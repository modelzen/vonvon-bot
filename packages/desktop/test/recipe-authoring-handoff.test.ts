import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,canonicalizeRichRecipeContent,groupIdSchema,type AccountStatus,type AuthoringFieldRequest,type AuthoringOperation,type AuthoringReceipt,
  desktopAuthoringRequestSchema,type HandoffAttestation,type RecipeAuthoringReply,type RecipeAuthoringRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import {RecipeAuthoringController} from '../src/recipe-authoring';
import {AuthoringJournal} from '../src/recipe-authoring-journal';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts';
import {AccountFault} from '../src/account-auth';
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
  const remote={sourceIntentId,deviceKey,identity,linked:true,missing:false,handoffDraft:false,statusFailures:0,cloudReceipt:undefined as AuthoringReceipt|undefined,operations:[] as AuthoringOperation[],field:undefined as AuthoringFieldRequest|undefined,pending:undefined as HandoffAttestation|undefined};
  const op:AuthoringOperation={operationId:sourceIntentId,format:'rich-v2',groupId,purpose:'prepareDraft',targetPublicKey:deviceKey,
    nonceCommitment:deviceKey,createdAt:Date.now(),deliveryUnknown:false,state:'completed',
    receipt:{operationId:sourceIntentId,status:'accepted',stateRevision:3,draftId,revision:1}};
  const calls:RecipeAuthoringRequest[]=[];
  const rpc=vi.fn(async (input:RecipeAuthoringRequest):Promise<RecipeAuthoringReply>=>{
    calls.push(input);
    switch(input.type){
      case 'open':return {kind:'session',session:randomUUID(),leaseMs:45000,linked:remote.linked};
      case 'close':return {kind:'closed'};
      case 'workflow':return {kind:'workflow',activity:0,ageMs:0,pausedContexts:[],handoff:remote.pending,field:remote.field};
      case 'status':if(remote.statusFailures-->0)throw Error('transient status failure');return {kind:'status',
        operations:remote.operations.filter(op=>input.operationId===undefined||op.operationId===input.operationId),linked:remote.linked,reconciliation:[]};
      case 'operationSourceIdentity':return {kind:'operationSourceIdentity',operationId:sourceIntentId,groupId,identity};
      case 'groupSourceIdentity':return {kind:'groupSourceIdentity',groupId,identity:remote.identity};
      case 'handoffStatus':return {kind:'handoff',handoff:{retryId:input.retryId,groupId,
        ...(remote.handoffDraft&&{draftId}),
        ...(remote.operations[0]?{state:'prepared',operationId:remote.operations[0].operationId}:{state:'selecting'})}};
      case 'restoreHandoff':
        if(remote.missing)return {kind:'handoffUnavailable',retryId:input.retryId,reason:'notFound'};
        remote.handoffDraft=input.expected.kind==='draft';
        return {kind:'handoff',handoff:{retryId:input.retryId,groupId,...(input.expected.kind==='draft'&&{draftId:input.expected.draftId}),
          ...(remote.operations[0]?{state:'prepared',operationId:remote.operations[0].operationId}:{state:'selecting'})}};
      case 'settle':{
        const operation=remote.operations.find(op=>op.operationId===input.operationId);
        if(!operation)throw Error('missing original operation');
        operation.state=input.receipt.status==='accepted'?'completed':input.receipt.status;operation.receipt=input.receipt;
        return {kind:'operation',operation};
      }
      case 'beginHandoff':case 'beginDraftHandoff':case 'answerHandoff':
        if(input.type==='beginHandoff' && input.retryId!==retryId)throw Error('active handoff');
        return {kind:'handoff',handoff:{groupId,retryId,draftId:input.type==='beginDraftHandoff'?draftId:undefined,state:'selecting'}};
      default:throw Error('unexpected RPC '+input.type);
    }
  });
  const client={device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,name:'来源设备',publicKey:remote.deviceKey},
    remote:{addresses:[],port:3000},clients:{active:1,total:1}}}),
    snapshot:async()=>({agents:[{id:botId,name:'来源 Bot',running:true}],groups:[{id:groupId,name:'原群'}],memberships:[{agentId:botId,groupId}]}),
    recipeAuthoring:rpc} as unknown as VonvonClient;
  const signal=new AbortController();
  const state:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  const request=vi.fn(async(id:string,path:string)=>{
    expect(id).toBe(accountId);
    if(path==='/v1/me')return Response.json({accountId});
    if(path.startsWith('/v2/authoring/')&&path.endsWith('/recovery'))
      return remote.cloudReceipt?Response.json({format:'rich-v2',...remote.cloudReceipt}):new Response('{}',{status:503});
    if(path.startsWith('/v2/versions/'))return Response.json({versionId:path.split('/')[3],authorId:accountId,access:'direct',items:[]});
    throw Error(path);
  });
  const account:NativeAccount={lease:id=>id===accountId?signal.signal:undefined,status:()=>state,onStatus:()=>()=>{},
    login:async()=>state,cancelLogin:async()=>state,logout:async()=>state,request,dispose:async()=>{}};
  const drafts=new LocalRecipeDrafts();clean.push(()=>drafts.close());
  const record:LocalRecipeDraftRecord={association:{...binding,binding:randomUUID(),scope:'a'.repeat(64)},
    work:{draftId,source:{preparationId:sourceIntentId,groupId,identity}},sourceCanonical:Buffer.from(original.canonical).toString('base64url'),members:[],
    draft:{format:'rich-v2',draftId,recipeId:null,revision:2,sourceIntentId,public:{name:'目前的内容',summary:'',overview:'',version:'',access:'direct'},rich:{content:JSON.parse(draft.canonical).content??JSON.parse(draft.canonical),canonical:Buffer.from(draft.canonical).toString('base64url'),texts:{}}}};
  for(let revision=1;revision<=2;revision++)drafts.commit({requestId:randomUUID(),expectedRevision:revision===1?null:revision-1,record:{...record,draft:{...record.draft,revision}}});
  const build=()=>{
    const journal=new AuthoringJournal(path);
    const controller=new RecipeAuthoringController(account,viewId=>({viewId,client,check(){}}),journal,undefined,drafts);
    clean.push(()=>controller.closeAll());
    return {journal,controller};
  };
  const openDraft={type:'openDraftSource' as const,accountId,viewId:'local',baseRevision:2,draftId};
  return {build,binding,draftId,draft,original,op,openDraft,retryId,sourceIntentId,groupId,identity,remote,calls,rpc,request,signal,drafts,record};
}
it.each([404,503])('prepares local items when an unrelated source is deleted, and retries transport failures (%i)',async status=>{
  const f=fixture(),{controller}=f.build();
  const session=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(session.kind!=='session')throw Error('session');
  const removed=randomUUID(),accessible=randomUUID(),reviewToken='a'.repeat(64),content=JSON.parse(f.original.canonical);
  const rpc=f.rpc.getMockImplementation()!,http=f.request.getMockImplementation()!;
  f.request.mockImplementation((id,path)=>path==='/v2/versions/'+removed+'/source-items'?Promise.resolve(new Response('{}',{status})):http(id,path));
  f.rpc.mockImplementation(async req=>{
    if(req.type==='richInventory')return {kind:'richInventory',groupId:f.groupId,inventory:{reviewToken,content,versions:[removed,accessible],unavailable:[]}};
    if(req.type==='richPrepare')return {kind:'operation',operation:f.op};
    return rpc(req);
  });
  const prepare=controller.request({type:'richPrepare',handle:session.handle,groupId:f.groupId,selection:{
    options:{skills:[],includeTasks:false,includeBotMemories:false},selected:[content.public.name.itemId],sourceAttested:true,
    public:{name:'新配方',summary:'',overview:'',version:'1.0'},reviewToken,access:'direct',setup:[],
  }});
  if(status===404){
    await expect(prepare).resolves.toMatchObject({kind:'operation'});
    expect(f.rpc.mock.calls.flatMap(([req])=>req.type==='richPrepare'?req.attestations.map(a=>a.versionId):[])).toEqual([accessible]);
  }else{
    await expect(prepare).rejects.toThrow();
    expect(f.rpc.mock.calls.some(([req])=>req.type==='richPrepare')).toBe(false);
  }
});
function gate(){
  let release!:()=>void;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  return {ready,release};
}

