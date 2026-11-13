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
