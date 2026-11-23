import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {agentIdSchema,canonicalizeRichRecipeContent,communityResponseSchemas,groupIdSchema,newRichMetadataRequestId,
  recipeRichContentSchema,type AccountStatus,type CommunityRequest,type RecipeRichPartDescriptor,type RichMetadataRequest} from '@vonvon/protocol';
import type {NativeAccount} from '../src/account-session';
import {localRecipeCommunity} from '../src/local-recipe-community';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts';

const fixtures:Array<{account:NativeAccount;store:LocalRecipeDrafts}>=[];
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const webp=Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=','base64');
afterEach(()=>{
  for(const f of fixtures.splice(0)){
    try{expect(f.account.request).not.toHaveBeenCalled();expect(f.account.publicRequest).not.toHaveBeenCalled();}
    finally{f.store.close();}
  }
});
function member(text:string){
  const descriptor:RecipeRichPartDescriptor={objectId:randomUUID(),kind:'text',sha256:sha(text),bytes:Buffer.byteLength(text),mediaType:'text/plain;charset=utf-8'};
  return {descriptor,base64:Buffer.from(text).toString('base64')};
}
function fixture(){
  const accountId=randomUUID(),other=randomUUID(),draftId=randomUUID(),preparationId=randomUUID();
  let active=accountId;
  const leases=new Map([[accountId,new AbortController()],[other,new AbortController()]]);
  const status=():AccountStatus=>({kind:'signedIn',accountId:active,displayName:'本地作者',provider:'google',persistence:'memory'});
  const request=vi.fn(async()=>{throw Error('offline test forbids authenticated network');});
  const publicRequest=vi.fn(async()=>{throw Error('offline test forbids public network');});
  const account:NativeAccount={status,lease:id=>id===active?leases.get(id)?.signal:undefined,onStatus:()=>()=>{},
    login:async()=>status(),cancelLogin:async()=>status(),logout:async()=>status(),dispose:async()=>{},request,publicRequest};
  const current=member('---\ndescription: 本地技能说明\n---\nCurrent skill bytes.'),sourceOnly=member('Original unselected source skill.'),unused=member('Unselected retained attachment.');
  const text=(value:string)=>({itemId:randomUUID(),originId:randomUUID(),value});
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription',text:{kind:'part',objectId:current.descriptor.objectId}};
  const skill={itemId:randomUUID(),originId:randomUUID(),name:'local-skill',entryFileId:file.itemId,fileIds:[file.itemId]};
  const content=recipeRichContentSchema.parse({format:'rich-v2',schemaVersion:2,
    public:{name:text('本地配方'),summary:text('本地简介'),overview:text('本地概览'),version:text('1.0')},
    settings:[],rules:[],skills:[skill],files:[file],tasks:[],memories:[],setup:[],parts:[current.descriptor]});
  const document=canonicalizeRichRecipeContent(content),source=structuredClone(content);
  const candidateFile={itemId:randomUUID(),originId:randomUUID(),name:'unselected/SKILL.md',use:'skillDescription',text:{kind:'part',objectId:sourceOnly.descriptor.objectId}};
  const sourceFile=recipeRichContentSchema.shape.files.element.parse(candidateFile);
  source.files.push(sourceFile);source.skills.push({...skill,itemId:randomUUID(),originId:randomUUID(),name:'unselected-source-skill',entryFileId:sourceFile.itemId,fileIds:[sourceFile.itemId]});
  source.parts.push(sourceOnly.descriptor);
  const original=canonicalizeRichRecipeContent(source);
  const publicInfo={name:'本地配方',summary:'本地简介',overview:'本地概览',version:'1.0',access:'direct' as const};
  const items=[...Object.values(content.public),...content.files,...content.skills];
  const record:LocalRecipeDraftRecord={association:{accountId,viewId:'local',deviceId:randomUUID(),deviceKey:Buffer.alloc(32,2).toString('base64url'),botId:agentIdSchema.parse('cli_local_community'),binding:randomUUID(),scope:'a'.repeat(64)},
    work:{draftId,source:{preparationId,groupId:groupIdSchema.parse('oc_local_community'),identity:'b'.repeat(64)}},
    draft:{format:'rich-v2',draftId,recipeId:null,revision:1,sourceIntentId:preparationId,public:publicInfo,
      rich:{content:document.content,canonical:Buffer.from(document.canonicalUTF8).toString('base64url'),texts:{[current.descriptor.objectId]:Buffer.from(current.base64,'base64').toString('utf8')}}},
    sourceCanonical:Buffer.from(original.canonicalUTF8).toString('base64url'),parent:{recipeId:randomUUID(),versionId:randomUUID()},
    origins:items.map(item=>({itemId:item.itemId,source:{kind:'accountClaim'}})),
    sourceOrigins:[{itemId:sourceFile.itemId,source:{kind:'releaseItem',versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'c'.repeat(64)}}],
    selected:items.map(item=>item.itemId),members:[current,sourceOnly,unused]};
  const store=new LocalRecipeDrafts();store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const f={accountId,other,account,draftId,record,store,publicInfo,
    replaceLease(){leases.set(active,new AbortController());},
    switchAccount(){leases.get(active)!.abort();active=other;}};
  fixtures.push(f);return f;
}
function metadata(f:ReturnType<typeof fixture>,changes:Partial<Pick<RichMetadataRequest,'revision'|'baseManifestSha256'|'public'|'logo'|'requestId'>>={}):RichMetadataRequest{
  const draft=f.store.read(f.accountId,f.draftId)!.draft;if(draft.format!=='rich-v2')throw Error('rich fixture required');
  return {type:'saveRichDraftMetadata',accountId:f.accountId,draftId:f.draftId,requestId:newRichMetadataRequestId(),revision:draft.revision,
    baseManifestSha256:sha(Buffer.from(draft.rich.canonical,'base64url')),public:{...draft.public,name:'本地修改后的名称'},logo:{kind:'keep'},...changes};
}
function role(f:ReturnType<typeof fixture>){
  const draftId=randomUUID(),record:LocalRecipeDraftRecord={association:f.record.association,work:{draftId,source:null},members:[],
    draft:{draftId,recipeId:null,revision:1,public:f.publicInfo,config:{role:'本地角色正文'}}};
  f.store.commit({requestId:randomUUID(),expectedRevision:null,record});return record;
}

