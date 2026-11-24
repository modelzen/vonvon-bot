import type {DesktopSnapshot, Membership, SnapshotProject} from '@vonvon/protocol';

export type WorkspaceDraft = {
  primary: string;
  additional: string[];
  repositories: string[];
};

export function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function sameWorkspaceDraft(a: WorkspaceDraft, b: WorkspaceDraft): boolean {
  return a.primary === b.primary
    && a.additional.length === b.additional.length
    && a.additional.every((item, index) => item === b.additional[index])
    && a.repositories.length === b.repositories.length
    && a.repositories.every((item, index) => item === b.repositories[index]);
}

/** Replace the main directory directly; if it was already in additional directories, remove the duplicate. */
export function replacePrimary(draft: WorkspaceDraft, nextPrimary: string): WorkspaceDraft {
  return {
    ...draft,
    primary: nextPrimary,
    additional: draft.additional.filter(path => path !== nextPrimary),
  };
}

/** Add an additional directory unless it already matches the main directory or an existing additional entry. */
export function addAdditionalDirectory(
  draft: WorkspaceDraft,
  path: string,
): {draft: WorkspaceDraft; duplicate?: 'primary' | 'additional'} {
  if (path === draft.primary) return {draft, duplicate: 'primary'};
  if (draft.additional.includes(path)) return {draft, duplicate: 'additional'};
  return {draft: {...draft, additional: [...draft.additional, path]}};
}

/** Promote an additional directory to primary, demoting the previous primary into additional directories. */
export function promoteAdditionalDirectory(draft: WorkspaceDraft, path: string): WorkspaceDraft {
  if (path === draft.primary) return draft;
  const additional = draft.additional
    .map(item => (item === path ? draft.primary : item))
    .filter((item, index, list) => item !== path && list.indexOf(item) === index);
  return {...draft, primary: path, additional};
}

export function removeAdditionalDirectory(draft: WorkspaceDraft, path: string): WorkspaceDraft {
  return {...draft, additional: draft.additional.filter(item => item !== path)};
}

export function removeLegacyRepository(draft: WorkspaceDraft, path: string): WorkspaceDraft {
  return {...draft, repositories: draft.repositories.filter(item => item !== path)};
}

export type SharedWorkspaceInfo = {
  shared: boolean;
  peerCount: number;
  groupCount: number;
  summary?: string;
};

/** Summarize other groups or Bots sharing the same underlying library project, without exposing "项目" to single-binding groups. */
export function sharedWorkspaceSummary(
  snapshot: DesktopSnapshot | undefined,
  project: SnapshotProject | undefined,
  member: Membership | undefined,
): SharedWorkspaceInfo {
  if (!snapshot || !project || !member) return {shared: false, peerCount: 0, groupCount: 1};
  const peers = project.bindings.filter(binding => !(binding.agentId === member.agentId && binding.groupId === member.groupId));
  const groupIds = new Set(project.bindings.map(binding => binding.groupId));
  const groupCount = Math.max(1, groupIds.size);
  if (!peers.length) return {shared: false, peerCount: 0, groupCount};
  const otherGroupIds = [...new Set(peers.filter(binding => binding.groupId !== member.groupId).map(binding => binding.groupId))];
  const sameGroupBotIds = [...new Set(peers.filter(binding => binding.groupId === member.groupId).map(binding => binding.agentId))];
  const groupName = (id: string) => snapshot.groups.find(group => group.id === id)?.name ?? '其他群';
  const botName = (id: string) => snapshot.agents.find(agent => agent.id === id)?.name ?? id;
  let summary: string;
  if (!otherGroupIds.length) {
    const first = botName(sameGroupBotIds[0]!);
    summary = sameGroupBotIds.length === 1 ? `与本群「${first}」共用` : `与本群「${first}」等 ${sameGroupBotIds.length} 个 Bot 共用`;
  } else {
    const first = groupName(otherGroupIds[0]!);
    summary = otherGroupIds.length === 1
      ? sameGroupBotIds.length > 0 ? `与「${first}」及本群其他 Bot 共用` : `与「${first}」共用`
      : `与「${first}」等 ${otherGroupIds.length} 个群共用`;
  }
  return {shared: true, peerCount: peers.length, groupCount, summary};
}

export function workspaceSummaryMeta(additionalCount: number, legacyRepoCount: number, sharedSummary?: string): string | undefined {
  const parts: string[] = [];
  if (additionalCount > 0) parts.push(`另含 ${additionalCount} 个其他目录`);
  if (legacyRepoCount > 0) parts.push(`另有 ${legacyRepoCount} 个代码仓库`);
  if (sharedSummary) parts.push(sharedSummary);
  return parts.length ? parts.join(' · ') : undefined;
}
