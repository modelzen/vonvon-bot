import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishWindowsObjects, validateBuildRun, windowsObjectPlan } from './publish-windows.mjs';

const sourceSha = 'a'.repeat(40), version = '0.7.5';
const bytes = Buffer.from('release fixture');
const evidence = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') };
const inventory = { sourceSha, version, architecture: 'x64', signed: false, updatesEnabled: false,
  artifacts: [
    ['installer', `Vonvon-Bot-${version}-windows-x64.exe`], ['zip', `Vonvon-Bot-${version}-windows-x64.zip`],
    ['blockmap', `Vonvon-Bot-${version}-windows-x64.exe.blockmap`], ['feed', 'latest.yml'],
  ].map(([kind, file]) => ({ kind, file, ...evidence })) };
const fetchImpl = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } });

test('trusts only successful owning-repository Windows workflow runs', () => {
  const run = { repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' }, path: '.github/workflows/windows-release.yml', status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sourceSha };
  assert.equal(validateBuildRun(run), sourceSha);
  for (const change of [{ conclusion: 'failure' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_repository: { full_name: 'other/repo' } }]) assert.throws(() => validateBuildRun({ ...run, ...change }));
});

test('unsigned publication never schedules an update feed or Mac object', () => {
  const objects = windowsObjectPlan(inventory);
  assert.equal(objects.length, 3);
  assert.ok(objects.every(item => item.key.startsWith(`bot/windows/${version}/`)));
  assert.ok(objects.every(item => !item.key.includes('stable') && !item.key.endsWith('latest.yml')));
  assert.throws(() => windowsObjectPlan({ ...inventory, updatesEnabled: true }));
  const changed = structuredClone(inventory); changed.artifacts[0].file = '../escape.exe';
  assert.throws(() => windowsObjectPlan(changed));
});

async function fixture(t, status) {
  const out = await mkdtemp(join(tmpdir(), 'vonvon-windows-publish-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  for (const object of inventory.artifacts) await writeFile(join(out, object.file), bytes);
  const calls = [];
  const client = {
    getBucketVersioning: (params, callback) => callback(null, { VersioningConfiguration: { Status: status } }),
    headObject: (params, callback) => callback({ statusCode: 404 }),
    putObject: (params, callback) => { calls.push(params); callback(null, {}); },
  };
  const config = { bucket: 'example-123', region: 'ap-shanghai' };
  const fetchPublic = async url => {
    const response = await fetchImpl(url);
    response.headers.set('content-type', url.endsWith('.zip') ? 'application/zip' : 'application/octet-stream');
    return response;
  };
  return { out, calls, options: { out, inventory, config, client, fetchImpl: fetchPublic, log: () => {} } };
}

test('publishes only immutable versioned bytes and records complete public verification', async t => {
  const h = await fixture(t);
  const receipt = await publishWindowsObjects(h.options);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(item => item.Headers['x-cos-forbid-overwrite'] === 'true'));
  assert.equal(receipt.objects.length, 3);
  assert.equal(receipt.updatesEnabled, false);
  assert.deepEqual(JSON.parse(await readFile(join(h.out, 'windows-publish-receipt.json'), 'utf8')), receipt);
});

test('refuses versioned buckets and modified local bytes before uploading', async t => {
  const h = await fixture(t, 'Suspended');
  await assert.rejects(publishWindowsObjects(h.options), /versioning/);
  assert.equal(h.calls.length, 0);
  h.options.client.getBucketVersioning = (params, callback) => callback(null, { VersioningConfiguration: {} });
  await writeFile(join(h.out, inventory.artifacts[0].file), 'changed');
  await assert.rejects(publishWindowsObjects(h.options), /Local file changed/);
  assert.equal(h.calls.length, 0);
});

test('existing different public bytes are never overwritten', async t => {
  const h = await fixture(t);
  h.options.client.headObject = (params, callback) => callback(null, {});
  h.options.fetchImpl = async () => new Response('wrong', { headers: { 'content-length': '5', 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } });
  await assert.rejects(publishWindowsObjects(h.options), /size mismatch/);
  assert.equal(h.calls.length, 0);
});
