import {expect,it,vi} from 'vitest';
import {createAgentEntries,type TurnFacts} from '../src/agent/entry/registry';
import {resourceTools} from '../src/agent/entry/resource-tools';
import {recipeCreationTools} from '../src/agent/entry/recipe-creation-tools';
import type {AgentThread} from '../src/agent/types';

const human:TurnFacts={requesterOpenId:'ou_owner',requesterKind:'user',triggerMessageId:'om_trigger',retry:false,initiative:false,wake:false};
it.each([{retry:true},{initiative:true},{wake:true},{scheduled:{taskId:'one',runId:'two'}},{requesterKind:'bot' as const},{requesterOpenId:'ou_other'}])(
  'rejects a synthetic or non-admin resource action before the broker sees it (%j)',async additions=>{
    const broker=vi.fn(async()=>({status:'unavailable'}));
    const entries=createAgentEntries({appId:'cli_bot',isAdmin:id=>id==='ou_owner',tools:[...resourceTools(broker),...recipeCreationTools(broker)]});
    const entry=entries.issue({kind:'p2p',chatId:'oc_p2p'}),thread={sessionId:'provider',isAlive:()=>true} as AgentThread;
    entry.attach(thread);
    const turn=entries.openTurn(thread,{...human,...additions});entry.noteToolUse('turn');
    expect(await entry.call('recipe_resource_read',{kind:'index'},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_resource_acquire',{versionId:'71111111-1111-4111-8111-111111111111'},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_resource_prepare',{groupId:'oc_group'},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_author_sources',{},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_author_material',{action:'create',proposalId:'71111111-1111-4111-8111-111111111111'},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_author_create',{groupId:'oc_group',public:{name:'周报',summary:'',overview:'',version:''}},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(await entry.call('recipe_author_status',{},{toolUseId:'turn'})).toMatchObject({ok:false});
    expect(broker).not.toHaveBeenCalled();turn.close();entries.closeAll('shutdown');
  });
it('rejects forged identity arguments, stale provider tool origins and different-user steering',async()=>{
  const broker=vi.fn(async()=>({status:'unavailable'}));
  const entries=createAgentEntries({appId:'cli_bot',isAdmin:()=>true,tools:resourceTools(broker)});
  const entry=entries.issue({kind:'p2p',chatId:'oc_p2p'}),thread={sessionId:'provider',isAlive:()=>true} as AgentThread;
  entry.attach(thread);entries.openTurn(thread,human);entry.noteToolUse('first');
  expect(await entry.call('recipe_resource_read',{kind:'index',openId:'ou_owner'},{toolUseId:'first'})).toMatchObject({ok:false,code:'bad-args'});
  entries.noteSteer(thread,{kind:'user',openId:'ou_other'});
  expect(await entry.call('recipe_resource_read',{kind:'index'},{toolUseId:'first'})).toMatchObject({ok:false});
  entries.openTurn(thread,{...human,triggerMessageId:'om_next'});
  expect(await entry.call('recipe_resource_read',{kind:'index'},{toolUseId:'first'})).toMatchObject({ok:false});
  expect(broker).not.toHaveBeenCalled();entries.closeAll('shutdown');
});

it('keeps preparation inside the current human tool deadline without changing public arguments',async()=>{
  const broker=vi.fn<Parameters<typeof resourceTools>[0]>(async()=>({status:'ready'}));
  const entries=createAgentEntries({appId:'cli_bot',isAdmin:()=>true,tools:resourceTools(broker)});
  const entry=entries.issue({kind:'p2p',chatId:'oc_p2p'}),thread={sessionId:'provider',isAlive:()=>true} as AgentThread;
  entry.attach(thread);const turn=entries.openTurn(thread,human);entry.noteToolUse('prepare-turn');
  const before=Date.now();
  expect(await entry.call('recipe_resource_prepare',{groupId:'oc_group'},{toolUseId:'prepare-turn'})).toMatchObject({ok:true,result:{status:'ready'}});
  const [get,query]=broker.mock.calls[0]!;
  expect(get()).toMatchObject({messageId:human.triggerMessageId,openId:human.requesterOpenId,chatId:'oc_p2p'});
  expect(query).toMatchObject({kind:'prepare',groupId:'oc_group',wait:{signal:expect.any(AbortSignal)}});
  if(query.kind!=='prepare'||!query.wait)throw new Error('Expected a bounded preparation');
  expect(query.wait.notAfter).toBeGreaterThan(before);
  expect(query.wait.notAfter).toBeLessThanOrEqual(before+69_000);
  turn.close();entries.closeAll('shutdown');
});
