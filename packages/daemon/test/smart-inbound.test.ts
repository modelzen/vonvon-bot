import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRevision } from '../src/admin/collaboration';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { wakeTables } from '../src/bot/bot-wake';
import { existsSync } from 'node:fs';
import { BOT_WAKE_NOTE, INITIATIVE_NOTE } from '../src/bot/session-title';
import { JUDGE_BUDGET, JudgeBudget } from '../src/bot/smart-intake';
import type { JudgeRequest, JudgeResult } from '../src/judge/types';
import { receive, type EventMessage, type ReceiveOpts } from './helpers/lark-events';

vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'smart-inbound-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments'), botsFile: join(appDir, 'bots.json') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  sessions: {} as Record<string, unknown>,
  projectLookup: vi.fn(),
  fullOnly: false,
  /** Holds every session read while set: an intake parked on the disk. */
  hold: undefined as Promise<void> | undefined,
  send: vi.fn(async () => ({ messageId: 'om_sent' })),
  get: vi.fn(async (_req: { path: { message_id: string } }) =>
    ({ code: 0, data: { items: [{ thread_id: 'omt_opened' }] as Array<Record<string, unknown>> } })),
  list: vi.fn(),
  request: vi.fn(),
  reply: vi.fn(async () => ({ code: 0, data: { message_id: 'om_reminder' } })),
  // One id per emoji, so the test sees which reaction went.
  react: vi.fn(async (req: { data: { reaction_type: { emoji_type: string } } }) => ({ data: { reaction_id: `r_${req.data.reaction_type.emoji_type}` } })),
  unreact: vi.fn(async () => ({})),
  inputs: [] as string[],
  /** A turn's events, when a test says; else it ends at once with nothing said. */
  events: undefined as (() => AsyncGenerator<unknown>) | undefined,
  del: vi.fn(),
  /** Each run card's create arguments, and the frames cards were finalized with. */
  cards: [] as unknown[][],
  finals: [] as unknown[],
  bots: '1',
  judge: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
const startThread = vi.fn(async () => ({
  sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
  runStreamed: (input: { text: string }) => {
    fake.inputs.push(input.text);
    return { turnId: () => 'turn-fixture', events: fake.events?.() ?? (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })() };
  },
}));

vi.mock('../src/bot/bot-wake', async original => {
  const real = await original<typeof import('../src/bot/bot-wake')>();
  return { ...real, wakeTables: vi.fn(real.wakeTables) };
});

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => { await fake.projectLookup(); return fake.project; } }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], startThread, fullAccessOnly: () => fake.fullOnly }) }));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async (key: string) => { await fake.hold; return fake.sessions[key]; }, upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/judge/judge', async original => ({
  ...await original<object>(),
  createJudge: () => ({ judge: fake.judge, warm: () => {}, shutdown: async () => {} }),
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create(...args: unknown[]) { fake.cards.push(args); return `card_${fake.cards.length}`; }
    async finalizeCard(_channel: unknown, card: unknown) { fake.finals.push(card); return true; }
    getCardId() { return 'card'; }
    async drain() {}
    async settleImages() { return new Map(); }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => true }); }
  },
}));

import { createOrchestrator } from '../src/bot/handle-message';

const BOT = { openId: 'ou_bot', name: '小码' };
const APP = 'cli_fixture';
const CHAT = 'oc_demo';
const base = { name: 'demo', chatId: CHAT, cwd: '/tmp/demo', kind: 'single', smart: true, mode: 'full', network: false };
const cfg: AppConfig & { preferences: NonNullable<AppConfig["preferences"]> } = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, completionReminder: { mode: 'manual' } } };
const channel = {
  send: fake.send, botIdentity: BOT,
  rawClient: { appId: APP, request: fake.request, im: { v1: {
    messageReaction: { create: fake.react, delete: fake.unreact },
    message: { reply: fake.reply, get: fake.get, list: fake.list, delete: fake.del },
    // The group's only bot unless a test says otherwise.
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', bot_count: fake.bots } }) },
  } } },
};

let sequence = 0;
let clock = Date.now();
/** A group message from the owner: `at` @-mentions this bot, `thread` puts it in a topic. */
function says(text: string, o: { at?: boolean; thread?: string } = {}): EventMessage {
  const id = `om_smart_${++sequence}`;
  const time = String(clock += 1000);
  return {
    message_id: id, create_time: time, update_time: time, chat_id: CHAT, chat_type: 'group', message_type: 'text',
    content: JSON.stringify({ text: o.at ? `@_user_1 ${text}` : text }),
    ...(o.at ? { mentions: [{ key: '@_user_1', id: { open_id: BOT.openId, union_id: 'on_bot' }, name: BOT.name, tenant_key: 't' }] } : {}),
    ...(o.thread ? { thread_id: o.thread, root_id: 'om_root', parent_id: 'om_root' } : {}),
  };
}
const idOf = (m: EventMessage) => String(m.message_id);

/** Judgements the test settles, by message id. A caller's abort settles one as `aborted`, as the judge layer does. */
const asked = new Map<string, { req: JudgeRequest; answer: Deferred<JudgeResult> }>();
const result = (decision: JudgeResult['decision'], extra: Partial<JudgeResult> = {}): JudgeResult =>
  ({ decision, reason: '', backend: 'codex-appserver', model: 'm', modelSource: 'default', promptSource: 'default', ms: 1, ...extra });
async function judged(m: EventMessage): Promise<{ req: JudgeRequest; answer: Deferred<JudgeResult> }> {
  await vi.waitFor(() => expect(asked.has(idOf(m))).toBe(true));
  return asked.get(idOf(m))!;
}
async function decide(m: EventMessage, value: JudgeResult): Promise<void> {
  (await judged(m)).answer.resolve(value);
}
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

