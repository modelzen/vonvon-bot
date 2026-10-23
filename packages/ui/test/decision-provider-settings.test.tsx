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
const defaults = {byProvider: {'codex-appserver': {model: 'luna', effort: 'low' as const}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}}};
const model = (id: string, supportedEfforts: Array<'low' | 'high'>) => ({id, displayName: id, description: '', hidden: false, isDefault: false, defaultEffort: 'low' as const, supportedEfforts});
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
  expect(select(ui, 'Codex 决策 Effort').props.options.map((item: {value: string}) => item.value)).toEqual(['', 'low', 'high']);
  expect(select(ui, 'Claude 决策 Effort').props.disabled).toBe(true);
  expect(select(ui, 'TypeSafe · Jev 决策模型').props.value).toBe('jev-latest');
  expect(ui.some(node => node.type === SelectControl && node.props.label === 'TypeSafe · Jev 决策 Effort')).toBe(false);
  expect(input.onChange).not.toHaveBeenCalled();
});
it('saves only the edited Provider and resets model-specific effort when switching model', () => {
  const input = {...props(), value: {byProvider: {'claude-agent': {model: 'haiku'}}}};
  const ui = nodes(DecisionProviderFields(input));
  select(ui, 'Codex 决策模型').props.onChange('other');
  expect(input.onChange).toHaveBeenCalledWith({byProvider: {'claude-agent': {model: 'haiku'}, 'codex-appserver': {model: 'other'}}});
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
