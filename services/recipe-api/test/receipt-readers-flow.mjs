import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const unknown={status:'unknown'};
const signatures=[
  'recipe_api.publication_receipt(text,uuid,uuid,integer,text)',
  'recipe_api.code_issuance_receipt(uuid,uuid,integer)',
];

export async function checkReceiptReaders({req,start,fixture,body,token,other,reader,fresh,sql,connectAdmin,applyMigration,opId}){
  const protectedCatalog=()=>sql(`select jsonb_build_object(
    'memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),
    'functions',(select jsonb_agg(to_jsonb(p) order by oid) from pg_proc p
      where pronamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)
      and proname not in ('publication_receipt','code_issuance_receipt')),
    'tables',(select jsonb_agg(to_jsonb(c) order by oid) from pg_class c
      where relnamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)))`);
  const beforeMigration=protectedCatalog();applyMigration();
  assert.equal(protectedCatalog(),beforeMigration,'forward reader migration preserves every existing function, table and role membership');
  for(const signature of signatures){
    const expression="'"+signature+"'::regprocedure";
    assert.equal(sql("select proowner='recipe_owner'::regrole and provolatile='s' and prosecdef and proconfig=array['search_path=pg_catalog, pg_temp'] from pg_proc where oid="+expression),'t');
    assert.equal(sql("select has_function_privilege('recipe_api',"+expression+",'execute')"),'t');
    for(const actor of ['anon','authenticated','recipe_object_verifier'])
      assert.equal(sql("select has_function_privilege('"+actor+"',"+expression+",'execute')"),'f');
    assert.equal(sql("select exists(select from pg_proc p,aclexplode(p.proacl) a where p.oid="+expression+" and a.grantee=0 and a.privilege_type='EXECUTE')"),'f');
  }
  const account=(await req('/v1/me',token)).accountId;
  await req('/v1/me',other);await req('/v1/me',reader);
  const snapshots=()=>sql(`select jsonb_build_object(
    'receipts',(select jsonb_agg(to_jsonb(r) order by actor,action,request_id) from recipe_private.receipts r),
    'codes',(select jsonb_agg(to_jsonb(c) order by id) from recipe_private.codes c),
    'drafts',(select jsonb_agg(to_jsonb(d) order by id) from recipe_private.drafts d),
    'retired',(select jsonb_agg(to_jsonb(d) order by id) from recipe_private.retired_drafts d),
    'recipes',(select jsonb_agg(to_jsonb(r) order by id) from recipe_private.recipes r),
    'versions',(select jsonb_agg(to_jsonb(v) order by id) from recipe_private.versions v),
    'grants',(select jsonb_agg(to_jsonb(g) order by actor,version_id) from recipe_private.grants g),
    'accounts',(select jsonb_agg(to_jsonb(a) order by id) from recipe_private.accounts a),
    'identities',(select jsonb_agg(to_jsonb(i) order by issuer,subject) from recipe_private.account_identities i))`);
  const legacyBody=access=>({public:{name:'Receipt author private title',summary:'Receipt fixture',overview:'',version:'1',access},config:{role:'Private role'}});
  const cases=[];
  for(const access of ['direct','coded']){
    const initial=await req('/v1/drafts',token,legacyBody(access),{key:randomUUID()});
    const draft=await req('/v1/drafts/'+initial.draftId,token,legacyBody(access),{method:'PATCH',key:randomUUID(),rev:1});
    const requestId=randomUUID(),revision=2;
    const publication=await req('/v1/drafts/'+draft.draftId+'/publish',token,{}, {key:requestId,rev:revision});
    cases.push({format:'role-v1',api:'v1',access,requestId,draftId:draft.draftId,revision,publication});
  }
  for(const access of ['direct','coded']){
    const handle=await start(token),plan=await handle.freeze(body(fixture,access)),saved=await handle.commit(plan);
    const requestId=randomUUID(),revision=saved.revision;
    const publication=await req('/v2/drafts/'+saved.draftId+'/publish',token,{canonical:plan.canonical},{key:requestId,rev:revision});
    cases.push({format:'rich-v2',api:'v2',access,requestId,draftId:saved.draftId,revision,hash:plan.contentSha256,publication});
  }
  const publicationPath=c=>'/'+c.api+'/receipts/publications/'+c.requestId+'?draftId='+c.draftId+'&revision='+c.revision+(c.hash?'&contentSha256='+c.hash:'');
  const committed=new Map();
  const before=snapshots();
  for(const c of cases){
    const path=publicationPath(c),publication=c.publication;
    const stored=JSON.parse(sql("select result::text from recipe_private.receipts where actor='"+account+"' and action='"+(c.format==='rich-v2'?'richPublish':'publish')+"' and request_id='"+c.requestId+"'"));
    assert.equal(sql("select count(*) from recipe_private.drafts where id='"+c.draftId+"'"),'0');
    assert.equal(sql("select count(*) from recipe_private.retired_drafts where id='"+c.draftId+"'"),'1');
    const expected={status:'committed',receipt:{requestId:c.requestId,format:c.format,draftId:c.draftId,draftRevision:c.revision,
      recipeId:publication.recipeId,versionId:publication.versionId,revision:publication.revision,public:publication.public,firstCodeId:stored.firstCodeId}};
    assert.deepEqual(await req(path,token),expected);
    assert.equal(expected.receipt.revision,1);
    if(c.format==='role-v1')assert.equal(expected.receipt.draftRevision,2);
    committed.set(c,expected);
    for(const bad of [path.replace(c.requestId,randomUUID()),path.replace(c.draftId,randomUUID()),path.replace('revision='+c.revision,'revision='+(c.revision+1)),
      ...(c.hash?[path.replace(c.hash,'00'.repeat(32))]:[])])assert.deepEqual(await req(bad,token),unknown);
    assert.deepEqual(await req(path,other),unknown);
    await req(path,undefined,undefined,{status:401});
    const wrongAction=c.format==='rich-v2'?path.replace('/v2/','/v1/').replace('&contentSha256='+c.hash,''):
      path.replace('/v1/','/v2/')+'&contentSha256='+'00'.repeat(32);
    assert.deepEqual(await req(wrongAction,token),unknown);
    assert.deepEqual(await req('/v1/receipts/code-issuance/'+c.requestId+'?versionId='+publication.versionId+'&count=1',token),unknown);
  }
  assert.equal(snapshots(),before,'publication lookup cannot create versions, codes, receipts, grants, drafts or accounts');

  const batches=[];
  for(const c of cases.filter(c=>c.access==='coded')){
    const versionId=c.publication.versionId,requestId=randomUUID(),count=3;
    const issued=await req('/v1/versions/'+versionId+'/codes',token,{count},{key:requestId});
    const exact=JSON.parse(sql("select result::text from recipe_private.receipts where actor='"+account+"' and action='issue' and request_id='"+requestId+"'"));
    assert.deepEqual(exact,issued.items.map(item=>item.codeId));
    const path='/v1/receipts/code-issuance/'+requestId+'?versionId='+versionId+'&count='+count;
    const expected={status:'committed',receipt:{requestId,versionId,count,codeIds:exact}};
    batches.push(expected);
    const firstId=committed.get(c).receipt.firstCodeId;
    assert.ok(firstId);
    const checkpoint=snapshots();
    assert.deepEqual(await req(path,token),expected);
    for(const bad of [path.replace(requestId,randomUUID()),path.replace(versionId,randomUUID()),path.replace('count=3','count=2')])
      assert.deepEqual(await req(bad,token),unknown);
    assert.deepEqual(await req(path,other),unknown);
    assert.deepEqual(await req('/v1/receipts/publications/'+requestId+'?draftId='+c.draftId+'&revision='+c.revision,token),unknown);
    assert.equal(snapshots(),checkpoint,'unknown and committed code receipts are read-only');
    const first=await req('/v1/codes/'+firstId+'/reveal',token,{}, {key:randomUUID()});
    assert.equal(first.code,c.publication.firstCode);
    if(c.format==='role-v1')await req('/v1/versions/'+versionId+'/redeem',other,{code:first.code},{key:'a2.'+opId()});
    else await req('/v1/codes/'+firstId+'/disable',token,{}, {key:randomUUID()});
    assert.equal(sql("select status from recipe_private.codes where id='"+firstId+"'"),c.format==='role-v1'?'redeemed':'disabled');
    await req('/'+c.api+'/versions/'+versionId+'/redeem',reader,{code:issued.items[0].code},{key:'a2.'+opId()});
    await req('/v1/codes/'+exact[1]+'/disable',token,{}, {key:randomUUID()});
    assert.equal(sql("select status from recipe_private.codes where id='"+exact[0]+"'"),'redeemed');
    assert.equal(sql("select status from recipe_private.codes where id='"+exact[1]+"'"),'disabled');
    assert.equal(sql("select status from recipe_private.codes where id='"+exact[2]+"'"),'available');
    const afterStatus=snapshots();
    assert.deepEqual(await req(publicationPath(c),token),committed.get(c));
    assert.deepEqual(await req(path,token),expected);
    await req('/v1/codes/'+firstId+'/reveal',token,{}, {key:randomUUID(),status:409});
    await req('/v1/codes/'+exact[1]+'/reveal',token,{}, {key:randomUUID(),status:409});
    assert.equal((await req('/v1/codes/'+exact[2]+'/reveal',token,{}, {key:randomUUID()})).code,issued.items[2].code);
    assert.equal(snapshots(),afterStatus,'reading original IDs never revives redeemed or disabled codes or mints replacements');
    const json=JSON.stringify([committed.get(c),expected]);
    for(const secret of [c.publication.firstCode,...issued.items.map(item=>item.code),'Private role'])assert.ok(!json.includes(secret));
    if(c.format==='rich-v2'){
      await req('/v2/versions/'+versionId+'/withdraw',token,{});
      const withdrawn=snapshots();
      assert.deepEqual(await req(publicationPath(c),token),committed.get(c));
      assert.deepEqual(await req(path,token),expected);
      assert.equal(sql("select status from recipe_private.codes where id='"+exact[2]+"'"),'disabled');
      assert.equal(snapshots(),withdrawn,'withdrawal status does not authorize another code batch');
    }
  }
  const client=connectAdmin();await client.connect();
  try{
    await client.query('begin read only');await client.query('set local role recipe_api');
    await client.query("select set_config('app.recipe_account',$1,true)",[account]);
    for(const c of cases){
      const {rows:[row]}=await client.query('select recipe_api.publication_receipt($1,$2,$3,$4,$5) as result',[c.format,c.requestId,c.draftId,c.revision,c.hash??null]);
      assert.deepEqual(row.result,committed.get(c));
    }
    for(const expected of batches){
      const {requestId,versionId,count}=expected.receipt;
      assert.deepEqual((await client.query('select recipe_api.code_issuance_receipt($1,$2,$3) as result',[requestId,versionId,count])).rows[0].result,expected);
    }
    assert.deepEqual((await client.query('select recipe_api.code_issuance_receipt($1,$2,$3) as result',[randomUUID(),randomUUID(),1])).rows[0].result,unknown);
  }finally{await client.query('rollback');await client.end();}
  const forgotten=cases[0];
  sql("delete from recipe_private.receipts where actor='"+account+"' and action='publish' and request_id='"+forgotten.requestId+"'");
  const withoutReceipt=snapshots();
  assert.deepEqual(await req(publicationPath(forgotten),token),unknown);
  assert.equal(snapshots(),withoutReceipt,'a missing receipt for a real retired publication remains unknown without replacing its version or code');
  const beforeFresh=JSON.parse(snapshots());
  assert.deepEqual(await req(publicationPath(cases[1]),fresh),unknown);
  const afterFresh=JSON.parse(snapshots());
  const business=({accounts,identities,...rows})=>rows;
  assert.deepEqual(business(afterFresh),business(beforeFresh),'a first-seen authenticated subject cannot create recipe, draft, grant, code or business receipt rows');
  assert.equal(afterFresh.accounts.length,beforeFresh.accounts.length+1,'existing identity bootstrap creates one account');
  assert.equal(afterFresh.identities.length,beforeFresh.identities.length+1,'existing identity bootstrap creates one subject binding');
  assert.deepEqual(await req(publicationPath(cases[1]),fresh),unknown);
  assert.deepEqual(JSON.parse(snapshots()),afterFresh,'repeat receipt lookup does not repeat identity bootstrap');
  sql("update recipe_private.accounts set status='disabled' where id='"+account+"'");
  const denied=await req(publicationPath(cases[0]),token,undefined,{status:403});assert.equal(denied.error.code,'account_disabled');
  sql("update recipe_private.accounts set status='active' where id='"+account+"'");
  console.log('PASS: SELECT-only publication and ordered code receipt reads preserve actor, exact action/key/arguments, retired publication, code redemption/disable/withdrawal, business IDs and rows, original ACLs and unknown semantics; HTTP keeps normal first-subject identity bootstrap.');
}
