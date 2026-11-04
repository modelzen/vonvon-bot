// The server's part of a release (docs/plans/server-5-release.md 4.3, 5): plan, versioned upload and stable promote,
// against a COS client in memory whose objects are what the fake public address serves. Keys are made here.
// main 必败: publish-server.mjs does not exist on main.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planServerPublication, promoteServerStable, publishServerObjects, readServerCosConfig, STABLE_RECEIPT, UPLOAD_RECEIPT, verifyServerPublic } from './publish-server.mjs';
import { PUBLISHED_TARGETS, SERVER_BASE_URL, SERVER_PREFIX, archiveName } from './server-constants.mjs';
import { publicKeyForms, signServerManifest, verifyServerManifest, withInstallScriptKey } from './server-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = 'c'.repeat(40), version = '0.9.0';
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const STABLE_KEYS = ['bot/server/install.sh', 'bot/server/uninstall.sh', 'bot/server/stable/manifest.json'];

/** A bucket in memory: what putObject stores is what the public address serves, with the headers it was stored with. */
function fakeCos() {
  const objects = new Map(), calls = [], hooks = {};
  const client = {
    getBucketVersioning: (_params, done) => { calls.push(['getBucketVersioning']); done(null, { VersioningConfiguration: hooks.versioning ?? {} }); },
    headObject: (params, done) => { calls.push(['headObject', params.Key]); if (objects.has(params.Key)) done(null, {}); else done({ statusCode: 404 }); },
    putObject: (params, done) => {
      calls.push(['putObject', params.Key, params]);
      hooks.beforePut?.(params);
      if (params.Headers?.['x-cos-forbid-overwrite'] === 'true' && objects.has(params.Key)) { done({ statusCode: 409, headers: { secret: 'SIGNED-URL' } }); return; }
      objects.set(params.Key, { body: Buffer.from(params.Body), contentType: params.ContentType, cacheControl: params.CacheControl });
      done(null, {});
    },
  };
  const fetchImpl = async url => {
    const object = url.startsWith(`${SERVER_BASE_URL}/`) ? objects.get(SERVER_PREFIX + url.slice(SERVER_BASE_URL.length + 1)) : undefined;
    if (!object) return new Response('missing', { status: 404 });
    return new Response(object.body, { status: 200, headers: { 'content-type': object.contentType, 'content-length': String(object.body.length), 'cache-control': object.cacheControl } });
  };
  const puts = () => calls.filter(call => call[0] === 'putObject');
  return { objects, calls, hooks, client, fetchImpl, puts };
}

/** A stable manifest for `liveVersion` signed with the fixture's key, put on the fake public address. */
function putLiveManifest(f, liveVersion, publishedAt) {
  const payload = { schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version: liveVersion, publishedAt,
    files: Object.fromEntries(PUBLISHED_TARGETS.map(target => [target, { url: `${SERVER_BASE_URL}/${liveVersion}/${archiveName(liveVersion, target)}`, sha512: 'e'.repeat(128), size: 5 }])) };
  const body = signServerManifest(payload, f.privatePem);
  f.cos.objects.set('bot/server/stable/manifest.json', { body, contentType: 'application/json', cacheControl: 'no-cache' });
  return body;
}

async function fixture(t, { updateKey = 'release', targets = PUBLISHED_TARGETS, sourceHead = sha, scriptKey, committedKey } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-publish-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'server');
  await mkdir(dir);
  const keys = generateKeyPairSync('ed25519'), forms = publicKeyForms(keys.publicKey);
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyFile = join(root, 'server-update.pem');
  await writeFile(keyFile, privatePem, { mode: 0o600 });
  const config = { bucket: 'fixture-123', region: 'ap-shanghai', prefix: SERVER_PREFIX, publicBaseURL: SERVER_BASE_URL, secretIdEnv: 'SERVER_ID', secretKeyEnv: 'SERVER_KEY', updatePrivateKeyFile: keyFile };
  const files = {};
  for (const target of targets) {
    const name = archiveName(version, target), body = Buffer.from(`package ${target} ${version}`);
    await writeFile(join(dir, name), body);
    files[target] = { name, size: body.length, sha256: hash(body), sha512: hash(body, 'sha512') };
  }
  const summary = { version, sourceHead, sourceDirty: false, node: '24.0.0', updateKey, update: { publicKey: forms.base64, baseURL: SERVER_BASE_URL }, files };
  await writeFile(join(dir, `vonvon-server-${version}-build.json`), JSON.stringify(summary, null, 2));
  const sources = {
    'scripts/install.sh': Buffer.from(withInstallScriptKey(await readFile(join(here, 'install.sh'), 'utf8'), scriptKey ?? forms.pem)),
    'scripts/uninstall.sh': await readFile(join(here, 'uninstall.sh')),
    'packages/daemon/server-update.json': Buffer.from(JSON.stringify({ publicKey: committedKey ?? forms.base64, baseURL: SERVER_BASE_URL })),
  };
  const readSource = async path => sources[path];
  const cos = fakeCos();
  const log = () => {};
  const plan = (extra = {}) => planServerPublication({ dir, version, sha, config, readSource, fetchImpl: cos.fetchImpl, now: () => 1_800_000_000_000, ...extra });
  const upload = (planned, extra = {}) => publishServerObjects({ dir, plan: planned, config, client: cos.client, fetchImpl: cos.fetchImpl, log, ...extra });
  const promote = (planned, extra = {}) => promoteServerStable({ dir, plan: planned, config, client: cos.client, fetchImpl: cos.fetchImpl, readSource, log, planSHA256: 'a'.repeat(64), ...extra });
  return { root, dir, keys, forms, privatePem, keyFile, config, summary, sources, cos, plan, upload, promote };
}

