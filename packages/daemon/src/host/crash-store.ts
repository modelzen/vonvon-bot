// Crash records, the host run marker and the resume request under `<data root>/crash/` (product.md 3.10).
// No import of config/paths or core/logger: the crash handler and its tests bundle this file into child processes.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const CRASH_WINDOW_MS = 600_000;
export const CRASH_PAUSE_COUNT = 3;
/** EX_SOFTWARE: restarted by `Restart=on-failure` and `KeepAlive{SuccessfulExit=false}`, told apart from 1 and 75. */
export const CRASH_EXIT_CODE = 70;
export const RESUME_MAX_AGE_MS = 120_000;
export const CRASH_SHOWN_MS = 24 * 60 * 60_000;
const KEEP_PER_SCOPE = 50;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const TMP_MAX_AGE_MS = 60 * 60_000;
const LIST_LIMIT = 200;
const MAX_FILE_BYTES = 16 * 1024;
const APP_ID = /^cli_[A-Za-z0-9_-]{1,200}$/;
const RECORD_NAME = /^(host|bot-[0-9a-f]{12})-(\d{8}T\d{9}Z)-(\d{1,10})-([0-9a-f]{8})\.json$/;
const TMP_NAME = /^\..+\.tmp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = z.string().datetime();
/** An uncaught exception, an unhandled rejection, a failure of `daemon run` that no stop asked for, or a forced end
 * (kill -9, out of memory, an abort) found by the next start. s18 moves the kinds and texts into the protocol. */
const crashKindSchema = z.enum(['exception', 'rejection', 'fatal', 'forced']);
export type CrashKind = z.infer<typeof crashKindSchema>;
export const CRASH_KIND_TEXT: Record<CrashKind, string> = {
  exception: '程序出错', rejection: '程序出错（未处理的异步错误）', fatal: '出错退出', forced: '被系统强制结束',
};
export const crashRecordSchema = z.object({
  v: z.literal(1), at: iso, sysUptimeMs: z.number().finite().nonnegative(), bootId: z.string().max(64).optional(),
  kind: crashKindSchema, scope: z.enum(['host', 'bot']), appId: z.string().regex(APP_ID).optional(),
  pid: z.number().int().positive(), runId: z.string().uuid(), chainId: z.string().uuid(), startedAt: iso,
  uptimeMs: z.number().int().nonnegative().optional(), version: z.string().min(1).max(40), managed: z.string().max(20).nullable(),
  during: z.enum(['run', 'stop', 'restart']).optional(), paused: z.boolean().optional(),
  reason: z.string().min(1).max(200), errorName: z.string().max(60).optional(),
}).strict();
export type CrashRecord = z.infer<typeof crashRecordSchema>;
export const runMarkerSchema = z.object({
  v: z.literal(1), runId: z.string().uuid(), chainId: z.string().uuid(), pid: z.number().int().positive(), startedAt: iso,
  startUptimeMs: z.number().int().nonnegative(), aliveAt: iso, aliveUptimeMs: z.number().int().nonnegative(),
  bootId: z.string().max(64).optional(), version: z.string().min(1).max(40), managed: z.string().max(20).nullable(),
  state: z.enum(['running', 'paused']), pausedAt: iso.optional(), pauseCrashes: z.number().int().positive().optional(),
}).strict();
export type RunMarker = z.infer<typeof runMarkerSchema>;
const resumeSchema = z.object({ v: z.literal(1), at: iso, pid: z.number().int().positive() }).strict();

/** Wall time, uptime since boot (CLOCK_BOOTTIME on Linux; `time() - kern.boottime` on macOS) and the boot's id. */
export interface Clock { now(): number; uptimeMs(): number; bootId(): string | undefined }

type BootIdSources = { readFile: (path: string) => string; exec: (file: string, args: string[]) => string };
const bootIdSources: BootIdSources = {
  readFile: path => readFileSync(path, 'utf8'),
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }),
};
/** Linux: the kernel's boot id. macOS: `kern.bootsessionuuid`, one sysctl spawn, so callers memoize it. */
export function readBootId(platform: NodeJS.Platform = process.platform, sources: BootIdSources = bootIdSources): string | undefined {
  try {
    const raw = platform === 'linux' ? sources.readFile('/proc/sys/kernel/random/boot_id')
      : platform === 'darwin' ? sources.exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']) : '';
    const id = String(raw).trim();
    return UUID.test(id) ? id : undefined;
  } catch { return undefined; }
}
export function createSystemClock(readId: () => string | undefined = () => readBootId()): Clock {
  let boot: { id: string | undefined } | undefined;
  return { now: () => Date.now(), uptimeMs: () => Math.round(uptime() * 1000), bootId: () => (boot ??= { id: readId() }).id };
}
export const systemClock = createSystemClock();

