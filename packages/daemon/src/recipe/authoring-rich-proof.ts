import {recipeApiOrigin} from './installer';
import {authoringReceiptSchema} from '@vonvon/protocol';
import {createHash,createPrivateKey} from 'node:crypto';
import {richAuthoringAuthorizationSchema,richFrozenResponseSchema,decodeRichRecipeContent,recipeRichAuthoringPayloadSchema,
  type RichFreezeInput,type RecipeRichContent} from '@vonvon/protocol';
import {itemsOf,wireDigest,wireJson} from './authoring-rich-snapshot';
// @ts-expect-error Shared native/service binary proof transcript.
import {richProof} from '../../../../services/recipe-api/src/rich-proof.mjs';
// @ts-expect-error Shared typed command interpreter. The service assigns fresh IDs with its private operation seed.
import {applyChanges} from '../../../../services/recipe-api/src/rich-document.mjs';

export const richAuthorization=richAuthoringAuthorizationSchema;
export type RichAuthorization=ReturnType<typeof richAuthorization.parse>;
export const richFreezeResponse=richFrozenResponseSchema;
export type FrozenRichResponse=ReturnType<typeof richFreezeResponse.parse>;
export type ReviewedRichFreeze=RichFreezeInput;
const mismatch=()=>new Error('云端草稿与本机核对的内容不一致。');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function decode(value:string){
  const bytes=Buffer.from(value,'base64url');
  if(bytes.toString('base64url')!==value)throw mismatch();
  return bytes;
}
function compareRemapped(expected:RecipeRichContent,received:RecipeRichContent,preserved:ReadonlySet<string>) {
  const rebound=structuredClone(received);
  const left=itemsOf(expected),right=itemsOf(rebound);
  if(left.length!==right.length)throw mismatch();
  const aliases=new Map<string,string>(),origins=new Map<string,string>();
  for(const [index,old] of left.entries()) {
    const fresh=right[index]!;
    if(preserved.has(old.itemId)&&(old.itemId!==fresh.itemId||old.originId!==fresh.originId))throw mismatch();
    if(origins.has(fresh.originId)&&origins.get(fresh.originId)!==old.originId)throw mismatch();
    aliases.set(fresh.itemId,old.itemId);origins.set(fresh.originId,old.originId);
    fresh.itemId=old.itemId; fresh.originId=old.originId;
  }
  for(const skill of rebound.skills){
    skill.fileIds=skill.fileIds.map(id=>aliases.get(id)!);
    skill.entryFileId=aliases.get(skill.entryFileId)!;
  }
  // Copied card blocks receive a generated native block id derived from their new itemId.
  for(const setting of rebound.settings)if(setting.field==='presentation.cardDisplay'&&setting.value)
    for(const block of setting.value.blocks) {
      const original=received.settings.find(x=>x.field===setting.field);
      const fresh=original?.value?.blocks.find(b=>aliases.get(b.itemId)===block.itemId);
      if(fresh && !preserved.has(block.itemId) && fresh.id==='b'+fresh.itemId.replaceAll('-',''))block.id='b'+block.itemId.replaceAll('-','');
    }
  if(wireJson(rebound)!==wireJson(expected))throw mismatch();
}
export function verifyFrozenRich(
  operationId:string,destinationDraftId:string,reviewed:ReviewedRichFreeze,response:unknown,
):FrozenRichResponse {
  const frozen=richFreezeResponse.parse(response);
  if(frozen.destinationDraftId!==destinationDraftId||frozen.sourceReviewSha256!==wireDigest(reviewed))throw mismatch();
  const canonical=decode(frozen.canonical),payload=decode(frozen.payload),doc=decodeRichRecipeContent(canonical);
  if(hash(canonical)!==frozen.contentSha256||hash(payload)!==frozen.payloadDigest||doc.logicalBytes!==frozen.logicalBytes)throw mismatch();
  const parsed=recipeRichAuthoringPayloadSchema.parse(JSON.parse(payload.toString('utf8')));
  if(wireJson(parsed)!==payload.toString('utf8'))throw mismatch();
  if('content' in reviewed) {
    if(parsed.purpose!=='prepareDraft'||parsed.sourceIntentId!==operationId||wireJson(parsed.content)!==doc.canonical)throw mismatch();
    compareRemapped(reviewed.content,doc.content,new Set());
  }else{
    if(parsed.purpose!=='editDraft'||parsed.draftId!==destinationDraftId||wireJson(parsed)!==wireJson(reviewed.payload))throw mismatch();
    const base=decodeRichRecipeContent(decode(reviewed.baseCanonical));
    const resolve=(ref:{sourceIntentId:string;candidateId:string})=>{
      const donor=reviewed.candidates?.find(c=>c.sourceIntentId===ref.sourceIntentId);
      return {content:donor?decodeRichRecipeContent(decode(donor.canonical)).content:base.content,itemId:ref.candidateId};
    };
    const expected=applyChanges(base.content,parsed.changes,resolve,Buffer.alloc(32),reviewed.newParts).doc.content as RecipeRichContent;
    compareRemapped(expected,doc.content,new Set(itemsOf(base.content).map(i=>i.itemId)));
  }
  return frozen;
}
export function richPossessionProof(secret:string,binding:RichAuthorization,review?:{
  request:ReviewedRichFreeze;frozen:FrozenRichResponse;destinationDraftId:string;
}) {
  if(binding.stage==='accept'){
    if(!review)throw mismatch();
    const result=verifyFrozenRich(binding.operationId,review.destinationDraftId,review.request,review.frozen);
    if(binding.sourceReviewSha256!==result.sourceReviewSha256||binding.payloadDigest!==result.payloadDigest)throw mismatch();
  }else if(binding.sourceReviewSha256!==undefined||binding.payloadDigest!==hash(Buffer.alloc(0)))throw mismatch();
  const key=createPrivateKey({format:'jwk',key:{kty:'OKP',crv:'X25519',x:binding.targetPublicKey,d:secret}});
  return (richProof(key,binding) as Buffer).toString('base64url');
}

