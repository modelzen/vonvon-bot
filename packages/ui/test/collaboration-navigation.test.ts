import assert from 'node:assert/strict';
import {test} from 'vitest';
import {agentIdSchema, groupIdSchema, membershipIdSchema, projectIdSchema, type DesktopSnapshot} from '@vonvon/protocol';
import {agentPanes, joinedGroupRoute, openDm, openMembership, routeBack, routeDetail, routeFromSearch, routeSelection, routeView, type CollaborationRoute} from '../src/collaboration-navigation';

const agentId = agentIdSchema.parse('cli_navigationA');
const anotherAgentId = agentIdSchema.parse('cli_navigationB');
const groupId = groupIdSchema.parse('oc_navigation');
const memberId = membershipIdSchema.parse('navigationA');
const anotherMemberId = membershipIdSchema.parse('navigationB');
const projectId = projectIdSchema.parse('prj_00000a0b');
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [agentId, anotherAgentId].map((id, index) => ({id, name: `Agent ${index}`, enabled: true, running: true, connection: 'connected' as const, activation: 'active' as const})),
  groups: [{id: groupId, name: '研发群'}],
  projects: [{id: projectId, name: '研发项目组', revision: 1, directory: '/tmp/research', bindings: [{agentId, groupId}, {agentId: anotherAgentId, groupId}]}],
  memberships: [memberId, anotherMemberId].map((id, index) => ({id, agentId: index ? anotherAgentId : agentId, groupId, projectId, name: `项目 ${index}`, directory: '/tmp/research', backend: 'codex-appserver', conversation: 'threads' as const, response: 'mention' as const, permission: {administrator: 'full' as const, member: 'qa' as const, network: false}, stale: false})),
  tools: [], jobs: [],
  application: {platform: 'macos', version: '0.7.0', loginItem: false, dataPath: '/tmp/test'},
};

test('Agent → group collaboration → settings → back restores the Agent and its pane', () => {
  const agent: CollaborationRoute = {kind: 'agent', id: agentId, pane: {kind: 'groups'}};
  const member = openMembership(agent, memberId, snapshot);
  assert.equal(routeView(member), 'agents');
  assert.deepEqual(routeSelection(member), {kind: 'membership', id: memberId});
  if (member.kind !== 'membership') return assert.fail('expected group collaboration');
  const settings: CollaborationRoute = {...member, pane: {kind: 'settings'}};
  assert.deepEqual(routeDetail(settings), {kind: 'membership-settings'});
  assert.deepEqual(routeBack(settings), agent);
  assert.deepEqual(routeBack(routeBack(settings)), {kind: 'list', view: 'agents'});
});

test('project → each binding → back restores the project and its pane', () => {
  const project: CollaborationRoute = {kind: 'project', id: projectId, pane: {kind: 'workspace'}};
  const first = openMembership(project, memberId, snapshot);
  const second = openMembership(project, anotherMemberId, snapshot);
  assert.notDeepEqual(routeSelection(first), routeSelection(second));
  assert.equal(routeView(first), 'projects');
  assert.deepEqual(routeSelection(project), {kind: 'project', id: projectId});
  assert.deepEqual(routeBack(first), project);
  assert.deepEqual(routeBack(second), project);
  assert.deepEqual(routeBack(project), {kind: 'list', view: 'projects'});
});

test('Agent settings use one pane and return to the Agent list', () => {
  const destination = {page: 'collaboration' as const, selection: {kind: 'agent' as const, id: agentId}, detail: {kind: 'agent-settings' as const}};
  const found = routeFromSearch(destination, snapshot);
  assert.deepEqual(found?.route, {kind: 'agent', id: agentId, pane: {kind: 'settings'}});
  if (!found) return assert.fail('expected Agent settings route');
  assert.deepEqual(routeDetail(found.route), {kind: 'agent-settings'});
  assert.deepEqual(routeBack(found.route), {kind: 'list', view: 'agents'});
});

test('search direct into group-local settings keeps its group as the parent', () => {
  const found = routeFromSearch({page: 'collaboration', selection: {kind: 'membership', id: memberId}, detail: {kind: 'membership-settings'}}, snapshot);
  assert.deepEqual(found?.route, {kind: 'membership', id: memberId, pane: {kind: 'settings'}, parent: {kind: 'group', id: groupId}});
  assert.deepEqual(routeBack(found!.route), {kind: 'group', id: groupId});
});

test('missing membership search returns a clear group list fallback', () => {
  const missing = routeFromSearch({page: 'collaboration', selection: {kind: 'membership', id: membershipIdSchema.parse('deleted')}}, snapshot);
  assert.deepEqual(missing?.route, {kind: 'list', view: 'groups'});
  assert.match(missing?.missing ?? '', /不存在/);
});

