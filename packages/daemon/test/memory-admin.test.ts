import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryReplySchema, memoryRequestSchema, type MemoryReply, type MemoryRequest } from '@vonvon/protocol';
import { memoryAction, type MemoryAdminDeps } from '../src/admin/memory';
import { libraryLocation } from '../src/project/library';

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-admin-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PROJECT = { id: 'prj_0a1b2c3d', name: '支付组', createdAt: 1, revision: 1, workspace: { primary: '/work/pay', additional: [] }, memoryLimit: 2 };
const OTHER = { id: 'prj_0a1b2c3e', name: '别的', createdAt: 1, revision: 1, workspace: { primary: '/work/other', additional: [] } };
function setup(origin?: 'cli', landing?: MemoryAdminDeps['landing']): { call: (request: unknown) => Promise<MemoryReply>; data: string } {
  const data = root();
  mkdirSync(join(data, 'library'), { recursive: true });
  writeFileSync(join(data, 'library', 'projects.json'), JSON.stringify({ version: 1, projects: [PROJECT, OTHER] }));
  const deps: MemoryAdminDeps = {
    library: libraryLocation(data), origin, ...(landing ? { landing } : {}),
    botDirectory: async botId => { if (botId !== 'cli_a') throw new Error('no such bot'); return join(data, 'bots', 'cli_a'); },
  } as MemoryAdminDeps;
  return { data, call: request => memoryAction(memoryRequestSchema.parse(request) as MemoryRequest, deps) };
}
const project = { kind: 'project', projectId: PROJECT.id } as const;
const bot = { kind: 'bot', botId: 'cli_a' } as const;
const item = (reply: MemoryReply) => { if (reply.kind !== 'item') throw new Error(`expected item, got ${reply.kind}`); return reply; };

