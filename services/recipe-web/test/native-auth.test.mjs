import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRecipeWeb } from '../server.mjs';
import { createNativeLogin } from '../native-auth.mjs';
import { WebError, createLogin } from '../auth.mjs';

const origin = 'https://community.example', issuer = 'https://supabase.example';
const identity={accountId:'11111111-1111-4111-8111-111111111111',displayName:'真实核验账号'};
const config = { verifyIdentity:async()=>identity, publicOrigin: origin, supabaseOrigin: issuer, publishableKey: 'sb_publishable_synthetic', providerNames: ['github', 'google', 'apple'] };
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
    const state = random(), response = await native('', { method: 'POST', headers: {'X-Vonvon-Login-Page': 'unified-v1'}, body: { state, confirmation:'identity-v1' } });
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
  const prove = async(flow,accessToken='synthetic-access-token',accountId=identity.accountId)=>native('/'+flow.flowId+'/identity',{method:'PUT',token:flow.pollToken,body:{accessToken,accountId}});
  const confirm = async(flow)=>{
    assert.equal((await prove(flow)).status,200);
    assert.equal((await browser('confirm',flow)).status,200);
  };
  const callback = async (flow, code = 'synthetic-code') => {
    const response = await fetch(host + '/auth/native/callback?code=' + encodeURIComponent(code), { headers: { cookie: flow.cookie }, redirect: 'manual' });
    assert.equal(response.status, 303);
    return { response, receipt: new URL(response.headers.get('location'), origin).hash.slice('#receipt='.length) };
  };
  return { server, host, native, create, browser, launch, authorizeUrl, authorize, callback, prove, confirm };
}

test('confirming the native identity signs in the same browser on refresh', async t => {
  const login = createLogin(config); t.after(() => login.stop());
  const f = await fixture(t, {confirmWebSession: login.confirmNative});
  const token = 'test.' + Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url') + '.test';
  const flow = await f.launch(await f.create()); await f.authorize(flow);
  const {receipt} = await f.callback(flow); await f.browser('complete',flow,{body:{receipt}});
  assert.equal((await f.prove(flow,token)).status,200);
  assert.equal(login.status({headers:{}}).signedIn,false);
  const response = await f.browser('confirm',flow);
  assert.equal(response.status,200);
  const cookie = response.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);
  const req = {headers:{cookie:cookie.split(';')[0]}};
  assert.equal(login.status(req).signedIn,true);
  assert.equal(await login.access(req),token);
  assert.equal((await f.browser('confirm',flow)).headers.get('set-cookie'),null);
});

test('native login transfers only a repeatable authorization code until acknowledged', async t => {
  const f = await fixture(t), issued = await f.create();
  assert.match(issued.flowId, /^[A-Za-z0-9_-]{43}$/); assert.match(issued.pollToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.confirmation,'identity-v1');
  assert.equal(issued.supabaseUrl, issuer); assert.equal(issued.publishableKey, config.publishableKey);
  assert.equal(new URL(issued.launchUrl).pathname, '/login');
  assert.equal(new URL(issued.launchUrl).search, '?mode=app');
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
  assert.equal((await f.native('/'+flow.flowId+'/ack',{method:'POST',token:flow.pollToken,body:{}})).status,409);
  await f.confirm(flow);
  for (let i = 0; i < 2; i++) {
    const ack = await f.native('/' + flow.flowId + '/ack', { method: 'POST', token: flow.pollToken, body: {} });
    assert.equal(ack.status, 200); assert.equal((await data(ack)).status, 'completed');
  }
  assert.equal((await poll()).code, undefined);
  assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 401);
});

