import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundledWorkspaces, stageDaemon, stageDependencies } from './stage-daemon.mjs';

const sdk = '@anthropic-ai/claude-agent-sdk';

test('Windows hoisting keeps deep transitive dependencies installable without links', async t => {
  const {source, destination, pkg} = await fixture(t);
  for (let i = 0; i < 12; i++) {
    const next = i === 11 ? 'dunder-proto' : `level-${i + 1}`;
    const current = await pkg(`level-${i}`, {dependencies: {[next]: '1'}});
    await writeFile(join(current, 'index.cjs'), `module.exports = require(${JSON.stringify(next)});`);
  }
  const leaf = await pkg('dunder-proto', {exports: {'.': './get.js'}});
  await writeFile(join(leaf, 'get.js'), "module.exports = 'all runtime files installed';");
  await stageDependencies(source, destination, {hoist: true, metadata: {dependencies: {'level-0': '1'}}});
  const moved = `${destination}-installed`;
  await rename(destination, moved);
  await rm(source, {recursive: true, force: true});
  assert.equal(createRequire(join(moved, 'package.json'))('level-0'), 'all runtime files installed');
  assert.equal(await assertInternalLinks(moved), 0);
  assert.equal(await readFile(join(moved, 'node_modules/dunder-proto/get.js'), 'utf8'), "module.exports = 'all runtime files installed';");
  assert.equal((await readdir(join(moved, 'node_modules'))).length, 13);
});

test('Windows hoisting preserves nested version conflicts and package cycles', async t => {
  const {source, destination, pkg} = await fixture(t);
  const left = await pkg('left', {dependencies: {shared: '1', right: '1'}});
  const right = await pkg('right', {dependencies: {shared: '2', left: '1'}});
  const shared = await pkg('shared');
  await writeFile(join(shared, 'index.cjs'), "module.exports = 'one';");
  const nested = await pkg('shared', {version: '2.0.0'}, right);
  await writeFile(join(nested, 'index.cjs'), "module.exports = 'two';");
  await writeFile(join(left, 'index.cjs'), "exports.value = require('shared'); exports.right = () => require('right').value;");
  await writeFile(join(right, 'index.cjs'), "exports.value = require('shared'); exports.left = () => require('left').value;");
  await stageDependencies(source, destination, {hoist: true, metadata: {dependencies: {left: '1', right: '1'}}});
  await rm(source, {recursive: true, force: true});
  const appRequire = createRequire(join(destination, 'package.json'));
  assert.equal(appRequire('left').value, 'one');
  assert.equal(appRequire('left').right(), 'two');
  assert.equal(appRequire('right').left(), 'one');
  assert.equal(await assertInternalLinks(destination), 0);
});

test('Windows hoisting cannot shadow an earlier sibling dependency from a higher scope', async t => {
  const {source, destination, pkg} = await fixture(t);
  const x1 = await pkg('x'); await writeFile(join(x1, 'index.cjs'), "module.exports = 'x1';");
  await pkg('b'); await pkg('c');
  const a = await pkg('a', {dependencies: {b: '1'}});
  const b = await pkg('b', {dependencies: {x: '1', c: '1'}}, a);
  const c = await pkg('c', {dependencies: {x: '2'}}, b);
  const x2 = await pkg('x', {}, c); await writeFile(join(x2, 'index.cjs'), "module.exports = 'x2';");
  await writeFile(join(a, 'index.cjs'), "module.exports = require('b');");
  await writeFile(join(b, 'index.cjs'), "module.exports = {x: require('x'), c: require('c')};");
  await writeFile(join(c, 'index.cjs'), "module.exports = require('x');");
  await stageDependencies(source, destination, {hoist: true, metadata: {dependencies: {x: '1', b: '0', c: '0', a: '1'}}});
  await rm(source, {recursive: true, force: true});
  assert.deepEqual(createRequire(join(destination, 'package.json'))('a'), {x: 'x1', c: 'x2'});
});