test('plan refuses a test-key build, another source, a changed package, a third target and keys that are not one', async t => {
  await assert.rejects((await fixture(t, { updateKey: 'test' })).plan(), /测试钥匙构建不能发布/);
  await assert.rejects((await fixture(t, { updateKey: 'none' })).plan(), /还没有发布公钥/);
  await assert.rejects((await fixture(t, { sourceHead: 'd'.repeat(40) })).plan(), /不是从这次发布的源码 SHA/);
  await assert.rejects((await fixture(t, { targets: [...PUBLISHED_TARGETS, 'darwin-arm64'] })).plan(), /只发 linux-x64、linux-arm64 两个 Linux 包/);
  const other = publicKeyForms(generateKeyPairSync('ed25519').publicKey);
  await assert.rejects((await fixture(t, { scriptKey: other.pem })).plan(), /不是同一把/);
  await assert.rejects((await fixture(t, { committedKey: other.base64 })).plan(), /不是同一把/);
  const changed = await fixture(t);
  await writeFile(join(changed.dir, archiveName(version, 'linux-arm64')), 'changed');
  await assert.rejects(changed.plan(), /linux-arm64\.tar\.gz 和构建记录对不上/);
  const dirty = await fixture(t);
  await writeFile(join(dirty.dir, `vonvon-server-${version}-build.json`), JSON.stringify({ ...dirty.summary, sourceDirty: true }));
  await assert.rejects(dirty.plan(), /干净构建/);
  const missing = await fixture(t);
  await rm(join(missing.dir, `vonvon-server-${version}-build.json`));
  await assert.rejects(missing.plan(), /先用 release-all build 打服务端包/);
});

test('plan lists two packages, the build report and the unsigned manifest, then the scripts and the signed manifest last', async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  assert.deepEqual(plan.versioned.map(object => object.key), [...PUBLISHED_TARGETS.map(target => `bot/server/${version}/${archiveName(version, target)}`),
    `bot/server/${version}/vonvon-server-${version}-build.json`, `bot/server/${version}/manifest.json`]);
  for (const object of plan.versioned) assert.equal(object.url, `${SERVER_BASE_URL}/${version}/${object.file}`);
  assert.deepEqual(plan.stable.map(object => object.key), STABLE_KEYS);
  assert.deepEqual(plan.previousManifest, { status: 404 });
  const unsigned = JSON.parse(await readFile(join(f.dir, 'manifest.json'), 'utf8'));
  assert.equal(unsigned.channel, undefined);
  assert.equal(unsigned.publishedAt, 1_800_000_000_000);
  assert.deepEqual(Object.values(unsigned.files).map(file => file.url), PUBLISHED_TARGETS.map(target => `${SERVER_BASE_URL}/${version}/${archiveName(version, target)}`));
  const signed = verifyServerManifest(await readFile(join(f.dir, 'stable-manifest.json')), f.forms.base64);
  assert.equal(signed.channel, 'stable');
  assert.deepEqual(await readFile(join(f.dir, 'install.sh')), f.sources['scripts/install.sh']);
  // publishedAt is fixed by the first plan: a later one signs nothing new and plans the same bytes.
  assert.deepEqual(await f.plan({ now: () => 1_900_000_000_000 }), plan);
  // A note that differs from the signed one is a different candidate.
  await assert.rejects(f.plan({ notes: '新的说明' }), /候选变了/);
});

