import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScheduleRequest } from '@vonvon/protocol';
import type { AppConfig } from '../src/config/schema';
import { loadConfig, saveConfig } from '../src/config/store';
import type { AgentEvent, AgentInput, StartThreadOptions } from '../src/agent/types';
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import type { ScheduleActor } from '../src/admin/schedule-commands';
import { paths } from '../src/config/paths';
import { addDmProject, addProject, dmChatId, rememberDmChat } from '../src/project/registry';
import { createOrchestrator } from '../src/bot/handle-message';
import type { createScheduler } from '../src/bot/schedule/scheduler';
import type { ScheduledJob, StoredTask } from '../src/bot/schedule/types';
import { seedBots } from './helpers/bot-fixture';

// dm-agent 8, 6.3: a private chat's task through the real orchestrator, registry, entries, scheduler deps and store on a
// temp dir; backend, Feishu and cards are faked. main 必败, every one: a private chat's task had no sender and no way to run.

type Deps = Parameters<typeof createScheduler>[0];
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = realpathSync(mkdtempSync(join(tmpdir(), 'dm-schedule-')));
  const inside = <T extends object>(known: T) => new Proxy(known, { get: (target, key) => key in target ? target[key as keyof T] : join(appDir, String(key)) });
  return { paths: inside({ appDir, configFile: join(appDir, 'config.json'), sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), projectsRootDir: join(appDir, 'projects'), commentInstructionsFile: join(appDir, 'instructions.md') }),
    botPaths: () => inside({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), schedulesFile: join(appDir, 'schedules.json') }) };
});
const fake = vi.hoisted(() => ({ backend: undefined as any, deps: undefined as Parameters<typeof createScheduler>[0] | undefined, n: 0 }));
vi.mock('../src/bot/schedule/scheduler', async original => {
  const real = await original<typeof import('../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (deps: Deps) => { fake.deps = deps; return real.createScheduler(deps); } };
});
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/card/managed', () => ({
  sendManagedCard: vi.fn(async () => ({ messageId: `om_card_${++fake.n}` })), updateManagedCard: vi.fn(async () => true),
}));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} async register() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { return 'card'; }
    getCardId() { return 'card'; }
    async drain() {}
    async settleImages() { return new Map(); }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
    constructor() { return new Proxy(this, { get: (target, key) => key in target ? target[key as keyof typeof target] : async () => true }); }
  },
}));

const BE = 'codex-appserver', APP = 'cli_fixture';
const bot = { appId: APP, tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
const A = 'oc_p2p_a', B = 'oc_p2p_b', G = 'oc_group';
const OWNER = 'ou_owner', ADMIN = 'ou_admin';

function thread(sessionId = 'native-1') {
  const ends: (() => void)[] = [];
  const consumed: AgentInput[] = [];
  const t = {
    sessionId, isAlive: () => true, close: vi.fn(async () => { for (const end of ends) end(); }), abort: vi.fn(async () => { for (const end of ends) end(); }),
    steer: vi.fn(async () => undefined), injectContext: vi.fn(async () => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const finished = new Promise<void>(resolve => { ends.push(resolve); });
      const id = `turn-${ends.length}`;
      return { turnId: () => id, events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn_started', turnId: id };
        await finished;
        yield { type: 'done', turnId: id };
      })() };
    },
  };
  return { t, ends, consumed };
}
const send = vi.fn(async (..._args: unknown[]) => ({ messageId: `om_sent_${++fake.n}` }));
const channel = { send, rawClient: { im: { v1: {
  message: { get: async () => ({ data: { items: [{}] } }) },
  messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
} } } };
let cfg: AppConfig;
let opened: ReturnType<typeof createOrchestrator>[] = [];
async function app(adminRemoved?: (openId: string) => Promise<void>) {
  await saveConfig(cfg);
  const run = thread();
  fake.backend = { id: BE, displayName: 'Codex (app-server)', capabilities: { steer: true }, listModels: async () => [],
    startThread: vi.fn(async (_options: StartThreadOptions) => run.t), resumeThread: vi.fn(async (_options: StartThreadOptions) => run.t),
    listThreads: vi.fn(async () => []), readHistory: vi.fn(async () => ({ name: 'historic', preview: '', turns: [], totalTurns: 0 })) };
  const entries: AgentEntries = createAgentEntries({ appId: APP, isAdmin: id => (cfg.preferences?.access?.admins ?? []).includes(id), tools: [] });
  const issue = vi.spyOn(entries, 'issue'), turn = vi.spyOn(entries, 'openTurn');
  const o = createOrchestrator(channel as never, cfg, paths.appDir, undefined, { entries, bot, droppedFile: join(paths.appDir, 'dropped.json'),
    ...(adminRemoved ? { authoring: { adminRemoved, onAction: async () => {}, onMessage: async () => false } } : {}) });
  opened.push(o); await o.initialize?.();
  const [dmDir, groupDir] = [join(paths.appDir, 'projects', 'dm'), join(paths.appDir, 'projects', 'group')];
  for (const dir of [dmDir, groupDir]) await mkdir(dir, { recursive: true });
  await addDmProject({ name: '私聊', chatId: dmChatId(APP), cwd: dmDir, blank: true, createdAt: 1, kind: 'single', mode: 'full', dm: { people: {} } });
  await rememberDmChat(A, OWNER, '主人');
  await rememberDmChat(B, ADMIN, '管理员');
  await addProject({ name: '研发群', chatId: G, cwd: groupDir, blank: false, createdAt: 1, kind: 'single', mode: 'write' });
  return { o, run, entries, issue, turn, as: (actor: ScheduleActor, request: ScheduleRequest) => o.scheduleAs(actor, request) };
}
const dm = (openId: string, chatId: string): ScheduleActor => ({ kind: 'dm', via: 'chat', openId, name: '张三', chatId });
const create = (chatId: string, more: Partial<Extract<ScheduleRequest, { action: 'create' }>> = {}): ScheduleRequest =>
  ({ action: 'create', chatId, name: '日报', instruction: '汇总一下', spec: { kind: 'daily', time: '09:00' }, ...more });
