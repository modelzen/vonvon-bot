import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,groupIdSchema,canonicalizeRichRecipeContent,creatorReplies,creatorSnapshotSchema,recipeAuthoringRequestSchema,newRichMetadataRequestId,type CreatorJob,type CreatorAnswer,type RecipeAuthoringRequest,type RecipeAuthoringReply,type AccountStatus} from '@vonvon/protocol';
import {createClient,type ClientConnection} from '../../client/src/client.js';
import {RecipeCreatorExecutor,type CreatorContext} from '../src/recipe-creator.js';
import {RecipeCreatorJournal,creatorSha,creatorSnapshotDigest} from '../src/recipe-creator-journal.js';
import {MetadataJournal} from '../src/community-metadata-journal.js';
import {AuthoringJournal} from '../src/recipe-authoring-journal.js';
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
  let job:CreatorJob,mode:'read'|'execute'|'receipt'|'delivery'='read',revoked=false;
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
    if(path==='/v2/drafts/'+draftId)return Response.json({error:{code:'not_found'}},{status:404});
    if(path==='/v1/drafts/'+draftId)return Response.json(draft);
    if(path.startsWith('/v1/drafts/'+draftId+'/creator-context?'))return Response.json({draftId,format:'role-v1',revision:draft.revision,sourceIntentId:null,parent:null});
    throw Error('Unexpected cloud '+path+' '+init?.method);
  });
  const native:NativeAccount={lease:id=>id===accountId?accountSignal.signal:undefined,status:()=>state,onStatus:()=>()=>{},login:async()=>state,logout:async()=>state,
    cancelLogin:async()=>state,dispose:async()=>{},recipeLink:(r,v)=>`https://vonvon.cc/recipes/${r}/versions/${v}`,request:async(id,path,init,beforeSend)=>{await beforeSend?.();return cloud(id,path,init);}};
  const journalPath=join(dir,'creator'),journal=new RecipeCreatorJournal(journalPath),metadata=new MetadataJournal(join(dir,'metadata')),authoring=new AuthoringJournal();
  cleanup.push(()=>authoring.history.close());
  const publications=vi.fn(),saves=vi.fn();
  const build=(saved=journal)=>new RecipeCreatorExecutor(native,saved,metadata,authoring,publications,saves);
  const context:CreatorContext={association,session,check(){if(revoked||accountSignal.signal.aborted)throw Error('revoked');},rpc:input=>client.recipeAuthoring!(input),settled:async()=>{}};
  const set=(task:CreatorJob['task'],nextMode=mode,id:string=randomUUID())=>{mode=nextMode;job=creatorReplies[2].parse({kind:'creatorJobs',jobs:[{id,binding:association.binding,scope:association.scope,task}]}).jobs[0]!;return job;};
  return {account:native,dir,journalPath,groupId,preparationId,identity,accountId,draftId,recipeId,versionId,firstCodeId,association,publicValue,draft,journal,metadata,authoring,context,cloud,answers,deliveries,rpcs,build,set,
    mode:(next:typeof mode)=>{mode=next;},revoke:()=>{revoked=true;},accountSignal,publications,saves};
}

it('freezes every preview page once, binds access outside canonical, and serves only exact immutable pages',async()=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const answer=f.answers.at(-1);if(answer?.kind!=='snapshot')throw Error('snapshot');
  const digest=creatorSnapshotDigest(answer.snapshot),stored=f.journal.snapshot(digest)!;
  expect(stored.pages.flat().every(page=>page.length<=4096)).toBe(true);
  expect(answer.snapshot.sections[1]!.title).toBe('角色');
  expect(stored.pages[1]!.join('')).toBe(f.draft.config.role);
  expect(creatorSnapshotDigest({...answer.snapshot,public:{...answer.snapshot.public,access:'direct'}})).not.toBe(digest);
  f.cloud.mockClear();
  await executor.run(f.context,f.set({kind:'read',read:{kind:'page',work,snapshotDigest:digest,section:1,page:1}},'read'));
  expect(f.cloud).not.toHaveBeenCalled();expect(f.answers.at(-1)).toMatchObject({kind:'page',text:stored.pages[1]![1]});
  await executor.run(f.context,f.set({kind:'read',read:{kind:'page',work,snapshotDigest:digest,section:1,page:999}},'read'));
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
});