test('plan refuses a live stable that is newer, the same version signed differently, or published later', async t => {
  const f = await fixture(t);
  const live = (liveVersion, publishedAt) => putLiveManifest(f, liveVersion, publishedAt);
  live('9.9.9', 1);
  await assert.rejects(f.plan(), /已经是更新的版本 9\.9\.9/);
  live(version, 1);
  await assert.rejects(f.plan(), /已经是 0\.9\.0 的另一份清单/);
  live('0.8.9', 1_900_000_000_000);
  await assert.rejects(f.plan(), /发布时间不比这次早/);
  f.cos.objects.set('bot/server/stable/manifest.json', { body: Buffer.from('{"payload":"","signature":""}'), contentType: 'application/json', cacheControl: 'no-cache' });
  await assert.rejects(f.plan(), /验不过/);
  live('0.8.9', 1_700_000_000_000);
  assert.equal((await f.plan()).previousManifest.version, '0.8.9');
});

test('upload writes each versioned object once, never overwriting, then verifies every public byte', async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  const receipt = await f.upload(plan);
  const puts = f.cos.puts();
  assert.deepEqual(puts.map(call => call[1]), plan.versioned.map(object => object.key));
  for (const [, , params] of puts) {
    assert.equal(params.Headers['x-cos-forbid-overwrite'], 'true');
    assert.equal(params.CacheControl, 'public, max-age=31536000, immutable');
  }
  assert.ok(puts.every(call => !STABLE_KEYS.includes(call[1])), 'upload never writes stable');
  assert.deepEqual(receipt.objects.map(object => object.file), plan.versioned.map(object => object.file));
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, UPLOAD_RECEIPT), 'utf8')).objects, receipt.objects);
  // A rerun finds every object already public with the planned bytes and writes nothing.
  await f.upload(plan);
  assert.equal(f.cos.puts().length, puts.length);
  // Versioning on: forbid-overwrite would be ignored.
  f.cos.hooks.versioning = { Status: 'Suspended' };
  await assert.rejects(f.upload(plan), /版本控制/);
});

test('an object that appears while uploading is kept only when its public bytes are the planned ones', async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  const report = plan.versioned[2];
  f.cos.hooks.beforePut = params => {
    if (params.Key === report.key) f.cos.objects.set(report.key, { body: Buffer.from(params.Body), contentType: params.ContentType, cacheControl: params.CacheControl });
  };
  await f.upload(plan);
  const g = await fixture(t);
  const other = await g.plan();
  g.cos.hooks.beforePut = params => {
    if (params.Key === other.versioned[2].key) g.cos.objects.set(params.Key, { body: Buffer.from('somebody else'), contentType: params.ContentType, cacheControl: params.CacheControl });
  };
  await assert.rejects(g.upload(other), error => {
    assert.match(error.message, /公网内容不一致/);
    assert.doesNotMatch(error.message, /SIGNED-URL/);
    return true;
  });
  assert.equal(g.cos.puts().some(call => call[1] === other.versioned[3].key), false, 'nothing after the conflict is written');
  await assert.rejects(stat(join(g.dir, UPLOAD_RECEIPT)), { code: 'ENOENT' });
});

test('upload stops at CANCEL before the next write and refuses a file changed since the plan', async t => {
  const f = await fixture(t);
  const plan = await f.plan(), cancel = join(f.root, 'CANCEL');
  f.cos.hooks.beforePut = params => { if (params.Key === plan.versioned[1].key) writeFileSync(cancel, 'stop'); };
  await assert.rejects(f.upload(plan, { cancelFile: cancel }), /CANCEL/);
  assert.equal(f.cos.puts().length, 2);
  await assert.rejects(stat(join(f.dir, UPLOAD_RECEIPT)), { code: 'ENOENT' });
  await rm(cancel);
  await writeFile(join(f.dir, 'manifest.json'), '{}');
  await assert.rejects(f.upload(plan), /manifest\.json 在计划之后被改过/);
  // The public check reads every byte.
  const g = await fixture(t), other = await g.plan();
  await g.upload(other);
  g.cos.objects.get(other.versioned[0].key).body[0] ^= 1;
  await assert.rejects(verifyServerPublic(other.versioned, { fetchImpl: g.cos.fetchImpl }), /公网内容不一致/);
});

