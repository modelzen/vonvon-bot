import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {recipeAuthoringRequestSchema as request, recipeAuthoringReplySchema as reply} from '../src/index.js';

const id = randomUUID(), hash = 'a'.repeat(64), botId = 'cli_bot';
it('uses separate discovery and binding-checked activation on owner authoring RPC', () => {
  expect(request.safeParse({type:'creatorDiscover',botId,accountId:id}).success).toBe(true);
  expect(request.safeParse({type:'creatorOpen',botId,accountId:id,binding:id,scope:hash,wakeId:null}).success).toBe(true);
  expect(request.safeParse({type:'creatorOpen',botId,accountId:id,wakeId:null}).success).toBe(false);
  expect(reply.safeParse({kind:'session',session:id,linked:true,leaseMs:45000,binding:id}).success).toBe(false);
});
it('keeps plaintext out of journalable replies and arbitrary requests out of the native job', () => {
  const base = {type:'creatorAnswer',botId,session:id,id};
  const target = {recipeId:id,versionId:id};
  expect(request.safeParse({...base,answer:{kind:'issued',target,codeIds:[id]}}).success).toBe(true);
  expect(request.safeParse({...base,answer:{kind:'issued',target,codeIds:[id],code:'a'.repeat(32)}}).success).toBe(false);
  expect(reply.safeParse({kind:'creatorJobs',jobs:[{id,binding:id,scope:hash,task:{kind:'command',command:{kind:'POST',path:'/anything'},approval:hash,expiresAt:1}}]}).success).toBe(false);
});
