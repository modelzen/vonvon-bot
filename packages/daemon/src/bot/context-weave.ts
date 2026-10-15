import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { labelScope } from '../config/scopes';
import { scopeDenial, type FeishuErrorBody } from '../utils/feishu-error';
import { extractSendCardText, isSendCard, isStreamingCard } from './card-content';
import { withDeadline, type NameBook } from './names';

/**
 * Inbound CONTEXT weaving — give codex the上下文 a Feishu @ alone doesn't carry.
 *
 * Feishu's message event only delivers the triggering message itself. Three
 * blind spots follow:
 *   1. 引用消息 (quote reply): the user 引用 another message + @bot. The quoted
 *      message id rides in `NormalizedMessage.replyToMessageId` (= the raw
 *      event's `parent_id`), but its CONTENT is never pushed — it must be pulled
 *      with `im.v1.message.get`.
 *   2. 话题上文 (topic history): people chat in a topic, then @bot mid-thread with
 *      little/no description. Those人对人 messages were never @ the bot, so the
 *      bridge dropped them at the @门 — codex has never seen them. They must be
 *      pulled with `im.v1.message.list` (container_id_type='thread').
 *   3. 主区 (a single group's main area): the same, pulled with
 *      container_id_type='chat', which lists main-area messages and topic roots
 *      but not topic replies.
 *
 * codex has no native "quoted message" / "chat history" input, so — exactly like
 * inbound files (see {@link import('./media').weaveFileManifest}) — we fold the
 * pulled text into the prompt as clearly-fenced blocks PREPENDED to the user's
 * actual line (which stays the instruction codex acts on). Pulled history goes
 * into one record block, `[飞书 · 群「…」· 主区|话题「…」· 你是「…」] … [/飞书]`
 * (product.md 3.5), one line per message with its time and real name; other
 * bots' answers are read from their cards (`card_msg_content_type`, e10).
 *
 * The bot reads these with its OWN tenant identity — no second identity /
 * lark-cli needed. Reading history needs `im:message:readonly` (required since
 * v1, see config/scopes.ts); an app that hasn't been granted it gets Feishu's
 * 99991672 rejection, which a pull logs as a structured `thread-context-failed`
 * / `chat-context-failed` warning naming the scope (see {@link scopeDenial}).
 * Every fetch is best-effort: a deleted message, a missing scope, or a timeout
 * ({@link FETCH_DEADLINE_MS}; the SDK's calls have none) is logged and skipped,
 * never thrown — a missing block must not break the turn.
 *
 * {@link sanitizeContext} is the SINGLE sanitization boundary for this
 * uploader-controlled text (mirrors media.cleanFileName): it strips control
 * chars and clamps length right before the text is woven into the prompt.
 */

/** Max chars woven for one quoted message (collapsed to a single line). */
const QUOTE_MAX = 800;
/** Max chars per person's line in a record block (collapsed to a single line each). */
const LINE_MAX = 280;
/** Max chars of a bot's line: other bots only bring their answer, cut to a few hundred chars (3.5). */
const BOT_LINE_MAX = 300;
/** Lines a new session's opening carries, most recent kept (see {@link keepRecent}). */
export const OPENING_MAX = 20;
/** Main-area lines a topic session's opening carries (product.md 3.5). */
export const OPENING_MAIN_MAX = 10;
/** Lines a back-fill into an existing session carries; older ones are only counted. */
export const BACKFILL_MAX = 40;
/** How long another bot's card that is still streaming gets read again on later
 * turns (session-store's `streaming`); after that it is taken as it was. */
export const STREAMING_RECHECK_MS = 10 * 60_000;
/** Feishu's page_size ceiling for one newest-first page. */
const PAGE_SIZE = 50;
/** Pages pulled at most per turn (500 messages); the rest is logged as cut. */
const PAGE_CAP = 10;
/** How long one pull, all its pages together, or one lookup may take: the turn
 * waits for it, and a stuck Feishu call would otherwise hold the turn forever. */
const FETCH_DEADLINE_MS = 10_000;
/** How long the lookup of a topic's first reply may take (at most 5 per turn, in parallel). */
const OPENER_DEADLINE_MS = 3000;
/** Pulls and lookups get cards in the send format, so another bot's answer is
 * readable; without it a 2.0 or CardKit card is only its title (e10). */
const CARD_CONTENT = 'user_card_content';

/** The scope this app requests for reading chat history with its own identity (config/scopes.ts). */
const HISTORY_SCOPE = 'im:message:readonly';

/** A message pulled for context (the quoted message, or one history entry). */
export interface ContextMessage {
  messageId: string;
  /** Best-effort display name (sender_name, else the name book's, else `用户<id尾4>`, else 某人). */
  senderName: string;
  /** Plain text extracted from the message body (NOT yet sanitized). */
  text: string;
  /** A person, another bot or app, or this bot itself. */
  from: 'user' | 'bot' | 'self';
  /** A person's open_id, or a bot's open_bot_id (undefined when the item has neither). */
  senderId?: string;
  /** create_time as epoch ms (0 when unknown). */
  createTime: number;
  /** It @-mentions this bot (that mention is then left out of `text`). */
  mentionsMe?: boolean;
  /** A card still streaming: its bot has not finished answering. */
  streaming?: boolean;
  /** The topic it is in (a main-area pull lists only a topic's first message). */
  threadId?: string;
}

