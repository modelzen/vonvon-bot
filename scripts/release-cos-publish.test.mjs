import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLedger, fixReleaseHeaders, NO_CDN, planPublish, promoteRelease, readCosWriteConfig, rollbackRelease, uploadRelease } from './release-cos-publish.mjs';
import { DEFAULT_MANIFEST_URL, validateReleaseInventory, verifyPublicRelease, verifyVersionedRelease } from './verify-public-release.mjs';

// Hermetic: a fake SDK client backed by an in-memory bucket, a fake public endpoint serving that
// bucket, and a fake verify child that runs the real verification functions against it. No network.
const version = '0.7.0', sha = 'a'.repeat(40);
const base = new URL('.', DEFAULT_MANIFEST_URL);
const BUCKET = 'vonvon-dl-1250000000', REGION = 'ap-shanghai', PREFIX = 'bot/mac/stable/';
const SECRETS = { COS_READ_ID: 'SENTINEL-READ-ID', COS_READ_KEY: 'SENTINEL-READ-KEY', COS_WRITE_ID: 'SENTINEL-WRITE-ID', COS_WRITE_KEY: 'SENTINEL-WRITE-KEY' };
const immutable = 'public, max-age=31536000, immutable';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const zipFile = `Vonvon-Bot-${version}-universal.zip`, dmgFile = `Vonvon-Bot-${version}-universal.dmg`, feedFile = `feed-${version}.json`;
const confirm = `确认 ${version} ${sha} 发布到 stable`;
const manifestBytes = v => Buffer.from(JSON.stringify({ version: v, feedURL: new URL(`feed-${v}.json`, base).href }, null, 2) + '\n');
const feedBytes = v => Buffer.from(JSON.stringify({ url: new URL(`Vonvon-Bot-${v}-universal.zip`, base).href, name: `Vonvon Bot ${v}`, notes: 'Release notes.', pub_date: '2026-10-27T00:00:00.000Z' }, null, 2) + '\n');

