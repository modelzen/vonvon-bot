import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { DEFAULT_BACKEND_ID, type ReasoningEffort, type ServiceTier } from '../agent/types';

/**
 * A persisted session = one Feishu topic (thread) bound to a codex thread.
 * Survives bridge restarts so @bot inside an existing topic resumes the right
 * codex thread (instead of silently starting a fresh one) and the ⚙️ per-session
 * model/effort overrides stick.
 */
export interface SessionRecord {
  /** Feishu topic thread_id (the key) */
  threadId: string;
  detached?: boolean;
  chatId: string;
  cwd: string;
  /** backend session id（codex 的 thread id / claude 的 session UUID）—— pass to
   * backend.resumeThread。v1 文件里的旧字段名在 read() 时迁移（见 migrate）。 */
  sessionId: string;
  /** 创建该会话的 agent 后端 id（见 src/agent/index.ts 注册表）。重启后
   * resolveThread 按它路由 resume —— 项目事后换后端不影响既有会话的归属。
   * v1 文件缺省 → 默认 codex 后端（read() 时回填）。 */
  backend: string;
  /** Present only when this binding points at a Bridge-owned native session
   * registered for one-time resume titling. Manual /resume records omit it. */
  titleJobKey?: string;
  /** The native Codex thread that accepted feedback_prepare on start. */
  feedbackToolSessionId?: string;
  model?: string;
  effort?: ReasoningEffort;
  /** Session override; omitted inherits the project's current default. */
  serviceTier?: ServiceTier;
  /** true 表示 {@link model} 是 /model 卡或网页上手填的 id（3.11），不在模型列表里也
   * 照显示；选回列表里的模型时写 false。 */
  modelCustom?: boolean;
  /** first user message excerpt, for context */
  summary: string;
  /** createTime (epoch ms) of the most recent message woven into this session —
   * the high-water mark for topic-history catch-up: every message at or before
   * it reached the session, so the next turn only pulls newer ones (see
   * context-weave.fetchThreadContext). Only moves up (see {@link nextSeen}). */
  lastSeenAt?: number;
  /** Messages newer than {@link lastSeenAt} that reached the session anyway: an
   * interjection, a queued turn, or a trigger whose back-fill failed. One mark
   * cannot cover them, since messages the bot skipped (an @ to someone else)
   * sit in between. Older records lack it. */
  seen?: SeenMark[];
  /** Other bots' cards that were still streaming when a back-fill wove them, at
   * or before {@link lastSeenAt}: the next back-fill reaches back to the oldest
   * and weaves them again, so the session gets their final answer (product.md
   * 3.5). Older records lack it. */
  streaming?: SeenMark[];
  /** The context meter's last reading, saved at the end of a turn so the first
   * card after a restart is not blank. Read only while `sessionId` still matches
   * the record's: a rebuilt, cleared or resumed session starts over. */
  usage?: { sessionId: string; used: number; window: number | null };
  /** A main session that compacted: its native session id, until a turn shows
   * the group's recent topics (s14b); '' once shown. Tied to the session id
   * like {@link usage}, so a new session drops it. Older records lack it. */
  topicsDue?: string;
  /** The newest compaction of the native session the daemon has seen, by the backend's id
   * for it (AgentThread.lastCompaction): a different one marks {@link topicsDue} (s15b).
   * Main sessions only. Older records lack it. */
  compactSeen?: string;
  /** The oldest message the session got (epoch ms): older ones never reached it,
   * and a rebuilt session's opening does not reach past it. `/new` sets it to
   * the command, an opening turn to its oldest line (s15). Older records lack it. */
  from?: number;
  /** Messages that reached the session and were recalled since, said at its next
   * ordinary turn and then dropped (product.md 3.5 "撤回和编辑"). Ids, times and
   * open_ids only, never text. Older records lack it. */
  recalls?: RecallNote[];
  /** What the session was last handed of vonvon's role, supplement and memory (bot/context-assembly.ts). A record
   * without it is an older session: its next turn gets the whole thing again. */
  context?: SessionContext;
  /** The native sessions this key held before {@link sessionId}, oldest first, at most {@link EARLIER_MAX}: a private
   * chat's `/resume` lists these and no other (dm-agent 4.3). `/new` leaves nothing else that says whose a session was. */
  earlier?: string[];
  createdAt: number;
  updatedAt: number;
}

