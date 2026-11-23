import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,canonicalizeRichRecipeContent,creatorReplies,creatorSnapshotSchema,inheritedPublicationSchema,recipeAuthoringRequestSchema,newRichMetadataRequestId,type CreatorJob,type CreatorAnswer,type RecipeAuthoringRequest,type RecipeAuthoringReply,type AccountStatus} from '@vonvon/protocol';
import {createClient,type ClientConnection} from '../../client/src/client.js';
import {RecipeCreatorExecutor,type CreatorContext} from '../src/recipe-creator.js';
import {RecipeCreatorJournal,creatorSha,creatorSnapshotDigest} from '../src/recipe-creator-journal.js';
import {MetadataJournal} from '../src/community-metadata-journal.js';
import {AuthoringJournal} from '../src/recipe-authoring-journal.js';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts.js';
import {LocalRecipePublisher} from '../src/local-recipe-publisher.js';
import * as publicationInheritance from '../src/recipe-publication-inheritance.js';
import type {NativeAccount} from '../src/account-session.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>{while(cleanup.length)cleanup.pop()!();});
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'vonvon-creator-native-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const accountId=randomUUID(),draftId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID(),firstCodeId=randomUUID(),session=randomUUID();
  const groupId=groupIdSchema.parse('oc_source'),preparationId=randomUUID(),identity='d'.repeat(64);
  const association={accountId,viewId:'local',deviceId:randomUUID(),deviceKey:Buffer.alloc(32,7).toString('base64url'),botId:agentIdSchema.parse('cli_creator'),binding:randomUUID(),scope:'c'.repeat(64)};
  const publicValue={name:'私聊配方',summary:'简介',overview:'概览'.repeat(4000),version:'1.1',access:'coded' as const};
  const draft={draftId,recipeId:null,revision:3,public:publicValue,config:{role:'角色\n'.repeat(2000)}};
  let job:CreatorJob,mode:'read'|'preview'|'execute'|'receipt'|'delivery'='read',revoked=false;
  const answers:CreatorAnswer[]=[],deliveries:Extract<RecipeAuthoringRequest,{type:'creatorDeliver'}>[]=[],rpcs:RecipeAuthoringRequest[]=[];
  let receive=(_:string)=>{};
  const socket:ClientConnection={isOpen:()=>true,onMessage:listener=>{receive=listener;},onClose:()=>{},onError:()=>{},close:async()=>{},send(frame,done){
    const request=JSON.parse(frame);const input=recipeAuthoringRequestSchema.parse(request.payload);rpcs.push(input);
    let payload:RecipeAuthoringReply;
    if(input.type==='creatorCheck')payload={kind:'creatorChecked',job,mode};
    else if(input.type==='creatorAnswer'){answers.push(input.answer);payload={kind:'creatorAck'};}
    else if(input.type==='operationSourceIdentity')payload={kind:'operationSourceIdentity',operationId:input.operationId,groupId,identity};
    else if(input.type==='groupSourceIdentity')payload={kind:'groupSourceIdentity',groupId,identity};
    else if(input.type==='creatorDeliver'){deliveries.push(input);payload={kind:'creatorAck'};}
    else throw Error(input.type);
    queueMicrotask(()=>receive(JSON.stringify({type:'response',method:'recipeAuthoring',id:request.id,payload})));done();
  }};
  const client=createClient(socket);
  const state:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  const accountSignal=new AbortController();
  const cloud=vi.fn(async(_id:string,path:string,init?:RequestInit):Promise<Response>=>{
    if(path==='/v1/drafts'&&init?.method==='POST')return Response.json({...draft,draftId:new Headers(init.headers).get('idempotency-key'),revision:1});
    throw Error('Unexpected cloud '+path+' '+init?.method);
  });
  const native:NativeAccount={lease:id=>id===accountId?accountSignal.signal:undefined,status:()=>state,onStatus:()=>()=>{},login:async()=>state,logout:async()=>state,
    cancelLogin:async()=>state,dispose:async()=>{},recipeLink:(r,v)=>`https://vonvon.cc/recipes/${r}/versions/${v}`,request:async(id,path,init,beforeSend)=>{await beforeSend?.();return cloud(id,path,init);}};
  const journalPath=join(dir,'creator'),journal=new RecipeCreatorJournal(journalPath),metadata=new MetadataJournal(join(dir,'metadata')),authoring=new AuthoringJournal();
  cleanup.push(()=>authoring.history.close());
  const publications=vi.fn(),saves=vi.fn(),previews=vi.fn();
  let drafts=new LocalRecipeDrafts();cleanup.push(()=>drafts.close());
  const publisher=new LocalRecipePublisher(join(dir,'publications'));cleanup.push(()=>publisher.close());
  const setLocal=(record?:LocalRecipeDraftRecord)=>{
    drafts.close();drafts=new LocalRecipeDrafts();
    if(record)for(let revision=1;revision<=record.draft.revision;revision++)drafts.commit({requestId:randomUUID(),expectedRevision:revision===1?null:revision-1,record:{...record,draft:{...record.draft,revision}}});
  };
  setLocal({association:structuredClone(association),work:{draftId,source:null},draft,members:[]});
  const build=(saved=journal)=>new RecipeCreatorExecutor(native,saved,metadata,authoring,publications,saves,previews,drafts,publisher);
  const context:CreatorContext={association,session,check(){if(revoked||accountSignal.signal.aborted)throw Error('revoked');},rpc:input=>client.recipeAuthoring!(input),settled:async()=>{}};
  const set=(task:CreatorJob['task'],nextMode=mode,id:string=randomUUID())=>{mode=nextMode;job=creatorReplies[2].parse({kind:'creatorJobs',jobs:[{id,binding:association.binding,scope:association.scope,task}]}).jobs[0]!;return job;};
  return {account:native,dir,journalPath,groupId,preparationId,identity,accountId,draftId,recipeId,versionId,firstCodeId,association,publicValue,draft,journal,metadata,authoring,context,cloud,answers,deliveries,rpcs,build,set,
    mode:(next:typeof mode)=>{mode=next;},revoke:()=>{revoked=true;},accountSignal,publications,saves,previews,setLocal,local:()=>drafts};
}

