import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import { deniedScopeName, errorDetail, reportScopeDenied } from './diagnostics';
import { withDeadline } from './names';

export const PEOPLE_TTL_MS = 10 * 60_000;
export const PEOPLE_RETRY_MS = 60_000;
/** One budget for all pages together. */
export const PEOPLE_READ_MS = 5_000;
export const PEOPLE_PAGE_SIZE = 100;
export const PEOPLE_MAX_PAGES = 10;
const MEMBERS_SCOPE = 'im:chat:readonly';
export interface ChatPerson { openId: string; name: string }
export interface PeopleList { people: readonly ChatPerson[]; complete: boolean }
export interface ChatPeople {
  peek(chatId: string): PeopleList | undefined;
  load(chatId: string): Promise<void>;
}
type Body = Awaited<ReturnType<LarkChannel['rawClient']['im']['v1']['chatMembers']['get']>>;
interface Entry { snapshot?: PeopleList; until: number; pending?: Promise<void> }

/** Reads every page before trusting name uniqueness. Shutdown releases callers without waiting for the SDK. */
export function createChatPeople(
  channel: Pick<LarkChannel, 'rawClient'>,
  opts: { stop: <T>(p: Promise<T>, fallback: T) => Promise<T> },
): ChatPeople {
  const entries = new Map<string, Entry>();
  async function read(chatId: string): Promise<PeopleList | 'stopped' | undefined> {
    const started = Date.now();
    const people: ChatPerson[] = [];
    let pages = 0;
    let token: string | undefined;
    const seenTokens = new Set<string>();
    const finish = (complete: boolean): PeopleList | undefined => {
      if (!pages) return undefined;
      log.info('card', 'chat-people', { chatId: chatId.slice(-6), people: people.length, pages, ...(!complete ? { more: true } : {}) });
      return { people, complete };
    };
    const failed = (reason: string, failure?: unknown): PeopleList | undefined => {
      const denial = scopeDenial(failure);
      const scope = denial ? deniedScopeName(denial.accepted) ?? MEMBERS_SCOPE : undefined;
      if (scope) reportScopeDenied(scope, 'chat-info');
      log.warn('card', 'chat-people-failed', { chatId: chatId.slice(-6), reason: scope ? 'missing-scope' : reason });
      return finish(false);
    };
    try {
      while (pages < PEOPLE_MAX_PAGES) {
        const remaining = PEOPLE_READ_MS - (Date.now() - started);
        if (remaining <= 0) return finish(false);
        const body = await opts.stop<Body | undefined | 'stopped'>(withDeadline(channel.rawClient.im.v1.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id', page_size: PEOPLE_PAGE_SIZE, ...(token ? { page_token: token } : {}) },
        }), remaining, 'chat-people'), 'stopped');
        if (body === 'stopped') return 'stopped';
        if (!body) return failed('timeout');
        if (body.code !== 0) return failed(`code=${body.code}`, body);
        const items = body.data?.items;
        if (!Array.isArray(items)) return failed('no-items');
        pages++;
        for (const item of items) {
          if (typeof item?.member_id === 'string' && item.member_id && typeof item.name === 'string' && item.name) {
            people.push({ openId: item.member_id, name: item.name });
          }
        }
        if (body.data?.has_more !== true) return finish(true);
        const next = body.data.page_token;
        if (!next || seenTokens.has(next)) return finish(false);
        seenTokens.add(next);
        token = next;
      }
      return finish(false);
    } catch (err) {
      const code = feishuError(err)?.code;
      return failed(code !== undefined ? `code=${code}` : errorDetail(err) ?? 'error', err);
    }
  }
  return {
    peek: (chatId) => entries.get(chatId)?.snapshot,
    async load(chatId) {
      const entry = entries.get(chatId) ?? { until: 0 };
      entries.set(chatId, entry);
      if (entry.pending) return entry.pending;
      if (entry.until > Date.now()) return;
      entry.pending = read(chatId).then((snapshot) => {
        if (snapshot === 'stopped') return;
        if (snapshot?.complete) entry.snapshot = snapshot;
        else if (entry.snapshot) entry.snapshot = { people: entry.snapshot.people, complete: false };
        else entry.snapshot = snapshot;
        entry.until = Date.now() + (snapshot?.complete ? PEOPLE_TTL_MS : PEOPLE_RETRY_MS);
      }).finally(() => { entry.pending = undefined; });
      return entry.pending;
    },
  };
}
