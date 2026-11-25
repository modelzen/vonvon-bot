import { FocusEverywhere } from './helpers/focus-everywhere';
import { Attention } from '../src/bot/attention';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAgentEntries } from '../src/agent/entry/registry';
import { Client, withTenantToken, type NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { projectRevision } from '../src/admin/collaboration';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { ROSTER_TTL_MS } from '../src/bot/bot-roster';
import { PEOPLE_RETRY_MS, PEOPLE_TTL_MS } from '../src/bot/chat-people';
import { wakeTriggerText } from '../src/bot/context-weave';
import { AT_HINT_NOTE, BOT_WAKE_NOTE, INITIATIVE_NOTE } from '../src/bot/session-title';
import { JUDGE_BUDGET, JudgeBudget } from '../src/bot/smart-intake';
import type { AgentBackend, JudgeCall } from '../src/agent/types';
import type { JudgeDeps } from '../src/judge/judge';
import { localDay } from '../src/judge/usage';
import type { JudgeRequest, JudgeResult } from '../src/judge/types';
import { throughBridgeChannel, receive, type EventMessage, type ReceiveOpts } from './helpers/lark-events';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'smart-inbound-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'smart-inbound-'));
  return { botPaths: (appId: string) => ({ dir: join(appDir, 'bots', appId), configFile: join(appDir, 'bots', appId, 'config.json') }), paths: { appDir, inboundDir: join(appDir, 'inbound'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments'), botsFile: join(appDir, 'bots.json') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  sessions: {} as Record<string, unknown>,
  projectLookup: vi.fn(),
  projectReads: vi.fn(),
  sessionReads: vi.fn(),
  readHistory: vi.fn(),
  projectRead: undefined as Promise<void> | undefined,
  fullOnly: false,
  /** Holds every session read while set: an intake parked on the disk. */
  hold: undefined as Promise<void> | undefined,
  send: vi.fn(async () => ({ messageId: 'om_sent' })),
  cardCreate: vi.fn(async () => ({ code: 0, data: { card_id: 'card_help' } })),
  get: vi.fn(async (_req: { path: { message_id: string } }) =>
    ({ code: 0, data: { items: [{ thread_id: 'omt_opened' }] as Array<Record<string, unknown>> } })),
  list: vi.fn(),
  request: vi.fn(),
  members: vi.fn(),
  reply: vi.fn(async (_req: { path: { message_id: string }; data: { msg_type: string; content: string; reply_in_thread?: boolean } }): ReturnType<Client['im']['v1']['message']['reply']> => ({ code: 0, data: { message_id: 'om_reminder' } })),
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
  finalOk: true,
  finalGate: undefined as Promise<void> | undefined,
  liveCards: [] as { id: number; card: unknown }[],
  bots: '1',
  judge: vi.fn(),
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({
    text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true },
  })),
  judgeDeps: undefined as JudgeDeps | undefined,
  judgeShutdown: vi.fn(async () => {}),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
const startThread = vi.fn(async () => ({
  sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
  // Native Codex context is separate from the message/wake envelope asserted below.
  injectContext: async (_text: string) => {},
  runGoal: () => ({ events: fake.events?.() ?? (async function* () {})() }),
  clearGoal: async () => {},
  runStreamed: (input: { text: string }) => {
    fake.inputs.push(input.text);
    return { turnId: () => 'turn-fixture', events: fake.events?.() ?? (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })() };
  },
}));

vi.mock('../src/bot/context-weave', async original => {
  const real = await original<typeof import('../src/bot/context-weave')>();
  return { ...real, wakeTriggerText: vi.fn(real.wakeTriggerText) };
});

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => { await fake.projectReads(); await fake.projectRead; return fake.project; }, getProjectByName: async () => { await fake.projectLookup(); return fake.project; } }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], listThreads: async () => [{ sessionId: 'past' }], readHistory: fake.readHistory, startThread, fullAccessOnly: () => fake.fullOnly }) }));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async (key: string) => { await fake.sessionReads(key); await fake.hold; return fake.sessions[key]; }, upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/voice/inbound', async original => ({ ...await original<object>(), ingestVoice: fake.voice }));
vi.mock('../src/judge/judge', async original => ({
  ...await original<object>(),
  createJudge: (deps: JudgeDeps) => { fake.judgeDeps = deps; return { judge: fake.judge, warm: () => {}, shutdown: () => fake.judgeShutdown() }; },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    private id = 0;
    async create(...args: unknown[]) { fake.cards.push(args); this.id = fake.cards.length; return `card_${this.id}`; }
    streamCoalesced(_channel: unknown, card: unknown) { fake.liveCards.push({ id: this.id, card }); }
    async updateCard(_channel: unknown, card: unknown) { fake.liveCards.push({ id: this.id, card }); return true; }
    async finalizeCard(_channel: unknown, card: unknown) { fake.finals.push(card); await fake.finalGate; return fake.finalOk; }
    getCardId() { return 'card'; }
    async drain() {}
    async settleImages() { return new Map(); }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => true }); }
  },
}));

import { createOrchestrator } from '../src/bot/handle-message';
import { createTopicRegistry } from '../src/bot/topic-registry';
import * as sessionStore from '../src/bot/session-store';

const BOT = { openId: 'ou_bot', name: '小码' };
const APP = 'cli_fixture';
const CHAT = 'oc_demo';
const base = { name: 'demo', chatId: CHAT, cwd: workspace, kind: 'single', smart: true, mode: 'full', network: false };
const cfg: AppConfig & { preferences: NonNullable<AppConfig["preferences"]> } = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] }, completionReminder: { mode: 'manual' } } };
const channel = {
  send: fake.send, botIdentity: BOT,
  rawClient: { appId: APP, request: fake.request, cardkit: { v1: { card: { create: fake.cardCreate } } }, im: { v1: {
    chatMembers: { get: fake.members },
    messageReaction: { create: fake.react, delete: fake.unreact },
    message: { reply: fake.reply, get: fake.get, list: fake.list, delete: fake.del },
    // The group's only bot unless a test says otherwise.
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', bot_count: fake.bots } }) },
  } } },
};

let sequence = 0;
let clock = Date.now();
/** A group message from the owner: `at` @-mentions this bot, `thread` puts it in a topic. */
function says(text: string, o: { at?: boolean; thread?: string; all?: boolean; mentionOther?: { openId: string; name: string }; parent?: string; root?: string } = {}): EventMessage {
  const id = `om_smart_${++sequence}`;
  const time = String(clock += 1000);
  return {
    message_id: id, create_time: time, update_time: time, chat_id: CHAT, chat_type: 'group', message_type: 'text',
    content: JSON.stringify({ text: o.at ? `@_user_1 ${text}` : o.all ? `@_all ${text}` : o.mentionOther ? `@_user_2 ${text}` : text }),
    ...(o.at ? { mentions: [{ key: '@_user_1', id: { open_id: BOT.openId, union_id: 'on_bot' }, name: BOT.name, tenant_key: 't' }] } : {}),
    ...(o.all ? { mentions: [{ key: '@_all', id: { open_id: 'all' }, name: '所有人' }] } : {}),
    ...(o.mentionOther ? { mentions: [{ key: '@_user_2', id: { open_id: o.mentionOther.openId }, name: o.mentionOther.name }] } : {}),
    ...(o.thread ? { thread_id: o.thread, root_id: 'om_root', parent_id: 'om_root' } : {}),
    ...(o.parent ? { parent_id: o.parent } : {}), ...(o.root ? { root_id: o.root } : {}),
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
/** Real file reads and writes take as long as the machine likes, so ticks alone cannot say the work has landed. */
const fileWork = (): boolean => process.getActiveResourcesInfo().some(name => name.startsWith('FSReq'));
const settle = async (): Promise<void> => {
  for (let round = 0; round < 500; round++) {
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
    if (!fileWork()) return;
  }
};

let orchestrator: ReturnType<typeof createOrchestrator>;
let events: DiagnosticsEvent[] = [];
const records = () => events.flatMap((event) => event.kind === 'notReplied' ? [event.record] : []);
const homeDecisions = () => events.flatMap(event => event.kind === 'decision' ? [event.decision] : []);
const latestActions = () => events.flatMap(event => event.kind === 'latestAction' ? [event.action] : []);
const send = async (m: EventMessage, sender?: ReceiveOpts['sender']) => orchestrator.onMessage(await receive(m, { bot: BOT, ...(sender ? { sender } : {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  asked.clear();
  fake.judgeShutdown.mockImplementation(async () => {});
  fake.voice.mockReset().mockImplementation(async (_channel, msg) => ({
    text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true },
  }));
  events = [];
  fake.inputs = [];
  fake.sessions = {};
  fake.fullOnly = false;
  fake.hold = undefined;
  fake.project = { ...base };
  fake.projectLookup.mockReset();
  fake.projectReads.mockReset();
  fake.sessionReads.mockReset();
  fake.readHistory.mockReset();
  fake.projectRead = undefined;
  fake.list.mockImplementation(async () => ({ code: 0, data: { items: [], has_more: false } }));
  fake.get.mockImplementation(async () => ({ code: 0, data: { items: [{ thread_id: 'omt_opened' }] } }));
  fake.del.mockImplementation(async () => ({ code: 0 }));
  fake.events = undefined;
  fake.cards = [];
  fake.finals = [];
  fake.finalOk = true;
  fake.finalGate = undefined;
  fake.reply.mockReset();
  fake.reply.mockResolvedValue({ code: 0, data: { message_id: 'om_reminder' } });
  fake.liveCards = [];
  fake.bots = '1';
  cfg.preferences.completionReminder = { mode: 'manual' };
  delete cfg.preferences.runIdleTimeoutSeconds;
  fake.members.mockReset();
  fake.members.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
  fake.request.mockImplementation(async () => ({ code: 0, data: { bots: [{ app_id: 'cli_other', member_id: 'ou_other', name: '小P' }] } }));
  fake.judge.mockImplementation((req: JudgeRequest) => {
    const answer = deferred<JudgeResult>();
    asked.set(req.ref!, { req, answer });
    const abort = () => answer.resolve(result('skip', { error: { kind: 'aborted' } }));
    if (req.signal?.aborted) abort(); else req.signal?.addEventListener('abort', abort);
    return answer.promise;
  });
  setDiagnosticsSink((event) => events.push(event));
  orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { attention: new FocusEverywhere() });
});
afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

describe('voice uses the text intake path', () => {
  const audio = (options: Parameters<typeof says>[1] = {}): EventMessage => ({
    ...says('', options), message_type: 'audio', content: JSON.stringify({ file_key: 'voice_fixture', duration: 3000 }),
  });
  const transcript = (m: EventMessage, text: string) => ({
    text, voice: { messageId: idOf(m), text, transcribed: true },
  });
  const panels = (card: unknown) => (card as { body: { elements: Array<{ element_id?: string; elements?: Array<{ text: { content: string } }> }> } })
    .body.elements.filter(element => element.element_id?.startsWith('voice_')).map(element => element.elements?.[0]?.text.content);

  it('judges the words and spoken name, then reuses the same transcript for execution and reply cards', async () => {
    const m = audio();
    const text = '小码，帮忙看一下登录接口的错误';
    fake.voice.mockResolvedValueOnce(transcript(m, text));
    await send(m);
    const { req } = await judged(m);
    expect(req.message.text).toBe(text);
    expect(req.why).toBe('真人叫了你的完整名字');
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'salience', expect.objectContaining({ kind: 'name' }));
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]).toContain(text);
    expect(fake.inputs[0]).not.toContain('[语音]');
    expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
    expect(panels(fake.cards[0]![2])).toEqual([text]);
    expect(panels(fake.finals[0])).toEqual([text]);
    await send(m);
    expect(fake.voice).toHaveBeenCalledOnce();
    expect(fake.inputs).toHaveLength(1);
  });

  it('keeps a skipped voice transcript in the next judgement and in history fetched for execution', async () => {
    const first = audio();
    const text = '部署之后登录接口一直返回 500';
    fake.voice.mockResolvedValueOnce(transcript(first, text));
    await send(first);
    await decide(first, result('skip'));
    await vi.waitFor(() => expect(records().map(record => record.reason)).toContain('judge-skip'));
    // Feishu still returns an audio attachment. The locally known transcript must win.
    fake.list.mockResolvedValue({ code: 0, data: { items: [{
      message_id: idOf(first), create_time: first.create_time, msg_type: 'audio', body: { content: first.content },
      sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' },
    }], has_more: false } });
    const next = says('小码，刚才说的故障请帮忙查一下');
    await send(next);
    expect((await judged(next)).req.context).toContainEqual(expect.objectContaining({ id: idOf(first), text }));
    await decide(next, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain(text);
    expect(fake.inputs[0]).not.toContain('[语音]');
    expect(fake.voice).toHaveBeenCalledOnce();
  });

  it('routes a transcribed /help through the same command handler as typed text', async () => {
    const m = audio();
    fake.voice.mockResolvedValueOnce(transcript(m, '/help'));
    await send(m);
    await vi.waitFor(() => expect(fake.cardCreate).toHaveBeenCalledOnce());
    await send(says('/help'));
    expect(fake.cardCreate).toHaveBeenCalledTimes(2);
    expect(fake.cardCreate.mock.calls[0]).toEqual(fake.cardCreate.mock.calls[1]);
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
    expect(fake.voice).toHaveBeenCalledOnce();
  });

  it('recognizes unmentioned commands in a no-mention multi group without turning ordinary voice into a topic', async () => {
    fake.project = { ...base, kind: 'multi', smart: false, noMention: true };
    const command = audio();
    fake.voice.mockResolvedValueOnce(transcript(command, '/help'));
    await send(command);
    await vi.waitFor(() => expect(fake.cardCreate).toHaveBeenCalledOnce());
    expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: idOf(command) } }));
    const chatter = audio();
    fake.voice.mockResolvedValueOnce(transcript(chatter, '只是和群友聊几句'));
    await send(chatter);
    await vi.waitFor(() => expect(fake.voice).toHaveBeenCalledTimes(2));
    await settle();
    expect(fake.cardCreate).toHaveBeenCalledOnce();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
    expect(fake.cards).toEqual([]);
  });

  it('does not transcribe an unmentioned main-area voice when the rule group requires mentions', async () => {
    fake.project = { ...base, kind: 'multi', smart: false, noMention: false };
    const m = audio();
    fake.voice.mockResolvedValueOnce(transcript(m, '/help'));
    await send(m);
    await settle();
    expect(fake.voice).not.toHaveBeenCalled();
    expect(fake.cardCreate).not.toHaveBeenCalled();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
  });

  it('rejects voice in another bot\'s rule-mode topic before transcription, just like text', async () => {
    fake.project = { ...base, kind: 'multi', smart: false, noMention: true };
    fake.bots = '2';
    fake.list.mockResolvedValue({ code: 0, data: { items: [{
      message_id: 'om_other_bot_reply', create_time: String(Date.now() - 1000), msg_type: 'text',
      body: { content: JSON.stringify({ text: '另一个 bot 的回复' }) },
      sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other' },
    }], has_more: false } });
    const thread = 'omt_other_bot_topic';
    const rejected = () => fake.log.info.mock.calls.filter(([, event, fields]) => event === 'audience'
      && fields?.to === 'other' && fields.by === 'topic');
    await send(audio({ thread }));
    await vi.waitFor(() => expect(rejected()).toHaveLength(1));
    await send(says('文字也属于另一个 bot', { thread }));
    expect(rejected()).toHaveLength(2);
    expect(fake.voice).not.toHaveBeenCalled();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
    expect(fake.cards).toEqual([]);
  });

  it('keeps a failed transcription as audio and reuses its explicit fallback without transcribing again', async () => {
    const m = audio({ at: true });
    const failure = '语音消息（未转写）：识别服务暂不可用\n原音频附件："/fixture/voice.ogg"';
    const notice = '语音未转写，已将原音频交给 agent。';
    fake.voice.mockResolvedValueOnce({ text: failure, voice: { messageId: idOf(m), text: notice, transcribed: false } });
    await send(m);
    expect((await judged(m)).req.message.text).toBe('[语音]');
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
    expect(fake.inputs).toHaveLength(1);
    expect(fake.inputs[0]).toContain(failure);
    expect(JSON.stringify(fake.finals[0])).toContain(notice);
    expect(fake.voice).toHaveBeenCalledOnce();
  });

  it('uses the known transcript when a later text quotes the original audio message', async () => {
    const first = audio();
    const text = '引用里的语音原文';
    fake.voice.mockResolvedValueOnce(transcript(first, text));
    await send(first);
    await decide(first, result('skip'));
    await vi.waitFor(() => expect(records().map(record => record.reason)).toContain('judge-skip'));
    fake.get.mockResolvedValue({ code: 0, data: { items: [{
      message_id: idOf(first), create_time: first.create_time, msg_type: 'audio', body: { content: first.content },
      sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' },
    }] } });
    const next = says('帮我处理这条', { at: true, parent: idOf(first) });
    await send(next);
    expect((await judged(next)).req.message.quote?.text).toBe(text);
    await decide(next, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain(text);
    expect(fake.inputs[0]).not.toContain('[语音]');
    expect(fake.get).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: idOf(first) } }));
    expect(fake.voice).toHaveBeenCalledOnce();
  });

  it.each(['denied', 'disabled', 'unbound', 'bot'] as const)('does not transcribe %s voice messages', async kind => {
    if (kind === 'denied') fake.project = { ...base, allowedUsers: ['ou_allowed'] };
    if (kind === 'disabled') fake.project = { ...base, enabled: false };
    if (kind === 'unbound') fake.project = undefined;
    await send(audio(), kind === 'bot' ? { openId: 'ou_other_bot', type: 'app' }
      : kind === 'denied' ? { openId: 'ou_denied' } : undefined);
    await settle();
    expect(fake.voice).not.toHaveBeenCalled();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
  });

  it('holds following text behind slow voice while another topic progresses', async () => {
    const m = audio();
    const gate = deferred<ReturnType<typeof transcript>>();
    fake.voice.mockReturnValueOnce(gate.promise);
    try {
      await send(m);
      await vi.waitFor(() => expect(fake.voice).toHaveBeenCalledOnce());
      const next = says('后面的文字');
      await send(next);
      const sibling = says('另一个话题的文字', { at: true, thread: 'omt_voice_sibling' });
      await send(sibling);
      await decide(sibling, result('skip'));
      expect(asked.has(idOf(m))).toBe(false);
      expect(asked.has(idOf(next))).toBe(false);
      gate.resolve(transcript(m, '先发出的语音'));
      await decide(m, result('skip'));
      const { req } = await judged(next);
      expect(req.context).toContainEqual(expect.objectContaining({ id: idOf(m), text: '先发出的语音' }));
      await decide(next, result('skip'));
      expect(fake.voice).toHaveBeenCalledOnce();
    } finally { gate.resolve(transcript(m, '先发出的语音')); }
  });

  it('discards a voice recalled during transcription and releases its following text', async () => {
    const m = audio();
    const gate = deferred<ReturnType<typeof transcript>>();
    fake.voice.mockReturnValueOnce(gate.promise);
    try {
      await send(m);
      await vi.waitFor(() => expect(fake.voice).toHaveBeenCalledOnce());
      const next = says('新的问题');
      await send(next);
      await orchestrator.onRecall({ messageId: idOf(m), chatId: CHAT });
      gate.resolve(transcript(m, '已撤回的语音内容'));
      const { req } = await judged(next);
      expect(asked.has(idOf(m))).toBe(false);
      expect(req.context.some(line => line.id === idOf(m))).toBe(false);
      await decide(next, result('skip'));
      expect(fake.inputs).toEqual([]);
      expect(fake.cards).toEqual([]);
    } finally { gate.resolve(transcript(m, '已撤回的语音内容')); }
  });

  it('shuts down without waiting for pending recognition and ignores its late result', async () => {
    const m = audio();
    const gate = deferred<ReturnType<typeof transcript>>();
    fake.voice.mockReturnValueOnce(gate.promise);
    try {
      await send(m);
      await vi.waitFor(() => expect(fake.voice).toHaveBeenCalledOnce());
      let stopped = false;
      const shutdown = orchestrator.shutdown().then(() => { stopped = true; });
      await vi.waitFor(() => expect(stopped).toBe(true));
      gate.resolve(transcript(m, '关闭以后才转写完成'));
      await shutdown;
      await settle();
      expect(fake.judge).not.toHaveBeenCalled();
      expect(fake.inputs).toEqual([]);
      expect(fake.cards).toEqual([]);
    } finally { gate.resolve(transcript(m, '关闭以后才转写完成')); }
  });
});

