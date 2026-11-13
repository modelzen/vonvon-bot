import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { createObjectBroker } from '../src/object-broker.mjs';
import { createObjectStore } from '../src/object-store.mjs';

const bin = process.env.PG_BINDIR || execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const dir = mkdtempSync(join(tmpdir(),'recipe-objects-'));
const socket = join(dir,'socket');
const cmd = (exe,args) => execFileSync(join(bin,exe),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sqlFiles = fileURLToPath(new URL('../../../supabase/migrations',import.meta.url));
let started = false;
let api, verifier, admin;
function operationId() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(),0,6); bytes[6] = (bytes[6]&15)|112; bytes[8] = (bytes[8]&63)|128;
  const h = bytes.toString('hex');
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');
}
const sha = b => createHash('sha256').update(b).digest('hex');
const info = (ordinal,bytes,kind='text') => ({ordinal,kind,bytes:bytes.length,sha256:sha(bytes)});
const expect = (p,reason) => assert.rejects(p,e => e.message === reason);
try {
  mkdirSync(socket,{mode:0o700});
  cmd('initdb',['-D',join(dir,'db'),'-U','object_test','--encoding=UTF8','--locale=C','--auth=trust']);
  cmd('pg_ctl',['-D',join(dir,'db'),'-l',join(dir,'log'),'-w','-o',"-k '"+socket+"' -c listen_addresses='' -c unix_socket_permissions=0700",'start']);
  started = true;
  for (const f of readdirSync(sqlFiles).filter(s=>s.endsWith('.sql')).sort()) {
    cmd('psql',['-h',socket,'-p','5432','-d','postgres','-U','object_test','-Xq','-1','-v','ON_ERROR_STOP=1','-f',join(sqlFiles,f)]);
  }
  const pool = user => new pg.Pool({host:socket,port:5432,user,database:'postgres',max:8,connectionTimeoutMillis:3000});
  admin = pool('object_test');
  await admin.query('create role api_login login noinherit; grant recipe_api to api_login; create role verifier_login login noinherit; grant recipe_object_verifier to verifier_login; create role anon; create role authenticated');
  api = pool('api_login'); verifier = pool('verifier_login');
  const [owner,other,draft] = Array.from({length:3},randomUUID);
  await admin.query('insert into recipe_private.accounts(id) values($1),($2)',[owner,other]);
  async function actorCall(actor,sql,args) {
    const c = await api.connect();
    try {
      await c.query('begin'); await c.query('set local role recipe_api');
      await c.query("select set_config('app.recipe_account',$1,true)",[actor]);
      const {rows} = await c.query(sql,args);
      await c.query('commit'); return rows[0]?.result;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  const reserve = (id,cap,d=draft,a=owner) => actorCall(a,'select recipe_api.reserve_object_package($1,$2,$3) as result',[id,d,cap]);
  const cancel = (id) => actorCall(owner,'select recipe_api.cancel_object_package($1)',[id]);
  await expect(createObjectStore(admin),'object_verifier_login_required');
  await expect(createObjectStore(api),'object_verifier_login_required');
  const store = await createObjectStore(verifier);
  await admin.query("create schema storage; create table storage.buckets(id text primary key,public boolean); create table storage.objects(bucket_id text,name text); alter table storage.buckets enable row level security; alter table storage.objects enable row level security; insert into storage.buckets values('recipe-private',false)");
  cmd('psql',['-h',socket,'-d','postgres','-U','object_test','-Xq','-1','-v','ON_ERROR_STOP=1','-f',
    fileURLToPath(new URL('../src/object-storage-absence.sql',import.meta.url))]);
  const metadataKey='temp/'+randomUUID();
  assert.equal(await store.call('storage_absent','recipe-private',metadataKey),true);
  await admin.query("insert into storage.objects values('recipe-private',$1)",[metadataKey]);
  assert.equal(await store.call('storage_absent','recipe-private',metadataKey),false);
  assert.equal(await store.call('storage_absent','other',metadataKey),false);
  const data = new Map();
  let writes = 0;
  const storage = {
    async create(id,lane,value) {
      const k=lane+'/'+id;
      if (data.has(k)) throw new Error('duplicate_storage_create');
      data.set(k,Buffer.from(value)); writes++;
    },
    async read(id,lane) { return data.get(lane+'/'+id) ?? null; },
    async remove(id,lane) { data.delete(lane+'/'+id); },
  };
  const broker = createObjectBroker({store,storage});
  for (const r of ['recipe_api','api_login','anon','authenticated']) {
    const {rows:[priv]} = await admin.query("select has_schema_privilege($1,'recipe_objects','usage') or has_function_privilege($1,'recipe_objects.ready(uuid,uuid,integer)','execute') or has_table_privilege($1,'recipe_private.object_attempts','update') as forged",[r]);
    assert.equal(priv.forged,false);
  }
  const id=operationId(), body=Buffer.from('参考文本');
  await Promise.all([reserve(id,4194304),reserve(id,4194304)]);
  await expect(reserve(id,4194303),'conflict');
  await expect(reserve(id,4194304,draft,other),'not_found');
  await expect(reserve(operationId(),1),'object_capacity');
  await expect(broker.receive(other,id,info(0,body),body),'not_found');
  const files=[];
  for (let n=0;n<64;n++) {
    const content=Buffer.from('file '+n);
    files.push(await broker.receive(owner,id,info(n,content),content));
  }
  const count=writes;
  assert.deepEqual(await broker.receive(owner,id,info(63,Buffer.from('file 63')),null),files[63]);
  assert.equal(writes,count);
  await expect(broker.receive(owner,id,info(64,body),body),'quota_exceeded');
  const inv=await store.call('inventory',owner,id);
  assert.equal(inv.actorHeld,4194304);
  assert.equal((await actorCall(owner,'select recipe_api.object_capacity() as result',[])).heldBytes,4194304);
  assert.equal(inv.members.filter(m=>m.state==='ready' && m.temp==='gone' && !m.inFlight).length,64);
  const makeDraft=async (d,who) => admin.query("insert into recipe_private.drafts(id,owner_id,recipe_id,revision,base_revision,public_info,config,bytes) values($1,$2,$3,1,0,'{}','{}',512)",[d,who,randomUUID()]);
  await makeDraft(draft,owner);
  const foreign=randomUUID(); await makeDraft(foreign,other);
  await expect(admin.query('insert into recipe_private.object_draft_refs values($1,$2)',[foreign,files[0].objectId]),'not_found');
  const attach = async (confirm, ids) => {
    const c=await admin.connect();
    try {
      await c.query('begin'); await c.query("select set_config('app.recipe_account',$1,true)",[owner]);
      await c.query('select recipe_private.attach_object_package($1,$2,$3)',[id,draft,ids]);
      await c.query(confirm?'commit':'rollback');
    } finally { await c.query('rollback'); c.release(); }
  };
  const ids=files.map(f=>f.objectId);
  await expect(attach(true,ids.slice(1)),'object_unavailable');
  await attach(false,ids);
  assert.equal((await store.call('inventory',owner,id)).actorHeld,4194304);
  await attach(true,ids); await attach(true,ids);
  assert.equal((await store.call('inventory',owner,id)).actorHeld,0);
  assert.equal((await broker.collect(owner,id)).pending.length,64);

  const version=randomUUID(), recipe=randomUUID(), pin=randomUUID();
  await admin.query('insert into recipe_private.recipes(id,owner_id) values($1,$2)',[recipe,owner]);
  await admin.query("insert into recipe_private.versions(id,recipe_id,owner_id,revision,public_info,config,bytes) values($1,$2,$3,1,'{}','{}',512)",[version,recipe,owner]);
  await admin.query('insert into recipe_private.object_version_refs values($1,$2)',[version,ids[0]]);
  await store.call('pin_backup',owner,id,1,pin,true);
  const full=operationId();
  await reserve(full,4194304);
  await expect(admin.query('delete from recipe_private.object_draft_refs where draft_id=$1',[draft]),'object_capacity');
  await cancel(full); await broker.collect(owner,full);
  await admin.query('delete from recipe_private.object_draft_refs where draft_id=$1',[draft]);
  assert.deepEqual((await broker.collect(owner,id)).pending.map(m=>m.ordinal),[0,1]);
  assert.ok(data.has('final/'+ids[0]) && data.has('final/'+ids[1]));
  await store.call('pin_backup',owner,id,1,pin,false);
  await store.call('begin_delete',owner,id,1,'final');
  await expect(admin.query('insert into recipe_private.object_version_refs values($1,$2)',[version,ids[1]]),'object_unavailable');
  await broker.collect(owner,id);
  assert.equal((await store.call('inventory',owner,id)).actorHeld,0);

  const held=await broker.collect(owner,id);
  assert.deepEqual(held.pending,[{ordinal:0,reason:'object_held'}]);
  await admin.query("update recipe_private.accounts set status='disabled' where id=$1",[other]);
  await expect(reserve(operationId(),50,randomUUID(),other),'account_disabled');
  const active=operationId();
  await reserve(active,300);
  let release;
  const paused = new Promise(r=>{release=r;});
  let startedWrites=0, two;
  const both=new Promise(r=>{two=r;});
  const delayed=createObjectBroker({store,storage:{...storage,async create(...args) {
    if(args[1]==='temp') { startedWrites++; if(startedWrites===2)two(); await paused; }
    return storage.create(...args);
  }}});
  const inFlight=[0,1].map(n=>delayed.receive(owner,active,info(n,body),body));
  await both;
  await expect(delayed.receive(owner,active,info(2,body),body),'object_stream_limit');
  await cancel(active);
  const collecting=await broker.collect(owner,active);
  assert.deepEqual(collecting.pending.map(p=>p.reason),['object_member_busy','object_member_busy']);
  assert.equal(collecting.inventory.actorHeld,300);
  release();
  assert.deepEqual((await Promise.allSettled(inFlight)).map(x=>x.reason.message),['operation_expired','operation_expired']);
  assert.equal((await broker.collect(owner,active)).inventory.actorHeld,0);

  const late=operationId();
  await reserve(late,4194304);
  let remote;
  const ambiguous=createObjectBroker({store,storage:{...storage,async create(...args){
    if(args[1]==='final') { remote=()=>storage.create(...args); throw new Error('lost_response'); }
    return storage.create(...args);
  }}});
  await expect(ambiguous.receive(owner,late,info(0,body),body),'lost_response');
  await cancel(late);
  const blocked=await broker.collect(owner,late);
  assert.deepEqual(blocked.pending,[{ordinal:0,reason:'object_write_uncertain'}]);
  assert.equal(blocked.inventory.actorHeld,4194304);
  await expect(reserve(operationId(),1),'object_capacity');
  await remote();
  assert.equal((await broker.collect(owner,late)).inventory.state,'closed');
  assert.equal((await store.call('inventory',owner,late)).actorHeld,0);
  await expect(broker.receive(owner,late,info(0,body),body),'operation_expired');

  const noSend=operationId();
  await reserve(noSend,200);
  await store.call('open_member',owner,noSend,0,'text',body.length,sha(body));
  await store.call('start_write',owner,noSend,0,'temp',body.length,sha(body));
  await cancel(noSend);
  assert.equal((await broker.collect(owner,noSend)).inventory.actorHeld,200);
  await broker.reconcileQuiescent(owner,noSend,0,'temp',sha(Buffer.from('synthetic upstream drained receipt')));
  assert.equal((await broker.collect(owner,noSend)).inventory.actorHeld,0);
  assert.equal((await admin.query('select count(*)::int n from recipe_private.object_quiescence')).rows[0].n,1);
  const logo=await sharp({create:{width:50,height:100,channels:4,background:'red'}}).png().toBuffer();
  const low=operationId();
  await reserve(low,logo.length+131071);
  await expect(broker.receive(owner,low,info(0,logo,'finalLogo'),logo),'object_capacity');
  await cancel(low); await broker.collect(owner,low);
  const logoOp=operationId();
  await reserve(logoOp,2097152+131072);
  await expect(reserve(operationId(),2097152+131072),'object_capacity');
  const normalized=await broker.receive(owner,logoOp,info(0,logo,'finalLogo'),logo);
  assert.equal(normalized.kind,'finalLogo');
  assert.equal(normalized.mediaType,'image/webp');
  assert.ok(normalized.bytes<=131072 && normalized.sha256!==sha(logo));
  await expect(broker.receive(owner,logoOp,info(1,logo,'finalLogo'),logo),'conflict');
  let allowed=true;
  const reader=createObjectBroker({store,storage,authorizeRead:async ({releaseId}) =>
    allowed && releaseId===version ? normalized : null});
  assert.equal(sha(await reader.readAuthorized({releaseId:version})),normalized.sha256);
  allowed=false;
  await expect(reader.readAuthorized({releaseId:version}),'not_found');
  await cancel(logoOp); await broker.collect(owner,logoOp);

  const bad=operationId(), binary=Buffer.from([255]);
  await reserve(bad,100);
  await expect(broker.receive(owner,bad,info(0,binary),binary),'invalid_object_text');
  await expect(broker.receive(owner,bad,info(1,body),Buffer.concat([body,body])),'object_too_large');
  await expect(broker.receive(owner,bad,info(2,body,'manifest'),body),'manifest_codec_unavailable');
  await cancel(bad); await broker.collect(owner,bad);
  const faulty=operationId();
  await reserve(faulty,100);
  const wrongRead=createObjectBroker({store,storage:{...storage,async read(id,lane,cap){
    const bytes=await storage.read(id,lane,cap);
    return lane==='final' && bytes ? Buffer.alloc(bytes.length) : bytes;
  }}});
  await expect(wrongRead.receive(owner,faulty,info(0,body),body),'object_integrity');
  assert.equal((await store.call('inventory',owner,faulty)).members[0].state,'preparing');
  const recovered=await broker.receive(owner,faulty,info(0,body),null);
  assert.equal(recovered.sha256,sha(body));
  await cancel(faulty);
  let deferDelete=true;
  const lostDelete=createObjectBroker({store,storage:{...storage,async remove(...args){
    if(deferDelete) {deferDelete=false;return;} return storage.remove(...args);
  }}});
  assert.deepEqual((await lostDelete.collect(owner,faulty)).pending,[{ordinal:0,reason:'object_delete_pending'}]);
  assert.equal((await store.call('inventory',owner,faulty)).actorHeld,100);
  assert.equal((await broker.collect(owner,faulty)).inventory.actorHeld,0);

  const expired=operationId();
  await reserve(expired,100);
  await store.call('open_member',owner,expired,0,'text',body.length,sha(body));
  await store.call('start_write',owner,expired,0,'temp',body.length,sha(body));
  await admin.query("update recipe_private.object_packages set deadline=clock_timestamp()-interval '1 second' where id=$1",[expired]);
  assert.equal((await broker.collect(owner,expired)).inventory.state,'closing');
  await broker.reconcileQuiescent(owner,expired,0,'temp',sha(Buffer.from('synthetic timed out request drained')));
  assert.equal((await broker.collect(owner,expired)).inventory.actorHeld,0);
  console.log('PASS private objects: PG migrations and restricted roles, aggregate 64 parts, CAS rollback, draft/history/pin GC, two ingress, late remote completion and quiescence evidence.');
} finally {
  await Promise.all([api,verifier,admin].filter(Boolean).map(p=>p.end()));
  if (started) cmd('pg_ctl',['-D',join(dir,'db'),'-m','fast','-w','stop']);
  rmSync(dir,{recursive:true,force:true});
}
