import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const {canonicalizeRichRecipeContent,recipeBrowseDetailSchema}=await import(process.env.RECIPE_TEST_PROTOCOL_MODULE??'../../../packages/protocol/dist/index.js');
import {checkPublicationDescriptions} from './publication-descriptions-flow.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const bin=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-browse-preview-')),db=join(dir,'db'),sock=join(dir,'s');
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=value=>run('psql',['-XAtq','-h',sock,'-p','5432','-U','browse_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',value]).trim();
const owner=randomUUID(),reader=randomUUID(),ungranted=randomUUID(),recipe=randomUUID(),version=randomUUID(),codedRecipe=randomUUID(),coded=randomUUID(),legacyRecipe=randomUUID(),legacy=randomUUID(),pkg=randomUUID(),manifest=randomUUID();
const issuer='https://browse.test/auth/v1';
let started=false;
try{
  mkdirSync(sock,{mode:0o700});run('initdb',['-D',db,'-U','browse_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',`-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);started=true;
  sql('create role anon;create role authenticated');
  const unrelated=new Set(['20261116000100_recipe_account_profile.sql','20261116000200_recipe_author_pages.sql']);
  const authority=()=>sql(`select jsonb_build_object('memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),
    'functions',(select jsonb_agg(to_jsonb(p)-'prosrc' order by oid) from pg_proc p where pronamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)))`);
  for(const file of readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')&&!unrelated.has(f)).sort()){
    const before=file==='20261116000600_recipe_public_browse_preview.sql'?authority():null;
    run('psql',['-Xq','-h',sock,'-p','5432','-U','browse_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(root,'supabase/migrations',file)]);
    if(before!==null)assert.equal(authority(),before,'public-preview migration must preserve role graph, function ownership and ACLs');
  }
  sql(`insert into recipe_private.accounts(id) values('${owner}'),('${reader}'),('${ungranted}');select recipe_api.bind_identity_issuer('${issuer}');`);
  const content=JSON.parse(readFileSync(join(root,'packages/protocol/test/fixtures/recipe-rich-v2.content.json'),'utf8'));
  content.role.text={kind:'inline',value:'ROLE_BODY_SECRET'};
  content.rules=[{itemId:randomUUID(),originId:randomUUID(),purpose:'work',text:{kind:'inline',value:'RULE_BODY_SECRET'}}];
  const task={itemId:randomUUID(),originId:randomUUID(),name:'Weekly review',instruction:{kind:'inline',value:'TASK_BODY_SECRET'},
    spec:{kind:'weekly',days:[2],time:'09:30'},timeZone:{kind:'recommended',iana:'Asia/Shanghai'},placement:'follow'};
  content.tasks=[task];
  const entryId=randomUUID(),skillId=randomUUID();
  content.files=[{itemId:entryId,originId:randomUUID(),name:'SKILL.md',use:'skillDescription',text:{kind:'inline',value:'---\nname: help\ndescription: Short public explanation\n---\nSKILL_BODY_SECRET'}}];
  content.skills=[{itemId:skillId,originId:randomUUID(),name:'help\npublic',entryFileId:entryId,fileIds:[entryId]}];
  const doc=canonicalizeRichRecipeContent(content),canonical=Buffer.from(doc.canonicalUTF8),digest=createHash('sha256').update(canonical).digest('hex'),hex=canonical.toString('hex');
  sql(`insert into recipe_private.recipes(id,owner_id,revision) values('${recipe}','${owner}',1),('${codedRecipe}','${owner}',1),('${legacyRecipe}','${owner}',1);
    insert into recipe_private.versions(id,recipe_id,owner_id,revision,public_info,config,bytes) values
      ('${version}','${recipe}','${owner}',1,'{"name":"Public","summary":"","overview":"","version":"1","access":"direct"}','{}',${doc.logicalBytes}),
      ('${coded}','${codedRecipe}','${owner}',1,'{"name":"Coded","summary":"","overview":"","version":"1","access":"coded"}','{}',${doc.logicalBytes}),
      ('${legacy}','${legacyRecipe}','${owner}',1,'{"name":"Legacy","summary":"","overview":"","version":"1","access":"direct"}','{"role":"LEGACY_ROLE_SECRET"}',10);
    insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${pkg}','${owner}',gen_random_uuid(),1048576,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
      values('${manifest}','${pkg}',65,'manifest',${canonical.length},'${digest}',${canonical.length},${canonical.length},'${digest}',false,'ready','gone','present');
    insert into recipe_private.rich_versions(id,manifest_id) values('${version}','${manifest}'),('${coded}','${manifest}');
    insert into recipe_private.object_version_refs(version_id,object_id) values('${version}','${manifest}'),('${coded}','${manifest}');`);
  const preview=(r=recipe,v=version,actor=null)=>JSON.parse(sql(`begin;set local role recipe_api;${actor?`set local app.recipe_account='${actor}';`:''}select recipe_api.browse_preview('${r}','${v}');commit;`));
  const summaries=(r,v,actor)=>JSON.parse(sql(`begin;set local role recipe_api;${actor?`set local app.recipe_account='${actor}';`:''}select recipe_api.task_summaries('${r}','${v}');commit;`));
  const expectedTask={itemId:task.itemId,name:task.name,spec:task.spec,timeZone:task.timeZone,placement:task.placement};
  assert.deepEqual(summaries(recipe,version,owner),{recipeId:recipe,versionId:version});
  assert.throws(()=>summaries(recipe,version,null),/auth_required/);
  assert.throws(()=>summaries(recipe,version,ungranted),/not_found/);
  const pending=recipeBrowseDetailSchema.parse(preview());assert.equal(pending.previewUnavailable,true);assert.equal(pending.preview,undefined);
  assert.equal(recipeBrowseDetailSchema.parse(preview(codedRecipe,coded)).previewUnavailable,true);
  sql(`set role recipe_owner;select recipe_private.cache_browse_preview('${version}',decode('${hex}','hex'));select recipe_private.cache_browse_preview('${coded}',decode('${hex}','hex'));reset role;`);
  const open=recipeBrowseDetailSchema.parse(preview());assert.equal(open.preview.skills[0].description,'Short public explanation');
  assert.equal(open.preview.skills[0].name,'help public');
  assert.ok(!JSON.stringify(open).match(/ROLE_BODY_SECRET|RULE_BODY_SECRET|SKILL_BODY_SECRET|objectId|manifest|canonical|fileIds|memories/));
  const locked=recipeBrowseDetailSchema.parse(preview(codedRecipe,coded));assert.deepEqual(locked.preview,open.preview);assert.equal(locked.previewUnavailable,undefined);assert.equal(locked.acquired,false);
  assert.ok(!JSON.stringify(locked).match(/ROLE_BODY_SECRET|RULE_BODY_SECRET|SKILL_BODY_SECRET|objectId|manifest|canonical|fileIds|memories/));
  sql(`insert into recipe_private.grants(actor,version_id,original_request,original_digest) values('${reader}','${version}',gen_random_uuid(),decode('ab','hex')),('${reader}','${coded}',gen_random_uuid(),decode('ab','hex'));`);
  for(const who of [owner,reader])assert.deepEqual(summaries(codedRecipe,coded,who),{recipeId:codedRecipe,versionId:coded,tasks:[expectedTask]});
  assert.throws(()=>summaries(recipe,coded,reader),/not_found/);
  assert.ok(!JSON.stringify(open).includes(task.name));
  const granted=recipeBrowseDetailSchema.parse(preview(codedRecipe,coded,reader));assert.equal(granted.acquired,true);assert.ok(granted.preview);
  const descriptor=(who,target=version)=>sql(`set role recipe_object_verifier;select recipe_objects.read_descriptor(${who?`'${issuer}','${who}'`:'null,null'},'version','${target}','${manifest}');reset role;`);
  assert.throws(()=>descriptor(null),/not_found/);assert.throws(()=>descriptor(ungranted),/not_found/);assert.throws(()=>descriptor(ungranted,coded),/not_found/);
  assert.equal(JSON.parse(descriptor(reader)).objectId,manifest);assert.equal(JSON.parse(descriptor(owner)).objectId,manifest);
  sql(`update recipe_private.rich_versions set state='withdrawn' where id='${coded}'`);
  assert.throws(()=>preview(codedRecipe,coded),/not_found/);
  for(const who of [owner,reader])assert.throws(()=>summaries(codedRecipe,coded,who),/not_found/);
  for(const actor of [reader,owner]) {const detail=recipeBrowseDetailSchema.parse(preview(codedRecipe,coded,actor));assert.equal(detail.state,'withdrawn');assert.equal(detail.preview,undefined);}
  sql(`update recipe_private.rich_versions set state='banned' where id='${coded}'`);
  for(const actor of [null,reader,owner])assert.deepEqual(preview(codedRecipe,coded,actor),{state:'blocked',versionId:coded});
  assert.throws(()=>descriptor(reader,coded),/not_found/);
  for(const who of [owner,reader])assert.throws(()=>summaries(codedRecipe,coded,who),/not_found/);
  sql(`update recipe_private.rich_versions set state='listed' where id='${coded}'`);
  const legacyDetail=actor=>JSON.parse(sql(`begin;set local role recipe_api;${actor?`set local app.recipe_account='${actor}';`:''}select recipe_api.version_detail('${legacyRecipe}','${legacy}');commit;`));
  assert.equal(legacyDetail(null).config,undefined);assert.equal(legacyDetail(ungranted).config,undefined);assert.equal(legacyDetail(owner).config.role,'LEGACY_ROLE_SECRET');
  assert.equal(recipeBrowseDetailSchema.parse(preview(legacyRecipe,legacy)).format,'role-v1');
  sql(`update recipe_private.rich_versions set state='withdrawn' where id='${version}'`);
  assert.throws(()=>preview(),/not_found/);assert.equal(recipeBrowseDetailSchema.parse(preview(recipe,version,reader)).preview,undefined);assert.throws(()=>descriptor(reader),/not_found/);
  sql(`update recipe_private.rich_versions set state='banned' where id='${version}'`);
  assert.equal(preview(recipe,version,reader).state,'blocked');assert.throws(()=>descriptor(reader),/not_found/);
  assert.throws(()=>sql(`set role recipe_owner;select recipe_private.cache_browse_preview('${coded}',decode('00','hex'));`),/conflict/);
  sql(`set role recipe_owner;select recipe_private.cache_browse_preview('${coded}',decode('${hex}','hex'),'${JSON.stringify({[skillId]:'Backfilled public summary'})}'::jsonb);reset role;`);
  assert.equal(preview(codedRecipe,coded,reader).preview.skills[0].description,'Backfilled public summary');
  sql(`set role recipe_owner;select recipe_private.cache_browse_preview('${coded}',decode('${hex}','hex'));reset role;`);
  assert.equal(preview(codedRecipe,coded,reader).preview.skills[0].description,'Backfilled public summary');
  for(const role of ['anon','authenticated','recipe_api','recipe_object_verifier'])assert.equal(sql(`select has_function_privilege('${role}','recipe_private.cache_browse_preview(uuid,bytea,jsonb)','execute')`),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_api.browse_preview(uuid,uuid)','execute')"),'t');
  const publishing=structuredClone(content);
  delete publishing.role;delete publishing.finalLogo;
  for(const key of ['settings','rules','skills','files','tasks','memories','setup','parts'])publishing[key]=[];
  publishing.tasks=[task];
  publishing.public.name.value='New publication';publishing.public.version.value='2';
  const publishedDoc=canonicalizeRichRecipeContent(publishing),publishedBytes=Buffer.from(publishedDoc.canonicalUTF8),publishedHash=createHash('sha256').update(publishedBytes).digest('hex');
  const draft=randomUUID(),publishRecipe=randomUUID(),publishPkg=randomUUID(),publishManifest=randomUUID(),request=randomUUID();
  const publicInfo=Object.fromEntries(Object.entries(publishing.public).map(([key,value])=>[key,value.value]));publicInfo.access='direct';
  sql(`insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes,source_operation_id)
      values('${draft}','${owner}','${publishRecipe}',0,1,'${JSON.stringify(publicInfo)}','{}',${publishedDoc.logicalBytes},gen_random_uuid());
    insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${publishPkg}','${owner}','${draft}',1048576,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
      values('${publishManifest}','${publishPkg}',65,'manifest',${publishedBytes.length},'${publishedHash}',${publishedBytes.length},${publishedBytes.length},'${publishedHash}',false,'ready','gone','present');
    insert into recipe_private.rich_drafts(id,manifest_id,items) values('${draft}','${publishManifest}','[]');
    insert into recipe_private.object_draft_refs(draft_id,object_id) values('${draft}','${publishManifest}');`);
  const publish=()=>JSON.parse(sql(`begin;set local role recipe_api;set local app.recipe_account='${owner}';select recipe_api.rich_publish('${draft}',1,'${request}',decode('${publishedBytes.toString('hex')}','hex'));commit;`));
  const published=publish();assert.deepEqual(publish(),published);
  const publishedPreview=recipeBrowseDetailSchema.parse(preview(published.recipeId,published.versionId));
  assert.deepEqual(summaries(published.recipeId,published.versionId,owner).tasks,[expectedTask]);
  assert.ok(publishedPreview.preview);assert.equal(publishedPreview.previewUnavailable,undefined);
  await checkPublicationDescriptions({sql,sock,owner,issuer,content});
  console.log('PASS: compact DB-only previews, public coded/direct metadata parity before and after grant, no role/rule/skill bodies, pending/backfilled metadata, legacy no-source previews, exact-grant raw reads, retained withdrawn grants, banned denial, immutable manifest binding and restricted backfill permissions.');
}finally{if(started)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
