import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { connectLocal, type VonvonClient } from '@vonvon/client';
import type { ScheduledTaskView } from '@vonvon/protocol';
import type { AdminBot, AdminProject, AdminService } from '../src/admin/service';
import { setCliContext, withDaemon } from '../src/cli/daemon-client';
import { loadCommands, loadLocalOnly } from './helpers/cli-commands';
import { fakeService, startFixture } from './server-fixture';
import type { AuthzDeps } from '../src/server/authz';
import agentFixture from '../../protocol/test/fixtures/agent-settings.json';
import { NOT_DM_COMMENT_MESSAGE, NOT_DM_MESSAGE } from '../src/agent/entry/registry';

/**
 * devices-4a 4.9, run as a Bot session's shell would: the CLI bundle against a daemon in this process. A session's
 * command carries its token and `--scope` and never the owner's credential; without a valid token nothing connects.
 */
const BOT = 'cli_x';
const GROUP = 'oc_y';
const OTHER = 'oc_z';
const bot: AdminBot = { appId: BOT, name: 'X', tenant: 'feishu', active: true, current: true, running: true, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };
const row = (name: string, chatId: string): AdminProject => ({ name, chatId, cwd: '/w', blank: false, kind: 'multi', origin: 'joined', noMention: false, mode: 'qa', guestMode: 'qa',
  network: false, backend: 'codex-appserver', allowedUsersCount: 0, sessionCount: 0, createdAt: 1 });

let dir: string;
let entry: string;
const temps: string[] = [];
beforeAll(async () => {
  await mkdir(resolve('node_modules/.cache'), { recursive: true });
  dir = await mkdtemp(resolve('node_modules/.cache/vonvon-cli-bot-session-'));
  entry = join(dir, 'cli.mjs');
  await build({ entryPoints: [resolve('src/cli/index.ts')], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const temp of temps) await rm(temp, { recursive: true, force: true });
});
afterEach(() => { setCliContext({ scope: undefined, env: process.env }); });

async function emptyHome(): Promise<{ home: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-bot-session-')); temps.push(base);
  const home = join(base, 'home'); await mkdir(home);
  return { home, root: join(base, 'vh') };
}
type Result = { code: number | null; json: { ok: boolean; error?: { kind: string; message: string; reason?: string } } & Record<string, unknown>; stderr: string };
function run(root: string, home: string, args: string[], session: NodeJS.ProcessEnv): Promise<Result> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '', ...session };
  delete env.VONVON_SERVICE;
  const child = spawn(process.execPath, [entry, ...args, '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', code => { try { done({ code, json: JSON.parse(stdout) as Result['json'], stderr }); } catch { fail(new Error(`not JSON: ${stdout}${stderr}`)); } });
  });
}
/** A running daemon whose `local-credential` nobody can read any more: a command that reads it fails. */
async function daemon(overrides: Partial<AdminService> = {}, askBot?: AuthzDeps['askBot']) {
  const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [], now: 1, timeZone: 'UTC' }));
  // devices-4b: the group's Bot process says a member's turn is going
  const actor = { kind: 'session' as const, openId: 'ou_m', role: 'member' as const, chatId: GROUP };
  const fixture = await startFixture(fakeService({ listBots: async () => [bot], listProjects: async appId => appId === BOT ? [row('研发', GROUP), row('运营', 'oc_z')] : [], executeSchedule, ...overrides }),
    undefined, undefined, undefined, askBot ?? (async () => ({ ok: true, role: 'member', openId: 'ou_m', actor })));
  await writeFile(join(fixture.home, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: fixture.api.listen }));
  await chmod(join(fixture.home, 'local-credential'), 0o000);
  const home = (await emptyHome()).home;
  const token = fixture.sessionTokens.issue({ appId: BOT, place: 'group', chatId: GROUP, sessionId: 'ses_0123456789abcdef' });
  return { fixture, home, token, executeSchedule, close: async () => { await chmod(join(fixture.home, 'local-credential'), 0o600); await fixture.close(); } };
}