test('promote needs the owner confirmation and the plan hash, writes the scripts and then the manifest, and reruns without writing', async t => {
  const f = await fixture(t);
  const plan = await f.plan();
  await f.upload(plan);
  const before = f.cos.puts().length;
  await assert.rejects(f.promote(plan), /owner 对这份候选的确认/);
  await assert.rejects(f.promote(plan, { ownerConfirmation: '发布到 stable', planSHA256: 'not-a-hash' }), /计划哈希/);
  assert.equal(f.cos.puts().length, before, 'nothing written without both');
  const receipt = await f.promote(plan, { ownerConfirmation: '发布到 stable' });
  const stable = f.cos.puts().slice(before);
  assert.deepEqual(stable.map(call => call[1]), STABLE_KEYS);
  for (const [, , params] of stable) assert.equal(params.CacheControl, 'no-cache');
  assert.equal(stable[2][2].Headers['x-cos-forbid-overwrite'], 'true', 'a first stable manifest is never written over another');
  assert.equal(stable[0][2].Headers, undefined);
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.ownerConfirmation, '发布到 stable');
  assert.equal(verifyServerManifest(f.cos.objects.get('bot/server/stable/manifest.json').body, f.forms.base64).version, version);
  // Rerun after success: only checked again, no confirmation needed.
  await f.promote(plan);
  assert.equal(f.cos.puts().length, before + 3);
  assert.equal(JSON.parse(await readFile(join(f.dir, STABLE_RECEIPT), 'utf8')).status, 'published');
});

test('promote writes no stable object at all when the live manifest is no longer the one the owner reviewed', async t => {
  const MANIFEST = 'bot/server/stable/manifest.json', newerScript = Buffer.from('#!/bin/sh\necho 0.9.1\n');
  // A newer server published with the same key (its install.sh with it), or bytes that do not verify.
  for (const live of [f => putLiveManifest(f, '0.9.1', 1_850_000_000_000), f => {
    const body = Buffer.from('someone else');
    f.cos.objects.set(MANIFEST, { body, contentType: 'application/json', cacheControl: 'no-cache' });
    return body;
  }]) {
    const f = await fixture(t);
    const plan = await f.plan();
    await f.upload(plan);
    const body = live(f);
    f.cos.objects.set('bot/server/install.sh', { body: newerScript, contentType: 'text/plain; charset=utf-8', cacheControl: 'no-cache' });
    const before = f.cos.puts().length;
    await assert.rejects(f.promote(plan, { ownerConfirmation: 'ok' }), /owner 看过计划之后变了；服务端 stable 一个对象都没写/);
    assert.equal(f.cos.puts().length, before, 'not one stable object written');
    assert.deepEqual(f.cos.objects.get(MANIFEST).body, body);
    assert.deepEqual(f.cos.objects.get('bot/server/install.sh').body, newerScript);
    assert.equal(f.cos.objects.has('bot/server/uninstall.sh'), false);
    await assert.rejects(stat(join(f.dir, STABLE_RECEIPT)), { code: 'ENOENT' });
  }
  // The manifest is still read again right before its own write: a change after the scripts leaves it alone.
  const g = await fixture(t), other = await g.plan();
  await g.upload(other);
  g.cos.hooks.beforePut = params => { if (params.Key === 'bot/server/uninstall.sh') g.cos.objects.set(MANIFEST, { body: Buffer.from('raced'), contentType: 'application/json', cacheControl: 'no-cache' }); };
  await assert.rejects(g.promote(other, { ownerConfirmation: 'ok' }), /owner 看过计划之后变了；清单没覆盖/);
  assert.equal(g.cos.objects.get(MANIFEST).body.toString(), 'raced');
  assert.deepEqual(g.cos.puts().filter(call => STABLE_KEYS.includes(call[1])).map(call => call[1]), STABLE_KEYS.slice(0, 2));
  // A rerun that finds the manifest already this candidate's still repairs a script.
  const h = await fixture(t), third = await h.plan();
  await h.upload(third);
  await h.promote(third, { ownerConfirmation: 'ok' });
  h.cos.objects.set('bot/server/install.sh', { body: newerScript, contentType: 'text/plain; charset=utf-8', cacheControl: 'no-cache' });
  const written = h.cos.puts().length;
  await h.promote(third, { ownerConfirmation: 'ok' });
  assert.deepEqual(h.cos.puts().slice(written).map(call => call[1]), ['bot/server/install.sh']);
  assert.deepEqual(h.cos.objects.get('bot/server/install.sh').body, h.sources['scripts/install.sh']);
});

