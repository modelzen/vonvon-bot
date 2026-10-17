// The crash handler of `vonvon daemon run`, the host run marker's lifecycle and the whole-host pause (product.md 3.10).
// A supervised bot child records under its host's run and chain (s18a); the supervisor counts and pauses it.
// No import-time side effects (the desktop imports @vonvon/daemon/host) and no import of config/paths or core/logger:
// the caller passes the data root and a log, so a test can bundle this file into a child process.
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { CRASH_KIND_TEXT } from '@vonvon/protocol';
import { errorPartLines } from '../core/error-parts';
import {
  countInWindow, CRASH_EXIT_CODE, CRASH_PAUSE_COUNT, crashErrorName, listCrashRecords, pruneCrashRecords,
  readRunMarker, removeRunMarkerSync, sanitizeReason, startedBeforeThisBoot, systemClock, takeResumeRequest,
  writeCrashRecordSync, writeRunMarkerSync, type Clock, type CrashRecord, type RunMarker,
} from './crash-store';

export type HostIntent = 'running' | 'restart' | 'stop';
export interface CrashLog {
  info(phase: string, event: string, fields?: Record<string, unknown>): void;
  warn(phase: string, event: string, fields?: Record<string, unknown>): void;
  fail(phase: string, error: unknown, fields?: Record<string, unknown>): void;
}
type Context = {
  scope: 'host' | 'bot'; appId?: string; root: string; runId: string; chainId: string; startedAt: string; bootId?: string;
  version: string; managed: string | null; paused: boolean; closed: boolean; intent: () => HostIntent; clock: Clock;
};
type HostRun = { marker: RunMarker; heartbeat?: NodeJS.Timeout; heartbeatFailed: boolean; log: CrashLog };
/** `crashes`: this chain's host crashes in the last 10 minutes, 0 after a resume request. For s18b's private message:
 * `resumed`, this start took a fresh resume request; `pauseEntered`, this start paused a run that was not paused. */
export type HostRunStart = {
  tracked: boolean; paused: boolean; runId?: string; chainId?: string; pauseCrashes?: number; pausedAt?: string; crashes: number; previous: CrashRecord | null;
  resumed: boolean; pauseEntered: boolean;
};

export const HEARTBEAT_MS = 60_000;
export const ORPHAN_DRAIN_MS = 20_000;
let context: Context | undefined;
let hostRun: HostRun | undefined;
let installedIntent: (() => HostIntent) | undefined;
let handling = false;
const crashHooks = new Set<() => void>();

/** Synchronous work that must finish before a crashing process exits. */
export function onCrashSync(hook: () => void): () => void {
  crashHooks.add(hook);
  return () => { crashHooks.delete(hook); };
}

const safe = (fn: () => void): void => { try { fn(); } catch { /* logging never ends a start or a crash */ } };

/** No supervisor remains to kill a child stuck draining after IPC disconnects. */
export function capOrphanDrain(options: { log: CrashLog; flush?: () => Promise<void>; ms?: number }): void {
  process.once('disconnect', () => {
    const since = Date.now();
    const timer = setTimeout(() => {
      safe(() => options.log.warn('run', 'orphan-drain-cut', { waitedMs: Date.now() - since }));
      const finish = (): never => { clearTimeout(fallback); process.exit(0); };
      const fallback = setTimeout(finish, 1500);
      void Promise.resolve().then(() => options.flush?.()).then(finish, finish);
    }, options.ms ?? ORPHAN_DRAIN_MS);
    timer.unref();
  });
}
const serviceManagedHost = (): boolean => Boolean(process.env.VONVON_SERVICE) && !process.send;
const managedName = (): string | null => process.env.VONVON_SERVICE?.slice(0, 20) || null;
const during = (intent: HostIntent): 'run' | 'stop' | 'restart' => intent === 'running' ? 'run' : intent;
function describe(value: unknown): string {
  let text: string;
  try { text = value instanceof Error ? value.stack ?? `${value.name}: ${value.message}` : typeof value === 'symbol' ? value.toString() : String(value); }
  catch { text = '(unprintable value)'; }
  // s17b: an AggregateError's stack names only the group; each error inside it gets a line.
  return [text, ...errorPartLines(value)].join('\n');
}

