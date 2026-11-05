import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { receive as receiveEvent } from './helpers/lark-events';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'sync-copy-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'sync-copy-'));
  return { botPaths: (appId: string) => ({ dir: join(appDir, 'bots', appId), configFile: join(appDir, 'bots', appId, 'config.json') }), paths: { appDir, inboundDir: join(appDir, 'inbound'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  send: vi.fn(async () => ({})),
  get: vi.fn(),
  react: vi.fn(async () => ({ data: {} })),
  dm: vi.fn(async () => undefined),
  readHistory: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
const startThread = vi.fn(async () => ({
  sessionId: 'native-fixture', isAlive: () => true, close: async () => {}, abort: async () => {},
  runStreamed: () => ({ turnId: () => 'turn-fixture', events: (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })() }),
}));

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], startThread, listThreads: async () => [{ sessionId: 'past' }], readHistory: fake.readHistory }) }));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(), getSession: async () => undefined, upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/bot/dm-console', () => ({ handleDmConsole: fake.dm }));
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

import { createOrchestrator } from '../src/bot/handle-message';
import { createSyncCopyGate } from '../src/bot/sync-copy';

// ── recorded shapes (e10 item 5, 2026-10-16) ────────────────────────────────
// A reply in a topic with 「同时发送到群」 ticked and @bot: two messages sent at
// the same time. The fields are the ones `message.get` returned for each; the
// event's `message` object is built from them, as Feishu's receive event names
// its fields the same way (whether it carries sync_to_chat_info is what the
// fallback lookup is for).
const BOT = { openId: 'ou_bot', name: '小码' };
const TOPIC = 'omt_topic_fixture';
const ROOT = 'om_root_fixture';
const IN_TOPIC = 'om_in_topic_fixture';
const MAIN_COPY = 'om_main_copy_fixture';
const TEXT = '订单接口一直报 500，帮忙看下';

type Shape = Record<string, unknown>;
const at = String(Date.now());
const atBot = { content: JSON.stringify({ text: `@_user_1 ${TEXT}` }), mentions: [{ key: '@_user_1', id: { open_id: BOT.openId, union_id: 'on_bot' }, name: BOT.name, tenant_key: 't' }] };
function topicMessage(chat: { chat_id: string; chat_type: string }, withSync = true): Shape {
  return { message_id: IN_TOPIC, root_id: ROOT, parent_id: ROOT, thread_id: TOPIC, create_time: at, update_time: at, ...chat, message_type: 'text', ...atBot,
    ...(withSync ? { sync_to_chat_info: { type: 2, related_message_id: MAIN_COPY } } : {}) };
}
function mainCopy(chat: { chat_id: string; chat_type: string }, withSync = true): Shape {
  return { message_id: MAIN_COPY, create_time: at, update_time: at, ...chat, message_type: 'text', ...atBot,
    ...(withSync ? { sync_to_chat_info: { type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC } } : {}) };
}
/** The same message without the @: 免@, or a group resuming sessions. */
function noAt(message: Shape): Shape {
  const { mentions: _mentions, ...rest } = message;
  return { ...rest, content: JSON.stringify({ text: TEXT }) };
}
const GROUP = { chat_id: 'oc_demo', chat_type: 'group' };
const DM = { chat_id: 'oc_dm', chat_type: 'p2p' };

/** The owner sends it (helpers/lark-events). */
const receive = (message: Shape): Promise<NormalizedMessage> => receiveEvent(message, { bot: BOT });

const gotItem = (item: Shape) => ({ code: 0, data: { items: [item] } });
const logged = (event: string) => fake.log.info.mock.calls.filter(call => call[0] === 'intake' && call[1] === event).map(call => call[2] as Shape);

beforeEach(() => {
  vi.clearAllMocks();
  fake.get.mockReset(); // also drops a failed test's unused once-values
  fake.get.mockImplementation(async () => gotItem({ thread_id: 'omt_opened_topic' }));
});

describe('the SDK hands sync_to_chat_info through', () => {
  it('keeps the event message untouched in raw', async () => {
    const msg = await receive(mainCopy(GROUP));
    expect(msg).toMatchObject({ messageId: MAIN_COPY, chatType: 'group', mentionedBot: true, threadId: undefined, content: TEXT });
    expect((msg.raw as { message: Shape }).message.sync_to_chat_info).toEqual({ type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC });
  });
});

