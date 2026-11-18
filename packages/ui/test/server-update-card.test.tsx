import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import {RpcError} from '@vonvon/client/browser';
import type {MachineReply, MachineRequest} from '@vonvon/protocol';

const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0, effects: [] as Array<() => unknown>}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const at = hooks.index++; if (!(at in hooks.state)) hooks.state[at] = initial; return [hooks.state[at], (next: unknown) => {hooks.state[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(hooks.state[at]) : next;}];},
  useEffect: (effect: () => unknown) => {hooks.effects.push(effect);},
}));
import {ServerUpdateCard} from '../src/management/ServerUpdateCard';

type Node = {props: Record<string, any>};
const nodes = (node: ReactNode): Node[] => Array.isArray(node) ? node.flatMap(nodes)
  : isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing)] : [];
const words = (tree: ReactNode): string => nodes(tree).flatMap(node => [node.props.label, node.props.title, node.props.value, ...[node.props.children].flat()])
  .filter(value => typeof value === 'string').join('\n');
const where = {isRemote: true, name: '验收设备 1', version: '0.9.0'};
const core = (kind: string, hasUpdate = true): MachineReply => ({type: 'coreUpdate', distribution: {kind, cliPath: '/x'}, current: '0.9.0', latest: hasUpdate ? '0.9.1' : '0.9.0', hasUpdate, dev: false});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function card(reply: (operation: MachineRequest) => Promise<MachineReply>, at: typeof where & {capabilities?: string[]} = where) {
  hooks.state = []; hooks.effects = [];
  const request = vi.fn(reply);
  const render = () => { hooks.index = 0; hooks.effects = []; return ServerUpdateCard({request, variant: 'remote', where: at}); };
  return {request, render};
}
async function opened(reply: (operation: MachineRequest) => Promise<MachineReply>, at?: typeof where & {capabilities?: string[]}) {
  const view = card(reply, at);
  view.render();
  for (const effect of hooks.effects) effect();
  await tick();
  return view;
}

it.each([['standalone', '独立安装的服务端'], ['global-npm', '全局 npm 安装']])('shows a %s server of another device and offers its update', async (kind, label) => {
  const view = await opened(async () => core(kind));
  // Opening reads the device's daily check, without asking the update source again.
  expect(view.request).toHaveBeenCalledWith({type: 'checkCoreUpdate', fresh: false});
  const tree = view.render();
  const text = words(tree);
  expect(text).toContain('「验收设备 1」的服务端');
  expect(text).toContain(label);
  expect(text).toContain('0.9.1');
  const update = nodes(tree).find(node => node.props.children?.join?.('') === '更新「验收设备 1」');
  expect(update?.props.disabled).toBe(false);
  // owner 2026-11-02: the update does not wait for the turns, and the row says so.
  expect(nodes(tree).some(node => node.props.description === '更新会重启服务端，正在进行的对话会被中断。')).toBe(true);
});

// devices-ui-4: a Windows desktop app's server says nothing of `update.bundled` for 0.9.0 (owner 2026-11-02).
it('only says where a bundled server is updated when its desktop app cannot do it from here, with no update button', async () => {
  const view = await opened(async () => core('bundled'));
  const tree = view.render();
  expect(words(tree)).toContain('「验收设备 1」的服务端是桌面端自带的，请在那台电脑上打开 Vonvon Bot 更新。');
  expect(words(tree)).toContain('桌面端自带');
  expect(nodes(tree).some(node => typeof node.props.children?.join?.('') === 'string' && node.props.children.join('').startsWith('更新「验收设备 1」'))).toBe(false);
  expect(nodes(tree).some(node => node.props.title === '更新')).toBe(false);
});

const viaDesktop = {...where, capabilities: ['device', 'session-scope', 'update.bundled']};
const bundledButton = (tree: ReactNode) => nodes(tree).find(node => node.props.children?.join?.('') === '更新「验收设备 1」上的 Vonvon Bot');
const dialog = (tree: ReactNode) => nodes(tree).find(node => node.props.confirmLabel === '更新');

// devices-ui-4 第 4 节: the desktop app on that computer updates the server it carries, after a confirmation that says the
// restart interrupts the conversations. main 必败: no button, only the text.
it('updates a bundled server through its desktop app after a confirmation', async () => {
  const view = await opened(async operation => operation.type === 'applyCoreUpdate' ? {type: 'done', message: '开始更新…'} : {...core('bundled'), desktopShell: true}, viaDesktop);
  let tree = view.render();
  expect(words(tree)).not.toContain('请在那台电脑上打开 Vonvon Bot 更新');
  expect(words(tree)).toContain('0.9.1');
  expect(bundledButton(tree)?.props.disabled).toBe(false);
  expect(nodes(tree).some(node => node.props.description === '那台电脑上的桌面端会下载更新，然后直接重启，正在进行的对话会被中断。')).toBe(true);
  expect(dialog(tree)?.props.open).toBe(false);
  bundledButton(tree)?.props.onClick();
  tree = view.render();
  expect(dialog(tree)?.props).toMatchObject({open: true, title: '更新「验收设备 1」上的 Vonvon Bot？', description: expect.stringContaining('正在进行的对话会被中断')});
  expect(view.request).not.toHaveBeenCalledWith({type: 'applyCoreUpdate'});
  dialog(tree)?.props.onConfirm();
  await tick();
  expect(view.request).toHaveBeenCalledWith({type: 'applyCoreUpdate'});
  tree = view.render();
  expect(dialog(tree)?.props.open).toBe(false);
  expect(words(tree)).toContain('开始更新…');
  expect(bundledButton(tree)?.props.disabled).toBe(true);
});

it('says the desktop app there must be open, and still offers the button', async () => {
  const view = await opened(async () => ({...core('bundled', false), latest: null, desktopShell: false}), viaDesktop);
  const tree = view.render();
  expect(words(tree)).toContain('要那台电脑上的 Vonvon Bot 桌面端开着才能远程更新');
  expect(bundledButton(tree)?.props.disabled).toBe(false);
  // no version known from there: no 可用版本 row saying the update source is unavailable
  expect(words(tree)).not.toContain('更新源不可用');
});

it('shows what the desktop app there answered, as that device\'s', async () => {
  const view = await opened(async () => ({...core('bundled', false), latest: null, desktopShell: true, message: '这个安装包没有可用的签名更新源，请到官网下载新版本：https://vonvon.bot/get/'}), viaDesktop);
  const tree = view.render();
  expect(words(tree)).toContain('没有可用的签名更新源');
  expect(bundledButton(tree)).toBeUndefined();
});

it('shows only the version when the device cannot update remotely', async () => {
  const view = await opened(async () => { throw new RpcError('unsupported', 'unsupported'); });
  const text = words(view.render());
  expect(text).toContain('「验收设备 1」上的 Vonvon Bot 不支持远程更新，请在那台设备上升级一次。');
  expect(text).toContain('0.9.0');
  expect(text).not.toContain('安装方式');
});

// Following an update, in one mount and across mounts, is in server-update-card-lifecycle.test.tsx: its harness runs an
// effect again only when its deps change, which the opening read of the update record needs.
