import {isValidElement, type ReactElement} from 'react';
import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevicesState} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider, type ShellCapabilities} from '../src/client-context';
import type {Page} from '../src/collaboration-model';
import {AppShell} from '../src/LocalShell';
import {BackButton} from '../src/BackButton';
import {DeviceSwitcher, DeviceSwitcherMenu} from '../src/devices/DeviceSwitcher';
import {linkPreviewCopy} from '../src/devices/devices-presentation';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, devicesState, fakeShell, info, localRow, newClient} from './devices-fixture';

// devices-ui-1b 第 5 节 device-switcher; 2026-11-03 moved to the top-left, in the brand's place, like a workspace switcher.
const render = (state: DevicesState, shell: ShellCapabilities = fakeShell()) => renderToStaticMarkup(<ClientProvider client={newClient()} shell={shell} device={activeDeviceFrom(state)} devices={state}>
  <DraftGuardProvider><DeviceSwitcher onManage={() => {}}/></DraftGuardProvider>
</ClientProvider>);
const menuOf = (state: DevicesState) => renderToStaticMarkup(<DeviceSwitcherMenu state={state} now={Date.now()} onPick={() => {}} onAdd={() => {}} onManage={() => {}}/>);
/** Each menu item's markup, in order. */
const items = (menu: string) => menu.split('role="menuitem"').slice(1);
const remote = devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()});
const localOnly: DevicesState = {...devicesState({id: 'local'}), devices: [{...localRow, current: true}]};

it('shows this computer alone, with a way to add the next device', () => {
  expect(render(localOnly)).toContain('当前设备：这台电脑，点击切换');
  const menu = menuOf(localOnly);
  expect(menu.match(/role="menuitem"/g)).toHaveLength(3);
  const [computer, add, manage] = items(menu);
  expect(computer).toContain('这台电脑');
  expect(computer).toContain('当前');
  expect(computer).toContain('data-current="true"');
  expect(add).toContain('添加设备…');
  expect(add).not.toContain('disabled');
  expect(manage).toContain('管理设备…');
});

it('is not there without the shell\'s devices (the web keeps its brand)', () => {
  expect(render(localOnly, {...fakeShell(), devices: undefined})).toBe('');
  expect(render(remote, {...fakeShell(), devices: undefined})).toBe('');
});

it('replaces the brand at the top-left, and the brand stays when no switcher is given', () => {
  for (const firstUse of [false, true]) {
    const shell = (deviceSwitcher?: ReactElement) => renderToStaticMarkup(<AppShell page="home" view="agents" title="此刻" firstUse={firstUse} onNavigate={() => {}} onOpenList={() => {}}
      deviceSwitcher={deviceSwitcher}><p/></AppShell>);
    const html = shell(<span className="probe-switcher"/>);
    const header = html.slice(html.indexOf('today-app-header'), html.indexOf('</header>'));
    expect(header.indexOf('probe-switcher')).toBeGreaterThan(0);
    expect(header.indexOf('probe-switcher')).toBeLessThan(header.indexOf('today-header-actions'));
    if (!firstUse) expect(header.indexOf('probe-switcher')).toBeLessThan(header.indexOf('主要导航'));
    expect(header.slice(header.indexOf('today-header-actions'))).not.toContain('probe-switcher');
    expect(header).not.toContain('today-brand');
    expect(header).not.toContain('Vonvon Bot 此刻');
    const web = shell();
    expect(web).toContain('class="today-brand"');
    expect(web).toContain('aria-label="Vonvon Bot 此刻"');
    expect(web).toContain('<strong>Vonvon Bot</strong>');
    expect(web).not.toContain('device-switcher');
  }
});

type Element = ReactElement<Record<string, any>>;
const tree = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(tree)
  : isValidElement<Record<string, any>>(node) ? [node, ...tree(node.props.children)] : [];

