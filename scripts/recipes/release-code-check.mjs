// From the repository root after npm ci there and in services/{recipe-web,release-code-mcp}:
// node --experimental-transform-types --test scripts/recipes/release-code-check.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ReleaseCodeConnections } from '../../packages/daemon/src/release-code/connection.ts';
import { createReleaseCodeAuth } from '../../services/recipe-web/release-code-oauth.mjs';
import { accountVerifier } from '../../services/release-code-mcp/src/auth.mjs';
import { createHttpService } from '../../services/release-code-mcp/src/http.mjs';
import { sourceLibrary } from '../../services/release-code-mcp/src/source.mjs';
import { usageStore } from '../../services/release-code-mcp/src/usage.mjs';

const accountOrigin = 'https://account.release-code.test';
const mcpOrigin = 'https://code.release-code.test';
const issuer = accountOrigin + '/release-code/oauth';
const audience = mcpOrigin + '/mcp';

async function start(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })
  );
  return 'http://127.0.0.1:' + server.address().port;
}

async function authorizeInBrowser(fetchLocal, message, user) {
  const begin = /打开 (https:\/\/[^，\s]+)，.*验证码 ([^。\s]+)/u.exec(message);
  assert.ok(begin, 'private chat returned an authorization URL and user code');
  const [, url, code] = begin;
  const cookies = new Map([['test_browser_session', user.webSession]]);
  async function request(endpoint, form) {
    const response = await fetchLocal(endpoint, {
      method: form ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { Origin: accountOrigin, Cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; ') },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    });
    for (const item of response.headers.getSetCookie()) {
      const [key, ...value] = item.split(';')[0].split('=');
      cookies.set(key, value.join('='));
    }
    return response;
  }
  const xsrf = (html) => {
    const field = /name="xsrf" value="([^"]+)"/u.exec(html);
    assert.ok(field, 'device confirmation page supplied a CSRF token');
    return field[1];
  };
  const entry = await request(url);
  assert.equal(entry.status, 200);
  const verify = await request(url, { user_code: code, xsrf: xsrf(await entry.text()) });
  assert.equal(verify.status, 200);
  const confirmed = await request(url, { user_code: code, xsrf: xsrf(await verify.text()), confirm: 'yes' });
  assert.equal(confirmed.status, 303);
  const consentUrl = confirmed.headers.get('location');
  const consent = await request(consentUrl);
  assert.equal(consent.status, 200);
  assert.ok((await consent.text()).includes(user.accountId), 'consent identifies the acting account');
  const accepted = await request(consentUrl, { session: user.webSession, action: 'accept' });
  assert.equal(accepted.status, 303);
  const complete = await request(accepted.headers.get('location'));
  assert.equal(complete.status, 200);
  assert.ok((await complete.text()).includes('授权操作已完成'));
}

test('two accounts connect through the daemon device flow and read a release through authenticated MCP', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-code-check-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const users = ['alice', 'bob'].map((sender) => ({
    key: JSON.stringify(['registration', 'app', 'tenant', sender]),
    accountId: randomUUID(),
    sessionId: randomUUID(),
    webSession: randomUUID(),
  }));
  const browserUser = (req) => {
    const session = /(?:^|; )test_browser_session=([^;]+)/u.exec(req.headers.cookie || '')?.[1];
    return users.find((u) => u.webSession === session);
  };
  // Supply the already authenticated web sessions and volatile grant storage only.
  // Device entry, consent, token exchange/signature, MCP auth, both transports, and SQL counts use production code.
  const grants = new Map();
  const store = {
    bind(id, account) {
      grants.set(id, account);
    },
    validGrant(id, account) {
      return grants.get(id) === account;
    },
    logout() {
      grants.clear();
    },
    close() {},
  };
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const authorization = createReleaseCodeAuth(
    {
      env: { RELEASE_CODE_ISSUER: issuer, RELEASE_CODE_RESOURCE: audience },
      publicOrigin: accountOrigin,
      login: {
        status(req) {
          const user = browserUser(req);
          return { signedIn: !!user, displaySession: user?.webSession };
        },
      },
    },
    {
      account: async (req) => browserUser(req),
      store,
      config: {
        jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: 'check', use: 'sig' }] },
        cookies: [randomUUID() + randomUUID()],
      },
    }
  );
  t.after(() => authorization.close());
  const accountAddress = await start(
    t,
    createServer(async (req, res) => {
      try {
        if (!(await authorization.handle(req, res, new URL(req.url, accountOrigin)))) {
          res.writeHead(404);
          res.end();
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
    })
  );
  await mkdir(join(home, 'current/tree/packages'), { recursive: true });
  await writeFile(
    join(home, 'current/release.json'),
    JSON.stringify({ version: '1.0.0', sourceSha: 'b'.repeat(40) })
  );
  await writeFile(join(home, 'current/tree/packages/feedback.ts'), 'first\ncheck_feedback()\n');
  const stats = join(home, 'calls.sqlite');
  const usage = usageStore(stats);
  t.after(() => usage.close());
  const mcpAddress = await start(
    t,
    createHttpService({
      audience,
      issuer,
      library: sourceLibrary({ root: home }),
      usage,
      verify: accountVerifier({ audience, issuer, jwksUrl: accountAddress + '/release-code/oauth/jwks' }),
    })
  );
  const servers = new Map([
    [accountOrigin, accountAddress],
    [mcpOrigin, mcpAddress],
  ]);
  const fetchLocal = (url, options) => {
    const target = new URL(url);
    const base = servers.get(target.origin);
    assert.ok(base, 'all traffic stays on the two temporary loopback services');
    return fetch(base + target.pathname + target.search, options);
  };
  const daemon = new ReleaseCodeConnections({ url: audience, issuer }, fetchLocal);
  t.after(() => daemon.close());
  const call = (user, name, args) => daemon.call(user.key, name, args, new AbortController().signal, () => {});
  await assert.rejects(() => call(users[1], 'read', { path: 'packages/feedback.ts' }), /登录|授权/u);

  await Promise.all(
    users.map(async (user) => {
      const message = await daemon.begin(user.key);
      await authorizeInBrowser(fetchLocal, message, user);
    })
  );
  // The issuer specifies a polling interval. Use the daemon's normal pending result and real clock.
  async function finish(user) {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      try {
        assert.match(await daemon.finish(user.key), /已连接本人的 VonVon 账号/u);
        return;
      } catch (error) {
        if (!/请稍等片刻|授权尚未完成/u.test(error.message)) throw error;
        await sleep(250);
      }
    }
    throw new Error('Device authorization did not finish in time');
  }
  await Promise.all(users.map(finish));
  const hits = JSON.parse(await call(users[0], 'rg', { argv: ['-n', '-F', 'check_feedback', 'packages'] }));
  assert.match(hits.text, /packages\/feedback\.ts:2:check_feedback/u);
  const file = JSON.parse(await call(users[1], 'read', { path: 'packages/feedback.ts', offset: 2, limit: 1 }));
  assert.deepEqual([file.version, file.text], ['1.0.0', '2\tcheck_feedback()']);
  await assert.rejects(() => call(users[1], 'read', { path: 'missing.ts' }), /Path not found/u);
  await daemon.logout(users[0].key);
  await assert.rejects(() => call(users[0], 'rg', { argv: ['--files'] }), /登录|授权/u);
  await call(users[1], 'read', { path: 'packages/feedback.ts', limit: 1 });
  const db = new DatabaseSync(stats, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('SELECT account,tool,SUM(calls) AS calls FROM calls GROUP BY account,tool ORDER BY tool')
        .all()
        .map((row) => ({ ...row })),
      [
        { account: users[1].accountId, tool: 'read', calls: 3 },
        { account: users[0].accountId, tool: 'rg', calls: 1 },
      ]
    );
  } finally {
    db.close();
  }
});
