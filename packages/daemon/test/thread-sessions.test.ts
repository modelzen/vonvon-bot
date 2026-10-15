import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  project: { name: 'test', chatId: 'chat', cwd: '/test', kind: 'single' } as Record<string, unknown>,
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  history: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true })),
  get: vi.fn(async ({ path }: { path: { message_id: string } }) => ({ data: { items: [{
    message_id: path.message_id, thread_id: 'omt_new', msg_type: 'text', create_time: '1',
    sender: { id: 'ou_q', sender_type: 'user', sender_name: '王五' }, body: { content: JSON.stringify({ text: `${path.message_id} 的原话` }) },
  }] } })),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => fake.project,
}));
vi.mock('../src/bot/context-weave', async (original) => ({
  ...await original<object>(),
  fetchThreadContext: fake.history,
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async (key: string) => fake.records.get(key),
  patchSession: async (key: string, patch: object | ((r: object) => object)) => {
    const r = fake.records.get(key);
    if (r) Object.assign(r, typeof patch === 'function' ? patch({ ...r }) : patch);
  },
  upsertSession: async (record: { threadId: string }) => { fake.records.set(record.threadId, record); },
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.createCard;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = fake.final;
    finalizeCard = fake.final;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createOrchestrator, sessionChangeNotice } from '../src/bot/handle-message';
import { createTopicRegistry, type TopicRegistry } from '../src/bot/topic-registry';
import type { AppConfig } from '../src/config/schema';

function thread(sessionId: string) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId, isAlive: () => true,
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      return {
        turnId: () => 'turn',
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: 'turn' };
          yield { type: 'done', turnId: 'turn' };
        })(),
      };
    },
  };
  return { t, consumed };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string, threadId?: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', ...(threadId ? { threadId } : {}),
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false, ...extra };
}
function setup(topics?: TopicRegistry) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: fake.get }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test', topics);
  return orchestrator;
}
const record = (key: string, extra: object = {}) => ({ threadId: key, chatId: 'chat', sessionId: `old-${key}`, backend: 'codex', cwd: '/test', summary: '', model: 'm', effort: 'medium', lastSeenAt: 1, ...extra });
const finalCard = () => JSON.stringify(fake.final.mock.calls.at(-1));
const done = () => vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

beforeEach(() => {
  vi.clearAllMocks();
  fake.records.clear();
  fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'single' };
  fake.backend.listModels.mockResolvedValue([{ id: 'm', displayName: 'M', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false }] as never);
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.history.mockReset().mockResolvedValue({ messages: [], ok: true, complete: true });
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  await orchestrator?.shutdown();
});

describe('topics in a single-session group', () => {
  it('gives a topic its own session and leaves the chat session alone', async () => {
    fake.records.set('chat', record('chat'));
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('in the topic', 'omt_topic'));
    await done();
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(fake.records.get('omt_topic')).toMatchObject({ threadId: 'omt_topic', chatId: 'chat', sessionId: 'topic-session' });
    expect(fake.records.get('chat')).toMatchObject({ sessionId: 'old-chat' });
    expect(fake.history).toHaveBeenCalledWith(expect.anything(), 'omt_topic', expect.anything());
    expect(fake.createCard.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({ replyInThread: true })]));
    expect(finalCard()).not.toContain('⚠️');
  });

  it('keeps main-area messages on the chat session', async () => {
    fake.records.set('chat', record('chat'));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('main area'));
    await done();
    expect(fake.backend.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-chat' }));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    expect(fake.records.has('omt_topic')).toBe(false);
  });

  it('answers /clear inside a topic without switching sessions', async () => {
    const o = setup();
    await o.onMessage(message('/clear', 'omt_topic'));
    expect(fake.send).toHaveBeenCalledWith('chat', { markdown: expect.stringContaining('开一个新话题') }, expect.objectContaining({ replyInThread: true }));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });
});

