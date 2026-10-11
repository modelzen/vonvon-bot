import { afterEach, expect, it, vi } from 'vitest';
import { SERVICE_UNAVAILABLE } from '../src/host/service';
import type { ServiceTransactionOutcome } from '../src/service/adapter';

const fixture = vi.hoisted(() => ({
  adapterLoads: vi.fn(),
  relaunch: vi.fn(async () => {}),
  getAdapter: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('../src/service/win-startup', () => {
  fixture.adapterLoads('win-startup');
  return { runWinRelaunch: fixture.relaunch };
});

it.each([
  { args: [], expected: {} },
  { args: ['--port', '0'], expected: {} },
  { args: ['--port', '23456'], expected: { port: 23456 } },
])('service install forwards parsed $args without taking a data lease', async ({ args, expected }) => {
  vi.resetModules();
  vi.clearAllMocks();
  const outcome: ServiceTransactionOutcome = { kind: 'installed', detail: 'Installed', retained: null, leftovers: [] };
  const install = vi.fn(async () => outcome);
  fixture.getAdapter.mockReturnValue({ install });
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  process.argv = [process.execPath, '/virtual/vonvon.mjs', 'service', 'install', ...args];
  await import('../src/cli/index');
  await vi.waitFor(() => expect(stdout).toHaveBeenCalledWith('installed: Installed\n'));
  expect(install).toHaveBeenCalledWith(expected);
  expect(fixture.mkdir).not.toHaveBeenCalled();
  expect(fixture.spawn).not.toHaveBeenCalled();
  expect(fixture.spawnSync).not.toHaveBeenCalled();
});

it.each(['abc', '-1', '65536', '1.5'])('service install rejects invalid port %s before loading an adapter', async port => {
  vi.resetModules();
  vi.clearAllMocks();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  process.argv = [process.execPath, '/virtual/vonvon.mjs', 'service', 'install', '--port', port];
  await import('../src/cli/index');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(errors).toHaveBeenCalledWith('Invalid port.');
  expect(fixture.getAdapter).not.toHaveBeenCalled();
  expect(fixture.mkdir).not.toHaveBeenCalled();
});

it.each([
  ['install', 'install_refused'], ['install', 'install_rolled_back'], ['install', 'install_incomplete'],
  ['uninstall', 'uninstall_refused'], ['uninstall', 'uninstall_rolled_back'], ['uninstall', 'uninstall_incomplete'],
] as const)('service %s exits 1 for %s and prints retained owner and leftovers', async (action, kind) => {
  vi.resetModules();
  vi.clearAllMocks();
  const outcome: ServiceTransactionOutcome = { kind, detail: 'transaction diagnostic', retained: { pid: 42, startedAt: 'retained' }, leftovers: ['file /fixture/service', 'job loaded'] };
  fixture.getAdapter.mockReturnValue({ [action]: vi.fn(async () => outcome) });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  process.argv = [process.execPath, '/virtual/vonvon.mjs', 'service', action];
  await import('../src/cli/index');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  expect(errors).toHaveBeenCalledWith(`${kind}: transaction diagnostic\nRetained PID 42 (startedAt retained).\nLeftover: file /fixture/service\nLeftover: job loaded`);
  expect(stdout).not.toHaveBeenCalled();
});
vi.mock('../src/service/adapter', () => { fixture.adapterLoads('adapter'); return { getServiceAdapter: fixture.getAdapter }; });
vi.mock('../src/service/launchd', () => { fixture.adapterLoads('launchd'); return {}; });
vi.mock('../src/service/systemd', () => { fixture.adapterLoads('systemd'); return {}; });
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: fixture.spawn,
  spawnSync: fixture.spawnSync,
  execFile: fixture.spawn,
  execFileSync: fixture.spawnSync,
}));
vi.mock('node:fs/promises', async (original) => ({
  ...await original<typeof import('node:fs/promises')>(),
  mkdir: fixture.mkdir,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it.each(['win32', 'darwin'] satisfies NodeJS.Platform[])('refuses hidden Windows relaunch on %s before importing an adapter', async platform => {
  vi.resetModules();
  fixture.adapterLoads.mockClear();
  fixture.relaunch.mockClear();
  fixture.getAdapter.mockClear();
  fixture.spawn.mockClear();
  fixture.spawnSync.mockClear();
  fixture.mkdir.mockClear();
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  const errors: string[] = [];
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    process.exitCode = code ?? undefined;
    return undefined as never;
  });
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
  process.argv = [process.execPath, '/virtual/vonvon.mjs', '__win-relaunch', '/virtual/unclaimed-request.json'];
  await import('../src/cli/index');
  await vi.waitFor(() => {
    if (exit.mock.calls.length === 0 && fixture.adapterLoads.mock.calls.length === 0 && fixture.relaunch.mock.calls.length === 0) throw new Error('CLI has not settled');
  });
  expect.soft(exit).toHaveBeenCalledWith(1);
  expect.soft(errors.join('\n')).toContain(SERVICE_UNAVAILABLE);
  expect.soft(fixture.adapterLoads).not.toHaveBeenCalled();
  expect.soft(fixture.relaunch).not.toHaveBeenCalled();
  expect.soft(fixture.getAdapter).not.toHaveBeenCalled();
  expect.soft(fixture.spawn).not.toHaveBeenCalled();
  expect.soft(fixture.spawnSync).not.toHaveBeenCalled();
  expect.soft(fixture.mkdir).not.toHaveBeenCalled();
});
