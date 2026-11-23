import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { ContextMessage } from '../src/bot/context-weave';
import type { AgentEvent, StartThreadOptions } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';

// T4b 4.1: `profileOf` writes the builtin package exactly where the schedule tools go; a failed write hands over the
// whole package already there, or none.
const fake = vi.hoisted(() => ({
  diskSessions: false,
  history: [] as ContextMessage[],
  project: undefined as Record<string, unknown> | undefined,
  /** The stored session a topic message resumes. */
  record: undefined as Record<string, unknown> | undefined,
  backend: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  ensure: vi.fn(),
  commentCwd: '',
}));
// The package is written under the data root: a temporary one, never the real `~/.vonvon-bot`.
const dataRoot = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'profile-of-builtin-data-')));
});
vi.mock('../src/config/data-root', () => ({ resolveDataRoot: () => ({ path: dataRoot, kind: 'canonical' }) }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent/builtin-skills/package', async (original) => ({ ...await original<object>(), ensureBuiltinPackage: fake.ensure }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(),
  fetchThreadContext: async () => ({ messages: fake.history, ok: true, complete: true }), fetchChatContext: async () => ({ messages: [], ok: true, complete: true }) }));
vi.mock('../src/bot/session-store', async (original) => {
  const store = await original<typeof import('../src/bot/session-store')>();
  return { ...store, getSession: async (key: string) => fake.diskSessions ? store.getSession(key) : fake.record,
    listSessions: async () => fake.diskSessions ? store.listSessions() : [],
    patchSession: (...args: Parameters<typeof store.patchSession>) => fake.diskSessions ? store.patchSession(...args) : Promise.resolve(),
    upsertSession: (rec: Parameters<typeof store.upsertSession>[0]) => fake.diskSessions ? store.upsertSession(rec) : Promise.resolve() };
});
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} } }));
vi.mock('../src/bot/comments', async original => ({ ...await original<object>(),
  resolveComment: async () => ({ target: { fileType: 'docx', fileToken: 'fixture-doc' }, ctx: { question: 'fixture question', isWhole: true } }),
  commentCwd: () => fake.commentCwd, loadCommentInstructions: async () => 'fixture instructions', syncCommentInstructions: async () => undefined,
  postCommentReply: async () => undefined }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = async () => 'card'; getCardId() { return 'card_entity'; } async updateElement() { return true; } streamCoalesced() {}
    async drain() {} setImageWorker() {} async settleImages() { return new Map(); } updateCard = async () => true; finalizeCard = async () => true;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { legacyWorkRules } from './helpers/work-rules-fixture';
import { builtinSkillsOfSet } from '../src/agent/builtin-skills/registry';
import { CodexAppServerBackend, codexSessionParams } from '../src/agent/codex-appserver/backend';
import { createAgentEntries } from '../src/agent/entry/registry';
import { feedbackTool } from '../src/agent/entry/feedback-tool';
import { configureFeedback } from '../src/feedback/config';
import { createFeedbackHost } from '../src/feedback/host';
import { FileFeedbackStore } from '../src/feedback/store';
import type { FeedbackActor } from '../src/feedback/types';
import type { Project } from '../src/project/registry';
import { getSession, upsertSession } from '../src/bot/session-store';
import { closeCodexToolFixtures, codexToolsFixture } from './helpers/codex-tools-fixture';
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

let root: string;
let seq = 0;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'profile-of-builtin-')));
  fake.commentCwd = join(root, 'comment');
  for (const dir of ['work', 'comment']) await mkdir(join(root, dir));
  vi.clearAllMocks();
  fake.record = undefined;
  fake.diskSessions = false;
  fake.history = [];
  fake.ensure.mockResolvedValue({ path: '/builtin/group', changed: false });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(join(dataRoot, 'bots'), { recursive: true, force: true });
});
afterAll(async () => { await rm(dataRoot, { recursive: true, force: true }); });

function orchestrator(capabilityPackages = true, options?: Parameters<typeof createOrchestrator>[4], provider?: CodexAppServerBackend, create = createOrchestrator) {
  const startThread = vi.fn(async (_opts: StartThreadOptions) => ({ sessionId: 'fresh', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
    runStreamed: () => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'turn_started', turnId: 'turn' }; yield { type: 'done', turnId: 'turn' }; })() }) }));
  fake.backend = provider ?? { id: 'codex-appserver', displayName: 'codex', profileCapabilities: { capabilityPackages }, listModels: async () => [], startThread, resumeThread: startThread, listThreads: async () => [] };
  const ok = async () => ({ code: 0, data: { message_id: `om_${++seq}`, items: [] } });
  const channel = { send: async () => ({}), rawClient: {
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'card' } }) } } },
    im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'omt_new' }] } }), list: ok, reply: ok, create: ok },
      chat: { get: async () => { throw new Error('no scope'); } }, messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) } } } } };
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] } } };
  return { o: create(channel as never, cfg, root, undefined, options), startThread };
}
const message = (threadId?: string): NormalizedMessage => ({ messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', ...(threadId ? { threadId } : {}),
  content: '每天 9 点发日报', senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false });
