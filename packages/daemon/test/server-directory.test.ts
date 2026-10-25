import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryBrowser } from '../src/server/directory-browser';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
  });

});

describe('web directory suggestions', () => {
  it('lists the host home and its visible folders, and admits the selected canonical path', async () => {
    const {home, browser} = await fixture();
    await Promise.all([mkdir(join(home, 'Projects')), mkdir(join(home, '.private')), writeFile(join(home, 'file.txt'), 'file')]);
    const result = await browser.suggest('');
    expect(result.parent).toBeNull();
    expect(result.entries.map(entry => entry.name)).toEqual(['home', 'Projects']);
    expect(result.path).toBe(result.root);
    const chosen = await browser.choose(result.entries[1]!.path);
    expect(await browser.resolve(chosen.token)).toBe(join(result.root, 'Projects'));
  });

  it('searches nested names while excluding hidden/generated trees and symlink escapes or cycles', async () => {
    const {home, outside, browser} = await fixture();
    await Promise.all([
      mkdir(join(home, 'Developer', 'Vonvon Bot'), {recursive: true}),
      mkdir(join(home, 'node_modules', 'vonvon-dependency'), {recursive: true}),
      mkdir(join(home, '.private', 'vonvon-secret'), {recursive: true}),
      mkdir(join(outside, 'vonvon-outside')),
      symlink(outside, join(home, 'vonvon-escape')),
      symlink(home, join(home, 'cycle')),
    ]);
    const result = await browser.suggest('vonvon');
    expect(result.entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
    expect(result.path).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it('supports tilde, full paths, partial names and browsing hidden folders explicitly', async () => {
    const {home, browser} = await fixture();
    await mkdir(join(home, 'Projects', 'Vonvon Bot'), {recursive: true});
    await mkdir(join(home, '.private', 'workspace'), {recursive: true});
    const result = await browser.suggest('~/Projects/');
    expect(result.entries.map(entry => entry.name)).toEqual(['Projects', 'Vonvon Bot']);
    expect(result.parent).toBe(result.root);
    const completion = await browser.suggest(join(home, 'Projects', 'Von'));
    expect(completion.entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
    expect(completion.path).toBe(result.path);
    expect((await browser.suggest('~/.private/')).entries.map(entry => entry.name)).toEqual(['.private', 'workspace']);
    expect((await browser.suggest('~/Projects/Vonvon Bot')).entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
  });

  it('rejects outside paths, escaped symlinks, nonexistent parents and files', async () => {
    const {home, outside, browser} = await fixture();
    await symlink(outside, join(home, 'escape'));
    await writeFile(join(home, 'not-a-directory'), 'file');
    await expect(browser.suggest(outside)).rejects.toMatchObject({code: 'outside_home'});
    await expect(browser.suggest('~/../outside')).rejects.toMatchObject({code: 'outside_home'});
    await expect(browser.suggest('~/escape/')).rejects.toMatchObject({code: 'outside_home'});
    await expect(browser.suggest('~/missing/child')).rejects.toMatchObject({code: 'invalid_directory'});
    await expect(browser.suggest('~/not-a-directory')).rejects.toMatchObject({code: 'invalid_directory'});
  });

  it.skipIf(process.getuid?.() === 0)('reports unreadable directories instead of presenting a successful empty result', async () => {
    const {home, browser} = await fixture();
    const protectedPath = join(home, 'protected');
    await mkdir(protectedPath); await chmod(protectedPath, 0);
    try { await expect(browser.suggest('~/protected/')).rejects.toMatchObject({code: 'directory_unreadable'}); }
    finally { await chmod(protectedPath, 0o700); }
  });

  it('bounds results and discovery depth while allowing exact selection of a deeper folder', async () => {
    const {home, browser} = await fixture();
    await Promise.all(Array.from({length: 55}, (_, index) => mkdir(join(home, `workspace-${index}`))));
    const many = await browser.suggest('workspace');
    expect(many.entries).toHaveLength(50);
    expect(many.truncated).toBe(true);
    const deep = join(home, ...Array.from({length: 10}, () => 'level'), 'deep-project');
    await mkdir(deep, {recursive: true});
    const result = await browser.suggest('deep-project');
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(true);
    expect((await browser.suggest(deep)).entries[0]?.name).toBe('deep-project');
  });

  it('avoids implicit discovery into virtual-machine and protected personal folders but allows explicit browsing', async () => {
    const {home, browser} = await fixture();
    await Promise.all(['OrbStack', 'Virtual Machines.localized', 'Documents', 'Downloads', 'Library', 'linux.vmwarevm'].map(name => mkdir(join(home, name, 'paseo'), {recursive: true})));
    expect((await browser.suggest('paseo')).entries).toEqual([]);
    expect((await browser.suggest('~/Virtual Machines.localized/')).entries.map(entry => entry.name)).toEqual(['Virtual Machines.localized', 'paseo']);
    expect((await browser.suggest('~/Documents/')).entries.map(entry => entry.name)).toEqual(['Documents', 'paseo']);
  });
});