describe('smart rules from group settings', () => {
  // Exercise the real intake -> judge -> provider boundary. Only the model and legacy file read are fixtures.
  async function useRealJudge(source: 'group' | 'bot' | 'default' = 'bot', decision: 'main' | 'skip' = 'skip') {
    const { createJudge } = await vi.importActual<typeof import('../src/judge/judge')>('../src/judge/judge');
    const calls: JudgeCall[] = [];
    const results: JudgeResult[] = [];
    const readPrompt = vi.fn(async () => ({ source, text: 'LEGACY_SMART_PROMPT', path: '/fixture/SMART.md' }));
    const backend = {
      id: 'codex-appserver', displayName: 'Codex', listModels: async () => [],
      judge: async (call: JudgeCall) => { calls.push(call); return { text: JSON.stringify({ decision, reason: '' }) }; },
    } as unknown as AgentBackend;
    const judge = createJudge({ backendFor: () => backend, readPrompt, cwd: async () => workspace });
    fake.judge.mockImplementation(async (request: JudgeRequest) => {
      const result = await judge.judge(request);
      results.push(result);
      return result;
    });
    fake.judgeShutdown.mockImplementation(() => judge.shutdown());
    return { calls, results, readPrompt };
  }

  it('sends both saved group rules to the model ahead of legacy prompts and executes a reply decision', async () => {
    fake.project = { ...base, smartRules: { respond: '遇到需要协助的技术问题就回复', newTopic: '独立的问题创建新话题' } };
    const judge = await useRealJudge('bot', 'main');
    await send(says('登录接口报错，请帮忙看一下'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(judge.results).toEqual([expect.objectContaining({ decision: 'main', promptSource: 'group' })]);
    expect(judge.calls[0]!.system).toContain('遇到需要协助的技术问题就回复');
    expect(judge.calls[0]!.system).toContain('独立的问题创建新话题');
    expect(judge.calls[0]!.system).not.toContain('LEGACY_SMART_PROMPT');
    expect(judge.readPrompt).not.toHaveBeenCalled();
    expect(fake.inputs[0]).toContain('登录接口报错，请帮忙看一下');
  });

  it('uses edited group rules on the next incoming message without restarting the bot', async () => {
    fake.project = { ...base, smartRules: { respond: '仅关注部署问题', newTopic: '部署故障单开话题' } };
    const judge = await useRealJudge();
    await send(says('第一条消息'));
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    fake.project = { ...base, smartRules: { respond: '也关注测试问题', newTopic: '测试失败单开话题' } };
    await send(says('第二条消息'));
    await vi.waitFor(() => expect(records()).toHaveLength(2));
    expect(judge.calls).toHaveLength(2);
    expect(judge.calls[0]!.system).toContain('仅关注部署问题');
    expect(judge.calls[0]!.system).toContain('部署故障单开话题');
    expect(judge.calls[1]!.system).toContain('也关注测试问题');
    expect(judge.calls[1]!.system).toContain('测试失败单开话题');
    expect(judge.calls[1]!.system).not.toContain('仅关注部署问题');
    expect(judge.readPrompt).not.toHaveBeenCalled();
  });

  it.each(['group', 'bot', 'default'] as const)('keeps the legacy %s prompt source when no group rules are saved', async source => {
    const judge = await useRealJudge(source);
    await send(says('没有群内规则时仍使用原来的提示词'));
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(judge.readPrompt).toHaveBeenCalledExactlyOnceWith(APP, CHAT);
    expect(judge.calls[0]!.system).toContain('LEGACY_SMART_PROMPT');
    expect(judge.results).toEqual([expect.objectContaining({ decision: 'skip', promptSource: source })]);
  });
});

describe('smart mode intake (s25)', () => {
  it('publishes a successful model intent at decision time with no prompt, reason or sender content', async () => {
    const msg = says('PRIVATE_MESSAGE', { at: true });
    await send(msg); await judged(msg);
    const before = Date.now();
    await decide(msg, result('topic', { reason: 'PRIVATE_REASON' }));
    await vi.waitFor(() => expect(homeDecisions()).toHaveLength(1));
    const decision = homeDecisions()[0]!;
    expect(decision).toMatchObject({ groupId: CHAT, place: 'main', decision: 'topic', trigger: 'mention', messageAt: Number(msg.create_time) });
    expect(decision.decidedAt).toBeGreaterThanOrEqual(before);
    expect(decision.decidedAt).toBeLessThanOrEqual(Date.now());
    expect(decision).not.toHaveProperty('messageCount');
    expect(JSON.stringify(decision)).not.toMatch(/PRIVATE|om_smart_|ou_owner/);
  });

  it('never publishes failed, fallback, recalled, budgeted or command paths as model decisions', async () => {
    const failed = says('failed', { at: true });
    await send(failed); await decide(failed, result('skip', { error: { kind: 'timeout' } }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    const recalled = says('recalled'); await send(recalled); await judged(recalled);
    await orchestrator.onRecall({ messageId: idOf(recalled), chatId: CHAT });
    const budget = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValue(false);
    try { await send(says('budget')); await settle(); } finally { budget.mockRestore(); }
    await send(says('/help', { at: true })); await settle();
    expect(homeDecisions()).toEqual([]);
  });

  it.each(['done', 'error', 'empty', 'missing-done', 'delivery-failed'] as const)('reports a reply only after confirmed nonempty successful delivery: %s', async outcome => {
    fake.project = { ...base, smart: false };
    fake.finalOk = outcome !== 'delivery-failed';
    fake.events = async function* () {
      if (outcome !== 'empty') yield { type: 'text', itemId: 'answer', text: 'PRIVATE_ANSWER' };
      if (outcome === 'error') yield { type: 'error', message: 'failure', willRetry: false };
      else if (outcome !== 'missing-done') yield { type: 'done', turnId: 'completed' };
    };
    await send(says('question', { at: true, thread: 'omt_activity' }));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
    expect(latestActions()).toHaveLength(outcome === 'done' ? 1 : 0);
    if (outcome === 'done') expect(latestActions()[0]).toMatchObject({ groupId: CHAT, kind: 'replied' });
    expect(JSON.stringify(latestActions())).not.toContain('PRIVATE_ANSWER');
    const ended = new Set(events.flatMap(event => event.kind === 'activityEnded' ? [event.id] : []));
    const running = events.flatMap(event => event.kind === 'activity' ? [event.activity.id] : []);
    expect(running.length).toBeGreaterThan(0);
    expect(running.every(id => ended.has(id))).toBe(true);
  });

  it('a judgement does not hold the chat: a topic @ is answered while the main area is still judged (A1)', async () => {
    const chatter = says('这个报错是不是缓存的问题');
    await send(chatter); // returns while the judgement runs
    expect((await judged(chatter)).req.variant).toBe('main');
    const named = says('帮我看下日志', { at: true, thread: 'omt_t' });
    await send(named); await decide(named, result('reply'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain('帮我看下日志');
    expect(asked.size).toBe(2);
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

  it('keeps an initiative run outside human settings authority', async () => {
    await orchestrator.shutdown();
    const entries = createAgentEntries({ appId: 'fixture', isAdmin: () => true });
    const issue = vi.spyOn(entries, 'issue'), open = vi.spyOn(entries, 'openTurn'), checked = vi.fn();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { attention: new FocusEverywhere(), entries });
    fake.events = async function* () {
      const grant = issue.mock.results[0]!.value;
      await expect(grant.call('session_info', {})).resolves.toMatchObject({ ok: true, result: { turn: 'other' } });
      checked();
      yield { type: 'done', turnId: 'turn-fixture' };
    };
    const m = says('登录接口为什么 500');
    await send(m);
    await decide(m, result('main'));
    await vi.waitFor(() => expect(checked).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ initiative: true, retry: false, wake: false }));
  });

  it('judges a named message with main and a 12 s timeout, THINKING meanwhile, without the initiative line', async () => {
    const m = says('看下这个', { at: true });
    await send(m);
    expect((await judged(m)).req.variant).toBe('main');
    expect((await judged(m)).req.why).toBe('真人 @ 了你');
    expect((await judged(m)).req.timeoutMs).toBe(12_000);
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

  it('a group switched away or disabled while judged refuses both unnamed and named judgements', async () => {
    const chatter = says('A 顺便说一句');
    const named = says('B 请回答', { at: true });
    await send(chatter);
    await send(named);
    await judged(chatter);
    await judged(named);
    fake.project = { ...base, smart: false };
    await decide(chatter, result('main'));
    await decide(named, result('topic'));
    await vi.waitFor(() => expect(records().map((r) => r.reason)).toEqual(['group-updating', 'group-updating']));
    expect(fake.inputs).toEqual([]);
    // Disabled meanwhile: noted, not answered.
    const late = says('线上挂了');
    fake.project = { ...base };
    await send(late);
    await judged(late);
    fake.project = { ...base, enabled: false };
    await decide(late, result('main'));
    await vi.waitFor(() => expect(records().map((r) => r.reason)).toEqual(['group-updating', 'group-updating', 'group-disabled']));
    expect(fake.inputs).toEqual([]);
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

  it('keeps judging a named message past 60 judgements an hour; unnamed ones are not judged', async () => {
    const judgeNamed = fake.judge.getMockImplementation()!;
    fake.judge.mockImplementation(async (req: JudgeRequest) => { asked.set(req.ref!, { req, answer: deferred() }); return result('skip'); });
    for (let i = 0; i < JUDGE_BUDGET; i++) {
      await send(says(`第 ${i} 句`));
      await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(i + 1));
    }
    await send(says('超了'));
    await vi.waitFor(() => expect(records().filter((r) => r.reason === 'judge-budget')).toHaveLength(1));
    fake.judge.mockImplementationOnce(judgeNamed);
    const named = says('请回答', { at: true });
    await send(named);
    expect((await judged(named)).req.variant).toBe('main');
    expect(fake.judge).toHaveBeenCalledTimes(JUDGE_BUDGET + 1);
    await decide(named, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    fake.judge.mockImplementationOnce(judgeNamed);
    const next = says('再请回答', { at: true });
    await send(next);
    expect((await judged(next)).req.variant).toBe('main');
    expect(fake.judge).toHaveBeenCalledTimes(JUDGE_BUDGET + 2);
    await decide(next, result('main'));
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
    const kept = createOrchestrator(channel as never, cfg, workspace, undefined, { droppedFile: file, attention: new FocusEverywhere() });
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
    const kept = createOrchestrator(channel as never, cfg, workspace, undefined, { droppedFile: file, attention: new FocusEverywhere() });
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
  const answered = () => vi.waitFor(() => expect(fake.inputs).toHaveLength(1));

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
    await send(named); await decide(named, result('skip')); await settle();
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

  it('supersedes a second judgement naming the line a topic is still being opened under', async () => {
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
    try {
      const first = says('顺便说一下是生产环境');
      await send(first, zhang);
      await decide(first, result('topic', { anchor: idOf(asked) }));
      await vi.waitFor(() => expect(startThread).toHaveBeenCalledTimes(1));
      const second = says('对，就是导出那个');
      await send(second, zhang);
      await decide(second, result('topic', { anchor: idOf(asked) }));
      await settle(); expect(fake.cards).toEqual([]);
      started.resolve();
      await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
      await vi.waitFor(() => expect(records().map(r => r.reason)).toContain('judge-superseded'));
      expect(startThread).toHaveBeenCalledTimes(1);
      expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(asked) });
      const next = says('好的');
      await send(next);
      expect((await judged(next)).req.context.filter(l => l.from === 'self' && l.text.includes('开了话题')).map(l => l.text))
        .toEqual(['（在 李四 的这条下开了话题来回）']);
    } finally { started.resolve(); }
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

  it('an interjection preserves the original human recipient on a smart error', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    fake.events = async function* () { await gate; yield { type: 'error', message: 'interjected failure', willRetry: false }; };
    const chatter = says('线上挂了吗');
    await send(chatter);
    await decide(chatter, result('main'));
    await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
    const named = says('看下这个', { at: true });
    await send(named, { openId: 'ou_interjector' });
    await decide(named, result('main'));
    await vi.waitFor(() => expect(fake.cards).toHaveLength(2));
    expect(fake.cards[1]![3]).toMatchObject({ replyTo: idOf(named) });
    release();
    await vi.waitFor(() => expect(fake.finals).toHaveLength(2));
    expect(fake.del).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fake.reply).toHaveBeenCalledOnce());
    expect(JSON.parse(fake.reply.mock.calls[0]![0].data.content).zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_owner' });
  });
});

function replyToHumanTopics() {
  const judge = fake.judge.getMockImplementation()!;
  fake.judge.mockImplementation((req: JudgeRequest) => req.variant === 'topic' && req.message.from === 'user' && req.message.named ? Promise.resolve(result('reply')) : judge(req));
}

describe('bot wakes (s27a)', () => {
  beforeEach(replyToHumanTopics);
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

  const privateLogs = async (m: EventMessage) => {
    const rows = fake.log.info.mock.calls.filter(c => String(c[1]).startsWith('bot-wake') || c[1] === 'judge-budget' || (c[1] === 'judge-landed' && JSON.stringify(c[2]).includes('"wake":true')));
    const failures = fake.log.fail.mock.calls.filter(c => ['bot-wake', 'bot-wake-land'].includes(String(c[2]?.phase)));
    const logs = JSON.stringify([...rows, ...failures.map(([phase, error, fields]) => ({ phase, fields, error: error instanceof Error ? { message: error.message, stack: error.stack } : error }))]);
    for (const secret of ['SECRET_BOT_TEXT', '小P', idOf(m), 'ou_other']) expect(logs).not.toContain(secret);
    if (failures.length) {
      const real = await vi.importActual<typeof import('../src/core/logger')>('../src/core/logger');
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const [phase, error, fields] of failures) real.log.fail(phase, error, fields);
        const output = JSON.stringify(printed.mock.calls);
        expect(output).toContain('bot-wake');
        for (const secret of ['SECRET_BOT_TEXT', '小P', idOf(m), 'ou_other']) expect(output).not.toContain(secret);
      } finally { printed.mockRestore(); }
    }
  };

  it('judges a topic bot mention within the budget, with the bot envelope and no THINKING', async () => {
    const m = wake({ thread: 'omt_wake' }); history(m);
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      await botSays(m);
      expect((await judged(m)).req).toMatchObject({ variant: 'topic', message: { from: 'bot', name: '小P', senderId: 'ou_other', mentions: ['小码'], text: expect.stringContaining('SECRET_BOT_TEXT') } });
      expect(take).toHaveBeenCalledOnce(); expect(take).toHaveBeenCalledWith(CHAT, expect.any(Number), 'bot'); expect(fake.inputs).toEqual([]);
      expect(fake.react).not.toHaveBeenCalled(); expect(fake.unreact).not.toHaveBeenCalled();
      await decide(m, result('reply')); await answered();
      expect(fake.inputs[0]?.startsWith(BOT_WAKE_NOTE('小P'))).toBe(true);
      expect(fake.inputs[0]).toContain('小P（bot）（open_id：ou_other）');
      expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
      expect(fake.react.mock.calls.some(([r]) => r.data.reaction_type.emoji_type === 'THINKING')).toBe(false);
      expect(JSON.stringify(fake.unreact.mock.calls)).not.toContain('r_THINKING');
      await privateLogs(m);
    } finally { take.mockRestore(); }
  });

  it.each(['main', 'topic'] as const)('answers a main-area bot trigger in %s on the trigger itself', async decision => {
    const m = wake(); history(m); await botSays(m);
    expect((await judged(m)).req.variant).toBe('main');
    await decide(m, result(decision, { anchor: 'm2' })); await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(m), replyInThread: decision === 'topic' });
    expect(fake.log.info.mock.calls.some(c => c[1] === 'anchor-dropped')).toBe(false);
  });

  it.each([false, true])('a bot judgement skip fails closed (error=%s)', async failed => {
    const m = wake(); await botSays(m);
    await decide(m, failed ? result('skip', { error: { kind: 'timeout' } }) : result('skip', { reason: 'bot 闲聊' }));
    await noted(failed ? 'judge-failed' : 'judge-skip');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ sender: '小P', detail: failed ? expect.stringContaining('timeout') : 'bot 闲聊' });
    expect(fake.inputs).toEqual([]); await privateLogs(m);
  });

  it("over the budget a bot's @ is not judged", async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValue(false);
    const m = wake();
    try {
      await botSays(m); await noted('judge-budget');
      expect(fake.get).toHaveBeenCalled(); expect(fake.list).not.toHaveBeenCalled(); expect(fake.judge).not.toHaveBeenCalled();
      expect(fake.log.info).toHaveBeenCalledWith('intake', 'judge-budget', expect.objectContaining({ wake: true })); await privateLogs(m);
    } finally { take.mockRestore(); }
  });

  it.each(['single', 'multi', 'unbound'])('keeps rejecting bots in %s rule groups without reading or noting', async kind => {
    fake.project = kind === 'unbound' ? undefined : { ...base, kind, smart: false };
    await botSays(wake()); await settle();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'reject', expect.objectContaining({ reason: 'bot-sender' }));
    expect(fake.list).not.toHaveBeenCalled(); expect(fake.request).not.toHaveBeenCalled();
    expect(records()).toEqual([]); expect(fake.inputs).toEqual([]);
    fake.project = { ...base }; const m = wake({ thread: 'omt_control' }); history(m);
    await botSays(m); await decide(m, result(m.thread_id ? 'reply' : 'main')); await answered();
  });

  it("judges a bot's seventh @ in a row like the first", async () => {
    const m = wake({ thread: 'omt_seventh' });
    history(m, Array.from({ length: 6 }, (_, i) => item({ ...m, message_id: `om_before_${i}`, create_time: String(Number(m.create_time) - 1000 - i * 1000) })));
    await botSays(m); await decide(m, result('reply')); await answered();
    expect(fake.inputs[0]?.startsWith(BOT_WAKE_NOTE('小P'))).toBe(true);
    expect(fake.inputs[0]).not.toMatch(/已互相叫醒|已到上限/);
    expect(records().some(r => r.reason === 'bot-wake-cap')).toBe(false);
    expect(fake.log.info.mock.calls.some(c => c[1] === 'bot-wake-cap')).toBe(false);
    const row = fake.log.info.mock.calls.find(c => c[1] === 'bot-wake'); expect(row?.[2]).not.toHaveProperty('n');
  });

  it.each(['history-throw', 'history-code', 'roster-throw', 'roster-missing'])("neither history nor the member list holds a bot's @ back (%s)", async failure => {
    const m = wake({ thread: 'omt_fail' }); history(m);
    if (failure === 'history-throw') fake.list.mockRejectedValue(new Error('network'));
    if (failure === 'history-code') fake.list.mockResolvedValue({ code: 230001 });
    if (failure === 'roster-throw') fake.request.mockRejectedValue(new Error('network'));
    if (failure === 'roster-missing') fake.request.mockResolvedValue({ code: 0, data: {} });
    await botSays(m); await decide(m, result('reply')); await answered();
    expect(records().some(r => r.reason === 'bot-wake-failed')).toBe(false);
    expect(fake.inputs[0]).toContain('SECRET_BOT_TEXT');
  });

  it('catches an exception before judging without falling back to direct', async () => {
    const m = wake({ thread: 'omt_boom' }); history(m);
    vi.mocked(wakeTriggerText).mockImplementationOnce(() => { throw new Error(`boom SECRET_BOT_TEXT 小P ${idOf(m)} ou_other`); });
    await botSays(m); await noted('bot-wake-failed');
    expect(records()[0]?.detail).toContain('boom SECRET_BOT_TEXT'); expect(fake.inputs).toEqual([]); expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.log.fail).toHaveBeenCalledWith('intake', 'bot-wake-failed', expect.objectContaining({ phase: 'bot-wake' }));
    expect(fake.react).not.toHaveBeenCalled(); await privateLogs(m);
  });


  it.each([
    ['ou_other', ['ou_owner'], false], ['ou_other', ['ou_owner', 'ou_other'], true],
    ['cli_other', ['ou_other'], true], ['cli_other', ['ou_owner'], false], ['ou_wrong', ['ou_other'], true], ['ou_other', [], true],
  ])('checks the resolved sender before judging, and again at landing (%s, %j)', async (eventId, allowedUsers, allowed) => {
    fake.project = { ...base, allowedUsers }; const m = wake({ thread: 'omt_audience' }); history(m);
    fake.get.mockResolvedValue({ code: 0, data: { items: [item(m)] } });
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      await botSays(m, eventId);
      if (allowed) { await decide(m, result('reply')); await answered(); }
      else { await noted('bot-wake-not-allowed'); expect(fake.inputs).toEqual([]); expect(fake.judge).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled(); expect(records()).toHaveLength(1); await privateLogs(m); }
      expect(fake.get).toHaveBeenCalled();
    } finally { take.mockRestore(); }
  });

  it.each(['rule-mode', 'audience', 'disabled', 'unbound'])('rechecks %s after the sender lookup', async change => {
    const m = wake({ thread: 'omt_change' }); const gate = deferred<Awaited<ReturnType<typeof fake.get>>>();
    fake.get.mockReturnValue(gate.promise); const take = vi.spyOn(JudgeBudget.prototype, 'take'); await botSays(m);
    await vi.waitFor(() => expect(fake.get).toHaveBeenCalled());
    fake.project = change === 'unbound' ? undefined : { ...base, ...(change === 'rule-mode' ? { smart: false } : change === 'disabled' ? { enabled: false } : { allowedUsers: ['ou_owner'] }) };
    gate.resolve({ code: 0, data: { items: [item(m)] } }); await settle();
    if (change !== 'unbound') await noted(change === 'audience' ? 'bot-wake-not-allowed' : change === 'disabled' ? 'group-disabled' : 'bot-wake-dropped');
    expect(fake.inputs).toEqual([]); expect(fake.judge).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled(); await privateLogs(m); take.mockRestore();
  });

  it('notes a disabled smart group at intake', async () => {
    fake.project = { ...base, enabled: false }; await botSays(wake()); await noted('group-disabled');
    expect(fake.list).not.toHaveBeenCalled();
  });

  it.each(['/goal 做点什么', '/compact'])('treats %s from a bot as ordinary text', async text => {
    const m = wake({ thread: 'omt_command', text }); history(m); await botSays(m); await decide(m, result(m.thread_id ? 'reply' : 'main')); await answered();
    expect(fake.inputs[0]).toContain(text);
    expect(fake.react.mock.calls.some(([r]) => r.data.reaction_type.emoji_type === 'OKR')).toBe(false);
  });

  it("keeps an unrelated topic responsive while a bot's @ is judged", async () => {
    const m = wake({ thread: 'omt_hung' }); await botSays(m); await judged(m);
    await send(says('HUMAN_OTHER', { at: true, thread: 'omt_other' })); await answered();
    await decide(m, result('reply')); await answered(2);
  });

  it('lands a preceding named human before a bot whose judgement finishes first', async () => {
    const human = says('HUMAN_FIRST', { at: true }); await send(human); await judged(human);
    const m = wake(); await botSays(m); await decide(m, result('main')); await settle(); expect(fake.inputs).toEqual([]);
    await decide(human, result('main')); await vi.waitFor(() => expect(fake.inputs.length).toBeGreaterThanOrEqual(1)); expect(fake.inputs[0]).toContain('HUMAN_FIRST');
  });

  it("a person's @ after a bot's @ does not wait for the bot's judgement", async () => {
    const m = wake(); await botSays(m); await judged(m);
    const human = says('HUMAN_LATER', { at: true }); await send(human); await decide(human, result('main')); await answered();
    expect(fake.inputs[0]).toContain('HUMAN_LATER');
    await decide(m, result('main'));
    await vi.waitFor(() => expect(fake.inputs.length === 2 || records().some(r => r.reason === 'bot-wake-dropped' && r.detail === '已随后来的消息进了会话')).toBe(true));
  });

  it.each(['ou_bot', 'ou_other'])('rejects itself while another bot wakes it (%s)', async sender => {
    const m = wake({ thread: 'omt_self' }); history(m); await botSays(m, sender);
    if (sender === 'ou_other') { await decide(m, result('reply')); await answered(); } else { await settle(); expect(fake.inputs).toEqual([]); expect(fake.list).not.toHaveBeenCalled(); }
  });

  it('records sender kind and logs wake metadata without names, body or full ids', async () => {
    const m = wake({ thread: 'omt_logs' }); history(m); await botSays(m); await decide(m, result('reply')); await answered();
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'recv', expect.objectContaining({ senderType: 'app', senderIdKind: 'ou_' }));
    await privateLogs(m);
    expect(fake.log.info.mock.calls.find(c => c[1] === 'bot-wake')?.[2]).toEqual({ ref: idOf(m).slice(-6), place: 'topic' });
  });

  it.each(['intake', 'lookup', 'judge', 'fill', 'land'])('shutdown during %s never persists a bot for resend or notes it', async stage => {
    await orchestrator.shutdown(); const file = join(paths.appDir, `wake-${stage}.json`);
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { droppedFile: file, attention: new FocusEverywhere() });
    const m = wake({ thread: 'omt_stop' }); const disk = deferred<void>();
    if (stage === 'intake') fake.hold = disk.promise;
    if (stage === 'lookup') { fake.get.mockReturnValue(new Promise(() => {})); fake.request.mockReturnValue(new Promise(() => {})); }
    if (stage === 'fill') fake.list.mockReturnValue(new Promise(() => {}));
    const intake = botSays(m);
    if (stage === 'intake') await settle();
    else if (stage === 'lookup') await vi.waitFor(() => expect(fake.get).toHaveBeenCalled());
    else if (stage === 'fill') await vi.waitFor(() => expect(fake.list).toHaveBeenCalled());
    else { await judged(m); if (stage === 'land') { fake.hold = disk.promise; await decide(m, result('reply')); await settle(); } }
    const stop = orchestrator.shutdown(); disk.resolve();
    await Promise.race([stop, new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 2900))]);
    await intake; await settle(); expect(fake.inputs).toEqual([]); expect(records()).toEqual([]); expect(fake.send).not.toHaveBeenCalled();
    if (existsSync(file)) expect(readFileSync(file, 'utf8')).not.toContain(idOf(m));
    const dropped = fake.log.info.mock.calls.some(c => c[1] === 'bot-wake-dropped' && JSON.stringify(c[2]).includes('shutdown'));
    expect(dropped).toBe(['intake', 'lookup', 'land'].includes(stage));
    if (stage === 'fill' && fake.judge.mock.calls.length) expect(fake.judge.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  it.each(['audience', 'rule-mode', 'updating-during-judgement'])('rechecks %s during judgement', async change => {
    const m = wake(); await botSays(m); await judged(m);
    const gate = deferred<void>(); let edit: Promise<unknown> | undefined;
    if (change === 'updating-during-judgement') {
      fake.projectLookup.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await gate.promise; throw new Error('test stopped edit'); });
      edit = orchestrator.collaboration({ action: 'editProject', projectName: 'demo', chatId: CHAT, expectedRevision: projectRevision(fake.project as never), enabled: false }).catch(() => undefined);
      await vi.waitFor(() => expect(fake.projectLookup).toHaveBeenCalledTimes(3));
    } else fake.project = { ...base, ...(change === 'audience' ? { allowedUsers: ['ou_owner'] } : { smart: false }) };
    try {
      await decide(m, result('main')); await noted(change === 'audience' ? 'bot-wake-not-allowed' : change === 'rule-mode' ? 'group-updating' : 'bot-wake-dropped');
      expect(fake.inputs).toEqual([]); expect(records()).toHaveLength(1);
      if (change === 'updating-during-judgement') expect(records()[0]?.detail).toBe('群正在改设置');
      if (change === 'rule-mode') expect(records()[0]?.detail).toBeUndefined();
      await privateLogs(m);
    } finally { gate.resolve(); await edit; }
  });


  async function holdMutation(kind: 'edit' | 'resume'): Promise<() => Promise<void>> {
    const gate = deferred<void>();
    let pending: Promise<unknown>;
    if (kind === 'edit') {
      fake.projectLookup.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { await gate.promise; throw new Error('controlled edit'); });
      pending = orchestrator.collaboration({ action: 'editProject', projectName: 'demo', chatId: CHAT, expectedRevision: projectRevision(fake.project as never), enabled: false }).catch(() => undefined);
      await vi.waitFor(() => expect(fake.projectLookup).toHaveBeenCalledTimes(3));
    } else {
      fake.project = { ...base, kind: 'multi' };
      const reads = fake.readHistory.mock.calls.length;
      fake.readHistory.mockImplementationOnce(async () => { await gate.promise; throw new Error('controlled resume'); });
      pending = orchestrator.collaboration({ action: 'resume', projectName: 'demo', chatId: CHAT, sessionId: 'past', backend: 'codex-appserver' }).catch(() => undefined);
      await vi.waitFor(() => expect(fake.readHistory).toHaveBeenCalledTimes(reads + 1));
    }
    return async () => { gate.resolve(); await pending; };
  }

  it.each(['intake', 'lookup', 'project'] as const)('recall while awaiting %s never spends judgement budget', async stage => {
    const m = wake(stage === 'lookup' ? { thread: 'omt_lookup_recall' } : {}); const gate = deferred<void>();
    if (stage === 'intake') fake.sessionReads.mockImplementationOnce(() => gate.promise);
    if (stage === 'lookup') fake.get.mockImplementationOnce(async () => { await gate.promise; return { code: 0, data: { items: [item(m)] } }; });
    if (stage === 'project') fake.projectReads.mockImplementationOnce(async () => {}).mockImplementationOnce(() => gate.promise);
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      const intake = botSays(m);
      await vi.waitFor(() => expect(stage === 'intake' ? fake.sessionReads.mock.calls.length : stage === 'lookup' ? fake.get.mock.calls.length : fake.projectReads.mock.calls.length).toBeGreaterThanOrEqual(stage === 'project' ? 2 : 1));
      await orchestrator.onRecall({ messageId: idOf(m), chatId: CHAT });
      gate.resolve(); await intake; await settle();
      expect(take).not.toHaveBeenCalled(); expect(fake.judge).not.toHaveBeenCalled(); expect(fake.inputs).toEqual([]); expect(records()).toEqual([]);
    } finally { gate.resolve(); take.mockRestore(); }
  });

  it('project lookup rejecting after shutdown does not publish a failed-wake diagnostic', async () => {
    const gate = deferred<void>(); const m = wake();
    fake.projectReads.mockImplementationOnce(async () => {}).mockImplementationOnce(() => gate.promise);
    await botSays(m); await vi.waitFor(() => expect(fake.projectReads).toHaveBeenCalledTimes(2));
    const stop = orchestrator.shutdown(); gate.reject(new Error('controlled storage failure')); await stop; await settle();
    expect(records()).toEqual([]); expect(fake.inputs).toEqual([]);
    expect(fake.log.info).toHaveBeenCalledWith('intake', 'bot-wake-dropped', expect.objectContaining({ why: 'shutdown' }));
  });

  it.each(['edit', 'resume'] as const)('a %s beginning during sender lookup blocks before budget and recovers', async kind => {
    const gate = deferred<void>(); const entered = deferred<void>(); const m = wake({ thread: 'omt_lookup_gate' });
    fake.get.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return { code: 0, data: { items: [item(m)] } }; });
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    await botSays(m); await entered.promise;
    expect(fake.get).toHaveBeenCalledWith({ path: { message_id: idOf(m) }, params: { with_sender_name: true } });
    const release = await holdMutation(kind);
    try {
      gate.resolve(); await noted('bot-wake-dropped');
      expect(records()).toHaveLength(1); expect(records()[0]?.detail).toBe(kind === 'edit' ? '群正在改设置' : '群正在恢复会话');
      expect(take).not.toHaveBeenCalled(); expect(fake.judge).not.toHaveBeenCalled(); expect(fake.inputs).toEqual([]);
    } finally { gate.resolve(); await release(); fake.project = { ...base }; take.mockRestore(); }
    const control = wake({ thread: 'omt_recovered' }); await botSays(control); await decide(control, result('reply')); await answered();
  });

  it.each(['edit', 'resume'] as const)('a late %s lock is rechecked after the final await for every wake exit', async kind => {
    for (const decision of ['main', 'reply', 'topic'] as const) {
      const m = wake(decision === 'reply' ? { thread: 'omt_late' } : {});
      await botSays(m); await judged(m);
      const gate = deferred<void>(); fake.sessionReads.mockImplementationOnce(() => gate.promise);
      const reads = fake.sessionReads.mock.calls.length;
      await decide(m, result(decision)); await vi.waitFor(() => expect(fake.sessionReads.mock.calls.length).toBeGreaterThan(reads));
      const release = await holdMutation(kind);
      try {
        gate.resolve(); await vi.waitFor(() => expect(records()).toHaveLength(['main', 'reply', 'topic'].indexOf(decision) + 1));
        expect(records().at(-1)).toMatchObject({ reason: 'bot-wake-dropped', detail: kind === 'edit' ? '群正在改设置' : '群正在恢复会话' });
        expect(fake.inputs).toEqual([]); expect(fake.send).not.toHaveBeenCalled();
      } finally { gate.resolve(); await release(); fake.project = { ...base }; fake.projectLookup.mockReset(); }
    }
  });

  it('judges a bot aside while ordinary unnamed messages remain in their own batch', async () => {
    const first = says('ORDINARY_FIRST'); await send(first); await judged(first);
    const m = wake(); await botSays(m); expect((await judged(m)).req.message.from).toBe('bot');
    const later = says('ORDINARY_LATER'); await send(later); await settle();
    expect(asked.has(idOf(later))).toBe(false);
    await decide(first, result('skip')); const next = await judged(later);
    expect(next.req.message.text).toContain('ORDINARY_LATER'); expect(next.req.message.text).not.toContain('SECRET_BOT_TEXT');
    await decide(later, result('skip')); await decide(m, result('skip')); await settle(); expect(fake.inputs).toEqual([]);
  });

  it('rejects an unknown bot sender before judging when there is an audience', async () => {
    fake.project = { ...base, allowedUsers: ['ou_other'] }; fake.get.mockRejectedValue(new Error('gone'));
    const take = vi.spyOn(JudgeBudget.prototype, 'take'); const m = wake();
    try { await botSays(m, 'cli_other'); await noted('bot-wake-not-allowed'); expect(fake.judge).not.toHaveBeenCalled(); expect(take).not.toHaveBeenCalled(); await privateLogs(m); }
    finally { take.mockRestore(); }
  });

  it("a lookup that throws while a bot's @ lands is noted", async () => {
    const m = wake(); await botSays(m); await judged(m);
    fake.projectRead = Promise.reject(new Error(`land lookup boom SECRET_BOT_TEXT 小P ${idOf(m)} ou_other`)); void fake.projectRead.catch(() => {});
    try {
      await decide(m, result('main')); await noted('bot-wake-failed');
      expect(records()[0]?.detail).toContain('land lookup boom'); expect(records()).toHaveLength(1); expect(fake.inputs).toEqual([]);
      expect(fake.log.fail).toHaveBeenCalledWith('intake', 'bot-wake-land-failed', expect.objectContaining({ phase: 'bot-wake-land' })); await privateLogs(m);
    } finally { fake.projectRead = undefined; }
  });

});

