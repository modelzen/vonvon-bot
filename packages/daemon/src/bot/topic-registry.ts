import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../core/logger';
import { sanitizeContext } from './context-weave';
import { isRetiredKey, listSessions, type SessionRecord } from './session-store';

/**
 * Topic registry (product.md 3.5 "daemon 在本机记什么"): per bot, one file per
 * group, `<bot dir>/topics/<chat id>.json`, recording every topic the bot saw:
 * its id, its first message (the one it hangs under), who opened it and when,
 * a title, and when it was last active. A topic often opens under an old
 * main-area message, so a time-ordered pull of the main area cannot find it.
 *
 * Whether the bot has a session in a topic is not stored here: reads join this
 * bot's bindings from sessions.json by key (the topic id; keys left from
 * before s15c's one tier are skipped), so every path that binds, rebuilds or
 * resumes a session shows up without writing a second file.
 *
 * Only the title (the first message's first {@link TITLE_MAX} chars) is chat
 * text; nothing else from messages is stored. The file keeps the
 * {@link MAX_TOPICS} most recently active topics, plus older ones that still
 * have a session. Writes go through one lock
 * per file and a function of the latest disk value, so concurrent turns never
 * overwrite each other. Unknown fields are kept; a file that does not parse is
 * moved aside to `.corrupt` on the next write and the registry starts empty.
 */

/** Who sent a message or opened a topic. `self` is this bot. */
export interface TopicPerson {
  kind: 'user' | 'bot' | 'self';
  /** open_id (another bot's open_bot_id); absent for self. */
  openId?: string;
  /** A name known without the name book: another vonvon bot's on this daemon (s14b). Never stored. */
  name?: string;
}

export interface TopicRecord {
  /** Feishu thread id (omt_…). */
  topicId: string;
  /** The topic's first message (root_id): the message it opened under. */
  firstId?: string;
  firstFrom?: TopicPerson;
  /** That message's createTime (epoch ms). */
  firstAt?: number;
  /** The first message's first chars (product.md 3.5); for a resumed session, its title. */
  title?: string;
  /** This bot when it opened the topic; otherwise the sender of the earliest
   * message it got there (a topic group's post: the poster). */
  openedBy?: TopicPerson;
  openedAt: number;
  /** createTime of the newest message the bot got in the topic, to the minute. */
  lastAt: number;
}

/** One sighting of a topic: a message in it, or this bot opening it. */
export interface TopicSighting {
  topicId: string;
  /** The message's createTime (the local clock when this bot opened it). */
  at: number;
  from: TopicPerson;
  /** What is known of the first message; `text` becomes the title. */
  first?: { id: string; from?: TopicPerson; at?: number; text?: string };
}

/** A binding of this bot in the topic (one per tier when tiers are split). */
export interface TopicSession {
  key: string;
  sessionId: string;
  backend: string;
}

export interface TopicView extends TopicRecord {
  sessions: TopicSession[];
}

export interface TopicRegistry {
  /** Record a sighting. Never throws (a failure is logged): it must not fail a
   * turn. Returns the stored record, or undefined when nothing was stored. */
  note(chatId: string, sighting: TopicSighting): Promise<TopicRecord | undefined>;
  /** The group's topics, most recently active first. Never throws. */
  list(chatId: string, opts?: { limit?: number }): Promise<TopicView[]>;
  get(chatId: string, topicId: string): Promise<TopicView | undefined>;
}

export const TITLE_MAX = 30;
/** Topics kept per group; the least recently active without a session go first. */
export const MAX_TOPICS = 200;
/** lastAt moves only in steps this large, so chatter in a topic does not rewrite the file per message. */
const LAST_AT_STEP_MS = 60_000;
const FILE_VERSION = 1;

interface RegistryFile {
  version: number;
  topics: TopicRecord[];
  [extra: string]: unknown;
}

/** The title for a first message's text (file tokens dropped, a `[文字](地址)` link as its text, one line, clamped). */
export function topicTitle(text: string | undefined): string | undefined {
  const plain = (text ?? '').replace(/<file\b[^<]*\/>/g, '').replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1');
  return sanitizeContext(plain, TITLE_MAX, true) || undefined;
}