function evidenceFiles() {
  const files = new Map([
    ['manifest.json', manifestBytes(version)],
    [feedFile, feedBytes(version)],
    [zipFile, Buffer.from('fixture ZIP bytes; not a real archive. '.repeat(40))],
    [dmgFile, Buffer.from('fixture DMG bytes; not a real image. '.repeat(40))],
  ]);
  const record = file => ({ file, size: files.get(file).length, sha256: digest(files.get(file)) });
  const publicFiles = [...files.keys()];
  const inventory = { version, sourceCommit: sha, mode: 'release', complete: true, baseline: 'none', publiclyPublished: false, files: publicFiles.map(record),
    notarization: { app: '11111111-1111-4111-8111-111111111111', dmg: '22222222-2222-4222-8222-222222222222' } };
  files.set('release-inventory.json', Buffer.from(JSON.stringify(inventory, null, 2) + '\n'));
  const state = { context: { version, sourceCommit: sha, mode: 'release', firstRelease: true }, complete: true, files: [...publicFiles, 'release-inventory.json'].map(record) };
  files.set('notarization-state.json', Buffer.from(JSON.stringify(state, null, 2) + '\n'));
  files.set('SHA256SUMS', Buffer.from(state.files.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n'));
  return files;
}

const published069 = () => [
  [`${PREFIX}manifest.json`, { bytes: manifestBytes('0.6.9'), cacheControl: 'no-cache', contentType: 'application/json' }],
  [`${PREFIX}feed-0.6.9.json`, { bytes: feedBytes('0.6.9'), cacheControl: immutable, contentType: 'application/json' }],
  [`${PREFIX}Vonvon-Bot-0.6.9-universal.zip`, { bytes: Buffer.from('old zip'), cacheControl: immutable, contentType: 'application/zip' }],
  [`${PREFIX}Vonvon-Bot-0.6.9-universal.dmg`, { bytes: Buffer.from('old dmg'), cacheControl: immutable, contentType: 'application/x-apple-diskimage' }],
];
const writeMethods = ['putObject', 'putObjectCopy', 'deleteObject'];

async function world(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cos-publish-'));
  assert.ok(basename(root).startsWith('cos-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'evidence');
  await mkdir(out);
  for (const [file, bytes] of evidenceFiles()) await writeFile(join(out, file), bytes);
  const ledgerFile = join(root, 'ledger.json');
  await writeFile(ledgerFile, JSON.stringify({ versions: settings.ledger ?? [] }, null, 2) + '\n', { mode: 0o600 });
  const sdkModule = join(root, 'sdk', 'node_modules', 'cos-nodejs-sdk-v5');
  const readConfigPath = join(root, 'cos-readonly.json'), writeConfigPath = join(root, 'cos-write.json');
  await writeFile(readConfigPath, JSON.stringify({ bucket: BUCKET, region: REGION, prefix: PREFIX, publicManifestURL: DEFAULT_MANIFEST_URL, secretIdEnv: 'COS_READ_ID', secretKeyEnv: 'COS_READ_KEY', sdkModule, ledgerFile }));
  await writeFile(writeConfigPath, JSON.stringify({ bucket: BUCKET, region: REGION, prefix: PREFIX, publicManifestURL: DEFAULT_MANIFEST_URL, secretIdEnv: 'COS_WRITE_ID', secretKeyEnv: 'COS_WRITE_KEY', sdkModule, ...settings.writeConfig }));
  const objects = new Map(settings.objects ?? []);
  const bucket = { versioning: settings.versioning };
  const calls = [], childCalls = [], fetched = [], logs = [];
  const md5 = bytes => createHash('md5').update(bytes).digest('base64');
  const writeClient = {
    getBucketVersioning(params, callback) {
      calls.push({ method: 'getBucketVersioning', params });
      callback(null, { VersioningConfiguration: bucket.versioning ? { Status: bucket.versioning } : {} });
    },
    putObject(params, callback) {
      calls.push({ method: 'putObject', params: { ...params, Body: undefined }, bodySHA256: digest(params.Body) });
      const injected = settings.onPut?.(params, { objects, calls, cancelFile });
      if (injected) return callback(injected);
      if (params.ContentMD5 !== md5(params.Body)) return callback({ statusCode: 400, code: 'InvalidDigest' });
      if (params.Headers?.['x-cos-forbid-overwrite'] === 'true' && objects.has(params.Key)) {
        return callback(Object.assign(new Error('The object already exists; request signed by SENTINEL-WRITE-ID'), { statusCode: 409, code: 'FileAlreadyExists', error: { Code: 'FileAlreadyExists', Message: 'q-sign-algorithm=sha1&q-ak=SENTINEL-WRITE-ID' }, headers: { authorization: 'q-ak=SENTINEL-WRITE-ID' } }));
      }
      objects.set(params.Key, { bytes: Buffer.from(params.Body), cacheControl: settings.storedCacheControl?.(params) ?? params.CacheControl, contentType: params.ContentType });
      callback(null, { statusCode: 200, ETag: '"not-a-content-hash"' });
    },
    putObjectCopy(params, callback) {
      calls.push({ method: 'putObjectCopy', params });
      const source = objects.get(params.Key);
      if (!source || params.CopySource !== `${BUCKET}.cos.${REGION}.myqcloud.com/${params.Key}`) return callback({ statusCode: 404, code: 'NoSuchKey' });
      objects.set(params.Key, { ...source, cacheControl: params.CacheControl, contentType: params.ContentType });
      callback(null, {});
    },
    deleteObject(params, callback) {
      calls.push({ method: 'deleteObject', params });
      objects.delete(params.Key);
      callback(null, { statusCode: 204 });
    },
  };
  const readClient = { getBucket(params, callback) {
    callback(null, { Contents: [...objects.keys()].filter(key => key.startsWith(params.Prefix)).map(Key => ({ Key })), IsTruncated: 'false' });
  } };
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    fetched.push(url);
    const object = objects.get(new URL(url).pathname.slice(1));
    if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'content-type': 'application/xml' } });
    return new Response(object.bytes, { status: 200, headers: { 'content-type': object.contentType ?? 'application/octet-stream', 'cache-control': object.cacheControl ?? '' } });
  };
  const execFile = async (command, args, options) => {
    childCalls.push({ command, args, env: options.env });
    assert.equal(command, process.execPath);
    assert.equal(basename(args[0]), 'verify-public-release.mjs');
    const value = flag => args[args.indexOf(flag) + 1];
    const mode = args.includes('--local-only') ? 'local' : args.includes('--versioned-only') ? 'versioned' : 'full';
    if (settings.verifyOutput?.[mode] !== undefined) return { stdout: settings.verifyOutput[mode], stderr: '' };
    try {
      const params = { out: value('--out'), version: value('--version'), sha: value('--sha'), fetchImpl, env: {} };
      if (mode === 'local') { await validateReleaseInventory(params.out, params); return { stdout: 'Local formal-release evidence verified. No upload or stable switch authorized.\n', stderr: '' }; }
      const report = mode === 'versioned' ? await verifyVersionedRelease(params) : await verifyPublicRelease(params);
      return { stdout: JSON.stringify(report, null, 2) + '\n', stderr: '' };
    } catch (error) {
      throw Object.assign(new Error('Command failed'), { code: 1, stdout: '', stderr: `${error.message}\n` });
    }
  };
  const cancelFile = join(root, 'cancel-task');
  const deps = { env: { PATH: process.env.PATH ?? '', ...SECRETS, ...settings.env }, execArgv: [], fetchImpl, writeClient, readClient, execFile, log: line => logs.push(line) };
  const options = { out, version, sha, 'cos-config': readConfigPath, 'cos-write-config': writeConfigPath };
  const writes = () => calls.filter(call => writeMethods.includes(call.method));
  return {
    root, out, objects, bucket, calls, childCalls, fetched, logs, deps, options, cancelFile, ledgerFile, readConfigPath, writeConfigPath, writes,
    plan: extra => planPublish({ ...options, ...extra }, deps),
    upload: extra => uploadRelease({ ...options, 'cancel-file': cancelFile, ...extra }, deps),
    promote: extra => promoteRelease({ ...options, 'cancel-file': cancelFile, 'owner-confirmation': confirm, ...extra }, deps),
    rollback: extra => rollbackRelease({ ...options, ...extra }, deps),
    fixHeaders: extra => fixReleaseHeaders({ ...options, 'cancel-file': cancelFile, ...extra }, deps),
    ledger: async () => JSON.parse(await readFile(ledgerFile, 'utf8')).versions,
    receipt: async name => JSON.parse(await readFile(join(out, name), 'utf8')),
  };
}
const publishedFirst = async (t, settings) => {
  const w = await world(t, settings);
  const { sha256 } = await w.plan({ 'first-release': true });
  await w.upload({ 'first-release': true, 'plan-sha256': sha256 });
  return { w, hash: sha256 };
};

