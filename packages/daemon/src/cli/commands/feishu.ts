import { groupIdSchema } from '@vonvon/protocol';
import { feishuGroups, feishuMembers } from '../../admin/structured-commands';
import { CommandError } from '../command-error';
import { pickBot, print, want, withDaemon, type Daemon, type Io } from '../daemon-client';

export async function runFeishu(kind: 'groups' | 'members', rawGroup: string | undefined, options: { bot?: string; cursor?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const chat = kind === 'members' ? groupIdSchema.parse(rawGroup) : undefined;
  const result = await daemon(async call => {
    const bot = pickBot((await call('读取快照', c => c.snapshot())).agents, options.bot);
    if (kind === 'groups') return feishuGroups({ groups: async cursor => {
      const result = want('查群列表', await call('查群列表', c => c.run({ type: 'listJoinedGroups', agentId: bot.id, ...(cursor ? { cursor } : {}) }), { feishu: true }), 'groups');
      return { groups: result.groups.map(({ id, ...group }) => ({ ...group, chatId: id })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    } }, options.cursor);
    if (!chat) throw new CommandError('bad-args', '需要群 id');
    return feishuMembers({ members: async (chatId, cursor) => {
      const { members, nextCursor } = want('查群成员', await call('查群成员', c => c.run({ type: 'listGroupMembers', agentId: bot.id, groupId: groupIdSchema.parse(chatId), ...(cursor ? { cursor } : {}) }), { feishu: true }), 'members');
      return { members, ...(nextCursor ? { nextCursor } : {}) };
    } }, chat, options.cursor);
  });
  print(io, [JSON.stringify(result)], result);
}