let orchestrator: ReturnType<typeof createOrchestrator>;
let events: DiagnosticsEvent[] = [];
const records = () => events.flatMap((event) => event.kind === 'notReplied' ? [event.record] : []);
const send = async (m: EventMessage, sender?: ReceiveOpts['sender']) => orchestrator.onMessage(await receive(m, { bot: BOT, ...(sender ? { sender } : {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  asked.clear();
  events = [];
  fake.inputs = [];
  fake.sessions = {};
  fake.fullOnly = false;
  fake.hold = undefined;
  fake.project = { ...base };
  fake.projectLookup.mockReset();
  fake.list.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }));
  fake.get.mockImplementation(async () => ({ code: 0, data: { items: [{ thread_id: 'omt_opened' }] } }));
  fake.del.mockImplementation(async () => ({ code: 0 }));
  fake.events = undefined;
  fake.cards = [];
  fake.finals = [];
  fake.bots = '1';
  cfg.preferences.completionReminder = { mode: 'manual' };
  fake.request.mockImplementation(async () => ({ code: 0, data: { bots: [{ app_id: 'cli_other', member_id: 'ou_other', name: '小P' }] } }));
  fake.judge.mockImplementation((req: JudgeRequest) => {
    const answer = deferred<JudgeResult>();
    asked.set(req.ref!, { req, answer });
    req.signal?.addEventListener('abort', () => answer.resolve(result(req.variant === 'mentioned' ? 'main' : 'skip', { error: { kind: 'aborted' } })));
    return answer.promise;
  });
  setDiagnosticsSink((event) => events.push(event));
  orchestrator = createOrchestrator(channel as never, cfg, '/tmp/demo');
});
afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

