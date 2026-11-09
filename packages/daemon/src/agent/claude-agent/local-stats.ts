import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { paths } from '../../config/paths';
import { log } from '../../core/logger';
import { writeFileAtomic } from '../../server/atomic-file';
import type { AccountProfileStats, ClaudeLocalStats } from '../types';

/**
 * Claude Code's own /usage → Stats, recounted from the host's transcripts with the definitions of the installed
 * Claude Code (2.1.319, `to`/`Xr`/`Sm`/`Jr` in its bundle): the same files and lines, UTC day keys, sessions,
 * streaks and start hours. Only counting fields are read; message text is never kept or logged.
 *
 * Results are cached per transcript (size, mtime) in Vonvon's data dir and recombined on every read, so today and
 * the streak always follow the clock. Like Claude Code's own stats cache (`Cm`, `yi`, `Sm`), the days through the
 * yesterday of the last scan are settled: a changed transcript keeps its settled days and its session as first
 * counted, and only later days come from the new read. So a transcript Claude Code cleans up later
 * (cleanupPeriodDays) keeps counting, and one past 100 MiB keeps the days its tail no longer reaches.
 *
 * What was cleaned up before the first scan comes from Claude Code's own stats cache (`stats-cache.json` next to
 * `projects/`), read only: never written, locked or kept beyond the numbers used (N2b). Through its lastComputedDate
 * both it and these transcripts count only what each of them read, so every day, model, session total and hour takes
 * the larger of the two, which never counts anything twice; later days come from the transcripts alone, as in
 * Claude Code's /usage.
 */

const COUNTED_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
/** Cheap pre-check before JSON.parse: a counted line has one of these as its top-level type. */
const COUNTED_LINE = /"type"\s*:\s*"(?:user|assistant|attachment|system)"/;
const SYNTHETIC_MODEL = '<synthetic>';
const CHUNK_BYTES = 1 << 18;
const CONCURRENCY = 2;
const REFRESH_MS = 60_000;
const CACHE_VERSION = 2;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULTS = {
  /** Claude Code reads only the last 100 MiB of a larger transcript and drops the cut first line. */
  tailBytes: 100 * 1024 * 1024,
  now: (): Date => new Date(),
};
let opts = DEFAULTS;

/** For tests: a smaller tail window and a fixed clock. */
export function configureClaudeLocalStats(overrides: Partial<typeof DEFAULTS>): void {
  opts = { ...DEFAULTS, ...overrides };
}

const time = z.number().min(-8.64e15).max(8.64e15);
const day = z.string().refine(isDay);
const fileSchema = z.object({
  size: z.number(),
  mtimeMs: time,
  /** a sub-agent transcript: its tokens count, its lines and session do not */
  sub: z.literal(true).optional(),
  /** no longer on disk */
  gone: z.literal(true).optional(),
  /** first and last counted line, and how many lines count; absent when the transcript counts nothing */
  first: time.optional(),
  last: time.optional(),
  lines: z.number().optional(),
  /** first seen after the day its session started was settled: Claude Code never counts that session, only later days */
  uncounted: z.literal(true).optional(),
  /** UTC day → main-session messages and tokens per model */
  days: z.record(day, z.object({ messages: z.number().optional(), tokens: z.record(z.string(), z.number()).optional() })),
});
const cacheSchema = z.object({
  version: z.literal(CACHE_VERSION), root: z.string(),
  /** Claude Code's lastComputedDate: days through this one are settled */
  settled: day.optional(),
  files: z.record(z.string(), fileSchema),
});
type FileStats = z.infer<typeof fileSchema>;
type Saved = { files: Map<string, FileStats>; settled?: string };