/** What one memory looked like when the session last got it: `[text hash, branch, 1 if trusted]` per active entry. */
export interface MemoryDelivered {
  storeId: string;
  lastEventId?: string;
  /** The branch list the model was told, in order. */
  branches: string[];
  items: Record<string, [string, string, 0 | 1]>;
}
export interface SessionContext {
  /** Section → version of what was last delivered. */
  versions: Record<string, string>;
  /** Random per session, changed at each whole redelivery; the update blocks and `<vonvon-mem>` carry it. */
  nonce: string;
  /** Marks this session was given before (the opening's, earlier redeliveries'): the model may still use them, so they still count. */
  previousNonces?: string[];
  /** A compaction ended since: the next turn hands over everything again. */
  fullRedeliverDue?: boolean;
  memory?: Record<string, MemoryDelivered>;
  lastTurn?: { at: number; injected: number; used: string[]; /** reasons of the hidden blocks not taken (3.4), no text */ missed?: string[] };
}

/** Every mark the session may be using: the current one first. */
export function acceptedNonces(context: Pick<SessionContext, 'nonce' | 'previousNonces'> | undefined): string[] {
  return context ? [context.nonce, ...(context.previousNonces ?? [])] : [];
}

/** A recalled message the session got: its id and send time, who sent it, and
 * whether someone else (a group owner or admin) recalled it. */
export interface RecallNote {
  id: string;
  at: number;
  who?: { kind: 'user' | 'bot'; openId?: string };
  other?: true;
}

/** Recall notes kept per session; the newest win. */
export const RECALLS_MAX = 20;

/** `list` with `note` added once (by id), oldest first, at most {@link RECALLS_MAX}. */
export function addRecall(list: RecallNote[] | undefined, note: RecallNote): RecallNote[] {
  return [...(list ?? []).filter((r) => r.id !== note.id), note].sort((a, b) => a.at - b.at).slice(-RECALLS_MAX);
}

/** One message that reached a session: its id and createTime (epoch ms). */
export interface SeenMark {
  id: string;
  at: number;
}

/** How a mark moves the watermark (see {@link nextSeen}). */
export type SeenHow = 'advance' | 'id' | 'restart';

/** Most marks kept above the watermark; past it the oldest are dropped (and
 * may come back once as history). */
const SEEN_MAX = 64;

/** A session nothing has reached yet (a new or recreated native session before
 * its first turn starts): its next back-fill starts from the topic's beginning,
 * bounded by `from`, which stays. The old session's recall notes go. */
export function nothingSeen(): Pick<SessionRecord, 'lastSeenAt' | 'seen' | 'recalls'> {
  return { lastSeenAt: 0, seen: [], recalls: undefined };
}

/** Whether the message reached the session as a turn, an interjection or a queued turn. */
export function isDelivered(rec: Pick<SessionRecord, 'seen'> | undefined, id: string): boolean {
  return Boolean(rec?.seen?.some((s) => s.id === id));
}

/** Whether the message already reached the session, delivered or woven as
 * history. Without a watermark only delivered ids count. */
export function isSeen(rec: Pick<SessionRecord, 'lastSeenAt' | 'seen'> | undefined, id: string, at: number): boolean {
  return isDelivered(rec, id) || (rec?.lastSeenAt !== undefined && at <= rec.lastSeenAt);
}

/** Whether a back-fill should weave the message (again): not seen yet, or a
 * card the session saw while it was still streaming. */
export function isUnread(rec: Pick<SessionRecord, 'lastSeenAt' | 'seen' | 'streaming'> | undefined, id: string, at: number): boolean {
  return !isSeen(rec, id, at) || Boolean(rec?.streaming?.some((s) => s.id === id));
}

/** Where the next back-fill stops paging back: the watermark, or the oldest
 * card still streaming before it. */
export function backfillFrom(rec: Pick<SessionRecord, 'lastSeenAt' | 'streaming'>): number {
  return Math.min(rec.lastSeenAt ?? 0, ...(rec.streaming ?? []).map((s) => s.at));
}

