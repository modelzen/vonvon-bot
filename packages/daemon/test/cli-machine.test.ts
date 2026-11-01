import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, membershipIdSchema,
  type AdminReply, type AdminRequest, type Agent, type ContextPreviewReply, type DaemonStatus, type DesktopSnapshot, type Membership,
} from '@vonvon/protocol';

vi.mock('../src/server/owner-verification', async original => ({ ...await original<object>(), verifyPidLockOwner: vi.fn(async () => {}) }));
import { CommandError } from '../src/cli/command-error';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { afterPrinted, lastLines, runLogs, runStatus } from '../src/cli/commands/daemon';
import { runServiceSkip } from '../src/cli/commands/service';
import { runContextShow } from '../src/cli/commands/context';
import { runSecretsTest, type SecretsContext } from '../src/cli/commands/secrets';
import { runNow, runSnapshot } from '../src/cli/commands/now';
import { stepLines } from '../src/cli/commands/bot';

/** cli-8-machine: daemon status / logs over RPC, service skip, context show, secrets test, now and snapshot. */
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const T0 = Date.parse('2026-11-01T05:00:00.000Z');
const agent = (id: string, name = 'Vonvon Bot', extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse(id), name, enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member = (agentId: string, groupId: string, name: string): Membership => ({
  id: membershipIdSchema.parse(JSON.stringify([agentId, groupId])), agentId: agentIdSchema.parse(agentId), groupId: groupIdSchema.parse(groupId), name, directory: `/work/${name}`,
  backend: 'codex-appserver', conversation: 'smart', response: 'mention', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false,
});
const snapshot = (agents: Agent[], extra: Partial<DesktopSnapshot> = {}): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents, groups: [], memberships: [member('cli_a', 'oc_dev', '研发群')], tools: [], jobs: [],
  application: { platform: 'linux', version: '0.8.0', loginItem: false, dataPath: '/home/u/.vonvon-bot' }, ...extra,
});
type Fake = Partial<Record<'snapshot' | 'admin' | 'machine' | 'contextPreview' | 'onLog' | 'onError', (request: never) => unknown>>;
function harness(client: Fake) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, ...client }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const offline: Daemon = async () => { throw new CommandError('connection', 'daemon 没有运行。'); };
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string });

describe('daemon status', () => {
  const home = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'vonvon-c8-')); roots.push(root);
    writeFileSync(join(root, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: new Date(T0 - 1000).toISOString(), listen: '127.0.0.1:43119', version: '0.8.0' }));
    return root;
  };
  const answer: DaemonStatus = { distribution: { kind: 'standalone', cliPath: '/opt/vonvon/bin/vonvon.mjs' }, installed: true, running: true, selfHosted: true, pid: process.pid, version: '0.8.0', supported: true, platformName: 'systemd', uptimeMs: 1000 };
  const running = () => harness({
    admin: async () => ({ kind: 'daemonStatus', status: answer }),
    snapshot: async () => snapshot([agent('cli_a', '值班', { paused: { since: T0, crashes: 3 } })], {
      application: { platform: 'linux', version: '0.8.0', loginItem: false, dataPath: '/home/u/.vonvon-bot', crashes: { records: [{ at: T0 - 60_000, kind: 'forced', appId: 'cli_a', reason: 'SIGKILL', uptimeMs: 5000 }] } },
    }),
  });

  // main 必败: daemon status only read the files
  it('asks a running daemon, which adds how it was installed and the data root', async () => {
    const h = running();
    const root = home();
    await runStatus(h.io(true), { home: root, now: () => T0, env: {}, daemon: h.daemon });
    expect(JSON.parse(h.out())).toEqual({
      ok: true, running: true, pid: process.pid, listen: '127.0.0.1:43119', version: '0.8.0', startedAt: new Date(T0 - 1000).toISOString(), source: 'daemon',
      pausedBots: [{ appId: 'cli_a', since: new Date(T0).toISOString(), crashes: 3 }],
      crashes: [{ at: new Date(T0 - 60_000).toISOString(), scope: 'bot', appId: 'cli_a', kind: 'forced', reason: 'SIGKILL', uptimeMs: 5000 }],
      distribution: answer.distribution, dataPath: '/home/u/.vonvon-bot', platform: 'linux', uptimeMs: 1000, service: { installed: true, supported: true, platformName: 'systemd' },
    });
    h.clear(); await runStatus(h.io(), { home: root, now: () => T0, env: {}, daemon: h.daemon });
    const lines = h.out().trimEnd().split('\n');
    expect(lines[0]).toBe(`running PID ${process.pid} at 127.0.0.1:43119`);
    expect(lines[1]).toContain('已暂停的 Bot：值班（10 分钟内崩溃了 3 次）');
    expect(lines.at(-3)).toMatch(/ {2}bot 值班 {2}被系统强制结束（SIGKILL），运行了 5 秒$/);
    expect(lines.slice(-2)).toEqual(['安装方式：standalone（安装脚本）', '数据目录：/home/u/.vonvon-bot']);
  });

  // main 必败: there was no RPC to fall back from, and a session read the files
  it('falls back to the files when the daemon does not answer, except in a session; the discovery always reads them', async () => {
    const root = home();
    const files = harness({});
    await runStatus(files.io(true), { home: root, now: () => T0, env: {}, daemon: offline });
    expect(JSON.parse(files.out())).toMatchObject({ ok: true, running: true, source: 'files', crashes: [] });
    expect(await caught(runStatus(files.io(true), { home: root, now: () => T0, env: { VONVON_SESSION: '1' }, daemon: offline }))).toMatchObject({ kind: 'connection' });
    const stopped = mkdtempSync(join(tmpdir(), 'vonvon-c8-')); roots.push(stopped);
    expect(await caught(runStatus(files.io(true), { home: stopped, now: () => T0, env: { VONVON_SESSION: '1' }, daemon: offline }))).toMatchObject({ kind: 'connection', message: 'daemon 没有运行。先运行 vonvon daemon start。' });
    // connectLocal runs `daemon status --json` to find the daemon: that one must not ask it
    const h = running();
    files.clear(); await runStatus(files.io(true), { home: root, now: () => T0, env: { VONVON_STATUS_FROM_FILES: '1', VONVON_SESSION: '1' }, daemon: h.daemon });
    expect(h.connect).not.toHaveBeenCalled();
    expect(JSON.parse(files.out())).toMatchObject({ running: true, listen: '127.0.0.1:43119', source: 'files' });
  });
});

