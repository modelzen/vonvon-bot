import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import { createScheduler, type Scheduler } from '../src/bot/schedule/scheduler';
import { createScheduleStore } from '../src/bot/schedule/store';
import type { ScheduledOutcome, StoredTask } from '../src/bot/schedule/types';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  orchestrator: undefined as unknown,
}));
vi.mock('../src/bot/bridge-channel', () => ({ createBridgeChannel: () => ({ on() {}, connect: async () => {}, disconnect: async () => {} }) }));
vi.mock('../src/config/card-callback', () => ({ createCardCallbackRecorder: () => ({ received() {}, close: async () => {} }) }));
vi.mock('../src/config/app-roles', () => ({
  APP_ROLE_CACHE_MS: 60_000, getAppRoleSnapshot: () => ({ fetchedAt: Date.now() }),
  createAppRoleRefresher: () => ({ refresh: async () => {}, stop: async () => {} }),
}));
vi.mock('../src/admin/groups', () => ({ createGroupExecutor: () => async () => ({ groups: [] }) }));
vi.mock('../src/agent/entry/command-tools', () => ({ createCommandTools: () => ({}) }));
vi.mock('../src/agent/entry/registry', () => ({ createAgentEntries: () => ({}) }));
vi.mock('../src/bot/memory-writer', () => ({ createMemoryWriter: () => ({}) }));
vi.mock('../src/project/registry', () => ({ listProjects: async () => [], splitTierChats: async () => new Map(), setTierMergePending: async () => {} }));
vi.mock('../src/bot/topic-registry', () => ({ createTopicRegistry: () => ({}) }));
vi.mock('../src/bot/session-store', () => ({ adoptAdminSessions: async () => [] }));
vi.mock('../src/config/paths', () => ({ paths: { topicsDir: '/fixture/topics' } }));
vi.mock('../src/host/crash-guard', () => ({ onCrashSync: () => () => {} }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
vi.mock('../src/bot/handle-message', () => ({ createOrchestrator: () => fixture.orchestrator }));

import { startBridge } from '../src/bot/bridge';
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'test', tenant: 'feishu' } } };
const start = () => startBridge({ identity: { appId: 'cli_fixture', tenant: 'feishu', createdAt: 1 }, cfg, appSecret: 'test', fallbackCwd: '/fixture' });
const log = { info: vi.fn(), warn: vi.fn(), fail: vi.fn() };
const A = Date.parse('2026-11-02T01:00:00Z'), MIN = 60_000;
let root: string;
let scheduler: Scheduler | undefined;

beforeEach(() => {
  fixture.order.length = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-schedule-shutdown-')));
});
afterEach(() => {
  scheduler?.stop();
  rmSync(root, { recursive: true, force: true });
});

function orchestrator(scheduler: Pick<Scheduler, 'stop' | 'drain'>, shutdown: () => Promise<void>) {
  return { initialize: async () => {}, dispatcher: { handle: async () => {} }, replyDropped() {}, saveDroppedSync() {}, settings: {}, shutdown, scheduler: { start: async () => {}, ...scheduler } };
}
const task = (patch: Partial<StoredTask> = {}): StoredTask => ({
  id: 'st_00000000000000a1', chatId: 'oc_a', revision: 'rev', name: '日报', instruction: '写日报', spec: { kind: 'every', minutes: 1, anchor: A },
  timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: A, updatedAt: A,
  cursor: A, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
/** A real scheduler on a real file; `run` is a fake, T2's runScheduled not being here. */
async function real(seeded: StoredTask, run: () => Promise<ScheduledOutcome>, now: number) {
  const file = join(root, 'schedules.json');
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [seeded] }));
  const store = createScheduleStore(file, { now: () => now, log, diagnostics: () => {} });
  const diagnostics = vi.fn();
  scheduler = createScheduler({ store, now: () => now, timers: { setTimeout, clearTimeout }, run, gate: () => 'ok',
    notifyAutoPause: async () => {}, notifyGateFailure: () => {}, maxInflight: () => 1, log, diagnostics });
  await scheduler.start(await store.load());
  const onDisk = () => (JSON.parse(readFileSync(file, 'utf8')) as { tasks: StoredTask[] }).tasks[0]!;
  return { diagnostics, onDisk };
}

it('stops the scheduler before the orchestrator shuts down, and drains it for at most 5 seconds after', async () => {
  let finish!: () => void;
  fixture.orchestrator = orchestrator(
    { stop: () => { fixture.order.push('stop'); }, drain: async ms => { fixture.order.push(`drain ${ms}`); } },
    () => { fixture.order.push('shutdown'); return new Promise(resolve => { finish = resolve; }); },
  );
  const handle = await start();
  const closing = handle.shutdown();
  await new Promise(resolve => setImmediate(resolve));
  expect(fixture.order).toEqual(['stop', 'shutdown']);
  finish();
  await closing;
  expect(fixture.order).toEqual(['stop', 'shutdown', 'drain 5000']);
});

it('a run on at shutdown is settled interrupted and written before the bridge is closed', async () => {
  let interrupt!: () => void;
  const running = new Promise<ScheduledOutcome>(resolve => { interrupt = () => resolve({ status: 'interrupted', by: 'shutdown' }); });
  const { onDisk } = await real(task(), () => running, A + MIN);
  await vi.waitFor(() => expect(onDisk().inflight).toBeDefined());
  // The orchestrator's shutdown interrupts the run and settles its hook (T2), standing in here for runScheduled.
  fixture.orchestrator = orchestrator(scheduler!, async () => { interrupt(); });
  await (await start()).shutdown();
  expect(onDisk().inflight).toBeUndefined();
  expect(onDisk().recent).toEqual([expect.objectContaining({ status: 'interrupted', by: 'shutdown', slot: A + MIN })]);
  expect(onDisk().counts).toEqual({ runs: 1, missed: 0, skipped: 0, consecutiveFailures: 0 });
});

it('a restart that finds a run still in flight records it interrupted by a crash, counts a failure and does not run it again', async () => {
  const run = vi.fn(async (): Promise<ScheduledOutcome> => ({ status: 'done', excerpt: '', durationMs: 1 }));
  const crashed = task({ cursor: A + MIN, inflight: { runId: 'run-1', slot: A + MIN, trigger: 'schedule', startedAt: A + MIN, revision: 'rev' } });
  const { onDisk, diagnostics } = await real(crashed, run, A + MIN + 30_000);
  await vi.waitFor(() => expect(onDisk().inflight).toBeUndefined());
  await scheduler!.drain(1_000);
  expect(onDisk()).toMatchObject({ cursor: A + MIN, counts: { runs: 1, consecutiveFailures: 1 }, recent: [{ runId: 'run-1', status: 'interrupted', by: 'crash' }] });
  expect(diagnostics).toHaveBeenCalledWith({ kind: 'schedule-interrupted', taskId: 'st_00000000000000a1' });
  expect(run).not.toHaveBeenCalled();
});
