import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ api: vi.fn(), providers: vi.fn(), shutdown: vi.fn(), onboard: vi.fn() }));
vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/agent/codex-appserver/owned-process', () => ({ closeOwnedCodexProcesses: fixture.providers, unconfirmedCodexPids: () => [] }));
vi.mock('../src/bot/onboarding', () => ({ ensureOnboarded: fixture.onboard, announceEventsWhenLive: vi.fn() }));
vi.mock('../src/bot/bridge', () => ({ startBridge: vi.fn(async () => ({ shutdown: fixture.shutdown })) }));
vi.mock('../src/core/single-instance', () => ({ acquireSingleInstanceLock: () => () => {}, BridgeAlreadyRunningError: class extends Error {} }));
vi.mock('../src/config/bots', () => ({ ensureRegistry: async () => ({ bots: [] }), activeBots: () => [] }));
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

it.each(['supervisor', 'single Bot'] as const)('%s cancels restart after a drain failure and reports it with exit zero', async mode => {
  const failure = new Error('drain failed');
  const release = vi.fn(async () => {});
  fixture.api.mockImplementation(async () => {
    control.requestRestart(1234);
    return { listen: '127.0.0.1:1234', beginDrain: async () => { throw failure; }, release };
  });
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toBe(failure);
  expect(release).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(0);
});

it.each(['supervisor', 'single Bot'] as const)('%s cancels restart after provider cleanup rejects', async mode => {
  fixture.providers.mockRejectedValue(new Error('provider cleanup failed'));
  fixture.api.mockImplementation(async () => {
    control.requestRestart(1234);
    return { listen: '127.0.0.1:1234', beginDrain: async () => {}, release: async () => {} };
  });
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toThrow('Provider cleanup failed');
  expect(process.exitCode).toBe(0);
});

it.each(['supervisor', 'single Bot'] as const)('%s preserves failure semantics when startup fails before any shutdown request', async mode => {
  fixture.api.mockRejectedValue(new Error('startup failed'));
  await expect(runRun(mode === 'single Bot' ? 'fixture' : undefined, { control })).rejects.toThrow('startup failed');
  expect(process.exitCode).toBeUndefined();
});