const stored = (id: string) => fake.deps!.store.get(id)!;
async function made(reply: ReturnType<ReturnType<typeof createOrchestrator>['scheduleAs']>): Promise<StoredTask> {
  const answer = await reply;
  if (answer.kind !== 'task') throw new Error(JSON.stringify(answer));
  return stored(answer.task.id);
}
const job = (task: StoredTask): ScheduledJob => ({ task, runId: 'run-1', slot: 1, trigger: 'schedule', nth: 1, late: false });
const until = (check: () => unknown) => vi.waitFor(check, { interval: 5, timeout: 4000 });
const remove = async (o: ReturnType<typeof createOrchestrator>, openId: string, membership: 'absent' | 'present' = 'absent') => {
  const view = await o.settings.read({ kind: 'agent', botId: APP }) as { administrators: { revision: string } };
  return o.settings.act({ kind: 'adminMember', botId: APP, openId, membership, revision: view.administrators.revision });
};

beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  for (const file of [paths.projectsFile, paths.sessionsFile, join(paths.appDir, 'schedules.json')]) await rm(file, { force: true });
  cfg = { accounts: { app: { id: APP, secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: OWNER, admins: [OWNER, ADMIN] } } };
  send.mockClear();
});
afterEach(async () => { for (const o of opened) await o.shutdown(); opened = []; });
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

