import { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as settleIO } from 'node:timers/promises';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShutdownControl } from '../src/host/lifecycle';
import { createApiLifetimeFake } from './helpers/api-lifetime';

const f = vi.hoisted(() => ({ root: '', spawn: vi.fn(), api: vi.fn(), calls: [] as string[] }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: f.spawn }));
vi.mock('../src/platform/owned-process', () => ({ closeOwnedCodexProcesses: async () => {}, unconfirmedCodexPids: () => [] }));
vi.mock('../src/config/paths', async original => ({
  ...await original<typeof import('../src/config/paths')>(), paths: { get appDir() { return f.root; } },
}));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: f.spawn }));
vi.mock('../src/admin/service', () => ({ createAdminService: vi.fn() }));
vi.mock('../src/agent', () => ({ installBackendDep: vi.fn(), uninstallBackendDep: vi.fn() }));
vi.mock('../src/server/http', async original => ({ ...await original<typeof import('../src/server/http')>(), startApi: f.api }));
vi.mock('../src/cli/commands/run', async () => {
  const { runSupervisor } = await import('../src/bot/supervisor');
  return { runRun: (_bot: unknown, options: Parameters<typeof runSupervisor>[1]) => runSupervisor([
    { name: 'held', appId: 'fixture', tenant: 'feishu', createdAt: 0, active: true },
  ], options) };
});
import { runHostRuntime } from '../src/host/bootstrap';

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
let owned: ChildProcess;
let running: Promise<unknown> | undefined;
let closeGate: ReturnType<typeof gate>;
let stopGate: ReturnType<typeof gate>;
let started: ReturnType<typeof gate>;
let settled: boolean;
beforeEach(() => {
  f.root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-lifecycle-runtime-')));
  f.calls = [];
  closeGate = gate(); stopGate = gate(); started = gate(); settled = false;
  owned = new ChildProcess(); Object.defineProperty(owned, 'pid', { value: 54321 });
  owned.kill = vi.fn(() => true);
  f.spawn.mockImplementation((command: string) => {
    if (command !== 'taskkill') return owned;
    const killer = new ChildProcess();
    queueMicrotask(() => {
      Object.defineProperty(killer, 'exitCode', { value: 0, configurable: true });
      killer.emit('exit', 0, null);
    });
    return killer;
  });
  const lifetime = createApiLifetimeFake(f.calls);
  f.api.mockResolvedValue({
    ...lifetime, port: 43119, listen: '127.0.0.1:43119', invalidate() {},
    beginDrain: async () => { f.calls.push('drain'); throw new Error('fixture API cleanup failed'); },
    release: async () => { f.calls.push('release'); await closeGate.promise; f.calls.push('closed'); },
    close: async () => { f.calls.push('legacy-close'); throw new Error('fixture API cleanup failed'); },
  });
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: undefined }));
});
afterEach(async () => {
  Object.defineProperty(owned, 'exitCode', { value: 0, configurable: true }); owned.emit('exit', 0, null);
  stopGate.release(); closeGate.release();
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1000);
  await running;
  owned.removeAllListeners();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  console.log('runner runtime fixture removed', f.root);
  rmSync(f.root, { recursive: true, force: true });
});

it.each([false, true])('retains real PID and host mutex after cleanup rejection until child death and listener closure, transient contention=%s', async contention => {
  const owner: ShutdownControl = {
    requested: false, waitForRequest: () => { started.release(); return stopGate.promise; },
    requestStop: stopGate.release, requestRestart() {}, dispose() {},
    completeShutdown: async release => release(),
  };
  if (contention) {
    const contender = await acquireMutex(f.root, 'host', 0);
    void settleIO(100).then(() => closeMutex(contender));
  }
  running = runHostRuntime({ managed: false, control: owner }).then(() => { settled = true; }, error => { settled = true; return error; });
  await Promise.race([started.promise, running.then(error => { throw error ?? new Error('Host ended before readiness'); })]);
  vi.useFakeTimers();
  expect(existsSync(join(f.root, 'daemon.pid'))).toBe(true);
  owned.emit('message', { fcb: 'fcb.owned-work', pids: [], settled: true });
  stopGate.release();
  await vi.advanceTimersByTimeAsync(120_000);
  await settleIO(30);
  if (process.platform === 'win32') {
    expect.soft(f.spawn).toHaveBeenCalledWith('taskkill', ['/pid', String(owned.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    expect.soft(f.spawn.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    expect.soft(owned.kill).not.toHaveBeenCalled();
  } else expect.soft(owned.kill).toHaveBeenCalledWith('SIGKILL');
  expect.soft(settled).toBe(false);
  expect.soft(existsSync(join(f.root, 'daemon.pid'))).toBe(true);
  const contender = await acquireMutex(f.root, 'host', 0).then(async lock => { await closeMutex(lock); return 'acquired'; }, () => 'held');
  expect.soft(contender).toBe('held');
  expect.soft(f.calls).not.toContain('release');
  Object.defineProperty(owned, 'signalCode', { value: 'SIGKILL', configurable: true }); owned.emit('exit', null, 'SIGKILL');
  await vi.advanceTimersByTimeAsync(1000);
  await settleIO(30);
  expect.soft(f.calls).toContain('release');
  expect.soft(settled).toBe(false);
  expect.soft(existsSync(join(f.root, 'daemon.pid'))).toBe(true);
  closeGate.release();
  const result = await running;
  expect(result).toBeInstanceOf(Error);
  expect(f.calls).toContain('closed');
  expect(existsSync(join(f.root, 'daemon.pid'))).toBe(false);
});
