import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { accountVerifier } from '../src/auth.mjs';
import { createHttpService } from '../src/http.mjs';
import { sourceLibrary } from '../src/source.mjs';
import { usageStore } from '../src/usage.mjs';

const account = 'bb502740-e804-4a57-93ee-7ecd54ad8c6b';
const second = 'ee6ab6d8-2a94-492b-986e-0bde04cc1951';
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
}
async function publish(root, version, sourceSha, text) {
  const release = join(root, 'snapshot-' + version);
  await mkdir(join(release, 'tree', 'pkg'), { recursive: true });
  await writeFile(join(release, 'release.json'), JSON.stringify({ version, sourceSha }));
  await writeFile(join(release, 'tree/pkg/app.ts'), text);
  await symlink('snapshot-' + version, join(root, 'next'));
  await rename(join(root, 'next'), join(root, 'current'));
}

test('real MCP transport, per-request identity, search, pagination, release updates and hourly counts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await publish(root, '1.2.3', 'a'.repeat(40), 'first\nneedle: 中文\nlast\n');
  const library = sourceLibrary({ root });
  const stats = join(root, 'statistics.sqlite');
  const usage = usageStore(stats, { maxCallsPerHour: 10 });
  t.after(() => usage.close());
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const key = { ...(await exportJWK(publicKey)), kid: 'one', alg: 'ES256' };
  let jwksCalls = 0;
  const keys = createServer((_req, res) => {
    jwksCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [key] }));
  });
  const issuer = (await listen(keys)) + '/release-code/oauth';
  t.after(() => close(keys));
  // Public deployment URL is independent of the loopback address that the reverse proxy dials.
  const audience = 'https://release-code.example/mcp';
  const verify = accountVerifier({ issuer, audience, jwksUrl: issuer + '/jwks' });
  const srv = createHttpService({ audience, issuer, verify, library, usage });
  const origin = await listen(srv);
  const url = origin + '/mcp';
  t.after(() => close(srv));
  const now = Math.floor(Date.now() / 1000);
  function token(claims = {}, type = 'at+jwt') {
    return new SignJWT({
      iss: issuer,
      aud: audience,
      iat: now,
      exp: now + 600,
      sub: account,
      scope: 'release-code:read',
      ...claims,
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'one', typ: type })
      .sign(privateKey);
  }
  const valid = await token();
  const headers = { authorization: 'Bearer ' + valid };
  const denied = await fetch(url);
  assert.equal(denied.status, 401);
  assert.match(
    denied.headers.get('www-authenticate'),
    /resource_metadata="https:\/\/release-code\.example\/\.well-known\/oauth-protected-resource\/mcp"/u
  );
  const metadata = await (await fetch(origin + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, audience);
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  for (const claims of [
    { aud: 'authenticated' },
    { aud: [audience, 'another'] },
    { scope: 'something:else' },
    { sub: 'anonymous' },
    { iat: now - 800, exp: now - 2 },
    { exp: now + 601 },
    { iss: origin },
  ]) {
    assert.equal(
      (await fetch(url, { headers: { authorization: 'Bearer ' + (await token(claims)) } })).status,
      401
    );
  }
  assert.equal(
    (await fetch(url, { headers: { authorization: 'Bearer ' + (await token({}, 'JWT')) } })).status,
    401
  );
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await (await fetch(origin + '/healthz')).json()).version, '1.2.3');
  const client = new Client({ name: 'acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['read', 'rg']);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const value = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const page = await value('read', { path: 'pkg/app.ts', offset: 2, limit: 1 });
  assert.equal(page.version, '1.2.3');
  assert.equal(page.nextOffset, 3);
  assert.equal(page.totalLines, 3);
  assert.equal(page.text, '2\tneedle: 中文');
  const hits = await value('rg', { argv: ['-n', '-F', '-C', '1', '--', 'needle: 中文', 'pkg'] });
  assert.match(hits.text, /pkg\/app.ts:2:needle: 中文/u);
  assert.match((await value('rg', { argv: ['--files', '-g', '*.ts'] })).text, /pkg\/app.ts/u);
  assert.equal((await value('rg', { argv: ['unmatched'] })).text, '');
  await publish(root, '1.2.4', 'b'.repeat(40), 'new\n');
  const latest = await value('read', { path: 'pkg/app.ts' });
  assert.equal(latest.text, '1\tnew');
  assert.equal(latest.sourceSha, 'b'.repeat(40));
  const secondClient = new Client({ name: 'second', version: '1' });
  await secondClient.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: 'Bearer ' + (await token({ sub: second })) } },
    })
  );
  t.after(() => secondClient.close());
  await secondClient.callTool({ name: 'rg', arguments: { argv: ['--files'] } });
  assert.equal(jwksCalls, 1);
  const db = new DatabaseSync(stats, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .map((column) => column.name),
      ['hour', 'account', 'tool', 'calls']
    );
    assert.deepEqual(
      db
        .prepare('SELECT account, tool, calls FROM calls ORDER BY account,tool')
        .all()
        .map((row) => ({ ...row })),
      [
        { account, tool: 'read', calls: 2 },
        { account, tool: 'rg', calls: 3 },
        { account: second, tool: 'rg', calls: 1 },
      ]
    );
  } finally {
    db.close();
  }
});

test('snapshot boundaries, rg options, long lines, binary and empty files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-mcp-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await publish(root, '1.2.3', 'a'.repeat(40), 'normal\n');
  const tree = join(root, 'current/tree');
  await symlink(root, join(tree, 'outside'));
  await symlink(join(root, 'current/release.json'), join(tree, 'pkg', 'link.ts'));
  await writeFile(join(tree, 'pkg', 'empty.ts'), '');
  await writeFile(join(tree, 'pkg', 'nul.ts'), Buffer.from([110, 0, 111]));
  await writeFile(join(tree, 'pkg', 'long.ts'), 'A'.repeat(40000) + '\nend');
  const source = sourceLibrary({ root });
  const call = (tool, input) => source.query(tool, input, new AbortController().signal);
  for (const path of [
    '../release.json',
    '/unrelated',
    'outside/current/release.json',
    'pkg/link.ts',
    '.secret',
    'pkg/nul.ts',
  ]) {
    await assert.rejects(() => call('read', { path }));
  }
  for (const argv of [
    ['--pre', 'echo', 'pattern'],
    ['-f', '../release.json'],
    ['-L', 'something'],
    ['--files', 'outside'],
    ['text', 'pkg/link.ts'],
    ['--max-depth', '-1', '--files'],
    ['-g', 'unmatched'],
    ['--files', '../'],
  ]) {
    await assert.rejects(() => call('rg', { argv }));
  }
  assert.equal((await call('rg', { argv: ['-F', 'sourceSha', 'pkg'] })).text, '');
  assert.equal((await call('read', { path: 'pkg/empty.ts' })).totalLines, 0);
  await assert.rejects(() => call('read', { path: 'pkg/long.ts' }), /Line exceeds/u);
  assert.equal((await call('read', { path: 'pkg/long.ts', offset: 2 })).text, '2\tend');
});

test('account usage limit aggregates tools but keeps accounts independent and expires on the hour', () => {
  const usage = usageStore(':memory:', { maxCallsPerHour: 2 });
  try {
    assert.ok(usage.take(account, 'read', 0));
    assert.ok(usage.take(account, 'rg', 42000));
    assert.equal(usage.take(account, 'rg', 43000), false);
    assert.ok(usage.take(second, 'read', 43000));
    assert.ok(usage.take(account, 'read', 3600000));
  } finally {
    usage.close();
  }
});
