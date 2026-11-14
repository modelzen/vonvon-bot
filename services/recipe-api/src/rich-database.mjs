import {createHash} from 'node:crypto';
import {ApiError,badInput} from './errors.mjs';
import {objectKeys,uuid} from './input.mjs';
import {richInstallMaterial} from './rich-install-proof.mjs';
import {richMaterial} from './rich-proof.mjs';
import {richWireBytes,applyChanges,document,freezeSnapshot,inventory,richDigest} from './rich-document.mjs';
import {parseEditFreeze,readDocument} from './rich-http.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const calls={
  richInstallPreview:'rich_install_preview($1)',richInstallRecover:"rich_install_control($1,'recover')",richInstallCancel:"rich_install_control($1,'cancel')",
  richInstallRedeem:'rich_possess_install($1,$2,$3,$4,$5)',richInstallComplete:'rich_possess_install($1,$2,$3,$4,$5)',
  richSourceItems:'rich_source_items($1)',richRegister:'rich_register($1,$2)',richDraft:'rich_draft($1)',richDraftList:'rich_draft_list()',richDelete:'rich_delete($1,$2,$3)',
  richDetail:'rich_detail($1,$2)',richWithdraw:'rich_withdraw($1)',richProfile:'rich_profile($1)',richCatalog:'rich_catalog_page($1,$2,$3)',
  richGet:"rich_op_context($1,'get',null)",richRecover:"rich_op_context($1,'recover',null)",richCancel:"rich_op_context($1,'cancel',null)",
  richDispatch:'rich_dispatch($1,$2,$3,$4)',richAccept:'rich_accept($1,$2,$3,$4,$5,$6,$7,$8)',
  richReserve:'reserve_object_package($1,$2,$3)',richCancelPackage:'cancel_object_package($1)',richCapacity:'object_capacity()',
};
export async function richExecute(client,op,args) {
  const call=async(expr,params)=>(await client.query('select recipe_api.'+expr+' as result',params)).rows[0].result;
  if(Object.hasOwn(calls,op))return call(calls[op],args);
  if(op==='richInstallAuthorize'){
    const ctx=await call('operation_context()',[]),[id,req]=args;
    const m=richInstallMaterial({...req,...ctx,operationId:id});
    return call('rich_install_authorize($1,$2,$3,$4,$5,$6,$7,$8)',[id,req,m.server,m.ticket,...m.hashes,ctx.deadline]);
  }
  if(op==='richAuthorize') {
    const context=await call("rich_op_context($1,'context',$2)",args),m=richMaterial(context);
    return call('rich_authorize($1,$2,$3,$4,$5,$6)',[...args,m.key,m.ticket,m.hash,context.deadline]);
  }
  if(op==='richPublish'){document(JSON.parse(args[3].toString('utf8')),true);return call('rich_publish($1,$2,$3,$4)',args);}
  if(op!=='richFreeze')throw badInput();
  const [id,b]=args;
  const ctx=await call('rich_plan_context($1)',[id]);
  let payload,doc,records,needsLogo;
  if(ctx.purpose==='prepareDraft') {
    const prior=b.sourceVersionId? await call('rich_update_items($1)',[uuid(b.sourceVersionId)]) : [];
    const result=freezeSnapshot(b,ctx.seed,new Map(prior.map(i=>[i.itemId,i])));doc=document(result.content);records=result.records;
    needsLogo=!!doc.content.finalLogo;
    payload={format:'rich-v2',purpose:'prepareDraft',sourceIntentId:id,content:doc.content};
  }else{
    const edit=parseEditFreeze(b,ctx.draftId,ctx.revision);
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
    doc=next.doc;records=next.copies;
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
