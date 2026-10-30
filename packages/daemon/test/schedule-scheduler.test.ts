import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleRunRecordSchema } from '@vonvon/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from '../src/bot/schedule/scheduler';
import { createScheduleStore, type ScheduleStore } from '../src/bot/schedule/store';
import { nextSlotAfter } from '../src/bot/schedule/time';
import type { ScheduledJob, ScheduledOutcome, StoredTask } from '../src/bot/schedule/types';

type Gate = ReturnType<Parameters<typeof createScheduler>[0]['gate']>;
const A = Date.parse('2026-11-01T10:00:00Z'), MIN = 60_000, HOUR = 60 * MIN;
const done: ScheduledOutcome = { status: 'done', excerpt: 'ok', durationMs: 1 };
const broken: ScheduledOutcome = { status: 'failed', error: 'broken', counts: true, durationMs: 1 };
const log = { info: vi.fn(), warn: vi.fn(), fail: vi.fn() };
const task = (patch: Partial<StoredTask> = {}): StoredTask => ({
  id: 'st_test', chatId: 'chat-test', revision: 'old', name: 'test', instruction: 'test',
  spec: { kind: 'every', minutes: 1, anchor: A }, timeZone: 'Asia/Shanghai', placement: { kind: 'follow' },
  state: 'active', createdBy: { via: 'cli' }, createdAt: A, updatedAt: A, cursor: A,
  counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
/** A paused-for-failures task whose auto-pause notice has not gone out yet. */
const noticeTask = (patch: Partial<StoredTask> = {}): StoredTask => task({ state: 'paused', pausedReason: 'failures', noticePending: true, noticeSince: A, ...patch });
function memory(initial: StoredTask[], autoChange = false, beforeCommit?: () => Promise<void>): ScheduleStore {
  let tasks = structuredClone(initial), serial = Promise.resolve();
  const listeners = new Set<() => void>();
  function mutate<T>(fn: (copy: StoredTask[]) => T): Promise<T> {
    const result = serial.then(async () => { const copy = structuredClone(tasks); const value = fn(copy); await beforeCommit?.(); tasks = copy; if (autoChange) for (const listener of listeners) listener(); return value; });
    serial = result.then(() => {}, () => {}); return result;
  }
  return {
    load: vi.fn(async () => ({ interrupted: tasks.filter(t => t.inflight) })),
    all: () => structuredClone(tasks), byChat: id => structuredClone(tasks.filter(t => t.chatId === id)),
    get: id => structuredClone(tasks.find(t => t.id === id)), onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    mutateRuntime: mutate,
    mutateConfig: fn => mutate(copy => fn(copy, t => { t.revision += '-new'; t.updatedAt = Date.now(); })),
  };
}
const schedulers: Scheduler[] = [];
function setup(initial: StoredTask[] = [task()], options: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const store = options.store ?? memory(initial), run = vi.fn<(job: ScheduledJob) => Promise<ScheduledOutcome>>(options.run ?? (async () => done));
  const notifyAutoPause = vi.fn(async () => {}), notifyGateFailure = vi.fn(), diagnostics = vi.fn();
  const scheduler = createScheduler({ store, notifyAutoPause, notifyGateFailure,
    now: Date.now, timers: { setTimeout, clearTimeout }, gate: () => 'ok', maxInflight: () => 2,
    log, diagnostics, ...options, run });
  schedulers.push(scheduler);
  return { store, run, scheduler, notifyAutoPause, notifyGateFailure, diagnostics };
}
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
/** start() no longer waits for its first tick; let that tick finish before the test moves the clock. */
async function begin(scheduler: Scheduler) { await scheduler.start({ interrupted: [] }); await flush(); }
async function tick(scheduler: Scheduler, at: number) { vi.setSystemTime(at); scheduler.wake(); await flush(); }
function deferred() { let resolve: (outcome: ScheduledOutcome) => void = () => {}; const promise = new Promise<ScheduledOutcome>(r => { resolve = r; }); return { promise, resolve }; }
const runIdOf = (reply: ReturnType<Scheduler['runNow']>): string => (reply.kind === 'started' ? reply.runId : `no run: ${reply.kind}`);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(A);
  for (const fn of Object.values(log)) fn.mockClear();
});
afterEach(() => { for (const s of schedulers.splice(0)) s.stop(); vi.useRealTimers(); });

