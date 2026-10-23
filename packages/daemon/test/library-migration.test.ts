import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectSectionSchemas } from '@vonvon/protocol';

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

import { libraryOverview, prepareLibraryAtStartup } from '../src/admin/library';
import { libraryLocation, PROJECT_NAME_MAX, readLibrary } from '../src/project/library';
import { log } from '../src/core/logger';
import { listProjectsIn, mutateProject, splitTierChats } from '../src/project/registry';
import { parseDirectorySettings } from '../src/config/directories';
import { runProjectList } from '../src/cli/commands/project';

type Row = Record<string, unknown>;
const NOW = 1_761_200_000_000;
let work: string;

beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'library-migration-')));
  // Outside the data root: a workspace inside it is refused, and the drift check now writes folders through that rule.
  work = realpathSync(mkdtempSync(join(tmpdir(), 'library-work-')));
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

function folder(name: string): string { const path = join(work, name); mkdirSync(path, { recursive: true }); return path; }
function bots(entries: Array<{ appId: string; botName: string; active?: boolean }>): void {
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: entries[0]?.appId,
    bots: entries.map((entry, index) => ({ name: `bot${index}`, appId: entry.appId, tenant: 'feishu', createdAt: 1, botName: entry.botName, active: entry.active ?? true })) }));
}
const rowsFile = (appId: string) => join(fixture.root, 'bots', appId, 'projects.json');
function rows(appId: string, projects: Row[]): void {
  mkdirSync(join(fixture.root, 'bots', appId), { recursive: true });
  writeFileSync(rowsFile(appId), JSON.stringify({ version: 1, projects }, null, 2));
}
const stored = (appId: string): Row[] => JSON.parse(readFileSync(rowsFile(appId), 'utf8')).projects;
const row = (name: string, chatId: string, cwd: string, extra: Row = {}): Row => ({ name, chatId, cwd, blank: false, createdAt: 1_000, ...extra });
const library = async () => (await readLibrary(libraryLocation(fixture.root))).projects;
const run = (options: Parameters<typeof prepareLibraryAtStartup>[0] = {}) => prepareLibraryAtStartup({ now: () => NOW, ...options });

/** The reader of a daemon from before P1a (dev 9b113b6 `listProjectsIn`), inlined: a rolled-back daemon must still start on migrated rows. */
function readLikeOldDaemon(file: string): Row[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.some((p: Row) => !p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.cwd !== 'string')) throw new Error('项目注册表格式无效');
  for (const project of parsed.projects) {
    parseDirectorySettings(project.directories);
    for (const key of ['profile', 'modelAccess', 'smartRules', 'skills', 'presentation'] as const) {
      if (project[key] !== undefined && !projectSectionSchemas[key].safeParse(project[key]).success) throw new Error(`Invalid group settings: ${key}`);
    }
  }
  return parsed.projects;
}