describe('forced session change notice', () => {
  it('says so on the run card when the resume fails', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    const fresh = thread('fresh');
    fake.backend.resumeThread.mockRejectedValue(new Error('no rollout'));
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage(message('again', 'omt_topic'));
    await done();
    const notice = sessionChangeNotice('resume-failed', true);
    expect(JSON.stringify(fake.createCard.mock.calls[0])).toContain(notice);
    expect(finalCard()).toContain(notice);
    expect(fake.records.get('omt_topic')).toMatchObject({ sessionId: 'fresh' });
    expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-changed', { sessionKey: 'omt_topic', reason: 'resume-failed' });
  });

  it('says so on the run card when the cwd changed', async () => {
    fake.records.set('chat', record('chat', { cwd: '/old' }));
    const fresh = thread('fresh');
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage(message('main area'));
    await done();
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(fake.backend.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/test' }));
    expect(finalCard()).toContain(sessionChangeNotice('cwd-changed', false));
  });

  it('shows nothing on a normal resume, and only on the first card after a change', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    const fresh = thread('fresh');
    fake.backend.resumeThread.mockRejectedValueOnce(new Error('gone'));
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage(message('first', 'omt_topic'));
    await done();
    fake.log.info.mockClear();
    await o.onMessage(message('second', 'omt_topic'));
    await done();
    expect(fresh.consumed).toHaveLength(2);
    expect(finalCard()).not.toContain('⚠️');
  });

  it('puts the notice in the failure reply when the first card cannot be created', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    const fresh = thread('fresh');
    fake.backend.resumeThread.mockRejectedValue(new Error('no rollout'));
    fake.backend.startThread.mockResolvedValue(fresh.t);
    fake.createCard.mockRejectedValueOnce(new Error('card api down'));
    const o = setup();
    await o.onMessage(message('again', 'omt_topic'));
    const notice = sessionChangeNotice('resume-failed', true);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith('chat',
      { markdown: expect.stringContaining('card api down') }, expect.objectContaining({ replyInThread: true })));
    expect(JSON.stringify(fake.send.mock.calls.at(-1))).toContain(notice);
  });

  it('does not repeat the notice in a failure reply once a card showed it', async () => {
    fake.records.set('chat', record('chat', { cwd: '/old' }));
    const fresh = thread('fresh');
    fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup();
    await o.onMessage(message('main area'));
    await done();
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('工作目录改了');
  });

  it('words the notice by reason and location', () => {
    expect(sessionChangeNotice('cwd-changed', false)).toContain('工作目录改了');
    expect(sessionChangeNotice('resume-failed', false)).not.toContain('话题');
    expect(sessionChangeNotice('resume-failed', true)).toContain('话题里最近的消息已重新带上');
  });
});

