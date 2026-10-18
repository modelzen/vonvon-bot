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
  mutateProject: async (_name: string, mutate: (project: object) => void) => { const next = { ...fake.project }; mutate(next); return next; },
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
  bindSession: async () => undefined,
  listSessions: async () => fake.sessions,
  detachSessionsForChat: async (_chatId: string, commit: () => Promise<unknown>) => commit(),
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
import { weaveRecordBlock, weaveSender } from '../src/bot/context-weave';
import { stripBridgeMessageEnvelope } from '../src/bot/session-title';
import { projectRevision } from '../src/admin/collaboration';
import type { AppConfig } from '../src/config/schema';

const NETWORK: AgentEvent = { type: 'error', message: 'stream disconnected before completion', willRetry: false, kind: 'network' };
const PROJECT = { name: 'test', chatId: 'chat', cwd: '/test', groupMode: 'multi' };
const STALE = '这个重试按钮已失效';

/** A fake host thread: turn n yields turn_started, then whatever `play` yields. */
function fakeThread(play: (id: string, n: number) => AsyncIterable<AgentEvent>) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: vi.fn(() => true),
    close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), steer: vi.fn(async () => undefined),
    runStreamed(input: AgentInput) {
      const n = consumed.push(input);
      const id = `turn-${n}`;
      return { turnId: () => id, events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: id };
        yield* play(id, n);
      })() };
    },
  };
  return { t, consumed };
}

/** Turns play scripted events; a turn without a script ends `done`. */
function scriptedThread(script: AgentEvent[][]) {
  return fakeThread(async function* (id, n) { yield* script[n - 1] ?? [{ type: 'done', turnId: id }]; });
}

/** Turns start and then never output again (wedged backend). */
function silentThread() {
  return fakeThread(async function* () { await new Promise(() => undefined); });
}

/** Dies with a network failure on its only turn. */
function dyingThread() {
  let alive = true;
  const dying = fakeThread(async function* () { yield NETWORK; alive = false; });
  dying.t.isAlive.mockImplementation(() => alive);
  dying.t.close.mockImplementation(async () => { alive = false; });
  return dying;
}

type Orchestrator = ReturnType<typeof createOrchestrator>;
let orchestrator: Orchestrator;
let seq = 0;
let cards = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
/** Starts the orchestrator; every resume returns `thread` when given. */
function setup(thread?: unknown) {
  if (thread) fake.backend.resumeThread.mockResolvedValue(thread);
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['admin'] } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
/** Sends `msg` to a session on `run` and waits for its run card's error final. */
async function failedRun(run = scriptedThread([[NETWORK]]), msg = message('整理一下文档')) {
  const o = setup(run.t);
  await o.onMessage(msg);
  await until(() => expect(finals('error')).toHaveLength(1));
  return { o, run };
}
/** A run that idles out after 300 ms and is held in its wrap-up until `wrapUp()`. */
async function heldInWrapUp() {
  fake.idleMs = 300;
  let release!: () => void;
  fake.patchGate = new Promise<void>((r) => { release = r; });
  const run = silentThread();
  const o = setup(run.t);
  await o.onMessage(message('跑个长命令'));
  await until(() => expect(fake.patchEntered).toHaveBeenCalled()); // card final, run still wrapping up
  const wrapUp = () => { fake.patchGate = undefined; release(); };
  return { o, run, wrapUp };
}
const press = (a: string, card: string, openId = 'owner') => orchestrator.dispatcher.handle({
  messageId: card, chatId: 'chat', operator: { openId }, action: { value: { a, m: card } },
} as never);
const tap = (card: string, openId?: string) => press('run.retry', card, openId);
const sentText = () => fake.send.mock.calls.map((call) => JSON.stringify(call[1]));
const replied = (text: string) => sentText().some((t) => t.includes(text));
const finalCards = () => fake.final.mock.calls.map((call) => JSON.stringify(call[1]));
/** Whether a final card (`card`'s, when given) carries the [重试] button. */
const offersRetry = (card = '') => finalCards().some((json) => json.includes('run.retry') && json.includes(card));
const retried = () => finalCards().some((json) => json.includes('已重试'));
const until = (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 3000 });
const untilReplied = (text: string) => until(() => expect(replied(text)).toBe(true));
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
  Object.assign(fake.backend, { id: 'codex', displayName: 'Codex (app-server)', listThreads: async () => [{ sessionId: 'past', preview: '', createdAt: 1, updatedAt: 2 }], readHistory: async () => ({ turns: [], totalTurns: 0 }) });
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

  // The /resume history card shows a retried turn through stripBridgeMessageEnvelope:
  // its preface must come off with the rest of the envelope.
  it("strips back to the person's words, for every reason", () => {
    const woven = weaveRecordBlock(weaveSender('整理一下文档', { senderId: 'ou_secret_id', senderName: '张三' }), {
      place: { group: '验收群', me: 'Vonvon Bot 6' },
      entries: [{ messageId: 'om_old', senderName: '李四', text: '上文', createTime: 1, from: 'user' }],
      now: 2,
    });
    for (const retry of [
      { reason: 'idle', idleSeconds: 600 },
      { reason: 'idle', idleSeconds: 45 },
      { reason: 'network', idleSeconds: 0 },
    ] as const) {
      expect(stripBridgeMessageEnvelope(retryPrompt(retry, woven))).toBe('整理一下文档');
    }
  });
});