it('reopens only the locally saved draft after operation journals expire and never imports an old cloud draft',async()=>{
  const f=fixture(),first=f.build();
  const session=await first.controller.request(f.openDraft);
  expect(session).toMatchObject({kind:'session',sourceGroup:{groupId:f.groupId}});
  first.controller.closeAll();f.remote.operations=[];
  const fresh=f.build();
  await expect(fresh.controller.request(f.openDraft)).resolves.toMatchObject({kind:'session',sourceGroup:{groupId:f.groupId}});
  f.drafts.discard({accountId:f.binding.accountId,draftId:f.draftId,requestId:randomUUID(),expectedRevision:2});
  await expect(fresh.controller.request(f.openDraft)).rejects.toThrow();
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
  expect(f.calls.filter(r=>r.type==='operationSourceIdentity')).toEqual([]);
});

it('uses the immutable account source digest and group from the original Main journal when the daemon operation has expired',async()=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity);
  journal.observe(f.binding,f.op);
  await expect(controller.request(f.openDraft)).resolves.toMatchObject({kind:'session',sourceGroup:{groupId:f.groupId}});
  expect(f.calls.map(r=>r.type)).not.toContain('operationSourceIdentity');
  expect(f.drafts.read(f.binding.accountId,f.draftId)?.work.source).toMatchObject({identity:f.identity,groupId:f.groupId});
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
  await expect(controller.request(begin)).resolves.toMatchObject({kind:'handoff'});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
  f.remote.sourceIntentId=f.sourceIntentId;
  f.remote.deviceKey=Buffer.alloc(32,3).toString('base64url');
  await expect(controller.request(f.openDraft)).rejects.toThrow('来源设备');
  f.remote.deviceKey=f.binding.deviceKey;
  f.remote.identity='f'.repeat(64);
  await expect(controller.request(f.openDraft)).rejects.toThrow('绑定');
  expect(f.calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(1);
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


it.each([false,true])('restores the exact edit receipt after its original revision advances (revoked %s)',async revoked=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity,f.groupId);
  const session=await controller.request(f.openDraft);
  if(session.kind!=='session')throw Error('session');
  const edit:AuthoringOperation={...f.op,groupId:undefined,operationId:randomUUID(),purpose:'editDraft',draftId:f.draftId,baseRevision:2,state:'pendingCloud',receipt:undefined};
  f.remote.operations=[edit];
  await controller.request({type:'status',handle:session.handle});
  f.remote.cloudReceipt={operationId:edit.operationId,status:'accepted',stateRevision:3,draftId:f.draftId,revision:3};
  const normal=f.request.getMockImplementation()!;
  f.request.mockImplementation((id,path)=>path==='/v2/drafts/'+f.draftId
    ?Promise.resolve(Response.json({format:'rich-v2',draftId:f.draftId,sourceIntentId:f.sourceIntentId,revision:3,manifest:f.draft.metadata,sourceManifest:f.original.metadata}))
    :normal(id,path));
  if(revoked){
    await controller.request({type:'close',handle:session.handle});
    await expect(controller.request({type:'status',handle:session.handle})).rejects.toThrow('账号或设备连接已改变');
  }
  const before=f.request.mock.calls.length;
  const restored=await controller.request(desktopAuthoringRequestSchema.parse({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',
    handle:session.handle,retryId:f.retryId,target:{kind:'draft',draftId:f.draftId,baseRevision:2}}));
  expect(restored).toMatchObject({kind:'handoffRestored',handoff:{retryId:f.retryId,operationId:edit.operationId},
    session:{operations:[expect.objectContaining({operationId:edit.operationId,receipt:expect.objectContaining({draftId:f.draftId,revision:3})})]}});
  expect(f.calls.filter(r=>r.type==='beginDraftHandoff')).toHaveLength(0);
  expect(f.request.mock.calls.slice(before).some(([,path])=>path.includes('/objects/'))).toBe(false);
  if(!revoked)expect(f.request.mock.calls.slice(before).some(([,path])=>path==='/v2/drafts/'+f.draftId)).toBe(false);
  await expect(controller.request(f.openDraft)).resolves.toMatchObject({kind:'session'});
  if(restored.kind!=='handoffRestored')throw Error('restored');
  if(revoked)expect(restored.session.handle).not.toBe(session.handle);
  else expect(restored.session.handle).toBe(session.handle);
  expect(f.drafts.read(f.binding.accountId,f.draftId)?.draft.revision).toBe(2);
  expect(f.request.mock.calls.every(([,path])=>!path.includes('/objects/'))).toBe(true);
});


