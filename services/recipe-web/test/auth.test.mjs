import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogin, createLoginAdmission, returnPath } from '../auth.mjs';

const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} });
const cookie = value => value.split(';', 1)[0];

test('personal library return state is an explicit four-value allowlist', () => {
  for (const state of ['all','acquired','drafts','published']) assert.equal(returnPath('/library?state=' + state),'/library?state=' + state);
  for (const value of ['/library?state=other','/library?state=published&state=drafts','/library?state=published&next=https://evil.example','/library?from=creator','/library?state=//evil.example']) assert.equal(returnPath(value),'/');
});

test('web OAuth selects accounts for GitHub and Google while preserving PKCE and exact callback', t => {
  const login = createLogin({publicOrigin: 'https://community.example', supabaseOrigin: 'https://issuer.example',
    publishableKey: 'synthetic', providerNames: ['github', 'google', 'apple']});
  t.after(() => login.stop());
  for (const provider of ['github', 'google', 'apple']) {
    const res = response(); login.start({headers: {}}, res, new URLSearchParams({provider}));
    const url = new URL(res.headers.Location);
    assert.equal(url.origin + url.pathname, 'https://issuer.example/auth/v1/authorize');
    assert.equal(url.searchParams.get('provider'), provider);
    assert.equal(url.searchParams.get('prompt'), provider === 'apple' ? null : 'select_account');
    assert.equal(url.searchParams.get('redirect_to'), 'https://community.example/auth/callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 's256');
    assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  }
});

test('logout invalidates a write that is waiting for token refresh', async t => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async url => {
    if (url.includes('grant_type=refresh_token')) {
      await new Promise(resolve => { release = resolve; });
      return Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 });
    }
    return Response.json({ access_token: 'expired-access', refresh_token: 'refresh', expires_in: 1 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = createLogin({ publicOrigin: 'http://localhost:1234', supabaseOrigin: 'http://localhost:1235',
    publishableKey: 'test', providerNames: ['github'] });
  t.after(() => login.stop());
  const start = response();
  login.start({ headers: {} }, start, new URLSearchParams({ provider: 'github' }));
  const finish = response();
  await login.callback({ headers: { cookie: cookie(start.headers['Set-Cookie']) } }, finish,
    new URL('http://localhost:1234/auth/callback?code=synthetic'));
  const req = { headers: { cookie: cookie(finish.headers['Set-Cookie'][1]) } };
  req.headers['x-vonvon-session'] = login.status(req).displaySession;
  const pending = login.access(req, { write: true });
  login.logout(req, response());
  release();
  await assert.rejects(pending, { status: 409, message: 'session_changed' });
  assert.equal(login.status(req).signedIn, false);
});

test('a token obtained before logout cannot be forwarded after an await boundary', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ access_token: 'valid-access', refresh_token: 'refresh', expires_in: 3600 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = createLogin({ publicOrigin: 'http://localhost:1234', supabaseOrigin: 'http://localhost:1235',
    publishableKey: 'test', providerNames: ['github'] });
  t.after(() => login.stop());
  const start = response();
  login.start({ headers: {} }, start, new URLSearchParams({ provider: 'github' }));
  const finish = response();
  await login.callback({ headers: { cookie: cookie(start.headers['Set-Cookie']) } }, finish,
    new URL('http://localhost:1234/auth/callback?code=synthetic'));
  const req = { headers: { cookie: cookie(finish.headers['Set-Cookie'][1]) } };
  req.headers['x-vonvon-session'] = login.status(req).displaySession;
  const access = await login.access(req, { write: true });
  login.assertAccess(req, access, { write: true });
  login.logout(req, response());
  assert.throws(() => login.assertAccess(req, access, { write: true }), { status: 409, message: 'session_changed' });
});

