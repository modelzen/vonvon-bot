import { randomBytes } from 'node:crypto';
import { scheduleRunRecordSchema } from '@vonvon/protocol';
import type { log } from '../../core/logger';
import type { ScheduleDiagnosticEvent } from '../diagnostics';
import { clampUnits, type ScheduleStore } from './store';
import type { StoredTask, ScheduledJob, ScheduledOutcome } from './types';
import { countSlotsBetween, latestSlotWithin, nextSlotAfter } from './time';

type Gate = 'ok' | 'disabled' | 'updating' | 'held' | 'unbound' | 'tier-unavailable' | 'admin-removed';
type SkipGate = 'disabled' | 'updating' | 'held';
type FailGate = 'unbound' | 'tier-unavailable' | 'admin-removed';
/** Why a launch is refused: what the gate said, or 'gate-error' when the gate itself threw. */
type Refusal = Exclude<Gate, 'ok'> | 'gate-error';
type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
type RunRecord = StoredTask['recent'][number];
type Trigger = RunRecord['trigger'];
type Outcome = ScheduledOutcome | { status: 'interrupted'; by: 'crash' };
type Touch = (task: StoredTask) => void;
/** What a run record needs from the run itself; `inflight` has exactly these fields. */
type RunStart = { runId: string; slot: number; trigger: Trigger; startedAt: number };
type ManualRun = { slot: number; runId: string };

export type RunNowResult = { kind: 'started'; runId: string } | { kind: 'running' } | { kind: 'not-found' } | { kind: 'not-started' };

