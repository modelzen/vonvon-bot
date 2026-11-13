import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {useActiveDevice, useClient} from '../src/client-context';
import {App} from '../src/App';
import {DesktopRootView} from '../src/devices/DesktopRoot';
import {A, devicesState, fakeShell, info, newClient} from './devices-fixture';

// devices-ui-1b 第 5 节 device-gate. main 必败: the desktop page had no devices.
const fallback = newClient();
function render(state: ReturnType<typeof devicesState> | undefined, shell = fakeShell()) {
  let client: unknown;
  const html = renderToStaticMarkup(<DesktopRootView state={state} fallback={fallback} shell={shell} renderApp={() => <AppProbe onClient={value => { client = value; }}/>}/>);
  return {html, client, shell};
}
function AppProbe({onClient}: {onClient: (client: unknown) => void}) {
  onClient(useClient());
  return <p>APP:{useActiveDevice().name}</p>;
}

it('shows App for this computer, and the web page without devices', () => {
  expect(render(devicesState({id: 'local'})).html).toContain('APP:这台电脑');
  const web = renderToStaticMarkup(<DesktopRootView fallback={fallback} shell={{}} renderApp={() => <p>WEB</p>}/>);
  expect(web).toBe('<p>WEB</p>');
});

it('keeps the window frame on every page outside App', () => {
  const states = [undefined, devicesState({id: A, phase: 'connecting'}), devicesState({id: A, phase: 'failed', failure: {code: 'client_revoked', attempts: [], at: 1}}),
    devicesState({id: A, phase: 'ready', mode: 'maintenance', serverInfo: info('0.10.0', 3)})];
  const pages = states.map(state => render(state).html);
  expect(pages[0]).toContain('正在打开 Vonvon Bot…');
  for (const html of pages) {
    expect(html).toContain('device-outside-window');
    expect(html).toContain('desktop-titlebar');
    expect(html).not.toContain('APP:');
  }
});

it('keeps local account settings reachable through connection, maintenance and snapshot gates', () => {
  const account = {status: vi.fn(async () => ({kind: 'signedOut' as const})), onStatus: vi.fn(() => () => {}), login: vi.fn(), cancelLogin: vi.fn(), logout: vi.fn()};
  const shell = {...fakeShell(), account};
  const states = [undefined, devicesState({id: A, phase: 'failed'}),
    devicesState({id: A, phase: 'ready', mode: 'maintenance', serverInfo: info('0.10.0', 3)}),
    devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}), devicesState({id: 'local'})];
  for (const state of states) {
    const html = renderToStaticMarkup(<DesktopRootView state={state} fallback={fallback} shell={shell} renderApp={() => <App/>}/>);
    expect(html).toContain('账号设置');
  }
  expect(shell.devices.switchTo).not.toHaveBeenCalled();
});

it('says it is connecting, then why it cannot', () => {
  expect(render(devicesState({id: A, phase: 'connecting'})).html).toContain('正在连接「机房」…');
  const failing = render(devicesState({id: A, phase: 'connecting', attempt: 1, retryAt: Date.now() + 5_000,
    failure: {code: 'unreachable', attempts: [{route: {host: '100.64.0.10', port: 7767, kind: 'tailscale'}, code: 'unreachable'}], at: 1}})).html;
  expect(failing).toContain('连不上「机房」');
  expect(failing).toContain('tailscale ping 100.64.0.10');
  expect(failing).toContain('秒后再试一次');
  expect(failing).toContain('现在重试');
  expect(failing).toContain('推荐用 Tailscale');
});

it('gives the network advice only for a network failure', () => {
  const tailscale = {route: {host: '100.64.0.10', port: 7767, kind: 'tailscale' as const}};
  const revoked = render(devicesState({id: A, phase: 'failed', failure: {code: 'client_revoked', attempts: [{...tailscale, code: 'client_revoked'}], at: 1}})).html;
  expect(revoked).not.toContain('tailscale ping');
  expect(revoked).not.toContain('推荐用 Tailscale');
  const closed = render(devicesState({id: A, phase: 'connecting', attempt: 1, failure: {code: 'closed', attempts: [{...tailscale, code: 'closed'}], at: 1}})).html;
  expect(closed).toContain('tailscale ping 100.64.0.10');
  expect(closed).toContain('推荐用 Tailscale');
});

