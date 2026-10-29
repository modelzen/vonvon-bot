import {expect, it, vi} from 'vitest';
import type {MemoryItem, MemoryReply} from '@vonvon/protocol';
import {
  archiveBranchItems, branchCanChange, branchNameProblem, branchViews, downgradeText, exportFileName, joinMarks, LEAF_LIMIT, leafActions, mergeTargets, moveRequest, roleUsage, runMemory, sameJson, searchPlan, shownLeaves, sourceLines, sourceProject,
} from '../src/memory-model';
import {memoryNodes} from '../src/memory-nodes';
import type {MapNode} from '../src/MindMap';

const scope = {kind: 'project', projectId: 'prj_00000001'} as const;
const item = (id: string, branch: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id, scope: {kind: 'project', projectId: 'prj_00000001'}, text: `条目 ${id}`, branch, state: 'active', trust: 'trusted',
  source: {via: 'tool', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_secret', chatId: 'oc_pay', messageId: 'om_secret'}, createdAt: 1_000, updatedAt: 1_000, revision: 3, ...over,
});
const branch = (name: string, fixed: boolean) => ({name, fixed, createdAt: 0, createdBy: 'system'});
const names = {bot: () => '小支', group: () => '支付组群'};

it('lists the fixed branches first and always, newest leaf first, with the archived ones grouped by branch', () => {
  const {branches, archived} = branchViews({
    branches: [branch('决定', true), branch('其他', true), branch('发版', false)],
    items: [item('a', '发版', {updatedAt: 5}), item('b', '决定', {updatedAt: 1}), item('c', '决定', {updatedAt: 9}), item('d', '决定', {state: 'archived'}), item('e', '消失的分支', {trust: 'untrusted'})],
  });
  expect(branches.map(view => view.name)).toEqual(['决定', '其他', '发版', '消失的分支']);
  expect(branches[0]!.items.map(entry => entry.id)).toEqual(['c', 'b']);
  expect(branches[1]!.items).toEqual([]);
  expect(branches[3]).toMatchObject({fixed: false, pending: 1});
  expect(archived.map(view => [view.name, view.items.length])).toEqual([['决定', 1]]);
});

it('groups many historical archived categories without reviving them in the active map', () => {
  const archived = Array.from({length: 200}, (_, at) => item(`old-${at}`, `旧分类${at}`, {state: 'archived', updatedAt: at}));
  const views = branchViews({branches: [branch('决定', true), branch('其他', true)], items: [item('active', '临时分类'), ...archived]});
  expect(views.branches.map(view => view.name)).toEqual(['决定', '其他', '临时分类']);
  expect(views.archived.map(view => view.name)).toEqual(archived.map(entry => entry.branch));
  expect(views.archived.every(view => view.items.length === 1)).toBe(true);
});

it('compares all JSON fields and keeps unchanged mark sets by identity', () => {
  const reply = {kind: 'list', items: [item('a', '决定')], branches: [branch('决定', true)], verified: true, problems: [], lastEventId: 'e1', newIds: ['a'], newBranches: [], madeRoom: []};
  expect(sameJson(reply, {newBranches: [], madeRoom: [], ...reply})).toBe(true);
  expect(sameJson(reply, {...reply, verified: false})).toBe(false);
  expect(sameJson(reply, {...reply, problems: ['changed']})).toBe(false);
  expect(sameJson(reply, {...reply, lastEventId: 'e2'})).toBe(false);
  expect(sameJson(reply, {...reply, newIds: ['b']})).toBe(false);
  expect(sameJson(reply, {...reply, newBranches: ['发版']})).toBe(false);
  expect(sameJson(reply, {...reply, madeRoom: ['old']})).toBe(false);
  const first = {ids: new Set(['a']), branches: new Set(['发版']), madeRoom: new Set<string>()};
  expect(joinMarks(first, {ids: new Set(['a']), branches: new Set(), madeRoom: new Set()})).toBe(first);
  expect(joinMarks(first, {ids: new Set(), branches: new Set(), madeRoom: new Set(['old'])}).madeRoom.has('old')).toBe(true);
});

it('does not resurrect an archived-only custom category in the active map, while keeping its restore path', () => {
  const views = branchViews({branches: [branch('决定', true)], items: [item('old', '发版', {state: 'archived'})]});
  expect(views.branches.map(view => view.name)).toEqual(['决定']);
  expect(views.archived.map(view => view.name)).toEqual(['发版']);
  expect(node(memoryNodes({views, plan: searchPlan([...views.branches, ...views.archived], ''), items: new Map(), isOpen: (_id, initially) => initially, flip: vi.fn(), leafMenu: () => [], branchMenu: () => [], onLeaf: vi.fn(), leafContent: () => undefined, moveTo: vi.fn()}).archive, 'i:old')).toBeDefined();
});

