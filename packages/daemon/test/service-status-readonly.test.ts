import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { serviceStatusSchema } from '@vonvon/protocol';
import { homedir } from 'node:os';
import { getServiceAdapter } from '../src/service/adapter';
import { controlDesktopService } from '../src/host/service';
import { runServiceStatus } from '../src/cli/commands/service';
import { serviceTarget } from '../src/service/identity';

const observation = vi.hoisted(() => ({
  launchd: vi.fn(),
  systemd: vi.fn(),
  launchdCreate: vi.fn(),
  systemdCreate: vi.fn(),
  windowsStatus: vi.fn(),
  windowsRun: vi.fn(),
  windowsRegistration: vi.fn(),
  owner: vi.fn(),
  verifyOwner: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/tmp/vonvon-status-root' } }));
vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../src/service/identity', async importOriginal => ({
  ...await importOriginal(),
  resolveServiceRoot: vi.fn(async (path: string) => path === '/tmp/vonvon-status-root' ? 'C:\\Vonvon' : path),
}));
vi.mock('../src/service/registration', () => ({ readRegistration: observation.windowsRegistration }));
vi.mock('../src/server/pid-lock', () => ({ readRunningPidLock: observation.owner }));
vi.mock('../src/server/owner-verification', () => ({ verifyPidLockOwner: observation.verifyOwner }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: (...args: unknown[]) => { observation.launchdCreate(...args); return { status: observation.launchd }; } }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: (...args: unknown[]) => { observation.systemdCreate(...args); return { status: observation.systemd }; } }));
vi.mock('../src/service/win-startup', () => ({
  readVonvonRunValue: observation.windowsRun,
}));

beforeEach(() => {
  vi.mocked(homedir).mockReturnValue('/home/vonvon-fixture');
  vi.stubEnv('XDG_CONFIG_HOME', '/home/vonvon-fixture/.config');
});
afterEach(() => { vi.mocked(homedir).mockReset(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

function registration(kind: 'absent' | 'ours' | 'other-root' | 'unrecognized') {
  if (kind === 'ours') return { kind, definition: { root: '/tmp/vonvon-status-root' } };
  if (kind === 'other-root') return { kind, recordedRoot: '/tmp/another-root', definition: { root: '/tmp/another-root' } };
  if (kind === 'unrecognized') return { kind, location: '/tmp/bad-definition', reason: 'bad bytes' };
  return { kind };
}

it.each([
  ['absent', { kind: 'absent' }, null, false, false],
  ['ours running', { kind: 'loaded', pid: 42, raw: '' }, 42, true, true],
  ['ours stopped', { kind: 'loaded', pid: null, raw: '' }, null, true, false],
  ['other-root', { kind: 'loaded', pid: 42, raw: '' }, 42, true, false],
  ['unrecognized', { kind: 'loaded', pid: 42, raw: '' }, 42, true, false],
  ['manager error', { kind: 'unknown', detail: 'permission denied' }, 42, true, false],
] as const)('macOS %s maps registration, manager and verified lock without mutations', async (scenario, manager, ownerPid, installed, running) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  const kind = scenario === 'other-root' || scenario === 'unrecognized' || scenario === 'absent' ? scenario : 'ours';
  observation.launchd.mockResolvedValue({ registration: registration(kind), manager, owner: ownerPid === null ? null : { pid: ownerPid, startedAt: 'now' }, running: ownerPid !== null });
  if (scenario === 'other-root' || scenario === 'unrecognized' || scenario === 'manager error') {
    const detail = scenario === 'other-root' ? '/tmp/another-root' : scenario === 'unrecognized' ? '/tmp/bad-definition' : 'permission denied';
    await expect(getServiceAdapter().status()).rejects.toThrow(detail);
  } else {
    const result = await getServiceAdapter().status();
    expect(result).toMatchObject({ installed, running });
    expect(serviceStatusSchema.parse(result)).toMatchObject({ installed, running });
  }
  expect(observation.launchdCreate).toHaveBeenCalledWith({ root: '/tmp/vonvon-status-root' });
  expect(observation.systemdCreate).not.toHaveBeenCalled();
  expect(observation.windowsStatus).not.toHaveBeenCalled();
});

it('Linux uses the manager MainPID and verified owner; JSON stays on the frozen schema', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const target = serviceTarget({ platform: 'linux', home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME });
  if (target.platform !== 'linux') throw new Error('Expected Linux target');
  observation.systemd.mockResolvedValue({ registration: registration('ours'), manager: { kind: 'present', loadState: 'loaded', fragmentPath: target.unitPath, mainPid: 54 }, enabled: { kind: 'enabled' }, owner: { pid: 54, startedAt: 'now' }, running: true });
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await runServiceStatus(true);
  expect(serviceStatusSchema.parse(JSON.parse(output.join('')))).toMatchObject({ platformName: 'systemd (Linux)', installed: true, running: true, pid: '54' });
  expect(JSON.parse(output.join(''))).not.toHaveProperty('raw');
  expect(observation.systemdCreate).toHaveBeenCalledWith({ root: '/tmp/vonvon-status-root' });
  expect(observation.windowsStatus).not.toHaveBeenCalled();
});

it('Linux refuses to identify a different manager unit as this root service', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  observation.systemd.mockResolvedValue({ registration: registration('ours'), manager: { kind: 'present', loadState: 'loaded', fragmentPath: '/tmp/other-unit', mainPid: 54 }, enabled: { kind: 'enabled' }, owner: { pid: 54, startedAt: 'now' }, running: true });
  await expect(getServiceAdapter().status()).rejects.toThrow('unexpected unit path');
});

