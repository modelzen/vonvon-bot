// Builds the standalone server packages (docs/plans/devices.md 7.1, 7.2; docs/plans/server-1-standalone.md).
// Each archive unpacks into releases/<version>/: app/ (the daemon, minified, with the web UI), node/ (official Node and
// its npm), standalone.json and build-manifest.json. Nothing is uploaded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { crc32, createGzip, deflateRawSync, inflateRawSync } from 'node:zlib';
import { assertNoBundledClaude } from './desktop-backend-policy.mjs';
import { fileEntries, listFiles, sha256 } from './package-tools.mjs';
import { checkedProductVersion } from './product-version.mjs';
import { stageDaemon } from './stage-daemon.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win-x64', 'win-arm64'];
export const isWindowsTarget = target => target.startsWith('win-');
export const archiveName = (version, target) => `vonvon-server-${version}-${target}.${isWindowsTarget(target) ? 'zip' : 'tar.gz'}`;
// PowerShell 5.1 Expand-Archive is held to 260 characters. 100 covers
// C:\Users\<20-character name>\AppData\Local\VonvonBot\server\releases\<version>.part\ with room to spare.
export const WINDOWS_PREFIX = 100;
/** TypeScript sources, declarations and source maps. */
const SOURCE_FILE = /\.(?:[mc]?ts|map)$/;
const APP_TOP = new Set(['package.json', 'bin', 'dist', 'ui', 'node_modules', 'NOTICE', 'LICENSE.bridge', 'LICENSE.paseo', 'PROVENANCE.md', 'import-core.json']);

/** Where Node and its npm sit inside an official Node archive of `target`, and so inside the release's node/. */
export function nodeLayout(target) {
  return isWindowsTarget(target) ? { node: 'node.exe', npm: 'node_modules/npm' } : { node: 'bin/node', npm: 'lib/node_modules/npm' };
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

/**
 * Unpacks a zip read through its central directory: stored or deflated entries only, CRC checked, no ZIP64, encryption,
 * absolute paths, backslashes or `..`. Enough for the official Windows Node archive; nothing else is unpacked with it.
 */
export async function unpackZip(archive, into) {
  const bytes = await readFile(archive);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw new Error(`${archive} is not a zip`);
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error(`${archive} needs ZIP64`);
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error(`${archive}: bad central directory`);
    const u16 = field => bytes.readUInt16LE(at + field);
    const u32 = field => bytes.readUInt32LE(at + field);
    const [flags, method, crc, size, length, nameLength, extra, comment, offset] = [u16(8), u16(10), u32(16), u32(20), u32(24), u16(28), u16(30), u16(32), u32(42)];
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extra + comment;
    if (name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error(`${archive}: unsafe entry ${name}`);
    if (flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || length === 0xffffffff) throw new Error(`${archive}: unsupported entry ${name}`);
    const target = join(into, name);
    if (name.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
    if (bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error(`${archive}: bad local header for ${name}`);
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = bytes.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : body;
    if (data.length !== length || crc32(data) !== crc) throw new Error(`${archive}: ${name} is damaged`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx' });
  }
}

/** Unpacks an official Node archive (tar.gz, or zip for Windows) and returns its top directory. */
async function unpackNode(archive, into) {
  await mkdir(into, { recursive: true });
  if (archive.endsWith('.zip')) await unpackZip(archive, into);
  else execFileSync('tar', ['-xzf', archive, '-C', into]);
  const [top, ...rest] = await readdir(into);
  if (!top || rest.length) throw new Error(`${archive} does not have one top directory`);
  return join(into, top);
}

/**
 * One release directory. `runtime` is the unpacked official Node archive of the target itself: Windows archives carry
 * npm with CRLF line ends and their own .cmd launchers, so no target borrows npm from another. Only Node, npm and
 * LICENSE are taken; npx, corepack, include/ and share/ are left out, as nothing runs them and bin/npm is a symbolic link.
 */
export async function assembleRelease({ app, runtime, target, version, nodeVersion }, release) {
  const layout = nodeLayout(target);
  await cp(app, join(release, 'app'), { recursive: true });
  await mkdir(dirname(join(release, 'node', layout.node)), { recursive: true });
  await copyFile(join(runtime, layout.node), join(release, 'node', layout.node));
  await chmod(join(release, 'node', layout.node), 0o755);
  // npm ships a few type declarations; no file of that kind goes into a server package.
  await cp(join(runtime, layout.npm), join(release, 'node', layout.npm), { recursive: true, filter: path => !SOURCE_FILE.test(path) });
  await copyFile(join(runtime, 'LICENSE'), join(release, 'node/LICENSE'));
  await writeFile(join(release, 'standalone.json'), JSON.stringify({ v: 1, version, target, node: nodeVersion }, null, 2) + '\n');
}

/** Refuses a release tree that is not safe to ship for `target`; returns its files. */
export async function checkServerTree(release, target) {
  const files = await listFiles(release); // refuses symbolic links and special files
  const problems = [];
  const layout = nodeLayout(target);
  const required = ['standalone.json', 'app/package.json', 'app/bin/vonvon.mjs', 'app/dist/cli.js', 'app/ui/dist/index.html',
    'app/NOTICE', 'app/LICENSE.paseo', 'app/LICENSE.bridge', 'node/LICENSE', `node/${layout.node}`, `node/${layout.npm}/bin/npm-cli.js`];
  for (const file of required) if (!files.includes(file)) problems.push(`missing ${file}`);
  const folded = new Map();
  for (const file of files) {
    if (SOURCE_FILE.test(file)) problems.push(`source, declaration or source map: ${file}`);
    if (file.startsWith('app/') && !file.startsWith('app/node_modules/')) {
      const top = file.split('/')[1];
      if (!APP_TOP.has(top) || (top === 'dist' && file !== 'app/dist/cli.js') || (top === 'ui' && !file.startsWith('app/ui/dist/'))) problems.push(`unexpected app file: ${file}`);
    }
    if (file.startsWith('app/node_modules/@vonvon/')) problems.push(`workspace package shipped as files: ${file}`);
    const key = file.toLowerCase();
    if (folded.has(key)) problems.push(`names differ only in case: ${folded.get(key)} and ${file}`);
    folded.set(key, file);
    if (isWindowsTarget(target) && WINDOWS_PREFIX + file.length >= 260) problems.push(`path too long for Windows: ${file}`);
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

/** A zip archive (deflate, UTF-8 names, no ZIP64) of `entries`, for PowerShell's Expand-Archive. */
export async function writeZip(root, entries, out, mtime) {
  if (entries.length >= 0xffff) throw new Error('too many files for a zip without ZIP64');
  const when = new Date(mtime * 1000);
  const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const dosDate = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const file = await open(out, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const data = await readFile(join(root, entry.path));
      const deflated = deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const name = Buffer.from(entry.path, 'utf8');
      const fields = Buffer.alloc(26);
      fields.writeUInt16LE(20, 0); fields.writeUInt16LE(0x0800, 2); fields.writeUInt16LE(stored ? 0 : 8, 4);
      fields.writeUInt16LE(dosTime, 6); fields.writeUInt16LE(dosDate, 8); fields.writeUInt32LE(crc32(data), 10);
      fields.writeUInt32LE(body.length, 14); fields.writeUInt32LE(data.length, 18); fields.writeUInt16LE(name.length, 22);
      const local = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), fields, name]);
      if (offset + local.length + body.length > 0xffffffff) throw new Error('archive too large for a zip without ZIP64');
      await file.write(local); await file.write(body);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); fields.copy(record, 6, 0, 26);
      record.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([record, name]));
      offset += local.length + body.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    await file.write(directory); await file.write(end);
  } finally { await file.close(); }
}

async function fileHashes(path) {
  const hashes = { sha256: createHash('sha256'), sha512: createHash('sha512') };
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hashes.sha256.update(chunk); hashes.sha512.update(chunk); }
  return { size, sha256: hashes.sha256.digest('hex'), sha512: hashes.sha512.digest('hex') };
}