describe('smart mode intake (s25)', () => {
  it('a judgement does not hold the chat: a topic @ is answered while the main area is still judged (A1)', async () => {
    const chatter = says('这个报错是不是缓存的问题');
    await send(chatter); // returns while the judgement runs
    expect((await judged(chatter)).req.variant).toBe('main');
    await send(says('帮我看下日志', { at: true, thread: 'omt_t' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain('帮我看下日志');
    expect(asked.size).toBe(1);
  });

  it('notes a skip with the reason and a failure with its detail, on the page only', async () => {
    const a = says('中午吃什么');
    await send(a);
    await decide(a, result('skip', { reason: '闲聊，和我无关' }));
    const b = says('今天好热');
    await send(b);
    await decide(b, result('skip', { error: { kind: 'timeout', detail: '判断超时' } }));
    // 80 emoji are 160 UTF-16 units: cut to the record's 120, not dropped by its schema.
    const c = says('哈哈');
    await send(c);
    await decide(c, result('skip', { reason: '😀'.repeat(80) }));
    await vi.waitFor(() => expect(records()).toHaveLength(3));
    expect(records().map((r) => [r.reason, r.detail])).toEqual([['judge-skip', '闲聊，和我无关'], ['judge-failed', '判断超时'], ['judge-skip', '😀'.repeat(60)]]);
    expect(startThread).not.toHaveBeenCalled();
  });

  it('joins in with the fixed initiative line, never the judge reason', async () => {
    const m = says('登录接口为什么 500');
    await send(m);
    await decide(m, result('main', { reason: 'SECRET_REASON_FIXTURE' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain(INITIATIVE_NOTE);
    expect(fake.inputs[0]).toContain('登录接口为什么 500');
    expect(fake.inputs[0]).not.toContain('SECRET_REASON_FIXTURE');
  });

  it('judges a named message only for where, marks it seen meanwhile, and answers it without the initiative line', async () => {
    const m = says('看下这个', { at: true });
    await send(m);
    expect((await judged(m)).req.variant).toBe('mentioned');
    await vi.waitFor(() => expect(fake.react).toHaveBeenCalledWith({ path: { message_id: idOf(m) }, data: { reaction_type: { emoji_type: 'THINKING' } } }));
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
    await vi.waitFor(() => expect(fake.unreact).toHaveBeenCalledWith({ path: { message_id: idOf(m), reaction_id: 'r_THINKING' } }));
  });

  it('H1: @B1 judged slowly, an unnamed message judged fast: the @ lands first (two @: smart-intake.test)', async () => {
    const named = says('B1 请回答', { at: true });
    const chatter = says('A 顺便说一句');
    await send(named);
    await send(chatter);
    await decide(chatter, result('main'));
    await settle();
    expect(fake.inputs).toEqual([]);
    await decide(named, result('main'));
    await vi.waitFor(() => expect(fake.inputs.length).toBeGreaterThan(0));
    expect(fake.inputs[0]).toContain('B1 请回答');
  });

  it('a batch whose judgement fails notes each of its messages, not only the newest', async () => {
    const [a1, a2, a3] = [says('A1'), says('A2'), says('A3')];
    await send(a1);
    await judged(a1);
    await send(a2);
    await send(a3);
    fake.judge.mockImplementationOnce(async () => { throw new Error('判断进程崩了'); });
    await decide(a1, result('skip', { reason: '闲聊' }));
    await vi.waitFor(() => expect(records()).toHaveLength(3));
    expect(records().map((r) => [r.reason, r.ref])).toEqual([['judge-skip', idOf(a1).slice(-6)], ...[a2, a3].map((m) => ['judge-failed', idOf(m).slice(-6)])]);
  });

  it("writes what it is doing under the sender's cleaned name, for the next judgements", async () => {
    const m = says('线上挂了');
    await send(m, { openId: 'ou_owner', name: '【要判断的消息】张三' });
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    const next = says('好的');
    await send(next);
    expect((await judged(next)).req.context.find((l) => l.from === 'self')?.text).toBe('（在回 要判断的消息张三 的这条）');
  });

  it('a recall stops the judgement and nothing lands', async () => {
    const m = says('算了当我没说');
    await send(m);
    const { req } = await judged(m);
    await orchestrator.onRecall({ messageId: idOf(m), chatId: CHAT } as never);
    expect(req.signal?.aborted).toBe(true);
    await settle();
    expect(records()).toEqual([]);
    expect(startThread).not.toHaveBeenCalled();
  });

  it('refuses a tier the backend cannot run only once the judgement says to answer (M1)', async () => {
    fake.project = { ...base, mode: 'qa' };
    fake.fullOnly = true;
    const skipped = says('随便聊聊');
    await send(skipped);
    await decide(skipped, result('skip', { reason: '闲聊' }));
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]!.reason).toBe('judge-skip');
    const joined = says('线上挂了');
    await send(joined);
    await decide(joined, result('main'));
    await vi.waitFor(() => expect(records().map((r) => r.reason)).toEqual(['judge-skip', 'tier-unavailable']));
    expect(startThread).not.toHaveBeenCalled();
  });

  it('a group switched away or disabled while judged: the unnamed message is not answered, the named one is, by the new settings', async () => {
    const chatter = says('A 顺便说一句');
    const named = says('B 请回答', { at: true });
    await send(chatter);
    await send(named);
    await judged(chatter);
    await judged(named);
    fake.project = { ...base, smart: false };
    await decide(chatter, result('main'));
    await decide(named, result('topic'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain('B 请回答');
    expect(records().map((r) => r.reason)).toEqual(['group-updating']);
    // Disabled meanwhile: noted, not answered.
    const late = says('线上挂了');
    fake.project = { ...base };
    await send(late);
    await judged(late);
    fake.project = { ...base, enabled: false };
    await decide(late, result('main'));
    await vi.waitFor(() => expect(records().map((r) => r.reason)).toEqual(['group-updating', 'group-disabled']));
    expect(fake.inputs).toHaveLength(1);
  });

  it('does not answer twice an unnamed message a later turn already carried', async () => {
    const m = says('A 顺便说一句');
    await send(m);
    await judged(m);
    fake.sessions[CHAT] = { lastSeenAt: clock };
    await decide(m, result('main'));
    await vi.waitFor(() => expect(records().map((r) => r.reason)).toEqual(['judge-superseded']));
    expect(startThread).not.toHaveBeenCalled();
  });

  it(`stops judging after ${JUDGE_BUDGET} judgements in an hour; a named message then goes to the main area unjudged`, async () => {
    fake.judge.mockImplementation(async (req: JudgeRequest) => { asked.set(req.ref!, { req, answer: deferred() }); return result('skip'); });
    for (let i = 0; i < JUDGE_BUDGET; i++) {
      await send(says(`第 ${i} 句`));
      await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(i + 1));
    }
    await send(says('超了'));
    await vi.waitFor(() => expect(records().filter((r) => r.reason === 'judge-budget')).toHaveLength(1));
    await send(says('请回答', { at: true }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.judge).toHaveBeenCalledTimes(JUDGE_BUDGET);
  });

  it('judges an unnamed topic message only for whether to reply', async () => {
    const m = says('接着说', { thread: 'omt_t' });
    await send(m);
    expect((await judged(m)).req.variant).toBe('topic');
    await decide(m, result('reply'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
  });

  it('at shutdown keeps the named messages still judged for an answer once back, not the unnamed ones (M7)', async () => {
    const file = join(paths.appDir, 'dropped.json');
    const kept = createOrchestrator(channel as never, cfg, '/tmp/demo', undefined, { droppedFile: file });
    const named = says('B 请回答', { at: true });
    const chatter = says('A 顺便说一句');
    await kept.onMessage(await receive(named, { bot: BOT }));
    await kept.onMessage(await receive(chatter, { bot: BOT }));
    const signals = [(await judged(named)).req.signal, (await judged(chatter)).req.signal];
    await kept.shutdown();
    expect(signals.every((s) => s?.aborted)).toBe(true);
    const saved = readFileSync(file, 'utf8');
    expect(saved).toContain(idOf(named));
    expect(saved).not.toContain(idOf(chatter));
    expect(startThread).not.toHaveBeenCalled();
    // No landing takes its THINKING off now.
    expect(fake.unreact).toHaveBeenCalledWith({ path: { message_id: idOf(named), reaction_id: 'r_THINKING' } });
  });

  it('keeps for an answer once back a named message whose intake crossed the shutdown, with no THINKING put on', async () => {
    const file = join(paths.appDir, 'dropped-crossed.json');
    const kept = createOrchestrator(channel as never, cfg, '/tmp/demo', undefined, { droppedFile: file });
    const disk = deferred<void>();
    fake.hold = disk.promise;
    const named = says('B 请回答', { at: true });
    const intake = kept.onMessage(await receive(named, { bot: BOT }));
    await settle(); // parked on its session read
    const stopped = kept.shutdown();
    disk.resolve();
    await Promise.all([intake, stopped]);
    expect(readFileSync(file, 'utf8')).toContain(idOf(named));
    expect(fake.react).not.toHaveBeenCalled();
    expect(fake.judge).not.toHaveBeenCalled();
  });
});

describe('smart mode: one person in a topic, the anchor, the empty card (s25b)', () => {
  const owner = { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' };
  const me = { id: APP, id_type: 'app_id', sender_type: 'app', open_bot_id: BOT.openId };
  /** A topic page newest first; `more` says another page follows. */
  const page = (senders: object[], more = false) => ({ code: 0, data: { items: senders.map((sender, i) => ({ message_id: `om_p${i}`, msg_type: 'text', sender })), has_more: more, ...(more ? { page_token: 'p2' } : {}) } });
  /** Only the topic scan lists without sender names. */
  const scans = () => fake.list.mock.calls.filter(([r]) => (r as { params: { with_sender_name?: boolean } }).params.with_sender_name === undefined);
  const answered = () => vi.waitFor(() => expect(fake.inputs).toHaveLength(1));

  it('answers unjudged, outside the budget, where only the sender talks with this bot', async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    fake.list.mockImplementation(async () => page([owner, me, owner]));
    await send(says('接着说', { thread: 'omt_t' }));
    await answered();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(take).not.toHaveBeenCalled();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'judge-solo', expect.anything());
    expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
    take.mockRestore();
  });

  it('judges when someone else spoke there, or a later page failed', async () => {
    fake.list.mockImplementation(async () => page([owner, me, { ...owner, id: 'ou_other' }]));
    const second = says('接着说', { thread: 'omt_t' });
    await send(second);
    await judged(second);
    fake.list.mockImplementation(async ({ params }: { params: { page_token?: string } }) => params.page_token ? { code: 230002, msg: 'x' } : page([owner, me], true));
    const failed = says('还在吗', { thread: 'omt_u' });
    await send(failed);
    await judged(failed);
  });

  it('with other bots, 三条底线 and the judgement read the topic once', async () => {
    fake.bots = '2';
    fake.list.mockImplementation(async () => page([owner, me]));
    await send(says('接着说', { thread: 'omt_t' }));
    await answered();
    expect(scans()).toHaveLength(1);
    expect(fake.judge).not.toHaveBeenCalled();
  });

  it('opens the topic under the earlier line the judgement names', async () => {
    const asked = says('导出接口 500 有人看吗？');
    await send(asked);
    await decide(asked, result('skip', { reason: '闲聊' }));
    const more = says('顺便说一下是生产环境');
    await send(more);
    fake.get.mockImplementationOnce(async () => ({ code: 0, data: { items: [{ create_time: '1' }] } })); // no topic under it
    await decide(more, result('topic', { anchor: idOf(asked) }));
    await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(asked), replyInThread: true });
    expect(fake.get).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: idOf(asked) } }));
    expect(fake.inputs[0]).toContain('下面这条是接着它说的');
    expect(fake.inputs[0]).toContain('顺便说一下是生产环境');
  });

  it('opens it on the message itself when the line has a topic, names someone, is not a person\'s or too far back, or the message named this bot (H2, M5, M6)', async () => {
    const [plain, threaded] = [says('导出接口 500 有人看吗？'), says('登录也挂了')];
    for (const m of [plain, threaded]) {
      await send(m);
      await decide(m, result('skip', { reason: '闲聊' }));
    }
    // Only `threaded` has a topic under it, by Feishu; a card has the one it opened.
    fake.get.mockImplementation(async ({ path }: { path: { message_id: string } }) =>
      ({ code: 0, data: { items: [{ create_time: '1', ...(path.message_id === idOf(threaded) || path.message_id.startsWith('card') ? { thread_id: 'omt_x' } : {}) }] } }));
    // Says nothing to this bot (it names another), but is a line of the ring.
    const named = says('@_user_2 你看下');
    named.mentions = [{ key: '@_user_2', id: { open_id: 'ou_x', union_id: 'on_x' }, name: '小审', tenant_key: 't' }];
    await send(named);
    const [first, third] = [says('顺便说一下是生产环境'), says('还有一件事')];
    const cases: Array<[EventMessage, string]> = [
      [first, idOf(threaded)],
      [says('他说的那个'), idOf(named)],
      [third, `act:${idOf(first)}`], // this bot's own line
      [says('看下这个', { at: true }), idOf(third)], // a plain line right before, but this one named the bot
      [says('最早那条'), idOf(plain)], // more than 5 lines back (M6)
    ];
    for (const [i, [m, anchor]] of cases.entries()) {
      await send(m);
      await decide(m, result('topic', { anchor }));
      await vi.waitFor(() => expect(fake.cards).toHaveLength(i + 1));
      expect(fake.cards[i]![3]).toMatchObject({ replyTo: idOf(m) });
    }
  });

  it('a second judgement naming the line a topic is still being opened under opens on its own message', async () => {
    const [lisi, zhang] = [{ openId: 'ou_lisi', name: '李四' }, { openId: 'ou_owner', name: '张三' }];
    const asked = says('导出接口 500 有人看吗？');
    await send(asked, lisi);
    await decide(asked, result('skip', { reason: '闲聊' }));
    // Feishu shows no topic under the line until its card is there; the first topic's backend is slow to start.
    fake.get.mockImplementation(async ({ path }: { path: { message_id: string } }) =>
      ({ code: 0, data: { items: [{ create_time: '1', ...(path.message_id.startsWith('card') ? { thread_id: 'omt_x' } : {}) }] } }));
    const started = deferred<void>();
    const impl = startThread.getMockImplementation()!;
    startThread.mockImplementationOnce(async () => { await started.promise; return impl(); });
    const first = says('顺便说一下是生产环境');
    await send(first, zhang);
    await decide(first, result('topic', { anchor: idOf(asked) }));
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledTimes(1));
    const second = says('对，就是导出那个');
    await send(second, zhang);
    await decide(second, result('topic', { anchor: idOf(asked) }));
    await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
    started.resolve();
    await vi.waitFor(() => expect(fake.cards).toHaveLength(2));
    expect(fake.cards.map((c) => (c[3] as { replyTo: string }).replyTo).sort()).toEqual([idOf(asked), idOf(second)].sort());
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'anchor-dropped', { ref: idOf(second).slice(-6), why: 'has-topic' });
    // What the next judgement reads: the dropped line's name written over with the sender's.
    const next = says('好的');
    await send(next);
    expect((await judged(next)).req.context.filter((l) => l.from === 'self' && l.text.includes('开了话题')).map((l) => l.text))
      .toEqual(['（在 李四 的这条下开了话题来回）', '（在 张三 的这条下开了话题来回）']);
  });

  it('the next judgement sees the topic it opens while the line under it is still looked up', async () => {
    const asked = says('导出接口 500 有人看吗？');
    await send(asked, { openId: 'ou_owner', name: '张三' });
    await decide(asked, result('skip', { reason: '闲聊' }));
    const lookup = deferred<{ code: number; data: { items: Array<{ thread_id?: string; create_time?: string }> } }>();
    fake.get.mockImplementation(async ({ path }: { path: { message_id: string } }) => path.message_id === idOf(asked)
      ? lookup.promise : { code: 0, data: { items: [{ thread_id: 'omt_opened' }] } });
    const more = says('顺便说一下是生产环境');
    await send(more, { openId: 'ou_owner', name: '张三' });
    await decide(more, result('topic', { anchor: idOf(asked) }));
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: idOf(asked) } })));
    const next = says('好的');
    await send(next);
    expect((await judged(next)).req.context.filter((l) => l.from === 'self').map((l) => l.text)).toEqual(['（在 张三 的这条下开了话题来回）']);
    lookup.resolve({ code: 0, data: { items: [{ create_time: '1' }] } });
    await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(asked) });
  });

  it('notes the confidence when a skip gives no reason (s23f)', async () => {
    const m = says('嗯');
    await send(m);
    await decide(m, result('skip', { reason: '', confidence: 0.62 }));
    await vi.waitFor(() => expect(records().map((r) => r.detail)).toEqual(['把握度 0.62']));
  });

  it('deletes the card of a turn it joined on its own and said nothing in, notes it, and the next judgement sees it', async () => {
    const m = says('3 加 3 等于几');
    await send(m);
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.del).toHaveBeenCalledWith({ path: { message_id: 'card_1' } }));
    await vi.waitFor(() => expect(records().map((r) => [r.reason, r.detail])).toEqual([['judge-empty', undefined]]));
    expect(fake.finals).toEqual([]);
    const next = says('好吧');
    await send(next);
    expect((await judged(next)).req.context.some((l) => l.from === 'self' && l.text === '（看了，没有要补的，没有回）')).toBe(true);
    // Its own card's recall event does not take that line out.
    await orchestrator.onRecall({ messageId: 'card_1', chatId: CHAT } as never);
    const third = says('再问一句');
    await send(third);
    await decide(next, result('skip', { reason: '闲聊' }));
    expect((await judged(third)).req.context.some((l) => l.text === '（看了，没有要补的，没有回）')).toBe(true);
  });

  it('a delete Feishu refuses leaves one short line and says why (M8)', async () => {
    fake.del.mockImplementation(async () => ({ code: 230027, msg: 'Lack of necessary permissions' }));
    const m = says('3 加 3 等于几');
    await send(m);
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
    expect(JSON.stringify(fake.finals[0])).toContain('（没有要补的）');
    expect(JSON.stringify(fake.finals[0])).not.toContain('未返回内容');
    expect(records()[0]).toMatchObject({ reason: 'judge-empty', detail: '空卡没删成，缺权限（230027），卡上留了一行' });
  });

  it('keeps the card of a turn that used a tool or failed, and of an @ answered with nothing', async () => {
    const turns = [
      async function* () { yield { type: 'tool_use', itemId: 't1', title: 'ls' }; yield { type: 'tool_result', itemId: 't1', output: '' }; yield { type: 'done', turnId: 'turn-fixture' }; },
      async function* () { yield { type: 'error', message: 'boom', willRetry: false }; },
    ];
    for (const turn of turns) {
      fake.events = turn;
      const m = says(`空：${turns.indexOf(turn)}`);
      await send(m);
      await decide(m, result('main'));
      await vi.waitFor(() => expect(fake.finals).toHaveLength(turns.indexOf(turn) + 1));
    }
    fake.events = undefined;
    const named = says('你好', { at: true });
    await send(named);
    await decide(named, result('main'));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(3));
    expect(JSON.stringify(fake.finals[2])).toContain('未返回内容');
    expect(fake.del).not.toHaveBeenCalled();
  });

  it('H1: an @ steered into the turn it joined gets its own card, which stays though nothing is said', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.events = async function* () { await gate; yield { type: 'done', turnId: 'turn-fixture' }; };
    const chatter = says('线上挂了吗');
    await send(chatter);
    await decide(chatter, result('main'));
    await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
    const named = says('看下这个', { at: true });
    await send(named);
    await decide(named, result('main'));
    await vi.waitFor(() => expect(fake.cards).toHaveLength(2));
    expect(fake.cards[1]![3]).toMatchObject({ replyTo: idOf(named) });
    release();
    await vi.waitFor(() => expect(fake.finals).toHaveLength(2));
    expect(fake.del).not.toHaveBeenCalled();
  });
});

