import type {DesktopSnapshot, MemoryItem} from '@vonvon/protocol';

export type MigrationFacts = {
  /** Groups where two Bots now have two projects (D2). */
  splitGroups: number;
  /** Bots whose AGENTS.md was merged into 其他说明 and not yet noticed. */
  rolesMerged: number;
  /** Old shared memory entries waiting in Bot memory, archived (§7.1 step B4). */
  pendingShared: number;
  /** Old group memory entries in project memory (all under 背景). */
  background: number;
};

/** Groups with Bots in more than one project: what a migration of two Bots in one group leaves (§7.1). */
export function splitGroupCount(snapshot: Pick<DesktopSnapshot, 'projects'>): number {
  const byGroup = new Map<string, Set<string>>();
  for (const project of snapshot.projects ?? []) for (const binding of project.bindings) byGroup.set(binding.groupId, (byGroup.get(binding.groupId) ?? new Set()).add(project.id));
  return [...byGroup.values()].filter(projects => projects.size > 1).length;
}

const imported = (item: Pick<MemoryItem, 'source'>) => item.source.via === 'import';
/** Old shared entries a Bot memory holds archived, and old group entries a project memory holds. */
export const pendingSharedCount = (items: readonly MemoryItem[]) => items.filter(item => item.state === 'archived' && imported(item)).length;
export const backgroundCount = (items: readonly MemoryItem[]) => items.filter(item => imported(item) && item.branch === '背景').length;

/** The banner's lines (§5.7): only what happened to this installation; nothing at all when nothing did. */
export function migrationLines(facts: MigrationFacts): string[] {
  return [
    ...(facts.splitGroups ? [`同一个群里的两个 Bot 现在是两个项目，记忆和目录不通；要合并，在群设置页“换到别的项目”。（${facts.splitGroups} 个群）`] : []),
    ...(facts.rolesMerged ? ['角色设定现在总是带上；原来 AGENTS.md 里的内容并到了“其他说明”。'] : []),
    ...(facts.background ? [`旧的本群记忆（${facts.background} 条）都在项目记忆的“背景”分支，可以拖到合适的分支。`] : []),
    ...(facts.pendingShared ? [`旧的公共记忆 ${facts.pendingShared} 条待挑选：在 Bot 记忆的“已归档”里恢复你要的。`] : []),
  ];
}
