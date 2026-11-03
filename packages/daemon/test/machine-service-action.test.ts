import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestSchema, SERVICE_BUSY_MESSAGE } from '@vonvon/protocol';
import { fakeService, socketClient, startFixture } from './server-fixture';
import { createServiceActionLauncher, LINUX_SERVICE_REFUSAL } from '../src/host/service-action';
import { machineRpc } from '../src/server/rpc/machine';
import { liveServiceActionRecord, readServiceActionRecord, readServiceSkipped, writeServiceActionRecord, type ServiceActionRecord } from '../src/service/action-report';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function machine(platform: NodeJS.Platform = 'darwin') {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-machine-service-')); roots.push(root);
  const children: (EventEmitter & { pid: number; unref: () => void })[] = [];
  const spawn = vi.fn((..._args: unknown[]) => {
    const child = Object.assign(new EventEmitter(), { pid: 5000 + children.length, unref: vi.fn() });
    children.push(child);
    return child;
  });
  const onSettled = vi.fn();
  const launcher = createServiceActionLauncher({ root, platform, spawn: spawn as never, onSettled, execPath: '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot', cliEntry: '/Applications/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs', now: () => 1000 });
  const snapshots = { observeService: vi.fn(), refreshService: vi.fn(async () => {}) };
  const call = (request: Parameters<typeof machineRpc>[3]) => machineRpc(fakeService(), undefined, 43119, request, { launcher, snapshots, root });
  return { root, spawn, children, onSettled, launcher, snapshots, call };
}
const snapshot = {} as never;

it('darwin install replies first, then spawns the detached helper with the data root and without the service marker', async () => {
  vi.stubEnv('VONVON_SERVICE', 'launchd');
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
  // devices-4a R3: a host started inside a session hands its helper no session marker (service install is local-only there)
  vi.stubEnv('FEISHU_CODEX_BRIDGE', '1');
  vi.stubEnv('VONVON_SESSION', `vs1.ses_0123456789abcdef.${'a'.repeat(43)}`);
  const m = await machine();
  const outcome = await m.call({ type: 'service', action: 'install' });
  if (outcome.kind !== 'shutdown') throw new Error('Expected the reply before the helper');
  expect(outcome.reply(snapshot)).toEqual({ type: 'done', message: '正在打开登录时启动，页面会断开几秒。' });
  expect(m.spawn).not.toHaveBeenCalled();
  expect(m.launcher.current()).toEqual({ action: 'install', startedAt: 1000 });
  outcome.afterReply();
  expect(m.spawn).toHaveBeenCalledOnce();
  const [executable, args, options] = m.spawn.mock.calls[0] as [string, string[], { detached: boolean; stdio: unknown[]; env: NodeJS.ProcessEnv }];
  expect(executable).toBe('/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot');
  expect(args).toEqual(['/Applications/Vonvon Bot.app/Contents/Resources/daemon/bin/vonvon.mjs', 'service', 'install', '--keep-running']);
  expect(options.detached).toBe(true);
  expect(options.stdio[0]).toBe('ignore'); expect(typeof options.stdio[1]).toBe('number'); expect(options.stdio[2]).toBe(options.stdio[1]);
  expect(options.env).toMatchObject({ VONVON_HOME: m.root, ELECTRON_RUN_AS_NODE: '1', PATH: process.env.PATH });
  expect(options.env).not.toHaveProperty('VONVON_SERVICE');
  expect(options.env).not.toHaveProperty('FEISHU_CODEX_BRIDGE');
  expect(options.env).not.toHaveProperty('VONVON_SESSION');
  expect(m.children[0]?.unref).toHaveBeenCalledOnce();
  expect(m.launcher.current()).toEqual({ action: 'install', startedAt: 1000, pid: 5000 });
  expect(await readFile(join(m.root, 'daemon.log'), 'utf8')).toBe('');
});

it('uninstall says it is turning the switch off', async () => {
  const m = await machine();
  const outcome = await m.call({ type: 'service', action: 'uninstall' });
  if (outcome.kind !== 'shutdown') throw new Error('Expected a shutdown outcome');
  expect(outcome.reply(snapshot)).toEqual({ type: 'done', message: '正在关闭登录时启动，页面会断开几秒。' });
  outcome.afterReply();
  expect(m.spawn.mock.calls[0]?.[1]).toEqual([expect.any(String), 'service', 'uninstall', '--keep-running']);
});

