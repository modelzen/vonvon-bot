import { MEMORY_BRANCH_COUNT_MAX, MEMORY_BRANCH_NAME_MAX, type MemoryBranch, type MemoryItemScope } from '@vonvon/protocol';

/**
 * 记忆分支表（记忆设计 §2.4，D7）。纯函数：名字归一化、固定分支、新开、12 支上限、空了自动去掉。
 * 条目库（memory-store.ts）在每次事件之后都过一遍 {@link pruneBranches}，重放时也一样，所以分支表是事件的函数。
 */

export const OTHER_BRANCH = '其他';
export const BOT_FIXED_BRANCHES: readonly string[] = ['关于你', '合作方式', '团队和人', OTHER_BRANCH];
export const PROJECT_FIXED_BRANCHES: readonly string[] = ['决定', '约定', '人和分工', '环境和资源', '背景', OTHER_BRANCH];
/** 私聊记忆（s49 之后）先只有"其他"，固定分支到时再定 */
export const DM_FIXED_BRANCHES: readonly string[] = [OTHER_BRANCH];

export function fixedBranchNames(scope: MemoryItemScope['kind']): readonly string[] {
  return scope === 'bot' ? BOT_FIXED_BRANCHES : scope === 'dm' ? DM_FIXED_BRANCHES : PROJECT_FIXED_BRANCHES;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const BRACKETS = /[[\]「」【】（）<>"]/g;

/**
 * 去掉控制字符、换行和 `[]「」【】（）<>"`，空白连成一个并去掉首尾，截到 12 码点。归一化后是空的，进"其他"。
 * 名字会进注入块和界面，所以连边界字符一起去掉，模型起不出能伪造块边界的名字。
 */
export function normalizeBranchName(raw: string): string {
  const cleaned = raw.replace(CONTROL, ' ').replace(BRACKETS, '').replace(/\s+/g, ' ').trim();
  const cut = Array.from(cleaned).slice(0, MEMORY_BRANCH_NAME_MAX).join('').trim();
  return cut || OTHER_BRANCH;
}

/** 比对用的键：ASCII 字母不分大小写，其余照旧 */
export const branchKey = (name: string): string => name.replace(/[A-Z]/g, letter => letter.toLowerCase());

export function findBranch(table: readonly MemoryBranch[], raw: string): MemoryBranch | undefined {
  const key = branchKey(normalizeBranchName(raw));
  return table.find(entry => branchKey(entry.name) === key);
}

/** 固定的在前（"其他"除外），新开的按创建先后，"其他"最后 */
export function orderBranches(table: readonly MemoryBranch[]): MemoryBranch[] {
  const rank = (entry: MemoryBranch): number => entry.name === OTHER_BRANCH ? 2 : entry.fixed ? 0 : 1;
  return table.map((entry, index) => ({ entry, index })).sort((a, b) => {
    const byRank = rank(a.entry) - rank(b.entry);
    if (byRank) return byRank;
    return rank(a.entry) === 0 ? a.index - b.index : a.entry.createdAt - b.entry.createdAt || a.index - b.index;
  }).map(({ entry }) => entry);
}

/** 建条目库时的分支表：这一类记忆的固定分支，空的也在 */
export function freshBranches(scope: MemoryItemScope['kind'], at: number): MemoryBranch[] {
  return orderBranches(fixedBranchNames(scope).map(name => ({ name, fixed: true, createdAt: at, createdBy: 'system' })));
}

export interface ResolvedBranch { name: string; newBranch: boolean }
/**
 * 条目要进哪一支：表里有就用（`" 发版 "` 和 `"发版"` 是同一支）；没有且这份记忆不到 12 支就新开；到了 12 支进"其他"。
 * `existingOnly`（移层时用）不新开，没有同名的直接进"其他"。
 */
export function resolveBranch(table: readonly MemoryBranch[], raw: string | undefined, options: { existingOnly?: boolean } = {}): ResolvedBranch {
  const name = normalizeBranchName(raw ?? '');
  const found = findBranch(table, name);
  if (found) return { name: found.name, newBranch: false };
  if (options.existingOnly || table.length >= MEMORY_BRANCH_COUNT_MAX) return { name: OTHER_BRANCH, newBranch: false };
  return { name, newBranch: true };
}

/** 没有 active 条目的新开分支自动去掉，不占名额；固定分支留着。返回新的分支表 */
export function pruneBranches(table: readonly MemoryBranch[], activeBranchNames: ReadonlySet<string>): MemoryBranch[] {
  const used = new Set([...activeBranchNames].map(branchKey));
  return orderBranches(table.filter(entry => entry.fixed || used.has(branchKey(entry.name))));
}
