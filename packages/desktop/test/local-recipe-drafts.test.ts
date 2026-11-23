import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {linkSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,groupIdSchema,recipeRichContentSchema,type RecipeRichPartDescriptor} from '@vonvon/protocol';
import {creatorAssociationSchema} from '../src/recipe-creator-journal';
import {isRecipeDirectoryIndex,readRecipeDirectory} from '../src/local-recipe-directory';
import {LocalRecipeDrafts,LocalRecipeDraftError,type LocalRecipeDraftRecord} from '../src/local-recipe-drafts';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const directories:string[]=[],stores:LocalRecipeDrafts[]=[],connections:DatabaseSync[]=[];
afterEach(()=>{
  for(const db of connections.splice(0))db.close();
  for(const store of stores.splice(0))store.close();
  for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});
});
function disk(){
  const root=mkdtempSync(join(tmpdir(),'vv-local-recipe-drafts-'));directories.push(root);
  const dir=join(root,'drafts'),store=new LocalRecipeDrafts(dir);stores.push(store);return {dir,store};
}
function reopen(dir:string){const store=new LocalRecipeDrafts(dir);stores.push(store);return store;}
function inspect(dir:string){const db=new DatabaseSync(join(dir,'drafts.sqlite'));connections.push(db);return db;}
function failure(action:()=>unknown,code:LocalRecipeDraftError['code']){
  assert.throws(action,error=>error instanceof LocalRecipeDraftError&&error.code===code);
}
function textMember(text:string){
  const descriptor:RecipeRichPartDescriptor={objectId:randomUUID(),kind:'text',bytes:Buffer.byteLength(text),sha256:sha(text),mediaType:'text/plain;charset=utf-8'};
  return {descriptor,base64:Buffer.from(text).toString('base64')};
}
function fixture({accountId=randomUUID(),draftId=randomUUID(),source=false,extra=false}:{accountId?:string;draftId?:string;source?:boolean;extra?:boolean}={}){
  const content=recipeRichContentSchema.parse(JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')));
  delete content.finalLogo;content.memories=[];
  const member=textMember('---\ndescription: 本地技能说明\n---\nOnly local draft bytes.');
  const file={itemId:randomUUID(),originId:randomUUID(),name:'SKILL.md',use:'skillDescription' as const,text:{kind:'part' as const,objectId:member.descriptor.objectId}};
  content.files=[file];content.skills=[{itemId:randomUUID(),originId:randomUUID(),name:'local-skill',entryFileId:file.itemId,fileIds:[file.itemId]}];content.parts=[member.descriptor];
  const doc=canonicalizeRichRecipeContent(content),preparationId=randomUUID();
  const publicInfo={name:doc.content.public.name.value,summary:doc.content.public.summary.value,overview:doc.content.public.overview.value,version:doc.content.public.version.value,access:'direct' as const};
  const record:LocalRecipeDraftRecord={
    association:creatorAssociationSchema.parse({accountId,viewId:'local',deviceId:randomUUID(),deviceKey:Buffer.alloc(32,1).toString('base64url'),botId:'cli_local_recipe_drafts',binding:randomUUID(),scope:'a'.repeat(64)}),
    work:{draftId,source:{preparationId,groupId:groupIdSchema.parse('oc_local_draft_source'),identity:'b'.repeat(64)}},
    draft:{format:'rich-v2',draftId,recipeId:null,revision:1,sourceIntentId:preparationId,public:publicInfo,
      rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),texts:{[member.descriptor.objectId]:Buffer.from(member.base64,'base64').toString('utf8')}}},
    origins:[{itemId:file.itemId,source:{kind:'accountClaim'}}],selected:[file.itemId],members:[member],
  };
  if(source){
    const original=structuredClone(content),old=textMember('Original unselected source bytes.');
    const sourceFile={...file,itemId:randomUUID(),originId:randomUUID(),text:{kind:'part' as const,objectId:old.descriptor.objectId}};
    original.files=[sourceFile];original.skills=[{...content.skills[0]!,itemId:randomUUID(),entryFileId:sourceFile.itemId,fileIds:[sourceFile.itemId]}];original.parts=[old.descriptor];
    const sourceDoc=canonicalizeRichRecipeContent(original);
    record.sourceCanonical=Buffer.from(sourceDoc.canonicalUTF8).toString('base64url');record.parent={recipeId:randomUUID(),versionId:randomUUID()};
    record.selected=[sourceFile.itemId];record.members.push(old);
  }
  if(extra)record.members.push(textMember('Candidate retained without being selected.'));
  return record;
}
function edit(record:LocalRecipeDraftRecord,revision:number,name='本地修改后的名称'){
  const next=structuredClone(record);next.draft.revision=revision;
  if(next.draft.format!=='rich-v2')throw Error('rich fixture required');
  next.draft.public.name=name;next.draft.rich.content.public.name.value=name;
  next.draft.rich.canonical=Buffer.from(canonicalizeRichRecipeContent(next.draft.rich.content).canonicalUTF8).toString('base64url');
  return next;
}