describe('bot wakes (s27a)', () => {
  const other = { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' };
  const owner = { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' };
  const item = (m: EventMessage, sender: object = other, extra: object = {}) => ({
    message_id: idOf(m), create_time: m.create_time, msg_type: m.message_type,
    body: { content: m.content }, sender,
    mentions: [{ id: BOT.openId, id_type: 'open_id', key: '@_user_1', name: BOT.name }], ...extra,
  });
  const page = (items: object[], more = false) => ({ code: 0, data: { items, has_more: more, page_token: more ? 'next' : undefined } });
  const botSays = (m: EventMessage, openId = 'ou_other') => send(m, { openId, type: 'app', name: '小P' });
  const answered = (n = 1) => vi.waitFor(() => expect(fake.inputs).toHaveLength(n));
  const noted = (reason: string) => vi.waitFor(() => expect(records().map(r => r.reason)).toContain(reason));
  const history = (m: EventMessage, earlier: object[] = []) => fake.list.mockResolvedValue(page([item(m), ...earlier,
    item({ ...m, message_id: 'om_person', create_time: String(Number(m.create_time) - 60_000) }, owner)]));
  const wake = (o: { thread?: string; text?: string } = {}) => says(o.text ?? 'SECRET_BOT_TEXT', { at: true, thread: o.thread });

  it('answers a topic bot mention without judging or budget, with the bot envelope and THINKING removed', async () => {
    const m = wake({ thread: 'omt_wake' }); history(m);
    const take = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValue(false);
    try {
      await botSays(m); await answered();
      expect(fake.inputs[0]).toContain(BOT_WAKE_NOTE('小P', 1));
      expect(fake.inputs[0]!.indexOf(BOT_WAKE_NOTE('小P', 1))).toBeLessThan(fake.inputs[0]!.indexOf('[本条消息的发信人'));
      expect(fake.inputs[0]).toContain('小P（bot）（open_id：ou_other）');
      expect(fake.inputs[0]).toContain('SECRET_BOT_TEXT');
      expect(fake.judge).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled();
      expect(fake.list).toHaveBeenCalled(); expect(fake.request).toHaveBeenCalled();
      await vi.waitFor(() => expect(fake.unreact).toHaveBeenCalled());
      expect(fake.react).toHaveBeenCalledWith(expect.objectContaining({ data: { reaction_type: { emoji_type: 'THINKING' } } }));
      expect(fake.log.info.mock.calls.some(c => c[1] === 'judge-budget')).toBe(false);
    } finally { take.mockRestore(); }
  });

  it('replies to a main-area trigger in the main area', async () => {
    const m = wake(); history(m); await botSays(m); await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(m), replyInThread: false });
  });

  it.each(['single', 'multi', 'unbound'])('keeps rejecting bots in %s rule groups without reading or noting', async kind => {
    fake.project = kind === 'unbound' ? undefined : { ...base, kind, smart: false };
    await botSays(wake()); await settle();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'reject', expect.objectContaining({ reason: 'bot-sender' }));
    expect(fake.list).not.toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled();
    expect(records()).toEqual([]); expect(fake.inputs).toEqual([]);
    fake.project = { ...base }; const m = wake({ thread: 'omt_control' }); history(m);
    await botSays(m); await answered();
  });

  it.each([5, 6, 7])('counts %i wakes from shared history and stops only past six', async n => {
    const m = wake();
    const earlier = Array.from({ length: n - 1 }, (_, i) => item({ ...m, message_id: `om_before_${i}`, create_time: String(Number(m.create_time) - 1000 - i * 1000) }));
    // An unmentioned, unanswered card is not another wake.
    earlier.push(item({ ...m, message_id: 'om_unanswered', create_time: String(Number(m.create_time) - 20_000) }, other, { msg_type: 'interactive', mentions: [] }));
    history(m, earlier); await botSays(m);
    if (n > 6) { await noted('bot-wake-cap'); expect(fake.inputs).toEqual([]); }
    else { await answered(); expect(fake.inputs[0]).toContain(`已互相叫醒 ${n} 次`); if (n === 6) expect(fake.inputs[0]).toContain('已到上限'); }
    expect(fake.log.info).toHaveBeenCalledWith('intake', n > 6 ? 'bot-wake-cap' : 'bot-wake', expect.objectContaining({ n }));
  });

  it('counts an unanswered card once when another application replied to it', async () => {
    const m = wake();
    history(m, [item({ ...m, message_id: 'om_answer', create_time: String(Number(m.create_time) - 1000) }, { ...other, id: APP, open_bot_id: BOT.openId }, { mentions: [], parent_id: 'om_card' }),
      item({ ...m, message_id: 'om_card', create_time: String(Number(m.create_time) - 2000) }, other, { msg_type: 'interactive', mentions: [] })]);
    await botSays(m); await answered(); expect(fake.inputs[0]).toContain(BOT_WAKE_NOTE('小P', 2));
  });

  it.each(['history-throw', 'history-code', 'roster-throw', 'roster-missing', 'boundary'])('fails closed when %s cannot be read', async failure => {
    const m = wake({ thread: 'omt_fail' }); history(m);
    if (failure === 'history-throw') fake.list.mockRejectedValue(new Error('network'));
    if (failure === 'history-code') fake.list.mockResolvedValue({ code: 230001 });
    if (failure === 'roster-throw') fake.request.mockRejectedValue(new Error('network'));
    if (failure === 'roster-missing') fake.request.mockResolvedValue({ code: 0, data: {} });
    if (failure === 'boundary') fake.list.mockResolvedValue(page([item(m, other, { mentions: [] })], true));
    await botSays(m); await noted('bot-wake-failed');
    expect(records()).toHaveLength(1); expect(fake.inputs).toEqual([]);
    expect(records()[0]?.detail).toBe(failure.startsWith('history') ? '历史读不到' : failure.startsWith('roster') ? '群成员列表读不到' : '没读到上一条真人消息');
  });

  it('catches a counting exception without falling back to direct, and removes THINKING', async () => {
    const m = wake({ thread: 'omt_boom' }); history(m);
    vi.mocked(wakeTables).mockImplementationOnce(() => { throw new Error('boom'); });
    await botSays(m); await noted('bot-wake-failed');
    expect(records()[0]?.detail).toBe('boom'); expect(fake.inputs).toEqual([]); expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.log.fail).toHaveBeenCalledWith('intake', expect.any(Error), expect.objectContaining({ phase: 'bot-wake' }));
    await vi.waitFor(() => expect(fake.unreact).toHaveBeenCalled());
  });

  it('does not use a person later than the trigger as a reset boundary', async () => {
    const m = wake();
    history(m, [item({ ...m, message_id: 'om_later', create_time: String(Number(m.create_time) + 1000) }, owner),
      item({ ...m, message_id: 'om_before', create_time: String(Number(m.create_time) - 1000) })]);
    await botSays(m); await answered(); expect(fake.inputs[0]).toContain(BOT_WAKE_NOTE('小P', 2));
  });

  it.each([
    ['ou_other', ['ou_owner'], false], ['ou_other', ['ou_owner', 'ou_other'], true],
    ['cli_other', ['ou_other'], true], ['cli_other', ['ou_owner'], false], ['ou_wrong', ['ou_other'], true], ['ou_other', [], true],
  ])('checks the resolved sender only at landing (%s, %j)', async (eventId, allowedUsers, allowed) => {
    fake.project = { ...base, allowedUsers }; const m = wake({ thread: 'omt_audience' }); history(m);
    await botSays(m, eventId);
    if (allowed) await answered(); else { await noted('bot-wake-not-allowed'); expect(fake.inputs).toEqual([]); }
    expect(fake.list).toHaveBeenCalled(); expect(fake.request).toHaveBeenCalled();
  });

  it.each(['rule-mode', 'audience', 'disabled', 'unbound'])('rechecks %s after counting completes', async change => {
    const m = wake({ thread: 'omt_change' }); const gate = deferred<ReturnType<typeof page>>();
    fake.list.mockReturnValue(gate.promise); await botSays(m);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
    fake.project = change === 'unbound' ? undefined : { ...base, ...(change === 'rule-mode' ? { smart: false } : change === 'disabled' ? { enabled: false } : { allowedUsers: ['ou_owner'] }) };
    gate.resolve(page([item(m)])); await settle();
    if (change !== 'unbound') await noted(change === 'audience' ? 'bot-wake-not-allowed' : change === 'disabled' ? 'group-disabled' : 'bot-wake-dropped');
    expect(fake.inputs).toEqual([]);
  });

  it('notes a disabled smart group at intake', async () => {
    fake.project = { ...base, enabled: false }; await botSays(wake()); await noted('group-disabled');
    expect(fake.list).not.toHaveBeenCalled();
  });

  it.each(['/goal 做点什么', '/compact'])('treats %s from a bot as ordinary text', async text => {
    const m = wake({ thread: 'omt_command', text }); history(m); await botSays(m); await answered();
    expect(fake.inputs[0]).toContain(text);
    expect(fake.react.mock.calls.some(([r]) => r.data.reaction_type.emoji_type === 'OKR')).toBe(false);
  });

  it('keeps an unrelated topic responsive while counting hangs', async () => {
    const m = wake({ thread: 'omt_hung' }); const gate = deferred<ReturnType<typeof page>>();
    fake.list.mockImplementation(async (r: { params: { container_id: string } }) => r.params.container_id === 'omt_hung' ? gate.promise : page([])); await botSays(m);
    await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
    await send(says('PERSON_CONTROL', { at: true, thread: 'omt_other' })); await answered();
    expect(fake.inputs[0]).toContain('PERSON_CONTROL'); gate.resolve(page([item(m)])); await answered(2);
  });

  it('lands a preceding named human before a bot whose count finishes first', async () => {
    const human = says('PERSON_FIRST', { at: true }); await send(human); await judged(human);
    const m = wake(); history(m); await botSays(m); await settle(); expect(fake.inputs).toEqual([]);
    await decide(human, result('main')); await answered(2);
    expect(fake.inputs[0]).toContain('PERSON_FIRST'); expect(fake.inputs[1]).toContain('SECRET_BOT_TEXT');
  });

  it.each(['ou_bot', 'ou_other'])('rejects itself while another bot wakes it (%s)', async sender => {
    const m = wake({ thread: 'omt_self' }); history(m); await botSays(m, sender);
    if (sender === 'ou_other') await answered(); else { await settle(); expect(fake.inputs).toEqual([]); expect(fake.list).not.toHaveBeenCalled(); }
  });

  it('records sender kind and logs wake metadata without names, body or full ids', async () => {
    const m = wake({ thread: 'omt_logs' }); history(m); await botSays(m); await answered();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recv', expect.objectContaining({ senderType: 'app', senderIdKind: 'ou_' }));
    const logs = fake.log.info.mock.calls.filter(c => String(c[1]).startsWith('bot-wake'));
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(new RegExp(`SECRET_BOT_TEXT|小P|${idOf(m)}|ou_other`));
  });

  it.each(['intake', 'count', 'land'])('shutdown during %s never persists a bot for resend or notes it', async stage => {
    await orchestrator.shutdown(); const file = join(paths.appDir, `wake-${stage}.json`);
    orchestrator = createOrchestrator(channel as never, cfg, '/tmp/demo', undefined, { droppedFile: file });
    const m = wake({ thread: 'omt_stop' }); const disk = deferred<void>(); const count = deferred<ReturnType<typeof page>>();
    history(m);
    if (stage === 'intake') fake.hold = disk.promise;
    else fake.list.mockReturnValue(count.promise);
    if (stage === 'count') fake.request.mockReturnValue(new Promise(() => {}));
    const intake = botSays(m);
    if (stage === 'intake') await settle();
    else {
      await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
      if (stage === 'land') { fake.hold = disk.promise; count.resolve(page([item(m)])); await settle(); }
    }
    const stop = orchestrator.shutdown(); disk.resolve();
    await Promise.race([stop, new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 2900))]);
    count.resolve(page([item(m)])); await intake; await settle();
    expect(fake.inputs).toEqual([]); expect(records()).toEqual([]);
    if (existsSync(file)) expect(readFileSync(file, 'utf8')).not.toContain(idOf(m));
    if (stage !== 'land') expect(fake.log.info).toHaveBeenCalledWith('intake', 'bot-wake-dropped', expect.objectContaining({ why: 'shutdown' }));
  });
});

