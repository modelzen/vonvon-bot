import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const bin=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-receipt-migration-')),socket=join(dir,'s'),db=join(dir,'db');
const migrations=fileURLToPath(new URL('../../../supabase/migrations',import.meta.url));
const migration='20261115000300_recipe_publication_receipt_readers.sql',file=join(migrations,migration);
const source=readFileSync(file,'utf8');
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const psql=(actor,args)=>run('psql',['-h',socket,'-p','5432','-d','postgres','-U',actor,'-XAtq','-v','ON_ERROR_STOP=1',...args]);
const sql=(query,actor='receipt_admin')=>psql(actor,['-c',query]);
const apply=(path,actor='receipt_admin',before)=>psql(actor,['-1',...(before?['-c',before]:[]),'-f',path,'-c','select current_user=session_user']);
const snapshot=()=>JSON.parse(sql(`select jsonb_build_object(
  'memberships',(select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb) from pg_auth_members m),
  'functions',(select jsonb_agg(to_jsonb(p) order by oid) from pg_proc p
    where pronamespace in ('recipe_api'::regnamespace,'recipe_private'::regnamespace)))`));
const clean=()=>sql('drop function recipe_api.publication_receipt(text,uuid,uuid,int,text),recipe_api.code_issuance_receipt(uuid,uuid,int)');
const expectFailure=(path,actor,reason,before)=>assert.throws(()=>apply(path,actor,before),e=>reason.test(e.stderr??''));
const poisoned="select set_config('vonvon.recipe_m202611150003_actor','untrusted',true),set_config('vonvon.recipe_m202611150003_memberships','invalid json',true),set_config('vonvon.recipe_m202611150003_can_set','invalid boolean',true),set_config('vonvon.recipe_m202611150003_self_grant','invalid boolean',true)";
let started=false;
try{
  mkdirSync(socket,{mode:0o700});
  run('initdb',['-D',db,'-U','receipt_admin','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',"-k '"+socket+"' -c listen_addresses='' -c unix_socket_permissions=0700",'start']);started=true;
  for(const name of readdirSync(migrations).filter(f=>f.endsWith('.sql')&&f<migration).sort())apply(join(migrations,name));
  sql('create role receipt_member login noinherit; create role receipt_grantor login createrole noinherit; '+
    'create role receipt_temporary login createrole noinherit; create role receipt_denied login noinherit; '+
    'create role receipt_unexpected; grant recipe_owner to receipt_grantor with admin option; revoke recipe_owner from receipt_admin');
  sql('grant recipe_owner to receipt_member with admin option','receipt_grantor');
  const injected=join(dir,'injected-error.sql');
  writeFileSync(injected,source.replace('\nreset role;','\nselect 1/0;\nreset role;'));
  const before=snapshot();
  expectFailure(injected,'receipt_admin',/division by zero/);assert.deepEqual(snapshot(),before);
  assert.match(apply(file,'receipt_admin',poisoned),/t$/);
  assert.deepEqual(snapshot().memberships,before.memberships);
  assert.equal(snapshot().functions.length,before.functions.length+2);
  clean();assert.deepEqual(snapshot(),before);
  console.log('PASS: reader DDL rolls back on failure, restores role, ignores poisoned GUCs and creates only two functions without changing prior catalogs.');

  const member=snapshot();
  assert.match(apply(file,'receipt_member',poisoned),/t$/);clean();assert.deepEqual(snapshot(),member);
  expectFailure(file,'receipt_member',/migration_role_session_changed/,'set local role recipe_owner');assert.deepEqual(snapshot(),member);
  expectFailure(file,'receipt_denied',/permission denied|must have admin option/);assert.deepEqual(snapshot(),member);
  console.log('PASS: existing membership grantor/options persist, preselected role and unprivileged deployer fail before DDL.');

  const version=Number(sql('show server_version_num'));
  if(version>=160000){
    sql('grant recipe_owner to receipt_temporary with admin option; grant recipe_owner to receipt_temporary with set false; grant recipe_owner to receipt_temporary with inherit false','receipt_grantor');
  }
  const temporary=snapshot();
  expectFailure(injected,'receipt_temporary',/division by zero/);assert.deepEqual(snapshot(),temporary);
  assert.match(apply(file,'receipt_temporary',poisoned),/t$/);clean();assert.deepEqual(snapshot(),temporary);
  if(version>=160000){
    sql('grant recipe_owner to receipt_temporary with set false','receipt_temporary');
    const blocked=snapshot();expectFailure(file,'receipt_temporary',/migration_role_set_disabled/);assert.deepEqual(snapshot(),blocked);
  }
  const changed=join(dir,'injected-membership.sql');
  writeFileSync(changed,source.replace('\nreset role;','\nreset role;\ngrant recipe_api to receipt_unexpected;\nset local role recipe_owner;\nreset role;'));
  const guarded=snapshot();expectFailure(changed,'receipt_admin',/migration_role_memberships_changed/);assert.deepEqual(snapshot(),guarded);
  console.log('PASS: PostgreSQL '+Math.floor(version/10000)+' temporary self-grant, rollback'+(version>=160000?', disabled SET membership':'')+', and complete graph-change guard preserve the authority envelope.');
}finally{
  if(started)run('pg_ctl',['-D',db,'-m','fast','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