it('persists the complete account-scoped record, source bytes and unused candidates across restart',()=>{
  const {dir,store}=disk(),record=fixture({source:true,extra:true}),requestId=randomUUID();
  const receipt=store.commit({requestId,expectedRevision:null,record});
  expect(receipt).toEqual({accountId:record.association.accountId,draftId:record.draft.draftId,requestId,revision:1,contentSha256:sha(Buffer.from(record.draft.format==='rich-v2'?record.draft.rich.canonical:'','base64url')),deleted:false});
  store.close();
  const restored=reopen(dir);
  expect(restored.read(record.association.accountId,record.draft.draftId)).toEqual(record);
  expect(restored.list(record.association.accountId)).toEqual([record]);
  expect(restored.receipt(record.association.accountId,record.draft.draftId,requestId)).toEqual(receipt);
  expect(statSync(dir).mode&0o777).toBe(0o700);expect(statSync(join(dir,'drafts.sqlite')).mode&0o777).toBe(0o600);
});

it('preserves source-only candidate provenance and refuses origins that do not belong to source canonical',()=>{
  const {dir,store}=disk(),record=fixture({source:true});
  record.sourceOrigins=[{itemId:record.selected![0]!,source:{kind:'releaseItem',versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'a'.repeat(64)}}];
  store.commit({requestId:randomUUID(),expectedRevision:null,record});store.close();
  expect(reopen(dir).read(record.association.accountId,record.draft.draftId)?.sourceOrigins).toEqual(record.sourceOrigins);
  const wrong=structuredClone(record);wrong.sourceOrigins![0]!.itemId=record.origins![0]!.itemId;
  failure(()=>store.commit({requestId:randomUUID(),expectedRevision:null,record:wrong}),'invalid_input');
  const duplicate=structuredClone(record);duplicate.sourceOrigins!.push(record.sourceOrigins[0]!);
  failure(()=>store.commit({requestId:randomUUID(),expectedRevision:null,record:duplicate}),'invalid_input');
  const missing=structuredClone(record);delete missing.sourceCanonical;
  failure(()=>store.commit({requestId:randomUUID(),expectedRevision:null,record:missing}),'invalid_input');
});

it('isolates drafts and request identifiers across accounts even when draft IDs are identical',()=>{
  const {store}=disk(),first=fixture(),second=fixture({draftId:first.draft.draftId}),requestId=randomUUID();
  store.commit({requestId,expectedRevision:null,record:first});store.commit({requestId,expectedRevision:null,record:second});
  expect(store.list(first.association.accountId)).toEqual([first]);expect(store.list(second.association.accountId)).toEqual([second]);
  expect(store.read(randomUUID(),first.draft.draftId)).toBeUndefined();
  expect(store.receipt(randomUUID(),first.draft.draftId,requestId)).toBeUndefined();
});

