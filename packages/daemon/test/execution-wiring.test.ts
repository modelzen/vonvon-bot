import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { CodexWorkspaceLayoutError } from '../src/agent/codex-appserver/workspace-admission';
import type { AgentEvent, AgentInput, ModelInfo, TurnOptions } from '../src/agent/types';

// s36d2: the orchestrator's entries read one resolver (config/execution.ts). Two real backend ids,
// so a session on the wrong backend shows up.

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  project: undefined as Record<string, unknown> | undefined,
  /** Answers for the next project lookups, before falling back to `project`. */
  lookups: [] as (Record<string, unknown> | undefined)[],
  backends: new Map<string, any>(),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  cards: [] as string[],
  commentCwd: '',
  reactions: vi.fn(async (..._args: unknown[]) => ({ data: {} })),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/config/bots', async (original) => ({ ...await original<object>(), loadBots: async () => ({ version: 1, bots: [] }) }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: (id: string) => fake.backends.get(id) }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => (fake.lookups.length ? fake.lookups.shift() : fake.project),
  getProjectByName: async () => fake.project,
}));
vi.mock('../src/bot/comments', async original => ({
  ...await original<object>(),
  resolveComment: async () => ({ target: { fileType: 'docx', fileToken: 'fixture-doc' }, ctx: { question: 'fixture question', isWhole: true } }),
  commentCwd: () => fake.commentCwd,
  loadCommentInstructions: async () => 'fixture instructions',
  syncCommentInstructions: async () => undefined,
  postCommentReply: async () => undefined,
}));
vi.mock('../src/bot/context-weave', async (original) => ({
  ...await original<object>(),
  fetchThreadContext: async () => ({ messages: [], ok: true, complete: true }),
  fetchChatContext: async () => ({ messages: [], ok: true, complete: true }),
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
    create = async () => 'card';
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = async () => true;
    finalizeCard = async () => true;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig, AppPreferences } from '../src/config/schema';

const CODEX = 'codex-appserver';
const CLAUDE = 'claude-agent';
const model = (id: string, isDefault = false): ModelInfo => ({ id, displayName: id, description: '', supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault, hidden: false });

function thread(sessionId: string, opts: { hold?: boolean; steer?: boolean } = {}) {
  const ends: (() => void)[] = [];
  const options: (TurnOptions | undefined)[] = [];
  const t = {
    sessionId, isAlive: () => true,
    ...(opts.steer === false ? { supportsSteer: false } : {}),
    close: vi.fn(async () => { for (const end of ends) end(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string) => undefined),
    runStreamed(_input: AgentInput, turn?: TurnOptions) {
      options.push(turn);
      const held = opts.hold ? new Promise<void>((resolve) => ends.push(resolve)) : Promise.resolve();
      return {
        turnId: () => 'turn',
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: 'turn' };
          await held;
          yield { type: 'done', turnId: 'turn' };
        })(),
      };
    },
  };
  return { t, options, release: () => { for (const end of ends) end(); } };
}
function backend(id: string, models: ModelInfo[], capabilities?: object) {
  const be = {
    id, displayName: id, capabilities,
    listModels: vi.fn(async () => models),
    startThread: vi.fn(async (_opts: Record<string, unknown>) => thread(`${id}-new`).t),
    resumeThread: vi.fn(async (o: { sessionId: string }) => thread(o.sessionId).t),
    listThreads: vi.fn(async (_cwd: string) => []),
  };
  fake.backends.set(id, be);
  return be;
}

let orchestrator: ReturnType<typeof createOrchestrator> | undefined;
let seq = 0;
let baseRoot: string;
let baseWork: string;
let baseMoved: string;
function message(text: string, threadId?: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', ...(threadId ? { threadId } : {}),
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(preferences: AppPreferences = {}, createdTopicId?: string) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' }, ...preferences } };
  const ok = async () => ({ code: 0, data: { message_id: `om_${++seq}`, items: [] } });
  const channel = { send: fake.send, rawClient: {
    cardkit: { v1: { card: { create: async ({ data }: { data: { data: string } }) => { fake.cards.push(data.data); return { data: { card_id: 'card' } }; } } } },
    im: { v1: { message: { get: createdTopicId ? async () => ({ data: { items: [{ thread_id: createdTopicId }] } }) : ok,
      list: ok, reply: ok, create: ok }, chat: { get: async () => { throw new Error('no scope'); } }, messageReaction: { create: fake.reactions, delete: async () => ({}) } } },
  } };
  orchestrator = createOrchestrator(channel as never, cfg, '/fallback');
  return orchestrator;
}
const record = (key: string, extra: object = {}) => ({ threadId: key, chatId: 'chat', sessionId: `old-${key}`, backend: CODEX, cwd: baseWork, summary: '', model: 'gpt-old', effort: 'high', lastSeenAt: 1, ...extra });
const finished = () => vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));

