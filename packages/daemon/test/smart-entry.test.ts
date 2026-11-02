import { FocusEverywhere } from './helpers/focus-everywhere';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';
import { addProject, getProjectByName } from '../src/project/registry';
import { projectRevision } from '../src/admin/collaboration';
import type { JudgeRequest, JudgeResult } from '../src/judge/types';
import { receive, type EventMessage } from './helpers/lark-events';
import { DM, GS, SMART_NO_MENTION_NOTE } from '../src/card/dm-cards';
import { NOT_DM_MESSAGE } from '../src/agent/entry/registry';
import { sendManagedCard } from '../src/card/managed';

// s25c: what an entry writes is what the inbound path reads. Real registry on disk, the SDK's own event parsing;
// only Feishu, the agent and the judge are fakes.
vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'smart-entry-'));
  const botDir = (appId: string) => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => { const dir = botDir(appId); return { dir, configFile: join(dir, 'config.json'), projectsFile: join(dir, 'projects.json'), sessionsFile: join(dir, 'sessions.json') }; };
  return { botDir, botPaths, paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments'), botsFile: join(appDir, 'bots.json') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({
  send: vi.fn(async () => ({ messageId: 'om_sent' })),
  judge: vi.fn(),
  /** Cards a tap redrew in place. */
  updated: [] as unknown[],
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: (id: string) => ({ id, listModels: async () => [], startThread: vi.fn() }) }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: vi.fn(async () => ({ messageId: 'om_card' })), updateManagedCard: vi.fn(async (_channel: unknown, _id: string, card: unknown) => { fake.updated.push(card); return true; }) }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/judge/judge', async original => ({ ...await original<object>(), createJudge: () => ({ judge: fake.judge, warm: () => {}, shutdown: async () => {} }) }));

import { createOrchestrator } from '../src/bot/handle-message';

const BOT = { openId: 'ou_bot', name: '小码' };
const CHAT = 'oc_entry';
const target = { projectName: 'entry', chatId: CHAT };
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, completionReminder: { mode: 'manual' } } };
const channel = {
  send: fake.send, botIdentity: BOT,
  rawClient: { appId: 'cli_fixture', im: { v1: {
    message: { list: async () => ({ code: 0, data: { items: [], has_more: false } }), get: async () => ({ code: 0, data: { items: [] } }) },
    messageReaction: { create: async () => ({ data: { reaction_id: 'r' } }), delete: async () => ({}) },
    chat: { get: async () => ({ code: 0, data: { chat_mode: 'group', bot_count: '1' } }) },
  } } },
};

let sequence = 0;
/** A main-area message from the owner that names no one. */
function chatter(text: string): EventMessage {
  const id = `om_entry_${++sequence}`;
  const time = String(Date.now() + sequence * 1000);
  return { message_id: id, create_time: time, update_time: time, chat_id: CHAT, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }) };
}

let orchestrator: ReturnType<typeof createOrchestrator>;
let events: DiagnosticsEvent[] = [];
const judgeRecords = () => events.flatMap(event => event.kind === 'notReplied' && event.record.reason.startsWith('judge') ? [event.record] : []);
const send = async (m: EventMessage) => orchestrator.onMessage(await receive(m, { bot: BOT }));
async function switchTo(kind: 'multi' | 'single' | 'smart') {
  const expectedRevision = projectRevision((await getProjectByName('entry'))!);
  return orchestrator.collaboration({ action: 'editProject', ...target, expectedRevision, kind });
}

