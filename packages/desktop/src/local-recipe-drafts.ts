import {createHash} from 'node:crypto';
import {chmodSync,closeSync,constants,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {authoringReceiptSchema,creatorWorkSchema,decodeRichRecipeContent,recipeDraftSchema,recipeRichOriginEdgeSchema,recipeRichPartDescriptorSchema,
  validateWritableRichRecipeContent,type AuthoringReceipt,type RecipeRichPartDescriptor} from '@vonvon/protocol';
import {isRecipeDirectoryIndex,readRecipeDirectory,recipeDirectoryPath,writeRecipeDirectory} from './local-recipe-directory.js';
import {creatorAssociationSchema} from './recipe-creator-journal.js';

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.number().int().positive().max(2147483647);
const canonical=z.string().min(1).max(1401000).regex(/^[A-Za-z0-9_-]+$/);
const origins=z.object({itemId:uuid,source:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('accountClaim')}).strict(),
  recipeRichOriginEdgeSchema.extend({kind:z.literal('releaseItem')}).strict(),
  z.object({kind:z.literal('releaseItems'),parents:recipeRichOriginEdgeSchema.array().min(1).max(64)}).strict(),
])}).strict();

export const localRecipeDraftRecordSchema=z.object({
  association:creatorAssociationSchema,work:creatorWorkSchema,draft:recipeDraftSchema,
  sourceCanonical:canonical.optional(),parent:z.object({recipeId:uuid,versionId:uuid}).strict().nullable().optional(),
  origins:origins.array().max(512).optional(),sourceOrigins:origins.array().max(512).optional(),selected:uuid.array().max(512).optional(),
  members:z.object({descriptor:recipeRichPartDescriptorSchema,base64:z.string().max(174764).regex(/^[A-Za-z0-9+/]*={0,2}$/)}).strict().array().max(388),
}).strict();
export type LocalRecipeDraftRecord=z.infer<typeof localRecipeDraftRecordSchema>;
export const localRecipeDraftReceiptSchema=z.object({
  accountId:uuid,draftId:uuid,requestId:uuid,revision,contentSha256:digest,deleted:z.boolean(),requestSha256:digest.optional(),
}).strict();
export type LocalRecipeDraftReceipt=z.infer<typeof localRecipeDraftReceiptSchema>;
export class LocalRecipeDraftError extends Error {
  constructor(readonly code:'invalid_input'|'conflict'|'not_found'|'corrupt'|'storage',message:string){super(message);this.name='LocalRecipeDraftError';}
}

