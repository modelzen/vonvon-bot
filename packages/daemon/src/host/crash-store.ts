import { redactTokens } from '../core/token-redact';
// Crash records, the host run marker and the resume request under `<data root>/crash/` (product.md 3.10).
// No import of config/paths or core/logger: the crash handler and its tests bundle this file into child processes.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, uptime } from 'node:os';
import { join } from 'node:path';
import { CRASH_KINDS, type CrashEntry } from '@vonvon/protocol';
import { z } from 'zod';

export const CRASH_WINDOW_MS = 600_000;
export const CRASH_PAUSE_COUNT = 3;
/** EX_SOFTWARE: restarted by `Restart=on-failure` and `KeepAlive{SuccessfulExit=false}`, told apart from 1 and 75. */
export const CRASH_EXIT_CODE = 70;
/** A supervised bot child that finds its bot's lock still held by the previous child, which is draining after its host
 * died (s18 D2): not a crash, the supervisor retries with backoff. */
export const BOT_LOCK_BUSY_EXIT = 75;
export const RESUME_MAX_AGE_MS = 120_000;
export const CRASH_SHOWN_MS = 24 * 60 * 60_000;
const KEEP_PER_SCOPE = 50;
const KEEP_MS = 30 * 24 * 60 * 60_000;
const TMP_MAX_AGE_MS = 60 * 60_000;
const LIST_LIMIT = 200;
const MAX_FILE_BYTES = 16 * 1024;
export const APP_ID = /^cli_[A-Za-z0-9_-]{1,200}$/;
const RECORD_NAME = /^(host|bot-[0-9a-f]{12})-(\d{8}T\d{9}Z)-(\d{1,10})-([0-9a-f]{8})\.json$/;
const TMP_NAME = /^\..+\.tmp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = z.string().datetime();
/** An uncaught exception, an unhandled rejection, a failure of `daemon run` that no stop asked for, or a forced end
 * (kill -9, out of memory, an abort, a signal the supervisor saw). The kinds and texts live in the protocol (s18a). */
const crashKindSchema = z.enum(CRASH_KINDS);
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

const NODE_TRAILER = /^Node\.js v\d/;
const CARET = /^\s*\^+\s*$/;
const ERROR_HEAD = /^[A-Za-z_$][\w$.]*(?:Error|Exception|Rejection)\b/;
/** A fatal exit's reason from a child's last non-empty stderr lines, newest last. Node's own printout of an uncaught
 * error (where, the source line, a caret, the error, its stack, `Node.js vX`) gives the error's first line, not the
 * version (s18b review 2); without the caret, its last error-like line. Any other ending gives the last line. */
export function stderrReason(lines: readonly string[]): string | undefined {
  const last = lines[lines.length - 1];
  if (last === undefined || !NODE_TRAILER.test(last.trim())) return last;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (!CARET.test(lines[i] ?? '')) continue;
    const error = lines[i + 1];
    if (error !== undefined && !NODE_TRAILER.test(error.trim())) return error;
    break;
  }
  for (let i = lines.length - 2; i >= 0; i--) if (ERROR_HEAD.test(lines[i] ?? '')) return lines[i];
  return undefined;
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

/** A write cut short (a full disk) or a failed rename leaves no temp file behind. 0600; also bot/restart-dropped's. */
export function writeAtomicSync(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${name}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, join(dir, name));
  } catch (error) { try { unlinkSync(tmp); } catch { /* the write or rename error is the one to report */ } throw error; }
}

export function writeCrashRecordSync(root: string, record: CrashRecord): string {
  const parsed = crashRecordSchema.parse(record);
  const name = `${crashScopeKey(parsed.scope, parsed.appId)}-${parsed.at.replace(/[-:.]/g, '')}-${parsed.pid}-${randomBytes(4).toString('hex')}.json`;
  if (!RECORD_NAME.test(name)) throw new Error(`Unexpected crash record name ${name}.`);
  writeAtomicSync(crashDir(root), name, redactTokens(JSON.stringify(parsed)));
  return name;
}

type Named = { name: string; key: string; stampMs: number; pid: number };
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
    named.push({ name, key: match[1] ?? '', stampMs, pid: Number(match[3]) });
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

/** File names only: a record of this scope key and PID written since the process started (a PID reused within the
 * 30 days kept has older stamps). Throws on an unreadable directory. */
export function hasCrashRecordFor(root: string, key: string, pid: number, startedAt: number): boolean {
  return recordNames(root).some(entry => entry.key === key && entry.pid === pid && entry.stampMs >= startedAt - 5000);
}
/** The newest such record itself, for the owner's private message (s18b); undefined when none can be read. */
export function crashRecordFor(root: string, key: string, pid: number, startedAt: number): CrashRecord | undefined {
  for (const entry of recordNames(root)) {
    if (entry.key !== key || entry.pid !== pid || entry.stampMs < startedAt - 5000) continue;
    try {
      const raw = readFileSync(join(crashDir(root), entry.name), 'utf8');
      const parsed = raw.length <= MAX_FILE_BYTES ? crashRecordSchema.safeParse(JSON.parse(raw)) : undefined;
      if (parsed?.success) return parsed.data;
    } catch { /* gone or not JSON: try the next */ }
  }
  return undefined;
}

