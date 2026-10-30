import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from '../src/bot/schedule/scheduler';
import { createScheduleStore, type ScheduleStore } from '../src/bot/schedule/store';
import { nextSlotAfter } from '../src/bot/schedule/time';
import type { ScheduledJob, ScheduledOutcome, StoredTask } from '../src/bot/schedule/types';

const A = Date.parse('2026-11-01T10:00:00Z'), MIN = 60_000, HOUR = 60 * MIN;
const done: ScheduledOutcome = { status: 'done', excerpt: 'ok', durationMs: 1 };
const log = { info: vi.fn(), warn: vi.fn(), fail: vi.fn() };
const task = (patch: Partial<StoredTask> = {}): StoredTask => ({
  id: 'st_test', chatId: 'chat-test', revision: 'old', name: 'test', instruction: 'test',
  spec: { kind: 'every', minutes: 1, anchor: A }, timeZone: 'Asia/Shanghai', placement: { kind: 'follow' },
  state: 'active', createdBy: { via: 'cli' }, createdAt: A, updatedAt: A, cursor: A,
  counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [], ...patch,
});
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
  const notifyAutoPause = vi.fn(async () => {}), notifyGateFailure = vi.fn();
  const scheduler = createScheduler({ store, notifyAutoPause, notifyGateFailure,
    now: Date.now, timers: { setTimeout, clearTimeout }, gate: () => 'ok', maxInflight: () => 2,
    log, diagnostics: vi.fn(), ...options, run });
  schedulers.push(scheduler);
  return { store, run, scheduler, notifyAutoPause, notifyGateFailure };
}
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
async function tick(scheduler: Scheduler, at: number) { vi.setSystemTime(at); scheduler.wake(); await flush(); }
function deferred() { let resolve: (outcome: ScheduledOutcome) => void = () => {}; const promise = new Promise<ScheduledOutcome>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(A); });
afterEach(() => { for (const s of schedulers.splice(0)) s.stop(); vi.useRealTimers(); });

