import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
const offlineProvider = vi.hoisted(() => vi.fn(() => { throw new Error('Provider is offline'); }));
vi.mock('../src/agent/index', () => ({ createBackend: offlineProvider }));
vi.mock('../src/config/paths', () => {
  const botDir = (id: string) => join(fixture.root, 'bots', id);
  const botPaths = (id: string) => ({ dir: botDir(id), configFile: join(botDir(id), 'config.json'), projectsFile: join(botDir(id), 'projects.json'), sessionsFile: join(botDir(id), 'sessions.json'), processesFile: join(botDir(id), 'processes.json') });
  return { botDir, botPaths, paths: {
    get appDir() { return fixture.root; },
    get botsFile() { return join(fixture.root, 'bots.json'); },
    get configFile() { return join(fixture.root, 'config.json'); },
    get projectsFile() { return join(fixture.root, 'projects.json'); },
    get projectsRootDir() { return join(fixture.root, 'projects'); },
  } };
});

import { dmPreparationError, prepareDmProjectForBot, prepareDmProjectsAtStartup, storedDmDefaults } from '../src/bot/dm-project';
import { resolveExecution } from '../src/config/execution';
import { loadBots, type BotEntry } from '../src/config/bots';
import type { AppPreferences } from '../src/config/schema';
import { log } from '../src/core/logger';
import { addProject, dmChatId, type Project } from '../src/project/registry';

const bots: BotEntry[] = [
  { appId: 'cli_upgrade_active', name: 'active', tenant: 'feishu', createdAt: 1, active: true },
  { appId: 'cli_upgrade_stopped', name: 'stopped', tenant: 'feishu', createdAt: 2, active: false },
];
const botFile = (bot: BotEntry, name: string) => join(fixture.root, 'bots', bot.appId, name);
const rows = (bot: BotEntry): Project[] => JSON.parse(readFileSync(botFile(bot, 'projects.json'), 'utf8')).projects;
function configure(bot: BotEntry, preferences?: AppPreferences): void {
  mkdirSync(join(fixture.root, 'bots', bot.appId), { recursive: true });
  writeFileSync(botFile(bot, 'config.json'), JSON.stringify({ version: 1, accounts: { app: { id: bot.appId, tenant: bot.tenant, secret: { source: 'exec', id: 'unavailable-test-secret' } } }, preferences }));
}
function group(name: string): Project {
  return { name, chatId: `oc_${name}`, cwd: join(fixture.root, name), blank: false, createdAt: 1 };
}
// Native realpath expands Windows 8.3 temp-directory aliases, matching fs/promises.realpath in production.
beforeEach(() => {
  fixture.root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-upgrade-')));
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: bots[0]!.appId, bots }));
  for (const bot of bots) configure(bot);
  offlineProvider.mockClear();
  vi.spyOn(log, 'fail').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture.root, { recursive: true, force: true }); });

