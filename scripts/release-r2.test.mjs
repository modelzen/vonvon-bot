import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { archiveName, PUBLISHED_TARGETS, SERVER_BASE_URL } from './server-constants.mjs';
import { publicKeyForms, signServerManifest, unsignedManifest } from './server-manifest.mjs';
import { r2TransferTimeout, r2BodyChunks, loadR2Client, planPublishedR2Mirror, planR2Mirror, r2PlanSHA256, syncR2Mirror, validateR2Config, verifyR2Mirror } from './release-r2.mjs';

const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const config = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'test-linux-release', publicBaseURL: 'https://example.workers.dev/bot/server', accessKeyIdEnv: 'TEST_R2_ID', secretAccessKeyEnv: 'TEST_R2_SECRET', sdkModule: '/private/tools/node_modules/@aws-sdk/client-s3' };
const immutable = 'public, max-age=31536000, immutable';
const mutable = 'no-store';
const stableKey = 'bot/server/stable/manifest.json';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'r2-mirror-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = publicKeyForms(publicKey);
  const privatePEM = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const version = '0.9.1';
  const bodies = new Map();
  const files = {};
  for (const target of PUBLISHED_TARGETS) {
    const file = archiveName(version, target), body = Buffer.from(`test archive ${target}`);
    bodies.set(file, body);
    files[target] = { url: `${SERVER_BASE_URL}/${version}/${file}`, sha512: hash(body, 'sha512'), size: body.length };
  }
  const payload = { schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt: 1793754123, files };
  bodies.set('stable-manifest.json', signServerManifest(payload, privatePEM));
  bodies.set('manifest.json', unsignedManifest(payload));
  bodies.set('install.sh', Buffer.from(`#!/bin/sh\nBASE_URL="${SERVER_BASE_URL}"\n# BEGIN VONVON PUBKEY\nPUBKEY_PEM='${key.pem}'\n# END VONVON PUBKEY\necho install\n`));
  bodies.set('uninstall.sh', Buffer.from('#!/bin/sh\necho uninstall\n'));
  for (const [name, bytes] of bodies) await writeFile(join(dir, name), bytes);
  const object = (file, key, contentType, sha512 = false) => ({ file, key, url: `${SERVER_BASE_URL}/${key.slice('bot/server/'.length)}`, contentType, bytes: bodies.get(file).length, sha256: hash(bodies.get(file)), ...(sha512 ? { sha512: hash(bodies.get(file), 'sha512') } : {}) });
  const serverPlan = { version, sourceSha: 'b'.repeat(40), publicKey: key.base64, publishedAt: payload.publishedAt,
    versioned: [...PUBLISHED_TARGETS.map(target => { const file = archiveName(version, target); return object(file, `bot/server/${version}/${file}`, 'application/gzip', true); }), object('manifest.json', `bot/server/${version}/manifest.json`, 'application/json', true)],
    stable: [object('install.sh', 'bot/server/install.sh', 'text/plain; charset=utf-8'), object('uninstall.sh', 'bot/server/uninstall.sh', 'text/plain; charset=utf-8'), object('stable-manifest.json', stableKey, 'application/json')],
  };
  const store = new Map(), canonical = new Map();
  for (const object of [...serverPlan.versioned, ...serverPlan.stable]) canonical.set(object.key, { body: bodies.get(object.file), contentType: object.contentType, cacheControl: serverPlan.stable.includes(object) ? mutable : immutable });
  const calls = [];
  let sequence = 0;
  const head = item => item && { size: item.body.length, etag: item.etag, contentType: item.contentType, cacheControl: item.cacheControl };
  const client = {
    async head(key) { calls.push(['head', key]); return head(store.get(key)) ?? null; },
    async get(key, { ifMatch } = {}) {
      calls.push(['get', key]);
      const item = store.get(key);
      if (!item) return null;
      if (ifMatch && item.etag !== ifMatch) throw Object.assign(new Error('conflict'), { status: 412 });
      return { ...head(item), body: Readable.from([item.body]) };
    },
    async put(key, body, options) {
      calls.push(['put', key, options]);
      const item = store.get(key);
      if ((options.ifNoneMatch === '*' && item) || (options.ifMatch && item?.etag !== options.ifMatch)) throw Object.assign(new Error('conflict'), { status: 412 });
      store.set(key, { body: Buffer.from(body), etag: `"etag-${++sequence}"`, contentType: options.contentType, cacheControl: options.cacheControl });
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, undefined);
    assert.equal(options.headers, undefined);
    const parsed = new URL(url);
    assert.equal(parsed.search, '');
    const source = parsed.origin === new URL(SERVER_BASE_URL).origin ? canonical : store;
    const item = source.get(parsed.pathname.slice(1));
    if (!item) return new Response('404', { status: 404, headers: { 'cache-control': mutable } });
    return new Response(item.body, { headers: { 'content-type': item.contentType, 'cache-control': item.cacheControl, 'content-length': String(item.body.length) } });
  };
  const plan = await planR2Mirror({ dir, serverPlan, config });
  const sync = (extra = {}) => syncR2Mirror({ dir, plan, config, planSHA256: r2PlanSHA256(plan), client, fetchImpl, ...extra });
  const seed = (object, body = bodies.get(object.file)) => store.set(object.key, { body, etag: `"seed-${++sequence}"`, contentType: object.contentType, cacheControl: serverPlan.stable.some(value => value.key === object.key) ? mutable : immutable });
  const signed = changes => signServerManifest({ ...payload, ...changes }, privatePEM);
  return { dir, bodies, serverPlan, plan, store, canonical, calls, client, fetchImpl, sync, seed, signed, payload, key };
}