beforeEach(async () => {
  vi.clearAllMocks();
  events = [];
  fake.updated = [];
  await rm(paths.projectsFile, { force: true });
  await rm(paths.sessionsFile, { force: true });
  await addProject({ name: 'entry', chatId: CHAT, cwd: paths.appDir, kind: 'single', blank: false, origin: 'joined', createdAt: 1, backend: 'codex-appserver', mode: 'full', noMention: true, judge: { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' } });
  fake.judge.mockImplementation(async (_req: JudgeRequest): Promise<JudgeResult> =>
    ({ decision: 'skip', reason: '闲聊', backend: 'codex-appserver', model: 'm', modelSource: 'default', promptSource: 'default', ms: 1 }));
  setDiagnosticsSink(event => events.push(event));
  orchestrator = createOrchestrator(channel as never, cfg, paths.appDir, undefined, { attention: new FocusEverywhere() });
});
afterEach(async () => { setDiagnosticsSink(undefined); await orchestrator.shutdown(); });

describe('s25c: the web entry writes 智能 the way the inbound path reads it', () => {
  it('judges an unnamed main-area message once switched to 智能, stops after 多会话, and says so again on the way back', async () => {
    await switchTo('smart');
    expect(fake.send).toHaveBeenCalledWith(CHAT, { text: '我会读群消息，合适时接话。' });
    await send(chatter('下周发布要不要先砍掉导出功能？'));
    await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(1));
    expect(fake.judge.mock.calls[0]![0]).toMatchObject({ variant: 'main' });
    await vi.waitFor(() => expect(judgeRecords().map(record => record.reason)).toEqual(['judge-skip']));

    await switchTo('multi');
    await send(chatter('今天食堂的红烧肉不错'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.judge).toHaveBeenCalledTimes(1);
    expect(judgeRecords()).toHaveLength(1);

    fake.send.mockClear();
    await switchTo('smart');
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledWith(CHAT, { text: '我会读群消息，合适时接话。' });
    await send(chatter('导出功能谁在用？'));
    await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(2));
  });

  it('a 单会话 group reached from 智能 answers by its own rule again: no judgement, 免@ off', async () => {
    await switchTo('smart');
    await switchTo('single');
    expect(await getProjectByName('entry')).toMatchObject({ kind: 'single', noMention: false });
    await send(chatter('有人在吗'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fake.judge).not.toHaveBeenCalled();
    expect(judgeRecords()).toEqual([]);
  });

  it('an old card\'s 免@ button on a group since switched to 智能 is refused and redraws the card without it', async () => {
    await switchTo('smart');
    const tap = (a: string, extra: Record<string, unknown> = {}) => ({ chatId: CHAT, messageId: `om_old_${a}`, operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a, v: 'on', ...extra } } });
    await orchestrator.dispatcher.handle(tap(DM.setNoMentionDm, { n: 'entry' }) as never);
    await vi.waitFor(() => expect(fake.updated).toHaveLength(1), { timeout: 3000 });
    const card = JSON.stringify(fake.updated[0]);
    expect(card).toContain('⚠️ 没有改：这个群现在是智能开话题。');
    expect(card).toContain(SMART_NO_MENTION_NOTE);
    expect(card).not.toContain(`"a":"${DM.setNoMentionDm}"`);
    expect(await getProjectByName('entry')).toMatchObject({ kind: 'single', smart: true, noMention: false });
  });

  it('an old in-group settings card changes nothing any more (s1b): its 免@ button turns into the not-dm sentence', async () => {
    const tap = { chatId: CHAT, messageId: 'om_old_gs', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: GS.setNoMention, v: 'off' } } };
    await orchestrator.dispatcher.handle(tap as never);
    await vi.waitFor(() => expect(fake.updated).toHaveLength(1), { timeout: 3000 });
    const card = JSON.stringify(fake.updated[0]);
    expect(card).toContain(NOT_DM_MESSAGE);
    expect(card).not.toContain(`"a":"${GS.setNoMention}"`);
    expect(await getProjectByName('entry')).toMatchObject({ kind: 'single', noMention: true });
  });
});

