import { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminServiceDeps } from '../src/admin/service';
import type { PidLockInfo } from '../src/server/pid-lock';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  verify: vi.fn(async () => {}),
  stopVerified: vi.fn(async () => {}),
  alive: new Set<number>(),
  adapter: {
    install: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), restart: vi.fn(async () => {}),
    status: vi.fn(async () => ({ supported: true, installed: false, running: false })),
  },
  getAdapter: vi.fn(),
  registryClose: vi.fn<() => Promise<void>>(async () => {}),
  registryPids: vi.fn<() => number[]>(() => []),
  startBridge: vi.fn(),
  bridgeShutdown: vi.fn(async () => {}),
  apiRelease: vi.fn(async () => {}),
  apiDrain: vi.fn(async () => {}),
  apiReady: vi.fn(),
  logWarn: vi.fn(), logFail: vi.fn(),
  admin: undefined as AdminServiceDeps | undefined,
  mutexHeld: false,
  botHeld: false,
  botRelease: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn, spawnSync: fixture.spawnSync }));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-lifecycle-red-')));
  console.log('runner fixture root', appDir);
  return { paths: { appDir }, botPaths: (appId: string) => ({ processesFile: join(appDir, appId + '.lock') }) };
});
vi.mock('../src/server/pid-lock', async (original) => {
  const real = await original<typeof import('../src/server/pid-lock')>();
  const { paths } = await import('../src/config/paths');
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { z } = await import('zod');
  const schema = z.object({ pid: z.number(), startedAt: z.string(), listen: z.string() });
  const read = (): PidLockInfo | null => {
    const file = join(paths.appDir, 'daemon.pid');
    return existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
  };
  return {
    ...real,
    getPidLockInfo: async () => read(),
    isPidLockOwnerRunning: (lock: PidLockInfo | null) => lock !== null && fixture.alive.has(lock.pid),
    readRunningPidLock: async () => {
      const lock = read();
      return lock && fixture.alive.has(lock.pid) ? lock : null;
    },
  };
});
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: fixture.verify, stopVerifiedOwner: fixture.stopVerified }));
vi.mock('../src/service/adapter', () => ({ getServiceAdapter: fixture.getAdapter }));
vi.mock('../src/service/win-startup', () => ({ readVonvonRunValue: () => ({ kind: 'absent' }) }));

vi.mock('../src/agent/codex-appserver/owned-process', () => ({
  closeOwnedCodexProcesses: fixture.registryClose,
  unconfirmedCodexPids: fixture.registryPids,
}));
vi.mock('../src/agent', () => ({ installBackendDep() {}, uninstallBackendDep() {} }));
vi.mock('../src/bot/bridge', () => ({ startBridge: fixture.startBridge }));
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: async () => ({ cfg: { accounts: { app: { id: 'runner-bot' } } }, secret: 'fixture' }),
  announceEventsWhenLive() {},
}));
vi.mock('../src/config/bots', () => ({ ensureRegistry: async () => ({ bots: [] }), activeBots: () => [], loadBots: async () => ({ bots: [] }) }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: fixture.spawn, spawnProcessSync: fixture.spawnSync }));
vi.mock('../src/admin/service', () => ({ createAdminService: (deps: AdminServiceDeps) => { fixture.admin = deps; return deps; } }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn: fixture.logWarn, fail: fixture.logFail } }));
vi.mock('../src/core/single-instance', () => ({
  BridgeAlreadyRunningError: class extends Error {},
  readSingleInstanceHolder: () => undefined,
  acquireSingleInstanceLock: () => {
    if (fixture.botHeld) throw new Error('Bot lock busy');
    fixture.botHeld = true;
    return () => { fixture.botHeld = false; fixture.botRelease(); };
  },
}));
vi.mock('../src/config/data-access', async original => ({
  ...await original<typeof import('../src/config/data-access')>(),
  acquireMutex: async () => {
    if (fixture.mutexHeld) throw new Error('Host mutex busy');
    fixture.mutexHeld = true;
    return {};
  },
  closeMutex: async () => { fixture.mutexHeld = false; },
}));
vi.mock('../src/server/http', () => ({
  ApiCleanupError: class ApiCleanupError extends AggregateError {
    constructor(errors: Iterable<unknown>) { super(errors, 'API cleanup failed after listener cutoff'); }
  },
  startApi: async () => {
    fixture.apiReady();
    return { port: 43119, listen: '127.0.0.1:43119', invalidate() {}, beginDrain: fixture.apiDrain, release: fixture.apiRelease, close: fixture.apiRelease };
  },
}));

