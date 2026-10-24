import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {MemoryItem, MemoryReply} from '@vonvon/protocol';
import {MemoryMap} from '../src/MemoryMap';
import {MindMap, type MapNode} from '../src/MindMap';
import {MapInlineEditor} from '../src/MapInlineEditor';

type Effect = {deps?: unknown[]; cleanup?: () => void};
const h = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, memos: [] as Array<{deps?: unknown[]; value: unknown}>, effects: [] as Effect[], pending: [] as Array<() => void>,
  si: 0, ri: 0, mi: 0, ei: 0, client: {memory: vi.fn()},
}));
vi.mock('react', async original => {
  const memo = (factory: () => unknown, deps?: unknown[]) => {const i = h.mi++; const old = h.memos[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return old.value; const value = factory(); h.memos[i] = {value, deps}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
    useRef: (initial: unknown) => h.refs[h.ri++] ??= {current: initial},
    useMemo: memo, useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {old?.cleanup?.(); h.effects[i] = {deps, cleanup: effect() || undefined};});},
  };
});
vi.mock('../src/settings/DraftGuard', () => ({useInlineDraft: () => {}}));
vi.mock('../src/client-context', () => ({useClient: () => h.client, useShellCapabilities: () => ({})}));

type Element = ReactElement<Record<string, any>>;
function nodes(value: ReactNode): Element[] {if (Array.isArray(value)) return value.flatMap(nodes); if (!isValidElement<Record<string, any>>(value)) return []; return [value, ...nodes(value.props.children)];}
function item(id: string, branch = '发版', revision = 3): MemoryItem {return {
  id, scope: {kind: 'project', projectId: 'prj_1'}, text: `记忆 ${id}`, branch, state: 'active', trust: 'trusted',
  source: {via: 'ui', botId: 'bot_1', actorRole: 'desktop'}, createdAt: 1, updatedAt: 1, revision,
};}
function list(items: MemoryItem[]): MemoryReply {return {kind: 'list', scope: {kind: 'project', projectId: 'prj_1'}, items,
  branches: [{name: '决定', fixed: true, createdAt: 1, createdBy: 'system'}, {name: '发版', fixed: false, createdAt: 1, createdBy: 'owner'}],
  used: items.filter(entry => entry.state === 'active').length, limit: 100, verified: true, problems: [], newIds: [], newBranches: [], madeRoom: [],
} as MemoryReply;}
const props = {scope: {kind: 'project', projectId: 'prj_1'} as const, rootLabel: '项目', mode: 'direct' as const, memoryLabel: '项目记忆', targets: {botName: () => 'Bot', groupName: () => '群'}};
function renderPage(extra: Partial<Parameters<typeof MemoryMap>[0]> = {}) {
  h.si = h.ri = h.mi = h.ei = 0;
  const all = nodes(MemoryMap({...props, ...extra}));
  for (const effect of h.pending.splice(0)) effect();
  return {root: all.find(element => element.type === MindMap)!.props.root as MapNode, all};
}
function render(extra: Partial<Parameters<typeof MemoryMap>[0]> = {}) {return renderPage(extra).root;}
async function flush() {for (let i = 0; i < 10; i++) await Promise.resolve();}
const find = (root: MapNode, id: string): MapNode => {const walk = (entry: MapNode): MapNode[] => [entry, ...(entry.children ?? []).flatMap(walk)]; return walk(root).find(entry => entry.id === id)!;};
const editor = (node: MapNode) => {const content = node.content as Element; expect(content?.type).toBe(MapInlineEditor); return content.props;};
beforeEach(() => {
  h.state = []; h.refs = []; h.memos = []; h.effects = []; h.pending = []; vi.clearAllMocks();
  h.client.memory.mockImplementation(async (request: {type: string}) => request.type === 'list' ? list([item('a'), item('b')]) : {kind: 'seen'});
  vi.stubGlobal('window', {setInterval: () => 1, clearInterval: () => {}, dispatchEvent: () => {}});
});

it('keeps an empty existing leaf draft and validates without sending an edit', async () => {
  render(); await flush();
  find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  expect(await draft.onCommit('')).toBe(false);
  expect(editor(find(render(), 'i:a')).value).toBe('记忆 a');
  expect(h.client.memory.mock.calls.some(([request]) => request.type === 'edit')).toBe(false);
});

it('freezes the original revision through a conflict and leaves the draft mounted', async () => {
  let current = list([item('a'), item('b')]);
  h.client.memory.mockImplementation(async (request: {type: string}) => request.type === 'list' ? current : request.type === 'edit' ? (current = list([item('a', '发版', 4), item('b')]), {kind: 'conflict', message: 'changed'}) : {kind: 'seen'});
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  const key = (find(render(), 'i:a').content as Element).key;
  expect(await editor(find(render(), 'i:a')).onCommit('我的草稿')).toBe(false);
  const draft = editor(find(render(), 'i:a'));
  expect(draft.value).toBe('记忆 a');
  expect((find(render(), 'i:a').content as Element).key).toBe(key);
  expect(await draft.onCommit('继续修改')).toBe(false);
  const edits = h.client.memory.mock.calls.map(([request]) => request).filter(request => request.type === 'edit');
  expect(edits.map(request => request.revision)).toEqual([3, 3]);
});

