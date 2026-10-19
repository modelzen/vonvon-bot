import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput, AskRequest } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  groupMode: 'single' as 'single' | 'multi',
  groupPolicy: undefined as 'steer' | 'queue' | undefined,
  noMention: undefined as boolean | undefined,
  sendManaged: vi.fn(async () => ({ messageId: 'ask-1', cardId: 'card-ask' })),
  updateManaged: vi.fn(async () => true),
  reply: vi.fn(async () => ({ data: {} })),
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({ text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true } })),
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  record: {} as Record<string, unknown>,
  history: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true })),
}));
vi.mock('../src/bot/steer-delivery', async original => { const real = await original<typeof import('../src/bot/steer-delivery')>(); return { ...real, steerWithDeadline: (thread: any, input: any, id: string) => real.steerWithDeadline(thread, input, id, undefined, 150) }; });
vi.mock('../src/card/managed', async original => ({ ...await original<object>(), sendManagedCard: fake.sendManaged, updateManagedCard: fake.updateManaged }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', kind: fake.groupMode, ...(fake.groupPolicy ? { pendingPolicy: fake.groupPolicy } : {}), ...(fake.noMention !== undefined ? { noMention: fake.noMention } : {}) }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async (key: string) => ({ threadId: key, chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '', ...fake.record }),
  // Only watermark writes (the function form) land; other patches stay no-ops.
  patchSession: async (_key: string, patch: unknown) => {
    if (typeof patch === 'function') Object.assign(fake.record, patch({ ...fake.record }));
  },
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(), fetchThreadContext: fake.history }));
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
import { isSeen } from '../src/bot/session-store';

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
  const respond = vi.fn(async () => {});
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
        respondToAsk: respond,
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
  return { t, turns, consumed, respond, emit(event: AgentEvent, index = 0) {
    progress[index]!.queue.push(event); progress[index]!.wake?.();
  } };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false, raw: { sender: { sender_type: 'user' } }, ...over } as NormalizedMessage;
}
function setup(policy: 'steer' | 'queue' = 'steer') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { reply: fake.reply, get: async () => ({ data: { items: [{ thread_id: 'new-topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.groupMode = 'single';
  fake.groupPolicy = undefined;
  fake.noMention = undefined;
  fake.sendManaged.mockReset().mockResolvedValue({ messageId: 'ask-1', cardId: 'card-ask' });
  fake.updateManaged.mockReset().mockResolvedValue(true);
  fake.reply.mockReset().mockResolvedValue({ data: {} });
  fake.record = {};
  fake.history.mockReset().mockResolvedValue({ messages: [], ok: true, complete: true });
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
});
// Keep synchronization polling well below the injected 150ms steer deadline.
const until = (check: () => void) => vi.waitFor(check, { interval: 5 });

const choice: AskRequest = { id: 'id', kind: 'choices', title: '选择', acceptedConsequence: '继续', declinedConsequence: '停止',
  questions: [{ id: 'q', title: '方案', detail: '', selection: 'single', other: false,
    options: [{ id: 'a', label: 'A', description: '' }, { id: 'b', label: 'B', description: '' }] }] };
const confirmation: AskRequest = { id: 'id', kind: 'confirmation', title: '确认', detail: '继续吗', acceptedConsequence: '继续', declinedConsequence: '停止' };
async function visible(run: ReturnType<typeof thread>, request: AskRequest = choice) {
  run.emit({ type: 'ask', request });
  await until(() => expect(fake.reply).toHaveBeenCalled());
}
async function started(run: ReturnType<typeof thread>, overrides: Partial<NormalizedMessage> = {}) {
  fake.backend.resumeThread.mockResolvedValue(run.t);
  fake.backend.startThread.mockResolvedValue(run.t);
  const o = setup(fake.groupPolicy ?? 'steer');
  await o.onMessage(message('first', overrides));
  await until(() => expect(run.consumed).toHaveLength(1));
  return o;
}
function answered(run: ReturnType<typeof thread>, text = '用方案 B') {
  expect(run.respond).toHaveBeenCalledExactlyOnceWith('id', { kind: 'answered', answer: { kind: 'text', text } });
  expect(run.t.steer).not.toHaveBeenCalled();
  expect(run.consumed).toHaveLength(1);
}

describe('typed ask messages at intake', () => {
  it.each([undefined, 'topic'])('consumes the answer in %s, without steering', async threadId => {
    const run = thread(); const o = await started(run, { threadId });
    await visible(run);
    await o.onMessage(message('用方案 B', { threadId }));
    await until(() => answered(run));
    run.turns[0]!.resolve();
  });

  it('answers before a queued turn is added', async () => {
    fake.groupPolicy = 'queue';
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('用方案 B'));
    await until(() => answered(run));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    expect(run.consumed).toHaveLength(1);
    expect(fake.log.info).not.toHaveBeenCalledWith('intake', 'queued', expect.anything());
  });

  it('lets a guest message steer, because the guest cannot answer', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('guest answer', { senderId: 'guest' }));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('lets confirmation text steer and leaves its card alone', async () => {
    const run = thread(); const o = await started(run);
    await visible(run, confirmation);
    await o.onMessage(message('确认'));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    expect(fake.updateManaged).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('routes slash commands without answering the card', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('/context'));
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('accepts a typed answer while a goal turn waits for choices', async () => {
    const run = thread();
    Object.assign(run.t, { runGoal: (_objective: string) => run.t.runStreamed({ text: 'goal' }),
      clearGoal: vi.fn(async () => undefined) });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/goal finish the work'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await visible(run);
    await o.onMessage(message('用方案 B'));
    await until(() => expect(run.respond).toHaveBeenCalledExactlyOnceWith('id',
      { kind: 'answered', answer: { kind: 'text', text: '用方案 B' } }));
    expect(fake.send.mock.calls.some(args => JSON.stringify(args).includes('目标运行中'))).toBe(false);
    run.turns[0]!.resolve();
  });

  it('records the answered message as seen', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    const answer = message('用方案 B');
    await o.onMessage(answer);
    await until(() => expect(run.respond).toHaveBeenCalled());
    await until(() => expect(isSeen(fake.record as Parameters<typeof isSeen>[0], answer.messageId, answer.createTime)).toBe(true));
    await o.onMessage(answer);
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it.each([false, true])('respects the no-mention gate (%s)', async noMention => {
    fake.noMention = noMention;
    const run = thread(); const o = await started(run, { threadId: undefined });
    await visible(run);
    await o.onMessage(message('用方案 B', { threadId: undefined, mentionedBot: false }));
    if (noMention) await until(() => answered(run));
    else { expect(run.respond).not.toHaveBeenCalled(); expect(run.t.steer).not.toHaveBeenCalled(); }
    run.turns[0]!.resolve();
  });

  it('does not take an earlier message delivered after the card', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('早先的话', { createTime: Date.now() - 60_000 }));
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });
});
