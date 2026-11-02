import { selfEntry } from '../core/self-entry';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../core/logger';
import { abandonOwnedUpdate, type UpdateStatus } from '../service/update';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { withoutSessionMarkers } from '../config/session-env';
import { ApiCleanupError } from '../server/http';
import { closeOwnedProviderProcesses, registeredProviderPids, unconfirmedProviderPids } from '../agent/owned-process';

/** Why the server stops, for the cards of the turns it cuts short (owner 2026-11-02): a stop, a restart, or an update's restart. */
export type StopReason = 'stop' | 'restart' | 'update';
export const STOP_REASONS: readonly StopReason[] = ['stop', 'restart', 'update'];

export interface ShutdownControl {
  readonly requested: boolean;
  /** What was asked for; optional so a test's fake control still fits. The crash handler reads it. */
  readonly intent?: 'running' | 'restart' | 'stop';
  /** Why the stop came: what the host was asked for, or what the host told this bot child (`bridge:shutdown`'s `reason`).
   * `stop` until something else is known; optional so a test's fake control still fits. */
  readonly reason?: StopReason;
  waitForRequest(): Promise<void>;
  /** `reason`: a stop for a desktop update; the cards then say the server was updated. */
  requestStop(reason?: StopReason): void;
  requestRestart(port: number, update?: UpdateStatus): void;
  completeShutdown(release: () => Promise<void>): Promise<void>;
  dispose(): void;
}

class ListenerCloseUnconfirmedError extends AggregateError {
  constructor(error: unknown) {
    super([error], 'Listener cutoff was not confirmed.');
  }
}

export function listenerCloseUnconfirmed(error: unknown): boolean {
  return error instanceof ListenerCloseUnconfirmedError
    || (error instanceof AggregateError && error.errors.some(listenerCloseUnconfirmed));
}

