import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {applyRichMetadata,communityResponseSchemas,RecipeRichValidationError,richMetadataLogoDescriptorSchema,
  richMetadataReceiptSchema,type CommunityResponses,type RecipeRichDraft,type RichMetadataInput,type RichMetadataRequest} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import {MetadataJournal,type MetadataEntry} from './community-metadata-journal.js';
import {MissingRichRecipe,richCommunity} from './community-rich.js';
import {boundedJson} from './community-response.js';
import {richAuthoringCloud} from './recipe-authoring-rich-cloud.js';

type Outcome=CommunityResponses['saveRichDraftMetadata'];
type Rejection=Extract<Outcome,{status:'rejected'}>;
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const reply=z.discriminatedUnion('status',[
  z.object({status:z.literal('committed'),receipt:richMetadataReceiptSchema}).strict(),
  z.object({status:z.enum(['open','closed','pending'])}).strict(),
]);
class Rejected extends Error {
  constructor(readonly code:Rejection['code']){super(code);}
}
async function httpError(response:Response):Promise<never>{
  const value=await boundedJson(response,4096);
  const parsed=z.object({error:z.object({code:z.string()})}).safeParse(value);
  if(parsed.success && response.status>=400 && response.status<500){
    const result=communityResponseSchemas.saveRichDraftMetadata.safeParse({status:'rejected',code:parsed.data.error.code});
    if(result.success && result.data.status==='rejected')throw new Rejected(result.data.code);
  }
  throw new Error('保存结果未知');
}

function confirmedRejection(error:unknown):Rejection['code']|undefined {
  if(error instanceof Rejected)return error.code;
  if(error instanceof MissingRichRecipe)return 'not_found';
  if(error instanceof RecipeRichValidationError)return 'invalid_input';
}

function semanticInput(request:RichMetadataRequest){
  let bytes:Buffer|undefined;
  if(request.logo.kind==='replace'){
    bytes=Buffer.from(request.logo.base64,'base64');
    if(bytes.length>2097152 || bytes.toString('base64')!==request.logo.base64)throw new Rejected('invalid_input');
  }
  const input:RichMetadataInput={transformVersion:1,baseManifestSha256:request.baseManifestSha256,public:request.public,
    logo:bytes?{kind:'replace',inputSha256:sha(bytes)}:request.logo.kind==='keep'?{kind:'keep'}:{kind:'remove'}};
  return {input,bytes};
}

