import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const bindir=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-library-groups-')),db=join(dir,'db'),sock=join(dir,'s');
const run=(name,args)=>execFileSync(join(bindir,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=value=>run('psql',['-XAtq','-h',sock,'-p','5432','-U','library_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',value]).trim();
const author=randomUUID(),reader=randomUUID(),stranger=randomUUID(),recipe='ffffffff-ffff-4fff-8fff-ffffffffffff';
const quoted=value=>value===null?'null':"'"+value.replaceAll("'","''")+"'";
let started=false;
try {
  mkdirSync(sock,{mode:0o700});
  run('initdb',['-D',db,'-U','library_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',`-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);started=true;
  sql('create role anon; create role authenticated');
  const migrations=join(root,'supabase/migrations');
  const lifecycle = '20261117000100_recipe_version_lifecycle.sql';
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql') && name < lifecycle).sort())
    run('psql',['-Xq','-h',sock,'-p','5432','-U','library_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(migrations,name)]);
  sql(`insert into recipe_private.accounts(id) values('${author}'),('${reader}'),('${stranger}');
    insert into recipe_private.recipes(id,owner_id,revision) values('${recipe}','${author}',52);
    insert into recipe_private.recipes(id,owner_id,revision) select gen_random_uuid(),'${author}',1 from generate_series(1,51);
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at)
      select id,owner_id,1,'{"name":"同名配方","summary":"简介","overview":"OVERVIEW MUST NOT LEAK","version":"v1","access":"coded"}',
        '{"role":"PRIVATE SOURCE"}',10,'2026-01-01T00:00:00Z' from recipe_private.recipes;
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at)
      select '${recipe}','${author}',n,jsonb_build_object('name','同名配方','summary','简介','overview','OVERVIEW MUST NOT LEAK','version','v'||n,'access',case when n=40 then 'direct' else 'coded' end),
        '{"role":"PRIVATE SOURCE"}',10,'2026-01-01T00:00:00Z' from generate_series(2,52) n;
    insert into recipe_private.grants(actor,version_id,original_request,original_digest)
      select '${reader}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where recipe_id='${recipe}' and revision in (1,3,50,51);
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
      values(gen_random_uuid(),'${author}',gen_random_uuid(),0,1,'{"name":"LOCAL DRAFT"}','{}',1);`);
  const packageId=randomUUID(),manifest=randomUUID();
  sql(`insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${packageId}','${author}',gen_random_uuid(),1024,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
      values('${manifest}','${packageId}',65,'manifest',1,repeat('a',64),1,1,repeat('a',64),false,'ready','gone','present');
    insert into recipe_private.rich_versions(id,manifest_id,state) select id,'${manifest}',case when revision=50 then 'banned' when revision=51 then 'withdrawn' else 'listed' end
      from recipe_private.versions where recipe_id='${recipe}' and revision>=50;`);
  function call(actor,fn,args){return JSON.parse(sql(`begin;set local role recipe_api;set local app.recipe_code_key='${'a'.repeat(64)}';${actor?`set local app.recipe_account='${actor}';`:''}select recipe_api.${fn}(${args.map(quoted).join(',')});commit;`));}
  const groups=(actor=author,scope='all',cursor=null)=>call(actor,'reader_recipe_groups',[scope,cursor]);
  const versions=(actor=author,scope='all',cursor=null,recipeId=recipe)=>call(actor,'reader_recipe_group_versions',[recipeId,scope,cursor]);
  const before=sql('select count(*) from recipe_private.grants');
  const first=groups(author,'published');
  assert.equal(first.items.length,50);assert.ok(first.nextCursor);
  assert.equal(first.items[0].recipeId,recipe);assert.equal(first.items[0].versionCount,51);assert.equal(first.items[0].revision,52);
  assert.equal(first.items[0].format,'rich-v2');assert.equal(first.items[0].owned,true);assert.equal(first.items[0].acquired,false);
  assert.ok(!JSON.stringify(first).includes('PRIVATE SOURCE'));assert.ok(!JSON.stringify(first).includes('OVERVIEW MUST NOT LEAK'));
  assert.ok(!JSON.stringify(first).includes('LOCAL DRAFT'));assert.ok(!JSON.stringify(first).includes('manifest'));
  // Publishing another version never moves the recipe across a group cursor.
  sql(`insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes) values('${recipe}','${author}',53,'{"name":"新名字","version":"v53","access":"coded"}','{}',1)`);
  // These rows model existing accounts above the new publication quota.
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql') && name >= lifecycle).sort())
    run('psql',['-Xq','-h',sock,'-p','5432','-U','library_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(migrations,name)]);
  // A historical label must not invalidate every card in a native catalog page.
  assert.equal(sql("select recipe_private.publication_display_info(jsonb_build_object('version',repeat('猫',41)))->>'version'"),'猫'.repeat(39)+'…');
  assert.equal(sql("select recipe_private.publication_display_info(jsonb_build_object('version',repeat('猫',40)))->>'version'"),'猫'.repeat(40));
  const second=groups(author,'published',first.nextCursor);
  assert.equal(second.items.length,2);assert.equal(second.nextCursor,null);
  const all=[...first.items,...second.items];assert.equal(new Set(all.map(x=>x.recipeId)).size,52);
  assert.deepEqual(all.map(x=>x.recipeId),all.map(x=>x.recipeId).sort().reverse());
  // Equal names remain separate recipes; latest and count only include exact grants.
  const acquired=groups(reader,'acquired');assert.equal(acquired.items.length,1);
  assert.equal(acquired.items[0].versionCount,3);assert.equal(acquired.items[0].revision,51);assert.equal(acquired.items[0].state,'withdrawn');
  assert.equal(acquired.items[0].owned,false);assert.equal(acquired.items[0].acquired,true);
  assert.deepEqual(groups(reader,'all').items,acquired.items);assert.equal(groups(reader,'published').items.length,0);
  assert.equal(groups(author,'acquired').items.length,0);assert.equal(groups(stranger).items.length,0);
  assert.deepEqual(versions(reader,'acquired').items.map(x=>x.revision),[51,3,1]);
  assert.throws(()=>versions(stranger),/not_found/);
  assert.throws(()=>versions(reader,'published'),/not_found/);
  assert.throws(()=>versions(reader,'acquired',null,randomUUID()),/not_found/);
  // Complete per-recipe version count, and independently paginated options.
  const ownVersions=versions(author,'published');assert.equal(ownVersions.items.length,50);assert.ok(ownVersions.nextCursor);
  assert.equal(ownVersions.items[0].revision,53);assert.ok(!ownVersions.items.some(x=>x.revision===50));
  const tail=versions(author,'published',ownVersions.nextCursor);assert.deepEqual(tail.items.map(x=>x.revision),[2,1]);assert.equal(tail.nextCursor,null);
  assert.equal(new Set([...ownVersions.items,...tail.items].map(x=>x.versionId)).size,52);
  sql(`insert into recipe_private.grants(actor,version_id,original_request,original_digest)
    select '${author}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where recipe_id='${recipe}' and revision=52`);
  assert.equal(groups(author,'all').items[0].versionCount,52);
  const both=groups(author,'acquired').items[0];assert.equal(both.versionCount,1);assert.equal(both.owned,true);assert.equal(both.acquired,true);
  sql(`delete from recipe_private.grants where actor='${author}'`);
  sql(`insert into recipe_private.creator_profiles(account_id,display_name) values('${author}','当前新昵称');`);
  assert.equal(groups(author,'published').items[0].creator.displayName,'当前新昵称');
  assert.equal(versions(reader,'acquired').items[0].creator.displayName,'当前新昵称');
  sql(`update recipe_private.creator_profiles set display_name='再次改昵称' where account_id='${author}';`);
  assert.equal(groups(reader,'acquired').items[0].creator.displayName,'再次改昵称');
  sql(`insert into recipe_private.rich_versions(id,manifest_id,state)
    select id,'${manifest}','banned' from recipe_private.versions where recipe_id='${recipe}' and revision=2`);
  assert.deepEqual(versions(author,'published',ownVersions.nextCursor).items.map(x=>x.revision),[1]);
  // Current permissions are re-evaluated even for a previously signed cursor.
  sql(`insert into recipe_private.grants(actor,version_id,original_request,original_digest)
    select '${reader}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where recipe_id='${recipe}' on conflict do nothing`);
  const grantedPage=versions(reader,'acquired');assert.ok(grantedPage.nextCursor);
  sql(`delete from recipe_private.grants where actor='${reader}' and version_id in
    (select id from recipe_private.versions where recipe_id='${recipe}' and revision in (1,2))`);
  assert.deepEqual(versions(reader,'acquired',grantedPage.nextCursor),{items:[],nextCursor:null});
  sql(`delete from recipe_private.grants where actor='${reader}';`);
  assert.throws(()=>versions(reader,'acquired',grantedPage.nextCursor),/not_found/);
  assert.equal(groups(reader,'acquired').items.length,0);
  // Restore original exact grants for the read-only assertion below.
  sql(`insert into recipe_private.grants(actor,version_id,original_request,original_digest)
    select '${reader}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where recipe_id='${recipe}' and revision in (1,3,50,51)`);
  for(const [actor,scope,cursor] of [[reader,'published',first.nextCursor],[author,'all',first.nextCursor],[author,'published',first.nextCursor.slice(0,-1)+(first.nextCursor.endsWith('0')?'1':'0')]])
    assert.throws(()=>groups(actor,scope,cursor),/invalid_input/);
  assert.throws(()=>versions(author,'published',ownVersions.nextCursor,all[1].recipeId),/invalid_input/);
  assert.throws(()=>versions(author,'all',ownVersions.nextCursor),/invalid_input/);
  assert.throws(()=>versions(reader,'published',ownVersions.nextCursor),/invalid_input/);
  assert.throws(()=>versions(author,'published',first.nextCursor),/invalid_input/);
  assert.throws(()=>groups(null),/auth_required/);assert.throws(()=>groups(author,'unknown'),/invalid_input/);
  assert.throws(()=>groups(author,'all','00.'+'a'.repeat(64)),/invalid_input/);
  assert.equal(sql('select count(*) from recipe_private.grants'),before);
  const closedId=sql(`select id from recipe_private.versions where recipe_id='${recipe}' and revision=51`);
  const close=(actor,fn,version)=>sql(`begin;set local role recipe_api;set local app.recipe_account='${actor}';select recipe_api.${fn}('${version}');commit;`);
  assert.throws(()=>close(reader,'delete_publication',closedId),/not_found/);
  for(const state of ['withdrawn','deleted']){
    if(state==='deleted')close(author,'delete_publication',closedId);
    const tombstone=call(reader,'browse_preview',[recipe,closedId]);
    assert.equal(tombstone.state,state);assert.equal(tombstone.acquired,true);
    assert.equal(tombstone.preview,undefined);assert.equal(tombstone.public.overview,'');
    assert.throws(()=>call(stranger,'browse_preview',[recipe,closedId]),/not_found/);
    assert.throws(()=>call(reader,'rich_install_preview',[closedId]),/forbidden/);
    assert.throws(()=>call(reader,'reader_acquire',[closedId,null,randomUUID()]),/forbidden/);
    assert.equal(versions(reader,'acquired').items.find(item=>item.versionId===closedId).state,state);
  }
  close(author,'delete_publication',closedId);
  const publishRecipe=randomUUID();
  sql(`insert into recipe_private.recipes(id,owner_id,revision) values('${publishRecipe}','${stranger}',11)`);
  const publish=n=>sql(`insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes)
    values('${publishRecipe}','${stranger}',${n},'{"name":"Quota","version":"v${n}","access":"direct"}','{}',1) returning id`);
  let oldest;
  for(let n=1;n<=10;n++){const id=publish(n);if(n===1)oldest=id;}
  assert.throws(()=>publish(11),/publication_limit/);
  close(stranger,'rich_withdraw',oldest);
  publish(11);
  assert.throws(()=>publish(12),/publication_limit/);
  close(stranger,'delete_publication',oldest);
  assert.throws(()=>publish(12),/publication_limit/);
  for(const role of ['anon','authenticated','recipe_object_verifier'])for(const signature of ['reader_recipe_groups(text,text)','reader_recipe_group_versions(uuid,text,text)'])
    assert.equal(sql(`select has_function_privilege('${role}','recipe_api.${signature}','execute')`),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_api.reader_recipe_groups(text,text)','execute')"),'t');
  console.log('PASS: permission-before-grouping, distinct same-name recipes, 52 recipes across pages, full version counts and option pagination, exact-grant latest, withdrawn retention, current banned/revoked-grant exclusion through old cursors, grant additions, dynamic nicknames, mixed generations, signed account/scope/recipe cursors, no content/draft leakage or grant writes.');
} finally {
  if(started)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
