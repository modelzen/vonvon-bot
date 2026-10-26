import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {agentIdSchema, type ModelCatalog} from '@vonvon/protocol';
import {ModelAccessChoices, ModelAccessFields, modelAccessProblem} from '../src/settings/GroupDesignSettings';
import {CompactModelSelection} from '../src/settings/CompactModelSelection';
import {Catalog, Editor} from '../src/settings/SettingsPanel';
import {SelectControl} from '../src/reference/components/ui';

type Slot = {state: unknown[]; refs: Array<{current: unknown}>; effects: Array<{deps?: unknown[]; cleanup?: () => void}>; si: number; ri: number; ei: number};
const h = vi.hoisted(() => ({slots: {} as Record<string, Slot>, active: '', pending: [] as Array<() => void>, draft: undefined as {save: () => Promise<boolean>} | undefined, client: {settings: vi.fn()}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const slot = h.slots[h.active]!; const i = slot.si++; if (!(i in slot.state)) slot.state[i] = typeof initial === 'function' ? initial() : initial; return [slot.state[i], (next: unknown) => {slot.state[i] = typeof next === 'function' ? next(slot.state[i]) : next;}];},
  useRef: (initial: unknown) => {const slot = h.slots[h.active]!; return slot.refs[slot.ri++] ??= {current: initial};},
  useContext: () => [], useCallback: (fn: unknown) => fn,
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const slot = h.slots[h.active]!; const i = slot.ei++; const old = slot.effects[i]; if (old?.deps && deps && deps.length === old.deps.length && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {old?.cleanup?.(); slot.effects[i] = {deps, cleanup: effect() || undefined};});},
  useMemo: (make: () => unknown) => make(),
}));
vi.mock('../src/settings/DraftGuard', () => ({useDraft: (dirty: boolean, draft: {save: () => Promise<boolean>}) => {h.draft = dirty ? draft : undefined;}}));
vi.mock('../src/client-context', () => ({useClient: () => h.client, useShellCapabilities: () => undefined}));

type Element = ReactElement<Record<string, any>>;
type Value = Parameters<typeof ModelAccessChoices>[0]['value'];
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];
}
function at(name: string, make: () => ReactNode) {
  const slot = h.slots[name] ??= {state: [], refs: [], effects: [], si: 0, ri: 0, ei: 0};
  h.active = name; slot.si = slot.ri = slot.ei = 0;
  const result = nodes(make());
  for (const effect of h.pending.splice(0)) effect();
  return result;
}
const catalog: ModelCatalog = {backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [
  {id: 'alpha', displayName: 'Alpha', description: '', isDefault: true, hidden: false, supportedEfforts: ['low', 'high'], defaultEffort: 'low'},
  {id: 'beta', displayName: 'Beta', description: '', isDefault: false, hidden: false, supportedEfforts: ['high'], defaultEffort: 'high'},
  {id: 'hidden', displayName: 'Hidden', description: '', isDefault: false, hidden: true, supportedEfforts: [], defaultEffort: 'none'},
]};
const initial = (): Value => ({backend: catalog.backend, models: ['alpha'], efforts: ['low', 'high']});
function text(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return isValidElement<{children?: ReactNode}>(node) ? text(node.props.children) : '';}
const button = (all: Element[], label: string) => all.find(node => node.props.label === label || node.props['aria-label'] === label || text(node.props.children) === label)!;
const picker = (all: Element[], field: 'models' | 'efforts') => all.filter(node => node.type === Combobox.Root)[field === 'models' ? 0 : 1]!;
const item = (all: Element[], label: string) => all.find(node => node.type === Combobox.Item && node.props['aria-label'] === label)!;
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function choices(props: Parameters<typeof ModelAccessChoices>[0]) {
  const component = at('choice-wrapper', () => ModelAccessChoices(props)).find(node => node.type === CompactModelSelection)!;
  return at('choices', () => CompactModelSelection(component.props as any));
}
beforeEach(() => {for (const slot of Object.values(h.slots)) for (const effect of slot.effects) effect.cleanup?.(); h.slots = {}; h.pending = []; h.draft = undefined; vi.clearAllMocks();});

