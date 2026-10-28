import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyWindowsPayloadPaths, verifyWindowsRuntime } from './windows-runtime-smoke.mjs';
import { readFile } from 'node:fs/promises';

test('installer gate rejects the nested dependency layout that lost runtime files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-payload-path-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'resources/daemon/node_modules/@larksuiteoapi/node-sdk/node_modules/axios/node_modules/form-data/node_modules/es-set-tostringtag/node_modules/get-intrinsic/node_modules/get-proto/node_modules/dunder-proto');
  await mkdir(path, {recursive: true}); await writeFile(join(path, 'get.js'), 'module.exports = true');
  await assert.rejects(verifyWindowsPayloadPaths(root), /exceeds installation budget/);
});

test('installer gate permits the shallow runtime dependency layout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-payload-path-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'resources/daemon/node_modules/dunder-proto');
  await mkdir(path, {recursive: true}); await writeFile(join(path, 'get.js'), 'module.exports = true');
  await verifyWindowsPayloadPaths(root);
});

test('a failed executable spawn reports ENOENT and preserves caller-owned runtime data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-missing-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'data'); await mkdir(home); await writeFile(join(home, 'sentinel'), 'keep');
  await assert.rejects(verifyWindowsRuntime(root, { retainedHome: home }), error => error.code === 'ENOENT');
  assert.equal(await readFile(join(home, 'sentinel'), 'utf8'), 'keep');
});
