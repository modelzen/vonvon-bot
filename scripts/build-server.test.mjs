import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';
import { TARGETS, archiveName, assembleRelease, checkServerTree, pinnedNodeFile, tarHeader, unpackZip, writeTarGz, writeZip } from './build-server.mjs';
import { fileEntries } from './package-tools.mjs';

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-build-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, file, content = 'fixture') {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
}

/** A staged app and unpacked official Node archives for Linux and Windows, all fake. */
async function sources(root) {
  const app = join(root, 'app-source');
  await put(app, 'package.json', '{"name":"@vonvon/daemon","version":"0.9.0"}');
  await put(app, 'bin/vonvon.mjs');
  await put(app, 'dist/cli.js', `var a=${'1+'.repeat(400)}1;`);
  for (const file of ['ui/dist/index.html', 'NOTICE', 'LICENSE.paseo', 'LICENSE.bridge', 'node_modules/dep/package.json']) await put(app, file);
  await put(app, 'node_modules/dep/src/index.js', 'module.exports = 1;');
  const linux = join(root, 'node-v0-linux-x64');
  for (const file of ['bin/node', 'bin/npx', 'LICENSE', 'include/node/node.h', 'lib/node_modules/npm/bin/npm-cli.js', 'lib/node_modules/npm/index.d.cts']) await put(linux, file);
  const windows = join(root, 'node-v0-win-x64');
  for (const file of ['node.exe', 'npm.cmd', 'LICENSE', 'node_modules/npm/bin/npm-cli.js', 'node_modules/npm/index.d.cts']) await put(windows, file);
  await put(windows, 'node_modules/npm/bin/npm.cmd', '@ECHO off\r\n');
  return { app, linux, windows };
}

async function release(t, target) {
  const root = await scratch(t);
  const { app, linux, windows } = await sources(root);
  const out = join(root, 'release');
  await assembleRelease({ app, runtime: target.startsWith('win-') ? windows : linux, target, version: '0.9.0', nodeVersion: '24.0.0' }, out);
  return out;
}

test('a release has the app, the Node of its target with npm, and standalone.json', async t => {
  for (const [target, node, npm] of [['linux-x64', 'node/bin/node', 'node/lib/node_modules/npm'], ['win-x64', 'node/node.exe', 'node/node_modules/npm']]) {
    const root = await release(t, target);
    const files = await checkServerTree(root, target);
    for (const file of [node, `${npm}/bin/npm-cli.js`, 'node/LICENSE', 'app/dist/cli.js', 'app/node_modules/dep/src/index.js']) assert.ok(files.includes(file), `${target}: ${file}`);
    assert.deepEqual(files.filter(file => file.startsWith('node/') && !file.startsWith(`${npm}/`)).sort(), ['node/LICENSE', node]);
    assert.equal(files.some(file => file.endsWith('.d.cts')), false);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'standalone.json'), 'utf8')), { v: 1, version: '0.9.0', target, node: '24.0.0' });
    assert.equal((await stat(join(root, node))).mode & 0o111, 0o111);
  }
  // Windows npm keeps the CRLF launchers of the official Windows archive.
  assert.equal(await readFile(join(await release(t, 'win-x64'), 'node/node_modules/npm/bin/npm.cmd'), 'utf8'), '@ECHO off\r\n');
});

const caseSensitive = async root => {
  await put(root, 'Case');
  try { await stat(join(root, 'case')); return false; } catch { return true; }
};