it('preserves a valid old handle after a transient restore read and revokes an actual device-key mismatch',async()=>{
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:opened.handle,groupId:f.groupId,retryId:f.retryId});
  const restore=desktopAuthoringRequestSchema.parse({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',handle:opened.handle,
    retryId:f.retryId,target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}});
  f.remote.statusFailures=1;
  await expect(controller.request(restore)).rejects.toThrow('transient status failure');
  await expect(controller.request({type:'status',handle:opened.handle})).resolves.toMatchObject({kind:'session',handle:opened.handle});
  expect(f.calls.filter(r=>r.type==='open')).toHaveLength(1);
  f.remote.deviceKey=Buffer.alloc(32,9).toString('base64url');
  await expect(controller.request(restore)).rejects.toThrow();
  await expect(controller.request({type:'status',handle:opened.handle})).rejects.toThrow();
  expect(f.calls.filter(r=>r.type==='beginHandoff')).toHaveLength(1);
});


it('serializes a local draft restore while account identity is pending, then allows a fresh preparation',async()=>{
  const f=fixture(),{controller}=f.build(),open={type:'open' as const,accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId};
  const old=await controller.request(f.openDraft);if(old.kind!=='session')throw Error('session');
  await controller.request({type:'close',handle:old.handle});
  const resume=gate(),started=gate(),normal=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(id,path)=>{if(path==='/v1/me'){started.release();await resume.ready;}return normal(id,path);});
  const pending=controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',handle:old.handle,retryId:f.retryId,target:{kind:'draft',draftId:f.draftId,baseRevision:2}});
  await started.ready;
  await expect(controller.request(open)).rejects.toThrow('正在连接');
  resume.release();await expect(pending).resolves.toMatchObject({kind:'handoffRestored'});
  const fresh=await controller.request(open);if(fresh.kind!=='session')throw Error('session');
  await expect(controller.request({type:'status',handle:fresh.handle})).resolves.toMatchObject({kind:'session',handle:fresh.handle});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each([403,503])('requires online account confirmation before restoring an old handle (%s)',async code=>{
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:opened.handle,groupId:f.groupId,retryId:f.retryId});
  const normal=f.request.getMockImplementation()!;
  f.request.mockImplementation((id,path)=>path==='/v1/me'?Promise.resolve(new Response('{}',{status:code})):normal(id,path));
  const before=f.calls.length;
  await expect(controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',handle:opened.handle,
    retryId:f.retryId,target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}})).rejects.toThrow();
  expect(f.calls.slice(before).filter(r=>r.type==='restoreHandoff')).toEqual([]);
});

