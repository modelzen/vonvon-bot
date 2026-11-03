import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryItem, MemorySource } from '@vonvon/protocol';
import { libraryLocation } from '../src/project/library';
import {
  ARCHIVED_MAX, botMemoryLocation, MemoryCorruptError, MemoryStore, PURGED_TEXT, projectMemoryLocation, similarMemoryText, transferItem,
  type ImportEntry, type ItemResult, type MemoryStoreOptions,
} from '../src/bot/memory-store';

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-store-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PROJECT = 'prj_0a1b2c3d';
const OWNER = { openId: 'ou_owner', role: 'owner' } as const;
const DESKTOP = { role: 'desktop' } as const;
const human: MemorySource = { via: 'ui', botId: '', actorRole: 'owner', actorOpenId: 'ou_owner' };
const botSource = (extra: Partial<MemorySource> = {}): MemorySource => ({ via: 'tool', botId: 'cli_a', actorRole: 'bot', chatId: 'oc_a', ...extra });

/** The store of a project in a fresh data root; `data` is where its files are. */
function project(options: MemoryStoreOptions & { limit?: number; data?: string } = {}): { store: MemoryStore; data: string; dir: string; again: (more?: MemoryStoreOptions) => MemoryStore } {
  const data = options.data ?? root();
  const { limit, data: _data, ...store } = options;
  const location = projectMemoryLocation(PROJECT, { library: libraryLocation(data), ...(limit ? { limit } : {}) });
  return { store: new MemoryStore(location, store), data, dir: location.dir, again: more => new MemoryStore(location, more) };
}
const names = (view: { branches: { name: string }[] }): string[] => view.branches.map(branch => branch.name);
const must = <T extends ItemResult>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result as Extract<T, { ok: true }>;
};
const mustItem = (result: Awaited<ReturnType<MemoryStore['undo']>>) => {
  if (!result.ok || !('item' in result)) throw new Error(`expected an item, got ${JSON.stringify(result)}`);
  return result;
};
const addHuman = (store: MemoryStore, text: string, branch?: string) => store.add({ text, ...(branch === undefined ? {} : { branch }), source: human, trust: 'trusted', actor: DESKTOP });
const byId = (items: MemoryItem[]): MemoryItem[] => [...items].sort((a, b) => a.id.localeCompare(b.id));
let clock = 1_000_000;
const tick = (): number => (clock += 1000);

describe('a new store', () => {
  it('has every fixed branch without a single file written', async () => {
    const { store, dir } = project();
    const view = await store.read();
    expect(names(view)).toEqual(['决定', '约定', '人和分工', '环境和资源', '背景', '其他']);
    expect(view).toMatchObject({ items: [], used: 0, limit: 100, verified: true, problems: [] });
    expect(existsSync(dir)).toBe(false);
    const bot = new MemoryStore(botMemoryLocation(join(root(), 'bots', 'cli_a')));
    expect(names(await bot.read())).toEqual(['关于你', '合作方式', '团队和人', '其他']);
    expect((await bot.read()).limit).toBe(50);
  });

  it('writes the data files with owner-only permissions', async () => {
    const { store, dir } = project();
    must(await addHuman(store, '周四发版', '决定'));
    const files = ['events.jsonl', 'integrity.json', 'memory.json'];
    expect(readdirSync(dir).sort()).toEqual(process.platform === 'darwin' ? ['.locks', ...files] : files);
    for (const name of files) expect(statMode(join(dir, name))).toBe(0o600);
    // macOS keeps its kernel-lock file after release; Linux uses an abstract socket.
    if (process.platform === 'darwin') {
      expect(statMode(join(dir, '.locks'))).toBe(0o700);
      expect(readdirSync(join(dir, '.locks'))).toEqual(['memory.lock']);
      expect(statMode(join(dir, '.locks', 'memory.lock'))).toBe(0o600);
    }
  });
});
const statMode = (path: string): number => statSync(path).mode & 0o777;

