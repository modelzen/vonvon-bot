import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {desktopSnapshotSchema, type ContextPreviewReply, type MemoryItem} from '@vonvon/protocol';
import {MindMap, type MapNode} from '../src/MindMap';
import {AppShell} from '../src/LocalShell';
import {ProjectDirectory} from '../src/ProjectDirectory';
import {ContextPanelView} from '../src/ContextPanel';
import {branchViews, joinMarks, marksOf, noMarks, searchPlan} from '../src/memory-model';
import {memoryNodes} from '../src/memory-nodes';
import {groupByBranch, injectedLine, INSTRUCTION_FILES_NOTE, judgeItems, judgeLines, lastTurnLines, newestTurn, panelRows} from '../src/context-model';
import {backgroundCount, migrationLines, pendingSharedCount, splitGroupCount} from '../src/migration-model';
import {countsOf, newTag, sumCounts} from '../src/new-counts';

const item = (id: string, branch: string, over: Partial<MemoryItem> = {}): MemoryItem => ({
  id, scope: {kind: 'project', projectId: 'prj_00000001'}, text: `条目 ${id}`, branch, state: 'active', trust: 'trusted',
  source: {via: 'tool', botId: 'cli_a', actorRole: 'member', chatId: 'oc_pay'}, createdAt: 1_000, updatedAt: 1_000, revision: 1, ...over,
});
const fixed = (name: string) => ({name, fixed: true, createdAt: 0, createdBy: 'system'});
const node = (root: MapNode[], id: string): MapNode | undefined => root.flatMap(function walk(entry): MapNode[] {return [entry, ...(entry.children ?? []).flatMap(walk)];}).find(entry => entry.id === id);
const build = (items: MemoryItem[], marks = noMarks, open = false) => {
  const views = branchViews({items, branches: [fixed('决定'), fixed('约定'), {name: '发版', fixed: false, createdAt: 1, createdBy: 'bot'}]});
  return memoryNodes({
    views, plan: searchPlan([...views.branches, ...views.archived], ''), items: new Map(items.map(entry => [entry.id, entry])), marks, isOpen: (_id, initially) => open || initially, flip: vi.fn(),
    leafMenu: () => [], branchMenu: () => [], onLeaf: vi.fn(), leafContent: () => undefined, moveTo: vi.fn(),
  });
};

it('draws a dot on a new leaf, 新 N on its branch and on 已归档, 新 on a branch the Bot opened, and 为腾位归档 on the archived leaf', () => {
  const items = [item('a', '决定'), item('b', '决定'), item('c', '约定'), item('r', '决定', {state: 'archived'}), item('v', '发版')];
  const marks = marksOf({newIds: ['a', 'r'], newBranches: ['发版'], madeRoom: ['r']});
  const {branches, archive} = build(items, marks);
  expect(node(branches, 'i:a')).toMatchObject({fresh: true});
  expect(node(branches, 'i:b')!.fresh).toBeUndefined();
  expect(node(branches, 'b:决定')!.meta).toBe('2 · 新 1');
  expect(node(branches, 'b:约定')!.meta).toBe('1');
  expect(node(branches, 'b:发版')!.meta).toBe('1 · 新');
  expect(archive[0]!.meta).toBe('1 · 新 1');
  expect(node(archive, 'i:r')).toMatchObject({fresh: true, meta: '为腾位归档'});
  const opened = build(items, marks, true);
  const html = renderToStaticMarkup(<MindMap root={{id: 'root', kind: 'root', label: '支付组', children: [...opened.branches, ...opened.archive]}} label="导图"/>);
  expect(html).toContain('class="mm-new" role="img" aria-label="新"');
  expect(html).toContain('data-fresh="true"');
  expect(html).toContain('为腾位归档');
});

