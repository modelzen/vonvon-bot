import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { JudgeLine } from '../judge/types';
import { fromBot, quotedId } from './baselines';
import { extractMessageText, type ContextMessage, type ThreadPull } from './context-weave';

/**
 * The recent messages a smart group's judgements read (product.md 3.5: in memory only, a few dozen per
 * group, gone on restart). One ring per place, a group's main area (its chat id) or a topic (its thread
 * id). Fed with every message of a smart group the bot receives, its own final answers and what it
 * decided to do, and once per place from Feishu's history; a recall takes its line out.
 */

/** A line and its message id, with what a topic opened under it needs (s25b). */
export interface RecentLine extends JudgeLine {
  id: string;
  /** A person's open_id, another bot's open_bot_id. */
  senderId?: string;
}

/** Lines kept per place, newest kept. */
export const RECENT_PER_PLACE = 40;
/** Places kept; the one used longest ago goes first. */
export const RECENT_PLACES = 200;
/** Lines a judgement gets before its message (renderJudgeInput cuts them again by length). */
export const RECENT_CONTEXT = 20;
/** A place holding fewer lines than this pulls its history before its first judgement. */
const COLD_LINES = 5;
/** Characters kept per line: the judgement reads at most 400 of a context line (JUDGE_INPUT_LIMITS). */
const LINE_CHARS = 400;

function cut(text: string, max = LINE_CHARS): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** A received message as a line: text as a record block writes it ([图片], [文件：名字]), the names it
 * @-mentions, and the line it quotes when that one is in the ring already (never looked up). `max` is
 * larger for the message judged (JUDGE_INPUT_LIMITS.messageChars). */
