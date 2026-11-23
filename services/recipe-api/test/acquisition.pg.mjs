import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

export function acquisitionKey(now = Date.now()) {
  const bytes = randomBytes(16); bytes.writeUIntBE(now,0,6);
  bytes[6] = 0x70 | (bytes[6] & 15); bytes[8] = 0x80 | (bytes[8] & 63);
  const h = bytes.toString('hex');
  return `a2.${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
export function seedAcquisitionHistory(sql, legacy) {
  const f = {actor:randomUUID(),bulk:randomUUID(),onlyActor:randomUUID(),onlyRequest:randomUUID(),rawVersion:randomUUID(),rawRequest:'12345678-1234-0123-0123-123456789abc',future:acquisitionKey(Date.UTC(2040,0,1)).slice(3),other:randomUUID()};
  f.raw = 'Ab-cD';
  sql(`insert into recipe_private.accounts(id) values('${f.actor}'),('${f.bulk}'),('${f.onlyActor}');
    insert into recipe_private.versions(id,recipe_id,owner_id,revision,public_info,config,bytes)
    select '${f.rawVersion}',recipe_id,owner_id,2,public_info||'{"version":"fixture-2"}',config,bytes from recipe_private.versions where id='${legacy.version}';
    insert into recipe_private.grants(actor,version_id,original_request,original_digest)
    values('${f.actor}','${f.rawVersion}','${f.rawRequest}',sha256(convert_to(jsonb_build_array('${f.rawVersion}'::uuid,'ABCD')::text,'UTF8'))),
      ('${f.onlyActor}','${f.rawVersion}','${f.onlyRequest}',sha256(convert_to(jsonb_build_array('${f.rawVersion}'::uuid,'ABCD')::text,'UTF8')));
    insert into recipe_private.receipts(actor,action,request_id,digest,result,created_at)
    values('${f.actor}','acquire','${f.rawRequest}',sha256(convert_to(jsonb_build_array('${f.rawVersion}'::uuid,'${f.raw}')::text,'UTF8')),
      jsonb_build_object('recipeId','${legacy.recipe}'::uuid,'versionId','${f.rawVersion}'::uuid,'owned',false,'acquired',true),'2020-01-01Z');
    insert into recipe_private.receipts(actor,action,request_id,digest,result,created_at)
    select '${f.bulk}','acquire',gen_random_uuid(),sha256('fixture'::bytea),'{}',clock_timestamp()-interval '1 hour' from generate_series(1,2200);
    insert into recipe_private.receipts(actor,action,request_id,digest,result,created_at)
    values('${f.bulk}','acquire','${f.future}',sha256(convert_to(jsonb_build_array('${legacy.version}'::uuid,null)::text,'UTF8')),'{}',clock_timestamp()),
      ('${f.bulk}','save','${f.other}',sha256('fixture'::bytea),'{}','2020-01-01Z');`);
  f.accepted = Number(sql(`select least(256,count(*)) from recipe_private.receipts where actor='${f.bulk}' and action='acquire' and created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' and created_at<=clock_timestamp()`));
  f.proof = sql(`select (to_jsonb(r)-'subject_id')::text from recipe_private.receipts r where actor='${f.actor}'`);
  f.grant = sql(`select to_jsonb(g)::text from recipe_private.grants g where actor='${f.actor}'`);
  return f;
}