for (const provider of ['github', 'google', 'apple']) test(provider + ' callback denial or error terminates only its flow and allows a fresh attempt', async t => {
  const f = await fixture(t);
  for (const [error, state] of [['access_denied', 'cancelled'], ['server_error', 'failed']]) {
    const flow = await f.launch(await f.create()); await f.authorize(flow, provider);
    const oldReceipt = (await f.callback(flow)).receipt;
    const callback = await fetch(f.host + '/auth/native/callback?' + new URLSearchParams({error, error_description: 'private-upstream-detail'}), {headers: {cookie: flow.cookie}, redirect: 'manual'});
    assert.equal(callback.status, 303);
    const destination = callback.headers.get('location');
    assert.equal(new URL(destination, origin).pathname, '/login');
    assert.equal(new URL(destination, origin).search, '?mode=app');
    assert.equal(destination.includes('private-upstream-detail'), false);
    const terminalReceipt = new URL(destination, origin).hash.slice('#receipt='.length);
    assert.ok(terminalReceipt);
    assert.equal((await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data)).status, 'provider');
    assert.equal((await f.browser('complete', flow, {body: {receipt: terminalReceipt}}).then(data)).status, state);
    assert.equal((await f.browser('complete', flow, {body: {receipt: terminalReceipt}}).then(data)).status, state);
    const polled = await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data);
    assert.equal(polled.status, state);
    assert.equal(polled.code, undefined); assert.equal(polled.identity, undefined);
    assert.equal((await f.browser('complete', flow, {body: {receipt: oldReceipt}})).status, 401);
    const fresh = await f.launch(await f.create()); await f.authorize(fresh, provider);
    const receipt = (await f.callback(fresh)).receipt;
    assert.ok(receipt);
    assert.equal((await f.browser('complete', fresh, {body: {receipt}})).status, 200);
    assert.equal((await f.native('/' + fresh.flowId, {token: fresh.pollToken}).then(data)).status, 'code');
  }
});

test('a denied older tab cannot cancel a newer cookie flow without its tab binding', async t => {
  const f = await fixture(t), older = await f.launch(await f.create()); await f.authorize(older);
  const newer = await f.launch(await f.create()); await f.authorize(newer, 'google');
  const response = await fetch(f.host + '/auth/native/callback?error=access_denied', {headers: {cookie: newer.cookie}, redirect: 'manual'});
  const receipt = new URL(response.headers.get('location'), origin).hash.slice('#receipt='.length);
  assert.ok(receipt);
  assert.equal((await f.browser('complete', {...older, cookie: newer.cookie}, {body: {receipt}})).status, 401);
  assert.equal((await f.native('/' + newer.flowId, {token: newer.pollToken}).then(data)).status, 'provider');
  const success = (await f.callback(newer)).receipt;
  assert.equal((await f.browser('complete', newer, {body: {receipt: success}})).status, 200);
  assert.equal((await f.native('/' + newer.flowId, {token: newer.pollToken}).then(data)).status, 'code');
});

test('callbacks without a usable receipt mark completion without changing or restarting the bound flow', async t => {
  const f = await fixture(t), flow = await f.launch(await f.create()); await f.authorize(flow);
  for (const suffix of ['', '#error=access_denied&error_description=private-fragment-detail', '?code=', '?code=one&code=two', '?unexpected=value']) {
    const response = await fetch(f.host + '/auth/native/callback' + suffix, {headers: {cookie: flow.cookie}, redirect: 'manual'});
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login?mode=app&complete=1#');
    const polled = await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data);
    assert.equal(polled.status, 'provider'); assert.equal(polled.code, undefined);
    const browser = await f.browser('browser', flow, {method: 'GET'}).then(data);
    assert.equal(browser.status, 'authorized'); assert.equal(browser.authorizeUrl, f.authorizeUrl());
  }
  const unbound = await fetch(f.host + '/auth/native/callback?code=unbound-code', {redirect: 'manual'});
  assert.equal(unbound.headers.get('location'), '/login?mode=app&complete=1#');
  const receipt = (await f.callback(flow)).receipt;
  assert.equal((await f.browser('complete', flow, {body: {receipt}})).status, 200);
  const late = await fetch(f.host + '/auth/native/callback', {headers: {cookie: flow.cookie}, redirect: 'manual'});
  assert.equal(late.headers.get('location'), '/login?mode=app&complete=1#');
  const ready = await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data);
  assert.equal(ready.status, 'code'); assert.equal(ready.code, 'synthetic-code');
});

test('older Apps retain the legacy launch contract without the unified page capability', async t => {
  const f = await fixture(t);
  const response = await f.native('', {method: 'POST', body: {state: random(), confirmation: 'identity-v1'}});
  assert.equal(response.status, 201);
  const issued = await response.json();
  const launch = new URL(issued.launchUrl);
  assert.equal(launch.origin, origin); assert.equal(launch.pathname, '/auth/native'); assert.equal(launch.search, '');
  assert.match(launch.hash, /^#ticket=[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.confirmation, 'identity-v1');
});

test('a late provider error cannot erase a completed receipt or confirmed identity', async t => {
  const f = await fixture(t), flow = await f.launch(await f.create()); await f.authorize(flow, 'apple');
  await f.browser('complete', flow, {body: {receipt: (await f.callback(flow)).receipt}});
  const error = () => fetch(f.host + '/auth/native/callback?error=access_denied', {headers: {cookie: flow.cookie}, redirect: 'manual'});
  await error();
  assert.equal((await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data)).status, 'code');
  await f.confirm(flow); await error();
  const polled = await f.native('/' + flow.flowId, {token: flow.pollToken}).then(data);
  assert.equal(polled.status, 'confirmed');
  assert.deepEqual(polled.identity, identity);
});

