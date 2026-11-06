import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { saveConfig } from '../src/config/store';
import { type AgentEvent, type AgentInput, type StartThreadOptions } from '../src/agent/types';
import type { JudgeRequest, JudgeResult } from '../src/judge/types';
import { DEFAULT_DM_SMART_RULES } from '@vonvon/protocol';
import { setDiagnosticsSink } from '../src/bot/diagnostics';
import { paths } from '../src/config/paths';
import { dmChatId, dmProject, mutateProjectByChatId } from '../src/project/registry';
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import { seedBots } from './helpers/bot-fixture';

// A private chat is judged like a colleague would (owner 2026-11-06): every message is looked at, not every one answered.
// Through the real orchestrator, session store and project registry on a temp dir; judge, backend, Feishu and cards are faked.

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-smart-')));
  // Every other file the bot opens at start lands in the temp dir too.
  const inside = <T extends object>(known: T) => new Proxy(known, { get: (target, key) => key in target ? target[key as keyof T] : join(appDir, String(key)) });
  return { paths: inside({ appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects'), commentInstructionsFile: join(appDir, 'instructions.md') }),
    botPaths: () => inside({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fake = vi.hoisted(() => ({
  backend: undefined as any, n: 0,
  cards: [] as { id: string; chatId: string; json: string }[],
  judge: vi.fn(),
}));
vi.mock('../src/judge/judge', async original => ({ ...await original<object>(), createJudge: () => ({ judge: fake.judge, warm: () => {}, shutdown: async () => {} }) }));
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

const BE = 'codex-appserver';
const APP = 'cli_fixture';
const bot = { appId: APP, tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
const A = 'oc_p2p_a';
const OWNER = 'ou_owner', ADMIN = 'ou_admin';

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
const listed = vi.fn(async (..._args: unknown[]): Promise<{ data: { items: unknown[]; has_more: boolean } }> => ({ data: { items: [], has_more: false } }));
const reacted = vi.fn(async (_call: { path: { message_id: string }; data: { reaction_type: { emoji_type: string } } }) => ({ data: { reaction_id: 'r' } }));
const channel = { send, rawClient: { im: { v1: {
  message: { get: async () => ({ data: { items: [{}] } }), list: listed },
  messageReaction: { create: reacted, delete: async () => ({}) },
} } } };
/** The quiet wait of a real private chat is 1.5 seconds; the order of things is what these tests are about. */
const time = { now: () => Date.now(), setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms === 1500 ? 40 : ms), clearTimer: (handle: unknown) => clearTimeout(handle as NodeJS.Timeout) };
let cfg: AppConfig;
let opened: ReturnType<typeof createOrchestrator>[] = [];
async function app(mode: 'smart' | 'single' = 'smart') {
  await saveConfig(cfg);
  const entries: AgentEntries = createAgentEntries({ appId: APP, isAdmin: id => (cfg.preferences?.access?.admins ?? []).includes(id), tools: [], sessions: { revoke() {} } });
  const o = createOrchestrator(channel as never, cfg, paths.appDir, undefined, { entries, bot, time });
  opened.push(o); await o.initialize?.();
  await until(async () => expect(await dmProject()).toBeDefined());
  if (mode === 'single') await mutateProjectByChatId(dmChatId(APP), project => { project.smart = false; });
  return o;
}
function message(text: string, more: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `om_msg_${++fake.n}`, chatId: A, chatType: 'p2p', content: text, senderId: OWNER, senderName: 'Owner', mentionedBot: false, createTime: Date.now(),
    rawContentType: 'text', resources: [], mentions: [], mentionAll: false, raw: { sender: { sender_type: 'user' } }, ...more } as NormalizedMessage;
}
const until = (check: () => unknown) => vi.waitFor(check, { interval: 5, timeout: 4000 });
/** Long enough for a judgement that was going to start to have started, and for its landing. */
const settled = () => new Promise<void>(resolve => setTimeout(resolve, 200));
const result = (decision: JudgeResult['decision'], extra: Partial<JudgeResult> = {}): JudgeResult => ({ decision, reason: '', backend: BE, model: 'fixture', modelSource: 'default', promptSource: 'default', ms: 1, ...extra });
const judged = () => fake.judge.mock.calls.map(([request]) => request as JudgeRequest);
const emoji = (messageId: string) => reacted.mock.calls.filter(([call]) => call.path.message_id === messageId).map(([call]) => call.data.reaction_type.emoji_type);
const said = () => JSON.stringify(send.mock.calls);
const text = (input: AgentInput | undefined) => JSON.stringify(input);

beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true });
  cfg = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: OWNER, admins: [OWNER, ADMIN] }, completionReminder: { mode: 'manual' }, pendingPolicy: 'queue' } } as AppConfig;
  fake.cards = []; send.mockClear(); reacted.mockClear(); listed.mockClear(); fake.judge.mockReset().mockResolvedValue(result('main'));
  backend(thread());
});
afterEach(async () => { setDiagnosticsSink(undefined); for (const o of opened) await o.shutdown(); opened = []; });
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

