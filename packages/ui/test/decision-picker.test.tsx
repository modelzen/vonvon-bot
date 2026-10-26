import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {type DecisionReasoningEffort} from '@vonvon/protocol';
import {SelectControl} from '../src/reference/components/ui';
import {DecisionPicker, decisionPickerModels, chosenDecisionModel, type DecisionCatalogs, type DecisionPickerValue} from '../src/settings/DecisionPicker';

// Exercise the component's public event callbacks; browser popup/focus acceptance is separate.
const hooks = vi.hoisted(() => ({state: [] as unknown[], index: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useId: () => 'decision-model-label',
  useState: (initial: unknown) => {const index = hooks.index++; if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial; return [hooks.state[index], (next: unknown) => {hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next;}];},
}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<Record<string, any>>(node) ? [node, ...nodes(node.props.children)] : [];}
function content(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(content).join(''); return isValidElement<Record<string, any>>(node) ? content(node.props.children) : '';}
const model = (id: string, efforts: DecisionReasoningEffort[], hidden = false) => ({id, displayName: id === 'haiku' ? 'Haiku' : id, description: '', hidden, isDefault: false, defaultEffort: 'low' as const, supportedEfforts: efforts});
const catalogs: DecisionCatalogs = {
  'codex-appserver': {kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: [model('gpt-6-luna', ['minimal', 'low', 'high']), model('gpt-6.1-sol', ['none', 'low', 'high']), model('hidden-model', ['low'], true)]},
  'claude-agent': {kind: 'providerModels', backend: 'claude-agent', state: 'ready', models: [model('haiku', ['low', 'high']), model('sonnet', ['low', 'high'])]},
};
const jevModels = [{id: 'jev-latest', displayName: 'Jev'}];
const changed = vi.fn(); const manage = vi.fn();
let props: Parameters<typeof DecisionPicker>[0];
function render() {hooks.index = 0; return nodes(DecisionPicker(props));}
const root = () => render().find(node => node.type === Combobox.Root)!;
const effort = () => render().find(node => node.type === SelectControl && node.props.label === '决策 Effort');
const key = (provider: string, model: string) => JSON.stringify([provider, model]);
const item = (provider: string, model: string) => render().find(node => node.type === Combobox.Item && node.props.value === key(provider, model))!;
beforeEach(() => {hooks.state = []; hooks.index = 0; changed.mockReset(); manage.mockReset(); props = {value: {provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'high'}, catalogs, jevModels, keyState: 'ready', context: 'global', onChange: changed, onManageKey: manage}; changed.mockImplementation((value: DecisionPickerValue) => {props.value = value;});});
it('shows only visible catalog models and independently recommends Codex Luna and Claude Haiku', () => {
  const models = decisionPickerModels({catalogs, jevModels});
  expect(models.map(entry => entry.model)).not.toContain('hidden-model');
  expect(models.filter(entry => entry.recommended).map(entry => [entry.provider, entry.model])).toEqual([['codex-appserver', 'gpt-6-luna'], ['claude-agent', 'haiku']]);
  expect(content(item('claude-agent', 'haiku'))).toContain('推荐');
  expect(content(item('codex-appserver', 'gpt-6-luna'))).toContain('推荐');
  expect(content(item('claude-agent', 'sonnet'))).not.toContain('推荐');
  expect(changed).not.toHaveBeenCalled();
});
it('selects a provider and model together, choosing off when supported and low otherwise', () => {
  root().props.onValueChange(key('codex-appserver', 'gpt-6.1-sol'));
  expect(changed).toHaveBeenLastCalledWith({provider: 'codex-appserver', model: 'gpt-6.1-sol', effort: 'none'});
  root().props.onValueChange(key('codex-appserver', 'gpt-6-luna'));
  expect(changed).toHaveBeenLastCalledWith({provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'low'});
  root().props.onValueChange(key('claude-agent', 'haiku'));
  expect(changed).toHaveBeenLastCalledWith({provider: 'claude-agent', model: 'haiku'});
  expect(effort()?.props).toMatchObject({presentation: 'dropdown', value: ''});
  expect(effort()?.props.options.find((option: {recommended?: boolean}) => option.recommended)).toMatchObject({value: '', label: '关闭思考'});
});
it('does not rewrite a saved effort while rendering and changes only effort on an effort selection', () => {
  expect(effort()?.props.value).toBe('high');
  expect(changed).not.toHaveBeenCalled();
  effort()!.props.onChange('low');
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'low'});
});
it.each(['global', 'group'] as const)('Jev has no effort in %s, even if an old value includes one', context => {
  props.context = context;
  root().props.onValueChange(key('typesafe', 'jev-latest'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'typesafe', model: 'jev-latest'});
  expect(effort()).toBeUndefined();
  props.value = {provider: 'typesafe', model: 'jev-latest', effort: 'high'};
  expect(effort()).toBeUndefined();
  expect(chosenDecisionModel({id: 'x', provider: 'typesafe', model: 'jev-latest', name: 'Jev', efforts: ['high']})).toEqual({provider: 'typesafe', model: 'jev-latest'});
});
it.each(['missing', 'invalid', 'unreadable', 'loading'] as const)('Jev %s key guides from its dropdown row without changing value via pointer or keyboard callbacks', keyState => {
  props.keyState = keyState;
  const original = {...props.value};
  const row = item('typesafe', 'jev-latest');
  expect(content(row)).toContain(keyState === 'missing' ? '添加密钥' : '检查密钥');
  const event = {preventBaseUIHandler: vi.fn()};
  row.props.onClick(event);
  expect(event.preventBaseUIHandler).toHaveBeenCalledOnce();
  expect(manage).toHaveBeenCalledOnce();
  expect(props.value).toEqual(original);
  root().props.onValueChange(key('typesafe', 'jev-latest'));
  expect(manage).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
  expect(props.value).toEqual(original);
});
it('uses a settings destination in groups and never renders a local secret input', () => {
  props.context = 'group'; props.keyState = 'missing';
  const row = item('typesafe', 'jev-latest');
  expect(content(row)).toContain('前往设置');
  expect(content(row)).not.toContain('添加密钥');
  row.props.onClick({preventBaseUIHandler: vi.fn()});
  expect(manage).toHaveBeenCalledOnce();
  expect(render().some(node => node.type === 'input' && node.props.type === 'password')).toBe(false);
  expect(content(render())).not.toContain('跟随全局默认');
});
it('allows Jev only after the key state becomes ready', () => {
  props.keyState = 'missing'; root().props.onValueChange(key('typesafe', 'jev-latest'));
  expect(changed).not.toHaveBeenCalled();
  props.keyState = 'ready'; root().props.onValueChange(key('typesafe', 'jev-latest'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'typesafe', model: 'jev-latest'});
});
it('keeps an unavailable saved model visible without silently substituting another model', () => {
  props.value = {provider: 'codex-appserver', model: 'retired-model', effort: 'high'};
  expect(root().props.value).toBe(key('codex-appserver', 'retired-model'));
  expect(item('codex-appserver', 'retired-model').props.disabled).toBe(true);
  expect(content(item('codex-appserver', 'retired-model'))).toContain('已保存');
  expect(effort()?.props.value).toBe('high');
  root().props.onValueChange(key('codex-appserver', 'retired-model'));
  expect(changed).not.toHaveBeenCalled();
});
it('preserves custom model IDs and saved effort while the catalog is unavailable', () => {
  props.value = {provider: 'codex-appserver', model: 'gateway/custom', custom: true, effort: 'high'};
  props.catalogs = {};
  expect(root().props.value).toBe(key('codex-appserver', 'gateway/custom'));
  expect(effort()?.props.value).toBe('high');
  expect(effort()?.props.options.some((option: {recommended?: boolean}) => option.recommended)).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  effort()!.props.onChange('');
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'codex-appserver', model: 'gateway/custom', custom: true});
});
it('searches across provider and model names without changing the selection', () => {
  root().props.onInputValueChange('Claude');
  expect(root().props.filteredItems).toEqual([key('claude-agent', 'haiku'), key('claude-agent', 'sonnet')]);
  root().props.onInputValueChange('Jev');
  expect(root().props.filteredItems).toEqual([key('typesafe', 'jev-latest')]);
  expect(changed).not.toHaveBeenCalled();
});
it('blocks unavailable providers, unknown IDs and readonly model and effort callbacks', () => {
  props.availableProviders = ['codex-appserver'];
  expect(item('claude-agent', 'haiku').props.disabled).toBe(true);
  root().props.onValueChange(key('claude-agent', 'haiku'));
  root().props.onValueChange('unknown');
  props.disabled = true; props.keyState = 'missing';
  root().props.onValueChange(key('codex-appserver', 'gpt-6.1-sol'));
  root().props.onValueChange(key('typesafe', 'jev-latest'));
  item('typesafe', 'jev-latest').props.onClick({preventBaseUIHandler: vi.fn()});
  effort()!.props.onChange('low');
  expect(changed).not.toHaveBeenCalled(); expect(manage).not.toHaveBeenCalled();
});
it('reselecting the current catalog model preserves an explicit effort instead of resetting it', () => {
  root().props.onValueChange(key('codex-appserver', 'gpt-6-luna'));
  expect(props.value).toEqual({provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'high'});
  expect(changed).not.toHaveBeenCalled();
  props.value = {provider: 'claude-agent', model: 'haiku', effort: 'high'};
  root().props.onValueChange(key('claude-agent', 'haiku'));
  expect(props.value).toEqual({provider: 'claude-agent', model: 'haiku', effort: 'high'});
  expect(changed).not.toHaveBeenCalled();
});
it('ignores stale or invalid effort callbacks without dropping the saved effort', () => {
  effort()!.props.onChange('not-supported');
  props.catalogs = {};
  effort()!.props.onChange('low');
  expect(props.value?.effort).toBe('high');
  expect(changed).not.toHaveBeenCalled();
});
it('keeps Claude alias identities and the Haiku recommendation when a gateway maps aliases to one target', () => {
  const aliases = ['haiku', 'sonnet', 'opus', 'opusplan', 'haiku[1m]', 'sonnet[1m]', 'opus[1m]'];
  props.catalogs = {...catalogs, 'claude-agent': {...catalogs['claude-agent']!, models: aliases.map(id => ({...model(id, ['low', 'high']), displayName: 'deepseek-flash[1m]'}))}};
  const mapped = decisionPickerModels({catalogs: props.catalogs}).filter(entry => entry.provider === 'claude-agent');
  expect(mapped.map(entry => [entry.model, entry.name, entry.detail])).toEqual([
    ['haiku', 'Haiku', 'deepseek-flash[1m]'], ['sonnet', 'Sonnet', 'deepseek-flash[1m]'], ['opus', 'Opus', 'deepseek-flash[1m]'], ['opusplan', 'Opus Plan', 'deepseek-flash[1m]'],
    ['haiku[1m]', 'Haiku · 1M', 'deepseek-flash[1m]'], ['sonnet[1m]', 'Sonnet · 1M', 'deepseek-flash[1m]'], ['opus[1m]', 'Opus · 1M', 'deepseek-flash[1m]'],
  ]);
  expect(mapped.filter(entry => entry.recommended).map(entry => entry.model)).toEqual(['haiku']);
  const row = item('claude-agent', 'haiku');
  expect(nodes(row).find(node => node.type === 'strong')?.props.children).toBe('Haiku');
  expect(content(row)).toContain('deepseek-flash[1m]');
  root().props.onValueChange(key('claude-agent', 'haiku'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'claude-agent', model: 'haiku'});
  const trigger = render().find(node => node.type === Combobox.Trigger)!;
  expect(content(trigger)).toContain('Haiku');
  expect(content(trigger)).toContain('deepseek-flash[1m]');
});
it('finds mapped Claude choices by alias or gateway target while preserving their IDs', () => {
  props.catalogs = {...catalogs, 'claude-agent': {...catalogs['claude-agent']!, models: ['haiku', 'sonnet', 'opus'].map(id => ({...model(id, ['low']), displayName: 'gateway-model'}))}};
  root().props.onInputValueChange('Haiku');
  expect(root().props.filteredItems).toEqual([key('claude-agent', 'haiku')]);
  root().props.onInputValueChange('gateway-model');
  expect(root().props.filteredItems).toEqual(['haiku', 'sonnet', 'opus'].map(id => key('claude-agent', id)));
  expect(changed).not.toHaveBeenCalled();
});
it('disambiguates unknown models with identical display names using their concrete IDs', () => {
  props.catalogs = {...catalogs, 'claude-agent': {...catalogs['claude-agent']!, models: ['gateway-a', 'gateway-b'].map(id => ({...model(id, ['low']), displayName: 'Shared label'}))}};
  const mapped = decisionPickerModels({catalogs: props.catalogs}).filter(entry => entry.provider === 'claude-agent');
  expect(mapped.map(entry => [entry.model, entry.name, entry.detail])).toEqual([['gateway-a', 'Shared label', 'gateway-a'], ['gateway-b', 'Shared label', 'gateway-b']]);
  expect(content(item('claude-agent', 'gateway-a'))).toContain('gateway-a');
  root().props.onInputValueChange('gateway-b');
  expect(root().props.filteredItems).toEqual([key('claude-agent', 'gateway-b')]);
  root().props.onValueChange(key('claude-agent', 'gateway-b'));
  expect(changed).toHaveBeenCalledExactlyOnceWith({provider: 'claude-agent', model: 'gateway-b'});
});