test('late native cancellation preserves completion and acknowledgement retries', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }), flow = await f.launch(await f.create());
  await f.authorize(flow);
  const { receipt } = await f.callback(flow);
  assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 200);
  await f.confirm(flow);
  const ack = () => f.native('/' + flow.flowId + '/ack', { method: 'POST', token: flow.pollToken, body: {} });
  assert.equal((await ack().then(data)).status, 'completed');
  for (let i = 0; i < 2; i++) {
    const cancelled = await f.native('/' + flow.flowId, { method: 'DELETE', token: flow.pollToken });
    assert.equal(cancelled.status, 200);
    assert.equal((await data(cancelled)).status, 'completed');
    const retried = await ack();
    assert.equal(retried.status, 200);
    assert.equal((await data(retried)).status, 'completed');
  }
  assert.equal((await f.browser('cancel', flow)).status,409);
  now += 300_001;
  const completed = await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data);
  assert.equal(completed.status, 'completed'); assert.equal(completed.code, undefined);
  assert.equal((await f.browser('cancel', flow)).status,409);
  assert.equal((await ack()).status, 200);
  assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 401);
  assert.equal((await f.callback(flow)).receipt, '');
});

test('browser cancel body crossing expiry preserves expired state', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now }), flow = await f.launch(await f.create());
  const received = once(f.server, 'request');
  let body;
  const pending = fetch(f.host + '/auth/native/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
      Cookie: flow.cookie, 'X-Vonvon-Native-Tab': flow.binding },
    body: new ReadableStream({ start(controller) { body = controller; controller.enqueue(Buffer.from('{')); } }),
    duplex: 'half',
  });
  await received;
  now = flow.expiresAt;
  body.enqueue(Buffer.from('}')); body.close();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await data(response)).status, 'expired');
  const polled = await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data);
  assert.equal(polled.status, 'expired'); assert.equal(polled.code, undefined);
});