describe('a Bot session\'s command line', () => {
  // main 必败: the CLI connected with local-credential, as the owner
  it.each([{ FEISHU_CODEX_BRIDGE: '1' }, { VONVON_SESSION: '1' }, { VONVON_SESSION: 'vs1.bad' }])('refuses %o before it looks for the daemon', async session => {
    const { home, root } = await emptyHome();
    // no daemon, no lock, no credential: a refusal after the lock read would be "daemon 没有运行" (exit 3)
    const result = await run(root, home, ['schedule', 'list', '--group', GROUP, '--scope', `bot=${BOT},group=${GROUP}`], session);
    expect(result).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused', reason: 'session_token_missing', message: '这是 Bot 会话，但没有有效的会话令牌，不能以主人身份运行。' } } });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('connects with its token, never local-credential, and negotiates its scope first', async () => {
    const d = await daemon();
    try {
      const ok = await run(d.fixture.home, d.home, ['schedule', 'list', '--group', GROUP, '--scope', `bot=${BOT},group=${GROUP}`], { VONVON_SESSION: d.token });
      expect(ok, ok.stderr).toMatchObject({ code: 0, json: { ok: true } });
      expect(d.executeSchedule).toHaveBeenCalledWith(BOT, { kind: 'session', openId: 'ou_m', role: 'member', chatId: GROUP }, { action: 'list', chatId: GROUP });
      // the global option goes anywhere on the line
      expect((await run(d.fixture.home, d.home, ['--scope', `bot=${BOT},group=${GROUP}`, 'schedule', 'list', '--group', GROUP], { VONVON_SESSION: d.token })).code).toBe(0);
      const missing = await run(d.fixture.home, d.home, ['schedule', 'list', '--group', GROUP], { VONVON_SESSION: d.token });
      expect(missing).toMatchObject({ code: 4, json: { error: { kind: 'refused', reason: 'scope_required' } } });
      // settings-dm-only: no skill teaches it, so the refusal says what to add
      expect(missing.json.error?.message).toContain('要带上 `--scope "$VONVON_SCOPE"`');
      const wider = await run(d.fixture.home, d.home, ['schedule', 'list', '--group', GROUP, '--scope', `bot=${BOT}`], { VONVON_SESSION: d.token });
      expect(wider).toMatchObject({ code: 4, json: { error: { reason: 'scope_required' } } });
      expect(wider.json.error?.message).toContain('范围超过了这条会话');
      expect(wider.json.error?.message).toContain('改用 `--scope "$VONVON_SCOPE"`');
      // a settings write from a group: the tools' sentence
      // D4a review R1: also those that read the bot's settings before they write
      // settings-dm-only: and reading the group's own settings, as no group session has settings_get
      for (const args of [['settings', 'act', 'voice', 'test'], ['settings', 'set', 'cards.showToolCalls=true'], ['settings', 'act', 'admin', 'add', 'ou_0123456789abcdef'], ['settings', 'act', 'comment-instructions', '--default'],
        ['settings', 'set', '--group', GROUP, 'permission.mode=full'], ['settings', 'get', '--group', GROUP]]) {
        const write = await run(d.fixture.home, d.home, [...args, '--scope', `bot=${BOT},group=${GROUP}`], { VONVON_SESSION: d.token });
        expect(write, args.join(' ')).toMatchObject({ code: 4, json: { error: { kind: 'refused', reason: 'not-dm' } } });
        // s1b: the sentence alone, not "读取设置失败：…" from the read a write starts with
        expect(write.json.error?.message, args.join(' ')).toBe(NOT_DM_MESSAGE);
      }
      // s1b: a group's queries are its whitelist; the rest is refused without saying what is there
      for (const args of [['group', 'show', '研发'], ['group', 'joined'], ['group', 'pending'], ['session', 'list', '--group', GROUP], ['settings', 'models', '--backend', 'codex', '--purpose', 'project'], ['project', 'list'],
        ['memory', 'export', '--bot', BOT], ['memory', 'events', 'p_prj_0a1b2c3d:abcdef', '--bot', BOT], ['daemon', 'logs']]) {
        const read = await run(d.fixture.home, d.home, [...args, '--scope', `bot=${BOT},group=${GROUP}`], { VONVON_SESSION: d.token });
        expect(read, args.join(' ')).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused' } } });
        expect(JSON.stringify(read.json), args.join(' ')).not.toContain('运营');
        expect(JSON.stringify(read.json), args.join(' ')).not.toContain('/w');
      }
      // Codex review 256-1 / 257-1. main 必败: service status ran from the files (exit 0, the service's definition and log
      // paths); it is the service manager's, refused in a session as the rest of `service`. daemon status answers from the
      // lock in a session, token or not, with what connectLocal reads and nothing else (no PID, start time or version).
      const comment = d.fixture.sessionTokens.issue({ appId: BOT, place: 'comment', sessionId: 'ses_2222222222222222' });
      for (const session of [{ VONVON_SESSION: d.token }, { VONVON_SESSION: comment }, { FEISHU_CODEX_BRIDGE: '1' }]) {
        const service = await run(d.fixture.home, d.home, ['service', 'status'], session);
        expect(service, service.stderr).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused', reason: 'not_in_session' } } });
        expect(JSON.stringify(service.json)).not.toContain(d.fixture.home);
        const status = await run(d.fixture.home, d.home, ['daemon', 'status'], session);
        expect(status, status.stderr).toMatchObject({ code: 0 });
        expect(status.json).toEqual({ ok: true, running: true, listen: d.fixture.api.listen, source: 'files' });
      }
      // Codex review 256-3 / 257-2. main 必败: the group's own id never reached the daemon (bindings hidden), and read 这个操作不能从 Bot 会话里做
      for (const [token, scope, sentence] of [[d.token, `bot=${BOT},group=${GROUP}`, NOT_DM_MESSAGE], [comment, `bot=${BOT}`, NOT_DM_COMMENT_MESSAGE]] as const) {
        const set = await run(d.fixture.home, d.home, ['group', 'set', GROUP, '--disable', '--scope', scope], { VONVON_SESSION: token });
        expect(set, set.stderr).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused', reason: 'not-dm', message: sentence } } });
      }
      // Codex review 230-3: a comment session's task is refused for its place (exit 4), not as a group it cannot see (exit 2)
      const add = await run(d.fixture.home, d.home, ['schedule', 'add', '巡检', '--group', GROUP, '--name', 'probe', '--every', '1h', '--scope', `bot=${BOT}`], { VONVON_SESSION: comment });
      expect(add, add.stderr).toMatchObject({ code: 4, json: { error: { kind: 'refused', reason: 'not-group' } } });
      d.fixture.sessionTokens.revoke('ses_0123456789abcdef');
      expect(await run(d.fixture.home, d.home, ['schedule', 'list', '--group', GROUP, '--scope', `bot=${BOT},group=${GROUP}`], { VONVON_SESSION: d.token }))
        .toMatchObject({ code: 4, json: { error: { kind: 'refused', reason: 'session_token_invalid', message: '会话令牌已失效（会话结束或超过 24 小时没用）。' } } });
    } finally { await d.close(); }
  }, 60_000);

  // Codex review 239-2 / 240-1. main 必败 (in this slice): settings get left them out, the act's --json printed them again
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('prints a private chat\'s administrators after settings act admin add as settings get shows them', async () => {
    const view = (openIds: string[], revision: string) => ({ ...agentFixture, scope: { kind: 'agent', botId: BOT },
      administrators: { feishu: { ownerOpenId: 'ou_owner', adminOpenIds: ['ou_fs'] }, scannerOpenId: 'ou_scan', openIds, revision } });
    const act = vi.fn(async () => ({ kind: 'saved', view: view(['ou_local', 'ou_0123456789abcdef'], 'a2'), effects: [], warnings: [] }));
    const settings = { act, read: async () => view(['ou_local'], 'a1'), save: async () => { throw new Error('unused'); }, models: async () => { throw new Error('unused'); } };
    // the owner's own private-chat turn, as its Bot process says
    const d = await daemon({ settings } as unknown as Partial<AdminService>, async () => ({ ok: true, role: 'owner', openId: 'ou_owner' }));
    try {
      const token = d.fixture.sessionTokens.issue({ appId: BOT, place: 'dm', chatId: 'oc_dm', sessionId: 'ses_1111111111111111' });
      const added = await run(d.fixture.home, d.home, ['settings', 'act', 'admin', 'add', 'ou_0123456789abcdef', '--scope', `bot=${BOT}`], { VONVON_SESSION: token });
      expect(added, added.stderr).toMatchObject({ code: 0, json: { ok: true, result: 'saved' } });
      expect(added.json.administrators).toEqual({ openIds: ['ou_local', 'ou_0123456789abcdef'], revision: 'a2' });
      expect(act).toHaveBeenCalledExactlyOnceWith({ kind: 'adminMember', botId: BOT, openId: 'ou_0123456789abcdef', membership: 'present', revision: 'a1' });
    } finally { await d.close(); }
  }, 60_000);

  // main 必败: these ran in a session
  it('refuses the local-only commands in a session, naming them, and runs the rest', async () => {
    const { home, root } = await emptyHome();
    const session = { VONVON_SESSION: `vs1.ses_0123456789abcdef.${'a'.repeat(43)}` };
    for (const [path, ...args] of [['daemon restart'], ['daemon start'], ['daemon stop'], ['service install'], ['service uninstall'], ['service status'], ['pair'], ['clients ls'],
      ['clients revoke', 'cl_0000000000000000'], ['device rename', 'x'], ['bot repair-dir', 'x'], ['open'],
      // D3: remote access is the owner's at this computer (devices 8.3), refused before it reads or writes remote.json
      ['remote status'], ['remote enable', '192.168.1.10'], ['remote enable', '--tailscale'], ['remote disable', '192.168.1.10'], ['remote port', '7767'],
      // I3: update and its check, and the install scripts' switch of `current` (devices 8.3: exit 4 in a session)
      ['update'], ['update', '--check'], ['update', '--allow-downgrade', '--to', '0.0.1'],
      ['__standalone-setup', '--install-root', root, '--release', '0.0.1'], ['__standalone-teardown', '--install-root', root]] as Array<[string, ...string[]]>) {
      const result = await run(root, home, [...path.split(' '), ...args], session);
      expect(result, path).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused', reason: 'not_in_session', message: `这条命令（\`vonvon ${path}\`）不能在 Bot 会话里运行。告诉用户去设备上或桌面端里做。` } } });
    }
    expect(await run(root, home, ['daemon', 'status'], session)).toMatchObject({ code: 3, json: { error: { kind: 'connection' } } });
    // devices 8.3's list: each one a command of this CLI
    const localOnly = await loadLocalOnly();
    const commands = new Set((await loadCommands()).map(command => command.path.replace(/ [<[].*$/, '')));
    expect(localOnly.filter(path => !commands.has(path))).toEqual([]);
    for (const allowed of ['daemon status', 'secrets get', 'schedule list', 'memory add', '__restart-after-exit', '__daemon-control']) expect(localOnly).not.toContain(allowed);
  }, 60_000);

  // D4a review R3: a host started inside a session (an older daemon) hands its environment to the helpers it starts
  it('leaves the host\'s own helpers to a host that carries a session marker', async () => {
    const { home, root } = await emptyHome();
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, VONVON_HOME: root, VONVON_SESSION: '', FEISHU_CODEX_BRIDGE: '1' };
    // an identity no restart can take: the helper itself refuses it, after the session check
    const child = spawn(process.execPath, [entry, '__restart-after-exit', '0', '1', '2026-11-01T00:00:00.000Z'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += String(data); });
    const code = await new Promise<number | null>(done => child.once('close', done));
    expect(code).not.toBe(4);
    expect(stderr).toContain('Invalid restart identity');
    expect(stderr).not.toContain('不能在 Bot 会话里运行');
  }, 60_000);

  it('takes --scope only as bot=<appId>[,group=<chatId>]', async () => {
    const { home, root } = await emptyHome();
    for (const spec of ['bad', 'group=oc_y', `bot=${BOT},bot=cli_z`, `bot=${BOT},room=oc_y`, `bot=${BOT},group=`]) {
      expect(await run(root, home, ['schedule', 'list', '--group', GROUP, '--scope', spec], {}), spec)
        .toMatchObject({ code: 2, json: { error: { kind: 'bad-args', message: '--scope 的写法是 bot=<appId>[,group=<chatId>]。' } } });
    }
  });
});