test('strict external config accepts only target and named credentials', () => {
  assert.deepEqual(validateR2Config(config), config);
  for (const bad of [
    { ...config, secretAccessKey: 'literal-secret' }, { ...config, secretAccessKeyEnv: 'literal-secret' },
    { ...config, accessKeyIdEnv: config.secretAccessKeyEnv }, { ...config, sdkModule: './sdk' },
    { ...config, endpoint: 'http://example.invalid' }, { ...config, bucket: '../bucket' },
    { ...config, publicBaseURL: 'https://example.r2.dev/bot/server' }, { ...config, publicBaseURL: SERVER_BASE_URL },
    { ...config, publicBaseURL: 'https://example.workers.dev/bot/server?url=other' },
  ]) assert.throws(() => validateR2Config(bad));
});

test('published plan matches signed exact Linux files; build reports are excluded', async t => {
  const f = await fixture(t);
  f.serverPlan.versioned.push({ key: 'bot/server/0.9.1/vonvon-server-0.9.1-build.json' });
  const plan = await planR2Mirror({ dir: f.dir, serverPlan: f.serverPlan, config });
  assert.equal(plan.versioned.length, 3);
  assert.equal(plan.stable.at(-1).file, 'stable-manifest.json');
  assert.equal(plan.versioned[0].url.startsWith(config.publicBaseURL), true);
  const recovered = await planPublishedR2Mirror({ dir: f.dir, config, publicKey: f.key.base64, sourceSha: f.serverPlan.sourceSha, fetchImpl: f.fetchImpl });
  assert.deepEqual(recovered, plan);
  assert.match(r2PlanSHA256(plan), /^[a-f0-9]{64}$/);
});

test('plan refuses foreign/duplicate paths, changed local bytes and bad signatures', async t => {
  const f = await fixture(t);
  for (const mutate of [
    plan => { plan.versioned.push({ ...plan.versioned[0], key: 'bot/mac/file.zip' }); },
    plan => { plan.versioned.push(plan.versioned[0]); },
    plan => { plan.versioned[0].file = '../archive'; },
    plan => { plan.versioned[0].url += '?bypass=1'; },
    plan => { plan.stable.reverse(); },
    plan => { plan.publicKey = publicKeyForms(generateKeyPairSync('ed25519').publicKey).base64; },
    plan => { plan.versioned[0].sha512 = '0'.repeat(128); },
  ]) {
    const bad = structuredClone(f.serverPlan); mutate(bad);
    await assert.rejects(planR2Mirror({ dir: f.dir, serverPlan: bad, config }));
  }
  await writeFile(join(f.dir, 'install.sh'), 'changed');
  await assert.rejects(planR2Mirror({ dir: f.dir, serverPlan: f.serverPlan, config }), /local size\/type changed/);
});