let codex: ReturnType<typeof backend>;
let claude: ReturnType<typeof backend>;
beforeEach(async () => {
  baseRoot = await realpath(await mkdtemp(join(tmpdir(), 'execution-base-')));
  baseWork = join(baseRoot, 'work'); baseMoved = join(baseRoot, 'moved');
  await mkdir(baseWork); await mkdir(baseMoved);
  vi.clearAllMocks();
  fake.records.clear();
  fake.lookups = [];
  fake.cards = [];
  fake.project = { name: 'g', chatId: 'chat', cwd: baseWork, kind: 'multi', createdAt: 1, blank: false };
  codex = backend(CODEX, [model('gpt-default', true), model('gpt-old'), model('gpt-bot')]);
  claude = backend(CLAUDE, [model('sonnet', true), model('opus')], { goal: false });
});
afterEach(async () => {
  await orchestrator?.shutdown();
  orchestrator = undefined;
  await rm(baseRoot, { recursive: true });
});

describe('an existing session keeps its backend', () => {
  it.each(['fresh', 'resume', 'recreate'] as const)('passes native Claude settings through %s', async path => {
    const settings = { permissionMode: 'plan', network: 'domains', domains: ['example.com'] };
    fake.project = { ...fake.project, backend: CLAUDE, mode: 'qa', custom: { backend: CLAUDE, settings } };
    if (path !== 'fresh') fake.records.set('omt_native', record('omt_native', { backend: CLAUDE }));
    if (path === 'recreate') claude.resumeThread.mockRejectedValueOnce(new Error('synthetic resume failure'));
    // A bot-opened topic needs Feishu's resulting thread id before its final card can settle.
    await setup({}, path === 'fresh' ? 'omt_native' : undefined).onMessage(message('native turn', path === 'fresh' ? undefined : 'omt_native'));
    await vi.waitFor(() => expect(path === 'resume' ? claude.resumeThread : claude.startThread).toHaveBeenCalled());
    const expected = expect.objectContaining({ mode: 'write', network: true, native: { ...settings, sandbox: true } });
    if (path !== 'fresh') expect(claude.resumeThread).toHaveBeenCalledWith(expected);
    if (path !== 'resume') expect(claude.startThread).toHaveBeenCalledWith(expected);
    await finished();
    expect(fake.records.get('omt_native')).toMatchObject({ backend: CLAUDE });
  });
  it("rebuilds a session whose cwd changed on the record's backend and model, in the new cwd", async () => {
    fake.project = { ...fake.project, cwd: baseMoved, backend: CLAUDE };
    fake.records.set('omt_t', record('omt_t'));
    await setup().onMessage(message('go on', 'omt_t'));
    await finished();
    expect(claude.startThread).not.toHaveBeenCalled();
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: baseMoved, model: 'gpt-old', effort: 'high' }));
    expect(fake.records.get('omt_t')).toMatchObject({ backend: CODEX, cwd: baseMoved, model: 'gpt-old' });
  });

  it("keeps an old group on Codex, full access with network under a Claude, read-write, networked bot default, for an old topic and a new one", async () => {
    fake.records.set('omt_old', record('omt_old'));
    const o = setup({ defaults: { backend: CLAUDE, model: { kind: 'custom', id: 'sonnet-x' }, permission: 'write', network: true } });
    await o.onMessage(message('old topic', 'omt_old'));
    await finished();
    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'old-omt_old', mode: 'full', network: true }));
    await o.onMessage(message('a new topic'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(claude.startThread).not.toHaveBeenCalled();
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-default', mode: 'full', network: true }));
  });
});