describe('s1b: /settings is a private chat\'s', () => {
  const managed = () => vi.mocked(sendManagedCard).mock.calls;
  const atBot = (text: string, extra: Record<string, unknown> = {}): EventMessage => {
    const id = `om_settings_${++sequence}`;
    const time = String(Date.now() + sequence * 1000);
    return { message_id: id, create_time: time, update_time: time, chat_id: CHAT, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: '@_user_1', id: { open_id: BOT.openId }, name: BOT.name }], ...extra };
  };

  it('a group\'s /settings, in the main area or a topic, from the owner, says where to change settings and sends no card', async () => {
    for (const kind of ['single', 'multi', 'smart'] as const) {
      if (kind !== 'single') await switchTo(kind);
      fake.send.mockClear();
      vi.mocked(sendManagedCard).mockClear();
      const main = atBot('/settings');
      await send(main);
      await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(CHAT, { markdown: NOT_DM_MESSAGE }, { replyTo: main.message_id }));
      const topic = atBot('/settings', { thread_id: 'omt_settings', root_id: 'om_root', parent_id: 'om_root' });
      await send(topic);
      await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith(CHAT, { markdown: NOT_DM_MESSAGE }, { replyTo: topic.message_id, replyInThread: true }));
      expect(managed()).toEqual([]);
    }
  });

  it('a private chat\'s /settings still opens the private console', async () => {
    vi.mocked(sendManagedCard).mockClear();
    const time = String(Date.now());
    await send({ message_id: 'om_dm_settings', create_time: time, update_time: time, chat_id: 'oc_dm', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '/settings' }) });
    await vi.waitFor(() => expect(managed()).toHaveLength(1));
    expect(managed()[0]![1]).toBe('oc_dm');
    expect(JSON.stringify(managed()[0]![2])).not.toContain(NOT_DM_MESSAGE);
    expect(fake.send).not.toHaveBeenCalledWith('oc_dm', { markdown: NOT_DM_MESSAGE }, expect.anything());
  });
});

describe('attention forgets (s25g)', () => {
  let clock = Date.now();
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fn(): void }>();
  const time = {
    now: () => clock,
    setTimer: (fn: () => void, ms: number) => { const h = ++nextTimer; timers.set(h, { at: clock + ms, fn }); return h; },
    clearTimer: (h: unknown) => { if (typeof h === 'number') timers.delete(h); },
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  async function advance(ms: number): Promise<void> {
    const end = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); clock = Math.max(clock, next[1].at); next[1].fn(); await settle();
    }
    clock = end; await settle();
  }
  const forgotten = () => fake.log.info.mock.calls.filter(([, e]) => e === 'attention-forget').map(([, , f]) => f);
  beforeEach(async () => {
    timers.clear(); clock = Date.now(); await orchestrator.shutdown();
    orchestrator = createOrchestrator(channel as never, cfg, paths.appDir, undefined, { time });
  });
  it('58. resets attention on both mode transitions and unbinding, but not on an unchanged mode', async () => {
    await switchTo('smart'); fake.log.info.mockClear();
    await send(chatter('ENTRY_FIRST')); await settle(); expect(fake.judge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(timers.size).toBe(1));
    await advance(20_000); await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(1));
    await switchTo('single'); expect(forgotten()).toHaveLength(1); expect(forgotten()[0]).toMatchObject({ why: 'mode' });
    await switchTo('smart'); expect(forgotten()).toHaveLength(2); expect(forgotten()[1]).toMatchObject({ why: 'mode' });
    await send(chatter('ENTRY_RESET')); await vi.waitFor(() => expect(timers.size).toBe(1));
    await advance(20_000); await vi.waitFor(() => expect(fake.judge).toHaveBeenCalledTimes(2));
    await switchTo('smart'); expect(forgotten()).toHaveLength(2);
    const expectedRevision = projectRevision((await getProjectByName('entry'))!);
    await orchestrator.collaboration({ action: 'removeProject', ...target, expectedRevision });
    expect(forgotten()).toHaveLength(3); expect(forgotten()[2]).toMatchObject({ why: 'unbind' });
  });
});