describe('a private chat\'s task running', () => {
  it('runs in the private chat\'s main session, as a private chat, its creator the turn\'s requester, with a person\'s rights', async () => {
    const { run, entries, issue, turn, as } = await app();
    const task = await made(as(dm(OWNER, A), create(A)));
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(issue).toHaveBeenCalledWith({ kind: 'p2p', chatId: A });
    const options = fake.backend.startThread.mock.calls[0][0] as StartThreadOptions;
    expect(options.mode).toBe('full');
    expect(options.profile?.tools).toMatchObject({ schedule: true, feishu: true });
    expect(turn.mock.calls[0]?.[1]).toMatchObject({ requesterOpenId: OWNER, requesterName: '张三', scheduled: { taskId: task.id, runId: 'run-1' } });
    expect(run.consumed[0]!.text).toContain('定时任务「日报」');
    expect(run.consumed[0]!.text).toContain('汇总一下');
    // 6.3: nobody is there, and it may read and change settings, make a task and act on any Bot's, as the person may
    const { sessionId } = issue.mock.results[0]!.value as { sessionId: string };
    expect(await entries.authorizeSessionCall(sessionId, { kind: 'settingsWrite' })).toMatchObject({ ok: true, openId: OWNER });
    expect(await entries.authorizeSessionCall(sessionId, { kind: 'adminRead' })).toMatchObject({ ok: true });
    expect(await entries.authorizeSessionCall(sessionId, { kind: 'schedule', action: 'create' })).toMatchObject({ ok: true, actor: { kind: 'dm', openId: OWNER, chatId: A } });
    expect(send).not.toHaveBeenCalled(); // no topic's root
    run.ends[0]!();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });

  it('opens no topic, whatever the task says (8)', async () => {
    const { run, as } = await app();
    const task = await made(as(dm(OWNER, A), create(A, { placement: { kind: 'newTopic' } })));
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(send).not.toHaveBeenCalled();
    run.ends[0]!();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });

  // Codex 审查任务 352 必败: the turn's open_id was its creator's and its union_id the chat's person's, so another Bot's group invited the wrong one
  it('carries the union_id of who it runs as, not of the chat\'s person', async () => {
    const { run, turn, as } = await app();
    await rememberDmChat(A, OWNER, '主人', 'on_owner');
    await rememberDmChat(B, ADMIN, '管理员', 'on_admin');
    const task = await made(as(dm(OWNER, A), create(B)));
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(turn.mock.calls[0]?.[1]).toMatchObject({ requesterOpenId: OWNER, requesterUnionId: 'on_owner' });
    run.ends[0]!();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });

  it('runs as the chat\'s person when this Bot has no open_id for who made it: the desktop, another Bot\'s private chat', async () => {
    const { run, turn, as } = await app();
    await rememberDmChat(B, ADMIN, '管理员', 'on_admin');
    const task = await made(as({ kind: 'dm', via: 'cli', name: '张三', chatId: 'oc_p2p_of_another_bot' }, create(B)));
    expect(task.createdBy).toEqual({ via: 'cli', name: '张三' });
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(turn.mock.calls[0]?.[1]).toMatchObject({ requesterOpenId: ADMIN, requesterUnionId: 'on_admin' });
    run.ends[0]!();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });

  it('is skipped, nothing started, when the removal landed after the gate let it through', async () => {
    const { o, as } = await app();
    const task = await made(as(dm(ADMIN, B), create(B)));
    await remove(o, ADMIN);
    await expect(fake.deps!.run(job(task))).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });

  it('leaves a group\'s run as it was: no sender, a group\'s place and tier', async () => {
    const { run, issue, turn, as } = await app();
    const task = await made(as(dm(OWNER, A), create(G)));
    expect(task.createdBy).toMatchObject({ via: 'chat', openId: OWNER, role: 'admin' });
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(issue).toHaveBeenCalledWith({ kind: 'group', chatId: G });
    expect(turn.mock.calls[0]?.[1]).toMatchObject({ requesterOpenId: '', scheduled: { taskId: task.id } });
    expect((fake.backend.startThread.mock.calls[0][0] as StartThreadOptions).mode).toBe('write');
    run.ends[0]!();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });
});

describe('the gate', () => {
  it('lets a private chat\'s task through only while its creator and the chat\'s person are admins; a group\'s does not care', async () => {
    const { o, as } = await app();
    const own = await made(as(dm(OWNER, A), create(A)));
    const theirs = await made(as(dm(ADMIN, A), create(A, { name: '另一个管理员建的' })));
    const second = await made(as(dm(ADMIN, B), create(B)));
    const group = await made(as(dm(ADMIN, A), create(G)));
    const gates = () => [own, theirs, second, group].map(task => fake.deps!.gate(task.chatId, task));
    expect(gates()).toEqual(['ok', 'ok', 'ok', 'ok']);
    await remove(o, ADMIN);
    expect(gates()).toEqual(['ok', 'admin-removed', 'admin-removed', 'ok']);
  });
});