it.each(['current','lease','mode'] as const)('remembers a verified parent only after its Creator read remains current (%s)',async change=>{
  const f=fixture(),target={recipeId:f.recipeId,versionId:f.versionId};
  const inherited=inheritedPublicationSchema.parse({accountId:f.accountId,versionId:f.versionId,public:{name:'已核验父配方',summary:'父版本说明',overview:'父版本概览',version:''},access:'coded'});
  let entered=()=>{},resume=()=>{};
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});
  const inheritance=vi.spyOn(publicationInheritance,'inheritedPublication').mockImplementation(async()=>{entered();await gate;return inherited;});
  const run=f.build().run(f.context,f.set({kind:'read',read:{kind:'parent',target}},'read')).catch((error:unknown)=>error);
  try{
    await waiting;
    expect(f.authoring.history.parent(f.association,target.versionId)).toBeUndefined();expect(f.answers).toEqual([]);
    if(change==='lease')f.accountSignal.abort();if(change==='mode')f.mode('execute');
    resume();const result=await run;
    expect(inheritance).toHaveBeenCalledOnce();expect(inheritance.mock.calls[0]?.slice(1,4)).toEqual([f.accountId,target.recipeId,target.versionId]);
    if(change==='current'){
      expect(result).toBeUndefined();expect(f.authoring.history.parent(f.association,target.versionId)).toEqual(target);
      expect(f.answers).toEqual([{kind:'parent',target,inherited}]);
    }else{
      expect(f.authoring.history.parent(f.association,target.versionId)).toBeUndefined();
      expect(f.answers.some(answer=>answer.kind==='parent')).toBe(false);
      if(change==='lease')expect(result).toBeInstanceOf(Error);
      else expect(f.answers).toEqual([{kind:'rejected',reason:'unavailable'}]);
    }
    expect(f.cloud).not.toHaveBeenCalled();
  }finally{resume();await run;inheritance.mockRestore();}
});

it.each(['valid','association','work','digest','source','revision','mode','lease'] as const)('opens the complete rich frozen preview only with the original %s evidence',async evidence=>{
  const {f,work,read,cloudDraft}=richMetadataFixture();
  await read();
  const answer=f.answers.at(-1);if(answer?.kind!=='snapshot')throw Error('snapshot');
  const snapshotDigest=creatorSnapshotDigest(answer.snapshot);
  let context=f.context,selected=work,digest=snapshotDigest;
  if(evidence==='association')context={...context,association:{...context.association,deviceKey:Buffer.alloc(32,8).toString('base64url')}};
  if(evidence==='work')selected={...work,source:{...work.source,preparationId:randomUUID()}};
  if(evidence==='digest')digest='f'.repeat(64);
  if(evidence==='source')context={...context,rpc:async request=>{
    const reply=await f.context.rpc(request);return reply.kind==='groupSourceIdentity'?{...reply,identity:'f'.repeat(64)}:reply;
  }};
  if(evidence==='revision'){cloudDraft.revision++;const row=f.local().read(f.accountId,f.draftId)!;f.setLocal({...row,draft:{...row.draft,revision:cloudDraft.revision}});}
  if(evidence==='lease')f.accountSignal.abort();
  const job=f.set({kind:'read',read:{kind:'openPreview',work:selected,snapshotDigest:digest}},evidence==='mode'?'execute':'read');
  await f.build().run(context,job).catch(()=>{});
  if(evidence==='valid'){
    expect(f.previews).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:3});
    expect(f.answers.at(-1)).toEqual({kind:'previewOpened',work,snapshotDigest,revision:3});
  }else expect(f.previews).not.toHaveBeenCalled();
  expect(f.publications).not.toHaveBeenCalled();expect(f.saves).not.toHaveBeenCalled();
  expect(f.cloud.mock.calls.every(([_id,_path,init])=>(init?.method??'GET')==='GET')).toBe(true);
});