it.each([true, false])('CLI propagates adapter uncertainty without emitting a successful status (json=%s)', async json => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await expect(runServiceStatus(json, { status: async () => { throw new Error('systemd query failed: permission denied'); } })).rejects.toThrow('permission denied');
  expect(output).not.toHaveBeenCalled();
});

it.each([
  ['absent', { kind: 'absent' }, false, false],
  ['ours stopped', { kind: 'ours' }, true, false],
  ['ours running', { kind: 'ours' }, true, true],
] as const)('Windows %s uses the Run registration and verified lock', async (_scenario, state, installed, running) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  const windowsRun = installed ? { kind: 'value', type: 'REG_SZ', value: 'wscript.exe //B \"C:\\Vonvon\\service\\vonvon-bot.vbs\"' } : { kind: 'absent' };
  observation.windowsRun.mockReturnValue(windowsRun);
  observation.windowsRegistration.mockResolvedValue(state);
  observation.owner.mockResolvedValue(running ? { pid: 42, startedAt: 'now', listen: '127.0.0.1:43121' } : null);
  const result = await getServiceAdapter().status();
  expect(result).toMatchObject({ installed, running, servicePath: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Vonvon Bot' });
  expect(result.pid).toBe(running ? '42' : undefined);
  expect(observation.windowsRegistration).toHaveBeenCalledWith(expect.objectContaining({ requestedRoot: 'C:\\Vonvon', windowsRun }));
  expect(observation.verifyOwner).toHaveBeenCalledTimes(running ? 1 : 0);
  expect(observation.windowsStatus).not.toHaveBeenCalled();
});

it.each([
  ['other-root', { kind: 'other-root', recordedRoot: 'D:\\Other' }, 'D:\\Other'],
  ['unrecognized', { kind: 'unrecognized', location: 'C:\\bad.vbs', reason: 'bad definition' }, 'bad definition'],
])('Windows %s refuses uncertain registration', async (_scenario, state, detail) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  observation.windowsRun.mockReturnValue({ kind: 'value', type: 'REG_SZ', value: 'locator' });
  observation.windowsRegistration.mockResolvedValue(state);
  await expect(getServiceAdapter().status()).rejects.toThrow(detail);
  expect(observation.owner).not.toHaveBeenCalled();
});

it('Windows never reports a lock as a running service without registration and owner verification', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  observation.windowsRun.mockReturnValue({ kind: 'absent' });
  observation.owner.mockResolvedValue({ pid: 42, startedAt: 'now', listen: '127.0.0.1:43121' });
  observation.windowsRegistration.mockResolvedValue({ kind: 'absent' });
  await expect(getServiceAdapter().status()).resolves.toMatchObject({ installed: false, running: false });
  expect(observation.verifyOwner).not.toHaveBeenCalled();
  observation.windowsRun.mockReturnValue({ kind: 'value', type: 'REG_SZ', value: 'wscript.exe //B \"C:\\Vonvon\\service\\vonvon-bot.vbs\"' });
  observation.windowsRegistration.mockResolvedValue({ kind: 'ours' });
  observation.verifyOwner.mockRejectedValue(new Error('Cannot verify daemon owner'));
  await expect(getServiceAdapter().status()).rejects.toThrow('Cannot verify daemon owner');
});

