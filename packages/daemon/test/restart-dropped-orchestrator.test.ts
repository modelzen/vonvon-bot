import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import type { DroppedOrigin } from '../src/bot/restart-dropped';
import type { DiagnosticsEvent } from '../src/bot/diagnostics';

const fake = vi.hoisted(() => ({
  kind: 'multi' as 'single' | 'multi',
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  reply: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ code: 0, msg: 'success', data: {} })),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  record: {} as Record<string, unknown>,
  history: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true })),
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async (chatId: string) => ({ name: 'test', chatId, cwd: '/test', kind: fake.kind, pendingPolicy: 'queue' }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async (key: string) => ({ threadId: key, chatId: 'oc_group_a', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '', ...fake.record }),
  patchSession: async () => undefined,
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(), fetchThreadContext: fake.history, fetchChatContext: fake.history }));
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

type Module = typeof import('../src/bot/handle-message');
type Dropped = typeof import('../src/bot/restart-dropped');
let createOrchestrator: Module['createOrchestrator'];
let dropped: Dropped;
let root: string;
let file: string;
let events: DiagnosticsEvent[];
const opened: ReturnType<Module['createOrchestrator']>[] = [];
const APP = 'cli_restart_fixture';

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'vonvon-restart-dropped-'));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  ({ createOrchestrator } = await import('../src/bot/handle-message'));
  dropped = await import('../src/bot/restart-dropped');
  const diagnostics = await import('../src/bot/diagnostics');
  events = [];
  diagnostics.setDiagnosticsSink(event => events.push(event));
  file = join(root, 'dropped.json');
  fake.kind = 'multi';
  fake.record = {};
  fake.history.mockReset().mockResolvedValue({ messages: [], ok: true, complete: true });
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.reply.mockReset().mockResolvedValue({ code: 0, msg: 'success', data: {} });
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const o of opened.splice(0)) await o.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function thread() {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (): Promise<void> => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const id = `turn-${turns.push(end)}`;
      return {
        turnId: () => id,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          await end.promise;
          yield { type: 'done', turnId: id };
        })(),
      };
    },
  };
  return { t, turns, consumed };
}
let seq = 0;
const BASE = Date.now();
function message(text: string, fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  seq++;
  return { messageId: `om_msg_${seq}`, chatId: 'oc_group_a', chatType: 'group', threadId: 'omt_topic_1',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: BASE + seq * 1000, rawContentType: 'text',
    resources: [], mentions: [], mentionAll: false, ...fields };
}
function setup(options: { droppedFile?: string | false; maxConcurrentRuns?: number; reply?: unknown } = {}) {
  const cfg: AppConfig = { accounts: { app: { id: APP, secret: 'test', tenant: 'feishu' } }, preferences: {
    pendingPolicy: 'queue', access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' },
    ...(options.maxConcurrentRuns ? { maxConcurrentRuns: options.maxConcurrentRuns } : {}),
  } };
  const channel = { send: fake.send, rawClient: { im: { v1: {
    message: { get: async () => ({ data: { items: [{ thread_id: 'omt_new_topic' }] } }), reply: options.reply ?? fake.reply },
    messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
  } } } };
  const o = createOrchestrator(channel as never, cfg, '/test', undefined, options.droppedFile === false ? undefined : { droppedFile: options.droppedFile ?? file });
  opened.push(o);
  return o;
}
const until = (check: () => void) => vi.waitFor(check, { interval: 5 });
const queued = (depth: number) => until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth }));
const entries = () => dropped.readDropped(file, Date.now()).entries;
const notReplied = () => events.flatMap(event => event.kind === 'notReplied' ? [{ ...event.record, times: event.times ?? 1 }] : []);
const seed = (items: DroppedOrigin[], at = Date.now()) => dropped.recordDroppedSync(file, items, at);
const place = (chat: string, message: string, at: number, fields: Partial<DroppedOrigin> = {}): DroppedOrigin =>
  ({ chatId: chat, messageId: message, at, replyInThread: true, place: 'topic', ...fields });