describe('names and watermark (s09)', () => {
  const quoted = (id: string) => fake.get.mock.calls.some(([p]) => p.path.message_id === id);
  const ctx = (messageId: string, text: string, createTime: number) => ({ messageId, senderName: '李四', text, fromUser: true, createTime });

  it('does not re-quote the topic root on a later turn, but keeps a reply quote in the main area', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    fake.records.set('chat', record('chat'));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('in the topic', 'omt_topic', { rootId: 'om_root', replyToMessageId: 'om_root' }));
    await done();
    expect(quoted('om_root')).toBe(false);
    expect(run.consumed[0]!.text).not.toContain('用户引用了一条消息');
    fake.log.info.mockClear();
    await o.onMessage(message('replying', undefined, { rootId: 'om_x', replyToMessageId: 'om_x' }));
    await done();
    expect(run.consumed[1]!.text).toContain('[用户引用了一条消息（来自 王五）：\nom_x 的原话\n]');
  });

  it('quotes a reply to another message inside the topic', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('this one', 'omt_topic', { rootId: 'om_root', replyToMessageId: 'om_t1' }));
    await done();
    expect(run.consumed[0]!.text).toContain('om_t1 的原话');
  });

  it("gives a new topic session the topic's first message once, when the listing leaves it out", async () => {
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first time here', 'omt_topic', { rootId: 'om_root', replyToMessageId: 'om_root' }));
    await done();
    expect(run.consumed[0]!.text).toContain('[话题中在此之前已有的消息');
    expect(run.consumed[0]!.text).toContain('王五：om_root 的原话');
    expect(run.consumed[0]!.text).not.toContain('用户引用了一条消息');
  });

  it('writes the watermark when the bot opens a topic, so its next turn catches up the chatter', async () => {
    fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'multi' };
    const run = thread('opened');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    const opener = message('open a topic');
    await o.onMessage(opener);
    await done();
    expect(fake.records.get('omt_new')).toMatchObject({ lastSeenAt: opener.createTime, seen: [{ id: opener.messageId, at: opener.createTime }] });
    fake.log.info.mockClear();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_chat', '中间别人说的', opener.createTime + 1)] });
    await o.onMessage(message('@bot 接着说', 'omt_new', { rootId: opener.messageId, replyToMessageId: opener.messageId }));
    await done();
    expect(fake.history).toHaveBeenLastCalledWith(expect.anything(), 'omt_new', expect.objectContaining({ stopAt: opener.createTime }));
    expect(run.consumed.at(-1)!.text).toContain('李四：中间别人说的');
  });

  it('does not move the watermark when the back-fill fails', async () => {
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: 5 }));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.history.mockResolvedValueOnce({ ok: false, complete: false, messages: [] });
    const o = setup();
    const m = message('pull fails', 'omt_topic');
    await o.onMessage(m);
    await done();
    await vi.waitFor(() => expect(fake.records.get('omt_topic').seen).toEqual([{ id: m.messageId, at: m.createTime }]));
    expect(fake.records.get('omt_topic').lastSeenAt).toBe(5);
  });

  it('skips a late re-push the session already took in, and says when a late one is answered', async () => {
    const now = Date.now();
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: now - 60_000 }));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('sent while offline', 'omt_topic', { createTime: now - 5 * 60_000 }));
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'late-redelivery-skipped', expect.objectContaining({ msgId: `msg-${seq}` }));
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: now - 10 * 60_000 }));
    await o.onMessage(message('never seen', 'omt_topic', { createTime: now - 5 * 60_000 }));
    await done();
    expect(run.consumed[0]!.text).toContain('（这条消息 5 分钟前发出，bot 断线重连后才收到）');
  });

  /** A thread whose first turn/start the host rejects (no turn_started). */
  function rejectingFirstTurn(run: ReturnType<typeof thread>) {
    return { ...run.t, runStreamed(input: AgentInput) {
      run.consumed.push(input);
      return { turnId: () => undefined, events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'error', message: 'turn/start rejected', willRetry: false };
      })() };
    } };
  }

  it('moves the watermark only once the host accepts the turn, so a re-push after a restart is answered', async () => {
    const now = Date.now();
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: 5 }));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValueOnce(rejectingFirstTurn(run)).mockResolvedValue(run.t);
    fake.history.mockResolvedValue({ ok: true, complete: true, messages: [ctx('om_h', '补拉的那句', now - 6 * 60_000)] });
    const o = setup();
    const trigger = message('the trigger', 'omt_topic', { createTime: now - 5 * 60_000 });
    await o.onMessage(trigger);
    await done();
    expect(run.consumed[0]!.text).toContain('李四：补拉的那句');
    expect(fake.records.get('omt_topic').lastSeenAt).toBe(5);
    expect(fake.records.get('omt_topic').seen ?? []).toEqual([]);
    // The daemon restarts (the in-memory dedup is gone) and Feishu re-pushes the trigger.
    await o.shutdown();
    fake.log.info.mockClear();
    const again = setup();
    await again.onMessage(trigger);
    await done();
    expect(fake.log.info).not.toHaveBeenCalledWith('intake', 'late-redelivery-skipped', expect.anything());
    expect(run.consumed[1]!.text).toContain('李四：补拉的那句');
    await vi.waitFor(() => expect(fake.records.get('omt_topic').lastSeenAt).toBe(trigger.createTime));
  });

  it('starts a new topic session with nothing seen until its first turn is accepted', async () => {
    const run = thread('topic-session');
    const ok = thread('other-session');
    fake.backend.startThread.mockResolvedValueOnce(rejectingFirstTurn(run)).mockResolvedValue(ok.t);
    const o = setup();
    await o.onMessage(message('first time here', 'omt_topic'));
    await done();
    expect(fake.records.get('omt_topic')).toMatchObject({ lastSeenAt: 0, seen: [] });
    fake.log.info.mockClear();
    const accepted = message('in another topic', 'omt_other');
    await o.onMessage(accepted);
    await done();
    await vi.waitFor(() => expect(fake.records.get('omt_other')).toMatchObject({
      lastSeenAt: accepted.createTime, seen: [{ id: accepted.messageId, at: accepted.createTime }],
    }));
  });

  it('resets the watermark when the session is recreated, until the new session takes a turn', async () => {
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: 5, seen: [{ id: 'om_old', at: 9 }] }));
    const fresh = thread('fresh');
    fake.backend.resumeThread.mockRejectedValue(new Error('no rollout'));
    fake.backend.startThread.mockResolvedValue(rejectingFirstTurn(fresh));
    const o = setup();
    await o.onMessage(message('again', 'omt_topic'));
    await done();
    expect(fake.records.get('omt_topic')).toMatchObject({ sessionId: 'fresh', lastSeenAt: 0, seen: [] });
  });
});

