import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash } from 'node:crypto';
import { createRecipeWeb } from '../server.mjs';
import { returnPath } from '../auth.mjs';
import {displayLogoLimit} from '../dist/rich-detail.mjs';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}
const r = '80b2a4df-0e0c-4e18-a90a-fda1c1ea7faa';
const v = '76ba7564-7ad3-4b46-833b-be9bb4827b77';
const detail = '/recipes/' + r + '/versions/' + v;
const toJson = (res, data) => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); };
const cookie = response => response.headers.getSetCookie().map(x => x.split(';', 1)[0]).join('; ');

test('public version logo route bounds and validates broker bytes without forwarding browser credentials', async t => {
  const seen = []; let payload = Buffer.from('<svg onload="alert(1)"></svg>');
  const broker = await listen(createServer((req, res) => {seen.push({path: req.url, authorization: req.headers.authorization}); res.end(payload);}), t);
  const host = await listen(createRecipeWeb({RECIPE_BROKER_ORIGIN: broker}), t);
  const logo = host + '/media/versions/' + v + '/logo.webp';
  assert.equal((await fetch(logo, {headers: {authorization: 'Bearer browser-supplied'}})).status, 503);
  assert.deepEqual(seen, [{path: '/v2/versions/' + v + '/display-logo', authorization: undefined}]);
  payload = Buffer.alloc(displayLogoLimit + 1);
  assert.equal((await fetch(logo)).status, 503);
  assert.equal((await fetch(host + '/media/versions/not-a-version/logo.webp')).status, 404);
  assert.equal(seen.length, 2);
});

test('return destination is always a local page', () => {
  for (const input of ['https://wrong.example/', '//wrong.example/', '/studio?next=other', '/auth/callback', '/recipes']) assert.equal(returnPath(input), '/');
  assert.equal(returnPath(detail), detail);
  assert.equal(returnPath('/studio'), '/studio');
});