/** The options of the session the group's message starts or, given a topic, resumes. */
async function groupSession(capabilityPackages = true, mode: 'qa' | 'write' = 'qa', threadId?: string): Promise<StartThreadOptions> {
  fake.project = { name: 'g', chatId: 'chat', cwd: join(root, 'work'), kind: 'multi', mode, createdAt: 1, blank: false };
  const { o, startThread } = orchestrator(capabilityPackages);
  await o.onMessage(message(threadId));
  await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
  await o.shutdown();
  return startThread.mock.calls[0]![0];
}
const groupProfile = async (capabilityPackages = true): Promise<SessionProfile | undefined> => (await groupSession(capabilityPackages)).profile;
/** The package an older daemon left whole, and this daemon's rewrite of it refused by a read-only skill directory. */
async function stalePackage(): Promise<{ path: string; restore: () => Promise<void> }> {
  const { ensureBuiltinPackage } = await vi.importActual<typeof import('../src/agent/builtin-skills/package')>('../src/agent/builtin-skills/package');
  const skill = builtinSkillsOfSet('group')[0]!;
  const { path } = await ensureBuiltinPackage('app', 'group', [{ ...skill, body: 'an older daemon\'s text' }]);
  fake.ensure.mockImplementation(ensureBuiltinPackage);
  const directory = join(path, 'skills', skill.name);
  await chmod(directory, 0o555);
  return { path, restore: () => chmod(directory, 0o700) };
}
const readOnlyDirectoriesBite = process.platform !== 'win32' && process.getuid?.() !== 0;

it('hands a bound group\'s session the group package', async () => {
  expect((await groupProfile())?.capabilityPackages).toEqual([{ path: '/builtin/group', kind: 'builtin' }]);
  expect(fake.ensure).toHaveBeenCalledWith('app', 'group', builtinSkillsOfSet('group'));
});

it('opens an ordinary group session even when its experimental package no longer exists', async () => {
  fake.project = { name: 'g', chatId: 'chat', cwd: join(root, 'work'), kind: 'multi', mode: 'qa', createdAt: 1, blank: false,
    workRules: 'Ordinary rule', richRecipe: legacyWorkRules('Obsolete injected text') };
  const {o, startThread} = orchestrator();
  try {
    await o.onMessage(message());
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    const profile = startThread.mock.calls[0]![0].profile;
    expect(profile?.capabilityPackages).toEqual([{path: '/builtin/group', kind: 'builtin'}]);
    expect(profile?.instructions).toContain('Ordinary rule');
    expect(profile?.instructions).not.toContain('Obsolete injected text');
  } finally { await o.shutdown(); }
});

it('starts a fresh provider thread for a persisted experimental session alias', async () => {
  fake.record = {threadId: 'omt_old', chatId: 'chat', sessionId: 'recipe_session_00000000-0000-4000-8000-000000000000',
    backend: 'codex-appserver', cwd: join(root, 'work'), summary: ''};
  const opened = await groupSession(true, 'qa', 'omt_old');
  expect(opened).not.toHaveProperty('sessionId');
  expect(opened.profile?.capabilityPackages).toEqual([{path: '/builtin/group', kind: 'builtin'}]);
});