describe('the model a session starts from', () => {
  it.each([
    ['the bot default for Claude', {}, { defaults: { backend: CLAUDE, model: { kind: 'custom' as const, id: 'sonnet-x' } } }],
    ["the group's hand-typed default for Claude", { defaultModel: 'opus-x', defaultModelCustom: true }, {}],
  ])("does not give an old Codex main session %s", async (_name, group, prefs) => {
    fake.project = { ...fake.project, kind: 'single', backend: CLAUDE, ...group };
    fake.records.set('chat', record('chat', { model: undefined, effort: undefined }));
    const run = thread('old-chat');
    codex.resumeThread.mockResolvedValue(run.t);
    await setup(prefs).onMessage(message('hello'));
    await finished();
    expect(run.options[0]).toMatchObject({ model: 'gpt-default' });
    expect(fake.records.get('chat')).toMatchObject({ model: 'gpt-default', modelCustom: false });
  });

  it("starts a new Claude session on the bot's default model, hand-typed", async () => {
    fake.project = { ...fake.project, backend: CLAUDE };
    await setup({ defaults: { backend: CLAUDE, model: { kind: 'custom', id: 'sonnet-x', effort: 'high' } } }).onMessage(message('a new topic'));
    await vi.waitFor(() => expect(claude.startThread).toHaveBeenCalled());
    expect(claude.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'sonnet-x', effort: 'high' }));
  });

  it.each([
    ['listed', { defaultModel: 'gpt-old' }, 'gpt-old'],
    ['hand-typed', { defaultModel: 'kimi-x', defaultModelCustom: true }, 'kimi-x'],
  ])("starts a new topic of a group whose backend left the catalog on Codex with the group's %s model", async (_name, group, expected) => {
    fake.project = { ...fake.project, backend: 'claude-sdk', ...group };
    await setup().onMessage(message('a new topic'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: expected }));
  });

  it("shows the bot's default model on the /model card of a topic with no session yet", async () => {
    await setup({ defaults: { model: { kind: 'catalog', id: 'gpt-bot', effort: 'low' } } }).onMessage(message('/model', 'omt_fresh'));
    await vi.waitFor(() => expect(fake.cards.length).toBe(1));
    expect(fake.cards[0]).toContain('gpt-bot');
  });
});

describe('/clear in a single-session group', () => {
  it("starts the new session in the group's current directory, on the record's backend and model", async () => {
    fake.project = { ...fake.project, kind: 'single', cwd: baseMoved, backend: CLAUDE };
    fake.records.set('chat', record('chat'));
    await setup().onMessage(message('/clear'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: baseMoved, model: 'gpt-old', effort: 'high' }));
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ cwd: baseMoved, backend: CODEX }));
  });

  it('starts a session that had no model on the default', async () => {
    fake.project = { ...fake.project, kind: 'single' };
    fake.records.set('chat', record('chat', { model: undefined, effort: undefined }));
    await setup({ defaults: { model: { kind: 'catalog', id: 'gpt-bot', effort: 'low' } } }).onMessage(message('/clear'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-bot', effort: 'low' }));
    await vi.waitFor(() => expect(fake.records.get('chat')).toMatchObject({ model: 'gpt-bot', effort: 'low', modelCustom: false }));
  });
});

describe("/goal looks at the session's backend", () => {
  it.each([
    ['takes it on an old Codex session in a Claude group', CLAUDE, CODEX, false],
    ['refuses it on a Claude session in a Codex group', CODEX, CLAUDE, true],
  ])('%s', async (_name, groupBackend, sessionBackend, denied) => {
    fake.project = { ...fake.project, kind: 'single', backend: groupBackend };
    fake.records.set('chat', record('chat', { backend: sessionBackend }));
    await setup().onMessage(message('/goal ship it'));
    const deny = () => fake.send.mock.calls.some((call) => JSON.stringify(call).includes('不支持 `/goal`'));
    if (denied) await vi.waitFor(() => expect(deny()).toBe(true));
    else {
      await vi.waitFor(() => expect(fake.reactions).toHaveBeenCalledWith(expect.objectContaining({ data: { reaction_type: { emoji_type: 'OKR' } } })));
      expect(deny()).toBe(false);
    }
  });
});

describe('运行中来了消息', () => {
  it('steers into an old Codex topic of a Claude group', async () => {
    fake.project = { ...fake.project, backend: CLAUDE };
    fake.records.set('omt_t', record('omt_t'));
    const run = thread('old-omt_t', { hold: true });
    codex.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first', 'omt_t'));
    await vi.waitFor(() => expect(run.options).toHaveLength(1));
    await o.onMessage(message('second', 'omt_t'));
    await vi.waitFor(() => expect(run.t.steer).toHaveBeenCalledOnce());
    run.release();
    await finished();
  });
});

describe('no group', () => {
  it("lists history in fallbackCwd, not the bot's primary workspace, when the group went away", async () => {
    fake.lookups = [fake.project];
    fake.project = undefined;
    await setup({ directories: { workspaces: { primary: '/bot-home', additional: [] } } }).onMessage(message('/resume'));
    await vi.waitFor(() => expect(codex.listThreads).toHaveBeenCalled());
    expect(codex.listThreads).toHaveBeenCalledWith('/fallback');
  });
});