function record(ctx: Context, kind: CrashRecord['kind'], error: unknown, intent: HostIntent): CrashRecord {
  const errorName = crashErrorName(error);
  return {
    v: 1, at: new Date(ctx.clock.now()).toISOString(), sysUptimeMs: ctx.clock.uptimeMs(), ...(ctx.bootId ? { bootId: ctx.bootId } : {}),
    kind, scope: ctx.scope, ...(ctx.appId ? { appId: ctx.appId } : {}), pid: process.pid, runId: ctx.runId, chainId: ctx.chainId,
    startedAt: ctx.startedAt, uptimeMs: Math.round(process.uptime() * 1000), version: ctx.version.slice(0, 40) || '0.0.0',
    managed: ctx.managed, during: during(intent), ...(ctx.paused ? { paused: true } : {}),
    reason: sanitizeReason(error), ...(errorName ? { errorName } : {}),
  };
}

/** Service-managed host: 0 honours a stop and ends the loop of a paused run, 75 keeps a requested restart. A bot child
 * always exits 70, which tells its supervisor the record is written. */
function exitCodeFor(ctx: Context | undefined, intent: HostIntent): number {
  if (ctx?.scope === 'bot' || !serviceManagedHost()) return CRASH_EXIT_CODE;
  if (intent === 'stop') return 0;
  if (intent === 'restart') return 75;
  return ctx?.paused ? 0 : CRASH_EXIT_CODE;
}

function crashed(kind: 'exception' | 'rejection', error: unknown): void {
  const ctx = context && !context.closed ? context : undefined;
  let intent: HostIntent = 'running';
  try { intent = (ctx?.intent ?? installedIntent)?.() ?? 'running'; } catch { /* keep running */ }
  if (handling) process.exit(exitCodeFor(ctx, intent));
  handling = true;
  try { writeSync(2, `vonvon: uncaught ${kind} (pid ${process.pid}): ${describe(error)}\n`); } catch { /* stderr gone */ }
  if (ctx) {
    try { writeCrashRecordSync(ctx.root, record(ctx, kind, error, intent)); }
    catch (failure) { try { writeSync(2, `vonvon: crash record not written: ${failure instanceof Error ? failure.message : String(failure)}\n`); } catch { /* stderr gone */ } }
    // A host's crash during a requested stop or restart is not counted: the next start begins a new chain. A bot child
    // shares its host's run id but never owns the marker (a child crashing while it drains must not end the chain).
    if (intent !== 'running' && ctx.scope === 'host') { try { removeRunMarkerSync(ctx.root, ctx.runId); } catch { /* the next start writes a forced record */ } }
  }
  for (const hook of crashHooks) safe(hook);
  process.exit(exitCodeFor(ctx, intent));
}

/**
 * Installs the handlers of `daemon run` once. A host records only after {@link openHostRun}, so a start that loses the
 * host mutex writes nothing. A bot child has no run of its own: it exits 70 where Node exits 1, and s18 records it.
 */
export function installCrashHandlers(options: { intent: () => HostIntent }): void {
  if (installedIntent) return;
  installedIntent = options.intent;
  process.on('uncaughtException', error => crashed('exception', error));
  process.on('unhandledRejection', reason => crashed('rejection', reason));
}

function forcedRecord(previous: RunMarker): CrashRecord {
  return {
    v: 1, at: previous.aliveAt, sysUptimeMs: previous.aliveUptimeMs, ...(previous.bootId ? { bootId: previous.bootId } : {}),
    kind: 'forced', scope: 'host', pid: previous.pid, runId: previous.runId, chainId: previous.chainId, startedAt: previous.startedAt,
    uptimeMs: Math.max(0, previous.aliveUptimeMs - previous.startUptimeMs), version: previous.version, managed: previous.managed,
    during: 'run', ...(previous.state === 'paused' ? { paused: true } : {}), reason: CRASH_KIND_TEXT.forced,
  };
}

