import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {z} from 'zod';
import {agentIdSchema,groupIdSchema,canonicalizeRichRecipeContent,type AccountStatus,type AuthoringOperation,type CreatorJob,type CreatorAnswer,type RecipeAuthoringRequest,type RecipeAuthoringReply} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import {RecipeCreatorSupervisor,type CreatorSourceLease} from '../src/recipe-creator-supervisor.js';
import {RecipeCreatorExecutor} from '../src/recipe-creator.js';
import {creatorSha,creatorSnapshotDigest,RecipeCreatorJournal} from '../src/recipe-creator-journal.js';
import {RecipeAuthoringController} from '../src/recipe-authoring.js';
import {AuthoringJournal} from '../src/recipe-authoring-journal.js';
import {MetadataJournal} from '../src/community-metadata-journal.js';
import type {NativeAccount} from '../src/account-session.js';
import {AuthoringError} from '../src/recipe-authoring-cloud.js';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts.js';
import {LocalRecipePublisher} from '../src/local-recipe-publisher.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function pauseNextPreview(executor:RecipeCreatorExecutor){
  let entered=()=>{},resume=()=>{};
  const paused=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const original=executor.preview.bind(executor);
  const preview=vi.spyOn(executor,'preview').mockImplementationOnce(async(context,job)=>{
    const result=await original(context,job);entered();await gate;return result;
  });
  cleanup.push(()=>{resume();preview.mockRestore();});
  return {paused,resume};
}
function seedDraft(store:LocalRecipeDrafts,record:LocalRecipeDraftRecord){
  for(let revision=1;revision<=record.draft.revision;revision++){
    const next=structuredClone(record);next.draft.revision=revision;
    store.commit({requestId:randomUUID(),expectedRevision:revision===1?null:revision-1,record:next});
  }
}
function fixture(journal=new RecipeCreatorJournal(),localDrafts=new LocalRecipeDrafts(),publisher=new LocalRecipePublisher()){
  cleanup.push(()=>localDrafts.close());
  cleanup.push(()=>publisher.close());
  const accountId=randomUUID(),other=randomUUID(),deviceId=randomUUID(),deviceKey=Buffer.alloc(32,3).toString('base64url'),botId=agentIdSchema.parse('cli_creator'),groupId=groupIdSchema.parse('oc_source');
  const sessions=new Map<string,string>(),bindings=new Map<string,string>([[accountId,randomUUID()],[other,randomUUID()]]),rpcs:RecipeAuthoringRequest[]=[];
  const signals=new Map([[accountId,new AbortController()],[other,new AbortController()]]),listeners=new Set<()=>void>();let active=accountId;
  const status=():AccountStatus=>({kind:'signedIn',accountId:active,displayName:'作者',provider:'google',persistence:'memory'});
  const operations:AuthoringOperation[]=[];
  let handoff:Extract<RecipeAuthoringReply,{kind:'workflow'}>['handoff'],groupIdentity='d'.repeat(64);
  const rpc=vi.fn(async(input:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
    rpcs.push(input);
    switch(input.type){
      case 'creatorDiscover':return {kind:'creatorBinding',association:{binding:bindings.get(input.accountId)!,scope:'c'.repeat(64),recipient:{openId:'ou_author',chatId:groupId,tenantKey:'tenant'}},wakeId:null};
      case 'creatorOpen':{const session=sessions.get(input.accountId)??randomUUID();sessions.set(input.accountId,session);return {kind:'creatorSession',session,binding:input.binding,scope:input.scope,leaseMs:45000};}
      case 'creatorContinue':return {kind:'creatorAck'};
      case 'creatorPoll':return {kind:'creatorJobs',jobs:[]};
      case 'close':return {kind:'closed'};
      case 'workflow':return {kind:'workflow',activity:1,ageMs:0,pausedContexts:[],...(handoff&&{handoff})};
      case 'status':return {kind:'status',linked:true,operations,reconciliation:[]};
      case 'resumeContext':{
        const operation=operations.find(op=>op.operationId===input.operationId);
        if(!operation)throw Error('missing operation');
        return {kind:'operation',operation};
      }
      case 'operationSourceIdentity':return {kind:'operationSourceIdentity',operationId:input.operationId,groupId,identity:'d'.repeat(64)};
      case 'beginDraftHandoff':return {kind:'handoff',handoff:{retryId:input.retryId,groupId,draftId:input.draftId,state:'selecting'}};
      case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId:input.groupId,identity:groupIdentity};
      case 'beginHandoff':return {kind:'handoff',handoff:{retryId:input.retryId,groupId:input.groupId,state:'selecting'}};
      case 'handoffStatus':return {kind:'handoff',handoff:{retryId:input.retryId,groupId,state:'awaitingAttestations'}};
      case 'answerHandoff':return {kind:'handoff',handoff:{retryId:input.request.retryId,groupId,state:'selecting'}};
      default:throw Error('unexpected '+input.type);
    }
  });
  const snapshot=vi.fn(async()=>({stale:false,host:{kind:'connected'},agents:[{id:botId,name:'原 Bot',running:true,connection:'connected',tenant:'feishu'}],memberships:[{agentId:botId,groupId,enabled:true,stale:false}],groups:[{id:groupId,name:'原群'}]}));
  const client={recipeAuthoring:rpc,device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,name:'原设备',publicKey:deviceKey},remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot} as unknown as VonvonClient;
  const references:Array<{owner:AbortController;release:ReturnType<typeof vi.fn>}> = [];
  const retain=vi.fn(async(viewId:string,signal:AbortSignal):Promise<CreatorSourceLease>=>{
    const owner=new AbortController(),release=vi.fn(()=>owner.abort()),activeSignal=AbortSignal.any([signal,owner.signal]);references.push({owner,release});
    return {viewId,client,signal:activeSignal,release,check(){activeSignal.throwIfAborted();}};
  });
  const request=vi.fn(async(id:string,path:string,_init?:RequestInit)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path.startsWith('/v2/versions/'))return Response.json({versionId:path.split('/')[3],authorId:id,access:'direct',items:[]});
    throw Error(path);
  });
  const account:NativeAccount={lease:id=>id===active?signals.get(id)?.signal:undefined,status,onStatus:listener=>{listeners.add(()=>listener(status()));return ()=>{};},
    login:async()=>status(),cancelLogin:async()=>status(),logout:async()=>status(),dispose:async()=>{},recipeLink:(r,v)=>`https://vonvon.cc/recipes/${r}/versions/${v}`,request:async(id,path,init,beforeSend)=>{await beforeSend?.();return request(id,path,init);}};
  const history=new AuthoringJournal(),metadata=new MetadataJournal();
  const authoring=new RecipeAuthoringController(account,()=>{throw Error('creator must not capture selected view');},history,undefined,localDrafts);
  cleanup.push(()=>authoring.closeAll());
  const published=vi.fn();
  const executor=new RecipeCreatorExecutor(account,journal,metadata,history,published,undefined,undefined,localDrafts,publisher);
  const build=(sources:string[]=[],records=journal,store=localDrafts)=>{const supervisor=new RecipeCreatorSupervisor(account,retain,()=>sources,records,history,authoring,records===journal?executor:new RecipeCreatorExecutor(account,records,metadata,history,published,undefined,undefined,store,publisher),store);cleanup.push(()=>supervisor.dispose());return supervisor;};
  return {accountId,other,botId,groupId,deviceId,deviceKey,account,authoring,executor,history,journal,localDrafts,published,request,references,retain,rpcs,rpc,sessions,operations,build,snapshot,
    privateHandoff(){handoff={retryId:randomUUID(),ref:randomUUID(),generation:1,lease:'a'.repeat(64),versions:[randomUUID()]};return handoff;},
    changeIdentity(){groupIdentity='e'.repeat(64);},
    replaceLease(){signals.set(active,new AbortController());},
    switchAccount(){signals.get(active)!.abort();active=other;for(const listener of listeners)listener();},
  };
}
function saveRichDraft(f:ReturnType<typeof fixture>){
  const draftId=randomUUID(),preparationId=randomUUID();
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const document=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:value('原草稿'),summary:value(''),overview:value(''),version:value('1.1')},
    settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});
  const sourceContent=structuredClone(document.content);sourceContent.public.name.value='原始来源内容';
  const source=canonicalizeRichRecipeContent(sourceContent);
  const record:LocalRecipeDraftRecord={association:f.journal.associations(f.accountId)[0]!,work:{draftId,source:{preparationId,groupId:f.groupId,identity:'d'.repeat(64)}},
    draft:{format:'rich-v2',draftId,recipeId:null,revision:2,sourceIntentId:preparationId,public:{name:'原草稿',summary:'',overview:'',version:'1.1',access:'direct'},
      rich:{content:document.content,canonical:Buffer.from(document.canonicalUTF8).toString('base64url'),texts:{}}},
    sourceCanonical:Buffer.from(source.canonicalUTF8).toString('base64url'),parent:null,origins:[],selected:[],members:[]};
  seedDraft(f.localDrafts,record);return record;
}