/** A running daemon the owner reaches as usual, its bot bound to two groups. */
async function ownerDaemon(overrides: Partial<AdminService> = {}) {
  const fixture = await startFixture(fakeService({ listBots: async () => [bot], listProjects: async appId => appId === BOT ? [row('研发', GROUP), row('运营', OTHER)] : [],
    getDaemonStatus: async () => ({ installed: false, running: true, selfHosted: true, version: 'test', supported: true, pid: process.pid }), ...overrides }));
  await writeFile(join(fixture.home, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), listen: fixture.api.listen }));
  return { fixture, home: (await emptyHome()).home };
}
const task = (id: string, chatId: string): ScheduledTaskView => ({ id, botId: BOT, chatId, revision: 'r1', name: id, instruction: 'x', spec: { kind: 'every', minutes: 60 }, timeZone: 'UTC',
  placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: 1, updatedAt: 1, running: false, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], describe: '每小时' });

describe('the owner\'s --scope on the command line', () => {
  // Codex review 228-2 / 229-3. main 必败: the reply kept the other group's tasks
  it('lists only the scoped group\'s tasks with --all', async () => {
    const executeSchedule = vi.fn(async () => ({ kind: 'tasks' as const, tasks: [task('st_a', GROUP), task('st_b', OTHER)], now: 1, timeZone: 'UTC' }));
    const d = await ownerDaemon({ executeSchedule });
    try {
      const all = await run(d.fixture.home, d.home, ['schedule', 'list', '--all', '--scope', `bot=${BOT},group=${GROUP}`], {});
      expect(all, all.stderr).toMatchObject({ code: 0, json: { ok: true, kind: 'tasks' } });
      expect((all.json.tasks as ScheduledTaskView[]).map(item => item.chatId)).toEqual([GROUP]);
      // without --scope the owner sees the whole bot
      expect(((await run(d.fixture.home, d.home, ['schedule', 'list', '--all'], {})).json.tasks as ScheduledTaskView[]).map(item => item.chatId)).toEqual([GROUP, OTHER]);
    } finally { await d.fixture.close(); }
  }, 60_000);

  // Codex review 229-4. main 必败: the other group was bound
  it('binds no group outside the scope', async () => {
    const bindGroup = vi.fn<NonNullable<AdminService['bindGroup']>>(async () => { throw new Error('not reached'); });
    const d = await ownerDaemon({ bindGroup });
    try {
      const outside = await run(d.fixture.home, d.home, ['group', 'bind', 'oc_outside', '--name', 'outside', '--tool', 'claude', '--conversation', 'threads', '--scope', `bot=${BOT},group=${GROUP}`], {});
      expect(outside, outside.stderr).toMatchObject({ code: 4, json: { ok: false, error: { kind: 'refused', reason: 'permission_denied' } } });
      expect(bindGroup).not.toHaveBeenCalled();
    } finally { await d.fixture.close(); }
  }, 60_000);
});