test('checkServerTree refuses what must not ship', async t => {
  const cases = [
    ['a declaration file', root => put(root, 'app/node_modules/dep/index.d.ts'), /source, declaration or source map: app\/node_modules\/dep\/index\.d\.ts/],
    ['a source map', root => put(root, 'app/node_modules/dep/index.js.map'), /source map/],
    ['our source', root => put(root, 'app/src/index.js'), /unexpected app file: app\/src\/index\.js/],
    ['a second dist file', root => put(root, 'app/dist/cli.js.LICENSE.txt'), /unexpected app file/],
    ['a workspace package as files', root => put(root, 'app/node_modules/@vonvon/protocol/index.js'), /workspace package shipped as files/],
    ['a readable CLI', root => put(root, 'app/dist/cli.js', 'const a = 1;\n'.repeat(50)), /not minified/],
    ['a missing Node', root => rm(join(root, 'node/bin/node')), /missing node\/bin\/node/],
    ['a missing web UI', root => rm(join(root, 'app/ui'), { recursive: true }), /missing app\/ui\/dist\/index\.html/],
  ];
  if (process.platform !== 'win32') cases.push(['a symbolic link', root => symlink('node', join(root, 'node/bin/npm')), /symlink refused: node\/bin\/npm/]);
  if (await caseSensitive(await scratch(t))) cases.push(['names that differ only in case', async root => { await put(root, 'app/node_modules/dep/README'); await put(root, 'app/node_modules/dep/readme'); }, /differ only in case/]);
  for (const [name, change, problem] of cases) {
    const root = await release(t, 'linux-x64');
    await change(root);
    await assert.rejects(checkServerTree(root, 'linux-x64'), problem, name);
  }
});

test('Windows packages keep every path inside the 260-character budget; other targets do not need to', async t => {
  const long = `app/node_modules/dep/${'d'.repeat(150)}.js`;
  const windows = await release(t, 'win-x64');
  await put(windows, long);
  await assert.rejects(checkServerTree(windows, 'win-x64'), /path too long for Windows/);
  const linux = await release(t, 'linux-x64');
  await put(linux, long);
  await checkServerTree(linux, 'linux-x64');
});

test('tar.gz archives hold regular files only, with fixed owner, time and modes, and paths beyond 100 bytes', async t => {
  const root = await scratch(t);
  const deep = `app/node_modules/${'package-name/'.repeat(9)}index.js`;
  await put(root, 'tree/app/bin/vonvon.mjs', 'run');
  await put(root, `tree/${deep}`, 'deep');
  await chmod(join(root, 'tree/app/bin/vonvon.mjs'), 0o755);
  const entries = await fileEntries(join(root, 'tree'));
  await writeTarGz(join(root, 'tree'), entries, join(root, 'out.tar.gz'), 1_700_000_000);
  const listing = execFileSync('tar', ['-tvzf', join(root, 'out.tar.gz')], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(listing.length, 2);
  assert.match(listing.find(line => line.endsWith('vonvon.mjs')), /^-rwxr-xr-x/);
  assert.match(listing.find(line => line.endsWith('index.js')), /^-rw-r--r--/);
  const raw = gunzipSync(await readFile(join(root, 'out.tar.gz')));
  for (const header of [0, 1024]) assert.deepEqual([raw.subarray(header + 108, header + 115).toString(), raw.subarray(header + 116, header + 123).toString(), raw.subarray(header + 136, header + 147).toString()], ['0000000', '0000000', (1_700_000_000).toString(8)]);
  await mkdir(join(root, 'unpacked'));
  execFileSync('tar', ['-xzf', join(root, 'out.tar.gz'), '-C', join(root, 'unpacked')]);
  assert.equal(await readFile(join(root, 'unpacked', deep), 'utf8'), 'deep');
  assert.throws(() => tarHeader(`${'x'.repeat(160)}/${'y'.repeat(101)}`, 0, 0o644, 0), /does not fit a ustar header/);
});

/** Reads a zip through its central directory, as Expand-Archive does. */
function readZip(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const [method, crc, size, nameLength, offset] = [bytes.readUInt16LE(at + 10), bytes.readUInt32LE(at + 16), bytes.readUInt32LE(at + 20), bytes.readUInt16LE(at + 28), bytes.readUInt32LE(at + 42)];
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const body = bytes.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(crc32(data), crc, name);
    files.set(name, data.toString('utf8'));
    at += 46 + nameLength;
  }
  return files;
}

test('zip archives list every file with its content', async t => {
  const root = await scratch(t);
  await put(root, 'tree/node/node.exe', 'MZ');
  await put(root, 'tree/app/dist/cli.js', 'x'.repeat(5000));
  await writeZip(join(root, 'tree'), await fileEntries(join(root, 'tree')), join(root, 'out.zip'), 1_700_000_000);
  assert.deepEqual(readZip(await readFile(join(root, 'out.zip'))), new Map([['app/dist/cli.js', 'x'.repeat(5000)], ['node/node.exe', 'MZ']]));
});

