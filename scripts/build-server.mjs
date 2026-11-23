// Builds the standalone server packages (docs/plans/devices.md 7.1, 7.2; docs/plans/server-1-standalone.md).
// Each archive unpacks into releases/<version>/: app/ (the daemon, minified, with the web UI), node/ (official Node and
// its npm), standalone.json and build-manifest.json. Nothing is uploaded. Only Linux has a script-installed server
// (owner 2026-11-01): Mac and Windows get theirs inside the desktop app, so no package is built for them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { createPublicKey } from 'node:crypto';
import { assertNoBundledClaude } from './desktop-backend-policy.mjs';
import { fileEntries, listFiles, sha256 } from './package-tools.mjs';
import { checkedProductVersion } from './product-version.mjs';
import { PUBLISHED_TARGETS, archiveName } from './server-constants.mjs';
import { buildRecipeFiles } from './build-recipe-files.mjs';
import { stageDaemon } from './stage-daemon.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
/**
 * PUBLISHED_TARGETS: every package there is, built by default and published; the server manifest
 * (standalone-manifest.ts SERVER_TARGETS) and install.sh take exactly these two.
 */
export { PUBLISHED_TARGETS, archiveName };
/** TypeScript sources, declarations and source maps. */
const SOURCE_FILE = /\.(?:[mc]?ts|map)$/;
const APP_TOP = new Set(['package.json', 'bin', 'dist', 'ui', 'node_modules', 'NOTICE', 'LICENSE.bridge', 'LICENSE.paseo', 'PROVENANCE.md', 'import-core.json', 'server-update.json']);
/** Where Node and its npm sit inside an official Linux Node archive, and so inside the release's node/. */
const NODE = 'bin/node';
const NPM = 'lib/node_modules/npm';

/**
 * The manifest key and address each package carries as app/server-update.json (docs/plans/server-3-update-engine.md C2).
 * The release build copies packages/daemon/server-update.json; `--update-public-key` (raw base64 or SPKI PEM) and
 * `--update-base-url` make a test build, marked `updateKey: "test"`, which publishing refuses. Test builds omit the
 * production mirrors so checks against a test key or source cannot reach them. A committed key that is
 * not one yet (the placeholder before the signing key exists) marks the build `updateKey: "none"`.
 */
export async function serverUpdateConfig({ publicKeyFile, baseURL } = {}) {
  const committed = JSON.parse(await readFile(join(repository, 'packages/daemon/server-update.json'), 'utf8'));
  const text = publicKeyFile ? (await readFile(publicKeyFile, 'utf8')).trim() : committed.publicKey;
  const publicKey = text.startsWith('-----BEGIN') ? createPublicKey(text).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64') : text;
  const valid = Buffer.from(publicKey, 'base64').length === 32 && Buffer.from(publicKey, 'base64').toString('base64') === publicKey;
  if (publicKeyFile && !valid) throw new Error(`${publicKeyFile} is not an Ed25519 public key`);
  const testBuild = Boolean(publicKeyFile || baseURL);
  const config = { publicKey, baseURL: baseURL ?? committed.baseURL };
  if (!testBuild && committed.mirrorBaseURLs !== undefined) config.mirrorBaseURLs = committed.mirrorBaseURLs;
  return { config, updateKey: testBuild ? 'test' : valid ? 'release' : 'none' };
}

