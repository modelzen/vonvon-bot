import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { audienceOf, quotedId, type AudienceLookups } from '../src/bot/baselines';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'baselines-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'baselines-'));
  return { botPaths: (appId: string) => ({ dir: join(appDir, 'bots', appId), configFile: join(appDir, 'bots', appId, 'config.json') }), paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  send: vi.fn(async () => ({})),
  get: vi.fn(),
  list: vi.fn(),
  chatGet: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  startThread: vi.fn(async () => ({
    sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => {},
    runStreamed: () => ({ turnId: () => 'turn-fixture', events: (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })() }),
  })),
}));

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], startThread: fake.startThread }) }));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async () => undefined, upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { return 'card'; }
    getCardId() { return 'card'; }
    async drain() {}
    async settleImages() { return new Map(); }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => true }); }
  },
}));

import { createOrchestrator } from '../src/bot/handle-message';

const ME = 'cli_me';
const OTHER_BOT = 'cli_other';
let sequence = 0;
interface Shape { text?: string; thread?: string; root?: string; parent?: string; atMe?: boolean; atOther?: 'user' | 'bot'; atAll?: boolean; sender?: 'user' | 'app'; senderId?: string }
function message(s: Shape = {}): NormalizedMessage {
  const mentions = [
    ...(s.atMe ? [{ key: '@_user_1', openId: 'ou_me', name: '小码', isBot: true }] : []),
    ...(s.atOther ? [{ key: '@_user_2', openId: s.atOther === 'bot' ? 'ou_other_bot' : 'ou_zhang', name: s.atOther === 'bot' ? '小P' : '张三', isBot: false }] : []),
  ];
  return {
    messageId: `om_fixture_${++sequence}`, chatId: 'oc_demo', chatType: 'group', content: s.text ?? '是不是昨天改了 token？',
    threadId: s.thread, rootId: s.root, replyToMessageId: s.parent,
    senderId: s.senderId ?? 'ou_li', mentionedBot: Boolean(s.atMe), mentionAll: Boolean(s.atAll), mentions,
    createTime: Date.now(), rawContentType: 'text', resources: [],
    raw: { sender: { sender_type: s.sender ?? 'user', sender_id: { open_id: s.senderId ?? 'ou_li' } } },
  };
}

