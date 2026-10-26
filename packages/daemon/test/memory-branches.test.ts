import { describe, expect, it } from 'vitest';
import { MEMORY_BRANCH_COUNT_MAX, type MemoryBranch } from '@vonvon/protocol';
import {
  BOT_FIXED_BRANCHES, branchKey, DM_FIXED_BRANCHES, freshBranches, normalizeBranchName, orderBranches, OTHER_BRANCH, PROJECT_FIXED_BRANCHES,
  pruneBranches, resolveBranch,
} from '../src/bot/memory-branches';

const fresh = (kind: 'project' | 'bot' | 'dm' = 'project'): MemoryBranch[] => freshBranches(kind, 0);
const opened = (table: MemoryBranch[], name: string, createdAt: number): MemoryBranch[] => orderBranches([...table, { name, fixed: false, createdAt, createdBy: 'bot' }]);

describe('branch names', () => {
  it('treats a name with spaces around it as the same branch', () => {
    expect(normalizeBranchName(' 发版 ')).toBe('发版');
    const table = opened(fresh(), '发版', 1);
    expect(resolveBranch(table, ' 发版 ')).toEqual({ name: '发版', newBranch: false });
    expect(resolveBranch(table, '发版')).toEqual({ name: '发版', newBranch: false });
  });

  it('collapses runs of whitespace and drops control characters, line breaks and the brackets that could forge a block edge', () => {
    expect(normalizeBranchName('发  版\n\t流程')).toBe('发 版 流程');
    expect(normalizeBranchName('a\u0000b\u0007c')).toBe('a b c');
    expect(normalizeBranchName('[项目记忆]「决定」【x】（y）<z>"q"')).toBe('项目记忆决定xyzq');
    expect(normalizeBranchName(' 发版 ')).toBe('发版');
  });

  it('cuts to 12 code points, counting an emoji as one', () => {
    expect(Array.from(normalizeBranchName('一二三四五六七八九十甲乙丙丁')).length).toBe(12);
    expect(normalizeBranchName('😀'.repeat(20))).toBe('😀'.repeat(12));
  });

  it('puts an empty result in 其他', () => {
    for (const raw of ['', '   ', '\n', '[]「」', '\u0000']) expect(normalizeBranchName(raw)).toBe(OTHER_BRANCH);
    expect(resolveBranch(fresh(), undefined)).toEqual({ name: OTHER_BRANCH, newBranch: false });
    expect(resolveBranch(fresh(), '【】')).toEqual({ name: OTHER_BRANCH, newBranch: false });
  });

  it('compares ASCII letters without case and everything else as it is', () => {
    expect(branchKey('Release')).toBe(branchKey('rElEaSe'));
    const table = opened(fresh(), 'Release', 1);
    expect(resolveBranch(table, 'release')).toEqual({ name: 'Release', newBranch: false });
    expect(resolveBranch(table, 'ＲＥＬＥＡＳＥ').newBranch).toBe(true);
  });
});

describe('fixed branches', () => {
  it('gives a new project and a new bot memory every fixed branch, empty ones included, with 其他 last', () => {
    expect(fresh('project').map(branch => branch.name)).toEqual(['决定', '约定', '人和分工', '环境和资源', '背景', '其他']);
    expect(fresh('bot').map(branch => branch.name)).toEqual(['关于你', '合作方式', '团队和人', '其他']);
    expect(fresh('dm').map(branch => branch.name)).toEqual([...DM_FIXED_BRANCHES]);
    expect(fresh('project').every(branch => branch.fixed)).toBe(true);
    expect(PROJECT_FIXED_BRANCHES.length + BOT_FIXED_BRANCHES.length).toBe(10);
  });

  it('orders fixed first, opened ones by creation time, 其他 last', () => {
    let table = fresh();
    table = opened(table, '乙', 20);
    table = opened(table, '甲', 10);
    expect(table.map(branch => branch.name)).toEqual(['决定', '约定', '人和分工', '环境和资源', '背景', '甲', '乙', '其他']);
  });
});

describe('the 12 branch cap', () => {
  it('opens a branch while the memory has fewer than 12 and puts the 13th name in 其他', () => {
    let table = fresh('project');
    for (let index = 0; table.length < MEMORY_BRANCH_COUNT_MAX; index++) {
      const resolved = resolveBranch(table, `新${index}`);
      expect(resolved.newBranch).toBe(true);
      table = opened(table, resolved.name, index + 1);
    }
    expect(table).toHaveLength(12);
    expect(resolveBranch(table, '第十三支')).toEqual({ name: OTHER_BRANCH, newBranch: false });
    // an existing name still resolves to itself at the cap
    expect(resolveBranch(table, '新0')).toEqual({ name: '新0', newBranch: false });
  });

  it('counts the fixed branches of a bot memory too, so it has room for 8 of its own', () => {
    let table = fresh('bot');
    let opened8 = 0;
    while (resolveBranch(table, `x${opened8}`).newBranch) { table = opened(table, `x${opened8}`, opened8 + 1); opened8++; }
    expect(opened8).toBe(8);
  });

  it('does not open a branch for a move between layers', () => {
    expect(resolveBranch(fresh(), '没有的名字', { existingOnly: true })).toEqual({ name: OTHER_BRANCH, newBranch: false });
    expect(resolveBranch(fresh(), '决定', { existingOnly: true })).toEqual({ name: '决定', newBranch: false });
  });
});

describe('empty branches', () => {
  it('drops an opened branch with no active item and keeps the fixed ones', () => {
    const table = opened(opened(fresh(), '甲', 1), '乙', 2);
    const pruned = pruneBranches(table, new Set(['乙']));
    expect(pruned.map(branch => branch.name)).toEqual(['决定', '约定', '人和分工', '环境和资源', '背景', '乙', '其他']);
  });
});
