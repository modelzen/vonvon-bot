import {draftScopeHead,editLocalDraftScope} from '../src/local-recipe-scope-edit';
import {itemsOf} from '../../daemon/src/recipe/authoring-rich-snapshot';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {groupIdSchema,newRichMetadataRequestId,recipeRichContentSchema,type RichFreezeInput,type RichMetadataRequest} from '@vonvon/protocol';
import {bindRichMembers} from '../../daemon/src/recipe/authoring-rich-flow';
import {verifyFrozenRich} from '../../daemon/src/recipe/authoring-rich-proof';
import {creatorAssociationSchema} from '../src/recipe-creator-journal';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts';
import {applyLocalMetadata,bindLocalRichMembers,buildLocalRichRecord,freezeLocalRich} from '../src/local-recipe-content';
import {freezeSnapshot,inventory} from '../../../services/recipe-api/src/rich-document.mjs';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const webp=Buffer.from('UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=','base64');
const stores:LocalRecipeDrafts[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();vi.restoreAllMocks();});
function store(){const value=new LocalRecipeDrafts();stores.push(value);return value;}
function fixture(){
  const content=recipeRichContentSchema.parse(JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')));
  content.memories=[];content.parts=[];delete content.finalLogo;
  const text='---\ndescription: 本地技能\n---\nKeep original candidate bytes.';
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:text}};
  const skill={itemId:randomUUID(),originId:randomUUID(),name:'local-helper',entryFileId:file.itemId,fileIds:[file.itemId]};
  content.files=[file];content.skills=[skill];
  const operationId=randomUUID(),draftId=randomUUID();
  const ids=[...Object.values(content.public),content.role!,file,skill];
  const request:RichFreezeInput={format:'rich-v2',content,access:'direct',origins:ids.map(item=>({itemId:item.itemId,source:{kind:'accountClaim'}}))};
  const bytes=Buffer.from(text);
  const members=[{itemId:file.itemId,kind:'text' as const,sha256:sha(bytes),bytes:bytes.toString('base64url')}];
  const association=creatorAssociationSchema.parse({accountId:randomUUID(),viewId:'local',deviceId:randomUUID(),deviceKey:Buffer.alloc(32,1).toString('base64url'),
    botId:'cli_local_content',binding:randomUUID(),scope:'a'.repeat(64)});
  const work={draftId,source:{preparationId:operationId,groupId:groupIdSchema.parse('oc_local_source'),identity:'b'.repeat(64)}};
  return {request,members,operationId,draftId,association,work,skill,file};
}
async function prepared(){
  const f=fixture(),bound=await bindLocalRichMembers(f.operationId,f.request,f.members);
  const request=bindRichMembers({request:f.request,members:f.members},bound.descriptors,f.operationId);
  const frozen=freezeLocalRich(f.operationId,f.draftId,request);
  const record=buildLocalRichRecord({...f,revision:1,request,frozen,members:bound.members});
  return {...f,request,frozen,record};
}
function metadata(record:LocalRecipeDraftRecord,logo:RichMetadataRequest['logo']={kind:'keep'}):RichMetadataRequest{
  if(record.draft.format!=='rich-v2')throw Error('rich fixture');
  return {type:'saveRichDraftMetadata',accountId:record.association.accountId,requestId:newRichMetadataRequestId(),draftId:record.draft.draftId,
    revision:record.draft.revision,baseManifestSha256:sha(Buffer.from(record.draft.rich.canonical,'base64url')),public:{...record.draft.public,name:'本地新名称',access:'coded'},logo};
}

it('binds exact local text bytes with stable IDs and verifies the complete record through the strict local store without a network call',async()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('network forbidden'));
  const f=fixture(),first=await bindLocalRichMembers(f.operationId,f.request,f.members);
  expect(await bindLocalRichMembers(f.operationId,f.request,f.members)).toEqual(first);
  await expect(bindLocalRichMembers(f.operationId,f.request,[{...f.members[0]!,sha256:'0'.repeat(64)}])).rejects.toThrow();
  await expect(bindLocalRichMembers(f.operationId,f.request,[])).rejects.toThrow();
  const {record,frozen}=await prepared(),db=store();
  db.commit({requestId:randomUUID(),expectedRevision:null,record});
  expect(db.read(record.association.accountId,record.work.draftId)).toEqual(record);
  expect(record.sourceCanonical).toBe(frozen.canonical);expect(record.sourceOrigins).toEqual(record.origins);
  expect(record.draft.format==='rich-v2'&&Object.values(record.draft.rich.texts)).toContain(Buffer.from(f.members[0]!.bytes,'base64url').toString());
  expect(network).not.toHaveBeenCalled();
});

