import { afterEach, expect, it, vi } from 'vitest';
import { SERVICE_UNAVAILABLE } from '../src/host/service';

const fixture = vi.hoisted(() => ({
  adapterLoads: vi.fn(),
  getAdapter: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  mkdir: vi.fn(),
}));

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
    if (exit.mock.calls.length === 0 && fixture.adapterLoads.mock.calls.length === 0) throw new Error('CLI has not settled');
  });
  expect.soft(exit).toHaveBeenCalledWith(1);
  expect.soft(errors.join('\n')).toContain(SERVICE_UNAVAILABLE);
  expect.soft(fixture.adapterLoads).not.toHaveBeenCalled();
  expect.soft(fixture.getAdapter).not.toHaveBeenCalled();
  expect.soft(fixture.spawn).not.toHaveBeenCalled();
  expect.soft(fixture.spawnSync).not.toHaveBeenCalled();
  expect.soft(fixture.mkdir).not.toHaveBeenCalled();
});
