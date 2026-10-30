import { randomBytes } from 'node:crypto';
import type { log } from '../../core/logger';
import type { ScheduleDiagnosticEvent } from '../diagnostics';
import type { ScheduleStore } from './store';
import type { StoredTask, ScheduledJob, ScheduledOutcome } from './types';
import { countSlotsBetween, latestSlotWithin, nextSlotAfter } from './time';

type Gate = 'ok' | 'disabled' | 'updating' | 'held' | 'unbound' | 'tier-unavailable';
type Timers = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
export interface Scheduler {
  start(loaded: { interrupted: StoredTask[] }): Promise<void>;
  stop(): void; drain(ms: number): Promise<void>; wake(): void;
  runNow(taskId: string): 'started' | 'running' | 'not-found' | 'not-started';
}
export function createScheduler(deps: {
  store: ScheduleStore; now: () => number; timers: Timers;
  run: (job: ScheduledJob) => Promise<ScheduledOutcome>;
  gate: (chatId: string) => Gate;
  notifyAutoPause: (task: StoredTask) => Promise<void>;
  notifyGateFailure: (task: StoredTask) => void;
  maxInflight: () => number; log: typeof log; diagnostics: (event: ScheduleDiagnosticEvent) => void;
}): Scheduler {
  const { store, now, timers } = deps;
  const windowMs = 7 * 86_400_000;
  const pending = new Map<string, { slot: number; order: number; revision: string }>();
  const manual = new Map<string, number>();
  const working = new Set<Promise<void>>();
  const cache = new Map<string, { revision: string; cursor: number; next: number | undefined }>();
  let started = false, stopping = false, again = false;
  let ticking: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined, lastLaunch = -Infinity;
  const id = (): string => randomBytes(8).toString('hex');
  const diagnostic = (kind: ScheduleDiagnosticEvent['kind'], task: StoredTask, count?: number): void => {
    deps.diagnostics({ kind, taskId: task.id, ...(count === undefined ? {} : { count }) });
  };
  const next = (task: StoredTask): number | undefined => {
    let entry = cache.get(task.id);
    if (!entry || entry.revision !== task.revision || entry.cursor !== task.cursor) {
      entry = { revision: task.revision, cursor: task.cursor, next: nextSlotAfter(task.spec, task.timeZone, task.cursor) };
      cache.set(task.id, entry);
    }
    return entry.next;
  };
  function recordMissed(task: StoredTask, slot: number, count: number): void {
    if (count <= 0) return;
    task.counts.missed += count;
    task.recent.push({ runId: id(), slot, trigger: 'schedule', status: 'missed', count });
    diagnostic('schedule-missed', task, count);
  }
  function finish(task: StoredTask, touch: (task: StoredTask) => void): void {
    if (task.state === 'active' && task.spec.kind === 'once' && nextSlotAfter(task.spec, task.timeZone, task.cursor) === undefined) {
      task.state = 'finished'; touch(task);
    }
  }
  async function notice(task: StoredTask): Promise<void> {
    if (!task.noticePending || now() - task.updatedAt >= 86_400_000) return;
    try {
      await deps.notifyAutoPause(task);
      await store.mutateRuntime(tasks => { const current = tasks.find(t => t.id === task.id); if (current?.updatedAt === task.updatedAt) delete current.noticePending; });
    } catch (error) {
      diagnostic('schedule-notice-pending', task); deps.log.fail('schedule', error);
    }
  }
  async function settle(taskId: string, runId: string, outcome: ScheduledOutcome | { status: 'interrupted'; by: 'crash' }): Promise<void> {
    await store.mutateConfig((tasks, touch) => {
      const task = tasks.find(t => t.id === taskId), flight = task?.inflight;
      if (!task || !flight || flight.runId !== runId) return;
      const record = { runId, slot: flight.slot, trigger: flight.trigger, startedAt: flight.startedAt, endedAt: now(), ...outcome };
      // The runner's failure-count flag is internal, never part of the stored run record.
      const { counts: _counts, excerpt: _excerpt, ...saved } = { counts: undefined, excerpt: undefined, ...record };
      task.recent.push(saved);
      if (outcome.status === 'skipped') { task.counts.skipped++; diagnostic('schedule-skipped', task); }
      else task.counts.runs++;
      if (outcome.status === 'done') task.counts.consecutiveFailures = 0;
      if ((outcome.status === 'failed' && outcome.counts) || (outcome.status === 'interrupted' && outcome.by === 'crash')) task.counts.consecutiveFailures++;
      const excerpt = outcome.status === 'done' ? outcome.excerpt : outcome.status === 'failed' ? `失败：${outcome.error}` : '';
      task.lastResult = { at: now(), status: outcome.status, excerpt, ...('messageId' in outcome && outcome.messageId ? { messageId: outcome.messageId } : {}) };
      delete task.inflight;
      if (task.counts.consecutiveFailures >= 10 && task.pausedReason !== 'failures') {
        task.state = 'paused'; task.pausedReason = 'failures'; task.noticePending = true; touch(task);
        diagnostic('schedule-auto-paused', task);
      }
      finish(task, touch);
    });
  }
  function track(work: Promise<void>): void {
    const handled = work.catch(error => deps.log.fail('schedule', error)).finally(() => { working.delete(handled); scheduler.wake(); });
    working.add(handled);
  }
  async function claim(snapshot: StoredTask, slot: number, isManual: boolean, gate: Gate): Promise<void> {
    const runId = id(), trigger = isManual ? 'manual' : now() - slot >= 60_000 ? 'catchUp' : 'schedule';
    let job: ScheduledJob | undefined;
    const claimed = await store.mutateRuntime(tasks => {
      const task = tasks.find(t => t.id === snapshot.id);
      if (stopping || !task || task.revision !== snapshot.revision || task.cursor !== snapshot.cursor || task.inflight || (!isManual && (task.state !== 'active' || slot <= task.cursor))) return false;
      if (!isManual) {
        recordMissed(task, next(task) ?? slot, countSlotsBetween(task.spec, task.timeZone, task.cursor, slot) - 1);
        task.cursor = slot;
      }
      task.inflight = { runId, slot, trigger, startedAt: now(), revision: task.revision };
      job = { task: structuredClone(task), runId, slot, trigger, nth: task.counts.runs + 1, late: trigger === 'catchUp' };
      return true;
    });
    if (!claimed || !job) return;
    pending.delete(snapshot.id); manual.delete(snapshot.id); lastLaunch = now();
    const launched = job;
    track((async () => {
      let outcome: ScheduledOutcome;
      if (stopping) outcome = { status: 'interrupted', by: 'shutdown' };
      else if (gate === 'disabled' || gate === 'updating' || gate === 'held') outcome = { status: 'skipped', reason: gate };
      else if (gate !== 'ok') outcome = { status: 'failed', error: gate === 'unbound' ? '群已解绑' : '本群的权限档现在用不了', durationMs: 0, counts: true };
      else { try { outcome = await deps.run(launched); } catch (error) { outcome = { status: 'failed', error: String(error).slice(0, 200), durationMs: now() - launched.task.inflight!.startedAt, counts: true }; } }
      await settle(snapshot.id, runId, outcome);
      if (gate === 'tier-unavailable') deps.notifyGateFailure(launched.task);
    })());
  }
  async function tick(): Promise<void> {
    for (const task of store.all()) {
      if (stopping) return;
      await notice(task);
      const due = task.state === 'active' ? next(task) : undefined;
      if (due === undefined || due > now()) { pending.delete(task.id); continue; }
      const latest = latestSlotWithin(task.spec, task.timeZone, now(), windowMs);
      if (latest === undefined) {
        await store.mutateConfig((tasks, touch) => {
          const current = tasks.find(t => t.id === task.id);
          if (!current || current.revision !== task.revision || current.cursor !== task.cursor) return;
          recordMissed(current, due, countSlotsBetween(current.spec, current.timeZone, current.cursor, now()));
          current.cursor = now(); finish(current, touch);
        });
        pending.delete(task.id); continue;
      }
      if (latest <= task.cursor) continue;
      const gate = deps.gate(task.chatId);
      if (task.inflight || gate === 'disabled' || gate === 'updating' || gate === 'held') {
        await store.mutateConfig((tasks, touch) => {
          const current = tasks.find(t => t.id === task.id);
          if (!current || current.revision !== task.revision || current.cursor !== task.cursor) return;
          recordMissed(current, due, countSlotsBetween(current.spec, current.timeZone, current.cursor, latest) - 1);
          current.recent.push({ runId: id(), slot: latest, trigger: 'schedule', status: 'skipped', reason: gate === 'disabled' || gate === 'updating' || gate === 'held' ? gate : 'running' });
          current.counts.skipped++; current.cursor = latest; diagnostic('schedule-skipped', current); finish(current, touch);
        });
        pending.delete(task.id); continue;
      }
      const queued = pending.get(task.id);
      if (queued && queued.slot < latest) {
        await store.mutateRuntime(tasks => {
          const current = tasks.find(t => t.id === task.id);
          if (!current || current.cursor >= queued.slot || current.revision !== task.revision) return;
          recordMissed(current, queued.slot, 1); current.cursor = queued.slot;
        });
      }
      pending.set(task.id, { slot: latest, order: queued?.order ?? due, revision: task.revision });
    }
    const candidates = [...manual].map(([taskId, slot]) => ({ taskId, slot, order: slot, manual: true }))
      .concat([...pending].filter(([taskId]) => !manual.has(taskId)).map(([taskId, p]) => ({ taskId, ...p, manual: false }))).sort((a, b) => a.order - b.order);
    for (const candidate of candidates) {
      if (stopping || store.all().filter(t => t.inflight).length >= Math.max(1, deps.maxInflight()) || now() - lastLaunch < 2000) break;
      const task = store.get(candidate.taskId);
      if (!task || task.inflight || (!candidate.manual && task.state !== 'active')) { pending.delete(candidate.taskId); manual.delete(candidate.taskId); continue; }
      if (!candidate.manual && pending.get(task.id)?.revision !== task.revision) { pending.delete(task.id); again = true; continue; }
      await claim(task, candidate.slot, candidate.manual, deps.gate(task.chatId));
    }
    const live = new Set(store.all().map(task => task.id));
    for (const taskId of cache.keys()) if (!live.has(taskId)) cache.delete(taskId);
  }
  function scheduleTick(): void {
    if (timer) timers.clearTimeout(timer);
    if (stopping || !started) return;
    const delay = pending.size || manual.size ? Math.max(1, Math.min(30_000, lastLaunch + 2000 - now())) : 30_000;
    // Capacity is released by settlement, so a full queue needs no busy polling.
    const full = store.all().filter(task => task.inflight).length >= Math.max(1, deps.maxInflight());
    timer = timers.setTimeout(() => { timer = undefined; scheduler.wake(); }, full ? 30_000 : delay);
  }
  const scheduler: Scheduler = {
    async start(loaded) {
      if (started || stopping) return;
      for (const task of loaded.interrupted) if (task.inflight) await settle(task.id, task.inflight.runId, { status: 'interrupted', by: 'crash' });
      started = true; unsubscribe = store.onChange(() => scheduler.wake()); scheduler.wake(); await ticking;
    },
    stop() { stopping = true; if (timer) timers.clearTimeout(timer); timer = undefined; unsubscribe?.(); pending.clear(); manual.clear(); },
    async drain(ms) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([(async () => { await ticking; while (working.size) await Promise.all([...working]); })(), new Promise<void>(resolve => { deadline = timers.setTimeout(resolve, ms); })]);
      if (deadline) timers.clearTimeout(deadline);
    },
    wake() {
      if (!started || stopping) return;
      if (ticking) { again = true; return; }
      ticking = (async () => { do { again = false; await tick(); } while (again && !stopping); })()
        .catch(error => deps.log.fail('schedule', error)).finally(() => { ticking = undefined; scheduleTick(); });
    },
    runNow(taskId) {
      if (!started || stopping) return 'not-started';
      const task = store.get(taskId);
      if (!task) return 'not-found';
      if (task.inflight || manual.has(taskId)) return 'running';
      manual.set(taskId, now()); scheduler.wake(); return 'started';
    },
  };
  return scheduler;
}
