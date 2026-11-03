// The queued messages a shutdown dropped unanswered, the turns it cut short whose card could not say so (owner
// 2026-11-02), and the line that asks their senders to send again once the bot is back (product.md 3.10, s18c). `bots/<appId>/dropped.json` keeps one entry per group: its newest dropped message's place
// and how many there were. Ids, times and places only, no text (3.5). The file stays true: an entry leaves it once its
// group is settled (replied, refused, given up), so a process killed halfway leaves the rest for the next one.
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import type { CrashLog } from '../host/crash-guard';
import { writeAtomicSync } from '../host/crash-store';
import { FEISHU_RATE_LIMIT_CODES, feishuError, scopeDenial } from '../utils/feishu-error';
import { fromBot } from './baselines';
import { deniedScopeName, errorDetail } from './diagnostics';

/** Where a dropped message was: the reply goes under it, in its topic when it was in one. */
export type DroppedOrigin = { chatId: string; messageId: string; at: number; replyInThread: boolean; place: 'main' | 'topic' };
/** A group's entry: the newest dropped message, how many were dropped there, and when the last of them was. */
export type DroppedEntry = z.infer<typeof entrySchema>;

/** Older than this, the sender has most likely moved on: no reply, the entry goes. */
export const DROPPED_MAX_AGE_MS = 24 * 60 * 60_000;
/** Back within this, the line says 刚才重启了; later, bot 停了一阵. */
export const DROPPED_RECENT_MS = 10 * 60_000;
export const DROPPED_RETRY_MS: readonly number[] = [60_000, 300_000];
/** The SDK's requests carry no timeout of their own. */
const REPLY_TIMEOUT_MS = 10_000;
const DROPPED_MAX_GROUPS = 200;
const DROPPED_MAX_COUNT = 10_000;
/** 200 groups write about 50 KB; a bigger file was not written by this. */
const DROPPED_MAX_BYTES = 64 * 1024;
/** Feishu's code for a reply to a recalled message, from its docs; not seen in a test yet (M4 step 5 looks). */
const RECALLED_CODE = 230011;

const entrySchema = z.object({
  chatId: z.string().regex(/^oc_[A-Za-z0-9_-]{1,61}$/), messageId: z.string().regex(/^om_[A-Za-z0-9_-]{1,61}$/),
  at: z.number().finite().nonnegative(), replyInThread: z.boolean(), place: z.enum(['main', 'topic']),
  count: z.number().int().min(1).max(DROPPED_MAX_COUNT), droppedAt: z.number().finite().nonnegative(),
  revision: z.number().int().nonnegative().optional(),
}).strict();
const fileSchema = z.object({ v: z.literal(1), entries: z.array(z.unknown()) }).strict();

/** A message's place as its ordinary reply has it: quoted in a single group's main area, else in its topic. */
export function originOf(msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'createTime'>, flat: boolean): DroppedOrigin {
  return { chatId: msg.chatId, messageId: msg.messageId, at: msg.createTime || Date.now(), replyInThread: !flat, place: flat ? 'main' : 'topic' };
}

/** Bots are never asked to resend after a restart. */
export function originFor(msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'createTime' | 'raw'>, flat: boolean): DroppedOrigin | undefined {
  return fromBot(msg) ? undefined : originOf(msg, flat);
}

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT';
/** The file's well-formed entries; an entry of another shape is left out. */
function load(file: string): { entries: DroppedEntry[]; invalid: number } | 'missing' | 'corrupt' {
  let raw: Buffer;
  try { raw = readFileSync(file); }
  catch (error) { if (isMissing(error)) return 'missing'; throw error; }
  if (raw.length > DROPPED_MAX_BYTES) return 'corrupt';
  let parsed: ReturnType<typeof fileSchema.safeParse>;
  try { parsed = fileSchema.safeParse(JSON.parse(raw.toString('utf8'))); } catch { return 'corrupt'; }
  if (!parsed.success) return 'corrupt';
  const entries = parsed.data.entries.flatMap(item => { const entry = entrySchema.safeParse(item); return entry.success ? [entry.data] : []; });
  return { entries, invalid: parsed.data.entries.length - entries.length };
}
function remove(file: string): void {
  try { unlinkSync(file); } catch (error) { if (!isMissing(error)) throw error; }
}
/** 0600, written to a temp file and renamed; no entry left, no file. */
function write(file: string, entries: readonly DroppedEntry[]): void {
  if (!entries.length) { remove(file); return; }
  writeAtomicSync(dirname(file), basename(file), JSON.stringify({ v: 1, entries }));
}

