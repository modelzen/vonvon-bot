import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { assertSecureTransport, DEFAULT_MANIFEST_URL, readStableManifest, validateManifest, validateReleaseInventory, verifyPublicRelease, verifyVersionedRelease } from './verify-public-release.mjs';

const version = '0.7.1', sha = 'a'.repeat(40);
const base = new URL('.', DEFAULT_MANIFEST_URL);
const manifest = { version, feedURL: new URL(`feed-${version}.json`, base).href };
const feed = { url: new URL(`Vonvon-Bot-${version}-universal.zip`, base).href, name: `Vonvon Bot ${version}`, notes: 'Fixed startup.', pub_date: '2026-10-26T00:00:00Z' };
const response = (body, { status = 200, cache = 'no-cache', type = 'application/json' } = {}) => new Response(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), {
  status, headers: { 'content-type': type, 'cache-control': cache },
});

test('TLS bypass and trust-store overrides are rejected before release requests', async () => {
  assertSecureTransport({}, []);
  assertSecureTransport({ NODE_TLS_REJECT_UNAUTHORIZED: '1', NODE_OPTIONS: '--max-old-space-size=4096' }, ['--test']);
  for (const env of [
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { NODE_OPTIONS: '--insecure-http-parser' },
    { NODE_EXTRA_CA_CERTS: '/fixture/ca.pem' }, { SSL_CERT_FILE: '/fixture/ca.pem' }, { SSL_CERT_DIR: '/fixture/certs' }, { NODE_USE_SYSTEM_CA: '1' },
    { NODE_OPTIONS: '--use-openssl-ca' }, { NODE_OPTIONS: '--use-system-ca' }, { NODE_OPTIONS: '--openssl-config=/fixture/openssl.cnf' },
    { NODE_OPTIONS: '-r ./hook.cjs' }, { NODE_OPTIONS: '--require=./hook.cjs' }, { NODE_OPTIONS: '--import ./hook.mjs' }, { NODE_OPTIONS: '--experimental-loader=./hook.mjs' },
  ]) assert.throws(() => assertSecureTransport(env, []), /TLS verification/, JSON.stringify(env));
  for (const execArgv of [['--use-openssl-ca'], ['--import=./hook.mjs'], ['-r', './hook.cjs'], ['--loader', './hook.mjs']]) {
    assert.throws(() => assertSecureTransport({}, execArgv), /TLS verification/, execArgv.join(' '));
  }
  const fetchImpl = async () => assert.fail('no request may be made');
  await assert.rejects(readStableManifest({ env: { NODE_EXTRA_CA_CERTS: '/fixture/ca.pem' }, fetchImpl }), /TLS verification/);
  await assert.rejects(verifyPublicRelease({ env: { SSL_CERT_FILE: '/fixture/ca.pem' }, out: '/evidence', version, sha, fetchImpl }), /TLS verification/);
  await assert.rejects(verifyVersionedRelease({ env: { SSL_CERT_DIR: '/fixture/certs' }, out: '/evidence', version, sha, fetchImpl }), /TLS verification/);
});

test('stable baseline requires exact HTTP 200 and product-compatible strict JSON', async () => {
  const result = await readStableManifest({ env: {}, fetchImpl: async (url, options) => {
    assert.equal(url, DEFAULT_MANIFEST_URL); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return response(manifest);
  } });
  assert.equal(result.kind, 'present'); assert.deepEqual(result.manifest, manifest);
  for (const value of [{ ...manifest, extra: true }, { ...manifest, version: 'x' }, { ...manifest, feedURL: 'https://other.example/feed-0.7.1.json' }, { ...manifest, feedURL: new URL('elsewhere/feed-0.7.1.json', base).href }, { ...manifest, feedURL: manifest.feedURL + '?token=secret' }]) {
    assert.throws(() => validateManifest(value));
  }
  await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => response(manifest, { type: 'text/html' }) }), /Content-Type/);
  await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => response(' '.repeat(16385)) }), /16384/);
});

test('first-release missing classification never treats other failures as an empty baseline', async () => {
  assert.deepEqual(await readStableManifest({ env: {}, fetchImpl: async () => response('', { status: 404 }) }), { kind: 'missing', status: 404, code: 'HTTP404' });
  for (const status of [201, 301, 302, 400, 403, 500, 503]) {
    await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => response('<Error><Code>NoSuchKey</Code></Error>', { status }) }), /HTTP/);
  }
  await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => response('<Error><Code>AccessDenied</Code></Error>', { status: 400 }) }), /HTTP 400/);
  await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => { throw new Error('certificate mismatch'); } }), /certificate mismatch/);
  await assert.rejects(readStableManifest({ env: {}, fetchImpl: async () => { throw new Error('timeout'); } }), /timeout/);
});