export interface Scheduler {
  /** Records every run left in `loaded.interrupted` as a crash, then kicks off the first tick without waiting for it. */
  start(loaded: { interrupted: StoredTask[] }): Promise<void>;
  stop(): void;
  drain(ms: number): Promise<void>;
  wake(): void;
  runNow(taskId: string): RunNowResult;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
const WINDOW_MS = 7 * DAY;            // only the latest slot of the last 7 days is caught up
const TICK_MS = 30_000;
const SPACING_MS = 2_000;             // between two launches
const LATE_MS = MINUTE;               // a slot started this late is a catch-up
const NOTICE_TIMEOUT_MS = 15_000;     // an auto-pause notice that takes longer counts as not sent
const PAUSE_AFTER_FAILURES = 10;
const MISSED_CAP = 10_000;            // a stored missed count of 10000 reads "10000+"
const MAX_ERROR_UNITS = 200;          // scheduleRunRecordSchema.error
const MAX_EXCERPT_UNITS = 500;        // lastResult.excerpt
const GATE_ERRORS: Record<FailGate | 'gate-error', string> = {
  unbound: '群已解绑', 'tier-unavailable': '权限档现在用不了', 'admin-removed': '创建人已不是管理员', 'gate-error': '运行前检查出错',
};
const INVALID_OUTCOME = '运行结果无效';
const SKIP_REASONS: readonly string[] = ['disabled', 'updating', 'held'] satisfies SkipGate[];
const INTERRUPTED_BY: readonly string[] = ['shutdown', 'user'];       // what a runner may say; 'crash' is the scheduler's own
/** The prefix of the error the store throws when it refuses a draft that load() would quarantine (store.ts mutate). */
const STORE_REFUSED = 'schedule store refused an invalid write';

/** Thrown inside a runtime write whose task turns out to need a state change; the write is redone as a config write. */
class NeedsConfigWrite extends Error {}

/** One attempt at a store write: the draft tasks, `touch` only on a config write, and diagnostics to emit after the commit. */
type Draft = { tasks: StoredTask[]; touch: Touch | undefined; events: ScheduleDiagnosticEvent[] };

const isSkipGate = (gate: Gate | 'gate-error'): gate is SkipGate => gate === 'disabled' || gate === 'updating' || gate === 'held';
const pausedForFailures = (task: StoredTask): boolean => task.state === 'paused' && task.pausedReason === 'failures';
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** The schema's own url check: a link it refuses would make the store refuse the whole settle. */
const isLink = (value: unknown): value is string => nonEmpty(value) && scheduleRunRecordSchema.shape.link.safeParse(value).success;
const refusedByStore = (error: unknown): boolean => error instanceof Error && error.message.startsWith(STORE_REFUSED);

/**
 * What run() handed back, made total: a value outside ScheduledOutcome would otherwise make every settle attempt
 * throw or be refused, and keep the task's `inflight` (so the task itself) stuck until a restart.
 */
function checkedOutcome(value: unknown, durationMs: number): ScheduledOutcome {
  const invalid: ScheduledOutcome = { status: 'failed', error: INVALID_OUTCOME, durationMs, counts: true };
  if (!value || typeof value !== 'object') return invalid;
  const outcome = value as ScheduledOutcome;
  switch (outcome.status) {
    case 'done': return { ...outcome, excerpt: String(outcome.excerpt ?? '') };
    case 'failed': return { ...outcome, error: String(outcome.error) }; // throws for an unprintable error: outcomeOf records it as failed
    case 'skipped': return SKIP_REASONS.includes(outcome.reason) ? outcome : { ...outcome, reason: 'updating' };
    case 'interrupted': return INTERRUPTED_BY.includes(outcome.by) ? outcome : { ...outcome, by: 'shutdown' };
    default: return invalid;
  }
}

/** The run as a counted failure, for an outcome the store refused to record. */
function invalidOutcome(outcome: Outcome): ScheduledOutcome {
  const durationMs = 'durationMs' in outcome && Number.isFinite(outcome.durationMs) ? outcome.durationMs : 0;
  return { status: 'failed', error: INVALID_OUTCOME, durationMs, counts: true };
}

function printable(error: unknown): string {
  try { return String(error); } catch { return INVALID_OUTCOME; }
}

function clearNotice(task: StoredTask): void {
  delete task.noticePending;
  delete task.noticeSince;
}

/** Whether a counted failure of `job` leaves a scheduled run to come: a scheduled run (not a manual one) of an active task
 * with a next slot, short of the auto-pause. A network failure's card says so, from the task as the store has it then. */
export function nextRunAfterFailure(job: ScheduledJob): boolean {
  const { task } = job;
  if (job.trigger === 'manual' || task.state !== 'active' || task.counts.consecutiveFailures + 1 >= PAUSE_AFTER_FAILURES) return false;
  try { return nextSlotAfter(task.spec, task.timeZone, task.cursor) !== undefined; } catch { return false; }
}

export function createScheduler(deps: {
  acquireTask?:(task:StoredTask)=>(()=>void);
  store: ScheduleStore; now: () => number; timers: Timers;
  run: (job: ScheduledJob) => Promise<ScheduledOutcome>;
  gate: (chatId: string, task: Pick<StoredTask, 'createdBy'>) => Gate;
  notifyAutoPause: (task: StoredTask) => Promise<void>;
  notifyGateFailure: (task: StoredTask) => void;
  maxInflight: () => number; log: typeof log; diagnostics: (event: ScheduleDiagnosticEvent) => void;
}): Scheduler {
  const { store, now, timers } = deps;
  /** Due scheduled tasks waiting for a free slot or for the launch spacing. */
  const pending = new Map<string, { slot: number; order: number; revision: string }>();
  /** Accepted manual runs not claimed yet; `runId` is the one runNow returned. */
  const manual = new Map<string, ManualRun>();
  /** runIds whose run() has not returned. This, not the persisted `inflight`, is what maxInflight limits. */
  const executing = new Set<string>();
  /** Outcomes whose settle write failed, by runId. Retried at every tick and in drain(); `inflight` stays until then. */
  const unsettled = new Map<string, { taskId: string; outcome: Outcome }>();
  /** Task ids with an auto-pause notice in flight, and the sends themselves for drain(). */
  const noticing = new Set<string>();
  const notices = new Set<Promise<void>>();
  /** By task id: the auto-pause (noticeSince) and time of the last notifyAutoPause call, for one send per 30 seconds. */
  const noticeTried = new Map<string, { since: number; at: number }>();
  /** By task id: the noticeSince whose notice was delivered and only waits for its clearing write. */
  const noticeSent = new Map<string, number>();
  /** The 15-second timers of notices in flight; stop() clears them, so nothing is reported after shutdown. */
  const noticeTimeouts = new Set<ReturnType<typeof setTimeout>>();
  /** Launched runs, through their settle. */
  const working = new Set<Promise<void>>();
  const nextCache = new Map<string, { revision: string; cursor: number; next: number | undefined }>();
  let starting = false, started = false, stopping = false;
  let again = false;      // set while a tick runs: run another pass right after it
  let backoff = false;    // the last tick or a claim failed: wait the full 30 seconds
  let ticking: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastLaunch = -Infinity;

  const newId = (): string => randomBytes(8).toString('hex');
  const event = (kind: ScheduleDiagnosticEvent['kind'], task: StoredTask, count?: number): ScheduleDiagnosticEvent => (
    { kind, taskId: task.id, ...(count === undefined ? {} : { count }) }
  );
  const triggerFor = (slot: number): Trigger => (now() - slot >= LATE_MS ? 'catchUp' : 'schedule');

  /** A throwing diagnostics sink is logged, never passed on: a committed write must still reach its caller. */
  function emit(item: ScheduleDiagnosticEvent): void {
    try {
      deps.diagnostics(item);
    } catch (error) {
      deps.log.fail('schedule', error, { phase: 'diagnostics', taskId: item.taskId });
    }
  }

  function forgetNotice(taskId: string): void {
    noticeTried.delete(taskId);
    noticeSent.delete(taskId);
  }

  function capacity(): number {
    const limit = deps.maxInflight();
    return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  }

  /** Milliseconds until the 2-second launch spacing allows the next launch; 0 when it does now. */
  function spacingLeft(): number {
    const since = now() - lastLaunch;
    return since >= 0 && since < SPACING_MS ? SPACING_MS - since : 0;
  }

  function next(task: StoredTask): number | undefined {
    const cached = nextCache.get(task.id);
    if (cached && cached.revision === task.revision && cached.cursor === task.cursor) return cached.next;
    const value = nextSlotAfter(task.spec, task.timeZone, task.cursor);
    nextCache.set(task.id, { revision: task.revision, cursor: task.cursor, next: value });
    return value;
  }

  // ---- store writes ----

  /**
   * Bookkeeping goes through mutateRuntime, which keeps the revision. Only when the draft needs a state change
   * (auto-pause, finished) is the write redone through mutateConfig, which can touch. A store callback that throws
   * leaves memory and the file as they were, so the discarded first attempt leaves no trace.
   */
  async function write<T>(fn: (draft: Draft) => T): Promise<T> {
    let events: ScheduleDiagnosticEvent[] = [];
    let result: T;
    try {
      result = await store.mutateRuntime(tasks => {
        events = [];
        return fn({ tasks, touch: undefined, events });
      });
    } catch (error) {
      if (!(error instanceof NeedsConfigWrite)) throw error;
      result = await store.mutateConfig((tasks, touch) => {
        events = [];
        return fn({ tasks, touch, events });
      });
    }
    for (const item of events) emit(item);
    return result;
  }

  function changeState(draft: Draft, task: StoredTask, change: () => void): void {
    if (!draft.touch) throw new NeedsConfigWrite();
    change();
    draft.touch(task);
  }

  /** The draft's copy of `seen`, if it is still active with the revision and cursor the decision was made on. */
  function unchanged(draft: Draft, seen: StoredTask): StoredTask | undefined {
    const current = draft.tasks.find(task => task.id === seen.id);
    if (!current || current.state !== 'active') return undefined;
    if (current.revision !== seen.revision || current.cursor !== seen.cursor) return undefined;
    return current;
  }

  // ---- what a write records ----

  function recordMissed(draft: Draft, task: StoredTask, slot: number, count: number): void {
    if (count <= 0) return;
    task.counts.missed += count;
    task.recent.push({ runId: newId(), slot, trigger: 'schedule', status: 'missed', count });
    draft.events.push(event('schedule-missed', task, count));
  }

  /** One merged missed record for the slots after the cursor and before `slot`. Call it before moving the cursor. */
  function recordMissedBefore(draft: Draft, task: StoredTask, slot: number): void {
    // Cap one higher so that, after leaving out `slot` itself, a capped count still reads 10000 ("10000+").
    const count = countSlotsBetween(task.spec, task.timeZone, task.cursor, slot, MISSED_CAP + 1) - 1;
    recordMissed(draft, task, next(task) ?? slot, count);
  }

  /** A once task whose slot is behind the cursor is finished, unless it was paused meanwhile. */
  function finishIfDone(draft: Draft, task: StoredTask): void {
    if (task.state !== 'active' || task.spec.kind !== 'once') return;
    if (nextSlotAfter(task.spec, task.timeZone, task.cursor) !== undefined) return;
    changeState(draft, task, () => { task.state = 'finished'; });
  }

  /**
   * Picks the scheduleRunRecordSchema fields one by one, so whatever a runner returns (made total by checkedOutcome)
   * can be read back by load().
   */
  function runRecord(run: RunStart, endedAt: number, outcome: Outcome): RunRecord {
    const record: RunRecord = {
      runId: run.runId, slot: run.slot, trigger: run.trigger, status: outcome.status, startedAt: run.startedAt, endedAt,
    };
    if ('durationMs' in outcome && Number.isFinite(outcome.durationMs)) record.durationMs = Math.max(0, Math.round(outcome.durationMs));
    if ('messageId' in outcome && nonEmpty(outcome.messageId)) record.messageId = outcome.messageId;
    if ('topicId' in outcome && nonEmpty(outcome.topicId)) record.topicId = outcome.topicId;
    if ('link' in outcome && isLink(outcome.link)) record.link = outcome.link;
    if (outcome.status === 'failed') record.error = clampUnits(String(outcome.error), MAX_ERROR_UNITS);
    if (outcome.status === 'skipped') record.reason = outcome.reason;
    if (outcome.status === 'interrupted') record.by = outcome.by;
    return record;
  }

  function lastResultOf(record: RunRecord, outcome: Outcome): NonNullable<StoredTask['lastResult']> {
    let excerpt = '';
    if (outcome.status === 'done') excerpt = outcome.excerpt;
    if (outcome.status === 'failed') excerpt = `失败：${record.error ?? ''}`;
    return {
      at: record.endedAt ?? now(),
      status: outcome.status,
      excerpt: clampUnits(excerpt, MAX_EXCERPT_UNITS),
      ...(record.messageId ? { messageId: record.messageId } : {}),
      ...(record.link ? { link: record.link } : {}),
    };
  }

  /** Records a run that has ended: the run record, counts, lastResult, then auto-pause and once finishing. */
  function applyOutcome(draft: Draft, task: StoredTask, run: RunStart, outcome: Outcome): void {
    const record = runRecord(run, now(), outcome);
    task.recent.push(record);
    if (outcome.status === 'skipped') {
      task.counts.skipped++;
      draft.events.push(event('schedule-skipped', task));
    } else {
      task.counts.runs++;
    }
    if (outcome.status === 'done') task.counts.consecutiveFailures = 0;
    const countsAsFailure = (outcome.status === 'failed' && outcome.counts) || (outcome.status === 'interrupted' && outcome.by === 'crash');
    if (countsAsFailure) task.counts.consecutiveFailures++;
    if (outcome.status === 'interrupted' && outcome.by === 'crash') draft.events.push(event('schedule-interrupted', task));
    task.lastResult = lastResultOf(record, outcome);
    // A paused or finished task keeps counting but keeps its state, and nobody is told.
    if (task.state === 'active' && task.counts.consecutiveFailures >= PAUSE_AFTER_FAILURES) {
      changeState(draft, task, () => {
        task.state = 'paused';
        task.pausedReason = 'failures';
        task.noticePending = true;
        task.noticeSince = record.endedAt ?? now();
      });
      draft.events.push(event('schedule-auto-paused', task));
    }
    finishIfDone(draft, task);
  }

  const gateFailure = (gate: FailGate | 'gate-error'): ScheduledOutcome => ({ status: 'failed', error: GATE_ERRORS[gate], durationMs: 0, counts: true });

  function notifyGateFailure(task: StoredTask): void {
    try {
      deps.notifyGateFailure(task);
    } catch (error) {
      deps.log.fail('schedule', error, { phase: 'gate-notice', taskId: task.id });
    }
  }

  // ---- settling ----

  async function settle(taskId: string, runId: string, outcome: Outcome): Promise<void> {
    await write(draft => {
      const task = draft.tasks.find(t => t.id === taskId);
      const flight = task?.inflight;
      if (!task || !flight || flight.runId !== runId) return; // deleted, or settled already
      delete task.inflight;
      applyOutcome(draft, task, flight, outcome);
    });
  }

  /** Settles the run; a write that fails is kept in `unsettled` and tried again by the next tick and drain(). */
  async function settleOrKeep(taskId: string, runId: string, outcome: Outcome, phase = 'settle'): Promise<void> {
    let attempt = outcome;
    try {
      try {
        await settle(taskId, runId, attempt);
      } catch (error) {
        // The store refusing the draft is not a disk error: it would refuse every retry, and inflight would stay.
        if (!refusedByStore(error)) throw error;
        deps.log.fail('schedule', error, { phase: 'settle-invalid', taskId });
        attempt = invalidOutcome(attempt);
        await settle(taskId, runId, attempt);
      }
      unsettled.delete(runId);
    } catch (error) {
      unsettled.set(runId, { taskId, outcome: attempt });
      deps.log.fail('schedule', error, { phase, taskId });
    }
  }

  async function retryUnsettled(): Promise<void> {
    for (const [runId, { taskId, outcome }] of [...unsettled]) await settleOrKeep(taskId, runId, outcome, 'settle-retry');
  }

  // ---- auto-pause notices ----

  /** Resolves true when `work` resolves within `ms`, false when it takes longer; a rejection passes through. */
  async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>(resolve => {
      timeout = timers.setTimeout(() => resolve(false), ms);
      noticeTimeouts.add(timeout);
    });
    try {
      return await Promise.race([work.then(() => true), expired]);
    } finally {
      timers.clearTimeout(timeout);
      if (timeout !== undefined) noticeTimeouts.delete(timeout);
    }
  }