it('shares one creator session across works, never legacy-opens, and retains work through renderer close and view changes',async()=>{
  const f=fixture(),supervisor=f.build();
  const entry={kind:'source' as const,viewId:'local',botId:f.botId,groupId:f.groupId};
  await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry});
  f.authoring.closeRenderer();
  await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry});
  expect(f.rpcs.filter(r=>r.type==='creatorOpen')).toHaveLength(1);
  expect(f.rpcs.filter(r=>r.type==='open'||r.type==='close')).toEqual([]);
  const begins=f.rpcs.filter(r=>r.type==='beginHandoff');expect(begins).toHaveLength(2);
  expect(begins.every(request=>request.conversation===true && request.groupId===f.groupId)).toBe(true);
  expect(begins[0]?.session).toBe(f.sessions.get(f.accountId));expect(begins[1]?.session).toBe(f.sessions.get(f.accountId));
  expect(f.references[0]?.release).not.toHaveBeenCalled();
  supervisor.dispose();expect(f.references[0]?.release).toHaveBeenCalledOnce();expect(f.rpcs.filter(r=>r.type==='close')).toHaveLength(1);
});

it('restores only persisted associations on relaunch and stops original leases before using another account',async()=>{
  const f=fixture(),first=f.build();
  await first.associated(f.accountId,'local',f.botId);first.dispose();
  const second=f.build();await settle();
  await second.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
  expect(f.rpcs.filter(r=>r.type==='creatorOpen')).toHaveLength(2);
  f.switchAccount();await settle();
  expect(f.references[1]?.release).toHaveBeenCalledOnce();
  await second.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.other,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
  const begin=f.rpcs.filter(r=>r.type==='beginHandoff').at(-1)!;
  expect(begin.session).toBe(f.sessions.get(f.other));expect(begin.session).not.toBe(f.sessions.get(f.accountId));
});

it('adopts private-started workflow handoff by exact retryId and sends source attestations without renderer state',async()=>{
  const f=fixture(),pending=f.privateHandoff(),supervisor=f.build();
  await supervisor.associated(f.accountId,'local',f.botId);await settle();
  expect(f.rpcs.filter(r=>r.type==='open')).toEqual([]);
  expect(f.rpcs.find(r=>r.type==='handoffStatus')).toMatchObject({retryId:pending.retryId,session:f.sessions.get(f.accountId)});
  expect(f.rpcs.find(r=>r.type==='answerHandoff')).toMatchObject({request:pending,session:f.sessions.get(f.accountId),attestations:[{versionId:pending.versions[0],authorId:f.accountId}]});
});

