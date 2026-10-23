import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {DirectoryReply, DirectoryRequest} from '@vonvon/protocol';
import {DirectoryPickerProvider} from '../src/directory-picker';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, pending: [] as Array<() => void>, client: {directory: vi.fn()},
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const index = harness.stateIndex++; if (!(index in harness.state)) harness.state[index] = typeof initial === 'function' ? initial() : initial; return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];},
  useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= {current: initial},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const index = harness.effectIndex++; const old = harness.effects[index]; if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return; harness.pending.push(() => {old?.cleanup?.(); harness.effects[index] = {deps, cleanup: effect() || undefined};});},
}));
vi.mock('../src/client-context', () => ({useClient: () => harness.client, useShellCapabilities: () => undefined}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];}
function render() {
  harness.stateIndex = harness.refIndex = harness.effectIndex = 0;
  const provider = DirectoryPickerProvider({children: null});
  const all = nodes(provider);
  for (const effect of harness.pending.splice(0)) effect();
  return {
    pickers: provider.props.value, all,
    button: (text: string) => all.find(node => node.props.children === text && node.props.onClick)!,
    checkbox: (name: string) => all.find(node => node.type === 'input' && node.props['aria-label'] === name)!,
    directory: (name: string) => all.find(node => node.type === 'button' && nodes(node.props.children).some(child => child.type === 'span' && child.props.children === name))!,
    location: all.find(node => node.props.className === 'directory-browser-location'),
  };
}
async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve();}
async function settle() {await flush(); render(); await flush(); return render();}
function listing(path: string, names: string[], parent: string | null = '/'): DirectoryReply {return {kind: 'entries', path, parent, truncated: false, entries: names.map(name => ({name, path: `${path}/${name}`, hidden: false}))};}
const chosen = (path: string) => ({kind: 'folderChosen', folder: {token: '00000000-0000-4000-8000-000000000001', displayPath: path}});
beforeEach(() => {
  for (const effect of harness.effects) effect.cleanup?.();
  harness.state = []; harness.refs = []; harness.effects = []; harness.pending = []; vi.clearAllMocks();
  harness.client.directory.mockImplementation(async (request: DirectoryRequest) => request.type === 'choose' ? chosen(request.path)
    : request.path === '/root/b' ? listing('/root/b', ['child'], '/root') : listing('/root', ['a', 'b']));
});
it('keeps multi-selection across browsing and admits exactly the selected directories', async () => {
  const result = render().pickers.multiple(); render(); let ui = await settle();
  ui.checkbox('选择 a').props.onChange(); ui = render();
  ui.directory('b').props.onClick(); render(); ui = await settle();
  ui.checkbox('选择 child').props.onChange(); ui = render();
  const back = ui.all.find(node => node.props['aria-label'] === '上一级目录')!;
  back.props.onClick(); render(); ui = await settle();
  expect(ui.checkbox('选择 a').props.checked).toBe(true);
  expect(ui.all.filter(node => node.type === 'code').map(node => node.props.children)).toEqual(expect.arrayContaining(['/root/a', '/root/b/child']));
  expect(harness.client.directory.mock.calls.filter(([request]) => request.type === 'choose')).toEqual([]);
  ui.button('添加所选目录').props.onClick(); await flush();
  expect((await result)?.map(folder => folder.displayPath)).toEqual(['/root/a', '/root/b/child']);
  expect(harness.client.directory.mock.calls.filter(([request]) => request.type === 'choose').map(([request]) => request.path)).toEqual(['/root/a', '/root/b/child']);
  expect(render().all.some(node => node.props.open)).toBe(false);
});
it('keeps the last successfully read path during failed navigation and never chooses the failed path', async () => {
  const result = render().pickers.single(); render(); let ui = await settle();
  let reject!: (error: Error) => void;
  harness.client.directory.mockImplementation((request: DirectoryRequest) => request.type === 'choose' ? Promise.resolve(chosen(request.path)) : new Promise((_resolve, fail) => {reject = fail;}));
  ui.directory('b').props.onClick(); ui = render();
  expect(nodes(ui.location).find(node => node.type === 'code')?.props.children).toBe('/root');
  expect(render().button('选择此目录').props.disabled).toBe(true);
  reject(new Error('无权读取')); ui = await settle();
  expect(nodes(ui.location).find(node => node.type === 'code')?.props.children).toBe('/root');
  expect(ui.all.some(node => node.props.children === '无权读取')).toBe(true);
  ui.button('选择此目录').props.onClick(); await flush();
  expect((await result)?.displayPath).toBe('/root');
  expect(harness.client.directory).toHaveBeenLastCalledWith({type: 'choose', path: '/root'});
});
it('cancels without admitting directories and starts the next picker with an empty selection', async () => {
  const result = render().pickers.multiple(); render(); let ui = await settle();
  ui.checkbox('选择 a').props.onChange(); ui = render(); ui.button('取消').props.onClick();
  expect(await result).toBeNull();
  expect(harness.client.directory.mock.calls.some(([request]) => request.type === 'choose')).toBe(false);
  const next = render().pickers.multiple(); render(); ui = await settle();
  expect(ui.checkbox('选择 a').props.checked).toBe(false);
  expect(ui.button('添加所选目录').props.disabled).toBe(true);
  ui.button('取消').props.onClick(); expect(await next).toBeNull();
});
