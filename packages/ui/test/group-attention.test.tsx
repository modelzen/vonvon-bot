import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ComponentProps} from 'react';
import {agentIdSchema, membershipSchema, type Agent, type GroupAttention} from '@vonvon/protocol';
import {GroupAttentionStatus} from '../src/settings/GroupAttentionStatus';

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
const show = (attention: GroupAttention) => content(render({agent: withAttention([attention])}));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

it.each([1, 3, 5])('shows the actual %i-minute watch interval and independently counted topics', minutes => {
  const text = show(state({main: {mode: 'watch', intervalMs: minutes * 60_000}}));
  expect(text).toContain('当前关注状态');
  expect(text).toContain('群主区');
  expect(text).toContain(`留意中 · 扫视间隔 ${minutes} 分钟`);
  expect(text).toContain('2 个专注 · 1 个留意');
});

it('shows focus without presenting its stored watch interval as a running scan schedule', () => {
  const text = show(state({main: {mode: 'focus', intervalMs: 60_000}}));
  expect(text).toContain('专注中');
  expect(text).not.toContain('扫视间隔 1 分钟');
  expect(text).toContain('2 个专注 · 1 个留意');
});

it('uses the selected group within the selected bot and never leaks another bot or group', () => {
  const other = state({groupId: 'oc_other', main: {mode: 'focus', intervalMs: 60_000}, focusedTopics: 99});
  const text = content(render({agent: withAttention([other, state()])}));
  expect(text).toContain('留意中 · 扫视间隔 3 分钟');
  expect(text).not.toContain('99 个专注');
  const wrongBot = content(render({membership: {...membership, agentId: agentIdSchema.parse('cli_other')}}));
  expect(wrongBot).toContain('暂无关注状态');
  expect(wrongBot).not.toContain('2 个专注');
  expect(wrongBot).not.toContain('留意中');
  expect(content(render({agent: withAttention([other])}))).toContain('暂无关注状态');
});

it('keeps topic-only attention and does not invent a main-area state', () => {
  const text = show(state({main: undefined}));
  expect(text).toContain('暂无关注状态');
  expect(text).toContain('2 个专注 · 1 个留意');
  expect(text).not.toContain('专注中');
  expect(text).not.toContain('留意中');
});

it('distinguishes absent records from a daemon that does not provide attention', () => {
  const empty = content(render({agent: withAttention([])}));
  expect(empty).toContain('暂无关注状态');
  expect(empty).not.toContain('0 个专注');
  expect(empty).not.toContain('当前版本未提供关注状态');
  expect(content(render({agent: withAttention(undefined)}))).toContain('当前版本未提供关注状态');
  expect(content(render({agent}))).toContain('当前版本未提供关注状态');
  expect(content(render({agent: undefined}))).toContain('暂无关注状态');
  expect(content(render({membership: undefined}))).toContain('暂无关注状态');
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
  const text = content(render(props));
  expect(text).toContain(message);
  expect(text).not.toContain('留意中');
  expect(text).not.toContain('2 个专注');
  expect(text).not.toContain('扫视间隔 3 分钟');
});

it('pauses watched places at the budget limit while focused places still judge new messages', () => {
  const budget = {kind: 'no-glance', until: now + 60_000} as const;
  const watching = show(state({budget}));
  expect(watching).toContain('暂停扫视');
  expect(watching).toContain('2 个专注 · 1 个暂停扫视');
  expect(watching).not.toContain('留意中');
  expect(watching).not.toContain('扫视间隔 3 分钟');
  const focused = show(state({main: {mode: 'focus', intervalMs: 60_000}, budget}));
  expect(focused).toContain('专注中');
  expect(focused).toContain('判断额度暂满，暂停扫视；专注中的位置仍会判断新消息。');
});

it('replaces normal main and topic activity when only direct human signals are allowed', () => {
  const text = show(state({main: {mode: 'focus', intervalMs: 60_000}, budget: {kind: 'named-only', until: now + 60_000}}));
  expect(text).toContain('仅处理真人直接找它的消息');
  expect(text).toContain('@、引用或回复 Bot 发起的话题根消息仍会判断。额度恢复后自动继续。');
  expect(text).not.toContain('专注中');
  expect(text).not.toContain('2 个专注');
  expect(text).not.toContain('1 个留意');
  expect(text).not.toContain('扫视间隔 1 分钟');
});

it.each(['no-glance', 'named-only'] as const)('waits for a fresh snapshot at the %s deadline instead of assuming the budget recovered', kind => {
  const limited = state({budget: {kind, until: now + 60_000}});
  vi.setSystemTime(now + 59_999);
  expect(show(limited)).toContain(kind === 'no-glance' ? '暂停扫视' : '仅处理真人直接找它的消息');
  vi.setSystemTime(now + 60_000);
  const expired = show(limited);
  expect(expired).toContain('关注状态待更新');
  expect(expired).not.toContain('2 个专注');
  expect(expired).not.toContain('扫视间隔 3 分钟');
  expect(expired).not.toContain('仅处理真人直接找它的消息');
  // A new diagnostics snapshot, rather than the clock, confirms recovery.
  expect(show(state())).toContain('留意中 · 扫视间隔 3 分钟');
});

it('offers keyboard-accessible help and no writable attention control', () => {
  const html = render();
  expect(html).toMatch(/<details[\s>]/);
  expect(html).toMatch(/<summary[^>]*>[^<]*关注状态说明/);
  expect(html).not.toMatch(/<(?:input|select|textarea)\b/);
  expect(html).not.toContain('role="slider"');
  expect(render({connected: false})).toContain('关注状态说明');
});

it.each(['threads', 'shared'] as const)('does not expose smart attention for a %s membership', conversation => {
  expect(render({membership: {...membership, conversation}})).toBe('');
});