describe('startup migration step A', () => {
  it('gives every row, a stopped bot\'s too, a project in the library and leaves its folder alone', async () => {
    const pay = folder('pay'), web = folder('web'), release = folder('release');
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发', active: false }]);
    rows('cli_a', [row('支付组', 'oc_pay', pay), row('官网', 'oc_web', web, { enabled: false })]);
    rows('cli_b', [row('发布群', 'oc_rel', release)]);
    const report = await run();
    expect(report).toMatchObject({ linked: 3, created: 3, failed: [], drift: [] });
    const projects = await library();
    expect(projects.map(project => project.name).sort()).toEqual(['发布群', '官网', '支付组']);
    for (const [appId, chatId, cwd] of [['cli_a', 'oc_pay', pay], ['cli_a', 'oc_web', web], ['cli_b', 'oc_rel', release]] as const) {
      const stored_ = stored(appId).find(item => item.chatId === chatId)!;
      expect(stored_.cwd).toBe(cwd);
      expect(stored_.migration).toEqual({ library: NOW, memory: NOW });
      const project = projects.find(item => item.id === stored_.projectId)!;
      expect(project).toMatchObject({ migratedFrom: { botId: appId, chatId }, revision: 1, createdAt: 1_000, workspace: { primary: cwd, additional: [] } });
    }
  });

  it('puts bindings of one folder, a symlinked one too, into one project', async () => {
    const shared = folder('shared');
    symlinkSync(shared, join(work, 'alias'));
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', shared)]);
    rows('cli_b', [row('支付组', 'oc_pay', shared), row('发布群', 'oc_rel', join(work, 'alias'))]);
    await run();
    const ids = new Set([...stored('cli_a'), ...stored('cli_b')].map(item => item.projectId));
    expect(ids.size).toBe(1);
    expect(await library()).toHaveLength(1);
    expect(stored('cli_b')[1]!.cwd).toBe(join(work, 'alias'));
  });

  it('keeps two bots of one group in two projects when their folders differ, each named after its bot (D2)', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('a-pay')), row('官网', 'oc_web', folder('a-web')), row('发布群', 'oc_rel', folder('a-rel')), row('周会', 'oc_week', folder('week'))]);
    // 官网 here is another group with a taken name; 发布 is the same group as 发布群 under another name; 周会 shares its folder.
    rows('cli_b', [row('支付组', 'oc_pay', folder('b-pay')), row('官网', 'oc_other', folder('b-web')), row('发布', 'oc_rel', folder('b-rel')), row('周会', 'oc_week', join(work, 'week'))]);
    await run();
    const names = new Map((await library()).map(project => [project.id, project.name]));
    expect(stored('cli_a').map(item => names.get(item.projectId as string))).toEqual(['支付组（小支）', '官网', '发布群（小支）', '周会']);
    expect(stored('cli_b').map(item => names.get(item.projectId as string))).toEqual(['支付组（小发）', '官网 2', '发布（小发）', '周会']);
  });

  it('cuts a long group name so the project name fits the library', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    const long = '群'.repeat(1000);
    rows('cli_a', [row(long, 'oc_long', folder('a-long'))]);
    rows('cli_b', [row(long, 'oc_long', folder('b-long'))]);
    expect((await run()).failed).toEqual([]);
    const names = (await library()).map(project => project.name).sort();
    expect(names.map(name => name.length)).toEqual([PROJECT_NAME_MAX, PROJECT_NAME_MAX]);
    expect(names.map(name => name.slice(-4))).toEqual(['群（小发）', '群（小支）'].map(name => name.slice(-4)).sort());
    expect([...stored('cli_a'), ...stored('cli_b')].every(item => typeof item.projectId === 'string')).toBe(true);
  });

  it('keys a folder that is missing at the first start by its real path, so a later binding of it joins', async () => {
    mkdirSync(join(work, 'real'), { recursive: true });
    symlinkSync(join(work, 'real'), join(work, 'link'));
    const cwd = join(work, 'link', 'proj');
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', cwd)]);
    await run();
    expect((await library())[0]!.workspace.primary).toBe(join(work, 'real', 'proj'));
    mkdirSync(join(work, 'real', 'proj'));
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_b', [row('支付组', 'oc_pay', cwd)]);
    expect(await run()).toMatchObject({ created: 0, linked: 1, drift: [] });
    expect(await library()).toHaveLength(1);
    expect(stored('cli_b')[0]!.projectId).toBe(stored('cli_a')[0]!.projectId);
  });

  it('settles a folder behind a link whose target is gone once the target is back, and never splits it', async () => {
    mkdirSync(join(work, 'volume', 'proj'), { recursive: true });
    symlinkSync(join(work, 'volume'), join(work, 'code'));
    renameSync(join(work, 'volume'), join(work, 'unmounted'));
    const cwd = join(work, 'code', 'proj');
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', cwd)]);
    rows('cli_b', [row('支付组', 'oc_pay', cwd)]);
    expect(await run()).toMatchObject({ created: 1, linked: 2, drift: [] });
    expect((await library())[0]!.workspace.primary).toBe(cwd);
    renameSync(join(work, 'unmounted'), join(work, 'volume'));
    const id = stored('cli_a')[0]!.projectId as string;
    // The same folder, now resolvable: the library takes the canonical path, the rows (which resolve to it) do not drift.
    expect((await run()).drift).toEqual([{ projectId: id, rows: 0, fields: ['primary'], outcome: 'repaired' }]);
    expect((await library())[0]).toMatchObject({ id, revision: 2, workspace: { primary: join(work, 'volume', 'proj') } });
    expect(stored('cli_a')[0]!.cwd).toBe(cwd);
    expect((await run()).drift).toEqual([]);
  });

  it('gives a group bound again to another folder a new project and leaves the old one as it was', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    const pay = folder('pay');
    rows('cli_a', [row('支付组', 'oc_pay', pay)]);
    await run();
    const [before] = await library();
    // Unbound (the project stays, D4), then bound again to another folder by a path that does not name a project yet.
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay-2'))]);
    expect(await run()).toMatchObject({ created: 1, linked: 1, drift: [] });
    const after = await library();
    expect(after.find(project => project.id === before!.id)).toEqual(before);
    expect(after.find(project => project.id === stored('cli_a')[0]!.projectId)).toMatchObject({ name: '支付组 2', workspace: { primary: join(work, 'pay-2') } });
    // Bound back to the first folder: it finds its old project again.
    rows('cli_a', [row('支付组', 'oc_pay', pay)]);
    await run();
    expect(stored('cli_a')[0]!.projectId).toBe(before!.id);
  });

  it('leaves a bot the bridge import still holds as it is', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'))]);
    rows('cli_b', [row('发布群', 'oc_rel', folder('release'))]);
    const txId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(join(fixture.root, 'import', 'bridge'), { recursive: true });
    writeFileSync(join(fixture.root, 'import', 'bridge', 'journal.json'), JSON.stringify({ version: 1, txId, hostPid: process.pid, startedAt: 1, uid: 501,
      bridgeDir: join(fixture.root, 'old'), plistFile: join(fixture.root, 'old.plist'), reservedAppIds: ['cli_a'], acquiredLocks: [],
      before: { plist: { present: false }, serviceLoaded: false, holders: [{ appId: 'cli_a', pid: null, startedAt: null }] },
      stageDir: join(fixture.root, 'import', 'bridge', txId), stageIdentity: null, intents: [], step: 'staging', cleanupPending: false, outcome: null }));
    const before = readFileSync(rowsFile('cli_a'), 'utf8');
    const report = await run();
    expect(report.failed).toEqual([{ botId: 'cli_a', error: expect.stringContaining('正在从 bridge 导入') }]);
    expect(readFileSync(rowsFile('cli_a'), 'utf8')).toBe(before);
    expect(stored('cli_b')[0]!.projectId).toEqual(expect.any(String));
    expect((await library()).map(project => project.name)).toEqual(['发布群']);
  });

  it('does not come back to a row without a group at every start', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay')), { name: '旧行', cwd: folder('old'), blank: false, createdAt: 1 }]);
    await run();
    const before = readFileSync(rowsFile('cli_a'), 'utf8');
    const warn = vi.spyOn(log, 'warn');
    expect(await run()).toEqual({ linked: 0, created: 0, failed: [], drift: [], memoryMigrated: 0 });
    expect(warn.mock.calls.filter(call => call[1] === 'row_skipped')).toEqual([]);
    expect(readFileSync(rowsFile('cli_a'), 'utf8')).toBe(before);
    warn.mockRestore();
  });

  it('removes a temporary library file a killed start left behind', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'))]);
    await run();
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    const leftover = join(libraryLocation(fixture.root).dir, `projects.json.tmp-${gone}-0f0e0d0c-0b0a-4908-8706-050403020100`);
    writeFileSync(leftover, '{"version":1');
    await run();
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(libraryLocation(fixture.root).dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('changes nothing on the next start', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'))]);
    await run();
    const files = [readFileSync(rowsFile('cli_a'), 'utf8'), readFileSync(libraryLocation(fixture.root).file, 'utf8')];
    expect(await run({ now: () => NOW + 1 })).toEqual({ linked: 0, created: 0, failed: [], drift: [], memoryMigrated: 0 });
    expect([readFileSync(rowsFile('cli_a'), 'utf8'), readFileSync(libraryLocation(fixture.root).file, 'utf8')]).toEqual(files);
  });

  it('leaves no orphan project when a start fails between the library and the rows', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay')), row('官网', 'oc_web', folder('web'))]);
    rows('cli_b', [row('发布群', 'oc_rel', folder('release'))]);
    const first = await run({ afterLibraryWrite: botId => { if (botId === 'cli_a') throw new Error('cut'); } });
    expect(first.failed).toEqual([{ botId: 'cli_a', error: 'cut' }]);
    expect(stored('cli_a').every(item => item.projectId === undefined)).toBe(true);
    const made = (await library()).map(project => project.id).sort();
    expect(made).toHaveLength(3);
    const second = await run();
    expect(second).toMatchObject({ linked: 2, created: 0, failed: [] });
    expect((await library()).map(project => project.id).sort()).toEqual(made);
    expect(new Set([...stored('cli_a'), ...stored('cli_b')].map(item => item.projectId)).size).toBe(3);
  });

  it('gives a row whose project the library lost that project back under the same id', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    const pay = folder('pay');
    rows('cli_a', [row('支付组', 'oc_pay', pay)]);
    rows('cli_b', [row('支付组', 'oc_pay', pay)]);
    await run();
    const id = stored('cli_a')[0]!.projectId;
    rmSync(libraryLocation(fixture.root).file);
    expect((await run()).created).toBe(1);
    expect((await library()).map(project => project.id)).toEqual([id]);
    expect(stored('cli_b')[0]!.projectId).toBe(id);
  });

  it('writes rows an older daemon still reads, and the registry\'s own writes keep the new keys', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    const profile = { persona: '先说结论', memory: '', inheritPersona: true, inheritMemory: true };
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'), { profile, directories: { workspaces: { primary: join(work, 'pay'), additional: [] } } })]);
    await run();
    expect(readLikeOldDaemon(rowsFile('cli_a'))[0]).toMatchObject({ projectId: expect.stringMatching(/^prj_/), profile });
    const read = await listProjectsIn(rowsFile('cli_a'));
    expect(read[0]!.projectId).toBe(stored('cli_a')[0]!.projectId);
    await mutateProject('支付组', project => { project.noMention = false; }, undefined, { file: rowsFile('cli_a'), dataRoot: fixture.root });
    expect(stored('cli_a')[0]).toMatchObject({ noMention: false, projectId: read[0]!.projectId, migration: { library: NOW } });
  });

  it('keeps a row\'s stored second tier for the tier merge (s15c)', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'), { mode: 'full', guestMode: 'qa' })]);
    await run();
    expect(stored('cli_a')[0]).toMatchObject({ guestMode: 'qa', projectId: expect.any(String) });
    expect(await splitTierChats(rowsFile('cli_a'))).toEqual(new Map([['oc_pay', 'qa']]));
  });

  it('fails one bot whose rows cannot be read and still migrates the others', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    mkdirSync(join(fixture.root, 'bots', 'cli_a'), { recursive: true });
    writeFileSync(rowsFile('cli_a'), '{"projects": "broken"}');
    rows('cli_b', [row('发布群', 'oc_rel', folder('release'))]);
    const report = await run();
    expect(report.failed.map(item => item.botId)).toEqual(['cli_a']);
    expect(stored('cli_b')[0]!.projectId).toEqual(expect.any(String));
  });

  it('makes an empty library folder, and nothing else, without bots or rows', async () => {
    expect(await run()).toEqual({ linked: 0, created: 0, failed: [], drift: [] });
    expect(existsSync(libraryLocation(fixture.root).dir)).toBe(true);
    bots([{ appId: 'cli_a', botName: '小支' }]);
    expect(await run()).toEqual({ linked: 0, created: 0, failed: [], drift: [], memoryMigrated: 0 });
    expect(() => readFileSync(libraryLocation(fixture.root).file)).toThrow();
  });

  it('carries a row\'s tier, network, custom permissions and unknown keys over byte for byte', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    const kept = { mode: 'qa', network: true, custom: { backend: 'codex', settings: { sandbox: 'off', broken: [1] } }, later: { any: 'thing' } };
    rows('cli_a', [row('支付组', 'oc_pay', folder('pay'), kept)]);
    await run();
    const after = stored('cli_a')[0]!;
    for (const [key, value] of Object.entries(kept)) expect(JSON.stringify(after[key])).toBe(JSON.stringify(value));
  });
});