test('promote stops at CANCEL before the manifest and refuses scripts not from the release source', async t => {
  const g = await fixture(t), other = await g.plan(), cancel = join(g.root, 'CANCEL');
  await g.upload(other);
  g.cos.hooks.beforePut = params => { if (params.Key === 'bot/server/uninstall.sh') writeFileSync(cancel, 'stop'); };
  await assert.rejects(g.promote(other, { ownerConfirmation: 'ok', cancelFile: cancel }), /CANCEL/);
  assert.equal(g.cos.objects.has('bot/server/stable/manifest.json'), false);
  assert.equal(JSON.parse(await readFile(join(g.dir, STABLE_RECEIPT), 'utf8')).status, 'write-started');
  const h = await fixture(t), third = await h.plan();
  await h.upload(third);
  h.sources['scripts/uninstall.sh'] = Buffer.from('#!/bin/sh\necho changed\n');
  await assert.rejects(h.promote(third, { ownerConfirmation: 'ok' }), /uninstall\.sh 和发布源码 SHA 里的不一样/);
  assert.equal(h.cos.puts().some(call => STABLE_KEYS.includes(call[1])), false);
});

test('cos-server.json names the server prefix and address, credential variables only and an owner-only absolute key file', async t => {
  const f = await fixture(t), path = join(f.root, 'cos-server.json');
  const save = value => writeFile(path, JSON.stringify(value));
  await save(f.config);
  assert.deepEqual(await readServerCosConfig(path), f.config);
  await assert.rejects(readServerCosConfig('cos-server.json'), /绝对路径/);
  for (const bad of [{ prefix: 'bot/windows/' }, { publicBaseURL: 'https://dl.vonvon.cc/bot/server/' }, { secretKey: 'inline' }, { secretIdEnv: 'not a name' }]) {
    await save({ ...f.config, ...bad });
    await assert.rejects(readServerCosConfig(path), /COS|credential/);
  }
  await save({ ...f.config, updatePrivateKeyFile: 'server-update.pem' });
  await assert.rejects(readServerCosConfig(path), /绝对路径/);
  await chmod(f.keyFile, 0o644);
  await save(f.config);
  await assert.rejects(readServerCosConfig(path), /0600/);
});

test('server plan binds packaged mirrors to the release source and rejects an omitted mirror', async t => {
  const f = await fixture(t), mirror = 'https://fixture.workers.dev/bot/server';
  const committed = JSON.parse(f.sources['packages/daemon/server-update.json']);
  f.sources['packages/daemon/server-update.json'] = Buffer.from(JSON.stringify({ ...committed, mirrorBaseURLs: [mirror] }));
  await assert.rejects(f.plan(), /mirrorBaseURLs.*不一致/);
  f.summary.update.mirrorBaseURLs = [mirror];
  await writeFile(join(f.dir, `vonvon-server-${version}-build.json`), JSON.stringify(f.summary));
  assert.deepEqual((await f.plan()).mirrorBaseURLs, [mirror]);
  f.summary.update.mirrorBaseURLs = ['http://invalid.example/bot/server'];
  await writeFile(join(f.dir, `vonvon-server-${version}-build.json`), JSON.stringify(f.summary));
  await assert.rejects(f.plan(), /Invalid server mirrorBaseURLs/);
});

test('server CDN config is explicit and ordinary GET refuses cached or stale mutable bytes', async t => {
  const f = await fixture(t), cdn = { provider: 'tencent', mutablePolicy: 'bypass' };
  const path = join(f.root, 'cos-cdn.json');
  await writeFile(path, JSON.stringify({ ...f.config, cdn }));
  assert.deepEqual((await readServerCosConfig(path)).cdn, cdn);
  await writeFile(path, JSON.stringify({ ...f.config, cdn: { provider: 'tencent', mutablePolicy: 'ttl' } }));
  await assert.rejects(readServerCosConfig(path), /CDN configuration supports only/);
  f.config.cdn = cdn;
  const planned = await f.plan();
  await f.upload(planned);
  const ordinary = async (url, options) => {
    assert.equal(options.cache, undefined);
    assert.equal(options.headers, undefined);
    const response = await f.cos.fetchImpl(url);
    if (url.endsWith('/install.sh') && response.status === 200) response.headers.set('X-Cache-Lookup', 'Cache Hit');
    return response;
  };
  await assert.rejects(f.promote(planned, { ownerConfirmation: 'ok', fetchImpl: ordinary }), /cached mutable response/);
  assert.notEqual(JSON.parse(await readFile(join(f.dir, STABLE_RECEIPT), 'utf8')).status, 'published');
  const fixed = await f.promote(planned, { ownerConfirmation: 'ok' });
  assert.match(fixed.cdn, /腾讯 CDN/);
  const stale = async (url, options) => {
    assert.equal(options.cache, undefined);
    if (url.endsWith('/install.sh')) return new Response('stale script', { headers: { 'content-type': 'text/plain', 'content-length': '12', 'cache-control': 'no-cache' } });
    return f.cos.fetchImpl(url);
  };
  await assert.rejects(f.promote(planned, { ownerConfirmation: 'ok', fetchImpl: stale }), /公网内容不一致/);
});
