import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readWindowsCosConfig, downloadBuild, publishWindowsObjects, validateBuildRun, windowsObjectPlan, planWindowsUpdates, promoteWindowsUpdates } from './publish-windows.mjs';
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

test('Windows publish CLI executes through a symlinked directory instead of silently exiting', async t => {
  const root = await mkdtemp(join(tmpdir(), 'windows-publish-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(dirname(fileURLToPath(import.meta.url)), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const script = join(root, 'alias', 'publish-windows.mjs');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0); assert.match(help.stdout, /Downloads a successful trusted Windows Actions artifact/);
  const invalid = spawnSync(process.execPath, [script, '--download-only'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /dedicated --out/);
});

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

test('CANCEL appearing during one upload prevents the next object and success receipt', async t => {
  const h = await fixture(t), cancelFile = join(h.out, 'CANCEL');
  const put = h.options.client.putObject;
  h.options.client.putObject = (params, callback) => {
    put(params, async error => {
      await writeFile(cancelFile, 'stop');
      callback(error, {});
    });
  };
  await assert.rejects(publishWindowsObjects({ ...h.options, cancelFile }), /stopped by CANCEL/);
  assert.equal(h.calls.length, 1);
  await assert.rejects(access(join(h.out, 'windows-publish-receipt.json')));
});

test('a present or relative cancellation path prevents all publication requests', async t => {
  const h = await fixture(t), cancelFile = join(h.out, 'CANCEL');
  h.options.client.getBucketVersioning = () => assert.fail('no COS operation after cancellation');
  await writeFile(cancelFile, 'stop');
  await assert.rejects(publishWindowsObjects({ ...h.options, cancelFile }), /stopped by CANCEL/);
  await assert.rejects(publishWindowsObjects({ ...h.options, cancelFile: 'CANCEL' }), /absolute --cancel-file/);
  assert.equal(h.calls.length, 0);
});

test('interrupted artifact extraction leaves the final directory clean and retry succeeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-windows-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'release');
  const name = `windows-unsigned-${version}-${sourceSha.slice(0, 12)}`;
  const env = { PATH: '/bin', NO_PROXY: '.local' };
  const api = async (args, apiEnv) => {
    assert.deepEqual(apiEnv, env);
    return args[1].includes('/artifacts?') ? { artifacts: [{ id: 123, name, expired: false, digest: 'sha256:abc' }] } : {
    repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' },
    path: '.github/workflows/windows-release.yml', status: 'completed', conclusion: 'success', event: 'push', head_sha: sourceSha, run_attempt: 1,
  }; };
  const downloadEnvironment = async original => {
    assert.deepEqual(original, env);
    return { ...original, HTTPS_PROXY: 'http://proxy.example:8080' };
  };
  const interrupted = async (command, args, options) => {
    assert.equal(options.env.HTTPS_PROXY, 'http://proxy.example:8080');
    assert.equal(options.env.NO_PROXY, '.local'); assert.equal(options.timeout, 15 * 60_000);
    await writeFile(join(args.at(-1), 'partial'), 'partial');
    throw new Error('connection lost https://secret.example/?token=fixture-secret');
  };
  await assert.rejects(downloadBuild({ runId: 123, out, env, api, execute: interrupted, downloadEnvironment }), error => {
    assert.match(error.message, /network route.*same release and run/);
    assert.doesNotMatch(error.message, /fixture-secret|secret.example/);
    return true;
  });
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
  const verified = await downloadBuild({ runId: 123, out, env, api, execute: complete, downloadEnvironment });
  assert.equal(verified.sourceSha, sourceSha);
  assert.equal(JSON.parse(await readFile(join(out, 'github-build.json'), 'utf8')).artifactId, 123);
  const reused = await downloadBuild({ runId: 123, out, env, api,
    downloadEnvironment: async () => assert.fail('verified downloads do not resolve or use the network route again'),
    execute: async () => assert.fail('verified artifact must be reused') });
  assert.deepEqual(reused, verified);
});

test('an overlong GitHub artifact download fails with a bounded, redacted recovery instruction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-windows-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = `windows-unsigned-${version}-${sourceSha.slice(0, 12)}`, out = join(root, 'release');
  const api = async args => args[1].includes('/artifacts?') ? { artifacts: [{ id: 123, name, expired: false }] } : {
    repository: { full_name: 'modelzen/vonvon-bot' }, head_repository: { full_name: 'modelzen/vonvon-bot' },
    path: '.github/workflows/windows-release.yml', status: 'completed', conclusion: 'success', event: 'push', head_sha: sourceSha,
  };
  await assert.rejects(downloadBuild({ runId: 123, out, api, downloadEnvironment: async env => env,
    execute: async (command, args, options) => {
      assert.equal(options.timeout, 900000);
      throw Object.assign(new Error('secret proxy diagnostic'), { killed: true });
    } }), error => {
    assert.match(error.message, /exceeded 15 minutes.*resume the same release and run/);
    assert.doesNotMatch(error.message, /secret proxy/);
    return true;
  });
  await assert.rejects(access(out));
});


async function updateFixture(t) {
  const out = await mkdtemp(join(tmpdir(), 'windows-feed-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519'), keyFile = join(out, 'private.pem');
  await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const modern = { ...inventory, format: 2, architecture: 'x64+arm64', updatesEnabled: true,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), artifacts: ['x64', 'arm64'].flatMap(arch =>
      inventory.artifacts.filter(item => item.kind !== 'zip').map(item => ({ ...item, file: item.file.replace('x64', arch).replace('latest.yml', arch === 'arm64' ? 'latest-arm64.yml' : 'latest.yml') }))) };
  const store = new Map(), writes = [];
  for (const artifact of modern.artifacts) { await writeFile(join(out, artifact.file), bytes); if (artifact.kind !== 'feed') store.set(`https://dl.vonvon.cc/bot/windows/${version}/${artifact.file}`, bytes); }
  const fetchPublic = async url => store.has(url) ? new Response(store.get(url), { headers: { 'content-length': String(store.get(url).length),
    'content-type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'cache-control': url.endsWith('.json') ? 'no-cache' : 'public,max-age=31536000,immutable' } }) : new Response(null, { status: 404 });
  const options = { out, inventory: modern, privateKeyFile: keyFile, fetchImpl: fetchPublic };
  const feeds = await planWindowsUpdates(options);
  const client = { putObject: (params, callback) => { writes.push(params); store.set(`https://dl.vonvon.cc/${params.Key}`, params.Body); callback(null, {}); } };
  return { ...options, feeds, config: { bucket: 'fixture-123', region: 'ap-shanghai', updatePrivateKeyFile: keyFile }, client, store, writes, planSHA256: 'a'.repeat(64) };
}

test('signed Windows feeds are separate per architecture, reviewed last, and idempotent on resume', async t => {
  const h = await updateFixture(t);
  assert.equal(windowsObjectPlan(h.inventory).length, 4, 'only two installers and blockmaps are immutable downloads');
  assert.deepEqual(h.feeds.map(item => item.architecture), ['x64', 'arm64']);
  assert.ok(h.feeds.every(item => item.previous.status === 404 && item.url.endsWith(`/${item.architecture}/update.json`)));
  await assert.rejects(promoteWindowsUpdates(h), /owner confirmation/); assert.equal(h.writes.length, 0);
  const receipt = await promoteWindowsUpdates({ ...h, ownerConfirmation: '发布当前候选' });
  assert.equal(receipt.feeds.length, 2); assert.equal(receipt.updatesEnabled, true); assert.equal(h.writes.length, 2);
  assert.ok(h.writes.every(item => item.CacheControl === 'no-cache' && item.Headers['x-cos-forbid-overwrite'] === 'true'));
  assert.equal(JSON.parse(await readFile(join(h.out, 'windows-update-publish-receipt.json'), 'utf8')).status, 'published');
  await promoteWindowsUpdates(h); assert.equal(h.writes.length, 2, 'resume verifies rather than rewrites the same signed bytes');
});

test('Windows stable refuses changed signed bytes, changed live snapshot, or unpublished installer', async t => {
  const h = await updateFixture(t);
  h.store.set(h.feeds[0].url, Buffer.from('unexpected live feed'));
  await assert.rejects(promoteWindowsUpdates({ ...h, ownerConfirmation: '确认' }), /changed since review/); assert.equal(h.writes.length, 0);
  const g = await updateFixture(t); await writeFile(join(g.out, g.feeds[0].file), '{}');
  await assert.rejects(promoteWindowsUpdates({ ...g, ownerConfirmation: '确认' }), /signature/); assert.equal(g.writes.length, 0);
  const j = await updateFixture(t); j.store.delete(windowsObjectPlan(j.inventory)[0].url);
  await assert.rejects(promoteWindowsUpdates({ ...j, ownerConfirmation: '确认' }), /Public download failed/); assert.equal(j.writes.length, 0);
});

test('Windows CDN config and promotion verify ordinary exact public responses', async t => {
  const h = await updateFixture(t), cdn = { provider: 'tencent', mutablePolicy: 'bypass' };
  const path = join(h.out, 'cos-windows.json');
  const config = { ...h.config, prefix: 'bot/windows/', publicBaseURL: 'https://dl.vonvon.cc/bot/windows/', secretIdEnv: 'WIN_ID', secretKeyEnv: 'WIN_KEY', cdn };
  await writeFile(path, JSON.stringify(config));
  assert.deepEqual((await readWindowsCosConfig(path)).cdn, cdn);
  await writeFile(path, JSON.stringify({ ...config, cdn: { provider: 'other', mutablePolicy: 'bypass' } }));
  await assert.rejects(readWindowsCosConfig(path), /CDN configuration supports only/);
  const fetchImpl = async (url, options) => {
    assert.equal(options.cache, undefined);
    assert.equal(options.headers, undefined);
    const response = await h.fetchImpl(url);
    if (url.includes('/stable/') && response.status === 200) response.headers.set('age', '60');
    return response;
  };
  await assert.rejects(promoteWindowsUpdates({ ...h, config, fetchImpl, ownerConfirmation: 'ok' }), /nonzero or invalid Age/);
  assert.notEqual(JSON.parse(await readFile(join(h.out, 'windows-update-publish-receipt.json'), 'utf8')).status, 'published');
  const result = await promoteWindowsUpdates({ ...h, config, ownerConfirmation: 'ok' });
  assert.match(result.cdn, /腾讯 CDN/);
});