test('same-origin PKCE login and claim use opaque session cookies', async t => {
  const apiCalls = [];
  const api = await listen(createServer(async (req,res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    apiCalls.push([req.method, req.url, req.headers.authorization, Buffer.concat(chunks).toString(), req.headers['idempotency-key']]);
    toJson(res, {ok:true});
  }),t);
  const exchanges = [];
  const issuer = await listen(createServer(async (req,res) => {
    const pieces=[]; for await (const c of req) pieces.push(c);
    exchanges.push({path:req.url, body:JSON.parse(Buffer.concat(pieces).toString()), apiKey:req.headers.apikey});
    toJson(res, {access_token:'synthetic-ac',refresh_token:'synthetic-rf',expires_in:3600});
  }),t);
  // The configured origin models the external HTTPS host when running behind Nginx.
  const origin = 'https://recipes.example';
  const host = await listen(createRecipeWeb({RECIPE_WEB_ORIGIN:origin, RECIPE_API_ORIGIN:api,
    SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'test-publishable',RECIPE_WEB_PROVIDERS:'github'}),t);
  let response = await fetch(host+'/auth/session');
  assert.deepEqual(await response.json(), {signedIn:false,providers:['github']});
  response = await fetch(host+'/api/v1/community/recipes', {headers:{Authorization:'Bearer client-supplied'}});
  assert.equal(response.status,200); assert.equal(apiCalls[0][2], undefined);
  let start = await fetch(host+'/auth/start', {method:'POST', redirect:'manual', headers:{origin}, body:new URLSearchParams({provider:'github',returnTo:detail})});
  assert.equal(start.status,303);
  assert.match(start.headers.get('set-cookie'),/HttpOnly/);
  assert.match(start.headers.get('set-cookie'),/; Secure/);
  const authorize=new URL(start.headers.get('location'));
  assert.equal(authorize.origin,issuer); assert.equal(authorize.searchParams.get('redirect_to'),origin+'/auth/callback');
  // A callback without the browser that started this flow cannot make a session or exchange the code.
  let finish=await fetch(host+'/auth/callback?code=hello',{redirect:'manual'});
  assert.equal(finish.headers.get('location'),'/login?returnTo=%2F&auth=failed#'); assert.equal(exchanges.length,0);
  finish=await fetch(host+'/auth/callback?code=hello',{redirect:'manual',headers:{cookie:cookie(start)}});
  assert.equal(finish.status,303); assert.equal(finish.headers.get('location'),detail+'#');
  assert.equal(start.headers.get('referrer-policy'), 'same-origin');
  assert.equal(finish.headers.get('referrer-policy'), 'no-referrer');
  const opaque=cookie(finish);
  assert.ok(!opaque.includes('synthetic-ac')); assert.ok(!opaque.includes('synthetic-rf'));
  assert.equal(exchanges.length,1); assert.equal(exchanges[0].path,'/auth/v1/token?grant_type=pkce');
  assert.equal(exchanges[0].body.auth_code,'hello');
  assert.equal(createHash('sha256').update(exchanges[0].body.code_verifier).digest('base64url'),authorize.searchParams.get('code_challenge'));
  assert.equal(exchanges[0].apiKey,'test-publishable');
  const replay=await fetch(host+'/auth/callback?code=hello',{redirect:'manual',headers:{cookie:cookie(start)}});
  assert.equal(replay.headers.get('location'),'/login?returnTo=%2F&auth=failed#');assert.equal(exchanges.length,1);
  const path=host+'/api/v1/versions/'+v+'/redeem';
  const view = await fetch(host + '/auth/session', {headers:{cookie:opaque}}).then(r=>r.json());
  assert.equal(typeof view.displaySession, 'string'); assert.ok(!opaque.includes(view.displaySession));
  const headers={origin,cookie:opaque,'X-Vonvon-Session':view.displaySession,'Content-Type':'application/json','Idempotency-Key':r};
  response=await fetch(path,{method:'POST',headers:{...headers,origin:'https://wrong.example'},body:'{"code":"a"}'});
  assert.equal(response.status,403); assert.deepEqual(apiCalls.map(call=>call[1]),['/v1/community/recipes','/v2/me/account-profile']);
  response=await fetch(path,{method:'POST',headers:{...headers,'X-Vonvon-Session':'older-window'},body:'{"code":"a"}'});
  assert.equal(response.status,409); assert.equal((await response.json()).error.code, 'session_changed');
  assert.deepEqual(apiCalls.map(call=>call[1]),['/v1/community/recipes','/v2/me/account-profile']);
  response=await fetch(path,{method:'POST',headers,body:'{"code":"a"}'});
  assert.equal(response.status,200); assert.deepEqual(apiCalls.at(-1),['POST','/v1/versions/'+v+'/redeem','Bearer synthetic-ac','{"code":"a"}',r]);
  assert.equal((await fetch(host+'/api/v1/unrelated',{headers})).status,404);
  let logout=await fetch(host+'/auth/logout',{method:'POST',redirect:'manual',headers});
  assert.equal(logout.status,303);
  assert.equal((await fetch(path,{method:'POST',headers,body:'{"code":"a"}'})).status,401);
});