it('freezes every preview page once, binds access outside canonical, and serves only exact immutable pages',async()=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const answer=f.answers.at(-1);if(answer?.kind!=='snapshot')throw Error('snapshot');
  const digest=creatorSnapshotDigest(answer.snapshot),stored=f.journal.snapshot(digest)!;
  expect(stored.pages.flat().every(page=>page.length<=4096)).toBe(true);
  expect(stored.pages[1]!.join('')).toBe(JSON.stringify(f.draft.config,null,2));
  expect(creatorSnapshotDigest({...answer.snapshot,public:{...answer.snapshot.public,access:'direct'}})).not.toBe(digest);
  f.cloud.mockClear();
  await executor.run(f.context,f.set({kind:'read',read:{kind:'page',work,snapshotDigest:digest,section:1,page:2}},'read'));
  expect(f.cloud).not.toHaveBeenCalled();expect(f.answers.at(-1)).toMatchObject({kind:'page',text:stored.pages[1]![2]});
  await executor.run(f.context,f.set({kind:'read',read:{kind:'page',work,snapshotDigest:digest,section:1,page:999}},'read'));
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
});

it.each(['lost response','limited receipt'])('recovers publication after %s and draft retirement without another POST or draft read',async failure=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  f.authoring.history.markLocal(f.association,f.draftId);
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);if(frozen?.kind!=='snapshot')throw Error('snapshot');
  const command={kind:'publish' as const,snapshotDigest:creatorSnapshotDigest(frozen.snapshot),snapshot:frozen.snapshot};
  const job=f.set({kind:'command',command,confirmation:{kind:'feishu-card'},approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  const prior=f.cloud.getMockImplementation()!;
  let submitted=0,committed=false,receiptAvailable=false;
  f.cloud.mockImplementation(async(id,path,init)=>{
    if(/^\/v1\/drafts\/[^/]+\/publish$/.test(path)){
      submitted++;committed=true;
      if(failure==='lost response')throw Error('response lost');
      return Response.json({recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue});
    }
    if(path.startsWith('/v1/receipts/publications/'))return !committed?Response.json({status:'unknown'}):!receiptAvailable?Response.json({error:{code:'rate_limited'}},{status:429}):Response.json({status:'committed',receipt:{requestId:job.id,format:'role-v1',draftId:new URL(path,'https://fixture.invalid').searchParams.get('draftId'),
      draftRevision:1,recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue,firstCodeId:f.firstCodeId}});
    if(committed)throw Error('retired draft must not be read');
    return prior(id,path,init);
  });
  await executor.run(f.context,job);expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  expect(f.publications).not.toHaveBeenCalled();
  expect(f.journal.command(f.accountId,job.id)?.phase).toBe('unknown');
  receiptAvailable=true;f.mode('receipt');
  await f.build(new RecipeCreatorJournal(f.journalPath)).run(f.context,job);
  expect(submitted).toBe(1);expect(f.answers.at(-1)).toMatchObject({kind:'published',draftRevision:3,revision:1,firstCodeId:f.firstCodeId});
  expect(f.publications).toHaveBeenCalledWith({accountId:f.accountId,draftId:f.draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1});
  expect(f.journal.command(f.accountId,job.id)?.phase).toBe('committed');
  expect(f.local().read(f.accountId,f.draftId)).toBeUndefined();
  expect(f.authoring.history.publication(f.association,f.draftId)).toEqual({state:'published',operationId:f.draftId,
    draftId:f.draftId,recipeId:f.recipeId,versionId:f.versionId,name:f.publicValue.name,version:f.publicValue.version,revision:1});
});

