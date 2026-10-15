import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

// Same harness shape as message-queue-races: real orchestrator, faked backend,
// card stream and stores.
const fake = vi.hoisted(() => ({
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', groupMode: 'multi' }),
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
import { createOrchestrator, retryPrompt } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

const NETWORK: AgentEvent = { type: 'error', message: 'stream disconnected before completion', willRetry: false, kind: 'network' };

/** A thread whose turns play scripted events; a turn without a script ends `done`. */
function scriptedThread(script: AgentEvent[][]) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    runStreamed(input: AgentInput) {
      const n = consumed.push(input);
      const id = `turn-${n}`;
      const events = script[n - 1] ?? [{ type: 'done', turnId: id }];
      return {
        turnId: () => id,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          yield* events;
        })(),
      };
    },
  };
  return { t, consumed };
}

let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
let cards = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup() {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['admin'] } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
const tap = (o: ReturnType<typeof createOrchestrator>, card: string, openId: string) => o.dispatcher.handle({
  messageId: card, chatId: 'chat', operator: { openId }, action: { value: { a: 'run.retry', m: card } },
} as never);
const sentText = () => fake.send.mock.calls.map((call) => JSON.stringify(call[1]));
const finalCards = () => fake.final.mock.calls.map((call) => JSON.stringify(call[1]));
const until = (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 3000 });

beforeEach(() => {
  vi.clearAllMocks();
  cards = 0;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockImplementation(async () => `card-${++cards}`);
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  await orchestrator?.shutdown();
});

describe('retryPrompt', () => {
  it('says why the last turn stopped, then carries its input', () => {
    expect(retryPrompt({ reason: 'idle', idleSeconds: 600 }, '原消息'))
      .toMatch(/^（重试）上一轮因为10 分钟没有输出，被自动停止了。[\s\S]*别重复做。\n\n原消息$/);
    expect(retryPrompt({ reason: 'network', idleSeconds: 600 }, 'x')).toContain('上一轮因为网络失败，中断了');
  });
});

describe('[重试] on a failed run card', () => {
  it('replays the failed turn once, through the normal pipeline', async () => {
    const run = scriptedThread([[NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('整理一下文档'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'error' }));
    expect(finalCards().some((json) => json.includes('run.retry') && json.includes('card-1'))).toBe(true);

    await tap(o, 'card-1', 'owner');
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('（重试）上一轮因为网络失败');
    expect(run.consumed[1]!.text).toContain(run.consumed[0]!.text);
    // The retry's card replies to the failed card.
    expect(fake.createCard.mock.calls[1]?.[3]).toMatchObject({ replyTo: 'card-1' });

    await tap(o, 'card-1', 'owner'); // already used
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    expect(run.consumed).toHaveLength(2);
  });

  it('lets an admin retry, but not another member', async () => {
    const run = scriptedThread([[NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('跑一下测试'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'error' }));

    await tap(o, 'card-1', 'someone');
    await until(() => expect(sentText().some((t) => t.includes('仅发起人或管理员可重试'))).toBe(true));
    expect(run.consumed).toHaveLength(1);

    await tap(o, 'card-1', 'admin');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('expires once a newer turn ran in the same session', async () => {
    const run = scriptedThread([[NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'error' }));
    await o.onMessage(message('second'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'done' }));

    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    expect(run.consumed).toHaveLength(2);
  });

  it('offers no [重试] for an ordinary agent error', async () => {
    const run = scriptedThread([[{ type: 'error', message: 'boom', willRetry: false }]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'error' }));
    expect(finalCards().some((json) => json.includes('run.retry'))).toBe(false);
  });
});
