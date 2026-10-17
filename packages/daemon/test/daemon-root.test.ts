import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDataRoot } from '../src/config/data-root';
const fixtures: string[] = [];
async function fixture(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'daemon-root-')); fixtures.push(dir); return dir; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(fixtures.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('daemon data root', () => {
  it('defaults to a fresh daemon path while ignoring conflicting legacy directories and migration metadata', async () => {
    const home = await fixture();
    const oldRoots = ['.feishu-codex-bridge', '.vonvon-bridge'];
    for (const name of oldRoots) {
      await mkdir(join(home, name));
      await writeFile(join(home, name, 'marker'), name);
    }
    const identities = oldRoots.map(name => lstatSync(join(home, name)).ino);
    await writeFile(join(home, '.vonvon-bridge-migration.json'), 'pending');
    const before = await readdir(home);
    vi.stubEnv('VONVON_HOME', undefined);
    expect(resolveDataRoot(home)).toEqual({ path: join(realpathSync(home), '.vonvon-bot'), kind: 'fresh' });
    expect(await readdir(home)).toEqual(before);
    for (const [index, name] of oldRoots.entries()) {
      const stat = lstatSync(join(home, name));
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.ino).toBe(identities[index]);
      expect(await readFile(join(home, name, 'marker'), 'utf8')).toBe(name);
    }
    expect(await readFile(join(home, '.vonvon-bridge-migration.json'), 'utf8')).toBe('pending');
  });
  it('uses VONVON_HOME and canonicalizes normal ancestor aliases without creating a home directory', async () => {
    const home = await fixture(); const selected = await fixture();
    vi.stubEnv('VONVON_HOME', selected);
    expect(resolveDataRoot(home)).toEqual({ path: realpathSync(selected), kind: 'canonical' });
    expect(await readdir(home)).toEqual([]);
  });
  it.each(['', 'relative/path', '   '])('rejects invalid override %j', async override => {
    vi.stubEnv('VONVON_HOME', override);
    expect(() => resolveDataRoot('/unused')).toThrow(/nonempty absolute/);
  });
  it.each(['file', 'symlink'])('rejects a %s as the selected root', async kind => {
    const home = await fixture(); const selected = join(home, 'selected');
    if (kind === 'file') await writeFile(selected, 'retained');
    else await symlink(await fixture(), selected, process.platform === 'win32' ? 'junction' : 'dir');
    vi.stubEnv('VONVON_HOME', selected);
    expect(() => resolveDataRoot(home)).toThrow(/physical directory/);
  });
});