/** A dropped message as a group's entry of its own, or nothing when it does not fit the file's shape. */
function freshEntry(item: DroppedOrigin, droppedAt: number): DroppedEntry | undefined {
  const entry = entrySchema.safeParse({ ...item, count: 1, droppedAt });
  return entry.success ? entry.data : undefined;
}
/** Two entries of one group as one: the newer message's id and place, the counts added up, a new revision. */
function merged(had: DroppedEntry, entry: DroppedEntry): DroppedEntry {
  const newer = entry.at >= had.at ? entry : had;
  return { ...newer, count: Math.min(DROPPED_MAX_COUNT, had.count + entry.count), droppedAt: Math.max(had.droppedAt, entry.droppedAt), revision: (had.revision ?? 0) + 1 };
}
/** Newest first, and past 200 groups the newest are kept. */
const newestGroups = (entries: readonly DroppedEntry[]): DroppedEntry[] =>
  [...entries].sort((a, b) => b.droppedAt - a.droppedAt || b.at - a.at).slice(0, DROPPED_MAX_GROUPS);

/**
 * Merge `items` (what this shutdown dropped) into the file, one entry per group: the newest message's id and place stay,
 * counts add up. Entries older than a day go, and past 200 groups the newest are kept. Nothing is touched when `items`
 * is empty; a damaged file is overwritten. Returns how many groups `items` had.
 */
export function recordDroppedSync(file: string, items: readonly DroppedOrigin[], now: number, onCorrupt?: () => void): number {
  const fresh = items.flatMap(item => freshEntry(item, now) ?? []);
  if (!fresh.length) return 0;
  const loaded = load(file);
  if (loaded === 'corrupt') onCorrupt?.();
  const old = typeof loaded === 'object' ? loaded.entries.filter(entry => now - entry.droppedAt <= DROPPED_MAX_AGE_MS) : [];
  const groups = new Map<string, DroppedEntry>();
  for (const entry of [...old, ...fresh]) {
    const had = groups.get(entry.chatId);
    groups.set(entry.chatId, had ? merged(had, entry) : entry);
  }
  write(file, newestGroups([...groups.values()]));
  return new Set(fresh.map(entry => entry.chatId)).size;
}

/** A group's entry in the file, if it has one. */
function groupEntry(file: string, chatId: string): DroppedEntry | undefined {
  const loaded = load(file);
  return typeof loaded === 'object' ? loaded.entries.find(entry => entry.chatId === chatId) : undefined;
}

/**
 * Puts a group's entry back together from `before`, the entry it had, and `items`, what was merged into it since, each
 * with when (review 259): what {@link recordDroppedSync} would have written without the messages taken out. With
 * neither, the group leaves the file; with only `before`, it is that again, word for word. Another rebuilt entry gets a
 * revision past the file's, so its reply is a new one (droppedUuid). A missing or damaged file is left as it is.
 */
function rebuildGroupSync(file: string, chatId: string, before: DroppedEntry | undefined, items: ReadonlyArray<{ origin: DroppedOrigin; at: number }>, now: number): void {
  const loaded = load(file);
  if (typeof loaded !== 'object') return;
  const current = loaded.entries.find(entry => entry.chatId === chatId);
  let entry = before && now - before.droppedAt <= DROPPED_MAX_AGE_MS ? before : undefined;
  for (const item of items) {
    const fresh = freshEntry(item.origin, item.at);
    if (fresh) entry = entry ? merged(entry, fresh) : fresh;
  }
  if (entry && entry !== before) entry = { ...entry, revision: (current?.revision ?? 0) + 1 };
  const others = loaded.entries.filter(other => other.chatId !== chatId);
  write(file, entry ? newestGroups([...others, entry]) : others);
}