const sessionsFile = (appId: string) => join(fixture.root, 'bots', appId, 'sessions.json');
function sessions(appId: string, chats: string[]): void {
  writeFileSync(sessionsFile(appId), JSON.stringify({ version: 3, titleJobs: [], sessions: chats.map(chatId => ({ threadId: `th_${chatId}`, chatId, cwd: '/old', sessionId: 's', backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 1 })) }));
}
const detached = (appId: string): Record<string, boolean> => Object.fromEntries((JSON.parse(readFileSync(sessionsFile(appId), 'utf8')).sessions as Row[]).map(item => [item.chatId as string, item.detached === true]));

describe('startup drift check', () => {
  it('makes a row that an older path changed follow the library again and archives its group\'s sessions', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    const pay = folder('pay');
    rows('cli_a', [row('支付组', 'oc_pay', pay), row('官网', 'oc_web', folder('web'))]);
    await run();
    const [project] = await library();
    rows('cli_a', stored('cli_a').map(item => item.chatId === 'oc_pay' ? { ...item, cwd: folder('moved') } : item));
    sessions('cli_a', ['oc_pay', 'oc_web']);
    const report = await run();
    expect(report.drift).toEqual([{ projectId: project!.id, rows: 1, fields: ['primary'], outcome: 'repaired' }]);
    // The library is the source of truth: it is untouched, the row took its folder.
    expect((await library())[0]).toEqual(project);
    expect(stored('cli_a')[0]).toMatchObject({ cwd: pay, directories: { workspaces: { primary: pay, additional: [] } } });
    expect(detached('cli_a')).toEqual({ oc_pay: true, oc_web: false });
    expect((await run()).drift).toEqual([]);
  });

  it('does not take a folder behind a link whose target is gone as a move', async () => {
    mkdirSync(join(work, 'volume', 'proj'), { recursive: true });
    symlinkSync(join(work, 'volume'), join(work, 'code'));
    bots([{ appId: 'cli_a', botName: '小支' }]);
    rows('cli_a', [row('支付组', 'oc_pay', join(work, 'code', 'proj'))]);
    await run();
    const before = await library();
    expect(before[0]!.workspace.primary).toBe(join(work, 'volume', 'proj'));
    renameSync(join(work, 'volume'), join(work, 'unmounted'));
    expect((await run()).drift).toEqual([]);
    expect(await library()).toEqual(before);
    renameSync(join(work, 'unmounted'), join(work, 'volume'));
    expect((await run()).drift).toEqual([]);
    expect(await library()).toEqual(before);
  });

  it('brings every binding of a shared project back to the project\'s folder', async () => {
    const shared = folder('shared');
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', shared)]);
    rows('cli_b', [row('支付组', 'oc_pay', shared)]);
    await run();
    const moved = folder('moved');
    for (const appId of ['cli_a', 'cli_b']) rows(appId, stored(appId).map(item => ({ ...item, cwd: moved })));
    expect((await run()).drift).toEqual([{ projectId: stored('cli_a')[0]!.projectId, rows: 2, fields: ['primary'], outcome: 'repaired' }]);
    expect((await library())[0]!.workspace.primary).toBe(shared);
    for (const appId of ['cli_a', 'cli_b']) expect(stored(appId)[0]!.cwd).toBe(shared);
  });

  it('keeps the union of the extra folders when rows join one project by folder, and a row moved onto another project\'s folder goes back', async () => {
    const shared = folder('shared'), extra = folder('extra'), other = folder('other');
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    rows('cli_a', [row('支付组', 'oc_pay', shared), row('官网', 'oc_web', other)]);
    rows('cli_b', [row('支付组', 'oc_pay', shared, { directories: { workspaces: { primary: shared, additional: [extra] } } })]);
    const first = await run();
    // The second row's extra folder is not dropped: the project has it, and the first row now mirrors it.
    expect((await library()).find(project => project.workspace.primary === shared)).toMatchObject({ revision: 2, workspace: { additional: [extra] } });
    expect(first.drift).toEqual([{ projectId: stored('cli_a')[0]!.projectId, rows: 1, fields: ['additional'], outcome: 'repaired' }]);
    expect(stored('cli_a')[0]).toMatchObject({ directories: { workspaces: { primary: shared, additional: [extra] } } });
    rows('cli_a', stored('cli_a').map(item => item.chatId === 'oc_web' ? { ...item, cwd: shared } : item));
    const second = await run();
    expect(second.drift).toEqual([{ projectId: stored('cli_a')[1]!.projectId, rows: 1, fields: ['primary'], outcome: 'repaired' }]);
    expect(stored('cli_a')[1]!.cwd).toBe(other);
  });

  it('leaves a drifted row of a bot that runs in another process for the next start', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }]);
    const pay = folder('pay');
    rows('cli_a', [row('支付组', 'oc_pay', pay)]);
    await run();
    const moved = folder('moved');
    rows('cli_a', stored('cli_a').map(item => ({ ...item, cwd: moved })));
    writeFileSync(join(fixture.root, 'bots', 'cli_a', 'processes.json'), JSON.stringify({ pid: process.ppid, appId: 'cli_a', startedAt: Date.now() }));
    const report = await run();
    expect(report.drift).toEqual([{ projectId: stored('cli_a')[0]!.projectId, rows: 1, fields: ['primary'], outcome: 'failed' }]);
    expect(stored('cli_a')[0]!.cwd).toBe(moved);
    rmSync(join(fixture.root, 'bots', 'cli_a', 'processes.json'));
    expect((await run()).drift).toEqual([{ projectId: stored('cli_a')[0]!.projectId, rows: 1, fields: ['primary'], outcome: 'repaired' }]);
    expect(stored('cli_a')[0]!.cwd).toBe(pay);
  });
});

