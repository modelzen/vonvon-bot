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

function card(reply: (operation: MachineRequest) => Promise<MachineReply>) {
  hooks.state = []; hooks.effects = [];
  const request = vi.fn(reply);
  const render = () => { hooks.index = 0; hooks.effects = []; return ServerUpdateCard({request, variant: 'remote', where}); };
  return {request, render};
}
async function opened(reply: (operation: MachineRequest) => Promise<MachineReply>) {
  const view = card(reply);
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
});

it('only says where a bundled server is updated, with no update button', async () => {
  const view = await opened(async () => core('bundled'));
  const tree = view.render();
  expect(words(tree)).toContain('「验收设备 1」的服务端是桌面端自带的，在那台电脑上的 Vonvon Bot 里更新。');
  expect(words(tree)).toContain('桌面端自带');
  expect(nodes(tree).some(node => node.props.children?.join?.('') === '更新「验收设备 1」')).toBe(false);
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
