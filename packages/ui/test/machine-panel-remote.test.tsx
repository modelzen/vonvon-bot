import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import type {MachineReply, MachineRequestHandler} from '@vonvon/protocol';

const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0, effects: [] as Array<() => unknown>, devices: undefined as unknown}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const at = hooks.index++; if (!(at in hooks.state)) hooks.state[at] = initial; return [hooks.state[at], (next: unknown) => {hooks.state[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(hooks.state[at]) : next;}];},
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
  useRef: () => ({current: null}),
}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(), useShellCapabilities: () => undefined, useDevicesState: () => hooks.devices}));
import {MachinePanel} from '../src/management/MachinePanel';
import {devicesState} from './devices-fixture';

type Node = {props: Record<string, any>};
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing), ...nodes(node.props.footer)] : [];
const label = (node: Node) => [node.props.children].flat().filter(item => typeof item === 'string').join('');
/** The words in order, as the page would read: labels, then descriptions, footers and children. */
const text = (node: ReactNode): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('')
  : isValidElement<Record<string, any>>(node) ? ['label', 'title', 'description', 'value', 'footer', 'children', 'trailing'].map(key => text(node.props[key])).join('') : '';
const dialog = (tree: ReactNode) => nodes(tree).find(node => 'open' in node.props && 'onClose' in node.props)!;
const running: Extract<MachineReply, {type: 'status'}> = {
  type: 'status', service: {platformName: 'systemd', installed: true, running: true, servicePath: '', stdoutPath: '', stderrPath: ''},
  host: {ownership: 'attached', pid: 42}, cli: {kind: 'ready', bin: '/usr/bin/vonvon', message: 'ready'},
};
const remote = {isRemote: true, name: '验收设备 1'};
function panel(props: {onRestart?: () => void; remote?: typeof remote; quitKeepsDaemon?: boolean}) {
  hooks.state = [];
  hooks.devices = undefined;
  const request = vi.fn<MachineRequestHandler>(async () => running);
  const render = () => { hooks.index = 0; hooks.effects = []; return MachinePanel({request, agents: [{id: 'a', name: 'A'}], ...props}); };
  render();
  hooks.state[0] = running; // the status the first read would have stored
  return {request, render};
}

// main 必败: a remote device got this computer's start buttons (devices-ui-2 4.4.4)
it('on a remote device shows [重启][停止] only, and restarts through the page', () => {
  const onRestart = vi.fn();
  const view = panel({remote, onRestart});
  const tree = view.render();
  const buttons = nodes(tree).filter(node => typeof node.props.onClick === 'function' && node.props.size === 'sm').map(label);
  for (const gone of ['启动 daemon', '启动服务', '仅运行此 Bot', '停止 daemon']) expect(buttons).not.toContain(gone);
  expect(buttons.indexOf('重启')).toBeGreaterThanOrEqual(0);
  expect(buttons.indexOf('重启')).toBeLessThan(buttons.indexOf('停止'));
  expect(text(tree)).toContain('这些设置作用在「验收设备 1」上。');
  nodes(tree).find(node => label(node) === '重启')!.props.onClick();
  expect(onRestart).toHaveBeenCalledOnce();
  expect(view.request).not.toHaveBeenCalled();
  nodes(view.render()).find(node => label(node) === '停止')!.props.onClick();
  const confirm = dialog(view.render());
  expect(confirm.props.open).toBe(true);
  expect(text(confirm.props.children)).toBe('停止「验收设备 1」的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。');
});

it('has no [重启] without onRestart', () => {
  const tree = panel({remote}).render();
  expect(nodes(tree).some(node => label(node) === '重启')).toBe(false);
});

// main 必败: quitting always said it stops the daemon (devices 7.4)
it('says quitting keeps a daemon installed and registered on its own, and keeps the old words otherwise', () => {
  const keeps = panel({quitKeepsDaemon: true});
  expect(text(keeps.render())).toContain('关闭桌面窗口时 Bot 继续运行。退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 vonvon daemon stop。');
  expect(text(dialog(keeps.render()).props.children)).toBe('停止服务会中断正在进行的对话。退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 vonvon daemon stop。');
  const stops = panel({});
  expect(text(stops.render())).toContain('关闭桌面窗口时 Bot 继续运行；手动退出桌面应用会停止后台和所有 Bot。');
  expect(text(dialog(stops.render()).props.children)).toBe('停止服务会中断正在进行的对话。关闭窗口不会停止后台；退出应用会停止后台和所有 Bot。');
});

// 0.9.0 Mac 验收 S-4: this computer's daemon stopped from outside; its settings said 状态未知 and 桌面端操作没有成功，请重试。
it('says this computer\'s daemon is stopped or connecting, without an error, while the shell has it down', async () => {
  hooks.state = [];
  const request = vi.fn<MachineRequestHandler>(async () => { throw new Error('桌面端操作没有成功，请重试。'); });
  const render = (props: {remote?: typeof remote} = {}) => { hooks.index = 0; hooks.effects = []; return MachinePanel({request, agents: [], ...props}); };
  const read = async () => { for (const effect of hooks.effects) effect(); await new Promise(resolve => setTimeout(resolve)); return text(render()); };
  hooks.devices = devicesState({id: 'local'}, {local: {status: 'offline'}});
  render();
  let page = await read();
  expect(page).toContain('运行方式接收飞书消息并运行 Bot。已停止');
  expect(page).toContain('后台没有连上，连上后再读取服务状态。');
  expect(page).not.toContain('状态未知');
  expect(page).not.toContain('桌面端操作没有成功');
  hooks.devices = devicesState({id: 'local'}, {local: {status: 'connecting'}});
  expect(await read()).toContain('运行方式接收飞书消息并运行 Bot。正在连接');
  // Another device is shown: its status is unknown, whatever this computer's is.
  expect(text(render({remote}))).toContain('状态未知');
  // A page with no devices (the web page) keeps the error.
  hooks.devices = undefined;
  page = await read();
  expect(page).toContain('状态未知');
  expect(page).toContain('桌面端操作没有成功，请重试。');
});