it('keeps restored source handles confined to their retry and original operation',async()=>{
  const f=fixture(),{controller}=f.build();
  const restored=await controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}});
  if(restored.kind!=='handoffRestored')throw Error('restored');
  const before=f.calls.length;
  const handle=restored.session.handle;
  await expect(controller.request({type:'reviewSource',handle,groupId:f.groupId})).rejects.toThrow();
  await expect(controller.request({type:'richInventory',handle,groupId:f.groupId,options:{skills:[],includeTasks:false,includeBotMemories:false}})).rejects.toThrow();
  await expect(controller.request({type:'prepare',handle,groupId:f.groupId,reviewToken:'c'.repeat(64),sourceAttested:true})).rejects.toThrow();
  await expect(controller.request({type:'richPrepare',handle,groupId:f.groupId,selection:{options:{skills:[],includeTasks:false,includeBotMemories:false},
    selected:[],reviewToken:'c'.repeat(64),sourceAttested:true,public:{name:'fixture',summary:'',overview:'',version:'1'},access:'direct',setup:[]}})).rejects.toThrow();
  await expect(controller.request({type:'handoffStatus',handle,retryId:randomUUID()})).rejects.toThrow();
  await expect(controller.request({type:'cancel',handle,operationId:randomUUID()})).rejects.toThrow();
  expect(f.calls.slice(before).some(r=>['reviewSource','richInventory','prepare','richPrepare','handoffStatus','cancel'].includes(r.type))).toBe(false);
});

it.each([false,true])('restores and polls only the original operation without updating another group card (already prepared %s)',async prepared=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity,f.groupId);
  const original={...f.op};
  const other={...f.op,operationId:randomUUID(),groupId:groupIdSchema.parse('oc_other'),cardUpdate:'pending' as const,state:'pendingMain' as const,receipt:undefined};
  f.remote.operations=prepared?[original,other]:[];
  const restored=await controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}});
  if(restored.kind!=='handoffRestored')throw Error('restored');
  f.remote.operations=[original,other];
  f.remote.field={requestId:randomUUID(),operationId:other.operationId,draftId:f.draftId,revision:1,field:'name'};
  await controller.request({type:'handoffStatus',handle:restored.session.handle,retryId:f.retryId});
  const updated=await controller.request({type:'status',handle:restored.session.handle});
  if(updated.kind!=='session')throw Error('session');
  expect(f.calls.filter(r=>r.type==='answerField')).toEqual([]);
  expect(f.calls.filter(r=>'operationId' in r&&r.operationId===other.operationId)).toEqual([]);
  expect(f.request.mock.calls.some(([,path])=>path.includes(other.operationId))).toBe(false);
  expect(updated.operations.map(op=>op.operationId)).toEqual([original.operationId]);
});