describe('topic registry (s13)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topics-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const registry = () => createTopicRegistry({ dir, sessions: async () => [...fake.records.values()] });
  const multi = () => { fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'multi', noMention: true }; };

  it("records a user's topic when first seen, and the session the bot opens there later", async () => {
    multi();
    const topics = registry();
    const o = setup(topics);
    // Addressed to someone else: not answered, still recorded, with its first message looked up once.
    const chatter = message('@李四 看下这个', 'omt_user', {
      rootId: 'om_root', mentionedBot: false, senderId: 'ou_zhang',
      mentions: [{ key: '@_user_1', openId: 'ou_li', name: '李四', isBot: false }],
    });
    await o.onMessage(chatter);
    await vi.waitFor(async () => expect(await topics.get('chat', 'omt_user')).toMatchObject({
      firstId: 'om_root', firstFrom: { kind: 'user', openId: 'ou_q' }, firstAt: 1, title: 'om_root 的原话',
      openedBy: { kind: 'user', openId: 'ou_zhang' }, openedAt: chatter.createTime, sessions: [],
    }));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    await o.onMessage(message('@bot 帮忙看下', 'omt_user', { rootId: 'om_root' }));
    await done();
    expect(await topics.get('chat', 'omt_user')).toMatchObject({
      openedBy: { kind: 'user', openId: 'ou_zhang' },
      sessions: [{ key: 'omt_user', sessionId: 'topic-session', backend: 'codex' }],
    });
    expect(fake.get.mock.calls.filter(([p]) => p.path.message_id === 'om_root').length).toBeLessThanOrEqual(2);
  });

  it('does not take a reply without root_id for the first message', async () => {
    multi();
    const topics = registry();
    const o = setup(topics);
    // Addressed to someone else, so the bot records them without answering.
    const toLi = { mentionedBot: false, mentions: [{ key: '@_user_1', openId: 'ou_li', name: '李四', isBot: false }] };
    await o.onMessage(message('@李四 同意楼上', 'omt_q', { ...toLi, replyToMessageId: 'om_parent', senderId: 'ou_zhang' }));
    await vi.waitFor(async () => expect(await topics.get('chat', 'omt_q')).toMatchObject({ openedBy: { kind: 'user', openId: 'ou_zhang' } }));
    const rec = await topics.get('chat', 'omt_q');
    expect(rec).not.toHaveProperty('firstId');
    expect(rec).not.toHaveProperty('title');
    // The next message that names the root fills it in.
    await o.onMessage(message('@李四 补一句', 'omt_q', { ...toLi, rootId: 'om_root', senderId: 'ou_wang' }));
    await vi.waitFor(async () => expect(await topics.get('chat', 'omt_q')).toMatchObject({
      firstId: 'om_root', firstFrom: { kind: 'user', openId: 'ou_q' }, title: 'om_root 的原话',
    }));
  });

  it('records a topic the bot opens from the main area as opened by itself', async () => {
    multi();
    const topics = registry();
    const run = thread('opened');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup(topics);
    const trigger = message('订单接口一直报 500', undefined, { senderId: 'ou_zhang' });
    await o.onMessage(trigger);
    await done();
    await vi.waitFor(async () => expect(await topics.get('chat', 'omt_new')).toMatchObject({
      firstId: trigger.messageId, firstFrom: { kind: 'user', openId: 'ou_zhang' }, firstAt: trigger.createTime,
      title: '订单接口一直报 500', openedBy: { kind: 'self' },
      sessions: [{ key: 'omt_new', sessionId: 'opened', backend: 'codex' }],
    }));
    // A reply in the new topic keeps it opened by the bot.
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await o.onMessage(message('@bot 接着说', 'omt_new', { rootId: trigger.messageId, senderId: 'ou_li' }));
    await done();
    expect((await topics.list('chat')).map((t) => [t.topicId, t.openedBy])).toEqual([['omt_new', { kind: 'self' }]]);
  });

  it('does not hold shutdown for a first-message lookup that hangs', async () => {
    multi();
    const topics = registry();
    const o = setup(topics);
    fake.get.mockImplementationOnce(() => new Promise(() => undefined));
    await o.onMessage(message('@李四 看下', 'omt_slow', {
      rootId: 'om_root', mentionedBot: false, senderId: 'ou_zhang',
      mentions: [{ key: '@_user_1', openId: 'ou_li', name: '李四', isBot: false }],
    }));
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalled());
    const stopped = await Promise.race([o.shutdown().then(() => 'stopped'), new Promise((r) => setTimeout(r, 4_000, 'waiting'))]);
    expect(stopped).toBe('stopped');
    expect(await topics.get('chat', 'omt_slow')).toMatchObject({ firstId: 'om_root', openedBy: { kind: 'user', openId: 'ou_zhang' } });
  });

  it('keeps the turn going when the registry cannot write', async () => {
    multi();
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, '');
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup(createTopicRegistry({ dir: blocked, sessions: async () => [] }));
    await o.onMessage(message('@bot 在吗', 'omt_user', { rootId: 'om_root' }));
    await done();
    expect(run.consumed).toHaveLength(1);
    expect(fake.log.warn).toHaveBeenCalledWith('intake', 'topic-registry-write-failed', expect.objectContaining({ chatId: 'chat' }));
  });
});

