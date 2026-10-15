import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { labelScope } from '../config/scopes';
import { scopeDenial, type FeishuErrorBody } from '../utils/feishu-error';
import type { NameBook } from './names';

/**
 * Inbound CONTEXT weaving — give codex the上下文 a Feishu @ alone doesn't carry.
 *
 * Feishu's message event only delivers the triggering message itself. Two common
 * blind spots follow:
 *   1. 引用消息 (quote reply): the user 引用 another message + @bot. The quoted
 *      message id rides in `NormalizedMessage.replyToMessageId` (= the raw
 *      event's `parent_id`), but its CONTENT is never pushed — it must be pulled
 *      with `im.v1.message.get`.
 *   2. 话题上文 (topic history): people chat in a topic, then @bot mid-thread with
 *      little/no description. Those人对人 messages were never @ the bot, so the
 *      bridge dropped them at the @门 — codex has never seen them. They must be
 *      pulled with `im.v1.message.list` (container_id_type='thread').
 *
 * codex has no native "quoted message" / "chat history" input, so — exactly like
 * inbound files (see {@link import('./media').weaveFileManifest}) — we fold the
 * pulled text into the prompt as clearly-fenced blocks PREPENDED to the user's
 * actual line (which stays the instruction codex acts on).
 *
 * The bot reads these with its OWN tenant identity — no second identity /
 * lark-cli needed. Reading history needs `im:message:readonly` (required since
 * v1, see config/scopes.ts); an app that hasn't been granted it gets Feishu's
 * 99991672 rejection, which the thread pull logs as a structured
 * `thread-context-failed` warning naming the scope (see {@link scopeDenial}).
 * Every fetch is best-effort: a deleted message, a missing scope, or a timeout
 * is logged and skipped, never thrown — a missing block must not break the turn.
 *
 * {@link sanitizeContext} is the SINGLE sanitization boundary for this
 * uploader-controlled text (mirrors media.cleanFileName): it strips control
 * chars and clamps length right before the text is woven into the prompt.
 */

/** Max chars woven for one quoted message (collapsed to a single line). */
const QUOTE_MAX = 800;
/** Max chars per thread-history line (collapsed to a single line each). */
const LINE_MAX = 280;
/** Max thread messages woven (most-recent kept, see {@link keepRecent}). */
export const THREAD_WEAVE_MAX = 20;
/** Feishu's page_size ceiling for one newest-first page of a topic. */
const THREAD_PAGE_SIZE = 50;
/** Pages pulled at most per turn (500 messages); the rest is logged as cut. */
const THREAD_PAGE_CAP = 10;

/** The scope this app requests for reading chat history with its own identity (config/scopes.ts). */
const HISTORY_SCOPE = 'im:message:readonly';

/** A message pulled for context (the quoted message, or one thread-history entry). */
export interface ContextMessage {
  messageId: string;
  /** Best-effort display name (sender_name, else the name book's, else `用户<id尾4>`, else 某人). */
  senderName: string;
  /** Plain text extracted from the message body (NOT yet sanitized). */
  text: string;
  /** sender_type === 'user' — false for the bot itself, other apps, system. */
  fromUser: boolean;
  /** A person's open_id, or a bot's open_bot_id (undefined when the item has neither). */
  senderId?: string;
  /** create_time as epoch ms (0 when unknown). */
  createTime: number;
}

/** Subset of the `im.v1.message.get` / `.list` item shape we read. */
interface RawMsgItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
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
    const res = await channel.rawClient.im.v1.message.get({
      path: { message_id: messageId },
      params: { with_sender_name: true },
    });
    const items = (res.data as { items?: RawMsgItem[] } | undefined)?.items ?? [];
    const item = items[0];
    if (!item || item.deleted) return undefined;
    learnNames(names, item);
    const cm = toContextMessage(item, names);
    return cm.text.trim() ? cm : undefined;
  } catch (err) {
    log.warn('intake', 'quote-fetch-failed', { messageId, err: String(err) });
    return undefined;
  }
}