it('checks CAS against the latest durable revision across independent store instances',()=>{
  const {dir,store}=disk(),record=fixture();store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const other=reopen(dir),updated=edit(record,2);
  expect(other.read(record.association.accountId,record.draft.draftId)?.draft.revision).toBe(1);
  store.commit({requestId:randomUUID(),expectedRevision:1,record:updated});
  failure(()=>other.commit({requestId:randomUUID(),expectedRevision:1,record:edit(record,2,'过期写入')}),'conflict');
  expect(other.read(record.association.accountId,record.draft.draftId)).toEqual(updated);
  failure(()=>other.commit({requestId:randomUUID(),expectedRevision:null,record}),'conflict');
});

it('replays original receipts without another revision and rejects request reuse with changed content or another draft',()=>{
  const {store}=disk(),record=fixture(),requestId=randomUUID(),input={requestId,expectedRevision:null,record};
  const first=store.commit(input);expect(store.commit(structuredClone(input))).toEqual(first);
  store.commit({requestId:randomUUID(),expectedRevision:1,record:edit(record,2)});
  expect(store.commit(input)).toEqual(first);
  expect(store.read(record.association.accountId,record.draft.draftId)?.draft.revision).toBe(2);
  failure(()=>store.commit({...input,record:edit(record,1,'同请求替换内容')}),'conflict');
  failure(()=>store.commit({...input,record:fixture({accountId:record.association.accountId})}),'conflict');
  expect(store.receipt(record.association.accountId,randomUUID(),requestId)).toBeUndefined();
});

it('persists the original metadata request hash through later edits and rejects same-key changed request hashes',()=>{
  const {dir,store}=disk(),record=fixture(),requestId=randomUUID();
  const input={requestId,expectedRevision:null,record,requestSha256:'a'.repeat(64)},receipt=store.commit(input);
  expect(receipt.requestSha256).toBe(input.requestSha256);
  store.commit({requestId:randomUUID(),expectedRevision:1,record:edit(record,2)});store.close();
  const restored=reopen(dir);
  expect(restored.receipt(record.association.accountId,record.draft.draftId,requestId)).toEqual(receipt);
  expect(restored.commit(input)).toEqual(receipt);
  failure(()=>restored.commit({...input,requestSha256:'b'.repeat(64)}),'conflict');
  expect(restored.read(record.association.accountId,record.draft.draftId)?.draft.revision).toBe(2);
});

it('does not treat object key ordering as changed content for idempotent replay',()=>{
  const {store}=disk(),record=fixture({extra:true}),requestId=randomUUID();
  const input={requestId,expectedRevision:null,record},receipt=store.commit(input),other=structuredClone(input);
  other.record.association={scope:record.association.scope,binding:record.association.binding,botId:record.association.botId,deviceKey:record.association.deviceKey,deviceId:record.association.deviceId,viewId:record.association.viewId,accountId:record.association.accountId};
  expect(store.commit(other)).toEqual(receipt);
});

it.each(['missing','length','sha','base64','duplicate','texts','canonical','public','work','origins','selected'] as const)('rejects %s corruption before writing a draft or a receipt',kind=>{
  const {store}=disk(),original=fixture(),requestId=randomUUID(),record=structuredClone(original);
  if(record.draft.format!=='rich-v2')throw Error('rich fixture required');
  if(kind==='missing')record.members=[];
  if(kind==='length')record.members[0]!.descriptor.bytes++;
  if(kind==='sha')record.members[0]!.descriptor.sha256='0'.repeat(64);
  if(kind==='base64')record.members[0]!.base64=record.members[0]!.base64.replace(/=+$/,'')+'\n';
  if(kind==='duplicate')record.members.push(structuredClone(record.members[0]!));
  if(kind==='texts')record.draft.rich.texts[record.members[0]!.descriptor.objectId]='Unverified replacement';
  if(kind==='canonical')record.draft.rich.canonical=Buffer.from('{}').toString('base64url');
  if(kind==='public')record.draft.public.name='Not the canonical public name';
  if(kind==='work')record.work.draftId=randomUUID();
  if(kind==='origins')record.origins=[{itemId:randomUUID(),source:{kind:'accountClaim'}}];
  if(kind==='selected')record.selected=[randomUUID()];
  failure(()=>store.commit({requestId,expectedRevision:null,record}),'invalid_input');
  expect(store.read(original.association.accountId,original.draft.draftId)).toBeUndefined();
  expect(store.receipt(original.association.accountId,original.draft.draftId,requestId)).toBeUndefined();
});

