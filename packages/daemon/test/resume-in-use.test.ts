import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { addProject, updateProject } from '../src/project/registry';
import { bindSession, getSession, listSessions, upsertSession, type SessionRecord } from '../src/bot/session-store';
import { createOrchestrator } from '../src/bot/handle-message';

// s15f: `/resume` leaves off, and refuses, a native session another place of the group holds.
// Real orchestrator and session store on a temp dir; faked backend, Feishu and cards.

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'resume-in-use-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'resume-in-use-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') },
    botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fake = vi.hoisted(() => ({
  backend: undefined as unknown,
  n: 0,
  /** Cards sent, by the message id each got. */
  cards: [] as { id: string; json: string }[],
  /** Card updates (the picker settling), by the card's message id. */
  updates: [] as { id: string; json: string }[],
  /** The topic lookup after a reply in thread; a test may hold it. */
  lookup: async (_id: string) => undefined as unknown,
}));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/card/managed', () => ({
  sendManagedCard: vi.fn(async (_channel: unknown, _chatId: string, card: unknown) => {
    const id = `om_card_${++fake.n}`;
    fake.cards.push({ id, json: JSON.stringify(card) });
    return { messageId: id };
  }),
  updateManagedCard: vi.fn(async (_channel: unknown, id: string, card: unknown) => {
    fake.updates.push({ id, json: JSON.stringify(card) });
    return true;
  }),
}));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { return 'card'; }
    getCardId() { return 'card'; }
    async drain() {}
    async settleImages() { return new Map(); }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    // Whatever else a run calls on its card is a no-op here.
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => true }); }
  },
}));

const CHAT = 'oc_demo';
const BE = 'codex-appserver';
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
const target = { projectName: 'demo', chatId: CHAT };
const send = vi.fn(async (..._args: unknown[]) => ({ messageId: `om_sent_${++fake.n}` }));
// A reply in thread opens topic `omt_<the reply's id>`.
const channel = { send, rawClient: { im: { v1: {
  message: { get: async ({ path }: { path: { message_id: string } }) => { await fake.lookup(path.message_id); return { data: { items: [{ thread_id: `omt_${path.message_id}` }] } }; } },
  messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
} } } };

function backend() {
  /** A turn on the thread runs until {@link turnEnd} settles. */
  let turnEnd!: () => void;
  const turnDone = new Promise<void>((resolve) => { turnEnd = resolve; });
  const thread = { sessionId: 'x', isAlive: () => true, close: vi.fn(async () => { turnEnd(); }), abort: async () => {},
    runStreamed: vi.fn(() => ({ turnId: () => 'turn-x', events: (async function* () {
      yield { type: 'turn_started', turnId: 'turn-x' }; await turnDone; yield { type: 'done', turnId: 'turn-x' };
    })() })) };
  const be = {
    thread, turnEnd,
    id: BE, displayName: 'Codex (app-server)', listModels: async () => [],
    startThread: vi.fn(async () => thread), resumeThread: vi.fn(async () => thread),
    listThreads: vi.fn(async () => ['mine', 'held', 'past'].map((sessionId) => ({ sessionId, preview: sessionId, createdAt: 1, updatedAt: 2 }))),
    readHistory: vi.fn(async () => ({ name: 'historic', preview: '', turns: [], totalTurns: 0 })),
  };
  fake.backend = be;
  return be;
}
const record = (threadId: string, sessionId: string, more: Partial<SessionRecord> = {}): SessionRecord =>
  ({ threadId, chatId: CHAT, cwd: workspace, sessionId, backend: BE, summary: sessionId, createdAt: 1, updatedAt: 1, ...more });
const bound = async (sessionId: string) => (await listSessions()).filter((s) => s.sessionId === sessionId && !s.detached).map((s) => s.threadId);

function message(content: string) {
  return { messageId: `om_msg_${++fake.n}`, chatId: CHAT, chatType: 'group' as const, content, senderId: 'ou_owner', senderName: 'Owner',
    mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
type App = ReturnType<typeof createOrchestrator>;
const until = (check: () => unknown) => vi.waitFor(check, { interval: 10, timeout: 4000 });
/** Sends `/resume` in the main area and returns the picker card. */
async function picker(app: App) {
  const before = fake.cards.length;
  await app.onMessage(message('/resume'));
  await until(() => expect(fake.cards.slice(before).some((c) => c.json.includes('恢复历史会话'))).toBe(true));
  return fake.cards.slice(before).find((c) => c.json.includes('恢复历史会话'))!;
}
const listed = (card: { json: string }) => [...card.json.matchAll(/"t":"([^"]+)"/g)].map((m) => m[1]);
const pick = (app: App, card: { id: string }, sessionId: string) =>
  app.dispatcher.handle({ messageId: card.id, chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'resume.pick', t: sessionId, b: BE } } } as never);
