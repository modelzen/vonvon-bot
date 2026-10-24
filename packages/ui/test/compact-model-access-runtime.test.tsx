import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {ModelCatalog} from '@vonvon/protocol';
import {ModelAccessChoices, modelAccessProblem} from '../src/settings/GroupDesignSettings';
import {CompactModelSelection} from '../src/settings/CompactModelSelection';
import {Editor} from '../src/settings/SettingsPanel';
import {Dialog} from '../src/reference/components/ui/Dialog';

type Slot = {state: unknown[]; refs: Array<{current: unknown}>; si: number; ri: number};
const h = vi.hoisted(() => ({slots: {} as Record<string, Slot>, active: ''}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const slot = h.slots[h.active]!; const i = slot.si++; if (!(i in slot.state)) slot.state[i] = typeof initial === 'function' ? initial() : initial; return [slot.state[i], (next: unknown) => {slot.state[i] = typeof next === 'function' ? next(slot.state[i]) : next;}];},
  useRef: (initial: unknown) => {const slot = h.slots[h.active]!; return slot.refs[slot.ri++] ??= {current: initial};},
  useContext: () => [], useEffect: () => {}, useCallback: (fn: unknown) => fn,
  useMemo: (make: () => unknown) => make(),
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: () => {}}));

type Element = ReactElement<Record<string, any>>;
type Value = Parameters<typeof ModelAccessChoices>[0]['value'];
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  if (node.type === Dialog && !node.props.open) return [node];
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];
}
function at(name: string, make: () => ReactNode) {
  const slot = h.slots[name] ??= {state: [], refs: [], si: 0, ri: 0};
  h.active = name; slot.si = slot.ri = 0;
  return nodes(make());
}
const catalog: ModelCatalog = {backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [
  {id: 'alpha', displayName: 'Alpha', description: '', isDefault: true, hidden: false, supportedEfforts: ['low', 'high'], defaultEffort: 'low'},
  {id: 'beta', displayName: 'Beta', description: '', isDefault: false, hidden: false, supportedEfforts: ['high'], defaultEffort: 'high'},
  {id: 'hidden', displayName: 'Hidden', description: '', isDefault: false, hidden: true, supportedEfforts: [], defaultEffort: 'none'},
]};
const initial = (): Value => ({backend: catalog.backend, models: ['alpha'], efforts: ['low', 'high']});
function text(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return isValidElement<{children?: ReactNode}>(node) ? text(node.props.children) : '';}
const button = (all: Element[], label: string) => all.find(node => text(node.props.children) === label && node.props.onClick)!;
const checkbox = (all: Element[], label: string) => all.find(node => node.type === 'input' && node.props['aria-label'] === label)!;
const dialog = (all: Element[]) => all.find(node => node.type === Dialog && node.props.open)!;
const search = (all: Element[]) => all.find(node => node.type === 'input' && node.props['aria-label'] === '搜索模型')!;
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function choices(props: Parameters<typeof ModelAccessChoices>[0]) {
  const component = at('choice-wrapper', () => ModelAccessChoices(props)).find(node => node.type === CompactModelSelection)!;
  return at('choices', () => CompactModelSelection(component.props as any));
}
beforeEach(() => {h.slots = {}; vi.clearAllMocks();});

it('keeps unselected models out of the normal page and preserves checked models across searches', () => {
  let value = initial();
  const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render();
  expect(all.some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false);
  expect(button(all, '选择模型')).toBeDefined(); expect(button(all, '选择强度')).toBeDefined();
  button(all, '选择模型').props.onClick(); all = render();
  search(all).props.onChange({target: {value: 'Beta'}}); all = render();
  expect(checkbox(all, '允许本群使用 Alpha')).toBeUndefined();
  checkbox(all, '允许本群使用 Beta').props.onChange({target: {checked: true}}); all = render();
  search(all).props.onChange({target: {value: 'Alpha'}}); all = render();
  expect(checkbox(all, '允许本群使用 Alpha').props.checked).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  button(all, '完成').props.onClick(); all = render();
  expect(value).toEqual({...initial(), models: ['alpha', 'beta']});
  expect(changed).toHaveBeenCalledOnce();
  expect(dialog(all)).toBeUndefined();
  expect(all.some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false);
});

