import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { ContextMessage } from '../src/bot/context-weave';
import type { AppConfig } from '../src/config/schema';
import { saveConfig } from '../src/config/store';
import { readDropped } from '../src/bot/restart-dropped';
import { parseAskRequest, type AgentEvent, type AgentInput, type StartThreadOptions } from '../src/agent/types';
import type { HostApi } from '../src/admin/ipc';
import { paths } from '../src/config/paths';
import { dmChatId, dmProject, mutateProjectByChatId } from '../src/project/registry';
import { getSession, listSessions, upsertSession } from '../src/bot/session-store';
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import { dmMemoryLocation, MemoryStore } from '../src/bot/memory-store';
import { botRoot } from '../src/bot/role-files';
import { closeCodexToolFixtures, codexToolsFixture } from './helpers/codex-tools-fixture';
import { seedBots } from './helpers/bot-fixture';

// dm-agent 5 (D2): an administrator's private chat is an Agent's window, through the real orchestrator, session store,
// project registry and entries on a temp dir; backend, Feishu, cards and transcription are faked.

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-turn-')));
  // Every other file the bot opens at start lands in the temp dir too.
  const inside = <T extends object>(known: T) => new Proxy(known, { get: (target, key) => key in target ? target[key as keyof T] : join(appDir, String(key)) });
  return { paths: inside({ appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects'), commentInstructionsFile: join(appDir, 'instructions.md') }),
    botPaths: () => inside({ builtinPackage: (name: string) => join(appDir, 'builtin', name), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fake = vi.hoisted(() => ({
  backend: undefined as any, n: 0,
  history: undefined as ContextMessage[] | undefined,
  cards: [] as { id: string; chatId: string; json: string }[],
  voice: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ text: '语音的话' })),
  /** The provider has no full tier. */
  noFull: false,
}));
vi.mock('../src/bot/context-weave', async original => {
  const real = await original<typeof import('../src/bot/context-weave')>();
  return {...real, fetchChatContext: (...args: Parameters<typeof real.fetchChatContext>) => fake.history
    ? Promise.resolve({messages: fake.history, ok: true, complete: true}) : real.fetchChatContext(...args)};
});
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
async function app(policy: 'steer' | 'queue' = 'queue', host?: Pick<HostApi, 'issueSessionToken'>, authoring?: import('../src/recipe/authoring-service').AuthoringService, create = createOrchestrator) {
  cfg.preferences!.pendingPolicy = policy;
  await saveConfig(cfg);
  const entries: AgentEntries = createAgentEntries({ appId: APP, isAdmin: id => (cfg.preferences?.access?.admins ?? []).includes(id), tools: authoring?(await import('../src/agent/entry/resource-tools')).resourceTools((get,q)=>authoring.resources.tool(get,q)):[],
    sessions: { revoke: sessionId => { revoked.push(sessionId); } } });
  const issue = vi.spyOn(entries, 'issue');
  const o = create(channel as never, cfg, paths.appDir, undefined, { entries, bot, authoring, droppedFile: DROPPED, ...(host ? { host } : {}) });
  opened.push(o); await o.initialize?.();
  // These tests are about the turn, so every message runs: the judge in front of it is dm-smart.test.ts.
  await until(async () => expect(await dmProject()).toBeDefined());
  await mutateProjectByChatId(dmChatId(APP), project => { project.smart = false; });
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
  fake.history = undefined; fake.cards = []; fake.noFull = false; send.mockClear(); revoked = []; fake.voice.mockReset().mockResolvedValue({ text: '语音的话' });
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

  // owner 2026-11-06: what a group can set, a private chat can set. The row wins over the Bot.
  it('takes 运行中来了消息 from its own row', async () => {
    const run = thread(); backend(run); const { o } = await app('queue');
    await mutateProjectByChatId(dmChatId(APP), project => { project.pendingPolicy = 'steer'; });
    await o.onMessage(message('先看这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('顺便看那个'));
    await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
    run.turns[0]!.resolve();
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

describe('the page changing what a private chat runs on (dm-agent 4.1)', () => {
  const model = (id: string) => ({ id, displayName: id, description: '', supportedEfforts: ['medium' as const], defaultEffort: 'medium' as const, isDefault: false, hidden: false });
  /** The page's save: the row's list, and its live thread gone, as settings.save does. */
  const save = async (run: Run, models: string[]) => {
    const stored = JSON.parse(await readFile(paths.projectsFile, 'utf8')) as { projects: { dm?: unknown; backend?: string; modelAccess?: unknown }[] };
    Object.assign(stored.projects.find(row => row.dm)!, { backend: BE, modelAccess: { backend: BE, models, efforts: ['medium'], defaultModel: models[0]!, defaultEffort: 'medium' } });
    await writeFile(paths.projectsFile, JSON.stringify(stored));
    run.t.isAlive = () => false;
  };
  it('moves to the row\'s default when the model in use is taken off the list, in the same session', async () => {
    const first = thread('native-1'), again = thread('native-1'), be = backend(first, again); be.listModels = async () => [model('old'), model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, model: 'old', effort: 'medium' });
    await save(first, ['new']);
    await o.onMessage(message('第二句')); await until(() => expect(again.consumed).toHaveLength(1));
    expect(await getSession(A)).toMatchObject({ sessionId: 'native-1', model: 'new', effort: 'medium' });
    expect(be.resumeThread.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'new' });
    expect(be.startThread).toHaveBeenCalledOnce();
    expect(said()).not.toContain('已不在本群可用范围');
    again.turns[0]!.resolve();
  });
  it('starts over on the new Provider, saying so, when the row moved to another', async () => {
    const first = thread('native-claude'), second = thread('native-new'), be = backend(first, second); be.listModels = async () => [model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, backend: 'claude-agent', model: 'sonnet', effort: 'medium' });
    await save(first, ['new']);
    await o.onMessage(message('第二句')); await until(() => expect(second.consumed).toHaveLength(1));
    expect(be.resumeThread).not.toHaveBeenCalled();
    expect(be.startThread).toHaveBeenCalledTimes(2);
    expect(await getSession(A)).toMatchObject({ backend: BE, sessionId: 'native-new', model: 'new' });
    expect(said()).not.toContain('已不在本群可用范围');
    second.turns[0]!.resolve();
  });
  it('/new starts on the row\'s default when the model in use left the list, not on a model its first turn would refuse', async () => {
    const first = thread('native-1'), second = thread('native-2'), be = backend(first, second); be.listModels = async () => [model('old'), model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, model: 'old', effort: 'medium' });
    await save(first, ['new']);
    await o.onMessage(message('/new')); await until(async () => expect((await getSession(A))?.sessionId).toBe('native-2'));
    expect(be.startThread.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'new', effort: 'medium' });
    await o.onMessage(message('第二句')); await until(() => expect(second.consumed).toHaveLength(1));
    expect(said()).not.toContain('已不在本群可用范围');
    second.turns[0]!.resolve();
  });
  it('/new goes to the row\'s Provider when the session is on another', async () => {
    const first = thread('native-claude'), second = thread('native-new'), be = backend(first, second); be.listModels = async () => [model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, backend: 'claude-agent', model: 'sonnet', effort: 'medium' });
    await save(first, ['new']);
    await o.onMessage(message('/new')); await until(async () => expect((await getSession(A))?.sessionId).toBe('native-new'));
    expect(await getSession(A)).toMatchObject({ backend: BE, model: 'new', effort: 'medium' });
    expect(said()).not.toContain('已不在本群可用范围');
  });
  it('/new keeps the model in use while it stays on the list', async () => {
    const first = thread('native-1'), second = thread('native-2'), be = backend(first, second); be.listModels = async () => [model('old'), model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, model: 'old', effort: 'medium' });
    await save(first, ['new', 'old']);
    await o.onMessage(message('/new')); await until(async () => expect((await getSession(A))?.sessionId).toBe('native-2'));
    expect(be.startThread.mock.calls.at(-1)?.[0]).toMatchObject({ model: 'old' });
  });
  it('leaves a session alone while its model stays on the list', async () => {
    const first = thread('native-1'), again = thread('native-1'), be = backend(first, again); be.listModels = async () => [model('old'), model('new')];
    const { o } = await app();
    await o.onMessage(message('第一句')); await until(() => expect(first.consumed).toHaveLength(1));
    first.turns[0]!.resolve(); await settled();
    await upsertSession({ ...(await getSession(A))!, model: 'old', effort: 'medium' });
    await save(first, ['new', 'old']);
    await o.onMessage(message('第二句')); await until(() => expect(again.consumed).toHaveLength(1));
    expect(await getSession(A)).toMatchObject({ model: 'old' });
    again.turns[0]!.resolve();
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

it.each([
  {resourceToolSessionId: 'old-native'},
  {resourceToolCatalog: {sessionId: 'old-native', version: 1}},
  {resourceToolCatalog: {sessionId: 'different-native', version: 2}},
])('upgrades an outdated recipe catalog before prepare and reuses the upgraded catalog after restart (%j)', async marker => {
  const {AuthoringService} = await import('../src/recipe/authoring-service');
  const service = new AuthoringService({bot, cfg, channel: channel as never, root: join(paths.appDir, 'resource-catalog'), origin: 'http://127.0.0.1:9', loopback: true, currentBot: async () => {}});
  vi.spyOn(service, 'onMessage').mockResolvedValue(false);
  vi.spyOn(service.resources, 'hasTrigger').mockReturnValue(true);
  vi.spyOn(service.resources, 'bind').mockResolvedValue('selected');
  const prepare = vi.spyOn(service.resources, 'tool').mockResolvedValue({status: 'ready'});
  const wire = codexToolsFixture();
  wire.seedTools('old-native', ['recipe_resource_read', 'recipe_resource_acquire']);
  async function startProvider() {
    vi.resetModules();
    const {CodexAppServerBackend} = await import('../src/agent/codex-appserver/backend');
    const {createOrchestrator} = await import('../src/bot/handle-message');
    fake.backend = new CodexAppServerBackend();
    vi.spyOn(fake.backend, 'listModels').mockResolvedValue([]);
    return app('queue', undefined, service, createOrchestrator);
  }
  let {o} = await startProvider();
  try {
    await upsertSession({threadId: A, chatId: A, sessionId: 'old-native', ...marker, backend: BE,
      cwd: (await dmProject())!.cwd, summary: 'old private chat', createdAt: 1, updatedAt: 1});
    fake.history = [{messageId: 'om_historical_catalog', senderId: OWNER, senderName: 'Owner', from: 'user', text: '升级前的私聊记录', createTime: 5}];
    wire.failNextStart();
    await o.onMessage(message('把配方用到已有群', {messageId: 'om_catalog_refused'}));
    await until(() => expect(said()).toContain('fixture refused thread/start'));
    expect(await getSession(A)).toMatchObject({sessionId: 'old-native', ...marker});
    const call = {tool: 'recipe_resource_prepare', args: {groupId: 'oc_existing'}};
    wire.scriptNext([call]);
    await o.onMessage(message('重试把配方用到已有群', {messageId: 'om_catalog_prepare'}));
    await until(() => expect(wire.answers()).toHaveLength(1));
    expect(wire.answers()[0]).toEqual({success: true, text: JSON.stringify({status: 'ready'})});
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[1]).toMatchObject({kind: 'prepare', groupId: 'oc_existing',wait:{signal:expect.any(AbortSignal)}});
    expect(wire.inputs().at(-1)?.text).toContain('升级前的私聊记录');
    expect(await getSession(A)).toMatchObject({sessionId: 'th', resourceToolCatalog: {sessionId: 'th', version: 2}, earlier: ['old-native']});
    expect(wire.starts()).toHaveLength(2);
    await o.shutdown();
    ({o} = await startProvider());
    wire.scriptNext([call]);
    await o.onMessage(message('继续应用到同一个群', {messageId: 'om_catalog_resumed'}));
    await until(() => expect(wire.answers()).toHaveLength(2));
    expect(wire.answers()[1]?.success).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(wire.starts()).toHaveLength(2);
    expect(wire.resumes().at(-1)?.threadId).toBe('th');
    expect((await getSession(A))?.earlier).toEqual(['old-native']);
  } finally {
    await o.shutdown();
    await closeCodexToolFixtures();
    service.close();
  }
});

it.each(['new session', 'old Codex rollout'] as const)('delivers an exact resource through the native reader to the real SDK private turn (%s)',async mode=>{
  const {randomUUID}=await import('node:crypto');
  const {receive,throughBridgeChannel}=await import('./helpers/lark-events');
  const {AuthoringService}=await import('../src/recipe/authoring-service');
  const {recipeAuthoringRequestSchema,agentIdSchema}=await import('@vonvon/protocol');
  const {startDynamicTools}=await import('../src/agent/codex-appserver/dynamic-tools');
  const {RecipeCreatorExecutor}=await import(new URL('../../desktop/src/recipe-creator.ts',import.meta.url).href);
  const {RecipeCreatorJournal}=await import(new URL('../../desktop/src/recipe-creator-journal.ts',import.meta.url).href);
  const {AuthoringJournal}=await import(new URL('../../desktop/src/recipe-authoring-journal.ts',import.meta.url).href);
  const {MetadataJournal}=await import(new URL('../../desktop/src/community-metadata-journal.ts',import.meta.url).href);
  const accountId=randomUUID(),recipeId=randomUUID(),target={recipeId,versionId:randomUUID()},later={recipeId,versionId:randomUUID()};
  const peer={id:randomUUID(),device:randomUUID()},lease=new AbortController();
  const info={name:'测试配方',summary:'测试',overview:'介绍',version:'1.0',access:'direct'};
  const guide=vi.fn(async()=>({code:0,data:{card_id:'card_resource'}}));
  const dispatch=vi.fn(async()=>({code:0,data:{message_id:'om_resource_guide',chat_id:A}}));
  const localChannel={...channel,rawClient:{...channel.rawClient,cardkit:{v1:{card:{create:guide}}},
    im:{v1:{...channel.rawClient.im.v1,chatMembers:{isInChat:async()=>({code:0,data:{is_in_chat:true}})},message:{...channel.rawClient.im.v1.message,create:dispatch}}}}};
  const serviceRoot = join(paths.appDir, mode);
  const service=new AuthoringService({bot,cfg,channel:localChannel as never,root:serviceRoot,origin:'http://127.0.0.1:9',loopback:true,currentBot:async()=>{}});
  const run=thread(),be=backend(run);
  // The in-memory backend accepts this session's start schemas. The old-rollout case exercises native acknowledgements below.
  Object.assign(run.t, {startedWithResourceTools: true});
  const wire = mode === 'old Codex rollout' ? codexToolsFixture() : undefined;
  async function startProvider() {
    if (!wire) return app('queue', undefined, service);
    vi.resetModules(); // A newly started daemon has a fresh process registry and session cache.
    const {CodexAppServerBackend} = await import('../src/agent/codex-appserver/backend');
    const {createOrchestrator} = await import('../src/bot/handle-message');
    fake.backend = new CodexAppServerBackend();
    vi.spyOn(fake.backend, 'listModels').mockResolvedValue([]);
    return app('steer', undefined, service, createOrchestrator);
  }
  let {o} = await startProvider();
  const event=async (text:string,id:string,quote?:string,sender=OWNER)=>receive({message_id:id,chat_id:A,chat_type:'p2p',message_type:'text',content:JSON.stringify({text}),
    ...(quote&&{parent_id:quote}),create_time:String(Date.now())},{bot:{openId:'ou_bot',name:'fixture'},sender:{openId:sender}});
  const rpc=(type:string,fields:object)=>service.request(peer,recipeAuthoringRequestSchema.parse({type,botId:APP,...fields}));
  const history=new AuthoringJournal();
  try{
    const targetGroup='oc_resource_target';
    const {addProject}=await import('../src/project/registry');
    await addProject({chatId:targetGroup,name:'Resource target',createdAt:1,cwd:paths.appDir,blank:false});
    if (wire) {
      const cwd = (await dmProject())!.cwd;
      await upsertSession({threadId: A, chatId: A, sessionId: 'old-native', backend: BE, cwd, summary: 'old private chat', createdAt: 1, updatedAt: 1});
      await throughBridgeChannel(await event('普通私聊 hold-old-turn', 'om_old_native'), m => o.onMessage(m));
      await until(() => expect(wire.inputs(), said()).toHaveLength(1));
      expect(wire.inputs()[0]).toMatchObject({threadId: 'old-native'});
      expect(wire.starts()).toHaveLength(0);
    }
    const opened=await rpc('open',{accountId});if(opened.kind!=='session')throw Error('open');
    const challenge=await rpc('beginLink',{session:opened.session});if(challenge.kind!=='challenge')throw Error('challenge');
    await throughBridgeChannel(await event('/recipe link '+challenge.code,'om_resource_link_'+peer.id),m=>o.onMessage(m));
    const seen=await rpc('inspectLink',{session:opened.session,challengeId:challenge.challengeId});if(seen.kind!=='link')throw Error('link');
    await rpc('confirmLink',{session:opened.session,challengeId:challenge.challengeId,evidence:seen.evidence});
    const found=await rpc('creatorDiscover',{accountId});if(found.kind!=='creatorBinding'||!found.association)throw Error('binding');
    const {binding,scope}=found.association;
    const openedCreator=await rpc('creatorOpen',{accountId,binding,scope,wakeId:null,resourceContext:true});
    if(openedCreator.kind!=='creatorSession')throw Error('creator');
    const session=openedCreator.session,requestId=randomUUID();
    const association={accountId,viewId:'local',deviceId:peer.device,deviceKey:Buffer.alloc(32,7).toString('base64url'),botId:agentIdSchema.parse(APP),binding,scope};
    const calls:string[]=[],postKeys:string[]=[];let acquired=false;
    const account={lease:()=>lease.signal,status:()=>({kind:'signedIn',accountId,displayName:'test',provider:'github',persistence:'memory'}),onStatus:()=>()=>{},
      request:async(id:string,path:string,init?:RequestInit,beforeSend?:()=>Promise<void>)=>{
        expect(id).toBe(accountId);expect(beforeSend).toBeTypeOf('function');await beforeSend!();calls.push(path);
        if(path.endsWith('/latest-install-version'))return Response.json({...later,revision:2,access:'direct',format:'role-v1',entitled:true,version:'2.0'});
        if(path.startsWith('/v2/recipes/')&&path.endsWith('/preview')){
          const second=path.includes(later.versionId);
          return Response.json({...second?later:target,revision:second?2:1,format:'role-v1',public:{...info,version:second?'2.0':'1.0'},
            creator:{authorId:recipeId,displayName:'配方作者'},state:'listed',owned:false,acquired:second?acquired:true,hasDisplayLogo:false,
            preview:{settings:[],skills:[],ruleCount:1,taskCount:0}});
        }
        if(path.startsWith('/v2/recipes/'))return Response.json({error:{code:'not_found'}},{status:404});
        if(path.endsWith('/acquire')){
          expect(init?.method).toBe('POST');postKeys.push(new Headers(init?.headers).get('idempotency-key')!);acquired=true;
          return Response.json({...later,owned:false,acquired:true});
        }
        const second=path.endsWith(later.versionId);
        return Response.json({...second?later:target,public:{...info,version:second?'2.0':'1.0'},config:{role:second?'VERSION-TWO-EXACT':'ROLE-ONLY-FROM-VERIFIED-SNAPSHOT'},revision:second?2:1,acquired:second?acquired:true,owned:false});
      }};
    const executor=new RecipeCreatorExecutor(account,new RecipeCreatorJournal(),new MetadataJournal(paths.appDir),history);
    const context={association,session,check:()=>lease.signal.throwIfAborted(),rpc:(r:Parameters<typeof service.request>[1])=>service.request(peer,r),
      settled:()=>{throw Error('resource should never use authoring draft settlement');}};
    const pump=async()=>{
      const reply=await rpc('creatorPoll',{session});if(reply.kind!=='creatorJobs')throw Error('poll');
      for(const job of reply.jobs)await executor.run(context,job);
    };
    const handoff=()=>rpc('resourceHandoff',{session,requestId,target});
    expect(await handoff()).toMatchObject({delivery:'pending'});
    await pump();expect(await handoff()).toMatchObject({delivery:'sent'});
    expect(guide).toHaveBeenCalledTimes(1);expect(dispatch).toHaveBeenCalledTimes(1);expect(run.turns).toHaveLength(0);
    const raw=await readFile(join(serviceRoot,'recipe-authoring','journal.json'),'utf8');
    expect(raw).not.toContain('ROLE-ONLY-FROM-VERIFIED-SNAPSHOT');
    expect(await service.onMessage(await event('借用别人的卡','om_resource_foreign','om_resource_guide',ADMIN))).toBe(true);
    if (wire) {
      fake.history = [{messageId: 'om_historical', senderId: OWNER, senderName: 'Owner', from: 'user', text: '历史记录里的领取请求', createTime: 5}];
      wire.failNextStart();
      await throughBridgeChannel(await event('使用这份配方', 'om_rejected_start', 'om_resource_guide'), m => o.onMessage(m));
      wire.releaseTurn();
      await until(() => expect(said()).toContain('fixture refused thread/start'));
      expect(await getSession(A)).toMatchObject({sessionId: 'old-native'});
      expect((await getSession(A))?.resourceToolSessionId).toBeUndefined();
      const run = async (text: string, id: string, requests: Parameters<typeof wire.scriptNext>[0], hold = false) => {
        const count = wire.answers().length;
        const release = wire.scriptNext(requests, hold);
        await throughBridgeChannel(await event(text, id, 'om_resource_guide'), m => o.onMessage(m));
        await until(() => expect(wire.answers()).toHaveLength(count + requests.length));
        return release;
      };
      const observed = vi.spyOn(service.resources, 'bind');
      const callsFrom: {query: string; caller?: import('../src/recipe/resource-context').ResourceCaller}[] = [];
      const resourceTool = service.resources.tool.bind(service.resources);
      vi.spyOn(service.resources, 'tool').mockImplementation((get, query) => {
        callsFrom.push({query: query.kind, caller: get()});
        return resourceTool(get, query);
      });
      await run('读取这份配方的目录', 'om_resource_read', [{tool: 'recipe_resource_read', args: {kind: 'index'}}]);
      expect(wire.inputs().at(-1)?.text).toContain('历史记录里的领取请求');
      expect(postKeys).toHaveLength(0);
      expect(wire.answers()[0]).toMatchObject({success: true, text: expect.stringContaining(target.versionId)});
      const firstCaller = observed.mock.calls.at(-1)?.[0];
      expect(firstCaller).toMatchObject({chatId: A, openId: OWNER, messageId: 'om_resource_read', sessionId: expect.any(String)});
      expect(callsFrom).toEqual([{query: 'index', caller: firstCaller}]);
      expect(await getSession(A)).toMatchObject({sessionId: 'th', resourceToolCatalog: {sessionId: 'th', version: 2}, earlier: ['old-native']});
      expect(wire.starts()).toHaveLength(2); // first failed, second accepted
      await o.shutdown();
      ({o} = await startProvider());
      const preparedCount=wire.answers().length;
      const finishPrepare=wire.scriptNext([
        {tool:'recipe_resource_prepare',args:{groupId:targetGroup}},
        {tool:'recipe_resource_read',args:{kind:'index',groupId:targetGroup}},
      ],true,{sequential:true});
      await throughBridgeChannel(await event('把已领取配方应用到所选群，准备后读取完整目录','om_prepare_full','om_resource_guide'),m=>o.onMessage(m));
      await until(async()=>{
        const jobs=await rpc('creatorPoll',{session});
        expect(jobs.kind==='creatorJobs'&&jobs.jobs.some(job=>job.task.kind==='resourceRead'&&job.task.groupId===targetGroup)).toBe(true);
      });
      expect(wire.answers()).toHaveLength(preparedCount);
      await pump();
      await until(()=>expect(wire.answers()).toHaveLength(preparedCount+2));
      expect(wire.answers()[preparedCount]).toMatchObject({success:true,text:expect.stringContaining('"status":"ready"')});
      const full=JSON.parse(wire.answers()[preparedCount+1]!.text);
      expect(full).toMatchObject({status:'ready',target,groupId:targetGroup});
      expect(full.page.entries.some((entry:{kind:string})=>entry.kind==='role')).toBe(true);
      finishPrepare();await settled();
      const endLatest = await run('查看新版', 'om_latest', [{tool: 'recipe_resource_read', args: {kind: 'latest'}}], true);
      await pump(); endLatest();
      const endAcquire = await run('本人要领取该新版', 'om_acquire', [
        {tool: 'recipe_resource_acquire', args: {versionId: later.versionId}, turnId: 'earlier-turn'},
        {tool: 'recipe_resource_acquire', args: {versionId: later.versionId}},
      ], true);
      expect(wire.answers().filter(answer => !answer.success)).toHaveLength(1);
      expect(wire.answers().filter(answer => answer.success && answer.text.includes('pending'))).toHaveLength(2);
      const currentCaller = observed.mock.calls.at(-1)?.[0];
      expect(currentCaller).toMatchObject({chatId: A, openId: OWNER, messageId: 'om_acquire'});
      expect(currentCaller?.sessionId).not.toBe(firstCaller?.sessionId);
      expect(callsFrom.filter(call => call.query === 'acquire')).toEqual([{query: 'acquire', caller: currentCaller}]);
      expect(wire.starts()).toHaveLength(2);
      expect(wire.resumes().at(-1)?.threadId).toBe('th');
      await pump(); endAcquire(); expect(postKeys).toHaveLength(1);
      return;
    }
    const natural=await event('参考刚刚选的版本，告诉我它的角色','om_resource_human','om_resource_guide');
    await throughBridgeChannel(natural,m=>o.onMessage(m));
    await until(()=>expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]?.text).toContain('recipe_resource_read');
    await throughBridgeChannel(natural,m=>o.onMessage(m));expect(run.consumed).toHaveLength(1);
    const opts=be.startThread.mock.calls[0][0] as StartThreadOptions;
    expect(startDynamicTools(opts).dynamicTools?.[0]?.tools.map(t=>t.name)).toContain('recipe_resource_acquire');
    const entry=opts.entry!;expect(entry.sessionId).not.toBe(run.t.sessionId);
    entry.noteToolUse('actual-resource-turn');
    const tool=async(name:string,args:unknown)=>{
      const result=await entry.call(name,args,{toolUseId:'actual-resource-turn'});
      if(!result.ok)throw Error(JSON.stringify(result));return result.result as Record<string,any>;
    };
    const count=calls.length;
    const list=await tool('recipe_resource_read',{kind:'index'});
    expect(list.page.entries.some((entry:{kind:string})=>entry.kind==='role')).toBe(false);
    const overview=list.page.entries.find((entry:{kind:string})=>entry.kind==='public');
    expect(await tool('recipe_resource_read',{kind:'text',documentId:overview.documentId})).toMatchObject({page:{text:expect.stringContaining(info.name)}});
    expect(calls.every(path=>!path.endsWith('/'+target.versionId)&&!path.endsWith('/'+later.versionId))).toBe(true);
    expect(calls).toHaveLength(count);
    expect(await tool('recipe_resource_read',{kind:'latest'})).toMatchObject({status:'pending'});await pump();
    expect(await tool('recipe_resource_read',{kind:'latest'})).toMatchObject({status:'newer',target:later});
    expect(await tool('recipe_resource_acquire',{versionId:later.versionId})).toMatchObject({status:'pending'});
    run.turns[0]!.resolve();await settled();
    await pump();expect(postKeys).toHaveLength(1);
    expect(await entry.call('recipe_resource_acquire',{versionId:later.versionId},{toolUseId:'actual-resource-turn'})).toMatchObject({ok:false});
    await throughBridgeChannel(await event('现在读取得的新版','om_resource_second'),m=>o.onMessage(m));
    await until(()=>expect(run.consumed).toHaveLength(2));
    entry.noteToolUse('second-resource-turn');
    const read=(q:object)=>entry.call('recipe_resource_read',q,{toolUseId:'second-resource-turn'});
    expect(await read({kind:'index'})).toMatchObject({ok:true,result:{status:'pending'}});await pump();
    const newer=await read({kind:'index'});expect(newer).toMatchObject({ok:true,result:{status:'ready',target:later}});
    expect(postKeys).toHaveLength(1);run.turns[1]!.resolve();
  }finally{
    for(const t of run.turns)t.resolve();
    if(wire){wire.releaseTurn();await o.shutdown();await closeCodexToolFixtures();}
    service.close();history.history.close();
  }
});