describe('branches while writing', () => {
  it('treats " 发版 " and "发版" as one branch, opened once', async () => {
    const { store } = project();
    const first = must(await addHuman(store, '发版前先在测试群回归', ' 发版 '));
    expect(first).toMatchObject({ branchApplied: '发版', newBranch: true });
    const second = must(await addHuman(store, '发版后在群里报一声', '发版'));
    expect(second.branchApplied).toBe('发版');
    expect(second.newBranch).toBeUndefined();
    const view = await store.read();
    expect(names(view).filter(name => name === '发版')).toHaveLength(1);
    expect(view.items.every(item => item.branch === '发版')).toBe(true);
  });

  it('puts the 13th branch in 其他', async () => {
    const { store } = project();
    // 6 fixed + 6 opened = 12
    for (let index = 0; index < 6; index++) must(await addHuman(store, `条目 ${index}`, `分支${index}`));
    expect(names(await store.read())).toHaveLength(12);
    const thirteenth = must(await addHuman(store, '放不下的', '第十三支'));
    expect(thirteenth.branchApplied).toBe('其他');
    expect(thirteenth.newBranch).toBeUndefined();
    expect(names(await store.read())).not.toContain('第十三支');
  });

  it('removes an opened branch when its last active entry leaves, and reopens it when the entry is restored', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '支付网关换了', '支付网关'));
    expect(names(await store.read())).toContain('支付网关');
    const archived = must(await store.archive({ itemId: added.item.id, revision: 1, actor: DESKTOP }));
    expect(names(await store.read())).not.toContain('支付网关');
    // the archived entry keeps its branch name
    expect((await store.get(added.item.id))?.branch).toBe('支付网关');
    const restored = must(await store.restore({ itemId: added.item.id, revision: archived.item.revision, actor: DESKTOP }));
    expect(restored).toMatchObject({ branchApplied: '支付网关', newBranch: true });
    expect(names(await store.read())).toContain('支付网关');
  });

  it('judges the branch again on restore: a full table sends it to 其他', async () => {
    const { store } = project();
    const first = must(await addHuman(store, '会被归档', '临时'));
    must(await store.archive({ itemId: first.item.id, revision: 1, actor: DESKTOP }));
    for (let index = 0; index < 6; index++) must(await addHuman(store, `占位 ${index}`, `占${index}`));
    const restored = must(await store.restore({ itemId: first.item.id, revision: 2, actor: DESKTOP }));
    expect(restored.branchApplied).toBe('其他');
  });

  it('moves an entry between branches with edit, opening one when needed', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    expect(added.branchApplied).toBe('其他');
    const moved = must(await store.edit({ itemId: added.item.id, revision: 1, branch: '发版', actor: DESKTOP }));
    expect(moved).toMatchObject({ branchApplied: '发版', newBranch: true, item: { revision: 2, text: '周四发版' } });
    const events = await store.events(added.item.id);
    expect(events.map(event => event.kind)).toEqual(['add', 'edit']);
    expect(events[1]).toMatchObject({ newBranch: true, before: { branch: '其他' }, after: { branch: '发版' } });
  });
});