/**
 * The record after a sighting (pure), or undefined when nothing changes:
 *   - the opener is the earliest sighting's, except that this bot opening the
 *     topic always wins (a reply in the topic can be seen before the bot
 *     learns the new topic's id);
 *   - first-message fields are filled once, never overwritten, except that
 *     this bot opening the topic sets the title (a resumed session's name),
 *     over one a lookup of the first message got in first;
 *   - lastAt only moves up, in steps of a minute.
 */
export function mergeTopic(prev: TopicRecord | undefined, s: TopicSighting): TopicRecord | undefined {
  const first = s.first;
  const title = topicTitle(first?.text);
  if (!prev) {
    return {
      topicId: s.topicId,
      ...(first ? { firstId: first.id } : {}),
      ...(first?.from ? { firstFrom: first.from } : {}),
      ...(first?.at ? { firstAt: first.at } : {}),
      ...(title ? { title } : {}),
      openedBy: s.from,
      openedAt: s.at,
      lastAt: s.at,
    };
  }
  const next: TopicRecord = { ...prev };
  let changed = false;
  if (!prev.openedBy) {
    next.openedBy = s.from;
    next.openedAt = prev.openedAt || s.at;
    changed = true;
  } else if (prev.openedBy.kind !== 'self' && (s.from.kind === 'self' || s.at < prev.openedAt)) {
    next.openedBy = s.from;
    next.openedAt = s.at;
    changed = true;
  }
  if (s.at >= prev.lastAt + LAST_AT_STEP_MS) {
    next.lastAt = s.at;
    changed = true;
  }
  if (first) {
    if (!prev.firstId) { next.firstId = first.id; changed = true; }
    if (first.id === next.firstId) {
      if (!prev.firstFrom && first.from) { next.firstFrom = first.from; changed = true; }
      if (!prev.firstAt && first.at) { next.firstAt = first.at; changed = true; }
      const opening = s.from.kind === 'self' && prev.openedBy?.kind !== 'self';
      if (title && title !== prev.title && (!prev.title || opening)) { next.title = title; changed = true; }
    }
  }
  return changed ? next : undefined;
}

/** Most recently active first. */
function byActivity(topics: TopicRecord[]): TopicRecord[] {
  return [...topics].sort((a, b) => b.lastAt - a.lastAt || b.openedAt - a.openedAt);
}

/** The {@link MAX_TOPICS} most recently active of `sorted`, plus older ones in `bound`. */
function trim(sorted: TopicRecord[], bound: Set<string>): TopicRecord[] {
  return sorted.filter((t, i) => i < MAX_TOPICS || bound.has(t.topicId));
}

/** Last chars of an id, for logs (no full chat ids in logs). */
function tail(id: string): string {
  return id.slice(-6);
}

/** A record read back: needs a topic id; missing times read as 0. */
function normalize(raw: unknown): TopicRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.topicId !== 'string' || !r.topicId) return undefined;
  const openedAt = typeof r.openedAt === 'number' ? r.openedAt : 0;
  return { ...(r as unknown as TopicRecord), openedAt, lastAt: typeof r.lastAt === 'number' ? r.lastAt : openedAt };
}

function emptyFile(): RegistryFile {
  return { version: FILE_VERSION, topics: [] };
}

/** The parsed file (empty when missing), or 'corrupt' when it does not parse. */
async function readStore(file: string): Promise<RegistryFile | 'corrupt'> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RegistryFile> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'corrupt';
    const topics = Array.isArray(parsed.topics) ? parsed.topics.map(normalize).filter((t): t is TopicRecord => Boolean(t)) : [];
    return { ...parsed, version: FILE_VERSION, topics };
  } catch {
    return 'corrupt';
  }
}

/**
 * Another bot's registry, read only (s14b): the group's topics stored under
 * `dir`, [] when there are none. Throws when the file cannot be read or parsed.
 */
export async function readTopicsIn(dir: string, chatId: string): Promise<TopicRecord[]> {
  const store = await readStore(join(dir, fileName(chatId)));
  if (store === 'corrupt') throw new Error('topic registry does not parse');
  return store.topics;
}

// One lock per file, shared by every registry in the process (see session-store's withLock).
const locks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(() => undefined, () => undefined);
  locks.set(file, settled);
  void settled.then(() => {
    if (locks.get(file) === settled) locks.delete(file);
  });
  return run;
}

