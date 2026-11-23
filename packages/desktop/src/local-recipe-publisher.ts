import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {chmodSync,closeSync,existsSync,mkdirSync,openSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {authoringOperationSchema,creatorAnswerSchema,decodeRichRecipeContent,newRichMetadataRequestId,recipeDraftSchema,
  recipeRichPartDescriptorSchema,richFreezeInputSchema,richFrozenResponseSchema,validateWritableRichRecipeContent,
  type CreatorAnswer,type RecipeRichContent,type RecipeRichText,type RichFreezeInput} from '@vonvon/protocol';
import {richPossessionProof,verifyFrozenRich} from '../../daemon/src/recipe/authoring-rich-proof.js';
import type {NativeAccount} from './account-session.js';
import {boundedJson} from './community-response.js';
import {localRecipeDraftRecordSchema,type LocalRecipeDraftRecord} from './local-recipe-drafts.js';
import {dispatchDigest} from './recipe-authoring-cloud.js';
import {richAuthoringCloud} from './recipe-authoring-rich-cloud.js';
import {CreatorCloudRejected,publicationReceipt} from './recipe-creator-cloud.js';
import {creatorSha,creatorSnapshotDigest,sameCreatorSource,type CreatorCommandRecord} from './recipe-creator-journal.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),binary=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const positive=z.number().int().positive();
const progressSchema=z.object({
  accountId:uuid,requestId:uuid,binding:sha,recordDigest:sha,cloudOperationId:uuid,createdAt:z.number().int(),
  key:z.object({targetPublicKey:binary,secret:binary,nonce:binary,nonceCommitment:binary}).strict(),
  generation:z.number().int().nonnegative(),preserveSelectedParent:z.literal(true).optional(),format:z.enum(['rich-v2','role-v1']),remoteDraftId:uuid.optional(),
  dispatched:z.boolean(),descriptors:recipeRichPartDescriptorSchema.array().max(65),
  frozen:richFrozenResponseSchema.optional(),manifestId:uuid.optional(),accepted:z.boolean(),result:creatorAnswerSchema.refine(answer=>answer.kind==='published').optional(),
}).strict();
type Progress=z.infer<typeof progressSchema>;

/** The fixed deployment origin must send these proof-only routes without a bearer. */
export type LocalRecipePossessionRequest=(accountId:string,path:string,init:RequestInit,beforeSend:()=>void|Promise<void>)=>Promise<Response>;
export type LocalRecipePublicationCheck=()=>void|Promise<void>;
const fail=()=>new Error('本地发布与已确认的快照不一致，请重新核对。');
function stable(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value!==null&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  const json=JSON.stringify(value);if(json===undefined)throw fail();return json;
}
const digest=(value:unknown)=>creatorSha(stable(value));
function entries(content:RecipeRichContent){
  const result:Array<{kind:string;item:{itemId:string;originId:string;text?:RecipeRichText;instruction?:RecipeRichText}}>=Object.values(content.public).map(item=>({kind:'publicText',item}));
  if(content.role)result.push({kind:'role',item:content.role});
  if(content.finalLogo)result.push({kind:'finalLogo',item:content.finalLogo});
  for(const [kind,items] of [['setting',content.settings],['rule',content.rules],['skill',content.skills],['file',content.files],['task',content.tasks],['memory',content.memories],['setup',content.setup]] as const)
    for(const item of items)result.push({kind,item});
  for(const setting of content.settings)if(setting.field==='presentation.cardDisplay'&&setting.value)
    for(const item of setting.value.blocks)result.push({kind:'cardBlock',item});
  return result;
}
function checked(row:CreatorCommandRecord,raw:LocalRecipeDraftRecord){
  const record=localRecipeDraftRecordSchema.parse(raw),r=row.request,c=row.command,draft=record.draft;
  if(r.type!=='publishDraft'||c.kind!=='publish'||r.requestId!==row.id||r.accountId!==row.association.accountId||
    record.association.accountId!==r.accountId||!sameCreatorSource(record.association,row.association)||
    r.draftId!==draft.draftId||r.revision!==draft.revision||c.snapshotDigest!==creatorSnapshotDigest(c.snapshot)||
    !isDeepStrictEqual(c.snapshot.work,record.work)||!isDeepStrictEqual(c.snapshot.public,draft.public)||
    !isDeepStrictEqual(c.snapshot.parent,record.parent??null)||c.snapshot.recipeId!==draft.recipeId||c.snapshot.revision!==draft.revision||
    c.snapshot.format!==(draft.format??'role-v1'))throw fail();
  if(draft.format!=='rich-v2'){
    if(c.snapshot.contentSha256!==creatorSha(stable(draft.config))||c.snapshot.parts.length||record.members.length)throw fail();
    return {record,parts:[]};
  }
  const bytes=Buffer.from(draft.rich.canonical,'base64url'),doc=decodeRichRecipeContent(bytes);
  if(bytes.toString('base64url')!==draft.rich.canonical||r.format!=='rich-v2'||r.canonical!==draft.rich.canonical||
    creatorSha(bytes)!==c.snapshot.contentSha256||!isDeepStrictEqual(doc.content,draft.rich.content)||
    !isDeepStrictEqual(c.snapshot.parts,doc.content.parts))throw fail();
  validateWritableRichRecipeContent(doc.content);
  for(const field of ['name','summary','overview','version'] as const)if(doc.content.public[field].value!==draft.public[field])throw fail();
  const ids=entries(doc.content),origins=record.origins;
  if(!origins||origins.length!==ids.length||new Set(origins.map(o=>o.itemId)).size!==ids.length||
    ids.some(({item})=>!origins.some(o=>o.itemId===item.itemId)))throw fail();
  const parts=doc.content.parts.map(descriptor=>{
    const matches=record.members.filter(member=>member.descriptor.objectId===descriptor.objectId),member=matches[0];
    if(matches.length!==1||!member||!isDeepStrictEqual(descriptor,member.descriptor))throw fail();
    const bytes=Buffer.from(member.base64,'base64');
    if(bytes.toString('base64')!==member.base64||bytes.length!==descriptor.bytes||creatorSha(bytes)!==descriptor.sha256)throw fail();
    if(descriptor.kind==='text'){
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if(draft.rich.texts[descriptor.objectId]!==text)throw fail();
    }
    return {descriptor,bytes};
  });
  if(parts.filter(p=>p.descriptor.kind==='text').length>64||parts.filter(p=>p.descriptor.kind==='finalLogo').length>1)throw fail();
  return {record,parts};
}
function registration(progress:Progress){
  return authoringOperationSchema.parse({operationId:progress.cloudOperationId,format:'rich-v2',purpose:'prepareDraft',
    targetPublicKey:progress.key.targetPublicKey,nonceCommitment:progress.key.nonceCommitment,state:'pendingMain',deliveryUnknown:false,createdAt:progress.createdAt});
}
function remoteRow(row:CreatorCommandRecord,progress:Progress):CreatorCommandRecord {
  if(row.command.kind!=='publish'||row.request.type!=='publishDraft'||!progress.remoteDraftId)throw fail();
  const snapshot={...row.command.snapshot,...(row.destination!==undefined&&{recipeId:row.destination?.recipeId??progress.remoteDraftId}),work:{...row.command.snapshot.work,draftId:progress.remoteDraftId},revision:1,
    ...(progress.frozen&&{contentSha256:progress.frozen.contentSha256})};
  return {...row,command:{...row.command,snapshot},request:{...row.request,draftId:progress.remoteDraftId,revision:1,
    ...(progress.frozen&&{format:'rich-v2',canonical:progress.frozen.canonical})}};
}
function localAnswer(row:CreatorCommandRecord,answer:CreatorAnswer):CreatorAnswer {
  if(answer.kind!=='published'||row.request.type!=='publishDraft')throw fail();
  return {...answer,draftId:row.request.draftId,draftRevision:row.request.revision};
}

export class LocalRecipePublisher {
  private connection?:DatabaseSync;
  private running=new Map<string,Promise<CreatorAnswer|undefined>>();
  constructor(private readonly dir?:string,private readonly possessionRequest?:LocalRecipePossessionRequest){}
  close(){this.connection?.close();this.connection=undefined;}
  private db(){
    if(this.connection)return this.connection;
    const path=this.dir&&join(this.dir,'publications.sqlite');
    if(this.dir){mkdirSync(this.dir,{recursive:true,mode:0o700});chmodSync(this.dir,0o700);closeSync(openSync(path!,'a',0o600));chmodSync(path!,0o600);}
    const db=new DatabaseSync(path??':memory:');
    db.exec('pragma busy_timeout=5000; pragma journal_mode=DELETE; pragma synchronous=EXTRA; pragma fullfsync=ON;');
    db.exec('create table if not exists publications (account_id text not null,request_id text not null,generation integer not null,body text not null,sha256 text not null,primary key(account_id,request_id)) without rowid;');
    this.connection=db;return db;
  }
  private read(accountId:string,requestId:string){
    uuid.parse(accountId);uuid.parse(requestId);
    const path=this.dir&&join(this.dir,'publications.sqlite');
    const db=this.connection??(path&&existsSync(path)?new DatabaseSync(path,{readOnly:true}):undefined);
    if(!db)return;
    try{
      if(!db.prepare("select 1 from sqlite_master where type='table' and name='publications'").get())return;
      const raw=db.prepare('select body,sha256 from publications where account_id=? and request_id=?').get(accountId,requestId);
      if(!raw)return;
      const envelope=z.object({body:z.string().max(5000000),sha256:sha}).parse(raw);
      if(creatorSha(envelope.body)!==envelope.sha256)throw fail();
      const state=progressSchema.parse(JSON.parse(envelope.body));
      if(state.accountId!==accountId||state.requestId!==requestId)throw fail();
      return state;
    }finally{if(db!==this.connection)db.close();}
  }
  private save(state:Progress,initial=false){
    const body=JSON.stringify(progressSchema.parse(state)),db=this.db();
    if(initial){
      db.prepare('insert or ignore into publications values (?,?,?,?,?)').run(state.accountId,state.requestId,state.generation,body,creatorSha(body));
      return this.read(state.accountId,state.requestId)!;
    }
    const result=db.prepare('update publications set generation=?,body=?,sha256=? where account_id=? and request_id=? and generation=?')
      .run(state.generation,body,creatorSha(body),state.accountId,state.requestId,state.generation-1);
    if(result.changes!==1)throw fail();
    return state;
  }
  private advance(state:Progress,change:Partial<Progress>){return this.save({...state,...change,generation:state.generation+1});}
  has(accountId:string,requestId:string){return this.read(accountId,requestId)!==undefined;}
  private binding(row:CreatorCommandRecord){return digest({association:row.association,id:row.id,command:row.command,request:row.request,destination:row.destination});}
  private guard(account:NativeAccount,row:CreatorCommandRecord,check:LocalRecipePublicationCheck,writing:boolean){
    const accountId=row.association.accountId,lease=account.lease?.(accountId);
    const quick=()=>{
      lease?.throwIfAborted();const status=account.status();
      if(!lease||account.lease?.(accountId)!==lease||status.kind!=='signedIn'||status.accountId!==accountId)throw fail();
      if(writing&&(!row.grant.confirmation||row.grant.expiresAt<=Date.now()))throw fail();
    };
    return {quick,check:async()=>{await check();quick();}};
  }
  private transport(account:NativeAccount,row:CreatorCommandRecord,guard:()=>Promise<void>,readonly=false):NativeAccount {
    return {...account,request:async(id,path,init={},beforeSend)=>{
      await guard();if(id!==row.association.accountId||readonly&&(init.method??'GET')!=='GET')throw fail();
      return account.request(id,path,init,async()=>{await beforeSend?.();await guard();});
    }};
  }
  async receipt(account:NativeAccount,row:CreatorCommandRecord,check:LocalRecipePublicationCheck):Promise<CreatorAnswer|undefined>{
    const state=this.read(row.association.accountId,row.id);if(!state)return;
    if(state.binding!==this.binding(row))throw fail();
    const guard=this.guard(account,row,check,false).check;await guard();
    if(state.result)return creatorAnswerSchema.parse(state.result);
    if(!state.remoteDraftId||state.format==='rich-v2'&&!state.frozen)return;
    const answer=await publicationReceipt(this.transport(account,row,guard,true),remoteRow(row,state));await guard();
    return answer&&localAnswer(row,answer);
  }
  async publish(account:NativeAccount,row:CreatorCommandRecord,raw:LocalRecipeDraftRecord,check:LocalRecipePublicationCheck):Promise<CreatorAnswer|undefined>{
    const guards=this.guard(account,row,check,true),guard=guards.check;await guard();
    const input=checked(row,raw),binding=this.binding(row),recordDigest=digest(input.record);
    let state=this.read(row.association.accountId,row.id);
    if(state&&(state.binding!==binding||state.recordDigest!==recordDigest))throw fail();
    if(input.record.draft.format==='rich-v2'&&!this.possessionRequest)throw new Error('未配置发布证明通道。');
    if(!state){
      const pair=generateKeyPairSync('x25519'),key=pair.privateKey.export({format:'jwk'}),nonce=randomBytes(32),cloudOperationId=newRichMetadataRequestId();
      state=this.save({accountId:row.association.accountId,requestId:row.id,binding,recordDigest,cloudOperationId,createdAt:Date.now(),generation:0,
        key:{targetPublicKey:binary.parse(key.x),secret:binary.parse(key.d),nonce:nonce.toString('base64url'),nonceCommitment:createHash('sha256').update(nonce).digest('base64url')},
        format:input.record.draft.format??'role-v1',...(input.record.draft.format!=='rich-v2'&&{remoteDraftId:cloudOperationId}),
        ...(input.record.draft.format==='rich-v2'&&row.destination&&isDeepStrictEqual(row.destination,input.record.parent)&&{preserveSelectedParent:true}),
        dispatched:false,descriptors:[],accepted:false},true);
      if(state.binding!==binding||state.recordDigest!==recordDigest)throw fail();
    }
    const runningKey=state.accountId+':'+row.id,active=this.running.get(runningKey);if(active){const result=await active;await guard();return result;}
    const run=this.execute(account,row,input,state,guard,guards.quick);this.running.set(runningKey,run);
    try{return await run;}finally{if(this.running.get(runningKey)===run)this.running.delete(runningKey);}
  }
  private async json(account:NativeAccount,id:string,path:string,init:RequestInit,guard:()=>Promise<void>,quick:()=>void){
    await guard();const response=await account.request(id,path,init,guard),value=await boundedJson(response,3000000,quick);
    if(!response.ok){const failure=z.object({error:z.object({code:z.string()})}).safeParse(value);
      if(response.status>=400&&response.status<500&&response.status!==408&&response.status!==429&&failure.success)throw new CreatorCloudRejected(failure.data.error.code);
      throw new Error('配方发布结果尚未确认，请核对原请求回执。');}
    await guard();return value;
  }
  private async execute(account:NativeAccount,row:CreatorCommandRecord,input:ReturnType<typeof checked>,initial:Progress,guard:()=>Promise<void>,quick:()=>void){
    let state=initial;
    if(state.result){await guard();return state.result;}
    const prior=await this.receipt(account,row,guard);if(prior){if(prior.kind!=='published')throw fail();await guard();this.advance(state,{result:prior});return prior;}
    const transport=this.transport(account,row,guard),id=state.accountId;
    if(state.format==='role-v1'){
      const draft=input.record.draft;if(draft.format==='rich-v2')throw fail();
      if(!state.accepted){
        const parent=row.destination===undefined?input.record.parent:null;
        const saved=recipeDraftSchema.parse(await this.json(transport,id,'/v1/drafts',{method:'POST',headers:{'content-type':'application/json','idempotency-key':state.cloudOperationId},
          body:JSON.stringify({public:draft.public,config:draft.config,...(parent&&{recipeId:parent.recipeId,sourceVersionId:parent.versionId})})},guard,quick));
        if(saved.draftId!==state.remoteDraftId||saved.revision!==1||!isDeepStrictEqual(saved.public,draft.public)||!('config'in saved)||!isDeepStrictEqual(saved.config,draft.config))throw fail();
        state=this.advance(state,{accepted:true});
      }
    }else state=await this.stageRich(transport,row,input,state,guard,quick);
    const r=remoteRow(row,state).request;if(r.type!=='publishDraft'||!state.remoteDraftId)throw fail();
    await this.json(transport,id,`/${state.format==='rich-v2'?'v2':'v1'}/drafts/${state.remoteDraftId}/publish`,{
      method:'POST',headers:{'content-type':'application/json','idempotency-key':row.id,'if-match':'"1"'},
      body:JSON.stringify({...(state.format==='rich-v2'&&{canonical:state.frozen?.canonical}),...(row.destination!==undefined&&{destination:row.destination})})},guard,quick);
    const answer=await this.receipt(account,row,guard);if(!answer)return;
    if(answer.kind!=='published')throw fail();
    await guard();this.advance(state,{result:answer});return answer;
  }
  private async stageRich(account:NativeAccount,row:CreatorCommandRecord,input:ReturnType<typeof checked>,initial:Progress,guard:()=>Promise<void>,quick:()=>void){
    let state=initial;const draft=input.record.draft;if(draft.format!=='rich-v2')throw fail();
    const signal=account.lease!(state.accountId)!;
    const cloud=richAuthoringCloud(account,state.accountId,signal,quick);
    const recovered=await cloud.recover(state.cloudOperationId);
    const terminal=z.object({operationId:z.literal(state.cloudOperationId),status:z.enum(['cancelled','expired'])}).safeParse(recovered);
    if(terminal.success)throw new Error('这次发布许可已经关闭，只能查询原回执。');
    const accepted=z.object({operationId:z.literal(state.cloudOperationId),status:z.literal('accepted'),draftId:uuid,revision:z.literal(1),manifestId:uuid,packageId:uuid}).safeParse(recovered);
    if(accepted.success){
      if(!state.frozen||!state.manifestId||accepted.data.draftId!==state.remoteDraftId||accepted.data.manifestId!==state.manifestId||accepted.data.packageId!==state.cloudOperationId)throw fail();
      return state.accepted?state:this.advance(state,{accepted:true});
    }
    if(state.accepted)throw fail();
    if(!state.remoteDraftId)state=this.advance(state,{remoteDraftId:await cloud.register(registration(state))});
    if(!state.dispatched){
      const dispatched=z.object({operationId:z.literal(state.cloudOperationId),accountId:z.literal(state.accountId),status:z.literal('dispatched')}).safeParse(recovered);
      if(!dispatched.success){
        const binding=await cloud.authorize(state.cloudOperationId,'dispatch',dispatchDigest);
        await this.possess(state,binding,undefined,guard,quick,signal);
      }
      state=this.advance(state,{dispatched:true});
    }
    // Persist the choice before the first freeze so older in-flight operations replay their original request.
    const parent=row.destination===undefined||state.preserveSelectedParent?input.record.parent:null;
    if(!state.frozen){
      const byItem=new Map(entries(draft.rich.content).map(entry=>[entry.item.itemId,entry.kind]));
      const attestations=new Map<string,Awaited<ReturnType<typeof cloud.sourceItems>>>();
      for(const origin of input.record.origins??[]){
        const parents=origin.source.kind==='accountClaim'?[]:origin.source.kind==='releaseItem'?[origin.source]:origin.source.parents;
        for(const parent of parents){
          let attestation=attestations.get(parent.versionId);
          if(!attestation){attestation=await cloud.sourceItems(parent.versionId);attestations.set(parent.versionId,attestation);}
          const source=attestation.items.find(item=>item.itemId===parent.itemId),kind=byItem.get(origin.itemId);
          if(!source||source.baselineSha256!==parent.baselineSha256||source.kind!==kind&&kind!=='setup'||
            attestation.authorId!==state.accountId&&(attestation.access==='coded'||kind==='finalLogo'||source.kind==='finalLogo'))throw fail();
        }
      }
      if(!state.remoteDraftId)throw fail();
      const cap=Math.max(1,2*(Buffer.from(draft.rich.canonical,'base64url').length+input.parts.reduce((sum,p)=>sum+p.bytes.length,0))+262144);
      await cloud.reserve(state.cloudOperationId,state.remoteDraftId,cap);
      let ordinal=0;
      for(let index=state.descriptors.length;index<input.parts.length;index++){
        ordinal=input.parts.slice(0,index).filter(p=>p.descriptor.kind==='text').length;
        const part=input.parts[index]!;
        const descriptor=recipeRichPartDescriptorSchema.parse(await cloud.upload(state.cloudOperationId,part.descriptor.kind==='finalLogo'?64:ordinal,part.descriptor.kind,part.bytes));
        if(descriptor.kind!==part.descriptor.kind||descriptor.kind==='text'&&(descriptor.sha256!==part.descriptor.sha256||descriptor.bytes!==part.descriptor.bytes))throw fail();
        state=this.advance(state,{descriptors:[...state.descriptors,descriptor]});
      }
      const request=this.rebind(input.record,state,parent);
      const frozen=await cloud.freeze(state.cloudOperationId,request);
      if(!state.remoteDraftId)throw fail();
      verifyFrozenRich(state.cloudOperationId,state.remoteDraftId,request,frozen);
      state=this.advance(state,{frozen});
    }
    if(!state.frozen||!state.remoteDraftId)throw fail();
    const request=this.rebind(input.record,state,parent);
    verifyFrozenRich(state.cloudOperationId,state.remoteDraftId,request,state.frozen);
    if(!state.manifestId){
      const descriptor=await cloud.upload(state.cloudOperationId,65,'manifest',Buffer.from(state.frozen.canonical,'base64url'));
      if(descriptor.kind!=='manifest')throw fail();state=this.advance(state,{manifestId:descriptor.objectId});
    }
    if(!state.frozen)throw fail();
    const binding=await cloud.authorize(state.cloudOperationId,'accept',state.frozen.payloadDigest);
    const result=z.object({format:z.literal('rich-v2'),operationId:z.literal(state.cloudOperationId),status:z.literal('accepted'),draftId:z.literal(state.remoteDraftId),
      revision:z.literal(1),manifestId:z.literal(state.manifestId!),packageId:z.literal(state.cloudOperationId)}).parse(await this.possess(state,binding,request,guard,quick,signal));
    if(result.draftId!==state.remoteDraftId)throw fail();return this.advance(state,{accepted:true});
  }
  private rebind(record:LocalRecipeDraftRecord,state:Progress,parent:LocalRecipeDraftRecord['parent']):RichFreezeInput {
    const draft=record.draft;if(draft.format!=='rich-v2'||state.descriptors.length!==draft.rich.content.parts.length)throw fail();
    const content=structuredClone(draft.rich.content),aliases=new Map<string,string>();
    content.parts=content.parts.map((local,index)=>{
      const remote=state.descriptors[index]!;
      if(remote.kind!==local.kind||remote.kind==='text'&&(remote.sha256!==local.sha256||remote.bytes!==local.bytes))throw fail();
      aliases.set(local.objectId,remote.objectId);return remote;
    });
    for(const {item} of entries(content))for(const key of ['text','instruction'] as const)if(key in item){
      const reference=item[key];if(reference&&reference.kind==='part'){
        const target=aliases.get(reference.objectId);if(!target)throw fail();reference.objectId=target;
      }
    }
    if(content.finalLogo){const target=aliases.get(content.finalLogo.objectId);if(!target)throw fail();content.finalLogo.objectId=target;}
    const logo=draft.rich.content.finalLogo&&draft.rich.content.parts.find(p=>p.objectId===draft.rich.content.finalLogo!.objectId);
    return richFreezeInputSchema.parse({format:'rich-v2',content,access:draft.public.access,origins:record.origins,
      ...(parent&&{sourceVersionId:parent.versionId}),...(logo&&{logoUpload:{packageId:state.cloudOperationId,inputSha256:logo.sha256}})});
  }
  private async possess(state:Progress,binding:Parameters<typeof richPossessionProof>[1],request:RichFreezeInput|undefined,guard:()=>Promise<void>,quick:()=>void,signal:AbortSignal){
    if(!this.possessionRequest||binding.accountId!==state.accountId||binding.operationId!==state.cloudOperationId||
      binding.purpose!=='prepareDraft'||binding.targetPublicKey!==state.key.targetPublicKey||binding.nonceCommitment!==state.key.nonceCommitment||
      binding.draftId!==undefined||binding.baseRevision!==undefined||binding.deadline<=Date.now()||binding.deadline>Date.now()+305000||binding.deadline>binding.operationDeadline||binding.stateRevision!==(binding.stage==='dispatch'?1:2)||binding.status!==(binding.stage==='dispatch'?'registered':'dispatched'))throw fail();
    const proof=richPossessionProof(state.key.secret,binding,request&&state.frozen&&state.remoteDraftId?{request,frozen:state.frozen,destinationDraftId:state.remoteDraftId}:undefined);
    await guard();signal.throwIfAborted();
    const response=await this.possessionRequest(state.accountId,`/v2/authoring/${state.cloudOperationId}/${binding.stage}`,{
      method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal,headers:{'content-type':'application/json'},
      body:JSON.stringify({ticket:binding.ticket,nonce:state.key.nonce,proof,...(binding.stage==='accept'&&state.frozen&&{
        canonical:state.frozen.canonical,payload:state.frozen.payload,manifestId:state.manifestId,packageId:state.cloudOperationId})}),
    },guard);
    const result=await boundedJson(response,8192,quick);await guard();
    if(!response.ok)throw new Error('发布证明结果尚未确认，请核对原请求回执。');
    if(binding.stage==='dispatch')z.object({format:z.literal('rich-v2'),operationId:z.literal(state.cloudOperationId),status:z.literal('dispatched'),stateRevision:z.literal(2)}).parse(result);
    return result;
  }
}
