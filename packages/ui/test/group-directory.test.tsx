import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {GroupDirectory, type GroupDirectoryState} from '../src/GroupDirectory';
import {AppShell} from '../src/LocalShell';
import {JoinGroupButton} from '../src/JoinGroupButton';

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const snapshot = desktopSnapshotSchema.parse({
  revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.7.6'},
  agents: ['cli_one', 'cli_two'].map(id => ({id, name: id, enabled: true, running: true, connection: 'connected', activation: 'active'})),
  groups: [{id: 'oc_one', name: '研发群'}, {id: 'oc_two', name: '发布群'}],
  projects: [],
  memberships: [['cli_one', 'oc_one', 'prj_00000001'], ['cli_two', 'oc_one', 'prj_00000002'], ['cli_one', 'oc_two', 'prj_00000001']].map(([agentId, groupId, projectId]) => ({id: JSON.stringify([agentId, groupId]), agentId, groupId, projectId, name: groupId, directory: '/tmp/r', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'qa', member: 'qa', network: false}, stale: false})),
  tools: [], jobs: [], application: {platform: 'macos', version: '0.7.6', loginItem: false, dataPath: '/tmp/review'},
});
function harness(data = snapshot, statusFor: Parameters<typeof GroupDirectory>[0]['statusFor'] = () => ({label: '', tone: 'success'})) {
  let state: GroupDirectoryState = {query: '', expanded: {}};
  const onMembership = vi.fn();
  const onJoin = vi.fn();
  const render = () => nodes(GroupDirectory({snapshot: data, state, onStateChange: next => {state = next;}, statusFor, onMembership, onJoin}));
  return {render, onMembership, onJoin, state: () => state};
}

it('groups by Feishu group even when one group has different projects and two groups share a project', () => {
  const h = harness();
  const groups = h.render().filter(node => node.props.className === 'group-directory-bots');
  expect(groups.map(group => [group.props['aria-label'], nodes(group.props.children).filter(node => node.props.className === 'group-directory-bot').length])).toEqual([['研发群的 Bot', 2], ['发布群的 Bot', 1]]);
  const rows = h.render().filter(node => node.props.className === 'group-directory-bot');
  rows[1]!.props.onClick();
  expect(h.onMembership).toHaveBeenCalledWith(JSON.stringify(['cli_two', 'oc_one']));
});

it('shows one new-memory action per group and opens its matching Bot binding', () => {
  const onNewMemory = vi.fn();
  const tree = nodes(GroupDirectory({snapshot, state: {query: '', expanded: {}}, onStateChange: vi.fn(), statusFor: () => ({label: '', tone: 'success'}), onMembership: vi.fn(), onNewMemory, onJoin: vi.fn(), newCounts: {prj_00000001: 1, prj_00000002: 2}}));
  const groups = tree.filter(node => node.props.className === 'group-directory-item');
  const action = (group: Element) => nodes(group).filter(node => node.props.className === 'group-directory-new-memory');
  expect(action(groups[0]!)).toHaveLength(1);
  expect(action(groups[0]!)[0]!.props.children.slice(0, 2).join('')).toBe('3 条新记忆');
  expect(action(groups[1]!)).toHaveLength(1);
  action(groups[1]!)[0]!.props.onClick();
  expect(onNewMemory).toHaveBeenCalledWith(JSON.stringify(['cli_one', 'oc_two']));
  expect(nodes(groups[0]!).filter(node => node.props.className === 'group-directory-count')[0]!.props.children.join('')).toBe('2 个 Bot');
});

it('retains the tree search and expansion when opening a binding and rendering it again', () => {
  const h = harness();
  h.render().find(node => node.type === 'input')!.props.onChange({target: {value: '研发'}});
  h.render().find(node => node.props.className === 'group-directory-identity')!.props.onClick();
  const before = structuredClone(h.state());
  h.render().find(node => node.props.className === 'group-directory-bot')!.props.onClick();
  expect(h.state()).toEqual(before);
  expect(h.render().find(node => node.type === 'input')!.props.value).toBe('研发');
  expect(h.render().find(node => node.props.className === 'group-directory-bots')!.props.hidden).toBe(true);
});

