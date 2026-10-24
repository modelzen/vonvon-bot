import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {GroupDirectory, type GroupDirectoryState} from '../src/GroupDirectory';
import {AppShell} from '../src/LocalShell';

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
function harness(data = snapshot) {
  let state: GroupDirectoryState = {query: '', expanded: {}};
  const onMembership = vi.fn();
  const render = () => nodes(GroupDirectory({snapshot: data, state, onStateChange: next => {state = next;}, statusFor: () => ({label: '', tone: 'success'}), onMembership}));
  return {render, onMembership, state: () => state};
}

it('groups by Feishu group even when one group has different projects and two groups share a project', () => {
  const h = harness();
  const groups = h.render().filter(node => node.props.className === 'group-directory-bots');
  expect(groups.map(group => [group.props['aria-label'], nodes(group.props.children).filter(node => node.props.className === 'group-directory-bot').length])).toEqual([['研发群的 Bot', 2], ['发布群的 Bot', 1]]);
  const rows = h.render().filter(node => node.props.className === 'group-directory-bot');
  rows[1]!.props.onClick();
  expect(h.onMembership).toHaveBeenCalledWith(JSON.stringify(['cli_two', 'oc_one']));
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

it('uses 群组 as the primary destination while retaining project memory counts', () => {
  const onOpenList = vi.fn();
  const shell = nodes(AppShell({page: 'collaboration', view: 'projects', title: '项目管理', newCounts: {bots: 1, projects: 3}, children: null, onNavigate: vi.fn(), onOpenList}));
  const nav = shell.find(node => node.props['aria-label'] === '主要导航')!;
  const buttons = nodes(nav.props.children).filter(node => node.type === 'button');
  expect(buttons.map(button => [button.props.children].flat()[0])).toEqual(['概览', 'Bot', '群组']);
  buttons[2]!.props.onClick();
  expect(onOpenList).toHaveBeenCalledWith('groups');
  expect(nodes(buttons[2]!.props.children).find(node => node.type === 'small')!.props['aria-label']).toBe('新记忆 3 条');
});