function assertNoSecrets(text, label) {
  for (const secret of Object.values(SECRETS)) assert.equal(text.includes(secret), false, `${label} contains a credential value`);
  for (const name of Object.keys(SECRETS)) assert.equal(text.includes(name), false, `${label} names a credential variable`);
  assert.equal(text.includes(BUCKET), false, `${label} contains the bucket identity`);
}

test('first release: plan writes nothing, upload writes only versioned objects, promote writes the manifest last', async t => {
  const w = await world(t);
  const planned = await w.plan({ 'first-release': true });
  assert.deepEqual(w.writes(), [], 'plan makes no COS write');
  const planBytes = await readFile(join(w.out, 'publish-plan.json'));
  assert.equal(digest(planBytes), planned.sha256);
  assert.ok(w.logs.includes(`Plan SHA-256: ${planned.sha256}`));
  const plan = JSON.parse(planBytes);
  assert.deepEqual(plan.previousManifest, { url: DEFAULT_MANIFEST_URL, status: 404 });
  assert.equal(plan.gates.baseline, 'none');
  assert.equal(plan.gates.bucketVersioning, 'never enabled');
  assert.deepEqual(plan.upload.map(step => step.key), [zipFile, dmgFile, feedFile].map(file => PREFIX + file));
  assert.deepEqual(plan.upload.map(step => step.headers), [
    { 'Cache-Control': immutable, 'Content-Type': 'application/zip', 'x-cos-forbid-overwrite': 'true' },
    { 'Cache-Control': immutable, 'Content-Type': 'application/x-apple-diskimage', 'x-cos-forbid-overwrite': 'true' },
    { 'Cache-Control': immutable, 'Content-Type': 'application/json', 'x-cos-forbid-overwrite': 'true' },
  ]);
  assert.deepEqual(plan.promote.headers, { 'Cache-Control': 'no-cache', 'Content-Type': 'application/json', 'x-cos-forbid-overwrite': 'true' });
  assert.equal(plan.promote.cdn, NO_CDN);
  assert.equal(plan.rollback.command, 'rollback --delete-first-release-manifest');

  await w.upload({ 'first-release': true, 'plan-sha256': planned.sha256 });
  const uploads = w.writes();
  assert.deepEqual(uploads.map(call => call.params.Key), plan.upload.map(step => step.key));
  for (const [index, call] of uploads.entries()) {
    assert.equal(call.method, 'putObject');
    assert.equal(call.params.Headers['x-cos-forbid-overwrite'], 'true');
    assert.equal(call.params.CacheControl, immutable);
    assert.equal(call.params.ContentType, plan.upload[index].headers['Content-Type']);
    assert.equal(call.bodySHA256, plan.upload[index].sha256);
  }
  assert.equal(w.objects.has(`${PREFIX}manifest.json`), false, 'upload never writes the manifest');
  assert.deepEqual(await w.ledger(), [version]);
  assert.equal((await stat(w.ledgerFile)).mode & 0o777, 0o600);
  const uploadReceipt = await w.receipt('upload-receipt.json');
  assert.equal(uploadReceipt.planSHA256, planned.sha256);
  assert.equal(uploadReceipt.versionedVerification.versionedObjectsVerified, true);
  assert.ok(uploadReceipt.objects.every(object => object.result === 'uploaded'));
  assert.ok(w.logs.some(line => line.includes('"versionedObjectsVerified": true')));

  const before = w.writes().length;
  await w.promote({ 'plan-sha256': planned.sha256 });
  const after = w.writes().slice(before);
  assert.equal(after.length, 1, 'promote writes exactly one object');
  assert.equal(after[0].params.Key, `${PREFIX}manifest.json`);
  assert.equal(after[0].params.CacheControl, 'no-cache');
  assert.equal(after[0].params.ContentType, 'application/json');
  assert.equal(after[0].params.Headers['x-cos-forbid-overwrite'], 'true', 'a first-release manifest may not replace one that appeared meanwhile');
  assert.equal(after[0].bodySHA256, digest(await readFile(join(w.out, 'manifest.json'))));
  assert.equal(w.writes().at(-1), after[0], 'the manifest is the last write');
  const receipt = await w.receipt('publish-receipt.json');
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.ownerConfirmation, confirm);
  assert.deepEqual(receipt.previousManifest, { status: 404 });
  assert.equal(receipt.cdn, NO_CDN);
  assert.equal(receipt.publicVerification.publiclyVerified, true);
  assert.equal(receipt.manifest.sha256, plan.promote.sha256);
  assert.deepEqual(receipt.objects.map(object => object.sha256), plan.upload.map(step => step.sha256));

  for (const call of w.childCalls) {
    for (const name of Object.keys(SECRETS)) assert.equal(name in call.env, false, `${name} reached a verification child`);
    assert.equal(Object.values(call.env).some(value => Object.values(SECRETS).includes(value)), false);
  }
  for (const name of ['publish-plan.json', 'upload-receipt.json', 'publish-receipt.json', 'publish-upload-state.json']) assertNoSecrets(await readFile(join(w.out, name), 'utf8'), name);
  assertNoSecrets(w.logs.join('\n'), 'output');
  await assert.rejects(w.promote({ 'plan-sha256': planned.sha256 }), /already serves this release/);
  await assert.rejects(w.plan(), /greater than the highest/, 'a promoted version cannot be planned again');
});