it.each(['lost response','limited receipt'])('recovers publication after %s and draft retirement without another POST or draft read',async failure=>{
  const f=fixture(),executor=f.build(),work={draftId:f.draftId,source:null};
  await executor.run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);if(frozen?.kind!=='snapshot')throw Error('snapshot');
  const command={kind:'publish' as const,snapshotDigest:creatorSnapshotDigest(frozen.snapshot),snapshot:frozen.snapshot};
  const job=f.set({kind:'command',command,approval:'a'.repeat(64),expiresAt:Date.now()+60000},'execute');
  const prior=f.cloud.getMockImplementation()!;
  let submitted=0,committed=false,receiptAvailable=false;
  f.cloud.mockImplementation(async(id,path,init)=>{
    if(path===`/v1/drafts/${f.draftId}/publish`){
      submitted++;committed=true;
      if(failure==='lost response')throw Error('response lost');
      return Response.json({recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue});
    }
    if(path.startsWith('/v1/receipts/publications/'))return !receiptAvailable?Response.json({error:{code:'rate_limited'}},{status:429}):Response.json({status:'committed',receipt:{requestId:job.id,format:'role-v1',draftId:f.draftId,
      draftRevision:3,recipeId:f.recipeId,versionId:f.versionId,revision:1,public:f.publicValue,firstCodeId:f.firstCodeId}});
    if(committed)throw Error('retired draft must not be read');
    return prior(id,path,init);
  });
  await executor.run(f.context,job);expect(f.answers.at(-1)).toEqual({kind:'unknown'});
  expect(f.publications).not.toHaveBeenCalled();
  expect(f.journal.command(f.accountId,job.id)?.phase).toBe(failure==='lost response'?'unknown':'awaitingReceipt');
  receiptAvailable=true;f.mode('receipt');
  await f.build(new RecipeCreatorJournal(f.journalPath)).run(f.context,job);
  expect(submitted).toBe(1);expect(f.answers.at(-1)).toMatchObject({kind:'published',draftRevision:3,revision:1,firstCodeId:f.firstCodeId});
  expect(f.publications).toHaveBeenCalledWith({accountId:f.accountId,draftId:f.draftId,recipeId:f.recipeId,versionId:f.versionId,revision:1});
  expect(f.journal.command(f.accountId,job.id)?.phase).toBe('committed');
});

