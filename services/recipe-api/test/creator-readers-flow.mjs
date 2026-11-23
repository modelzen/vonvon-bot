import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {applyRichMetadata,richMetadataInputDigest} from '../../../packages/protocol/dist/index.js';
import {richDigest} from '../src/rich-document.mjs';

const unknown={status:'unknown'};
const signatures=[
  'recipe_api.metadata_receipt(uuid,uuid,integer,text,integer,text,text)',
  'recipe_api.creator_context(text,uuid,integer,text)',
];

export async function checkCreatorReaders({req,start,fixture,body,upload,token,other,fresh,sql,connectAdmin,applyMigration,opId}){
  const catalog=()=>sql(`select jsonb_build_object(
    'memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),
    'functions',(select jsonb_agg(to_jsonb(p) order by oid) from pg_proc p
      where pronamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)
      and proname not in ('metadata_receipt','creator_context')),
    'tables',(select jsonb_agg(to_jsonb(c) order by oid) from pg_class c
      where relnamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)))`);
  const originalCatalog=catalog();applyMigration();assert.equal(catalog(),originalCatalog);
  for(const signature of signatures){
    const expression="'"+signature+"'::regprocedure";
    assert.equal(sql("select proowner='recipe_owner'::regrole and provolatile='s' and prosecdef and proconfig=array['search_path=pg_catalog, pg_temp'] from pg_proc where oid="+expression),'t');
    assert.equal(sql("select has_function_privilege('recipe_api',"+expression+",'execute')"),'t');
    for(const actor of ['anon','authenticated','recipe_object_verifier'])
      assert.equal(sql("select has_function_privilege('"+actor+"',"+expression+",'execute')"),'f');
    assert.equal(sql("select exists(select from pg_proc p,aclexplode(p.proacl) a where p.oid="+expression+" and a.grantee=0 and a.privilege_type='EXECUTE')"),'f');
  }
  const {accountId}=await req('/v1/me',token),otherId=(await req('/v1/me',other)).accountId;
  const tables=sql("select string_agg(relname,',' order by relname) from pg_class where relnamespace='recipe_private'::regnamespace and relkind='r'").split(',');
  const snapshot=()=>JSON.parse(sql('select jsonb_object_agg(name,rows) from ('+tables.map(table=>
    "select '"+table+"' name,(select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from recipe_private."+table+' t) rows').join(' union all ')+') s'));
  const record=async(path,expected)=>{
    const before=snapshot();assert.deepEqual(await req(path,token),expected);
    assert.deepEqual(snapshot(),before,'GET cannot change any recipe_private table');
  };
  const contextPath=(format,id,revision,hash)=>'/'+(format==='rich-v2'?'v2':'v1')+'/drafts/'+id+'/creator-context?revision='+revision+(hash?'&contentSha256='+hash:'');
  const context=(format,draft,sourceIntentId,parent)=>({draftId:draft.draftId,format,revision:draft.revision,sourceIntentId,parent});
  const legacyBody=version=>({public:{name:'Creator parent',summary:'Creator context fixture',overview:'',version,access:'direct'},config:{role:'Private creator role'}});
  const legacy=await req('/v1/drafts',token,legacyBody('1'),{key:randomUUID()});
  const legacyGet=await req('/v1/drafts/'+legacy.draftId,token);
  assert.deepEqual(Object.keys(legacyGet).sort(),['config','draftId','public','recipeId','revision']);
  await record(contextPath('role-v1',legacy.draftId,1),context('role-v1',legacy,null,null));
  const legacyVersion=await req('/v1/drafts/'+legacy.draftId+'/publish',token,{}, {key:randomUUID(),rev:1});
  const withParent=version=>({...legacyBody(version),recipeId:legacyVersion.recipeId,sourceVersionId:legacyVersion.versionId});
  const heldLegacy=await req('/v1/drafts',token,withParent('2'),{key:randomUUID()});
  const nextLegacy=await req('/v1/drafts',token,withParent('3'),{key:randomUUID()});
  await req('/v1/drafts/'+nextLegacy.draftId+'/publish',token,{}, {key:randomUUID(),rev:1});
  const heldLegacyGet=await req('/v1/drafts/'+heldLegacy.draftId,token);
  const expectedLegacy=context('role-v1',heldLegacy,null,{recipeId:legacyVersion.recipeId,versionId:legacyVersion.versionId});
  await record(contextPath('role-v1',heldLegacy.draftId,1),expectedLegacy);
  assert.deepEqual(await req('/v1/drafts/'+heldLegacy.draftId,token),heldLegacyGet);

  async function rich(version,parent){
    const source=structuredClone(fixture);source.public.version.value=version;
    const handle=await start(token),input=body(source,'direct');if(parent)input.sourceVersionId=parent;
    const plan=await handle.freeze(input),saved=await handle.commit(plan);
    return {handle,plan,saved};
  }
  const base=await rich('1');
  const baseGet=await req('/v2/drafts/'+base.saved.draftId,token);
  assert.deepEqual(Object.keys(baseGet).sort(),['access','draftId','format','logicalBytes','manifest','recipeId','retainedCandidateBytes','revision','sourceIntentId','sourceManifest']);
  await record(contextPath('rich-v2',base.saved.draftId,1,base.plan.contentSha256),context('rich-v2',base.saved,base.handle.op,null));
  const baseVersion=await req('/v2/drafts/'+base.saved.draftId+'/publish',token,{canonical:base.plan.canonical},{key:randomUUID(),rev:1});
  const heldRich=await rich('2',baseVersion.versionId),nextRich=await rich('3',baseVersion.versionId);
  await req('/v2/drafts/'+nextRich.saved.draftId+'/publish',token,{canonical:nextRich.plan.canonical},{key:randomUUID(),rev:1});
  const richPath=contextPath('rich-v2',heldRich.saved.draftId,1,heldRich.plan.contentSha256);
  const expectedRich=context('rich-v2',heldRich.saved,heldRich.handle.op,{recipeId:baseVersion.recipeId,versionId:baseVersion.versionId});
  const heldRichGet=await req('/v2/drafts/'+heldRich.saved.draftId,token);
  await record(richPath,expectedRich);
  assert.deepEqual(await req('/v2/drafts/'+heldRich.saved.draftId,token),heldRichGet);
  for(const path of [contextPath('role-v1',heldLegacy.draftId,1),richPath]){
    const before=snapshot();assert.equal((await req(path,other,undefined,{status:404})).error.code,'not_found');
    assert.deepEqual(snapshot(),before);
    assert.equal((await req(path.replace('revision=1','revision=2'),token,undefined,{status:409})).error.code,'conflict');
  }
  assert.equal((await req(richPath.replace(heldRich.plan.contentSha256,'00'.repeat(32)),token,undefined,{status:409})).error.code,'conflict');
  assert.equal((await req(contextPath('role-v1',heldRich.saved.draftId,1),token,undefined,{status:409})).error.code,'request_upgrade_required');
  assert.equal((await req(contextPath('rich-v2',heldLegacy.draftId,1,'00'.repeat(32)),token,undefined,{status:404})).error.code,'not_found');
  assert.equal((await req(contextPath('role-v1',randomUUID(),1),token,undefined,{status:404})).error.code,'not_found');
  sql("update recipe_private.drafts set base_revision=999 where id='"+heldLegacy.draftId+"'");
  assert.equal((await req(contextPath('role-v1',heldLegacy.draftId,1),token,undefined,{status:503})).error.code,'integrity_error');
  sql("update recipe_private.drafts set base_revision=1 where id='"+heldLegacy.draftId+"'");
  sql("update recipe_private.versions set owner_id='"+otherId+"' where id='"+baseVersion.versionId+"'");
  assert.equal((await req(richPath,token,undefined,{status:503})).error.code,'integrity_error');
  sql("update recipe_private.versions set owner_id='"+accountId+"' where id='"+baseVersion.versionId+"'");

  async function metadata(target,canonical,changes){
    const draft=await req('/v2/drafts/'+target,token),content=JSON.parse(Buffer.from(canonical,'base64url'));
    const input={transformVersion:1,baseManifestSha256:draft.manifest.sha256,
      public:{...Object.fromEntries(Object.entries(content.public).map(([key,value])=>[key,value.value])),access:draft.access,...changes},logo:{kind:'keep'}};
    const key=opId(),digest=await richMetadataInputDigest(input);
    await req('/v2/objects/'+key+'/reserve',token,{draftId:target,cap:175000,revision:draft.revision,metadata:input});
    const transformed=await applyRichMetadata(content,accountId,key,input);
    const manifest=await upload(token,key,65,'manifest',Buffer.from(transformed.canonicalUTF8));
    const wire={input,baseCanonical:canonical,manifestId:manifest.objectId};
    const result=await req('/v2/drafts/'+target+'/metadata',token,wire,{key,rev:draft.revision,method:'PATCH'});
    const path='/v2/receipts/metadata/'+key+'?draftId='+target+'&revision='+draft.revision+'&baseManifestSha256='+input.baseManifestSha256+'&transformVersion=1&inputSha256='+digest;
    const args=[key,target,draft.revision,input.baseManifestSha256,1,digest,richDigest(wire)];
    return {key,path,args,result,canonical:Buffer.from(transformed.canonicalUTF8).toString('base64url')};
  }
  const metadataWork=await rich('metadata');
  const first=await metadata(metadataWork.saved.draftId,metadataWork.plan.canonical,{summary:'First exact metadata receipt'});
  const second=await metadata(metadataWork.saved.draftId,first.canonical,{summary:'Later edit preserves old receipt'});
  const currentRich=await req('/v2/drafts/'+metadataWork.saved.draftId,token);
  await record(contextPath('rich-v2',metadataWork.saved.draftId,3,currentRich.manifest.sha256),{...context('rich-v2',metadataWork.saved,metadataWork.handle.op,null),revision:3});
  for(const path of [first.path,first.path+'&wireSha256='+first.args[6]])await record(path,first.result);
  const beforeUnknown=snapshot();
  for(const path of [
    first.path.replace(first.key,randomUUID()),first.path.replace(first.key,opId(Date.now()-10*86400000)),
    first.path.replace(metadataWork.saved.draftId,randomUUID()),first.path.replace('revision=1','revision=2'),
    first.path.replace('baseManifestSha256='+first.args[3],'baseManifestSha256='+'00'.repeat(32)),
    first.path.replace('inputSha256='+first.args[5],'inputSha256='+'00'.repeat(32)),first.path+'&wireSha256='+'00'.repeat(32),
  ])assert.deepEqual(await req(path,token),unknown);
  assert.deepEqual(await req(first.path,other),unknown);assert.deepEqual(snapshot(),beforeUnknown);
  const expired=opId();
  const expiredContent=JSON.parse(Buffer.from(second.canonical,'base64url'));
  const expiredInput={transformVersion:1,baseManifestSha256:currentRich.manifest.sha256,
    public:{...Object.fromEntries(Object.entries(expiredContent.public).map(([key,value])=>[key,value.value])),access:'direct'},logo:{kind:'keep'}};
  await req('/v2/objects/'+expired+'/reserve',token,{draftId:metadataWork.saved.draftId,cap:175000,revision:3,
    metadata:expiredInput});
  sql("update recipe_private.object_packages set deadline=clock_timestamp()-interval '1 hour' where id='"+expired+"'");
  const expiredPath='/v2/receipts/metadata/'+expired+'?draftId='+metadataWork.saved.draftId+'&revision=3&baseManifestSha256='+currentRich.manifest.sha256+'&transformVersion=1&inputSha256='+await richMetadataInputDigest(expiredInput);
  await record(expiredPath,unknown);
  sql("update recipe_private.object_packages set state='closed' where id='"+expired+"'");
  await record(expiredPath,unknown);
  sql("update recipe_private.receipts set created_at=clock_timestamp()-interval '10 days' where actor='"+accountId+"' and action='richMetadata' and request_id='"+first.key+"'");
  await record(first.path,first.result);
  const publicationKey=randomUUID();
  await req('/v2/drafts/'+metadataWork.saved.draftId+'/publish',token,{canonical:second.canonical},{key:publicationKey,rev:3});
  await record(first.path,first.result);
  await record(second.path,second.result);
  assert.equal((await req(contextPath('rich-v2',metadataWork.saved.draftId,3,currentRich.manifest.sha256),token,undefined,{status:404})).error.code,'not_found');
  await record(first.path.replace(first.key,publicationKey),unknown);
  const deletable=await rich('delete');
  const deleted=await metadata(deletable.saved.draftId,deletable.plan.canonical,{summary:'Receipt survives deletion'});
  await req('/v2/drafts/'+deletable.saved.draftId,token,{}, {method:'DELETE',key:randomUUID(),rev:2});
  await record(deleted.path,deleted.result);
  const nonsecret=JSON.stringify([first.result,second.result,deleted.result,expectedLegacy,expectedRich]);
  for(const secret of ['Private creator role','First exact metadata receipt','Later edit preserves old receipt',first.args[6]])assert.ok(!nonsecret.includes(secret));
  sql("delete from recipe_private.receipts where actor='"+accountId+"' and action='richMetadata' and request_id='"+first.key+"'");
  await record(first.path,unknown);

  const live=await rich('read-only');
  const client=connectAdmin();await client.connect();
  try{
    await client.query('begin read only');await client.query('set local role recipe_api');
    await client.query("select set_config('app.recipe_account',$1,true)",[accountId]);
    assert.deepEqual((await client.query('select recipe_api.metadata_receipt($1,$2,$3,$4,$5,$6,$7) result',deleted.args)).rows[0].result,deleted.result);
    assert.deepEqual((await client.query('select recipe_api.metadata_receipt($1,$2,$3,$4,$5,$6,$7) result',[...deleted.args.slice(0,6),null])).rows[0].result,deleted.result);
    assert.deepEqual((await client.query('select recipe_api.creator_context($1,$2,$3,$4) result',['role-v1',heldLegacy.draftId,1,null])).rows[0].result,expectedLegacy);
    assert.deepEqual((await client.query('select recipe_api.creator_context($1,$2,$3,$4) result',['rich-v2',live.saved.draftId,1,live.plan.contentSha256])).rows[0].result,context('rich-v2',live.saved,live.handle.op,null));
    assert.deepEqual((await client.query('select recipe_api.metadata_receipt($1,$2,$3,$4,$5,$6,$7) result',[...deleted.args.slice(0,6),'00'.repeat(32)])).rows[0].result,unknown);
    for(const [index,value] of [[0,null],[1,null],[2,0],[3,null],[4,2],[5,'bad'],[6,'bad']]){
      const args=[...deleted.args];args[index]=value;await client.query('savepoint invalid_metadata');
      await assert.rejects(client.query('select recipe_api.metadata_receipt($1,$2,$3,$4,$5,$6,$7)',args),{message:'invalid_input'});
      await client.query('rollback to savepoint invalid_metadata');
    }
    for(const args of [[null,heldLegacy.draftId,1,null],['role-v1',null,1,null],['role-v1',heldLegacy.draftId,0,null],
      ['role-v1',heldLegacy.draftId,1,'00'.repeat(32)],['rich-v2',live.saved.draftId,1,null]]){
      await client.query('savepoint invalid_context');
      await assert.rejects(client.query('select recipe_api.creator_context($1,$2,$3,$4)',args),{message:'invalid_input'});
      await client.query('rollback to savepoint invalid_context');
    }
  }finally{await client.query('rollback');await client.end();}
  const beforeFresh=snapshot();assert.deepEqual(await req(deleted.path,fresh),unknown);const afterFresh=snapshot();
  const business=({accounts,account_identities,...rows})=>rows;
  assert.deepEqual(business(afterFresh),business(beforeFresh));
  assert.equal(afterFresh.accounts.length,beforeFresh.accounts.length+1);
  assert.equal(afterFresh.account_identities.length,beforeFresh.account_identities.length+1);
  assert.deepEqual(await req(deleted.path,fresh),unknown);assert.deepEqual(snapshot(),afterFresh);
  sql("update recipe_private.accounts set status='disabled' where id='"+accountId+"'");
  for(const path of [deleted.path,contextPath('role-v1',heldLegacy.draftId,1)])assert.equal((await req(path,token,undefined,{status:403})).error.code,'account_disabled');
  sql("update recipe_private.accounts set status='active' where id='"+accountId+"'");
  console.log('PASS: migration004 preserves prior catalogs and ACLs; exact active parent/source reads and historical metadata receipt GETs preserve all business rows after edits, publication, deletion, expiry, mismatches, and missing receipts.');
}
