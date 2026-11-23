import {randomUUID} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentIdSchema,canonicalizeRichRecipeContent,decodeRichRecipeContent,groupIdSchema,recipeAuthoringRequestSchema} from '@vonvon/protocol';
import {expect,it,vi} from 'vitest';
import {PrivateHandoffs} from '../src/recipe/authoring-handoff';
import {AuthoringJournal,type Link} from '../src/recipe/authoring-journal';
import {emptySelection,handoffCard,type PrivateHandoff} from '../src/recipe/authoring-handoff-menu';
import type {AuthoringIm} from '../src/recipe/authoring-im';
import type {RichNativeOptions} from '../src/recipe/authoring-rich-flow';
import {typedRichEdit,richCardReview} from '../src/recipe/authoring-rich-flow';
import {candidateConfirmation} from '../src/recipe/authoring-im';
import {assemble,openingInstructions,type ContextSources} from '../src/bot/context-assembly';
import {parseRole} from '../src/bot/role-files';

vi.mock('../src/recipe/authoring-source',async(original)=>({
  ...await original(),groupSourceIdentity:async()=> 'verified-original-group',
}));

const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const field=(value:string)=>({...identity(),value});
const secret='HISTORICAL_PRIVATE_MEMORY_4812';

async function fixture(){
  const item={...identity(),text:{kind:'inline' as const,value:secret}};
  const canonical=Buffer.from(canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,
    public:{name:field('配方'),overview:field(''),summary:field(''),version:field('1')},
    rules:[],skills:[],files:[],tasks:[],settings:[],setup:[],parts:[],memories:[item]}).canonicalUTF8).toString('base64url');
  const now=1730000000000,account=randomUUID(),groupId=groupIdSchema.parse('oc_review'),retryId=randomUUID(),draftId=randomUUID();
  const recipient={chatId:'oc_review_private',tenantKey:'t_review',openId:'ou_review'};
  const link:Link={recipient,binding:'review-binding',bot:'cli_review',sources:[]};
  const old:PrivateHandoff={edit:{draftId,baseRevision:1,canonical,source:{sourceIntentId:randomUUID(),canonical}},groupName:'Review',draftId,baseRevision:1,
    retryId,groupId,account,scope:'review-scope',identity:'verified-original-group',recipient,binding:link.binding,session:randomUUID(),
    phase:{state:'selecting'},expiresAt:now+60000,ref:randomUUID(),generation:1,cardId:'historical_card',sendUuid:randomUUID(),
    sentAt:now-2000,selection:{...emptySelection(),choices:[{id:item.itemId,action:'item',label:'记忆 · '+secret,checked:false}],count:1}};
  const ledger=new AuthoringJournal(await mkdtemp(join(tmpdir(),'recipe-handoff-policy-')),()=>now);
  const edit=structuredClone(old.edit!);
  await ledger.run(db=>{db.handoffs={[retryId]:old};db.links.one=link;});
  const presence={session:randomUUID(),scope:old.scope,account};
  let remote=JSON.stringify(handoffCard(old));
  const sent:Array<{cardId:string;uuid:string;body:string}>=[];
  const im={
    updateJson:vi.fn(async(_card:string,_seq:number,_ref:string,body:object)=>{remote=JSON.stringify(body);return 'updated';}),
    send:vi.fn(async(_chat:string,cardId:string,uuid:string)=>{sent.push({cardId,uuid,body:remote});return 'om_review';}),
    showsJson:vi.fn(async()=>false),
  };
  const service=new PrivateHandoffs({bot:{},channel:{}} as unknown as RichNativeOptions,ledger,im as unknown as AuthoringIm,()=>now,()=>{});
  const request=recipeAuthoringRequestSchema.parse({type:'restoreHandoff',botId:link.bot,session:presence.session,
    retryId,expected:{kind:'draft',baseRevision:1,draftId,groupId}});
  if(request.type!=='restoreHandoff')throw Error('expected restore request');
  const restore=()=>service.restore(presence,link,request);
  return {restore,sent,ledger,old,edit,im,remote:()=>remote};
}

it.each([false,true])('never resends historical memory, including a delivered send whose reply is lost (%s)',async(lost)=>{
  const f=await fixture();
  expect(f.remote()).toContain(secret);
  if(lost){const send=f.im.send.getMockImplementation()!;f.im.send.mockImplementation(async(...args)=>{await send(...args);throw Error('response lost');});}
  const result=await f.restore();
  expect(result).toMatchObject({kind:'handoff',handoff:{state:lost?'deliveryUnknown':'selecting'}});
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({cardId:f.old.cardId,uuid:f.old.sendUuid});
  expect(f.sent[0]!.body).not.toContain(secret);
  expect(f.sent[0]!.body).not.toContain(f.old.ref);
  expect(f.remote()).not.toContain(secret);
});