it('offers ← 此刻 in first use on the desktop, where neither the tabs nor the brand lead home', () => {
  const back = (page: Page, {firstUse = true, switcher = true} = {}) => {
    const onNavigate = vi.fn();
    const shell = AppShell({page, view: 'agents', title: '页面', firstUse, onNavigate, onOpenList: () => {},
      deviceSwitcher: switcher ? <span className="probe-switcher"/> : undefined, children: <p/>});
    const row = tree(shell).find(node => node.type === BackButton);
    return {html: row && renderToStaticMarkup(row), click: () => {row?.props.onClick(); return onNavigate.mock.calls;}};
  };
  // 设置 itself, and the Bot / 群组 lists that search opens: nothing else leads back.
  for (const page of ['settings', 'collaboration'] as const) {
    expect(back(page).html).toContain('aria-label="返回此刻"');
    expect(back(page).click()).toEqual([['home']]);
  }
  expect(back('home').html).toBeUndefined();
  // A settings page keeps its way back to 设置, which then leads home.
  expect(back('devices').html).toContain('aria-label="返回设置"');
  expect(back('devices').html).not.toContain('此刻');
  expect(back('devices').click()).toEqual([['settings']]);
  // With the tabs, and on the web (the brand), nothing changes.
  expect(back('settings', {firstUse: false}).html).toBeUndefined();
  expect(back('settings', {switcher: false}).html).toBeUndefined();
});

it('shows the device being looked at, and lists them all with a way to add and manage', () => {
  const html = render(remote);
  expect(html).toContain('当前设备：机房，点击切换');
  expect(html).toContain('title="机房 · 在线"');
  expect(html).toContain('data-tone="green"');
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-expanded="false"');
  const menu = menuOf(remote);
  expect(menu).toContain('role="menu"');
  expect(menu.match(/role="menuitem"/g)).toHaveLength(5);
  expect(menu.match(/data-current/g)).toHaveLength(1);
  const [computer, server, home, add, manage] = items(menu);
  for (const row of [computer, server, home]) expect(row).toContain('device-tile');
  expect(computer).toContain('这台电脑');
  expect(computer).not.toContain('当前');
  expect(server).toContain('data-current="true"');
  expect(server.indexOf('当前')).toBeGreaterThan(server.indexOf('机房'));
  expect(server).toContain('在线');
  expect(home).toContain('家里');
  expect(home).not.toContain('当前');
  expect(home).toContain('上次在线 5 分钟前');
  expect(add).toContain('添加设备…');
  expect(manage).toContain('管理设备…');
  expect(menu.indexOf('添加设备…')).toBeGreaterThan(menu.lastIndexOf('家里'));
  expect(menu.indexOf('添加设备…')).toBeLessThan(menu.indexOf('管理设备…'));
});

it('tints the trigger on a remote device and says when it is reconnecting', () => {
  expect(render(remote)).toContain('data-remote="true"');
  expect(render(devicesState({id: 'local'}))).not.toContain('data-remote');
  expect(render(localOnly)).not.toContain('data-remote');
  expect(render(remote)).not.toContain('device-switcher__state');
  const reconnecting = devicesState({id: A, phase: 'reconnecting', mode: 'full', serverInfo: info()}, {[A]: {status: 'reconnecting'}});
  const html = render(reconnecting);
  expect(html).toContain('data-tone="yellow"');
  expect(html).toContain('· 重连中');
  expect(html).toContain('title="机房 · 重连中"');
  expect(html).toContain('data-remote="true"');
});

it('greys out 添加设备… for the same reasons as the page', () => {
  const add = items(menuOf(devicesState({id: A}, {}, {secureStorage: false})))[3]!;
  expect(add).toContain('添加设备…');
  expect(add).toContain('disabled=""');
  expect(add).toContain(`title="${linkPreviewCopy('no_secure_storage', '')}"`);
  const manage = items(menuOf(devicesState({id: A}, {}, {secureStorage: false})))[4]!;
  expect(manage).not.toContain('disabled');
});

it('keeps account actions below device actions with the user profile', () => {
  const profile = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: 'Clay', provider: 'github', persistence: 'secure'} as const;
  const renderMenu = (status: typeof profile | {kind: 'signedOut'}) => renderToStaticMarkup(<DeviceSwitcherMenu state={remote} now={Date.now()} onPick={() => {}} onAdd={() => {}} onManage={() => {}}
    account={{status, supported: true, onLogin: () => {}, onManage: () => {}}}/>);
  const signedIn = renderMenu(profile);
  expect(signedIn.indexOf('Clay')).toBeGreaterThan(signedIn.indexOf('管理设备…'));
  expect(signedIn).toContain('账号管理');
  expect(signedIn).toContain('account-avatar');
  const signedOut = renderMenu({kind: 'signedOut'});
  expect(signedOut.indexOf('<strong>登录</strong>')).toBeGreaterThan(signedOut.indexOf('管理设备…'));
  expect(signedOut).not.toContain('网页登录');
});