/** Subset of the `im.v1.message.get` / `.list` item shape we read. */
interface RawMsgItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  thread_id?: string;
  root_id?: string;
  /** `sender_name` and `open_bot_id` come only `with_sender_name` (e10). */
  sender?: { id?: string; id_type?: string; sender_type?: string; sender_name?: string; open_bot_id?: string };
  body?: { content?: string };
  mentions?: { key?: string; id?: string; id_type?: string; name?: string }[];
}

/** Remember every name a pulled item carries: its sender (a bot by its
 * `open_bot_id`, which matches the open_id in event mentions) and its @mentions. */
function learnNames(names: NameBook | undefined, item: RawMsgItem): void {
  if (!names) return;
  const s = item.sender;
  if (s?.sender_type === 'user' && isOpenId(s.id_type)) names.remember(s.id, s.sender_name);
  else if (s?.open_bot_id) names.remember(s.open_bot_id, s.sender_name);
  for (const m of item.mentions ?? []) if (isOpenId(m.id_type)) names.remember(m.id, m.name);
}

/** A person's open_id, or a bot's open_bot_id (undefined when the item has neither). */
function senderIdOf(s: RawMsgItem['sender']): string | undefined {
  if (s?.sender_type !== 'user') return s?.open_bot_id;
  return s.id && isOpenId(s.id_type) ? s.id : undefined;
}

/** An item's id is an open_id unless it says otherwise. */
function isOpenId(idType: string | undefined): boolean {
  return (idType ?? 'open_id') === 'open_id';
}

/** This bot as a sender: its open_id (what `open_bot_id` carries) and its app id (an app sender's `id`). */
interface Me {
  openId?: string;
  appId?: string;
}

function meOf(channel: LarkChannel): Me {
  return { openId: channel.botIdentity?.openId, appId: channel.rawClient.appId };
}

/** Who sent an item; undefined for a system notice (it has no sender). */
function kindOf(s: RawMsgItem['sender'], me: Me): ContextMessage['from'] | undefined {
  if (s?.sender_type === 'user') return 'user';
  if (s?.sender_type !== 'app') return undefined;
  return (me.openId && s.open_bot_id === me.openId) || (me.appId && s.id === me.appId) ? 'self' : 'bot';
}

// ── pulling ──────────────────────────────────────────────────────────────

/**
 * Fetch the quoted/replied message's content by id. Returns undefined when the
 * message is missing/deleted/empty or the call fails (all best-effort).
 */
export async function fetchQuotedMessage(
  channel: LarkChannel,
  messageId: string,
  names?: NameBook,
): Promise<ContextMessage | undefined> {
  try {
    const res = await withDeadline(channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { with_sender_name: true, card_msg_content_type: CARD_CONTENT },
    }), FETCH_DEADLINE_MS);
    if (!res) {
      log.warn('intake', 'quote-fetch-failed', { messageId, err: 'timeout' });
      return undefined;
    }
    const items = (res.data as { items?: RawMsgItem[] } | undefined)?.items ?? [];
    const item = items[0];
    if (!item || item.deleted) return undefined;
    learnNames(names, item);
    const cm = toContextMessage(item, meOf(channel), names);
    return cm.text.trim() ? cm : undefined;
  } catch (err) {
    log.warn('intake', 'quote-fetch-failed', { messageId, err: String(err) });
    return undefined;
  }
}

/** One history pull: the messages found, oldest→newest. */
export interface ThreadPull {
  messages: ContextMessage[];
  /** false when a page failed (messages is then empty): the watermark must not move. */
  ok: boolean;
  /** true when paging reached `stopAt` or the start; false when it stopped at the page cap or after `enough`. */
  complete: boolean;
  /** Main area only: this bot's own messages a topic hangs under, left out of
   * `messages`. Another bot's topic under one sends this bot no event (s14c). */
  ownRoots?: ContextMessage[];
}

/** What a pull collects (see {@link fetchThreadContext}). */
export interface PullOpts {
  stopAt?: number;
  enough?: number;
  before?: number;
  excludeMessageId?: string;
  keepId?: string;
  /** Keep this bot's own messages too (a topic opening's main-area lines). */
  keepSelf?: boolean;
  names?: NameBook;
}

/**
 * Page through a topic newest-first (`with_sender_name`, so people and bots
 * come with real names; cards in the send format, so another bot's answer
 * is readable) and collect its messages:
 *   - `stopAt`: the session's watermark. Paging stops at the first page that
 *     reaches it; 0 means none (a fresh session's opening).
 *   - `enough`: also stop once this many are found (for an opening, where
 *     only the most recent ones are woven).
 *   - `before`: only messages up to this (the trigger's createTime), so a
 *     message that arrives as its own turn later is not woven twice; one in
 *     the same ms is kept, as the watermark moving to the trigger covers it.
 * This bot's own replies, system notices, deleted, empty and
 * `excludeMessageId` messages are dropped, except `keepId` (the topic's first
 * message, kept even when this bot sent it). Other bots stay. Own replies are
 * dropped as already in the session (product.md 3.5); in a group split into
 * admin and guest tiers that holds only for the tier that answered, so each
 * tier's session sees the other's questions without the answers. The guest
 * session must not get the admin one's answers; the admin session missing the
 * guest answers is accepted.
 * Filtering by what the session has already seen is the caller's job
 * (session-store.isSeen). Never throws: a failure logs and returns `ok: false`.
 */
export function fetchThreadContext(channel: LarkChannel, threadId: string, opts: PullOpts = {}): Promise<ThreadPull> {
  return pullContext(channel, { type: 'thread', id: threadId }, opts);
}

