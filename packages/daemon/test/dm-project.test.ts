import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupIdSchema } from '@vonvon/protocol';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async () => {
  const { join } = await import('node:path');
  const botDir = (appId: string) => join(fixture.root, 'bots', appId);
  const botPaths = (appId: string) => ({ dir: botDir(appId), configFile: join(botDir(appId), 'config.json'), sessionsFile: join(botDir(appId), 'sessions.json'), projectsFile: join(botDir(appId), 'projects.json'), processesFile: join(botDir(appId), 'processes.json') });
  return { botDir, botPaths, paths: {
    get appDir() { return fixture.root; },
    get botsFile() { return join(fixture.root, 'bots.json'); },
    get projectsFile() { return join(fixture.root, 'bots', APP, 'projects.json'); },
    get projectsRootDir() { return join(fixture.root, 'projects'); },
  } };
});
const APP = vi.hoisted(() => 'cli_fixture');

import { ensureDmProject } from '../src/bot/dm-project';
import { botIdentity, ensureBotDmDirectory, loadBots, withBotGroupBinding, type BotEntry } from '../src/config/bots';
import { libraryOverview, prepareLibraryAtStartup } from '../src/admin/library';
import { readLibrary, libraryLocation } from '../src/project/library';
import { createSettingsService } from '../src/admin/settings-service';
import type { AdminServiceDeps } from '../src/admin/service';
import { saveConfig } from '../src/config/store';
import { log } from '../src/core/logger';
import { addDmProject, addProject, bindProject, dmChatId, dmProject, getProjectByChatId, getProjectByChatIdSync, getProjectByName, listProjects, listProjectsIn, mutateProject, mutateProjectByChatId, rememberDmChat, removeProject, resetProjectDirectoryOverride, splitTierChats, updateProject, withStoredRows, type Project } from '../src/project/registry';