/** A run that began in an earlier boot. Ids decide when both are known; else the uptime rule, which a forward
 * clock step of more than 5 s after the start defeats on macOS (kern.boottime moves with the clock). */
export function startedBeforeThisBoot(run: { startedAt: string; bootId?: string }, clock: Clock): boolean {
  const boot = clock.bootId();
  if (run.bootId && boot) return run.bootId !== boot;
  return Date.parse(run.startedAt) < clock.now() - clock.uptimeMs() - 5000;
}

export const crashDir = (root: string): string => join(root, 'crash');
export const crashScopeKey = (scope: 'host' | 'bot', appId?: string): string =>
  scope === 'host' ? 'host' : `bot-${createHash('sha256').update(appId ?? '').digest('hex').slice(0, 12)}`;
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
function reasonText(value: unknown): string {
  try {
    if (value instanceof Error) {
      const message = typeof value.message === 'string' ? value.message : '';
      const name = typeof value.name === 'string' ? value.name : '';
      return message && name ? `${name}: ${message}` : message || name;
    }
    if (typeof value === 'symbol') return value.toString();
    return String(value);
  } catch { return ''; }
}
/** The first line, with the home folder, Feishu ids, URL credentials and anything token-like taken out; ≤ 200. */
export function sanitizeReason(value: unknown, home = homedir()): string {
  let text = (reasonText(value).split(/\r\n|\r|\n/)[0] ?? '').replace(CONTROL, '').trim();
  if (home.length > 1) text = text.split(home).join('~');
  text = text.replace(/\/(?:Users|home)\/[^/\s'"`:]+/g, '~')
    .replace(/(?:oc|om|omt|ou|on)_[A-Za-z0-9_-]{7,}/g, id => id.slice(-6))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]');
  if (text.length > 200) {
    text = text.slice(0, 200);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return text || '(无说明)';
}
/** `TypeError`, or `Error:EADDRINUSE` with a system error code; nothing else of the error. */
export function crashErrorName(value: unknown): string | undefined {
  if (!(value instanceof Error) || typeof value.name !== 'string' || !/^[A-Za-z][\w.]{0,40}$/.test(value.name)) return undefined;
  const code = (value as { code?: unknown }).code;
  return (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `${value.name}:${code}` : value.name).slice(0, 60);
}

function writeAtomicSync(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  try { renameSync(tmp, join(dir, name)); }
  catch (error) { try { unlinkSync(tmp); } catch { /* the rename error is the one to report */ } throw error; }
}

export function writeCrashRecordSync(root: string, record: CrashRecord): string {
  const parsed = crashRecordSchema.parse(record);
  const name = `${crashScopeKey(parsed.scope, parsed.appId)}-${parsed.at.replace(/[-:.]/g, '')}-${parsed.pid}-${randomBytes(4).toString('hex')}.json`;
  if (!RECORD_NAME.test(name)) throw new Error(`Unexpected crash record name ${name}.`);
  writeAtomicSync(crashDir(root), name, JSON.stringify(parsed));
  return name;
}

type Named = { name: string; key: string; stampMs: number };
function recordNames(root: string): Named[] {
  let entries: string[];
  try { entries = readdirSync(crashDir(root)); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const named: Named[] = [];
  for (const name of entries) {
    const match = RECORD_NAME.exec(name);
    const stamp = match?.[2];
    if (!match || !stamp) continue;
    const stampMs = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15), +stamp.slice(15, 18));
    named.push({ name, key: match[1] ?? '', stampMs });
  }
  return named.sort((a, b) => b.stampMs - a.stampMs || (a.name < b.name ? 1 : -1));
}

/** Newest first; `scope` is a scope key (`host`, `bot-<hash>`). Unreadable, oversized or foreign files are skipped. */
export function listCrashRecords(root: string, options: { scope?: string; limit?: number } = {}): CrashRecord[] {
  const names = recordNames(root).filter(entry => !options.scope || entry.key === options.scope).slice(0, options.limit ?? LIST_LIMIT);
  const records: CrashRecord[] = [];
  for (const { name } of names) {
    try {
      const raw = readFileSync(join(crashDir(root), name), 'utf8');
      if (raw.length > MAX_FILE_BYTES) continue;
      const parsed = crashRecordSchema.safeParse(JSON.parse(raw));
      if (parsed.success) records.push(parsed.data);
    } catch { /* gone (pruned meanwhile) or not JSON */ }
  }
  return records;
}

/** Per scope the newest 50 within 30 days; temp files older than an hour. Host only. */
export function pruneCrashRecords(root: string, options: { now: number; scope?: string }): number {
  let removed = 0;
  const remove = (name: string): void => {
    try { unlinkSync(join(crashDir(root), name)); removed++; }
    catch (error) { if (!isMissing(error)) throw error; }
  };
  if (!options.scope) {
    let entries: string[] = [];
    try { entries = readdirSync(crashDir(root)); }
    catch (error) { if (!isMissing(error)) throw error; }
    for (const name of entries) {
      if (!TMP_NAME.test(name)) continue;
      try { if (options.now - statSync(join(crashDir(root), name)).mtimeMs > TMP_MAX_AGE_MS) remove(name); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  const kept = new Map<string, number>();
  for (const entry of recordNames(root)) {
    if (options.scope && entry.key !== options.scope) continue;
    const count = (kept.get(entry.key) ?? 0) + 1;
    kept.set(entry.key, count);
    if (count > KEEP_PER_SCOPE || options.now - entry.stampMs > KEEP_MS) remove(entry.name);
  }
  return removed;
}

/** Host crashes of one chain while running (not during a requested stop or restart) in the last 10 minutes of uptime. */
export function countInWindow(records: readonly CrashRecord[], options: { chainId: string; nowUptimeMs: number }): number {
  return records.filter(record => {
    const age = options.nowUptimeMs - record.sysUptimeMs;
    return record.scope === 'host' && record.chainId === options.chainId && (record.during ?? 'run') === 'run'
      && age >= -5000 && age <= CRASH_WINDOW_MS;
  }).length;
}

const markerPath = (root: string): string => join(crashDir(root), 'run.json');
export function readRunMarker(root: string): RunMarker | null | 'corrupt' {
  let raw: string;
  try { raw = readFileSync(markerPath(root), 'utf8'); }
  catch (error) { if (isMissing(error)) return null; throw error; }
  try {
    const parsed = runMarkerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'corrupt';
  } catch { return 'corrupt'; }
}
export function writeRunMarkerSync(root: string, marker: RunMarker): void {
  writeAtomicSync(crashDir(root), 'run.json', JSON.stringify(runMarkerSchema.parse(marker)));
}
/** Only the marker of this run: a later run's marker is never removed. */
export function removeRunMarkerSync(root: string, runId: string): void {
  const marker = readRunMarker(root);
  if (marker === null || marker === 'corrupt' || marker.runId !== runId) return;
  try { unlinkSync(markerPath(root)); }
  catch (error) { if (!isMissing(error)) throw error; }
}

const resumePath = (root: string): string => join(crashDir(root), 'resume.json');
/** Written by `vonvon daemon restart` while nothing runs; returns the request time. */
export function writeResumeRequest(root: string, now = Date.now()): number {
  writeAtomicSync(crashDir(root), 'resume.json', JSON.stringify({ v: 1, at: new Date(now).toISOString(), pid: process.pid }));
  return now;
}
/** Consumes the request: honoured only within 2 minutes, so a CLI killed before it started anything resets nothing later. */
export function takeResumeRequest(root: string, now: number): 'none' | 'fresh' | 'stale' {
  let raw: string;
  try { raw = readFileSync(resumePath(root), 'utf8'); }
  catch (error) { if (isMissing(error)) return 'none'; throw error; }
  try { unlinkSync(resumePath(root)); }
  catch (error) { if (!isMissing(error)) throw error; }
  try {
    const parsed = resumeSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return 'stale';
    const age = now - Date.parse(parsed.data.at);
    return age >= -5000 && age <= RESUME_MAX_AGE_MS ? 'fresh' : 'stale';
  } catch { return 'stale'; }
}
/** Removes the request written at `at`, and no other. */
export function removeResumeRequest(root: string, at: number): void {
  try {
    const parsed = resumeSchema.safeParse(JSON.parse(readFileSync(resumePath(root), 'utf8')));
    if (parsed.success && Date.parse(parsed.data.at) === at) unlinkSync(resumePath(root));
  } catch { /* already consumed */ }
}

export type CrashSummary = { paused?: { since: string; crashes: number; running: boolean }; crashes: CrashRecord[] };
/** For `vonvon daemon status`: read only, never creates the directory, never asks a service manager. */
export function readCrashSummary(root: string, options: { running: boolean; ownerPid?: number; now: number; clock?: Clock }): CrashSummary {
  let marker: RunMarker | null = null;
  try { const read = readRunMarker(root); marker = read === 'corrupt' ? null : read; } catch { /* unreadable: no pause shown */ }
  // Another live daemon's paused marker is not this one's; with nothing running it is the paused run that ended, if in this boot.
  const paused = marker?.state === 'paused' && (options.running ? marker.pid === options.ownerPid : !startedBeforeThisBoot(marker, options.clock ?? systemClock))
    ? { since: marker.pausedAt ?? marker.startedAt, crashes: marker.pauseCrashes ?? CRASH_PAUSE_COUNT, running: options.running } : undefined;
  let crashes: CrashRecord[] = [];
  try { crashes = listCrashRecords(root, { limit: 20 }).filter(record => options.now - Date.parse(record.at) <= CRASH_SHOWN_MS).slice(0, 10); }
  catch { /* unreadable directory */ }
  return { ...(paused ? { paused } : {}), crashes };
}
