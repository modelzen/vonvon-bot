import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevicesState} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider} from '../src/client-context';
import {DeviceStatusBanner, DeviceVersionNotice} from '../src/devices/DeviceStatusBanner';
import {A, devicesState, fakeShell, info, newClient} from './devices-fixture';

// devices-ui-1b 第 5 节 device-status-banner. main 必败: a remote connection had no banner.
const render = (state: DevicesState) => renderToStaticMarkup(<ClientProvider client={newClient()} shell={fakeShell()} device={activeDeviceFrom(state)} devices={state}>
  <DeviceStatusBanner/><DeviceVersionNotice onUpgrade={() => {}}/>
</ClientProvider>);
const reconnecting = (extra: Partial<DevicesState['active']>) => devicesState({id: A, phase: 'reconnecting', mode: 'full', serverInfo: info(), ...extra});

it('says why the connection is gone, and what came back', () => {
  expect(render(reconnecting({expected: 'restart'}))).toContain('「机房」正在重启，好了会自动连上。');
  const disabled = render(reconnecting({disabledAt: 1, attempt: 2, failure: {code: 'refused', attempts: [{route: {host: '100.64.0.10', port: 7767, kind: 'tailscale'}, code: 'refused'}], at: 2}}));
  expect(disabled).toContain('「机房」关闭了远程连接');
  expect(disabled).not.toContain('可能没在运行');
  expect(disabled).toContain('现在重试');
  expect(render(reconnecting({retryAt: Date.now() + 8_000}))).toMatch(/正在重连（\d 秒后再试）/);
  const updated = render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info(), notice: {kind: 'updated', from: '0.9.0', to: '0.9.1', at: 1}}));
  expect(updated).toContain('「机房」已更新到 0.9.1。');
  expect(updated).toContain('关闭提示');
});

it('says nothing for this computer or a matching version', () => {
  expect(render(devicesState({id: 'local', serverInfo: info()}))).toBe('');
  expect(render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}))).toBe('');
});

it('notes another version without stopping anything, with a button only when it can upgrade', () => {
  const old = render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info('0.9.0', 2, ['device', 'update.standalone'])}));
  expect(old).toContain('建议升级服务端');
  expect(old).toContain('升级「机房」');
  expect(render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info('0.9.0', 2, ['device'])}))).not.toContain('升级「机房」');
  expect(render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info('0.9.3')}))).toContain('去更新');
});
