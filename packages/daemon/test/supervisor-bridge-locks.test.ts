import {afterEach, expect, it, vi} from 'vitest';
const fixture = vi.hoisted(() => ({registryUnreadable: false, guard: vi.fn(async (_id: string) => undefined), dispose: vi.fn(), start: vi.fn(async () => ({port: 1, listen: '127.0.0.1:1', invalidate() {}, beginDrain: async () => {}, release: async () => {}, close: async () => {}}))}));
vi.mock('../src/import/bridge/runtime', () => ({bridgeImportRuntime: () => ({importer: {}, guard: fixture.guard, bind() {}, releaseRemoved() {}, shutdown: async () => {}, dispose: fixture.dispose})}));
vi.mock('../src/config/bots', () => ({loadBots: async () => {if (fixture.registryUnreadable) throw new Error('unreadable registry'); return {version: 1, bots: [{appId: 'disabled_imported', name: 'disabled', tenant: 'feishu', createdAt: 1, active: false}]};}}));
vi.mock('../src/admin/service', () => ({createAdminService: () => ({})}));
vi.mock('../src/server/http', () => ({startApi: fixture.start}));
vi.mock('../src/agent/owned-process', () => ({closeOwnedProviderProcesses: async () => {}, unconfirmedProviderPids: () => [], registeredProviderPids: () => []}));
vi.mock('../src/core/logger', () => ({log: {info() {}, warn() {}, fail() {}}}));
vi.mock('../src/agent', () => ({installBackendDep() {}, uninstallBackendDep() {}}));
vi.mock('../src/platform/spawn', () => ({spawnProcess: vi.fn(() => {throw new Error('Disabled bot must never spawn');})}));
import {runSupervisor} from '../src/bot/supervisor';
import {spawnProcess} from '../src/platform/spawn';
it('guards disabled registry Bots on host restart and in periodic checks even with no active children', async () => {
  let stop = () => {};
  const requested = new Promise<void>(resolve => {stop = resolve;});
  const running = runSupervisor([], {timing: {lockSlowMs: 10}, control: {requested: false, waitForRequest: () => requested, requestStop() {}, requestRestart() {}, completeShutdown: async release => release(), dispose() {}}});
  try {
    await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled());
    expect(fixture.guard).toHaveBeenCalledWith('disabled_imported');
    const count = fixture.guard.mock.calls.length;
    await vi.waitFor(() => expect(fixture.guard.mock.calls.length).toBeGreaterThan(count));
    expect(spawnProcess).not.toHaveBeenCalled();
  } finally {stop(); await running;}
  expect(fixture.dispose).toHaveBeenCalledOnce();
});

afterEach(() => {fixture.registryUnreadable = false; vi.clearAllMocks();});
it('keeps the paused diagnostic API available when the registry is unreadable', async () => {
  fixture.registryUnreadable = true;
  let stop = () => {}; const requested = new Promise<void>(resolve => {stop = resolve;});
  const running = runSupervisor([], {paused: true, registryUnreadable: true, control: {requested: false, waitForRequest: () => requested, requestStop() {}, requestRestart() {}, completeShutdown: async release => release(), dispose() {}}});
  try {await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled()); expect(spawnProcess).not.toHaveBeenCalled();}
  finally {stop(); await running;}
});