it('draws nothing as new when there is nothing new, and keeps the first reading\'s marks when a later one is empty', () => {
  const {branches} = build([item('a', '决定')]);
  expect(node(branches, 'i:a')!.fresh).toBeUndefined();
  expect(node(branches, 'b:决定')!.meta).toBe('1');
  const first = marksOf({newIds: ['a'], newBranches: [], madeRoom: []});
  const joined = joinMarks(first, marksOf({newIds: ['z'], newBranches: ['发版']}));
  expect([...joined.ids]).toEqual(['a', 'z']);
  expect([...joined.branches]).toEqual(['发版']);
  expect(marksOf({}).ids.size).toBe(0);
});

it('shows the counts on the navigation, in the project list and in the Bot list, and nothing for zero', () => {
  const shell = (counts?: {bots: number; projects: number}) => renderToStaticMarkup(<AppShell page="collaboration" view="projects" title="项目" newCounts={counts} onNavigate={vi.fn()} onOpenList={vi.fn()}>x</AppShell>);
  expect(shell({bots: 1, projects: 3})).toContain('title="新记忆 3 条">新记忆 3</small>');
  expect(shell({bots: 1, projects: 3})).toContain('title="新记忆 1 条">新记忆 1</small>');
  expect(shell({bots: 0, projects: 0})).not.toContain('today-nav-count');
  expect(shell()).not.toContain('today-nav-count');
  const snapshot = desktopSnapshotSchema.parse({
    revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '1'},
    agents: [{id: 'cli_a', name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active'}], groups: [{id: 'oc_pay', name: '支付组群'}],
    projects: [{id: 'prj_00000001', name: '支付组', revision: 1, directory: '/w', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}]}, {id: 'prj_00000002', name: '官网', revision: 1, directory: '/w2', bindings: [{agentId: 'cli_a', groupId: 'oc_pay'}]}],
    memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: '1', loginItem: false, dataPath: '/t'},
  });
  const list = renderToStaticMarkup(<ProjectDirectory snapshot={snapshot} state={{query: '', expanded: {}}} onStateChange={vi.fn()} statusFor={() => ({label: '', tone: 'success'})} onProject={vi.fn()} onMembership={vi.fn()} newCounts={{prj_00000001: 2}}/>);
  expect(list).toContain(' · 新 2<');
  expect(list.match(/ · 新 /g)).toHaveLength(1);
  expect(newTag(2)).toBe('新 2'); expect(newTag(0)).toBe(''); expect(newTag(undefined)).toBe('');
  expect(sumCounts({a: 2, b: 3})).toBe(5);
  expect(countsOf({kind: 'newCounts', projects: {p: 1}, bots: {b: 2}})).toEqual({projects: {p: 1}, bots: {b: 2}});
  expect(countsOf({kind: 'purged'})).toEqual({projects: {}, bots: {}});
});

const reply = (over: Partial<ContextPreviewReply> = {}): ContextPreviewReply => ({
  kind: 'preview', running: true,
  next: {
    sections: [
      {key: 'identity', version: 'i1', chars: 20}, {key: 'role', version: 'd4e5f6', chars: 1204}, {key: 'supplement', version: 's1', chars: 86},
      {key: 'botMemory', version: 'b1', chars: 90, items: 3, branches: 4}, {key: 'projectMemory', version: 'p2', chars: 400, items: 23, branches: 7},
    ],
    items: {bot: 3, trusted: 17, untrusted: 6}, tools: ['memory_add', 'memory_update', 'memory_forget', 'memory_list'],
  },
  session: {
    threadId: 't1', updatedAt: 1, backend: 'codex-appserver', legacy: false, redeliverDue: false,
    sections: [
      {key: 'identity', version: 'i1', stale: false}, {key: 'role', version: 'a1b2c3d4', stale: true}, {key: 'supplement', version: 's1', stale: false},
      {key: 'botMemory', version: 'b1', stale: false, items: 3, branches: 4}, {key: 'projectMemory', version: 'p1', stale: true, items: 22, branches: 7},
    ],
    lastTurn: {at: Date.UTC(2026, 9, 23, 6, 2), injected: 25, items: {bot: 3, trusted: 17, untrusted: 5}, used: [{id: 'p_x:1', text: '发版改到周四'}, {id: 'p_x:2'}], missed: ['像密钥', '像密钥']},
  },
  judge: {via: 'third-party', label: 'TypeSafe Jev', roleChars: 120, memoryItems: 2, memoryChars: 40},
  ...over,
});

