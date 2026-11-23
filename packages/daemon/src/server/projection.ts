import { agentIdSchema, groupIdSchema, membershipIdSchema, modeToConversation, projectIdSchema, type DesktopSnapshot, type Agent, type Membership, type Group, type SnapshotProject } from '@vonvon/protocol';
import { groupPermission } from '../config/execution';
import type { AdminProject } from '../admin/service';
import type { LibraryProject } from '../project/library';
import type { AdminState } from './state';

/** One project row as a client reads it: a group's binding, or the private chat beside them. */
function membershipOf(agentId: Agent['id'], project: AdminProject): Membership {
  return { id: membershipIdSchema.parse(JSON.stringify([agentId, project.chatId])), agentId, groupId: groupIdSchema.parse(project.chatId), name: project.name, directory: project.cwd, ...(project.bindingIncarnation && {bindingIncarnation:project.bindingIncarnation}), ...(projectIdSchema.safeParse(project.projectId).success ? { projectId: projectIdSchema.parse(project.projectId) } : {}), ...(project.directoryProblem ? { directoryProblem: project.directoryProblem } : {}), backend: project.backend, ...(project.enabled === undefined ? {} : { enabled: project.enabled }), conversation: modeToConversation(project.kind), effectMode: groupPermission(project).effect.mode, response: project.noMention ? 'all' : 'mention', permission: { administrator: project.mode, member: project.mode, network: project.network }, stale: false };
}

// Ported from desktop/main/projection.ts at fab5237.
export function projectState(state: AdminState, previous: DesktopSnapshot, pending: ReadonlySet<string>) {
  const agents: Agent[] = [];
  const memberships: Membership[] = [];
  /** A group's picture goes on the group once. A copy on each membership made a snapshot hundreds of KB larger, more than
   * a slow link to another device carried in time (0.9.0 Mac 验收 B-1). */
  const avatars = new Map<string, string>();
  for (const bot of state.bots) {
    const agentId = agentIdSchema.parse(bot.appId);
    const duplicate = new Set(bot.projects.map(project => project.chatId)).size !== bot.projects.length;
    const readError = ('projectsError' in bot ? bot.projectsError : undefined) ?? (duplicate ? '同一个 Bot 存在冲突的群绑定，请在内核中修复。' : undefined);
    // Private-chat failures do not invalidate healthy group bindings. Keep any previous DM only as stale.
    const previousDm = previous.agents.find(agent => agent.id === agentId)?.dm;
    const dmError = bot.dmError;
    const dm = dmError ? (previousDm && { ...previousDm, stale: true }) : bot.dm ? membershipOf(agentId, bot.dm) : readError ? (previousDm && { ...previousDm, stale: true }) : undefined;
    agents.push({
      id: agentId, name: bot.botName || bot.name,
      ...(bot.badgeNumber ? { badgeNumber: bot.badgeNumber } : {}),
      ...(bot.registrationId && {registrationId:bot.registrationId}),
      ...(bot.registeredAt !== undefined ? { registeredAt: bot.registeredAt } : {}),
      ...(bot.ownerName ? { ownerName: bot.ownerName } : {}),
      ...(bot.tenant ? { tenant: bot.tenant } : {}),
      ...(bot.avatarDataUrl ? { avatarDataUrl: bot.avatarDataUrl } : {}),
      enabled: bot.active, running: bot.running, connection: bot.connection ?? (bot.running ? 'unknown' : 'disconnected'),
      activation: pending.has(bot.appId) || bot.active !== bot.running ? 'restartRequired' : 'active',
      ...(readError ? { readError } : {}),
      ...(dm ? { dm } : {}),
      ...(dmError ? { dmError } : {}),
    });
    if (readError) {
      for (const member of previous.memberships.filter(member => member.agentId === bot.appId)) {
        memberships.push({ ...member, stale: true });
        const avatar = previous.groups.find(group => group.id === member.groupId)?.avatarDataUrl;
        if (avatar && !avatars.has(member.groupId)) avatars.set(member.groupId, avatar);
      }
      continue;
    }
    // AdminProject.mode/network already carry groupPermission's resolved effects.
    // A 智能 group's `response` is always mention and means nothing: it has no 免@ (s25c).
    for (const project of bot.projects) {
      if (project.avatarDataUrl) avatars.set(project.chatId, project.avatarDataUrl);
      memberships.push(membershipOf(agentId, project));
    }
  }
  const groups = new Map<string, Group>();
  for (const member of memberships) {
    const avatarDataUrl = avatars.get(member.groupId);
    groups.set(member.groupId, { id: member.groupId, name: member.name, ...(avatarDataUrl ? { avatarDataUrl } : {}) });
  }
  return { agents, memberships, groups: [...groups.values()], stale: agents.some(agent => !!agent.readError) };
}

/** The library's projects with the bindings the memberships name them for (memory design §2.5). */
export function projectLibrary(projects: readonly LibraryProject[], memberships: DesktopSnapshot['memberships']): SnapshotProject[] {
  return projects.map(project => ({
    id: projectIdSchema.parse(project.id), name: project.name, revision: project.revision, directory: project.workspace.primary,
    bindings: memberships.filter(member => member.projectId === project.id && !member.stale).map(member => ({ agentId: member.agentId, groupId: member.groupId })),
  }));
}
