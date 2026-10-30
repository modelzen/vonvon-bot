import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent } from '../src/agent/types';
import type { SessionProfile } from '../src/agent/session-profile';

// T4b 4.1: `profileOf` writes the builtin package exactly where the schedule tools go; a failed write leaves it out.
const fake = vi.hoisted(() => ({
  project: undefined as Record<string, unknown> | undefined,
  backend: undefined as unknown,
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  ensure: vi.fn(),
  commentCwd: '',
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent/builtin-skills/package', () => ({ ensureBuiltinPackage: fake.ensure }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({ ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project }));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(),
  fetchThreadContext: async () => ({ messages: [], ok: true, complete: true }), fetchChatContext: async () => ({ messages: [], ok: true, complete: true }) }));
vi.mock('../src/bot/session-store', async (original) => ({ ...await original<object>(),
  getSession: async () => undefined, listSessions: async () => [], patchSession: async () => undefined, upsertSession: async () => undefined }));
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
import { builtinSkillsOfSet } from '../src/agent/builtin-skills/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

let root: string;
let seq = 0;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'profile-of-builtin-')));
  fake.commentCwd = join(root, 'comment');
  for (const dir of ['work', 'comment']) await mkdir(join(root, dir));
  vi.clearAllMocks();
  fake.ensure.mockResolvedValue({ path: '/builtin/group', changed: false });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function orchestrator(capabilityPackages = true) {
  const startThread = vi.fn(async (_opts: { profile?: SessionProfile }) => ({ sessionId: 'fresh', isAlive: () => true, close: async () => {}, abort: async () => {}, steer: async () => {},
    runStreamed: () => ({ turnId: () => 'turn', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'turn_started', turnId: 'turn' }; yield { type: 'done', turnId: 'turn' }; })() }) }));
  fake.backend = { id: 'codex-appserver', displayName: 'codex', profileCapabilities: { capabilityPackages }, listModels: async () => [], startThread, resumeThread: startThread, listThreads: async () => [] };
  const ok = async () => ({ code: 0, data: { message_id: `om_${++seq}`, items: [] } });
  const channel = { send: async () => ({}), rawClient: {
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'card' } }) } } },
    im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'omt_new' }] } }), list: ok, reply: ok, create: ok },
      chat: { get: async () => { throw new Error('no scope'); } }, messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) } } } } };
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } };
  return { o: createOrchestrator(channel as never, cfg, root), startThread };
}
const message = (): NormalizedMessage => ({ messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', content: '每天 9 点发日报', senderId: 'owner',
  senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false });
async function groupProfile(capabilityPackages = true): Promise<SessionProfile | undefined> {
  fake.project = { name: 'g', chatId: 'chat', cwd: join(root, 'work'), kind: 'multi', mode: 'qa', createdAt: 1, blank: false };
  const { o, startThread } = orchestrator(capabilityPackages);
  await o.onMessage(message());
  await vi.waitFor(() => expect(startThread).toHaveBeenCalled());
  await o.shutdown();
  return startThread.mock.calls[0]![0].profile;
}

it('hands a bound group\'s session the group package', async () => {
  expect((await groupProfile())?.capabilityPackages).toEqual([{ path: '/builtin/group', kind: 'builtin' }]);
  expect(fake.ensure).toHaveBeenCalledWith('app', 'group', builtinSkillsOfSet('group'));
});

it('starts the session without the package when writing it fails, and records why', async () => {
  fake.ensure.mockRejectedValue(new Error('disk full'));
  const profile = await groupProfile();
  expect(profile).toMatchObject({ capabilityPackages: [], tools: { schedule: true } });
  expect(fake.log.fail).toHaveBeenCalledWith('agent', expect.objectContaining({ message: 'disk full' }), { phase: 'builtin-package-failed', chatId: 'chat' });
  expect(fake.log.fail.mock.calls.filter(([, , fields]) => fields?.phase === 'builtin-package-failed')).toHaveLength(1);
});

it('writes nothing for a backend that cannot take packages', async () => {
  expect((await groupProfile(false))?.capabilityPackages).toEqual([]);
  expect(fake.ensure).not.toHaveBeenCalled();
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
