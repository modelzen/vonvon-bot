import {expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {type SecretService} from '@vonvon/protocol';
import {DecisionProviderFields} from '../src/management/DecisionProviderSettings';
import {DecisionPicker} from '../src/settings/DecisionPicker';

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.trailing)];
}
const defaults = {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'low' as const}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}}};
const model = (id: string, supportedEfforts: Array<'none' | 'minimal' | 'low' | 'high'>) => ({id, displayName: id, description: '', hidden: false, isDefault: false, defaultEffort: 'low' as const, supportedEfforts});
const catalogs = {
  'codex-appserver': {kind: 'providerModels' as const, backend: 'codex-appserver' as const, state: 'ready' as const, models: [model('gpt-6-luna', ['low', 'high']), model('other', ['low'])]},
  'claude-agent': {kind: 'providerModels' as const, backend: 'claude-agent' as const, state: 'ready' as const, models: [model('haiku', []), model('sonnet', ['low', 'high'])]},
};
const service = (status: SecretService['status']): SecretService => ({provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', status, models: [{id: 'jev-latest', displayName: 'Jev'}], inUse: []});
const props = () => ({value: {byProvider: {}}, defaults, catalogs, services: [service('set')], disabled: false, onChange: vi.fn(), onManageKey: vi.fn()});
function picker(input: Parameters<typeof DecisionProviderFields>[0]) {
  const matches = nodes(DecisionProviderFields(input)).filter(node => node.type === DecisionPicker);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
it('presents one global picker with the effective default and does not write on render', () => {
  const input = props();
  expect(picker(input).props).toMatchObject({context: 'global', value: {provider: 'codex-appserver', model: 'gpt-6-luna', effort: 'low'}});
  expect(input.onChange).not.toHaveBeenCalled();
});
it('selecting a model changes the default provider and that profile while preserving other profiles', () => {
  const input = {...props(), value: {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'custom-codex', custom: true}, typesafe: {model: 'jev-latest'}}}};
  picker(input).props.onChange({provider: 'claude-agent', model: 'sonnet', effort: 'high'});
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({defaultProvider: 'claude-agent', byProvider: {'codex-appserver': {model: 'custom-codex', custom: true}, typesafe: {model: 'jev-latest'}, 'claude-agent': {model: 'sonnet', effort: 'high'}}});
});
it('keeps a saved custom model and effort when discovery fails or the global default changes', () => {
  const input = {...props(), catalogs: {}, value: {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'gateway/model', custom: true, effort: 'high' as const}}}};
  expect(picker(input).props.value).toEqual({provider: 'codex-appserver', model: 'gateway/model', custom: true, effort: 'high'});
  expect(input.onChange).not.toHaveBeenCalled();
});
it('stores Jev without an effort field and preserves inactive provider profiles', () => {
  const input = {...props(), value: {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'high' as const}}}};
  picker(input).props.onChange({provider: 'typesafe', model: 'jev-latest'});
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({defaultProvider: 'typesafe', byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'high'}, typesafe: {model: 'jev-latest'}}});
});
it('does not edit a readonly global default even when its callback is invoked', () => {
  const input = {...props(), disabled: true};
  const control = picker(input);
  expect(control.props.disabled).toBe(true);
  control.props.onChange({provider: 'claude-agent', model: 'haiku'});
  expect(input.onChange).not.toHaveBeenCalled();
});
it.each([
  ['set', 'ready'], ['missing', 'missing'], ['invalid', 'invalid'], ['unreadable', 'unreadable'],
] as const)('passes the actual %s key state to the picker and opens global key management', (status, keyState) => {
  const input = {...props(), services: [service(status)]};
  const control = picker(input);
  expect(control.props.keyState).toBe(keyState);
  control.props.onManageKey();
  expect(input.onManageKey).toHaveBeenCalledOnce();
  expect(input.onChange).not.toHaveBeenCalled();
});
it('distinguishes loading key state from a missing key', () => {
  const input = {...props(), services: undefined};
  expect(picker(input).props.keyState).toBe('loading');
});
it('preserves a saved effort without replacing it with the recommendation', () => {
  const input = {...props(), value: {defaultProvider: 'codex-appserver' as const, byProvider: {'codex-appserver': {model: 'gpt-6-luna', effort: 'high' as const}}}};
  expect(picker(input).props.value.effort).toBe('high');
  expect(input.onChange).not.toHaveBeenCalled();
});
it('retains the custom endpoint when selecting its model and strips API effort fields', () => {
  const input = {...props(), value: {defaultProvider: 'codex-appserver' as const, byProvider: {custom: {model: 'private-jev', endpoint: 'https://example.com/judge', effort: 'high' as const}}}};
  picker(input).props.onChange({provider: 'custom', model: 'private-jev', effort: 'high', custom: true});
  expect(input.onChange).toHaveBeenCalledExactlyOnceWith({defaultProvider: 'custom', byProvider: {custom: {model: 'private-jev', endpoint: 'https://example.com/judge'}}});
});
it('edits the shared custom endpoint and model independently without changing the host default', () => {
  const input = {...props(), value: {defaultProvider: 'claude-agent' as const, byProvider: {custom: {model: 'private-jev', endpoint: 'https://example.com/judge'}}}};
  const fields = nodes(DecisionProviderFields(input));
  const endpoint = fields.find(node => node.props['aria-label'] === '自定义决策请求地址')!;
  const model = fields.find(node => node.props['aria-label'] === '自定义接口模型 ID')!;
  expect(endpoint.props.defaultValue).toBe('https://example.com/judge');
  expect(model.props.defaultValue).toBe('private-jev');
  endpoint.props.onBlur({currentTarget: {value: ' https://new.example.com/system-one '}});
  expect(input.onChange).toHaveBeenLastCalledWith({defaultProvider: 'claude-agent', byProvider: {custom: {model: 'private-jev', endpoint: 'https://new.example.com/system-one'}}});
  model.props.onBlur({currentTarget: {value: ' private-system-one '}});
  expect(input.onChange).toHaveBeenLastCalledWith({defaultProvider: 'claude-agent', byProvider: {custom: {model: 'private-system-one', endpoint: 'https://example.com/judge'}}});
});
it('shows all four service states and the configured custom model in the global picker', () => {
  const input = {...props(), value: {byProvider: {custom: {model: 'private-jev', endpoint: 'https://example.com/judge'}}}, services: [service('set'),
    {...service('missing'), provider: 'openrouter', displayName: 'OpenRouter', keyId: 'openrouter-api-key', models: [{id: 'typesafe/jev-1.14', displayName: 'Jev'}]},
    {...service('invalid'), provider: 'vercel', displayName: 'Vercel', keyId: 'vercel-api-key', models: [{id: 'typesafe-ai/jev', displayName: 'Jev'}]},
    {...service('set'), provider: 'custom', displayName: '自定义 Jev', keyId: 'custom-decision-api-key'},
  ]};
  const control = picker(input);
  expect(control.props.decisionServices.map((service: {provider: string; keyState: string}) => [service.provider, service.keyState])).toEqual([
    ['typesafe', 'ready'], ['openrouter', 'missing'], ['vercel', 'invalid'], ['custom', 'ready'],
  ]);
  expect(control.props.decisionServices.find((service: {provider: string}) => service.provider === 'custom')).toMatchObject({models: [{id: 'private-jev', displayName: 'Jev / System One'}], endpointConfigured: true});
  control.props.onManageKey('vercel');
  expect(input.onManageKey).toHaveBeenCalledExactlyOnceWith('vercel');
});
it('blocks readonly custom connection callbacks', () => {
  const input = {...props(), disabled: true};
  for (const field of nodes(DecisionProviderFields(input)).filter(node => node.type === 'input')) {
    expect(field.props.disabled).toBe(true);
    field.props.onBlur({currentTarget: {value: 'changed'}});
  }
  expect(input.onChange).not.toHaveBeenCalled();
});
// owner 2026-11-02: the shared endpoint and key are the device's
it('says whose Bots share the custom endpoint and key', () => {
  const note = (place?: string) => nodes(DecisionProviderFields({...props(), ...(place ? {place} : {})})).find(node => node.type === 'p' && node.props.className === 'decision-connection-note');
  const words = (node: Element | undefined) => [node?.props.children].flat(2).join('');
  expect(words(note())).toBe('此接口与密钥供本机使用该服务的 Bot 和群共用。');
  expect(words(note('「机房 Linux」上'))).toBe('此接口与密钥供「机房 Linux」上使用该服务的 Bot 和群共用。');
});
