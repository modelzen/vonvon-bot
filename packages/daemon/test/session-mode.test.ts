import { describe, expect, it } from 'vitest';
import { bindNoMention, noMentionOf, pendingPolicyOf, ruleKind, sessionModeOf, storedMode, type Project } from '../src/project/registry';
import { buildGroupSettingsCard, buildJoinGroupFormCard, buildNewProjectDoneCard, buildNewProjectFormCard, buildProjectListCard, buildProjectSettingsCard, DM, GS, kindLabel, parseNoMentionPick, SMART_NO_MENTION_NOTE } from '../src/card/dm-cards';
import { buildWelcomeCard } from '../src/card/command-cards';

const row = (extra: Partial<Project>): Project => ({ name: 'p', chatId: 'oc_p', cwd: '/tmp/p', blank: false, createdAt: 1, ...extra });

describe('s21 会话方式 read rules (product.md 3.4)', () => {
  it('reads missing and unknown kinds as 多会话, as before s21', () => {
    expect(sessionModeOf(row({}))).toBe('multi');
    expect(sessionModeOf(row({ kind: 'later' as never }))).toBe('multi');
    expect(sessionModeOf(row({ kind: 'single', smart: 'yes' as never }))).toBe('single');
    expect(sessionModeOf(row({ kind: 'multi', smart: true }))).toBe('multi'); // switched by an older daemon
    expect(ruleKind(row({ kind: 'single' }))).toBe('single');
  });
  it('runs a stored 智能 main area as one session, with no 免@: its judgement decides (s25)', () => {
    const smart = row({ kind: 'single', smart: true, noMention: true });
    expect(sessionModeOf(smart)).toBe('smart');
    expect(ruleKind(smart)).toBe('single');
    expect(noMentionOf(smart)).toBe(false);
  });
  it('keeps the bridge defaults for old rows and writes 3.4 defaults for new binds', () => {
    expect(noMentionOf(row({ kind: 'single' }))).toBe(true); // created 单会话: bridge default on
    expect(noMentionOf(row({ kind: 'single', origin: 'joined' }))).toBe(false);
    expect(noMentionOf(row({ kind: 'multi', origin: 'joined' }))).toBe(true);
    expect(noMentionOf(row({ kind: 'single', noMention: true, origin: 'joined' }))).toBe(true);
    expect(bindNoMention('multi')).toBe(true);
    expect(bindNoMention('single')).toBe(false);
    expect(bindNoMention('smart')).toBe(false);
  });
  it('s25c: stores 智能 as 单会话 plus smart with 免@ off, which every reader agrees on', () => {
    expect(storedMode('multi')).toEqual({ kind: 'multi' });
    expect(storedMode('single')).toEqual({ kind: 'single' });
    expect(storedMode('smart')).toEqual({ kind: 'single', smart: true, noMention: false });
    for (const mode of ['multi', 'single', 'smart'] as const) expect(sessionModeOf(row(storedMode(mode)))).toBe(mode);
    // A daemon from before s21 reads only kind and noMention: 单会话 that answers an @ only.
    expect(row(storedMode('smart')).noMention).toBe(false);
  });
  it('takes the group 运行中来了消息 over the bot, and Claude always queues', () => {
    expect(pendingPolicyOf('steer', undefined)).toBe('steer');
    expect(pendingPolicyOf('steer', row({}))).toBe('steer');
    expect(pendingPolicyOf('steer', row({ pendingPolicy: 'queue' }))).toBe('queue');
    expect(pendingPolicyOf('queue', row({ pendingPolicy: 'steer' }))).toBe('steer');
    expect(pendingPolicyOf('steer', row({ backend: 'claude-agent', pendingPolicy: 'steer' }))).toBe('queue');
  });
});