function parseArguments(args) {
  const options = { targets: TARGETS, allowDirty: false };
  for (let i = 0; i < args.length; i++) {
    const [name, value] = [args[i], args[i + 1]];
    if (name === '--allow-dirty') { options.allowDirty = true; continue; }
    if (!['--out', '--targets', '--node-cache'].includes(name) || !value) throw new Error('usage: build-server.mjs --out <dir> [--targets linux-x64,...] [--node-cache <dir>] [--allow-dirty]');
    if (name === '--out') options.out = resolve(value);
    if (name === '--node-cache') options.cache = resolve(value);
    if (name === '--targets') options.targets = value.split(',');
    i++;
  }
  if (!options.out) throw new Error('--out is required');
  for (const target of options.targets) if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
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

export async function buildServer({ out, targets, cache, allowDirty }) {
  await outsideRepository(out);
  if (cache) await outsideRepository(cache);
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
    await assertNoBundledClaude(app);
    const nodeCache = cache ?? join(work, 'node-cache');
    const summary = { version, sourceHead, sourceDirty, node: pins.version, external: staged.external, bundled: staged.bundled, files: {} };
    const lockfileSha256 = sha256(await readFile(join(repository, 'package-lock.json')));
    const esbuild = JSON.parse(await readFile(join(repository, 'node_modules/esbuild/package.json'), 'utf8')).version;
    await mkdir(out, { recursive: true });
    for (const target of targets) {
      const runtime = await unpackNode(await pinnedNodeFile(pins, target, nodeCache), join(work, 'node', target));
      const release = join(work, 'release', target);
      await assembleRelease({ app, runtime, target, version, nodeVersion: pins.version }, release);
      await checkServerTree(release, target);
      const manifest = { schema: 1, package: 'vonvon-server', version, target, node: pins.version, sourceHead, sourceDirty, lockfileSha256, buildNode: process.version, esbuild, files: await fileEntries(release) };
      await writeFile(join(release, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const entries = [...manifest.files, { path: 'build-manifest.json', mode: '644' }].sort((a, b) => a.path < b.path ? -1 : 1);
      const name = archiveName(version, target);
      await (isWindowsTarget(target) ? writeZip : writeTarGz)(release, entries, join(out, `${name}.tmp`), mtime);
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
