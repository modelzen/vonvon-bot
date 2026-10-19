import { z } from 'zod';
import type { ChatPerson } from './chat-people';
import type { Span } from '../card/md-scan';
import type { RosterBot } from './bot-roster';
import { atTags, neutraliseAts } from '../card/at-guard';
import { codeSpans } from '../card/md-scan';
import { personName, sanitizeContext } from './context-weave';
import { stripFileTokens } from './media';

export const HANDOFF_TEXT_MAX = 200;
export const HANDOFF_SEND_MS = 10_000;
export const HANDOFF_FALLBACK = '请看上面的回答';
export const HANDOFF_MAX_ATS = 5;
export const RESERVED_AT_NAMES: readonly string[] = ['所有人', '全体成员', 'all', 'everyone'];
export interface Handoff { openId: string; name: string; sentence: string; person?: true }
export interface Me { openId?: string; appId?: string }
type Recipient = Pick<Handoff, 'name' | 'person'>;
export interface Found { handoffs: Handoff[]; ambiguous: string[]; ambiguousPeople: string[]; over: Recipient[]; unverified: Recipient[] }
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const alnum = (s: string): boolean => /^[a-z0-9]$/i.test(s);
const plainName = (s: string): string => s.replace(/[<>&]/g, '');

const reserved = (name: string): boolean => RESERVED_AT_NAMES.includes(fold(name));
const validId = (id: string): boolean => /^ou_[^\s<>"'&]+$/u.test(id);
const boundary = (text: string, end: number): boolean => !alnum(text[end] ?? '') && !(/^[_/.-]$/.test(text[end] ?? '') && alnum(text[end + 1] ?? ''));
function quoteSpans(text: string): Span[] {
  return [...text.matchAll(/^[ \t]*>.*$/gmu)].map((match) => [match.index, match.index + match[0].length]);
}
function botCandidates(bots: ReadonlyMap<string, RosterBot>, me: Me) {
  return [...bots].filter(([id, bot]) => id !== me.openId && (!me.appId || bot.appId !== me.appId))
    .map(([openId, bot]) => ({ openId, name: personName(bot.name) }))
    .filter((bot) => validId(bot.openId) && bot.name && !reserved(bot.name));
}

/** Recipients mentioned in the answer, in order of their first occurrence. */
export function findHandoffs(text: string, bots: ReadonlyMap<string, RosterBot>, me: Me, people: readonly ChatPerson[] = [], peopleComplete = true): Found {
  const candidates: Omit<Handoff, 'sentence'>[] = [...botCandidates(bots, me),
    ...people.filter((person) => person.openId !== me.openId && validId(person.openId))
      .map((person): Omit<Handoff, 'sentence'> => ({ openId: person.openId, name: personName(person.name), person: true }))
      .filter((person) => person.name && !reserved(person.name))];
  candidates.sort((a, b) => b.name.length - a.name.length || (a.openId < b.openId ? -1 : a.openId > b.openId ? 1 : 0));
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const key = fold(candidate.name);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  // 2. Both mention forms skip code. A tag's contents belong to that single mention.
  const code = [...codeSpans(text), ...quoteSpans(text)];
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
    const reservedName = RESERVED_AT_NAMES.find((name) => fold(text.slice(i + 1, i + 1 + name.length)) === fold(name)
      && (!alnum(name.slice(-1)) || boundary(text, i + 1 + name.length)));
    if (reservedName) { i += reservedName.length; continue; }
    const bot = candidates.find((b) => fold(text.slice(i + 1, i + 1 + b.name.length)) === fold(b.name));
    if (!bot) continue;
    const end = i + 1 + bot.name.length;
    if (alnum(bot.name.slice(-1)) && !boundary(text, end)) continue;
    mentions.push({ start: i, end, bot });
    i = end - 1;
  }
  // 4. atTags supplies ids and full ranges; 5. preserve occurrence order and deduplicate by bot.
  mentions.sort((a, b) => a.start - b.start);
  const handoffs: Handoff[] = [];
  const ambiguous = new Map<string, string>();
  const ambiguousPeople = new Map<string, string>();
  const over: Recipient[] = [];
  const unverified: Recipient[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    const { bot } = mention;
    const key = fold(bot.name);
    const group = groups.get(key) ?? [];
    if (group.length > 1) {
      const target = group.some((candidate) => candidate.person) ? ambiguousPeople : ambiguous;
      if (!target.has(key)) target.set(key, bot.name);
      continue;
    }
    if (seen.has(bot.openId)) continue;
    seen.add(bot.openId);
    const recipient: Recipient = bot.person ? { name: bot.name, person: true } : { name: bot.name };
    if (!peopleComplete) { unverified.push(recipient); continue; }
    if (handoffs.length >= HANDOFF_MAX_ATS) { over.push(recipient); continue; }
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
  return { handoffs, ambiguous: [...ambiguous.values()], ambiguousPeople: [...ambiguousPeople.values()], over, unverified };
}

export function handoffText(handoffs: readonly Handoff[]): string {
  const ats = handoffs.map((h) => `<at user_id="${h.openId}">${plainName(h.name)}</at>`).join(' ');
  const joined = [...new Set(handoffs.map((h) => h.sentence))].join(' ');
  const sentence = sanitizeContext(stripFileTokens(neutraliseAts(joined, undefined)).replace(/[<>]/g, ''), HANDOFF_TEXT_MAX, true);
  return `${ats} ${sentence || HANDOFF_FALLBACK}`;
}

export type HandoffSendResult = { kind: 'sent' } | { kind: 'failed'; code: number } | { kind: 'unknown' };
const replyCode = z.object({ code: z.number().int() });
/** A missing or invalid business result cannot prove the server rejected a reply. */
export function handoffSendResult(reply: unknown): HandoffSendResult {
  const parsed = replyCode.safeParse(reply);
  if (!parsed.success) return { kind: 'unknown' };
  return parsed.data.code === 0 ? { kind: 'sent' } : { kind: 'failed', code: parsed.data.code };
}

export type HandoffMiss = 'failed' | 'timeout' | 'unknown';
const MISS: Record<HandoffMiss, string> = { failed: '没发出：发送失败', timeout: '没收到发送结果：超时，可能已发出', unknown: '没收到发送结果：可能已发出' };
const label = (who: Recipient): string => `${plainName(who.name)}${who.person ? '' : '（bot）'}`;
export function handoffNote(who: readonly Recipient[], why: HandoffMiss): string {
  return `→ 想 @ ${who.map(label).join('、')}，${MISS[why]}`;
}
export function ambiguousNote(name: string): string {
  const clean = plainName(name);
  return `→ 想 @ ${label({ name })}，没交接：群里不止一个叫 ${clean} 的 bot`;
}

export function ambiguousPersonNote(name: string): string {
  return `→ 想 @ ${label({ name, person: true })}，没发：群里不止一个叫 ${plainName(name)} 的成员`;
}
export function overNote(who: readonly Recipient[]): string {
  return `→ 还想 @ ${who.map(label).join('、')}，没发：一条最多 @ ${HANDOFF_MAX_ATS} 个`;
}
export function incompleteNote(who: readonly Recipient[]): string {
  return `→ 想 @ ${who.map(label).join('、')}，没发：群成员名单没读全，认不准有没有重名`;
}
export function otherBotNames(bots: ReadonlyMap<string, RosterBot> | undefined, me: Me): string[] {
  const candidates = botCandidates(bots ?? new Map(), me);
  const counts = new Map<string, number>();
  for (const bot of candidates) counts.set(fold(bot.name), (counts.get(fold(bot.name)) ?? 0) + 1);
  return candidates.filter((bot) => counts.get(fold(bot.name)) === 1).slice(0, 20).map((bot) => bot.name);
}
