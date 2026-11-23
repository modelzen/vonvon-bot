import {createHash} from 'node:crypto';
import {z} from 'zod';
import {authoringReceiptSchema,decodeRichRecipeContent,recipeRichManifestObjectSchema,recipeRichPartDescriptorSchema,richAuthoringAuthorizationSchema,richFrozenResponseSchema,
  richSourceAttestationSchema,richFreezeInputSchema,type RichFreezeInput,type AuthoringOperation} from '@vonvon/protocol';
interface AccountTransport {request(accountId:string,path:string,init:RequestInit,beforeSend:()=>void):Promise<Response>}

const uuid=z.string().uuid();
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
class MissingRichOperation extends Error {}
class ForbiddenRichResource extends Error {}
export class UnavailableSourceItems extends Error {}
export function richTerminal(raw:unknown){
  const v=z.object({format:z.literal('rich-v2'),operationId:uuid,status:z.enum(['accepted','expired','cancelled']),stateRevision:z.number().int().positive().optional(),
    draftId:uuid.optional(),revision:z.number().int().positive().optional(),outcome:z.literal('unknown').optional()}).safeParse(raw);
  if(!v.success)return;
  const {format:_format,...data}=v.data;
  return authoringReceiptSchema.parse(data);
}
const fail=()=>new Error('云端配方资料与本次请求不一致。');
export function richAuthoringCloud(account:AccountTransport,accountId:string,signal:AbortSignal,check:()=>void){
  async function bounded(path:string,init:RequestInit,cap:number){
    const active=init.signal?AbortSignal.any([signal,init.signal]):signal;
    check();signal.throwIfAborted();
    const response=await account.request(accountId,path,{...init,signal:active},check);
    if(!response.ok||!response.body){await response.body?.cancel();if(response.status===404)throw new MissingRichOperation();if(response.status===403)throw new ForbiddenRichResource();throw fail();}
    const reader=response.body.getReader(), chunks:Uint8Array[]=[];
    let bytes=0;
    try {for(;;){
      const {done,value}=await reader.read();
      check();signal.throwIfAborted();
      if(done)break;
      if((bytes+=value.byteLength)>cap)throw fail();
      chunks.push(value);
    }}finally{await reader.cancel().catch(()=>{});}
    return Buffer.concat(chunks);
  }
  async function json(path:string,body?:object,cap=262144){
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bounded(path,body===undefined?{}:{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    },cap))) as unknown;
  }
  const route=(operation:string)=>'/v2/authoring/'+uuid.parse(operation);
  const pkg=(packageId:string)=>'/v2/objects/'+uuid.parse(packageId);
  return {
    async register(op:AuthoringOperation){
      const r=z.object({format:z.literal('rich-v2'),destinationDraftId:uuid,operationId:uuid,accountId:uuid,
        purpose:z.enum(['prepareDraft','editDraft']),targetPublicKey:z.string(),nonceCommitment:z.string()}).parse(await json(route(op.operationId)+'/register',
        {format:'rich-v2',purpose:op.purpose,targetPublicKey:op.targetPublicKey,nonceCommitment:op.nonceCommitment,
          ...(op.purpose==='editDraft'&&{draftId:op.draftId,baseRevision:op.baseRevision})}));
      if(r.operationId!==op.operationId||r.accountId!==accountId||r.purpose!==op.purpose||r.targetPublicKey!==op.targetPublicKey||
          r.nonceCommitment!==op.nonceCommitment||op.purpose==='editDraft'&&op.draftId!==r.destinationDraftId)throw fail();
      return r.destinationDraftId;
    },
    async draftMetadata(draftId:string,revision:number){
      const meta=z.object({format:z.literal('rich-v2'),draftId:uuid,revision:z.number().int(),sourceIntentId:uuid,manifest:recipeRichManifestObjectSchema,
        sourceManifest:recipeRichManifestObjectSchema}).parse(await json('/v2/drafts/'+uuid.parse(draftId)));
      if(meta.draftId!==draftId||meta.revision!==revision)throw fail();
      return meta;
    },
    async draft(draftId:string,revision:number){
      const meta=await this.draftMetadata(draftId,revision);
      const bytes=await this.readMember(draftId,meta.manifest);
      decodeRichRecipeContent(bytes);
      return {canonical:bytes.toString('base64url'),meta};
    },
    async sourceItems(versionId:string){
      try {
        const attested=richSourceAttestationSchema.parse(await json('/v2/versions/'+uuid.parse(versionId)+'/source-items'));
        if(attested.versionId!==versionId)throw fail();
        return attested;
      } catch(error) {
        if(error instanceof MissingRichOperation||error instanceof ForbiddenRichResource)
          throw new UnavailableSourceItems('所选版本已不可用或无法读取。');
        throw error;
      }
    },
    async authorize(op:string,stage:'dispatch'|'accept',payloadDigest:string){
      const binding=richAuthoringAuthorizationSchema.parse(await json(route(op)+'/authorize',{stage,stateRevision:stage==='dispatch'?1:2,payloadDigest}));
      if(binding.operationId!==op||binding.accountId!==accountId||binding.stage!==stage||binding.payloadDigest!==payloadDigest)throw fail();
      return binding;
    },
    async reserve(packageId:string,draftId:string,cap:number){
      if(!Number.isSafeInteger(cap)||cap<1||cap>4194304)throw fail();
      await json(pkg(packageId)+'/reserve',{draftId:uuid.parse(draftId),cap});
    },
    async upload(packageId:string,ordinal:number,kind:'text'|'manifest'|'finalLogo',bytes:Uint8Array,transferSignal?:AbortSignal){
      if(!Number.isInteger(ordinal)||ordinal<0||ordinal>65||bytes.length>(kind==='manifest'?1048576:kind==='finalLogo'?2097152:131072))throw fail();
      const digest=sha(bytes);
      const data=await bounded(pkg(packageId)+'/members/'+ordinal,{method:'PUT',signal:transferSignal,headers:{'content-type':'application/octet-stream',
        'content-length':String(bytes.length),'x-recipe-kind':kind,'x-recipe-sha256':digest},body:new Uint8Array(bytes)},2048);
      const descriptor=(kind==='manifest'?recipeRichManifestObjectSchema:recipeRichPartDescriptorSchema).parse(JSON.parse(data.toString('utf8')));
      if(descriptor.kind!==kind || kind!=='finalLogo'&&(descriptor.sha256!==digest||descriptor.bytes!==bytes.length))throw fail();
      return descriptor;
    },
    async freeze(op:string,request:RichFreezeInput){
      return richFrozenResponseSchema.parse(await json(route(op)+'/freeze',richFreezeInputSchema.parse(request),3000000));
    },
    async readMember(draftId:string,descriptor:{objectId:string;sha256:string;bytes:number}){
      if(!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<0||descriptor.bytes>1048576)throw fail();
      const bytes=await bounded('/v2/drafts/'+uuid.parse(draftId)+'/objects/'+uuid.parse(descriptor.objectId),{},descriptor.bytes);
      if(bytes.length!==descriptor.bytes||sha(bytes)!==descriptor.sha256)throw fail();
      return bytes;
    },
    async cancelPackage(packageId:string){await json(pkg(packageId)+'/cancel',{});},
    async cancel(operationId:string){return json(route(operationId)+'/cancel',{});},
    async recover(operationId:string){
      try{
        const result=await json(route(operationId)+'/recovery');
        const expired=z.object({unredeemable:z.literal(true),accountId:uuid,operationId:uuid,format:z.literal('rich-v2')}).safeParse(result);
        if(expired.success){
          if(expired.data.accountId!==accountId||expired.data.operationId!==operationId)throw fail();
          return {format:'rich-v2',operationId,status:'expired',outcome:'unknown'};
        }
        return result;
      }catch(e){if(e instanceof MissingRichOperation)return;throw e;}
    },
  };
}
