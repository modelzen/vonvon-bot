import {expect,it,vi} from 'vitest';
import type {Membership} from '@vonvon/protocol';
import type {SessionRecord} from '../src/bot/session-store';
import {readRecentConversations} from '../src/server/recent-conversations';

it('shows only current bound group conversations and reports unreadable Bots independently',async()=>{
  const member=(agentId:string,groupId:string)=>({agentId,groupId,directory:'/work',stale:false}) as Membership;
  const session=(threadId:string,chatId='oc_a',other:Partial<SessionRecord>={})=>({threadId,chatId,cwd:'/work',sessionId:threadId,backend:'codex-appserver',summary:'User question',createdAt:1,updatedAt:1,...other}) satisfies SessionRecord;
  const read=vi.fn(async(file:string)=>{
    if(file.includes('cli_failed')) throw new Error('corrupt');
    return [session('omt_old'),session('omt_latest','oc_a',{updatedAt:4}),session('omt_gone','oc_unbound'),session('omt_moved','oc_a',{cwd:'/old'}),session('omt_detached','oc_a',{detached:true})];
  });
  const view=await readRecentConversations('/test-data',[member('cli_ok','oc_a'),member('cli_ok','oc_b'),member('cli_failed','oc_c')],read);
  expect(view.items.map(item=>item.threadId)).toEqual(['omt_latest','omt_old']);
  expect(view.unavailableBots).toBe(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledWith('/test-data/bots/cli_ok/sessions.json');
});