function beat(): void {
  const run = hostRun;
  const ctx = context;
  if (!run || !ctx || ctx.closed || ctx.scope !== 'host') return;
  run.marker = { ...run.marker, aliveAt: new Date(ctx.clock.now()).toISOString(), aliveUptimeMs: ctx.clock.uptimeMs() };
  try { writeRunMarkerSync(ctx.root, run.marker); }
  catch (error) {
    if (run.heartbeatFailed) return;
    run.heartbeatFailed = true;
    safe(() => run.log.fail('daemon-crash', error, { phase: 'heartbeat' }));
  }
}

/**
 * Classifies how the previous run of this data root ended and whether this one comes up paused (3 crashes of one
 * chain within 10 minutes). Called by the host mutex holder right after `daemon.pid`. Never throws: a failure here
 * leaves the run unpaused and untracked.
 */
export function openHostRun(options: { root: string; startedAt: string; version: string; intent: () => HostIntent; log: CrashLog; clock?: Clock; pid?: number }): HostRunStart {
  const clock = options.clock ?? systemClock;
  const log = options.log;
  try {
    let read = readRunMarker(options.root);
    if (read === 'corrupt') { safe(() => log.warn('daemon-crash', 'marker_corrupt', {})); read = null; }
    const prev = read;
    const resume = takeResumeRequest(options.root, clock.now());
    if (resume === 'stale') safe(() => log.warn('daemon-crash', 'resume_stale', {}));
    let chainId: string = randomUUID();
    let paused = false;
    let previous: CrashRecord | null = null;
    let count = 0;
    if (prev && startedBeforeThisBoot(prev, clock)) safe(() => log.info('daemon-crash', 'previous_reboot', { pid: prev.pid }));
    else if (prev) {
      const records = listCrashRecords(options.root, { scope: 'host' });
      previous = records.find(entry => entry.runId === prev.runId) ?? null;
      if (!previous) { // also under a resume request: a run killed before `daemon restart` still gets its record (3.10)
        previous = forcedRecord(prev);
        writeCrashRecordSync(options.root, previous);
        records.unshift(previous);
        safe(() => log.warn('daemon-crash', 'previous_forced', { pid: prev.pid, startedAt: prev.startedAt, aliveAt: prev.aliveAt }));
      }
      if (resume !== 'fresh') {
        chainId = prev.chainId;
        count = countInWindow(records, { chainId, nowUptimeMs: clock.uptimeMs() });
        paused = prev.state === 'paused' || count >= CRASH_PAUSE_COUNT;
      }
    }
    if (resume === 'fresh') safe(() => log.info('daemon-crash', 'resumed', {}));
    const sticky = paused && prev?.state === 'paused' ? prev : undefined;
    const now = new Date(clock.now()).toISOString();
    const up = clock.uptimeMs();
    const bootId = clock.bootId();
    const pauseCrashes = sticky ? sticky.pauseCrashes ?? Math.max(count, CRASH_PAUSE_COUNT) : count;
    const marker: RunMarker = {
      v: 1, runId: randomUUID(), chainId, pid: options.pid ?? process.pid, startedAt: options.startedAt, startUptimeMs: up,
      aliveAt: now, aliveUptimeMs: up, ...(bootId ? { bootId } : {}), version: options.version.slice(0, 40) || '0.0.0', managed: managedName(),
      state: paused ? 'paused' : 'running', ...(paused ? { pausedAt: sticky?.pausedAt ?? now, pauseCrashes } : {}),
    };
    // After the forced record, so a kill in between loses nothing: the next start finds that record by run id.
    writeRunMarkerSync(options.root, marker);
    const run: HostRun = { marker, heartbeatFailed: false, log };
    run.heartbeat = setInterval(beat, HEARTBEAT_MS);
    run.heartbeat.unref();
    hostRun = run;
    try { pruneCrashRecords(options.root, { now: clock.now() }); }
    catch (error) { safe(() => log.fail('daemon-crash', error, { phase: 'prune' })); }
    if (paused) safe(() => log.warn('daemon-crash', 'paused', { crashes: pauseCrashes }));
    context = {
      scope: 'host', root: options.root, runId: marker.runId, chainId, startedAt: options.startedAt, ...(bootId ? { bootId } : {}),
      version: marker.version, managed: marker.managed, paused, closed: false, intent: options.intent, clock,
    };
    return {
      tracked: true, paused, runId: marker.runId, chainId, ...(paused ? { pauseCrashes, ...(marker.pausedAt ? { pausedAt: marker.pausedAt } : {}) } : {}), crashes: count, previous,
      resumed: resume === 'fresh', pauseEntered: paused && !sticky,
    };
  } catch (error) {
    safe(() => log.fail('daemon-crash', error, { phase: 'open-run' }));
    return { tracked: false, paused: false, crashes: 0, previous: null, resumed: false, pauseEntered: false };
  }
}

