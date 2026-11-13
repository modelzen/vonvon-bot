import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRecipeWeb } from '../server.mjs';
import { createNativeLogin } from '../native-auth.mjs';
import { WebError } from '../auth.mjs';

const origin = 'https://community.example', issuer = 'https://supabase.example';
const config = { publicOrigin: origin, supabaseOrigin: issuer, publishableKey: 'sb_publishable_synthetic', providerNames: ['github', 'google', 'apple'] };
const random = () => randomBytes(32).toString('base64url');
const cookie = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
const data = response => response.json();

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, overrides = {}) {
  const broker = createNativeLogin({ ...config, ...overrides });
  const server = createServer(async (req, res) => {
    try {
      const handled = await broker.handle(req, res, new URL(req.url, origin));
      if (!handled) res.writeHead(404).end();
    } catch (error) {
      res.writeHead(error instanceof WebError ? error.status : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: error.message } }));
    }
  });
  server.on('close', () => broker.stop());
  const host = await listen(server, t);
  const native = (path, { method = 'GET', body, token, headers = {} } = {}) => fetch(host + '/auth/native/flows' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }), redirect: 'manual',
  });
  const create = async () => {
    const state = random(), response = await native('', { method: 'POST', body: { state } });
    assert.equal(response.status, 201);
    return { ...await data(response), state };
  };
  const browser = (path, flow, { method = 'POST', body = {}, headers = {} } = {}) => fetch(host + '/auth/native/' + path, {
    method, headers: { 'Content-Type': 'application/json', cookie: flow.cookie, 'X-Vonvon-Native-Tab': flow.binding,
      ...(method === 'POST' && { Origin: origin }), ...headers }, ...(method === 'POST' && { body: JSON.stringify(body) }), redirect: 'manual',
  });
  const launch = async flow => {
    const binding = random(), ticket = new URL(flow.launchUrl).hash.slice('#ticket='.length);
    const response = await fetch(host + '/auth/native/launch', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, binding }) });
    assert.equal(response.status, 200);
    return { ...flow, binding, ticket, cookie: cookie(response) };
  };
  const authorizeUrl = (provider = 'github', challenge = 'O5hwEy1OnF7HbhS44a6pULsqP_zVICdEGCiSZDRqiAs') =>
    issuer + '/auth/v1/authorize?provider=' + provider + '&redirect_to=' + encodeURIComponent(origin + '/auth/native/callback') +
    '&code_challenge=' + challenge + '&code_challenge_method=s256';
  const authorize = async (flow, provider = 'github') => {
    assert.equal((await browser('select', flow, { body: { provider } })).status, 200);
    const response = await native('/' + flow.flowId + '/authorize', { method: 'PUT', token: flow.pollToken, body: { url: authorizeUrl(provider) } });
    assert.equal(response.status, 200);
  };
  const callback = async (flow, code = 'synthetic-code') => {
    const response = await fetch(host + '/auth/native/callback?code=' + encodeURIComponent(code), { headers: { cookie: flow.cookie }, redirect: 'manual' });
    assert.equal(response.status, 303);
    return { response, receipt: new URL(response.headers.get('location'), origin).hash.slice('#receipt='.length) };
  };
  return { host, native, create, browser, launch, authorizeUrl, authorize, callback };
}

test('native login transfers only a repeatable authorization code until acknowledged', async t => {
  const f = await fixture(t), issued = await f.create();
  assert.match(issued.flowId, /^[A-Za-z0-9_-]{43}$/); assert.match(issued.pollToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.supabaseUrl, issuer); assert.equal(issued.publishableKey, config.publishableKey);
  assert.equal(new URL(issued.launchUrl).pathname, '/auth/native');
  assert.equal(new URL(issued.launchUrl).search, '');
  assert.ok(issued.expiresAt > Date.now()); assert.ok(issued.expiresAt <= Date.now() + 300_000);
  const poll = () => f.native('/' + issued.flowId, { token: issued.pollToken }).then(data);
  assert.deepEqual(await poll(), { status: 'waiting', state: issued.state, expiresAt: issued.expiresAt });
  assert.equal((await f.native('/' + issued.flowId + '/ack', { method: 'POST', token: issued.pollToken, body: {} })).status, 409);
  const flow = await f.launch(issued);
  assert.match(flow.cookie, /^__Host-vv-native=/);
  const replay = await f.browser('launch', flow, { body: { ticket: flow.ticket, binding: flow.binding } });
  assert.equal(replay.status, 401);
  await f.authorize(flow);
  assert.equal((await poll()).status, 'provider');
  const ready = await f.browser('browser', flow, { method: 'GET' }).then(data);
  assert.equal(ready.authorizeUrl, f.authorizeUrl());
  assert.ok(!JSON.stringify(ready).includes(flow.pollToken));
  const { response, receipt } = await f.callback(flow);
  assert.ok(receipt); assert.ok(!response.headers.get('location').includes('synthetic-code'));
  assert.equal((await poll()).status, 'provider');
  for (let i = 0; i < 2; i++) {
    const complete = await f.browser('complete', flow, { body: { receipt } });
    assert.equal(complete.status, 200);
    assert.ok(!JSON.stringify(await data(complete)).includes('synthetic-code'));
    assert.deepEqual(await poll(), { status: 'code', state: flow.state, expiresAt: flow.expiresAt, provider: 'github', code: 'synthetic-code' });
  }
  for (let i = 0; i < 2; i++) {
    const ack = await f.native('/' + flow.flowId + '/ack', { method: 'POST', token: flow.pollToken, body: {} });
    assert.equal(ack.status, 200); assert.equal((await data(ack)).status, 'completed');
  }
  assert.equal((await poll()).code, undefined);
  assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 401);
});

