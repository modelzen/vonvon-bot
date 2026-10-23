import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopSnapshotSchema, type DesktopSnapshot } from '@vonvon/protocol';
import type { AdminBot, AdminProject } from '../src/admin/service';
import type { DesktopServiceStatus } from '../src/host/service';
import { createSnapshotStore, type SnapshotStore } from '../src/server/snapshot';
import { environmentRpc } from '../src/server/rpc/environment';
import { writeServiceActionRecord, writeServiceSkipped, type ServiceActionRecord } from '../src/service/action-report';

vi.mock('../src/agent', () => ({ createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }) }));

const stores: SnapshotStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
// The real manager's first answer lands whenever launchctl or systemctl replies, adding a revision of its own.
const noManager = async (): Promise<DesktopServiceStatus> => ({ supported: false, installed: false, running: false });
const bot: AdminBot = { appId: 'cli_test', name: 'test', tenant: 'feishu', active: false, current: true, running: false, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

describe('snapshot commit queue', () => {
  it('publishes external project enable changes even when attention remains unchanged, preserving older providers', async () => {
    let enabled: boolean | undefined = true;
    const project: AdminProject = {name: 'attention', chatId: 'oc_attention', cwd: '/tmp/attention', blank: false,
      kind: 'smart', origin: 'created', noMention: false, mode: 'full', guestMode: 'full', network: false,
      backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1};
    const diagnostics = {notReplied: [], deniedScopes: [], attention: [{groupId: project.chatId,
      main: {mode: 'focus' as const, intervalMs: 60_000}, focusedTopics: 2, watchedTopics: 1}]};
    const frames: DesktopSnapshot[] = [];
    const store = await createSnapshotStore({
      service: {listBots: async () => [{...bot, active: true, running: true, connection: 'connected'}],
        listProjects: async () => [{...project, ...(enabled === undefined ? {} : {enabled})}]},
      jobs: () => [], readTools: async () => [], readService: noManager,
      publish: state => {frames.push(desktopSnapshotSchema.parse(state));},
      diagnostics: {view: () => diagnostics, retain: () => {}},
    });
    stores.push(store);
    expect(desktopSnapshotSchema.parse(store.current()).memberships[0]?.enabled).toBe(true);
    for (const value of [false, true]) {enabled = value; await store.rebuild();}
    expect(frames.map(frame => frame.memberships[0]?.enabled)).toEqual([false, true]);
    expect(frames.map(frame => frame.revision)).toEqual([2, 3]);
    for (const frame of frames) expect(frame.agents[0]?.diagnostics).toEqual(diagnostics);
    // An older provider may omit the new field; neither projection nor schema invents a value.
    enabled = undefined;
    await store.rebuild();
    expect(desktopSnapshotSchema.parse(store.current()).memberships[0]).not.toHaveProperty('enabled');
  });

  it('starts at one without an event and publishes before a matching writer reply', async () => {
    let enabled = false;
    let probes = 0;
    const frames: string[] = [];
    const store = await createSnapshotStore({ service: { listBots: async () => [{ ...bot, active: enabled }], listProjects: async () => [] }, jobs: () => [], readTools: async () => { probes++; return []; }, readService: noManager, publish: state => frames.push(`event:${state.revision}`) });
    stores.push(store);
    expect(store.current().revision).toBe(1);
    expect(frames).toEqual([]);
    await store.rebuild(state => frames.push(`reply:${state.revision}`));
    enabled = true;
    await Promise.all([store.rebuild(state => frames.push(`reply:${state.revision}`)), store.rebuild(state => frames.push(`reply:${state.revision}`))]);
    expect(frames).toEqual(['reply:1', 'event:2', 'reply:2', 'reply:2']);
    expect(probes).toBe(1);
    store.current();
    expect(probes).toBe(1);
  });

  it('recovers from a failed build without publishing or consuming a revision', async () => {
    let fail = false;
    let enabled = false;
    const revisions: number[] = [];
    const store = await createSnapshotStore({ service: { listBots: async () => { if (fail) throw new Error('read failed'); return [{ ...bot, active: enabled }]; }, listProjects: async () => [] }, jobs: () => [], readTools: async () => [], readService: noManager, publish: state => revisions.push(state.revision) });
    stores.push(store);
    fail = true;
    await expect(store.rebuild()).rejects.toThrow('read failed');
    expect(store.current().revision).toBe(1);
    fail = false;
    enabled = true;
    await store.rebuild();
    expect(revisions).toEqual([2]);
  });

  it('marks an installed Codex that is too old so the checklist can say so', async () => {
    const setup = { installation: 'installed' as const, authentication: 'signedIn' as const, version: 'codex-cli 0.120.0', executable: '/bin/codex' };
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [], codexSetup: async () => setup }, jobs: () => [], publish: () => {} });
    stores.push(store);
    expect(store.current().tools[0]).toMatchObject({ tool: 'codex', version: 'codex-cli 0.120.0', compatibility: { status: 'tooOld', minimum: '0.156.1' } });
    expect(store.current().tools[1]).toMatchObject({ tool: 'claude', installation: 'missing' });
  });

  it('reads tools once more when asked during a read, so a fresh login is not lost', async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => {
      reads++;
      const version = String(reads);
      if (reads === 2) await new Promise<void>(resolve => { release = resolve; });
      return [{ tool: 'claude', installation: 'installed', authentication: reads >= 3 ? 'signedIn' : 'unknown', version }];
    } });
    stores.push(store);
    const inFlight = store.refreshTools();
    const afterLogin = store.refreshTools();
    const another = store.refreshTools();
    expect(afterLogin).toBe(another);
    release?.();
    await Promise.all([inFlight, afterLogin]);
    expect(reads).toBe(3);
    expect(store.current().tools[0]).toMatchObject({ authentication: 'signedIn', version: '3' });
  });
  it('does not wait for the service manager before serving, and keeps the last login item when it cannot tell', async () => {
    let answer: (value: DesktopServiceStatus) => void = () => {};
    let item: Promise<DesktopServiceStatus> = new Promise(resolve => { answer = resolve; });
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: () => item, distribution: async () => npm });
    stores.push(store);
    expect(store.current().application).toMatchObject({ loginItem: false }); expect(store.current().application.service).toBeUndefined();
    answer(managed('running'));
    await vi.waitFor(() => expect(store.current().application.loginItem).toBe(true));
    item = Promise.resolve(managed('unknown', 'launchctl timed out'));
    await store.refreshTools();
    expect(store.current().application).toMatchObject({ loginItem: true, service: { state: 'unknown', detail: 'launchctl timed out' } });
  });
});