export async function checkAcquisitionBudget({sql,request,jwt,origin,v,v2,legacy,history,pgEnv}) {
  const f = history;
  assert.equal(sql(`select (to_jsonb(r)-'subject_id')::text from recipe_private.receipts r where actor='${f.actor}'`),f.proof);
  assert.equal(sql(`select (to_jsonb(g)-'acquisition_proof')::text from recipe_private.grants g where actor='${f.actor}'`),f.grant);
  assert.equal(sql(`select acquisition_proof from recipe_private.grants where actor='${f.actor}'`),'legacy-with-raw');
  assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${f.bulk}' and action='acquire'`),'2048');
  assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${f.bulk}' and action='save'`),'1');
  assert.equal(Number(sql(`select accepted from recipe_private.acquisition_state where actor='${f.bulk}'`)),f.accepted);
  const rawRoute = '/versions/'+f.rawVersion+'/redeem';
  const rawToken = jwt(f.actor);
  await request(rawRoute,{method:'POST',token:rawToken,body:{code:f.raw},key:f.rawRequest});
  assert.equal((await request(rawRoute,{method:'POST',token:rawToken,body:{code:'ABCD'},key:f.rawRequest,status:409})).error.code,'conflict');
  assert.equal(sql(`select acquisition_proof from recipe_private.grants where actor='${f.onlyActor}'`),'legacy-grant-only');
  await request(rawRoute,{method:'POST',token:jwt(f.onlyActor),body:{code:'aB-cD'},key:f.onlyRequest});
  assert.equal(sql(`select acquisition_proof from recipe_private.grants where actor='${f.onlyActor}'`),'legacy-with-raw');
  assert.equal(sql(`select count(*) from recipe_private.acquisition_state where actor='${f.onlyActor}'`),'0');
  assert.equal((await request(rawRoute,{method:'POST',token:jwt(f.onlyActor),body:{code:'ABCD'},key:f.onlyRequest,status:409})).error.code,'conflict');
  await request('/versions/'+v2.versionId+'/acquire',{method:'POST',token:jwt(f.bulk),body:{},key:randomUUID(),status:409});
  if(f.accepted===256) {
    const limited=await fetch(origin+'/v1/versions/'+v2.versionId+'/acquire',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt(f.bulk),'Idempotency-Key':acquisitionKey()},body:'{}'});
    assert.equal(limited.status,429);assert.equal((await limited.json()).error.code,'acquire_rate_limited');
    assert.match(limited.headers.get('retry-after'),/^[1-9][0-9]*$/);assert.ok(Number(limited.headers.get('retry-after'))<=86400);
  }
  await request('/versions/'+legacy.version+'/acquire',{method:'POST',token:jwt(f.bulk),body:{},key:f.future});
  assert.equal(sql(`select acquisition_proof from recipe_private.grants where actor='${legacy.reader}' and version_id='${legacy.version}'`),'legacy-with-raw');
  const pool = new pg.Pool({host:pgEnv.PGHOST,port:Number(pgEnv.PGPORT),database:pgEnv.PGDATABASE,user:'recipe_check_login',max:24});
  const acquire = async (actor,version,key,code=null,uuidSignature=false) => {
    const client = await pool.connect();
    try {
      await client.query('begin'); await client.query('set local role recipe_api');
      await client.query("select set_config('app.recipe_account',$1,true),set_config('app.recipe_code_key',$2,true)",[actor,'00'.repeat(32)]);
      const {rows} = await client.query(`select recipe_api.acquire($1::uuid,$2::text,$3::${uuidSignature?'uuid':'text'}) as result`,[version,code,key]);
      await client.query('commit'); return rows[0].result;
    } catch (error) {await client.query('rollback'); throw error;}
    finally {client.release();}
  };
  const expect = (promise, code) => assert.rejects(promise, error => error.code==='P0001' && error.message===code);
  const actor = randomUUID(); sql(`insert into recipe_private.accounts(id) values('${actor}')`);
  try {
    // Use the actual restricted SQL role. No HTTP pool admission can make this pass accidentally.
    const keys = Array.from({length:300},()=>acquisitionKey());
    const outcomes = await Promise.allSettled(keys.map(key=>acquire(actor,v2.versionId,key)));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,256);
    assert.equal(outcomes.filter(x=>x.status==='rejected' && x.reason.message==='acquire_rate_limited').length,44);
    assert.equal(sql(`select accepted from recipe_private.acquisition_state where actor='${actor}'`),'256');
    assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${actor}'`),'256');
    const replayKey = 'a2.'+sql(`select original_request from recipe_private.grants where actor='${actor}'`);
    const replay = await acquire(actor,v2.versionId,replayKey);
    assert.ok(replay.acquired);
    await expect(acquire(actor,v2.versionId,replayKey,'changed'),'conflict');
    await expect(acquire(actor,v2.versionId,replayKey.slice(3),null,true),'conflict');
    await expect(acquire(actor,v2.versionId,randomUUID(),null,true),'request_upgrade_required');
    const safeResults = await pool.query("begin; set local role recipe_api; select has_function_privilege(current_user,'recipe_api.acquire(uuid,text,text)','EXECUTE') as allowed, has_schema_privilege(current_user,'recipe_private','USAGE') as private; rollback");
    assert.deepEqual(safeResults[2].rows[0],{allowed:true,private:false});
    await assert.rejects(pool.query('delete from recipe_private.acquisition_state'));
    assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='recipe_api' and p.proname='acquire' and (p.proowner<>'recipe_owner'::regrole or p.proconfig<>array['search_path=pg_catalog, pg_temp'])`),'0');

    for (const [owner,req,version] of [[f.actor,f.rawRequest,f.rawVersion],[actor,replayKey.slice(3),v2.versionId]]) {
      const saved = sql(`select to_jsonb(r)::text from recipe_private.receipts r where actor='${owner}' and subject_id='${version}'`);
      sql(`delete from recipe_private.receipts where actor='${owner}' and subject_id='${version}'`);
      await expect(acquire(owner,version,owner===actor?replayKey:req,owner===actor?null:'AB-CD'),'integrity_error');
      sql(`insert into recipe_private.receipts select * from json_populate_record(null::recipe_private.receipts,${literal(saved)})`);
    }
    await expect(acquire(f.actor,v2.versionId,'a2.'+f.rawRequest),'invalid_input');
    // Cross-generation first-proof UUID collision precedes code validation/consumption.
    const collision = acquisitionKey();
    sql(`update recipe_private.grants set original_request='${collision.slice(3)}' where actor='${f.actor}' and version_id='${f.rawVersion}';
      update recipe_private.receipts set request_id='${collision.slice(3)}' where actor='${f.actor}' and subject_id='${f.rawVersion}'`);
    await expect(acquire(f.actor,v.versionId,collision,'00000000000000000000000000000000'),'conflict');

    const definition = sql("select pg_get_functiondef('recipe_private.acquire_core(uuid,text,text)'::regprocedure)");
    const at = milliseconds => sql(definition.replace('wall := clock_timestamp();','wall := '+literal(new Date(milliseconds).toISOString())+'::timestamptz;'));
    const future = Date.UTC(2035,5,1,23,59,59);
    try {
      at(future);
      sql(`insert into recipe_private.receipts(actor,action,request_id,digest,result,created_at)
        values('${f.actor}','acquire_v2','${collision.slice(3)}',sha256('fixture'::bytea),'{}','2020-01-01Z')`);
      await acquire(f.actor,v2.versionId,acquisitionKey(future));
      assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${f.actor}' and action='acquire_v2' and request_id='${collision.slice(3)}'`),'0');
      assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${f.actor}' and action='acquire' and request_id='${collision.slice(3)}'`),'1');
      const timeActor=randomUUID(); sql(`insert into recipe_private.accounts(id) values('${timeActor}')`);
      await expect(acquire(timeActor,v.versionId,acquisitionKey(future),'bad'),'invalid_code');
      assert.equal(sql(`select count(*) from recipe_private.acquisition_state where actor='${timeActor}'`),'0');
      await expect(acquire(timeActor,v2.versionId,acquisitionKey(future-300001)),'operation_expired');
      await expect(acquire(timeActor,v2.versionId,acquisitionKey(future+120001)),'operation_clock_skew');
      const first=acquisitionKey(future), noop=acquisitionKey(future);
      await acquire(timeActor,v2.versionId,first); await acquire(timeActor,v2.versionId,noop);
      const receipt=sql(`select to_jsonb(r)::text from recipe_private.receipts r where actor='${timeActor}' and request_id='${noop.slice(3)}'`);
      at(future+168*3600000);
      await expect(acquire(timeActor,v.versionId,acquisitionKey(future+168*3600000),'bad'),'invalid_code');
      assert.equal(sql(`select to_jsonb(r)::text from recipe_private.receipts r where actor='${timeActor}' and request_id='${noop.slice(3)}'`),receipt);
      await acquire(timeActor,v2.versionId,acquisitionKey(future+168*3600000));
      assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${timeActor}' and request_id='${noop.slice(3)}'`),'0');
      await acquire(timeActor,v2.versionId,first); // Protected forever, despite the day cap and age.
      at(future);
      await expect(acquire(timeActor,v2.versionId,noop),'operation_expired');
      assert.equal(sql(`select effective_at= '${new Date(future+168*3600000).toISOString()}'::timestamptz from recipe_private.acquisition_state where actor='${timeActor}'`),'t');
      sql(`update recipe_private.acquisition_state set accepted=256 where actor='${timeActor}'`);
      await assert.rejects(acquire(timeActor,v2.versionId,acquisitionKey(future+168*3600000)),error=>
        error.message==='acquire_rate_limited' && Number(error.detail)===168*3600+1);
      at(future+1000);
      const utcActor=randomUUID();sql(`insert into recipe_private.accounts(id) values('${utcActor}')`);
      await acquire(utcActor,v2.versionId,acquisitionKey(future+1000));
      assert.equal(sql(`set timezone='America/Los_Angeles'; select utc_day from recipe_private.acquisition_state where actor='${utcActor}'`),'2035-06-02');
      const boundedActor=randomUUID();sql(`insert into recipe_private.accounts(id) values('${boundedActor}')`);
      let retired;
      for(let n=0;n<8;n++) {
        const wall=future+n*86400000-(n===7?1000:0);at(wall);
        const keys=Array.from({length:256},()=>acquisitionKey(wall));
        await Promise.all(keys.map(key=>acquire(boundedActor,v2.versionId,key)));
        if(n===0)retired='a2.'+sql(`select request_id from recipe_private.receipts where actor='${boundedActor}' and subject_id is null limit 1`);
      }
      assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${boundedActor}' and subject_id is null`),'2047');
      at(future+8*86400000);await acquire(boundedActor,v2.versionId,acquisitionKey(future+8*86400000));
      assert.ok(Number(sql(`select count(*) from recipe_private.receipts where actor='${boundedActor}' and subject_id is null`))<=2048);
      await expect(acquire(boundedActor,v2.versionId,retired),'operation_expired');
      at(Date.UTC(2040,0,1));
      await acquire(f.bulk,v2.versionId,acquisitionKey(Date.UTC(2040,0,1)));
      await expect(acquire(f.bulk,legacy.version,f.future),'request_upgrade_required');
      assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${f.bulk}' and action='save'`),'1');
    } finally {sql(definition);}

    // Holding the same account lock proves wall is captured after the wait.
    const lockActor=randomUUID();sql(`insert into recipe_private.accounts(id) values('${lockActor}')`);
    const locker=await pool.connect();
    try {
      await locker.query('begin');await locker.query('select pg_advisory_xact_lock(hashtextextended($1,187511))',[lockActor]);
      const waiting=acquire(lockActor,v2.versionId,acquisitionKey());
      const started=Date.now();await delay(1100);await locker.query('commit');await waiting;
      assert.ok(Date.parse(sql(`select effective_at from recipe_private.acquisition_state where actor='${lockActor}'`))>=started+1000);
    } finally {await locker.query('rollback');locker.release();}

    const token=jwt(randomUUID()), route='/versions/'+v2.versionId+'/acquire';
    const responses=await Promise.all(Array.from({length:300},async()=>{
      const response=await fetch(origin+'/v1'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':acquisitionKey()},body:'{}'});
      return {status:response.status,data:await response.json(),retry:response.headers.get('retry-after')};
    }));
    assert.ok(responses.every(r=>r.status===200 || r.status===429 && r.data.error.code==='acquire_rate_limited' || r.status===503 && r.data.error.code==='database_unavailable'));
    const ok=responses.filter(r=>r.status===200).length;
    const account=(await request('/me',{token})).accountId;
    assert.equal(Number(sql(`select count(*) from recipe_private.receipts where actor='${account}'`)),ok);
    assert.ok(ok<=256);
    const limited=await fetch(origin+'/v1/versions/'+v2.versionId+'/acquire',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt(f.bulk),'Idempotency-Key':acquisitionKey()},body:'{}'});
    assert.equal(limited.status,410); // Its committed highwater cannot be reset by returning to wall time.
    console.log('PASS: acquisition migration, real-role 300-way budget, raw/legacy proofs, rollback, 168h expiry, UTC, highwater, lock wait and HTTP overload.');
  } finally {await pool.end();}
}
