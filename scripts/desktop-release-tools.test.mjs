import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { updateConfiguration, verifyDmg, verifyUniversalApp, writeDesktopRelease, writeSplitFeeds } from './desktop-release-tools.mjs';
import { checkedProductVersion, syncProductVersion } from './product-version.mjs';

const version = '0.7.0';
const teamIdentifier = 'TESTTEAM01';
const config = { manifestURL: 'https://updates.example.test/releases/latest.json', teamIdentifier };
const publishedAt = '2026-10-20T00:00:00.000Z';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  };
  await put(`Vonvon-Bot-${version}-universal.dmg`, 'signed dmg fixture');
  await put(`Vonvon-Bot-${version}-universal.zip`, 'signed zip fixture');
  return { root, put, release: {
    out: join(root, 'metadata'), version, config,
    dmg: join(root, `Vonvon-Bot-${version}-universal.dmg`),
    zip: join(root, `Vonvon-Bot-${version}-universal.zip`),
    verifiedApp: { signature: 'Developer ID Application' }, publishedAt,
  } };
}

test('local release produces the exact updater manifest and default Squirrel.Mac zip feed', async t => {
  const { release } = await fixture(t);
  const inventory = await writeDesktopRelease(release);
  const manifest = await json(join(release.out, 'latest.json'));
  assert.deepEqual(manifest, { version, feedURL: `https://updates.example.test/releases/feed-${version}.json` });
  const feed = await json(join(release.out, `feed-${version}.json`));
  assert.deepEqual(feed, {
    url: `https://updates.example.test/releases/Vonvon-Bot-${version}-universal.zip`,
    name: `Vonvon Bot ${version}`, notes: '', pub_date: publishedAt,
  });
  assert.equal(new URL(manifest.feedURL).origin, new URL(config.manifestURL).origin);
  assert.equal(new URL(feed.url).origin, new URL(config.manifestURL).origin);
  assert.equal(inventory.state, 'local-configured');
  for (const [kind, file] of Object.entries(inventory.files)) {
    const bytes = await readFile(release[kind]);
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('unconfigured release has only a pending inventory and no usable source', async t => {
  const { release } = await fixture(t);
  const inventory = await writeDesktopRelease({ ...release, config: {} });
  assert.equal(inventory.state, 'awaiting-release-urls');
  assert.deepEqual(await readdir(release.out), ['release-inventory.json']);
  assert.deepEqual(updateConfiguration({}), {});
});

for (const invalid of [
  null, [], { manifestURL: config.manifestURL }, { ...config, teamIdentifier: 'bad-team' },
  { ...config, extra: true },
  ...['http://updates.example.test/latest.json', 'https://user:secret@updates.example.test/latest.json',
    'https://updates.example.test/latest.json?q=1', 'https://updates.example.test/latest.json#fragment',
    'https://updates.example.test/latest.yml'].map(manifestURL => ({ ...config, manifestURL })),
]) {
  test(`invalid release configuration is rejected: ${JSON.stringify(invalid)}`, async t => {
    const { release } = await fixture(t);
    await assert.rejects(writeDesktopRelease({ ...release, config: invalid }));
    await assert.rejects(readdir(release.out), { code: 'ENOENT' });
  });
}

for (const variant of ['missing zip', 'empty zip', 'linked zip', 'wrong version', 'wrong filename', 'dirty output']) {
  test(`release fails without producing a source: ${variant}`, async t => {
    const { root, put, release } = await fixture(t);
    if (variant === 'missing zip' || variant === 'linked zip') await rm(release.zip);
    if (variant === 'empty zip') await writeFile(release.zip, '');
    if (variant === 'linked zip') await symlink(release.dmg, release.zip);
    if (variant === 'wrong version') release.version = '0.8.0';
    if (variant === 'wrong filename') release.zip = join(root, 'wrong.zip');
    if (variant === 'dirty output') await put('metadata/stale.json', '{}');
    await assert.rejects(writeDesktopRelease(release));
    assert.deepEqual(await readdir(release.out).catch(() => []), variant === 'dirty output' ? ['stale.json'] : []);
  });
}

async function appFixture(t) {
  const h = await fixture(t);
  const app = join(h.root, 'Vonvon Bot.app');
  const core = 'Vonvon Bot.app/Contents/Resources/daemon/';
  await h.put(`${core}package.json`, JSON.stringify({ version, license: 'Apache-2.0' }));
  for (const name of ['LICENSE', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md']) await h.put(core + name, `third-party ${name}`);
  for (const path of ['Contents/MacOS/Vonvon Bot', 'Contents/Frameworks/Electron Framework.framework/Electron Framework',
    'Contents/Frameworks/Vonvon Helper.app/Contents/MacOS/Vonvon Helper']) {
    await h.put(`Vonvon Bot.app/${path}`, Buffer.from('cafebabe00000000', 'hex'));
  }
  const execute = async (command, args) => {
    if (command.endsWith('PlistBuddy')) return { stdout: `${version}\n`, stderr: '' };
    if (command.endsWith('lipo')) return { stdout: 'x86_64 arm64\n', stderr: '' };
    if (args.includes('--entitlements')) return { stdout: '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>', stderr: '' };
    return { stdout: '', stderr: `Authority=Developer ID Application: Test\nTeamIdentifier=${teamIdentifier}\nflags=0x10000(runtime)\n` };
  };
  return { ...h, app, core, execute, options: { app, version, teamIdentifier, execute } };
}

test('verification reads actual Core metadata, third-party declarations and every Mach-O', async t => {
  const h = await appFixture(t);
  const result = await verifyUniversalApp(h.options);
  assert.equal(result.architectures.length, 3);
  assert.equal(result.architectures.every(file => file.archs.length === 2), true);
  assert.deepEqual(result.entitlementChecks.map(entry => entry.entitlements), [
    { 'com.apple.security.cs.allow-jit': true }, { 'com.apple.security.cs.allow-jit': true },
  ]);
  await verifyDmg(h.release.dmg, teamIdentifier, h.execute);
});

for (const variant of ['Core version', 'first-party license', 'third-party declaration', 'bundled Claude', 'single arch', 'unsigned', 'wrong team', 'broad entitlements', 'false JIT', 'unknown entitlement']) {
  test(`verification refuses ${variant}`, async t => {
    const h = await appFixture(t);
    if (variant === 'Core version') await h.put(`${h.core}package.json`, JSON.stringify({ version: '0.1.0', license: 'Apache-2.0' }));
    if (variant === 'first-party license') await h.put(`${h.core}package.json`, JSON.stringify({ version, license: 'MIT' }));
    if (variant === 'third-party declaration') await rm(join(h.root, h.core, 'NOTICE'));
    if (variant === 'bundled Claude') await h.put(`${h.core}node_modules/@anthropic-ai/claude-agent-sdk/package.json`, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk' }));
    const execute = async (command, args) => {
      if (variant === 'unsigned' && args.includes('--verify')) throw new Error('invalid signature');
      if (variant === 'single arch' && command.endsWith('lipo')) return { stdout: 'arm64', stderr: '' };
      const result = await h.execute(command, args);
      if (variant === 'wrong team') result.stderr = result.stderr.replace(teamIdentifier, 'OTHERTEAM1');
      if (variant === 'broad entitlements' && args.includes('--entitlements')) result.stdout = result.stdout.replace('</dict>', '<key>com.apple.security.cs.disable-library-validation</key><true/></dict>');
      if (variant === 'false JIT' && args.includes('--entitlements')) result.stdout = result.stdout.replace('<true/>', '<false/>');
      if (variant === 'unknown entitlement' && args.includes('--entitlements')) result.stdout = result.stdout.replace('</dict>', '<key>com.apple.security.get-task-allow</key><true/></dict>');
      return result;
    };
    await assert.rejects(verifyUniversalApp({ ...h.options, execute }));
  });
}

test('version sync updates actual desktop and lock metadata while preserving independent API versions', async t => {
  const h = await fixture(t);
  await h.put('packages/daemon/package.json', JSON.stringify({ version: '2.3.4' }));
  await h.put('packages/desktop/package.json', JSON.stringify({ version: '0.1.0', license: 'Apache-2.0' }));
  await h.put('packages/protocol/package.json', JSON.stringify({ version: '0.1.0' }));
  await h.put('package-lock.json', JSON.stringify({ packages: { 'packages/desktop': { version: '0.1.0' }, 'packages/protocol': { version: '0.1.0' } } }));
  await assert.rejects(checkedProductVersion(h.root), /version mismatch/);
  await syncProductVersion(h.root);
  assert.equal(await checkedProductVersion(h.root), '2.3.4');
  assert.equal((await json(join(h.root, 'packages/desktop/package.json'))).version, '2.3.4');
  const lock = await json(join(h.root, 'package-lock.json'));
  assert.equal(lock.packages['packages/desktop'].version, '2.3.4');
  assert.equal(lock.packages['packages/protocol'].version, '0.1.0');
  assert.equal((await json(join(h.root, 'packages/protocol/package.json'))).version, '0.1.0');
});

test('reserved inventory filename cannot overwrite the updater manifest', async t => {
  const { release } = await fixture(t);
  await assert.rejects(writeDesktopRelease({
    ...release, config: { ...config, manifestURL: 'https://updates.example.test/releases/release-inventory.json' },
  }), /filenames must differ/);
  assert.deepEqual(await readdir(release.out), []);
});

for (const [architecture, mach] of [['arm64', 'arm64'], ['x64', 'x86_64']]) {
  test(`accepts only ${architecture} Mach-O files for a ${architecture} release`, async t => {
    const h = await appFixture(t);
    const execute = async (command, args) => command.endsWith('lipo') ? {stdout: mach, stderr: ''} : h.execute(command, args);
    const result = await verifyUniversalApp({ ...h.options, architecture, execute });
    assert.ok(result.architectures.every(file => file.archs.join() === mach));
    await assert.rejects(verifyUniversalApp({ ...h.options, architecture }), /architecture/);
  });
}

test('split feeds preserve the universal fallback for older clients', async t => {
  const h = await fixture(t);
  await writeDesktopRelease(h.release);
  const releases = {};
  for (const architecture of ['arm64', 'x64']) {
    const dmg = `Vonvon-Bot-${version}-${architecture}.dmg`;
    const zip = `Vonvon-Bot-${version}-${architecture}.zip`;
    await h.put(dmg, 'dmg'); await h.put(zip, 'zip');
    releases[architecture] = await writeDesktopRelease({ ...h.release, architecture, out: join(h.release.out, architecture), dmg: join(h.root, dmg), zip: join(h.root, zip) });
  }
  await writeSplitFeeds({ out: h.release.out, version, config, releases, publishedAt });
  const manifest = await json(join(h.release.out, 'latest.json'));
  assert.equal(manifest.feedURL, `https://updates.example.test/releases/feed-${version}.json`);
  for (const architecture of ['arm64', 'x64']) {
    assert.equal(manifest.feedURLs[architecture], `https://updates.example.test/releases/feed-${version}-${architecture}.json`);
    const feed = await json(join(h.release.out, `feed-${version}-${architecture}.json`));
    assert.equal(feed.url, `https://updates.example.test/releases/Vonvon-Bot-${version}-${architecture}.zip`);
  }
});