  function clearNoticeTimeouts(): void {
    for (const timeout of noticeTimeouts) timers.clearTimeout(timeout);
    noticeTimeouts.clear();
  }

  /** Clears the notice of the auto-pause at `since`; a newer auto-pause has its own noticeSince and keeps its notice. */
  async function clearNoticeSince(taskId: string, since: number | undefined): Promise<void> {
    await store.mutateRuntime(tasks => {
      const current = tasks.find(t => t.id === taskId);
      if (current?.noticePending && current.noticeSince === since) clearNotice(current);
    });
    forgetNotice(taskId);
  }

  async function sendNotice(taskId: string): Promise<void> {
    const task = store.get(taskId);
    if (!task?.noticePending) {
      forgetNotice(taskId);
      return;
    }
    if (!pausedForFailures(task)) {
      // Resumed, edited or paused for another reason since the auto-pause: the notice no longer applies.
      await store.mutateRuntime(tasks => {
        const current = tasks.find(t => t.id === taskId);
        if (current && !pausedForFailures(current)) clearNotice(current);
      });
      forgetNotice(taskId);
      return;
    }
    const since = task.noticeSince;
    if (since === undefined || now() - since >= DAY) {
      // Retried for 24 hours, then given up; one with no auto-pause time to count from is given up at once.
      await clearNoticeSince(taskId, since);
      return;
    }
    if (noticeSent.get(taskId) !== since) {
      // At most one send per 30 seconds, however many passes the store's writes wake; a newer auto-pause does not wait.
      const tried = noticeTried.get(taskId);
      const elapsed = tried ? now() - tried.at : -1;
      if (tried?.since === since && elapsed >= 0 && elapsed < TICK_MS) return;
      noticeTried.set(taskId, { since, at: now() });
      const sent = await within(NOTICE_TIMEOUT_MS, Promise.resolve().then(() => deps.notifyAutoPause(task)));
      if (!sent) {
        if (!stopping) emit(event('schedule-notice-pending', task));
        return;
      }
      // Delivered: if the clearing write fails, later passes retry only the write, never the message.
      noticeSent.set(taskId, since);
    }
    await clearNoticeSince(taskId, since);
  }

