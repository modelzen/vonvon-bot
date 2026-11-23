import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {createLogin, returnPath} from '../auth.mjs';
import {createReleaseCodeAuth} from '../release-code-oauth.mjs';

const html = await readFile(new URL('../public/login.html', import.meta.url), 'utf8');
const home = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/login.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(setImmediate);
};

function memoryStore() {
  const rows = new Map();
  class Adapter {
    constructor(name) {this.name = name;}
    upsert(id, value) {rows.set(this.name + id, structuredClone(value));}
    find(id) {return structuredClone(rows.get(this.name + id));}
    by(field, value) {
      return structuredClone([...rows].find(([key, row]) => key.startsWith(this.name) && row[field] === value)?.[1]);
    }
    findByUserCode(value) {return this.by('userCode', value);}
    findByUid(value) {return this.by('uid', value);}
    destroy(id) {rows.delete(this.name + id);}
    consume(id) {rows.get(this.name + id).consumed = Math.floor(Date.now() / 1000);}
    revokeByGrantId(id) {
      for (const [key, row] of rows) if (row.grantId === id) rows.delete(key);
    }
  }
  const bindings = new Map();
  return {Adapter, bindings, bind: (id, account) => bindings.set(id, account),
    validGrant: (id, account) => bindings.get(id) === account, logout: () => bindings.clear(), close() {}};
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function fixture(t) {
  let exchanges = 0;
  const supabase = createServer(async (req, res) => {
    assert.equal(req.url, '/auth/v1/token?grant_type=pkce');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.apikey, 'synthetic-public-key');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.auth_code, 'synthetic-success');
    assert.match(body.code_verifier, /^[A-Za-z0-9._~-]{43,128}$/);
    exchanges++;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, user: {id: '11111111-1111-4111-8111-111111111111'}}));
  });
  const supabaseOrigin = await listen(supabase);
  t.after(() => close(supabase));
  const server = createServer();
  const origin = await listen(server);
  const login = createLogin({publicOrigin: origin, supabaseOrigin, publishableKey: 'synthetic-public-key', providerNames: ['github', 'google']});
  const store = memoryStore();
  const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'P-256'});
  const accountId = randomUUID(), sessionId = randomUUID(), issuer = origin + '/release-code/oauth';
  const app = createReleaseCodeAuth({env: {RELEASE_CODE_ISSUER: issuer, RELEASE_CODE_RESOURCE: origin + '/mcp'}, publicOrigin: origin, login}, {
    config: {jwks: {keys: [{...privateKey.export({format: 'jwk'}), alg: 'ES256', kid: 'login-fixture', use: 'sig'}]},
      cookies: ['offline-shared-login-fixture-cookie-signing-key']},
    store,
    account: async req => {
      const access = await login.access(req);
      login.assertAccess(req, access);
      return access === 'synthetic-access' ? {accountId, sessionId, webSession: login.status(req).displaySession} : null;
    },
  });
  server.on('request', (req, res) => void (async () => {
    const url = new URL(req.url, origin);
    if (await app.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {'content-type': 'text/html'});
      return res.end(home);
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
      return res.end(html.replaceAll('__LOGIN_RETURN_TO__', encodeURIComponent(returnPath(url.searchParams.get('returnTo'))))
        .replaceAll('__COMMUNITY_URL__', '/')
        .replaceAll('__LOGIN_ERROR__', url.searchParams.get('auth') === 'cancelled' ? 'cancelled' : 'false')
        .replaceAll('__LOGIN_MODE__', 'web'));
    }
    if (req.method === 'GET' && url.pathname === '/auth/session') {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify(login.status(req)));
    }
    if (req.method === 'POST' && url.pathname === '/auth/start') {
      assert.equal(req.headers.origin, origin);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      return login.start(req, res, new URLSearchParams(raw));
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') return login.callback(req, res, url);
    res.writeHead(404); res.end();
  })().catch(error => {res.writeHead(error.status || 500); res.end(String(error));}));
  t.after(async () => {app.close(); login.stop(); await close(server);});
  const jar = new Map();
  async function request(path, form) {
    const response = await fetch(new URL(path, origin), {redirect: 'manual',
      headers: {origin, cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ')},
      ...(form && {method: 'POST', body: new URLSearchParams(form)})});
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';'), index = pair.indexOf('=');
      if (/Max-Age=0(?:;|$)/.test(header)) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function renderedLogin(path) {
    const response = await request(path);
    assert.equal(response.status, 200);
    const dom = new JSDOM(await response.text(), {url: new URL(path, origin).href});
    t.after(() => dom.window.close());
    const domFetch = async (url, options) => {
      assert.equal(url, '/auth/session');
      assert.equal(options.credentials, 'same-origin');
      return request(url);
    };
    await new AsyncFunction('document', 'window', 'location', 'sessionStorage', 'fetch', 'BroadcastChannel', 'AbortSignal', script)(
      dom.window.document, dom.window, {origin}, dom.window.sessionStorage, domFetch, undefined, AbortSignal);
    for (let i = 0; i < 30 && !dom.window.document.querySelector('#login-providers form'); i++) await settle();
    return dom.window.document;
  }
  async function confirmation() {
    const device = await (await request(issuer + '/device/auth', {client_id: 'vonvon-feedback-bot', resource: origin + '/mcp', scope: 'release-code:read offline_access'})).json();
    const xsrf = text => text.match(/name="xsrf" value="([^"]+)"/)?.[1];
    const begin = await (await request(device.verification_uri_complete)).text();
    const verify = await (await request(device.verification_uri, {user_code: device.user_code, xsrf: xsrf(begin)})).text();
    const response = await request(device.verification_uri, {user_code: device.user_code, xsrf: xsrf(verify), confirm: 'yes'});
    assert.equal(response.status, 303);
    return new URL(response.headers.get('location')).pathname;
  }
  return {origin, issuer, supabaseOrigin, request, renderedLogin, confirmation, store, exchanges: () => exchanges};
}

