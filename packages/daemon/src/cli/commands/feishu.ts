import { groupIdSchema } from '@vonvon/protocol';
import { feishuGroups, feishuMembers } from '../../admin/structured-commands';
import { badArgs } from '../command-error';
import { pickBot, print, want, withDaemon, type Daemon, type Io } from '../daemon-client';

export async function runFeishu(kind: 'groups' | 'members', rawGroup: string | undefined, options: { bot?: string; cursor?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const parsed = kind === 'members' ? groupIdSchema.safeParse(rawGroup) : undefined;
  if (parsed && !parsed.success) throw badArgs('群 id 应该以 oc_ 开头。用 vonvon feishu groups 查。');
  const chat = parsed?.data;
  const result = await daemon(async call => {
    const bot = pickBot((await call('读取快照', c => c.snapshot())).agents, options.bot);
    if (!chat) return feishuGroups({ groups: async cursor => {
      const result = want('查群列表', await call('查群列表', c => c.run({ type: 'listJoinedGroups', agentId: bot.id, ...(cursor ? { cursor } : {}) }), { feishu: true }), 'groups');
      return { groups: result.groups.map(({ id, ...group }) => ({ ...group, chatId: id })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    } }, options.cursor);
    return feishuMembers({ members: async (chatId, cursor) => {
      const { members, nextCursor } = want('查群成员', await call('查群成员', c => c.run({ type: 'listGroupMembers', agentId: bot.id, groupId: chat, ...(cursor ? { cursor } : {}) }), { feishu: true }), 'members');
      return { members, ...(nextCursor ? { nextCursor } : {}) };
    } }, chat, options.cursor);
  });
  const rows = 'groups' in result
    ? result.groups.map(group => `${group.name}  ${group.chatId}${group.bound ? '  已绑定' : ''}`)
    : result.members.map(member => `${member.name}  ${member.openId}`);
  if (!rows.length) rows.push('这一页是空的。');
  if (result.nextCursor) rows.push(`还有下一页：加上 --cursor ${result.nextCursor} 再运行一次。`);
  print(io, rows, result);
}
