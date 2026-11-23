import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {applyRichMetadata} from '../../../packages/protocol/dist/index.js';
const sha=value=>createHash('sha256').update(value).digest('hex');

export async function checkMetadataSaves({connectAdmin,communityRequest,accountRequest,req,upload,read,start,sql,opId,token,other,body,fixture,png,collector}){
  const {accountId}=await req('/v1/me',token);
  const source=structuredClone(fixture);
  delete source.finalLogo; source.parts=[]; source.memories=[];
  const prepare=await start(token),initial=await prepare.freeze(body(source,'direct'));
  const {draftId}=await prepare.commit(initial);
  const draftPath='/v2/drafts/'+draftId;
  const metadata=draftPath+'/metadata';
  async function intent(changes={},logo={kind:'keep'},key=opId()){
    const draft=await req(draftPath,token);
    const bytes=await read(token,'drafts',draftId,draft.manifest.objectId),base=JSON.parse(bytes);
    const pub=Object.fromEntries(Object.entries(base.public).map(([k,v])=>[k,v.value]));
    const input={transformVersion:1,baseManifestSha256:draft.manifest.sha256, public:{...pub,access:draft.access,...changes},logo};
    const reserve={draftId,cap:175000,revision:draft.revision,metadata:input};
    const patch=(payload,status=200,who=token)=>req(metadata,who,payload,{status,key,rev:draft.revision,method:'PATCH'});
    return {key,input,base,draft,patch,reserve:(status=200)=>req('/v2/objects/'+key+'/reserve',token,reserve,{status}),
      async assemble(descriptor){
        const next=await applyRichMetadata(base,accountId,key,input,descriptor);
        const m=await upload(token,key,65,'manifest',Buffer.from(next.canonicalUTF8));
        return {canonical:Buffer.from(next.canonicalUTF8).toString('base64url'),wire:{input,manifestId:m.objectId,
          baseCanonical:bytes.toString('base64url'),...(descriptor?{logoDescriptor:descriptor}:{})}};
      }};
  }
  const access=await intent({access:'coded'}),pending=await access.patch({input:access.input});
  assert.equal(pending.status,'pending');
  await access.reserve();
  const changed={...access.input,public:{...access.input.public,name:'other'}};
  await req('/v2/objects/'+access.key+'/reserve',token,{draftId,cap:175000,revision:1,metadata:changed},{status:409});
  await req('/v2/objects/'+access.key+'/reserve',token,{draftId,cap:175000},{status:409});
  const absent={input:access.input,baseCanonical:initial.canonical,manifestId:access.draft.manifest.objectId};
  await access.patch(absent,409); // Same bytes and an existing reference, but no ready ordinal 65.
  await access.patch({input:access.input},404,other);
  const accessBody=await access.assemble(),first=await access.patch(accessBody.wire);
  assert.equal(first.receipt.revision,2);assert.equal(first.receipt.manifestSha256,initial.contentSha256);
  await access.patch({...accessBody.wire,manifestId:randomUUID()},409);
  const insert=await intent({name:'当前名称'},{kind:'replace',inputSha256:sha(png)});
  await insert.reserve();
  const normalized=await upload(token,insert.key,64,'finalLogo',png);
  const add=await insert.assemble(normalized);
  await insert.patch({...add.wire,logoDescriptor:{...normalized,bytes:normalized.bytes+1}},409);
  const inserted=await insert.patch(add.wire);assert.equal(inserted.receipt.revision,3);
  const insertedDoc=JSON.parse(Buffer.from(add.canonical,'base64url'));
  const replace=await intent({overview:'公开介绍'},{kind:'replace',inputSha256:sha(png)});
  await replace.reserve();
  const another=await upload(token,replace.key,64,'finalLogo',png);
  const replaced=await replace.assemble(another);
  const replacement=JSON.parse(Buffer.from(replaced.canonical,'base64url'));
  assert.deepEqual(replacement.finalLogo,{...insertedDoc.finalLogo,objectId:another.objectId});
  assert.deepEqual(replacement.rules,insertedDoc.rules);
  await replace.patch(replaced.wire);
  const chat=await start(token,{purpose:'editDraft',draftId,baseRevision:4});
  const chatPlan=await chat.freeze({format:'rich-v2',baseCanonical:replaced.canonical,payload:{
    format:'rich-v2',purpose:'editDraft',draftId,baseRevision:4,requestId:randomUUID(),schemaVersion:2,
    changes:[{op:'setPublicText',field:'name',itemId:replacement.public.name.itemId,value:'来自对话'}]}});
  const acceptChat=await chat.prepareAccept(chatPlan);
  const remove=await intent({summary:'更新介绍'},{kind:'remove'});
  await remove.reserve();const removed=await remove.assemble();
  const oldRefs=()=>sql("select string_agg(object_id::text,',' order by object_id) from recipe_private.object_draft_refs where draft_id='"+draftId+"'");
  const old=oldRefs();
  // Fill the account budget to exercise transaction rollback after reference mutation.
  const filler=randomUUID();
  sql("insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes) select gen_random_uuid(),'"+accountId+"','"+filler+"',0,1,'{}','{}',1048576 from generate_series(1,10)");
  // A larger public edit also drops the last reference to the current Logo.
  const big=await intent({overview:'x'.repeat(6000)},{kind:'remove'});
  await big.reserve();const bigBody=await big.assemble();
  const rejected=await big.patch(bigBody.wire,422);assert.equal(rejected.error.code,'quota_exceeded');
  assert.equal(oldRefs(),old);assert.equal((await req(draftPath,token)).revision,4);
  assert.equal((await big.patch({input:big.input,close:true})).status,'closed');
  await big.patch(bigBody.wire,410);
  await collector.collect(accountId,big.key);
  sql("delete from recipe_private.drafts where recipe_id='"+filler+"'");
  assert.equal((await remove.patch(removed.wire)).receipt.revision,5);
  assert.ok(!oldRefs().includes(another.objectId));
  assert.equal((await acceptChat(409)).error.code,'conflict');
  await req('/v2/objects/'+chat.pkg+'/cancel',token,{});
  await collector.collect(accountId,chat.pkg);
  const secret=await intent({overview:'sk-'+'A'.repeat(48)});
  assert.equal((await secret.reserve(422)).error.code,'credential_detected');
  const expired=await intent({summary:'过期'});await expired.reserve();
  const late=await expired.assemble();
  const blocker=connectAdmin();
  await blocker.connect();
  try{
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,187511))',[accountId]);
    const delayed=expired.patch(late.wire,410);
    let waiting=false;
    for(let i=0;i<100 && !waiting;i++){
      waiting=Number(sql("select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%rich_metadata_context%'"))>0;
      if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
    }
    await blocker.query("update recipe_private.object_packages set deadline=clock_timestamp()-interval '1 second' where id=$1",[expired.key]);
    await blocker.query('commit');
    assert.equal((await delayed).error.code,'operation_expired');assert.ok(waiting);
  }finally{await blocker.end();}
  assert.equal((await req(draftPath,token)).revision,5);
  await remove.patch({...removed.wire,items:[]},422);
  await collector.collect(accountId,expired.key);
  const native={status:()=>({kind:'signedIn',accountId}),onStatus:()=>()=>{},
    request:(id,path,init,beforeSend)=>{assert.equal(id,accountId);beforeSend?.();return accountRequest(token,path,init);}};
  const saved=await communityRequest(native,{type:'saveRichDraftMetadata',accountId,requestId:opId(),draftId,revision:5,
    baseManifestSha256:sha(Buffer.from(removed.canonical,'base64url')),public:{...remove.input.public,name:'桌面保存'},logo:{kind:'replace',base64:png.toString('base64')}});
  assert.equal(saved.status,'committed');assert.equal(saved.draft?.public.name,'桌面保存');assert.ok(saved.draft.logo);
  const publication=await communityRequest(native,{type:'publishDraft',format:'rich-v2',accountId,requestId:randomUUID(),draftId,
    revision:saved.receipt.revision,canonical:saved.draft.rich.canonical});
  assert.equal((await req('/v2/recipes/'+publication.recipeId+'/versions/'+publication.versionId,token)).release.contentSha256,saved.receipt.manifestSha256);
  assert.deepEqual(await access.patch(accessBody.wire),first);
  assert.deepEqual(await insert.patch({input:insert.input}),inserted);
  const published=await req('/v2/recipes/'+publication.recipeId+'/versions/'+publication.versionId,token);
  const historical=await read(token,'versions',publication.versionId,published.manifest.objectId);
  assert.equal(historical.toString('base64url'),saved.draft.rich.canonical);
  console.log('PASS: account metadata save, every Logo action, expiry, staged input conflicts, chat CAS, quota rollback and receipt replay after publication, and separate desktop Main save/publish with no Bot.');
}