  /** Starts the task's pending notice without waiting for it; one send per task at a time. */
  function startNotice(task: StoredTask): void {
    if (!task.noticePending) {
      forgetNotice(task.id);
      return;
    }
    if (noticing.has(task.id)) return;
    noticing.add(task.id);
    const sending: Promise<void> = sendNotice(task.id)
      .catch(error => {
        if (!stopping) emit(event('schedule-notice-pending', task));
        deps.log.fail('schedule', error, { phase: 'notice', taskId: task.id });
      })
      .finally(() => {
        noticing.delete(task.id);
        notices.delete(sending);
      });
    notices.add(sending);
  }

  // ---- the decision for one task (overview section 6, steps 1 to 5) ----

  /** Every slot since the cursor is older than the window: one missed record, nothing runs. */
  async function recordStale(task: StoredTask, due: number): Promise<void> {
    await write(draft => {
      const current = unchanged(draft, task);
      if (!current) return;
      const at = now();
      recordMissed(draft, current, due, countSlotsBetween(current.spec, current.timeZone, current.cursor, at, MISSED_CAP));
      current.cursor = at;
      finishIfDone(draft, current);
    });
  }

  /**
   * Skips `slot`: one skipped record, the missed ones before it merged, the cursor moves on. For 'running' the
   * inflight is read again inside the write; a run that has settled meanwhile is not recorded as running.
   */
  async function skipSlot(task: StoredTask, slot: number, reason: SkipGate | 'running'): Promise<'skipped' | 'settled' | 'stale'> {
    return write(draft => {
      const current = unchanged(draft, task);
      if (!current) return 'stale';
      if (reason === 'running' && !current.inflight) return 'settled';
      recordMissedBefore(draft, current, slot);
      current.cursor = slot;
      current.recent.push({ runId: newId(), slot, trigger: triggerFor(slot), status: 'skipped', reason });
      current.counts.skipped++;
      draft.events.push(event('schedule-skipped', current));
      finishIfDone(draft, current);
      return 'skipped';
    });
  }