test('signed payload protects archives even when the unsigned upload plan hashes are edited', async t => {
  const f = await fixture(t);
  const object = f.serverPlan.versioned[0], body = Buffer.from('untrusted replacement');
  await writeFile(join(f.dir, object.file), body);
  Object.assign(object, { bytes: body.length, sha256: hash(body), sha512: hash(body, 'sha512') });
  await assert.rejects(planR2Mirror({ dir: f.dir, serverPlan: f.serverPlan, config }), /differs from signed manifest/);
});

test('public metadata and embedded installer key are bound to the signed release', async t => {
  for (const name of ['manifest.json', 'install.sh']) {
    const f = await fixture(t), object = [...f.serverPlan.versioned, ...f.serverPlan.stable].find(object => object.file === name);
    const body = Buffer.from(name === 'manifest.json' ? '{}' : f.bodies.get(name).toString().replace(SERVER_BASE_URL, 'https://other.invalid'));
    await writeFile(join(f.dir, name), body);
    Object.assign(object, { bytes: body.length, sha256: hash(body), ...(object.sha512 ? { sha512: hash(body, 'sha512') } : {}) });
    await assert.rejects(planR2Mirror({ dir: f.dir, serverPlan: f.serverPlan, config }), /differs/);
  }
});

test('all mode uploads immutable dependencies first, manifest last, and checks full public bytes', async t => {
  const f = await fixture(t), receipt = await f.sync();
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.verification.length, 6);
  const writes = f.calls.filter(call => call[0] === 'put');
  assert.deepEqual(writes.map(call => call[1]), [...f.plan.versioned, ...f.plan.stable].map(object => object.key));
  assert.equal(writes.at(-1)[1], stableKey);
  assert.ok(writes.every(call => call[2].ifNoneMatch === '*'));
  assert.deepEqual(f.store.get(stableKey).body, f.bodies.get('stable-manifest.json'));
  f.calls.length = 0;
  const again = await f.sync();
  assert.ok(again.objects.every(object => object.action === 'already-exact'));
  assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
});

test('reviewed plan hash, config target and local bytes are checked before mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.sync({ planSHA256: '0'.repeat(64) }), /exact reviewed/);
  await assert.rejects(f.sync({ config: { ...config, bucket: 'other-bucket' } }), /target differs/);
  await writeFile(join(f.dir, 'uninstall.sh'), 'changed');
  await assert.rejects(f.sync(), /local size\/type changed/);
  assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
});

test('stable rejects noncanonical scripts and stale canonical signed manifest before all writes', async t => {
  for (const key of ['bot/server/install.sh', stableKey]) {
    const f = await fixture(t);
    f.canonical.get(key).body = Buffer.from('not currently canonical');
    await assert.rejects(f.sync(), /length differs|remote bytes differ/);
    assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
    await assert.rejects(planPublishedR2Mirror({ dir: f.dir, config, publicKey: f.key.base64, fetchImpl: f.fetchImpl }));
  }
});

test('versioned candidate upload does not touch stable or require candidate already canonical', async t => {
  const f = await fixture(t);
  f.canonical.clear();
  const receipt = await f.sync({ mode: 'versioned' });
  assert.equal(receipt.objects.length, 3);
  assert.equal(f.store.has(stableKey), false);
  assert.equal(f.calls.some(call => call[0] === 'put' && call[1].includes('stable')), false);
});

