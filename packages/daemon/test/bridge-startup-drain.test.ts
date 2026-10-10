import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';

const fixture = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(async () => {}),
  membership: vi.fn(),
  lockHeld: false,
  releaseLock: vi.fn(),
  cliShutdown: vi.fn(async () => {}),
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
vi.mock('../src/agent/codex-appserver/owned-process', async original => ({
  ...await original<object>(),
  closeOwnedCodexProcesses: fixture.registryClose,
  unconfirmedCodexPids: () => [],
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} },
}));
vi.mock('../src/project/registry', async original => ({
  ...await original<object>(),
  getProjectByChatId: async () => undefined,
}));
vi.mock('../src/cli-bridge', () => ({
  createCliBridgeService: () => ({ shutdown: fixture.cliShutdown, register() {} }),
  shouldStartCliBridge: () => false,
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
vi.mock('../src/service/win-startup', () => ({ recordServicePid() {}, clearServicePid() {} }));

import { paths } from '../src/config/paths';
import { pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { runHostRuntime } from '../src/host/bootstrap';
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

afterEach(() => {
  fixture.connect.mockReset();
  fixture.membership.mockReset();
  fixture.disconnect.mockClear();
  fixture.cliShutdown.mockReset();
  fixture.registryClose.mockClear();
  fixture.releaseLock.mockClear();
  fixture.logFail.mockClear();
});

function reasons(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}

it.each([false, true])('keeps host and Bot ownership through accepted startup verification when connection fails, cleanup fails=%s', async cleanupFails => {
  const file = pendingGroupsFile(paths.projectsFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, groups: [{
    chatId: 'oc_pending', operator: 'owner', addedAt: 1, generation: 'first', state: 'verifying',
  }] }));
  const verification = deferred<{ code: number; data: { is_in_chat: boolean } }>();
  fixture.membership.mockReturnValue(verification.promise);
  const connectError = new Error('fixture connect rejected');
  const cleanupError = new Error('fixture CLI cleanup rejected');
  fixture.cliShutdown.mockImplementation(async () => {
    if (cleanupFails) throw cleanupError;
  });
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
  expect(fixture.cliShutdown).toHaveBeenCalledOnce();
  expect(fixture.lockHeld).toBe(false);
  expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(false);
  expect(await readFile(file, 'utf8')).toContain('Research');
});
