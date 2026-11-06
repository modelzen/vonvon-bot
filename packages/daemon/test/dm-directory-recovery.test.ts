import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async () => {
  const { join } = await import('node:path');
  const botDir = (appId: string) => join(fixture.root, 'bots', appId);
  return { botDir, botPaths: (appId: string) => ({ dir: botDir(appId), configFile: join(botDir(appId), 'config.json') }), paths: {
    get appDir() { return fixture.root; },
    get botsFile() { return join(fixture.root, 'bots.json'); },
    get projectsRootDir() { return join(fixture.root, 'projects'); },
  } };
});

import { botIdentity, ensureBotDmDirectory, loadBots, repairBotDirectories, withBotGroupBinding, type BotEntry, type BotsRegistry } from '../src/config/bots';
import { directoryIdentity, verifyDirectory } from '../src/config/bot-namespace';

const first: BotEntry = { name: 'first', appId: 'cli_first', tenant: 'feishu', createdAt: 1 };
const second: BotEntry = { name: 'second', appId: 'cli_second', tenant: 'feishu', createdAt: 2 };
let outside: string;
const projects = () => join(fixture.root, 'projects');
const file = () => join(fixture.root, 'bots.json');
const contents = () => readFileSync(file(), 'utf8');
const save = (value: BotsRegistry) => writeFileSync(file(), JSON.stringify(value));
const read = (): BotsRegistry => JSON.parse(contents());
const dm = (bot = first, parent = projects()) => ensureBotDmDirectory(botIdentity(bot), parent);
const group = (bot = first, chatId = 'oc_first', parent = projects()) => withBotGroupBinding(botIdentity(bot),
  { chatId, name: chatId, projectsRootDir: parent }, scope => scope.prepareDefault());

function changeRecordedDevice() {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.dev === 'string' && typeof record.ino === 'string') record.dev = (BigInt(record.dev) + 1n).toString();
    for (const child of Object.values(record)) visit(child);
  };
  const value = read(); visit(value); save(value);
}

beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-directory-recovery-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'dm-directory-external-')));
  save({ version: 1, current: first.appId, bots: [first, second] });
});
afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('DM initialization after restoring managed directories', () => {
  it.each(['unallocated', 'restored'] as const)('leaves an import-reserved Bot %s until bridge import finishes', async state => {
    if (state === 'restored') { await group(); changeRecordedDevice(); }
    const journalDir = join(fixture.root, 'import', 'bridge');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(join(journalDir, 'journal.json'), JSON.stringify({
      version: 1, txId: '3e155b08-6fca-49a0-8a00-ef532db6d905', hostPid: 123, startedAt: 1,
      bridgeDir: join(fixture.root, 'old'), plistFile: join(fixture.root, 'old.plist'), uid: 501,
      reservedAppIds: [first.appId], acquiredLocks: [],
      before: { plist: { present: false }, serviceLoaded: false, holders: [{ appId: first.appId, pid: null, startedAt: null }] },
      stageDir: join(journalDir, '3e155b08-6fca-49a0-8a00-ef532db6d905'), stageIdentity: null,
      intents: [], step: 'moving', cleanupPending: true, outcome: null,
    }));
    const before = contents();
    await expect(dm()).rejects.toThrow('正在从 bridge 导入');
    expect(contents()).toBe(before);
    expect(existsSync(join(projects(), first.name, 'dm'))).toBe(false);
    if (state === 'unallocated') expect(existsSync(projects())).toBe(false);
  });

  it('recovers changed mount numbers for the complete Bot and group ledger', async () => {
    const existing = await group();
    writeFileSync(join(existing.cwd, 'user.txt'), 'keep me');
    changeRecordedDevice();
    // Creating ordinary groups retains the explicit repair requirement.
    await expect(group(first, 'oc_before')).rejects.toThrow();
    expect(await dm()).toBe(join(projects(), first.name, 'dm'));
    const registry = await loadBots();
    const allocation = registry.allocations![first.appId]!;
    expect(allocation.parentIdentity).toEqual(await directoryIdentity(projects()));
    for (const record of [allocation, registry.groupContainers![first.appId]!, ...Object.values(registry.groupAllocations!)]) {
      expect(record.state).toBe('ready');
      if (record.state === 'ready') await expect(verifyDirectory(record, fixture.root)).resolves.toBeUndefined();
    }
    expect(readFileSync(join(existing.cwd, 'user.txt'), 'utf8')).toBe('keep me');
    await expect(group(first, 'oc_after')).resolves.toMatchObject({ blank: true });
  });

  it('recovers copied-back directories after device and inode changes without moving their contents', async () => {
    const existing = await group();
    writeFileSync(join(existing.cwd, 'note.txt'), 'existing work');
    const before = read();
    const moved = join(outside, 'previous-projects');
    renameSync(projects(), moved);
    cpSync(moved, projects(), { recursive: true });
    expect(await directoryIdentity(projects())).not.toEqual(before.allocations![first.appId]!.parentIdentity);
    // The copy really changes inodes; stale device numbers model restoring onto a different data volume too.
    changeRecordedDevice();
    await dm();
    expect(readFileSync(join(existing.cwd, 'note.txt'), 'utf8')).toBe('existing work');
    const allocation = read().allocations![first.appId]!;
    expect(allocation.namespaceRoot).toBe(before.allocations![first.appId]!.namespaceRoot);
    expect(allocation.parentIdentity).toEqual(await directoryIdentity(projects()));
  });

  it('recovers all Bots sharing the root independently and is idempotent', async () => {
    await group(); await group(second, 'oc_second');
    changeRecordedDevice();
    await Promise.all([dm(), dm(second)]);
    const after = read();
    for (const bot of [first, second]) {
      expect(after.allocations![bot.appId]!.parentIdentity).toEqual(await directoryIdentity(projects()));
      expect(existsSync(join(projects(), bot.name, 'dm'))).toBe(true);
    }
    await dm(); await dm(second);
    expect(read()).toEqual(after);
  });

  it('keeps custom roots strict until the explicit repair command runs', async () => {
    await group(first, 'oc_external', outside);
    changeRecordedDevice();
    const before = contents();
    await expect(dm(first, outside)).rejects.toThrow();
    expect(contents()).toBe(before);
    await repairBotDirectories(first.name);
    await expect(dm(first, outside)).resolves.toBe(join(outside, first.name, 'dm'));
  });

  it('rejects a linked projects root without publishing any repair', async () => {
    await group();
    const moved = join(outside, 'linked-projects');
    renameSync(projects(), moved);
    symlinkSync(moved, projects(), 'dir');
    const before = contents();
    await expect(dm()).rejects.toThrow();
    expect(contents()).toBe(before);
  });

  it('rejects a linked Bot directory without publishing any repair', async () => {
    await group(); changeRecordedDevice();
    const bot = read().allocations![first.appId]!.namespaceRoot;
    const moved = join(outside, 'linked-bot');
    renameSync(bot, moved); symlinkSync(moved, bot, 'dir');
    const before = contents();
    await expect(dm()).rejects.toThrow();
    expect(contents()).toBe(before);
  });

  it('rejects a linked descendant after checking the parent without a partial publish', async () => {
    const existing = await group(); changeRecordedDevice();
    const moved = join(outside, 'linked-group');
    renameSync(existing.cwd, moved); symlinkSync(moved, existing.cwd, 'dir');
    const before = contents();
    await expect(dm()).rejects.toThrow();
    expect(contents()).toBe(before);
    expect(existsSync(join(projects(), first.name, 'dm'))).toBe(false);
  });

  it('rejects an existing DM leaf link without touching its target or repairing the ledger', async () => {
    await group(); changeRecordedDevice();
    writeFileSync(join(outside, 'keep.txt'), 'outside content');
    symlinkSync(outside, join(projects(), first.name, 'dm'), 'dir');
    const before = contents();
    await expect(dm()).rejects.toThrow('目录被换成了文件或链接');
    expect(contents()).toBe(before);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('outside content');
  });

  it('rejects a dangling DM leaf link without creating the external target', async () => {
    await group();
    const target = join(outside, 'must-not-be-created');
    symlinkSync(target, join(projects(), first.name, 'dm'), 'dir');
    await expect(dm()).rejects.toThrow('目录被换成了文件或链接');
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a file in place of the DM directory and preserves its bytes', async () => {
    await group();
    const leaf = join(projects(), first.name, 'dm');
    writeFileSync(leaf, 'keep file');
    await expect(dm()).rejects.toThrow('目录被换成了文件或链接');
    expect(readFileSync(leaf, 'utf8')).toBe('keep file');
  });

  it('does not adopt an occupied reserved descendant', async () => {
    await group(); changeRecordedDevice();
    const value = read();
    const [key, claim] = Object.entries(value.groupAllocations!)[0]!;
    const { object: _object, ...reserved } = claim as typeof claim & { object?: unknown };
    value.groupAllocations![key] = { ...reserved, state: 'reserved' };
    save(value);
    const before = contents();
    await expect(dm()).rejects.toThrow();
    expect(contents()).toBe(before);
  });

  it('does not adopt an occupied reserved Bot allocation', async () => {
    await dm();
    const value = read();
    const claim = value.allocations![first.appId]!;
    const { object: _object, ...reserved } = claim as typeof claim & { object?: unknown };
    value.allocations![first.appId] = { ...reserved, state: 'reserved' };
    save(value); changeRecordedDevice();
    const before = contents();
    await expect(dm()).rejects.toThrow();
    expect(contents()).toBe(before);
  });

  it('keeps ordinary missing-directory recreation working', async () => {
    await group();
    renameSync(join(projects(), first.name), join(outside, 'old-bot'));
    await expect(dm()).resolves.toBe(join(projects(), first.name, 'dm'));
    expect(existsSync(join(projects(), first.name, 'dm'))).toBe(true);
  });
});