const STATS_CACHE = 'stats-cache.json';
/** Claude Code adds a few hundred bytes a day; a file this big is not its stats cache. */
const STATS_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** Claude Code's `Qo`: per-day tokens of an older version it rebuilds from the transcripts left, keeping its totals. */
const DAILY_TOKENS_VERSION = 5;
const tally = z.number().finite().nonnegative();
/** The fields of Claude Code's stats cache (`rn`, `pm`, `Hr`; versions 1 to 5) that are used here; others are dropped. */
const statsCacheSchema = z.object({
  version: z.number().int().min(1).max(5),
  lastComputedDate: z.string().nullish(),
  dailyActivity: z.array(z.object({ date: day, messageCount: tally })),
  dailyModelTokens: z.array(z.object({ date: day, tokensByModel: z.record(z.string(), tally) })),
  dailyModelTokensVersion: z.number().optional(),
  modelUsage: z.record(z.string(), z.object({
    inputTokens: tally.optional(), outputTokens: tally.optional(), cacheReadInputTokens: tally.optional(), cacheCreationInputTokens: tally.optional(),
  })).optional(),
  totalSessions: tally,
  totalMessages: tally,
  longestSession: z.object({ duration: tally, messageCount: tally }).nullish(),
  hourCounts: z.record(z.string().regex(/^(?:1?\d|2[0-3])$/), tally).optional(),
});
type StatsCache = z.infer<typeof statsCacheSchema>;
type Day = { messages: number; tokens: Map<string, number> };
type Longest = { ms: number; lines: number };
/** What Claude Code's stats cache counts through `asOf`, its lastComputedDate; days after it are not used. */
type Backfill = { asOf: string; days: Map<string, Day>; sessions: number; hours: number[]; longest?: Longest; models: Map<string, number> };
/** The last read of the stats cache, by size and mtime: unchanged, it is not read again. */
type StatsCacheRead = { size: number; mtimeMs: number; backfill?: Backfill };

export type ClaudeLocalProfile = Pick<AccountProfileStats, 'dailyBuckets' | 'lifetimeTokens' | 'peakDailyTokens' | 'currentStreakDays' | 'longestStreakDays'>
  & { localStats: ClaudeLocalStats };

type State = {
  root: string;
  controller: AbortController;
  /** undefined until the first scan (or the saved cache) is in */
  files?: Map<string, FileStats>;
  settled?: string;
  /** no transcript on disk at the last look: Claude Code then shows no stats at all */
  empty?: boolean;
  statsCache?: StatsCacheRead;
  /** why the stats cache was last unusable, logged once until that changes */
  statsCacheCode?: string;
  running?: Promise<void>;
  startedAt?: number;
};
let state: State | undefined;

/** Starts a background rescan of `root` (`<config dir>/projects`) unless one ran within the last minute. Never rejects. */
export function refreshClaudeLocalStats(root: string, force = false): Promise<void> {
  if (state?.root !== root) {
    state?.controller.abort();
    state = { root, controller: new AbortController() };
  }
  const current = state;
  if (current.running) return current.running;
  if (!force && current.startedAt !== undefined && Date.now() - current.startedAt < REFRESH_MS) return Promise.resolve();
  current.startedAt = Date.now();
  const running = rescan(current).catch(error => {
    if (current.controller.signal.aborted) return;
    current.files ??= new Map();
    log.warn('claude-stats', 'scan-failed', { code: errorCode(error) });
  }).finally(() => { current.running = undefined; });
  current.running = running;
  return running;
}

/** What the last scan of `root` found, recombined for `now`. Never throws: quota is returned without stats instead. */
export function claudeLocalStats(root: string, now = opts.now()): ClaudeLocalProfile {
  const current = state?.root === root ? state : undefined;
  if (!current?.files) return withoutStats('scanning');
  if (current.empty) return withoutStats('unavailable');
  try {
    return summarize(current.files.values(), now, current.statsCache?.backfill);
  } catch (error) {
    log.warn('claude-stats', 'summary-failed', { code: errorCode(error) });
    return withoutStats('unavailable');
  }
}