// Separate describe keeps the shared fixture while exercising sender and lifecycle fallbacks.
describe('bot wake fallbacks and queued turns (s27a)', () => {
  beforeEach(replyToHumanTopics);
  const memento = (m: EventMessage, sender: object = { sender_type: 'app', id: 'cli_other', open_bot_id: 'ou_other', sender_name: '小P' }) => ({
    message_id: idOf(m), create_time: m.create_time, msg_type: m.message_type, body: { content: m.content }, sender,
    mentions: [{ id: BOT.openId, id_type: 'open_id', key: '@_user_1', name: BOT.name }],
  });
  const page = (items: object[]) => ({ code: 0, data: { items, has_more: false } });
  const botSays = (m: EventMessage, openId = 'ou_other') => send(m, { openId, type: 'app', name: '小P' });
  const rawBotSays = async (m: EventMessage, senderType: 'app' | 'bot') => {
    const msg = await receive(m, { bot: BOT, sender: { openId: 'ou_other', type: 'app', name: '小P' } });
    await orchestrator.onMessage({ ...msg, raw: { sender: { sender_type: senderType } } });
  };
  const answered = (n = 1) => vi.waitFor(() => expect(fake.inputs).toHaveLength(n));

  it('includes an actual main answer and the bot trigger in exchanges, without counting its act record', async () => {
    fake.events = async function* () { yield { type: 'text', itemId: 'answer', text: '已经完成第一步' }; yield { type: 'done', turnId: 'turn-fixture' }; };
    const human = { ...says('先处理第一步', { at: true }), create_time: String(Date.now() - 2_000) };
    await send(human); await decide(human, result('main')); await answered();
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
    const bot = { ...says('请接着第二步', { at: true }), create_time: String(Date.now() + 1) };
    fake.list.mockResolvedValue(page([memento(bot)]));
    await botSays(bot);
    const req = (await judged(bot)).req;
    expect(req.why).toBe('别的 bot @ 了你');
    expect(req.facts?.botExchangesSincePerson).toEqual({ count: 2, atLeast: true });
    await decide(bot, result('skip'));
  });

  it('records a bot mention during /goal without sending the goal-busy explanation, while a person gets it', async () => {
    const gate = deferred<void>();
    fake.events = async function* () { yield { type: 'text', itemId: 'goal-output', text: '正在整理' }; await gate.promise; };
    try {
      await send(says('/goal 整理文档', { at: true, thread: 'omt_busy_goal' }));
      await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
      const m = says('BOT_GOAL_BUSY', { at: true, thread: 'omt_busy_goal' });
      await botSays(m); await decide(m, result('reply'));
      await vi.waitFor(() => expect(records().filter(record => record.reason === 'bot-wake-dropped')).toHaveLength(1));
      expect(records().find(record => record.reason === 'bot-wake-dropped')).toMatchObject({ detail: '会话在跑 /goal' });
      expect(JSON.stringify(fake.send.mock.calls)).not.toContain('目标运行中');
      await send(says('HUMAN_GOAL_BUSY', { at: true, thread: 'omt_busy_goal' }));
      await vi.waitFor(() => expect(JSON.stringify(fake.send.mock.calls)).toContain('目标运行中'));
      expect(fake.inputs).toEqual([]);
    } finally { gate.resolve(); }
  });

  it('drops a bot message sent before /new without asking it to resend', async () => {
    const gate = deferred<void>();
    const create = startThread.getMockImplementation();
    if (!create) throw new Error('thread fixture missing');
    startThread.mockImplementationOnce(async () => { await gate.promise; return create(); });
    const m = says('BOT_BEFORE_NEW', { at: true });
    try {
      await send(says('/new', { at: true }));
      await vi.waitFor(() => expect(startThread).toHaveBeenCalledOnce());
      await botSays(m); await decide(m, result('main'));
      await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'deferred', expect.objectContaining({ msgId: idOf(m) })));
      gate.resolve();
      await vi.waitFor(() => expect(records().filter(record => record.reason === 'bot-wake-dropped')).toHaveLength(1));
      expect(records().find(record => record.reason === 'bot-wake-dropped')).toMatchObject({ detail: '会话换成了新的（/new）' });
      expect(JSON.stringify(fake.send.mock.calls)).not.toContain('这条在');
      expect(fake.inputs).toEqual([]);
    } finally { gate.resolve(); }
  });

  it('drops bot intake finishing after stop without asking for a resend', async () => {
    const run = deferred<void>(); const context = deferred<void>(); const reading = deferred<void>();
    fake.events = async function* () { await run.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    try {
      await send(says('RUNNING', { at: true, thread: 'omt_cancelled' })); await answered();
      const m = { ...says('BOT_CANCELLED', { at: true, thread: 'omt_cancelled' }), parent_id: 'om_quoted' };
      await botSays(m); await judged(m);
      fake.get.mockImplementationOnce(async () => { reading.resolve(); await context.promise; return { code: 0, data: { items: [] } }; });
      await decide(m, result('reply')); await vi.waitFor(() => expect(fake.get).toHaveBeenCalledWith(expect.objectContaining({ path: { message_id: 'om_quoted' } }))); await reading.promise;
      const stopping = orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.stop', m: 'card_1' } } } as never);
      await settle(); context.resolve(); run.resolve(); await stopping;
      await vi.waitFor(() => expect(records().filter(record => record.reason === 'bot-wake-dropped')).toHaveLength(1));
      expect(records().find(record => record.reason === 'bot-wake-dropped')).toMatchObject({ detail: '会话被停下了' });
      expect(fake.log.info).toHaveBeenCalledWith('intake', 'bot-wake-dropped', expect.objectContaining({ why: 'intake-cancelled' }));
      expect(JSON.stringify(fake.send.mock.calls)).not.toContain('请重发');
      expect(fake.inputs).toHaveLength(1);
    } finally { context.resolve(); run.resolve(); }
  });

  it('quietens repeated full-only explanations for bots while human mentions still get an explanation', async () => {
    fake.project = { ...base, mode: 'qa' }; fake.fullOnly = true;
    for (let i = 0; i < 2; i++) {
      const m = says('BOT_FULL_ONLY', { at: true, thread: `omt_full_bot_${i}` });
      await botSays(m); await decide(m, result('reply'));
      await vi.waitFor(() => expect(records()).toHaveLength(i + 1));
    }
    expect(fake.send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) await send(says('HUMAN_FULL_ONLY', { at: true, thread: `omt_full_human_${i}` }));
    await vi.waitFor(() => expect(records()).toHaveLength(4));
    expect(fake.send).toHaveBeenCalledTimes(3);
    expect(records().every(record => record.reason === 'tier-unavailable')).toBe(true);
    expect(fake.inputs).toEqual([]);
  });

  it.each([['failed', 0], ['failed', 1], ['stopped', 0], ['stopped', 1]] as const)('asks only people in a dropped queue to resend (%s, people=%s)', async (terminal, people) => {
    fake.project = { ...base, pendingPolicy: 'queue' };
    const gate = deferred<void>();
    fake.events = async function* () {
      await gate.promise;
      if (terminal === 'failed') throw new Error('controlled failure');
      else yield { type: 'done', turnId: 'turn-fixture' };
    };
    await send(says('RUNNING', { at: true, thread: 'omt_dropped' })); await answered();
    const m = says('BOT_DROPPED', { at: true, thread: 'omt_dropped' });
    await botSays(m); await decide(m, result('reply'));
    await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(call => call[1] === 'queued')).toHaveLength(1));
    if (people) {
      await send(says('HUMAN_DROPPED', { at: true, thread: 'omt_dropped' }));
      await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(call => call[1] === 'queued')).toHaveLength(2));
    }
    const stopping = terminal === 'stopped' ? orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.stop', m: 'card_1' } } } as never) : undefined;
    await settle(); gate.resolve(); await stopping;
    await vi.waitFor(() => expect(records().filter(record => record.reason === 'bot-wake-dropped')).toHaveLength(1));
    expect(records().find(record => record.reason === 'bot-wake-dropped')).toMatchObject({ detail: terminal === 'failed' ? '前一轮出错，排队的没跑' : '会话被停下了' });
    if (people) await vi.waitFor(() => expect(JSON.stringify(fake.send.mock.calls)).toContain('1 条排队消息'));
    else expect(JSON.stringify(fake.send.mock.calls)).not.toContain('条排队消息');
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('2 条排队消息');
    expect(fake.inputs).toHaveLength(1);
    await settle();
    if (terminal === 'stopped') expect(fake.reply.mock.calls.filter(([req]) => req.data.msg_type === 'post')).toHaveLength(0);
  });

  it.each([0, 1])('counts only people queued while a desktop resume fails (people=%s)', async people => {
    const gate = deferred<void>();
    fake.readHistory.mockImplementationOnce(async () => { await gate.promise; throw new Error('controlled resume'); });
    const resume = orchestrator.collaboration({ action: 'resume', projectName: 'demo', chatId: CHAT, sessionId: 'past', backend: 'codex-appserver' }).catch(() => undefined);
    try {
      await vi.waitFor(() => expect(fake.readHistory).toHaveBeenCalledOnce());
      const m = says('BOT_OCCUPIED', { at: true });
      await botSays(m); await decide(m, result('main'));
      await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
      if (people) {
        const human = says('HUMAN_OCCUPIED', { at: true });
        await send(human); await decide(human, result('main'));
        await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(call => call[1] === 'queued')).toHaveLength(2));
      }
      gate.resolve(); await resume;
      expect(records().filter(record => record.reason === 'bot-wake-dropped')).toEqual([expect.objectContaining({ detail: '会话被占用' })]);
      if (people) expect(JSON.stringify(fake.send.mock.calls)).toContain('切回期间收到的 1 条消息未执行，请重发');
      else expect(JSON.stringify(fake.send.mock.calls)).not.toContain('请重发');
      expect(fake.inputs).toEqual([]);
    } finally { gate.resolve(); await resume; }
  });

  it.each(['main', 'topic'] as const)('reports the actual %s location when desktop compact drops a bot queue', async place => {
    const key = place === 'main' ? CHAT : 'omt_compact_diagnostic';
    const location = place === 'main' ? {} : { thread: key };
    const gate = deferred<void>(); const entered = deferred<void>();
    const create = startThread.getMockImplementation();
    if (!create) throw new Error('thread fixture missing');
    startThread.mockImplementationOnce(async () => ({ ...await create(), compact: async () => {
      entered.resolve(); await gate.promise; return {};
    } }));
    const record = { threadId: key, chatId: CHAT, cwd: workspace, sessionId: 'native-fixture',
      backend: 'codex-appserver', summary: 'fixture', createdAt: 1, updatedAt: 1 };
    const list = vi.spyOn(sessionStore, 'listSessions').mockResolvedValue([record]);
    fake.sessions[key] = record;
    let compact: Promise<unknown> | undefined;
    try {
      const first = says('WARM_SESSION', { at: true, ...location });
      await send(first);
      if (place === 'main') await decide(first, result('main'));
      await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
      if (place === 'topic') fake.list.mockResolvedValueOnce({ code: 0, data: { items: [{ message_id: 'om_compact_root', chat_id: CHAT, thread_id: key }] } });
      compact = orchestrator.collaboration({ action: 'compact', projectName: 'demo', chatId: CHAT, threadId: key });
      await entered.promise;
      const bot = says('BOT_DURING_COMPACT', { at: true, ...location });
      await botSays(bot); await decide(bot, result(place === 'main' ? 'main' : 'reply'));
      await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(call => call[1] === 'queued')).toHaveLength(1));
      const human = says('HUMAN_DURING_COMPACT', { at: true, ...location });
      await send(human);
      if (place === 'main') await decide(human, result('main'));
      await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(call => call[1] === 'queued')).toHaveLength(2));
      gate.resolve(); await compact;
      expect(records().filter(record => record.reason === 'bot-wake-dropped')).toEqual([
        expect.objectContaining({ place, detail: '会话被占用' }),
      ]);
      expect(fake.send).toHaveBeenLastCalledWith(CHAT, { markdown: '操作期间收到的 1 条消息未执行，请重发。' }, place === 'topic' ? { replyTo: 'om_compact_root', replyInThread: true } : undefined);
      expect(fake.inputs).toHaveLength(1);
    } finally { gate.resolve(); await compact; list.mockRestore(); }
  });

  it('drops a queued bot during shutdown without adding diagnostics or asking for a resend', async () => {
    fake.project = { ...base, pendingPolicy: 'queue' };
    const gate = deferred<void>();
    fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('RUNNING', { at: true, thread: 'omt_shutdown_queue' })); await answered();
    const m = says('BOT_SHUTDOWN', { at: true, thread: 'omt_shutdown_queue' });
    await botSays(m); await decide(m, result('reply'));
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    const stopping = orchestrator.shutdown(); await settle(); gate.resolve(); await stopping;
    expect(records()).toEqual([]);
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('请重发');
    expect(fake.log.info).toHaveBeenCalledWith('bridge', 'shutdown_dropped', { queued: 1, held: 0, compacts: 0 });
    expect(fake.inputs).toHaveLength(1);
  });

  it('fetches a bot card text by id', async () => {
    const m = { ...says('', { at: true, thread: 'omt_card' }), message_type: 'interactive', content: JSON.stringify({ text: '降级占位' }) };
    const card = { ...memento(m), body: { content: JSON.stringify({ title: 'CARD_BODY_FIXTURE', elements: [] }) } };
    fake.get.mockResolvedValue({ code: 0, data: { items: [card] } });
    await botSays(m); await decide(m, result('reply')); await answered();
    expect(fake.inputs[0]).toContain('CARD_BODY_FIXTURE');
    const cardReads = fake.get.mock.calls.filter(([r]) => r.path.message_id === idOf(m) && 'params' in r && JSON.stringify(r).includes('card_msg_content_type'));
    expect(cardReads.length).toBeGreaterThan(0);
  });

  it.each([true, false])('resolves the sender with metadata when readable=%s', async readable => {
    const m = says('继续看', { at: true, thread: 'omt_sender' }); fake.list.mockResolvedValue(page([]));
    if (readable) fake.get.mockResolvedValue({ code: 0, data: { items: [memento(m)] } });
    else fake.get.mockRejectedValue(new Error('gone'));
    await botSays(m, 'cli_other'); await decide(m, result('reply')); await answered();
    if (readable) expect(fake.inputs[0]).toContain('open_id：ou_other');
    else { expect(fake.inputs[0]).not.toContain('本条消息的发信人'); expect(fake.inputs[0]).toContain(BOT_WAKE_NOTE('另一个 bot')); }
  });

  it.each(['intake', 'land'])('does not answer a wake already seen at %s', async stage => {
    const m = says('ALREADY_SEEN', { at: true });
    if (stage === 'intake') fake.sessions[CHAT] = { lastSeenAt: Number(m.create_time) + 1000 };
    await botSays(m);
    if (stage === 'land') {
      await judged(m); fake.sessions[CHAT] = { lastSeenAt: Number(m.create_time) + 1000 }; await decide(m, result('main'));
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
    await botSays(control); await decide(control, result('reply')); await answered();
  });

  it.each([['always', 'app'], ['always', 'bot'], ['failures', 'app'], ['failures', 'bot'], ['manual', 'app'], ['manual', 'bot']] as const)('a bot-started turn sends no completion reminder in %s and shows no bell (raw %s)', async (mode, senderType) => {
    cfg.preferences.completionReminder = { mode }; const m = says('提醒测试', { at: true, thread: 'omt_remind' });
    await rawBotSays(m, senderType); await decide(m, result('reply')); await answered();
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
    expect(fake.reply).not.toHaveBeenCalled(); expect(fake.log.info.mock.calls.some(c => c[1] === 'completion-reminder')).toBe(false);
    expect(JSON.stringify(fake.cards[0]?.[2])).not.toContain('完成后提醒我');
    expect(JSON.stringify(fake.liveCards.filter(c => c.id === 1))).not.toContain('完成后提醒我');
    if (mode === 'manual') {
      fake.project = { ...base, smart: false };
      await send(says('HUMAN_CONTROL', { at: true, thread: 'omt_person' })); await answered(2);
      await vi.waitFor(() => expect(JSON.stringify(fake.liveCards.filter(c => c.id === 2))).toContain('完成后提醒我'));
    }
  });

  it('keeps the wake envelope when a bot queues behind a human turn', async () => {
    fake.project = { ...base, pendingPolicy: 'queue' }; const gate = deferred<void>();
    fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('HUMAN_RUNNING', { at: true, thread: 'omt_queue' })); await answered();
    const m = says('BOT_QUEUED', { at: true, thread: 'omt_queue' }); fake.list.mockResolvedValue(page([memento(m)]));
    await botSays(m); await decide(m, result('reply')); await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    fake.sessions.omt_queue = { recalls: [{ id: 'om_withdrawn', at: Date.now(), who: { kind: 'user', openId: 'ou_owner' } }] };
    gate.resolve(); await answered(2);
    expect(fake.inputs[1]?.startsWith(BOT_WAKE_NOTE('小P'))).toBe(true);
    expect(fake.inputs[1]).toContain('撤回');
    expect(JSON.stringify(fake.liveCards.filter(c => c.id === 1))).toContain('完成后提醒我');
    expect(JSON.stringify(fake.cards[1]?.[2])).not.toContain('完成后提醒我');
    await vi.waitFor(() => expect(fake.liveCards.some(c => c.id === 2)).toBe(true));
    expect(JSON.stringify(fake.liveCards.filter(c => c.id === 2))).not.toContain('完成后提醒我');
  });

  it.each(['app', 'bot'] as const)('does not persist a bot waiting for the global run slot (raw %s)', async senderType => {
    await orchestrator.shutdown(); const file = join(paths.appDir, `wake-global-slot-${senderType}.json`);
    orchestrator = createOrchestrator(channel as never, { ...cfg, preferences: { ...cfg.preferences, maxConcurrentRuns: 1 } }, workspace, undefined, { droppedFile: file, attention: new FocusEverywhere() });
    const gate = deferred<void>(); fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('SLOT_OWNER', { at: true, thread: 'omt_slot_a' })); await answered();
    const m = says('BOT_WAITING', { at: true, thread: 'omt_slot_b' }); fake.list.mockResolvedValue(page([memento(m)]));
    await rawBotSays(m, senderType); await decide(m, result('reply')); await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
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
  await decide(m, result('reply'));
  await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
  const lookups = fake.log.warn.mock.calls.filter(c => ['quote-fetch-failed', 'wake-sender-lookup-failed'].includes(String(c[1])) && JSON.stringify(c[2]).includes(idOf(m).slice(-6)));
  expect(lookups).toHaveLength(2);
  expect(JSON.stringify(lookups)).not.toMatch(new RegExp(`${idOf(m)}|PRIVATE_BODY|小P`));
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
describe('judge usage wiring (s28b)', () => {
  const request = (): JudgeRequest => ({ variant: 'main', appId: APP, botName: BOT.name, group: { chatId: CHAT, name: 'demo', backend: 'codex-appserver' }, context: [], message: { at: 0, from: 'user', name: 'fixture', text: 'hello' } });
  it.each([true, false])('persists only sent results with a configured file: %s', async configured => {
    await orchestrator.shutdown();
    const dir = mkdtempSync(join(tmpdir(), 'smart-usage-'));
    const file = join(dir, 'judge-usage.json');
    try {
      orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { ...(configured ? { judgeUsageFile: file } : {}), attention: new FocusEverywhere() });
      fake.judgeDeps?.onResult?.(request(), result('skip'), { sent: true });
      fake.judgeDeps?.onResult?.(request(), result('skip'), { sent: false });
      await orchestrator.shutdown();
      if (configured) expect(JSON.parse(readFileSync(file, 'utf8')).days[localDay(Date.now())]).toEqual({ 'llm:codex-appserver': 1 });
      else expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('flushes usage without waiting for judge backend cleanup', async () => {
    await orchestrator.shutdown();
    const dir = mkdtempSync(join(tmpdir(), 'smart-usage-'));
    const file = join(dir, 'judge-usage.json');
    const pending = deferred<void>();
    fake.judgeShutdown.mockImplementation(() => pending.promise);
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { judgeUsageFile: file, attention: new FocusEverywhere() });
    fake.judgeDeps?.onResult?.(request(), result('skip'), { sent: true });
    let done = false;
    const shutdown = orchestrator.shutdown().then(() => { done = true; });
    try {
      await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8')).days[localDay(Date.now())]).toEqual({ 'llm:codex-appserver': 1 }), { timeout: 2500 });
      expect(done).toBe(false);
    } finally { pending.resolve(); await shutdown; rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('attention (s25g)', () => {
  const s = (n: number) => n * 1000;
  const m = (n: number) => n * 60_000;
  const timers = new Map<number, { at: number; fn(): void }>();
  let nextTimer = 0;
  const time = {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => { const h = ++nextTimer; timers.set(h, { at: clock + ms, fn }); return h; },
    clearTimer: (h: unknown) => { if (typeof h === 'number') timers.delete(h); },
  };
  async function advance(ms: number): Promise<void> {
    const end = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn(); await settle();
    }
    clock = end; await settle();
  }
  const noted = (reason: string) => events.flatMap(e => e.kind === 'notReplied' && e.record.reason === reason ? [{ ...e.record, times: e.times ?? 1 }] : []);
  const logged = (event: string) => fake.log.info.mock.calls.filter(([, e]) => e === event).map(([, , fields]) => fields);
  function privateLogs(messages: EventMessage[]): void {
    const rows = fake.log.info.mock.calls.filter(([, e]) => String(e).startsWith('attention')
      || ['glance-deferred', 'unjudged', 'judge-landed', 'lane-pruned', 'judge-dropped'].includes(String(e)));
    expect(rows.length).toBeGreaterThan(0);
    const text = JSON.stringify(rows); expect(text).not.toContain(BOT.name);
    for (const msg of messages) { expect(text).not.toContain(idOf(msg)); expect(text).not.toContain(JSON.parse(String(msg.content)).text); }
  }
  async function focus(): Promise<void> {
    const a = says('请解答关注度测试问题'); await send(a); await advance(s(20));
    await decide(a, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
  }
  beforeEach(async () => {
    timers.clear(); await orchestrator.shutdown();
    fake.events = async function* () { yield { type: 'turn_started', turnId: 'turn-fixture' }; yield { type: 'done', turnId: 'turn-fixture' }; };
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time });
  });

  it('waits for host acceptance before raising attention or granting a continuation', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).filter(group => group.groupId === CHAT).at(-1);
    const accepted = deferred<void>();
    fake.events = async function* () {
      await accepted.promise;
      yield { type: 'turn_started', turnId: 'turn-fixture' };
      yield { type: 'done', turnId: 'turn-fixture' };
    };
    const message = says('HOST_ACCEPTANCE', { at: true });
    try {
      await send(message); await decide(message, result('main'));
      await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
      expect(latest()?.group?.score).toBe(10);
      const early = says('NOT_ACCEPTED_YET'); await send(early); await settle();
      expect(asked.has(idOf(early))).toBe(false);
      accepted.resolve(); await settle();
      expect(latest()?.group?.score).toBe(100);
    } finally { accepted.resolve(); }
  });

  it('does not revive forgotten attention when an earlier host acceptance arrives late', async () => {
    await orchestrator.shutdown(); timers.clear();
    const attention = new Attention();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time, attention });
    const accepted = deferred<void>();
    fake.events = async function* () {
      await accepted.promise;
      yield { type: 'turn_started', turnId: 'turn-fixture' };
      yield { type: 'done', turnId: 'turn-fixture' };
    };
    const message = says('STALE_HOST_ACCEPTANCE', { at: true });
    try {
      await send(message); await decide(message, result('main'));
      await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
      attention.forget(CHAT);
      attention.arrive({ chatId: CHAT, place: CHAT }, clock);
      accepted.resolve(); await settle();
      expect(attention.snapshot()[0]?.group?.score).toBe(10);
      expect(attention.followup({ chatId: CHAT, place: CHAT }, clock, 'ou_owner')).toBe(false);
    } finally { accepted.resolve(); }
  });

  it('lets a newly changed prompt raise attention and grant its own follow-up after real acceptance', async () => {
    await orchestrator.shutdown(); timers.clear();
    const attention = new Attention();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time, attention });
    const first = says('PARTICIPATED_WITH_H1', { at: true });
    await send(first); await decide(first, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    const previous = attention.captureGroup(CHAT);
    expect(attention.snapshot()[0]?.group?.score).toBe(100);
    await advance(m(3));
    const next = says('ACCEPT_NEW_PROMPT_H2', { at: true });
    const incoming = await receive(next, { bot: BOT });
    await orchestrator.onMessage(incoming); await decide(next, result('main', { promptHash: 'h2' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2)); await settle();
    expect(attention.isCurrentGroup(CHAT, previous)).toBe(false);
    expect(attention.snapshot()[0]?.group?.score).toBe(100);
    expect(attention.followup({ chatId: CHAT, place: CHAT }, clock, incoming.senderId)).toBe(true);
  });

  it('keeps an older in-flight judgement from warming a replacement group generation', async () => {
    await orchestrator.shutdown(); timers.clear();
    const attention = new Attention();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time, attention });
    const first = says('ESTABLISH_H1', { at: true });
    await send(first); await decide(first, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    const delayed = says('OLD_GENERATION_JUDGEMENT', { at: true });
    const incoming = await receive(delayed, { bot: BOT });
    await orchestrator.onMessage(incoming); await judged(delayed);
    attention.forget(CHAT);
    attention.arrive({ chatId: CHAT, place: CHAT }, clock);
    const replacement = attention.captureGroup(CHAT);
    await decide(delayed, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2)); await settle();
    expect(attention.isCurrentGroup(CHAT, replacement)).toBe(true);
    expect(attention.snapshot()[0]?.group?.score).toBe(10);
    expect(attention.followup({ chatId: CHAT, place: CHAT }, clock, incoming.senderId)).toBe(false);
  });

  it('ignores a stale prompt hash when a newer judgement already reset the group', async () => {
    await orchestrator.shutdown(); timers.clear();
    const attention = new Attention();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time, attention });
    const first = says('INITIAL_PROMPT_H1', { at: true });
    await send(first); await decide(first, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    const delayed = says('LATE_OLD_PROMPT_H1', { at: true });
    await send(delayed); await judged(delayed);
    const fresh = says('NEWER_PROMPT_H2', { at: true });
    await send(fresh); await decide(fresh, result('main', { promptHash: 'h2' })); await settle();
    const replacement = attention.captureGroup(CHAT);
    expect(replacement).toBeDefined();
    await decide(delayed, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(3)); await settle();
    expect(attention.isCurrentGroup(CHAT, replacement)).toBe(true);
    expect(attention.snapshot()[0]?.group?.score).toBe(100);
  });

  it('keeps a failed backend launch cold after a judgement decided to reply', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).filter(group => group.groupId === CHAT).at(-1);
    startThread.mockRejectedValueOnce(new Error('fixture backend start refused'));
    const message = says('FAILED_START', { at: true });
    await send(message); await decide(message, result('main'));
    await vi.waitFor(() => expect(fake.send.mock.calls.some(call => JSON.stringify(call).includes('fixture backend start refused'))).toBe(true));
    expect(fake.inputs).toHaveLength(0);
    expect(latest()?.group?.score).toBe(10);
    const ordinary = says('NO_FAILED_START_SHORTCUT'); await send(ordinary); await settle();
    expect(asked.has(idOf(ordinary))).toBe(false);
  });

  it('keeps attention cold when a running goal refuses the judged message', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).filter(group => group.groupId === CHAT).at(-1);
    const running = deferred<void>();
    fake.events = async function* () {
      yield { type: 'turn_started', turnId: 'goal-fixture' };
      yield { type: 'text', itemId: 'goal-output', text: '正在整理' };
      await running.promise;
      yield { type: 'done', turnId: 'goal-fixture' };
    };
    try {
      await send(says('/goal 整理文档', { at: true, thread: 'omt_attention_goal' }));
      await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
      const message = says('GOAL_REFUSED_SMART_REPLY', { at: true, thread: 'omt_attention_goal' });
      await send(message); await decide(message, result('reply'));
      await vi.waitFor(() => expect(JSON.stringify(fake.send.mock.calls)).toContain('目标运行中'));
      expect(fake.inputs).toHaveLength(0);
      expect(latest()?.group?.score).toBe(10);
    } finally { running.resolve(); }
  });

  it('keeps a host-refused first turn cold even when its card was created', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).filter(group => group.groupId === CHAT).at(-1);
    fake.events = async function* () { yield { type: 'error', message: 'fixture host rejected input', willRetry: false }; };
    const message = says('HOST_REFUSED_INPUT', { at: true });
    await send(message); await decide(message, result('main'));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1)); await settle();
    expect(fake.inputs).toHaveLength(1);
    expect(latest()?.group?.score).toBe(10);
  });

  it('publishes every group attention stage without another arrival or model call', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).filter(group => group.groupId === CHAT).at(-1);
    await focus();
    expect(latest()?.group?.score).toBe(100);
    const calls = fake.judge.mock.calls.length;
    for (const [elapsed, score] of [[m(2), 75], [m(8), 50], [m(10), 25], [m(10), 10]] as const) {
      await advance(elapsed);
      expect(latest()?.group?.score).toBe(score);
      expect(fake.judge).toHaveBeenCalledTimes(calls);
    }
    expect(fake.inputs).toHaveLength(1);
    expect(timers.size).toBe(0);

    const next = says('AFTER_IDLE_GROUP'); await send(next); await settle();
    expect(latest()?.group?.score).toBe(10);
    expect(asked.has(idOf(next))).toBe(false);
    await advance(s(20));
    expect((await judged(next)).req.message.fresh).toBe(true);
  });

  it('renews group stage deadlines only when the bot actually replies again', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1);
    await focus(); await advance(m(9));
    const again = says('RENEW_GROUP', { at: true }); await send(again); await decide(again, result('main'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(2)); await settle();
    expect(timers.size).toBe(1);
    await advance(m(1)); expect(latest()?.group?.score).toBe(100);
    await advance(m(1)); expect(latest()?.group?.score).toBe(75);
    await advance(m(28)); expect(latest()?.group?.score).toBe(10);
    expect(timers.size).toBe(0);
  });

  it('uses one group score for main and topic participation and lets old topics cool', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1);
    await focus();
    const topic = says('TOPIC_PARTICIPATION', { at: true, thread: 'omt_keep_focus' });
    await send(topic); await decide(topic, result('reply')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(2)); await settle();
    const calls = fake.judge.mock.calls.length;
    expect(latest()?.group?.score).toBe(100);
    await advance(m(30));
    expect(latest()).toMatchObject({ group: { score: 10 }, focusedTopics: 0, watchedTopics: 1 });
    expect(fake.judge).toHaveBeenCalledTimes(calls);
    expect(timers.size).toBe(0);
    const next = says('OLD_TOPIC_RETURN', { thread: 'omt_keep_focus' }); await send(next); await settle();
    expect(asked.has(idOf(next))).toBe(false);
    await advance(s(20)); expect((await judged(next)).req.variant).toBe('topic');
  });

  it('keeps budget and natural attention stage deadlines independently', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1);
    await focus();
    let count = 45;
    const until = clock + m(15);
    const used = vi.spyOn(JudgeBudget.prototype, 'used').mockImplementation(() => count);
    const free = vi.spyOn(JudgeBudget.prototype, 'freeAt').mockReturnValue(until);
    try {
      const signal = says('KEEP_BUDGET_DEADLINE', { at: true }); await send(signal); await decide(signal, result('skip')); await settle();
      expect(timers.size).toBe(1);
      await advance(m(10));
      expect(latest()).toMatchObject({ group: { score: 50 }, budget: { kind: 'no-glance', until } });
      count = 0; await advance(until - clock);
      expect(latest()?.budget).toBeUndefined();
      expect(latest()?.group?.score).toBe(50);
      expect(timers.size).toBe(1);
      await advance(m(15)); expect(latest()?.group?.score).toBe(10);
      expect(timers.size).toBe(0);
    } finally { used.mockRestore(); free.mockRestore(); }
  });

  it('clears the focus expiry timer and ignores a late callback after shutdown', async () => {
    await focus();
    expect(timers.size).toBe(1);
    const late = [...timers.values()][0]!.fn;
    await orchestrator.shutdown();
    expect(timers.size).toBe(0);
    const count = events.length;
    await advance(m(11)); late(); await settle();
    expect(events).toHaveLength(count);
    expect(timers.size).toBe(0);
  });

  it('publishes actual budget thresholds through diagnostics, expires them and removes its timer on shutdown', async () => {
    let count = 45;
    const used = vi.spyOn(JudgeBudget.prototype, 'used').mockImplementation(() => count);
    const free = vi.spyOn(JudgeBudget.prototype, 'freeAt').mockImplementation(() => clock + s(30));
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1);
    try {
      const first = says('BUDGET_NOTICE', { at: true }); await send(first); await decide(first, result('skip')); await settle();
      expect(latest()?.budget).toEqual({kind: 'no-glance', until: clock + s(30)});
      count = 60;
      const named = says('NAMED_STILL_RUNS', { at: true }); await send(named); await decide(named, result('skip')); await settle();
      expect(latest()?.budget?.kind).toBe('named-only');
      count = 0; await advance(s(30));
      expect(latest()?.budget).toBeUndefined();
      count = 45;
      const last = says('STOP_BUDGET_TIMER', { at: true }); await send(last); await decide(last, result('skip')); await settle();
      expect(timers.size).toBeGreaterThan(0);
      await orchestrator.shutdown(); expect(timers.size).toBe(0);
    } finally { used.mockRestore(); free.mockRestore(); }
  });

  it('43. waits for twenty quiet seconds and marks the first glance fresh', async () => {
    const a = says('FIRST_PRIVATE'); await send(a); await settle(); expect(fake.judge).not.toHaveBeenCalled();
    await advance(s(19)); expect(asked.has(idOf(a))).toBe(false); await advance(s(1));
    const { req } = await judged(a); expect(req.message.fresh).toBe(true);
    expect(req.why).toContain('第一次看这里'); expect(req.why).toContain('1 条');
    expect(req.context.filter(l => l.fresh)).toEqual([]);
    expect(logged('attention')).toContainEqual(expect.objectContaining({ kind: 'glance', mode: 'watch', n: 1, old: 0 }));
  });
  it('44. batches unrelated arrivals without raising attention and uses the cold five-minute cadence', async () => {
    const a = says('BATCH_A'), b = says('BATCH_B'), c = says('BATCH_C');
    for (const msg of [a, b, c]) await send(msg); await advance(s(20));
    const { req } = await judged(c);
    expect([...asked.keys()]).toEqual([idOf(c)]);
    expect(req.context.filter(l => l.fresh).map(l => l.id)).toEqual([idOf(a), idOf(b)]);
    await decide(c, result('skip', { reason: '闲聊' })); await settle();
    expect(noted('judge-skip')).toHaveLength(1);
    expect(noted('judge-skip')[0]).toMatchObject({ times: 3, detail: '闲聊', ref: idOf(c).slice(-6) });
    expect(homeDecisions()).toEqual([expect.objectContaining({ decision: 'skip', trigger: 'glance', messageCount: 3, messageAt: Number(c.create_time), decidedAt: clock })]);
    const d = says('BATCH_D'); await send(d); await advance(s(20)); expect(asked.has(idOf(d))).toBe(false);
    await advance(m(5)); expect((await judged(d)).req.why).toContain('5 分钟没看这里了');
  });
  it('45. batches ten arrivals without bypassing the cold-start delay', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => says(`TEN_${i}`));
    for (const msg of msgs) await send(msg); await settle();
    expect(fake.judge).not.toHaveBeenCalled(); await advance(s(20));
    const { req } = await judged(msgs[9]!); expect(req.context.filter(l => l.fresh)).toHaveLength(9);
    expect(req.message.fresh).toBe(true); expect(logged('attention')).toContainEqual(expect.objectContaining({ n: 10 }));
  });
  it('46, 62. replies to the batch anchor and then judges focused messages immediately, with private logs', async () => {
    const a = says('导出接口 500 有人看吗'), b = says('顺便'), c = says('是生产环境');
    for (const msg of [a, b, c]) await send(msg); await advance(s(20));
    await decide(c, result('main', { anchor: idOf(a) })); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain('导出接口 500 有人看吗'); expect(fake.inputs[0]).toContain(INITIATIVE_NOTE);
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(a) });
    expect(logged('judge-landed')).toContainEqual(expect.objectContaining({ glance: true, looked: 3, trigger: idOf(a).slice(-6) }));
    const d = says('FOCUSED_PRIVATE'); await send(d); await settle(); const { req } = await judged(d);
    expect(req.why).toContain('刚在这里说过话'); expect(req.message.fresh).toBeUndefined();
    expect(logged('attention')).toContainEqual(expect.objectContaining({ kind: 'focus', mode: 'focus' })); privateLogs([a, b, c, d]);
  });
  it('47. falls back to the latest arrival when an anchor is only old context', async () => {
    const x = says('OLD_ANCHOR'); await send(x); await advance(s(20)); await decide(x, result('skip')); await settle();
    const a = says('CURRENT_ANCHOR'); await send(a); await advance(m(5));
    expect((await judged(a)).req.context).toContainEqual(expect.objectContaining({ id: idOf(x) }));
    await decide(a, result('main', { anchor: idOf(x) })); await vi.waitFor(() => expect(fake.cards).toHaveLength(1));
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(a) }); expect(logged('anchor-not-in-batch')).toHaveLength(1);
  });
  it('48. opens under the glance anchor and focuses the new topic', async () => {
    const a = says('TOPIC_A'), b = says('TOPIC_B'), c = says('TOPIC_C');
    for (const msg of [a, b, c]) await send(msg); await advance(s(20));
    fake.get.mockImplementationOnce(async () => ({ code: 0, data: { items: [{ create_time: '1' }] } }));
    await decide(c, result('topic', { anchor: idOf(a) })); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.cards[0]![3]).toEqual({ replyTo: idOf(a), replyInThread: true });
    const d = says('TOPIC_FOCUS', { thread: 'omt_opened' }); await send(d); await settle();
    expect((await judged(d)).req.variant).toBe('topic');
    expect(logged('attention')).toContainEqual(expect.objectContaining({ kind: 'focus', place: 'topic' }));
  });
  it('49. skips do not renew group attention, while ordinary hot messages still batch', async () => {
    const latest = () => events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1);
    await focus();
    const first = says('ONE_FOLLOWUP'); await send(first); await settle();
    await decide(first, result('skip')); await settle();
    const second = says('HOT_CHAT_ONE'), third = says('HOT_CHAT_TWO');
    await send(second); await send(third); await settle();
    expect(asked.has(idOf(second))).toBe(false); expect(asked.has(idOf(third))).toBe(false);
    await advance(s(5));
    const { req } = await judged(third);
    expect(req.context).toContainEqual(expect.objectContaining({ id: idOf(second), fresh: true }));
    expect(asked.has(idOf(second))).toBe(false);
    await decide(third, result('skip')); await settle();
    expect(latest()?.group?.score).toBe(100);
    await advance(m(2)); expect(latest()?.group?.score).toBe(75);
    await advance(m(28)); expect(latest()?.group?.score).toBe(10);
  });
  it('allows one main-area follow-up from the recent participant while other people batch', async () => {
    await focus();
    const other = says('ANOTHER_PERSONS_CHAT');
    await send(other, { openId: 'ou_someone_else', type: 'user', name: '李四' });
    await settle(); expect(asked.has(idOf(other))).toBe(false);
    const owner = says('MY_FOLLOWUP'); await send(owner); await settle();
    // The owner's continuation can pull the waiting batch forward, without
    // turning every later message from either person into an immediate look.
    expect((await judged(owner)).req.message.fresh).toBeUndefined();
    await decide(owner, result('skip')); await settle();
    const later = says('SECOND_FOLLOWUP'); await send(later); await settle();
    expect(asked.has(idOf(later))).toBe(false);
    await advance(s(5)); expect((await judged(later)).req.message.fresh).toBe(true);
  });

  it('shares the viewing cadence across topics while preserving each batch context and avoiding starvation', async () => {
    const a = says('TOPIC_A_ONLY', { thread: 'omt_batch_a' });
    const b = says('TOPIC_B_ONLY', { thread: 'omt_batch_b' });
    await send(a); await send(b); await advance(s(20));
    expect(fake.judge).toHaveBeenCalledTimes(1);
    await decide(a, result('skip')); await settle();
    expect(asked.has(idOf(b))).toBe(false);
    await advance(m(6));
    const { req } = await judged(b);
    expect(req.variant).toBe('topic');
    expect(req.context.some(line => line.id === idOf(a))).toBe(false);
    expect(req.message.text).toContain('TOPIC_B_ONLY');
    await decide(b, result('reply')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1)?.group?.score).toBe(100);
  });

  it('50. a named topic opening leaves pending main messages and rearms a short batch', async () => {
    const a = says('WAIT_FOR_TOPIC'); await send(a); expect(timers.size).toBe(1);
    const n = says('请开一个话题', { at: true }); await send(n); expect((await judged(n)).req.variant).toBe('main');
    expect(asked.has(idOf(a))).toBe(false); await decide(n, result('topic'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    expect(asked.has(idOf(a))).toBe(false);
    await advance(s(5));
    expect((await judged(a)).req.message.fresh).toBe(true); expect(logged('lane-pruned')).toEqual([]);
    expect(logged('attention')).toContainEqual(expect.objectContaining({ kind: 'glance' }));
  });
  it('51, 62. a named main reply prunes pending arrivals without spending another judgement', async () => {
    const a = says('PRUNE_PRIVATE'), n = says('MAIN_PRIVATE', { at: true }); await send(a); await send(n);
    await decide(n, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(logged('lane-pruned')).toContainEqual(expect.objectContaining({ n: 1 })); await advance(s(60));
    expect(asked.has(idOf(a))).toBe(false); expect(records()).toEqual([]); privateLogs([a, n]);
  });
  it('52. a named reply landing first supersedes the in-flight glance', async () => {
    const a = says('GLANCE_RACE'); await send(a); await advance(s(20));
    const n = says('NAMED_RACE', { at: true }); await send(n); await judged(n);
    await decide(n, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    await decide(a, result('main')); await settle();
    expect(noted('judge-superseded')).toHaveLength(1); expect(noted('judge-superseded')[0]?.times).toBe(1);
    expect(fake.inputs).toHaveLength(1); expect(startThread).toHaveBeenCalledTimes(1);
  });
  it('supersedes a glance topic after a named main reply lands during its anchor lookup', async () => {
    const a = says('LATE_TOPIC_ANCHOR'), b = says('LATE_TOPIC_BATCH');
    await send(a); await send(b); await advance(s(20));
    const lookup = deferred<void>();
    const entered = deferred<void>();
    fake.get.mockImplementation(async ({ path }) => {
      if (path.message_id === idOf(a)) { entered.resolve(); await lookup.promise; }
      return { code: 0, data: { items: [{ create_time: '1', ...(path.message_id.startsWith('card') ? { thread_id: 'omt_opened' } : {}) }] } };
    });
    try {
      await decide(b, result('topic', { anchor: idOf(a) })); await entered.promise;
      const n = says('NAMED_MAIN_WINS', { at: true }); await send(n); await decide(n, result('main'));
      await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
      expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(n) });
      lookup.resolve();
      await vi.waitFor(() => expect(fake.inputs.length > 1 || noted('judge-superseded').length === 1).toBe(true));
      expect(fake.inputs).toHaveLength(1); expect(startThread).toHaveBeenCalledTimes(1);
      expect(fake.cards).toHaveLength(1); expect(fake.inputs[0]).toContain('NAMED_MAIN_WINS');
      expect(noted('judge-superseded')).toMatchObject([{ ref: idOf(b).slice(-6), times: 2 }]);
      expect(logged('judge-landed')).toEqual([expect.objectContaining({ ref: idOf(n).slice(-6), decision: 'main' })]);
      const next = says('NEW_TOPIC_REQUEST'); await send(next);
      const { req } = await judged(next);
      expect(req.context.some(l => l.id === `act:${idOf(b)}` || l.text.includes('开了话题'))).toBe(false);
      // A new, later request can still use A: the discarded lookup left no anchor reservation.
      await decide(next, result('topic', { anchor: idOf(a) }));
      await vi.waitFor(() => expect(fake.cards).toHaveLength(2));
      expect(fake.cards[1]![3]).toMatchObject({ replyTo: idOf(a), replyInThread: true });
      expect(startThread).toHaveBeenCalledTimes(2);
    } finally { lookup.resolve(); }
  });
  it('53. a named arrival still runs when the earlier glance lands first', async () => {
    const a = says('GLANCE_FIRST'); await send(a); await advance(s(20));
    const n = says('NAMED_SECOND', { at: true }); await send(n); await judged(n);
    await decide(a, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    await decide(n, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(2));
    expect(noted('judge-superseded')).toEqual([]);
  });
  it('54. historical topics retain context without restoring permanent focus', async () => {
    const reg = createTopicRegistry({ dir: mkdtempSync(join(paths.appDir, 'topics-')), sessions: async () => [{ threadId: 'omt_v', chatId: CHAT, cwd: workspace, sessionId: 'past', backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 1 }] });
    for (const topicId of ['omt_t', 'omt_u', 'omt_v']) await reg.note(CHAT, { topicId, at: clock, from: topicId === 'omt_t' ? { kind: 'self' } : { kind: 'user', openId: 'ou_owner' } });
    await orchestrator.shutdown(); orchestrator = createOrchestrator(channel as never, cfg, workspace, reg, { time });
    const messages = ['omt_t', 'omt_u', 'omt_v'].map(thread => says('RETURN_TO_OLD_TOPIC', { thread }));
    for (const message of messages) await send(message);
    await settle(); expect(fake.judge).not.toHaveBeenCalled();
    await advance(s(20));
    await vi.waitFor(() => expect(fake.judge.mock.calls.length).toBeGreaterThan(0));
    expect(logged('attention-recover')).toEqual([]);
    for (const message of messages) {
      if (asked.has(idOf(message))) await decide(message, result('skip'));
    }
    await settle(); await advance(m(6));
    for (const message of messages) expect((await judged(message)).req.variant).toBe('topic');
    await vi.waitFor(() => expect(events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1)?.group?.score).toBe(10));
  });
  it('55, 62. defers at 45 uses, drops stale arrivals when budget returns, and does not count an empty glance', async () => {
    const used = vi.spyOn(JudgeBudget.prototype, 'used').mockReturnValue(45);
    const free = vi.spyOn(JudgeBudget.prototype, 'freeAt').mockReturnValue(clock + m(30));
    try {
      const a = says('STALE_PRIVATE'); await send(a); await advance(s(20)); expect(asked.has(idOf(a))).toBe(false);
      expect(logged('glance-deferred')).toHaveLength(1);
      expect(logged('glance-deferred')[0]).toMatchObject({ inMs: expect.any(Number) });
      const delay = logged('glance-deferred')[0]?.inMs; expect(delay).toBeGreaterThan(m(29)); expect(delay).toBeLessThanOrEqual(m(30));
      expect(noted('judge-budget')).toEqual([]); expect(timers.size).toBe(2); used.mockReturnValue(0);
      await advance(m(30)); expect(fake.judge).not.toHaveBeenCalled(); expect(logged('attention')).toEqual([]);
      expect(logged('unjudged')).toContainEqual(expect.objectContaining({ why: 'old', n: 1 })); expect(records()).toEqual([]);
      const b = says('FRESH_PRIVATE'); await send(b); await advance(s(20)); const { req } = await judged(b);
      expect(req.context.filter(l => l.fresh)).toEqual([]); expect(req.why).toContain('第一次看这里'); privateLogs([a, b]);
    } finally { used.mockRestore(); free.mockRestore(); }
  });
  it('56. preserves natural attention at exhaustion, diagnoses once, and treats a glance-cap race separately', async () => {
    await focus(); const take = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValueOnce(false);
    try {
      const d = says('FREEZE_ME'); await send(d); await settle(); expect(asked.has(idOf(d))).toBe(false);
      expect(events.flatMap(event => event.kind === 'attention' ? event.groups : []).at(-1)?.group?.score).toBe(100);
      expect(logged('unjudged')).toContainEqual(expect.objectContaining({ why: 'budget', noted: true }));
      expect(noted('judge-budget')).toHaveLength(1); expect(noted('judge-budget')[0]).toMatchObject({ times: 1 });
      expect(noted('judge-budget')[0]?.detail).toBeUndefined();
      const e = says('AFTER_FREEZE'); await send(e); await settle(); expect(asked.has(idOf(e))).toBe(false);
      await advance(s(5)); expect((await judged(e)).req.message.fresh).toBe(true); await decide(e, result('skip')); await settle();
      take.mockReturnValueOnce(false); const f = says('CAP_RACE'); await send(f); await advance(m(6));
      expect(asked.has(idOf(f))).toBe(false); expect(logged('unjudged')).toContainEqual(expect.objectContaining({ why: 'glance-cap' }));
      expect(logged('attention-freeze')).toEqual([]); expect(noted('judge-budget')).toHaveLength(1);
    } finally { take.mockRestore(); }
  });
  it('57. drops queued work after a switch to rules or disabling the group', async () => {
    const a = says('RULE_PENDING'); await send(a); fake.project = { ...base, smart: false }; await advance(s(20));
    expect(fake.judge).not.toHaveBeenCalled(); expect(records()).toEqual([]);
    expect(logged('judge-dropped')).toContainEqual(expect.objectContaining({ why: 'rule-mode' }));
    fake.project = { ...base }; const b = says('DISABLED_PENDING'); await send(b); fake.project = { ...base, enabled: false };
    await advance(m(5)); expect(fake.judge).not.toHaveBeenCalled(); expect(records()).toEqual([]);
    expect(logged('judge-dropped')).toContainEqual(expect.objectContaining({ why: 'disabled' }));
  });
  it('59. resets attention when the prompt hash changes', async () => {
    const a = says('HASH_FIRST'); await send(a); await advance(s(20)); await decide(a, result('main', { promptHash: 'h1' }));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await settle();
    for (const { text, hash } of [{ text: 'HASH_SAME', hash: 'h1' }, { text: 'HASH_CHANGED', hash: 'h2' }]) {
      const msg = says(text); await send(msg); await settle(); await advance(s(5)); await decide(msg, result('skip', { promptHash: hash })); await settle();
    }
    expect(logged('attention-forget')).toContainEqual(expect.objectContaining({ why: 'prompt' }));
    const d = says('HASH_RESET'); await send(d); await settle(); expect(asked.has(idOf(d))).toBe(false);
    await advance(s(20)); expect((await judged(d)).req.why).toContain('第一次看这里');
  });
  it('60. removes recalled pending work and its timer', async () => {
    const a = says('RECALL_PENDING'); await send(a);
    await orchestrator.onRecall({ messageId: idOf(a), chatId: CHAT }); expect(timers.size).toBe(0);
    await advance(s(60)); expect(fake.judge).not.toHaveBeenCalled(); expect(records()).toEqual([]);
  });
  it('61. shuts down pending work without persisting it as dropped', async () => {
    const file = join(paths.appDir, `attention-dropped-${sequence}.json`);
    await orchestrator.shutdown(); orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { time, droppedFile: file });
    const a = says('STOP_PENDING'); await send(a); expect(timers.size).toBe(1);
    await orchestrator.shutdown(); expect(timers.size).toBe(0); await advance(s(60)); expect(fake.judge).not.toHaveBeenCalled();
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain(idOf(a));
  });
  it('63. a bot skip leaves waiting work, and a bot reply prunes it', async () => {
    const botSays = (msg: EventMessage) => {
      fake.list.mockResolvedValue({ code: 0, data: { items: [
        { message_id: idOf(msg), create_time: msg.create_time, msg_type: 'text', body: { content: msg.content }, sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' }, mentions: [{ id: BOT.openId, id_type: 'open_id', key: '@_user_1', name: BOT.name }] },
        { message_id: 'om_person', create_time: String(Number(msg.create_time) - 60000), msg_type: 'text', body: { content: '{"text":"earlier"}' }, sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' } },
      ], has_more: false } });
      return send(msg, { openId: 'ou_other', type: 'app', name: '小P' });
    };
    const a = says('WAIT_BOT_SKIP'); await send(a); const bot = says('BOT_SKIP', { at: true }); await botSays(bot);
    await decide(bot, result('skip')); await settle(); expect(noted('judge-skip')).toHaveLength(1); expect(asked.has(idOf(a))).toBe(false);
    await advance(s(20)); await decide(a, result('skip')); await settle();
    const b = says('WAIT_BOT_REPLY'); await send(b); const bot2 = says('BOT_REPLY', { at: true }); await botSays(bot2);
    await decide(bot2, result('reply')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(logged('lane-pruned')).toContainEqual(expect.objectContaining({ n: 1 })); await advance(m(5)); expect(asked.has(idOf(b))).toBe(false);
  });
  it('64. a direct topic mention prunes pending work and focuses the topic', async () => {
    const a = says('TOPIC_PENDING', { thread: 'omt_t' }); await send(a);
    const n = says('TOPIC_NAMED', { at: true, thread: 'omt_t' }); await send(n); await decide(n, result('reply'));
    await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); expect(fake.judge).toHaveBeenCalledTimes(1);
    expect(logged('lane-pruned')).toContainEqual(expect.objectContaining({ n: 1 }));
    const b = says('TOPIC_AFTER', { thread: 'omt_t' }); await send(b); await settle(); await judged(b);
    expect(logged('attention')).toContainEqual(expect.objectContaining({ kind: 'focus', place: 'topic' }));
  });
  it('65. refuses an in-flight named judgement after changing to rules, while new rules still run', async () => {
    const msg = says('SMART_NAMED', { at: true }); await send(msg); await judged(msg); fake.project = { ...base, smart: false };
    await decide(msg, result('main')); await settle(); expect(fake.inputs).toEqual([]); expect(fake.cards).toEqual([]);
    expect(noted('group-updating')).toHaveLength(1); expect(noted('group-updating')[0]?.ref).toBe(idOf(msg).slice(-6));
    expect(fake.unreact).toHaveBeenCalled(); const count = fake.judge.mock.calls.length;
    await send(says('RULE_NAMED', { at: true })); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); expect(fake.judge).toHaveBeenCalledTimes(count);
  });
});

