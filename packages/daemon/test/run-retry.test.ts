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
  managed: vi.fn(async (..._args: unknown[]) => ({ messageId: 'managed' })),
  project: undefined as Record<string, unknown> | undefined,
  /** Overrides the configured idle watchdog (ms) when set. */
  idleMs: undefined as number | undefined,
  /** Holds the turn's terminal patchSession({ updatedAt }) while set. */
  patchGate: undefined as Promise<void> | undefined,
  patchEntered: vi.fn(),
  sessions: [] as Record<string, unknown>[],
}));
vi.mock('../src/config/schema', async (original) => {
  const schema = await original<typeof import('../src/config/schema')>();
  return { ...schema, getRunIdleTimeoutMs: (cfg: AppConfig) => fake.idleMs ?? schema.getRunIdleTimeoutMs(cfg) };
});
vi.mock('../src/card/managed', async (original) => ({
  ...await original<object>(), sendManagedCard: fake.managed, updateManagedCard: async () => true,
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => fake.project,
  getProjectByName: async () => fake.project,
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '' }),
  patchSession: async (_key: string, patch: Record<string, unknown>) => {
    if (fake.patchGate && Object.keys(patch).join() === 'updatedAt') {
      fake.patchEntered();
      await fake.patchGate;
    }
  },
  upsertSession: async () => undefined,
  listSessions: async () => fake.sessions,
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
const PROJECT = { name: 'test', chatId: 'chat', cwd: '/test', groupMode: 'multi' };

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

/** A thread that dies with a network failure on its only turn. */
function dyingThread() {
  let alive = true;
  const t = {
    sessionId: 'host', isAlive: () => alive,
    close: vi.fn(async () => { alive = false; }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    runStreamed(_input: AgentInput) {
      return { turnId: () => 'turn-1', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn-1' };
        yield NETWORK;
        alive = false;
      })() };
    },
  };
  return { t };
}

