import type {AgentId, DesktopSnapshot, GroupId, MembershipId, ProjectId} from '@vonvon/protocol';
import type {CollaborationView} from './collaboration-model';
import type {GroupDesignTab} from './GroupWorkspace';
import type {GroupSettingsTab} from './settings/GroupDesignSettings';
import type {Destination, DetailPane, Selection} from './search';

export type AgentPane = {kind: 'groups'} | {kind: 'profile'} | {kind: 'schedule'} | {kind: 'settings'};
/** The Bot page's tabs in order; 任务 lists every group's tasks of the Bot and a row opens that group's 任务 tab. */
export const agentPanes: readonly {kind: AgentPane['kind']; label: string}[] = [{kind: 'groups', label: '聊天'}, {kind: 'profile', label: '记忆'}, {kind: 'schedule', label: '任务'}, {kind: 'settings', label: '设置'}];
/** Project memory and workspace remain reachable as secondary destinations. */
export type ProjectPane = {kind: 'map'} | {kind: 'workspace'} | {kind: 'context'} | {kind: 'group'; tab: GroupSettingsTab};
export type MembershipPane = {kind: 'activity'} | {kind: 'settings'};
/** `list` is where a binding no project owns yet (bound since the last daemon start, or from an older daemon) is opened from. */
export type MembershipParent = {kind: 'agent'; id: AgentId; pane: AgentPane} | {kind: 'group'; id: GroupId} | {kind: 'project'; id: ProjectId; pane: ProjectPane} | {kind: 'list'; view: 'projects'};
export type CollaborationRoute =
  | {kind: 'list'; view: CollaborationView}
  | {kind: 'agent'; id: AgentId; pane: AgentPane}
  | {kind: 'group'; id: GroupId}
  | {kind: 'project'; id: ProjectId; pane: ProjectPane; from?: {route: CollaborationRoute; label: string}}
  | {kind: 'membership'; id: MembershipId; pane: MembershipPane; parent: MembershipParent}
  /** A Bot's private chat: the same workspace as a group, with no group behind it. `from`: the Bot page's tab it was opened from. */
  | {kind: 'dm'; agentId: AgentId; tab: GroupDesignTab; from?: AgentPane};

export const initialRoute: CollaborationRoute = {kind: 'list', view: 'agents'};

export function routeView(route: CollaborationRoute): CollaborationView {
  if (route.kind === 'list') return route.view;
  if (route.kind === 'membership') return routeView(route.parent);
  return route.kind === 'agent' || route.kind === 'dm' ? 'agents' : route.kind === 'group' ? 'groups' : 'projects';
}