it('normalizes Logo locally, preserves the input SHA for daemon binding and refuses a missing normalizer',async()=>{
  const f=fixture(),raw={itemId:randomUUID(),kind:'finalLogo' as const,sha256:sha(webp),bytes:webp.toString('base64url')};
  await expect(bindLocalRichMembers(f.operationId,f.request,[...f.members,raw])).rejects.toThrow();
  const normalize=vi.fn(async()=>Buffer.from(webp));
  const bound=await bindLocalRichMembers(f.operationId,f.request,[...f.members,raw],normalize);
  const request=bindRichMembers({request:f.request,members:[...f.members,raw]},bound.descriptors,f.operationId);
  expect(request.logoUpload).toEqual({packageId:f.operationId,inputSha256:sha(webp)});
  expect(normalize).toHaveBeenCalledWith(webp);
  const frozen=freezeLocalRich(f.operationId,f.draftId,request),record=buildLocalRichRecord({...f,revision:1,request,frozen,members:bound.members});
  expect(record.draft.logo).toBe('data:image/webp;base64,'+webp.toString('base64'));
  store().commit({requestId:randomUUID(),expectedRevision:null,record});
});

it('keeps the first saved source and its members while removing and deterministically restoring a skill through a later local edit',async()=>{
  const f=await prepared(),db=store();db.commit({requestId:randomUUID(),expectedRevision:null,record:f.record});
  if(f.record.draft.format!=='rich-v2')throw Error('rich fixture');
  const remove:RichFreezeInput={format:'rich-v2',baseCanonical:f.frozen.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:f.draftId,baseRevision:1,
    requestId:randomUUID(),schemaVersion:2,changes:[{op:'removeItem',kind:'skill',itemId:f.skill.itemId}]}};
  const removed=buildLocalRichRecord({...f,revision:2,request:remove,frozen:freezeLocalRich(randomUUID(),f.draftId,remove),members:[],base:f.record});
  expect(removed.sourceCanonical).toBe(f.record.sourceCanonical);expect(removed.members).toEqual(f.record.members);
  expect(removed.draft.format==='rich-v2'&&removed.draft.rich.content.skills).toEqual([]);
  db.commit({requestId:randomUUID(),expectedRevision:1,record:removed});
  if(removed.draft.format!=='rich-v2')throw Error('rich fixture');
  const restore:RichFreezeInput={format:'rich-v2',baseCanonical:removed.draft.rich.canonical,candidates:[{sourceIntentId:f.operationId,canonical:removed.sourceCanonical!}],
    payload:{format:'rich-v2',purpose:'editDraft',draftId:f.draftId,baseRevision:2,requestId:randomUUID(),schemaVersion:2,
      changes:[{op:'includeCandidate',value:{kind:'skill',source:{sourceIntentId:f.operationId,candidateId:f.skill.itemId,expectedRevision:2}}}]}};
  const operationId=randomUUID(),frozen=freezeLocalRich(operationId,f.draftId,restore);
  expect(freezeLocalRich(operationId,f.draftId,restore)).toEqual(frozen);
  expect(verifyFrozenRich(operationId,f.draftId,restore,frozen)).toEqual(frozen);
  const restored=buildLocalRichRecord({...f,revision:3,request:restore,frozen,members:[],base:removed});
  expect(restored.sourceOrigins).toEqual(f.record.sourceOrigins);
  if(restored.draft.format!=='rich-v2')throw Error('rich fixture');
  expect(restored.draft.rich.content.skills).toHaveLength(1);expect(restored.draft.rich.content.files).toHaveLength(1);
  expect(restored.origins).toHaveLength(f.record.origins!.length);
  expect(restored.origins?.every(origin=>origin.source.kind==='accountClaim')).toBe(true);
  db.commit({requestId:randomUUID(),expectedRevision:2,record:restored});
  expect(()=>db.commit({requestId:randomUUID(),expectedRevision:1,record:restored})).toThrow();
});

it('rejects mismatched draft IDs, base revisions, associations, frozen hashes and missing original members',async()=>{
  const f=await prepared();
  const request:RichFreezeInput={format:'rich-v2',baseCanonical:f.frozen.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:f.draftId,baseRevision:1,
    requestId:randomUUID(),schemaVersion:2,changes:[{op:'setAccess',value:'coded'}]},access:'coded'};
  expect(()=>freezeLocalRich(randomUUID(),randomUUID(),request)).toThrow();
  const frozen=freezeLocalRich(randomUUID(),f.draftId,request);
  expect(()=>buildLocalRichRecord({...f,request,frozen,revision:3,members:[],base:f.record})).toThrow();
  expect(()=>buildLocalRichRecord({...f,request,frozen,revision:2,members:[],base:f.record,association:{...f.association,accountId:randomUUID()}})).toThrow();
  expect(()=>buildLocalRichRecord({...f,request,frozen:{...frozen,contentSha256:'0'.repeat(64)},revision:2,members:[],base:f.record})).toThrow();
  expect(()=>buildLocalRichRecord({...f,revision:1,frozen:f.frozen,members:[]})).toThrow();
});

