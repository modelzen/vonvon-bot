import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { BackendNotInstalledError } from '../src/agent/backend-loader';
import { CODEX_FULL_ONLY, CodexFullOnlyError } from '../src/agent/codex-appserver/full-only';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { DM } from '../src/card/dm-cards';
import { addProject, getProjectByName, removeProject } from '../src/project/registry';

vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'not-replied-'));
  return { paths: { appDir, botsFile: join(appDir, 'bots.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  events: [] as unknown[],
  startError: undefined as Error | undefined,
  fullOnly: undefined as string | undefined,
  cardError: undefined as unknown,
  stream: undefined as (() => AsyncIterable<unknown>) | undefined,
  aborted: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  card: vi.fn(async (..._args: unknown[]) => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
const startThread = vi.fn(async () => {
  if (fake.startError) throw fake.startError;
  return {
    sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => { fake.aborted(); },
    runStreamed: () => ({ turnId: () => 'turn-fixture', events: fake.stream?.() ?? (async function* () { for (const event of fake.events) yield event; })() }),
  };
});

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => fake.project }));
vi.mock('../src/agent', async original => ({
  ...await original<object>(),
  createBackend: (id: string) => ({ id, listModels: async () => [], startThread, fullAccessOnly: () => fake.fullOnly }),
}));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async () => undefined, upsertSession: async () => undefined }));
vi.mock('../src/card/managed', async original => ({ ...await original<object>(), sendManagedCard: fake.card }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { if (fake.cardError) throw fake.cardError; return 'card'; }
    getCardId() { return 'card'; }
    async updateElement() { return true; }
    async drain() {}
    async settleImages() { return new Map(); }
    async updateCard() { return true; }
    async finalizeCard() { return true; }
    streamCoalesced() {}
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    // Whatever else a run calls on its card is a no-op here.
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }); }
  },
}));

import { createOrchestrator, failureReason } from '../src/bot/handle-message';

const base = { name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', kind: 'multi', noMention: false, mode: 'qa', guestMode: 'qa', network: false };
const cfg = (allowedChats?: string[]): AppConfig => ({ accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', ...(allowedChats ? { allowedChats } : {}) }, completionReminder: { mode: 'manual' } } });
const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) }, message: { get: async () => ({ data: { items: [{ thread_id: 'omt_opened_topic' }] } }) } } } } };
let orchestrator: ReturnType<typeof createOrchestrator>;
let events: DiagnosticsEvent[] = [];
let sequence = 0;
const SECRET = 'the secret plan for friday';
function message(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `om_fixture_${String(++sequence).padStart(6, '0')}`, chatId: 'oc_demo', chatType: 'group', content: SECRET, senderId: 'ou_owner', senderName: 'Owner',
    mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false, ...fields };
}
const records = () => events.flatMap(event => event.kind === 'notReplied' ? [event.record] : []);
const replies = () => fake.send.mock.calls.map(([, content]) => (content as { markdown: string }).markdown);
function start(config = cfg()) { orchestrator = createOrchestrator(channel as never, config, '/tmp/demo'); }

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  setDiagnosticsSink(event => events.push(event));
  fake.project = { ...base };
  fake.events = [{ type: 'done', turnId: 'turn-fixture' }];
  fake.startError = undefined;
  fake.fullOnly = undefined;
  fake.cardError = undefined;
  fake.stream = undefined;
  start();
});
afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

