import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireMutex, closeMutex, LockOrderError } from '../src/config/data-access';
import { withStoredRows } from '../src/project/registry';
import {
  holdMemoryDirectory, isProjectId, LIBRARY_MUTEX_TIMEOUT_MS, libraryLocation, ownLibrary, projectDirectory, readLibrary, resolveDirectory,
  type LibraryProject,
} from '../src/project/library';

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'project-library-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const project = (id: string, name: string, primary: string): LibraryProject => ({ id, name, createdAt: 1, revision: 1, workspace: { primary, additional: [] } });
/** A bot's projects.json with one row, for the registry's side of the lock order. */
function botFile(data: string): { file: string; dataRoot: string } {
  const dir = join(data, 'bots', 'cli_a');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'projects.json');
  writeFileSync(file, JSON.stringify({ version: 1, projects: [{ name: 'g', chatId: 'oc_g', cwd: data, blank: false, createdAt: 1 }] }));
  return { file, dataRoot: data };
}

describe('project library file', () => {
  it('reads a missing library as empty and publishes what a commit wrote', async () => {
    const location = libraryLocation(root());
    expect(await readLibrary(location)).toEqual({ projects: [], rest: {} });
    await ownLibrary(async draft => { draft.projects.push(project('prj_0000000a', '支付组', '/w/a')); await draft.commit(); }, location);
    expect((await readLibrary(location)).projects.map(item => item.name)).toEqual(['支付组']);
    expect(readdirSync(location.dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('keeps keys a later version wrote, at the top and in each project', async () => {
    const location = libraryLocation(root());
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(location.file, JSON.stringify({ version: 1, future: { a: 1 }, projects: [{ ...project('prj_0000000a', 'a', '/w/a'), memoryLimit: 100 }] }));
    await ownLibrary(async draft => { draft.projects[0]!.name = 'b'; await draft.commit(); }, location);
    const stored = JSON.parse(readFileSync(location.file, 'utf8'));
    expect(stored.future).toEqual({ a: 1 });
    expect(stored.projects[0]).toMatchObject({ name: 'b', memoryLimit: 100 });
  });

  it('allows two projects to share one main folder, while keeping ids and names unique', async () => {
    const location = libraryLocation(root());
    await expect(ownLibrary(async draft => {
      draft.projects.push(project('prj_0000000a', 'a', '/w/a'), project('prj_0000000b', 'a', '/w/b'));
      await draft.commit();
    }, location)).rejects.toThrow(/唯一/);
    expect(await readLibrary(location)).toEqual({ projects: [], rest: {} });
    await ownLibrary(async draft => {
      draft.projects.push(project('prj_0000000a', 'a', '/w/a'), project('prj_0000000b', 'b', '/w/a'));
      await draft.commit();
    }, location);
    expect((await readLibrary(location)).projects.map(item => [item.name, item.workspace.primary])).toEqual([['a', '/w/a'], ['b', '/w/a']]);
  });

  it('never reads a broken, foreign or linked file as an empty library', async () => {
    const data = root();
    const location = libraryLocation(data);
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(location.file, '{"version":2,"projects":[]}');
    await expect(readLibrary(location)).rejects.toThrow(/格式无效/);
    await expect(ownLibrary(async () => 'ran', location)).rejects.toThrow(/格式无效/);
    rmSync(location.file);
    writeFileSync(join(data, 'elsewhere.json'), '{"version":1,"projects":[]}');
    symlinkSync(join(data, 'elsewhere.json'), location.file);
    await expect(readLibrary(location)).rejects.toThrow();
  });

  it('leaves the published file and no temporary file when a write fails before the rename', async () => {
    const location = libraryLocation(root());
    await ownLibrary(async draft => { draft.projects.push(project('prj_0000000a', 'a', '/w/a')); await draft.commit(); }, location);
    const before = readFileSync(location.file, 'utf8');
    await expect(ownLibrary(async draft => {
      draft.projects.push(project('prj_0000000b', 'b', '/w/b'));
      await draft.commit({ beforeRename: () => { throw new Error('cut before rename'); } });
    }, location)).rejects.toThrow('cut before rename');
    expect(readFileSync(location.file, 'utf8')).toBe(before);
    expect(readdirSync(location.dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('removes only temporary files whose writer is gone', async () => {
    const location = libraryLocation(root());
    await ownLibrary(async draft => { draft.projects.push(project('prj_0000000a', 'a', '/w/a')); await draft.commit(); }, location);
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    const uuid = '0f0e0d0c-0b0a-4908-8706-050403020100';
    for (const name of [`projects.json.tmp-${gone}-${uuid}`, `projects.json.tmp-${process.pid}-${uuid}`, 'notes.txt']) writeFileSync(join(location.dir, name), '{');
    expect(await ownLibrary(draft => draft.sweepTemporaries(), location)).toBe(1);
    const left = readdirSync(location.dir);
    expect(left).toEqual(expect.arrayContaining(['notes.txt', `projects.json.tmp-${process.pid}-${uuid}`, 'projects.json']));
    expect(left).not.toContain(`projects.json.tmp-${gone}-${uuid}`);
  });

  it('names a project directory only for a project id', () => {
    const location = libraryLocation('/data');
    expect(projectDirectory('prj_0123abcd', location)).toBe(join('/data', 'library', 'prj_0123abcd'));
    expect(() => projectDirectory('../bots', location)).toThrow();
    expect(isProjectId('prj_0123abcd')).toBe(true);
    expect(isProjectId('prj_0123ABCD')).toBe(false);
  });
});

describe('canonical main folders', () => {
  it('resolves a folder that does not exist yet through its existing ancestor, the same key once it exists', async () => {
    const data = root();
    mkdirSync(join(data, 'real'));
    symlinkSync(join(data, 'real'), join(data, 'link'));
    expect(await resolveDirectory(join(data, 'link', 'proj', 'sub'))).toEqual({ path: join(data, 'real', 'proj', 'sub'), resolved: true });
    mkdirSync(join(data, 'real', 'proj', 'sub'), { recursive: true });
    expect(await resolveDirectory(join(data, 'link', 'proj', 'sub/'))).toEqual({ path: join(data, 'real', 'proj', 'sub'), resolved: true });
  });

  it('does not claim a canonical path behind a link whose target is gone', async () => {
    const data = root();
    mkdirSync(join(data, 'volume', 'code', 'proj'), { recursive: true });
    symlinkSync(join(data, 'volume', 'code'), join(data, 'code'));
    expect(await resolveDirectory(join(data, 'code', 'proj'))).toEqual({ path: join(data, 'volume', 'code', 'proj'), resolved: true });
    renameSync(join(data, 'volume'), join(data, 'unmounted'));
    expect(await resolveDirectory(join(data, 'code', 'proj'))).toEqual({ path: join(data, 'code', 'proj'), resolved: false });
    expect(await resolveDirectory(join(data, 'code'))).toEqual({ path: join(data, 'code'), resolved: false });
  });
});

describe('lock order bots → library → projects → memory', () => {
  it('takes a bot\'s projects inside the library, never the library inside projects', async () => {
    const data = root();
    const location = libraryLocation(data);
    const target = botFile(data);
    await expect(ownLibrary(async () => { await withStoredRows(target, async () => false); return 'nested'; }, location)).resolves.toBe('nested');
    await expect(withStoredRows(target, async () => { await ownLibrary(async () => undefined, location); return false; })).rejects.toBeInstanceOf(LockOrderError);
    // The refused call released what it held: both locks are free again.
    await expect(ownLibrary(async () => withStoredRows(target, async () => false), location)).resolves.toBeUndefined();
  });

  it('puts memory last: nothing of the four inside it', async () => {
    const data = root();
    const location = libraryLocation(data);
    const target = botFile(data);
    const memory = projectDirectory('prj_0123abcd', location);
    await expect(ownLibrary(async () => holdMemoryDirectory(memory, async () => 'ok'), location)).resolves.toBe('ok');
    await expect(withStoredRows(target, async () => { await holdMemoryDirectory(memory, async () => undefined); return false; })).resolves.toBeUndefined();
    await expect(holdMemoryDirectory(memory, () => ownLibrary(async () => undefined, location))).rejects.toBeInstanceOf(LockOrderError);
    await expect(holdMemoryDirectory(memory, () => withStoredRows(target, async () => false))).rejects.toBeInstanceOf(LockOrderError);
  });

  it('refuses taking a role again at once instead of waiting for itself', async () => {
    const data = root();
    const location = libraryLocation(data);
    const target = botFile(data);
    const started = Date.now();
    await expect(ownLibrary(() => ownLibrary(async () => 'inner', location), location)).rejects.toBeInstanceOf(LockOrderError);
    await expect(withStoredRows(target, async () => { await withStoredRows(target, async () => false); return false; })).rejects.toBeInstanceOf(LockOrderError);
    // Two memory stores at once could be taken in opposite order by two processes.
    await expect(holdMemoryDirectory(projectDirectory('prj_0000000a', location), () => holdMemoryDirectory(projectDirectory('prj_0000000b', location), async () => 'b')))
      .rejects.toBeInstanceOf(LockOrderError);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Nothing stayed held: each can be taken again, one after another.
    await expect(ownLibrary(async () => 'again', location)).resolves.toBe('again');
    await expect(holdMemoryDirectory(projectDirectory('prj_0000000b', location), async () => 'b')).resolves.toBe('b');
  });

  it('does not count a role whose operation has ended against work it left running', async () => {
    const data = root();
    const location = libraryLocation(data);
    let later: Promise<string> | undefined;
    await withStoredRows(botFile(data), async () => {
      later = new Promise(resolve => setTimeout(resolve, 50)).then(() => ownLibrary(async () => 'after', location));
      return false;
    });
    await expect(later).resolves.toBe('after');
  });

  it('waits up to 30 seconds for another holder of the library, longer than the 1.5 s default', async () => {
    expect(LIBRARY_MUTEX_TIMEOUT_MS).toBe(30_000);
    const location = libraryLocation(root());
    mkdirSync(location.dir, { recursive: true });
    const other = await acquireMutex(location.dir, 'library', 0);
    const started = Date.now();
    setTimeout(() => { void closeMutex(other); }, 2_000);
    await expect(ownLibrary(async () => 'got it', location)).resolves.toBe('got it');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  });
});
