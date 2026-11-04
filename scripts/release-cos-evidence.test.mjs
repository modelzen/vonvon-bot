import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { COS_SDK_LOCKFILE, COS_SDK_VERSION, cosCredentialEnvNames, loadPinnedSdk, readCosConfig, readCosReleaseEvidence } from './release-cos-evidence.mjs';
const config = { bucket: 'release-1234567890', region: 'ap-shanghai', prefix: 'bot/mac/stable/', publicManifestURL: 'https://dl.vonvon.cc/bot/mac/stable/manifest.json', ledgerFile: '/external/ledger.json' };
const readJSON = async path => path.endsWith('ledger.json') ? { versions: ['0.8.0'] } : config;
const params = page => ({ env: {}, readJSON, client: { getBucket: (input, callback) => callback(null, page(input)) } });

test('COS enumeration collects every page and the durable highest-version ledger', async () => {
  const markers = [];
  const evidence = await readCosReleaseEvidence('/external/cos.json', params(input => {
    markers.push(input.Marker);
    assert.equal(input.Prefix, 'bot/mac/stable/');
    return input.Marker ? { Contents: [{ Key: 'bot/mac/stable/Vonvon-Bot-0.9.0-universal.zip' }], IsTruncated: 'false' }
      : { Contents: [{ Key: 'bot/mac/stable/feed-0.7.0.json' }], IsTruncated: 'true', NextMarker: 'next-page' };
  }));
  assert.deepEqual(markers, ['', 'next-page']);
  assert.deepEqual(evidence.versions, ['0.8.0', '0.7.0', '0.9.0']);
  assert.equal(evidence.keys.length, 2);
});

test('COS errors and incomplete, looping or out-of-prefix listings never prove an empty prefix', async () => {
  for (const page of [
    {}, { Contents: [], IsTruncated: 'true' },
    { Contents: [], IsTruncated: 'true', NextMarker: 'same' },
    { Contents: [{ Key: 'elsewhere/feed-0.7.0.json' }], IsTruncated: false },
    { Contents: [{ Key: 'bot/mac/stable/feed-unknown' }], IsTruncated: false },
  ]) await assert.rejects(readCosReleaseEvidence('/external/cos.json', params(() => page)));
  const dependencies = params(() => ({}));
  dependencies.client.getBucket = (_, cb) => cb(new Error('credential value must not escape'));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', dependencies), error => !error.message.includes('credential value'));
});

test('COS gate requires external config, exact stable identity and readable ledger', async () => {
  await assert.rejects(readCosReleaseEvidence('relative.json', params(() => ({}))));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', { ...params(() => ({})), readJSON: async () => ({ ...config, prefix: 'other/' }) }));
  await assert.rejects(readCosReleaseEvidence('/external/cos.json', { ...params(() => ({})), readJSON: async path => path.endsWith('ledger.json') ? {} : config }));
});

test('credential settings are variable names only and are reported for stripping', async () => {
  const withNames = { ...config, secretIdEnv: 'COS_READ_ID', secretKeyEnv: 'COS_READ_KEY', securityTokenEnv: 'COS_READ_TOKEN' };
  assert.deepEqual(cosCredentialEnvNames(await readCosConfig('/external/cos.json', { readJSON: async () => withNames })), ['COS_READ_ID', 'COS_READ_KEY', 'COS_READ_TOKEN']);
  await assert.rejects(readCosConfig('/external/cos.json', { readJSON: async () => ({ ...withNames, secretKeyEnv: 'AKID-inline-secret-value' }) }), error => !error.message.includes('AKID'));
});

test('read configuration validates an optional CDN policy instead of silently accepting unsupported settings', async () => {
  const cdn = { provider: 'tencent', mutablePolicy: 'bypass' };
  assert.deepEqual((await readCosConfig('/external/cos.json', { readJSON: async () => ({ ...config, cdn }) })).cdn, cdn);
  await assert.rejects(readCosConfig('/external/cos.json', { readJSON: async () => ({ ...config, cdn: { provider: 'tencent', mutablePolicy: 'refresh' } }) }), /CDN configuration/);
});