it('upgrades an existing Codex topic once at its first configured SDK turn and keeps its history through restart', async () => {
  fake.diskSessions = true;
  const threadId = 'omt_feedback', chatId = 'oc_feedback', cwd = join(root, 'work');
  const project = {name: 'group', chatId, cwd, kind: 'multi', mode: 'full', createdAt: 1, blank: false} satisfies Project;
  fake.project = project;
  fake.ensure.mockResolvedValue({path: cwd, changed: false});
  const old = {threadId, chatId, cwd, backend: 'codex-appserver', sessionId: 'old-native', summary: 'history', createdAt: 1, updatedAt: 1};
  await upsertSession(old);
  fake.history = [{messageId: 'om_old', senderId: 'ou_old', senderName: 'Earlier author', from: 'user', text: '历史发言仅作上下文', createTime: 5}];
  const sdk = (content: string, senderId = 'ou_member'): NormalizedMessage => {
    const msg = {...message(threadId), chatId, senderId, content};
    return {...msg, raw: {sender: {sender_type: 'user', tenant_key: 'test', sender_id: {open_id: msg.senderId}},
      message: {message_id: msg.messageId, chat_id: chatId, chat_type: 'group'}}};
  };
  const review = vi.fn(async (_actor: FeedbackActor) => 'om_review');
  const user = async (actor: FeedbackActor) => ({appId: actor.appId, openId: actor.openId, name: '成员'});
  const unused = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
  const registration = 'test-registration';
  const feedback = createFeedbackHost({
    bot: {appId: 'cli_app', botId: 'bot'}, registration, root, project: id => id === chatId ? project : undefined,
    allowed: () => true, checkBot: async () => {}, close: async () => {},
    configure: async (actor, dest, binding) => {
      if (actor.openId !== 'ou_admin') throw new Error('Admin required');
      configureFeedback(project, registration, dest, binding);
    },
    im: () => ({reply: async () => {}, review, authorization: unused}), download: unused,
    authorization: {beginAuthorization: unused, finishAuthorization: user}, store: new FileFeedbackStore(join(root, 'operations')),
    gateway: {user, validate: async () => {}, lookup: unused, submit: unused, recordLink: unused},
  });
  const wire = codexToolsFixture();
  async function start() {
    // A daemon restart has a new native process registry, resident pool and in-memory session cache.
    vi.resetModules();
    const {CodexAppServerBackend} = await import('../src/agent/codex-appserver/backend');
    const {createOrchestrator} = await import('../src/bot/handle-message');
    const provider = new CodexAppServerBackend();
    vi.spyOn(provider, 'listModels').mockResolvedValue([]);
    return orchestrator(true, {feedback, entries: createAgentEntries({appId: 'cli_app', isAdmin: () => false,
      feedbackEnabled: feedback.enabled, tools: [feedbackTool]})}, provider, createOrchestrator).o;
  }
  let runner = await start();
  try {
    await runner.onMessage(sdk('配置前的普通发言 hold-old-turn'));
    await vi.waitFor(() => expect(wire.inputs()).toHaveLength(1), {timeout: 3500});
    expect(wire.inputs()[0]?.threadId).toBe('old-native');
    expect(wire.starts()).toHaveLength(0);
    await runner.onMessage(sdk('/feedback setup https://my.feishu.cn/base/BaseABC?table=tblOne https://my.feishu.cn/share/base/shrOne', 'ou_admin'));
    expect(feedback.enabled(chatId)).toBe(true);
    const first = sdk('反馈测试');
    await runner.onMessage(first);
    wire.releaseTurn();
    await vi.waitFor(() => expect(wire.answers()).toEqual([{success: true, text: expect.stringContaining('trackingCode')}]), {timeout: 3500});
    expect(wire.starts()).toHaveLength(1);
    expect(wire.inputs()[1]).toMatchObject({threadId: 'th', text: expect.stringContaining('历史发言仅作上下文')});
    expect(await getSession(threadId)).toMatchObject({sessionId: 'th', feedbackToolSessionId: 'th', earlier: ['old-native']});
    await runner.shutdown();
    runner = await start();
    const next = sdk('反馈测试');
    await runner.onMessage(next);
    await vi.waitFor(() => expect(wire.answers().filter(answer => answer.success)).toHaveLength(2), {timeout: 3500});
    expect(wire.starts()).toHaveLength(1);
    expect(wire.resumes().at(-1)?.threadId).toBe('th');
    expect(review.mock.calls.map(([actor]) => [actor.openId, actor.messageId])).toEqual([[first.senderId, first.messageId], [next.senderId, next.messageId]]);
  } finally {
    wire.releaseTurn();
    await runner.shutdown();
    await feedback.close();
    await closeCodexToolFixtures();
  }
});

it('starts the session without the package when writing it fails, and records why', async () => {
  fake.ensure.mockRejectedValue(new Error('disk full'));
  const profile = await groupProfile();
  expect(profile).toMatchObject({ capabilityPackages: [], tools: { schedule: true } });
  expect(fake.log.fail).toHaveBeenCalledWith('agent', expect.objectContaining({ message: 'disk full' }), { phase: 'builtin-package-failed', chatId: 'chat', kept: false });
  expect(fake.log.fail.mock.calls.filter(([, , fields]) => fields?.phase === 'builtin-package-failed')).toHaveLength(1);
});

it.runIf(readOnlyDirectoriesBite)('hands over the whole package already there when rewriting it fails, and records why', async () => {
  const { path, restore } = await stalePackage();
  let profile: SessionProfile | undefined;
  try { profile = await groupProfile(); } finally { await restore(); }
  expect(profile?.capabilityPackages).toEqual([{ path, kind: 'builtin' }]);
  expect(fake.log.fail).toHaveBeenCalledWith('agent', expect.objectContaining({ code: 'EACCES' }), { phase: 'builtin-package-failed', chatId: 'chat', kept: true });
});

