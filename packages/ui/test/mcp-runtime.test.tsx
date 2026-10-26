import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {McpReply} from '@vonvon/protocol';
import {AddMcpDialog, McpPanel} from '../src/management/McpPanel';
type Effect = {deps?: unknown[]; cleanup?: () => void};
const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as Array<{current: unknown}>, effects: [] as Effect[], memos: [] as Array<{deps?: unknown[]; value: unknown}>,
  stateIndex: 0, refIndex: 0, effectIndex: 0, memoIndex: 0, pending: [] as Array<() => void>,
  draft: undefined as undefined | {save?: () => Promise<boolean>; discard: () => void}, client: {machine: vi.fn()},
}));
vi.mock('react', async original => {
  const memo = (factory: () => unknown, deps?: unknown[]) => {const index = harness.memoIndex++; const old = harness.memos[index]; if (old?.deps && deps && deps.every((item, at) => Object.is(item, old.deps![at]))) return old.value; const value = factory(); harness.memos[index] = {value, deps}; return value;};
  return {...await original<typeof import('react')>(),
    useState: (initial: unknown) => {const index = harness.stateIndex++; if (!(index in harness.state)) harness.state[index] = initial; return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? next(harness.state[index]) : next;}];},
    useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= {current: initial}, useId: () => 'field',
    useCallback: (callback: unknown, deps?: unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const index = harness.effectIndex++; const old = harness.effects[index]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; harness.pending.push(() => {old?.cleanup?.(); harness.effects[index] = {deps, cleanup: effect() || undefined};});},
  };
});
vi.mock('../src/client-context', () => ({useClient: () => harness.client}));
vi.mock('../src/settings/DraftGuard', () => ({useDraftGuard: () => ({navigate: (action: () => void) => action()}), useDraft: (_dirty: boolean, draft: typeof harness.draft) => {harness.draft = draft;}}));
const entry: McpReply['entries'][number] = {name: 'docs', transport: 'http', source: 'user', urlOrigin: 'https://docs.example', envNames: [], headerNames: [], enabled: true, authorization: 'not-checked'};
const view: McpReply = {type: 'mcp', provider: 'codex', status: 'ready', cliAvailable: true, revision: 'r1', configPath: '/native/config', entries: [entry]};
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children), ...nodes(node.props.trailing), ...nodes(node.props.footer)];}
function render(make: () => ReactNode = () => McpPanel({})) {harness.stateIndex = harness.refIndex = harness.effectIndex = harness.memoIndex = 0; const all = nodes(make()); for (const effect of harness.pending.splice(0)) effect(); return {all, button: (text: string) => all.find(node => (node.props.label ?? node.props.children) === text && node.props.onClick)!, by: (prop: string) => all.find(node => prop in node.props)!};}
async function flush() {for (let i = 0; i < 8; i++) await Promise.resolve();}
beforeEach(() => {harness.state = []; harness.refs = []; harness.effects = []; harness.memos = []; harness.pending = []; harness.draft = undefined; vi.clearAllMocks(); harness.client.machine.mockResolvedValue(view);});
it('retains the prior list and disables writes when refresh fails', async () => {
  render(); await flush(); let ui = render(); expect(ui.by('view').props.view.entries).toEqual([entry]);
  harness.client.machine.mockRejectedValueOnce(new Error('secret detail'));
  await ui.button('重新读取 MCP 配置').props.onClick(); await flush(); ui = render();
  expect(ui.by('view').props.view.entries).toEqual([entry]); expect(ui.by('view').props.disabled).toBe(true); expect(ui.button('添加').props.disabled).toBe(true);
  expect(JSON.stringify(ui.all.map(node => node.props.children))).not.toContain('secret detail');
});
it('removes only the selected provider entry with the observed revision', async () => {
  render(); await flush(); let ui = render(); ui.by('view').props.onRemove(entry); ui = render();
  harness.client.machine.mockResolvedValueOnce({...view, entries: [], revision: 'r2', changed: true});
  await ui.by('onConfirm').props.onConfirm(); await flush(); ui = render();
  expect(harness.client.machine).toHaveBeenLastCalledWith({type: 'mcp', request: {action: 'remove', provider: 'codex', name: 'docs', revision: 'r1'}});
  expect(ui.by('view').props.view.entries).toEqual([]);
});
it('keeps an add draft on conflict and only uses a fresh revision after explicit reread', async () => {
  const save = vi.fn().mockResolvedValueOnce({kind: 'conflict', message: '配置已更改'}).mockResolvedValueOnce({kind: 'saved'});
  const refresh = vi.fn(async () => ({...view, revision: 'r2'}));
  const close = vi.fn();
  const make = () => AddMcpDialog({provider: 'codex', revision: 'r1', onSave: save, onRefresh: refresh, onClose: close});
  let ui = render(make);
  ui.all.find(node => node.props.id === 'field-name')!.props.onChange({target: {value: 'new.docs'}});
  ui.all.find(node => node.props.id === 'field-url')!.props.onChange({target: {value: 'https://new.example/mcp'}});
  ui = render(make); await ui.button('添加').props.onClick(); await flush(); ui = render(make);
  expect(save).toHaveBeenLastCalledWith('new.docs', {transport: 'http', url: 'https://new.example/mcp'}, 'r1');
  expect(ui.all.find(node => node.props.id === 'field-name')!.props.value).toBe('new.docs');
  expect(ui.button('添加').props.disabled).toBe(true); expect(harness.draft?.save).toBeUndefined();
  await ui.button('重新读取并保留草稿').props.onClick(); ui = render(make);
  await ui.button('添加').props.onClick(); await flush();
  expect(save).toHaveBeenLastCalledWith('new.docs', {transport: 'http', url: 'https://new.example/mcp'}, 'r2');
});