const http = (status: number, data?: unknown) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data } });
const stoppedCards = () => fake.final.mock.calls.filter(call => JSON.stringify(call[1]).includes('bot 停止运行了，这一轮没开始'));
/** The next queue card is created only when `created` resolves; other cards at once. */
function holdQueueCard() {
  const created = deferred<string>();
  fake.createCard.mockImplementation(async (...args: unknown[]) => JSON.stringify(args[2]).includes('排队中') ? created.promise : 'card');
  const asked = () => until(() => expect(fake.createCard.mock.calls.some(call => JSON.stringify(call[2]).includes('排队中'))).toBe(true));
  return { created, asked };
}

describe('a shutdown keeps what it drops (s18c)', () => {
  it('① a single group\'s main area: the newest queued message, two of them, quoted in place', async () => {
    fake.kind = 'single';
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first', { threadId: undefined }));
    await until(() => expect(run.consumed).toHaveLength(1));
    const second = message('second', { threadId: undefined });
    const third = message('third', { threadId: undefined });
    await o.onMessage(second); await queued(1);
    await o.onMessage(third); await queued(2);
    const closing = o.shutdown();
    // Written in shutdown()'s own synchronous step, before the queue is cleared.
    expect(entries()).toEqual([{ chatId: 'oc_group_a', messageId: third.messageId, at: third.createTime, replyInThread: false, place: 'main', count: 2, droppedAt: expect.any(Number) }]);
    expect(fake.log.info).toHaveBeenCalledWith('bridge', 'dropped-recorded', { groups: 1, messages: 2, why: 'shutdown' });
    await closing;
  });

  it('② a topic of a multi-session group: replied in the topic', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const second = message('second');
    await o.onMessage(second); await queued(1);
    void o.shutdown();
    expect(entries()).toMatchObject([{ messageId: second.messageId, replyInThread: true, place: 'topic', count: 1 }]);
  });

  it('③ a /compact waiting on a run, and input held by a /new', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const swap = deferred<ReturnType<typeof thread>['t']>();
    fake.backend.startThread.mockReturnValue(swap.promise);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const compact = message('/compact');
    await o.onMessage(compact);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'compact-queued', expect.anything()));
    fake.kind = 'single';
    await o.onMessage(message('/new', { chatId: 'oc_group_b', threadId: undefined }));
    await until(() => expect(fake.backend.startThread).toHaveBeenCalled());
    const held = message('while new', { chatId: 'oc_group_b', threadId: undefined });
    await o.onMessage(held);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'deferred', { msgId: held.messageId }));
    const closing = o.shutdown();
    expect(entries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 'oc_group_a', messageId: compact.messageId, replyInThread: true, place: 'topic', count: 1 }),
      expect.objectContaining({ chatId: 'oc_group_b', messageId: held.messageId, replyInThread: false, place: 'main', count: 1 }),
    ]));
    expect(entries()).toHaveLength(2);
    swap.resolve(thread().t);
    await closing;
  });

  it('④ a run waiting for a slot; its queue card says the bot stopped, not that someone cancelled', async () => {
    const one = thread(), two = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(one.t).mockResolvedValueOnce(two.t);
    const o = setup({ maxConcurrentRuns: 1 });
    await o.onMessage(message('first'));
    await until(() => expect(one.consumed).toHaveLength(1));
    const waiting = message('second topic', { threadId: 'omt_topic_2' });
    await o.onMessage(waiting);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
    const closing = o.shutdown();
    expect(entries()).toMatchObject([{ messageId: waiting.messageId, replyInThread: true, place: 'topic', count: 1 }]);
    await closing;
    const card = fake.final.mock.calls.map(call => call[1] as { config?: { summary?: { content?: string } } }).find(c => JSON.stringify(c).includes('这一轮没开始'));
    expect(JSON.stringify(card)).toContain('bot 停止运行了，这一轮没开始');
    expect(JSON.stringify(card)).not.toContain('已取消排队');
    expect(card?.config?.summary?.content).toBe('bot 停止运行了');
    expect(two.consumed).toHaveLength(0);
  });

  it('④ a shutdown while the queue card is still being created: the card says the bot stopped once it exists', async () => {
    const one = thread(), two = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(one.t).mockResolvedValueOnce(two.t);
    const o = setup({ maxConcurrentRuns: 1 });
    await o.onMessage(message('first'));
    await until(() => expect(one.consumed).toHaveLength(1));
    // The running turn keeps its slot through the close until it is let go below.
    one.t.close.mockImplementation(async () => undefined);
    const card = holdQueueCard();
    const waiting = message('second topic', { threadId: 'omt_topic_2' });
    await o.onMessage(waiting);
    await card.asked();
    const closing = o.shutdown();
    expect(entries()).toMatchObject([{ messageId: waiting.messageId, count: 1 }]);
    card.created.resolve('card_queued');
    // Cancelled as soon as the card exists, not when the slot comes.
    await until(() => expect(stoppedCards()).toHaveLength(1));
    expect(two.t.close).toHaveBeenCalled();
    one.turns[0]!.resolve();
    await closing;
    expect(stoppedCards()).toHaveLength(1);
    expect(two.consumed).toHaveLength(0);
  });

  it('④ the slot came while the queue card was being created, then a shutdown: the card says the bot stopped', async () => {
    const one = thread(), two = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(one.t).mockResolvedValueOnce(two.t);
    const o = setup({ maxConcurrentRuns: 1 });
    await o.onMessage(message('first'));
    await until(() => expect(one.consumed).toHaveLength(1));
    const card = holdQueueCard();
    const waiting = message('second topic', { threadId: 'omt_topic_2' });
    await o.onMessage(waiting);
    await card.asked();
    one.turns[0]!.resolve();
    // The first run gives its slot back in the same step that logs its final card.
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    const closing = o.shutdown();
    // Not started yet: kept.
    expect(entries()).toMatchObject([{ messageId: waiting.messageId, count: 1 }]);
    card.created.resolve('card_queued');
    await closing;
    expect(stoppedCards()).toHaveLength(1);
    expect(two.consumed).toHaveLength(0);
  });

  it('④ a run that waited for its slot and started is not kept', async () => {
    const one = thread(), two = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(one.t).mockResolvedValueOnce(two.t);
    const o = setup({ maxConcurrentRuns: 1 });
    await o.onMessage(message('first'));
    await until(() => expect(one.consumed).toHaveLength(1));
    await o.onMessage(message('second topic', { threadId: 'omt_topic_2' }));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
    one.turns[0]!.resolve();
    await until(() => expect(two.consumed).toHaveLength(1));
    await o.shutdown();
    expect(existsSync(file)).toBe(false);
  });

  it('⑭ a dropped.json it cannot write is logged, and the shutdown goes on', async () => {
    writeFileSync(join(root, 'blocker'), '');
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup({ droppedFile: join(root, 'blocker', 'dropped.json') });
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('queued')); await queued(1);
    await o.shutdown();
    expect(fake.log.fail).toHaveBeenCalledWith('bridge', expect.objectContaining({ code: 'ENOTDIR' }), { phase: 'dropped-record' });
    expect(run.t.close).toHaveBeenCalled();
  });

  it('⑧ merges what two shutdowns drop when the bot never connected between them', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const first = setup();
    await first.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await first.onMessage(message('queued once')); await queued(1);
    await first.shutdown();
    fake.log.info.mockClear();
    const again = thread(); fake.backend.resumeThread.mockResolvedValue(again.t);
    const second = setup();
    await second.onMessage(message('first again'));
    await until(() => expect(again.consumed).toHaveLength(1));
    await second.onMessage(message('queued twice')); await queued(1);
    const last = message('queued thrice');
    await second.onMessage(last); await queued(2);
    await second.shutdown();
    expect(entries()).toMatchObject([{ messageId: last.messageId, count: 3 }]);
    expect(fake.reply).not.toHaveBeenCalled();
  });

  it('⑩ a run still preparing its first turn is not kept (s18e)', async () => {
    const resume = deferred<ReturnType<typeof thread>['t']>();
    fake.backend.resumeThread.mockReturnValue(resume.promise);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalled());
    const closing = o.shutdown();
    expect(existsSync(file)).toBe(false);
    resume.resolve(thread().t);
    await closing;
  });

  it('⑫ a queued message the running turn\'s record block already carried is not kept', async () => {
    fake.record = { lastSeenAt: 1 };
    const pulled = deferred<{ messages: unknown[]; ok: boolean; complete: boolean }>();
    fake.history.mockReturnValueOnce(pulled.promise);
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    const first = message('first');
    // Sent before the trigger, delivered after it: a line of the trigger's record block.
    const early = message('sent earlier', { createTime: first.createTime - 500 });
    await o.onMessage(first);
    await until(() => expect(fake.history).toHaveBeenCalled());
    await o.onMessage(early); await queued(1);
    pulled.resolve({ ok: true, complete: true, messages: [{ messageId: early.messageId, senderName: '李四', text: 'sent earlier', from: 'user', createTime: early.createTime }] });
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('sent earlier');
    const later = message('sent later');
    await o.onMessage(later); await queued(2);
    void o.shutdown();
    expect(entries()).toMatchObject([{ messageId: later.messageId, count: 1 }]);
  });

  it('⑬ keeps and answers nothing without a droppedFile', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup({ droppedFile: false });
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('queued')); await queued(1);
    await o.shutdown();
    const found: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(join(dir, entry.name)) : found.push(entry.name); };
    walk(root);
    expect(found).not.toContain('dropped.json');
    seed([place('oc_group_a', 'om_x', 1)]);
    setup({ droppedFile: false }).replyDropped();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.reply).not.toHaveBeenCalled();
  });
});