/** One topic pull: the human messages found, oldest→newest. */
export interface ThreadPull {
  messages: ContextMessage[];
  /** false when a page failed (messages is then empty): the watermark must not move. */
  ok: boolean;
  /** true when paging reached `stopAt` or the topic's start; false when it stopped at the page cap or after `enough`. */
  complete: boolean;
}

/**
 * Page through a topic newest-first (`with_sender_name`, so people and bots
 * come with real names) and collect the human messages:
 *   - `stopAt`: the session's watermark. Paging stops at the first page that
 *     reaches it; 0 means none (a fresh session's opening).
 *   - `enough`: also stop once this many are found (for an opening, where
 *     only the most recent ones are woven).
 *   - `before`: only messages older than this (the trigger's createTime), so a
 *     message that arrives as its own turn later is not woven twice.
 * Bot/app/system, deleted, empty and `excludeMessageId` messages are dropped,
 * except `keepId` (the topic's first message, kept even when a bot sent it).
 * Filtering by what the session has already seen is the caller's job
 * (session-store.isSeen). Never throws: a failure logs and returns `ok: false`.
 */
export async function fetchThreadContext(
  channel: LarkChannel,
  threadId: string,
  opts: { stopAt?: number; enough?: number; before?: number; excludeMessageId?: string; keepId?: string; names?: NameBook } = {},
): Promise<ThreadPull> {
  const stopAt = opts.stopAt ?? 0;
  const found: ContextMessage[] = [];
  function done(complete: boolean): ThreadPull {
    return { messages: found.sort((a, b) => a.createTime - b.createTime), ok: true, complete };
  }
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < THREAD_PAGE_CAP; page++) {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: threadId,
          sort_type: 'ByCreateTimeDesc',
          page_size: THREAD_PAGE_SIZE,
          with_sender_name: true,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      // The SDK only throws on HTTP errors; a 200 with a non-zero code is a failure too.
      if (typeof res.code === 'number' && res.code !== 0) {
        warnThreadContextFailed(threadId, res);
        return failedPull();
      }
      const data = res.data as { items?: RawMsgItem[]; has_more?: boolean; page_token?: string } | undefined;
      const items = data?.items ?? [];
      let oldest = Infinity;
      for (const it of items) {
        learnNames(opts.names, it);
        const m = toContextMessage(it, opts.names);
        if (m.createTime > 0) oldest = Math.min(oldest, m.createTime);
        if (
          !it.deleted &&
          (m.fromUser || m.messageId === opts.keepId) && // drop the bot's own replies, other apps, system notices
          m.messageId !== opts.excludeMessageId && // drop the triggering @ message
          (!opts.before || m.createTime < opts.before) &&
          m.text.trim().length > 0
        ) {
          found.push(m);
        }
      }
      if (!data?.has_more || !data.page_token || items.length === 0) return done(true);
      if (stopAt > 0 && oldest <= stopAt) return done(true);
      if (opts.enough && found.length >= opts.enough) return done(false);
      pageToken = data.page_token;
    }
    log.info('intake', 'thread-context-page-cap', { threadId, pages: THREAD_PAGE_CAP, found: found.length });
    return done(false);
  } catch (err) {
    warnThreadContextFailed(threadId, err);
    return failedPull();
  }
}

function failedPull(): ThreadPull {
  return { messages: [], ok: false, complete: false };
}

/** The most recent `limit` messages to weave (oldest→newest in, same order
 * out), always keeping `pinId` (a topic's first message) when present. */
export function keepRecent(msgs: ContextMessage[], pinId?: string, limit = THREAD_WEAVE_MAX): ContextMessage[] {
  if (msgs.length <= limit) return msgs;
  const pinned = pinId ? msgs.find((m) => m.messageId === pinId) : undefined;
  const rest = msgs.filter((m) => m !== pinned);
  const out = pinned ? [pinned, ...rest.slice(-(limit - 1))] : rest.slice(-limit);
  log.info('intake', 'thread-context-truncated', { kept: out.length, total: msgs.length });
  return out;
}

