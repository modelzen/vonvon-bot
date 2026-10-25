import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {AdminSetupStatus, Agent, DesktopSnapshot} from '@vonvon/protocol';
import {FeishuConnections} from '../src/setup/FeishuConnections';
import type {SetupRead} from '../src/setup/useSetupStatus';

const h = vi.hoisted(() => ({
  state: [] as unknown[], index: 0,
  reads: {} as Record<string, unknown>,
  recheck: vi.fn(), admin: vi.fn(), openExternal: vi.fn(),
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = h.index++;
    if (!(index in h.state)) h.state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [h.state[index], (next: unknown) => {h.state[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(h.state[index]) : next;}];
  },
}));
vi.mock('../src/client-context', () => ({useClient: () => ({admin: h.admin}), useShellCapabilities: () => ({})}));
vi.mock('../src/setup/useSetupStatus', () => ({useSetupStatus: () => ({reads: h.reads, recheck: h.recheck})}));
vi.mock('../src/url-actions', () => ({openExternalUrl: (...args: unknown[]) => h.openExternal(...args)}));

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<Record<string, any>>(node)) return text(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const first: Agent = {id: 'cli_first' as Agent['id'], name: '一号 Bot', enabled: true, running: true, connection: 'connected', activation: 'active'};
const second: Agent = {id: 'cli_second' as Agent['id'], name: '二号 Bot', enabled: true, running: true, connection: 'connected', activation: 'active'};
const done = (appId: string, confirmed = true): AdminSetupStatus => ({
  appId, tenant: 'feishu', credentials: {ok: true}, connection: {running: true},
  event: {state: 'ok', version: '1.0.2'}, scopes: {missingRequired: [], grantUrl: `https://open.feishu.cn/app/${appId}/auth`},
  eventConfigUrl: `https://open.feishu.cn/app/${appId}/event`, consoleUrl: `https://open.feishu.cn/app/${appId}`,
  cardCallback: {confirmed},
});
const snapshot: DesktopSnapshot = {
  revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents: [first, second], groups: [], memberships: [{id: 'bound', agentId: first.id, groupId: 'oc_bound'}] as DesktopSnapshot['memberships'],
  tools: [], jobs: [], application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/tmp/test'},
};
const run = vi.fn(async () => ({kind: 'applied', revision: 1} as const));
const onRegister = vi.fn();
const onOpenGroups = vi.fn();
const onNotice = vi.fn();
function render(value: DesktopSnapshot = snapshot) {
  h.index = 0;
  return nodes(FeishuConnections({snapshot: value, ready: true, busy: false, run, onRegister, onOpenGroups, onOpenEnvironment: () => {}, onNotice, codexJobs: null}));
}
const section = (all: Element[]) => all.find(node => node.type === 'section' && String(node.props['aria-label'] ?? '').endsWith('的配置检查'))!;
const button = (all: Element[], label: string) => all.find(node => node.props.onClick && text(node.props.children) === label)!;
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

beforeEach(() => {
  h.state = []; h.index = 0; h.reads = {}; h.recheck.mockReset().mockResolvedValue(undefined); h.admin.mockReset().mockResolvedValue({kind: 'applied'});
  run.mockClear(); onRegister.mockClear(); onOpenGroups.mockClear(); onNotice.mockClear();
  h.openExternal.mockReset().mockResolvedValue(undefined);
});

it('shows one Bot at a time in the six Feishu checks and switches without mixing results', () => {
  h.reads[first.id] = {status: done(first.id), checking: false} satisfies SetupRead;
  h.reads[second.id] = {status: {...done(second.id), event: {state: 'missing', missingRequired: ['im.message.receive_v1']}}, checking: false} satisfies SetupRead;
  let all = render();
  expect(section(all).props['aria-label']).toBe('一号 Bot 的配置检查');
  expect(nodes(section(all)).filter(node => node.type === 'h3').map(node => text(node.props.children))).toEqual(['飞书应用', '权限', '长连接', '事件订阅', '卡片回调', '发布']);
  expect(text(section(all))).toContain('已完成 6 / 6');
  expect(text(section(all))).not.toContain('缺少接收消息事件');
  all.find(node => node.type === 'button' && node.props.title === '二号 Bot')!.props.onClick();
  all = render();
  expect(section(all).props['aria-label']).toBe('二号 Bot 的配置检查');
  expect(text(section(all))).toContain('缺少接收消息事件');
  expect(text(section(all))).not.toContain('已完成 6 / 6');
  expect(all.find(node => node.type === 'button' && node.props.title === '二号 Bot')?.props['aria-pressed']).toBe(true);
});

it('confirms and revokes card callbacks only for the currently selected Bot', async () => {
  h.reads[first.id] = {status: done(first.id, false), checking: false} satisfies SetupRead;
  h.reads[second.id] = {status: done(second.id), checking: false} satisfies SetupRead;
  let all = render();
  button(all, '我已配置').props.onClick(); await flush();
  expect(h.admin).toHaveBeenCalledExactlyOnceWith({type: 'confirmCardCallback', agentId: first.id, confirmed: true});
  expect(h.recheck).toHaveBeenCalledExactlyOnceWith(first.id);
  all.find(node => node.type === 'button' && node.props.title === '二号 Bot')!.props.onClick();
  all = render();
  expect(text(section(all))).toContain('已手动确认');
  button(all, '撤销确认').props.onClick(); await flush();
  expect(h.admin).toHaveBeenLastCalledWith({type: 'confirmCardCallback', agentId: second.id, confirmed: false});
  expect(h.recheck).toHaveBeenLastCalledWith(second.id);
  expect(h.admin).toHaveBeenCalledTimes(2);
});

it('shows received callbacks as verified without a manual confirmation action', () => {
  h.reads[first.id] = {status: done(first.id, false), checking: false} satisfies SetupRead;
  let all = render();
  expect(text(section(all))).toContain('待验证');
  expect(button(all, '我已配置')).toBeDefined();
  h.reads[first.id] = {status: {...done(first.id), cardCallback: {confirmed: true, verifiedAt: 1_792_900_000_000}}, checking: false} satisfies SetupRead;
  all = render();
  expect(text(section(all))).toContain('已验证');
  expect(text(section(all))).toContain('已完成 6 / 6');
  expect(button(all, '我已配置')).toBeUndefined();
  expect(button(all, '撤销确认')).toBeUndefined();
  expect(h.admin).not.toHaveBeenCalled();
});

it('keeps a failed or stale read visible instead of claiming setup is complete', () => {
  h.reads[first.id] = {status: done(first.id), problem: '飞书接口超时', checking: false} satisfies SetupRead;
  let all = render();
  expect(text(all)).toContain('飞书接口超时');
  expect(text(section(all))).not.toContain('已完成 6 / 6');
  h.reads[first.id] = {problem: '没有这个 Bot', checking: false} satisfies SetupRead;
  all = render();
  expect(text(all)).toContain('没有这个 Bot');
  expect(text(section(all))).not.toContain('已完成');
  expect(text(section(all))).toContain('检测失败');
});

it('keeps a disabled Bot selectable for inspection while its sibling stays active', () => {
  h.reads[first.id] = {status: done(first.id), checking: false} satisfies SetupRead;
  h.reads[second.id] = {status: done(second.id), checking: false} satisfies SetupRead;
  const value = {...snapshot, agents: [first, {...second, enabled: false, running: false, connection: 'disconnected' as const}]};
  let all = render(value);
  all.find(node => node.type === 'button' && node.props.title === '二号 Bot')!.props.onClick();
  all = render(value);
  expect(section(all).props['aria-label']).toBe('二号 Bot 的配置检查');
  expect(text(all)).toContain('未启用');
  expect(all.find(node => node.type === 'button' && node.props.title === '一号 Bot')?.props.disabled).not.toBe(true);
});

it('keeps an event and callback settings entry after every check is complete', () => {
  h.reads[first.id] = {status: {...done(first.id), cardCallback: {confirmed: false, configuration: {state: 'configured', mode: 'websocket'}}}, checking: false} satisfies SetupRead;
  const all = render();
  expect(text(section(all))).toContain('已完成 6 / 6');
  expect(text(section(all))).toContain('已配置 · 长连接');
  expect(button(all, '事件与回调')).toBeDefined();
  expect(button(all, '我已配置')).toBeUndefined();
});

it('opens the selected Bot settings from one persistent entry without duplicate row actions', async () => {
  h.reads[first.id] = {status: done(first.id), checking: false} satisfies SetupRead;
  h.reads[second.id] = {status: {...done(second.id), event: {state: 'ok', missingOptional: ['drive.notice.comment_add_v1']}}, checking: false} satisfies SetupRead;
  let all = render();
  button(all, '事件与回调').props.onClick(); await flush();
  expect(h.openExternal).toHaveBeenLastCalledWith(done(first.id).eventConfigUrl, 'event-settings', {});
  all.find(node => node.type === 'button' && node.props.title === '二号 Bot')!.props.onClick();
  all = render();
  expect(button(all, '打开事件设置')).toBeUndefined();
  button(all, '事件与回调').props.onClick(); await flush();
  expect(h.openExternal).toHaveBeenLastCalledWith(done(second.id).eventConfigUrl, 'event-settings', {});
});