import * as http from '../src/server/http';
import { runRun } from '../src/cli/commands/run';
import { runHostRuntime } from '../src/host/bootstrap';
import { runSupervisor } from '../src/bot/supervisor';
import { acquireSingleInstanceLock } from '../src/core/single-instance';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { paths } from '../src/config/paths';
import { observeShutdown, settleOwnedChild, type ShutdownControl } from '../src/host/lifecycle';
import { runSamePortRestartHelper } from '../src/host/restart';
import { runStart, runStop } from '../src/cli/commands/daemon';
import { runServiceCommand } from '../src/cli/commands/service';
import { controlDesktopService } from '../src/host/service';
import { acquireUpdateLock, finishOwnedUpdate, readUpdateStatus, restartDaemon, writeUpdateStatus } from '../src/service/update';

const old = { pid: 43210, startedAt: '2026-10-10T00:00:00.000Z', listen: '127.0.0.1:43119' } satisfies PidLockInfo;
const replacement = { pid: 43211, startedAt: '2026-10-10T00:02:00.000Z', listen: old.listen } satisfies PidLockInfo;
const originalEntry = process.argv[1];
const controls: ShutdownControl[] = [];
const children: ChildProcess[] = [];
function publish(lock: PidLockInfo): void { writeFileSync(join(paths.appDir, 'daemon.pid'), JSON.stringify(lock)); fixture.alive.add(lock.pid); }
function clearOwner(): void { rmSync(join(paths.appDir, 'daemon.pid'), { force: true }); fixture.alive.delete(old.pid); }
function child(): ChildProcess {
  const value = new ChildProcess();
  Object.defineProperty(value, 'pid', { value: 54321 });
  value.kill = vi.fn(() => true);
  value.unref = vi.fn();
  children.push(value);
  return value;
}
function control(): ShutdownControl { writeFileSync(join(paths.appDir, 'daemon.pid'), JSON.stringify({ ...old, pid: process.pid })); const value = observeShutdown(); controls.push(value); return value; }
function observed<T>(promise: Promise<T>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let error: unknown;
  const settled = promise.then(() => { state = 'fulfilled'; }, (reason: unknown) => { state = 'rejected'; error = reason; });
  return { state: () => state, error: () => error, settled };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
  vi.clearAllMocks();
  fixture.registryClose.mockReset().mockResolvedValue();
  fixture.registryPids.mockReset().mockReturnValue([]);
  fixture.apiRelease.mockReset().mockResolvedValue();
  fixture.apiDrain.mockReset().mockResolvedValue();
  fixture.bridgeShutdown.mockReset().mockResolvedValue();
  fixture.startBridge.mockReset().mockResolvedValue({ shutdown: fixture.bridgeShutdown, channel: {} });
  fixture.botHeld = false; fixture.mutexHeld = false; fixture.admin = undefined;
  fixture.alive.clear();
  fixture.getAdapter.mockReturnValue(fixture.adapter);
  fixture.spawn.mockImplementation(() => {
    const value = child();
    queueMicrotask(() => { publish(replacement); Object.defineProperty(value, 'exitCode', { value: 0, configurable: true }); value.emit('exit', 0, null); });
    return value;
  });
  process.argv[1] = '/owned/fixture/vonvon.mjs';
});
afterEach(() => {
  for (const value of controls.splice(0)) value.dispose();
  for (const value of children.splice(0)) { Object.defineProperty(value, 'exitCode', { value: 0, configurable: true }); value.emit('exit', 0, null); value.removeAllListeners(); }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalEntry === undefined) delete process.argv[1];
  else process.argv[1] = originalEntry;
  for (const name of readdirSync(paths.appDir)) rmSync(join(paths.appDir, name), { recursive: true, force: true });
});
afterAll(() => { console.log('runner fixture removed', paths.appDir); rmSync(paths.appDir, { recursive: true, force: true }); });