it('lists, reads and recovers complete local drafts without authenticated or public requests',async()=>{
  const f=fixture();
  expect(await localRecipeCommunity(f.account,f.store,{type:'drafts',accountId:f.accountId})).toEqual({items:[f.record.draft]});
  expect(await localRecipeCommunity(f.account,f.store,{type:'draft',accountId:f.accountId,draftId:f.draftId})).toEqual(f.record.draft);
  expect(await localRecipeCommunity(f.account,f.store,{type:'recoverRichDraftMetadata',accountId:f.accountId,draftId:f.draftId})).toEqual({status:'current',draft:f.record.draft});
});

it('saves rich metadata locally while retaining original source, parent, provenance and every attachment',async()=>{
  const f=fixture(),request=metadata(f),reply=await localRecipeCommunity(f.account,f.store,request);
  expect(communityResponseSchemas.saveRichDraftMetadata.parse(reply)).toMatchObject({status:'committed',draft:{revision:2,public:request.public}});
  const current=f.store.read(f.accountId,f.draftId)!;
  expect(current).toMatchObject({association:f.record.association,work:f.record.work,parent:f.record.parent,sourceCanonical:f.record.sourceCanonical,
    sourceOrigins:f.record.sourceOrigins,origins:f.record.origins,selected:f.record.selected,members:f.record.members});
  if(current.draft.format!=='rich-v2')throw Error('rich draft required');
  expect(current.draft.rich.content.public.name.value).toBe(request.public.name);
});

it('replays a metadata receipt without another revision and refuses changed public or logo bodies under the same request',async()=>{
  const f=fixture(),request=metadata(f),first=await localRecipeCommunity(f.account,f.store,request);
  expect(await localRecipeCommunity(f.account,f.store,structuredClone(request))).toEqual(first);
  expect(f.store.read(f.accountId,f.draftId)?.draft.revision).toBe(2);
  expect(await localRecipeCommunity(f.account,f.store,{...request,public:{...request.public,name:'同请求换正文'}})).toEqual({status:'rejected',code:'conflict'});
  expect(await localRecipeCommunity(f.account,f.store,{...request,logo:{kind:'remove'}})).toEqual({status:'rejected',code:'conflict'});
  expect(f.store.read(f.accountId,f.draftId)?.draft.revision).toBe(2);
});

it('replays the same metadata request after top-level and public insertion order changes while refusing actual content changes',async()=>{
  const f=fixture(),request=metadata(f),first=await localRecipeCommunity(f.account,f.store,request);
  const reordered:RichMetadataRequest={logo:request.logo,
    public:{access:request.public.access,version:request.public.version,overview:request.public.overview,summary:request.public.summary,name:request.public.name},
    baseManifestSha256:request.baseManifestSha256,revision:request.revision,draftId:request.draftId,requestId:request.requestId,accountId:request.accountId,type:request.type};
  expect(await localRecipeCommunity(f.account,f.store,reordered)).toEqual(first);
  expect(await localRecipeCommunity(f.account,f.store,{...reordered,public:{...reordered.public,name:'同请求的不同内容'}})).toEqual({status:'rejected',code:'conflict'});
  expect(f.store.read(f.accountId,f.draftId)?.draft.revision).toBe(2);
});

