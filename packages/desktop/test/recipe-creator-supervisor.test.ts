import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
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
const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
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
  const client={recipeAuthoring:rpc,device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,name:'原设备',publicKey:deviceKey},remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({agents:[{id:botId,name:'原 Bot',running:true}],memberships:[{agentId:botId,groupId}],groups:[{id:groupId,name:'原群'}]})} as unknown as VonvonClient;
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
  const history=new AuthoringJournal(),journal=new RecipeCreatorJournal(),metadata=new MetadataJournal();
  const authoring=new RecipeAuthoringController(account,()=>{throw Error('creator must not capture selected view');},history);
  cleanup.push(()=>authoring.closeAll());
  const executor=new RecipeCreatorExecutor(account,journal,metadata,history);
  const build=(sources:string[]=[])=>{const supervisor=new RecipeCreatorSupervisor(account,retain,()=>sources,journal,history,authoring,executor);cleanup.push(()=>supervisor.dispose());return supervisor;};
  return {accountId,other,botId,groupId,deviceId,deviceKey,account,authoring,history,journal,request,references,retain,rpcs,rpc,sessions,operations,build,
    privateHandoff(){handoff={retryId:randomUUID(),ref:randomUUID(),generation:1,lease:'a'.repeat(64),versions:[randomUUID()]};return handoff;},
    changeIdentity(){groupIdentity='e'.repeat(64);},
    switchAccount(){signals.get(active)!.abort();active=other;for(const listener of listeners)listener();},
  };
}

it('shares one creator session across works, never legacy-opens, and retains work through renderer close and view changes',async()=>{
  const f=fixture(),supervisor=f.build();
  const entry={kind:'source' as const,viewId:'local',botId:f.botId,groupId:f.groupId};
  await supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry});
  f.authoring.closeRenderer();
  await supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry});
  expect(f.rpcs.filter(r=>r.type==='creatorOpen')).toHaveLength(1);
  expect(f.rpcs.filter(r=>r.type==='open'||r.type==='close')).toEqual([]);
  const begins=f.rpcs.filter(r=>r.type==='beginHandoff');expect(begins).toHaveLength(2);
  expect(begins[0]?.session).toBe(f.sessions.get(f.accountId));expect(begins[1]?.session).toBe(f.sessions.get(f.accountId));
  expect(f.references[0]?.release).not.toHaveBeenCalled();
  supervisor.dispose();expect(f.references[0]?.release).toHaveBeenCalledOnce();expect(f.rpcs.filter(r=>r.type==='close')).toHaveLength(1);
});

it('restores only persisted associations on relaunch and stops original leases before using another account',async()=>{
  const f=fixture(),first=f.build();
  await first.associated(f.accountId,'local',f.botId);first.dispose();
  const second=f.build();await settle();
  await second.continue({type:'creatorContinue',accountId:f.accountId,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
  expect(f.rpcs.filter(r=>r.type==='creatorOpen')).toHaveLength(2);
  f.switchAccount();await settle();
  expect(f.references[1]?.release).toHaveBeenCalledOnce();
  await second.continue({type:'creatorContinue',accountId:f.other,entry:{kind:'source',viewId:'local',botId:f.botId,groupId:f.groupId}});
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

it('discovers an existing rich draft original source by exact authenticated operation and never asks for another device',async()=>{
  const f=fixture(),supervisor=f.build(),draftId=randomUUID(),preparationId=randomUUID(),objectId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const document=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:value('原草稿'),summary:value(''),overview:value(''),version:value('')},
    settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});
  const manifest={objectId,kind:'manifest',sha256:creatorSha(document.canonicalUTF8),bytes:document.canonicalUTF8.length,mediaType:'application/json'};
  f.request.mockImplementation(async(id,path)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path==='/v2/drafts/'+draftId)return Response.json({format:'rich-v2',draftId,recipeId:null,revision:2,access:'direct',sourceIntentId:preparationId,
      manifest,sourceManifest:manifest,logicalBytes:document.logicalBytes,retainedCandidateBytes:0});
    if(path==='/v2/drafts/'+draftId+'/objects/'+objectId)return new Response(document.canonical);
    throw Error(path);
  });
  expect(f.history.history.locator(f.accountId,preparationId)).toBeUndefined();
  expect(await supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry:{kind:'draft',draftId,revision:2}})).toEqual({kind:'creatorContinuing',accountId:f.accountId,viewId:'local',botId:f.botId});
  expect(f.history.history.locator(f.accountId,preparationId)).toMatchObject({deviceId:f.deviceId,deviceKey:f.deviceKey,botId:f.botId,groupId:f.groupId,identity:'d'.repeat(64)});
  expect(f.rpcs.find(r=>r.type==='beginDraftHandoff')).toMatchObject({session:f.sessions.get(f.accountId),draftId,baseRevision:2,groupId:f.groupId,
    source:{sourceIntentId:preparationId,canonical:Buffer.from(document.canonicalUTF8).toString('base64url')}});
  expect(f.rpcs.filter(r=>r.type==='open')).toEqual([]);
});

