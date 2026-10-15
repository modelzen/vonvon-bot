import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { loadBots } from '../config/bots';
import { botPaths } from '../config/paths';
import { log } from '../core/logger';
import { scopeDenial } from '../utils/feishu-error';
import { reportScopeDenied } from './diagnostics';
import { fetchTopicOpener, type ContextMessage, type TopicQuote, type TopicRow, type Who } from './context-weave';
import { withDeadline, type NameBook } from './names';
import { readTopicsIn, type TopicPerson, type TopicRecord, type TopicRegistry, type TopicView } from './topic-registry';

/**
 * Topics in a record block (product.md 3.5, s14b): which registry topics
 * become 引用行 or table rows, and two Feishu lookups the openings need —
 * whether a group has a main area at all, and who opened a topic another bot
 * started (this bot gets no events for that bot's messages). The topics the
 * other vonvon bots on this daemon opened come from their registries instead.
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
  const name = p.name ?? names.peek(p.openId);
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

/** Another vonvon bot on this daemon: its name and its topic registry's directory. */
export interface LocalBot {
  name?: string;
  topicsDir: string;
}

/** The vonvon bots in bots.json other than `selfAppId`. */
export async function localBots(selfAppId: string): Promise<LocalBot[]> {
  return (await loadBots()).bots
    .filter((b) => b.appId !== selfAppId)
    .map((b) => ({ ...(b.botName ? { name: b.botName } : {}), topicsDir: botPaths(b.appId).topicsDir }));
}

/**
 * A topic another local bot opened, as this bot sees it: opened by that bot,
 * with its first message's sender only when that bot sent it (the other
 * open_ids are of that bot's app). Its sessions are that bot's: none shown.
 */
function asLocal(t: TopicRecord, name: string | undefined): TopicView {
  const bot: TopicPerson = { kind: 'bot', ...(name ? { name } : {}) };
  const { topicId, firstId, firstAt, title, openedAt, lastAt } = t;
  return { topicId, ...(firstId ? { firstId } : {}), ...(firstAt ? { firstAt } : {}), ...(title ? { title } : {}),
    ...(t.firstFrom?.kind === 'self' ? { firstFrom: bot } : {}), openedBy: bot, openedAt, lastAt, sessions: [] };
}

/**
 * This bot's topics plus the local bots' (pure). A topic both know keeps this
 * bot's record and sessions, but takes its opener from the bot that opened it,
 * unless this bot did, and the earlier opening time.
 */
function withLocal(own: TopicView[], local: TopicView[]): TopicView[] {
  const theirs = new Map(local.map((t) => [t.topicId, t]));
  const merged = own.map((t) => {
    const o = theirs.get(t.topicId);
    theirs.delete(t.topicId);
    return o && t.openedBy?.kind !== 'self' ? { ...t, openedBy: o.openedBy, openedAt: Math.min(t.openedAt, o.openedAt) } : t;
  });
  return [...merged, ...theirs.values()];
}

export interface TopicContext {
  /** A topic group (话题群 / 话题形式群): no main-area chat. False when unknown. */
  noMainArea(chatId: string): Promise<boolean>;
  /** Record the topics under `msgs` (main-area lines) the registry does not know yet. */
  discover(chatId: string, msgs: ContextMessage[], known: Set<string>): Promise<TopicView[]>;
  /** `own` (this bot's topics in the group) with the ones the other vonvon bots
   * on this daemon opened there, read from their registries. Never throws. */
  quotable(chatId: string, own: TopicView[]): Promise<TopicView[]>;
}

/**
 * `track` keeps registry writes for shutdown; `stopping` skips them once it starts.
 * Per process: a chat's mode is cached (an hour, ten minutes when unknown),
 * and each topic is looked up at most once: a turn that reaches a topic still
 * being looked up, or one recorded after its list was read, gets that lookup's answer.
 * `localBots` lists the other vonvon bots whose registries {@link TopicContext.quotable} reads.
 */
export function createTopicContext(
  channel: LarkChannel,
  topics: TopicRegistry | undefined,
  names: NameBook,
  opts: { stopping: () => boolean; track: <T>(p: Promise<T>) => Promise<T>; localBots?: () => Promise<LocalBot[]> },
): TopicContext {
  const modes = new Map<string, { topic: Promise<boolean>; until: number }>();
  const looked = new Map<string, Promise<TopicView | undefined>>();

  async function chatMode(chatId: string): Promise<{ topic: boolean; ttl: number }> {
    const unknown = (reason: string, failure?: unknown) => {
      const denied = Boolean(scopeDenial(failure));
      const why = denied ? { reason: 'missing-scope', scope: 'im:chat:readonly' } : { reason };
      if (denied) reportScopeDenied('im:chat:readonly', 'chat-info');
      log.info('intake', 'chat-mode-unknown', { chatId: chatId.slice(-6), ...why });
      return { topic: false, ttl: 10 * 60_000 };
    };
    try {
      const res = await withDeadline(channel.rawClient.im.v1.chat.get({ path: { chat_id: chatId } }), 3000);
      if (!res) return unknown('timeout');
      if (typeof res.code === 'number' && res.code !== 0) return unknown(`code=${res.code}`, res);
      const d = res.data as { chat_mode?: string; group_message_type?: string } | undefined;
      const topic = d?.chat_mode === 'topic' || d?.group_message_type === 'thread';
      log.info('intake', 'chat-mode', { chatId: chatId.slice(-6), topic });
      return { topic, ttl: HOUR };
    } catch (err) {
      return unknown(String(err), err);
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
      // Cached before it answers, so concurrent openings share one lookup.
      const entry = {
        topic: chatMode(chatId).then((r) => {
          entry.until = Date.now() + r.ttl;
          return r.topic;
        }),
        until: Infinity,
      };
      modes.set(chatId, entry);
      return entry.topic;
    },
    async discover(chatId, msgs, known) {
      if (!topics) return [];
      const roots = msgs.filter((m) => m.threadId && !known.has(m.threadId));
      // Topics already looked up take none of the 5 slots.
      const fresh = new Set(roots.filter((m) => !looked.has(m.threadId!)).slice(-DISCOVER_MAX));
      const found = await Promise.all(roots.filter((m) => fresh.has(m) || looked.has(m.threadId!)).map((root) => {
        const topicId = root.threadId!;
        const hit = looked.get(topicId);
        if (hit) return hit;
        if (looked.size >= 1000) looked.clear();
        const lookup = (async (): Promise<TopicView | undefined> => {
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
        })().catch(() => undefined);
        looked.set(topicId, lookup);
        return lookup;
      }));
      return found.filter((t): t is TopicView => Boolean(t));
    },
    async quotable(chatId, own) {
      if (!topics || !opts.localBots) return own;
      // A registry that is missing has nothing; one that cannot be read is skipped, logged once a call.
      let skipped = 0;
      const bots = await opts.localBots().catch((): LocalBot[] => { skipped += 1; return []; });
      const local = await Promise.all(bots.map((bot) => readTopicsIn(bot.topicsDir, chatId).then(
        (ts) => ts.filter((t) => t.openedBy?.kind === 'self').map((t) => asLocal(t, bot.name)),
        () => { skipped += 1; return []; },
      )));
      if (skipped) log.info('intake', 'local-bot-topics-skipped', { chatId: chatId.slice(-6), skipped });
      return withLocal(own, local.flat());
    },
  };
}
