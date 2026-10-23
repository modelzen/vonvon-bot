import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ComponentProps} from 'react';
import {agentIdSchema, membershipSchema, type Agent, type GroupAttention} from '@vonvon/protocol';
import {GroupAttentionStatus} from '../src/management/GroupAttentionStatus';

const now = new Date('2026-10-23T06:00:00Z').getTime();
const agent: Agent = {
  id: agentIdSchema.parse('cli_attention'), name: '群助手', enabled: true, running: true,
  connection: 'connected', activation: 'active',
};
const membership = membershipSchema.parse({
  id: '["cli_attention","oc_attention"]', agentId: agent.id, groupId: 'oc_attention',
  name: '讨论群', directory: '/tmp/attention', backend: 'codex-appserver', conversation: 'smart',
  response: 'mention', permission: {administrator: 'full', member: 'full', network: false}, stale: false, enabled: true,
});
const state = (fields: Partial<GroupAttention> = {}): GroupAttention => ({
  groupId: membership.groupId, main: {mode: 'watch', intervalMs: 180_000},
  focusedTopics: 2, watchedTopics: 1, ...fields,
});
const withAttention = (attention: GroupAttention[] | undefined): Agent => ({
  ...agent, diagnostics: {notReplied: [], deniedScopes: [], ...(attention === undefined ? {} : {attention})},
});
const render = (props: Partial<ComponentProps<typeof GroupAttentionStatus>> = {}) => renderToStaticMarkup(
  <GroupAttentionStatus agent={withAttention([state()])} membership={membership} connected {...props}/>,
);
const content = (html: string) => html.replace(/<[^>]+>/g, '');
// Limit assertions to the live reading, never the static score examples in help.
function region(html: string, className: string): string {
  const opening = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(html);
  if (!opening) return '';
  const start = opening.index + opening[0].length;
  const tags = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    if (tag[1] !== opening[1]) continue;
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  return '';
}
const value = (html: string) => content(region(html, 'group-attention__value')).replace(/\s/g, '');
const reading = (html: string) => content(region(html, 'group-attention__reading'));
const topics = (html: string) => content(region(html, 'group-attention__topics'));
const show = (attention: GroupAttention) => render({agent: withAttention([attention])});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

it.each([[1, 75], [3, 50], [5, 25]])('shows %i-minute main-area watch as %i/100, with topic counts separately', (minutes, score) => {
  const html = show(state({main: {mode: 'watch', intervalMs: minutes! * 60_000}}));
  expect(html).toContain('aria-label="主区关注度"');
  expect(value(html)).toBe(`${score}/100`);
  expect(region(html, 'group-attention__value')).toContain(`<strong>${score}</strong>`);
  expect(reading(html)).toContain('留意中');
  expect(reading(html)).toContain(`当前间隔 ${minutes} 分钟`);
  expect(topics(html)).toContain('2 个专注 · 1 个留意');
});

it('shows focus without presenting its stored watch interval as a running scan schedule', () => {
  const html = show(state({main: {mode: 'focus', intervalMs: 60_000}}));
  expect(value(html)).toBe('100/100');
  expect(reading(html)).toContain('专注中');
  expect(reading(html)).toContain('新消息到达就判断是否接话');
  expect(reading(html)).not.toContain('当前间隔');
  expect(topics(html)).toContain('2 个专注 · 1 个留意');
});

it('uses the selected group within the selected bot and never leaks another bot or group', () => {
  const other = state({groupId: 'oc_other', main: {mode: 'focus', intervalMs: 60_000}, focusedTopics: 99});
  const html = render({agent: withAttention([other, state()])});
  expect(value(html)).toBe('50/100');
  expect(reading(html)).toContain('当前间隔 3 分钟');
  expect(topics(html)).not.toContain('99 个专注');
  const wrongBot = render({membership: {...membership, agentId: agentIdSchema.parse('cli_other')}});
  expect(value(wrongBot)).toBe('—');
  expect(reading(wrongBot)).toContain('暂无关注状态');
  expect(topics(wrongBot)).toBe('');
  expect(reading(wrongBot)).not.toContain('留意中');
  const wrongGroup = render({agent: withAttention([other])});
  expect(value(wrongGroup)).toBe('—');
  expect(reading(wrongGroup)).toContain('暂无关注状态');
});

it('keeps topic-only attention and does not invent a main-area state', () => {
  const html = show(state({main: undefined}));
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain('暂无关注状态');
  expect(topics(html)).toContain('2 个专注 · 1 个留意');
  expect(reading(html)).not.toContain('专注中');
  expect(reading(html)).not.toContain('留意中');
});

it('does not interpolate or round an unrecognized interval into a score', () => {
  const html = show(state({main: {mode: 'watch', intervalMs: 120_000}}));
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain('留意中');
  expect(reading(html)).toContain('当前间隔 2 分钟');
  expect(topics(html)).toContain('2 个专注 · 1 个留意');
});

