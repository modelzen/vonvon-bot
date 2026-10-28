import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadBuild, publishWindowsObjects, validateBuildRun, windowsObjectPlan } from './publish-windows.mjs';
import { createWindowsInventory } from './package-windows.mjs';

const sourceSha = 'a'.repeat(40), version = '0.7.6';
const bytes = Buffer.from('release fixture');
const evidence = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64') };
const inventory = { sourceSha, version, architecture: 'x64', signed: false, updatesEnabled: false,
  artifacts: [
    ['installer', `Vonvon-Bot-Setup-${version}-x64.exe`], ['zip', `Vonvon-Bot-${version}-windows-x64.zip`],
    ['blockmap', `Vonvon-Bot-Setup-${version}-x64.exe.blockmap`], ['feed', 'latest.yml'],
  ].map(([kind, file]) => ({ kind, file, ...evidence })) };
const fetchImpl = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' } });

test('trusts only successful owning-repository Windows workflow runs', () => {
  const run = { repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' }, path: '.github/workflows/windows-release.yml', status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sourceSha };
  assert.equal(validateBuildRun(run), sourceSha);
  for (const change of [{ conclusion: 'failure' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_repository: { full_name: 'other/repo' } }]) assert.throws(() => validateBuildRun({ ...run, ...change }));
});

test('pinned dispatch binds source separately from the workflow SHA and accepts only main dispatches', () => {
  const run = { repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' }, path: '.github/workflows/windows-release.yml',
    status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: 'b'.repeat(40), head_branch: 'main',
    display_title: `windows-release ${version} ${sourceSha} 12345678-1234-1234-1234-123456789abc` };
  assert.equal(validateBuildRun(run), sourceSha);
  for (const change of [{ head_branch: 'dev' }, { event: 'push' }, { display_title: 'windows-release incomplete' }, { head_sha: 'short' }]) assert.throws(() => validateBuildRun({ ...run, ...change }));
});

test('pinned source and workflow SHA must both have verified ancestry on main before any artifact download', async () => {
  const workflowSha = 'b'.repeat(40), calls = [];
  const run = { repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' }, path: '.github/workflows/windows-release.yml',
    status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: workflowSha, head_branch: 'main',
    display_title: `windows-release ${version} ${sourceSha} 12345678-1234-1234-1234-123456789abc` };
  const api = async args => {
    calls.push(args[1]);
    if (args[1].includes('/compare/')) {
      const sha = args[1].match(/compare\/([a-f0-9]+)\.\.\./)[1];
      return { status: sha === workflowSha ? 'diverged' : 'ahead', merge_base_commit: { sha } };
    }
    return run;
  };
  await assert.rejects(downloadBuild({ runId: 123, out: '/unused', api, expectedSha: sourceSha, expectedVersion: version }), /not on main/);
  assert.ok(calls.some(path => path.includes(`/compare/${sourceSha}...main`)));
  assert.ok(calls.some(path => path.includes(`/compare/${workflowSha}...main`)));
  await assert.rejects(downloadBuild({ runId: 123, out: '/unused', api, expectedSha: workflowSha }), /expected release SHA/);
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

test('interrupted artifact extraction leaves the final directory clean and retry succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-windows-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'release');
  const name = `windows-unsigned-${version}-${sourceSha.slice(0, 12)}`;
  const api = async args => args[1].includes('/artifacts?') ? { artifacts: [{ id: 123, name, expired: false, digest: 'sha256:abc' }] } : {
    repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' },
    path: '.github/workflows/windows-release.yml', status: 'completed', conclusion: 'success', event: 'push', head_sha: sourceSha, run_attempt: 1,
  };
  const interrupted = async (command, args) => { await writeFile(join(args.at(-1), 'partial'), 'partial'); throw new Error('connection lost'); };
  await assert.rejects(downloadBuild({ runId: 123, out, api, execute: interrupted }), /connection lost/);
  await assert.rejects(access(out));
  const complete = async (command, args) => {
    const dir = args.at(-1), base = `Vonvon-Bot-${version}-windows-x64`, setup = `Vonvon-Bot-Setup-${version}-x64`;
    const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68);
    const sha = createHash('sha512').update(pe).digest('base64');
    await writeFile(join(dir, `${setup}.exe`), pe); await writeFile(join(dir, `${base}.zip`), 'zip');
    await writeFile(join(dir, `${setup}.exe.blockmap`), 'blockmap');
    await writeFile(join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${setup}.exe\n    sha512: ${sha}\n    size: 128\npath: ${setup}.exe\nsha512: ${sha}\n`);
    await createWindowsInventory({ out: dir, version, sourceSha, unpackedExe: join(dir, `${setup}.exe`), zipExe: join(dir, `${setup}.exe`) });
  };
  const verified = await downloadBuild({ runId: 123, out, api, execute: complete });
  assert.equal(verified.sourceSha, sourceSha);
  assert.equal(JSON.parse(await readFile(join(out, 'github-build.json'), 'utf8')).artifactId, 123);
});