it('keeps a branch to its newest 8 leaves and puts the rest behind 还有 N 条', () => {
  const many = Array.from({length: 11}, (_, at) => item(`i${at}`, '背景'));
  expect(shownLeaves(many, false)).toMatchObject({hidden: 3});
  expect(shownLeaves(many, false).shown).toHaveLength(LEAF_LIMIT);
  expect(shownLeaves(many, true)).toEqual({shown: many, hidden: 0});
  expect(shownLeaves(many.slice(0, 8), false).hidden).toBe(0);
  // a search hit past the 8th is still drawn
  expect(shownLeaves(many, false, new Set(['i10'])).shown.map(entry => entry.id)).toContain('i10');
});

const node = (root: MapNode[], id: string): MapNode | undefined => root.flatMap(function walk(entry): MapNode[] {return [entry, ...(entry.children ?? []).flatMap(walk)];}).find(entry => entry.id === id);
const build = (items: MemoryItem[], query = '', over: Partial<Parameters<typeof memoryNodes>[0]> = {}) => {
  const list = {items, branches: [branch('决定', true), branch('背景', true), branch('其他', true), branch('发版', false)]};
  const views = branchViews(list);
  return memoryNodes({
    views, plan: searchPlan([...views.branches, ...views.archived], query), items: new Map(items.map(entry => [entry.id, entry])), isOpen: (_id, initially) => initially, flip: vi.fn(),
    leafMenu: () => [], branchMenu: view => [{id: 'add', label: '在这支加一条', onSelect: vi.fn()}, ...(branchCanChange(view) ? [{id: 'rename', label: '改名', onSelect: vi.fn()}] : [])],
    onLeaf: vi.fn(), leafContent: () => undefined, moveTo: vi.fn(), ...over,
  });
};

it('draws 还有 N 条 past 8 leaves, a dashed frame for 待确认, and archived leaves muted under 已归档', () => {
  const items = [...Array.from({length: 10}, (_, at) => item(`b${at}`, '背景', {updatedAt: at})), item('p', '决定', {trust: 'untrusted'}), item('x', '决定', {state: 'archived'})];
  const {branches, archive} = build(items);
  expect(node(branches, 'b:背景')!.children!.at(-1)).toMatchObject({kind: 'more', label: '还有 2 条'});
  expect(node(branches, 'i:p')).toMatchObject({tone: 'pending', meta: '仅作参考'});
  expect(node(branches, 'b:决定')!.meta).toBe('1 · 参考 1');
  expect(archive[0]).toMatchObject({id: 'archive', open: false});
  expect(node(archive, 'i:x')).toMatchObject({tone: 'muted'});
  expect(node(archive, 'i:x')!.drag).toBeUndefined();
});

it('never duplicates a custom category editor into its archived category of the same name', () => {
  const content = '正在改名';
  const {branches, archive} = build([item('live', '发版'), item('old', '发版', {state: 'archived'})], '', {
    branchContent: view => view.name === '发版' ? content : undefined,
  });
  expect(node(branches, 'b:发版')!.content).toBe(content);
  expect(node(archive, 'a:发版')!.content).toBeUndefined();
});

it('a search highlights the hits, opens the branch they are in and dims the rest', () => {
  const items = [item('hit', '发版', {text: '发版通知发在发布群'}), item('miss', '决定', {text: '别的事'}), item('other', '发版', {text: '周四发'})];
  const {branches} = build(items, '发布群', {isOpen: (_id, initially) => initially});
  expect(node(branches, 'i:hit')!.tone).toBe('match');
  expect(node(branches, 'i:other')!.tone).toBe('dim');
  expect(node(branches, 'b:发版')).toMatchObject({open: true});
  expect(node(branches, 'b:决定')).toMatchObject({open: false, tone: 'dim'});
  // a branch matched by its own name is highlighted
  expect(node(build(items, '发版').branches, 'b:发版')!.tone).toBe('match');
  expect(searchPlan([], '   ').active).toBe(false);
});

