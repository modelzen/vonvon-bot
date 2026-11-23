import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { CardActionEvent } from '@larksuiteoapi/node-sdk';
import { createOrchestrator } from '../src/bot/handle-message';
import { DM } from '../src/card/dm-cards';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'recipe-callback-')));
  const isolated = new Proxy({ appDir }, {
    get: (target, key) => key === 'appDir' ? target.appDir : join(appDir, String(key)),
  });
  return { paths: isolated, botPaths: () => isolated };
});
const fake = vi.hoisted(() => ({
  backend: { id: 'codex', listModels: vi.fn(async () => []) },
  update: vi.fn(async (_channel: unknown, _messageId: string, _card: object) => true),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/card/managed', () => ({ updateManagedCard: fake.update, sendManagedCard: vi.fn(async () => ({ messageId: 'fresh' })) }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, run: () => unknown) => run() }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));

const cfg: AppConfig = {
  accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] } },
};
let orchestrator: ReturnType<typeof createOrchestrator> | undefined;
const releases: (() => void)[] = [];
function blocked() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}
function setup(onAction: (evt: CardActionEvent) => Promise<void>) {
  orchestrator = createOrchestrator({} as never, cfg, paths.appDir, undefined, {
    authoring: { onAction, onMessage: async () => false, adminRemoved: async () => {} },
  });
  return orchestrator;
}
function click(action = 'recipe.authoring'): CardActionEvent {
  return { chatId: 'oc_private', messageId: 'om_card', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: action, ref: 'live-ref' } } };
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await orchestrator?.shutdown();
  orchestrator = undefined;
  vi.useRealTimers();
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

it('ACKs the real dispatcher before slow authoring and updates the SDK card once after the interaction closes', async () => {
  const slow = blocked();
  let acknowledged = false;
  let displayed = 'unchecked';
  const sdkUpdate = vi.fn(async () => {
    if (acknowledged) displayed = 'checked';
    return { code: 0 };
  });
  const onAction = vi.fn(async () => { await slow.promise; await sdkUpdate(); });
  const o = setup(onAction);
  const evt = click();
  const callback = o.dispatcher.handle(evt).then(() => { acknowledged = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(acknowledged, 'SDK callback must ACK without waiting for authoring I/O').toBe(true);
  expect(onAction).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onAction).toHaveBeenCalledExactlyOnceWith(evt);
  expect(sdkUpdate).not.toHaveBeenCalled();
  slow.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await callback;
  expect(sdkUpdate).toHaveBeenCalledTimes(1);
  expect(displayed).toBe('checked');
});

it('cancels a settled action when its Bot closes before execution and rejects later events', async () => {
  const onAction = vi.fn(async () => {});
  const o = setup(onAction);
  const callback = o.dispatcher.handle(click());
  await vi.advanceTimersByTimeAsync(0);
  await o.shutdown();
  await callback;
  await vi.advanceTimersByTimeAsync(1_000);
  await o.dispatcher.handle(click());
  expect(onAction).not.toHaveBeenCalled();
});

it('keeps an action that already started in the Bot shutdown drain', async () => {
  const slow = blocked();
  const onAction = vi.fn(async () => slow.promise);
  const o = setup(onAction);
  const callback = o.dispatcher.handle(click());
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onAction).toHaveBeenCalledTimes(1);
  let closed = false;
  const closing = o.shutdown().then(() => { closed = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toBe(false);
  slow.resolve();
  await closing;
  await callback;
  expect(closed).toBe(true);
});

it('preserves immediate console ACK and its deferred card update', async () => {
  const o = setup(vi.fn(async () => {}));
  let acknowledged = false;
  const callback = o.dispatcher.handle(click(DM.newProject)).then(() => { acknowledged = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(acknowledged).toBe(true);
  expect(fake.update).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  await callback;
  expect(fake.update).toHaveBeenCalledTimes(1);
});
