import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'provider-ownership-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/platform/spawn', async original => ({ ...await original<object>(), spawnProcess: transport.spawn }));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => '/fixture/no-provider', resolveCodexBin: () => '/fixture/no-provider',
  codexVersionAsync: async () => 'codex-cli 0.163.0',
}));
const fake = vi.hoisted(() => ({
  project: vi.fn(),
  refreshRoles: vi.fn(async () => {}),
  stopRoles: vi.fn(async () => {}),
  channel: { on: vi.fn((..._args: unknown[]) => {}), connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) },
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({ text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true } })),
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/config/app-roles', async original => ({
  ...await original<object>(),
  createAppRoleRefresher: () => ({ refresh: fake.refreshRoles, stop: fake.stopRoles }),
}));
// F1's profileOf prepares the download folder on the real disk, which fake timers do not wait for.
vi.mock('../src/bot/media', async original => ({ ...await original<object>(), prepareInboundDir: async () => {} }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: (...args: unknown[]) => fake.project(...args),
  // s15c's tier merge reads projects.json from disk before connect; these tests
  // count fake-timer ticks to connect, so keep startup free of real I/O.
  splitTierChats: async () => new Map(),
}));
// Ownership assertions use exact fake-clock ticks; personality file I/O has its own tests.
vi.mock('../src/bot/context-assembly', async original => ({
  ...await original<object>(),
  loadContextSources: async () => ({ place: { kind: 'comment' }, botName: 'fixture', soul: '', role: { identity: '', notes: '', headed: false }, supplement: '', failed: {} }),
  planTurnUpdate: async () => ({ context: { versions: {}, nonce: 'fixture' } }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: workspace, summary: '' }),
  patchSession: async () => undefined,
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.createCard;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced = fake.live;
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = fake.final;
    finalizeCard = fake.final;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
vi.mock('../src/voice/inbound', async original => ({ ...await original<object>(), ingestVoice: fake.voice }));
// The real bridge wires a topic registry on disk: a topic turn reads its title
// before starting (s14), which the fake clock's ticks don't wait for, and the
// writes would land in the real data directory.
vi.mock('../src/bot/topic-registry', async original => ({
  ...await original<object>(),
  createTopicRegistry: () => ({ note: async () => undefined, list: async () => [], get: async () => undefined }),
}));
let createOrchestrator: typeof import('../src/bot/handle-message').createOrchestrator;
import type { AppConfig } from '../src/config/schema';
import { SHUTDOWN_INTERRUPT_GRACE_MS } from '../src/bot/handle-message';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function thread() {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const started = deferred<void>();
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    injectContext: vi.fn(async (_text: string) => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const id = `turn-${turns.push(end)}`;
      started.resolve();
      return {
        turnId: () => id,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          await end.promise;
          yield { type: 'done', turnId: id };
        })(),
      };
    },
  };
  return { t, turns, consumed, started };
}
let orchestrator: ReturnType<typeof createOrchestrator> | undefined;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(policy: 'steer' | 'queue' = 'steer') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner', admins: ['owner'] }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'new-topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, workspace);
  return orchestrator;
}

vi.mock('@larksuiteoapi/node-sdk', async original => ({ ...await original<object>(), createLarkChannel: () => channel() }));

vi.mock('../src/card/managed', async original => ({ ...await original<object>(), sendManagedCard: (...args: unknown[]) => fake.send(...args) }));

