import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyWindowsPayloadPaths, verifyWindowsRuntime } from './windows-runtime-smoke.mjs';
import { readFile } from 'node:fs/promises';
import { createPackagedCodexFixture } from './windows-provider-smoke.mjs';

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

test('each reinstall Provider lane starts its own call log and preserves retained application data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-reinstall-fixture-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  await writeFile(join(root,'sentinel'),'preserve');
  const first = await createPackagedCodexFixture(root, join(root,'Vonvon Bot.exe'));
  await writeFile(first.callsFile,'{"method":"model/list"}\n');
  const next = await createPackagedCodexFixture(root, join(root,'Vonvon Bot.exe'));
  assert.equal(await readFile(next.callsFile,'utf8'),'');
  assert.equal(await readFile(join(root,'sentinel'),'utf8'),'preserve');
});
