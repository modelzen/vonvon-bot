import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DecisionModelsView, type JudgeSelectionView, type ModelCatalog} from '@vonvon/protocol';
import {DecisionFields, DecisionModelChoices, decisionProviderProblem} from '../src/settings/DecisionFields';
import {Catalog} from '../src/settings/SettingsPanel';
import {SettingChoices} from '../src/settings/SettingChoices';
import {SelectControl} from '../src/reference/components/ui';

const hooks = vi.hoisted(() => ({states: [] as unknown[], cursor: 0, effects: [] as Array<unknown[] | undefined>, effectCursor: 0, pending: [] as Array<() => void>, checkLogin: vi.fn()}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;}];
  },
  useEffect: (effect: () => void, deps?: unknown[]) => {
    const index = hooks.effectCursor++;
    const previous = hooks.effects[index];
    if (previous && deps && previous.length === deps.length && deps.every((value, at) => Object.is(value, previous[at]))) return;
    hooks.effects[index] = deps;
    hooks.pending.push(effect);
  },
}));
vi.mock('../src/setup/useClaudeLoginCheck', () => ({useClaudeLoginCheck: () => ({checking: false, check: hooks.checkLogin})}));

type Element = ReactElement<Record<string, any>>;
type Props = Parameters<typeof DecisionFields>[0];
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
const codex = {id: 'codex-appserver', displayName: 'Codex'};
const claude = {id: 'claude-agent', displayName: 'Claude'};
const saved = {kind: 'llm' as const, backend: codex.id, model: 'model-a', effort: 'high' as const};
const services: DecisionModelsView = [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', keySet: false, models: [{id: 'jev-latest', displayName: 'Jev'}]}];
const catalog: ModelCatalog = {backend: codex.id, state: 'ready', source: 'backend-provided', observedAt: 1, titleEfforts: ['low', 'high'], models: [
  {id: 'model-a', displayName: '模型 A', description: '', isDefault: true, hidden: false, supportedEfforts: ['low', 'high'], defaultEffort: 'low'},
  {id: 'model-b', displayName: '模型 B', description: '', isDefault: false, hidden: false, supportedEfforts: ['low'], defaultEffort: 'low'},
  {id: 'hidden', displayName: '隐藏模型', description: '', isDefault: false, hidden: true, supportedEfforts: [], defaultEffort: 'none'},
]};
let props: Props;
const changed = vi.fn<(selection: JudgeSelectionView) => void>();
const openProviders = vi.fn();
const openSecrets = vi.fn();
const providerChanged = vi.fn();
function render() {hooks.cursor = hooks.effectCursor = 0; const ui = nodes(DecisionFields(props)); for (const effect of hooks.pending.splice(0)) effect(); return ui;}
function providerChoice(ui = render()) {return ui.find(node => node.type === SettingChoices && node.props.label === '决策 Provider')!;}
function browse(provider: string) {providerChoice().props.onChange(provider); return render();}
function modelNodes(ui = render(), source = catalog) {
  const loader = ui.find(node => node.type === Catalog)!;
  expect(loader).toBeDefined();
  expect(loader.props.purpose).toBe('judge');
  const choices = loader.props.children(source) as Element;
  expect(choices.type).toBe(DecisionModelChoices);
  return nodes(DecisionModelChoices(choices.props as Parameters<typeof DecisionModelChoices>[0]));
}
function modelChoice(ui: Element[]) {return ui.find(node => node.type === SelectControl && node.props.label === '决策模型')!;}
beforeEach(() => {
  hooks.states = []; hooks.effects = []; hooks.pending = []; hooks.cursor = hooks.effectCursor = 0; vi.clearAllMocks();
  props = {botId: agentIdSchema.parse('cli_decision_fields'), groupBackend: codex.id, value: saved, effective: saved, onChange: changed,
    disabled: false, providers: [codex], services, onOpenProviders: openProviders, onOpenSecrets: openSecrets, onProviderChange: providerChanged};
  changed.mockImplementation(selection => {props = {...props, value: selection};});
});

it('uses one compact model selector and excludes hidden models', () => {
  const ui = modelNodes();
  const select = modelChoice(ui);
  expect(ui.filter(node => node.type === SelectControl && node.props.label === '决策模型')).toHaveLength(1);
  expect(ui.some(node => node.type === 'input' && node.props.type === 'radio')).toBe(false);
  expect(select.props.value).toBe('model-a');
  expect(select.props.options.map((option: {value: string}) => option.value)).toEqual(['', 'model-a', 'model-b']);
});

it('shows the effective model and effort for a legacy default without making a draft', () => {
  props.value = {kind: 'default'};
  const ui = modelNodes();
  expect(modelChoice(ui).props.value).toBe(saved.model);
  expect(ui.find(node => node.type === SelectControl && node.props.label === '决策 Effort')!.props.value).toBe('high');
  expect(changed).not.toHaveBeenCalled();
});

it('requires an explicit initial choice instead of showing an unselected effective default as chosen', () => {
  props.initial = true;
  props.value = {kind: 'default'};
  const ui = modelNodes();
  expect(modelChoice(ui).props.value).toBe('');
  expect(modelChoice(ui).props.options).toContainEqual({value: '', label: '选择模型', disabled: true});
  expect(ui.some(node => node.type === SelectControl && node.props.label === '决策 Effort')).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  modelChoice(ui).props.onChange('model-a');
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'llm', backend: codex.id, model: 'model-a'});
  expect(modelChoice(modelNodes()).props.value).toBe('model-a');
});

