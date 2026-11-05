import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { saveConfig } from '../src/config/store';
import { readDropped } from '../src/bot/restart-dropped';
import { parseAskRequest, type AgentEvent, type AgentInput, type StartThreadOptions } from '../src/agent/types';
import type { HostApi } from '../src/admin/ipc';
import { paths } from '../src/config/paths';
import { dmChatId, dmProject } from '../src/project/registry';
import { getSession, listSessions, upsertSession } from '../src/bot/session-store';
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import { dmMemoryLocation, MemoryStore } from '../src/bot/memory-store';
import { botRoot } from '../src/bot/role-files';
import { seedBots } from './helpers/bot-fixture';

// dm-agent 5 (D2): an administrator's private chat is an Agent's window, through the real orchestrator, session store,
// project registry and entries on a temp dir; backend, Feishu, cards and transcription are faked.

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-turn-')));
  // Every other file the bot opens at start lands in the temp dir too.
  const inside = <T extends object>(known: T) => new Proxy(known, { get: (target, key) => key in target ? target[key as keyof T] : join(appDir, String(key)) });
  return { paths: inside({ appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects'), commentInstructionsFile: join(appDir, 'instructions.md') }),
    botPaths: () => inside({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fake = vi.hoisted(() => ({
  backend: undefined as any, n: 0,
  cards: [] as { id: string; chatId: string; json: string }[],
  voice: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ text: '语音的话' })),
  /** The provider has no full tier. */
  noFull: false,
}));
vi.mock('../src/agent/permission', async original => {
  const real = await original<typeof import('../src/agent/permission')>();
  return { ...real, tierInfo: (...args: Parameters<typeof real.tierInfo>) => ({ ...real.tierInfo(...args), ...fake.noFull ? { unavailable: '这个 provider 没有这一档。' } : {} }) };
});
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/card/managed', () => ({
  sendManagedCard: vi.fn(async (_channel: unknown, chatId: string, card: unknown) => {
    const id = `om_card_${++fake.n}`; fake.cards.push({ id, chatId, json: JSON.stringify(card) }); return { messageId: id };
  }),
  updateManagedCard: vi.fn(async () => true),
}));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} async register() {} } }));
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
vi.mock('../src/voice/inbound', async original => ({ ...await original<object>(), ingestVoice: fake.voice }));

const BE = 'codex-appserver';
const APP = 'cli_fixture';
const bot = { appId: APP, tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
const DROPPED = join(paths.appDir, 'dropped.json');
const A = 'oc_p2p_a', B = 'oc_p2p_b';
const OWNER = 'ou_owner', ADMIN = 'ou_admin', STRANGER = 'ou_stranger';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function thread(sessionId = 'native-1') {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const t = {
    sessionId, isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    injectContext: vi.fn(async (_text: string) => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const id = `turn-${turns.push(end)}`;
      return { turnId: () => id, events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: id };
        await end.promise;
        yield { type: 'done', turnId: id };
      })() };
    },
  };
  return { t, turns, consumed };
}
type Run = ReturnType<typeof thread>;
function backend(...runs: Run[]) {
  let next = 0;
  const pick = async () => (runs[next++] ?? runs.at(-1)!).t;
  fake.backend = { id: BE, displayName: 'Codex (app-server)', capabilities: { steer: true }, listModels: async () => [],
    startThread: vi.fn(async (_options: StartThreadOptions) => pick()), resumeThread: vi.fn(async (_options: StartThreadOptions) => pick()),
    listThreads: vi.fn(async () => [] as { sessionId: string; preview: string; createdAt: number; updatedAt: number }[]),
    readHistory: vi.fn(async () => ({ name: 'historic', preview: '', turns: [], totalTurns: 0 })) };
  return fake.backend;
}
const send = vi.fn(async (..._args: unknown[]) => ({ messageId: `om_sent_${++fake.n}` }));
const channel = { send, rawClient: { im: { v1: {
  message: { get: async () => ({ data: { items: [{}] } }) },
  messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
} } } };
let cfg: AppConfig;
let opened: ReturnType<typeof createOrchestrator>[] = [];
let revoked: string[] = [];
async function app(policy: 'steer' | 'queue' = 'queue', host?: Pick<HostApi, 'issueSessionToken'>) {
  cfg.preferences!.pendingPolicy = policy;
  await saveConfig(cfg);
  const entries: AgentEntries = createAgentEntries({ appId: APP, isAdmin: id => (cfg.preferences?.access?.admins ?? []).includes(id), tools: [],
    sessions: { revoke: sessionId => { revoked.push(sessionId); } } });
  const issue = vi.spyOn(entries, 'issue');
  const o = createOrchestrator(channel as never, cfg, paths.appDir, undefined, { entries, bot, droppedFile: DROPPED, ...(host ? { host } : {}) });
  opened.push(o); await o.initialize?.();
  return { o, entries, issue };
}
function message(text: string, more: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `om_msg_${++fake.n}`, chatId: A, chatType: 'p2p', content: text, senderId: OWNER, senderName: 'Owner', mentionedBot: false, createTime: Date.now(),
    rawContentType: 'text', resources: [], mentions: [], mentionAll: false, raw: { sender: { sender_type: 'user' } }, ...more } as NormalizedMessage;
}
const until = (check: () => unknown) => vi.waitFor(check, { interval: 5, timeout: 4000 });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 30));
/** A run's tail (final card, close of the turn) after its last event. */
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 150));
const said = () => JSON.stringify(send.mock.calls);
const remove = async (o: ReturnType<typeof createOrchestrator>, openId: string) => {
  const view = await o.settings.read({ kind: 'agent', botId: APP }) as { administrators: { revision: string } };
  return o.settings.act({ kind: 'adminMember', botId: APP, openId, membership: 'absent', revision: view.administrators.revision });
};
const restore = async (o: ReturnType<typeof createOrchestrator>, openId: string) => {
  const view = await o.settings.read({ kind: 'agent', botId: APP }) as { administrators: { revision: string } };
  return o.settings.act({ kind: 'adminMember', botId: APP, openId, membership: 'present', revision: view.administrators.revision });
};

beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true }); await rm(DROPPED, { force: true });
  cfg = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: OWNER, admins: [OWNER, ADMIN] }, completionReminder: { mode: 'manual' } } };
  fake.cards = []; fake.noFull = false; send.mockClear(); revoked = []; fake.voice.mockReset().mockResolvedValue({ text: '语音的话' });
});
afterEach(async () => { for (const o of opened) await o.shutdown(); opened = []; });
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

describe('who gets in, in what order', () => {
  // dm-agent 6.1 and 6.4. main 必败: VONVON_SCOPE named the private chat, and nothing kept the union_id another Bot needs
  it('starts a private chat\'s session with its token and no scope, and tells the turn the person\'s union_id', async () => {
    const TOKEN = `vs1.ses_0123456789abcdef.${'a'.repeat(43)}`;
    const host = { issueSessionToken: vi.fn(async () => TOKEN) };
    const run = thread(), be = backend(run); const { o, entries } = await app('queue', host);
    const turn = vi.spyOn(entries, 'openTurn');
    await o.onMessage(message('帮我看看', { raw: { sender: { sender_type: 'user', sender_id: { union_id: 'on_person' } } } }));
    await until(() => expect(run.consumed).toHaveLength(1));
    const env = (be.startThread.mock.calls[0][0] as StartThreadOptions).profile?.env;
    expect(env).toMatchObject({ VONVON_SESSION: TOKEN, VONVON_BOT: APP });
    expect(env).not.toHaveProperty('VONVON_SCOPE');
    expect(turn.mock.calls[0]?.[1]).toMatchObject({ requesterOpenId: OWNER, requesterUnionId: 'on_person' });
    expect((await dmProject())?.dm?.people[A]).toMatchObject({ openId: OWNER, unionId: 'on_person' });
  });
  it('runs an administrator\'s plain words as a turn of the private chat, in place and with the fixed full tier (main 必败)', async () => {
    const run = thread(), be = backend(run); const { o, issue } = await app();
    await o.onMessage(message('帮我看看'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(issue).toHaveBeenCalledWith({ kind: 'p2p', chatId: A });
    const options = be.startThread.mock.calls[0][0] as StartThreadOptions;
    expect(options.cwd).toBe((await dmProject())?.cwd);
    expect(options.mode).toBe('full');
    expect(options.profile?.tools).toMatchObject({ feishu: true, feishuApi: true });
    expect((await dmProject())?.dm?.people[A]).toMatchObject({ openId: OWNER });
    expect(await getSession(A)).toMatchObject({ chatId: A, sessionId: 'native-1' });
    expect((await listSessions()).some(record => record.chatId === dmChatId(APP))).toBe(false);
    run.turns[0]!.resolve();
  });

  // dm-agent 5 (D3). main 必败: a session's opening had no private-chat memory.
  it('opens each administrator\'s session with their own memory and not the other\'s', async () => {
    const remember = (openId: string, text: string) => new MemoryStore(dmMemoryLocation(botRoot(APP), openId)).add({ text, trust: 'trusted', actor: { role: 'admin', openId },
      source: { via: 'tool', botId: APP, actorRole: 'admin', actorOpenId: openId } });
    await remember(OWNER, '主人的私聊记忆'); await remember(ADMIN, '管理员的私聊记忆');
    const first = thread('native-1'), second = thread('native-2'), be = backend(first, second); const { o } = await app();
    await o.onMessage(message('帮我看看'));
    await until(() => expect(first.consumed).toHaveLength(1));
    await o.onMessage(message('我也看看', { chatId: B, senderId: ADMIN, senderName: 'Admin' }));
    await until(() => expect(second.consumed).toHaveLength(1));
    const opening = (index: number) => (be.startThread.mock.calls[index][0] as StartThreadOptions).profile?.instructions ?? '';
    expect(opening(0)).toContain('主人的私聊记忆');
    expect(opening(0)).not.toContain('管理员的私聊记忆');
    expect(opening(1)).toContain('管理员的私聊记忆');
    expect(opening(1)).not.toContain('主人的私聊记忆');
    first.turns[0]!.resolve(); second.turns[0]!.resolve();
  });

  it('takes no bot, and refuses someone else before anything is transcribed', async () => {
    const be = backend(thread()); const { o } = await app();
    await o.onMessage(message('hi', { senderId: 'ou_bot', raw: { sender: { sender_type: 'app' } } } as never));
    expect(send).not.toHaveBeenCalled();
    await o.onMessage(message('', { senderId: STRANGER, rawContentType: 'audio' }));
    await until(() => expect(send).toHaveBeenCalled());
    expect(fake.voice).not.toHaveBeenCalled();
    // Not a reply to anyone's card either: a quote does not open the door.
    await o.onMessage(message('回答', { senderId: STRANGER, parentId: 'om_nothing' } as never));
    await tick();
    // The same person is told once in ten minutes (dm-agent 3.5).
    expect(send).toHaveBeenCalledTimes(1);
    expect(be.startThread).not.toHaveBeenCalled(); expect(await listSessions()).toEqual([]);
    expect((await dmProject())?.dm?.people[A]).toBeUndefined();
  });

  it.each(['/menu', '/settings', '/MENU extra'])('gives the old menu for %s and starts nothing', async text => {
    const be = backend(thread()); const { o } = await app();
    await o.onMessage(message(text));
    await until(() => expect(fake.cards.some(card => card.chatId === A && card.json.includes('常用入口'))).toBe(true));
    await tick();
    expect(be.startThread).not.toHaveBeenCalled();
  });

  it('lets anything else that starts like a command through to the Agent, and a spoken message too', async () => {
    const run = thread(), be = backend(run); const { o } = await app();
    await o.onMessage(message('/menus 是什么'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await until(async () => expect((await getSession(A))?.sessionId).toBe('native-1'));
    await o.onMessage(message('', { rawContentType: 'audio' }));
    await until(() => expect(fake.voice).toHaveBeenCalled());
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(JSON.stringify(run.consumed[1])).toContain('语音的话');
    expect(be.startThread).toHaveBeenCalledOnce();
    run.turns[1]!.resolve();
  });

  it('says so when the row could not be made, and starts nothing', async () => {
    const be = backend(thread());
    const o = createOrchestrator(channel as never, cfg, paths.appDir, undefined, {}); opened.push(o);
    await o.onMessage(message('在吗'));
    await until(() => expect(said()).toContain('私聊项目没建好'));
    expect(be.startThread).not.toHaveBeenCalled();
  });

  it('says why each time when the provider has no full tier, and /menu still answers (main 必败)', async () => {
    const be = backend(thread()); const { o } = await app(); fake.noFull = true;
    await o.onMessage(message('在吗'));
    await until(() => expect(said()).toContain('私聊固定用'));
    expect(said()).toContain('/menu');
    await o.onMessage(message('还在吗'));
    await until(() => expect(send).toHaveBeenCalledTimes(2));
    await o.onMessage(message('/menu'));
    await until(() => expect(fake.cards.some(card => card.json.includes('常用入口'))).toBe(true));
    expect(be.startThread).not.toHaveBeenCalled();
  });

  it('is not shut by a list of allowed groups', async () => {
    const run = thread(); backend(run); cfg.preferences!.access!.allowedChats = ['oc_elsewhere'];
    const { o } = await app();
    await o.onMessage(message('在吗'));
    await until(() => expect(run.consumed).toHaveLength(1));
    // The run card's stop goes through the same place check.
    await o.onReaction({ action: 'added', emojiType: 'OK', messageId: 'card', operator: { openId: OWNER } } as never);
    await until(() => expect(run.t.abort).toHaveBeenCalled());
  });

  it('keeps each person\'s window apart: a chat and a session each', async () => {
    const one = thread('native-a'), two = thread('native-b'); backend(one, two); const { o } = await app();
    await o.onMessage(message('我的')); await until(() => expect(one.consumed).toHaveLength(1));
    await o.onMessage(message('我的', { chatId: B, senderId: ADMIN, senderName: 'Admin' })); await until(() => expect(two.consumed).toHaveLength(1));
    expect(await getSession(A)).toMatchObject({ sessionId: 'native-a' });
    expect(await getSession(B)).toMatchObject({ sessionId: 'native-b' });
    one.turns[0]!.resolve(); two.turns[0]!.resolve();
  });
});

describe('a turn going on in a private chat', () => {
  it('queues what is said meanwhile and runs it next', async () => {
    const run = thread(), be = backend(run); const { o } = await app('queue');
    await o.onMessage(message('第一句')); await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('第二句'));
    await tick(); expect(run.consumed).toHaveLength(1);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(JSON.stringify(run.consumed[1])).toContain('第二句');
    expect(be.startThread).toHaveBeenCalledOnce();
    run.turns[1]!.resolve();
  });

  it('steers the turn with what is said meanwhile, under the steer policy', async () => {
    const run = thread(); backend(run); const { o } = await app('steer');
    await o.onMessage(message('第一句')); await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('补一句'));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(JSON.stringify(run.t.steer.mock.calls[0]![0])).toContain('补一句');
    expect(run.consumed).toHaveLength(1);
    run.turns[0]!.resolve();
  });

  it('keeps a /goal turn\'s sensitive question in this window: no other administrator gets it (main 必败)', async () => {
    const run = thread(); backend(run); const { o } = await app();
    const request = parseAskRequest({ id: 'ask-1', title: '需要你决定', acceptedConsequence: '继续', declinedConsequence: '暂停', kind: 'choices',
      questions: [{ id: 'password', title: '密码', detail: '填写密码', selection: 'text', sensitive: true }] });
    const end = deferred<void>();
    Object.assign(run.t, { clearGoal: async () => undefined, runGoal: () => ({ turnId: () => 'goal-1', respondToAsk: async () => undefined, events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId: 'goal-1' };
      yield { type: 'ask', request };
      await end.promise;
      yield { type: 'done', turnId: 'goal-1' };
    })() }) });
    await o.onMessage(message('/goal 改完'));
    await until(() => expect(fake.cards.some(card => card.chatId === A && card.json.includes('填写密码'))).toBe(true));
    await tick();
    expect(fake.cards.filter(card => card.chatId === ADMIN)).toEqual([]);
    expect(said()).not.toContain(ADMIN);
    end.resolve();
  });

  it('holds /new until the turn ends; then the next words go to a new session and the old one stays attributed', async () => {
    const first = thread('native-old'), second = thread('native-new'); backend(first, second); const { o } = await app();
    await o.onMessage(message('旧的')); await until(() => expect(first.consumed).toHaveLength(1));
    await o.onMessage(message('/new'));
    await until(() => expect(said()).toContain('结束后再'));
    first.turns[0]!.resolve();
    await settled();
    await o.onMessage(message('/new'));
    await until(async () => expect((await getSession(A))?.sessionId).toBe('native-new'));
    expect((await getSession(A))?.earlier).toEqual(['native-old']);
    await o.onMessage(message('新的')); await until(() => expect(second.consumed).toHaveLength(1));
    second.turns[0]!.resolve();
  });

  it('stops by the card\'s reaction, the queue with it, and takes the next words in the same session', async () => {
    const run = thread(), be = backend(run); const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('排着的')); await tick();
    await o.onReaction({ action: 'added', emojiType: 'OK', messageId: 'card', operator: { openId: OWNER } } as never);
    await until(() => expect(run.t.abort).toHaveBeenCalled());
    await settled();
    expect(run.consumed).toHaveLength(1);
    await o.onMessage(message('接着说')); await until(() => expect(run.consumed).toHaveLength(2));
    expect(be.startThread).toHaveBeenCalledOnce();
    run.turns[1]!.resolve();
  });

  it('is cut by a shutdown like a group\'s: the queued words are kept for the restart to ask again', async () => {
    const run = thread(); backend(run); const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(run.consumed).toHaveLength(1));
    const queued = message('第二句');
    await o.onMessage(queued); await tick();
    await o.shutdown();
    expect(readDropped(DROPPED, Date.now()).entries).toMatchObject([{ chatId: A, messageId: queued.messageId, place: 'main', count: 1 }]);
  });

  it('picks the same session up after a restart, as a private chat again', async () => {
    const before = thread('native-kept'); backend(before);
    const first = await app();
    await first.o.onMessage(message('记住')); await until(() => expect(before.consumed).toHaveLength(1));
    before.turns[0]!.resolve();
    await until(async () => expect((await getSession(A))?.sessionId).toBe('native-kept'));
    await first.o.shutdown();
    const after = thread('native-kept'), be = backend(after);
    const second = await app();
    await second.o.onMessage(message('还在吗')); await until(() => expect(after.consumed).toHaveLength(1));
    expect(be.resumeThread).toHaveBeenCalledOnce();
    expect(be.resumeThread.mock.calls[0][0]).toMatchObject({ sessionId: 'native-kept', mode: 'full' });
    expect(be.startThread).not.toHaveBeenCalled();
    expect(second.issue).toHaveBeenCalledWith({ kind: 'p2p', chatId: A });
    after.turns[0]!.resolve();
  });
});