/**
 * A supervised bot child (`daemon run --bot` with IPC): its records go under its host's run and chain, passed in
 * `VONVON_HOST_RUN_ID` and `VONVON_HOST_CHAIN_ID`. No marker, heartbeat or pruning: the supervisor records what the child
 * could not (a signal, a failed handler, a fatal exit) and counts. False, and the handler only prints, on bad ids.
 */
export function openBotCrashContext(options: { root: string; appId: string; runId: string | undefined; chainId: string | undefined; startedAt: string; version: string; intent: () => HostIntent; clock?: Clock }): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!options.runId || !options.chainId || !uuid.test(options.runId) || !uuid.test(options.chainId) || !/^cli_[A-Za-z0-9_-]{1,200}$/.test(options.appId)) return false;
  const clock = options.clock ?? systemClock;
  const bootId = clock.bootId();
  context = {
    scope: 'bot', appId: options.appId, root: options.root, runId: options.runId, chainId: options.chainId, startedAt: options.startedAt,
    ...(bootId ? { bootId } : {}), version: options.version.slice(0, 40) || '0.0.0', managed: managedName(), paused: false, closed: false, intent: options.intent, clock,
  };
  return true;
}

/**
 * A supervised bot child whose host died (kill -9) still drains, but its stdout and stderr lead to a dead reader: the next
 * write fails with EPIPE, which with no listener is an uncaught exception that ends the drain (s18 D1). The listener keeps
 * the drain going; a stop is asked for too, in case the IPC disconnect has not arrived.
 */
export function guardParentPipes(control: { requestStop(): void }): void {
  const lost = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') control.requestStop();
  };
  process.stdout.on('error', lost);
  process.stderr.on('error', lost);
}

/**
 * Ends this run's bookkeeping: a clean end removes the marker (the next start begins a new chain); a failure that no
 * stop or restart asked for writes a `fatal` record and keeps it. A no-op without {@link openHostRun}.
 */
export function closeHostRun(outcome: { kind: 'clean' } | { kind: 'fatal'; error: unknown }): void {
  const ctx = context;
  const run = hostRun;
  if (!ctx || ctx.closed || !run) return;
  clearInterval(run.heartbeat);
  ctx.closed = true;
  try {
    if (outcome.kind === 'clean') removeRunMarkerSync(ctx.root, ctx.runId);
    else {
      const entry = record(ctx, 'fatal', outcome.error, 'running');
      writeCrashRecordSync(ctx.root, entry);
      safe(() => run.log.warn('daemon-crash', 'fatal', { reason: entry.reason, paused: ctx.paused }));
    }
  } catch (error) { safe(() => run.log.fail('daemon-crash', error, { phase: 'close-run' })); }
}
