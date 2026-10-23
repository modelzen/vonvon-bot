import type {AgentId, DesktopSnapshot, GroupId, LibraryProject, Membership, MembershipId, ProjectId, SnapshotProject} from '@vonvon/protocol';

const groupName = (snapshot: DesktopSnapshot, groupId: GroupId, fallback: string) => snapshot.groups.find(group => group.id === groupId)?.name ?? fallback;
const botName = (snapshot: DesktopSnapshot, agentId: AgentId) => snapshot.agents.find(agent => agent.id === agentId)?.name ?? agentId;

export type BindingRow = {
  agentId: AgentId; groupId: GroupId; group: string; bot: string;
  /** The binding's membership in the snapshot; none = the daemon lists the row but the Bot's side cannot be read (失效). */
  member?: Membership;
  state: 'ok' | 'invalid' | 'disabled';
};
/** The groups and Bots a project's 导图 tab lists: the library's bindings when it has them, else the snapshot's. */
export function bindingRows(snapshot: DesktopSnapshot, project: SnapshotProject, library?: LibraryProject): BindingRow[] {
  const bindings: Array<{agentId: AgentId; groupId: GroupId; name: string; enabled: boolean}> = library
    ? library.bindings.map(binding => ({...binding}))
    : project.bindings.map(binding => ({...binding, name: '', enabled: true}));
  return bindings.map(binding => {
    const member = snapshot.memberships.find(item => item.agentId === binding.agentId && item.groupId === binding.groupId);
    const live = member !== undefined && !member.stale;
    return {
      agentId: binding.agentId, groupId: binding.groupId, group: groupName(snapshot, binding.groupId, binding.name || binding.groupId), bot: botName(snapshot, binding.agentId),
      ...(member ? {member} : {}), state: !live ? 'invalid' : binding.enabled === false || member.enabled === false ? 'disabled' : 'ok',
    };
  });
}

export type Notice = {memberId: MembershipId; group: string; bot: string; project: string};
/** Another Bot in one of this project's groups that works in a different project: its memory and folder do not reach here. */
export function otherProjectNotices(snapshot: DesktopSnapshot, project: SnapshotProject): Notice[] {
  const groups = new Set(project.bindings.map(binding => binding.groupId as string));
  return snapshot.memberships.flatMap(member => {
    if (!groups.has(member.groupId) || !member.projectId || member.projectId === project.id) return [];
    const other = snapshot.projects?.find(item => item.id === member.projectId);
    return other ? [{memberId: member.id, group: groupName(snapshot, member.groupId, member.name), bot: botName(snapshot, member.agentId), project: other.name}] : [];
  });
}

export type Risk = {memberId: MembershipId; label: string};
/**
 * Who can write in a project's workspace (§5.3, D8). The mode is the daemon's `effectMode`, what the group really runs
 * in: never the stored `permission` tier, which a custom permission or s31d's native settings can leave wider than the
 * effect. A binding the daemon sent no `effectMode` for (an older daemon) is not guessed at and raises nothing.
 */
export function workspaceRisks(snapshot: DesktopSnapshot, project: SnapshotProject): {writable: Risk[]; full: Risk[]; shared: boolean} {
  const members = project.bindings.flatMap(binding => snapshot.memberships.find(item => item.agentId === binding.agentId && item.groupId === binding.groupId && !item.stale) ?? []);
  const risk = (member: Membership): Risk => ({memberId: member.id, label: `${groupName(snapshot, member.groupId, member.name)} · ${botName(snapshot, member.agentId)}`});
  const writable = members.filter(member => member.effectMode === 'write' || member.effectMode === 'full').map(risk);
  const full = members.filter(member => member.effectMode === 'full').map(risk);
  return {writable, full, shared: project.bindings.length > 1};
}

/** A project with no group and no Bot can be deleted; anything else is unbound or switched first. */
export const projectDeletable = (project: SnapshotProject): boolean => project.bindings.length === 0;

export type ProjectChoice = {kind: 'new'} | {kind: 'join'; id: ProjectId; reason: 'sibling' | 'previous' | 'picked'};
/**
 * What the 建群/加群 dialog's 项目 row starts on (§5.6): the project another Bot of this group already works in, else the
 * one this group was bound to before, else a new one. `previous` is what the daemon remembers for this Bot and group.
 */
export function defaultProjectChoice(snapshot: DesktopSnapshot, groupId: string | undefined, previous?: ProjectId): ProjectChoice {
  const sibling = groupId ? snapshot.memberships.find(member => member.groupId === groupId && member.projectId && snapshot.projects?.some(project => project.id === member.projectId)) : undefined;
  if (sibling?.projectId) return {kind: 'join', id: sibling.projectId, reason: 'sibling'};
  if (previous && snapshot.projects?.some(project => project.id === previous)) return {kind: 'join', id: previous, reason: 'previous'};
  return {kind: 'new'};
}

/** Joining a project another group uses lets the two groups' people see each other's project through the Bots (§5.6). */
export function crossGroupWarning(project: SnapshotProject | undefined, groupId: string | undefined): string | undefined {
  if (!project || !project.bindings.some(binding => binding.groupId !== groupId)) return undefined;
  const others = new Set(project.bindings.filter(binding => binding.groupId !== groupId).map(binding => binding.groupId)).size;
  return `加入后，这个项目现有的 ${others} 个群和这个群的人会通过 Bot 互相间接看到：项目记忆、工作区文件和可恢复的会话历史；以后新增的也一样。`;
}

/** What 移除本地 Bot asks the owner to confirm: what goes (counted) and what stays with the projects (§5.2). */
export function deleteAgentDescription(name: string, bindings: number, memories: number | undefined): string {
  const counted = [`${bindings} 个群绑定`, ...(memories === undefined ? [] : [`${memories} 条 Bot 记忆`])].join('、');
  return `将移除「${name}」的本地注册信息、凭据、${counted}、设置和会话记录。项目的记忆和工作区属于项目，不会删。飞书开发者平台中的应用不会删除。请确认这个 Bot 已停用并停止运行。`;
}