it('keeps a manual Provider check available while healthy without changing the model draft', () => {
  const check = vi.fn(); const changed = vi.fn();
  const all = at('healthy-provider', () => ModelAccessFields({botId: agentIdSchema.parse('cli_check'), value: initial(), onChange: changed, disabled: false,
    providers: [{id: catalog.backend, displayName: 'Codex'}], onCheckProviders: check, checkingProviders: false}));
  const action = all.find(node => node.props.label === '重新检查 Provider')!;
  expect(action.props.disabled).toBe(false);
  action.props.onClick();
  expect(check).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
});

it('filters the model menu and updates the page draft immediately while it stays open', () => {
  let value = initial();
  const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render();
  expect(button(all, '选择模型')).toBeDefined(); expect(button(all, '选择强度')).toBeDefined();
  expect(picker(all, 'models').props.open).toBe(false);
  picker(all, 'models').props.onOpenChange(true); all = render();
  expect(picker(all, 'models').props.open).toBe(true);
  picker(all, 'models').props.onInputValueChange('Beta', {reason: 'input-change', cancel: vi.fn()}); all = render();
  expect(picker(all, 'models').props.filteredItems).toEqual(['beta']);
  expect(item(all, '允许本群使用 Beta').props.value).toBe('beta');
  picker(all, 'models').props.onValueChange(['alpha', 'beta']); all = render();
  expect(value).toEqual({...initial(), models: ['alpha', 'beta']});
  expect(changed).toHaveBeenCalledOnce();
  expect(picker(all, 'models').props.open).toBe(true);
  const cancelClear = vi.fn();
  picker(all, 'models').props.onInputValueChange('', {reason: 'input-clear', cancel: cancelClear}); all = render();
  expect(cancelClear).toHaveBeenCalledOnce();
  expect(picker(all, 'models').props.filteredItems).toEqual(['beta']);
  picker(all, 'models').props.onInputValueChange('Alpha', {reason: 'input-change', cancel: vi.fn()}); all = render();
  expect(picker(all, 'models').props.filteredItems).toEqual(['alpha']);
  expect(picker(all, 'models').props.value).toEqual(['alpha', 'beta']);
});

it('keeps a selected model in the page draft when the menu closes', () => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render(); picker(all, 'models').props.onOpenChange(true); all = render();
  picker(all, 'models').props.onValueChange(['alpha', 'beta']); all = render();
  picker(all, 'models').props.onOpenChange(false); all = render();
  expect(picker(all, 'models').props.open).toBe(false);
  expect(value.models).toEqual(['alpha', 'beta']);
  picker(all, 'models').props.onOpenChange(true); all = render();
  expect(picker(all, 'models').props.value).toEqual(['alpha', 'beta']);
  expect(changed).toHaveBeenCalledOnce();
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
  let ui = render(); picker(ui.choices, 'models').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'models').props.onValueChange(['alpha', 'beta']); ui = render();
  expect(save).not.toHaveBeenCalled(); expect(button(ui.editor, '保存')).toBeDefined();
  picker(ui.choices, 'efforts').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'efforts').props.onValueChange(['high']); ui = render();
  expect(save).not.toHaveBeenCalled();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{models: ['alpha', 'beta'], efforts: ['high']}, 'r1']]);
  expect(button(ui.editor, '保存')).toBeUndefined();
});

it('saves the current model draft through Save and Leave once the native catalog is ready', async () => {
  const value = initial();
  const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const save = vi.fn(async (patch: Partial<Value>) => ({kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored: {...value, ...patch}, effective: {...value, ...patch}, revision: 'r2'}}, effects: []}} as any));
  const render = () => {
    const editor = at('leave-editor', () => Editor({title: '执行模型', section, save, validate: draft => modelAccessProblem(draft, catalog),
      render: (draft, onChange, disabled) => <CompactModelSelection value={draft} onChange={onChange} disabled={disabled} catalog={catalog}/>}));
    const compact = editor.find(node => node.type === CompactModelSelection)!;
    return {editor, choices: at('leave-picker', () => CompactModelSelection(compact.props as any))};
  };
  let ui = render();
  picker(ui.choices, 'models').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'models').props.onValueChange(['alpha', 'beta']); ui = render();
  expect(h.draft).toBeDefined();
  expect(await h.draft!.save()).toBe(true);
  ui = render();
  expect(save.mock.calls).toEqual([[{models: ['alpha', 'beta']}, 'r1']]);
  expect(h.draft).toBeUndefined();
  expect(button(ui.editor, '保存')).toBeUndefined();
});

