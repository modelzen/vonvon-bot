import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {DesktopSnapshot, MachineRequestHandler} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider, type ActiveDevice} from '../src/client-context';
import {appCardFor, UpdatePanel} from '../src/management/UpdatePanel';
import {RemoteServiceGroup} from '../src/management/RemoteServiceGroup';
import {ServerUpdateCard} from '../src/management/ServerUpdateCard';
import {DraftGuardProvider} from '../src/settings/DraftGuard';

const client = createClient({
  isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {},
  send: () => {}, close: async () => {},
});
const request: MachineRequestHandler = async () => { throw new Error('not in this test'); };
const device: ActiveDevice = {id: 'd1', isRemote: true, name: '验收设备 1', platform: 'linux', mode: 'full', version: '0.9.0', capabilities: ['device', 'update.standalone']};
const application = (platform: DesktopSnapshot['application']['platform'], service?: Partial<NonNullable<DesktopSnapshot['application']['service']>>) =>
  ({platform, version: '0.9.0', loginItem: false, dataPath: '/srv/vh', ...(service ? {service: {state: 'not-installed', skipped: false, ...service}} : {})}) as DesktopSnapshot['application'];

const page = (app: DesktopSnapshot['application']) => renderToStaticMarkup(
  <ClientProvider client={client} device={device}>
    <DraftGuardProvider>
      <UpdatePanel request={request} externalCoreAvailable={false} {...appCardFor(device, app, '0.9.1')}
        server={<ServerUpdateCard variant="remote" request={request} where={device}/>} advancedSettings={null}>
        <RemoteServiceGroup application={app} where={device} busy={false} onRestart={vi.fn()} onToggle={vi.fn()}/>
      </UpdatePanel>
    </DraftGuardProvider>
  </ClientProvider>,
);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

// main 必败: on a remote device the page showed the other device's version as this app's (devices-ui-2 4.4.1)
it('shows this computer\'s app with its own version, and the other device\'s server below', () => {
  const html = text(page(application('linux')));
  expect(html).toContain('这台电脑上的 Vonvon Bot 应用');
  expect(html).toContain('这台电脑 · v0.9.1');
  expect(html).not.toContain('外部 Core / CLI');
  expect(html).toContain('「验收设备 1」的服务端');
  expect(html).toContain('「验收设备 1」的后台服务');
  expect(html).toContain('退出这台电脑上的 Vonvon Bot 不影响「验收设备 1」。');
});

it('keeps this computer\'s app card as it was', () => {
  expect(appCardFor({isRemote: false}, {platform: 'macos', version: '0.9.0'}, '0.9.1')).toEqual({device: '这台 Mac', version: '0.9.0'});
});

it.each([
  ['macos', '登录电脑时启动'],
  ['linux', '在那台设备的终端运行 vonvon service install'],
  ['windows', '这一批 Windows 不做登录自启，那台电脑上的 Vonvon Bot 开着时才在线。'],
] as const)('says how a %s device starts at login', (platform, words) => {
  expect(text(page(application(platform, {})))).toContain(words);
});

it('adds the linger hint on Linux when linger is off', () => {
  expect(text(page(application('linux', {linger: 'off', hint: '没开 linger 的提示'})))).toContain('没开 linger 的提示');
});