test('Windows hoisting refuses a conflicting nested peer instead of changing its identity', async t => {
  const {source, destination, pkg} = await fixture(t);
  const peer1 = await pkg('peer'); await writeFile(join(peer1, 'index.cjs'), "module.exports = 'peer1';");
  const a = await pkg('a', {dependencies: {plugin: '1', peer: '2'}});
  const peer2 = await pkg('peer', {}, a); await writeFile(join(peer2, 'index.cjs'), "module.exports = 'peer2';");
  const plugin = await pkg('plugin', {peerDependencies: {peer: '2', 'optional-peer': '1'}, peerDependenciesMeta: {'optional-peer': {optional: true}}}, a);
  await writeFile(join(plugin, 'index.cjs'), "module.exports = require('peer');");
  await writeFile(join(a, 'index.cjs'), "module.exports = require('plugin');");
  await assert.rejects(stageDependencies(source, destination, {hoist: true, metadata: {dependencies: {peer: '1', a: '1'}}}), /Cannot preserve peer instance/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-stage-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'isolated-app');
  async function pkg(name, metadata = {}, parent = source) {
    const path = name ? join(parent, 'node_modules', name) : source;
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'package.json'), JSON.stringify({name: name || 'daemon', version: '1.0.0', main: 'index.cjs', ...metadata}));
    await writeFile(join(path, 'index.cjs'), 'module.exports = true;');
    return path;
  }
  await pkg('', {devDependencies: {[sdk]: '1.0.0'}});
  return {source, destination, pkg};
}

test('desktop stages the SDK, native runtime and required peers outside the source tree', async t => {
  const {source, destination, pkg} = await fixture(t);
  await pkg(sdk, {peerDependencies: {'sdk-peer': '1'}, optionalDependencies: {'sdk-native': '1', 'other-platform': '1'}});
  await pkg('sdk-peer', {dependencies: {'peer-child': '1'}});
  await pkg('peer-child');
  await pkg('sdk-native');
  await stageDependencies(source, destination, {metadata: {dependencies: {[sdk]: '1.0.0'}}});
  const appRequire = createRequire(join(destination, 'package.json'));
  const sdkRequire = createRequire(appRequire.resolve(sdk));
  assert.equal(sdkRequire('sdk-peer'), true);
  assert.equal(sdkRequire('sdk-native'), true);
  assert.match(sdkRequire.resolve('sdk-peer'), /isolated-app/);
  const peerRequire = createRequire(sdkRequire.resolve('sdk-peer'));
  assert.equal(peerRequire('peer-child'), true);
  assert.equal(JSON.parse(await readFile(join(destination, 'node_modules', sdk, 'package.json'))).version, '1.0.0');
});

test('a missing required SDK peer fails packaging instead of shipping a broken Provider', async t => {
  const {source, destination, pkg} = await fixture(t);
  await pkg(sdk, {peerDependencies: {'required-sdk-peer': '1'}});
  await assert.rejects(stageDependencies(source, destination, {metadata: {dependencies: {[sdk]: '1.0.0'}}}), /required-sdk-peer/);
});

test('CLI staging does not silently include development-only SDK packages', async t => {
  const {source, destination, pkg} = await fixture(t);
  await pkg(sdk);
  await stageDependencies(source, destination, {metadata: {dependencies: {}}});
  assert.throws(() => createRequire(join(destination, 'package.json')).resolve(sdk), /Cannot find module/);
});

async function assertInternalLinks(root) {
  root = await realpath(root);
  let links = 0;
  async function walk(path) {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        links += 1;
        const target = await readlink(child);
        assert.equal(isAbsolute(target), false, `absolute symlink: ${child}`);
        const resolved = await realpath(resolve(dirname(child), target));
        const within = relative(root, resolved);
        assert.ok(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), `external symlink: ${child}`);
      } else if (entry.isDirectory()) {
        await walk(child);
      }
    }
  }
  await walk(root);
  return links;
}

async function addFile(root, file, contents = 'fixture') {
  await mkdir(dirname(join(root, file)), {recursive: true});
  await writeFile(join(root, file), contents);
}

