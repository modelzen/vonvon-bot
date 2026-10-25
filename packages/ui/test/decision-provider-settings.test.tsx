import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DecisionProviderFields} from '../src/management/DecisionProviderSettings';
import {SelectControl} from '../src/reference/components/ui';
import {SettingsRow} from '../src/reference/components/system-settings';

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...(node.type === SettingsRow ? nodes(node.props.trailing) : [])];
}
const defaults = {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'luna', effort: 'low' as const}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}}};
const model = (id: string, supportedEfforts: Array<'none' | 'minimal' | 'low' | 'high'>) => ({id, displayName: id, description: '', hidden: false, isDefault: false, defaultEffort: 'low' as const, supportedEfforts});
const catalogs = {
  'codex-appserver': {kind: 'providerModels' as const, backend: 'codex-appserver' as const, state: 'ready' as const, models: [model('luna', ['low', 'high']), model('other', ['low']), {...model('hidden', []), hidden: true}]},
  'claude-agent': {kind: 'providerModels' as const, backend: 'claude-agent' as const, state: 'ready' as const, models: [model('haiku', []), model('sonnet', ['low', 'high'])]},
};
const props = () => ({value: {byProvider: {}}, defaults, catalogs, disabled: false, onChange: vi.fn()});
function select(ui: Element[], label: string) {return ui.find(node => node.type === SelectControl && node.props.label === label)!;}
it('configures all three Providers without a Bot and only shows supported efforts', () => {
  const input = props(); const ui = nodes(DecisionProviderFields(input));
  expect(select(ui, 'Codex 决策模型').props.value).toBe('luna');
  expect(select(ui, 'Codex 决策模型').props.options.map((item: {value: string}) => item.value)).toEqual(['luna', 'other']);
  expect(select(ui, 'Codex 决策 Effort').props.options.map((item: {value: string}) => item.value)).toEqual(['low', 'high']);
  expect(select(ui, 'Claude 决策 Effort').props.disabled).toBe(true);
  expect(select(ui, 'TypeSafe · Jev 决策模型').props.value).toBe('jev-latest');
  expect(ui.some(node => node.type === SelectControl && node.props.label === 'TypeSafe · Jev 决策 Effort')).toBe(false);
  expect(input.onChange).not.toHaveBeenCalled();
});
it('saves only the edited Provider and resets model-specific effort when switching model', () => {
  const input = {...props(), value: {byProvider: {'claude-agent': {model: 'haiku'}}}};
  const ui = nodes(DecisionProviderFields(input));
  select(ui, 'Codex 决策模型').props.onChange('other');
  expect(input.onChange).toHaveBeenCalledWith({byProvider: {'claude-agent': {model: 'haiku'}, 'codex-appserver': {model: 'other', effort: 'low'}}});
  input.onChange.mockClear();
  select(ui, 'Codex 决策 Effort').props.onChange('high');
  expect(input.onChange).toHaveBeenCalledWith({byProvider: {'claude-agent': {model: 'haiku'}, 'codex-appserver': {model: 'luna', effort: 'high'}}});
});
it('preserves saved values when discovery fails and offers Provider setup', () => {
  const input = {...props(), catalogs: {}, value: {byProvider: {'codex-appserver': {model: 'gateway/model', effort: 'high' as const}}}, onOpenProviders: vi.fn()};
  const ui = nodes(DecisionProviderFields(input));
  expect(select(ui, 'Codex 决策模型').props.value).toBe('gateway/model');
  expect(select(ui, 'Codex 决策模型').props.disabled).toBe(true);
  expect(select(ui, 'Codex 决策 Effort').props.value).toBe('high');
  expect(input.onChange).not.toHaveBeenCalled();
  const text = renderToStaticMarkup(<DecisionProviderFields {...input}/>);
  expect(text).toContain('设置 Provider'); expect(text).not.toContain('vonvon secrets');
});
it('lets custom model IDs preserve the other Provider settings', () => {
  const input = {...props(), value: {byProvider: {'codex-appserver': {model: 'custom-a', custom: true}, typesafe: {model: 'jev-latest'}}}};
  const ui = nodes(DecisionProviderFields(input));
  ui.find(node => node.type === 'input' && node.props['aria-label'] === 'Codex 决策模型 ID')!.props.onChange({target: {value: 'custom-b'}});
  expect(input.onChange).toHaveBeenCalledWith({byProvider: {'codex-appserver': {model: 'custom-b', custom: true}, typesafe: {model: 'jev-latest'}}});
});
it('uses the discovered default for an unsaved profile without writing it', () => {
  const input = {...props(), catalogs: {...catalogs, 'codex-appserver': {...catalogs['codex-appserver'], models: [model('fallback', ['minimal', 'low']), {...model('preferred', ['none', 'low']), isDefault: true}]}}};
  const ui = nodes(DecisionProviderFields(input));
  expect(select(ui, 'Codex 决策模型').props.value).toBe('preferred');
  const effort = select(ui, 'Codex 决策 Effort');
  expect(effort.props.value).toBe('none');
  expect(effort.props.options.find((option: {recommended?: boolean}) => option.recommended)).toEqual({value: 'none', label: '关闭思考', recommended: true});
  expect(input.onChange).not.toHaveBeenCalled();
});
it('keeps both effort controls as dropdowns and recommends low ahead of minimal', () => {
  const input = {...props(), catalogs: {...catalogs, 'codex-appserver': {...catalogs['codex-appserver'], models: [model('luna', ['minimal', 'low', 'high'])]}}};
  const ui = nodes(DecisionProviderFields(input));
  const effort = select(ui, 'Codex 决策 Effort');
  expect(effort.props.presentation).toBe('dropdown');
  expect(select(ui, 'Claude 决策 Effort').props.presentation).toBe('dropdown');
  expect(effort.props.value).toBe('low');
  expect(effort.props.options.filter((option: {recommended?: boolean}) => option.recommended).map((option: {value: string}) => option.value)).toEqual(['low']);
});
it.each(['minimal', 'high'] as const)('preserves an explicitly saved %s instead of applying the recommendation', effort => {
  const input = {...props(), value: {byProvider: {'codex-appserver': {model: 'luna', effort}}}, catalogs: {...catalogs, 'codex-appserver': {...catalogs['codex-appserver'], models: [model('luna', ['none', 'minimal', 'low', 'high'])]}}};
  expect(select(nodes(DecisionProviderFields(input)), 'Codex 决策 Effort').props.value).toBe(effort);
  expect(input.onChange).not.toHaveBeenCalled();
});
it('selects none for a newly selected model that supports disabling thought, and guards readonly edits', () => {
  const input = {...props(), catalogs: {...catalogs, 'codex-appserver': {...catalogs['codex-appserver'], models: [model('luna', ['low']), model('no-thought', ['none', 'low'])]}}};
  select(nodes(DecisionProviderFields(input)), 'Codex 决策模型').props.onChange('no-thought');
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({byProvider: {'codex-appserver': {model: 'no-thought', effort: 'none'}}});
  input.onChange.mockClear();
  select(nodes(DecisionProviderFields({...input, disabled: true})), 'Codex 决策模型').props.onChange('no-thought');
  expect(input.onChange).not.toHaveBeenCalled();
});
it('does not invent a supported effort or recommendation for a custom model', () => {
  const input = {...props(), value: {byProvider: {'codex-appserver': {model: 'custom-a', custom: true}}}};
  const effort = select(nodes(DecisionProviderFields(input)), 'Codex 决策 Effort');
  expect(effort.props.value).toBe('');
  expect(effort.props.options[0]).toMatchObject({value: '', label: '未指定'});
  expect(effort.props.options.some((option: {recommended?: boolean}) => option.recommended)).toBe(false);
  expect(input.onChange).not.toHaveBeenCalled();
});
it('allows removing a custom model effort without claiming that the model supports none', () => {
  const input = {...props(), value: {byProvider: {'codex-appserver': {model: 'custom-a', custom: true, effort: 'high' as const}}}};
  const effort = select(nodes(DecisionProviderFields(input)), 'Codex 决策 Effort');
  expect(effort.props.options[0]).toMatchObject({value: '', label: '未指定'});
  effort.props.onChange('');
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({byProvider: {'codex-appserver': {model: 'custom-a', custom: true}}});
});

