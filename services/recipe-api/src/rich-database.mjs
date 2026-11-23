import {applyRichMetadata,richMetadataInputDigest} from '../../../packages/protocol/dist/index.js';
import {createHash} from 'node:crypto';
import {credentialField} from './credential-shapes.mjs';
import {ApiError,badInput} from './errors.mjs';
import {objectKeys,uuid} from './input.mjs';
import {richInstallMaterial} from './rich-install-proof.mjs';
import {richMaterial} from './rich-proof.mjs';
import {richWireBytes,applyChanges,document,writableDocument,validateRichWritePayload,freezeSnapshot,inventory,richDigest} from './rich-document.mjs';
import {parseEditFreeze,readDocument} from './rich-http.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const calls={
  richAccountProfileInitialize:'rich_account_profile_initialize($1)',
  richBrowsePreview:'browse_preview($1,$2)',richTaskSummaries:'task_summaries($1,$2)',
  richAuthorRecipes:'reader_author_recipes($1,$2)',
  richUnredeemable:'rich_install_unredeemable($1,$2)',
  richInstallPreview:'rich_install_preview($1)',richInstallRecover:"rich_install_control($1,'recover')",richInstallCancel:"rich_install_control($1,'cancel')",
  richInstallRedeem:'rich_possess_install($1,$2,$3,$4,$5)',richInstallComplete:'rich_possess_install($1,$2,$3,$4,$5)',
  richSourceItems:'rich_source_items($1)',richRegister:'rich_register($1,$2)',richDraft:'rich_draft($1)',richDraftList:'rich_draft_list()',richDelete:'rich_delete($1,$2,$3)',
  richDetail:'rich_detail($1,$2)',richWithdraw:'rich_withdraw($1)',richDeletePublication:'delete_publication($1)',richProfileRead:'rich_profile_read()',richAccountProfileRead:'rich_account_profile_read()',richProfile:'rich_profile($1)',richAccountProfile:'rich_account_profile($1,$2,$3,$4)',richCatalog:'reader_catalog_page($1,$2,$3)',
  richGet:"rich_op_context($1,'get',null)",richRecover:"rich_op_context($1,'recover',null)",richCancel:"rich_op_context($1,'cancel',null)",
  richDispatch:'rich_dispatch($1,$2,$3,$4)',richAccept:'rich_accept($1,$2,$3,$4,$5,$6,$7,$8)',
  richReserve:'reserve_object_package($1,$2,$3)',richCancelPackage:'cancel_object_package($1)',richCapacity:'object_capacity()',
};
async function metadataBinding(revision,input){
  return {revision,baseManifestSha256:input.baseManifestSha256,transformVersion:input.transformVersion,inputSha256:await richMetadataInputDigest(input)};
}
export async function richExecute(client,op,args) {
  const call=async(expr,params)=>(await client.query('select recipe_api.'+expr+' as result',params)).rows[0].result;
  if(Object.hasOwn(calls,op))return call(calls[op],args);
  if(op==='richReserveMetadata'){
    const [requestId,draftId,cap,revision,input]=args;
    if(credentialField({public:input.public}))throw new ApiError(422,'credential_detected');
    return call('reserve_metadata_package($1,$2,$3,$4)',[requestId,draftId,cap,await metadataBinding(revision,input)]);
  }
  if(op==='richMetadata'){
    const [requestId,draftId,revision,body]=args;
    const binding=await metadataBinding(revision,body.input);
    if(body.close){
      const result=await call('rich_close_metadata($1,$2,$3)',[requestId,draftId,binding]);
      return result.receipt?{status:'committed',receipt:result.receipt}:{status:result.closed?'closed':'pending'};
    }
    const wireHash=body.baseCanonical ? richDigest(body) : null;
    const ctx=await call('rich_metadata_context($1,$2,$3,$4)',[requestId,draftId,binding,wireHash]);
    if(ctx.receipt) return {status:'committed',receipt:ctx.receipt};
    if(ctx.pending || !wireHash) return {status:ctx.pending?'pending':'open'};
    const base=readDocument(body.baseCanonical);
    if(sha(base.canonicalUTF8)!==ctx.manifest.sha256)throw new ApiError(409,'conflict');
    let transformed;
    try {transformed=await applyRichMetadata(base.content,ctx.accountId,requestId,body.input,body.logoDescriptor);}
    catch {throw badInput();}
    const doc=writableDocument(transformed.content);
    const evidence=body.logoDescriptor?{packageId:requestId,inputSha256:body.input.logo.inputSha256,descriptor:body.logoDescriptor}:null;
    const receipt=await call('rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',[requestId,draftId,binding,wireHash,
      Buffer.from(doc.canonicalUTF8),body.manifestId,body.input.public.access,JSON.stringify(inventory(doc.content)),evidence]);
    return {status:'committed',receipt};
  }
  if(op==='richInstallAuthorize'){
    const ctx=await call('operation_context()',[]),[id,req]=args;
    const m=richInstallMaterial({...req,...ctx,operationId:id});
    return call('rich_install_authorize($1,$2,$3,$4,$5,$6,$7,$8)',[id,req,m.server,m.ticket,...m.hashes,ctx.deadline]);
  }
  if(op==='richAuthorize') {
    const context=await call("rich_op_context($1,'context',$2)",args),m=richMaterial(context);
    return call('rich_authorize($1,$2,$3,$4,$5,$6)',[...args,m.key,m.ticket,m.hash,context.deadline]);
  }
  if(op==='richPublishInto'){
    const [draft,revision,request,canonical,recipe,version,descriptions]=args;
    document(JSON.parse(canonical.toString('utf8')),true);
    return call('publish_into($1,$2,$3,$4,$5,$6,$7::jsonb)',[draft,revision,request,recipe,version,canonical,descriptions?JSON.stringify(descriptions):null]);
  }
  if(op==='richPublish'){
    document(JSON.parse(args[3].toString('utf8')),true);
    return args.length===5?call('rich_publish($1,$2,$3,$4,$5::jsonb)',[...args.slice(0,4),JSON.stringify(args[4])]):call('rich_publish($1,$2,$3,$4)',args);
  }
  if(op!=='richFreeze')throw badInput();
  const [id,b]=args;
  const ctx=await call('rich_plan_context($1)',[id]);
  let payload,doc,records,needsLogo;
  if(ctx.purpose==='prepareDraft') {
    writableDocument(b.content);
    const prior=b.sourceVersionId? await call('rich_update_items($1)',[uuid(b.sourceVersionId)]) : [];
    const result=freezeSnapshot(b,ctx.seed,new Map(prior.map(i=>[i.itemId,i])));doc=document(result.content);records=result.records;
    needsLogo=!!doc.content.finalLogo;
    payload={format:'rich-v2',purpose:'prepareDraft',sourceIntentId:id,content:doc.content};
  }else{
    const edit=parseEditFreeze(b,ctx.draftId,ctx.revision);
    validateRichWritePayload(edit.payload);
    if(sha(edit.base.canonicalUTF8)!==ctx.manifest.sha256)throw new ApiError(409,'conflict');
    const cache=new Map(),originals=new Map();
    for(const candidate of edit.candidates){
      objectKeys(candidate,['sourceIntentId','canonical']);uuid(candidate.sourceIntentId);
      if(originals.has(candidate.sourceIntentId))throw badInput();
      originals.set(candidate.sourceIntentId,readDocument(candidate.canonical));
    }
    for(const {value} of edit.payload.changes.filter(c=>c.op==='includeCandidate')){
      const {source}=value;
      if(source.sourceIntentId!==ctx.sourceIntentId)throw new ApiError(403,'source_unavailable');
      const match=await call('rich_candidate($1,$2,$3)',[source.sourceIntentId,source.candidateId,source.expectedRevision]);
      const donor=originals.get(source.sourceIntentId)??edit.base;
      if(sha(donor.canonicalUTF8)!==match.candidateHash)throw new ApiError(409,'conflict');
      cache.set(richDigest(source),{content:donor.content,itemId:match.itemId});
    }

    const next=applyChanges(edit.base.content,edit.payload.changes,s=>cache.get(richDigest(s)),ctx.seed,edit.parts);
    doc=writableDocument(next.doc.content);records=next.copies;
    const sets=edit.payload.changes.filter(c=>c.op==='setFinalLogo');
    if(sets.length>1 || sets.length && sets[0].objectId!==doc.content.finalLogo?.objectId)throw badInput();
    needsLogo=sets.length===1;
    payload=edit.payload;
  }
  const bytes=richWireBytes(payload),hash=sha(doc.canonicalUTF8),digest=sha(bytes);
  if(needsLogo!==(b.logoUpload!==undefined))throw badInput();
  let evidence=null;
  if(needsLogo){
    objectKeys(b.logoUpload,['packageId','inputSha256']);
    const packageId=uuid(b.logoUpload.packageId);
    if(typeof b.logoUpload.inputSha256!=='string'||!/^[0-9a-f]{64}$/.test(b.logoUpload.inputSha256))throw badInput();
    const descriptor=doc.content.parts.find(p=>p.kind==='finalLogo'&&p.objectId===doc.content.finalLogo.objectId);
    if(!descriptor)throw badInput();
    evidence={packageId,inputSha256:b.logoUpload.inputSha256,descriptor};
  }
  await call('rich_save_plan($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,richDigest(b),hash,digest,b.access??ctx.access,b.sourceVersionId??null,
    JSON.stringify(records),JSON.stringify(inventory(doc.content)),evidence]);
  return {format:'rich-v2',sourceReviewSha256:richDigest(b),destinationDraftId:ctx.draftId,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),contentSha256:hash,
    logicalBytes:doc.logicalBytes,payload:bytes.toString('base64url'),payloadDigest:digest};
}