test('native credentials reject browser ambient authority and malformed JSON', async t => {
  const f = await fixture(t), flow = await f.create();
  for (const headers of [{ Origin: origin }, { Origin: 'null' }, { Cookie: '' }]) {
    assert.equal((await f.native('', { method: 'POST', body: { confirmation:'identity-v1', state: random() }, headers })).status, 403);
    assert.equal((await f.native('/' + flow.flowId, { token: flow.pollToken, headers })).status, 403);
  }
  assert.equal((await f.native('/' + flow.flowId)).status, 401);
  assert.equal((await f.native('/' + flow.flowId, { token: random() })).status, 401);
  assert.equal((await f.native('/' + random(), { token: flow.pollToken })).status, 404);
  for (const body of [{ confirmation:'identity-v1',state: 'short' }, { confirmation:'identity-v1',state: random() + '=' }, { confirmation:'identity-v1',state: random(), extra: 'secret' }, [], null]) {
    const response = await f.native('', { method: 'POST', body });
    assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('secret'));
  }
  assert.equal((await f.native('', { method: 'POST', body: { confirmation:'identity-v1', state: random() }, headers: { 'Content-Type': 'application/json-bogus' } })).status, 415);
  for (const body of ['{', JSON.stringify({ confirmation:'identity-v1', state: random(), padding: 'a'.repeat(4096) })]) {
    const response = await fetch(f.host + '/auth/native/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, body === '{' ? 400 : 413);
  }
  assert.equal((await f.native('?state=secret', { method: 'POST', body: { confirmation:'identity-v1', state: random() } })).status, 400);
  assert.equal((await f.native('', { method: 'POST', body: { confirmation:'identity-v1', state: random(), pendingActionRef: 'opaque-action-id' } })).status, 201);
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

test('account selection permits only the exact supported provider prompt and keeps legacy clients compatible', async t => {
  const f = await fixture(t);
  for (const provider of ['github', 'google', 'apple']) {
    const flow = await f.launch(await f.create());
    await f.browser('select', flow, {body: {provider}});
    const put = url => f.native('/' + flow.flowId + '/authorize', {method: 'PUT', token: flow.pollToken, body: {url}});
    for (const prompt of ['consent', 'none', '', 'select_account&redirect_uri=https://evil.example']) {
      const url = new URL(f.authorizeUrl(provider)); url.searchParams.set('prompt', prompt);
      assert.equal((await put(url.href)).status, 400);
    }
    const url = new URL(f.authorizeUrl(provider)); url.searchParams.set('prompt', 'select_account');
    const duplicate = new URL(url); duplicate.searchParams.append('prompt', 'select_account');
    assert.equal((await put(duplicate.href)).status, 400);
    assert.equal((await put(url.href)).status, provider === 'apple' ? 400 : 200);
    if (provider === 'apple') assert.equal((await put(f.authorizeUrl(provider))).status, 200);
  }
  const legacy = await f.launch(await f.create());
  await f.authorize(legacy);
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
  const current = await f.callback(b, 'current-code-from-b');
  const lateTab = { ...a, cookie: b.cookie }, late = await f.callback(lateTab, 'late-code-from-a');
  assert.ok(late.receipt);
  assert.equal((await f.browser('complete', lateTab, { body: { receipt: late.receipt } })).status, 401);
  const result = await f.native('/' + b.flowId, { token: b.pollToken }).then(data);
  assert.equal(result.status, 'provider'); assert.equal(result.code, undefined);
  assert.ok(current.receipt);
  assert.equal((await f.browser('complete', b, { body: { receipt: current.receipt } })).status, 200);
  assert.equal((await f.browser('complete', b, { body: { receipt: current.receipt } })).status, 200);
  assert.equal((await f.native('/' + b.flowId, { token: b.pollToken }).then(data)).code, 'current-code-from-b');
  assert.equal((await f.native('/' + a.flowId, { token: a.pollToken }).then(data)).status, 'cancelled');
});

test('completion rejects corrupted or oversized receipts and still accepts the original at the code size limit', async t => {
  const f = await fixture(t), flow = await f.launch(await f.create());
  await f.authorize(flow);
  const code = 'é'.repeat(1024);
  assert.equal((await f.callback(flow, code + '!')).receipt, '');
  const { receipt } = await f.callback(flow, code);
  assert.ok(receipt);
  const complete = value => f.browser('complete', flow, { body: { receipt: value } });
  for (const value of [null, '', receipt + '=', 'a'.repeat(3000)]) assert.equal((await complete(value)).status, 400);
  assert.equal((await complete('a'.repeat(4096))).status, 413);
  const changed = Buffer.from(receipt, 'base64url');
  changed[changed.length - 1] ^= 1;
  assert.equal((await complete(changed.toString('base64url'))).status, 401);
  assert.equal((await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data)).status, 'provider');
  assert.equal((await complete(receipt)).status, 200);
  assert.equal((await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data)).code, code);
});

test('the first receipt remains usable across callback redelivery, and only its confirmation is repeatable', async t => {
  const f = await fixture(t), flow = await f.launch(await f.create());
  await f.authorize(flow);
  const receipts = [];
  for (let i = 0; i < 8; i++) {
    const callback = await f.callback(flow, 'synthetic-code-' + i);
    assert.ok(callback.receipt);
    receipts.push(callback.receipt);
  }
  const receipt = receipts[0];
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 200);
    const ready = await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data);
    assert.equal(ready.status, 'code'); assert.equal(ready.code, 'synthetic-code-0');
  }
  for (const orphan of receipts.slice(1)) {
    assert.equal((await f.browser('complete', flow, { body: { receipt: orphan } })).status, 401);
  }
  assert.equal((await f.callback(flow)).receipt, '');
});

