import {join} from 'node:path';
import type {DesktopSnapshot, Membership} from '@vonvon/protocol';
import {isRetiredKey,listSessionsIn,type SessionRecord} from '../bot/session-store';

/** Read local, still-bound conversations only. No provider history fetch or Feishu request. */
export async function readRecentConversations(root:string,memberships:Membership[],read:(file:string)=>Promise<SessionRecord[]>=listSessionsIn):Promise<NonNullable<DesktopSnapshot['recentConversations']>> {
  const items:NonNullable<DesktopSnapshot['recentConversations']>['items']=[];
  let unavailableBots=0;
  for (const botId of new Set(memberships.filter(item=>!item.stale).map(item=>item.agentId))) {
    const groups=new Map(memberships.filter(item=>item.agentId===botId && !item.stale).map(item=>[item.groupId,item]));
    try {
      for (const session of await read(join(root,'bots',botId,'sessions.json'))) {
        const group=groups.get(session.chatId as Membership['groupId']);
        if (!group || session.detached || isRetiredKey(session.threadId) || session.cwd!==group.directory) continue;
        items.push({agentId:botId,groupId:group.groupId,threadId:session.threadId,summary:session.summary.replace(/[\x00-\x1f]/g,' ').slice(0,180),updatedAt:session.updatedAt});
      }
    } catch {unavailableBots++;}
  }
  items.sort((a,b)=>b.updatedAt-a.updatedAt);
  return {items:items.slice(0,8),unavailableBots};
}
