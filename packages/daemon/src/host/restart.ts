import { spawn } from 'node:child_process';
import { paths } from '../config/paths';
import { withoutSessionMarkers } from '../config/session-env';
import { getPidLockInfo, isPidLockOwnerRunning, type PidLockInfo } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { finishOwnedUpdate, holdOwnedUpdate, type HeldUpdate, type UpdateStatus } from '../service/update';
import { readCurrent, releaseCommand, switchCurrent } from '../service/current-release';
import { standaloneInstallRoot } from '../service/distribution';
import { selfEntry } from '../core/self-entry';
import { log } from '../core/logger';

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Test seams; the defaults are the real lock, verification, spawn and clock. */
export type RestartHelperDeps = {
  readLock: () => Promise<PidLockInfo | null>;
  running: (lock: PidLockInfo) => boolean;
  verify: (lock: PidLockInfo) => Promise<void>;
  /** Runs `<file> <args>` to its exit and resolves its exit code. */
  start: (file: string, args: string[]) => Promise<number | null>;
  now: () => number;
  pause: (ms: number) => Promise<void>;
  /** The install root of a standalone server this helper belongs to. */
  installRoot: () => Promise<string | undefined>;
  switchCurrent: (installRoot: string, version: string) => Promise<unknown>;
  readCurrentVersion: (installRoot: string) => Promise<string | undefined>;
  /** Clears `releases/` but for the given versions (standalone-update.ts cleanupReleases). */
  cleanup: (installRoot: string, keep: string[]) => Promise<void>;
  /** Keeps a release from other data directories' cleanups while this process lives (noteRunning). */
  note: (installRoot: string, version: string) => Promise<void>;
};
const realDeps = (): RestartHelperDeps => ({
  readLock: () => getPidLockInfo(paths.appDir),
  running: isPidLockOwnerRunning,
  verify: lock => verifyPidLockOwner(paths.appDir, lock),
  start: (file, args) => new Promise((resolve, reject) => {
    // the host's own child (devices-4a R3): a host started inside a session does not pass the session on
    const child = spawn(file, args, { stdio: 'ignore', env: { ...withoutSessionMarkers(process.env), VONVON_HOME: paths.appDir } });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  }),
  now: Date.now,
  pause,
  installRoot: async () => standaloneInstallRoot(),
  switchCurrent: (root, version) => switchCurrent(root, version),
  readCurrentVersion: async root => (await readCurrent(root))?.version,
  cleanup: async (root, keep) => { await (await import('../service/standalone-update')).cleanupReleases(root, keep); },
  note: async (root, version) => { await (await import('../service/standalone-update')).noteRunning(root, version); },
});

/**
 * How long a standalone update waits for the new version to listen, then for the previous one after switching back
 * (4.6). A new process that already holds the pid lock but does not listen yet (a migration on its first start) gets
 * STARTING_OWNER_MS more before the helper gives up on it, and a listening owner counts once it has stayed the same live
 * process for STEADY_OWNER_MS: one that listens and dies at once is not up.
 */
export const NEW_OWNER_MS = 60_000;
export const STARTING_OWNER_MS = 240_000;
export const ROLLBACK_OWNER_MS = 25_000;
export const STEADY_OWNER_MS = 5_000;

type Owner = { lock?: PidLockInfo; starting?: boolean };