describe('s39a production profile delivery', () => {
  let root: string;
  let cwd: string;
  let extra: string;
  let repository: string;
  let botExtra: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'execution-wiring-')));
    cwd = join(root, 'work'); extra = join(root, 'extra'); repository = join(root, 'repo'); botExtra = join(root, 'bot-extra');
    for (const path of [cwd, extra, repository, botExtra]) await mkdir(path);
    fake.commentCwd = cwd;
    execFileSync('git', ['init', '--quiet', repository]);
    fake.project = { ...fake.project, cwd, directories: { workspaces: { primary: cwd, additional: [extra] } } };
  });
  afterEach(async () => { await rm(root, { recursive: true }); });
  const roots = (extra: string, repo: string) => [{ path: extra, access: 'write' }, { path: repo, access: 'write' }];
  it('delivers only group workspaces and inherited repositories to a new topic', async () => {
    await setup({ directories: { workspaces: { primary: botExtra, additional: [botExtra] }, repositories: [repository] } }).onMessage(message('new topic'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
  });
  it('uses the stored Codex backend for resume and fallback recreation in a Claude group', async () => {
    fake.project = { ...fake.project, backend: CLAUDE };
    fake.records.set('omt_t', record('omt_t', { cwd }));
    codex.resumeThread.mockRejectedValueOnce(new Error('missing session'));
    await setup({ directories: { repositories: [repository] } }).onMessage(message('continue', 'omt_t'));
    await finished();
    for (const call of [codex.resumeThread, codex.startThread]) {
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
    }
    expect(claude.startThread).not.toHaveBeenCalled();
  });
  it('surfaces an unsafe restored layout without replacing the stored conversation', async () => {
    fake.records.set('omt_t', record('omt_t', { cwd }));
    codex.resumeThread.mockRejectedValueOnce(new CodexWorkspaceLayoutError());
    await setup({ directories: { repositories: [repository] } }).onMessage(message('continue', 'omt_t'));
    await vi.waitFor(() => expect(fake.send.mock.calls.some(call => JSON.stringify(call).includes('硬链接'))).toBe(true));
    expect(codex.startThread).not.toHaveBeenCalled();
    expect(fake.records.get('omt_t')).toMatchObject({ sessionId: 'old-omt_t', cwd });
  });
  it('delivers the current group profile and configured roots to Claude', async () => {
    fake.project = { ...fake.project, backend: CLAUDE };
    await setup({ directories: { repositories: [repository] } }).onMessage(message('new topic'));
    await vi.waitFor(() => expect(claude.startThread).toHaveBeenCalled());
    expect(claude.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd }));
    const profile = claude.startThread.mock.calls[0]?.[0].profile as { instructions: string };
    expect(profile).toMatchObject({
      additionalRoots: roots(extra, repository),
      capabilityPackages: [], env: {}, mcpServers: [], nativeSettings: { automaticMemory: false },
    });
    // The opening comes from context assembly (memory design §4.1); the multi-root note follows it once.
    expect(profile.instructions).toContain('群「g」里工作。');
    expect(profile.instructions.endsWith('用某个仓库或附加工作区前，先阅读那里适用的 AGENTS.md 或 CLAUDE.md；附加根不保证原生加载其说明文件。')).toBe(true);
  });
  it('delivers current group roots through clear while retaining the stored backend', async () => {
    fake.project = { ...fake.project, kind: 'single', backend: CLAUDE };
    fake.records.set('chat', record('chat', { cwd }));
    await setup({ directories: { repositories: [repository] } }).onMessage(message('/clear'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
  });
  it.each(['ordinary', 'goal'])('delivers roots on a fresh single-session %s run', async kind => {
    fake.project = { ...fake.project, kind: 'single' };
    await setup({ directories: { repositories: [repository] } }).onMessage(message(kind === 'goal' ? '/goal ship it' : 'hello'));
    await vi.waitFor(() => expect(codex.startThread).toHaveBeenCalled());
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
  });
  it('delivers roots through the management clear entry', async () => {
    fake.project = { ...fake.project, kind: 'single', backend: CLAUDE };
    fake.records.set('chat', record('chat', { cwd }));
    await setup({ directories: { repositories: [repository] } }).collaboration({ action: 'clear', projectName: 'g', chatId: 'chat', threadId: 'chat' });
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
  });
  it('delivers bot additional roots and repositories to comment start/resume while retaining comment cwd and full access', async () => {
    const preferences: AppPreferences = { defaults: { permission: 'qa' }, directories: { workspaces: { primary: botExtra, additional: [extra] }, repositories: [repository] } };
    const o = setup(preferences);
    const event = { fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId: 'one', mentionedBot: true, operator: { openId: 'owner' }, timestamp: Date.now() };
    await o.onComment(event);
    expect(codex.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
    // A new orchestrator forces native resume without changing the comment cwd.
    await o.shutdown();
    const resumed = setup({ ...preferences, comments: { model: 'gpt-old' } });
    await resumed.onComment({ ...event, replyId: 'two' });
    expect(codex.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ cwd, profile: expect.objectContaining({ additionalRoots: roots(extra, repository) }) }));
  });

});
