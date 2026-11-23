import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createReleaseCodeAuth } from '../release-code-oauth.mjs';

const codeScope = 'release-code:read offline_access';
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';

function testStore() {
  const rows = new Map(),
    bindings = new Map();
  class Adapter {
    constructor(name) {
      this.name = name;
    }
    upsert(id, payload) {
      rows.set(this.name + id, structuredClone(payload));
    }
    find(id) {
      return structuredClone(rows.get(this.name + id));
    }
    by(field, value) {
      return [...rows].find(([k, v]) => k.startsWith(this.name) && v[field] === value)?.[1];
    }
    findByUserCode(value) {
      return this.by('userCode', value);
    }
    findByUid(value) {
      return this.by('uid', value);
    }
    destroy(id) {
      rows.delete(this.name + id);
    }
    consume(id) {
      rows.get(this.name + id).consumed = Math.floor(Date.now() / 1000);
    }
    revokeByGrantId(id) {
      for (const [k, v] of rows) if (v.grantId === id) rows.delete(k);
    }
  }
  return {
    Adapter,
    bind: (id, account) => bindings.set(id, account),
    validGrant: (id, account) => bindings.get(id) === account,
    logout: () => bindings.clear(),
    close() {}
  };
}

async function setup(t) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port,
    issuer = origin + '/release-code/oauth',
    resource = origin + '/mcp';
  const store = testStore(),
    accountId = randomUUID(),
    sessionId = randomUUID(),
    webSession = 'test-user-browser-session';
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const config = {
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'fixture', use: 'sig' }] },
    cookies: ['client-machine-integration-test-cookie-signing-key']
  };
  const login = { status: () => ({ signedIn: true, displaySession: webSession }) };
  const app = createReleaseCodeAuth(
    { env: { RELEASE_CODE_ISSUER: issuer, RELEASE_CODE_RESOURCE: resource }, publicOrigin: origin, login },
    { config, store, account: async () => ({ accountId, sessionId, webSession }) }
  );
  server.on('request', async (req, res) => {
    try {
      if (!(await app.handle(req, res, new URL(req.url, origin)))) {
        res.statusCode = 404;
        res.end();
      }
    } catch (err) {
      res.statusCode = err.status || 500;
      res.end(String(err));
    }
  });
  t.after(async () => {
    app.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const cookies = new Map();
  async function request(url, form) {
    const resp = await fetch(url, {
      redirect: 'manual',
      headers: { origin, cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') },
      method: form ? 'POST' : 'GET',
      ...(form ? { body: new URLSearchParams(form) } : {})
    });
    for (const h of resp.headers.getSetCookie()) {
      const [name, ...value] = h.split(';')[0].split('=');
      cookies.set(name, value.join('='));
    }
    return resp;
  }
  async function accept(location) {
    const confirm = await request(location);
    assert.equal(confirm.status, 200, await confirm.text());
    const accepted = await request(location, { session: webSession, action: 'accept' });
    assert.equal(accepted.status, 303, await accepted.text());
    return request(accepted.headers.get('location'));
  }
  return { origin, issuer, resource, accountId, request, accept, store };
}

test('device approval, account-specific JWT, rotation and logout', async (t) => {
  const { origin, issuer, resource, accountId, request, accept, store } = await setup(t);
  const metadata = await (
    await request(origin + '/.well-known/oauth-authorization-server/release-code/oauth')
  ).json();
  const params = { client_id: 'vonvon-feedback-bot', resource, scope: codeScope };
  assert.equal(metadata.issuer, issuer);
  assert.equal(metadata.device_authorization_endpoint, issuer + '/device/auth');
  const device = await (await request(metadata.device_authorization_endpoint, params)).json();
  assert.ok(device.user_code, JSON.stringify(device));
  assert.ok(device.verification_uri_complete);
  const xsrf = (html) => html.match(/name="xsrf" value="([^"]+)"/)?.[1];
  const begin = await (await request(device.verification_uri_complete)).text();
  const form = await (
    await request(device.verification_uri, { user_code: device.user_code, xsrf: xsrf(begin) })
  ).text();
  const started = await request(device.verification_uri, {
    user_code: device.user_code,
    xsrf: xsrf(form),
    confirm: 'yes'
  });
  assert.equal(started.status, 303, await started.text());
  const complete = await accept(started.headers.get('location'));
  assert.equal(complete.status, 200, await complete.text());
  const token = await (
    await request(metadata.token_endpoint, { ...params, grant_type: deviceGrant, device_code: device.device_code })
  ).json();
  assert.ok(token.access_token, JSON.stringify(token));
  assert.ok(token.refresh_token);
  const key = (await (await request(metadata.jwks_uri)).json()).keys[0];
  assert.equal(key.d, undefined);
  const [h, p, s] = token.access_token.split('.');
  assert.ok(
    verify(
      'sha256',
      Buffer.from(h + '.' + p),
      { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url')
    )
  );
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(
    [claims.sub, claims.aud, claims.iss, claims.scope, claims.exp - claims.iat],
    [accountId, resource, issuer, 'release-code:read', 600]
  );
  const next = await (
    await request(metadata.token_endpoint, {
      client_id: params.client_id,
      resource,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    })
  ).json();
  assert.ok(next.access_token);
  assert.notEqual(next.refresh_token, token.refresh_token);
  store.logout();
  const blocked = await (
    await request(metadata.token_endpoint, {
      client_id: params.client_id,
      resource,
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token
    })
  ).json();
  assert.equal(blocked.error, 'invalid_grant');
});

test('native PKCE binds the redirect, verifier and exact resource', async (t) => {
  const { origin, resource, request, accept } = await setup(t);
  const m = await (await request(origin + '/.well-known/oauth-authorization-server/release-code/oauth')).json();
  const verifier = 'this-is-an-isolated-synthetic-pkce-verifier-for-test';
  const client_id = 'vonvon-feedback-bot',
    redirect_uri = 'http://127.0.0.1:42000/vonvon/oauth/callback';
  const params = {
    client_id,
    redirect_uri,
    resource,
    scope: codeScope,
    prompt: 'consent',
    response_type: 'code',
    state: 'fixture',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url')
  };
  const response = await request(m.authorization_endpoint + '?' + new URLSearchParams(params));
  assert.equal(response.status, 303, await response.text());
  const done = await accept(response.headers.get('location'));
  const callback = new URL(done.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirect_uri);
  const token = await (
    await request(m.token_endpoint, {
      client_id,
      redirect_uri,
      resource,
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code'),
      code_verifier: verifier
    })
  ).json();
  assert.ok(token.access_token, JSON.stringify(token));
  assert.ok(token.refresh_token);
  const rejected = await (
    await request(m.token_endpoint, {
      client_id,
      resource: 'https://wrong.example/mcp',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    })
  ).json();
  assert.ok(rejected.error);
});

test('browser logout survives an unavailable OAuth database; queued revocations persist across restart', async (t) => {
  const { logoutJournal } = await import('../release-code-store.mjs');
  const { mkdtemp, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-code-logout-test-'));
  const id = 'z'.repeat(43);
  const failed = logoutJournal(dir, async () => {
    throw new Error('database unavailable');
  });
  failed.record(id);
  await failed.flush();
  assert.equal(failed.contains(id), true);
  assert.deepEqual(await readdir(dir), [id]);
  failed.close();
  const recovered = [];
  const restarted = logoutJournal(dir, async (value) => {
    recovered.push(value);
  });
  t.after(() => restarted.close());
  await restarted.flush();
  assert.equal(restarted.contains(id), false);
  assert.deepEqual(recovered, [id]);
  assert.deepEqual(await readdir(dir), []);
});

test('logout retries a missing marker and a failed revocation without blocking another user', async (t) => {
  const { logoutJournal } = await import('../release-code-store.mjs');
  const { mkdtemp, readdir, rename } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'vonvon-logout-retry-'));
  const dir = join(root, 'journal');
  const [offline, next, third] = ['a', 'b', 'c'].map((s) => s.repeat(43));
  const removed = [];
  const journal = logoutJournal(dir, async (id) => {
    if (id === offline) throw new Error('cannot revoke this grant yet');
    removed.push(id);
  });
  t.after(() => journal.close());
  await rename(dir, join(root, 'unavailable'));
  journal.record(offline);
  journal.record(next);
  await journal.flush();
  assert.equal(journal.contains(offline), true);
  assert.equal(journal.contains(next), false);
  assert.deepEqual(removed, [next]);

  await rename(join(root, 'unavailable'), dir);
  journal.record(third);
  await journal.flush();
  assert.deepEqual(removed, [next, third]);
  assert.deepEqual(await readdir(dir), [offline]);
  journal.close();

  const restarted = logoutJournal(dir, async (id) => removed.push(id));
  t.after(() => restarted.close());
  await restarted.flush();
  assert.deepEqual(removed, [next, third, offline]);
  assert.equal(restarted.contains(offline), false);
  assert.deepEqual(await readdir(dir), []);
});

test('existing website clears its login cookie and session during an OAuth PostgreSQL outage', async (t) => {
  const { createRecipeWeb } = await import('../server.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'vonvon-code-logout-http-'));
  const keys = join(dir, 'keys.json');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await writeFile(
    keys,
    JSON.stringify({
      jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'fixture' }] },
      cookies: ['k'.repeat(44)]
    }),
    { mode: 0o600 }
  );
  const upstream = createServer((_, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const publicOrigin = 'http://localhost:49149';
  const web = createRecipeWeb({
    RECIPE_WEB_ORIGIN: publicOrigin,
    SUPABASE_URL: 'http://127.0.0.1:' + upstream.address().port,
    SUPABASE_PUBLISHABLE_KEY: 'test',
    RELEASE_CODE_ISSUER: publicOrigin + '/release-code/oauth',
    RELEASE_CODE_RESOURCE: 'http://localhost:49150/mcp',
    RELEASE_CODE_AUTH_KEYS_FILE: keys,
    RELEASE_CODE_AUTH_LOGOUT_DIR: join(dir, 'logout'),
    RELEASE_CODE_AUTH_DATABASE_URL: 'postgresql://127.0.0.1:1/unavailable'
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => web.close(resolve)));
  const origin = 'http://127.0.0.1:' + web.address().port;
  const begin = await fetch(origin + '/auth/start', {
    method: 'POST',
    headers: { origin: publicOrigin },
    body: new URLSearchParams({ provider: 'github' }),
    redirect: 'manual'
  });
  const cookie = (r) =>
    r.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
  const finish = await fetch(origin + '/auth/callback?code=fixture', {
    headers: { cookie: cookie(begin) },
    redirect: 'manual'
  });
  const sessionCookie = cookie(finish);
  const session = () =>
    fetch(origin + '/auth/session', { headers: { cookie: sessionCookie } }).then((r) => r.json());
  const login = await session();
  assert.equal(login.signedIn, true);
  const response = await fetch(origin + '/auth/logout', {
    method: 'POST',
    headers: { origin: publicOrigin, cookie: sessionCookie, 'x-vonvon-session': login.displaySession },
    redirect: 'manual'
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await session()).signedIn, false);
});
