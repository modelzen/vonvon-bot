import { z } from 'zod';
import { REFUSAL_KINDS } from '../feishu-read/denial';
import type { FeishuReadReply, FeishuReadRequest } from '../feishu-read/reader';
import type { SessionTokens } from '../host/session-tokens';

/**
 * dm-agent 7.3: which Bot a Feishu read runs on, the host's half. open_ids and permissions are per app, so a Bot reads as
 * itself and a read of what only another Bot can see goes to that Bot's process, which answers in its own name (7.5: its
 * link, its name to share with). A private chat's tools and `vonvon feishu` come through here; a group's and a comment's
 * tools read in their own process and never do. A group's command line comes with `bot` and `only` set by authz.
 */

/**
 * Which Bot: `bot` as named (its id or name); else the one bound to the chat asked about, `prefer` first; else `prefer`, the
 * session's own. `only`: the chat the read is kept to (7.2).
 */
export interface FeishuReach { bot?: string; prefer?: string; only?: string }
export interface RouteBot { id: string; label: string; name: string }
export interface FeishuRouteDeps {
  bots(): Promise<readonly RouteBot[]>;
  /** The chats a Bot is bound to. */
  chats(botId: string): Promise<readonly string[]>;
  running(botId: string): Promise<boolean>;
  /** The read in that Bot's process; undefined when it has none (7.3: not running). */
  execute(botId: string, request: FeishuReadRequest): Promise<unknown>;
}
/** A session's read as its Bot process sends it to the host: `sessionId` is what the host checks. */
export type RoutedRead = Omit<FeishuReadRequest, 'only'> & { sessionId: string };

export const feishuReadReplySchema: z.ZodType<FeishuReadReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), kind: z.enum(REFUSAL_KINDS), message: z.string().min(1) }).strict(),
]);

const refused = (message: string, kind: Extract<FeishuReadReply, { ok: false }>['kind'] = 'other'): FeishuReadReply => ({ ok: false, kind, message });
export const botNotRunning = (bot: string): string => `Bot ${bot} 没在运行。`;
const NAME_THE_BOT = '要指定用哪个 Bot 读：命令行写 --bot。';
const NO_BINDING = '这台电脑上没有 Bot 绑定这个群。要读，用 --bot 指定一个在这个群里的 Bot。';
const SESSION_REFUSED = '目标不存在或没有权限。';
/** A refusal another Bot may not have: Feishu's permissions and shares and a chat's members are each app's own. */
const ANOTHER_MAY_READ: ReadonlySet<string> = new Set(['scope', 'not-shared', 'not-in-chat']);

function named(bots: readonly RouteBot[], wanted: string): RouteBot | FeishuReadReply {
  const byId = bots.find(bot => bot.id === wanted);
  if (byId) return byId;
  const found = bots.filter(bot => bot.label === wanted || bot.name === wanted);
  if (found.length > 1) return refused(`有 ${found.length} 个 Bot 都叫「${wanted}」，用 App ID 指定：${found.map(bot => bot.id).join('、')}。`);
  return found[0] ?? refused(`这台电脑上没有 Bot「${wanted}」。现有的 Bot：${bots.map(bot => `${bot.label}（${bot.id}）`).join('、')}。`);
}

/** The first bound Bot that can answer: a stopped one first in the list says nothing of one that is running. */
async function boundTo(chat: string, current: RouteBot | undefined, bots: readonly RouteBot[], deps: FeishuRouteDeps): Promise<RouteBot | undefined> {
  const bound = async (bot: RouteBot): Promise<boolean> => (await deps.chats(bot.id).catch((): readonly string[] => [])).includes(chat);
  if (current && await bound(current)) return current;
  const binders: RouteBot[] = [];
  for (const bot of bots) if (bot !== current && await bound(bot)) binders.push(bot);
  for (const bot of binders) if (await deps.running(bot.id).catch(() => false)) return bot;
  return binders[0];
}

async function targetOf(reach: FeishuReach, chat: string | undefined, bots: readonly RouteBot[], deps: FeishuRouteDeps): Promise<RouteBot | FeishuReadReply> {
  if (reach.bot !== undefined) return named(bots, reach.bot);
  const current = bots.find(bot => bot.id === reach.prefer);
  if (chat === undefined) return current ?? refused(NAME_THE_BOT);
  return await boundTo(chat, current, bots, deps) ?? current ?? refused(NO_BINDING);
}

/** 7.3: what the session's own Bot could not read, another may. Only a read that named no Bot, on the session's own. */
async function othersLine(target: RouteBot, bots: readonly RouteBot[], deps: FeishuRouteDeps): Promise<string> {
  const others = bots.filter(bot => bot !== target);
  if (!others.length) return '';
  const shown = await Promise.all(others.map(async bot => `${bot.label}（${bot.id}）${await deps.running(bot.id).catch(() => false) ? '' : '，没在运行'}`));
  return ` 这台电脑上还有别的 Bot：${shown.join('、')}。可以换一个读：工具写 bot 参数，命令行写 --bot。`;
}

/** Never throws for a read that did not happen: a Bot gone in the middle of it is an answer like any other refusal. */
export async function routeFeishuRead(deps: FeishuRouteDeps, reach: FeishuReach, request: Omit<FeishuReadRequest, 'only'>): Promise<FeishuReadReply> {
  const bots = await deps.bots();
  const chat = typeof request.args.chat === 'string' ? request.args.chat : undefined;
  const target = await targetOf(reach, chat, bots, deps);
  if ('ok' in target) return target;
  let reply: FeishuReadReply;
  try {
    const answer = await deps.execute(target.id, { ...request, ...(reach.only ? { only: reach.only } : {}) });
    if (answer === undefined) return refused(botNotRunning(target.label));
    reply = feishuReadReplySchema.parse(answer);
  } catch (error) {
    return refused(`Bot ${target.label} 这次没读成：${error instanceof Error ? error.message : String(error)}`, 'no-answer');
  }
  if (reply.ok || reach.bot !== undefined || target.id !== reach.prefer || !ANOTHER_MAY_READ.has(reply.kind)) return reply;
  return { ...reply, message: `${reply.message}${await othersLine(target, bots, deps)}` };
}

/**
 * The host's side of a session's read through another Bot: what the tools found (a private chat, an administrator's turn)
 * is checked again where a Bot process cannot speak for itself. The session must be one of this process's, a private
 * chat's, and still standing; a group's or a comment's never gets past this, whatever its process sends.
 */
export async function hostFeishuRead(host: { appId: string; tokens: Pick<SessionTokens, 'session'>; read(reach: FeishuReach, request: Omit<FeishuReadRequest, 'only'>): Promise<FeishuReadReply> },
  bot: string | undefined, { sessionId, ...request }: RoutedRead): Promise<FeishuReadReply> {
  const session = host.tokens.session(sessionId);
  if (session?.appId !== host.appId || session.place !== 'dm') return refused(SESSION_REFUSED);
  return host.read({ prefer: host.appId, ...(bot !== undefined ? { bot } : {}) }, request);
}
