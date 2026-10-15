// Adapted from getpaseo/paseo packages/server/src/server/pid-lock.ts at 0009a7e71.
// Copyright Paseo contributors. Licensed under Apache-2.0; see NOTICE.
import { readFileSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { bridgeVersion } from '../core/version';
import { writeFileAtomic } from './atomic-file';

const lockSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  listen: z.string().nullable(),
  version: z.string().optional(),
  bootId: z.string().optional(),
});
export type PidLockInfo = z.infer<typeof lockSchema>;

export class PidLockError extends Error {
  constructor(message: string, readonly existingLock?: PidLockInfo) {
    super(message);
    this.name = 'PidLockError';
  }
}

const lockPath = (home: string): string => join(home, 'daemon.pid');
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function currentBootId(): string | undefined {
  try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; }
  catch { return undefined; }
}

export function isPidLockOwnerRunning(lock: PidLockInfo): boolean {
  const boot = currentBootId();
  if (lock.bootId && boot && lock.bootId !== boot) return false;
  if (!lock.bootId || !boot) {
    const started = Date.parse(lock.startedAt);
    if (started < Date.now() - uptime() * 1000 - 5000) return false;
  }
  try { process.kill(lock.pid, 0); return true; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'EPERM'; }
}

export async function getPidLockInfo(home: string): Promise<PidLockInfo | null> {
  let raw = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    try { raw = await readFile(lockPath(home), 'utf8'); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    if (raw.length > 0) break;
    if (attempt === 9) return null;
    await pause(50);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new PidLockError('Invalid daemon PID lock JSON.'); }
  const result = lockSchema.safeParse(parsed);
  if (!result.success) throw new PidLockError('Invalid daemon PID lock shape.');
  return result.data;
}

export async function readRunningPidLock(home: string): Promise<PidLockInfo | null> {
  const lock = await getPidLockInfo(home);
  return lock && isPidLockOwnerRunning(lock) ? lock : null;
}

function sameOwner(a: Pick<PidLockInfo, 'pid' | 'startedAt'>, b: Pick<PidLockInfo, 'pid' | 'startedAt'>): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/** A lock identity that failed authentication; a starter waits past it for the daemon that replaces it. */
export type StaleOwner = Pick<PidLockInfo, 'pid' | 'startedAt'>;
export const isStaleOwner = (lock: PidLockInfo, stale: StaleOwner | undefined): boolean => stale !== undefined && sameOwner(lock, stale);

/**
 * Creates `daemon.pid` for this process. With `hostMutexHeld`, the caller holds the host mutex, which every live
 * daemon keeps while it owns the lock, so a lock whose PID still answers belongs to a dead daemon whose PID was reused.
 */
export async function acquirePidLock(home: string, options: { hostMutexHeld?: boolean } = {}): Promise<PidLockInfo> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = lockPath(home);
  const live = (lock: PidLockInfo): boolean => !options.hostMutexHeld && isPidLockOwnerRunning(lock);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await getPidLockInfo(home);
    if (previous) {
      if (live(previous)) throw new PidLockError(`Another Vonvon daemon is already running (PID ${previous.pid}).`, previous);
      const confirmation = await getPidLockInfo(home);
      if (!confirmation || !sameOwner(previous, confirmation) || live(confirmation)) {
        throw new PidLockError('PID lock changed while checking its owner.');
      }
      await unlink(path);
    } else {
      try { if ((await stat(path)).size === 0) await unlink(path); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    const bootId = currentBootId();
    const lock: PidLockInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      listen: null,
      version: bridgeVersion(),
      ...(bootId ? { bootId } : {}),
    };
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(lock)); }
      finally { await file.close(); }
      return lock;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      await pause(25);
    }
  }
  throw new PidLockError('Cannot acquire daemon PID lock after concurrent startup.');
}

export async function publishPidLock(home: string, owner: PidLockInfo, listen: string): Promise<PidLockInfo> {
  const current = await getPidLockInfo(home);
  if (!current || !sameOwner(current, owner)) throw new PidLockError('Cannot publish readiness for a different daemon owner.');
  const ready = { ...current, listen };
  await writeFileAtomic(lockPath(home), JSON.stringify(ready));
  return ready;
}

export async function releasePidLock(home: string, owner: PidLockInfo): Promise<void> {
  const current = await getPidLockInfo(home);
  if (current && sameOwner(current, owner)) await unlink(lockPath(home)).catch((error: unknown) => { if (!isMissing(error)) throw error; });
}
