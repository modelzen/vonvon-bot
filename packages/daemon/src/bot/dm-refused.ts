import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { botPaths } from '../config/paths';
import { log } from '../core/logger';
import { writeFileAtomic } from '../server/atomic-file';
import { chatMemberNames, resolveNames, withDeadline } from './names';

/**
 * Who was turned away from a private chat with a bot (dm-agent 3.5): the reply that tells them what to do, and the list
 * the client offers when an administrator is added. D2 calls {@link createDmRefusal} where the private chat checks
 * `isAdmin`, before any transcription or download.
 */
export const DM_REFUSED_MESSAGE = '你还不是这个 Bot 的管理员，请管理员在 Vonvon Bot 的「设置 → 管理员」里添加你。';
export const DM_REFUSED_MAX = 20;
export const DM_REFUSED_TTL_MS = 30 * 24 * 60 * 60_000;
/** The same person gets the reply once in this long. */
export const DM_REFUSED_REPLY_MS = 10 * 60_000;
/** A name Feishu would not give is not asked for again for this long. */
const NAME_RETRY_MS = 10 * 60_000;
const NAME_DEADLINE_MS = 3000;

const fileSchema = z.object({
  v: z.literal(1),
  people: z.array(z.object({ openId: z.string().min(1), name: z.string().min(1), at: z.number().finite().nonnegative() })),
});
export interface RefusedPerson { openId: string; name: string; at: number }
const fileFor = (appId: string): string => join(botPaths(appId).dir, 'dm-refused.json');
const live = (people: readonly RefusedPerson[], now: number): RefusedPerson[] =>
  people.filter(person => now - person.at < DM_REFUSED_TTL_MS)
    .sort((a, b) => b.at - a.at).slice(0, DM_REFUSED_MAX);

/** The people turned away in the last 30 days, the latest first; none when the file is missing or unreadable. */
export function readRefused(appId: string, now = Date.now()): RefusedPerson[] {
  try { return live(fileSchema.parse(JSON.parse(readFileSync(fileFor(appId), 'utf8'))).people, now); }
  catch { return []; }
}

/** Writes of one bot go one after the other: two people turned away together must both land. */
const writes = new Map<string, Promise<unknown>>();
async function update(appId: string, change: (people: RefusedPerson[]) => RefusedPerson[], now: number): Promise<void> {
  const run = (writes.get(appId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const people = live(change(readRefused(appId, now)), now);
    await writeFileAtomic(fileFor(appId), JSON.stringify({ v: 1, people }));
  });
  writes.set(appId, run);
  try { await run; } finally { if (writes.get(appId) === run) writes.delete(appId); }
}

export interface DmRefusalDeps {
  channel: LarkChannel;
  appId: string;
  now?: () => number;
  /** The person's name from Feishu, never from what they wrote; tests replace it. */
  lookupName?: (openId: string, chatId: string | undefined) => Promise<string | undefined>;
}
/** Who knocked: `chatId` and `replyTo` when it came as a message, only the `openId` when it came from the bot menu. */
export interface DmVisitor { openId: string; chatId?: string; replyTo?: string }

/**
 * `contact/v3/users/batch`, then, for someone outside the address book's range, the members of their private chat with the
 * bot (2026-11-05 read the name of one user this way; A2's second try with such a person is still to do).
 */
async function feishuName(channel: LarkChannel, openId: string, chatId: string | undefined): Promise<string | undefined> {
  const found = (await resolveNames(channel, [openId])).get(openId);
  if (found || !chatId) return found;
  try { return (await chatMemberNames(channel, chatId)).find(member => member.openId === openId)?.name || undefined; }
  catch (error) { log.info('console', 'dm-refused-name-fail', { err: String(error) }); return undefined; }
}

export function createDmRefusal(deps: DmRefusalDeps): (visitor: DmVisitor) => Promise<void> {
  const now = deps.now ?? Date.now;
  const lookup = deps.lookupName ?? ((openId, chatId) => feishuName(deps.channel, openId, chatId));
  const answered = new Map<string, number>();
  const unnamed = new Map<string, number>();
  const reply = async ({ openId, chatId, replyTo }: DmVisitor): Promise<void> => {
    const until = answered.get(openId);
    if (until !== undefined && now() < until) return;
    for (const [id, at] of answered) if (now() >= at) answered.delete(id);
    answered.set(openId, now() + DM_REFUSED_REPLY_MS);
    try {
      if (chatId) await deps.channel.send(chatId, { markdown: DM_REFUSED_MESSAGE }, replyTo ? { replyTo } : undefined);
      else await deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'open_id' },
        data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: DM_REFUSED_MESSAGE }) } });
    } catch (error) {
      answered.delete(openId); // not told: the next message tries again
      log.info('console', 'dm-refused-reply-fail', { err: String(error) });
    }
  };
  const record = async ({ openId, chatId }: DmVisitor): Promise<void> => {
    const at = now();
    const known = readRefused(deps.appId, at).find(person => person.openId === openId);
    let name = known?.name;
    if (!name) {
      const retryAt = unnamed.get(openId);
      if (retryAt !== undefined && at < retryAt) return;
      name = await withDeadline(lookup(openId, chatId), NAME_DEADLINE_MS, 'dm-refused-name');
      // No name from Feishu, nobody to offer: what the message says about who they are is not taken.
      if (!name) { unnamed.set(openId, at + NAME_RETRY_MS); return; }
      unnamed.delete(openId);
    }
    await update(deps.appId, people => [...people.filter(person => person.openId !== openId), { openId, name: name!, at }], at);
  };
  return async visitor => {
    if (!visitor.openId) return;
    log.info('console', 'dm-refused', { sender: visitor.openId.slice(-6) });
    await reply(visitor);
    await record(visitor).catch(error => log.fail('console', error, { phase: 'dm-refused-record' }));
  };
}
