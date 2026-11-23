import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactNode, type ReactElement} from 'react';
import {desktopSnapshotSchema} from '@vonvon/protocol';
import {SelectJoinBotDialog} from '../src/SelectJoinBotDialog';
const h = vi.hoisted(() => ({selected: undefined as unknown}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: () => [h.selected, (next: unknown) => {h.selected = next;}]}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];
}
const snapshot = desktopSnapshotSchema.parse({revision: 1, observedAt: 0, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.7.14'}, agents: ['cli_first', 'cli_second', 'cli_stopped'].map((id, i) => ({id, name: id, enabled: i < 2, running: i < 2, connection: 'connected', activation: 'active'})), groups: [], memberships: [], tools: [], jobs: [], application: {platform: 'macos', version: '0.7.14', loginItem: false, dataPath: '/tmp/join-picker'}});
beforeEach(() => {h.selected = undefined;});
function render(data = snapshot) {
  const onSelect = vi.fn();
  const dialog = SelectJoinBotDialog({snapshot: data, onSelect, onClose: vi.fn()});
  expect(dialog.props.description).toBe('选择后，继续创建或连接群聊。');
  const next = nodes(dialog.props.footer).find(node => node.props.children === '下一步')!;
  return {options: nodes(dialog).filter(node => node.type === 'input'), next, onSelect};
}
it('requires a deliberate Bot choice, then continues with that Bot id', () => {
  let view = render();
  expect(view.next.props.disabled).toBe(true);
  expect(view.options.map(option => option.props.checked)).toEqual([false, false, false]);
  view.options[1]!.props.onChange();
  view = render();
  expect(view.next.props.disabled).toBe(false);
  view.next.props.onClick();
  expect(view.onSelect).toHaveBeenCalledWith('cli_second');
});
it('blocks stopped or unreadable Bots and invalidates a choice removed by a live refresh', () => {
  const view = render();
  expect(view.options[2]!.props.disabled).toBe(true);
  view.options[0]!.props.onChange();
  const changed = render({...snapshot, agents: snapshot.agents.slice(1)});
  expect(changed.next.props.disabled).toBe(true);
  changed.next.props.onClick();
  expect(changed.onSelect).not.toHaveBeenCalled();
  const unreadable = render({...snapshot, agents: snapshot.agents.map(agent => ({...agent, readError: 'bad config'}))});
  expect(unreadable.options.every(option => option.props.disabled)).toBe(true);
});