it('retries an applied update whose response was lost with a higher sequence before resending the same card',async()=>{
  const f=await fixture(),update=f.im.updateJson.getMockImplementation()!;
  f.im.updateJson.mockImplementationOnce(async(...args)=>{await update(...args);return 'pending';});
  await f.restore().catch(()=>undefined);
  expect(f.sent).toEqual([]);
  expect(f.remote()).not.toContain(secret);
  const sequence=f.im.updateJson.mock.calls[0]![1];
  await f.restore();
  expect(f.im.updateJson.mock.calls[1]![1]).toBeGreaterThan(sequence);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({cardId:f.old.cardId,uuid:f.old.sendUuid});
  expect(f.sent[0]!.body).not.toContain(secret);
});

it('does not send when persistence after the clean entity update fails',async()=>{
  const f=await fixture(),atomic=await import('../src/server/atomic-file'),write=atomic.writeFileAtomic;
  const failure=vi.spyOn(atomic,'writeFileAtomic').mockImplementation(async(...args)=>{
    if(f.im.updateJson.mock.calls.length)throw Error('durable write failed');
    return write(...args);
  });
  try{await expect(f.restore()).rejects.toThrow('durable write failed');}finally{failure.mockRestore();}
  expect(f.im.updateJson).toHaveBeenCalled();
  expect(f.sent).toEqual([]);
});

it.each(['pending','conflict','unavailable'])('does not resend an old entity when its clean update is unverified (%s)',async(outcome)=>{
  const f=await fixture();
  f.im.updateJson.mockImplementation(async()=>outcome);
  await f.restore().catch(()=>undefined);
  expect(f.im.updateJson).toHaveBeenCalled();
  expect(f.sent).toEqual([]);
  const retained=await f.ledger.run(db=>db.handoffs![f.old.retryId]!);
  expect(retained.cardId).toBe(f.old.cardId);
  expect(retained.sendUuid).toBe(f.old.sendUuid);
  expect(retained.messageId).toBeUndefined();
  expect(JSON.stringify(retained.selection)).not.toContain(secret);
});

it('describes the surviving recipe context as work rules in the provider prompt',()=>{
  const source:ContextSources={place:{kind:'group',chatId:'oc_review',chatName:'Review'},botName:'probe',soul:'',
    role:parseRole(''),supplement:'',failed:{},recipeContext:'ORDERED_WORK_RULE'};
  const prompt=openingInstructions(assemble(source),'fixture');
  expect(prompt).toContain('[本群配方 · 工作规则]');
  expect(prompt).toContain('ORDERED_WORK_RULE');
  expect(prompt).not.toContain('选中的记忆');
});

it('keeps fifteen ordinary edits and legacy cleanup reviewable in the same private confirmation',async()=>{
  const f=await fixture(),edit=f.edit;
  const content=decodeRichRecipeContent(Buffer.from(edit.canonical,'base64url')).content,itemId=content.public.name.itemId;
  const changes=Array.from({length:15},(_,i)=>({op:'setPublicText' as const,field:'name' as const,itemId,value:'name '+i}));
  const rich=typedRichEdit({type:'richEdit',botId:agentIdSchema.parse('cli_review'),session:randomUUID(),...edit,selected:[itemId],changes});
  const details=richCardReview({view:{operationId:randomUUID(),draftId:edit.draftId,baseRevision:1},rich});
  const confirmation=JSON.stringify(candidateConfirmation(randomUUID(),details));
  expect(confirmation).toContain('保存到草稿');
  expect(confirmation).toContain('name 14');
  expect(confirmation).not.toContain(secret);
  expect(rich.request&&'payload'in rich.request&&rich.request.payload.changes).toHaveLength(16);
});

it('rejects all sixteen ordinary edits plus cleanup before the private journal changes',async()=>{
  const f=await fixture(),edit=f.edit,before=await f.ledger.run(db=>db);
  const itemId=decodeRichRecipeContent(Buffer.from(edit.canonical,'base64url')).content.public.name.itemId;
  const changes=Array.from({length:16},(_,i)=>({op:'setPublicText' as const,field:'name' as const,itemId,value:'name '+i}));
  expect(()=>typedRichEdit({type:'richEdit',botId:agentIdSchema.parse('cli_review'),session:randomUUID(),...edit,selected:[itemId],changes})).toThrow('请先单独确认排除');
  expect(await f.ledger.run(db=>db)).toEqual(before);
});