/**
 * The watermark after `mark` reached the session (pure; apply it through
 * {@link patchSession}'s function form so concurrent marks never lose each other):
 *   - `advance`: everything up to `mark` reached it (a fresh run whose back-fill
 *     succeeded, or one that pulls none). The mark only moves up.
 *   - `id`: only this message did (an interjection, a queued turn, a failed back-fill).
 *   - `restart`: a new session whose back-fill failed: start over from 0 so
 *     the next turn back-fills the whole topic.
 * The newest `advance`, and `restart`, also replace the cards to read again
 * with `streaming` (see {@link SessionRecord.streaming}); `id` keeps them.
 */
export function nextSeen(
  rec: Pick<SessionRecord, 'lastSeenAt' | 'seen' | 'streaming'>,
  mark: SeenMark,
  how: SeenHow,
  streaming: SeenMark[] = [],
): Pick<SessionRecord, 'lastSeenAt' | 'seen' | 'streaming'> {
  const base = how === 'restart' ? 0 : rec.lastSeenAt;
  const lastSeenAt = how === 'advance' ? Math.max(base ?? 0, mark.at) : base;
  const prior = how === 'restart' ? [] : (rec.seen ?? []);
  const seen = [...prior.filter((s) => s.id !== mark.id), mark]
    .filter((s) => lastSeenAt === undefined || s.at >= lastSeenAt)
    .sort((a, b) => a.at - b.at)
    .slice(-SEEN_MAX);
  // The newest advance, or a restart, decides which cards to read again. Set only
  // when there is something to set or to clear (patchSession skips undefined).
  const newest = how === 'restart' || (how === 'advance' && lastSeenAt === mark.at);
  const cards = newest && (streaming.length > 0 || (rec.streaming?.length ?? 0) > 0) ? { streaming } : {};
  return { lastSeenAt, seen, ...cards };
}

export type SessionTitlePhase =
  | 'waiting_source'
  | 'waiting_turn'
  | 'pending'
  | 'generating'
  | 'prepared'
  | 'applying'
  | 'done'
  | 'skipped';

export interface SessionTitlePolicySnapshot {
  strategy: 'model' | 'truncate';
  /** Title generation provider; absent on legacy jobs means the session provider. */
  backend?: string;
  model?: string;
  effort?: ReasoningEffort;
}

export type SessionTitleOutcome = 'written' | 'preexisting' | 'unsupported' | 'excluded' | 'failed';

/**
 * Durable title work is keyed by the HOST session, not the Feishu topic. A
 * single-session group's `/clear` or in-place `/resume` replaces its
 * {@link SessionRecord}, while the parked host session still needs its title
 * job to finish. Keeping this ledger alongside (rather than inside) a binding
 * also deduplicates one host session resumed into multiple Feishu topics.
 */
export interface SessionTitleJob {
  /** Stable compound key produced by {@link sessionTitleJobKey}. */
  key: string;
  backend: string;
  sessionId: string;
  cwd: string;
  phase: SessionTitlePhase;
  /** Clean first user prompt; terminal jobs may erase it after completion. */
  source?: string;
  /** Final normalized value, persisted BEFORE the host title mutation. */
  candidate?: string;
  /** Observed/written terminal title, for diagnostics. */
  finalTitle?: string;
  /** Backend-specific title model choice captured when the job is claimed. */
  policy?: SessionTitlePolicySnapshot;
  /** Worker lease. claimId gates every later conditional transition. */
  claimId?: string;
  leaseUntil?: number;
  /** Persisted immediately before the one allowed native title mutation.
   * Recovery may verify its outcome, but must never issue that mutation again. */
  writeAttempted?: boolean;
  attempts: number;
  nextRetryAt?: number;
  outcome?: SessionTitleOutcome;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: number;
  sessions: SessionRecord[];
  titleJobs: SessionTitleJob[];
}

// v3：在 sessions 绑定外新增按 backend+sessionId 去重的持久 titleJobs。
// 旧 v1/v2 读入时 titleJobs=[]，不静默回填历史会话。
const FILE_VERSION = 3;