describe('a /resume pick from the Feishu card', () => {
  // The real backends' own displayName ("Codex (app-server)") is not what users call them.
  it.each([
    { id: 'codex-appserver', displayName: 'Codex (app-server)', shown: 'Codex', other: /Claude|app-server/ },
    { id: 'claude-agent', displayName: 'Claude', shown: 'Claude', other: /Codex/ },
  ])("names the group's backend on the history card: $shown", async ({ id, displayName, shown, other }) => {
    fake.project = { ...PROJECT, kind: 'single' };
    Object.assign(fake.backend, {
      id,
      displayName,
      readHistory: async () => ({ turns: [{ userText: '记住暗号', assistantText: '记住了。', reasoning: '', tools: [] }], totalTurns: 3 }),
    });
    const o = setup();
    await o.onMessage({ ...message('/resume'), threadId: undefined });
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'resume', expect.anything()));
    await o.dispatcher.handle({ messageId: 'managed', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'resume.pick', t: 'past' } } } as never);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'resume-done-single', expect.anything()));
    const card = JSON.stringify(fake.managed.mock.calls.find((call) => JSON.stringify(call).includes('已恢复历史会话')));
    expect(card).toContain(`**🤖 ${shown}**`);
    expect(card).toContain(`更早的 2 轮 ${shown} 仍保留`);
    expect(card).not.toMatch(other);
  });
});