test('compact staging deduplicates a diamond and remains self-contained after relocation', {skip: process.platform === 'win32' && 'POSIX compact layout uses symlinks; Windows uses hoisting'}, async t => {
  const {source, destination, pkg} = await fixture(t);
  const left = await pkg('left', {dependencies: {shared: '1'}});
  const right = await pkg('right', {dependencies: {shared: '1'}});
  const shared = await pkg('shared');
  await writeFile(join(left, 'index.cjs'), "module.exports = require('shared');");
  await writeFile(join(right, 'index.cjs'), "module.exports = require('shared');");
  await writeFile(join(shared, 'index.cjs'), "module.exports = {marker: 'same instance'};");
  await stageDependencies(source, destination, {compact: true, metadata: {dependencies: {left: '1', right: '1'}}});

  const appRequire = createRequire(join(destination, 'package.json'));
  assert.equal(appRequire('left'), appRequire('right'));
  assert.equal(createRequire(appRequire.resolve('left')).resolve('shared'), createRequire(appRequire.resolve('right')).resolve('shared'));
  assert.ok(await assertInternalLinks(destination) > 0);

  const moved = `${destination}-moved`;
  await rename(destination, moved);
  await rm(source, {recursive: true, force: true});
  const movedRequire = createRequire(join(moved, 'package.json'));
  assert.deepEqual(movedRequire('left'), {marker: 'same instance'});
  assert.equal(movedRequire('left'), movedRequire('right'));
  assert.ok(await assertInternalLinks(moved) > 0);
});

for (const rightVersion of ['1.0.0', '2.0.0']) {
  test(`compact staging preserves separate source packages and their dependencies (right version ${rightVersion})`, async t => {
    const {source, destination, pkg} = await fixture(t);
    const left = await pkg('left', {dependencies: {shared: '1'}});
    const right = await pkg('right', {dependencies: {shared: rightVersion}});
    for (const [parent, version, leafValue] of [[left, '1.0.0', 'left leaf'], [right, rightVersion, 'right leaf']]) {
      await writeFile(join(parent, 'index.cjs'), "module.exports = require('shared');");
      const shared = await pkg('shared', {version, dependencies: {leaf: '1'}}, parent);
      const leaf = await pkg('leaf', {}, shared);
      await writeFile(join(leaf, 'index.cjs'), `module.exports = ${JSON.stringify(leafValue)};`);
      await writeFile(join(shared, 'index.cjs'), "module.exports = {version: require('./package.json').version, leaf: require('leaf')};");
    }
    await stageDependencies(source, destination, {compact: true, metadata: {dependencies: {left: '1', right: '1'}}});
    const appRequire = createRequire(join(destination, 'package.json'));
    assert.deepEqual(appRequire('left'), {version: '1.0.0', leaf: 'left leaf'});
    assert.deepEqual(appRequire('right'), {version: rightVersion, leaf: 'right leaf'});
    assert.notEqual(createRequire(appRequire.resolve('left')).resolve('shared'), createRequire(appRequire.resolve('right')).resolve('shared'));
    await assertInternalLinks(destination);
  });
}

test('compact staging upgrades an existing dependency when the SDK later requires its peers', {skip: process.platform === 'win32' && 'POSIX compact layout uses symlinks; Windows uses hoisting'}, async t => {
  const {source, destination, pkg} = await fixture(t);
  const plain = await pkg('plain-user', {dependencies: {'shared-peer': '1'}});
  const shared = await pkg('shared-peer', {peerDependencies: {'required-peer-child': '1'}});
  const child = await pkg('required-peer-child');
  await pkg(sdk, {peerDependencies: {'shared-peer': '1'}});
  await writeFile(join(plain, 'index.cjs'), "module.exports = require('shared-peer');");
  await writeFile(join(shared, 'index.cjs'), "module.exports = require('required-peer-child');");
  await writeFile(join(child, 'index.cjs'), "module.exports = 'required peer is staged';");
  await stageDependencies(source, destination, {compact: true, metadata: {dependencies: {'plain-user': '1', [sdk]: '1'}}});
  await rm(source, {recursive: true, force: true});
  const appRequire = createRequire(join(destination, 'package.json'));
  const sdkRequire = createRequire(appRequire.resolve(sdk));
  assert.equal(sdkRequire('shared-peer'), 'required peer is staged');
  assert.equal(appRequire('plain-user'), 'required peer is staged');
  assert.equal(createRequire(appRequire.resolve('plain-user')).resolve('shared-peer'), sdkRequire.resolve('shared-peer'));
  await assertInternalLinks(destination);
});