test('non-first release snapshots the live manifest, replaces it at promote, and restore-previous writes the saved bytes back', async t => {
  const w = await world(t, { objects: published069(), ledger: ['0.6.9'] });
  const oldManifest = manifestBytes('0.6.9');
  await assert.rejects(w.plan({ 'first-release': true }), /cannot replace an existing stable manifest/);
  await assert.rejects(w.plan({ 'no-live-manifest': true }), /requires the public stable manifest to be missing/);
  const { sha256: hash, plan } = await w.plan();
  assert.equal(plan.gates.baseline, '0.6.9');
  assert.equal(plan.gates.highestPublished, '0.6.9');
  assert.deepEqual({ ...plan.previousManifest, bytesBase64: undefined }, { url: DEFAULT_MANIFEST_URL, status: 200, version: '0.6.9', feedURL: new URL('feed-0.6.9.json', base).href, size: oldManifest.length, sha256: digest(oldManifest), bytesBase64: undefined });
  assert.equal(Buffer.from(plan.previousManifest.bytesBase64, 'base64').equals(oldManifest), true);
  assert.equal('x-cos-forbid-overwrite' in plan.promote.headers, false, 'promote replaces the existing manifest');
  assert.equal(plan.rollback.command, 'rollback --restore-previous');
  await w.upload({ 'plan-sha256': hash });
  assert.deepEqual(await w.ledger(), ['0.6.9', version]);
  await w.promote({ 'plan-sha256': hash });
  assert.equal(w.writes().at(-1).params.Key, `${PREFIX}manifest.json`);
  assert.equal(w.writes().at(-1).params.Headers, undefined);
  assert.equal(w.objects.get(`${PREFIX}manifest.json`).bytes.equals(manifestBytes(version)), true);
  assert.equal((await w.receipt('publish-receipt.json')).previousManifest.sha256, digest(oldManifest));

  const before = w.writes().length;
  await w.rollback({ 'plan-sha256': hash, 'restore-previous': true, 'dry-run': true });
  assert.equal(w.writes().length, before, 'dry-run prints only');
  await assert.rejects(w.rollback({ 'plan-sha256': hash, 'delete-first-release-manifest': true }), /applies only when the reviewed plan found no stable manifest/);
  await w.rollback({ 'plan-sha256': hash, 'restore-previous': true });
  const restore = w.writes().slice(before);
  assert.equal(restore.length, 1);
  assert.deepEqual([restore[0].method, restore[0].params.Key, restore[0].params.CacheControl, restore[0].params.ContentType], ['putObject', `${PREFIX}manifest.json`, 'no-cache', 'application/json']);
  assert.equal(w.objects.get(`${PREFIX}manifest.json`).bytes.equals(oldManifest), true);
  for (const file of [zipFile, dmgFile, feedFile]) assert.ok(w.objects.has(PREFIX + file), 'versioned objects stay');
  assert.deepEqual(await w.ledger(), ['0.6.9', version], 'the ledger stays');
  const receipt = await w.receipt('rollback-receipt.json');
  assert.equal(receipt.action, 'restored');
  assert.deepEqual(receipt.after, { status: 200, sha256: digest(oldManifest) });
  await assert.rejects(w.promote({ 'plan-sha256': hash }), /rolled back; a fix must be a new, higher version/);
});

test('first-release withdrawal deletes only manifest.json and confirms HTTP 404', async t => {
  const { w, hash } = await publishedFirst(t);
  await w.promote({ 'plan-sha256': hash });
  await assert.rejects(w.rollback({ 'plan-sha256': hash, 'restore-previous': true }), /saved no previous manifest/);
  await assert.rejects(w.rollback({ 'plan-sha256': hash }), /exactly one/);
  const before = w.writes().length;
  await w.rollback({ 'plan-sha256': hash, 'delete-first-release-manifest': true });
  const removal = w.writes().slice(before);
  assert.deepEqual(removal.map(call => [call.method, call.params.Key]), [['deleteObject', `${PREFIX}manifest.json`]]);
  assert.equal(w.objects.has(`${PREFIX}manifest.json`), false);
  for (const file of [zipFile, dmgFile, feedFile]) assert.ok(w.objects.has(PREFIX + file));
  assert.deepEqual(await w.ledger(), [version]);
  assert.equal((await w.receipt('rollback-receipt.json')).action, 'deleted');
  await w.rollback({ 'plan-sha256': hash, 'delete-first-release-manifest': true });
  assert.equal(w.writes().length, before + 1, 'a repeated withdrawal writes nothing');
});

test('local evidence gates stop plan before any request or COS call', async t => {
  for (const [name, damage, error] of [
    ['rehearsal marker', w => writeFile(join(w.out, 'DO-NOT-PUBLISH'), 'rehearsal'), /Rehearsal/],
    ['changed bytes', w => writeFile(join(w.out, zipFile), 'tampered'), /bytes do not match/],
    ['missing file', w => unlink(join(w.out, dmgFile)), /ENOENT|no such file/],
    ['extra SHA256SUMS entry', async w => writeFile(join(w.out, 'SHA256SUMS'), (await readFile(join(w.out, 'SHA256SUMS'), 'utf8')) + `${'b'.repeat(64)}  extra.zip\n`), /SHA256SUMS does not cover/],
    ['extra inventory file', async w => {
      const inventory = JSON.parse(await readFile(join(w.out, 'release-inventory.json'), 'utf8'));
      inventory.files.push({ file: 'extra.zip', size: 1, sha256: 'b'.repeat(64) });
      await writeFile(join(w.out, 'release-inventory.json'), JSON.stringify(inventory));
    }, /exactly the four/],
    ['another source SHA', async w => {
      const state = JSON.parse(await readFile(join(w.out, 'notarization-state.json'), 'utf8'));
      state.context.sourceCommit = 'b'.repeat(40);
      await writeFile(join(w.out, 'notarization-state.json'), JSON.stringify(state));
    }, /complete formal release matching/],
  ]) await t.test(name, async t2 => {
    const w = await world(t2);
    await damage(w);
    await assert.rejects(w.plan({ 'first-release': true }), error);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, []);
    assert.deepEqual(w.childCalls, [], 'the in-process gate runs before the verify child');
    await assert.rejects(readFile(join(w.out, 'publish-plan.json')), { code: 'ENOENT' });
  });
});