it('recovers the original legacy edit by read-only receipt lookup after a restored selecting dialog is detached',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity,f.groupId);
  const restored=await controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'draft',draftId:f.draftId,baseRevision:2}});
  if(restored.kind!=='handoffRestored')throw Error('restored');
  expect(restored.handoff.state).toBe('selecting');
  await controller.request({type:'detach',handle:restored.session.handle});
  const edit:AuthoringOperation={...f.op,operationId:randomUUID(),purpose:'editDraft',groupId:undefined,
    draftId:f.draftId,baseRevision:2,state:'pendingMain',receipt:undefined};
  const other:AuthoringOperation={...f.op,operationId:randomUUID(),groupId:groupIdSchema.parse('oc_other'),
    state:'pendingMain',cardUpdate:'pending',receipt:undefined};
  f.remote.operations=[edit,other];
  f.remote.cloudReceipt={operationId:edit.operationId,status:'accepted',stateRevision:3,draftId:f.draftId,revision:3};
  f.remote.field={requestId:randomUUID(),operationId:other.operationId,draftId:f.draftId,revision:1,field:'name'};
  const before=f.calls.length;
  for(let i=0;i<5;i++)await vi.advanceTimersByTimeAsync(3000);
  expect(edit).toMatchObject({state:'completed',receipt:f.remote.cloudReceipt});
  expect(f.calls.slice(before).filter(r=>r.type==='handoffStatus')).not.toHaveLength(0);
  expect(f.calls.slice(before).filter(r=>r.type==='handoffStatus').every(r=>r.retryId===f.retryId)).toBe(true);
  expect(f.calls.slice(before).filter(r=>r.type==='status').every(r=>r.operationId===edit.operationId)).toBe(true);
  expect(f.calls.slice(before).some(r=>'operationId' in r&&r.operationId===other.operationId||r.type==='answerField')).toBe(false);
  expect(f.request.mock.calls.some(([,path])=>path.includes(edit.operationId))).toBe(true);
  expect(f.request.mock.calls.some(([,path])=>path.includes(other.operationId))).toBe(false);
});

it.each([false,true])('holds new Bot opens until local draft restore resolves (unavailable %s)',async missing=>{
  const f=fixture(),{controller}=f.build(),open={type:'open' as const,accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId};
  const old=await controller.request(f.openDraft);if(old.kind!=='session')throw Error('session');
  await controller.request({type:'close',handle:old.handle});
  const resume=gate(),started=gate(),normal=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(id,path)=>{if(path==='/v1/me'){started.release();await resume.ready;}return normal(id,path);});
  const pending=controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',handle:old.handle,retryId:f.retryId,target:{kind:'draft',draftId:f.draftId,baseRevision:2}});
  await started.ready;
  await expect(controller.request(open)).rejects.toThrow('正在连接');
  f.remote.missing=missing;resume.release();
  await expect(pending).resolves.toMatchObject({kind:missing?'handoffUnavailable':'handoffRestored'});
  await expect(controller.request(open)).resolves.toMatchObject({kind:'session'});
  expect(f.request.mock.calls.every(([,path])=>path==='/v1/me')).toBe(true);
});

it.each(['503','network','timeout','offline account'])('pauses writes without closing a valid handle after transient presence failure (%s)',async failure=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:opened.handle,groupId:f.groupId,retryId:f.retryId});
  const restore={type:'restoreHandoff' as const,accountId:f.binding.accountId,viewId:'local',handle:opened.handle,
    retryId:f.retryId,target:{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}};
  const normal=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(id,path)=>{
    if(path!=='/v1/me')return normal(id,path);
    if(failure==='network')throw new TypeError('fetch failed');
    if(failure==='timeout')throw new DOMException('timed out','TimeoutError');
    if(failure==='offline account')throw new AccountFault('offline');
    return new Response('temporarily unavailable',{status:503});
  });
  const before=f.calls.length,checks=f.request.mock.calls.length;
  await expect(controller.request(restore)).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.calls.slice(before)).toEqual([]);
  expect(f.request.mock.calls.slice(checks).filter(([,path])=>path==='/v1/me').length).toBeGreaterThan(1);
  f.request.mockImplementation(normal);
  await expect(controller.request(restore)).resolves.toMatchObject({kind:'handoffRestored',session:{handle:opened.handle}});
  await expect(controller.request({type:'status',handle:opened.handle})).resolves.toMatchObject({kind:'session',handle:opened.handle});
  expect(f.calls.filter(r=>r.type==='open')).toHaveLength(1);
});

