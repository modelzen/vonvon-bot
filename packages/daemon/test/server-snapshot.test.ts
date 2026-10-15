import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminBot } from '../src/admin/service';
import type { DesktopServiceStatus } from '../src/host/service';
import { createSnapshotStore, type SnapshotStore } from '../src/server/snapshot';
import { writeServiceActionRecord, writeServiceSkipped, type ServiceActionRecord } from '../src/service/action-report';

vi.mock('../src/agent', () => ({ createBackend: () => ({ doctor: async () => ({ ok: false, version: null, depState: 'not-installed' }) }) }));

const stores: SnapshotStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
// The real manager's first answer lands whenever launchctl or systemctl replies, adding a revision of its own.
const noManager = async (): Promise<DesktopServiceStatus> => ({ supported: false, installed: false, running: false });
const bot: AdminBot = { appId: 'cli_test', name: 'test', tenant: 'feishu', active: false, current: true, running: false, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

describe('snapshot commit queue', () => {
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
    expect(store.current().tools[0]).toMatchObject({ tool: 'codex', version: 'codex-cli 0.120.0', compatibility: { status: 'tooOld', minimum: '0.139.0' } });
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
    await writeServiceActionRecord(root, { pid: process.pid, action: 'install', phase: 'running', startedAt: 2 });
    await store.rebuild();
    expect(store.current().application.service?.action).toEqual({ action: 'install', phase: 'running', startedAt: 2 });
    running = { action: 'install', startedAt: 3 };
    await store.rebuild();
    expect(store.current().application.service?.action).toEqual({ action: 'install', phase: 'running', startedAt: 3 });
  });
  it.each([
    ['development', { kind: 'development', cliPath: '/src/vonvon-bot/packages/daemon/bin/vonvon.mjs' }],
    ['development', { kind: 'unknown', cliPath: '/opt/vonvon/bin/vonvon.mjs' }],
    ['translocated', { kind: 'bundled', cliPath: '/private/var/folders/x/T/AppTranslocation/1F2E/d/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs' }],
  ] as const)('blocks installing from %s', async (blocked, distribution) => {
    const { store } = await serviceStore({ distribution: async () => distribution });
    await vi.waitFor(() => expect(store.current().application.service?.blocked).toBe(blocked));
  });
  it('has no service field where there is no manager', async () => {
    const store = await createSnapshotStore({ service: { listBots: async () => [], listProjects: async () => [] }, jobs: () => [], publish: () => {}, readTools: async () => [], readService: async () => ({ supported: false, installed: false, running: false }), distribution: async () => npm });
    stores.push(store);
    await store.refreshService();
    expect(store.current().application.service).toBeUndefined();
  });
});