test('the official SDK is loaded only from a pinned tool prefix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cos-sdk-'));
  assert.ok(basename(root).startsWith('cos-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'node_modules', 'cos-nodejs-sdk-v5');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'index.js'), "module.exports = class { constructor(options) { this.options = options; } getBucket(_input, callback) { callback(null, { Contents: [], IsTruncated: 'false', seenKey: this.options.SecretKey }); } };\n");
  const env = { COS_READ_ID: 'id', COS_READ_KEY: 'key' };
  const settings = { ...config, secretIdEnv: 'COS_READ_ID', secretKeyEnv: 'COS_READ_KEY', sdkModule: sdk };
  const read = (packageJSON, overrides = {}) => async path => path.endsWith('ledger.json') ? { versions: [] } : path.endsWith('package.json') ? packageJSON : { ...settings, ...overrides };
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION, main: 'index.js' }));
  await writeFile(join(root, 'package-lock.json'), await readFile(COS_SDK_LOCKFILE));
  const evidence = await readCosReleaseEvidence('/external/cos.json', { env, readJSON: read({ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION }) });
  assert.deepEqual(evidence.keys, []);
  for (const [packageJSON, overrides] of [
    [{ name: 'cos-nodejs-sdk-v5', version: '2.99.0' }, {}],
    [{ name: 'cos-sdk-impostor', version: COS_SDK_VERSION }, {}],
    [{ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION }, { sdkModule: undefined }],
    [{ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION }, { sdkModule: 'cos-nodejs-sdk-v5' }],
    [{ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION }, { sdkModule: join(root, 'stub') }],
  ]) await assert.rejects(readCosReleaseEvidence('/external/cos.json', { env, readJSON: read(packageJSON, overrides) }), /sdkModule|pinned/, JSON.stringify({ packageJSON, overrides }));
});

test('the SDK is loaded only from a prefix installed from the reviewed lockfile, byte for byte', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cos-sdk-lock-'));
  assert.ok(basename(root).startsWith('cos-sdk-lock-'));
  t.after(() => { delete globalThis.unpinnedCosSdkLoaded; return rm(root, { recursive: true, force: true }); });
  const sdk = join(root, 'node_modules', 'cos-nodejs-sdk-v5'), lockfile = join(root, 'package-lock.json');
  await mkdir(sdk, { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'cos-nodejs-sdk-v5', version: COS_SDK_VERSION, main: 'index.js' }));
  await writeFile(join(sdk, 'index.js'), 'globalThis.unpinnedCosSdkLoaded = true;\nmodule.exports = class {};\n');
  const pinned = await readFile(COS_SDK_LOCKFILE);
  const relaxed = JSON.parse(pinned);
  relaxed.packages['node_modules/cos-request'].version = '1.3.4';
  for (const [name, bytes] of [['missing', undefined], ['a transitive version changed', JSON.stringify(relaxed, null, 2) + '\n'], ['reformatted', JSON.stringify(JSON.parse(pinned))], ['one trailing byte', Buffer.concat([pinned, Buffer.from('\n')])]]) {
    if (bytes === undefined) await rm(lockfile, { force: true }); else await writeFile(lockfile, bytes);
    await assert.rejects(loadPinnedSdk(sdk), /installed with npm ci from scripts\/cos-sdk; its package-lock\.json is missing or differs/, name);
    assert.equal(globalThis.unpinnedCosSdkLoaded, undefined, `${name}: the SDK code must not run`);
  }
  await writeFile(lockfile, pinned);
  assert.equal(typeof await loadPinnedSdk(sdk), 'function');
  assert.equal(globalThis.unpinnedCosSdkLoaded, true);
});

test('scripts/cos-sdk pins exactly the SDK version the helpers accept, with every package locked', async () => {
  const manifest = JSON.parse(await readFile(new URL('./cos-sdk/package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(await readFile(COS_SDK_LOCKFILE, 'utf8'));
  assert.deepEqual(manifest.dependencies, { 'cos-nodejs-sdk-v5': COS_SDK_VERSION });
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(lock.packages['node_modules/cos-nodejs-sdk-v5'].version, COS_SDK_VERSION);
  for (const [path, entry] of Object.entries(lock.packages).filter(([path]) => path)) {
    assert.match(entry.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(entry.integrity ?? '', /^sha512-/, path);
  }
});

test('workflow.md installs and names the same SDK version the helper accepts', async () => {
  const workflow = await readFile(new URL('../.agents/skills/release-mac/references/workflow.md', import.meta.url), 'utf8');
  const installs = [...workflow.matchAll(/cos-nodejs-sdk-v5@(\d+\.\d+\.\d+)/g)].map(match => match[1]);
  assert.ok(installs.length > 0, 'workflow.md must name the pinned SDK version');
  assert.deepEqual([...new Set(installs)], [COS_SDK_VERSION]);
  assert.match(workflow, new RegExp(`现在是 ${COS_SDK_VERSION.replaceAll('.', '\\.')}`));
  assert.ok(workflow.includes('cp "$SOURCE_WORKTREE/scripts/cos-sdk/package.json" "$SOURCE_WORKTREE/scripts/cos-sdk/package-lock.json" "$COS_SDK_PREFIX/"'), 'workflow.md copies the reviewed lockfile');
  assert.ok(workflow.includes('HOME="$T/home" npm ci --prefix "$COS_SDK_PREFIX" --ignore-scripts'), 'workflow.md installs with npm ci and no install scripts');
  assert.equal(/npm install[^\n`]*cos-nodejs-sdk-v5@/.test(workflow), false, 'workflow.md no longer installs the SDK without the lockfile');
});
