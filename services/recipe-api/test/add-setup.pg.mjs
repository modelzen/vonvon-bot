import assert from 'node:assert/strict';
import {createHash,randomUUID,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import sharp from 'sharp';
import {startRecipeService} from '../src/main.mjs';
import {createRichBrokerServer} from '../src/rich-broker.mjs';
import {createObjectStore} from '../src/object-store.mjs';
import {createVerifier} from '../src/auth.mjs';
import {richInstallProof} from '../src/rich-install-proof.mjs';
import {installProof} from '../src/install-proof.mjs';
import {richProof} from '../src/rich-proof.mjs';
import {inventory} from '../src/rich-document.mjs';
import {authoringProof,DISPATCH_DIGEST} from '../src/authoring-proof.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),folders=join(root,'supabase/migrations');
const dir=mkdtempSync(join(tmpdir(),'vv-rich-cloud-')),sock=join(dir,'s'),db=join(dir,'db');
const bin=process.env.PG_BINDIR??execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const run=(name,args)=>execFileSync(join(bin,name),args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const sql=s=>run('psql',['-XAtq','-h',sock,'-p','5432','-U','cloud_test','-d','postgres','-v','ON_ERROR_STOP=1','-c',s]).trim();
const sha=b=>createHash('sha256').update(b).digest();
const opId=()=>{const h=Date.now().toString(16).padStart(12,'0'),id=randomUUID();return h.slice(0,8)+'-'+h.slice(8)+'-7'+id.slice(15);};
const b64=b=>Buffer.from(b).toString('base64url');
const listen=s=>new Promise((resolve,reject)=>s.once('error',reject).listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>s.close(resolve));
const orig=s=>'http://127.0.0.1:'+s.address().port;
let pgUp=false,api,broker,issuerServer,pool;
try{
  mkdirSync(sock,{mode:0o700});run('initdb',['-D',db,'-U','cloud_test','--encoding=UTF8','--locale=C','--auth=trust']);
  run('pg_ctl',['-D',db,'-l',join(dir,'log'),'-w','-o',"-k '"+sock+"' -p 5432 -c listen_addresses='' -c unix_socket_permissions=0700",'start']);pgUp=true;
  const files=readdirSync(folders).filter(f=>f.endsWith('.sql')).sort();
  const apply=f=>run('psql',['-h',sock,'-p','5432','-U','cloud_test','-d','postgres','-Xq','-1','-v','ON_ERROR_STOP=1','-f',join(folders,f)]);
  const firstRich=files.findIndex(f=>f.endsWith('_recipe_rich_cloud.sql'));assert.ok(firstRich>=0);files.slice(0,firstRich).forEach(apply);
  sql('create role main_test login noinherit; grant recipe_api to main_test; create role verifier_test login noinherit; grant recipe_object_verifier to verifier_test');
  const pair=generateKeyPairSync('ec',{namedCurve:'P-256'}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'rich-pg',alg:'ES256',use:'sig'};
  issuerServer=createServer((req,res)=>res.end(JSON.stringify({keys:[jwk]})));await listen(issuerServer);
  const issuer=orig(issuerServer)+'/auth/v1', jwt=subject=>{
    const h=b64(JSON.stringify({alg:'ES256',kid:'rich-pg'}))+'.'+b64(JSON.stringify({iss:issuer,aud:'authenticated',role:'authenticated',
      sub:subject,exp:Math.floor(Date.now()/1000)+900}));return h+'.'+b64(sign('sha256',Buffer.from(h),{key:pair.privateKey,dsaEncoding:'ieee-p1363'}));
  };
  const a=jwt(randomUUID()),b=jwt(randomUUID());
  const env={RECIPE_AUTH_ISSUER:issuer,RECIPE_DATABASE_URL:'postgresql://main_test@localhost/postgres?host='+encodeURIComponent(sock)+'&port=5432',
    RECIPE_CODE_KEY:randomBytes(32).toString('hex'),RECIPE_RICH_WRITES:'1',PORT:'0'};
  api=await startRecipeService(env);
  pool=new pg.Pool({user:'verifier_test',database:'postgres',host:sock,port:5432});
  const bytes=new Map(),storage={async create(id,lane,v){const k=lane+id;assert.ok(!bytes.has(k));bytes.set(k,Buffer.from(v));},
    async read(id,lane){return bytes.get(lane+id)??null;},async remove(id,lane){bytes.delete(lane+id);}};
  broker=createRichBrokerServer({verify:createVerifier(issuer),store:await createObjectStore(pool),storage,admit:true});await listen(broker);
  async function req(path,token,body,{status=200,key,rev,method}={}){
    const headers={};if(token)headers.authorization='Bearer '+token;if(body!==undefined)headers['content-type']='application/json';
    if(key)headers['idempotency-key']=key;if(rev)headers['if-match']='"'+rev+'"';
    const r=await fetch(orig(api.server)+path,{method:method??(body!==undefined?'POST':'GET'),headers,body:body===undefined?undefined:JSON.stringify(body)});
    const out=await r.json();assert.equal(r.status,status,path+' '+JSON.stringify(out.error));return out;
  }
  async function upload(token,pkg,idx,kind,buf,status=200) {
    const r=await fetch(orig(broker)+'/v2/objects/'+pkg+'/members/'+idx,{method:'PUT',headers:{authorization:'Bearer '+token,
      'content-type':'application/octet-stream','x-recipe-kind':kind,'x-recipe-sha256':sha(buf).toString('hex')},body:buf});
    const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j;
  }
  async function read(token,scope,target,obj,status=200){
    const r=await fetch(orig(broker)+'/v2/'+scope+'/'+target+'/objects/'+obj,{headers:token?{authorization:'Bearer '+token}:{}});
    assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal(r.status,status);
    return Buffer.from(await r.arrayBuffer());
  }
  const account=(await req('/v1/me',a)).accountId,reader=(await req('/v1/me',b)).accountId;
  const legacyKey=generateKeyPairSync('x25519'),legacyNonce=randomBytes(32),legacyDevice={
    targetPublicKey:b64(legacyKey.publicKey.export({type:'spki',format:'der'}).subarray(-32)),nonceCommitment:b64(sha(legacyNonce))};
  const legacyDoc={public:{name:'legacy',summary:'legacy',overview:'字节',version:'1',access:'direct'},config:{role:'留存 legacy'}};
  const ld=await req('/v1/drafts',a,legacyDoc,{key:randomUUID()});
  const lv=await req('/v1/drafts/'+ld.draftId+'/publish',a,{}, {key:randomUUID(),rev:1});
  const historical=sql("select bytes::text||':'||encode(recipe_private.install_manifest(v),'hex') from recipe_private.versions v where id='"+lv.versionId+"'");
  const lp=await req('/v1/versions/'+lv.versionId+'/install-preview',a);
  const lid=opId(),li=await req('/v1/operations/'+lid+'/authorize',a,{purpose:'installBoundRole',generation:1,versionId:lv.versionId,
    manifestSha256:lp.manifestSha256,...legacyDevice});
  const lido=opId(),lo='/v1/authoring/'+lido;
  await req(lo+'/register',a,{purpose:'prepareDraft',...legacyDevice});
  const lc=await req(lo+'/authorize',a,{stage:'dispatch',stateRevision:1,payloadDigest:DISPATCH_DIGEST});
  files.slice(firstRich).forEach(apply);
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('recipe_api','recipe_objects','recipe_private') and p.proacl is not null and exists(select from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')"),'0');
  for (const role of ['recipe_api','recipe_object_verifier','recipe_editor']) assert.equal(sql("select has_table_privilege('"+role+"','recipe_private.rich_members','SELECT')"),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_api.rich_moderate(text,uuid,uuid)','EXECUTE')"),'f');
  assert.equal(sql("select has_function_privilege('recipe_api','recipe_objects.display_logo(uuid)','EXECUTE')"),'f');
  assert.equal(sql("select has_function_privilege('recipe_object_verifier','recipe_api.rich_publish(uuid,integer,uuid,bytea)','EXECUTE')"),'f');
  console.log('INDEPENDENT: table/private RPC/operator/verifier privilege separation verified');
  assert.equal(sql("select bytes::text||':'||encode(recipe_private.install_manifest(v),'hex') from recipe_private.versions v where id='"+lv.versionId+"'"),historical);
  const lred=await req('/v1/operations/'+lid+'/redeem',null,{ticket:li.ticket,nonce:b64(legacyNonce),proof:b64(installProof(legacyKey.privateKey,li))});
  assert.equal(lred.manifest,lp.manifest);
  await req(lo+'/dispatch',null,{ticket:lc.ticket,nonce:b64(legacyNonce),proof:b64(authoringProof(legacyKey.privateKey,lc))});
  await req(lo+'/cancel',a,{});
  const fixture=JSON.parse(readFileSync(join(root,'packages/protocol/test/fixtures/recipe-rich-v2.content.json'),'utf8'));
  delete fixture.finalLogo;fixture.parts=[];fixture.memories=[];
  fixture.rules.push({itemId:randomUUID(),originId:randomUUID(),purpose:'work',text:{kind:'inline',value:'私有规则'}});
  const own=c=>inventory(c).map(({itemId})=>({itemId,source:{kind:'accountClaim'}}));
  const body=(c,access='coded')=>({format:'rich-v2',content:c,access,origins:own(c)});
  async function start(token,edit={}){
    const op=opId(),pkg=opId(),device=generateKeyPairSync('x25519'),nonce=randomBytes(32);
    const reg={format:'rich-v2',purpose:'prepareDraft',targetPublicKey:b64(device.publicKey.export({type:'spki',format:'der'}).subarray(-32)),nonceCommitment:b64(sha(nonce)),...edit};
    const path='/v2/authoring/'+op;
    const register=await req(path+'/register',token,reg),draft=register.destinationDraftId;
    const cap=async(stage,digest)=>req(path+'/authorize',token,{stage,stateRevision:stage==='dispatch'?1:2,payloadDigest:digest});
    const possess=c=>({ticket:c.ticket,nonce:b64(nonce),proof:b64(richProof(device.privateKey,c))});
    const dispatch=await cap('dispatch',DISPATCH_DIGEST);await req('/v1/authoring/'+op+'/dispatch',null,possess(dispatch),{status:404});
    await req(path+'/dispatch',null,{...possess(dispatch),proof:b64(authoringProof(device.privateKey,dispatch))},{status:403});
    await req(path+'/dispatch',null,possess(dispatch));
    await req('/v2/objects/'+pkg+'/reserve',token,{draftId:draft,cap:250000});
    return {op,pkg,path,draft,
      freeze:async b=>req(path+'/freeze',token,b),
      async commit(plan){
        const m=await upload(token,pkg,65,'manifest',Buffer.from(plan.canonical,'base64url'));
        const c=await cap('accept',plan.payloadDigest),msg={...possess(c),payload:plan.payload,canonical:plan.canonical,manifestId:m.objectId,packageId:pkg};
        const wrongReview={...c,sourceReviewSha256:'00'.repeat(32)};
        await req(path+'/accept',null,{...msg,proof:b64(richProof(device.privateKey,wrongReview))},{status:403});
        const post=()=>req(path+'/accept',null,msg),r=await post();assert.deepEqual(await post(),r);return r;
      }};
  }
  const prep=await start(a),initialPlan=await prep.freeze(body(fixture,'direct')),saved=await prep.commit(initialPlan);
  const initial=JSON.parse(Buffer.from(initialPlan.canonical,'base64url'));assert.deepEqual(initial.setup,[]);
  const value={kind:'tool',title:'Install local tool',instructions:'Install with your normal package manager.',check:'Confirm its version.',required:true,action:{kind:'manual'}};
  const changes=[{op:'addSetup',value,source:{kind:'accountClaim'}}];
  const edit=await start(a,{purpose:'editDraft',draftId:saved.draftId,baseRevision:1});
  const input={format:'rich-v2',baseCanonical:initialPlan.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:saved.draftId,baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes}};
  const plan=await edit.freeze(input);assert.deepEqual(await edit.freeze(input),plan);
  const next=JSON.parse(Buffer.from(plan.canonical,'base64url'));assert.equal(next.setup.length,1);assert.deepEqual(next.setup[0].action,{kind:'manual'});
  assert.ok(next.setup[0].itemId);assert.ok(next.setup[0].originId);assert.equal(next.setup[0].instructions,value.instructions);
  const changed=structuredClone(input);changed.payload.changes[0].source={kind:'releaseItems',parents:[{versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'ab'.repeat(32)}]};
  await req(edit.path+'/freeze',a,changed,{status:409});
  const edited=await edit.commit(plan);assert.equal(edited.revision,2);
  await req('/v2/authoring/'+opId()+'/register',a,{format:'rich-v2',purpose:'editDraft',draftId:saved.draftId,baseRevision:1,...legacyDevice},{status:409});
  const over=await start(a,{purpose:'editDraft',draftId:saved.draftId,baseRevision:2});
  const overInput={...input,baseCanonical:plan.canonical,payload:{...input.payload,baseRevision:2,requestId:randomUUID(),changes:Array.from({length:8},()=>changes[0])}};
  await req(over.path+'/freeze',a,overInput,{status:422});
  for(const invalid of [
    {...changes[0],itemId:randomUUID()}, {...changes[0],value:{...value,originId:randomUUID()}},
    {...changes[0],value:{...value,action:{kind:'shell',command:'echo unsafe'}}},
    {...changes[0],value:{...value,instructions:'x'.repeat(2049)}},
    {...changes[0],source:{kind:'releaseItems',parents:[]}},
  ])await req(over.path+'/freeze',a,{...overInput,payload:{...overInput.payload,changes:[invalid]}},{status:422});
  await req(over.path+'/cancel',a,{});await req('/v2/objects/'+over.pkg+'/cancel',a,{});
  const published=await req('/v2/drafts/'+saved.draftId+'/publish',a,{canonical:plan.canonical},{key:randomUUID(),rev:2});
  const member=inventory(next).find(x=>x.kind==='rule');
  const readerPrep=await start(b),readerPlan=await readerPrep.freeze(body(fixture,'direct')),readerSaved=await readerPrep.commit(readerPlan);
  const readerEdit=await start(b,{purpose:'editDraft',draftId:readerSaved.draftId,baseRevision:1});
  const derived={format:'rich-v2',baseCanonical:readerPlan.canonical,payload:{...input.payload,draftId:readerSaved.draftId,requestId:randomUUID(),changes:[{op:'addSetup',value,source:{kind:'releaseItems',parents:[{versionId:published.versionId,itemId:member.itemId,baselineSha256:member.baselineSha256}]}}]}};
  const badBaseline=structuredClone(derived);badBaseline.payload.changes[0].source.parents[0].baselineSha256='0'.repeat(64);
  await req(readerEdit.path+'/freeze',b,badBaseline,{status:403});
  const foreignKind=structuredClone(derived);foreignKind.payload.changes[0].source.parents[0].kind='setup';
  await req(readerEdit.path+'/freeze',b,foreignKind,{status:422});
  const derivedPlan=await readerEdit.freeze(derived);const derivedSaved=await readerEdit.commit(derivedPlan);
  assert.equal(derivedSaved.revision,2);assert.notEqual(JSON.parse(Buffer.from(derivedPlan.canonical,'base64url')).setup[0].itemId,member.itemId);
  const detail=await req('/v2/recipes/'+published.recipeId+'/versions/'+published.versionId,a);assert.equal(detail.release.contentSha256,plan.contentSha256);
  const coded=await start(a),codedPlan=await coded.freeze(body(next,'coded')),codedSaved=await coded.commit(codedPlan);
  const codedVersion=await req('/v2/drafts/'+codedSaved.draftId+'/publish',a,{canonical:codedPlan.canonical},{key:randomUUID(),rev:1});
  await req('/v1/versions/'+codedVersion.versionId+'/redeem',b,{code:codedVersion.firstCode},{key:'a2.'+opId()});
  const mixed=await start(b,{purpose:'editDraft',draftId:readerSaved.draftId,baseRevision:2});
  const codedMember=inventory(JSON.parse(Buffer.from(codedPlan.canonical,'base64url'))).find(x=>x.kind==='rule');
  const mixedInput={...derived,baseCanonical:derivedPlan.canonical,payload:{...derived.payload,baseRevision:2,requestId:randomUUID(),changes:[{op:'addSetup',value,source:{kind:'releaseItems',parents:[...derived.payload.changes[0].source.parents,{versionId:codedVersion.versionId,itemId:codedMember.itemId,baselineSha256:codedMember.baselineSha256}]}}]}};
  await req(mixed.path+'/freeze',b,mixedInput,{status:403});
  const relabel=structuredClone(mixedInput);relabel.payload.changes[0].source={kind:'accountClaim'};
  await req(mixed.path+'/freeze',b,relabel,{status:403});
  assert.equal((await req('/v2/drafts/'+readerSaved.draftId,b)).revision,2);
  await req(mixed.path+'/cancel',b,{});await req('/v2/objects/'+mixed.pkg+'/cancel',b,{});
  const independent=structuredClone(fixture);delete independent.role;independent.rules=[];
  const prepared=await start(a),createdPlan=await prepared.freeze(body(independent,'direct')),created=await prepared.commit(createdPlan);
  const permission=await start(a,{purpose:'editDraft',draftId:created.draftId,baseRevision:1});
  const accessInput={format:'rich-v2',access:'coded',baseCanonical:createdPlan.canonical,payload:{...derived.payload,draftId:created.draftId,requestId:randomUUID(),baseRevision:1,changes:[{op:'setAccess',value:'coded'}]}};
  await req(permission.path+'/freeze',a,{...accessInput,access:'direct'},{status:422});
  const privatePlan=await permission.freeze(accessInput);assert.equal(privatePlan.canonical,createdPlan.canonical);
  await permission.commit(privatePlan);
  assert.equal((await req('/v2/drafts/'+created.draftId,a)).access,'coded');
  console.log('PASS: empty draft typed setup creation; deterministic retry; server identity; exact source proof; stale CAS; limits; inert manual action; direct lineage; foreign coded mixed DAG rejection; immutable release.');
}finally{if(broker)await close(broker);if(pool)await pool.end();if(api)await api.close();if(issuerServer)await close(issuerServer);
  if(pgUp)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
