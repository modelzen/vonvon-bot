import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryBrowser } from '../src/server/directory-browser';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-directory-'));
  roots.push(root);
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(home), mkdir(outside)]);
  return { home, outside, browser: await createDirectoryBrowser(home) };
}
describe('canonical home directory tokens', () => {
  it('lists nested folders and refuses paths or symlinks escaping home', async () => {
    const { home, outside, browser } = await fixture();
    await mkdir(join(home, 'a', 'b'), { recursive: true });
    await mkdir(join(home, '.hidden'));
    await symlink(outside, join(home, 'escape'));
    const list = await browser.list();
    expect(list.parent).toBeNull();
    expect(list.entries.map(entry => entry.name)).toEqual(['.hidden', 'a']);
    expect(list.entries[0]?.hidden).toBe(true);
    expect((await browser.list(join(home, 'a', 'b'))).parent).toBe(join(list.path, 'a'));
    await expect(browser.list(outside)).rejects.toMatchObject({ code: 'outside_home' });
    await expect(browser.choose(join(home, 'escape'))).rejects.toMatchObject({ code: 'outside_home' });
  });

  it('rechecks containment at use and expires a token after ten minutes', async () => {
    const { home, outside, browser } = await fixture();
    const path = join(home, 'project');
    await mkdir(path);
    const folder = await browser.choose(path);
    expect(await browser.resolve(folder.token)).toBe(folder.displayPath);
    await rm(path, { recursive: true });
    await symlink(outside, path);
    await expect(browser.resolve(folder.token)).rejects.toMatchObject({ code: 'outside_home' });
    const rootFolder = await browser.choose(home);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 600_000);
    await expect(browser.resolve(rootFolder.token)).rejects.toMatchObject({ code: 'invalid_folder_token' });
  });
  it('sorts and caps a directory listing at 1000 entries with an explicit truncated flag', async () => {
    const { home, browser } = await fixture();
    await Promise.all(Array.from({ length: 1001 }, (_, index) => mkdir(join(home, String(index).padStart(4, '0')))));
    const result = await browser.list();
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1000);
    expect(result.entries[0]?.name).toBe('0000');
    expect(result.entries[999]?.name).toBe('0999');
  }, process.platform === 'win32' ? 20_000 : 5_000);

});