it.each([401,403])('keeps publication after receipt HTTP %s recoverable without another upload or publication',async status=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const snapshot=f.answers.at(-1);if(snapshot?.kind!=='snapshot')throw Error('snapshot');
  const job=f.set({kind:'command',command:{kind:'publish',snapshot:snapshot.snapshot,snapshotDigest:creatorSnapshotDigest(snapshot.snapshot)},
    confirmation:{kind:'feishu-card'},approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  let published=false,receiptReady=false;const prior=f.cloud.getMockImplementation()!;
  f.cloud.mockImplementation(async(id,path,init)=>{
    if(/^\/v1\/drafts\/[^/]+\/publish$/.test(path)){published=true;return Response.json({recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue});}
    if(path.startsWith('/v1/receipts/publications/')){
      if(!published)return Response.json({status:'unknown'});
      if(!receiptReady)return Response.json({error:{code:status===401?'unauthorized':'forbidden'}},{status});
      return Response.json({status:'committed',receipt:{requestId:job.id,format:'role-v1',draftId:new URL(path,'https://fixture.invalid').searchParams.get('draftId'),
        draftRevision:1,recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue,firstCodeId:f.firstCodeId}});
    }
    return prior(id,path,init);
  });
  await executor.run(f.context,job);
  expect(published).toBe(true);expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  expect(f.journal.command(f.accountId,job.id)?.phase).toBe('unknown');expect(f.publications).not.toHaveBeenCalled();
  const before=f.cloud.mock.calls.length;receiptReady=true;
  expect(await f.build(new RecipeCreatorJournal(f.journalPath)).recoverPublication(f.accountId,f.draftId,()=>{})).toMatchObject({kind:'publicationRecovery',result:{kind:'published'}});
  expect(f.cloud.mock.calls.slice(before).every(([,path,init])=>(init?.method??'GET')==='GET'&&path.includes('/receipts/publications/'))).toBe(true);
  expect(f.cloud.mock.calls.filter(([,path])=>path.endsWith('/publish'))).toHaveLength(1);
  expect(f.journal.command(f.accountId,job.id)?.result?.kind).toBe('published');
});

it.each([408,429])('retains publication as unknown after a temporary receipt failure (%s) without uploading',async status=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);if(frozen?.kind!=='snapshot')throw Error('snapshot');
  const job=f.set({kind:'command',command:{kind:'publish',snapshot:frozen.snapshot,snapshotDigest:creatorSnapshotDigest(frozen.snapshot)},
    confirmation:{kind:'feishu-card'},approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  f.cloud.mockImplementation(async(_id,path,init)=>{
    expect(init?.method??'GET').toBe('GET');expect(path).toContain('/receipts/publications/');
    return Response.json({error:{code:status===429?'rate_limited':'request_timeout'}},{status});
  });
  await executor.run(f.context,job);
  expect(f.answers.at(-1)).toEqual({kind:'unknown'});expect(f.journal.command(f.accountId,job.id)?.phase).toBe('unknown');
  expect(f.local().read(f.accountId,f.draftId)?.draft.revision).toBe(3);
  expect(f.publications).not.toHaveBeenCalled();
  f.mode('receipt');await executor.run(f.context,job);
  expect(f.answers.at(-1)).toEqual({kind:'unknown'});expect(f.cloud.mock.calls.every(([, ,init])=>(init?.method??'GET')==='GET')).toBe(true);
});

it.each(['matching','other'] as const)('uses only the exact metadata receipt and preserves the %s shared entry on recovery',async slot=>{
  const f=fixture(),id=newRichMetadataRequestId(),work={draftId:f.draftId,source:null};
  f.setLocal();
  const command={kind:'metadata' as const,work,revision:3,baseSha256:'b'.repeat(64),change:{field:'summary' as const,value:'新简介'}};
  const request={type:'saveRichDraftMetadata' as const,accountId:f.accountId,requestId:id,draftId:f.draftId,revision:3,
    baseManifestSha256:'b'.repeat(64),public:{...f.publicValue,summary:'新简介'},logo:{kind:'keep' as const}};
  const key=f.metadata.key(f.accountId,f.draftId);
  const pending=slot==='matching'?request:{...request,requestId:newRichMetadataRequestId()};
  f.metadata.write(key,{request:pending});
  f.journal.save({association:f.association,id,command,grant:{approval:'a'.repeat(64),expiresAt:Date.now()-10},request,phase:'unknown'});
  const job=f.set({kind:'command',command,approval:'a'.repeat(64),expiresAt:Date.now()-10},'receipt',id);
  f.cloud.mockImplementation(async(_id,path,init)=>{
    expect(init?.method??'GET').toBe('GET');expect(path).toContain(`/v2/receipts/metadata/${id}?`);
    return Response.json({status:'committed',receipt:{requestId:id,draftId:f.draftId,revision:4,manifestSha256:'d'.repeat(64)}});
  });
  await f.build().run(f.context,job);
  expect(f.cloud).toHaveBeenCalledTimes(1);expect(f.answers.at(-1)).toEqual({kind:'saved',work,revision:4});
  expect(f.journal.command(f.accountId,id)?.request).toEqual(request);
  if(slot==='other')expect(f.metadata.read(key)).toEqual({request:pending});
  else expect(f.metadata.read(key)?.receipt).toMatchObject({requestId:id,draftId:f.draftId,revision:4,manifestSha256:'d'.repeat(64)});
  expect(f.saves).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:4});
});

