import { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Registration } from '../src/service/registration';

const fixture = vi.hoisted(() => ({
  registration: vi.fn<() => Promise<Registration>>(), owner: vi.fn(), verify: vi.fn(),
  launchdStart: vi.fn(), systemdStart: vi.fn(), spawn: vi.fn(), close: vi.fn(), open: vi.fn(),
  windowsStart: vi.fn(), sid: vi.fn(async () => 'S-1-5-21-1000000001-2000000002-3000000003-1001'),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../src/core/logger', () => ({ readRecentLogs: vi.fn() }));
vi.mock('../src/service/registration', () => ({ readRegistration: fixture.registration }));
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: fixture.owner, PidLockError: class PidLockError extends Error {} }));
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: fixture.verify }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: () => ({ start: fixture.launchdStart }) }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: () => ({ start: fixture.systemdStart }) }));
vi.mock('../src/service/windows', () => ({ createWindowsService: () => ({ start: fixture.windowsStart }) }));
vi.mock('../src/service/identity', async original => ({ ...await original<typeof import('../src/service/identity')>(), currentWindowsSid: fixture.sid }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fixture.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), open: fixture.open, realpath: vi.fn(async () => '/owned/root'), stat: vi.fn(async () => ({ isDirectory: () => true })) }));

import { runStart } from '../src/cli/commands/daemon';
import { PidLockError } from '../src/server/pid-lock';
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
  fixture.open.mockResolvedValue({ fd: 123, close: fixture.close });
});
afterEach(() => { vi.mocked(homedir).mockReset(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['darwin', 'linux'] as const)('routes %s to its manager and maps zero to the registered port', async platform => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  await expect(runStart()).resolves.toEqual({ running: true, ...owner });
  expect(platform === 'darwin' ? fixture.launchdStart : fixture.systemdStart).toHaveBeenCalledWith({});
  expect(platform === 'darwin' ? fixture.systemdStart : fixture.launchdStart).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('I4a: routes win32 to the scheduled task, looked up by the user\'s SID', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  fixture.sid.mockResolvedValue('S-1-5-21-1000000001-2000000002-3000000003-1001');
  fixture.windowsStart.mockResolvedValue({ ...owner, port: 1234 });
  await expect(runStart()).resolves.toEqual({ running: true, ...owner });
  expect(fixture.windowsStart).toHaveBeenCalledWith({});
  expect(fixture.registration).toHaveBeenCalledWith({ target: { platform: 'win32', taskName: expect.stringMatching(/^\\VonvonBot-[0-9a-f]{12}-[0-9a-f]{12}$/), sid: 'S-1-5-21-1000000001-2000000002-3000000003-1001' }, requestedRoot: '/owned/root', unansweredAsAbsent: true });
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('I4a: win32 without a SID has no task to look up, and starts detached and hidden', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  fixture.sid.mockRejectedValue(new Error('no whoami'));
  fixture.spawn.mockImplementation(() => { throw new Error('stop here'); });
  await expect(runStart()).rejects.toThrow('stop here');
  expect(fixture.registration).not.toHaveBeenCalled();
  expect(fixture.windowsStart).not.toHaveBeenCalled();
  expect(fixture.spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, windowsHide: true });
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
it('starts the registered manager when the recorded owner fails PID-lock authentication', async () => {
  fixture.owner.mockResolvedValue(owner);
  fixture.verify.mockRejectedValue(new PidLockError('PID 4242 is not a Vonvon daemon'));
  await expect(runStart()).resolves.toEqual({ running: true, ...owner });
  expect(fixture.launchdStart).toHaveBeenCalledWith({ staleOwner: owner });
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it('starts the registered manager past a recorded owner that never publishes readiness', async () => {
  vi.useFakeTimers();
  try {
    const unready = { ...owner, listen: null };
    fixture.owner.mockResolvedValue(unready);
    const started = runStart();
    await vi.advanceTimersByTimeAsync(26_000);
    await expect(started).resolves.toEqual({ running: true, ...owner });
    expect(fixture.launchdStart).toHaveBeenCalledWith({ staleOwner: unready });
    expect(fixture.verify).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
it.each([['verifies once more and returns', true], ['keeps the exit diagnosis', false]] as const)('when the child loses to an unverified owner that becomes ready, %s', async (_name, recovers) => {
  vi.useFakeTimers();
  try {
    fixture.registration.mockResolvedValue({ kind: 'absent' });
    const child = new ChildProcess();
    Object.defineProperties(child, { pid: { value: 5555 }, exitCode: { value: 1 } });
    vi.spyOn(child, 'unref').mockImplementation(() => {});
    fixture.spawn.mockReturnValue(child);
    fixture.owner.mockResolvedValue(owner);
    fixture.verify.mockRejectedValueOnce(new PidLockError('busy'));
    if (recovers) fixture.verify.mockResolvedValue(undefined); else fixture.verify.mockRejectedValue(new PidLockError('busy'));
    const started = runStart();
    const settled = started.then(value => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(2_000);
    if (recovers) expect(await settled).toEqual({ value: { running: true, ...owner } });
    else expect(await settled).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('Daemon exited before readiness') }) });
    expect(fixture.verify).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it('refuses unrecognized definitions', async () => {
  fixture.registration.mockResolvedValue({ kind: 'unrecognized', location: '/service', reason: 'invalid' });
  await expect(runStart()).rejects.toThrow('Unrecognized service registration /service: invalid');
  expect(fixture.spawn).not.toHaveBeenCalled();
});
it.each([['darwin', 'absent'], ['linux', 'absent'], ['darwin', 'other-root']] as const)('retains V3 detached startup on %s for an %s registration', async (platform, kind) => {
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