/**
 * Page through a group's main area the same way. The `chat` container lists
 * main-area messages and topic roots, not topic replies (session-map 3.6); a
 * reply that shows up anyway is dropped. The window is also bounded on the
 * server with `start_time` / `end_time` (seconds, so rounded outwards); the
 * exact bounds stay the local filters.
 */
export function fetchChatContext(channel: LarkChannel, chatId: string, opts: Omit<PullOpts, 'keepId'> = {}): Promise<ThreadPull> {
  return pullContext(channel, { type: 'chat', id: chatId }, opts);
}

interface Container {
  type: 'thread' | 'chat';
  id: string;
}

async function pullContext(channel: LarkChannel, c: Container, opts: PullOpts): Promise<ThreadPull> {
  const stopAt = opts.stopAt ?? 0;
  const found: ContextMessage[] = [];
  const ownRoots: ContextMessage[] = [];
  /** Each listed message's topic, and the main-area messages whose root_id is another message (see below). */
  const threadOf = new Map<string, string>();
  const held: { m: ContextMessage; own: boolean; rootId: string }[] = [];
  const take = (m: ContextMessage, own: boolean): void => {
    if (!own) {
      if (m.text.trim().length > 0) found.push(m);
    } else if (c.type === 'chat' && m.threadId) {
      ownRoots.push(m);
    }
  };
  function done(complete: boolean): ThreadPull {
    for (const h of held.splice(0)) if (threadOf.get(h.rootId) !== h.m.threadId) take(h.m, h.own);
    const byTime = (a: ContextMessage, b: ContextMessage): number => a.createTime - b.createTime;
    const pull: ThreadPull = { messages: found.sort(byTime), ok: true, complete };
    if (ownRoots.length) pull.ownRoots = ownRoots.sort(byTime);
    return pull;
  }
  const window: { start_time?: string; end_time?: string } = {};
  if (c.type === 'chat' && stopAt > 0) window.start_time = String(Math.floor(stopAt / 1000));
  if (c.type === 'chat' && opts.before) window.end_time = String(Math.ceil(opts.before / 1000));
  let pageToken: string | undefined;
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  try {
    const me = meOf(channel);
    for (let page = 0; page < PAGE_CAP; page++) {
      const res = await withDeadline(channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: c.type,
          container_id: c.id,
          sort_type: 'ByCreateTimeDesc',
          page_size: PAGE_SIZE,
          with_sender_name: true,
          card_msg_content_type: CARD_CONTENT,
          ...window,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), deadline - Date.now());
      if (!res) {
        // Out of time. The pages read so far hold the most recent messages and are
        // kept, as at the page cap; with none, the pull fails and the watermark stays.
        if (page > 0) {
          log.info('intake', `${c.type}-context-timeout`, { ...where(c), pages: page, found: found.length });
          return done(false);
        }
        log.warn('intake', `${c.type}-context-failed`, { ...where(c), reason: 'timeout' });
        return failedPull();
      }
      // The SDK only throws on HTTP errors; a 200 with a non-zero code is a failure too.
      if (typeof res.code === 'number' && res.code !== 0) {
        warnContextFailed(c, res);
        return failedPull();
      }
      const data = res.data as { items?: RawMsgItem[]; has_more?: boolean; page_token?: string } | undefined;
      const items = data?.items ?? [];
      let oldest = Infinity;
      for (const it of items) {
        learnNames(opts.names, it);
        const m = toContextMessage(it, me, opts.names);
        if (m.createTime > 0) oldest = Math.min(oldest, m.createTime);
        const kind = kindOf(it.sender, me);
        if (it.thread_id) threadOf.set(m.messageId, it.thread_id);
        if (
          it.deleted ||
          kind === undefined || // drop system notices
          m.messageId === opts.excludeMessageId || // drop the triggering @ message
          (opts.before && m.createTime > opts.before) // the trigger's own ms too: the watermark covers it
        ) continue;
        const own = kind === 'self' && !opts.keepSelf && m.messageId !== opts.keepId; // the bot's own replies (see above)
        if (c.type === 'chat' && it.thread_id && it.root_id && it.root_id !== it.message_id) {
          // A topic reply, which the chat container should not list, or a reply that a
          // topic was opened under later: its root_id stays the message it replied to.
          // It is a topic reply only when that root is listed in the same topic (s14c).
          held.push({ m, own, rootId: it.root_id });
          continue;
        }
        // The bot's own messages are left out; one a topic hangs under is handed back apart (s14c).
        take(m, own);
      }
      if (!data?.has_more || !data.page_token || items.length === 0) return done(true);
      if (stopAt > 0 && oldest <= stopAt) return done(true);
      if (opts.enough && found.length >= opts.enough) return done(false);
      pageToken = data.page_token;
    }
    log.info('intake', `${c.type}-context-page-cap`, { ...where(c), pages: PAGE_CAP, found: found.length });
    return done(false);
  } catch (err) {
    warnContextFailed(c, err);
    return failedPull();
  }
}

/** A container for the log: a topic's id, or a chat id's last 6 chars. */
function where(c: Container): Record<string, string> {
  return c.type === 'thread' ? { threadId: c.id } : { chatId: c.id.slice(-6) };
}

function failedPull(): ThreadPull {
  return { messages: [], ok: false, complete: false };
}