it('keeps the original metadata receipt after subsequent edits instead of applying the old request again',async()=>{
  const f=fixture(),request=metadata(f),first=await localRecipeCommunity(f.account,f.store,request);
  if(first.status!=='committed')throw Error('first save must commit');
  expect(await localRecipeCommunity(f.account,f.store,metadata(f,{public:{...f.publicInfo,name:'后续修改'}}))).toMatchObject({status:'committed',draft:{revision:3}});
  expect(await localRecipeCommunity(f.account,f.store,request)).toEqual({status:'committed',receipt:first.receipt});
  expect(f.store.read(f.accountId,f.draftId)?.draft.revision).toBe(3);
});

it('allows only one concurrent metadata CAS and refuses stale revision or base manifest without changing local data',async()=>{
  const f=fixture(),first=metadata(f),second=metadata(f,{public:{...f.publicInfo,name:'并发修改'}});
  const outcomes=await Promise.all([localRecipeCommunity(f.account,f.store,first),localRecipeCommunity(f.account,f.store,second)]);
  expect(outcomes.filter(outcome=>outcome.status==='committed')).toHaveLength(1);
  expect(outcomes.filter(outcome=>outcome.status==='rejected')).toEqual([{status:'rejected',code:'conflict'}]);
  const before=f.store.read(f.accountId,f.draftId);
  expect(await localRecipeCommunity(f.account,f.store,{...first,requestId:newRichMetadataRequestId()})).toEqual({status:'rejected',code:'conflict'});
  expect(await localRecipeCommunity(f.account,f.store,metadata(f,{baseManifestSha256:'0'.repeat(64)}))).toEqual({status:'rejected',code:'conflict'});
  expect(f.store.read(f.accountId,f.draftId)).toEqual(before);
});

it('normalizes a replacement logo locally only once and retains source-only and unselected members',async()=>{
  const f=fixture(),normalize=vi.fn(async()=>Buffer.from(webp));
  const request=metadata(f,{logo:{kind:'replace',base64:webp.toString('base64')}});
  const first=await localRecipeCommunity(f.account,f.store,request,normalize);
  expect(first).toMatchObject({status:'committed',draft:{logo:'data:image/webp;base64,'+webp.toString('base64'),revision:2}});
  expect(await localRecipeCommunity(f.account,f.store,request,normalize)).toEqual(first);
  expect(normalize).toHaveBeenCalledOnce();
  const current=f.store.read(f.accountId,f.draftId)!;
  for(const original of f.record.members)expect(current.members).toContainEqual(original);
  expect(current.members).toHaveLength(f.record.members.length+1);
  expect(current.sourceCanonical).toBe(f.record.sourceCanonical);
  expect(current.sourceOrigins).toEqual(f.record.sourceOrigins);
});

it('rejects an account switch during local logo work before committing any update',async()=>{
  const f=fixture(),before=f.store.read(f.accountId,f.draftId),request=metadata(f,{logo:{kind:'replace',base64:webp.toString('base64')}});
  const normalize=vi.fn(async()=>{f.switchAccount();return Buffer.from(webp);});
  expect(await localRecipeCommunity(f.account,f.store,request,normalize)).toEqual({status:'rejected',code:'invalid_input'});
  expect(f.store.read(f.accountId,f.draftId)).toEqual(before);
  expect(f.store.receipt(f.accountId,f.draftId,request.requestId)).toBeUndefined();
});

it('rejects an old logo save when the same account acquires a different lease during normalization',async()=>{
  const f=fixture(),before=f.store.read(f.accountId,f.draftId),request=metadata(f,{logo:{kind:'replace',base64:webp.toString('base64')}});
  const originalLease=f.account.lease?.(f.accountId);if(!originalLease)throw Error('fixture lease missing');
  let entered=()=>{},release=()=>{};
  const normalizing=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const normalize=vi.fn(async()=>{entered();await gate;return Buffer.from(webp);});
  const saving=localRecipeCommunity(f.account,f.store,request,normalize);
  await normalizing;
  f.replaceLease();
  expect(f.account.status()).toMatchObject({kind:'signedIn',accountId:f.accountId});
  expect(f.account.lease?.(f.accountId)).not.toBe(originalLease);
  expect(originalLease.aborted).toBe(false);
  release();
  expect(await saving).toEqual({status:'rejected',code:'invalid_input'});
  expect(f.store.read(f.accountId,f.draftId)).toEqual(before);
  expect(f.store.receipt(f.accountId,f.draftId,request.requestId)).toBeUndefined();
});

