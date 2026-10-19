import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

/**
 * 三条底线 (product.md 3.4, s22): before a mode decides, who a group message
 * is for. Shared by both modes; the smart mode (s25) reads it as 免@ on.
 *   1. 点名: whom it @-mentions or quotes is the only one to answer. An @ of
 *      someone else, @所有人, or a quote of someone else's message leaves the
 *      other bots out; @-ing two bots names both. In rule mode's 仅@ a quote
 *      of this bot's message does not name it, as in the bridge.
 *   2. 接着聊: an unnamed message in a topic is for the bot that spoke there last.
 *   3. bot 消息: another bot's message counts only when it @-mentions this bot.
 * The lookups run only where the answer can change what this bot does: 免@
 * on, and another bot in the group (or the count unknown). A message that only
 * @-mentions someone else needs none: it is not answered in either case.
 */
export type Audience =
  | { to: 'me'; by: 'mention' | 'quote'; fromBot?: true }
  | { to: 'other'; by: 'bot-sender' | 'mention-all' | 'mention' | 'quote' | 'topic' }
  /** Named nobody: the mode decides (免@). */
  | { to: 'nobody' }
  /** A lookup it needed failed: not answered, as it may be someone else's. */
  | { to: 'unknown'; why: 'quote' | 'topic' };

export interface AudienceLookups {
  /** This bot is known to be the group's only bot: no lookup can change the answer. */
  lonely(): Promise<boolean>;
  /** Who sent the quoted message; undefined when the lookup failed. */
  quoted(messageId: string): Promise<{ from: 'self' | 'bot' | 'user'; senderId?: string } | undefined>;
  /** The bot that spoke last in the topic; undefined when the lookup failed. */
  lastBot(threadId: string): Promise<'self' | 'bot' | 'none' | undefined>;
}

/** Whether a message came from a bot (an app), from the raw receive event. */
export function fromBot(msg: Pick<NormalizedMessage, 'raw'>): boolean {
  const type = (msg.raw as { sender?: { sender_type?: string } } | undefined)?.sender?.sender_type;
  return type === 'app' || type === 'bot';
}

/** The message it quotes: a main-area reply, or in a topic a reply to one of its
 * messages. A message posted straight into a topic has parent_id = root_id (the
 * topic's first message), so it quotes nothing (e10 item 4). */
export function quotedId(msg: NormalizedMessage): string | undefined {
  const parent = msg.replyToMessageId;
  if (!parent) return undefined;
  if (msg.threadId && parent === msg.rootId) return undefined;
  return parent;
}

/**
 * Who `msg` is for. `noMention` is 免@: a quote of this bot's message names it
 * and an unnamed topic message goes to its last bot. In 仅@ only an @ names this
 * bot and nothing is looked up. `smart` (s25): as the group's only bot, a quote
 * is still looked up, since a quote of this bot then gets the named variant.
 */
export async function audienceOf(msg: NormalizedMessage, opts: { noMention: boolean; smart?: boolean }, lookups: AudienceLookups): Promise<Audience> {
  if (fromBot(msg)) return msg.mentionedBot ? { to: 'me', by: 'mention', fromBot: true } : { to: 'other', by: 'bot-sender' };
  if (msg.mentionedBot) return { to: 'me', by: 'mention' };
  if (msg.mentionAll) return { to: 'other', by: 'mention-all' };
  const mentionsOther = msg.mentions.some((m) => !m.isBot); // SDK: isBot = this bot
  const withoutLookup: Audience = mentionsOther ? { to: 'other', by: 'mention' } : { to: 'nobody' };
  const quote = opts.noMention ? quotedId(msg) : undefined;
  if (!quote && (mentionsOther || !opts.noMention || !msg.threadId)) return withoutLookup;
  if (await lookups.lonely()) {
    if (opts.smart && quote && (await lookups.quoted(quote))?.from === 'self') return { to: 'me', by: 'quote' };
    return withoutLookup;
  }
  if (quote) {
    const q = await lookups.quoted(quote);
    if (!q) return { to: 'unknown', why: 'quote' };
    // Quoting this bot names it even beside an @ of another bot (both named).
    if (q.from === 'self') return { to: 'me', by: 'quote' };
    if (mentionsOther) return { to: 'other', by: 'mention' };
    // Quoting one's own message names no one else.
    if (q.from === 'bot' || !q.senderId || q.senderId !== msg.senderId) return { to: 'other', by: 'quote' };
    if (!msg.threadId) return { to: 'nobody' };
  }
  const last = await lookups.lastBot(msg.threadId!);
  if (last === undefined) return { to: 'unknown', why: 'topic' };
  return last === 'bot' ? { to: 'other', by: 'topic' } : { to: 'nobody' };
}