test('unpackZip reads a zip back and refuses unsafe or damaged entries', async t => {
  const root = await scratch(t);
  await put(root, 'tree/node-v0-win-x64/node.exe', 'MZ');
  await put(root, 'tree/node-v0-win-x64/node_modules/npm/bin/npm-cli.js', 'x'.repeat(5000));
  await writeZip(join(root, 'tree'), await fileEntries(join(root, 'tree')), join(root, 'good.zip'), 1_700_000_000);
  await unpackZip(join(root, 'good.zip'), join(root, 'good'));
  assert.equal(await readFile(join(root, 'good/node-v0-win-x64/node.exe'), 'utf8'), 'MZ');
  assert.equal(await readFile(join(root, 'good/node-v0-win-x64/node_modules/npm/bin/npm-cli.js'), 'utf8'), 'x'.repeat(5000));
  await put(root, 'outside', 'kept');
  await put(root, 'tree/etc/passwd', 'absolute');
  const unsafe = [['parent', '../outside'], ['absolute', '/etc/passwd']];
  if (process.platform !== 'win32') { await put(root, 'tree/a\\b', 'backslash'); unsafe.push(['backslash', 'a\\b']); }
  for (const [name, path] of unsafe) {
    await writeZip(join(root, 'tree'), [{ path, mode: '644' }], join(root, `${name}.zip`), 1_700_000_000);
    await assert.rejects(unpackZip(join(root, `${name}.zip`), join(root, name)), /unsafe entry/, name);
  }
  assert.equal(await readFile(join(root, 'outside'), 'utf8'), 'kept');
  const damaged = await readFile(join(root, 'good.zip'));
  damaged[30 + 'node-v0-win-x64/node.exe'.length] ^= 1; // the first entry, stored
  await writeFile(join(root, 'damaged.zip'), damaged);
  await assert.rejects(unpackZip(join(root, 'damaged.zip'), join(root, 'damaged')), /node\.exe is damaged/);
});

test('pinned Node files are checked on download and on every reuse', async t => {
  const root = await scratch(t);
  const bytes = Buffer.from('official node');
  const pins = { version: '24.0.0', files: { 'win-x64': { file: 'node-v24.0.0-win-x64.zip', sha256: createHash('sha256').update(bytes).digest('hex') } } };
  const urls = [];
  const fetchBytes = async url => { urls.push(url); return bytes; };
  const path = await pinnedNodeFile(pins, 'win-x64', root, fetchBytes);
  assert.equal(await pinnedNodeFile(pins, 'win-x64', root, fetchBytes), path);
  assert.deepEqual(urls, ['https://nodejs.org/dist/v24.0.0/node-v24.0.0-win-x64.zip']);
  await writeFile(path, 'tampered');
  assert.equal(await readFile(await pinnedNodeFile(pins, 'win-x64', root, fetchBytes), 'utf8'), 'official node');
  await assert.rejects(pinnedNodeFile(pins, 'win-x64', join(root, 'other'), async () => Buffer.from('not node')), /does not match its SHA-256/);
  await assert.rejects(pinnedNodeFile(pins, 'linux-x64', root, fetchBytes), /no pin for linux-x64/);
});

test('every target has a pinned Node file and an archive name', async () => {
  const pins = JSON.parse(await readFile(new URL('./server-node.json', import.meta.url), 'utf8'));
  assert.match(pins.version, /^24\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(pins.files).sort(), [...TARGETS].sort());
  for (const target of TARGETS) {
    assert.match(pins.files[target].sha256, /^[0-9a-f]{64}$/, target);
    assert.equal(pins.files[target].file, `node-v${pins.version}-${target}.${target.startsWith('win-') ? 'zip' : 'tar.gz'}`);
  }
  assert.equal(archiveName('0.9.0', 'linux-arm64'), 'vonvon-server-0.9.0-linux-arm64.tar.gz');
  assert.equal(archiveName('0.9.0', 'win-arm64'), 'vonvon-server-0.9.0-win-arm64.zip');
});

test('the build refuses an output inside the repository', async () => {
  const { buildServer } = await import('./build-server.mjs');
  await assert.rejects(buildServer({ out: new URL('../.server-out', import.meta.url).pathname, targets: ['linux-x64'] }), /must be outside the repository/);
});
