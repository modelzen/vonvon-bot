import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', stop: vi.fn(), stopGc: vi.fn() }));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return fixture.root; } } }));
vi.mock('../src/config/data-access', () => ({ acquireMutex: vi.fn(), closeMutex: vi.fn() }));
vi.mock('../src/server/pid-lock', () => ({ acquirePidLock: vi.fn(), publishPidLock: vi.fn(), releasePidLock: vi.fn(), getPidLockInfo: async () => null, isPidLockOwnerRunning: () => false }));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: 'absent' }) }));
vi.mock('../src/cli/commands/run', () => ({ runRun: vi.fn() }));
vi.mock('../src/core/loop-lag', () => ({ startLoopLagMonitor: vi.fn(() => fixture.stop) }));
vi.mock('../src/core/logger', async importOriginal => ({ ...await importOriginal<typeof import('../src/core/logger')>(), startLogGc: vi.fn(() => fixture.stopGc) }));
import { startLogGc } from '../src/core/logger';
import { startLoopLagMonitor } from '../src/core/loop-lag';
import { acquirePidLock } from '../src/server/pid-lock';
import { runRun } from '../src/cli/commands/run';
import { runHostRuntime } from '../src/host/bootstrap';

beforeEach(async () => {
  vi.stubEnv('VONVON_SERVICE', undefined);
  // the host's own path, not a bot child's: a vitest worker has an IPC channel
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: undefined, writable: true } }));
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-loop-lag-'));
  vi.mocked(acquirePidLock).mockResolvedValue({ pid: process.pid, startedAt: 'fixture', listen: '' });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.mocked(startLoopLagMonitor).mockImplementation(() => fixture.stop);
  vi.mocked(startLogGc).mockImplementation(() => fixture.stopGc);
  await rm(fixture.root, { recursive: true, force: true });
});
const control = () => ({ requested: false, dispose: vi.fn(), waitForRequest: vi.fn(), requestStop: vi.fn(), requestRestart: vi.fn(), completeShutdown: async (release: () => Promise<void>) => release() });

it('a long-running daemon watches its event loop while it runs and stops watching when the run ends (s23f2)', async () => {
  vi.mocked(runRun).mockImplementation(async () => {
    expect(startLoopLagMonitor).toHaveBeenCalledTimes(1);
    expect(fixture.stop).not.toHaveBeenCalled();
  });
  await runHostRuntime({ bot: 'cli_a', managed: false, control: control() });
  expect(runRun).toHaveBeenCalledTimes(1);
  expect(startLoopLagMonitor).toHaveBeenCalledWith({ pid: process.pid, bot: 'cli_a' });
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});

it('stops watching when the run fails too', async () => {
  vi.mocked(runRun).mockImplementation(async () => { throw new Error('startup failed'); });
  await expect(runHostRuntime({ managed: false, control: control() })).rejects.toThrow('startup failed');
  expect(startLoopLagMonitor).toHaveBeenCalledWith({ pid: process.pid });
  expect(fixture.stop).toHaveBeenCalledTimes(1);
});

it('the supervisor trims old daily logs while it runs and stops when the run ends, even by failure', async () => {
  vi.mocked(runRun).mockImplementation(async () => {
    expect(startLogGc).toHaveBeenCalledTimes(1);
    expect(fixture.stopGc).not.toHaveBeenCalled();
  });
  await runHostRuntime({ managed: false, control: control() });
  expect(fixture.stopGc).toHaveBeenCalledTimes(1);
  vi.mocked(runRun).mockImplementation(async () => { throw new Error('startup failed'); });
  await expect(runHostRuntime({ managed: false, control: control() })).rejects.toThrow('startup failed');
  expect(startLogGc).toHaveBeenCalledTimes(2);
  expect(fixture.stopGc).toHaveBeenCalledTimes(2);
});

it('a bot child leaves the shared logs to the supervisor', async () => {
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: () => true, writable: true } }));
  vi.mocked(runRun).mockImplementation(async () => {});
  await runHostRuntime({ bot: 'cli_a', managed: false, control: control() });
  expect(startLogGc).not.toHaveBeenCalled();
});