test('immutable remote collision checks actual bytes, not metadata or reported hashes', async t => {
  const f = await fixture(t), object = f.plan.versioned[0];
  const changed = Buffer.from(f.bodies.get(object.file)); changed[0] ^= 1;
  f.seed(object, changed);
  await assert.rejects(f.sync({ mode: 'versioned' }), /remote bytes differ/);
  assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
  assert.deepEqual(f.store.get(object.key).body, changed);
});

test('immutable If-None-Match race accepts only a concurrent exact upload', async t => {
  const f = await fixture(t), object = f.plan.versioned[0];
  const put = f.client.put;
  let raced = false;
  f.client.put = async (key, body, options) => {
    if (key === object.key && !raced) { raced = true; f.seed(object); throw Object.assign(new Error('race'), { status: 412 }); }
    return put(key, body, options);
  };
  const result = await f.sync({ mode: 'versioned' });
  assert.equal(result.objects[0].action, 'already-exact');
});

test('stable-only requires every immutable object already present and exact', async t => {
  const f = await fixture(t);
  await assert.rejects(f.sync({ mode: 'stable' }), /metadata differs/);
  assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
  await f.sync({ mode: 'versioned' });
  const receipt = await f.sync({ mode: 'stable' });
  assert.equal(receipt.verification.length, 3);
});

test('stable rejects newer target, future timestamp, same-version replacement or invalid signature', async t => {
  for (const mode of ['newer', 'future', 'same-version', 'invalid']) {
    const f = await fixture(t);
    let body;
    if (mode === 'newer') {
      const files = Object.fromEntries(Object.entries(f.payload.files).map(([target, value]) => [target, { ...value, url: `${SERVER_BASE_URL}/0.9.2/${archiveName('0.9.2', target)}` }]));
      body = f.signed({ version: '0.9.2', files });
    } else if (mode === 'future') body = f.signed({ publishedAt: f.payload.publishedAt + 100 });
    else if (mode === 'same-version') body = f.signed({ notes: 'changed' });
    else body = Buffer.from('{}');
    f.seed(f.plan.stable.at(-1), body);
    await assert.rejects(f.sync(), /regression|replacement refused|manifest refused/);
    assert.equal(f.calls.filter(call => call[0] === 'put').length, 0);
  }
});

test('older stable advances through conditional writes only', async t => {
  const f = await fixture(t);
  const files = Object.fromEntries(Object.entries(f.payload.files).map(([target, value]) => [target, { ...value, url: `${SERVER_BASE_URL}/0.9.0/${archiveName('0.9.0', target)}` }]));
  f.seed(f.plan.stable.at(-1), f.signed({ version: '0.9.0', publishedAt: f.payload.publishedAt - 100, files }));
  const previousETag = f.store.get(stableKey).etag;
  await f.sync();
  assert.equal(f.calls.find(call => call[0] === 'put' && call[1] === stableKey)[2].ifMatch, previousETag);
});

test('canonical change after an immutable upload prevents mutable promotion', async t => {
  const f = await fixture(t), put = f.client.put;
  f.client.put = async (key, body, options) => {
    const result = await put(key, body, options);
    if (key === f.plan.versioned.at(-1).key) f.canonical.get(stableKey).body = Buffer.from('canonical changed');
    return result;
  };
  await assert.rejects(f.sync(), /length differs|remote bytes differ/);
  assert.equal(f.store.has(stableKey), false);
  assert.equal(f.store.has('bot/server/install.sh'), false);
});

test('target manifest race after preflight prevents any stable overwrite', async t => {
  const f = await fixture(t), put = f.client.put;
  f.client.put = async (key, body, options) => {
    const result = await put(key, body, options);
    if (key === f.plan.versioned.at(-1).key) f.seed(f.plan.stable.at(-1));
    return result;
  };
  await assert.rejects(f.sync(), /stable changed concurrently/);
  assert.equal(f.store.has('bot/server/install.sh'), false);
});

test('stale public mirror fails receipt after successful storage writes', async t => {
  const f = await fixture(t);
  const fetchImpl = async (url, options) => url === `${config.publicBaseURL}/stable/manifest.json` ? new Response('stale', { headers: { 'content-type': 'application/json', 'cache-control': mutable } }) : f.fetchImpl(url, options);
  await assert.rejects(f.sync({ fetchImpl }), /remote bytes differ/);
  assert.equal(f.store.has(stableKey), true);
});