const npm = { kind: 'global-npm', cliPath: '/usr/local/lib/node_modules/vonvon-bot/bin/vonvon.mjs' } as const;
const managed = (state: NonNullable<DesktopServiceStatus['state']>, detail: string = state): DesktopServiceStatus => ({ supported: true, installed: state !== 'not-installed', running: state === 'running', state, detail });
describe('状态与诊断 in the snapshot (s19)', () => {
  it('lays the cached Claude login over the tools on every rebuild, without reading the tools again', async () => {
    let login: { state: 'signedOut'; message: string } | undefined;
    let reads = 0;
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readService: noManager, claudeLogin: () => login,
      readTools: async () => { reads++; return [{ tool: 'claude', installation: 'installed', authentication: 'unknown', version: '0.3.296', message: 'hint' }]; } });
    stores.push(store);
    expect(store.current().tools[0]).toMatchObject({ authentication: 'unknown', message: 'hint' });
    login = { state: 'signedOut', message: 'a turn failed' };
    await store.rebuild();
    expect(store.current().tools[0]).toMatchObject({ authentication: 'signedOut', message: 'a turn failed', version: '0.3.296' });
    expect(reads).toBe(1);
  });

  it('answers 检查登录 only after a rebuild, so the page has the new login when the reply lands', async () => {
    const service = { backendLogin: async () => ({ state: 'signedIn' as const, message: 'ok' }) };
    const outcome = await environmentRpc(service as never, {} as never, {} as never, { type: 'backendLogin', id: 'claude-agent', refresh: true });
    expect(outcome.kind).toBe('mutation');
    if (outcome.kind === 'mutation') expect(outcome.reply({} as never)).toEqual({ kind: 'backendLogin', id: 'claude-agent', state: 'signedIn', message: 'ok' });
  });

  it('carries the records of the bots that have some, and lets go of deleted bots', async () => {
    const view = { notReplied: [{ at: 1, count: 2, groupId: 'oc_fixture', place: 'main' as const, reason: 'unbound' as const }], deniedScopes: [] };
    const retained: string[][] = [];
    const store = await createSnapshotStore({ service: { listBots: async () => [bot, { ...bot, appId: 'cli_other', name: 'other' }], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: noManager,
      diagnostics: { view: appId => appId === 'cli_test' ? view : undefined, retain: appIds => { retained.push([...appIds]); } } });
    stores.push(store);
    expect(store.current().agents.find(agent => agent.id === 'cli_test')?.diagnostics).toEqual(view);
    expect(store.current().agents.find(agent => agent.id === 'cli_other')).not.toHaveProperty('diagnostics');
    expect(retained.at(-1)).toEqual(['cli_test', 'cli_other']);
  });
  it('carries the daemon\'s crashes and each bot\'s own pause, a paused bot not waiting for a restart (s18a)', async () => {
    const crashes = { paused: { since: 5, crashes: 3 }, records: [{ at: 4, kind: 'forced' as const, appId: 'cli_test', reason: 'SIGKILL', uptimeMs: 2000 }] };
    let held = true;
    const store = await createSnapshotStore({ service: { listBots: async () => [{ ...bot, active: true }, { ...bot, appId: 'cli_other', name: 'other', active: true }], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: noManager,
      crashes: { application: () => crashes, paused: appId => appId === 'cli_test' ? { since: 4, crashes: 3 } : undefined, lockHeld: appId => held && appId === 'cli_other' ? { since: 7, pid: 123 } : undefined } });
    stores.push(store);
    expect(store.current().application.crashes).toEqual(crashes);
    expect(store.current().agents.find(agent => agent.id === 'cli_test')).toMatchObject({ running: false, paused: { since: 4, crashes: 3 }, activation: 'active' });
    expect(store.current().agents.find(agent => agent.id === 'cli_other')).toMatchObject({ activation: 'restartRequired' });
    expect(store.current().agents.find(agent => agent.id === 'cli_other')).not.toHaveProperty('paused');
    expect(store.current().agents.find(agent => agent.id === 'cli_other')?.lockHeld).toEqual({ since: 7, pid: 123 });
    held = false;
    await store.rebuild();
    expect(store.current().agents.find(agent => agent.id === 'cli_other')).not.toHaveProperty('lockHeld');
    const older = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: noManager });
    stores.push(older);
    expect(older.current().application).not.toHaveProperty('crashes');
  });
});

