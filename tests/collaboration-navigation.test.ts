import assert from 'node:assert/strict';
import test from 'node:test';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type DesktopSnapshot} from '../desktop/shared/bridge';
import {openMembership, routeBack, routeDetail, routeFromSearch, routeSelection, routeView, type CollaborationRoute} from '../desktop/renderer/collaboration-navigation';

const agentId = agentIdSchema.parse('cli_navigationA');
const anotherAgentId = agentIdSchema.parse('cli_navigationB');
const groupId = groupIdSchema.parse('oc_navigation');
const memberId = membershipIdSchema.parse('navigationA');
const anotherMemberId = membershipIdSchema.parse('navigationB');
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: Date.now(), stale: false,
  host: {kind: 'connected', ownership: 'owned', version: '0.7.0'},
  agents: [agentId, anotherAgentId].map((id, index) => ({id, name: `Agent ${index}`, enabled: true, running: true, connection: 'connected' as const, activation: 'active' as const})),
  groups: [{id: groupId, name: '研发群'}],
  memberships: [memberId, anotherMemberId].map((id, index) => ({id, agentId: index ? anotherAgentId : agentId, groupId, name: `项目 ${index}`, directory: '/tmp/research', backend: 'codex-appserver', conversation: 'threads' as const, response: 'mention' as const, permission: {administrator: 'full' as const, member: 'qa' as const, network: false}, stale: false})),
  tools: [], jobs: [], diagnostics: [],
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

test('group → each Agent collaboration → back restores the group', () => {
  const group: CollaborationRoute = {kind: 'group', id: groupId};
  const first = openMembership(group, memberId, snapshot);
  const second = openMembership(group, anotherMemberId, snapshot);
  assert.notDeepEqual(routeSelection(first), routeSelection(second));
  assert.equal(routeView(first), 'groups');
  assert.deepEqual(routeBack(first), group);
  assert.deepEqual(routeBack(second), group);
});

test('Agent settings use one pane and return to the Agent list', () => {
  const destination = {page: 'collaboration' as const, selection: {kind: 'agent' as const, id: agentId}, detail: {kind: 'agent-settings' as const}};
  const found = routeFromSearch(destination, snapshot);
  assert.deepEqual(found?.route, {kind: 'agent', id: agentId, pane: {kind: 'settings'}});
  if (!found) return assert.fail('expected Agent settings route');
  assert.deepEqual(routeDetail(found.route), {kind: 'agent-settings'});
  assert.deepEqual(routeBack(found.route), {kind: 'list', view: 'agents'});
});

test('search direct into group-local settings uses the group as its canonical parent', () => {
  const found = routeFromSearch({page: 'collaboration', selection: {kind: 'membership', id: memberId}, detail: {kind: 'membership-settings'}}, snapshot);
  assert.deepEqual(found?.route, {kind: 'membership', id: memberId, pane: {kind: 'settings'}, parent: {kind: 'group', id: groupId}});
  assert.deepEqual(routeBack(found!.route), {kind: 'group', id: groupId});
});

test('missing membership search returns a clear group list fallback', () => {
  const missing = routeFromSearch({page: 'collaboration', selection: {kind: 'membership', id: membershipIdSchema.parse('deleted')}}, snapshot);
  assert.deepEqual(missing?.route, {kind: 'list', view: 'groups'});
  assert.match(missing?.missing ?? '', /不存在/);
});