  /**
   * The gate refuses `slot` outright (unbound, tier unavailable, creator removed): a counted failed run, the cursor moves
   * on. The removal pauses a private chat's tasks itself and only logs a failure to (dm-agent 3.3), and a Bot that was
   * stopped never heard of it: a task that gets here pauses now, in the same words, and nobody is told.
   */
  async function failSlot(task: StoredTask, slot: number, gate: FailGate): Promise<void> {
    const failed = await write(draft => {
      const current = unchanged(draft, task);
      if (!current) return undefined;
      recordMissedBefore(draft, current, slot);
      current.cursor = slot;
      if (gate === 'admin-removed') changeState(draft, current, () => { current.state = 'paused'; current.pausedReason = 'admin-removed'; });
      applyOutcome(draft, current, { runId: newId(), slot, trigger: triggerFor(slot), startedAt: now() }, gateFailure(gate));
      return structuredClone(current);
    });
    if (failed && gate === 'tier-unavailable') notifyGateFailure(failed);
  }

  async function closeSlot(task: StoredTask, slot: number, gate: Exclude<Gate, 'ok'>): Promise<void> {
    if (isSkipGate(gate)) await skipSlot(task, slot, gate);
    else await failSlot(task, slot, gate);
  }

  /** A newer slot replaces the queued one: the missed before it merged, the replaced slot missed once, not skipped. */
  async function supersede(task: StoredTask, oldSlot: number): Promise<void> {
    await write(draft => {
      const current = unchanged(draft, task);
      if (!current || oldSlot <= current.cursor) return;
      recordMissedBefore(draft, current, oldSlot);
      recordMissed(draft, current, oldSlot, 1);
      current.cursor = oldSlot;
    });
  }