export async function runSamePortRestartHelper(options: { port: number; oldPid: number; oldStartedAt: string; update?: UpdateStatus }, overrides: Partial<RestartHelperDeps> = {}): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !Number.isSafeInteger(options.oldPid) || options.oldPid < 1 || !Number.isFinite(Date.parse(options.oldStartedAt))) throw new Error('Invalid restart identity.');
  const deps = { ...realDeps(), ...overrides };
  const cliEntry = selfEntry();
  if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
  const listen = `127.0.0.1:${options.port}`;
  const update = options.update;
  // Any restart of a standalone server starts what `current` points at: an update switched it before the old daemon
  // drained, and the install script may have (review F8). Elsewhere it is this process's own entry.
  const installRoot = await deps.installRoot().catch(() => undefined);
  const standalone = installRoot !== undefined && update?.previous !== undefined && update.to !== undefined
    ? { root: installRoot, update: { ...update, previous: update.previous, to: update.to } } : undefined;
  const sameOld = (lock: PidLockInfo): boolean => lock.pid === options.oldPid && lock.startedAt === options.oldStartedAt;
  let outcome: 'start_failed' | 'superseded' = 'start_failed';
  let next: PidLockInfo | null = null;
  const verifyReplacement = async (lock: PidLockInfo): Promise<void> => {
    if (sameOld(lock)) throw new Error('Old daemon still owns the restart port.');
    if (lock.listen !== listen) { outcome = 'superseded'; throw new Error(`Restart superseded by PID ${lock.pid} at ${lock.listen}.`); }
    await deps.verify(lock);
  };
  const startCommand = async (): Promise<[string, string[]]> => {
    const version = installRoot ? await deps.readCurrentVersion(installRoot).catch(() => undefined) : undefined;
    const { node, entry } = installRoot && version ? releaseCommand(installRoot, version) : { node: process.execPath, entry: cliEntry };
    return [node, [entry, 'daemon', 'start', '--port', String(options.port)]];
  };
  try {
    for (;;) {
      next = await deps.readLock();
      if (!next || !deps.running(next)) break;
      // A standalone update judges a new owner by its version, listening yet or not (settleStandalone).
      if (!sameOld(next) && standalone) break;
      if (!sameOld(next) && next.listen) { await verifyReplacement(next); break; }
      await deps.pause(100);
    }
  } catch (error) {
    log.warn('daemon-restart', outcome, { oldPid: options.oldPid, oldListen: listen, pid: next?.pid, listen: next?.listen, reason: String(error) });
    finishOwnedUpdate(update, 'error', standalone ? '重启助手读不了 daemon.pid，没有判断新版本' : outcome);
    throw error;
  }
  if (standalone) { await settleStandalone(standalone.root, standalone.update); return; }
  try {
    if (!next || !deps.running(next)) {
      const code = await deps.start(...await startCommand());
      if (code !== 0) throw new Error(`Restart start command exited ${code}.`);
      next = await deps.readLock();
      if (!next || !deps.running(next)) throw new Error('Replacement daemon did not publish a running owner.');
      await verifyReplacement(next);
    }
    log.info('daemon-restart', 'replaced', { oldPid: options.oldPid, oldListen: listen, pid: next.pid, listen: next.listen });
    finishOwnedUpdate(update, 'done');
  } catch (error) {
    log.warn('daemon-restart', outcome, { oldPid: options.oldPid, oldListen: listen, pid: next?.pid, listen: next?.listen, reason: String(error) });
    finishOwnedUpdate(update, 'error', outcome);
    throw error;
  }

  /** A live owner other than the old daemon, or null; a pid lock that cannot be read counts as none this time. */
  async function liveOwner(): Promise<PidLockInfo | null> {
    const lock = await deps.readLock().catch(() => null);
    return lock && deps.running(lock) && !sameOld(lock) ? lock : null;
  }

  /**
   * Starts the daemon unless one runs, then waits up to `ms` for an owner that listens and stays up. Judged by the pid
   * lock alone (4.11): no ws handshake, whose protocol a newer release may have moved on. One that holds the lock
   * without listening at the deadline is waited for up to STARTING_OWNER_MS more while it stays the same process.
   */
  async function awaitOwner(ms: number): Promise<Owner> {
    if (!await liveOwner()) void deps.start(...await startCommand()).catch(error => log.fail('daemon-restart', error, { phase: 'start' }));
    const deadline = deps.now() + ms;
    const cap = deadline + STARTING_OWNER_MS;
    let steady: { id: string; since: number } | undefined;
    let starting: string | undefined;
    for (;;) {
      const lock = await liveOwner();
      const now = deps.now();
      const id = lock ? `${lock.pid}@${lock.startedAt}` : '';
      if (lock?.listen) {
        if (steady?.id !== id) steady = { id, since: now };
        if (now - steady.since >= STEADY_OWNER_MS || now >= cap) return { lock };
      } else {
        steady = undefined;
        if (now >= deadline) {
          if (!lock) return {};
          starting ??= id;
          // The one waited for is gone and another took the lock: a crash loop, not a slow start.
          if (starting !== id) return {};
          if (now >= cap) return { lock, starting: true };
        }
      }
      await deps.pause(500);
    }
  }

  async function settleStandalone(root: string, update: UpdateStatus & { previous: string; to: string }): Promise<void> {
    // This helper runs from `previous` (the old daemon's release) and may switch back to it.
    await deps.note(root, update.previous).catch(error => log.fail('daemon-restart', error, { phase: 'note' }));
    // The old daemon is gone: the helper holds `update.lock` from here to the outcome, so no other update starts and the
    // new daemon's own startup check leaves the record to it. Someone already ended the record (a stop that cancelled
    // the restart, the new daemon): they own the outcome, and nothing is started against a stop.
    const held = await holdOwnedUpdate(update);
    if (!held) return;
    try { await judge(root, update, held); }
    finally { held.release(); }
  }

  async function judge(root: string, update: UpdateStatus & { previous: string; to: string }, held: HeldUpdate): Promise<void> {
    held.write({ ...update, detail: 'waiting', at: Date.now() });
    const first = await awaitOwner(NEW_OWNER_MS);
    if (first.lock && !first.starting && first.lock.version === update.to) {
      log.info('daemon-restart', 'replaced', { oldPid: options.oldPid, oldListen: listen, pid: first.lock.pid, listen: first.lock.listen, version: first.lock.version });
      held.end('done');
      // The new daemon's startup cleanup found the lock held: releases/ is cleared here instead (4.10).
      await deps.cleanup(root, [update.to, update.previous]).catch(error => log.fail('daemon-restart', error, { phase: 'cleanup' }));
      return;
    }
    if (first.starting) {
      // Still starting after all that time: switching back under it would leave it running a release `current` no
      // longer names. Once the lock is let go, it ends the record itself when it listens (settleUpdateAtStartup).
      log.warn('daemon-restart', 'update-standalone-still-starting', { pid: first.lock?.pid, version: first.lock?.version ?? null });
      return;
    }
    const what = first.lock ? `重启后运行的是 ${first.lock.version ?? '未知版本'}` : `新版本 ${update.to} 没有起来`;
    try { await deps.switchCurrent(root, update.previous); }
    catch (error) {
      log.fail('daemon-restart', error, { phase: 'switch-back' });
      held.end('error', `${what}，也没能切回 ${update.previous}`);
      return;
    }
    // Written before the previous version starts, so its own startup check finds the update ended.
    held.end('error', `${what}，已切回 ${update.previous}`, { rolledBack: true });
    log.warn('daemon-restart', 'update-standalone-rolled-back', { from: update.to, to: update.previous, owner: first.lock?.version ?? null });
    if (first.lock) return; // something already listens; nothing to start
    const second = await awaitOwner(ROLLBACK_OWNER_MS);
    const version = second.lock && !second.starting ? second.lock.version : undefined;
    if (version === update.previous) return;
    if (version === update.to) {
      // The new release came up after all, late: it is what runs, so `current` names it again and the update stands.
      try {
        await deps.switchCurrent(root, update.to);
        held.end('done', `新版本 ${update.to} 起得慢，已经起来了`);
      } catch (error) { log.fail('daemon-restart', error, { phase: 'switch-forward' }); }
      return;
    }
    held.end('error', version
      ? `${what}，已切回 ${update.previous}，但现在运行的是 ${version}`
      : `${what}，已切回 ${update.previous}，但它也没有起来。请运行 vonvon daemon start。`);
  }
}