/** v1 文件的旧字段名（`codexThread` + `Id`）。拼接而非字面量，是为了让「全链改名
 * 后 grep 旧名 = 0」的判据可机械验证 —— 这里是全仓唯一还认得旧名的地方。 */
const LEGACY_V1_SESSION_FIELD = 'codexThread' + 'Id';

/** 旧记录读入迁移：v1 的旧会话 id 字段 → sessionId；缺 backend 回填默认 codex
 * 后端（v1 时代只有它）。原地落盘格式只在下次写盘时才换新（read 不回写），
 * 所以迁移必须幂等且每次 read 都跑。 */
function migrate(raw: Record<string, unknown>): SessionRecord {
  const rec = raw as unknown as SessionRecord;
  if (typeof rec.sessionId !== 'string') {
    const legacy = raw[LEGACY_V1_SESSION_FIELD];
    if (typeof legacy === 'string') (rec as { sessionId: string }).sessionId = legacy;
  }
  if (typeof rec.backend !== 'string') (rec as { backend: string }).backend = DEFAULT_BACKEND_ID;
  return rec;
}

function emptyStore(): StoreFile {
  return { version: FILE_VERSION, sessions: [], titleJobs: [] };
}

async function readStoreIn(file: string): Promise<StoreFile> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    const sessions = Array.isArray(parsed.sessions)
      ? (parsed.sessions as unknown as Record<string, unknown>[]).map(migrate)
      : [];
    // v1/v2 deliberately migrate to an EMPTY ledger: the feature only owns
    // bridge-created sessions registered after the upgrade.
    const titleJobs =
      typeof parsed.version === 'number' && parsed.version >= 3 && Array.isArray(parsed.titleJobs)
        ? (parsed.titleJobs as SessionTitleJob[])
        : [];
    return { ...parsed, version: FILE_VERSION, sessions, titleJobs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function read(): Promise<StoreFile> {
  return readStoreIn(paths.sessionsFile);
}

/** 读取指定 sessions.json（绝对路径，含 v1 迁移）。Web 控制台 / supervisor 跨
 * bot 聚合视图专用——daemon 进程内绝不可用 useBotDir 全局切目录。 */
export async function listSessionsIn(file: string): Promise<SessionRecord[]> {
  return (await readStoreIn(file)).sessions;
}

// 同进程内并发的「读-改-写」串行化（upsertSession/patchSession）：话题天然并行
// （semaphore 默认 10），两个话题同时落盘会基于同一旧快照算结果、后写覆盖前写——
// 其中一个话题的 sessionId 绑定静默丢失，重启后上下文蒸发。与 registry.ts 的
// 同款锁一致：配合函数式 updater，把 read+算+write 收进一个临界区。
let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(store: StoreFile, beforeCommit?: () => void, file: string = paths.sessionsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const body: StoreFile = { ...store, version: FILE_VERSION };
  try {
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    beforeCommit?.();
    await rename(tmp, file);
  } finally { await unlink(tmp).catch(() => undefined); }
}

export async function listSessions(): Promise<SessionRecord[]> {
  return (await read()).sessions;
}

export async function getSession(threadId: string): Promise<SessionRecord | undefined> {
  return (await read()).sessions.find((s) => s.threadId === threadId && !s.detached);
}

export async function detachSessionsForChat<T>(chatId: string, commit: () => Promise<T>): Promise<T> {
  return detachSessionsForChatIn(paths.sessionsFile, chatId, commit);
}

/**
 * {@link detachSessionsForChat} on a named sessions.json, for the host archiving the sessions of a bot that is not
 * running (a workspace change reaches every bot of a project, memory design §2.1). Only safe while no process owns
 * that bot's files: the in-process lock here does not cover another process.
 */
export async function detachSessionsForChatIn<T>(file: string, chatId: string, commit: () => Promise<T>): Promise<T> {
  return withLock(async () => {
    const store = await readStoreIn(file);
    const original = structuredClone(store);
    for (const session of store.sessions) if (session.chatId === chatId) session.detached = true;
    await write(store, undefined, file);
    try {
      return await commit();
    } catch (error) {
      await write(original, undefined, file);
      throw error;
    }
  });
}

/** A key from before s15c (one tier per group): admins' and guests' sessions of
 * a group with two tiers. Left in sessions.json, never used. */
export const isRetiredKey = (key: string): boolean => /#(admin|guest)$/.test(key);
/** The answer to anything asked of a retired key by its id (desktop, settings). */
export const RETIRED_KEY_TEXT = '这条会话是分管理员、普通成员两档时留下的，已停用；请用群里现在的会话。';

/**
 * At start (s15c): in each group that still stores two tiers, admins talked in
 * `<place>#admin`, so each live such record takes its place's key, replacing
 * any record already there (an older binding nothing read while the split
 * lasted). Guests' `#guest` records, archived `#admin` ones and those of groups
 * no longer split stay as they are. Returns the places; writes only when one
 * moved, so a second run is a no-op.
 */
export async function adoptAdminSessions(splitChats: { has(chatId: string): boolean }): Promise<string[]> {
  return withLock(async () => {
    const store = await read();
    const moved = store.sessions.filter((s) => !s.detached && splitChats.has(s.chatId) && s.threadId.endsWith('#admin'));
    if (!moved.length) return [];
    const places = new Set(moved.map((s) => s.threadId.slice(0, -'#admin'.length)));
    // One record per key: upsert and patch match the first record by key, archived or not.
    store.sessions = store.sessions.filter((s) => !places.has(s.threadId));
    for (const s of moved) s.threadId = s.threadId.slice(0, -'#admin'.length);
    await write(store);
    return [...places];
  });
}

/** Puts `rec` in place of the record at its key, or adds it. */
export const EARLIER_MAX = 50;
/** `earlier` of a key that moves from the native session `held` to `next`. */
function earlierAfter(held: Pick<SessionRecord, 'sessionId' | 'earlier'>, next: string): string[] | undefined {
  if (held.sessionId === next) return held.earlier;
  return [...(held.earlier ?? []).filter(id => id !== next && id !== held.sessionId), held.sessionId].slice(-EARLIER_MAX);
}
function put(store: StoreFile, rec: SessionRecord): void {
  const idx = store.sessions.findIndex((s) => s.threadId === rec.threadId);
  if (idx === -1) { store.sessions.push(rec); return; }
  const held = store.sessions[idx]!;
  const earlier = earlierAfter(held, rec.sessionId);
  if (held.feedbackToolSessionId === rec.sessionId) rec = {...rec, feedbackToolSessionId: rec.sessionId};
  store.sessions[idx] = earlier ? { ...rec, earlier } : rec;
}

/** Insert or replace a session by threadId. */
export async function upsertSession(rec: SessionRecord): Promise<void> {
  return withLock(async () => {
    const store = await read();
    put(store, rec);
    await write(store);
  });
}

/** The live record of the group `chatId` that holds the native session, at a key other than
 * `key` (s15f): another topic or the main area. Archived and retired records hold nothing. */
export function sessionHolder(
  sessions: readonly SessionRecord[],
  want: { chatId: string; key?: string; backend: string; sessionId: string },
): SessionRecord | undefined {
  return sessions.find((s) =>
    s.chatId === want.chatId && s.threadId !== want.key && !s.detached && !isRetiredKey(s.threadId) &&
    s.backend === want.backend && s.sessionId === want.sessionId);
}

/** {@link upsertSession} for a `/resume` (s15f): unless another place of the group holds the
 * native session, then nothing is written and that place's record comes back. Look and write
 * share the lock, so of two places resuming one session at once only one binds it. Resuming
 * the session a key already holds into that key is fine. */
export async function bindSession(rec: SessionRecord): Promise<SessionRecord | undefined> {
  return withLock(async () => {
    const store = await read();
    const holder = sessionHolder(store.sessions, { ...rec, key: rec.threadId });
    if (holder) return holder;
    put(store, rec);
    await write(store);
    return undefined;
  });
}

/** Patch fields of an existing session; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(s) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 避免并发读-改-写丢更新。 */
export async function patchSession(
  threadId: string,
  patch:
    | Partial<Omit<SessionRecord, 'threadId'>>
    | ((s: SessionRecord) => Partial<Omit<SessionRecord, 'threadId'>>),
): Promise<void> {
  return withLock(async () => {
    const store = await read();
    const rec = store.sessions.find((s) => s.threadId === threadId);
    if (!rec) return;
    const actual = typeof patch === 'function' ? patch(rec) : patch;
    const earlier = actual.sessionId ? earlierAfter(rec, actual.sessionId) : undefined;
    if (earlier) rec.earlier = earlier;
    const target = rec as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
      else if (k === 'serviceTier') delete target[k];
    }
    rec.updatedAt = Date.now();
    await write(store);
  });
}