describe('a session\'s token given to connectLocal', () => {
  // Codex review 230-2. main 必败: the discovery child checked the owner with local-credential (unreadable here) and failed
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('finds the daemon from the lock alone, with the real discovery command', async () => {
    vi.stubEnv('VONVON_SESSION', ''); vi.stubEnv('FEISHU_CODEX_BRIDGE', '');
    const d = await daemon();
    try {
      const { client, serverInfo } = await connectLocal({ home: d.fixture.home, cliEntry: entry, credential: d.token });
      expect(serverInfo).toMatchObject({ principal: 'bot-session:group' });
      // Codex review 256-2. main 必败: the hello named the device and its machine id to a group's token
      expect(Object.keys(serverInfo).sort()).toEqual(['principal', 'protocolVersion', 'type', 'version']);
      await client.close();
    } finally { vi.unstubAllEnvs(); await d.close(); }
  }, 60_000);
});

describe('negotiate outside a session', () => {
  const fake = () => {
    const admin = vi.fn(async () => ({ kind: 'negotiated' as const, principal: 'owner:local' as const, scope: null }));
    const snapshot = vi.fn(async () => ({}));
    return { admin, snapshot, client: { admin, snapshot, close: async () => {} } as unknown as VonvonClient };
  };
  it('negotiates first when the owner gives --scope, not otherwise', async () => {
    setCliContext({ env: {} });
    const plain = fake();
    await withDaemon(call => call('读取快照', c => c.snapshot()), async () => plain.client);
    expect(plain.admin).not.toHaveBeenCalled();
    setCliContext({ env: {}, scope: { bot: BOT } });
    const scoped = fake();
    await withDaemon(call => call('读取快照', c => c.snapshot()), async () => scoped.client);
    expect(scoped.admin).toHaveBeenCalledWith({ type: 'negotiate', capabilities: ['cli'], scope: { bot: BOT } });
    expect(scoped.admin.mock.invocationCallOrder[0]).toBeLessThan(scoped.snapshot.mock.invocationCallOrder[0]!);
  });
});
