import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogin, createLoginAdmission } from '../auth.mjs';

const response = () => ({ writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} });
const cookie = value => value.split(';', 1)[0];

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
    assert.equal(finish.headers.Location, '/?auth=failed');
    assert.equal(finish.headers['Set-Cookie'], undefined);
    if (action === 'start') {
      const current = response();
      await login.callback({ headers: { cookie: cookie(next.headers['Set-Cookie']) } }, current,
        new URL('http://localhost:1234/auth/callback?code=current'));
      assert.equal(current.headers.Location, '/');
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
  assert.equal(finish.headers.Location, '/');
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
    assert.equal(finish.headers.Location, returnTo.startsWith('https:') ? '/' : returnTo);
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
  assert.equal(failed.headers.Location,path+'?auth=failed');
  assert.equal(failed.headers['Set-Cookie'].length,1);
});