  /** Records what a due task's slot comes to; returns the slot when it is to be claimed. */
  async function decide(task: StoredTask): Promise<{ due: number; latest: number } | undefined> {
    if (task.state !== 'active') return undefined;
    const due = next(task);
    if (due === undefined || due > now()) return undefined;
    const latest = latestSlotWithin(task.spec, task.timeZone, now(), WINDOW_MS);
    if (latest === undefined) {
      await recordStale(task, due);
      return undefined;
    }
    if (latest <= task.cursor) return undefined;
    // The gate comes before the running check: a refused slot is recorded as refused even while a run is on.
    const gate = deps.gate(task.chatId, task);
    if (gate !== 'ok') {
      await closeSlot(task, latest, gate);
      return undefined;
    }
    if (task.inflight) {
      if (await skipSlot(task, latest, 'running') === 'settled') again = true; // look again: now it can be claimed
      return undefined;
    }
    return { due, latest };
  }

  async function consider(task: StoredTask): Promise<void> {
    startNotice(task);
    const slots = await decide(task);
    if (!slots) {
      pending.delete(task.id);
      return;
    }
    const queued = pending.get(task.id);
    if (queued && queued.revision === task.revision && queued.slot < slots.latest) await supersede(task, queued.slot);
    pending.set(task.id, { slot: slots.latest, order: queued?.order ?? slots.due, revision: task.revision });
  }

  // ---- claiming and running ----

  async function outcomeOf(job: ScheduledJob): Promise<ScheduledOutcome> {
    if (stopping) return { status: 'interrupted', by: 'shutdown' };
    const startedAt = now();
    try {
      const outcome: unknown = await deps.run(job);
      return checkedOutcome(outcome, now() - startedAt);
    } catch (error) {
      return { status: 'failed', error: printable(error), durationMs: now() - startedAt, counts: true };
    }
  }

