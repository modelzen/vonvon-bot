import { spawn, type ChildProcess } from 'node:child_process';
import { log } from '../core/logger';
import { finishOwnedUpdate, type UpdateStatus } from '../service/update';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { ApiCleanupError } from '../server/http';
import { closeOwnedCodexProcesses, unconfirmedCodexPids } from '../platform/owned-process';

export interface ShutdownControl {
  readonly requested: boolean;
  waitForRequest(): Promise<void>;
  requestStop(): void;
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
  const report = (settled: boolean): Promise<void> => {
    const pids = unconfirmedCodexPids();
    if (!settled && pids.length) log.warn('daemon-shutdown', 'owned_work_unconfirmed', { pid: process.pid, pids });
    if (!process.send) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (!process.connected) { reject(new Error('Owned-work IPC channel is closed.')); return; }
      process.send?.({ fcb: 'fcb.owned-work', pids, settled }, (error: Error | null) => error ? reject(error) : resolve());
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
  try { await closeOwnedCodexProcesses(); }
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
};

export function observeShutdown(parentControl = false): ShutdownControl {
  let intent: 'running' | 'restart' | 'stop' = 'running';
  let committed = false;
  let helper: RestartHelper | undefined;
  let completion: Promise<void> | undefined;
  let wake: () => void = () => {};
  const pending = new Promise<void>(resolve => { wake = resolve; });
  const isStopping = (): boolean => intent === 'stop';
  const cancelHelper = (): void => {
    if (!helper || helper.cancelled) return;
    const owned = helper;
    owned.cancelled = true;
    log.info('daemon-restart', 'cancelled', { pid: process.pid, helperPid: owned.child.pid });
    finishOwnedUpdate(owned.update, 'error', '重启已被停止取消');
    if (owned.dead) return;
    try { owned.child.kill('SIGTERM'); } catch (error) { log.fail('daemon-restart', error, { phase: 'cancel-term' }); }
    owned.escalation = setTimeout(() => {
      if (!owned.dead) {
        try { owned.child.kill('SIGKILL'); } catch (error) { log.fail('daemon-restart', error, { phase: 'cancel-kill' }); }
      }
    }, 5000);
  };
  const request = (): void => {
    if (committed) { log.info('daemon-shutdown', 'stop_after_commit', { pid: process.pid }); return; }
    intent = 'stop';
    cancelHelper();
    setImmediate(wake);
  };
  const message = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'bridge:shutdown') request();
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
      committed = true;
      try { await release(); }
      catch (error) {
        if (error instanceof ApiCleanupError) {
          log.fail('daemon-shutdown', error, { phase: 'listener-cleanup' });
          throw error;
        }
        log.fail('daemon-shutdown', error, { phase: 'listener_close_unconfirmed' });
        throw new ListenerCloseUnconfirmedError(error);
      }
      return;
    }
  };
  return {
    get requested() { return intent !== 'running'; },
    waitForRequest: () => pending,
    requestStop: request,
    completeShutdown(release) { return completion ??= complete(release); },
    requestRestart(port, update) {
      if (intent === 'stop' || committed) { finishOwnedUpdate(update, 'error', '重启已被停止取消'); return; }
      if (helper) { finishOwnedUpdate(update, 'error', '已有重启正在进行'); return; }
      intent = 'restart';
      try {
        const cliEntry = process.argv[1];
        if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
        const identity = z.object({ pid: z.number().int().positive(), startedAt: z.string().datetime() })
          .parse(JSON.parse(readFileSync(join(paths.appDir, 'daemon.pid'), 'utf8')));
        if (identity.pid !== process.pid) throw new Error('Cannot restart a different daemon owner.');
        const args = [cliEntry, '__restart-after-exit', String(port), String(identity.pid), identity.startedAt];
        if (update) args.push(JSON.stringify(update));
        const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env } });
        let markDead: () => void = () => {};
        const death = new Promise<void>(resolve => { markDead = resolve; });
        const owned: RestartHelper = { child, update, born: child.pid !== undefined, dead: false, death, cancelled: false };
        helper = owned;
        const died = (): void => {
          if (owned.dead) return;
          owned.dead = true;
          clearTimeout(owned.escalation);
          markDead();
          if (!committed && !owned.cancelled) {
            intent = 'stop';
            log.warn('daemon-restart', 'helper_lost', { pid: identity.pid, listen: `127.0.0.1:${port}`, helperPid: child.pid });
            finishOwnedUpdate(update, 'error', 'helper_lost');
            wake();
          }
        };
        child.once('spawn', () => {
          owned.born = true;
          if (owned.cancelled && !owned.dead) child.kill('SIGTERM');
          wake();
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
        intent = 'stop';
        finishOwnedUpdate(update, 'error', 'helper_lost');
        log.fail('daemon-restart', error, { phase: 'helper-spawn' });
        wake();
      }
    },
    dispose() {
      process.off('SIGINT', request); process.off('SIGTERM', request);
      process.off('message', message); process.off('disconnect', request);
      if (parentControl) {
        process.stdin.off('data', data); process.stdin.off('end', request); process.stdin.off('error', request);
        process.stdin.pause();
      }
    },
  };
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

export function stopChild(child: ChildProcess, graceMs = HOST_SHUTDOWN_GRACE_MS, ownsProcessGroup = false, beforeEscalation?: () => Promise<void>): Promise<void> {
  const existing = stops.get(child);
  if (existing) return existing;
  const stopping = stop(child, graceMs, ownsProcessGroup, beforeEscalation);
  stops.set(child, stopping);
  return stopping;
}

async function stop(child: ChildProcess, graceMs: number, ownsProcessGroup: boolean, beforeEscalation?: () => Promise<void>): Promise<void> {
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.pid) throw new Error('Cannot terminate a child without a process identity.');
    if (child.connected) {
      child.send({ type: 'bridge:shutdown' }, () => {});
      if (process.platform !== 'win32') child.kill('SIGTERM');
    }
    else if (child.stdin && !child.stdin.destroyed) child.stdin.end('shutdown\n');
    else if (process.platform !== 'win32') child.kill('SIGTERM');
    await beforeEscalation?.();
    if (!await waitForExit(child, graceMs)) {
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

export async function settleOwnedChild(child: ChildProcess, graceMs = CHILD_SHUTDOWN_GRACE_MS, ownsProcessGroup = false, beforeEscalation?: () => Promise<void>): Promise<void> {
  let observed = child.exitCode !== null || child.signalCode !== null;
  const observe = (): void => { observed = true; };
  child.once('exit', observe);
  child.once('close', observe);
  try {
    try { await stopChild(child, graceMs, ownsProcessGroup, beforeEscalation); }
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
