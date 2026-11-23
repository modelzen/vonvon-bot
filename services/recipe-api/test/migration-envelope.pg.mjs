import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const bin=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-migration-envelope-')),socket=join(dir,'socket'),db=join(dir,'db');
const migrations=fileURLToPath(new URL('../../../supabase/migrations',import.meta.url));
const migration='20261114001400_recipe_authoring_package_lifetime.sql',file=join(migrations,migration);
const source=readFileSync(file,'utf8');
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const psql=(actor,args)=>run('psql',['-h',socket,'-p','5432','-d','postgres','-U',actor,'-XAtq','-v','ON_ERROR_STOP=1',...args]);
const sql=(query,actor='envelope_admin')=>psql(actor,['-c',query]);
const apply=(path,actor='envelope_admin',before)=>psql(actor,['-1',...(before?['-c',before]:[]),'-f',path,
  '-c',"select current_user=session_user"]);
const snapshot=()=>JSON.parse(sql(`select jsonb_build_object(
  'memberships',(select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb) from pg_catalog.pg_auth_members m),
  'function',(select jsonb_build_object('body',prosrc,'owner',proowner,'acl',proacl) from pg_proc
    where oid='recipe_api.reserve_object_package(uuid,uuid,integer)'::regprocedure))`));
const canSet=actor=>sql("select pg_has_role(session_user,'recipe_owner','"+(version>=160000?'SET':'MEMBER')+"')",actor)==='t';
const directMember=actor=>sql("select exists(select from pg_catalog.pg_auth_members where roleid='recipe_owner'::regrole and member='"+actor+"'::regrole)")==='t';
const poisoned=`do $$ begin
  perform set_config('vonvon.recipe_m014_actor','untrusted_caller_value',true);
  perform set_config('vonvon.recipe_m014_memberships','invalid json',true);
  perform set_config('vonvon.recipe_m014_can_set','invalid boolean',true);
  perform set_config('vonvon.recipe_m014_self_grant','invalid boolean',true);
end $$;`;
const expectFailure=(path,actor,reason,before)=>assert.throws(()=>apply(path,actor,before),
  e=>reason instanceof RegExp?reason.test(e.stderr??''):e.stderr?.includes(reason));