it('continues a local rich draft using durable source bytes without cloud draft reads or daemon history recovery',async()=>{
  const f=fixture(),supervisor=f.build();
  await supervisor.associated(f.accountId,'local',f.botId);
  const record=saveRichDraft(f),draftId=record.draft.draftId,preparationId=record.work.source!.preparationId;
  f.request.mockClear();
  expect(f.history.history.locator(f.accountId,preparationId)).toBeUndefined();
  expect(await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'draft',draftId,revision:2}})).toMatchObject({kind:'creatorContinuing',delivery:'delivered',accountId:f.accountId,viewId:'local',botId:f.botId,tenant:'feishu',botName:'原 Bot'});
  expect(f.rpcs.filter(r=>r.type==='operationSourceIdentity')).toEqual([]);
  expect(f.rpcs.find(r=>r.type==='creatorContinue')).toMatchObject({session:f.sessions.get(f.accountId),conversationRevision:2,selection:{kind:'draft',work:record.work}});
  expect(f.rpcs.some(r=>r.type==='beginDraftHandoff')).toBe(false);
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
  expect(f.rpcs.filter(r=>r.type==='open')).toEqual([]);
});

it('continues after local store restart even when no operation source history survives',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'creator-local-draft-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new LocalRecipeDrafts(dir),f=fixture(undefined,store),first=f.build();
  await first.associated(f.accountId,'local',f.botId);
  const record=saveRichDraft(f);
  first.dispose();expect(store.read(f.accountId,record.draft.draftId)).toEqual(record);store.close();
  const restored=new LocalRecipeDrafts(dir);cleanup.push(()=>restored.close());
  const supervisor=f.build([],f.journal,restored);await supervisor.associated(f.accountId,'local',f.botId);
  f.request.mockClear();
  expect(f.history.history.locator(f.accountId,record.work.source!.preparationId)).toBeUndefined();
  expect(await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'draft',draftId:record.draft.draftId,revision:2}})).toMatchObject({delivery:'delivered'});
  expect(f.rpcs.find(r=>r.type==='creatorContinue')).toMatchObject({conversationRevision:2,selection:{kind:'draft',work:record.work}});
  expect(restored.read(f.accountId,record.draft.draftId)).toEqual(record);
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
  expect(f.rpcs.filter(r=>r.type==='operationSourceIdentity')).toEqual([]);
});

it('refuses an unknown old cloud draft without reading or importing its contents',async()=>{
  const f=fixture(),supervisor=new RecipeCreatorSupervisor(f.account,f.retain,()=>[],f.journal,f.history,f.authoring,f.executor);cleanup.push(()=>supervisor.dispose());
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'draft',draftId:randomUUID(),revision:1}})).rejects.toThrow('本机未找到');
  expect(f.request).not.toHaveBeenCalled();
  expect(f.localDrafts.list(f.accountId)).toEqual([]);
  expect(f.rpcs.filter(r=>['creatorContinue','beginDraftHandoff','operationSourceIdentity'].includes(r.type))).toEqual([]);
});

it.each(['deviceId','deviceKey','botId','viewId'] as const)('rejects a local draft recorded for another %s before sending it to a Bot',async field=>{
  const f=fixture(),supervisor=f.build();await supervisor.associated(f.accountId,'local',f.botId);
  const record=saveRichDraft(f);record.draft.revision=3;
  if(field==='deviceId')record.association.deviceId=randomUUID();
  if(field==='deviceKey')record.association.deviceKey=Buffer.alloc(32,9).toString('base64url');
  if(field==='botId')record.association.botId=agentIdSchema.parse('cli_other_bot');
  if(field==='viewId')record.association.viewId=randomUUID();
  f.localDrafts.commit({requestId:randomUUID(),expectedRevision:2,record});f.request.mockClear();
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'draft',draftId:record.draft.draftId,revision:3},source:{viewId:'local',botId:f.botId}})).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.rpcs.filter(r=>['creatorContinue','beginDraftHandoff','operationSourceIdentity'].includes(r.type))).toEqual([]);
});

it('does not expose another account local draft or fill missing source bytes from the cloud',async()=>{
  const f=fixture(),supervisor=f.build();await supervisor.associated(f.accountId,'local',f.botId);
  const record=saveRichDraft(f);delete record.sourceCanonical;record.draft.revision=3;
  f.localDrafts.commit({requestId:randomUUID(),expectedRevision:2,record});f.request.mockClear();
  const entry={kind:'draft' as const,draftId:record.draft.draftId,revision:3};
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry})).rejects.toThrow('来源资料尚未完整保存');
  f.switchAccount();
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.other,entry})).rejects.toThrow('本机未找到');
  expect(f.request).not.toHaveBeenCalled();
  expect(f.rpcs.filter(r=>['creatorContinue','beginDraftHandoff','operationSourceIdentity'].includes(r.type))).toEqual([]);
});

async function existingRichDraft(state:'waiting'|'candidate'='waiting'){
  const f=fixture(),supervisor=f.build();
  await supervisor.associated(f.accountId,'local',f.botId);
  const record=saveRichDraft(f),draftId=record.draft.draftId,preparationId=record.work.source!.preparationId;
  const operation:AuthoringOperation={operationId:randomUUID(),format:'rich-v2',purpose:'editDraft',draftId,baseRevision:2,state,createdAt:Date.now()-31*60_000,
    targetPublicKey:f.deviceKey,nonceCommitment:f.deviceKey,deliveryUnknown:false,...(state==='candidate'&&{payloadDigest:'a'.repeat(64)})};
  f.operations.push(operation);
  return {...f,supervisor,draftId,preparationId,record,operation,continueDraft:()=>supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'draft',draftId,revision:2}})};
}