describe('gates', () => {
  it('notes a disabled group only when the bot is @-ed', async () => {
    fake.project = { ...base, enabled: false };
    await orchestrator.onMessage(message({ mentionedBot: false }));
    expect(records()).toEqual([]);
    const msg = message();
    await orchestrator.onMessage(msg);
    expect(records()).toEqual([{ at: msg.createTime, groupId: 'oc_demo', place: 'main', reason: 'group-disabled', ref: msg.messageId.slice(-6) }]);
  });

  it('does not note rule mode\'s messages that were not for it', async () => {
    await orchestrator.onMessage(message({ mentionedBot: false }));
    await orchestrator.onMessage(message({ mentionedBot: false, threadId: 'omt_topic' }));
    expect(records()).toEqual([]);
  });

  it('tells a group missing from 允许的飞书群 from a sender missing from 响应成员', async () => {
    fake.project = { ...base, allowedUsers: ['ou_member'] };
    await orchestrator.onMessage(message({ senderId: 'ou_stranger', threadId: 'omt_topic' }));
    await orchestrator.shutdown();
    start(cfg(['oc_elsewhere']));
    await orchestrator.onMessage(message());
    expect(records().map(record => [record.reason, record.place])).toEqual([['user-not-allowed', 'topic'], ['chat-not-allowed', 'main']]);
    expect(startThread).not.toHaveBeenCalled();
  });

  it('notes an unbound group it only hinted in', async () => {
    fake.project = undefined;
    await orchestrator.onMessage(message({ mentionedBot: false }));
    expect(records()).toEqual([]);
    await orchestrator.onMessage(message());
    expect(records().map(record => record.reason)).toEqual(['unbound']);
    expect(fake.send).toHaveBeenCalledWith('oc_demo', { markdown: expect.stringContaining('还没绑定') }, expect.anything());
  });
});