/** Remove a consumed title marker only if it still points at `key`. The
 * conditional protects a concurrent /clear or /resume replacement. */
export async function clearSessionTitleJobKey(threadId: string, key: string): Promise<void> {
  return withLock(async () => {
    const store = await read();
    const rec = store.sessions.find((session) => session.threadId === threadId);
    if (!rec || rec.titleJobKey !== key) return;
    delete rec.titleJobKey;
    rec.updatedAt = Date.now();
    await write(store);
  });
}

/** Stable identity for title exactly-once coordination across Feishu bindings. */
export function sessionTitleJobKey(backend: string, sessionId: string): string {
  return `${backend}:${sessionId}`;
}

export async function listSessionTitleJobs(): Promise<SessionTitleJob[]> {
  return (await read()).titleJobs;
}

export async function getSessionTitleJob(key: string): Promise<SessionTitleJob | undefined> {
  return (await read()).titleJobs.find((job) => job.key === key);
}

/**
 * Insert a title job iff this backend session has never been registered. The
 * existing value wins on duplicates, which makes fresh/adopt/resume races
 * idempotent. `key` is validated so callers cannot accidentally split one host
 * session across two ledger entries.
 */
export async function createSessionTitleJob(job: SessionTitleJob): Promise<boolean> {
  const expected = sessionTitleJobKey(job.backend, job.sessionId);
  if (job.key !== expected) throw new Error(`invalid session title job key: expected ${expected}`);
  return withLock(async () => {
    const store = await read();
    const existing = store.titleJobs.find((item) => item.key === job.key);
    if (existing) return false;
    store.titleJobs.push(job);
    await write(store);
    return true;
  });
}