it('does not answer a pending field after a transient online confirmation failure',async()=>{
  const f=fixture(),{controller}=f.build();
  f.remote.operations=[f.op];
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  f.remote.field={requestId:randomUUID(),operationId:f.op.operationId,draftId:f.draftId,revision:1,field:'name'};
  const normal=f.request.getMockImplementation()!;
  f.request.mockImplementation((id,path)=>path==='/v1/me'?Promise.resolve(new Response('{}',{status:503})):normal(id,path));
  const before=f.calls.length;
  await expect(controller.request({type:'status',handle:opened.handle})).rejects.toThrow();
  expect(f.calls.slice(before).filter(r=>r.type==='answerField'||r.type==='close')).toEqual([]);
  f.remote.field=undefined;
  f.request.mockImplementation(normal);
  await expect(controller.request({type:'status',handle:opened.handle})).resolves.toMatchObject({kind:'session',handle:opened.handle});
});

it('pauses an in-flight restore when a background account confirmation fails',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  const session=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(session.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:session.handle,retryId:f.retryId,groupId:f.groupId});
  const restore={type:'restoreHandoff' as const,accountId:f.binding.accountId,viewId:'local',handle:session.handle,
    retryId:f.retryId,target:{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}};
  const atStatus=gate(),resume=gate(),events:string[]=[];
  const normalRpc=f.rpc.getMockImplementation()!,normalAccount=f.request.getMockImplementation()!;
  let hold=true,offline=false;
  f.rpc.mockImplementation(async input=>{
    if(input.type==='status'&&input.operationId===null&&hold){hold=false;atStatus.release();await resume.ready;}
    if(input.type==='restoreHandoff')events.push(input.type);
    return normalRpc(input);
  });
  f.request.mockImplementation((id,path)=>{
    if(path==='/v1/me'){
      events.push(offline?'me503':'me200');
      if(offline)return Promise.resolve(new Response('{}',{status:503}));
    }
    return normalAccount(id,path);
  });
  const pending=controller.request(restore).then(reply=>({reply}),error=>({error}));
  await atStatus.ready;
  offline=true;
  await vi.advanceTimersByTimeAsync(12000);
  expect(events).toContain('me503');
  resume.release();
  const outcome=await pending;
  expect(events.slice(events.lastIndexOf('me503')+1)).not.toContain('restoreHandoff');
  expect(outcome).toHaveProperty('error');
  expect(f.calls.filter(r=>r.type==='close')).toEqual([]);
  offline=false;
  await expect(controller.request(restore)).resolves.toMatchObject({kind:'handoffRestored',session:{handle:session.handle}});
  expect(f.calls.filter(r=>r.type==='open')).toHaveLength(1);
});

it('pauses an in-flight field answer when concurrent restore loses account confirmation',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  f.remote.operations=[f.op];
  const restore={type:'restoreHandoff' as const,accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}};
  const restored=await controller.request(restore);
  if(restored.kind!=='handoffRestored')throw Error('restore');
  const handle=restored.session.handle,atRead=gate(),resume=gate(),events:string[]=[];
  f.remote.field={requestId:randomUUID(),operationId:f.op.operationId,draftId:f.draftId,revision:1,field:'name'};
  const normalRpc=f.rpc.getMockImplementation()!,normalAccount=f.request.getMockImplementation()!;
  let hold=true,offline=false;
  f.request.mockImplementation(async(id,path)=>{
    if(path==='/v1/me'){
      events.push(offline?'me503':'me200');
      if(offline)return new Response('{}',{status:503});
    }
    if(path==='/v1/authoring/'+f.op.operationId)return Response.json(f.op.receipt);
    return normalAccount(id,path);
  });
  f.rpc.mockImplementation(async input=>{
    if(input.type==='groupSourceIdentity'&&hold){hold=false;atRead.release();await resume.ready;}
    if(input.type==='answerField'){events.push('answerField');return {kind:'fieldAnswered'};}
    return normalRpc(input);
  });
  await vi.advanceTimersByTimeAsync(3000);
  await atRead.ready;
  offline=true;
  await expect(controller.request({...restore,handle})).rejects.toThrow();
  resume.release();
  await vi.advanceTimersByTimeAsync(1);
  expect(events).toContain('me503');
  expect(events.slice(events.indexOf('me503')+1)).not.toContain('answerField');
  expect(f.calls.filter(r=>r.type==='close')).toEqual([]);
  offline=false;
  await expect(controller.request({...restore,handle})).resolves.toMatchObject({kind:'handoffRestored',session:{handle}});
  await vi.advanceTimersByTimeAsync(3000);
  expect(events).toContain('answerField');
});