export async function postRichStage(url:string,op:import('./authoring-journal').LocalOperation,
  request:Extract<import('@vonvon/protocol').RecipeAuthoringRequest,{type:'richAdvance'}>,now:number,http=fetch,loopback=false){
  const binding=request.authorization,view=op.view,dispatch=binding.stage==='dispatch';
  if(view.format!=='rich-v2'||!op.rich||!op.secret||!op.nonce||binding.operationId!==view.operationId||binding.accountId!==op.accountId||
    binding.purpose!==view.purpose||binding.targetPublicKey!==view.targetPublicKey||binding.nonceCommitment!==view.nonceCommitment||
    binding.draftId!==view.draftId||binding.baseRevision!==view.baseRevision||binding.stateRevision!==(dispatch?1:2)||binding.status!==(dispatch?'registered':'dispatched')||
    binding.deadline<=now||binding.deadline>now+305000||binding.deadline>binding.operationDeadline||
    request.destinationDraftId!==op.rich.destinationDraftId||dispatch!==!request.accepted||view.state!==(dispatch?'pendingMain':'pendingCloud'))throw mismatch();
  const accepted=request.accepted;
  const review=accepted&&op.rich.request?{request:op.rich.boundRequest??op.rich.request,frozen:accepted.frozen,destinationDraftId:request.destinationDraftId}:undefined;
  const proof=richPossessionProof(op.secret,binding,review);
  const response=await http(recipeApiOrigin(url,loopback)+'/v2/authoring/'+view.operationId+'/'+binding.stage,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
    signal:AbortSignal.timeout(12000),headers:{'content-type':'application/json'},body:JSON.stringify({ticket:binding.ticket,nonce:op.nonce,proof,
      ...(accepted&&{payload:accepted.frozen.payload,canonical:accepted.frozen.canonical,manifestId:accepted.manifestId,packageId:accepted.packageId})})});
  if(!response.ok||!response.body){await response.body?.cancel();throw mismatch();}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];
  let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;if((size+=r.value.length)>4096)throw mismatch();chunks.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
  const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(raw.operationId!==view.operationId)throw mismatch();
  if(dispatch){if(raw.status!=='dispatched'||raw.stateRevision!==2||raw.format!=='rich-v2')throw mismatch();return;}
  const {format,recipeId,manifestId,packageId,...receipt}=raw;
  if(typeof recipeId!=='string'||manifestId!==accepted?.manifestId||packageId!==accepted?.packageId)throw mismatch();
  if(format!==undefined&&format!=='rich-v2')throw mismatch();
  const result=authoringReceiptSchema.options[0].parse(receipt);
  if(result.draftId!==request.destinationDraftId||result.revision!==(view.baseRevision??0)+1)throw mismatch();
  return result;
}