describe('createSyncCopyGate', () => {
  const channel = () => ({ rawClient: { im: { v1: { message: { get: fake.get } } } } }) as never;

  it('drops the main-area copy and keeps the topic message, from the event field alone', async () => {
    const gate = createSyncCopyGate(channel());
    expect(await gate.skip(await receive(topicMessage(GROUP)), true)).toBe(false);
    expect(await gate.skip(await receive(mainCopy(GROUP)), true)).toBe(true);
    expect(await gate.skip(await receive(mainCopy(DM)), true)).toBe(true);
    expect(fake.get).not.toHaveBeenCalled();
    expect(logged('sync-copy-skipped')).toEqual([
      { via: 'event', chatType: 'group', ref: MAIN_COPY.slice(-6) },
      { via: 'event', chatType: 'p2p', ref: MAIN_COPY.slice(-6) },
    ]);
  });

  it('logs the receive event\'s field names once without the field and once with it', async () => {
    const gate = createSyncCopyGate(channel());
    await gate.skip(await receive(mainCopy(GROUP, false)), false);
    await gate.skip(await receive(mainCopy(GROUP, false)), false);
    await gate.skip(await receive(topicMessage(GROUP)), true);
    await gate.skip(await receive(mainCopy(GROUP)), true);
    const lines = logged('receive-fields');
    expect(lines).toEqual([
      { syncToChatInfo: false, fields: Object.keys(mainCopy(GROUP, false)).sort() },
      { syncToChatInfo: true, fields: Object.keys(topicMessage(GROUP)).sort() },
    ]);
    // Names only: no ids, no text.
    expect(JSON.stringify(lines)).not.toMatch(/om_|oc_|omt_|500/);
  });

  it('without the field, looks a main-area message it would act on up once', async () => {
    const gate = createSyncCopyGate(channel());
    fake.get.mockResolvedValueOnce(gotItem({ message_id: MAIN_COPY, sync_to_chat_info: { type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC } }));
    expect(await gate.skip(await receive(mainCopy(GROUP, false)), true)).toBe(true);
    expect(fake.get).toHaveBeenCalledTimes(1);
    expect(fake.get).toHaveBeenCalledWith({ path: { message_id: MAIN_COPY } });
    expect(logged('sync-copy-skipped')).toEqual([{ via: 'lookup', chatType: 'group', ref: MAIN_COPY.slice(-6) }]);
    expect(logged('sync-lookup')).toHaveLength(1);
    // An ordinary message: the lookup has no field.
    fake.get.mockResolvedValueOnce(gotItem({ message_id: MAIN_COPY }));
    expect(await gate.skip(await receive({ ...mainCopy(GROUP, false), message_id: 'om_plain' }), true)).toBe(false);
    expect(logged('sync-lookup')).toHaveLength(1);
  });

  it('does not look up a topic message, one it would not act on, or once a main-area copy\'s event carried the field', async () => {
    const gate = createSyncCopyGate(channel());
    expect(await gate.skip(await receive(topicMessage(GROUP, false)), true)).toBe(false);
    expect(await gate.skip(await receive(mainCopy(GROUP, false)), false)).toBe(false);
    expect(fake.get).not.toHaveBeenCalled();
    expect(await gate.skip(await receive(mainCopy(GROUP)), true)).toBe(true);
    expect(await gate.skip(await receive(mainCopy(GROUP, false)), true)).toBe(false);
    expect(fake.get).not.toHaveBeenCalled();
  });

  it('keeps looking up while only topic messages\' events carry the field', async () => {
    const gate = createSyncCopyGate(channel());
    const copyItem = gotItem({ message_id: MAIN_COPY, sync_to_chat_info: { type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC } });
    for (let pair = 0; pair < 2; pair++) {
      fake.get.mockResolvedValueOnce(copyItem);
      expect(await gate.skip(await receive(mainCopy(GROUP, false)), true)).toBe(true);
      expect(await gate.skip(await receive(topicMessage(GROUP)), true)).toBe(false);
    }
    expect(fake.get).toHaveBeenCalledTimes(2);
    expect(logged('sync-copy-skipped').map(line => line.via)).toEqual(['lookup', 'lookup']);
  });

  it('skips only type 1: another type, a main-area reply or a quote is answered', async () => {
    const gate = createSyncCopyGate(channel());
    expect(await gate.skip(await receive(mainCopy(GROUP)), true)).toBe(true); // events carry the field: no lookups below
    expect(await gate.skip(await receive({ ...mainCopy(GROUP), message_id: 'om_type3', sync_to_chat_info: { type: 3 } }), true)).toBe(false);
    expect(await gate.skip(await receive({ ...mainCopy(GROUP), message_id: 'om_type2_main', sync_to_chat_info: { type: 2, related_message_id: IN_TOPIC } }), true)).toBe(false);
    expect(await gate.skip(await receive({ ...mainCopy(GROUP, false), message_id: 'om_reply', root_id: ROOT, parent_id: ROOT }), true)).toBe(false);
    expect(await gate.skip(await receive({ ...mainCopy(DM, false), message_id: 'om_quote', parent_id: IN_TOPIC }), true)).toBe(false);
    expect(fake.get).not.toHaveBeenCalled();
    expect(logged('sync-copy-skipped')).toHaveLength(1);
  });

  it('does nothing without a raw event', async () => {
    const gate = createSyncCopyGate(channel());
    const { raw: _raw, ...bare } = await receive(mainCopy(GROUP));
    expect(await gate.skip(bare, true)).toBe(false);
    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.log.info).not.toHaveBeenCalled();
  });

  it('warns again for a failure after a lookup succeeded', async () => {
    const gate = createSyncCopyGate(channel());
    const copy = await receive(mainCopy(GROUP, false));
    fake.get.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await gate.skip(copy, true)).toBe(false);
    fake.get.mockResolvedValueOnce(gotItem({ message_id: 'om_plain' }));
    expect(await gate.skip({ ...copy, messageId: 'om_plain' }, true)).toBe(false);
    fake.get.mockResolvedValueOnce({ code: 99991400, msg: 'rate limited' });
    expect(await gate.skip({ ...copy, messageId: 'om_limited' }, true)).toBe(false);
    fake.get.mockResolvedValueOnce({ code: 99991400, msg: 'rate limited' });
    expect(await gate.skip({ ...copy, messageId: 'om_limited_again' }, true)).toBe(false);
    expect(fake.log.warn.mock.calls).toEqual([
      ['intake', 'sync-lookup-failed', { err: 'socket hang up' }],
      ['intake', 'sync-lookup-failed', { err: 'code=99991400' }],
    ]);
  });

  it('fails open on an error, a refusal and a timeout, warning once', async () => {
    const gate = createSyncCopyGate(channel(), 20);
    const copy = await receive(mainCopy(GROUP, false));
    fake.get.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await gate.skip(copy, true)).toBe(false);
    fake.get.mockResolvedValueOnce({ code: 230002, msg: 'bot not in chat' });
    expect(await gate.skip({ ...copy, messageId: 'om_refused' }, true)).toBe(false);
    fake.get.mockImplementationOnce(() => new Promise(() => {}));
    expect(await gate.skip({ ...copy, messageId: 'om_slow' }, true)).toBe(false);
    expect(fake.get).toHaveBeenCalledTimes(3);
    expect(fake.log.warn.mock.calls).toEqual([['intake', 'sync-lookup-failed', { err: 'socket hang up' }]]);
    expect(logged('sync-copy-skipped')).toEqual([]);
  });

  it('times out on its own', async () => {
    const gate = createSyncCopyGate(channel(), 20);
    fake.get.mockImplementationOnce(() => new Promise(() => {}));
    expect(await gate.skip(await receive(mainCopy(GROUP, false)), true)).toBe(false);
    expect(fake.log.warn).toHaveBeenCalledWith('intake', 'sync-lookup-failed', { err: 'timeout' });
  });
});