describe('[重试] on a failed run card', () => {
  it('replays the failed turn once, through the normal pipeline', async () => {
    const { run } = await failedRun();
    expect(offersRetry('card-1')).toBe(true);

    await tap('card-1');
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('（重试）上一轮因为网络失败');
    expect(run.consumed[1]!.text).toContain(run.consumed[0]!.text);
    // The retry's card replies to the failed card.
    expect(fake.createCard.mock.calls[1]?.[3]).toMatchObject({ replyTo: 'card-1' });

    await tap('card-1'); // already used
    await untilReplied(STALE);
    expect(run.consumed).toHaveLength(2);
  });

  it('lets an admin retry, but not another member', async () => {
    const { run } = await failedRun();
    await tap('card-1', 'someone');
    await untilReplied('仅发起人或管理员可重试');
    expect(run.consumed).toHaveLength(1);

    await tap('card-1', 'admin');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('expires once a newer turn ran in the same session', async () => {
    const { o, run } = await failedRun();
    await o.onMessage(message('second'));
    await until(() => expect(finals('done')).toHaveLength(1));
    await tap('card-1');
    await untilReplied(STALE);
    expect(run.consumed).toHaveLength(2);
  });

  it('expires once a newer message is accepted, before that message starts', async () => {
    const run2 = scriptedThread([]);
    let resume2!: (thread: unknown) => void;
    fake.backend.resumeThread
      .mockResolvedValueOnce(dyingThread().t)
      .mockImplementationOnce(() => new Promise((r) => { resume2 = r; }));
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-evict', expect.anything()));
    expect(offersRetry('card-1')).toBe(true);

    await o.onMessage(message('second')); // reserved, still resuming the dead process
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2));
    await tap('card-1');
    await untilReplied(STALE);
    resume2(run2.t);
    await until(() => expect(finals('done')).toHaveLength(1));
    await sleep(50);
    expect(run2.consumed.map((input) => input.text)).toEqual([expect.stringContaining('second')]);
  });

  it("waits out the failed run's wrap-up and starts fresh, instead of joining a queue it drops", async () => {
    const { run, wrapUp } = await heldInWrapUp();
    expect(offersRetry()).toBe(true);
    await tap('card-1');
    await sleep(700); // past the repaint settle delay
    expect(retried()).toBe(false); // not accepted yet
    wrapUp();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('（重试）上一轮因为');
    await until(() => expect(retried()).toBe(true));
    expect(replied('已丢弃')).toBe(false);
  });

  it('expires while it waits out the wrap-up if a message is queued meanwhile', async () => {
    const { o, run, wrapUp } = await heldInWrapUp();
    await tap('card-1'); // passes the tap checks, then waits
    await o.onMessage(message('先别管那个'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    wrapUp();
    await untilReplied(STALE);
    await sleep(50);
    expect(run.consumed).toHaveLength(1);
    expect(sentText().filter((t) => t.includes('已丢弃'))).toEqual([expect.stringContaining('1 条排队消息已丢弃')]);
  });

  it('tells the tap when a resume starts while it waits out the wrap-up, and keeps the button', async () => {
    let readHistory: ((err: Error) => void) | undefined;
    Object.assign(fake.backend, {
      listThreads: async () => [{ sessionId: 'past' }],
      readHistory: () => new Promise((_resolve, reject) => { readHistory = reject; }),
    });
    const { o, run, wrapUp } = await heldInWrapUp();
    await tap('card-1'); // passes the tap checks, then waits
    const resume = o.collaboration({ action: 'resume', projectName: 'test', chatId: 'chat', sessionId: 'past', backend: 'codex' })
      .catch(() => undefined);
    await until(() => expect(readHistory).toBeDefined()); // the desktop resume is publishing
    wrapUp();
    await untilReplied('正在恢复历史会话');
    expect(run.consumed).toHaveLength(1);
    readHistory!(new Error('gone'));
    await resume;

    await tap('card-1');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('runs once when tapped twice, telling the second tap it is already on its way', async () => {
    const { run } = await failedRun();
    await Promise.all([tap('card-1'), tap('card-1', 'admin')]);
    await until(() => expect(run.consumed).toHaveLength(2));
    await sleep(50);
    expect(run.consumed).toHaveLength(2);
    expect(replied('正在重试')).toBe(true);
  });

  it('wraps a retried turn only once when the retry fails too', async () => {
    const { run } = await failedRun(scriptedThread([[NETWORK], [NETWORK]]));
    await tap('card-1');
    await until(() => expect(finals('error')).toHaveLength(2));
    await tap('card-2');
    await until(() => expect(run.consumed).toHaveLength(3));
    expect((run.consumed[2]!.text ?? '').split('（重试）')).toHaveLength(2);
    expect(run.consumed[2]!.text).toContain(run.consumed[0]!.text);
  });

  it('refuses after the group was unbound, and 👍 does not resume it either', async () => {
    fake.project = { ...PROJECT, mode: 'qa' };
    fake.backend.resumeThread.mockResolvedValueOnce(dyingThread().t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-evict', expect.anything()));
    fake.project = undefined; // unbound in the DM console; the bot is still in the group

    await tap('card-1');
    await untilReplied('本群还没绑定为项目');
    await o.onReaction({ action: 'added', emojiType: 'THUMBSUP', messageId: 'card-1', operator: { openId: 'owner' } } as never);
    await sleep(100);
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(retried()).toBe(false);
  });

  it('keeps the button usable while the project is disabled', async () => {
    const { run } = await failedRun();
    fake.project = { ...PROJECT, enabled: false };
    await tap('card-1');
    await untilReplied('项目已停用');
    await sleep(700);
    expect(retried()).toBe(false);
    expect(run.consumed).toHaveLength(1);

    fake.project = { ...PROJECT };
    await tap('card-1');
    await until(() => expect(run.consumed).toHaveLength(2));
    await until(() => expect(retried()).toBe(true));
  });

  it.each([
    { how: '/clear', sessions: [], async clear(o: Orchestrator) {
      await o.onMessage({ ...message('/clear'), threadId: undefined });
      await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'clear', expect.anything()));
    } },
    { how: 'a desktop clear', sessions: [{ threadId: 'chat', chatId: 'chat', cwd: '/test', sessionId: 'host', backend: 'codex', summary: '' }],
      async clear(o: Orchestrator) { await o.collaboration({ action: 'clear', projectName: 'test', chatId: 'chat', threadId: 'chat' }); } },
    { how: 'a /resume pick', sessions: [], async clear(o: Orchestrator) {
      await o.onMessage({ ...message('/resume'), threadId: undefined });
      await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'resume', expect.anything()));
      await o.dispatcher.handle({ messageId: 'managed', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'resume.pick', t: 'past' } } } as never);
      await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'resume-done-single', expect.anything()));
    } },
    { how: 'a desktop resume', sessions: [], async clear(o: Orchestrator) {
      await o.collaboration({ action: 'resume', projectName: 'test', chatId: 'chat', sessionId: 'past', backend: 'codex' });
    } },
    { how: 'a folder change', sessions: [], async clear(o: Orchestrator) {
      await o.collaboration({ action: 'editProject', projectName: 'test', chatId: 'chat', expectedRevision: projectRevision(fake.project as never), directory: process.cwd() });
    } },
  ])('expires once $how swaps the session for another thread', async ({ sessions, clear }) => {
    fake.project = { ...PROJECT, kind: 'single' };
    fake.sessions = sessions;
    const run = scriptedThread([[NETWORK]]);
    const fresh = scriptedThread([]);
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const { o } = await failedRun(run, { ...message('整理一下文档'), threadId: undefined });
    expect(offersRetry()).toBe(true);
    await clear(o);

    await tap('card-1');
    await untilReplied(STALE);
    await sleep(50);
    expect(run.consumed).toHaveLength(1);
    expect(fresh.consumed).toHaveLength(0);
  });

  it('stays usable while /compact holds the session, instead of joining a queue it drops', async () => {
    const run = scriptedThread([[NETWORK]]);
    let compacted: (() => void) | undefined;
    Object.assign(run.t, { compact: () => new Promise((r) => { compacted = () => r({}); }) });
    const { o } = await failedRun(run);
    await o.onMessage(message('/compact'));
    await until(() => expect(compacted).toBeDefined());

    await tap('card-1');
    await untilReplied('会话正在处理别的操作');
    compacted!();
    await sleep(100);
    expect(replied('未进入会话')).toBe(false);
    await tap('card-1');
    await until(() => expect(run.consumed).toHaveLength(2));
  });

  it('offers no [重试] on a card stopped with ⏹, even if the idle timer fired while stopping', async () => {
    fake.idleMs = 300;
    const o = setup(silentThread().t); // abort is ignored: the stop waits out its 5 s
    await o.onMessage(message('跑个长命令'));
    await until(() => expect(fake.live).toHaveBeenCalled());
    await press('run.stop', 'card-1');
    await until(() => expect(finals('interrupted')).toHaveLength(1));
    expect(offersRetry()).toBe(false);
  });

  it('offers no [重试] for an ordinary agent error', async () => {
    await failedRun(scriptedThread([[{ type: 'error', message: 'boom', willRetry: false }]]));
    expect(offersRetry()).toBe(false);
  });
});

describe('a /goal that recovered from an API retry', () => {
  it('reports the real end reason, not the retry notice', async () => {
    const goal = Object.assign(scriptedThread([]).t, {
      clearGoal: vi.fn(async () => undefined),
      runGoal: () => ({ turnId: () => 't1', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 't1' };
        yield { type: 'error', message: '网络波动，正在重试…', willRetry: true };
        yield { type: 'text_delta', itemId: 'a', delta: '继续做' };
        yield { type: 'done', turnId: 't1' };
        yield { type: 'goal_update', status: 'budgetLimited', objective: '整理文档', tokensUsed: 10, timeUsedSeconds: 5, tokenBudget: 10 };
      })() }),
    });
    const o = setup(goal);
    await o.onMessage(message('/goal 整理文档'));
    await until(() => expect(fake.managed).toHaveBeenCalled());
    const done = JSON.stringify(fake.managed.mock.calls[0]![2]);
    expect(done).toContain('Token 预算用尽');
    expect(done).not.toContain('网络波动');
  });
});