test('bucket versioning Enabled or Suspended stops plan and upload before any write', async t => {
  for (const status of ['Enabled', 'Suspended']) await t.test(status, async t2 => {
    const w = await world(t2, { versioning: status });
    await assert.rejects(w.plan({ 'first-release': true }), new RegExp(`versioning is ${status}`));
    assert.deepEqual(w.writes(), []);
    w.bucket.versioning = undefined;
    const { sha256 } = await w.plan({ 'first-release': true });
    w.bucket.versioning = status;
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /versioning/);
    assert.deepEqual(w.writes(), []);
  });
});

test('a resumed upload reuses identical existing bytes and stops on different bytes', async t => {
  await t.test('identical bytes are reused without overwriting', async t2 => {
    let failDMG = true;
    const w = await world(t2, { onPut: params => params.Key.endsWith('.dmg') && failDMG ? { statusCode: 503, code: 'ServiceUnavailable', message: 'signature SENTINEL-WRITE-KEY' } : undefined });
    const { sha256 } = await w.plan({ 'first-release': true });
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), error => /HTTP 503 \(ServiceUnavailable\)/.test(error.message) && !error.message.includes('SENTINEL'));
    assert.deepEqual(await w.ledger(), [], 'no ledger entry before --versioned-only passes');
    failDMG = false;
    await w.upload({ 'first-release': true, 'plan-sha256': sha256 });
    const receipt = await w.receipt('upload-receipt.json');
    assert.deepEqual(receipt.objects.map(object => object.result), ['reused-existing', 'uploaded', 'uploaded']);
    assert.ok(w.fetched.includes(new URL(zipFile, base).href), 'reuse is decided by the public bytes');
    assert.deepEqual(await w.ledger(), [version]);
  });
  await t.test('different bytes stop without overwriting', async t2 => {
    let failDMG = true;
    const w = await world(t2, { onPut: params => params.Key.endsWith('.dmg') && failDMG ? { statusCode: 500 } : undefined });
    const { sha256 } = await w.plan({ 'first-release': true });
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /HTTP 500/);
    failDMG = false;
    w.objects.set(PREFIX + zipFile, { ...w.objects.get(PREFIX + zipFile), bytes: Buffer.from('someone else\'s bytes') });
    const before = w.writes().length;
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /already exists with different bytes/);
    assert.deepEqual(w.writes().slice(before).map(call => call.params.Key), [PREFIX + zipFile], 'nothing after the conflicting object');
    assert.equal(w.objects.get(PREFIX + zipFile).bytes.toString(), 'someone else\'s bytes');
    await assert.rejects(readFile(join(w.out, 'upload-receipt.json')), { code: 'ENOENT' });
  });
  await t.test('this version in COS without this output\'s upload record is investigated', async t2 => {
    const w = await world(t2, { objects: [[PREFIX + zipFile, { bytes: Buffer.from('x'), cacheControl: immutable }]] });
    await assert.rejects(w.plan({ 'first-release': true }), /no upload record/);
    const ledgerOnly = await world(t2, { ledger: [version] });
    await assert.rejects(ledgerOnly.plan({ 'first-release': true }), /no upload record/);
  });
});

test('plan hash, plan file and cancel file are checked before every write', async t => {
  await t.test('a different plan hash uploads nothing', async t2 => {
    const w = await world(t2);
    await w.plan({ 'first-release': true });
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': 'c'.repeat(64) }), /differs from --plan-sha256/);
    await assert.rejects(w.upload({ 'first-release': true }), /--plan-sha256/);
    await assert.rejects(w.upload({ 'plan-sha256': 'c'.repeat(64) }), /First release requires/, 'upload flags must match the plan rules');
    assert.deepEqual(w.writes(), []);
  });
  await t.test('an edited plan file uploads nothing', async t2 => {
    const w = await world(t2);
    const { sha256 } = await w.plan({ 'first-release': true });
    await writeFile(join(w.out, 'publish-plan.json'), '{}\n');
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /publish-plan\.json differs/);
    assert.deepEqual(w.writes(), []);
  });
  await t.test('a cancel file stops upload before the first and before the next object', async t2 => {
    const w = await world(t2);
    const { sha256 } = await w.plan({ 'first-release': true });
    await writeFile(w.cancelFile, 'cancel');
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /Cancel file exists/);
    assert.deepEqual(w.writes(), []);
    await unlink(w.cancelFile);
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256, 'cancel-file': undefined }), /--cancel-file/);
  });
  await t.test('a cancel file created mid-upload stops before the next object', async t2 => {
    const w = await world(t2);
    const { sha256 } = await w.plan({ 'first-release': true });
    const put = w.deps.writeClient.putObject;
    w.deps.writeClient.putObject = (params, callback) => put(params, async (error, data) => { await writeFile(w.cancelFile, 'cancel'); callback(error, data); });
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /Cancel file exists; stopped before uploading Vonvon-Bot-0\.7\.0-universal\.dmg/);
    assert.deepEqual(w.writes().map(call => call.params.Key), [PREFIX + zipFile]);
  });
  await t.test('a cancel file stops promote before the manifest', async t2 => {
    const { w, hash } = await publishedFirst(t2);
    const before = w.writes().length;
    await writeFile(w.cancelFile, 'cancel');
    await assert.rejects(w.promote({ 'plan-sha256': hash }), /Cancel file exists/);
    assert.equal(w.writes().length, before);
    assert.equal(w.objects.has(`${PREFIX}manifest.json`), false);
  });
});