test('compact staging removes development payloads but retains runtime assets and legal files', async t => {
  const {source, destination, pkg} = await fixture(t);
  const runtime = await pkg('runtime');
  const removed = ['index.d.ts', 'types/api.d.mts', 'types/api.d.cts', 'dist/index.js.map', 'test/fixture.json', 'tests/unit.cjs', '__tests__/unit.cjs', 'examples/demo.cjs', 'docs/guide.md'];
  const retained = ['LICENSE', 'LICENSE-MIT', 'NOTICE', 'assets/schema.json', 'assets/template.txt', 'dist/runtime.json', 'dist/worker.cjs'];
  for (const file of [...removed, ...retained]) await addFile(runtime, file);
  await writeFile(join(runtime, 'index.cjs'), "module.exports = require('node:fs').readFileSync(require('node:path').join(__dirname, 'assets/template.txt'), 'utf8');");
  await stageDependencies(source, destination, {compact: true, metadata: {dependencies: {runtime: '1'}}});
  const staged = join(destination, 'node_modules/runtime');
  for (const file of removed) await assert.rejects(lstat(join(staged, file)), {code: 'ENOENT'}, file);
  for (const file of retained) assert.equal(await readFile(join(staged, file), 'utf8'), 'fixture', file);
  assert.equal(createRequire(join(destination, 'package.json'))('runtime'), 'fixture');
});

test('hoist staging (Windows desktop, server packages) also removes development payloads', async t => {
  const {source, destination, pkg} = await fixture(t);
  const runtime = await pkg('runtime', {main: 'src/index.js'});
  const removed = ['index.d.ts', 'src/index.ts', 'src/worker.mts', 'dist/index.js.map', 'test/fixture.json', 'docs/guide.md', 'examples/demo.cjs'];
  for (const file of removed) await addFile(runtime, file);
  await addFile(runtime, 'src/index.js', "module.exports = 'runs from src';");
  await addFile(runtime, 'LICENSE');
  await stageDependencies(source, destination, {hoist: true, metadata: {dependencies: {runtime: '1'}}});
  const staged = join(destination, 'node_modules/runtime');
  for (const file of removed) await assert.rejects(lstat(join(staged, file)), {code: 'ENOENT'}, file);
  assert.equal(await readFile(join(staged, 'LICENSE'), 'utf8'), 'fixture');
  assert.equal(createRequire(join(destination, 'package.json'))('runtime'), 'runs from src');
});

