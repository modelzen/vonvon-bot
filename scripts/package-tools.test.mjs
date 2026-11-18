import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowlist, fileEntries, validateInstalledManifest, validateManifest, validateTree } from './package-tools.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-package-test-'));
  const metadata = { name: 'vonvon-bot', version: '0.7.0', type: 'module', engines: { node: '^22.12.0 || ^24.0.0 || >=26.0.0' }, license: 'MIT', author: 'modelzen', bin: { vonvon: 'bin/vonvon.mjs' }, dependencies: {}, bundleDependencies: [] };
  for (const path of ['bin/vonvon.mjs', 'dist/cli.js', 'ui/dist/index.html', 'LICENSE', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md', 'import-core.json']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), path);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(metadata));
  const manifest = { schema: 1, package: 'vonvon-bot', version: '0.7.0', sourceHead: 'abc', lockfileSha256: 'a'.repeat(64), node: 'v22.22.0', npm: '10.9.4', esbuild: '0.25.9', files: await fileEntries(root) };
  return { root, manifest };
}

async function installedFixture(t) {
  const { root, manifest } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [directory, name, bin] of [
    ['node_modules/qrcode', 'qrcode', { qrcode: 'bin/qrcode' }],
    ['node_modules/parent/node_modules/@scope/tool', '@scope/tool', 'bin/tool'],
  ]) {
    await mkdir(join(root, directory, 'bin'), { recursive: true });
    await writeFile(join(root, directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', bin }));
    await writeFile(join(root, directory, typeof bin === 'string' ? bin : bin.qrcode), 'executable');
  }
  manifest.files = await fileEntries(root);
  const links = [
    ['node_modules/.bin/qrcode', '../qrcode/bin/qrcode'],
    ['node_modules/parent/node_modules/.bin/tool', '../@scope/tool/bin/tool'],
  ];
  for (const [path, target] of links) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await symlink(target, join(root, path));
  }
  return { root, manifest, links };
}

test('installed manifest accepts exact dependency bin links while packed tree remains strict', async t => {
  const { root, manifest } = await installedFixture(t);
  await validateInstalledManifest(root, manifest, 'abc');
  await assert.rejects(validateManifest(root, manifest, 'abc'), /symlink refused/);
  await assert.rejects(validateTree(root), /symlink refused/);
  await assert.rejects(fileEntries(root), /symlink refused/);
});

test('installed manifest treats backslashes as separators only on Windows', async t => {
  const { root, manifest, links } = await installedFixture(t);
  for (const [path, target] of links) {
    await rm(join(root, path));
    await symlink(target.replaceAll('/', '\\'), join(root, path));
  }
  if (process.platform === 'win32') await validateInstalledManifest(root, manifest, 'abc');
  else await assert.rejects(validateInstalledManifest(root, manifest, 'abc'), /installed symlink refused/);
});

for (const [path, target] of [
  ['node_modules/.bin/undeclared', '../qrcode/bin/qrcode'],
  ['bin/qrcode', '../node_modules/qrcode/bin/qrcode'],
  ['node_modules/.bin/qrcode', '../qrcode/package.json'],
  ['node_modules/.bin/qrcode', '../qrcode/bin/missing'],
  ['node_modules/.bin/qrcode', '/tmp/outside'],
  ['node_modules/.bin/qrcode', '../../../outside'],
  ['node_modules/.bin/qrcode', '../qrcode/bin/../bin/qrcode'],
  ['node_modules/.bin/qrcode', '..\\..\\..\\outside'],
  ['node_modules/.bin/qrcode', '..\\qrcode\\bin\\..\\bin\\qrcode'],
  ['node_modules/.bin/qrcode', '../parent/node_modules/@scope/tool/bin/tool'],
]) {
  test(`installed manifest refuses unauthorized link ${path} to ${target}`, async t => {
    const { root, manifest } = await installedFixture(t);
    await rm(join(root, path), { force: true });
    await symlink(target, join(root, path));
    await assert.rejects(validateInstalledManifest(root, manifest, 'abc'), /installed symlink refused/);
  });
}

test('installed manifest ignores group and other bits that a umask changes', { skip: process.platform === 'win32' }, async t => {
  const { root, manifest } = await installedFixture(t);
  for (const file of manifest.files) await chmod(join(root, file.path), parseInt(file.mode, 8) ^ 0o066);
  await validateInstalledManifest(root, manifest, 'abc');
});

for (const variant of ['extra file', 'bin file', 'content', 'mode', 'metadata', 'missing target', 'linked target']) {
  test(`installed manifest still refuses ${variant}`, async t => {
    const { root, manifest } = await installedFixture(t);
    const target = join(root, 'node_modules/qrcode/bin/qrcode');
    if (variant === 'extra file') await writeFile(join(root, 'extra'), 'extra');
    if (variant === 'bin file') await writeFile(join(root, 'node_modules/.bin/extra'), 'extra');
    if (variant === 'content') await writeFile(target, 'changed');
    if (variant === 'mode') {
      const original = manifest.files.find(file => file.path === 'node_modules/qrcode/bin/qrcode');
      original.mode = (parseInt(original.mode, 8) ^ 0o100).toString(8).padStart(3, '0');
    }
    if (variant === 'metadata') await writeFile(join(root, 'node_modules/qrcode/package.json'), JSON.stringify({ name: 'qrcode', version: '1.0.0', bin: { qrcode: 'package.json' } }));
    if (variant === 'missing target' || variant === 'linked target') await rm(target);
    if (variant === 'linked target') await symlink('../package.json', target);
    await assert.rejects(validateInstalledManifest(root, manifest, 'abc'), /manifest file hash, mode, or inventory mismatch/);
  });
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