for (const action of ['logout', 'start']) {
  test(action + ' invalidates a callback waiting for its PKCE exchange', async t => {
    const originalFetch = globalThis.fetch;
    let release, exchanges = 0;
    globalThis.fetch = async () => {
      if (++exchanges === 1) await new Promise(resolve => { release = resolve; });
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const login = createLogin({ publicOrigin: 'http://localhost:1234', supabaseOrigin: 'http://localhost:1235',
      publishableKey: 'test', providerNames: ['github'] });
    t.after(() => login.stop());
    const start = response();
    login.start({ headers: {} }, start, new URLSearchParams({ provider: 'github' }));
    const req = { headers: { cookie: cookie(start.headers['Set-Cookie']) } }, finish = response();
    const pending = login.callback(req, finish, new URL('http://localhost:1234/auth/callback?code=synthetic'));
    const next = response();
    if (action === 'logout') login.logout(req, next);
    else login.start(req, next, new URLSearchParams({ provider: 'github' }));
    release(); await pending;
    assert.equal(finish.headers.Location, '/login?returnTo=%2F&auth=failed#');
    assert.equal(finish.headers['Set-Cookie'], undefined);
    if (action === 'start') {
      const current = response();
      await login.callback({ headers: { cookie: cookie(next.headers['Set-Cookie']) } }, current,
        new URL('http://localhost:1234/auth/callback?code=current'));
      assert.equal(current.headers.Location, '/#');
      const sessionCookie = cookie(current.headers['Set-Cookie'][1]);
      assert.equal(login.status({ headers: { cookie: sessionCookie } }).signedIn, true);
    }
  });
}

test('a duplicate callback cannot exchange the same flow concurrently', async t => {
  const originalFetch = globalThis.fetch;
  let release, exchanges = 0;
  globalThis.fetch = async () => {
    exchanges++; await new Promise(resolve => { release = resolve; });
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = createLogin({ publicOrigin: 'http://localhost:1234', supabaseOrigin: 'http://localhost:1235',
    publishableKey: 'test', providerNames: ['github'] });
  t.after(() => login.stop());
  const start = response();
  login.start({ headers: {} }, start, new URLSearchParams({ provider: 'github' }));
  const req = { headers: { cookie: cookie(start.headers['Set-Cookie']) } }, finish = response();
  const url = new URL('http://localhost:1234/auth/callback?code=synthetic');
  const pending = login.callback(req, finish, url), duplicate = response();
  await login.callback(req, duplicate, url);
  assert.equal(duplicate.headers['Set-Cookie'], undefined); assert.equal(exchanges, 1);
  release(); await pending;
  assert.equal(finish.headers.Location, '/#');
});

test('anonymous login admission has a bounded burst and recovers over time', () => {
  let now = 1000;
  const admit = createLoginAdmission({ now: () => now });
  for (let i = 0; i < 32; i++) admit();
  assert.throws(admit, { status: 429, message: 'busy' });
  now += 1000;
  admit();
  assert.throws(admit, { status: 429 });
  now += 100_000;
  for (let i = 0; i < 32; i++) admit();
  assert.throws(admit, { status: 429 });
});

test('forged browser origins cannot bypass the login admission budget', () => {
  const login = createLogin({ publicOrigin: 'https://community.example', supabaseOrigin: 'https://issuer.example',
    publishableKey: 'test', providerNames: ['github'] });
  try {
    for (let i = 0; i < 32; i++) {
      login.start({ headers: { origin: 'https://' + i + '.example' } }, response(), new URLSearchParams({ provider: 'github' }));
    }
    assert.throws(() => login.start({ headers: {} }, response(), new URLSearchParams({ provider: 'github' })),
      { status: 429, message: 'busy' });
  } finally { login.stop(); }
});

test('only allowlisted acquisition flows return a one-use exact-version continuation', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({access_token:'access',refresh_token:'refresh',expires_in:3600});
  t.after(() => {globalThis.fetch = originalFetch;});
  const login = createLogin({publicOrigin:'http://localhost:1234',supabaseOrigin:'http://localhost:1235',publishableKey:'test',providerNames:['github']});
  t.after(() => login.stop());
  const path = '/recipes/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222';
  for (const [returnTo, continuation, expected] of [[path,'acquire',path],[path,'',undefined],['https://evil.example','acquire',undefined],['/library','acquire',undefined],[path,'redeem',undefined]]) {
    const start = response();
    login.start({headers:{}}, start, new URLSearchParams({provider:'github',returnTo,continuation,continuationNonce:'a'.repeat(64)}));
    const finish = response();
    await login.callback({headers:{cookie:cookie(start.headers['Set-Cookie'])}},finish,new URL('http://localhost:1234/auth/callback?code=ok'));
    assert.equal(finish.headers.Location, (returnTo.startsWith('https:') ? '/' : returnTo) + '#');
    const req = {headers:{cookie:cookie(finish.headers['Set-Cookie'][1])}};
    assert.equal(login.status(req).continuation, expected);
    assert.equal(login.status(req).continuation, expected);
    assert.equal(login.status(req).continuationNonce, undefined);
    req.headers['x-vonvon-session'] = 'stale-session';
    assert.throws(() => login.consumeContinuation(req, path, 'a'.repeat(64)), {status:409});
    req.headers['x-vonvon-session'] = login.status(req).displaySession;
    assert.deepEqual(login.consumeContinuation(req, path, 'b'.repeat(64)), {consumed:false});
    assert.deepEqual(login.consumeContinuation(req, '/library', 'a'.repeat(64)), {consumed:false});
    assert.equal(login.status(req).continuation, expected);
    assert.deepEqual(login.consumeContinuation(req, path, 'a'.repeat(64)), {consumed:Boolean(expected)});
    assert.deepEqual(login.consumeContinuation(req, path, 'a'.repeat(64)), {consumed:false});
    assert.equal(login.status(req).continuation, undefined);
  }
  const start = response();
  login.start({headers:{}},start,new URLSearchParams({provider:'github',returnTo:path,continuation:'acquire'}));
  const failed = response();
  await login.callback({headers:{cookie:cookie(start.headers['Set-Cookie'])}},failed,new URL('http://localhost:1234/auth/callback?error=access_denied'));
  assert.equal(failed.headers.Location,'/login?'+new URLSearchParams({returnTo:path,auth:'cancelled'})+'#');
  assert.equal(failed.headers['Set-Cookie'].length,1);
});

test('return paths preserve only bounded search and recipe provenance with canonical encoding', () => {
  const recipe='/recipes/ABCDEF12-1234-4234-8234-ABCDEF123456/versions/ABCDEF12-1234-4234-8234-ABCDEF123456';
  const author='ABCDEF12-1234-4234-8234-ABCDEF123456';
  for(const path of ['/library','/publications','/studio','/account','/authors/'+author,recipe])assert.equal(returnPath(path),path.toLowerCase());
  assert.equal(returnPath('/?q=Alice%20%26%20%E4%BD%A0'), '/?q=Alice+%26+%E4%BD%A0');
  assert.equal(returnPath('/?q='+('你'.repeat(120))), '/?'+new URLSearchParams({q:'你'.repeat(120)}));
  for(const from of ['library','library-all','published','creator'])assert.equal(returnPath(recipe+'?from='+from),recipe.toLowerCase()+'?from='+from);
  assert.equal(returnPath(recipe+'?author='+author+'&from=author'),recipe.toLowerCase()+'?from=author&author='+author.toLowerCase());
  for(const value of [undefined,null,12,'https://evil.example','javascript:alert(1)','//evil.example','///evil.example','/\\evil','/login','/auth/native',
    '/account?match=secret','/account?returnTo=/library','/library?q=search','/authors/'+author+'?q=search','/unknown','/./account','/%61ccount','/account#x',
    '/?q=one&q=two','/?unknown=x','/?q='+('a'.repeat(121)),'/?q=%0a','/?q=%00','/?q=%C2%85','/?q=%E2%80%A8','/?q=%5c','/?q=%','/account\n','/account\t',
    recipe+'?from=unknown',recipe+'?author='+author,recipe+'?from=author',recipe+'?from=library&author='+author,recipe+'?from=creator&author='+author,recipe+'?from=library-all&author='+author,
    recipe+'?from=author&author=bad',recipe+'?from=author&author='+author+'&author='+author,recipe+'?from=library&from=published',recipe+'?q=search',recipe+'?from=library#x'])assert.equal(returnPath(value),'/',String(value));
});

for (const provider of ['github', 'google', 'apple']) test(provider + ' denial preserves the exact return context and permits a fresh login', async t => {
  const previous = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async () => {exchanges++; return Response.json({access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600});};
  t.after(() => {globalThis.fetch = previous;});
  const login = createLogin({publicOrigin: 'https://community.example', supabaseOrigin: 'https://issuer.example', publishableKey: 'synthetic', providerNames: [provider]});
  t.after(() => login.stop());
  const returnTo = '/recipes/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222?from=library-all';
  const start = response(); login.start({headers: {}}, start, new URLSearchParams({provider, returnTo}));
  const denied = response();
  await login.callback({headers: {cookie: cookie(start.headers['Set-Cookie'])}}, denied,
    new URL('https://community.example/auth/callback?error=access_denied&error_description=private-upstream-detail'));
  assert.equal(denied.headers.Location, '/login?' + new URLSearchParams({returnTo, auth: 'cancelled'}) + '#');
  assert.equal(denied.headers.Location.includes('private-upstream-detail'), false);
  assert.equal(exchanges, 0);
  assert.equal(login.status({headers: {}}).signedIn, false);
  const retry = response(); login.start({headers: {}}, retry, new URLSearchParams({provider, returnTo}));
  const completed = response();
  await login.callback({headers: {cookie: cookie(retry.headers['Set-Cookie'])}}, completed, new URL('https://community.example/auth/callback?code=fresh'));
  assert.equal(completed.headers.Location, returnTo + '#');
  assert.equal(exchanges, 1);
});

test('ambiguous web callbacks never exchange tokens or replace an existing session', async t => {
  const previous = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async () => {exchanges++; return Response.json({access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600});};
  t.after(() => {globalThis.fetch = previous;});
  const login = createLogin({publicOrigin: 'https://community.example', supabaseOrigin: 'https://issuer.example', publishableKey: 'synthetic', providerNames: ['github', 'google', 'apple']});
  t.after(() => login.stop());
  const start = response(); login.start({headers: {}}, start, new URLSearchParams({provider: 'github'}));
  const current = response();
  await login.callback({headers: {cookie: cookie(start.headers['Set-Cookie'])}}, current, new URL('https://community.example/auth/callback?code=valid'));
  const sessionCookie = cookie(current.headers['Set-Cookie'][1]);
  const identity = login.status({headers: {cookie: sessionCookie}});
  for (const query of ['?code=one&code=two', '?code=one&error=access_denied', '?code=one&returnTo=//evil.example']) {
    const next = response(); login.start({headers: {cookie: sessionCookie}}, next, new URLSearchParams({provider: 'apple', returnTo: '/library?state=acquired'}));
    const rejected = response();
    await login.callback({headers: {cookie: sessionCookie + '; ' + cookie(next.headers['Set-Cookie'])}}, rejected, new URL('https://community.example/auth/callback' + query));
    assert.equal(rejected.headers.Location, '/login?' + new URLSearchParams({returnTo: '/library?state=acquired', auth: 'failed'}) + '#');
    assert.deepEqual(login.status({headers: {cookie: sessionCookie}}), identity);
    assert.equal(exchanges, 1);
  }
});

test('OAuth returns original sanitized search/detail queries and retries failures on the login page', async t => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({access_token:'access',refresh_token:'refresh',expires_in:3600});
  t.after(()=>{globalThis.fetch=originalFetch;});
  const login=createLogin({publicOrigin:'http://localhost:1234',supabaseOrigin:'http://localhost:1235',publishableKey:'test',providerNames:['google']});
  t.after(()=>login.stop());
  assert.equal(login.status({headers:{}}).provider,undefined);
  const path='/recipes/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222';
  for(const returnTo of ['/?q=Alice%20%26%20Bob',path+'?from=library',path+'?from=author&author=33333333-3333-4333-8333-333333333333']){
    const start=response();login.start({headers:{}},start,new URLSearchParams({provider:'google',returnTo,continuation:'acquire',continuationNonce:'a'.repeat(64)}));
    const finish=response();await login.callback({headers:{cookie:cookie(start.headers['Set-Cookie'])}},finish,new URL('http://localhost:1234/auth/callback?code=ok'));
    assert.equal(finish.headers.Location,returnPath(returnTo)+'#');
    const req={headers:{cookie:cookie(finish.headers['Set-Cookie'][1])}};
    assert.equal(login.status(req).provider,'google');
    assert.equal(login.status(req).continuation,returnTo.startsWith('/recipes/')?path:undefined);
    const retry=response();login.start(req,retry,new URLSearchParams({provider:'google',returnTo}));
    const failed=response();await login.callback({headers:{cookie:cookie(retry.headers['Set-Cookie'])}},failed,new URL('http://localhost:1234/auth/callback?error=denied'));
    const url=new URL(failed.headers.Location,'http://localhost:1234');
    assert.equal(url.pathname,'/login');assert.equal(url.searchParams.get('returnTo'),returnPath(returnTo));assert.equal(url.searchParams.get('auth'),'failed');
    assert.equal(failed.headers['Set-Cookie'].length,1);
    assert.equal(login.status(req).provider,'google');
  }
});