test('cancelled and expired native flows reject old callbacks and cannot revive', async t => {
  let now = Date.now();
  const f = await fixture(t, { now: () => now });
  for (const terminal of ['cancelled', 'expired']) {
    const flow = await f.launch(await f.create()); await f.authorize(flow);
    const { receipt } = await f.callback(flow);
    if (terminal === 'cancelled') {
      assert.equal((await f.native('/' + flow.flowId, { method: 'DELETE', token: flow.pollToken }).then(data)).status, terminal);
    } else now += 300_001;
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.native('/' + flow.flowId, { method: 'DELETE', token: flow.pollToken }).then(data)).status, terminal);
      assert.equal((await f.browser('cancel', flow).then(data)).status, terminal);
      assert.equal((await f.browser('complete', flow, { body: { receipt } })).status, 401);
      assert.equal((await f.callback(flow)).receipt, '');
      const ack = await f.native('/' + flow.flowId + '/ack', { method: 'POST', token: flow.pollToken, body: {} });
      assert.equal(ack.status, terminal === 'expired' ? 410 : 409);
      const authorize = await f.native('/' + flow.flowId + '/authorize', { method: 'PUT', token: flow.pollToken, body: { url: f.authorizeUrl() } });
      assert.equal(authorize.status, terminal === 'expired' ? 410 : 409);
      assert.equal((await f.browser('select', flow, { body: { provider: 'github' } })).status, terminal === 'expired' ? 410 : 409);
      const result = await f.native('/' + flow.flowId, { token: flow.pollToken }).then(data);
      assert.equal(result.status, terminal); assert.equal(result.code, undefined);
    }
  }
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
  assert.equal((await f.callback(flow)).response.headers.get('location'), '/login?mode=app&complete=1#');
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
  assert.equal((await f.callback(pending)).response.headers.get('location'), '/login?mode=app&complete=1#');
  const expiredReady = await f.native('/' + ready.flowId, { token: ready.pollToken }).then(data);
  assert.equal(expiredReady.status, 'expired'); assert.equal(expiredReady.code, undefined);
});

test('native anonymous admission is bounded and does not expose secret config', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 32; i++) await f.create();
  assert.equal((await f.native('', { method: 'POST', body: { confirmation:'identity-v1', state: random() } })).status, 429);
  for (const publishableKey of [undefined, 'service_role-secret', 'eyJhbGciOiJIUzI1NiJ9.secret', 'sb_secret_hidden']) {
    const disabled = await fixture(t, { publishableKey });
    const response = await disabled.native('', { method: 'POST', body: { confirmation:'identity-v1', state: random() } });
    assert.equal(response.status, 503); assert.deepEqual(await data(response), { error: { code: 'native_login_unavailable' } });
  }
});

test('production HTTP routing retains native security headers and separate BFF session', async t => {
  const host = await listen(createRecipeWeb({ RECIPE_WEB_ORIGIN: origin, SUPABASE_URL: issuer,
    SUPABASE_PUBLISHABLE_KEY: config.publishableKey }), t);
  const created = await fetch(host + '/auth/native/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation:'identity-v1', state: random() }) });
  assert.equal(created.status, 201); assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.headers.get('referrer-policy'), 'no-referrer');
  const flow = await data(created), binding = random();
  const launch = await fetch(host + '/auth/native/launch', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(flow.launchUrl).hash.slice(8), binding }) });
  assert.match(launch.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Secure/);
  assert.deepEqual(await fetch(host + '/auth/session', { headers: { Cookie: cookie(launch) } }).then(data),
    { signedIn: false, providers: ['github', 'google'] });
  const page = await fetch(host + '/auth/native/complete');
  const html = await page.text(); assert.equal(page.status, 200);
  assert.ok(!html.includes(flow.pollToken)); assert.ok(!html.includes(flow.state));
  assert.equal((await fetch(host + '/native.mjs')).status, 200);
});

test('paired identity capability is required and missing verifier cannot fall back to legacy acceptance',async t=>{
  const f=await fixture(t);
  for(const confirmation of [undefined,'legacy','identity-v2']){
    const response=await f.native('',{method:'POST',body:{state:random(),...(confirmation&&{confirmation})}});
    assert.equal(response.status,503);assert.deepEqual(await data(response),{error:{code:'native_login_upgrade_required'}});
  }
  const unavailable=await fixture(t,{verifyIdentity:undefined});
  assert.equal((await unavailable.native('',{method:'POST',body:{state:random(),confirmation:'identity-v1'}})).status,503);
});

