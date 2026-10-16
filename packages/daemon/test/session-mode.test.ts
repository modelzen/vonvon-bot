import { describe, expect, it } from 'vitest';
import { bindNoMention, noMentionOf, pendingPolicyOf, ruleKind, sessionModeOf, type Project } from '../src/project/registry';
import { buildJoinGroupFormCard, buildNewProjectFormCard, kindLabel, parseNoMentionPick } from '../src/card/dm-cards';
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
  it('runs a stored 智能 as 单会话 that replies only when @-ed, until s25', () => {
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
  for (const [name, built] of [['bind', buildJoinGroupFormCard({ chatId: 'oc_x', name: 'x' })], ['new', buildNewProjectFormCard({})]] as const) {
    it(`${name}: lists 多会话 then 单会话 with 3.4's words, preselects nothing and marks nothing`, () => {
      const json = JSON.stringify(built);
      const multi = json.indexOf('@ 我开新会话：'.replace('：', '**：'));
      expect(json).toContain('**@ 我开新会话**：在主区 @ 我就开一个话题，一个话题一条会话，几件事各聊各的');
      expect(json).toContain('**整群一条会话**：主区一条会话，上下文一直连着；想另起一件事，开个话题和我聊');
      expect(json.indexOf('**@ 我开新会话**')).toBeLessThan(json.indexOf('**整群一条会话**'));
      expect(multi).toBeGreaterThan(-1);
      expect(json).not.toContain('推荐');
      expect(json).not.toContain('智能');
      expect(json).not.toContain('initial_option');
      const buttons = [...json.matchAll(/"kind":"(multi|single)"/g)].map(match => match[1]);
      expect(buttons).toEqual(['multi', 'single']);
      expect(json).not.toContain('"type":"primary","form_action_type":"submit"');
    });
  }
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
    expect(kindLabel(row({ kind: 'single', smart: true }))).toBe('单会话 · 整群一条会话'); // 智能 stays hidden until s25
  });
});
