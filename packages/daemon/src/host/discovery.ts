import { DataRootMigrationError, resolveDataRoot } from '../config/data-root';
import { DataAccessError } from '../config/data-access';
import { verifyPidLockOwner } from '../server/owner-verification';
import { getPidLockInfo, isPidLockOwnerRunning } from '../server/pid-lock';

export type HostRefusal = {
  kind: 'blocked';
  reason: 'busy' | 'inspection-failed' | 'migration-pending' | 'startup-failed' | 'service-registered';
  message: string;
};
export type HostInspection = { kind: 'absent' } | { kind: 'attached'; pid: number } | HostRefusal;
export interface HostEndpoint { port: number; pid: number; startedAt: string; listen: string }

export function refusal(error: unknown): HostRefusal {
  return { kind: 'blocked', reason: error instanceof DataRootMigrationError ? 'migration-pending' : error instanceof DataAccessError ? 'busy' : 'inspection-failed', message: error instanceof Error ? error.message : String(error) };
}

export async function readHostEndpoint(home: string, explicitRoot = false): Promise<HostEndpoint | HostRefusal | undefined> {
  try {
    const root = explicitRoot ? { path: home } : resolveDataRoot(home);
    const lock = await getPidLockInfo(root.path);
    if (!lock || !isPidLockOwnerRunning(lock)) return;
    if (!lock.listen) return { kind: 'blocked', reason: 'busy', message: `Host PID ${lock.pid} has not published readiness.` };
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(lock.listen);
    const port = Number(match?.[1]);
    if (!match || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Host listen address in PID lock.');
    await verifyPidLockOwner(root.path, lock);
    return { pid: lock.pid, startedAt: lock.startedAt, listen: lock.listen, port };
  } catch (error) { return refusal(error); }
}