it.each([
  [1, MIN, MIN, 'schedule', 0], [1, 3 * HOUR, 3 * HOUR, 'schedule', 179],
  [60, 3.5 * HOUR, 3 * HOUR, 'catchUp', 2], [60, 8 * 24 * HOUR + 30 * MIN, 192 * HOUR, 'catchUp', 191],
])('every %s handles wake at +%s', async (minutes, elapsed, slot, trigger, missed) => {
  const { scheduler, run, store } = setup([task({ spec: { kind: 'every', minutes, anchor: A } })]);
  await scheduler.start({ interrupted: [] }); await tick(scheduler, A + elapsed);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]?.[0]).toMatchObject({ slot: A + slot, trigger, nth: 1, late: trigger === 'catchUp' });
  expect(store.get('st_test')).toMatchObject({ cursor: A + slot, counts: { runs: 1, missed } });
  if (missed) expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', count: missed }));
});
it.each(['cron', 'once'])('does not run %s slots older than seven days', async kind => {
  const old = Date.parse('2027-01-01T01:00Z'), now = Date.parse('2027-01-08T02:00Z');
  vi.setSystemTime(old - HOUR);
  const { scheduler, run, store } = setup([task({ cursor: old - HOUR, spec: kind === 'once' ? { kind: 'once', at: old } : { kind: 'cron', expr: '0 9 1 1 *' } })]);
  await scheduler.start({ interrupted: [] }); await tick(scheduler, now);
  expect(run).not.toHaveBeenCalled();
  expect(store.get('st_test')).toMatchObject({ cursor: now, state: kind === 'once' ? 'finished' : 'active', counts: { missed: 1 } });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', slot: old, count: 1 }));
  if (kind === 'cron') expect(nextSlotAfter(store.get('st_test')!.spec, 'Asia/Shanghai', now)).toBe(Date.parse('2028-01-01T01:00Z'));
});
it('skips the next slot while a run is pending', async () => {
  const pending = deferred(), run = vi.fn(() => pending.promise);
  const { scheduler, store } = setup(undefined, { run }); await scheduler.start({ interrupted: [] });
  await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  expect(run).toHaveBeenCalledTimes(1); expect(store.get('st_test')).toMatchObject({ cursor: A + 2 * MIN, counts: { skipped: 1 } });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'running' }));
  pending.resolve(done); await flush();
});
it('persists the claim before calling the runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-claim-'));
  try {
    const file = join(dir, 'schedules.json'), store = createScheduleStore(file, { now: Date.now, log, diagnostics: vi.fn() });
    await store.load(); await store.mutateConfig(tasks => { tasks.push(task()); });
    let persisted: unknown;
    const run = vi.fn(async () => { persisted = JSON.parse(await readFile(file, 'utf8')); return done; });
    const { scheduler } = setup([], { store, run }); await scheduler.start({ interrupted: [] });
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
  expect(store.get('once')?.state).toBe('finished'); expect(store.get('repeat')).toMatchObject({ state: 'paused', pausedReason: 'failures', counts: { consecutiveFailures: 10 } });
  expect(notifyAutoPause).toHaveBeenCalledTimes(1); expect(run).not.toHaveBeenCalled();
  expect(scheduler.runNow('once')).toBe('started'); await flush(); expect(run).toHaveBeenCalledTimes(1);
});
it('pauses on ten counted failures and notifies only once', async () => {
  const run = vi.fn(async (): Promise<ScheduledOutcome> => ({ status: 'failed', error: 'broken', counts: true, durationMs: 1 }));
  const { scheduler, store, notifyAutoPause } = setup(undefined, { run }); await scheduler.start({ interrupted: [] });
  for (let i = 1; i <= 11; i++) await tick(scheduler, A + i * MIN);
  expect(run).toHaveBeenCalledTimes(10); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  expect(store.get('st_test')).toMatchObject({ state: 'paused', pausedReason: 'failures', counts: { consecutiveFailures: 10 } });
  expect(store.get('st_test')?.revision).not.toBe('old');
});
it.each<ScheduledOutcome>([done, { status: 'failed', error: 'offline', counts: false, durationMs: 0 }, { status: 'interrupted', by: 'shutdown' }, { status: 'interrupted', by: 'user' }])('settles failure streak for $status $by', async outcome => {
  const t = task(); t.counts.consecutiveFailures = 4;
  const { scheduler, store } = setup([t], { run: async () => outcome }); await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN);
  expect(store.get(t.id)?.counts).toMatchObject({ runs: 1, consecutiveFailures: outcome.status === 'done' ? 0 : 4 });
});
it.each([false, true])('retries pending pause notices until success or 24h expiry: %s', async expired => {
  const t = task({ state: 'paused', pausedReason: 'failures', noticePending: true }); t.counts.consecutiveFailures = 10;
  const notifyAutoPause = vi.fn(async (): Promise<void> => { throw new Error('offline'); });
  const { scheduler, store } = setup([t], { notifyAutoPause }); await scheduler.start({ interrupted: [] }); await flush();
  expect(store.get(t.id)?.noticePending).toBe(true); const calls = notifyAutoPause.mock.calls.length;
  notifyAutoPause.mockResolvedValueOnce(undefined); await tick(scheduler, A + (expired ? 25 * HOUR : MIN));
  expect(notifyAutoPause).toHaveBeenCalledTimes(calls + (expired ? 0 : 1));
  if (!expired) expect(store.get(t.id)?.noticePending).toBeUndefined();
});
it.each(['unchanged', 'edited', 'paused', 'interrupted'])('settles once tasks: %s', async mode => {
  const pending = deferred(), t = task({ spec: { kind: 'once', at: A + MIN } });
  const { scheduler, store } = setup([t], { run: () => pending.promise }); await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN);
  if (mode === 'edited' || mode === 'paused') await store.mutateConfig((tasks, touch) => { for (const t of tasks) { if (mode === 'edited') t.spec = { kind: 'once', at: A + 21 * MIN }; else { t.state = 'paused'; t.pausedReason = 'unavailable'; } touch(t); } });
  pending.resolve(mode === 'interrupted' ? { status: 'interrupted', by: 'user' } : done); await flush();
  expect(store.get(t.id)?.state).toBe(mode === 'edited' ? 'active' : mode === 'paused' ? 'paused' : 'finished');
  if (mode === 'edited') { expect(nextSlotAfter(store.get(t.id)!.spec, t.timeZone, A + MIN)).toBe(A + 21 * MIN); await tick(scheduler, A + 21 * MIN); expect(store.get(t.id)?.cursor).toBe(A + 21 * MIN); }
});
it('manual runs preserve the cursor, accept paused tasks, and reject duplicate claims', async () => {
  const pending = deferred(), { scheduler, store, run } = setup([task({ state: 'paused' })], { run: vi.fn(() => pending.promise) });
  expect(scheduler.runNow('st_test')).toBe('not-started'); await scheduler.start({ interrupted: [] });
  expect(scheduler.runNow('missing')).toBe('not-found'); expect(scheduler.runNow('st_test')).toBe('started'); await flush();
  expect(scheduler.runNow('st_test')).toBe('running'); expect(run).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'manual', slot: A }));
  expect(store.get('st_test')?.cursor).toBe(A); expect(nextSlotAfter(store.get('st_test')!.spec, 'Asia/Shanghai', A)).toBe(A + MIN); pending.resolve(done); await flush();
});
it('coalesces concurrent wake calls into one claim', async () => {
  const { scheduler, run, store } = setup(); const original = store.mutateRuntime; let claims = 0;
  store.mutateRuntime = fn => original(tasks => { const before = tasks.filter(t => t.inflight).length; const value = fn(tasks); claims += Math.max(0, tasks.filter(t => t.inflight).length - before); return value; });
  await scheduler.start({ interrupted: [] });
  vi.setSystemTime(A + MIN); scheduler.wake(); scheduler.wake(); scheduler.wake(); await flush();
  expect(run).toHaveBeenCalledTimes(1); expect(store.get('st_test')?.counts.runs).toBe(1); expect(claims).toBe(1);
});
it('rechecks the cursor inside the claim mutation', async () => {
  const store = memory([task()]), original = store.mutateRuntime; let race = true;
  store.mutateRuntime = fn => original(tasks => { if (race && Date.now() > A) { race = false; for (const t of tasks) t.cursor = Date.now(); } return fn(tasks); });
  const { scheduler, run } = setup([], { store }); await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN); expect(run).not.toHaveBeenCalled();
});
it('limits concurrent runs and spaces starts two seconds apart', async () => {
  const pending = deferred(), run = vi.fn(() => pending.promise);
  const { scheduler } = setup(['a', 'b', 'c'].map(id => task({ id })), { run }); await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN);
  expect(run).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(2); pending.resolve(done); await flush();
  await vi.advanceTimersByTimeAsync(2000); expect(run).toHaveBeenCalledTimes(3);
});
it('replaces a queued slot without double-counting it as missed or skipped', async () => {
  const pending = deferred(), run = vi.fn((job: ScheduledJob) => job.task.id === 'a' ? pending.promise : Promise.resolve(done));
  const { scheduler, store } = setup([task({ id: 'a', spec: { kind: 'once', at: A + MIN } }), task({ id: 'b' })], { run, maxInflight: () => 1 });
  await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN); await tick(scheduler, A + 2 * MIN);
  expect(store.get('b')).toMatchObject({ counts: { missed: 1, skipped: 0 } });
  expect(store.get('b')?.recent).toContainEqual(expect.objectContaining({ status: 'missed', slot: A + MIN, count: 1 }));
  pending.resolve(done); await flush(); await vi.advanceTimersByTimeAsync(2000);
  expect(run.mock.calls.filter(([job]) => job.task.id === 'b')).toHaveLength(1);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ slot: A + 2 * MIN })); expect(store.get('b')?.counts.missed).toBe(1);
});
it.each<ReturnType<Parameters<typeof createScheduler>[0]['gate']>>(['disabled', 'updating', 'held', 'tier-unavailable', 'unbound'])('handles gate %s', async gate => {
  const { scheduler, store, run, notifyGateFailure, notifyAutoPause } = setup(undefined, { gate: () => gate });
  await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN); const failed = gate === 'tier-unavailable' || gate === 'unbound';
  expect(run).not.toHaveBeenCalled(); expect(notifyAutoPause).not.toHaveBeenCalled();
  expect(notifyGateFailure).toHaveBeenCalledTimes(gate === 'tier-unavailable' ? 1 : 0);
  expect(store.get('st_test')?.counts).toMatchObject({ consecutiveFailures: failed ? 1 : 0, skipped: failed ? 0 : 1 });
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining(failed ? { status: 'failed' } : { status: 'skipped', reason: gate }));
});
it.each([false, true])('stops claiming and drains with bounded wait; timeout: %s', async timeout => {
  const pending = deferred(), { scheduler, run, store } = setup(undefined, { run: vi.fn(() => pending.promise) });
  await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN); scheduler.stop(); await tick(scheduler, A + 2 * MIN);
  expect(run).toHaveBeenCalledTimes(1); let drained = false; const draining = scheduler.drain(5000).then(() => { drained = true; });
  await flush(); expect(drained).toBe(false);
  if (timeout) await vi.advanceTimersByTimeAsync(5000); else { pending.resolve(done); await flush(); }
  await draining; expect(drained).toBe(true); if (!timeout) expect(store.get('st_test')?.counts.runs).toBe(1);
});