describe('an administrator taken off the list', () => {
  it('has their private-chat tasks paused, the group\'s left, with the reason shown', async () => {
    const { o, as } = await app();
    const inTheirChat = await made(as(dm(ADMIN, B), create(B)));
    const inAnother = await made(as(dm(ADMIN, A), create(A, { name: '建在别人的私聊' })));
    const someoneElse = await made(as(dm(OWNER, A), create(A, { name: '别人的' })));
    const group = await made(as(dm(ADMIN, B), create(G)));
    const manual = await made(as(dm(ADMIN, B), create(B, { name: '已经手动暂停的' })));
    await as(dm(ADMIN, B), { action: 'pause', chatId: B, taskId: manual.id });
    await remove(o, ADMIN);
    await until(() => expect(stored(inTheirChat.id)).toMatchObject({ state: 'paused', pausedReason: 'admin-removed' }));
    expect(stored(inAnother.id)).toMatchObject({ state: 'paused', pausedReason: 'admin-removed' });
    expect(stored(someoneElse.id)).toMatchObject({ state: 'active' });
    expect(stored(group.id)).toMatchObject({ state: 'active' });
    expect(stored(manual.id)).toMatchObject({ state: 'paused', pausedReason: 'manual' });
  });

  it('interrupts and revokes a running private turn and pauses its task even if the draft journal fails', async () => {
    const adminRemoved = vi.fn(async () => { throw new Error('journal unavailable'); });
    const { o, run, entries, issue, as } = await app(adminRemoved);
    const task = await made(as(dm(ADMIN, B), create(B)));
    const result = fake.deps!.run(job(task));
    await until(() => expect(run.consumed).toHaveLength(1));
    const { sessionId } = issue.mock.results[0]!.value as { sessionId: string };
    await expect(entries.authorizeSessionCall(sessionId, { kind: 'settingsWrite' })).resolves.toMatchObject({ ok: true });

    await expect(remove(o, ADMIN)).resolves.toMatchObject({ kind: 'saved' });
    expect((await loadConfig()).preferences?.access?.admins).toEqual([OWNER]);
    expect(adminRemoved).toHaveBeenCalledExactlyOnceWith(ADMIN);
    await until(() => expect(stored(task.id)).toMatchObject({ state: 'paused', pausedReason: 'admin-removed' }));
    expect(run.t.abort).toHaveBeenCalledWith('turn-1');
    await expect(entries.authorizeSessionCall(sessionId, { kind: 'settingsWrite' })).resolves.toMatchObject({ ok: false, reason: 'turn-ended' });
    await expect(result).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('stays paused when put back on the list, until a person resumes it', async () => {
    const { o, as } = await app();
    const task = await made(as(dm(ADMIN, B), create(B)));
    await remove(o, ADMIN);
    await until(() => expect(stored(task.id).state).toBe('paused'));
    await remove(o, ADMIN, 'present');
    expect(stored(task.id)).toMatchObject({ state: 'paused', pausedReason: 'admin-removed' });
    expect(await as(dm(ADMIN, B), { action: 'resume', chatId: B, taskId: task.id })).toMatchObject({ kind: 'task', task: { state: 'active' } });
    expect(stored(task.id)).not.toHaveProperty('pausedReason');
  });
});

describe('what a task shows', () => {
  it('lists private chats\' tasks on the Bot with the person, and takes the row\'s own id from a private chat only (D4)', async () => {
    const { as } = await app();
    await made(as(dm(OWNER, A), create(A)));
    await made(as(dm(OWNER, A), create(G)));
    const listed = await as({ kind: 'local', via: 'desktop' }, { action: 'listBot' });
    expect(listed).toMatchObject({ kind: 'tasks', tasks: [{ chatId: A, dm: { name: '主人' } }, { chatId: G }] });
    expect(listed.kind === 'tasks' && listed.tasks[1]).not.toHaveProperty('dm');
    expect(await as(dm(OWNER, A), create(dmChatId(APP)))).toMatchObject({ kind: 'task', task: { chatId: A } });
    expect(await as({ kind: 'local', via: 'cli' }, create(dmChatId(APP)))).toMatchObject({ kind: 'refused', reason: 'not-found' });
    expect(await as(dm(OWNER, A), create('oc_nowhere'))).toMatchObject({ kind: 'refused', reason: 'not-found' });
  });
});

// A private chat with no message of its row is not there to run in: nothing else keeps a stale id working.
it('fails a task of a private chat the Bot no longer knows as unbound', async () => {
  await app();
  expect(fake.deps!.gate('oc_p2p_gone', { createdBy: { via: 'cli', openId: OWNER } })).toBe('unbound');
});