/**
 * Atomic compare-and-replace for worker claims and every later phase transition.
 * Predicate + updater run under the SAME lock and against the latest disk value;
 * only one concurrent `pending -> generating` claimant can win. Unlike
 * patchSession, the updater returns a COMPLETE replacement: omitting source,
 * candidate, policy, claimId, etc. really removes it, which terminal/recovery
 * transitions need. Stable identity and createdAt cannot be changed.
 */
export async function updateSessionTitleJob(
  key: string,
  predicate: (job: Readonly<SessionTitleJob>) => boolean,
  updater: (job: Readonly<SessionTitleJob>) => SessionTitleJob,
): Promise<boolean> {
  return withLock(async () => {
    const store = await read();
    const idx = store.titleJobs.findIndex((item) => item.key === key);
    if (idx === -1) return false;
    const job = store.titleJobs[idx]!;
    if (!predicate(job)) return false;
    const snapshot: SessionTitleJob = { ...job, ...(job.policy ? { policy: { ...job.policy } } : {}) };
    const replacement = updater(snapshot);
    if (
      replacement.key !== job.key ||
      replacement.backend !== job.backend ||
      replacement.sessionId !== job.sessionId ||
      replacement.createdAt !== job.createdAt
    ) {
      throw new Error('session title job updater cannot change stable identity or createdAt');
    }
    store.titleJobs[idx] = { ...replacement, updatedAt: Date.now() };
    await write(store);
    return true;
  });
}

export async function mutateSession(threadId: string, mutate: (session: SessionRecord) => void | Promise<void>, options?: { beforeCommit?: () => void }): Promise<SessionRecord> {
  return withLock(async () => {
    const store = await read();
    const session = store.sessions.find(item => item.threadId === threadId);
    if (!session) throw new Error('会话不存在或已被删除');
    await mutate(session);
    session.updatedAt = Date.now();
    await write(store, options?.beforeCommit);
    return session;
  });
}
