import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { INITIATIVE_NOTE } from '../src/bot/session-title';
import { JUDGE_BUDGET } from '../src/bot/smart-intake';
import type { JudgeRequest, JudgeResult } from '../src/judge/types';
import { receive, type EventMessage } from './helpers/lark-events';

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
  fullOnly: false,
  send: vi.fn(async () => ({ messageId: 'om_sent' })),
  get: vi.fn(async () => ({ code: 0, data: { items: [{ thread_id: 'omt_opened' }] } })),
  list: vi.fn(),
  // One id per emoji, so the test sees which reaction went.
  react: vi.fn(async (req: { data: { reaction_type: { emoji_type: string } } }) => ({ data: { reaction_id: `r_${req.data.reaction_type.emoji_type}` } })),
  unreact: vi.fn(async () => ({})),
  inputs: [] as string[],
  judge: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
const startThread = vi.fn(async () => ({
  sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => {},
  runStreamed: (input: { text: string }) => {
    fake.inputs.push(input.text);
    return { turnId: () => 'turn-fixture', events: (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })() };
  },
}));

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], startThread, fullAccessOnly: () => fake.fullOnly }) }));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async (key: string) => fake.sessions[key], upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/judge/judge', async original => ({
  ...await original<object>(),
  createJudge: () => ({ judge: fake.judge, warm: () => {}, shutdown: async () => {} }),
}));
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

const BOT = { openId: 'ou_bot', name: '小码' };
const APP = 'cli_fixture';
const CHAT = 'oc_demo';
const base = { name: 'demo', chatId: CHAT, cwd: '/tmp/demo', kind: 'single', smart: true, mode: 'full', network: false };
const cfg: AppConfig = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, completionReminder: { mode: 'manual' } } };
const channel = {
  send: fake.send, botIdentity: BOT,
  rawClient: { appId: APP, im: { v1: {
    messageReaction: { create: fake.react, delete: fake.unreact },
    message: { get: fake.get, list: fake.list },
    // The group's only bot unless a test says otherwise.
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', bot_count: '1' } }) },
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
const send = async (m: EventMessage, sender?: string) => orchestrator.onMessage(await receive(m, { bot: BOT, ...(sender ? { sender: { openId: sender } } : {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  asked.clear();
  events = [];
  fake.inputs = [];
  fake.sessions = {};
  fake.fullOnly = false;
  fake.project = { ...base };
  fake.list.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }));
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
    await vi.waitFor(() => expect(records()).toHaveLength(2));
    expect(records().map((r) => [r.reason, r.detail])).toEqual([['judge-skip', '闲聊，和我无关'], ['judge-failed', '判断超时']]);
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
  });
});