test('binding opens the matching Bot in the group once its snapshot arrives', () => {
  const target = {agentId: anotherAgentId, chatId: groupId};
  assert.equal(joinedGroupRoute({...snapshot, memberships: []}, target), undefined);
  assert.equal(joinedGroupRoute({...snapshot, groups: []}, target), undefined);
  assert.deepEqual(joinedGroupRoute(snapshot, target), {
    kind: 'membership', id: anotherMemberId, pane: {kind: 'settings'}, parent: {kind: 'group', id: groupId},
  });
});

test('a binding no project owns yet opens from the project list, and a project search lands on its page', () => {
  const unlinked: DesktopSnapshot = {...snapshot, projects: [], memberships: snapshot.memberships.map(({projectId: _drop, ...member}) => member)};
  const opened = openMembership({kind: 'list', view: 'projects'}, memberId, unlinked);
  assert.deepEqual(opened, {kind: 'membership', id: memberId, pane: {kind: 'settings'}, parent: {kind: 'list', view: 'projects'}});
  assert.deepEqual(routeBack(opened), {kind: 'list', view: 'projects'});
  assert.equal(routeView(opened), 'projects');
  assert.deepEqual(routeFromSearch({page: 'collaboration', selection: {kind: 'project', id: projectId}}, snapshot)?.route, {kind: 'project', id: projectId, pane: {kind: 'map'}});
  const gone = routeFromSearch({page: 'collaboration', selection: {kind: 'project', id: projectId}}, unlinked);
  assert.deepEqual(gone?.route, {kind: 'list', view: 'projects'});
  assert.match(gone?.missing ?? '', /项目已不存在/);
});


test('same group with Bots in different projects keeps one group parent', () => {
  const otherProjectId = projectIdSchema.parse('prj_00000a0c');
  const data: DesktopSnapshot = {...snapshot, projects: [...snapshot.projects!, {...snapshot.projects![0]!, id: otherProjectId}], memberships: snapshot.memberships.map((member, index) => ({...member, projectId: index ? otherProjectId : projectId}))};
  const first = openMembership({kind: 'list', view: 'groups'}, memberId, data);
  const second = openMembership(first, anotherMemberId, data);
  assert.equal(routeView(first), 'groups');
  assert.deepEqual(routeBack(first), {kind: 'group', id: groupId});
  assert.deepEqual(routeBack(second), {kind: 'group', id: groupId});
});

test('different groups sharing a project preserve distinct group parents', () => {
  const otherGroupId = groupIdSchema.parse('oc_navigation_other');
  const data: DesktopSnapshot = {...snapshot, groups: [...snapshot.groups, {id: otherGroupId, name: '发布群'}], memberships: snapshot.memberships.map((member, index) => ({...member, groupId: index ? otherGroupId : groupId}))};
  const first = openMembership({kind: 'list', view: 'groups'}, memberId, data);
  const second = openMembership(first, anotherMemberId, data);
  assert.deepEqual(routeBack(first), {kind: 'group', id: groupId});
  assert.deepEqual(routeBack(second), {kind: 'group', id: otherGroupId});
});

test('old daemons without projects still support the group tree and group search route', () => {
  const data: DesktopSnapshot = {...snapshot, projects: undefined, memberships: snapshot.memberships.map(({projectId: _drop, ...member}) => member)};
  const opened = openMembership({kind: 'list', view: 'groups'}, memberId, data);
  assert.deepEqual(routeBack(opened), {kind: 'group', id: groupId});
  assert.deepEqual(routeFromSearch({page: 'collaboration', selection: {kind: 'group', id: groupId}}, data)?.route, {kind: 'group', id: groupId});
});

test('the Bot page has four panes, 任务 after 记忆', () => {
  assert.deepEqual(agentPanes.map(pane => pane.label), ['聊天', '记忆', '任务', '设置']);
  assert.deepEqual(routeDetail({kind: 'agent', id: agentId, pane: {kind: 'schedule'}}), {kind: 'overview'});
});

// dm-agent 10 (D4). main 必败: there was no route to a private chat
test('the private chat sits under its Bot: its page, its 模型与权限 tab first, and back to where it was opened from', () => {
  const opened = openDm(agentId);
  assert.deepEqual(opened, {kind: 'dm', agentId, tab: 'model'});
  assert.equal(routeView(opened), 'agents');
  assert.deepEqual(routeSelection(opened), {kind: 'agent', id: agentId});
  assert.deepEqual(routeDetail(opened), {kind: 'overview'});
  assert.deepEqual(routeBack(opened), {kind: 'agent', id: agentId, pane: {kind: 'groups'}});
  assert.deepEqual(routeBack(openDm(agentId, 'schedule', {kind: 'schedule'})), {kind: 'agent', id: agentId, pane: {kind: 'schedule'}});
  // a group opened from the private chat's page goes back to the Bot, the private chat being no group's parent
  const member = openMembership(opened, memberId, snapshot);
  assert.deepEqual(member, {kind: 'membership', id: memberId, pane: {kind: 'settings'}, parent: {kind: 'agent', id: agentId, pane: {kind: 'groups'}}});
});
