import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importGroupMemory, importSharedMemory, splitLegacyMemory, SPLIT_NOTE } from '../src/bot/memory-import';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { libraryLocation } from '../src/project/library';

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-import-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const projectStore = (limit?: number): MemoryStore => new MemoryStore(projectMemoryLocation('prj_0a1b2c3d', { library: libraryLocation(root()), ...(limit ? { limit } : {}) }));

describe('splitting an old memory text', () => {
  it('splits on blank lines and on list items, and joins indented continuation lines', () => {
    expect(splitLegacyMemory('第一段\n接着写\n\n第二段')).toEqual(['第一段\n接着写', '第二段']);
    expect(splitLegacyMemory('- 甲\n- 乙\n* 丙\n1. 丁\n2) 戊\n3、己')).toEqual(['甲', '乙', '丙', '丁', '戊', '己']);
    expect(splitLegacyMemory('- 甲\n  继续甲\n- 乙')).toEqual(['甲 继续甲', '乙']);
    expect(splitLegacyMemory('标题\n- 甲\n- 乙\n\n\n结尾')).toEqual(['标题', '甲', '乙', '结尾']);
    expect(splitLegacyMemory('  \n\n')).toEqual([]);
    expect(splitLegacyMemory('- 甲\r\n- 乙\r\n')).toEqual(['甲', '乙']);
  });

  it('cuts a long chunk at sentence ends, truncates what still does not fit, and marks the first entry', () => {
    const sentence = '这是一句比较长的话，用来凑够字数。'.repeat(8);
    const text = sentence.repeat(9);
    expect(Array.from(text).length).toBeGreaterThan(500);
    const chunks = splitLegacyMemory(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => Array.from(chunk).length <= 500)).toBe(true);
    expect(chunks[0]!.startsWith(SPLIT_NOTE)).toBe(true);
    expect(chunks.slice(1).every(chunk => !chunk.startsWith(SPLIT_NOTE))).toBe(true);
    const unbroken = splitLegacyMemory('字'.repeat(1200));
    expect(unbroken).toHaveLength(1);
    expect(Array.from(unbroken[0]!).length).toBe(500);
    expect(splitLegacyMemory('短的\n\n短的二').every(chunk => !chunk.startsWith(SPLIT_NOTE))).toBe(true);
  });
});

describe('importing the old group memory', () => {
  const text = '- 测试群在周四发版\n- 数据库在内网\n\n部署用 deploy 脚本';
  const input = { importFile: 'projects.json#oc_a.profile.memory', text, botId: 'cli_a', chatId: 'oc_a', trusted: true };

  it('puts it in 背景 as trusted entries from the group', async () => {
    const store = projectStore();
    expect(await importGroupMemory(store, input)).toEqual({ added: 3, archived: 0, skipped: 0, rejected: 0 });
    const view = await store.read();
    expect(view.items.map(item => item.text)).toEqual(['测试群在周四发版', '数据库在内网', '部署用 deploy 脚本']);
    for (const item of view.items) {
      expect(item).toMatchObject({ branch: '背景', state: 'active', trust: 'trusted', source: { via: 'import', actorRole: 'desktop', chatId: 'oc_a', importFile: input.importFile } });
      expect(item.source.importHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('does not add the same file twice, and does not bring back one that was purged', async () => {
    const store = projectStore();
    await importGroupMemory(store, input);
    expect(await importGroupMemory(store, input)).toEqual({ added: 0, archived: 0, skipped: 3, rejected: 0 });
    expect((await store.read()).items).toHaveLength(3);
    const first = (await store.read()).items[0]!;
    await store.purge({ itemId: first.id, actor: { role: 'desktop' } });
    expect(await importGroupMemory(store, input)).toMatchObject({ added: 0, skipped: 3 });
    // an edited file adds only what is new
    expect(await importGroupMemory(store, { ...input, text: `${text}\n\n- 新的一条` })).toMatchObject({ added: 1, skipped: 3 });
    expect((await store.read()).items).toHaveLength(3);
  });

  it('imports an untrusted copy from a file in the group folder', async () => {
    const store = projectStore();
    await importGroupMemory(store, { ...input, importFile: 'groups/oc_a/memory/group.md', trusted: false });
    expect((await store.read()).items.every(item => item.trust === 'untrusted' && item.source.actorRole === 'import')).toBe(true);
  });

  it('archives what does not fit under the limit instead of refusing it', async () => {
    const store = projectStore(2);
    expect(await importGroupMemory(store, input)).toEqual({ added: 3, archived: 1, skipped: 0, rejected: 0 });
    const view = await store.read();
    expect(view.used).toBe(2);
    expect(view.items.filter(item => item.state === 'archived').map(item => item.text)).toEqual(['部署用 deploy 脚本']);
  });

  it('leaves out a line that looks like a key', async () => {
    const store = projectStore();
    expect(await importGroupMemory(store, { ...input, text: '- 正常的\n- 密钥 sk-proj-AbCd1234EfGh5678IjKl9012MnOp' })).toMatchObject({ added: 1, rejected: 1 });
  });
});

describe('importing the old shared bot memory', () => {
  it('puts all of it, archived, in 其他, to be picked one by one', async () => {
    const store = new MemoryStore(botMemoryLocation(join(root(), 'bots', 'cli_a')));
    const input = { importFile: 'memory/shared.md', text: '- 总是先写结论\n- 支付组的网关在内网', botId: 'cli_a' };
    expect(await importSharedMemory(store, input)).toEqual({ added: 2, archived: 2, skipped: 0, rejected: 0 });
    const view = await store.read();
    expect(view.used).toBe(0);
    expect(view.items).toHaveLength(2);
    for (const item of view.items) expect(item).toMatchObject({ scope: { kind: 'bot' }, branch: '其他', state: 'archived', trust: 'untrusted', source: { via: 'import', actorRole: 'import', importFile: 'memory/shared.md' } });
    expect(await importSharedMemory(store, input)).toMatchObject({ added: 0, skipped: 2 });
    // the owner brings one back, and it can be dragged to another branch
    const item = view.items[0]!;
    const restored = await store.restore({ itemId: item.id, revision: 1, actor: { role: 'desktop' } });
    expect(restored).toMatchObject({ ok: true, item: { state: 'active', branch: '其他' } });
  });
});