/** Daemon shutdown: stops a running scan and waits until it lets go of its files. A later read starts over. */
export async function stopClaudeLocalStats(): Promise<void> {
  const current = state;
  state = undefined;
  current?.controller.abort();
  await current?.running;
}

function withoutStats(stateName: 'scanning' | 'unavailable'): ClaudeLocalProfile {
  return { dailyBuckets: [], localStats: { state: stateName, models: [], sessions: 0, messages: 0, activeDays: 0 } };
}

async function rescan(current: State): Promise<void> {
  const { root, controller: { signal } } = current;
  await readStatsCache(current);
  signal.throwIfAborted();
  // A saved cache answers (stale) while this scan runs; without one the first scan reports "scanning".
  if (!current.files) Object.assign(current, await loadCache(root));
  const listed = await listTranscripts(root);
  signal.throwIfAborted();
  const previous = current.files ?? new Map<string, FileStats>();
  const yesterday = shiftDay(utcDay(opts.now()), -1);
  // Claude Code recounts only the days after its watermark, which is never later than yesterday.
  const settled = current.settled !== undefined && current.settled > yesterday ? yesterday : current.settled;
  // Moved to another project folder: the same session, so the new path takes over the entry the old one left.
  const listedPaths = new Set(listed);
  const left = new Map<string, string>();
  for (const path of previous.keys()) if (!listedPaths.has(path)) left.set(sessionKey(root, path), path);
  const movedFrom = new Set<string>();
  const next = new Map<string, FileStats>();
  let changed = false, failures = 0, failure: string | undefined;
  await eachLimit(listed, CONCURRENCY, async path => {
    signal.throwIfAborted();
    let old = previous.get(path);
    const from = old ? undefined : left.get(sessionKey(root, path));
    if (from !== undefined) {
      left.delete(sessionKey(root, path));
      movedFrom.add(from);
      old = previous.get(from);
      changed = true;
    }
    try {
      const { size, mtimeMs } = await stat(path);
      if (old?.size === size && old.mtimeMs === mtimeMs) {
        if (old.gone) changed = true;
        next.set(path, old.gone ? { ...old, gone: undefined } : old);
        return;
      }
      next.set(path, settle(old, await scanFile(path, size, mtimeMs, signal), settled));
      changed = true;
    } catch (error) {
      if (signal.aborted) throw error;
      failures++;
      failure ??= errorCode(error);
      if (old) next.set(path, old);
    }
  });
  for (const [path, old] of previous) {
    if (next.has(path) || movedFrom.has(path)) continue;
    if (!old.gone) changed = true;
    next.set(path, old.gone ? old : { ...old, gone: true });
  }
  signal.throwIfAborted();
  // Claude Code sets its watermark once a pass through yesterday finds anything, then moves it to yesterday on every
  // pass; with no transcript listed it computes nothing and keeps it.
  const watermark = listed.length && (settled !== undefined || countsThrough(next.values(), yesterday)) ? yesterday : current.settled;
  if (watermark !== current.settled) changed = true;
  current.files = next;
  current.settled = watermark;
  current.empty = listed.length === 0;
  if (failures) log.warn('claude-stats', 'files-unreadable', { count: failures, code: failure });
  if (changed) await saveCache(root, { files: next, settled: watermark });
}

/**
 * A changed transcript, merged like Claude Code's cache (`Cm` → `yi`, then `Sm` for today): days through `settled`
 * keep their cached counts and later days come from the new read, so days the 100 MiB tail no longer reaches stay.
 * A session counts once, as read in the pass that settled the day it started; one first seen after that day never
 * counts as a session, though its later days do.
 */
