import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Popover} from '@base-ui/react/popover';
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
  useId: () => `${h.active}-id-${h.slots[h.active]!.si++}`,
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
  if (typeof node.type === 'function' && ['CheckLabel', 'DefaultBadge', 'ModelSummaryMenu'].includes(node.type.name)) return [node, ...nodes(node.type(node.props))];
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
const picker = (all: Element[], label: string) => all.find(node => node.type === Popover.Root && nodes(node.props.children).some(child => child.type === Popover.Trigger && child.props['aria-label'] === label))!;
const checkbox = (all: Element[], label: string) => all.find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === label)!;
async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
function choices(props: Parameters<typeof ModelAccessChoices>[0]) {
  const component = at('choice-wrapper', () => ModelAccessChoices(props)).find(node => node.type === CompactModelSelection)!;
  return at('choices', () => CompactModelSelection(component.props as any));
}
beforeEach(() => {for (const slot of Object.values(h.slots)) for (const effect of slot.effects) effect.cleanup?.(); h.slots = {}; h.pending = []; h.draft = undefined; vi.clearAllMocks();});

it('withholds the previous ready catalog from save validation while refreshing', () => {
  const onCatalog = vi.fn();
  const props = {value: initial(), catalog, disabled: false, onChange: vi.fn(), onCatalog};
  choices({...props, catalogControls: {loading: false, refresh: vi.fn()}});
  expect(onCatalog).toHaveBeenLastCalledWith(catalog);
  choices({...props, catalogControls: {loading: true, refresh: vi.fn()}});
  expect(onCatalog).toHaveBeenLastCalledWith(undefined);
});

it('checks a model, chooses a new default, and keeps edits in the page draft', () => {
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render();
  expect(button(all, '配置可用模型')).toBeDefined();
  expect(checkbox(all, '允许 Beta').props.checked).toBe(false);
  checkbox(all, '允许 Beta').props.onChange(); all = render();
  expect(value.models).toEqual(['alpha', 'beta']);
  expect(value.modelEfforts?.beta).toEqual(['high']);
  expect(value.modelServiceTiers?.beta).toEqual([]);
  expect(value.defaultModel).toBe('alpha');
  button(all, '将 Beta 设为新话题默认').props.onClick(); all = render();
  expect(value.defaultModel).toBe('beta');
  expect(value.defaultEffort).toBe('high');
  expect(changed).toHaveBeenCalledTimes(2);
});

it('groups equal Effort capabilities and edits them together without touching another group', () => {
  const same = {...catalog.models[0]!, id: 'another', displayName: 'Another', supportedEfforts: ['high', 'low']};
  const current = {...catalog, models: [...catalog.models, same]};
  let value: Value = {...initial(), models: ['alpha', 'beta', 'another']};
  const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog: current, disabled: false, onChange: changed});
  let all = render();
  expect(button(all, '配置可用思考强度')).toBeDefined();
  expect(all.filter(node => node.type === 'section' && node.props['aria-label'] === 'Alpha、Another 可用思考强度')).toHaveLength(1);
  checkbox(all, '允许 low').props.onChange(); all = render();
  expect(value.modelEfforts?.alpha).toEqual(['high']);
  expect(value.modelEfforts?.another).toEqual(['high']);
  expect(value.modelEfforts?.beta).toEqual(['high']);
  expect(changed).toHaveBeenCalledOnce();
});

it('allows a default Effort when its star is chosen and prevents the final model being unchecked', () => {
  let value: Value = {...initial(), modelEfforts: {alpha: ['low']}, efforts: ['low'], defaultModel: 'alpha', defaultEffort: 'low'};
  const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render();
  checkbox(all, '允许 Alpha').props.onChange(); all = render();
  expect(value.models).toEqual(['alpha']); expect(changed).not.toHaveBeenCalled();
  button(all, '将 high 设为新话题默认强度').props.onClick(); all = render();
  expect(value.defaultEffort).toBe('high');
  expect(value.modelEfforts?.alpha).toEqual(['low', 'high']);
  expect(changed).toHaveBeenCalledOnce();
});

it('shows native acceleration permissions and stores the toggle only in the draft', () => {
  const accelerated: ModelCatalog = {...catalog, models: [{...catalog.models[0]!, serviceTiers: [{id: 'fast', name: 'Fast', description: ''}, {id: 'ultrafast', name: 'UltraFast', description: ''}]}, ...catalog.models.slice(1)]};
  let value = initial(); const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog: accelerated, disabled: false, onChange: changed});
  let all = render();
  expect(button(all, 'Alpha 允许加速')).toBeDefined();
  expect(checkbox(all, '允许 Fast').props.checked).toBe(false);
  checkbox(all, '允许 Fast').props.onChange(); all = render();
  expect(value.modelServiceTiers?.alpha).toEqual(['fast']);
  expect(checkbox(all, '允许 UltraFast').props.checked).toBe(false);
  expect(changed).toHaveBeenCalledOnce();
});