describe('/resume in a private chat', () => {
  it('lists this person\'s sessions, parked ones too, and nothing else (main 必败)', async () => {
    const run = thread('mine'), be = backend(run); const { o } = await app();
    await o.onMessage(message('开始')); await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await until(async () => expect((await getSession(A))?.sessionId).toBe('mine'));
    const row = await dmProject();
    await upsertSession({ threadId: B, chatId: B, cwd: row!.cwd, sessionId: 'his', backend: BE, summary: '', createdAt: 1, updatedAt: 1 });
    const current = (await getSession(A))!;
    await upsertSession({ ...current, sessionId: 'mine-parked' });
    await upsertSession({ ...current, sessionId: 'mine' });
    be.listThreads.mockResolvedValue(['mine', 'mine-parked', 'his', 'nobodys'].map(sessionId => ({ sessionId, preview: `preview-${sessionId}`, createdAt: 1, updatedAt: 2 })));
    await o.onMessage(message('/resume'));
    await until(() => expect(fake.cards.some(card => card.json.includes('恢复历史会话'))).toBe(true));
    const card = fake.cards.find(c => c.json.includes('恢复历史会话'))!.json;
    expect(card).toContain('mine-parked');
    expect(card).not.toContain('his'); expect(card).not.toContain('nobodys');
    expect(be.listThreads).toHaveBeenCalledWith(row!.cwd, 200);
  });
});

