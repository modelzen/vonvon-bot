import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const bindir=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-catalog-author-search-')),db=join(dir,'db'),sock=join(dir,'s');
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
  const target='20261116000400_recipe_catalog_author_search.sql';
  const apply=name=>run('psql',['-Xq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(migrations,name)]);
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')&&name<target).sort())apply(name);
  sql(`insert into recipe_private.accounts(id) values('${account}'),('${other}');
    insert into recipe_private.recipes(id,owner_id,revision) select gen_random_uuid(),'${account}',1 from generate_series(1,19);
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at)
      select id,owner_id,1,'{"name":"Public recipe","summary":"Summary","version":"v1","access":"coded"}','{"role":"PRIVATE SOURCE"}',10,'2020-11-16T00:00:00Z' from recipe_private.recipes;
    insert into recipe_private.recipes(id,owner_id,revision) values('${other}','${other}',1);
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes) values('${other}','${other}',1,'{"name":"Other recipe","version":"v1","access":"direct"}','{}',1);
    insert into recipe_private.grants(actor,version_id,original_request,original_digest) select '${account}',id,gen_random_uuid(),decode('ab','hex') from recipe_private.versions where owner_id='${other}';`);
  const fallback=sql(`select recipe_private.account_default_nickname('${account}')`);
  const quote=value=>value===null?'null':"'"+value.replaceAll("'","''")+"'";
  const page=(q,cursor=null)=>JSON.parse(sql(`begin;set local role recipe_api;set local app.recipe_account='${account}';set local app.recipe_code_key='${'ab'.repeat(32)}';select recipe_api.reader_catalog_page(${quote(q)},${quote(cursor)},null);commit;`));
  assert.equal(page(fallback).items.length,0,'prior catalog misses no-profile default nickname');
  sql('grant recipe_owner to profile_test');
  const memberships=()=>sql("select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb) from pg_catalog.pg_auth_members m");
  const definition=()=>sql("select pg_get_functiondef('recipe_api.rich_catalog_page(text,text,text)'::regprocedure)");
  const acl=()=>sql("select proacl::text from pg_proc where oid='recipe_api.rich_catalog_page(text,text,text)'::regprocedure");
  const beforeMembers=memberships(),beforeDefinition=definition(),beforeAcl=acl();
  apply(target);
  assert.equal(memberships(),beforeMembers);assert.equal(acl(),beforeAcl);
  assert.equal(definition(),beforeDefinition.replace('lower(cp.display_name)','lower(coalesce(cp.display_name,recipe_private.account_default_nickname(v.owner_id)))'));
  const all=q=>{
    let cursor=null,items=[],pages=0;
    do{const current=page(q,cursor);assert.equal(current.hero,null);assert.ok(current.items.length<=8);items.push(...current.items);cursor=current.nextCursor;assert.ok(++pages<=5);}while(cursor);
    assert.equal(new Set(items.map(x=>x.recipeId)).size,items.length);return items;
  };
  assert.equal(all(fallback).length,19);
  assert.equal(all(fallback.toUpperCase().slice(-24)).length,19);
  const first=page(fallback);assert.ok(first.nextCursor);
  assert.throws(()=>page('different',first.nextCursor),/invalid_input/);
  assert.throws(()=>page(fallback,first.nextCursor.slice(0,-1)+(first.nextCursor.endsWith('a')?'b':'a')),/invalid_input/);
  sql(`insert into recipe_private.creator_profiles(account_id,display_name) values('${account}','NickNameAlpha')`);
  assert.equal(all(fallback).length,0);assert.equal(all('nicknamealpha').length,19);assert.equal(all('NAMEALP').length,19);
  const oldest=all('nicknamealpha')[0];
  sql(`update recipe_private.recipes set revision=2 where id='${oldest.recipeId}';
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes,published_at) values('${oldest.recipeId}','${account}',2,'{"name":"Public latest","summary":"Summary","version":"v2","access":"direct"}','{"role":"PRIVATE SOURCE"}',1,'2020-11-17T00:00:00Z')`);
  const packageId=randomUUID(),manifest=randomUUID();
  sql(`insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${packageId}','${account}',gen_random_uuid(),1024,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
      values('${manifest}','${packageId}',65,'manifest',1,repeat('a',64),1,1,repeat('a',64),false,'ready','gone','present');
    insert into recipe_private.rich_versions(id,manifest_id,state) select id,'${manifest}','listed' from recipe_private.versions where recipe_id='${oldest.recipeId}' and revision=2;`);
  assert.equal(all('nicknamealpha').length,19);assert.equal(all('nicknamealpha')[0].revision,2);
  for(const state of ['withdrawn','banned']){
    sql(`update recipe_private.rich_versions set state='${state}' where manifest_id='${manifest}'`);
    const items=all('nicknamealpha');assert.equal(items.length,18);assert.ok(items.every(x=>x.recipeId!==oldest.recipeId));
  }
  sql(`update recipe_private.creator_profiles set display_name='ChangedHandle' where account_id='${account}'`);
  assert.equal(all('nicknamealpha').length,0);
  const items=all('changedhandle');assert.equal(items.length,18);assert.ok(items.every(x=>x.creator.authorId===account&&x.creator.displayName==='ChangedHandle'));
  assert.ok(!JSON.stringify(items).includes('PRIVATE SOURCE'));assert.ok(items.every(x=>x.recipeId!==other));
  console.log('PASS: default/current nickname exact and partial case-insensitive search; all signed cursor pages; latest/listed visibility; no acquisition/source leak; unchanged function except predicate, ACL and pre-existing memberships.');
} finally {
  if(started)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
