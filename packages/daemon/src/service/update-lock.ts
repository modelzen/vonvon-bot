import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The file lock behind `update.lock`, `releases.lock` and `update-state.lock` (server-3 review 220). Processes of
 * different data directories, and of different versions, meet on it, so it is a plain file with a JSON record:
 * `{ pid, at, token, start? }` — the holder's pid, when it was taken, a random token, and on Linux the holder's start
 * time (`processStart`: boot id and `/proc/<pid>/stat` field 22), which tells a later process with the same pid apart.
 *
 * Only these file system steps are used, each atomic on its own: making a name that must not exist yet (`link`,
 * `mkdir`, `rename` of a directory onto a name that is free or an empty directory), removing a name (`unlink`, `rmdir`
 * of a directory only while it is empty) and reading. There is no "remove if unchanged" in a file system, and that is
 * what the reclaim guard below supplies.
 *
 * Invariants (each holds given the ones before it):
 *
 * 1. A lock whose holder lives is never taken. `isStale` says a record is left behind only when its pid is dead, or
 *    the pid lives but with a start time other than the recorded one (another process got the pid), or the pid is this
 *    process and `held` does not list the token (a process with this pid before us wrote it: we list every lock we
 *    hold, on the process so every copy of this module sees it). No age plays into it: a holder that is paused, slow
 *    or stuck keeps its lock. A record without a pid is nobody's. The one age rule is for a file that does not parse:
 *    this module never shows a half-written lock (the record is written to a private file and `link`ed into place,
 *    so the name appears with all its bytes), but a writer of the code before this one, or a file system without
 *    hard links (`createExclusive` falls back to O_EXCL and a write), can; such a file is left alone until its mtime
 *    is `UNREADABLE_LOCK_MS` old, after which no writer of ours could still be on it.
 * 2. Removing a stale lock never removes a live one, so there are never two holders. A holder exists only by
 *    `createExclusive` succeeding on a name that was free, so a second holder needs the first one's name removed.
 *    The names removed are: a holder's own, in `release`, after the text read back is its own record (by 1, nothing
 *    else removes a live holder's lock, so what it read is what it removes); and a stale record, inside the reclaim
 *    guard only, after reading the name again and finding the same text (same token) that was judged stale. The
 *    guard `<file>.reclaim` is a directory holding one file named by the reclaimer's token with its record; it is
 *    built aside and `rename`d into place, so it too appears whole. While a live process holds the guard, nobody else
 *    can: `rename` onto a non-empty directory fails, and the owner file is removed only by name, by a process that
 *    judged that owner stale by the rule in 1 — and a live owner is never judged stale. A guard whose owner died is
 *    recovered by removing that owner file by its name (never another's) and `rmdir`, which fails if another
 *    reclaimer's directory has taken the (momentarily empty) name meanwhile. So between the guard holder's second read
 *    of the stale record and its `unlink`, no other process removes or replaces the lock: the holder of that record
 *    is gone, other reclaimers wait for the guard, and `release` only removes its caller's own live lock.
 * 3. `release` removes only the caller's own lock, once: it needs the token it was given to still be the one listed
 *    in `held`, and the file's text to be the record it wrote. A lock taken later by this process, or by another
 *    after this one was reclaimed, is left standing.
 *
 * Liveness is best effort: a process that finds the guard taken, or loses the race to create the lock after a
 * reclaim, reports busy and the caller decides whether to try again (`withStateLock` polls; an update refuses).
 */
export const UNREADABLE_LOCK_MS = 10_000;

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

export function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process is there, this one may not signal it: alive.
    return code(err) === 'EPERM';
  }
}

/**
 * Which run of `pid` this is, on Linux: the boot and the start time in clock ticks after it (/proc/<pid>/stat field 22).
 * A pid used again later, also by a container started anew, gets another start time. Undefined elsewhere.
 */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return ticks && /^\d+$/.test(ticks) ? `${boot}/${ticks}` : undefined;
  } catch {
    return undefined;
  }
}

// What this process holds, by resolved path (a lock file or a reclaim guard) → token. On the process, not the module.
const HELD = Symbol.for('vonvon.update-locks');
const held = ((globalThis as Record<symbol, unknown>)[HELD] ??= new Map<string, string>()) as Map<string, string>;

function record(token: string): string {
  const start = processStart(process.pid);
  return JSON.stringify({ pid: process.pid, at: Date.now(), token, ...(start ? { start } : {}) });
}

/** Is the record `text` at `file` left behind by a holder that is gone (invariant 1)? `key` is where this process would list it. */
function isStale(key: string, file: string, text: string): boolean {
  let rec: { pid?: unknown; token?: unknown; start?: unknown };
  try {
    rec = JSON.parse(text) as typeof rec;
    if (typeof rec !== 'object' || rec === null) rec = {};
  } catch {
    try { return Date.now() - statSync(file).mtimeMs > UNREADABLE_LOCK_MS; } catch { return false; } // gone: look again
  }
  if (typeof rec.pid !== 'number') return true;
  if (rec.pid === process.pid) { const mine = held.get(key); return mine === undefined || mine !== rec.token; }
  if (!livePid(rec.pid)) return true;
  // The pid lives, but as another process when its start time is not the one written (a lock written without one,
  // or a system without /proc, goes by the pid alone).
  const start = typeof rec.start === 'string' ? processStart(rec.pid) : undefined;
  return start !== undefined && start !== rec.start;
}

