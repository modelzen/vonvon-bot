import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Registration } from '../src/service/registration';

const fixture = vi.hoisted(() => ({
  registration: vi.fn<() => Promise<Registration>>(), owner: vi.fn(), acquireMutex: vi.fn(), acquirePidLock: vi.fn(),
  closeMutex: vi.fn(), releasePidLock: vi.fn(), run: vi.fn(), info: vi.fn(), importedRun: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('../src/config/data-access', () => ({ acquireMutex: fixture.acquireMutex, closeMutex: fixture.closeMutex }));
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: fixture.owner, acquirePidLock: fixture.acquirePidLock, releasePidLock: fixture.releasePidLock, publishPidLock: vi.fn() }));
vi.mock('../src/service/registration', () => ({ readRegistration: fixture.registration }));
vi.mock('../src/core/logger', () => ({ log: { info: fixture.info } }));
vi.mock('../src/service/win-startup', () => ({ recordServicePid: vi.fn(), clearServicePid: vi.fn() }));
vi.mock('../src/service/codex-bin', () => ({ readServiceCodexBin: vi.fn() }));
vi.mock('../src/cli/commands/run', () => { fixture.importedRun(); return { runRun: fixture.run }; });
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), realpath: vi.fn(async () => '/owned/root'), stat: vi.fn(async () => ({ isDirectory: () => true })) }));

import { runHostRuntime } from '../src/host/bootstrap';
import { resolveServiceRoot } from '../src/service/identity';
import type { ShutdownControl } from '../src/host/lifecycle';

const owner = { pid: 4242, startedAt: '2026-10-11T00:00:00.000Z', listen: '127.0.0.1:1234' };
const control: ShutdownControl = {
  requested: false, requestStop: vi.fn(), requestRestart: vi.fn(), waitForRequest: vi.fn(),
  completeShutdown: vi.fn(async (release: () => Promise<void>) => { await release(); }), dispose: vi.fn(),
};

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.registration.mockReset(); fixture.owner.mockReset(); fixture.acquireMutex.mockReset(); fixture.acquirePidLock.mockReset();
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
    platform: { value: 'darwin' }, send: { value: undefined }, exitCode: { value: undefined, writable: true },
  }));
  vi.stubEnv('VONVON_SERVICE', 'launchd');
  fixture.registration.mockResolvedValue({ kind: 'ours', definition: { root: await resolveServiceRoot('/owned/root'), port: 1234, capturedPath: '/bin', distribution: { kind: 'npm', executable: '/node', entry: '/cli' } } });
  fixture.owner.mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function untouched(): void {
  expect(fixture.acquireMutex).not.toHaveBeenCalled(); expect(fixture.acquirePidLock).not.toHaveBeenCalled();
  expect(fixture.releasePidLock).not.toHaveBeenCalled(); expect(fixture.closeMutex).not.toHaveBeenCalled();
  expect(fixture.run).not.toHaveBeenCalled(); expect(fixture.importedRun).not.toHaveBeenCalled();
}
it('returns zero before either lock when managed registration is absent', async () => {
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(fixture.owner).not.toHaveBeenCalled(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'registration_absent');
});
it('returns zero for an unrecognized managed registration', async () => {
  fixture.registration.mockResolvedValue({ kind: 'unrecognized', location: '/service', reason: 'invalid' });
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
});
it('treats a registration read failure as not ours for a managed launch', async () => {
  fixture.registration.mockRejectedValue(new Error('unreadable'));
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
});
it('returns zero without releasing or overwriting an existing owner', async () => {
  fixture.owner.mockResolvedValue(Object.freeze(owner));
  await runHostRuntime({ managed: false, control });
  untouched(); expect(process.exitCode).toBe(0);
  expect(fixture.info).toHaveBeenCalledWith('daemon-startup', 'owner_present', { pid: owner.pid });
});
it('releases only its own mutex after a pid-lock collision', async () => {
  const mutex = {};
  fixture.acquireMutex.mockResolvedValue(mutex);
  fixture.acquirePidLock.mockRejectedValue(new Error('collision'));
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValueOnce(owner);
  await runHostRuntime({ managed: false, control });
  expect(process.exitCode).toBe(0); expect(fixture.closeMutex).toHaveBeenCalledWith(mutex);
  expect(fixture.releasePidLock).not.toHaveBeenCalled(); expect(fixture.run).not.toHaveBeenCalled();
});
it('returns zero on a mutex collision only when another live owner exists', async () => {
  fixture.acquireMutex.mockRejectedValue(new Error('collision'));
  fixture.owner.mockResolvedValueOnce(null).mockResolvedValueOnce(owner);
  await runHostRuntime({ managed: false, control });
  expect(process.exitCode).toBe(0); expect(fixture.closeMutex).not.toHaveBeenCalled();
  expect(fixture.acquirePidLock).not.toHaveBeenCalled();
});
it('propagates lock failures without another live owner', async () => {
  fixture.acquireMutex.mockRejectedValue(new Error('unavailable'));
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('unavailable');
  expect(fixture.run).not.toHaveBeenCalled();
});
it('refuses unmanaged foreground startup with exit one before locks', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Use vonvon daemon start or vonvon service uninstall');
  untouched(); expect(process.exitCode).toBe(1);
});
it('does not exempt a bot argument without the supervisor IPC channel', async () => {
  vi.stubEnv('VONVON_SERVICE', '');
  await expect(runHostRuntime({ managed: false, bot: 'fixture', control })).rejects.toThrow('Use vonvon daemon start');
  untouched(); expect(process.exitCode).toBe(1);
});
it('exempts only the IPC Bot child without reading registration or locks', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'send', { value: vi.fn() }));
  await runHostRuntime({ managed: false, bot: 'fixture', control });
  expect(fixture.registration).not.toHaveBeenCalled(); expect(fixture.owner).not.toHaveBeenCalled();
  expect(fixture.acquireMutex).not.toHaveBeenCalled(); expect(fixture.acquirePidLock).not.toHaveBeenCalled();
  expect(fixture.run).toHaveBeenCalledWith('fixture', expect.objectContaining({ control }));
});
it.each(['darwin', 'win32'] as const)('retains ordinary foreground startup when registration is absent or the existing unmanaged Windows path on %s', async platform => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: platform }));
  vi.stubEnv('VONVON_SERVICE', '');
  fixture.registration.mockResolvedValue({ kind: 'absent' });
  const mutex = {};
  fixture.acquireMutex.mockResolvedValue(mutex);
  fixture.acquirePidLock.mockResolvedValue(owner);
  await runHostRuntime({ managed: false, control });
  expect(fixture.acquireMutex).toHaveBeenCalledWith('/owned/root', 'host');
  expect(fixture.acquirePidLock).toHaveBeenCalledWith('/owned/root');
  expect(fixture.acquireMutex.mock.invocationCallOrder[0]).toBeLessThan(fixture.acquirePidLock.mock.invocationCallOrder[0] ?? 0);
  expect(fixture.run).toHaveBeenCalledOnce();
  expect(fixture.releasePidLock).toHaveBeenCalledWith('/owned/root', owner);
  expect(fixture.closeMutex).toHaveBeenCalledWith(mutex);
});