it('keeps the original group tree available with an old daemon', () => {
  const h = harness({...snapshot, projects: undefined, memberships: snapshot.memberships.map(({projectId: _drop, ...member}) => member)});
  expect(h.render().filter(node => node.props.className === 'group-directory-identity')).toHaveLength(2);
  expect(h.onMembership).not.toHaveBeenCalled();
});

it('summarizes unavailable bindings without muting a group that still has an available Bot', () => {
  const h = harness({...snapshot, memberships: snapshot.memberships.map((member, index) => ({...member, enabled: index === 1}))});
  const groups = h.render().filter(node => node.props.className === 'group-directory-item');
  expect(groups.map(group => group.props['data-unavailable'])).toEqual([undefined, true]);
  const summary = (group: Element) => nodes(group).find(node => node.props.className === 'group-directory-summary')!.props.children;
  expect(groups.map(summary)).toEqual(['1 个 Bot 不可用', '本群已停用']);
  const unavailableRow = h.render().find(node => node.props.className === 'group-directory-bot' && node.props['data-unavailable'])!;
  expect(unavailableRow.props.disabled).toBe(false);
  unavailableRow.props.onClick();
  expect(h.onMembership).toHaveBeenCalledWith(snapshot.memberships[0]!.id);
});

it.each([
  ['stopped', 'Bot 已停用', 'neutral'],
  ['disconnected', '未连接', 'neutral'],
  ['stale', '状态过期', 'warning'],
  ['missing', 'Bot 暂不可用', 'warning'],
] as const)('shows %s status in a collapsed group', (kind, label, tone) => {
  const h = harness({
    ...snapshot,
    agents: kind === 'missing' ? [] : snapshot.agents,
    memberships: snapshot.memberships.map(member => ({...member, stale: kind === 'stale'})),
  }, () => kind === 'stopped' ? {label: '已停用', tone: 'neutral'} : {label: '未连接', tone: 'neutral'});
  const group = h.render().filter(node => node.props.className === 'group-directory-item')[1]!;
  expect(nodes(group).find(node => node.props.className === 'group-directory-bots')!.props.hidden).toBe(true);
  const summary = nodes(group).find(node => node.props.className === 'group-directory-summary')!;
  expect([summary.props.children, summary.props['data-tone'], group.props['data-unavailable']]).toEqual([label, tone, true]);
});

it('keeps the join entry available through empty searches without changing the group tree', () => {
  const h = harness();
  h.render().find(node => node.type === 'input')!.props.onChange({target: {value: '没有这个群'}});
  const action = h.render().find(node => node.type === JoinGroupButton)!;
  expect(action.props.disabled).not.toBe(true);
  action.props.onClick();
  expect(h.onJoin).toHaveBeenCalledOnce();
  expect(h.state()).toEqual({query: '没有这个群', expanded: {}});
  expect(h.render().some(node => node.props.className === 'group-directory-toggle')).toBe(false);
});

it('shows the same join entry before the first group has been connected', () => {
  const h = harness({...snapshot, groups: [], memberships: []});
  h.render().find(node => node.type === JoinGroupButton)!.props.onClick();
  expect(h.onJoin).toHaveBeenCalledOnce();
});

it('uses 群组 as the primary destination while retaining project memory counts', () => {
  const onOpenList = vi.fn();
  const shell = nodes(AppShell({page: 'collaboration', view: 'projects', title: '项目管理', newCounts: {bots: 1, projects: 3}, children: null, onNavigate: vi.fn(), onOpenList}));
  const nav = shell.find(node => node.props['aria-label'] === '主要导航')!;
  const buttons = nodes(nav.props.children).filter(node => node.type === 'button');
  expect(buttons.map(button => [button.props.children].flat()[0])).toEqual(['此刻', '社区', 'Bot', '群组']);
  buttons[3]!.props.onClick();
  expect(onOpenList).toHaveBeenCalledWith('groups');
  expect(nodes(buttons[3]!.props.children).find(node => node.type === 'small')!.props.children.join('')).toBe('新记忆 3');
});