/** The most recent `limit` messages to weave (oldest→newest in, same order
 * out), always keeping `pinId` (a topic's first message) when present. */
export function keepRecent(msgs: ContextMessage[], pinId?: string, limit = OPENING_MAX): ContextMessage[] {
  if (msgs.length <= limit) return msgs;
  const pinned = pinId ? msgs.find((m) => m.messageId === pinId) : undefined;
  const rest = msgs.filter((m) => m !== pinned);
  const out = pinned ? [pinned, ...rest.slice(-(limit - 1))] : rest.slice(-limit);
  log.info('intake', 'thread-context-truncated', { kept: out.length, total: msgs.length });
  return out;
}

/**
 * Log a failed history pull. A missing scope gets a structured warning naming the
 * scope to grant (so the gap is visible in the log rather than a bare error
 * string); anything else keeps the plain error. The turn still proceeds without
 * the record block either way.
 */
function warnContextFailed(c: Container, failure: unknown): void {
  const event = `${c.type}-context-failed`;
  const denial = scopeDenial(failure);
  if (denial) {
    // We request HISTORY_SCOPE; name another only when Feishu says ours wouldn't satisfy the call.
    const scope = denial.accepted.includes(HISTORY_SCOPE) ? HISTORY_SCOPE : (denial.accepted[0] ?? HISTORY_SCOPE);
    log.warn('intake', event, {
      ...where(c),
      reason: 'missing-scope',
      scope,
      scopeLabel: labelScope(scope),
      code: denial.code,
      ...(denial.accepted.length ? { accepted: denial.accepted } : {}),
    });
    return;
  }
  // A returned error body has no useful String(); show its code and msg instead.
  const body = failure as FeishuErrorBody | undefined;
  const err =
    failure instanceof Error || typeof body?.code !== 'number'
      ? String(failure)
      : `code=${body.code} msg=${String(body.msg ?? '')}`;
  log.warn('intake', event, { ...where(c), err });
}

function toContextMessage(item: RawMsgItem, me: Me, names?: NameBook): ContextMessage {
  const id = item.sender?.id ?? '';
  const name = item.sender?.sender_name || names?.peek(id) || (id ? `用户${id.slice(-4)}` : '某人');
  // An @ to this bot becomes the line's "→ @你"; its token is left out of the text.
  const mine = me.openId ? (item.mentions ?? []).filter((m) => m.id === me.openId) : [];
  const others = item.mentions?.filter((m) => !mine.includes(m));
  const drop = mine.map((m) => m.key).filter((k): k is string => Boolean(k));
  return {
    messageId: item.message_id ?? '',
    senderName: name,
    text: extractMessageText(item.msg_type, item.body?.content, others, drop),
    from: kindOf(item.sender, me) ?? 'bot',
    senderId: senderIdOf(item.sender),
    createTime: Number(item.create_time) || 0,
    ...(mine.length ? { mentionsMe: true } : {}),
    ...(item.msg_type === 'interactive' && isStreamingCard(item.body?.content) ? { streaming: true } : {}),
    ...(item.thread_id ? { threadId: item.thread_id } : {}),
  };
}

/** Who opened a topic and when: the sender of its first reply. */
export interface TopicOpener {
  at: number;
  from: ContextMessage['from'];
  senderId?: string;
}

/**
 * The first reply in a topic, from its two oldest messages (whether or not
 * the listing includes the root), so a topic another bot opened can be told
 * apart from the message it hangs under. Undefined when there is none or the
 * lookup fails (logged as info `topic-opener-failed`); limited to
 * {@link OPENER_DEADLINE_MS}.
 */
export async function fetchTopicOpener(
  channel: LarkChannel,
  threadId: string,
  rootId: string,
  names?: NameBook,
): Promise<TopicOpener | undefined> {
  const failed = (err: string): undefined => {
    log.info('intake', 'topic-opener-failed', { topic: threadId.slice(-6), err });
    return undefined;
  };
  try {
    const res = await withDeadline(channel.rawClient.im.v1.message.list({
      params: { container_id_type: 'thread', container_id: threadId, sort_type: 'ByCreateTimeAsc', page_size: 2, with_sender_name: true },
    }), OPENER_DEADLINE_MS);
    if (!res) return failed('timeout');
    if (typeof res.code === 'number' && res.code !== 0) return failed(`code=${res.code}`);
    const item = ((res.data as { items?: RawMsgItem[] } | undefined)?.items ?? []).find((it) => it.message_id !== rootId);
    if (!item) return undefined;
    learnNames(names, item);
    const from = kindOf(item.sender, meOf(channel));
    return from ? { at: Number(item.create_time) || 0, from, senderId: senderIdOf(item.sender) } : undefined;
  } catch (err) {
    return failed(String(err));
  }
}

// ── content → plain text ───────────────────────────────────────────────────

/**
 * Extract human-readable text from a raw message body. `text`/`post` yield their
 * words (with @mentions resolved to names); everything else collapses to a short
 * placeholder (`[图片]`, `[文件：a.log]`, …) so codex knows something was there
 * without us trying to render it. Exported for testing — the body shapes are the
 * bug-prone part. Returned text is NOT yet sanitized (caller's job). The
 * mentions keyed in `drop` (this bot's) are left out.
 */
