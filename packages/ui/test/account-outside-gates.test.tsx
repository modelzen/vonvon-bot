import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement} from 'react';
import type {AccountStatus, DevicesState} from '@vonvon/protocol';
import {CommunityWindow} from '../src/community/CommunityWindow';
import {DeviceGate, DesktopRootView} from '../src/devices/DesktopRoot';
import {DeviceConnectionView, DeviceOutsideFrame, SnapshotPendingView} from '../src/devices/DeviceConnectionView';
import {MaintenanceView} from '../src/devices/MaintenanceView';
import {AccountPageProvider} from '../src/accounts/account-page';
import {AccountMenuItem} from '../src/accounts/AccountMenuItem';
import {AccountPanel} from '../src/accounts/AccountPanel';
import {AccountAvatar} from '../src/accounts/AccountAvatar';
import {AddDeviceDialog} from '../src/devices/AddDeviceDialog';
import {Button} from '../src/reference/components/ui';
import {activeDeviceFrom} from '../src/client-context';
import {A, devicesState, fakeShell, info, newClient} from './devices-fixture';

const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, si: 0, ri: 0, deviceState: undefined as DevicesState | undefined, shell: undefined as ReturnType<typeof fakeShell> | undefined,
  account: {supported: true, status: {kind: 'signedOut'} as AccountStatus, login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()},
  community: {isOpen: false, open: vi.fn()},
  page: {isOpen: false, open: vi.fn(), close: vi.fn()},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useRef: (initial: unknown) => {const i = h.ri++; return h.refs[i] ??= {current: initial};},
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock('../src/community/community-context', async original => ({...await original<typeof import('../src/community/community-context')>(), useCommunity: () => h.community}));
vi.mock('../src/account-context', async original => ({...await original<typeof import('../src/account-context')>(), useAccount: () => h.account}));
vi.mock('../src/accounts/account-page', async original => ({...await original<typeof import('../src/accounts/account-page')>(), useAccountPage: () => h.page}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(),
  useDevicesState: () => h.deviceState, useShellCapabilities: () => h.shell,
  useActiveDevice: () => activeDeviceFrom(h.deviceState!), useClient: () => newClient(),
}));
vi.mock('../src/devices/device-bits', async original => ({...await original<typeof import('../src/devices/device-bits')>(), useNow: () => Date.now()}));

type Element = ReactElement<Record<string, any>>;
const nodes = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, any>>(node) ? [node, ...Object.values(node.props).flatMap(nodes)] : [];
function frame() {
  const gate = DeviceGate({state: h.deviceState!, renderApp: () => null});
  const view = gate.type === DeviceConnectionView ? DeviceConnectionView()
    : gate.type === MaintenanceView ? MaintenanceView() : SnapshotPendingView();
  expect(view!.type).toBe(DeviceOutsideFrame);
  h.si = 0;
  return nodes(DeviceOutsideFrame(view!.props));
}
function click(list: Element[], label: string) {list.find(node => node.type === Button && node.props.children === label)!.props.onClick();}
const identity = {kind: 'signedIn', accountId: A, displayName: 'Clay', provider: 'github', persistence: 'secure'} as const;

beforeEach(() => {
  h.state = []; h.refs = []; h.si = h.ri = 0; h.community.isOpen = false; h.shell = fakeShell(); h.page.isOpen = false; h.account.status = {kind: 'signedOut'};
  vi.clearAllMocks();
  h.page.open.mockImplementation(() => {h.page.isOpen = true;});
  h.page.close.mockImplementation(() => {h.page.isOpen = false;});
  h.account.login.mockImplementation(() => {h.account.status = {kind: 'signingIn'};});
  h.account.cancelLogin.mockImplementation(() => {h.account.status = {kind: 'signedOut', reason: 'cancelled'};});
  h.account.logout.mockImplementation(() => {h.account.status = {kind: 'signedOut'};});
});