it('an older async save cannot close a newly opened draft', async () => {
  let finish!: (reply: MemoryReply) => void;
  const pending = new Promise<MemoryReply>(resolve => {finish = resolve;});
  h.client.memory.mockImplementation(async (request: {type: string}) => request.type === 'list' ? list([item('a'), item('b')]) : request.type === 'edit' ? pending : {kind: 'seen'});
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  const beforeSave = render();
  const old = editor(find(beforeSave, 'i:a'));
  const switchToB = find(beforeSave, 'i:b').onEdit!;
  const saving = old.onCommit('改过的 a');
  switchToB();
  expect(editor(find(render(), 'i:b')).value).toBe('记忆 b');
  finish({kind: 'item', item: item('a')} as MemoryReply);
  expect(await saving).toBe(true);
  expect(editor(find(render(), 'i:b')).value).toBe('记忆 b');
});

it('stops category soft deletion after the first refusal and reports partial progress', async () => {
  const archive = vi.fn().mockResolvedValueOnce({kind: 'item', item: item('a', '发版', 4)}).mockResolvedValueOnce({kind: 'refused', reason: 'not-allowed', message: '不能删除 b'});
  h.client.memory.mockImplementation(async (request: {type: string}) => request.type === 'list' ? list([item('a'), item('b')]) : request.type === 'archive' ? archive(request) : {kind: 'seen'});
  render(); await flush(); find(render(), 'b:发版').onDelete?.(); await flush();
  const requests = archive.mock.calls.map(([request]) => request);
  expect(requests).toHaveLength(2);
  expect(requests.map(request => request.revision)).toEqual([3, 3]);
  expect(h.client.memory.mock.calls.some(([request]) => request.type === 'purge')).toBe(false);
  expect(h.state).toContain('已删除 1 条；不能删除 b，剩余条目未删除。');
});

it('runs the role draft guard before edit and add; typing a custom category supplies its first character', async () => {
  const blocked: Array<() => void> = [];
  const beforeLeafSelect = (action: () => void) => {blocked.push(action);};
  render({beforeLeafSelect}); await flush();
  let root = render({beforeLeafSelect});
  find(root, 'i:a').onEdit?.(); find(root, 'b:发版').onAdd?.();
  expect(blocked).toHaveLength(2);
  expect(find(render({beforeLeafSelect}), 'i:a').content).toBeUndefined();
  blocked[0]!();
  expect(editor(find(render({beforeLeafSelect}), 'i:a')).value).toBe('记忆 a');
  root = render({beforeLeafSelect}); find(root, 'b:发版').onEdit?.({text: '新'});
  blocked.at(-1)!();
  expect(editor(find(render({beforeLeafSelect}), 'b:发版')).value).toBe('新');
});

it.each(['keyboard', 'menu'] as const)('successful %s leaf archive clears that leaf selection, details and draft', async path => {
  let current = list([item('a'), item('b')]);
  h.client.memory.mockImplementation(async (request: {type: string}) => {
    if (request.type === 'list') return current;
    if (request.type === 'archive') {current = list([{...item('a', '发版', 4), state: 'archived'}, item('b')]); return {kind: 'item', item: {...item('a', '发版', 4), state: 'archived'}};}
    return {kind: 'seen'};
  });
  render(); await flush();
  let leaf = find(render(), 'i:a');
  leaf.onClick?.();
  leaf = find(render(), 'i:a');
  if (path === 'keyboard') {leaf.onEdit?.(); expect(find(render(), 'i:a').content).toBeDefined();}
  else {leaf.menu!.find(action => action.id === 'details')!.onSelect(); expect(find(render(), 'i:a').children?.length).toBeGreaterThan(0);}
  leaf = find(render(), 'i:a');
  if (path === 'keyboard') leaf.onDelete?.(); else leaf.menu!.find(action => action.id === 'delete')!.onSelect();
  await flush();
  const after = renderPage();
  expect(find(after.root, 'i:a').selected).toBe(false);
  expect(find(after.root, 'i:a').content).toBeUndefined();
  expect(after.all.some(element => element.type === 'aside')).toBe(false);
});

it.each(['keyboard', 'menu'] as const)('failed %s leaf archive keeps its selection, details and draft', async path => {
  h.client.memory.mockImplementation(async (request: {type: string}) => request.type === 'list' ? list([item('a'), item('b')])
    : request.type === 'archive' ? {kind: 'refused', reason: 'not-allowed', message: '不能删除'} : {kind: 'seen'});
  render(); await flush();
  let leaf = find(render(), 'i:a');
  leaf.onClick?.();
  leaf = find(render(), 'i:a');
  if (path === 'keyboard') leaf.onEdit?.();
  else leaf.menu!.find(action => action.id === 'details')!.onSelect();
  leaf = find(render(), 'i:a');
  if (path === 'keyboard') leaf.onDelete?.(); else leaf.menu!.find(action => action.id === 'delete')!.onSelect();
  await flush();
  const after = renderPage();
  expect(find(after.root, 'i:a').selected).toBe(true);
  if (path === 'keyboard') expect(find(after.root, 'i:a').content).toBeDefined();
  else expect(find(after.root, 'i:a').children?.length).toBeGreaterThan(0);
  expect(h.client.memory.mock.calls.filter(([request]) => request.type === 'archive')).toHaveLength(1);
});