it('the fixed branches have no 改名 or 合并 in their menu, and cannot be merged away', () => {
  const {branches} = build([]);
  expect(node(branches, 'b:决定')!.menu!.map(entry => entry.id)).toEqual(['add']);
  expect(node(branches, 'b:发版')!.menu!.map(entry => entry.id)).toEqual(['add', 'rename']);
  expect(branchCanChange({fixed: true})).toBe(false);
  expect(mergeTargets(branchViews({items: [], branches: [branch('决定', true), branch('发版', false)]}).branches, '发版')).toEqual(['决定']);
});

it('keeps selection separate from inline edits, protects fixed categories and archived entries, and offers local add', () => {
  const onLeaf = vi.fn(); const onLeafEdit = vi.fn(); const onLeafDelete = vi.fn();
  const onLeafAdd = vi.fn(); const onBranchAdd = vi.fn(); const onBranchEdit = vi.fn(); const onBranchDelete = vi.fn();
  const active = item('a', '发版', {revision: 7});
  const archived = item('old', '发版', {state: 'archived'});
  const {branches, archive} = build([active, archived], '', {onLeaf, onLeafEdit, onLeafDelete, onLeafAdd, onBranchAdd, onBranchEdit, onBranchDelete});
  const leaf = node(branches, 'i:a')!;
  leaf.onClick?.();
  expect(onLeaf).toHaveBeenCalledWith(active, false);
  expect(onLeafEdit).not.toHaveBeenCalled();
  leaf.onEdit?.({text: '新文字'});
  leaf.onDelete?.();
  leaf.onAdd?.();
  expect(onLeafEdit).toHaveBeenCalledWith(active, {text: '新文字'});
  expect(onLeafDelete).toHaveBeenCalledWith(active);
  expect(onLeafAdd).toHaveBeenCalledWith(active);
  const fixed = node(branches, 'b:决定')!;
  expect(fixed.fixed).toBe(true);
  expect(fixed.onEdit).toBeUndefined();
  expect(fixed.onDelete).toBeUndefined();
  fixed.onAdd?.();
  expect(onBranchAdd).toHaveBeenCalledWith(expect.objectContaining({name: '决定'}));
  const custom = node(branches, 'b:发版')!;
  custom.onEdit?.();
  custom.onDelete?.();
  expect(onBranchEdit).toHaveBeenCalledWith(expect.objectContaining({name: '发版'}), undefined);
  expect(onBranchDelete).toHaveBeenCalledWith(expect.objectContaining({name: '发版'}));
  expect(custom.childCount).toBe(1);
  expect(node(archive, 'i:old')!.onDelete).toBeUndefined();
});

it('archives a custom category item by item with each frozen revision and stops on conflict', async () => {
  const memory = vi.fn().mockResolvedValueOnce({kind: 'item', item: item('a', '发版', {state: 'archived', revision: 8})})
    .mockResolvedValueOnce({kind: 'conflict', message: 'changed'});
  const result = await archiveBranchItems({memory}, scope, [item('a', '发版', {revision: 7}), item('b', '发版', {revision: 4}), item('c', '发版')]);
  expect(result).toMatchObject({archived: 1, failure: {ok: false, conflict: true}});
  expect(memory.mock.calls.map(([request]) => request)).toEqual([
    {type: 'archive', scope, itemId: 'a', revision: 7},
    {type: 'archive', scope, itemId: 'b', revision: 4},
  ]);
});

it('dropping a leaf on another branch asks for the move; the same branch or an archived leaf does not take it', () => {
  const moveTo = vi.fn();
  const items = [item('a', '决定', {revision: 7}), item('z', '决定', {state: 'archived'})];
  const {branches} = build(items, '', {moveTo});
  const target = node(branches, 'b:发版')!.drop!;
  expect(target.accepts('a')).toBe(true);
  expect(target.accepts('z')).toBe(false);
  expect(node(branches, 'b:决定')!.drop!.accepts('a')).toBe(false);
  target.onDrop('a');
  expect(moveTo).toHaveBeenCalledWith('a', '发版');
  // the request carries the revision the page saw and changes only the branch
  expect(moveRequest(scope, items[0]!, ' 发版 ')).toEqual({type: 'edit', scope, itemId: 'a', revision: 7, branch: '发版'});
  expect(moveRequest(scope, items[0]!, '决定')).toBeUndefined();
  expect(moveRequest(scope, items[0]!, '  ')).toBeUndefined();
});

