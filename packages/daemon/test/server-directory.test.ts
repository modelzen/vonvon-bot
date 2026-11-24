import { chmod, mkdtemp, mkdir, realpath, rm, symlink as fileSymlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryBrowser } from '../src/server/directory-browser';

/** Folder names whose realpath or readdir fails the way Windows fails on protected folders. */
const denied = vi.hoisted(() => ({ realpath: new Set<string>(), readdir: new Set<string>() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const deny = (names: Set<string>, path: unknown) => {
    if (names.has(basename(String(path)))) throw Object.assign(new Error(`EPERM: operation not permitted, '${String(path)}'`), { code: 'EPERM' });
  };
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => { deny(denied.realpath, args[0]); return actual.realpath(...args); },
    readdir: async (...args: Parameters<typeof actual.readdir>) => { deny(denied.readdir, args[0]); return actual.readdir(...args); },
  };
});

/** A directory link. Windows makes a junction, which needs no admin rights (Windows acceptance task 205); targets here are absolute. */
const symlink = (target: string, path: string) => fileSymlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); denied.realpath.clear(); denied.readdir.clear(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-directory-'));
  roots.push(root);
  const home = join(root, 'home');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(home), mkdir(outside)]);
  return { home, outside, browser: await createDirectoryBrowser(home) };
}
describe('canonical home directory tokens', () => {
  // main 必败 (devices-ui-2 4.3): folders outside home were refused as outside_home; any folder this user can read is fine now.
  it('starts at home, and lists and chooses folders outside it too, up to the filesystem root', async () => {
    const { home, outside, browser } = await fixture();
    await mkdir(join(home, 'a', 'b'), { recursive: true });
    await mkdir(join(home, '.hidden'));
    await mkdir(join(outside, 'srv-app'));
    await symlink(outside, join(home, 'escape'));
    const list = await browser.list();
    expect(list.path).toBe(await realpath(home));
    expect(list.parent).toBe(dirname(list.path));
    expect(list.entries.map(entry => entry.name)).toEqual(['.hidden', 'a', 'escape']);
    expect(list.entries[0]?.hidden).toBe(true);
    expect((await browser.list(join(home, 'a', 'b'))).parent).toBe(join(list.path, 'a'));
    expect((await browser.list('~')).path).toBe(list.path);
    expect((await browser.list('~/a')).path).toBe(join(list.path, 'a'));
    const away = await browser.list(outside);
    expect(away.entries.map(entry => entry.name)).toEqual(['srv-app']);
    expect((await browser.choose(join(home, 'escape'))).displayPath).toBe(await realpath(outside));
    const top = parse(list.path).root;
    expect((await browser.list(top)).parent).toBeNull();
  });

  it('resolves a token again at use and expires it after ten minutes', async () => {
    const { home, outside, browser } = await fixture();
    const path = join(home, 'project');
    await mkdir(path);
    const folder = await browser.choose(path);
    expect(await browser.resolve(folder.token)).toBe(folder.displayPath);
    await rm(path, { recursive: true });
    await symlink(outside, path);
    expect(await browser.resolve(folder.token)).toBe(await realpath(outside));
    const rootFolder = await browser.choose(home);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 600_000);
    await expect(browser.resolve(rootFolder.token)).rejects.toMatchObject({ code: 'invalid_folder_token' });
  });
  // main 必败: a path that is not there came out as the raw ENOENT, which the web page showed as 操作失败 (cli-3-groups)
  it('says a folder that is not there, runs through a file or loops is invalid_directory', async () => {
    const { home, browser } = await fixture();
    await writeFile(join(home, 'file'), 'file');
    await symlink(join(home, 'loop-b'), join(home, 'loop-a'));
    await symlink(join(home, 'loop-a'), join(home, 'loop-b'));
    const missing = { code: 'invalid_directory', message: '找不到这个目录，请检查路径。' };
    await expect(browser.choose(join(home, 'nope'))).rejects.toMatchObject(missing);
    await expect(browser.list(join(home, 'nope'))).rejects.toMatchObject(missing);
    await expect(browser.list(join(home, 'file', 'sub'))).rejects.toMatchObject(missing);
    await expect(browser.choose(join(home, 'loop-a'))).rejects.toMatchObject(missing);
    await expect(browser.list(join(home, 'file'))).rejects.toMatchObject({ code: 'invalid_directory' });
    // a loop among the children is left out of a listing, as before
    expect((await browser.list()).entries.map(entry => entry.name)).toEqual([]);
    const folder = await browser.choose(home);
    expect(await browser.resolve(folder.token)).toBe(folder.displayPath);
  });

  // main 必败 (Windows acceptance task 318): a drive root failed to list, as its `System Volume Information` gave EPERM
  it('leaves out children this user may not open, and says so for a listed folder it cannot read', async () => {
    const { home, browser } = await fixture();
    await Promise.all(['open', 'System Volume Information', 'Other User'].map(name => mkdir(join(home, name))));
    denied.realpath.add('System Volume Information');
    denied.readdir.add('Other User');
    expect((await browser.list()).entries.map(entry => entry.name)).toEqual(['open', 'Other User']);
    await expect(browser.list(join(home, 'Other User'))).rejects.toMatchObject({ code: 'directory_unreadable' });
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
  it('lists the host home with visible folders before hidden folders, and admits the selected canonical path', async () => {
    const {home, browser} = await fixture();
    await Promise.all([mkdir(join(home, 'Projects')), mkdir(join(home, '.private')), mkdir(join(home, '.vonvon-bot')), writeFile(join(home, 'file.txt'), 'file')]);
    const result = await browser.suggest('');
    expect(result.parent).toBe(dirname(result.root));
    expect(result.entries.map(entry => entry.name)).toEqual(['home', 'Projects', '.private', '.vonvon-bot']);
    expect(result.entries.map(entry => entry.hidden)).toEqual([false, false, true, true]);
    expect(result.path).toBe(result.root);
    const chosen = await browser.choose(result.entries[1]!.path);
    expect(await browser.resolve(chosen.token)).toBe(join(result.root, 'Projects'));
  });

  it('searches nested names while matching top-level dot folders, excluding hidden trees, generated trees, and symlink escapes or cycles', async () => {
    const {home, outside, browser} = await fixture();
    await Promise.all([
      mkdir(join(home, 'Developer', 'Vonvon Bot'), {recursive: true}),
      mkdir(join(home, 'node_modules', 'vonvon-dependency'), {recursive: true}),
      mkdir(join(home, '.private', 'vonvon-secret'), {recursive: true}),
      mkdir(join(home, '.vonvon-bot', 'projects'), {recursive: true}),
      mkdir(join(outside, 'vonvon-outside')),
      symlink(outside, join(home, 'vonvon-escape')),
      symlink(home, join(home, 'cycle')),
    ]);
    const result = await browser.suggest('vonvon');
    expect(result.entries.map(entry => entry.name)).toEqual(['Vonvon Bot', '.vonvon-bot']);
    expect(result.entries.map(entry => entry.hidden)).toEqual([false, true]);
    expect(result.path).toBeNull();
    expect(result.truncated).toBe(false);
    const dotResult = await browser.suggest('.vonvon');
    expect(dotResult.entries.map(entry => entry.name)).toEqual(['.vonvon-bot']);
  });

  it('supports tilde, full paths, partial names, trailing dot completion and browsing hidden folders explicitly', async () => {
    const {home, browser} = await fixture();
    await mkdir(join(home, 'Projects', 'Vonvon Bot'), {recursive: true});
    await mkdir(join(home, '.private', 'workspace'), {recursive: true});
    await mkdir(join(home, '.vonvon-bot', 'projects'), {recursive: true});
    const result = await browser.suggest('~/Projects/');
    expect(result.entries.map(entry => entry.name)).toEqual(['Projects', 'Vonvon Bot']);
    expect(result.parent).toBe(result.root);
    const completion = await browser.suggest(join(home, 'Projects', 'Von'));
    expect(completion.entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
    expect(completion.path).toBe(result.path);
    expect((await browser.suggest('~/.')).entries.map(entry => entry.name)).toEqual(['.private', '.vonvon-bot']);
    expect((await browser.suggest(`${home}/.`)).entries.map(entry => entry.name)).toEqual(['.private', '.vonvon-bot']);
    expect((await browser.suggest('~/.private/')).entries.map(entry => entry.name)).toEqual(['.private', 'workspace']);
    expect((await browser.suggest('~/Projects/Vonvon Bot')).entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
    if (process.platform !== 'win32') return;
    // main 必败: Windows took ~\ for a name to search for (Windows acceptance task 205)
    expect((await browser.suggest('~\\Projects\\')).entries.map(entry => entry.name)).toEqual(['Projects', 'Vonvon Bot']);
    expect((await browser.suggest('~\\Projects\\Von')).entries.map(entry => entry.name)).toEqual(['Vonvon Bot']);
    expect((await browser.suggest('~\\.')).entries.map(entry => entry.name)).toEqual(['.private', '.vonvon-bot']);
    expect((await browser.suggest('~\\..\\outside\\')).path).toBe(await realpath(join(home, '..', 'outside')));
  });

  // main 必败 (devices-ui-2 4.3): the search refused folders outside home as outside_home.
  it('browses folders outside home and links out of it, and rejects nonexistent parents and files', async () => {
    const {home, outside, browser} = await fixture();
    await mkdir(join(outside, 'data'));
    await symlink(outside, join(home, 'escape'));
    await writeFile(join(home, 'not-a-directory'), 'file');
    const away = await browser.suggest(outside);
    expect(away.entries.map(entry => entry.name)).toEqual(['outside', 'data']);
    expect(away.parent).toBe(dirname(await realpath(outside)));
    expect((await browser.suggest('~/../outside/')).entries.map(entry => entry.name)).toEqual(['outside', 'data']);
    expect((await browser.suggest('~/escape/')).path).toBe(await realpath(outside));
    expect((await browser.suggest('~/')).entries.map(entry => entry.name)).toContain('escape');
    await expect(browser.suggest('~/missing/child')).rejects.toMatchObject({code: 'invalid_directory'});
    await expect(browser.suggest('~/not-a-directory')).rejects.toMatchObject({code: 'invalid_directory'});
  });

  // chmod(0) means nothing on Windows, which has no POSIX permission bits; root reads everything.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports unreadable directories instead of presenting a successful empty result', async () => {
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
