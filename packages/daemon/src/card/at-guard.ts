import type { LarkChannel } from '@larksuiteoapi/node-sdk';

/**
 * s27a0. A bot's `<at>` inside a card or a markdown post wakes that bot, yet Feishu's message list shows no mention
 * for it (s27 probe, 2026-10-19), so nobody could count that wake. Every card and markdown post this bot sends passes
 * here: an `<at>` stays a real mention only when the chat's bot list is known and lacks its id, or when the program
 * put that id there itself ({@link keepAts}). A bot's, `all`, and any we cannot tell yet show as plain `@name`.
 */
export type ChatBotIds = ReadonlyMap<string, { readonly name?: string }>;

/** A chat's bots by open_id ({@link ../bot/bot-roster}). */
export interface ChatBots {
  /** Stale or fresh; undefined until a read succeeds. Never waits. */
  peek(chatId: string): ChatBotIds | undefined;
  /** Read the list unless it is fresh. Settles, never rejects: read, failed, timed out or shut down. */
  load(chatId: string): Promise<void>;
}

const lists = new WeakMap<object, ChatBots>();
const wrapped = new WeakSet<object>();
const kept = new WeakMap<object, ReadonlySet<string>>();

/** `ids` are @-ed in `card` by the program itself (an ask card's respondents): they stay real before the list is read. */
export function keepAts<T extends object>(card: T, ids: readonly string[]): T {
  kept.set(card, new Set(ids));
  return card;
}
export const keptAts = (card: object): ReadonlySet<string> | undefined => kept.get(card);

const HAS_AT = /<at\b/i;
// A tag never spans lines; `$` is a frame cut inside the tag.
const AT = /<at\b([^>\n]*)(?:>([^<\n]*)<\/at\s*>|>|$)/gi;
const AT_ID = /\b(?:open_id|user_id|id)\s*=\s*["']?([^"'\s>]+)/i;

/** Every opening tag counts: `id=`, `user_id=`, `open_id=`, quoted or not, closed or not, inside code too (Feishu was
 * never tried there; it only changes the look). `bots` undefined: this chat's list is not known. */
export function neutraliseAts(text: string, bots: ChatBotIds | undefined, keep?: ReadonlySet<string>): string {
  if (!HAS_AT.test(text)) return text;
  return text.replace(AT, (tag, attrs: string, name: string | undefined) => {
    const id = AT_ID.exec(attrs)?.[1];
    const bot = id !== undefined && bots?.has(id) === true;
    if (!bot && id !== 'all' && (bots !== undefined || (id !== undefined && keep?.has(id) === true))) return tag;
    if (name === undefined) return '@';
    return `@${name.trim() || (id && bots?.get(id)?.name) || (bot ? '另一个 bot' : id === 'all' ? '所有人' : '某人')}`;
  });
}

type Maybe<T> = T | Promise<T>;
const then = <T, R>(value: Maybe<T>, next: (v: T) => R): Maybe<R> => value instanceof Promise ? value.then(next) : next(value);

/** The list as it is now; with `wait` (anything but a streamed frame), an unknown one once read. The read is bounded
 * and shutdown cuts it. Synchronous unless it waits, so a card is not held back a tick for nothing. */
function botsFor(client: object, chatId: string | undefined, wait: boolean): Maybe<ChatBotIds | undefined> {
  const list = lists.get(client);
  if (!list || !chatId) return undefined;
  const loading = list.load(chatId); // refreshes a stale list in the background
  const now = list.peek(chatId);
  return now || !wait ? now : loading.then(() => list.peek(chatId));
}

/** A card's JSON with every string in it settled for `chatId`. */
export function guardCardJson(client: object, raw: string, chatId?: string, keep?: ReadonlySet<string>, wait = true): Maybe<string> {
  if (!HAS_AT.test(raw)) return raw;
  return then(botsFor(client, chatId, wait), (bots) =>
    JSON.stringify(JSON.parse(raw), (_key, value: unknown) => typeof value === 'string' ? neutraliseAts(value, bots, keep) : value));
}

export function guardText(client: object, text: string, chatId?: string, wait = true): Maybe<string> {
  return HAS_AT.test(text) ? then(botsFor(client, chatId, wait), (bots) => neutraliseAts(text, bots)) : text;
}

/** Cards find the list by `rawClient` (serializeRuntimeCard, the run card's element writes); markdown posts by this
 * wrapper on `channel.send`, so no call site can skip it. Text messages are not touched: their @ is listed. */
export function installAtGuard(channel: Pick<LarkChannel, 'rawClient' | 'send'>, list: ChatBots): void {
  if (channel.rawClient) lists.set(channel.rawClient, list); // some test channels have none
  if (wrapped.has(channel) || typeof channel.send !== 'function') return;
  wrapped.add(channel);
  const send = channel.send.bind(channel);
  channel.send = (to, input, ...rest) => 'markdown' in input && HAS_AT.test(input.markdown)
    ? Promise.resolve(guardText(channel.rawClient, input.markdown, to)).then((markdown) => send(to, { markdown }, ...rest))
    : send(to, input, ...rest);
}
