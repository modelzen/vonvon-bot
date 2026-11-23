import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, get } from 'node:http';
import { createRecipeWeb } from '../server.mjs';

const community = 'https://community.vonvon.bot';
const account = 'https://account.vonvon.bot';
const accountId = '11111111-1111-4111-8111-111111111111';
const recipePath = '/recipes/' + accountId + '/versions/' + accountId;
const profile = '/api/v2/me/account-profile';
const random = () => randomBytes(32).toString('base64url');
const cookie = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
const json = (res, data) => res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify(data));

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t) {
  const api = await listen(t, createServer((req,res) => json(res, {authorId:accountId, displayName:'同步账号', revision:0})));
  const issuer = await listen(t, createServer((req,res) => json(res, {access_token:'fixture-token',refresh_token:'fixture-refresh',expires_in:3600, user: {id: accountId}})));
  const local = await listen(t, createRecipeWeb({RECIPE_WEB_ORIGIN:community,RECIPE_COMMUNITY_ORIGIN:community,RECIPE_ACCOUNT_ORIGIN:account,RECIPE_API_ORIGIN:api,
    SUPABASE_URL:issuer,SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture',RECIPE_WEB_PROVIDERS:'github,google'}));
  const request = (path, options) => fetch(local + path, {redirect:'manual', ...options});
  const accountPage = path => new Promise((resolve, reject) => {
    get(local + path, {headers:{Host:new URL(account).host}}, async res => {
      try {
        let text = '';
        res.setEncoding('utf8');
        for await (const chunk of res) text += chunk;
        resolve({status:res.statusCode, headers:res.headers, text});
      } catch (error) { reject(error); }
    }).on('error', reject);
  });
  return {issuer, request, accountPage};
}

test('account host serves its own shell and the community redirects only account pages', async t => {
  const {request, accountPage} = await fixture(t);
  for (const path of ['/login?returnTo=%2Flibrary', '/account?after=%2Flibrary', '/login?mode=app', '/auth/native', '/auth/native/complete']) {
    const redirect = await request(path);
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get('location'), account + path);
    const page = await accountPage(path);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-auth-origin="https:\/\/community\.vonvon\.bot"/);
    assert.match(page.headers['content-security-policy'], /connect-src 'self' https:\/\/community\.vonvon\.bot;/);
    assert.equal(page.headers['set-cookie'], undefined);
    if (path.startsWith('/login?returnTo=')) {
      assert.equal(page.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.match(page.text, /<meta name="referrer" content="strict-origin-when-cross-origin">/);
    } else if (!path.startsWith('/account')) assert.equal(page.headers['referrer-policy'], 'no-referrer');
  }
  const accountRoot = await accountPage('/');
  assert.equal(accountRoot.status, 200);
  assert.match(accountRoot.text, /href="https:\/\/community\.vonvon\.bot\/" class="brand"/);
  for (const asset of ['/mark.png', '/login.mjs', '/account.css', '/avatar-format.mjs']) assert.equal((await accountPage(asset)).status, 200);
  for (const path of ['/library','/studio','/auth/session','/auth/callback?code=fixture','/api/v2/community/recipes']) {
    assert.equal((await accountPage(path)).status, 404);
  }
  assert.equal((await request('/studio')).status, 200);
  assert.equal((await request('/library')).status, 200);
});

test('OAuth callbacks share one guarded community session with the dedicated account host', async t => {
  const {request} = await fixture(t);
  const nonce = 'a'.repeat(64);
  const start = origin => request('/auth/start', {method:'POST',headers:{origin},body:new URLSearchParams({
    provider:'github',returnTo:recipePath,continuation:'acquire',continuationNonce:nonce,
  })});
  assert.equal((await start('https://bridge.vonvon.cc')).status, 403);
  const deniedStart = await start(account);
  assert.equal(deniedStart.status,303);
  assert.equal(new URL(deniedStart.headers.get('location')).searchParams.get('redirect_to'), community + '/auth/callback');
  const cancelled = await request('/auth/callback?error=access_denied', {headers:{cookie:cookie(deniedStart)}});
  const retry = new URL(cancelled.headers.get('location'));
  assert.equal(retry.origin + retry.pathname, account + '/login');
  assert.equal(retry.searchParams.get('returnTo'), recipePath);
  assert.equal(retry.searchParams.get('auth'), 'cancelled');
  assert.equal(retry.hash, '#acquire=' + nonce);

  const pending = await start(account);
  const accepted = await request('/auth/callback?code=fixture', {headers:{cookie:cookie(pending)}});
  const next = new URL(accepted.headers.get('location'));
  assert.equal(next.origin + next.pathname, account + '/account');
  assert.equal(next.searchParams.get('after'), recipePath);
  assert.match(accepted.headers.getSetCookie()[1], /^__Host-vv-session=.*; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  const sessionCookie = cookie(accepted), signedIn = origin => request('/auth/session', {headers:{origin,cookie:sessionCookie}});
  const response = await signedIn(account);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), account);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
  const session = await response.json();
  assert.equal(session.signedIn, true);
  assert.equal(session.continuation, recipePath);
  assert.equal((await (await signedIn(community)).json()).displaySession, session.displaySession);
  assert.equal((await signedIn('https://bridge.vonvon.cc')).headers.get('Access-Control-Allow-Origin'), null);

  const preflight = (path, headers, method = 'POST') => request(path, {method:'OPTIONS',headers:{origin:account,
    'Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}});
  assert.equal((await preflight(profile, 'content-type,if-match,x-vonvon-session')).status, 204);
  assert.equal((await preflight(profile, 'authorization')).status, 403);
  assert.equal((await preflight('/auth/native/flows','content-type')).status, 403);
  assert.equal((await preflight('/api/v2/me/recipe-groups','x-vonvon-session','GET')).status, 403);
  const profileHeaders = {origin:account,cookie:sessionCookie,'X-Vonvon-Session':session.displaySession};
  assert.equal((await request(profile,{headers:profileHeaders})).status,200);
  assert.equal((await request(profile,{headers:{...profileHeaders,'X-Vonvon-Session':'stale'}})).status,409);
  assert.equal((await request('/auth/logout',{method:'POST',headers:{origin:account,cookie:sessionCookie}})).status,409);
  const logout = await request('/auth/logout',{method:'POST',headers:profileHeaders});
  assert.equal(logout.status,204);
  assert.match(logout.headers.getSetCookie()[0], /^__Host-vv-session=; Max-Age=0;/);
  assert.equal((await (await signedIn(community)).json()).signedIn,false);
});

test('App flow keeps community endpoints and binds the account-host UI to its tab', async t => {
  const {issuer, request} = await fixture(t);
  const appHeaders = {'Content-Type':'application/json','X-Vonvon-Login-Page':'unified-v1'};
  const flowBody = JSON.stringify({state:random(),confirmation:'identity-v1'});
  assert.equal((await request('/auth/native/flows',{method:'POST',headers:{...appHeaders,origin:account},body:flowBody})).status,403);
  const created = await request('/auth/native/flows',{method:'POST',headers:appHeaders,body:flowBody});
  assert.equal(created.status,201);
  const flow = await created.json();
  const launch = new URL(flow.launchUrl);
  assert.equal(launch.origin + launch.pathname + launch.search, community + '/login?mode=app');
  const binding = random(), ticket = launch.hash.slice('#ticket='.length);
  const browserHeaders = {origin:account,'Content-Type':'application/json','X-Vonvon-Native-Tab':binding};
  const launchOptions = {method:'POST',headers:browserHeaders,body:JSON.stringify({ticket,binding})};
  const wrongOrigin = await request('/auth/native/launch',{...launchOptions,headers:{...browserHeaders,origin:'https://bridge.vonvon.cc'}});
  assert.equal(wrongOrigin.status,403);
  const launched = await request('/auth/native/launch',launchOptions);
  assert.equal(launched.status,200);
  assert.equal(launched.headers.get('Access-Control-Allow-Origin'),account);
  assert.match(launched.headers.getSetCookie()[0],/^__Host-vv-native=.*; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  browserHeaders.cookie = cookie(launched);
  assert.equal((await request('/auth/native/browser',{headers:{...browserHeaders,'X-Vonvon-Native-Tab':random()}})).status,401);
  assert.equal((await request('/auth/native/select',{method:'POST',headers:browserHeaders,body:JSON.stringify({provider:'github'})})).status,200);
  const authorizeUrl = issuer + '/auth/v1/authorize?' + new URLSearchParams({provider:'github',redirect_to:community + '/auth/native/callback',
    code_challenge:random(),code_challenge_method:'s256'});
  const authorized = await request('/auth/native/flows/' + flow.flowId + '/authorize',{method:'PUT',
    headers:{'Content-Type':'application/json',Authorization:'Bearer ' + flow.pollToken},body:JSON.stringify({url:authorizeUrl})});
  assert.equal(authorized.status,200);
  const callback = await request('/auth/native/callback?code=fixture',{headers:{cookie:browserHeaders.cookie}});
  const receipt = new URL(callback.headers.get('location'));
  assert.equal(receipt.origin + receipt.pathname + receipt.search,account + '/login?mode=app');
  assert.match(receipt.hash,/^#receipt=/);
  assert.equal((await request('/auth/native/complete',{method:'POST',headers:browserHeaders,
    body:JSON.stringify({receipt:receipt.hash.slice('#receipt='.length)})})).status,200);
});
