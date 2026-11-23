import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { authoringProof, DISPATCH_DIGEST } from '../src/authoring-proof.mjs';
import { payloadBytes } from '../src/authoring-input.mjs';
import { sha256 } from '../src/install-proof.mjs';
import { checkSourceHistory } from './source-history.pg.mjs';
import { startRecipeService } from '../src/main.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const tmp=mkdtempSync(join(tmpdir(),'vonvon-authoring-check-'));
const bin=process.env.PG_BINDIR || execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const command=(name,args,extra={})=>execFileSync(join(bin,name),args,{encoding:'utf8',...extra});
const db=join(tmp,'db'),sock=join(tmp,'s');
const pgEnv={...process.env,PGHOST:sock,PGPORT:'5432',PGDATABASE:'postgres',PGUSER:'bootstrap_test',PGPASSWORD:''};
const sql=stmt=>command('psql',['-XAtq','-v','ON_ERROR_STOP=1','-c',stmt],{env:pgEnv}).trim();
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
function operationId(time=Date.now()) {
  const raw=randomBytes(16); raw.writeUIntBE(time,0,6); raw[6]=0x70|(raw[6]&15); raw[8]=0x80|(raw[8]&63);
  const hex=raw.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
let up=false,service,issuerServer;
try {
  assert.match(command('postgres',['--version']),/PostgreSQL\) 15\./);
  mkdirSync(sock,{mode:0o700});
  command('initdb',['-D',db,'-U','bootstrap_test','--encoding=UTF8','--locale=C','--auth=trust'],{stdio:'ignore'});
  command('pg_ctl',['-D',db,'-w','-l',join(tmp,'pg.log'),'-o',`-k '${sock}' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);up=true;
  const migrations = readdirSync(join(root,'supabase/migrations')).filter(name=>name.endsWith('.sql')).sort();
  const sourceMigration = migrations.findIndex(name=>name.endsWith('_recipe_source_history.sql'));
  assert.ok(sourceMigration >= 0);
  const apply = name => command('psql',['-Xq','-1','-v','ON_ERROR_STOP=1','-f',join(root,'supabase/migrations',name)],{
    env:pgEnv,stdio:['ignore','ignore','pipe'],
  });
  migrations.slice(0,sourceMigration).forEach(apply);
  sql('create role recipe_check_login login noinherit; grant recipe_api to recipe_check_login');
  const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-authoring',alg:'ES256',use:'sig'};
  issuerServer=createServer((req,res)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({keys:[jwk]})));
  await new Promise(resolve=>issuerServer.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${issuerServer.address().port}/auth/v1`;
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt=(subject,extra={})=>{
    const now=Math.floor(Date.now()/1000);
    const text=encode({alg:'ES256',kid:jwk.kid})+'.'+encode({iss:issuer,aud:'authenticated',role:'authenticated',sub:subject,iat:now,exp:now+120,...extra});
    return text+'.'+sign('sha256',Buffer.from(text),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  };
  const url=new URL('postgresql://recipe_check_login@localhost/postgres');url.searchParams.set('host',sock);url.searchParams.set('port','5432');
  const env={...process.env,RECIPE_AUTH_ISSUER:issuer,RECIPE_DATABASE_URL:url.href,RECIPE_CODE_KEY:randomBytes(32).toString('hex'),PORT:'0'};
  service=await startRecipeService(env);
  const request=async(path,{token,method='GET',body,revision,key,status=200}={})=>{
    const headers={};if(token)headers.authorization='Bearer '+token;
    if(method!=='GET')Object.assign(headers,{'content-type':'application/json','idempotency-key':key??operationId()});
    if(revision!==undefined)headers['if-match']='"'+revision+'"';
    const res=await fetch('http://127.0.0.1:'+service.server.address().port+'/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,status,path+' '+res.status+' '+data.error?.code);return data;
  };
  const authorSubject=randomUUID(),author=jwt(authorSubject),other=jwt(randomUUID());
  const account=(await request('/me',{token:author})).accountId;
  const keyPair=generateKeyPairSync('x25519'),nonce=randomBytes(32);
  const registration={purpose:'prepareDraft',targetPublicKey:keyPair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64url'),nonceCommitment:sha256(nonce).toString('base64url')};
  const register=(id=operationId(),changes={},token=author,status=200)=>request('/authoring/'+id+'/register',{method:'POST',token,body:{...registration,...changes},status});
  const recover=(id,token=author,status=200)=>request('/authoring/'+id+'/recovery',{token,status});
  const closedId=id=>({operationId:id,accountId:account,unredeemable:true});
  const cancel=(id,token=author,status=200)=>request('/authoring/'+id+'/cancel',{method:'POST',token,body:{},status});
  const authorize=(id,stage,revision,payloadDigest,token=author,status=200)=>request('/authoring/'+id+'/authorize',{method:'POST',token,body:{stage,stateRevision:revision,payloadDigest},status});
  const possession=(cap,changes={})=>({ticket:cap.ticket,nonce:nonce.toString('base64url'),proof:authoringProof(keyPair.privateKey,cap).toString('base64url'),...changes});
  const dispatch=(cap,status=200,changes={})=>request('/authoring/'+cap.operationId+'/dispatch',{method:'POST',body:possession(cap,changes),status});
  const accept=(cap,body,status=200,changes={})=>request('/authoring/'+cap.operationId+'/accept',{method:'POST',body:possession(cap,{payload:payloadBytes(body).toString('base64url'),...changes}),status});
  const body={public:{name:'',summary:'',overview:'',version:'',access:'direct'},config:{role:'SELECTED-ROLE'}};
  const completeBody={public:{name:'配方',summary:'作者手写',overview:'',version:'1',access:'direct'},config:{role:'SELECTED-ROLE',setup:{steps:[{kind:'context',title:'准备',instructions:'作者步骤',required:true}]}}};
  async function dispatched(changes={}) {
    const op=await register(operationId(),changes);
    const cap=await authorize(op.operationId,'dispatch',1,DISPATCH_DIGEST);
    assert.deepEqual(await authorize(op.operationId,'dispatch',1,DISPATCH_DIGEST),cap);
    assert.deepEqual(await dispatch(cap),{operationId:op.operationId,status:'dispatched',stateRevision:2});
    return {op,cap};
  }
  async function ready(body,changes={}) {
    const {op,cap:dispatchCap}=await dispatched(changes);
    const cap=await authorize(op.operationId,'accept',2,sha256(payloadBytes(body)).toString('hex'));
    assert.deepEqual(await authorize(op.operationId,'accept',2,cap.payloadDigest),cap);
    return {op,cap,dispatchCap};
  }
  await checkSourceHistory({request, ready, accept, operationId, author, other,
    secondDevice:jwt(authorSubject,{session_id:randomUUID()}), completeBody, account, sql,
    upgrade:()=>migrations.slice(sourceMigration).forEach(apply),
  });
  const id=operationId();
  await recover(operationId(),author,404);
  const unregistered=operationId(Date.now()-6*60_000);
  await recover(unregistered,null,401);
  assert.deepEqual(await recover(unregistered),closedId(unregistered));
  await register(unregistered,{},author,410);
  await cancel(unregistered,author,410);
  const registrations=await Promise.all(Array.from({length:8},()=>register(id)));
  registrations.forEach(value=>assert.deepEqual(value,registrations[0]));
  assert.deepEqual(await recover(id),registrations[0]);
  await recover(id,other,404);
  assert.equal(registrations[0].stateRevision,1);
  assert.ok(registrations[0].operationDeadline-Date.now()>23*3600000);
  await register(id,{},other,404);await cancel(id,other,404);
  await register(id,{botId:'private-bot'},author,422);
  await register(id,{targetPublicKey:randomBytes(32).toString('base64url')},author,409);
  await authorize(id,'accept',1,sha256(payloadBytes(body)).toString('hex'),author,409);
  await authorize(id,'dispatch',1,DISPATCH_DIGEST,other,404);
  await authorize(id,'dispatch',1,DISPATCH_DIGEST,null,401);
  const initial=await authorize(id,'dispatch',1,DISPATCH_DIGEST);
  await dispatch(initial,403,{nonce:randomBytes(32).toString('base64url')});
  await dispatch(initial,403,{proof:randomBytes(32).toString('base64url')});
  await dispatch(initial,403,{ticket:randomBytes(32).toString('base64url')});
  await dispatch(initial,403,{proof:authoringProof(generateKeyPairSync('x25519').privateKey,initial).toString('base64url')});
  await accept(initial,body,403);
  await dispatch(initial);
  await authorize(id,'dispatch',1,DISPATCH_DIGEST,author,409);
  const cap=await authorize(id,'accept',2,sha256(payloadBytes(body)).toString('hex'));
  await authorize(id,'accept',2,'f'.repeat(64),author,409);
  await accept(cap,{...body,config:{role:'changed'}},409);
  for(const mutation of [
    {accountId:randomUUID()}, {operationId:operationId()}, {purpose:'editDraft'}, {stage:'dispatch'},
    {payloadDigest:'f'.repeat(64)}, {stateRevision:1}, {baseRevision:1}, {draftId:randomUUID()},
    {nonceCommitment:randomBytes(32).toString('base64url')},
  ])await accept(cap,body,403,{proof:authoringProof(keyPair.privateKey,{...cap,...mutation}).toString('base64url')});
  const credentials=[cap.ticket,nonce.toString('base64url'),authoringProof(keyPair.privateKey,cap).toString('base64url')]
    .map(value=>"decode('"+Buffer.from(value,'base64url').toString('hex')+"','hex')");
  const encodedPayload="decode('"+payloadBytes(body).toString('hex')+"','hex')";
  function deniedSql(expression,expected) {
    sql(`begin;set local role recipe_api;select set_config('app.recipe_account','${account}',true);
      do $$ declare denied boolean:=false;begin
        begin perform ${expression};exception when raise_exception then
          if sqlerrm='${expected}' then denied:=true;else raise;end if;
        end;
        if not denied then raise exception 'Malformed SQL input was accepted';end if;
      end $$;rollback;`);
  }
  for (const invalid of ['null', "'{}'::uuid[]", "array[null]::uuid[]", `array['${id}','${id}']::uuid[]`,
      `array[array['${id}']]::uuid[]`, `array['${randomUUID()}']::uuid[]`]) {
    deniedSql(`recipe_api.source_history(${invalid})`,'invalid_input');
  }
  for(const index of [0,1,2,3,4]) {
    const args=[...credentials,encodedPayload,"'accept'"];args[index]='null';
    deniedSql(`recipe_api.possess_authoring('${id}',${args.join(',')})`,index<3||index===4?'invalid_operation_proof':'invalid_input');
  }
  const material=[q(JSON.stringify(registration))+'::jsonb',...Array(3).fill("decode('"+'11'.repeat(32)+"','hex')"),String(Date.now()+10000)];
  for(const invalid of ['null',"'null'::jsonb","'[]'::jsonb","'1'::jsonb","'{}'::jsonb",
      ...Object.keys(registration).map(field=>q(JSON.stringify({...registration,[field]:null}))+'::jsonb')]) {
    deniedSql(`recipe_api.register_authoring('${operationId()}',${invalid})`,'invalid_input');
  }
  const stageRequest={stage:'accept',payloadDigest:cap.payloadDigest,stateRevision:2};
  for(const invalid of ['null',"'null'::jsonb","'1'::jsonb","'[]'::jsonb","'{}'::jsonb",
      ...Object.keys(stageRequest).map(field=>q(JSON.stringify({...stageRequest,[field]:null}))+'::jsonb')]) {
    deniedSql(`recipe_api.authoring_context('${id}',${invalid})`,'invalid_input');
  }
  material[0]=q(JSON.stringify(stageRequest))+'::jsonb';
  for(const index of [1,2,3,4]) {
    const args=[...material];args[index]='null';
    deniedSql(`recipe_api.authorize_authoring('${id}',${args.join(',')})`,'invalid_input');
  }
  const first=await accept(cap,body);
  assert.deepEqual(await accept(cap,body),first);
  assert.deepEqual(await cancel(id),first);
  assert.deepEqual(await recover(id),first);
  assert.deepEqual(await register(id),first);
  assert.equal(first.revision,1);
  const draft=await request('/drafts/'+first.draftId,{token:author});
  assert.deepEqual(draft.public,body.public);
  assert.deepEqual(draft.config,body.config);
  assert.equal(sql(`select count(*) from recipe_private.authoring_capabilities where operation_id='${id}'`),'2');
  assert.equal(sql(`select count(*) from recipe_private.drafts where id='${first.draftId}'`),'1');
  assert.equal(sql(`select receipt::text like '%SELECTED-ROLE%' from recipe_private.authoring_operations where id='${id}'`),'f');
  const changed=await request('/drafts/'+draft.draftId,{method:'PATCH',token:author,revision:1,body:completeBody});
  assert.equal(changed.revision,2);
  assert.deepEqual(await accept(cap,body),first);
  const published=await request('/drafts/'+draft.draftId+'/publish',{method:'POST',token:author,revision:2,body:{}});
  assert.ok(published.versionId);
  assert.deepEqual(await accept(cap,body),first);
  assert.deepEqual(await dispatch(initial),{operationId:id,status:'dispatched',stateRevision:2});
  const beforeCancel=operationId();assert.equal((await cancel(beforeCancel)).status,'cancelled');
  await register(beforeCancel,{},author,409);
  const afterRegister=await register();assert.equal((await cancel(afterRegister.operationId)).status,'cancelled');
  await authorize(afterRegister.operationId,'dispatch',1,DISPATCH_DIGEST,author,409);

  const fresh=await register();const oldCap=await authorize(fresh.operationId,'dispatch',1,DISPATCH_DIGEST);
  sql(`update recipe_private.authoring_capabilities set deadline=0 where operation_id='${fresh.operationId}'`);
  await dispatch(oldCap,410);
  await authorize(fresh.operationId,'dispatch',1,DISPATCH_DIGEST,jwt(authorSubject,{exp:1}),401);
  const renewed=await authorize(fresh.operationId,'dispatch',1,DISPATCH_DIGEST,jwt(authorSubject));
  assert.notEqual(renewed.ticket,oldCap.ticket);
  await dispatch(oldCap,403);await dispatch(renewed);
  const final=await authorize(fresh.operationId,'accept',2,sha256(payloadBytes(body)).toString('hex'));
  sql(`update recipe_private.authoring_capabilities set deadline=0 where operation_id='${fresh.operationId}' and stage='accept'`);
  await accept(final,body,410);
  const finalRenewed=await authorize(fresh.operationId,'accept',2,final.payloadDigest,jwt(authorSubject));
  await accept(final,body,403);const finalReceipt=await accept(finalRenewed,body);
  await service.close();service=await startRecipeService(env);
  assert.deepEqual(await accept(finalRenewed,body),finalReceipt);
  assert.deepEqual(await request('/authoring/'+fresh.operationId,{token:jwt(authorSubject)}),finalReceipt);

  for(const interval of ['1 second','8 days']) {
    const expiredDispatch=await dispatched();
    sql(`update recipe_private.authoring_capabilities set deadline=0 where operation_id='${expiredDispatch.op.operationId}'`);
    assert.deepEqual(await dispatch(expiredDispatch.cap),{operationId:expiredDispatch.op.operationId,status:'dispatched',stateRevision:2});
    sql(`update recipe_private.authoring_operations set expires_at=clock_timestamp()-interval '${interval}' where id='${expiredDispatch.op.operationId}'`);
    await dispatch(expiredDispatch.cap,410);
  }
  const acceptedRecovery=await ready(body);
  const acceptedReceipt=await accept(acceptedRecovery.cap,body);
  sql(`update recipe_private.authoring_operations set expires_at=clock_timestamp()-interval '8 days' where id='${acceptedRecovery.op.operationId}';
    update recipe_private.authoring_capabilities set deadline=0 where operation_id='${acceptedRecovery.op.operationId}'`);
  assert.deepEqual(await accept(acceptedRecovery.cap,body),acceptedReceipt);
  await dispatch(acceptedRecovery.dispatchCap,410);
  sql(`update recipe_private.authoring_operations set terminal_at=clock_timestamp()-interval '8 days' where id='${acceptedRecovery.op.operationId}'`);
  await accept(acceptedRecovery.cap,body,410);

  const expired=await register();
  sql(`update recipe_private.authoring_operations set expires_at=clock_timestamp()-interval '1 second' where id='${expired.operationId}'`);
  assert.equal((await request('/authoring/'+expired.operationId,{token:author})).status,'expired');
  await register(expired.operationId,{},author,410);
  await register(operationId(Date.now()-300001),{},author,410);
  await cancel(operationId(Date.now()+121000),author,422);
  const ancient=operationId(Date.now()-9*86400000);
  sql(`update recipe_private.authoring_operations set id='${ancient}',terminal_at=clock_timestamp()-interval '8 days' where id='${expired.operationId}'`);
  await cancel(operationId());assert.equal(sql(`select count(*) from recipe_private.authoring_operations where id='${ancient}'`),'0');
  await register(ancient,{},author,410);

  // A committed draft survives pruning of its operation. The negative assertion says nothing about past saves.
  const pastId=operationId(Date.now()-8*86400_000);
  const retained=await ready(body);
  const saved=await accept(retained.cap,body);
  sql(`delete from recipe_private.authoring_capabilities where operation_id='${retained.op.operationId}';
    update recipe_private.authoring_operations set id='${pastId}',receipt=jsonb_set(receipt,'{operationId}',to_jsonb('${pastId}'::text)),
      terminal_at=clock_timestamp()-interval '6 days' where id='${retained.op.operationId}'`);
  assert.deepEqual(await recover(pastId),{...saved,operationId:pastId});
  await recover(pastId,other,404);
  sql(`update recipe_private.authoring_operations set terminal_at=clock_timestamp()-interval '7 days 1 second' where id='${pastId}'`);
  assert.deepEqual(await recover(pastId),closedId(pastId));
  assert.equal((await request('/drafts/'+saved.draftId,{token:author})).revision,saved.revision);
  await register(pastId,{},author,410);
  const editDraft=await request('/drafts',{method:'POST',token:author,body:completeBody});
  const patch={schemaVersion:1,draftId:editDraft.draftId,baseRevision:1,changes:[{op:'setDraftRole',value:'PATCHED-ROLE'},{op:'setPublicText',field:'summary',value:'新简介'}]};
  const edit=await ready(patch,{purpose:'editDraft',draftId:editDraft.draftId,baseRevision:1});
  await register(operationId(),{purpose:'editDraft',draftId:editDraft.draftId,baseRevision:1},author,409);
  await register(operationId(),{purpose:'editDraft',draftId:editDraft.draftId,baseRevision:1},other,404);
  const patchReceipt=await accept(edit.cap,patch);
  assert.equal(patchReceipt.revision,2);
  const secondPatch={...patch,baseRevision:2,changes:[{op:'setSetup',value:null}]};
  const patchKey=operationId();
  const appReceipt=await request('/drafts/'+editDraft.draftId+'/patch',{method:'POST',token:author,key:patchKey,body:secondPatch});
  assert.equal(appReceipt.revision,3);
  assert.deepEqual(await accept(edit.cap,patch),patchReceipt);
  assert.deepEqual(await request('/drafts/'+editDraft.draftId+'/patch',{method:'POST',token:author,key:patchKey,body:secondPatch}),appReceipt);
  await request('/drafts/'+editDraft.draftId+'/patch',{method:'POST',token:author,key:patchKey,body:{...secondPatch,changes:[{op:'setDraftRole',value:'different'}]},status:409});
  await request('/drafts/'+editDraft.draftId+'/publish',{method:'POST',token:author,revision:3,body:{}});
  assert.deepEqual(await accept(edit.cap,patch),patchReceipt);
  assert.deepEqual(await request('/drafts/'+editDraft.draftId+'/patch',{method:'POST',token:author,key:patchKey,body:secondPatch}),appReceipt);
  assert.equal(sql(`select result::text like '%PATCHED-ROLE%' from recipe_private.receipts where request_id='${patchKey}'`),'f');
  assert.equal(sql("select has_table_privilege('recipe_api','recipe_private.authoring_operations','SELECT') or has_table_privilege('recipe_api','recipe_private.authoring_capabilities','INSERT')"),'f');

  const blocker=new pg.Client({host:sock,port:5432,database:'postgres',user:'bootstrap_test'});
  const observer=new pg.Client({host:sock,port:5432,database:'postgres',user:'bootstrap_test'});
  await blocker.connect();await observer.connect();
  async function waiting(fragment) {
    for(let i=0;i<200;i++) {
      const result=await observer.query("select count(*) from pg_stat_activity where application_name='vonvon-recipe-api' and wait_event_type='Lock' and query like $1",['%'+fragment+'%']);
      if(Number(result.rows[0].count))return;await delay(5);
    }
    assert.fail('missing row lock waiter '+fragment);
  }
  const lock=async()=>{await blocker.query('BEGIN');await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,187511))',[account]);};
  try {
    // Both queries start while a UUID is still fresh and finish after its registration window closes.
    // An uncommitted real registration wins; only the absent ID can receive the negative assertion.
    const birth=Date.now()-298500, concurrent=operationId(birth), absent=operationId(birth);
    await lock();
    await blocker.query("select set_config('app.recipe_account',$1,true)",[account]);
    const registered=await blocker.query('select recipe_api.register_authoring($1,$2) as result',[concurrent,registration]);
    const checked=recover(concurrent);
    await waiting('recover_authoring');
    // Use a second SQL connection with the actor set to bypass the HTTP identity lock, but retain the actual operation lock.
    const checker=new pg.Client({host:sock,port:5432,database:'postgres',user:'bootstrap_test',application_name:'vonvon-recipe-api'});
    await checker.connect();
    try {
      await checker.query('begin');
      await checker.query("select set_config('app.recipe_account',$1,true)",[account]);
      const unknown=checker.query('select recipe_api.recover_authoring($1) as absent_check',[absent]);
      await waiting('absent_check');
      assert.ok(Date.now()<birth+300000);
      await delay(Math.max(0,birth+300002-Date.now()));
      await blocker.query('COMMIT');
      assert.deepEqual(await checked,registered.rows[0].result);
      assert.deepEqual((await unknown).rows[0].absent_check,closedId(absent));
      await checker.query('commit');
    } finally {await checker.end();}
    await cancel(concurrent);
    const deadlineRace=await dispatched();
    await blocker.query('BEGIN');
    const changedDeadline=await blocker.query(`update recipe_private.authoring_operations
      set expires_at=clock_timestamp()+interval '1500 milliseconds' where id=$1
      returning floor(extract(epoch from expires_at)*1000)::bigint as deadline`,[deadlineRace.op.operationId]);
    const deadline=Number(changedDeadline.rows[0].deadline);
    const expiredReplay=dispatch(deadlineRace.cap,410);
    await waiting('possess_authoring');
    assert.ok(Date.now()<deadline);
    while(Date.now()<=deadline)await delay(Math.min(20,deadline-Date.now()+1));
    await blocker.query('COMMIT');
    await expiredReplay;
    for(const cancelFirst of [true,false]) {
      const operation=await ready(body);
      await lock();
      const winner=cancelFirst?cancel(operation.op.operationId):accept(operation.cap,body);
      await waiting(cancelFirst?'cancel_authoring':'possess_authoring');
      const loser=cancelFirst?accept(operation.cap,body,409):cancel(operation.op.operationId);
      await blocker.query('COMMIT');
      const won=await winner,lost=await loser;
      if(cancelFirst)assert.equal(won.status,'cancelled');else assert.deepEqual(lost,won);
    }
    for(const publishFirst of [true,false]) {
      const d=await request('/drafts',{method:'POST',token:author,body:completeBody});
      const change={...patch,draftId:d.draftId,changes:[{op:'setDraftRole',value:'RACE-ROLE'}]};
      const operation=await ready(change,{purpose:'editDraft',draftId:d.draftId,baseRevision:1});
      const publish=status=>request('/drafts/'+d.draftId+'/publish',{method:'POST',token:author,body:{},revision:1,status});
      await lock();const winner=publishFirst?publish(200):accept(operation.cap,change);
      await waiting(publishFirst?'publish_draft':'possess_authoring');
      const loser=publishFirst?accept(operation.cap,change,409):publish(409);
      await blocker.query('COMMIT');await winner;await loser;
      await cancel(operation.op.operationId);
    }
    const disabled=await ready(body);
    await blocker.query('BEGIN');await blocker.query("update recipe_private.accounts set status='disabled' where id=$1",[account]);
    const denied=accept(disabled.cap,body,403);await waiting('possess_authoring');await blocker.query('COMMIT');await denied;
    sql(`update recipe_private.accounts set status='active' where id='${account}'`);await cancel(disabled.op.operationId);
  } finally {await blocker.query('ROLLBACK');await blocker.end();await observer.end();}

  const quota=jwt(randomUUID());
  const competition=await Promise.all(Array.from({length:8},async()=>{
    const operation=operationId();
    const res=await fetch('http://127.0.0.1:'+service.server.address().port+'/v1/authoring/'+operation+'/register',{
      method:'POST',headers:{authorization:'Bearer '+quota,'content-type':'application/json'},body:JSON.stringify(registration)});
    assert.ok([200,429].includes(res.status));return {status:res.status,body:await res.json()};
  }));
  assert.equal(competition.filter(result=>result.status===200).length,3);
  for(const result of competition.filter(result=>result.status===200))await cancel(result.body.operationId,quota);
  const quotaAccount=(await request('/me',{token:quota})).accountId;
  const count=Number(sql(`select count(*) from recipe_private.authoring_operations where account_id='${quotaAccount}'`));
  for(let i=count;i<60;i++)await cancel(operationId(),quota);
  await cancel(operationId(),quota,429);
  const typedQuota=jwt(randomUUID());const typedAccount=(await request('/me',{token:typedQuota})).accountId;
  const typedDraft=await request('/drafts',{method:'POST',token:typedQuota,body:completeBody});
  sql(`insert into recipe_private.receipts(actor,action,request_id,digest,result) select '${typedAccount}','patch',gen_random_uuid(),decode(repeat('11',32),'hex'),'{}'::jsonb from generate_series(1,600)`);
  await request('/drafts/'+typedDraft.draftId+'/patch',{method:'POST',token:typedQuota,body:{...patch,draftId:typedDraft.draftId},status:429});
  sql(`update recipe_private.receipts set created_at=clock_timestamp()-interval '8 days' where actor='${typedAccount}'`);
  await request('/drafts/'+typedDraft.draftId+'/patch',{method:'POST',token:typedQuota,body:{...patch,draftId:typedDraft.draftId}});
  assert.equal(sql(`select count(*) from recipe_private.receipts where actor='${typedAccount}' and action='patch'`),'1');
  assert.equal(sql(`select count(*) from recipe_private.authoring_operations where account_id='${quotaAccount}'`),'60');
  assert.equal(sql(`select to_jsonb(o)::text like '%SELECTED-ROLE%' from recipe_private.authoring_operations o where id='${id}'`),'f');
  assert.equal(sql(`select count(*) from recipe_private.versions where config->>'role'='RACE-ROLE'`),'0');
  console.log('PASS: PostgreSQL 15 + HTTP authoring registration, stage isolation, exact canonical bytes, X25519 possession, renewal, restart, stable receipts, one proposal, cancellation/publication/disable races, quotas, retention, private source history across migration and device publication, private fields.');
} finally {
  try {await service?.close();if(issuerServer)await new Promise(resolve=>issuerServer.close(resolve));}
  finally {if(up)command('pg_ctl',['-D',db,'-m','fast','-w','stop']);rmSync(tmp,{recursive:true,force:true});}
}