it('receipt unknown and a stale execute grant never resubmit an already dispatched request',async()=>{
  const f=fixture(),id=randomUUID(),target={recipeId:f.recipeId,versionId:f.versionId};
  const command={kind:'issue' as const,target,count:3};
  const job=f.set({kind:'command',command,approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute',id);
  f.journal.save({association:f.association,id,command,request:{type:'issueCodes',accountId:f.accountId,requestId:id,versionId:f.versionId,count:3},
    grant:{approval:'a'.repeat(64),expiresAt:Date.now()+60000},phase:'unknown'});
  f.cloud.mockImplementation(async(_id,path,init)=>{expect(init?.method??'GET').toBe('GET');expect(path).toContain('/receipts/code-issuance/');return Response.json({status:'unknown'});});
  await f.build().run(f.context,job);expect(f.answers.at(-1)).toEqual({kind:'unknown'});expect(f.cloud).toHaveBeenCalledTimes(1);
});

it('rechecks original source after every await and preserves dispatch-unknown if source is lost after HTTP',async()=>{
  const f=fixture(),id=randomUUID(),target={recipeId:f.recipeId,versionId:f.versionId},command={kind:'issue' as const,target,count:1};
  const job=f.set({kind:'command',command,approval:'b'.repeat(64),expiresAt:Date.now()+60000},'execute',id);
  f.journal.save({association:f.association,id,command,request:{type:'issueCodes',accountId:f.accountId,requestId:id,versionId:f.versionId,count:1},
    grant:{approval:'a'.repeat(64),expiresAt:Date.now()+60000},phase:'unknown'});
  f.cloud.mockImplementation(async(_id,path,init)=>{
    if(path.includes('/receipts/'))return Response.json({status:'unknown'});
    if(init?.method==='POST'){f.revoke();throw Error('connection lost after dispatch');}
    throw Error(path);
  });
  await expect(f.build().run(f.context,job)).rejects.toThrow('revoked');
  expect(f.journal.command(f.accountId,id)?.phase).toBe('unknown');expect(f.answers).toEqual([]);
});

it('rejects changed original bytes and never stores or broadcasts code plaintext',async()=>{
  const f=fixture(),id=randomUUID(),target={recipeId:f.recipeId,versionId:f.versionId};
  const command={kind:'issue' as const,target,count:1};
  f.journal.save({association:f.association,id,command,request:{type:'issueCodes',accountId:f.accountId,requestId:id,versionId:f.versionId,count:1},
    grant:{approval:'a'.repeat(64),expiresAt:Date.now()+60000},phase:'unknown'});
  expect(()=>f.journal.save({...f.journal.command(f.accountId,id)!,command:{...command,count:2}})).toThrow('原请求不能替换');
  const code='AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-1111-2222',codeId=randomUUID();
  f.cloud.mockImplementation(async(_id,path)=>{
    if(path.startsWith('/v2/recipes/'))return Response.json({error:{code:'not_found'}},{status:404});
    if(path.startsWith('/v1/recipes/'))return Response.json({...target,revision:1,public:f.publicValue,config:{role:'角色'},owned:true,acquired:false});
    if(path.endsWith('/codes'))return Response.json({items:[{codeId,suffix:'2222',status:'available',redeemedAt:null}],nextCursor:null});
    if(path.endsWith('/reveal'))return Response.json({codeId,status:'available',code});
    throw Error(path);
  });
  await f.build().run(f.context,f.set({kind:'deliverCodes',target,codeIds:[codeId]},'delivery'));
  expect(f.deliveries[0]?.items).toEqual([{codeId,status:'available',code}]);
  expect(f.answers).toEqual([]);
  for(const name of readdirSync(f.journalPath))expect(readFileSync(join(f.journalPath,name),'utf8')).not.toContain(code);
});

it('previews verified local rich bytes and exact parent, refusing corrupt members or writable memory without a cloud read',async()=>{
  const f=fixture(),text='完整文件正文\n'.repeat(5000),partId=randomUUID();
  const work={draftId:f.draftId,source:{preparationId:f.preparationId,groupId:f.groupId,identity:f.identity}};
  const value=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'part' as const,objectId:partId}};
  const doc=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:value('完整配方'),summary:value('简介'),overview:value('概览'),version:value('1.1')},
    settings:[],rules:[],skills:[{itemId:randomUUID(),originId:randomUUID(),name:'示例技能',entryFileId:file.itemId,fileIds:[file.itemId]}],files:[file],tasks:[],memories:[],setup:[],
    parts:[{objectId:partId,kind:'text',sha256:creatorSha(text),bytes:Buffer.byteLength(text),mediaType:'text/plain;charset=utf-8'}]});
  const record:LocalRecipeDraftRecord={association:structuredClone(f.association),work,parent:{recipeId:f.recipeId,versionId:f.versionId},members:[{descriptor:doc.content.parts[0]!,base64:Buffer.from(text).toString('base64')}],
    sourceCanonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),draft:{format:'rich-v2',draftId:f.draftId,recipeId:f.recipeId,revision:3,sourceIntentId:f.preparationId,
      public:{name:'完整配方',summary:'简介',overview:'概览',version:'1.1',access:'coded'},rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),texts:{[partId]:text}}}};
  f.setLocal(record);
  await f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);expect(frozen).toMatchObject({kind:'snapshot',snapshot:{parent:record.parent,parts:doc.content.parts}});
  if(frozen?.kind!=='snapshot')throw Error('snapshot');
  expect(f.journal.snapshot(creatorSnapshotDigest(frozen.snapshot))!.pages.flat().join('')).toContain(text);
  expect(()=>f.setLocal({...record,members:[{...record.members[0]!,base64:Buffer.from('substitution').toString('base64')}]})).toThrow();
  if(record.draft.format!=='rich-v2')throw Error('rich fixture');
  const richDraft=record.draft;
  const memory=canonicalizeRichRecipeContent({...doc.content,memories:[{itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'不应发布的记忆'}}]});
  expect(()=>f.setLocal({...record,draft:{...richDraft,rich:{content:memory.content,canonical:Buffer.from(memory.canonicalUTF8).toString('base64url'),texts:{[partId]:text}}}})).toThrow();
  expect(f.cloud).not.toHaveBeenCalled();
});

it('backfills exact historical publication source from trusted operation history and ignores other accounts',async()=>{
  const f=fixture(),other=randomUUID();
  f.authoring.history.remember(f.association,f.preparationId,f.identity,f.groupId);
  f.authoring.history.remember({...f.association,accountId:other},randomUUID(),f.identity,f.groupId);
  f.cloud.mockImplementation(async(id,path,init)=>{
    expect(id).toBe(f.accountId);expect(path).toBe('/v1/authoring/source-history');
    expect(JSON.parse(String(init?.body))).toEqual({operationIds:[f.preparationId]});
    return Response.json({entries:[{state:'published',operationId:f.preparationId,draftId:f.draftId,recipeId:f.recipeId,versionId:f.versionId,name:'原版本',version:'1.0',revision:1}]});
  });
  expect(await f.build().resolveVersion(f.context,{recipeId:f.recipeId,versionId:f.versionId})).toBe(true);
  expect(f.journal.version(f.accountId,f.versionId)).toEqual(f.association);
  expect(f.authoring.history.operations(f.association)).toEqual([{operationId:f.preparationId,identity:f.identity,groupId:f.groupId}]);
  expect(f.journal.version(other,f.versionId)).toBeUndefined();
});