it('requires source-only objects as well as current objects and refuses a noncanonical source',()=>{
  const {store}=disk(),record=fixture({source:true}),requestId=randomUUID();
  const missing=structuredClone(record);missing.members=missing.members.slice(0,1);
  failure(()=>store.commit({requestId,expectedRevision:null,record:missing}),'invalid_input');
  const malformed=structuredClone(record);malformed.sourceCanonical=Buffer.from(' {} ').toString('base64url');
  failure(()=>store.commit({requestId,expectedRevision:null,record:malformed}),'invalid_input');
  expect(store.commit({requestId,expectedRevision:null,record}).revision).toBe(1);
});

it('soft-deletes atomically with an idempotent receipt while retaining the source data and older receipts',()=>{
  const {dir,store}=disk(),record=fixture({source:true}),requestId=randomUUID();
  const initial=store.commit({requestId,expectedRevision:null,record});
  const input={accountId:record.association.accountId,draftId:record.draft.draftId,requestId:randomUUID(),expectedRevision:1};
  failure(()=>store.discard({...input,expectedRevision:2}),'conflict');
  const receipt=store.discard(input);expect(receipt).toEqual({...initial,requestId:input.requestId,revision:2,deleted:true});
  expect(store.discard(input)).toEqual(receipt);expect(store.read(input.accountId,input.draftId)).toBeUndefined();expect(store.list(input.accountId)).toEqual([]);
  expect(store.receipt(input.accountId,input.draftId,requestId)).toEqual(initial);
  const db=inspect(dir),row=db.prepare('select body from draft_records where account_id=? and draft_id=?').get(input.accountId,input.draftId);
  const index:unknown=JSON.parse(String(row?.body));assert(isRecipeDirectoryIndex(index));
  expect(readRecipeDirectory(realpathSync(dir),input.accountId,input.draftId,index)).toEqual(record);
  expect(store.directory(input.accountId,input.draftId)).toBeUndefined();
  store.close();const restored=reopen(dir);
  expect(restored.list(input.accountId)).toEqual([]);expect(restored.receipt(input.accountId,input.draftId,input.requestId)).toEqual(receipt);
  failure(()=>restored.commit({requestId:randomUUID(),expectedRevision:2,record:edit(record,3)}),'not_found');
});

it('rolls back the draft update if its receipt cannot be written',()=>{
  const {dir,store}=disk(),record=fixture();store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const requestId=randomUUID(),db=inspect(dir);
  db.exec(`create trigger fail_receipt before insert on draft_requests when new.request_id='${requestId}' begin select raise(abort,'synthetic durable write failure'); end`);
  failure(()=>store.commit({requestId,expectedRevision:1,record:edit(record,2)}),'storage');
  expect(store.read(record.association.accountId,record.draft.draftId)).toEqual(record);
  expect(store.receipt(record.association.accountId,record.draft.draftId,requestId)).toBeUndefined();
  expect(reopen(dir).read(record.association.accountId,record.draft.draftId)).toEqual(record);
});

it('detects stored member corruption even when the outer body digest was recomputed',()=>{
  const {dir,store}=disk(),record=fixture();store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const changed=structuredClone(record);changed.members[0]!.base64=Buffer.from('Different source bytes').toString('base64');
  const body=JSON.stringify(changed),db=inspect(dir);
  db.prepare('update draft_records set body=?,body_sha256=? where account_id=? and draft_id=?').run(body,sha(body),record.association.accountId,record.draft.draftId);
  failure(()=>store.read(record.association.accountId,record.draft.draftId),'corrupt');
  failure(()=>reopen(dir).list(record.association.accountId),'corrupt');
});