describe('same-port helper ownership', () => {
  it('waits through 120 seconds of retained ownership and starts exactly once after release', async () => {
    publish(old);
    const running = observed(runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt }));
    await vi.advanceTimersByTimeAsync(31_000);
    expect.soft(running.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(88_000);
    expect.soft(running.state()).toBe('pending');
    expect.soft(fixture.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    clearOwner();
    await vi.advanceTimersByTimeAsync(100);
    await running.settled;
    expect.soft(running.state()).toBe('fulfilled');
    expect(fixture.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ['/owned/fixture/vonvon.mjs', 'daemon', 'start', '--port', '43119'], expect.any(Object));
  });
  it('rejects a foreign-port owner without spawning or signaling it', async () => {
    publish({ ...replacement, listen: '127.0.0.1:43120' });
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt })).rejects.toThrow(/superseded|43120|port/i);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
  });
  it('verifies an already-ready same-port replacement before counting success', async () => {
    publish(replacement);
    await runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt });
    expect(fixture.verify).toHaveBeenCalledWith(paths.appDir, replacement);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('plain restart cannot complete an unrelated restarting update record', async () => {
    const unrelated = { phase: 'restarting', ok: true, from: '1', to: '2', at: 10 } as const;
    writeUpdateStatus(unrelated);
    const running = observed(runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt }));
    await vi.advanceTimersByTimeAsync(100);
    await running.settled;
    expect(running.state()).toBe('fulfilled');
    expect(readUpdateStatus()).toEqual(unrelated);
  });
});

