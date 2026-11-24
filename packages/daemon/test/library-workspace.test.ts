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

import { createHostLibrary, mirrorProjectIntoBot, prepareLibraryAtStartup, type AdminLibraryOp } from '../src/admin/library';
import { createAdminService } from '../src/admin/service';
import { projectRevision } from '../src/admin/collaboration';
import { AdminWriteError } from '../src/admin/ops';
import { detachSessionsForChatIn } from '../src/bot/session-store';
import { createLibraryProject, libraryLocation, ownLibrary, readLibrary } from '../src/project/library';
import { bindProject, listProjectsIn, mutateProject, previousProjectIdIn, removeProject, resetProjectDirectoryOverride, type Project } from '../src/project/registry';

type Row = Record<string, unknown>;
let work: string;

beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'library-workspace-')));
  // Outside the data root: a workspace inside it is refused.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'library-workspace-work-')));
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

function folder(name: string): string { const path = join(work, name); mkdirSync(path, { recursive: true }); return path; }
function bots(...appIds: string[]): void {
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: appIds[0],
    bots: appIds.map((appId, index) => ({ name: `bot${index}`, appId, tenant: 'feishu', createdAt: 1, botName: `bot-${appId}`, active: true })) }));
}
const rowsFile = (appId: string) => join(fixture.root, 'bots', appId, 'projects.json');
function rows(appId: string, projects: Row[]): void {
  mkdirSync(join(fixture.root, 'bots', appId), { recursive: true });
  writeFileSync(rowsFile(appId), JSON.stringify({ version: 1, projects }, null, 2));
}
const stored = (appId: string): Row[] => JSON.parse(readFileSync(rowsFile(appId), 'utf8')).projects;
const row = (name: string, chatId: string, cwd: string, extra: Row = {}): Row => ({ name, chatId, cwd, blank: false, createdAt: 1_000, ...extra });
const library = async () => (await readLibrary(libraryLocation(fixture.root))).projects;
const sessionsFile = (appId: string) => join(fixture.root, 'bots', appId, 'sessions.json');
function sessions(appId: string, chats: string[]): void {
  writeFileSync(sessionsFile(appId), JSON.stringify({ version: 3, titleJobs: [], sessions: chats.map(chatId => ({ threadId: `th_${chatId}`, chatId, cwd: '/old', sessionId: 's', backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 1 })) }));
}
const detached = (appId: string): Record<string, boolean> => Object.fromEntries((JSON.parse(readFileSync(sessionsFile(appId), 'utf8')).sessions as Row[]).map(item => [item.chatId as string, item.detached === true]));

/** Two bots in one group, one folder: step A makes them one project. */
async function sharedProject(): Promise<{ id: string; shared: string }> {
  const shared = folder('shared');
  bots('cli_a', 'cli_b');
  rows('cli_a', [row('支付组', 'oc_pay', shared), row('官网', 'oc_web', folder('web'))]);
  rows('cli_b', [row('支付组', 'oc_pay', shared)]);
  sessions('cli_a', ['oc_pay', 'oc_web']);
  sessions('cli_b', ['oc_pay']);
  await prepareLibraryAtStartup();
  const project = (await library()).find(item => item.workspace.primary === shared)!;
  expect(stored('cli_a')[0]!.projectId).toBe(project.id);
  expect(stored('cli_b')[0]!.projectId).toBe(project.id);
  return { id: project.id, shared };
}

