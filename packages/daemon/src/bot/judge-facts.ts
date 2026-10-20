import type { JudgeFacts } from '../judge/types';
import type { BotRosterSnapshot } from './bot-roster';
import type { RecentLine } from './recent-lines';
import { COMMON_NAMES } from './salience';

/** Short/common names are weak evidence only; a long name's two-character prefix is not one. */
export function sameNameWord(text: string, botName: string): boolean {
  const name = botName.trim();
  if (!name) return false;
  const ascii = /^[\x20-\x7e]+$/.test(name);
  if (!COMMON_NAMES.has(name.toLowerCase()) && (ascii ? name.length >= 3 : [...name].length >= 2)) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ascii ? new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(text) : text.includes(name);
}

/** Only the current place's bounded ring is admitted. An absent person boundary is a lower bound. */
export function buildJudgeFacts(opts: {
  lines: readonly RecentLine[]; message: RecentLine; topic: boolean;
  roster?: BotRosterSnapshot; self: { openId?: string; appId?: string }; openedBy?: string;
}): JudgeFacts {
  const byId = new Map<string, RecentLine>();
  for (const line of [...opts.lines, opts.message]) {
    if (line.at <= opts.message.at && !line.id.startsWith('act:') && !line.id.startsWith('empty:')) byId.set(line.id, line);
  }
  const lines = [...byId.values()].sort((a, b) => a.at - b.at);
  const speakers = new Map<string, string>();
  const bots = new Map<string, string>();
  for (const line of lines) {
    const key = line.from === 'self' ? 'self' : line.senderId;
    if (key) speakers.set(key, line.from === 'self' ? '你' : line.name);
    if (line.from === 'bot' && line.senderId) bots.set(line.senderId, line.name);
  }
  if (opts.roster?.complete) {
    bots.clear();
    for (const [id, bot] of opts.roster.bots) {
      if (id !== opts.self.openId && !(opts.self.appId && bot.appId === opts.self.appId)) bots.set(id, bot.name || '名字未知的 bot');
    }
  }
  let count = 0;
  for (const line of [...lines].reverse()) {
    if (line.from === 'user') break;
    count++;
  }
  return {
    otherBots: { names: [...bots.values()], complete: opts.roster?.complete === true },
    here: { kind: opts.topic ? 'topic' : 'main', ...(opts.openedBy ? { openedBy: opts.openedBy } : {}), speakers: [...speakers.values()], historyIncomplete: true },
    ...(count >= 2 ? { botExchangesSincePerson: { count, atLeast: true } } : {}),
  };
}

/** Reads may settle later, but a recalled judgement stops waiting immediately. */
export async function judgeFactRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  let abort!: () => void;
  const stopped = new Promise<undefined>((resolve) => { abort = () => resolve(undefined); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try { return await Promise.race([read.catch(() => undefined), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}
