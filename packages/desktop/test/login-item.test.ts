import { ChildProcess, type spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_BUSY_MESSAGE, serviceActionMessage } from '@vonvon/protocol';
import type { ServiceActionRecord } from '../../daemon/src/service/action-report.js';
import { toolDirectories } from '../../daemon/src/platform/tool-path.js';
import {
  changeLoginItem, planStartupRepair, repairServiceAtStartup, runServiceHelper,
  type LoginItemHooks, type ServiceRuntime, type StartupRepairInput,
} from '../src/login-item.js';
import type { Registration, VerifiedDaemon } from '../src/daemon-manager.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A packaged app's Resources with the bundled daemon, and its data root. */
async function packagedRuntime(overrides: Partial<ServiceRuntime> = {}): Promise<ServiceRuntime> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-login-item-')));
  roots.push(root);
  const resources = join(root, 'resources');
  const files: Array<[string, string]> = [
    ['daemon/package.json', JSON.stringify({ name: '@vonvon/daemon', version: '0.2.0', bin: { vonvon: 'bin/vonvon.mjs' } })],
    ['daemon/bin/vonvon.mjs', ''],
    ['daemon/dist/cli.js', ''],
    ['app.asar/package.json', JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' })],
    ['app.asar/desktop/main.cjs', ''],
  ];
  for (const [file, content] of files) {
    const path = join(resources, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { platform: 'darwin', packaged: true, root, home: root, executable: '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot', resources, ...overrides };
}

type Spawn = typeof spawn;
/** Each spawned child gets the next pid and exits as `exits` says; `null` never exits. */
function children(...exits: Array<{ code: number | null; signal?: NodeJS.Signals } | null>) {
  const spawned: ChildProcess[] = [];
  const start = vi.fn((..._args: unknown[]) => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 700 + spawned.length });
    child.kill = vi.fn(() => true);
    const exit = exits[spawned.length];
    spawned.push(child);
    if (exit) queueMicrotask(() => child.emit('exit', exit.code, exit.signal ?? null));
    return child;
  });
  return { start, spawn: start as unknown as Spawn, spawned };
}

const done = (pid: number, report: Partial<ServiceActionRecord> = {}): ServiceActionRecord =>
  ({ pid, action: 'install', phase: 'done', ok: true, kind: 'installed', startedAt: 1, finishedAt: 2, ...report });

/** A running report; a live pid keeps it current, so only another helper's own pid makes it "busy". */
const running = (pid: number): ServiceActionRecord => ({ pid, action: 'install', phase: 'running', startedAt: Date.now() });

async function writeReport(runtime: ServiceRuntime, record: ServiceActionRecord): Promise<void> {
  await writeFile(join(runtime.root, 'service-action.json'), JSON.stringify(record));
}

