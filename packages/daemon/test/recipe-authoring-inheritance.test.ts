import {createHash,randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,type InheritedPublication,type RecipeRichContent} from '@vonvon/protocol';
const state=vi.hoisted(()=>({inventory:undefined as unknown}));
vi.mock('../src/recipe/authoring-source',()=>({groupSourceIdentity:vi.fn(async()=> 'identity')}));
vi.mock('../src/recipe/authoring-rich-flow',async load=>({...await load<object>(),readRichSource:async()=>state.inventory}));
import {PrivateHandoffs} from '../src/recipe/authoring-handoff';
import {bindRichMembers,chatRichProposal,richCardReview,type RichLocalDraft} from '../src/recipe/authoring-rich-flow';
import {AuthoringJournal,linkKey,maintain,newCarrier,type AuthoringLedger,type Link} from '../src/recipe/authoring-journal';
import {groupSourceIdentity} from '../src/recipe/authoring-source';
import type {PrivateHandoff} from '../src/recipe/authoring-handoff-menu';
import {candidateConfirmation,type AuthoringIm} from '../src/recipe/authoring-im';
import type {LocalOperation} from '../src/recipe/authoring-journal';
function fixture(inherit=true,now=()=>1000){
 const account=randomUUID(),versionId=randomUUID(),retryId=randomUUID(),groupId=groupIdSchema.parse('oc_inherit');
 const field=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
 const content:RecipeRichContent={format:'rich-v2',schemaVersion:2,public:{name:field(''),summary:field(''),overview:field(''),version:field('')},
   role:{itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'UNSELECTED ROLE'}},settings:[],skills:[],files:[],tasks:[],memories:[],rules:[],setup:[],parts:[]};
 state.inventory={lease:'a'.repeat(64),content,evidence:new Map(Object.values(content.public).map(item=>[item.itemId,{kind:'native'}]))};
 const logo=Buffer.from('524946460e000000574542505650384c020000002f00','hex').toString('base64url');
 const inherited:InheritedPublication={accountId:account,versionId,public:{name:'本人名称',summary:'本人摘要',overview:'完整介绍',version:''},access:'coded',logo};
 const recipient={openId:'ou_test',chatId:groupId,tenantKey:'tenant'},link:Link={bot:'cli_inherit',binding:'binding',recipient,sources:[]};
 const db={version:1 as const,handoffs:{} as Record<string,PrivateHandoff>,links:{[linkKey('scope',account)]:link},operations:{} as Record<string,LocalOperation>,daily:{}} satisfies AuthoringLedger;
 class MemoryJournal extends AuthoringJournal {
  override async run<T>(edit:(value:AuthoringLedger)=>T):Promise<T>{maintain(db,now());return structuredClone(edit(db));}
 }
 const ledger=new MemoryJournal('',now);
 const createJson=vi.fn(async()=> 'card'),send=vi.fn(async()=> 'message');
 const im={createJson,send,updateJson:async()=> 'updated'} as unknown as AuthoringIm;
 const native={bot:{appId:'cli_inherit'},channel:{}} as ConstructorParameters<typeof PrivateHandoffs>[0];
 const handoffs=new PrivateHandoffs(native,ledger,im,now,()=>{}),p={session:randomUUID(),account,scope:'scope'};
 const req={type:'beginHandoff' as const,botId:agentIdSchema.parse('cli_inherit'),session:p.session,retryId,groupId,groupName:'群',...(inherit&&{sourceVersionId:versionId,inherited})};
 return {handoffs,p,link,db,req,inherited,logo,retryId,createJson,send};
}
it('returns unavailable when maintenance prunes the exact prepared operation during restore identity verification',async()=>{
 let clock=1000;
 const f=fixture(false,()=>clock);await f.handoffs.begin(f.p,f.link,f.req);
 const row=f.db.handoffs[f.retryId]!,operationId=randomUUID(),terminalAt=clock+60_000;
 row.phase={state:'prepared',operationId};
 f.db.operations[operationId]={accountId:f.p.account,scope:f.p.scope,bot:f.link.bot,binding:f.link.binding,recipient:f.link.recipient,
  carrier:newCarrier('saved'),dispatched:true,instructionId:f.retryId,originalGroup:{groupId:f.req.groupId,identity:row.identity},terminalAt,
  view:{operationId,format:'rich-v2',purpose:'prepareDraft',groupId:f.req.groupId,targetPublicKey:'a'.repeat(43),nonceCommitment:'b'.repeat(43),
   state:'completed',deliveryUnknown:false,createdAt:clock,receipt:{operationId,status:'accepted',stateRevision:3,draftId:randomUUID(),revision:1}}};
 clock=terminalAt+7*86_400_000-1;
 vi.mocked(groupSourceIdentity).mockImplementationOnce(async()=>{clock+=2;return row.identity;});
 const restore=()=>f.handoffs.restore(f.p,f.link,{type:'restoreHandoff',botId:f.req.botId,session:f.p.session,retryId:f.retryId,expected:{kind:'source',groupId:f.req.groupId}});
 const first=await restore();
 expect(f.db.operations[operationId]).toBeUndefined();expect(f.db.handoffs[f.retryId]).toBeDefined();
 expect(first).toEqual({kind:'handoffUnavailable',retryId:f.retryId,reason:'notFound'});
 expect(await restore()).toEqual({kind:'handoffUnavailable',retryId:f.retryId,reason:'notFound'});
 expect(Object.keys(f.db.operations)).toEqual([]);expect(Object.keys(f.db.handoffs)).toEqual([f.retryId]);
 expect(f.createJson).toHaveBeenCalledTimes(1);expect(f.send).toHaveBeenCalledTimes(1);
});
it('captures inherited snapshot at begin and carries identical metadata, access, parent and uploaded logo through review',async()=>{
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);
 let row=f.db.handoffs[f.retryId]!;
 expect(row.inherited).toEqual(f.inherited);
 const resumed={...f.p,session:randomUUID()};await f.handoffs.begin(resumed,f.link,f.req);f.p.session=resumed.session;row=f.db.handoffs[f.retryId]!;
 expect(row.inherited).toEqual(f.inherited);
 const request={retryId:f.retryId,ref:row.ref,generation:row.generation,lease:'a'.repeat(64),versions:[]};row.phase={state:'awaitingAttestations',request};
 let rich:RichLocalDraft|undefined;
 await f.handoffs.answer(f.p,f.link,{type:'answerHandoff',botId:f.req.botId,session:f.p.session,request,attestations:[]},async target=>{
  rich=target.rich;
  return {kind:'operation',operation:{operationId:randomUUID(),purpose:'prepareDraft',targetPublicKey:'a'.repeat(43),nonceCommitment:'a'.repeat(43),state:'waiting',deliveryUnknown:false,createdAt:1000}};
 });
 const prepared=rich!;expect(prepared.request&&'content'in prepared.request&&prepared.request.sourceVersionId).toBe(f.inherited.versionId);
 if(!prepared.request||!('content'in prepared.request))throw Error('missing request');
 expect(Object.fromEntries(Object.entries(prepared.request.content.public).map(([k,v])=>[k,v.value]))).toEqual(f.inherited.public);
 expect(prepared.request.access).toBe('coded');expect(prepared.request.content.role).toBeUndefined();
 expect(prepared.members).toHaveLength(1);expect(prepared.members![0]!.bytes).toBe(f.logo);
 const member=prepared.members![0]!,bytes=Buffer.from(f.logo,'base64url'),packageId=randomUUID();
 const bound=bindRichMembers(prepared,[{objectId:randomUUID(),kind:'finalLogo',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'image/webp'}],packageId);
 expect(bound.logoUpload).toEqual({packageId,inputSha256:member.sha256});
 expect(richCardReview({view:{operationId:randomUUID()},rich:prepared})?.fields.some(field=>field.valueJson?.includes('本人名称'))).toBe(true);
 expect(JSON.stringify(prepared.request)).not.toContain('UNSELECTED ROLE');
});
it('keeps first creation blank and rejects account changes, snapshot drift and legacy missing snapshots',async()=>{
 const fresh=fixture(false);await fresh.handoffs.begin(fresh.p,fresh.link,fresh.req);expect(fresh.db.handoffs[fresh.retryId]!.inherited).toBeUndefined();
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);
 await expect(f.handoffs.begin({...f.p,account:randomUUID()},f.link,f.req)).rejects.toThrow('重新准备');
 await expect(f.handoffs.begin(f.p,f.link,{...f.req,inherited:{...f.inherited,public:{...f.inherited.public,name:'changed'}}})).rejects.toThrow('重新准备');
 delete f.db.handoffs[f.retryId]!.inherited;
 await expect(f.handoffs.begin(f.p,f.link,f.req)).rejects.toThrow('重新准备');
});
it('confirms a published long inherited overview without changing its full digest-bound value',async()=>{
 const f=fixture();f.inherited.public.overview='甲'.repeat(10500);
 await f.handoffs.begin(f.p,f.link,f.req);
 const row=f.db.handoffs[f.retryId]!;
 const request={retryId:f.retryId,ref:row.ref,generation:row.generation,lease:'a'.repeat(64),versions:[]};row.phase={state:'awaitingAttestations',request};
 let prepared:RichLocalDraft|undefined;
 await f.handoffs.answer(f.p,f.link,{type:'answerHandoff',botId:f.req.botId,session:f.p.session,request,attestations:[]},async target=>{
  prepared=target.rich;return {kind:'operation',operation:{operationId:randomUUID(),purpose:'prepareDraft',targetPublicKey:'a'.repeat(43),nonceCommitment:'a'.repeat(43),state:'waiting',deliveryUnknown:false,createdAt:1000}};
 });
 expect(prepared?.request&&'content'in prepared.request&&prepared.request.content.public.overview.value).toBe(f.inherited.public.overview);
 const review=richCardReview({view:{operationId:randomUUID()},rich:prepared});
 expect(JSON.stringify(review)).toContain('完整发布信息在 App 核对');expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThan(10000);
 const before=review?.payloadDigest;
 if(prepared?.request&&'content'in prepared.request)prepared.request.content.public.overview.value+='x';
 expect(richCardReview({view:{operationId:randomUUID()},rich:prepared})?.payloadDigest).not.toBe(before);
});
import {mkdtemp,readFile,writeFile,stat,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recipeAuthoringRequestSchema} from '@vonvon/protocol';
import {AuthoringJournal as RealJournal} from '../src/recipe/authoring-journal';
it('accepts published Unicode fields and enforces byte and scalar limits',()=>{
 const f=fixture();f.inherited.public.name='🧩'.repeat(60);f.inherited.public.summary='🧩'.repeat(240);
 expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(true);
 f.inherited.public.name+='x';expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(false);
 f.inherited.public.name='ok';f.inherited.public.overview='甲'.repeat(10923);expect(recipeAuthoringRequestSchema.safeParse(f.req).success).toBe(false);
});
it('keeps large repeated snapshots outside the journal and verifies recovery blobs',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'inherit-blob-')));const journal=new RealJournal(root,()=>1000);
 const f=fixture();await f.handoffs.begin(f.p,f.link,f.req);const row=f.db.handoffs[f.retryId]!;
 row.inherited!.logo=Buffer.alloc(131072,1).toString('base64url');row.inherited!.public.overview='甲'.repeat(10922);
 await journal.run(db=>{db.handoffs=Object.fromEntries(Array.from({length:100},()=>{const retryId=randomUUID();return [retryId,{...row,retryId}];}));});
 const file=join(root,'recipe-authoring/journal.json'),disk=JSON.parse(await readFile(file,'utf8'));
 expect((await stat(file)).size).toBeLessThan(200000);
 const entry=Object.values(disk.handoffs)[0] as {inheritedBlob:string};expect(entry.inheritedBlob).toMatch(/^[a-f0-9]{64}$/);
 await journal.run(db=>{expect(Object.values(db.handoffs!)[0]!.inherited).toEqual(row.inherited);});
 await writeFile(join(root,'recipe-authoring','rich-'+entry.inheritedBlob+'.json'),'{}');
 await expect(journal.run(db=>Object.values(db.handoffs!)[0]!.inherited)).rejects.toThrow('已变化');
 const expired=new RealJournal(root,()=>row.expiresAt+7*86400000+1);
 await expired.run(db=>{expect(Object.keys(db.handoffs!)).toHaveLength(0);});
 expect((await readdir(join(root,'recipe-authoring'))).filter(name=>name.startsWith('rich-'))).toEqual([]);
});

