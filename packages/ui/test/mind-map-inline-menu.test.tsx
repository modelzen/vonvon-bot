import {beforeEach, expect, it, vi} from 'vitest';
import {MindMap, type MapNode} from '../src/MindMap';
const h = vi.hoisted(() => ({state: [] as unknown[], index: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useId: () => 'map', useLayoutEffect: () => {}, useRef: (current: unknown) => ({current}),
  useState: (initial: unknown) => {const i = h.index++; if (!(i in h.state)) h.state[i] = initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? next(h.state[i]) : next;}];},
}));
beforeEach(() => {h.state = []; h.index = 0;});
const entry: MapNode = {id: 'item', kind: 'leaf', label: '记忆', menu: [{id: 'history', label: '详情与历史', onSelect: vi.fn()}]};
function render(beforeSelect?: (select: () => void) => void) {
  h.index = 0;
  const tree = MindMap({root: entry, label: 'map', inlineMenus: true, beforeSelect});
  return {tree, branch: tree.props.children[1]};
}
it('opens right-click operations as connected child nodes, then closes after executing an action', () => {
  render().branch.props.openMenu(entry);
  const branch = render().branch;
  const menu = branch.props.node.children[0] as MapNode;
  expect(menu.label).toBe('操作');
  expect(menu.children?.map(node => node.label)).toEqual(['详情与历史', '收起操作']);
  menu.children![0]!.onClick!();
  expect(entry.menu![0]!.onSelect).toHaveBeenCalledOnce();
  expect(render().branch.props.node.children).toBeUndefined();
});
it('waits for the draft boundary before opening actions or changing the active node', () => {
  const pending: Array<() => void> = [];
  const guard = (select: () => void) => pending.push(select);
  const page = render(guard);
  page.branch.props.openMenu(entry);
  expect(render(guard).branch.props.node.children).toBeUndefined();
  pending.shift()!();
  expect(render(guard).branch.props.node.children).toHaveLength(1);
  page.branch.props.select(entry);
  expect(render(guard).tree.props['aria-activedescendant']).toBeUndefined();
  pending.shift()!();
  expect(render(guard).tree.props['aria-activedescendant']).toBe('map-item');
});