describe('the orchestrator answers only the topic message', () => {
  const base = { name: 'demo', chatId: 'oc_demo', cwd: workspace, kind: 'multi', noMention: false, mode: 'qa', guestMode: 'qa', network: false };
  const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] }, completionReminder: { mode: 'manual' } } };
  // The group's only bot (s22 looks nothing up then).
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: { create: fake.react, delete: async () => ({}) }, message: { get: fake.get }, chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', bot_count: '1' } }) } } } } };
  let orchestrator: ReturnType<typeof createOrchestrator>;
  let events: DiagnosticsEvent[] = [];
  const records = () => events.flatMap(event => event.kind === 'notReplied' ? [event.record] : []);
  const reactedTo = () => fake.react.mock.calls.map(call => (call as unknown as [{ path: { message_id: string } }])[0].path.message_id);
  const sentFor = () => fake.send.mock.calls.map(call => (call as unknown as [string, unknown, { replyTo?: string }?])[2]?.replyTo);

  beforeEach(() => {
    events = [];
    setDiagnosticsSink(event => events.push(event));
    fake.project = { ...base };
    orchestrator = createOrchestrator(channel as never, cfg, workspace);
  });
  afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

  /** Both copies, the main one first so a turn for it would start first; then drain. */
  async function sendBoth(chat: typeof GROUP, withSync = true): Promise<void> {
    await orchestrator.onMessage(await receive(mainCopy(chat, withSync)));
    await orchestrator.onMessage(await receive(topicMessage(chat, withSync)));
  }
  async function drained(): Promise<void> {
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', { terminal: 'done' }));
    await orchestrator.shutdown();
  }

  it('in a group that opens topics, does not open one for the copy', async () => {
    await sendBoth(GROUP);
    await drained();
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).not.toContain(MAIN_COPY);
    expect(reactedTo()).toContain(IN_TOPIC);
    expect(sentFor()).not.toContain(MAIN_COPY);
    expect(records()).toEqual([]);
    expect(fake.get.mock.calls.map(call => (call as unknown as [{ path: { message_id: string } }])[0].path.message_id)).not.toContain(MAIN_COPY);
  });

  it('in a continuous group, does not answer the copy in the main area', async () => {
    fake.project = { ...base, kind: 'single' };
    await sendBoth(GROUP);
    await drained();
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).not.toContain(MAIN_COPY);
    expect(sentFor()).not.toContain(MAIN_COPY);
    expect(records()).toEqual([]);
  });

  // dm-agent 5: the words in a private topic are the Agent's; here no row exists, so the one answer is the sentence.
  it('in a DM topic, answers once, the topic message', async () => {
    await sendBoth(DM);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(1));
    expect(sentFor()).toEqual([IN_TOPIC]);
    expect(fake.dm).not.toHaveBeenCalled();
  });

  it('notes a disabled group\'s @ once, for the topic message', async () => {
    fake.project = { ...base, enabled: false };
    await sendBoth(GROUP);
    expect(records().map(record => [record.place, record.ref])).toEqual([['topic', IN_TOPIC.slice(-6)]]);
  });

  it('without the field in the event, finds the copy with one lookup', async () => {
    fake.get.mockImplementation(async ({ path }: { path: { message_id: string } }) => path.message_id === MAIN_COPY
      ? gotItem({ message_id: MAIN_COPY, sync_to_chat_info: { type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC } })
      : gotItem({ thread_id: 'omt_opened_topic' }));
    await sendBoth(GROUP, false);
    await drained();
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).not.toContain(MAIN_COPY);
    expect(fake.get.mock.calls.filter(call => (call as unknown as [{ path: { message_id: string } }])[0].path.message_id === MAIN_COPY)).toHaveLength(1);
    expect(records()).toEqual([]);
  });

  /** Events without the field: the lookup finds the copy, any other id is an opened topic's message. */
  function lookupFindsCopy(): void {
    fake.get.mockImplementation(async ({ path }: { path: { message_id: string } }) => path.message_id === MAIN_COPY
      ? gotItem({ message_id: MAIN_COPY, sync_to_chat_info: { type: 1, related_message_id: IN_TOPIC, thread_id: TOPIC } })
      : gotItem({ thread_id: 'omt_opened_topic' }));
  }
  const lookedUp = () => fake.get.mock.calls.filter(call => (call as unknown as [{ path: { message_id: string } }])[0].path.message_id === MAIN_COPY);

  it('in a 免@ continuous group, looks the copy without an @ up and does not answer it', async () => {
    fake.project = { ...base, kind: 'single', noMention: true };
    lookupFindsCopy();
    await orchestrator.onMessage(await receive(noAt(mainCopy(GROUP, false))));
    await orchestrator.onMessage(await receive(noAt(topicMessage(GROUP, false))));
    await drained();
    expect(lookedUp()).toHaveLength(1);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).not.toContain(MAIN_COPY);
    expect(sentFor()).not.toContain(MAIN_COPY);
    expect(records()).toEqual([]);
  });

  it('in a 免@ group that opens topics, neither looks up nor answers a main-area copy without an @', async () => {
    fake.project = { ...base, noMention: true };
    lookupFindsCopy();
    await orchestrator.onMessage(await receive(noAt(mainCopy(GROUP, false))));
    await orchestrator.onMessage(await receive(noAt(topicMessage(GROUP, false))));
    await drained();
    expect(lookedUp()).toEqual([]);
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).not.toContain(MAIN_COPY);
  });

  it('while sessions are being resumed, sends the wait note once, for the topic message', async () => {
    let failHistory!: (error: Error) => void;
    fake.readHistory.mockImplementationOnce(() => new Promise((_resolve, reject) => { failHistory = reject; }));
    lookupFindsCopy();
    const resuming = orchestrator.collaboration({ action: 'resume', projectName: 'demo', chatId: 'oc_demo', sessionId: 'past', backend: 'codex-appserver' } as never);
    await vi.waitFor(() => expect(fake.readHistory).toHaveBeenCalledOnce());
    try {
      await orchestrator.onMessage(await receive(noAt(mainCopy(GROUP, false))));
      await orchestrator.onMessage(await receive(noAt(topicMessage(GROUP, false))));
      expect(lookedUp()).toHaveLength(1);
      expect(sentFor()).toEqual([IN_TOPIC]);
    } finally { failHistory(new Error('fixture: resume ends')); }
    await expect(resuming).rejects.toThrow('fixture: resume ends');
  });

  it('answers a main-area @ the lookup cannot place', async () => {
    fake.get.mockRejectedValueOnce(new Error('socket hang up'));
    await orchestrator.onMessage(await receive(mainCopy(GROUP, false)));
    await drained();
    expect(startThread).toHaveBeenCalledTimes(1);
    expect(reactedTo()).toContain(MAIN_COPY);
  });
});
