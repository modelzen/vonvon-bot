import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import * as logger from '../src/core/logger';
import { cleanupReleases } from '../src/service/standalone-update';

// main 必败: releases/ grew by one directory each update (server-3 4.10)
const root = mkdtempSync(join(tmpdir(), 'vonvon-release-cleanup-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function releases(dir: string): Promise<void> {
  for (const version of ['1.0.0', '1.0.1', '1.0.2']) {
    await mkdir(join(dir, 'releases', version), { recursive: true });
    await writeFile(join(dir, 'releases', version, 'standalone.json'), JSON.stringify({ v: 1, version }));
  }
  await mkdir(join(dir, 'releases', '1.0.3.part', 'app'), { recursive: true });
  await mkdir(join(dir, 'releases', 'junk'), { recursive: true });
  await mkdir(join(dir, 'releases', '0.9.0'), { recursive: true }); // no standalone.json: not ours to remove
}

it('keeps current and previous, removes other releases and every .part, and leaves what it does not know', async () => {
  const dir = join(root, 'a');
  await releases(dir);
  await mkdir(join(dir, 'outside'), { recursive: true });
  await symlink(join(dir, 'outside'), join(dir, 'releases', '0.8.0'));
  await cleanupReleases(dir, ['1.0.2', '1.0.1']);
  expect((await readdir(join(dir, 'releases'))).sort()).toEqual(['0.8.0', '0.9.0', '1.0.1', '1.0.2', 'junk']);
  expect(await readdir(dir)).toContain('outside');
});

// review 221: a restart helper keeps the versions of its own update, read long before; another data directory's update
// may have switched `current` meanwhile, and every getter and service definition runs what `current` names
it('never removes the release current names, whatever the caller keeps', async () => {
  const dir = join(root, 'c');
  await releases(dir);
  await mkdir(join(dir, 'releases', '1.0.3', 'app'), { recursive: true });
  await writeFile(join(dir, 'releases', '1.0.3', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.3' }));
  await symlink('releases/1.0.3', join(dir, 'current'));
  await cleanupReleases(dir, ['1.0.2', '1.0.1']);
  // Before: 1.0.3 went, and `current` pointed at nothing.
  expect((await readdir(join(dir, 'releases'))).sort()).toEqual(['0.9.0', '1.0.1', '1.0.2', '1.0.3', 'junk']);
});

it('skips a directory in use and says so, without failing', async () => {
  const dir = join(root, 'b');
  await releases(dir);
  const warn = vi.spyOn(logger.log, 'warn');
  const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
  await cleanupReleases(dir, ['1.0.2', '1.0.1'], async () => { throw busy; });
  expect(warn).toHaveBeenCalledWith('core-update', 'update-cleanup-skipped', { name: '1.0.0', code: 'EBUSY' });
  expect(warn).toHaveBeenCalledWith('core-update', 'update-cleanup-skipped', { name: '1.0.3.part', code: 'EBUSY' });
  warn.mockRestore();
});