// Separate describe keeps the shared fixture while exercising sender and lifecycle fallbacks.
describe('bot wake fallbacks and queued turns (s27a)', () => {
  const memento = (m: EventMessage, sender: object = { sender_type: 'app', id: 'cli_other', open_bot_id: 'ou_other', sender_name: '小P' }) => ({
    message_id: idOf(m), create_time: m.create_time, msg_type: m.message_type, body: { content: m.content }, sender,
    mentions: [{ id: BOT.openId, id_type: 'open_id', key: '@_user_1', name: BOT.name }],
  });
  const page = (items: object[]) => ({ code: 0, data: { items, has_more: false } });
  const botSays = (m: EventMessage, openId = 'ou_other') => send(m, { openId, type: 'app', name: '小P' });
  const answered = (n = 1) => vi.waitFor(() => expect(fake.inputs).toHaveLength(n));

  it.each([true, false])('uses card text from history when listed=%s, otherwise fetches the card', async listed => {
    const m = { ...says('', { at: true, thread: 'omt_card' }), message_type: 'interactive', content: JSON.stringify({ text: '降级占位' }) };
    const card = { ...memento(m), body: { content: JSON.stringify({ title: 'CARD_BODY_FIXTURE', elements: [] }) } };
    fake.list.mockResolvedValue(page(listed ? [card] : []));
    fake.get.mockResolvedValue({ code: 0, data: { items: [card] } });
    await botSays(m); await answered();
    expect(fake.inputs[0]).toContain('CARD_BODY_FIXTURE');
    const cardReads = fake.get.mock.calls.filter(([r]) => r.path.message_id === idOf(m) && 'params' in r && JSON.stringify(r).includes('card_msg_content_type'));
    expect(cardReads.length > 0).toBe(!listed);
  });

  it.each([true, false])('resolves missing trigger sender with metadata when readable=%s', async readable => {
    const m = says('继续看', { at: true, thread: 'omt_sender' }); fake.list.mockResolvedValue(page([]));
    if (readable) fake.get.mockResolvedValue({ code: 0, data: { items: [memento(m)] } });
    else fake.get.mockRejectedValue(new Error('gone'));
    await botSays(m, 'cli_other'); await answered();
    if (readable) expect(fake.inputs[0]).toContain('open_id：ou_other');
    else { expect(fake.inputs[0]).not.toContain('本条消息的发信人'); expect(fake.inputs[0]).toContain(BOT_WAKE_NOTE('另一个 bot', 1)); }
  });

  it.each(['intake', 'land'])('does not answer a wake already seen at %s', async stage => {
    const m = says('ALREADY_SEEN', { at: true }); const gate = deferred<ReturnType<typeof page>>();
    if (stage === 'intake') fake.sessions[CHAT] = { lastSeenAt: Number(m.create_time) + 1000 };
    else fake.list.mockReturnValue(gate.promise);
    await botSays(m);
    if (stage === 'land') {
      await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
      fake.sessions[CHAT] = { lastSeenAt: Number(m.create_time) + 1000 }; gate.resolve(page([memento(m)]));
    }
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'bot-wake-superseded', expect.objectContaining({ at: stage })));
    expect(fake.inputs).toEqual([]);
    if (stage === 'intake') { expect(records()).toEqual([]); expect(fake.list).not.toHaveBeenCalled(); }
    else expect(records()[0]).toMatchObject({ reason: 'bot-wake-dropped', detail: '已随后来的消息进了会话' });
  });

  it('ignores a recalled wake and answers an otherwise identical control', async () => {
    const m = says('WITHDRAWN', { at: true, thread: 'omt_recalled' });
    await orchestrator.onRecall({ messageId: idOf(m), chatId: CHAT } as never); await botSays(m); await settle();
    expect(fake.inputs).toEqual([]);
    const control = says('CONTROL', { at: true, thread: 'omt_control' }); fake.list.mockResolvedValue(page([memento(control)]));
    await botSays(control); await answered();
  });

  it.each(['always', 'failures'] as const)('completion mode %s preserves the bot requester and post mention', async mode => {
    cfg.preferences.completionReminder = { mode }; const m = says('提醒测试', { at: true, thread: 'omt_remind' });
    fake.list.mockResolvedValue(page([memento(m)])); await botSays(m); await answered();
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
    if (mode === 'always') {
      expect(fake.reply).toHaveBeenCalledOnce();
      expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ msg_type: 'post', content: expect.stringContaining('ou_other') }) }));
      expect(fake.log.info).toHaveBeenCalledWith('card', 'completion-reminder', expect.objectContaining({ requester: 'bot' }));
    } else expect(fake.reply).not.toHaveBeenCalled();
  });

  it('keeps the wake envelope when a bot queues behind a human turn', async () => {
    fake.project = { ...base, pendingPolicy: 'queue' }; const gate = deferred<void>();
    fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('HUMAN_RUNNING', { at: true, thread: 'omt_queue' })); await answered();
    const m = says('BOT_QUEUED', { at: true, thread: 'omt_queue' }); fake.list.mockResolvedValue(page([memento(m)]));
    await botSays(m); await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    gate.resolve(); await answered(2);
    expect(fake.inputs[1]?.startsWith(BOT_WAKE_NOTE('小P', 1))).toBe(true);
  });

  it('does not persist a bot waiting for the global run slot', async () => {
    await orchestrator.shutdown(); const file = join(paths.appDir, 'wake-global-slot.json');
    orchestrator = createOrchestrator(channel as never, { ...cfg, preferences: { ...cfg.preferences, maxConcurrentRuns: 1 } }, '/tmp/demo', undefined, { droppedFile: file });
    const gate = deferred<void>(); fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('SLOT_OWNER', { at: true, thread: 'omt_slot_a' })); await answered();
    const m = says('BOT_WAITING', { at: true, thread: 'omt_slot_b' }); fake.list.mockResolvedValue(page([memento(m)]));
    await botSays(m); await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
    const stopping = orchestrator.shutdown(); gate.resolve(); await stopping;
    if (existsSync(file)) expect(readFileSync(file, 'utf8')).not.toContain(idOf(m));
  });
});

