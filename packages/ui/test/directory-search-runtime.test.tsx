import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {DirectoryReply, FolderChoice} from '@vonvon/protocol';
import {DirectorySearchStep} from '../src/DirectorySearchStep';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, pending: [] as Array<() => void>, client: {directory: vi.fn()},
  onChoose: vi.fn(), onBusyChange: vi.fn(),
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useId: () => 'directory-results',
  useState: (initial: unknown) => {const index = harness.stateIndex++; if (!(index in harness.state)) harness.state[index] = typeof initial === 'function' ? initial() : initial; return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];},
  useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= {current: initial},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const index = harness.effectIndex++; const old = harness.effects[index]; if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return; harness.pending.push(() => {old?.cleanup?.(); harness.effects[index] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/client-context', async original => ({...await original<typeof import('../src/client-context')>(), useActiveDevice: () => ({id: 'local', isRemote: false, name: '这台电脑', mode: 'full', capabilities: []}), useClient: () => harness.client}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children)];}
function render() {
  harness.stateIndex = harness.refIndex = harness.effectIndex = 0;
  const all = nodes(DirectorySearchStep({onChoose: harness.onChoose, onBusyChange: harness.onBusyChange}));
  for (const effect of harness.pending.splice(0)) effect();
  return {all, input: all.find(node => node.type === 'input')!, button: (label: string) => all.find(node => node.props.label === label)!,
    choose: all.filter(node => node.type === 'button' && node.props.className === 'join-directory-select')};
}
const suggestions = (names = ['alpha', 'beta'], parent: string | null = null): DirectoryReply => ({kind: 'suggestions', root: '/host', path: '/host', parent, truncated: false, entries: names.map(name => ({name, path: `/host/${name}`, hidden: false}))});
const folder = {token: '00000000-0000-4000-8000-000000000001', displayPath: '/host/beta'} as FolderChoice;
async function settle() {for (let i = 0; i < 8; i++) await Promise.resolve(); return render();}
async function load() {render(); await vi.advanceTimersByTimeAsync(200); return settle();}
function key(input: Element, key: string) {input.props.onKeyDown({key, nativeEvent: {}, currentTarget: {selectionStart: String(input.props.value).length}, preventDefault: vi.fn()});}
function unmount() {for (const effect of harness.effects) effect.cleanup?.(); harness.effects = [];}
beforeEach(() => {
  unmount(); harness.state = []; harness.refs = []; harness.pending = []; vi.clearAllMocks(); vi.useFakeTimers();
  harness.client.directory.mockImplementation(async request => request.type === 'suggest' ? suggestions() : {kind: 'folderChosen', folder});
});
afterEach(() => {unmount(); vi.useRealTimers();});

it('navigates keyboard suggestions and admits the selected path once, even with repeated Enter', async () => {
  let ui = await load();
  expect(harness.client.directory).toHaveBeenCalledWith({type: 'suggest', query: ''});
  key(ui.input, 'ArrowDown'); ui = render();
  key(ui.input, 'Enter'); key(ui.input, 'Enter'); await settle();
  expect(harness.client.directory.mock.calls.filter(([request]) => request.type === 'choose')).toEqual([[{type: 'choose', path: '/host/beta'}]]);
  expect(harness.onChoose).toHaveBeenCalledWith(folder);
});

it('browses a child with its chevron, keeps selection separate, and uses the server parent', async () => {
  let ui = await load();
  harness.client.directory.mockResolvedValue(suggestions(['child'], '/host'));
  ui.button('浏览 alpha 的子目录').props.onClick(); render(); await vi.advanceTimersByTimeAsync(200); ui = await settle();
  expect(harness.client.directory).toHaveBeenLastCalledWith({type: 'suggest', query: '/host/alpha/'});
  expect(harness.onChoose).not.toHaveBeenCalled();
  ui.button('上一级目录').props.onClick(); render(); await vi.advanceTimersByTimeAsync(200); await settle();
  expect(harness.client.directory).toHaveBeenLastCalledWith({type: 'suggest', query: '/host/'});
});

it('does not allow a stale result or an earlier request to replace the current query', async () => {
  let ui = await load();
  let oldReply!: (reply: DirectoryReply) => void;
  harness.client.directory.mockImplementationOnce(() => new Promise(resolve => {oldReply = resolve;}));
  ui.input.props.onChange({target: {value: 'old'}}); render(); await vi.advanceTimersByTimeAsync(200); ui = render();
  ui.input.props.onChange({target: {value: 'new'}}); ui = render();
  expect(ui.choose).toHaveLength(0);
  key(ui.input, 'Enter');
  harness.client.directory.mockResolvedValueOnce(suggestions(['new']));
  await vi.advanceTimersByTimeAsync(200); await settle();
  oldReply(suggestions(['old'])); ui = await settle();
  expect(ui.all.some(node => node.type === 'strong' && node.props.children === 'new')).toBe(true);
  expect(ui.all.some(node => node.type === 'strong' && node.props.children === 'old')).toBe(false);
  expect(harness.onChoose).not.toHaveBeenCalled();
});

it('shows read errors with retry and clears them after a successful retry', async () => {
  harness.client.directory.mockRejectedValueOnce(new Error('没有读取权限'));
  let ui = await load();
  expect(ui.all.some(node => node.props.role === 'alert')).toBe(true);
  expect(ui.choose).toHaveLength(0);
  ui.button('重试读取目录').props.onClick(); render(); await vi.advanceTimersByTimeAsync(200); ui = await settle();
  expect(ui.all.some(node => node.props.role === 'alert')).toBe(false);
  expect(ui.choose).toHaveLength(2);
});

it('shows dot-prefixed hidden directories by default and toggles them client-side unless explicitly queried', async () => {
  harness.client.directory.mockResolvedValue({
    kind: 'suggestions',
    root: '/host',
    path: '/host',
    parent: '/',
    truncated: false,
    entries: [
      {name: 'host', path: '/host', hidden: false},
      {name: 'Projects', path: '/host/Projects', hidden: false},
      {name: '.vonvon-bot', path: '/host/.vonvon-bot', hidden: true},
    ],
  });
  let ui = await load();
  expect(ui.choose).toHaveLength(3);
  expect(ui.all.some(node => node.props['data-hidden'] && node.props.role === 'option')).toBe(true);
  const toggle = ui.all.find(node => node.type === 'button' && node.props.className === 'join-directory-hidden-toggle')!;
  expect(toggle.props['aria-pressed']).toBe(true);
  toggle.props.onClick(); ui = render();
  expect(ui.choose).toHaveLength(2);
  expect(harness.client.directory).toHaveBeenCalledTimes(1);
  // Explicit dot prefix reveals hidden folders even while the toggle is off.
  ui.input.props.onChange({target: {value: '/host/.'}}); render(); await vi.advanceTimersByTimeAsync(200); ui = await settle();
  expect(ui.choose).toHaveLength(3);
});

it('ignores an in-flight choice when the parent cancels the step', async () => {
  const ui = await load();
  let resolve!: (value: DirectoryReply) => void;
  harness.client.directory.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
  ui.choose[0]!.props.onClick(); render();
  expect(harness.onBusyChange).toHaveBeenLastCalledWith(true);
  unmount(); resolve({kind: 'folderChosen', folder}); await Promise.resolve(); await Promise.resolve();
  expect(harness.onChoose).not.toHaveBeenCalled();
  expect(harness.onBusyChange).toHaveBeenLastCalledWith(false);
});
