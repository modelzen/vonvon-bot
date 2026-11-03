import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevicesState} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider} from '../src/client-context';
import {DevicesPanel} from '../src/devices/DevicesPanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {settingAnchor} from '../src/search';
import {A, B, devicesState, fakeShell, info, newClient} from './devices-fixture';

// devices-ui-1b 第 5 节 devices-panel. main 必败: there was no devices page.
const render = (state: DevicesState) => renderToStaticMarkup(<ClientProvider client={newClient()} shell={fakeShell()} device={activeDeviceFrom(state)} devices={state}>
  <DraftGuardProvider><DevicesPanel/></DraftGuardProvider>
</ClientProvider>);
const rowOf = (html: string, id: 'local' | 'remote', index = 0) => html.split('<li class="device-row"').filter(part => part.includes(`data-device="${id}"`))[index] ?? '';

it('lists this computer first, then the devices with what each can do', () => {
  const html = render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}, {[B]: {status: 'revoked'}}));
  const local = rowOf(html, 'local');
  expect(local).toContain('这台电脑');
  expect(local).toContain('切换到');
  expect(local).not.toContain('删除');
  expect(local).not.toContain('改名');
  // no ⋯ menu on this computer's row
  expect(local).not.toContain('更多操作');
  const [a, b] = [rowOf(html, 'remote', 0), rowOf(html, 'remote', 1)];
  expect(a).toContain('机房');
  // the device shown is marked, with no 切换到 (it was a greyed-out button)
  expect(a).toContain('data-current="true"');
  expect(a).toContain('当前');
  expect(a).not.toContain('>切换到<');
  expect(a).not.toContain('重新配对');
  expect(b).toContain('家里');
  expect(b).toContain('重新配对');
  expect(b).toContain('data-tone="red"');
  expect(b).toContain('已撤销');
  // 改名 and 删除 sit behind the row's ⋯
  expect(b).toContain('role="menuitem"');
  expect(b).toContain('「家里」的更多操作');
  expect(html.indexOf('data-device="local"')).toBeLessThan(html.indexOf('data-device="remote"'));
  expect(html).toContain('推荐用 Tailscale');
  expect(html).toContain('一次看一台。');
});

it('greys out adding without the keychain, saying why', () => {
  const html = render(devicesState({id: 'local'}, {}, {secureStorage: false}));
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>添加设备<\/span>/);
  expect(html).toContain('这台电脑的系统钥匙串现在用不了');
});

it('says the list was broken and started again', () => {
  const html = render(devicesState({id: 'local'}, {}, {registry: 'recovered'}));
  expect(html).toContain('已另存一份');
  expect(html).not.toMatch(/disabled=""[^>]*><span>添加设备/);
});

// owner 2026-11-03: 允许别的设备连接 moved from 应用与启动 to here, under the list, still of the device shown. main 必败
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const SERVED = `id="${settingAnchor('允许别的设备连接')}"`;
it('puts 允许别的设备连接 of the device shown under the list', () => {
  const here = render(devicesState({id: 'local', phase: 'ready', mode: 'full'}));
  expect(here).toContain(SERVED);
  expect(here.indexOf('class="device-list"')).toBeGreaterThan(-1);
  expect(here.indexOf('class="device-list"')).toBeLessThan(here.indexOf(SERVED));
  expect(text(here)).toContain('允许别的设备连接本机');
  expect(here.match(/添加设备/g)).toHaveLength(1);
  // looking at 「机房」: the list is still this computer's, the block is 「机房」's
  const there = render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}));
  expect(text(there)).toContain('允许别的设备连接「机房」');
  expect(text(there)).not.toContain('允许别的设备连接本机');
});

it('gives the web page (no list) a 设备 page with only 允许别的设备连接', () => {
  const html = renderToStaticMarkup(<ClientProvider client={newClient()}><DraftGuardProvider><DevicesPanel/></DraftGuardProvider></ClientProvider>);
  expect(html).toContain('<h1>设备</h1>');
  expect(html).toContain(SERVED);
  expect(text(html)).toContain('允许别的设备连接本机');
  expect(html).not.toContain('添加设备');
  expect(html).not.toContain('device-list');
});

it('leaves 应用与启动 without 允许别的设备连接', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const page = app.slice(app.indexOf('page === "application" && ('), app.indexOf('page === "devices" &&'));
  expect(page).toContain('<UpdatePanel');
  expect(page).not.toMatch(/RemoteAccess/);
  expect(app).not.toMatch(/RemoteAccessPanel/);
  expect(app).toMatch(/page === "devices" && <DevicesPanel\/>/);
});
