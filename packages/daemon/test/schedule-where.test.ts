import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent } from '../src/agent/types';
import type { TurnFacts, TurnWhere } from '../src/agent/entry/registry';
import { G, human, removeScheduleFixtures, scheduleFixture } from './helpers/schedule-entry';

// T3 4.1 and 4.2: where a task goes, from where() as it is when the tool runs; launchRun hands that closure in.
const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  records: new Map<string, Record<string, unknown>>(),
  backend: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(),
  fetchThreadContext: async () => ({ messages: [], ok: true, complete: true }), fetchChatContext: async () => ({ messages: [], ok: true, complete: true }) }));
vi.mock('../src/bot/session-store', async (original) => ({ ...await original<object>(),
  getSession: async (key: string) => fake.records.get(key), listSessions: async () => [...fake.records.values()],
  patchSession: async () => undefined, upsertSession: async (record: { threadId: string }) => { fake.records.set(record.threadId, record); } }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = async () => 'card'; getCardId() { return 'card_entity'; } async updateElement() { return true; } streamCoalesced() {}
    async drain() {} setImageWorker() {} async settleImages() { return new Map(); } updateCard = async () => true; finalizeCard = async () => true;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createAgentEntries } from '../src/agent/entry/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

afterEach(removeScheduleFixtures);

describe('where a task goes', () => {
  const main: TurnWhere = { inTopic: false };
  const topic: TurnWhere = { inTopic: true, topicId: 'omt_topic' };
  const unclaimed: TurnWhere = { inTopic: true };
  const once = { kind: 'once', inMinutes: 20 }, every = { kind: 'daily', time: '09:00' };
  it.each([
    ['here in the main area', main, undefined, once, { kind: 'follow' }],
    ['here in a topic, once', topic, undefined, once, { kind: 'topic', topicId: 'omt_topic' }],
    ['here in a topic, recurring', topic, 'here', every, { kind: 'follow' }],
    ['here in a topic not claimed yet, recurring', unclaimed, undefined, every, { kind: 'follow' }],
    ['thisTopic in a topic, recurring', topic, 'thisTopic', every, { kind: 'topic', topicId: 'omt_topic' }],
    ['thisTopic in the main area', main, 'thisTopic', every, { kind: 'follow' }],
    ['newTopic in a topic', topic, 'newTopic', once, { kind: 'newTopic' }],
    ['newTopic in the main area', main, 'newTopic', every, { kind: 'newTopic' }],
  ] as const)('%s', async (_case, where, place, when, placement) => {
    const f = await scheduleFixture();
    f.open(human(undefined, { where: () => where }));
    expect(await f.call('schedule_create', { name: '回来看', instruction: '看一下', when, ...(place ? { where: place } : {}) })).toMatchObject({ ok: true });
    expect(f.request()).toMatchObject({ action: 'create', chatId: G, placement });
    expect(f.store.all()[0]).toMatchObject({ placement });
  });
  // A once made here goes back to this topic (3.13), so it waits for the id like thisTopic does instead of following
  // the group: a multi-session group would open a new topic and session on every run.
  it.each([
    ['thisTopic, recurring', 'thisTopic', every],
    ['here, once', 'here', once],
    ['no where, once', undefined, once],
  ] as const)('answers %s in a topic the bot just opened with topic-pending, and reads where() again on the retry', async (_case, place, when) => {
    const f = await scheduleFixture();
    let where: TurnWhere = unclaimed;
    f.open(human(undefined, { where: () => where }));
    const args = { name: '日报', instruction: '发日报', when, ...(place ? { where: place } : {}) };
    expect(await f.text('schedule_create', args)).toMatch(/^话题还没建好，稍等几秒再试。\n.*"reason":"topic-pending"/);
    expect(f.execute).not.toHaveBeenCalled();
    where = { inTopic: true, topicId: 'omt_new' };
    await f.call('schedule_create', args);
    expect(f.request()).toMatchObject({ placement: { kind: 'topic', topicId: 'omt_new' } });
  });
  it('answers an edit that moves a once task here, in a topic not claimed yet, with topic-pending', async () => {
    const f = await scheduleFixture();
    f.open(human(undefined, { where: () => main }));
    await f.call('schedule_create', { name: '回来看', instruction: '看一下', when: once });
    const { id, revision } = f.store.all()[0]!;
    f.open(human(undefined, { triggerMessageId: 'om_2', where: () => unclaimed }));
    f.execute.mockClear();
    expect(await f.text('schedule_edit', { taskId: id, revision, patch: { where: 'here' } })).toMatch(/^话题还没建好，稍等几秒再试。\n.*"reason":"topic-pending"/);
    expect(f.execute.mock.calls.map(call => call[1].action)).toEqual(['list']);
    expect(f.store.get(id)?.placement).toEqual({ kind: 'follow' });
  });
  it('moves a once task into this topic on edit, judging once by the task itself', async () => {
    const f = await scheduleFixture();
    f.open(human(undefined, { where: () => ({ inTopic: false }) }));
    await f.call('schedule_create', { name: '回来看', instruction: '看一下', when: { kind: 'once', inMinutes: 20 } });
    const { id, revision } = f.store.all()[0]!;
    f.open(human(undefined, { triggerMessageId: 'om_2', where: () => ({ inTopic: true, topicId: 'omt_topic' }) }));
    await f.call('schedule_edit', { taskId: id, revision, patch: { where: 'here' } });
    expect(f.request()).toMatchObject({ action: 'edit', patch: { placement: { kind: 'topic', topicId: 'omt_topic' } } });
  });
});

describe('where() from launchRun', () => {
  let root: string;
  let seq = 0;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'schedule-where-'))); vi.clearAllMocks(); fake.records.clear(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function harness(kind: 'single' | 'multi') {
    fake.project = { name: 'g', chatId: 'chat', cwd: root, kind, createdAt: 1, blank: false };
    const startThread = vi.fn(async () => ({ sessionId: 'fresh', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
      runStreamed: () => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'turn_started', turnId: 'turn' }; yield { type: 'done', turnId: 'turn' }; })() }) }));
    fake.backend = { id: 'codex-appserver', displayName: 'codex', listModels: async () => [], startThread, resumeThread: startThread, listThreads: async () => [] };
    const ok = async () => ({ code: 0, data: { message_id: `om_${++seq}`, items: [] } });
    const channel = { send: async () => ({}), rawClient: {
      cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'card' } }) } } },
      im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'omt_new' }] } }), list: ok, reply: ok, create: ok },
        chat: { get: async () => { throw new Error('no scope'); } }, messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) } } } } };
    const entries = createAgentEntries({ appId: 'app', isAdmin: () => true });
    const opened: { facts: TurnFacts; where: TurnWhere | undefined }[] = [];
    const open = entries.openTurn.bind(entries);
    vi.spyOn(entries, 'openTurn').mockImplementation((thread, facts) => { opened.push({ facts, where: facts.where?.() }); return open(thread, facts); });
    const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] } } };
    const o = createOrchestrator(channel as never, cfg, root, undefined, { entries });
    return { o, opened };
  }
  const message = (): NormalizedMessage => ({ messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', content: '20 分钟后回来看', senderId: 'owner',
    senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false });
  const finished = () => vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

  it('says main area in a single-session group', async () => {
    const { o, opened } = harness('single');
    await o.onMessage(message());
    await finished();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ where: { inTopic: false }, facts: { requesterName: 'Owner' } });
    expect(opened[0]!.facts.where?.()).toEqual({ inTopic: false });
    await o.shutdown();
  });
  it('says topic at once in a topic the bot opens, and its id only after the card claimed it', async () => {
    const { o, opened } = harness('multi');
    await o.onMessage(message());
    await finished();
    expect(opened[0]).toMatchObject({ where: { inTopic: true }, facts: { requesterName: 'Owner' } });
    expect(opened[0]!.where).not.toHaveProperty('topicId');
    expect(opened[0]!.facts.where?.()).toEqual({ inTopic: true, topicId: 'omt_new' });
    await o.shutdown();
  });
});