export async function closeOwnedProviders(shutdown: () => Promise<void> = async () => {}): Promise<void> {
  let orphanKey: string | undefined;
  const report = (settled: boolean): Promise<void> => {
    const pids = unconfirmedProviderPids();
    if (process.send && !process.connected) {
      const key = [...pids].sort((a, b) => a - b).join(',');
      if (key !== orphanKey) { orphanKey = key; log.info('daemon-shutdown', 'owned-work-orphan', { pids }); }
      return Promise.resolve();
    }
    if (!settled && pids.length) log.warn('daemon-shutdown', 'owned_work_unconfirmed', { pid: process.pid, pids });
    if (!process.send) return Promise.resolve();
    // `registered`: what the host kills by group if it has to kill this process before the agents are closed (supervisor.ts).
    const registered = settled ? [] : registeredProviderPids();
    return new Promise((resolve, reject) => {
      process.send?.({ fcb: 'fcb.owned-work', pids, settled, registered }, (error: Error | null) => error ? reject(error) : resolve());
    });
  };
  const pendingReport = (): void => {
    void report(false).catch(error => log.fail('daemon-shutdown', error, { phase: 'owned-work-report' }));
  };
  pendingReport();
  const timer = setInterval(pendingReport, 1000);
  const errors: unknown[] = [];
  try { await shutdown(); }
  catch (error) { errors.push(error); }
  try { await closeOwnedProviderProcesses(); }
  catch (error) { errors.push(error); }
  finally { clearInterval(timer); }
  try { await report(true); }
  catch (error) { log.fail('daemon-shutdown', error, { phase: 'owned-work-report' }); errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Provider cleanup failed.');
}

type RestartHelper = {
  child: ChildProcess;
  update?: UpdateStatus;
  born: boolean;
  dead: boolean;
  death: Promise<void>;
  cancelled: boolean;
  escalation?: NodeJS.Timeout;
  readiness:
    | { kind: 'immediate' }
    | { kind: 'pending'; scope: string; helperArgs: string[]; deadlineAt: number }
    | { kind: 'ready' };
  settled: Promise<void>;
  poll?: NodeJS.Timeout;
};

interface ShutdownOptions {
  serviceManaged?: boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  readProc?: (pid: number, file: 'cgroup' | 'cmdline') => string;
  /** Where a standalone server is installed; the default asks the running distribution. */
  installRoot?: () => Promise<string | undefined>;
}

export function linuxHelperReady(cgroup: string, cmdline: string[], scope: string, helperArgs: string[]): boolean {
  const unified = cgroup.split('\n').filter(line => line.startsWith('0::'));
  if (unified.length !== 1) return false;
  const path = unified[0]?.slice(3);
  if (!path?.startsWith('/') || path.includes('\0')) return false;
  const components = path.slice(1).split('/');
  if (components.some(part => !part || part === '.' || part === '..' || /^vonvon-bot(?:-[0-9a-f]{12})?\.service$/.test(part))) return false;
  return components.at(-1) === scope && cmdline.length === helperArgs.length + 1
    && helperArgs.every((arg, index) => cmdline[index + 1] === arg);
}

export function observeShutdown(parentControl = false, options: ShutdownOptions = {}): ShutdownControl {
  const serviceManaged = (options.serviceManaged ?? Boolean(process.env.VONVON_SERVICE)) && !process.send;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? setTimeout;
  const unschedule = options.clearTimeout ?? clearTimeout;
  const readProc = options.readProc ?? ((pid, file) => readFileSync(`/proc/${pid}/${file}`, 'utf8'));
  let settleHelper: () => void = () => {};
  let intent: 'running' | 'restart' | 'stop' = 'running';
  let stopReason: StopReason = 'stop';
  let committed = false;
  let helper: RestartHelper | undefined;
  let completion: Promise<void> | undefined;
  let wake: () => void = () => {};
  const pending = new Promise<void>(resolve => { wake = resolve; });
  const isStopping = (): boolean => intent === 'stop';
  // A restart that will not happen ends its update record; a standalone one first switches `current` back, which
  // completes before this process lets go (server-3 review F2).
  let abandoning: Promise<void> | undefined;
  const abandon = (update: UpdateStatus | undefined, reason: string): void => {
    if (!update) return;
    const step = abandonOwnedUpdate(update, reason, options.installRoot).catch(error => log.fail('daemon-restart', error, { phase: 'abandon-update' }));
    // Other records end at once, inside the call; only a standalone switch back is waited for.
    if (update.previous !== undefined) abandoning = Promise.all([abandoning, step]).then(() => undefined);
  };
  const cancelHelper = (reason = '重启已被停止取消'): void => {
    if (!helper || helper.cancelled) return;
    const owned = helper;
    owned.cancelled = true;
    log.info('daemon-restart', 'cancelled', { pid: process.pid, helperPid: owned.child.pid });
    abandon(owned.update, reason);
    unschedule(owned.poll);
    settleHelper();
    if (owned.dead) return;
    try { owned.child.kill('SIGTERM'); } catch (error) { log.fail('daemon-restart', error, { phase: 'cancel-term' }); }
    owned.escalation = schedule(() => {
      if (!owned.dead) {
        try { owned.child.kill('SIGKILL'); } catch (error) { log.fail('daemon-restart', error, { phase: 'cancel-kill' }); }
      }
    }, 5000);
  };
  const request = (): void => {
    if (committed) { log.info('daemon-shutdown', 'stop_after_commit', { pid: process.pid }); return; }
    // A stop that cancels a pending restart is a stop: the server does not come back.
    if (intent === 'restart') stopReason = 'stop';
    intent = 'stop';
    cancelHelper();
    setImmediate(wake);
  };
  const message = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'bridge:shutdown') return;
    // The host's SIGTERM may come first: the reason the message carries still holds, the cards read it as they end.
    const told = 'reason' in value ? STOP_REASONS.find(known => known === value.reason) : undefined;
    if (told) stopReason = told;
    request();
  };
  let input = '';
  const data = (chunk: Buffer): void => {
    input += chunk.toString('utf8');
    if (input.length > 1024 || input.includes('\n')) {
      if (input.trim() === 'shutdown') request();
      input = '';
    }
  };
  process.on('SIGINT', request);
  process.on('SIGTERM', request);
  // A foreground run whose terminal goes away stops cleanly instead of dying and leaving a forced crash record.
  process.on('SIGHUP', request);
  if (process.send) {
    process.on('message', message);
    process.on('disconnect', request);
  }
  if (parentControl) {
    process.stdin.on('data', data);
    process.stdin.on('end', request);
    process.stdin.on('error', request);
    process.stdin.resume();
    if (process.stdin.readableEnded || process.stdin.destroyed) request();
  }
  const complete = async (release: () => Promise<void>): Promise<void> => {
    for (;;) {
      if (intent === 'stop') cancelHelper();
      if (helper?.cancelled && !helper.dead) { await helper.death; continue; }
      if (helper && !helper.dead && helper.readiness.kind === 'pending') { await helper.settled; continue; }
      if (abandoning) {
        const abandoned = abandoning;
        await abandoned;
        if (abandoning === abandoned) abandoning = undefined;
        continue;
      }
      committed = true;
      if (serviceManaged && intent !== 'running') process.exitCode = 0;
      try { await release(); }
      catch (error) {
        if (error instanceof ApiCleanupError) {
          log.fail('daemon-shutdown', error, { phase: 'listener-cleanup' });
          throw error;
        }
        log.fail('daemon-shutdown', error, { phase: 'listener_close_unconfirmed' });
        throw new ListenerCloseUnconfirmedError(error);
      } finally { if (serviceManaged && intent === 'restart') process.exitCode = 75; } // s17: kept after a failed release
      return;
    }
  };
  /**
   * A restart whose helper failed (owner 2026-11-02): under a service manager this process still exits 75 and the manager
   * starts the server again, on the release `current` names once the update is abandoned (a standalone one switches it
   * back first); a server nobody manages stops.
   */
  const helperFailed = (update: UpdateStatus | undefined, why: string, cancel: boolean): void => {
    if (serviceManaged) log.warn('daemon-restart', 'helper_failed_service_restart', { pid: process.pid, why });
    else intent = 'stop';
    if (cancel) cancelHelper(why);
    else abandon(update, why);
    wake();
  };
  return {
    get requested() { return intent !== 'running'; },
    get intent() { return intent; },
    get reason() { return stopReason; },
    waitForRequest: () => pending,
    requestStop(why?: StopReason) {
      request();
      // Not after a committed restart, which goes on as it is.
      if (why && intent === 'stop' && !committed) stopReason = why;
    },
    completeShutdown(release) { return completion ??= complete(release); },
    requestRestart(port, update) {
      if (intent === 'stop' || committed) { abandon(update, '重启已被停止取消'); return; }
      if (intent === 'restart') { abandon(update, '已有重启正在进行'); return; }
      intent = 'restart';
      stopReason = update ? 'update' : 'restart';
      if (serviceManaged && !update) { setImmediate(wake); return; }
      try {
        const cliEntry = selfEntry();
        if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
        const identity = z.object({ pid: z.number().int().positive(), startedAt: z.string().datetime() })
          .parse(JSON.parse(readFileSync(join(paths.appDir, 'daemon.pid'), 'utf8')));
        if (identity.pid !== process.pid) throw new Error('Cannot restart a different daemon owner.');
        const args = [cliEntry, '__restart-after-exit', String(port), String(identity.pid), identity.startedAt];
        if (update) args.push(JSON.stringify(update));
        const scope = serviceManaged && platform === 'linux'
          ? `vonvon-bot-update-${randomBytes(8).toString('hex')}.scope` : undefined;
        const child = spawn(scope ? 'systemd-run' : process.execPath,
          scope ? ['--user', '--scope', '--quiet', `--unit=${scope}`, process.execPath, ...args] : args,
          { detached: true, stdio: 'ignore', env: withoutSessionMarkers(process.env) });
        let markDead: () => void = () => {};
        const death = new Promise<void>(resolve => { markDead = resolve; });
        const settled = scope ? new Promise<void>(resolve => { settleHelper = resolve; }) : Promise.resolve();
        const owned: RestartHelper = {
          child, update, born: child.pid !== undefined, dead: false, death, cancelled: false, settled,
          readiness: scope ? { kind: 'pending', scope, helperArgs: args, deadlineAt: Infinity } : { kind: 'immediate' },
        };
        helper = owned;
        const died = (): void => {
          if (owned.dead) return;
          owned.dead = true;
          unschedule(owned.escalation);
          unschedule(owned.poll);
          settleHelper();
          markDead();
          if (!committed && !owned.cancelled) {
            log.warn('daemon-restart', 'helper_lost', { pid: identity.pid, listen: `127.0.0.1:${port}`, helperPid: child.pid });
            helperFailed(update, 'helper_lost', false);
          }
        };
        const poll = (): void => {
          if (owned.dead || owned.cancelled || owned.readiness.kind !== 'pending') return;
          if (now() >= owned.readiness.deadlineAt) {
            helperFailed(update, 'helper_lost', true);
            return;
          }
          let ready = false;
          try {
            if (child.pid !== undefined) {
              const cgroup = readProc(child.pid, 'cgroup');
              const cmdline = readProc(child.pid, 'cmdline').split('\0');
              if (cmdline.at(-1) === '') cmdline.pop();
              ready = linuxHelperReady(cgroup, cmdline, owned.readiness.scope, owned.readiness.helperArgs);
            }
          } catch { /* A proc read failure cannot prove readiness or death. */ }
          if (ready) {
            owned.readiness = { kind: 'ready' };
            unschedule(owned.poll);
            settleHelper();
            wake();
          } else owned.poll = schedule(poll, 50);
        };
        child.once('spawn', () => {
          owned.born = true;
          if (owned.cancelled && !owned.dead) child.kill('SIGTERM');
          if (owned.dead || owned.cancelled) return;
          if (owned.readiness.kind === 'pending') {
            owned.readiness.deadlineAt = now() + 25_000;
            owned.poll = schedule(poll, 50);
          } else wake();
        });
        child.on('error', error => {
          log.fail('daemon-restart', error, { phase: 'helper-spawn' });
          if (!owned.born && child.pid === undefined) died();
        });
        child.once('exit', died);
        child.once('close', died);
        if (child.exitCode !== null || child.signalCode !== null) died();
        if (isStopping()) cancelHelper();
        child.unref();
      } catch (error) {
        log.fail('daemon-restart', error, { phase: 'helper-spawn' });
        helperFailed(update, 'helper_lost', false);
      }
    },
    dispose() {
      process.off('SIGINT', request); process.off('SIGTERM', request); process.off('SIGHUP', request);
      process.off('message', message); process.off('disconnect', request);
      if (parentControl) {
        process.stdin.off('data', data); process.stdin.off('end', request); process.stdin.off('error', request);
        process.stdin.pause();
      }
    },
  };
}

