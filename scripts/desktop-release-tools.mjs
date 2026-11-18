import plist from 'plist';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { assertNoBundledClaude } from './desktop-backend-policy.mjs';
const exec = promisify(execFile);
const run = async (command, args) => exec(command, args, { timeout: 60000, maxBuffer: 1024 * 1024 });

export function updateConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid desktop update configuration');
  const keys = Object.keys(value);
  if (keys.length === 0) return {};
  if (keys.length !== 2 || !keys.includes('manifestURL') || !keys.includes('teamIdentifier')
    || typeof value.manifestURL !== 'string' || typeof value.teamIdentifier !== 'string' || !/^[A-Z0-9]{10}$/.test(value.teamIdentifier)) {
    throw new Error('Update configuration must contain only manifestURL and teamIdentifier');
  }
  const url = new URL(value.manifestURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('.json')) {
    throw new Error('Release manifest must be an HTTPS JSON URL without credentials, query or fragment');
  }
  return { manifestURL: url.href, teamIdentifier: value.teamIdentifier };
}

export async function artifactRecord(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Missing regular artifact: ${basename(path)}`);
  const file = await open(path, 'r');
  const hash = createHash('sha256');
  try { for await (const chunk of file.createReadStream()) hash.update(chunk); }
  finally { await file.close(); }
  return { file: basename(path), size: info.size, sha256: hash.digest('hex') };
}

const machoMagic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
async function machoFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await machoFiles(path));
    else if (entry.isFile()) {
      const handle = await open(path, 'r');
      try {
        const bytes = Buffer.alloc(4);
        await handle.read(bytes, 0, 4, 0);
        if (machoMagic.has(bytes.toString('hex'))) files.push(path);
        else if (/\.(?:node|dylib)$/.test(path)) throw new Error(`Non-macOS native dependency: ${entry.name}`);
      } finally { await handle.close(); }
    }
  }
  return files;
}

/** Inspect actual signed bytes, rather than trusting builder metadata or the filename. */
export async function verifyUniversalApp({ app, version, teamIdentifier, architecture = 'universal', execute = run }) {
  const expected = { universal: 'arm64,x86_64', arm64: 'arm64', x64: 'x86_64' }[architecture];
  if (!expected) throw new Error('Unsupported desktop architecture');
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier ?? '')) throw new Error('An expected signing TeamIdentifier is required');
  await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', app]);
  if (!stderr.split('\n').includes(`TeamIdentifier=${teamIdentifier}`)
    || !/^Authority=Developer ID Application:/m.test(stderr) || !/flags=.*\bruntime\b/.test(stderr)) {
    throw new Error('App must have the expected Developer ID signature and hardened runtime');
  }
  const { stdout: bundleVersion } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')]);
  const { stdout: buildVersion } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', join(app, 'Contents/Info.plist')]);
  const core = JSON.parse(await readFile(join(app, 'Contents/Resources/daemon/package.json'), 'utf8'));
  if (bundleVersion.trim() !== version || buildVersion.trim() !== version || core.version !== version || core.license !== 'Apache-2.0') {
    throw new Error('App/Core product version or first-party license mismatch');
  }
  await assertNoBundledClaude(join(app, 'Contents/Resources/daemon'));
  for (const name of ['LICENSE', 'LICENSE.bridge', 'LICENSE.paseo', 'NOTICE', 'PROVENANCE.md']) {
    if (!(await readFile(join(app, 'Contents/Resources/daemon', name))).length) throw new Error(`Missing ${name}`);
  }
  const paths = await machoFiles(app);
  if (!paths.some(path => path.includes('/Contents/MacOS/')) || !paths.some(path => path.includes('Electron Framework.framework/'))) {
    throw new Error('No complete Electron Mach-O runtime found in universal app');
  }
  const architectures = [];
  for (const path of paths) {
    const { stdout } = await execute('/usr/bin/lipo', ['-archs', path]);
    const archs = stdout.trim().split(/\s+/).sort();
    const relative = path.slice(app.length + 1);
    if (archs.join(',') !== expected) throw new Error(`Unexpected bundled runtime architecture: ${relative}`);
    await execute('/usr/bin/codesign', ['--verify', '--strict', path]);
    architectures.push({ path: path.slice(app.length + 1), archs });
  }
  const entitlementChecks = [];
  for (const path of [app, ...paths.filter(path => /Helper[^/]*\.app\/Contents\/MacOS\//.test(path))]) {
    const { stdout, stderr: entitlementError } = await execute('/usr/bin/codesign', ['--display', '--entitlements', ':-', path]);
    const xml = (stdout + entitlementError).match(/<\?xml[\s\S]*<\/plist>/)?.[0];
    const entitlements = xml ? plist.parse(xml) : undefined;
    if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)
      || Object.keys(entitlements).length !== 1 || entitlements['com.apple.security.cs.allow-jit'] !== true) {
      throw new Error('Electron entitlements do not match the minimal JIT policy');
    }
    entitlementChecks.push({ path: path === app ? '.' : path.slice(app.length + 1), entitlements });
  }
  return { signature: 'Developer ID Application', hardenedRuntime: true, architectures, entitlementChecks };
}

/** The existing NativeUpdateDriver uses Squirrel.Mac's default JSON endpoint, not latest-mac.yml. */
export async function writeDesktopRelease({ out, version, config: raw, dmg, zip, verifiedApp, architecture = 'universal', publishedAt = new Date().toISOString() }) {
  if (!['universal', 'arm64', 'x64'].includes(architecture)) throw new Error('Unsupported desktop architecture');
  const config = updateConfiguration(raw);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !Number.isFinite(Date.parse(publishedAt))) throw new Error('Invalid release version/date');
  const names = { dmg: `Vonvon-Bot-${version}-${architecture}.dmg`, zip: `Vonvon-Bot-${version}-${architecture}.zip` };
  if (basename(dmg) !== names.dmg || basename(zip) !== names.zip) throw new Error('Release artifact/version mismatch');
  const files = { dmg: await artifactRecord(dmg), zip: await artifactRecord(zip) };
  const inventory = { version, state: config.manifestURL ? 'local-configured' : 'awaiting-release-urls', files, verification: verifiedApp };
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error('Release metadata output must be empty; refusing stale update sources');
  if (config.manifestURL && architecture === 'universal') {
    const manifest = new URL(config.manifestURL);
    const feed = new URL(`feed-${version}.json`, manifest);
    const download = new URL(files.zip.file, manifest);
    if (feed.href === manifest.href || basename(manifest.pathname) === 'release-inventory.json') {
      throw new Error('Manifest, feed and inventory filenames must differ');
    }
    await writeFile(join(out, basename(manifest.pathname)), JSON.stringify({ version, feedURL: feed.href }, null, 2) + '\n');
    await writeFile(join(out, basename(feed.pathname)), JSON.stringify({
      url: download.href, name: `Vonvon Bot ${version}`, notes: '', pub_date: publishedAt,
    }, null, 2) + '\n');
  }
  await writeFile(join(out, 'release-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return inventory;
}

export async function verifyDmg(path, teamIdentifier, execute = run) {
  await execute('/usr/bin/codesign', ['--verify', '--strict', path]);
  const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', path]);
  if (!/^Authority=Developer ID Application:/m.test(stderr) || !stderr.split('\n').includes(`TeamIdentifier=${teamIdentifier}`)) throw new Error('DMG does not have the expected Developer ID signature');
}

/** Add architecture feeds to the legacy manifest after every signed artifact is verified.
 * Old clients ignore the extra field and keep using the universal feed. */
export async function writeSplitFeeds({ out, version, config: raw, releases, publishedAt = new Date().toISOString() }) {
  const config = updateConfiguration(raw);
  if (!config.manifestURL) return;
  const manifestURL = new URL(config.manifestURL);
  const manifestPath = join(out, basename(manifestURL.pathname));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== version || !manifest.feedURL) throw new Error('Legacy manifest is missing or stale');
  const feedURLs = {};
  for (const architecture of ['arm64', 'x64']) {
    const release = releases[architecture];
    const expected = `Vonvon-Bot-${version}-${architecture}.zip`;
    if (!release || release.files.zip.file !== expected || !release.verification) throw new Error(`Missing verified ${architecture} release`);
    const name = `feed-${version}-${architecture}.json`;
    feedURLs[architecture] = new URL(name, manifestURL).href;
    await writeFile(join(out, name), JSON.stringify({ url: new URL(expected, manifestURL).href, name: `Vonvon Bot ${version}`, notes: '', pub_date: publishedAt }, null, 2) + '\n', { flag: 'wx' });
  }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, feedURLs }, null, 2) + '\n');
}