test('public verification rejects cached mutable data and wrong immutable caching', async t => {
  const f = await fixture(t);
  await f.sync();
  f.store.get(stableKey).cacheControl = 'public, max-age=60';
  await assert.rejects(verifyR2Mirror({ plan: f.plan, config, fetchImpl: f.fetchImpl }), /headers differ/);
  f.store.get(stableKey).cacheControl = mutable;
  f.store.get(f.plan.versioned[0].key).cacheControl = mutable;
  await assert.rejects(verifyR2Mirror({ plan: f.plan, config, fetchImpl: f.fetchImpl }), /headers differ/);
});

test('official SDK adapter uses explicit credentials, conditional Put and safe errors', async () => {
  const commands = [];
  class Command { constructor(input) { this.input = input; } }
  class Client {
    constructor(options) { assert.equal(options.maxAttempts, 3); assert.deepEqual(options.requestHandler, { connectionTimeout: 15_000, socketTimeout: 60_000 }); assert.deepEqual(options.credentials, { accessKeyId: 'secret-id', secretAccessKey: 'secret-key' }); }
    async send(command) { commands.push(command.input); return { ETag: '"abc"', ContentLength: 3, Body: Readable.from([Buffer.from('abc')]) }; }
    destroy() {}
  }
  const client = await loadR2Client(config, { env: { TEST_R2_ID: 'secret-id', TEST_R2_SECRET: 'secret-key' }, sdk: { S3Client: Client, HeadObjectCommand: Command, GetObjectCommand: Command, PutObjectCommand: Command } });
  await client.put('bot/server/test', Buffer.from('abc'), { ifNoneMatch: '*', cacheControl: immutable, contentType: 'application/gzip' });
  assert.equal(commands[0].IfNoneMatch, '*');
  assert.equal(commands[0].ContentLength, 3);
  assert.equal(commands[0].ContentMD5, 'kAFQmDzST7DWlj99KOF/cg==');
  assert.equal(commands[0].Bucket, config.bucket);
  await assert.rejects(loadR2Client(config, { env: {} }), /variables must be set/);
  class BadClient { async send() { throw Object.assign(new Error('secret-key leaked in SDK error'), { $metadata: { httpStatusCode: 403 } }); } }
  const bad = await loadR2Client(config, { env: { TEST_R2_ID: 'id', TEST_R2_SECRET: 'key' }, sdk: { S3Client: BadClient, HeadObjectCommand: Command } });
  await assert.rejects(bad.head('key'), error => error.message === 'R2 request failed (HTTP 403)' && !error.message.includes('secret'));
});

test('stable manifest CAS stays bound to the original snapshot across the final head race', async t => {
  const f = await fixture(t);
  const filesAt = version => Object.fromEntries(Object.entries(f.payload.files).map(([target, value]) => [target, { ...value, url: `${SERVER_BASE_URL}/${version}/${archiveName(version, target)}` }]));
  f.seed(f.plan.stable.at(-1), f.signed({ version: '0.9.0', publishedAt: f.payload.publishedAt - 100, files: filesAt('0.9.0') }));
  const newer = f.signed({ version: '0.9.2', publishedAt: f.payload.publishedAt + 100, files: filesAt('0.9.2') });
  const head = f.client.head;
  let reads = 0;
  f.client.head = async key => {
    const result = await head(key);
    const scriptsWritten = ['bot/server/install.sh', 'bot/server/uninstall.sh'].every(script => f.calls.some(call => call[0] === 'put' && call[1] === script));
    if (key === stableKey && scriptsWritten && ++reads === 1) f.seed(f.plan.stable.at(-1), newer);
    return result;
  };
  await assert.rejects(f.sync(), /stable changed concurrently/);
  assert.deepEqual(f.store.get(stableKey).body, newer);
  assert.equal(f.calls.some(call => call[0] === 'put' && call[1] === stableKey), false);
});