it('retains saved values in unavailable catalogs and permits read-only inspection', () => {
  const value: Value = {...initial(), models: ['retired'], efforts: ['high']};
  const changed = vi.fn();
  const unavailable: ModelCatalog = {...catalog, state: 'unavailable', models: [], error: '模型目录读取失败'};
  const render = () => choices({value, catalog: unavailable, disabled: false, onChange: changed});
  let all = render(); picker(all, 'models').props.onOpenChange(true); all = render();
  expect(picker(all, 'models').props.value).toEqual(['retired']);
  expect(item(all, '移除未列出的模型 retired').props.disabled).toBe(true);
  picker(all, 'models').props.onValueChange([]); all = render();
  expect(value.models).toEqual(['retired']);
  picker(all, 'models').props.onOpenChange(false); all = render();
  picker(all, 'efforts').props.onOpenChange(true); all = render();
  expect(picker(all, 'efforts').props.value).toEqual(['high']);
  expect(item(all, '允许本群使用 high Effort').props.disabled).toBe(true);
  picker(all, 'efforts').props.onValueChange([]); all = render();
  expect(changed).not.toHaveBeenCalled(); expect(value.models).toEqual(['retired']);
});

it.each(['loading', 'fallback', 'other-provider'] as const)('does not create unsaveable choices while the catalog is %s', state => {
  const value = initial();
  const changed = vi.fn();
  const current = state === 'loading' ? undefined : {...catalog, state: state === 'fallback' ? 'fallback' as const : 'ready' as const, backend: state === 'other-provider' ? 'claude-agent' : value.backend};
  const render = () => choices({value, catalog: current, disabled: false, onChange: changed});
  let all = render();
  picker(all, 'models').props.onOpenChange(true); all = render();
  expect(all.filter(node => node.type === Combobox.Item).every(node => node.props.disabled)).toBe(true);
  picker(all, 'models').props.onValueChange([]);
  expect(changed).not.toHaveBeenCalled();
  picker(all, 'models').props.onOpenChange(false); all = render();
  picker(all, 'efforts').props.onOpenChange(true); all = render();
  expect(item(all, '允许本群使用 low Effort').props.disabled).toBe(true);
  expect(picker(all, 'efforts').props.value).toEqual(['low', 'high']);
  picker(all, 'efforts').props.onValueChange([]);
  expect(value).toEqual(initial());
});

it.each(['fallback', 'failed'] as const)('retries the same Provider after a %s catalog without losing the page draft', async failure => {
  const value = {...initial(), models: ['alpha', 'beta']};
  const changed = vi.fn();
  if (failure === 'failed') h.client.settings.mockRejectedValueOnce(new Error('目录读取失败'));
  else h.client.settings.mockResolvedValueOnce({kind: 'models', catalog: {...catalog, state: 'fallback'}});
  h.client.settings.mockResolvedValueOnce({kind: 'models', catalog});
  const render = () => {
    const all = at('retry-catalog', () => Catalog({botId: agentIdSchema.parse('cli_retry'), backend: value.backend, purpose: 'project',
      children: current => <CompactModelSelection value={value} catalog={current} disabled={false} onChange={changed}/>}));
    const component = all.find(node => node.type === CompactModelSelection)!;
    return {all, choices: at('retry-picker', () => CompactModelSelection(component.props as any))};
  };
  let ui = render(); await flush(); ui = render();
  expect(button(ui.choices, '查看模型')).toBeDefined();
  button(ui.all, '重新读取模型').props.onClick(); ui = render(); await flush(); ui = render();
  expect(h.client.settings).toHaveBeenCalledTimes(2);
  expect(h.client.settings).toHaveBeenLastCalledWith({type: 'models', query: {botId: 'cli_retry', backend: value.backend, purpose: 'project'}});
  expect(button(ui.all, '重新读取模型')).toBeUndefined();
  picker(ui.choices, 'models').props.onOpenChange(true); ui = render();
  expect(picker(ui.choices, 'models').props.value).toEqual(['alpha', 'beta']);
  expect(item(ui.choices, '允许本群使用 Beta').props.disabled).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  expect(value.models).toEqual(['alpha', 'beta']);
});