describe('bot handoffs (s27b)', () => {
  beforeEach(replyToHumanTopics);
  const bots = [{ app_id: 'cli_other', member_id: 'ou_other', name: '小P' }, { app_id: 'cli_审', member_id: 'ou_审', name: '小审' }];
  const answers = (text: string) => { fake.events = async function* () { yield { type: 'text', itemId: 'a', text }; yield { type: 'done', turnId: 'turn-fixture' }; }; };
  const replies = (type = 'text') => fake.reply.mock.calls.map(([req]) => req).filter(req => req.data.msg_type === type);
  const textOf = (): string => JSON.parse(replies()[0]!.data.content).text;
  const finalText = () => JSON.stringify(fake.finals.at(-1));
  const landed = async () => { await vi.waitFor(() => expect(fake.log.info.mock.calls.some(c => c[1] === 'final')).toBe(true)); await settle(); };
  const handoff = (fields: object) => expect(fake.log.info).toHaveBeenCalledWith(expect.any(String), 'handoff', expect.objectContaining(fields));
  async function turn(text = '@小审 请审一下。', place: 'reply' | 'main' | 'topic' = 'reply') {
    answers(text); const m = says('请写方案', { at: true, ...(place === 'reply' ? { thread: 'omt_handoff' } : {}) });
    await send(m); if (place !== 'reply') await decide(m, result(place)); await landed();
  }
  async function botTurn(text: string) {
    answers(text); const m = says('请修改', { at: true, thread: 'omt_handoff' });
    fake.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: idOf(m), create_time: m.create_time, msg_type: 'text', body: { content: m.content }, sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' } }], has_more: false } });
    await send(m, { openId: 'ou_other', type: 'app', name: '小P' }); await decide(m, result('reply')); await landed();
  }
  beforeEach(() => { fake.request.mockResolvedValue({ code: 0, data: { bots } }); });

  it('24: a person’s turn in a smart group hands off and sends no completion reminder', async () => {
    cfg.preferences.completionReminder = { mode: 'always' };
    fake.reply.mockImplementation(async () => { expect(fake.finals).toHaveLength(1); expect(finalText()).not.toContain('→ 想 @'); return { code: 0, data: { message_id: 'om_reply' } }; });
    await turn('方案在上面。\n@小审 请审一下。');
    expect(fake.reply.mock.calls.map(([req]) => req.data.msg_type)).toEqual(['text']);
    expect(replies()[0]).toMatchObject({ path: { message_id: 'card_1' }, data: { reply_in_thread: true } });
    expect(textOf()).toBe('<at user_id="ou_审">小审</at> 请审一下。');
    expect(replies('post')).toEqual([]); handoff({ sent: true });
  });
  it.each(['main', 'topic'] as const)('25/25a: main-area mention judged %s wires smart handoffs', async place => {
    await turn('@小审 请审一下。', place); expect(replies()).toHaveLength(1); expect(replies()[0]!.data.reply_in_thread).toBe(place === 'topic');
    expect(fake.inputs[0]).toContain(AT_HINT_NOTE(['小P', '小审']));
  });
  it('26: supplies context for an empty sentence', async () => { await turn('@小审'); expect(textOf()).toBe('<at user_id="ou_审">小审</at> 请看上面的回答'); });
  it('27: sends one message for multiple recipients', async () => {
    await turn('@小审 @小P 你们看看'); expect(replies()).toHaveLength(1); expect(textOf()).toBe('<at user_id="ou_审">小审</at> <at user_id="ou_other">小P</at> 你们看看');
  });
  it.each(['code', 'throw-code'])('29: a business error (%s) is failed delivery without a success reminder', async failure => {
    cfg.preferences.completionReminder = { mode: 'always' };
    fake.reply.mockImplementation(async req => { if (req.data.msg_type === 'text') { if (failure === 'throw-code') throw { response: { data: { code: 230001 } } }; return { code: 230001, data: { message_id: '' } }; } return { code: 0, data: { message_id: 'om_reminder' } }; });
    await turn(); expect(fake.finals).toHaveLength(2); expect(finalText()).toContain("<font color='grey'>→ 想 @ 小审（bot），没发出：发送失败</font>");
    expect(replies('post')).toHaveLength(0); handoff({ sent: false, why: 'send-failed', code: 230001 });
  });
  it('30: timeout reports unknown delivery and ignores late success', async () => {
    const gate = deferred<{ code: number; data: { message_id: string } }>(); fake.reply.mockImplementation(() => gate.promise);
    answers('@小审 请审'); await send(says('请写', { at: true, thread: 'omt_handoff' })); await vi.waitFor(() => expect(replies()).toHaveLength(1));
    try {
      await vi.waitFor(() => expect(fake.finals).toHaveLength(2), { timeout: 11_000, interval: 50 });
      expect(finalText()).toContain('没收到发送结果：超时'); handoff({ sent: 'unknown', why: 'timeout' });
      gate.resolve({ code: 0, data: { message_id: 'om_late' } }); await settle(); expect(fake.finals).toHaveLength(2); expect(replies()).toHaveLength(1);
    } finally { gate.resolve({ code: 0, data: { message_id: 'om_late' } }); }
  }, 15_000);
  it('31: failed final card delivery prevents handoff', async () => { fake.finalOk = false; await turn(); expect(replies()).toEqual([]); expect(fake.finals).toHaveLength(1); handoff({ why: 'finalize-failed' }); });
  it('32: bot-started turns send exactly one handoff with no reminder in always mode', async () => {
    cfg.preferences.completionReminder = { mode: 'always' }; await botTurn('改好了。@小P 请再看一遍。');
    expect(fake.reply).toHaveBeenCalledOnce(); expect(textOf()).toBe('<at user_id="ou_other">小P</at> 请再看一遍。'); expect(replies('post')).toEqual([]);
    expect(fake.log.info.mock.calls.some(c => c[1] === 'completion-reminder')).toBe(false); handoff({ sent: true });
  });
  it('32a: bot-started answers without @ send nothing', async () => { cfg.preferences.completionReminder = { mode: 'always' }; await botTurn('修改好了。'); expect(fake.reply).not.toHaveBeenCalled(); });
  it('33: stopped partial answers do not hand off', async () => {
    const gate = deferred<void>(); fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '@小审 请审' }; await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('请写', { at: true, thread: 'omt_handoff' })); await vi.waitFor(() => expect(fake.liveCards.length).toBeGreaterThan(0));
    const stopping = orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.stop', m: 'card_1' } } } as never);
    await settle(); gate.resolve(); await stopping; await landed();
    expect(fake.log.info.mock.calls.some(c => c[1] === 'final' && c[2]?.terminal === 'interrupted')).toBe(true); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @');
  });
  it('34: failed partial answers do not hand off', async () => {
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '@小审 请审' }; yield { type: 'error', message: 'boom', willRetry: false }; };
    await send(says('请写', { at: true, thread: 'omt_handoff' })); await landed(); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @');
  });
  it('35: rule groups keep @ names as ordinary answer text', async () => { fake.project = { ...base, smart: false }; await turn(); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @'); });
  it.each(['@张三 请看', '@小码 请看'])('36/37: unknown and self names stay text: %s', async text => { await turn(text); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @'); });
  it('38: unavailable roster causes no speculative footnote', async () => {
    fake.request.mockRejectedValue(new Error('unavailable')); await turn(); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @'); handoff({ why: 'no-roster' });
  });
  it.each([false, true])('38a/b: ambiguous names add a footnote and distinct recipients still send (%s)', async mixed => {
    fake.request.mockResolvedValue({ code: 0, data: { bots: [...bots, { app_id: 'cli_审b', member_id: 'ou_审b', name: '小审' }, { app_id: 'cli_丁', member_id: 'ou_丁', name: '小丁' }] } });
    await turn(mixed ? '@小审 @小丁 看' : '@小审 请审'); expect(fake.finals).toHaveLength(2);
    expect(finalText()).toContain("<font color='grey'>→ 想 @ 小审（bot），没交接：群里不止一个叫 小审 的 bot</font>"); expect(finalText()).not.toContain('ou_审'); expect(finalText()).not.toContain('没发出');
    expect(replies()).toHaveLength(mixed ? 1 : 0); if (mixed) { expect(textOf()).toBe('<at user_id="ou_丁">小丁</at> 看'); handoff({ sent: true, ambiguous: 1 }); } else handoff({ why: 'ambiguous', names: 1 });
  });
  it('39: shutdown releases a pending handoff without updating the card again', async () => {
    const gate = deferred<{ code: number; data: { message_id: string } }>(); fake.reply.mockImplementation(() => gate.promise);
    answers('@小审 请审'); await send(says('请写', { at: true, thread: 'omt_handoff' })); await vi.waitFor(() => expect(replies()).toHaveLength(1));
    await Promise.race([orchestrator.shutdown(), new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown blocked')), 3000))]);
    expect(fake.finals).toHaveLength(1); handoff({ sent: 'unknown', why: 'shutdown' }); gate.resolve({ code: 0, data: { message_id: 'om_late' } });
  });
  it('a private chat never hands off or adds footnotes', async () => {
    answers('@小审 请审');
    await send({ ...says('请写', { at: true }), chat_type: 'p2p' }); await settle();
    expect(fake.inputs).toEqual([]); expect(fake.finals).toEqual([]); expect(replies()).toEqual([]);
  });
  it.each(['throw', 'missing-code'])('a reply with no confirmed result (%s) is unknown delivery', async failure => {
    fake.reply.mockImplementation(async () => { if (failure === 'throw') throw new Error('send failed'); return JSON.parse('{"data":{"message_id":"om_no_code"}}'); });
    await turn(); expect(fake.finals).toHaveLength(2);
    expect(finalText()).toContain('没收到发送结果：可能已发出'); handoff({ sent: 'unknown', why: 'no-result' }); expect(replies()).toHaveLength(1);
  });
  it('a partial roster cannot send until completeness recovers', async () => {
    fake.request.mockResolvedValue({ code: 0, data: { bots, has_more: true } });
    await turn(); expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @'); handoff({ why: 'no-roster' });
    fake.request.mockResolvedValue({ code: 0, data: { bots, has_more: false } });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    try { await turn('@小审 再审一下。'); await vi.waitFor(() => expect(replies()).toHaveLength(1)); handoff({ sent: true }); } finally { now.mockRestore(); }
  });
  it('an SDK request accepted before disconnect is unknown delivery and is never retried', async () => {
    cfg.preferences.completionReminder = { mode: 'always' };
    let accepted = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.includes('/auth/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, tenant_access_token: 'fixture', expire: 7200 })); return; }
        accepted++; req.socket.destroy();
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test server address');
    const client = new Client({ appId: APP, appSecret: 'fixture', domain: `http://127.0.0.1:${address.port}` });
    // SDK URL interpolation also treats the local port as a path parameter.
    fake.reply.mockImplementation(req => client.im.v1.message.reply({ ...req, path: { ...req.path, [address.port]: `:${address.port}` } }, withTenantToken('fixture')));
    try {
      await turn(); expect(accepted).toBe(1); expect(replies()).toHaveLength(1);
      expect(finalText()).toContain('没收到发送结果：可能已发出'); handoff({ sent: 'unknown', why: 'no-result' });
      await settle(); expect(accepted).toBe(1); expect(fake.reply).toHaveBeenCalledOnce(); expect(replies('post')).toEqual([]);
    } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); }
  });
  it('shutdown during an ambiguous roster lookup never sends or repaints', async () => {
    const gate = deferred<unknown>();
    fake.request.mockResolvedValueOnce({ code: 0, data: { bots } }).mockImplementation(() => gate.promise);
    vi.useFakeTimers({ toFake: ['Date'] });
    fake.events = async function* () {
      yield { type: 'text', itemId: 'a', text: '@小审 请审' };
      // The input hint used the initial roster; only the final handoff refresh hangs.
      vi.setSystemTime(Date.now() + 600_001);
      yield { type: 'done', turnId: 'turn-fixture' };
    };
    try {
      await send(says('请写', { at: true, thread: 'omt_handoff' }));
      await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
      await vi.waitFor(() => expect(fake.request).toHaveBeenCalledTimes(2));
      const stopping = orchestrator.shutdown();
      gate.resolve({ code: 0, data: { bots: [...bots, { app_id: 'cli_审b', member_id: 'ou_审b', name: '小审' }] } });
      await stopping; await settle(); expect(fake.finals).toHaveLength(1); expect(replies()).toEqual([]);
      expect(finalText()).not.toContain('→ 想 @'); handoff({ why: 'shutdown' });
    } finally { vi.useRealTimers(); gate.resolve({ code: 0, data: { bots } }); }
  });
  it('40: queued turns hand off separately on their own cards', async () => {
    fake.project = { ...base, pendingPolicy: 'queue' }; const gate = deferred<void>(); let runs = 0;
    fake.events = async function* () { if (++runs === 1) await gate.promise; yield { type: 'text', itemId: 'a', text: '@小审 请审' }; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('第一轮', { at: true, thread: 'omt_handoff' })); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1)); await send(says('第二轮', { at: true, thread: 'omt_handoff' }));
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything())); gate.resolve(); await vi.waitFor(() => expect(replies()).toHaveLength(2));
    expect(replies().map(req => req.path.message_id)).toEqual(['card_1', 'card_2']);
  });
});

