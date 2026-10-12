import { ChildProcess } from 'node:child_process';
import { OwnedCodexProcess, CodexProcessCleanupError } from '../src/agent/codex-appserver/owned-process';
import { spawnProcess } from '../src/platform/spawn';
vi.mock('../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
import { UnsentRequestError } from '../src/agent/types';
import { JsonRpcError } from '../src/agent/codex-appserver/app-server-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  groupMode: 'single' as 'single' | 'multi',
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({ text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true } })),
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', groupMode: fake.groupMode }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '' }),
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
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

function voiceResult(text: string, messageId = 'voice') {
  return { text, voice: { messageId, text, transcribed: true } };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function thread() {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const progress: { queue: AgentEvent[]; wake?: () => void }[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const live: { queue: AgentEvent[]; wake?: () => void } = { queue: [] };
      progress.push(live);
      const id = `turn-${turns.push(end)}`;
      return {
        turnId: () => id, // deliberately keep backend ID stale during final-card I/O
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          let done = false;
          let failure: { error: unknown } | undefined;
          void end.promise.then(() => { done = true; live.wake?.(); }, error => { failure = { error }; done = true; live.wake?.(); });
          while (!done || live.queue.length) {
            const event = live.queue.shift();
            if (event) yield event;
            else await new Promise<void>(resolve => { live.wake = resolve; });
          }
          if (failure) throw failure.error;
          yield { type: 'done', turnId: id };
        })(),
      };
    },
  };
  return { t, turns, consumed, emit(event: AgentEvent, index = 0) {
    progress[index]!.queue.push(event); progress[index]!.wake?.();
  } };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(policy: 'steer' | 'queue' = 'steer') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'new-topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.groupMode = 'single';
  fake.voice.mockReset().mockImplementation(async (_channel, msg) => voiceResult('语音正文', msg.messageId));
  fake.backend.capabilities.steer = true;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  await orchestrator?.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function ownedFixture() {
  vi.useFakeTimers();
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 987654321 });
  vi.mocked(spawnProcess).mockReturnValue(child);
  let alive = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, _signal) => {
    expect(pid).toBe(-987654321);
    if (!alive) throw Object.assign(new Error('no such group'), { code: 'ESRCH' });
    return true;
  });
  const owner = new OwnedCodexProcess('fixture-never-spawned', [], {});
  return { owner, kill, isAlive: () => alive, die() {
    alive = false;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  } };
}

it('diagnostic: real owned-process rejects at 6 seconds while its mocked group remains alive', async () => {
  const f = ownedFixture();
  const closing = f.owner.close();
  const rejection = expect(closing).rejects.toBeInstanceOf(CodexProcessCleanupError);
  await vi.advanceTimersByTimeAsync(6000);
  await rejection;
  expect(f.isAlive()).toBe(true);
  expect(f.kill).toHaveBeenCalledWith(-987654321, 'SIGTERM');
  expect(f.kill).toHaveBeenCalledWith(-987654321, 'SIGKILL');
  expect(f.owner.close()).toBe(closing);
  f.die();
  expect(f.owner.close()).toBe(closing);
  await expect(f.owner.close()).rejects.toBeInstanceOf(CodexProcessCleanupError);
});

it('RED: retry after cleanup rejection stays pending until actual owned-group death', async () => {
  const f = ownedFixture();
  const first = f.owner.close();
  void first.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(6000);
  let state = 'pending';
  const retry = f.owner.close();
  void retry.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  await vi.advanceTimersByTimeAsync(0);
  try {
    expect(f.isAlive()).toBe(true);
    expect(state).toBe('pending');
    f.die();
    await vi.advanceTimersByTimeAsync(1000);
    await retry;
  } finally { f.die(); }
});

it('RED: real orchestrator shutdown retains an inline provider whose group survives forced termination', async () => {
  const f = ownedFixture();
  const run = thread();
  run.t.close.mockImplementation(() => f.owner.close());
  fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup();
  await o.onMessage(message('first'));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.consumed).toHaveLength(1);
  const turn = run.turns[0];
  if (!turn) throw new Error('fixture did not start its turn');
  turn.resolve();
  await vi.advanceTimersByTimeAsync(0);
  let state = 'pending';
  void o.shutdown().then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
  await vi.advanceTimersByTimeAsync(6000);
  try {
    expect(run.t.close).toHaveBeenCalled();
    expect(f.isAlive()).toBe(true);
    expect(state).toBe('pending');
  } finally { f.die(); }
});