/** Crashes of one chain while running (not during a requested stop or restart) in the last 10 minutes of uptime: the
 * host's, or with `appId` that bot's since its last 恢复运行 (`sinceUptimeMs`). */
export function countInWindow(records: readonly CrashRecord[], options: { chainId: string; nowUptimeMs: number; appId?: string; sinceUptimeMs?: number }): number {
  return records.filter(record => {
    const age = options.nowUptimeMs - record.sysUptimeMs;
    return (options.appId ? record.scope === 'bot' && record.appId === options.appId : record.scope === 'host')
      && record.chainId === options.chainId && (record.during ?? 'run') === 'run' && age >= -5000 && age <= CRASH_WINDOW_MS
      && (options.sinceUptimeMs === undefined || record.sysUptimeMs > options.sinceUptimeMs);
  }).length;
}

/** The snapshot's view of a record: no run, chain, PID, version or boot id. */
export const crashEntry = (record: CrashRecord): CrashEntry => ({
  at: Date.parse(record.at), kind: record.kind, ...(record.appId ? { appId: record.appId } : {}),
  ...(record.uptimeMs !== undefined ? { uptimeMs: record.uptimeMs } : {}), ...(record.paused ? { paused: true } : {}), reason: record.reason,
});

/** The records for every snapshot rebuild (every 5 s): one stat of `crash/`, a listing only when its mtime moved or 30 s
 * passed (a coarse file system clock can hide a write), then the last 24 hours, newest 20. `invalidate()` lists again
 * at the next read: the supervisor calls it when a child exits and after each record it writes. */
export type CrashRecordCache = ((now: number) => CrashEntry[]) & { invalidate(): void };
export function createCrashRecordCache(root: string, seams: { stat?: (dir: string) => number; list?: () => CrashRecord[] } = {}): CrashRecordCache {
  const stat = seams.stat ?? ((dir: string) => statSync(dir).mtimeMs);
  const list = seams.list ?? (() => listCrashRecords(root, { limit: 50 }));
  let cached: { mtimeMs: number; readAt: number; records: CrashRecord[] } | undefined;
  const read = (now: number): CrashEntry[] => {
    try {
      const mtimeMs = stat(crashDir(root));
      if (!cached || cached.mtimeMs !== mtimeMs || now - cached.readAt >= 30_000) cached = { mtimeMs, readAt: now, records: list() };
    } catch { cached = undefined; }
    return (cached?.records ?? []).filter(record => now - Date.parse(record.at) <= CRASH_SHOWN_MS).slice(0, 20).map(crashEntry);
  };
  return Object.assign(read, { invalidate: () => { cached = undefined; } });
}

/** `crash/bot-pauses.json`: the bots paused in one chain and when each last resumed. Only the host writes it. */
const botPauseSchema = z.object({ pausedAt: iso.optional(), pauseCrashes: z.number().int().positive().optional(), resumedUptimeMs: z.number().int().nonnegative().optional() }).strict();
export type BotPauseState = z.infer<typeof botPauseSchema>;
const botPausesSchema = z.object({ v: z.literal(1), chainId: z.string().uuid(), bots: z.record(z.string().regex(APP_ID), botPauseSchema) }).strict();
const botPausesPath = (root: string): string => join(crashDir(root), 'bot-pauses.json');
/** Empty for another chain, a missing or a damaged file; `onCorrupt` hears of a file that is there but not JSON or not
 * of this shape, for the supervisor's log (no logger here). */
export function readBotPauses(root: string, chainId: string, onCorrupt?: () => void): Record<string, BotPauseState> {
  let raw: string;
  try { raw = readFileSync(botPausesPath(root), 'utf8'); } catch { return {}; }
  try {
    const parsed = botPausesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.chainId === chainId ? parsed.data.bots : {};
  } catch { /* not JSON */ }
  onCorrupt?.();
  return {};
}
export function writeBotPausesSync(root: string, chainId: string, bots: Record<string, BotPauseState>): void {
  writeAtomicSync(crashDir(root), 'bot-pauses.json', JSON.stringify(botPausesSchema.parse({ v: 1, chainId, bots })));
}

/** `crash/notices.json` (s18b): when each bot last got a crash message through to its owner, for the limit of one in 10
 * minutes. Only the host writes it; entries older than a day are dropped at each write. */
