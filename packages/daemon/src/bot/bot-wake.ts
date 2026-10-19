import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { RosterBot } from './bot-roster';
import { sanitizeContext, type ContextMessage } from './context-weave';

/**
 * s27a-0. Bots waking bots (product.md 3.4"bot 之间"): since the last person's message, at most this many wakes in
 * one place, counted from what Feishu's message list shows, so every bot in the chat counts the same (owner
 * 2026-10-18). The 7th wake is not answered; the 6th is, with a note that it is the last.
 */
export const BOT_WAKE_CAP = 6;
/** The most of another bot's message that goes into the turn's input, in UTF-16 units; a longer one is cut there
 * (one less when that would split an emoji) and gets 「…」 and a note, about 30 more. */
export const BOT_TRIGGER_MAX = 800;
/** A wake count's history pull, all pages together; the member list keeps its own 3 seconds, in parallel. */
export const WAKE_PULL_MS = 5000;

const TRUNCATED = '（已截断，需要时用 vonvon 飞书 skill 查全文）';
const NO_TEXT = '（对方没有给出文字回答）';

/** A chat's bots from its member list ({@link ../bot-roster}), looked up both ways. */
export interface WakeTables {
  /** open_id (this app's namespace) → app_id and name. */
  byOpenId: ReadonlyMap<string, RosterBot>;
  /** app_id, the same for every reader → open_id and name. */
  byAppId: ReadonlyMap<string, { openId: string; name: string }>;
}

export function wakeTables(bots: ReadonlyMap<string, RosterBot>): WakeTables {
  const byAppId = new Map<string, { openId: string; name: string }>();
  for (const [openId, b] of bots) if (b.appId) byAppId.set(b.appId, { openId, name: b.name });
  return { byOpenId: bots, byAppId };
}

export interface WakeCount {
  /** `failed`: no person's message was found and the list was not read to its start, with fewer than 7 wakes seen;
   * or the trigger has no time, so nothing bounds the count. */
  kind: 'ok' | 'failed';
  /** Wakes since the last person's message, the trigger included. */
  n: number;
  /** The trigger is in the list. */
  listed: boolean;
  /** The trigger as listed. */
  trigger?: ContextMessage;
  /** What the wakes came from, for the log: an @ to a bot in the list, or a reply from another app. */
  counted: { mentioned: number; replied: number };
}

/**
 * Count the wakes before and at `trigger` (another bot's message that @-ed this one). `messages` is a pull with
 * `mentions: true` and `before: trigger.createTime`, oldest first; this bot's own messages are in it. Pure: no clock,
 * so the count is the same whenever it is read, however late the event came.
 * Since the last message from a person, each bot message counts once when
 *   (a) it @-mentions a bot of the chat's list other than its sender (text and post alike: their @ shows in the
 *       list, a card's does not; s27a step 0, 2026-10-19), or
 *   (b) another app replied to it: the brake for a card's @, which the list does not show. A message posted
 *       straight into a topic has parent_id = root_id, the topic's first message, and quotes nothing.
 * The trigger always counts: its event proved the @.
 */
export function countBotWakes(
  messages: readonly ContextMessage[],
  trigger: { messageId: string; createTime: number },
  me: { openId?: string; appId?: string },
  tables: WakeTables,
  complete: boolean,
): WakeCount {
  const botIds = new Set(tables.byOpenId.keys());
  if (me.openId) botIds.add(me.openId);
  const appOf = (m: ContextMessage): string | undefined => m.senderAppId ?? (m.from === 'self' ? me.appId || undefined : undefined);
  const openIdOf = (m: ContextMessage): string | undefined =>
    m.senderId ?? (m.from === 'self' ? me.openId : undefined) ?? (m.senderAppId ? tables.byAppId.get(m.senderAppId)?.openId : undefined);
  // Unknown on either side is the same app: a reply only counts when it is known to come from another one.
  const sameApp = (a: ContextMessage, b: ContextMessage): boolean => {
    const [x, y] = [appOf(a), appOf(b)];
    if (x && y) return x === y;
    const [p, q] = [openIdOf(a), openIdOf(b)];
    return p && q ? p === q : true;
  };

  // The pull's `before` already holds to this: nothing sent after the trigger is part of its count (H3). A trigger
  // with no time (0, missing) bounds nothing, so a person's later message could end the count early: failed (E4).
  const timed = trigger.createTime > 0;
  const upTo = timed ? messages.filter((m) => m.createTime <= trigger.createTime) : messages;
  let start = 0;
  for (let i = upTo.length - 1; i >= 0; i--) {
    if (upTo[i]!.from === 'user') {
      start = i + 1;
      break;
    }
  }
  const bounded = start > 0;
  const segment = upTo.slice(start);
  const bots = segment.filter((m) => m.from !== 'user');
  const seen = new Set<string>();
  const counted = { mentioned: 0, replied: 0 };
  let n = 0;
  const count = (m: ContextMessage, kind: keyof typeof counted): void => {
    if (seen.has(m.messageId)) return;
    seen.add(m.messageId);
    n++;
    counted[kind]++;
  };
  for (const p of bots) {
    const sender = openIdOf(p);
    if (p.mentionIds?.some((id) => botIds.has(id) && id !== sender)) count(p, 'mentioned');
    const replied = bots.some((r) => r.parentId === p.messageId && !sameApp(r, p)
      && !(r.threadId && r.parentId === r.rootId && p.threadId === r.threadId));
    if (replied) count(p, 'replied');
  }
  const listedTrigger = segment.find((m) => m.messageId === trigger.messageId);
  const listed = upTo.some((m) => m.messageId === trigger.messageId);
  // Not listed yet (the event beat the list), or listed with no @ to see (another bot's card): its event proved it.
  if (!listedTrigger || !seen.has(listedTrigger.messageId)) n++;
  const kind = timed && (bounded || complete || n > BOT_WAKE_CAP) ? 'ok' : 'failed';
  return { kind, n, listed, ...(listedTrigger ? { trigger: listedTrigger } : {}), counted };
}

/**
 * The text of the trigger that goes into the turn, always a string: a text or post message's own content (the
 * SDK has turned it into text and left out the @ to this bot), a card's from the counting pull or else `fetched`
 * (a lookup by id). Sanitized as quoted context is, multi-line, cut at {@link BOT_TRIGGER_MAX} with a note.
 */
export function wakeTriggerText(
  msg: Pick<NormalizedMessage, 'content' | 'rawContentType'>,
  trigger: Pick<ContextMessage, 'text'> | undefined,
  fetched?: string,
): string {
  const raw = msg.rawContentType === 'interactive'
    ? (trigger?.text.trim() ? trigger.text : fetched ?? '')
    : msg.content;
  const full = sanitizeContext(raw, Infinity, false);
  if (!full) return NO_TEXT;
  const cut = sanitizeContext(raw, BOT_TRIGGER_MAX, false, true);
  return cut === full ? full : `${cut}${TRUNCATED}`;
}
