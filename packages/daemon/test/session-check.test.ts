import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { SessionInUseError, type AgentEvent, type AgentInput } from '../src/agent/types';

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
import { createOrchestrator } from '../src/bot/handle-message';
import { createTopicRegistry, type TopicRegistry } from '../src/bot/topic-registry';
import type { AppConfig } from '../src/config/schema';

// s15b: a live session is checked against its native file before a turn, a native
// compaction makes the recent-topics table due, and a Codex session is let go after a run.

interface Opts { foreign?: () => Promise<{ foreign: boolean }>; lastCompaction?: string; releaseAfterRun?: boolean; hold?: Promise<void> }
function thread(sessionId: string, opts: Opts = {}) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId, isAlive: () => true, supportsSteer: false,
    lastCompaction: opts.lastCompaction,
    releaseAfterRun: opts.releaseAfterRun,
    ...(opts.foreign ? { checkNative: vi.fn(opts.foreign) } : {}),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ usage: null })),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const wait = consumed.length === 1 ? opts.hold : undefined;
      return {
        turnId: () => 'turn',
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: 'turn' };
          await wait;
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
const record = (key: string, extra: object = {}) => ({ threadId: key, chatId: 'chat', sessionId: `old-${key}`, backend: 'codex', cwd: '/test', summary: '', model: 'm', effort: 'medium', lastSeenAt: 5, ...extra });
const finals = () => (fake.log.info.mock.calls as unknown[][]).filter((c) => c[0] === 'card' && c[1] === 'final').length;
async function turn(o: ReturnType<typeof setup>, msg: NormalizedMessage) {
  const before = finals();
  await o.onMessage(msg);
  await vi.waitFor(() => expect(finals()).toBe(before + 1));
}
const sent = () => JSON.stringify([fake.send.mock.calls, fake.createCard.mock.calls, fake.final.mock.calls]);

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
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
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe('a live session written elsewhere (checkNative)', () => {
  it('drops a live thread whose session was written elsewhere and resumes it from disk', async () => {
    fake.records.set('chat', record('chat'));
    const first = thread('old-chat', { foreign: async () => ({ foreign: true }) });
    const second = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup();
    await turn(o, message('一'));
    await turn(o, message('二'));
    expect(first.t.checkNative).toHaveBeenCalledTimes(1);
    expect(first.t.close).toHaveBeenCalled();
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2);
    expect(fake.backend.resumeThread).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'old-chat' }));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    expect(first.consumed).toHaveLength(1);
    expect(second.consumed).toHaveLength(1);
    expect(second.consumed[0]!.text).toContain('二');
  });

  it.each([
    ['not written elsewhere', async () => ({ foreign: false })],
    ['the check fails', async (): Promise<{ foreign: boolean }> => { throw new Error('EACCES'); }],
  ])('keeps the live thread when %s', async (_name, foreign) => {
    fake.records.set('chat', record('chat'));
    const live = thread('old-chat', { foreign });
    fake.backend.resumeThread.mockResolvedValue(live.t);
    const o = setup();
    await turn(o, message('一'));
    await turn(o, message('二'));
    expect(live.t.checkNative).toHaveBeenCalledTimes(1);
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(live.t.close).not.toHaveBeenCalled();
    expect(live.consumed).toHaveLength(2);
  });
});