describe('vonvon project list', () => {
  it('lists each project with its folder and groups, one without a group, and rows still waiting', async () => {
    bots([{ appId: 'cli_a', botName: '小支' }, { appId: 'cli_b', botName: '小发' }]);
    const pay = folder('pay'), web = folder('web'), release = folder('release');
    rows('cli_a', [row('支付组', 'oc_pay', pay), row('官网', 'oc_web', web, { enabled: false })]);
    rows('cli_b', [row('支付组', 'oc_pay', pay), row('发布群', 'oc_rel', release)]);
    await run();
    // 发布群 unbound since (its project stays, D4); 新群 bound since, linked at the next start.
    rows('cli_b', [stored('cli_b')[0]!, row('新群', 'oc_new', folder('new'))]);
    const id = new Map((await library()).map(project => [project.name, project.id]));
    const out: string[] = [];
    await runProjectList({ json: false, write: text => { out.push(text); } });
    expect(out.join('').split('\n')).toEqual([
      `支付组  ${id.get('支付组')}  ${pay}`,
      '  小支 在 支付组  oc_pay',
      '  小发 在 支付组  oc_pay',
      `官网  ${id.get('官网')}  ${web}`,
      '  小支 在 官网  oc_web（群已停用）',
      `发布群  ${id.get('发布群')}  ${release}`,
      '  没有群',
      '还有 1 个群没有项目，daemon 下次启动时会建好：小发 在 新群',
      '',
    ]);
    const json: string[] = [];
    await runProjectList({ json: true, write: text => { json.push(text); } });
    expect(JSON.parse(json.join(''))).toEqual(JSON.parse(JSON.stringify(await libraryOverview())));
  });

  it('says there are no projects yet', async () => {
    const out: string[] = [];
    await runProjectList({ json: false, write: text => { out.push(text); } });
    expect(out.join('')).toBe('还没有项目。绑定群以后，daemon 启动时给每个群建好项目。\n');
  });
});