const maximumRecordBytes=8*1024*1024;
const hash=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const invalid=()=>new LocalRecipeDraftError('invalid_input','本地草稿内容未通过完整性核对。');
const corrupt=()=>new LocalRecipeDraftError('corrupt','本地草稿记录已损坏，无法继续读取。');
const conflict=()=>new LocalRecipeDraftError('conflict','本地草稿已改变，请重新读取后继续。');
const missing=()=>new LocalRecipeDraftError('not_found','这份本地草稿已不存在。');
function stableJson(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stableJson).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([key,item])=>JSON.stringify(key)+':'+stableJson(item)).join(',')+'}';
  const text=JSON.stringify(value);if(text===undefined)throw invalid();return text;
}
function decodeCanonical(value:string){
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value)throw invalid();
  return decodeRichRecipeContent(bytes);
}
function itemIds(value:unknown,result=new Set<string>()):Set<string>{
  if(Array.isArray(value)){for(const item of value)itemIds(item,result);}
  else if(value!==null&&typeof value==='object'){
    if('itemId' in value&&typeof value.itemId==='string')result.add(value.itemId);
    for(const item of Object.values(value))itemIds(item,result);
  }
  return result;
}
function checkedRecord(raw:unknown){
  try{
    const record=localRecipeDraftRecordSchema.parse(raw),draft=record.draft;
    if(record.work.draftId!==draft.draftId)throw invalid();
    const members=new Map<string,{descriptor:RecipeRichPartDescriptor;bytes:Buffer}>();
    for(const member of record.members){
      const bytes=Buffer.from(member.base64,'base64'),descriptor=member.descriptor;
      if(bytes.toString('base64')!==member.base64||bytes.byteLength!==descriptor.bytes||hash(bytes)!==descriptor.sha256||members.has(descriptor.objectId))throw invalid();
      members.set(descriptor.objectId,{descriptor,bytes});
    }
    const requireMembers=(parts:RecipeRichPartDescriptor[])=>{
      for(const part of parts){const member=members.get(part.objectId);if(!member||!isDeepStrictEqual(member.descriptor,part))throw invalid();}
    };
    let contentSha256:string;
    if(draft.format==='rich-v2'){
      if(!record.work.source||record.work.source.preparationId!==draft.sourceIntentId)throw invalid();
      const decoded=decodeCanonical(draft.rich.canonical);
      validateWritableRichRecipeContent(decoded.content);
      if(!isDeepStrictEqual(decoded.content,draft.rich.content))throw invalid();
      if((['name','summary','overview','version'] as const).some(field=>decoded.content.public[field].value!==draft.public[field]))throw invalid();
      requireMembers(decoded.content.parts);
      const texts:Record<string,string>={};
      for(const part of decoded.content.parts)if(part.kind==='text'){
        const member=members.get(part.objectId);if(!member)throw invalid();
        texts[part.objectId]=new TextDecoder('utf-8',{fatal:true}).decode(member.bytes);
      }
      if(!isDeepStrictEqual(texts,draft.rich.texts))throw invalid();
      if(draft.logo!==undefined){
        const logoId=decoded.content.finalLogo?.objectId,logo=logoId?members.get(logoId):undefined;
        if(!logo||draft.logo!=='data:image/webp;base64,'+logo.bytes.toString('base64'))throw invalid();
      }
      const current=itemIds(decoded.content),available=new Set(current),sourceItems=new Set<string>();
      if(record.sourceCanonical){
        const source=decodeCanonical(record.sourceCanonical);requireMembers(source.content.parts);
        for(const id of itemIds(source.content)){available.add(id);sourceItems.add(id);}
      }
      if(record.origins){
        const seen=new Set<string>();
        for(const origin of record.origins){if(!current.has(origin.itemId)||seen.has(origin.itemId))throw invalid();seen.add(origin.itemId);}
      }
      if(record.sourceOrigins){
        const seen=new Set<string>();
        for(const origin of record.sourceOrigins){if(!sourceItems.has(origin.itemId)||seen.has(origin.itemId))throw invalid();seen.add(origin.itemId);}
      }
      if(record.selected&&(new Set(record.selected).size!==record.selected.length||record.selected.some(id=>!available.has(id))))throw invalid();
      contentSha256=hash(decoded.canonicalUTF8);
    }else{
      if(record.work.source!==null||record.sourceCanonical||record.members.length||record.origins?.length||record.sourceOrigins?.length||record.selected?.length)throw invalid();
      contentSha256=hash(stableJson(draft.config));
    }
    const body=JSON.stringify(record);
    if(Buffer.byteLength(body)>maximumRecordBytes)throw invalid();
    return {record,body,contentSha256,recordSha256:hash(stableJson(record))};
  }catch{throw invalid();}
}

const draftRow=z.object({account_id:uuid,draft_id:uuid,revision,deleted:z.union([z.literal(0),z.literal(1)]),body:z.string().max(maximumRecordBytes),body_sha256:digest}).strict();
const requestRow=z.object({account_id:uuid,draft_id:uuid,request_id:uuid,input_sha256:digest,receipt:z.string().max(2048),receipt_sha256:digest}).strict();
const commitInput=z.object({requestId:uuid,expectedRevision:revision.nullable(),record:localRecipeDraftRecordSchema,requestSha256:digest.optional()}).strict();
const discardInput=z.object({accountId:uuid,draftId:uuid,requestId:uuid,expectedRevision:revision}).strict();
const pendingRow=z.object({account_id:uuid,draft_id:uuid,request_id:uuid,input:z.string().max(maximumRecordBytes+4096),input_sha256:digest}).strict();
const finishInput=z.object({accountId:uuid,draftId:uuid,requestId:uuid,receipt:authoringReceiptSchema.options[0]}).strict();
export type LocalRecipeDraftPending=z.infer<typeof commitInput>;
function prepareCommit(raw:LocalRecipeDraftPending){
  let input:LocalRecipeDraftPending;
  try{input=commitInput.parse(raw);}catch{throw invalid();}
  const checked=checkedRecord(input.record);
  return {input,checked,inputSha256:hash(stableJson({kind:'commit',...input}))};
}