it('offers a removal checkbox when a previously allowed acceleration tier disappears', () => {
  let value: Value = {...initial(), modelServiceTiers: {alpha: ['fast']}};
  const changed = vi.fn((next: Value) => {value = next;});
  const current: ModelCatalog = {...catalog, models: [{...catalog.models[0]!, serviceTiers: []}, ...catalog.models.slice(1)]};
  const render = () => choices({value, catalog: current, disabled: false, onChange: changed});
  let all = render();
  expect(button(all, 'Alpha 允许加速')).toBeDefined();
  expect(text(all)).toContain('已不可用');
  checkbox(all, '允许 fast').props.onChange(); all = render();
  expect(value.modelServiceTiers?.alpha).toEqual([]);
  expect(changed).toHaveBeenCalledOnce();
});

it('persists model, Effort, defaults, and speed permissions atomically only through Save', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const accelerated: ModelCatalog = {...catalog, models: [{...catalog.models[0]!, serviceTiers: [{id: 'fast', name: 'Fast', description: ''}]}, ...catalog.models.slice(1)]};
  const save = vi.fn(async (patch: Partial<Value>) => ({kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored: {...value, ...patch}, effective: {...value, ...patch}, revision: 'r2'}}, effects: []}} as any));
  const render = () => {
    const editor = at('editor', () => Editor({title: '可用模型', section, save, validate: draft => modelAccessProblem(draft, accelerated),
      render: (draft, onChange, disabled) => <CompactModelSelection value={draft} onChange={onChange} disabled={disabled} catalog={accelerated}/> }));
    const compact = editor.find(node => node.type === CompactModelSelection)!;
    return {editor, choices: at('editor-choices', () => CompactModelSelection(compact.props as any))};
  };
  let ui = render(); checkbox(ui.choices, '允许 Beta').props.onChange(); ui = render();
  button(ui.choices, '将 Beta 设为新话题默认').props.onClick(); ui = render();
  expect(save).not.toHaveBeenCalled();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(save).toHaveBeenCalledOnce();
  expect(save.mock.calls[0]?.[0]).toMatchObject({models: ['alpha', 'beta'], defaultModel: 'beta', defaultEffort: 'high', modelEfforts: {alpha: ['low', 'high'], beta: ['high']}, modelServiceTiers: {beta: []}});
});

it('Save and Leave persists the current draft once', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const save = vi.fn(async (patch: Partial<Value>) => ({kind: 'saved', result: {kind: 'saved', section: {value: {...section, stored: {...value, ...patch}, effective: {...value, ...patch}, revision: 'r2'}}, effects: []}} as any));
  const render = () => {
    const editor = at('leave-editor', () => Editor({title: '可用模型', section, save, validate: draft => modelAccessProblem(draft, catalog),
      render: (draft, onChange, disabled) => <CompactModelSelection value={draft} onChange={onChange} disabled={disabled} catalog={catalog}/> }));
    const compact = editor.find(node => node.type === CompactModelSelection)!;
    return {editor, choices: at('leave-choices', () => CompactModelSelection(compact.props as any))};
  };
  let ui = render(); checkbox(ui.choices, '允许 Beta').props.onChange(); ui = render();
  expect(h.draft).toBeDefined(); expect(await h.draft!.save()).toBe(true);
  ui = render(); expect(save).toHaveBeenCalledOnce(); expect(h.draft).toBeUndefined();
});

it('keeps saved choices read only and unconfirmed if the directory fails', () => {
  const value: Value = {...initial(), models: ['retired'], efforts: ['high']}; const changed = vi.fn();
  const unavailable: ModelCatalog = {...catalog, state: 'unavailable', models: [], error: '模型目录读取失败'};
  const all = choices({value, catalog: unavailable, disabled: false, onChange: changed});
  expect(checkbox(all, '允许 retired').props.checked).toBe(true);
  expect(checkbox(all, '允许 retired').props.disabled).toBe(true);
  expect(text(all)).toContain('已保存，当前无法核对');
  expect(text(all)).not.toContain('已不可用');
  checkbox(all, '允许 retired').props.onChange();
  expect(changed).not.toHaveBeenCalled();
});

