import {readFileSync} from 'node:fs';
import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DeviceStatus} from '@vonvon/protocol';
import {activeDeviceFrom, ClientProvider} from '../src/client-context';
import {DevicesPanel} from '../src/devices/DevicesPanel';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {devicesState, fakeShell, newClient} from './devices-fixture';

// owner 2026-11-03: 允许别的设备连接 is on 设备, under the list, which already says to use Tailscale: once on the page (审查 P3).
// A static render runs no effect, so the real block never gets past 正在读取…; this one has read a device with no Tailscale
// address, and shows what DevicesPanel asks of it.
const bare = vi.hoisted((): DeviceStatus => ({
  device: {id: 'd', name: '办公室 Mac', publicKey: 'k'}, clients: {total: 0, active: 0},
  remote: {port: 7767, addresses: [], candidates: [{host: '192.0.2.9', kind: 'lan', iface: 'eth0'}]},
}));
vi.mock('../src/settings/RemoteAccessPanel', async importOriginal => {
  const real = await importOriginal<typeof import('../src/settings/RemoteAccessPanel')>();
  const {useActiveDevice} = await import('../src/client-context');
  const {addressRows} = await import('../src/settings/remote-access-presentation');
  const noop = () => {};
  return {...real, RemoteAccessPanel: ({tailscaleAdvice}: {tailscaleAdvice?: boolean} = {}) => <real.RemoteAccessView
    where={useActiveDevice()} status={bare} rows={addressRows(bare)} now={0} busy={false} tailscaleAdvice={tailscaleAdvice}
    onPick={noop} onRefresh={noop} onEnable={noop} onDisable={noop} onReconfirm={noop} onPair={noop} onCopy={noop} onRename={noop} renameForm={() => null} onRevoke={noop}/>};
});
const ADVICE = /推荐用 Tailscale/g;

it('says to use Tailscale once on the desktop\'s 设备 page, and still on the web page\'s', () => {
  const state = devicesState({id: 'local', phase: 'ready', mode: 'full'});
  const desktop = renderToStaticMarkup(<ClientProvider client={newClient()} shell={fakeShell()} device={activeDeviceFrom(state)} devices={state}>
    <DraftGuardProvider><DevicesPanel/></DraftGuardProvider>
  </ClientProvider>);
  // the block has read (not 正在读取…), with no Tailscale address, under the list (修之前必败: it said it twice)
  expect(desktop).toContain('class="device-list"');
  expect(desktop).toContain('192.0.2.9');
  expect(desktop.match(ADVICE)).toHaveLength(1);
  expect(desktop.indexOf('推荐用 Tailscale')).toBeLessThan(desktop.indexOf('192.0.2.9'));
  // the web page has no list: the block says it
  const web = renderToStaticMarkup(<ClientProvider client={newClient()}><DraftGuardProvider><DevicesPanel/></DraftGuardProvider></ClientProvider>);
  expect(web).not.toContain('device-list');
  expect(web).toContain('192.0.2.9');
  expect(web.match(ADVICE)).toHaveLength(1);
  // and the real panel hands what it is asked to its view, which the static render cannot reach
  const source = readFileSync(new URL('../src/settings/RemoteAccessPanel.tsx', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('return <RemoteAccessView '), source.indexOf('onPick={setPicked}'));
  expect(call).toContain('tailscaleAdvice={tailscaleAdvice}');
});
