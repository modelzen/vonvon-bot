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
        const post=()=>req(path+'/accept',null,msg),r=await post();assert.deepEqual(await post(),r);return r;
      }};
  }
  const prep=await start(a);const privateBytes=Buffer.from('SELECTED PRIVATE MEMORY');
  const p=await upload(a,prep.pkg,0,'text',privateBytes);
  const png=await sharp({create:{width:20,height:30,channels:3,background:'#22aa33'}}).png().toBuffer();
  const logo=await upload(a,prep.pkg,1,'finalLogo',png);
  fixture.finalLogo={itemId:randomUUID(),originId:randomUUID(),objectId:logo.objectId};fixture.parts=[p,logo];fixture.memories=[{itemId:randomUUID(),originId:randomUUID(),text:{kind:'part',objectId:p.objectId}}];
  const input=body(fixture),plan=await prep.freeze(input);
  assert.deepEqual(await prep.freeze(input),plan);
  const initial=JSON.parse(Buffer.from(plan.canonical,'base64url'));
  assert.notEqual(initial.role.itemId,fixture.role.itemId);
  const saved=await prep.commit(plan);
  assert.equal(saved.revision,1);const draft=await req('/v2/drafts/'+saved.draftId,a);
  assert.equal((await read(a,'drafts',draft.draftId,draft.manifest.objectId)).toString('base64url'),plan.canonical);
  await read(b,'drafts',draft.draftId,p.objectId,404);
  assert.deepEqual((await req('/v1/me/drafts',a)).items,[]);await req('/v1/drafts/'+draft.draftId,a,undefined,{status:409});
  const edit=await start(a,{purpose:'editDraft',draftId:draft.draftId,baseRevision:1});
  const patch={format:'rich-v2',purpose:'editDraft',draftId:draft.draftId,baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[
    {op:'setRoleText',itemId:initial.role.itemId,value:{kind:'inline',value:'自动化验证的私有角色'}},
    {op:'removeItem',kind:'rule',itemId:initial.rules[0].itemId},
    {op:'includeCandidate',value:{kind:'rule',source:{sourceIntentId:prep.op,candidateId:initial.rules[0].itemId,expectedRevision:1}}},
    {op:'copyItem',source:{kind:'memory',itemId:initial.memories[0].itemId}}]};
  const edited=await edit.freeze({format:'rich-v2',baseCanonical:plan.canonical,payload:patch}),updated=JSON.parse(Buffer.from(edited.canonical,'base64url'));
  assert.equal(updated.role.originId,initial.role.originId);assert.notEqual(updated.rules[0].originId,initial.rules[0].originId);
  assert.equal((await edit.commit(edited)).revision,2);
  const restored=await req('/v2/drafts/'+draft.draftId,a);assert.equal(restored.sourceManifest.objectId,draft.manifest.objectId);
  assert.equal((await read(a,'drafts',draft.draftId,restored.sourceManifest.objectId)).toString('base64url'),plan.canonical);
  assert.equal(restored.retainedCandidateBytes,Buffer.from(plan.canonical,'base64url').length);
  const key=randomUUID(),pub=()=>req('/v2/drafts/'+draft.draftId+'/publish',a,{canonical:edited.canonical},{key,rev:2});
  const skewed=structuredClone(updated);skewed.role.text.value='未经核实的编辑';
  await req('/v2/drafts/'+draft.draftId+'/publish',a,{canonical:b64(JSON.stringify(skewed))},{key,rev:2,status:409});
  const v=await pub();assert.deepEqual(await pub(),v);assert.ok(v.firstCode);
  const detail='/v2/recipes/'+v.recipeId+'/versions/'+v.versionId;assert.equal((await req(detail)).visibility,'intro');
  const publicLogo=async status=>{const r=await fetch(orig(broker)+'/v2/versions/'+v.versionId+'/display-logo');assert.equal(r.status,status);
    if(status===200){assert.equal(r.headers.get('content-type'),'image/webp');assert.equal(sha(Buffer.from(await r.arrayBuffer())).toString('hex'),logo.sha256);}};
  await publicLogo(200);await read(null,'versions',v.versionId,logo.objectId,404);
  assert.ok(!('manifest' in await req(detail)));await read(null,'versions',v.versionId,p.objectId,404);
  await req('/v1/versions/'+v.versionId+'/install-preview',a,undefined,{status:409});
  await req('/v1/versions/'+v.versionId+'/redeem',b,{code:v.firstCode},{key:'a2.'+opId()});
  assert.deepEqual(await read(b,'versions',v.versionId,p.objectId),privateBytes);
  assert.equal((await req(detail,b)).release.contentSha256,edited.contentSha256);
  assert.equal((await req('/v1/authoring/source-history',a,{operationIds:[prep.op]})).entries[0].versionId,v.versionId);
  const thief=await start(b);const role=updated.role,baseline=inventory(updated).find(i=>i.itemId===role.itemId).baselineSha256;
  const copied=structuredClone(fixture);copied.role.text=structuredClone(role.text);copied.parts=[];copied.memories=[];delete copied.finalLogo;
  const foreign=body(copied,'direct');foreign.origins.find(o=>o.itemId===copied.role.itemId).source={kind:'releaseItem',versionId:v.versionId,itemId:role.itemId,baselineSha256:baseline};
  await req(thief.path+'/freeze',b,foreign,{status:403});
  foreign.origins.find(o=>o.itemId===copied.role.itemId).source={kind:'accountClaim'};await req(thief.path+'/freeze',b,foreign,{status:403});
  await req(thief.path+'/cancel',b,{});
  const opInstall=async(token,release,extra={})=>{
    const oid=opId(),path='/v2/operations/'+oid,device=generateKeyPairSync('x25519'),nonce=randomBytes(32);
    const reqBody={format:'rich-v2',purpose:'installRichRecipe',generation:2,versionId:release.versionId,manifestSha256:release.contentSha256,
      targetPublicKey:b64(device.publicKey.export({format:'der',type:'spki'}).subarray(-32)),nonceCommitment:b64(sha(nonce)),...extra};
    const cap=await req(path+'/authorize',token,reqBody);
    assert.deepEqual(await req(path+'/authorize',token,reqBody),cap);
    const proof=stage=>({ticket:cap.ticket,nonce:b64(nonce),proof:b64(richInstallProof(device.privateKey,cap,stage))});
    await req('/v1/operations/'+oid+'/cancel',token,{},{status:404});
    await req(path+'/redeem',null,{...proof('redeem'),proof:b64(installProof(device.privateKey,cap))},{status:403});
    await req(path+'/complete',null,{...proof('applied'),outcome:'applied'},{status:409});
    const redeemed=await req(path+'/redeem',null,proof('redeem'));assert.deepEqual(redeemed.release,release);
    await req(path+'/complete',null,{...proof('redeem'),outcome:'applied'},{status:403});
    const readPart=async(obj,status=200)=>{
      const r=await fetch(orig(broker)+path+'/objects/'+obj,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(proof('redeem'))});
      assert.equal(r.status,status);return Buffer.from(await r.arrayBuffer());
    };
    assert.equal(sha(await readPart(redeemed.manifest.objectId)).toString('hex'),release.contentSha256);
    await readPart(randomUUID(),404);
    return {oid,readPart,complete:(outcome,expected=200)=>req(path+'/complete',null,{...proof(outcome),outcome},{status:expected})};
  };
  const install=await opInstall(b,(await req('/v2/versions/'+v.versionId+'/install-preview',b)).release);
  assert.equal((await install.complete('applied')).disposition,'recorded');await install.complete('rejected',409);
  sql("select recipe_api.rich_moderate('feature','"+v.versionId+"','"+reader+"')");
  assert.equal((await req('/v2/community/recipes')).hero.versionId,v.versionId);
  const newer=structuredClone(updated);newer.public.version.value='2.0';newer.memories=[];newer.parts=[];delete newer.finalLogo;
  const oldIndex=new Map(inventory(updated).map(i=>[i.itemId,i])),nextInput=body(newer,'direct');
  nextInput.sourceVersionId=v.versionId;
  nextInput.origins=nextInput.origins.map(({itemId})=>({itemId,source:{kind:'releaseItem',versionId:v.versionId,itemId,baselineSha256:oldIndex.get(itemId).baselineSha256}}));
  const prep2=await start(a),nextPlan=await prep2.freeze(nextInput);
  assert.deepEqual(JSON.parse(Buffer.from(nextPlan.canonical,'base64url')).role,updated.role);
  const draft2=await prep2.commit(nextPlan);
  await read(b,'versions',v.versionId,draft.manifest.objectId,404);
  const nextVersion=await req('/v2/drafts/'+draft2.draftId+'/publish',a,{canonical:nextPlan.canonical},{rev:1,key:randomUUID()});
  const nextDetail=await req('/v2/recipes/'+nextVersion.recipeId+'/versions/'+nextVersion.versionId);
  assert.equal(nextDetail.visibility,'full');
  await req('/v2/versions/'+nextVersion.versionId+'/install-preview',b,undefined,{status:403});
  const derivative=await start(b),derivedDoc=structuredClone(newer);derivedDoc.rules[0].text.value='重新组织的规则';
  derivedDoc.role.text.value='自己的新角色';derivedDoc.public.name.value='来源校验';const derivedInput=body(derivedDoc,'direct');
  const newItems=(await req('/v2/versions/'+nextVersion.versionId+'/source-items',b)).items;
  const edge=(vid,item)=>({versionId:vid,itemId:item.itemId,baselineSha256:item.baselineSha256});
  const donor=newItems.find(item=>item.itemId===derivedDoc.rules[0].itemId);
  const origin=derivedInput.origins.find(x=>x.itemId===donor.itemId);
  origin.source={kind:'releaseItems',parents:[edge(nextVersion.versionId,donor),edge(v.versionId,oldIndex.get(donor.itemId))]};
  await req(derivative.path+'/freeze',b,derivedInput,{status:403});
  origin.source={kind:'releaseItem',...edge(nextVersion.versionId,donor),baselineSha256:'00'.repeat(32)};
  await req(derivative.path+'/freeze',b,derivedInput,{status:403});
  origin.source={kind:'releaseItem',...edge(nextVersion.versionId,donor)};
  const derivedPlan=await derivative.freeze(derivedInput),derivedSaved=await derivative.commit(derivedPlan);
  const pending=await opInstall(b,nextDetail.release,{purpose:'updateDirectRichRecipe',fromVersionId:v.versionId,localPlanSha256:'12'.repeat(32)});
  assert.equal(sql("select count(*) from recipe_private.grants where actor='"+reader+"' and version_id='"+nextVersion.versionId+"'"),'0');
  await req('/v2/versions/'+nextVersion.versionId+'/withdraw',a,{});
  await req('/v2/drafts/'+derivedSaved.draftId+'/publish',b,{canonical:derivedPlan.canonical},{key:randomUUID(),rev:1,status:403});
  assert.equal((await req('/v2/drafts/'+derivedSaved.draftId,b)).revision,1);
  assert.equal((await pending.complete('applied')).disposition,'settled');
  assert.equal((await pending.complete('applied')).disposition,'settled');
  assert.equal((await req('/v2/versions/'+nextVersion.versionId+'/install-preview',b)).release.versionId,nextVersion.versionId);
  sql("select recipe_api.rich_moderate('ban','"+nextVersion.versionId+"',null)");await pending.readPart(nextDetail.manifest.objectId,403);
  console.log('PASS: native-device operation proofs, old-domain refusal, verified member read, distinct settlement proof, direct update grant only on completion after withdrawal.');
  await req('/v2/versions/'+v.versionId+'/withdraw',a,{});
  await publicLogo(404);assert.equal((await req(detail)).state,'withdrawn');assert.deepEqual(await read(b,'versions',v.versionId,p.objectId),privateBytes);
  sql("select recipe_api.rich_moderate('ban','"+v.versionId+"',null)");await read(b,'versions',v.versionId,p.objectId,404);
  assert.equal((await req(detail,b)).state,'blocked');
  sql("with seq as (select gen_random_uuid() rid,x from generate_series(1,12)x),rp as (insert into recipe_private.recipes(id,owner_id,revision) select rid,'"+account+"',1 from seq returning id) insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes) select id,'"+account+"',1,jsonb_build_object('name','分页','summary','page','version','1','overview','','access','direct'),'{\"role\":\"\"}',80 from rp");
  const first=await req('/v2/community/recipes?q='+encodeURIComponent('分页'));assert.equal(first.hero,null);assert.equal(first.items.length,8);
  const next=await req('/v2/community/recipes?q='+encodeURIComponent('分页')+'&cursor='+first.nextCursor);assert.equal(next.items.length,4);
  assert.equal(new Set([...first.items,...next.items].map(i=>i.recipeId)).size,12);
  await req('/v2/community/recipes?cursor='+first.nextCursor,undefined,undefined,{status:422});
  await req('/v2/community/recipes?cursor='+first.nextCursor.slice(0,-3),undefined,undefined,{status:422});
  console.log('PASS: normalized public Logo without private selector, signed stable pagination, tamper and query mismatch rejection.');
  console.log('PASS: exact broker bytes; separate proof domain; typed copy/edit; atomic replay; foreign coded origin/redacted text; historical refs, feature, withdraw, ban.');
}finally{if(broker)await close(broker);if(pool)await pool.end();if(api)await api.close();if(issuerServer)await close(issuerServer);
  if(pgUp)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
