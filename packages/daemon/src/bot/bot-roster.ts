import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { ChatBots } from '../card/at-guard';
import { log } from '../core/logger';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import { deniedScopeName, errorDetail, reportScopeDenied } from './diagnostics';
import { withDeadline } from './names';

/** How long a chat's bot list is trusted. s27a0: only the `<at>` guard reads it (D/card/at-guard.ts). */
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
interface Entry { bots?: ReadonlyMap<string, RosterBot>; until: number; pending?: Promise<void> }

/**
 * The bots in a chat, from Feishu's member list: the `bots` bucket of `GET im/v1/chats/<chat_id>/members/list`
 * (`member_types=bot`), which the SDK has no call for. Keyed by `member_id`, this app's open_id for that bot. Each bot
 * reads its own; never another bot's files. A failed read keeps the old list. `stop` is the orchestrator's `orStop`:
 * shutdown does not wait on a read.
 */
export function createBotRoster(
  channel: Pick<LarkChannel, 'rawClient' | 'botIdentity'>,
  opts: { stop: <T>(p: Promise<T>, fallback: T) => Promise<T> },
): ChatBots {
  const entries = new Map<string, Entry>();

  async function read(chatId: string, stale: boolean): Promise<ReadonlyMap<string, RosterBot> | undefined> {
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
      const bots = new Map<string, RosterBot>();
      for (const b of body.data?.bots ?? []) {
        if (typeof b?.member_id === 'string' && b.member_id) {
          bots.set(b.member_id, { appId: typeof b.app_id === 'string' ? b.app_id : '', name: typeof b.name === 'string' ? b.name : '' });
        }
      }
      const me = channel.botIdentity;
      if (me?.openId && !bots.has(me.openId)) bots.set(me.openId, { appId: '', name: me.name });
      log.info('card', 'bot-roster', { ...where, bots: bots.size, ...(body.data?.has_more ? { more: true } : {}) });
      return bots;
    } catch (err) {
      const code = feishuError(err)?.code;
      return failed(code !== undefined ? `code=${code}` : errorDetail(err) ?? 'error', err);
    }
  }

  return {
    peek: (chatId) => entries.get(chatId)?.bots,
    load(chatId) {
      const entry = entries.get(chatId) ?? { until: 0 };
      entries.set(chatId, entry);
      if (entry.pending) return entry.pending;
      if (entry.until > Date.now()) return Promise.resolve();
      const pending = read(chatId, Boolean(entry.bots)).then((bots) => {
        if (bots) entry.bots = bots;
        entry.until = Date.now() + (bots ? ROSTER_TTL_MS : ROSTER_RETRY_MS);
      }).finally(() => { entry.pending = undefined; });
      entry.pending = pending;
      return pending;
    },
  };
}