it('refuses another selection or add when the current inline draft cannot commit', async () => {
  render(); await flush();
  find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  const focus = vi.fn();
  const commit = vi.fn(() => draft.onCommit(''));
  draft.session.current = {commit, focus};
  const root = render();
  find(root, 'i:b').onClick?.();
  await flush();
  expect(commit).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
  expect(find(render(), 'i:b').selected).toBe(false);
  expect(find(render(), 'i:a').content).toBeDefined();
  find(render(), 'b:发版').onAdd?.(); await flush();
  expect(commit).toHaveBeenCalledTimes(2);
  expect(find(render(), 'b:发版').children!.some(child => child.id === 'add:发版')).toBe(false);
});

it('waits for the pending inline commit before selecting another leaf', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  render(); await flush();
  find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  const commit = vi.fn(async () => {await gate; return draft.onCommit('记忆 a');});
  draft.session.current = {commit, focus: vi.fn()};
  find(render(), 'i:b').onClick?.();
  expect(find(render(), 'i:b').selected).toBe(false);
  expect(find(render(), 'i:a').content).toBeDefined();
  release(); await flush();
  expect(commit).toHaveBeenCalledOnce();
  expect(find(render(), 'i:b').selected).toBe(true);
  expect(find(render(), 'i:a').content).toBeUndefined();
});

it('focuses the current editor handle when a pending validation fails after the handle refreshes', async () => {
  let finish!: (ok: boolean) => void;
  const pending = new Promise<boolean>(resolve => {finish = resolve;});
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  draft.session.current = {commit: () => pending, focus: vi.fn()};
  find(render(), 'i:b').onClick?.();
  const focus = vi.fn();
  draft.session.current = {commit: vi.fn(), focus};
  finish(false); await flush();
  expect(focus).toHaveBeenCalledOnce();
  expect(find(render(), 'i:b').selected).toBe(false);
  expect(find(render(), 'i:a').content).toBeDefined();
});

it('keeps a category expanded when its leaf draft is invalid', async () => {
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  const focus = vi.fn();
  draft.session.current = {commit: () => draft.onCommit(''), focus};
  find(render(), 'b:发版').onToggle?.(); await flush();
  expect(find(render(), 'b:发版').open).toBe(true);
  expect(find(render(), 'i:a').content).toBeDefined();
  expect(focus).toHaveBeenCalledOnce();
});

it('waits for a valid leaf draft before folding its category', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  const draft = editor(find(render(), 'i:a'));
  draft.session.current = {commit: async () => {await gate; return draft.onCommit('记忆 a');}, focus: vi.fn()};
  find(render(), 'b:发版').onToggle?.();
  expect(find(render(), 'b:发版').open).toBe(true);
  release(); await flush();
  expect(find(render(), 'b:发版').open).toBe(false);
  expect(find(render(), 'i:a').content).toBeUndefined();
});


it('clears a validation notice when the original valid text is restored', async () => {
  render(); await flush(); find(render(), 'i:a').onEdit?.();
  expect(await editor(find(render(), 'i:a')).onCommit('')).toBe(false);
  expect(h.state).toContain('记忆内容不能为空。');
  expect(await editor(find(render(), 'i:a')).onCommit('记忆 a')).toBe(true);
  expect(h.state).not.toContain('记忆内容不能为空。');
  expect(find(render(), 'i:a').content).toBeUndefined();
});


it('keeps search and feedback inside the tree without an external frame', async () => {
  render(); await flush();
  render().menu!.find(entry => entry.id === 'search')!.onSelect();
  const page = renderPage();
  expect(find(page.root, 'search').content).toBeDefined();
  expect(page.all.some(element => ['aside', 'input', 'dialog'].includes(String(element.type)))).toBe(false);
});

it('commits a memory draft before opening a page-owned role node', async () => {
  const onClick = vi.fn();
  const before: MapNode[] = [{id: 'role', kind: 'leaf', label: '角色', onClick}];
  render({before}); await flush(); find(render({before}), 'i:a').onEdit?.();
  const draft = editor(find(render({before}), 'i:a'));
  const focus = vi.fn(); draft.session.current = {commit: async () => false, focus};
  find(render({before}), 'role').onClick?.(); await flush();
  expect(onClick).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce();
  draft.session.current = {commit: () => draft.onCommit('记忆 a'), focus};
  find(render({before}), 'role').onClick?.(); await flush();
  expect(onClick).toHaveBeenCalledOnce();
});
