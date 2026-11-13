import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AccountStatus} from '@vonvon/protocol';
import {AccountPanel} from '../src/accounts/AccountPanel';
import {AccountAvatar} from '../src/accounts/AccountAvatar';
import {SettingsHome} from '../src/TodayHome';
import {Button} from '../src/reference/components/ui';

const h = vi.hoisted(() => ({account: {supported: true, status: {kind: 'signedOut'} as AccountStatus | undefined, error: undefined as string | undefined, login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()}}));
vi.mock('../src/account-context', async original => ({...await original<typeof import('../src/account-context')>(), useAccount: () => h.account}));
vi.mock('../src/client-context', async original => {const actual = await original<typeof import('../src/client-context')>(); return {...actual, useActiveDevice: () => actual.LOCAL_ACTIVE_DEVICE};});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, unknown>>(node) ? [node, ...Object.values(node.props).flatMap(nodes)] : [];
const identity = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: 'Clay', provider: 'google', persistence: 'secure'} as const;
const html = () => renderToStaticMarkup(<AccountPanel/>);
function click(label: string) {
  const button = nodes(AccountPanel()).find(node => node.type === Button && node.props.children === label)!;
  (button.props.onClick as () => void)();
}
beforeEach(() => {h.account.supported = true; h.account.status = {kind: 'signedOut'}; h.account.error = undefined; vi.clearAllMocks();});

it('starts native login directly and offers cancellation while waiting', () => {
  expect(html()).toContain('登录 Vonvon');
  expect(html()).not.toContain('网页登录');
  click('登录 Vonvon');
  expect(h.account.login).toHaveBeenCalledOnce();
  h.account.status = {kind: 'signingIn'};
  expect(html()).toContain('等待登录完成');
  expect(html()).not.toContain('登录 Vonvon</button>');
  click('取消登录');
  expect(h.account.cancelLogin).toHaveBeenCalledOnce();
});

it('shows the signed-in profile and explains a session held only in memory', () => {
  h.account.status = {...identity, persistence: 'memory'};
  const markup = html();
  expect(markup).toContain('Clay');
  expect(markup).toContain('通过 Google 登录');
  expect(markup).toContain('本次登录仅保留到应用关闭');
  expect(markup).toContain('已配对设备、Bot 和群组设置会保留');
  expect(markup).not.toContain('创作中心');
  expect(markup).not.toContain('已获取');
  click('退出登录');
  expect(h.account.logout).toHaveBeenCalledOnce();
});

it('shows failure and expiry states, and only retries a usable native capability', () => {
  h.account.status = {kind: 'signedOut', reason: 'expired'};
  expect(html()).toContain('登录已过期');
  h.account.status = {kind: 'unavailable', reason: 'offline'};
  expect(html()).toContain('请检查网络');
  click('重试登录');
  expect(h.account.login).toHaveBeenCalledOnce();
  h.account.status = {kind: 'unavailable', reason: 'configuration'};
  expect(html()).toContain('账户服务尚未配置');
  expect(html()).not.toContain('<button');
  h.account.supported = false; h.account.status = undefined;
  expect(html()).toContain('账户功能在 Vonvon Bot 桌面应用中提供');
  expect(html()).not.toContain('<button');
});

it('puts the profile and provider in settings and uses the existing account navigation', () => {
  h.account.status = identity;
  const onNavigate = vi.fn();
  const tree = SettingsHome({onNavigate, onFeature: () => {}});
  const markup = renderToStaticMarkup(tree);
  expect(markup).toContain('Clay'); expect(markup).toContain('通过 Google 登录');
  const row = nodes(tree).find(node => node.type === 'button' && nodes(node).some(child => child.type === AccountAvatar))!;
  (row.props.onClick as () => void)();
  expect(onNavigate).toHaveBeenCalledWith('account');
});

it('renders sanitized raster data only and falls back to the user initials', () => {
  expect(renderToStaticMarkup(<AccountAvatar identity={{...identity, avatarUrl: 'https://example.test/avatar.png'}}/>)).not.toContain('<img');
  expect(renderToStaticMarkup(<AccountAvatar identity={identity}/>)).toContain('CL');
  const data = 'data:image/png;base64,YQ==';
  expect(renderToStaticMarkup(<AccountAvatar identity={{...identity, avatarDataUrl: data}}/>)).toContain(data);
  expect(renderToStaticMarkup(<AccountAvatar identity={{...identity, avatarDataUrl: 'data:image/svg+xml;base64,YQ=='}}/>)).not.toContain('<img');
});
