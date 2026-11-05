import type { DesktopSnapshot, Scope } from '@vonvon/protocol';
import type { Principal } from './principal';

export type BotSessionPrincipal = Extract<Principal, { kind: 'bot-session' }>;

/**
 * Which of its bot's groups a reach takes in (devices 5.3): a group session only its own, a comment none, and the owner
 * within a `--scope` (scopedOwner) all of them narrowed by `group=`. A group session without a chat reaches none.
 * A private chat's session is not narrowed at all (dm-agent 6.1).
 */
export function sessionGroups(principal: BotSessionPrincipal, scope: Scope | null): (groupId: string) => boolean {
  if (principal.place === 'comment') return () => false;
  if (principal.place === 'group') return groupId => principal.chatId !== undefined && groupId === principal.chatId;
  const only = scope?.group;
  return groupId => only === undefined || groupId === only;
}

/**
 * The reach an owner's `--scope` stands for (devices 5.3): its bot, and its one group if it names one, as a session of
 * that bot in that group (or a private chat of it) would reach. No session stands behind it: the place rules do not apply.
 */
export function scopedOwner(scope: Scope): BotSessionPrincipal {
  return { kind: 'bot-session', sessionId: '', appId: scope.bot, ...(scope.group === undefined ? { place: 'dm' as const } : { place: 'group' as const, chatId: scope.group }) };
}

/**
 * devices-4a 4.7: what the owner within a `--scope` sees of the daemon's state: its bot and the groups it reaches, none
 * of the diagnostics; the host, platform and version as they are.
 */
export function filterSnapshot(snapshot: DesktopSnapshot, principal: BotSessionPrincipal, scope: Scope | null): DesktopSnapshot {
  const { appId } = principal;
  const reaches = sessionGroups(principal, scope);
  const memberships = snapshot.memberships.filter(membership => membership.agentId === appId && reaches(membership.groupId));
  const groupIds = new Set<string>(memberships.map(membership => membership.groupId));
  const { crashes: _crashes, ...application } = snapshot.application;
  const { projects, recentConversations, ...rest } = snapshot;
  return {
    ...rest,
    // A scope narrowed to one group does not reach the Bot's private chat.
    agents: snapshot.agents.filter(agent => agent.id === appId).map(({ diagnostics: _diagnostics, dm, ...agent }) => ({ ...agent, ...(dm && scope?.group === undefined ? { dm } : {}) })),
    groups: snapshot.groups.filter(group => groupIds.has(group.id)),
    memberships,
    ...(projects ? { projects: projects
      .map(project => ({ ...project, bindings: project.bindings.filter(binding => binding.agentId === appId && groupIds.has(binding.groupId)) }))
      .filter(project => project.bindings.length > 0) } : {}),
    jobs: snapshot.jobs.filter(job => 'agentId' in job && job.agentId === appId),
    ...(recentConversations ? { recentConversations: { items: recentConversations.items.filter(item => item.agentId === appId && groupIds.has(item.groupId)), unavailableBots: 0 } } : {}),
    application,
  };
}

/** What a Bot session reads of the daemon's state: a private chat's every Bot, a group's and a comment's far less. */
export function sessionSnapshot(snapshot: DesktopSnapshot, principal: BotSessionPrincipal): DesktopSnapshot {
  return principal.place === 'dm' ? dmSnapshot(snapshot) : placeSnapshot(snapshot, principal);
}

/** dm-agent 6.1: a private chat reaches every Bot of this computer, so all of it but the crash reports and the diagnostics. The desktop badge labels the Feishu app owner; that person's name stays out of a session's reads. */
function dmSnapshot(snapshot: DesktopSnapshot): DesktopSnapshot {
  const { crashes: _crashes, ...application } = snapshot.application;
  return { ...snapshot, agents: snapshot.agents.map(({ diagnostics: _diagnostics, ownerName: _ownerName, ...agent }) => agent), application };
}

/**
 * s1b: what a group's (or a comment's) session reads of the daemon's state, the least its command line resolves names
 * with. Its bot's id and name, its group's id and name, and the group's project (id and name) for `--group <项目名>` and
 * `memory --project`; nothing of folders, permission tiers, models, other groups, tools, jobs or the machine's service.
 * The schema's required fields carry blanks where they would say more.
 */
function placeSnapshot(snapshot: DesktopSnapshot, principal: BotSessionPrincipal): DesktopSnapshot {
  const { appId } = principal;
  const chatId = principal.place === 'group' ? principal.chatId : undefined;
  const bound = chatId !== undefined && snapshot.memberships.some(membership => membership.agentId === appId && membership.groupId === chatId);
  const host = snapshot.host.kind === 'blocked' || snapshot.host.kind === 'disconnected' ? { kind: snapshot.host.kind, message: '' } : snapshot.host;
  const { platform, version } = snapshot.application;
  return {
    revision: snapshot.revision, observedAt: snapshot.observedAt, stale: snapshot.stale, host,
    agents: snapshot.agents.filter(agent => agent.id === appId)
      .map(({ id, name, enabled, running, activation }) => ({ id, name, enabled, running, connection: '', activation })),
    groups: bound ? snapshot.groups.filter(group => group.id === chatId).map(({ id, name }) => ({ id, name })) : [],
    memberships: [],
    ...(snapshot.projects ? { projects: bound ? snapshot.projects
      .filter(project => project.bindings.some(binding => binding.agentId === appId && binding.groupId === chatId))
      .map(({ id, name, revision, bindings }) => ({ id, name, revision, directory: '', bindings: bindings.filter(binding => binding.agentId === appId && binding.groupId === chatId) })) : [] } : {}),
    tools: [], jobs: [],
    application: { platform, version, loginItem: false, dataPath: '' },
  };
}
