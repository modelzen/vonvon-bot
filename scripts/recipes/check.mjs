// Exercises the shipped SQL and HTTP code together. The only identity substitute
// is a local asymmetric issuer. The suite never uses a cloud URL or an existing DB.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'vonvon-recipes-check-'));
const bindir = process.env.PG_BINDIR || execFileSync('pg_config', ['--bindir'], {encoding:'utf8'}).trim();
const pg = (bin, args, opts = {}) => execFileSync(join(bindir, bin), args, {encoding:'utf8', ...opts});
const db = join(tmp, 'db'), sock = join(tmp, 's');
const json = { 'content-type': 'application/json' };
const port = 5432; // Unix socket lives in our unique 0700 directory; no TCP listener.
const pgEnv = { ...process.env, PGHOST:sock, PGPORT:String(port), PGDATABASE:'postgres', PGUSER:'bootstrap_test', PGPASSWORD:'' };
const sql = stmt => pg('psql', ['-XAtq','-v','ON_ERROR_STOP=1','-c',stmt], {env:pgEnv}).trim();
const review=process.argv.includes('--review');
const legacy={owner:randomUUID(),reader:randomUUID(),recipe:randomUUID(),version:randomUUID(),request:randomUUID()};
let up=false, service, issuerServer,webServer;
let reviewAuth=null;
const closeServer = s => new Promise((resolve,reject)=>s.close(err => err ? reject(err) : resolve()));
try {
  mkdirSync(sock, {mode:0o700});
  pg('initdb', ['-D',db,'-U','bootstrap_test','--encoding=UTF8','--locale=C','--auth=trust'], {stdio:'ignore'});
  pg('pg_ctl', ['-D',db,'-w','-l',join(tmp,'pg.log'),'-o',`-k '${sock}' -p ${port} -c listen_addresses='' -c unix_socket_permissions=0700`,'start']);
  up=true;
  const migrations=join(root,'supabase/migrations');
  for (const f of readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort()) {
    if (!review && f.endsWith('_recipe_accounts.sql')) {
      sql(`insert into recipe_private.recipes(id,owner_id,revision) values('${legacy.recipe}','${legacy.owner}',1);
        insert into recipe_private.versions(id,recipe_id,owner_id,revision,public_info,config,bytes)
        values('${legacy.version}','${legacy.recipe}','${legacy.owner}',1,
          '{"name":"legacy","summary":"retained","overview":"","version":"1","access":"coded"}',
          '{"role":"LEGACY-PRIVATE"}',25);
        insert into recipe_private.grants(actor,version_id,original_request,original_digest)
        values('${legacy.reader}','${legacy.version}','${legacy.request}',
          sha256(convert_to(jsonb_build_array('${legacy.version}'::uuid,null)::text,'UTF8')));`);
    }
    pg('psql',['-Xq','-1','-v','ON_ERROR_STOP=1','-f',join(migrations,f)],{env:pgEnv,stdio:['ignore','ignore','pipe']});
  }
  sql('create role recipe_check_login login noinherit; grant recipe_api to recipe_check_login');
  const {publicKey, privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const jwk={ ...publicKey.export({format:'jwk'}), kid:'local-fixture', alg:'ES256',use:'sig'};
  issuerServer=createServer((req,res)=>{
    if(req.url!=='/auth/v1/.well-known/jwks.json'){if(reviewAuth){reviewAuth(req,res).catch(()=>res.writeHead(400).end());return;}res.writeHead(404).end();return;}
    res.writeHead(200,json).end(JSON.stringify({keys:[jwk]}));
  });
  await new Promise(resolve=>issuerServer.listen(0,'127.0.0.1',resolve));
  const issuer=`http://127.0.0.1:${issuerServer.address().port}/auth/v1`;
  const enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt=(who, overrides={})=>{
    const now=Math.floor(Date.now()/1000);
    const signed=enc({alg:'ES256',kid:jwk.kid,typ:'JWT'})+'.'+enc({iss:issuer,aud:'authenticated',role:'authenticated',sub:who,iat:now,exp:now+120,...overrides});
    return signed+'.'+sign('sha256',Buffer.from(signed),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  };
  // Set configuration before loading any server modules. The unix-socket URL
  // cannot point at production even if a developer has unrelated PG settings.
  const url=new URL('postgresql://recipe_check_login@localhost/postgres');
  url.searchParams.set('host',sock);url.searchParams.set('port',String(port));
  const env={...process.env,RECIPE_AUTH_ISSUER:issuer,RECIPE_DATABASE_URL:url.href,RECIPE_CODE_KEY:randomBytes(32).toString('hex'),PORT:'0'};
  const { startLocalRecipeApi } = await import('./service-fixture.mjs');
  service=await startLocalRecipeApi(root,env);
  const { origin }=service;
  async function request(path,{token,method='GET',body,revision,key,status=200}={}){
    const headers={};if(token) headers.authorization='Bearer '+token;
    if(method!=='GET'){Object.assign(headers,json);headers['idempotency-key']=key??randomUUID();}
    if(revision!==undefined)headers['if-match']='"'+revision+'"';
    const res=await fetch(origin+'/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();assert.equal(res.status,status,path+' '+res.status+' '+(data.error?.code||''));return data;
  }
  const [aid,rid,oid] = Array.from({length:3},()=>randomUUID());
  const [author,reader,other]=[aid,rid,oid].map(s=>jwt(s));
  if (review) {
    const helpRecipe = JSON.parse(readFileSync(join(root, 'content/recipes/vonvon-help/recipe.json'), 'utf8'));
    assert.equal(helpRecipe.public.access, 'direct');
    const draft = await request('/drafts', {method: 'POST', token: author, body: helpRecipe});
    const publish = {
      method: 'POST', token: author, body: {}, revision: draft.revision, key: randomUUID(),
    };
    const route = '/drafts/' + draft.draftId + '/publish';
    const version = await request(route, publish);
    assert.equal((await request(route, publish)).versionId, version.versionId);
    const catalog = await request('/community/recipes');
    assert.equal(catalog.hero.versionId, version.versionId);
    assert.deepEqual(catalog.items, []);
    assert.deepEqual((await request('/recipes/' + version.recipeId + '/versions/' + version.versionId)).config, helpRecipe.config);

    const { startReview } = await import('./web-review.mjs');
    const running = await startReview({apiOrigin: origin, issuer, jwt, accounts: [aid, rid, oid]});
    webServer = running.web;
    reviewAuth = running.auth;
    console.log('本机验收（合成账号）：' + running.webOrigin + '  · Ctrl-C 关闭并清理临时库');
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
    await request('/me',{status:401});
    const accounts=await Promise.all(Array.from({length:24},()=>request('/me',{token:author})));
    const accountId=accounts[0].accountId;
    assert.notEqual(accountId,aid);
    assert.deepEqual(Object.keys(accounts[0]),['accountId']);
    assert.ok(accounts.every(a=>a.accountId===accountId));
    assert.equal(sql(`select count(*) from recipe_private.account_identities where subject='${aid}'`),'1');
    assert.notEqual((await request('/me',{token:jwt(accountId)})).accountId,accountId);
    assert.deepEqual((await request('/me/publications',{token:jwt(accountId)})).items,[]);
    assert.equal((await request('/me',{token:jwt(aid,{email:'other@example.com',app_metadata:{provider:'google'}})})).accountId,accountId);
    assert.notEqual((await request('/me',{token:jwt(randomUUID(),{email:'other@example.com'})})).accountId,accountId);
    await request('/me',{token:jwt(aid,{iss:issuer+'/other'}),status:401});
    const legacyOwner=jwt(legacy.owner),legacyReader=jwt(legacy.reader);
    assert.equal((await request('/me',{token:legacyOwner})).accountId,legacy.owner);
    assert.equal((await request('/me',{token:legacyReader})).accountId,legacy.reader);
    const legacyDetail='/recipes/'+legacy.recipe+'/versions/'+legacy.version;
    for (const token of [legacyOwner,legacyReader]) assert.equal((await request(legacyDetail,{token})).config.role,'LEGACY-PRIVATE');
    assert.ok(!('config' in await request(legacyDetail,{token:author})));
    assert.equal((await request('/me/recipes',{token:legacyReader})).items[0].versionId,legacy.version);
    await request('/versions/'+legacy.version+'/acquire',{method:'POST',token:legacyReader,body:{},key:legacy.request});
    await assert.rejects(startLocalRecipeApi(root,{...env,RECIPE_AUTH_ISSUER:issuer+'/other/auth/v1'}),/identity_issuer_mismatch/);
    assert.equal(sql(`select has_schema_privilege('recipe_api','recipe_private','USAGE')
      or has_table_privilege('recipe_api','recipe_private.accounts','SELECT')
      or has_table_privilege('recipe_api','recipe_private.account_identities','INSERT')
      or has_table_privilege('recipe_api','recipe_private.identity_deployment','UPDATE')
      or has_function_privilege('recipe_check_login','recipe_api.resolve_identity(text,uuid)','EXECUTE')`),'f');
    sql('create role anon; create role authenticated');
    for (const role of ['anon','authenticated']) {
      assert.equal(sql(`select has_schema_privilege('${role}','recipe_api','USAGE')
        or has_function_privilege('${role}','recipe_api.resolve_identity(text,uuid)','EXECUTE')
        or has_function_privilege('${role}','recipe_api.bind_identity_issuer(text)','EXECUTE')`),'f');
    }
    const pub={name:'开发晨报',summary:'只看本周变化',overview:'## 介绍',version:'1.0',access:'coded'};
    const trimSpace='\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    let blankDraft;
    for (const field of ['name','summary','version']) {
      const body={public:{...pub,[field]:trimSpace},config:{role:''}};
      blankDraft=await request(blankDraft?'/drafts/'+blankDraft.draftId:'/drafts',{
        method:blankDraft?'PATCH':'POST',token:author,revision:blankDraft?.revision,body});
      await request('/drafts/'+blankDraft.draftId+'/publish',{
        method:'POST',token:author,body:{},revision:blankDraft.revision,status:422});
      assert.equal((await request('/drafts/'+blankDraft.draftId,{token:author})).public[field],trimSpace);
    }
    await request('/drafts/'+blankDraft.draftId,{method:'DELETE',token:author,body:{},revision:blankDraft.revision});
    const setupStep={kind:'context',title:'准备代码',instructions:'PRIVATE-SETUP-SENTINEL',check:'能看到 README',required:true};
    const config={role:'PRIVATE-CONFIG-SENTINEL',setup:{steps:[setupStep]}};
    const unfinished={...config,setup:{steps:[{...setupStep,title:'\t\u3000'}]}};
    const initial=await request('/drafts',{method:'POST',token:author,body:{public:pub,config:unfinished}});
    const unfinishedPublish=await request('/drafts/'+initial.draftId+'/publish',{method:'POST',token:author,body:{},revision:initial.revision,status:422});
    assert.equal(unfinishedPublish.error.code,'incomplete_setup');
    assert.deepEqual((await request('/drafts/'+initial.draftId,{token:author})).config,unfinished);
    const draft=await request('/drafts/'+initial.draftId,{method:'PATCH',token:author,revision:initial.revision,body:{public:pub,config}});
    const pubKey=randomUUID(), options={method:'POST',token:author,body:{},revision:draft.revision,key:pubKey};
    const v=await request('/drafts/'+draft.draftId+'/publish',options);
    const replay=await request('/drafts/'+draft.draftId+'/publish',options);
    assert.equal(v.versionId,replay.versionId);assert.ok(v.firstCode);
    const detail='/recipes/'+v.recipeId+'/versions/'+v.versionId;
    for (const token of [undefined,reader]) {
      const preview=await request(detail,{token});assert.equal(preview.public.name,pub.name);assert.ok(!('config' in preview));
      assert.ok(!JSON.stringify(preview).includes(setupStep.instructions));
    }
    const publicCatalog=JSON.stringify(await request('/community/recipes'));
    assert.ok(!publicCatalog.includes(config.role)&&!publicCatalog.includes(setupStep.instructions));
    assert.deepEqual((await request(detail,{token:author})).config,config);
    assert.ok(!('config' in await request(detail)));
    await request('/me/recipes',{token:jwt(rid,{aud:'other'}),status:401});
    const claim='/versions/'+v.versionId+'/redeem';
    const key=randomUUID();
    await request(claim,{method:'POST',token:reader,body:{code:v.firstCode},key});
    await request(claim,{method:'POST',token:reader,body:{code:v.firstCode},key});
    await request(claim,{method:'POST',token:reader,body:{code:'changed'},key,status:409});
    assert.deepEqual((await request(detail,{token:reader})).config,config);
    assert.equal((await request('/me/recipes',{token:reader})).items.length,1);
    assert.equal((await request('/me/recipes',{token:other})).items.length,0);
    const denied=await fetch(origin+'/v1'+claim,{method:'POST',headers:{...json,authorization:'Bearer '+other,'idempotency-key':randomUUID()},body:JSON.stringify({code:v.firstCode})});
    assert.ok(denied.status>=400&&denied.status<500);
    assert.ok(!(await denied.text()).includes(v.firstCode));
    assert.ok(!('config' in await request(detail,{token:other})));
    const codes=await request('/versions/'+v.versionId+'/codes',{token:author});
    assert.equal(codes.items.filter(c=>c.status==='redeemed').length,1);
    assert.ok(!JSON.stringify(codes).includes(v.firstCode));
    // Changing the existing draft must invalidate an old publish confirmation.
    const v2pub={...pub,name:'晨报更新',version:'2.0',access:'direct'};
    const d2=await request('/drafts',{method:'POST',token:author,body:{public:v2pub,config,recipeId:v.recipeId,sourceVersionId:v.versionId}});
    const updated=await request('/drafts/'+d2.draftId,{method:'PATCH',token:author,revision:d2.revision,body:{public:v2pub,config:{role:'更新后的公开角色'}}});
    await request('/drafts/'+d2.draftId+'/publish',{method:'POST',token:author,body:{},revision:d2.revision,status:409});
    const v2=await request('/drafts/'+d2.draftId+'/publish',{method:'POST',token:author,body:{},revision:updated.revision});
    assert.deepEqual((await request('/recipes/'+v2.recipeId+'/versions/'+v2.versionId)).config,{role:'更新后的公开角色'});
    assert.deepEqual((await request(detail,{token:reader})).config,config);
    assert.ok(!('config' in await request(detail,{token:other})));
    await request('/drafts',{method:'POST',token:author,body:{public:{...pub,version:'3'},config,recipeId:v.recipeId,sourceVersionId:v.versionId},status:409});
    await request('/versions/'+v2.versionId+'/acquire',{method:'POST',token:other,body:{}});
    assert.equal((await request('/me/recipes',{token:other})).items[0].versionId,v2.versionId);
    const {build} = await import('esbuild');
    const nativeModule = join(tmp, 'native-community.mjs');
    await build({entryPoints: [join(root, 'packages/desktop/src/community-api.ts')], outfile: nativeModule,
      alias: {'@vonvon/protocol': join(root, 'packages/protocol/src/index.ts')}, bundle: true, platform: 'node', format: 'esm'});
    const {communityRequest: nativeRequest} = await import(pathToFileURL(nativeModule));
    let droppedBatch; let dropReceipt = true;
    const native = {
      status: () => ({kind: 'signedIn', accountId}), onStatus: () => () => {},
      request: async (_account, path, init) => {
        const headers = new Headers(init.headers); headers.set('Authorization', 'Bearer ' + author);
        const response = await fetch(origin + path, {...init, headers});
        if (dropReceipt && path === '/v1/versions/' + v.versionId + '/codes' && init.method === 'POST') {
          dropReceipt = false; droppedBatch = await response.clone().json();
          throw new Error('Synthetic response loss after real transaction commit');
        }
        return response;
      },
    };
    const batchRequest = {type: 'issueCodes', accountId, versionId: v.versionId, count: 3, requestId: randomUUID()};
    await assert.rejects(nativeRequest(native, batchRequest));
    await request(claim, {method: 'POST', token: jwt(randomUUID()), body: {code: droppedBatch.items[0].code}});
    await request('/codes/' + droppedBatch.items[1].codeId + '/disable', {method: 'POST', token: author, body: {}});
    const recoveredBatch = await nativeRequest(native, batchRequest);
    assert.deepEqual(recoveredBatch.items.map(item => item.status).sort(), ['available', 'disabled', 'redeemed']);
    assert.deepEqual(recoveredBatch.items.filter(item => 'code' in item).map(item => item.code), [droppedBatch.items[2].code]);
    assert.equal(recoveredBatch.items.length, 3);
    for (const item of recoveredBatch.items) {
      const command = {type: 'revealCode', accountId, codeId: item.codeId, requestId: randomUUID()};
      if (item.status === 'available') assert.equal((await nativeRequest(native, command)).code, item.code);
      else await assert.rejects(nativeRequest(native, command));
    }
    const unicode = {public: {...pub, name: '🦉'.repeat(60), summary: '🦉'.repeat(240), version: '🦉'.repeat(40), access: 'direct'},
      config: {role: '角色', setup: {steps: [{kind: 'config', title: '🦉'.repeat(80), instructions: '准备', required: false}]}}};
    const unicodeDraft = await request('/drafts', {method: 'POST', token: author, body: unicode});
    const unicodeVersion = await request('/drafts/' + unicodeDraft.draftId + '/publish', {method: 'POST', token: author, revision: unicodeDraft.revision, body: {}});
    const unicodeCatalog = await nativeRequest(native, {type: 'catalog', accountId, query: unicode.public.name});
    assert.equal(unicodeCatalog.items[0].versionId, unicodeVersion.versionId);
    assert.deepEqual((await nativeRequest(native, {type: 'detail', accountId, recipeId: unicodeVersion.recipeId, versionId: unicodeVersion.versionId})).public, unicode.public);
    const {checkNativeInstall}=await import('./native-install-check.mjs');
    const nextDraft=await request('/drafts',{method:'POST',token:author,body:{...unicode,public:{...unicode.public,version:'2'},recipeId:unicodeVersion.recipeId,sourceVersionId:unicodeVersion.versionId}});
    const nextVersion=await request('/drafts/'+nextDraft.draftId+'/publish',{method:'POST',token:author,revision:nextDraft.revision,body:{}});
    await checkNativeInstall({root,tmp,origin,author,accountId,version:unicodeVersion,nextVersion,sql});
    const {checkNativeAuthoring} = await import('./native-authoring-check.mjs');
    await checkNativeAuthoring({root,tmp,origin,author,reader,accountId,sql,request});
    console.log('PASS: native boundary reads Unicode versions and recovers a lost code batch after cross-client redemption and disable.');
    const spare=await request('/versions/'+v.versionId+'/codes',{method:'POST',token:author,body:{count:2}});
    for (const token of [author,other]) {
      const noOpKey=randomUUID();
      const noOp={method:'POST',token,body:{},key:noOpKey};
      const acquired=await request('/versions/'+v2.versionId+'/acquire',noOp);
      assert.deepEqual(await request('/versions/'+v2.versionId+'/acquire',noOp),acquired);
      await request('/versions/'+v.versionId+'/acquire',{...noOp,status:409});
      await request(claim,{method:'POST',token,body:{code:spare.items[0].code},key:noOpKey,status:409});
    }
    const alreadyGrantedKey=randomUUID();
    const alreadyGranted={method:'POST',token:reader,body:{code:spare.items[0].code},key:alreadyGrantedKey};
    await request(claim,alreadyGranted);
    await request(claim,alreadyGranted);
    await request(claim,{...alreadyGranted,body:{code:spare.items[1].code},status:409});
    const unchanged=await request('/versions/'+v.versionId+'/codes',{token:author});
    for (const code of spare.items) assert.equal(unchanged.items.find(c=>c.codeId===code.codeId).status,'available');
    // Two different accounts submit the same still-valid code at the same time.
    const issued=await request('/versions/'+v.versionId+'/codes',{method:'POST',token:author,body:{count:1}});
    const competitors=[jwt(randomUUID()),jwt(randomUUID())];
    const statuses=await Promise.all(competitors.map(token=>fetch(origin+'/v1'+claim,{method:'POST',headers:{...json,authorization:'Bearer '+token,'idempotency-key':randomUUID()},body:JSON.stringify({code:issued.items[0].code})}).then(r=>r.status)));
    assert.equal(statuses.filter(s=>s===200).length,1);assert.ok(statuses.some(s=>s>=400&&s<500));
    const bodies=await Promise.all(competitors.map(token=>request(detail,{token})));
    assert.equal(bodies.filter(d=>d.config?.role===config.role).length,1);
    const pausedDraft=await request('/drafts',{method:'POST',token:author,body:{public:pub,config}});
    for (const status of ['stopped','disabled']) {
      sql(`update recipe_private.accounts set status='${status}' where id='${accountId}'`);
      for (const path of ['/me','/me/drafts','/me/recipes','/me/publications','/drafts/'+pausedDraft.draftId,
        '/versions/'+v.versionId+'/codes',detail,'/community/recipes']) {
        const response=await request(path,{token:author,status:403});
        assert.equal(response.error.code,'account_disabled');
      }
      for (const [path,method,body] of [
        ['/drafts','POST',{public:pub,config}],
        ['/drafts/'+pausedDraft.draftId,'PATCH',{public:pub,config}],
        ['/drafts/'+pausedDraft.draftId,'DELETE',{}],
        ['/drafts/'+pausedDraft.draftId+'/publish','POST',{}],
        ['/versions/'+v2.versionId+'/acquire','POST',{}],
        [claim,'POST',{code:spare.items[0].code}],
        ['/versions/'+v.versionId+'/codes','POST',{count:1}],
        ['/codes/'+spare.items[0].codeId+'/disable','POST',{}],
        ['/codes/'+spare.items[0].codeId+'/reveal','POST',{}],
      ]) assert.equal((await request(path,{method,body,token:author,revision:pausedDraft.revision,status:403})).error.code,'account_disabled');
      assert.ok(!('config' in await request(detail)));
      sql(`update recipe_private.accounts set status='active' where id='${accountId}'`);
    }
    assert.equal((await request('/drafts/'+pausedDraft.draftId,{token:author})).revision,pausedDraft.revision);
    assert.equal(sql(`select owner_id::text from recipe_private.versions where id='${v.versionId}'`),accountId);
    assert.equal(sql(`select actor::text from recipe_private.grants where version_id='${v.versionId}' and actor='${(await request('/me',{token:reader})).accountId}'`),
      (await request('/me',{token:reader})).accountId);
    const { checkInstallOperations } = await import('../../services/recipe-api/test/operations.pg.mjs');
    await checkInstallOperations({request,sql,jwt,author,reader,other,v,v2,legacy,pgEnv,config});
    let remaining=500-Number(sql(`select count(*) from recipe_private.codes where owner_id='${accountId}'`));
    let lastBatch;
    while (remaining>0) {
      const count=Math.min(100,remaining),key=randomUUID();
      lastBatch={method:'POST',token:author,body:{count},key};
      await request('/versions/'+v.versionId+'/codes',lastBatch);
      remaining-=count;
    }
    await request('/versions/'+v.versionId+'/codes',lastBatch);
    assert.equal((await request('/versions/'+v.versionId+'/codes',{
      method:'POST',token:author,body:{count:1},status:429})).error.code,'rate_limited');
    assert.equal(sql(`select count(*) from recipe_private.codes where owner_id='${accountId}'`),'500');
    console.log('PASS: real PostgreSQL + HTTP: mapped identities, concurrent first login, legacy upgrade, issuer pin, disabled accounts, private scopes, idempotent grants and finite code quota.');
  }
} finally {
  try { if(webServer?.listening)await closeServer(webServer);await service?.close(); } finally {
    try { if(issuerServer?.listening)await closeServer(issuerServer); } finally {
      if(up)pg('pg_ctl',['-D',db,'-m','fast','-w','stop']);
      rmSync(tmp,{recursive:true,force:true});
    }
  }
}