it('a second call while the helper is alive is busy, until it exits and the snapshot is refreshed', async () => {
  const m = await machine();
  const first = await m.call({ type: 'service', action: 'install' });
  await expect(m.call({ type: 'service', action: 'uninstall' })).rejects.toMatchObject({ code: 'busy', message: SERVICE_BUSY_MESSAGE });
  if (first.kind !== 'shutdown') throw new Error('Expected a shutdown outcome');
  first.afterReply();
  await expect(m.call({ type: 'service', action: 'install' })).rejects.toMatchObject({ code: 'busy' });
  m.children[0]?.emit('exit', 0, null);
  expect(m.onSettled).toHaveBeenCalledOnce();
  expect(m.launcher.current()).toBeUndefined();
  expect((await m.call({ type: 'service', action: 'install' })).kind).toBe('shutdown');
});

it('a reply that never went out frees the slot without spawning', async () => {
  const m = await machine();
  const outcome = await m.call({ type: 'service', action: 'install' });
  if (outcome.kind !== 'shutdown') throw new Error('Expected a shutdown outcome');
  outcome.cancel?.();
  outcome.afterReply();
  expect(m.spawn).not.toHaveBeenCalled();
  expect(m.launcher.current()).toBeUndefined();
});

it('a running report from a live helper is busy; one from a dead helper is not', async () => {
  const m = await machine();
  await writeServiceActionRecord(m.root, { pid: process.pid, action: 'uninstall', phase: 'running', startedAt: 1 });
  await expect(m.call({ type: 'service', action: 'install' })).rejects.toMatchObject({ code: 'busy', message: SERVICE_BUSY_MESSAGE });
  await writeServiceActionRecord(m.root, { pid: 99_999_999, action: 'uninstall', phase: 'running', startedAt: 1 });
  expect((await m.call({ type: 'service', action: 'install' })).kind).toBe('shutdown');
});

it('a running report whose pid was reused after the helper died is stale: past the longest run, or another user\'s process', async () => {
  const m = await machine();
  const bound = 10 * 60_000;
  await writeServiceActionRecord(m.root, { pid: process.pid, action: 'install', phase: 'running', startedAt: 1 });
  expect(liveServiceActionRecord(m.root, 1 + bound)).toMatchObject({ phase: 'running' });
  expect(liveServiceActionRecord(m.root, 2 + bound)).toBeNull();
  await writeServiceActionRecord(m.root, { pid: process.pid, action: 'install', phase: 'running', startedAt: 999 - bound });
  expect((await m.call({ type: 'service', action: 'install' })).kind).toBe('shutdown');
});

// pid 1 is root's init or launchd: signalling it fails with EPERM unless the tests run as root.
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a running report naming a process this user may not signal is not busy', async () => {
  const m = await machine();
  await writeServiceActionRecord(m.root, { pid: 1, action: 'uninstall', phase: 'running', startedAt: 1000 });
  expect(liveServiceActionRecord(m.root, 1000)).toBeNull();
  expect((await m.call({ type: 'service', action: 'install' })).kind).toBe('shutdown');
});

async function started(m: Awaited<ReturnType<typeof machine>>) {
  const outcome = await m.call({ type: 'service', action: 'install' });
  if (outcome.kind !== 'shutdown') throw new Error('Expected a shutdown outcome');
  outcome.afterReply();
  const child = m.children[0];
  if (!child) throw new Error('Expected a helper');
  return child;
}
it.each([
  ['lost the service mutex', undefined, [1, null], 'install_refused', 'code 1'],
  ['was killed mid-transaction', 'running', [null, 'SIGKILL'], 'install_incomplete', 'SIGKILL'],
] as const)('a helper that %s without writing its result leaves a failed report', async (_case, phase, [code, signal], kind, how) => {
  const m = await machine();
  const child = await started(m);
  if (phase) await writeServiceActionRecord(m.root, { pid: child.pid, action: 'install', phase, startedAt: 1000 });
  child.emit('exit', code, signal);
  await vi.waitFor(() => expect(m.onSettled).toHaveBeenCalledOnce());
  expect(readServiceActionRecord(m.root)).toEqual({ pid: process.pid, action: 'install', phase: 'done', ok: false, kind, reason: 'other', detail: `vonvon service install exited with ${how} before writing its result; see daemon.log`, startedAt: 1000, finishedAt: 1000 });
  expect(m.launcher.current()).toBeUndefined();
});
it.each([
  ['its own failed result', (pid: number): ServiceActionRecord => ({ pid, action: 'install', phase: 'done', ok: false, kind: 'install_refused', reason: 'turned-off', detail: 'turned off in System Settings', startedAt: 1000, finishedAt: 1000 })],
  ['another helper\'s live run', (_pid: number): ServiceActionRecord => ({ pid: process.pid, action: 'uninstall', phase: 'running', startedAt: 1000 })],
] as const)('a helper that exits 1 after %s leaves that report alone', async (_case, report) => {
  const m = await machine();
  const child = await started(m);
  const written = report(child.pid);
  await writeServiceActionRecord(m.root, written);
  child.emit('exit', 1, null);
  expect(m.onSettled).toHaveBeenCalledOnce();
  expect(readServiceActionRecord(m.root)).toEqual(written);
});

