import { spawn } from 'node:child_process';
import { paths } from '../config/paths';
import { withoutSessionMarkers } from '../config/session-env';
import { getPidLockInfo, isPidLockOwnerRunning, type PidLockInfo } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { finishOwnedUpdate, type UpdateStatus } from '../service/update';
import { log } from '../core/logger';

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export async function runSamePortRestartHelper(options: { port: number; oldPid: number; oldStartedAt: string; update?: UpdateStatus }): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !Number.isSafeInteger(options.oldPid) || options.oldPid < 1 || !Number.isFinite(Date.parse(options.oldStartedAt))) throw new Error('Invalid restart identity.');
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
  const listen = `127.0.0.1:${options.port}`;
  const sameOld = (lock: PidLockInfo): boolean => lock.pid === options.oldPid && lock.startedAt === options.oldStartedAt;
  let outcome: 'start_failed' | 'superseded' = 'start_failed';
  let next: PidLockInfo | null = null;
  const verifyReplacement = async (lock: PidLockInfo): Promise<void> => {
    if (sameOld(lock)) throw new Error('Old daemon still owns the restart port.');
    if (lock.listen !== listen) { outcome = 'superseded'; throw new Error(`Restart superseded by PID ${lock.pid} at ${lock.listen}.`); }
    await verifyPidLockOwner(paths.appDir, lock);
  };
  try {
    for (;;) {
      next = await getPidLockInfo(paths.appDir);
      if (!next || !isPidLockOwnerRunning(next)) break;
      if (!sameOld(next) && next.listen) { await verifyReplacement(next); break; }
      await pause(100);
    }
    if (!next || !isPidLockOwnerRunning(next)) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cliEntry, 'daemon', 'start', '--port', String(options.port)], {
          stdio: 'ignore', env: { ...withoutSessionMarkers(process.env), VONVON_HOME: paths.appDir },
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Restart start command exited ${code}.`)));
      });
      next = await getPidLockInfo(paths.appDir);
      if (!next || !isPidLockOwnerRunning(next)) throw new Error('Replacement daemon did not publish a running owner.');
      await verifyReplacement(next);
    }
    log.info('daemon-restart', 'replaced', { oldPid: options.oldPid, oldListen: listen, pid: next.pid, listen: next.listen });
    finishOwnedUpdate(options.update, 'done');
  } catch (error) {
    log.warn('daemon-restart', outcome, { oldPid: options.oldPid, oldListen: listen, pid: next?.pid, listen: next?.listen, reason: String(error) });
    finishOwnedUpdate(options.update, 'error', outcome);
    throw error;
  }
}