test('native credentials reject browser ambient authority and malformed JSON', async t => {
  const f = await fixture(t), flow = await f.create();
  for (const headers of [{ Origin: origin }, { Origin: 'null' }, { Cookie: '' }]) {
    assert.equal((await f.native('', { method: 'POST', body: { state: random() }, headers })).status, 403);
    assert.equal((await f.native('/' + flow.flowId, { token: flow.pollToken, headers })).status, 403);
  }
  assert.equal((await f.native('/' + flow.flowId)).status, 401);
  assert.equal((await f.native('/' + flow.flowId, { token: random() })).status, 401);
  assert.equal((await f.native('/' + random(), { token: flow.pollToken })).status, 404);
  for (const body of [{ state: 'short' }, { state: random() + '=' }, { state: random(), extra: 'secret' }, [], null]) {
    const response = await f.native('', { method: 'POST', body });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('secret'));
  }
  assert.equal((await f.native('', { method: 'POST', body: { state: random() }, headers: { 'Content-Type': 'application/json-bogus' } })).status, 415);
  for (const body of ['{', JSON.stringify({ state: random(), padding: 'a'.repeat(4096) })]) {
    const response = await fetch(f.host + '/auth/native/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, body === '{' ? 400 : 413);
  }
  assert.equal((await f.native('?state=secret', { method: 'POST', body: { state: random() } })).status, 400);
  assert.equal((await f.native('', { method: 'POST', body: { state: random(), pendingActionRef: 'opaque-action-id' } })).status, 201);
});

test('authorize accepts actual SDK output and rejects every changed trust boundary', async t => {
  const f = await fixture(t), flow = await f.launch(await f.create());
  const put = url => f.native('/' + flow.flowId + '/authorize', { method: 'PUT', token: flow.pollToken, body: { url } });
  assert.equal((await put(f.authorizeUrl())).status, 400);
  assert.equal((await f.browser('select', flow, { body: { provider: 'github' } })).status, 200);
  const valid = f.authorizeUrl();
  const mutations = [
    url => { url.hostname = 'other.example'; }, url => { url.pathname = '/auth/v1/token'; },
    url => { url.searchParams.set('redirect_to', origin + '/auth/callback'); },
    url => { url.searchParams.set('redirect_to', origin + '/auth/native/callback?flow=other'); },
    url => { url.searchParams.set('provider', 'google'); }, url => { url.searchParams.append('provider', 'github'); },
    url => { url.searchParams.set('skip_http_redirect', 'true'); }, url => { url.searchParams.set('code_challenge_method', 'plain'); },
    url => { url.searchParams.set('code_challenge', random() + '='); }, url => { url.searchParams.set('code_challenge', 'a'.repeat(43)); },
    url => { url.hash = 'secret'; }, url => { url.username = 'secret'; },
  ];
  for (const mutate of mutations) {
    const changed = new URL(valid); mutate(changed);
    assert.equal((await put(changed.href)).status, 400, changed.href);
  }
  assert.equal((await put(valid)).status, 200);
  assert.equal((await put(valid)).status, 200);
  assert.equal((await put(f.authorizeUrl('github', random()))).status, 409);
  assert.equal((await f.browser('select', flow, { body: { provider: 'google' } })).status, 409);
  const second = await f.launch(await f.create());
  await f.browser('select', second, { body: { provider: 'google' } });
  assert.equal((await f.native('/' + second.flowId + '/authorize', { method: 'PUT', token: second.pollToken,
    body: { url: f.authorizeUrl('google').replace('method=s256', 'method=S256') } })).status, 200);
});

test('browser mutations require their cookie, tab binding, and same origin', async t => {
  const f = await fixture(t), a = await f.launch(await f.create()), b = await f.launch(await f.create());
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }]) {
    assert.equal((await f.browser('select', a, { body: { provider: 'github' }, headers })).status, 403);
  }
  for (const headers of [{ cookie: b.cookie }, { 'X-Vonvon-Native-Tab': b.binding }, { cookie: 'vv-local-session=web-session' }]) {
    assert.equal((await f.browser('select', a, { body: { provider: 'github' }, headers })).status, 401);
  }
  await f.authorize(a); await f.authorize(b);
  const { receipt } = await f.callback(a);
  assert.equal((await f.browser('complete', b, { body: { receipt } })).status, 401);
  assert.equal((await f.browser('complete', a, { body: { receipt }, headers: { 'X-Vonvon-Native-Tab': b.binding } })).status, 401);
  assert.equal((await f.native('/' + a.flowId, { token: a.pollToken }).then(data)).status, 'provider');
  assert.equal((await f.browser('complete', a, { body: { receipt } })).status, 200);
});