test('promote stops when the live manifest changed after the plan', async t => {
  await t.test('a manifest appeared before a first-release promote', async t2 => {
    const { w, hash } = await publishedFirst(t2);
    w.objects.set(`${PREFIX}manifest.json`, { bytes: manifestBytes('0.6.9'), cacheControl: 'no-cache', contentType: 'application/json' });
    const before = w.writes().length;
    await assert.rejects(w.promote({ 'plan-sha256': hash }), /changed since the reviewed plan/);
    assert.equal(w.writes().length, before);
  });
  await t.test('the previous manifest bytes changed', async t2 => {
    const w = await world(t2, { objects: published069(), ledger: ['0.6.9'] });
    const { sha256 } = await w.plan();
    await w.upload({ 'plan-sha256': sha256 });
    w.objects.set(`${PREFIX}manifest.json`, { bytes: Buffer.from(JSON.stringify({ version: '0.6.9', feedURL: new URL('feed-0.6.9.json', base).href })), cacheControl: 'no-cache', contentType: 'application/json' });
    const before = w.writes().length;
    await assert.rejects(w.promote({ 'plan-sha256': sha256 }), /changed since the reviewed plan/);
    assert.equal(w.writes().length, before);
  });
  await t.test('a manifest racing in after the snapshot is not overwritten', async t2 => {
    const { w, hash } = await publishedFirst(t2);
    const put = w.deps.writeClient.putObject;
    w.deps.writeClient.putObject = (params, callback) => {
      if (params.Key.endsWith('manifest.json')) w.objects.set(params.Key, { bytes: manifestBytes('0.6.9'), cacheControl: 'no-cache', contentType: 'application/json' });
      put(params, callback);
    };
    await assert.rejects(w.promote({ 'plan-sha256': hash }), /appeared after the snapshot; nothing was overwritten/);
    assert.equal(w.objects.get(`${PREFIX}manifest.json`).bytes.equals(manifestBytes('0.6.9')), true);
  });
  await t.test('promote requires a completed upload for this plan', async t2 => {
    const w = await world(t2);
    const { sha256 } = await w.plan({ 'first-release': true });
    await assert.rejects(w.promote({ 'plan-sha256': sha256 }), /upload-receipt\.json is missing/);
    assert.deepEqual(w.writes(), []);
  });
});

test('verification that exits 0 without its success output is a failure', async t => {
  await t.test('--local-only without its line', async t2 => {
    const w = await world(t2, { verifyOutput: { local: 'Local evidence looked fine\n' } });
    await assert.rejects(w.plan({ 'first-release': true }), /did not print "Local formal-release evidence verified\."/);
    await assert.rejects(readFile(join(w.out, 'publish-plan.json')), { code: 'ENOENT' });
  });
  await t.test('--versioned-only without "versionedObjectsVerified": true', async t2 => {
    const w = await world(t2);
    const { sha256 } = await w.plan({ 'first-release': true });
    const realExec = w.deps.execFile;
    for (const output of ['', '{"versionedObjectsVerified": false}\n', JSON.stringify({ version, sourceCommit: sha, versionedObjectsVerified: 'true' }, null, 2),
      JSON.stringify({ version: '0.6.9', sourceCommit: sha, versionedObjectsVerified: true }, null, 2)]) {
      w.deps.execFile = async (command, args, options) => args.includes('--versioned-only') ? { stdout: output } : realExec(command, args, options);
      await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /did not print "versionedObjectsVerified": true/, output);
    }
    assert.deepEqual(await w.ledger(), []);
    await assert.rejects(readFile(join(w.out, 'upload-receipt.json')), { code: 'ENOENT' });
  });
  await t.test('full verification failure keeps the manifest, prints the rollback and exits nonzero', async t2 => {
    const { w, hash } = await publishedFirst(t2, { verifyOutput: { full: 'all good\n' } });
    await assert.rejects(w.promote({ 'plan-sha256': hash }), /Public verification failed after writing the stable manifest/);
    const receipt = await w.receipt('publish-receipt.json');
    assert.equal(receipt.status, 'manifest-written-public-verification-failed');
    assert.equal(receipt.publicVerification.publiclyVerified, false);
    assert.equal(w.writes().at(-1).params.Key, `${PREFIX}manifest.json`, 'no automatic rollback after the manifest write');
    assert.ok(w.objects.has(`${PREFIX}manifest.json`));
    const command = w.logs.find(line => line.includes(' rollback --delete-first-release-manifest '));
    assert.ok(command && command.includes(`--plan-sha256 ${hash}`));
  });
});

test('owner confirmation must be given verbatim and name the version, exact SHA and 发布到 stable', async t => {
  const { w, hash } = await publishedFirst(t);
  const before = w.writes().length;
  for (const text of [undefined, '', `${version} 发布到 stable`, `${version} ${sha.slice(0, 12)} 发布到 stable`, `${version} ${sha}`, `0.7.01 ${sha} 发布到 stable`]) {
    await assert.rejects(w.promote({ 'plan-sha256': hash, 'owner-confirmation': text }), /owner/, String(text));
  }
  assert.equal(w.writes().length, before);
  await assert.rejects(w.promote({ 'plan-sha256': hash, 'first-release': true }), /promote does not take --first-release/);
  await w.promote({ 'plan-sha256': hash, 'owner-confirmation': `版本 ${version}，源码 ${sha}，发布到 stable。` });
});