it.each(['matching','other'] as const)('uses only the exact metadata receipt and preserves the %s shared entry on recovery',async slot=>{
  const f=fixture(),id=newRichMetadataRequestId(),work={draftId:f.draftId,source:null};
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

it('verifies rich bytes and every part, retains the exact parent, and refuses memory or substituted part content',async()=>{
  const f=fixture(),text='完整文件正文\n'.repeat(5000),partId=randomUUID(),manifestId=randomUUID();
  const extraTexts=new Map<string,string>();
  const work={draftId:f.draftId,source:{preparationId:f.preparationId,groupId:f.groupId,identity:f.identity}};
  f.authoring.history.remember(f.association,f.preparationId,f.identity,f.groupId);
  const publicText=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription',text:{kind:'part' as const,objectId:partId}};
  const content={format:'rich-v2',schemaVersion:2,public:{name:publicText(f.publicValue.name),summary:publicText(f.publicValue.summary),overview:publicText('概览'),version:publicText('1.1')},
    role:{itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'你是可靠的研究助手。'}},
    settings:[{...publicText(''),field:'sessionMode',value:'smart'},
      {...publicText(''),field:'response.noMention',value:false},
      {...publicText(''),field:'presentation.completionTemplate',value:null},
      {...publicText(''),field:'model.recommendation',value:{backend:'custom-backend',selection:{kind:'explicit',model:'default',effort:'high',custom:true}}}],
    rules:[{itemId:randomUUID(),originId:randomUUID(),purpose:'work',text:{kind:'inline',value:'保留证据来源。'}}],
    skills:[{itemId:randomUUID(),originId:randomUUID(),name:'示例技能',entryFileId:file.itemId,fileIds:[file.itemId]}],files:[file],
    tasks:[{itemId:randomUUID(),originId:randomUUID(),name:'每周回顾',instruction:{kind:'inline',value:'整理本周事项，不要发送。'},
      spec:{kind:'weekly',days:[1,5],time:'18:30'},timeZone:{kind:'recommended',iana:'Asia/Shanghai'},placement:'newTopic'}],
    memories:[] as unknown[],setup:[{itemId:randomUUID(),originId:randomUUID(),kind:'tool',title:'可选工具说明',instructions:'按需要安装。',required:false,check:'查看版本号',action:{kind:'manual'}}],
    parts:[{objectId:partId,kind:'text',sha256:creatorSha(text),bytes:Buffer.byteLength(text),mediaType:'text/plain;charset=utf-8'}]};
  let document=canonicalizeRichRecipeContent(content),corrupt=false;
  f.cloud.mockImplementation(async(_id,path)=>{
    const manifest={objectId:manifestId,kind:'manifest',sha256:creatorSha(document.canonicalUTF8),bytes:document.canonicalUTF8.length,mediaType:'application/json'};
    if(path==='/v2/drafts/'+f.draftId)return Response.json({format:'rich-v2',draftId:f.draftId,recipeId:f.recipeId,revision:3,access:'coded',sourceIntentId:f.preparationId,
      manifest,sourceManifest:manifest,logicalBytes:document.logicalBytes,retainedCandidateBytes:0});
    if(path.endsWith('/objects/'+manifestId))return new Response(document.canonical);
    if(path.endsWith('/objects/'+partId))return new Response(corrupt?'substitution':text);
    for(const [id,body] of extraTexts)if(path.endsWith('/objects/'+id))return new Response(body);
    if(path.includes('/creator-context?'))return Response.json({format:'rich-v2',draftId:f.draftId,revision:3,sourceIntentId:f.preparationId,parent:{recipeId:f.recipeId,versionId:f.versionId}});
    throw Error(path);
  });
  await f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const frozen=f.answers.at(-1);expect(frozen).toMatchObject({kind:'snapshot',snapshot:{parent:{recipeId:f.recipeId,versionId:f.versionId},parts:content.parts}});
  if(frozen?.kind!=='snapshot')throw Error('snapshot');
  const saved=f.journal.snapshot(creatorSnapshotDigest(frozen.snapshot))!;
  const readable=saved.pages.map(section=>section.join('')).join('\n');
  expect(saved.canonical).toBe(Buffer.from(document.canonicalUTF8).toString('base64url'));
  expect(frozen.snapshot.contentSha256).toBe(creatorSha(document.canonicalUTF8));
  expect(frozen.snapshot.sections.map(section=>section.title)).toContain('补充说明');
  const bodySection=frozen.snapshot.sections.findIndex(section=>section.title==='SKILL.md');
  expect(bodySection).toBeGreaterThanOrEqual(0);
  expect(saved.pages[bodySection]!.join('')).toBe(text);
  for(const value of ['你是可靠的研究助手。','会话模式','智能会话','无需提及 Bot','关闭','完成通知模板','未指定',
    '推荐模型','custom-backend','default','high','保留证据来源。','示例技能','SKILL.md','技能说明',
    '每周回顾','整理本周事项，不要发送。','每周','18:30','Asia/Shanghai','新话题','可选工具说明','按需要安装。','查看版本号'])expect(readable).toContain(value);
  for(const internal of ['itemId','originId','objectId','sha256',file.itemId,partId,creatorSha(text)])expect(readable).not.toContain(internal);
  expect(readable).toContain('安装后暂停');
  expect(readable).not.toContain('准备步骤');
  const extraFiles=Array.from({length:7},(_,index)=>{
    const objectId=randomUUID(),body=`第 ${index+1} 份参考文件\r\n\n正文保留尾随空格。  \n`;
    extraTexts.set(objectId,body);
    return {itemId:randomUUID(),originId:randomUUID(),name:`references/文档-${index+1}.md`,use:'reference',text:{kind:'part',objectId}};
  });
  document=canonicalizeRichRecipeContent({...content,skills:content.skills.map(skill=>({...skill,fileIds:[file.itemId,...extraFiles.map(extra=>extra.itemId)]})),
    files:[file,...extraFiles],parts:[...content.parts,...[...extraTexts].map(([objectId,body])=>({
    objectId,kind:'text',sha256:creatorSha(body),bytes:Buffer.byteLength(body),mediaType:'text/plain;charset=utf-8',
  }))]});
  await f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  const many=f.answers.at(-1);if(many?.kind!=='snapshot')throw Error('snapshot');
  expect(many.snapshot.sections).toHaveLength(11);
  const combined=f.journal.snapshot(creatorSnapshotDigest(many.snapshot))!.pages.at(-1)!.join('');
  expect(combined).toContain('SKILL.md\n'+text);
  extraFiles.forEach(extra=>expect(combined).toContain(extra.name+'\n'+extraTexts.get(extra.text.objectId)));
  corrupt=true;
  await f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
  corrupt=false;document=canonicalizeRichRecipeContent({...content,memories:[{itemId:randomUUID(),originId:randomUUID(),text:{kind:'inline',value:'不应发布的记忆'}}]});
  await f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
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
  expect(f.cloud.mock.calls.filter(([, ,init])=>init?.method==='PATCH')).toHaveLength(1);
});

function richMetadataFixture(){
  const f=fixture(),requestId=newRichMetadataRequestId(),objectId=randomUUID();
  const work={draftId:f.draftId,source:{preparationId:f.preparationId,groupId:f.groupId,identity:f.identity}};
  f.authoring.history.remember(f.association,f.preparationId,f.identity,f.groupId);
  const field=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const doc=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,public:{name:field('当前名称'),summary:field(''),overview:field(''),version:field('')},
    settings:[],rules:[],skills:[],files:[],tasks:[],memories:[],setup:[],parts:[]});
  const hash=creatorSha(doc.canonicalUTF8);
  const request={type:'saveRichDraftMetadata' as const,accountId:f.accountId,requestId,draftId:f.draftId,revision:2,baseManifestSha256:'e'.repeat(64),
    public:{name:'当前名称',summary:'',overview:'',version:'',access:'direct' as const},logo:{kind:'keep' as const}};
  const key=f.metadata.key(f.accountId,f.draftId);
  f.metadata.write(key,{request});
  const cloudDraft={revision:3,committed:true};
  const receipt={requestId,draftId:f.draftId,revision:3,manifestSha256:hash};
  f.cloud.mockImplementation(async(id,path,init)=>{
    expect(id).toBe(f.accountId);expect(init?.method??'GET').toBe('GET');
    const {revision,committed}=cloudDraft;
    if(path.startsWith('/v2/receipts/metadata/'+requestId+'?'))return Response.json(committed?{status:'committed',receipt}:{status:'unknown'});
    if(path==='/v2/drafts/'+f.draftId)return Response.json({format:'rich-v2',draftId:f.draftId,recipeId:null,revision,access:'direct',sourceIntentId:f.preparationId,
      manifest:{objectId,kind:'manifest',bytes:doc.canonicalUTF8.length,sha256:hash,mediaType:'application/json'},sourceManifest:null,logicalBytes:doc.logicalBytes,retainedCandidateBytes:0});
    if(path.endsWith('/objects/'+objectId))return new Response(doc.canonical);
    if(path.includes('/creator-context?'))return Response.json({format:'rich-v2',draftId:f.draftId,revision,sourceIntentId:f.preparationId,parent:null});
    throw Error(path);
  });
  const command={kind:'metadata' as const,work,revision:request.revision,baseSha256:request.baseManifestSha256,change:{field:'name' as const,value:'当前名称'}};
  const writer={association:f.association,id:requestId,command,request,phase:'unknown' as const,grant:{approval:'a'.repeat(64),expiresAt:Date.now()+60000}};
  const read=()=>f.build().run(f.context,f.set({kind:'read',read:{kind:'draft',work}},'read'));
  return {f,work,writer,read,key,request,receipt,cloudDraft};
}

