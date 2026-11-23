import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {applyRichMetadata,richMetadataInputDigest} from '../../../packages/protocol/dist/index.js';
import {applyChanges,document,freezeSnapshot,inventory,richDigest,richWireBytes} from '../src/rich-document.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>Buffer.from(value).toString('base64url');
const identity=()=>({itemId:randomUUID(),originId:randomUUID()});

export async function checkMemoryPolicy({connectAdmin,req,upload,read,start,applyPolicy,fixture,body,token,opId,collector}){
  const {accountId}=await req('/v1/me',token);
  async function call(expression,args){
    const client=connectAdmin();await client.connect();
    try{
      await client.query('begin');await client.query('set local role recipe_api');
      await client.query("select set_config('app.recipe_account',$1,true)",[accountId]);
      const {rows:[row]}=await client.query('select recipe_api.'+expression+' as result',args);
      await client.query('commit');return row.result;
    }finally{await client.end();}
  }
  async function oldPlan(handle,input,{cleanPayload=false}={}){
    const ctx=await call('rich_plan_context($1)',[handle.op]);
    let doc,records,payload;
    if(ctx.purpose==='prepareDraft'){
      const result=freezeSnapshot(input,ctx.seed);doc=document(result.content);records=result.records;
      payload={format:'rich-v2',purpose:'prepareDraft',sourceIntentId:handle.op,
        content:cleanPayload?{...doc.content,memories:[]}:doc.content};
    }else{
      const base=JSON.parse(Buffer.from(input.baseCanonical,'base64url'));
      const result=applyChanges(base,input.payload.changes,()=>{throw Error('unexpected candidate');},ctx.seed);
      doc=result.doc;records=result.copies;payload=input.payload;
    }
    const items=inventory(doc.content);
    await call('rich_save_plan($1,$2,$3,$4,$5,$6,$7,$8,$9)',[handle.op,richDigest(input),sha(doc.canonicalUTF8),sha(richWireBytes(payload)),
      'direct',null,JSON.stringify(cleanPayload?records.filter(row=>row.kind!=='memory'):records),
      JSON.stringify(cleanPayload?items.filter(row=>row.kind!=='memory'):items),null]);
    return {format:'rich-v2',sourceReviewSha256:richDigest(input),destinationDraftId:handle.draft,canonical:encoded(doc.canonicalUTF8),
      contentSha256:sha(doc.canonicalUTF8),logicalBytes:doc.logicalBytes,payload:encoded(richWireBytes(payload)),payloadDigest:sha(richWireBytes(payload))};
  }
  const source=structuredClone(fixture);delete source.finalLogo;source.parts=[];
  source.memories=Array.from({length:64},(_,index)=>({...identity(),text:{kind:'inline',value:'Historical private memory '+index}}));
  const published=await start(token),publishedPlan=await oldPlan(published,body(source,'direct'));
  const publishedAccept=await published.prepareAccept(publishedPlan),publishedReceipt=await publishedAccept();
  const publishKey=randomUUID();
  const publish=()=>req('/v2/drafts/'+publishedReceipt.draftId+'/publish',token,{canonical:publishedPlan.canonical},{key:publishKey,rev:1});
  const historicalPublication=await publish();

  const kept=await start(token),keptPlan=await oldPlan(kept,body(source,'direct')),keptAccept=await kept.prepareAccept(keptPlan);
  const keptReceipt=await keptAccept(),draftId=keptReceipt.draftId,path='/v2/drafts/'+draftId;
  const initial=JSON.parse(Buffer.from(keptPlan.canonical,'base64url'));
  async function metadata(base,revision,changes={},finalContent){
    const id=opId(),baseDoc=document(base),input={transformVersion:1,baseManifestSha256:sha(baseDoc.canonicalUTF8),
      public:{...Object.fromEntries(Object.entries(base.public).map(([key,item])=>[key,item.value])),...changes,access:'direct'},logo:{kind:'keep'}};
    const binding={revision,baseManifestSha256:input.baseManifestSha256,transformVersion:1,inputSha256:await richMetadataInputDigest(input)};
    await req('/v2/objects/'+id+'/reserve',token,{draftId,cap:250000,revision,metadata:input});
    const transformed=finalContent?document(finalContent):await applyRichMetadata(base,accountId,id,input);
    const manifest=await upload(token,id,65,'manifest',Buffer.from(transformed.canonicalUTF8));
    const wire={input,baseCanonical:encoded(baseDoc.canonicalUTF8),manifestId:manifest.objectId};
    const args=[id,draftId,binding,richDigest(wire),Buffer.from(transformed.canonicalUTF8),manifest.objectId,'direct',JSON.stringify(inventory(transformed.content)),null];
    return {id,binding,wire,args,content:transformed.content,
      patch:status=>req(path+'/metadata',token,wire,{key:id,rev:revision,method:'PATCH',status})};
  }
  const committedMetadata=await metadata(initial,1,{summary:'Historical metadata save'});
  const metadataReceipt=await call('rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',committedMetadata.args);
  const base=committedMetadata.content,baseCanonical=encoded(document(base).canonicalUTF8);
  const patch=changes=>({format:'rich-v2',baseCanonical,payload:{format:'rich-v2',purpose:'editDraft',draftId,baseRevision:2,
    requestId:randomUUID(),schemaVersion:2,changes}});
  const copySource=await start(token),copySourcePlan=await oldPlan(copySource,body(source,'direct'));
  const copySourceReceipt=await copySource.commit(copySourcePlan),copyBase=JSON.parse(Buffer.from(copySourcePlan.canonical,'base64url'));
  const pendingPrepare=await start(token),pendingPlan=await oldPlan(pendingPrepare,body(source,'direct'),{cleanPayload:true});
  const pendingAccept=await pendingPrepare.prepareAccept(pendingPlan);
  const pendingEdit=await start(token,{purpose:'editDraft',draftId,baseRevision:2});
  const editPlan=await oldPlan(pendingEdit,patch([{op:'setPublicText',field:'name',itemId:base.public.name.itemId,value:'Clean-looking edit'}]));
  const editAccept=await pendingEdit.prepareAccept(editPlan);
  const pendingCopy=await start(token,{purpose:'editDraft',draftId:copySourceReceipt.draftId,baseRevision:1});
  const copyInput=patch([{op:'copyItem',source:{kind:'memory',itemId:base.memories[0].itemId}},{op:'removeLegacyMemories'}]);
  const oldCopyInput={format:'rich-v2',baseCanonical:copySourcePlan.canonical,payload:{...copyInput.payload,
    draftId:copySourceReceipt.draftId,baseRevision:1,changes:[{op:'copyItem',source:{kind:'memory',itemId:copyBase.memories[0].itemId}},{op:'removeLegacyMemories'}]}};
  const copyPlan=await oldPlan(pendingCopy,oldCopyInput),copyAccept=await pendingCopy.prepareAccept(copyPlan);
  assert.equal(JSON.parse(Buffer.from(copyPlan.canonical,'base64url')).memories.length,0);
  const storedBytes=await call('rich_detail($1,$2)',[historicalPublication.recipeId,historicalPublication.versionId]);
  const historicalBytes=await read(token,'versions',historicalPublication.versionId,storedBytes.manifest.objectId);
  assert.equal(encoded(historicalBytes),publishedPlan.canonical);

  applyPolicy();
  assert.deepEqual(await publishedAccept(),publishedReceipt);
  assert.deepEqual(await keptAccept(),keptReceipt);
  assert.deepEqual(await publish(),historicalPublication);
  assert.deepEqual(await committedMetadata.patch(200),{status:'committed',receipt:metadataReceipt});
  const badProof=[...keptAccept.sqlArgs];badProof[3]=Buffer.alloc(32);
  await assert.rejects(call('rich_accept($1,$2,$3,$4,$5,$6,$7,$8)',badProof),/invalid_operation_proof/);
  await req('/v2/drafts/'+publishedReceipt.draftId+'/publish',token,{canonical:keptPlan.canonical},{key:publishKey,rev:1,status:409});
  await req(path+'/metadata',token,{...committedMetadata.wire,manifestId:randomUUID()},
    {key:committedMetadata.id,rev:1,method:'PATCH',status:409});
  assert.deepEqual(await call('rich_detail($1,$2)',[historicalPublication.recipeId,historicalPublication.versionId]),storedBytes);
  assert.deepEqual(await read(token,'versions',historicalPublication.versionId,storedBytes.manifest.objectId),historicalBytes);
  for(const [handle,accept] of [[pendingPrepare,pendingAccept],[pendingEdit,editAccept],[pendingCopy,copyAccept]]){
    await assert.rejects(call('rich_accept($1,$2,$3,$4,$5,$6,$7,$8)',accept.sqlArgs),/invalid_input/);
    assert.equal((await accept(422)).error.code,'invalid_input');
    await req(handle.path+'/cancel',token,{});
    await req('/v2/objects/'+handle.pkg+'/cancel',token,{});
    await collector.collect(accountId,handle.pkg);
  }
  assert.equal((await req(path,token)).revision,2);
  await req(path+'/publish',token,{canonical:baseCanonical},{key:randomUUID(),rev:2,status:422});
  const clean=applyChanges(base,[{op:'removeLegacyMemories'}],()=>{},'clean').doc;
  await assert.rejects(call('rich_publish($1,$2,$3,$4)',[draftId,2,randomUUID(),Buffer.from(clean.canonicalUTF8)]),/invalid_input/);

  const prepare=await start(token);
  await req(prepare.path+'/freeze',token,body(source,'direct'),{status:422});
  const rows=inventory(base),memoryRow=rows.find(row=>row.kind==='memory');
  const planArgs=[prepare.op,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'direct',null,JSON.stringify([{...memoryRow,source:{kind:'accountClaim'}}]),JSON.stringify(inventory(clean.content)),null];
  await assert.rejects(call('rich_save_plan($1,$2,$3,$4,$5,$6,$7,$8,$9)',planArgs),/invalid_input/);
  await assert.rejects(call('rich_save_plan($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...planArgs.slice(0,6),'[]',JSON.stringify(rows),null]),/invalid_input/);
  await req(prepare.path+'/cancel',token,{});
  await req('/v2/objects/'+prepare.pkg+'/cancel',token,{});
  await collector.collect(accountId,prepare.pkg);
  const dirtyMetadata=await metadata(base,2,{name:'New dirty metadata'});
  await dirtyMetadata.patch(422);
  await assert.rejects(call('rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',dirtyMetadata.args),/invalid_input/);
  await req('/v2/objects/'+dirtyMetadata.id+'/cancel',token,{});
  await collector.collect(accountId,dirtyMetadata.id);
  const dirtyRows=await metadata(base,2,{},clean.content);
  dirtyRows.args[7]=JSON.stringify([...inventory(clean.content),memoryRow]);
  await assert.rejects(call('rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',dirtyRows.args),/invalid_input/);
  await req('/v2/objects/'+dirtyRows.id+'/cancel',token,{});
  await collector.collect(accountId,dirtyRows.id);

  const edit=await start(token,{purpose:'editDraft',draftId,baseRevision:2});
  await req(edit.path+'/freeze',token,copyInput,{status:422});
  const include=patch([{op:'includeCandidate',value:{kind:'memory',source:{sourceIntentId:kept.op,candidateId:base.memories[0].itemId,expectedRevision:1}}},{op:'removeLegacyMemories'}]);
  await req(edit.path+'/freeze',token,include,{status:422});
  const cleanup=patch([{op:'removeLegacyMemories'}]);
  await req(edit.path+'/freeze',token,{...cleanup,payload:{...cleanup.payload,baseRevision:1}},{status:409});
  const next=await edit.freeze(cleanup),nextContent=JSON.parse(Buffer.from(next.canonical,'base64url'));
  assert.deepEqual(nextContent,clean.content);
  const nextReceipt=await edit.commit(next);assert.equal(nextReceipt.revision,3);
  const publication=await req(path+'/publish',token,{canonical:next.canonical},{key:randomUUID(),rev:3});
  const detail=await req('/v2/recipes/'+publication.recipeId+'/versions/'+publication.versionId,token);
  assert.equal(detail.release.contentSha256,next.contentSha256);
  assert.deepEqual(await committedMetadata.patch(200),{status:'committed',receipt:metadataReceipt});
  assert.deepEqual(await keptAccept(),keptReceipt);
  assert.deepEqual(await read(token,'versions',historicalPublication.versionId,storedBytes.manifest.objectId),historicalBytes);
  console.log('PASS: no-memory new plan/accept/publish/metadata SQL and HTTP boundaries; authenticated pre-policy receipt replays; 64-memory cleanup and stale revision; historical release unchanged.');
}
