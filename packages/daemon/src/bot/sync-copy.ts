import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { withDeadline } from './names';

/**
 * 「同时发送到群」and, in a DM topic, 「同时发送到会话」(s14d, e10 item 5). Feishu
 * sends such a reply twice, at the same time: the topic message, with
 * `sync_to_chat_info` `{type: 2, related_message_id: the copy}`, and a copy in
 * the main area without `thread_id` or `root_id`, with `{type: 1,
 * related_message_id: the topic message, thread_id: the topic}`. Only the
 * topic message is answered. The copy stays in Feishu's main-area history, so
 * a later main-area record block or topic opening still lists it like any
 * other main-area message: people there saw it.
 *
 * The SDK hands the receive event through untouched as `msg.raw` (the daemon
 * sets `includeRawEvent`), with the event's `message` object as Feishu sent it,
 * so the field is read there although the SDK's types lack it. Whether the
 * event carries it at all is unconfirmed (only `message.get` was seen to
 * return it), so a main-area message the bot would act on is looked up once
 * while no receive event has shown the field in this process.
 */

/** `sync_to_chat_info.type` of the main-area copy. */
export const SYNC_COPY_TYPE = 1;
/** How long the fallback lookup may take: it holds the chat's intake queue. */
export const SYNC_LOOKUP_MS = 1500;

export interface SyncCopyGate {
  /**
   * True when `msg` is the main-area copy and must be dropped before anything
   * else happens to it. `wouldAct`: the bot would answer it (an @, 免@, or any
   * DM message), the only case worth a lookup when the event has no field.
   */
  skip(msg: NormalizedMessage, wouldAct: boolean): Promise<boolean>;
}

/** The event's `message` object; undefined without a raw event. */
function eventMessage(raw: unknown): Record<string, unknown> | undefined {
  const r = raw as { message?: unknown; event?: { message?: unknown } } | undefined;
  const m = r?.message ?? r?.event?.message;
  return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
}

function isCopy(info: unknown): boolean {
  return Number((info as { type?: unknown } | null | undefined)?.type) === SYNC_COPY_TYPE;
}

export function createSyncCopyGate(channel: LarkChannel, lookupMs = SYNC_LOOKUP_MS): SyncCopyGate {
  /** What the receive-fields line last said: once without the field, once with it. */
  let fieldsLogged: boolean | undefined;
  /** A receive event carried the field: one without it is no copy. */
  let eventsCarry = false;
  let lookupLogged = false;
  let failLogged = false;

  /** Field names only, for the M5 acceptance (which path ran). */
  function noteFields(m: Record<string, unknown>, present: boolean): void {
    if (fieldsLogged === true || fieldsLogged === present) return;
    fieldsLogged = present;
    log.info('intake', 'receive-fields', { syncToChatInfo: present, fields: Object.keys(m).sort() });
  }

  function failed(err: string): false {
    if (!failLogged) {
      failLogged = true;
      log.warn('intake', 'sync-lookup-failed', { err });
    }
    return false;
  }

  /** Fails open: a lookup that fails or runs out of time is an ordinary message. */
  async function lookedUpCopy(messageId: string): Promise<boolean> {
    if (!lookupLogged) {
      lookupLogged = true;
      log.info('intake', 'sync-lookup', { timeoutMs: lookupMs });
    }
    try {
      const res = await withDeadline(channel.rawClient.im.v1.message.get({ path: { message_id: messageId } }), lookupMs);
      if (!res) return failed('timeout');
      if (typeof res.code === 'number' && res.code !== 0) return failed(`code=${res.code}`);
      const item = (res.data as { items?: { sync_to_chat_info?: unknown }[] } | undefined)?.items?.[0];
      return isCopy(item?.sync_to_chat_info);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    async skip(msg, wouldAct) {
      const m = eventMessage(msg.raw);
      // No raw event (never in the daemon): nothing to go on.
      if (!m) return false;
      const present = 'sync_to_chat_info' in m;
      noteFields(m, present);
      if (present) eventsCarry = true;
      let via: 'event' | 'lookup' | undefined;
      if (present) via = isCopy(m.sync_to_chat_info) ? 'event' : undefined;
      else if (!msg.threadId && wouldAct && !eventsCarry && (await lookedUpCopy(msg.messageId))) via = 'lookup';
      if (!via) return false;
      log.info('intake', 'sync-copy-skipped', { via, chatType: msg.chatType, ref: msg.messageId.slice(-6) });
      return true;
    },
  };
}