it.each(['waiting','candidate'] as const)('continues the exact existing rich %s operation without starting another private handoff',async(state)=>{
  const f=await existingRichDraft(state),{operation,draftId,preparationId}=f;
  const before=structuredClone(operation);
  expect(await f.continueDraft()).toMatchObject({kind:'creatorContinuing',delivery:'restored',accountId:f.accountId,viewId:'local',botId:f.botId,tenant:'feishu',botName:'原 Bot'});
  expect(f.rpcs.filter(r=>r.type==='beginDraftHandoff')).toEqual([]);
  expect(f.rpcs.filter(r=>r.type==='resumeContext')).toEqual([{type:'resumeContext',botId:f.botId,session:f.sessions.get(f.accountId),operationId:operation.operationId}]);
  expect(f.rpcs.find(r=>r.type==='creatorContinue')).toMatchObject({selection:{kind:'draft',work:{draftId,source:{preparationId,groupId:f.groupId,identity:'d'.repeat(64)}},name:'原草稿',version:'1.1'}});
  expect(operation).toEqual(before);
  expect(f.request.mock.calls.some(([,path])=>path.includes('/authoring/'))).toBe(false);
});

it.each(['pendingCloud','cancelPending','needsReview','sending','pendingMain','deliveryUnknown','revision','duplicate','legacy'] as const)(
  'leaves a saved-draft %s operation untouched when it cannot resume',async(reason)=>{
    const f=await existingRichDraft();
    if(reason==='deliveryUnknown')f.operation.deliveryUnknown=true;
    else if(reason==='revision')f.operation.baseRevision=1;
    else if(reason==='duplicate')f.operations.push({...f.operation,operationId:randomUUID()});
    else if(reason==='legacy')delete f.operation.format;
    else f.operation.state=reason;
    const before=structuredClone(f.operations);
    await expect(f.continueDraft()).rejects.toThrow();
    expect(f.rpcs.filter(r=>['resumeContext','creatorContinue','beginDraftHandoff'].includes(r.type))).toEqual([]);
    expect(f.operations).toEqual(before);
    expect(f.request.mock.calls.some(([,path])=>path.includes('/authoring/'))).toBe(false);
  });

it.each(['account','source'] as const)('does not resume a saved draft through a changed %s',async(change)=>{
  const f=await existingRichDraft();
  if(change==='account')f.switchAccount();
  else f.changeIdentity();
  const before=structuredClone(f.operations);
  await expect(f.continueDraft()).rejects.toThrow();
  expect(f.rpcs.filter(r=>['resumeContext','creatorContinue','beginDraftHandoff'].includes(r.type))).toEqual([]);
  expect(f.operations).toEqual(before);
});

it('opens exact historical version management with its real title/version without reading new-version inheritance',async()=>{
  const f=fixture(),supervisor=f.build(),recipeId=randomUUID(),versionId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);
  const linked=f.journal.associations(f.accountId)[0]!;
  f.journal.rememberVersion({...linked,binding:randomUUID(),scope:'e'.repeat(64)},versionId);
  f.request.mockImplementation(async(id,path)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path.startsWith('/v2/recipes/'))return Response.json({error:{code:'not_found'}},{status:404});
    if(path===`/v1/recipes/${recipeId}/versions/${versionId}`)return Response.json({recipeId,versionId,revision:5,public:{name:'历史原名称',version:'旧版第五次',summary:'原简介',overview:'',access:'coded'},
      config:{role:'原角色'},owned:true,acquired:true});
    throw Error('unexpected inheritance read '+path);
  });
  expect(await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'version',recipeId,versionId}})).toMatchObject({kind:'creatorContinuing',viewId:'local'});
  expect(f.rpcs.find(r=>r.type==='creatorContinue')).toMatchObject({session:f.sessions.get(f.accountId),selection:{kind:'version',target:{recipeId,versionId},name:'历史原名称',version:'旧版第五次'}});
  expect(f.request.mock.calls.some(([,path])=>path.endsWith('/source-items'))).toBe(false);
  expect(f.journal.version(f.accountId,versionId)).toEqual(linked);
});

it('a recorded source key is checked before sending version selection',async()=>{
  const f=fixture(),supervisor=f.build(),recipeId=randomUUID(),versionId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);f.journal.rememberVersion({...f.journal.associations(f.accountId)[0]!,deviceKey:Buffer.alloc(32,7).toString('base64url')},versionId);
  f.request.mockImplementation(async(id,path)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path.startsWith('/v2/recipes/'))return Response.json({error:{code:'not_found'}},{status:404});
    if(path===`/v1/recipes/${recipeId}/versions/${versionId}`)return Response.json({recipeId,versionId,revision:5,public:{name:'历史原名称',version:'旧版第五次',summary:'原简介',overview:'',access:'coded'},
      config:{role:'原角色'},owned:true,acquired:true});
    throw Error('unexpected inheritance read '+path);
  });
  f.request.mockClear();
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'version',recipeId,versionId}})).rejects.toThrow('来源不能替换');
  expect(f.request.mock.calls.filter(([,path])=>path.includes('/recipes/'))).toHaveLength(0);
  expect(f.journal.version(f.accountId,versionId)?.deviceKey).not.toBe(f.deviceKey);
  expect(f.rpcs.filter(r=>r.type==='creatorContinue')).toHaveLength(0);
});