/**
 * Log a failed 话题上文 pull. A missing scope gets a structured warning naming the
 * scope to grant (so the gap is visible in the log rather than a bare error
 * string); anything else keeps the plain error. The turn still proceeds without
 * the history block either way.
 */
function warnThreadContextFailed(threadId: string, failure: unknown): void {
  const denial = scopeDenial(failure);
  if (denial) {
    // We request HISTORY_SCOPE; name another only when Feishu says ours wouldn't satisfy the call.
    const scope = denial.accepted.includes(HISTORY_SCOPE) ? HISTORY_SCOPE : (denial.accepted[0] ?? HISTORY_SCOPE);
    log.warn('intake', 'thread-context-failed', {
      threadId,
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
  log.warn('intake', 'thread-context-failed', { threadId, err });
}

function toContextMessage(item: RawMsgItem, names?: NameBook): ContextMessage {
  const id = item.sender?.id ?? '';
  const name = item.sender?.sender_name || names?.peek(id) || (id ? `用户${id.slice(-4)}` : '某人');
  return {
    messageId: item.message_id ?? '',
    senderName: name,
    text: extractMessageText(item.msg_type, item.body?.content, item.mentions),
    fromUser: item.sender?.sender_type === 'user',
    senderId: senderIdOf(item.sender),
    createTime: Number(item.create_time) || 0,
  };
}

// ── content → plain text ───────────────────────────────────────────────────

/**
 * Extract human-readable text from a raw message body. `text`/`post` yield their
 * words (with @mentions resolved to names); everything else collapses to a short
 * placeholder (`[图片]`, `[文件：a.log]`, …) so codex knows something was there
 * without us trying to render it. Exported for testing — the body shapes are the
 * bug-prone part. Returned text is NOT yet sanitized (caller's job).
 */
export function extractMessageText(
  msgType: string | undefined,
  content: string | undefined,
  mentions?: { key?: string; name?: string }[],
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
      return replaceMentions((parsed as { text?: string } | null)?.text ?? '', mentions);
    case 'post':
      return replaceMentions(extractPostText(parsed), mentions);
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
      return extractCardText(parsed) || '[卡片消息]';
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
function extractPostText(parsed: unknown): string {
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
      const lineText = line.map(nodeToText).join('');
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
 * Extract human-readable text from an `interactive` (card) message body.
 *
 * Feishu's `im.v1.message.get` NEVER returns a card's source JSON — it returns a
 * down-converted, post-like shape `{title, elements:[[node,…],…]}` (verified
 * against the live API). For legacy (schema 1.0) cards the full body text
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
    out = out.split(m.key).join(m.name ? `@${m.name}` : '@某人');
  }
  return out;
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
  // weaveThreadHistory. sanitizeContext is the single boundary for this text.
  const body = sanitizeContext(quoted.text, QUOTE_MAX, true);
  if (!body) return text;
  const block = `[用户引用了一条消息（来自 ${who}）：\n${body}\n]`;
  return prependBlock(block, text);
}

/**
 * Prepend a fenced "话题上文" block (one line per message, time-ascending) before
 * the user's text. Returns `text` unchanged when there are no messages.
 */
export function weaveThreadHistory(text: string, msgs: ContextMessage[]): string {
  if (msgs.length === 0) return text;
  const lines = msgs
    .map((m) => {
      const who = sanitizeContext(m.senderName, 40, true) || '某人';
      const body = sanitizeContext(m.text, LINE_MAX, true);
      return body ? `${who}：${body}` : '';
    })
    .filter((l) => l.length > 0);
  if (lines.length === 0) return text;
  const block = `[话题中在此之前已有的消息（按时间先后排列，供你理解上下文）：\n${lines.join('\n')}\n]`;
  return prependBlock(block, text);
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
 * forge a fenced block (mirrors weaveQuote / weaveThreadHistory).
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
