import { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Registration } from '../src/service/registration';

const fixture = vi.hoisted(() => ({
  registration: vi.fn<() => Promise<Registration>>(), owner: vi.fn(), verify: vi.fn(),
  launchdStart: vi.fn(), systemdStart: vi.fn(), windowsStart: vi.fn(), spawn: vi.fn(), close: vi.fn(), open: vi.fn(), runValue: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../src/core/logger', () => ({ readRecentLogs: vi.fn() }));
vi.mock('../src/service/registration', () => ({ readRegistration: fixture.registration }));
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: fixture.owner }));
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: fixture.verify }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: () => ({ start: fixture.launchdStart }) }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: () => ({ start: fixture.systemdStart }) }));
vi.mock('../src/service/windows', () => ({ createWindowsService: () => ({ start: fixture.windowsStart }) }));
vi.mock('../src/service/win-startup', () => ({ readVonvonRunValue: fixture.runValue }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), open: fixture.open, realpath: vi.fn(async () => process.platform === 'win32' ? 'C:\\owned\\root' : '/owned/root'), stat: vi.fn(async () => ({ isDirectory: () => true })) }));

import { runStart } from '../src/cli/commands/daemon';
import { resolveServiceRoot } from '../src/service/identity';

const owner = { pid: 4242, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:1234' };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(homedir).mockReturnValue('/home/vonvon-fixture');
  vi.stubEnv('XDG_CONFIG_HOME', '/home/vonvon-fixture/.config');
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
    platform: { value: 'darwin' }, send: { value: undefined }, exitCode: { value: undefined, writable: true },
  }));
  fixture.registration.mockResolvedValue({ kind: 'ours', definition: { root: await resolveServiceRoot('/owned/root'), port: 1234, capturedPath: '/bin', distribution: { kind: 'npm', executable: '/node', entry: '/cli' } } });
  fixture.owner.mockResolvedValue(null);
  fixture.launchdStart.mockResolvedValue({ ...owner, port: 1234 });
  fixture.systemdStart.mockResolvedValue({ ...owner, port: 1234 });
  fixture.windowsStart.mockResolvedValue({ ...owner, port: 1234 });
  fixture.open.mockResolvedValue({ fd: 123, close: fixture.close });
  fixture.runValue.mockReturnValue({ kind: 'absent' });
});
afterEach(() => { vi.mocked(homedir).mockReset(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
it.each([['darwin', 'absent'], ['win32', 'absent'], ['darwin', 'other-root']] as const)('retains V3 detached startup on %s for an %s registration', async (platform, kind) => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  vi.stubEnv('VONVON_SERVICE', 'launchd');
  const registration = await fixture.registration();
  if (registration.kind !== 'ours') throw new Error('Missing fixture');
  fixture.registration.mockResolvedValue(kind === 'absent' ? { kind } : { ...registration, kind, recordedRoot: registration.definition.root });
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: owner.pid });
  vi.spyOn(child, 'unref').mockImplementation(() => {});
  fixture.spawn.mockReturnValue(child);
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValue(owner);
  await expect(runStart(1234)).resolves.toEqual({ running: true, ...owner });
  expect(fixture.spawn).toHaveBeenCalledWith(process.execPath, [process.argv[1], 'daemon', 'run', '--port', '1234'], expect.objectContaining({ detached: true }));
  expect(fixture.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('VONVON_SERVICE');
  expect(fixture.spawn.mock.calls[0]?.[2].env).toMatchObject({ VONVON_HOME: '/owned/root' });
  expect(fixture.verify).toHaveBeenCalledWith('/owned/root', owner);
  expect(fixture.launchdStart).not.toHaveBeenCalled();
  expect(fixture.close).toHaveBeenCalledOnce();
});
it('routes Windows managed startup through the registered launcher without detached fallback', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  await expect(runStart()).resolves.toEqual({ running: true, ...owner });
  expect(fixture.windowsStart).toHaveBeenCalledWith({});
  expect(fixture.registration).toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('propagates Windows launcher failure without a detached fallback', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  fixture.windowsStart.mockRejectedValue(new Error('wscript denied'));
  await expect(runStart(1234)).rejects.toThrow('wscript denied');
  expect(fixture.windowsStart).toHaveBeenCalledWith({ port: 1234 });
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('refuses Windows startup when the Run value cannot be read', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  fixture.runValue.mockReturnValue({ kind: 'unavailable', reason: 'Windows Run query timed out' });
  await expect(runStart()).rejects.toThrow('Windows Run observation unavailable: Windows Run query timed out');
  expect(fixture.registration).not.toHaveBeenCalled();
  expect(fixture.windowsStart).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