it('keeps failed card and sender lookup logs free of the trigger id, body and bot name', async () => {
  const m = { ...says('PRIVATE_BODY', { at: true, thread: 'omt_private' }), message_type: 'interactive' };
  fake.list.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  fake.get.mockImplementation(async r => {
    if (r.path.message_id === idOf(m)) throw new Error(`failed ${idOf(m)} PRIVATE_BODY 小P`);
    return { code: 0, data: { items: [] } };
  });
  await send(m, { openId: 'cli_other', type: 'app', name: '小P' });
  await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
  const lookups = fake.log.warn.mock.calls.filter(c => ['quote-fetch-failed', 'wake-sender-lookup-failed'].includes(String(c[1])) && JSON.stringify(c[2]).includes(idOf(m).slice(-6)));
  expect(lookups).toHaveLength(2);
  expect(JSON.stringify(lookups)).not.toMatch(new RegExp(`${idOf(m)}|PRIVATE_BODY|小P`));
});


it('a main-area bot wake does not take an exhausted judgement budget', async () => {
  const take = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValue(false);
  try {
    await send(says('BOT_NO_BUDGET', { at: true }), { openId: 'ou_other', type: 'app', name: '小P' });
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(take).not.toHaveBeenCalled(); expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.log.info.mock.calls.some(c => c[1] === 'judge-budget')).toBe(false);
  } finally { take.mockRestore(); }
});

it('records a bot wake at the settings gate without asking it to resend', async () => {
  const gate = deferred<void>();
  fake.projectLookup.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await gate.promise; throw new Error('test stopped edit'); });
  const edit = orchestrator.collaboration({ action: 'editProject', projectName: 'demo', chatId: CHAT, expectedRevision: projectRevision(fake.project as never), enabled: false }).catch(() => undefined);
  await vi.waitFor(() => expect(fake.projectLookup).toHaveBeenCalledTimes(3));
  await send(says('BOT_DURING_EDIT', { at: true }), { openId: 'ou_other', type: 'app', name: '小P' });
  expect(records()[0]).toMatchObject({ reason: 'bot-wake-dropped', detail: '群正在改设置' });
  expect(fake.list).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled();
  gate.resolve(); await edit;
});