it('sends one auto-pause notice when store changes wake a tick during settlement', async () => {
  const t = task(); t.counts.consecutiveFailures = 9;
  const pending = deferred(), notifyAutoPause = vi.fn(async () => { await pending.promise; });
  const store = memory([t], true), { scheduler } = setup([], { store, notifyAutoPause,
    run: async () => ({ status: 'failed', error: 'broken', counts: true, durationMs: 1 }) });
  await scheduler.start({ interrupted: [] }); await tick(scheduler, A + MIN);
  expect(store.get(t.id)?.state).toBe('paused'); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  scheduler.wake(); scheduler.wake(); await flush(); expect(notifyAutoPause).toHaveBeenCalledTimes(1);
  pending.resolve(done); await flush(); expect(store.get(t.id)?.noticePending).toBeUndefined();
  expect(notifyAutoPause).toHaveBeenCalledTimes(1);
});
it('does not launch a claimed run when stop occurs before claim persistence completes', async () => {
  const pending = deferred(); let writing = false;
  const store = memory([task()], false, async () => { if (!writing && Date.now() > A) { writing = true; await pending.promise; } });
  const { scheduler, run } = setup([], { store }); await scheduler.start({ interrupted: [] });
  await tick(scheduler, A + MIN); expect(writing).toBe(true); expect(store.get('st_test')?.inflight).toBeUndefined();
  scheduler.stop(); pending.resolve(done); await flush(); await scheduler.drain(5000);
  expect(run).not.toHaveBeenCalled(); expect(store.get('st_test')?.inflight).toBeUndefined();
  expect(store.get('st_test')?.recent).toContainEqual(expect.objectContaining({ status: 'interrupted', by: 'shutdown' }));
});
it.each(['cursor', 'configuration'])('drops a queued claim when %s changes during a later notification', async change => {
  const pending = deferred(), notifyAutoPause = vi.fn(async () => { await pending.promise; });
  const store = memory([task({ id: 'due' }), task({ id: 'notice', state: 'paused', pausedReason: 'failures', noticePending: true })]);
  const { scheduler, run } = setup([], { store, notifyAutoPause });
  const starting = scheduler.start({ interrupted: [] }); await flush();
  pending.resolve(done); await starting; await flush();
  const blocked = deferred(); notifyAutoPause.mockImplementation(async () => { await blocked.promise; });
  await store.mutateRuntime(tasks => { const notice = tasks.find(t => t.id === 'notice'); if (notice) notice.noticePending = true; });
  await tick(scheduler, A + MIN); expect(notifyAutoPause).toHaveBeenCalledTimes(2);
  if (change === 'cursor') await store.mutateRuntime(tasks => { const due = tasks.find(t => t.id === 'due'); if (due) due.cursor = A + MIN; });
  else await store.mutateConfig((tasks, touch) => { const due = tasks.find(t => t.id === 'due'); if (due) { due.spec = { kind: 'once', at: A + HOUR }; touch(due); } });
  blocked.resolve(done); await flush(); expect(run).not.toHaveBeenCalled();
});
