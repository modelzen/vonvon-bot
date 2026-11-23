import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { Arch } from 'builder-util';
import afterPack, { assertNoBundledClaude } from './desktop-backend-policy.mjs';
import { stageDependencies } from './stage-daemon.mjs';

const sdk = '@anthropic-ai/claude-agent-sdk';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-desktop-backends-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const daemon = join(root, 'App.app/Contents/Resources/daemon');
  const put = async (path, value = '{}') => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  await put(join(daemon, 'package.json'), JSON.stringify({ name: '@vonvon/daemon', dependencies: {} }));
  return { root, daemon, put };
}

test('compact desktop staging excludes SDK/native dev dependencies even when present locally', async t => {
  const { root, daemon, put } = await fixture(t);
  const source = join(root, 'source');
  await put(join(source, 'package.json'), JSON.stringify({ devDependencies: { [sdk]: '1.0.0' }, dependencies: { runtime: '1.0.0' } }));
  await put(join(source, 'node_modules/runtime/package.json'), JSON.stringify({ name: 'runtime', version: '1.0.0' }));
  await put(join(source, `node_modules/${sdk}/package.json`), JSON.stringify({ name: sdk }));
  await put(join(source, `node_modules/${sdk}-darwin-arm64/claude`), 'native fixture');
  await stageDependencies(source, daemon, { compact: true });
  await assertNoBundledClaude(daemon);
  await afterPack({ appOutDir: root, electronPlatformName: 'darwin', arch: Arch.arm64, packager: { appInfo: { productFilename: 'App' } } });
});

for (const metadata of [
  { dependencies: { [sdk]: '1' } },
  { optionalDependencies: { '@anthropic-ai/claude-code': '1' } },
  { bundledBackends: ['claude-agent'] },
]) {
  test(`rejects desktop metadata declaring Claude: ${JSON.stringify(metadata)}`, async t => {
    const { daemon, put } = await fixture(t);
    await put(join(daemon, 'package.json'), JSON.stringify(metadata));
    await assert.rejects(assertNoBundledClaude(daemon), /Claude must be user-installed/);
  });
}

for (const name of [sdk, `${sdk}-darwin-arm64`, '@anthropic-ai/claude-code', '@anthropic-ai/claude-code-darwin-x64']) {
  test(`afterPack rejects an undeclared nested Claude package: ${name}`, async t => {
    const { root, daemon, put } = await fixture(t);
    await put(join(daemon, 'node_modules/parent/node_modules', name, 'package.json'));
    await assert.rejects(afterPack({ appOutDir: root, electronPlatformName: 'darwin', arch: Arch.arm64, packager: { appInfo: { productFilename: 'App' } } }), /Claude must be user-installed/);
  });
}

test('rejects SDK symlinks while allowing unrelated Anthropic client packages', async t => {
  const { root, daemon, put } = await fixture(t);
  await put(join(daemon, 'node_modules/@anthropic-ai/sdk/package.json'));
  await assertNoBundledClaude(daemon);
  await put(join(root, 'external-sdk/package.json'));
  await symlink(join(root, 'external-sdk'), join(daemon, 'node_modules', sdk));
  await assert.rejects(assertNoBundledClaude(daemon), /Claude must be user-installed/);
});