it('announces the viewed Provider and blocks saving a different preserved draft during setup browsing', () => {
  modelChoice(modelNodes()).props.onChange('model-b');
  expect(providerChanged).toHaveBeenCalledWith(codex.id);
  changed.mockClear();
  const ui = browse('decision:typesafe');
  expect(providerChanged).toHaveBeenLastCalledWith('decision:typesafe');
  expect(props.value).toEqual({kind: 'llm', backend: codex.id, model: 'model-b'});
  expect(decisionProviderProblem(props.value, providerChoice(ui).props.value, props.groupBackend)).toBe('请先选择当前 Provider 的模型。');
  expect(changed).not.toHaveBeenCalled();
  const returned = browse(codex.id);
  expect(providerChanged).toHaveBeenLastCalledWith(codex.id);
  expect(decisionProviderProblem(props.value, providerChoice(returned).props.value, props.groupBackend)).toBeUndefined();
  expect(modelChoice(modelNodes(returned)).props.value).toBe('model-b');
  expect(changed).not.toHaveBeenCalled();
});

it('checks native, inherited-backend and service selections against the viewed Provider', () => {
  expect(decisionProviderProblem(saved, claude.id, codex.id)).toBeDefined();
  expect(decisionProviderProblem({kind: 'llm', model: 'model-a'}, codex.id, codex.id)).toBeUndefined();
  expect(decisionProviderProblem({kind: 'llm', model: 'model-a'}, claude.id, codex.id)).toBeDefined();
  const jev = {kind: 'decision' as const, provider: 'typesafe', model: 'jev-latest'};
  expect(decisionProviderProblem(jev, codex.id, codex.id)).toBeDefined();
  expect(decisionProviderProblem(jev, 'decision:typesafe', codex.id)).toBeUndefined();
});

it('shows both native Providers while unavailable and offers configuration and login checks', () => {
  props.providers = [];
  const choices = providerChoice().props.choices as Array<{value: string; disabled?: boolean}>;
  for (const id of [codex.id, claude.id]) expect(choices.find(choice => choice.value === id)).toEqual(expect.objectContaining({value: id}));
  expect(choices.some(choice => choice.disabled)).toBe(false);
  let ui = render();
  ui.find(node => node.props.children === '设置 Provider')!.props.onClick();
  expect(openProviders).toHaveBeenCalledOnce();
  ui = browse(claude.id);
  expect(ui.some(node => node.props.title === 'Claude 尚未就绪')).toBe(true);
  expect(ui.some(node => node.type === Catalog)).toBe(false);
  ui.find(node => node.props.children === '检查登录')!.props.onClick();
  expect(hooks.checkLogin).toHaveBeenCalledWith(true);
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  {keySet: false, title: 'Jev 尚未配置'},
  {keySet: true, keyUnreadable: true, title: '无法读取 Jev 密钥'},
])('lets users explore Jev setup without replacing the saved model: $title', state => {
  props.services = [{...services[0]!, keySet: state.keySet, ...('keyUnreadable' in state ? {keyUnreadable: state.keyUnreadable} : {})}];
  const ui = browse('decision:typesafe');
  expect(providerChoice(ui).props.value).toBe('decision:typesafe');
  expect(ui.some(node => node.props.title === state.title)).toBe(true);
  expect(ui.some(node => node.type === SelectControl || node.type === Catalog)).toBe(false);
  ui.find(node => node.props.children === '设置密钥')!.props.onClick();
  expect(openSecrets).toHaveBeenCalledWith('typesafe');
  expect(changed).not.toHaveBeenCalled();
  expect(props.value).toEqual(saved);
  expect(modelChoice(modelNodes(browse(codex.id))).props.value).toBe(saved.model);
  expect(changed).not.toHaveBeenCalled();
});

it('replaces the current model with an explicit Provider and drops the old effort', () => {
  modelChoice(modelNodes()).props.onChange('model-b');
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'llm', backend: codex.id, model: 'model-b'});
  expect(modelChoice(modelNodes()).props.value).toBe('model-b');
});

it('selects a Claude decision model independently from the task Provider', () => {
  props.providers = [codex, claude];
  const ui = browse(claude.id);
  expect(changed).not.toHaveBeenCalled();
  const claudeCatalog: ModelCatalog = {...catalog, backend: claude.id, models: [{...catalog.models[0]!, id: 'haiku', displayName: 'Haiku'}]};
  const choice = modelChoice(modelNodes(ui, claudeCatalog));
  expect(choice.props.value).toBe('');
  choice.props.onChange('haiku');
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'llm', backend: claude.id, model: 'haiku'});
  expect(props.groupBackend).toBe(codex.id);
});

it('allows choosing Jev once the key is configured', () => {
  props.services = [{...services[0]!, keySet: true}];
  const ui = browse('decision:typesafe');
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'decision', provider: 'typesafe', model: 'jev-latest'});
  expect(modelChoice(ui).props.value).toBe('jev-latest');
  expect(ui.some(node => node.props.children === '设置密钥')).toBe(false);
});

it('keeps an unlisted saved model visible and never accepts a hidden or stale catalog entry', () => {
  props.value = {...saved, model: 'retired-model'};
  let choice = modelChoice(modelNodes());
  expect(choice.props.value).toBe('retired-model');
  expect(choice.props.options).toContainEqual({value: 'retired-model', label: 'retired-model（已保存）', disabled: true});
  choice.props.onChange('hidden');
  expect(changed).not.toHaveBeenCalled();
  choice = modelChoice(modelNodes(render(), {...catalog, backend: claude.id}));
  expect(choice.props.disabled).toBe(true);
  choice.props.onChange('model-a');
  expect(changed).not.toHaveBeenCalled();
});