describe('audienceOf (product.md 3.4 三条底线)', () => {
  const lookups = (o: { lonely?: boolean; quoted?: Awaited<ReturnType<AudienceLookups['quoted']>>; last?: Awaited<ReturnType<AudienceLookups['lastBot']>> } = {}) =>
    ({ lonely: vi.fn(async () => o.lonely ?? false), quoted: vi.fn(async () => o.quoted), lastBot: vi.fn(async () => o.last) });
  const on = { noMention: true };

  it('takes an @ of this bot first, also beside @所有人 or an @ of another bot', async () => {
    const l = lookups();
    expect(await audienceOf(message({ atMe: true, atAll: true }), on, l)).toEqual({ to: 'me', by: 'mention' });
    expect(await audienceOf(message({ atMe: true, atOther: 'bot' }), on, l)).toEqual({ to: 'me', by: 'mention' });
    expect(l.lonely).not.toHaveBeenCalled();
  });

  it('leaves @所有人 and an @ of someone else to them, without a lookup', async () => {
    const l = lookups();
    expect(await audienceOf(message({ atAll: true }), on, l)).toEqual({ to: 'other', by: 'mention-all' });
    expect(await audienceOf(message({ atOther: 'user', thread: 'omt_t', root: 'om_r', parent: 'om_r' }), on, l)).toEqual({ to: 'other', by: 'mention' });
    expect(await audienceOf(message({ atOther: 'bot' }), on, l)).toEqual({ to: 'other', by: 'mention' });
    expect(l.lonely).not.toHaveBeenCalled();
  });

  it('counts another bot only when it @-mentions this one', async () => {
    const l = lookups();
    expect(await audienceOf(message({ sender: 'app', senderId: 'ou_other_bot' }), on, l)).toEqual({ to: 'other', by: 'bot-sender' });
    expect(await audienceOf(message({ sender: 'app', atMe: true }), on, l)).toEqual({ to: 'me', by: 'mention', fromBot: true });
  });

  it('names whose message is quoted (免@)', async () => {
    expect(await audienceOf(message({ parent: 'om_q' }), on, lookups({ quoted: { from: 'self' } }))).toEqual({ to: 'me', by: 'quote' });
    expect(await audienceOf(message({ parent: 'om_q' }), on, lookups({ quoted: { from: 'bot', senderId: 'ou_other_bot' } }))).toEqual({ to: 'other', by: 'quote' });
    expect(await audienceOf(message({ parent: 'om_q' }), on, lookups({ quoted: { from: 'user', senderId: 'ou_zhang' } }))).toEqual({ to: 'other', by: 'quote' });
    // Quoting one's own message names no one; quoting this bot beside an @ of another bot names both.
    expect(await audienceOf(message({ parent: 'om_q' }), on, lookups({ quoted: { from: 'user', senderId: 'ou_li' } }))).toEqual({ to: 'nobody' });
    expect(await audienceOf(message({ parent: 'om_q', atOther: 'bot' }), on, lookups({ quoted: { from: 'self' } }))).toEqual({ to: 'me', by: 'quote' });
    expect(await audienceOf(message({ parent: 'om_q', atOther: 'bot' }), on, lookups({ quoted: { from: 'user', senderId: 'ou_li' } }))).toEqual({ to: 'other', by: 'mention' });
    expect(await audienceOf(message({ parent: 'om_q' }), on, lookups())).toEqual({ to: 'unknown', why: 'quote' });
  });

  it('in 仅@ looks nothing up: a quote names no one, as in the bridge', async () => {
    const l = lookups({ quoted: { from: 'self' }, last: 'bot' });
    expect(await audienceOf(message({ parent: 'om_q' }), { noMention: false }, l)).toEqual({ to: 'nobody' });
    expect(await audienceOf(message({ thread: 'omt_t', root: 'om_r', parent: 'om_r' }), { noMention: false }, l)).toEqual({ to: 'nobody' });
    expect([l.lonely, l.quoted, l.lastBot].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  });

  it('gives an unnamed topic message to the bot that spoke there last', async () => {
    const inTopic = { thread: 'omt_t', root: 'om_r', parent: 'om_r' };
    expect(await audienceOf(message(inTopic), on, lookups({ last: 'bot' }))).toEqual({ to: 'other', by: 'topic' });
    expect(await audienceOf(message(inTopic), on, lookups({ last: 'self' }))).toEqual({ to: 'nobody' });
    expect(await audienceOf(message(inTopic), on, lookups({ last: 'none' }))).toEqual({ to: 'nobody' });
    expect(await audienceOf(message(inTopic), on, lookups())).toEqual({ to: 'unknown', why: 'topic' });
    // A reply to one's own message in the topic still goes to its last bot.
    expect(await audienceOf(message({ ...inTopic, parent: 'om_mine' }), on, lookups({ quoted: { from: 'user', senderId: 'ou_li' }, last: 'bot' }))).toEqual({ to: 'other', by: 'topic' });
  });

  it("as the group's only bot, looks nothing else up", async () => {
    const l = lookups({ lonely: true, last: 'bot', quoted: { from: 'user', senderId: 'ou_zhang' } });
    expect(await audienceOf(message({ thread: 'omt_t', root: 'om_r', parent: 'om_r' }), on, l)).toEqual({ to: 'nobody' });
    expect(await audienceOf(message({ parent: 'om_q' }), on, l)).toEqual({ to: 'nobody' });
    expect(await audienceOf(message({ parent: 'om_q', atOther: 'user' }), on, l)).toEqual({ to: 'other', by: 'mention' });
    expect([l.quoted, l.lastBot].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it('reads a quote in a topic only when it replies to a message other than the first (e10 item 4)', () => {
    expect(quotedId(message({ thread: 'omt_t', root: 'om_r', parent: 'om_r' }))).toBeUndefined();
    expect(quotedId(message({ thread: 'omt_t', root: 'om_r', parent: 'om_t1' }))).toBe('om_t1');
    expect(quotedId(message({ parent: 'om_q' }))).toBe('om_q');
    expect(quotedId(message({ thread: 'omt_post' }))).toBeUndefined(); // a topic group's post
  });
});

describe('the orchestrator with several bots in the group', () => {
  const cfg: AppConfig = { accounts: { app: { id: ME, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, botIdentity: { openId: 'ou_me', name: '小码' },
    rawClient: { appId: ME, im: { v1: { messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) }, message: { get: fake.get, list: fake.list }, chat: { get: fake.chatGet } } } } };
  let orchestrator: ReturnType<typeof createOrchestrator>;
  let events: DiagnosticsEvent[] = [];
  const records = () => events.flatMap((e) => e.kind === 'notReplied' ? [e.record] : []);
  const audience = () => fake.log.info.mock.calls.filter((c) => c[0] === 'intake' && c[1] === 'audience').map((c) => c[2] as Record<string, unknown>);
  const item = (sender: 'self' | 'bot' | 'user', extra: Record<string, unknown> = {}) => ({
    message_id: `om_item_${++sequence}`, create_time: String(Date.now()), msg_type: 'text', body: { content: '{"text":"x"}' },
    sender: sender === 'user' ? { id: 'ou_zhang', id_type: 'open_id', sender_type: 'user' } : { id: sender === 'self' ? ME : OTHER_BOT, id_type: 'app_id', sender_type: 'app' },
    ...extra,
  });
  const topicSays = (...items: unknown[]) => fake.list.mockImplementation(async () => ({ code: 0, data: { items, has_more: false } }));
  const answered = () => vi.waitFor(() => expect(fake.startThread).toHaveBeenCalledOnce());
  const inTopic = { thread: 'omt_t', root: 'om_r', parent: 'om_r' };
  const speakerLookups = () => fake.list.mock.calls.filter((c) => !(c as unknown as [{ params: Record<string, unknown> }])[0].params.with_sender_name).length;

  beforeEach(() => {
    vi.clearAllMocks();
    fake.get.mockReset();
    fake.list.mockReset();
    fake.chatGet.mockReset();
    fake.chatGet.mockImplementation(async () => ({ code: 0, data: { chat_mode: 'group', bot_count: '2' } }));
    fake.get.mockImplementation(async () => ({ code: 0, data: { items: [item('user')] } }));
    events = [];
    setDiagnosticsSink((e) => events.push(e));
    fake.project = { name: 'demo', chatId: 'oc_demo', cwd: workspace, kind: 'multi', noMention: true, mode: 'full', network: false };
    orchestrator = createOrchestrator(channel as never, cfg, workspace);
  });
  afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

  it('stays out of a topic another bot spoke in last', async () => {
    topicSays(item('user'), item('bot'), item('self'));
    await orchestrator.onMessage(message(inTopic));
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(audience()).toEqual([{ to: 'other', by: 'topic', ref: expect.any(String) }]);
    expect(records()).toEqual([]);
    const params = (fake.list.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0].params;
    expect(params).toMatchObject({ container_id_type: 'thread', container_id: 'omt_t', sort_type: 'ByCreateTimeDesc' });
  });

  it('answers in a topic it spoke in last, or one no bot has', async () => {
    topicSays(item('user'), item('self'), item('bot'));
    await orchestrator.onMessage(message(inTopic));
    await answered();
    vi.clearAllMocks();
    topicSays(item('user'));
    await orchestrator.onMessage(message({ ...inTopic, thread: 'omt_u' }));
    await answered();
  });

  it('pages back to find the last bot', async () => {
    fake.list
      .mockImplementationOnce(async () => ({ code: 0, data: { items: [item('user')], has_more: true, page_token: 'p2' } }))
      .mockImplementationOnce(async () => ({ code: 0, data: { items: [item('bot')], has_more: false } }));
    await orchestrator.onMessage(message(inTopic));
    expect(fake.list).toHaveBeenCalledTimes(2);
    expect(fake.startThread).not.toHaveBeenCalled();
  });

  it('does not answer when the topic cannot be read, and says why on the page', async () => {
    fake.list.mockImplementation(async () => ({ code: 230002, msg: 'no permission' }));
    await orchestrator.onMessage(message(inTopic));
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(records().map((r) => [r.reason, r.place, r.detail])).toEqual([['lookup-failed', 'topic', '话题里谁在说话']]);
  });

  it('answers a quote of its own message, and leaves a quote of someone else\'s', async () => {
    fake.get.mockImplementationOnce(async () => ({ code: 0, data: { items: [item('user')] } }));
    await orchestrator.onMessage(message({ ...inTopic, parent: 'om_t1' }));
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    fake.get.mockImplementationOnce(async () => ({ code: 0, data: { items: [item('self')] } }));
    topicSays(item('bot'));
    await orchestrator.onMessage(message({ ...inTopic, parent: 'om_t2' }));
    await answered();
    expect(audience().map((a) => [a.to, a.by])).toEqual([['other', 'quote'], ['me', 'quote']]);
  });

  it('opens a topic for a main-area quote of its own message (全部回复)', async () => {
    fake.get.mockImplementation(async () => ({ code: 0, data: { items: [item('self')] } }));
    fake.send.mockImplementation(async () => ({ messageId: 'om_reply', threadId: 'omt_new' }) as never);
    await orchestrator.onMessage(message({ parent: 'om_my_help_card' }));
    await answered();
  });

  it('does not answer a quote it cannot look up', async () => {
    fake.get.mockImplementation(async () => ({ code: 99991400, msg: 'rate limited' }));
    fake.project = { ...fake.project, kind: 'single' };
    await orchestrator.onMessage(message({ parent: 'om_q' }));
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(records().map((r) => [r.reason, r.place, r.detail])).toEqual([['lookup-failed', 'main', '引用的消息']]);
  });

  it('needs an @ for a main-area command, and answers one with an @', async () => {
    await orchestrator.onMessage(message({ text: '/model' }));
    expect(fake.send).not.toHaveBeenCalled();
    expect(audience()).toEqual([{ to: 'other', by: 'command-needs-at', ref: expect.any(String) }]);
    expect(records()).toEqual([]); // two bots, read: not for it
    await orchestrator.onMessage(message({ text: '/model', atMe: true }));
    expect(fake.send).toHaveBeenCalledTimes(1);
  });

  it('takes a group whose info it cannot read as one with other bots', async () => {
    fake.chatGet.mockImplementation(async () => { throw new Error('socket hang up'); });
    await orchestrator.onMessage(message({ text: '/model' }));
    expect(fake.send).not.toHaveBeenCalled();
    expect(records().map((r) => [r.reason, r.place, r.detail])).toEqual([['lookup-failed', 'main', '群里有几个 bot']]);
    topicSays(item('self'));
    await orchestrator.onMessage(message(inTopic));
    await answered();
    expect(fake.chatGet).toHaveBeenCalledTimes(1); // cached
  });

  it('as the only bot, answers a main-area command without an @ and reads no topic', async () => {
    fake.chatGet.mockImplementation(async () => ({ code: 0, data: { chat_mode: 'group', bot_count: '1' } }));
    await orchestrator.onMessage(message({ text: '/model' }));
    expect(fake.send).toHaveBeenCalledTimes(1);
    await orchestrator.onMessage(message(inTopic));
    await answered();
    expect(speakerLookups()).toBe(0); // the turn's own history pull carries sender names
  });

  it("still rejects another bot in a rule group, even one that @-mentions it", async () => {
    await orchestrator.onMessage(message({ sender: 'app', senderId: 'ou_other_bot', ...inTopic }));
    await orchestrator.onMessage(message({ sender: 'app', senderId: 'ou_other_bot', atMe: true }));
    expect(fake.startThread).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'reject', { reason: 'bot-sender', ref: expect.any(String) });
    expect(records()).toEqual([]);
  });

  it('in 仅@ looks nothing up and answers only an @', async () => {
    fake.project = { ...fake.project, noMention: false };
    await orchestrator.onMessage(message(inTopic));
    await orchestrator.onMessage(message({ parent: 'om_q' }));
    expect([fake.chatGet, fake.get, fake.list].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
    expect(fake.startThread).not.toHaveBeenCalled();
    await orchestrator.onMessage(message({ ...inTopic, atMe: true }));
    await answered();
  });
});