describe('once back, each group hears once (s18c)', () => {
  it('⑤ replies under each group\'s newest message, settles the file, and tells the page the real count', async () => {
    seed([place('oc_group_a', 'om_a1', 1, { replyInThread: false, place: 'main' }), place('oc_group_a', 'om_a2_abcdef', 2, { replyInThread: false, place: 'main' }), place('oc_group_b', 'om_b1_123456', 3)]);
    setup().replyDropped();
    await until(() => expect(existsSync(file)).toBe(false));
    expect(fake.reply).toHaveBeenCalledTimes(2);
    const calls = fake.reply.mock.calls.map(call => call[0] as { path: { message_id: string }; data: { msg_type: string; content: string; reply_in_thread: boolean; uuid: string } });
    expect(calls.find(call => call.path.message_id === 'om_a2_abcdef')?.data).toEqual({
      msg_type: 'text', content: JSON.stringify({ text: '刚才重启了，这条和这个群里另外 1 条都没处理，请再发一次。' }), reply_in_thread: false,
      uuid: dropped.droppedUuid(APP, { chatId: 'oc_group_a', messageId: 'om_a2_abcdef' }),
    });
    expect(calls.find(call => call.path.message_id === 'om_b1_123456')?.data).toMatchObject({ content: JSON.stringify({ text: '刚才重启了，这条没处理，请再发一次。' }), reply_in_thread: true });
    expect(notReplied()).toEqual(expect.arrayContaining([
      { at: 2, groupId: 'oc_group_a', place: 'main', reason: 'restarted', ref: 'abcdef', times: 2 },
      { at: 3, groupId: 'oc_group_b', place: 'topic', reason: 'restarted', ref: '123456', times: 1 },
    ]));
    expect(notReplied()).toHaveLength(2);
    expect(fake.log.info).toHaveBeenCalledWith('bridge', 'dropped-replied', { chat: 'roup_a', count: 2 });
  });

  it('⑥ tries again with the same uuid after 1 and 5 minutes, and never a refusal', async () => {
    vi.useFakeTimers({ now: Date.now() });
    seed([
      place('oc_once', 'om_once', 4), place('oc_recall_one', 'om_recall1', 3), place('oc_recall_three', 'om_recall3', 2),
      place('oc_never', 'om_never', 1),
    ]);
    seed([place('oc_recall_three', 'om_recall3', 2), place('oc_recall_three', 'om_recall3', 2)]);
    let onceTried = false;
    fake.reply.mockImplementation(async (payload: unknown) => {
      const id = (payload as { path: { message_id: string } }).path.message_id;
      if (id === 'om_once') { if (onceTried) return { code: 0 }; onceTried = true; throw http(503, '<html>'); }
      if (id === 'om_recall1') throw http(400, { code: 230011, msg: 'The message was withdrawn.' });
      if (id === 'om_recall3') return { code: 230011, msg: 'The message was withdrawn.' }; // a 2xx with the code
      throw http(503, '<html>');
    });
    setup().replyDropped();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.reply).toHaveBeenCalledTimes(4);
    expect(entries().map(entry => entry.messageId).sort()).toEqual(['om_never', 'om_once']);
    expect(notReplied()).toEqual([{ at: 2, groupId: 'oc_recall_three', place: 'topic', reason: 'restarted', ref: 'ecall3', detail: '最新那条撤回了', times: 2 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.reply).toHaveBeenCalledTimes(6);
    expect(entries().map(entry => entry.messageId)).toEqual(['om_never']);
    expect(notReplied().find(record => record.groupId === 'oc_once')).toEqual({ at: 4, groupId: 'oc_once', place: 'topic', reason: 'restarted', ref: 'm_once', times: 1 });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.reply).toHaveBeenCalledTimes(7);
    expect(existsSync(file)).toBe(false);
    expect(notReplied().find(record => record.groupId === 'oc_never')).toMatchObject({ detail: 'HTTP 503', times: 1 });
    const uuids = (id: string) => new Set(fake.reply.mock.calls.filter(call => (call[0] as { path: { message_id: string } }).path.message_id === id)
      .map(call => (call[0] as { data: { uuid: string } }).data.uuid));
    expect([uuids('om_once').size, uuids('om_never').size]).toEqual([1, 1]);
    expect(uuids('om_never')).toEqual(new Set([dropped.droppedUuid(APP, { chatId: 'oc_never', messageId: 'om_never' })]));
    expect(fake.log.warn).toHaveBeenCalledWith('bridge', 'dropped-retry', expect.objectContaining({ chat: '_never', attempt: 2, retryInMs: 300_000 }));
  });

  it('⑦ a shutdown mid-way keeps what is unanswered; a result after it still settles', async () => {
    seed([place('oc_a', 'om_a', 3), place('oc_b', 'om_b', 2), place('oc_c', 'om_c', 1)]);
    const inFlight = deferred<unknown>();
    fake.reply.mockImplementation(async (payload: unknown) => {
      const id = (payload as { path: { message_id: string } }).path.message_id;
      return id === 'om_b' ? inFlight.promise : { code: 0 };
    });
    const o = setup();
    o.replyDropped();
    await until(() => expect(fake.reply).toHaveBeenCalledTimes(2));
    await o.shutdown();
    expect(entries().map(entry => entry.messageId).sort()).toEqual(['om_b', 'om_c']);
    inFlight.resolve({ code: 0 });
    await until(() => expect(entries().map(entry => entry.messageId)).toEqual(['om_c']));
    setup().replyDropped();
    await until(() => expect(existsSync(file)).toBe(false));
    expect(fake.reply.mock.calls.map(call => (call[0] as { path: { message_id: string } }).path.message_id)).toEqual(['om_a', 'om_b', 'om_c']);
  });

  it('⑦ a reply that never came back is sent again by the next process under the same uuid', async () => {
    seed([place('oc_a', 'om_a', 2), place('oc_b', 'om_b', 1)]);
    fake.reply.mockImplementation(async (payload: unknown) =>
      (payload as { path: { message_id: string } }).path.message_id === 'om_b' ? new Promise(() => {}) : { code: 0 });
    const o = setup();
    o.replyDropped();
    await until(() => expect(fake.reply).toHaveBeenCalledTimes(2));
    await o.shutdown();
    fake.reply.mockReset().mockResolvedValue({ code: 0 });
    setup().replyDropped();
    await until(() => expect(existsSync(file)).toBe(false));
    expect(fake.reply).toHaveBeenCalledOnce();
    expect((fake.reply.mock.calls[0]![0] as { data: { uuid: string } }).data.uuid).toBe(dropped.droppedUuid(APP, { chatId: 'oc_b', messageId: 'om_b' }));
  });

  it('⑨ does nothing once shut down', async () => {
    seed([place('oc_a', 'om_a', 1)]);
    const o = setup();
    await o.shutdown();
    o.replyDropped();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fake.reply).not.toHaveBeenCalled();
    expect(entries()).toHaveLength(1);
  });

  it('⑪ settles a reply that throws something not Feishu\'s, with nothing left unhandled', async () => {
    seed([place('oc_a', 'om_a', 1)]);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      setup({ reply: () => { throw new TypeError('reply is not wired'); } }).replyDropped();
      await until(() => expect(notReplied()).toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(existsSync(file)).toBe(false);
      expect(notReplied()[0]).toMatchObject({ groupId: 'oc_a', reason: 'restarted', detail: 'reply is not wired' });
      expect(fake.log.fail).toHaveBeenCalledWith('bridge', expect.any(TypeError), expect.objectContaining({ phase: 'dropped-reply-failed' }));
    } finally { process.off('unhandledRejection', unhandled); }
  });
});
