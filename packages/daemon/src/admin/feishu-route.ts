import { z } from 'zod';
import { REFUSAL_KINDS } from '../feishu-read/denial';
import type { ApiRequest } from '../feishu-read/api';
import type { FeishuReadReply, FeishuReadRequest } from '../feishu-read/reader';
import type { SessionTokens } from '../host/session-tokens';

/**
 * dm-agent 7.3: which Bot a Feishu read runs on, the host's half. open_ids and permissions are per app, so a Bot reads as
 * itself and a read of what only another Bot can see goes to that Bot's process, which answers in its own name (7.5: its
 * link, its name to share with). A private chat's tools and `vonvon feishu` come through here; a group's and a comment's
 * tools read in their own process and never do. A group's command line comes with `bot` and `only` set by authz.
 * `feishu_api` naming another Bot (7.6) comes here too, a private chat's only, and has no way in from the command line.
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
/** A session's `feishu_api` call on another Bot, the same way. */
export interface RoutedApi { sessionId: string; request: ApiRequest }
export interface FeishuApiRouteDeps extends Pick<FeishuRouteDeps, 'bots'> {
  /** The call in that Bot's process; undefined when it has none. */
  execute(botId: string, request: ApiRequest): Promise<unknown>;
}

export const feishuReadReplySchema: z.ZodType<FeishuReadReply> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), kind: z.enum(REFUSAL_KINDS), message: z.string().min(1) }).strict(),
]);
const apiValue = z.union([z.string(), z.number(), z.boolean()]);
/** Its shape as it crosses processes; what may be sent is `checkedPath`'s, in the Bot that sends it. */
export const apiRequestSchema: z.ZodType<ApiRequest> = z.object({ method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']), path: z.string().min(1).max(2000),
  params: z.record(z.string(), z.union([apiValue, z.array(apiValue)])).optional(), body: z.record(z.string(), z.unknown()).optional() }).strict();

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

/** What a Bot's process answered: a Bot gone in the middle of it is an answer like any other refusal. */
async function answerOf(target: RouteBot, ask: () => Promise<unknown>, lost: (cause: string) => string): Promise<FeishuReadReply> {
  try {
    const answer = await ask();
    return answer === undefined ? refused(botNotRunning(target.label)) : feishuReadReplySchema.parse(answer);
  } catch (error) {
    return refused(lost(error instanceof Error ? error.message : String(error)), 'no-answer');
  }
}

/** Never throws for a read that did not happen. */
export async function routeFeishuRead(deps: FeishuRouteDeps, reach: FeishuReach, request: Omit<FeishuReadRequest, 'only'>): Promise<FeishuReadReply> {
  const bots = await deps.bots();
  const chat = typeof request.args.chat === 'string' ? request.args.chat : undefined;
  const target = await targetOf(reach, chat, bots, deps);
  if ('ok' in target) return target;
  const reply = await answerOf(target, () => deps.execute(target.id, { ...request, ...(reach.only ? { only: reach.only } : {}) }), cause => `Bot ${target.label} 这次没读成：${cause}`);
  if (reply.ok || reach.bot !== undefined || target.id !== reach.prefer || !ANOTHER_MAY_READ.has(reply.kind)) return reply;
  return { ...reply, message: `${reply.message}${await othersLine(target, bots, deps)}` };
}

/** 7.6: the Bot named, or none. Only a GET surely changed nothing, so a lost answer says what it does not know, as the call itself does. */
export async function routeFeishuApi(deps: FeishuApiRouteDeps, bot: string, request: ApiRequest): Promise<FeishuReadReply> {
  const target = named(await deps.bots(), bot);
  if ('ok' in target) return target;
  return answerOf(target, () => deps.execute(target.id, request), cause => request.method === 'GET' ? `Bot ${target.label} 这次没调成：${cause}`
    : `Bot ${target.label} 没有回话，不知道这次调用生效没有。先查一下，再决定要不要重试。`);
}

/**
 * The host's side of a session's read through another Bot: what the tools found (a private chat, an administrator's turn)
 * is checked again where a Bot process cannot speak for itself. The session must be one of this process's, a private
 * chat's, and still standing; a group's or a comment's never gets past this, whatever its process sends.
 */
export async function hostFeishuRead(host: DmHost & { read(reach: FeishuReach, request: Omit<FeishuReadRequest, 'only'>): Promise<FeishuReadReply> },
  bot: string | undefined, { sessionId, ...request }: RoutedRead): Promise<FeishuReadReply> {
  return inPrivateChat(host, sessionId) ? host.read({ prefer: host.appId, ...(bot !== undefined ? { bot } : {}) }, request) : refused(SESSION_REFUSED);
}

/** `feishu_api`'s: the same check. The turn was its tool's, under the commit guard (7.6). */
export async function hostFeishuApi(host: DmHost & { api(bot: string, request: ApiRequest): Promise<FeishuReadReply> }, bot: string, { sessionId, request }: RoutedApi): Promise<FeishuReadReply> {
  return inPrivateChat(host, sessionId) ? host.api(bot, request) : refused(SESSION_REFUSED);
}

interface DmHost { appId: string; tokens: Pick<SessionTokens, 'session'> }
function inPrivateChat({ appId, tokens }: DmHost, sessionId: string): boolean {
  const session = tokens.session(sessionId);
  return session?.appId === appId && session.place === 'dm';
}