it('a helper that cannot start leaves a failed report and frees the slot', async () => {
  const m = await machine();
  const child = await started(m);
  child.emit('error', new Error('spawn ENOENT'));
  child.emit('exit', -2, null);
  await vi.waitFor(() => expect(m.onSettled).toHaveBeenCalledOnce());
  expect(readServiceActionRecord(m.root)).toEqual({ pid: process.pid, action: 'install', phase: 'done', ok: false, kind: 'install_refused', reason: 'other', detail: 'Could not start vonvon service install: spawn ENOENT', startedAt: 1000, finishedAt: 1000 });
  expect(m.launcher.current()).toBeUndefined();
});

it('Linux refuses with the terminal command', async () => {
  const m = await machine('linux');
  for (const action of ['install', 'uninstall'] as const) {
    await expect(m.call({ type: 'service', action })).rejects.toMatchObject({ code: 'unsupported', message: LINUX_SERVICE_REFUSAL });
  }
  expect(LINUX_SERVICE_REFUSAL).toBe('Linux 上请在终端运行 vonvon service install 或 vonvon service uninstall。');
  expect(m.spawn).not.toHaveBeenCalled();
});

it.each(['start', 'stop'] as const)('service %s stays unsupported', async action => {
  const m = await machine();
  await expect(m.call({ type: 'service', action })).rejects.toMatchObject({ code: 'unsupported' });
  expect(m.launcher.current()).toBeUndefined();
});

it('setServiceSkipped writes the machine-level flag beside other keys and refreshes the service read', async () => {
  const m = await machine();
  await writeFile(join(m.root, 'setup.json'), JSON.stringify({ later: { kept: true } }));
  const skipped = await m.call({ type: 'setServiceSkipped', skipped: true });
  expect(skipped.kind).toBe('mutation');
  expect(readServiceSkipped(m.root)).toBe(true);
  expect(JSON.parse(await readFile(join(m.root, 'setup.json'), 'utf8'))).toEqual({ later: { kept: true }, service: { skipped: true, at: expect.any(Number) } });
  expect(m.snapshots.refreshService).toHaveBeenCalledOnce();
  await m.call({ type: 'setServiceSkipped', skipped: false });
  expect(readServiceSkipped(m.root)).toBe(false);
});

it('status hands its fresh read to the snapshot', async () => {
  const m = await machine();
  const outcome = await m.call({ type: 'status' });
  expect(outcome.kind).toBe('read');
  expect(m.snapshots.observeService).toHaveBeenCalledOnce();
});

it('the web UI install replies over the socket, then starts the helper, and the snapshot shows it running', async () => {
  const spawned: unknown[][] = [];
  const spawn = vi.fn((...args: unknown[]) => { spawned.push(args); return Object.assign(new EventEmitter(), { pid: 6001, unref: () => {} }); });
  const fixture = await startFixture(fakeService(), undefined, { platform: 'darwin', spawn: spawn as never, readService: async () => ({ supported: true, installed: false, running: true, state: 'not-installed' }) });
  try {
    const client = await socketClient(fixture.api.port, fixture.credential);
    await client.ready();
    const reply = await client.call(requestSchema.parse({ type: 'request', id: 'install', method: 'machine', payload: { type: 'service', action: 'install' } }));
    expect(reply).toMatchObject({ type: 'response', payload: { type: 'done', message: '正在打开登录时启动，页面会断开几秒。' } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[1]).toEqual([process.argv[1], 'service', 'install', '--keep-running']);
    await client.wait(frame => frame.type === 'event' && frame.event === 'snapshot' && frame.payload.application.service?.action?.phase === 'running');
    const busy = await client.call(requestSchema.parse({ type: 'request', id: 'again', method: 'machine', payload: { type: 'service', action: 'uninstall' } }));
    expect(busy).toMatchObject({ type: 'error', code: 'busy', message: SERVICE_BUSY_MESSAGE });
    await client.close();
  } finally { await fixture.close(); }
});