it('validates publication notifications and only delivers them to the current authenticated App account',async()=>{
  const {createDesktopFacades}=await import('../src/facade.js');
  let receive=(_:unknown)=>{};
  const shell=createDesktopFacades({invoke:async()=>({ok:true,value:undefined}),receive:listener=>{receive=listener;return ()=>{};}}).shell;
  const accountId=randomUUID(),receipt={accountId,draftId:randomUUID(),recipeId:randomUUID(),versionId:randomUUID(),revision:7};
  const observed:unknown[]=[];shell.recipeAuthoring.onPublished!(value=>observed.push(value));
  receive({type:'account',value:{kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'}});
  receive({type:'authoringPublished',value:receipt});
  receive({type:'authoringPublished',value:{...receipt,code:'secret'}});
  receive({type:'account',value:{kind:'signedOut'}});
  receive({type:'authoringPublished',value:receipt});
  expect(observed).toEqual([receipt]);
});

it('version locators permit a verified replacement Link on the same source without inheriting old command grants',()=>{
  const f=fixture(),replacement={...f.association,binding:randomUUID(),scope:'e'.repeat(64)};
  f.journal.rememberVersion(f.association,f.versionId);f.journal.rememberVersion(replacement,f.versionId);
  expect(f.journal.version(f.accountId,f.versionId)).toEqual(replacement);
  expect(()=>f.journal.rememberVersion({...replacement,deviceKey:Buffer.alloc(32,8).toString('base64url')},f.versionId)).toThrow('来源不能替换');
});

it('keeps unsupported historical conversion and legacy withdrawal explicit and sends no invented mutation endpoint',async()=>{
  const f=fixture(),target={recipeId:f.recipeId,versionId:f.versionId};
  f.cloud.mockImplementation(async(_id,path,init)=>{
    expect(init?.method??'GET').toBe('GET');
    if(path.startsWith('/v2/'))return Response.json({error:{code:'not_found'}},{status:404});
    if(path.startsWith('/v1/recipes/'))return Response.json({...target,revision:1,public:f.publicValue,config:{role:'旧角色'},owned:true,acquired:true});
    throw Error(path);
  });
  const {inheritedPublication}=await import('../src/recipe-publication-inheritance.js');
  await expect(inheritedPublication(f.account,f.accountId,f.recipeId,f.versionId,()=>{})).rejects.toThrow('旧格式版本暂不支持直接准备新版');
  const job=f.set({kind:'command',command:{kind:'withdraw',target},approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  await f.build().run(f.context,job);
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'invalid'});
  expect(f.journal.command(f.accountId,job.id)).toBeUndefined();
});

it('retains committed issuance as unresolved after a transient receipt read failure',async()=>{
  const f=fixture(),id=randomUUID(),target={recipeId:f.recipeId,versionId:f.versionId},command={kind:'issue' as const,target,count:1};
  const expiresAt=Date.now()+60000,approval='a'.repeat(64),job=f.set({kind:'command',command,approval,expiresAt},'execute',id);
  f.journal.save({association:f.association,id,command,request:{type:'issueCodes',accountId:f.accountId,requestId:id,versionId:f.versionId,count:1},grant:{approval,expiresAt},phase:'frozen'});
  const codeId=randomUUID();let posts=0,receipt:'limited'|'unknown'|'committed'='limited';
  f.cloud.mockImplementation(async(_id,path,init)=>{
    if(init?.method==='POST'){posts++;return Response.json({items:[{codeId,status:'redeemed'}]});}
    if(path.includes('/receipts/'))return receipt==='unknown'?Response.json({status:'unknown'}):receipt==='limited'?Response.json({error:{code:'rate_limited'}},{status:429}):Response.json({status:'committed',receipt:{requestId:id,versionId:f.versionId,count:1,codeIds:[codeId]}});
    throw Error(path);
  });
  await f.build().run(f.context,job);expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  receipt='unknown';
  await f.build(new RecipeCreatorJournal(f.journalPath)).run(f.context,f.set({kind:'command',command,expiresAt,approval:'b'.repeat(64)},'execute',id));
  receipt='committed';await f.build(new RecipeCreatorJournal(f.journalPath)).run(f.context,f.set({kind:'command',command,approval,expiresAt},'receipt',id));
  expect(posts).toBe(1);
  expect(f.answers.at(-1)).toMatchObject({kind:'issued',codeIds:[codeId]});
});

it('saves a legacy draft on its first private approval and notifies only after the confirmed revision',async()=>{
  const f=fixture(),work={draftId:f.draftId,source:null};
  const command={kind:'metadata' as const,work,revision:f.draft.revision,baseSha256:creatorSha(JSON.stringify(f.draft.config)),change:{field:'name' as const,value:'新名'}};
  const job=f.set({kind:'command',command,approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  const prior=f.cloud.getMockImplementation()!;
  f.cloud.mockImplementation(async(id,path,init)=>{
    if(init?.method!=='PATCH')return prior(id,path,init);
    expect(f.saves).not.toHaveBeenCalled();expect(new Headers(init.headers).get('idempotency-key')).toBe(job.id);
    return Response.json({...f.draft,revision:4,public:{...f.draft.public,name:'新名'}});
  });
  await f.build().run(f.context,job);
  expect(f.answers.at(-1)).toEqual({kind:'saved',work,revision:4});
  expect(f.saves).toHaveBeenCalledExactlyOnceWith({accountId:f.accountId,draftId:f.draftId,revision:4});
  expect(f.cloud).not.toHaveBeenCalled();
  expect(f.local().read(f.accountId,f.draftId)?.draft).toMatchObject({revision:4,public:{name:'新名'}});
});

function richMetadataFixture(){
  const f=fixture(),requestId=newRichMetadataRequestId();
  const work={draftId:f.draftId,source:{preparationId:f.preparationId,groupId:f.groupId,identity:f.identity}};
  f.authoring.history.remember(f.association,f.preparationId,f.identity,f.groupId);
  const field=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const doc=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:field('当前名称'),summary:field(''),overview:field(''),version:field('')},
    settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});
  const hash=creatorSha(doc.canonicalUTF8);
  const request={type:'saveRichDraftMetadata' as const,accountId:f.accountId,requestId,draftId:f.draftId,revision:2,baseManifestSha256:hash,
    public:{name:'当前名称',summary:'',overview:'',version:'',access:'direct' as const},logo:{kind:'keep' as const}};
  const key=f.metadata.key(f.accountId,f.draftId);
  f.metadata.write(key,{request});
  const cloudDraft={revision:3,committed:true};
  const receipt={requestId,draftId:f.draftId,revision:3,manifestSha256:hash};
  f.cloud.mockImplementation(async(id,path,init)=>{
    expect(id).toBe(f.accountId);expect(init?.method??'GET').toBe('GET');
    const {committed}=cloudDraft;
    if(path.startsWith('/v2/receipts/metadata/'+requestId+'?'))return Response.json(committed?{status:'committed',receipt}:{status:'unknown'});
    throw Error(path);
  });
  const command={kind:'metadata' as const,work,revision:request.revision,baseSha256:request.baseManifestSha256,change:{field:'name' as const,value:'当前名称'}};
  const writer={association:f.association,id:requestId,command,request,phase:'unknown' as const,grant:{approval:'a'.repeat(64),expiresAt:Date.now()+60000}};
  const syncLocal=()=>f.setLocal({association:structuredClone(f.association),work,draft:{format:'rich-v2',draftId:f.draftId,recipeId:null,revision:cloudDraft.revision,sourceIntentId:f.preparationId,public:request.public,
    rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),texts:{}}},sourceCanonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),members:[]});
  syncLocal();
  const read=()=>f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  return {f,work,writer,read,key,request,receipt,cloudDraft,syncLocal};
}

