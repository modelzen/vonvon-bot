import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowlist, fileEntries, validateManifest, validateTree } from './package-tools.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-package-test-'));
  const metadata = { name: 'vonvon-bot', version: '0.7.0', type: 'module', engines: { node: '^22.12.0 || ^24.0.0 || >=26.0.0' }, license: 'MIT', author: 'modelzen', bin: { vonvon: 'bin/vonvon.mjs' }, dependencies: {}, bundleDependencies: [] };
  for (const path of ['bin/vonvon.mjs', 'dist/cli.js', 'ui/dist/index.html', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), path);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  const manifest = { schema: 1, package: 'vonvon-bot', version: '0.7.0', sourceHead: 'abc', lockfileSha256: 'a'.repeat(64), node: 'v22.22.0', npm: '10.9.4', esbuild: '0.25.9', files: await fileEntries(root) };
  return { root, manifest };
}

test('manifest is deterministic and detects missing, extra, modified, native files and wrong head', async t => {
  const { root, manifest } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await fileEntries(root), manifest.files);
  assert.deepEqual(await fileEntries(root), manifest.files);
  await validateManifest(root, manifest, 'abc');
  await assert.rejects(validateManifest(root, manifest, 'wrong'), /head mismatch/);
  await writeFile(join(root, 'dist/cli.js'), 'changed');
  await assert.rejects(validateManifest(root, manifest, 'abc'), /hash/);
  await writeFile(join(root, 'dist/cli.js'), 'dist\/cli.js');
  await writeFile(join(root, 'extra'), 'x');
  await assert.rejects(validateManifest(root, manifest, 'abc'), /inventory/);
  await rm(join(root, 'extra'));
  await writeFile(join(root, 'bad.node'), 'x');
  await assert.rejects(validateManifest(root, manifest, 'abc'), /native module/);
  await rm(join(root, 'bad.node'));
  await rm(join(root, 'NOTICE'));
  await assert.rejects(validateManifest(root, manifest, 'abc'), /missing file/);
});

test('unlisted install script and changed allowlisted script file are refused', async t => {
  const { root, manifest } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  metadata.scripts = { postinstall: 'echo surprise' };
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  await assert.rejects(validateManifest(root, { ...manifest, files: await fileEntries(root) }, 'abc'), /metadata mismatch/);
  const dependency = join(root, 'node_modules/protobufjs');
  await mkdir(join(dependency, 'scripts'), { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'protobufjs', version: '7.6.6', scripts: { postinstall: 'echo surprise' } }));
  await writeFile(join(dependency, 'scripts/postinstall.js'), 'tampered');
  delete metadata.scripts;
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  await assert.rejects(validateManifest(root, { ...manifest, files: await fileEntries(root) }, 'abc'), /install script refused/);
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'protobufjs', version: '7.6.6', scripts: { postinstall: 'node scripts/postinstall' } }));
  await assert.rejects(validateManifest(root, { ...manifest, files: await fileEntries(root) }, 'abc'), /install script hash mismatch/);
});

for (const variant of ['approved', 'bad integrity', 'wrong version', 'wrong name', 'missing lock', 'changed script', 'changed script file', 'missing script file', 'native']) {
  test(`nested bundled install script with hoisted source lock: ${variant}`, async t => {
    const { root } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const approved = allowlist.find(item => item.name === 'protobufjs');
    const dependency = join(root, 'node_modules/parent/node_modules/protobufjs');
    await mkdir(join(dependency, 'scripts'), { recursive: true });
    const metadata = { name: approved.name, version: approved.version, scripts: { [approved.lifecycle]: approved.script } };
    const record = { version: approved.version, integrity: approved.integrity };
    const lock = { packages: { [approved.lockPath]: record } };
    if (variant === 'bad integrity') record.integrity = 'sha512-unapproved';
    if (variant === 'wrong version') record.version = '0.0.0';
    if (variant === 'wrong name') record.name = 'other-package';
    if (variant === 'missing lock') delete lock.packages[approved.lockPath];
    if (variant === 'changed script') metadata.scripts[approved.lifecycle] = 'node malicious.js';
    await writeFile(join(dependency, 'package.json'), JSON.stringify(metadata));
    for (const file of Object.keys(approved.files)) {
      if (variant === 'missing script file') continue;
      const bytes = variant === 'changed script file' ? 'changed' : await readFile(new URL(`../${approved.lockPath}/${file}`, import.meta.url));
      await writeFile(join(dependency, file), bytes);
    }
    if (variant === 'native') await writeFile(join(dependency, 'addon.node'), 'native');
    if (variant === 'approved') await validateTree(root, lock);
    else await assert.rejects(validateTree(root, lock), variant === 'native' ? /native module refused/ : variant.endsWith('script file') ? /install script hash mismatch/ : /install script refused/);
  });
}

for (const field of ['lockfileSha256', 'node', 'npm', 'esbuild']) {
  test(`manifest requires valid ${field}`, async t => {
    const { root, manifest } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const omitted = { ...manifest };
    delete omitted[field];
    await assert.rejects(validateManifest(root, omitted, 'abc'), /provenance metadata mismatch/);
    for (const invalid of [null, 123, '', 'latest', field === 'lockfileSha256' ? 'A'.repeat(64) : '^22.0.0']) {
      await assert.rejects(validateManifest(root, { ...manifest, [field]: invalid }, 'abc'), /provenance metadata mismatch/);
    }
  });
}

for (const field of ['engines', 'license', 'author']) {
  test(`package requires valid ${field} even with an updated manifest inventory`, async t => {
    const { root, manifest } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const invalidValues = field === 'engines' ? [undefined, null, {}, { node: '' }, { node: 22 }] : [undefined, null, '', '   ', 123];
    for (const invalid of invalidValues) {
      const metadata = { ...original, [field]: invalid };
      await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
      await assert.rejects(validateManifest(root, { ...manifest, files: await fileEntries(root) }, 'abc'), /package metadata mismatch/);
    }
  });
}