describe('daemon logs', () => {
  const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n';
  /**
   * A daemon whose logs are `text`; `emit` pushes a log event, `drop` closes the connection. `silent` requests get no
   * reply, unless `fail` fails them; `listening` counts the client listeners and Ctrl-C handlers still on.
   */
  function logs(silent: (request: AdminRequest) => boolean = () => false) {
    let log: ((payload: { lines: string }) => void) | undefined;
    let error: ((error: Error) => void) | undefined;
    const waiting: Array<(error: Error) => void> = [];
    const admin = vi.fn((request: AdminRequest): Promise<AdminReply> => silent(request) ? new Promise((_, reject) => { waiting.push(reject); })
      : Promise.resolve(request.type === 'logs' ? { kind: 'logs', text } : { kind: 'following', follow: request.type === 'followLogs' && request.follow }));
    const h = harness({ admin, onLog: ((listener: typeof log) => { log = listener; return () => { log = undefined; }; }) as never, onError: ((listener: typeof error) => { error = listener; return () => { error = undefined; }; }) as never });
    let handlers = 0;
    let interrupt = (): void => {};
    const readFiles = vi.fn(async () => 'from files\n');
    const deps = { daemon: h.daemon, env: {}, readFiles, onInterrupt: (handler: () => void) => { handlers++; interrupt = handler; return () => { handlers--; interrupt = () => {}; }; } };
    return {
      ...h, admin, readFiles, deps, emit: (lines: string) => log?.({ lines }), drop: () => error?.(new ConnectionError(new Error('closed'))), interrupt: () => interrupt(),
      listening: () => handlers + Number(log !== undefined) + Number(error !== undefined),
      fail: (failure: Error) => { for (const reject of waiting.splice(0)) reject(failure); },
    };
  }
  const stopSending = (request: AdminRequest): boolean => request.type === 'followLogs' && !request.follow;
  /** Lets every reply already given arrive; the timers are fake in the Ctrl-C tests, so only these run. */
  const settled = <T>(run: Promise<T>): Promise<T | 'still waiting'> => Promise.race([run, new Promise<'still waiting'>(resolve => { setImmediate(() => resolve('still waiting')); })]);

  it('keeps the last lines, and skips what the follower sends again', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc\n');
    expect(lastLines('a\nb', 5)).toBe('a\nb\n');
    expect(lastLines('', 3)).toBe('');
    expect(afterPrinted('x\ny\nz\n', 'y\nz\nnew\n')).toBe('new\n');
    expect(afterPrinted('x\ny\n', 'other\n')).toBe('other\n');
    expect(afterPrinted('x\ny\n', 'x\ny\n')).toBe('');
    // a short --tail: the replay holds all of it, and more before
    expect(afterPrinted('y\nz\n', 'w\nx\ny\nz\nnew\n')).toBe('new\n');
    expect(afterPrinted('z\n', 'z\nxz\n')).toBe('xz\n'); // only whole lines match
    expect(afterPrinted('', 'a\n')).toBe('a\n');
  });

  // main 必败: daemon logs read the files even with a daemon, and never in a session it refused
  it('asks a running daemon, falls back to the files, and not in a session', async () => {
    const h = logs();
    await runLogs({ tail: 50 }, h.io(true), h.deps);
    expect(h.admin).toHaveBeenCalledWith({ type: 'logs', maxBytes: 20_000 });
    expect(JSON.parse(h.out())).toEqual({ ok: true, source: 'daemon', text: lastLines(text, 50) });
    expect(h.out()).not.toContain('"line 29\\n');
    expect(h.readFiles).not.toHaveBeenCalled();
    h.clear(); await runLogs({ tail: 50 }, h.io(true), { ...h.deps, daemon: offline });
    expect(JSON.parse(h.out())).toEqual({ ok: true, source: 'files', text: 'from files\n' });
    h.readFiles.mockClear();
    expect(await caught(runLogs({ tail: 50 }, h.io(true), { ...h.deps, daemon: offline, env: { FEISHU_CODEX_BRIDGE: '1' } }))).toMatchObject({ kind: 'connection' });
    expect(await caught(runLogs({ tail: 50, follow: true }, h.io(true), { ...h.deps, daemon: offline }))).toMatchObject({ kind: 'connection' });
    expect(h.readFiles).not.toHaveBeenCalled();
  });

  // main 必败: there was no --follow
  it('--follow prints each batch until Ctrl-C (130), after asking the daemon to stop sending', async () => {
    const h = logs();
    const run = caught(runLogs({ tail: 2, follow: true }, h.io(true), h.deps));
    await vi.waitFor(() => expect(h.admin).toHaveBeenCalledWith({ type: 'followLogs', follow: true }));
    h.emit('line 78\nline 79\nline 80\n');
    h.emit('line 81\n');
    h.interrupt();
    expect(await run).toMatchObject({ kind: 'interrupted' });
    expect(h.admin).toHaveBeenLastCalledWith({ type: 'followLogs', follow: false });
    expect(h.out().trimEnd().split('\n').map(line => JSON.parse(line))).toEqual([
      { event: 'log', lines: 'line 78\nline 79\n' }, { event: 'log', lines: 'line 80\n' }, { event: 'log', lines: 'line 81\n' },
    ]);
    expect(h.close).toHaveBeenCalled();
  });

  // 审查后（任务 203）: Ctrl-C did not decide the outcome; a dropped connection while it stopped sending ended it with 3
  it('--follow: after Ctrl-C a dropped connection or a failed request still ends with 130, at once and with nothing left on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const after of ['drop', 'fail'] as const) {
        const h = logs(after === 'drop' ? stopSending : request => stopSending(request) || request.type === 'followLogs');
        const run = caught(runLogs({ tail: 1, follow: true }, h.io(true), h.deps));
        expect(await settled(run)).toBe('still waiting');
        expect(h.admin).toHaveBeenCalledWith({ type: 'followLogs', follow: true });
        h.interrupt();
        expect(h.admin).toHaveBeenLastCalledWith({ type: 'followLogs', follow: false });
        h.emit('line 81\n');
        if (after === 'drop') h.drop();
        else h.fail(new ConnectionError(new Error('closed'))); // the requests out fail instead
        expect(await settled(run), after).toMatchObject({ kind: 'interrupted', message: '不再跟日志。' });
        expect(h.out()).toBe(`${JSON.stringify({ event: 'log', lines: 'line 79\n' })}\n`);
        expect(h.listening()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  // 审查后（任务 203）: a second Ctrl-C waited for the first one's second, and Ctrl-C during the first read was Node's own
  it('--follow: a second Ctrl-C ends at once, and Ctrl-C during the first read is 130 too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const h = logs(stopSending);
      const run = caught(runLogs({ tail: 1, follow: true }, h.io(), h.deps));
      expect(await settled(run)).toBe('still waiting');
      h.interrupt();
      expect(await settled(run)).toBe('still waiting'); // the first one waits up to 1 s for the daemon to stop sending
      h.interrupt();
      expect(await settled(run)).toMatchObject({ kind: 'interrupted' });
      expect(h.admin.mock.calls.filter(([request]) => stopSending(request))).toHaveLength(1);
      expect(h.listening()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      const reading = logs(request => request.type === 'logs');
      const early = caught(runLogs({ tail: 1, follow: true }, reading.io(true), reading.deps));
      expect(await settled(early)).toBe('still waiting');
      reading.interrupt();
      expect(await settled(early)).toMatchObject({ kind: 'interrupted', message: '不再跟日志。' });
      expect(reading.admin.mock.calls.map(([request]) => request.type)).toEqual(['logs']);
      expect(reading.out()).toBe('');
      expect(reading.listening()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  // main 必败: there was no --follow
  it('--follow ends with 3 when the daemon stops, and closes the connection', async () => {
    const h = logs();
    const run = caught(runLogs({ tail: 1, follow: true }, h.io(), h.deps));
    await vi.waitFor(() => expect(h.admin).toHaveBeenCalledWith({ type: 'followLogs', follow: true }));
    h.emit('line 80\n\u001b[31mred\u001b[0m\n');
    h.drop();
    expect(await run).toMatchObject({ kind: 'connection', message: expect.stringContaining('daemon 停了') });
    expect(h.out()).toBe('line 79\nline 80\n[31mred[0m\n');
    expect(h.close).toHaveBeenCalled();
  });
});

// main 必败: there was no service skip
it('service skip sends the choice and prints what the daemon says', async () => {
  const machine = vi.fn(async (request: { skipped: boolean }) => ({ type: 'done', message: request.skipped ? '已跳过登录时启动。' : '已取消跳过。' }));
  const h = harness({ machine });
  await runServiceSkip(false, h.io(true), h.daemon);
  expect(machine).toHaveBeenCalledWith({ type: 'setServiceSkipped', skipped: false });
  expect(JSON.parse(h.out())).toEqual({ ok: true, skipped: false, message: '已取消跳过。' });
  h.clear(); await runServiceSkip(true, h.io(), h.daemon);
  expect(h.out()).toBe('已跳过登录时启动。\n');
});

// main 必败: the two steps said 在网页里点「…」
it('bot status gives the commands for 跳过登录时启动 and 重新检测', () => {
  const lines = stepLines({ id: 'service', title: '登录时启动', status: '还没装', tone: 'warning', done: false, actions: [{ kind: 'serviceSkip', label: '跳过' }, { kind: 'serviceRecheck', label: '重新检测' }] }, 'cli_a');
  expect(lines.slice(1)).toEqual(['    运行 vonvon service skip', '    运行 vonvon service status']);
});

const preview: ContextPreviewReply = {
  kind: 'preview', running: true,
  next: { sections: [{ key: 'identity', version: 'v1', chars: 1234 }, { key: 'botMemory', version: 'v2', chars: 40, items: 12, branches: 2 }], items: { bot: 12, trusted: 3, untrusted: 1 }, tools: ['vonvon_memory'] },
  session: { threadId: 'th_1', updatedAt: T0, backend: 'codex', legacy: false, redeliverDue: true, sections: [{ key: 'identity', version: 'abcdef123', stale: true }],
    lastTurn: { at: T0, injected: 5, items: { bot: 2, trusted: 3, untrusted: 0 }, used: [{ id: 'm1', text: '周四发版' }] } },
  judge: { via: 'local', roleChars: 80, memoryItems: 3, memoryChars: 120 },
};
// main 必败: there was no context show
it('context show asks for a group or the comments and prints both columns', async () => {
  const contextPreview = vi.fn(async () => preview);
  const h = harness({ snapshot: async () => snapshot([agent('cli_a')]), contextPreview });
  await runContextShow({ group: '研发群' }, h.io(), h.daemon);
  expect(contextPreview).toHaveBeenCalledWith({ type: 'get', agentId: 'cli_a', place: { kind: 'group', groupId: 'oc_dev' } });
  const lines = h.out().split('\n');
  expect(lines.slice(0, 4)).toEqual(['下一次新会话会拿到：', '  身份行  1,234 字', '  Bot 记忆  12 条（2 个分支）', '  工具  vonvon_memory']);
  expect(lines).toContain('  身份行  版本 abcdef，下一轮会换新的');
  expect(lines).toContain('  压缩过，下一轮全部重给');
  expect(lines.some(line => line.startsWith('上一轮') && line.endsWith('注入 5 条，模型说用了 1 条'))).toBe(true);
  h.clear(); await runContextShow({ comment: true, session: 'th_2' }, h.io(true), h.daemon);
  expect(contextPreview).toHaveBeenLastCalledWith({ type: 'get', agentId: 'cli_a', place: { kind: 'comment' }, threadId: 'th_2' });
  expect(JSON.parse(h.out())).toEqual({ ok: true, preview });
  for (const options of [{ group: '研发群', comment: true }, {}]) expect(await caught(runContextShow(options, h.io(), h.daemon))).toMatchObject({ kind: 'bad-args' });
  expect(contextPreview).toHaveBeenCalledTimes(2);
});

// main 必败: there was no secrets test
it('secrets test: busy is the right key (0), auth fails with its outcome, a session is refused before connecting', async () => {
  const outcome = { value: 'busy' as 'busy' | 'auth' };
  const admin = vi.fn(async () => ({ kind: 'secretTested', keyId: 'typesafe-api-key', outcome: outcome.value, message: outcome.value === 'busy' ? '服务忙' : 'key 不对' }));
  const h = harness({ admin });
  const ctx = (env: NodeJS.ProcessEnv = {}, json = true): SecretsContext => ({ io: h.io(json), env, warn: () => {}, readKey: async () => '', daemonRunning: async () => true, daemon: h.daemon, direct: async () => { throw new Error('no files'); } });
  await runSecretsTest('typesafe-api-key', [], ctx());
  expect(admin).toHaveBeenCalledWith({ type: 'testSecret', keyId: 'typesafe-api-key' });
  expect(JSON.parse(h.out())).toEqual({ ok: true, keyId: 'typesafe-api-key', outcome: 'busy', message: '服务忙' });
  outcome.value = 'auth';
  expect(await caught(runSecretsTest('typesafe-api-key', [], ctx()))).toMatchObject({ kind: 'failed', reason: 'auth', message: '试了一次：key 不对。换一个 key：vonvon secrets set typesafe-api-key' });
  expect(await caught(runSecretsTest('typesafe-api-key', [], ctx({ VONVON_SESSION: '1' })))).toMatchObject({ kind: 'refused', reason: 'not_in_session' });
  expect(await caught(runSecretsTest('nope', [], ctx()))).toMatchObject({ kind: 'bad-args' });
  expect(h.connect).toHaveBeenCalledTimes(2);
});

// main 必败: there was no now
it('now shows each activity, a possibly stuck one, attention and the latest action; nothing going on is 都闲着', async () => {
  const busy = agent('cli_a', '小助手', { diagnostics: {
    notReplied: [], deniedScopes: [],
    activities: [{ id: '7d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c12', groupId: groupIdSchema.parse('oc_dev'), phase: 'thinking', startedAt: T0 - 120_000, updatedAt: T0 - 61_000 }],
    attention: [{ groupId: 'oc_dev', main: { mode: 'focus', intervalMs: 0 }, focusedTopics: 0, watchedTopics: 2 }],
    latestAction: { id: '8d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c12', groupId: 'oc_dev', kind: 'replied', at: T0 - 10_000 },
  } });
  const h = harness({ snapshot: async () => snapshot([busy, agent('cli_b', '闲着的')]) });
  await runNow(undefined, h.io(), h.daemon, () => T0);
  expect(h.out()).toBe('小助手（cli_a）\n  研发群：思考中（2 分钟）（可能卡住了）\n  关注：研发群 主区专注、2 个话题留意\n  刚刚：在 研发群 回复了\n');
  h.clear(); await runNow(undefined, h.io(true), h.daemon, () => T0);
  expect(JSON.parse(h.out()).bots.map((bot: { id: string; activities: unknown[] }) => [bot.id, bot.activities.length])).toEqual([['cli_a', 1], ['cli_b', 0]]);
  const idle = harness({ snapshot: async () => snapshot([agent('cli_a')]) });
  await runNow(undefined, idle.io(), idle.daemon, () => T0);
  expect(idle.out()).toBe('都闲着。\n');
});

// main 必败: there was no snapshot
it('snapshot --json has the whole state without avatars; a terminal gets a summary', async () => {
  const h = harness({ snapshot: async () => snapshot([agent('cli_a', 'Vonvon Bot', { avatarDataUrl: 'data:image/png;base64,AAAA', connection: 'disconnected' })], { groups: [{ id: groupIdSchema.parse('oc_dev'), name: '研发群', avatarDataUrl: 'data:image/png;base64,BBBB' }] }) });
  await runSnapshot(h.io(true), h.daemon);
  const json = JSON.parse(h.out());
  expect(json).toMatchObject({ ok: true, snapshot: { revision: 1, agents: [{ id: 'cli_a' }], groups: [{ id: 'oc_dev' }], application: { dataPath: '/home/u/.vonvon-bot' } } });
  expect(h.out()).not.toContain('avatarDataUrl');
  h.clear(); await runSnapshot(h.io(), h.daemon);
  expect(h.out()).toBe('daemon 0.8.0 · 1 个 Bot · 1 个群\n问题：Vonvon Bot 没连上飞书\n完整内容加 --json。\n');
});