describe('Codex that runs only in 完全访问 (Linux)', () => {
  beforeEach(() => { fake.fullOnly = CODEX_FULL_ONLY; });

  it('answers an @ in the main area without starting a session', async () => {
    const msg = message();
    await orchestrator.onMessage(msg);
    expect(startThread).not.toHaveBeenCalled();
    expect(records()).toEqual([{ at: msg.createTime, groupId: 'oc_demo', place: 'main', reason: 'tier-unavailable', backend: 'codex', ref: msg.messageId.slice(-6) }]);
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledWith('oc_demo', expect.anything(), { replyTo: msg.messageId, replyInThread: false });
    expect(replies()[0]).toContain('这个群是「只读」档');
    expect(replies()[0]).toContain('把「管理员权限」改成「完全访问」');
    expect(replies()[0]).toContain('`vonvon settings set --group oc_demo permission.mode=full`');
  });

  it('answers in the topic, naming the tier', async () => {
    fake.project = { ...base, mode: 'write', guestMode: 'write' };
    const msg = message({ threadId: 'omt_topic' });
    await orchestrator.onMessage(msg);
    expect(startThread).not.toHaveBeenCalled();
    expect(records().map(record => [record.reason, record.place])).toEqual([['tier-unavailable', 'topic']]);
    expect(fake.send).toHaveBeenCalledWith('oc_demo', expect.anything(), { replyTo: msg.messageId, replyInThread: true });
    expect(replies()[0]).toContain('这个群是「读写」档');
  });

  it('answers a 免@ group once in 10 minutes, an @ every time, and notes every message', async () => {
    fake.project = { ...base, kind: 'single', noMention: true };
    await orchestrator.onMessage(message({ mentionedBot: false }));
    await orchestrator.onMessage(message({ mentionedBot: false }));
    await orchestrator.onMessage(message());
    expect(startThread).not.toHaveBeenCalled();
    expect(records().map(record => record.reason)).toEqual(['tier-unavailable', 'tier-unavailable', 'tier-unavailable']);
    expect(replies()).toHaveLength(2);
  });

  it('does not quiet a 免@ group after an explanation that failed to send', async () => {
    fake.project = { ...base, kind: 'single', noMention: true };
    fake.send.mockRejectedValueOnce(new Error('rate limited'));
    await orchestrator.onMessage(message({ mentionedBot: false }));
    await orchestrator.onMessage(message({ mentionedBot: false }));
    await orchestrator.onMessage(message({ mentionedBot: false }));
    expect(records().map(record => record.reason)).toEqual(['tier-unavailable', 'tier-unavailable', 'tier-unavailable']);
    expect(fake.send).toHaveBeenCalledTimes(2);
  });

  it('refuses /goal before it starts, in a single group and in a main area', async () => {
    fake.project = { ...base, kind: 'single' };
    await orchestrator.onMessage(message({ content: '/goal 把单测跑绿' }));
    fake.project = { ...base };
    await orchestrator.onMessage(message({ content: '/goal 把单测跑绿' }));
    expect(startThread).not.toHaveBeenCalled();
    expect(records().map(record => [record.reason, record.place])).toEqual([['tier-unavailable', 'main'], ['tier-unavailable', 'main']]);
    expect(replies()).toHaveLength(2);
  });

  it('runs the admin\'s full tier and refuses a guest\'s 只读 with guestMode', async () => {
    fake.project = { ...base, mode: 'full', guestMode: 'qa' };
    await orchestrator.onMessage(message({ senderId: 'ou_guest', threadId: 'omt_topic' }));
    expect(replies()[0]).toContain('把「普通成员权限」改成「完全访问」');
    expect(replies()[0]).toContain('permission.guestMode=full');
    expect(startThread).not.toHaveBeenCalled();
    await orchestrator.onMessage(message({ threadId: 'omt_topic' }));
    await vi.waitFor(() => expect(startThread).toHaveBeenCalledOnce());
    expect(records().map(record => record.reason)).toEqual(['tier-unavailable']);
  });

  it('refuses an old DM card that saves 只读, and sends one offering only 完全访问', async () => {
    await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false, mode: 'qa' });
    const submit = (mode: string) => orchestrator.dispatcher.handle({ chatId: 'ou_owner', messageId: 'om_card', operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: DM.permissionSubmit, n: 'demo' } }, raw: { action: { form_value: { mode, guestMode: mode, network: 'off' } } } } as never);
    try {
      await submit('qa');
      await vi.waitFor(() => expect(fake.card).toHaveBeenCalledOnce());
      expect(JSON.stringify(fake.card.mock.calls[0]?.[2])).toContain(CODEX_FULL_ONLY);
      expect((await getProjectByName('demo'))?.mode).toBe('qa');
      await submit('full');
      await vi.waitFor(() => expect(fake.card).toHaveBeenCalledTimes(2));
      expect(await getProjectByName('demo')).toMatchObject({ mode: 'full', guestMode: 'full' });
    } finally { await removeProject('demo'); }
  });

  it('keeps a stored 只读 when the DM card is saved with the tier dropdowns left alone', async () => {
    await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false, mode: 'qa' });
    try {
      // The card presets no tier it cannot offer, so an untouched dropdown sends nothing.
      await orchestrator.dispatcher.handle({ chatId: 'ou_owner', messageId: 'om_card', operator: { openId: 'ou_owner' },
        action: { tag: 'button', value: { a: DM.permissionSubmit, n: 'demo' } }, raw: { action: { form_value: { network: 'on' } } } } as never);
      await vi.waitFor(() => expect(fake.card).toHaveBeenCalledOnce());
      const saved = await getProjectByName('demo');
      expect(saved).toMatchObject({ mode: 'qa', network: true });
      expect(saved?.guestMode).toBeUndefined();
    } finally { await removeProject('demo'); }
  });

  it('names the bot in the command when the host has several', async () => {
    const bot = (appId: string) => ({ name: appId, appId, tenant: 'feishu', createdAt: 1 });
    writeFileSync(paths.botsFile, JSON.stringify({ version: 1, bots: [bot('cli_fixture'), bot('cli_other')] }));
    try {
      await orchestrator.onMessage(message());
      expect(replies()[0]).toContain('`vonvon settings set --bot cli_fixture --group oc_demo permission.mode=full`');
    } finally { rmSync(paths.botsFile, { force: true }); }
  });
});