it('keeps a new pending draft invisible until the exact accepted daemon receipt is committed',()=>{
  const {store}=disk(),record=fixture({source:true,extra:true}),requestId=randomUUID();
  const input={requestId,expectedRevision:null,record};
  store.stage(input);
  expect(store.read(record.association.accountId,record.work.draftId)).toBeUndefined();
  expect(store.list(record.association.accountId)).toEqual([]);
  expect(store.receipt(record.association.accountId,record.work.draftId,requestId)).toBeUndefined();
  expect(store.pending(record.association.accountId,record.work.draftId,requestId)).toEqual(input);
  const result=store.finishPending({accountId:record.association.accountId,draftId:record.work.draftId,requestId,
    receipt:{operationId:requestId,status:'accepted',stateRevision:3,draftId:record.work.draftId,revision:1}});
  expect(store.read(record.association.accountId,record.work.draftId)).toEqual(record);
  expect(store.receipt(record.association.accountId,record.work.draftId,requestId)).toEqual(result);
  expect(store.pending(record.association.accountId,record.work.draftId,requestId)).toBeUndefined();
});

it('keeps the old edit visible and blocks competing metadata writes until acceptance or abort',()=>{
  const {dir,store}=disk(),record=fixture(),accountId=record.association.accountId,draftId=record.work.draftId;
  store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const other=reopen(dir),requestId=randomUUID(),next=edit(record,2),input={requestId,expectedRevision:1,record:next};
  store.stage(input);store.stage(structuredClone(input));
  expect(other.read(accountId,draftId)).toEqual(record);
  failure(()=>other.commit({requestId:randomUUID(),expectedRevision:1,record:edit(record,2,'competing metadata')}),'conflict');
  failure(()=>other.commit(input),'conflict');
  failure(()=>other.discard({accountId,draftId,requestId:randomUUID(),expectedRevision:1}),'conflict');
  failure(()=>other.stage({...input,requestId:randomUUID()}),'conflict');
  failure(()=>other.stage({...input,record:edit(record,2,'same operation changed payload')}),'conflict');
  other.abortPending(accountId,draftId,requestId);
  expect(store.read(accountId,draftId)).toEqual(record);
  expect(store.pending(accountId,draftId,requestId)).toBeUndefined();
  failure(()=>store.stage(input),'conflict');
  const committed=edit(record,2,'metadata after abort');store.commit({requestId:randomUUID(),expectedRevision:1,record:committed});
  expect(store.read(accountId,draftId)).toEqual(committed);
});

it('retains exact pending bytes across restart and finishes acknowledgement-loss recovery once',()=>{
  const {dir,store}=disk(),record=fixture({source:true,extra:true}),accountId=record.association.accountId,draftId=record.work.draftId,requestId=randomUUID();
  const input={requestId,expectedRevision:null,record,requestSha256:'e'.repeat(64)};
  store.stage(input);store.close();
  const restored=reopen(dir);expect(restored.pending(accountId,draftId,requestId)).toEqual(input);
  expect(restored.list(accountId)).toEqual([]);
  const proof={accountId,draftId,requestId,receipt:{operationId:requestId,status:'accepted' as const,stateRevision:3 as const,draftId,revision:1}};
  const first=restored.finishPending(proof);expect(restored.finishPending(proof)).toEqual(first);
  restored.stage(input);expect(restored.read(accountId,draftId)).toEqual(record);
  expect(restored.pending(accountId,draftId,requestId)).toBeUndefined();
  expect(statSync(dir).mode&0o777).toBe(0o700);expect(statSync(join(dir,'drafts.sqlite')).mode&0o777).toBe(0o600);
});

