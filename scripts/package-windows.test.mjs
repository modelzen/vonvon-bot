import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { combineWindowsArtifacts, createWindowsInventory, peMachine, validateWindowsAcceptance, validateWindowsInventory, verifyLatestYml, verifyWindowsArtifacts } from './package-windows.mjs';

const version = '0.7.2';
const sourceSha = '1234567890abcdef1234567890abcdef12345678';
const base = `Vonvon-Bot-${version}-windows-x64`;
const setup = `Vonvon-Bot-Setup-${version}-x64`;
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}
async function fixture(t, architecture = 'x64') {
  const base = `Vonvon-Bot-${version}-windows-${architecture}`;
  const setup = `Vonvon-Bot-Setup-${version}-${architecture}`;
  const feed = architecture === 'arm64' ? 'latest-arm64.yml' : 'latest.yml';
  const out = await mkdtemp(join(tmpdir(), 'vonvon-windows-package-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const installer = pe(0x14c); // An NSIS bootstrapper can be 32-bit.
  const sha512 = createHash('sha512').update(installer).digest('base64');
  const yaml = `version: ${version}\nfiles:\n  - url: ${setup}.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${setup}.exe\nsha512: ${sha512}\nreleaseDate: 2026-10-28T00:00:00.000Z\n`;
  await Promise.all([
    writeFile(join(out, `${setup}.exe`), installer),
    writeFile(join(out, `${base}.zip`), 'zip fixture'),
    writeFile(join(out, `${setup}.exe.blockmap`), 'blockmap fixture'),
    writeFile(join(out, feed), yaml),
    writeFile(join(out, 'unpacked.exe'), pe(architecture === 'arm64' ? 0xaa64 : 0x8664)),
    writeFile(join(out, 'zipped.exe'), pe(architecture === 'arm64' ? 0xaa64 : 0x8664)),
  ]);
  const options = { out, version, sourceSha, architecture, unpackedExe: join(out, 'unpacked.exe'), zipExe: join(out, 'zipped.exe') };
  return { out, options, yaml };
}

test('inventory ties unsigned x64 payload and all four artifacts to the source SHA', async t => {
  const { out, options } = await fixture(t);
  const inventory = await createWindowsInventory(options);
  assert.equal(inventory.sourceSha, sourceSha);
  assert.equal(inventory.architecture, 'x64');
  assert.equal(inventory.signed, false);
  assert.equal(inventory.updatesEnabled, false);
  assert.deepEqual(inventory.artifacts.map(item => item.kind), ['installer', 'zip', 'blockmap', 'feed']);
  for (const item of inventory.artifacts) {
    const bytes = await readFile(join(out, item.file));
    assert.equal(item.bytes, bytes.length);
    assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(item.sha512, createHash('sha512').update(bytes).digest('base64'));
  }
  assert.deepEqual(JSON.parse(await readFile(join(out, 'windows-release-inventory.json'), 'utf8')), inventory);
  assert.deepEqual(await verifyWindowsArtifacts(out, { version, sourceSha }), inventory);
});

test('ARM64 inventory requires ARM64 PE payload and its separate feed', async t => {
  const h = await fixture(t, 'arm64');
  const inventory = await createWindowsInventory(h.options);
  assert.equal(inventory.architecture, 'arm64');
  assert.equal(inventory.artifacts[3].file, 'latest-arm64.yml');
  await writeFile(h.options.unpackedExe, pe());
  await assert.rejects(createWindowsInventory(h.options), /not arm64/);
});

test('combined downloads require both native installer acceptance reports for matching bytes and source', async t => {
  const archs = ['x64', 'arm64'], inputs = [];
  for (const architecture of archs) {
    const h = await fixture(t, architecture);
    const inventory = await createWindowsInventory(h.options);
    const report = { architecture, hostArchitecture: architecture, sourceSha, installerSha256: inventory.artifacts[0].sha256, passed: true,
      steps: ['fresh-install','overwrite-install','uninstall','reinstall-after-uninstall','reinstall-after-0.7.5-orphan'].map(name => ({ name, passed: true })) };
    const expected = { architecture, sourceSha, installerSha256: report.installerSha256 };
    validateWindowsAcceptance(report, expected);
    for (const change of [{ hostArchitecture: 'emulated' }, { sourceSha: 'f'.repeat(40) }, { installerSha256: '0'.repeat(64) }, { steps: [] }, { passed: false }]) {
      assert.throws(() => validateWindowsAcceptance({ ...report, ...change }, expected));
    }
    await writeFile(join(h.out, `windows-acceptance-${architecture}.json`), JSON.stringify(report));
    inputs.push(h.out);
  }
  const out = await mkdtemp(join(tmpdir(), 'vonvon-combined-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const combined = await combineWindowsArtifacts(inputs, out);
  assert.equal(combined.architecture, 'x64+arm64');
  assert.equal(combined.artifacts.length, 8);
  await writeFile(join(out, 'windows-acceptance-arm64.json'), '{}');
  await assert.rejects(verifyWindowsArtifacts(out), /native acceptance/);
  await assert.rejects(combineWindowsArtifacts([inputs[0]], out), /Both Windows architectures/);
});

test('publisher verification refuses edited files or untrusted inventory identity', async t => {
  const { out, options } = await fixture(t);
  const inventory = await createWindowsInventory(options);
  assert.throws(() => validateWindowsInventory(inventory, { sourceSha: 'f'.repeat(40) }), /source SHA mismatch/);
  await writeFile(join(out, `${base}.zip`), 'tampered zip');
  await assert.rejects(verifyWindowsArtifacts(out, { version, sourceSha }), /Artifact content mismatch/);
});

test('refuses mismatched metadata and non-x64 application payload', async t => {
  const h = await fixture(t);
  await writeFile(join(h.out, 'latest.yml'), h.yaml.replace(`version: ${version}`, 'version: 9.9.9'));
  await assert.rejects(createWindowsInventory(h.options), /version mismatch/);
  await writeFile(join(h.out, 'latest.yml'), h.yaml);
  await writeFile(h.options.zipExe, pe(0x14c));
  await assert.rejects(createWindowsInventory(h.options), /not x64/);
});

test('latest.yml rejects a changed installer path, digest, or size', async t => {
  const h = await fixture(t);
  const installer = await readFile(join(h.out, `${setup}.exe`));
  const expected = {
    version, installerName: `${setup}.exe`, installerSize: installer.length,
    installerSha512: createHash('sha512').update(installer).digest('base64'),
  };
  for (const changed of [
    h.yaml.replace(`path: ${setup}.exe`, 'path: other.exe'),
    h.yaml.replace(`size: ${installer.length}`, 'size: 999'),
    h.yaml.replace(`sha512: ${expected.installerSha512}`, 'sha512: wrong'),
  ]) assert.throws(() => verifyLatestYml(changed, expected));
});

test('refuses missing blockmap and malformed PE', async t => {
  const h = await fixture(t);
  await rm(join(h.out, `${setup}.exe.blockmap`));
  await assert.rejects(createWindowsInventory(h.options));
  await writeFile(join(h.out, `${setup}.exe.blockmap`), 'blockmap fixture');
  await writeFile(h.options.unpackedExe, 'not a PE');
  await assert.rejects(createWindowsInventory(h.options), /PE DOS header/);
  assert.throws(() => peMachine(Buffer.alloc(128)), /PE DOS header/);
});