// A resumed Codex thread keeps listing the skills its rollout stored, whatever this resume selects: the package must stay
// readable in the tiers that grant reads path by path.
for (const mode of ['qa', 'write'] as const) {
  it.runIf(readOnlyDirectoriesBite)(`keeps a resumed Codex thread's package readable in ${mode} when rewriting it fails`, async () => {
    const { path, restore } = await stalePackage();
    fake.record = { threadId: 'omt_old', chatId: 'chat', sessionId: 'thread', backend: 'codex-appserver', cwd: join(root, 'work'), summary: '' };
    let options: StartThreadOptions;
    try { options = await groupSession(true, mode, 'omt_old'); } finally { await restore(); }
    expect(options).toMatchObject({ sessionId: 'thread', mode });
    const sent = codexSessionParams(options, 'codex-cli 0.163.0', null) as Record<string, any>;
    expect(sent.selectedCapabilityRoots).toEqual([{ id: 'vonvon-builtin', location: { type: 'environment', environmentId: 'local', path } }]);
    expect(sent.config.permissions.feishu.filesystem[path]).toEqual({ '.': 'read' });
  });
}

it('writes nothing for a backend that cannot take packages', async () => {
  expect((await groupProfile(false))?.capabilityPackages).toEqual([]);
  expect(fake.ensure).not.toHaveBeenCalled();
});

// dm-agent 9: every session, wherever it runs and whether it starts or resumes, finds `vonvon`; both Providers read `env`.
describe('the launcher in a session\'s env', () => {
  const CLI = join('/data', 'bin', 'vonvon');
  const onPath = { VONVON_CLI: CLI };
  const started = async (start: (o: ReturnType<typeof createOrchestrator>) => Promise<unknown>) => {
    const { o, startThread } = orchestrator(true, { sessionCli: CLI });
    await start(o);
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    await o.shutdown();
    return startThread.mock.calls[0]![0];
  };
  const group = () => ({ name: 'g', chatId: 'chat', cwd: join(root, 'work'), kind: 'multi', mode: 'qa', createdAt: 1, blank: false });
  it('reaches a group\'s new session', async () => {
    fake.project = group();
    expect((await started(o => o.onMessage(message()))).profile?.env).toMatchObject(onPath);
  });
  it('reaches a resumed session', async () => {
    fake.project = group();
    fake.record = { threadId: 'omt_old', chatId: 'chat', sessionId: 'thread', backend: 'codex-appserver', cwd: join(root, 'work'), summary: '' };
    const options = await started(o => o.onMessage(message('omt_old')));
    expect(options).toMatchObject({ sessionId: 'thread' });
    expect(options.profile?.env).toMatchObject(onPath);
  });
  it('reaches a comment\'s session', async () => {
    fake.project = undefined;
    const options = await started(o => o.onComment({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId: 'one', mentionedBot: true, operator: { openId: 'owner' }, timestamp: Date.now() }));
    expect(options.profile?.env).toMatchObject(onPath);
  });
  it('goes through to Codex\'s shell policy', async () => {
    fake.project = group();
    const sent = codexSessionParams(await started(o => o.onMessage(message())), 'codex-cli 0.163.0', null) as Record<string, any>;
    expect(sent.config.shell_environment_policy.set).toMatchObject(onPath);
    expect(sent.config.shell_environment_policy.set).not.toHaveProperty('PATH');
  });
  it('is left out where no launcher was written', async () => {
    fake.project = group();
    expect((await groupProfile())?.env).not.toHaveProperty('VONVON_CLI');
  });
  it('sits beside a session\'s token and scope', async () => {
    fake.project = group();
    const entries = createAgentEntries({ appId: 'app', isAdmin: () => true });
    const { o, startThread } = orchestrator(true, { sessionCli: CLI, entries, host: { issueSessionToken: async () => 'vs1.token' } });
    await o.onMessage(message());
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    await o.shutdown();
    expect(startThread.mock.calls[0]![0].profile?.env).toMatchObject({ ...onPath, VONVON_SESSION: 'vs1.token', VONVON_SCOPE: 'bot=app,group=chat' });
    expect(startThread.mock.calls[0]![0].profile?.env).not.toHaveProperty('VONVON_BOT');
  });
});

it('gives a comment\'s session none', async () => {
  fake.project = undefined;
  const { o, startThread } = orchestrator();
  await o.onComment({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId: 'one', mentionedBot: true, operator: { openId: 'owner' }, timestamp: Date.now() });
  await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
  await o.shutdown();
  expect(startThread.mock.calls[0]![0].profile).toMatchObject({ capabilityPackages: [], tools: { schedule: false } });
  expect(fake.ensure).not.toHaveBeenCalled();
});