it('says the device took this computer off, with what to do next', () => {
  const html = render(devicesState({id: A, phase: 'failed', failure: {code: 'client_revoked', attempts: [], at: 1}}, {[A]: {status: 'revoked'}})).html;
  expect(html).toContain('已取消这台电脑的访问');
  expect(html).toContain('重新配对');
  expect(html).toContain('回到这台电脑');
  expect(html).toContain('已撤销');
  expect(html).not.toContain('现在重试');
  expect(html).not.toContain('再试一次');
  const key = render(devicesState({id: A, phase: 'failed', failure: {code: 'key_unreadable', attempts: [], at: 1}})).html;
  expect(key).toContain('再试一次');
  // A 4005 before message 2 can be forged: this attempt's result, tried again from here too (Codex 审查 235-2).
  const identity = render(devicesState({id: A, phase: 'failed', failure: {code: 'identity_changed', attempts: [], at: 1}})).html;
  expect(identity).toContain('身份和配对时不一样了');
  expect(identity).toContain('重新配对');
  expect(identity).toContain('再试一次');
});

it('keeps only the device list and the upgrade when the protocols differ', () => {
  const old = render(devicesState({id: A, phase: 'ready', mode: 'maintenance', serverInfo: info('0.9.0', 1)}, {}, {client: {version: '0.10.0', protocolVersion: 3}})).html;
  expect(old).toContain('「机房」和这台电脑的版本不能一起工作');
  expect(old).toContain('两边不能一起工作。升级服务端后才能继续管理。');
  expect(old).toContain('还不能从这里升级');
  expect(old).toContain('家里');
  const v1 = render(devicesState({id: A, phase: 'ready', mode: 'maintenance', serverInfo: info('0.7.4', 1, null)})).html;
  expect(v1).toContain('不支持远程管理');
  expect(v1).not.toContain('还不能从这里升级');
  const clientOld = render(devicesState({id: A, phase: 'ready', mode: 'maintenance', serverInfo: info('0.10.0', 3)})).html;
  expect(clientOld).toContain('先更新这台电脑上的应用');
});

it('keeps the page while the same device reconnects', () => {
  expect(render(devicesState({id: A, phase: 'reconnecting', mode: 'full', serverInfo: info()})).html).toContain('APP:机房');
});

it('gives each device page the client bound to that device', () => {
  const shell = fakeShell();
  const local = render(devicesState({id: 'local'}), shell);
  const remote = render(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}), shell);
  expect(shell.devices.clientFor.mock.calls.map(call => call[0])).toEqual(['local', A]);
  expect(remote.client).toBe(shell.devices.clientFor.mock.results[1]!.value);
  expect(local.client).not.toBe(remote.client);
  expect(remote.client).not.toBe(fallback);
});

// 0.9.0 Mac 验收 B-1 and S-4: App with no snapshot yet was a bare loading line, with no way to another device or to 启动 daemon.
it('keeps the way out while App waits for its first snapshot', () => {
  const app = (state: ReturnType<typeof devicesState>, shell = fakeShell()) =>
    renderToStaticMarkup(<DesktopRootView state={state} fallback={fallback} shell={shell} renderApp={() => <App/>}/>);
  const remote = app(devicesState({id: A, phase: 'ready', mode: 'full', serverInfo: info()}));
  expect(remote).toContain('正在打开「机房」…');
  expect(remote).toContain('回到这台电脑');
  expect(remote).toContain('家里');
  expect(remote).not.toContain('现在重试');
  expect(app(devicesState({id: A, phase: 'reconnecting', mode: 'full', serverInfo: info()}))).toContain('现在重试');
  // This computer online: the snapshot comes over IPC in a moment, so only the line.
  const online = app(devicesState({id: 'local'}));
  expect(online).toContain('正在打开 Vonvon Bot…');
  expect(online).not.toContain('device-outside-window');
  const down = app(devicesState({id: 'local'}, {local: {status: 'offline'}}), {...fakeShell(), startHost: vi.fn()});
  expect(down).toContain('这台电脑的 daemon 没有连上');
  expect(down).toContain('启动 daemon');
  expect(down).toContain('机房');
  expect(down).not.toContain('回到这台电脑');
  expect(app(devicesState({id: 'local'}, {local: {status: 'connecting'}}))).toContain('正在重新连接这台电脑的 daemon…');
});
