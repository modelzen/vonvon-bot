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
  const logoReceipts=new Map();
  async function upload(token,pkg,idx,kind,buf,status=200) {
    const r=await fetch(orig(broker)+'/v2/objects/'+pkg+'/members/'+idx,{method:'PUT',headers:{authorization:'Bearer '+token,
      'content-type':'application/octet-stream','x-recipe-kind':kind,'x-recipe-sha256':sha(buf).toString('hex')},body:buf});
    const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));
    if(status===200&&kind==='finalLogo')logoReceipts.set(j.objectId,{packageId:pkg,inputSha256:sha(buf).toString('hex')});
    return j;
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
  const body=(c,access='coded')=>({format:'rich-v2',content:c,access,origins:own(c),...(c.finalLogo?{logoUpload:logoReceipts.get(c.finalLogo.objectId)}:{})});
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
  const prep=await start(a);const privateBytes=Buffer.from('SELECTED PRIVATE MEMORY');
  const p=await upload(a,prep.pkg,0,'text',privateBytes);
  const png=await sharp({create:{width:20,height:30,channels:3,background:'#22aa33'}}).png().toBuffer();
  const logo=await upload(a,prep.pkg,64,'finalLogo',png);
  fixture.finalLogo={itemId:randomUUID(),originId:randomUUID(),objectId:logo.objectId};fixture.parts=[p,logo];fixture.memories=[{itemId:randomUUID(),originId:randomUUID(),text:{kind:'part',objectId:p.objectId}}];
  const input=body(fixture),plan=await prep.freeze(input);
  assert.deepEqual(await prep.freeze(input),plan);
  const initial=JSON.parse(Buffer.from(plan.canonical,'base64url'));
  assert.notEqual(initial.role.itemId,fixture.role.itemId);
  const modifiedReview=structuredClone(input);modifiedReview.access='direct';
  await req(prep.path+'/freeze',a,modifiedReview,{status:409});
  await req(prep.path+'/freeze',b,input,{status:404});
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
  const logoSource=await start(a),sourceLogo=await upload(a,logoSource.pkg,64,'finalLogo',png);
  const directSource=structuredClone(fixture);directSource.memories=[];directSource.parts=[sourceLogo];directSource.finalLogo.objectId=sourceLogo.objectId;
  directSource.public.name.value='known direct logo source';
  const logoSourcePlan=await logoSource.freeze(body(directSource,'direct')),logoSourceSaved=await logoSource.commit(logoSourcePlan);
  const logoRelease=await req('/v2/drafts/'+logoSourceSaved.draftId+'/publish',a,{canonical:logoSourcePlan.canonical},{key:randomUUID(),rev:1});
  const logoDonor=JSON.parse(Buffer.from(logoSourcePlan.canonical,'base64url'));
  const derivedLogoOp=await start(b),derivedLogoPart=await upload(b,derivedLogoOp.pkg,64,'finalLogo',png);
  const derivedLogoDoc=structuredClone(logoDonor);derivedLogoDoc.parts=[derivedLogoPart];derivedLogoDoc.finalLogo.objectId=derivedLogoPart.objectId;
  derivedLogoDoc.public.name.value='explicit derivative reuploaded logo';derivedLogoDoc.role.text.value='independent role';
  const derivedLogoInput=body(derivedLogoDoc,'direct');
  const directRule=inventory(logoDonor).find(x=>x.kind==='rule');
  derivedLogoInput.origins.find(x=>x.itemId===directRule.itemId).source={kind:'releaseItem',versionId:logoRelease.versionId,itemId:directRule.itemId,baselineSha256:directRule.baselineSha256};
  const honestLogoInput=structuredClone(derivedLogoInput),knownLogoItem=inventory(logoDonor).find(x=>x.kind==='finalLogo');
  honestLogoInput.origins.find(x=>x.itemId===knownLogoItem.itemId).source={kind:'releaseItem',versionId:logoRelease.versionId,itemId:knownLogoItem.itemId,baselineSha256:knownLogoItem.baselineSha256};
  await req(derivedLogoOp.path+'/freeze',b,honestLogoInput,{status:403});
  await req(derivedLogoOp.path+'/freeze',b,derivedLogoInput,{status:403});
  const unrelated=await start(b),unrelatedPart=await upload(b,unrelated.pkg,64,'finalLogo',png),unrelatedDoc=structuredClone(derivedLogoDoc);
  unrelatedDoc.parts=[unrelatedPart];unrelatedDoc.finalLogo.objectId=unrelatedPart.objectId;const unrelatedInput=body(unrelatedDoc,'direct');
  const unrelatedPlan=await unrelated.freeze(unrelatedInput),privateLogoDraft=await unrelated.commit(unrelatedPlan);
  const newArt=await start(b),newPart=await upload(b,newArt.pkg,64,'finalLogo',await sharp({create:{width:8,height:8,channels:4,background:'#ffeedd'}}).png().toBuffer());
  const newArtInput=structuredClone(derivedLogoInput);newArtInput.logoUpload=logoReceipts.get(newPart.objectId);newArtInput.content.parts=[newPart];newArtInput.content.finalLogo.objectId=newPart.objectId;
  const newArtPlan=await newArt.freeze(newArtInput),newArtSaved=await newArt.commit(newArtPlan);
  const newArtRelease=await req('/v2/drafts/'+newArtSaved.draftId+'/publish',b,{canonical:newArtPlan.canonical},{key:randomUUID(),rev:1});
  const ownUpdate=await start(b),ownUpdateDoc=JSON.parse(Buffer.from(newArtPlan.canonical,'base64url'));ownUpdateDoc.public.version.value='2';
  const ownPart=await upload(b,ownUpdate.pkg,64,'finalLogo',await sharp({create:{width:8,height:8,channels:4,background:'#ffeedd'}}).png().toBuffer());
  ownUpdateDoc.parts=[ownPart];ownUpdateDoc.finalLogo.objectId=ownPart.objectId;const ownUpdateInput=body(ownUpdateDoc,'direct');ownUpdateInput.sourceVersionId=newArtRelease.versionId;
  const ownIndex=inventory(JSON.parse(Buffer.from(newArtPlan.canonical,'base64url')));
  ownUpdateInput.origins=ownUpdateInput.origins.map(({itemId})=>({itemId,source:{kind:'releaseItem',versionId:newArtRelease.versionId,itemId,baselineSha256:ownIndex.find(x=>x.itemId===itemId).baselineSha256}}));
  const ownUpdatePlan=await ownUpdate.freeze(ownUpdateInput);await ownUpdate.commit(ownUpdatePlan);
  const ancestry=await start(b),ancestryDoc=structuredClone(derivedLogoDoc);delete ancestryDoc.finalLogo;ancestryDoc.parts=[];
  const ancestryInput=body(ancestryDoc,'direct');ancestryInput.origins.find(x=>x.itemId===directRule.itemId).source={kind:'releaseItems',parents:[{versionId:logoRelease.versionId,itemId:directRule.itemId,baselineSha256:directRule.baselineSha256}]};
  const ancestryPlan=await ancestry.freeze(ancestryInput),ancestrySaved=await ancestry.commit(ancestryPlan);
  const ancestryContent=JSON.parse(Buffer.from(ancestryPlan.canonical,'base64url')),ancestryRule=ancestryContent.rules[0];
  const privateEdit=await start(b,{purpose:'editDraft',draftId:ancestrySaved.draftId,baseRevision:1});
  const privatePlan=await privateEdit.freeze({format:'rich-v2',baseCanonical:ancestryPlan.canonical,payload:{format:'rich-v2',purpose:'editDraft',draftId:ancestrySaved.draftId,baseRevision:1,requestId:randomUUID(),schemaVersion:2,changes:[
    {op:'setRule',itemId:ancestryRule.itemId,value:{purpose:ancestryRule.purpose,text:{kind:'inline',value:'Privately rewritten derivative'}}},
    {op:'copyItem',source:{kind:'rule',itemId:ancestryRule.itemId}},
    {op:'removeItem',kind:'rule',itemId:ancestryRule.itemId},
  ]}});await privateEdit.commit(privatePlan);
  const ancestryVersion=await req('/v2/drafts/'+ancestrySaved.draftId+'/publish',b,{canonical:privatePlan.canonical},{key:randomUUID(),rev:2});
  const indirect=await start(b),indirectPart=await upload(b,indirect.pkg,64,'finalLogo',png),indirectDoc=JSON.parse(Buffer.from(privatePlan.canonical,'base64url'));
  indirectDoc.public.version.value='2';indirectDoc.finalLogo={itemId:randomUUID(),originId:randomUUID(),objectId:indirectPart.objectId};indirectDoc.parts=[indirectPart];
  const indirectInput=body(indirectDoc,'direct');indirectInput.sourceVersionId=ancestryVersion.versionId;
  await req(indirect.path+'/freeze',b,indirectInput,{status:403});
  assert.equal((await req('/v2/recipes/'+ancestryVersion.recipeId+'/versions/'+ancestryVersion.versionId,b)).state,'listed');
  const oldLogo=JSON.parse(Buffer.from(unrelatedPlan.canonical,'base64url')).finalLogo;
  const logoEdit=await start(b,{purpose:'editDraft',draftId:privateLogoDraft.draftId,baseRevision:1});
  const editedPart=await upload(b,logoEdit.pkg,64,'finalLogo',await sharp({create:{width:9,height:5,channels:4,background:'#112233'}}).png().toBuffer());
  const logoPatch=(baseCanonical,baseRevision,changes)=>({format:'rich-v2',baseCanonical,payload:{format:'rich-v2',purpose:'editDraft',
    draftId:privateLogoDraft.draftId,baseRevision,requestId:randomUUID(),schemaVersion:2,changes}});
  const replace={...logoPatch(unrelatedPlan.canonical,1,[{op:'setFinalLogo',itemId:oldLogo.itemId,objectId:editedPart.objectId}]),
    newParts:[editedPart],logoUpload:logoReceipts.get(editedPart.objectId)};
  await req(logoEdit.path+'/freeze',b,{...replace,logoUpload:{...replace.logoUpload,packageId:unrelated.pkg}},{status:410});
  const replaced=await logoEdit.freeze(replace);
  assert.deepEqual(await logoEdit.freeze(replace),replaced);
  const newLogo=JSON.parse(Buffer.from(replaced.canonical,'base64url')).finalLogo;
  assert.deepEqual(newLogo,{...oldLogo,objectId:editedPart.objectId});
  await logoEdit.commit(replaced);
  const removal=await start(b,{purpose:'editDraft',draftId:privateLogoDraft.draftId,baseRevision:2});
  const removed=await removal.freeze(logoPatch(replaced.canonical,2,[{op:'removeItem',kind:'finalLogo',itemId:newLogo.itemId}]));
  assert.ok(!JSON.parse(Buffer.from(removed.canonical,'base64url')).finalLogo);
  await removal.commit(removed);
  const addLogo=await start(b,{purpose:'editDraft',draftId:privateLogoDraft.draftId,baseRevision:3});
  const addedPart=await upload(b,addLogo.pkg,64,'finalLogo',png);
  const added=await addLogo.freeze({...logoPatch(removed.canonical,3,[{op:'setFinalLogo',objectId:addedPart.objectId}]),
    newParts:[addedPart],logoUpload:logoReceipts.get(addedPart.objectId)});
  assert.notEqual(JSON.parse(Buffer.from(added.canonical,'base64url')).finalLogo.itemId,newLogo.itemId);
  await addLogo.commit(added);
  console.log('PASS: known ancestor Logo rejects direct and DAG relabels and own parent versions without Logo; unrelated common artwork, fresh Logo and own author Logo updates remain allowed.');
  for(const pending of [derivedLogoOp,indirect]){await req(pending.path+'/cancel',b,{});await req('/v2/objects/'+pending.pkg+'/cancel',b,{});}
}finally{if(broker)await close(broker);if(pool)await pool.end();if(api)await api.close();if(issuerServer)await close(issuerServer);
  if(pgUp)run('pg_ctl',['-D',db,'-m','immediate','-w','stop']);rmSync(dir,{recursive:true,force:true});}
