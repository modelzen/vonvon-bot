import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { ChatBots } from '../card/at-guard';
import { log } from '../core/logger';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import { deniedScopeName, errorDetail, reportScopeDenied } from './diagnostics';
import { withDeadline } from './names';

/** How long a chat's bot list is trusted by the `<at>` guard (D/card/at-guard.ts). A wake count reads past it. */
export const ROSTER_TTL_MS = 10 * 60_000;
/** A failed read is not tried again sooner: the guard asks on every frame. */
export const ROSTER_RETRY_MS = 60_000;
/** The SDK's calls have no timeout of their own. */
export const ROSTER_READ_MS = 3_000;
/** Reported when Feishu's refusal names no scope the console check reads. */
const MEMBERS_SCOPE = 'im:chat:readonly';

export interface RosterBot { appId: string; name: string }
interface MembersBody {
  code?: number;
  data?: { bots?: { app_id?: unknown; member_id?: unknown; name?: unknown }[]; has_more?: boolean };
}
type Bots = ReadonlyMap<string, RosterBot>;
/** `pending` is a read in flight, settling with what it read, or undefined when it failed. */
interface Entry { bots?: Bots; until: number; pending?: Promise<Bots | undefined> }

/** The guard's view, and a fresh read for a wake count (s27a-0). */
export interface BotRoster extends ChatBots {
  /** A fresh read, past the cache: this read's list, or undefined when it failed (never the old list: two computers
   * could hold different ones). Shares a read in flight; a success refreshes the cache too. */
  refresh(chatId: string): Promise<Bots | undefined>;
}

/**
 * The bots in a chat, from Feishu's member list: the `bots` bucket of `GET im/v1/chats/<chat_id>/members/list`
 * (`member_types=bot`), which the SDK has no call for. Keyed by `member_id`, this app's open_id for that bot. Each bot
 * reads its own; never another bot's files. A failed read keeps the old list for {@link ChatBots.peek}. `stop` is the
 * orchestrator's `orStop`: shutdown does not wait on a read.
 */
export function createBotRoster(
  channel: Pick<LarkChannel, 'rawClient' | 'botIdentity'>,
  opts: { stop: <T>(p: Promise<T>, fallback: T) => Promise<T> },
): BotRoster {
  const entries = new Map<string, Entry>();

  async function read(chatId: string, stale: boolean): Promise<Bots | undefined> {
    const where = { chatId: chatId.slice(-6), stale };
    const failed = (reason: string, failure?: unknown): undefined => {
      const denial = scopeDenial(failure);
      const scope = denial ? deniedScopeName(denial.accepted) ?? MEMBERS_SCOPE : undefined;
      if (scope) reportScopeDenied(scope, 'chat-info');
      log.warn('card', 'bot-roster-failed', { ...where, reason: scope ? 'missing-scope' : reason, ...(scope ? { scope } : {}) });
      return undefined;
    };
    try {
      const body = await opts.stop<MembersBody | undefined | 'stopped'>(withDeadline(channel.rawClient.request<MembersBody>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/list`,
        params: { member_types: 'bot', member_id_type: 'open_id', page_size: 100 },
      }), ROSTER_READ_MS), 'stopped');
      if (body === 'stopped') return undefined;
      if (!body) return failed('timeout');
      if (body.code !== 0) return failed(`code=${String(body.code)}`, body);
      // No bucket at all, not even an empty one: the API changed, so nothing is known (v1-plan, s27a0 做法).
      const bucket = body.data?.bots;
      if (!Array.isArray(bucket)) return failed('no-bots-bucket');
      const bots = new Map<string, RosterBot>();
      for (const b of bucket) {
        if (typeof b?.member_id === 'string' && b.member_id) {
          bots.set(b.member_id, { appId: typeof b.app_id === 'string' ? b.app_id : '', name: typeof b.name === 'string' ? b.name : '' });
        }
      }
      const me = channel.botIdentity;
      // My app_id too: a wake count tells this bot's messages by it (s27a-0).
      if (me?.openId && !bots.has(me.openId)) bots.set(me.openId, { appId: channel.rawClient.appId ?? '', name: me.name });
      log.info('card', 'bot-roster', { ...where, bots: bots.size, ...(body.data?.has_more ? { more: true } : {}) });
      return bots;
    } catch (err) {
      const code = feishuError(err)?.code;
      return failed(code !== undefined ? `code=${code}` : errorDetail(err) ?? 'error', err);
    }
  }

  function entryOf(chatId: string): Entry {
    const entry = entries.get(chatId) ?? { until: 0 };
    entries.set(chatId, entry);
    return entry;
  }
  function start(chatId: string, entry: Entry): Promise<Bots | undefined> {
    const pending = read(chatId, Boolean(entry.bots)).then((bots) => {
      if (bots) entry.bots = bots;
      entry.until = Date.now() + (bots ? ROSTER_TTL_MS : ROSTER_RETRY_MS);
      return bots;
    }).finally(() => { entry.pending = undefined; });
    entry.pending = pending;
    return pending;
  }

  return {
    peek: (chatId) => entries.get(chatId)?.bots,
    async load(chatId) {
      const entry = entryOf(chatId);
      if (entry.pending) await entry.pending;
      else if (entry.until <= Date.now()) await start(chatId, entry);
    },
    refresh(chatId) {
      const entry = entryOf(chatId);
      return entry.pending ?? start(chatId, entry);
    },
  };
}