it('reflects an external parent update immediately while the menu is open', () => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render(); picker(all, 'models').props.onOpenChange(true); all = render();
  value = {...value, models: ['beta']}; all = render();
  expect(picker(all, 'models').props.open).toBe(true);
  expect(picker(all, 'models').props.value).toEqual(['beta']);
  expect(changed).not.toHaveBeenCalled();
});

it('loads the changed Provider catalog, edits model and Effort drafts, and saves only after both validate', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const otherCatalog: ModelCatalog = {...catalog, backend: 'claude-agent', titleEfforts: ['high'], models: [{...catalog.models[1]!, id: 'claude-model', displayName: 'Claude Model'}]};
  const save = vi.fn(async (patch: Partial<Value>) => {
    const stored = {...value, ...patch};
    return {kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored, effective: stored, revision: 'r2'}}, effects: []}} as any;
  });
  h.client.settings.mockImplementation(async request => ({kind: 'models', catalog: request.query.backend === otherCatalog.backend ? otherCatalog : catalog}));
  let liveCatalog: ModelCatalog | undefined;
  const rememberCatalog = (next: ModelCatalog | undefined) => {liveCatalog = next;};
  const render = () => {
    const editor = at('provider-editor', () => Editor({title: '执行模型', section, save, validate: next => modelAccessProblem(next, liveCatalog),
      render: (draft, onChange, disabled) => <ModelAccessFields botId={agentIdSchema.parse('cli_switch')} value={draft} onChange={onChange} disabled={disabled} onCatalog={rememberCatalog}
        providers={[{id: catalog.backend, displayName: 'Codex'}, {id: otherCatalog.backend, displayName: 'Claude'}]}/>}));
    const fields = editor.find(node => node.type === ModelAccessFields)!;
    const all = at('provider-fields', () => ModelAccessFields(fields.props as any));
    const loader = all.find(node => node.type === Catalog)!;
    const backend = loader.props.backend;
    const loaded = at(`catalog:${backend}`, () => Catalog(loader.props as any));
    const choice = loaded.find(node => node.type === ModelAccessChoices)!;
    const wrapped = at(`choice:${backend}`, () => ModelAccessChoices(choice.props as any));
    const compact = wrapped.find(node => node.type === CompactModelSelection)!;
    return {editor, provider: all.find(node => node.type === SelectControl && node.props.label === '模型 Provider')!, choices: at(`compact:${backend}`, () => CompactModelSelection(compact.props as any)), value: fields.props.value};
  };
  let ui = render(); await flush(); ui = render();
  ui.provider.props.onChange(otherCatalog.backend); ui = render();
  expect(ui.value).toEqual({backend: otherCatalog.backend, models: [], efforts: []});
  expect(save).not.toHaveBeenCalled();
  expect(h.client.settings).toHaveBeenCalledWith({type: 'models', query: {botId: 'cli_switch', backend: otherCatalog.backend, purpose: 'project'}});
  await flush(); ui = render();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save).not.toHaveBeenCalled();
  picker(ui.choices, 'models').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'models').props.onValueChange(['claude-model']); ui = render();
  picker(ui.choices, 'models').props.onOpenChange(false); ui = render();
  expect(ui.value.models).toEqual(['claude-model']); expect(save).not.toHaveBeenCalled();
  button(ui.editor, '放弃修改').props.onClick(); ui = render();
  expect(ui.value).toEqual(value); expect(save).not.toHaveBeenCalled();
  ui.provider.props.onChange(otherCatalog.backend); ui = render();
  picker(ui.choices, 'models').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'models').props.onValueChange(['claude-model']); ui = render();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save).not.toHaveBeenCalled();
  picker(ui.choices, 'efforts').props.onOpenChange(true); ui = render();
  picker(ui.choices, 'efforts').props.onValueChange(['high']); ui = render();
  expect(save).not.toHaveBeenCalled();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save.mock.calls).toEqual([[{backend: otherCatalog.backend, models: ['claude-model'], efforts: ['high']}, 'r1']]);
});

