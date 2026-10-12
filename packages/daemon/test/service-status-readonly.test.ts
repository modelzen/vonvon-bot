import { afterEach, expect, it, vi } from 'vitest';
import { serviceStatusSchema } from '@vonvon/protocol';
import { homedir } from 'node:os';
import { getServiceAdapter } from '../src/service/adapter';
import { runServiceStatus } from '../src/cli/commands/service';
import { serviceTarget } from '../src/service/identity';

const observation = vi.hoisted(() => ({
  launchd: vi.fn(),
  systemd: vi.fn(),
  launchdCreate: vi.fn(),
  systemdCreate: vi.fn(),
  windowsStatus: vi.fn(),
}));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/tmp/vonvon-status-root' } }));
vi.mock('../src/service/launchd', () => ({ createLaunchdService: (...args: unknown[]) => { observation.launchdCreate(...args); return { status: observation.launchd }; } }));
vi.mock('../src/service/systemd', () => ({ createSystemdService: (...args: unknown[]) => { observation.systemdCreate(...args); return { status: observation.systemd }; } }));
vi.mock('../src/service/win-startup', () => ({
  installWinStartup: vi.fn(), uninstallWinStartup: vi.fn(), restartWinStartup: vi.fn(), winStartupRunning: vi.fn(), statusWinStartup: observation.windowsStatus,
}));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

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
  const result = await getServiceAdapter().status();
  expect(result).toMatchObject({ installed, running });
  expect(serviceStatusSchema.parse(result)).toMatchObject({ installed, running });
  if (scenario === 'other-root') expect(result.raw).toContain('/tmp/another-root');
  if (scenario === 'unrecognized') expect(result.raw).toContain('/tmp/bad-definition');
  if (scenario === 'manager error') expect(result.raw).toContain('permission denied');
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
  const result = await getServiceAdapter().status();
  expect(result).toMatchObject({ installed: true, running: false });
  expect(result.raw).toContain('unexpected unit path');
});

it('JSON keeps the frozen fields and sends other-root detail to stderr', async () => {
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  await runServiceStatus(true, { status: async () => ({
    platformName: 'launchd (macOS)', installed: true, running: false,
    servicePath: '/tmp/vonvon.plist', stdoutPath: '/tmp/service.log', stderrPath: '/tmp/service.err.log',
    raw: 'Vonvon service registration belongs to /tmp/another-root.',
  }) });
  expect(serviceStatusSchema.parse(JSON.parse(output.join('')))).toMatchObject({ installed: true, running: false });
  expect(JSON.parse(output.join(''))).not.toHaveProperty('raw');
  expect(errors.join('')).toContain('/tmp/another-root');
});

it('human output says the running state is unknown when the manager query fails', async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await runServiceStatus(false, { status: async () => ({
    platformName: 'systemd (Linux)', installed: true, running: false,
    servicePath: '/tmp/vonvon.service', stdoutPath: '/tmp/service.log', stderrPath: '/tmp/service.err.log',
    raw: 'systemd query failed: permission denied',
  }) });
  expect(output.join('')).toContain('running state unavailable');
  expect(output.join('')).not.toContain('not running');
});

it('Windows status never calls the legacy startup reader', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  await expect(getServiceAdapter().status()).rejects.toThrow('Run registration reader');
  expect(observation.windowsStatus).not.toHaveBeenCalled();
});
