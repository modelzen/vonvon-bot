import { groupIdSchema } from '@vonvon/protocol';
import { feishuGroups } from '../../admin/structured-commands';
import { badArgs } from '../command-error';
import { cliInSession, pickBot, print, want, withDaemon, type Daemon, type Io } from '../daemon-client';

export async function runFeishuGroups(options: { bot?: string; cursor?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const result = await daemon(async call => {
    const bot = pickBot((await call('读取快照', c => c.snapshot())).agents, options.bot);
    return feishuGroups({ groups: async cursor => {
      const result = want('查群列表', await call('查群列表', c => c.run({ type: 'listJoinedGroups', agentId: bot.id, ...(cursor ? { cursor } : {}) }), { feishu: true }), 'groups');
      return { groups: result.groups.map(({ id, ...group }) => ({ ...group, chatId: id })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    } }, options.cursor);
  });
  const rows = result.groups.map(group => `${group.name}  ${group.chatId}${group.bound ? '  已绑定' : ''}`);
  if (!rows.length) rows.push('这一页是空的。');
  if (result.nextCursor) rows.push(`还有下一页：加上 --cursor ${result.nextCursor} 再运行一次。`);
  print(io, rows, result);
}

export async function runFeishuGroupIdentity(chatId: string, options: {bot?: string}, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  if (!groupIdSchema.safeParse(chatId).success) throw badArgs('群 id 应该以 oc_ 开头。');
  const result = await daemon(async call => {
    const bot = pickBot((await call('读取快照', client => client.snapshot())).agents, options.bot);
    return want('读取群名', await call('读取群名', client => client.run({type: 'readGroupIdentity', agentId: bot.id, groupId: groupIdSchema.parse(chatId)}), {feishu: true}), 'groupIdentity');
  });
  print(io, [`${result.name}  ${result.groupId}  ${result.agentId}`], result);
}

/** A `--filter`-like value: the shape is the tool's to check, the syntax is this command's. */
export function jsonArgument(flag: string, text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { throw badArgs(`${flag} 要写 JSON。`); }
}

interface Row { id: string; time: string; sender: string; text: string }
/** What the tools answer, as lines. Whatever has no shape of its own here reads as its JSON; `--json` always does. */
function readLines(result: Record<string, unknown>): string[] {
  const { members, messages, message, forwarded, text, path } = result as { members?: { openId: string; name: string }[]; messages?: Row[]; message?: Row; forwarded?: Row[]; text?: string; path?: string };
  const shown = (row: Row): string[] => [`${row.time}  ${row.sender}  ${row.id}`, ...row.text.split('\n')];
  if (members) return members.map(member => `${member.name}  ${member.openId}`);
  if (messages) return messages.flatMap(shown);
  if (message) return [...shown(message), ...(forwarded ?? []).flatMap(shown)];
  if (typeof text === 'string') return text.split('\n');
  if (typeof path === 'string') return [path];
  return JSON.stringify(result, null, 2).split('\n');
}

/**
 * `vonvon feishu <read>` (dm-agent 7.3): a tool's read, its arguments as the tool takes them. Without --bot a session is
 * the daemon's to place, and a terminal asking about a group the bound Bot's; only then is there no single Bot to pick.
 */
export async function runFeishuRead(tool: string, given: Record<string, unknown>, options: { bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const args = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined));
  if (args.chat !== undefined && !groupIdSchema.safeParse(args.chat).success) throw badArgs('群 id 应该以 oc_ 开头。用 vonvon feishu groups 查。');
  const result = await daemon(async call => {
    const { agents } = await call('读取快照', c => c.snapshot());
    const picked = options.bot !== undefined || agents.length === 1 || !(cliInSession() || args.chat !== undefined);
    const agentId = picked ? pickBot(agents, options.bot).id : undefined;
    return want('读飞书', await call('读飞书', c => c.run({ type: 'feishuRead', ...(agentId ? { agentId } : {}), tool, args }), { feishu: true }), 'feishuRead').result;
  });
  const value = (result ?? {}) as Record<string, unknown>;
  const rows = readLines(value);
  const next = value.nextCursor ?? value.cursor;
  if (!rows.length) rows.push('这一页是空的。');
  if (typeof next === 'string') rows.push(`还有下一页：加上 --cursor ${next} 再运行一次。`);
  print(io, rows, value);
}