describe('people @ and brakes (s27b2)', () => {
  beforeEach(replyToHumanTopics);
  const bots = [{ app_id: 'cli_other', member_id: 'ou_other', name: '小P' }, { app_id: 'cli_审', member_id: 'ou_审', name: '小审' }];
  const people = [{ member_id: 'ou_owner', name: '王五' }, { member_id: 'ou_张', name: '张三' }, { member_id: 'ou_张丰', name: '张三丰' }, { member_id: 'ou_李', name: '李四' }];
  const page = (items = people, has_more = false) => ({ code: 0, data: { items, has_more, ...(has_more ? { page_token: 'p2' } : {}) } });
  const replies = (type = 'text') => fake.reply.mock.calls.map(([req]) => req).filter(req => req.data.msg_type === type);
  const textOf = (): string => JSON.parse(replies().at(-1)!.data.content).text;
  const finalText = () => JSON.stringify(fake.finals.at(-1));
  const handoff = (fields: object) => expect(fake.log.info).toHaveBeenCalledWith(expect.any(String), 'handoff', expect.objectContaining(fields));
  const answers = (text: string) => { fake.events = async function* () { yield { type: 'text', itemId: 'a', text }; yield { type: 'done', turnId: 'turn-fixture' }; }; };
  async function turn(text: string) {
    const previous = fake.log.info.mock.calls.filter(c => c[1] === 'final').length;
    answers(text); await send(says('请写方案', { at: true, thread: 'omt_people' }));
    await vi.waitFor(() => expect(fake.log.info.mock.calls.filter(c => c[1] === 'final')).toHaveLength(previous + 1)); await settle();
  }
  beforeEach(() => {
    fake.request.mockResolvedValue({ code: 0, data: { bots } }); fake.members.mockResolvedValue(page());
    fake.get.mockResolvedValue({ code: 0, data: { items: [{ sender: { id: 'ou_owner', sender_name: '王五' } }] } });
  });

  it('31: mentions the human requester in a threaded text reply', async () => {
    cfg.preferences.completionReminder = { mode: 'always' };
    await turn('做好了。@王五 请看。');
    expect(replies()).toHaveLength(1); expect(textOf()).toBe('<at user_id="ou_owner">王五</at> 请看。');
    expect(replies()[0]).toMatchObject({ path: { message_id: 'card_1' }, data: { reply_in_thread: true } }); expect(fake.reply).toHaveBeenCalledOnce(); expect(replies('post')).toEqual([]); handoff({ sent: true, persons: 1 });
  });
  it('32: combines bot and human recipients in one reply', async () => {
    await turn('@小审 @张三 一起看看'); expect(replies()).toHaveLength(1);
    expect(textOf()).toBe('<at user_id="ou_审">小审</at> <at user_id="ou_张">张三</at> 一起看看');
  });
  it('33: sends the first five recipients and explains the rest in a grey footnote', async () => {
    fake.members.mockResolvedValue(page([...people, { member_id: 'ou_赵', name: '赵六' }, { member_id: 'ou_钱', name: '钱七' }]));
    await turn('@小审 @小P @张三 @李四 @王五 @赵六 @钱七 看');
    expect(replies()).toHaveLength(1); expect(textOf().match(/<at user_id="[^"]+">/g)).toEqual(['ou_审', 'ou_other', 'ou_张', 'ou_李', 'ou_owner'].map(id => `<at user_id="${id}">`));
    expect(fake.finals).toHaveLength(2); expect(finalText()).toContain("<font color='grey'>→ 还想 @ 赵六、钱七，没发：一条最多 @ 5 个</font>"); handoff({ over: 2 });
  });
  it('34: never emits an everyone tag alongside a known person', async () => {
    await turn('照抄：@所有人 明天开会 <at user_id="all">所有人</at>。@张三 请确认。');
    expect(replies()).toHaveLength(1); expect(textOf().match(/<at /g)).toHaveLength(1); expect(textOf()).toContain('user_id="ou_张"'); expect(textOf()).not.toContain('user_id="all"');
  });
  it('35: ignores even a member named everyone, while ordinary people can be mentioned', async () => {
    fake.members.mockResolvedValue(page([...people, { member_id: 'ou_所', name: '所有人' }]));
    await turn('@所有人 明天开会'); expect(fake.reply).not.toHaveBeenCalled(); expect(fake.finals).toHaveLength(1);
    await turn('@张三 明天开会'); expect(replies()).toHaveLength(1); expect(textOf()).toContain('user_id="ou_张"');
  });
  it('36: ignores quoted mentions but sends the unquoted counterpart', async () => {
    await turn('> @张三 说要改\n\n好的，已改。'); expect(fake.reply).not.toHaveBeenCalled();
    await turn('@张三 说要改\n\n好的，已改。'); expect(replies()).toHaveLength(1); expect(textOf()).toContain('user_id="ou_张"');
  });
  it('37: explains duplicate human names without sending', async () => {
    fake.members.mockResolvedValue(page([...people, { member_id: 'ou_张b', name: '张三' }]));
    await turn('@张三 看'); expect(replies()).toEqual([]); expect(fake.finals).toHaveLength(2);
    expect(finalText()).toContain('→ 想 @ 张三，没发：群里不止一个叫 张三 的成员'); handoff({ why: 'ambiguous', names: 1 });
  });
  it('38: blocks bot mentions too when the first people page fails', async () => {
    fake.members.mockRejectedValue(new Error('unavailable')); await turn('@张三 @小审 看');
    expect(replies()).toEqual([]); expect(fake.finals).toHaveLength(2);
    expect(finalText()).toContain('→ 想 @ 小审（bot），没发：群成员名单没读全，认不准有没有重名'); handoff({ incomplete: true, people: false, why: 'incomplete' });
  });
  it('38a: discovers duplicate names across pages', async () => {
    fake.members.mockResolvedValueOnce(page([{ member_id: 'ou_张', name: '张三' }, { member_id: 'ou_王', name: '王五' }], true)).mockImplementationOnce(async req => {
      expect(req.params.page_token).toBe('p2'); return page([{ member_id: 'ou_张b', name: '张三' }]);
    });
    await turn('@张三 看看'); expect(fake.members).toHaveBeenCalledTimes(2); expect(replies()).toEqual([]);
    expect(finalText()).toContain('→ 想 @ 张三，没发：群里不止一个叫 张三 的成员'); handoff({ why: 'ambiguous', names: 1 });
  });
  it('38b: a failed later page blocks both human and bot candidates', async () => {
    fake.members.mockResolvedValueOnce(page([{ member_id: 'ou_张', name: '张三' }], true)).mockRejectedValueOnce(new Error('unavailable'));
    await turn('@张三 @小审 看'); expect(replies()).toEqual([]);
    expect(finalText()).toContain('→ 想 @ 张三、小审（bot），没发：群成员名单没读全，认不准有没有重名'); handoff({ incomplete: true, unverified: 2 });
  });
  it('38c: sends unique recipients from every completed page', async () => {
    fake.members.mockResolvedValueOnce(page(people.slice(0, 2), true)).mockResolvedValueOnce(page([people[3]!]));
    await turn('@张三 @李四 @小审 看'); expect(replies()).toHaveLength(1);
    expect(textOf()).toBe('<at user_id="ou_张">张三</at> <at user_id="ou_李">李四</at> <at user_id="ou_审">小审</at> 看'); expect(finalText()).not.toContain('→ 想 @');
    expect(fake.log.info.mock.calls.filter(c => c[1] === 'handoff').at(-1)?.[2]).not.toHaveProperty('incomplete');
  });
  it('38d: retains stale candidates as unverified until a complete refresh recovers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      fake.members.mockResolvedValueOnce(page([{ member_id: 'ou_张', name: '张三' }])); await turn('@张三 看'); expect(textOf()).toContain('user_id="ou_张"');
      vi.setSystemTime(Date.now() + PEOPLE_TTL_MS + 1);
      fake.members.mockResolvedValueOnce(page([{ member_id: 'ou_王', name: '王五' }], true)).mockRejectedValueOnce(new Error('unavailable'));
      await turn('@张三 @小审 看'); expect(replies()).toHaveLength(1);
      expect(finalText()).toContain('→ 想 @ 张三、小审（bot），没发：群成员名单没读全，认不准有没有重名'); handoff({ incomplete: true });
      vi.setSystemTime(Date.now() + PEOPLE_RETRY_MS + 1);
      fake.members.mockResolvedValueOnce(page([{ member_id: 'ou_王', name: '王五' }], true)).mockResolvedValueOnce(page([{ member_id: 'ou_张', name: '张三' }]));
      await turn('@张三 @小审 看'); expect(replies()).toHaveLength(2); expect(textOf()).toBe('<at user_id="ou_张">张三</at> <at user_id="ou_审">小审</at> 看');
      expect(fake.log.info.mock.calls.filter(c => c[1] === 'handoff').at(-1)?.[2]).not.toHaveProperty('incomplete');
    } finally { vi.useRealTimers(); }
  });
  it('43: rule groups retain completion reminders and never translate answer mentions', async () => {
    fake.project = { ...base, smart: false }; cfg.preferences.completionReminder = { mode: 'always' };
    await turn('@张三 看'); expect(replies()).toEqual([]); expect(replies('post')).toHaveLength(1); expect(replies('post')[0]!.data.content).toContain('ou_owner');
  });
  it.each([false, true])('45: places the mention hint before the human sender, with empty roster=%s', async empty => {
    if (empty) fake.request.mockResolvedValue({ code: 0, data: { bots: [] } });
    await turn('好的'); const input = fake.inputs[0]!; const hint = AT_HINT_NOTE(empty ? [] : ['小P', '小审']);
    expect(input).toContain(hint); expect(input.indexOf(hint)).toBeLessThan(input.indexOf('[本条消息的发信人：'));
  });
  it('45: omits ambiguous bot names from the hint', async () => {
    fake.request.mockResolvedValue({ code: 0, data: { bots: [...bots, { app_id: 'cli_审b', member_id: 'ou_审b', name: '小审' }] } });
    await turn('好的'); expect(fake.inputs[0]).toContain(AT_HINT_NOTE(['小P'])); expect(fake.inputs[0]).not.toContain(AT_HINT_NOTE(['小P', '小审']));
  });
  it('45: puts a bot wake before the mention hint and sender block', async () => {
    answers('好的'); const m = says('请修改', { at: true, thread: 'omt_people' });
    fake.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: idOf(m), create_time: m.create_time, msg_type: 'text', body: { content: m.content }, sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' } }], has_more: false } });
    await send(m, { openId: 'ou_other', type: 'app', name: '小P' }); await decide(m, result('reply')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    const input = fake.inputs[0]!; const hint = AT_HINT_NOTE(['小P', '小审']);
    expect(input).toContain(hint); expect(input.indexOf(BOT_WAKE_NOTE('小P'))).toBe(0); expect(input.indexOf(hint)).toBeLessThan(input.indexOf('[本条消息的发信人：'));
  });
  it('45: supplies the hint to a queued human turn too', async () => {
    fake.project = { ...base, pendingPolicy: 'queue' }; const gate = deferred<void>(); let runs = 0;
    fake.events = async function* () { if (++runs === 1) await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    await send(says('第一轮', { at: true, thread: 'omt_people' })); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    await send(says('第二轮', { at: true, thread: 'omt_people' })); await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    gate.resolve(); await vi.waitFor(() => expect(fake.inputs).toHaveLength(2)); expect(fake.inputs[1]).toContain(AT_HINT_NOTE(['小P', '小审']));
  });
  it('45: leaves rule-group input free of the smart mention hint', async () => {
    fake.project = { ...base, smart: false }; await turn('好的'); expect(fake.inputs[0]).not.toContain('会变成真 @');
  });
  it('releases a pending people lookup on shutdown without sending or repainting', async () => {
    const gate = deferred<unknown>(); fake.members.mockImplementation(() => gate.promise);
    answers('@张三 @小审 看'); await send(says('请写方案', { at: true, thread: 'omt_people' }));
    await vi.waitFor(() => expect(fake.members).toHaveBeenCalled()); await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
    await orchestrator.shutdown();
    gate.resolve(page()); await settle(); expect(fake.finals).toHaveLength(1); expect(replies()).toEqual([]); handoff({ why: 'shutdown' });
  });
  it('never sends a person mention without a complete bot roster', async () => {
    fake.request.mockRejectedValue(new Error('unavailable')); await turn('@张三 看');
    expect(replies()).toEqual([]); expect(finalText()).not.toContain('→ 想 @'); handoff({ why: 'no-roster' });
  });
  it('uses the solo hint when the bot roster cannot be read', async () => {
    fake.request.mockRejectedValue(new Error('unavailable')); await turn('好的');
    expect(fake.inputs[0]).toContain(AT_HINT_NOTE([])); expect(fake.inputs[0]).not.toContain(AT_HINT_NOTE(['小P', '小审']));
  });
  it('keeps the hint out of judge input before supplying it to the agent', async () => {
    answers('好的'); const m = says('请写方案', { at: true }); await send(m);
    const request = (await judged(m)).req;
    expect(JSON.stringify(request)).not.toContain('会变成真 @');
    expect(request.facts?.otherBots).toEqual({ names: ['小P', '小审'], complete: true });
    await decide(m, result('main')); await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
    expect(fake.inputs[0]).toContain(AT_HINT_NOTE(['小P', '小审']));
  });

});

describe('no rules at the smart entry (s25e)', () => {
  const other = { openId: 'ou_other', name: '张三' };
  const noted = (reason: string) => records().filter(r => r.reason === reason);
  const logged = (event: string) => fake.log.info.mock.calls.filter(([, e]) => e === event).map(([, , fields]) => fields);
  const meta = (self: boolean) => ({ code: 0, data: { items: [{ create_time: '1', sender: self ? { id: APP, id_type: 'app_id', sender_type: 'app', open_bot_id: BOT.openId } : { id: 'ou_zhang', id_type: 'open_id', sender_type: 'user' } }] } });
  async function ask(m: EventMessage) { await throughBridgeChannel(await receive(m, { bot: BOT }), orchestrator.onMessage); return (await judged(m)).req; }
  const answered = (n = 1) => vi.waitFor(() => expect(fake.inputs).toHaveLength(n));

  it('13: everyone mentions enter judgement and keep their visible name', async () => {
    const m = says('明天十点开会', { all: true });
    const req = await ask(m);
    expect(req.variant).toBe('main');
    expect(req.message.mentions).toContain('所有人');
    expect(req.message.named).toBe(true);
    await decide(m, result('skip')); await settle();
    expect(noted('judge-skip')).toHaveLength(1);
  });
  it('SDK entry leaves @all without @thisBot silent in rules mode', async () => {
    fake.project = { ...base, smart: false };
    const m = says('请大家看一下', { all: true });
    await throughBridgeChannel(await receive(m, { bot: BOT }), orchestrator.onMessage);
    await settle();
    expect(fake.judge).not.toHaveBeenCalled();
    expect(fake.inputs).toEqual([]);
    expect(fake.reply).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });
  it('14: mentions of other people enter judgement as initiative', async () => {
    const m = says('你看下', { mentionOther: { openId: 'ou_x', name: '小审' } });
    expect((await ask(m)).message.mentions).toEqual(['小审']);
    await decide(m, result('main')); await answered();
    expect(fake.inputs[0]).toContain(INITIATIVE_NOTE);
  });
  it('15: resolves missing quotes, trusts the ring, and treats missing metadata as ordinary', async () => {
    fake.bots = '2';
    fake.get.mockResolvedValueOnce(meta(false));
    const q1 = says('这个呢', { parent: 'om_q1' });
    expect((await ask(q1)).timeoutMs).toBeUndefined();
    expect(noted('lookup-failed')).toEqual([]);
    await decide(q1, result('skip')); await settle();
    fake.get.mockResolvedValueOnce(meta(true));
    const q2 = says('那这个', { parent: 'om_q2' });
    const req = await ask(q2);
    expect(req.variant).toBe('main'); expect(req.timeoutMs).toBe(12_000);
    expect(req.why).toBe('真人引用了你的消息');
    expect(fake.react).toHaveBeenCalledWith({ path: { message_id: idOf(q2) }, data: { reaction_type: { emoji_type: 'THINKING' } } });
    expect(logged('salience')).toContainEqual(expect.objectContaining({ kind: 'quote-me', by: 'quote' }));
    await decide(q2, result('skip', { reason: '知悉' })); await settle();
    expect(fake.unreact).toHaveBeenCalled(); expect(fake.inputs).toEqual([]); expect(fake.send).not.toHaveBeenCalled();
    expect(noted('judge-skip').filter(r => r.detail === '知悉')).toHaveLength(1);
    fake.get.mockResolvedValueOnce({ code: 230002, data: { items: [] } });
    const q3 = says('还有', { parent: 'om_q3' });
    expect((await ask(q3)).timeoutMs).toBeUndefined();
    expect(noted('lookup-failed')).toEqual([]);
    await decide(q3, result('skip')); await settle();
    const a = says('问题'); await ask(a); await decide(a, result('skip')); await settle();
    const getsBeforeQuote = fake.get.mock.calls.filter(([r]) => r.path.message_id === idOf(a)).length;
    const b = says('补充', { parent: idOf(a) }); await ask(b);
    expect(fake.get.mock.calls.filter(([r]) => r.path.message_id === idOf(a))).toHaveLength(getsBeforeQuote);
  });
  it('16: named timeouts answer without initiative or failure diagnostics and remove THINKING', async () => {
    const m = says('看下', { at: true }); await ask(m);
    await decide(m, result('skip', { error: { kind: 'timeout' } })); await answered();
    expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE); expect(noted('judge-failed')).toEqual([]);
    expect(logged('judge-fallback')).toContainEqual(expect.objectContaining({ why: 'named', error: 'timeout' }));
    expect(fake.unreact).toHaveBeenCalled();
  });
  it('17: topic mentions are judged with 12 seconds and may reply or silently skip', async () => {
    const m = says('看下', { at: true, thread: 'omt_t' });
    const req = await ask(m); expect(req.variant).toBe('topic'); expect(req.timeoutMs).toBe(12_000);
    await decide(m, result('reply')); await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyInThread: true });
    const skipped = says('还有', { at: true, thread: 'omt_t' }); await ask(skipped);
    await decide(skipped, result('skip')); await settle();
    expect(fake.inputs).toHaveLength(1); expect(noted('judge-skip')).toHaveLength(1); expect(fake.unreact).toHaveBeenCalled();
  });
  it('18: one-person topics are judged and budgeted, falling back only until another person speaks', async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      const a = says('接着说', { thread: 'omt_s' }); await ask(a);
      await decide(a, result('reply')); await answered(); await settle();
      const b = says('再问一句', { thread: 'omt_s' }); await ask(b);
      await decide(b, result('skip', { error: { kind: 'failed', detail: 'boom' } })); await answered(2); await settle();
      expect(noted('judge-failed')).toEqual([]);
      expect(logged('judge-fallback')).toContainEqual(expect.objectContaining({ why: 'solo' }));
      const c = says('我也问', { thread: 'omt_s' }); await send(c, other); await judged(c);
      await decide(c, result('skip')); await settle();
      const d = says('呢', { thread: 'omt_s' }); await ask(d);
      await decide(d, result('skip', { error: { kind: 'failed' } })); await settle();
      expect(fake.inputs).toHaveLength(2); expect(noted('judge-failed')).toHaveLength(1);
      expect(take).toHaveBeenCalledTimes(4);
      expect(take.mock.calls.map(([, , kind]) => kind)).toEqual(['focus', 'focus', 'focus', 'focus']);
    } finally { take.mockRestore(); }
  });
  it('19: names use their budget, without THINKING, initiative, or error fallback', async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      const m = says('小码 看下 128'); const req = await ask(m);
      expect(req.variant).toBe('main'); expect(req.timeoutMs).toBeUndefined();
      expect(fake.react).not.toHaveBeenCalled(); expect(take.mock.calls.at(-1)?.[2]).toBe('name');
      expect(logged('salience')).toContainEqual(expect.objectContaining({ kind: 'name' }));
      expect(req.why).toBe('真人叫了你的完整名字');
      await decide(m, result('main')); await answered(); await settle(); expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
      const skipped = says('小码 第三人称'); await ask(skipped); await decide(skipped, result('skip', { reason: '第三人称' })); await settle();
      expect(noted('judge-skip')).toHaveLength(1);
      const failed = says('小码 看下'); await ask(failed); await decide(failed, result('skip', { error: { kind: 'timeout' } })); await settle();
      expect(fake.inputs).toHaveLength(1); expect(noted('judge-failed')).toHaveLength(1); expect(logged('judge-fallback')).toEqual([]);
    } finally { take.mockRestore(); }
  });
  it('20: an exhausted name budget records one unaggregated refusal without freezing attention', async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take').mockReturnValueOnce(false);
    try {
      await send(says('小码 在吗')); await settle();
      expect(fake.judge).not.toHaveBeenCalled(); expect(noted('judge-budget')).toHaveLength(1);
      expect(events.find(e => e.kind === 'notReplied' && e.record.reason === 'judge-budget')).not.toHaveProperty('times');
      expect(logged('attention-freeze')).toEqual([]);
    } finally { take.mockRestore(); }
  });
  it('21: named topic proposals open under the triggering message rather than the anchor', async () => {
    const e = says('早'); await ask(e); await decide(e, result('skip')); await settle();
    fake.get.mockResolvedValue(meta(false)); // The earlier line is a valid, unthreaded anchor.
    const m = says('小码 这个500看下'); await ask(m); await decide(m, result('topic', { anchor: idOf(e) })); await answered();
    expect(fake.cards[0]![3]).toMatchObject({ replyTo: idOf(m) });
  });
  it('22: partial names remain chat, full names use name budget, and common names have no salience', async () => {
    const take = vi.spyOn(JudgeBudget.prototype, 'take');
    try {
      for (const name of ['小码助手', 'AI']) {
        await orchestrator.shutdown();
        const bot = { ...BOT, name };
        orchestrator = createOrchestrator({ ...channel, botIdentity: bot } as never, cfg, workspace, undefined, { attention: new FocusEverywhere() });
        fake.log.info.mockClear();
        const m = says(name === 'AI' ? 'AI 看下' : '小码 看下');
        await orchestrator.onMessage(await receive(m, { bot }));
        expect((await judged(m)).req.message.sameNameWord).toBe(name === 'AI' ? true : undefined);
        expect((await judged(m)).req.message.fresh).toBeUndefined(); expect(take.mock.calls.at(-1)?.[2]).toBe('focus');
        expect(logged('name-partial')).toHaveLength(name === 'AI' ? 0 : 1);
        expect(logged('salience')).toEqual([]);
        await decide(m, result('skip')); await settle();
        if (name !== 'AI') {
          const full = says('小码助手 看下'); await orchestrator.onMessage(await receive(full, { bot })); await judged(full);
          expect(take.mock.calls.at(-1)?.[2]).toBe('name'); await decide(full, result('skip')); await settle();
        }
      }
    } finally { take.mockRestore(); }
  });
  it('attaches weak-name evidence to the earlier batch line when its latest line has no name', async () => {
    await orchestrator.shutdown();
    const bot = { ...BOT, name: 'AI' };
    orchestrator = createOrchestrator({ ...channel, botIdentity: bot } as never, cfg, workspace, undefined, { attention: new FocusEverywhere() });
    const first = says('先看这里');
    await orchestrator.onMessage(await receive(first, { bot })); await judged(first);
    const earlier = says('AI 看看'), latest = says('还有这个');
    await orchestrator.onMessage(await receive(earlier, { bot }));
    await orchestrator.onMessage(await receive(latest, { bot }));
    await decide(first, result('skip'));
    const req = (await judged(latest)).req;
    expect(req.context.find((l) => l.id === idOf(earlier))?.sameNameWord).toBe(true);
    expect(req.message.sameNameWord).toBeUndefined();
    await decide(latest, result('skip'));
  });
  it('does not reuse an old complete roster when the current fact read times out', async () => {
    const first = says('第一次读取', { at: true });
    expect((await ask(first)).facts?.otherBots).toEqual({ names: ['小P'], complete: true });
    await decide(first, result('skip')); await settle();
    const pending = deferred<{ code: number; data: { bots: { app_id: string; member_id: string; name: string }[] } }>();
    const realNow = Date.now.bind(Date);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ROSTER_TTL_MS + 1);
    fake.request.mockReturnValue(pending.promise);
    try {
      const next = says('缓存过期后', { at: true });
      await send(next);
      await vi.waitFor(() => expect(asked.has(idOf(next))).toBe(true), { timeout: 5_000 });
      expect(asked.get(idOf(next))?.req.facts?.otherBots).toEqual({ names: [], complete: false });
      await decide(next, result('skip')); await settle();
      pending.resolve({ code: 0, data: { bots: [{ app_id: 'late', member_id: 'ou_late', name: '迟到名册' }] } });
      await settle();
      expect(asked.get(idOf(next))?.req.facts?.otherBots).toEqual({ names: [], complete: false });
    } finally { now.mockRestore(); pending.resolve({ code: 0, data: { bots: [] } }); }
  }, 10_000);

  it('23: commands need an at in multi-bot main areas, while a lone bot still serves help', async () => {
    fake.bots = '2'; await send(says('/help')); await settle();
    expect(fake.judge).not.toHaveBeenCalled(); expect(fake.send).not.toHaveBeenCalled();
    expect(logged('audience')).toContainEqual(expect.objectContaining({ by: 'command-needs-at' }));
    fake.bots = '1'; await orchestrator.shutdown();
    orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, { attention: new FocusEverywhere() });
    await send(says('/help')); await settle();
    expect(fake.cardCreate).toHaveBeenCalledTimes(1);
    expect(fake.reply).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ msg_type: 'interactive' }) }));
  });
  it('24: recalled named messages never fall back or leave a refusal', async () => {
    const m = says('看下', { at: true }); await ask(m);
    await orchestrator.onRecall({ messageId: idOf(m), chatId: CHAT }); await settle();
    expect(fake.inputs).toEqual([]); expect(records()).toEqual([]); expect(logged('judge-fallback')).toEqual([]);
  });
  it('25: salience, partial-name, fallback and budget logs contain no text, name, or full message id', async () => {
    fake.get.mockResolvedValueOnce(meta(true));
    const quote = says('看下', { parent: 'om_q1' }); await ask(quote); await decide(quote, result('skip')); await settle();
    const named = says('看下', { at: true }); await ask(named); await decide(named, result('skip', { error: { kind: 'timeout' } })); await answered(); await settle();
    const name = says('小码 看下'); await ask(name); await decide(name, result('skip')); await settle();
    const entries = ['salience', 'name-partial', 'judge-fallback', 'judge-budget'].flatMap(logged);
    expect(entries.length).toBeGreaterThan(0);
    const text = JSON.stringify(entries);
    for (const secret of ['小码', '小审', '看下', idOf(quote), idOf(named), idOf(name)]) expect(text).not.toContain(secret);
  });

  it('root cache: successful lookups are reused, failures retry, and the oldest of 201 roots is evicted', async () => {
    const lookupCount = (id: string) => fake.get.mock.calls.filter(([r]) => r.path.message_id === id).length;
    fake.get.mockResolvedValue(meta(true));
    const first = says('继续', { thread: 'omt_cached', root: 'om_cached', parent: 'om_cached' });
    expect((await ask(first)).timeoutMs).toBe(12_000); await decide(first, result('skip')); await settle();
    const second = says('继续问', { thread: 'omt_cached', root: 'om_cached', parent: 'om_cached' });
    expect((await ask(second)).timeoutMs).toBe(12_000); await decide(second, result('skip')); await settle();
    expect(lookupCount('om_cached')).toBe(1);
    fake.get.mockResolvedValueOnce({ code: 230002, data: { items: [] } });
    const failed = says('还在吗', { thread: 'omt_retry', root: 'om_retry', parent: 'om_retry' });
    expect((await ask(failed)).timeoutMs).toBeUndefined(); await decide(failed, result('skip')); await settle();
    const retry = says('再问', { thread: 'omt_retry', root: 'om_retry', parent: 'om_retry' });
    expect((await ask(retry)).timeoutMs).toBe(12_000); await decide(retry, result('skip')); await settle();
    expect(lookupCount('om_retry')).toBe(2);
    for (let i = 0; i < 199; i++) {
      const m = says('继续', { thread: `omt_cache_${i}`, root: `om_cache_${i}`, parent: `om_cache_${i}` });
      await ask(m); await decide(m, result('skip')); await settle();
    }
    const evicted = says('再继续', { thread: 'omt_cached', root: 'om_cached', parent: 'om_cached' });
    expect((await ask(evicted)).timeoutMs).toBe(12_000);
    expect(lookupCount('om_cached')).toBe(2);
  }, 30_000);

  it('quote lookup deadlines admit ordinary messages after three seconds without lookup-failed diagnostics', async () => {
    fake.get.mockImplementationOnce(() => new Promise(() => {}));
    const m = says('继续', { parent: 'om_hung' });
    const started = Date.now();
    expect((await ask(m)).timeoutMs).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(noted('lookup-failed')).toEqual([]);
    expect(fake.log.warn.mock.calls.filter(([, event]) => event === 'quote-lookup-failed')).toHaveLength(1);
    await decide(m, result('skip')); await settle();
    expect(fake.inputs).toEqual([]);
  }, 10_000);
  it('a newer named fallback supersedes the earlier chat judgement so only one turn starts', async () => {
    const chat = says('再补一句'); await ask(chat);
    const named = says('看下', { at: true }); await ask(named);
    await decide(named, result('skip', { error: { kind: 'timeout' } })); await answered(); await settle();
    await decide(chat, result('main')); await settle();
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(fake.inputs).toHaveLength(1); expect(fake.inputs[0]).not.toContain(INITIATIVE_NOTE);
    expect(noted('judge-failed')).toEqual([]);
  });

  it.each(['at', 'quote', 'fallback'] as const)('36—38: %s judgement is discarded after switching to rules', async kind => {
    if (kind === 'quote') fake.get.mockResolvedValueOnce(meta(true));
    const m = says('看下', kind === 'quote' ? { parent: 'om_q2' } : { at: true }); await ask(m);
    fake.project = { ...base, smart: false };
    await decide(m, kind === 'fallback' ? result('skip', { error: { kind: 'timeout' } }) : result('main')); await settle();
    expect(fake.inputs).toEqual([]); expect(fake.cards).toEqual([]); expect(noted('group-updating')).toHaveLength(1);
    expect(fake.unreact).toHaveBeenCalled(); expect(noted('judge-failed')).toEqual([]);
    if (kind === 'fallback') expect(logged('judge-fallback')).toContainEqual(expect.objectContaining({ why: 'named' }));
    if (kind === 'at') {
      const count = fake.judge.mock.calls.length;
      await send(says('再看下', { at: true })); await answered(); expect(fake.judge).toHaveBeenCalledTimes(count);
    }
  });
});