let started=false,version;
try {
  mkdirSync(socket,{mode:0o700});
  run('initdb',['-D',db,'-U','envelope_admin','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',
    "-k '"+socket+"' -c listen_addresses='' -c unix_socket_permissions=0700",'start']);
  started=true;version=Number(sql("show server_version_num"));
  for(const name of readdirSync(migrations).filter(f=>f.endsWith('.sql')&&f<migration).sort())
    psql('envelope_admin',['-1','-f',join(migrations,name)]);
  sql('create role member_deployer login noinherit; create role original_grantor login createrole noinherit; '+
    'create role temporary_deployer login createrole noinherit; create role denied_deployer login noinherit; '+
    'create role unexpected_member; grant recipe_owner to original_grantor with admin option; '+
    'revoke recipe_owner from envelope_admin');
  sql('grant recipe_owner to member_deployer with admin option','original_grantor');
  const businessBody=source.match(/language plpgsql security definer set search_path = pg_catalog,pg_temp as \$\$([\s\S]*?)\$\$;/)?.[1];
  assert.ok(businessBody);
  const injected=join(dir,'injected-error.sql');
  writeFileSync(injected,source.replace('\nreset role;','\nselect 1/0;\nreset role;'));
  const before=snapshot();
  expectFailure(injected,'envelope_admin','division by zero');
  assert.deepEqual(snapshot(),before,'failed DDL must roll back the entire original SQL transaction');
  assert.equal(directMember('envelope_admin'),false);assert.equal(canSet('envelope_admin'),true);
  assert.equal(apply(file,'envelope_admin',poisoned),'t');
  const elevated=snapshot();
  assert.deepEqual(elevated.memberships,before.memberships,'superusers must not acquire persistent membership');
  assert.equal(elevated.function.body,businessBody);
  assert.equal(elevated.function.owner,before.function.owner);assert.deepEqual(elevated.function.acl,before.function.acl);
  console.log('PASS: raw psql -1 -f restores role, ignores caller GUCs, preserves full membership/ACL and rolls back DDL on error');

  assert.equal(canSet('member_deployer'),true);
  assert.equal(directMember('member_deployer'),true);
  const memberBefore=snapshot();
  const memberEdge=memberBefore.memberships.find(m=>Number(m.member)===Number(sql("select 'member_deployer'::regrole::oid")));
  assert.equal(memberEdge.admin_option,true);
  assert.equal(Number(memberEdge.grantor),Number(sql("select 'original_grantor'::regrole::oid")));
  assert.equal(apply(file,'member_deployer',poisoned),'t');
  assert.deepEqual(snapshot(),memberBefore,'existing grantor and every membership option must remain byte-equivalent');
  expectFailure(file,'member_deployer','migration_role_session_changed','set local role recipe_owner');
  assert.deepEqual(snapshot(),memberBefore,'a preselected effective role must fail before any grant');
  console.log('PASS: existing SET-capable NOINHERIT membership keeps original grantor and ADMIN/INHERIT/SET options');

  if(version<160000) {
    assert.equal(canSet('temporary_deployer'),false);assert.equal(directMember('temporary_deployer'),false);
    const temporaryBefore=snapshot();
    expectFailure(injected,'temporary_deployer','division by zero');
    assert.deepEqual(snapshot(),temporaryBefore,'temporary membership must roll back even if cleanup is not reached');
    assert.equal(apply(file,'temporary_deployer',poisoned),'t');
    assert.deepEqual(snapshot(),temporaryBefore,'only newly granted temporary membership may be revoked');
    assert.equal(directMember('temporary_deployer'),false);assert.equal(canSet('temporary_deployer'),false);
    console.log('PASS: PostgreSQL 15 CREATEROLE temporary elevation leaves no membership after success or injected failure');
    console.log('SKIP: PostgreSQL 16+ SET FALSE membership branch requires that server version; local server is '+version);
  } else {
    sql('create role blocked_deployer login noinherit; create role self_blocked_deployer login noinherit; '+
      'grant recipe_owner to blocked_deployer with admin option; '+
      'grant recipe_owner to blocked_deployer with set false; grant recipe_owner to blocked_deployer with inherit false');
    assert.equal(directMember('blocked_deployer'),true);assert.equal(canSet('blocked_deployer'),false);
    const blockedBefore=snapshot();
    expectFailure(injected,'blocked_deployer','division by zero');
    assert.deepEqual(snapshot(),blockedBefore,'temporary self-grant must roll back while keeping other grantor membership');
    assert.equal(apply(file,'blocked_deployer',poisoned),'t');
    assert.deepEqual(snapshot(),blockedBefore,'other grantor SET FALSE membership must survive temporary self-grant exactly');
    assert.equal(canSet('blocked_deployer'),false);
    sql('grant recipe_owner to self_blocked_deployer with admin option; '+
      'grant recipe_owner to self_blocked_deployer with set false; grant recipe_owner to self_blocked_deployer with inherit false');
    sql('grant recipe_owner to self_blocked_deployer with set false','self_blocked_deployer');
    assert.equal(canSet('self_blocked_deployer'),false);
    const selfBefore=snapshot();
    expectFailure(file,'self_blocked_deployer','migration_role_set_disabled');
    assert.deepEqual(snapshot(),selfBefore,'existing self-granted SET FALSE membership must fail without rewriting options');
    console.log('PASS: PostgreSQL 16+ other-grantor SET FALSE membership is preserved and existing self-grant fails closed');
  }
  const deniedBefore=snapshot();
  expectFailure(file,'denied_deployer',/permission denied|must have admin option/);
  assert.deepEqual(snapshot(),deniedBefore,'unprivileged callers must fail without a membership change');
  const changed=join(dir,'injected-membership.sql');
  writeFileSync(changed,source.replace('\nreset role;',
    '\nreset role;\ngrant recipe_api to unexpected_member;\nset local role recipe_owner;\nreset role;'));
  expectFailure(changed,'envelope_admin','migration_role_memberships_changed');
  assert.deepEqual(snapshot(),deniedBefore,'unexpected graph changes must abort the complete migration transaction');
  console.log('PASS: insufficient authority and unexpected complete-membership snapshot changes fail closed');
} finally {
  if(started) run('pg_ctl',['-D',db,'-m','fast','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