test('stageDaemon ships a minified CLI with the workspace packages bundled from source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-stage-daemon-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const daemonRoot = fileURLToPath(new URL('../packages/daemon/', import.meta.url));
  const daemon = JSON.parse(await readFile(join(daemonRoot, 'package.json'), 'utf8'));
  const staged = join(root, 'daemon');
  const previousOrigin = process.env.VONVON_ACCOUNT_API_ORIGIN;
  process.env.VONVON_ACCOUNT_API_ORIGIN = 'https://recipes-staging.example';
  let result;
  try {
    result = await stageDaemon(staged, {name: daemon.name, version: daemon.version, type: 'module', bin: daemon.bin, dependencies: daemon.dependencies}, {hoist: true});
  } finally {
    if (previousOrigin === undefined) delete process.env.VONVON_ACCOUNT_API_ORIGIN;
    else process.env.VONVON_ACCOUNT_API_ORIGIN = previousOrigin;
  }
  const cli = await readFile(join(staged, 'dist/cli.js'), 'utf8');
  assert.ok(cli.includes('https://recipes-staging.example'), 'the packaged daemon retains its compiled account origin');
  assert.ok(cli.length / cli.split('\n').length > 400, 'dist/cli.js is minified');
  assert.doesNotMatch(cli, /sourceMappingURL|\bfrom\s*["']@vonvon\//);
  const metadata = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'));
  for (const name of bundledWorkspaces) {
    assert.equal(name in metadata.dependencies, false, name);
    await assert.rejects(lstat(join(staged, 'node_modules', name)), {code: 'ENOENT'}, name);
    assert.equal(result.external.includes(name), false, name);
  }
  assert.ok(result.external.includes('ws'));
  // Protocol keeps its own zod when the daemon ships a different one.
  const zodOf = from => realpath(dirname(createRequire(join(from, 'package.json')).resolve('zod/package.json')));
  const protocolRoot = fileURLToPath(new URL('../packages/protocol/', import.meta.url));
  assert.equal(result.bundled.includes('zod'), await zodOf(protocolRoot) !== await zodOf(daemonRoot));
  const shipped = [];
  async function walk(path) {
    for (const entry of await readdir(path, {withFileTypes: true})) {
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (/\.(?:[mc]?ts|map)$/.test(entry.name)) shipped.push(join(path, entry.name));
    }
  }
  await walk(staged);
  assert.deepEqual(shipped, []);
  assert.equal(execFileSync(process.execPath, [join(staged, 'bin/vonvon.mjs'), '--version'], {encoding: 'utf8'}).trim(), daemon.version);

  // main 必败: the folder search ran its worker from Function.prototype.toString(), and after minify + keepNames the body
  // called esbuild's __name helper, which the worker's own process did not have: every search failed with
  // directory_unreadable on the packaged daemon (Windows acceptance task 205).
  await t.test('dir suggest finds a folder through the staged daemon', async () => {
    const home = join(root, 'home');
    await mkdir(join(home, 'Projects', 'vonvon-stage-target'), {recursive: true});
    const env = {...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), VONVON_HOME: join(root, 'data')};
    for (const name of ['VONVON_SERVICE', 'VONVON_SESSION', 'FEISHU_CODEX_BRIDGE', 'FEISHU_CODEX_CWD', 'CODEX_HOME']) delete env[name];
    const vonvon = (...args) => spawnSync(process.execPath, [join(staged, 'bin/vonvon.mjs'), ...args], {env, encoding: 'utf8', timeout: 60_000});
    // The CLI only points at daemon.log; the CI log keeps nothing else of why the daemon went away or did not stop
    const daemonLog = () => { try { return readFileSync(join(root, 'data', 'daemon.log'), 'utf8').split('\n').slice(-40).join('\n'); } catch (error) { return String(error); } };
    const started = vonvon('daemon', 'start', '--port', '0');
    try {
      assert.equal(started.status, 0, started.status === 0 ? '' : `${started.stdout}${started.stderr}\n--- daemon.log ---\n${daemonLog()}`);
      for (const query of ['vonvon-stage', '~/Projects/', ...process.platform === 'win32' ? ['~\\Projects\\'] : []]) {
        // A loaded CI runner can take longer than the 1.5 s search budget just to start the worker's node: that comes back
        // empty and truncated, or as a timeout. The bug this guards failed every attempt with directory_unreadable.
        let found;
        for (let attempt = 0; attempt < 5; attempt++) {
          found = vonvon('dir', 'suggest', query, '--json');
          const slow = found.status === 0 ? (({entries, truncated}) => truncated && !entries.length)(JSON.parse(found.stdout)) : /超时|directory_timeout/.test(found.stdout + found.stderr);
          if (!slow) break;
        }
        assert.equal(found.status, 0, `${query}: ${found.stdout}${found.stderr}`);
        assert.ok(JSON.parse(found.stdout).entries.some(entry => entry.name === 'vonvon-stage-target'), `${query}: ${found.stdout}`);
      }
    } finally {
      const stopped = vonvon('daemon', 'stop');
      assert.equal(stopped.status, 0, stopped.status === 0 ? '' : `${stopped.stdout}${stopped.stderr}\n--- daemon.log ---\n${daemonLog()}`);
    }
  });
});

test('default CLI staging keeps development payloads and separate dependency copies without symlinks', async t => {
  const {source, destination, pkg} = await fixture(t);
  await pkg('left', {dependencies: {shared: '1'}});
  await pkg('right', {dependencies: {shared: '1'}});
  const shared = await pkg('shared');
  const files = ['index.d.ts', 'dist/index.js.map', 'test/fixture.json', 'docs/guide.md', 'LICENSE'];
  for (const file of files) await addFile(shared, file);
  await stageDependencies(source, destination, {metadata: {dependencies: {left: '1', right: '1'}}});
  for (const parent of ['left', 'right']) {
    const staged = join(destination, 'node_modules', parent, 'node_modules/shared');
    assert.equal((await lstat(staged)).isSymbolicLink(), false);
    for (const file of files) assert.equal(await readFile(join(staged, file), 'utf8'), 'fixture');
  }
  assert.equal(await assertInternalLinks(destination), 0);
});