describe('stop wins before restart commit', () => {
  it('a stop accepted before restart prevents helper creation', () => {
    const owner = control();
    owner.requestStop();
    owner.requestRestart(43119);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('cancels a helper whose spawn notification arrives after stop', async () => {
    const helper = child(); fixture.spawn.mockReturnValue(helper);
    const owner = control();
    owner.requestRestart(43119);
    owner.requestStop();
    helper.emit('spawn');
    await vi.advanceTimersByTimeAsync(0);
    expect(helper.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('escalates cancellation after five seconds and still retains release until observed exit', async () => {
    const helper = child(); fixture.spawn.mockReturnValue(helper);
    const owner = control(); owner.requestRestart(43119); helper.emit('spawn'); owner.requestStop();
    const release = vi.fn(async () => {});
    const done = observed(owner.completeShutdown(release));
    await vi.advanceTimersByTimeAsync(120_000);
    expect.soft(helper.kill).toHaveBeenCalledWith('SIGTERM');
    expect.soft(helper.kill).toHaveBeenCalledWith('SIGKILL');
    expect.soft(done.state()).toBe('pending');
    expect.soft(release).not.toHaveBeenCalled();
    Object.defineProperty(helper, 'signalCode', { value: 'SIGKILL', configurable: true }); helper.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toHaveBeenCalledTimes(1);
    await done.settled;
  });
  it('a generic postbirth child error cannot stand in for cancellation exit', async () => {
    const helper = child(); fixture.spawn.mockReturnValue(helper);
    const owner = control(); owner.requestRestart(43119); helper.emit('spawn');
    helper.emit('error', new Error('fixture transport error while process remains alive'));
    owner.requestStop();
    const release = vi.fn(async () => {});
    const done = observed(owner.completeShutdown(release));
    await vi.advanceTimersByTimeAsync(6000);
    expect.soft(done.state()).toBe('pending');
    expect.soft(release).not.toHaveBeenCalled();
    expect(helper.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('an already-exited helper fails only its matching update before release', async () => {
    const helper = child();
    Object.defineProperty(helper, 'exitCode', { value: 1, configurable: true });
    fixture.spawn.mockReturnValue(helper);
    const update = { phase: 'restarting', from: '1', to: '2', ok: true, at: 10 } as const;
    writeUpdateStatus(update);
    const owner = control(); owner.requestRestart(43119, update);
    const release = vi.fn(async () => { expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, from: '1', to: '2' }); });
    const done = observed(owner.completeShutdown(release));
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, from: '1', to: '2' });
    expect.soft(release).toHaveBeenCalledTimes(1);
    expect(helper.kill).not.toHaveBeenCalled();
    await done.settled;
  });
  it('awaits physical listener closure and ignores stop cancellation after commit', async () => {
    const helper = child(); fixture.spawn.mockReturnValue(helper);
    const owner = control(); owner.requestRestart(43119); helper.emit('spawn');
    let close: () => void = () => {};
    const release = vi.fn(() => new Promise<void>((resolve) => { close = resolve; }));
    const done = observed(owner.completeShutdown(release));
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(release).toHaveBeenCalledTimes(1);
    expect.soft(done.state()).toBe('pending');
    owner.requestStop();
    expect(helper.kill).not.toHaveBeenCalled();
    close(); await done.settled;
    expect(done.state()).toBe('fulfilled');
  });
});

describe('CLI ownership', () => {
  it('explicit start port refuses an existing different-port owner without spawning', async () => {
    publish(replacement);
    await expect(runStart(43120)).rejects.toThrow(/43119|port/i);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('port zero accepts a verified existing owner', async () => {
    publish(replacement);
    await expect(runStart(0)).resolves.toMatchObject({ pid: replacement.pid, listen: replacement.listen });
    expect(fixture.verify).toHaveBeenCalled();
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('stop uses verified stopHost, sends no signal, and waits beyond 120 seconds', async () => {
    publish(old);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const done = observed(runStop());
    await vi.advanceTimersByTimeAsync(120_000);
    expect.soft(fixture.stopVerified).toHaveBeenCalledWith(paths.appDir, old);
    expect.soft(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
    expect.soft(done.state()).toBe('pending');
    clearOwner(); await vi.advanceTimersByTimeAsync(1000); await done.settled;
    expect(done.state()).toBe('fulfilled');
  });
  it('stop fails when a replacement takes ownership instead of claiming it stopped', async () => {
    publish(old);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const done = observed(runStop());
    await vi.advanceTimersByTimeAsync(100);
    fixture.alive.delete(old.pid); publish(replacement);
    await vi.advanceTimersByTimeAsync(1000); await done.settled;
    expect(done.state()).toBe('rejected');
    expect(String(done.error())).toContain(String(replacement.pid));
    expect(String(done.error())).toContain(replacement.listen);
  });
});

describe('V3 service refusal', () => {
  const refusal = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';
  it.each(['install', 'uninstall'] as const)('service %s refuses before loading an adapter or mutating files', async (action) => {
    const before = readdirSync(paths.appDir);
    const result = observed(runServiceCommand(action)); await result.settled;
    expect.soft(String(result.error())).toContain(refusal);
    expect.soft(fixture.getAdapter).not.toHaveBeenCalled();
    expect.soft(fixture.adapter.install).not.toHaveBeenCalled();
    expect.soft(fixture.adapter.uninstall).not.toHaveBeenCalled();
    expect.soft(fixture.spawn).not.toHaveBeenCalled();
    expect.soft(fixture.spawnSync).not.toHaveBeenCalled();
    expect(readdirSync(paths.appDir)).toEqual(before);
  });
  it.each(['install', 'start', 'stop', 'uninstall'])('desktop service %s also refuses before adapter access', async (action) => {
    const result = observed(controlDesktopService(action)); await result.settled;
    expect.soft(String(result.error())).toContain(refusal);
    expect(fixture.getAdapter).not.toHaveBeenCalled();
  });
  it('legacy restartDaemon cannot reach the OS service adapter', async () => {
    const result = observed(restartDaemon()); await result.settled;
    expect.soft(String(result.error())).toContain(refusal);
    expect.soft(fixture.getAdapter).not.toHaveBeenCalled();
    expect(fixture.adapter.restart).not.toHaveBeenCalled();
  });
});

it('an aged live update lock remains owned and its bytes stay unchanged', () => {
  const file = join(paths.appDir, 'update.lock');
  const record = JSON.stringify({ pid: process.pid, at: Date.now() - 31 * 60_000 });
  writeFileSync(file, record);
  const release = acquireUpdateLock();
  try {
    expect.soft(release).toBeNull();
    expect.soft(readFileSync(file, 'utf8')).toBe(record);
    expect(existsSync(file)).toBe(true);
  } finally { release?.(); }
});

describe('exact update record ownership', () => {
  const record = { phase: 'restarting', ok: true, message: 'owned', from: '1', to: '2', at: 10 } as const;
  it.each([
    { phase: 'installing' as const }, { ok: false }, { message: 'other' },
    { from: 'other' }, { to: 'other' }, { at: 11 }, { message: undefined },
  ])('preserves a record differing in %j', change => {
    const newer = { ...record, ...change };
    writeUpdateStatus(newer);
    finishOwnedUpdate(record, 'done');
    expect(readUpdateStatus()).toEqual(JSON.parse(JSON.stringify(newer)));
  });
  it('compares all fields and writes only while holding the existing lock', () => {
    writeUpdateStatus(record);
    const release = acquireUpdateLock();
    expect(release).not.toBeNull();
    finishOwnedUpdate(record, 'done');
    expect(readUpdateStatus()).toEqual(record);
    release?.();
    finishOwnedUpdate(record, 'done');
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', ok: true, from: '1', to: '2', message: 'owned' });
    expect(existsSync(join(paths.appDir, 'update.lock'))).toBe(false);
  });
  it('writes cancellation before release and never overwrites a later update', async () => {
    const helper = child(); fixture.spawn.mockReturnValue(helper);
    const owner = control(); writeUpdateStatus(record);
    owner.requestRestart(43119, record); helper.emit('spawn');
    owner.requestStop();
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', message: '重启已被停止取消', from: '1', to: '2' });
    const newer = { ...record, at: 11 }; writeUpdateStatus(newer);
    helper.emit('exit', 0, null);
    await owner.completeShutdown(async () => { expect(readUpdateStatus()).toEqual(newer); });
  });
  it('writes done only after verified same-port replacement', async () => {
    writeUpdateStatus(record); publish(replacement);
    fixture.verify.mockImplementationOnce(async () => { expect(readUpdateStatus()).toEqual(record); });
    await runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt, update: record });
    expect(readUpdateStatus()).toMatchObject({ phase: 'done', from: '1', to: '2' });
  });
  it('does not finalize an update that changed during owner verification', async () => {
    writeUpdateStatus(record); publish(replacement);
    const newer = { ...record, message: 'new invocation' };
    fixture.verify.mockImplementationOnce(async () => { writeUpdateStatus(newer); });
    await runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt, update: record });
    expect(readUpdateStatus()).toEqual(newer);
  });
  it('marks only its own superseded update as failed', async () => {
    writeUpdateStatus(record); publish({ ...replacement, listen: '127.0.0.1:43120' });
    await expect(runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt, update: record })).rejects.toThrow('superseded');
    expect(readUpdateStatus()).toMatchObject({ phase: 'error', ok: false, message: 'superseded' });
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});

it('treats the same PID with a newer startedAt as a replacement', async () => {
  const reused = { ...replacement, pid: old.pid }; publish(reused);
  await runSamePortRestartHelper({ port: 43119, oldPid: old.pid, oldStartedAt: old.startedAt });
  expect(fixture.verify).toHaveBeenCalledWith(paths.appDir, reused);
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('stop rejects a same-PID replacement rather than waiting on its reused process number', async () => {
  publish(old);
  const running = observed(runStop()); await vi.advanceTimersByTimeAsync(100);
  publish({ ...replacement, pid: old.pid });
  await vi.advanceTimersByTimeAsync(100); await running.settled;
  expect(running.state()).toBe('rejected');
  expect(String(running.error())).toContain(replacement.listen);
});
it('retains the old identity in the hidden helper arguments', () => {
  const helper = child(); fixture.spawn.mockReturnValue(helper);
  const owner = control(); owner.requestRestart(43119);
  expect(fixture.spawn.mock.calls[0]?.[1]).toEqual(['/owned/fixture/vonvon.mjs', '__restart-after-exit', '43119', String(process.pid), old.startedAt]);
});
it('initial helper spawn failure confirms no child and permits stop release', async () => {
  const helper = new ChildProcess(); helper.unref = vi.fn(); children.push(helper);
  fixture.spawn.mockReturnValue(helper);
  const owner = control(); owner.requestRestart(43119);
  helper.emit('error', new Error('ENOENT'));
  const release = vi.fn(async () => {}); await owner.completeShutdown(release);
  expect(release).toHaveBeenCalledTimes(1);
});
it('records stop immediately while leaving reply microtasks ahead of drain wakeup', async () => {
  const owner = control(); const order: string[] = [];
  void owner.waitForRequest().then(() => { order.push('drain'); });
  owner.requestStop();
  expect(owner.requested).toBe(true);
  await Promise.resolve(); order.push('done');
  expect(order).toEqual(['done']);
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(['done', 'drain']);
});

function deferredRegistry() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  fixture.registryClose.mockReturnValue(promise);
  fixture.registryPids.mockReturnValue([65432]);
  return { resolve: () => { fixture.registryPids.mockReturnValue([]); resolve(); }, reject: (error: Error) => { fixture.registryPids.mockReturnValue([]); reject(error); } };
}
function runnerControl(): ShutdownControl {
  const value = observeShutdown(); controls.push(value); return value;
}
function exitShell(value: ChildProcess, code = 0): void {
  Object.defineProperty(value, 'exitCode', { value: code, configurable: true }); value.emit('exit', code, null);
}
function supervisorShell(): ChildProcess {
  const value = child();
  Object.defineProperty(value, 'connected', { value: true, configurable: true });
  value.send = vi.fn(() => true);
  fixture.spawn.mockImplementation((command: string) => {
    if (command !== 'taskkill') return value;
    const killer = child();
    queueMicrotask(() => {
      exitShell(killer);
      exitShell(value, 1);
    });
    return killer;
  });
  return value;
}
function expectNoForcedTreeTermination(value: ChildProcess): void {
  if (process.platform === 'win32') {
    expect.soft(fixture.spawn.mock.calls.filter(([command]) => command === 'taskkill')).toEqual([]);
    expect.soft(value.kill).not.toHaveBeenCalled();
  } else expect.soft(value.kill).not.toHaveBeenCalledWith('SIGKILL');
}
function expectForcedTreeTermination(value: ChildProcess): void {
  if (process.platform === 'win32') {
    expect.soft(fixture.spawn).toHaveBeenCalledWith('taskkill', ['/pid', String(value.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    expect.soft(fixture.spawn.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    expect.soft(value.kill).not.toHaveBeenCalled();
  } else expect.soft(value.kill).toHaveBeenCalledWith('SIGKILL');
}
it.skipIf(process.platform !== 'win32')('taskkill failure retains ownership until host death', async () => {
  const shell = supervisorShell();
  const killer = child();
  fixture.spawn.mockImplementation((command: string) => {
    if (command !== 'taskkill') return shell;
    queueMicrotask(() => exitShell(killer, 1));
    return killer;
  });
  const stopping = observed(settleOwnedChild(shell, 100));
  await vi.advanceTimersByTimeAsync(1100);
  expectForcedTreeTermination(shell);
  expect.soft(stopping.state()).toBe('pending');
  expect.soft(fixture.logWarn.mock.calls.some(([, message]) => message === 'owned_work_unconfirmed')).toBe(true);
  exitShell(shell, 1);
  await vi.advanceTimersByTimeAsync(1000);
  await stopping.settled;
  expect(stopping.state()).toBe('rejected');
  expect(String(stopping.error())).toContain(`Host tree termination failed for ${shell.pid}`);
});
function allReasons(error: unknown): string[] {
  return error instanceof AggregateError ? [error.message, ...error.errors.flatMap(allReasons)] : [error instanceof Error ? error.message : String(error)];
}
async function assertLocksHeld(): Promise<void> {
  expect.soft(fixture.botHeld).toBe(true);
  expect.soft(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(true);
  expect.soft(fixture.mutexHeld).toBe(true);
  expect.soft(() => { const release = acquireSingleInstanceLock('runner-bot'); release(); }).toThrow('busy');
  const contender = await acquireMutex(paths.appDir, 'host', 0).then(async mutex => { await closeMutex(mutex); return 'acquired'; }, error => String(error));
  expect.soft(contender).toContain('busy');
}
const botEntry = { appId: 'runner-bot', name: 'runner', tenant: 'feishu' as const, createdAt: 0 };

async function startInline() {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
  const owner = runnerControl();
  const running = observed(runHostRuntime({ bot: 'runner-bot', managed: false, control: owner }));
  await vi.waitFor(() => expect(fixture.startBridge).toHaveBeenCalledOnce());
  return { owner, running };
}

describe('provider runner ownership', () => {
  it.each([false, true])('retains inline and host ownership beyond 120 seconds, startup failure=%s', async startupFailure => {
    const registry = deferredRegistry();
    if (startupFailure) fixture.startBridge.mockRejectedValueOnce(new Error('fixture bridge start failed after provider birth'));
    const { owner, running } = await startInline();
    try {
      owner.requestStop();
      await vi.waitFor(() => expect(fixture.registryClose).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(121_000);
      expect.soft(running.state()).toBe('pending');
      await assertLocksHeld();
      const warnings = fixture.logWarn.mock.calls.filter(call => call[1] === 'owned_work_unconfirmed');
      expect.soft(warnings.length).toBeGreaterThanOrEqual(120);
      expect.soft(JSON.stringify(warnings)).toContain('65432');
      registry.reject(new Error('fixture providers died after forced cleanup'));
      await vi.waitFor(() => expect(running.state()).toBe('rejected'));
      expect.soft(allReasons(running.error())).toContain('fixture providers died after forced cleanup');
      if (startupFailure) expect.soft(allReasons(running.error())).toContain('fixture bridge start failed after provider birth');
      expect.soft(fixture.botHeld).toBe(false);
      expect.soft(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(false);
      expect.soft(fixture.mutexHeld).toBe(false);
    } finally { registry.resolve(); owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled; }
  });

  it('empty supervisor holds host ownership for its own provider registry', async () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
    const registry = deferredRegistry();
    const owner = runnerControl();
    const running = observed(runHostRuntime({ managed: false, control: owner }));
    try {
      await vi.waitFor(() => expect(fixture.apiReady).toHaveBeenCalledOnce());
      owner.requestStop(); await vi.advanceTimersByTimeAsync(121_000);
      expect.soft(running.state()).toBe('pending');
      expect.soft(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(true);
      expect.soft(fixture.mutexHeld).toBe(true);
      expect.soft(fixture.apiRelease).not.toHaveBeenCalled();
      registry.resolve();
      await vi.waitFor(() => expect(running.state()).toBe('fulfilled'));
      expect.soft(fixture.mutexHeld).toBe(false);
      expect.soft(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(false);
    } finally { registry.resolve(); owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled; }
  });

  it('managed Bot reports pending ownership each second and flushes final settlement before returning', async () => {
    const registry = deferredRegistry();
    const callbacks: (() => void)[] = [];
    const sent: unknown[] = [];
    const send = vi.fn((...args: unknown[]) => {
      const message = args[0]; sent.push(message);
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        if (typeof message === 'object' && message !== null && 'settled' in message && message.settled === true) callbacks.push(() => callback(null));
        else callback(null);
      }
      return true;
    });
    vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, connected: { value: true } }));
    const owner = runnerControl(); const running = observed(runRun('runner-bot', { control: owner }));
    try {
      await vi.advanceTimersByTimeAsync(0); owner.requestStop();
      await vi.advanceTimersByTimeAsync(121_000);
      expect.soft(running.state()).toBe('pending');
      const pending = sent.filter(value => typeof value === 'object' && value !== null && 'fcb' in value && value.fcb === 'fcb.owned-work' && 'settled' in value && value.settled === false);
      expect.soft(pending.length).toBeGreaterThanOrEqual(120);
      expect.soft(pending[0]).toEqual({ fcb: 'fcb.owned-work', pids: [65432], settled: false });
      registry.reject(new Error('fixture managed provider cleanup failed'));
      await vi.advanceTimersByTimeAsync(1000);
      expect.soft(sent).toContainEqual({ fcb: 'fcb.owned-work', pids: [], settled: true });
      expect.soft(callbacks.length).toBeGreaterThan(0);
      expect.soft(running.state()).toBe('pending');
      for (const callback of callbacks.splice(0)) callback();
      await vi.advanceTimersByTimeAsync(0); await running.settled;
      expect.soft(running.state()).toBe('rejected');
      expect.soft(allReasons(running.error())).toContain('fixture managed provider cleanup failed');
    } finally {
      registry.resolve(); for (const callback of callbacks.splice(0)) callback();
      owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled;
    }
  });

  const unsettledReports = [
    { name: 'no report', report: undefined },
    { name: 'empty pending diagnostics', report: { fcb: 'fcb.owned-work', pids: [], settled: false } },
    { name: 'retained providers', report: { fcb: 'fcb.owned-work', pids: [65432], settled: false } },
    { name: 'negative pid', report: { fcb: 'fcb.owned-work', pids: [-1], settled: true } },
    { name: 'fractional pid', report: { fcb: 'fcb.owned-work', pids: [1.5], settled: true } },
    { name: 'zero pid', report: { fcb: 'fcb.owned-work', pids: [0], settled: true } },
    { name: 'string settled', report: { fcb: 'fcb.owned-work', pids: [], settled: 'true' } },
  ];
  it.each(unsettledReports)('does not kill a Bot past grace for $name and permits escalation only after settlement', async ({ report }) => {
    const shell = supervisorShell(); const owner = runnerControl();
    const running = observed(runSupervisor([botEntry], { control: owner }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      if (report) shell.emit('message', report);
      owner.requestStop(); await vi.advanceTimersByTimeAsync(121_000);
      expect.soft(shell.send).toHaveBeenCalledWith({ type: 'bridge:shutdown' }, expect.any(Function));
      expectNoForcedTreeTermination(shell);
      const warnings = fixture.logWarn.mock.calls.filter(call => call[1] === 'owned_work_unconfirmed');
      expect.soft(warnings.length).toBeGreaterThan(100);
      expect.soft(JSON.stringify(warnings)).toContain('54321');
      if (report && 'pids' in report && report.pids.some(pid => pid === 65432)) expect.soft(JSON.stringify(warnings)).toContain('65432');
      expect.soft(running.state()).toBe('pending');
      expect.soft(fixture.apiRelease).not.toHaveBeenCalled();
      shell.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
      await vi.advanceTimersByTimeAsync(12_000);
      expectForcedTreeTermination(shell);
      exitShell(shell, 1); await vi.advanceTimersByTimeAsync(1000); await running.settled;
      expect.soft(running.state()).toBe('rejected');
    } finally { exitShell(shell); owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled; }
  });

  it('toggle-off waits for the same provider settlement before acknowledging', async () => {
    const shell = supervisorShell(); const owner = runnerControl();
    const running = observed(runSupervisor([botEntry], { control: owner }));
    try {
      await vi.advanceTimersByTimeAsync(0);
      const apply = fixture.admin?.applyBotActivation;
      if (!apply) throw new Error('Missing activation boundary');
      shell.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: false });
      const disabling = observed(apply(botEntry.appId, false));
      await vi.advanceTimersByTimeAsync(121_000);
      expect.soft(shell.send).toHaveBeenCalledWith({ type: 'bridge:shutdown' }, expect.any(Function));
      expectNoForcedTreeTermination(shell);
      expect.soft(disabling.state()).toBe('pending');
      shell.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
      await vi.advanceTimersByTimeAsync(12_000);
      expectForcedTreeTermination(shell);
      exitShell(shell, 1); await vi.advanceTimersByTimeAsync(1000); await disabling.settled;
      expect.soft(disabling.state()).toBe('rejected');
    } finally { exitShell(shell); owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled; }
  });

  it('a late settlement report from a dead generation cannot authorize killing its replacement', async () => {
    const first = supervisorShell(); const owner = runnerControl();
    const running = observed(runSupervisor([botEntry], { control: owner }));
    let next = first;
    try {
      await vi.advanceTimersByTimeAsync(0);
      first.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
      next = supervisorShell(); exitShell(first);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.spawn).toHaveBeenCalledTimes(2);
      first.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
      owner.requestStop(); await vi.advanceTimersByTimeAsync(121_000);
      expectNoForcedTreeTermination(next);
      expect.soft(running.state()).toBe('pending');
      next.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
      await vi.advanceTimersByTimeAsync(12_000);
      expectForcedTreeTermination(next);
    } finally { exitShell(next); owner.requestStop(); await vi.advanceTimersByTimeAsync(2000); await running.settled; }
  });
});

describe('listener cutoff classification through runner and cached shutdown', () => {
  it.each(['confirmed cleanup', 'unknown cutoff'] as const)('%s preserves rejection and releases only confirmed ownership', async kind => {
    const failure = new Error('fixture listener cleanup failure');
    fixture.apiRelease.mockRejectedValueOnce(kind === 'confirmed cleanup' ? new http.ApiCleanupError([failure]) : failure);
    const { owner, running } = await startInline();
    owner.requestStop();
    await vi.waitFor(() => expect(running.state()).toBe('rejected'));
    expect.soft(allReasons(running.error())).toContain(failure.message);
    const cached = observed(owner.completeShutdown(async () => { throw new Error('must not replace cached release'); }));
    await cached.settled;
    expect.soft(cached.state()).toBe('rejected');
    expect.soft(allReasons(cached.error())).toContain(failure.message);
    expect.soft(fixture.apiRelease).toHaveBeenCalledOnce();
    const retained = kind === 'unknown cutoff';
    expect.soft(fixture.botHeld).toBe(retained);
    expect.soft(fixture.mutexHeld).toBe(retained);
    expect.soft(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(retained);
    if (retained) {
      expect.soft(fixture.botRelease).not.toHaveBeenCalled();
      expect.soft(JSON.stringify([...fixture.logWarn.mock.calls, ...fixture.logFail.mock.calls])).toContain('listener_close_unconfirmed');
    }
  });
});