test('CANCEL stops R2 before the next conditional upload', async t => {
  const f = await fixture(t), path = join(f.dir, 'CANCEL'), put = f.client.put;
  f.client.put = async (...args) => { const result = await put(...args); await writeFile(path, 'stop'); return result; };
  await assert.rejects(f.sync({ cancelFile: path, mode: 'versioned' }), /stopped by CANCEL/);
  assert.equal(f.calls.filter(call => call[0] === 'put').length, 1);
  assert.equal(f.store.has(stableKey), false);
});

test('large transfers get a bounded size-based budget and stalled bodies are cancelled', async () => {
  assert.equal(r2TransferTimeout(0), 300_000);
  assert.equal(r2TransferTimeout(100 * 1024 * 1024), 1_900_000);
  assert.equal(r2TransferTimeout(10 * 1024 * 1024 * 1024), 3_600_000);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(async () => { for await (const _chunk of r2BodyChunks(body, { idleTimeoutMs: 10 })) { /* never reached */ } }, /body stalled/);
  assert.equal(cancelled, true);
});

test('safe per-object progress identifies transfer phases without credentials', async t => {
  const f = await fixture(t), events = [], logs = [];
  await f.sync({ mode: 'versioned', onProgress: event => events.push(event), log: line => logs.push(line) });
  assert.ok(events.some(event => event.phase === 'upload'));
  assert.ok(events.some(event => event.phase === 'verify-stored'));
  assert.ok(events.some(event => event.phase === 'verify-public'));
  assert.ok(events.every(event => Number.isInteger(event.elapsedSeconds) && event.bytes > 0));
  assert.ok(logs.every(line => !line.includes('secret') && !line.includes(config.endpoint)));
});

test('SDK timeouts are identified without exposing the SDK error detail', async () => {
  class Command { constructor(input) { this.input = input; } }
  class Client { async send() { throw Object.assign(new Error('private signed URL'), { name: 'TimeoutError' }); } }
  const client = await loadR2Client(config, { env: { TEST_R2_ID: 'id', TEST_R2_SECRET: 'key' }, sdk: { S3Client: Client, HeadObjectCommand: Command } });
  await assert.rejects(client.head('test'), error => /timed out.*15s transfer deadline/.test(error.message) && !error.message.includes('private'));
});

test('script HEAD cannot adopt a newer release ETag after the initial manifest guard', async t => {
  for (const file of ['install.sh', 'uninstall.sh']) await t.test(file, async t => {
    const f = await fixture(t);
    await f.sync({ mode: 'versioned' });
    const object = f.plan.stable.find(object => object.file === file);
    const newerScript = Buffer.from(`#!/bin/sh\necho newer ${file}\n`);
    const files = Object.fromEntries(Object.entries(f.payload.files).map(([target, value]) => [target, { ...value, url: `${SERVER_BASE_URL}/0.9.2/${archiveName('0.9.2', target)}` }]));
    const newerManifest = f.signed({ version: '0.9.2', files, publishedAt: f.payload.publishedAt + 1 });
    const head = f.client.head;
    let raced = false;
    f.client.head = async key => {
      if (key === object.key && !raced) {
        raced = true;
        f.seed(object, newerScript);
        f.seed(f.plan.stable.at(-1), newerManifest);
      }
      return head(key);
    };
    await assert.rejects(f.sync({ mode: 'stable' }), /stable changed concurrently/);
    assert.deepEqual(f.store.get(object.key).body, newerScript);
    assert.deepEqual(f.store.get(stableKey).body, newerManifest);
    assert.equal(f.calls.some(call => call[0] === 'put' && call[1] === object.key), false);
  });
});