it('Windows query failure reaches the existing CLI and host error channel without success output', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  observation.windowsRun.mockReturnValue({ kind: 'unavailable', reason: 'permission denied' });
  observation.windowsRegistration.mockResolvedValue({ kind: 'unrecognized', location: 'HKCU', reason: 'Windows Run observation unavailable: permission denied' });
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await expect(runServiceStatus(true)).rejects.toThrow('permission denied');
  await expect(controlDesktopService('status')).rejects.toThrow('permission denied');
  expect(output).not.toHaveBeenCalled();
});

it('Windows CLI human and JSON and host use the same read-only adapter', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  observation.windowsRun.mockReturnValue({ kind: 'absent' });
  observation.windowsRegistration.mockResolvedValue({ kind: 'absent' });
  observation.owner.mockResolvedValue(null);
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
  await runServiceStatus(false);
  expect(stdout.join('')).toContain('not registered, not running');
  expect(stderr.join('')).toContain('No Vonvon service registration');
  expect(await controlDesktopService('status')).toMatchObject({ supported: true, installed: false, running: false });
  stdout.length = 0;
  await runServiceStatus(true);
  const wire = JSON.parse(stdout.join(''));
  expect(wire).toEqual(serviceStatusSchema.parse(wire));
  expect(wire).not.toHaveProperty('raw');
});

it('Windows host mutations refuse before invoking a manager adapter', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  await expect(controlDesktopService('install')).rejects.toThrow('cannot manage an OS service');
  await expect(controlDesktopService('uninstall')).rejects.toThrow('cannot manage an OS service');
  expect(observation.windowsRun).not.toHaveBeenCalled();
});

for (const phrase of ['query failed', 'unexpected unit path', 'Unrecognized Vonvon service registration', 'registration belongs to elsewhere']) {
  it.each([true, false])(`accepts a valid Linux ${phrase} path with running=%s through host and CLI`, async running => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.stubEnv('XDG_CONFIG_HOME', `/tmp/${phrase}`);
    const unitPath = `/tmp/${phrase}/systemd/user/vonvon-bot.service`;
    observation.systemd.mockResolvedValue({ registration: registration('ours'), manager: { kind: 'present', loadState: 'loaded', fragmentPath: unitPath, mainPid: running ? 54 : null }, enabled: { kind: 'enabled' }, owner: running ? { pid: 54, startedAt: 'now' } : null, running });
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runServiceStatus(false);
    expect(output.join('')).toContain(running ? 'running PID 54' : 'not running');
    expect(await controlDesktopService('status')).toMatchObject({ supported: true, installed: true, running, servicePath: unitPath });
    output.length = 0;
    await runServiceStatus(true);
    const wire = JSON.parse(output.join(''));
    expect(wire).toEqual(serviceStatusSchema.parse(wire));
    expect(wire).toMatchObject({ installed: true, running, servicePath: unitPath });
    expect(wire).not.toHaveProperty('raw');
  });
}

it.each(['darwin', 'linux'] as const)('propagates typed %s uncertainty through both consumers', async platform => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const target = serviceTarget({ platform: 'linux', home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME });
  if (target.platform !== 'linux') throw new Error('Expected Linux target');
  const present = { kind: 'present', loadState: 'loaded', fragmentPath: target.unitPath, mainPid: null };
  const known = platform === 'linux' ? present : { kind: 'loaded', pid: null, raw: '' };
  const cases = [
    { registration: registration('other-root'), manager: known, enabled: { kind: 'enabled' }, detail: '/tmp/another-root' },
    { registration: registration('unrecognized'), manager: known, enabled: { kind: 'enabled' }, detail: '/tmp/bad-definition' },
    { registration: registration('ours'), manager: { kind: 'unknown', detail: 'denied' }, enabled: { kind: 'enabled' }, detail: 'query failed: denied' },
    ...(platform === 'linux' ? [
      { registration: registration('ours'), manager: present, enabled: { kind: 'unknown', detail: 'denied' }, detail: 'is-enabled query failed: denied' },
      { registration: registration('ours'), manager: { ...present, fragmentPath: '/tmp/foreign' }, enabled: { kind: 'enabled' }, detail: 'unexpected unit path: /tmp/foreign' },
    ] : []),
  ];
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const { detail, ...facts } of cases) {
    const status = platform === 'linux' ? observation.systemd : observation.launchd;
    status.mockResolvedValue({ ...facts, owner: null, running: false });
    await expect(controlDesktopService('status')).rejects.toThrow(detail);
    await expect(runServiceStatus(false)).rejects.toThrow(detail);
    await expect(runServiceStatus(true)).rejects.toThrow(detail);
  }
  expect(output).not.toHaveBeenCalled();
});