test('only server-verified identity is shown; explicit browser confirmation gates acknowledgement',async t=>{
  let checks=0;
  const f=await fixture(t,{verifyIdentity:async(accessToken,signal)=>{checks++;assert.equal(accessToken,'secret-jwt-proof');assert.equal(signal.aborted,false);return {...identity,email:'never@example.invalid',accessToken:'secret-jwt-proof',avatarDataUrl:'https://untrusted.invalid/avatar'};}});
  const flow=await f.launch(await f.create());await f.authorize(flow);const {receipt}=await f.callback(flow);await f.browser('complete',flow,{body:{receipt}});
  const ack=()=>f.native('/'+flow.flowId+'/ack',{method:'POST',token:flow.pollToken,body:{}});
  assert.equal((await ack()).status,409);assert.equal((await f.browser('confirm',flow)).status,409);
  const verified=await f.prove(flow,'secret-jwt-proof');assert.equal(verified.status,200);const result=await data(verified);
  assert.equal(result.status,'confirming');assert.deepEqual(result.identity,identity);assert.equal(result.code,undefined);
  assert.ok(!JSON.stringify(result).includes('secret-jwt'));assert.ok(!JSON.stringify(result).includes('never@'));
  const browser=await f.browser('browser',flow,{method:'GET'}).then(data);assert.deepEqual(browser.identity,identity);assert.equal(browser.status,'confirming');assert.equal(browser.code,undefined);
  assert.equal((await f.prove(flow,'secret-jwt-proof')).status,200);assert.equal(checks,1);
  assert.equal((await f.prove(flow,'different-proof')).status,409);assert.equal((await ack()).status,409);
  assert.equal((await f.browser('confirm',flow,{headers:{Origin:'null'}})).status,403);
  assert.equal((await f.browser('confirm',flow,{headers:{'X-Vonvon-Native-Tab':random()}})).status,401);
  assert.equal((await f.browser('confirm',flow)).status,200);assert.equal((await f.browser('confirm',flow)).status,200);
  assert.equal((await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data)).status,'confirmed');
  assert.equal((await f.browser('cancel',flow)).status,409);assert.equal((await f.browser('switch',flow)).status,409);
  assert.equal((await ack()).status,200);const completed=await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data);assert.equal(completed.status,'completed');assert.equal(completed.identity,undefined);
});

test('identity mismatch never advances; switching destroys proof and receipt and requires a new flow',async t=>{
  const f=await fixture(t),flow=await f.launch(await f.create());await f.authorize(flow);const {receipt}=await f.callback(flow);await f.browser('complete',flow,{body:{receipt}});
  assert.equal((await f.prove(flow,'proof','22222222-2222-4222-8222-222222222222')).status,403);
  assert.equal((await f.prove(flow,'a'.repeat(16385))).status,400);
  assert.equal((await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data)).status,'code');
  assert.equal((await f.prove(flow)).status,200);
  assert.equal((await f.browser('switch',flow)).status,200);
  const polled=await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data);assert.equal(polled.status,'switching');assert.equal(polled.identity,undefined);assert.equal(polled.code,undefined);
  assert.equal((await f.prove(flow)).status,409);assert.equal((await f.browser('confirm',flow)).status,409);assert.equal((await f.browser('complete',flow,{body:{receipt}})).status,401);
  assert.equal((await f.callback(flow)).receipt,'');
  const next=await f.launch(await f.create());await f.authorize(next);assert.equal((await f.browser('complete',next,{body:{receipt}})).status,401);
});

for(const action of ['cancel','expire','switch'])test('late identity verification cannot revive a flow after '+action,async t=>{
  let release,entered,now=Date.now();const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{now:()=>now,verifyIdentity:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  const pending=f.prove(flow);await started;
  assert.equal((await f.prove(flow,'different-proof')).status,409,'different concurrent proof cannot replace the first proof');
  if(action==='expire')now=flow.expiresAt;
  else if(action==='cancel')await f.native('/'+flow.flowId,{method:'DELETE',token:flow.pollToken});
  else {
    // A browser switch is unavailable before identity exists; cancel the ready flow to start another account selection.
    assert.equal((await f.browser('switch',flow)).status,409);
    await f.browser('cancel',flow);
  }
  release(identity);assert.equal((await pending).status,action==='expire'?410:409);
  const polled=await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data);assert.equal(polled.status,action==='expire'?'expired':'cancelled');assert.equal(polled.identity,undefined);assert.equal(polled.code,undefined);
});

test('App cancellation remains allowed after browser confirmation but before acknowledgement',async t=>{
  const f=await fixture(t),flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});await f.confirm(flow);
  assert.equal((await f.native('/'+flow.flowId,{method:'DELETE',token:flow.pollToken}).then(data)).status,'cancelled');
  assert.equal((await f.native('/'+flow.flowId+'/ack',{method:'POST',token:flow.pollToken,body:{}})).status,409);
});