for (const provider of ['github', 'google']) test(provider + ' source approval returns through the shared DOM login and real PKCE HTTP callback', async t => {
  const f = await fixture(t);
  let path;
  // Use a real protocol interaction with both letter cases, not a made-up UID.
  for (let i = 0; i < 8; i++) {
    path = await f.confirmation();
    const uid = path.split('/').at(-1);
    if (/[a-z]/.test(uid) && /[A-Z]/.test(uid)) break;
  }
  assert.match(path, /^\/release-code\/confirm\/(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{8,128}$/);
  const first = await f.request(path);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const loginPath = '/login?' + new URLSearchParams({returnTo: path});
  assert.equal(first.headers.get('location'), loginPath);
  const document = await f.renderedLogin(loginPath);
  assert.equal(document.querySelector('#login-cancel'), null);
  assert.equal(document.querySelector('#login-continue').getAttribute('href'), path);
  const cancelled = await f.request(document.querySelector('.auth-mast .brand').getAttribute('href'));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.headers.get('location'), null, 'the brand links to the community outside the authorization flow');
  const forms = [...document.querySelectorAll('#login-providers form')];
  assert.equal(forms.length, 2);
  for (const form of forms) {
    assert.equal(form.getAttribute('action'), '/auth/start');
    assert.equal(form.querySelector('[name=returnTo]').value, path);
    assert.equal(form.querySelector('[name=continuation]'), null);
  }
  const form = forms.find(item => item.querySelector('[name=provider]').value === provider);
  const fields = Object.fromEntries([...form.querySelectorAll('input')].map(input => [input.name, input.value]));
  const start = await f.request('/auth/start', fields);
  assert.equal(start.status, 303);
  const upstream = new URL(start.headers.get('location'));
  assert.equal(upstream.origin, f.supabaseOrigin);
  assert.equal(upstream.pathname, '/auth/v1/authorize');
  assert.equal(upstream.searchParams.get('provider'), provider);
  assert.equal(upstream.searchParams.get('redirect_to'), f.origin + '/auth/callback');
  assert.equal(upstream.searchParams.get('code_challenge_method'), 's256');
  assert.match(upstream.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const denied = await f.request('/auth/callback?error=access_denied&error_description=private-upstream-message');
  assert.equal(denied.status, 303);
  assert.equal(denied.headers.get('location'), '/login?' + new URLSearchParams({returnTo: path, auth: 'cancelled'}) + '#');
  assert.equal(f.exchanges(), 0);
  const retryDocument = await f.renderedLogin(denied.headers.get('location'));
  assert.match(retryDocument.querySelector('#login-error').textContent, /你已取消登录/);
  assert.equal(retryDocument.querySelector('[name=returnTo]').value, path);
  assert.equal((await f.request('/auth/start', fields)).status, 303);
  const callback = await f.request('/auth/callback?code=synthetic-success');
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), path + '#');
  assert.equal(f.exchanges(), 1);
  const returned = await f.request(callback.headers.get('location'));
  assert.equal(returned.status, 200);
  const content = await returned.text();
  assert.match(content, /允许查阅/);
  assert.doesNotMatch(content, /action="\/auth\/start"/);
  assert.equal(f.store.bindings.size, 0, 'account login does not grant code access without explicit approval');
});

test('source approval return allowlists reject query, fragment, encoded paths and wrong UID lengths in server and DOM', async t => {
  const f = await fixture(t);
  const path = '/release-code/confirm/AbCd_123-xYz';
  const cases = [[path, path], ['/release-code/confirm/' + 'a'.repeat(8), '/release-code/confirm/' + 'a'.repeat(8)],
    ['/release-code/confirm/' + 'Z'.repeat(128), '/release-code/confirm/' + 'Z'.repeat(128)]];
  for (const invalid of [path + '?', path + '?a=1', path + '#fragment', path + '/', path + '%2Ffile',
    '/release-code/confirm/short', '/release-code/confirm/' + 'a'.repeat(129),
    '/release-code/confirm/%41bCd_123-xYz', '/release-code/confirm/AbCd.123-xYz',
    '/Release-code/confirm/AbCd_123-xYz', '//evil.example' + path, path + '\n']) cases.push([invalid, '/']);
  for (const [value, expected] of cases) {
    assert.equal(returnPath(value), expected, value);
    // Exercise the browser validator independently of the server sanitization.
    const dom = new JSDOM(html.replaceAll('__LOGIN_RETURN_TO__', encodeURIComponent(value)).replaceAll('__LOGIN_MODE__', 'web'), {url: f.origin + '/login'});
    t.after(() => dom.window.close());
    await new AsyncFunction('document', 'window', 'location', 'sessionStorage', 'fetch', 'BroadcastChannel', 'AbortSignal', script)(
      dom.window.document, dom.window, {origin: f.origin}, dom.window.sessionStorage,
      async () => Response.json({signedIn: false, providers: ['github', 'google']}), undefined, AbortSignal);
    await settle();
    assert.equal(dom.window.document.querySelector('[name=returnTo]').value, expected, value);
    assert.equal(dom.window.document.querySelector('#login-continue').getAttribute('href'), expected, value);
  }
});