test('logout while a write body is pending prevents API forwarding', async t => {
  let forwarded = 0;
  const api = await listen(createServer((req, res) => { if (req.method === 'POST') forwarded++; toJson(res, { ok: true }); }), t);
  const issuer = await listen(createServer((req, res) => toJson(res,
    { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })), t);
  const origin = 'https://recipes.example';
  const server = createRecipeWeb({ RECIPE_WEB_ORIGIN: origin, RECIPE_API_ORIGIN: api,
    SUPABASE_URL: issuer, SUPABASE_PUBLISHABLE_KEY: 'test-publishable', RECIPE_WEB_PROVIDERS: 'github' });
  const host = await listen(server, t);
  const start = await fetch(host + '/auth/start', { method: 'POST', redirect: 'manual', headers: { origin },
    body: new URLSearchParams({ provider: 'github' }) });
  const finish = await fetch(host + '/auth/callback?code=synthetic', { redirect: 'manual', headers: { cookie: cookie(start) } });
  const sessionCookie = cookie(finish);
  const status = await fetch(host + '/auth/session', { headers: { cookie: sessionCookie } }).then(response => response.json());
  const payload = JSON.stringify({ code: 'synthetic' });
  const arrived = new Promise(resolve => server.once('request', resolve));
  let write;
  const result = new Promise((resolve, reject) => {
    write = request(host + '/api/v1/versions/' + v + '/redeem', { method: 'POST', headers: {
      origin, cookie: sessionCookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      'X-Vonvon-Session': status.displaySession,
    } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    write.on('error', reject); write.write(payload.slice(0, 1));
  });
  await arrived;
  const logout = await fetch(host + '/auth/logout', { method: 'POST', redirect: 'manual', headers: { origin, cookie: sessionCookie } });
  assert.equal(logout.status, 303);
  write.end(payload.slice(1));
  assert.equal(await result, 409); assert.equal(forwarded, 0);
});

test('reconciliation detail binds the displayed session, blocks changed cookies and rechecks logout after upstream await', async t => {
  let release, arrived;
  let waiting = false;
  const seen = [];
  const api = await listen(createServer(async (req,res) => {
    seen.push(req.headers.authorization);
    if (waiting) {arrived(); await new Promise(resolve => {release=resolve;});}
    toJson(res,{owned:!!req.headers.authorization});
  }),t);
  let identity=0;
  const issuer=await listen(createServer((_req,res)=>toJson(res,{access_token:'synthetic-'+ ++identity,refresh_token:'synthetic-refresh',expires_in:3600})),t);
  const origin='https://recipes.example';
  const host=await listen(createRecipeWeb({RECIPE_WEB_ORIGIN:origin,RECIPE_API_ORIGIN:api,SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'fixture',RECIPE_WEB_PROVIDERS:'github'}),t);
  async function login() {
    const start=await fetch(host+'/auth/start',{method:'POST',redirect:'manual',headers:{origin},body:new URLSearchParams({provider:'github'})});
    const finish=await fetch(host+'/auth/callback?code=fixture',{redirect:'manual',headers:{cookie:cookie(start)}});
    const sessionCookie=cookie(finish);
    const view=await fetch(host+'/auth/session',{headers:{cookie:sessionCookie}}).then(r=>r.json());
    return {cookie:sessionCookie,'X-Vonvon-Session':view.displaySession};
  }
  const a=await login(),b=await login(), path=host+'/api/v1'+detail;
  for (const privatePath of ['/api/v2/me/recipes', '/api/v2/me/publications']) {
    assert.equal((await fetch(host + privatePath, {headers: {...b, 'X-Vonvon-Session': a['X-Vonvon-Session']}})).status, 409);
    assert.equal((await fetch(host + privatePath, {headers: {cookie: b.cookie}})).status, 409);
    assert.equal((await fetch(host + privatePath, {headers: a})).status, 200);
  }

  assert.equal((await fetch(path,{headers:a})).status,200);
  const count=seen.length;
  for (const headers of [{'X-Vonvon-Session':a['X-Vonvon-Session']},{...b,'X-Vonvon-Session':a['X-Vonvon-Session']}]) {
    const response=await fetch(path,{headers});assert.equal(response.status,409);assert.equal((await response.json()).error.code,'session_changed');
  }
  assert.equal(seen.length,count);
  assert.equal((await fetch(path)).status,200);assert.equal(seen.at(-1),undefined);
  waiting=true;
  const started=new Promise(resolve=>{arrived=resolve;});
  const pending=fetch(path,{headers:a});await started;
  await fetch(host+'/auth/logout',{method:'POST',redirect:'manual',headers:{...a,origin}});
  release();const response=await pending;
  assert.equal(response.status,409);assert.equal((await response.json()).error.code,'session_changed');
});
