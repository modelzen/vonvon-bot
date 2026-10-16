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
  chat: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true } as { messages: unknown[]; ok: boolean; complete: boolean; ownRoots?: unknown[] })),
  get: vi.fn(async ({ path }: { path: { message_id: string } }) => ({ data: { items: [{
    message_id: path.message_id, thread_id: 'omt_new', msg_type: 'text', create_time: '1',
    sender: { id: 'ou_q', sender_type: 'user', sender_name: '王五' }, body: { content: JSON.stringify({ text: `${path.message_id} 的原话` }) },
  }] } })),
  list: vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { items: [] as unknown[] } })),
  chatGet: vi.fn(async (..._args: unknown[]): Promise<unknown> => { throw new Error('no im:chat:readonly'); }),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  /** bots.json's bots, and where their topic registries live. */
  bots: [] as object[],
  localRoot: '',
}));
vi.mock('../src/config/bots', async (original) => ({ ...await original<object>(), loadBots: async () => ({ version: 1, bots: fake.bots }) }));
vi.mock('../src/config/paths', async (original) => {
  const real = await original<typeof import('../src/config/paths')>();
  return { ...real, botPaths: (appId: string) => ({ ...real.botPaths(appId), topicsDir: `${fake.localRoot}/${appId}` }) };
});
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => fake.project,
}));
vi.mock('../src/bot/context-weave', async (original) => ({
  ...await original<object>(),
  fetchThreadContext: fake.history,
  fetchChatContext: fake.chat,
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async (key: string) => fake.records.get(key),
  listSessions: async () => [...fake.records.values()],
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
  const channel = { send: fake.send, rawClient: { appId: 'cli_me', im: { v1: { message: { get: fake.get, list: fake.list }, chat: { get: fake.chatGet }, messageReaction: {
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
  fake.chat.mockReset().mockResolvedValue({ messages: [], ok: true, complete: true });
  fake.list.mockReset().mockResolvedValue({ code: 0, data: { items: [] } });
  fake.chatGet.mockReset().mockRejectedValue(new Error('no im:chat:readonly'));
  fake.bots = [];
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

  it.each(['/clear', '/new'])('answers %s inside a topic without switching sessions', async (cmd) => {
    const o = setup();
    await o.onMessage(message(cmd, 'omt_topic'));
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
  const ctx = (messageId: string, text: string, createTime: number) => ({ messageId, senderName: '李四', text, from: 'user', createTime });

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
    expect(run.consumed[0]!.text).toMatch(/^\[飞书 · 群「test」· 话题「om_root 的原话」\]\n这个话题开在群主区 .* 王五的消息下。.*\n.* 王五：om_root 的原话（话题第一条）\n\[\/飞书\]\n/);
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

describe('record block (s14)', () => {
  const ctx = (messageId: string, text: string, createTime: number, extra: object = {}) =>
    ({ messageId, senderName: '李四', text, from: 'user', createTime, ...extra });
  const clock = '(?:\\d\\d-\\d\\d )?\\d\\d:\\d\\d';
  const seenOf = (key: string) => fake.records.get(key).seen;

  it('back-fills the main area since the watermark, in one block above the trigger', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const trigger = message('两个话题的结论总结一下');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      ctx('om_1', '下午三点发版', trigger.createTime - 2000),
      ctx('om_p', '网关日志里 500 都来自 OrderService', trigger.createTime - 1000, { senderName: '小P', from: 'bot' }),
    ] });
    const o = setup();
    await o.onMessage(trigger);
    await done();
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat',
      expect.objectContaining({ stopAt: 5, before: trigger.createTime, excludeMessageId: trigger.messageId }));
    expect(fake.history).not.toHaveBeenCalled();
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${clock} 李四：下午三点发版\\n`
      + `${clock} 小P（bot）：网关日志里 500 都来自 OrderService\\n\\[/飞书\\]\\n\\n\\[本条消息的发信人：Owner（open_id：owner）\\]\\n\\n两个话题的结论总结一下$`));
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(trigger.createTime));
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'record-block', expect.objectContaining({ place: 'main', lines: 2, opening: false }));
  });

  it('opens a new main session with the 20 most recent messages, and says how many were left out', async () => {
    const run = thread('main-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const trigger = message('第一次在主区');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true,
      messages: Array.from({ length: 25 }, (_, i) => ctx(`om_${i}`, `第 ${i} 条`, trigger.createTime - 25_000 + i * 1000)) });
    const o = setup();
    await o.onMessage(trigger);
    await done();
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ stopAt: 0, enough: 20 }));
    const text = run.consumed[0]!.text ?? '';
    expect(text.split('\n')[1]).toBe('（更早还有 5 条没带进来，需要时用 vonvon 飞书 skill 查）');
    expect(text.match(/李四：/g)).toHaveLength(20);
    expect(text).not.toContain('第 4 条');
    expect(text).toContain('第 5 条');
  });

  it('runs on the trigger alone when the main pull fails, and keeps the watermark', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.chat.mockResolvedValueOnce({ ok: false, complete: false, messages: [] });
    const o = setup();
    const m = message('pull fails');
    await o.onMessage(m);
    await done();
    expect(run.consumed[0]!.text).not.toContain('[飞书');
    expect(run.consumed[0]!.text).toContain('pull fails');
    await vi.waitFor(() => expect(seenOf('chat')).toEqual([{ id: m.messageId, at: m.createTime }]));
    expect(fake.records.get('chat').lastSeenAt).toBe(5);
  });

  it('skips a late main-area re-push that is under the watermark', async () => {
    const now = Date.now();
    fake.records.set('chat', record('chat', { lastSeenAt: now - 60_000 }));
    const o = setup();
    await o.onMessage(message('sent while offline', undefined, { createTime: now - 5 * 60_000 }));
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'late-redelivery-skipped', expect.objectContaining({ msgId: `msg-${seq}` }));
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
  });

  it('does not back-fill a main session that has no watermark, and starts one', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: undefined }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    const m = message('resumed by hand');
    await o.onMessage(m);
    await done();
    expect(fake.chat).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(m.createTime));
  });

  it('pulls nothing for a /goal in the main area, and marks only its trigger', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(Object.assign(run.t, {
      clearGoal: vi.fn(async () => undefined),
      runGoal: () => ({ turnId: () => 'goal', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'goal' };
        yield { type: 'done', turnId: 'goal' };
        yield { type: 'goal_update', status: 'complete', objective: '整理文档', tokensUsed: 1, timeUsedSeconds: 1, tokenBudget: null };
      })() }),
    }));
    const o = setup();
    const m = message('/goal 整理文档');
    await o.onMessage(m);
    await vi.waitFor(() => expect(seenOf('chat')).toEqual([{ id: m.messageId, at: m.createTime }]));
    expect(fake.chat).not.toHaveBeenCalled();
    expect(fake.records.get('chat').lastSeenAt).toBe(5);
  });

  it("resumes the group's one session at the group's tier for a member's message, and leaves a key from before s15c alone", async () => {
    fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', mode: 'full' };
    fake.records.set('chat', record('chat', { lastSeenAt: 7 }));
    fake.records.set('chat#guest', record('chat#guest', { lastSeenAt: 3 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    const m = message('成员的问题', undefined, { senderId: 'ou_guest' });
    await o.onMessage(m);
    await done();
    expect(fake.backend.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-chat', mode: 'full' }));
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ stopAt: 7 }));
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(m.createTime));
    expect(fake.records.get('chat#guest')).toMatchObject({ lastSeenAt: 3 });
  });

  it("reads a card that was still streaming again on the next turn, so the session gets the bot's final answer", async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const first = message('先看看');
    const card = (text: string, streaming: boolean) =>
      ctx('om_p', text, first.createTime - 2000, { senderName: '小P', from: 'bot', ...(streaming ? { streaming } : {}) });
    const asked = ctx('om_1', '还有别的吗', first.createTime - 1000);
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [card('查到一半', true), asked] });
    const o = setup();
    await o.onMessage(first);
    await done();
    expect(run.consumed[0]!.text).toContain('小P（bot，还没答完）：查到一半');
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(first.createTime));
    fake.log.info.mockClear();
    const second = message('那结论呢', undefined, { createTime: first.createTime + 5000 });
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      card('网关的 500 都来自 OrderService', false), asked, ctx(first.messageId, '先看看', first.createTime),
    ] });
    await o.onMessage(second);
    await done();
    // The pull reaches back to the card; of what it finds, only the card is new.
    expect(fake.chat).toHaveBeenLastCalledWith(expect.anything(), 'chat', expect.objectContaining({ stopAt: first.createTime - 2000 }));
    expect(run.consumed[1]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${clock} 小P（bot）：网关的 500 都来自 OrderService\\n\\[/飞书\\]\\n`));
    // Finished now, so the turn after starts from the watermark again.
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(second.createTime));
    expect(fake.records.get('chat').streaming).toEqual([]);
  });

  it('stops reading a card again once it has streamed for 10 minutes', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const m = message('先看看');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      ctx('om_stuck', '一直在转', m.createTime - 11 * 60_000, { senderName: '小P', from: 'bot', streaming: true }),
      ctx('om_p', '查到一半', m.createTime - 2000, { senderName: '小P', from: 'bot', streaming: true }),
    ] });
    const o = setup();
    await o.onMessage(m);
    await done();
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(m.createTime));
    expect(fake.records.get('chat').streaming).toEqual([{ id: 'om_p', at: m.createTime - 2000 }]);
  });

  it("skips a main-area message whose own event comes in after a later message's block carried it", async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const x = message('第二条');
    const y = message('第一条', undefined, { messageId: 'om_y', createTime: x.createTime - 500 });
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_y', '第一条', y.createTime, { mentionsMe: true })] });
    const o = setup();
    await o.onMessage(x);
    await done();
    expect(run.consumed[0]!.text).toContain('李四 → @你：第一条');
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(x.createTime));
    await o.onMessage(y); // half a second late: not a re-push
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'late-redelivery-skipped', expect.objectContaining({ msgId: 'om_y' }));
    expect(run.consumed).toHaveLength(1);
  });

  it('drops a queued message that the running turn already carried as a line', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const x = message('第二条');
    const y = message('第一条', undefined, { messageId: 'om_y', createTime: x.createTime - 500 });
    type Pull = { messages: unknown[]; ok: boolean; complete: boolean };
    let pulled!: (p: Pull) => void;
    fake.chat.mockImplementationOnce(() => new Promise<Pull>((resolve) => { pulled = resolve; }));
    const o = setup();
    await o.onMessage(x);
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalled());
    await o.onMessage(y); // in while x's back-fill is pulled: queued behind it
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    pulled({ ok: true, complete: true, messages: [ctx('om_y', '第一条', y.createTime, { mentionsMe: true })] });
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued-seen-skipped', { msgId: 'om_y' }));
    expect(run.consumed).toHaveLength(1);
    expect(run.consumed[0]!.text).toContain('李四 → @你：第一条');
  });

  it('does not steer in a message that the running turn already carried as a line', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    run.t.runStreamed = (input: AgentInput) => {
      run.consumed.push(input);
      return { turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn' };
        await finished;
        yield { type: 'done', turnId: 'turn' };
      })() };
    };
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const x = message('第二条');
    // Y quotes a message, so its preparation waits on that lookup.
    const y = message('第一条', undefined, { messageId: 'om_y', createTime: x.createTime - 500, replyToMessageId: 'om_q' });
    type Pull = { messages: unknown[]; ok: boolean; complete: boolean };
    let pulled!: (p: Pull) => void;
    fake.chat.mockImplementationOnce(() => new Promise<Pull>((resolve) => { pulled = resolve; }));
    let looked!: () => void;
    const lookup = new Promise<void>((resolve) => { looked = resolve; });
    const get = fake.get.getMockImplementation()!;
    fake.get.mockImplementation(async (req) => { if (req.path.message_id === 'om_q') await lookup; return get(req); });
    const o = setup();
    await o.onMessage(x);
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalled());
    await o.onMessage(y);
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'om_q' } })));
    pulled({ ok: true, complete: true, messages: [ctx('om_y', '第一条', y.createTime, { mentionsMe: true })] });
    await vi.waitFor(() => expect(fake.records.get('chat').lastSeenAt).toBe(x.createTime));
    looked();
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued-seen-skipped', { msgId: 'om_y' }));
    finish();
    await done();
    fake.get.mockImplementation(get);
    expect(run.t.steer).not.toHaveBeenCalled();
    expect(run.consumed).toHaveLength(1);
  });

  it('does not hold shutdown for a main-area pull that does not answer, and keeps the watermark', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.chat.mockImplementationOnce(() => new Promise(() => undefined));
    const o = setup();
    await o.onMessage(message('卡住的补拉'));
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalled());
    await o.shutdown();
    expect(run.consumed).toHaveLength(0);
    expect(run.t.close).toHaveBeenCalled();
    expect(fake.records.get('chat')).toMatchObject({ lastSeenAt: 5 });
  });

  it("puts another bot's answer in a topic's back-fill, under the topic's header", async () => {
    fake.records.set('omt_topic', record('omt_topic', { lastSeenAt: 5 }));
    const run = thread('old');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const m = message('接着说', 'omt_topic');
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      ctx('om_p', '网关的 500 都来自 OrderService', m.createTime - 1000, { senderName: '小P', from: 'bot' }),
    ] });
    const o = setup();
    await o.onMessage(m);
    await done();
    expect(fake.chat).not.toHaveBeenCalled();
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 话题\\]\\n${clock} 小P（bot）：网关的 500 都来自 OrderService\\n\\[/飞书\\]\\n`));
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

describe('topic openings, 引用行 and the topics table (s14b)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topics-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const registry = () => createTopicRegistry({ dir, sessions: async () => [...fake.records.values()] });
  const multi = () => { fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'multi' }; };
  const ctx = (messageId: string, text: string, createTime: number, extra: object = {}) =>
    ({ messageId, senderName: '李四', text, from: 'user', createTime, ...extra });
  const clock = '(?:\\d\\d-\\d\\d )?\\d\\d:\\d\\d';
  const opened = (topics: TopicRegistry, topicId: string, at: number, first: object = {}) =>
    topics.note('chat', { topicId, at, from: { kind: 'user', openId: 'ou_li' }, first: { id: `om_${topicId}`, text: `${topicId} 的标题`, ...first } });

  it("opens a user's topic with the pointer, the main area before its first message and the 引用行 there", async () => {
    fake.records.set('chat', record('chat'));
    fake.records.set('omt_old', record('omt_old'));
    const topics = registry();
    const rootAt = Date.now() - 60_000;
    await opened(topics, 'omt_old', rootAt - 30_000, { id: 'om_m1' });
    await opened(topics, 'omt_older', rootAt - 50_000); // before the oldest main line: not quoted
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_root', '订单接口一直报 500', rootAt, { senderName: '张三' })] });
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_m1', '下午三点发版', rootAt - 40_000)] });
    const o = setup(topics);
    await o.onMessage(message('@bot 帮忙看下', 'omt_new', { rootId: 'om_root' }));
    await done();
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ before: rootAt, excludeMessageId: 'om_root', enough: 10, keepSelf: true }));
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 话题「[^」]*」\\]\\n这个话题开在群主区 ${clock} 张三的消息下（主区会话 id：old-chat）。.*\\n`
      + `主区在这之前：\\n${clock} 李四：下午三点发版\\n`
      + `${clock} 〔话题〕用户u_li在上面这条下开了话题「omt_old 的标题」，你在那边另有一条会话，这里不用接。（话题 id：omt_old，会话 id：old-omt_old）\\n`
      + `话题里：\\n${clock} 张三：订单接口一直报 500（话题第一条）\\n\\[/飞书\\]\\n`));
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'record-block', expect.objectContaining({ place: 'topic', pointer: true, mainLines: 1, mainSession: true, quotes: 1 }));
  });

  it("names the main session and keeps the bot's own main lines for everyone, and names none in a multi group", async () => {
    fake.records.set('chat', record('chat'));
    fake.records.set('chat#guest', record('chat#guest'));
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('成员开的话题', 'omt_g', { rootId: 'om_root', senderId: 'ou_guest' }));
    await done();
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ keepSelf: true }));
    expect(run.consumed[0]!.text).toContain('（主区会话 id：old-chat）');
    multi();
    fake.records.set('chat', record('chat'));
    fake.log.info.mockClear();
    await o.onMessage(message('多话题群', 'omt_m', { rootId: 'om_root2' }));
    await done();
    expect(run.consumed[1]!.text).toMatch(/\n这个话题开在群主区 .* 王五的消息下。主区/);
  });

  it('leaves the main area out of a topic group, and asks nothing for a post', async () => {
    fake.chatGet.mockResolvedValue({ code: 0, data: { chat_mode: 'topic' } });
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('帖子里的回复', 'omt_p', { rootId: 'om_post' }));
    await done();
    expect(run.consumed[0]!.text).not.toContain('这个话题');
    expect(run.consumed[0]!.text).toContain('王五：om_post 的原话（话题第一条）');
    expect(fake.chat).not.toHaveBeenCalled();
    fake.log.info.mockClear();
    await o.onMessage(message('发帖并 @bot', 'omt_q'));
    await done();
    expect(fake.chatGet).toHaveBeenCalledTimes(1);
  });

  it('opens a topic the bot starts from a main @ with the pointer and the main area before the trigger', async () => {
    multi();
    const run = thread('opened');
    fake.backend.startThread.mockResolvedValue(run.t);
    const trigger = message('订单接口一直报 500', undefined, { senderName: '张三' });
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_m1', '下午三点发版', trigger.createTime - 1000)] });
    const o = setup();
    await o.onMessage(trigger);
    await done();
    expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ before: trigger.createTime, excludeMessageId: trigger.messageId, enough: 10 }));
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 话题「订单接口一直报 500」\\]\\n这个话题是你在群主区 ${clock} 张三的这条消息下开的，就是下面这条。.*\\n`
      + `主区在这之前：\\n${clock} 李四：下午三点发版\\n\\[/飞书\\]\\n\\n\\[本条消息的发信人：张三`));
    fake.chat.mockResolvedValueOnce({ ok: false, complete: false, messages: [] });
    fake.log.info.mockClear();
    await o.onMessage(message('拉不到主区'));
    await done();
    expect(run.consumed[1]!.text).toMatch(/^\[飞书 · 群「test」· 话题「拉不到主区」\]\n这个话题是你在群主区 .*\n\[\/飞书\]\n/);
  });

  it('quotes a topic opened since the main session last spoke, with its session id, once', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    fake.records.set('omt_t', record('omt_t'));
    const topics = registry();
    await opened(topics, 'omt_t', Date.now() - 1000);
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.chat.mockResolvedValue({ ok: false, complete: false, messages: [] }); // the turn runs on local records only
    const o = setup(topics);
    const first = message('第一轮');
    await o.onMessage(first);
    await done();
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n（更早的消息没带进来，需要时用 vonvon 飞书 skill 查）\\n`
      + `${clock} 〔话题〕用户u_li开了话题「omt_t 的标题」，你在那边另有一条会话，这里不用接。（话题 id：omt_t，会话 id：old-omt_t）\\n\\[/飞书\\]\\n`));
    await vi.waitFor(() => expect(fake.records.get('chat').seen).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'omt_t' })])));
    expect(fake.records.get('chat').lastSeenAt).toBe(5);
    fake.log.info.mockClear();
    await o.onMessage(message('第二轮'));
    await done();
    expect(run.consumed[1]!.text).not.toContain('〔话题〕');
  });

  it('does not quote again to a session that starts over from 0 after a failed pull', async () => {
    const topics = registry();
    const at = Date.now() - 1000;
    await opened(topics, 'omt_t', at);
    fake.records.set('chat', record('chat', { lastSeenAt: 0, seen: [{ id: 'omt_t', at }] }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_1', '一条', at - 1000)] });
    const o = setup(topics);
    await o.onMessage(message('又来'));
    await done();
    expect(run.consumed[0]!.text).toContain('李四：一条');
    expect(run.consumed[0]!.text).not.toContain('omt_t');
  });

  it("starts a new main session's 引用行 at its oldest line", async () => {
    const topics = registry();
    const trigger = message('第一次在主区');
    await opened(topics, 'omt_before', trigger.createTime - 5000);
    await opened(topics, 'omt_after', trigger.createTime - 1000);
    const run = thread('main-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_1', '最早的一条', trigger.createTime - 2000)] });
    const o = setup(topics);
    await o.onMessage(trigger);
    await done();
    expect(run.consumed[0]!.text).toContain('（话题 id：omt_after）');
    expect(run.consumed[0]!.text).not.toContain('omt_before');
  });

  it('recognises a topic another bot opened under a main-area line', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const topics = registry();
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const trigger = message('总结一下');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      ctx('om_root', '订单接口一直报 500', trigger.createTime - 2000, { threadId: 'omt_a', senderId: 'ou_zhang', senderName: '张三' }),
    ] });
    fake.list.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'om_p', msg_type: 'text', create_time: String(trigger.createTime - 1000),
      sender: { id: 'cli_p', id_type: 'app_id', sender_type: 'app', sender_name: '小P', open_bot_id: 'ou_p' }, body: { content: '{"text":"看看"}' } }] } });
    const o = setup(topics);
    await o.onMessage(trigger);
    await done();
    expect(await topics.get('chat', 'omt_a')).toMatchObject({ openedBy: { kind: 'bot', openId: 'ou_p' }, firstId: 'om_root' });
    expect(run.consumed[0]!.text).toContain('张三：订单接口一直报 500\n');
    expect(run.consumed[0]!.text).toMatch(/〔话题〕小P（bot）在上面这条下开了话题「订单接口一直报 500」，你在那边还没有会话，这里不用接。（话题 id：omt_a）\n/);
  });

  it("recognises a topic another bot opened under this bot's own main-area reply, which stays out of the block (s14c)", async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const topics = registry();
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const trigger = message('总结一下');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_u', '先看下日志', trigger.createTime - 3000)],
      ownRoots: [ctx('om_mine', '网关日志', trigger.createTime - 2000, { threadId: 'omt_m', from: 'self', senderName: '小码' })] });
    fake.list.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'om_p', msg_type: 'text', create_time: String(trigger.createTime - 1000),
      sender: { id: 'cli_p', id_type: 'app_id', sender_type: 'app', sender_name: '小P', open_bot_id: 'ou_p' }, body: { content: '{"text":"展开说说"}' } }] } });
    const o = setup(topics);
    await o.onMessage(trigger);
    await done();
    expect(await topics.get('chat', 'omt_m')).toMatchObject({ openedBy: { kind: 'bot', openId: 'ou_p' }, firstId: 'om_mine' });
    const text = run.consumed[0]!.text!;
    expect(text).toContain('李四：先看下日志\n');
    expect(text).not.toMatch(/你：网关日志/);
    expect(text).toMatch(new RegExp(`〔话题〕小P（bot）在你 ${clock} 的回复下开了话题「网关日志」，你在那边还没有会话，这里不用接。（话题 id：omt_m）\n`));
  });

  it("quotes the topics another vonvon bot on this daemon opened, from its registry, with this bot's session ids only", async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    fake.records.set('omt_both', record('omt_both'));
    const topics = registry();
    const at = Date.now() - 3000;
    await opened(topics, 'omt_both', at + 500); // this bot first saw it from 李四's reply
    fake.localRoot = dir;
    fake.bots = [{ name: 'me', appId: 'app' }, { name: 'p', appId: 'cli_p', botName: '小P' }];
    const theirs = createTopicRegistry({ dir: join(dir, 'cli_p'), sessions: async () => [] });
    await theirs.note('chat', { topicId: 'omt_both', at, from: { kind: 'self' } });
    await theirs.note('chat', { topicId: 'omt_p', at: at + 1000, from: { kind: 'self' }, first: { id: 'om_r', text: '灰度方案' } });
    await createTopicRegistry({ dir: join(dir, 'app'), sessions: async () => [] }).note('chat', { topicId: 'omt_self', at, from: { kind: 'self' } });
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_r', '灰度方案', at + 900, { threadId: 'omt_p', senderName: '张三' })] });
    const o = setup(topics);
    await o.onMessage(message('总结一下'));
    await done();
    expect(run.consumed[0]!.text).toMatch(new RegExp(`\\n${clock} 〔话题〕小P（bot）开了话题「omt_both 的标题」，你在那边另有一条会话，这里不用接。（话题 id：omt_both，会话 id：old-omt_both）\\n`
      + `${clock} 张三：灰度方案\\n${clock} 〔话题〕小P（bot）在上面这条下开了话题「灰度方案」，你在那边还没有会话，这里不用接。（话题 id：omt_p）\\n\\[/飞书\\]`));
    expect(run.consumed[0]!.text).not.toContain('omt_self');
    expect(fake.list).not.toHaveBeenCalled(); // known from the registry: not looked up
  });

  /** A thread whose turns yield these events between turn_started and done, one list per turn. */
  function turns(sessionId: string, perTurn: AgentEvent[][], hold?: Promise<void>) {
    const run = thread(sessionId);
    Object.assign(run.t, { supportsSteer: false, compact: vi.fn(async () => ({ usage: null })) });
    run.t.runStreamed = (input: AgentInput) => {
      run.consumed.push(input);
      const evs = perTurn.shift() ?? [];
      const wait = run.consumed.length === 1 ? hold : undefined;
      return { turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn' };
        yield* evs;
        await wait;
        yield { type: 'done', turnId: 'turn' };
      })() };
    };
    return run;
  }
  const compacted: AgentEvent = { type: 'compaction', phase: 'end' };
  const table = '〔本群最近 1 个活跃话题〕';

  it('shows the recent topics on the next main turn after a compaction, once', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5, sessionId: 'old-chat' }));
    const topics = registry();
    await opened(topics, 'omt_t', 3);
    const run = turns('old-chat', [[compacted], [], []]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(topics);
    await o.onMessage(message('一'));
    await done();
    expect(run.consumed[0]!.text).not.toContain('〔本群');
    await vi.waitFor(() => expect(fake.records.get('chat').topicsDue).toBe('old-chat'));
    for (const text of ['二', '三']) {
      fake.log.info.mockClear();
      await o.onMessage(message(text));
      await done();
    }
    expect(run.consumed[1]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${table}这条会话压缩过.*\\n· 「omt_t 的标题」用户u_li ${clock} 开的`));
    expect(run.consumed[2]!.text).not.toContain('〔本群');
    expect(fake.records.get('chat').topicsDue).toBe('');
  });

  it('sets nothing for a failed compaction or one in a topic, and sets it after /compact', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    fake.records.set('omt_x', record('omt_x'));
    const run = turns('old-chat', [[{ ...compacted, failed: true }], [compacted]]);
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('一'));
    await done();
    fake.log.info.mockClear();
    await o.onMessage(message('话题里', 'omt_x'));
    await done();
    expect(fake.records.get('chat')).not.toHaveProperty('topicsDue');
    expect(fake.records.get('omt_x')).not.toHaveProperty('topicsDue');
    await o.onMessage(message('/compact'));
    await vi.waitFor(() => expect(fake.records.get('chat').topicsDue).toBe('old-chat'));
  });

  it('puts the table above a message queued during the turn that compacted', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const topics = registry();
    await opened(topics, 'omt_t', 3);
    let release!: () => void;
    const run = turns('old-chat', [[compacted], []], new Promise<void>((resolve) => { release = resolve; }));
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(topics);
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(fake.records.get('chat').topicsDue).toBe('old-chat'));
    await o.onMessage(message('排队的'));
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    release();
    await vi.waitFor(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${table}.*\\n· .*\\n\\[/飞书\\]\\n\\n\\[本条消息的发信人：Owner`));
    await vi.waitFor(() => expect(fake.records.get('chat').topicsDue).toBe(''));
  });

  it("asks the group and pulls the main area of a new topic session without waiting for the model list", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = thread('topic-session');
    fake.backend.startThread.mockResolvedValue(run.t);
    const rootAt = Date.now() - 60_000;
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_root', '订单接口一直报 500', rootAt, { senderName: '张三' })] });
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_m1', '下午三点发版', rootAt - 40_000)] });
    const o = setup();
    const models = await fake.backend.listModels(); // after the boot prewarm: the turn's own call is held
    fake.backend.listModels.mockImplementationOnce(async () => { await held; return models; });
    await o.onMessage(message('@bot 帮忙看下', 'omt_new', { rootId: 'om_root' }));
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalledWith(expect.anything(), 'chat', expect.objectContaining({ before: rootAt })));
    expect(fake.chatGet).toHaveBeenCalledTimes(1);
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    release();
    await done();
    expect(run.consumed[0]!.text).toContain('李四：下午三点发版');
  });

  it('looks up the topics under the main lines while a bot-opened topic session starts', async () => {
    multi();
    const run = thread('opened');
    let release!: (t: unknown) => void;
    fake.backend.startThread.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const trigger = message('订单接口一直报 500');
    fake.chat.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx('om_r', '灰度方案', trigger.createTime - 1000, { threadId: 'omt_a' })] });
    const o = setup(registry());
    await o.onMessage(trigger);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
    release(run.t);
    await done();
    expect(run.consumed[0]!.text).toContain('李四：灰度方案');
  });

  it('does not open a second topic for a main @ re-pushed after a restart', async () => {
    multi();
    const topics = registry();
    const sent = message('订单接口一直报 500', undefined, { createTime: Date.now() - 2 * 60_000 });
    await topics.note('chat', { topicId: 'omt_mine', at: sent.createTime, from: { kind: 'self' }, first: { id: sent.messageId } });
    const o = setup(topics);
    await o.onMessage(sent);
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'late-redelivery-skipped', expect.objectContaining({ msgId: sent.messageId, reopen: true }));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });
});

