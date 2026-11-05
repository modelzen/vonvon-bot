import { describe, expect, it } from 'vitest';
import { adminCandidates, CREATOR_NAME } from '../src/admin/admin-candidates';

const names = (entries: [string, string][] = []) => new Map(entries);

describe('adminCandidates', () => {
  it('offers the creator whatever Feishu says, under the name it has or 创建者', () => {
    expect(adminCandidates({ admins: [], creator: 'ou_c', feishu: [], refused: [], names: names() }))
      .toEqual([{ openId: 'ou_c', name: CREATOR_NAME, sources: ['creator'] }]);
    expect(adminCandidates({ admins: [], creator: 'ou_c', feishu: [], refused: [], names: names([['ou_c', '李四']]) }))
      .toEqual([{ openId: 'ou_c', name: '李四', sources: ['creator'] }]);
  });

  it('lists a person Feishu names only when it gives the name, and merges the sources of one person', () => {
    const out = adminCandidates({ admins: [], creator: 'ou_c', feishu: ['ou_c', 'ou_f', 'ou_nameless', 'ou_f'], refused: [{ openId: 'ou_r', name: '旧名', at: 5 }, { openId: 'ou_f', name: '旧名', at: 9 }],
      names: names([['ou_c', '李四'], ['ou_f', '王五']]) });
    expect(out).toEqual([
      { openId: 'ou_c', name: '李四', sources: ['creator', 'feishu'] },
      { openId: 'ou_f', name: '王五', sources: ['feishu', 'refused'], at: 9 },
      { openId: 'ou_r', name: '旧名', sources: ['refused'], at: 5 },
    ]);
  });

  it('leaves out whoever is already an administrator', () => {
    expect(adminCandidates({ admins: ['ou_c', 'ou_r'], creator: 'ou_c', feishu: [], refused: [{ openId: 'ou_r', name: '甲', at: 1 }], names: names() })).toEqual([]);
  });
});
