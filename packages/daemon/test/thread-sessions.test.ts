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
  history: vi.fn(async () => [] as unknown[]),
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
  patchSession: async (key: string, patch: object) => { const r = fake.records.get(key); if (r) Object.assign(r, patch); },
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
function message(text: string, threadId?: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', ...(threadId ? { threadId } : {}),
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup() {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
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
  fake.history.mockReset().mockResolvedValue([]);
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
