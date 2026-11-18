import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PUBLISHED_TARGETS, archiveName, assembleRelease, checkServerTree, parseArguments, pinnedNodeFile, serverUpdateConfig, tarHeader, writeTarGz } from './build-server.mjs';
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

/** A staged app and an unpacked official Linux Node archive, all fake. */
async function sources(root) {
  const app = join(root, 'app-source');
  await put(app, 'package.json', '{"name":"@vonvon/daemon","version":"0.9.0"}');
  await put(app, 'bin/vonvon.mjs');
  await put(app, 'server-update.json', '{"publicKey":"","baseURL":"https://example.invalid/bot/server"}');
  await put(app, 'dist/cli.js', `var a=${'1+'.repeat(400)}1;`);
  for (const file of ['ui/dist/index.html', 'LICENSE', 'NOTICE', 'LICENSE.paseo', 'LICENSE.bridge', 'node_modules/dep/package.json']) await put(app, file);
  await put(app, 'node_modules/dep/src/index.js', 'module.exports = 1;');
  const linux = join(root, 'node-v0-linux-x64');
  for (const file of ['bin/node', 'bin/npx', 'LICENSE', 'include/node/node.h', 'lib/node_modules/npm/bin/npm-cli.js', 'lib/node_modules/npm/index.d.cts']) await put(linux, file);
  return { app, linux };
}

async function release(t, target) {
  const root = await scratch(t);
  const { app, linux } = await sources(root);
  const out = join(root, 'release');
  await assembleRelease({ app, runtime: linux, target, version: '0.9.0', nodeVersion: '24.0.0' }, out);
  return out;
}

test('a release has the app, the Node of its target with npm, and standalone.json', async t => {
  const [target, node, npm] = ['linux-x64', 'node/bin/node', 'node/lib/node_modules/npm'];
  const root = await release(t, target);
  const files = await checkServerTree(root, target);
  for (const file of [node, `${npm}/bin/npm-cli.js`, 'node/LICENSE', 'app/dist/cli.js', 'app/node_modules/dep/src/index.js']) assert.ok(files.includes(file), `${target}: ${file}`);
  assert.deepEqual(files.filter(file => file.startsWith('node/') && !file.startsWith(`${npm}/`)).sort(), ['node/LICENSE', node]);
  assert.equal(files.some(file => file.endsWith('.d.cts')), false);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'standalone.json'), 'utf8')), { v: 1, version: '0.9.0', target, node: '24.0.0' });
  // Windows keeps no execute bits, and the packages are not built there.
  if (process.platform !== 'win32') assert.equal((await stat(join(root, node))).mode & 0o111, 0o111);
});

// main 必败: packages carried no manifest key or address (server-3-update-engine C2)
test('server-update.json: the committed key makes a release build, a key or address given makes a test build', async t => {
  const root = await scratch(t);
  const committed = JSON.parse(await readFile(new URL('../packages/daemon/server-update.json', import.meta.url), 'utf8'));
  const placeholder = await serverUpdateConfig();
  assert.deepEqual(placeholder.config, committed);
  assert.equal(placeholder.updateKey, committed.publicKey ? 'release' : 'none');
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  await writeFile(join(root, 'key.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(join(root, 'key.txt'), `${raw}\n`);
  for (const file of ['key.pem', 'key.txt']) {
    assert.deepEqual(await serverUpdateConfig({ publicKeyFile: join(root, file), baseURL: 'http://127.0.0.1:9/bot/server' }), { config: { publicKey: raw, baseURL: 'http://127.0.0.1:9/bot/server' }, updateKey: 'test' });
  }
  assert.equal((await serverUpdateConfig({ baseURL: 'http://127.0.0.1:9/bot/server' })).updateKey, 'test');
  assert.equal((await serverUpdateConfig({ baseURL: 'http://127.0.0.1:9/bot/server' })).config.mirrorBaseURLs, undefined);
  assert.equal((await serverUpdateConfig({ publicKeyFile: join(root, 'key.txt') })).config.mirrorBaseURLs, undefined);
  await writeFile(join(root, 'bad.txt'), 'not a key');
  await assert.rejects(serverUpdateConfig({ publicKeyFile: join(root, 'bad.txt') }), /not an Ed25519 public key/);
});

test('a release archive carries the committed trusted mirrors for later standalone updates', async t => {
  const root = await scratch(t);
  const { app, linux } = await sources(root);
  const committed = JSON.parse(await readFile(new URL('../packages/daemon/server-update.json', import.meta.url), 'utf8'));
  const { config } = await serverUpdateConfig();
  assert.ok(committed.mirrorBaseURLs.length > 0, 'the Linux release has a global mirror');
  await writeFile(join(app, 'server-update.json'), JSON.stringify(config));
  const out = join(root, 'release');
  await assembleRelease({ app, runtime: linux, target: 'linux-x64', version: '0.9.0', nodeVersion: '24.0.0' }, out);
  const archive = join(root, 'release.tar.gz');
  await writeTarGz(out, await fileEntries(out), archive, 1_700_000_000);
  const packaged = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'app/server-update.json'], { encoding: 'utf8' }));
  assert.deepEqual(packaged, committed);
});