describe('every message is looked at', () => {
  it('a new Bot\'s private chat is smart, with no @ needed', async () => {
    await app();
    expect(await dmProject()).toMatchObject({ kind: 'single', smart: true, noMention: true });
  });

  it('judges a message by the private chat\'s own rules, then answers it', async () => {
    const run = thread(); backend(run); const o = await app();
    await o.onMessage(message('帮我看看这个群'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(judged()).toHaveLength(1);
    const request = judged()[0]!;
    expect(request.variant).toBe('dm');
    expect(request.group?.smartRules).toEqual(DEFAULT_DM_SMART_RULES);
    expect(request.group?.name).toBe('和 Owner 的私聊');
    expect(request.why).toBe('这是私聊，这句话是对你说的');
    expect(request.facts).toBeUndefined();
    expect(text(run.consumed[0])).toContain('帮我看看这个群');
    run.turns[0]!.resolve();
  });

  it('a person\'s own rules replace the default', async () => {
    const o = await app();
    await mutateProjectByChatId(dmChatId(APP), project => { project.smartRules = { respond: '都回', newTopic: '' }; });
    await o.onMessage(message('在吗'));
    await until(() => expect(judged()).toHaveLength(1));
    expect(judged()[0]!.group?.smartRules).toEqual({ respond: '都回', newTopic: '' });
  });

  it('leaves a reaction on what needs no answer, and starts nothing', async () => {
    fake.judge.mockResolvedValue(result('skip', { reason: '收尾' }));
    const run = thread(), be = backend(run); const o = await app();
    const closing = message('好的');
    await o.onMessage(closing);
    await until(() => expect(emoji(closing.messageId)).toContain('OK'));
    await settled();
    expect(be.startThread).not.toHaveBeenCalled();
    expect(run.consumed).toEqual([]);
    expect(said()).not.toContain('好的');
  });

  it('the waiting reaction goes once it has been judged', async () => {
    const del = vi.spyOn(channel.rawClient.im.v1.messageReaction, 'delete');
    fake.judge.mockResolvedValue(result('skip'));
    const o = await app();
    const closing = message('收到');
    await o.onMessage(closing);
    await until(() => expect(emoji(closing.messageId)).toEqual(['THINKING', 'OK']));
    await until(() => expect(del).toHaveBeenCalled());
    del.mockRestore();
  });

  it.each(['timeout', 'quota'] as const)('a judge that fails (%s) answers instead of going silent', async kind => {
    fake.judge.mockResolvedValue(result('skip', { error: { kind } }));
    const run = thread(); backend(run); const o = await app();
    const asked = message('帮我查下');
    await o.onMessage(asked);
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(emoji(asked.messageId)).not.toContain('OK');
    run.turns[0]!.resolve();
  });

  it('says nothing for a judgement the person recalled, and leaves no OK', async () => {
    const gate = deferred<JudgeResult>(); fake.judge.mockReturnValue(gate.promise);
    const run = thread(); backend(run); const o = await app();
    const gone = message('发错了');
    await o.onMessage(gone);
    await until(() => expect(judged()).toHaveLength(1));
    await o.onRecall({ messageId: gone.messageId, chatId: A });
    gate.resolve(result('skip'));
    await settled();
    expect(emoji(gone.messageId)).not.toContain('OK');
    expect(run.consumed).toEqual([]);
  });

  it('feeds neither the 此刻 page\'s decisions nor attention', async () => {
    const events: { kind: string; groups?: unknown[] }[] = [];
    setDiagnosticsSink(event => { events.push(event as { kind: string; groups?: unknown[] }); });
    fake.judge.mockResolvedValue(result('skip', { reason: '收尾' }));
    const o = await app();
    const closing = message('好的');
    await o.onMessage(closing);
    await until(() => expect(emoji(closing.messageId)).toContain('OK'));
    await settled();
    expect(events.filter(event => event.kind === 'decision' || event.groups?.length)).toEqual([]);
  });

  it('a topic in a private chat is judged as a topic', async () => {
    const run = thread(); backend(run); const o = await app();
    await o.onMessage(message('接着说', { threadId: 'omt_dm' }));
    await until(() => expect(judged()).toHaveLength(1));
    expect(judged()[0]!.variant).toBe('topic');
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
  });
});

describe('a person still typing', () => {
  it('judges only the newest of a burst, and the earlier ones reach the judge and the turn', async () => {
    const run = thread(); backend(run); const o = await app();
    const first = message('帮我查一下', { createTime: Date.now() - 5000 });
    listed.mockResolvedValue({ data: { items: [{ message_id: first.messageId, msg_type: 'text', create_time: String(first.createTime), sender: { id: OWNER, sender_type: 'user', sender_name: 'Owner' }, body: { content: JSON.stringify({ text: first.content }) } }], has_more: false } });
    await o.onMessage(first);
    await o.onMessage(message('昨天的那个报错'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await settled();
    expect(judged()).toHaveLength(1);
    const seen = JSON.stringify(judged()[0]);
    expect(seen).toContain('帮我查一下'); expect(seen).toContain('昨天的那个报错');
    expect(text(run.consumed[0])).toContain('帮我查一下'); expect(text(run.consumed[0])).toContain('昨天的那个报错');
    expect(run.consumed).toHaveLength(1);
    run.turns[0]!.resolve();
  });

  it('shows the judge the question a closing word followed, so the word cannot drop it', async () => {
    const o = await app();
    const asked = message('帮我查下昨天的报错', { createTime: Date.now() - 5000 });
    await o.onMessage(asked);
    await o.onMessage(message('谢谢'));
    await until(() => expect(judged()).toHaveLength(1));
    expect(judged()[0]!.context.find(line => line.id === asked.messageId)).toMatchObject({ fresh: true });
  });

  it('a recalled newest message does not take the earlier one with it', async () => {
    const run = thread(); backend(run); const o = await app();
    const first = message('帮我查一下'), last = message('打错了');
    await o.onMessage(first);
    await o.onMessage(last);
    await o.onRecall({ messageId: last.messageId, chatId: A });
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(text(run.consumed[0])).toContain('帮我查一下');
    run.turns[0]!.resolve();
  });

  it('a file is never folded into the words after it', async () => {
    const file = message('[图片]', { rawContentType: 'image', resources: [{ type: 'image', fileKey: 'img_fixture' }] as never });
    const words = message('看下这张');
    const run = thread(); backend(run); const o = await app();
    await o.onMessage(file);
    await o.onMessage(words);
    await until(() => expect(judged().map(request => request.message.id)).toEqual(expect.arrayContaining([file.messageId, words.messageId])));
    run.turns[0]?.resolve();
  });
});

describe('what the judge never sees', () => {
  it('a slash command goes straight through', async () => {
    const o = await app();
    await o.onMessage(message('/menu'));
    await until(() => expect(fake.cards.length + send.mock.calls.length).toBeGreaterThan(0));
    expect(judged()).toEqual([]);
  });

  it('单会话 answers every message without a judge', async () => {
    const run = thread(); backend(run); const o = await app('single');
    await o.onMessage(message('好的'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(judged()).toEqual([]);
    run.turns[0]!.resolve();
  });
});

describe('who it answers', () => {
  it('someone removed from the admins while it judged gets no turn', async () => {
    const gate = deferred<JudgeResult>(); fake.judge.mockReturnValue(gate.promise);
    const run = thread(); backend(run); const o = await app();
    await o.onMessage(message('帮我改下设置', { senderId: ADMIN }));
    await until(() => expect(judged()).toHaveLength(1));
    cfg.preferences!.access!.admins = [OWNER];
    gate.resolve(result('main'));
    await settled();
    expect(run.consumed).toEqual([]);
  });
});
