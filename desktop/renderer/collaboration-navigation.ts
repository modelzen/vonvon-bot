import type {AgentId, DesktopSnapshot, GroupId, MembershipId} from '../shared/bridge';
import type {CollaborationView} from './collaboration-model';
import type {Destination, DetailPane, MembershipCategory, Selection} from './search';

export type AgentPane = {kind: 'groups'} | {kind: 'settings'};
export type MembershipPane = {kind: 'activity'} | {kind: 'settings'; category: MembershipCategory};
export type CollaborationRoute =
  | {kind: 'list'; view: CollaborationView}
  | {kind: 'agent'; id: AgentId; pane: AgentPane}
  | {kind: 'group'; id: GroupId}
  | {kind: 'membership'; id: MembershipId; pane: MembershipPane; parent: {kind: 'agent'; id: AgentId; pane: AgentPane} | {kind: 'group'; id: GroupId}};

export const initialRoute: CollaborationRoute = {kind: 'list', view: 'agents'};

export function routeView(route: CollaborationRoute): CollaborationView {
  if (route.kind === 'list') return route.view;
  if (route.kind === 'membership') return route.parent.kind === 'agent' ? 'agents' : 'groups';
  return route.kind === 'agent' ? 'agents' : 'groups';
}

export function routeSelection(route: CollaborationRoute): Selection {
  switch (route.kind) {
    case 'list': return {kind: 'overview'};
    case 'agent': return {kind: 'agent', id: route.id};
    case 'group': return {kind: 'group', id: route.id};
    case 'membership': return {kind: 'membership', id: route.id};
  }
}

export function routeDetail(route: CollaborationRoute): DetailPane {
  if (route.kind === 'agent' && route.pane.kind === 'settings') return {kind: 'agent-settings'};
  if (route.kind === 'membership' && route.pane.kind === 'settings') return {kind: 'membership-settings', category: route.pane.category};
  return {kind: 'overview'};
}

export function openMembership(route: CollaborationRoute, id: MembershipId, snapshot: DesktopSnapshot): CollaborationRoute {
  const member = snapshot.memberships.find(item => item.id === id);
  if (!member) return route;
  const parent = route.kind === 'agent' && route.id === member.agentId
    ? {kind: 'agent' as const, id: route.id, pane: route.pane}
    : route.kind === 'group' && route.id === member.groupId
      ? {kind: 'group' as const, id: route.id}
      : route.kind === 'membership' && (route.parent.kind === 'agent' ? route.parent.id === member.agentId : route.parent.id === member.groupId)
        ? route.parent
        : routeView(route) === 'agents'
          ? {kind: 'agent' as const, id: member.agentId, pane: {kind: 'groups' as const}}
          : {kind: 'group' as const, id: member.groupId};
  return {kind: 'membership', id, pane: {kind: 'activity'}, parent};
}

export function routeBack(route: CollaborationRoute): CollaborationRoute {
  if (route.kind === 'membership') return route.parent;
  if (route.kind === 'list') return route;
  return {kind: 'list', view: routeView(route)};
}

export function routeFromSearch(destination: Destination, snapshot: DesktopSnapshot): {route: CollaborationRoute; missing?: string} | undefined {
  if (destination.page !== 'collaboration') return undefined;
  const selection = destination.selection;
  if (!selection || selection.kind === 'overview') return {route: {kind: 'list', view: destination.view ?? 'agents'}};
  if (selection.kind === 'agent') {
    if (!snapshot.agents.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'agents'}, missing: '这个 Agent 已不存在，已返回 Agent 列表。'};
    return {route: {kind: 'agent', id: selection.id, pane: destination.detail?.kind === 'agent-settings' ? {kind: 'settings'} : {kind: 'groups'}}};
  }
  if (selection.kind === 'group') {
    if (!snapshot.groups.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'groups'}, missing: '这个飞书群已不存在，已返回群聊列表。'};
    return {route: {kind: 'group', id: selection.id}};
  }
  const member = snapshot.memberships.find(item => item.id === selection.id);
  if (!member) return {route: {kind: 'list', view: 'groups'}, missing: '这条群内协作已不存在，已返回群聊列表。'};
  const parent = snapshot.groups.some(item => item.id === member.groupId)
    ? {kind: 'group' as const, id: member.groupId}
    : undefined;
  if (!parent) return {route: {kind: 'list', view: 'groups'}, missing: '这条群内协作的飞书群已不存在，已返回群聊列表。'};
  return {route: {kind: 'membership', id: member.id, parent, pane: destination.detail?.kind === 'membership-settings' ? {kind: 'settings', category: destination.detail.category} : {kind: 'activity'}}};
}