describe('renaming and merging branches', () => {
  async function withBranches() {
    const made = project();
    const a = must(await addHuman(made.store, '甲一', '甲'));
    const b = must(await addHuman(made.store, '甲二', '甲'));
    const c = must(await addHuman(made.store, '乙一', '乙'));
    return { ...made, a, b, c };
  }

  it('refuses to rename or merge away a fixed branch', async () => {
    const { store } = await withBranches();
    expect(await store.branchRename({ from: '决定', to: '决策', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'fixed-branch' });
    expect(await store.branchRename({ from: '其他', to: '杂项', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'fixed-branch' });
    expect(await store.branchMerge({ from: '决定', into: '甲', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'fixed-branch' });
    expect(names(await store.read())).toContain('决定');
    // another branch may be merged into a fixed one
    expect(await store.branchMerge({ from: '乙', into: '决定', actor: DESKTOP })).toMatchObject({ ok: true, moved: 1 });
  });

  it('reports conflict when the new name is taken, also by a fixed branch', async () => {
    const { store } = await withBranches();
    expect(await store.branchRename({ from: '甲', to: '乙', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await store.branchRename({ from: '甲', to: ' 决定 ', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await store.branchRename({ from: '没有', to: '丙', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'no-such-branch' });
  });

  it('renames a branch with everything in it, archived entries too', async () => {
    const { store, a } = await withBranches();
    must(await store.archive({ itemId: a.item.id, revision: 1, actor: DESKTOP }));
    const renamed = await store.branchRename({ from: '甲', to: '  新甲 ', actor: DESKTOP });
    expect(renamed).toMatchObject({ ok: true, moved: 2 });
    const view = await store.read();
    expect(names(view)).toContain('新甲');
    expect(names(view)).not.toContain('甲');
    expect(view.items.filter(item => item.branch === '新甲')).toHaveLength(2);
    // case-only change of its own name is not a conflict
    expect(await store.branchRename({ from: '新甲', to: '新甲', actor: DESKTOP })).toMatchObject({ ok: true, moved: 0 });
  });

  it('undoes a merge as one batch', async () => {
    const { store, a, b, c } = await withBranches();
    const merged = await store.branchMerge({ from: '甲', into: '乙', actor: DESKTOP });
    expect(merged).toMatchObject({ ok: true, moved: 2 });
    let view = await store.read();
    expect(names(view)).not.toContain('甲');
    expect(view.items.filter(item => item.branch === '乙')).toHaveLength(3);
    const eventId = view.lastEventId!;
    const undone = await store.undo({ eventId, actor: DESKTOP });
    expect(undone).toMatchObject({ ok: true, moved: 2 });
    view = await store.read();
    expect(names(view)).toContain('甲');
    expect(view.items.find(item => item.id === a.item.id)?.branch).toBe('甲');
    expect(view.items.find(item => item.id === b.item.id)?.branch).toBe('甲');
    expect(view.items.find(item => item.id === c.item.id)?.branch).toBe('乙');
  });

  it('refuses to undo a merge when one of its entries changed since, or its old name is taken', async () => {
    const { store, a } = await withBranches();
    await store.branchMerge({ from: '甲', into: '乙', actor: DESKTOP });
    const eventId = (await store.read()).lastEventId!;
    const current = (await store.get(a.item.id))!;
    must(await store.edit({ itemId: a.item.id, revision: current.revision, text: '甲一改过', actor: DESKTOP }));
    expect(await store.undo({ eventId, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(names(await store.read())).not.toContain('甲');
    // the old name taken by a new branch
    const second = project();
    await addHuman(second.store, '一', '丙');
    await addHuman(second.store, '二', '丁');
    await second.store.branchMerge({ from: '丙', into: '丁', actor: DESKTOP });
    const merge = (await second.store.read()).lastEventId!;
    await addHuman(second.store, '三', '丙');
    expect(await second.store.undo({ eventId: merge, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('undoes a rename', async () => {
    const { store } = await withBranches();
    await store.branchRename({ from: '甲', to: '丙', actor: DESKTOP });
    const eventId = (await store.read()).lastEventId!;
    expect(await store.undo({ eventId, actor: DESKTOP })).toMatchObject({ ok: true, moved: 2 });
    const view = await store.read();
    expect(names(view)).toContain('甲');
    expect(names(view)).not.toContain('丙');
  });

  it('replays the same state when the process is killed after the merge event and before the snapshot', async () => {
    const { store, dir, again } = await withBranches();
    const killed = again({ afterEvents: () => { throw new Error('killed'); } });
    await expect(killed.branchMerge({ from: '甲', into: '乙', actor: DESKTOP })).rejects.toThrow('killed');
    const fresh = again();
    const view = await fresh.read();
    expect(names(view)).not.toContain('甲');
    expect(view.items.filter(item => item.branch === '乙')).toHaveLength(3);
    expect(view.verified).toBe(true);
    // memory.json still says the old state; the next write brings it up to date, without applying anything twice
    expect(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).items.filter((item: MemoryItem) => item.branch === '甲')).toHaveLength(2);
    must(await addHuman(fresh, '丙一'));
    const after = await again().read();
    expect(after.items.find(item => item.text === '乙一')?.revision).toBe(1);
    expect(after.items.find(item => item.text === '甲二')?.revision).toBe(2);
    expect(after.items.find(item => item.text === '甲一')?.revision).toBe(2);
    expect(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).lastEventId).toBe(after.lastEventId);
  });
});

// C5: the web page's 删除分支 as one request (memory.branchDelete)
describe('deleting a branch', () => {
  async function withBranch() {
    const made = project();
    const a = must(await addHuman(made.store, '甲一', '甲'));
    const b = must(await addHuman(made.store, '甲二', '甲'));
    const c = must(await addHuman(made.store, '甲三', '甲'));
    must(await made.store.archive({ itemId: c.item.id, revision: 1, actor: DESKTOP }));
    const other = must(await addHuman(made.store, '乙一', '乙'));
    return { ...made, a, b, c, other };
  }
  const eventsOf = (dir: string) => readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; itemId?: string; eventId: string; actor: { role: string } });

  // main 必败: there was no branchDelete
  it("archives the branch's active entries in one go, an archive event each, and the empty branch goes", async () => {
    const { store, dir, a, b, c, other } = await withBranch();
    const before = eventsOf(dir).length;
    expect(await store.branchDelete({ name: ' 甲 ', expected: 2, actor: { role: 'cli' } })).toMatchObject({ ok: true, moved: 2 });
    const view = await store.read();
    expect(names(view)).not.toContain('甲');
    expect(names(view)).toContain('乙');
    expect(view.items.filter(item => item.branch === '甲').map(item => [item.id, item.state, item.revision])).toEqual(expect.arrayContaining([
      [a.item.id, 'archived', 2], [b.item.id, 'archived', 2], [c.item.id, 'archived', 2],
    ]));
    expect(view.items.find(item => item.id === other.item.id)?.state).toBe('active');
    const added = eventsOf(dir).slice(before);
    expect(added.map(event => [event.kind, event.itemId, event.actor.role])).toEqual([['archive', a.item.id, 'cli'], ['archive', b.item.id, 'cli']]);
  });

  it('changes nothing when the count the caller saw is not the count now, and refuses a fixed or a missing branch', async () => {
    const { store, dir } = await withBranch();
    const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(await store.branchDelete({ name: '甲', expected: 3, actor: DESKTOP })).toEqual({ ok: false, reason: 'conflict', message: '分支里的条目刚变过，重新看一次再删' });
    expect(await store.branchDelete({ name: '决定', actor: DESKTOP })).toEqual({ ok: false, reason: 'fixed-branch', message: '固定分支不能删' });
    expect(await store.branchDelete({ name: '其他', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'fixed-branch' });
    expect(await store.branchDelete({ name: '没有', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'no-such-branch' });
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe(before);
    expect(names(await store.read())).toContain('甲');
  });

  it('is undone one entry at a time, which brings the branch back', async () => {
    const { store, dir, a, b } = await withBranch();
    expect(await store.branchDelete({ name: '甲', actor: DESKTOP })).toMatchObject({ ok: true, moved: 2 });
    const archiveOfA = eventsOf(dir).filter(event => event.kind === 'archive' && event.itemId === a.item.id).at(-1)!;
    mustItem(await store.undo({ eventId: archiveOfA.eventId, actor: DESKTOP }));
    const view = await store.read();
    expect(names(view)).toContain('甲');
    expect(view.items.find(item => item.id === a.item.id)).toMatchObject({ state: 'active', branch: '甲' });
    expect(view.items.find(item => item.id === b.item.id)?.state).toBe('archived');
  });

  it('trims the oldest archived entries past the cap as archiving them one by one does', async () => {
    const results: string[][] = [];
    for (const oneByOne of [false, true]) {
      const { store } = project();
      const old: ImportEntry[] = Array.from({ length: ARCHIVED_MAX - 1 }, (_, at) => ({ text: `旧${at}`, branch: '背景', source: human, trust: 'trusted', archived: true }));
      await store.importItems(old, DESKTOP);
      const items = [must(await addHuman(store, '甲一', '甲')), must(await addHuman(store, '甲二', '甲')), must(await addHuman(store, '甲三', '甲'))];
      if (oneByOne) for (const { item } of items) must(await store.archive({ itemId: item.id, revision: 1, actor: DESKTOP }));
      else expect(await store.branchDelete({ name: '甲', actor: DESKTOP })).toMatchObject({ ok: true, moved: 3 });
      const view = await store.read();
      expect(view.items).toHaveLength(ARCHIVED_MAX);
      results.push(view.items.map(item => item.text).sort());
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).not.toContain('旧0');
    expect(results[0]).toContain('甲一');
  });
});

describe('the event log and the snapshot', () => {
  it('replays to the same state after a kill between the events and the snapshot', async () => {
    const { store, again } = project();
    must(await addHuman(store, '一', '决定'));
    must(await addHuman(store, '二', '约定'));
    const killed = again({ afterEvents: () => { throw new Error('killed'); } });
    await expect(killed.add({ text: '三', branch: '新开的', source: human, trust: 'trusted', actor: DESKTOP })).rejects.toThrow('killed');
    const view = await again().read();
    expect(view.items.map(item => item.text).sort()).toEqual(['一', '三', '二']);
    expect(names(view)).toContain('新开的');
    expect(view.verified).toBe(true);
    // a write after the kill heals the snapshot; reading again gives the same, and nothing is applied twice
    const healed = must(await again().add({ text: '四', source: human, trust: 'trusted', actor: DESKTOP }));
    const reread = await again().read();
    expect(byId(reread.items).map(item => item.text)).toEqual(byId([...view.items, healed.item]).map(item => item.text));
    expect(reread.items).toHaveLength(4);
    expect((await again().events()).map(event => event.kind)).toEqual(['add', 'add', 'add', 'add']);
  });

  it('replays a store whose first write was killed before any snapshot existed', async () => {
    const { again, dir } = project();
    const killed = again({ afterEvents: () => { throw new Error('killed'); } });
    await expect(killed.add({ text: '第一条', source: human, trust: 'trusted', actor: DESKTOP })).rejects.toThrow('killed');
    expect(existsSync(join(dir, 'memory.json'))).toBe(false);
    const view = await again().read();
    expect(view.items.map(item => item.text)).toEqual(['第一条']);
    expect(view.verified).toBe(true);
  });

  it('accepts a snapshot whose integrity record was written and whose rename was killed', async () => {
    const { store, again } = project();
    must(await addHuman(store, '一'));
    const killed = again({ beforeSnapshotRename: () => { throw new Error('killed'); } });
    await expect(killed.add({ text: '二', source: human, trust: 'trusted', actor: DESKTOP })).rejects.toThrow('killed');
    const view = await again().read();
    expect(view.items).toHaveLength(2);
    expect(view.verified).toBe(true);
    // and the stray temporary file of the dead write does not stop the next one
    must(await addHuman(again(), '三'));
    expect((await again().read()).items).toHaveLength(3);
  });

  it('drops a last line a kill cut off, and writes on after it', async () => {
    const { store, dir, again } = project();
    must(await addHuman(store, '一'));
    writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + '{"eventId":"p_x:e_cut","at":1,"kind":"ad');
    expect((await again().read()).items).toHaveLength(1);
    must(await addHuman(again(), '二'));
    const events = (await again().events());
    expect(events).toHaveLength(2);
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });

  it('refuses a log with a bad line in the middle, and a snapshot that names a missing event', async () => {
    const { store, dir, again } = project();
    must(await addHuman(store, '一'));
    must(await addHuman(store, '二'));
    const log = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n');
    writeFileSync(join(dir, 'events.jsonl'), `garbage\n${log.slice(1).join('\n')}`);
    await expect(again().read()).rejects.toBeInstanceOf(MemoryCorruptError);
    writeFileSync(join(dir, 'events.jsonl'), '');
    await expect(again().read()).rejects.toBeInstanceOf(MemoryCorruptError);
  });

  it('refuses a symlink and a hard-linked file', async () => {
    const { store, dir, again } = project();
    must(await addHuman(store, '一'));
    const { symlinkSync, linkSync, renameSync } = await import('node:fs');
    renameSync(join(dir, 'memory.json'), join(dir, 'real.json'));
    symlinkSync(join(dir, 'real.json'), join(dir, 'memory.json'));
    await expect(again().read()).rejects.toThrow();
    rmSync(join(dir, 'memory.json'));
    renameSync(join(dir, 'real.json'), join(dir, 'memory.json'));
    linkSync(join(dir, 'memory.json'), join(dir, 'twin.json'));
    await expect(again().read()).rejects.toBeInstanceOf(MemoryCorruptError);
  });
});

describe('integrity', () => {
  it('flags a memory.json that was edited outside the daemon', async () => {
    const { store, dir, again } = project();
    const added = must(await store.add({ text: '待确认的', source: botSource(), trust: 'untrusted', actor: { role: 'bot' } }));
    expect((await store.read()).verified).toBe(true);
    const snapshot = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    snapshot.items[0].trust = 'trusted';
    writeFileSync(join(dir, 'memory.json'), JSON.stringify(snapshot));
    const view = await again().read();
    expect(view.verified).toBe(false);
    expect(view.problems.join()).toContain('外部改过');
    // the owner accepts the file as it is, which seals it again
    await again().reseal();
    expect((await again().read()).verified).toBe(true);
    expect((await again().get(added.item.id))?.trust).toBe('trusted');
  });

  it('flags a snapshot with no integrity record, and ignores entries that belong to another memory', async () => {
    const { store, dir, again } = project();
    must(await addHuman(store, '一'));
    rmSync(join(dir, 'integrity.json'));
    expect((await again().read()).verified).toBe(false);
    await again().reseal();
    const snapshot = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    snapshot.items.push({ ...snapshot.items[0], id: `p_${PROJECT}:zzzzzz`, scope: { kind: 'project', projectId: 'prj_ffffffff' } });
    writeFileSync(join(dir, 'memory.json'), JSON.stringify(snapshot));
    const view = await again().read();
    expect(view.items).toHaveLength(1);
    expect(view.problems.join()).toContain('不属于这份记忆');
  });
});

describe('the limit', () => {
  it('refuses the 101st entry and offers the five least recently used bot-written ones', async () => {
    const { store } = project({ now: tick });
    const botIds: string[] = [];
    for (let index = 0; index < 100; index++) {
      const bot = index % 10 === 0;
      const added = must(await store.add({
        text: `条目 ${index}`, source: bot ? botSource({ messageId: `om_${index}` }) : human,
        trust: bot ? 'untrusted' : 'trusted', actor: bot ? { role: 'bot' } : DESKTOP,
      }));
      if (bot) botIds.push(added.item.id);
    }
    expect((await store.read()).used).toBe(100);
    // the most recently used first entry goes to the end of the offer
    await store.recordUsage([botIds[0]!]);
    const refused = await store.add({ text: '第 101 条', source: human, trust: 'trusted', actor: DESKTOP });
    expect(refused).toMatchObject({ ok: false, reason: 'memory-full', usage: { used: 100, limit: 100 } });
    const candidates = !refused.ok && 'candidates' in refused ? refused.candidates ?? [] : [];
    expect(candidates).toHaveLength(5);
    expect(candidates.map(item => item.id)).toEqual(botIds.slice(1, 6));
    expect(candidates.every(item => item.source.actorRole === 'bot')).toBe(true);
    expect((await store.read()).used).toBe(100);
    // forgetting one makes room again
    must(await store.archive({ itemId: botIds[1]!, revision: 1, actor: DESKTOP, reason: 'make-room' }));
    must(await store.add({ text: '第 101 条', source: human, trust: 'trusted', actor: DESKTOP }));
    const events = await store.events(botIds[1]!);
    expect(events.at(-1)).toMatchObject({ kind: 'archive', reason: 'make-room' });
  }, 60_000);

  it('does not count archived entries, and refuses a restore into a full memory', async () => {
    const { store } = project({ limit: 2 });
    const a = must(await addHuman(store, '甲'));
    must(await addHuman(store, '乙'));
    must(await store.archive({ itemId: a.item.id, revision: 1, actor: DESKTOP }));
    must(await addHuman(store, '丙'));
    expect(await store.restore({ itemId: a.item.id, revision: 2, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'memory-full' });
  });

  it('uses the bot-memory limit of 50 by default', async () => {
    const bot = new MemoryStore({ ...botMemoryLocation(join(root(), 'bots', 'cli_a')), limit: 3 });
    for (let index = 0; index < 3; index++) must(await bot.add({ text: `项 ${index}`, source: human, trust: 'trusted', actor: DESKTOP }));
    expect(await bot.add({ text: '满了', source: human, trust: 'trusted', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'memory-full' });
  });

  it('physically removes the oldest archived entries beyond 500, scrubbing their text from the log', async () => {
    const { store, dir } = project({ now: tick });
    const entries: ImportEntry[] = Array.from({ length: ARCHIVED_MAX + 2 }, (_, index) => ({
      text: `旧的 ${index}`, branch: '背景', trust: 'untrusted', archived: true,
      source: { via: 'import', botId: 'cli_a', actorRole: 'import', importFile: 'f', importHash: `h${index}` },
    }));
    expect(await store.importItems(entries, { role: 'import' })).toMatchObject({ added: 502, archived: 502 });
    expect((await store.read()).items).toHaveLength(502);
    const fresh = must(await addHuman(store, '新的'));
    must(await store.archive({ itemId: fresh.item.id, revision: 1, actor: DESKTOP }));
    const view = await store.read();
    expect(view.items.filter(item => item.state === 'archived')).toHaveLength(ARCHIVED_MAX);
    expect(view.items.some(item => item.text === '旧的 0')).toBe(false);
    expect(view.items.some(item => item.text === '旧的 3')).toBe(true);
    const log = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(log).not.toContain('旧的 0"');
    expect(log).toContain(PURGED_TEXT);
    expect((await store.events()).filter(event => event.kind === 'purge' && event.reason === 'cap')).toHaveLength(3);
  }, 60_000);
});

describe('what may be written', () => {
  it('refuses a key-shaped text without writing memory data, and lets a path through', async () => {
    const { store, dir } = project();
    for (const text of ['token 是 sk-proj-AbCd1234EfGh5678IjKl9012MnOp', 'ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6']) {
      expect(await addHuman(store, text)).toMatchObject({ ok: false, reason: 'looks-like-secret' });
    }
    expect(readdirSync(dir)).toEqual(process.platform === 'darwin' ? ['.locks'] : []);
    if (process.platform === 'darwin') expect(readFileSync(join(dir, '.locks', 'memory.lock'))).toHaveLength(0);
    expect((await store.read()).items).toEqual([]);
    expect(await store.events()).toEqual([]);
    must(await addHuman(store, '日志放在 /var/log/pay 下'));
    const added = must(await addHuman(store, '旧的'));
    expect(await store.edit({ itemId: added.item.id, revision: 1, text: 'key: AKIAIOSFODNN7EXAMPLE', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'looks-like-secret' });
  });

  it('refuses empty and over-long text, and an edit that changes nothing asked', async () => {
    const { store } = project();
    expect(await addHuman(store, '   ')).toMatchObject({ ok: false, reason: 'bad-args' });
    expect(await addHuman(store, '字'.repeat(501))).toMatchObject({ ok: false, reason: 'bad-args' });
    must(await addHuman(store, '字'.repeat(500)));
    const added = must(await addHuman(store, '另一条'));
    expect(await store.edit({ itemId: added.item.id, revision: 1, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'bad-args' });
  });

  it('refuses a second entry for the same message that says the same thing, and only that', async () => {
    const { store } = project();
    const bot = (text: string, messageId: string, via: 'tool' | 'hidden_block' = 'tool') =>
      store.add({ text, source: botSource({ messageId, via }), trust: 'untrusted', actor: { role: 'bot' } });
    const first = must(await bot('发版改到周四', 'om_1'));
    expect(await bot(' 发版改到周四。', 'om_1', 'hidden_block')).toMatchObject({ ok: false, reason: 'duplicate', itemId: first.item.id });
    expect(await bot('发版改到周四!', 'om_1')).toMatchObject({ ok: false, reason: 'duplicate' });
    must(await bot('发版改到周五之后再说', 'om_1'));
    must(await bot('发版改到周四', 'om_2'));
    // once the first is archived, the same words may be written again
    must(await store.archive({ itemId: first.item.id, revision: 1, actor: DESKTOP }));
    must(await bot('发版改到周四', 'om_1'));
    expect(similarMemoryText('发版改到周四', '发版 改到周四。')).toBe(true);
    expect(similarMemoryText('发版改到周四', '完全不同的话题')).toBe(false);
  });

  it('keeps an entry written by hand apart from an import with the same words', async () => {
    const { store } = project();
    must(await store.add({ text: '周四发版', source: botSource({ messageId: 'om_1', via: 'import' }), trust: 'untrusted', actor: { role: 'import' } }));
    must(await store.add({ text: '周四发版', source: botSource({ messageId: 'om_1' }), trust: 'untrusted', actor: { role: 'bot' } }));
  });
});

describe('changing entries', () => {
  it('conflicts on a stale revision and hands back the current entry', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    must(await store.edit({ itemId: added.item.id, revision: 1, text: '周五发版', actor: OWNER }));
    const stale = await store.edit({ itemId: added.item.id, revision: 1, text: '周六发版', actor: OWNER });
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', current: { text: '周五发版', revision: 2, lastEditedBy: { actorRole: 'owner' } } });
    expect(await store.archive({ itemId: added.item.id, revision: 1, actor: OWNER })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await store.edit({ itemId: 'p_x:nope', revision: 1, text: 'x', actor: OWNER })).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('withdraws the trust of a text a member changed, keeps it for the owner, and confirms on request', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    const byMember = must(await store.edit({ itemId: added.item.id, revision: 1, text: '周五发版', actor: { role: 'member', openId: 'ou_m' } }));
    expect(byMember.item.trust).toBe('untrusted');
    const confirmed = must(await store.confirm({ itemId: added.item.id, revision: 2, actor: DESKTOP }));
    expect(confirmed.item).toMatchObject({ trust: 'trusted', revision: 3 });
    const byOwner = must(await store.edit({ itemId: added.item.id, revision: 3, text: '周六发版', actor: OWNER }));
    expect(byOwner.item.trust).toBe('trusted');
  });

  it('does not edit an archived entry', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    must(await store.archive({ itemId: added.item.id, revision: 1, actor: DESKTOP }));
    expect(await store.edit({ itemId: added.item.id, revision: 2, text: 'x', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'archived' });
  });
});

describe('undo', () => {
  it('conflicts when the entry changed after the event, applies the inverse otherwise, and records it as a new event', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    const edited = must(await store.edit({ itemId: added.item.id, revision: 1, text: '周五发版', branch: '发版', actor: OWNER }));
    const [addEvent, editEvent] = await store.events(added.item.id);
    expect(await store.undo({ eventId: addEvent!.eventId, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict', current: { revision: 2 } });
    const undone = mustItem(await store.undo({ eventId: editEvent!.eventId, actor: DESKTOP }));
    expect(undone.item).toMatchObject({ text: '周四发版', branch: '其他', revision: 3 });
    expect(names(await store.read())).not.toContain('发版');
    const last = (await store.events(added.item.id)).at(-1)!;
    expect(last).toMatchObject({ kind: 'edit', reason: 'undo', undoOf: editEvent!.eventId, actor: { role: 'desktop' } });
    expect(edited.item.revision).toBe(2);
    // undoing the add (once nothing changed it since) archives the entry; undoing that restores it
    const current = (await store.get(added.item.id))!;
    must(await store.archive({ itemId: added.item.id, revision: current.revision, actor: DESKTOP }));
    const archiveEvent = (await store.events(added.item.id)).at(-1)!;
    const restored = await store.undo({ eventId: archiveEvent.eventId, actor: DESKTOP });
    expect(restored).toMatchObject({ ok: true, item: { state: 'active' } });
  });

  it('cannot undo a purge or an unknown event', async () => {
    const { store } = project();
    const added = must(await addHuman(store, '周四发版'));
    await store.purge({ itemId: added.item.id, actor: DESKTOP });
    const purge = (await store.events()).at(-1)!;
    expect(await store.undo({ eventId: purge.eventId, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'not-undoable' });
    expect(await store.undo({ eventId: 'nope', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('purge', () => {
  it('removes the entry and its text from every event, and keeps the log valid', async () => {
    const { store, dir, again } = project();
    const added = must(await store.add({ text: '张三的手机号放在抽屉里', source: botSource({ why: '主人说的', messageId: 'om_1' }), trust: 'untrusted', actor: { role: 'bot' } }));
    must(await store.edit({ itemId: added.item.id, revision: 1, text: '张三的手机号放在抽屉第二层', actor: OWNER }));
    const other = must(await addHuman(store, '别的条目'));
    expect(await store.purge({ itemId: added.item.id, actor: DESKTOP })).toEqual({ ok: true });
    const log = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(log).not.toContain('手机号');
    expect(log).not.toContain('主人说的');
    expect(log).toContain(PURGED_TEXT);
    expect(readFileSync(join(dir, 'memory.json'), 'utf8')).not.toContain('手机号');
    const view = await again().read();
    expect(view.items.map(item => item.id)).toEqual([other.item.id]);
    expect(view.verified).toBe(true);
    expect((await again().events()).at(-1)).toMatchObject({ kind: 'purge', itemId: added.item.id });
    expect(await store.purge({ itemId: added.item.id, actor: DESKTOP })).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

describe('usage', () => {
  it('keeps use counts in usage.json outside the revision, the events and the integrity record', async () => {
    const { store, dir } = project({ now: tick });
    const added = must(await addHuman(store, '周四发版'));
    const before = readFileSync(join(dir, 'integrity.json'), 'utf8');
    await store.recordUsage([added.item.id]);
    await store.recordUsage([added.item.id]);
    expect((await store.readUsage())[added.item.id]).toMatchObject({ useCount: 2 });
    expect(readFileSync(join(dir, 'integrity.json'), 'utf8')).toBe(before);
    expect((await store.get(added.item.id))?.revision).toBe(1);
    expect(await store.events()).toHaveLength(1);
    expect((await store.read()).verified).toBe(true);
  });
});

describe('moving between layers', () => {
  it('promotes a project entry into the bot memory and archives the source, then moves one back', async () => {
    const data = root();
    const projectStore = project({ data }).store;
    const bot = new MemoryStore(botMemoryLocation(join(data, 'bots', 'cli_a')));
    const added = must(await projectStore.add({ text: '给主人的东西都先写结论', branch: '约定', source: botSource({ messageId: 'om_9' }), trust: 'untrusted', actor: { role: 'bot' } }));
    const promoted = must(await transferItem({ from: projectStore, to: bot, itemId: added.item.id, revision: 1, via: 'promoted', branch: '合作方式', actor: DESKTOP }));
    expect(promoted.item).toMatchObject({
      scope: { kind: 'bot' }, branch: '合作方式', trust: 'trusted',
      source: { via: 'promoted', fromItemId: added.item.id, chatId: 'oc_a', messageId: 'om_9', actorRole: 'bot' },
    });
    expect((await projectStore.get(added.item.id))?.state).toBe('archived');
    expect((await bot.events()).map(event => event.kind)).toEqual(['promote']);
    // a name the bot memory does not have goes to 其他, and no branch is opened for it
    const back = must(await transferItem({ from: bot, to: projectStore, itemId: promoted.item.id, revision: 1, via: 'moved', actor: DESKTOP }));
    expect(back.item).toMatchObject({ scope: { kind: 'project', projectId: PROJECT }, branch: '其他', source: { via: 'moved' } });
    expect((await bot.get(promoted.item.id))?.state).toBe('archived');
  });

  it('writes nothing when the target is full or the source revision is stale', async () => {
    const data = root();
    const projectStore = project({ data }).store;
    const bot = new MemoryStore({ ...botMemoryLocation(join(data, 'bots', 'cli_a')), limit: 1 });
    must(await addHuman(bot, '占着'));
    const added = must(await addHuman(projectStore, '要移走的'));
    expect(await transferItem({ from: projectStore, to: bot, itemId: added.item.id, revision: 1, via: 'promoted', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'memory-full' });
    expect((await projectStore.get(added.item.id))?.state).toBe('active');
    expect(await transferItem({ from: projectStore, to: bot, itemId: added.item.id, revision: 9, via: 'promoted', actor: DESKTOP })).toMatchObject({ ok: false, reason: 'conflict' });
  });
});

describe('export', () => {
  it('gives one markdown document per branch with entries, without ids or sources', async () => {
    const { store } = project();
    await store.add({ text: '周四发版', branch: '决定', source: { via: 'tool', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_secret', chatId: 'oc_secret', messageId: 'om_secret' }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_secret' } });
    await addHuman(store, '测试环境在 staging-1\n端口 8080', '环境和资源');
    await addHuman(store, '发版前回归', '发版');
    const archived = must(await addHuman(store, '已经归档的', '决定'));
    must(await store.archive({ itemId: archived.item.id, revision: 1, actor: DESKTOP }));
    const files = await store.exportBranches();
    expect(files.map(file => file.branch)).toEqual(['决定', '环境和资源', '发版']);
    expect(files[0]!.markdown).toBe('# 决定\n\n- 周四发版\n');
    expect(files[1]!.markdown).toBe('# 环境和资源\n\n- 测试环境在 staging-1\n  端口 8080\n');
    const all = files.map(file => file.markdown).join('');
    for (const leak of ['ou_secret', 'om_secret', 'oc_secret', '已经归档的']) expect(all).not.toContain(leak);
  });
});

describe('temporary files', () => {
  it('sweeps those of a dead writer', async () => {
    const { store, dir } = project();
    must(await addHuman(store, '一'));
    const stray = join(dir, 'memory.json.tmp-2147483646-00000000-0000-0000-0000-000000000000');
    writeFileSync(stray, 'half');
    const live = join(dir, `memory.json.tmp-${process.pid}-00000000-0000-0000-0000-000000000000`);
    writeFileSync(live, 'mine');
    must(await addHuman(store, '二'));
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