function settle(old: FileStats | undefined, fresh: FileStats, settled: string | undefined): FileStats {
  if (settled === undefined) return fresh;
  const days: FileStats['days'] = {};
  for (const [date, counts] of Object.entries(old?.days ?? {})) if (date <= settled) days[date] = counts;
  for (const [date, counts] of Object.entries(fresh.days)) if (date > settled) days[date] = counts;
  const base = { size: fresh.size, mtimeMs: fresh.mtimeMs, ...(fresh.sub ? { sub: true as const } : {}), days };
  const session = old?.first !== undefined && utcDay(new Date(old.first)) <= settled ? old : fresh;
  if (session.first === undefined) return base;
  const uncounted = session.uncounted || (session === fresh && utcDay(new Date(session.first)) <= settled);
  return { ...base, first: session.first, last: session.last, lines: session.lines, ...(uncounted ? { uncounted: true as const } : {}) };
}

/** Whether a pass through `last` finds anything: Claude Code's `Qr` on its first full pass. */
function countsThrough(files: Iterable<FileStats>, last: string): boolean {
  for (const file of files) {
    if (file.first !== undefined && utcDay(new Date(file.first)) <= last && Object.keys(file.days).some(date => date <= last)) return true;
  }
  return false;
}

/** The files Claude Code's Stats reads: `<project>/*.jsonl` and `<project>/<dir>/subagents/agent-*.jsonl`, nothing deeper. */
async function listTranscripts(root: string): Promise<string[]> {
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (errorCode(error) === 'ENOENT') return []; throw error; }
  const lists = await Promise.all(projects.filter(entry => entry.isDirectory()).map(async project => {
    const dir = join(root, project.name);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const agents = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
        const subagents = join(dir, entry.name, 'subagents');
        try {
          return (await readdir(subagents, { withFileTypes: true }))
            .filter(file => file.isFile() && file.name.endsWith('.jsonl') && file.name.startsWith('agent-')).map(file => join(subagents, file.name));
        } catch { return []; }
      }));
      return [...entries.filter(file => file.isFile() && file.name.endsWith('.jsonl')).map(file => join(dir, file.name)), ...agents.flat()];
    } catch { return []; } // Claude Code skips an unreadable project folder too
  }));
  return lists.flat();
}

/** The path below its project folder: session ids are unique, so this names the transcript wherever it lives. */
function sessionKey(root: string, path: string): string {
  return relative(root, path).split(sep).slice(1).join(sep);
}

async function scanFile(path: string, size: number, mtimeMs: number, signal: AbortSignal): Promise<FileStats> {
  const sub = path.includes(`${sep}subagents${sep}`);
  const days: FileStats['days'] = {};
  let first: unknown, last: unknown, lines = 0;
  for await (const text of transcriptLines(path, size, signal)) {
    if (!COUNTED_LINE.test(text)) continue;
    let entry: unknown;
    try { entry = JSON.parse(text); } catch { continue; }
    if (typeof entry !== 'object' || entry === null) continue;
    const line = entry as { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } };
    if (typeof line.type !== 'string' || !COUNTED_TYPES.has(line.type) || (!sub && line.isSidechain)) continue;
    if (lines++ === 0) first = line.timestamp;
    last = line.timestamp;
    const at = new Date(line.timestamp as string);
    // Claude Code skips the day counts of a line without a valid date; past year 9999 there is no YYYY-MM-DD key.
    const key = Number.isNaN(at.getTime()) ? '' : utcDay(at);
    if (!DAY.test(key)) continue;
    if (!sub) { const day = (days[key] ??= {}); day.messages = (day.messages ?? 0) + 1; }
    const usage = line.type === 'assistant' ? line.message?.usage : undefined;
    if (!usage) continue;
    const model = String(line.message?.model || 'unknown');
    if (model === SYNTHETIC_MODEL || model in Object.prototype) continue;
    const tokens = count(usage.input_tokens) + count(usage.output_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
    if (tokens <= 0) continue;
    const day = (days[key] ??= {});
    const byModel = (day.tokens ??= {});
    byModel[model] = (byModel[model] ?? 0) + tokens;
  }
  const start = new Date(first as string).getTime(), end = new Date(last as string).getTime();
  // Claude Code drops a transcript whose first or last counted line has no valid timestamp.
  if (!lines || Number.isNaN(start) || Number.isNaN(end)) return { size, mtimeMs, ...(sub ? { sub } : {}), days: {} };
  return { size, mtimeMs, ...(sub ? { sub } : {}), first: start, last: end, lines, days };
}

