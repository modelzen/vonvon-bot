import {createHash} from 'node:crypto';
import {ApiError,badInput} from './errors.mjs';
import {payloadBytes} from './authoring-input.mjs';
import {uuid} from './input.mjs';
import {richInstallMaterial} from './rich-install-proof.mjs';
import {richMaterial} from './rich-proof.mjs';
import {applyChanges,document,freezeSnapshot,inventory,richDigest} from './rich-document.mjs';
import {parseEditFreeze} from './rich-http.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const calls={
  richUnredeemable:'rich_install_unredeemable($1,$2)',
  richInstallPreview:'rich_install_preview($1)',richInstallRecover:"rich_install_control($1,'recover')",richInstallCancel:"rich_install_control($1,'cancel')",
  richInstallRedeem:'rich_possess_install($1,$2,$3,$4,$5)',richInstallComplete:'rich_possess_install($1,$2,$3,$4,$5)',
  richSourceItems:'rich_source_items($1)',richRegister:'rich_register($1,$2)',richDraft:'rich_draft($1)',richDraftList:'rich_draft_list()',richDelete:'rich_delete($1,$2,$3)',
  richDetail:'rich_detail($1,$2)',richWithdraw:'rich_withdraw($1)',richProfile:'rich_profile($1)',richCatalog:'rich_catalog($1,$2)',
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
  let payload,doc,records;
  if(ctx.purpose==='prepareDraft') {
    const prior=b.sourceVersionId? await call('rich_update_items($1)',[uuid(b.sourceVersionId)]) : [];
    const result=freezeSnapshot(b,ctx.seed,new Map(prior.map(i=>[i.itemId,i])));doc=document(result.content);records=result.records;
    payload={format:'rich-v2',purpose:'prepareDraft',sourceIntentId:id,content:doc.content};
  }else{
    const edit=parseEditFreeze(b,ctx.draftId,ctx.revision);
    if(sha(edit.base.canonicalUTF8)!==ctx.manifest.sha256)throw new ApiError(409,'conflict');
    const cache=new Map();
    for(const {value} of edit.payload.changes.filter(c=>c.op==='includeCandidate')){
      const {source}=value;
      if(source.sourceIntentId!==ctx.sourceIntentId)throw new ApiError(403,'source_unavailable');
      const match=await call('rich_candidate($1,$2,$3)',[source.sourceIntentId,source.candidateId,source.expectedRevision]);
      if(match.manifestHash!==ctx.manifest.sha256)throw new ApiError(409,'conflict');
      cache.set(richDigest(source),{content:edit.base.content,itemId:match.itemId});
    }
    if(edit.candidates.length)throw badInput();
    const next=applyChanges(edit.base.content,edit.payload.changes,s=>cache.get(richDigest(s)),ctx.seed,edit.parts);
    doc=next.doc;const index=new Map(inventory(doc.content).map(i=>[i.itemId,i]));
    // A copied then removed donor may still have descendants in this same batch.
    records=next.copies.map(c=>({...c,baselineSha256:index.get(c.itemId)?.baselineSha256??richDigest({removed:c.kind})}));
    payload=edit.payload;
  }
  const bytes=payloadBytes(payload),hash=sha(doc.canonicalUTF8),digest=sha(bytes);
  await call('rich_save_plan($1,$2,$3,$4,$5,$6,$7,$8)',[id,richDigest(b),hash,digest,b.access??ctx.access,b.sourceVersionId??null,
    JSON.stringify(records),JSON.stringify(inventory(doc.content))]);
  return {format:'rich-v2',destinationDraftId:ctx.draftId,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),contentSha256:hash,
    logicalBytes:doc.logicalBytes,payload:bytes.toString('base64url'),payloadDigest:digest};
}