test('checkServerTree refuses what must not ship', async t => {
  const cases = [
    ['no manifest key file', root => rm(join(root, 'app/server-update.json')), /missing app\/server-update\.json/],
    ['a declaration file', root => put(root, 'app/node_modules/dep/index.d.ts'), /source, declaration or source map: app\/node_modules\/dep\/index\.d\.ts/],
    ['a source map', root => put(root, 'app/node_modules/dep/index.js.map'), /source map/],
    ['our source', root => put(root, 'app/src/index.js'), /unexpected app file: app\/src\/index\.js/],
    ['a second dist file', root => put(root, 'app/dist/cli.js.LICENSE.txt'), /unexpected app file/],
    ['a workspace package as files', root => put(root, 'app/node_modules/@vonvon/protocol/index.js'), /workspace package shipped as files/],
    ['a readable CLI', root => put(root, 'app/dist/cli.js', 'const a = 1;\n'.repeat(50)), /not minified/],
    ['a missing Node', root => rm(join(root, 'node/bin/node')), /missing node\/bin\/node/],
    ['a missing web UI', root => rm(join(root, 'app/ui'), { recursive: true }), /missing app\/ui\/dist\/index\.html/],
    ['a native module', root => put(root, 'app/node_modules/dep/addon.node'), /native module refused: app\/node_modules\/dep\/addon\.node/],
  ];
  if (process.platform !== 'win32') cases.push(['a symbolic link', root => symlink('node', join(root, 'node/bin/npm')), /symlink refused: node\/bin\/npm/]);
  for (const [name, change, problem] of cases) {
    const root = await release(t, 'linux-x64');
    await change(root);
    await assert.rejects(checkServerTree(root, 'linux-x64'), problem, name);
  }
});

test('tar.gz archives hold regular files only, with fixed owner, time and modes, and paths beyond 100 bytes', async t => {
  const root = await scratch(t);
  const deep = `app/node_modules/${'package-name/'.repeat(9)}index.js`;
  await put(root, 'tree/app/bin/vonvon.mjs', 'run');
  await put(root, `tree/${deep}`, 'deep');
  await chmod(join(root, 'tree/app/bin/vonvon.mjs'), 0o755);
  const entries = await fileEntries(join(root, 'tree'));
  // The archive takes each entry's mode. Windows has no execute bit to read it from (chmod only sets read-only), so there
  // the entry says it; elsewhere it must have come from the disk.
  const launcher = entries.find(entry => entry.path === 'app/bin/vonvon.mjs');
  if (process.platform === 'win32') launcher.mode = '755';
  else assert.equal(launcher.mode, '755');
  await writeTarGz(join(root, 'tree'), entries, join(root, 'out.tar.gz'), 1_700_000_000);
  // Windows tar.exe ends its lines with CRLF.
  const listing = execFileSync('tar', ['-tvzf', join(root, 'out.tar.gz')], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.equal(listing.length, 2);
  assert.match(listing.find(line => line.endsWith('vonvon.mjs')), /^-rwxr-xr-x/);
  assert.match(listing.find(line => line.endsWith('index.js')), /^-rw-r--r--/);
  const raw = gunzipSync(await readFile(join(root, 'out.tar.gz')));
  // mode, owner, group and time of the launcher's header, then of the deep file's
  for (const [header, mode] of [[0, '0000755'], [1024, '0000644']]) assert.deepEqual([raw.subarray(header + 100, header + 107).toString(), raw.subarray(header + 108, header + 115).toString(), raw.subarray(header + 116, header + 123).toString(), raw.subarray(header + 136, header + 147).toString()], [mode, '0000000', '0000000', (1_700_000_000).toString(8)]);
  await mkdir(join(root, 'unpacked'));
  execFileSync('tar', ['-xzf', join(root, 'out.tar.gz'), '-C', join(root, 'unpacked')]);
  assert.equal(await readFile(join(root, 'unpacked', deep), 'utf8'), 'deep');
  assert.throws(() => tarHeader(`${'x'.repeat(160)}/${'y'.repeat(101)}`, 0, 0o644, 0), /does not fit a ustar header/);
});

test('pinned Node files are checked on download and on every reuse', async t => {
  const root = await scratch(t);
  const bytes = Buffer.from('official node');
  const pins = { version: '24.0.0', files: { 'linux-arm64': { file: 'node-v24.0.0-linux-arm64.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex') } } };
  const urls = [];
  const fetchBytes = async url => { urls.push(url); return bytes; };
  const path = await pinnedNodeFile(pins, 'linux-arm64', root, fetchBytes);
  assert.equal(await pinnedNodeFile(pins, 'linux-arm64', root, fetchBytes), path);
  assert.deepEqual(urls, ['https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-arm64.tar.gz']);
  await writeFile(path, 'tampered');
  assert.equal(await readFile(await pinnedNodeFile(pins, 'linux-arm64', root, fetchBytes), 'utf8'), 'official node');
  await assert.rejects(pinnedNodeFile(pins, 'linux-arm64', join(root, 'other'), async () => Buffer.from('not node')), /does not match its SHA-256/);
  await assert.rejects(pinnedNodeFile(pins, 'linux-x64', root, fetchBytes), /no pin for linux-x64/);
});