/** The picker's last settled card, once it is done or failed. */
async function settled(card: { id: string }) {
  await until(() => expect(fake.updates.some((u) => u.id === card.id && /恢复失败|已恢复|已切回/.test(u.json))).toBe(true));
  return fake.updates.filter((u) => u.id === card.id).at(-1)!.json;
}

beforeEach(async () => {
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true });
  fake.cards = []; fake.updates = []; send.mockClear(); fake.lookup = async () => undefined;
  await addProject({ name: 'demo', chatId: CHAT, cwd: workspace, kind: 'single', blank: false, origin: 'joined', createdAt: 1, backend: BE });
  await upsertSession(record(CHAT, 'mine'));       // the main area
  await upsertSession(record('omt_a', 'held'));    // a topic of the group
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

describe('the session store binds a native session to one place of a group', () => {
  it('of two places binding one session at once, one wins and the other gets the holder', async () => {
    const results = await Promise.all([bindSession(record('omt_b', 'past')), bindSession(record('omt_c', 'past'))]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    const holder = results.find(Boolean)!;
    expect(await bound('past')).toEqual([holder.threadId]);
  });

  it('rebinds the key that holds it; archived records and other groups hold nothing', async () => {
    expect(await bindSession(record('omt_a', 'held', { summary: 'again' }))).toBeUndefined();
    expect(await getSession('omt_a')).toMatchObject({ sessionId: 'held', summary: 'again' });
    await upsertSession(record('omt_old', 'past', { detached: true }));
    await upsertSession(record('omt_x', 'past', { chatId: 'oc_other' }));
    expect(await bindSession(record('omt_b', 'past'))).toBeUndefined();
    expect(await bindSession(record('omt_c', 'held'))).toMatchObject({ threadId: 'omt_a' });
    expect(await getSession('omt_c')).toBeUndefined();
  });
});

describe('/resume in a single-session group', () => {
  it('lists the main area\'s own session but not one a topic holds', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      expect(listed(card)).toEqual(['mine', 'past']);
      expect(card.json).toContain('另有 1 条在本群别处用着，没有列出：话题「held」。');
    } finally { await app.shutdown(); }
  });

  it('refuses a pick a topic took after the card went out, and says where', async () => {
    const be = backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      await upsertSession(record('omt_b', 'past'));
      await pick(app, card, 'past');
      expect(await settled(card)).toContain('这条会话正在本群的话题「past」里用着');
      expect(await getSession(CHAT)).toMatchObject({ sessionId: 'mine' });
      expect(be.readHistory).not.toHaveBeenCalled();
    } finally { await app.shutdown(); }
  });

  it('resumes the session the main area already holds again', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      await pick(app, card, 'mine');
      expect(await settled(card)).toContain('已切回');
      expect(await getSession(CHAT)).toMatchObject({ sessionId: 'mine', summary: 'historic' });
      await expect(app.collaboration({ action: 'resume', ...target, sessionId: 'mine', backend: BE })).resolves.toMatchObject({ threadId: CHAT });
    } finally { await app.shutdown(); }
  });

  it('refuses a web resume of a session a topic holds', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      await expect(app.collaboration({ action: 'resume', ...target, sessionId: 'held', backend: BE })).rejects.toThrow('这条会话正在本群的话题「held」里用着');
      expect(await getSession(CHAT)).toMatchObject({ sessionId: 'mine' });
      expect(fake.cards).toHaveLength(0); // no history card
    } finally { await app.shutdown(); }
  });

  it('leaves the main area as it was when a topic takes the session during a web resume', async () => {
    const be = backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      await app.collaboration({ action: 'clear', ...target, threadId: CHAT }); // a live thread in the main area
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      be.readHistory.mockImplementation(async () => { await gate; return { name: 'historic', preview: '', turns: [], totalTurns: 0 }; });
      const web = app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: BE });
      await until(() => expect(be.readHistory).toHaveBeenCalled());
      await upsertSession(record('omt_b', 'past'));
      release();
      await expect(web).rejects.toThrow('这条会话正在本群的话题「past」里用着');
      expect(fake.cards.filter((c) => c.json.includes('已恢复历史会话'))).toHaveLength(0);
      expect(be.thread.close).not.toHaveBeenCalled();
      expect(await bound('past')).toEqual(['omt_b']);
    } finally { await app.shutdown(); }
  });
});