export function extractMessageText(
  msgType: string | undefined,
  content: string | undefined,
  mentions?: { key?: string; name?: string }[],
  drop: string[] = [],
): string {
  if (!content) return placeholderFor(msgType);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return placeholderFor(msgType);
  }
  switch (msgType) {
    case 'text':
      return replaceMentions(drop.reduce((t, k) => replaceKey(t, k, ''), (parsed as { text?: string } | null)?.text ?? ''), mentions);
    case 'post':
      return replaceMentions(extractPostText(parsed, drop), mentions);
    case 'image':
      return '[图片]';
    case 'audio':
      return '[语音]';
    case 'media':
      return '[视频]';
    case 'file': {
      const name = (parsed as { file_name?: string } | null)?.file_name;
      return name ? `[文件：${name}]` : '[文件]';
    }
    case 'sticker':
      return '[表情]';
    case 'interactive':
      return (isSendCard(parsed) ? extractSendCardText(parsed) : extractCardText(parsed)) || '[卡片消息]';
    case 'share_chat':
      return '[分享群名片]';
    case 'share_user':
      return '[分享个人名片]';
    case 'merge_forward':
    case 'forward':
      return '[合并转发消息]';
    default:
      return placeholderFor(msgType);
  }
}

function placeholderFor(msgType: string | undefined): string {
  return msgType ? `[${msgType} 消息]` : '[消息]';
}

/** Pull text out of a `post` (rich-text) body — both the direct
 * `{title, content:[[node]]}` shape and the locale-wrapped `{zh_cn:{...}}` one. */
function extractPostText(parsed: unknown, drop: string[]): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as Record<string, unknown>;
  let title = obj.title;
  let blocks = obj.content;
  if (!Array.isArray(blocks)) {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)) {
        title = (v as { title?: unknown }).title;
        blocks = (v as { content?: unknown }).content;
        break;
      }
    }
  }
  const parts: string[] = [];
  if (typeof title === 'string' && title.trim()) parts.push(title.trim());
  if (Array.isArray(blocks)) {
    for (const line of blocks) {
      if (!Array.isArray(line)) continue;
      // A post's at node carries the mention key as its user_id.
      const lineText = line.filter((n) => !drop.includes((n as { user_id?: string } | null)?.user_id ?? '')).map(nodeToText).join('');
      if (lineText) parts.push(lineText);
    }
  }
  return parts.join('\n');
}

function nodeToText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  switch (n.tag) {
    case 'text':
      return typeof n.text === 'string' ? n.text : '';
    case 'a':
      return typeof n.text === 'string' ? n.text : typeof n.href === 'string' ? n.href : '';
    case 'at': {
      const name = typeof n.user_name === 'string' ? n.user_name : '';
      return name ? `@${name}` : '@某人';
    }
    case 'img':
      return '[图片]';
    case 'media':
      return '[视频]';
    case 'emotion':
      return '[表情]';
    default:
      return typeof n.text === 'string' ? n.text : '';
  }
}

/**
 * The placeholder Feishu injects into a card's down-converted `message.get` body
 * when the card (schema 2.0 / CardKit) can't be rendered into the legacy post
 * shape — only the `title` survives, the body collapses to this client-upgrade
 * nag. Dropped so the woven context isn't polluted by it (it isn't card content).
 */
const CARD_UPGRADE_HINT = '请升级至最新版本客户端';

/**
 * Extract human-readable text from an `interactive` (card) message body in
 * the down-converted shape (a send-format body, which pulls ask for, goes to
 * card-content.extractSendCardText).
 *
 * Without `card_msg_content_type`, Feishu's `im.v1.message.get` NEVER returns a
 * card's source JSON — it returns a down-converted, post-like shape
 * `{title, elements:[[node,…],…]}` (verified against the live API). For legacy (schema 1.0) cards the full body text
 * survives there; for schema 2.0 / CardKit cards (incl. the bridge's own) only
 * the `title` does, the body replaced by {@link CARD_UPGRADE_HINT} (dropped).
 * Returns '' when nothing readable remains (caller falls back to [卡片消息]).
 * Exported for testing — the body shapes are the bug-prone part.
 */
export function extractCardText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const title = textValue(obj.title);
  if (title.trim()) parts.push(title.trim());
  if (Array.isArray(obj.elements)) {
    for (const line of obj.elements) {
      const nodes = Array.isArray(line) ? line : [line];
      const lineText = nodes.map(cardNodeToText).join('').trim();
      if (lineText && !lineText.includes(CARD_UPGRADE_HINT)) parts.push(lineText);
    }
  }
  return parts.join('\n').trim();
}

/** Read a node's text field across the shapes the card down-convert uses: a bare
 * string (schema-1.0 button), or a `{tag, content}` text object (plain_text /
 * lark_md). */
function textValue(t: unknown): string {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') {
    const c = (t as { content?: unknown }).content;
    if (typeof c === 'string') return c;
  }
  return '';
}

/** One node of a down-converted card line → text. Covers the tags the message.get
 * shape emits (text / a / at / note / button / img); unknown tags fall back to
 * their `text` field so future shapes degrade gracefully rather than vanish. */
function cardNodeToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  switch (n.tag) {
    case 'text':
      return textValue(n.text);
    case 'a':
      return textValue(n.text) || (typeof n.href === 'string' ? n.href : '');
    case 'at': {
      const name = typeof n.user_name === 'string' ? n.user_name : '';
      return name ? `@${name}` : '@某人';
    }
    case 'note':
      return Array.isArray(n.elements) ? n.elements.map(cardNodeToText).join('') : '';
    case 'button': {
      const label = textValue(n.text);
      return label ? `[按钮：${label}]` : '';
    }
    case 'img':
      return '';
    default:
      return textValue(n.text);
  }
}