/** Downloads a pinned Node file once into `cache`; every use checks it against scripts/server-node.json. */
export async function pinnedNodeFile(pins, target, cache, fetchBytes = defaultFetch) {
  const { file, sha256: expected } = pins.files[target] ?? {};
  if (!file || !/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error(`scripts/server-node.json has no pin for ${target}`);
  const path = join(cache, file.replaceAll('/', '-'));
  try { if (sha256(await readFile(path)) === expected) return path; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = `https://nodejs.org/dist/v${pins.version}/${file}`;
  const bytes = await fetchBytes(url);
  if (sha256(bytes) !== expected) throw new Error(`${url} does not match its SHA-256 in scripts/server-node.json`);
  await mkdir(cache, { recursive: true });
  await writeFile(`${path}.tmp`, bytes);
  await rename(`${path}.tmp`, path);
  return path;
}

async function defaultFetch(url) {
  if (!url.startsWith('https://')) throw new Error(`refusing ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Unpacks an official Node archive (tar.gz) and returns its top directory. */
async function unpackNode(archive, into) {
  await mkdir(into, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', into]);
  const [top, ...rest] = await readdir(into);
  if (!top || rest.length) throw new Error(`${archive} does not have one top directory`);
  return join(into, top);
}

/**
 * One release directory. `runtime` is the unpacked official Node archive of the target itself. Only Node, npm and
 * LICENSE are taken; npx, corepack, include/ and share/ are left out, as nothing runs them and bin/npm is a symbolic link.
 */
export async function assembleRelease({ app, runtime, target, version, nodeVersion }, release) {
  await cp(app, join(release, 'app'), { recursive: true });
  await mkdir(dirname(join(release, 'node', NODE)), { recursive: true });
  await copyFile(join(runtime, NODE), join(release, 'node', NODE));
  await chmod(join(release, 'node', NODE), 0o755);
  // npm ships a few type declarations; no file of that kind goes into a server package.
  await cp(join(runtime, NPM), join(release, 'node', NPM), { recursive: true, filter: path => !SOURCE_FILE.test(path) });
  await copyFile(join(runtime, 'LICENSE'), join(release, 'node/LICENSE'));
  await writeFile(join(release, 'standalone.json'), JSON.stringify({ v: 1, version, target, node: nodeVersion }, null, 2) + '\n');
}

/** Refuses a release tree that is not safe to ship for `target`; returns its files. */
export async function checkServerTree(release, target) {
  const files = await listFiles(release); // refuses symbolic links and special files
  const problems = [];
  const required = ['standalone.json', 'app/package.json', 'app/bin/vonvon.mjs', 'app/dist/cli.js', 'app/dist/native/recipe-files', 'app/ui/dist/index.html', 'app/server-update.json',
    'app/NOTICE', 'app/LICENSE.paseo', 'app/LICENSE.bridge', 'node/LICENSE', `node/${NODE}`, `node/${NPM}/bin/npm-cli.js`];
  for (const file of required) if (!files.includes(file)) problems.push(`missing ${file}`);
  for (const file of files) {
    if (SOURCE_FILE.test(file)) problems.push(`source, declaration or source map: ${file}`);
    // One app serves every target, so nothing in it may be built for one platform.
    if (file.endsWith('.node')) problems.push(`native module refused: ${file}`);
    if (file.startsWith('app/') && !file.startsWith('app/node_modules/')) {
      const top = file.split('/')[1];
      if (!APP_TOP.has(top) || (top === 'dist' && file !== 'app/dist/cli.js' && file !== 'app/dist/native/recipe-files') || (top === 'ui' && !file.startsWith('app/ui/dist/'))) problems.push(`unexpected app file: ${file}`);
    }
    if (file.startsWith('app/node_modules/@vonvon/')) problems.push(`workspace package shipped as files: ${file}`);
  }
  if (files.includes('app/dist/cli.js')) {
    const cli = await readFile(join(release, 'app/dist/cli.js'), 'utf8');
    const lines = cli.split('\n').length;
    if (cli.length / lines < 400 || /sourceMappingURL/.test(cli)) problems.push('app/dist/cli.js is not minified');
    if (/\bfrom\s*["']@vonvon\/|\bimport\(\s*["']@vonvon\//.test(cli)) problems.push('app/dist/cli.js imports a workspace package at run time');
  }
  if (problems.length) throw new Error(`server package ${target} refused:\n  ${problems.join('\n  ')}`);
  return files;
}

const tarField = (value, length) => Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0', 'ascii');

/** A ustar header for a regular file; the path goes into name, or prefix and name. */
export function tarHeader(path, size, mode, mtime) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', path.length - 1);
    for (let at = cut; at > 0; at = path.lastIndexOf('/', at - 1)) {
      if (Buffer.byteLength(path.slice(at + 1)) <= 100 && Buffer.byteLength(path.slice(0, at)) <= 155) { prefix = path.slice(0, at); name = path.slice(at + 1); break; }
    }
    if (!prefix) throw new Error(`path does not fit a ustar header: ${path}`);
  }
  header.write(name, 0, 'utf8');
  tarField(mode, 8).copy(header, 100);
  tarField(0, 8).copy(header, 108);
  tarField(0, 8).copy(header, 116);
  tarField(size, 12).copy(header, 124);
  tarField(mtime, 12).copy(header, 136);
  header.fill(' ', 148, 156);
  header.write('0', 156, 'ascii');
  header.write('ustar\0' + '00', 257, 'ascii');
  header.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);
  return header;
}

/** A gzip-compressed ustar archive of `entries` (from fileEntries), in their sorted order, with fixed owners and times. */
export async function writeTarGz(root, entries, out, mtime) {
  async function* blocks() {
    for (const entry of entries) {
      const data = await readFile(join(root, entry.path));
      yield tarHeader(entry.path, data.length, parseInt(entry.mode, 8), mtime);
      yield data;
      if (data.length % 512) yield Buffer.alloc(512 - data.length % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(blocks()), createGzip({ level: 9 }), createWriteStream(out));
}

async function fileHashes(path) {
  const hashes = { sha256: createHash('sha256'), sha512: createHash('sha512') };
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hashes.sha256.update(chunk); hashes.sha512.update(chunk); }
  return { size, sha256: hashes.sha256.digest('hex'), sha512: hashes.sha512.digest('hex') };
}

export function parseArguments(args) {
  const options = { targets: PUBLISHED_TARGETS, allowDirty: false };
  for (let i = 0; i < args.length; i++) {
    const [name, value] = [args[i], args[i + 1]];
    if (name === '--allow-dirty') { options.allowDirty = true; continue; }
    if (!['--out', '--targets', '--node-cache', '--update-public-key', '--update-base-url'].includes(name) || !value) throw new Error('usage: build-server.mjs --out <dir> [--targets linux-x64,linux-arm64] [--node-cache <dir>] [--allow-dirty] [--update-public-key <file> --update-base-url <url>]');
    if (name === '--out') options.out = resolve(value);
    if (name === '--update-public-key') options.publicKeyFile = resolve(value);
    if (name === '--update-base-url') options.baseURL = value.replace(/\/+$/, '');
    if (name === '--node-cache') options.cache = resolve(value);
    if (name === '--targets') options.targets = value.split(',');
    i++;
  }
  if (!options.out) throw new Error('--out is required');
  for (const target of options.targets) if (!PUBLISHED_TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
  return options;
}

async function outsideRepository(path) {
  const repo = await realpath(repository);
  let existing = path;
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = dirname(existing); }
  }
  if (existing === repo || existing.startsWith(repo + sep)) throw new Error(`${path} must be outside the repository`);
}

export async function buildServer({ out, targets, cache, allowDirty, publicKeyFile, baseURL, platform = process.platform }) {
  await outsideRepository(out);
  if (cache) await outsideRepository(cache);
  // A tar.gz takes its modes from the disk, and Windows keeps no execute bits; nor can it unpack the links in Node's tar.gz.
  if (platform === 'win32') throw new Error('the server packages are built on Linux or macOS, not on Windows');
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  const sourceDirty = git(['status', '--porcelain']) !== '';
  if (sourceDirty && !allowDirty) throw new Error('the worktree has uncommitted changes; commit them or pass --allow-dirty (such a build must not be published)');
  try { await readFile(join(repository, 'packages/ui/dist/index.html')); }
  catch { throw new Error('packages/ui/dist is missing; run npm run build -w packages/ui first'); }
  const version = await checkedProductVersion();
  const daemon = JSON.parse(await readFile(join(repository, 'packages/daemon/package.json'), 'utf8'));
  const pins = JSON.parse(await readFile(join(repository, 'scripts/server-node.json'), 'utf8'));
  const sourceHead = git(['rev-parse', 'HEAD']);
  const mtime = Number(git(['log', '-1', '--format=%ct']));
  const work = await mkdtemp(join(tmpdir(), 'vonvon-server-'));
  try {
    const app = join(work, 'app');
    const staged = await stageDaemon(app, {
      name: '@vonvon/daemon', version, type: 'module', private: true, bin: { vonvon: 'bin/vonvon.mjs' },
      engines: daemon.engines, license: daemon.license, author: daemon.author, dependencies: daemon.dependencies,
    }, { hoist: true });
    await cp(join(repository, 'packages/ui/dist'), join(app, 'ui/dist'), { recursive: true });
    const update = await serverUpdateConfig({ publicKeyFile, baseURL });
    await writeFile(join(app, 'server-update.json'), JSON.stringify(update.config, null, 2) + '\n');
    await assertNoBundledClaude(app);
    const nodeCache = cache ?? join(work, 'node-cache');
    const summary = { version, sourceHead, sourceDirty, node: pins.version, updateKey: update.updateKey, update: update.config, external: staged.external, bundled: staged.bundled, files: {} };
    const lockfileSha256 = sha256(await readFile(join(repository, 'package-lock.json')));
    const esbuild = JSON.parse(await readFile(join(repository, 'node_modules/esbuild/package.json'), 'utf8')).version;
    await mkdir(out, { recursive: true });
    for (const target of targets) {
      const runtime = await unpackNode(await pinnedNodeFile(pins, target, nodeCache), join(work, 'node', target));
      const release = join(work, 'release', target);
      await assembleRelease({ app, runtime, target, version, nodeVersion: pins.version }, release);
      buildRecipeFiles(join(release, 'app/dist'), target);
      await checkServerTree(release, target);
      const manifest = { schema: 1, package: 'vonvon-server', version, target, node: pins.version, sourceHead, sourceDirty, lockfileSha256, buildNode: process.version, esbuild, files: await fileEntries(release) };
      await writeFile(join(release, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const entries = [...manifest.files, { path: 'build-manifest.json', mode: '644' }].sort((a, b) => a.path < b.path ? -1 : 1);
      const name = archiveName(version, target);
      await writeTarGz(release, entries, join(out, `${name}.tmp`), mtime);
      await rename(join(out, `${name}.tmp`), join(out, name));
      summary.files[target] = { name, ...await fileHashes(join(out, name)) };
      await rm(release, { recursive: true, force: true });
      await rm(join(work, 'node', target), { recursive: true, force: true });
      process.stderr.write(`built ${name}\n`);
    }
    const report = join(out, `vonvon-server-${version}-build.json`);
    await writeFile(report, JSON.stringify(summary, null, 2) + '\n');
    return { report, summary };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { report } = await buildServer(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${report}\n`);
}
