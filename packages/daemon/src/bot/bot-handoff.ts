import type { RosterBot } from './bot-roster';
import { atTags, neutraliseAts } from '../card/at-guard';
import { codeSpans } from '../card/md-scan';
import { personName, sanitizeContext } from './context-weave';
import { stripFileTokens } from './media';

export const HANDOFF_TEXT_MAX = 200;
export const HANDOFF_SEND_MS = 10_000;
export const HANDOFF_FALLBACK = '请看上面的回答';
export interface Handoff { openId: string; name: string; sentence: string }
export interface Me { openId?: string; appId?: string }
export interface Found { handoffs: Handoff[]; ambiguous: string[] }
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const alnum = (s: string): boolean => /^[a-z0-9]$/i.test(s);
const plainName = (s: string): string => s.replace(/[<>&]/g, '');

/** Other bots mentioned in the answer, in order of their first occurrence. */
export function findHandoffs(text: string, bots: ReadonlyMap<string, RosterBot>, me: Me): Found {
  // 1. Exclude ourselves by either identity; normalized duplicate names remain ambiguous.
  const candidates = [...bots].filter(([id, bot]) => id !== me.openId && (!me.appId || bot.appId !== me.appId))
    .map(([openId, bot]) => ({ openId, name: personName(bot.name) })).filter((bot) => bot.name)
    .sort((a, b) => b.name.length - a.name.length || (a.openId < b.openId ? -1 : a.openId > b.openId ? 1 : 0));
  const counts = new Map<string, number>();
  for (const bot of candidates) counts.set(fold(bot.name), (counts.get(fold(bot.name)) ?? 0) + 1);
  // 2. Both mention forms skip code. A tag's contents belong to that single mention.
  const code = codeSpans(text);
  const inCode = (i: number): boolean => code.some(([a, b]) => i >= a && i < b);
  const tags = atTags(text);
  type Mention = { start: number; end: number; bot: typeof candidates[number] };
  const mentions: Mention[] = [];
  for (const tag of tags) {
    const bot = candidates.find((b) => b.openId === tag.id);
    if (bot && !inCode(tag.start)) mentions.push({ ...tag, bot });
  }
  // 3. Longest prefix first; a failed ASCII boundary never falls back to a shorter name.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || inCode(i) || tags.some((t) => i >= t.start && i < t.end)) continue;
    if (/[a-z0-9/]/i.test(text[i - 1] ?? '')) continue;
    const bot = candidates.find((b) => fold(text.slice(i + 1, i + 1 + b.name.length)) === fold(b.name));
    if (!bot) continue;
    const end = i + 1 + bot.name.length;
    if (alnum(bot.name.slice(-1)) && (alnum(text[end] ?? '') || (/^[_/.-]$/.test(text[end] ?? '') && alnum(text[end + 1] ?? '')))) continue;
    mentions.push({ start: i, end, bot });
    i = end - 1;
  }
  // 4. atTags supplies ids and full ranges; 5. preserve occurrence order and deduplicate by bot.
  mentions.sort((a, b) => a.start - b.start);
  const handoffs: Handoff[] = [];
  const ambiguous = new Map<string, string>();
  const seen = new Set<string>();
  for (const mention of mentions) {
    const { bot } = mention;
    const key = fold(bot.name);
    if ((counts.get(key) ?? 0) > 1) { if (!ambiguous.has(key)) ambiguous.set(key, bot.name); continue; }
    if (seen.has(bot.openId)) continue;
    seen.add(bot.openId);
    // 6. Keep the enclosing sentence and its final punctuation, removing every recognized mention.
    let start = mention.start;
    let end = mention.end;
    while (start > 0 && !/[。！？!?；;\n]/.test(text[start - 1] ?? '')) start--;
    while (end < text.length && !/[。！？!?；;\n]/.test(text[end] ?? '')) end++;
    if (end < text.length && text[end] !== '\n') end++;
    let sentence = '';
    let cursor = start;
    for (const other of mentions) {
      if (other.start < start || other.end > end) continue;
      sentence += text.slice(cursor, other.start);
      cursor = other.end;
    }
    sentence += text.slice(cursor, end);
    // Remove file tokens while angle brackets still identify them.
    sentence = stripFileTokens(neutraliseAts(sentence, undefined)).replace(/[<>]/g, '');
    handoffs.push({ ...bot, sentence: sanitizeContext(sentence, HANDOFF_TEXT_MAX, true) });
  }
  // 7. Unknown names and ids stay ordinary text, without a footnote.
  return { handoffs, ambiguous: [...ambiguous.values()] };
}

export function handoffText(handoffs: readonly Handoff[]): string {
  const ats = handoffs.map((h) => `<at user_id="${h.openId}">${plainName(h.name)}</at>`).join(' ');
  const joined = [...new Set(handoffs.map((h) => h.sentence))].join(' ');
  const sentence = sanitizeContext(stripFileTokens(neutraliseAts(joined, undefined)).replace(/[<>]/g, ''), HANDOFF_TEXT_MAX, true);
  return `${ats} ${sentence || HANDOFF_FALLBACK}`;
}

export type HandoffMiss = 'failed' | 'timeout';
const MISS: Record<HandoffMiss, string> = { failed: '没发出：发送失败', timeout: '没收到发送结果：超时，可能已发出' };
export function handoffNote(names: readonly string[], why: HandoffMiss): string {
  return `→ 想 @ ${names.map((name) => `${plainName(name)}（bot）`).join('、')}，${MISS[why]}`;
}
export function ambiguousNote(name: string): string {
  const clean = plainName(name);
  return `→ 想 @ ${clean}（bot），没交接：群里不止一个叫 ${clean} 的 bot`;
}