it.each(['cancel', 'dismiss'] as const)('discards a local model selection on %s and reopens from the saved parent draft', action => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render(); button(all, '选择模型').props.onClick(); all = render();
  checkbox(all, '允许本群使用 Beta').props.onChange({target: {checked: true}}); all = render();
  if (action === 'cancel') button(all, '取消').props.onClick(); else dialog(all).props.onClose();
  all = render(); expect(changed).not.toHaveBeenCalled(); expect(value).toEqual(initial());
  button(all, '选择模型').props.onClick(); all = render();
  expect(checkbox(all, '允许本群使用 Beta').props.checked).toBe(false);
  expect(checkbox(all, '允许本群使用 Alpha').props.checked).toBe(true);
});

it('edits model and Effort independently and persists only through the existing section save', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const save = vi.fn(async (patch: Partial<Value>) => {
    const stored = {...value, ...patch};
    return {kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored, effective: stored, revision: 'r2'}}, effects: []}} as any;
  });
  const render = () => {
    const editor = at('editor', () => Editor({title: '执行模型', section, save, validate: next => modelAccessProblem(next, catalog),
      render: (draft, onChange, disabled) => <ModelAccessChoices value={draft} onChange={onChange} disabled={disabled} catalog={catalog}/>}));
    const choices = editor.find(node => node.type === ModelAccessChoices)!;
    return {editor, choices: at('choice-component', () => CompactModelSelection(choices.props as any))};
  };
  let ui = render(); button(ui.choices, '选择模型').props.onClick(); ui = render();
  checkbox(ui.choices, '允许本群使用 Beta').props.onChange({target: {checked: true}}); ui = render();
  button(ui.choices, '完成').props.onClick(); ui = render();
  expect(save).not.toHaveBeenCalled(); expect(button(ui.editor, '保存')).toBeDefined();
  button(ui.choices, '选择强度').props.onClick(); ui = render();
  checkbox(ui.choices, '允许本群使用 low Effort').props.onChange({target: {checked: false}}); ui = render();
  button(ui.choices, '完成').props.onClick(); ui = render();
  expect(save).not.toHaveBeenCalled();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{models: ['alpha', 'beta'], efforts: ['high']}, 'r1']]);
  expect(button(ui.editor, '保存')).toBeUndefined();
});

it('retains saved values in unavailable catalogs and permits read-only inspection', () => {
  const value: Value = {...initial(), models: ['retired'], efforts: ['high']};
  const changed = vi.fn();
  const unavailable: ModelCatalog = {...catalog, state: 'unavailable', models: [], error: '模型目录读取失败'};
  const render = () => choices({value, catalog: unavailable, disabled: false, onChange: changed});
  let all = render(); button(all, '查看模型').props.onClick(); all = render();
  const saved = checkbox(all, '移除未列出的模型 retired');
  expect(saved.props.checked).toBe(true); expect(saved.props.disabled).toBe(true);
  expect(button(all, '完成')?.props.disabled ?? true).toBe(true);
  dialog(all).props.onClose(); all = render();
  button(all, '查看强度').props.onClick(); all = render();
  expect(checkbox(all, '允许本群使用 high Effort').props.checked).toBe(true);
  expect(checkbox(all, '允许本群使用 high Effort').props.disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled(); expect(value.models).toEqual(['retired']);
});

it('blocks a stale picker draft after the parent setting changes, then reloads the new selection explicitly', () => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render(); button(all, '选择模型').props.onClick(); all = render();
  checkbox(all, '允许本群使用 Beta').props.onChange({target: {checked: true}}); all = render();
  value = {...value, models: ['beta']}; all = render();
  expect(button(all, '完成').props.disabled).toBe(true);
  expect(all.find(node => node.props.title === '模型设置已在别处更改')).toBeDefined();
  expect(changed).not.toHaveBeenCalled();
  button(all, '重新读取并放弃选择').props.onClick(); all = render();
  expect(checkbox(all, '允许本群使用 Alpha').props.checked).toBe(false);
  expect(checkbox(all, '允许本群使用 Beta').props.checked).toBe(true);
  expect(button(all, '完成').props.disabled).toBe(false);
});