test('credential settings are environment variable names in a separate, matching write configuration', async t => {
  const read = value => async () => value;
  const valid = { bucket: BUCKET, region: REGION, prefix: PREFIX, publicManifestURL: DEFAULT_MANIFEST_URL, secretIdEnv: 'COS_WRITE_ID', secretKeyEnv: 'COS_WRITE_KEY', sdkModule: '/tools/node_modules/cos-nodejs-sdk-v5' };
  assert.deepEqual(await readCosWriteConfig('/external/cos-write.json', { readJSON: read(valid) }), valid);
  for (const [config, error] of [
    [{ ...valid, secretKeyEnv: 'AKIDliteralSecretValue0123' }, /environment variable names/],
    [{ ...valid, secretKey: 'SENTINEL-WRITE-KEY' }, /unexpected fields/],
    [{ ...valid, secretIdEnv: undefined }, /environment variable names/],
    [{ ...valid, prefix: 'bot/mac/beta/' }, /stable bucket/],
    [{ ...valid, cdn: { domain: 'dl.vonvon.cc' } }, /CDN refresh is not implemented/],
  ]) {
    await assert.rejects(readCosWriteConfig('/external/cos-write.json', { readJSON: read(config) }), caught => {
      assert.match(caught.message, error);
      assert.doesNotMatch(caught.message, /AKID|SENTINEL/);
      return true;
    });
  }
  await assert.rejects(readCosWriteConfig('relative.json', { readJSON: read(valid) }), /absolute --cos-write-config/);
  for (const [name, writeConfig, error] of [
    ['another bucket', { bucket: 'other-1250000000' }, /same stable bucket/],
    ['shared variable names', { secretIdEnv: 'COS_READ_ID', secretKeyEnv: 'COS_READ_KEY' }, /separate from the read-only/],
  ]) await t.test(name, async t2 => {
    const w = await world(t2, { writeConfig });
    await assert.rejects(w.plan({ 'first-release': true }), error);
    assert.deepEqual(w.calls, []);
    assert.deepEqual(w.fetched, []);
  });
  await t.test('the same key in both roles', async t2 => {
    const w = await world(t2, { env: { COS_WRITE_ID: SECRETS.COS_READ_ID } });
    await assert.rejects(w.plan({ 'first-release': true }), /different sub-account/);
  });
  await t.test('SDK errors never echo credentials or signatures', async t2 => {
    const w = await world(t2, { onPut: () => ({ statusCode: 403, code: 'SignatureDoesNotMatch', message: 'StringToSign q-ak=SENTINEL-WRITE-ID', error: { Code: 'SignatureDoesNotMatch', StringToSign: 'SENTINEL-WRITE-KEY' }, url: `https://${BUCKET}.cos.${REGION}.myqcloud.com/` }) });
    const { sha256 } = await w.plan({ 'first-release': true });
    await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), error => {
      assert.match(error.message, /HTTP 403 \(SignatureDoesNotMatch\)/);
      assertNoSecrets(error.message, 'error');
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test('TLS trust-store overrides stop every subcommand before any request', async t => {
  for (const extra of [{ NODE_EXTRA_CA_CERTS: '/fixture/ca.pem' }, { SSL_CERT_FILE: '/fixture/ca.pem' }, { SSL_CERT_DIR: '/fixture/certs' }, { NODE_USE_SYSTEM_CA: '1' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { NODE_OPTIONS: '--use-openssl-ca' }, { NODE_OPTIONS: '--import ./hook.mjs' }]) {
    await t.test(JSON.stringify(extra), async t2 => {
      const w = await world(t2, { env: extra });
      const hash = 'c'.repeat(64);
      for (const run of [() => w.plan({ 'first-release': true }), () => w.upload({ 'first-release': true, 'plan-sha256': hash }), () => w.promote({ 'plan-sha256': hash }),
        () => w.rollback({ 'plan-sha256': hash, 'restore-previous': true }), () => w.fixHeaders({ 'plan-sha256': hash })]) await assert.rejects(run(), /TLS verification/);
      assert.deepEqual(w.calls, []);
      assert.deepEqual(w.fetched, []);
      assert.deepEqual(w.childCalls, []);
    });
  }
  await t.test('Node preload flags', async t2 => {
    const w = await world(t2);
    await assert.rejects(planPublish({ ...w.options, 'first-release': true }, { ...w.deps, execArgv: ['--require', './hook.cjs'] }), /TLS verification/);
    assert.deepEqual(w.fetched, []);
  });
});

test('ledger append is idempotent, keeps 0600 and stops on an interrupted write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cos-ledger-'));
  assert.ok(basename(root).startsWith('cos-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ledger.json');
  await writeFile(file, JSON.stringify({ versions: ['0.6.9'], note: 'kept' }));
  assert.equal(await appendLedger(file, '0.7.0'), 'appended');
  assert.equal(await appendLedger(file, '0.7.0'), 'already-recorded');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { versions: ['0.6.9', '0.7.0'], note: 'kept' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await writeFile(`${file}.new`, 'partial');
  await assert.rejects(appendLedger(file, '0.7.1'), /\.new already exists: an earlier write was interrupted/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).versions, ['0.6.9', '0.7.0']);
  await assert.rejects(appendLedger(file, '0.7'), /invalid/);
});

test('fix-headers replaces metadata in place and re-verifies the full SHA-256', async t => {
  const w = await world(t, { storedCacheControl: () => 'max-age=60' });
  const { sha256 } = await w.plan({ 'first-release': true });
  await assert.rejects(w.upload({ 'first-release': true, 'plan-sha256': sha256 }), /--versioned-only failed: Versioned objects require Cache-Control/);
  assert.deepEqual(await w.ledger(), []);
  const bytesBefore = [zipFile, dmgFile, feedFile].map(file => digest(w.objects.get(PREFIX + file).bytes));
  const before = w.writes().length;
  await w.fixHeaders({ 'plan-sha256': sha256 });
  const copies = w.writes().slice(before);
  assert.deepEqual(copies.map(call => call.method), ['putObjectCopy', 'putObjectCopy', 'putObjectCopy']);
  for (const call of copies) {
    assert.equal(call.params.MetadataDirective, 'Replaced');
    assert.equal(call.params.CopySource, `${BUCKET}.cos.${REGION}.myqcloud.com/${call.params.Key}`);
    assert.equal(call.params.CacheControl, immutable);
    assert.notEqual(call.params.Key, `${PREFIX}manifest.json`);
  }
  assert.deepEqual([zipFile, dmgFile, feedFile].map(file => digest(w.objects.get(PREFIX + file).bytes)), bytesBefore);
  assert.equal(w.objects.get(PREFIX + feedFile).contentType, 'application/json');
  assert.deepEqual(await w.ledger(), [version]);
  assert.equal((await w.receipt('fix-headers-receipt.json')).versionedVerification.versionedObjectsVerified, true);
  assert.ok(w.logs.includes('Run upload again with the same plan to record upload-receipt.json before promote.'));
  await w.upload({ 'first-release': true, 'plan-sha256': sha256 });
  assert.ok((await w.receipt('upload-receipt.json')).objects.every(object => object.result === 'reused-existing'));
  await w.promote({ 'plan-sha256': sha256 });
  assert.equal((await w.receipt('publish-receipt.json')).status, 'published');
});

test('version gate: history above the release or a mismatched first-release flag stops the plan', async t => {
  const higher = await world(t, { ledger: ['0.7.1'] });
  await assert.rejects(higher.plan({ 'no-live-manifest': true }), /greater than the highest previously published/);
  const history = await world(t, { objects: published069().slice(1), ledger: ['0.6.9'] });
  await assert.rejects(history.plan({ 'first-release': true }), /--no-live-manifest/);
  const { plan } = await history.plan({ 'no-live-manifest': true });
  assert.deepEqual(plan.gates.baseline, { live: 'none', highestPublished: '0.6.9' });
  assert.equal(plan.rollback.command, 'rollback --delete-first-release-manifest');
  const listed = await world(t, { objects: [[`${PREFIX}manifest.json`, { bytes: Buffer.from('{}') }]] });
  listed.deps.fetchImpl = async () => new Response('', { status: 404 });
  await assert.rejects(listed.plan({ 'first-release': true }), /still lists manifest\.json/);
  assert.deepEqual(listed.writes(), []);
});

test('plan runs the real verify-public-release --local-only child without credentials', async t => {
  const w = await world(t);
  const { execFile: _fake, ...deps } = w.deps;
  const { sha256 } = await planPublish({ ...w.options, 'first-release': true }, deps);
  assert.match(sha256, /^[a-f0-9]{64}$/);
});

test('the stable confirmation rule is kept word for word in AGENTS.md, SKILL.md and workflow.md', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const agents = await read('../AGENTS.md');
  const rule = agents.match(/\*\*切 stable manifest 的确认只认一种：[^*]+\*\*/)?.[0];
  assert.ok(rule, 'AGENTS.md states the stable confirmation rule');
  const skill = await read('../.agents/skills/release-mac/SKILL.md');
  const workflow = await read('../.agents/skills/release-mac/references/workflow.md');
  for (const [name, text] of [['SKILL.md', skill], ['workflow.md', workflow]]) {
    assert.ok(text.includes(rule), `${name} keeps the rule verbatim`);
    assert.equal(/尚未实现/.test(text), false, `${name} no longer says the writer is missing`);
    assert.ok(text.includes('scripts/release-cos-publish.mjs'), `${name} names the publishing tool`);
  }
  for (const command of ['plan', 'upload', 'promote', 'rollback --restore-previous', 'rollback --delete-first-release-manifest', 'fix-headers']) assert.ok(workflow.includes(command), `workflow.md documents ${command}`);
});

test('CLI explains every subcommand and fails closed through a symlinked directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cos-publish-cli-'));
  assert.ok(basename(root).startsWith('cos-publish-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'alias'), 'dir');
  const run = (args, env = {}) => spawnSync(process.execPath, [join(root, 'alias', 'release-cos-publish.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const command of ['plan ', 'upload ', 'promote ', 'rollback ', 'fix-headers ', '--owner-confirmation', '--cancel-file', '--plan-sha256', '--cos-write-config']) assert.ok(help.stdout.includes(command), command);
  for (const args of [[], ['publish'], ['plan', 'upload']]) {
    const usage = run(args);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Use one subcommand/);
  }
  const gated = run(['plan', '--out', join(root, 'evidence'), '--version', version, '--sha', sha], { SSL_CERT_FILE: '/fixture/ca.pem' });
  assert.equal(gated.status, 1);
  assert.match(gated.stderr, /TLS verification/);
  const missing = run(['upload', '--out', join(root, 'evidence'), '--version', version, '--sha', sha, '--owner-confirmation', 'x']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /upload does not take --owner-confirmation/);
});