it('saves an existing role draft locally and replays the same request without another revision',async()=>{
  const f=fixture(),original=role(f);
  const request:Extract<CommunityRequest,{type:'saveDraft'}>={type:'saveDraft',accountId:f.accountId,requestId:randomUUID(),target:{kind:'existing',draftId:original.draft.draftId,revision:1},
    public:{...f.publicInfo,name:'修改后的角色'},config:{role:'仅本地更新'}};
  const saved=await localRecipeCommunity(f.account,f.store,request);
  expect(communityResponseSchemas.saveDraft.parse(saved)).toMatchObject({revision:2,public:request.public,config:request.config});
  expect(await localRecipeCommunity(f.account,f.store,request)).toEqual(saved);
  await expect(localRecipeCommunity(f.account,f.store,{...request,config:{role:'同请求换内容'}})).rejects.toMatchObject({code:'conflict'});
  await expect(localRecipeCommunity(f.account,f.store,{...request,requestId:randomUUID()})).rejects.toMatchObject({code:'conflict'});
  expect(f.store.read(f.accountId,original.draft.draftId)?.draft.revision).toBe(2);
});

it('soft-discards a local draft idempotently with a valid response and hides it from list/read',async()=>{
  const f=fixture(),request:Extract<CommunityRequest,{type:'deleteDraft'}>={type:'deleteDraft',accountId:f.accountId,requestId:randomUUID(),draftId:f.draftId,revision:1};
  expect(communityResponseSchemas.deleteDraft.parse(await localRecipeCommunity(f.account,f.store,request))).toEqual({draftId:f.draftId,deleted:true});
  expect(await localRecipeCommunity(f.account,f.store,request)).toEqual({draftId:f.draftId,deleted:true});
  expect(await localRecipeCommunity(f.account,f.store,{type:'drafts',accountId:f.accountId})).toEqual({items:[]});
  await expect(localRecipeCommunity(f.account,f.store,{type:'draft',accountId:f.accountId,draftId:f.draftId})).rejects.toMatchObject({code:'not_found'});
  expect(f.store.receipt(f.accountId,f.draftId,request.requestId)).toMatchObject({revision:2,deleted:true});
});

it('refuses bare publish IPC and direct new-draft saves without sending content anywhere',async()=>{
  const f=fixture();
  await expect(localRecipeCommunity(f.account,f.store,{type:'publishDraft',accountId:f.accountId,requestId:randomUUID(),draftId:f.draftId,revision:1})).rejects.toThrow('明确确认发布');
  await expect(localRecipeCommunity(f.account,f.store,{type:'saveDraft',accountId:f.accountId,requestId:randomUUID(),target:{kind:'new'},public:f.publicInfo,config:{role:'不能绕过Bot创作'}})).rejects.toThrow('Bot 的创作入口');
  expect(f.store.read(f.accountId,f.draftId)).toEqual(f.record);
});

it('never fills an unknown old cloud draft through read, recovery, metadata, role-save or discard',async()=>{
  const f=fixture(),draftId=randomUUID();
  const requests=[{type:'draft',accountId:f.accountId,draftId},{type:'recoverRichDraftMetadata',accountId:f.accountId,draftId},
    {...metadata(f),draftId},{type:'saveDraft',accountId:f.accountId,requestId:randomUUID(),target:{kind:'existing',draftId,revision:1},public:f.publicInfo,config:{role:'旧云内容'}},
    {type:'deleteDraft',accountId:f.accountId,requestId:randomUUID(),draftId,revision:1}] satisfies Parameters<typeof localRecipeCommunity>[2][];
  for(const request of requests)await expect(localRecipeCommunity(f.account,f.store,request)).rejects.toMatchObject({code:'not_found'});
  expect(f.store.list(f.accountId)).toEqual([f.record]);
});

it('rejects every local operation for a switched account and keeps the other account list isolated',async()=>{
  const f=fixture(),requests=[{type:'drafts',accountId:f.accountId},{type:'draft',accountId:f.accountId,draftId:f.draftId},
    {type:'recoverRichDraftMetadata',accountId:f.accountId,draftId:f.draftId},metadata(f),
    {type:'saveDraft',accountId:f.accountId,requestId:randomUUID(),target:{kind:'existing',draftId:f.draftId,revision:1},public:f.publicInfo,config:{role:'账号切换'}},
    {type:'deleteDraft',accountId:f.accountId,requestId:randomUUID(),draftId:f.draftId,revision:1},
    {type:'publishDraft',accountId:f.accountId,requestId:randomUUID(),draftId:f.draftId,revision:1}] satisfies Parameters<typeof localRecipeCommunity>[2][];
  f.switchAccount();
  for(const request of requests)await expect(localRecipeCommunity(f.account,f.store,request)).rejects.toThrow('账号已切换');
  expect(await localRecipeCommunity(f.account,f.store,{type:'drafts',accountId:f.other})).toEqual({items:[]});
  await expect(localRecipeCommunity(f.account,f.store,{type:'draft',accountId:f.other,draftId:f.draftId})).rejects.toMatchObject({code:'not_found'});
  expect(f.store.read(f.accountId,f.draftId)).toEqual(f.record);
});
