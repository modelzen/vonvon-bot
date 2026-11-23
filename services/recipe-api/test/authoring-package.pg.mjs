import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';

const bin=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir=mkdtempSync(join(tmpdir(),'vv-authoring-package-')),socket=join(dir,'socket'),db=join(dir,'db');
const migrations=fileURLToPath(new URL('../../../supabase/migrations',import.meta.url));
const migration='20261114001400_recipe_authoring_package_lifetime.sql';
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const apply=name=>run('psql',['-h',socket,'-p','5432','-d','postgres','-U','package_test','-Xq','-1',
  '-v','ON_ERROR_STOP=1','-f',join(migrations,name)]);
const operationId=(born=Date.now())=>{
  const b=randomBytes(16);b.writeUIntBE(born,0,6);b[6]=(b[6]&15)|112;b[8]=(b[8]&63)|128;
  const h=b.toString('hex');return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
};
const expect=(promise,reason)=>assert.rejects(promise,e=>e.message===reason);
const hour=60*60*1000;
let started=false,admin,api,verifier;
try {
  mkdirSync(socket,{mode:0o700});
  run('initdb',['-D',db,'-U','package_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',
    "-k '"+socket+"' -c listen_addresses='' -c unix_socket_permissions=0700",'start']);
  started=true;
  const files=readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort();
  const migrationIndex=files.indexOf(migration);
  assert.ok(migrationIndex>=0,'test must include the incremental migration');
  files.slice(0,migrationIndex).forEach(apply);
  const pool=user=>new pg.Pool({host:socket,port:5432,user,database:'postgres',max:4,connectionTimeoutMillis:3000});
  admin=pool('package_test');
  await admin.query('create role api_login login noinherit; grant recipe_api to api_login; '+
    'create role verifier_login login noinherit; grant recipe_object_verifier to verifier_login');
  api=pool('api_login');verifier=pool('verifier_login');
  const account=async(id=randomUUID())=>{
    await admin.query('insert into recipe_private.accounts(id) values($1) on conflict do nothing',[id]);return id;
  };
  async function roleCall(pool,role,actor,sql,args) {
    const c=await pool.connect();
    try {
      await c.query('begin');await c.query('set local role '+role);
      if(actor) await c.query("select set_config('app.recipe_account',$1,true)",[actor]);
      const {rows}=await c.query(sql,args);await c.query('commit');return rows[0]?.result;
    } catch(e) {await c.query('rollback');throw e;} finally {c.release();}
  }
  const reserve=(intent,{actor=intent.actor,draft=intent.draft,cap=1024}={})=>
    roleCall(api,'recipe_api',actor,'select recipe_api.reserve_object_package($1,$2,$3) as result',[intent.id,draft,cap]);
  const seedIntent=async({age=hour,state='dispatched',purpose='prepareDraft',rich=true,
    actor,richActor,draft=randomUUID(),expires}={})=>{
    actor??=await account();richActor??=actor;
    const born=Date.now()-age,id=operationId(born),terminal=['accepted','cancelled','expired'].includes(state);
    await account(richActor);
    if(purpose==='editDraft') await admin.query('insert into recipe_private.drafts '+
      '(id,owner_id,recipe_id,revision,base_revision,public_info,config,bytes) values($1,$2,$3,1,0,\'{}\',\'{}\',0)',
      [draft,actor,randomUUID()]);
    await admin.query('insert into recipe_private.authoring_operations '+
      '(id,account_id,purpose,target_key,nonce_commitment,draft_id,base_revision,state,created_at,expires_at,terminal_at,receipt) '+
      'values($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id,actor,purpose,Buffer.alloc(32).toString('base64url'),purpose==='editDraft'?draft:null,
        purpose==='editDraft'?1:null,state,new Date(born),new Date(expires??born+24*hour),
        terminal?new Date():null,state==='accepted'?{}:null]);
    if(rich) await admin.query('insert into recipe_private.rich_intents(id,account_id,draft_id) values($1,$2,$3)',
      [id,richActor,draft]);
    return {id,actor,draft};
  };
  const packageRow=async id=>(await admin.query('select * from recipe_private.object_packages where id=$1',[id])).rows[0];
  const rejectNew=async(intent,reason,options)=>{
    await expect(reserve(intent,options),reason);assert.equal(await packageRow(intent.id),undefined);
  };

  const prepared=await seedIntent();
  await rejectNew(prepared,'operation_expired');
  const oldAcl=(await admin.query("select proacl from pg_proc where oid='recipe_api.reserve_object_package(uuid,uuid,integer)'::regprocedure")).rows[0].proacl;
  files.slice(migrationIndex).forEach(apply);
  assert.deepEqual((await admin.query("select proacl from pg_proc where oid='recipe_api.reserve_object_package(uuid,uuid,integer)'::regprocedure")).rows[0].proacl,oldAcl);
  for(const role of ['api_login','recipe_api','recipe_object_verifier']) {
    const {rows:[priv]}=await admin.query("select has_table_privilege($1,'recipe_private.rich_intents','select') as private_read, "+
      "has_function_privilege($1,'recipe_api.reserve_object_package(uuid,uuid,integer)','execute') as reserve",[role]);
    assert.equal(priv.private_read,false);assert.equal(priv.reserve,role==='recipe_api');
  }
  const before=Date.now();
  const reservations=await Promise.all([reserve(prepared),reserve(prepared)]);
  assert.deepEqual(reservations[0],reservations[1]);
  assert.equal(reservations[0].draftId,prepared.draft);
  assert.equal(reservations[0].state,'open');
  assert.ok(Date.parse(reservations[0].deadline)>=before+10*60*1000);
  assert.ok(Date.parse(reservations[0].deadline)<=Date.now()+10*60*1000);
  assert.equal((await admin.query('select draft_id from recipe_private.authoring_operations where id=$1',[prepared.id])).rows[0].draft_id,null,
    'prepareDraft destination comes from rich_intents, not the nullable authoring draft_id');
  await expect(reserve(prepared,{cap:1025}),'conflict');
  await expect(reserve(prepared,{draft:randomUUID()}),'conflict');
  await expect(reserve(prepared,{actor:await account()}),'not_found');
  const edited=await seedIntent({purpose:'editDraft',age:23*hour});
  assert.equal((await reserve(edited)).draftId,edited.draft);
  console.log('PASS: aged prepare/edit first reservation, concurrent idempotency and unchanged ten-minute package lifetime');

  await rejectNew(await seedIntent(),'operation_expired',{actor:await account()});
  const mismatchedActor=await account(),mismatched=await seedIntent({richActor:mismatchedActor});
  await rejectNew(mismatched,'operation_expired');
  await rejectNew(mismatched,'operation_expired',{actor:mismatchedActor});
  await rejectNew(await seedIntent(),'operation_expired',{draft:randomUUID()});
  await rejectNew(await seedIntent({age:25*hour}),'operation_expired');
  await rejectNew(await seedIntent({expires:Date.now()-1000}),'operation_expired');
  for(const state of ['registered','accepted','cancelled','expired'])
    await rejectNew(await seedIntent({state}),'operation_expired');
  await rejectNew(await seedIntent({rich:false}),'operation_expired');
  const standalone={id:operationId(Date.now()-hour),actor:await account(),draft:randomUUID()};
  await rejectNew(standalone,'operation_expired');
  const fresh={...standalone,id:operationId()};
  assert.equal((await reserve(fresh)).state,'open','independent fresh packages remain supported');
  await rejectNew({...standalone,id:randomUUID()},'invalid_input');
  await rejectNew({...standalone,id:operationId(Date.now()+5*60*1000)},'operation_clock_skew');
  console.log('PASS: actor/destination/lifetime/state boundaries and ordinary UUIDv7 admission remain enforced');

  const expiredDeadline=new Date(Date.now()-1000);
  await admin.query('update recipe_private.object_packages set deadline=$2 where id=$1',[prepared.id,expiredDeadline]);
  assert.equal(Date.parse((await reserve(prepared)).deadline),expiredDeadline.getTime());
  const openMember=()=>roleCall(verifier,'recipe_object_verifier',null,'select recipe_objects.open_member($1,$2,0,\'text\',0,$3)',
    [prepared.actor,prepared.id,'00'.repeat(32)]);
  await expect(openMember(),'operation_expired');
  for(const state of ['closing','attached','closed']) {
    await admin.query('update recipe_private.object_packages set state=$2 where id=$1',[prepared.id,state]);
    const replay=await reserve(prepared);
    assert.equal(replay.state,state);assert.equal(Date.parse(replay.deadline),expiredDeadline.getTime());
    await expect(openMember(),'operation_expired');
  }
  console.log('PASS: expired and closed existing packages cannot be reopened or receive a renewed deadline');

  for(const cap of [0,4194305]) await rejectNew(await seedIntent(),'invalid_input',{cap});
  await rejectNew(await seedIntent(),'operation_expired',{draft:null});
  await rejectNew({...standalone,id:operationId()},'invalid_input',{draft:null});
  const foreign=await seedIntent();
  await admin.query('insert into recipe_private.drafts '+
    '(id,owner_id,recipe_id,revision,base_revision,public_info,config,bytes) values($1,$2,$3,1,0,\'{}\',\'{}\',0)',
    [foreign.draft,await account(),randomUUID()]);
  await rejectNew(foreign,'not_found');
  const retired=await seedIntent();
  await admin.query('insert into recipe_private.retired_drafts(id,owner_id,created_at) values($1,$2,clock_timestamp())',
    [retired.draft,retired.actor]);
  await rejectNew(retired,'not_found');
  const disabled=await seedIntent();
  await admin.query("update recipe_private.accounts set status='disabled' where id=$1",[disabled.actor]);
  await rejectNew(disabled,'account_disabled');
  for(const count of [1,3,60]) {
    const limited=await seedIntent();
    for(let n=0;n<count;n++) await admin.query('insert into recipe_private.object_packages(id,actor,draft_id,cap,state) '+
      'values($1,$2,$3,$4,$5)',[operationId(),limited.actor,randomUUID(),count===1?4194304:1,count===60?'closed':'open']);
    await rejectNew(limited,count===60?'rate_limited':'object_capacity');
  }
  console.log('PASS: cap, ownership, retired drafts, active account, aggregate bytes, open package count and daily quota guards');
} finally {
  await Promise.all([api,verifier,admin].filter(Boolean).map(p=>p.end()));
  if(started) run('pg_ctl',['-D',db,'-m','fast','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
