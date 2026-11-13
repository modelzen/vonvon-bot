import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { installProof, sha256 } from '../src/install-proof.mjs';

function operationId(time = Date.now()) {
  const raw = randomBytes(16);
  raw.writeUIntBE(time,0,6);
  raw[6] = 0x70 | (raw[6] & 15);
  raw[8] = 0x80 | (raw[8] & 63);
  const hex = raw.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export async function checkInstallOperations({request,sql,jwt,author,reader,other,v,v2,legacy,pgEnv,config}) {
  const preview = await request('/versions/'+v.versionId+'/install-preview',{token:author});
  const manifest = JSON.parse(Buffer.from(preview.manifest,'base64url').toString());
  assert.equal(sha256(Buffer.from(preview.manifest,'base64url')).toString('hex'),preview.manifestSha256);
  assert.deepEqual(manifest,{schema:1,recipeId:v.recipeId,versionId:v.versionId,authorId:preview.accountId,
    revision:1,access:'coded',role:config.role,setup:config.setup});
  assert.equal((await request('/versions/'+v.versionId+'/install-preview',{token:reader})).manifest,preview.manifest);
  await request('/versions/'+v.versionId+'/install-preview',{status:401});
  await request('/versions/'+v.versionId+'/install-preview',{token:other,status:403});
  const stranger=jwt(randomUUID());
  await request('/versions/'+v2.versionId+'/install-preview',{token:stranger,status:403});
  for (const subject of [legacy.owner,legacy.reader]) {
    const p=await request('/versions/'+legacy.version+'/install-preview',{token:jwt(subject)});
    assert.equal(JSON.parse(Buffer.from(p.manifest,'base64url')).role,'LEGACY-PRIVATE');
  }
  const {publicKey,privateKey}=generateKeyPairSync('x25519');
  const targetPublicKey=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url');
  const nonce=randomBytes(32);
  const body={purpose:'installBoundRole',versionId:v.versionId,manifestSha256:preview.manifestSha256,
    targetPublicKey,nonceCommitment:sha256(nonce).toString('base64url'),generation:1};
  const authorize=(id,token=author,changes={},status=200)=>request('/operations/'+id+'/authorize',{
    method:'POST',token,body:{...body,...changes},status});
  const cancel=(id,token=author,status=200)=>request('/operations/'+id+'/cancel',{method:'POST',token,body:{},status});
  const possession=auth=>({ticket:auth.ticket,nonce:nonce.toString('base64url'),proof:installProof(privateKey,auth).toString('base64url')});
  const redeem=(auth,status=200,changes={})=>request('/operations/'+auth.operationId+'/redeem',{
    method:'POST',body:{...possession(auth),...changes},status});
  const complete=(auth,outcome='applied',status=200)=>request('/operations/'+auth.operationId+'/complete',{
    method:'POST',body:{...possession(auth),outcome},status});

  const id=operationId(),started=Date.now();
  const same=await Promise.all(Array.from({length:8},()=>authorize(id)));
  same.forEach(auth=>assert.deepEqual(auth,same[0]));
  const auth=same[0];
  assert.equal(auth.status,'authorized');
  assert.ok(auth.deadline>=started && auth.deadline<=Date.now()+300000);
  assert.equal(auth.accountId,preview.accountId);
  assert.equal(sql(`select count(*) from recipe_private.install_operations where id='${id}'`),'1');
  assert.equal(sql(`select octet_length(expected_proof_hash)=32 and binding::text not like '%${nonce.toString('base64url')}%'
    from recipe_private.install_operations where id='${id}'`),'t');
  for (const change of [{manifestSha256:'f'.repeat(64)},{versionId:v2.versionId},
    {nonceCommitment:sha256(randomBytes(32)).toString('base64url')}]) await authorize(id,author,change,409);
  await cancel(id,other,404);
  await complete(auth,'applied',409);
  await redeem(auth,403,{nonce:randomBytes(32).toString('base64url')});
  await redeem(auth,403,{proof:randomBytes(32).toString('base64url')});
  await redeem(auth,403,{ticket:randomBytes(32).toString('base64url')});
  const wrongKey=generateKeyPairSync('x25519').privateKey;
  await redeem(auth,403,{proof:installProof(wrongKey,auth).toString('base64url')});
  const credentials=[auth.ticket,nonce.toString('base64url'),installProof(privateKey,auth).toString('base64url')]
    .map(value=>`decode('${Buffer.from(value,'base64url').toString('hex')}','hex')`);
  for (const missing of [0,1,2,-1]) for (const outcome of ['null',"'applied'"]) {
    const args=credentials.map((value,index)=>missing===-1 || index===missing?'null':value);
    sql(`begin; set local role recipe_api;
      do $$ declare denied boolean := false; begin
        begin
          perform recipe_api.possess_operation('${id}',${args.join(',')},${outcome});
        exception when raise_exception then
          if sqlerrm='invalid_operation_proof' then denied:=true; else raise; end if;
        end;
        if not denied then raise exception 'NULL possession credential was accepted'; end if;
      end $$; rollback;`);
  }
  const quoted=value=>"'"+value.replaceAll("'","''")+"'";
  const requestSql=quoted(JSON.stringify(body))+'::jsonb';
  const materialSql=[requestSql,...Array(3).fill("decode('"+'11'.repeat(32)+"','hex')"),
    "floor(extract(epoch from clock_timestamp())*1000)::bigint+10000"];
  function invalidAuthorization(candidate,args) {
    sql(`begin; set local role recipe_api; select set_config('app.recipe_account','${preview.accountId}',true);
      do $$ declare denied boolean := false; begin
        begin
          perform recipe_api.authorize_operation('${candidate}',${args.join(',')});
        exception when raise_exception then
          if sqlerrm='invalid_input' then denied:=true; else raise; end if;
        end;
        if not denied then raise exception 'Malformed SQL authorization input was accepted'; end if;
      end $$; rollback;`);
  }
  const invalidRequests=['null',"'null'::jsonb","'1'::jsonb","'true'::jsonb",`'"text"'::jsonb`,"'[]'::jsonb","'{}'::jsonb"];
  for (const field of Object.keys(body)) {
    invalidRequests.push(quoted(JSON.stringify({...body,[field]:null}))+'::jsonb');
    invalidRequests.push(quoted(JSON.stringify({...body,[field]:field==='generation'?'1':32}))+'::jsonb');
  }
  invalidRequests.push(quoted(JSON.stringify({...body,targetPublicKey:'_'.repeat(43)}))+'::jsonb');
  for (const candidate of [operationId(),id]) {
    for (const invalid of invalidRequests) invalidAuthorization(candidate,[invalid,...materialSql.slice(1)]);
    for (const index of [1,2,3,4]) {
      const invalid=[...materialSql]; invalid[index]='null';
      invalidAuthorization(candidate,invalid);
      if (index<4) for (const length of [31,33]) {
        invalid[index]="decode('"+'11'.repeat(length)+"','hex')";
        invalidAuthorization(candidate,invalid);
      }
    }
  }
  for (const [field,value] of [
    ['request_digest','null'], ['version_id','null'], ['binding','null'], ['binding',"'null'::jsonb"],
    ['binding',"'[]'::jsonb"], ['binding',"'1'::jsonb"],
    ['ticket','null'], ['expected_proof_hash','null'], ['deadline','null'],
  ]) {
    sql(`do $$ declare denied boolean := false; begin
      begin
        update recipe_private.install_operations set ${field}=${value} where id='${id}';
      exception when check_violation then denied:=true;
      end;
      if not denied then raise exception 'Malformed operation row was accepted'; end if;
    end $$;`);
  }
  const received=await redeem(auth);
  assert.equal(received.status,'redeemed');
  assert.equal(received.manifest,preview.manifest);
  assert.ok(!('ticket' in received));
  assert.deepEqual(await redeem(auth),received);
  assert.equal((await cancel(id)).status,'in_progress');
  sql(`update recipe_private.install_operations set deadline=0 where id='${id}'`);
  assert.equal((await redeem(auth)).status,'redeemed');
  assert.equal((await complete(auth)).status,'applied');
  assert.deepEqual(await complete(auth),{operationId:id,status:'applied'});
  await complete(auth,'rejected',409);
  assert.equal((await redeem(auth)).status,'applied');
  assert.equal((await authorize(id)).status,'applied');
  assert.equal((await cancel(id)).status,'applied');

  const preCancel=operationId();
  assert.equal((await cancel(preCancel)).status,'cancelled');
  assert.deepEqual(await cancel(preCancel),{operationId:preCancel,status:'cancelled'});
  await authorize(preCancel,author,{},409);
  const cancelled=await authorize(operationId());
  assert.equal((await cancel(cancelled.operationId)).status,'cancelled');
  await redeem(cancelled,409);
  const expired=await authorize(operationId());
  sql(`update recipe_private.install_operations set deadline=0 where id='${expired.operationId}'`);
  await redeem(expired,410);
  await authorize(expired.operationId,author,{},410);
  await authorize(operationId(Date.now()-300001),author,{},410);
  await cancel(operationId(Date.now()-300001),author,410);
  await authorize(operationId(Date.now()+130000),author,{},422);
  await cancel(operationId(Date.now()+130000),author,422);
  const future=operationId(Date.now()+130000),credentialsBody=possession(auth);
  for (const action of ['redeem','complete']) {
    const result=await request('/operations/'+future+'/'+action,{method:'POST',status:422,
      body:{...credentialsBody,...(action==='complete'?{outcome:'applied'}:{})}});
    assert.equal(result.error.code,'operation_clock_skew');
  }
  const clockAllowed=await authorize(operationId(Date.now()+100000));
  await cancel(clockAllowed.operationId);
  await authorize(operationId(),author,{targetPublicKey:Buffer.alloc(32).toString('base64url')},422);
  await authorize(operationId(),author,{manifestSha256:'e'.repeat(64)},409);

  const acquired=await authorize(operationId(),reader);
  const readerAccount=(await request('/me',{token:reader})).accountId;
  const grant=sql(`select row_to_json(g) from recipe_private.grants g where actor='${readerAccount}' and version_id='${v.versionId}'`);
  sql(`delete from recipe_private.grants where actor='${readerAccount}' and version_id='${v.versionId}'`);
  await redeem(acquired,403);
  sql(`insert into recipe_private.grants select * from json_populate_record(null::recipe_private.grants,'${grant}')`);
  assert.equal((await redeem(acquired)).status,'redeemed');
  assert.equal((await complete(acquired,'rejected')).status,'rejected');
  const old=await authorize(operationId());
  sql(`update recipe_private.install_operations set created_at=clock_timestamp()-interval '8 days' where id='${old.operationId}'`);
  await redeem(old,410);
  // The embedded birth time prevents a purged old UUID from creating a second operation.
  const oldId=operationId(Date.now()-8*86400000);
  sql(`update recipe_private.install_operations set id='${oldId}' where id='${old.operationId}'`);
  await cancel(operationId());
  assert.equal(sql(`select count(*) from recipe_private.install_operations where id='${oldId}'`),'0');
  await authorize(oldId,author,{},410);

  const connection=()=>new pg.Client({host:pgEnv.PGHOST,port:Number(pgEnv.PGPORT),database:pgEnv.PGDATABASE,user:pgEnv.PGUSER});
  const blocker=connection(),observer=connection();
  await blocker.connect(); await observer.connect();
  async function waiting(fragment) {
    for (let i=0;i<200;i++) {
      const result=await observer.query(`select count(*) from pg_stat_activity where application_name='vonvon-recipe-api'
        and wait_event_type='Lock' and query like $1`,['%'+fragment+'%']);
      if (Number(result.rows[0].count)>0) return;
      await delay(5);
    }
    assert.fail('expected database row lock waiter for '+fragment);
  }
  try {
    const deadlineRace=await authorize(operationId());
    await blocker.query('BEGIN');
    const deadlineUpdate=await blocker.query(`update recipe_private.install_operations
      set deadline=floor(extract(epoch from clock_timestamp())*1000)::bigint+1500 where id=$1 returning deadline`,[deadlineRace.operationId]);
    const deadline=Number(deadlineUpdate.rows[0].deadline);
    const expiredRetry=authorize(deadlineRace.operationId,author,{},410);
    await waiting('authorize_operation');
    assert.ok(Date.now()<deadline,'authorize must enter its row-lock wait before the deadline');
    while (Date.now()<=deadline) await delay(Math.min(20,deadline-Date.now()+1));
    await blocker.query('COMMIT');
    assert.equal((await expiredRetry).error.code,'operation_expired');
    await redeem(deadlineRace,410);

    const disabledRace=await authorize(operationId());
    await blocker.query('BEGIN');
    await blocker.query("update recipe_private.accounts set status='disabled' where id=$1",[preview.accountId]);
    const denied=redeem(disabledRace,403);
    await waiting('possess_operation');
    await blocker.query('COMMIT');
    await denied;
    assert.equal(sql(`select state from recipe_private.install_operations where id='${disabledRace.operationId}'`),'authorized');
    await authorize(operationId(),author,{},403);
    await cancel(disabledRace.operationId,author,403);
    await complete(auth,'applied',403);
    await request('/versions/'+v.versionId+'/install-preview',{token:author,status:403});
    sql(`update recipe_private.accounts set status='active' where id='${preview.accountId}'`);
    await redeem(disabledRace);
    await complete(disabledRace,'rejected');

    const cancelledRace=await authorize(operationId());
    await blocker.query('BEGIN');
    await blocker.query('select id from recipe_private.install_operations where id=$1 for update',[cancelledRace.operationId]);
    const cancelWins=cancel(cancelledRace.operationId);
    await waiting('cancel_operation');
    const redeemLoses=redeem(cancelledRace,409);
    await blocker.query('COMMIT');
    assert.equal((await cancelWins).status,'cancelled');
    await redeemLoses;

    const redeemRace=await authorize(operationId());
    await blocker.query('BEGIN');
    await blocker.query('select id from recipe_private.install_operations where id=$1 for update',[redeemRace.operationId]);
    const redeemWins=redeem(redeemRace);
    await waiting('possess_operation');
    const cancelLoses=cancel(redeemRace.operationId);
    await blocker.query('COMMIT');
    assert.equal((await redeemWins).status,'redeemed');
    assert.equal((await cancelLoses).status,'in_progress');
    await complete(redeemRace,'rejected');
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end(); await observer.end();
  }

  const quotaToken=jwt(randomUUID());
  await request('/versions/'+v2.versionId+'/acquire',{method:'POST',token:quotaToken,body:{}});
  const quotaPreview=await request('/versions/'+v2.versionId+'/install-preview',{token:quotaToken});
  const quotaBody={versionId:v2.versionId,manifestSha256:quotaPreview.manifestSha256};
  const competitors=await Promise.all(Array.from({length:8},async()=>{
    const candidate=operationId();
    try { return await authorize(candidate,quotaToken,quotaBody); }
    catch (err) { assert.match(err.message,/429 operation_pending_limit/); return null; }
  }));
  const allowed=competitors.filter(Boolean);
  assert.equal(allowed.length,3);
  for (const granted of allowed) {
    assert.deepEqual(await authorize(granted.operationId,quotaToken,quotaBody),granted);
    await cancel(granted.operationId,quotaToken);
  }
  const before=Number(sql("select count(*) from recipe_private.receipts"));
  const quotaAccount=quotaPreview.accountId;
  const existing=Number(sql(`select count(*) from recipe_private.install_operations where account_id='${quotaAccount}'`));
  let last;
  for (let n=existing;n<60;n++) { last=operationId(); await cancel(last,quotaToken); }
  await cancel(last,quotaToken);
  await cancel(operationId(),quotaToken,429);
  assert.equal(Number(sql("select count(*) from recipe_private.receipts")),before);
  assert.equal(sql(`select count(*) from recipe_private.install_operations where account_id='${quotaAccount}'`),'60');
  assert.equal(sql("select has_table_privilege('recipe_api','recipe_private.install_operations','SELECT')"),'f');
  console.log('PASS: install operations: immutable previews, owned/acquired boundary, exact retries, key+nonce proofs, completion receipts, real row-lock cancel/disable races, pending/day quotas, UUIDv7 retention.');
}