function evidence() {
  const files = new Map([
    ['manifest.json', Buffer.from(JSON.stringify(manifest))],
    [`feed-${version}.json`, Buffer.from(JSON.stringify(feed))],
    [`Vonvon-Bot-${version}-universal.zip`, Buffer.from('not a real ZIP; hash fixture')],
    [`Vonvon-Bot-${version}-universal.dmg`, Buffer.from('not a real DMG; hash fixture')],
  ]);
  const record = file => ({ file, size: files.get(file).length, sha256: createHash('sha256').update(files.get(file)).digest('hex') });
  const inventory = { version, sourceCommit: sha, mode: 'release', complete: true, files: [...files.keys()].map(record) };
  files.set('release-inventory.json', Buffer.from(JSON.stringify(inventory)));
  const state = { context: { version, sourceCommit: sha, mode: 'release' }, complete: true, files: [...files.keys()].map(record) };
  files.set('notarization-state.json', Buffer.from(JSON.stringify(state)));
  files.set('SHA256SUMS', Buffer.from(state.files.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n'));
  return { files, inventory, state };
}

function fixture(t) {
  const data = evidence(), { files } = data;
  const missing = () => Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
  t.mock.method(fs, 'readFile', async (path, encoding) => { const value = files.get(basename(path)); if (!value) throw missing(); return encoding ? value.toString(encoding) : value; });
  t.mock.method(fs, 'lstat', async path => { const value = files.get(basename(path)); if (!value) throw missing(); return { size: value.length, isFile: () => true, isSymbolicLink: () => false }; });
  t.mock.method(fs, 'open', async path => { const value = files.get(basename(path)); if (!value) throw missing(); return { createReadStream: () => Readable.from([value]), close: async () => {} }; });
  return data;
}

test('local gate binds complete formal release, version/SHA, inventory, sums and file bytes', async t => {
  const data = fixture(t);
  const result = await validateReleaseInventory('/evidence', { version, sha });
  assert.equal(result.files.length, 4);
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha: 'b'.repeat(40) }), /matching/);
  data.files.set(`Vonvon-Bot-${version}-universal.zip`, Buffer.from('changed artifact'));
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha }), /bytes/);
});

test('local gate refuses rehearsals, incomplete state, traversal and malformed sums', async t => {
  const data = fixture(t);
  data.files.set('DO-NOT-PUBLISH', Buffer.from('rehearsal'));
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha }), /Rehearsal/);
  data.files.delete('DO-NOT-PUBLISH');
  data.state.complete = false; data.files.set('notarization-state.json', Buffer.from(JSON.stringify(data.state)));
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha }), /complete formal/);
  data.state.complete = true; data.state.context.mode = 'rehearsal'; data.files.set('notarization-state.json', Buffer.from(JSON.stringify(data.state)));
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha }), /complete formal/);
  data.state.context.mode = 'release'; data.files.set('notarization-state.json', Buffer.from(JSON.stringify(data.state)));
  data.files.set('SHA256SUMS', Buffer.from('a'.repeat(64) + '  ../outside.zip\n'));
  await assert.rejects(validateReleaseInventory('/evidence', { version, sha }), /Malformed/);
});

test('public verification streams and hashes every artifact with cache/header and redirect constraints', async t => {
  const data = fixture(t); const seen = [];
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal); seen.push(url);
    const file = basename(new URL(url).pathname);
    return response(data.files.get(file), { cache: file === 'manifest.json' ? 'no-cache' : 'public, max-age=31536000, immutable', type: file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
  };
  const result = await verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl });
  assert.equal(result.publiclyVerified, true); assert.equal(seen.length, 4);
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async () => response(manifest, { status: 302 }) }), /HTTP 200/);
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async () => response(manifest, { cache: 'max-age=3600' }) }), /Manifest requires/);
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async () => response(manifest, { cache: 'no-cache, s-maxage=600' }) }), /CDN cache/);
});

test('public verification rejects stale versioned cache policy and altered downloads', async t => {
  const data = fixture(t);
  const serve = (url, change) => {
    const file = basename(new URL(url).pathname);
    return response(change && file.endsWith('.zip') ? 'wrong bytes' : data.files.get(file), { cache: file === 'manifest.json' ? 'max-age=60' : change ? 'public, max-age=31536000, immutable' : 'max-age=60' });
  };
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async url => serve(url, false) }), /Versioned objects/);
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async url => serve(url, true) }), /SHA-256 or size/);
});

