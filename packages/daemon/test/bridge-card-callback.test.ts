import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event?: unknown) => unknown>(),
  write: vi.fn(async (_appId: string, _at: number) => {}),
  dispatch: vi.fn(async (_event: unknown) => {}),
  connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  shutdown: vi.fn(async () => {}), logFail: vi.fn(),
}));
vi.mock('../src/bot/bridge-channel', () => ({ createBridgeChannel: () => ({
  on: (name: string, handler: (event?: unknown) => unknown) => { fixture.handlers.set(name, handler); },
  connect: fixture.connect, disconnect: fixture.disconnect,
}) }));
vi.mock('../src/config/card-callback', async original => {
  const actual = await original<typeof import('../src/config/card-callback')>();
  return { ...actual, createCardCallbackRecorder: (appId: string, options: Parameters<typeof actual.createCardCallbackRecorder>[1]) =>
    actual.createCardCallbackRecorder(appId, { ...options, now: () => 1_790_000_000_000, write: fixture.write }) };
});
vi.mock('../src/config/app-roles', () => ({
  APP_ROLE_CACHE_MS: 60_000, getAppRoleSnapshot: () => ({ fetchedAt: Date.now() }),
  createAppRoleRefresher: () => ({ refresh: async () => {}, stop: async () => {} }),
}));
vi.mock('../src/admin/groups', () => ({ createGroupExecutor: () => async () => ({ groups: [] }) }));
vi.mock('../src/agent/entry/command-tools', () => ({ createCommandTools: () => ({}) }));
vi.mock('../src/agent/entry/registry', () => ({ createAgentEntries: () => ({}) }));
vi.mock('../src/bot/memory-writer', () => ({ createMemoryWriter: () => ({}) }));
vi.mock('../src/project/registry', () => ({ listProjects: async () => [], splitTierChats: async () => new Map(), setTierMergePending: async () => {} }));
vi.mock('../src/bot/topic-registry', () => ({ createTopicRegistry: () => ({}) }));
vi.mock('../src/bot/session-store', () => ({ adoptAdminSessions: async () => [] }));
vi.mock('../src/config/paths', () => ({ paths: { topicsDir: '/fixture/topics' } }));
vi.mock('../src/host/crash-guard', () => ({ onCrashSync: () => () => {} }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, fail: fixture.logFail } }));
vi.mock('../src/bot/handle-message', () => ({ createOrchestrator: () => ({
  initialize: async () => {}, dispatcher: { handle: fixture.dispatch }, shutdown: fixture.shutdown,
  replyDropped() {}, saveDroppedSync() {}, settings: {}, scheduler: { start: async () => {}, stop() {}, drain: async () => {} },
}) }));

import { startBridge } from '../src/bot/bridge';
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'test', tenant: 'feishu' } } };
const start = () => startBridge({ identity: { appId: 'cli_fixture', tenant: 'feishu', createdAt: 1 }, cfg, appSecret: 'test', fallbackCwd: '/fixture' });
const event = { action: { value: { a: 'continue' } }, messageId: 'om_fixture', chatId: 'oc_fixture' };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let handle: Awaited<ReturnType<typeof start>> | undefined;
beforeEach(() => {
  fixture.handlers.clear();
  fixture.write.mockReset().mockResolvedValue(undefined);
  fixture.dispatch.mockReset().mockResolvedValue(undefined);
  fixture.connect.mockClear(); fixture.disconnect.mockReset().mockResolvedValue(undefined);
  fixture.shutdown.mockClear(); fixture.logFail.mockClear();
});
afterEach(async () => { await handle?.shutdown(); handle = undefined; });

it('records only real incoming cardAction events; connection and other events do not establish proof', async () => {
  handle = await start();
  fixture.handlers.get('reconnected')?.();
  fixture.handlers.get('reconnecting')?.();
  expect(fixture.write).not.toHaveBeenCalled();
  await fixture.handlers.get('cardAction')!(event);
  await handle.shutdown();
  expect(fixture.write).toHaveBeenCalledExactlyOnceWith('cli_fixture', 1_790_000_000_000);
  expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(event);
});

it('answers business callbacks while evidence is pending and waits for the evidence on shutdown', async () => {
  const saving = deferred(); fixture.write.mockReturnValue(saving.promise);
  handle = await start();
  await fixture.handlers.get('cardAction')!(event);
  await fixture.handlers.get('cardAction')!(event);
  expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  expect(fixture.write).toHaveBeenCalledOnce();
  let closed = false;
  const closing = handle.shutdown().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  expect(closed).toBe(false);
  saving.resolve(); await closing;
  expect(closed).toBe(true);
});

it('keeps a storage failure out of card actions and retries on the next receipt', async () => {
  fixture.write.mockRejectedValueOnce(new Error('disk unavailable'));
  handle = await start();
  await expect(Promise.resolve(fixture.handlers.get('cardAction')!(event))).resolves.toBeUndefined();
  await vi.waitFor(() => expect(fixture.logFail).toHaveBeenCalledOnce());
  await fixture.handlers.get('cardAction')!(event);
  await handle.shutdown();
  expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  expect(fixture.write).toHaveBeenCalledTimes(2);
});

it('still establishes receipt evidence when the business action rejects', async () => {
  fixture.dispatch.mockRejectedValueOnce(new Error('action failed'));
  handle = await start();
  await expect(Promise.resolve(fixture.handlers.get('cardAction')!(event))).rejects.toThrow('action failed');
  await handle.shutdown();
  expect(fixture.write).toHaveBeenCalledOnce();
});

it('waits for evidence even when disconnect fails', async () => {
  const saving = deferred(); fixture.write.mockReturnValue(saving.promise);
  fixture.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
  handle = await start();
  await fixture.handlers.get('cardAction')!(event);
  let closed = false;
  const closing = handle.shutdown().catch(error => { closed = true; return error; });
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(false);
  saving.resolve();
  expect(await closing).toBeInstanceOf(AggregateError);
  expect(closed).toBe(true);
  handle = undefined;
});

it('also drains a callback received while the transport is disconnecting', async () => {
  const disconnect = deferred(), saving = deferred();
  fixture.disconnect.mockReturnValue(disconnect.promise);
  fixture.write.mockReturnValue(saving.promise);
  handle = await start();
  const closing = handle.shutdown();
  await fixture.handlers.get('cardAction')!(event);
  disconnect.resolve();
  let closed = false; void closing.then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(false);
  saving.resolve(); await closing;
  expect(fixture.write).toHaveBeenCalledOnce();
});