describe('failed turns', () => {
  it('does not note a turn that finished', async () => {
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'done' }));
    expect(records()).toEqual([]);
  });

  it('does not note a turn the user stopped with ⏹', async () => {
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    fake.aborted.mockImplementation(() => stop());
    fake.stream = async function* () { await stopped; yield { type: 'error', message: 'turn interrupted', willRetry: false }; };
    await orchestrator.onMessage(message());
    await vi.waitFor(async () => {
      await orchestrator.onReaction({ action: 'added', messageId: 'card', emojiType: 'OK', operator: { openId: 'ou_owner' }, raw: { operator_type: 'user' } } as never);
      expect(fake.aborted).toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'interrupt', expect.anything()));
    expect(records()).toEqual([]);
  });

  it('does not note a turn whose message was recalled while it ran', async () => {
    let recall!: () => void;
    const recalled = new Promise<void>(resolve => { recall = resolve; });
    fake.stream = async function* () { await recalled; yield { type: 'error', message: '401 Unauthorized', willRetry: false }; };
    const msg = message();
    await orchestrator.onMessage(msg);
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    await orchestrator.onRecall({ messageId: msg.messageId, chatId: msg.chatId });
    recall();
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'error' }));
    expect(records()).toEqual([]);
  });

  it('notes a Codex login failure with its backend', async () => {
    fake.events = [{ type: 'error', message: '401 Unauthorized', willRetry: false }];
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ reason: 'signed-out', backend: 'codex', place: 'topic' });
  });

  it('names Claude for a Claude group in the main area of a continuous group', async () => {
    fake.project = { ...base, kind: 'single', backend: 'claude-agent' };
    fake.events = [{ type: 'error', message: 'Not logged in · Please run /login', willRetry: false }];
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ reason: 'signed-out', backend: 'claude', place: 'main' });
  });

  it('says Codex is too old when the server wants a newer one', async () => {
    fake.events = [{ type: 'error', message: "The 'gpt-6-luna' model requires a newer version of Codex. Please upgrade.", willRetry: false }];
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]?.reason).toBe('codex-too-old');
  });

  it('notes a backend that is not installed', async () => {
    fake.startError = new BackendNotInstalledError('@openai/codex');
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ reason: 'tool-missing', backend: 'codex' });
  });

  it('notes a card Feishu refused for a scope, and the scope for 缺的权限', async () => {
    fake.cardError = { response: { data: { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message, im:message:send_as_bot]' } } };
    await orchestrator.onMessage(message());
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ reason: 'missing-scope', detail: 'im:message:send_as_bot' });
    expect(events).toContainEqual({ kind: 'scopeDenied', denial: { scope: 'im:message:send_as_bot', where: 'send', at: expect.any(Number) } });
  });

  it('keeps the message text out of the records and the intake log', async () => {
    fake.events = [{ type: 'error', message: 'boom', willRetry: false }];
    const msg = message({ threadId: 'omt_0123456789abcdef', mentionedBot: true });
    await orchestrator.onMessage(msg);
    await vi.waitFor(() => expect(records()).toHaveLength(1));
    expect(records()[0]).toMatchObject({ reason: 'failed', detail: 'boom' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    const recv = fake.log.info.mock.calls.find(call => call[0] === 'intake' && call[1] === 'recv');
    expect(recv?.[2]).toEqual({ chatType: 'group', mentionedBot: true, threadId: 'abcdef', chat: 'c_demo', ref: msg.messageId.slice(-6) });
  });
});

it('maps each failure to its reason', () => {
  const rs = (fields: object) => ({ blocks: [], reasoning: [], reasoningActive: false, footer: null, terminal: 'error', ...fields }) as never;
  expect(failureReason({ rs: rs({ terminal: 'idle_timeout' }) })).toEqual({ reason: 'idle-timeout' });
  expect(failureReason({ rs: rs({ errorKind: 'quota', errorMsg: 'x' }) })).toEqual({ reason: 'quota' });
  expect(failureReason({ rs: rs({ errorKind: 'network', errorMsg: 'x' }) })).toEqual({ reason: 'network' });
  expect(failureReason({ rs: rs({ errorMsg: 'agent 进程异常退出，请重发本条消息' }), procDead: true })).toEqual({ reason: 'agent-exited' });
  expect(failureReason({ error: new Error('first line\nstack') })).toEqual({ reason: 'failed', detail: 'first line' });
  expect(failureReason({ error: new CodexFullOnlyError() })).toEqual({ reason: 'tier-unavailable' });
  expect(failureReason({ error: { code: 99991672, msg: 'denied' } })).toEqual({ reason: 'missing-scope' });
  expect(failureReason({ error: { code: 99991672, msg: 'denied: [im:message]' } })).toEqual({ reason: 'missing-scope', detail: 'im:message', scope: 'im:message' });
});