async function publicationFixture(journal?:RecipeCreatorJournal){
  const f=fixture(journal),supervisor=f.build(),draftId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);await settle();
  const association=f.journal.associations(f.accountId)[0]!;
  const draft={draftId,recipeId:null,revision:2,public:{name:'App 预览',version:'1',summary:'简介',overview:'完整概览',access:'direct' as const},config:{role:'完整角色正文'}};
  const record:LocalRecipeDraftRecord={association,work:{draftId,source:null},draft,members:[]};
  seedDraft(f.localDrafts,record);
  let current:CreatorJob|undefined,state:'preparing'|'offer'|'active'|'unknown'|'finished'='preparing',result:CreatorAnswer|undefined;
  let loseResponse=false,receiptAvailable=true,remoteDraftId:string|undefined;
  const prior=f.rpc.getMockImplementation()!;
  const creatorJob=(task:CreatorJob['task']):CreatorJob=>({id:randomUUID(),binding:association.binding,scope:association.scope,task});
  f.rpc.mockImplementation(async(input):Promise<RecipeAuthoringReply>=>{
    if(['creatorPreview','creatorCheck','creatorAppConfirm','creatorAnswer'].includes(input.type))f.rpcs.push(input);
    switch(input.type){
      case 'creatorPreview':
        if(input.work.draftId!==draftId||input.revision!==draft.revision)throw Error('changed draft');
        current??=creatorJob({kind:'read',read:{kind:'draft',work:input.work}});
        return {kind:'creatorPreview',job:current,state,...(result&&{result})};
      case 'creatorCheck':
        if(!current||current.id!==input.id)throw Error('wrong job');
        return {kind:'creatorChecked',job:current,mode:state==='preparing'?'read':state==='offer'?'preview':state==='unknown'?'receipt':'execute'};
      case 'creatorAppConfirm':{
        if(!current||current.id!==input.id||current.task.kind!=='command'||current.task.command.kind!=='publish'||current.task.command.snapshotDigest!==input.snapshotDigest)throw Error('changed review');
        current={...current,task:{...current.task,confirmation:{kind:'app',confirmationId:input.confirmationId},approval:creatorSha(input.confirmationId),expiresAt:Date.now()+60000}};state='active';
        return {kind:'creatorAck'};
      }
      case 'creatorAnswer':
        if(!current||current.id!==input.id)throw Error('wrong job');
        if(input.answer.kind==='snapshot'){
          current=creatorJob({kind:'command',command:{kind:'publish',snapshot:input.answer.snapshot,snapshotDigest:creatorSnapshotDigest(input.answer.snapshot)},approval:'0'.repeat(64),expiresAt:Date.now()+60000});state='offer';
        }else if(input.answer.kind==='unknown')state='unknown';
        else{state='finished';result=input.answer;}
        return {kind:'creatorAck'};
      default:return prior(input);
    }
  });
  f.request.mockImplementation(async(_accountId,path,init)=>{
    if(path==='/v1/me')return Response.json({accountId:f.accountId});
    if(path.startsWith('/v1/receipts/publications/')){
      if(!receiptAvailable||!remoteDraftId)return Response.json({status:'unknown'});
      return Response.json({status:'committed',receipt:{requestId:current!.id,format:'role-v1',draftId:remoteDraftId,draftRevision:1,recipeId,versionId,revision:1,public:draft.public,firstCodeId:null}});
    }
    if(path==='/v1/drafts'&&init?.method==='POST'){
      const requestId=new Headers(init.headers).get('idempotency-key');if(!requestId)throw Error('missing remote draft id');
      remoteDraftId=requestId;return Response.json({...draft,draftId:remoteDraftId,revision:1});
    }
    if(remoteDraftId&&path===`/v1/drafts/${remoteDraftId}/publish`){if(loseResponse)throw Error('lost response');return Response.json({recipeId,versionId,revision:1,public:draft.public});}
    throw Error(path+' '+init?.method);
  });
  const prepare=()=>supervisor.preparePublication({type:'preparePublication',accountId:f.accountId,draft:structuredClone(draft)});
  const confirm=(reviewId:string)=>supervisor.confirmPublication({type:'confirmPublication',accountId:f.accountId,reviewId});
  return {...f,supervisor,draft,prepare,confirm,recipeId,versionId,current:()=>current,
    save(){f.localDrafts.commit({requestId:randomUUID(),expectedRevision:draft.revision-1,record:{...record,draft:structuredClone(draft)}});},
    lost(){loseResponse=true;receiptAvailable=false;},receipt(){receiptAvailable=true;},active(){state='active';},
    restart(records?:RecipeCreatorJournal){supervisor.dispose();return f.build([],records);}};
}

