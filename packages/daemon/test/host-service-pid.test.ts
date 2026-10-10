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
import { clearServicePid, SERVICE_ENV_FLAG } from '../src/service/win-startup';

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'vonvon-service-pid-'));
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { platform: { value: 'win32' }, send: { value: undefined, writable: true } }));
  vi.stubEnv(SERVICE_ENV_FLAG, '1');
  vi.mocked(acquirePidLock).mockResolvedValue({ pid: process.pid, startedAt: 'fixture', listen: '' });
});
afterEach(async () => {
  process.removeListener('exit', clearServicePid);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});
const run = () => runHostRuntime({ managed: false, control: { requested: false, dispose: vi.fn(), waitForRequest: vi.fn(), requestStop: vi.fn(), requestRestart: vi.fn() } });

it('publishes the service owner during runtime and clears it on shutdown', async () => {
  vi.mocked(runRun).mockImplementation(async () => {
    expect(await readFile(join(fixture.root, 'service.pid'), 'utf8')).toBe(String(process.pid));
  });
  await run();
  await expect(readFile(join(fixture.root, 'service.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('clears the service owner when runtime startup fails', async () => {
  vi.mocked(runRun).mockImplementation(async () => {
    expect(await readFile(join(fixture.root, 'service.pid'), 'utf8')).toBe(String(process.pid));
    throw new Error('startup failed');
  });
  await expect(run()).rejects.toThrow('startup failed');
  await expect(readFile(join(fixture.root, 'service.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves a replacement owner during cleanup', async () => {
  vi.mocked(runRun).mockImplementation(async () => { await writeFile(join(fixture.root, 'service.pid'), '123'); });
  await run();
  expect(await readFile(join(fixture.root, 'service.pid'), 'utf8')).toBe('123');
});
it.each(['duplicate', 'foreground', 'ipc child', 'non-Windows'])('does not claim or clear service ownership for %s', async (kind) => {
  await writeFile(join(fixture.root, 'service.pid'), '123');
  if (kind === 'duplicate') vi.mocked(acquireMutex).mockRejectedValue(new Error('busy'));
  if (kind === 'non-Windows') vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' }));
  if (kind === 'foreground') vi.stubEnv(SERVICE_ENV_FLAG, '');
  if (kind === 'ipc child') vi.stubGlobal('process', Object.assign(Object.create(process), { send: vi.fn() }));
  vi.mocked(runRun).mockImplementation(async () => {
    expect(await readFile(join(fixture.root, 'service.pid'), 'utf8')).toBe('123');
  });
  try {
    if (kind === 'duplicate') await expect(run()).rejects.toThrow('busy');
    else await run();
    expect(await readFile(join(fixture.root, 'service.pid'), 'utf8')).toBe('123');
  } finally { vi.unstubAllGlobals(); }
});