it('lists two columns of vonvon\'s own parts: what the live session has and what a new one gets, with the stale ones flagged', () => {
  const rows = panelRows(reply());
  expect(rows.map(row => row.label)).toEqual(['固定约定', '身份行', '角色设定', '本项目的补充职责', 'Bot 记忆', '项目记忆']);
  expect(rows.find(row => row.key === 'role')).toMatchObject({live: '版本 a1b2c3，还没收到，下一轮生效', liveWarn: true, next: '1,204 字'});
  expect(rows.find(row => row.key === 'botMemory')).toMatchObject({live: '3 条', next: '3 条（4 个分支）'});
  expect(rows.find(row => row.key === 'projectMemory')).toMatchObject({live: '22 条，还没收到，下一轮生效', liveWarn: true, next: '可信 17 条 / 待确认 6 条（7 个分支）'});
  expect(rows.find(row => row.key === 'identity')).toMatchObject({live: '✓', next: '✓'});
  const legacy = panelRows(reply({session: {...reply().session!, legacy: true, sections: []}}));
  expect(legacy[0]).toMatchObject({live: '旧版（升级前开场）', liveWarn: true});
  expect(panelRows(reply({session: undefined})).every(row => row.live === undefined)).toBe(true);
});

it('renders the panel with the model\'s own account of the last turn, the not-recorded line, the judge line and exactly one fixed sentence', () => {
  const html = renderToStaticMarkup(<ContextPanelView title="小支 · 支付组群 · Codex" groupId="oc_pay" reply={reply()} onOpen={vi.fn()} go={{role: vi.fn(), projectMemory: vi.fn()}}/>);
  expect(html).toContain('这条活会话实际有的');
  expect(html).toContain('下一次新会话会有的');
  expect(html).toContain('还没收到，下一轮生效');
  expect(html).toContain('去改');
  expect(html).toContain('去看');
  expect(html).toContain('模型说参考了 2 条：发版改到周四 · （这条已经不在了）');
  expect(html).toContain('模型自述，群里不显示');
  expect(html).toContain('有 2 条没记上：像密钥（不存原文）');
  expect(html).toContain('智能判断会发给决策模型（TypeSafe Jev，第三方）');
  expect(html).toContain('项目记忆只发本群可信条目 2 条');
  expect(html.split(INSTRUCTION_FILES_NOTE)).toHaveLength(2);
  expect(INSTRUCTION_FILES_NOTE).toBe('模型还会读项目自己的 AGENTS.md / CLAUDE.md，vonvon 不显示也不改。');
  // D6: no rule row, no instruction file path or name beyond the fixed sentence
  const without = html.replace(INSTRUCTION_FILES_NOTE, '');
  expect(without).not.toMatch(/AGENTS|CLAUDE|规矩|\.md|~\/|\/home\/|\/Users\//);
});

it('says so when the Bot is stopped or the group has no live session, and still ends with the fixed sentence', () => {
  const stopped = renderToStaticMarkup(<ContextPanelView title="x" groupId="oc_pay" reply={reply({running: false, session: undefined})} onOpen={vi.fn()}/>);
  expect(stopped).toContain('没有运行，没有活会话');
  expect(stopped).toContain(INSTRUCTION_FILES_NOTE);
  const none = renderToStaticMarkup(<ContextPanelView title="x" groupId="oc_pay" reply={reply({session: undefined})} onOpen={vi.fn()}/>);
  expect(none).toContain('现在没有活会话');
  const failed = renderToStaticMarkup(<ContextPanelView title="x" groupId="oc_pay" error="读不到" onOpen={vi.fn()}/>);
  expect(failed).toContain('读不到');
  expect(failed).toContain(INSTRUCTION_FILES_NOTE);
});

it('opens the entries behind the counts by branch, and for the decision model lists this group\'s trusted ones only', () => {
  const items = [
    item('1', '决定', {createdAt: 5}), item('2', '约定', {createdAt: 9}), item('3', '决定', {trust: 'untrusted', createdAt: 7}),
    item('4', '决定', {source: {via: 'tool', botId: 'cli_a', actorRole: 'member', chatId: 'oc_other'}, createdAt: 8}), item('5', '决定', {state: 'archived'}),
  ];
  expect(judgeItems(items, 'oc_pay', 5).map(entry => entry.id)).toEqual(['2', '1']);
  expect(judgeItems(items, 'oc_pay', 1).map(entry => entry.id)).toEqual(['2']);
  expect(groupByBranch(items.slice(0, 3), ['决定', '约定']).map(group => [group.branch, group.items.length])).toEqual([['决定', 2], ['约定', 1]]);
  const project = {items: items.filter(entry => entry.state === 'active'), branches: ['决定', '约定']};
  const html = renderToStaticMarkup(<ContextPanelView title="x" groupId="oc_pay" reply={reply()} open="judge" details={{project}} onOpen={vi.fn()}/>);
  expect(html).toContain('条目 2');
  expect(html).toContain('条目 1');
  expect(html).not.toContain('条目 3');
  expect(html).not.toContain('条目 4');
  const inject = renderToStaticMarkup(<ContextPanelView title="x" groupId="oc_pay" reply={reply()} open="project" details={{project}} onOpen={vi.fn()}/>);
  expect(inject).toContain('待确认');
  expect(inject).toContain('条目 3');
});

it('words the judge line for a local model, the last turn for the project page and picks the newest among bindings', () => {
  expect(judgeLines({via: 'local', roleChars: 0, memoryItems: 0, memoryChars: 0})[0]).toBe('智能判断交给本机决策模型');
  const turn = reply().session!.lastTurn!;
  expect(lastTurnLines(turn).head).toMatch(/^最近一轮参考了 2 条（10-23 \d\d:\d\d）$/);
  expect(lastTurnLines({...turn, missed: undefined}).missed).toBeUndefined();
  expect(injectedLine(turn)).toBe('注入：Bot 记忆 3 条 · 项目记忆 可信 17 / 待确认 5');
  const older = reply({session: {...reply().session!, lastTurn: {...turn, at: 1}}});
  expect(newestTurn([{label: '旧', reply: older}, {label: '新', reply: reply()}, {label: '没读到'}])!.label).toBe('新');
  expect(newestTurn([{label: '没读到'}])).toBeUndefined();
});

it('builds the migration banner from what happened to this installation and says nothing when nothing did', () => {
  expect(migrationLines({splitGroups: 0, rolesMerged: 0, pendingShared: 0, background: 0})).toEqual([]);
  const lines = migrationLines({splitGroups: 1, rolesMerged: 1, pendingShared: 4, background: 6});
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain('两个 Bot 现在是两个项目');
  expect(lines[1]).toContain('并到了“其他说明”');
  expect(lines[2]).toContain('“背景”分支');
  expect(lines[3]).toContain('旧的公共记忆 4 条待挑选');
  expect(migrationLines({splitGroups: 0, rolesMerged: 0, pendingShared: 0, background: 2}).join()).not.toContain('AGENTS.md');
  expect(splitGroupCount({projects: [
    {id: 'prj_00000001', name: 'a', revision: 1, directory: '/a', bindings: [{agentId: 'cli_a', groupId: 'oc_1'}]},
    {id: 'prj_00000002', name: 'b', revision: 1, directory: '/b', bindings: [{agentId: 'cli_b', groupId: 'oc_1'}, {agentId: 'cli_b', groupId: 'oc_2'}]},
  ] as never})).toBe(1);
  const imported = {via: 'import' as const, botId: 'cli_a', actorRole: 'import' as const};
  expect(pendingSharedCount([item('a', '其他', {state: 'archived', source: imported}), item('b', '其他', {source: imported}), item('c', '其他', {state: 'archived'})])).toBe(1);
  expect(backgroundCount([item('a', '背景', {source: imported}), item('b', '决定', {source: imported}), item('c', '背景')])).toBe(1);
});