/** The entries of the last day, left in the file; older ones are taken out of it and counted as `stale`. A damaged file
 * is deleted, and `onCorrupt` hears of it. */
export function readDropped(file: string, now: number, onCorrupt?: () => void): { entries: DroppedEntry[]; stale: number } {
  const loaded = load(file);
  if (loaded === 'missing') return { entries: [], stale: 0 };
  if (loaded === 'corrupt') { onCorrupt?.(); remove(file); return { entries: [], stale: 0 }; }
  const entries = loaded.entries.filter(entry => now - entry.droppedAt <= DROPPED_MAX_AGE_MS);
  const stale = loaded.entries.length - entries.length;
  if (stale || loaded.invalid) write(file, entries);
  return { entries, stale };
}

/** A reply settles only its snapshot: a later shutdown may merge even an older message into the same group. */
export function settleDroppedSync(file: string, settled: Pick<DroppedEntry, 'chatId' | 'messageId' | 'revision'>): void {
  const loaded = load(file);
  if (typeof loaded !== 'object') return;
  const kept = loaded.entries.filter(entry => entry.chatId !== settled.chatId || entry.messageId !== settled.messageId || (entry.revision ?? 0) !== (settled.revision ?? 0));
  if (kept.length !== loaded.entries.length) write(file, kept);
}

/** The line under a group's newest dropped message: queued and never started, or cut short mid-turn (owner 2026-11-02). */
export function droppedText(count: number, sinceMs: number): string {
  const head = sinceMs < DROPPED_RECENT_MS ? '刚才重启了' : 'bot 停了一阵';
  return count === 1 ? `${head}，这条没处理完，请再发一次。` : `${head}，这条和这个群里另外 ${count - 1} 条都没处理完，请再发一次。`;
}

/** Fixed by the message and snapshot revision: retries, including in the next process, use the same uuid; a merge
 * uses a new one even if the newest message stays the same. Feishu
 * answers one uuid once within an hour (verified 2026-10-16 on the reply API: the same message_id twice). 43 of 50. */