/** A file name for a chat id: as is when it is a plain id, else a hash. */
function fileName(chatId: string): string {
  const base = /^[\w-]{1,100}$/.test(chatId) ? chatId : createHash('sha256').update(chatId).digest('hex').slice(0, 32);
  return `${base}.json`;
}

/**
 * A registry over `dir` (the bot's `topics/` directory). `sessions` loads this
 * bot's bindings for the join (sessions.json of the current bot by default).
 */
export function createTopicRegistry(opts: {
  dir: string;
  sessions?: () => Promise<SessionRecord[]>;
}): TopicRegistry {
  const loadSessions = opts.sessions ?? listSessions;
  function fileFor(chatId: string): string {
    return join(opts.dir, fileName(chatId));
  }

  async function readTopics(chatId: string): Promise<TopicRecord[]> {
    try {
      const store = await readStore(fileFor(chatId));
      if (store === 'corrupt') {
        log.warn('intake', 'topic-registry-corrupt', { chatId: tail(chatId) });
        return [];
      }
      return store.topics;
    } catch (err) {
      log.warn('intake', 'topic-registry-read-failed', { chatId: tail(chatId), err: String(err) });
      return [];
    }
  }

  /** This bot's live bindings in the group (none when sessions.json cannot be read). */
  async function bindingsIn(chatId: string): Promise<SessionRecord[]> {
    const all = await loadSessions().catch((err: unknown) => {
      log.warn('intake', 'topic-registry-sessions-failed', { chatId: tail(chatId), err: String(err) });
      return [] as SessionRecord[];
    });
    return all.filter((b) => !b.detached && b.chatId === chatId && !isRetiredKey(b.threadId));
  }

  async function view(chatId: string, topics: TopicRecord[]): Promise<TopicView[]> {
    if (!topics.length) return [];
    const bindings = await bindingsIn(chatId);
    return topics.map((t) => {
      const sessions = bindings
        .filter((b) => b.threadId === t.topicId)
        .map((b) => ({ key: b.threadId, sessionId: b.sessionId, backend: b.backend }));
      return { ...t, sessions };
    });
  }

  return {
    async note(chatId, sighting) {
      const file = fileFor(chatId);
      try {
        return await withFileLock(file, async () => {
          let store = await readStore(file);
          if (store === 'corrupt') {
            // Keep the bad file for a look, start over: the registry is rebuilt from new messages.
            await rename(file, `${file}.corrupt`);
            log.warn('intake', 'topic-registry-corrupt', { chatId: tail(chatId), action: 'moved-aside' });
            store = emptyFile();
          }
          const idx = store.topics.findIndex((t) => t.topicId === sighting.topicId);
          const prev = idx === -1 ? undefined : store.topics[idx];
          const next = mergeTopic(prev, sighting);
          if (!next) return prev;
          const topics = byActivity(idx === -1 ? [...store.topics, next] : store.topics.map((t, i) => (i === idx ? next : t)));
          const bound = topics.length > MAX_TOPICS
            ? new Set((await bindingsIn(chatId)).map((b) => b.threadId))
            : new Set<string>();
          const kept = trim(topics, bound);
          await mkdir(opts.dir, { recursive: true });
          const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
          try {
            await writeFile(tmp, `${JSON.stringify({ ...store, topics: kept }, null, 2)}\n`, 'utf8');
            await rename(tmp, file);
          } catch (err) {
            await unlink(tmp).catch(() => undefined);
            throw err;
          }
          return kept.includes(next) ? next : undefined;
        });
      } catch (err) {
        log.warn('intake', 'topic-registry-write-failed', { chatId: tail(chatId), topic: tail(sighting.topicId), err: String(err) });
        return undefined;
      }
    },
    async list(chatId, listOpts) {
      const topics = byActivity(await readTopics(chatId));
      return view(chatId, listOpts?.limit ? topics.slice(0, listOpts.limit) : topics);
    },
    async get(chatId, topicId) {
      const topic = (await readTopics(chatId)).find((t) => t.topicId === topicId);
      return topic ? (await view(chatId, [topic]))[0] : undefined;
    },
  };
}
