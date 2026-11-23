import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,canonicalizeRichRecipeContent,groupIdSchema,type AccountStatus,type AuthoringOperation,
  type HandoffAttestation,type RecipeAuthoringReply,type RecipeAuthoringRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import {RecipeAuthoringController} from '../src/recipe-authoring';
import {AuthoringJournal} from '../src/recipe-authoring-journal';
import type {NativeAccount} from '../src/account-session';

const clean:Array<()=>void>=[];
afterEach(()=>{while(clean.length)clean.pop()!();});
function manifest(name:string){
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const {canonical}=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,
    public:{name:value(name),summary:value(''),overview:value(''),version:value('')},
    settings:[],rules:[],tasks:[],memories:[],skills:[],files:[],setup:[],parts:[]});
  return {canonical,metadata:{objectId:randomUUID(),kind:'manifest',sha256:createHash('sha256').update(canonical).digest('hex'),
    mediaType:'application/json',bytes:Buffer.byteLength(canonical)}};
}
function fixture(path?:string) {
  const accountId=randomUUID(),sourceIntentId=randomUUID(),draftId=randomUUID(),retryId=randomUUID(),
    deviceId=randomUUID(),deviceKey=Buffer.alloc(32,7).toString('base64url'),identity='c'.repeat(64);
  const botId=agentIdSchema.parse('cli_original'),groupId=groupIdSchema.parse('oc_original');
  const binding={accountId,viewId:'local' as const,deviceId,deviceKey,botId};
  const draft=manifest('目前的内容'),original=manifest('来源内容');
  const remote={sourceIntentId,deviceKey,identity,linked:true,operations:[] as AuthoringOperation[],pending:undefined as HandoffAttestation|undefined};
  const op:AuthoringOperation={operationId:sourceIntentId,format:'rich-v2',groupId,purpose:'prepareDraft',targetPublicKey:deviceKey,
    nonceCommitment:deviceKey,createdAt:Date.now(),deliveryUnknown:false,state:'completed',
    receipt:{operationId:sourceIntentId,status:'accepted',stateRevision:3,draftId,revision:1}};
  const calls:RecipeAuthoringRequest[]=[];
  const rpc=async (input:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
    calls.push(input);
    switch(input.type){
      case 'open':return {kind:'session',session:randomUUID(),leaseMs:45000,linked:remote.linked};
      case 'close':return {kind:'closed'};
      case 'workflow':return {kind:'workflow',activity:0,ageMs:0,pausedContexts:[],handoff:remote.pending};
      case 'status':return {kind:'status',operations:remote.operations,linked:remote.linked,reconciliation:[]};
      case 'operationSourceIdentity':return {kind:'operationSourceIdentity',operationId:sourceIntentId,groupId,identity};
      case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId,identity:remote.identity};
      case 'beginHandoff':case 'beginDraftHandoff':case 'answerHandoff':
        if(input.type==='beginHandoff' && input.retryId!==retryId)throw Error('active handoff');
        return {kind:'handoff',handoff:{groupId,retryId,draftId:input.type==='beginDraftHandoff'?draftId:undefined,state:'selecting'}};
      default:throw Error('unexpected RPC '+input.type);
    }
  };
  const client={device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,name:'来源设备',publicKey:remote.deviceKey},
    remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({agents:[{id:botId,name:'来源 Bot',running:true}],groups:[{id:groupId,name:'原群'}],memberships:[{agentId:botId,groupId}]}),
    recipeAuthoring:rpc} as unknown as VonvonClient;
  const signal=new AbortController();
  const state:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  const request=vi.fn(async(id:string,path:string)=>{
    expect(id).toBe(accountId);
    if(path==='/v1/me')return Response.json({accountId});
    if(path==='/v2/drafts/'+draftId)return Response.json({format:'rich-v2',draftId,sourceIntentId:remote.sourceIntentId,
      revision:2,manifest:draft.metadata,sourceManifest:original.metadata});
    for(const item of [draft,original])if(path==='/v2/drafts/'+draftId+'/objects/'+item.metadata.objectId)return new Response(item.canonical);
    if(path.startsWith('/v2/versions/'))return Response.json({versionId:path.split('/')[3],authorId:accountId,access:'direct',items:[]});
    throw Error(path);
  });
  const account:NativeAccount={lease:id=>id===accountId?signal.signal:undefined,status:()=>state,onStatus:()=>()=>{},
    login:async()=>state,cancelLogin:async()=>state,logout:async()=>state,request,dispose:async()=>{}};
  const build=()=>{
    const journal=new AuthoringJournal(path);
    const controller=new RecipeAuthoringController(account,viewId=>({viewId,client,check(){}}),journal);
    clean.push(()=>controller.closeAll());
    return {journal,controller};
  };
  const openDraft={type:'openDraftSource' as const,accountId,viewId:'local',baseRevision:2,draftId};
  return {build,binding,draftId,draft,original,op,openDraft,retryId,sourceIntentId,groupId,identity,remote,calls,request,signal};
}