it('APP PUBLICATION prepares exact readonly bytes without publishing and confirms through the existing executor once',async()=>{
  const f=await publicationFixture();
  const ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
  expect(f.rpcs.some(r=>r.type==='creatorContinue'||r.type==='beginDraftHandoff'||r.type==='beginHandoff')).toBe(false);
  const repeated=await f.prepare();expect(repeated).toEqual(ready);
  const results=await Promise.all([f.confirm(ready.reviewId),f.confirm(ready.reviewId)]);
  for(const reply of results)expect(reply).toEqual({kind:'publicationResult',result:{kind:'published',publication:{accountId:f.accountId,draftId:f.draft.draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1}}});
  expect(f.request.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
  expect(f.request.mock.calls.filter(([,path])=>path==='/v1/drafts')).toHaveLength(1);
  expect(f.journal.command(f.accountId,f.current()!.id)?.grant.confirmation?.kind).toBe('app');
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toHaveLength(1);
});

it('binds the chosen publication destination to the confirmed local job and the remote publish request',async()=>{
  const f=await publicationFixture(), ready=await f.prepare();
  if(ready.kind!=='publicationReady')throw Error('missing confirmation');
  const destination={recipeId:f.recipeId,versionId:randomUUID()};
  const result=await f.supervisor.confirmPublication({type:'confirmPublication',reviewId:ready.reviewId,accountId:f.accountId,destination});
  expect(result).toMatchObject({kind:'publicationResult',result:{kind:'published',publication:{recipeId:destination.recipeId}}});
  const request=f.request.mock.calls.find(([,path])=>path.endsWith('/publish'));
  expect(JSON.parse(String(request?.[2]?.body))).toMatchObject({destination});
  expect(f.journal.command(f.accountId,f.current()!.id)?.destination).toEqual(destination);
});

it('APP PUBLICATION compares the caller preview with authoritative local content before any source or cloud action',async()=>{
  const f=await publicationFixture();f.draft.config.role='unsaved renderer content';f.request.mockClear();
  await expect(f.prepare()).rejects.toThrow('重新读取本地草稿');
  expect(f.rpcs.filter(r=>r.type==='creatorPreview'||r.type==='creatorAppConfirm')).toEqual([]);
  expect(f.request).not.toHaveBeenCalled();
});

it('requires the public name, summary and version before preparing publication', async () => {
  for (const field of ['name', 'summary', 'version'] as const) {
    const f = await publicationFixture();
    f.draft.public[field] = '  ';
    await expect(f.prepare()).rejects.toThrow('请在 Bot 私聊中补充');
    expect(f.rpcs.filter(request => request.type === 'creatorPreview' || request.type === 'creatorAppConfirm')).toEqual([]);
    expect(f.request.mock.calls.some(([, , init]) => init?.method === 'POST')).toBe(false);
  }
});

it('APP PUBLICATION diagnostics identify a failed stage without logging error messages or arbitrary names',async()=>{
  const f=await publicationFixture(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const prior=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async input=>{
      if(input.type==='creatorPreview')throw Object.assign(new Error('secret-message-token-draft-body'),{name:'secret-error-name'});
      return prior(input);
    });
    await expect(f.prepare()).rejects.toThrow('发布准备尚未完成');
    expect(warn).toHaveBeenCalledWith('recipe.publication.prepare.failed',{code:'prepare_failed',stage:'daemonPreview',errorName:'UnknownError'});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  }finally{warn.mockRestore();}
});

it('APP PUBLICATION diagnostics preserve structural Zod paths and hide dynamic path values and messages',async()=>{
  const f=await publicationFixture(),warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
    const prior=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async input=>{
      if(input.type==='creatorPreview')throw new z.ZodError([{code:'invalid_type',expected:'string',received:'number',
        path:['job','task','snapshot','secret-draft-id',0,'revision'],message:'secret-zod-message'}]);
      return prior(input);
    });
    await expect(f.prepare()).rejects.toThrow('发布准备尚未完成');
    expect(warn).toHaveBeenCalledWith('recipe.publication.prepare.failed',{code:'prepare_failed',stage:'daemonPreview',errorName:'ZodError',
      issues:[{code:'invalid_type',path:['job','task','snapshot','*',0,'revision']}]});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  }finally{warn.mockRestore();}
});

it.each(['account','revision','content','review','saved'] as const)('APP PUBLICATION refuses changed %s before authorization',async(change)=>{
  const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  let reviewId=ready.reviewId;
  if(change==='account')f.switchAccount();
  if(change==='revision'){f.draft.revision++;f.save();}
  if(change==='content'){f.draft.config.role='changed behind preview';f.draft.revision++;f.save();}
  if(change==='review')reviewId=randomUUID();
  if(change==='saved')f.supervisor.invalidateDraft(f.accountId,f.draft.draftId);
  await expect(f.confirm(reviewId)).rejects.toThrow();
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toEqual([]);
  expect(f.request.mock.calls.some(([,path])=>path.endsWith('/publish'))).toBe(false);
});

it.each((['preview','queue'] as const).flatMap(wait=>(['invalidate','expire','lease'] as const).map(change=>({wait,change}))))(
  'APP PUBLICATION rejects a $change review while waiting for $wait before sending confirmation',async({wait,change})=>{
    const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
    const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now);cleanup.push(()=>clock.mockRestore());
    const blocked=pauseNextPreview(f.executor);
    const occupying=wait==='queue'?f.prepare().catch((error:unknown)=>error):undefined;
    if(occupying)await blocked.paused;
    const confirming=f.confirm(ready.reviewId).catch((error:unknown)=>error);
    if(wait==='preview')await blocked.paused;
    else await settle();
    if(change==='invalidate')f.supervisor.invalidateDraft(f.accountId,f.draft.draftId);
    if(change==='expire')clock.mockReturnValue(now+10*60_000);
    if(change==='lease'){
      const original=f.account.lease?.(f.accountId);f.replaceLease();
      expect(f.account.status()).toMatchObject({kind:'signedIn',accountId:f.accountId});
      expect(f.account.lease?.(f.accountId)).not.toBe(original);expect(original?.aborted).toBe(false);
    }
    blocked.resume();
    if(occupying)await occupying;
    const result=await confirming;
    expect(f.rpcs.filter(request=>request.type==='creatorAppConfirm')).toEqual([]);
    expect(f.request.mock.calls.filter(([, , init])=>init?.method&&init.method!=='GET')).toEqual([]);
    expect(result).toBeInstanceOf(AuthoringError);
  });

it('APP PUBLICATION cold recovery uses only persisted account/draft and exact receipt GET while the source is offline',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'creator-cold-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const f=await publicationFixture(new RecipeCreatorJournal(dir)),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  f.lost();expect(await f.confirm(ready.reviewId)).toEqual({kind:'publicationResult',result:{kind:'pending'}});
  const original=f.current()!.id,draftId=f.draft.draftId;
  f.retain.mockRejectedValue(new Error('source offline'));
  const restarted=f.restart(new RecipeCreatorJournal(dir));await settle();
  const input={type:'recoverPublication' as const,accountId:f.accountId,draftId};
  expect(await restarted.recoverPublication(input)).toEqual({kind:'publicationRecovery',result:{kind:'pending'}});
  f.receipt();
  expect(await restarted.recoverPublication(input)).toEqual({kind:'publicationRecovery',result:{kind:'published',publication:{accountId:f.accountId,draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1}}});
  expect(new RecipeCreatorJournal(dir).version(f.accountId,f.versionId)).toMatchObject({accountId:f.accountId});
  expect(f.published).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1});
  expect(f.current()!.id).toBe(original);
  expect(f.request.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toHaveLength(1);
  expect(f.request.mock.calls.filter(([,path])=>path.includes('/receipts/publications/')).every(([,path,init])=>path.includes(original)&&(!init?.method||init.method==='GET'))).toBe(true);
});

