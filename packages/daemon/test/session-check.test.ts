import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { SessionInUseError, type AgentEvent, type AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  project: { name: 'test', chatId: 'chat', cwd: '/test', kind: 'single' } as Record<string, unknown>,
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), listSkills: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
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
  getProjectByName: async (name: string) => fake.project.name === name ? fake.project : undefined,
  mutateProject: async (_name: string, change: (project: typeof fake.project) => void | Promise<void>) => { await change(fake.project); return fake.project; },
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
import {projectSkillKey} from '../src/bot/skill-profile';
import {CodexAppServerBackend} from '../src/agent/codex-appserver/backend';
import {shutdownResidentClients, utilityRequest} from '../src/agent/codex-appserver/client-pool';

// s15b: a live session is checked against its native file before a turn, a native
// compaction makes the recent-topics table due, and a Codex session is let go after a run.

interface Opts { foreign?: () => Promise<{ foreign: boolean }>; lastCompaction?: string; releaseAfterRun?: boolean; hold?: Promise<void>; closed?: Promise<void>; firstEvents?: AgentEvent[] }
function thread(sessionId: string, opts: Opts = {}) {
  const consumed: AgentInput[] = [];
  const t = {
    sessionId, isAlive: () => true, supportsSteer: false,
    lastCompaction: opts.lastCompaction,
    releaseAfterRun: opts.releaseAfterRun,
    ...(opts.foreign ? { checkNative: vi.fn(opts.foreign) } : {}),
    close: vi.fn(async () => { await opts.closed; }),
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
          if (consumed.length === 1) yield* opts.firstEvents ?? [];
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
function setup(topics?: TopicRegistry, create = createOrchestrator) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] } } };
  const channel = { send: fake.send, rawClient: { appId: 'cli_me', im: { v1: { message: { get: fake.get, list: fake.list }, chat: { get: fake.chatGet }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = create(channel as never, cfg, '/test', topics);
  return orchestrator;
}
const record = (key: string, extra: object = {}) => ({ threadId: key, chatId: 'chat', sessionId: `old-${key}`, backend: 'codex', cwd: '/test', summary: '', model: 'm', effort: 'medium', lastSeenAt: 5, ...extra });
const finals = () => (fake.log.info.mock.calls as unknown[][]).filter((c) => c[0] === 'card' && c[1] === 'final').length;
async function turn(o: ReturnType<typeof setup>, msg: NormalizedMessage, timeout = 1000) {
  const before = finals();
  await o.onMessage(msg);
  await vi.waitFor(() => expect(finals()).toBe(before + 1), {timeout});
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
  fake.backend.id = 'codex';
});

it.runIf(process.env.GROUP_SKILLS_NATIVE_LIVE === '1')('refreshes actual native skills on a stored session, after restart, and when re-enabled', {timeout: 180_000}, async () => {
  const home = process.env.HOME;
  if (!home?.startsWith(tmpdir()) || !process.env.CODEX_HOME || !process.env.VONVON_HOME?.startsWith(home)) throw new Error('Use an isolated native verification HOME');
  const cwd = mkdtempSync(join(home, 'orchestrator-skills-'));
  const name = `vonvon-orchestrator-${Date.now()}`;
  const path = join(cwd, '.agents', 'skills', name, 'SKILL.md');
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, `---\nname: ${name}\ndescription: Native orchestrator skill visibility verification.\n---\nOnly say SKILL_VERIFICATION.\n`);
  fake.project.cwd = cwd; fake.backend.id = 'codex-appserver';
  fake.backend.listModels.mockResolvedValue([{id: 'gpt-6-luna', displayName: 'Native test', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false}] as never);
  let native = new CodexAppServerBackend();
  let nativeUtility = utilityRequest;
  let shutdownNative = shutdownResidentClients;
  fake.backend.startThread.mockImplementation(opts => native.startThread(opts));
  fake.backend.resumeThread.mockImplementation(opts => native.resumeThread(opts));
  const evidence: {phase: string; sessionId: string; loaded: boolean}[] = [];
  async function context(phase: string) {
    const sessionId: string = fake.records.get('chat').sessionId;
    const result = await nativeUtility<{thread: {path: string}}>('thread/read', {threadId: sessionId, includeTurns: false});
    const records = readFileSync(result.thread.path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    const instructions = records.filter(row => row.type === 'response_item' && row.payload.type === 'message' && ['developer', 'user'].includes(row.payload.role))
      .flatMap(row => row.payload.content.map((item: {text?: string}) => item.text ?? '')).filter((text: string) => text.includes('Skills')).join('\n');
    const observed = {phase, sessionId, loaded: instructions.includes(name)}; evidence.push(observed);
    if (process.env.GROUP_SKILLS_EVIDENCE) writeFileSync(process.env.GROUP_SKILLS_EVIDENCE.replace(/\.json$/, '-orchestrator.json'), JSON.stringify(evidence, null, 2));
    return observed;
  }
  try {
    const first = setup();
    await turn(first, message('Reply only SKILLS_READY. Do not invoke skills or tools.'), 45_000);
    const enabled = await context('enabled'); expect(enabled.loaded).toBe(true);
    fake.project.skills = {disabledPaths: [path]};
    await turn(first, message('Reply only SKILLS_READY. Do not invoke skills or tools.'), 45_000);
    const disabled = await context('disabled'); expect(disabled.loaded).toBe(false); expect(disabled.sessionId).not.toBe(enabled.sessionId);
    expect(sent()).toContain('本群技能已更新');
    expect(readFileSync((await nativeUtility<{thread: {path: string}}>('thread/read', {threadId: enabled.sessionId, includeTurns: false})).thread.path, 'utf8')).toContain(name);
    await first.shutdown();
    // A daemon shutdown permanently closes its process registries. Reload modules like a fresh daemon process.
    vi.resetModules();
    const freshBackend = await import('../src/agent/codex-appserver/backend');
    const freshPool = await import('../src/agent/codex-appserver/client-pool');
    const freshOrchestrator = await import('../src/bot/handle-message');
    native = new freshBackend.CodexAppServerBackend(); nativeUtility = freshPool.utilityRequest; shutdownNative = freshPool.shutdownResidentClients;
    const restarted = setup(undefined, freshOrchestrator.createOrchestrator);
    await turn(restarted, message('Reply only SKILLS_READY. Do not invoke skills or tools.'), 45_000);
    const resumed = await context('restart-disabled'); expect(resumed.loaded).toBe(false); expect(resumed.sessionId).toBe(disabled.sessionId);
    fake.project.skills = {disabledPaths: []};
    await turn(restarted, message('Reply only SKILLS_READY. Do not invoke skills or tools.'), 45_000);
    const reenabled = await context('reenabled'); expect(reenabled.loaded).toBe(true); expect(reenabled.sessionId).not.toBe(disabled.sessionId);
    if (process.env.GROUP_SKILLS_EVIDENCE) writeFileSync(process.env.GROUP_SKILLS_EVIDENCE.replace(/\.json$/, '-orchestrator.json'), JSON.stringify(evidence, null, 2));
  } catch (error) {
    if (process.env.GROUP_SKILLS_EVIDENCE) writeFileSync(process.env.GROUP_SKILLS_EVIDENCE.replace(/\.json$/, '-orchestrator-errors.json'), JSON.stringify(fake.log.fail.mock.calls.map(args => args.map(value => value instanceof Error ? value.message : value)), null, 2));
    throw error;
  } finally {await orchestrator?.shutdown(); await shutdownNative();}
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

describe('live permission binding', () => {
  it('keeps the clear-history floor after desktop skill refresh and does not weave older messages back in', async () => {
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    fake.records.set('chat', record('chat', {from: 1000, lastSeenAt: 1500, seen: [{id: 'before-clear', at: 900}], streaming: [{id: 'before-clear', at: 900}], recalls: [{id: 'before-clear', at: 900, kind: 'recalled'}], titleJobKey: 'old-title'}));
    const old = thread('old-chat'), fresh = thread('fresh');
    fake.backend.resumeThread.mockResolvedValueOnce(old.t); fake.backend.startThread.mockResolvedValueOnce(fresh.t);
    const o = setup();
    expect(await o.collaboration({action: 'compact', projectName: 'test', chatId: 'chat', threadId: 'chat'})).toMatchObject({ok: true});
    expect(fake.records.get('chat')).toMatchObject({sessionId: 'fresh', from: 1000, lastSeenAt: 1000, seen: [], streaming: [], recalls: []});
    expect(fake.records.get('chat').titleJobKey).not.toBe('old-title');
    fake.chat.mockResolvedValue({messages: [
      {messageId: 'before-clear', senderName: 'Owner', from: 'user', text: 'BEFORE_CLEAR_PRIVATE', createTime: 900},
      {messageId: 'after-clear', senderName: 'Owner', from: 'user', text: 'AFTER_CLEAR_CONTEXT', createTime: 1100},
    ], ok: true, complete: true});
    await turn(o, message('下一条任务'));
    expect(fresh.consumed[0]?.text).toContain('AFTER_CLEAR_CONTEXT');
    expect(fresh.consumed[0]?.text).not.toContain('BEFORE_CLEAR_PRIVATE');
  });
  it('does not send a prepared first turn when skill settings change while chat history is being woven', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;});
    fake.chat.mockImplementationOnce(async () => {await held; return {messages: [], ok: true, complete: true};});
    fake.records.set('chat', record('chat'));
    const first = thread('old-chat'); fake.backend.resumeThread.mockResolvedValueOnce(first.t);
    const o = setup();
    await o.onMessage(message('准备任务'));
    await vi.waitFor(() => expect(fake.backend.resumeThread).toHaveBeenCalledOnce());
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    release();
    await vi.waitFor(() => expect(first.t.close).toHaveBeenCalled());
    expect(first.consumed).toHaveLength(0);
    await vi.waitFor(() => expect(sent()).toContain('本群技能在准备任务时已更新'));
  });
  it('recreates a live session after a skill is disabled and re-enables it on a later fresh session', async () => {
    fake.records.set('chat', record('chat'));
    const first = thread('old-chat'), disabled = thread('disabled-chat'), enabled = thread('enabled-chat');
    fake.backend.resumeThread.mockResolvedValueOnce(first.t);
    fake.backend.startThread.mockResolvedValueOnce(disabled.t).mockResolvedValueOnce(enabled.t);
    const o = setup(); await turn(o, message('启用时的任务'));
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    await turn(o, message('关闭后的任务'));
    expect(first.t.close).toHaveBeenCalledOnce(); expect(first.consumed).toHaveLength(1);
    expect(disabled.consumed).toHaveLength(1);
    expect(fake.backend.startThread).toHaveBeenLastCalledWith(expect.objectContaining({profile: expect.objectContaining({skills: expect.objectContaining({disabledPaths: ['/work/feedback/SKILL.md']})})}));
    expect(sent()).toContain('本群技能已更新');
    expect(fake.records.get('chat')).toMatchObject({sessionId: 'disabled-chat', skillProfile: {sessionId: 'disabled-chat'}});
    fake.project.skills = {disabledPaths: []};
    await turn(o, message('重新启用后的任务'));
    expect(disabled.t.close).toHaveBeenCalledOnce(); expect(disabled.consumed).toHaveLength(1);
    expect(enabled.consumed).toHaveLength(1);
    expect(fake.backend.startThread.mock.calls.at(-1)?.[0].profile.skills).toBeUndefined();
  });
  it('refreshes an old stored session with disabled skills after restart before running any new input', async () => {
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    fake.records.set('chat', record('chat'));
    const old = thread('old-chat'), fresh = thread('fresh-chat');
    fake.backend.resumeThread.mockResolvedValueOnce(old.t); fake.backend.startThread.mockResolvedValueOnce(fresh.t);
    await turn(setup(), message('重启后继续'));
    expect(old.t.close).toHaveBeenCalledOnce(); expect(old.consumed).toHaveLength(0);
    expect(fresh.consumed).toHaveLength(1);
    expect(fake.records.get('chat')).toMatchObject({sessionId: 'fresh-chat', skillProfile: {sessionId: 'fresh-chat'}});
  });
  it('keeps an unchanged skill policy on stored resume', async () => {
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    fake.records.set('chat', record('chat', {skillProfile: {sessionId: 'old-chat', key: projectSkillKey({skills: {disabledPaths: ['/work/feedback/SKILL.md']}})}}));
    const resumed = thread('old-chat'); fake.backend.resumeThread.mockResolvedValueOnce(resumed.t);
    const o = setup(); await turn(o, message('配置未变'));
    expect(resumed.consumed).toHaveLength(1); expect(fake.backend.startThread).not.toHaveBeenCalled();
  });
  it.each(['start', 'resume'])('closes an in-flight %s made with stale skill policy before sending input', async method => {
    if (method === 'resume') fake.records.set('chat', record('chat'));
    const stale = thread(method === 'resume' ? 'old-chat' : 'stale'), refreshed = thread('old-chat'), fresh = thread('fresh');
    let finish!: (value: typeof stale.t) => void;
    const create = method === 'resume' ? fake.backend.resumeThread : fake.backend.startThread;
    create.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValueOnce(method === 'resume' ? refreshed.t : fresh.t);
    if (method === 'resume') fake.backend.startThread.mockResolvedValueOnce(fresh.t);
    const o = setup(), before = finals(); await o.onMessage(message('准备中的任务'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    fake.project.skills = {disabledPaths: ['/work/feedback/SKILL.md']};
    finish(stale.t);
    await vi.waitFor(() => expect(finals()).toBe(before + 1));
    expect(stale.t.close).toHaveBeenCalledOnce(); expect(stale.consumed).toHaveLength(0); expect(fresh.consumed).toHaveLength(1);
    if (method === 'resume') {expect(refreshed.t.close).toHaveBeenCalledOnce(); expect(refreshed.consumed).toHaveLength(0);}
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({profile: expect.objectContaining({skills: expect.objectContaining({disabledPaths: ['/work/feedback/SKILL.md']})})}));
  });
  it('rebinds a cached full thread after the group becomes read-only even without eviction', async () => {
    fake.project.mode = 'full'; fake.project.network = true;
    fake.records.set('chat', record('chat'));
    const first = thread('old-chat'), second = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup(); await turn(o, message('一'));
    Object.assign(fake.project, {mode: 'qa', network: false});
    await turn(o, message('二'));
    expect(first.t.close).toHaveBeenCalledOnce(); expect(first.consumed).toHaveLength(1); expect(second.consumed).toHaveLength(1);
    expect(fake.backend.resumeThread).toHaveBeenLastCalledWith(expect.objectContaining({mode: 'qa', network: false}));
  });
  it.each([
    {domains: ['example.org'], sandbox: true},
    {domains: ['github.com'], sandbox: false},
  ])('rebinds a native-only change without changing mode/network: %j', async change => {
    const settings = {permissionMode: 'acceptEdits', sandbox: true, network: 'domains', domains: ['github.com']};
    Object.assign(fake.project, {backend: 'claude-agent', mode: 'write', network: false, custom: {backend: 'claude-agent', settings}});
    fake.records.set('chat', record('chat', {backend: 'claude-agent'}));
    const first = thread('old-chat'), second = thread('old-chat');
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup(); await turn(o, message('一'));
    fake.project.custom = {backend: 'claude-agent', settings: {...settings, ...change}};
    await turn(o, message('二'));
    expect(first.t.close).toHaveBeenCalledOnce();
    expect(fake.backend.resumeThread).toHaveBeenLastCalledWith(expect.objectContaining({mode: 'write', network: true, native: expect.objectContaining(change)}));
  });
  it('keeps the live binding when native object keys are reordered without a value change', async () => {
    Object.assign(fake.project, {backend: 'claude-agent', mode: 'write', custom: {backend: 'claude-agent', settings: {permissionMode: 'acceptEdits', sandbox: true, network: 'domains', domains: ['github.com']}}});
    fake.records.set('chat', record('chat', {backend: 'claude-agent'}));
    const first = thread('old-chat'); fake.backend.resumeThread.mockResolvedValue(first.t);
    const o = setup(); await turn(o, message('一'));
    fake.project.custom = {backend: 'claude-agent', settings: {domains: ['github.com'], network: 'domains', sandbox: true, permissionMode: 'acceptEdits'}};
    await turn(o, message('二'));
    expect(first.t.close).not.toHaveBeenCalled(); expect(first.consumed).toHaveLength(2);
    expect(fake.backend.resumeThread).toHaveBeenCalledOnce();
  });
  it.each(['start', 'resume'])('rejects a stale in-flight %s that a permission save could not yet evict', async method => {
    Object.assign(fake.project, {mode: 'full', network: true});
    if (method === 'resume') fake.records.set('chat', record('chat'));
    const first = thread('old-chat'), second = thread('old-chat');
    let finish!: (thread: typeof first.t) => void;
    const create = method === 'resume' ? fake.backend.resumeThread : fake.backend.startThread;
    create.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValueOnce(second.t);
    const o = setup(), before = finals();
    await o.onMessage(message('旧权限已读、provider还在准备'));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({mode: 'full', network: true}));
    await o.adminExecute({kind: 'setPermissionMode', project: 'test', mode: 'qa'});
    expect(first.t.close).not.toHaveBeenCalled(); // The save's eviction had no cached thread to close.
    finish(first.t);
    await vi.waitFor(() => expect(finals()).toBe(before + 1));
    expect(first.t.close).toHaveBeenCalledOnce(); expect(first.consumed).toHaveLength(0); expect(second.consumed).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({mode: 'qa', network: false}));
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

  it('does not show the table again for its own compaction a queued turn already showed it for', async () => {
    fake.records.set('chat', record('chat'));
    let release!: () => void;
    const first = thread('old-chat', {
      releaseAfterRun: true,
      hold: new Promise<void>((resolve) => { release = resolve; }),
      firstEvents: [{ type: 'compaction', phase: 'start', itemId: 'cc-new' }, { type: 'compaction', phase: 'end', itemId: 'cc-new' }],
    });
    // Resumed after the release: codex now reports the compaction the bot saw in turn 1.
    const second = thread('old-chat', { releaseAfterRun: true, lastCompaction: 'cc-new' });
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup(await withTopic());
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(first.consumed).toHaveLength(1));
    await o.onMessage(message('排队的'));
    await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    release();
    await vi.waitFor(() => expect(first.consumed).toHaveLength(2));
    expect(first.consumed[0]!.text).not.toContain(table);
    expect(first.consumed[1]!.text).toContain(table);
    await vi.waitFor(() => expect(first.t.close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ topicsDue: '' }));
    await turn(o, message('三'));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2);
    expect(second.consumed[0]!.text).toContain('三');
    expect(second.consumed[0]!.text).not.toContain(table);
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ compactSeen: 'cc-new', topicsDue: '' }));
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

  it('waits for the released process to close before resuming the session again', async () => {
    fake.records.set('chat', record('chat'));
    let closeDone!: () => void;
    const first = thread('old-chat', { releaseAfterRun: true, closed: new Promise<void>((resolve) => { closeDone = resolve; }) });
    const second = thread('old-chat', { releaseAfterRun: true });
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValueOnce(second.t);
    const o = setup();
    await turn(o, message('一'));
    await vi.waitFor(() => expect(first.t.close).toHaveBeenCalledTimes(1));
    await o.onMessage(message('二'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(second.consumed).toHaveLength(0);
    closeDone();
    await vi.waitFor(() => expect(fake.backend.resumeThread).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.consumed).toHaveLength(1));
    expect(second.consumed[0]!.text).toContain('二');
  });

  it('lets go of a resumed thread when the run fails before it starts', async () => {
    fake.records.set('chat', record('chat', { model: undefined }));
    const run = thread('old-chat', { releaseAfterRun: true });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.listModels.mockRejectedValue(new Error('model list down'));
    const o = setup();
    await o.onMessage(message('一'));
    await vi.waitFor(() => expect(fake.log.fail).toHaveBeenCalledWith('intake', expect.objectContaining({ message: 'model list down' })));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    expect(run.consumed).toHaveLength(0);
    await vi.waitFor(() => expect(run.t.close).toHaveBeenCalledTimes(1));
    expect(released()).toBe(1);
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