test('a late cancelled tab cannot assign its callback code to a newer cookie flow', async t => {
  const f = await fixture(t), a = await f.launch(await f.create());
  await f.authorize(a);
  assert.equal((await f.native('/' + a.flowId, { method: 'DELETE', token: a.pollToken })).status, 200);
  const b = await f.launch(await f.create()); await f.authorize(b);
  const late = await f.callback({ ...a, cookie: b.cookie }, 'late-code-from-a');
  assert.ok(late.receipt);
  assert.equal((await f.browser('complete', { ...a, cookie: b.cookie }, { body: { receipt: late.receipt } })).status, 401);
  const result = await f.native('/' + b.flowId, { token: b.pollToken }).then(data);
  assert.equal(result.status, 'provider'); assert.equal(result.code, undefined);
  const current = await f.callback(b, 'current-code-from-b');
  assert.equal((await f.browser('complete', b, { body: { receipt: current.receipt } })).status, 200);
  assert.equal((await f.native('/' + b.flowId, { token: b.pollToken }).then(data)).code, 'current-code-from-b');
  assert.equal((await f.native('/' + a.flowId, { token: a.pollToken }).then(data)).status, 'cancelled');
});

test('cancel and expiry destroy tickets, codes, and receipts without revival', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }), flow = await f.launch(await f.create());
  await f.authorize(flow);
  const { receipt } = await f.callback(flow);
  await f.browser('complete', flow, { body: { receipt } });
  for (let i = 0; i < 2; i++) {
    const response = await f.native('/' + flow.flowId, { method: 'DELETE', token: flow.pollToken });
    assert.equal((await data(response)).status, 'cancelled');
  }
  assert.equal((await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data)).code, undefined);
  assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 401);
  assert.equal((await f.callback(flow)).response.headers.get('location'), '/auth/native/complete');
  const unlaunched = await f.create(), pending = await f.launch(await f.create()); await f.authorize(pending);
  const pendingReceipt = (await f.callback(pending)).receipt;
  const ready = await f.launch(await f.create()); await f.authorize(ready);
  await f.browser('complete', ready, { body: { receipt: (await f.callback(ready)).receipt } });
  now += 300_001;
  assert.equal((await f.native('/' + pending.flowId, { token: pending.pollToken }).then(data)).status, 'expired');
  assert.equal((await f.browser('complete', pending, { body: { receipt: pendingReceipt } })).status, 401);
  const expiredLaunch = await fetch(f.host + '/auth/native/launch', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(unlaunched.launchUrl).hash.slice(8), binding: random() }) });
  assert.equal(expiredLaunch.status, 410);
  assert.equal((await f.callback(pending)).response.headers.get('location'), '/auth/native/complete');
  const expiredReady = await f.native('/' + ready.flowId, { token: ready.pollToken }).then(data);
  assert.equal(expiredReady.status, 'expired'); assert.equal(expiredReady.code, undefined);
});

test('native anonymous admission is bounded and does not expose secret config', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) await f.create();
  assert.equal((await f.native('', { method: 'POST', body: { state: random() } })).status, 429);
  for (const publishableKey of [undefined, 'service_role-secret', 'eyJhbGciOiJIUzI1NiJ9.secret', 'sb_secret_hidden']) {
    const disabled = await fixture(t, { publishableKey });
    const response = await disabled.native('', { method: 'POST', body: { state: random() } });
    assert.equal(response.status, 503); assert.deepEqual(await data(response), { error: { code: 'native_login_unavailable' } });
  }
});

test('production HTTP routing retains native security headers and separate BFF session', async t => {
  const host = await listen(createRecipeWeb({ RECIPE_WEB_ORIGIN: origin, SUPABASE_URL: issuer,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey }), t);
  const created = await fetch(host + '/auth/native/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: random() }) });
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('referrer-policy'), 'no-referrer');
  const flow = await data(created), binding = random();
  const launch = await fetch(host + '/auth/native/launch', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(flow.launchUrl).hash.slice(8), binding }) });
  assert.match(launch.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Secure/);
  assert.deepEqual(await fetch(host + '/auth/session', { headers: { Cookie: cookie(launch) } }).then(data),
    { signedIn: false, providers: ['github', 'google', 'apple'] });
  const page = await fetch(host + '/auth/native/complete');
  const html = await page.text(); assert.equal(page.status, 200);
  assert.ok(!html.includes(flow.pollToken)); assert.ok(!html.includes(flow.state));
  assert.equal((await fetch(host + '/native.mjs')).status, 200);
});
