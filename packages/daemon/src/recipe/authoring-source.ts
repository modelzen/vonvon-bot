import { randomUUID } from 'node:crypto';
import { groupIdSchema, type RecipeAuthoringReply } from '@vonvon/protocol';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { withRegisteredBot, type BotIdentity } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { createGroupExecutor } from '../admin/groups';
import { supplementOf } from '../bot/context-assembly';
import { mutateProjectStore, type Project } from '../project/registry';
import { blankPublic, digest, freezePayload } from './authoring-wire';
import { physicalChat } from './authoring-im';

export function exportableRecipeGroup(row:Project, account:string):boolean {
  return !row.dm && physicalChat(row.chatId) && [row.recipeInstall,row.richRecipe?.pointer.release].every(source=>
    !source || Boolean(source.versionId && source.authorId && (source.access==='direct'||source.access==='coded'&&source.authorId===account)));
}

export async function atSource<T>(channel: LarkChannel, bot: BotIdentity, groupId: string, read: (row: Project) => T) {
  if (!physicalChat(groupId)) throw new Error('请选择已绑定的群。');
  await createGroupExecutor(channel, bot)({kind:'groupMembership', chatId: groupId, identity: bot});
  return withRegisteredBot(bot.appId, () => mutateProjectStore({file: botPaths(bot.appId).projectsFile, dataRoot: paths.appDir}, async (_store, rows) => {
    const row = rows.find(p => !p.dm && p.chatId === groupId);
    if (!row) throw new Error('所选群已解绑。');
    const changed = row.bindingIncarnation === undefined || row.projectSettingsRevision === undefined;
    row.bindingIncarnation ??= randomUUID();
    row.projectSettingsRevision ??= 0;
    return {changed, durableRead: true, value: read(row)};
  }), bot);
}

export const sourceIdentityOf = (scope: string, row: Project) => digest(JSON.stringify([scope, row.chatId, row.bindingIncarnation]));
export function groupSourceIdentity(channel: LarkChannel, bot: BotIdentity, scope: string, groupId: string) {
  return atSource(channel, bot, groupId, row => sourceIdentityOf(scope, row));
}

export type ReviewedSource = Extract<RecipeAuthoringReply, {kind:'source'}> & {identity: string};
export function reviewSource(channel: LarkChannel, bot: BotIdentity, scope: string, account: string, groupId: string): Promise<ReviewedSource> {
  return atSource(channel, bot, groupId, row => {
    const source = row.recipeInstall;
    if (source && (!['direct','coded'].includes(source.access) || !source.authorId || !source.versionId ||
      (source.access === 'coded' && source.authorId !== account))) throw new Error('这个群含无法导出的受限配方。');
    const role = supplementOf(row);
    freezePayload({public: blankPublic(), config: {role}});
    const reviewToken = digest(JSON.stringify([scope, account, groupId, row.bindingIncarnation, row.projectSettingsRevision, role,
      source ? [source.access, source.authorId, source.recipeId, source.versionId, source.manifestSha256] : null]));
    return {kind: 'source', groupId: groupIdSchema.parse(groupId), reviewToken, role, untracked: !source, identity: sourceIdentityOf(scope, row)};
  });
}