it('keeps fallback choices unconfirmed and unchanged across a failed forced refresh', async () => {
  const value: Value = {...initial(), models: ['retired']}; const changed = vi.fn();
  const fallback: ModelCatalog = {...catalog, state: 'fallback', models: [], error: '使用本机缓存'};
  h.client.settings.mockResolvedValueOnce({kind: 'models', catalog: fallback}).mockRejectedValueOnce(new Error('刷新失败'));
  const render = () => {
    const all = at('failed-refresh', () => Catalog({botId: agentIdSchema.parse('cli_failed'), backend: value.backend, purpose: 'project', showStatus: false,
      children: (current, controls) => <CompactModelSelection value={value} catalog={current} catalogControls={controls} disabled={false} onChange={changed}/> }));
    const component = all.find(node => node.type === CompactModelSelection)!;
    return at('failed-refresh-choices', () => CompactModelSelection(component.props as any));
  };
  render(); await flush(); let all = render();
  expect(checkbox(all, '允许 retired').props.disabled).toBe(true);
  expect(text(all)).toContain('已保存，当前无法核对');
  button(all, '刷新模型').props.onClick(); all = render(); all = render();
  expect(button(all, '刷新模型').props.disabled).toBe(true);
  await flush(); all = render();
  expect(text(all)).toContain('刷新失败');
  expect(text(all)).not.toContain('已不可用');
  expect(value.models).toEqual(['retired']); expect(changed).not.toHaveBeenCalled();
});

it('confirms a missing model only with a ready catalog and lets it be removed', () => {
  let value: Value = {...initial(), models: ['alpha', 'retired']}; const changed = vi.fn((next: Value) => {value = next;});
  const render = () => choices({value, catalog, disabled: false, onChange: changed});
  let all = render();
  expect(text(all)).toContain('已不可用');
  checkbox(all, '允许 retired').props.onChange(); all = render();
  expect(value.models).toEqual(['alpha']); expect(changed).toHaveBeenCalledOnce();
});

it('refreshes the shared catalog from each menu and disables refresh while loading', async () => {
  const value = initial(); const changed = vi.fn();
  let release!: (reply: {kind: 'models'; catalog: ModelCatalog}) => void;
  const pending = new Promise<{kind: 'models'; catalog: ModelCatalog}>(resolve => {release = resolve;});
  h.client.settings.mockResolvedValueOnce({kind: 'models', catalog}).mockReturnValueOnce(pending).mockResolvedValue({kind: 'models', catalog});
  const render = () => {
    const all = at('catalog', () => Catalog({botId: agentIdSchema.parse('cli_refresh'), backend: value.backend, purpose: 'project', showStatus: false,
      children: (current, controls) => <CompactModelSelection value={value} catalog={current} catalogControls={controls} disabled={false} onChange={changed}/> }));
    const component = all.find(node => node.type === CompactModelSelection)!;
    return {all, choices: at('catalog-choices', () => CompactModelSelection(component.props as any))};
  };
  let ui = render(); await flush(); ui = render();
  button(ui.choices, '刷新模型').props.onClick(); ui = render(); ui = render();
  expect(button(ui.choices, '刷新模型').props.disabled).toBe(true);
  release({kind: 'models', catalog}); await flush(); ui = render();
  button(ui.choices, '刷新思考强度').props.onClick(); ui = render(); await flush(); ui = render();
  expect(h.client.settings).toHaveBeenCalledTimes(3);
  expect(h.client.settings).toHaveBeenLastCalledWith({type: 'models', query: {botId: 'cli_refresh', backend: value.backend, purpose: 'project', refresh: true}});
  expect(changed).not.toHaveBeenCalled();
});

it('keeps a manual Provider check independent from the model draft', () => {
  const check = vi.fn(); const changed = vi.fn();
  const all = at('provider-check', () => ModelAccessFields({botId: agentIdSchema.parse('cli_check'), value: initial(), onChange: changed, disabled: false,
    providers: [{id: catalog.backend, displayName: 'Codex'}], onCheckProviders: check, checkingProviders: false}));
  button(all, '重新检查 Provider').props.onClick();
  expect(check).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
});

it('clears dependent choices when switching Providers', () => {
  const value = initial(); const changed = vi.fn();
  const all = at('switch-provider', () => ModelAccessFields({botId: agentIdSchema.parse('cli_switch'), providers: [{id: value.backend, displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}], value, onChange: changed, disabled: false}));
  const selector = all.find(node => node.type === SelectControl)!;
  selector.props.onChange('claude-agent');
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0]?.[0]).toMatchObject({backend: 'claude-agent', models: [], efforts: []});
});

