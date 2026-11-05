import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import type { createScheduler } from '../src/bot/schedule/scheduler';
import type { ScheduledJob } from '../src/bot/schedule/types';

type Deps = Parameters<typeof createScheduler>[0];
const fake = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  backend: { id: 'codex', capabilities: {}, listModels: async () => [], startThread: vi.fn() },
  deps: undefined as Deps | undefined,
  card: vi.fn(async (..._args: unknown[]) => 'om_card'),
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} register = async () => undefined; } }));
vi.mock('../src/bot/schedule/scheduler', async original => {
  const real = await original<typeof import('../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (deps: Deps) => { fake.deps = deps; return real.createScheduler(deps); } };
});
vi.mock('../src/bot/context-assembly', async original => ({
  ...await original<object>(),
  loadContextSources: async () => ({ place: { kind: 'comment' }, botName: 'fixture', soul: '', role: { identity: '', notes: '', headed: false }, supplement: '', failed: {} }),
  planTurnUpdate: async () => ({ context: { versions: {}, nonce: 'fixture' } }),
}));
vi.mock('../src/bot/context-weave', async original => ({ ...await original<object>(), fetchThreadContext: async () => ({ messages: [], ok: true, complete: true }) }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.card;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    async updateCard() { return true; }
    async finalizeCard() { return true; }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));

let root: string;
let registry: typeof import('../src/project/registry');
let o: ReturnType<typeof import('../src/bot/handle-message')['createOrchestrator']>;
let finish: () => void;
let session: unknown;
const holds: (() => void)[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-lock-')));
  for (const dir of ['home', 'vonvon', 'workspace']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  registry = await import('../src/project/registry');
  for (const [chatId, projectId] of [['oc_a', 'prj_0000000a'], ['oc_b', 'prj_0000000b']] as const) {
    await registry.addProject({ name: chatId, chatId, cwd: join(root, 'workspace'), blank: false, createdAt: 1, kind: 'single', mode: 'full', projectId });
  }
  // The run in group A lasts until the test ends it.
  const ended = new Promise<void>(resolve => { finish = resolve; });
  session = {
    sessionId: 'session-a', isAlive: () => true, close: async () => { finish(); }, abort: async () => {}, steer: async () => {},
    runStreamed: () => ({ turnId: () => 'turn-a', events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'turn_started', turnId: 'turn-a' };
      await ended;
      yield { type: 'done', turnId: 'turn-a' };
    })() }),
  };
  fake.backend.startThread.mockResolvedValue(session);
  const cfg: AppConfig = { accounts: { app: { id: 'cli_schedule_lock', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] }, completionReminder: { mode: 'manual' } } };
  const channel = { send: vi.fn(async () => ({ messageId: 'om_sent' })), rawClient: { im: { v1: {
    message: { get: async () => ({ data: { items: [] } }) }, messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
  } } } };
  o = (await import('../src/bot/handle-message')).createOrchestrator(channel as never, cfg, join(root, 'workspace'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const go of holds.splice(0)) go();
  finish();
  await o.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const message = (chatId: string): NormalizedMessage => ({ messageId: `om_${chatId}`, chatId, chatType: 'group', content: '在吗', senderId: 'ou_owner', senderName: 'Owner',
  mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false });
const edit = async (chatId: string) => o.collaboration({ action: 'editProject', projectName: chatId, chatId, enabled: true,
  expectedRevision: (await import('../src/admin/collaboration')).projectRevision((await registry.getProjectByChatId(chatId))!) });
/** A claimed run of a daily task in `chatId`, as the scheduler hands it over. */
const job = (chatId: string): ScheduledJob => ({
  task: { id: 'st_00000000000000b1', chatId, revision: 'r1', name: '日报', instruction: '写今天的日报', spec: { kind: 'daily', time: '09:00' },
    timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: 1, updatedAt: 1,
    cursor: 1, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [] },
  runId: 'run-1', slot: 1, trigger: 'schedule', nth: 1, late: false,
});
/** The next session start waits until the test ends. */
function holdStart(): void {
  fake.backend.startThread.mockReturnValueOnce(new Promise(resolve => { holds.push(() => resolve(session)); }));
}

it('a run in group A locks only group A, and holds its scheduled tasks for a minute', async () => {
  await o.onMessage(message('oc_a'));
  await vi.waitFor(() => expect(fake.card).toHaveBeenCalled());
  await expect(edit('oc_b')).resolves.toMatchObject({ ok: true });
  expect(fake.deps!.gate('oc_a')).toBe('ok');
  await expect(edit('oc_a')).rejects.toThrow('Agent 正在执行任务');
  expect([fake.deps!.gate('oc_a'), fake.deps!.gate('oc_b')]).toEqual(['held', 'ok']);
  const later = Date.now() + 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  expect(fake.deps!.gate('oc_a')).toBe('ok');
});

it('the library workspace check looks at the groups of that project only, and holds them', async () => {
  await o.onMessage(message('oc_a'));
  await vi.waitFor(() => expect(fake.card).toHaveBeenCalled());
  expect(await o.libraryExecute({ kind: 'libraryWorkspaceCheck', projectId: 'prj_0000000b' })).toEqual({ busy: false });
  expect(fake.deps!.gate('oc_b')).toBe('ok');
  expect(await o.libraryExecute({ kind: 'libraryWorkspaceCheck', projectId: 'prj_0000000a' })).toEqual({ busy: true });
  expect(fake.deps!.gate('oc_a')).toBe('held');
});

it('a scheduled run of group B, while its session starts, locks group B only', async () => {
  holdStart();
  void fake.deps!.run(job('oc_b'));
  await vi.waitFor(() => expect(fake.backend.startThread).toHaveBeenCalled());
  await expect(edit('oc_a')).resolves.toMatchObject({ ok: true });
  expect(fake.deps!.gate('oc_a')).toBe('ok');
  await expect(edit('oc_b')).rejects.toThrow('Agent 正在执行任务');
});

it('a scheduled run of group B in a new topic, once running, locks group B only', async () => {
  const run = job('oc_b');
  void fake.deps!.run({ ...run, task: { ...run.task, placement: { kind: 'newTopic' } } });
  await vi.waitFor(() => expect(fake.card).toHaveBeenCalled());
  await expect(edit('oc_a')).resolves.toMatchObject({ ok: true });
  expect(fake.deps!.gate('oc_a')).toBe('ok');
  await expect(edit('oc_b')).rejects.toThrow('Agent 正在执行任务');
});

it('a /goal in a new topic of group C, once running, locks group C only', async () => {
  await registry.addProject({ name: 'oc_c', chatId: 'oc_c', cwd: join(root, 'workspace'), blank: false, createdAt: 1, kind: 'multi', mode: 'full' });
  const goal = session as { runStreamed: () => unknown };
  Object.assign(goal, { runGoal: goal.runStreamed, clearGoal: async () => {} });
  await o.onMessage({ ...message('oc_c'), content: '/goal 写日报' });
  await vi.waitFor(() => expect(fake.card).toHaveBeenCalled());
  await expect(edit('oc_a')).resolves.toMatchObject({ ok: true });
  await expect(edit('oc_c')).rejects.toThrow('Agent 正在执行任务');
});

it('a person\'s turn in group A, while its session starts, locks group A only', async () => {
  holdStart();
  await o.onMessage(message('oc_a'));
  await vi.waitFor(() => expect(fake.backend.startThread).toHaveBeenCalled());
  await expect(edit('oc_b')).resolves.toMatchObject({ ok: true });
  await expect(edit('oc_a')).rejects.toThrow('Agent 正在执行任务');
});

it('a /new in group B, while its session starts, still locks every group', async () => {
  holdStart();
  await o.onMessage({ ...message('oc_b'), content: '/new' });
  await vi.waitFor(() => expect(fake.backend.startThread).toHaveBeenCalled());
  await expect(edit('oc_a')).rejects.toThrow('Agent 正在执行任务');
  expect(fake.deps!.gate('oc_a')).toBe('held');
});