it('the leaf menu: delete, move, to Bot memory, 点成可信 for a waiting entry only; a Bot entry goes back to a project', () => {
  expect(leafActions({state: 'active', trust: 'trusted'}, 'project').map(entry => entry.action)).toEqual(['move-branch', 'to-bot', 'delete']);
  expect(leafActions({state: 'active', trust: 'untrusted'}, 'project').map(entry => entry.action)).toEqual(['move-branch', 'trust', 'to-bot', 'delete']);
  expect(leafActions({state: 'active', trust: 'trusted'}, 'bot', '支付组').map(entry => entry.label)).toContain('移回项目「支付组」');
  expect(leafActions({state: 'active', trust: 'trusted'}, 'bot').map(entry => entry.label)).toContain('移到项目…');
  expect(leafActions({state: 'active', trust: 'trusted'}, 'bot').map(entry => entry.action)).not.toContain('trust');
  expect(leafActions({state: 'archived', trust: 'trusted'}, 'project').map(entry => entry.action)).toEqual(['restore', 'purge']);
});

it('移回项目 starts on the project of the group the entry came from, the Bot\'s own binding of it', () => {
  const projects = [
    {id: 'prj_00000001', bindings: [{agentId: 'cli_b', groupId: 'oc_pay'}]},
    {id: 'prj_00000002', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}, {agentId: 'cli_a', groupId: 'oc_rel'}]},
  ];
  expect(sourceProject(item('a', '关于你', {source: {via: 'tool', botId: 'cli_a', actorRole: 'owner', chatId: 'oc_pay'}}), 'cli_a', projects)).toBe('prj_00000002');
  expect(sourceProject(item('a', '关于你', {source: {via: 'ui', botId: 'cli_a', actorRole: 'desktop'}}), 'cli_a', projects)).toBeUndefined();
});

it('the source block says who, where, when, why and what lowered it, and never shows an id', () => {
  const lines = sourceLines(item('a', '决定', {
    source: {via: 'tool', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_secret', chatId: 'oc_pay', messageId: 'om_secret', claim: 'asked', why: '周会上定的', downgraded: 'not-in-message'},
    lastEditedBy: {actorRole: 'owner', at: 5_000}, trust: 'untrusted',
  }), names).join('\n');
  expect(lines).toContain('群友说的');
  expect(lines).toContain('支付组群');
  expect(lines).toContain('小支 说：有人要求记。周会上定的');
  expect(lines).toContain('主人 ');
  expect(lines).toContain(downgradeText['not-in-message']);
  expect(lines).toContain('已保存，仅作参考');
  expect(lines).not.toMatch(/ou_|om_|oc_|cli_/);
  expect(sourceLines(item('b', '决定', {source: {via: 'tool', botId: 'cli_a', actorRole: 'bot', claim: 'self'}}), names)[0]).toContain('小支 自己记的');
});

it('names an export file after its branch and a branch name against the rules', () => {
  expect(exportFileName('决定')).toBe('决定.md');
  expect(exportFileName('a/b:c')).toBe('a_b_c.md');
  const views = [{name: '决定'}, {name: '发版'}];
  expect(branchNameProblem('', views)).toBeTruthy();
  expect(branchNameProblem('一二三四五六七八九十一二三', views)).toContain('12');
  expect(branchNameProblem('决定', views)).toContain('已经有');
  expect(branchNameProblem('发版', views, '发版')).toBeUndefined();
  expect(branchNameProblem('支付网关', views)).toBeUndefined();
});

it('reads a conflict as 已在别处改过, a refusal as its message, and a failure as text', async () => {
  const run = (reply: MemoryReply | Error) => runMemory({memory: async () => {if (reply instanceof Error) throw reply; return reply;}}, {type: 'list', scope});
  expect(await run({kind: 'conflict', message: 'x'})).toEqual({ok: false, conflict: true, message: '已在别处改过，重新读取。'});
  expect(await run({kind: 'refused', reason: 'memory-full', message: '满了'})).toEqual({ok: false, message: '满了'});
  expect(await run(new Error('断了'))).toEqual({ok: false, message: '断了'});
  expect((await run({kind: 'purged'})).ok).toBe(true);
});

it('shows the two 角色设定 leaves with their sizes once known', () => {
  expect(roleUsage({identity: 312, notes: 892})).toEqual([{id: 'identity', label: '身份与职责', meta: '312 / 500 字'}, {id: 'notes', label: '其他说明', meta: '892 字'}]);
  expect(roleUsage()).toEqual([{id: 'identity', label: '身份与职责'}, {id: 'notes', label: '其他说明'}]);
});
