import { spawn } from 'node:child_process';
import { paths } from '../config/paths';
import { getPidLockInfo, isPidLockOwnerRunning, type PidLockInfo } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { finishOwnedUpdate, readUpdateStatus, type UpdateStatus } from '../service/update';
import { readCurrent, releaseCommand, switchCurrent } from '../service/current-release';
import { runtimeDistribution } from '../service/distribution';
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
  /** Windows' service supervisor (I4b) switches `current.txt` back itself; two writers would fight. */
  rollsBack: boolean;
};
const realDeps = (): RestartHelperDeps => ({
  readLock: () => getPidLockInfo(paths.appDir),
  running: isPidLockOwnerRunning,
  verify: lock => verifyPidLockOwner(paths.appDir, lock),
  start: (file, args) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', env: { ...process.env, VONVON_HOME: paths.appDir } });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  }),
  now: Date.now,
  pause,
  installRoot: async () => { const distribution = await runtimeDistribution(); return distribution.kind === 'standalone' ? distribution.installRoot : undefined; },
  switchCurrent: (root, version) => switchCurrent(root, version),
  readCurrentVersion: async root => (await readCurrent(root))?.version,
  rollsBack: !(process.platform === 'win32' && process.env.VONVON_SERVICE),
});

/** How long a standalone update waits for the new version, then for the previous one after switching back (4.6). */
export const NEW_OWNER_MS = 60_000;
export const ROLLBACK_OWNER_MS = 25_000;

export async function runSamePortRestartHelper(options: { port: number; oldPid: number; oldStartedAt: string; update?: UpdateStatus }, overrides: Partial<RestartHelperDeps> = {}): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !Number.isSafeInteger(options.oldPid) || options.oldPid < 1 || !Number.isFinite(Date.parse(options.oldStartedAt))) throw new Error('Invalid restart identity.');
  const deps = { ...realDeps(), ...overrides };
  const cliEntry = selfEntry();
  if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
  const listen = `127.0.0.1:${options.port}`;
  const update = options.update;
  // A standalone update switched `current` before the old daemon drained: the replacement must run `update.to`.
  const standalone = update?.previous !== undefined && update.to !== undefined ? await deps.installRoot() : undefined;
  const sameOld = (lock: PidLockInfo): boolean => lock.pid === options.oldPid && lock.startedAt === options.oldStartedAt;
  let outcome: 'start_failed' | 'superseded' = 'start_failed';
  let next: PidLockInfo | null = null;
  const verifyReplacement = async (lock: PidLockInfo): Promise<void> => {
    if (sameOld(lock)) throw new Error('Old daemon still owns the restart port.');
    if (lock.listen !== listen) { outcome = 'superseded'; throw new Error(`Restart superseded by PID ${lock.pid} at ${lock.listen}.`); }
    await deps.verify(lock);
  };
  // The start command names what `current` points at now, not this helper's own release.
  const startCommand = async (): Promise<[string, string[]]> => {
    const version = standalone ? await deps.readCurrentVersion(standalone) : undefined;
    const { node, entry } = standalone && version ? releaseCommand(standalone, version) : { node: process.execPath, entry: cliEntry };
    return [node, [entry, 'daemon', 'start', '--port', String(options.port)]];
  };
  try {
    for (;;) {
      next = await deps.readLock();
      if (!next || !deps.running(next)) break;
      if (!sameOld(next) && next.listen) { await verifyReplacement(next); break; }
      await deps.pause(100);
    }
    if (standalone && update) { await settleStandalone(next && deps.running(next) ? next : null); return; }
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

  /** Starts the daemon unless one runs, then waits up to `ms` for a verified owner on this port. */
  async function startAndWait(ms: number): Promise<PidLockInfo | null> {
    const until = deps.now() + ms;
    void deps.start(...await startCommand()).catch(error => log.fail('daemon-restart', error, { phase: 'start' }));
    for (;;) {
      const lock = await deps.readLock().catch(() => null);
      if (lock && deps.running(lock) && !sameOld(lock) && lock.listen) { await verifyReplacement(lock); return lock; }
      if (deps.now() >= until) return null;
      await deps.pause(500);
    }
  }

  async function settleStandalone(replacement: PidLockInfo | null): Promise<void> {
    if (!standalone || !update?.previous) return;
    const owner = replacement ?? await startAndWait(NEW_OWNER_MS);
    if (owner && owner.version === update.to) {
      log.info('daemon-restart', 'replaced', { oldPid: options.oldPid, oldListen: listen, pid: owner.pid, listen: owner.listen, version: owner.version });
      finishOwnedUpdate(update, 'done');
      return;
    }
    // The new process may have ended the record itself (bootstrap), or a later update owns the file now.
    const current = readUpdateStatus();
    if (current?.phase !== 'restarting' || current.at !== update.at) return;
    const what = owner ? `重启后运行的是 ${owner.version ?? '未知版本'}` : `新版本 ${update.to} 没有起来`;
    if (!deps.rollsBack) { finishOwnedUpdate(update, 'error', what); return; }
    await deps.switchCurrent(standalone, update.previous);
    log.warn('daemon-restart', 'update-standalone-rolled-back', { from: update.to, to: update.previous, owner: owner?.version ?? null });
    // Written before the previous version starts, so its own startup check finds the update ended.
    const ended = finishOwnedUpdate(update, 'error', `${what}，已切回 ${update.previous}`, { rolledBack: true });
    if (owner) return; // something already listens; nothing to start
    if (!await startAndWait(ROLLBACK_OWNER_MS)) finishOwnedUpdate(ended, 'error', `${what}，已切回 ${update.previous}，但它也没有起来。请运行 vonvon daemon start。`);
  }
}