it('pauses an in-flight handoff answer when account confirmation fails during group lookup',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  const restore={type:'restoreHandoff' as const,accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}};
  const restored=await controller.request(restore);
  if(restored.kind!=='handoffRestored')throw Error('restore');
  const handle=restored.session.handle,source=gate(),group=gate(),groupStarted=gate(),sourceStarted=gate(),events:string[]=[];
  f.remote.pending={retryId:f.retryId,ref:randomUUID(),generation:2,lease:'a'.repeat(64),versions:[randomUUID()]};
  const normalAccount=f.request.getMockImplementation()!,normalRpc=f.rpc.getMockImplementation()!;
  let holdGroup=false,offline=false;
  f.request.mockImplementation(async(id,path)=>{
    if(path.endsWith('/source-items')){sourceStarted.release();await source.ready;return normalAccount(id,path);}
    if(path==='/v1/me'){
      events.push(offline?'me503':'me200');
      if(offline)return new Response('{}',{status:503});
    }
    return normalAccount(id,path);
  });
  f.rpc.mockImplementation(async input=>{
    if(input.type==='groupSourceIdentity'&&holdGroup){holdGroup=false;groupStarted.release();await group.ready;}
    if(input.type==='answerHandoff')events.push(input.type);
    return normalRpc(input);
  });
  await controller.request({type:'status',handle});
  await sourceStarted.ready;
  holdGroup=true;
  source.release();
  await groupStarted.ready;
  offline=true;
  await expect(controller.request({...restore,handle})).rejects.toThrow();
  group.release();
  await vi.advanceTimersByTimeAsync(1);
  expect(events).toContain('me503');
  expect(events.slice(events.indexOf('me503')+1)).not.toContain('answerHandoff');
  expect(f.calls.filter(r=>r.type==='close')).toEqual([]);
  offline=false;
  await expect(controller.request({...restore,handle})).resolves.toMatchObject({kind:'handoffRestored',session:{handle}});
  await vi.advanceTimersByTimeAsync(12000);
  expect(events).toContain('answerHandoff');
});

it.each(['forbidden','account mismatch','invalid response','unexpected error','lease aborted'])('still revokes a handle after confirmed identity or lease failure (%s)',async failure=>{
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  const normal=f.request.getMockImplementation()!;
  const before=f.calls.length;
  if(failure==='lease aborted')f.signal.abort();
  else f.request.mockImplementation(async(id,path)=>{
    if(path!=='/v1/me')return normal(id,path);
    if(failure==='unexpected error')throw Error('unexpected account failure');
    if(failure==='forbidden')return new Response('{}',{status:403});
    if(failure==='invalid response')return Response.json({});
    return Response.json({accountId:randomUUID()});
  });
  await expect(controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',handle:opened.handle,
    retryId:f.retryId,target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}})).rejects.toThrow();
  expect(f.calls.slice(before).filter(r=>r.type==='close')).toHaveLength(1);
  await expect(controller.request({type:'status',handle:opened.handle})).rejects.toThrow();
  expect(f.calls.slice(before).filter(r=>r.type==='restoreHandoff')).toEqual([]);
});