export function lineOfMessage(msg: NormalizedMessage, name: string, quoted?: RecentLine, max = LINE_CHARS): RecentLine {
  const event = (msg.raw as { message?: { message_type?: string; content?: string } } | undefined)?.message;
  const others = msg.mentions.filter((m) => !m.isBot);
  const mine = msg.mentions.filter((m) => m.isBot).map((m) => m.key);
  const text = event?.content ? extractMessageText(event.message_type, event.content, others, mine).trim() : msg.content;
  const mentions = [...msg.mentions.map((m) => m.name ?? '某人'), ...(msg.mentionAll ? ['所有人'] : [])];
  return {
    id: msg.messageId, at: msg.createTime || Date.now(), from: fromBot(msg) ? 'bot' : 'user', name, text: cut(text, max),
    ...(msg.senderId ? { senderId: msg.senderId } : {}), ...(mentions.length || msg.mentionAll ? { named: true as const } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(quoted ? { quote: { name: quoted.from === 'self' ? '你' : quoted.name, text: cut(quoted.text, 200) } } : {}),
  };
}

/** A pulled history message as a line. */
function lineOfPulled(m: ContextMessage): RecentLine {
  return { id: m.messageId, at: m.createTime, from: m.from, name: m.senderName, text: cut(m.text),
    ...(m.senderId ? { senderId: m.senderId } : {}), ...(m.named ? { named: true } : {}) };
}

interface Place {
  lines: RecentLine[];
  /** Its history was pulled once, whatever came of it. */
  filled: boolean;
  /** The pull in flight: a judgement coming meanwhile waits for it. */
  pulling?: Promise<void>;
  /** Up to when a pull has read its history: the next one stops there. */
  pulledTo?: number;
}

/** What a place's pull may ask for: messages back to `stopAt`, or the latest `enough`. Undefined when it failed or ran out of time. */
export type RecentPull = (opts: { stopAt?: number; enough?: number }) => Promise<ThreadPull | undefined>;

export class RecentLines {
  /** In use order: the first is the one used longest ago. */
  private readonly places = new Map<string, Place>();
  /** Each line's place, for a recall. */
  private readonly where = new Map<string, string>();

  constructor(private readonly perPlace = RECENT_PER_PLACE, private readonly maxPlaces = RECENT_PLACES) {}

  /** Reads without changing the order used for eviction. */
  lines(key: string): readonly RecentLine[] {
    return this.places.get(key)?.lines ?? [];
  }

  private place(key: string): Place {
    let p = this.places.get(key);
    if (p) this.places.delete(key);
    else p = { lines: [], filled: false };
    this.places.set(key, p);
    while (this.places.size > this.maxPlaces) {
      const [old, gone] = this.places.entries().next().value as [string, Place];
      this.places.delete(old);
      for (const line of gone.lines) this.where.delete(line.id);
    }
    return p;
  }

  /** Adds lines to a place, by time; one already there is kept as it is. */
  add(key: string, ...lines: RecentLine[]): void {
    const p = this.place(key);
    for (const line of lines) {
      if (!line.id || this.where.has(line.id)) continue;
      let at = p.lines.length;
      while (at > 0 && p.lines[at - 1]!.at > line.at) at--;
      p.lines.splice(at, 0, line);
      this.where.set(line.id, key);
    }
    for (const gone of p.lines.splice(0, Math.max(0, p.lines.length - this.perPlace))) this.where.delete(gone.id);
  }

  /** This bot's own line (its answer, or what it decided), where its group is known; `chatId` for a topic it just opened. */
  addOwn(key: string, chatId: string, line: Omit<RecentLine, 'from' | 'name'>): void {
    if (this.places.has(key) || this.places.has(chatId)) this.add(key, { ...line, from: 'self', name: '你', text: cut(line.text) });
  }

  get(id: string): RecentLine | undefined {
    const key = this.where.get(id);
    return key === undefined ? undefined : this.places.get(key)?.lines.find((l) => l.id === id);
  }

  /** A recalled message leaves its place. */
  remove(id: string): void {
    const key = this.where.get(id);
    if (key === undefined) return;
    this.where.delete(id);
    const p = this.places.get(key);
    if (p) p.lines = p.lines.filter((l) => l.id !== id);
  }

  /** The judgement's context: the place's last {@link RECENT_CONTEXT} lines before the message, oldest first. Only a
   * judge line's fields: ids are what an anchor names, `named` keeps a line pulled from history (no names) out of a
   * decision model's anchor options, an open_id goes nowhere. */
  context(key: string, message: { id: string; at: number }): JudgeLine[] {
    const before = (this.places.get(key)?.lines ?? []).filter((l) => l.id !== message.id && l.at <= message.at);
    return before.slice(-RECENT_CONTEXT).map(({ id, at, from, name, text, mentions, named, quote }) =>
      ({ id, at, from, name, text, ...(mentions ? { mentions } : {}), ...(named ? { named } : {}), ...(quote ? { quote } : {}) }));
  }

  /**
   * Before a judgement. A place's first judgement, with fewer than {@link COLD_LINES} lines, pulls its latest
   * history once whatever comes of it (a cold start). With `others` (other bots in the group, or the count
   * unread), it also pulls what came since its last pull: Feishu does not push other bots' messages to this
   * one (3.11), so only a pull shows what they said. A failed pull leaves the ring as it was. One pull at a
   * time per place: a judgement coming meanwhile waits for it, then decides.
   */
  async fill(key: string, before: number, pull: RecentPull, others: boolean): Promise<void> {
    const p = this.place(key);
    while (p.pulling) await p.pulling.catch(() => undefined);
    const cold = !p.filled && p.lines.length < COLD_LINES;
    p.filled = true;
    if (!cold && !others) return;
    const pulling = pull(!cold && p.pulledTo ? { stopAt: p.pulledTo } : { enough: RECENT_CONTEXT }).then((got) => {
      if (!got?.ok) return;
      this.add(key, ...got.messages.map(lineOfPulled));
      p.pulledTo = Math.max(p.pulledTo ?? 0, before);
    });
    p.pulling = pulling;
    try { await pulling; } finally { if (p.pulling === pulling) p.pulling = undefined; }
  }
}

/** The quoted line of `msg`, when it is in the ring. */
export function quotedLine(lines: RecentLines, msg: NormalizedMessage): RecentLine | undefined {
  const id = quotedId(msg);
  return id ? lines.get(id) : undefined;
}