describe('context meter after a restart (s13)', () => {
  function metered(sessionId: string) {
    const t = thread(sessionId);
    t.t.runStreamed = (input: AgentInput) => {
      t.consumed.push(input);
      return { turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn' };
        yield { type: 'context_usage', usedTokens: 50_000, contextWindow: 200_000 };
        yield { type: 'done', turnId: 'turn' };
      })() };
    };
    return t;
  }

  it('saves the last reading with the session at the end of a turn', async () => {
    fake.records.set('omt_topic', record('omt_topic'));
    fake.backend.resumeThread.mockResolvedValue(metered('old-omt_topic').t);
    const o = setup();
    await o.onMessage(message('hi', 'omt_topic'));
    await done();
    await vi.waitFor(() => expect(fake.records.get('omt_topic').usage).toEqual({ sessionId: 'old-omt_topic', used: 50_000, window: 200_000 }));
  });

  it('starts the first card from the saved reading of the same session only', async () => {
    fake.records.set('omt_topic', record('omt_topic', { usage: { sessionId: 'old-omt_topic', used: 86_000, window: 200_000 } }));
    fake.backend.resumeThread.mockResolvedValue(thread('old-omt_topic').t);
    const o = setup();
    await o.onMessage(message('after restart', 'omt_topic'));
    await done();
    expect(finalCard()).toContain('上下文 43%');
    fake.records.set('omt_other', record('omt_other', { usage: { sessionId: 'gone', used: 86_000, window: 200_000 } }));
    fake.backend.resumeThread.mockResolvedValue(thread('old-omt_other').t);
    fake.log.info.mockClear();
    await o.onMessage(message('rebuilt elsewhere', 'omt_other'));
    await done();
    expect(finalCard()).toContain('上下文 —');
  });
});