describe('/new, /compact while busy and recall notes (s15)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topics-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = (messageId: string, text: string, createTime: number) => ({ messageId, senderName: '李四', text, from: 'user', createTime });
  const clock = '(?:\\d\\d-\\d\\d )?\\d\\d:\\d\\d';
  const sent = () => JSON.stringify(fake.send.mock.calls);
  const logged = (event: string) => vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', event, expect.anything()));
  /** A thread that does not steer; each turn waits for `next()` before it ends. */
  function held(sessionId: string) {
    const run = thread(sessionId);
    const gates: (() => void)[] = [];
    let compacted!: () => void;
    const compact = vi.fn(() => new Promise((resolve) => { compacted = () => resolve({ usage: null }); }));
    Object.assign(run.t, { supportsSteer: false, compact });
    run.t.runStreamed = (input: AgentInput) => {
      run.consumed.push(input);
      const gate = new Promise<void>((resolve) => gates.push(resolve));
      return { turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: 'turn' };
        await gate;
        yield { type: 'done', turnId: 'turn' };
      })() };
    };
    return { ...run, compact, next: () => gates.shift()?.(), compacted: () => compacted() };
  }
  /** The next message.get of `id` finds it recalled (a deleted item keeps its place and sender). */
  const recalledOnce = (id: string, at: number, extra: object = {}) => fake.get.mockImplementationOnce((async () => ({ code: 0, data: { items: [{
    message_id: id, deleted: true, msg_type: 'text', create_time: String(at),
    sender: { id: 'ou_li', id_type: 'open_id', sender_type: 'user', sender_name: '李四' }, ...extra }] } })) as never);

  it('swaps the main session for the owner on /new, starting after the command', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5, recalls: [{ id: 'om_r', at: 3 }] }));
    fake.backend.startThread.mockResolvedValue(thread('fresh').t);
    const o = setup();
    const cmd = message('/new');
    await o.onMessage(cmd);
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'clear', expect.objectContaining({ cmd: 'new' })));
    expect(fake.records.get('chat')).toMatchObject({ sessionId: 'fresh', lastSeenAt: cmd.createTime, from: cmd.createTime + 1 });
    expect(fake.records.get('chat')).not.toHaveProperty('recalls');
  });

  it('lets only the owner and admins use /new in the main area, and explains it in a multi group', async () => {
    const o = setup();
    await o.onMessage(message('/new', undefined, { senderId: 'ou_guest' }));
    expect(fake.send).toHaveBeenCalledWith('chat', { markdown: '⚠️ `/new` 只有主人和管理员能用。主区的会话是大家共用的。' }, expect.anything());
    fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'multi' };
    await o.onMessage(message('/new'));
    expect(sent()).toContain('这个群的主区不留会话，不用 `/new`');
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });

  it('runs a message sent during the swap on the new session, and tells one sent before the command', async () => {
    fake.records.set('chat', record('chat'));
    const fresh = thread('fresh');
    let start!: (t: unknown) => void;
    fake.backend.startThread.mockImplementationOnce(() => new Promise((resolve) => { start = resolve; }));
    const o = setup();
    const cmd = message('/new');
    await o.onMessage(cmd);
    await vi.waitFor(() => expect(fake.backend.startThread).toHaveBeenCalled());
    const before = message('命令之前发的', undefined, { createTime: cmd.createTime - 1 }); // still prepared, or Feishu's order
    await o.onMessage(before);
    await o.onMessage(message('换完再说', undefined, { createTime: cmd.createTime + 1 }));
    await vi.waitFor(() => expect((fake.log.info.mock.calls as unknown[][]).filter((c) => c[1] === 'deferred')).toHaveLength(2));
    start(fresh.t);
    await done();
    expect(fresh.consumed).toHaveLength(1);
    expect(fresh.consumed[0]!.text).toContain('换完再说');
    expect(fresh.consumed[0]!.text).not.toContain('命令之前发的');
    expect(fake.send).toHaveBeenCalledWith('chat', { markdown: '⚠️ 这条在 `/new` 之前发的，新会话不带它，要问就再发一次。' }, expect.objectContaining({ replyTo: before.messageId }));
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'reject', { reason: 'before-new', msgId: before.messageId });
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(sent()).not.toContain('请重发');
  });

  it('rebuilds a session unused since /new without the lines before it, and says nothing about it', async () => {
    const at = Date.now() - 60_000;
    fake.records.set('chat', record('chat', { lastSeenAt: at, from: at + 1 }));
    const fresh = thread('fresh');
    fake.backend.resumeThread.mockRejectedValue(new Error('no rollout'));
    fake.backend.startThread.mockResolvedValue(fresh.t);
    fake.chat.mockResolvedValue({ ok: true, complete: true, messages: [ctx('om_before', '命令之前', at - 1000), ctx('om_after', '命令之后', at + 1000)] });
    const o = setup();
    await o.onMessage(message('接着'));
    await done();
    expect(fake.chat).toHaveBeenLastCalledWith(expect.anything(), 'chat', expect.objectContaining({ stopAt: at + 1, enough: 20 }));
    expect(fresh.consumed[0]!.text).toContain('李四：命令之后');
    expect(fresh.consumed[0]!.text).not.toContain('命令之前');
    expect(finalCard()).not.toContain('⚠️');
    expect(fake.log.info).toHaveBeenCalledWith('agent', 'session-changed', { sessionKey: 'chat', reason: 'resume-failed', unused: true });
  });

  it('compacts right after the running turn, and runs what came in during the compaction', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = held('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('/compact'));
    await o.onMessage(message('/compact'));
    expect(sent()).toContain('⏳ 等这一轮结束就压缩，不用再发。');
    expect(sent()).toContain('已经排上了，这一轮结束后就压缩。');
    run.next();
    await vi.waitFor(() => expect(run.compact).toHaveBeenCalledTimes(1));
    await o.onMessage(message('二'));
    await logged('queued');
    await o.onMessage(message('/compact'));
    expect(sent()).toContain('正在压缩，不用再发 `/compact`。');
    expect(run.consumed).toHaveLength(1);
    run.compacted();
    await vi.waitFor(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('二');
    run.next();
    await vi.waitFor(() => expect((fake.log.info.mock.calls as unknown[][]).filter((c) => c[1] === 'final')).toHaveLength(2));
    expect(run.compact).toHaveBeenCalledTimes(1);
    expect(sent()).not.toContain('请重发');
  });

  it('refuses /compact during a goal, and drops a waiting one when the turn ends with its process gone', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = held('old-chat');
    let alive = true;
    run.t.isAlive = () => alive;
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/goal 把单测跑绿'));
    await o.onMessage(message('/compact'));
    expect(sent()).toContain('🎯 目标运行中，结束后再 `/compact`。');
    await vi.waitFor(() => expect(fake.log.fail).toHaveBeenCalled()); // the fake thread has no goal support
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('/compact'));
    alive = false;
    run.next();
    await vi.waitFor(() => expect(sent()).toContain('前面那一轮停了，`/compact` 没有执行，要压缩就再发一次。'));
    expect(run.compact).not.toHaveBeenCalled();
  });

  it('runs a message sent during an idle /compact once it is done', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = held('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/compact'));
    await vi.waitFor(() => expect(run.compact).toHaveBeenCalled());
    await o.onMessage(message('压缩时说的'));
    await logged('deferred');
    expect(run.consumed).toHaveLength(0);
    run.compacted();
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('压缩时说的');
    run.next();
    await done();
    expect(sent()).not.toContain('请重发');
  });

  it('says a recalled line the main session got once, at its next turn', async () => {
    const at = Date.now() - 60_000;
    fake.records.set('chat', record('chat', { lastSeenAt: at + 1000 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    recalledOnce('om_r', at);
    await o.onRecall({ messageId: 'om_r', chatId: 'chat', recallType: 'message_owner' });
    expect(fake.records.get('chat').recalls).toEqual([{ id: 'om_r', at, who: { kind: 'user', openId: 'ou_li' } }]);
    await o.onMessage(message('接着说'));
    await done();
    expect(run.consumed[0]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${clock} 〔撤回〕李四撤回了一条消息，不要再用它。\\n\\[/飞书\\]\\n`));
    await vi.waitFor(() => expect(fake.records.get('chat').recalls).toEqual([]));
    const gets = fake.get.mock.calls.length;
    await o.onRecall({ messageId: 'om_r', chatId: 'chat', recallType: 'message_owner' }); // Feishu pushes it again
    expect(fake.get).toHaveBeenCalledTimes(gets);
    expect(fake.records.get('chat').recalls).toEqual([]);
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recall', { chat: 'chat', msg: 'om_r', type: 'message_owner', lookup: 'repeat', sessions: 0, noted: 0 });
    fake.log.info.mockClear();
    await o.onMessage(message('再说'));
    await done();
    expect(run.consumed[1]!.text).not.toContain('〔撤回〕');
  });

  it('logs a recall in a chat with no session yet', async () => {
    const o = setup();
    await o.onRecall({ messageId: 'om_quiet', chatId: 'chat' });
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recall', { chat: 'chat', msg: '_quiet', type: null, lookup: 'skipped', sessions: 0, noted: 0 });
  });

  it('notes a recall for the sessions the message reached only', async () => {
    const at = Date.now() - 60_000;
    const topics = createTopicRegistry({ dir, sessions: async () => [...fake.records.values()] });
    await topics.note('chat', { topicId: 'omt_t', at: at + 500, from: { kind: 'user', openId: 'ou_li' }, first: { id: 'om_root', at: at + 500 } });
    fake.records.set('chat', record('chat', { lastSeenAt: at + 1000 }));
    fake.records.set('omt_t', record('omt_t', { lastSeenAt: at + 1000, from: at - 5000 }));
    const o = setup(topics);
    const ids = (key: string) => (fake.records.get(key).recalls ?? []).map((r: { id: string }) => r.id);
    recalledOnce('om_reply', at, { thread_id: 'omt_t', root_id: 'om_root' }); // a reply in the topic
    await o.onRecall({ messageId: 'om_reply', chatId: 'chat', recallType: 'group_owner' });
    recalledOnce('om_main', at); // a main line the topic's opening carried
    await o.onRecall({ messageId: 'om_main', chatId: 'chat' });
    recalledOnce('om_older', at - 10_000); // before the topic's opening
    await o.onRecall({ messageId: 'om_older', chatId: 'chat' });
    recalledOnce('om_unseen', at + 5000); // after both watermarks
    await o.onRecall({ messageId: 'om_unseen', chatId: 'chat' });
    recalledOnce('om_mine', at, { sender: { id: 'cli_me', id_type: 'app_id', sender_type: 'app' } }); // the bot's own
    await o.onRecall({ messageId: 'om_mine', chatId: 'chat' });
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recall', expect.objectContaining({ msg: 'm_mine', lookup: 'self', sessions: 2, noted: 0 }));
    expect(ids('chat')).toEqual(['om_older', 'om_main']);
    expect(ids('omt_t')).toEqual(['om_reply', 'om_main']);
    expect(fake.records.get('omt_t').recalls[0]).toMatchObject({ other: true });
  });

  it('drops a queued message recalled before its turn, skips one whose recall came first, and says one written meanwhile', async () => {
    const at = Date.now() - 60_000;
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = held('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1));
    const queued = message('二');
    await o.onMessage(queued);
    await logged('queued');
    recalledOnce(queued.messageId, queued.createTime);
    await o.onRecall({ messageId: queued.messageId, chatId: 'chat' });
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recall-queued-dropped', { msgId: queued.messageId, dropped: 1 });
    const early = message('三');
    recalledOnce(early.messageId, early.createTime);
    await o.onRecall({ messageId: early.messageId, chatId: 'chat' });
    await o.onMessage(early);
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'reject', { reason: 'recalled', msgId: early.messageId });
    recalledOnce('om_r', at); // under the watermark the running turn moved
    await o.onRecall({ messageId: 'om_r', chatId: 'chat' });
    await o.onMessage(message('四'));
    run.next();
    await vi.waitFor(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[0]!.text).not.toContain('〔撤回〕');
    expect(run.consumed[1]!.text).toMatch(new RegExp(`^\\[飞书 · 群「test」· 主区\\]\\n${clock} 〔撤回〕李四撤回了一条消息，不要再用它。\\n\\[/飞书\\]\\n[^]*四$`));
    await vi.waitFor(() => expect(fake.records.get('chat').recalls).toEqual([]));
    run.next();
    await done();
  });

  it('notes a trigger recalled while its turn was prepared, for the next turn', async () => {
    fake.records.set('chat', record('chat', { lastSeenAt: 5 }));
    const run = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValue(run.t);
    type Pull = { messages: unknown[]; ok: boolean; complete: boolean };
    let pulled!: (p: Pull) => void;
    fake.chat.mockImplementationOnce(() => new Promise<Pull>((resolve) => { pulled = resolve; }));
    const o = setup();
    const trigger = message('马上撤回');
    await o.onMessage(trigger);
    await vi.waitFor(() => expect(fake.chat).toHaveBeenCalled());
    recalledOnce(trigger.messageId, trigger.createTime);
    await o.onRecall({ messageId: trigger.messageId, chatId: 'chat' });
    expect(fake.records.get('chat')).not.toHaveProperty('recalls');
    pulled({ ok: true, complete: true, messages: [] });
    await done();
    await vi.waitFor(() => expect(fake.records.get('chat').recalls).toEqual([{ id: trigger.messageId, at: trigger.createTime, who: { kind: 'user', openId: 'owner' } }]));
  });
});
