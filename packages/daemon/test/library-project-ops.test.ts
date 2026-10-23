import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async () => {
  const { join } = await import('node:path');
  const botDir = (appId: string) => join(fixture.root, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return { dir, configFile: join(dir, 'config.json'), sessionsFile: join(dir, 'sessions.json'), projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'), setupFile: join(dir, 'setup.json'), topicsDir: join(dir, 'topics'),
      droppedFile: join(dir, 'dropped.json'), judgeUsageFile: join(dir, 'judge-usage.json') };
  };
  return {
    botDir, botPaths,
    paths: {
      get appDir() { return fixture.root; },
      get botsFile() { return join(fixture.root, 'bots.json'); },
      get projectsFile() { return join(fixture.root, 'projects.json'); },
      get projectsRootDir() { return join(fixture.root, 'projects'); },
    },
  };
});

import { createHostLibrary } from '../src/admin/library';
import { AdminWriteError } from '../src/admin/ops';
import { createLibraryProject, LibraryError, libraryLocation, projectDirectory, readLibrary } from '../src/project/library';
import { existsSync } from 'node:fs';

type Row = Record<string, unknown>;
let work: string;
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'library-ops-')));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'library-ops-work-')));
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

function folder(name: string): string { const path = join(work, name); mkdirSync(path, { recursive: true }); return path; }
async function project(name: string) {
  return createLibraryProject({ name, workspace: { primary: folder(name), additional: [] }, createdBy: { botId: 'cli_a', chatId: `oc_${name}` } }, libraryLocation(fixture.root));
}
const library = async () => (await readLibrary(libraryLocation(fixture.root))).projects;
function bindRow(appId: string, projectId: string): void {
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: appId, bots: [{ name: 'bot', appId, tenant: 'feishu', createdAt: 1, botName: 'bot', active: true }] }));
  mkdirSync(join(fixture.root, 'bots', appId), { recursive: true });
  const row: Row = { name: 'g', chatId: 'oc_g', cwd: folder('g'), blank: false, createdAt: 1, projectId };
  writeFileSync(join(fixture.root, 'bots', appId, 'projects.json'), JSON.stringify({ version: 1, projects: [row] }));
}

describe('library.rename and library.delete (P6)', () => {
  it('renames a project, bumps its revision, keeps names unique and refuses a stale revision', async () => {
    const a = await project('支付组');
    const b = await project('官网');
    const host = createHostLibrary();
    const renamed = await host.rename({ projectId: a.id, revision: 1, name: '  发版组 ' });
    expect(renamed).toMatchObject({ name: '发版组', revision: 2 });
    expect((await host.rename({ projectId: a.id, revision: 2, name: '发版组' })).revision).toBe(2);
    const taken = await host.rename({ projectId: b.id, revision: 1, name: '发版组' }).catch((error: unknown) => error);
    expect(taken).toBeInstanceOf(LibraryError);
    expect((taken as LibraryError).code).toBe('name-taken');
    const stale = await host.rename({ projectId: a.id, revision: 1, name: '别的' }).catch((error: unknown) => error);
    expect((stale as LibraryError).code).toBe('revision');
    expect((await library()).map(item => item.name).sort()).toEqual(['发版组', '官网']);
  });

  it('deletes a project nothing binds, with its directory, and refuses while a binding row names it', async () => {
    const used = await project('用着的');
    const free = await project('空的');
    bindRow('cli_a', used.id);
    mkdirSync(projectDirectory(free.id, libraryLocation(fixture.root)), { recursive: true });
    writeFileSync(join(projectDirectory(free.id, libraryLocation(fixture.root)), 'memory.json'), '{}');
    const host = createHostLibrary();
    const refused = await host.remove({ projectId: used.id, revision: 1 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AdminWriteError);
    expect((await library()).map(item => item.id)).toContain(used.id);
    await host.remove({ projectId: free.id, revision: 1 });
    expect((await library()).map(item => item.id)).toEqual([used.id]);
    expect(existsSync(projectDirectory(free.id, libraryLocation(fixture.root)))).toBe(false);
  });

  it('keeps a project when its last group is unbound, remembers it for that group, and then lets it be deleted', async () => {
    const pay = await project('支付组');
    bindRow('cli_a', pay.id);
    const host = createHostLibrary();
    // Unbinding drops the row and remembers its project for the group (registry.removeProject).
    writeFileSync(join(fixture.root, 'bots', 'cli_a', 'projects.json'), JSON.stringify({ version: 1, projects: [], previousProjects: { oc_g: pay.id } }));
    expect((await library()).map(item => item.id)).toEqual([pay.id]);
    expect(await host.previous('cli_a', 'oc_g')).toEqual({ id: pay.id, name: '支付组' });
    expect(await host.previous('cli_a', 'oc_other')).toBeUndefined();
    await host.remove({ projectId: pay.id, revision: 1 });
    expect(await library()).toEqual([]);
    expect(await host.previous('cli_a', 'oc_g')).toBeUndefined();
  });
});
