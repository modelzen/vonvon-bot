import { readFile } from 'node:fs/promises';
import type { ProcessIdentity, ReadProcessIdentity } from './posix-driver';
import { assertDeadline, beforeDeadline } from './tree-kill';
import type { ResourceCloseResult } from './tree-kill';

export function parseLinuxStat(stat: string, ticksPerSecond: number, bootTimeMs: number): ProcessIdentity {
  const endOfName = stat.lastIndexOf(')');
  if (endOfName < 0) return { kind: 'unknown', reason: 'Malformed Linux process stat' };
  const fields = stat.slice(endOfName + 1).trim().split(/\s+/);
  const groupId = Number(fields[2]);
  const ticks = Number(fields[19]);
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(ticks) || ticks < 0
    || !Number.isSafeInteger(ticksPerSecond) || ticksPerSecond <= 0 || !Number.isSafeInteger(bootTimeMs) || bootTimeMs <= 0) {
    return { kind: 'unknown', reason: 'Invalid Linux process birth or process group' };
  }
  const startedAtMs = bootTimeMs + ticks * 1000 / ticksPerSecond;
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return { kind: 'unknown', reason: 'Invalid Linux process birth' };
  return { kind: 'live', startedAtMs, groupId };
}

/** ticksPerSecond must come from sysconf(_SC_CLK_TCK), never an assumed 100 Hz. */
export function linuxProcessIdentity(ticksPerSecond: number): ReadProcessIdentity {
  const pendingCleanup = new Set<AbortController>();
  const operations = new Map<AbortController, { cancel: () => void; closed: Promise<void> }>();
  let accepting = true;
  const read = async (pid: number, deadlineMs: number): Promise<ProcessIdentity> => {
    assertDeadline(deadlineMs);
    const startedAt = performance.now();
    if (!accepting) return { kind: 'unknown', reason: 'Linux identity reader is closed' };
    if (startedAt >= deadlineMs) return { kind: 'unknown', reason: 'Linux identity deadline expired' };
    if (process.platform !== 'linux') return { kind: 'unknown', reason: 'Linux procfs is unavailable' };
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return { kind: 'unknown', reason: 'Invalid process PID' };
    if (pendingCleanup.size > 0) return { kind: 'unknown', reason: 'Linux identity read cleanup is unconfirmed' };
    const effectiveDeadline = Math.min(deadlineMs, startedAt + 1000);
    const controller = new AbortController();
    const reads = Promise.allSettled([
      readFile(`/proc/${pid}/stat`, { encoding: 'utf8', signal: controller.signal }),
      readFile('/proc/stat', { encoding: 'utf8', signal: controller.signal }),
    ]);
    const identity = reads.then(([stat, systemStat]): ProcessIdentity => {
      if (stat.status === 'rejected') {
        const error: unknown = stat.reason;
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' };
        return { kind: 'unknown', reason: 'Cannot read Linux process birth identity' };
      }
      if (systemStat.status === 'rejected') return { kind: 'unknown', reason: 'Cannot read Linux boot time' };
      const bootSeconds = systemStat.value.match(/^btime (\d+)$/m)?.[1];
      if (bootSeconds === undefined) return { kind: 'unknown', reason: 'Linux boot time is unavailable' };
      return parseLinuxStat(stat.value, ticksPerSecond, Number(bootSeconds) * 1000);
    });
    return new Promise<ProcessIdentity>(resolve => {
      let settled = false;
      const timer = setTimeout(() => cancel('Linux identity read timed out; cleanup is unconfirmed'), Math.max(0, effectiveDeadline - performance.now()));
      function cancel(reason: string): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pendingCleanup.add(controller);
        controller.abort();
        resolve({ kind: 'unknown', reason });
      }
      const closed = identity.then(result => {
        clearTimeout(timer);
        pendingCleanup.delete(controller);
        operations.delete(controller);
        if (settled) return;
        settled = true;
        resolve(performance.now() >= effectiveDeadline
          ? { kind: 'unknown', reason: 'Linux identity deadline expired' }
          : result);
      }, () => {
        clearTimeout(timer);
        pendingCleanup.delete(controller);
        operations.delete(controller);
        settled = true;
        resolve({ kind: 'unknown', reason: 'Cannot read Linux process birth identity' });
      });
      operations.set(controller, { cancel: () => cancel('Linux identity reader is closed; cleanup is unconfirmed'), closed });
      if (performance.now() >= effectiveDeadline) cancel('Linux identity read timed out; cleanup is unconfirmed');
    });
  };
  return Object.assign(read, {
    owesWork: (): boolean => operations.size > 0,
    close: async (deadlineMs: number): Promise<ResourceCloseResult> => {
      assertDeadline(deadlineMs);
      accepting = false;
      for (const operation of operations.values()) operation.cancel();
      if (operations.size === 0) return 'closed';
      const result = await beforeDeadline(Promise.all([...operations.values()].map(operation => operation.closed)), deadlineMs);
      return result.kind === 'completed' && operations.size === 0 ? 'closed' : 'timeout';
    },
  });
}