/** Lines split on "\n" like Claude Code, read up to the size the cache entry is keyed on. */
async function* transcriptLines(path: string, size: number, signal: AbortSignal): AsyncGenerator<string> {
  if (size === 0) return;
  const start = Math.max(0, size - opts.tailBytes);
  let cut = start > 0, offset = start, carry: Buffer[] = [];
  const stream = createReadStream(path, { start, end: size - 1, highWaterMark: CHUNK_BYTES, signal });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
      const part = chunk.subarray(from, at);
      const bytes = carry.length ? Buffer.concat([...carry, part]) : part;
      carry = [];
      from = at + 1;
      // The cut first line of a tail read is dropped, unless nothing follows it.
      if (cut) { cut = false; if (offset + at < size - 1) continue; }
      const text = bytes.toString('utf8').trim();
      if (text) yield text;
    }
    if (from < chunk.length) carry.push(chunk.subarray(from));
    offset += chunk.length;
  }
  const text = Buffer.concat(carry).toString('utf8').trim();
  if (text) yield text;
}

function summarize(files: Iterable<FileStats>, now: Date, backfill?: Backfill): ClaudeLocalProfile {
  const today = utcDay(now);
  const days = new Map<string, Day>();
  // Sessions starting through the stats cache's day are in its totals as well; later ones only here.
  const early = { sessions: 0, hours: Array<number>(24).fill(0), longest: undefined as Longest | undefined };
  const late = { ...early, hours: Array<number>(24).fill(0) };
  for (const file of files) {
    if (file.first === undefined || file.last === undefined) continue;
    const start = utcDay(new Date(file.first)), touchedToday = utcDay(new Date(file.mtimeMs)) >= today;
    // Claude Code counts through yesterday in a cached pass that skips sessions starting later, and today in a pass
    // over the files modified today; nothing dated after today counts.
    if (start > today || (start === today && !touchedToday)) continue;
    if (!file.sub && !file.uncounted) {
      const into = backfill && start <= backfill.asOf ? early : late;
      into.sessions++;
      into.hours[new Date(file.first).getHours()]!++;
      into.longest = longer(into.longest, { ms: file.last - file.first, lines: file.lines ?? 0 });
    }
    for (const [date, counts] of Object.entries(file.days)) {
      if (date > today || (date === today ? !touchedToday : start === today)) continue;
      const day = dayOf(days, date);
      day.messages += counts.messages ?? 0;
      for (const [model, tokens] of Object.entries(counts.tokens ?? {})) day.tokens.set(model, (day.tokens.get(model) ?? 0) + tokens);
    }
  }
  let sessions = early.sessions + late.sessions, hourCounts = early.hours, longest = longer(early.longest, late.longest);
  if (backfill) {
    // Claude Code recounts today, so its figures stop at yesterday even when its clock ran ahead.
    const last = backfill.asOf < today ? backfill.asOf : shiftDay(today, -1);
    for (const [date, theirs] of backfill.days) {
      if (date > last) continue;
      const day = dayOf(days, date);
      day.messages = Math.max(day.messages, theirs.messages);
      for (const [model, tokens] of theirs.tokens) day.tokens.set(model, Math.max(day.tokens.get(model) ?? 0, tokens));
    }
    sessions = Math.max(early.sessions, backfill.sessions) + late.sessions;
    // Start hours have no split by day: the side with more sessions has the hours of them.
    if (backfill.sessions > early.sessions) hourCounts = backfill.hours;
    longest = longer(longer(early.longest, backfill.longest), late.longest);
  }
  hourCounts = hourCounts.map((count, hour) => count + late.hours[hour]!);
  if (!sessions) return withoutStats('unavailable');
  // Claude Code's per-model totals (its Total tokens and Favorite model) can hold more than its days do.
  const settledModels = new Map<string, number>(), models = new Map<string, number>();
  for (const [date, day] of days) {
    for (const [model, tokens] of day.tokens) {
      const into = backfill && date <= backfill.asOf ? settledModels : models;
      into.set(model, (into.get(model) ?? 0) + tokens);
    }
  }
  for (const [model, tokens] of backfill?.models ?? []) settledModels.set(model, Math.max(settledModels.get(model) ?? 0, tokens));
  for (const [model, tokens] of settledModels) models.set(model, (models.get(model) ?? 0) + tokens);
  const dailyBuckets = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, tokens: sum(day.tokens.values()), messages: day.messages }));
  const messages = dailyBuckets.reduce((total, day) => total + day.messages, 0);
  const active = dailyBuckets.filter(day => day.messages > 0).map(day => day.date);
  const activeSet = new Set(active);
  let currentStreakDays = 0, longestStreakDays = 0, run = 0;
  for (let day = today; activeSet.has(day); day = shiftDay(day, -1)) currentStreakDays++;
  active.forEach((day, index) => {
    run = index > 0 && shiftDay(active[index - 1]!, 1) === day ? run + 1 : 1;
    longestStreakDays = Math.max(longestStreakDays, run);
  });
  return {
    dailyBuckets,
    lifetimeTokens: sum(models.values()),
    peakDailyTokens: Math.max(0, ...dailyBuckets.map(day => day.tokens)),
    currentStreakDays,
    longestStreakDays,
    localStats: {
      state: 'ready',
      // Claude Code's "Favorite model" is the first of these.
      models: [...models].filter(([, tokens]) => tokens > 0).sort((a, b) => b[1] - a[1]).map(([id, tokens]) => ({ id, tokens })),
      sessions,
      messages,
      activeDays: active.length,
      ...(longest ? { longestSessionSec: Math.max(0, Math.round(longest.ms / 1000)), longestSessionMessages: longest.lines } : {}),
      hourCounts,
    },
  };
}

