import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
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

  const owner=await account(),other=await account(),draftId=randomUUID();
  const id=operationId(),original=operationId(),baseManifest=randomUUID();
  const emptyHash='00'.repeat(32),changedHash='11'.repeat(32);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const publicItems=Object.fromEntries(['name','summary','overview','version'].map(field=>
    [field,{itemId:randomUUID(),originId:randomUUID(),value:field}]));
  const canonical=Buffer.from(JSON.stringify({format:'rich-v2',schemaVersion:2,public:publicItems,parts:[]}));
  const manifestHash=digest(canonical);
  const items=Object.entries(publicItems).map(([field,item])=>({field,kind:'publicText',itemId:item.itemId,
    originId:item.originId,baselineSha256:emptyHash,contentFingerprint:emptyHash}));
  const binding={revision:1,baseManifestSha256:manifestHash,transformVersion:1,inputSha256:emptyHash};
  const runAs=(actor,call,args)=>roleCall(api,'recipe_api',actor,'select recipe_api.'+call+' as result',args);
  const metadataReserve=(request,bound=binding,actor=owner)=>runAs(actor,'reserve_metadata_package($1,$2,$3,$4)',[request,draftId,1024,bound]);
  const probe=(request,bound=binding,wire=null)=>runAs(owner,'rich_metadata_context($1,$2,$3,$4)',[request,draftId,bound,wire]);
  const close=(request,bound=binding)=>runAs(owner,'rich_close_metadata($1,$2,$3)',[request,draftId,bound]);
  const readyManifest=(request,object)=>admin.query(`insert into recipe_private.object_attempts
    (id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state)
    values($1,$2,65,'manifest',$3,$4,$3,$3,$4,false,'ready','gone','present')`,[object,request,canonical.byteLength,manifestHash]);

  await admin.query(`insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
    values($1,$2,$1,0,1,'{"access":"direct"}','{}',$3)`,[draftId,owner,canonical.byteLength]);
  await admin.query(`insert into recipe_private.object_packages(id,actor,draft_id,cap,state)
    values($1,$2,$3,1024,'attached')`,[original,owner,draftId]);
  await readyManifest(original,baseManifest);
  await admin.query('insert into recipe_private.object_draft_refs values($1,$2)',[draftId,baseManifest]);
  await admin.query('insert into recipe_private.rich_drafts(id,manifest_id,items) values($1,$2,$3)',[draftId,baseManifest,JSON.stringify(items)]);
  for(const item of items)await admin.query(`insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline)
    values($1,$2,'publicText',$3,$4,$5)`,[item.originId,owner,original,item.itemId,emptyHash]);

  assert.deepEqual(await probe(id),{pending:true});
  const neverReserved=operationId();
  assert.deepEqual(await close(neverReserved),{closed:true});
  await expect(metadataReserve(neverReserved),'operation_expired');
  await expect(metadataReserve(id,binding,other),'not_found');
  assert.equal((await metadataReserve(id)).state,'open');
  await expect(metadataReserve(id,{...binding,inputSha256:changedHash}),'conflict');
  await expect(reserve({id,actor:owner,draft:draftId}),'conflict');
  await expect(metadataReserve(original),'conflict');
  assert.deepEqual(await close(id),{closed:true});
  assert.equal((await packageRow(id)).state,'closed');
  await expect(metadataReserve(id),'operation_expired');
  await expect(probe(id),'operation_expired');
  await expect(probe(operationId(Date.now()-10*60*1000)),'operation_expired');

  const staged=operationId(),nextManifest=randomUUID();
  const save=(request,object,wire=emptyHash)=>runAs(owner,'rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [request,draftId,binding,wire,canonical,object,'coded',JSON.stringify(items),null]);
  await metadataReserve(staged);
  await expect(save(staged,baseManifest),'object_unavailable');
  await readyManifest(staged,nextManifest);
  const receipt=await save(staged,nextManifest);
  assert.deepEqual(receipt,{requestId:staged,draftId,revision:2,manifestSha256:manifestHash});
  assert.deepEqual(await close(staged),{receipt});
  assert.deepEqual(await probe(staged),{receipt});
  await expect(probe(staged,{...binding,inputSha256:changedHash}),'conflict');
  await expect(probe(staged,binding,changedHash),'conflict');
  const row=(await admin.query('select bytes,revision,public_info from recipe_private.drafts where id=$1',[draftId])).rows[0];
  assert.equal(row.bytes,canonical.byteLength);assert.equal(row.public_info.access,'coded');assert.equal(row.revision,2);
  assert.equal((await packageRow(staged)).state,'attached');

  await admin.query("update recipe_private.receipts set created_at=clock_timestamp()-interval '8 days' where request_id=$1",[staged]);
  const next=operationId(),newerManifest=randomUUID(),nextBinding={...binding,revision:2};
  await metadataReserve(next,nextBinding);await readyManifest(next,newerManifest);
  await runAs(owner,'rich_save_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [next,draftId,nextBinding,changedHash,canonical,newerManifest,'direct',JSON.stringify(items),null]);
  assert.deepEqual(await probe(staged),{receipt});
  assert.deepEqual(await save(staged,nextManifest),receipt);
  const sameIntent=await seedIntent({actor:owner,age:0,state:'cancelled'});
  const metadataOrigin=randomUUID(),authoringOrigin=randomUUID();
  for(const [origin,provenance] of [[metadataOrigin,'metadata'],[authoringOrigin,'authoring']]){
    await admin.query(`insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline,provenance)
      values($1,$2,'finalLogo',$3,$4,$5,$6)`,[origin,owner,sameIntent.id,randomUUID(),emptyHash,provenance]);
  }
  await admin.query('delete from recipe_private.authoring_operations where id=$1',[sameIntent.id]);
  assert.deepEqual((await admin.query('select id from recipe_private.rich_origins where intent=$1',[sameIntent.id])).rows,[{id:metadataOrigin}]);
  assert.deepEqual((await admin.query(`select has_function_privilege('recipe_api',
    'recipe_private.rich_write_refs(uuid,uuid,uuid,uuid,text,bytea,jsonb)','EXECUTE') as exposed`)).rows,[{exposed:false}]);
  console.log('PASS: metadata package purpose, close, ordinal-65 access-only commit, exact receipt and provenance cleanup isolation');
} finally {
  await Promise.all([api,verifier,admin].filter(Boolean).map(p=>p.end()));
  if(started) run('pg_ctl',['-D',db,'-m','fast','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
