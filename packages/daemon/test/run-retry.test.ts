import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEntry, AgentEvent, AgentInput, AgentRun, AskRequest } from '../src/agent/types';

// Same harness shape as message-queue-races: real orchestrator, faked backend,
// card stream and stores.
const fake = vi.hoisted(() => ({
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  live: vi.fn(),
  updated: vi.fn(async (..._args: unknown[]) => true),
  deleteElement: vi.fn(async (..._args: unknown[]) => ({})),
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
  ...await original<object>(), sendManagedCard: fake.managed, updateManagedCard: fake.updated,
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
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import { createOrchestrator, retryPrompt } from '../src/bot/handle-message';
import { weaveRecordBlock, weaveSender } from '../src/bot/context-weave';
import { stripBridgeMessageEnvelope } from '../src/bot/session-title';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { projectRevision } from '../src/admin/collaboration';
import type { AppConfig } from '../src/config/schema';
import type { HostApi } from '../src/admin/ipc';
import { inBotSession } from '../src/config/session-env';

const NETWORK: AgentEvent = { type: 'error', message: 'stream disconnected before completion', willRetry: false, kind: 'network' };
const PROJECT = { name: 'test', chatId: 'chat', cwd: '/test', groupMode: 'multi' };
const STALE = '这个重试按钮已失效';

/** A fake host thread: turn n yields turn_started, then whatever `play` yields. */
function fakeThread(play: (id: string, n: number) => AsyncIterable<AgentEvent>) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: vi.fn(() => true),
    close: vi.fn(async () => undefined), abort: vi.fn(async () => undefined), steer: vi.fn(async () => undefined),
    // Match Codex's native context channel; user-input assertions stay separate from settings.
    injectContext: vi.fn(async (_text: string) => undefined),
    runStreamed(input: AgentInput): AgentRun {
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
function setup(thread?: unknown, allowedChats = ['chat'], entries?: AgentEntries, host?: Pick<HostApi, 'issueSessionToken'>) {
  if (thread) fake.backend.resumeThread.mockResolvedValue(thread);
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['admin'], allowedChats } } };
  const channel = { send: fake.send, getChatInfo: async () => ({ name: 'Test', chatType: 'group' }), rawClient: { cardkit: { v1: { cardElement: { delete: fake.deleteElement } } }, im: { v1: { chat: { get: async () => ({ data: { chat_mode: 'group' } }) }, chatMembers: { isInChat: async () => ({ code: 0, data: { is_in_chat: true } }) }, message: { get: async () => ({ data: { items: [{ thread_id: 'topic', body: { content: JSON.stringify({ type: 'card', data: { card_id: 'orphan-entity' } }) } }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test', undefined, { entries, ...(host ? { host } : {}) });
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
const until = (check: () => void | Promise<void>) => vi.waitFor(check, { interval: 5, timeout: 3000 });
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
  setDiagnosticsSink(undefined);
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

  it('during multi-session recovery asks only a human to wait, never another bot', async () => {
    let failHistory!: (error: Error) => void;
    Object.assign(fake.backend, {
      listThreads: async () => [{ sessionId: 'past' }],
      readHistory: () => new Promise((_resolve, reject) => { failHistory = reject; }),
    });
    const o = setup(scriptedThread([]).t);
    const resume = o.collaboration({ action: 'resume', projectName: 'test', chatId: 'chat', sessionId: 'past', backend: 'codex' }).catch(() => undefined);
    await until(() => expect(failHistory).toBeDefined());
    const bot = { ...message('BOT_WAIT_CONTROL'), raw: { sender: { sender_type: 'app' } } };
    await o.onMessage(bot);
    expect(sentText().filter(t => t.includes('正在恢复历史会话'))).toEqual([]);
    await o.onMessage(message('PERSON_WAIT_CONTROL'));
    await untilReplied('正在恢复历史会话');
    failHistory(new Error('gone'));
    await resume;
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
    await untilReplied('主人还没设置好这个群');
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

describe('single subagent controls', () => {
  it('heals a mapped card after its run has ended', async () => {
    const { o, wrapUp } = await heldInWrapUp();
    try {
      await o.dispatcher.handle({ messageId: 'card-1', chatId: 'chat', operator: { openId: 'owner' },
        action: { value: { a: 'run.stopSub', m: 'card-1', subagentId: 'child-a' } } } as never);
      await untilReplied('该任务已结束');
    } finally { wrapUp(); }
  });

  it('keeps the parent running, returns only public rows, and preserves RPC refusal reasons', async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const stopSubagent = vi.fn(async (_id: string) => {});
    const run = fakeThread(async function* () {
      yield { type: 'subagent_start', id: 'child-a', name: 'Alpha', task: 'Count files', stoppable: true };
      yield { type: 'subagent_start', id: 'child-b', name: 'Beta', task: 'Read files', stoppable: true };
      await held;
      yield { type: 'done', turnId: 'turn-1' };
    });
    const original = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = input => ({ ...original(input), stopSubagent });
    const o = setup(run.t);
    fake.sessions = [{ threadId: 'topic', chatId: 'chat', cwd: '/test', sessionId: 'host', backend: 'codex', summary: '' }];
    const target = { projectName: 'test', chatId: 'chat', threadId: 'topic' };
    await o.onMessage(message('Work'));
    let runId = '';
    await until(async () => {
      const context = z.object({ run: z.object({ id: z.string(), subagents: z.array(z.object({ id: z.string(), name: z.string(), task: z.string(), status: z.string(), stoppable: z.boolean() }).passthrough()) }).nullable() }).parse(await o.collaboration({ action: 'context', ...target }));
      expect(context).toMatchObject({ run: { subagents: [{ id: 'child-a' }, { id: 'child-b' }] } });
      if (context.run) {
        runId = context.run.id;
        expect(Object.keys(context.run.subagents[0] ?? {}).sort()).toEqual(['id', 'name', 'status', 'stoppable', 'task']);
      }
    });
    await expect(o.collaboration({ action: 'stopSubagent', ...target, runId: 'old', subagentId: 'child-a' })).rejects.toThrow('原任务已经结束，请刷新');
    await o.collaboration({ action: 'stopSubagent', ...target, runId, subagentId: 'child-a' });
    expect(stopSubagent).toHaveBeenCalledExactlyOnceWith('child-a');
    expect(run.t.abort).not.toHaveBeenCalled();
    stopSubagent.mockRejectedValueOnce(new Error('这个子 agent 已经结束'));
    await expect(o.collaboration({ action: 'stopSubagent', ...target, runId, subagentId: 'child-a' })).rejects.toThrow('这个子 agent 已经结束');
    finish();
    await until(async () => expect(await o.collaboration({ action: 'context', ...target })).toMatchObject({ run: null }));
  });

  it('gates the card action by chat and owner, stops only the requested child, and heals stale cards', async () => {
    const stopSubagent = vi.fn(async (_id: string) => {});
    const run = silentThread();
    const original = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = input => ({ ...original(input), stopSubagent });
    const o = setup(run.t);
    await o.onMessage(message('Work'));
    await until(() => expect(fake.live).toHaveBeenCalled());
    const click = (openId: string, chatId = 'chat', card = 'card-1') => o.dispatcher.handle({
      messageId: card, chatId, operator: { openId }, action: { value: { a: 'run.stopSub', m: card, subagentId: 'child-a' } },
    } as never);
    await click('owner', 'blocked-chat');
    expect(stopSubagent).not.toHaveBeenCalled();
    await click('other');
    expect(stopSubagent).not.toHaveBeenCalled();
    await untilReplied('仅发起人或管理员');
    await click('owner');
    await until(() => expect(stopSubagent).toHaveBeenCalledExactlyOnceWith('child-a'));
    expect(run.t.abort).not.toHaveBeenCalled();
    stopSubagent.mockRejectedValueOnce(new Error('这个子 agent 已经结束'));
    await click('admin');
    await untilReplied('这个子 agent 已经结束');
    await click('owner', 'chat', 'missing-card');
    await untilReplied('该任务已结束');
  });
});

describe('unbound group hints', () => {
  const unboundMessage = (text: string) => ({ ...message(text), chatId: 'oc_unbound' });
  const notes: DiagnosticsEvent[] = [];
  function unbound() {
    fake.project = undefined;
    notes.length = 0;
    setDiagnosticsSink(event => notes.push(event));
    return setup(undefined, ['oc_unbound', 'oc_other']);
  }
  const unboundNotes = () => notes.filter(event => event.kind === 'notReplied' && event.record.reason === 'unbound');

  it('limits repeated mentions for ten minutes while recording each one', async () => {
    const o = unbound();
    await o.onMessage(unboundMessage('一'));
    await o.onMessage(unboundMessage('二'));
    expect(fake.send).toHaveBeenCalledOnce();
    expect(unboundNotes()).toHaveLength(2);
    const realNow = Date.now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000 + 1);
    try {
      await o.onMessage(unboundMessage('三'));
      expect(fake.send).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it('retries immediately after a failed send', async () => {
    const o = unbound();
    fake.send.mockRejectedValueOnce(new Error('send failed'));
    await o.onMessage(unboundMessage('一'));
    await o.onMessage(unboundMessage('二'));
    await o.onMessage(unboundMessage('三'));
    expect(fake.send).toHaveBeenCalledTimes(2);
  });

  it('replies inside the mentioned topic', async () => {
    const o = unbound();
    const msg = unboundMessage('话题');
    await o.onMessage(msg);
    expect(fake.send).toHaveBeenCalledWith('oc_unbound', expect.any(Object), { replyTo: msg.messageId, replyInThread: true });
  });

  it('keeps separate groups independent and main-area replies in the main area', async () => {
    const o = unbound();
    await o.onMessage({ ...unboundMessage('一'), threadId: undefined });
    await o.onMessage({ ...unboundMessage('二'), chatId: 'oc_other' });
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(fake.send.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ replyInThread: false }));
  });

  it('does not reply or record diagnostics without a mention', async () => {
    const o = unbound();
    expect(notes).toEqual([{ kind: 'attention', groups: [] }]);
    notes.length = 0;
    await o.onMessage({ ...unboundMessage('一'), mentionedBot: false });
    expect(fake.send).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
  });

  it('clears the quiet period when the bot is invited again', async () => {
    const o = unbound();
    await o.onMessage(unboundMessage('一'));
    await o.onBotAddedToChat({ chatId: 'oc_unbound', operator: { openId: 'owner' } });
    await o.onMessage(unboundMessage('二'));
    expect(fake.send).toHaveBeenCalledTimes(2);
  });
});


describe('s35 child lifecycle at the orchestrator boundary', () => {
  const child: AgentEvent = { type: 'subagent_start', id: 'child', name: 'reviewer', task: 'Inspect', stoppable: true };
  const click = (a: string, value: object = {}, chatId = 'chat', openId = 'owner', m = 'card-1') => orchestrator.dispatcher.handle({
    messageId: m, chatId, operator: { openId }, action: { value: { a, m, ...value } },
  } as never);

  it.each([false, true])('warns on single-stop refusal only while the row is running: terminal=%s', async terminal => {
    let finish!: () => void; const held = new Promise<void>(r => { finish = r; });
    const run = fakeThread(async function* (id) { yield child; if (terminal) yield { type: 'subagent_status', id: 'child', status: 'completed' }; await held; yield { type: 'done', turnId: id }; });
    const original = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = input => ({ ...original(input), stopSubagent: async () => { throw Error('stop refused'); } });
    const o = setup(run.t); await o.onMessage(message('Work'));
    await until(() => expect(JSON.stringify(fake.live.mock.calls)).toContain(terminal ? '已完成' : 'reviewer'));
    await click('run.stopSub', { subagentId: 'child' }); await sleep(20);
    expect(replied('stop refused')).toBe(!terminal); finish(); await until(() => expect(finals('done')).toHaveLength(1));
  });

  it('heals each valid stale child/page button once and ignores forged element identities', async () => {
    setup(); fake.deleteElement.mockRejectedValueOnce(new Error('controls already removed'));
    for (const e of ['sb_0123456789ab', 'sb_abcdef012345', 'sb_x', 'so_0123456789ab']) await click('run.stopSub', { e, subagentId: 'child' }, 'chat', 'owner', 'orphan');
    await click('run.subPage', {}, 'chat', 'owner', 'orphan');
    await until(() => expect(fake.deleteElement).toHaveBeenCalledTimes(7));
    const ids = fake.deleteElement.mock.calls.map(call => z.object({ path: z.object({ element_id: z.string() }) }).parse(call[0]).path.element_id);
    expect(ids.filter(id => id.startsWith('sb_'))).toEqual(['sb_0123456789ab', 'sb_abcdef012345']); expect(ids).toContain('sp_next');
    await click('run.stopSub', { e: 'sb_0123456789ab', subagentId: 'child' }, 'chat', 'owner', 'orphan');
    expect(fake.deleteElement).toHaveBeenCalledTimes(7);
  });

  it('accepts paging for allowed members, rejects illegal pages and never bypasses the chat gate', async () => {
    const o = setup(silentThread().t); await o.onMessage(message('Work')); await until(() => expect(fake.live).toHaveBeenCalled());
    fake.live.mockClear();
    await click('run.subPage', { p: 1 }, 'chat', 'other'); expect(fake.live).toHaveBeenCalledTimes(1);
    for (const p of [-1, 'x', 1.5]) await click('run.subPage', { p });
    await click('run.subPage', { p: 2 }, 'blocked-chat'); expect(fake.live).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('queues new input or gracefully stops while waiting for children: stop=%s', async stop => {
    let finish!: () => void; const held = new Promise<void>(r => { finish = r; }); let waiting = false;
    const run = fakeThread(async function* (id, n) { if (n === 1) { yield child; waiting = true; yield { type: 'awaiting_subagents' }; await held; yield { type: 'subagent_status', id: 'child', status: stop ? 'stopped' : 'completed' }; } yield { type: 'done', turnId: id }; });
    const original = run.t.runStreamed.bind(run.t); run.t.runStreamed = input => ({ ...original(input), turnId: () => waiting ? undefined : 'turn-1' });
    run.t.abort.mockImplementation(async () => { finish(); });
    const o = setup(run.t); await o.onMessage(message('Work')); await until(() => expect(JSON.stringify(fake.live.mock.calls)).toContain('等 1 个子 agent'));
    if (stop) { await click('run.stop'); await until(() => expect(finals('interrupted')).toHaveLength(1)); expect(run.t.abort).toHaveBeenCalledExactlyOnceWith('turn-1'); expect(run.t.close).not.toHaveBeenCalled(); }
    else { await o.onMessage(message('Next')); expect(run.consumed).toHaveLength(1); expect(run.t.steer).not.toHaveBeenCalled(); finish(); await until(() => expect(run.consumed).toHaveLength(2)); }
  });

  it('merges twenty child steps into the next clock frame instead of pushing twenty cards', async () => {
    let steps!: () => void; const gate = new Promise<void>(r => { steps = r; }); let finish!: () => void; const held = new Promise<void>(r => { finish = r; }); let delivered = false;
    const run = fakeThread(async function* (id) { yield child; await gate; for (let n = 0; n < 20; n++) yield { type: 'subagent_step', id: 'child', stepId: String(n), title: 'step', status: 'running' }; delivered = true; await held; yield { type: 'done', turnId: id }; });
    vi.useFakeTimers();
    try {
    const o = setup(run.t); await o.onMessage(message('Work')); await until(() => expect(JSON.stringify(fake.live.mock.calls)).toContain('reviewer'));
    const count = fake.live.mock.calls.length; steps(); await until(() => expect(delivered).toBe(true)); expect(fake.live).toHaveBeenCalledTimes(count); finish(); await until(() => expect(finals('done')).toHaveLength(1));
    } finally { finish(); vi.useRealTimers(); }
  });

  it('keeps child origin and waiting identity even when parent card pushes fail', async () => {
    fake.live.mockImplementation(() => false); let finish!: () => void; const held = new Promise<void>(r => { finish = r; });
    const request = { kind: 'confirmation', id: 'q', title: 'Proceed?', detail: '', acceptedConsequence: 'Continue', declinedConsequence: 'Stop' } as const;
    const run = fakeThread(async function* (id) { yield child; yield { type: 'ask', request, subagentId: 'child' }; await held; yield { type: 'done', turnId: id }; });
    const original = run.t.runStreamed.bind(run.t); run.t.runStreamed = input => ({ ...original(input), respondToAsk: async () => {} });
    const o = setup(run.t); await o.onMessage(message('Work')); await until(() => expect(fake.managed).toHaveBeenCalled());
    expect(JSON.stringify(fake.managed.mock.calls)).toContain('子 agent reviewer 问：'); expect(JSON.stringify(fake.live.mock.calls)).toContain('回答（见下方卡片）'); finish(); await until(() => expect(finals('done')).toHaveLength(1));
  });

  it('carries a live row across goal turns and retains a step between them without an empty card', async () => {
    let next!: () => void; const gap = new Promise<void>(r => { next = r; });
    const goal = Object.assign(scriptedThread([]).t, { clearGoal: vi.fn(async () => {}), runGoal: () => ({ turnId: () => 'g', events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId: 'g1' }; yield child; yield { type: 'text_delta', itemId: 'a', delta: 'first' }; yield { type: 'done', turnId: 'g1' };
      yield { type: 'subagent_step', id: 'child', stepId: 'gap', title: 'between turns', status: 'running' }; await gap;
      yield { type: 'turn_started', turnId: 'g2' }; yield { type: 'text_delta', itemId: 'b', delta: 'second' }; yield { type: 'subagent_status', id: 'child', status: 'completed' }; yield { type: 'done', turnId: 'g2' };
      yield { type: 'goal_update', status: 'complete', objective: 'Work', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: null };
    })() }) });
    const o = setup(goal); await o.onMessage(message('/goal Work')); await until(() => expect(finalCards().join()).toContain('接着显示在下一张卡'));
    expect(fake.createCard).toHaveBeenCalledTimes(1); next(); await until(() => expect(fake.managed).toHaveBeenCalled());
    expect(fake.createCard).toHaveBeenCalledTimes(2); expect(finalCards().join()).toContain('between turns'); expect(finalCards().join()).toContain('1 步');
  });
});


it('restores a completed goal child when reused without another start event', async () => {
  const goal = Object.assign(scriptedThread([]).t, { clearGoal: vi.fn(async () => {}), runGoal: () => ({ turnId: () => 'g', events: (async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'turn_started', turnId: 'g1' }; yield { type: 'subagent_start', id: 'reused', name: 'reused worker', task: 'Inspect', stoppable: true };
    yield { type: 'subagent_status', id: 'reused', status: 'completed' }; yield { type: 'text_delta', itemId: 'a', delta: 'first' }; yield { type: 'done', turnId: 'g1' };
    yield { type: 'turn_started', turnId: 'g2' }; yield { type: 'subagent_status', id: 'reused', status: 'running' }; yield { type: 'subagent_step', id: 'reused', stepId: 'reuse', title: 'resumed work', status: 'running' };
    yield { type: 'text_delta', itemId: 'b', delta: 'second' }; yield { type: 'subagent_status', id: 'reused', status: 'completed' }; yield { type: 'done', turnId: 'g2' };
    yield { type: 'goal_update', status: 'complete', objective: 'Work', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: null };
  })() }) });
  const o = setup(goal); await o.onMessage(message('/goal Work')); await until(() => expect(fake.managed).toHaveBeenCalled());
  const resumed = finalCards().find(card => card.includes('resumed work'));
  expect(resumed).toBeDefined(); expect(resumed).toContain('1 步');
  expect(JSON.stringify(fake.live.mock.calls)).toContain('"subagentId":"reused"');
});

it.each([false, true])('keeps the latest between-turn goal child terminal without a new card: completed=%s', async completed => {
  const goal = Object.assign(scriptedThread([]).t, { clearGoal: vi.fn(async () => {}), runGoal: () => ({ turnId: () => 'g', events: (async function* (): AsyncGenerator<AgentEvent> {
    yield { type: 'turn_started', turnId: 'g1' }; yield { type: 'subagent_start', id: 'child', name: 'worker', task: 'Inspect', stoppable: true }; yield { type: 'text_delta', itemId: 'a', delta: 'answer' }; yield { type: 'done', turnId: 'g1' };
    if (completed) yield { type: 'subagent_status', id: 'child', status: 'completed' };
    yield { type: 'goal_update', status: 'complete', objective: 'Work', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: null };
  })() }) });
  const o = setup(goal); await o.onMessage(message('/goal Work')); await until(() => expect(fake.managed).toHaveBeenCalled());
  expect(fake.createCard).toHaveBeenCalledTimes(1); expect(finalCards().at(-1)).toContain('worker：Inspect'); expect(finalCards().at(-1)).not.toContain('接着显示在下一张卡');
  expect(finalCards().at(-1)?.includes('没收到结束消息')).toBe(!completed);
});

describe('goal child questions across parent turns', () => {
  const request = (id: string) => ({ kind: 'confirmation', id, title: id, detail: '', acceptedConsequence: 'Continue', declinedConsequence: 'Stop' } as const);
  function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
  function goalRun(play: () => AsyncIterable<AgentEvent>) {
    const response = vi.fn<NonNullable<AgentRun['respondToAsk']>>(async () => {});
    const thread = Object.assign(scriptedThread([]).t, { clearGoal: vi.fn(async () => {}),
      runGoal: () => ({ turnId: () => 'g', respondToAsk: response, events: play() }) });
    return { thread, response };
  }
  const child: AgentEvent = { type: 'subagent_start', id: 'C', name: 'worker', task: 'Inspect', stoppable: true };
  const complete: AgentEvent = { type: 'goal_update', status: 'complete', objective: 'Work', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: null };
  const answer = (id: string, carrier = 'managed') => orchestrator.dispatcher.handle({ messageId: carrier, chatId: 'chat', operator: { openId: 'owner' },
    action: { value: { a: 'ask_submit', requestId: id, decision: 'proceed' } } } as never);

  it.each([false, true])('keeps a child question answerable across done and next started: askBeforeDone=%s', async before => {
    const done = gate(), next = gate(), finish = gate(); let inGap = false, inNext = false;
    const f = goalRun(async function* () {
      yield { type: 'turn_started', turnId: 'g1' }; yield child; yield { type: 'text_delta', itemId: 'a', delta: 'first' };
      if (before) yield { type: 'ask', request: request('child-q'), subagentId: 'C' };
      await done.promise; yield { type: 'done', turnId: 'g1' };
      if (!before) yield { type: 'ask', request: request('child-q'), subagentId: 'C' };
      inGap = true; await next.promise; yield { type: 'turn_started', turnId: 'g2' }; inNext = true;
      await finish.promise; yield { type: 'subagent_status', id: 'C', status: 'completed' }; yield { type: 'done', turnId: 'g2' }; yield complete;
    });
    const o = setup(f.thread); await o.onMessage(message('/goal Work'));
    if (before) await until(() => expect(JSON.stringify(fake.managed.mock.calls)).toContain('child-q'));
    done.release(); await until(() => expect(inGap).toBe(true));
    expect(f.thread.clearGoal).not.toHaveBeenCalled(); expect(f.response).not.toHaveBeenCalled();
    await until(() => expect(JSON.stringify(fake.managed.mock.calls)).toContain('子 agent worker 问：'));
    if (!before) { next.release(); await until(() => expect(inNext).toBe(true)); }
    await answer('child-q'); await answer('child-q');
    expect(f.response).toHaveBeenCalledExactlyOnceWith('child-q', { kind: 'answered', answer: { kind: 'confirmation', decision: 'proceed' } });
    next.release(); finish.release(); await until(() => expect(f.thread.close).toHaveBeenCalled());
  });

  it('ends only parent questions while keeping one FIFO for child and next-parent questions', async () => {
    const done = gate(), next = gate(), finish = gate(); let inGap = false, inNext = false; let count = 0;
    fake.managed.mockImplementation(async () => ({ messageId: `qcard-${++count}` }));
    const f = goalRun(async function* () {
      yield { type: 'turn_started', turnId: 'g1' }; yield child;
      yield { type: 'ask', request: request('parent-1') }; yield { type: 'ask', request: request('child-q'), subagentId: 'C' };
      await done.promise; yield { type: 'done', turnId: 'g1' }; inGap = true; await next.promise;
      yield { type: 'turn_started', turnId: 'g2' }; yield { type: 'ask', request: request('parent-2') }; inNext = true;
      await finish.promise; yield { type: 'done', turnId: 'g2' }; yield complete;
    });
    const o = setup(f.thread); await o.onMessage(message('/goal Work')); await until(() => expect(count).toBe(1));
    done.release(); await until(() => expect(inGap).toBe(true)); await until(() => expect(count).toBe(2));
    expect(f.response.mock.calls).toEqual([['parent-1', { kind: 'unanswered', reason: 'turn-ended' }]]);
    next.release(); await until(() => expect(inNext).toBe(true)); expect(count).toBe(2);
    await answer('parent-1', 'qcard-1'); expect(f.response).toHaveBeenCalledTimes(1);
    await answer('child-q', 'qcard-2'); await until(() => expect(count).toBe(3));
    await answer('parent-2', 'qcard-3'); expect(f.response.mock.calls.map(c => c[0])).toEqual(['parent-1', 'child-q', 'parent-2']);
    finish.release(); await until(() => expect(f.thread.close).toHaveBeenCalled());
  });

  it.each(['child-terminal', 'cancel', 'goal-terminal', 'stop', 'endGoal', 'shutdown'] as const)('cleans the child question on %s and ignores late answer/cancellation', async reason => {
    const end = gate(), finish = gate(); let cleaned = false;
    const f = goalRun(async function* () {
      yield { type: 'turn_started', turnId: 'g1' }; yield child; yield { type: 'text_delta', itemId: 'a', delta: 'first' };
      yield { type: 'done', turnId: 'g1' };
      if (reason === 'endGoal') { yield { type: 'turn_started', turnId: 'g2' }; yield { type: 'text_delta', itemId: 'b', delta: 'second' }; }
      yield { type: 'ask', request: request('child-q'), subagentId: 'C' };
      await end.promise;
      if (reason === 'endGoal') { yield { type: 'turn_started', turnId: 'g3' }; yield { type: 'ask', request: request('late-child'), subagentId: 'C' }; yield { type: 'done', turnId: 'g3' }; }
      if (reason === 'child-terminal' || reason === 'cancel') {
        yield { type: 'ask_cancelled', requestId: 'child-q' };
        if (reason === 'child-terminal') yield { type: 'subagent_status', id: 'C', status: 'completed' };
        cleaned = true; await finish.promise; yield { type: 'ask_cancelled', requestId: 'child-q' };
      }
      yield complete;
    });
    const o = setup(f.thread); await o.onMessage(message('/goal Work')); await until(() => expect(JSON.stringify(fake.managed.mock.calls)).toContain('child-q'));
    expect(f.response).not.toHaveBeenCalled();
    if (reason === 'stop') {
      fake.sessions = [{ threadId: 'topic', chatId: 'chat', cwd: '/test', sessionId: 'host', backend: 'codex', summary: '' }];
      const target = { projectName: 'test', chatId: 'chat', threadId: 'topic' };
      const context = z.object({ run: z.object({ id: z.string() }) }).parse(await o.collaboration({ action: 'context', ...target }));
      await o.collaboration({ action: 'stop', ...target, runId: context.run.id });
    }
    else if (reason === 'endGoal') await press('goal.end', 'card-2');
    else if (reason === 'shutdown') await o.shutdown();
    else { end.release(); if (reason === 'child-terminal' || reason === 'cancel') await until(() => expect(cleaned).toBe(true)); else await until(() => expect(f.thread.close).toHaveBeenCalled()); }
    await answer('child-q');
    if (reason === 'child-terminal' || reason === 'cancel') expect(f.response).not.toHaveBeenCalled();
    else expect(f.response).toHaveBeenCalledExactlyOnceWith('child-q', { kind: 'unanswered', reason: reason === 'goal-terminal' ? 'turn-ended' : 'stopped' });
    end.release(); finish.release(); await until(() => expect(f.thread.close).toHaveBeenCalled());
    expect(f.response).toHaveBeenCalledTimes(reason === 'endGoal' ? 2 : reason === 'child-terminal' || reason === 'cancel' ? 0 : 1);
    if (reason === 'endGoal') {
      expect(f.response).toHaveBeenLastCalledWith('late-child', { kind: 'unanswered', reason: 'unavailable' });
      expect(JSON.stringify(fake.managed.mock.calls)).not.toContain('late-child');
    }
  });
  it.each([false, true])('keeps sensitive child questions private across parent boundaries and stop: askBeforeDone=%s', async before => {
    const done = gate(), next = gate(), finish = gate(); let inGap = false, inNext = false, count = 0;
    fake.managed.mockImplementation(async () => ({ messageId: `private-card-${++count}` }));
    const secret = 'fixture-private-answer';
    const sensitive = (id: string): AskRequest => ({ kind: 'choices', id, title: id, acceptedConsequence: 'Continue', declinedConsequence: 'Stop',
      questions: [{ id: 'q', title: 'Private input', detail: '', selection: 'text', sensitive: true }] });
    const f = goalRun(async function* () {
      yield { type: 'turn_started', turnId: 'g1' }; yield child; yield { type: 'text_delta', itemId: 'a', delta: 'first' };
      if (before) yield { type: 'ask', request: sensitive('secret-first'), subagentId: 'C' };
      await done.promise; yield { type: 'done', turnId: 'g1' };
      if (!before) yield { type: 'ask', request: sensitive('secret-first'), subagentId: 'C' };
      inGap = true; await next.promise; yield { type: 'turn_started', turnId: 'g2' }; yield { type: 'text_delta', itemId: 'b', delta: 'second' };
      yield { type: 'ask', request: sensitive('secret-second'), subagentId: 'C' }; inNext = true;
      await finish.promise; yield { type: 'done', turnId: 'g2' }; yield complete;
    });
    const o = setup(f.thread); await o.onMessage(message('/goal Work'));
    const carrier = (id: string, recipient: string) => {
      const index = fake.managed.mock.calls.findIndex(call => call[1] === recipient && JSON.stringify(call[2]).includes(id));
      expect(index).toBeGreaterThanOrEqual(0); return `private-card-${index + 1}`;
    };
    const click = (id: string, recipient: string) => o.dispatcher.handle({ messageId: carrier(id, recipient), chatId: recipient === 'chat' ? 'chat' : 'p2p', operator: { openId: 'owner' },
      action: { value: { a: 'ask_submit', requestId: id, decision: 'submit' } }, raw: { action: { form_value: { q0: secret } } } } as never);
    if (before) await until(() => expect(count).toBe(3));
    done.release(); await until(() => expect(inGap).toBe(true)); await until(() => expect(count).toBe(3));
    expect(f.thread.clearGoal).not.toHaveBeenCalled(); expect(f.response).not.toHaveBeenCalled();
    for (const call of fake.managed.mock.calls) {
      const card = JSON.stringify(call[2]); expect(card).toContain('子 agent worker 问：');
      expect(card.includes('"tag":"form"')).toBe(call[1] !== 'chat');
      if (call[1] === 'chat') expect(card).not.toContain('"tag":"input"');
    }
    await click('secret-first', 'chat'); expect(f.response).not.toHaveBeenCalled();
    next.release(); await until(() => expect(inNext).toBe(true)); expect(count).toBe(3);
    await o.onMessage({ ...message(secret), chatType: 'p2p', chatId: 'p2p', threadId: undefined });
    expect(f.response).toHaveBeenCalledExactlyOnceWith('secret-first', { kind: 'answered', answer: { kind: 'text', text: secret } });
    await until(() => expect(count).toBe(6)); await click('secret-first', 'owner'); expect(f.response).toHaveBeenCalledTimes(1);
    fake.sessions = [{ threadId: 'topic', chatId: 'chat', cwd: '/test', sessionId: 'host', backend: 'codex', summary: '' }];
    const target = { projectName: 'test', chatId: 'chat', threadId: 'topic' };
    const context = z.object({ run: z.object({ id: z.string() }) }).parse(await o.collaboration({ action: 'context', ...target }));
    await o.collaboration({ action: 'stop', ...target, runId: context.run.id });
    await click('secret-second', 'owner'); await until(() => expect(f.thread.close).toHaveBeenCalled());
    expect(f.response.mock.calls).toEqual([['secret-first', { kind: 'answered', answer: { kind: 'text', text: secret } }], ['secret-second', { kind: 'unanswered', reason: 'stopped' }]]);
    const updates = fake.updated.mock.calls;
    for (const recipient of ['chat', 'owner', 'admin']) {
      for (const id of ['secret-first', 'secret-second']) {
        const patch = updates.find(call => call[1] === carrier(id, recipient)); expect(patch).toBeDefined();
        expect(JSON.stringify(patch)).toContain(id === 'secret-first' ? recipient === 'chat' ? '已在私聊里回答' : recipient === 'owner' ? '已提交' : '已由' : '已停止');
        expect(JSON.stringify(patch)).not.toContain('"tag":"form"');
      }
    }
    expect(JSON.stringify([fake.managed.mock.calls, updates, fake.live.mock.calls, fake.final.mock.calls, fake.send.mock.calls, fake.log.info.mock.calls, fake.log.warn.mock.calls, fake.log.fail.mock.calls])).not.toContain(secret);
    finish.release();
  });

});

describe('agent entry authority during compact and retry', () => {
  const registry = () => createAgentEntries({ appId: 'fixture', isAdmin: () => true, isOwner: () => true });
  const human = (text: string) => ({ ...message(text), raw: { sender: { sender_type: 'user' } } });
  it('closes the triggering authority before running a queued manual compaction', async () => {
    let finish: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const run = fakeThread(async function* (turnId) { await gate; yield { type: 'done', turnId }; });
    const entries = registry();
    let grant: AgentEntry;
    const compactChecked = vi.fn();
    const compact = vi.fn(async () => {
      await expect(grant.call('session_info', {})).resolves.toMatchObject({ result: { turn: 'none' } });
      compactChecked();
      return {};
    });
    Object.assign(run.t, { compact });
    const o = setup(run.t, ['chat'], entries);
    await o.onMessage(human('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    grant = fake.backend.resumeThread.mock.calls[0]![0].entry;
    await expect(grant.call('session_info', {})).resolves.toMatchObject({ result: { turn: 'person' } });
    await o.onMessage(human('/compact'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'compact-queued', expect.anything()));
    expect(compact).not.toHaveBeenCalled();
    finish?.();
    await until(() => expect(compactChecked).toHaveBeenCalledOnce());
    expect(compact).toHaveBeenCalledOnce();
  });
  it('replays through the retry button without reusing the original human authority', async () => {
    const entries = registry(), open = vi.spyOn(entries, 'openTurn'), checked = vi.fn();
    const run = fakeThread(async function* (turnId, n) {
      const grant: AgentEntry = fake.backend.resumeThread.mock.calls[0]![0].entry;
      await expect(grant.call('session_info', {})).resolves.toMatchObject({ result: { turn: n === 1 ? 'person' : 'other' } });
      if (n === 1) yield NETWORK;
      else { checked(); yield { type: 'done', turnId }; }
    });
    const o = setup(run.t, ['chat'], entries);
    await o.onMessage(human('retry this message'));
    await until(() => expect(offersRetry('card-1')).toBe(true));
    await tap('card-1');
    await until(() => expect(checked).toHaveBeenCalledOnce());
    expect(run.consumed).toHaveLength(2);
    expect(open).toHaveBeenLastCalledWith(run.t, expect.objectContaining({ retry: true }));
  });
});

// devices-4a 4.3: a session's shell carries the token the host issued for it, never the bare marker; no token, no session.
describe('session token', () => {
  const human = (text: string) => ({ ...message(text), raw: { sender: { sender_type: 'user' } } });
  const TOKEN = `vs1.ses_0123456789abcdef.${'a'.repeat(43)}`;
  // main 必败: the session started with VONVON_SESSION=1
  it('starts the session with its token in the environment', async () => {
    const sessions = { revoke: vi.fn() };
    const entries = createAgentEntries({ appId: 'app', isAdmin: () => true, isOwner: () => true, sessions });
    const host = { issueSessionToken: vi.fn(async () => TOKEN) };
    const run = scriptedThread([]);
    const o = setup(run.t, ['chat'], entries, host);
    await o.onMessage(human('hi'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const opts = fake.backend.resumeThread.mock.calls[0]![0] as { entry: AgentEntry; profile: { env: Record<string, string> } };
    expect(host.issueSessionToken).toHaveBeenCalledWith({ appId: 'app', place: 'group', chatId: 'chat', sessionId: opts.entry.sessionId });
    expect(opts.profile.env.VONVON_SESSION).toBe(TOKEN);
    expect(inBotSession(opts.profile.env)).toBe(true);
    expect(sessions.revoke).not.toHaveBeenCalled();
  });
  it('does not start a session the host gave no token for', async () => {
    const sessions = { revoke: vi.fn() };
    const entries = createAgentEntries({ appId: 'app', isAdmin: () => true, isOwner: () => true, sessions });
    const host = { issueSessionToken: vi.fn(async () => { throw new Error('vonvon 主进程 5000ms 未响应'); }) };
    const run = scriptedThread([]);
    const o = setup(run.t, ['chat'], entries, host);
    await o.onMessage(human('hi'));
    // each attempt (the resume, then a new session) got its own entry, ended when its token did not come
    const issued = () => (host.issueSessionToken.mock.calls as unknown as Array<[{ sessionId: string }]>).map(([input]) => input.sessionId);
    await until(() => { expect(issued().length).toBeGreaterThan(0); expect(sessions.revoke.mock.calls.map(([id]) => id)).toEqual(issued()); });
    await sleep(200);
    expect(sessions.revoke.mock.calls.map(([id]) => id)).toEqual(issued());
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });
});