export function droppedUuid(appId: string, entry: Pick<DroppedEntry, 'chatId' | 'messageId' | 'revision'>): string {
  const key = `${appId}\n${entry.chatId}\n${entry.messageId}${entry.revision ? `\n${entry.revision}` : ''}`;
  return `vd-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** No answer within the limit; the request may still have gone through. */
export class ReplyTimeoutError extends Error {
  constructor(ms: number) { super(`${Math.round(ms / 1000)} 秒没有响应`); this.name = 'ReplyTimeoutError'; }
}
export type ReplyFailure = { retry: boolean; detail?: string; scope?: string; recalled?: boolean; unexpected?: boolean };
/** The SDK's own error when the token endpoint answers a 2xx without a token (`buildTokenError` in 1.71.1): a plain
 * Error whose message alone carries Feishu's code, or `unknown` when the body had none. */
const TOKEN_ERROR = /^failed to get \w+, code: ([^,]*), msg: ([\s\S]*)$/;

/**
 * How a reply failed. The SDK throws an HTTP error (`response.status`, with Feishu's `{code, msg}` in `response.data`)
 * and resolves a 2xx with a code other than 0, which the caller throws with `code` and `msg` on it. A rate limit, 5xx,
 * 429, no answer and a timeout are tried again; any other refusal is not. A token the SDK could not get is judged as
 * crash-notify judges it: a rate limit or a body with no code is tried again, another code is a refusal. Anything else
 * is not Feishu's and not retried.
 */
export function replyFailure(error: unknown): ReplyFailure {
  if (error instanceof ReplyTimeoutError) return { retry: true, detail: error.message };
  const token = error instanceof Error ? TOKEN_ERROR.exec(error.message) : null;
  if (token) {
    const code = /^\d+$/.test(token[1]!) ? Number(token[1]) : undefined;
    const msg = token[2]!.split('\n')[0]!.replace(/[\x00-\x1f\x7f]/g, '').trim();
    const said = code === undefined ? '飞书没给错误码' : `飞书 ${code}${msg && msg !== 'no message' ? `：${msg}` : ''}`;
    return { retry: code === undefined || FEISHU_RATE_LIMIT_CODES.has(code), detail: `没拿到 token，${said}`.slice(0, 120) };
  }
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  const http = typeof status === 'number' ? status : undefined;
  const feishu = feishuError(error);
  if (feishu || http !== undefined) {
    const detail = (feishu ? `飞书 ${feishu.code}${feishu.msg ? `：${feishu.msg}` : ''}` : `HTTP ${http}`).slice(0, 120);
    if ((http !== undefined && (http >= 500 || http === 429)) || (feishu && FEISHU_RATE_LIMIT_CODES.has(feishu.code))) return { retry: true, detail };
    const denied = scopeDenial(error);
    const scope = denied ? deniedScopeName(denied.accepted) : undefined;
    if (scope) return { retry: false, detail: `缺 ${scope}`.slice(0, 120), scope };
    return { retry: false, detail, ...(feishu?.code === RECALLED_CODE ? { recalled: true } : {}) };
  }
  const code = (error as { code?: unknown } | null)?.code;
  // No answer at all: axios without a response, or a socket's errno.
  if ((error as { isAxiosError?: unknown } | null)?.isAxiosError === true || (typeof code === 'string' && /^E[A-Z]+$/.test(code))) {
    return { retry: true, detail: errorDetail(error) ?? '连不上飞书' };
  }
  return { retry: false, unexpected: true, detail: errorDetail(error) ?? '出错了' };
}

function within<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ReplyTimeoutError(ms)), ms); timer.unref?.(); });
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

export interface DroppedReplies {
  /** Once connected: reply to each group the file holds, one after another. Once only, and never after {@link saveSync}. */
  start(): void;
  /** At shutdown: merge what is lost into the file, synchronously, and start no more replies. Once only. */
  saveSync(lost: readonly DroppedOrigin[], why: 'shutdown' | 'crash'): void;
  /** After {@link saveSync}: a first turn that was still preparing, or a cut-short turn whose card did not say so in time. */
  appendSync(origin: DroppedOrigin): void;
  /**
   * A message {@link appendSync} kept whose turn's card got through after all (review 259): it leaves the file again, and
   * the other messages of its group stay. False when this process did not append it.
   */
  retractSync(origin: DroppedOrigin): boolean;
}

/**
 * The replies, not tracked by the shutdown: a reply still in flight when it comes keeps its entry in the file, and the
 * next process sends it again under the same uuid. Every failure is caught here; one left unhandled would crash the bot
 * child (crash-guard), and with the file still there it would crash again at each start.
 */
export function createDroppedReplies(deps: {
  appId: string; file: string;
  /** The raw reply API; throws when Feishu did not take it. */
  reply: (entry: DroppedEntry, text: string, uuid: string) => Promise<void>;
  /** The 状态与诊断 page, once per group when it is settled; `detail` says why the reply did not go. */
  report: (entry: DroppedEntry, times: number, detail?: string, scope?: string) => void;
  log: CrashLog;
  now?: () => number; retryMs?: readonly number[]; timeoutMs?: number;
}): DroppedReplies {
  const { appId, file, log } = deps;
  const now = deps.now ?? Date.now;
  const retryMs = deps.retryMs ?? DROPPED_RETRY_MS;
  const timeoutMs = deps.timeoutMs ?? REPLY_TIMEOUT_MS;
  const timers = new Set<NodeJS.Timeout>();
  let started = false;
  let saved = false;
  /** What appendSync merged into each group, each with when, and the group's entry before the first of it (retractSync). */
  const appended = new Map<string, { before: DroppedEntry | undefined; items: Array<{ origin: DroppedOrigin; at: number }> }>();
  const chat = (entry: Pick<DroppedEntry, 'chatId'>): string => entry.chatId.slice(-6);
  const corrupt = (): void => log.warn('bridge', 'dropped-corrupt', {});
  const settle = (entry: DroppedEntry): void => {
    try { settleDroppedSync(file, entry); }
    catch (error) { log.fail('bridge', error, { phase: 'dropped-settle', chat: chat(entry) }); }
  };

  const attempt = async (entry: DroppedEntry, tries: number): Promise<void> => {
    try {
      await within(deps.reply(entry, droppedText(entry.count, now() - entry.droppedAt), droppedUuid(appId, entry)), timeoutMs);
    } catch (error) {
      const failure = replyFailure(error);
      const delay = retryMs[tries];
      if (failure.retry && delay !== undefined) {
        // Shut down meanwhile: the entry stays for the next process.
        if (saved) return;
        log.warn('bridge', 'dropped-retry', { chat: chat(entry), attempt: tries + 1, retryInMs: delay, ...(failure.detail ? { detail: failure.detail } : {}) });
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!saved) void attempt(entry, tries + 1).catch(failed => log.fail('bridge', failed, { phase: 'dropped-loop', chat: chat(entry) }));
        }, delay);
        timer.unref?.();
        timers.add(timer);
        return;
      }
      settle(entry);
      if (failure.unexpected) log.fail('bridge', error, { phase: 'dropped-reply-failed', chat: chat(entry), count: entry.count });
      else log.warn('bridge', 'dropped-reply-failed', { chat: chat(entry), count: entry.count, ...(failure.detail ? { detail: failure.detail } : {}) });
      // A recalled newest message is not one the page lists (s15); the others still went unanswered.
      if (failure.recalled) { if (entry.count > 1) deps.report(entry, entry.count - 1, '最新那条撤回了'); }
      else deps.report(entry, entry.count, failure.detail ?? '出错了', failure.scope);
      return;
    }
    settle(entry);
    log.info('bridge', 'dropped-replied', { chat: chat(entry), count: entry.count });
    deps.report(entry, entry.count);
  };

  const loop = async (entries: readonly DroppedEntry[]): Promise<void> => {
    for (const entry of entries) {
      if (saved) return;
      try { await attempt(entry, 0); }
      catch (error) { log.fail('bridge', error, { phase: 'dropped-loop', chat: chat(entry) }); }
    }
  };

  return {
    start() {
      if (started || saved) return;
      started = true;
      let read: ReturnType<typeof readDropped>;
      try { read = readDropped(file, now(), corrupt); }
      catch (error) { log.fail('bridge', error, { phase: 'dropped-read' }); return; }
      if (read.stale) log.info('bridge', 'dropped-stale', { groups: read.stale });
      if (!read.entries.length) return;
      log.info('bridge', 'dropped-read', { groups: read.entries.length, stale: read.stale });
      void loop(read.entries).catch(error => log.fail('bridge', error, { phase: 'dropped-loop' }));
    },
    saveSync(lost, why) {
      if (saved) return;
      saved = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      let groups: number;
      try { groups = recordDroppedSync(file, lost, now(), corrupt); }
      catch (error) { log.fail('bridge', error, { phase: 'dropped-record' }); return; }
      if (groups) log.info('bridge', 'dropped-recorded', { groups, messages: lost.length, why });
    },
    appendSync(origin) {
      if (!saved) return;
      try {
        const group = appended.get(origin.chatId) ?? { before: groupEntry(file, origin.chatId), items: [] };
        const at = now();
        const groups = recordDroppedSync(file, [origin], at, corrupt);
        if (!groups) return;
        group.items.push({ origin, at });
        appended.set(origin.chatId, group);
        log.info('bridge', 'dropped-appended', { groups });
      } catch (error) { log.fail('bridge', error, { phase: 'dropped-append' }); }
    },
    retractSync(origin) {
      const group = appended.get(origin.chatId);
      const index = group ? group.items.findIndex(item => item.origin.messageId === origin.messageId) : -1;
      if (!group || index < 0) return false;
      group.items.splice(index, 1);
      try {
        rebuildGroupSync(file, origin.chatId, group.before, group.items, now());
        log.info('bridge', 'dropped-retracted', { chat: chat(origin), left: group.items.length });
      } catch (error) { log.fail('bridge', error, { phase: 'dropped-retract' }); }
      return true;
    },
  };
}
