// The crash handler of `vonvon daemon run`, the host run marker's lifecycle and the whole-host pause (product.md 3.10).
// Bot children get their handler, records and pause in s18; the record format already carries `scope: 'bot'`.
// No import-time side effects (the desktop imports @vonvon/daemon/host) and no import of config/paths or core/logger:
// the caller passes the data root and a log, so a test can bundle this file into a child process.
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import {
  countInWindow, CRASH_EXIT_CODE, CRASH_KIND_TEXT, CRASH_PAUSE_COUNT, crashErrorName, listCrashRecords, pruneCrashRecords,
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
  root: string; runId: string; chainId: string; startedAt: string; bootId?: string;
  version: string; managed: string | null; paused: boolean; closed: boolean; intent: () => HostIntent; clock: Clock;
};
type HostRun = { marker: RunMarker; heartbeat?: NodeJS.Timeout; heartbeatFailed: boolean; log: CrashLog };
export type HostRunStart = { tracked: boolean; paused: boolean; runId?: string; chainId?: string; pauseCrashes?: number; previous: CrashRecord | null };

export const HEARTBEAT_MS = 60_000;
let context: Context | undefined;
let hostRun: HostRun | undefined;
let installedIntent: (() => HostIntent) | undefined;
let handling = false;

const safe = (fn: () => void): void => { try { fn(); } catch { /* logging never ends a start or a crash */ } };
const serviceManagedHost = (): boolean => Boolean(process.env.VONVON_SERVICE) && !process.send;
const managedName = (): string | null => process.env.VONVON_SERVICE?.slice(0, 20) || null;
const during = (intent: HostIntent): 'run' | 'stop' | 'restart' => intent === 'running' ? 'run' : intent;
function describe(value: unknown): string {
  try { return value instanceof Error ? value.stack ?? `${value.name}: ${value.message}` : typeof value === 'symbol' ? value.toString() : String(value); }
  catch { return '(unprintable value)'; }
}

function record(ctx: Context, kind: CrashRecord['kind'], error: unknown, intent: HostIntent): CrashRecord {
  const errorName = crashErrorName(error);
  return {
    v: 1, at: new Date(ctx.clock.now()).toISOString(), sysUptimeMs: ctx.clock.uptimeMs(), ...(ctx.bootId ? { bootId: ctx.bootId } : {}),
    kind, scope: 'host', pid: process.pid, runId: ctx.runId, chainId: ctx.chainId,
    startedAt: ctx.startedAt, uptimeMs: Math.round(process.uptime() * 1000), version: ctx.version.slice(0, 40) || '0.0.0',
    managed: ctx.managed, during: during(intent), ...(ctx.paused ? { paused: true } : {}),
    reason: sanitizeReason(error), ...(errorName ? { errorName } : {}),
  };
}

/** Service-managed host: 0 honours a stop and ends the loop of a paused run, 75 keeps a requested restart. */
function exitCodeFor(ctx: Context | undefined, intent: HostIntent): number {
  if (!serviceManagedHost()) return CRASH_EXIT_CODE;
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
    // A crash during a requested stop or restart is not counted: the next start begins a new chain.
    if (intent !== 'running') { try { removeRunMarkerSync(ctx.root, ctx.runId); } catch { /* the next start writes a forced record */ } }
  }
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
  if (!run || !ctx || ctx.closed) return;
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
    if (prev && resume !== 'fresh') {
      if (startedBeforeThisBoot(prev, clock)) safe(() => log.info('daemon-crash', 'previous_reboot', { pid: prev.pid }));
      else {
        chainId = prev.chainId;
        const records = listCrashRecords(options.root, { scope: 'host' });
        previous = records.find(entry => entry.runId === prev.runId) ?? null;
        if (!previous) {
          previous = forcedRecord(prev);
          writeCrashRecordSync(options.root, previous);
          records.unshift(previous);
          safe(() => log.warn('daemon-crash', 'previous_forced', { pid: prev.pid, startedAt: prev.startedAt, aliveAt: prev.aliveAt }));
        }
        count = countInWindow(records, { chainId, nowUptimeMs: clock.uptimeMs() });
        paused = prev.state === 'paused' || count >= CRASH_PAUSE_COUNT;
      }
    } else if (resume === 'fresh') safe(() => log.info('daemon-crash', 'resumed', {}));
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
      root: options.root, runId: marker.runId, chainId, startedAt: options.startedAt, ...(bootId ? { bootId } : {}),
      version: marker.version, managed: marker.managed, paused, closed: false, intent: options.intent, clock,
    };
    return { tracked: true, paused, runId: marker.runId, chainId, ...(paused ? { pauseCrashes } : {}), previous };
  } catch (error) {
    safe(() => log.fail('daemon-crash', error, { phase: 'open-run' }));
    return { tracked: false, paused: false, previous: null };
  }
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