it('keeps an old cloud metadata request untouched while previewing authoritative local content without a cloud read',async()=>{
  const {f,key,request,read,cloudDraft,syncLocal}=richMetadataFixture();
  cloudDraft.revision=2;cloudDraft.committed=false;syncLocal();
  await read();expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{revision:2}});
  expect(f.metadata.read(key)).toEqual({request});
  cloudDraft.committed=true;cloudDraft.revision=3;syncLocal();
  await read();expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{revision:3}});
  expect(f.metadata.read(key)).toEqual({request});expect(f.cloud).not.toHaveBeenCalled();
});

it('recovers an exact local metadata receipt and previews it after renewing only the Link binding',async()=>{
  const {f,writer,work,read,key,request}=richMetadataFixture();
  const latest=f.local().read(f.accountId,f.draftId)!;
  f.setLocal({...latest,draft:{...latest.draft,revision:2}});
  f.local().commit({requestId:writer.id,requestSha256:creatorSha(JSON.stringify(request)),expectedRevision:2,record:latest});
  f.journal.save(writer);
  await f.build().run(f.context,f.set({kind:'command',command:writer.command,...writer.grant},'receipt',writer.id));
  expect(f.answers.at(-1)).toEqual({kind:'saved',work,revision:3});
  f.association.binding=randomUUID();await read();
  expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{work,revision:3}});
  expect(f.metadata.read(key)).toEqual({request});expect(f.cloud).not.toHaveBeenCalled();
});

it('keeps the original metadata grant bound to the old Link',async()=>{
  const {f,writer}=richMetadataFixture();
  f.journal.save({...writer,phase:'frozen'});
  f.association.binding=randomUUID();
  const job=f.set({kind:'command',command:writer.command,...writer.grant},'execute',writer.id);
  await f.build().run(f.context,job);
  expect(f.cloud).not.toHaveBeenCalled();
  expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  expect(f.journal.command(f.accountId,writer.id)?.phase).toBe('frozen');
});

