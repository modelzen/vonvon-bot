import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '', target: '', refuse: 0, calls: 0, code: 'EPERM' }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (String(args[1]) === fixture.target) {
      fixture.calls++;
      if (fixture.refuse-- > 0) throw Object.assign(new Error('Windows reader holds destination'), { code: fixture.code });
    }
    return actual.rename(...args);
  } };
});
vi.mock('../src/config/paths', () => {
  const botDir = (id: string) => join(fixture.root, 'bots', id);
  const botPaths = (id: string) => ({ dir: botDir(id), configFile: join(botDir(id), 'config.json'), projectsFile: join(botDir(id), 'projects.json') });
  return { botDir, botPaths, paths: {
    get appDir() { return fixture.root; },
    get botsFile() { return join(fixture.root, 'bots.json'); },
    get configFile() { return join(fixture.root, 'config.json'); },
    get projectsFile() { return join(fixture.root, 'projects.json'); },
    get projectsRootDir() { return join(fixture.root, 'projects'); },
  } };
});

import { prepareDmProjectForBot } from '../src/bot/dm-project';
import { ensureRegistry, type BotEntry } from '../src/config/bots';
import { addProject, dmChatId, updateProject, type Project } from '../src/project/registry';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const bot: BotEntry = { appId: 'cli_atomic_test', name: 'atomic', tenant: 'feishu', createdAt: 1 };
const group = (name: string): Project => ({ name, chatId: `oc_${name}`, cwd: fixture.root, blank: false, createdAt: 1 });
beforeEach(() => {
  fixture.root = realpathSync.native(mkdtempSync(join(tmpdir(), 'project-atomic-windows-')));
  Object.assign(fixture, { target: '', refuse: 0, calls: 0, code: 'EPERM' });
  writeFileSync(join(fixture.root, 'bots.json'), JSON.stringify({ version: 1, current: bot.appId, bots: [bot] }));
  mkdirSync(join(fixture.root, 'bots', bot.appId), { recursive: true });
  writeFileSync(join(fixture.root, 'bots', bot.appId, 'config.json'), JSON.stringify({ version: 1, accounts: { app: { id: bot.appId, tenant: bot.tenant, secret: { source: 'exec', id: 'offline-secret' } } } }));
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(fixture.root, { recursive: true, force: true });
});

it.each(['EPERM', 'EACCES', 'EBUSY'])('keeps every concurrent group and one DM after transient %s readers', async code => {
  const file = join(fixture.root, 'bots', bot.appId, 'projects.json');
  writeFileSync(file, JSON.stringify({ version: 1, projects: [group('existing')] }));
  Object.assign(fixture, { target: file, refuse: 3, code });
  const result = await Promise.all([
    ...Array.from({ length: 4 }, () => prepareDmProjectForBot(bot)),
    ...Array.from({ length: 4 }, (_, index) => addProject(group(`new_${index}`), { file, dataRoot: fixture.root })),
  ]);
  expect(result.slice(0, 4).every(Boolean)).toBe(true);
  const projects: Project[] = JSON.parse(readFileSync(file, 'utf8')).projects;
  expect(projects.filter(row => row.dm).map(row => row.chatId)).toEqual([dmChatId(bot.appId)]);
  expect(projects.filter(row => !row.dm).map(row => row.name).sort()).toEqual(['existing', 'new_0', 'new_1', 'new_2', 'new_3']);
  expect(fixture.calls).toBe(8);
  expect(readdirSync(join(fixture.root, 'bots', bot.appId)).filter(name => name.includes('.tmp-'))).toEqual([]);
});

it.each(['projects.json', 'bots.json'])('preserves %s bytes and cleans temporary files after permanent reader refusal', async name => {
  const file = join(fixture.root, name);
  if (name === 'projects.json') writeFileSync(file, JSON.stringify({ version: 1, projects: [group('existing')] }));
  const original = readFileSync(file, 'utf8');
  Object.assign(fixture, { target: file, refuse: 100 });
  await expect(name === 'projects.json' ? addProject(group('new')) : ensureRegistry()).rejects.toMatchObject({ code: 'EPERM' });
  expect(fixture.calls).toBe(9);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(fixture.root).filter(entry => entry.startsWith(`${basename(file)}.tmp-`))).toEqual([]);
});

it('rechecks authorization after waiting and never retries an authorization rejection', async () => {
  const file = join(fixture.root, 'projects.json');
  const original = JSON.stringify({ version: 1, projects: [group('existing')] });
  writeFileSync(file, original);
  Object.assign(fixture, { target: file, refuse: 1 });
  const denied = Object.assign(new Error('authorization expired'), { code: 'EPERM' });
  const beforeCommit = vi.fn(() => { if (fixture.calls > 0) throw denied; });
  await expect(updateProject('existing', { noMention: true }, { beforeCommit })).rejects.toBe(denied);
  expect(beforeCommit).toHaveBeenCalledTimes(2);
  expect(fixture.calls).toBe(1);
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(fixture.root).filter(name => name.includes('.tmp-'))).toEqual([]);
});

it('publishes the Bot registry after a transient reader releases it', async () => {
  Object.assign(fixture, { target: join(fixture.root, 'bots.json'), refuse: 2 });
  const saved = await ensureRegistry();
  expect(saved.bots[0]?.badgeNumber).toBeTruthy();
  expect(JSON.parse(readFileSync(fixture.target, 'utf8')).bots).toEqual(saved.bots);
  expect(fixture.calls).toBe(3);
  expect(readdirSync(fixture.root).filter(name => name.includes('.tmp-'))).toEqual([]);
});