describe('a native compaction makes the recent topics due', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'topics-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const registry = () => createTopicRegistry({ dir, sessions: async () => [...fake.records.values()] });
  const table = '〔本群最近';
  const withTopic = async () => {
    const topics = registry();
    await topics.note('chat', { topicId: 'omt_t', at: 3, from: { kind: 'user', openId: 'ou_li' }, first: { id: 'om_omt_t', text: 'omt_t 的标题' } });
    return topics;
  };

  it('shows the table once for a main session resumed with a compaction it has not seen', async () => {
    fake.records.set('chat', record('chat'));
    const run = thread('old-chat', { lastCompaction: 'cc-1' });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(await withTopic());
    await turn(o, message('一'));
    await turn(o, message('二'));
    expect(run.consumed[0]!.text).toContain(table);
    expect(run.consumed[1]!.text).not.toContain(table);
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ compactSeen: 'cc-1', topicsDue: '' }));
  });

  it('shows it again when the live thread reports a newer compaction, and not for the one already seen', async () => {
    fake.records.set('chat', record('chat', { compactSeen: 'cc-1' }));
    const run = thread('old-chat', { lastCompaction: 'cc-1', foreign: async () => ({ foreign: false }) });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(await withTopic());
    await turn(o, message('一'));
    expect(run.consumed[0]!.text).not.toContain(table);
    run.t.lastCompaction = 'cc-2';
    await turn(o, message('二'));
    await turn(o, message('三'));
    expect(run.consumed[1]!.text).toContain(table);
    expect(run.consumed[2]!.text).not.toContain(table);
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ compactSeen: 'cc-2' }));
  });

  it('never marks a topic session', async () => {
    fake.records.set('omt_x', record('omt_x'));
    const run = thread('old-omt_x', { lastCompaction: 'cc-1' });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(await withTopic());
    await turn(o, message('话题里', 'omt_x'));
    await turn(o, message('话题里二', 'omt_x'));
    expect(run.consumed.map((i) => i.text).join('\n')).not.toContain(table);
    expect(fake.records.get('omt_x')).not.toHaveProperty('compactSeen');
    expect(fake.records.get('omt_x')).not.toHaveProperty('topicsDue');
  });
});

describe('a Codex session is let go after a run (releaseAfterRun)', () => {
  const released = () => (fake.log.info.mock.calls as unknown[][]).filter((c) => c[1] === 'session-release').length;

  it('closes the thread after its run, and the next message resumes the session', async () => {
    fake.records.set('chat', record('chat'));
    const first = thread('old-chat', { releaseAfterRun: true });
    const second = thread('old-chat', { releaseAfterRun: true });
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup();
    await turn(o, message('一'));
    await vi.waitFor(() => expect(first.t.close).toHaveBeenCalledTimes(1));
    await turn(o, message('二'));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2);
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    expect(second.consumed[0]!.text).toContain('二');
    await vi.waitFor(() => expect(second.t.close).toHaveBeenCalledTimes(1));
  });

  it('keeps a thread that does not ask to be let go', async () => {
    fake.records.set('chat', record('chat'));
    const live = thread('old-chat', { releaseAfterRun: false });
    fake.backend.resumeThread.mockResolvedValue(live.t);
    const o = setup();
    await turn(o, message('一'));
    await turn(o, message('二'));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(live.t.close).not.toHaveBeenCalled();
    expect(live.consumed).toHaveLength(2);
    expect(released()).toBe(0);
  });

  it('runs a message queued during the run on the same thread before letting it go', async () => {
    fake.records.set('chat', record('chat'));
    let release!: () => void;
    const run = thread('old-chat', { releaseAfterRun: true, hold: new Promise<void>((resolve) => { release = resolve; }) });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('排队的'));
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    expect(run.t.close).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('排队的');
    await vi.waitFor(() => expect(run.t.close).toHaveBeenCalledTimes(1));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(released()).toBe(1);
  });

  it('lets the thread go after a standalone /compact', async () => {
    fake.records.set('chat', record('chat'));
    const run = thread('old-chat', { releaseAfterRun: true });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/compact'));
    await vi.waitFor(() => expect(run.t.compact).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(run.t.close).toHaveBeenCalledTimes(1));
    expect(released()).toBe(1);
  });
});

describe('a session open in a terminal or the Codex app (SessionInUseError)', () => {
  it('tells the user, keeps the session and starts no new one', async () => {
    fake.records.set('chat', record('chat'));
    fake.backend.resumeThread.mockRejectedValue(new SessionInUseError('old-chat', new Error('already has an active writer')));
    const o = setup();
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(sent()).toContain('这条会话正在终端或 Codex 应用里打开着'));
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    expect(fake.records.get('chat')).toMatchObject({ sessionId: 'old-chat' });
  });
});