describe('/resume in a group where each topic is a session', () => {
  beforeEach(() => updateProject('demo', { kind: 'multi' }));

  it('lists only sessions no place of the group holds, and says where the others are', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      expect(listed(card)).toEqual(['past']);
      expect(card.json).toContain('另有 2 条在本群别处用着，没有列出：主区、话题「held」。');
      // A placeholder summary names no topic.
      await upsertSession(record('omt_b', 'past', { summary: '(新会话)' }));
      const none = await picker(app);
      expect(listed(none)).toEqual([]);
      expect(none.json).toContain('该目录下的 3 条历史会话都在本群别处用着：主区、话题「held」、一个话题。');
    } finally { await app.shutdown(); }
  });

  it('refuses a pick held elsewhere without opening a topic', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      await upsertSession(record('omt_b', 'past'));
      await pick(app, card, 'past');
      expect(await settled(card)).toContain('这条会话正在本群的话题「past」里用着');
      expect(fake.cards.filter((c) => c.json.includes('已恢复历史会话'))).toHaveLength(0);
      expect(await bound('past')).toEqual(['omt_b']);
    } finally { await app.shutdown(); }
  });

  it('refuses a web resume of a session the main area holds, naming the main area', async () => {
    backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      await expect(app.collaboration({ action: 'resume', ...target, sessionId: 'mine', backend: BE })).rejects.toThrow('这条会话正在本群的主区用着');
      expect(send).not.toHaveBeenCalled(); // no topic root
    } finally { await app.shutdown(); }
  });

  it('leaves a new topic its own session when a message there started one before the bind', async () => {
    const be = backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let opened: string | undefined;
      fake.lookup = async (id) => { opened = `omt_${id}`; await gate; };
      await pick(app, card, 'past');
      await until(() => expect(opened).toBeDefined());
      // Someone writes in the new topic before its id is known.
      await app.onMessage({ ...message('接着上次的说'), threadId: opened! } as never);
      await until(() => expect(be.thread.runStreamed).toHaveBeenCalled());
      release();
      expect(await settled(card)).toContain('新话题里已经开始了新的会话');
      expect(await bound('past')).toEqual([]);
      expect((await getSession(opened!))?.sessionId).not.toBe('past');
      await until(() => expect(send.mock.calls.filter((call) => JSON.stringify(call[1]).includes('这个话题没有接上会话：新话题里已经开始了新的会话'))).toHaveLength(1));
      be.turnEnd();
    } finally { await app.shutdown(); }
  });

  it('of a card pick and a web resume of one session at once, only one binds it', async () => {
    const be = backend(); const app = createOrchestrator(channel as never, cfg, paths.appDir);
    try {
      const card = await picker(app);
      // Both pass the first look before either binds.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      be.readHistory.mockImplementation(async () => { await gate; return { name: 'historic', preview: '', turns: [], totalTurns: 0 }; });
      await pick(app, card, 'past');
      const web = app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: BE }).then(() => 'ok', (error: Error) => error.message);
      await until(() => expect(be.readHistory).toHaveBeenCalledTimes(2));
      release();
      const webOutcome = await web;
      const cardOutcome = await settled(card);
      expect(await bound('past')).toHaveLength(1);
      const refused = [webOutcome.includes('这条会话正在本群的话题「historic」里用着'), cardOutcome.includes('这条会话正在本群的话题「historic」里用着')];
      expect(refused.filter(Boolean)).toHaveLength(1);
      // Both opened a topic; the desktop card waits for binding before claiming success.
      expect(fake.cards.filter((c) => c.json.includes('已恢复历史会话'))).toHaveLength(1);
      const webCard = fake.cards.find(c => c.json.includes('正在恢复历史会话'));
      expect(webCard).toBeDefined();
      expect(fake.updates.filter(update => update.id === webCard!.id).at(-1)?.json)
        .toContain(webOutcome === 'ok' ? '已恢复历史会话' : '未恢复历史会话');
      await until(() => expect(send.mock.calls.filter((call) => JSON.stringify(call[1]).includes('这个话题没有接上会话'))).toHaveLength(1));
    } finally { await app.shutdown(); }
  });
});