it('preserves the private-link confirmation step while background restore polling waits',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  await controller.request({type:'beginHandoff',handle:opened.handle,groupId:f.groupId,retryId:f.retryId});
  f.remote.linked=false;
  const restore={type:'restoreHandoff' as const,accountId:f.binding.accountId,viewId:'local',handle:opened.handle,
    retryId:f.retryId,target:{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}};
  await expect(controller.request(restore)).resolves.toMatchObject({kind:'handoffLinkRequired',session:{handle:opened.handle}});
  const before=f.calls.length;
  const normal=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async input=>{
    if(input.type==='handoffStatus'&&!f.remote.linked)throw Error('private link required');
    return normal(input);
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.calls.slice(before).some(r=>r.type==='handoffStatus'||r.type==='close')).toBe(false);
  f.remote.linked=true;
  await expect(controller.request(restore)).resolves.toMatchObject({kind:'handoffRestored',session:{handle:opened.handle}});
});

it('retains the original idle expiry when account confirmation stays unavailable',async()=>{
  vi.useFakeTimers();
  clean.push(()=>vi.useRealTimers());
  const f=fixture(),{controller}=f.build();
  const opened=await controller.request({type:'open',accountId:f.binding.accountId,viewId:'local',botId:f.binding.botId,groupId:f.groupId});
  if(opened.kind!=='session')throw Error('session');
  const normal=f.request.getMockImplementation()!;
  f.request.mockImplementation((id,path)=>path==='/v1/me'?Promise.resolve(new Response('{}',{status:503})):normal(id,path));
  const before=f.calls.length;
  vi.setSystemTime(Date.now()+30*60_000);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.calls.slice(before).filter(r=>r.type==='close')).toHaveLength(1);
  expect(f.calls.slice(before).filter(r=>r.type==='workflow')).toEqual([]);
  await expect(controller.request({type:'status',handle:opened.handle})).rejects.toThrow();
});

it.each(['source','draft'])('returns the real unavailable result when original %s evidence expires between RPCs',async targetKind=>{
  const f=fixture(),{journal,controller}=f.build();
  journal.history.remember(f.binding,f.sourceIntentId,f.identity,f.groupId);
  const operationId=randomUUID();
  const op:AuthoringOperation=targetKind==='source'?{...f.op}:{...f.op,operationId,groupId:undefined,
    purpose:'editDraft',draftId:f.draftId,baseRevision:2,receipt:{operationId,status:'accepted',stateRevision:3,draftId:f.draftId,revision:3}};
  f.remote.operations=[op];
  const normal=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async input=>{
    if(input.type==='status'&&input.operationId===op.operationId){f.remote.operations=[];f.remote.missing=true;}
    return normal(input);
  });
  const target=targetKind==='source'?{kind:'source' as const,botId:f.binding.botId,groupId:f.groupId}
    :{kind:'draft' as const,draftId:f.draftId,baseRevision:2};
  await expect(controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,target}))
    .resolves.toEqual({kind:'handoffUnavailable',retryId:f.retryId,reason:'notFound'});
  const restores=f.calls.filter(r=>r.type==='restoreHandoff');
  expect(restores).toHaveLength(2);
  expect(restores[1]).toEqual(restores[0]);
  expect(f.calls.some(r=>r.type==='beginHandoff'||r.type==='beginDraftHandoff')).toBe(false);
});

it.each(['still prepared','other operation','changed identity','link-only returned operation'])('rejects inconsistent scoped evidence rather than guessing unavailable (%s)',async failure=>{
  const f=fixture(),{controller}=f.build();
  f.remote.operations=[{...f.op}];
  const normal=f.rpc.getMockImplementation()!;
  let restores=0;
  f.rpc.mockImplementation(async input=>{
    if(input.type==='restoreHandoff'&&++restores===2&&failure==='changed identity')throw Error('identity changed');
    if(input.type==='status'&&input.operationId===null&&failure==='link-only returned operation')
      return {kind:'status',linked:true,reconciliation:[],operations:[f.op]};
    if(input.type==='status'&&input.operationId===f.op.operationId){
      if(failure==='other operation'){
        f.remote.missing=true;
        return {kind:'status',linked:true,reconciliation:[],operations:[{...f.op,operationId:randomUUID()}]};
      }
      return {kind:'status',linked:true,reconciliation:[],operations:[]};
    }
    return normal(input);
  });
  await expect(controller.request({type:'restoreHandoff',accountId:f.binding.accountId,viewId:'local',retryId:f.retryId,
    target:{kind:'source',botId:f.binding.botId,groupId:f.groupId}})).rejects.toThrow();
  expect(restores).toBe(failure==='link-only returned operation'?0:failure==='other operation'?1:2);
  expect(f.calls.some(r=>r.type==='beginHandoff'||r.type==='beginDraftHandoff')).toBe(false);
});