const noticeStampSchema = z.object({ at: iso, uptimeMs: z.number().int().nonnegative(), bootId: z.string().max(64).optional() }).strict();
export type NoticeStamp = z.infer<typeof noticeStampSchema>;
const noticesSchema = z.object({ v: z.literal(1), bots: z.record(z.string().regex(APP_ID), noticeStampSchema) }).strict();
const noticesPath = (root: string): string => join(crashDir(root), 'notices.json');
/** Empty for a missing, unreadable or damaged file; `onCorrupt` hears of one that is there but not of this shape. */
export function readNotices(root: string, onCorrupt?: () => void): Record<string, NoticeStamp> {
  let raw: string;
  try { raw = readFileSync(noticesPath(root), 'utf8'); } catch { return {}; }
  try {
    const parsed = noticesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.bots;
  } catch { /* not JSON */ }
  onCorrupt?.();
  return {};
}
export function writeNoticesSync(root: string, bots: Record<string, NoticeStamp>, now: number): void {
  const kept = Object.fromEntries(Object.entries(bots).filter(([, stamp]) => now - Date.parse(stamp.at) <= CRASH_SHOWN_MS));
  writeAtomicSync(crashDir(root), 'notices.json', JSON.stringify(noticesSchema.parse({ v: 1, bots: kept })));
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

export type CrashSummary = {
  paused?: { since: string; crashes: number; running: boolean };
  pausedBots: Array<{ appId: string; since: string; crashes: number }>;
  crashes: CrashRecord[];
};
/** For `vonvon daemon status`: read only, never creates the directory, never asks a service manager. */
export function readCrashSummary(root: string, options: { running: boolean; ownerPid?: number; now: number; clock?: Clock }): CrashSummary {
  let marker: RunMarker | null = null;
  try { const read = readRunMarker(root); marker = read === 'corrupt' ? null : read; } catch { /* unreadable: no pause shown */ }
  // Another live daemon's marker is not this one's; with nothing running it is the run that ended, if in this boot.
  const live = marker && (options.running ? marker.pid === options.ownerPid : !startedBeforeThisBoot(marker, options.clock ?? systemClock)) ? marker : null;
  const paused = live?.state === 'paused'
    ? { since: live.pausedAt ?? live.startedAt, crashes: live.pauseCrashes ?? CRASH_PAUSE_COUNT, running: options.running } : undefined;
  const pausedBots = live ? Object.entries(readBotPauses(root, live.chainId)).flatMap(([appId, bot]) =>
    bot.pausedAt ? [{ appId, since: bot.pausedAt, crashes: bot.pauseCrashes ?? CRASH_PAUSE_COUNT }] : []) : [];
  let crashes: CrashRecord[] = [];
  try { crashes = listCrashRecords(root, { limit: 20 }).filter(record => options.now - Date.parse(record.at) <= CRASH_SHOWN_MS).slice(0, 10); }
  catch { /* unreadable directory */ }
  return { ...(paused ? { paused } : {}), pausedBots, crashes };
}

/** Pause messages awaiting a conclusive result. Only the host writes; UUID identifies the whole send job. */
const unsentBase = { uuid: z.string().regex(/^vc-[0-9a-f]{32}$/), chainId: z.string().uuid(), at: iso,
  crashes: z.number().int().positive(), reason: z.string().max(1000).optional() };
export const unsentNoticeSchema = z.discriminatedUnion('kind', [
  z.object({ ...unsentBase, kind: z.literal('host-paused'), bots: z.array(z.string()) }).strict(),
  z.object({ ...unsentBase, kind: z.literal('bot-paused'), appId: z.string().regex(APP_ID), name: z.string(), reason: z.string().max(1000) }).strict(),
]);
export type UnsentNotice = z.infer<typeof unsentNoticeSchema>;
const unsentSchema = z.object({ v: z.literal(1), items: z.array(unsentNoticeSchema).max(20) }).strict();
const unsentPath = (root: string): string => join(crashDir(root), 'unsent-notices.json');
export function readUnsentNotices(root: string, onCorrupt?: () => void): UnsentNotice[] {
  let raw: string;
  try { raw = readFileSync(unsentPath(root), 'utf8'); } catch (error) { if (isMissing(error)) return []; throw error; }
  try {
    const parsed = unsentSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data.items;
  } catch { /* malformed JSON */ }
  onCorrupt?.();
  return [];
}
export function writeUnsentNoticesSync(root: string, items: readonly UnsentNotice[], now: number): void {
  const kept = items.filter(item => now - Date.parse(item.at) <= CRASH_SHOWN_MS).slice(-20);
  if (!kept.length) { try { unlinkSync(unsentPath(root)); } catch (error) { if (!isMissing(error)) throw error; } return; }
  writeAtomicSync(crashDir(root), 'unsent-notices.json', JSON.stringify(unsentSchema.parse({ v: 1, items: kept })));
}
