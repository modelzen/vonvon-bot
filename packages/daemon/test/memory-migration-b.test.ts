import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

import { prepareLibraryAtStartup } from '../src/admin/library';
import { libraryLocation } from '../src/project/library';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';

type Row = Record<string, unknown>;
const NOW = 1_761_200_000_000;
let work: string;
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-migration-')));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'memory-work-')));
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const APP = 'cli_a';
function folder(name: string): string { const path = join(work, name); mkdirSync(path, { recursive: true }); return path; }
function bots(): void {
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: APP, bots: [{ name: 'bot', appId: APP, tenant: 'feishu', createdAt: 1, botName: '小支', active: true }] }));
}
const botFile = (...parts: string[]) => join(fixture.root, 'bots', APP, ...parts);
const put = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
function rows(projects: Row[]): void { put(botFile('projects.json'), JSON.stringify({ version: 1, projects }, null, 2)); }
const stored = (): Row[] => JSON.parse(readFileSync(botFile('projects.json'), 'utf8')).projects;
const row = (name: string, chatId: string, cwd: string, extra: Row = {}): Row => ({ name, chatId, cwd, blank: false, createdAt: 1_000, ...extra });
const run = () => prepareLibraryAtStartup({ now: () => NOW });
const projectStore = (id: unknown) => new MemoryStore(projectMemoryLocation(String(id), { library: libraryLocation(fixture.root) }));
const botStore = () => new MemoryStore(botMemoryLocation(botFile('')));

describe('startup migration step B (supplement and memory)', () => {
  it('moves a row\'s persona to its supplement and its memory to trusted entries under 背景, from that group', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'), { profile: { persona: '只管发布', memory: '- 周四发版\n- 日志在 /var/log/pay', inheritPersona: false, inheritMemory: true } })]);
    bots();
    const report = await run();
    expect(report).toMatchObject({ memoryMigrated: 1, failed: [] });
    const [migrated] = stored();
    expect(migrated).toMatchObject({ supplement: '只管发布', migration: { library: NOW, memory: NOW }, profile: { persona: '只管发布' } });
    const view = await projectStore(migrated!.projectId).read();
    expect(view.items.map(item => item.text)).toEqual(['周四发版', '日志在 /var/log/pay']);
    for (const item of view.items) {
      expect(item).toMatchObject({ branch: '背景', state: 'active', trust: 'trusted', source: { via: 'import', actorRole: 'desktop', chatId: 'oc_pay', importFile: 'projects.json#oc_pay.profile.memory' } });
    }
  });

  it('does it once: a second start imports nothing again and does not touch a supplement the owner changed since', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'), { profile: { persona: '只管发布', memory: '周四发版', inheritPersona: true, inheritMemory: true } })]);
    bots();
    await run();
    const projectId = stored()[0]!.projectId;
    rows(stored().map(item => ({ ...item, supplement: '主人改过' })));
    expect((await run())).toMatchObject({ memoryMigrated: 0 });
    expect(stored()[0]!.supplement).toBe('主人改过');
    expect((await projectStore(projectId).read()).items).toHaveLength(1);
  });

  it('does not import twice when a run stopped after the entries went in and before the marker', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'), { profile: { persona: '', memory: '周四发版', inheritPersona: true, inheritMemory: true } })]);
    bots();
    await run();
    const projectId = stored()[0]!.projectId;
    // the marker is lost, the entries are there
    rows(stored().map(({ migration: _migration, ...rest }) => ({ ...rest, migration: { library: NOW } })));
    await run();
    expect((await projectStore(projectId).read()).items).toHaveLength(1);
    expect(stored()[0]!.migration).toEqual({ library: NOW, memory: NOW });
  });

  it('takes a row without a profile from its group files: the role file is the supplement, group.md becomes untrusted entries, and the files stay', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'))]);
    bots();
    put(botFile('groups', 'oc_pay', 'SOUL.md'), '群里的个性');
    put(botFile('groups', 'oc_pay', 'memory', 'group.md'), '一条\n\n两条');
    await run();
    const [migrated] = stored();
    expect(migrated!.supplement).toBe('群里的个性');
    const view = await projectStore(migrated!.projectId).read();
    expect(view.items.map(item => [item.text, item.trust, item.source.actorRole])).toEqual([['一条', 'untrusted', 'import'], ['两条', 'untrusted', 'import']]);
    expect(readFileSync(botFile('groups', 'oc_pay', 'SOUL.md'), 'utf8')).toBe('群里的个性');
    expect(existsSync(botFile('groups', 'oc_pay', 'memory', 'group.md'))).toBe(true);
  });

  it('puts the bot\'s old shared memory into Bot memory as archived entries under 其他, and leaves the file', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'))]);
    bots();
    put(botFile('memory', 'shared.md'), '- 公共一\n- 公共二');
    await run();
    const view = await botStore().read();
    expect(view.items.map(item => [item.text, item.state, item.branch, item.trust])).toEqual([['公共一', 'archived', '其他', 'untrusted'], ['公共二', 'archived', '其他', 'untrusted']]);
    expect(existsSync(botFile('memory', 'shared.md'))).toBe(true);
    await run();
    expect((await botStore().read()).items).toHaveLength(2);
  });

  it('keeps a supplement the row already has, and leaves the AGENTS.md step to step R (the role file is not read here)', async () => {
    rows([row('支付组', 'oc_pay', folder('pay'), { supplement: '已有补充', profile: { persona: '旧个性', memory: '', inheritPersona: true, inheritMemory: true } })]);
    bots();
    put(botFile('SOUL.md'), '## 身份与职责\n助手\n');
    put(botFile('AGENTS.md'), '旧规矩');
    await run();
    expect(stored()[0]!.supplement).toBe('已有补充');
    expect(readFileSync(botFile('SOUL.md'), 'utf8')).toContain('旧规矩');
  });

});