it.each([
  ['account',{accountId:randomUUID()}],['device',{deviceId:randomUUID()}],
  ['device key',{deviceKey:Buffer.alloc(32,9).toString('base64url')}],['Bot',{botId:agentIdSchema.parse('cli_other')}],
] as const)('keeps confirmed metadata private when the %s changes',async(_,changed)=>{
  const {f,writer,read,key,request,receipt}=richMetadataFixture();
  f.journal.save(writer);
  f.metadata.write(key,{request,receipt});
  Object.assign(f.association,{binding:randomUUID()},changed);
  await read();
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
  expect(f.rpcs.filter(r=>r.type==='operationSourceIdentity'||r.type==='groupSourceIdentity')).toEqual([]);
  expect(f.cloud).not.toHaveBeenCalled();
  expect(f.metadata.read(key)).toEqual({request,receipt});
});

it.each(['view','scope','draft','group identity','request','manifest'] as const)('keeps stale cloud metadata %s evidence separate from authoritative local preview after Link renewal',async mismatch=>{
  const {f,writer,work,read,key,request,receipt}=richMetadataFixture();
  const storedWork=structuredClone(work);
  if(mismatch==='draft')storedWork.draftId=randomUUID();
  if(mismatch==='group identity')storedWork.source.identity='e'.repeat(64);
  const held={
    request:mismatch==='request'?{...request,public:{...request.public,name:'另一请求'}}:request,
    receipt:mismatch==='manifest'?{...receipt,manifestSha256:'f'.repeat(64)}:receipt,
  };
  f.journal.save({...writer,command:{...writer.command,work:storedWork}});
  f.metadata.write(key,held);
  f.association.binding=randomUUID();
  if(mismatch==='scope')f.association.scope='a'.repeat(64);
  if(mismatch==='view')f.association.viewId=randomUUID();
  await read();
  if(mismatch==='view')expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
  else expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{work,revision:3}});
  expect(f.metadata.read(key)).toEqual(held);expect(f.cloud).not.toHaveBeenCalled();
});

it('refuses version management from a replacement source before its cloud request',async()=>{
  const f=fixture(),target={recipeId:f.recipeId,versionId:f.versionId};
  f.journal.rememberVersion({...f.association,deviceKey:Buffer.alloc(32,8).toString('base64url')},f.versionId);
  const job=f.set({kind:'command',command:{kind:'issue',target,count:1},approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  await f.build().run(f.context,job);
  expect(f.cloud).not.toHaveBeenCalled();
  expect(f.answers.at(-1)?.kind).toBe('rejected');
  expect(f.journal.command(f.accountId,job.id)).toBeUndefined();
});

it('APP PUBLICATION preview freezes actual draft bytes and never executes an unapproved offer',async()=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);if(frozen?.kind!=='snapshot')throw Error('snapshot');
  expect(frozen.snapshot.appPreviewUrl).toBeUndefined();
  const task={kind:'command' as const,command:{kind:'publish' as const,snapshot:frozen.snapshot,snapshotDigest:creatorSnapshotDigest(frozen.snapshot)},approval:'0'.repeat(64),expiresAt:Date.now()+60000};
  const job=f.set(task,'preview');
  const preview=await executor.preview(f.context,job);expect(preview.draft).toEqual(f.draft);
  await expect(executor.run(f.context,job)).rejects.toThrow();
  expect(f.journal.command(f.accountId,job.id)).toBeUndefined();
  f.draft.config.role='Changed after App preview';f.setLocal({association:structuredClone(f.association),work,draft:f.draft,members:[]});
  await expect(executor.preview(f.context,job)).rejects.toThrow();
  expect(f.cloud.mock.calls.every(([,path,init])=>!path.endsWith('/publish')&&(init?.method??'GET')==='GET')).toBe(true);
});

it('APP PUBLICATION preserves explicit App grant and exact receipt recovery in the existing disk journal',async()=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);if(frozen?.kind!=='snapshot')throw Error('snapshot');
  const confirmation={kind:'app' as const,confirmationId:randomUUID()};
  const job=f.set({kind:'command',command:{kind:'publish',snapshot:frozen.snapshot,snapshotDigest:creatorSnapshotDigest(frozen.snapshot)},confirmation,approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  const prior=f.cloud.getMockImplementation()!;let posted=0,committed=false,recovered=false;
  f.cloud.mockImplementation(async(id,path,init)=>{
    if(/^\/v1\/drafts\/[^/]+\/publish$/.test(path)){posted++;committed=true;throw Error('lost reply');}
    if(path.startsWith('/v1/receipts/publications/'))return recovered?Response.json({status:'committed',receipt:{requestId:job.id,format:'role-v1',draftId:new URL(path,'https://fixture.invalid').searchParams.get('draftId'),draftRevision:1,
      recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue,firstCodeId:f.firstCodeId}}):Response.json({status:'unknown'});
    if(committed)throw Error('retired draft');
    return prior(id,path,init);
  });
  await executor.run(f.context,job);expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  const durable=new RecipeCreatorJournal(f.journalPath);expect(durable.command(f.accountId,job.id)?.grant.confirmation).toEqual(confirmation);
  f.mode('receipt');recovered=true;await f.build(durable).run(f.context,job);
  expect(posted).toBe(1);expect(f.answers.at(-1)).toMatchObject({kind:'published',draftId:f.draftId,draftRevision:3});
  expect(f.publications).toHaveBeenCalledOnce();
});
