import { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
}));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn, spawnSync: fixture.spawnSync }));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { paths: { appDir: realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-lifecycle-red-'))) } };
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
vi.mock('../src/service/adapter', () => ({ getServiceAdapter: fixture.getAdapter, isServiceRunning: () => false }));

import { paths } from '../src/config/paths';
import { observeShutdown, type ShutdownControl } from '../src/host/lifecycle';
import { runSamePortRestartHelper } from '../src/host/restart';
import { runStart, runStop } from '../src/cli/commands/daemon';
import { runServiceCommand } from '../src/cli/commands/service';
import { controlDesktopService } from '../src/host/service';
import { acquireUpdateLock, readUpdateStatus, restartDaemon, writeUpdateStatus } from '../src/service/update';

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
function control(): ShutdownControl { const value = observeShutdown(); controls.push(value); return value; }
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
  if (originalEntry === undefined) delete process.argv[1];
  else process.argv[1] = originalEntry;
  for (const name of readdirSync(paths.appDir)) rmSync(join(paths.appDir, name), { recursive: true, force: true });
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

describe('same-port helper ownership', () => {
  it('waits through 120 seconds of retained ownership and starts exactly once after release', async () => {
    publish(old);
    const running = observed(runSamePortRestartHelper({ port: 43119, oldPid: old.pid }));
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
    await expect(runSamePortRestartHelper({ port: 43119, oldPid: old.pid })).rejects.toThrow(/superseded|43120|port/i);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([]);
  });
  it('verifies an already-ready same-port replacement before counting success', async () => {
    publish(replacement);
    await runSamePortRestartHelper({ port: 43119, oldPid: old.pid });
    expect(fixture.verify).toHaveBeenCalledWith(paths.appDir, replacement);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it('plain restart cannot complete an unrelated restarting update record', async () => {
    const unrelated = { phase: 'restarting', ok: true, from: '1', to: '2', at: 10 } as const;
    writeUpdateStatus(unrelated);
    const running = observed(runSamePortRestartHelper({ port: 43119, oldPid: old.pid }));
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
