import { afterEach, expect, it, vi } from 'vitest';
import type { ShutdownControl } from '../src/host/lifecycle';

// s18 D2: a supervised child that finds its bot's lock held (the previous child still draining) exits 75, not a crash.
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: vi.fn(async () => ({ cfg: { accounts: { app: { id: 'cli_lockbusy', secret: 'x', tenant: 'feishu' } } }, secret: 'x' })),
  announceEventsWhenLive() {},
}));
vi.mock('../src/core/single-instance', async original => {
  const real = await original<typeof import('../src/core/single-instance')>();
  return { ...real, acquireSingleInstanceLock: () => { throw new real.BridgeAlreadyRunningError(4242); } };
});
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
import { runRun } from '../src/cli/commands/run';
import { ensureOnboarded } from '../src/bot/onboarding';
import { readSingleInstanceHolder } from '../src/core/single-instance';

const control: ShutdownControl = { requested: false, waitForRequest: () => new Promise(() => {}), requestStop() {}, requestRestart() {}, completeShutdown: async release => release(), dispose() {} };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('a supervised child checks the held lock before onboarding or credential requests', async () => {
  vi.spyOn(await import('../src/core/single-instance'), 'readSingleInstanceHolder').mockReturnValue({ pid: process.pid, startedAt: Date.now() });
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: () => true }, exitCode: { value: undefined, writable: true } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runRun('cli_lockbusy', { control });
  expect(process.exitCode).toBe(75);
  expect(readSingleInstanceHolder).toHaveBeenCalledOnce();
  expect(ensureOnboarded).not.toHaveBeenCalled();
});

it.each([['supervised', 75, () => true], ['standalone', 1, undefined]] as const)('%s: the lock held by a live process exits %i', async (_name, code, send) => {
  vi.stubGlobal('process', Object.defineProperties(Object.create(process), { send: { value: send }, exitCode: { value: undefined, writable: true } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runRun('cli_lockbusy', { control });
  expect(process.exitCode).toBe(code);
});
