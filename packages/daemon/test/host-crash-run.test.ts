import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShutdownControl } from '../src/host/lifecycle';

const fixture = vi.hoisted(() => ({ root: '', registration: 'absent' as 'absent' | 'ours', closeAll: undefined as Error | undefined }));
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
  ProcessHost: class { async sweepOrphans() { return {}; } admission() { return undefined; } async closeAll() { if (fixture.closeAll) throw fixture.closeAll; } },
}));
vi.mock('../src/cli/commands/run', () => ({ runRun: vi.fn() }));
import { runRun } from '../src/cli/commands/run';
import { closeMutex } from '../src/config/data-access';
import { log } from '../src/core/logger';
import { releasePidLock } from '../src/server/pid-lock';
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
  fixture.closeAll = undefined;
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
  // The bot children's records go under this run and chain (s18a).
  expect(vi.mocked(runRun).mock.calls[0]?.[1]).toMatchObject({ paused: true, crash: { runId: expect.any(String), chainId: listCrashRecords(fixture.root)[0]?.chainId, pause: { crashes: 3 } } });
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

// s17b: what the console shows of the JSON log, error lines only.
const failLines = (spy: { mock: { calls: unknown[][] } }, match: string): string[] => spy.mock.calls.map(call => String(call[0])).filter(line => line.includes(match));

it('logs each error of a failed process-host cleanup and still releases the locks', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  fixture.closeAll = new AggregateError([new Error('holder gone'), new Error('group 77 alive')], 'Process host cleanup failed.');
  vi.mocked(runRun).mockImplementationOnce(async () => { requested = true; });
  await expect(start()).rejects.toThrow('Process host cleanup failed.');
  expect(failLines(error, 'phase=process-host')).toEqual([
    expect.stringMatching(/^✗ \[daemon-shutdown\.fail\] phase=process-host err=Process host cleanup failed\. parts=2$/),
    expect.stringMatching(/^✗ \[daemon-shutdown\.fail_part\] phase=process-host part=1 of=2 errName=Error err=holder gone$/),
    expect.stringMatching(/^✗ \[daemon-shutdown\.fail_part\] phase=process-host part=2 of=2 errName=Error err=group 77 alive$/),
  ]);
  expect(releasePidLock).toHaveBeenCalledOnce();
  expect(closeMutex).toHaveBeenCalledOnce();
});

it('logs a failure of the run that nothing logged yet, and not one the supervisor already logged', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(runRun).mockImplementationOnce(async () => { throw new Error('registry unreadable'); });
  await expect(start()).rejects.toThrow('registry unreadable');
  expect(failLines(error, '[daemon-run.fail]')).toEqual([expect.stringMatching(/phase=run err=registry unreadable$/)]);
  error.mockClear();
  // The supervisor's finally logs each cleanup error, then throws them as one group.
  vi.mocked(runRun).mockImplementationOnce(async () => {
    const errors = [new Error('drain failed'), new Error('IPC channel closed')];
    for (const failure of errors) log.fail('daemon-shutdown', failure, { phase: 'cleanup' });
    throw new AggregateError(errors, 'Supervisor cleanup failed.');
  });
  await expect(start()).rejects.toThrow('Supervisor cleanup failed.');
  expect(failLines(error, '[daemon-shutdown.fail]')).toHaveLength(2);
  expect(failLines(error, '[daemon-run.fail')).toEqual([]);
});

it('VONVON_TEST_CRASH=cleanup: a stop logs the seam and its two parts without a crash record; a crash keeps its own record', async () => {
  vi.stubEnv('VONVON_TEST_CRASH', 'cleanup');
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(runRun).mockImplementationOnce(async () => { requested = true; });
  await expect(start()).rejects.toThrow('VONVON_TEST_CRASH cleanup');
  // A seam left in the environment says so at each start.
  expect(warn.mock.calls.map(call => String(call[0]))).toEqual(['⚠ [daemon-startup.test_seam] seam=cleanup']);
  expect(failLines(error, 'phase=test-seam')).toEqual([
    expect.stringMatching(/^✗ \[daemon-shutdown\.fail\] phase=test-seam err=VONVON_TEST_CRASH cleanup parts=2$/),
    expect.stringMatching(/ part=1 of=2 errName=Error err=step 1$/),
    expect.stringMatching(/ part=2\.1 of=2 within=VONVON_TEST_CRASH nested errName=Error err=step 2$/),
  ]);
  // A cleanup failure on a requested stop is not a crash: no record, the run marker is removed.
  expect(listCrashRecords(fixture.root)).toEqual([]);
  expect(readRunMarker(fixture.root)).toBeNull();
  // No stop asked for: the run's own failure is the fatal record; the seam is one more error of the shutdown.
  requested = false;
  vi.mocked(runRun).mockImplementationOnce(async () => { throw new Error('listen EADDRINUSE'); });
  const failure: unknown = await start().catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).message).toBe('Host shutdown failed.');
  expect((failure as AggregateError).errors.map((item: Error) => item.message)).toEqual(['listen EADDRINUSE', 'VONVON_TEST_CRASH cleanup']);
  expect(listCrashRecords(fixture.root)).toEqual([expect.objectContaining({ kind: 'fatal', reason: 'Error: listen EADDRINUSE' })]);
});
