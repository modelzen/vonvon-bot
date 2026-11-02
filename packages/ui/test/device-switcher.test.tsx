import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevicesState} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider} from '../src/client-context';
import {AppShell} from '../src/LocalShell';
import {DeviceSwitcher, DeviceSwitcherMenu} from '../src/devices/DeviceSwitcher';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {A, devicesState, fakeShell, info, localRow, newClient} from './devices-fixture';

// devices-ui-1b 第 5 节 device-switcher. main 必败: there was no switcher.
const render = (state: DevicesState) => renderToStaticMarkup(<ClientProvider client={newClient()} shell={fakeShell()} device={activeDeviceFrom(state)} devices={state}>
  <DraftGuardProvider><DeviceSwitcher onManage={() => {}}/></DraftGuardProvider>
</ClientProvider>);
const remote = devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()});

it('stays away until another device is added', () => {
  expect(render({...devicesState({id: 'local'}), devices: [{...localRow, current: true}]})).toBe('');
});

it('sits first among the header actions, before search, also on first use', () => {
  for (const firstUse of [false, true]) {
    const html = renderToStaticMarkup(<AppShell page="home" view="agents" title="此刻" firstUse={firstUse} onNavigate={() => {}} onOpenList={() => {}}
      deviceSwitcher={<span className="probe-switcher"/>}><p/></AppShell>);
    const actions = html.slice(html.indexOf('today-header-actions'));
    expect(actions.indexOf('probe-switcher')).toBeGreaterThan(0);
    expect(actions.indexOf('probe-switcher')).toBeLessThan(actions.indexOf('搜索设置'));
  }
});

it('shows the device being looked at, and lists them all with a way to manage', () => {
  const html = render(remote);
  expect(html).toContain('当前设备：机房，点击切换');
  expect(html).toContain('data-tone="green"');
  const menu = renderToStaticMarkup(<DeviceSwitcherMenu state={remote} now={Date.now()} onPick={() => {}} onManage={() => {}}/>);
  expect(menu.match(/role="menuitem"/g)).toHaveLength(4);
  expect(menu).toContain('这台电脑');
  expect(menu).toMatch(/机房<\/span><small>当前<\/small>/);
  expect(menu).not.toMatch(/家里<\/span><small>/);
  expect(menu.lastIndexOf('管理设备…')).toBeGreaterThan(menu.lastIndexOf('家里'));
});
