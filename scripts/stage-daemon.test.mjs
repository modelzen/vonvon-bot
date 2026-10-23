import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { stageDependencies } from './stage-daemon.mjs';

const sdk = '@anthropic-ai/claude-agent-sdk';
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

test('compact staging deduplicates a diamond and remains self-contained after relocation', async t => {
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

test('compact staging upgrades an existing dependency when the SDK later requires its peers', async t => {
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

test('compact staging keeps only built output and package/legal metadata for first-party runtime packages', async t => {
  const {source, destination, pkg} = await fixture(t);
  for (const name of ['@vonvon/client', '@vonvon/protocol']) {
    const root = await pkg(name, {main: 'dist/index.cjs'});
    await addFile(root, 'dist/index.cjs', `module.exports = ${JSON.stringify(name)};`);
    for (const file of ['LICENSE', 'LICENSE.bridge', 'NOTICE', 'NOTICE.md']) await addFile(root, file);
    for (const file of ['src/index.ts', 'test/runtime.test.ts', 'tsconfig.json', 'README.md', 'dist/index.d.ts', 'dist/index.cjs.map']) await addFile(root, file);
  }
  await stageDependencies(source, destination, {compact: true, metadata: {dependencies: {'@vonvon/client': '1', '@vonvon/protocol': '1'}}});
  const appRequire = createRequire(join(destination, 'package.json'));
  for (const name of ['@vonvon/client', '@vonvon/protocol']) {
    const root = join(destination, 'node_modules', name);
    assert.equal(appRequire(name), name);
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name, name);
    for (const file of ['LICENSE', 'LICENSE.bridge', 'NOTICE', 'NOTICE.md']) assert.equal(await readFile(join(root, file), 'utf8'), 'fixture');
    for (const file of ['src', 'test', 'index.cjs', 'tsconfig.json', 'README.md', 'dist/index.d.ts', 'dist/index.cjs.map']) await assert.rejects(lstat(join(root, file)), {code: 'ENOENT'}, `${name}/${file}`);
  }
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
