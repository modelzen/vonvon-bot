import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWindowsInventory, peMachine, validateWindowsInventory, verifyLatestYml, verifyWindowsArtifacts } from './package-windows.mjs';

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
async function fixture(t) {
  const out = await mkdtemp(join(tmpdir(), 'vonvon-windows-package-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const installer = pe(0x14c); // An NSIS bootstrapper can be 32-bit.
  const sha512 = createHash('sha512').update(installer).digest('base64');
  const yaml = `version: ${version}\nfiles:\n  - url: ${setup}.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${setup}.exe\nsha512: ${sha512}\nreleaseDate: 2026-10-28T00:00:00.000Z\n`;
  await Promise.all([
    writeFile(join(out, `${setup}.exe`), installer),
    writeFile(join(out, `${base}.zip`), 'zip fixture'),
    writeFile(join(out, `${setup}.exe.blockmap`), 'blockmap fixture'),
    writeFile(join(out, 'latest.yml'), yaml),
    writeFile(join(out, 'unpacked.exe'), pe()),
    writeFile(join(out, 'zipped.exe'), pe()),
  ]);
  const options = { out, version, sourceSha, unpackedExe: join(out, 'unpacked.exe'), zipExe: join(out, 'zipped.exe') };
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
