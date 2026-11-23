import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const bindir=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-author-pages-')),db=join(dir,'db'),sock=join(dir,'s');
const run=(name,args)=>execFileSync(join(bindir,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=value=>run('psql',['-XAtq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',value]).trim();
const account=randomUUID(),other=randomUUID();
let started=false;
try {
  mkdirSync(sock,{mode:0o700});
  run('initdb',['-D',db,'-U','profile_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',`-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);started=true;
  sql('create role anon; create role authenticated');
  const migrations=join(root,'supabase/migrations');
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort())
    run('psql',['-Xq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(migrations,name)]);
  sql(`insert into recipe_private.accounts(id) values('${account}'),('${other}')`);
  const read=(who=account,cursor=null)=>JSON.parse(sql(`set role recipe_api; select recipe_api.reader_author_recipes('${who}',${cursor?"'"+cursor+"'":'null'}); reset role;`));
  assert.throws(()=>read(),/not_found/);
  sql(`insert into recipe_private.creator_profiles(account_id,display_name) values('${account}','公开昵称');
    insert into recipe_private.recipes(id,owner_id,revision) select gen_random_uuid(),'${account}',1 from generate_series(1,52);
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at)
      select id,owner_id,1,'{"name":"公开配方","summary":"简介","version":"v1","access":"direct"}','{"role":"PRIVATE SOURCE"}',10,'2026-11-16T00:00:00Z' from recipe_private.recipes;
    insert into recipe_private.recipes(id,owner_id,revision) values('${other}','${other}',1);
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes) values('${other}','${other}',1,'{"name":"其他作者","version":"v1","access":"coded"}','{}',1);
    insert into recipe_private.grants(actor,version_id,original_request,original_digest) select '${account}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where owner_id='${other}';`);
  let first=read();
  assert.deepEqual(first.creator,{authorId:account,displayName:'公开昵称'});
  assert.equal(first.items.length,50);assert.ok(first.nextCursor);
  const second=read(account,first.nextCursor);assert.equal(second.items.length,2);assert.equal(second.nextCursor,null);
  const all=[...first.items,...second.items];assert.equal(new Set(all.map(x=>x.recipeId)).size,52);
  assert.deepEqual(all.map(x=>x.versionId),[...all.map(x=>x.versionId)].sort().reverse());
  assert.ok(all.every(x=>x.creator.authorId===account&&x.format==='role-v1'));
  assert.ok(!JSON.stringify(first).includes('PRIVATE SOURCE'));
  const old=all[0];
  const detail=(recipe,version,actor=null)=>JSON.parse(sql(`begin;set local role recipe_api;${actor?"set local app.recipe_account='"+actor+"';":''} select recipe_api.version_detail('${recipe}','${version}');commit;`));
  const checkDetail=(item,actor=null)=>{
    const result=detail(item.recipeId,item.versionId,actor);
    const prior=JSON.parse(sql(`begin;${actor?"set local app.recipe_account='"+actor+"';":''} select recipe_private.detail_role_generation('${item.recipeId}','${item.versionId}');commit;`));
    assert.deepEqual(result.creator,{authorId:item.creator.authorId,displayName:item.creator.displayName});
    const {creator,...unchanged}=result;assert.deepEqual(unchanged,prior);
    return result;
  };
  assert.deepEqual(checkDetail(old).config,{role:'PRIVATE SOURCE'});
  const coded=read(other).items[0];
  assert.equal(checkDetail(coded).config,undefined);
  assert.equal(checkDetail(coded,other).owned,true);
  assert.equal(checkDetail(coded,account).acquired,true);
  assert.throws(()=>detail(old.recipeId,coded.versionId),/not_found/);

  sql(`insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at) values('${old.recipeId}','${account}',2,'{"name":"新版","version":"v2","access":"direct"}','{}',1,'2026-11-17T00:00:00Z')`);
  first=read();assert.equal(first.items[0].revision,2);assert.equal(first.items.filter(x=>x.recipeId===old.recipeId).length,1);
  const packageId=randomUUID(),manifest=randomUUID();
  sql(`insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${packageId}','${account}',gen_random_uuid(),1024,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
      values('${manifest}','${packageId}',65,'manifest',1,repeat('a',64),1,1,repeat('a',64),false,'ready','gone','present');
    insert into recipe_private.rich_versions(id,manifest_id,state) select id,'${manifest}','listed' from recipe_private.versions where recipe_id='${old.recipeId}' and revision=2;`);
  assert.equal(read().items[0].format,'rich-v2');
  const rich=read().items[0];assert.throws(()=>detail(rich.recipeId,rich.versionId),/request_upgrade_required/);
  for(const state of ['withdrawn','banned']){
    sql(`update recipe_private.rich_versions set state='${state}' where manifest_id='${manifest}'`);
    const page=read();assert.ok(page.items.every(x=>x.revision===1));
    assert.equal(page.items.find(x=>x.recipeId===old.recipeId)?.versionId,old.versionId);
  }
  assert.throws(()=>read(account,read(other).items[0].versionId),/invalid_input/);
  assert.throws(()=>read(account,randomUUID()),/invalid_input/);
  assert.throws(()=>read(randomUUID()),/not_found/);
  sql(`insert into recipe_private.rich_versions(id,manifest_id,state) select id,'${manifest}','withdrawn' from recipe_private.versions where owner_id='${other}'`);
  assert.throws(()=>read(other),/not_found/);
  for(const role of ['anon','authenticated','recipe_object_verifier'])assert.equal(sql(`select has_function_privilege('${role}','recipe_api.reader_author_recipes(uuid,uuid)','execute')`),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_api.reader_author_recipes(uuid,uuid)','execute')"),'t');
  console.log('PASS: anonymous author pages, legacy/rich visibility, latest listed revision, 50-item stable tie pagination, no acquisition/source leak, unknown author and cross-author cursor rejection, minimum grants; legacy detail creator preserves original entitlement/config projection.');
} finally {
  if(started)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
