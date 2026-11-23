import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const bindir=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-account-profile-')),db=join(dir,'db'),sock=join(dir,'s');
const run=(name,args)=>execFileSync(join(bindir,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=value=>run('psql',['-XAtq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',value]).trim();
const asyncSql=value=>new Promise((resolve,reject)=>execFile(join(bindir,'psql'),['-XAtq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',value],{encoding:'utf8',timeout:15000},(error,stdout,stderr)=>error?reject(new Error(stderr)):resolve(stdout.trim())));
const account=randomUUID(),other=randomUUID(),avatar='data:image/webp;base64,YWJj';
const call=(expression,actor=account)=>sql(`begin; set local role recipe_api; set local app.recipe_account='${actor}'; select ${expression}; commit;`);
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const profile=(actor=account)=>JSON.parse(call('recipe_api.rich_account_profile_read()',actor));
const initialized=(actor,name)=>JSON.parse(call(`recipe_api.rich_account_profile_initialize(${quote(name)})`,actor));
let started=false;
try {
  mkdirSync(sock,{mode:0o700});
  run('initdb',['-D',db,'-U','profile_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',`-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);started=true;
  sql('create role anon; create role authenticated');
  const migrations=join(root,'supabase/migrations');
  for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()) {
    if(name==='20261116000100_recipe_account_profile.sql') {
      sql("insert into recipe_private.accounts(id) values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003')");
      sql("insert into recipe_private.creator_profiles(account_id,display_name) values('00000000-0000-4000-8000-000000000001','Creator'),('00000000-0000-4000-8000-000000000002','ＣＲＥＡＴＯＲ'),('00000000-0000-4000-8000-000000000003','creator')");
    }
    run('psql',['-Xq','-h',sock,'-p','5432','-U','profile_test','-d','postgres','-v','ON_ERROR_STOP=1','-1','-f',join(migrations,name)]);
  }
  assert.equal(sql("select display_name from recipe_private.creator_profiles where account_id='00000000-0000-4000-8000-000000000001'"),'Creator');
  assert.equal(sql('select count(*)=count(distinct nickname_key) from recipe_private.creator_profiles'),'t');
  assert.equal(sql('select count(*) from recipe_private.creator_profiles'),'3');
  sql(`insert into recipe_private.accounts(id) values('${account}'),('${other}')`);
  assert.deepEqual(profile(),{authorId:account,displayName:'Vonvon 用户-'+account.replaceAll('-',''),revision:0});
  assert.notEqual(profile().displayName,profile(other).displayName);
  const save=(name,kind,data,revision)=>JSON.parse(call(`recipe_api.rich_account_profile('${name}','${kind}',${data===null?'null':"'"+data+"'"},${revision})`));
  assert.deepEqual(save('公开昵称','replace',avatar,0),{authorId:account,displayName:'公开昵称',revision:1,avatarDataUrl:avatar});
  assert.equal(save('新昵称','keep',null,1).avatarDataUrl,avatar);
  assert.throws(()=>save('迟到的旧资料','remove',null,1),/conflict/);
  assert.deepEqual(JSON.parse(call('recipe_api.rich_account_profile_read()')),{authorId:account,displayName:'新昵称',revision:2,avatarDataUrl:avatar});
  const legacy=JSON.parse(call("recipe_api.rich_profile('旧版保存昵称')"));
  assert.deepEqual(legacy,{authorId:account,displayName:'旧版保存昵称'});
  assert.deepEqual(JSON.parse(call('recipe_api.rich_profile_read()')),{authorId:account,displayName:'旧版保存昵称'});
  assert.equal(JSON.parse(call('recipe_api.rich_account_profile_read()')).avatarDataUrl,avatar);
  assert.equal(JSON.parse(call('recipe_api.rich_account_profile_read()')).revision,3);
  assert.deepEqual(save('恢复默认','remove',null,3),{authorId:account,displayName:'恢复默认',revision:4});
  const publicBefore=JSON.parse(sql(`select recipe_private.public_creator('${account}')`));
  assert.equal(publicBefore.displayName,'恢复默认');
  const beforeInitialize=profile();
  assert.deepEqual(initialized(account,'不得覆盖已有账号昵称'),beforeInitialize);
  const peer=initialized(other,'恢复默认');
  assert.notEqual(peer.displayName,'恢复默认');
  assert.match(peer.displayName,new RegExp('^恢复默认-'+other.slice(0,8)));
  assert.equal(peer.authorId,other);assert.equal(peer.revision,1);
  assert.deepEqual(initialized(other,'另一个推荐名字'),peer);
  for(const taken of ['ＣＲＥＡＴＯＲ','creator','Creator\u200d']) {
    assert.throws(()=>call(`recipe_api.rich_account_profile(${quote(taken)},'keep',null,4)`),/nickname_taken/);
    assert.deepEqual(profile(),beforeInitialize);
  }
  assert.throws(()=>call(`recipe_api.rich_account_profile(${quote('Vonvon 用户-'+other.replaceAll('-',''))},'keep',null,4)`),/nickname_taken/);
  assert.throws(()=>call(`recipe_api.rich_account_profile(${quote('crea\u202etor')},'keep',null,4)`),/invalid_input/);
  const renamed=save('  新  昵称  👩‍💻  ','keep',null,4);
  assert.equal(renamed.displayName,'新 昵称 👩‍💻');
  assert.equal(JSON.parse(sql(`select recipe_private.public_creator('${account}')`)).displayName,renamed.displayName);
  assert.equal(renamed.authorId,publicBefore.authorId);
  assert.equal(sql(`select recipe_private.account_nickname_key('Ｆｏｏ　　Ｂａｒ')=recipe_private.account_nickname_key(' foo bar ')`),'t');
  assert.equal(sql(`select recipe_private.account_nickname_key('Älpha')=recipe_private.account_nickname_key('älpha')`),'t');
  for(const name of ['Creator \u200d','Creator\ufe0f','Creator \u200d  '])
    assert.throws(()=>call(`recipe_api.rich_account_profile(${quote(name)},'keep',null,5)`),/nickname_taken/);
  for(const name of ['\u115f','\u1160','\u3164','\uffa0','a\u3164b','a\u{1bca0}b'])
    assert.throws(()=>call(`recipe_api.rich_account_profile(${quote(name)},'keep',null,5)`),/invalid_input/);
  const reservedInitializer=randomUUID();sql(`insert into recipe_private.accounts(id) values('${reservedInitializer}')`);
  const ownDefault=initialized(reservedInitializer,'Vonvon 用户-'+other.replaceAll('-',''));
  assert.equal(ownDefault.displayName,'Vonvon 用户-'+reservedInitializer.replaceAll('-',''));
  const racers=[randomUUID(),randomUUID()];
  sql(`insert into recipe_private.accounts(id) values('${racers[0]}'),('${racers[1]}')`);
  const outcomes=await Promise.allSettled(racers.map(actor=>asyncSql(`begin;set local role recipe_api;set local app.recipe_account='${actor}';select recipe_api.rich_account_profile('并发昵称','keep',null,0);select pg_sleep(0.1);commit;`)));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  const rejected=outcomes.find(result=>result.status==='rejected');
  assert.match(rejected.reason.message,/nickname_taken/);
  assert.equal(sql("select count(*) from recipe_private.creator_profiles where display_name='并发昵称'"),'1');
  const initializing=randomUUID();sql(`insert into recipe_private.accounts(id) values('${initializing}')`);
  const sameAccount=await Promise.all(['竞速初始化甲','竞速初始化乙'].map(name=>asyncSql(`begin;set local role recipe_api;set local app.recipe_account='${initializing}';select recipe_api.rich_account_profile_initialize('${name}');commit;`)));
  assert.equal(JSON.parse(sameAccount[0]).authorId,initializing);assert.equal(sameAccount[0],sameAccount[1]);
  assert.equal(JSON.parse(sameAccount[0]).revision,1);
  assert.equal(JSON.parse(call('recipe_api.me()')).accountId,account);
  assert.equal(sql(`select count(*) from recipe_private.creator_profiles where account_id='${other}'`),'1');
  for(const role of ['anon','authenticated','recipe_object_verifier'])assert.equal(sql(`select has_function_privilege('${role}','recipe_api.rich_account_profile(text,text,text,integer)','execute')`),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_api.rich_account_profile(text,text,text,integer)','execute')"),'t');
  assert.throws(()=>sql('set role recipe_api;select recipe_api.rich_profile_read()'),/auth_required/);
  console.log('PASS: profile migration, deterministic duplicate repair, Unicode nickname uniqueness, concurrent conflicts, idempotent initialization, legacy compatibility, live creator names, avatar/CAS/ACL and stable IDs.');
} finally {
  if(started)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