test('every target has a pinned Node file and an archive name', async () => {
  const pins = JSON.parse(await readFile(new URL('./server-node.json', import.meta.url), 'utf8'));
  assert.match(pins.version, /^24\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(pins.files), PUBLISHED_TARGETS);
  for (const target of PUBLISHED_TARGETS) {
    assert.match(pins.files[target].sha256, /^[0-9a-f]{64}$/, target);
    assert.equal(pins.files[target].file, `node-v${pins.version}-${target}.tar.gz`);
  }
  assert.equal(archiveName('0.9.0', 'linux-arm64'), 'vonvon-server-0.9.0-linux-arm64.tar.gz');
});

// main 必败: four macOS and Windows targets were still built when named (owner 2026-11-01: Linux only, I6)
test('the two Linux targets are the only ones: built by default, one of them when named, nothing else', () => {
  assert.deepEqual(PUBLISHED_TARGETS, ['linux-x64', 'linux-arm64']);
  assert.deepEqual(parseArguments(['--out', '/tmp/server-out']).targets, PUBLISHED_TARGETS);
  assert.deepEqual(parseArguments(['--out', '/tmp/server-out', '--targets', 'linux-arm64']).targets, ['linux-arm64']);
  for (const target of ['linux-x86', 'darwin-arm64', 'win-x64']) {
    assert.throws(() => parseArguments(['--out', '/tmp/server-out', '--targets', target]), new RegExp(`unknown target ${target}`));
  }
});

// main 必败 on Windows: a URL's pathname there is /E:/…, which is not inside the repository, so the build went on to the
// clean-tree check (Windows acceptance task 205). allowDirty keeps the answer from depending on the worktree.
test('the build refuses an output or a Node cache inside the repository, and any build on Windows', async () => {
  const { buildServer } = await import('./build-server.mjs');
  const inside = fileURLToPath(new URL('../.server-out', import.meta.url));
  await assert.rejects(buildServer({ out: inside, targets: ['linux-x64'], allowDirty: true }), /\.server-out must be outside the repository/);
  await assert.rejects(buildServer({ out: join(tmpdir(), 'vonvon-server-out'), cache: inside, targets: ['linux-x64'], allowDirty: true }), /\.server-out must be outside the repository/);
  await assert.rejects(buildServer({ out: join(tmpdir(), 'vonvon-server-out'), targets: ['linux-x64'], allowDirty: true, platform: 'win32' }), /^Error: the server packages are built on Linux or macOS, not on Windows/);
});

// main 必败: npm ci rewrote the CRLF shebang line of a linked bin on a Windows checkout with core.autocrlf=true, and the
// build then refused the dirty tree (Windows acceptance task 205). .gitattributes keeps every package bin LF.
test('every package bin is checked out with LF', async () => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const { workspaces } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const bins = [];
  for (const workspace of ['.', ...workspaces]) {
    const { bin } = JSON.parse(await readFile(join(repo, workspace, 'package.json'), 'utf8'));
    for (const file of typeof bin === 'string' ? [bin] : Object.values(bin ?? {})) bins.push(posix.join(workspace, file));
  }
  assert.ok(bins.includes('packages/daemon/bin/vonvon.mjs'));
  const attributes = execFileSync('git', ['check-attr', 'eol', '--', ...bins], { cwd: repo, encoding: 'utf8' });
  for (const file of bins) assert.ok(attributes.includes(`${file}: eol: lf`), `${file} has no eol=lf in .gitattributes`);
});