describe('login-time service field (s08)', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  async function serviceStore(options: Partial<Parameters<typeof createSnapshotStore>[0]> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'vonvon-snapshot-service-')); roots.push(root);
    let status = managed('not-installed');
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: async () => status, distribution: async () => npm, root, ...options });
    stores.push(store);
    await vi.waitFor(() => expect(store.current().application.service).toBeDefined());
    return { root, store, set: (next: DesktopServiceStatus) => { status = next; } };
  }
  it('shows a service turned off in System Settings as disabled, with the login item off', async () => {
    const { store, set } = await serviceStore();
    set(managed('disabled', 'launchd has no job for it'));
    await store.refreshService();
    expect(store.current().application).toMatchObject({ loginItem: false, service: { state: 'disabled', detail: 'launchd has no job for it', skipped: false } });
    expect(store.current().application.service?.blocked).toBeUndefined();
  });
  it('carries the Linux linger state and the user manager hint to the checklist (s20a)', async () => {
    const { store, set } = await serviceStore();
    set({ ...managed('unknown', 'Cannot ask systemd (Linux): Failed to connect to bus'), hint: '当前终端没有 XDG_RUNTIME_DIR。', linger: { state: 'off', detail: 'x' } });
    await store.refreshService();
    expect(store.current().application.service).toMatchObject({ state: 'unknown', hint: '当前终端没有 XDG_RUNTIME_DIR。', linger: 'off' });
    expect(store.current().application.platform).toBe(process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'unsupported');
  });
  it('re-reads the skip flag and a finished report on the next rebuild', async () => {
    const { root, store } = await serviceStore();
    await writeServiceSkipped(root, true);
    const report: ServiceActionRecord = { pid: 99_999_999, action: 'uninstall', phase: 'done', ok: true, kind: 'uninstalled', detail: 'Uninstalled', leftovers: [], startedAt: 1, finishedAt: 2, restarted: { pid: 7 } };
    await writeServiceActionRecord(root, report);
    await store.rebuild();
    const { pid: _pid, leftovers: _leftovers, ...shown } = report;
    expect(store.current().application.service).toEqual({ state: 'not-installed', detail: 'not-installed', skipped: true, action: shown });
  });
  it('drops a running report whose helper died, and shows this daemon\'s own helper first', async () => {
    let running: { action: 'install'; startedAt: number } | undefined;
    const { root, store } = await serviceStore({ serviceAction: () => running });
    await writeServiceActionRecord(root, { pid: 99_999_999, action: 'install', phase: 'running', startedAt: 1 });
    await store.rebuild();
    expect(store.current().application.service?.action).toBeUndefined();
    const startedAt = Date.now();
    await writeServiceActionRecord(root, { pid: process.pid, action: 'install', phase: 'running', startedAt });
    await store.rebuild();
    expect(store.current().application.service?.action).toEqual({ action: 'install', phase: 'running', startedAt });
    running = { action: 'install', startedAt: 3 };
    await store.rebuild();
    expect(store.current().application.service?.action).toEqual({ action: 'install', phase: 'running', startedAt: 3 });
  });
  it.each([
    ['development', { kind: 'development', cliPath: '/src/vonvon-bot/packages/daemon/bin/vonvon.mjs' }],
    ['translocated', { kind: 'bundled', cliPath: '/private/var/folders/x/T/AppTranslocation/1F2E/d/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs' }],
  ] as const)('blocks installing from %s', async (blocked, distribution) => {
    const { store } = await serviceStore({ distribution: async () => distribution });
    await vi.waitFor(() => expect(store.current().application.service?.blocked).toBe(blocked));
  });
  it('leaves an unrecognized layout to the install transaction instead of calling it a development checkout', async () => {
    // A global npm install whose `npm root -g` timed out or was not on the PATH at login.
    const { store } = await serviceStore({ distribution: async () => ({ kind: 'unknown', cliPath: npm.cliPath }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    await store.rebuild();
    expect(store.current().application.service?.blocked).toBeUndefined();
  });
  it('keeps the newest manager answer when an older poll read lands after it', async () => {
    let stale: (status: DesktopServiceStatus) => void = () => {};
    let next: Promise<DesktopServiceStatus> | undefined;
    const { store } = await serviceStore({ readService: async () => next ?? managed('not-installed') });
    // The 60 s poll asks launchctl, slow just after login; then 重新检测 or a helper's exit asks again and hears first.
    next = new Promise(resolve => { stale = resolve; });
    const poll = store.refreshTools();
    next = Promise.resolve(managed('detached'));
    await store.refreshService();
    expect(store.current().application).toMatchObject({ loginItem: true, service: { state: 'detached' } });
    stale(managed('disabled'));
    await poll;
    expect(store.current().application).toMatchObject({ loginItem: true, service: { state: 'detached' } });
    // 重新检测 (machine `status`) hands over a read that began after the poll's, so it wins as well.
    next = new Promise(resolve => { stale = resolve; });
    const again = store.refreshTools();
    store.observeService(Promise.resolve(managed('running')));
    await vi.waitFor(() => expect(store.current().application.service?.state).toBe('running'));
    stale(managed('disabled'));
    await again;
    expect(store.current().application).toMatchObject({ loginItem: true, service: { state: 'running' } });
  });
  it('has no service field where there is no manager', async () => {
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: noManager, distribution: async () => npm });
    stores.push(store);
    await store.refreshService();
    expect(store.current().application.service).toBeUndefined();
  });
});
