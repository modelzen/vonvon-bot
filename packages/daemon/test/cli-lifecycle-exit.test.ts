import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ run: vi.fn(), release: vi.fn(), exit: vi.fn() }));
vi.mock('../src/core/version', () => ({ bridgeVersion: () => '0.7.0' }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('../src/config/data-access', () => ({ enterDataAccess: async () => ({ release: fixture.release }) }));
vi.mock('../src/host/bootstrap', () => ({ runHostRuntime: fixture.run }));
vi.mock('../src/host/lifecycle', () => ({ observeShutdown: () => ({ dispose() {} }) }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.assign(Object.create(process), {
    argv: ['node', '/cli', 'daemon', 'run'], exitCode: undefined, exit: fixture.exit,
    env: { ...process.env, VONVON_SERVICE: '1' }, send: undefined,
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  { label: 'completed restart', code: 75, failure: false, expected: 75 },
  { label: 'completed stop', code: 0, failure: false, expected: 0 },
  { label: 'stop with reported cleanup error', code: 0, failure: true, expected: 0 },
  { label: 'restart with late cleanup error', code: 75, failure: true, expected: 0 },
  { label: 'startup failure', code: undefined, failure: true, expected: 1 },
])('$label exits $expected', async ({ code, failure, expected }) => {
  fixture.run.mockImplementation(async () => {
    process.exitCode = code;
    if (failure) throw new Error('reported failure');
  });
  await import('../src/cli/index');
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(expected));
  if (failure) expect(console.error).toHaveBeenCalledWith('reported failure');
});

it('cancels a successful restart code when the CLI lease release fails', async () => {
  fixture.run.mockImplementation(async () => { process.exitCode = 75; });
  fixture.release.mockImplementation(() => { throw new Error('lease release failed'); });
  await import('../src/cli/index');
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(0));
  expect(console.error).toHaveBeenCalledWith('lease release failed');
});

it.each([
  { label: 'unmanaged host', service: undefined, child: false, code: 0 },
  { label: 'unmanaged host', service: undefined, child: false, code: 75 },
  { label: 'IPC Bot child', service: '1', child: true, code: 0 },
  { label: 'IPC Bot child', service: '1', child: true, code: 75 },
])('$label rejects with exit 1 despite preset code $code', async ({ service, child, code }) => {
  if (service) process.env.VONVON_SERVICE = service;
  else delete process.env.VONVON_SERVICE;
  if (child) process.send = vi.fn();
  fixture.run.mockImplementation(async () => {
    process.exitCode = code;
    throw new Error('reported failure');
  });
  await import('../src/cli/index');
  await vi.waitFor(() => expect(fixture.exit).toHaveBeenCalledExactlyOnceWith(1));
  expect(console.error).toHaveBeenCalledWith('reported failure');
});
