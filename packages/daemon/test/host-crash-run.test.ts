import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShutdownControl } from '../src/host/lifecycle';

const fixture = vi.hoisted(() => ({ root: '', registration: 'absent' as 'absent' | 'ours' }));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return fixture.root; } } }));
vi.mock('../src/config/data-access', () => ({ acquireMutex: vi.fn(async () => ({})), closeMutex: vi.fn(), DataAccessError: class extends Error {} }));
vi.mock('../src/server/pid-lock', () => ({
  acquirePidLock: vi.fn(async () => ({ pid: process.pid, startedAt: new Date().toISOString(), listen: null })),
  publishPidLock: vi.fn(), releasePidLock: vi.fn(), getPidLockInfo: async () => null, isPidLockOwnerRunning: () => false,
}));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: fixture.registration }) }));
vi.mock('../src/service/codex-bin', () => ({ readServiceCodexBin: () => undefined }));
vi.mock('../src/provider/process/process-host', () => ({
  defaultHolderPath: () => '/fixture/holder',
  ProcessHost: class { async sweepOrphans() { return {}; } admission() { return undefined; } async closeAll() {} },
}));
vi.mock('../src/cli/commands/run', () => ({ runRun: vi.fn() }));
import { runRun } from '../src/cli/commands/run';
import { listCrashRecords, readRunMarker } from '../src/host/crash-store';
import { runHostRuntime } from '../src/host/bootstrap';

let requested = false;
const control = (): ShutdownControl => ({
  get requested() { return requested; }, dispose: vi.fn(), waitForRequest: vi.fn(), requestStop: vi.fn(), requestRestart: vi.fn(),
  completeShutdown: async (release: () => Promise<void>) => release(),
});
// Each call stands for one `daemon run` process: the run it opens is closed in its finally.
const start = (): Promise<void> => runHostRuntime({ managed: fixture.registration === 'ours', control: control() });

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-host-crash-'));
  fixture.registration = 'absent';
  requested = false;
  vi.stubEnv('VONVON_SERVICE', undefined);
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: undefined, writable: true }, exitCode: { value: undefined, writable: true } }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});

it('a failure while stopping is a clean end; three unrequested failures pause the fourth start', async () => {
  vi.mocked(runRun).mockImplementationOnce(async () => { requested = true; throw new Error('drain failed'); });
  await expect(start()).rejects.toThrow('drain failed');
  expect(readRunMarker(fixture.root)).toBeNull();
  requested = false;
  vi.mocked(runRun).mockImplementation(async () => { throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }); });
  for (let attempt = 0; attempt < 3; attempt++) await expect(start()).rejects.toThrow('EADDRINUSE');
  expect(listCrashRecords(fixture.root).map(entry => `${entry.kind}:${entry.errorName}`)).toEqual(['fatal:Error:EADDRINUSE', 'fatal:Error:EADDRINUSE', 'fatal:Error:EADDRINUSE']);
  expect(vi.mocked(runRun).mock.calls.every(call => call[1]?.paused === undefined)).toBe(true);
  vi.mocked(runRun).mockReset().mockResolvedValue();
  await start();
  expect(vi.mocked(runRun).mock.calls[0]?.[1]).toMatchObject({ paused: true });
});

it('a paused service-managed run that cannot start exits 0 and stays paused', async () => {
  fixture.registration = 'ours';
  vi.stubEnv('VONVON_SERVICE', 'systemd');
  vi.mocked(runRun).mockImplementation(async () => { throw new Error('listen EADDRINUSE'); });
  for (let attempt = 0; attempt < 3; attempt++) {
    process.exitCode = undefined;
    await expect(start()).rejects.toThrow('EADDRINUSE');
    expect(process.exitCode).toBeUndefined();
  }
  process.exitCode = undefined;
  await expect(start()).rejects.toThrow('EADDRINUSE');
  expect(process.exitCode).toBe(0);
  expect(readRunMarker(fixture.root)).toMatchObject({ state: 'paused', pauseCrashes: 3 });
  expect(listCrashRecords(fixture.root)[0]).toMatchObject({ kind: 'fatal', paused: true, managed: 'systemd' });
});