export class LocalRecipeDrafts {
  private connection?:DatabaseSync;
  private packageRoot?:string;
  private createdDirectories?:string[];
  constructor(private readonly dir?:string){}
  private db(){
    if(this.connection)return this.connection;
    let db:DatabaseSync|undefined;
    try{
      let path:string|undefined;
      if(this.dir){
        mkdirSync(this.dir,{recursive:true,mode:0o700});
        if(!lstatSync(this.dir).isDirectory())throw corrupt();
        const root=realpathSync(this.dir);
        chmodSync(root,0o700);path=join(root,'drafts.sqlite');
        const fd=openSync(path,constants.O_CREAT|constants.O_RDWR|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0),0o600);
        try{
          const stat=fstatSync(fd);
          if(!stat.isFile()||stat.nlink!==1||realpathSync(path)!==path)throw corrupt();
          fchmodSync(fd,0o600);
        }finally{closeSync(fd);}
        this.packageRoot=root;
      }
      db=new DatabaseSync(path??':memory:');
      db.exec(`
        pragma busy_timeout = 5000;
        pragma journal_mode = DELETE;
        pragma synchronous = EXTRA;
        pragma fullfsync = ON;
        create table if not exists draft_records (
          account_id text not null, draft_id text not null, revision integer not null, deleted integer not null check(deleted in (0,1)),
          body text not null, body_sha256 text not null, primary key(account_id,draft_id)
        ) without rowid;
        create table if not exists draft_requests (
          account_id text not null, draft_id text not null, request_id text not null, input_sha256 text not null,
          receipt text not null, receipt_sha256 text not null, primary key(account_id,request_id)
        ) without rowid;
        create table if not exists draft_pending (
          account_id text not null, draft_id text not null, request_id text not null, input text not null, input_sha256 text not null,
          primary key(account_id,request_id), unique(account_id,draft_id)
        ) without rowid;
        create table if not exists draft_acceptances (
          account_id text not null, draft_id text not null, request_id text not null, proof_sha256 text not null,
          primary key(account_id,request_id)
        ) without rowid;
        create table if not exists draft_aborted (
          account_id text not null, draft_id text not null, request_id text not null, input_sha256 text not null,
          primary key(account_id,request_id)
        ) without rowid;
      `);
      this.connection=db;return db;
    }catch{db?.close();throw new LocalRecipeDraftError('storage','无法打开本地草稿存储。');}
  }
  close(){this.connection?.close();this.connection=undefined;this.packageRoot=undefined;}
  private diskBody(checked:ReturnType<typeof checkedRecord>){
    if(!this.packageRoot)return checked.body;
    const saved=writeRecipeDirectory(this.packageRoot,checked.record,checked.recordSha256);
    if(saved.created)this.createdDirectories!.push(saved.created);
    return JSON.stringify(saved.index);
  }
  private decodeStored(raw:unknown,accountId:string,draftId?:string){
    try{
      const row=draftRow.parse(raw);
      if(row.account_id!==accountId||draftId!==undefined&&row.draft_id!==draftId||hash(row.body)!==row.body_sha256)throw corrupt();
      const body:unknown=JSON.parse(row.body);
      const index=isRecipeDirectoryIndex(body)?body:undefined;
      if(index&&!this.packageRoot)throw corrupt();
      const checked=checkedRecord(index?readRecipeDirectory(this.packageRoot!,accountId,row.draft_id,index):body);
      if(index&&checked.recordSha256!==index.recordSha256)throw corrupt();
      if(checked.record.association.accountId!==accountId||checked.record.draft.draftId!==row.draft_id||
        row.revision!==checked.record.draft.revision+row.deleted)throw corrupt();
      if(this.packageRoot&&!index){
        // Migrate a verified SQLite-only row under the same lock that protects a normal edit.
        const migrate=(db:DatabaseSync)=>{
          const current=db.prepare('select revision,body_sha256 from draft_records where account_id=? and draft_id=?').get(accountId,row.draft_id);
          if(current?.revision!==row.revision||current.body_sha256!==row.body_sha256)return;
          const migrated=this.diskBody(checked);
          db.prepare('update draft_records set body=?,body_sha256=? where account_id=? and draft_id=?').run(migrated,hash(migrated),accountId,row.draft_id);
        };
        if(this.createdDirectories)migrate(this.db());else this.transaction(migrate);
      }
      return {...checked,revision:row.revision,deleted:row.deleted===1};
    }catch(error){if(error instanceof LocalRecipeDraftError&&error.code==='storage')throw error;throw corrupt();}
  }
  private stored(accountId:string,draftId:string){
    const raw=this.db().prepare('select * from draft_records where account_id=? and draft_id=?').get(accountId,draftId);
    return raw?this.decodeStored(raw,accountId,draftId):undefined;
  }
  private previous(accountId:string,requestId:string){
    const raw=this.db().prepare('select * from draft_requests where account_id=? and request_id=?').get(accountId,requestId);
    if(!raw)return;
    try{
      const row=requestRow.parse(raw);
      if(row.account_id!==accountId||row.request_id!==requestId||hash(row.receipt)!==row.receipt_sha256)throw corrupt();
      const receipt=localRecipeDraftReceiptSchema.parse(JSON.parse(row.receipt));
      if(receipt.accountId!==accountId||receipt.draftId!==row.draft_id||receipt.requestId!==requestId)throw corrupt();
      return {inputSha256:row.input_sha256,receipt};
    }catch{throw corrupt();}
  }
  private transaction<T>(run:(db:DatabaseSync)=>T):T{
    const db=this.db();
    try{db.exec('BEGIN IMMEDIATE');}catch{throw new LocalRecipeDraftError('storage','本地草稿正在写入，请稍后重试。');}
    this.createdDirectories=[];
    try{db.exec('SAVEPOINT draft_write');const value=run(db);db.exec('COMMIT');return value;}
    catch(error){
      // Only remove packages while this connection still owns its original write lock.
      try{
        db.exec('ROLLBACK TO draft_write');
        for(const path of this.createdDirectories)rmSync(path,{recursive:true,force:true});
      }catch{}
      try{db.exec('ROLLBACK');}catch{}
      if(error instanceof LocalRecipeDraftError)throw error;
      throw new LocalRecipeDraftError('storage','本地草稿保存未完成，请重试原请求。');
    }finally{this.createdDirectories=undefined;}
  }
  private saveReceipt(db:DatabaseSync,receipt:LocalRecipeDraftReceipt,inputSha256:string){
    const body=JSON.stringify(localRecipeDraftReceiptSchema.parse(receipt));
    db.prepare('insert into draft_requests values (?,?,?,?,?,?)').run(receipt.accountId,receipt.draftId,receipt.requestId,inputSha256,body,hash(body));
  }
  private staged(accountId:string,requestId:string){
    const raw=this.db().prepare('select * from draft_pending where account_id=? and request_id=?').get(accountId,requestId);
    if(!raw)return;
    try{
      const row=pendingRow.parse(raw),prepared=prepareCommit(JSON.parse(row.input));
      if(row.account_id!==accountId||row.request_id!==requestId||prepared.input.record.association.accountId!==accountId||
        prepared.input.record.work.draftId!==row.draft_id||prepared.input.requestId!==requestId||prepared.inputSha256!==row.input_sha256||
        prepared.input.record.draft.revision!==(prepared.input.expectedRevision??0)+1)throw corrupt();
      return {...prepared,draftId:row.draft_id};
    }catch{throw corrupt();}
  }
  private checkUnreserved(accountId:string,draftId:string,requestId:string){
    if(this.staged(accountId,requestId)||this.db().prepare('select 1 from draft_pending where account_id=? and draft_id=?').get(accountId,draftId)||
      this.db().prepare('select 1 from draft_aborted where account_id=? and request_id=?').get(accountId,requestId))throw conflict();
  }
  private checkHead(input:LocalRecipeDraftPending){
    const current=this.stored(input.record.association.accountId,input.record.work.draftId);
    if(current?.deleted)throw missing();
    if(input.expectedRevision===null?current!==undefined:!current||current.revision!==input.expectedRevision)throw conflict();
    if(input.record.draft.revision!==(input.expectedRevision??0)+1)throw conflict();
  }
  private writeCommitted(db:DatabaseSync,prepared:ReturnType<typeof prepareCommit>){
    const {input,checked,inputSha256}=prepared,{record,contentSha256}=checked;
    this.checkHead(input);
    const accountId=record.association.accountId,draftId=record.work.draftId,nextRevision=record.draft.revision;
    const body=this.diskBody(checked);
    db.prepare(`insert into draft_records values (?,?,?,?,?,?) on conflict(account_id,draft_id) do update set
      revision=excluded.revision,deleted=excluded.deleted,body=excluded.body,body_sha256=excluded.body_sha256`)
      .run(accountId,draftId,nextRevision,0,body,hash(body));
    const receipt={accountId,draftId,requestId:input.requestId,revision:nextRevision,contentSha256,deleted:false,
      ...(input.requestSha256&&{requestSha256:input.requestSha256})};
    this.saveReceipt(db,receipt,inputSha256);return receipt;
  }
  stage(raw:LocalRecipeDraftPending):void{
    const prepared=prepareCommit(raw),{input,inputSha256}=prepared,accountId=input.record.association.accountId,draftId=input.record.work.draftId;
    this.transaction(db=>{
      const previous=this.previous(accountId,input.requestId);
      if(previous){if(previous.inputSha256!==inputSha256)throw conflict();return;}
      const held=this.staged(accountId,input.requestId);
      if(held){if(held.inputSha256!==inputSha256)throw conflict();return;}
      this.checkUnreserved(accountId,draftId,input.requestId);this.checkHead(input);
      db.prepare('insert into draft_pending values (?,?,?,?,?)').run(accountId,draftId,input.requestId,JSON.stringify(input),inputSha256);
    });
  }
  pending(accountId:string,draftId:string,requestId:string):LocalRecipeDraftPending|undefined{
    uuid.parse(accountId);uuid.parse(draftId);uuid.parse(requestId);
    const held=this.staged(accountId,requestId);return held?.draftId===draftId?held.input:undefined;
  }
  finishPending(raw:{accountId:string;draftId:string;requestId:string;receipt:AuthoringReceipt}):LocalRecipeDraftReceipt{
    let input:z.infer<typeof finishInput>;
    try{input=finishInput.parse(raw);}catch{throw invalid();}
    const {accountId,draftId,requestId,receipt}=input;
    if(receipt.operationId!==requestId||receipt.draftId!==draftId)throw conflict();
    const proofSha256=hash(stableJson(receipt));
    return this.transaction(db=>{
      const previous=this.previous(accountId,requestId);
      if(previous){
        const accepted=db.prepare('select draft_id,proof_sha256 from draft_acceptances where account_id=? and request_id=?').get(accountId,requestId);
        if(previous.receipt.draftId!==draftId||previous.receipt.deleted||previous.receipt.revision!==receipt.revision||
          accepted?.draft_id!==draftId||accepted.proof_sha256!==proofSha256)throw conflict();
        return previous.receipt;
      }
      const held=this.staged(accountId,requestId);
      if(!held||held.draftId!==draftId)throw missing();
      if(held.input.record.draft.revision!==receipt.revision)throw conflict();
      const committed=this.writeCommitted(db,held);
      db.prepare('insert into draft_acceptances values (?,?,?,?)').run(accountId,draftId,requestId,proofSha256);
      db.prepare('delete from draft_pending where account_id=? and request_id=?').run(accountId,requestId);
      return committed;
    });
  }
  abortPending(accountId:string,draftId:string,requestId:string):void{
    uuid.parse(accountId);uuid.parse(draftId);uuid.parse(requestId);
    this.transaction(db=>{
      const held=this.staged(accountId,requestId);
      if(!held||held.draftId!==draftId)return;
      db.prepare('insert into draft_aborted values (?,?,?,?)').run(accountId,draftId,requestId,held.inputSha256);
      db.prepare('delete from draft_pending where account_id=? and request_id=?').run(accountId,requestId);
    });
  }
  read(accountId:string,draftId:string):LocalRecipeDraftRecord|undefined{
    const row=this.stored(uuid.parse(accountId),uuid.parse(draftId));return row&&!row.deleted?row.record:undefined;
  }
  directory(accountId:string,draftId:string):string|undefined{
    const row=this.stored(uuid.parse(accountId),uuid.parse(draftId));
    if(!row||row.deleted||!this.packageRoot)return;
    return recipeDirectoryPath(this.packageRoot,accountId,draftId,{recordSha256:row.recordSha256,draft:{revision:row.record.draft.revision}});
  }
  list(accountId:string):LocalRecipeDraftRecord[]{
    uuid.parse(accountId);
    const rows=this.db().prepare('select * from draft_records where account_id=? and deleted=0 order by draft_id').all(accountId);
    return rows.map(row=>this.decodeStored(row,accountId).record);
  }
  receipt(accountId:string,draftId:string,requestId:string):LocalRecipeDraftReceipt|undefined{
    uuid.parse(accountId);uuid.parse(draftId);uuid.parse(requestId);
    const row=this.previous(accountId,requestId);return row?.receipt.draftId===draftId?row.receipt:undefined;
  }
  commit(raw:{requestId:string;expectedRevision:number|null;record:LocalRecipeDraftRecord;requestSha256?:string}):LocalRecipeDraftReceipt{
    const prepared=prepareCommit(raw),{input,checked,inputSha256}=prepared,{record}=checked;
    const accountId=record.association.accountId,draftId=record.draft.draftId;
    return this.transaction(db=>{
      const previous=this.previous(accountId,input.requestId);
      if(previous){if(previous.inputSha256!==inputSha256)throw conflict();return previous.receipt;}
      this.checkUnreserved(accountId,draftId,input.requestId);
      return this.writeCommitted(db,prepared);
    });
  }
  discard(raw:{accountId:string;draftId:string;requestId:string;expectedRevision:number}):LocalRecipeDraftReceipt{
    let input:z.infer<typeof discardInput>;
    try{input=discardInput.parse(raw);}catch{throw invalid();}
    const inputSha256=hash(stableJson({kind:'discard',...input}));
    return this.transaction(db=>{
      const previous=this.previous(input.accountId,input.requestId);
      if(previous){if(previous.inputSha256!==inputSha256)throw conflict();return previous.receipt;}
      this.checkUnreserved(input.accountId,input.draftId,input.requestId);
      const current=this.stored(input.accountId,input.draftId);
      if(!current||current.deleted)throw missing();
      if(current.revision!==input.expectedRevision||current.revision===2147483647)throw conflict();
      const nextRevision=current.revision+1;
      db.prepare('update draft_records set revision=?,deleted=1 where account_id=? and draft_id=?').run(nextRevision,input.accountId,input.draftId);
      const receipt={accountId:input.accountId,draftId:input.draftId,requestId:input.requestId,revision:nextRevision,contentSha256:current.contentSha256,deleted:true};
      this.saveReceipt(db,receipt,inputSha256);return receipt;
    });
  }
}