test('canonical source is checked again after capturing each mutable object ETag', async t => {
  for (const file of ['install.sh', 'uninstall.sh', 'stable-manifest.json']) await t.test(file, async t => {
    const f = await fixture(t);
    await f.sync({ mode: 'versioned' });
    const object = f.plan.stable.find(object => object.file === file);
    const head = f.client.head;
    let manifestReads = 0, raced = false;
    f.client.head = async key => {
      const result = await head(key);
      // The stable manifest also has guard HEADs. Its ordinary object HEAD is the
      // second consecutive HEAD after the preceding script has been uploaded.
      const scriptWrites = f.calls.filter(call => call[0] === 'put' && ['bot/server/install.sh', 'bot/server/uninstall.sh'].includes(call[1])).length;
      const candidateHead = file === 'stable-manifest.json' ? key === stableKey && scriptWrites === 2 && ++manifestReads === 2 : key === object.key;
      if (candidateHead && !raced) {
        raced = true;
        f.canonical.get(object.key).body = Buffer.from('canonical source advanced');
      }
      return result;
    };
    await assert.rejects(f.sync({ mode: 'stable' }), /length differs|remote bytes differ/);
    assert.equal(raced, true);
    assert.equal(f.calls.some(call => call[0] === 'put' && call[1] === object.key), false);
  });
});

test('a script change after the final manifest guard is still protected by the captured ETag', async t => {
  const f = await fixture(t);
  await f.sync({ mode: 'versioned' });
  const object = f.plan.stable[0];
  f.seed(object, Buffer.from('old script'));
  const capturedETag = f.store.get(object.key).etag;
  const head = f.client.head;
  const newerScript = Buffer.from('newer script written after guard');
  let captured = false, raced = false;
  f.client.head = async key => {
    const result = await head(key);
    if (key === object.key) captured = true;
    else if (key === stableKey && captured && !raced) { raced = true; f.seed(object, newerScript); }
    return result;
  };
  await assert.rejects(f.sync({ mode: 'stable' }), error => error.status === 412);
  assert.equal(raced, true);
  const attempt = f.calls.find(call => call[0] === 'put' && call[1] === object.key);
  assert.equal(attempt[2].ifMatch, capturedETag);
  assert.deepEqual(f.store.get(object.key).body, newerScript);
});

test('SDK retry diagnostics stay bounded and sanitized without an outer PUT retry', async () => {
  const sent = [];
  class Command { constructor(input) { this.input = input; } }
  class Client {
    constructor(options) { assert.equal(options.maxAttempts, 3); assert.equal(options.requestHandler.socketTimeout, 60_000); }
    async send(command) {
      sent.push(command.input);
      throw Object.assign(new Error('private signed URL and secret'), { name: 'TimeoutError', $metadata: { attempts: 3 } });
    }
  }
  const client = await loadR2Client(config, { env: { TEST_R2_ID: 'id', TEST_R2_SECRET: 'key' }, sdk: { S3Client: Client, PutObjectCommand: Command } });
  await assert.rejects(client.put('bot/server/install.sh', Buffer.from('candidate'), { ifMatch: '"captured-etag"', cacheControl: mutable, contentType: 'text/plain; charset=utf-8' }), error => {
    assert.equal(error.attempts, 3);
    assert.match(error.message, /R2 request timed out.*SDK attempts: 3/);
    assert.doesNotMatch(error.message, /private|secret|signed URL/);
    return true;
  });
  assert.equal(sent.length, 1, 'the SDK owns its bounded retry budget; the adapter must not multiply it');
  assert.equal(sent[0].IfMatch, '"captured-etag"');
});

test('CANCEL arriving during the final mutable guards prevents its conditional PUT', async t => {
  const f = await fixture(t), path = join(f.dir, 'CANCEL');
  await f.sync({ mode: 'versioned' });
  const head = f.client.head, object = f.plan.stable[0];
  let captured = false;
  f.client.head = async key => {
    const result = await head(key);
    if (key === object.key) captured = true;
    else if (key === stableKey && captured) await writeFile(path, 'stop');
    return result;
  };
  await assert.rejects(f.sync({ mode: 'stable', cancelFile: path }), /stopped by CANCEL/);
  assert.equal(f.calls.some(call => call[0] === 'put' && call[1] === object.key), false);
});