async function existingRichDraft(state:'waiting'|'candidate'='waiting'){
  const f=fixture(),supervisor=f.build(),draftId=randomUUID(),preparationId=randomUUID(),objectId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const document=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:value('原草稿'),summary:value(''),overview:value(''),version:value('1.1')},
    settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});
  const manifest={objectId,kind:'manifest',sha256:creatorSha(document.canonicalUTF8),bytes:document.canonicalUTF8.length,mediaType:'application/json'};
  f.history.history.remember(f.journal.associations(f.accountId)[0]!,preparationId,'d'.repeat(64),f.groupId);
  const operation:AuthoringOperation={operationId:randomUUID(),format:'rich-v2',purpose:'editDraft',draftId,baseRevision:2,state,createdAt:Date.now()-31*60_000,
    targetPublicKey:f.deviceKey,nonceCommitment:f.deviceKey,deliveryUnknown:false,...(state==='candidate'&&{payloadDigest:'a'.repeat(64)})};
  f.operations.push(operation);
  f.request.mockImplementation(async(id,path)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path==='/v2/drafts/'+draftId)return Response.json({format:'rich-v2',draftId,recipeId:null,revision:2,access:'direct',sourceIntentId:preparationId,
      manifest,sourceManifest:manifest,logicalBytes:document.logicalBytes,retainedCandidateBytes:0});
    if(path==='/v2/drafts/'+draftId+'/objects/'+objectId)return new Response(document.canonical);
    throw Error(path);
  });
  return {...f,supervisor,draftId,preparationId,operation,continueDraft:()=>supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry:{kind:'draft',draftId,revision:2}})};
}

it.each(['waiting','candidate'] as const)('continues the exact existing rich %s operation without starting another private handoff',async(state)=>{
  const f=await existingRichDraft(state),{operation,draftId,preparationId}=f;
  const before=structuredClone(operation);
  expect(await f.continueDraft()).toEqual({kind:'creatorContinuing',accountId:f.accountId,viewId:'local',botId:f.botId});
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
  expect(await supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry:{kind:'version',recipeId,versionId}})).toMatchObject({kind:'creatorContinuing',viewId:'local'});
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
  await expect(supervisor.continue({type:'creatorContinue',accountId:f.accountId,entry:{kind:'version',recipeId,versionId}})).rejects.toThrow('来源不能替换');
  expect(f.request.mock.calls.filter(([,path])=>path.includes('/recipes/'))).toHaveLength(0);
  expect(f.journal.version(f.accountId,versionId)?.deviceKey).not.toBe(f.deviceKey);
  expect(f.rpcs.filter(r=>r.type==='creatorContinue')).toHaveLength(0);
});

