import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ShutdownControl } from '../src/host/lifecycle';

// The host prepares the library and private chats before any Bot, skips both while paused and starts despite preparation errors.
const fixture = vi.hoisted(() => ({ root: '', order: [] as string[] }));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return fixture.root; } } }));
vi.mock('../src/config/data-access', () => ({ acquireMutex: vi.fn(async () => ({})), closeMutex: vi.fn(), DataAccessError: class extends Error {} }));
vi.mock('../src/server/pid-lock', () => ({
  acquirePidLock: vi.fn(async () => ({ pid: process.pid, startedAt: new Date().toISOString(), listen: null })),
  publishPidLock: vi.fn(), releasePidLock: vi.fn(), getPidLockInfo: async () => null, isPidLockOwnerRunning: () => false,
}));
vi.mock('../src/service/startup', () => ({ readStartupRegistration: async () => ({ kind: 'absent' }) }));
vi.mock('../src/service/codex-bin', () => ({ readServiceCodexBin: () => undefined }));
vi.mock('../src/provider/process/process-host', () => ({
  defaultHolderPath: () => '/fixture/holder',
  ProcessHost: class { async sweepOrphans() { return {}; } admission() { return undefined; } async closeAll() {} },
}));
vi.mock('../src/cli/commands/run', () => ({ runRun: vi.fn() }));
vi.mock('../src/admin/library', () => ({ prepareLibraryAtStartup: vi.fn() }));
vi.mock('../src/bot/dm-project', () => ({ prepareDmProjectsAtStartup: vi.fn() }));
import { runRun } from '../src/cli/commands/run';
import { prepareLibraryAtStartup } from '../src/admin/library';
import { prepareDmProjectsAtStartup } from '../src/bot/dm-project';
import { log } from '../src/core/logger';
import { runHostRuntime } from '../src/host/bootstrap';

const control = (): ShutdownControl => ({
  requested: false, dispose: vi.fn(), waitForRequest: vi.fn(), requestStop: vi.fn(), requestRestart: vi.fn(),
  completeShutdown: async (release: () => Promise<void>) => release(),
});
const start = (): Promise<void> => runHostRuntime({ managed: false, control: control() });

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-host-library-'));
  fixture.order = [];
  vi.stubEnv('VONVON_SERVICE', undefined);
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: undefined, writable: true }, exitCode: { value: undefined, writable: true } }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(prepareLibraryAtStartup).mockImplementation(async () => { fixture.order.push('library'); return { linked: 0, created: 0, failed: [], drift: [] }; });
  vi.mocked(prepareDmProjectsAtStartup).mockImplementation(async () => { fixture.order.push('dm'); });
  vi.mocked(runRun).mockImplementation(async () => { fixture.order.push('run'); });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});

it('prepares the library then private chats once, and waits before the run starts any Bot', async () => {
  let finishPreparation!: () => void;
  const prepared = new Promise<void>(resolve => { finishPreparation = resolve; });
  vi.mocked(prepareDmProjectsAtStartup).mockImplementationOnce(async () => {
    fixture.order.push('dm');
    await prepared;
    fixture.order.push('dm-ready');
  });
  const started = start();
  try {
    await vi.waitFor(() => expect(prepareDmProjectsAtStartup).toHaveBeenCalledOnce());
    expect(fixture.order).toEqual(['library', 'dm']);
    expect(runRun).not.toHaveBeenCalled();
  } finally {
    finishPreparation();
    await started;
  }
  expect(prepareLibraryAtStartup).toHaveBeenCalledOnce();
  expect(fixture.order).toEqual(['library', 'dm', 'dm-ready', 'run']);
});

it('starts the Bots anyway when the migration fails, and logs it', async () => {
  const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
  vi.mocked(prepareLibraryAtStartup).mockRejectedValueOnce(new Error('library broke'));
  await start();
  expect(vi.mocked(runRun)).toHaveBeenCalledTimes(1);
  expect(fixture.order).toEqual(['dm', 'run']);
  expect(fail.mock.calls.map(call => [call[0], (call[1] as Error).message])).toEqual([['library', 'library broke']]);
});

it('starts the Bots anyway when private-chat preparation fails, and logs its distinct startup phase', async () => {
  const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
  const failure = new Error('private chat directory unavailable');
  vi.mocked(prepareDmProjectsAtStartup).mockImplementationOnce(async () => { fixture.order.push('dm'); throw failure; });
  await start();
  expect(fixture.order).toEqual(['library', 'dm', 'run']);
  expect(runRun).toHaveBeenCalledOnce();
  expect(fail).toHaveBeenCalledOnce();
  expect(fail).toHaveBeenCalledWith('project', failure, { phase: 'dm-startup' });
});

it('leaves both preparations to the next start while paused after three crashes', async () => {
  vi.mocked(runRun).mockImplementation(async () => { throw new Error('listen EADDRINUSE'); });
  for (let attempt = 0; attempt < 3; attempt++) await expect(start()).rejects.toThrow('EADDRINUSE');
  expect(vi.mocked(prepareLibraryAtStartup)).toHaveBeenCalledTimes(3);
  expect(vi.mocked(prepareDmProjectsAtStartup)).toHaveBeenCalledTimes(3);
  vi.mocked(runRun).mockReset().mockResolvedValue();
  await start();
  expect(vi.mocked(runRun).mock.calls[0]?.[1]).toMatchObject({ paused: true });
  expect(vi.mocked(prepareLibraryAtStartup)).toHaveBeenCalledTimes(3);
  expect(vi.mocked(prepareDmProjectsAtStartup)).toHaveBeenCalledTimes(3);
});