it.each([[true,false],[false,true],[true,true]])('keeps inherited Logo %s and long overview %s saveable after version chat edits',async(logo,long)=>{
 const f=fixture();if(!logo)delete f.inherited.logo;if(long)f.inherited.public.overview='甲'.repeat(10500);
 await f.handoffs.begin(f.p,f.link,f.req);
 const row=f.db.handoffs[f.retryId]!;
 const request={retryId:f.retryId,ref:row.ref,generation:row.generation,lease:'a'.repeat(64),versions:[]};row.phase={state:'awaitingAttestations',request};
 let rich:RichLocalDraft|undefined;
 await f.handoffs.answer(f.p,f.link,{type:'answerHandoff',botId:f.req.botId,session:f.p.session,request,attestations:[]},async target=>{
  rich=target.rich;return {kind:'operation',operation:{operationId:randomUUID(),purpose:'prepareDraft',targetPublicKey:'a'.repeat(43),nonceCommitment:'a'.repeat(43),state:'waiting',deliveryUnknown:false,createdAt:1000}};
 });
 const op={view:{operationId:randomUUID()},rich} as LocalOperation;
 const apply=async(instruction:string)=>{
  const result=await chatRichProposal(op,instruction,new AbortController().signal);
  if(result.kind!=='proposal'||!('newFields'in result))throw Error('missing proposal');
  Object.assign(op.rich!,result);
 };
 await apply('/recipe version 2.0');
 const details=richCardReview(op),card=candidateConfirmation('ref',details);
 expect(card).toBeDefined();expect(JSON.stringify(card)).toContain('保存到草稿');expect(JSON.stringify(card)).toContain('2.0');
 expect(details?.sourceCapture).toBe(true);expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(10000);
 expect(rich?.request&&'content'in rich.request&&rich.request.content.public.overview.value).toBe(f.inherited.public.overview);
 for(const key of ['privateSelection','source','newFields','sourceCaptureDigest'] as const){
  const missing=structuredClone(op.rich!);delete missing[key];
  expect(richCardReview({...op,rich:missing})).toBeUndefined();
 }
 const unknown=structuredClone(op.rich!);
 if(!unknown.request||!('content'in unknown.request))throw Error('missing content');
 Object.assign(unknown.request.content.public.version,{unknown:true});
 expect(richCardReview({...op,rich:unknown})).toBeUndefined();
 const extraLogo=structuredClone(op.rich!);
 extraLogo.members=[...(extraLogo.members??[]),{itemId:randomUUID(),kind:'finalLogo',bytes:f.logo,sha256:createHash('sha256').update(Buffer.from(f.logo,'base64url')).digest('hex')}];
 expect(richCardReview({...op,rich:extraLogo})).toBeUndefined();
 const digest=details?.payloadDigest;
 await apply('/recipe version 3.0');expect(richCardReview(op)?.payloadDigest).not.toBe(digest);
 expect(candidateConfirmation('ref',richCardReview(op))).toBeDefined();
 await apply('/recipe overview 这里是本次完整的新概览');
 expect(JSON.stringify(candidateConfirmation('ref',richCardReview(op)))).toContain('这里是本次完整的新概览');
 const edited=structuredClone(rich!);
 if(!rich?.request||!('content'in rich.request))throw Error('missing content');
 rich.request.content.role={itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'HIDDEN'}};
 expect(richCardReview(op)).toBeUndefined();
 if(logo){
  op.rich=structuredClone(edited);op.rich.members![0]!.bytes=Buffer.from('replacement').toString('base64url');
  expect(richCardReview(op)).toBeUndefined();
 }
 op.rich=structuredClone(edited);op.rich.newFields=[];expect(richCardReview(op)).toBeUndefined();
 op.rich=structuredClone(edited);
 op.rich.request&&'content'in op.rich.request&&(op.rich.request.sourceVersionId=randomUUID());
 expect(richCardReview(op)).toBeUndefined();
 op.rich=structuredClone(edited);
 if(!op.rich.request||!('content'in op.rich.request))throw Error('missing content');
 op.rich.request.content.public.overview.value='甲'.repeat(10500);
 expect(candidateConfirmation('ref',richCardReview(op))).toBeUndefined();
});
