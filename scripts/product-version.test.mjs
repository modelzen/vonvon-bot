// One product version for macOS, Windows and the Linux server package (AGENTS.md, owner 2026-10-28; devices 7.6).
// main 必败: checkedProductVersion ignores a server build report on main.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkedProductVersion } from './product-version.mjs';

test('the server build report must carry the daemon and desktop version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-product-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['daemon', 'desktop']) {
    await mkdir(join(root, 'packages', name), { recursive: true });
    await writeFile(join(root, 'packages', name, 'package.json'), JSON.stringify({ version: '0.9.0' }));
  }
  const report = join(root, 'build.json');
  await writeFile(report, JSON.stringify({ version: '0.9.0' }));
  assert.equal(await checkedProductVersion(root, { serverBuildJSON: report }), '0.9.0');
  await writeFile(report, JSON.stringify({ version: '0.8.9' }));
  await assert.rejects(checkedProductVersion(root, { serverBuildJSON: report }), /Server package version 0\.8\.9 differs from the product version 0\.9\.0/);
  assert.equal(await checkedProductVersion(root), '0.9.0', 'without a server report only macOS and Windows are compared');
});