function dayOf(days: Map<string, Day>, date: string): Day {
  let day = days.get(date);
  if (!day) days.set(date, day = { messages: 0, tokens: new Map() });
  return day;
}

/** The longer session; on a tie the one counted first, as Claude Code keeps it. */
function longer(a: Longest | undefined, b: Longest | undefined): Longest | undefined {
  return !a || (b && b.ms > a.ms) ? b : a;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Claude Code's stats cache, for the days its cleanup took the transcripts of. Missing, unreadable or of another
 * shape: transcripts alone, and one log line with a code until that changes. Never written, locked or copied.
 */
async function readStatsCache(current: State): Promise<void> {
  const file = join(dirname(current.root), STATS_CACHE);
  let code: string, seen: StatsCacheRead | undefined;
  try {
    const { size, mtimeMs } = await stat(file);
    if (current.statsCache?.size === size && current.statsCache.mtimeMs === mtimeMs) return;
    // An unusable file is not read again until it changes; a failing read is tried again.
    seen = { size, mtimeMs };
    if (size > STATS_CACHE_MAX_BYTES) throw new StatsCacheUnusable('too-large');
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')); } catch (error) { throw error instanceof SyntaxError ? new StatsCacheUnusable('bad-json') : error; }
    const parsed = statsCacheSchema.safeParse(raw);
    if (!parsed.success) throw new StatsCacheUnusable('bad-shape');
    current.statsCache = { size, mtimeMs, backfill: toBackfill(parsed.data) };
    current.statsCacheCode = undefined;
    return;
  } catch (error) {
    code = error instanceof StatsCacheUnusable ? error.code : errorCode(error);
    current.statsCache = error instanceof StatsCacheUnusable ? seen : undefined;
  }
  if (code === current.statsCacheCode) return;
  current.statsCacheCode = code;
  // Most users never open /usage, so there is no file to read.
  if (code === 'ENOENT') log.info('claude-stats', 'stats-cache-unused', { code });
  else log.warn('claude-stats', 'stats-cache-unused', { code });
}

class StatsCacheUnusable extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Only the numbers used: no session id, no costs. */
function toBackfill(cache: StatsCache): Backfill | undefined {
  // Like Claude Code (`Hr`): without a valid lastComputedDate the latest day it holds is its watermark; with no day,
  // it starts over.
  const dates = [...cache.dailyActivity, ...cache.dailyModelTokens].map(entry => entry.date);
  const asOf = cache.lastComputedDate && isDay(cache.lastComputedDate) ? cache.lastComputedDate : dates.sort().at(-1);
  if (!asOf) return undefined;
  const days = new Map<string, Day>();
  for (const { date, messageCount } of cache.dailyActivity) {
    if (!messageCount) continue;
    const day = dayOf(days, date);
    day.messages = Math.max(day.messages, messageCount);
  }
  // Per-day tokens of an older version: Claude Code rebuilds them from the transcripts left, so they are not used.
  if (cache.dailyModelTokensVersion === DAILY_TOKENS_VERSION) {
    for (const { date, tokensByModel } of cache.dailyModelTokens) {
      for (const [model, tokens] of usableModels(tokensByModel)) {
        if (!tokens) continue;
        const day = dayOf(days, date);
        day.tokens.set(model, Math.max(day.tokens.get(model) ?? 0, tokens));
      }
    }
  }
  const models = new Map<string, number>();
  for (const [model, usage] of usableModels(cache.modelUsage ?? {})) {
    models.set(model, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0));
  }
  const hours = Array<number>(24).fill(0);
  for (const [hour, count] of Object.entries(cache.hourCounts ?? {})) hours[Number(hour)]! += count;
  const longest = cache.longestSession ? { ms: cache.longestSession.duration, lines: cache.longestSession.messageCount } : undefined;
  return { asOf, days, sessions: cache.totalSessions, hours, ...(longest ? { longest } : {}), models };
}

