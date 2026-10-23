import type {AgentId, DesktopSnapshot, MembershipId, ProjectId} from '@vonvon/protocol';
import type {CollaborationView} from './collaboration-model';
import type {GroupSettingsTab} from './settings/GroupDesignSettings';
import type {Destination, DetailPane, Selection} from './search';

export type AgentPane = {kind: 'groups'} | {kind: 'profile'} | {kind: 'settings'};
/** 导图, 工作区 and 模型看到什么 are the project's own; `group` is the one binding's settings when a project has only one (§5.3). */
export type ProjectPane = {kind: 'map'} | {kind: 'workspace'} | {kind: 'context'} | {kind: 'group'; tab: GroupSettingsTab};
export type MembershipPane = {kind: 'activity'} | {kind: 'settings'};
/** `list` is where a binding no project owns yet (bound since the last daemon start, or from an older daemon) is opened from. */
export type MembershipParent = {kind: 'agent'; id: AgentId; pane: AgentPane} | {kind: 'project'; id: ProjectId; pane: ProjectPane} | {kind: 'list'; view: 'projects'};
export type CollaborationRoute =
  | {kind: 'list'; view: CollaborationView}
  | {kind: 'agent'; id: AgentId; pane: AgentPane}
  | {kind: 'project'; id: ProjectId; pane: ProjectPane}
  | {kind: 'membership'; id: MembershipId; pane: MembershipPane; parent: MembershipParent};

export const initialRoute: CollaborationRoute = {kind: 'list', view: 'agents'};

export function routeView(route: CollaborationRoute): CollaborationView {
  if (route.kind === 'list') return route.view;
  if (route.kind === 'membership') return route.parent.kind === 'agent' ? 'agents' : 'projects';
  return route.kind === 'agent' ? 'agents' : 'projects';
}

export function routeSelection(route: CollaborationRoute): Selection {
  switch (route.kind) {
    case 'list': return {kind: 'overview'};
    case 'agent': return {kind: 'agent', id: route.id};
    case 'project': return {kind: 'project', id: route.id};
    case 'membership': return {kind: 'membership', id: route.id};
  }
}

export function routeDetail(route: CollaborationRoute): DetailPane {
  if (route.kind === 'agent' && route.pane.kind === 'settings') return {kind: 'agent-settings'};
  if (route.kind === 'membership' && route.pane.kind === 'settings') return {kind: 'membership-settings'};
  return {kind: 'overview'};
}

/** The project a binding belongs to, when the snapshot has it. */
export function membershipProject(snapshot: DesktopSnapshot, id: MembershipId): ProjectId | undefined {
  const projectId = snapshot.memberships.find(item => item.id === id)?.projectId;
  return projectId && snapshot.projects?.some(project => project.id === projectId) ? projectId : undefined;
}

export function openMembership(route: CollaborationRoute, id: MembershipId, snapshot: DesktopSnapshot): CollaborationRoute {
  const member = snapshot.memberships.find(item => item.id === id);
  if (!member) return route;
  const projectId = membershipProject(snapshot, id);
  const sameProject = (parent: MembershipParent) => parent.kind === 'project' && parent.id === projectId;
  const parent: MembershipParent = route.kind === 'agent' && route.id === member.agentId
    ? {kind: 'agent', id: route.id, pane: route.pane}
    : route.kind === 'project' && route.id === projectId
      ? {kind: 'project', id: route.id, pane: route.pane}
      : route.kind === 'membership' && (route.parent.kind === 'agent' ? route.parent.id === member.agentId : sameProject(route.parent))
        ? route.parent
        : routeView(route) === 'agents'
          ? {kind: 'agent', id: member.agentId, pane: {kind: 'groups'}}
          : projectId ? {kind: 'project', id: projectId, pane: {kind: 'map'}} : {kind: 'list', view: 'projects'};
  return {kind: 'membership', id, pane: {kind: 'settings'}, parent};
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
    if (!snapshot.agents.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'agents'}, missing: '这个 Bot 已不存在，已返回 Bot 列表。'};
    return {route: {kind: 'agent', id: selection.id, pane: destination.reveal === 'agent-profile' ? {kind:'profile'} : destination.detail?.kind === 'agent-settings' ? {kind: 'settings'} : {kind: 'groups'}}};
  }
  if (selection.kind === 'project') {
    if (!snapshot.projects?.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'projects'}, missing: '这个项目已不存在，已返回项目列表。'};
    return {route: {kind: 'project', id: selection.id, pane: destination.section === '工作区' ? {kind: 'workspace'} : {kind: 'map'}}};
  }
  const member = snapshot.memberships.find(item => item.id === selection.id);
  if (!member) return {route: {kind: 'list', view: 'projects'}, missing: '这条群内协作已不存在，已返回项目列表。'};
  if (!snapshot.groups.some(item => item.id === member.groupId)) return {route: {kind: 'list', view: 'projects'}, missing: '这条群内协作的飞书群已不存在，已返回项目列表。'};
  const projectId = membershipProject(snapshot, member.id);
  const parent: MembershipParent = projectId ? {kind: 'project', id: projectId, pane: {kind: 'map'}} : {kind: 'list', view: 'projects'};
  return {route: {kind: 'membership', id: member.id, parent, pane: destination.detail?.kind === 'membership-settings' ? {kind: 'settings'} : {kind: 'activity'}}};
}

/** A create/bind reply may arrive before the next snapshot contains its membership. */
export function joinedGroupRoute(snapshot: DesktopSnapshot, target: {agentId: AgentId; chatId: string}): CollaborationRoute | undefined {
  const member = snapshot.memberships.find(item => item.agentId === target.agentId && item.groupId === target.chatId);
  if (!member || !snapshot.groups.some(group => group.id === member.groupId)) return undefined;
  const projectId = membershipProject(snapshot, member.id);
  return openMembership(projectId ? {kind: 'project', id: projectId, pane: {kind: 'map'}} : {kind: 'list', view: 'projects'}, member.id, snapshot);
}
