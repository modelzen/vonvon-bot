import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DecisionModelsView, type JudgeSelectionView} from '@vonvon/protocol';
import {DecisionFields, providerDecisionProblem} from '../src/settings/DecisionFields';
import {DecisionPicker} from '../src/settings/DecisionPicker';

vi.mock('../src/settings/useDecisionCatalogs', () => ({useDecisionCatalogs: () => ({catalogs: {}, refresh: vi.fn()})}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children)];}
function content(node: ReactNode): string {if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(content).join(''); return isValidElement<Record<string, any>>(node) ? content(node.props.children) : '';}
const codex = {id: 'codex-appserver', displayName: 'Codex'};
const claude = {id: 'claude-agent', displayName: 'Claude'};
const services: DecisionModelsView = [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', keySet: true, models: [{id: 'jev-latest', displayName: 'Jev'}]}];
const changed = vi.fn<(selection: JudgeSelectionView) => void>();
let props: Parameters<typeof DecisionFields>[0];
function render() {return nodes(DecisionFields(props));}
function picker() {return render().find(node => node.type === DecisionPicker)!;}
beforeEach(() => {
  changed.mockReset();
  props = {botId: agentIdSchema.parse('cli_decision'), groupBackend: codex.id,
    value: {kind: 'llm', backend: codex.id, model: 'creation-model', effort: 'high'}, effective: {kind: 'llm', backend: codex.id, model: 'creation-model', effort: 'high'}, onChange: changed,
    disabled: false, providers: [codex, claude], services,
    configuration: {kind: 'ready', configuration: {defaultProvider: 'claude-agent', byProvider: {'codex-appserver': {model: 'new-codex', effort: 'low'}, 'claude-agent': {model: 'haiku'}, typesafe: {model: 'jev-latest'}}}},
    onOpenProviders: vi.fn(), onOpenSecrets: vi.fn(), onProviderChange: vi.fn()};
  changed.mockImplementation(value => {props.value = value;});
});
it('shows the group creation snapshot and never offers a follow-global choice', () => {
  expect(picker().props).toMatchObject({context: 'group', value: {provider: codex.id, model: 'creation-model', effort: 'high'}});
  expect(content(render())).not.toMatch(/跟随全局|随全局|使用统一配置|恢复全局默认/);
  expect(changed).not.toHaveBeenCalled();
});
it('keeps the group model and effort when the host default or profile changes', () => {
  const before = picker().props.value;
  props.configuration = {kind: 'ready', configuration: {defaultProvider: 'typesafe', byProvider: {typesafe: {model: 'jev-new'}, 'codex-appserver': {model: 'host-changed', effort: 'low'}}}};
  expect(picker().props.value).toEqual(before);
  expect(changed).not.toHaveBeenCalled();
});
it('writes the entire native selection into the group instead of a provider reference', () => {
  picker().props.onChange({provider: claude.id, model: 'haiku', effort: 'low'});
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'llm', backend: claude.id, model: 'haiku', effort: 'low'});
  expect(props.onProviderChange).toHaveBeenCalledWith(claude.id);
});
it('preserves explicit custom model and effort during edits', () => {
  props.value = {kind: 'llm', backend: codex.id, model: 'gateway/private', custom: true, effort: 'high'};
  expect(picker().props.value).toEqual({provider: codex.id, model: 'gateway/private', custom: true, effort: 'high'});
  picker().props.onChange({provider: codex.id, model: 'gateway/private', custom: true});
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'llm', backend: codex.id, model: 'gateway/private', custom: true});
});
it('writes Jev as a concrete group model without an effort field', () => {
  picker().props.onChange({provider: 'typesafe', model: 'jev-latest'});
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'decision', provider: 'typesafe', model: 'jev-latest'});
});
it('opens global Jev key settings without rendering a credential editor in the group', () => {
  picker().props.onManageKey();
  expect(props.onOpenSecrets).toHaveBeenCalledExactlyOnceWith('typesafe');
  expect(render().some(node => node.type === 'input' && node.props.type === 'password')).toBe(false);
  expect(changed).not.toHaveBeenCalled();
});
it.each([[true, false, 'ready'], [false, false, 'missing'], [true, true, 'unreadable']] as const)('passes actual Jev key state (set=%s, unreadable=%s)', (keySet, keyUnreadable, expected) => {
  props.services = services.map(service => ({...service, keySet, keyUnreadable}));
  expect(picker().props.keyState).toBe(expected);
});
it('does not treat an unavailable key read as a missing key', () => {
  props.services = undefined;
  expect(picker().props.keyState).not.toBe('missing');
  expect(providerDecisionProblem({kind: 'decision', provider: 'typesafe', model: 'jev-latest'}, [codex], undefined)).toContain('读取');
});
it('retains the effective model supplied for a legacy default while the host profile is different', () => {
  props.value = {kind: 'default'};
  props.effective = {kind: 'llm', backend: codex.id, model: 'retained-group-model', effort: 'high'};
  expect(picker().props.value).toEqual({provider: codex.id, model: 'retained-group-model', effort: 'high'});
  expect(changed).not.toHaveBeenCalled();
});
it('keeps the group usable without host configuration when its model is explicit', () => {
  props.configuration = {kind: 'failed'};
  expect(picker().props.value).toMatchObject({model: 'creation-model', effort: 'high'});
  expect(providerDecisionProblem(props.value, props.providers, services, props.configuration)).toBeUndefined();
});
it('keeps unavailable saved models visible and blocks readonly callbacks', () => {
  props.providers = [codex]; props.value = {kind: 'llm', backend: claude.id, model: 'haiku'};
  expect(picker().props.value).toEqual({provider: claude.id, model: 'haiku'});
  expect(picker().props.availableProviders).toEqual([codex.id]);
  expect(providerDecisionProblem(props.value, props.providers, services)).toContain('不可用');
  props.disabled = true;
  expect(picker().props.disabled).toBe(true);
  picker().props.onChange({provider: codex.id, model: 'gpt-6-luna'});
  expect(changed).not.toHaveBeenCalled();
});
it('does not overwrite future decision settings that this client cannot interpret', () => {
  props.value = {kind: 'future'};
  expect(content(render())).toContain('无法编辑');
  const control = picker();
  if (control) {expect(control.props.disabled).toBe(true); control.props.onChange({provider: codex.id, model: 'gpt-6-luna'});}
  expect(changed).not.toHaveBeenCalled();
});
it.each([{kind: 'loading'}, {kind: 'failed'}, {kind: 'ready', configuration: {byProvider: {}}}] as const)('rejects an unresolved creation default while configuration is %j', configuration => {
  expect(providerDecisionProblem({kind: 'default'}, [codex], services, configuration)).toBeDefined();
});
it.each([
  [{kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna'}, [codex], true, undefined],
  [{kind: 'llm', backend: 'claude-agent', model: 'haiku'}, [codex], true, '不可用'],
  [{kind: 'decision', provider: 'typesafe', model: 'jev-latest'}, [codex], false, '密钥'],
] as const)('validates concrete group selections %j against runtime availability', (value, providers, keySet, message) => {
  const result = providerDecisionProblem(value as JudgeSelectionView, [...providers], services.map(service => ({...service, keySet})));
  if (message) expect(result).toContain(message); else expect(result).toBeUndefined();
});
it.each(['openrouter', 'vercel', 'custom'] as const)('writes %s as a concrete decision selection and opens its own key settings', provider => {
  picker().props.onChange({provider, model: 'jev-provider-model', effort: 'high'});
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'decision', provider, model: 'jev-provider-model'});
  picker().props.onManageKey(provider);
  expect(props.onOpenSecrets).toHaveBeenCalledExactlyOnceWith(provider);
});
it('uses each hosted provider key state instead of the TypeSafe key state', () => {
  props.services = [...services,
    {provider: 'openrouter', displayName: 'OpenRouter', keyId: 'openrouter-api-key', keySet: false, models: [{id: 'typesafe/jev-1.14', displayName: 'Jev'}]},
    {provider: 'vercel', displayName: 'Vercel', keyId: 'vercel-api-key', keySet: true, models: [{id: 'typesafe-ai/jev', displayName: 'Jev'}]},
    {provider: 'custom', displayName: '自定义 Jev', keyId: 'custom-decision-api-key', keySet: true, endpointConfigured: false, models: [{id: 'jev-latest', displayName: 'Jev'}]},
  ];
  expect(picker().props.decisionServices.map((service: {provider: string; keyState: string}) => [service.provider, service.keyState])).toEqual([
    ['typesafe', 'ready'], ['openrouter', 'missing'], ['vercel', 'ready'], ['custom', 'ready'],
  ]);
  expect(providerDecisionProblem({kind: 'decision', provider: 'openrouter', model: 'typesafe/jev-1.14'}, [codex], props.services)).toContain('OpenRouter 密钥');
  expect(providerDecisionProblem({kind: 'decision', provider: 'vercel', model: 'typesafe-ai/jev'}, [codex], props.services)).toBeUndefined();
  expect(providerDecisionProblem({kind: 'decision', provider: 'custom', model: 'jev-latest'}, [codex], props.services)).toContain('接口地址');
});