describe('smart reminder runtime (s27b3)', () => {
  beforeEach(() => {
    // Reminder cases exercise a turn the smart judge has chosen to answer.
    fake.judge.mockImplementation((req: JudgeRequest) => {
      const answer = deferred<JudgeResult>();
      answer.resolve(result('reply'));
      asked.set(req.ref!, { req, answer });
      return answer.promise;
    });
    vi.spyOn(sessionStore, 'listSessions').mockResolvedValue(['omt_snapshot', 'omt_stale', 'omt_goal_reminder', 'omt_slot_a', 'omt_slot_b', 'omt_denied'].map(threadId => ({ threadId, chatId: CHAT, cwd: workspace, sessionId: 'native-fixture', backend: 'codex-appserver', summary: 'test', createdAt: 0, updatedAt: 0 })));
  });
  afterEach(() => vi.mocked(sessionStore.listSessions).mockRestore());
  const landed = async () => { await vi.waitFor(() => expect(fake.log.info.mock.calls.some(c => c[1] === 'final')).toBe(true)); await settle(); };
  const posts = () => fake.reply.mock.calls.filter(([req]) => req.data.msg_type === 'post');

  it('a smart human waiting for a global slot in failures mode has no manual reminder controls', async () => {
    cfg.preferences.completionReminder = { mode: 'failures' };
    await orchestrator.shutdown();
    orchestrator = createOrchestrator(channel as never, { ...cfg, preferences: { ...cfg.preferences, maxConcurrentRuns: 1 } }, workspace);
    const gate = deferred<void>();
    fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    try {
      await send(says('SLOT_OWNER', { at: true, thread: 'omt_slot_a' }));
      await vi.waitFor(() => expect(fake.inputs).toHaveLength(1));
      await send(says('HUMAN_WAITING', { at: true, thread: 'omt_slot_b' }));
      await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
      expect(JSON.stringify([fake.cards[1], fake.liveCards.filter(card => card.id === 2)])).not.toContain('完成后提醒我');
      const context = await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_slot_b' });
      expect(context).toMatchObject({ run: { canRemind: false, reminderRequested: false } });
      if (typeof context !== 'object' || context === null || !('run' in context) || typeof context.run !== 'object' || context.run === null || !('id' in context.run) || typeof context.run.id !== 'string') throw new Error('missing queued context');
      await expect(orchestrator.collaboration({ action: 'reminder', projectName: 'demo', chatId: CHAT, threadId: 'omt_slot_b', runId: context.run.id, requested: true })).rejects.toThrow('仅任务发起人');
      await orchestrator.dispatcher.handle({ messageId: 'card_2', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.remind', m: 'card_2' } } } as never);
      expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_slot_b' })).toMatchObject({ run: { reminderRequested: false } });
    } finally { const stopped = orchestrator.shutdown(); gate.resolve(); await stopped; }
  });

  it.each(['other-human', 'bot'] as const)('rejects real card and management writes for a non-owner initiator (%s)', async initiator => {
    fake.project = { ...base, smart: initiator === 'bot' };
    const gate = deferred<void>();
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '处理中' }; await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    try {
      const m = says('请处理', { at: true, thread: 'omt_denied' });
      if (initiator === 'bot') {
        fake.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: idOf(m), create_time: m.create_time, msg_type: 'text', body: { content: m.content }, sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' } }], has_more: false } });
        await send(m, { openId: 'ou_other', type: 'app', name: '小P' }); await decide(m, result('reply'));
      } else await send(m, { openId: 'ou_other' });
      await vi.waitFor(() => expect(fake.liveCards.length).toBeGreaterThan(0));
      fake.project = { ...base, smart: false };
      const context = await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_denied' });
      expect(context).toMatchObject({ run: { canRemind: false, reminderRequested: false } });
      if (typeof context !== 'object' || context === null || !('run' in context) || typeof context.run !== 'object' || context.run === null || !('id' in context.run) || typeof context.run.id !== 'string') throw new Error('missing running context');
      await expect(orchestrator.collaboration({ action: 'reminder', projectName: 'demo', chatId: CHAT, threadId: 'omt_denied', runId: context.run.id, requested: true })).rejects.toThrow('仅任务发起人');
      for (const openId of ['ou_owner', 'ou_other']) {
        await orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId }, action: { value: { a: 'run.remind', m: 'card_1' } } } as never);
        if (openId === 'ou_owner' || initiator === 'bot') expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_denied' })).toMatchObject({ run: { reminderRequested: false } });
      }
      if (initiator === 'other-human') expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_denied' })).toMatchObject({ run: { reminderRequested: true } });
    } finally { gate.resolve(); }
  });

  it('does not send a late error reminder after shutdown starts during finalization', async () => {
    const gate = deferred<void>(); fake.finalGate = gate.promise;
    fake.events = async function* () { yield { type: 'error', message: 'late terminal', willRetry: false }; };
    await send(says('请处理', { at: true, thread: 'omt_late_final' }));
    await vi.waitFor(() => expect(fake.finals).toHaveLength(1));
    const stopped = orchestrator.shutdown();
    await settle(); gate.resolve(); await stopped; await settle();
    expect(posts()).toHaveLength(0);
  });

  it('a smart manual turn reaching the real idle watchdog sends one timeout reminder', async () => {
    const priorIdleTimeout = cfg.preferences.runIdleTimeoutSeconds;
    cfg.preferences.runIdleTimeoutSeconds = 10;
    const gate = deferred<void>();
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '处理中' }; await gate.promise; };
    try {
      await send(says('请处理', { at: true, thread: 'omt_idle' }));
      await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith(expect.any(String), 'final', expect.objectContaining({ terminal: 'idle_timeout' })), { timeout: 12_000, interval: 50 });
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
      expect(posts()[0]?.[0].data.content).toContain('响应超时');
      expect(posts()[0]?.[0].data.content).toContain('ou_owner');
      expect(fake.log.info).toHaveBeenCalledWith('card', 'completion-reminder', expect.objectContaining({ smart: true, terminal: 'idle_timeout' }));
    } finally {
      gate.resolve();
      if (priorIdleTimeout === undefined) delete cfg.preferences.runIdleTimeoutSeconds;
      else cfg.preferences.runIdleTimeoutSeconds = priorIdleTimeout;
    }
  }, 15_000);

  it('39: a human error sends one native reminder even in manual mode', async () => {
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '处理中' }; yield { type: 'error', message: 'boom', willRetry: false }; };
    await send(says('请处理', { at: true, thread: 'omt_error' })); await landed();
    expect(posts()).toHaveLength(1); expect(posts()[0]?.[0].data.content).toContain('ou_owner'); expect(posts()[0]?.[0].data.content).toContain('执行失败');
    expect(fake.log.info).toHaveBeenCalledWith('card', 'completion-reminder', expect.objectContaining({ smart: true }));
  });

  it.each([true, false])('40/41: success only sends a terminal-card fallback (updated=%s)', async cardUpdated => {
    cfg.preferences.completionReminder = { mode: cardUpdated ? 'always' : 'manual' }; fake.finalOk = cardUpdated;
    await send(says('请处理', { at: true, thread: 'omt_success' })); await landed();
    expect(posts()).toHaveLength(cardUpdated ? 0 : 1);
    if (!cardUpdated) expect(posts()[0]?.[0].data.content).toContain('最终卡片更新失败');
  });

  it.each([true, false])('44: card and web controls follow the turn snapshot after a mode edit (smart=%s)', async smart => {
    fake.project = { ...base, smart }; const gate = deferred<void>();
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '处理中' }; await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    const threadId = 'omt_snapshot';
    try {
      await send(says('请处理', { at: true, thread: threadId })); await vi.waitFor(() => expect(fake.liveCards.length).toBeGreaterThan(0));
      fake.project = { ...base, smart: !smart };
      const context = await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId });
      expect(context).toMatchObject({ run: { canRemind: true, reminderRequested: false } });
      expect(JSON.stringify([fake.cards, fake.liveCards])).toContain('完成后提醒我');
      await orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_other' }, action: { value: { a: 'run.remind', m: 'card_1' } } } as never);
      expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId })).toMatchObject({ run: { reminderRequested: false } });
      await orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.remind', m: 'card_1' } } } as never);
      expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId })).toMatchObject({ run: { reminderRequested: true } });
      gate.resolve(); await landed();
      expect(JSON.stringify(fake.finals)).not.toContain('完成后提醒我');
      expect(posts()).toHaveLength(1);
      expect(posts()[0]?.[0].data.content).toContain('已完成');
      expect(posts()[0]?.[0].data.content).toContain('ou_owner');
    } finally { gate.resolve(); }
  });

  it('42: a bot-started error never sends a post', async () => {
    cfg.preferences.completionReminder = { mode: 'always' };
    fake.events = async function* () { yield { type: 'error', message: 'boom', willRetry: false }; };
    const m = says('请处理', { at: true, thread: 'omt_bot_error' });
    fake.list.mockResolvedValue({ code: 0, data: { items: [{ message_id: idOf(m), create_time: m.create_time, msg_type: 'text', body: { content: m.content }, sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app', open_bot_id: 'ou_other', sender_name: '小P' } }], has_more: false } });
    await send(m, { openId: 'ou_other', type: 'app', name: '小P' }); await decide(m, result('reply')); await landed();
    expect(posts()).toHaveLength(0);
  });

  it('a goal has no reminder controls and sends no completion post', async () => {
    fake.project = { ...base, smart: false }; cfg.preferences.completionReminder = { mode: 'manual' }; const gate = deferred<void>();
    fake.events = async function* () { yield { type: 'text', itemId: 'a', text: '目标处理中' }; await gate.promise; yield { type: 'done', turnId: 'goal-fixture' }; };
    try {
      await send(says('/goal 整理文档', { at: true, thread: 'omt_goal_reminder' }));
      await vi.waitFor(() => expect(fake.liveCards.length).toBeGreaterThan(0));
      const context = await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_goal_reminder' });
      expect(context).toMatchObject({ run: { goal: true, canRemind: false, reminderRequested: false } });
      if (typeof context !== 'object' || context === null || !('run' in context) || typeof context.run !== 'object' || context.run === null || !('id' in context.run) || typeof context.run.id !== 'string') throw new Error('missing goal context');
      await expect(orchestrator.collaboration({ action: 'reminder', projectName: 'demo', chatId: CHAT, threadId: 'omt_goal_reminder', runId: context.run.id, requested: true })).rejects.toThrow('仅任务发起人');
      await orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.remind', m: 'card_1' } } } as never);
      expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_goal_reminder' })).toMatchObject({ run: { reminderRequested: false } });
      expect(JSON.stringify([fake.cards, fake.liveCards])).not.toContain('完成后提醒我');
      gate.resolve(); await settle(); expect(posts()).toHaveLength(0);
      await vi.waitFor(() => expect(latestActions()).toEqual([expect.objectContaining({ groupId: CHAT, kind: 'replied' })]));
      const ids = events.flatMap(event => event.kind === 'activity' ? [event.activity.id] : []);
      expect(ids.length).toBeGreaterThan(0);
      expect(events.filter(event => event.kind === 'activityEnded').map(event => event.id)).toEqual(expect.arrayContaining([...new Set(ids)]));
    } finally { gate.resolve(); }
  });

  it('rejects an old smart-card reminder action for a run started in failures mode', async () => {
    fake.project = { ...base, presentation: { completionMode: 'failures' } };
    const gate = deferred<void>(); fake.events = async function* () { await gate.promise; yield { type: 'done', turnId: 'turn-fixture' }; };
    try {
      await send(says('请处理', { at: true, thread: 'omt_stale' })); await vi.waitFor(() => expect(fake.liveCards.length).toBeGreaterThan(0));
      await orchestrator.dispatcher.handle({ messageId: 'card_1', chatId: CHAT, operator: { openId: 'ou_owner' }, action: { value: { a: 'run.remind', m: 'card_1' } } } as never);
      expect(await orchestrator.collaboration({ action: 'context', projectName: 'demo', chatId: CHAT, threadId: 'omt_stale' })).toMatchObject({ run: { canRemind: false, reminderRequested: false } });
    } finally { gate.resolve(); }
  });
});