describe('the memory RPC on the files', () => {
  // dm-agent 6.4. main 必败: a landing wrote into the session's own Bot, whichever Bot the request named
  it('lands a private chat\'s write in the Bot it names, with the person\'s name and no open_id of another app', async () => {
    const { call } = setup('cli', { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin' }, source: { botId: 'cli_own', actorName: '张三' } });
    const added = item(await call({ type: 'add', scope: bot, text: '周四发版' }));
    expect(added.item).toMatchObject({ trust: 'trusted', source: { botId: 'cli_own', actorRole: 'admin', actorName: '张三' } });
    expect(added.item.source).not.toHaveProperty('actorOpenId');
  });

  it('lists an empty project with its fixed branches and its limit from the library', async () => {
    const { call } = setup();
    const reply = await call({ type: 'list', scope: project });
    expect(reply).toMatchObject({ kind: 'list', items: [], limit: 2, used: 0, verified: true });
    if (reply.kind === 'list') expect(reply.branches.map(branch => branch.name)).toEqual(['决定', '约定', '人和分工', '环境和资源', '背景', '其他']);
  });

  it('adds as the owner at the desktop, trusted, and as the command line when asked', async () => {
    const ui = setup();
    const added = item(await ui.call({ type: 'add', scope: project, text: '周四发版', branch: '决定' }));
    expect(added.item).toMatchObject({ trust: 'trusted', branch: '决定', source: { via: 'ui', actorRole: 'desktop' } });
    const cli = setup('cli');
    expect(item(await cli.call({ type: 'add', scope: bot, text: '先写结论' })).item).toMatchObject({ scope: { kind: 'bot' }, branch: '其他', source: { via: 'cli', actorRole: 'cli', botId: 'cli_a' } });
    expect(readFileSync(join(cli.data, 'bots', 'cli_a', 'memory', 'memory.json'), 'utf8')).toContain('先写结论');
  });

  // D4a review R4, devices-4b 4.5: a Bot session's turn writes as itself, where its Bot process said it lands
  it('adds as a Bot session\'s turn where its Bot process landed it, as its person, trusted as it said', async () => {
    // a member's --bot lands in its group's project, untrusted (memory-authority's decideAdd)
    const member = setup('cli', { scope: { kind: 'project', projectId: PROJECT.id }, trust: 'untrusted', actor: { role: 'member', openId: 'ou_member' },
      source: { botId: 'cli_a', turn: { kind: 'human', steered: false }, chatId: 'oc_pay', messageId: 'om_1', downgraded: 'member' } });
    const landed = item(await member.call({ type: 'add', scope: bot, text: '周四发版' })).item;
    expect(landed).toMatchObject({ scope: { kind: 'project', projectId: PROJECT.id }, trust: 'untrusted',
      source: { via: 'cli', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_member', chatId: 'oc_pay', messageId: 'om_1', downgraded: 'member' } });
    expect(() => readFileSync(join(member.data, 'bots', 'cli_a', 'memory', 'memory.json'), 'utf8')).toThrow();
    const admin = setup('cli', { scope: { kind: 'bot' }, trust: 'trusted', actor: { role: 'admin', openId: 'ou_admin' }, source: { botId: 'cli_a', turn: { kind: 'human', steered: false } } });
    expect(item(await admin.call({ type: 'add', scope: bot, text: '先写结论' })).item).toMatchObject({ scope: { kind: 'bot' }, trust: 'trusted', source: { actorRole: 'admin', actorOpenId: 'ou_admin' } });
    expect(readFileSync(join(admin.data, 'bots', 'cli_a', 'memory', 'memory.json'), 'utf8')).toContain('先写结论');
  });

  it('answers refusals and conflicts as replies, not errors', async () => {
    const { call } = setup();
    const first = item(await call({ type: 'add', scope: project, text: '周四发版' }));
    expect(await call({ type: 'edit', scope: project, itemId: first.item.id, revision: 7, text: '周五' })).toMatchObject({ kind: 'conflict', current: { revision: 1 } });
    expect(await call({ type: 'add', scope: project, text: 'sk-proj-AbCd1234EfGh5678IjKl9012MnOp' })).toMatchObject({ kind: 'refused', reason: 'looks-like-secret' });
    await call({ type: 'add', scope: project, text: '第二条' });
    expect(await call({ type: 'add', scope: project, text: '第三条' })).toMatchObject({ kind: 'refused', reason: 'memory-full' });
    expect(await call({ type: 'archive', scope: project, itemId: 'p_x:nope', revision: 1 })).toMatchObject({ kind: 'refused', reason: 'not-found' });
  });

  it('refuses to rename or merge a fixed branch and reports a taken name', async () => {
    const { call } = setup();
    await call({ type: 'add', scope: bot, text: '一', branch: '甲' });
    await call({ type: 'add', scope: bot, text: '二', branch: '乙' });
    expect(await call({ type: 'branchRename', scope: bot, from: '合作方式', to: '协作' })).toMatchObject({ kind: 'refused', reason: 'fixed-branch' });
    expect(await call({ type: 'branchMerge', scope: bot, from: '关于你', into: '甲' })).toMatchObject({ kind: 'refused', reason: 'fixed-branch' });
    expect(await call({ type: 'branchRename', scope: bot, from: '甲', to: '乙' })).toMatchObject({ kind: 'conflict' });
    expect(await call({ type: 'branchRename', scope: bot, from: '没有', to: '丙' })).toMatchObject({ kind: 'refused', reason: 'no-such-branch' });
    const merged = await call({ type: 'branchMerge', scope: bot, from: '甲', into: '乙' });
    expect(merged).toMatchObject({ kind: 'branches', moved: 1 });
    const events = await call({ type: 'events', scope: bot, itemId: (item(await call({ type: 'add', scope: bot, text: '三', branch: '乙' })).item.id) });
    expect(events.kind).toBe('events');
  });

  // C5 main 必败: no branchDelete
  it('deletes a branch as the command line, a conflict and the store refusals as replies', async () => {
    const { call } = setup('cli');
    const one = item(await call({ type: 'add', scope: bot, text: '一', branch: '甲' }));
    await call({ type: 'add', scope: bot, text: '二', branch: '甲' });
    expect(await call({ type: 'branchDelete', scope: bot, name: '甲', expected: 1 })).toMatchObject({ kind: 'conflict', message: '分支里的条目刚变过，重新看一次再删' });
    expect(await call({ type: 'branchDelete', scope: bot, name: '合作方式' })).toMatchObject({ kind: 'refused', reason: 'fixed-branch' });
    const deleted = await call({ type: 'branchDelete', scope: bot, name: '甲', expected: 2 });
    expect(deleted).toMatchObject({ kind: 'branches', moved: 2 });
    expect(deleted.kind === 'branches' && deleted.branches.map(branch => branch.name)).not.toContain('甲');
    const events = await call({ type: 'events', scope: bot, itemId: one.item.id });
    expect(events.kind === 'events' && events.events.at(-1)).toMatchObject({ kind: 'archive', actor: { role: 'cli' } });
  });

  it('undoes a merge by event id', async () => {
    const { call } = setup();
    await call({ type: 'add', scope: bot, text: '一', branch: '甲' });
    await call({ type: 'add', scope: bot, text: '二', branch: '乙' });
    await call({ type: 'branchMerge', scope: bot, from: '甲', into: '乙' });
    const list = await call({ type: 'list', scope: bot });
    if (list.kind !== 'list') throw new Error('list');
    expect(await call({ type: 'undo', scope: bot, eventId: list.lastEventId! })).toMatchObject({ kind: 'branches', moved: 1 });
    const after = await call({ type: 'list', scope: bot });
    expect(after.kind === 'list' && after.branches.map(branch => branch.name)).toContain('甲');
  });

  it('promotes a project entry to a bot and moves it back, and exports and purges', async () => {
    const { call } = setup();
    const added = item(await call({ type: 'add', scope: project, text: '给主人的东西先写结论', branch: '约定' }));
    const promoted = item(await call({ type: 'promote', scope: project, itemId: added.item.id, revision: 1, botId: 'cli_a', branch: '合作方式' }));
    expect(promoted.item).toMatchObject({ scope: { kind: 'bot' }, branch: '合作方式', source: { via: 'promoted', fromItemId: added.item.id } });
    expect(await call({ type: 'export', scope: bot })).toEqual({ kind: 'exported', files: [{ branch: '合作方式', markdown: '# 合作方式\n\n- 给主人的东西先写结论\n' }] });
    const back = item(await call({ type: 'move', scope: bot, itemId: promoted.item.id, revision: 1, to: { projectId: OTHER.id } }));
    expect(back.item).toMatchObject({ scope: { kind: 'project', projectId: OTHER.id }, branch: '其他' });
    expect(await call({ type: 'purge', scope: bot, itemId: promoted.item.id })).toEqual({ kind: 'purged' });
  });

  it('turns a wrong request into an error', async () => {
    const { call } = setup();
    await expect(call({ type: 'list', scope: { kind: 'project', projectId: 'prj_00000000' } })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(call({ type: 'list', scope: { kind: 'bot', botId: 'cli_nope' } })).rejects.toThrow();
    await expect(call({ type: 'promote', scope: bot, itemId: 'b:x', revision: 1, botId: 'cli_a' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(call({ type: 'move', scope: project, itemId: 'p_x:y', revision: 1, to: { projectId: OTHER.id } })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('yields replies the protocol schema accepts', async () => {
    const { call } = setup();
    for (const request of [{ type: 'list', scope: project }, { type: 'list', scope: bot }, { type: 'export', scope: bot }]) {
      expect(memoryReplySchema.safeParse(await call(request)).success).toBe(true);
    }
  });
});