it('retries a failed catalog read without changing the parent selection', async () => {
  const value = initial();
  h.client.settings.mockResolvedValueOnce({kind: 'refused', message: '目录服务暂不可用'}).mockResolvedValueOnce({kind: 'models', catalog});
  const render = () => at('retry-catalog', () => Catalog({botId: agentIdSchema.parse('cli_retry'), backend: value.backend, purpose: 'project', children: current => <span>{current?.state ?? 'loading'}</span>}));
  render(); await flush(); let all = render();
  expect(all.filter(node => node.props.children === '目录服务暂不可用')).toHaveLength(1);
  button(all, '重新读取模型').props.onClick(); render(); await flush(); all = render();
  expect(h.client.settings).toHaveBeenCalledTimes(2);
  expect(all.some(node => node.props.children === 'ready')).toBe(true);
  expect(value).toEqual(initial());
});

it('preserves saved Effort selections while the catalog is still loading', () => {
  const changed = vi.fn();
  let all = choices({value: initial(), disabled: false, onChange: changed});
  picker(all, 'efforts').props.onOpenChange(true); all = choices({value: initial(), disabled: false, onChange: changed});
  expect(picker(all, 'efforts').props.value).toEqual(['low', 'high']);
  expect(item(all, '允许本群使用 low Effort').props.disabled).toBe(true);
  picker(all, 'efforts').props.onValueChange(['high']);
  expect(changed).not.toHaveBeenCalled();
});

it('keeps an Effort change in the page draft after closing the menu', () => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render(); picker(all, 'efforts').props.onOpenChange(true); all = render();
  picker(all, 'efforts').props.onValueChange(['low']); all = render();
  picker(all, 'efforts').props.onOpenChange(false); all = render();
  expect(value.efforts).toEqual(['low']);
  picker(all, 'efforts').props.onOpenChange(true); all = render();
  expect(picker(all, 'efforts').props.value).toEqual(['low']);
  expect(changed).toHaveBeenCalledOnce();
});

it('takes an extensible Provider list as data and clears dependent choices when switching', () => {
  const providers = Array.from({length: 12}, (_, index) => ({id: `provider-${index}`, displayName: `Provider ${index}`}));
  const value = {...initial(), backend: 'provider-0'}; const changed = vi.fn();
  const all = at('many-providers', () => ModelAccessFields({botId: agentIdSchema.parse('cli_many'), providers, value, onChange: changed, disabled: false}));
  const selector = all.find(node => node.type === SelectControl)!;
  expect(selector.props.options).toHaveLength(12);
  selector.props.onChange('provider-11');
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'provider-11', models: [], efforts: []});
});

it('does not offer a meaningless picker for a Provider without Effort support', () => {
  const value = {...initial(), efforts: []};
  const noEffortCatalog = {...catalog, models: catalog.models.map(model => ({...model, supportedEfforts: []}))};
  const all = choices({value, catalog: noEffortCatalog, disabled: false, onChange: vi.fn()});
  expect(button(all, '选择强度').props.disabled).toBe(true);
  expect(text(button(all, '选择强度').props.children)).toContain('此 Provider 未提供思考强度');
});

it('lets the page draft become empty but blocks saving without a model', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const save = vi.fn();
  const render = () => {
    const editor = at('empty-editor', () => Editor({title: '可用模型', section, save, validate: draft => modelAccessProblem(draft, catalog),
      render: (draft, onChange, disabled) => <CompactModelSelection value={draft} onChange={onChange} disabled={disabled} catalog={catalog}/>}));
    const compact = editor.find(node => node.type === CompactModelSelection)!;
    return {editor, choices: at('empty-picker', () => CompactModelSelection(compact.props as any))};
  };
  let ui = render(); picker(ui.choices, 'models').props.onValueChange([]); ui = render();
  expect(picker(ui.choices, 'models').props.value).toEqual([]);
  button(ui.editor, '保存').props.onClick(); await flush();
  expect(save).not.toHaveBeenCalled();
});