it('clears provider-specific policies through the sparse Editor draft when switching away and back', () => {
  const value: Value = {...initial(), modelEfforts: {alpha: ['low']}, modelServiceTiers: {alpha: ['fast']}, defaultModel: 'alpha', defaultEffort: 'low'};
  const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const render = () => {
    const editor = at('provider-editor', () => Editor({title: '模型设置', section, save: vi.fn(),
      render: (draft, onChange, disabled) => <ModelAccessFields botId={agentIdSchema.parse('cli_switch')} providers={[{id: 'codex-appserver', displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}]} value={draft} onChange={onChange} disabled={disabled}/> }));
    const fields = editor.find(node => node.type === ModelAccessFields)!;
    const all = at('provider-fields', () => ModelAccessFields(fields.props as any));
    return {value: fields.props.value as Value, selector: all.find(node => node.type === SelectControl)!};
  };
  let ui = render(); ui.selector.props.onChange('claude-agent'); ui = render();
  expect(ui.value).toEqual({backend: 'claude-agent', models: [], efforts: [], modelEfforts: {}, modelServiceTiers: {}, defaultModel: undefined, defaultEffort: undefined});
  ui.selector.props.onChange('codex-appserver'); ui = render();
  expect(ui.value.modelServiceTiers).toEqual({}); expect(ui.value.modelEfforts).toEqual({});
  expect(ui.value.defaultModel).toBeUndefined(); expect(ui.value.defaultEffort).toBeUndefined();
});

it('marks only the affected controls, links the specific reason, and clears resolved problems', () => {
  const bad: Value = {...initial(), models: ['alpha', 'retired'], modelEfforts: {alpha: ['low', 'obsolete']}};
  let all = choices({value: bad, catalog, disabled: false, onChange: vi.fn()});
  for (const label of ['配置可用模型', '配置可用思考强度']) {
    const control = button(all, label);
    expect(control.props['aria-invalid']).toBe(true);
    const message = all.find(node => node.props.id === control.props['aria-describedby']);
    expect(message?.props.role).toBe('alert');
    expect(text(message)).toContain(label === '配置可用模型' ? 'retired' : 'Alpha · obsolete');
  }
  all = choices({value: {...initial(), modelEfforts: {alpha: ['low']}}, catalog, disabled: false, onChange: vi.fn()});
  expect(button(all, '配置可用模型').props['aria-invalid']).toBe(false);
  expect(button(all, '配置可用思考强度').props['aria-invalid']).toBe(false);
  all = choices({value: bad, catalog, catalogControls: {loading: true, refresh: vi.fn()}, disabled: false, onChange: vi.fn()});
  expect(button(all, '配置可用模型').props['aria-invalid']).toBe(false);
  expect(button(all, '配置可用思考强度').props['aria-invalid']).toBe(false);
});

it('localizes a server rejection to its field, preserves the draft, and clears it after editing', async () => {
  const value = initial(); const section = {stored: value, effective: value, revision: 'r1', access: {kind: 'writable' as const}, apply: []};
  const save = vi.fn(async () => ({kind: 'saved', result: {kind: 'rejected', fields: [{field: 'modelEfforts', message: 'Beta 的 high 已不可用，请刷新后重新选择。'}]}} as any));
  const render = () => {
    const editor = at('field-editor', () => Editor({title: '模型设置', section, save, fieldLabels: {modelEfforts: '可用思考强度'},
      render: (draft, onChange, disabled, _commit, _key, _discard, fieldIssues) => <ModelAccessChoices value={draft} onChange={onChange} disabled={disabled} catalog={catalog} fieldIssues={fieldIssues}/> }));
    const component = editor.find(node => node.type === ModelAccessChoices)!;
    return {editor, value: component.props.value as Value, choices: choices(component.props as any)};
  };
  let ui = render(); checkbox(ui.choices, '允许 Beta').props.onChange(); ui = render();
  button(ui.editor, '保存').props.onClick(); await flush(); ui = render();
  expect(ui.value.models).toEqual(['alpha', 'beta']);
  expect(button(ui.choices, '配置可用模型').props['aria-invalid']).toBe(false);
  expect(button(ui.choices, '配置可用思考强度').props['aria-invalid']).toBe(true);
  expect(text(ui.editor)).toContain('可用思考强度：Beta 的 high');
  checkbox(ui.choices, '允许 Beta').props.onChange(); ui = render();
  expect(button(ui.choices, '配置可用思考强度').props['aria-invalid']).toBe(false);
});