  async function execute(job: ScheduledJob): Promise<void> {
    const outcome = await outcomeOf(job);
    executing.delete(job.runId);
    await settleOrKeep(job.task.id, job.runId, outcome);
  }

  function track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch(error => deps.log.fail('schedule', error, { phase: 'run' }))
      .finally(() => {
        working.delete(tracked);
        scheduler.wake();
      });
    working.add(tracked);
  }

  /** Writes `inflight` (and, for a scheduled slot, the cursor) in one write; run() is called only after it is on disk. */
  async function claim(task: StoredTask, slot: number, runId: string, trigger: Trigger): Promise<void> {
    const release=deps.acquireTask?.(task);
    let launched=false;
    try {
    const isManual = trigger === 'manual';
    const job = await write((draft): ScheduledJob | undefined => {
      const current = draft.tasks.find(t => t.id === task.id);
      if (stopping || !current || current.inflight) return undefined;
      if (current.revision !== task.revision || current.cursor !== task.cursor) return undefined;
      if (!isManual) {
        if (current.state !== 'active' || slot <= current.cursor) return undefined;
        recordMissedBefore(draft, current, slot);
        current.cursor = slot;
      }
      current.inflight = { runId, slot, trigger, startedAt: now(), revision: current.revision };
      return { task: structuredClone(current), runId, slot, trigger, nth: current.counts.runs + 1, late: trigger === 'catchUp' };
    });
    if (!job) {
      if (!stopping) again = true; // someone else changed the task first; decide again on the fresh copy
      return;
    }
    if (isManual && manual.get(task.id)?.runId === runId) manual.delete(task.id);
    lastLaunch = now();
    executing.add(runId);
    track(execute(job).finally(()=>release?.()));launched=true;
    } finally {if(!launched)release?.();}
  }

  /** A manual run the gate refuses: recorded like a run that ended at once (skipped, or a counted failure). */
  async function refuseManual(task: StoredTask, run: ManualRun, gate: Refusal): Promise<void> {
    const outcome: ScheduledOutcome = isSkipGate(gate) ? { status: 'skipped', reason: gate } : gateFailure(gate);
    const recorded = await write(draft => {
      const current = draft.tasks.find(t => t.id === task.id);
      if (!current) return undefined;
      applyOutcome(draft, current, { runId: run.runId, slot: run.slot, trigger: 'manual', startedAt: now() }, outcome);
      return structuredClone(current);
    });
    if (recorded && gate === 'tier-unavailable') notifyGateFailure(recorded);
  }

  /**
   * The chat's gate, or 'gate-error' when it throws. Logged here, apart from the store writes: a gate that throws for
   * one chat is that task's error, and must not set the 30-second backoff that slows every other task's launches.
   */
  function gateOf(task: StoredTask): Refusal | 'ok' {
    try {
      return deps.gate(task.chatId, task);
    } catch (error) {
      deps.log.fail('schedule', error, { phase: 'gate', taskId: task.id });
      return 'gate-error';
    }
  }

  async function launch(taskId: string, manualRun: ManualRun | undefined): Promise<void> {
    const task = store.get(taskId);
    if (manualRun) {
      if (!task) {
        manual.delete(taskId);
        return;
      }
      if (task.inflight) return; // stays queued and starts once the current run is done
      const gate = gateOf(task);
      if (gate === 'ok') {
        await claim(task, manualRun.slot, manualRun.runId, 'manual');
      } else {
        // Dequeued once the refusal is on record; a failed write leaves it queued, with its runId, for the next tick.
        await refuseManual(task, manualRun, gate);
        if (manual.get(taskId)?.runId === manualRun.runId) manual.delete(taskId);
      }
      return;
    }
    const entry = pending.get(taskId);
    pending.delete(taskId); // claimed or closed now, or decided afresh by the next pass
    if (!task || !entry || task.state !== 'active' || task.inflight) return;
    if (entry.revision !== task.revision) {
      again = true;
      return;
    }
    const gate = gateOf(task);
    if (gate === 'gate-error') return; // like a decision that throws: logged, decided afresh by the next tick
    if (gate === 'ok') await claim(task, entry.slot, newId(), triggerFor(entry.slot));
    else await closeSlot(task, entry.slot, gate);
  }

  /** Starts waiting runs in the order they came due, within the concurrency limit and the launch spacing. */
  async function launchWaiting(): Promise<void> {
    const waiting = [
      ...[...manual].map(([taskId, run]) => ({ taskId, order: run.slot, manualRun: run as ManualRun | undefined })),
      ...[...pending].filter(([taskId]) => !manual.has(taskId)).map(([taskId, entry]) => ({ taskId, order: entry.order, manualRun: undefined })),
    ].sort((a, b) => a.order - b.order);
    for (const { taskId, manualRun } of waiting) {
      if (stopping || executing.size >= capacity() || spacingLeft() > 0) return;
      try {
        await launch(taskId, manualRun && manual.get(taskId));
      } catch (error) {
        // A scheduled slot is decided afresh by the next tick; an accepted manual run stays queued for it.
        pending.delete(taskId);
        backoff = true;
        deps.log.fail('schedule', error, { phase: 'claim', taskId });
      }
    }
  }

  async function tick(): Promise<void> {
    await retryUnsettled();
    const ids = store.all().map(task => task.id);
    for (const taskId of ids) {
      if (stopping) return;
      const task = store.get(taskId); // fresh: earlier tasks' writes and settles may have landed meanwhile
      if (!task) continue;
      try {
        await consider(task);
      } catch (error) {
        pending.delete(taskId);
        deps.log.fail('schedule', error, { phase: 'tick', taskId });
      }
    }
    await launchWaiting();
    const live = new Set(ids);
    for (const taskId of nextCache.keys()) if (!live.has(taskId)) nextCache.delete(taskId);
    for (const taskId of [...noticeTried.keys(), ...noticeSent.keys()]) if (!live.has(taskId)) forgetNotice(taskId);
  }

  /** 30 seconds, unless the launch spacing is the only thing holding a waiting run back. */
  function nextDelay(): number {
    const waiting = pending.size > 0 || manual.size > 0;
    const left = spacingLeft();
    // Anything else waiting waits on capacity, which the end of a run wakes, or on a failure: no fast retry.
    if (backoff || !waiting || left === 0) return TICK_MS;
    try {
      return executing.size < capacity() ? left : TICK_MS;
    } catch {
      return TICK_MS;
    }
  }

  function scheduleTick(): void {
    if (timer) timers.clearTimeout(timer);
    timer = undefined;
    if (stopping || !started) return;
    const delay = nextDelay();
    backoff = false;
    timer = timers.setTimeout(() => {
      timer = undefined;
      scheduler.wake();
    }, delay);
  }

  const scheduler: Scheduler = {
    async start(loaded) {
      if (starting || stopping) return;
      starting = true;
      for (const task of loaded.interrupted) {
        if (task.inflight) await settleOrKeep(task.id, task.inflight.runId, { status: 'interrupted', by: 'crash' });
      }
      if (stopping) return;
      started = true;
      unsubscribe = store.onChange(() => scheduler.wake());
      scheduler.wake();
    },
    stop() {
      stopping = true;
      if (timer) timers.clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      clearNoticeTimeouts(); // drain() still waits for a notice in flight, up to its own deadline
      pending.clear();
      manual.clear();
    },
    async drain(ms) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>(resolve => { deadline = timers.setTimeout(resolve, ms); });
      const finished = (async () => {
        await ticking;
        while (working.size || notices.size) await Promise.all([...working, ...notices]);
        await retryUnsettled();
      })();
      await Promise.race([finished, expired]);
      timers.clearTimeout(deadline);
      clearNoticeTimeouts();
    },
    wake() {
      if (!started || stopping) return;
      again = true;
      if (ticking) return;
      ticking = (async () => {
        try {
          while (again && !stopping) {
            again = false;
            try {
              await tick();
            } catch (error) {
              backoff = true; // no pass right after a failed one: the next waits the full 30 seconds
              try { deps.log.fail('schedule', error, { phase: 'tick' }); } catch { /* a failing logger must not stop the loop */ }
              break;
            }
          }
        } finally {
          // In the same synchronous step as the last read of `again`: from here on a wake() starts a new pass.
          ticking = undefined;
          scheduleTick();
        }
      })();
    },
    runNow(taskId) {
      if (!started || stopping) return { kind: 'not-started' };
      const task = store.get(taskId);
      if (!task) return { kind: 'not-found' };
      if (task.inflight || manual.has(taskId)) return { kind: 'running' };
      const runId = newId();
      manual.set(taskId, { slot: now(), runId });
      scheduler.wake();
      return { kind: 'started', runId };
    },
  };
  return scheduler;
}
