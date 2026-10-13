import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return fixture.root; } } }));
vi.mock('../src/config/data-access', () => ({ acquireMutex: vi.fn(), closeMutex: vi.fn() }));
vi.mock('../src/server/pid-lock', () => ({ acquirePidLock: vi.fn(), publishPidLock: vi.fn(), releasePidLock: vi.fn() }));
vi.mock('../src/cli/commands/run', () => ({ runRun: vi.fn() }));
import { acquireMutex } from '../src/config/data-access';
import { acquirePidLock } from '../src/server/pid-lock';
import { runRun } from '../src/cli/commands/run';
import { runHostRuntime } from '../src/host/bootstrap';

beforeEach(async () => {
  vi.stubEnv('FEISHU_CODEX_BRIDGE_SERVICE', '1');
  vi.stubEnv('VONVON_SERVICE', undefined);
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-service-pid-'));
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { platform: { value: 'win32' }, send: { value: undefined, writable: true } }));
  vi.mocked(acquirePidLock).mockResolvedValue({ pid: process.pid, startedAt: 'fixture', listen: '' });
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});
const run = () => runHostRuntime({ managed: false, control: { requested: false, dispose: vi.fn(), waitForRequest: vi.fn(), requestStop: vi.fn(), requestRestart: vi.fn(), completeShutdown: async (release: () => Promise<void>) => release() } });

it('leaves an unrelated legacy service.pid byte-for-byte intact', async () => {
  const pidPath = join(fixture.root, 'service.pid');
  const legacyBytes = 'foreign owner\r\n';
  await writeFile(pidPath, legacyBytes);
  vi.mocked(runRun).mockImplementation(async () => {
    expect(await readFile(pidPath, 'utf8')).toBe(legacyBytes);
  });
  await run();
  expect(await readFile(pidPath, 'utf8')).toBe(legacyBytes);
});

it('leaves an unrelated legacy service.pid intact when startup fails', async () => {
  const pidPath = join(fixture.root, 'service.pid');
  const legacyBytes = 'foreign owner\r\n';
  await writeFile(pidPath, legacyBytes);
  vi.mocked(runRun).mockImplementation(async () => { throw new Error('startup failed'); });
  await expect(run()).rejects.toThrow('startup failed');
  expect(await readFile(pidPath, 'utf8')).toBe(legacyBytes);
});

it('preserves a replacement owner written during runtime', async () => {
  const pidPath = join(fixture.root, 'service.pid');
  await writeFile(pidPath, 'foreign owner\r\n');
  vi.mocked(runRun).mockImplementation(async () => { await writeFile(pidPath, 'replacement owner\r\n'); });
  await run();
  expect(await readFile(pidPath, 'utf8')).toBe('replacement owner\r\n');
});

it.each(['duplicate', 'foreground', 'ipc child', 'non-Windows'])('preserves legacy PID bytes for %s', async kind => {
  const pidPath = join(fixture.root, 'service.pid');
  const legacyBytes = 'foreign owner\r\n';
  await writeFile(pidPath, legacyBytes);
  if (kind === 'duplicate') vi.mocked(acquireMutex).mockRejectedValue(new Error('busy'));
  if (kind === 'foreground') vi.stubEnv('FEISHU_CODEX_BRIDGE_SERVICE', '');
  if (kind === 'ipc child') vi.stubGlobal('process', Object.assign(Object.create(process), { send: vi.fn() }));
  if (kind === 'non-Windows') vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' }));
  vi.mocked(runRun).mockImplementation(async () => {
    expect(await readFile(pidPath, 'utf8')).toBe(legacyBytes);
  });
  if (kind === 'duplicate') await expect(run()).rejects.toThrow('busy');
  else await run();
  expect(await readFile(pidPath, 'utf8')).toBe(legacyBytes);
  if (kind === 'duplicate') expect(runRun).not.toHaveBeenCalled();
  if (kind === 'ipc child') {
    expect(acquireMutex).not.toHaveBeenCalled();
    expect(acquirePidLock).not.toHaveBeenCalled();
  }
});