async function publicationFixture(){
  const f=fixture(),supervisor=f.build(),draftId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID();
  await supervisor.associated(f.accountId,'local',f.botId);await settle();
  const association=f.journal.associations(f.accountId)[0]!;
  const draft={draftId,recipeId:null,revision:2,public:{name:'App 预览',version:'1',summary:'简介',overview:'完整概览',access:'direct' as const},config:{role:'完整角色正文'}};
  let current:CreatorJob|undefined,state:'preparing'|'offer'|'active'|'unknown'|'finished'='preparing',result:CreatorAnswer|undefined;
  let loseResponse=false,receiptAvailable=true,retired=false;
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
      if(!receiptAvailable)return Response.json({status:'unknown'});
      return Response.json({status:'committed',receipt:{requestId:current!.id,format:'role-v1',draftId,draftRevision:2,recipeId,versionId,revision:1,public:draft.public,firstCodeId:null}});
    }
    if(path===`/v1/drafts/${draftId}/publish`){retired=true;if(loseResponse)throw Error('lost response');return Response.json({recipeId,versionId,revision:1,public:draft.public});}
    if(retired)throw Error('retired draft must not be re-read');
    if(path==='/v2/drafts/'+draftId)return Response.json({error:{code:'not_found'}},{status:404});
    if(path==='/v1/drafts/'+draftId)return Response.json(draft);
    if(path.startsWith(`/v1/drafts/${draftId}/creator-context?`))return Response.json({draftId,format:'role-v1',revision:draft.revision,sourceIntentId:null,parent:null});
    throw Error(path+' '+init?.method);
  });
  const prepare=()=>supervisor.preparePublication({type:'preparePublication',accountId:f.accountId,draft:structuredClone(draft)});
  const confirm=(reviewId:string)=>supervisor.confirmPublication({type:'confirmPublication',accountId:f.accountId,reviewId});
  return {...f,supervisor,draft,prepare,confirm,recipeId,versionId,current:()=>current,
    lost(){loseResponse=true;receiptAvailable=false;},receipt(){receiptAvailable=true;},active(){state='active';},
    restart(){supervisor.dispose();return f.build();}};
}

it('APP PUBLICATION prepares exact readonly bytes without publishing and confirms through the existing executor once',async()=>{
  const f=await publicationFixture();
  const ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  expect(f.request.mock.calls.some(([,path,init])=>path.endsWith('/publish')||init?.method==='POST')).toBe(false);
  expect(f.rpcs.some(r=>r.type==='creatorContinue'||r.type==='beginDraftHandoff'||r.type==='beginHandoff')).toBe(false);
  const repeated=await f.prepare();expect(repeated).toEqual(ready);
  const results=await Promise.all([f.confirm(ready.reviewId),f.confirm(ready.reviewId)]);
  for(const reply of results)expect(reply).toEqual({kind:'publicationResult',result:{kind:'published',publication:{accountId:f.accountId,draftId:f.draft.draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1}}});
  expect(f.request.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
  expect(f.journal.command(f.accountId,f.current()!.id)?.grant.confirmation?.kind).toBe('app');
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toHaveLength(1);
});

it.each(['account','revision','content','review','saved'] as const)('APP PUBLICATION refuses changed %s before authorization',async(change)=>{
  const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  let reviewId=ready.reviewId;
  if(change==='account')f.switchAccount();
  if(change==='revision')f.draft.revision++;
  if(change==='content')f.draft.config.role='changed behind preview';
  if(change==='review')reviewId=randomUUID();
  if(change==='saved')f.supervisor.invalidateDraft(f.accountId,f.draft.draftId);
  await expect(f.confirm(reviewId)).rejects.toThrow();
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toEqual([]);
  expect(f.request.mock.calls.some(([,path])=>path.endsWith('/publish'))).toBe(false);
});

it('APP PUBLICATION recovers the exact unknown job after restart and retired draft without another publisher or POST',async()=>{
  const f=await publicationFixture(),ready=await f.prepare();if(ready.kind!=='publicationReady')throw Error('not ready');
  f.lost();expect(await f.confirm(ready.reviewId)).toEqual({kind:'publicationResult',result:{kind:'pending'}});
  const original=f.current()!.id;
  const restarted=f.restart();await settle();f.receipt();
  const recovered=await restarted.preparePublication({type:'preparePublication',accountId:f.accountId,draft:f.draft});
  expect(recovered).toMatchObject({kind:'publicationResult',result:{kind:'published',publication:{draftId:f.draft.draftId,versionId:f.versionId}}});
  expect(f.current()!.id).toBe(original);
  expect(f.request.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
  expect(f.rpcs.filter(r=>r.type==='creatorAppConfirm')).toHaveLength(1);
});

it('APP PUBLICATION gives controlled source recovery guidance without exposing transport details',async()=>{
  const f=await publicationFixture();
  f.references[0]!.owner.abort();f.retain.mockRejectedValue(new Error('transport bearer=private-secret'));
  const error:unknown=await f.prepare().catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(AuthoringError);
  if(!(error instanceof AuthoringError))throw Error('expected safe authoring failure');
  expect(error.message).toContain('保持原来源 Bot 在线');expect(error.message).not.toContain('private-secret');
});
