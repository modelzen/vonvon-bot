import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,canonicalizeRichRecipeContent,type AccountStatus,type RecipeAuthoringRequest,type RecipeAuthoringReply} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import {RecipeCreatorSupervisor,type CreatorSourceLease} from '../src/recipe-creator-supervisor.js';
import {RecipeCreatorExecutor} from '../src/recipe-creator.js';
import {creatorSha,RecipeCreatorJournal} from '../src/recipe-creator-journal.js';
import {RecipeAuthoringController} from '../src/recipe-authoring.js';
import {AuthoringJournal} from '../src/recipe-authoring-journal.js';
import {MetadataJournal} from '../src/community-metadata-journal.js';
import type {NativeAccount} from '../src/account-session.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
function fixture(){
  const accountId=randomUUID(),other=randomUUID(),deviceId=randomUUID(),deviceKey=Buffer.alloc(32,3).toString('base64url'),botId=agentIdSchema.parse('cli_creator'),groupId=groupIdSchema.parse('oc_source');
  const sessions=new Map<string,string>(),bindings=new Map<string,string>([[accountId,randomUUID()],[other,randomUUID()]]),rpcs:RecipeAuthoringRequest[]=[];
  const signals=new Map([[accountId,new AbortController()],[other,new AbortController()]]),listeners=new Set<()=>void>();let active=accountId;
  const status=():AccountStatus=>({kind:'signedIn',accountId:active,displayName:'作者',provider:'google',persistence:'memory'});
  let handoff:Extract<RecipeAuthoringReply,{kind:'workflow'}>['handoff'];
  const rpc=vi.fn(async(input:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
    rpcs.push(input);
    switch(input.type){
      case 'creatorDiscover':return {kind:'creatorBinding',association:{binding:bindings.get(input.accountId)!,scope:'c'.repeat(64),recipient:{openId:'ou_author',chatId:groupId,tenantKey:'tenant'}},wakeId:null};
      case 'creatorOpen':{const session=sessions.get(input.accountId)??randomUUID();sessions.set(input.accountId,session);return {kind:'creatorSession',session,binding:input.binding,scope:input.scope,leaseMs:45000};}
      case 'creatorContinue':return {kind:'creatorAck'};
      case 'creatorPoll':return {kind:'creatorJobs',jobs:[]};
      case 'close':return {kind:'closed'};
      case 'workflow':return {kind:'workflow',activity:1,ageMs:0,pausedContexts:[],...(handoff&&{handoff})};
      case 'status':return {kind:'status',linked:true,operations:[],reconciliation:[]};
      case 'operationSourceIdentity':return {kind:'operationSourceIdentity',operationId:input.operationId,groupId,identity:'d'.repeat(64)};
      case 'beginDraftHandoff':return {kind:'handoff',handoff:{retryId:input.retryId,groupId,draftId:input.draftId,state:'selecting'}};
      case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId:input.groupId,identity:'d'.repeat(64)};
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
  const request=vi.fn(async(id:string,path:string)=>{
    if(path==='/v1/me')return Response.json({accountId:id});
    if(path.startsWith('/v2/versions/'))return Response.json({versionId:path.split('/')[3],authorId:id,access:'direct',items:[]});
    throw Error(path);
  });
  const account:NativeAccount={lease:id=>id===active?signals.get(id)?.signal:undefined,status,onStatus:listener=>{listeners.add(()=>listener(status()));return ()=>{};},
    login:async()=>status(),cancelLogin:async()=>status(),logout:async()=>status(),dispose:async()=>{},request};
  const history=new AuthoringJournal(),journal=new RecipeCreatorJournal(),metadata=new MetadataJournal();
  const authoring=new RecipeAuthoringController(account,()=>{throw Error('creator must not capture selected view');},history);
  cleanup.push(()=>authoring.closeAll());
  const executor=new RecipeCreatorExecutor(account,journal,metadata,history);
  const build=(sources:string[]=[])=>{const supervisor=new RecipeCreatorSupervisor(account,retain,()=>sources,journal,history,authoring,executor);cleanup.push(()=>supervisor.dispose());return supervisor;};
  return {accountId,other,botId,groupId,deviceId,deviceKey,account,authoring,history,journal,request,references,retain,rpcs,sessions,build,
    privateHandoff(){handoff={retryId:randomUUID(),ref:randomUUID(),generation:1,lease:'a'.repeat(64),versions:[randomUUID()]};return handoff;},
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