it('reconciles historical App metadata by GET before full private preview, retaining unknown and stale evidence',async()=>{
  const {f,key,request,receipt,read,cloudDraft}=richMetadataFixture();
  cloudDraft.revision=2;
  cloudDraft.committed=false;
  await read();expect(f.answers.at(-1)?.kind).toBe('rejected');expect(f.metadata.read(key)).toEqual({request});
  cloudDraft.committed=true;
  await read();expect(f.answers.at(-1)?.kind).toBe('rejected');expect(f.metadata.read(key)).toEqual({request,receipt});
  cloudDraft.revision=3;
  await read();expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{revision:3}});
  expect(f.metadata.read(key)).toBeUndefined();
  expect(f.cloud.mock.calls.filter(([,path])=>path.startsWith('/v2/receipts/metadata/'))).toHaveLength(2);
});

it('previews the confirmed metadata revision after renewing only the Link binding',async()=>{
  const {f,writer,work,read,key,request,receipt}=richMetadataFixture();
  f.journal.save(writer);
  const task={kind:'command' as const,command:writer.command,...writer.grant};
  await f.build().run(f.context,f.set(task,'receipt',writer.id));
  expect(f.answers.at(-1)).toEqual({kind:'saved',work,revision:3});
  expect(f.metadata.read(key)).toEqual({request,receipt});

  f.association.binding=randomUUID();
  await read();
  expect(f.answers.at(-1)).toMatchObject({kind:'snapshot',snapshot:{work,revision:3,contentSha256:receipt.manifestSha256}});
  expect(f.metadata.read(key)).toBeUndefined();
  expect(f.cloud.mock.calls.every(([, ,init])=>(init?.method??'GET')==='GET')).toBe(true);
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

it.each(['view','scope','draft','group identity','request','manifest'] as const)('retains the receipt when the metadata %s differs after Link renewal',async mismatch=>{
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
  expect(f.answers.at(-1)).toEqual({kind:'rejected',reason:'unavailable'});
  expect(f.metadata.read(key)).toEqual(held);
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