export function routeSelection(route: CollaborationRoute): Selection {
  switch (route.kind) {
    case 'list': return {kind: 'overview'};
    case 'agent': return {kind: 'agent', id: route.id};
    case 'group': return {kind: 'group', id: route.id};
    case 'project': return {kind: 'project', id: route.id};
    case 'membership': return {kind: 'membership', id: route.id};
    case 'dm': return {kind: 'agent', id: route.agentId};
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
  const matches = (parent: MembershipParent) => parent.kind === 'agent' ? parent.id === member.agentId
    : parent.kind === 'group' ? parent.id === member.groupId
    : parent.kind === 'project' ? parent.id === projectId : false;
  const parent: MembershipParent = route.kind !== 'membership' && route.kind !== 'list' && route.kind !== 'dm' && matches(route)
    ? route
    : route.kind === 'membership' && matches(route.parent)
      ? route.parent
      : routeView(route) === 'agents'
        ? {kind: 'agent', id: member.agentId, pane: {kind: 'groups'}}
        : routeView(route) === 'projects'
          ? projectId ? {kind: 'project', id: projectId, pane: {kind: 'map'}} : {kind: 'list', view: 'projects'}
          : {kind: 'group', id: member.groupId};
  return {kind: 'membership', id, pane: {kind: 'settings'}, parent};
}

/** A row of the Bot page's 任务 pane opens its group page on the 任务 tab; other group pages keep theirs. */
export function openScheduleTab(tabs: Readonly<Record<string, GroupDesignTab>>, id: MembershipId): Record<string, GroupDesignTab> {
  return {...tabs, [id]: 'schedule'};
}

/** The private chat's page, on `tab`; back goes to the Bot page's `from`, its 群聊 tab unless given. */
export function openDm(agentId: AgentId, tab: GroupDesignTab = 'model', from?: AgentPane): CollaborationRoute {
  return {kind: 'dm', agentId, tab, ...(from ? {from} : {})};
}

export function routeBack(route: CollaborationRoute): CollaborationRoute {
  if (route.kind === 'membership') return route.parent;
  if (route.kind === 'dm') return {kind: 'agent', id: route.agentId, pane: route.from ?? {kind: 'groups'}};
  if (route.kind === 'project' && route.from) return route.from.route;
  if (route.kind === 'list') return route;
  return {kind: 'list', view: routeView(route)};
}

export function routeFromSearch(destination: Destination, snapshot: DesktopSnapshot): {route: CollaborationRoute; missing?: string} | undefined {
  if (destination.page !== 'collaboration') return undefined;
  const selection = destination.selection;
  if (!selection || selection.kind === 'overview') return {route: {kind: 'list', view: destination.view ?? 'agents'}};
  if (selection.kind === 'agent') {
    const agent = snapshot.agents.find(item => item.id === selection.id);
    if (!agent) return {route: {kind: 'list', view: 'agents'}, missing: '这个 Bot 已不存在，已返回 Bot 列表。'};
    if (destination.reveal === 'dm-response') return agent.dm ? {route:openDm(agent.id,'response')} : {route:{kind:'agent',id:agent.id,pane:{kind:'groups'}},missing:'这个 Bot 的私聊设置暂不可用，已返回聊天列表。'};
    return {route: {kind: 'agent', id: selection.id, pane: destination.reveal === 'agent-profile' ? {kind:'profile'} : destination.detail?.kind === 'agent-settings' ? {kind: 'settings'} : {kind: 'groups'}}};
  }
  if (selection.kind === 'group') {
    if (!snapshot.groups.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'groups'}, missing: '这个飞书群已不存在，已返回群组列表。'};
    return {route: {kind: 'group', id: selection.id}};
  }
  if (selection.kind === 'project') {
    if (!snapshot.projects?.some(item => item.id === selection.id)) return {route: {kind: 'list', view: 'projects'}, missing: '这个项目已不存在，已返回项目列表。'};
    return {route: {kind: 'project', id: selection.id, pane: destination.section === '工作区' ? {kind: 'workspace'} : {kind: 'map'}}};
  }
  const member = snapshot.memberships.find(item => item.id === selection.id);
  if (!member) return {route: {kind: 'list', view: 'groups'}, missing: '这条群内协作已不存在，已返回群组列表。'};
  if (!snapshot.groups.some(item => item.id === member.groupId)) return {route: {kind: 'list', view: 'groups'}, missing: '这条群内协作的飞书群已不存在，已返回群组列表。'};
  const parent: MembershipParent = {kind: 'group', id: member.groupId};
  return {route: {kind: 'membership', id: member.id, parent, pane: destination.detail?.kind === 'membership-settings' ? {kind: 'settings'} : {kind: 'activity'}}};
}

/** A create/bind reply may arrive before the next snapshot contains its membership. */
export function joinedGroupRoute(snapshot: DesktopSnapshot, target: {agentId: AgentId; chatId: string}): CollaborationRoute | undefined {
  const member = snapshot.memberships.find(item => item.agentId === target.agentId && item.groupId === target.chatId);
  if (!member || !snapshot.groups.some(group => group.id === member.groupId)) return undefined;
  return openMembership({kind: 'group', id: member.groupId}, member.id, snapshot);
}
