import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryReplySchema, memoryRequestSchema, type MemoryReply, type MemoryRequest } from '@vonvon/protocol';
import { memoryAction, type MemoryAdminDeps } from '../src/admin/memory';
import { MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { libraryLocation } from '../src/project/library';

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-seen-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PROJECT = { id: 'prj_0a1b2c3d', name: '支付组', createdAt: 1, revision: 1, workspace: { primary: '/work/pay', additional: [] }, memoryLimit: 3 };
const project = { kind: 'project', projectId: PROJECT.id } as const;

function setup(): { call: (request: unknown) => Promise<MemoryReply>; group: MemoryStore; data: string; clock: { at: number } } {
  const data = root();
  const library = libraryLocation(data);
  mkdirSync(library.dir, { recursive: true });
  writeFileSync(library.file, JSON.stringify({ version: 1, projects: [PROJECT] }));
  const clock = { at: 1_000 };
  const deps: MemoryAdminDeps = { library, now: () => clock.at, botDirectory: async () => join(data, 'bots', 'cli_a') };
  // 群里的写入：bot 经工具写，和桌面端的写入走同一个条目库
  const group = new MemoryStore(projectMemoryLocation(PROJECT.id, { library, limit: 3 }), { now: () => clock.at });
  return { data, clock, group, call: request => memoryAction(memoryRequestSchema.parse(request) as MemoryRequest, deps) };
}
const written = (text: string, branch?: string) => ({
  text, ...(branch ? { branch } : {}), trust: 'trusted' as const, actor: { role: 'bot' as const },
  source: { via: 'tool' as const, botId: 'cli_a', actorRole: 'bot' as const, chatId: 'oc_pay' },
});
const list = (reply: MemoryReply) => { if (reply.kind !== 'list') throw new Error(`expected list, got ${reply.kind}`); return reply; };
const idOf = async (call: (request: unknown) => Promise<MemoryReply>, text: string) => list(await call({ type: 'list', scope: project })).items.find(entry => entry.text === text)!;

describe('the 新 marks (§5.8)', () => {
  it('marks what the group wrote, not what the owner did at the desktop, and the marks go once the page is seen', async () => {
    const { call, group, clock } = setup();
    clock.at = 2_000;
    await group.add(written('群里记的', '决定'));
    clock.at = 2_100;
    await call({ type: 'add', scope: project, text: '主人自己加的', branch: '决定' });
    const first = list(await call({ type: 'list', scope: project }));
    const mine = await idOf(call, '群里记的'), own = await idOf(call, '主人自己加的');
    expect(first.newIds).toEqual([mine.id]);
    expect(first.newIds).not.toContain(own.id);

    clock.at = 3_000;
    expect(await call({ type: 'seen', page: { kind: 'project', projectId: PROJECT.id } })).toEqual({ kind: 'seen', at: 3_000 });
    expect(list(await call({ type: 'list', scope: project })).newIds).toEqual([]);
    // 打开之后群里再记的又标"新"
    clock.at = 4_000;
    await group.add(written('之后又记的'));
    expect(list(await call({ type: 'list', scope: project })).newIds).toEqual([(await idOf(call, '之后又记的')).id]);
  });

  it('stores the time per page in library/seen.json, atomically, and reads a damaged file as never seen', async () => {
    const { call, data, clock } = setup();
    clock.at = 5_000;
    await call({ type: 'seen', page: { kind: 'project', projectId: PROJECT.id } });
    clock.at = 6_000;
    await call({ type: 'seen', page: { kind: 'bot', botId: 'cli_a' } });
    expect(JSON.parse(readFileSync(join(data, 'library', 'seen.json'), 'utf8'))).toEqual({ [`project:${PROJECT.id}`]: 5_000, 'bot:cli_a': 6_000 });
    writeFileSync(join(data, 'library', 'seen.json'), '{not json');
    expect(list(await call({ type: 'list', scope: project })).newIds).toEqual([]);
  });

  it('does not mark an edit, a branch rename, a merge, or an undo the owner made at the desktop', async () => {
    const { call, group, clock } = setup();
    await group.add(written('旧条目', '决定'));
    await call({ type: 'seen', page: { kind: 'project', projectId: PROJECT.id } });
    clock.at = 9_000;
    const entry = await idOf(call, '旧条目');
    await call({ type: 'edit', scope: project, itemId: entry.id, revision: entry.revision, text: '改过的旧条目' });
    await call({ type: 'branchRename', scope: project, from: '决定', to: '决定' }).catch(() => undefined);
    expect(list(await call({ type: 'list', scope: project })).newIds).toEqual([]);
    // 群里把它改了分支：标
    clock.at = 9_500;
    const current = await idOf(call, '改过的旧条目');
    await group.edit({ itemId: current.id, revision: current.revision, branch: '约定', actor: { role: 'bot' } });
    expect(list(await call({ type: 'list', scope: project })).newIds).toEqual([current.id]);
  });

  it('marks a branch the Bot opened and lists the entries archived to make room', async () => {
    const { call, group, clock } = setup();
    clock.at = 2_000;
    const old = await group.add(written('最老的'));
    await group.add(written('第二条'));
    clock.at = 2_500;
    await group.add(written('发版要点', '发版'));
    if (!old.ok || !('item' in old)) throw new Error('add failed');
    clock.at = 3_000;
    await group.archive({ itemId: old.item.id, revision: old.item.revision, actor: { role: 'bot' }, reason: 'make-room' });
    const reply = list(await call({ type: 'list', scope: project }));
    expect(reply.newBranches).toEqual(['发版']);
    expect(reply.madeRoom).toEqual([old.item.id]);
    expect(reply.newIds).toContain(old.item.id);
    // 看过以后"新"没了，"为腾位归档"这条事实还在
    await call({ type: 'seen', page: { kind: 'project', projectId: PROJECT.id } });
    const later = list(await call({ type: 'list', scope: project }));
    expect(later.newIds).toEqual([]);
    expect(later.madeRoom).toEqual([old.item.id]);
  });

  it('counts the new entries of every project for the navigation and the lists', async () => {
    const { call, group, clock } = setup();
    clock.at = 2_000;
    await group.add(written('一'));
    await group.add(written('二'));
    const reply = await call({ type: 'newCounts' });
    expect(reply).toEqual({ kind: 'newCounts', projects: { [PROJECT.id]: 2 }, bots: {} });
    expect(memoryReplySchema.safeParse(reply).success).toBe(true);
    await call({ type: 'seen', page: { kind: 'project', projectId: PROJECT.id } });
    expect(await call({ type: 'newCounts' })).toEqual({ kind: 'newCounts', projects: {}, bots: {} });
  });
});