it.each(['failed', 'maintenance', 'snapshot pending'] as const)('keeps account profile, login, cancellation and logout usable while %s', phase => {
  h.deviceState = devicesState({id: A, phase: phase === 'failed' ? 'failed' : 'ready', mode: phase === 'maintenance' ? 'maintenance' : 'full', serverInfo: info()});
  const entry = frame().find(node => node.type === AccountMenuItem)!;
  AccountMenuItem(entry.props).props.onClick();
  expect(h.account.login).toHaveBeenCalledOnce();
  click(frame(), '账号设置');
  expect(frame().some(node => node.type === AccountPanel)).toBe(true);
  click(nodes(AccountPanel()), '取消登录');
  expect(h.account.cancelLogin).toHaveBeenCalledOnce();
  h.account.status = identity;
  const signedInEntry = frame().find(node => node.type === AccountMenuItem)!;
  const profile = nodes(AccountMenuItem(signedInEntry.props)).find(node => node.type === AccountAvatar)!;
  expect(profile.props.identity).toEqual(identity);
  click(nodes(AccountPanel()), '退出登录');
  expect(h.account.logout).toHaveBeenCalledOnce();
  expect(h.deviceState.active.id).toBe(A);
  expect(h.shell!.devices.switchTo).not.toHaveBeenCalled();
  expect(h.shell!.devices.add).not.toHaveBeenCalled();
  click(frame(), '返回设备连接');
  expect(frame().some(node => node.type === AccountPanel)).toBe(false);
});

it('preserves the original add and other-device actions beside the account footer', () => {
  h.deviceState = devicesState({id: A, phase: 'failed'});
  click(frame(), '添加设备');
  expect(frame().some(node => node.type === AddDeviceDialog)).toBe(true);
  frame().find(node => node.type === AddDeviceDialog)!.props.onClose();
  click(frame(), '回到这台电脑');
  expect(h.shell!.devices.switchTo).toHaveBeenCalledExactlyOnceWith('local');
  frame().find(node => node.type === 'button' && node.props.title === '家里')!.props.onClick();
  expect(h.shell!.devices.switchTo).toHaveBeenCalledTimes(2);
  expect(h.page.isOpen).toBe(false);
});

it('keeps the window account route independent of the selected device connection', () => {
  const render = () => {h.si = 0; return AccountPageProvider({children: null}).props.value;};
  expect(render().isOpen).toBe(false);
  render().open();
  for (const phase of ['failed', 'ready', 'reconnecting'] as const) {
    h.deviceState = devicesState({id: A, phase});
    expect(render().isOpen).toBe(true);
  }
  render().close();
  expect(render().isOpen).toBe(false);
});

it('keeps community available outside device gates without opening any device controls', () => {
  h.deviceState = devicesState({id: A, phase: 'failed'});
  click(frame(), '浏览社区');
  expect(h.community.open).toHaveBeenCalledOnce();
  expect(h.shell!.devices.switchTo).not.toHaveBeenCalled();
  expect(h.shell!.devices.add).not.toHaveBeenCalled();
});

it.each(['failed', 'maintenance', 'unknown'] as const)('renders community through the %s device gate without a daemon snapshot', phase => {
  const state = phase === 'unknown' ? undefined : devicesState({id: A, phase: phase === 'failed' ? 'failed' : 'ready', mode: phase === 'maintenance' ? 'maintenance' : 'full'});
  h.community.isOpen = true;
  const root = DesktopRootView({state, shell: h.shell, fallback: newClient(), renderApp: () => <p>COMMUNITY-APP</p>});
  const device = root.props.children.props.children.props.children;
  const rendered = device.type(device.props);
  expect(nodes(rendered).some(node => node.type === CommunityWindow)).toBe(true);
  expect(nodes(rendered).some(node => node.type === DeviceGate)).toBe(false);
  expect(h.shell!.devices.switchTo).not.toHaveBeenCalled();
});