/** Makes `file` with `text` in one step: no reader sees it half written. */
function createExclusive(file: string, text: string, token: string): true | 'exists' | Error {
  const temporary = `${file}.${token}.tmp`;
  try { writeFileSync(temporary, text, { flag: 'wx' }); } catch (error) { return error as Error; }
  try {
    linkSync(temporary, file);
    return true;
  } catch (error) {
    if (code(error) === 'EEXIST') return 'exists';
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK'].includes(code(error) ?? '')) return error as Error;
    // A file system without hard links: O_EXCL and a write, the window the UNREADABLE_LOCK_MS rule is for.
    let fd: number;
    try { fd = openSync(file, 'wx'); } catch (opening) { return code(opening) === 'EEXIST' ? 'exists' : opening as Error; }
    try { writeSync(fd, text); } catch (writing) { closeSync(fd); rmSync(file, { force: true }); return writing as Error; }
    closeSync(fd);
    return true;
  } finally { rmSync(temporary, { force: true }); }
}

/** Takes the reclaim guard of `file`, or returns null while another live process has it (invariant 2). */
function takeGuard(file: string, token: string): (() => void) | null {
  const guard = `${file}.reclaim`;
  const key = resolve(guard);
  const temporary = `${file}.${token}.reclaiming`;
  try {
    mkdirSync(temporary);
    writeFileSync(join(temporary, token), record(token));
  } catch { rmSync(temporary, { recursive: true, force: true }); return null; }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(temporary, guard); // onto a free name, or an empty directory a recoverer is about to rmdir
        held.set(key, token);
        return () => releaseGuard(guard, key, token);
      } catch (error) {
        if (code(error) === 'ENOENT') return null; // the lock's directory is gone
      }
      let owners: string[];
      try { owners = readdirSync(guard); } catch { continue; } // gone meanwhile, or not a directory of ours
      if (owners.length === 0) continue; // being recovered: the rename above replaces it
      if (owners.length !== 1) return null; // not made by this code
      const owner = join(guard, owners[0]!);
      let text = '';
      try { text = readFileSync(owner, 'utf8'); } catch (error) { if (code(error) === 'ENOENT') continue; }
      if (!isStale(key, owner, text)) return null; // a live reclaimer: it takes the lock, we are late
      try { unlinkSync(owner); } catch { /* another recoverer did */ }
      try { rmdirSync(guard); } catch { /* ENOTEMPTY: another reclaimer's directory took the name */ }
    }
    return null;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function releaseGuard(guard: string, key: string, token: string): void {
  if (held.get(key) !== token) return;
  held.delete(key);
  try { unlinkSync(join(guard, token)); } catch { /* already gone */ }
  try { rmdirSync(guard); } catch { /* another reclaimer's directory took the name */ }
}

/**
 * One try at the lock `file`: its release, `'busy'` while a live process holds it (or is reclaiming it), or the file
 * system error that stopped the try (no directory, no permission, no space). Never throws.
 */
export function tryFileLock(file: string): (() => void) | 'busy' | Error {
  const key = resolve(file);
  const token = randomBytes(8).toString('hex');
  const mine = record(token);
  for (let attempt = 0; attempt < 4; attempt++) {
    const created = createExclusive(file, mine, token);
    if (created === true) {
      held.set(key, token);
      return releaseLock(file, key, token, mine);
    }
    if (created !== 'exists') return created;
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch (error) {
      if (code(error) === 'ENOENT') continue; // released meanwhile
      return error as Error;
    }
    if (!isStale(key, file, text)) return 'busy';
    const guard = takeGuard(file, token);
    if (!guard) return 'busy';
    try {
      let again: string | undefined;
      try { again = readFileSync(file, 'utf8'); } catch { again = undefined; }
      if (again === text) unlinkSync(file); // still the record judged stale: its holder is gone, and only we may remove it now
    } catch { /* ENOENT: nothing to remove */ } finally { guard(); }
  }
  return 'busy'; // lost the race to create it after each reclaim
}

/** The lock `file`, or null when it cannot be had now (held, being reclaimed, or a file system error). */
export function acquireFileLock(file: string): (() => void) | null {
  const attempt = tryFileLock(file);
  return typeof attempt === 'function' ? attempt : null;
}

/** release (invariant 3): only the lock this call took, only once. */
function releaseLock(file: string, key: string, token: string, mine: string): () => void {
  return () => {
    if (held.get(key) !== token) return;
    held.delete(key);
    try {
      if (readFileSync(file, 'utf8') === mine) unlinkSync(file);
    } catch { /* already gone */ }
  };
}