it('updates metadata and Logo locally, retaining the immutable source and removed Logo bytes for later recovery',async()=>{
  const f=await prepared(),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('network forbidden'));
  const input=metadata(f.record,{kind:'replace',base64:webp.toString('base64')});
  await expect(applyLocalMetadata(f.record,input)).rejects.toThrow();
  const changed=await applyLocalMetadata(f.record,input,async()=>Buffer.from(webp));
  expect(await applyLocalMetadata(f.record,input,async()=>Buffer.from(webp))).toEqual(changed);
  expect(changed.draft).toMatchObject({revision:2,public:{name:'本地新名称',access:'coded'},logo:'data:image/webp;base64,'+webp.toString('base64')});
  expect(changed.sourceCanonical).toBe(f.record.sourceCanonical);expect(changed.sourceOrigins).toEqual(f.record.sourceOrigins);
  const removed=await applyLocalMetadata(changed,metadata(changed,{kind:'remove'}));
  expect(removed.draft.logo).toBeUndefined();expect(removed.members).toEqual(changed.members);
  const db=store();db.commit({requestId:randomUUID(),expectedRevision:null,record:f.record});
  db.commit({requestId:input.requestId,expectedRevision:1,record:changed});
  db.commit({requestId:randomUUID(),expectedRevision:2,record:removed});
  await expect(applyLocalMetadata(changed,input)).rejects.toThrow();
  await expect(applyLocalMetadata(f.record,{...input,accountId:randomUUID()})).rejects.toThrow();
  await expect(applyLocalMetadata(f.record,{...input,baseManifestSha256:'0'.repeat(64)})).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

it('publishes an inherited skill copy with derived provenance while retaining each original release identity only once',async()=>{
  const f=await prepared(),parent={recipeId:randomUUID(),versionId:randomUUID()};
  if(f.record.draft.format!=='rich-v2')throw Error('rich fixture');
  const prior=inventory(f.record.draft.rich.content),inherited=new Set<string>([f.skill.itemId,f.file.itemId]);
  f.record.parent=parent;f.record.draft.recipeId=parent.recipeId;
  f.record.origins=f.record.origins!.map(origin=>{
    const item=prior.find(item=>item.itemId===origin.itemId)!;
    return inherited.has(origin.itemId)?{itemId:origin.itemId,source:{kind:'releaseItem',versionId:parent.versionId,itemId:origin.itemId,baselineSha256:item.baselineSha256}}:origin;
  });
  f.record.sourceOrigins=structuredClone(f.record.origins);
  const request:RichFreezeInput={format:'rich-v2',baseCanonical:f.record.draft.rich.canonical,payload:{format:'rich-v2',purpose:'editDraft',
    draftId:f.draftId,baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[{op:'copyItem',source:{kind:'skill',itemId:f.skill.itemId}}]}};
  const copied=buildLocalRichRecord({...f,revision:2,request,frozen:freezeLocalRich(randomUUID(),f.draftId,request),members:[],base:f.record});
  if(copied.draft.format!=='rich-v2')throw Error('rich fixture');
  const copiedContent=copied.draft.rich.content;
  expect(()=>freezeSnapshot({format:'rich-v2',content:copiedContent,origins:copied.origins,access:'direct',sourceVersionId:parent.versionId},
    Buffer.alloc(32,1),new Map(prior.map(item=>[item.itemId,item])))).not.toThrow();
  const newIds=[...copied.draft.rich.content.skills,...copied.draft.rich.content.files].filter(item=>!inherited.has(item.itemId)).map(item=>item.itemId);
  expect(newIds).toHaveLength(2);
  for(const itemId of newIds)expect(copied.origins!.find(origin=>origin.itemId===itemId)?.source.kind).toBe('releaseItems');
  expect(copied.origins!.filter(origin=>origin.source.kind==='releaseItem')).toHaveLength(2);
});

it('saves scope changes as exact revisions while preserving metadata, image, prior file bodies and source proof',async()=>{
  const f=await prepared(),drafts=store();
  drafts.commit({requestId:randomUUID(),expectedRevision:null,record:f.record});
  const metadataEdit=await applyLocalMetadata(f.record,metadata(f.record,{kind:'replace',base64:webp.toString('base64')}),async()=>webp);
  drafts.commit({requestId:randomUUID(),expectedRevision:1,record:metadataEdit});
  if(metadataEdit.draft.format!=='rich-v2')throw Error('rich fixture');
  const original=metadataEdit.draft;
  const source=structuredClone(original.rich.content);
  delete source.role;delete source.finalLogo;
  source.skills=[];source.files=[];source.parts=[];source.rules=[];source.settings=[];
  const task={itemId:randomUUID(),originId:randomUUID(),name:'新的群任务',instruction:{kind:'inline' as const,value:'每周整理周报'},
    placement:'follow' as const,spec:{kind:'every' as const,minutes:60},timeZone:{kind:'recommended' as const,iana:'Asia/Shanghai'}};
  source.tasks=[task];
  const entry={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'inline' as const,value:'---\nname: 新技能\n---\n新的群技能'}};
  const skill={itemId:randomUUID(),originId:randomUUID(),name:'new-group-skill',entryFileId:entry.itemId,fileIds:[entry.itemId]};
  source.skills=[skill];source.files=[entry];
  const make=(base:LocalRecipeDraftRecord,donor:typeof source,addIds:string[],removeIds:string[])=>{
    const head=draftScopeHead(base);
    return {kind:'draftScopeApply' as const,work:base.work,revision:base.draft.revision,baseSha256:head.baseSha256,lease:'a'.repeat(64),donor,
      evidence:Object.fromEntries(itemsOf(donor).map(i=>[i.itemId,{kind:'native' as const}])),addIds,removeIds};
  };
  const add=make(metadataEdit,source,[skill.itemId,task.itemId],[]);
  const next=editLocalDraftScope(metadataEdit,add,new Map());
  drafts.commit({requestId:randomUUID(),expectedRevision:2,record:next});
  expect(next.draft.public).toEqual(original.public);expect(next.draft.logo).toBe(original.logo);
  expect(next.draft.rich.content.files).toEqual([...original.rich.content.files,entry]);
  expect(next.draft.rich.content.tasks).toEqual([task]);expect(next.draft.rich.texts).toEqual(original.rich.texts);
  expect(next.sourceCanonical).toBe(metadataEdit.sourceCanonical);expect(next.sourceOrigins).toEqual(metadataEdit.sourceOrigins);
  expect(()=>editLocalDraftScope(next,add,new Map())).toThrow();
  expect(()=>drafts.commit({requestId:randomUUID(),expectedRevision:2,record:next})).toThrow();
  const roleOnly=structuredClone(source);roleOnly.tasks=[];roleOnly.skills=[];roleOnly.files=[];
  const removed=editLocalDraftScope(next,make(next,roleOnly,[],[task.itemId]),new Map());
  expect(removed.draft.rich.content.tasks).toEqual([]);expect(removed.draft.rich.content.skills).toEqual(next.draft.rich.content.skills);
  const reference={itemId:randomUUID(),originId:randomUUID(),name:'references/how.md',use:'reference' as const,text:{kind:'inline' as const,value:'核对逐项说明'}};
  const fileSource=structuredClone(roleOnly);fileSource.skills=[{...skill,fileIds:[entry.itemId,reference.itemId]}];fileSource.files=[entry,reference];
  const include=make(removed,fileSource,[reference.itemId],[]);
  const proof={itemId:randomUUID(),versionId:randomUUID(),baselineSha256:'b'.repeat(64)};
  const managed={...include,evidence:{...include.evidence,[reference.itemId]:{kind:'managed' as const,parents:[proof]}}};
  expect(()=>editLocalDraftScope(removed,managed,new Map())).toThrow();
  const attest=new Map([[proof.versionId+':'+proof.itemId,{...proof,authorId:randomUUID(),access:'direct' as const}]]);
  const withRef=editLocalDraftScope(removed,managed,attest);
  expect(withRef.draft.rich.content.files).toContainEqual(reference);
  expect(withRef.origins).toContainEqual({itemId:reference.itemId,source:{kind:'releaseItem',...proof}});
  const without=editLocalDraftScope(withRef,make(withRef,roleOnly,[],[reference.itemId]),new Map());
  expect(without.draft.rich.content.skills.find(s=>s.itemId===skill.itemId)?.fileIds).toEqual([entry.itemId]);
  expect(without.draft.rich.content.files).not.toContainEqual(reference);
  expect(without.draft.rich.content.files).toContainEqual(entry);expect(without.draft.logo).toBe(original.logo);
  expect(()=>editLocalDraftScope(without,make(without,roleOnly,[],[entry.itemId]),new Map())).toThrow();
  expect(editLocalDraftScope(without,make(without,fileSource,[reference.itemId],[]),new Map()).draft.rich.content.files).toContainEqual(reference);
});