it('shows the configured global default without changing any profile', () => {
  const input = {...props(), value: {defaultProvider: 'claude-agent' as const, byProvider: {'codex-appserver': {model: 'custom-codex'}}}};
  const ui = nodes(DecisionProviderFields(input));
  const control = select(ui, '默认决策模型');
  expect(control.props.value).toBe('claude-agent');
  expect(control.props.options.map((option: {value: string}) => option.value)).toEqual(['codex-appserver', 'claude-agent', 'typesafe']);
  expect(input.onChange).not.toHaveBeenCalled();
  control.props.onChange('typesafe');
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({defaultProvider: 'typesafe', byProvider: {'codex-appserver': {model: 'custom-codex'}}});
});
it('preserves the selected global default while editing one provider profile', () => {
  const input = {...props(), value: {defaultProvider: 'typesafe' as const, byProvider: {'claude-agent': {model: 'haiku'}}}};
  const ui = nodes(DecisionProviderFields(input));
  select(ui, 'Codex 决策模型').props.onChange('other');
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({defaultProvider: 'typesafe', byProvider: {'claude-agent': {model: 'haiku'}, 'codex-appserver': {model: 'other', effort: 'low'}}});
});
it('displays the effective global default until explicitly changed and guards disabled changes', () => {
  const input = props();
  expect(select(nodes(DecisionProviderFields(input)), '默认决策模型').props.value).toBe('codex-appserver');
  expect(input.onChange).not.toHaveBeenCalled();
  select(nodes(DecisionProviderFields({...input, disabled: true})), '默认决策模型').props.onChange('typesafe');
  expect(input.onChange).not.toHaveBeenCalled();
});