it('refuses service-managed Windows before any registration or lock action', async () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'win32' }));
  await expect(runHostRuntime({ managed: false, control })).rejects.toThrow('Windows service startup is unavailable');
  untouched(); expect(fixture.registration).not.toHaveBeenCalled();
});

it.each(['stop', 'restart'] as const)('preserves %s exit zero while reporting a late PID release failure', async intent => {
  const { observeShutdown } = await import('../src/host/lifecycle');
  const shutdown = observeShutdown();
  const failure = new Error('PID release failed');
  fixture.acquirePidLock.mockResolvedValue({ ...owner, pid: process.pid });
  fixture.releasePidLock.mockRejectedValueOnce(failure);
  fixture.run.mockImplementationOnce(async () => {
    if (intent === 'restart') shutdown.requestRestart(1234);
    else shutdown.requestStop();
    await shutdown.completeShutdown(async () => {});
  });
  await expect(runHostRuntime({ managed: false, control: shutdown })).rejects.toBe(failure);
  expect(process.exitCode).toBe(0);
});

it('cancels a requested restart when the runner rejects before completing shutdown', async () => {
  const { observeShutdown } = await import('../src/host/lifecycle');
  const shutdown = observeShutdown();
  const failure = new Error('runner failed during drain');
  fixture.run.mockImplementationOnce(async () => {
    shutdown.requestRestart(1234);
    throw failure;
  });
  await expect(runHostRuntime({ managed: false, control: shutdown })).rejects.toBe(failure);
  expect(process.exitCode).toBe(0);
});
