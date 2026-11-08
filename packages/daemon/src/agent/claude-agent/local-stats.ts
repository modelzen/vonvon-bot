import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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
 * the streak always follow the clock. A transcript Claude Code cleans up later (cleanupPeriodDays) keeps counting,
 * as Claude Code's own stats cache keeps the days it already counted.
 */

const COUNTED_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
/** Cheap pre-check before JSON.parse: a counted line has one of these as its top-level type. */
const COUNTED_LINE = /"type"\s*:\s*"(?:user|assistant|attachment|system)"/;
const SYNTHETIC_MODEL = '<synthetic>';
/** Claude Code reads only the last 100 MiB of a larger transcript and drops the cut first line. */
const TAIL_BYTES = 100 * 1024 * 1024;
const CHUNK_BYTES = 1 << 18;
const CONCURRENCY = 2;
const REFRESH_MS = 60_000;
const CACHE_VERSION = 1;

const time = z.number().min(-8.64e15).max(8.64e15);
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
  /** UTC day → main-session messages and tokens per model */
  days: z.record(z.string(), z.object({ messages: z.number().optional(), tokens: z.record(z.string(), z.number()).optional() })),
});
const cacheSchema = z.object({ version: z.literal(CACHE_VERSION), root: z.string(), files: z.record(z.string(), fileSchema) });
type FileStats = z.infer<typeof fileSchema>;

export type ClaudeLocalProfile = Pick<AccountProfileStats, 'dailyBuckets' | 'lifetimeTokens' | 'peakDailyTokens' | 'currentStreakDays' | 'longestStreakDays'>
  & { localStats: ClaudeLocalStats };

type State = {
  root: string;
  controller: AbortController;
  /** undefined until the first scan (or the saved cache) is in */
  files?: Map<string, FileStats>;
  /** no transcript on disk at the last look: Claude Code then shows no stats at all */
  empty?: boolean;
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

/** What the last scan of `root` found, recombined for `now`. */
export function claudeLocalStats(root: string, now = new Date()): ClaudeLocalProfile {
  const current = state?.root === root ? state : undefined;
  if (!current?.files) return withoutStats('scanning');
  if (current.empty) return withoutStats('unavailable');
  return summarize(current.files.values(), now);
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
  // A saved cache answers (stale) while this scan runs; without one the first scan reports "scanning".
  current.files ??= await loadCache(root);
  const listed = await listTranscripts(root);
  signal.throwIfAborted();
  const previous = current.files ?? new Map<string, FileStats>();
  const next = new Map<string, FileStats>();
  let changed = false, failures = 0, failure: string | undefined;
  await eachLimit(listed, CONCURRENCY, async path => {
    signal.throwIfAborted();
    const old = previous.get(path);
    try {
      const { size, mtimeMs } = await stat(path);
      if (old?.size === size && old.mtimeMs === mtimeMs) {
        if (old.gone) changed = true;
        next.set(path, old.gone ? { ...old, gone: undefined } : old);
        return;
      }
      next.set(path, await scanFile(path, size, mtimeMs, signal));
      changed = true;
    } catch (error) {
      if (signal.aborted) throw error;
      failures++;
      failure ??= errorCode(error);
      if (old) next.set(path, old);
    }
  });
  const present = new Set(listed.map(path => sessionKey(root, path)));
  for (const [path, old] of previous) {
    if (next.has(path)) continue;
    // Moved to another project folder: the same session, counted once under its new path.
    if (present.has(sessionKey(root, path))) { changed = true; continue; }
    if (!old.gone) changed = true;
    next.set(path, old.gone ? old : { ...old, gone: true });
  }
  signal.throwIfAborted();
  current.files = next;
  current.empty = listed.length === 0;
  if (failures) log.warn('claude-stats', 'files-unreadable', { count: failures, code: failure });
  if (changed) await saveCache(root, next);
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
    if (Number.isNaN(at.getTime())) continue;
    const key = utcDay(at);
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
  const start = Math.max(0, size - TAIL_BYTES);
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

function summarize(files: Iterable<FileStats>, now: Date): ClaudeLocalProfile {
  const today = utcDay(now);
  const days = new Map<string, { messages: number; tokens: number }>();
  const models = new Map<string, number>();
  const hourCounts = Array<number>(24).fill(0);
  let sessions = 0, messages = 0, longest: { ms: number; lines: number } | undefined;
  for (const file of files) {
    if (file.first === undefined || file.last === undefined) continue;
    const start = utcDay(new Date(file.first)), touchedToday = utcDay(new Date(file.mtimeMs)) >= today;
    // Claude Code counts through yesterday in a cached pass that skips sessions starting later, and today in a pass
    // over the files modified today; nothing dated after today counts.
    if (start > today || (start === today && !touchedToday)) continue;
    if (!file.sub) {
      sessions++;
      hourCounts[new Date(file.first).getHours()]!++;
      const ms = file.last - file.first;
      if (!longest || ms > longest.ms) longest = { ms, lines: file.lines ?? 0 };
    }
    for (const [date, counts] of Object.entries(file.days)) {
      if (date > today || (date === today ? !touchedToday : start === today)) continue;
      const day = days.get(date) ?? { messages: 0, tokens: 0 };
      day.messages += counts.messages ?? 0;
      messages += counts.messages ?? 0;
      for (const [model, tokens] of Object.entries(counts.tokens ?? {})) {
        day.tokens += tokens;
        models.set(model, (models.get(model) ?? 0) + tokens);
      }
      days.set(date, day);
    }
  }
  if (!sessions || !longest) return withoutStats('unavailable');
  const dailyBuckets = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, tokens: day.tokens, messages: day.messages }));
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
    lifetimeTokens: dailyBuckets.reduce((sum, day) => sum + day.tokens, 0),
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
      longestSessionSec: Math.max(0, Math.round(longest.ms / 1000)),
      longestSessionMessages: longest.lines,
      hourCounts,
    },
  };
}

async function loadCache(root: string): Promise<Map<string, FileStats> | undefined> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(await readFile(paths.claudeLocalStatsFile, 'utf8')));
    return parsed.success && parsed.data.root === root ? new Map(Object.entries(parsed.data.files)) : undefined;
  } catch { return undefined; }
}

async function saveCache(root: string, files: Map<string, FileStats>): Promise<void> {
  try {
    await writeFileAtomic(paths.claudeLocalStatsFile, JSON.stringify({ version: CACHE_VERSION, root, files: Object.fromEntries(files) }));
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