it('backfills an old verified target from the exact daemon operation, then reopens after both journals expire',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'authoring-locator-'));
  clean.push(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'operations.json');
  const f=fixture(path),old=f.build();
  old.journal.history.remember(f.binding,f.sourceIntentId,f.identity);
  f.remote.operations.push(f.op);
  const first=await old.controller.request(f.openDraft);
  expect(first).toMatchObject({kind:'session',sourceGroup:{groupId:f.groupId,groupName:'原群'}});
  expect(f.calls.filter(r=>r.type==='operationSourceIdentity')).toHaveLength(1);
  old.controller.closeAll();
  unlinkSync(path);
  f.remote.operations.length=0;
  const fresh=f.build();
  const session=await fresh.controller.request(f.openDraft);
  if(session.kind!=='session')throw Error('session');
  await fresh.controller.request({type:'beginDraftHandoff',handle:session.handle,draftId:f.draftId,baseRevision:2,retryId:f.retryId});
  expect(f.calls.at(-1)).toMatchObject({type:'beginDraftHandoff',retryId:f.retryId,draftId:f.draftId,baseRevision:2,
    groupId:f.groupId,identity:f.identity,groupName:'原群',canonical:Buffer.from(f.draft.canonical).toString('base64url'),
    source:{sourceIntentId:f.sourceIntentId,canonical:Buffer.from(f.original.canonical).toString('base64url')}});
  expect(f.calls.filter(r=>r.type==='operationSourceIdentity')).toHaveLength(1);
});

it('uses the immutable account source digest and group from the original Main journal when the daemon operation has expired',async()=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity);
  journal.observe(f.binding,f.op);
  await expect(controller.request(f.openDraft)).resolves.toMatchObject({kind:'session',sourceGroup:{groupId:f.groupId}});
  expect(f.calls.map(r=>r.type)).not.toContain('operationSourceIdentity');
  expect(journal.history.locator(f.binding.accountId,f.sourceIntentId)).toMatchObject({identity:f.identity,groupId:f.groupId});
});

it('refuses unrelated owned intents, replaced device keys, changed registrations/groups, switched accounts and draft substitution',async()=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity,f.groupId);
  const session=await controller.request(f.openDraft);
  if(session.kind!=='session')throw Error('session');
  const begin={type:'beginDraftHandoff' as const,handle:session.handle,retryId:f.retryId,draftId:f.draftId,baseRevision:2};
  await expect(controller.request({...begin,draftId:randomUUID()})).rejects.toThrow();
  await expect(controller.request({...f.openDraft,accountId:randomUUID()})).rejects.toThrow();
  f.remote.sourceIntentId=randomUUID();
  await expect(controller.request(begin)).rejects.toThrow();
  await expect(controller.request(f.openDraft)).rejects.toThrow('来源记录');
  f.remote.sourceIntentId=f.sourceIntentId;
  f.remote.deviceKey=Buffer.alloc(32,3).toString('base64url');
  await expect(controller.request(f.openDraft)).rejects.toThrow('来源设备');
  f.remote.deviceKey=f.binding.deviceKey;
  f.remote.identity='f'.repeat(64);
  await expect(controller.request(f.openDraft)).rejects.toThrow('绑定');
  expect(f.calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(0);
});