it('refuses cancelled, expired, substituted or wrong-revision acceptance proofs without exposing pending content',()=>{
  const {store}=disk(),record=fixture(),accountId=record.association.accountId,draftId=record.work.draftId,requestId=randomUUID();
  store.stage({requestId,expectedRevision:null,record});
  const proof={accountId,draftId,requestId,receipt:{operationId:requestId,status:'accepted' as const,stateRevision:3 as const,draftId,revision:1}};
  failure(()=>store.finishPending({...proof,receipt:{operationId:requestId,status:'cancelled',stateRevision:2}}),'invalid_input');
  failure(()=>store.finishPending({...proof,receipt:{operationId:requestId,status:'expired',stateRevision:2}}),'invalid_input');
  failure(()=>store.finishPending({...proof,receipt:{...proof.receipt,operationId:randomUUID()}}),'conflict');
  failure(()=>store.finishPending({...proof,receipt:{...proof.receipt,draftId:randomUUID()}}),'conflict');
  failure(()=>store.finishPending({...proof,receipt:{...proof.receipt,revision:2}}),'conflict');
  expect(store.read(accountId,draftId)).toBeUndefined();expect(store.pending(accountId,draftId,requestId)).toBeDefined();
});

it('isolates pending operations by account and refuses account-global request reuse for another draft',()=>{
  const {store}=disk(),record=fixture(),other=fixture({draftId:record.work.draftId}),requestId=randomUUID();
  store.stage({requestId,expectedRevision:null,record});store.stage({requestId,expectedRevision:null,record:other});
  expect(store.pending(randomUUID(),record.work.draftId,requestId)).toBeUndefined();
  expect(store.pending(record.association.accountId,randomUUID(),requestId)).toBeUndefined();
  const unrelated=fixture({accountId:record.association.accountId});
  failure(()=>store.stage({requestId,expectedRevision:null,record:unrelated}),'conflict');
  failure(()=>store.commit({requestId,expectedRevision:null,record:unrelated}),'conflict');
  store.abortPending(record.association.accountId,record.work.draftId,requestId);
  expect(store.pending(other.association.accountId,other.work.draftId,requestId)?.record).toEqual(other);
});

it('rolls back acceptance, visible head and receipt together if the durable acceptance proof cannot be written',()=>{
  const {dir,store}=disk(),record=fixture(),accountId=record.association.accountId,draftId=record.work.draftId,requestId=randomUUID();
  const input={requestId,expectedRevision:null,record};store.stage(input);
  const proof={accountId,draftId,requestId,receipt:{operationId:requestId,status:'accepted' as const,stateRevision:3 as const,draftId,revision:1}};
  const db=inspect(dir);
  db.exec(`create trigger fail_pending_acceptance before insert on draft_acceptances when new.request_id='${requestId}' begin select raise(abort,'synthetic acceptance write failure'); end`);
  failure(()=>store.finishPending(proof),'storage');
  expect(store.read(accountId,draftId)).toBeUndefined();expect(store.receipt(accountId,draftId,requestId)).toBeUndefined();
  expect(reopen(dir).pending(accountId,draftId,requestId)).toEqual(input);
  db.exec('drop trigger fail_pending_acceptance');
  const result=store.finishPending(proof);expect(store.read(accountId,draftId)).toEqual(record);
  store.commit({requestId:randomUUID(),expectedRevision:1,record:edit(record,2)});
  expect(store.finishPending(proof)).toEqual(result);
  expect(store.read(accountId,draftId)?.draft.revision).toBe(2);
});

it('detects damaged staged bytes before reading or accepting them and never reveals a visible draft',()=>{
  const {dir,store}=disk(),record=fixture(),accountId=record.association.accountId,draftId=record.work.draftId,requestId=randomUUID();
  const input={requestId,expectedRevision:null,record};store.stage(input);
  const db=inspect(dir),changed={...input,record:edit(record,1,'substituted staged bytes')};
  db.prepare('update draft_pending set input=? where account_id=? and request_id=?').run(JSON.stringify(changed),accountId,requestId);
  failure(()=>store.pending(accountId,draftId,requestId),'corrupt');
  failure(()=>store.finishPending({accountId,draftId,requestId,receipt:{operationId:requestId,status:'accepted',stateRevision:3,draftId,revision:1}}),'corrupt');
  expect(store.read(accountId,draftId)).toBeUndefined();expect(store.list(accountId)).toEqual([]);
});

