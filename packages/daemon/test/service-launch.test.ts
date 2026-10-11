import { ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), info: vi.fn(), warn: vi.fn(), fail: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }));
vi.mock('../src/core/logger', () => ({ log: { info: fixture.info, warn: fixture.warn, fail: fixture.fail } }));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: mkdtempSync(join(tmpdir(), 'vonvon-service-launch-')) } };
});

import { paths } from '../src/config/paths';
import { linuxHelperReady, listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from '../src/host/lifecycle';
import { ApiCleanupError } from '../src/server/http';
import { readUpdateStatus, writeUpdateStatus, type UpdateStatus } from '../src/service/update';

const record: UpdateStatus = Object.freeze({ phase: 'restarting', ok: true, from: '0.7.0', to: '0.7.1', at: 42 });
const startedAt = '2026-10-11T00:00:00.000Z';
const controls: ShutdownControl[] = [];
let child: ChildProcess;
let cgroup: string;
let cmdline: string;
let readProc: ReturnType<typeof vi.fn<(pid: number, file: 'cgroup' | 'cmdline') => string>>;

function control(options: Parameters<typeof observeShutdown>[1] = {}): ShutdownControl {
  const owner = observeShutdown(false, {
    serviceManaged: true, platform: 'linux', now: Date.now, setTimeout, clearTimeout, readProc, ...options,
  });
  controls.push(owner);
  return owner;
}
function launch(): { scope: string; args: string[] } {
  const call = fixture.spawn.mock.calls[0];
  if (!call || !Array.isArray(call[1]) || !call[1].every((arg: unknown) => typeof arg === 'string')) throw new Error('Missing helper launch');
  const argv: string[] = call[1];
  const unit = argv[3];
  if (!unit?.startsWith('--unit=')) throw new Error('Missing helper scope');
  return { scope: unit.slice(7), args: argv.slice(5) };
}
function proof(): void {
  const { scope, args } = launch();
  cgroup = `0::/user.slice/${scope}\n`;
  cmdline = ['/rewritten/node', ...args].join('\0') + '\0';
}
function died(): void { Object.defineProperty(child, 'exitCode', { value: 1, configurable: true }); child.emit('exit', 1, null); child.emit('close', 1, null); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
  vi.stubEnv('VONVON_SERVICE', '');
  vi.stubGlobal('process', Object.assign(Object.create(process), { send: undefined }));
  child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 54321, configurable: true });
  vi.spyOn(child, 'kill').mockReturnValue(true);
  vi.spyOn(child, 'unref').mockImplementation(() => {});
  fixture.spawn.mockReturnValue(child);
  cgroup = '0::/user.slice/vonvon-bot.service\n';
  cmdline = 'systemd-run\0--user\0';
  readProc = vi.fn((pid, file) => {
    expect(pid).toBe(54321);
    return file === 'cgroup' ? cgroup : cmdline;
  });
  writeFileSync(join(paths.appDir, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt }));
  writeUpdateStatus(record);
});
afterEach(() => {
  for (const owner of controls.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const file of readdirSync(paths.appDir)) rmSync(join(paths.appDir, file), { force: true });
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

describe('Linux helper proof', () => {
  const scope = 'vonvon-bot-update-0123456789abcdef.scope';
  const args = ['cli', '__restart-after-exit', '1234', '42', startedAt, JSON.stringify(record)];
  it('ignores only argv zero', () => {
    expect(linuxHelperReady(`0::/user.slice/${scope}\n`, ['/absolute/node', ...args], scope, args)).toBe(true);
  });
  it.each([
    '', '1:cpu:/scope', `0::relative/${scope}`, `0::/vonvon-bot.service/${scope}`,
    '0::/different.scope', `0::/user.slice/${scope}/`, `0::/user.slice//${scope}`,
    `0::/../${scope}`, `0::/user.slice/${scope}\n0::/other`, `0::/bad\0/${scope}`,
  ])('rejects malformed or unowned cgroup %j', value => {
    expect(linuxHelperReady(value, ['node', ...args], scope, args)).toBe(false);
  });
  it.each([['node', ...args, 'extra'], ['node', ...args.slice(0, -1)], ['node', '--user'], ['node', ...args.slice(0, -1), 'changed']])('requires every helper argument %j', (...argv) => {
    expect(linuxHelperReady(`0::/${scope}`, argv, scope, args)).toBe(false);
  });
});

it('keeps an empty drain pending until scope and exec proofs agree in one poll', async () => {
  const owner = control();
  owner.requestRestart(1234, record);
  const { scope, args } = launch();
  expect(scope).toMatch(/^vonvon-bot-update-[0-9a-f]{16}\.scope$/);
  expect(args).toEqual([process.argv[1], '__restart-after-exit', '1234', String(process.pid), startedAt, JSON.stringify(record)]);
  expect(fixture.spawn).toHaveBeenCalledWith('systemd-run', ['--user', '--scope', '--quiet', `--unit=${scope}`, process.execPath, ...args], { detached: true, stdio: 'ignore', env: { ...process.env } });
  const release = vi.fn(async () => {});
  const completion = owner.completeShutdown(release);
  const awakened = vi.fn();
  void owner.waitForRequest().then(awakened);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(release).not.toHaveBeenCalled();
  expect(readProc).not.toHaveBeenCalled();
  child.emit('spawn');
  await vi.advanceTimersByTimeAsync(150);
  expect(awakened).not.toHaveBeenCalled();
  cgroup = `0::/user.slice/${scope}`;
  await vi.advanceTimersByTimeAsync(100);
  expect(release).not.toHaveBeenCalled();
  proof();
  await vi.advanceTimersByTimeAsync(50);
  await completion;
  expect(release).toHaveBeenCalledOnce();
  expect(awakened).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(readUpdateStatus()).toEqual(record);
  owner.requestStop();
  died();
  expect(child.kill).not.toHaveBeenCalled();
  expect(readUpdateStatus()).toEqual(record);
  expect(fixture.info).toHaveBeenCalledWith('daemon-shutdown', 'stop_after_commit', expect.any(Object));
});

it('treats proc read errors as pending and recovers on a later complete proof', async () => {
  const owner = control(); owner.requestRestart(1234, record); child.emit('spawn'); proof();
  readProc.mockImplementationOnce(() => { throw new Error('proc unavailable'); });
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  await vi.advanceTimersByTimeAsync(50); expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50); await completion;
  expect(release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['before spawn', 'pending', 'ready'] as const)('stop %s waits for observed death even after TERM, KILL and a born-child error', async timing => {
  const owner = control(); owner.requestRestart(1234, record);
  if (timing !== 'before spawn') child.emit('spawn');
  if (timing === 'ready') { proof(); await vi.advanceTimersByTimeAsync(50); }
  owner.requestStop();
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  if (timing === 'before spawn') { child.emit('spawn'); expect(child.kill).toHaveBeenCalledTimes(2); }
  child.emit('error', new Error('born child error'));
  await vi.advanceTimersByTimeAsync(4999); expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(1); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(100_000); expect(release).not.toHaveBeenCalled();
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启已被停止取消', from: record.from, to: record.to });
  died(); await completion;
  expect(release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it('expires at the spawn deadline before accepting a late proof and waits without a death deadline', async () => {
  const owner = control(); owner.requestRestart(1234, record); child.emit('spawn');
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  await vi.advanceTimersByTimeAsync(24_950); expect(child.kill).not.toHaveBeenCalled();
  proof(); await vi.advanceTimersByTimeAsync(50);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: 'helper_lost' });
  await vi.advanceTimersByTimeAsync(5000); expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  await vi.advanceTimersByTimeAsync(100_000); expect(release).not.toHaveBeenCalled();
  died(); await completion;
  expect(release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['spawn failure', 'scope death', 'synchronous spawn failure'] as const)('%s records helper_lost and releases once', async failure => {
  if (failure === 'spawn failure') Object.defineProperty(child, 'pid', { value: undefined, configurable: true });
  if (failure === 'synchronous spawn failure') fixture.spawn.mockImplementationOnce(() => { throw new Error('missing systemd-run'); });
  const owner = control(); owner.requestRestart(1234, record);
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  if (failure === 'spawn failure') child.emit('error', new Error('ENOENT'));
  if (failure === 'scope death') { child.emit('spawn'); died(); }
  await completion;
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: 'helper_lost' });
  expect(release).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it('managed plain restart needs no owner file or child and leaves a stale record unchanged', async () => {
  rmSync(join(paths.appDir, 'daemon.pid'));
  const before = readFileSync(join(paths.appDir, 'update-status.json'), 'utf8');
  const owner = control(); owner.requestRestart(1234); owner.requestRestart(1234);
  const release = vi.fn(async () => {}); await owner.completeShutdown(release);
  expect(fixture.spawn).not.toHaveBeenCalled(); expect(readProc).not.toHaveBeenCalled();
  expect(readFileSync(join(paths.appDir, 'update-status.json'), 'utf8')).toBe(before);
  expect(release).toHaveBeenCalledOnce();
});
it('rejects an update restart while a helper-free restart is already pending', () => {
  const owner = control(); owner.requestRestart(1234); owner.requestRestart(1234, record);
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '已有重启正在进行' });
});

it.each(['self-hosted', 'darwin', 'win32', 'bot child'] as const)('%s retains the detached Node helper', async mode => {
  if (mode === 'bot child') vi.stubGlobal('process', Object.assign(Object.create(process), { send: vi.fn() }));
  const owner = control({ serviceManaged: mode !== 'self-hosted', platform: mode === 'darwin' || mode === 'win32' ? mode : 'linux' });
  owner.requestRestart(1234, record);
  expect(fixture.spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], '__restart-after-exit', '1234', String(process.pid), startedAt, JSON.stringify(record)], { detached: true, stdio: 'ignore', env: { ...process.env } });
  child.emit('spawn'); await owner.waitForRequest();
  const release = vi.fn(async () => {}); await owner.completeShutdown(release);
  expect(release).toHaveBeenCalledOnce(); expect(readProc).not.toHaveBeenCalled();
});

it.each(['changed record', 'live lock'] as const)('does not overwrite update ownership after %s', async mode => {
  const owner = control(); owner.requestRestart(1234, record); child.emit('spawn');
  if (mode === 'changed record') writeUpdateStatus({ ...record, at: 43 });
  else writeFileSync(join(paths.appDir, 'update.lock'), JSON.stringify({ pid: process.pid, at: 0 }));
  const before = readFileSync(join(paths.appDir, 'update-status.json'), 'utf8');
  owner.requestStop(); died(); await owner.completeShutdown(async () => {});
  expect(readFileSync(join(paths.appDir, 'update-status.json'), 'utf8')).toBe(before);
});

it.each(['confirmed cleanup', 'unknown cutoff'] as const)('caches %s rejection without changing listener error classification', async kind => {
  const owner = control(); owner.requestRestart(1234);
  const failure = new Error('listener failure');
  const error = kind === 'confirmed cleanup' ? new ApiCleanupError([failure]) : failure;
  const release = vi.fn(async () => { throw error; });
  const first = owner.completeShutdown(release); const second = owner.completeShutdown(async () => {});
  expect(second).toBe(first);
  const rejected = await first.catch(value => value);
  expect(listenerCloseUnconfirmed(rejected)).toBe(kind === 'unknown cutoff');
  if (kind === 'confirmed cleanup') expect(rejected).toBe(error);
  else expect(rejected.errors).toEqual([error]);
  expect(release).toHaveBeenCalledOnce();
});

it('does not combine scope proof from one poll with exec proof from another', async () => {
  const owner = control(); owner.requestRestart(1234, record); child.emit('spawn');
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  const { scope, args } = launch();
  cgroup = `0::/${scope}`;
  await vi.advanceTimersByTimeAsync(50);
  cgroup = '0::/vonvon-bot.service';
  cmdline = ['node', ...args].join('\0') + '\0';
  await vi.advanceTimersByTimeAsync(50);
  expect(release).not.toHaveBeenCalled();
  proof(); await vi.advanceTimersByTimeAsync(50); await completion;
  expect(release).toHaveBeenCalledOnce();
});

it('uses the service environment by default and still exempts Bot children', async () => {
  vi.stubEnv('VONVON_SERVICE', '1');
  const owner = control({ serviceManaged: undefined });
  owner.requestRestart(1234);
  expect(fixture.spawn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  await owner.waitForRequest();
  await owner.completeShutdown(async () => {});
  vi.stubGlobal('process', Object.assign(Object.create(process), { send: vi.fn() }));
  const bot = control({ serviceManaged: undefined });
  bot.requestRestart(1234, record);
  expect(fixture.spawn.mock.calls[0]?.[0]).toBe(process.execPath);
  child.emit('spawn');
  await bot.completeShutdown(async () => {});
});

it('keeps a pending complete call blocked when stop cancels readiness', async () => {
  const owner = control(); owner.requestRestart(1234, record); child.emit('spawn');
  const release = vi.fn(async () => {}); const completion = owner.completeShutdown(release);
  owner.requestStop();
  await vi.advanceTimersByTimeAsync(0);
  expect(release).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  died(); await completion;
  expect(release).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