function channel() {
  return { ...fake.channel, send: fake.send, rawClient: { im: { v1: {
    message: { get: async () => ({ data: { items: [{ thread_id: 'new-topic' }] } }) },
    messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
  } } } };
}
const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] }, completionReminder: { mode: 'manual' } } };
type GroupState = 'present' | 'missing' | 'permission-denied';
interface Shell {
  child: ChildProcess;
  pid: number | undefined;
  requests: { id: number; method: string }[];
  held: Set<string>;
  state(): GroupState;
  setGroup(next: GroupState): void;
  reply(method: string): void;
  exit(code?: number): void;
  die(code?: number): void;
}
const shells: Shell[] = [];
const endings: Promise<unknown>[] = [];
let ownerModule: typeof import('../src/agent/owned-process');
let kill: MockInstance<typeof process.kill>;
let nextPid = 987654321;
const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
function observe<T>(promise: Promise<T>) {
  const outcome: { status: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { status: 'pending' };
  const settled = promise.then(() => { outcome.status = 'fulfilled'; }, error => { outcome.status = 'rejected'; outcome.error = error; });
  endings.push(settled);
  return outcome;
}
function shell(pid: number | undefined = nextPid++): Shell {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(child, { pid: { value: pid, configurable: true }, stdin: { value: stdin }, stdout: { value: stdout }, stderr: { value: stderr } });
  const requests: { id: number; method: string; params?: Record<string, unknown> }[] = [];
  const held = new Set<string>();
  let state: GroupState = 'present';
  let exited = false;
  const respond = (request: typeof requests[number]) => {
    const params = request.params;
    const result = request.method.startsWith('thread/') ? {
      thread: { id: 'host' }, cwd: params?.cwd,
      runtimeWorkspaceRoots: params?.runtimeWorkspaceRoots, approvalPolicy: params?.approvalPolicy,
      ...(params?.sandbox === 'danger-full-access' ? { sandbox: { type: 'dangerFullAccess' } } : {}),
    } : {};
    stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
  };
  stdin.on('data', data => {
    for (const line of String(data).trim().split('\n')) {
      const request: unknown = JSON.parse(line);
      if (!request || typeof request !== 'object' || !('id' in request) || typeof request.id !== 'number' || !('method' in request) || typeof request.method !== 'string') continue;
      const rpc = { id: request.id, method: request.method, params: 'params' in request ? request.params as Record<string, unknown> : undefined };
      requests.push(rpc);
      if (!held.has(rpc.method)) queueMicrotask(() => respond(rpc));
    }
  });
  const exit = (code = 0) => { if (!exited) { exited = true; child.emit('exit', code, null); child.emit('close', code, null); } };
  const fixture = { child, pid, requests, held, state: () => state,
    setGroup(next: GroupState) { state = next; },
    reply(method: string) { held.delete(method); for (const request of requests.filter(r => r.method === method)) respond(request); },
    exit,
    die(code = 0) { state = 'missing'; exit(code); },
  };
  shells.push(fixture);
  return fixture;
}
function born(fixture = shell()) {
  transport.spawn.mockReturnValueOnce(fixture.child);
  const owner = new ownerModule.OwnedProviderProcess('/fixture/no-provider', [], {});
  return { fixture, owner };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  orchestrator = undefined;
  shells.length = 0;
  nextPid = 987654321;
  endings.length = 0;
  transport.spawn.mockReset().mockImplementation(() => { throw new Error('Unexpected fixture spawn'); });
  fake.project.mockReset().mockImplementation(async () => ({ name: 'test', chatId: 'chat', cwd: workspace, groupMode: 'single' }));
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
  fake.send.mockReset().mockResolvedValue({});
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.final.mockReset().mockResolvedValue(true);
  kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const fixture = shells.find(candidate => candidate.pid !== undefined && -candidate.pid === pid);
    if (!fixture) throw new Error(`Unowned signal target ${pid}`);
    if (fixture.state() === 'missing') throw Object.assign(new Error('no group'), { code: 'ESRCH' });
    if (fixture.state() === 'permission-denied' && signal === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return true;
  });
  ownerModule = await import('../src/agent/owned-process');
  ({ createOrchestrator } = await import('../src/bot/handle-message'));
});
afterEach(async () => {
  for (const fixture of shells) fixture.die();
  if (orchestrator) observe(orchestrator.shutdown());
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(endings);
  for (const [pid] of kill.mock.calls) expect(shells.some(fixture => fixture.pid !== undefined && -fixture.pid === pid)).toBe(true);
  vi.clearAllTimers();
  Object.defineProperty(process, 'platform', nativePlatform);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('explicit POSIX process-group model', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin' }); });

it('retains close at 6 and 120 seconds until group death', async () => {
  const { owner, fixture } = born();
  const closing = owner.close();
  const result = observe(closing);
  await vi.advanceTimersByTimeAsync(6000);
  expect.soft(result.status).toBe('pending');
  await vi.advanceTimersByTimeAsync(114000);
  expect.soft(result.status).toBe('pending');
  expect.soft(kill.mock.calls.filter(call => call[1] === 'SIGKILL').length).toBeGreaterThanOrEqual(115);
  expect(owner.close()).toBe(closing);
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('rejected');
  expect(result.error).toBeInstanceOf(ownerModule.ProviderProcessCleanupError);
  expect(owner.close()).toBe(closing);
});

it('registry retains uncertainty, caches its exact Promise, and seals new births synchronously', async () => {
  const { owner, fixture } = born();
  const closing = owner.close();
  observe(closing);
  const registry = ownerModule.closeOwnedProviderProcesses();
  const result = observe(registry);
  expect(ownerModule.closeOwnedProviderProcesses()).toBe(registry);
  expect(() => new ownerModule.OwnedProviderProcess('/fixture/late', [], {})).toThrow();
  expect(transport.spawn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120000);
  expect(result.status).toBe('pending');
  expect(ownerModule.unconfirmedProviderPids()).toEqual([fixture.pid]);
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('rejected');
  expect(ownerModule.unconfirmedProviderPids()).toEqual([]);
  expect(ownerModule.closeOwnedProviderProcesses()).toBe(registry);
});

it('postbirth error neither settles exited nor proves death and becomes a cleanup failure after death', async () => {
  const { owner, fixture } = born();
  const exit = observe(owner.exited);
  fixture.child.emit('error', new Error('postbirth pipe error'));
  const closing = observe(owner.close());
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(exit.status).toBe('pending');
  expect.soft(closing.status).toBe('pending');
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect(exit.status).toBe('fulfilled');
  expect(closing.status).toBe('rejected');
});

it('birthless spawn error rejects exited promptly without signals or unhandled rejection and caches close', async () => {
  const fixture = shell();
  Object.defineProperty(fixture.child, 'pid', { value: undefined });
  transport.spawn.mockReturnValueOnce(fixture.child);
  const owner = new ownerModule.OwnedProviderProcess('/fixture/missing', [], {});
  const failure = new Error('spawn ENOENT');
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    fixture.child.emit('error', failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(unhandled).not.toHaveBeenCalled();
    const exit = observe(owner.exited);
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(exit.status).toBe('rejected');
    expect.soft(exit.error).toBe(failure);
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    expect(kill).not.toHaveBeenCalled();
    const registry = ownerModule.closeOwnedProviderProcesses();
    expect(ownerModule.closeOwnedProviderProcesses()).toBe(registry);
    await registry;
    expect(ownerModule.unconfirmedProviderPids()).toEqual([]);
  } finally { process.off('unhandledRejection', unhandled); }
});

it('observed group ESRCH latches before delayed direct exit and prevents later signals after numeric reuse', async () => {
  const { owner, fixture } = born();
  fixture.setGroup('missing');
  const result = observe(owner.close());
  await vi.advanceTimersByTimeAsync(1000);
  expect.soft(result.status).toBe('pending');
  const callsAtDisappearance = kill.mock.calls.length;
  fixture.setGroup('present');
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  fixture.exit();
  await vi.advanceTimersByTimeAsync(1000);
  expect(kill).toHaveBeenCalledTimes(callsAtDisappearance);
  expect(result.status).toBe('fulfilled');
});

it('EPERM probing a group counts as existing while graceful death settles successfully', async () => {
  const { owner, fixture } = born();
  fixture.setGroup('permission-denied');
  const result = observe(owner.close());
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('pending');
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('fulfilled');
});

it('nonzero direct exit propagates a cleanup failure after confirmed death', async () => {
  const { owner, fixture } = born();
  const result = observe(owner.close());
  fixture.die(17);
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('rejected');
  expect(result.error).toBeInstanceOf(ownerModule.ProviderProcessCleanupError);
});

it('real AppServerClient close retains its exact Promise and forced-death failure', async () => {
  const fixture = shell();
  transport.spawn.mockReturnValueOnce(fixture.child);
  const { AppServerClient } = await import('../src/agent/codex-appserver/app-server-client');
  const client = new AppServerClient({ bin: '/fixture/no-provider', cwd: workspace });
  const connecting = client.connect();
  await vi.advanceTimersByTimeAsync(0);
  await connecting;
  const closing = client.close();
  const result = observe(closing);
  expect(client.close()).toBe(closing);
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect(result.status).toBe('rejected');
  expect(result.error).toBeInstanceOf(ownerModule.ProviderProcessCleanupError);
});

it('connecting an already closed client rejects without spawning', async () => {
  const { AppServerClient } = await import('../src/agent/codex-appserver/app-server-client');
  const client = new AppServerClient({ bin: '/fixture/no-provider', cwd: workspace });
  await client.close();
  const result = observe(client.connect());
  await vi.advanceTimersByTimeAsync(0);
  expect(result.status).toBe('rejected');
  expect(transport.spawn).not.toHaveBeenCalled();
});

it.each(['utility', 'warm'] as const)('shutdown closes in-flight %s creation before initialization and prevents late publication or refill', async kind => {
  const fixture = shell();
  fixture.held.add('initialize');
  transport.spawn.mockReturnValueOnce(fixture.child);
  const pool = await import('../src/agent/codex-appserver/client-pool');
  const creating = kind === 'utility' ? pool.utilityRequest('model/list') : pool.refillWarmPool();
  observe(creating);
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.requests.map(request => request.method)).toEqual(['initialize']);
  const closing = pool.shutdownResidentClients();
  const result = observe(closing);
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(kill).toHaveBeenCalledWith(-fixture.pid!, 'SIGTERM');
  fixture.reply('initialize');
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  expect.soft(pool.takeWarmClient('/fixture/no-provider')).toBeNull();
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect.soft(result.status).toBe('rejected');
  await pool.refillWarmPool();
  expect(transport.spawn).toHaveBeenCalledTimes(1);
});

async function activeOrchestrator() {
  const { owner, fixture } = born();
  const run = thread();
  run.t.close.mockImplementation(() => owner.close());
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup();
  await o.onMessage(message('first'));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.consumed).toHaveLength(1);
  run.turns[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  return { o, run, fixture };
}

it('real orchestrator shutdown caches one Promise and propagates provider failure only after death', async () => {
  const { o, fixture } = await activeOrchestrator();
  const first = o.shutdown();
  const result = observe(first);
  const second = o.shutdown();
  observe(second);
  expect.soft(second).toBe(first);
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(first).rejects.toThrow('Bridge orchestrator cleanup failed');
  expect.soft(result.status).toBe('rejected');
  expect(o.shutdown()).toBe(first);
});

it('idle-reaped provider remains owned after removal from the real orchestrator session map', async () => {
  const { o, run, fixture } = await activeOrchestrator();
  await vi.advanceTimersByTimeAsync(50 * 60000);
  expect(run.t.close).toHaveBeenCalled();
  const closing = o.shutdown();
  const result = observe(closing);
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(closing).rejects.toThrow('Bridge orchestrator cleanup failed');
  expect(result.status).toBe('rejected');
});

it('real BridgeHandle shares shutdown and retains provider failure through transport teardown', async () => {
  const { owner, fixture } = born();
  const run = thread();
  run.t.close.mockImplementation(() => owner.close());
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const { startBridge } = await import('../src/bot/bridge');
  const bridge = await startBridge({ identity: { appId: cfg.accounts.app.id, tenant: cfg.accounts.app.tenant, createdAt: 1 }, cfg, appSecret: 'fixture', fallbackCwd: workspace });
  const registration = fake.channel.on.mock.calls.find(call => call[0] === 'message');
  if (!registration || typeof registration[1] !== 'function') throw new Error('Message handler absent');
  await registration[1](message('first'));
  await vi.advanceTimersByTimeAsync(0);
  run.turns[0]!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  const closing = bridge.shutdown();
  const result = observe(closing);
  const concurrent = bridge.shutdown();
  observe(concurrent);
  expect.soft(concurrent).toBe(closing);
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(result.status).toBe('pending');
  // s18c: the long connection goes first; the close still waits for the provider.
  expect.soft(fake.channel.disconnect).toHaveBeenCalledOnce();
  fixture.die();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(closing).rejects.toThrow('Bridge cleanup failed');
  expect.soft(result.status).toBe('rejected');
  expect.soft(fake.channel.disconnect).toHaveBeenCalledOnce();
  expect(bridge.shutdown()).toBe(closing);
});

it('real orchestrator shutdown awaits an accepted message continuation before its first run is tracked', async () => {
  const project = deferred<{ name: string; chatId: string; cwd: string; groupMode: 'single' }>();
  fake.project.mockReturnValueOnce(project.promise);
  const sent = deferred<object>();
  fake.send.mockReturnValueOnce(sent.promise);
  const o = setup();
  const accepted = o.onMessage(message('/help'));
  observe(accepted);
  await vi.advanceTimersByTimeAsync(0);
  const shutdown = o.shutdown();
  const closing = observe(shutdown);
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(closing.status).toBe('pending');
  project.resolve({ name: 'test', chatId: 'chat', cwd: workspace, groupMode: 'single' });
  await vi.advanceTimersByTimeAsync(0);
  expect.soft(fake.send).toHaveBeenCalledOnce();
  expect.soft(closing.status).toBe('pending');
  sent.resolve({});
  await accepted;
  await vi.advanceTimersByTimeAsync(0);
  await expect(shutdown).resolves.toBeUndefined();
  expect(closing.status).toBe('fulfilled');
});

it.each(['clean', 'failed'] as const)('startup failure waits for the accepted run and %s provider cleanup', async cleanup => {
  const { owner, fixture } = born();
  const run = thread();
  const closingProvider = deferred<void>();
  run.t.close.mockImplementation(() => { closingProvider.resolve(); return owner.close(); });
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const startupError = new Error('channel connect failed after accepting a run');
  const accepted = deferred<void>();
  fake.channel.connect.mockImplementationOnce(async () => {
    const registration = fake.channel.on.mock.calls.find(call => call[0] === 'message');
    if (!registration || typeof registration[1] !== 'function') throw new Error('Message handler absent');
    await registration[1](message('first'));
    await accepted.promise;
    throw startupError;
  });
  const { startBridge } = await import('../src/bot/bridge');
  const startup = startBridge({ identity: { appId: cfg.accounts.app.id, tenant: cfg.accounts.app.tenant, createdAt: 1 }, cfg, appSecret: 'fixture', fallbackCwd: workspace });
  const starting = observe(startup);
  await vi.advanceTimersByTimeAsync(0);
  await run.started.promise;
  expect(fake.refreshRoles).toHaveBeenCalledOnce();
  expect(run.consumed).toHaveLength(1);
  expect(transport.spawn).toHaveBeenCalledOnce();
  expect(fixture.state()).toBe('present');
  accepted.resolve();
  await vi.advanceTimersByTimeAsync(0);
  // owner 2026-11-02: the run is interrupted at once and its provider closed once the grace is over.
  expect(run.t.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(SHUTDOWN_INTERRUPT_GRACE_MS);
  await closingProvider.promise;
  await vi.advanceTimersByTimeAsync(0);
  expect(run.t.close).toHaveBeenCalledOnce();
  expect(kill).toHaveBeenCalledWith(-fixture.pid!, 'SIGTERM');
  const providerClosing = observe(owner.close());
  const registryClosing = observe(ownerModule.closeOwnedProviderProcesses());
  expect(starting.status).toBe('pending');
  // s18c: disconnected as the cleanup began, while it still waits for the accepted run and the provider.
  expect(fake.channel.disconnect).toHaveBeenCalledOnce();

  if (cleanup === 'clean') {
    fixture.die();
    await vi.advanceTimersByTimeAsync(1000);
    expect(providerClosing.status).toBe('fulfilled');
    expect(registryClosing.status).toBe('fulfilled');
    expect(starting.status).toBe('pending');
    expect(fake.channel.disconnect).toHaveBeenCalledOnce();
    run.turns[0]!.resolve();
  } else {
    run.turns[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.final).toHaveBeenCalled();
    expect(starting.status).toBe('pending');
    expect(providerClosing.status).toBe('pending');
    expect(registryClosing.status).toBe('pending');
    expect(fake.channel.disconnect).toHaveBeenCalledOnce();
    fixture.die(17);
  }
  await vi.advanceTimersByTimeAsync(1000);
  await expect(startup).rejects.toThrow(cleanup === 'clean' ? startupError : 'Bridge startup and cleanup failed');
  expect(starting.status).toBe('rejected');
  expect(ownerModule.unconfirmedProviderPids()).toEqual([]);
  expect(fake.stopRoles).toHaveBeenCalledOnce();
  expect(fake.channel.disconnect).toHaveBeenCalledOnce();
  if (cleanup === 'clean') {
    expect(starting.error).toBe(startupError);
  } else {
    expect(providerClosing.status).toBe('rejected');
    expect(providerClosing.error).toBeInstanceOf(ownerModule.ProviderProcessCleanupError);
    expect(registryClosing.status).toBe('rejected');
    if (!(starting.error instanceof AggregateError)) throw new Error('Startup cleanup failure was not aggregated');
    expect(starting.error.errors).toHaveLength(2);
    expect(starting.error.errors[0]).toBe(startupError);
    const cleanupError: unknown = starting.error.errors[1];
    if (!(cleanupError instanceof AggregateError)) throw new Error('Orchestrator cleanup failure was not retained');
    expect(cleanupError.errors).toEqual([registryClosing.error, providerClosing.error]);
    expect(cleanupError.errors[0]).toBe(registryClosing.error);
    expect(cleanupError.errors[1]).toBe(providerClosing.error);
  }
});


it('actual backend thread close and resident warm client remain pending past grace and propagate death failure', async () => {
  const warm = shell();
  const session = shell();
  transport.spawn.mockReturnValueOnce(warm.child).mockReturnValueOnce(session.child);
  const { CodexAppServerBackend } = await import('../src/agent/codex-appserver/backend');
  const pool = await import('../src/agent/codex-appserver/client-pool');
  const pendingThread = new CodexAppServerBackend().resumeThread({ cwd: workspace, sessionId: 'host' });
  await vi.advanceTimersByTimeAsync(0);
  const actualThread = await pendingThread;
  const threadResult = observe(actualThread.close());
  const residentResult = observe(pool.shutdownResidentClients());
  await vi.advanceTimersByTimeAsync(120000);
  expect.soft(threadResult.status).toBe('pending');
  expect.soft(residentResult.status).toBe('pending');
  warm.die();
  session.die();
  await vi.advanceTimersByTimeAsync(1000);
  expect.soft(threadResult.status).toBe('rejected');
  expect(residentResult.status).toBe('rejected');
});

});
