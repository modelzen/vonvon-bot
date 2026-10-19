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
  refreshRoles: vi.fn(async () => {}),
  stopRoles: vi.fn(async () => {}),
  lockHeld: false,
  releaseLock: vi.fn(),
  registryClose: vi.fn(async () => {}),
  logFail: vi.fn(),
  reply: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ code: 0 })),
  crashHooks: new Set<() => void>(),
}));

vi.mock('../src/config/app-roles', async original => ({
  ...await original<object>(),
  createAppRoleRefresher: () => ({ refresh: fixture.refreshRoles, stop: fixture.stopRoles }),
}));

vi.mock('../src/host/crash-guard', async original => ({
  ...await original<object>(),
  onCrashSync: (hook: () => void) => {
    fixture.crashHooks.add(hook);
    return () => { fixture.crashHooks.delete(hook); };
  },
}));

vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<object>(),
  createLarkChannel: () => ({
    on: vi.fn(), connect: fixture.connect, disconnect: fixture.disconnect,
    rawClient: { im: { v1: { chatMembers: { isInChat: fixture.membership }, message: { reply: fixture.reply } } } },
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
  ensureOnboarded: async () => ({ cfg, secret: 'fixture', identity: { appId: cfg.accounts.app.id, tenant: cfg.accounts.app.tenant, createdAt: 1 } }),
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
// A connected start serves the page; no real port here.
vi.mock('../src/server/http', () => ({
  startApi: async () => ({ listen: '127.0.0.1:1', beginDrain: async () => {}, release: async () => {}, invalidate() {} }),
}));
vi.mock('../src/core/logger', () => ({
  log: { info() {}, warn() {}, fail: fixture.logFail },
  flushLogs: async () => {},
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
  expect(fixture.crashHooks.size).toBe(0);
  fixture.connect.mockReset();
  fixture.membership.mockReset();
  fixture.refreshRoles.mockReset();
  fixture.stopRoles.mockClear();
  fixture.disconnect.mockClear();
  fixture.registryClose.mockClear();
  fixture.releaseLock.mockClear();
  fixture.logFail.mockClear();
  fixture.reply.mockClear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('registers the bridge crash hook before connecting and removes it after closing', async () => {
  const { startBridge } = await import('../src/bot/bridge');
  const file = await seedDropped();
  const saved = await readFile(file, 'utf8');
  const connect = deferred<void>();
  fixture.connect.mockReturnValue(connect.promise);
  const starting = startBridge({ identity: { appId: cfg.accounts.app.id, tenant: cfg.accounts.app.tenant, createdAt: 1 }, cfg, appSecret: 'fixture', fallbackCwd: '/test', droppedFile: file });
  await vi.waitFor(() => expect(fixture.crashHooks.size).toBe(1), COLD);
  for (const hook of fixture.crashHooks) hook();
  connect.resolve();
  const handle = await starting;
  try {
    expect(fixture.reply).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(saved);
  } finally { await handle.shutdown(); }
  expect(fixture.crashHooks.size).toBe(0);
});

/** The first wait covers runHostRuntime's cold import of the whole bot, which can take more than waitFor's 1 s. */
const COLD = { timeout: 10_000 };

function reasons(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(reasons) : [error];
}

/** A pending group whose membership check is still out when the close starts: an accepted task it waits for. */
async function pendingVerification() {
  const { paths } = await import('../src/config/paths');
  const { pendingGroupsFile } = await import('../src/project/pending-groups');
  const file = pendingGroupsFile(paths.projectsFile);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, groups: [{
    chatId: 'oc_pending', operator: 'owner', addedAt: 1, generation: 'first', state: 'verifying',
  }] }));
  const verification = deferred<{ code: number; data: { is_in_chat: boolean } }>();
  const checking = deferred<void>();
  fixture.membership.mockImplementation(() => { checking.resolve(); return verification.promise; });
  return { file, verification, checking };
}

/** What the last shutdown dropped (s18c), where `daemon run` keeps it for this bot. */
async function seedDropped() {
  const { botPaths } = await import('../src/config/paths');
  const { recordDroppedSync } = await import('../src/bot/restart-dropped');
  const file = botPaths('startup-drain').droppedFile;
  await mkdir(dirname(file), { recursive: true });
  recordDroppedSync(file, [{ chatId: 'oc_dropped', messageId: 'om_dropped', at: 1, replyInThread: true, place: 'topic' }], Date.now());
  return file;
}

it.each([false, true])('keeps host and Bot ownership through accepted startup verification when connection fails, cleanup fails=%s', async cleanupFails => {
  const { paths } = await import('../src/config/paths');
  const { readPendingGroups } = await import('../src/project/pending-groups');
  const { runHostRuntime } = await import('../src/host/bootstrap');
  expect(process.send).toBeUndefined();
  const { file, verification, checking } = await pendingVerification();
  const dropped = await seedDropped();
  const kept = await readFile(dropped, 'utf8');
  const connectError = new Error('fixture connect rejected');
  const cleanupError = new Error('fixture disconnect rejected');
  const roleRefresh = deferred<void>();
  const connecting = deferred<void>();
  const failConnection = deferred<void>();
  const disconnected = deferred<void>();
  fixture.refreshRoles.mockReturnValueOnce(roleRefresh.promise);
  fixture.connect.mockImplementationOnce(async () => {
    connecting.resolve();
    await failConnection.promise;
    throw connectError;
  });
  fixture.disconnect.mockImplementationOnce(async () => {
    disconnected.resolve();
    if (cleanupFails) throw cleanupError;
  });
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
    await checking.promise;
    expect(fixture.membership).toHaveBeenCalledOnce();
    expect(fixture.connect).not.toHaveBeenCalled();
    roleRefresh.resolve();
    await connecting.promise;
    expect(fixture.refreshRoles).toHaveBeenCalledOnce();
    expect(fixture.disconnect).not.toHaveBeenCalled();
    failConnection.resolve();
    await disconnected.promise;
    await vi.waitFor(() => expect(fixture.registryClose).toHaveBeenCalled());
    expect(fixture.connect.mock.invocationCallOrder[0]).toBeLessThan(fixture.disconnect.mock.invocationCallOrder[0]!);
    expect(fixture.disconnect.mock.invocationCallOrder[0]).toBeLessThan(fixture.registryClose.mock.invocationCallOrder[0]!);
    expect(running.state()).toBe('pending');
    expect(fixture.lockHeld).toBe(true);
    expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(true);
    // s18c: the long connection went first; lock and pid file stay while the verification runs.
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  } finally {
    roleRefresh.resolve();
    failConnection.resolve();
    verification.resolve({ code: 0, data: { is_in_chat: true } });
    await running.settled;
  }
  expect(running.state()).toBe('rejected');
  expect(reasons(running.error())).toContain(connectError);
  expect(fixture.stopRoles).toHaveBeenCalledOnce();
  if (cleanupFails) expect(reasons(running.error())).toContain(cleanupError);
  expect((await readPendingGroups(file))[0]).toMatchObject({ state: 'ready', name: 'Research' });
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  expect(fixture.lockHeld).toBe(false);
  expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(false);
  expect(await readFile(file, 'utf8')).toContain('Research');
  // Not connected: nothing was answered, and the file waits for the next start.
  expect(fixture.reply).not.toHaveBeenCalled();
  expect(await readFile(dropped, 'utf8')).toBe(kept);
});

it('answers what the last shutdown dropped once connected, and closes the long connection before the orchestrator (s18c)', async () => {
  const { paths } = await import('../src/config/paths');
  const { runHostRuntime } = await import('../src/host/bootstrap');
  const { verification } = await pendingVerification();
  const dropped = await seedDropped();
  fixture.connect.mockResolvedValue(undefined);
  const stop = deferred<void>();
  const control: ShutdownControl = {
    requested: false,
    waitForRequest: () => stop.promise,
    requestStop() {},
    requestRestart() {},
    completeShutdown: async release => { await release(); },
    dispose() {},
  };
  const running = outcome(runHostRuntime({ bot: 'startup-drain', managed: false, control }));
  try {
    await vi.waitFor(() => expect(existsSync(dropped)).toBe(false), COLD);
    expect(fixture.reply).toHaveBeenCalledWith({ path: { message_id: 'om_dropped' }, data: expect.objectContaining({ reply_in_thread: true, uuid: expect.stringMatching(/^vd-/) }) });
    await vi.waitFor(() => expect(fixture.membership).toHaveBeenCalledOnce());
    stop.resolve();
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    // The orchestrator's close starts by closing its Codex processes: after the disconnect.
    await vi.waitFor(() => expect(fixture.registryClose).toHaveBeenCalled());
    expect(fixture.disconnect.mock.invocationCallOrder[0]).toBeLessThan(fixture.registryClose.mock.invocationCallOrder[0]!);
    await Promise.resolve();
    expect(running.state()).toBe('pending');
    expect(fixture.lockHeld).toBe(true);
    expect(existsSync(join(paths.appDir, 'daemon.pid'))).toBe(true);
  } finally {
    stop.resolve();
    verification.resolve({ code: 0, data: { is_in_chat: true } });
    await running.settled;
  }
  expect(running.state()).toBe('fulfilled');
  expect(fixture.disconnect).toHaveBeenCalledOnce();
  expect(fixture.lockHeld).toBe(false);
});

it('a supervised child still reports a dropped message whose reply settles during the close (s18c)', async () => {
  // A bot child under the supervisor: what it sends over IPC is recorded, and each send's callback is called.
  const sent: unknown[] = [];
  const child = Object.create(process) as NodeJS.Process;
  Object.defineProperties(child, {
    send: { value: (message: unknown, ...rest: unknown[]) => {
      sent.push(message);
      (rest.find(item => typeof item === 'function') as ((error: Error | null) => void) | undefined)?.(null);
      return true;
    } },
    connected: { value: true },
    // Its own listeners: `process.on('message')` must not reach the real process.
    _events: { value: Object.create(null), writable: true },
    _eventsCount: { value: 0, writable: true },
  });
  vi.stubGlobal('process', child);
  const { runHostRuntime } = await import('../src/host/bootstrap');
  const { verification } = await pendingVerification();
  const dropped = await seedDropped();
  fixture.connect.mockResolvedValue(undefined);
  const answered = deferred<unknown>();
  fixture.reply.mockReturnValueOnce(answered.promise);
  const stop = deferred<void>();
  const control: ShutdownControl = {
    requested: false,
    waitForRequest: () => stop.promise,
    requestStop() {},
    requestRestart() {},
    completeShutdown: async release => { await release(); },
    dispose() {},
  };
  const running = outcome(runHostRuntime({ bot: 'startup-drain', managed: false, control }));
  try {
    await vi.waitFor(() => expect(fixture.reply).toHaveBeenCalledOnce(), COLD);
    await vi.waitFor(() => expect(fixture.membership).toHaveBeenCalledOnce());
    stop.resolve();
    // The close has begun, and waits for the verification: the reply's answer comes now.
    await vi.waitFor(() => expect(fixture.disconnect).toHaveBeenCalledOnce());
    answered.resolve({ code: 0 });
    await vi.waitFor(() => expect(existsSync(dropped)).toBe(false));
    expect(running.state()).toBe('pending');
  } finally {
    stop.resolve();
    answered.resolve({ code: 0 });
    verification.resolve({ code: 0, data: { is_in_chat: true } });
    await running.settled;
  }
  expect(sent).toContainEqual({ fcb: 'fcb.diagnostics', event: { kind: 'notReplied', record: expect.objectContaining({ reason: 'restarted', groupId: 'oc_dropped', place: 'topic' }) } });
});