it('distinguishes absent records from a daemon that does not provide attention', () => {
  const empty = render({agent: withAttention([])});
  expect(value(empty)).toBe('—');
  expect(reading(empty)).toContain('暂无关注状态');
  expect(topics(empty)).toBe('');
  expect(reading(empty)).not.toContain('当前版本未提供关注状态');
  for (const missing of [withAttention(undefined), agent]) {
    const html = render({agent: missing});
    expect(value(html)).toBe('—');
    expect(reading(html)).toContain('当前版本未提供关注状态');
  }
  for (const props of [{agent: undefined}, {membership: undefined}]) {
    const html = render(props);
    expect(value(html)).toBe('—');
    expect(reading(html)).toContain('暂无关注状态');
  }
});

it.each([
  {name: 'stopped bot', props: {agent: {...withAttention([state()]), running: false}}, message: 'Bot 未运行'},
  {name: 'disabled bot', props: {agent: {...withAttention([state()]), enabled: false}}, message: 'Bot 未运行'},
  {name: 'disconnected host', props: {connected: false}, message: '连接已断开，暂无关注状态'},
  {name: 'disconnected bot', props: {agent: {...withAttention([state()]), connection: 'disconnected'}}, message: '连接已断开，暂无关注状态'},
  {name: 'stale membership', props: {membership: {...membership, stale: true}}, message: '群状态暂不可读'},
  {name: 'disabled project', props: {membership: {...membership, enabled: false}}, message: '项目已停用，暂停关注'},
  {name: 'unreadable project', props: {membership: {...membership, enabled: undefined}}, message: '项目状态暂不可读'},
])('does not advertise cached attention for $name', ({props, message}) => {
  const html = render(props);
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain(message);
  expect(reading(html)).not.toContain('留意中');
  expect(topics(html)).toBe('');
  expect(reading(html)).not.toContain('当前间隔');
});

it('pauses watched places at the budget limit while focused places still judge new messages', () => {
  const budget = {kind: 'no-glance', until: now + 60_000} as const;
  const watching = show(state({budget}));
  expect(value(watching)).toBe('0/100');
  expect(reading(watching)).toContain('暂停扫视');
  expect(topics(watching)).toContain('2 个专注 · 1 个暂停扫视');
  expect(reading(watching)).not.toContain('留意中');
  expect(reading(watching)).not.toContain('当前间隔');
  const focused = show(state({main: {mode: 'focus', intervalMs: 60_000}, budget}));
  expect(value(focused)).toBe('100/100');
  expect(reading(focused)).toContain('专注中');
  expect(content(focused).split('数值说明')[0]).toContain('暂停扫视');
});

it('replaces normal main and topic activity when only direct human signals are allowed', () => {
  const html = show(state({main: {mode: 'focus', intervalMs: 60_000}, budget: {kind: 'named-only', until: now + 60_000}}));
  expect(value(html)).toBe('0/100');
  expect(reading(html)).toContain('仅处理真人直接找它的消息');
  expect(reading(html)).not.toContain('专注中');
  expect(topics(html)).toBe('');
  expect(reading(html)).not.toContain('当前间隔');
});

it.each(['no-glance', 'named-only'] as const)('waits for a fresh snapshot at the %s deadline instead of assuming the budget recovered', kind => {
  const limited = state({budget: {kind, until: now + 60_000}});
  vi.setSystemTime(now + 59_999);
  expect(value(show(limited))).toBe('0/100');
  expect(reading(show(limited))).toContain(kind === 'no-glance' ? '暂停扫视' : '仅处理真人直接找它的消息');
  vi.setSystemTime(now + 60_000);
  const expired = show(limited);
  expect(value(expired)).toBe('—');
  expect(reading(expired)).toContain('关注状态待更新');
  expect(topics(expired)).toBe('');
  expect(reading(expired)).not.toContain('当前间隔');
  expect(reading(expired)).not.toContain('仅处理真人直接找它的消息');
  // A new diagnostics snapshot, rather than the clock, confirms recovery.
  expect(value(show(state()))).toBe('50/100');
  expect(reading(show(state()))).toContain('当前间隔 3 分钟');
});

it('offers keyboard-accessible help and no writable attention control', () => {
  const html = render();
  expect(html).toMatch(/<details[\s>]/);
  expect(html).toMatch(/<summary[^>]*>[^<]*数值说明/);
  expect(html).not.toMatch(/<(?:input|select|textarea)\b/);
  expect(html).not.toContain('role="slider"');
  expect(render({connected: false})).toContain('数值说明');
});

it.each(['threads', 'shared'] as const)('does not expose smart attention for a %s membership', conversation => {
  expect(render({membership: {...membership, conversation}})).toBe('');
});
