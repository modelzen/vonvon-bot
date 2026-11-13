import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type KeyboardEvent, type ReactElement, type RefObject} from 'react';
import type {AccountStatus} from '@vonvon/protocol';
import {DeviceSwitcher, DeviceSwitcherMenu} from '../src/devices/DeviceSwitcher';
import {AddDeviceDialog} from '../src/devices/AddDeviceDialog';
import {AccountAvatar} from '../src/accounts/AccountAvatar';
import {AccountMenuItem} from '../src/accounts/AccountMenuItem';
import {A, devicesState, fakeShell, info} from './devices-fixture';

const h = vi.hoisted(() => ({state: [] as unknown[], refs: [] as Array<{current: unknown}>, pending: [] as Array<() => void>, si: 0, ri: 0,
  devices: undefined as unknown, deviceState: undefined as unknown, navigate: vi.fn((action: () => void) => action()),
  account: {supported: true, status: {kind: 'signedOut'} as AccountStatus, login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
  useEffect: (effect: () => void) => {h.pending.push(effect);},
}));
vi.mock('../src/client-context', () => ({useDevicesState: () => h.deviceState, useShellCapabilities: () => ({devices: h.devices}), useActiveDevice: () => ({isRemote: false})}));
vi.mock('../src/account-context', async original => ({...await original<typeof import('../src/account-context')>(), useAccount: () => h.account}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: h.navigate})}));
vi.mock('../src/devices/device-bits', async original => ({...await original<typeof import('../src/devices/device-bits')>(), useDismiss: () => {}, useNow: () => Date.now()}));

type Element = ReactElement<Record<string, any>>;
const nodes = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];
const onManage = vi.fn(); const onAccount = vi.fn();
function render() {h.si = h.ri = 0; return nodes(DeviceSwitcher({onManage, onAccount}));}
function open() {render().find(node => node.props.className === 'device-switcher__button')!.props.onClick({detail: 0}); return render().find(node => node.type === DeviceSwitcherMenu)!;}
beforeEach(() => {
  h.state = []; h.refs = []; h.pending = [];
  h.deviceState = devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}); h.devices = fakeShell().devices;
  h.account.status = {kind: 'signedOut'};
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it('opens native login directly from the account row and keeps signed-in management separate', () => {
  open().props.account.onLogin();
  expect(h.account.login).toHaveBeenCalledOnce();
  expect(onManage).not.toHaveBeenCalled(); expect(onAccount).not.toHaveBeenCalled();
  expect(render().some(node => node.type === DeviceSwitcherMenu)).toBe(false);
  h.account.status = {kind: 'signedIn', accountId: '11111111-1111-4111-8111-111111111111', displayName: 'Clay', provider: 'github', persistence: 'secure'};
  expect(render().some(node => node.type === AccountAvatar)).toBe(true);
  expect(render().some(node => node.props.className === 'device-switcher__logo')).toBe(false);
  open().props.account.onManage();
  expect(onAccount).toHaveBeenCalledOnce();
});

it('preserves add, manage and guarded device switching', () => {
  open().props.onAdd();
  expect(render().some(node => node.type === AddDeviceDialog)).toBe(true);
  render().find(node => node.type === AddDeviceDialog)!.props.onClose();
  open().props.onManage(); expect(onManage).toHaveBeenCalledOnce();
  open().props.onPick('local');
  expect(h.navigate).toHaveBeenCalledOnce();
  expect((h.devices as ReturnType<typeof fakeShell>['devices']).switchTo).toHaveBeenCalledWith('local');
});

it('includes the account row in menu keyboard movement and returns focus on Shift+Tab', () => {
  const focus = vi.fn();
  const buttons = Array.from({length: 6}, (_, index) => ({focus: () => {focus(index); (document as unknown as {activeElement: unknown}).activeElement = buttons[index];}}));
  vi.stubGlobal('document', {activeElement: null});
  const menu = {current: {querySelectorAll: vi.fn(() => buttons)}};
  h.si = h.ri = 0;
  const onLeave = vi.fn();
  const element = DeviceSwitcherMenu({state: h.deviceState as ReturnType<typeof devicesState>, now: Date.now(), onPick: vi.fn(), onAdd: vi.fn(), onManage: vi.fn(), onLeave,
    menuRef: menu as unknown as RefObject<HTMLDivElement | null>, autoFocus: 'first', account: {supported: true, status: {kind: 'signedOut'}, onLogin: vi.fn(), onManage: vi.fn()}});
  const menuNodes = nodes(element).flatMap(node => node.type === AccountMenuItem ? nodes(AccountMenuItem(node.props)) : [node]);
  const rows = menuNodes.filter(node => node.props.role === 'menuitem');
  expect(rows).toHaveLength(buttons.length);
  for (const effect of h.pending.splice(0)) effect();
  expect(focus).toHaveBeenLastCalledWith(0);
  const key = (value: string, shiftKey = false) => {const preventDefault = vi.fn(); element.props.onKeyDown({key: value, shiftKey, preventDefault} as unknown as KeyboardEvent<HTMLDivElement>); return preventDefault;};
  expect(key('End')).toHaveBeenCalledOnce(); expect(focus).toHaveBeenLastCalledWith(5);
  key('ArrowDown'); expect(focus).toHaveBeenLastCalledWith(0);
  key('ArrowUp'); expect(focus).toHaveBeenLastCalledWith(5);
  key('Home'); expect(focus).toHaveBeenLastCalledWith(0);
  expect(key('Tab', true)).toHaveBeenCalledOnce(); expect(onLeave).toHaveBeenCalledOnce();
  expect(key('Tab')).not.toHaveBeenCalled();
});