describe('library.workspace, the one writer of a project\'s workspace', () => {
  it('changes the folder of a project two bots share while both are stopped, and archives both bots\' sessions', async () => {
    const { id } = await sharedProject();
    const target = folder('moved');
    const change = await createHostLibrary().workspace({ projectId: id, revision: 1, workspace: { primary: target, additional: [] } });
    expect(change).toMatchObject({ changed: true, project: { revision: 2, workspace: { primary: target } } });
    expect(change.rebound.map(item => [item.botId, item.chatId, item.state])).toEqual([['cli_a', 'oc_pay', 'archived'], ['cli_b', 'oc_pay', 'archived']]);
    for (const appId of ['cli_a', 'cli_b']) expect(stored(appId)[0]).toMatchObject({ cwd: target, blank: false, directories: { workspaces: { primary: target, additional: [] } } });
    expect(detached('cli_a')).toEqual({ oc_pay: true, oc_web: false });
    expect(detached('cli_b')).toEqual({ oc_pay: true });
    expect((await library()).find(project => project.id === id)).toMatchObject({ revision: 2, workspace: { primary: target } });
  });

  it('has a running bot\'s own process follow through the op, after the library is released, and a stopped one directly', async () => {
    const { id } = await sharedProject();
    const target = folder('moved');
    const asked: Array<[string, AdminLibraryOp['kind']]> = [];
    let released = '';
    const host = createHostLibrary({
      liveStatus: async botId => ({ running: botId === 'cli_a' }),
      executeLibrary: async (botId, op) => {
        asked.push([botId, op.kind]);
        // The bot's process takes `projects` next: the library must be free, or it would wait for the host's lock.
        released = await Promise.race([ownLibrary(async () => 'free', libraryLocation(fixture.root)), new Promise<string>(resolve => setTimeout(() => resolve('held'), 3000))]);
        return mirrorProjectIntoBot(botId, op.projectId, (chatId, commit) => detachSessionsForChatIn(sessionsFile(botId), chatId, commit));
      },
    });
    const change = await host.workspace({ projectId: id, workspace: { primary: target, additional: [] } });
    expect(asked).toEqual([['cli_a', 'libraryWorkspaceChanged']]);
    expect(released).toBe('free');
    expect(change.rebound.map(item => [item.botId, item.state])).toEqual([['cli_a', 'archived'], ['cli_b', 'archived']]);
    expect(detached('cli_a').oc_pay).toBe(true);
    expect(detached('cli_b').oc_pay).toBe(true);
    expect(stored('cli_b')[0]!.cwd).toBe(target);
  });

  it('allows changing a project to a main folder another project already uses, without altering the other project', async () => {
    const { id, shared } = await sharedProject();
    const web = (await library()).find(project => project.id !== id)!;
    const change = await createHostLibrary().workspace({ projectId: web.id, workspace: { primary: shared, additional: [] } });
    expect(change).toMatchObject({ changed: true, project: { id: web.id, revision: 2, workspace: { primary: shared } } });
    expect(change.rebound.map(item => [item.botId, item.chatId, item.state])).toEqual([['cli_a', 'oc_web', 'archived']]);
    expect(detached('cli_a')).toEqual({ oc_pay: false, oc_web: true });
    expect(detached('cli_b')).toEqual({ oc_pay: false });
    expect((await library()).find(project => project.id === id)).toMatchObject({ revision: 1, workspace: { primary: shared } });
    expect((await library()).find(project => project.id === web.id)).toMatchObject({ revision: 2, workspace: { primary: shared } });
  });

  it('refuses a stale revision and a folder the data root forbids, and leaves the project as it was', async () => {
    const { id } = await sharedProject();
    const before = await library();
    await expect(createHostLibrary().workspace({ projectId: id, revision: 7, workspace: { primary: folder('moved'), additional: [] } })).rejects.toMatchObject({ code: 'revision' });
    const inside = join(fixture.root, 'inside'); mkdirSync(inside);
    await expect(createHostLibrary().workspace({ projectId: id, workspace: { primary: inside, additional: [] } })).rejects.toBeInstanceOf(AdminWriteError);
    await expect(createHostLibrary().workspace({ projectId: 'prj_00000000', workspace: { primary: folder('moved'), additional: [] } })).rejects.toMatchObject({ code: 'not-found' });
    expect(await library()).toEqual(before);
    expect(detached('cli_a')).toEqual({ oc_pay: false, oc_web: false });
  });

  it('archives nothing when the project already has that workspace', async () => {
    const { id, shared } = await sharedProject();
    const change = await createHostLibrary().workspace({ projectId: id, revision: 1, workspace: { primary: shared, additional: [] } });
    expect(change).toMatchObject({ changed: false, rebound: [], project: { revision: 1 } });
    expect(detached('cli_a')).toEqual({ oc_pay: false, oc_web: false });
  });

  it('refuses while a bot of the project is busy when the entry asks (editProject), and does not for a settings save', async () => {
    const { id } = await sharedProject();
    const executeLibrary = vi.fn(async (botId: string, op: AdminLibraryOp) => op.kind === 'libraryWorkspaceCheck' ? { busy: botId === 'cli_b' }
      : mirrorProjectIntoBot(botId, op.projectId, (chatId, commit) => detachSessionsForChatIn(sessionsFile(botId), chatId, commit)));
    const host = createHostLibrary({ liveStatus: async () => ({ running: true }), executeLibrary });
    const workspace = { primary: folder('moved'), additional: [] };
    await expect(host.workspace({ projectId: id, workspace, refuseWhenBusy: true })).rejects.toThrow('bot-cli_b」正在执行任务');
    expect((await library()).find(project => project.id === id)!.revision).toBe(1);
    expect((await host.workspace({ projectId: id, workspace })).changed).toBe(true);
  });

  it('leaves a bot that runs in another process for the next start, and the others done', async () => {
    const { id, shared } = await sharedProject();
    const target = folder('moved');
    writeFileSync(join(fixture.root, 'bots', 'cli_b', 'processes.json'), JSON.stringify({ pid: process.ppid, appId: 'cli_b', startedAt: Date.now() }));
    const change = await createHostLibrary().workspace({ projectId: id, workspace: { primary: target, additional: [] } });
    expect(change.rebound.map(item => [item.botId, item.state])).toEqual([['cli_a', 'archived'], ['cli_b', 'failed']]);
    expect(stored('cli_a')[0]!.cwd).toBe(target);
    expect(stored('cli_b')[0]!.cwd).toBe(shared);
    rmSync(join(fixture.root, 'bots', 'cli_b', 'processes.json'));
    expect((await prepareLibraryAtStartup()).drift).toEqual([{ projectId: id, rows: 1, fields: ['primary'], outcome: 'repaired' }]);
    expect(stored('cli_b')[0]!.cwd).toBe(target);
    expect(detached('cli_b').oc_pay).toBe(true);
  });

  it('resets one override of the project\'s workspace', async () => {
    const { id, shared } = await sharedProject();
    const extra = folder('extra');
    const host = createHostLibrary();
    await host.workspace({ projectId: id, workspace: { primary: shared, additional: [extra] } });
    expect(stored('cli_b')[0]).toMatchObject({ directories: { workspaces: { additional: [extra] } } });
    await host.resetOverride(id, 'workspaces');
    expect(stored('cli_b')[0]).toMatchObject({ cwd: shared, directories: { workspaces: { primary: shared, additional: [] } } });
  });
});

