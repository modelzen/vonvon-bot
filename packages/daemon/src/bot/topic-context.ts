import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { scopeDenial } from '../utils/feishu-error';
import { fetchTopicOpener, type ContextMessage, type TopicQuote, type TopicRow, type Who } from './context-weave';
import { withDeadline, type NameBook } from './names';
import type { TopicPerson, TopicRegistry, TopicView } from './topic-registry';

/**
 * Topics in a record block (product.md 3.5, s14b): which registry topics
 * become 引用行 or table rows, and two Feishu lookups the openings need —
 * whether a group has a main area at all, and who opened a topic another bot
 * started (this bot gets no events for that bot's messages).
 */

/** 引用行 per block at most; the newest are kept, the rest only counted. */
export const QUOTES_MAX = 10;
/** Unknown topic roots looked up per turn at most. */
const DISCOVER_MAX = 5;
const HOUR = 60 * 60_000;

/** The topics a block may quote: opened in the window, not excluded or skipped. */
export interface QuoteWindow {
  /** Opened after this (an existing session's watermark)… */
  after?: number;
  /** …or at or after this (the oldest woven line). */
  from?: number;
  /** Opened at or before this (the trigger, or the topic's first message). */
  to: number;
  /** The topic the block is for. */
  exclude?: string;
  /** Already quoted to this session. */
  skip?: (t: TopicView) => boolean;
  /** The session's tier: only that tier's binding gives a session id. */
  tier?: 'admin' | 'guest';
}

/** Someone the registry recorded, as a block names them. */
export function personOf(p: TopicPerson | undefined, names: NameBook): Who | undefined {
  if (!p) return undefined;
  if (p.kind === 'self') return { kind: 'self' };
  const name = names.peek(p.openId);
  if (p.kind === 'bot') return { kind: 'bot', name };
  return { kind: 'user', name: name ?? (p.openId ? `用户${p.openId.slice(-4)}` : undefined) };
}

function quoteOf(t: TopicView, tier: QuoteWindow['tier'], names: NameBook): TopicQuote {
  const key = tier ? `${t.topicId}#${tier}` : t.topicId;
  const sessionId = t.sessions.find((s) => s.key === key)?.sessionId;
  return {
    topicId: t.topicId,
    title: t.title,
    at: t.openedAt,
    who: personOf(t.openedBy, names),
    ...(t.firstId ? { root: { id: t.firstId, at: t.firstAt, who: personOf(t.firstFrom, names) } } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

/** The 引用行 for a window, oldest first, and how many were cut over {@link QUOTES_MAX}. */
export function topicQuotes(topics: TopicView[], w: QuoteWindow, names: NameBook): { quotes: TopicQuote[]; more: number } {
  const ids = new Set<string>();
  const hits = topics
    .filter((t) => {
      if (ids.has(t.topicId)) return false;
      ids.add(t.topicId);
      const opened = w.after !== undefined ? t.openedAt > w.after : t.openedAt >= (w.from ?? 0);
      return t.topicId !== w.exclude && opened && t.openedAt <= w.to && !w.skip?.(t);
    })
    .sort((a, b) => a.openedAt - b.openedAt);
  const kept = hits.slice(-QUOTES_MAX);
  return { quotes: kept.map((t) => quoteOf(t, w.tier, names)), more: hits.length - kept.length };
}

/** Table rows for topics, in the order given. */
export function topicRows(topics: TopicView[], tier: QuoteWindow['tier'], names: NameBook): TopicRow[] {
  return topics.map((t) => ({ ...quoteOf(t, tier, names), lastAt: t.lastAt }));
}

export interface TopicContext {
  /** A topic group (话题群 / 话题形式群): no main-area chat. False when unknown. */
  noMainArea(chatId: string): Promise<boolean>;
  /** Record the topics under `msgs` (main-area lines) the registry does not know yet. */
  discover(chatId: string, msgs: ContextMessage[], known: Set<string>): Promise<TopicView[]>;
}

/**
 * `track` keeps registry writes for shutdown; `stopping` skips them once it starts.
 * Per process: a chat's mode is cached (an hour, ten minutes when unknown),
 * and each topic is looked up at most once.
 */
export function createTopicContext(
  channel: LarkChannel,
  topics: TopicRegistry | undefined,
  names: NameBook,
  opts: { stopping: () => boolean; track: <T>(p: Promise<T>) => Promise<T> },
): TopicContext {
  const modes = new Map<string, { topic: Promise<boolean>; until: number }>();
  const tried = new Set<string>();

  async function chatMode(chatId: string): Promise<{ topic: boolean; ttl: number }> {
    const unknown = (reason: string, extra: object = {}) => {
      log.info('intake', 'chat-mode-unknown', { chatId: chatId.slice(-6), reason, ...extra });
      return { topic: false, ttl: 10 * 60_000 };
    };
    try {
      const res = await withDeadline(channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } }), 3000);
      if (!res) return unknown('timeout');
      if (typeof res.code === 'number' && res.code !== 0) {
        return scopeDenial(res) ? unknown('missing-scope', { scope: 'im:chat:readonly' }) : unknown(`code=${res.code}`);
      }
      const d = res.data as { chat_mode?: string; group_message_type?: string } | undefined;
      const topic = d?.chat_mode === 'topic' || d?.group_message_type === 'thread';
      log.info('intake', 'chat-mode', { chatId: chatId.slice(-6), topic });
      return { topic, ttl: HOUR };
    } catch (err) {
      return scopeDenial(err) ? unknown('missing-scope', { scope: 'im:chat:readonly' }) : unknown(String(err));
    }
  }

  function person(from: ContextMessage['from'], openId: string | undefined): TopicPerson {
    if (from === 'self') return { kind: 'self' };
    return openId ? { kind: from, openId } : { kind: from };
  }

  return {
    noMainArea(chatId) {
      const hit = modes.get(chatId);
      if (hit && hit.until > Date.now()) return hit.topic;
      const entry = { topic: chatMode(chatId).then((r) => { entry.until = Date.now() + r.ttl; return r.topic; }), until: Infinity };
      modes.set(chatId, entry);
      return entry.topic;
    },
    async discover(chatId, msgs, known) {
      if (!topics) return [];
      const roots = msgs.filter((m) => m.threadId && !known.has(m.threadId) && !tried.has(m.threadId)).slice(-DISCOVER_MAX);
      const found = await Promise.all(roots.map(async (root): Promise<TopicView | undefined> => {
        const topicId = root.threadId!;
        if (tried.size >= 1000) tried.clear();
        tried.add(topicId);
        const opener = await fetchTopicOpener(channel, topicId, root.messageId, names);
        if (!opener || opts.stopping()) return undefined;
        const rec = await opts.track(topics.note(chatId, {
          topicId,
          at: opener.at,
          from: person(opener.from, opener.senderId),
          first: { id: root.messageId, from: person(root.from, root.senderId), at: root.createTime || undefined, text: root.text },
        }));
        if (rec) log.info('intake', 'topic-discovered', { chatId: chatId.slice(-6), topic: topicId.slice(-6), opener: opener.from });
        return rec ? { ...rec, sessions: [] } : undefined;
      }));
      return found.filter((t): t is TopicView => Boolean(t));
    },
  };
}