/** A thread whose turns start and then never output again (wedged backend). */
function silentThread() {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    runStreamed(input: AgentInput) {
      const id = `turn-${consumed.push(input)}`;
      return { turnId: () => id, events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: id };
        await new Promise(() => undefined);
      })() };
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
const stop = (o: ReturnType<typeof createOrchestrator>, card: string, openId: string) => o.dispatcher.handle({
  messageId: card, chatId: 'chat', operator: { openId }, action: { value: { a: 'run.stop', m: card } },
} as never);
const sentText = () => fake.send.mock.calls.map((call) => JSON.stringify(call[1]));
const finalCards = () => fake.final.mock.calls.map((call) => JSON.stringify(call[1]));
const until = (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 3000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finals = (terminal: string) =>
  fake.log.info.mock.calls.filter((call) => call[1] === 'final' && (call[2] as { terminal?: string }).terminal === terminal);

beforeEach(() => {
  vi.clearAllMocks();
  cards = 0;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockImplementation(async () => `card-${++cards}`);
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
  fake.managed.mockReset().mockResolvedValue({ messageId: 'managed' });
  fake.project = { ...PROJECT };
  fake.idleMs = undefined;
  fake.patchGate = undefined;
  fake.sessions = [];
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

  it('expires once a newer message is accepted, before that message starts', async () => {
    const dead = dyingThread();
    const run2 = scriptedThread([]);
    let resume2!: (thread: unknown) => void;
    fake.backend.resumeThread
      .mockResolvedValueOnce(dead.t)
      .mockImplementationOnce(() => new Promise((r) => { resume2 = r; }));
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-evict', expect.anything()));
    expect(finalCards().some((json) => json.includes('run.retry') && json.includes('card-1'))).toBe(true);

    await o.onMessage(message('second')); // reserved, still resuming the dead process
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2));
    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    resume2(run2.t);
    await until(() => expect(finals('done')).toHaveLength(1));
    await sleep(50);
    expect(run2.consumed.map((input) => input.text)).toEqual([expect.stringContaining('second')]);
  });

  it("waits out the failed run's wrap-up and starts fresh, instead of joining a queue it drops", async () => {
    fake.idleMs = 300;
    let wrapUp!: () => void;
    fake.patchGate = new Promise<void>((r) => { wrapUp = r; });
    const run = silentThread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('跑个长命令'));
    await until(() => expect(fake.patchEntered).toHaveBeenCalled()); // card final, run still wrapping up
    expect(finalCards().some((json) => json.includes('run.retry'))).toBe(true);

    await tap(o, 'card-1', 'owner');
    await sleep(700); // past the repaint settle delay
    expect(finalCards().some((json) => json.includes('已重试'))).toBe(false); // not accepted yet
    fake.patchGate = undefined;
    wrapUp();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('（重试）上一轮因为');
    await until(() => expect(finalCards().some((json) => json.includes('已重试'))).toBe(true));
    expect(sentText().some((t) => t.includes('已丢弃'))).toBe(false);
  });

  it('expires while it waits out the wrap-up if a message is queued meanwhile', async () => {
    fake.idleMs = 300;
    let wrapUp!: () => void;
    fake.patchGate = new Promise<void>((r) => { wrapUp = r; });
    const run = silentThread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('跑个长命令'));
    await until(() => expect(fake.patchEntered).toHaveBeenCalled());
    await tap(o, 'card-1', 'owner'); // passes the tap checks, then waits
    await o.onMessage(message('先别管那个'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    fake.patchGate = undefined;
    wrapUp();
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    await sleep(50);
    expect(run.consumed).toHaveLength(1);
    expect(sentText().filter((t) => t.includes('已丢弃'))).toEqual([expect.stringContaining('1 条排队消息已丢弃')]);
  });

  it('tells the tap when a resume starts while it waits out the wrap-up, and keeps the button', async () => {
    fake.idleMs = 300;
    let wrapUp!: () => void;
    fake.patchGate = new Promise<void>((r) => { wrapUp = r; });
    const run = silentThread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    let readHistory: ((err: Error) => void) | undefined;
    Object.assign(fake.backend, {
      listThreads: async () => [{ sessionId: 'past' }],
      readHistory: () => new Promise((_resolve, reject) => { readHistory = reject; }),
    });
    const o = setup();
    await o.onMessage(message('跑个长命令'));
    await until(() => expect(fake.patchEntered).toHaveBeenCalled());
    await tap(o, 'card-1', 'owner'); // passes the tap checks, then waits
    const resume = o.collaboration({ action: 'resume', projectName: 'test', chatId: 'chat', sessionId: 'past', backend: 'codex' })
      .catch(() => undefined);
    await until(() => expect(readHistory).toBeDefined()); // the desktop resume is publishing
    fake.patchGate = undefined;
    wrapUp();
    await until(() => expect(sentText().some((t) => t.includes('正在恢复历史会话'))).toBe(true));
    expect(run.consumed).toHaveLength(1);
    readHistory!(new Error('gone'));
    await resume;

    await tap(o, 'card-1', 'owner');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('runs once when tapped twice, telling the second tap it is already on its way', async () => {
    const run = scriptedThread([[NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('整理一下文档'));
    await until(() => expect(finals('error')).toHaveLength(1));
    await Promise.all([tap(o, 'card-1', 'owner'), tap(o, 'card-1', 'admin')]);
    await until(() => expect(run.consumed).toHaveLength(2));
    await sleep(50);
    expect(run.consumed).toHaveLength(2);
    expect(sentText().some((t) => t.includes('正在重试'))).toBe(true);
  });

  it('wraps a retried turn only once when the retry fails too', async () => {
    const run = scriptedThread([[NETWORK], [NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('整理一下文档'));
    await until(() => expect(finals('error')).toHaveLength(1));
    await tap(o, 'card-1', 'owner');
    await until(() => expect(finals('error')).toHaveLength(2));
    await tap(o, 'card-2', 'owner');
    await until(() => expect(run.consumed).toHaveLength(3));
    expect((run.consumed[2]!.text ?? '').split('（重试）')).toHaveLength(2);
    expect(run.consumed[2]!.text).toContain(run.consumed[0]!.text);
  });

  it('refuses after the group was unbound, and 👍 does not resume it either', async () => {
    fake.project = { ...PROJECT, mode: 'qa' };
    const dead = dyingThread();
    fake.backend.resumeThread.mockResolvedValueOnce(dead.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-evict', expect.anything()));
    fake.project = undefined; // unbound in the DM console; the bot is still in the group

    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('本群还没绑定为项目'))).toBe(true));
    await o.onReaction({ action: 'added', emojiType: 'THUMBSUP', messageId: 'card-1', operator: { openId: 'owner' } } as never);
    await sleep(100);
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(finalCards().some((json) => json.includes('已重试'))).toBe(false);
  });

  it('keeps the button usable while the project is disabled', async () => {
    const run = scriptedThread([[NETWORK]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('整理一下文档'));
    await until(() => expect(finals('error')).toHaveLength(1));
    fake.project = { ...PROJECT, enabled: false };
    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('项目已停用'))).toBe(true));
    await sleep(700);
    expect(finalCards().some((json) => json.includes('已重试'))).toBe(false);
    expect(run.consumed).toHaveLength(1);

    fake.project = { ...PROJECT };
    await tap(o, 'card-1', 'owner');
    await until(() => expect(run.consumed).toHaveLength(2));
    await until(() => expect(finalCards().some((json) => json.includes('已重试'))).toBe(true));
  });

  it('expires once /clear swaps in a fresh thread', async () => {
    fake.project = { ...PROJECT, kind: 'single' };
    const run = scriptedThread([[NETWORK]]);
    const fresh = scriptedThread([]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage({ ...message('整理一下文档'), threadId: undefined });
    await until(() => expect(finals('error')).toHaveLength(1));
    expect(finalCards().some((json) => json.includes('run.retry'))).toBe(true);
    await o.onMessage({ ...message('/clear'), threadId: undefined });
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'clear', expect.anything()));

    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    await sleep(50);
    expect(run.consumed).toHaveLength(1);
    expect(fresh.consumed).toHaveLength(0);
  });

  it('expires once a desktop clear swaps in a fresh thread', async () => {
    fake.project = { ...PROJECT, kind: 'single' };
    fake.sessions = [{ threadId: 'chat', chatId: 'chat', cwd: '/test', sessionId: 'host', backend: 'codex', summary: '' }];
    const run = scriptedThread([[NETWORK]]);
    const fresh = scriptedThread([]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage({ ...message('整理一下文档'), threadId: undefined });
    await until(() => expect(finals('error')).toHaveLength(1));
    await o.collaboration({ action: 'clear', projectName: 'test', chatId: 'chat', threadId: 'chat' });

    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('这个重试按钮已失效'))).toBe(true));
    await sleep(50);
    expect(run.consumed).toHaveLength(1);
    expect(fresh.consumed).toHaveLength(0);
  });

  it('stays usable while /compact holds the session, instead of joining a queue it drops', async () => {
    const run = scriptedThread([[NETWORK]]);
    let compacted: (() => void) | undefined;
    Object.assign(run.t, { compact: () => new Promise((r) => { compacted = () => r({}); }) });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('整理一下文档'));
    await until(() => expect(finals('error')).toHaveLength(1));
    await o.onMessage(message('/compact'));
    await until(() => expect(compacted).toBeDefined());

    await tap(o, 'card-1', 'owner');
    await until(() => expect(sentText().some((t) => t.includes('会话正在处理别的操作'))).toBe(true));
    compacted!();
    await sleep(100);
    expect(sentText().some((t) => t.includes('未进入会话'))).toBe(false);
    await tap(o, 'card-1', 'owner');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('offers no [重试] on a card stopped with ⏹, even if the idle timer fired while stopping', async () => {
    fake.idleMs = 300;
    const run = silentThread(); // abort is ignored: the stop waits out its 5 s
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('跑个长命令'));
    await until(() => expect(fake.live).toHaveBeenCalled());
    await stop(o, 'card-1', 'owner');
    await until(() => expect(finals('interrupted')).toHaveLength(1));
    expect(finalCards().some((json) => json.includes('run.retry'))).toBe(false);
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

describe('a /goal that recovered from an API retry', () => {
  it('reports the real end reason, not the retry notice', async () => {
    const goal = {
      sessionId: 'host', isAlive: () => true,
      close: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      clearGoal: vi.fn(async () => undefined),
      runGoal: () => ({ turnId: () => 't1', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 't1' };
        yield { type: 'error', message: '网络波动，正在重试…', willRetry: true };
        yield { type: 'text_delta', itemId: 'a', delta: '继续做' };
        yield { type: 'done', turnId: 't1' };
        yield { type: 'goal_update', status: 'budgetLimited', objective: '整理文档', tokensUsed: 10, timeUsedSeconds: 5, tokenBudget: 10 };
      })() }),
    };
    fake.backend.resumeThread.mockResolvedValue(goal);
    const o = setup();
    await o.onMessage(message('/goal 整理文档'));
    await until(() => expect(fake.managed).toHaveBeenCalled());
    const done = JSON.stringify(fake.managed.mock.calls[0]![2]);
    expect(done).toContain('Token 预算用尽');
    expect(done).not.toContain('网络波动');
  });
});
