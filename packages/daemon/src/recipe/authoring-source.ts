import { randomUUID } from 'node:crypto';
import { groupIdSchema, type RecipeAuthoringReply } from '@vonvon/protocol';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { withRegisteredBot, type BotIdentity } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { createGroupExecutor } from '../admin/groups';
import { supplementOf } from '../bot/context-assembly';
import { mutateProjectStore } from '../project/registry';
import { blankPublic, digest, freezePayload } from './authoring-wire';
import { physicalChat } from './authoring-im';

export async function reviewSource(channel: LarkChannel, bot: BotIdentity, scope: string, account: string, groupId: string): Promise<Extract<RecipeAuthoringReply,{kind:'source'}>> {
  if (!physicalChat(groupId)) throw new Error('请选择已绑定的群。');
  await createGroupExecutor(channel, bot)({kind:'groupMembership', chatId: groupId, identity: bot});
  return withRegisteredBot(bot.appId, () => mutateProjectStore({file: botPaths(bot.appId).projectsFile, dataRoot: paths.appDir}, async (_store, rows) => {
    const row = rows.find(p => !p.dm && p.chatId === groupId);
    if (!row) throw new Error('所选群已解绑。');
    const source = row.recipeInstall;
    if (source && (!['direct','coded'].includes(source.access) || !source.authorId || !source.versionId ||
      (source.access === 'coded' && source.authorId !== account))) throw new Error('这个群含无法导出的受限配方。');
    const role = supplementOf(row);
    freezePayload({public: blankPublic(), config: {role}});
    const backfill = row.bindingIncarnation === undefined || row.projectSettingsRevision === undefined;
    row.bindingIncarnation ??= randomUUID();
    row.projectSettingsRevision ??= 0;
    const reviewToken = digest(JSON.stringify([scope, account, groupId, row.bindingIncarnation, row.projectSettingsRevision, role,
      source ? [source.access, source.authorId, source.recipeId, source.versionId, source.manifestSha256] : null]));
    return {changed: backfill, durableRead: true, value: {kind: 'source', groupId: groupIdSchema.parse(groupId), reviewToken, role, untracked: !source}};
  }), bot);
}