it('retains a detached preparation and checks the complete attestation challenge again after authenticated source reads',async()=>{
  const f=fixture(),{controller}=f.build();
  const open={type:'open' as const,accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId};
  const session=await controller.request(open);
  if(session.kind!=='session')throw Error('session');
  const begin={type:'beginHandoff' as const,handle:session.handle,groupId:f.groupId,retryId:f.retryId};
  await controller.request(begin);
  await expect(controller.request({...begin,retryId:randomUUID()})).rejects.toThrow('active handoff');
  await controller.request({type:'detach',handle:session.handle});
  expect(await controller.request(open)).toMatchObject({handle:session.handle});
  expect(f.calls.filter(r=>r.type==='open')).toHaveLength(1);
  const version=randomUUID();
  const item={itemId:randomUUID(),kind:'role',baselineSha256:'c'.repeat(64)};
  const request:HandoffAttestation={retryId:f.retryId,ref:randomUUID(),generation:1,lease:'a'.repeat(64),versions:[version],items:[{versionId:version,itemIds:[item.itemId]}]};
  f.remote.pending=request;
  const normal=f.request.getMockImplementation()!;
  let finish!:()=>void;
  const held = new Promise<void>(resolve=>{finish=resolve;});
  f.request.mockImplementation(async(id,path)=>{
    if(path.endsWith('/source-items')){
      await held;
      return Response.json({versionId:version,authorId:f.binding.accountId,access:'direct',items:[item,{...item,itemId:randomUUID()}]});
    }
    return normal(id,path);
  });
  await controller.request({type:'status',handle:session.handle});
  await vi.waitFor(()=>expect(f.request.mock.calls.some(([,path])=>path.endsWith('/source-items'))).toBe(true));
  f.remote.pending={...request,generation:2,lease:'b'.repeat(64),ref:randomUUID()};
  finish();
  await vi.waitFor(()=>expect(f.calls.filter(r=>r.type==='workflow').length).toBeGreaterThan(3));
  await vi.waitFor(async()=>{
    await controller.request({type:'status',handle:session.handle});
    expect(f.calls.some(r=>r.type==='answerHandoff')).toBe(true);
  });
  const answers=f.calls.filter(r=>r.type==='answerHandoff');
  expect(answers.every(r=>r.request.generation===2)).toBe(true);
  expect(answers[0]).toMatchObject({request:f.remote.pending,attestations:[{versionId:version,authorId:f.binding.accountId,items:[item]}]});
});

it.each([403,404,503])('settles an unavailable attestation and retains transient failures for retry (%i)',async code=>{
  const f=fixture(),{controller}=f.build();
  const session=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',
    botId:f.binding.botId,groupId:f.groupId});
  if(session.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:session.handle,retryId:f.retryId,groupId:f.groupId});
  const version=randomUUID(),normal=f.request.getMockImplementation()!;
  const failed=vi.fn(()=>new Response('{}',{status:code}));
  f.request.mockImplementation((id,path)=>path.endsWith('/source-items')?Promise.resolve(failed()):normal(id,path));
  f.remote.pending={retryId:f.retryId,ref:randomUUID(),generation:3,lease:'f'.repeat(64),versions:[version]};
  await controller.request({type:'status',handle:session.handle});
  await vi.waitFor(()=>expect(failed).toHaveBeenCalledOnce());
  if(code===503){
    await controller.request({type:'status',handle:session.handle});
    expect(f.calls.filter(r=>r.type==='answerHandoff')).toEqual([]);
    expect(failed).toHaveBeenCalledOnce();
  }else{
    await vi.waitFor(()=>expect(f.calls.filter(r=>r.type==='answerHandoff')).toHaveLength(1));
    expect(f.calls.find(r=>r.type==='answerHandoff')).toMatchObject({request:f.remote.pending,attestations:[],unavailable:true});
  }
});