it.each([
  [1, MIN, MIN, 'schedule', 0], [1, 3 * HOUR, 3 * HOUR, 'schedule', 179],
  [60, 3.5 * HOUR, 3 * HOUR, 'catchUp', 2], [60, 8 * 24 * HOUR + 30 * MIN, 192 * HOUR, 'catchUp', 191],
  // [9] every is counted exactly: 30 days of a minute task is 43200 slots, minus the one that runs
  [1, 30 * 24 * HOUR, 30 * 24 * HOUR, 'schedule', 43_199],
])('every %s handles wake at +%s', async (minutes, elapsed, slot, trigger, missed) => {
  const { scheduler, run, store } = setup([task({ spec: { kind: 'every', minutes, anchor: A } })]);
  await begin(scheduler); await tick(scheduler, A + elapsed);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]).toMatchObject({ slot: A + slot, trigger, nth: 1, late: trigger === 'catchUp' });
  expect(store.get('st_test')).toMatchObject({ cursor: A + slot, counts: { runs: 1, missed } });
  if (missed) expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', count: missed }));
});
it.each<[string, Gate, number, number]>([
  ['runs after 8 days', 'ok', 8 * 24 * HOUR, 10_000],
  ['is skipped after 8 days', 'disabled', 8 * 24 * HOUR, 10_000],
  ['runs after 10000 minutes (not capped)', 'ok', 10_000 * MIN, 9_999],
])('[12] a minute cron that %s keeps a capped missed count at 10000', async (_name, gate, elapsed, missed) => {
  const { scheduler, run, store } = setup([task({ spec: { kind: 'cron', expr: '* * * * *' } })], { gate: () => gate });
  await begin(scheduler); await tick(scheduler, A + elapsed);
  expect(run).toHaveBeenCalledTimes(gate === 'ok' ? 1 : 0);
  expect(store.get('st_test')?.counts.missed).toBe(missed);
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', slot: A + MIN, count: missed }));
  if (gate !== 'ok') expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'skipped', reason: gate, slot: A + elapsed }));
});
it.each(['cron', 'once'])('does not run %s slots older than seven days', async kind => {
  const old = Date.parse('2027-01-01T01:00Z'), now = Date.parse('2027-01-08T02:00Z');
  vi.setSystemTime(old - HOUR);
  const { scheduler, run, store } = setup([task({ cursor: old - HOUR, spec: kind === 'once' ? { kind: 'once', at: old } : { kind: 'cron', expr: '0 9 1 1 *' } })]);
  await begin(scheduler); await tick(scheduler, now);
  expect(run).not.toHaveBeenCalled();
  expect(store.get('st_test')).toMatchObject({ cursor: now, state: kind === 'once' ? 'finished' : 'active', counts: { missed: 1 } });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', slot: old, count: 1 }));
  if (kind === 'cron') expect(nextSlotAfter(store.get('st_test')!.spec, 'Asia/Shanghai', now)).toBe(Date.parse('2028-01-01T01:00Z'));
});
it('skips the next slot while a run is pending', async () => {
  const pending = deferred(), run = vi.fn(() => pending.promise);
  const { scheduler, store } = setup(undefined, { run }); await begin(scheduler);
  await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  expect(run).toHaveBeenCalledTimes(1); expect(store.get('st_test')).toMatchObject({ cursor: A + 2 * MIN, counts: { skipped: 1 } });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'running' }));
  pending.resolve(done); await flush();
});
it('[22] a run that settles just before the skip write is not recorded as running, and the slot runs', async () => {
  const first = deferred();
  const run = vi.fn<(job: ScheduledJob) => Promise<ScheduledOutcome>>().mockImplementationOnce(() => first.promise).mockResolvedValue(done);
  const { scheduler, store } = setup(undefined, { run });
  await begin(scheduler); await tick(scheduler, A + MIN);
  const original = store.mutateRuntime; let settleFirst = true;
  store.mutateRuntime = fn => original(tasks => {
    // The first run's settle lands between the tick's look at the task and its skip write.
    if (settleFirst) { settleFirst = false; for (const t of tasks) delete t.inflight; }
    return fn(tasks);
  });
  await tick(scheduler, A + 2 * MIN);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ slot: A + 2 * MIN, trigger: 'schedule' }));
  expect(store.get('st_test')?.recent).not.toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'running' }));
  first.resolve(done); await flush();
});
it('persists the claim before calling the runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-claim-'));
  try {
    const file = join(dir, 'schedules.json'), store = createScheduleStore(file, { now: Date.now, log, diagnostics: vi.fn() });
    await store.load(); await store.mutateConfig(tasks => { tasks.push(task()); });
    let persisted: unknown;
    const run = vi.fn(async () => { persisted = JSON.parse(await readFile(file, 'utf8')); return done; });
    const { scheduler } = setup([], { store, run }); await begin(scheduler);
    await tick(scheduler, A + MIN); await vi.waitFor(() => expect(persisted).toBeDefined());
    expect(persisted).toMatchObject({ tasks: [expect.objectContaining({ cursor: A + MIN, inflight: expect.objectContaining({ revision: 'old', runId: expect.any(String) }) })] });
    await scheduler.drain(5000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it.each([false, true])('recovers persisted inflight, deleted before start: %s', async deleted => {
  const t = task({ inflight: { runId: 'old-run', slot: A, trigger: 'schedule', startedAt: A, revision: 'old' } });
  const { scheduler, store, run } = setup([t]); const loaded = await store.load();
  if (deleted) await store.mutateConfig(tasks => { tasks.splice(0); });
  await scheduler.start(loaded); await flush(); expect(store.load).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
  if (!deleted) {
    expect(store.get(t.id)).toMatchObject({ counts: { runs: 1, consecutiveFailures: 1 } });
    expect(store.get(t.id)?.inflight).toBeUndefined();
    expect(store.get(t.id)?.recent).toContainEqual(expect.objectContaining({ status: 'interrupted', by: 'crash' }));
  }
});
it('finishes a crashed once task and pauses on the tenth crash', async () => {
  const once = task({ id: 'once', spec: { kind: 'once', at: A }, inflight: { runId: 'crash-once', slot: A, trigger: 'schedule', startedAt: A, revision: 'old' } });
  const recurring = task({ id: 'repeat', inflight: { runId: 'crash-repeat', slot: A, trigger: 'schedule', startedAt: A, revision: 'old' } });
  recurring.counts.consecutiveFailures = 9;
  const { scheduler, store, notifyAutoPause, run } = setup([once, recurring]); await scheduler.start(await store.load()); await flush();
  expect(store.get('once')?.state).toBe('finished');
  expect(store.get('repeat')).toMatchObject({ state: 'paused', pausedReason: 'failures', counts: { consecutiveFailures: 10 } });
  expect(notifyAutoPause).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
  expect(scheduler.runNow('once')).toMatchObject({ kind: 'started' }); await flush(); expect(run).toHaveBeenCalledTimes(1);
});
it('pauses on ten counted failures and notifies only once', async () => {
  const run = vi.fn(async (): Promise<ScheduledOutcome> => broken);
  const { scheduler, store, notifyAutoPause } = setup(undefined, { run }); await begin(scheduler);
  for (let i = 1; i <= 11; i++) await tick(scheduler, A + i * MIN);
  expect(run).toHaveBeenCalledTimes(10); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  expect(store.get('st_test')).toMatchObject({ state: 'paused', pausedReason: 'failures', counts: { consecutiveFailures: 10 } });
  expect(store.get('st_test')?.revision).not.toBe('old');
});
it.each<[string, StoredTask, Gate]>([
  ['task paused by hand', task({ state: 'paused', pausedReason: 'manual' }), 'ok'],
  ['task paused as unavailable (gate unbound)', task({ state: 'paused', pausedReason: 'unavailable' }), 'unbound'],
  ['finished once task', task({ state: 'finished', spec: { kind: 'once', at: A }, cursor: A }), 'ok'],
])('[7][24] the tenth failure of a %s counts but keeps its state and sends nothing', async (_name, t, gate) => {
  t.counts.consecutiveFailures = 9;
  const { scheduler, store, notifyAutoPause } = setup([t], { run: async () => broken, gate: () => gate });
  await begin(scheduler); scheduler.runNow(t.id); await flush();
  expect(store.get(t.id)).toMatchObject({ state: t.state, revision: 'old', counts: { runs: 1, consecutiveFailures: 10 } });
  expect(store.get(t.id)?.pausedReason).toBe(t.pausedReason);
  expect(store.get(t.id)?.noticePending).toBeUndefined();
  expect(notifyAutoPause).not.toHaveBeenCalled();
});
it('[7][24] a task paused while its run is on is not auto-paused by that run failing for the tenth time', async () => {
  const t = task(); t.counts.consecutiveFailures = 9;
  const pending = deferred(), { scheduler, store, notifyAutoPause } = setup([t], { run: () => pending.promise });
  await begin(scheduler); await tick(scheduler, A + MIN);
  await store.mutateConfig((tasks, touch) => { for (const x of tasks) { x.state = 'paused'; x.pausedReason = 'unavailable'; touch(x); } });
  pending.resolve(broken); await flush();
  expect(store.get(t.id)).toMatchObject({ state: 'paused', pausedReason: 'unavailable', counts: { consecutiveFailures: 10 } });
  expect(store.get(t.id)?.noticePending).toBeUndefined();
  expect(notifyAutoPause).not.toHaveBeenCalled();
});
it.each<ScheduledOutcome>([done, { status: 'failed', error: 'offline', counts: false, durationMs: 0 }, { status: 'interrupted', by: 'shutdown' }, { status: 'interrupted', by: 'user' }])('settles failure streak for $status $by', async outcome => {
  const t = task(); t.counts.consecutiveFailures = 4;
  const { scheduler, store } = setup([t], { run: async () => outcome }); await begin(scheduler); await tick(scheduler, A + MIN);
  expect(store.get(t.id)?.counts).toMatchObject({ runs: 1, consecutiveFailures: outcome.status === 'done' ? 0 : 4 });
});
it.each<[string, ScheduledOutcome, Record<string, unknown>, string]>([
  ['a long error and a fractional duration',
    { status: 'failed', error: 'x'.repeat(250), counts: true, durationMs: 12.5, messageId: '', topicId: 'om_topic' },
    { error: 'x'.repeat(200), durationMs: 13, topicId: 'om_topic' }, `失败：${'x'.repeat(200)}`],
  ['an emoji error that must not be cut inside a pair and a negative duration',
    { status: 'failed', error: '\u{1F525}'.repeat(150), counts: true, durationMs: -5 },
    { error: '\u{1F525}'.repeat(100), durationMs: 0 }, `失败：${'\u{1F525}'.repeat(100)}`],
  ['a done run with a long excerpt and runner-only fields',
    { status: 'done', excerpt: 'y'.repeat(600), durationMs: 1.5, messageId: 'om_1', extra: true } as ScheduledOutcome,
    { durationMs: 2, messageId: 'om_1' }, 'y'.repeat(500)],
])('[17] settle stores only run-record fields that load() accepts: %s', async (_name, outcome, saved, excerpt) => {
  const { scheduler, store } = setup(undefined, { run: async () => outcome });
  await begin(scheduler); await tick(scheduler, A + MIN);
  const record = store.get('st_test')?.recent.at(-1);
  expect(() => scheduleRunRecordSchema.parse(record)).not.toThrow();
  expect(record).toMatchObject({ status: outcome.status, slot: A + MIN, ...saved });
  for (const key of ['counts', 'excerpt', 'extra']) expect(record).not.toHaveProperty(key);
  if (!('messageId' in saved)) expect(record).not.toHaveProperty('messageId');
  expect(store.get('st_test')?.lastResult?.excerpt).toBe(excerpt);
});
it('[17] a runner error longer than the schema allows survives a restart of the real store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-settle-'));
  try {
    const file = join(dir, 'schedules.json'), diagnostics = vi.fn();
    const store = createScheduleStore(file, { now: Date.now, log, diagnostics });
    await store.load(); await store.mutateConfig(tasks => { tasks.push(task()); });
    const { scheduler } = setup([], { store, run: async () => ({ status: 'failed', error: 'x'.repeat(201), counts: true, durationMs: 1.5 }) });
    await begin(scheduler); await tick(scheduler, A + MIN); await scheduler.drain(5000);
    const reloaded = createScheduleStore(file, { now: Date.now, log, diagnostics });
    await reloaded.load();
    expect(reloaded.get('st_test')?.recent).toEqual([expect.objectContaining({ status: 'failed', error: 'x'.repeat(200), durationMs: 2 })]);
    expect(diagnostics).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule-store-corrupt' }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it.each([false, true])('retries pending pause notices until success or 24h expiry: %s', async expired => {
  const t = noticeTask(); t.counts.consecutiveFailures = 10;
  const notifyAutoPause = vi.fn(async (): Promise<void> => { throw new Error('offline'); });
  const { scheduler, store } = setup([t], { notifyAutoPause }); await begin(scheduler);
  expect(store.get(t.id)?.noticePending).toBe(true); const calls = notifyAutoPause.mock.calls.length;
  notifyAutoPause.mockResolvedValueOnce(undefined); await tick(scheduler, A + (expired ? 25 * HOUR : MIN));
  expect(notifyAutoPause).toHaveBeenCalledTimes(calls + (expired ? 0 : 1));
  if (!expired) expect(store.get(t.id)).not.toHaveProperty('noticePending');
});
it('[20] a hung auto-pause notice holds up neither start(), nor ticks, nor runNow', async () => {
  const notifyAutoPause = vi.fn(() => new Promise<void>(() => {}));
  const { scheduler, run } = setup([noticeTask({ id: 'notice', chatId: 'chat-a' }), task({ id: 'due', chatId: 'chat-b' })], { notifyAutoPause });
  let started = false;
  void scheduler.start({ interrupted: [] }).then(() => { started = true; });
  await flush();
  expect(started).toBe(true);
  await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  expect(run.mock.calls.map(([job]) => job.slot)).toEqual([A + MIN, A + 2 * MIN]);
  vi.setSystemTime(A + 2 * MIN + 5000); expect(scheduler.runNow('due')).toMatchObject({ kind: 'started' }); await flush();
  expect(run).toHaveBeenCalledTimes(3);
  expect(notifyAutoPause).toHaveBeenCalledTimes(1); // the first send is still in flight, so no second one
});
it('[3] an auto-pause notice with no answer in 15 seconds counts as not sent and is retried by the next tick', async () => {
  const notifyAutoPause = vi.fn(() => new Promise<void>(() => {}));
  const { scheduler, store, diagnostics } = setup([noticeTask()], { notifyAutoPause });
  await begin(scheduler); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(14_999); scheduler.wake(); await flush();
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule-notice-pending' }));
  expect(store.get('st_test')?.noticePending).toBe(true);
  scheduler.wake(); await flush();
  expect(notifyAutoPause).toHaveBeenCalledTimes(2);
});
it('[20] start() resolves after the crash records without waiting for the first tick', async () => {
  const blocked = deferred(); let block = false;
  const crashed = task({ id: 'crashed', inflight: { runId: 'crash', slot: A, trigger: 'schedule', startedAt: A, revision: 'old' } });
  const store = memory([crashed, task({ id: 'due' })], false, async () => { if (block) { block = false; await blocked.promise; } });
  const { scheduler, run } = setup([], { store });
  vi.setSystemTime(A + MIN);
  let started = false;
  void scheduler.start(await store.load()).then(() => { started = true; block = true; });
  await flush();
  // The crash is on record before start() resolves; the first tick's claim write is the one held.
  expect(started).toBe(true);
  expect(store.get('crashed')?.recent).toContainEqual(expect.objectContaining({ status: 'interrupted', by: 'crash' }));
  expect(run).not.toHaveBeenCalled();
  blocked.resolve(done); await flush();
  expect(run).toHaveBeenCalled();
});
it.each([false, true])('[3] drain waits for an auto-pause notice in flight, up to its deadline; hung: %s', async hung => {
  const sending = deferred(), notifyAutoPause = vi.fn(async () => { if (!hung) await sending.promise; else await new Promise(() => {}); });
  const { scheduler, store } = setup([noticeTask()], { notifyAutoPause });
  await begin(scheduler); scheduler.stop();
  let drained = false; const draining = scheduler.drain(5000).then(() => { drained = true; });
  await flush(); expect(drained).toBe(false);
  if (hung) await vi.advanceTimersByTimeAsync(5000); else { sending.resolve(done); await flush(); }
  await draining;
  expect(drained).toBe(true);
  if (!hung) expect(store.get('st_test')?.noticePending).toBeUndefined();
});
it('[23] the notice of a task resumed meanwhile is dropped without sending', async () => {
  const notifyAutoPause = vi.fn(async (): Promise<void> => { throw new Error('offline'); });
  const { scheduler, store } = setup([noticeTask()], { notifyAutoPause });
  await begin(scheduler); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  await store.mutateConfig((tasks, touch) => { for (const x of tasks) { x.state = 'active'; delete x.pausedReason; x.counts.consecutiveFailures = 0; touch(x); } });
  notifyAutoPause.mockResolvedValue(undefined); await tick(scheduler, A + 10_000);
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  expect(store.get('st_test')).not.toHaveProperty('noticePending');
  expect(store.get('st_test')).not.toHaveProperty('noticeSince');
});
it('[23] a rename while the notice is in flight does not keep it pending after it was sent', async () => {
  const sending = deferred(), notifyAutoPause = vi.fn(async () => { await sending.promise; });
  const { scheduler, store } = setup([noticeTask()], { notifyAutoPause });
  await begin(scheduler);
  vi.setSystemTime(A + 1000);
  await store.mutateConfig((tasks, touch) => { for (const x of tasks) { x.name = 'renamed'; touch(x); } });
  sending.resolve(done); await flush();
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  expect(store.get('st_test')?.noticePending).toBeUndefined();
  await tick(scheduler, A + 2000); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
});
it('[23] the 24-hour notice window counts from the auto-pause, not from a later edit', async () => {
  const notifyAutoPause = vi.fn(async (): Promise<void> => { throw new Error('offline'); });
  const { scheduler, store } = setup([noticeTask()], { notifyAutoPause });
  await begin(scheduler); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  vi.setSystemTime(A + 23 * HOUR);
  await store.mutateConfig((tasks, touch) => { for (const x of tasks) { x.name = 'renamed'; touch(x); } });
  await tick(scheduler, A + 25 * HOUR);
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
});
it.each(['unchanged', 'edited', 'paused', 'interrupted'])('settles once tasks: %s', async mode => {
  const pending = deferred(), t = task({ spec: { kind: 'once', at: A + MIN } });
  const { scheduler, store } = setup([t], { run: () => pending.promise }); await begin(scheduler); await tick(scheduler, A + MIN);
  if (mode === 'edited' || mode === 'paused') await store.mutateConfig((tasks, touch) => { for (const t of tasks) { if (mode === 'edited') t.spec = { kind: 'once', at: A + 21 * MIN }; else { t.state = 'paused'; t.pausedReason = 'unavailable'; } touch(t); } });
  pending.resolve(mode === 'interrupted' ? { status: 'interrupted', by: 'user' } : done); await flush();
  expect(store.get(t.id)?.state).toBe(mode === 'edited' ? 'active' : mode === 'paused' ? 'paused' : 'finished');
  if (mode === 'edited') { expect(nextSlotAfter(store.get(t.id)!.spec, t.timeZone, A + MIN)).toBe(A + 21 * MIN); await tick(scheduler, A + 21 * MIN); expect(store.get(t.id)?.cursor).toBe(A + 21 * MIN); }
});
it('manual runs preserve the cursor, accept paused tasks, and reject duplicate claims', async () => {
  const pending = deferred(), { scheduler, store, run } = setup([task({ state: 'paused' })], { run: vi.fn(() => pending.promise) });
  expect(scheduler.runNow('st_test')).toEqual({ kind: 'not-started' }); await begin(scheduler);
  expect(scheduler.runNow('missing')).toEqual({ kind: 'not-found' }); expect(scheduler.runNow('st_test')).toMatchObject({ kind: 'started' }); await flush();
  expect(scheduler.runNow('st_test')).toEqual({ kind: 'running' }); expect(run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', slot: A }));
  expect(store.get('st_test')?.cursor).toBe(A); expect(nextSlotAfter(store.get('st_test')!.spec, 'Asia/Shanghai', A)).toBe(A + MIN); pending.resolve(done); await flush();
});
it('runNow returns the runId of the run it starts and says running while that run is queued or on', async () => {
  const pending = deferred(), { scheduler, store, run } = setup(undefined, { run: vi.fn(() => pending.promise) });
  await begin(scheduler);
  const reply = scheduler.runNow('st_test');
  expect(reply).toEqual({ kind: 'started', runId: expect.any(String) });
  expect(scheduler.runNow('st_test')).toEqual({ kind: 'running' }); // accepted, not claimed yet
  await flush();
  expect(run.mock.calls[0]?.[0]).toMatchObject({ runId: runIdOf(reply), trigger: 'manual' });
  expect(store.get('st_test')?.inflight?.runId).toBe(runIdOf(reply));
  expect(scheduler.runNow('st_test')).toEqual({ kind: 'running' });
  pending.resolve(done); await flush();
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ runId: runIdOf(reply), trigger: 'manual', status: 'done' }));
});
it('a manual run accepted while a scheduled claim is being written waits for that run, then runs with its runId', async () => {
  const blocked = deferred(); let block = false;
  const store = memory([task()], false, async () => { if (block) { block = false; await blocked.promise; } });
  const first = deferred();
  const run = vi.fn<(job: ScheduledJob) => Promise<ScheduledOutcome>>().mockImplementationOnce(() => first.promise).mockResolvedValue(done);
  const { scheduler } = setup([], { store, run });
  await begin(scheduler); block = true; await tick(scheduler, A + MIN); // the scheduled claim write is held
  const reply = scheduler.runNow('st_test');
  expect(reply.kind).toBe('started');
  blocked.resolve(done); await flush();
  expect(run.mock.calls.map(([job]) => job.trigger)).toEqual(['schedule']);
  first.resolve(done); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]?.[0]).toMatchObject({ trigger: 'manual', runId: runIdOf(reply) });
});
it('coalesces concurrent wake calls into one claim', async () => {
  const { scheduler, run, store } = setup(); const original = store.mutateRuntime; let claims = 0;
  store.mutateRuntime = fn => original(tasks => { const before = tasks.filter(t => t.inflight).length; const value = fn(tasks); claims += Math.max(0, tasks.filter(t => t.inflight).length - before); return value; });
  await begin(scheduler);
  vi.setSystemTime(A + MIN); scheduler.wake(); scheduler.wake(); scheduler.wake(); await flush();
  expect(run).toHaveBeenCalledTimes(1); expect(store.get('st_test')?.counts.runs).toBe(1); expect(claims).toBe(1);
});
it.each(['cursor', 'configuration'])('rechecks the %s inside the claim mutation', async change => {
  const store = memory([task()]), original = store.mutateRuntime; let race = true;
  store.mutateRuntime = fn => original(tasks => {
    if (race && Date.now() > A) {
      race = false;
      for (const t of tasks) {
        if (change === 'cursor') t.cursor = Date.now();
        else { t.spec = { kind: 'once', at: A + HOUR }; t.revision = 'edited'; }
      }
    }
    return fn(tasks);
  });
  const { scheduler, run } = setup([], { store }); await begin(scheduler); await tick(scheduler, A + MIN); expect(run).not.toHaveBeenCalled();
});
it('limits concurrent runs and spaces starts two seconds apart', async () => {
  const pending = deferred(), run = vi.fn(() => pending.promise);
  const { scheduler } = setup(['a', 'b', 'c'].map(id => task({ id })), { run }); await begin(scheduler); await tick(scheduler, A + MIN);
  expect(run).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(2); pending.resolve(done); await flush();
  await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(3);
});
it('replaces a queued slot without double-counting it as missed or skipped', async () => {
  const pending = deferred(), run = vi.fn((job: ScheduledJob) => job.task.id === 'a' ? pending.promise : Promise.resolve(done));
  const { scheduler, store } = setup([task({ id: 'a', spec: { kind: 'once', at: A + MIN } }), task({ id: 'b' })], { run, maxInflight: () => 1 });
  await begin(scheduler); await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  expect(store.get('b')).toMatchObject({ counts: { missed: 1, skipped: 0 } });
  expect(store.get('b')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', slot: A + MIN, count: 1 }));
  pending.resolve(done); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls.filter(([job]) => job.task.id === 'b')).toHaveLength(1);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ slot: A + 2 * MIN })); expect(store.get('b')?.counts.missed).toBe(1);
});
it('[21] replacing a queued catch-up slot keeps the merged missed count of the slots before it', async () => {
  const held = deferred(), run = vi.fn((job: ScheduledJob) => job.task.id === 'a' ? held.promise : Promise.resolve(done));
  const { scheduler, store } = setup([task({ id: 'a', state: 'paused' }), task({ id: 'b' })], { run, maxInflight: () => 1 });
  await begin(scheduler); scheduler.runNow('a'); await flush(); // a holds the only slot
  await tick(scheduler, A + 3 * HOUR); await tick(scheduler, A + 3 * HOUR + MIN);
  held.resolve(done); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls.filter(([job]) => job.task.id === 'b').map(([job]) => job.slot)).toEqual([A + 181 * MIN]);
  expect(store.get('b')?.counts).toMatchObject({ missed: 180, skipped: 0 });
  expect(store.get('b')?.recent).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: 'missed', slot: A + MIN, count: 179 }),
    expect.objectContaining({ status: 'missed', slot: A + 180 * MIN, count: 1 }),
  ]));
});
it.each<Gate>(['disabled', 'updating', 'held', 'tier-unavailable', 'unbound'])('handles gate %s', async gate => {
  const { scheduler, store, run, notifyGateFailure, notifyAutoPause } = setup(undefined, { gate: () => gate });
  await begin(scheduler); await tick(scheduler, A + MIN); const failed = gate === 'tier-unavailable' || gate === 'unbound';
  expect(run).not.toHaveBeenCalled(); expect(notifyAutoPause).not.toHaveBeenCalled();
  expect(notifyGateFailure).toHaveBeenCalledTimes(gate === 'tier-unavailable' ? 1 : 0);
  expect(store.get('st_test')?.counts).toMatchObject({ consecutiveFailures: failed ? 1 : 0, skipped: failed ? 0 : 1 });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining(failed ? { status: 'failed' } : { status: 'skipped', reason: gate }));
});
it('checks the gate before the running rule: tier-unavailable during a run is a counted failure, not a skip', async () => {
  const pending = deferred(); let gate: Gate = 'ok';
  const { scheduler, store, notifyGateFailure } = setup(undefined, { run: () => pending.promise, gate: () => gate });
  await begin(scheduler); await tick(scheduler, A + MIN);
  gate = 'tier-unavailable'; await tick(scheduler, A + 2 * MIN);
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'failed', slot: A + 2 * MIN, error: '本群的权限档现在用不了' }));
  expect(store.get('st_test')?.recent).not.toContainEqual(expect.objectContaining({ reason: 'running' }));
  expect(store.get('st_test')?.counts).toMatchObject({ consecutiveFailures: 1, skipped: 0 });
  expect(notifyGateFailure).toHaveBeenCalledTimes(1);
  pending.resolve(done); await flush();
});
it('keeps run bookkeeping off the config entry: a claim, a skip and a settle leave the revision alone', async () => {
  const pending = deferred(), store = memory([task()]), mutateConfig = vi.spyOn(store, 'mutateConfig');
  const { scheduler } = setup([], { store, run: () => pending.promise });
  await begin(scheduler); await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  pending.resolve(done); await flush();
  expect(mutateConfig).not.toHaveBeenCalled();
  expect(store.get('st_test')).toMatchObject({ revision: 'old', counts: { runs: 1, skipped: 1 } });
});
it.each([['first', ['bad', 'good']], ['last', ['good', 'bad']]])('[1] a task whose decision throws (%s) is logged and skipped; the others run and nothing retries fast', async (_where, order) => {
  const tasks = order.map(id => task({ id, ...(id === 'bad' ? { spec: { kind: 'cron', expr: 'a b c d e' } } : {}) }));
  const { scheduler, run } = setup(tasks);
  await begin(scheduler); await tick(scheduler, A + MIN);
  expect(run.mock.calls.map(([job]) => job.task.id)).toEqual(['good']);
  const failures = log.fail.mock.calls.length;
  expect(failures).toBeGreaterThan(0);
  expect(failures).toBeLessThan(10);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(log.fail).toHaveBeenCalledTimes(failures);
  await vi.advanceTimersByTimeAsync(1000);
  expect(log.fail).toHaveBeenCalledTimes(failures + 1);
});
it('[18] a gate that throws for one chat does not stop the tasks of other chats', async () => {
  const gate = vi.fn((chatId: string): Gate => { if (chatId === 'chat-bad') throw new Error('gate broke'); return 'ok'; });
  const { scheduler, run } = setup(['good', 'bad', 'good2'].map(id => task({ id, chatId: `chat-${id}` })), { gate });
  await begin(scheduler); await tick(scheduler, A + MIN);
  expect(run.mock.calls.map(([job]) => job.task.id)).toEqual(['good']);
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls.map(([job]) => job.task.id)).toEqual(['good', 'good2']);
  expect(gate.mock.calls.length).toBeLessThan(20);
});
it('[1][18] a claim write that keeps failing is retried every 30 seconds, not every millisecond', async () => {
  const store = memory([task()]); let writes = 0;
  store.mutateRuntime = () => { writes++; return Promise.reject(new Error('disk full')); };
  const { scheduler, run } = setup([], { store });
  await begin(scheduler); await tick(scheduler, A + MIN);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(writes).toBe(1);
  expect(log.fail).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(writes).toBe(2);
  expect(run).not.toHaveBeenCalled();
});
/** A store whose writes that would settle task `id` fail while `failing.on` is true. */
function failingSettles(store: ScheduleStore, id: string) {
  const failing = { on: true }, original = store.mutateRuntime;
  store.mutateRuntime = fn => original(tasks => {
    const before = tasks.find(t => t.id === id)?.inflight;
    const value = fn(tasks);
    if (failing.on && before && !tasks.find(t => t.id === id)?.inflight) throw new Error('disk full');
    return value;
  });
  return failing;
}
it('[5][19] a failed settle write is retried, and its run does not keep holding a concurrency slot', async () => {
  const store = memory([task({ id: 'a' }), task({ id: 'b' })]), failing = failingSettles(store, 'a');
  const { scheduler, run } = setup([], { store, maxInflight: () => 1 });
  await begin(scheduler); await tick(scheduler, A + MIN);
  expect(store.get('a')?.inflight).toBeDefined();
  await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls.map(([job]) => job.task.id)).toEqual(['a', 'b']); // b got the slot a's finished run left
  failing.on = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(store.get('a')?.inflight).toBeUndefined();
  expect(store.get('a')).toMatchObject({ counts: { runs: 1, skipped: 0 }, lastResult: { status: 'done' } });
  expect(store.get('a')?.recent).toContainEqual(expect.objectContaining({ status: 'done', slot: A + MIN }));
  expect(scheduler.runNow('a')).toMatchObject({ kind: 'started' });
});
it('[19] drain retries a settle write that failed', async () => {
  const store = memory([task()]), failing = failingSettles(store, 'st_test');
  const { scheduler } = setup([], { store });
  await begin(scheduler); await tick(scheduler, A + MIN);
  expect(store.get('st_test')?.inflight).toBeDefined();
  scheduler.stop(); failing.on = false; await scheduler.drain(5000);
  expect(store.get('st_test')?.inflight).toBeUndefined();
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'done', slot: A + MIN }));
});
it.each([false, true])('stops claiming and drains with bounded wait; timeout: %s', async timeout => {
  const pending = deferred(), { scheduler, run, store } = setup(undefined, { run: vi.fn(() => pending.promise) });
  await begin(scheduler); await tick(scheduler, A + MIN); scheduler.stop(); await tick(scheduler, A + 2 * MIN);
  expect(run).toHaveBeenCalledTimes(1); let drained = false; const draining = scheduler.drain(5000).then(() => { drained = true; });
  await flush(); expect(drained).toBe(false);
  if (timeout) await vi.advanceTimersByTimeAsync(5000); else { pending.resolve(done); await flush(); }
  await draining; expect(drained).toBe(true); if (!timeout) expect(store.get('st_test')?.counts.runs).toBe(1);
});
it('sends one auto-pause notice when store changes wake a tick during settlement', async () => {
  const t = task(); t.counts.consecutiveFailures = 9;
  const pending = deferred(), notifyAutoPause = vi.fn(async () => { await pending.promise; });
  const store = memory([t], true), { scheduler } = setup([], { store, notifyAutoPause, run: async () => broken });
  await begin(scheduler); await tick(scheduler, A + MIN);
  expect(store.get(t.id)).toMatchObject({ state: 'paused', noticePending: true, noticeSince: A + MIN }); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  scheduler.wake(); scheduler.wake(); await flush(); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  pending.resolve(done); await flush(); expect(store.get(t.id)?.noticePending).toBeUndefined();
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
});
it('does not launch a claimed run when stop occurs before claim persistence completes', async () => {
  const pending = deferred(); let writing = false;
  const store = memory([task()], false, async () => { if (!writing && Date.now() > A) { writing = true; await pending.promise; } });
  const { scheduler, run } = setup([], { store }); await begin(scheduler);
  await tick(scheduler, A + MIN); expect(writing).toBe(true); expect(store.get('st_test')?.inflight).toBeUndefined();
  scheduler.stop(); pending.resolve(done); await flush(); await scheduler.drain(5000);
  expect(run).not.toHaveBeenCalled(); expect(store.get('st_test')?.inflight).toBeUndefined();
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'interrupted', by: 'shutdown' }));
});
