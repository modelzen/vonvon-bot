import { describe, expect, it } from 'vitest';
import { buildJoinGroupFormCard, parseProjectPick } from '../src/card/dm-cards';

describe('the private-chat setup card (P6, P7a)', () => {
  it('offers only the project another bot has in this group, by name, next to a new one: no id, no other project', () => {
    const card = JSON.stringify(buildJoinGroupFormCard({ chatId: 'oc_group', name: '支付组群', sibling: { name: '支付组' } }));
    expect(card).toContain('加入本群已有的项目「支付组」');
    expect(card).toContain('新建项目「支付组群」');
    expect(card.match(/"name":"project"/g)).toHaveLength(1);
    expect(card).not.toMatch(/prj_[0-9a-f]{8}/);
    expect(card).toContain('"initial_option":"join"');
  });
  it('reads the pick: join unless new was chosen', () => {
    expect(parseProjectPick({ project: 'new' })).toBe('new');
    for (const value of [{ project: 'join' }, {}, { project: 'prj_00000001' }, undefined]) expect(parseProjectPick(value)).toBe('join');
  });
  it('lists no project: no project name, no id, no project picker, so another project cannot be picked from outside the desktop', () => {
    const card = JSON.stringify(buildJoinGroupFormCard({ chatId: 'oc_group', name: '支付组群', backends: [{ value: 'codex-appserver', label: 'Codex' }, { value: 'claude-agent', label: 'Claude' }] }));
    expect(card).not.toMatch(/prj_[0-9a-f]{8}/);
    expect(card).not.toContain('加入项目');
    expect(card).not.toContain('"name":"project"');
    // the only free-text place that reaches a folder is the existing-directory input, which the daemon refuses for another project's folder
    expect(card.match(/"name":"cwd"/g)).toHaveLength(1);
  });
});
