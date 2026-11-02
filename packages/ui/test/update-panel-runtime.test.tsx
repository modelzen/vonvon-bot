import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode} from 'react';
import type {MachineReply, MachineRequest} from '@vonvon/protocol';

const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0}));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const at = hooks.index++; if (!(at in hooks.state)) hooks.state[at] = initial; return [hooks.state[at], (next: unknown) => {hooks.state[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(hooks.state[at]) : next;}];},
  useEffect: () => {},
}));
vi.mock('../src/desktop-update', () => ({useDesktopUpdate: () => [undefined, () => {}], useDesktopUpdateOperation: () => ({})}));
vi.mock('../src/client-context', () => ({useShellCapabilities: () => ({})}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()})}));
import {UpdatePanel} from '../src/management/UpdatePanel';
const nodes = (node: ReactNode): Array<{props: Record<string, any>}> => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children), ...nodes(node.props.trailing)] : [];
const replies: Record<string, MachineReply> = {coreUpdateStatus: {type: 'coreUpdateStatus', status: null},
  checkCoreUpdate: {type: 'coreUpdate', distribution: {kind: 'standalone', cliPath: '/x'}, current: '1.0.0', latest: '1.0.1', hasUpdate: true, dev: false}};
const button = (label: string) => {
  hooks.index = 0;
  const tree = UpdatePanel({request: async (operation: MachineRequest) => replies[operation.type]!, externalCoreAvailable: true, version: '1.0.0', device: 'Mac', children: null, advancedSettings: null});
  return nodes(tree).find(node => node.props.onClick && node.props.children === label)!;
};
// review 207: reading an empty progress record started following it, and the update button stayed off until a reload
it('keeps the Core update button on after reading an empty progress record', async () => {
  for (const step of ['检查 Core 更新', '查看 Core 更新进度']) {
    button(step).props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(button('更新外部 Core').props.disabled).toBe(false);
  }
});