/** Claude Code skips these model names too (`qo`, `Mi`). */
function usableModels<T>(byModel: Record<string, T>): [string, T][] {
  return Object.entries(byModel).filter(([model]) => model !== SYNTHETIC_MODEL && !(model in Object.prototype));
}

/** An older version, another root or any invalid field (an impossible day included) discards the cache: a full rescan. */
async function loadCache(root: string): Promise<Saved | undefined> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(await readFile(paths.claudeLocalStatsFile, 'utf8')));
    if (!parsed.success || parsed.data.root !== root) return undefined;
    return { files: new Map(Object.entries(parsed.data.files)), settled: parsed.data.settled };
  } catch { return undefined; }
}

async function saveCache(root: string, { files, settled }: Saved): Promise<void> {
  try {
    await writeFileAtomic(paths.claudeLocalStatsFile, JSON.stringify({ version: CACHE_VERSION, root, settled, files: Object.fromEntries(files) }));
  } catch (error) {
    // Costs only a longer scan after the next restart.
    log.warn('claude-stats', 'cache-write-failed', { code: errorCode(error) });
  }
}

/** Waits for every worker, so a stopped scan has closed its files when this settles. */
async function eachLimit<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
  for (const worker of workers) if (worker.status === 'rejected') throw worker.reason;
}

/** Claude Code's day key: the UTC date. */
function utcDay(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/** A real date key, as Claude Code checks the dates in its own cache (`hi`). */
function isDay(key: string): boolean {
  if (!DAY.test(key)) return false;
  const date = new Date(key);
  return !Number.isNaN(date.getTime()) && utcDay(date) === key;
}

function shiftDay(day: string, by: number): string {
  const date = new Date(day);
  date.setUTCDate(date.getUTCDate() + by);
  return utcDay(date);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown';
}
