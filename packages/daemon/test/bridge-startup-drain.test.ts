import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';

const fixture = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(async () => {}),
  membership: vi.fn(),
  lockHeld: false,
  releaseLock: vi.fn(),
  registryClose: vi.fn(async () => {}),
  logFail: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<object>(),
  createLarkChannel: () => ({
    on: vi.fn(), connect: fixture.connect, disconnect: fixture.disconnect,
    rawClient: { im: { v1: { chatMembers: { isInChat: fixture.membership } } } },
    getChatInfo: async () => ({ chatType: 'group', name: 'Research', ownerId: 'owner' }),
  }),
}));
vi.mock('../src/agent', async original => ({
  ...await original<object>(),
  createBackend: () => ({ id: 'codex', capabilities: {}, listModels: async () => [] }),
}));
vi.mock('../src/agent/owned-process', async original => ({
  ...await original<object>(),
  closeOwnedProviderProcesses: fixture.registryClose,
  unconfirmedProviderPids: () => [],
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} },
}));
vi.mock('../src/project/registry', async original => ({
  ...await original<object>(),
  getProjectByChatId: async () => undefined,
}));
vi.mock('../src/bot/onboarding', () => ({
  ensureOnboarded: async () => ({ cfg, secret: 'fixture' }),
  announceEventsWhenLive() {},
}));
vi.mock('../src/core/single-instance', () => ({
  BridgeAlreadyRunningError: class extends Error {},
  acquireSingleInstanceLock: () => {
    if (fixture.lockHeld) throw new Error('Bot lock busy');
    fixture.lockHeld = true;
    return () => { fixture.lockHeld = false; fixture.releaseLock(); };
  },
}));
vi.mock('../src/core/logger', () => ({
  log: { info() {}, warn() {}, fail: fixture.logFail },
  withTrace: (_context: unknown, operation: () => unknown) => operation(),
}));

import type { ShutdownControl } from '../src/host/lifecycle';

const cfg: AppConfig = {
  accounts: { app: { id: 'startup-drain', secret: 'fixture', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function outcome(promise: Promise<unknown>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let error: unknown;
  const settled = promise.then(() => { state = 'fulfilled'; }, reason => { state = 'rejected'; error = reason; });
  return { state: () => state, error: () => error, settled };
}

beforeEach(async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'vonvon-startup-drain-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'home', '.config'));
  vi.stubEnv('VONVON_SERVICE', '');
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex'));
  vi.stubEnv('CODEX_BIN', join(root, 'unavailable-codex'));
  const standaloneProcess = Object.create(process);
  Object.defineProperty(standaloneProcess, 'send', { value: undefined });
  vi.stubGlobal('process', standaloneProcess);
});

afterEach(() => {
  fixture.connect.mockReset();
  fixture.membership.mockReset();
  fixture.disconnect.mockClear();
  fixture.registryClose.mockClear();
  fixture.releaseLock.mockClear();
  fixture.logFail.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function reasons(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}

it.each([false, true])('keeps host and Bot ownership through accepted startup verification when connection fails, cleanup fails=%s', async cleanupFails => {
  const { paths } = await import('../src/config/paths');
  const { pendingGroupsFile, readPendingGroups } = await import('../src/project/pending-groups');
  const { runHostRuntime } = await import('../src/host/bootstrap');
  expect(process.send).toBeUndefined();
  const file = pendingGroupsFile(paths.projectsFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, groups: [{
    chatId: 'oc_pending', operator: 'owner', addedAt: 1, generation: 'first', state: 'verifying',
  }] }));
  const verification = deferred<{ code: number; data: { is_in_chat: boolean } }>();
  fixture.membership.mockReturnValue(verification.promise);
  const connectError = new Error('fixture connect rejected');
  const cleanupError = new Error('fixture disconnect rejected');
  if (cleanupFails) fixture.disconnect.mockImplementationOnce(async () => { throw cleanupError; });
  fixture.connect.mockRejectedValue(connectError);
  const control: ShutdownControl = {
    requested: false,
    waitForRequest: () => new Promise<void>(() => {}),
    requestStop() {},
    requestRestart() {},
    completeShutdown: async release => { await release(); },
    dispose() {},
  };
  const running = outcome(runHostRuntime({ bot: 'startup-drain', managed: false, control }));
  try {
    await vi.waitFor(() => expect(fixture.membership).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(running.state()).toBe('pending');
    expect(fixture.lockHeld).toBe(true);
    expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(true);
    expect(fixture.disconnect).not.toHaveBeenCalled();
  } finally {
    verification.resolve({ code: 0, data: { is_in_chat: true } });
    await running.settled;
  }
  expect(running.state()).toBe('rejected');
  expect(reasons(running.error())).toContain(connectError);
  if (cleanupFails) expect(reasons(running.error())).toContain(cleanupError);
  expect((await readPendingGroups(file))[0]).toMatchObject({ state: 'ready', name: 'Research' });
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  expect(fixture.lockHeld).toBe(false);
  expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(false);
  expect(await readFile(file, 'utf8')).toContain('Research');
});