it('supports isolated in-memory use without an account or network client',()=>{
  const store=new LocalRecipeDrafts();stores.push(store);const record=fixture();
  store.commit({requestId:randomUUID(),expectedRevision:null,record});
  expect(store.read(record.association.accountId,record.draft.draftId)).toEqual(record);
  const empty=new LocalRecipeDrafts();stores.push(empty);expect(empty.list(record.association.accountId)).toEqual([]);
});

it('persists an explicitly supplied local role draft without inventing a rich source or attachments',()=>{
  const {dir,store}=disk(),rich=fixture(),record:LocalRecipeDraftRecord={association:rich.association,
    work:{draftId:rich.draft.draftId,source:null},draft:{format:'role-v1',draftId:rich.draft.draftId,recipeId:null,revision:1,
      public:rich.draft.public,config:{role:'Local role bytes'}},members:[]};
  const receipt=store.commit({requestId:randomUUID(),expectedRevision:null,record});
  expect(receipt.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(reopen(dir).read(record.association.accountId,record.draft.draftId)).toEqual(record);
});

it('reads the active distributable folder and keeps proof, account data and unused candidates private',()=>{
  const {dir,store}=disk(),record=fixture({source:true,extra:true}),{accountId}=record.association,{draftId}=record.draft;
  assert(record.draft.format==='rich-v2');
  const initial=store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const folder=store.directory(accountId,draftId)!;
  const raw=readFileSync(join(folder,'manifest.json'),'utf8'),manifest=JSON.parse(raw);
  expect(manifest.public).toEqual(record.draft.public);
  expect(manifest.config.role).toEqual(record.draft.rich.content.role);
  expect(manifest.config.files[0].paths).toEqual(['skills/local-skill/SKILL.md']);
  const entry=join(folder,'skills','local-skill','SKILL.md');
  expect(readFileSync(entry,'utf8')).toContain('Only local draft bytes.');
  expect(raw).not.toContain(record.association.deviceKey);
  expect(raw).not.toContain(record.association.binding);
  expect(raw).not.toContain(accountId);
  expect(raw).not.toContain('Original unselected source bytes.');
  const db=inspect(dir),index=String(db.prepare('select body from draft_records').get()?.body);
  expect(index).not.toContain(record.members[0]!.base64);
  const next=edit(record,2);store.commit({requestId:randomUUID(),expectedRevision:1,record:next});
  expect(store.directory(accountId,draftId)).not.toBe(folder);
  expect(JSON.parse(readFileSync(join(store.directory(accountId,draftId)!,'manifest.json'),'utf8')).public.name).toBe(next.draft.public.name);
  expect(JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8')).public.name).toBe(record.draft.public.name);
  expect(store.receipt(accountId,draftId,initial.requestId)).toEqual(initial);
  const currentEntry=join(store.directory(accountId,draftId)!,'skills','local-skill','SKILL.md');
  writeFileSync(currentEntry,'malformed external edit');
  failure(()=>reopen(dir).read(accountId,draftId),'corrupt');
  failure(()=>reopen(dir).list(accountId),'corrupt');
});

it('migrates an existing SQLite-only head on first read and preserves its operation receipts and source provenance',()=>{
  const {dir,store}=disk(),record=fixture({source:true,extra:true}),{accountId}=record.association,{draftId}=record.draft;
  const input={requestId:randomUUID(),expectedRevision:null,record},receipt=store.commit(input);
  const folder=store.directory(accountId,draftId)!;
  const db=inspect(dir),old=JSON.stringify(record);
  db.prepare('update draft_records set body=?,body_sha256=?').run(old,sha(old));
  rmSync(folder,{recursive:true});
  store.close();
  const next=reopen(dir);
  expect(next.list(accountId)).toEqual([record]);
  expect(next.read(accountId,draftId)).toEqual(record);
  expect(next.commit(input)).toEqual(receipt);
  const index=JSON.parse(String(db.prepare('select body from draft_records').get()?.body));
  expect(index.storage).toBe('recipe-directory-v1');
  expect(readFileSync(join(next.directory(accountId,draftId)!,'skills/local-skill/SKILL.md'),'utf8')).toContain('Only local draft bytes.');
});

it('rejects a substituted hard link even when the outside file has the expected bytes',()=>{
  const {dir,store}=disk(),record=fixture(),{accountId}=record.association,{draftId}=record.draft;
  store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const entry=join(store.directory(accountId,draftId)!,'skills','local-skill','SKILL.md');
  const outside=join(dir,'outside.txt');
  writeFileSync(outside,readFileSync(entry));unlinkSync(entry);linkSync(outside,entry);
  failure(()=>store.read(accountId,draftId),'corrupt');
  expect(readFileSync(outside,'utf8')).toContain('Only local draft bytes.');
});

it('does not leave a visible package for a newly rolled-back revision and can retry the same edit',()=>{
  const {dir,store}=disk(),record=fixture(),{accountId}=record.association,{draftId}=record.draft;
  store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const input={requestId:randomUUID(),expectedRevision:1,record:edit(record,2)},db=inspect(dir);
  db.exec("create trigger fail_directory_receipt before insert on draft_requests begin select raise(abort,'failed receipt'); end");
  failure(()=>store.commit(input),'storage');
  const parent=join(dir,'recipes',accountId,draftId);
  expect(readdirSync(parent)).toHaveLength(1);expect(store.read(accountId,draftId)).toEqual(record);
  db.exec('drop trigger fail_directory_receipt');
  expect(store.commit(input).revision).toBe(2);expect(store.commit(input).revision).toBe(2);
  expect(readdirSync(parent)).toHaveLength(2);expect(store.read(accountId,draftId)).toEqual(input.record);
});


it('writes nested inline references and disambiguates two identically named skills sharing the same files',()=>{
  const {dir,store}=disk(),record=fixture();assert(record.draft.format==='rich-v2');
  const {rich}=record.draft,first=rich.content.skills[0]!,entry=rich.content.files[0]!;
  first.name='会议助手';
  const reference={itemId:randomUUID(),originId:randomUUID(),name:'references/写作指南.md',use:'reference' as const,
    text:{kind:'inline' as const,value:'\uFEFF# 写作指南\n保留文档原样。\n'}};
  rich.content.files.push(reference);first.fileIds=[entry.itemId,reference.itemId];
  rich.content.skills.push({...first,itemId:randomUUID(),originId:randomUUID()});
  const doc=canonicalizeRichRecipeContent(rich.content);rich.content=doc.content;rich.canonical=Buffer.from(doc.canonicalUTF8).toString('base64url');
  record.sourceCanonical=rich.canonical;
  store.commit({requestId:randomUUID(),expectedRevision:null,record});
  const {accountId}=record.association,{draftId}=record.draft,folder=store.directory(accountId,draftId)!;
  const skills=readdirSync(join(folder,'skills'));
  expect(skills).toHaveLength(2);
  for(const name of skills)expect(readFileSync(join(folder,'skills',name,reference.name),'utf8')).toBe(reference.text.value);
  expect(reopen(dir).read(accountId,draftId)).toEqual(record);
  writeFileSync(join(folder,'untracked.txt'),'untracked document');
  failure(()=>store.directory(accountId,draftId),'corrupt');
  unlinkSync(join(folder,'untracked.txt'));
  writeFileSync(join(folder,'skills',skills[1]!,reference.name),'changed copy');
  failure(()=>store.read(accountId,draftId),'corrupt');
});
