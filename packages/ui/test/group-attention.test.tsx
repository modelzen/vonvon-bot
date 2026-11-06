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
  groupId: membership.groupId, group: {score: 50, intervalMs: 180_000, updatedAt: now}, main: {mode: 'watch', intervalMs: 180_000},
  focusedTopics: 2, watchedTopics: 1, ...fields,
});
const withAttention = (attention: GroupAttention[] | undefined): Agent => ({
  ...agent, diagnostics: {notReplied: [], deniedScopes: [], ...(attention === undefined ? {} : {attention})},
});
const render = (props: Partial<ComponentProps<typeof GroupAttentionStatus>> = {}) => renderToStaticMarkup(
  <GroupAttentionStatus attentionModel="group" agent={withAttention([state()])} membership={membership} connected {...props}/>,
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
const show = (attention: GroupAttention) => render({agent: withAttention([attention])});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

it.each([[100, 5_000, '专注中'], [75, 60_000, '留意中'], [50, 180_000, '留意中'], [25, 300_000, '留意中'], [10, 300_000, '低度留意']] as const)(
  'shows group score %i, independent of main and topic legacy fields', (score, intervalMs, label) => {
    const html = show(state({group: {score, intervalMs, updatedAt: now}, main: {mode: 'focus', intervalMs: 60_000}, focusedTopics: 99}));
    expect(value(html)).toBe(`${score}/100`);
    expect(reading(html)).toContain(label);
    expect(html).toContain('aria-label="群注意力"');
    expect(html).not.toContain('99 个专注');
    expect(html).not.toContain('主区关注度');
  },
);

it('uses the same reading as the badge and exposes the low tier as a partial arc', () => {
  const html = show(state({group: {score: 10, intervalMs: 300_000, updatedAt: now}}));
  expect(value(html)).toBe('10/100');
  expect(reading(html)).toContain('约 20 秒');
  expect(html.match(/class="is-lit"/g)).toHaveLength(1);
});

it('uses the selected group and bot without borrowing other readings', () => {
  const other = state({groupId: 'oc_other', group: {score: 100, intervalMs: 5_000, updatedAt: now}});
  expect(value(render({agent: withAttention([other, state()])}))).toBe('50/100');
  expect(value(render({agent: withAttention([other])}))).toBe('10/100');
  const wrong = render({membership: {...membership, agentId: agentIdSchema.parse('cli_other')}});
  expect(value(wrong)).toBe('—');
  expect(reading(wrong)).toContain('暂无注意力状态');
});

it('supports empty snapshots and refuses to derive a group score from an old daemon', () => {
  const empty = render({agent: withAttention([])});
  expect(value(empty)).toBe('10/100');
  expect(reading(empty)).toContain('低度留意');
  const legacy = show(state({group: undefined}));
  expect(value(legacy)).toBe('—');
  expect(reading(legacy)).toContain('请更新后台服务');
  const missing = render({agent: withAttention(undefined)});
  expect(value(missing)).toBe('—');
  expect(reading(missing)).toContain('当前版本未提供注意力状态');
});

it.each([
  {name: 'stopped bot', props: {agent: {...withAttention([state()]), running: false}}, message: 'Bot 未运行'},
  {name: 'disabled bot', props: {agent: {...withAttention([state()]), enabled: false}}, message: 'Bot 未运行'},
  {name: 'disconnected host', props: {connected: false}, message: '连接恢复后更新注意力状态'},
  {name: 'disconnected bot', props: {agent: {...withAttention([state()]), connection: 'disconnected'}}, message: '连接恢复后更新注意力状态'},
  {name: 'read error', props: {agent: {...withAttention([state()]), readError: 'unreadable'}}, message: '群状态暂不可读'},
  {name: 'stale membership', props: {membership: {...membership, stale: true}}, message: '群状态暂不可读'},
  {name: 'disabled project', props: {membership: {...membership, enabled: false}}, message: '本群已停用'},
  {name: 'unreadable project', props: {membership: {...membership, enabled: undefined}}, message: '群状态暂不可读'},
])('does not advertise a cached group score for $name', ({props, message}) => {
  const html = render(props);
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain(message);
});

it.each(['no-glance', 'named-only'] as const)('shows the %s restriction separately from the real score', kind => {
  const html = show(state({group: {score: 75, intervalMs: 60_000, updatedAt: now}, budget: {kind, until: now + 60_000}}));
  expect(value(html)).toBe('75/100');
  expect(html).toContain('data-tone="paused"');
  expect(reading(html)).toContain('判断额度暂满');
  expect(reading(html)).toContain(kind === 'named-only' ? '仅真人 @' : '批量查看暂缓');
});

it('waits for a fresh snapshot after budget expiration', () => {
  const html = show(state({budget: {kind: 'named-only', until: now}}));
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain('正在等待新的注意力状态');
});

it('offers accessible read-only help with the same named group score', () => {
  const html = render();
  const trigger = html.match(/<button\b[^>]*aria-label="群注意力 50 \/ 100，留意中。查看数值说明"[^>]*>/)?.[0];
  expect(trigger).toContain('aria-expanded="false"');
  expect(trigger).toContain('aria-haspopup="dialog"');
  expect(html).not.toMatch(/<(?:input|select|textarea)\b/);
  expect(html).not.toContain('role="slider"');
});

it.each(['threads', 'shared'] as const)('omits group attention for a %s membership', conversation => {
  expect(render({membership: {...membership, conversation}})).toBe('');
});

it('does not call an old daemon empty snapshot a known low score', () => {
  const html = render({agent: withAttention([]), attentionModel: undefined});
  expect(value(html)).toBe('—');
  expect(reading(html)).toContain('请更新后台服务');
});