it('APP PUBLICATION receipt recovery cannot execute a frozen command or reveal another account or absent draft',async()=>{
  const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  f.lost();await f.confirm(ready.reviewId);
  const row=f.journal.command(f.accountId,f.current()!.id)!;
  const frozen=new RecipeCreatorJournal();frozen.save({...row,phase:'frozen'});
  const recoverer=f.build([],frozen);f.request.mockClear();
  expect(await recoverer.recoverPublication({type:'recoverPublication',accountId:f.accountId,draftId:f.draft.draftId})).toEqual({kind:'publicationRecovery',result:{kind:'absent'}});
  expect(await recoverer.recoverPublication({type:'recoverPublication',accountId:f.accountId,draftId:randomUUID()})).toEqual({kind:'publicationRecovery',result:{kind:'absent'}});
  await expect(recoverer.recoverPublication({type:'recoverPublication',accountId:f.other,draftId:f.draft.draftId})).rejects.toThrow();
  f.switchAccount();
  expect(await recoverer.recoverPublication({type:'recoverPublication',accountId:f.other,draftId:f.draft.draftId})).toEqual({kind:'publicationRecovery',result:{kind:'absent'}});
  expect(f.request).not.toHaveBeenCalled();
});

it('APP PUBLICATION recovery rejects a mismatched receipt and a changed account before recording success',async()=>{
  const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  f.lost();await f.confirm(ready.reviewId);f.receipt();
  const prior=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(id,path,init)=>{
    const response=await prior(id,path,init);
    if(!path.includes('/receipts/publications/'))return response;
    const body=await response.json();body.receipt.draftRevision++;
    return Response.json(body);
  });
  const input={type:'recoverPublication' as const,accountId:f.accountId,draftId:f.draft.draftId};
  await expect(f.supervisor.recoverPublication(input)).rejects.toThrow();
  expect(f.journal.version(f.accountId,f.versionId)).toBeUndefined();
  f.request.mockImplementation(async(id,path,init)=>{const response=await prior(id,path,init);if(path.includes('/receipts/publications/'))f.switchAccount();return response;});
  await expect(f.supervisor.recoverPublication(input)).rejects.toThrow();
  expect(f.journal.version(f.accountId,f.versionId)).toBeUndefined();
  expect(f.request.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
});

it('APP PUBLICATION gives controlled source recovery guidance without exposing transport details',async()=>{
  const f=await publicationFixture();
  f.references[0]!.owner.abort();f.retain.mockRejectedValue(new Error('transport bearer=private-secret'));
  const error:unknown=await f.prepare().catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(AuthoringError);
  if(!(error instanceof AuthoringError))throw Error('expected safe authoring failure');
  expect(error.message).toContain('保持原来源 Bot 在线');expect(error.message).not.toContain('private-secret');
});

it('returns the original source Bot tenant and name validated before starting a creator handoff',async()=>{
  const f=fixture(),supervisor=f.build();
  const original=await f.snapshot();
  f.snapshot.mockResolvedValue({...original,agents:[{...original.agents[0]!,tenant:'lark',name:'原 Lark Bot'}]});
  const reply=await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
  expect(reply).toMatchObject({kind:'creatorContinuing',delivery:'delivered',accountId:f.accountId,viewId:'local',botId:f.botId,tenant:'lark',botName:'原 Lark Bot'});
  const started=f.rpc.mock.calls.findIndex(([request])=>request.type==='beginHandoff');
  expect(started).toBeGreaterThanOrEqual(0);
  expect(f.snapshot.mock.invocationCallOrder.at(-1)).toBeLessThan(f.rpc.mock.invocationCallOrder[started]!);
});
it.each(['readFailure','missingBot','stoppedBot','disconnectedBot','missingTenant','staleSnapshot','disconnectedSource','invalidName'])('stops %s before a new creator card or handoff is sent',async failure=>{
  const f=fixture(),supervisor=f.build();
  await supervisor.associated(f.accountId,'local',f.botId);
  const next=await f.snapshot();
  if(failure==='readFailure')f.snapshot.mockRejectedValueOnce(new Error('Synthetic source snapshot failure'));
  else{
    if(failure==='missingBot')next.agents=[];
    if(failure==='stoppedBot')next.agents[0]!.running=false;
    if(failure==='disconnectedBot')next.agents[0]!.connection='disconnected';
    if(failure==='missingTenant')Reflect.deleteProperty(next.agents[0]!,'tenant');
    if(failure==='staleSnapshot')next.stale=true;
    if(failure==='disconnectedSource')next.host.kind='disconnected';
    if(failure==='invalidName')next.agents[0]!.name='';
    f.snapshot.mockResolvedValueOnce(next);
  }
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}})).rejects.toThrow();
  expect(f.rpcs.filter(request=>['creatorContinue','beginHandoff','beginDraftHandoff'].includes(request.type))).toEqual([]);
});
it('rechecks the original account lease after metadata arrives before sending a creator card',async()=>{
  const f=fixture(),supervisor=f.build();
  await supervisor.associated(f.accountId,'local',f.botId);
  const next=await f.snapshot();
  f.snapshot.mockImplementationOnce(async()=>{f.switchAccount();return next;});
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}})).rejects.toThrow();
  expect(f.rpcs.filter(request=>['creatorContinue','beginHandoff','beginDraftHandoff'].includes(request.type))).toEqual([]);
});