const versionedHeaders = file => ({ cache: file === 'manifest.json' ? 'no-cache' : 'public, max-age=31536000, immutable', type: file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });

test('versioned-only verification checks feed, ZIP and DMG before the stable switch without reading the live manifest', async t => {
  const data = fixture(t);
  const serve = (override = {}) => async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url === DEFAULT_MANIFEST_URL) throw new Error('the live manifest must not be read before the stable switch');
    const file = basename(new URL(url).pathname);
    return response(override.bytes?.(file) ?? data.files.get(file), { ...versionedHeaders(file), ...override.headers?.(file) });
  };
  const result = await verifyVersionedRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: serve() });
  assert.equal(result.versionedObjectsVerified, true);
  assert.equal(result.publiclyVerified, undefined);
  assert.deepEqual(result.files.map(record => record.file).sort(), [`Vonvon-Bot-${version}-universal.dmg`, `Vonvon-Bot-${version}-universal.zip`, `feed-${version}.json`]);
  assert.ok(result.files.every(record => record.url === new URL(record.file, DEFAULT_MANIFEST_URL).href && /^[a-f0-9]{64}$/.test(record.sha256)));
  await assert.rejects(verifyVersionedRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: serve({ headers: file => file.startsWith('feed-') ? { type: 'application/octet-stream' } : {} }) }), /application\/json/);
  await assert.rejects(verifyVersionedRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: serve({ headers: file => file.endsWith('.dmg') ? { cache: '' } : {} }) }), /Versioned objects/);
  await assert.rejects(verifyVersionedRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: serve({ bytes: file => file.endsWith('.zip') ? 'wrong bytes' : undefined }) }), /SHA-256 or size/);
  await assert.rejects(verifyVersionedRelease({ env: {}, out: '/evidence', version, sha, fetchImpl: async () => response('', { status: 404 }) }), /HTTP 200/);
});

test('full public verification also requires the feed to be served as JSON', async t => {
  const data = fixture(t);
  const fetchImpl = async url => {
    const file = basename(new URL(url).pathname);
    return response(data.files.get(file), { ...versionedHeaders(file), ...(file.startsWith('feed-') ? { type: 'application/octet-stream' } : {}) });
  };
  await assert.rejects(verifyPublicRelease({ env: {}, out: '/evidence', version, sha, fetchImpl }), /application\/json/);
});

test('CLI runs through a symlinked directory instead of silently exiting 0', async t => {
  // macOS mktemp paths sit under the /var -> /private/var link; simulate that alias.
  const root = await fs.mkdtemp(join(tmpdir(), 'verify-cli-'));
  assert.ok(basename(root).startsWith('verify-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alias = join(root, 'alias');
  await fs.symlink(dirname(fileURLToPath(import.meta.url)), alias, 'dir');
  const run = (args, env = {}) => spawnSync(process.execPath, [join(alias, 'verify-public-release.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /--out/);
  for (const mode of [['--local-only'], ['--versioned-only'], []]) {
    const missing = run(['--out', join(root, 'missing'), '--version', '0.7.0', '--sha', 'a'.repeat(40), ...mode]);
    assert.equal(missing.status, 1, `mode ${mode.join(' ') || 'full'} must fail on missing evidence`);
    assert.match(missing.stderr, /ENOENT|no such file/i);
    assert.equal(missing.stdout, '');
  }
  // Success is judged by the printed line (workflow.md), so the CLI's success path is pinned too.
  const out = join(root, 'evidence');
  await fs.mkdir(out);
  for (const [file, bytes] of evidence().files) await fs.writeFile(join(out, file), bytes);
  const args = ['--out', out, '--version', version, '--sha', sha];
  const local = run([...args, '--local-only']);
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /^Local formal-release evidence verified\./m);
  const both = run([...args, '--local-only', '--versioned-only']);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--local-only \| --versioned-only/);
  assert.equal(both.stdout, '');
  // Without network, the public modes must still reach their TLS gate instead of the local-only path.
  for (const mode of [['--versioned-only'], []]) {
    const gated = run([...args, ...mode], { SSL_CERT_FILE: '/fixture/ca.pem' });
    assert.equal(gated.status, 1, `mode ${mode.join(' ') || 'full'}`);
    assert.match(gated.stderr, /TLS verification/);
    assert.equal(gated.stdout, '');
  }
});
