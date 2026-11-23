import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ScheduleRequest } from '@vonvon/protocol';
import type { AppConfig } from '../src/config/schema';
import type { StoredTask } from '../src/bot/schedule/types';

const fake = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  stores: [] as { file: string; load: MockInstance }[],
  starts: [] as MockInstance[],
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
// The real store and scheduler, watched: how often the file is read, and that nothing starts the tick.
vi.mock('../src/bot/schedule/store', async (original) => {
  const real = await original<typeof import('../src/bot/schedule/store')>();
  return { ...real, createScheduleStore: (...args: Parameters<typeof real.createScheduleStore>) => {
    const store = real.createScheduleStore(...args);
    fake.stores.push({ file: args[0], load: vi.spyOn(store, 'load') });
    return store;
  } };
});
vi.mock('../src/bot/schedule/scheduler', async (original) => {
  const real = await original<typeof import('../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (...args: Parameters<typeof real.createScheduler>) => {
    const scheduler = real.createScheduler(...args);
    fake.starts.push(vi.spyOn(scheduler, 'start'));
    return scheduler;
  } };
});

type Module = typeof import('../src/bot/handle-message');
const APP = 'cli_schedule_wiring';
const CHAT = 'oc_group_a';
let createOrchestrator: Module['createOrchestrator'];
let root: string;
let file: string;
const opened: ReturnType<Module['createOrchestrator']>[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  fake.stores.length = 0;
  fake.starts.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-wiring-')));
  for (const dir of ['home', 'vonvon', 'workspace']) mkdirSync(join(root, dir));
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('VONVON_HOME', join(root, 'vonvon'));
  ({ createOrchestrator } = await import('../src/bot/handle-message'));
  file = (await import('../src/config/paths')).botPaths(APP).schedulesFile;
  mkdirSync(dirname(file), { recursive: true });
});
afterEach(async () => {
  for (const o of opened.splice(0)) await o.shutdown();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const cfg: AppConfig = { accounts: { app: { id: APP, secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner'] } } };
  const channel = { send: vi.fn(async () => ({})), rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [] } }), reply: vi.fn(async () => ({ data: {} })) } } } } };
  const o = createOrchestrator(channel as never, cfg, join(root, 'workspace'));
  opened.push(o);
  return o;
}
const task = (id: string, name: string): StoredTask => ({
  id, chatId: CHAT, revision: `rev-${id}`, name, instruction: `做${name}`, spec: { kind: 'every', minutes: 30, anchor: 0 },
  timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: 0, updatedAt: 0,
  cursor: 0, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
});
const earlier = [task('st_00000000000000a1', '日报'), task('st_00000000000000a2', '周报')];
const seed = (): void => writeFileSync(file, JSON.stringify({ version: 1, tasks: earlier }));
const onDisk = (): string[] => (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks.map(t => t.id);
const list: ScheduleRequest = { action: 'list', chatId: CHAT };
const listed = async (reply: Promise<unknown>): Promise<string[]> => {
  const value = await reply;
  expect(value).toMatchObject({ kind: 'tasks', timeZone: expect.any(String), now: expect.any(Number) });
  return (value as { tasks: { id: string }[] }).tasks.map(t => t.id);
};
const corruptions = () => fake.log.info.mock.calls.filter(([phase, event]) => phase === 'schedule' && event === 'schedule-store-corrupt');

describe('the orchestrator owns the bot\'s schedule store (T1b 4.2)', () => {
  it('builds the store on this bot\'s schedules.json and a scheduler it never starts', async () => {
    const o = setup();
    expect(fake.stores.map(s => s.file)).toEqual([file]);
    expect(fake.starts).toHaveLength(1);
    await o.initialize?.();
    expect(await listed(o.scheduleAs({ kind: 'local', via: 'cli' }, list))).toEqual([]);
    expect(fake.starts[0]).not.toHaveBeenCalled();
  });

  it('after a restart lists the tasks already in the file, and a create keeps them', async () => {
    seed();
    const o = setup();
    await o.initialize?.();
    expect(fake.stores[0]!.load).toHaveBeenCalledOnce();
    expect(await listed(o.scheduleAs({ kind: 'local', via: 'cli' }, list))).toEqual(earlier.map(t => t.id));
    const created = await o.scheduleAs({ kind: 'local', via: 'desktop' }, { action: 'create', chatId: CHAT, name: '早报', instruction: '整理早上的新闻', spec: { kind: 'every', minutes: 60 } });
    expect(created).toMatchObject({ kind: 'task', task: { chatId: CHAT, name: '早报', createdBy: { via: 'desktop' } } });
    expect(onDisk()).toHaveLength(3);
    expect(onDisk()).toEqual(expect.arrayContaining(earlier.map(t => t.id)));
    expect(fake.stores[0]!.load).toHaveBeenCalledOnce();
    expect(fake.starts[0]).not.toHaveBeenCalled();
  });

  it('loads ordinary tasks without opening the experimental recipe task file', async () => {
    seed();
    const experimental = join(dirname(file), 'recipe-schedules.json');
    writeFileSync(experimental, 'old experimental bytes');
    const o = setup();
    await o.initialize?.();
    expect(await listed(o.scheduleAs({kind: 'local', via: 'cli'}, list))).toEqual(earlier.map(t => t.id));
    expect(readFileSync(experimental, 'utf8')).toBe('old experimental bytes');
    expect(fake.backend.startThread).not.toHaveBeenCalled();
  });

  it('moves a corrupt file aside in initialize, records one diagnostic and starts empty', async () => {
    writeFileSync(file, '{broken');
    const o = setup();
    await o.initialize?.();
    expect(readdirSync(dirname(file)).filter(name => /^schedules\.json\.corrupt-\d+$/.test(name))).toHaveLength(1);
    expect(corruptions()).toHaveLength(1);
    expect(await listed(o.scheduleAs({ kind: 'local', via: 'cli' }, list))).toEqual([]);
    expect(corruptions()).toHaveLength(1);
  });

  it('answers a request after shutdown began with refused bot-not-running, not a rejection, and writes nothing', async () => {
    const o = setup();
    await o.initialize?.();
    await o.shutdown();
    const notRunning = { kind: 'refused', reason: 'bot-not-running', message: 'Bot 没在运行，任务暂时看不到；启动后再来。' };
    expect(await o.scheduleAs({ kind: 'local', via: 'cli' }, list)).toEqual(notRunning);
    expect(await o.scheduleAs({ kind: 'local', via: 'desktop' }, { action: 'create', chatId: CHAT, name: '早报', instruction: '整理早上的新闻', spec: { kind: 'every', minutes: 60 } })).toEqual(notRunning);
    expect(readdirSync(dirname(file))).not.toContain('schedules.json');
  });

  it('a harness that never calls initialize reads the file at its first request, and only once', async () => {
    seed();
    const o = setup();
    expect(fake.stores[0]!.load).not.toHaveBeenCalled();
    const first = o.scheduleAs({ kind: 'local', via: 'cli' }, list);
    const second = o.scheduleAs({ kind: 'local', via: 'desktop' }, list);
    expect(await listed(first)).toEqual(earlier.map(t => t.id));
    expect(await listed(second)).toEqual(earlier.map(t => t.id));
    await o.initialize?.();
    expect(fake.stores[0]!.load).toHaveBeenCalledOnce();
    expect(fake.starts[0]).not.toHaveBeenCalled();
  });
});
