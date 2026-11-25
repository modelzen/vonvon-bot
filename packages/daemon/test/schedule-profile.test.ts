import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';

// T3 4.5: `profileOf` decides `tools.schedule`, the one switch for the schedule tools (and T4b's skill).
const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  backend: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  commentCwd: '',
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(),
  fetchThreadContext: async () => ({ messages: [], ok: true, complete: true }), fetchChatContext: async () => ({ messages: [], ok: true, complete: true }) }));
vi.mock('../src/bot/session-store', async (original) => ({ ...await original<object>(),
  getSession: async () => undefined, listSessions: async () => [], patchSession: async () => undefined, upsertSession: async () => undefined }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} } }));
vi.mock('../src/bot/comments', async original => ({ ...await original<object>(),
  resolveComment: async (_channel: unknown, evt: { fileType: string }) => ({ target: { fileType: evt.fileType, fileToken: 'fixture-doc' }, ctx: { question: 'fixture question', isWhole: true } }),
  commentCwd: () => fake.commentCwd, loadCommentInstructions: async () => 'fixture instructions', syncCommentInstructions: async () => undefined,
  postCommentReply: async () => undefined }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = async () => 'card'; getCardId() { return 'card_entity'; } async updateElement() { return true; } streamCoalesced() {}
    async drain() {} setImageWorker() {} async settleImages() { return new Map(); } updateCard = async () => true; finalizeCard = async () => true;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { codexSessionParams } from '../src/agent/codex-appserver/backend';
import { resolveSessionProfile } from '../src/agent/session-profile';
import { createOrchestrator } from '../src/bot/handle-message';
import { executionSessionProfile, resolveExecution } from '../src/config/execution';
import type { AppConfig } from '../src/config/schema';

let root: string;
let seq = 0;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'schedule-profile-')));
  fake.commentCwd = join(root, 'comment');
  for (const dir of ['work', 'extra', 'comment']) await mkdir(join(root, dir));
  vi.clearAllMocks();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function orchestrator() {
  const startThread = vi.fn(async (_opts: { profile?: SessionProfile }) => ({ sessionId: 'fresh', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
    runStreamed: () => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'turn_started', turnId: 'turn' }; yield { type: 'done', turnId: 'turn' }; })() }) }));
  fake.backend = { id: 'codex-appserver', displayName: 'codex', listModels: async () => [], startThread, resumeThread: startThread, listThreads: async () => [] };
  const ok = async () => ({ code: 0, data: { message_id: `om_${++seq}`, items: [] } });
  const channel = { send: async () => ({}), rawClient: {
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'card' } }) } } },
    im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'omt_new' }] } }), list: ok, reply: ok, create: ok },
      chat: { get: async () => { throw new Error('no scope'); } }, messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) } } } } };
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] } } };
  return { o: createOrchestrator(channel as never, cfg, root), startThread };
}
const message = (): NormalizedMessage => ({ messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', content: '每天 9 点发日报', senderId: 'owner',
  senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false });

describe('profileOf', () => {
  it.each([['qa', {}], ['write', { feishuEdit: true }], ['full', { feishuEdit: true }]] as const)('gives a bound group\'s session the schedule tools in the %s tier, and the edit tool above read-only', async (mode, edit) => {
    fake.project = { name: 'g', chatId: 'chat', cwd: join(root, 'work'), kind: 'multi', mode, createdAt: 1, blank: false };
    const { o, startThread } = orchestrator();
    await o.onMessage(message());
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    // No `feishuApi`: the generic tool is a private chat's (dm-agent 7.6), asserted in dm-turn.test.ts.
    expect(startThread.mock.calls[0]![0].profile?.tools).toEqual({ schedule: true, feishu: true, askUser: true, ...edit });
    await o.shutdown();
  });
  it('gives a comment\'s session no schedule tools, the document column, and the edit tool on a docx', async () => {
    fake.project = undefined;
    const { o, startThread } = orchestrator();
    await o.onComment({ fileType: 'docx', fileToken: 'fixture-doc', commentId: 'comment', replyId: 'one', mentionedBot: true, operator: { openId: 'owner' }, timestamp: Date.now() });
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    expect(startThread.mock.calls[0]![0].profile?.tools).toEqual({ schedule: false, feishu: true, feishuEdit: true, documentsOnly: true });
    await o.shutdown();
  });
  it('gives a comment on a spreadsheet the same reads and no edit tool', async () => {
    fake.project = undefined;
    const { o, startThread } = orchestrator();
    await o.onComment({ fileType: 'sheet', fileToken: 'fixture-sheet', commentId: 'comment-sheet', replyId: 'one', mentionedBot: true, operator: { openId: 'owner' }, timestamp: Date.now() });
    await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
    expect(startThread.mock.calls[0]![0].profile?.tools).toEqual({ schedule: false, feishu: true, documentsOnly: true });
    await o.shutdown();
  });
});

describe('the profile on its way to a backend', () => {
  const base: SessionProfile = { instructions: 'x', env: {}, nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [], mcpServers: [] };
  it('keeps tools when executionSessionProfile adds a root, and resolves a missing one to off', async () => {
    const cwd = join(root, 'work'), extra = join(root, 'extra');
    const execution = resolveExecution({ group: { cwd, mode: 'qa', directories: { workspaces: { primary: cwd, additional: [extra] } } } });
    const built = await executionSessionProfile({ execution, cwd, backend: 'claude-agent', scope: 'group', profile: { ...base, tools: { schedule: true } }, dataDir: join(root, 'data') });
    expect(built).toMatchObject({ additionalRoots: [{ path: extra, access: 'read' }], tools: { schedule: true } });
    expect(resolveSessionProfile(built, { additionalRoots: true }).tools).toEqual({ schedule: true, feishu: false });
    expect(resolveSessionProfile(base).tools).toEqual({ schedule: false, feishu: false });
    expect(resolveSessionProfile().tools).toEqual({ schedule: false, feishu: false });
  });
  it('keeps dynamicTools out of the params Codex start and resume share (T3b adds them on thread/start only)', () => {
    for (const schedule of [true, false]) {
      expect(JSON.stringify(codexSessionParams({ cwd: '/work', mode: 'full', profile: { ...base, tools: { schedule } } }))).not.toMatch(/dynamicTools|schedule_/);
    }
  });
});