/** Replace `@_user_N` / `@_all` placeholder tokens in a `text` body with the
 * mentioned names so codex reads "@张三" instead of an opaque key. */
function replaceMentions(text: string, mentions?: { key?: string; name?: string }[]): string {
  if (!text || !mentions?.length) return text;
  let out = text;
  for (const m of mentions) {
    if (!m.key) continue;
    out = replaceKey(out, m.key, m.name ? `@${m.name}` : '@某人');
  }
  return out;
}

/** Every `key` in `text` replaced, but not where it is the head of a longer key (`@_user_1` in `@_user_10`). */
function replaceKey(text: string, key: string, by: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped + '(?!\\d)', 'g'), () => by);
}

// ── sanitize + weave ─────────────────────────────────────────────────────

/**
 * The single sanitization boundary for pulled, uploader-controlled context text
 * (mirrors media.cleanFileName). Strips control chars, normalizes newlines, and
 * clamps length. `oneLine` collapses ALL whitespace to single spaces — both
 * weave callers use it so a crafted body can't forge fenced-block structure
 * (a `\n]\n[fake]`) to inject instructions. The multi-line branch (kept for
 * generality) only squeezes whitespace runs. Exported for testing.
 */
export function sanitizeContext(s: string, maxLen: number, oneLine: boolean): string {
  if (!s) return '';
  let out = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // drop control chars (keep \t \n \r)
    .replace(/\r\n?/g, '\n');
  out = oneLine ? out.replace(/\s+/g, ' ') : out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  out = out.trim();
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

/**
 * Prepend a fenced context block above the user's actual text (the instruction
 * codex acts on), separated by a blank line. Returns the block alone when the
 * user text is empty. Shared by every weave* below so the "block ↕ base"
 * convention lives in one place.
 */
function prependBlock(block: string, text: string): string {
  const base = text.trim();
  return base ? `${block}\n\n${base}` : block;
}

/**
 * Prepend a fenced "引用的消息" block before the user's text. Returns `text`
 * unchanged when there's no quoted message or it sanitizes to empty.
 */
export function weaveQuote(text: string, quoted: ContextMessage | undefined): string {
  if (!quoted) return text;
  const who = sanitizeContext(quoted.senderName, 40, true) || '某人';
  // oneLine=true: collapse newlines so a crafted quote body (or @mention name)
  // can't forge a `\n]\n[fake block]` to fabricate context — same defense as
  // weaveRecordBlock. sanitizeContext is the single boundary for this text.
  const body = sanitizeContext(quoted.text, QUOTE_MAX, true);
  if (!body) return text;
  const block = `[用户引用了一条消息（来自 ${who}）：\n${body}\n]`;
  return prependBlock(block, text);
}

/** Where a record block's messages come from, for its header line. */
export interface RecordPlace {
  /** The group's name (a project's name is its group's). */
  group?: string;
  /** This bot's name. */
  me?: string;
  /** Set in a topic, with its title when known; the main area otherwise. */
  topic?: { title?: string };
}

/** Someone a daemon line names: this bot, a person or another bot. */
export interface Who {
  kind: 'self' | 'user' | 'bot';
  name?: string;
}

/** Where a topic session's topic hangs in the main area (its opening's first line). */
export interface TopicPointer {
  /** This bot opened the topic on the trigger (a main @ in a multi group). */
  botOpened?: boolean;
  /** The message it hangs under; undefined when that could not be read. */
  root?: { at: number; who: Who };
  /** The main area's session in a single group, same tier. */
  mainSessionId?: string;
}

/** A topic opened in the main area, written as a 引用行 among the main-area lines. */
export interface TopicQuote {
  topicId: string;
  title?: string;
  /** When it was opened. */
  at: number;
  /** Who opened it; undefined when unknown. */
  who?: Who;
  /** The message it hangs under. */
  root?: { id: string; at?: number; who?: Who };
  /** This bot's session there, same tier only. */
  sessionId?: string;
}

/** A row of the table of recent topics shown after a compaction. */
export interface TopicRow extends TopicQuote {
  lastAt: number;
}

/** A record block (product.md 3.5): the messages a session has not seen yet. */
export interface RecordBlock {
  place: RecordPlace;
  entries: ContextMessage[];
  /** Older messages left out: how many, or `some` when the pull did not reach them all. */
  earlier?: number | 'some';
  /** The trigger's createTime: a line from another day carries its date. */
  now: number;
  /** The topic's first message, marked （话题第一条）; the earlier note goes after it. */
  rootId?: string;
  /** A topic session's opening: the pointer, and the main-area lines before the topic's first message. */
  opening?: { pointer: TopicPointer; main: ContextMessage[] };
  /** 引用行, among `opening.main` when there is an opening, else among `entries`. */
  quotes?: TopicQuote[];
  /** Topics left out of `quotes`. */
  moreTopics?: number;
  /** The recent topics, as the block's last lines. */
  table?: TopicRow[];
  /** Not woven, only for the 引用行 to say whose message a topic hangs under (`ThreadPull.ownRoots`). */
  refs?: ContextMessage[];
}

/**
 * Prepend the record block (one line per message, time-ascending, each with its
 * time and real name) before the user's text:
 *
 *   [飞书 · 群「支付组」· 主区 · 你是「小码」]
 *   （更早还有 3 条没带进来，需要时用 vonvon 飞书 skill 查）
 *   09:58 张三：下午三点发版
 *   10:01 张三 → @你：订单接口一直报 500
 *   10:03 小P（bot）：网关日志里 500 都来自 OrderService
 *   [/飞书]
 *
 * A topic session's opening starts with a pointer to the message the topic
 * hangs under, then `主区在这之前：` with the main-area lines before it and
 * `话题里：`. Topics opened in the main area show as 引用行 among the
 * main-area lines (`10:01 〔话题〕李四在上面这条下开了话题「…」…`); after a
 * compaction the recent topics come last (s14b).
 *
 * Every line from a message starts with its time and sender, and every
 * user-controlled part is collapsed to one line, so a crafted body or name can
 * neither close the block nor pass for a line the daemon writes; names and
 * titles also lose the brackets and arrow those lines use. Returns `text`
 * unchanged when there is nothing to show.
 */
export function weaveRecordBlock(text: string, block: RecordBlock): string {
  const { opening, now } = block;
  const quotes = block.quotes ?? [];
  const all = [...block.entries, ...(opening?.main ?? []), ...(block.refs ?? [])];
  const more = block.moreTopics && quotes.length ? [`（还有 ${block.moreTopics} 个话题没列，需要时用 vonvon 飞书 skill 列）`] : [];
  const own = sectionLines(block.entries, opening ? [] : quotes, all, now, block.rootId, earlierNote(block.earlier));
  const lines = opening ? own : [...more, ...own];
  if (opening) {
    const main = sectionLines(opening.main, quotes, all, now);
    const head = main.length ? ['主区在这之前：', ...more, ...main, ...(own.length ? ['话题里：'] : [])] : [];
    lines.unshift(pointerLine(opening.pointer, now), ...head);
  }
  lines.push(...tableLines(block.table ?? [], now));
  if (lines.length === 0) return text;
  return prependBlock([recordHeader(block.place), ...lines, '[/飞书]'].join('\n'), text);
}

/**
 * One section's lines, time-ascending: its messages, and the 引用行 among
 * them (after a message of the same time). The root gets （话题第一条）, and
 * the earlier note goes right after it, else first; none without a line.
 */
function sectionLines(msgs: ContextMessage[], quotes: TopicQuote[], all: ContextMessage[], now: number, rootId?: string, earlier?: string): string[] {
  const out: string[] = [];
  const qs = [...quotes].sort((a, b) => a.at - b.at);
  let prev: ContextMessage | undefined; // the message on the line above, if that line is one
  let rootAt = 0;
  const quote = (q: TopicQuote) => {
    out.push(quoteLine(q, prev, all, now));
    prev = undefined;
  };
  for (const m of [...msgs].sort((a, b) => a.createTime - b.createTime)) {
    while (qs.length && qs[0]!.at < m.createTime) quote(qs.shift()!);
    const line = recordLine(m, now);
    if (!line) continue;
    if (m.messageId === rootId) {
      out.push(`${line}（话题第一条）`);
      rootAt = out.length;
    } else {
      out.push(line);
    }
    prev = m;
  }
  qs.forEach(quote);
  if (earlier && out.length) out.splice(rootAt, 0, earlier);
  return out;
}

/** The opening's pointer: where the topic hangs, and the main session's id. */
function pointerLine(p: TopicPointer, now: number): string {
  const rest = '主区的其他内容不在这里，需要时用 vonvon 飞书 skill 查。';
  const at = p.root ? ` ${clockOf(p.root.at, now)} ` : '';
  if (p.botOpened) {
    const under = p.root ? `${at}${whoText(p.root.who)}的这条` : '的一条';
    return `这个话题是你在群主区${under}消息下开的，就是下面这条。${rest}`;
  }
  let where = '的一条消息';
  if (p.root?.who.kind === 'self') where = `${at}你的回复`;
  else if (p.root) where = `${at}${whoText(p.root.who)}的消息`;
  const sid = p.mainSessionId ? `（主区会话 id：${label(p.mainSessionId, 80)}）` : '';
  return `这个话题开在群主区${where}下${sid}。${rest}`;
}

/** A 引用行: `HH:MM 〔话题〕{谁}{在哪条下}开了话题「…」，{会话}，这里不用接。（ids）`. */
function quoteLine(q: TopicQuote, prev: ContextMessage | undefined, all: ContextMessage[], now: number): string {
  const title = label(q.title ?? '', 30);
  const what = title ? `开了话题「${title}」` : '开了一个话题';
  const there = q.who?.kind === 'self' ? '在那边' : '你在那边'; // the line already starts with 你
  const session = q.sessionId ? '另有一条会话' : '还没有会话';
  return `${clockOf(q.at, now)} 〔话题〕${whoText(q.who)}${whereText(q.root, prev, all, now)}${what}，${there}${session}，这里不用接。（${topicIds(q)}）`;
}

/** The message a topic hangs under: the line above, or its time and sender (from the block when it is there). */
function whereText(root: TopicQuote['root'], prev: ContextMessage | undefined, all: ContextMessage[], now: number): string {
  if (!root) return '';
  if (prev?.messageId === root.id) return '在上面这条下';
  const m = all.find((x) => x.messageId === root.id);
  const who = m ? { kind: m.from, name: m.senderName } : root.who;
  if (!who) return '';
  const t = m?.createTime ?? root.at;
  const at = t ? ` ${clockOf(t, now)} ` : '';
  if (who.kind === 'self') return `在你${at}的回复下`;
  return `在${at}${whoText(who)}的消息下`;
}

/** The table of recent topics (product.md 3.5), or none without rows. */
function tableLines(rows: TopicRow[], now: number): string[] {
  if (!rows.length) return [];
  const head = `〔本群最近 ${rows.length} 个活跃话题〕这条会话压缩过，前面的话题引用可能已经被摘要掉。更多话题用 vonvon 飞书 skill 列。`;
  return [head, ...rows.map((r) => {
    const title = label(r.title ?? '', 30);
    const what = title ? `「${title}」` : '一个话题，';
    const who = whoText(r.who);
    const by = who.endsWith('）') ? who : `${who} `; // 名字（bot） needs no space before the time
    const has = r.sessionId ? '你在那边有会话' : '你在那边还没有会话';
    return `· ${what}${by}${clockOf(r.at, now)} 开的，最近 ${clockOf(r.lastAt, now)} 有消息，${has}（${topicIds(r)}）`;
  })];
}

function topicIds(q: TopicQuote): string {
  return `话题 id：${label(q.topicId, 80)}${q.sessionId ? `，会话 id：${label(q.sessionId, 80)}` : ''}`;
}

/** A daemon line's name for someone: 你, a person's name, `名字（bot）`, or a stand-in. */
function whoText(who: Who | undefined): string {
  if (!who) return '有人';
  if (who.kind === 'self') return '你';
  const name = personName(who.name ?? '');
  if (who.kind === 'bot') return name ? `${name}（bot）` : '另一个 bot';
  return name || '某人';
}

/** Without parentheses, a person's name cannot pass for "名字（bot）". */
function personName(s: string): string {
  return label(s.replace(/[（）()]/g, ''), 40);
}

function recordHeader(p: RecordPlace): string {
  const group = label(p.group ?? '', 40);
  const title = label(p.topic?.title ?? '', 30);
  const me = label(p.me ?? '', 40);
  let area = '主区';
  if (p.topic) area = title ? `话题「${title}」` : '话题';
  const parts = [group ? `群「${group}」` : '群', area, ...(me ? [`你是「${me}」`] : [])];
  let header = '飞书';
  // As in product.md 3.5: no space between a closing 」 and the dot.
  for (const part of parts) header += `${header.endsWith('」') ? '· ' : ' · '}${part}`;
  return `[${header}]`;
}

/** The note on older messages left out, or undefined when there are none. */
function earlierNote(earlier: RecordBlock['earlier']): string | undefined {
  if (earlier === 'some') return '（更早的消息没带进来，需要时用 vonvon 飞书 skill 查）';
  if (earlier) return `（更早还有 ${earlier} 条没带进来，需要时用 vonvon 飞书 skill 查）`;
  return undefined;
}

/** One message as a line, or '' when its text sanitizes to nothing. */
function recordLine(m: ContextMessage, now: number): string {
  const body = sanitizeContext(m.text, m.from === 'user' ? LINE_MAX : BOT_LINE_MAX, true);
  if (!body) return '';
  const at = clockOf(m.createTime, now);
  if (m.from === 'self') return `${at} 你：${body}`;
  const who = personName(m.senderName) || '某人';
  if (m.from === 'bot') return `${at} ${who}（bot${m.streaming ? '，还没答完' : ''}）：${body}`;
  return `${at} ${who}${m.mentionsMe ? ' → @你' : ''}：${body}`;
}

/** A name or title for a record block: one line, without the marks daemon-written parts use. */
function label(s: string, max: number): string {
  return sanitizeContext(s.replace(/[〔〕「」→]/g, ''), max, true);
}

/** `HH:MM` in the daemon's time zone, `MM-DD HH:MM` when not the trigger's day. */
function clockOf(t: number, now: number): string {
  if (!t) return '--:--';
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, '0');
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

/** Max chars for the woven sender display name (matches the per-line history clamp). */
const SENDER_NAME_MAX = 40;
/** A message received this long after it was sent says so in its sender block:
 * Feishu re-pushes messages sent while the bot was offline about 5 minutes late (e10). */
const LATE_NOTE_MS = 2 * 60_000;

/**
 * Prepend a fenced "发信人" block so codex knows WHO sent THIS turn. Feishu's
 * message event carries the sender's open_id + display name, but the bridge
 * otherwise hands codex only the message text — leaving it identity-blind.
 * Folding identity in lets codex (a) match the sender against a roster (e.g. an
 * approve-gate: is this 开发/老板?), and (b) @ them back via `<at id=ou_xxx></at>`.
 * Returns `text` unchanged when there's no usable open_id (nothing to assert).
 * sanitizeContext is the single boundary for the display name — it is
 * uploader-influenced, so oneLine=true collapses it so a crafted name can't
 * forge a fenced block (mirrors weaveQuote / weaveRecordBlock).
 */
export function weaveSender(
  text: string,
  sender: { senderId?: string; senderName?: string },
  lateMs = 0,
): string {
  const id = (sender.senderId ?? '').trim();
  if (!id) return text;
  const who = sanitizeContext(sender.senderName ?? '', SENDER_NAME_MAX, true) || '某用户';
  // Inside the block (still ending in "）]") so session-title strips it with the block.
  const late = lateMs > LATE_NOTE_MS ? `（这条消息 ${Math.round(lateMs / 60_000)} 分钟前发出，bot 断线重连后才收到）` : '';
  const block = `[本条消息的发信人：${who}（open_id：${id}）${late}]`;
  return prependBlock(block, text);
}