describe('a row of a library project does not take a folder from anywhere else', () => {
  it('refuses a direct change of cwd or of the directory overrides, and a reset', async () => {
    await sharedProject();
    const file = rowsFile('cli_a');
    const location = { file, dataRoot: fixture.root };
    await expect(mutateProject('支付组', project => { project.cwd = folder('elsewhere'); }, undefined, location)).rejects.toThrow('归项目管');
    await expect(mutateProject('支付组', project => { project.directories = { workspaces: { primary: project.cwd, additional: [folder('x')] } }; }, undefined, location)).rejects.toThrow('归项目管');
    await expect(mutateProject('支付组', project => { project.enabled = false; }, undefined, location)).resolves.toMatchObject({ enabled: false });
    expect(stored('cli_a')[0]!.cwd).toBe(folder('shared'));
    // The reset helper only changes the file the daemon runs on: for a bound row it refuses too.
    writeFileSync(join(fixture.root, 'projects.json'), JSON.stringify({ version: 1, projects: [{ ...stored('cli_a')[0], directories: { repositories: [] } }] }));
    await expect(resetProjectDirectoryOverride('支付组', 'repositories')).rejects.toThrow('归项目管');
  });
});

describe('making and joining projects at binding time', () => {
  it('makes the project before the row, finds it again on a retry, allows another group to use the same folder, and suffixes a name', async () => {
    const pay = folder('pay');
    const workspace = { primary: pay, additional: [] };
    const first = await createLibraryProject({ name: '支付组', workspace, createdBy: { botId: 'cli_a', chatId: 'oc_pay' } }, libraryLocation(fixture.root), () => 5);
    expect(first).toMatchObject({ name: '支付组', revision: 1, createdAt: 5, createdBy: { botId: 'cli_a', chatId: 'oc_pay' } });
    expect(await createLibraryProject({ name: '支付组', workspace, createdBy: { botId: 'cli_a', chatId: 'oc_pay' } }, libraryLocation(fixture.root))).toEqual(first);
    const other = await createLibraryProject({ name: '别的', workspace, createdBy: { botId: 'cli_b', chatId: 'oc_other' } }, libraryLocation(fixture.root));
    expect(other.id).not.toBe(first.id);
    expect(other.workspace.primary).toBe(pay);
    // Retrying the second group's creation still finds its own project instead of the first group's.
    expect(await createLibraryProject({ name: '别的', workspace, createdBy: { botId: 'cli_b', chatId: 'oc_other' } }, libraryLocation(fixture.root))).toEqual(other);
    const second = await createLibraryProject({ name: '支付组', workspace: { primary: folder('pay-2'), additional: [] }, createdBy: { botId: 'cli_a', chatId: 'oc_pay2' } }, libraryLocation(fixture.root));
    expect(second.name).toBe('支付组 2');
    expect((await library()).map(project => project.name)).toEqual(['支付组', '别的', '支付组 2']);
  });

  it('writes the row with the project it joins and the step-A marker, and remembers the project of an unbound group', async () => {
    const pay = folder('pay');
    bots('cli_a');
    const project = await createLibraryProject({ name: '支付组', workspace: { primary: pay, additional: [] }, createdBy: { botId: 'cli_a', chatId: 'oc_pay' } }, libraryLocation(fixture.root));
    const binding = { name: '支付组', chatId: 'oc_pay', cwd: { kind: 'existing' as const, path: pay }, backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi' as const, noMention: true, project: { id: project.id } };
    const prepare = async () => ({ cwd: pay, blank: false, createdAt: 1, directories: { workspaces: { primary: pay, additional: [] } } }) satisfies Partial<Project> as never;
    const bound = await bindProject(binding, prepare);
    expect(bound.project).toMatchObject({ projectId: project.id, migration: { library: expect.any(Number) } });
    expect(await previousProjectIdIn(join(fixture.root, 'projects.json'), 'oc_pay')).toBeUndefined();
    await removeProject('支付组');
    expect(await previousProjectIdIn(join(fixture.root, 'projects.json'), 'oc_pay')).toBe(project.id);
    expect((await listProjectsIn(join(fixture.root, 'projects.json')))).toEqual([]);
  });
});

describe('editProject with a folder goes through the library', () => {
  const service = (executeCollaboration: (botId: string, request: unknown) => Promise<unknown>) => createAdminService({ executeCollaboration: executeCollaboration as never });
  const request = (project: Project, patch: Row = {}) => ({ action: 'editProject' as const, projectName: project.name, chatId: project.chatId, expectedRevision: projectRevision(project), ...patch });

  it('moves every binding of the project, forwards the rest on the fresh revision, and the drift check does not put the old folder back', async () => {
    const { id } = await sharedProject();
    const target = folder('moved');
    const forwarded: unknown[] = [];
    const rowOf = async () => (await listProjectsIn(rowsFile('cli_a')))[0]!;
    const reply = await service(async (_botId, forward) => { forwarded.push(forward); return { ok: true }; })
      .collaboration!('cli_a', request(await rowOf(), { directory: target, enabled: false }));
    expect(reply).toEqual({ ok: true });
    expect(forwarded).toEqual([expect.objectContaining({ action: 'editProject', enabled: false, expectedRevision: projectRevision(await rowOf()) })]);
    expect(forwarded[0]).not.toHaveProperty('directory');
    expect((await library()).find(project => project.id === id)).toMatchObject({ revision: 2, workspace: { primary: target } });
    for (const appId of ['cli_a', 'cli_b']) expect(stored(appId)[0]!.cwd).toBe(target);
    expect(detached('cli_b').oc_pay).toBe(true);
    // The old path left the library behind and the next start put the row back; now the library is where it was written.
    expect((await prepareLibraryAtStartup()).drift).toEqual([]);
    expect(stored('cli_a')[0]!.cwd).toBe(target);
  });

  it('answers a folder-only edit itself, refuses a stale revision before touching anything, and leaves a row with no project to the bot', async () => {
    const { id } = await sharedProject();
    const forwarded = vi.fn(async () => ({ ok: true, project: 'by-the-bot' }));
    const host = service(forwarded);
    const current = (await listProjectsIn(rowsFile('cli_a')))[0]!;
    await expect(host.collaboration!('cli_a', request(current, { expectedRevision: 'stale', directory: folder('moved') }))).rejects.toThrow('已改变');
    expect((await library()).find(project => project.id === id)!.revision).toBe(1);
    const answer = await host.collaboration!('cli_a', request(current, { directory: folder('moved') })) as { ok: boolean; project: { cwd: string } };
    expect(answer).toMatchObject({ ok: true, project: { name: '支付组', cwd: folder('moved') } });
    expect(forwarded).not.toHaveBeenCalled();
    // A row nothing links yet goes to the bot as it always did.
    rows('cli_a', [row('新群', 'oc_new', folder('fresh'))]);
    const lone = (await listProjectsIn(rowsFile('cli_a')))[0]!;
    await host.collaboration!('cli_a', request(lone, { directory: folder('other') }));
    expect(forwarded).toHaveBeenCalledWith('cli_a', expect.objectContaining({ directory: folder('other') }));
  });
});
