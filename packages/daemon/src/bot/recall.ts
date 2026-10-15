import { isSeen, type SessionRecord } from './session-store';

/**
 * Which sessions a recalled message reached (product.md 3.5 "撤回和编辑", s15),
 * from what the daemon already records: the delivered marks and the watermark
 * (s09), the topic registry's first-message time (s13) and the session's `from`.
 * No message text is stored. Every doubt leans toward noting: a note about a
 * line the model never saw is harmless.
 */

/** What a lookup of the recalled message gives (context-weave.fetchMessageMeta). */
export interface MessageMeta {
  /** Its send time (epoch ms). */
  at: number;
  threadId?: string;
  rootId?: string;
  from: 'user' | 'bot' | 'self';
  senderId?: string;
}

/** A reply in a topic. A topic's first message carries the topic's id and no root (s14a). */
export function isTopicReply(x: MessageMeta, id: string): boolean {
  return Boolean(x.threadId && x.rootId && x.rootId !== id);
}

/**
 * When the recalled message `id` reached `rec` (its send time), or undefined
 * when it did not. `x` is the lookup, undefined when it failed; `rootAt` is the
 * first message's time of the topic `rec` is for, from the registry.
 */
export function reachedAt(
  rec: Pick<SessionRecord, 'threadId' | 'lastSeenAt' | 'seen' | 'from'>,
  chatId: string,
  id: string,
  x: MessageMeta | undefined,
  rootAt: number | undefined,
): number | undefined {
  const mark = rec.seen?.find((s) => s.id === id);
  if (mark) return mark.at; // a trigger, an interjection or a queued turn
  if (!x) return undefined;
  const place = rec.threadId.replace(/#(admin|guest)$/, '');
  const reply = isTopicReply(x, id);
  if (place === chatId) {
    // Main sessions never get topic replies.
    return !reply && isSeen(rec, id, x.at) && x.at >= (rec.from ?? 0) ? x.at : undefined;
  }
  if (x.threadId === place) return isSeen(rec, id, x.at) ? x.at : undefined;
  if (reply) return undefined; // another topic
  // A main-area line: the topic's opening carried the main lines up to its first message (s14b).
  return rec.from !== undefined && rootAt !== undefined && rec.from <= x.at && x.at <= rootAt ? x.at : undefined;
}
