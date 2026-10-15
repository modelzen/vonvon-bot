import { afterEach, expect, it, vi } from 'vitest';
import { runServiceCommand, runServiceStatus } from '../src/cli/commands/service';
import { serviceStatus } from '../src/service/adapter';
import type { ServiceTransactionOutcome } from '../src/service/adapter';

const outcome = (kind: ServiceTransactionOutcome['kind'], extra: Partial<ServiceTransactionOutcome> = {}): ServiceTransactionOutcome => ({ kind, detail: kind, retained: null, leftovers: [], ...extra });
afterEach(() => { vi.restoreAllMocks(); });

it.each(['installed', 'already-installed'] as const)('install prints %s and succeeds', async kind => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(async () => outcome(kind)), uninstall: vi.fn() };
  await runServiceCommand('install', adapter, { port: 32123 });
  expect(adapter.install).toHaveBeenCalledWith({ port: 32123 }); expect(adapter.uninstall).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledWith(`${kind}: ${kind}\n`);
});
it('a successful install names the service daemon without calling it left behind', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(async () => outcome('installed', { detail: 'Installed', retained: { pid: 7, startedAt: 'x' }, leftovers: ['retained pid 7', 'plist /p: ours'] })), uninstall: vi.fn() };
  await runServiceCommand('install', adapter);
  expect(write).toHaveBeenCalledWith('installed: Installed\nDaemon PID 7 is running under the service.\n');
});
it.each(['install_refused', 'install_rolled_back', 'install_incomplete'] as const)('install %s fails with the detail and what was left behind', async kind => {
  const adapter = { install: vi.fn(async () => outcome(kind, { detail: 'stop_unconfirmed: lost', retained: { pid: 7, startedAt: 'x' }, leftovers: ['plist /p: ours'] })), uninstall: vi.fn() };
  await expect(runServiceCommand('install', adapter)).rejects.toThrow(`${kind}: stop_unconfirmed: lost\nDaemon PID 7 is still running.\nLeft behind: plist /p: ours\nNext step: vonvon service uninstall`);
});
it('uninstall reports not-installed as success', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(), uninstall: vi.fn(async () => outcome('not-installed')) };
  await expect(runServiceCommand('uninstall', adapter)).resolves.toBeUndefined();
});

const observed = { platformName: 'launchd (macOS)', name: 'com.vonvon.bot.daemon', servicePath: '/Users/u/Library/LaunchAgents/com.vonvon.bot.daemon.plist', ownerError: null } as const;
const ours = { kind: 'ours', definition: {} } as never;
it.each([
  ['not-installed', { registration: { kind: 'absent' }, manager: { kind: 'absent' }, owner: null, running: false }],
  ['conflict', { registration: { kind: 'absent' }, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['disabled', { registration: ours, manager: { kind: 'absent' }, owner: null, running: false }],
  ['running', { registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: true }],
  ['detached', { registration: ours, manager: { kind: 'enabled', pid: null }, owner: { pid: 9 }, running: true }],
  ['stopped', { registration: ours, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['conflict', { registration: { kind: 'unrecognized', location: '/p', reason: 'old' }, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['unknown', { registration: ours, manager: { kind: 'unknown', detail: 'timed out' }, owner: null, running: false }],
] as const)('status folds into %s', (state, input) => {
  const status = serviceStatus({ ...observed, ...input } as Parameters<typeof serviceStatus>[0]);
  expect(status.state).toBe(state);
  expect(status.installed).toBe(input.registration.kind !== 'absent');
  expect(status.pid).toBe(input.running ? '9' : undefined);
});
it('a plist that launchd does not know reads as turned off in System Settings (e06)', () => {
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'absent' }, owner: null, running: false });
  expect(status.detail).toContain('Login Items & Extensions');
});
it('a daemon that does not authenticate is a conflict, not running', () => {
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: false, ownerError: 'bad credential' });
  expect(status.state).toBe('conflict'); expect(status.detail).toContain('bad credential');
});
it('status prints the state, its next step and the files, or JSON', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: true });
  await runServiceStatus(false, { status: async () => status });
  expect(String(write.mock.calls[0]?.[0])).toMatch(/^launchd \(macOS\) com\.vonvon\.bot\.daemon: running \(PID 9\)\nRunning under the service manager\.\nDefinition: .*com\.vonvon\.bot\.daemon\.plist\nLogs: /);
  await runServiceStatus(true, { status: async () => status });
  expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({ state: 'running', pid: '9', installed: true });
});