export async function saveRichMetadata(account:NativeAccount,request:RichMetadataRequest,journal:MetadataJournal):Promise<Outcome>{
  const key=journal.key(request.accountId,request.draftId);
  const controller=new AbortController();
  const check=()=>{
    const state=account.status();
    if(controller.signal.aborted || state.kind!=='signedIn' || state.accountId!==request.accountId)throw new Rejected('session_changed');
  };
  const unsubscribe=account.onStatus(next=>{
    if(next.kind!=='signedIn'||next.accountId!==request.accountId)controller.abort();
  });
  const rich=richCommunity(account,request.accountId,check);
  const cloud=richAuthoringCloud(account,request.accountId,controller.signal,check,httpError);

  async function perform(row:MetadataEntry,recovering:boolean):Promise<Outcome>{
    const r=row.request, {input,bytes}=semanticInput(r);
    const headers={'content-type':'application/json','if-match':'"'+r.revision+'"','idempotency-key':r.requestId};
    async function send(path:string,body:unknown,method='PATCH'){
      check();
      const response=await account.request(r.accountId,path,{method,body:JSON.stringify(body),headers,signal:controller.signal},check);
      if(!response.ok)await httpError(response);
      return boundedJson(response,4096);
    }
    const patch=async(body:unknown)=>reply.parse(await send('/v2/drafts/'+r.draftId+'/metadata',body));
    async function committed(receipt:z.infer<typeof richMetadataReceiptSchema>):Promise<Outcome>{
      if(receipt.requestId!==r.requestId||receipt.draftId!==r.draftId||receipt.revision!==r.revision+1)throw new Error('保存回执不匹配');
      let draft:RecipeRichDraft|undefined;
      try{
        const current=await rich.draft(r.draftId);
        if(current.format==='rich-v2' && current.revision===receipt.revision &&
          sha(Buffer.from(current.rich.canonical,'base64url'))===receipt.manifestSha256)draft=current;
      }catch{/* A verified receipt is sufficient when the separate read is unavailable. */}
      try{journal.clear(key);}catch{/* The next invocation can replay the same receipt. */}
      return {status:'committed',receipt,...(draft?{draft}:{})};
    }
    let held=recovering;
    let probing=!row.commit;
    try {
      if(row.commit){
        const replay=await patch(row.commit);
        return replay.status==='committed'?committed(replay.receipt):{status:'uncertain'};
      }
      const probe=await patch({input});
      if(probe.status==='committed')return committed(probe.receipt);
      held=probe.status==='open';
      probing=false;
      const base=await rich.draft(r.draftId);
      if(base.format!=='rich-v2'||base.revision!==r.revision||sha(Buffer.from(base.rich.canonical,'base64url'))!==r.baseManifestSha256)
        throw new Rejected('conflict');
      const estimate=bytes?{objectId:r.requestId,kind:'finalLogo' as const,sha256:'0'.repeat(64),bytes:1,mediaType:'image/webp' as const}:undefined;
      const provisional=await applyRichMetadata(base.rich.content,r.accountId,r.requestId,input,estimate);
      const logoSizeDigits=String(131072).length-1;
      const manifestCap=2*(provisional.canonicalUTF8.length+(bytes?logoSizeDigits:0));
      const cap=bytes?Math.max(bytes.length+131072,131072+manifestCap):manifestCap;
      await send('/v2/objects/'+r.requestId+'/reserve',{draftId:r.draftId,cap,revision:r.revision,metadata:input},'POST');
      held=true;
      const logoDescriptor=bytes?richMetadataLogoDescriptorSchema.parse(await cloud.upload(r.requestId,64,'finalLogo',bytes)):undefined;
      const assembled=logoDescriptor?await applyRichMetadata(base.rich.content,r.accountId,r.requestId,input,logoDescriptor):provisional;
      const manifest=await cloud.upload(r.requestId,65,'manifest',assembled.canonicalUTF8);
      const commit={input,baseCanonical:base.rich.canonical,manifestId:manifest.objectId,...(logoDescriptor?{logoDescriptor}:{})};
      journal.write(key,{request:r,commit});
      const result=await patch(commit);
      return result.status==='committed'?committed(result.receipt):{status:'uncertain'};
    }catch(error){
      const code=confirmedRejection(error);
      if(!code || code==='session_changed')return {status:'uncertain'};
      if(code==='auth_required'||code==='account_disabled'){
        if(held)return {status:'uncertain'};
        journal.clear(key);
        return {status:'rejected',code};
      }
      if((held || probing && code==='conflict') && code!=='operation_expired'){
        let closed:z.infer<typeof reply>;
        try{closed=await patch({input,close:true});}
        catch(closeError){
          if(!(closeError instanceof Rejected) || !['conflict','not_found','operation_expired'].includes(closeError.code))throw closeError;
          // A different immutable binding, owner or expired ID cannot commit this command.
          closed={status:'closed'};
        }
        if(closed.status==='committed')return committed(closed.receipt);
        if(closed.status!=='closed')return {status:'uncertain'};
      }
      journal.clear(key);
      return {status:'rejected',code};
    }
  }

  try{
    return await journal.exclusive(key,async()=>{
      check();
      const previous=journal.read(key);
      if(previous){
        if(previous.request.requestId===request.requestId && !isDeepStrictEqual(previous.request,request))
          return {status:'rejected',code:'conflict'};
        const recovered=await perform(previous,true);
        if(previous.request.requestId===request.requestId || recovered.status==='uncertain')return recovered;
        if(recovered.status==='committed')return {status:'rejected',code:'conflict'};
      }
      semanticInput(request);
      journal.write(key,{request});
      return perform({request},false);
    });
  }catch(error){
    if(error instanceof Rejected){
      try{if(!journal.read(key))return {status:'rejected',code:error.code};}catch{}
    }
    return {status:'uncertain'};
  }finally{unsubscribe();}
}
