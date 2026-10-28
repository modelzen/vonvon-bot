import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactRecord } from './desktop-release-tools.mjs';
import { releaseMetadata } from './release-mac.mjs';
import { assembleSplitRelease } from './assemble-split-release.mjs';

const version = '0.7.3', sha = 'a'.repeat(40);
const json = value => JSON.stringify(value, null, 2) + '\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'split-evidence-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const options = {out: join(root, 'assembled'), repo: join(root, 'source'), version, sha};
  await mkdir(options.repo);
  for (const architecture of ['universal', 'arm64', 'x64']) {
    const path = options[architecture] = join(root, architecture); await mkdir(path);
    const suffix = architecture === 'universal' ? '' : `-${architecture}`;
    const feedName = `feed-${version}${suffix}.json`;
    const names = [`Vonvon-Bot-${version}-${architecture}.zip`, `Vonvon-Bot-${version}-${architecture}.dmg`, feedName, 'manifest.json'];
    for (const name of names) await writeFile(join(path, name), name === feedName ? json(releaseMetadata(version, '2026-10-28T00:00:00Z', 'notes', architecture).feed) : name === 'manifest.json' ? json(releaseMetadata(version, '2026-10-28T00:00:00Z', 'notes', architecture).manifest) : `fixture ${name}`);
    const files = await Promise.all(names.map(name => artifactRecord(join(path, name))));
    const checks = Object.fromEntries(['appStapled', 'dmgStapled', 'gatekeeperApp', 'gatekeeperDmg', 'quarantineAbsent', 'zipContainsStapledApp', 'dmgContainsStapledApp'].map(key => [key, true]));
    const notarization = {app: `app-${architecture}`, dmg: `dmg-${architecture}`};
    const slices = architecture === 'universal' ? ['arm64', 'x86_64'] : [architecture === 'x64' ? 'x86_64' : 'arm64'];
    const inventory = {mode: 'release', version, sourceCommit: sha, complete: true, baseline: 'none', files, checks, notarization, verification: { architectures: [{archs:slices}] }};
    await writeFile(join(path, 'release-inventory.json'), json(inventory));
    const context = {...(architecture === 'universal' ? {} : {architecture}), mode:'release', version, sourceCommit:sha};
    const stateFiles = [...files, await artifactRecord(join(path, 'release-inventory.json'))];
    const zip = files.find(file => file.file.endsWith('.zip')), dmg = files.find(file => file.file.endsWith('.dmg'));
    const state = {context, complete:true, files:stateFiles, appSeal:Object.fromEntries(slices.map(slice => [slice, 'aa'])), dmgSeal:{default:'bb'}, transport:{sha256:'cc'}, zip, zipVerification:{archiveSHA256:zip.sha256}, app:{id:notarization.app, status:'Accepted', logVerified:true, sha256:'cc'}, dmg:{id:notarization.dmg, status:'Accepted', logVerified:true, stapledSHA256:dmg.sha256}};
    await writeFile(join(path, 'notarization-state.json'), json(state));
    await writeFile(join(path, 'SHA256SUMS'), stateFiles.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
  }
  return options;
}
test('assembles all signed candidates and emits separate update feeds with legacy fallback', async t => {
  const options = await fixture(t); const result = await assembleSplitRelease(options, {temporaryRoots: [], verify: async () => {}});
  assert.equal(result.files.length, 10);
  const manifest = JSON.parse(await readFile(join(options.out, 'manifest.json'), 'utf8'));
  assert.match(manifest.feedURL, /feed-0\.7\.3\.json$/);
  assert.match(manifest.feedURLs.arm64, /feed-0\.7\.3-arm64\.json$/);
  assert.match(manifest.feedURLs.x64, /feed-0\.7\.3-x64\.json$/);
});
test('refuses artifacts changed after notarization evidence', async t => {
  const options = await fixture(t);
  await writeFile(join(options.arm64, `Vonvon-Bot-${version}-arm64.zip`), 'tampered');
  await assert.rejects(assembleSplitRelease(options, {temporaryRoots: [], verify: async () => {}}), /differs/);
});

test('rejects a substituted ZIP even if inventory, state files and checksums are rewritten', async t => {
  const options = await fixture(t); const path = options.arm64;
  const name = `Vonvon-Bot-${version}-arm64.zip`;
  await writeFile(join(path, name), 'substituted ZIP');
  const replacement = await artifactRecord(join(path, name));
  const inventoryPath = join(path, 'release-inventory.json'), statePath = join(path, 'notarization-state.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  inventory.files = inventory.files.map(file => file.file === name ? replacement : file);
  await writeFile(inventoryPath, json(inventory));
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.files = state.files.map(file => file.file === name ? replacement : file.file === 'release-inventory.json' ? null : file);
  state.files[state.files.findIndex(file => file === null)] = await artifactRecord(inventoryPath);
  await writeFile(statePath, json(state));
  await writeFile(join(path, 'SHA256SUMS'), state.files.map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n');
  await assert.rejects(assembleSplitRelease(options, {temporaryRoots: [], verify: async () => {}}), /ZIP differs from the verified archive/);
});

test('requires artifact verification for each architecture before producing a manifest', async t => {
  const options = await fixture(t); const seen = [];
  await assert.rejects(assembleSplitRelease(options, {temporaryRoots: [], verify: async item => {
    seen.push(item.architecture);
    if (item.architecture === 'x64') throw new Error('ticket invalid');
  }}), /ticket invalid/);
  assert.deepEqual(seen, ['universal', 'arm64', 'x64']);
  await assert.rejects(readFile(join(options.out, 'manifest.json')), {code:'ENOENT'});
});
