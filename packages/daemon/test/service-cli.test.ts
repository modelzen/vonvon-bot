import { afterEach, expect, it, vi } from 'vitest';
import { runServiceCommand } from '../src/cli/commands/service';
import type { ServiceTransactionOutcome } from '../src/service/adapter';

afterEach(() => { vi.restoreAllMocks(); });

it.each([
  ['install', 'installed'], ['install', 'already-installed'],
  ['uninstall', 'uninstalled'], ['uninstall', 'not-installed'],
] as const)('CLI service %s reports %s successfully without a status reread', async (action, kind) => {
  const result: ServiceTransactionOutcome = { kind, detail: kind, retained: { pid: 42, startedAt: 'original-owner' }, leftovers: [] };
  const adapter = { install: vi.fn(async () => result), uninstall: vi.fn(async () => result), status: vi.fn(() => { throw new Error('status must not affect completed transaction'); }) };
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await expect(runServiceCommand(action, adapter)).resolves.toBeUndefined();
  expect(adapter[action]).toHaveBeenCalledOnce();
  expect(adapter[action === 'install' ? 'uninstall' : 'install']).not.toHaveBeenCalled();
  expect(adapter.status).not.toHaveBeenCalled();
  expect(output.mock.calls.map(([text]) => text).join('')).toContain('Retained PID 42');
});

it.each([
  ['install', 'install_refused'], ['install', 'install_rolled_back'], ['install', 'install_incomplete'],
  ['uninstall', 'uninstall_refused'], ['uninstall', 'uninstall_rolled_back'], ['uninstall', 'uninstall_incomplete'],
] as const)('CLI service %s rejects %s with every diagnostic for the CLI exit-1 boundary', async (action, kind) => {
  const result: ServiceTransactionOutcome = { kind, detail: 'transaction diagnostic', retained: { pid: 42, startedAt: 'original-owner' }, leftovers: ['definition /tmp/service', 'job present: unknown'] };
  const adapter = { install: vi.fn(async () => result), uninstall: vi.fn(async () => result) };
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await expect(runServiceCommand(action, adapter)).rejects.toThrow([
    `${kind}: transaction diagnostic`, 'Retained PID 42 (startedAt original-owner).',
    'Leftover: definition /tmp/service', 'Leftover: job present: unknown',
  ].join('\n'));
  expect(output).not.toHaveBeenCalled();
});

it.each(['install', 'uninstall'] as const)('an unconfirmed stop during %s names the recovery command', async action => {
  const result: ServiceTransactionOutcome = { kind: action === 'install' ? 'install_incomplete' : 'uninstall_incomplete', detail: 'stop_unconfirmed: PID 42 may still be draining', retained: { pid: 42, startedAt: 'original-owner' }, leftovers: ['job loaded'] };
  const adapter = { install: vi.fn(async () => result), uninstall: vi.fn(async () => result) };
  await expect(runServiceCommand(action, adapter)).rejects.toThrow('Next step: vonvon service uninstall');
});

it('forwards the requested installation port', async () => {
  const result: ServiceTransactionOutcome = { kind: 'installed', detail: 'Installed', retained: null, leftovers: [] };
  const adapter = { install: vi.fn(async () => result), uninstall: vi.fn() };
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await runServiceCommand('install', adapter, { port: 12345 });
  expect(adapter.install).toHaveBeenCalledWith({ port: 12345 });
});

it('preserves an adapter rejection without printing success', async () => {
  const failure = new Error('Registration read failed');
  const adapter = { install: vi.fn(async () => { throw failure; }), uninstall: vi.fn() };
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  await expect(runServiceCommand('install', adapter)).rejects.toBe(failure);
  expect(output).not.toHaveBeenCalled();
});
