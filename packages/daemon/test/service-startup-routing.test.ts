import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Registration } from '../src/service/registration';

const fixture = vi.hoisted(() => ({
  registration: vi.fn<() => Promise<Registration>>(), owner: vi.fn(), verify: vi.fn(),
  launchdStart: vi.fn(), systemdStart: vi.fn(), spawn: vi.fn(), close: vi.fn(), open: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('../src/core/logger', () => ({ readRecentLogs: vi.fn() }));
vi.mock('../src/service/registration', () => ({ readRegistration: fixture.registration }));
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: fixture.owner }));
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: fixture.verify }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: () => ({ start: fixture.launchdStart }) }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: () => ({ start: fixture.systemdStart }) }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), open: fixture.open, realpath: vi.fn(async () => '/owned/root'), stat: vi.fn(async () => ({ isDirectory: () => true })) }));

import { runStart } from '../src/cli/commands/daemon';
import { resolveServiceRoot } from '../src/service/identity';

const owner = { pid: 4242, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:1234' };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
    platform: { value: 'darwin' }, send: { value: undefined }, exitCode: { value: undefined, writable: true },
  }));
  fixture.registration.mockResolvedValue({ kind: 'ours', definition: { root: await resolveServiceRoot('/owned/root'), port: 1234, capturedPath: '/bin', distribution: { kind: 'npm', executable: '/node', entry: '/cli' } } });
  fixture.owner.mockResolvedValue(null);
  fixture.launchdStart.mockResolvedValue({ ...owner, port: 1234 });
  fixture.systemdStart.mockResolvedValue({ ...owner, port: 1234 });
  fixture.open.mockResolvedValue({ fd: 123, close: fixture.close });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['darwin', 'linux'] as const)('routes %s to its manager and maps zero to the registered port', async platform => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  await expect(runStart()).resolves.toEqual({ running: true, ...owner });
  expect(platform === 'darwin' ? fixture.launchdStart : fixture.systemdStart).toHaveBeenCalledWith({});
  expect(platform === 'darwin' ? fixture.systemdStart : fixture.launchdStart).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('propagates manager output without detached fallback', async () => {
  fixture.launchdStart.mockRejectedValue(new Error('launchctl denied'));
  await expect(runStart(1234)).rejects.toThrow('launchctl denied');
  expect(fixture.launchdStart).toHaveBeenCalledWith({ port: 1234 });
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('authenticates an existing owner without starting a manager', async () => {
  fixture.owner.mockResolvedValue(owner);
  await expect(runStart(1234)).resolves.toEqual({ running: true, ...owner });
  expect(fixture.verify).toHaveBeenCalledWith('/owned/root', owner);
  expect(fixture.registration).not.toHaveBeenCalled();
  expect(fixture.launchdStart).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('keeps the existing-owner port mismatch refusal', async () => {
  fixture.owner.mockResolvedValue(owner);
  await expect(runStart(5678)).rejects.toThrow('Daemon PID 4242 already runs at 127.0.0.1:1234, not requested port 5678.');
  expect(fixture.verify).toHaveBeenCalledOnce();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('refuses an owner that fails authentication', async () => {
  fixture.owner.mockResolvedValue(owner);
  fixture.verify.mockRejectedValue(new Error('identity mismatch'));
  await expect(runStart()).rejects.toThrow('identity mismatch');
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.launchdStart).not.toHaveBeenCalled();
});
it('refuses unrecognized definitions', async () => {
  fixture.registration.mockResolvedValue({ kind: 'unrecognized', location: '/service', reason: 'invalid' });
  await expect(runStart()).rejects.toThrow('Unrecognized service registration /service: invalid');
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('refuses definitions belonging to another root', async () => {
  const registration = await fixture.registration();
  if (registration.kind !== 'ours') throw new Error('Missing fixture');
  fixture.registration.mockResolvedValue({ ...registration, kind: 'other-root', recordedRoot: registration.definition.root });
  await expect(runStart()).rejects.toThrow('Service registration belongs to');
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it.each(['darwin', 'win32'] as const)('retains V3 detached startup for absent registration or the existing unmanaged Windows path on %s', async platform => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: owner.pid });
  vi.spyOn(child, 'unref').mockImplementation(() => {});
  fixture.spawn.mockReturnValue(child);
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValue(owner);
  await expect(runStart(1234)).resolves.toEqual({ running: true, ...owner });
  expect(fixture.spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], 'daemon', 'run', '--port', '1234'], expect.objectContaining({ detached: true }));
  expect(fixture.verify).toHaveBeenCalledWith('/owned/root', owner);
  expect(fixture.launchdStart).not.toHaveBeenCalled();
  expect(fixture.close).toHaveBeenCalledOnce();
});
it('keeps managed Windows startup refused pending the authored integration contract', async () => {
  vi.stubEnv('VONVON_SERVICE', 'win32');
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  await expect(runStart()).rejects.toThrow('Windows service startup is unavailable');
  expect(fixture.spawn).not.toHaveBeenCalled();
});