describe('private chat upgrade before Provider startup', () => {
  it('prepares active and stopped old Bots without allocations or a working Provider, in separate files', async () => {
    const active = bots[0]!, stopped = bots[1]!;
    configure(active, { defaults: { backend: 'claude-agent', model: { kind: 'custom', id: 'offline-custom-model', effort: 'high' } } });
    configure(stopped, { defaults: { backend: 'codex-appserver', model: { kind: 'catalog', id: 'stored-codex-model', effort: 'low' } } });
    for (const bot of bots) writeFileSync(botFile(bot, 'projects.json'), JSON.stringify({ version: 1, projects: [group(bot.name)] }));
    expect((await loadBots()).allocations).toBeUndefined();
    await prepareDmProjectsAtStartup();
    for (const bot of bots) {
      expect(rows(bot).map(row => row.chatId)).toEqual([`oc_${bot.name}`, dmChatId(bot.appId)]);
      const dm = rows(bot).find(row => row.dm)!;
      expect(dm).toMatchObject({ kind: 'single', smart: true, noMention: true, mode: 'full', network: true, dm: { people: {} } });
      expect(existsSync(dm.cwd)).toBe(true);
      expect(dm.cwd).toBe(join(fixture.root, 'projects', bot.name, 'dm'));
      expect(dmPreparationError(bot.appId)).toBeUndefined();
    }
    expect(rows(active).find(row => row.dm)).toMatchObject({ backend: 'claude-agent', defaultModel: 'offline-custom-model', defaultModelCustom: true, defaultEffort: 'high' });
    expect(rows(stopped).find(row => row.dm)).toMatchObject({ backend: 'codex-appserver', defaultModel: 'stored-codex-model', defaultEffort: 'low' });
    expect(offlineProvider).not.toHaveBeenCalled();
    expect(existsSync(join(fixture.root, 'projects.json'))).toBe(false);
  });

  it('upgrades a legacy current-only registry without active flags or prior namespace allocation', async () => {
    const legacy = bots.map(({ active: _active, ...bot }) => bot);
    writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: legacy[0]!.appId, bots: legacy }));
    await prepareDmProjectsAtStartup();
    for (const bot of legacy) expect(rows(bot).filter(row => row.dm).map(row => row.chatId)).toEqual([dmChatId(bot.appId)]);
    expect(offlineProvider).not.toHaveBeenCalled();
  });

  it('resolves stored defaults synchronously, including absent and removed backend preferences', () => {
    expect(storedDmDefaults(undefined)).toEqual({ backend: 'codex-appserver' });
    expect(storedDmDefaults({ defaults: { backend: 'removed-backend' } })).toEqual({ backend: 'codex-appserver' });
    expect(storedDmDefaults({ defaults: { backend: 'claude-agent', model: { kind: 'custom', id: 'my-model', effort: 'high' } } })).toEqual({ backend: 'claude-agent', defaultModel: 'my-model', defaultModelCustom: true, defaultEffort: 'high' });
    expect(offlineProvider).not.toHaveBeenCalled();
  });

  it('keeps Provider defaults for a DM created without a model after the Bot model changes', async () => {
    const bot = bots[0]!;
    await prepareDmProjectsAtStartup();
    const dm = rows(bot).find(row => row.dm)!;
    expect(dm.defaultModel).toBeUndefined();
    expect(dm.dm?.useProviderDefault).toBe(true);
    const changed: AppPreferences = { defaults: { backend: 'codex-appserver', model: { kind: 'custom', id: 'later-bot-model', effort: 'high' } } };
    configure(bot, changed);
    await prepareDmProjectsAtStartup();
    const preservedDm = rows(bot).find(row => row.dm)!;
    expect(resolveExecution({ bot: changed, group: preservedDm }).model).toBeUndefined();
    expect(resolveExecution({ bot: changed, group: group('ordinary') }).model).toMatchObject({ model: 'later-bot-model', effort: 'high', custom: true, source: 'bot' });
    expect(preservedDm).toEqual(dm);
  });

  it('preserves legacy unmarked DM model inheritance and does not rewrite its file', async () => {
    const bot = bots[0]!;
    const cwd = join(fixture.root, 'legacy-private-chat');
    mkdirSync(cwd);
    const legacy: Project = { name: '私聊', chatId: dmChatId(bot.appId), cwd, blank: false, createdAt: 12, backend: 'codex-appserver', dm: { people: {} } };
    const original = `${JSON.stringify({ version: 1, projects: [legacy] }, null, 3)}\n\n`;
    writeFileSync(botFile(bot, 'projects.json'), original);
    const preferences: AppPreferences = { defaults: { backend: 'codex-appserver', model: { kind: 'custom', id: 'legacy-bot-model', effort: 'high' } } };
    configure(bot, preferences);
    await prepareDmProjectsAtStartup();
    const dm = rows(bot).find(row => row.dm)!;
    expect(dm.dm?.useProviderDefault).toBeUndefined();
    expect(resolveExecution({ bot: preferences, group: dm }).model).toMatchObject({ model: 'legacy-bot-model', effort: 'high', custom: true, source: 'bot' });
    expect(readFileSync(botFile(bot, 'projects.json'), 'utf8')).toBe(original);
  });

  it('preserves existing private-chat settings, people and custom cwd byte-for-byte on repeated startup', async () => {
    const bot = bots[1]!;
    const cwd = join(fixture.root, 'custom-private-chat');
    mkdirSync(cwd);
    const dm: Project = { name: '私聊', chatId: dmChatId(bot.appId), cwd, blank: false, createdAt: 12, smart: false, noMention: false, mode: 'qa', network: false, backend: 'claude-agent', defaultModel: 'keep-me', defaultEffort: 'high', dm: { people: { oc_known: { openId: 'ou_known', name: 'Known person', at: 7 } } } };
    const original = `${JSON.stringify({ version: 1, projects: [group('existing'), dm] }, null, 3)}\n\n`;
    writeFileSync(botFile(bot, 'projects.json'), original);
    configure(bot, { defaults: { backend: 'codex-appserver', model: { kind: 'custom', id: 'do-not-inherit' } } });
    await prepareDmProjectsAtStartup();
    await prepareDmProjectsAtStartup();
    expect(readFileSync(botFile(bot, 'projects.json'), 'utf8')).toBe(original);
    expect(existsSync(join(fixture.root, 'projects', bot.name, 'dm'))).toBe(false);
    expect((await loadBots()).allocations?.[bot.appId]).toBeUndefined();
  });

  it('keeps corrupt project data untouched, prepares other Bots, and clears the failure after repair', async () => {
    const bot = bots[0]!;
    const broken = '{"version":1,"projects":[';
    writeFileSync(botFile(bot, 'projects.json'), broken);
    await prepareDmProjectsAtStartup();
    expect(readFileSync(botFile(bot, 'projects.json'), 'utf8')).toBe(broken);
    expect(dmPreparationError(bot.appId)).toBeTruthy();
    expect(rows(bots[1]!).filter(row => row.dm)).toHaveLength(1);
    writeFileSync(botFile(bot, 'projects.json'), JSON.stringify({ version: 1, projects: [group('recovered')] }));
    await prepareDmProjectsAtStartup();
    expect(rows(bot).map(row => row.chatId)).toEqual(['oc_recovered', dmChatId(bot.appId)]);
    expect(dmPreparationError(bot.appId)).toBeUndefined();
  });

  it('serializes concurrent preparation and group writes without duplicates or lost groups', async () => {
    const bot = bots[0]!;
    const target = { file: botFile(bot, 'projects.json'), dataRoot: fixture.root };
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => prepareDmProjectForBot(bot)),
      ...Array.from({ length: 8 }, (_, index) => addProject(group(`concurrent_${index}`), target)),
    ]);
    expect(results.slice(0, 8).every(row => row !== undefined)).toBe(true);
    expect(rows(bot).filter(row => row.dm)).toHaveLength(1);
    expect(rows(bot).filter(row => !row.dm).map(row => row.chatId).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `oc_concurrent_${index}`).sort());
    expect(dmPreparationError(bot.appId)).toBeUndefined();
  });
});
