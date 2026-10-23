import { describe, expect, it } from 'vitest';
import { buildJoinGroupFormCard } from '../src/card/dm-cards';

describe('the private-chat setup card (P6)', () => {
  it('lists no project: no project name, no id, no project picker, so another project cannot be picked from outside the desktop', () => {
    const card = JSON.stringify(buildJoinGroupFormCard({ chatId: 'oc_group', name: '支付组群', backends: [{ value: 'codex-appserver', label: 'Codex' }, { value: 'claude-agent', label: 'Claude' }] }));
    expect(card).not.toMatch(/prj_[0-9a-f]{8}/);
    expect(card).not.toContain('加入项目');
    expect(card).not.toContain('"name":"project"');
    // the only free-text place that reaches a folder is the existing-directory input, which the daemon refuses for another project's folder
    expect(card.match(/"name":"cwd"/g)).toHaveLength(1);
  });
});