it('preserves deliveryUnknown from the original daemon handoff', async()=>{
  const f=fixture(),supervisor=f.build();
  const previous=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async input=> input.type==='beginHandoff'
    ? {kind:'handoff',handoff:{retryId:input.retryId,groupId:input.groupId,state:'deliveryUnknown'}}
    : previous(input));
  const result=await supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
  expect(result).toMatchObject({delivery:'deliveryUnknown'});
});

it.each(['deliveryUnknown','lostReply'] as const)('recovers the %s handoff by its original request and group without beginning twice',async fault=>{
  const f=fixture(),supervisor=f.build();
  const input={type:'creatorContinue' as const,accountId:f.accountId,retryId:randomUUID(),entry:{kind:'source' as const,viewId:'local',botId:f.botId,groupId:f.groupId}};
  const prior=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async request=>{
    if(request.type==='beginHandoff'){
      expect(request.retryId).toBe(input.retryId);
      if(fault==='lostReply')throw Error('fixture lost reply');
      return {kind:'handoff',handoff:{retryId:request.retryId,groupId:request.groupId,state:'deliveryUnknown'}};
    }
    if(request.type==='restoreHandoff'){
      expect(request).toMatchObject({retryId:input.retryId,expected:{kind:'source',groupId:f.groupId}});
      return {kind:'handoff',handoff:{retryId:request.retryId,groupId:request.expected.groupId,state:'selecting'}};
    }
    return prior(request);
  });
  if(fault==='lostReply')await expect(supervisor.continue(input)).rejects.toThrow();
  else expect(await supervisor.continue(input)).toMatchObject({delivery:'deliveryUnknown',retryId:input.retryId});
  expect(await supervisor.continue({...input,recover:'request'})).toMatchObject({delivery:'delivered',retryId:input.retryId});
  expect(f.rpc.mock.calls.filter(([r])=>r.type==='beginHandoff')).toHaveLength(1);
});
it('reports a role selection acknowledgement as queued and never reenqueues it while recovering a lost reply',async()=>{
  const f=await publicationFixture();
  const input={type:'creatorContinue' as const,accountId:f.accountId,retryId:randomUUID(),entry:{kind:'draft' as const,draftId:f.draft.draftId,revision:f.draft.revision}};
  expect(await f.supervisor.continue(input)).toMatchObject({delivery:'queued',retryId:input.retryId});
  expect(await f.supervisor.continue({...input,recover:'request'})).toMatchObject({kind:'creatorContinuing',accountId:f.accountId,retryId:input.retryId,delivery:'unverified',viewId:'local',botId:f.botId});
  expect(await f.supervisor.continue({...input,recover:'request',source:{viewId:'local',botId:f.botId}})).toMatchObject({delivery:'unverified',retryId:input.retryId});
  expect(f.rpcs.filter(r=>r.type==='creatorContinue')).toHaveLength(1);
});
it.each(['wrongRetry','wrongGroup','cancelled','expired','needsReview'] as const)('rejects %s handoffs instead of claiming a sent card',async kind=>{
  const f=fixture(),supervisor=f.build(),prior=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async request=>request.type==='beginHandoff'?{kind:'handoff',handoff:{
    retryId:kind==='wrongRetry'?randomUUID():request.retryId,groupId:kind==='wrongGroup'?groupIdSchema.parse('oc_other'):request.groupId,
    state:kind==='wrongGroup'||kind==='wrongRetry'?'selecting':kind}}:prior(request));
  await expect(supervisor.continue({type:'creatorContinue',accountId:f.accountId,retryId:randomUUID(),entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}})).rejects.toThrow();
});

it.each(['bindingIncarnation','registrationId'] as const)('checks the selected %s on the original device before beginning a new handoff',async field=>{
  const f=fixture(),supervisor=f.build();
  const entry={kind:'source' as const,botId:f.botId,viewId:'local',groupId:f.groupId,[field]:randomUUID()};
  await expect(supervisor.continue({type:'creatorContinue',retryId:randomUUID(),accountId:f.accountId,entry})).rejects.toThrow();
  expect(f.rpc.mock.calls.filter(([r])=>r.type==='beginHandoff')).toHaveLength(0);
});

it.each(['acknowledged','unverifiedPrepared','neverArrived'] as const)('checks an unavailable original %s handoff before reporting success',async evidence=>{
  const f=fixture(),supervisor=f.build(),prior=f.rpc.getMockImplementation()!,retryId=randomUUID();
  const input={type:'creatorContinue' as const,accountId:f.accountId,retryId,entry:{kind:'source' as const,viewId:'local',botId:f.botId,groupId:f.groupId}};
  f.rpc.mockImplementation(async request=>{
    if(request.type==='restoreHandoff')return {kind:'handoffUnavailable',retryId:request.retryId,reason:'notFound'};
    if(request.type==='beginHandoff'&&evidence==='unverifiedPrepared')return {kind:'handoff',handoff:{retryId,groupId:f.groupId,state:'prepared',operationId:randomUUID()}};
    return prior(request);
  });
  const recovery=supervisor.continue({...input,recover:evidence==='acknowledged'?'handoff':'request'});
  if(evidence==='neverArrived')await expect(recovery).resolves.toMatchObject({delivery:'delivered',retryId});
  else await expect(recovery).rejects.toThrow();
  expect(f.rpc.mock.calls.filter(([r])=>r.type==='beginHandoff').map(([r])=>'retryId' in r&&r.retryId)).toEqual(evidence==='acknowledged'?[]:[retryId]);
});