describe('the login-item helper', () => {
  it('runs the bundled vonvon in Node mode with the daemon environment and waits for its report', async () => {
    vi.stubEnv('PATH', ['/usr/bin', '/bin'].join(delimiter));
    vi.stubEnv('VONVON_SERVICE', 'launchd');
    const runtime = await packagedRuntime();
    const { start, spawn } = children({ code: 0 });
    await writeReport(runtime, done(700));
    await runServiceHelper(runtime, 'install', { spawn });
    expect(start).toHaveBeenCalledExactlyOnceWith(runtime.executable,
      [join(runtime.resources, 'daemon', 'bin', 'vonvon.mjs'), 'service', 'install', '--keep-running'], expect.anything());
    const options = start.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv; stdio: unknown[]; detached?: boolean };
    expect(options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', VONVON_HOME: runtime.root, PATH: ['/usr/bin', '/bin', ...toolDirectories(runtime.home)].join(delimiter) });
    expect(options.env).not.toHaveProperty('VONVON_SERVICE');
    expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(options.detached).toBeUndefined();
  });

  it('turns a failed report into its protocol message', async () => {
    const runtime = await packagedRuntime();
    const report = done(700, { action: 'uninstall', ok: false, kind: 'uninstall_refused', reason: 'turned-off', detail: 'turned off in System Settings.' });
    await writeReport(runtime, report);
    const failure = runServiceHelper(runtime, 'uninstall', children({ code: 1 }));
    await expect(failure).rejects.toThrow(serviceActionMessage(report));
    await expect(failure).rejects.toMatchObject({ reason: 'report' });
  });

  it.each([
    ['still running', () => running(process.pid)],
    ['finished after this one started', () => done(9999, { startedAt: Date.now() - 60_000, finishedAt: Date.now() + 1_000 })],
  ])('reads busy from another helper\'s report %s: the mutex refused this one before it wrote anything', async (_case, report) => {
    const runtime = await packagedRuntime();
    await writeReport(runtime, report());
    await expect(runServiceHelper(runtime, 'install', children({ code: 1 }))).rejects.toThrow(SERVICE_BUSY_MESSAGE);
  });

  it.each([
    ['no report', undefined, { code: 1 }],
    ['its own report still running', running(700), { code: null, signal: 'SIGKILL' as const }],
    // Last week's report, or a helper that died mid-run: this one failed for its own reason, written to daemon.log.
    ['an older finished report', done(9999, { finishedAt: Date.now() - 7 * 86_400_000 }), { code: 1 }],
    ['a running report whose helper is gone', running(2 ** 22 + 1), { code: 1 }],
  ])('reports a helper that exited without finishing: %s', async (_case, report, exit) => {
    const runtime = await packagedRuntime();
    if (report) await writeReport(runtime, report);
    await expect(runServiceHelper(runtime, 'install', children(exit))).rejects.toMatchObject({ reason: 'exit' });
  });

  it('stops waiting after the timeout and leaves the helper running', async () => {
    const runtime = await packagedRuntime();
    const { spawn, spawned } = children(null);
    await expect(runServiceHelper(runtime, 'install', { spawn, timeoutMs: 5 })).rejects.toMatchObject({ reason: 'timeout', message: expect.stringContaining('3 分钟') });
    expect(spawned[0]?.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['unsupported', { platform: 'linux' as const }, '这台电脑上不能设置登录时启动。'],
    ['unpackaged', { packaged: false }, '要用打包的 Vonvon Bot 才能设置登录时启动。'],
    ['distribution', { resources: '/nowhere' }, 'app 里的 daemon 不完整，请重新安装 Vonvon Bot。'],
  ])('refuses %s before the window expects a disconnect', async (reason, overrides, message) => {
    const runtime = await packagedRuntime(overrides);
    const { start, spawn } = children({ code: 0 });
    const hooks = { readVerifiedDaemon: vi.fn(async () => null), reattach: vi.fn(async () => {}), expectDisconnect: vi.fn() };
    const refusal = changeLoginItem(runtime, true, null, hooks, { spawn });
    await expect(refusal).rejects.toThrow(message);
    await expect(refusal).rejects.toMatchObject({ reason });
    expect(start).not.toHaveBeenCalled();
    expect(hooks.expectDisconnect).not.toHaveBeenCalled();
  });
});

describe('switching 登录电脑时启动 from the window', () => {
  const previous = { pid: 42, startedAt: 'before', listen: '127.0.0.1:4000' };
  function hooks(after: VerifiedDaemon | null) {
    const expected: boolean[] = [];
    const value = {
      readVerifiedDaemon: vi.fn(async () => after),
      reattach: vi.fn(async () => {}),
      expectDisconnect: vi.fn((flag: boolean) => { expected.push(flag); }),
    } satisfies LoginItemHooks;
    return { ...value, expected };
  }

  it('keeps the connection when the same daemon still runs', async () => {
    const runtime = await packagedRuntime();
    await writeReport(runtime, done(700, { kind: 'already-installed' }));
    const h = hooks(previous);
    await changeLoginItem(runtime, true, previous, h, children({ code: 0 }));
    expect(h.reattach).not.toHaveBeenCalled();
    expect(h.expected).toEqual([true, false]);
  });

  it.each([
    ['a new daemon', { pid: 43, startedAt: 'after', listen: '127.0.0.1:4000' }],
    ['the same pid started again', { pid: 42, startedAt: 'after', listen: '127.0.0.1:4000' }],
    ['no daemon', null],
  ])('reattaches when the verified daemon changed: %s', async (_case, after) => {
    const runtime = await packagedRuntime();
    await writeReport(runtime, done(700, { action: 'uninstall', kind: 'uninstalled', restarted: { pid: 43 } }));
    const h = hooks(after);
    await changeLoginItem(runtime, false, previous, h, children({ code: 0 }));
    expect(h.reattach).toHaveBeenCalledOnce();
    expect(h.expected).toEqual([true]);
  });

  it('reattaches after a failure that replaced the daemon, then reports the failure', async () => {
    const runtime = await packagedRuntime();
    const report = done(700, { ok: false, kind: 'install_rolled_back', reason: 'other', detail: 'bootstrap failed', restarted: { pid: 43 } });
    await writeReport(runtime, report);
    const h = hooks({ ...previous, pid: 43 });
    await expect(changeLoginItem(runtime, true, previous, h, children({ code: 1 }))).rejects.toThrow(serviceActionMessage(report));
    expect(h.reattach).toHaveBeenCalledOnce();
  });

  it('starts no daemon while a helper may still be changing the service', async () => {
    const runtime = await packagedRuntime();
    const h = hooks(null);
    await expect(changeLoginItem(runtime, true, previous, h, { ...children(null), timeoutMs: 5 })).rejects.toMatchObject({ reason: 'timeout' });
    await writeReport(runtime, running(process.pid));
    await expect(changeLoginItem(runtime, true, previous, h, children({ code: 1 }))).rejects.toMatchObject({ reason: 'busy' });
    expect(h.reattach).not.toHaveBeenCalled();
  });

  it('says the window could not reconnect when reattaching fails', async () => {
    const runtime = await packagedRuntime();
    await writeReport(runtime, done(700));
    const h = hooks(null);
    h.reattach.mockRejectedValueOnce(new Error('Daemon did not become ready within the startup wait.'));
    await expect(changeLoginItem(runtime, true, previous, h, children({ code: 0 }))).rejects.toMatchObject({ reason: 'reattach' });
  });
});

describe('repairing the service when the app starts', () => {
  const app = '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot';
  const entry = '/Applications/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs';
  const ours = (kind: 'desktop' | 'npm' = 'desktop'): Registration => ({ kind: 'ours', definition: { kind, executable: app, entry, port: 4000 } });
  const running = (version: string): VerifiedDaemon => ({ pid: 42, startedAt: 'old', listen: '127.0.0.1:4000', version });
  const plan = (input: Partial<StartupRepairInput>) => planStartupRepair({
    platform: 'darwin', packaged: true, executable: app, registration: ours(), running: running('0.2.0'),
    bundledVersion: '0.2.0', exists: () => true, ...input,
  });

  it.each([
    ['moved: the recorded app is gone', { exists: (path: string) => path !== app }, 'reinstall'],
    ['moved: the recorded entry is gone, nothing running', { exists: (path: string) => path !== entry, running: null }, 'reinstall'],
    ['updated: an older daemon runs', { running: running('0.1.9') }, 'reinstall'],
    ['a newer daemon runs', { running: running('0.3.0') }, 'none'],
    ['the same version runs', {}, 'none'],
    ['an npm service, even older and moved', { registration: ours('npm'), running: running('0.1.0'), exists: () => false }, 'none'],
    ['no service and an older daemon', { registration: { kind: 'absent' as const }, running: running('0.1.0') }, 'stop'],
    ['no service and nothing running', { registration: { kind: 'absent' as const }, running: null }, 'none'],
    ['translocated', { executable: '/private/var/folders/x/AppTranslocation/1/d/Vonvon Bot.app/Contents/MacOS/Vonvon Bot', running: running('0.1.0') }, 'none'],
    ['an older definition format', { registration: { kind: 'unrecognized' as const, file: '/p', reason: 'Definition does not match the complete generated format' } }, 'reinstall'],
    ['a symlink under our name', { registration: { kind: 'unrecognized' as const, file: '/p', reason: 'Definition must be a regular file, not a symlink or directory' } }, 'none'],
    ['another root\'s service', { registration: { kind: 'other-root' as const, root: '/other' }, running: running('0.1.0') }, 'none'],
    ['unpackaged', { packaged: false, running: running('0.1.0') }, 'none'],
    ['not macOS', { platform: 'linux' as const, running: running('0.1.0') }, 'none'],
    ['a daemon without a version', { running: { pid: 42, startedAt: 'old', listen: '127.0.0.1:4000' } }, 'none'],
  ])('plans %s', (_case, input, expected) => {
    expect(plan(input)).toBe(expected);
  });

  const reads = (registration: Registration, daemon: VerifiedDaemon | null) =>
    ({ readRegistration: vi.fn(async () => registration), readVerifiedDaemon: vi.fn(async () => daemon) });

  it('stops the older daemon, then installs the service for this app', async () => {
    const runtime = await packagedRuntime({ executable: app });
    const { start, spawn } = children({ code: 0 }, { code: 0 });
    await writeReport(runtime, done(701, { kind: 'already-installed' }));
    await expect(repairServiceAtStartup(runtime, reads(ours(), running('0.1.0')), { stop: { spawn }, helper: { spawn }, exists: () => true })).resolves.toBeUndefined();
    expect(start.mock.calls.map(call => (call[1] as string[]).slice(1))).toEqual([['daemon', 'stop'], ['service', 'install', '--keep-running']]);
  });

  it('keeps the old daemon when it cannot be stopped', async () => {
    const runtime = await packagedRuntime({ executable: app });
    const { start, spawn } = children({ code: 1 });
    const notice = await repairServiceAtStartup(runtime, reads(ours(), running('0.1.0')), { stop: { spawn }, helper: { spawn } });
    expect(notice).toBe('没能停下旧版本的 daemon：vonvon daemon stop 失败（退出码 1），详情在 daemon.log。先用着旧版本，稍后在「应用与启动」里重启 daemon。');
    expect(start).toHaveBeenCalledOnce();
  });

  it('reports an install that failed, for the fatal dialog or the notice', async () => {
    const runtime = await packagedRuntime({ executable: app });
    const report = done(700, { ok: false, kind: 'install_refused', reason: 'turned-off', detail: 'turned off in System Settings.' });
    await writeReport(runtime, report);
    const notice = await repairServiceAtStartup(runtime, reads(ours(), null), { helper: children({ code: 1 }), exists: () => false });
    expect(notice).toBe(`后台服务没能更新到这个位置的 Vonvon Bot：${serviceActionMessage(report)}`);
  });

  it('only stops an older detached daemon when no service is installed', async () => {
    const runtime = await packagedRuntime({ executable: app });
    const { start, spawn } = children({ code: 0 });
    await expect(repairServiceAtStartup(runtime, reads({ kind: 'absent' }, running('0.1.0')), { stop: { spawn }, helper: { spawn } })).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    expect((start.mock.calls[0]?.[1] as string[]).slice(1)).toEqual(['daemon', 'stop']);
  });

  it('leaves startup to ensureReady when the state cannot be read', async () => {
    const runtime = await packagedRuntime({ executable: app });
    const { start, spawn } = children();
    const failing = { readRegistration: async () => ours(), readVerifiedDaemon: async () => { throw new Error('auth failed'); } };
    await expect(repairServiceAtStartup(runtime, failing, { stop: { spawn }, helper: { spawn } })).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });
});
