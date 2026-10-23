import { agentIdSchema, groupIdSchema, membershipIdSchema, modeToConversation, type DesktopSnapshot, type Agent, type Membership, type Group } from '@vonvon/protocol';
import type { AdminState } from './state';

// Ported from desktop/main/projection.ts at fab5237.
export function projectState(state: AdminState, previous: DesktopSnapshot, pending: ReadonlySet<string>) {
  const agents: Agent[] = [];
  const memberships: Membership[] = [];
  for (const bot of state.bots) {
    const agentId = agentIdSchema.parse(bot.appId);
    const duplicate = new Set(bot.projects.map(project => project.chatId)).size !== bot.projects.length;
    const readError = ('projectsError' in bot ? bot.projectsError : undefined) ?? (duplicate ? '同一个 Bot 存在冲突的群绑定，请在内核中修复。' : undefined);
    agents.push({ id: agentId, name: bot.botName || bot.name, ...(bot.avatarDataUrl ? { avatarDataUrl: bot.avatarDataUrl } : {}), enabled: bot.active, running: bot.running, connection: bot.connection ?? (bot.running ? 'unknown' : 'disconnected'), activation: pending.has(bot.appId) || bot.active !== bot.running ? 'restartRequired' : 'active', ...(readError ? { readError } : {}) });
    if (readError) {
      memberships.push(...previous.memberships.filter(member => member.agentId === bot.appId).map(member => ({ ...member, stale: true })));
      continue;
    }
    // A 智能 group's `response` is always mention and means nothing: it has no 免@ (s25c).
    for (const project of bot.projects) memberships.push({ id: membershipIdSchema.parse(JSON.stringify([bot.appId, project.chatId])), agentId, groupId: groupIdSchema.parse(project.chatId), name: project.name, ...(project.avatarDataUrl ? { avatarDataUrl: project.avatarDataUrl } : {}), directory: project.cwd, ...(project.directoryProblem ? { directoryProblem: project.directoryProblem } : {}), backend: project.backend, ...(project.enabled === undefined ? {} : { enabled: project.enabled }), conversation: modeToConversation(project.kind), response: project.noMention ? 'all' : 'mention', permission: { administrator: project.mode, member: project.mode, network: project.network }, stale: false });
  }
  const groups = new Map<string, Group>();
  for (const member of memberships) {
    const avatarDataUrl = member.avatarDataUrl ?? groups.get(member.groupId)?.avatarDataUrl;
    groups.set(member.groupId, { id: member.groupId, name: member.name, ...(avatarDataUrl ? { avatarDataUrl } : {}) });
  }
  return { agents, memberships, groups: [...groups.values()], stale: agents.some(agent => !!agent.readError) };
}
