import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DevicesState} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider} from '../src/client-context';
import {DevicesPanel} from '../src/devices/DevicesPanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
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