/**
 * The longest a requested stop, restart or update takes in the host (owner 2026-11-02): the Bot children stop all at
 * once, BOT_STOP_LIMIT_MS each at most (supervisor.ts), and the rest is quick, so 3 to 8 seconds is usual. Past it the
 * host exits anyway; systemd's TimeoutStopSec of 45 seconds is the backstop under it.
 */
export const HOST_STOP_LIMIT_MS = 30_000;

/**
 * Once a stop is requested, exits the host after `ms` if it is still there: a restart under a service manager with 75,
 * so the manager starts it again; a stop under one with 0; otherwise 1. `beforeExit` ends the run's bookkeeping first, so
 * the next start does not take it for a crash. Returns the disarm.
 */
export function armHostStopLimit(control: Pick<ShutdownControl, 'waitForRequest' | 'intent'>, options: {
  ms?: number; serviceManaged?: boolean; exit?: (code: number) => void; beforeExit?: () => void; flush?: () => Promise<void>;
} = {}): () => void {
  const ms = options.ms ?? HOST_STOP_LIMIT_MS;
  const serviceManaged = options.serviceManaged ?? (Boolean(process.env.VONVON_SERVICE) && !process.send);
  let disarmed = false;
  let timer: NodeJS.Timeout | undefined;
  void control.waitForRequest().then(() => {
    if (disarmed) return;
    timer = setTimeout(() => {
      const intent = control.intent ?? 'stop';
      const code = serviceManaged ? (intent === 'restart' ? 75 : 0) : 1;
      log.warn('daemon-shutdown', 'host_stop_limit', { pid: process.pid, limitMs: ms, intent, code });
      try { options.beforeExit?.(); } catch (error) { log.fail('daemon-shutdown', error, { phase: 'stop-limit' }); }
      let exited = false;
      const exit = (): void => { if (exited) return; exited = true; (options.exit ?? process.exit)(code); };
      const fallback = setTimeout(exit, 1500);
      void Promise.resolve().then(() => options.flush?.()).then(exit, exit).finally(() => clearTimeout(fallback));
    }, ms);
    timer.unref?.();
  });
  return () => { disarmed = true; if (timer) clearTimeout(timer); };
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => { clearTimeout(timer); child.off('exit', exitedEvent); resolve(exited); };
    const exitedEvent = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', exitedEvent);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export const CHILD_SHUTDOWN_GRACE_MS = 8000;
const FORCE_EXIT_MS = 3000;
const FORCE_SHUTDOWN_MS = FORCE_EXIT_MS * (process.platform === 'win32' ? 2 : 1);
const HOST_SHUTDOWN_GRACE_MS = CHILD_SHUTDOWN_GRACE_MS + FORCE_SHUTDOWN_MS + 1000;
const stops = new WeakMap<ChildProcess, Promise<void>>();

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function reapGroup(pid: number): Promise<boolean> {
  if (!groupExists(pid)) return false;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const deadline = Date.now() + FORCE_EXIT_MS;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Host process group ${pid} has not exited after forced termination.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** How long the exit is waited for once `beforeEscalation` is done; a function is read then, so one deadline can cover both. */
export type GraceMs = number | (() => number);

export function stopChild(child: ChildProcess, graceMs: GraceMs = HOST_SHUTDOWN_GRACE_MS, ownsProcessGroup = false, beforeEscalation?: () => Promise<void>, reason?: StopReason): Promise<void> {
  const existing = stops.get(child);
  if (existing) return existing;
  const stopping = stop(child, graceMs, ownsProcessGroup, beforeEscalation, reason);
  stops.set(child, stopping);
  return stopping;
}

async function stop(child: ChildProcess, graceMs: GraceMs, ownsProcessGroup: boolean, beforeEscalation?: () => Promise<void>, reason?: StopReason): Promise<void> {
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.pid) throw new Error('Cannot terminate a child without a process identity.');
    if (child.connected) {
      // The reason rides on the message, which goes before the SIGTERM: the child's cards say why their turns stopped.
      child.send(reason ? { type: 'bridge:shutdown', reason } : { type: 'bridge:shutdown' }, () => {});
      if (process.platform !== 'win32') child.kill('SIGTERM');
    }
    else if (child.stdin && !child.stdin.destroyed) child.stdin.end('shutdown\n');
    else if (process.platform !== 'win32') child.kill('SIGTERM');
    await beforeEscalation?.();
    if (!await waitForExit(child, Math.max(0, typeof graceMs === 'function' ? graceMs() : graceMs))) {
      forced = true;
      const forceDeadline = Date.now() + FORCE_EXIT_MS;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        let killError: Error | undefined;
        killer.once('error', (error) => { killError = error; });
        if (!await waitForExit(killer, FORCE_EXIT_MS)) {
          killer.kill();
          throw new Error(`Host tree termination timed out for ${child.pid}.`, { cause: killError });
        }
        if (killError) throw killError;
        if (killer.exitCode !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`Host tree termination failed for ${child.pid}.`);
      } else if (ownsProcessGroup) {
        await reapGroup(child.pid);
      } else child.kill('SIGKILL');
      const exitWaitMs = process.platform === 'win32' ? FORCE_EXIT_MS : Math.max(0, forceDeadline - Date.now());
      if (!await waitForExit(child, exitWaitMs)) throw new Error(`Host process ${child.pid} has not exited after forced termination.`);
    }
  }
  if (ownsProcessGroup && process.platform !== 'win32' && child.pid) forced = await reapGroup(child.pid) || forced;
  if (forced) throw new Error(`Host process ${child.pid} required forced termination; graceful cleanup was not confirmed.`);
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(`Host process ${child.pid} exited with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}; graceful cleanup failed.`);
  }
}

export async function settleOwnedChild(child: ChildProcess, graceMs: GraceMs = CHILD_SHUTDOWN_GRACE_MS, ownsProcessGroup = false, beforeEscalation?: () => Promise<void>, reason?: StopReason): Promise<void> {
  let observed = child.exitCode !== null || child.signalCode !== null;
  const observe = (): void => { observed = true; };
  child.once('exit', observe);
  child.once('close', observe);
  try {
    try { await stopChild(child, graceMs, ownsProcessGroup, beforeEscalation, reason); }
    catch (error) {
      for (;;) {
        let groupAlive = false;
        if (ownsProcessGroup && process.platform !== 'win32' && child.pid) {
          try { groupAlive = groupExists(child.pid); }
          catch { groupAlive = true; }
        }
        if (observed && !groupAlive) break;
        log.warn('daemon-shutdown', 'owned_work_unconfirmed', { pid: child.pid });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw error;
    }
  } finally { child.off('exit', observe); child.off('close', observe); }
}