const file = () => join(fixture.root, 'bots', APP, 'projects.json');
const stored = (): Project[] => JSON.parse(readFileSync(file(), 'utf8')).projects;
const dmRow = (extra: Partial<Project> = {}): Project => ({ name: '私聊', chatId: dmChatId(APP), cwd: join(fixture.root, 'projects', 'dm'), blank: true, origin: 'created', kind: 'single', noMention: true, mode: 'full', network: true, createdAt: 1, dm: { people: {} }, ...extra });
const group = (name: string, chatId: string, extra: Partial<Project> = {}): Project => ({ name, chatId, cwd: mkdirIn(name), blank: false, createdAt: 2, ...extra });
function mkdirIn(name: string): string { const path = join(work, name); mkdirSync(path, { recursive: true }); return path; }
const entry: BotEntry = { name: 'jojo', appId: APP, tenant: 'feishu', createdAt: 1 };
function registered(extra: Partial<BotEntry> = {}): void {
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: APP, bots: [{ ...entry, ...extra }] }));
}
let work: string;
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-project-')));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'dm-project-work-')));
  mkdirSync(join(fixture.root, 'bots', APP), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

describe('reading the private-chat row', () => {
  beforeEach(async () => { await addDmProject(dmRow()); await addProject(group('demo', 'oc_demo')); });
  it('has an id the protocol takes for a group', () => expect(groupIdSchema.safeParse(dmChatId('cli_a9f1-x_2')).success).toBe(true));
  it('is not among the groups', async () => {
    expect((await listProjects()).map(row => row.name)).toEqual(['demo']);
    expect((await listProjectsIn(file())).map(row => row.name)).toEqual(['demo']);
    expect(await getProjectByName('私聊')).toBeUndefined();
    expect(await getProjectByName(dmChatId(APP))).toBeUndefined();
    expect((await dmProject())?.chatId).toBe(dmChatId(APP));
  });
  it('is reached by a p2p chat_id with that chat_id, and by oc_dm_ as stored', async () => {
    await rememberDmChat('oc_p2p', 'ou_a', '张三');
    for (const found of [await getProjectByChatId('oc_p2p'), getProjectByChatIdSync('oc_p2p')]) expect(found).toMatchObject({ name: '私聊', chatId: 'oc_p2p', mode: 'full' });
    for (const found of [await getProjectByChatId(dmChatId(APP)), getProjectByChatIdSync(dmChatId(APP))]) expect(found?.chatId).toBe(dmChatId(APP));
    expect(stored().find(row => row.dm)?.chatId).toBe(dmChatId(APP));
  });
  it('does not answer for a chat nobody remembered, or a name on the object prototype', async () => {
    expect(await getProjectByChatId('oc_other')).toBeUndefined();
    expect(getProjectByChatIdSync('constructor')).toBeUndefined();
    expect((await getProjectByChatId('oc_demo'))?.name).toBe('demo');
  });
  it('tolerates a hand-edited row with no people', async () => {
    writeFileSync(file(), JSON.stringify({ version: 1, projects: [{ ...dmRow(), dm: {} }] }));
    expect(await getProjectByChatId('oc_p2p')).toBeUndefined();
    expect((await dmProject())?.name).toBe('私聊');
  });
});

describe('rememberDmChat', () => {
  beforeEach(() => addDmProject(dmRow()));
  it('keeps each person, and the first time they came', async () => {
    await rememberDmChat('oc_a', 'ou_a', '张三');
    await rememberDmChat('oc_b', 'ou_b');
    const at = stored()[0]!.dm!.people.oc_a!.at;
    await rememberDmChat('oc_a', 'ou_a', '张三丰');
    expect(stored()[0]!.dm!.people).toEqual({ oc_a: { openId: 'ou_a', name: '张三丰', at }, oc_b: { openId: 'ou_b', at: expect.any(Number) } });
  });
  it('does not write when nothing changed', async () => {
    await rememberDmChat('oc_a', 'ou_a', '张三');
    // A marker a write would drop: it serializes the rows again.
    const marked = `${readFileSync(file(), 'utf8')}\n`;
    writeFileSync(file(), marked);
    await rememberDmChat('oc_a', 'ou_a');
    expect(readFileSync(file(), 'utf8')).toBe(marked);
  });
  it('fails when the bot has no private-chat row', async () => {
    writeFileSync(file(), JSON.stringify({ version: 1, projects: [] }));
    await expect(rememberDmChat('oc_a', 'ou_a')).rejects.toThrow('私聊项目不存在');
  });
});

describe('group writers', () => {
  beforeEach(() => addDmProject(dmRow({ dm: { people: { oc_p2p: { openId: 'ou_a', at: 1 } } } })));
  it('leave the row in the file', async () => {
    await addProject(group('demo', 'oc_demo'));
    await updateProject('demo', { branch: 'main' });
    await mutateProject('demo', row => { row.noMention = false; });
    await bindProject({ name: 'bound', chatId: 'oc_bound', cwd: { kind: 'existing', path: mkdirIn('bound') }, backend: 'codex-appserver', defaultBackend: 'codex-appserver', kind: 'multi', noMention: true },
      async () => ({ cwd: join(work, 'bound'), blank: false, createdAt: 3 }));
    await removeProject('demo');
    expect(stored().map(row => row.chatId)).toEqual([dmChatId(APP), 'oc_bound']);
    expect(stored()[0]!.dm!.people.oc_p2p!.openId).toBe('ou_a');
  });
  it('cannot reach it by name, and a group may have the same name', async () => {
    await addProject(group('私聊', 'oc_named'));
    await updateProject('私聊', { branch: 'main' });
    await mutateProject('私聊', row => { row.noMention = false; });
    expect(stored().find(row => row.dm)).not.toHaveProperty('branch');
    expect(stored().find(row => row.dm)?.noMention).toBe(true);
    expect((await removeProject('私聊'))?.chatId).toBe('oc_named');
    expect(await removeProject('私聊')).toBeUndefined();
    await expect(mutateProject('私聊', () => {})).rejects.toThrow('项目不存在');
    await updateProject('私聊', { branch: 'main' });
    await resetProjectDirectoryOverride('私聊', 'workspaces');
    expect(stored().map(row => row.chatId)).toEqual([dmChatId(APP)]);
  });
  it('binding its id is refused', () => expect(addProject(group('x', dmChatId(APP)))).rejects.toThrow('已绑定'));
});

describe('mutateProjectByChatId', () => {
  beforeEach(() => addDmProject(dmRow({ dm: { people: { oc_p2p: { openId: 'ou_a', at: 1 } } } })));
  it('finds the row by its own id and by a p2p chat_id, and keeps its id', async () => {
    await mutateProjectByChatId(dmChatId(APP), row => { row.skills = { disabledPaths: ['/a'] }; });
    const saved = await mutateProjectByChatId('oc_p2p', row => { row.defaultModel = 'm'; });
    expect(saved.chatId).toBe(dmChatId(APP));
    expect(stored()[0]).toMatchObject({ skills: { disabledPaths: ['/a'] }, defaultModel: 'm' });
  });
  it('throws for an unknown chat', () => expect(mutateProjectByChatId('oc_none', () => {})).rejects.toThrow('项目不存在'));
});

describe('code that walks the stored rows', () => {
  it('withStoredRows hands over the groups and writes the private chat back', async () => {
    await addDmProject(dmRow());
    await addProject(group('demo', 'oc_demo'));
    const seen: string[] = [];
    await withStoredRows({ file: file(), dataRoot: fixture.root }, async rows => { seen.push(...rows.map(row => row.chatId)); for (const row of rows) row.branch = 'x'; return true; });
    expect(seen).toEqual(['oc_demo']);
    expect(stored().map(row => row.branch)).toEqual([undefined, 'x']);
  });
  it('splitTierChats skips it', async () => {
    await addDmProject(dmRow());
    const body = JSON.parse(readFileSync(file(), 'utf8'));
    writeFileSync(file(), JSON.stringify({ ...body, tierMergePending: [dmChatId(APP)] }));
    expect((await splitTierChats(file())).size).toBe(0);
  });
  it('the project library neither links nor lists it', async () => {
    registered();
    await addDmProject(dmRow());
    await addProject(group('demo', 'oc_demo'));
    await prepareLibraryAtStartup({ now: () => 1000 });
    expect((await readLibrary(libraryLocation(fixture.root))).projects.map(project => project.name)).toEqual(['demo']);
    expect(stored().find(row => row.dm)).not.toHaveProperty('projectId');
    expect(stored().find(row => row.dm)).not.toHaveProperty('migration');
    const overview = await libraryOverview();
    expect(JSON.stringify(overview)).not.toContain(dmChatId(APP));
  });
});

describe('settings of a stopped bot', () => {
  it('read and save the private chat in the bot\'s own file', async () => {
    registered();
    await addDmProject(dmRow({ cwd: mkdirIn('dm') }));
    await addProject(group('私聊', 'oc_named'));
    await saveConfig({ accounts: { app: { id: APP, tenant: 'feishu', secret: { source: 'exec', id: 'fixture' } } } } as never, join(fixture.root, 'bots', APP, 'config.json'));
    const service = createSettingsService({ executeWrite: async () => { throw new Error('the bot is stopped'); } } as unknown as AdminServiceDeps);
    const scope = { kind: 'project' as const, botId: APP, projectName: dmChatId(APP) };
    const view = await service.read(scope);
    if (view.scope.kind !== 'project' || !('sections' in view)) throw new Error('not a project view');
    expect(view.identity.chatId).toBe(dmChatId(APP));
    const saved = await service.save({ scope, section: 'skills', revision: view.sections.skills.revision, patch: { disabledPaths: ['/x'] } } as never);
    expect(saved.kind).toBe('saved');
    expect(stored().find(row => row.dm)?.skills?.disabledPaths).toEqual(['/x']);
    expect(stored().find(row => !row.dm)).not.toHaveProperty('skills');
  });
});

describe('ensureDmProject', () => {
  const defaults = vi.fn(async () => ({ backend: 'claude-agent', defaultModel: 'm', defaultEffort: 'high' as const, modelAccess: { backend: 'claude-agent', models: ['m'], efforts: ['high' as const] } }));
  const ensure = () => ensureDmProject({ bot: botIdentity(entry), projectsRootDir: undefined, defaults });
  beforeEach(() => { defaults.mockClear(); });
  it('gives a new bot the row of 4.1 and the folder', async () => {
    registered();
    await ensure();
    const cwd = join(fixture.root, 'projects', 'jojo', 'dm');
    expect(statSync(cwd).isDirectory()).toBe(true);
    const [row] = stored();
    expect(row).toEqual({ name: '私聊', chatId: dmChatId(APP), cwd, blank: true, origin: 'created', kind: 'single', noMention: true, mode: 'full', network: true, createdAt: expect.any(Number), dm: { people: {} },
      backend: 'claude-agent', defaultModel: 'm', defaultEffort: 'high', modelAccess: { backend: 'claude-agent', models: ['m'], efforts: ['high'] } });
  });
  it('joins an upgraded bot\'s groups', async () => {
    registered();
    await addProject(group('demo', 'oc_demo'));
    await ensure();
    expect(stored().map(row => row.chatId)).toEqual(['oc_demo', dmChatId(APP)]);
    expect((await listProjects()).map(row => row.name)).toEqual(['demo']);
  });
  it('keeps the people and the settings on the next start, and works out no defaults', async () => {
    registered();
    await ensure();
    await rememberDmChat('oc_p2p', 'ou_a');
    await mutateProjectByChatId(dmChatId(APP), row => { row.defaultModel = 'mine'; });
    const before = readFileSync(file(), 'utf8');
    await ensure();
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(defaults).toHaveBeenCalledTimes(1);
  });
  it('makes a deleted folder again', async () => {
    registered();
    await ensure();
    const cwd = stored()[0]!.cwd;
    rmSync(cwd, { recursive: true });
    await ensure();
    expect(existsSync(cwd)).toBe(true);
  });
  it('leaves where groups go as it was: the same bot directory', async () => {
    registered();
    await ensure();
    const allocated = (await loadBots()).allocations?.[APP]?.namespaceRoot;
    const cwd = await withBotGroupBinding(botIdentity(entry), { chatId: 'oc_demo', name: 'demo', projectsRootDir: join(fixture.root, 'projects') }, async scope => (await scope.prepareDefault()).cwd);
    expect(cwd).toBe(join(allocated!, 'groups', 'demo'));
  });
  it('follows the bot\'s configured projects root when it has no directory yet', async () => {
    registered();
    await ensureDmProject({ bot: botIdentity(entry), projectsRootDir: join(work, 'root'), defaults });
    expect(stored()[0]!.cwd).toBe(join(work, 'root', 'jojo', 'dm'));
  });
  it('only logs a failure, and a later start makes the row', async () => {
    registered();
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    defaults.mockRejectedValueOnce(new Error('provider down'));
    await expect(ensure()).resolves.toBeUndefined();
    expect(fail).toHaveBeenCalledWith('project', expect.any(Error), { phase: 'dm-project' });
    expect(existsSync(file())).toBe(false);
    await ensure();
    expect(stored()).toHaveLength(1);
  });
  it('only logs when the registered bot is another incarnation', async () => {
    registered({ registrationId: 'other' });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await ensure();
    expect(fail).toHaveBeenCalledOnce();
    expect(existsSync(file())).toBe(false);
  });
  it('ensureBotDmDirectory is idempotent', async () => {
    registered();
    const first = await ensureBotDmDirectory(botIdentity(entry), join(fixture.root, 'projects'));
    expect(await ensureBotDmDirectory(botIdentity(entry), join(fixture.root, 'projects'))).toBe(first);
  });
});
