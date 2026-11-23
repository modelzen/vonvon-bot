import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { createLogin } from '../auth.mjs';
import { createNativeLogin } from '../native-auth.mjs';

const publicOrigin = 'https://community.example';
const accountOrigin = 'https://account.example';
const supabaseOrigin = 'https://issuer.example';
const user = {id: '11111111-1111-4111-8111-111111111111'};
const config = {publicOrigin, accountOrigin, supabaseOrigin, publishableKey: 'sb_publishable_synthetic',
  providerNames: ['github', 'google']};
const random = () => randomBytes(32).toString('base64url');
const cookie = value => value.split(';', 1)[0];
const response = () => ({
  headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
  end(data) { this.data = data ? JSON.parse(data) : undefined; },
});

function storage() {
  const rows = new Map();
  const key = (kind, id) => kind + ':' + id;
  return {
    rows,
    get(kind, id) {
      const row = rows.get(key(kind, id));
      return row && JSON.parse(row.value);
    },
    set(kind, id, value, deadline) {
      rows.set(key(kind, id), {kind, value: JSON.stringify(value), deadline});
    },
    delete(kind, id) { rows.delete(key(kind, id)); },
    count(kind) { return [...rows.values()].filter(row => row.kind === kind).length; },
    prune(kind, now) {
      for (const [id, row] of rows) if (row.kind === kind && row.deadline !== null && row.deadline <= now) rows.delete(id);
    },
  };
}

test('Web PKCE, established session and logout survive coordinator recreation without replaying the code', async t => {
  const authStorage = storage();
  const makeLogin = () => createLogin({...config, authStorage});
  let expectedChallenge, exchanges = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(url, /grant_type=pkce$/);
    const {auth_code, code_verifier} = JSON.parse(init.body);
    assert.equal(auth_code, 'synthetic');
    assert.equal(createHash('sha256').update(code_verifier).digest('base64url'), expectedChallenge);
    exchanges++;
    return Response.json({access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600, user});
  });

  let login = makeLogin();
  const start = response();
  await login.start({headers: {}}, start, new URLSearchParams({provider: 'github', returnTo: '/account'}));
  expectedChallenge = new URL(start.headers.Location).searchParams.get('code_challenge');
  const callbackRequest = {headers: {cookie: cookie(start.headers['Set-Cookie'])}};
  const callbackUrl = new URL('/auth/callback?code=synthetic', publicOrigin);
  login.stop();

  login = makeLogin();
  const complete = response();
  await login.callback(callbackRequest, complete, callbackUrl);
  assert.equal(complete.headers.Location, accountOrigin + '/account#');
  const request = {headers: {cookie: cookie(complete.headers['Set-Cookie'][1])}};
  assert.equal(await login.access(request), 'synthetic-access');
  login.stop();

  login = makeLogin();
  assert.equal(await login.access(request), 'synthetic-access');
  const replay = response();
  await login.callback(callbackRequest, replay, callbackUrl);
  assert.match(replay.headers.Location, /auth=failed/);
  assert.equal(exchanges, 1);
  login.logout(request, response());
  login.stop();
  assert.equal(makeLogin().status(request).signedIn, false);
});

test('App login persists the browser binding, sealed receipt, identity confirmation and ACK across recreation', async () => {
  const authStorage = storage();
  const profile = {accountId: user.id, displayName: 'Example User', revision: 0};
  const access = 'header.' + Buffer.from(JSON.stringify({exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url') + '.signature';
  let now = Date.now();
  const issuer = {...config, authStorage, now: () => now, verifyIdentity: async token => {
    assert.equal(token, access);
    return profile;
  }};
  async function call(method, path, body, headers = {}) {
    const login = createLogin(issuer);
    const native = createNativeLogin({...issuer, confirmWebSession: login.confirmNative});
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = {...(body === undefined ? {} : {'content-type': 'application/json'}), ...headers};
    const res = response();
    try {
      assert.equal(await native.handle(req, res, new URL(path, publicOrigin), headers.origin === accountOrigin), true);
      return res;
    } finally {
      native.stop();
      login.stop();
    }
  }

  const start = (await call('POST', '/auth/native/flows', {state: random(), confirmation: 'identity-v1'})).data;
  const pollPath = '/auth/native/flows/' + start.flowId;
  const daemon = {authorization: 'Bearer ' + start.pollToken};
  const ticket = new URLSearchParams(new URL(start.launchUrl).hash.slice(1)).get('ticket');
  const binding = random();
  const client = {origin: accountOrigin, 'x-vonvon-native-tab': binding};
  const launch = await call('POST', '/auth/native/launch', {ticket, binding}, client);
  client.cookie = cookie(launch.headers['Set-Cookie']);
  await assert.rejects(call('POST', '/auth/native/launch', {ticket, binding}, client), {status: 401});

  await call('POST', '/auth/native/select', {provider: 'github'}, client);
  const provider = new URL('/auth/v1/authorize', supabaseOrigin);
  provider.search = new URLSearchParams({provider: 'github', redirect_to: publicOrigin + '/auth/native/callback',
    code_challenge: random(), code_challenge_method: 's256'});
  await call('PUT', pollPath + '/authorize', {url: provider.href}, daemon);
  const callback = await call('GET', '/auth/native/callback?code=synthetic-code', undefined, {cookie: client.cookie});
  const receipt = new URLSearchParams(new URL(callback.headers.Location).hash.slice(1)).get('receipt');
  await call('POST', '/auth/native/complete', {receipt}, client);
  assert.equal((await call('GET', pollPath, undefined, daemon)).data.code, 'synthetic-code');
  await call('PUT', pollPath + '/identity', {accessToken: access, accountId: profile.accountId}, daemon);
  const confirm = await call('POST', '/auth/native/confirm', {}, client);
  const webCookie = cookie(confirm.headers['Set-Cookie']);
  assert.equal(createLogin(issuer).status({headers: {cookie: webCookie}}).signedIn, true);
  await call('POST', pollPath + '/ack', {}, daemon);
  assert.equal((await call('GET', '/auth/native/browser', undefined, client)).data.status, 'acknowledged');
  assert.equal(authStorage.count('native-secrets'), 0);
  assert.equal((await call('GET', pollPath, undefined, daemon)).data.code, undefined);
  now = start.expiresAt + 5 * 60_000;
  await call('POST', '/auth/native/flows', {state: random(), confirmation: 'identity-v1'});
  await assert.rejects(call('GET', pollPath, undefined, daemon), {status: 404});
});
