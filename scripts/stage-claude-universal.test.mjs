import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { stageClaudeUniversal } from './stage-claude-universal.mjs';

const version = '0.3.296';
const prefix = '@anthropic-ai/claude-agent-sdk-darwin-';
const target = (stage, arch) => join(stage, 'node_modules/@anthropic-ai/claude-agent-sdk/node_modules/@anthropic-ai', `claude-agent-sdk-darwin-${arch}`);
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
const native = async (directory, arch, declaredVersion = version) => {
  await write(join(directory, 'package.json'), JSON.stringify({ name: prefix + arch, version: declaredVersion }));
  await write(join(directory, 'claude'), `thin-${arch}`);
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-claude-universal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage/daemon');
  await write(join(stage, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), JSON.stringify({
    name: '@anthropic-ai/claude-agent-sdk', version,
    optionalDependencies: Object.fromEntries(['arm64', 'x64'].map(arch => [prefix + arch, version])),
  }));
  const archive = Buffer.from('verified-tarball-fixture');
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  const packages = Object.fromEntries(['arm64', 'x64'].map(arch => [`node_modules/${prefix}${arch}`, {
    version, integrity, resolved: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-darwin-${arch}/-/claude-agent-sdk-darwin-${arch}-${version}.tgz`,
  }]));
  const lockFile = join(root, 'package-lock.json');
  await write(lockFile, JSON.stringify({ packages }));
  const fetcher = async () => ({ ok: true, arrayBuffer: async () => archive });
  const extract = async (_archive, destination) => {
    // Caller supplies the architecture-specific package identity through destination name.
    const arch = destination.includes('arm64') ? 'arm64' : 'x64';
    await native(join(destination, 'package'), arch);
  };
  const inspectBinary = async path => path.includes('arm64') ? 'arm64' : 'x86_64';
  return { root, stage, lockFile, archive, packages, fetcher, extract, inspectBinary };
}

test('fills both native packages from the exact lock with verified archives and keeps their thin binaries', async t => {
  const h = await fixture(t);
  const urls = [];
  await stageClaudeUniversal({ ...h, fetcher: async url => { urls.push(url); return h.fetcher(); } });
  assert.equal(urls.length, 2);
  for (const arch of ['arm64', 'x64']) {
    assert.equal(JSON.parse(await readFile(join(target(h.stage, arch), 'package.json'))).version, version);
    assert.equal(await readFile(join(target(h.stage, arch), 'claude'), 'utf8'), `thin-${arch}`);
  }
});

test('reuses validated local packages without fetching', async t => {
  const h = await fixture(t);
  for (const arch of ['arm64', 'x64']) await native(join(h.root, 'node_modules/@anthropic-ai', `claude-agent-sdk-darwin-${arch}`), arch);
  await stageClaudeUniversal({ ...h, fetcher: () => { throw new Error('unexpected fetch'); } });
  assert.equal(await readFile(join(target(h.stage, 'x64'), 'claude'), 'utf8'), 'thin-x64');
});

for (const scenario of ['integrity', 'locked version', 'native version', 'native architecture']) {
  test(`fails before packaging when ${scenario} is wrong`, async t => {
    const h = await fixture(t);
    if (scenario === 'integrity') h.packages[`node_modules/${prefix}arm64`].integrity = 'sha512-' + Buffer.alloc(64).toString('base64');
    if (scenario === 'locked version') h.packages[`node_modules/${prefix}arm64`].version = '0.0.1';
    await write(h.lockFile, JSON.stringify({ packages: h.packages }));
    const extract = scenario === 'native version'
      ? async (_archive, destination) => native(join(destination, 'package'), 'arm64', '0.0.1')
      : h.extract;
    const inspectBinary = scenario === 'native architecture' ? async () => 'x86_64' : h.inspectBinary;
    await assert.rejects(stageClaudeUniversal({ ...h, extract, inspectBinary }));
  });
}
