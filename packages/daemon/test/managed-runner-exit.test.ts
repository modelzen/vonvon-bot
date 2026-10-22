import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ api: vi.fn(), providers: vi.fn(), shutdown: vi.fn(), onboard: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/agent/owned-process', () => ({ closeOwnedProviderProcesses: fixture.providers, unconfirmedProviderPids: () => [] }));
vi.mock('../src/bot/onboarding', () => ({ ensureOnboarded: fixture.onboard, announceEventsWhenLive: vi.fn() }));
vi.mock('../src/bot/bridge', () => ({ startBridge: vi.fn(async () => ({ shutdown: fixture.shutdown })) }));
vi.mock('../src/core/single-instance', () => ({ acquireSingleInstanceLock: () => () => {}, BridgeAlreadyRunningError: class extends Error {} }));
vi.mock('../src/config/bots', () => ({ ensureRegistry: async () => ({ bots: [] }), activeBots: () => [], loadBots: async () => ({ bots: [] }) }));
// Keep restart/exit-code cases independent from the host's Bridge migration owner.
vi.mock('../src/import/bridge/runtime', () => ({
  bridgeImportRuntime: () => ({
    importer: {}, recover: async () => {}, guard: async () => undefined,
    bind() {}, releaseRemoved() {}, shutdown: async () => {}, dispose() {},
  }),
}));
vi.mock('../src/admin/service', () => ({ createAdminService: vi.fn() }));
vi.mock('../src/agent', () => ({ installBackendDep: vi.fn(), uninstallBackendDep: vi.fn() }));
vi.mock('../src/server/http', async original => ({ ...await original<typeof import('../src/server/http')>(), startApi: fixture.api }));

import { observeShutdown, type ShutdownControl } from '../src/host/lifecycle';
import { runRun } from '../src/cli/commands/run';

let control: ShutdownControl;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send: undefined, exitCode: undefined }));
  vi.stubEnv('VONVON_SERVICE', 'launchd');
  control = observeShutdown();
  fixture.onboard.mockResolvedValue({ cfg: { accounts: { app: { id: 'fixture' } } }, secret: 'test' });
});
afterEach(() => { control.dispose(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// s17 reverses #276 here on purpose (v1-plan s17): the replacement starts only after this process exits, so a
// failed cleanup keeps the restart the user asked for (75), and the failure is still reported.
it.each(['supervisor', 'single Bot'] as const)('%s keeps the restart after a drain failure and reports it', async mode => {
  const failure = new Error('drain failed');
  const release = vi.fn(async () => {});
  const stop = vi.spyOn(control, 'requestStop');
  fixture.api.mockImplementation(async () => {
    control.requestRestart(1234);
    return { listen: '127.0.0.1:1234', beginDrain: async () => { throw failure; }, release };
  });
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(control.intent).toBe('restart');
  expect(process.exitCode).toBe(75);
});

it.each(['supervisor', 'single Bot'] as const)('%s keeps the restart after provider cleanup rejects', async mode => {
  fixture.providers.mockRejectedValue(new Error('provider cleanup failed'));
  fixture.api.mockImplementation(async () => {
    control.requestRestart(1234);
    return { listen: '127.0.0.1:1234', beginDrain: async () => {}, release: async () => {} };
  });
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toThrow('Provider cleanup failed');
  expect(process.exitCode).toBe(75);
});

it.each(['supervisor', 'single Bot'] as const)('%s preserves failure semantics when startup fails before any shutdown request', async mode => {
  fixture.api.mockRejectedValue(new Error('startup failed'));
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toThrow('startup failed');
  expect(process.exitCode).toBeUndefined();
});