describe('s21 DM bind and new-group cards', () => {
  for (const [name, verb, built] of [['bind', '绑定', buildJoinGroupFormCard({ chatId: 'oc_x', name: 'x' })], ['new', '创建', buildNewProjectFormCard({})]] as const) {
    it(`${name}: lists 多会话, 单会话 then 智能 with 3.4's words, preselects nothing and marks nothing (s25c)`, () => {
      const json = JSON.stringify(built);
      const lines = ['**@ 我开新会话**：在主区 @ 我就开一个话题，一个话题一条会话，几件事各聊各的',
        '**整群一条会话**：主区一条会话，上下文一直连着；想另起一件事，开个话题和我聊',
        '**智能开话题**：主区一条会话，不用 @ 我也会看情况接话；聊到新的事，我自己开话题、起新会话'];
      const at = lines.map(line => json.indexOf(line));
      expect(at.every(index => index > -1)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(json).not.toContain('推荐');
      expect(json).not.toContain('initial_option');
      const buttons = [...json.matchAll(/"name":"(submit_\w+)","text":\{"tag":"plain_text","content":"([^"]+)"\}.*?"kind":"(\w+)"/g)].map(match => match.slice(1));
      expect(buttons).toEqual([['submit_multi', `${verb}·@ 我开新会话`, 'multi'], ['submit_single', `${verb}·整群一条会话`, 'single'], ['submit_smart', `${verb}·智能开话题`, 'smart']]);
      expect(json).not.toContain('"type":"primary","form_action_type":"submit"');
      expect(json).toContain('智能开话题没有这一项');
    });
  }
  it('s25c: says on the done card that a 免@ picked with 智能 was not used', () => {
    const smart = row({ kind: 'single', smart: true, noMention: false, origin: 'joined' });
    expect(JSON.stringify(buildNewProjectDoneCard(smart, true))).toContain('智能开话题没有免 @，刚才选的没用上。');
    expect(JSON.stringify(buildNewProjectDoneCard(smart))).not.toContain('没用上');
    expect(JSON.stringify(buildNewProjectDoneCard(smart))).toContain('智能 · 智能开话题');
  });
  it('s25c: hides 免@ for a 智能 group on the DM settings card, the group /settings card and the project list', () => {
    const smart = row({ kind: 'single', smart: true, noMention: true });
    const single = row({ kind: 'single', noMention: true });
    for (const [built, action] of [[(p: Project) => buildProjectSettingsCard(p), DM.setNoMentionDm], [(p: Project) => buildGroupSettingsCard(p), GS.setNoMention]] as const) {
      const hidden = JSON.stringify(built(smart));
      expect(hidden).not.toContain(`"a":"${action}"`);
      expect(hidden).toContain(SMART_NO_MENTION_NOTE);
      expect(hidden).not.toContain('im:message.group_msg');
      expect(hidden).toContain('智能 · 智能开话题');
      const shown = JSON.stringify(built(single));
      expect(shown).toContain(`"a":"${action}"`);
      expect(shown).not.toContain(SMART_NO_MENTION_NOTE);
    }
    expect(JSON.stringify(buildProjectListCard([smart]))).not.toContain('免@');
    expect(JSON.stringify(buildProjectListCard([single]))).toContain('免@：开');
  });
  it('the 多会话 welcome card promises 免@ in topics only when it is on', () => {
    expect(JSON.stringify(buildWelcomeCard('multi', undefined, true))).toContain('免@');
    expect(JSON.stringify(buildWelcomeCard('multi', undefined, false))).not.toContain('直接发消息（免@）');
  });
  it('reads an unpicked 免@ as "follow the 会话方式"', () => {
    expect(parseNoMentionPick(undefined)).toBeUndefined();
    expect(parseNoMentionPick({})).toBeUndefined();
    expect(parseNoMentionPick({ noMention: 'on' })).toBe(true);
    expect(parseNoMentionPick({ noMention: 'off' })).toBe(false);
    expect(parseNoMentionPick({ noMention: 'yes' })).toBeUndefined();
  });
  it('labels groups with the 3.4 names', () => {
    expect(kindLabel(row({}))).toBe('多会话 · @ 我开新会话');
    expect(kindLabel(row({ kind: 'single' }))).toBe('单会话 · 整群一条会话');
    expect(kindLabel(row({ kind: 'single', smart: true }))).toBe('智能 · 智能开话题');
    expect(kindLabel(row({ kind: 'multi', smart: true }))).toBe('多会话 · @ 我开新会话');
  });
});