test('abort-aware identity verification still reports cancellation rather than a verifier outage',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{verifyIdentity:async(_token,signal)=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});entered();})});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  const pending=f.prove(flow);await started;await f.native('/'+flow.flowId,{method:'DELETE',token:flow.pollToken});
  assert.equal((await pending).status,409);assert.equal((await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data)).status,'cancelled');
});

test('same pending identity proof coalesces verification and survives loss of the first response',async t=>{
  let release,entered,checks=0;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{verifyIdentity:async()=>{checks++;entered();return new Promise(resolve=>{release=resolve;});}});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  const first=f.prove(flow);await started;
  const retry=f.prove(flow);assert.equal((await f.prove(flow,'different-proof')).status,409);
  assert.equal((await f.prove(flow,'synthetic-access-token','22222222-2222-4222-8222-222222222222')).status,409);
  release(identity);
  const [a,b]=await Promise.all([first,retry]);assert.equal(a.status,200);assert.equal(b.status,200);
  // Treat the first response body as lost; a later retry must still recover the same proof.
  assert.equal((await b.json()).status,'confirming');assert.equal((await f.prove(flow)).status,200);assert.equal(checks,1);
});
for(const failure of [401,403])test('verifier '+failure+' is fatal and clears every credential-bearing view',async t=>{
  let checks=0;const f=await fixture(t,{verifyIdentity:async()=>{checks++;throw new WebError(failure,'secret verifier diagnostic');}});
  const flow=await f.launch(await f.create());await f.authorize(flow);const receipt=(await f.callback(flow)).receipt;await f.browser('complete',flow,{body:{receipt}});
  const rejected=await f.prove(flow);assert.equal(rejected.status,failure);assert.deepEqual(await rejected.json(),{error:{code:'identity_rejected'}});
  const poll=await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data);assert.equal(poll.status,'failed');assert.equal(poll.code,undefined);assert.equal(poll.identity,undefined);
  const browser=await f.browser('browser',flow,{method:'GET'}).then(data);assert.equal(browser.status,'failed');assert.equal(browser.identity,undefined);
  assert.equal((await f.prove(flow)).status,409);assert.equal(checks,1);
  assert.equal((await f.native('/'+flow.flowId+'/ack',{method:'POST',token:flow.pollToken,body:{}})).status,409);
  assert.equal((await f.browser('complete',flow,{body:{receipt}})).status,401);
});
test('verifier outages remain retryable and a later same-proof retry can confirm',async t=>{
  let checks=0;const f=await fixture(t,{verifyIdentity:async()=>{if(++checks===1)throw new WebError(503,'outage');return identity;}});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  assert.equal((await f.prove(flow)).status,503);assert.equal((await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data)).status,'code');
  assert.equal((await f.prove(flow)).status,200);assert.equal(checks,2);assert.equal((await f.browser('confirm',flow)).status,200);
  assert.equal((await f.native('/'+flow.flowId+'/ack',{method:'POST',token:flow.pollToken,body:{}})).status,200);
});
test('a disconnected identity response can retry while verification is pending without a second verifier call',async t=>{
  let release,entered,checks=0;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{verifyIdentity:async()=>{checks++;entered();return new Promise(resolve=>{release=resolve;});}});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  const abort=new AbortController();
  const lost=fetch(f.host+'/auth/native/flows/'+flow.flowId+'/identity',{method:'PUT',signal:abort.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+flow.pollToken},body:JSON.stringify({accessToken:'synthetic-access-token',accountId:identity.accountId})}).catch(error=>error);
  await started;abort.abort();assert.equal((await lost).name,'AbortError');
  const retry=f.prove(flow);await new Promise(setImmediate);release(identity);
  assert.equal((await retry).status,200);assert.equal(checks,1);
});
test('coalesced pending proof callers both fail closed after App cancellation',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{verifyIdentity:async(_token,signal)=>new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});entered();})});
  const flow=await f.launch(await f.create());await f.authorize(flow);await f.browser('complete',flow,{body:{receipt:(await f.callback(flow)).receipt}});
  const first=f.prove(flow);await started;const retry=f.prove(flow);
  await new Promise(setImmediate);await f.native('/'+flow.flowId,{method:'DELETE',token:flow.pollToken});
  for(const response of await Promise.all([first,retry]))assert.equal(response.status,409);
  assert.equal((await f.native('/'+flow.flowId,{token:flow.pollToken}).then(data)).status,'cancelled');
});
