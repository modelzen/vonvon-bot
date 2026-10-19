import type { LarkChannel, MentionInfo, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { scopeDenial } from '../utils/feishu-error';
import { reportScopeDenied } from './diagnostics';

/**
 * Real names by open_id (product.md 3.5: 真人的话带真名).
 *
 * open_id is per app, so every bot (one orchestrator each) keeps its own
 * {@link NameBook}; never share one across bots. The book fills itself from
 * what passes by: inbound @mentions and every pulled history or quote item
 * (pulled `with_sender_name`, which e10 showed returns real names for people
 * and bots). On a miss for a turn's sender it looks up, in order:
 *   1. `message.get` on the trigger `with_sender_name` (the history scope we
 *      already require);
 *   2. `contact.v3.user.batch` (optional `contact:user.base:readonly`; a
 *      99991672 skips this step for half an hour, since the owner may grant
 *      the scope meanwhile);
 *   3. the chat's member list (first page; remembers every member at once).
 * Everything is best-effort and bounded by a deadline: a failed lookup
 * returns undefined and the caller shows what it showed before. The SDK's
 * HTTP calls have no timeout, so a lookup still running after a longer hard
 * deadline counts as a miss; a name it finds later is still kept.
 */

const HIT_TTL_MS = 12 * 60 * 60_000;
const MISS_TTL_MS = 10 * 60_000;
const MAX_NAMES = 2000;
const LOOKUP_DEADLINE_MS = 3000;
const LOOKUP_HARD_DEADLINE_MS = 15_000;
const CONTACT_RETRY_MS = 30 * 60_000;

interface NameEntry {
  /** undefined for a remembered miss. */
  name?: string;
  until: number;
}

export interface NameBook {
  /** The cached name, without any lookup. */
  peek(openId: string | undefined): string | undefined;
  remember(openId: string | undefined, name: string | undefined): void;
  learnMentions(mentions: readonly MentionInfo[] | undefined): void;
  /** The sender's real name, or undefined when every step failed. Never throws. */
  senderName(msg: Pick<NormalizedMessage, 'senderId' | 'messageId' | 'chatId'>): Promise<string | undefined>;
}

export function createNameBook(
  channel: LarkChannel,
  opts: { now?: () => number; deadlineMs?: number; hardDeadlineMs?: number } = {},
): NameBook {
  const now = opts.now ?? Date.now;
  const deadlineMs = opts.deadlineMs ?? LOOKUP_DEADLINE_MS;
  const hardDeadlineMs = opts.hardDeadlineMs ?? LOOKUP_HARD_DEADLINE_MS;
  const entries = new Map<string, NameEntry>();
  const inflight = new Map<string, Promise<string | undefined>>();
  /** Until when contact is skipped after a missing scope. */
  let contactDeniedUntil = 0;

  function put(id: string, name: string | undefined): void {
    entries.delete(id); // re-insert so the oldest entry is evicted first
    entries.set(id, { name, until: now() + (name ? HIT_TTL_MS : MISS_TTL_MS) });
    if (entries.size > MAX_NAMES) entries.delete(entries.keys().next().value as string);
  }
  /** The live entry (a hit or a remembered miss); an expired one is dropped. */
  function entry(id: string): NameEntry | undefined {
    const e = entries.get(id);
    if (e && e.until <= now()) {
      entries.delete(id);
      return undefined;
    }
    return e;
  }
  function peek(id: string | undefined): string | undefined {
    return id ? entry(id)?.name : undefined;
  }
  function remember(id: string | undefined, name: string | undefined): void {
    const n = name?.trim();
    if (id && n) put(id, n);
  }

  async function lookup(msg: Pick<NormalizedMessage, 'senderId' | 'messageId' | 'chatId'>): Promise<string | undefined> {
    const id = msg.senderId;
    try {
      const res = await channel.rawClient.im.v1.message.get({
        path: { message_id: msg.messageId },
        params: { with_sender_name: true },
      });
      const sender = (res.data?.items?.[0] as { sender?: { id?: string; sender_name?: string } } | undefined)?.sender;
      const name = sender?.sender_name?.trim();
      if (sender?.id === id && name) return name;
    } catch (err) {
      log.info('intake', 'sender-name-miss', { step: 'message', err: String(err) });
    }
    if (now() >= contactDeniedUntil) {
      try {
        const name = (await contactNames(channel, [id])).get(id);
        if (name) return name;
      } catch (err) {
        const denied = Boolean(scopeDenial(err));
        if (denied) { contactDeniedUntil = now() + CONTACT_RETRY_MS; reportScopeDenied('contact:user.base:readonly', 'names'); }
        log.info('intake', 'sender-name-miss', { step: 'contact', denied, err: String(err) });
      }
    }
    try {
      for (const m of await chatMemberNames(channel, msg.chatId)) remember(m.openId, m.name);
    } catch (err) {
      log.info('intake', 'sender-name-miss', { step: 'members', err: String(err) });
    }
    return peek(id);
  }

  return {
    peek,
    remember,
    learnMentions(mentions) {
      for (const m of mentions ?? []) remember(m.openId, m.name);
    },
    senderName(msg) {
      const id = msg.senderId;
      if (!id) return Promise.resolve(undefined);
      const hit = entry(id);
      if (hit) return Promise.resolve(hit.name);
      let pending = inflight.get(id);
      if (!pending) {
        const looked = lookup(msg)
          .catch(() => undefined)
          .then((name) => {
            if (name) put(id, name); // also when it arrives after the hard deadline
            return name;
          });
        pending = withDeadline(looked, hardDeadlineMs)
          .then(() => {
            // A history pull may have learned the name while this lookup failed.
            if (!peek(id)) put(id, undefined);
            return peek(id);
          })
          .finally(() => inflight.delete(id));
        inflight.set(id, pending);
      }
      return withDeadline(pending, deadlineMs);
    },
  };
}

/**
 * `p`, or undefined once `ms` passed (the SDK's calls have no timeout). A `p` that settles after that is still
 * watched: one info line says how long it took and whether it succeeded, to tell a slow call from a dead one (s23f2).
 * `what` names the call in that line.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, what?: string): Promise<T | undefined> {
  const started = Date.now();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { expired = true; resolve(undefined); }, ms);
  });
  const settled = (ok: boolean): void => {
    if (expired) log.info('intake', 'late-answer', { ...(what ? { what } : {}), deadlineMs: ms, ms: Date.now() - started, ok });
  };
  // handles the rejection too, so a late failure is never unhandled
  p.then(() => settled(true), () => settled(false));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** contact.batch by open_id. Throws on any failure, including a returned non-zero code. */
async function contactNames(channel: LarkChannel, ids: string[]): Promise<Map<string, string>> {
  const r = await channel.rawClient.contact.v3.user.batch({
    params: { user_ids: ids, user_id_type: 'open_id' },
  });
  if (typeof r.code === 'number' && r.code !== 0) throw r;
  const out = new Map<string, string>();
  for (const it of r.data?.items ?? []) {
    if (it.open_id && it.name) out.set(it.open_id, it.name);
  }
  return out;
}

/** The chat's members (first page). Throws on failure. */
async function chatMemberNames(channel: LarkChannel, chatId: string): Promise<{ openId: string; name?: string }[]> {
  const r = await channel.rawClient.im.v1.chatMembers.get({
    path: { chat_id: chatId },
    params: { member_id_type: 'open_id', page_size: 100 },
  });
  return (r.data?.items ?? []).flatMap((it) => (it.member_id ? [{ openId: it.member_id, name: it.name || undefined }] : []));
}

/**
 * open_id → 姓名 的批量解析（管理员 / 白名单卡展示用）。需 contact:user.base:readonly
 * scope；无 scope / 调用失败则返回空 Map，卡片降级显示 open_id 尾段（见 memberName）。
 */
export async function resolveNames(channel: LarkChannel, ids: (string | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (uniq.length === 0) return new Map();
  try {
    return await contactNames(channel, uniq);
  } catch (err) {
    log.info('console', 'resolve-names-fail', { n: uniq.length, err: String(err) });
    return new Map();
  }
}

/** 拉群成员（open_id + 姓名）。该接口**不返回机器人成员**（天然排除 bot），也能拿到
 * 外部租户成员（不受通讯录可见范围限制）。失败 / 无权限返回空数组（调用方降级到手填
 * open_id）。仅取首页（page_size 100），大群配合手填。 */
export async function fetchChatMembers(channel: LarkChannel, chatId: string): Promise<{ openId: string; name: string }[]> {
  try {
    return (await chatMemberNames(channel, chatId)).map((m) => ({ openId: m.openId, name: m.name ?? `…${m.openId.slice(-6)}` }));
  } catch (err) {
    log.info('console', 'fetch-members-fail', { chatId: chatId.slice(-6), err: String(err) });
    return [];
  }
}