describe('an administrator taken off the list', () => {
  it('has the running turn stopped, the queue emptied, the token revoked and the window shut (main 必败)', async () => {
    const run = thread(); backend(run); const { o } = await app();
    await o.onMessage(message('干活')); await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('排着的')); await tick();
    expect((await remove(o, OWNER)).kind).toBe('saved');
    await until(() => expect(run.t.close).toHaveBeenCalled());
    // Stopped as a stop is, not only cut off by the close.
    expect(run.t.abort).toHaveBeenCalled();
    await tick();
    expect(run.consumed).toHaveLength(1); expect(revoked).toHaveLength(1);
    send.mockClear();
    await o.onMessage(message('还能用吗'));
    await until(() => expect(send).toHaveBeenCalled());
    await tick();
    expect(run.consumed).toHaveLength(1);
  });

  it.each(['sessionsFile', 'projectsFile'] as const)('stops the turn and revokes the token though %s cannot be read', async file => {
    const run = thread(); backend(run); const { o } = await app();
    await o.onMessage(message('干活')); await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('排着的')); await tick();
    const view = await o.settings.read({ kind: 'agent', botId: APP }) as { administrators: { revision: string } };
    const kept = await readFile(paths[file], 'utf8');
    await writeFile(paths[file], '{');
    try {
      expect((await o.settings.act({ kind: 'adminMember', botId: APP, openId: OWNER, membership: 'absent', revision: view.administrators.revision })).kind).toBe('saved');
      await until(() => expect(run.t.abort).toHaveBeenCalled());
      await until(() => expect(run.t.close).toHaveBeenCalled());
      expect(revoked).toHaveLength(1);
      await tick();
      expect(run.consumed).toHaveLength(1);
    } finally { await writeFile(paths[file], kept); }
  });

  it('leaves another administrator\'s window alone', async () => {
    const one = thread('native-a'), two = thread('native-b'); backend(one, two); const { o } = await app();
    await o.onMessage(message('甲')); await until(() => expect(one.consumed).toHaveLength(1));
    await o.onMessage(message('乙', { chatId: B, senderId: ADMIN })); await until(() => expect(two.consumed).toHaveLength(1));
    await remove(o, ADMIN);
    await until(() => expect(two.t.close).toHaveBeenCalled());
    expect(one.t.close).not.toHaveBeenCalled(); expect(revoked).toHaveLength(1);
    one.turns[0]!.resolve();
  });

  it('starts no turn when the removal lands while the session is being made, and closes what was made', async () => {
    const run = thread(), made = deferred<Run['t']>(); const be = backend(run); const { o } = await app();
    be.startThread.mockImplementationOnce(() => made.promise);
    await o.onMessage(message('干活')); await until(() => expect(be.startThread).toHaveBeenCalled());
    await remove(o, OWNER);
    made.resolve(run.t);
    await until(() => expect(run.t.close).toHaveBeenCalled());
    await tick();
    expect(run.consumed).toEqual([]);
    expect(said()).toContain('这一轮没有开始');
  });

  it('starts nothing when the removal lands while a message is being transcribed', async () => {
    const heard = deferred<unknown>(), be = backend(thread()); const { o } = await app();
    fake.voice.mockImplementationOnce(() => heard.promise);
    const pending = o.onMessage(message('', { rawContentType: 'audio' }));
    await until(() => expect(fake.voice).toHaveBeenCalled());
    await remove(o, OWNER);
    send.mockClear();
    heard.resolve({ text: '语音的话' }); await pending; await settled();
    expect(be.startThread).not.toHaveBeenCalled();
    // Stopped at the door of the turn, before a session is asked for: nothing to tell.
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['steer', 'queue'] as const)('neither steers nor queues words transcribed after the removal, a turn running (%s)', async policy => {
    const run = thread(), heard = deferred<unknown>(); backend(run); const { o } = await app(policy);
    await o.onMessage(message('干活')); await until(() => expect(run.consumed).toHaveLength(1));
    fake.voice.mockImplementationOnce(() => heard.promise);
    const pending = o.onMessage(message('', { rawContentType: 'audio' }));
    await until(() => expect(fake.voice).toHaveBeenCalled());
    await remove(o, OWNER);
    heard.resolve({ text: '语音的话' }); await pending; await settled();
    expect(run.t.steer).not.toHaveBeenCalled();
    expect(run.consumed).toHaveLength(1);
  });

  it('gets the window back when put on the list again, on the same session', async () => {
    const first = thread('native-kept'), back = thread('native-kept'), be = backend(first, back); const { o } = await app();
    await o.onMessage(message('干活')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve();
    await until(async () => expect((await getSession(A))?.sessionId).toBe('native-kept'));
    await remove(o, OWNER); await until(() => expect(first.t.close).toHaveBeenCalled());
    await restore(o, OWNER);
    await o.onMessage(message('回来了')); await until(() => expect(back.consumed).toHaveLength(1));
    expect(be.resumeThread.mock.calls.at(-1)?.[0]).toMatchObject({ sessionId: 'native-kept' });
    back.turns[0]!.resolve();
  });

  it('does nothing for someone without a private chat', async () => {
    const run = thread(); backend(run); const { o } = await app();
    await o.onMessage(message('干活')); await until(() => expect(run.consumed).toHaveLength(1));
    await remove(o, ADMIN); await tick();
    expect(run.t.close).not.toHaveBeenCalled(); expect(revoked).toEqual([]);
    run.turns[0]!.resolve();
  });
});
