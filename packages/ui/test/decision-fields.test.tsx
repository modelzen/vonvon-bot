import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DecisionModelsView, type JudgeSelectionView} from '@vonvon/protocol';
import {DecisionFields, providerDecisionProblem} from '../src/settings/DecisionFields';
import {SettingChoices} from '../src/settings/SettingChoices';
import {renderToStaticMarkup} from 'react-dom/server';
import {Button} from '../src/reference/components/ui';

const state = vi.hoisted(() => ({values: [] as unknown[], index: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(), useState: (initial: unknown) => {
  const index = state.index++;
  if (!(index in state.values)) state.values[index] = initial;
  return [state.values[index], (next: unknown) => {state.values[index] = typeof next === 'function' ? next(state.values[index]) : next;}];
}}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {if (Array.isArray(node)) return node.flatMap(nodes); if (!isValidElement<Record<string, any>>(node)) return []; return [node, ...nodes(node.props.children)];}
const codex = {id: 'codex-appserver', displayName: 'Codex'};
const claude = {id: 'claude-agent', displayName: 'Claude'};
const services: DecisionModelsView = [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', keySet: false, models: [{id: 'jev', displayName: 'Jev'}]}];
const changed = vi.fn<(selection: JudgeSelectionView) => void>();
let props: Parameters<typeof DecisionFields>[0];
function render() {state.index = 0; return nodes(DecisionFields(props));}
function choice(ui = render()) {return ui.find(node => node.type === SettingChoices && node.props.label === '判断 Provider')!;}
beforeEach(() => {
  state.values = []; state.index = 0; changed.mockReset();
  props = {botId: agentIdSchema.parse('cli_decision'), groupBackend: codex.id, value: {kind: 'default'}, effective: {kind: 'default'}, onChange: changed,
    disabled: false, providers: [codex], services, onOpenProviders: vi.fn(), onOpenSecrets: vi.fn()};
  changed.mockImplementation(value => {props.value = value;});
});
it('starts unselected and writes only the chosen judgment Provider', () => {
  expect(choice().props.value).toBe('');
  expect(choice().props.choices.map((item: {value: string; label: string}) => [item.value, item.label])).toEqual([
    [codex.id, 'Codex'], [claude.id, 'Claude'], ['typesafe', 'Jev'],
  ]);
  expect(changed).not.toHaveBeenCalled();
  expect(render().some(node => node.props.children === '选择一个已就绪的 Provider。')).toBe(true);
  choice().props.onChange(codex.id);
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'provider', provider: codex.id});
  expect(choice().props.value).toBe(codex.id);
  expect(render().some(node => node.props.label === '决策模型' || node.props.label === '决策 Effort')).toBe(false);
});
it('keeps Jev selection explicit and preserves readonly Provider choices', () => {
  props.services = services.map(service => ({...service, keySet: true}));
  expect(choice().props.value).toBe('');
  expect(changed).not.toHaveBeenCalled();
  choice().props.onChange('typesafe');
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'provider', provider: 'typesafe'});
  expect(choice().props.value).toBe('typesafe');
  changed.mockClear();
  props.disabled = true;
  expect(choice().props.disabled).toBe(true);
  choice().props.onChange(codex.id);
  expect(changed).not.toHaveBeenCalled();
});
it('disables providers that are not ready in the current snapshot or service state', () => {
  const options = choice().props.choices as Array<{value: string; disabled?: boolean}>;
  expect(options.find(item => item.value === codex.id)?.disabled).toBe(false);
  expect(options.find(item => item.value === claude.id)?.disabled).toBe(true);
  expect(options.find(item => item.value === 'typesafe')?.disabled).toBe(true);
  choice().props.onChange(claude.id); choice().props.onChange('typesafe');
  expect(changed).not.toHaveBeenCalled();
  expect(providerDecisionProblem({kind: 'provider', provider: 'typesafe'}, [codex], services)).toContain('密钥');
});
it('preserves a legacy group selection until the owner explicitly chooses a provider', () => {
  props.value = {kind: 'llm', backend: codex.id, model: 'legacy-model', effort: 'high'};
  const ui = render();
  expect(choice(ui).props.value).toBe(codex.id);
  expect(ui.some(node => String(node.props.children).includes('保留旧决策模型设置'))).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  const migrate = ui.find(node => node.props.children === '使用统一配置')!;
  expect(migrate.props.disabled).toBe(false);
  migrate.props.onClick();
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'provider', provider: codex.id});
});
it('does not offer same-provider migration while the legacy provider is unavailable', () => {
  props.value = {kind: 'llm', backend: claude.id, model: 'legacy-model'};
  const ui = render();
  const migrate = ui.find(node => node.props.children === '使用统一配置')!;
  expect(migrate.props.disabled).toBe(true);
  migrate.props.onClick();
  expect(changed).not.toHaveBeenCalled();
});
it('migrates a legacy default inherited from the only ready provider without selecting another', () => {
  props.value = {kind: 'default'};
  props.effective = {kind: 'llm', backend: codex.id, model: 'inherited-model', effort: 'low'};
  const ui = render();
  expect(choice(ui).props.value).toBe(codex.id);
  expect(changed).not.toHaveBeenCalled();
  const migrate = ui.find(node => node.props.children === '使用统一配置')!;
  expect(migrate.props.disabled).toBe(false);
  migrate.props.onClick();
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'provider', provider: codex.id});
});
it('does not offer migration for a decision kind this client cannot interpret', () => {
  props.value = {kind: 'future'};
  props.effective = {kind: 'llm', backend: codex.id, model: 'inherited-model'};
  expect(render().some(node => node.props.children === '使用统一配置')).toBe(false);
});
it('keeps an unavailable saved provider visible and does not silently switch it', () => {
  props.value = {kind: 'provider', provider: claude.id};
  const ui = render();
  expect(choice(ui).props.value).toBe(claude.id);
  expect(providerDecisionProblem(props.value, [codex], services)).toContain('不可用');
  expect(changed).not.toHaveBeenCalled();
});
it.each([
  [codex.id, '修改 Codex 配置'],
  [claude.id, '修改 Claude 配置'],
  ['typesafe', '修改 Jev 配置'],
])('opens the selected shared configuration even when %s is unavailable', (provider, label) => {
  props.value = {kind: 'provider', provider} as JudgeSelectionView;
  const link = render().find(node => node.type === Button && node.props.className === 'gd-decision-config-link')!;
  expect(link.props['aria-label']).toBe(label);
  expect(renderToStaticMarkup(<>{link.props.children}</>)).toContain('修改');
  expect(link.props.disabled).toBe(false);
  link.props.onClick();
  expect(props.onOpenSecrets).toHaveBeenCalledExactlyOnceWith(provider);
  expect(changed).not.toHaveBeenCalled();
});
it('offers general configuration before a Provider is selected and respects disabled state', () => {
  let link = render().find(node => node.props.className === 'gd-decision-config-link')!;
  expect(renderToStaticMarkup(<>{link.props.children}</>)).toContain('管理决策模型');
  link.props.onClick();
  expect(props.onOpenSecrets).toHaveBeenCalledExactlyOnceWith(undefined);
  props.disabled = true;
  link = render().find(node => node.props.className === 'gd-decision-config-link')!;
  expect(link.props.disabled).toBe(true);
});
it.each([
  [true, false, '密钥已添加'],
  [false, false, '尚未添加密钥'],
  [true, true, '密钥状态未知'],
])('shows the actual Jev key state (set=%s, unreadable=%s)', (keySet, keyUnreadable, label) => {
  props.value = {kind: 'provider', provider: 'typesafe'};
  props.services = services.map(service => ({...service, keySet, keyUnreadable}));
  const status = render().find(node => node.props.className === 'gd-decision-key-state')!;
  expect(renderToStaticMarkup(<>{status.props.children}</>)).toContain(label);
  expect(changed).not.toHaveBeenCalled();
});
it('does not treat an unavailable key state as a missing key', () => {
  props.value = {kind: 'provider', provider: 'typesafe'};
  props.services = undefined;
  const status = render().find(node => node.props.className === 'gd-decision-key-state')!;
  expect(renderToStaticMarkup(<>{status.props.children}</>)).toBe('密钥状态未知');
});
it.each([
  [codex.id, {model: 'gpt-6-luna', effort: 'low' as const}, 'low'],
  [codex.id, {model: 'gpt-6-sol'}, '默认'],
  [codex.id, {model: 'gpt-6-sol', effort: 'none' as const}, '关闭思考'],
  [claude.id, {model: 'haiku'}, '关闭思考'],
  ['typesafe', {model: 'jev-latest'}, '不支持单独设置'],
])('shows the configured model and thinking level for %s', (provider, profile, effort) => {
  props.value = {kind: 'provider', provider} as JudgeSelectionView;
  props.services = services.map(service => ({...service, keySet: true}));
  props.configuration = {kind: 'ready', configuration: {byProvider: {[provider]: profile}}};
  const ui = render();
  const values = ui.find(node => node.props.className === 'gd-decision-config-values')!;
  const text = renderToStaticMarkup(<>{values.props.children}</>);
  expect(text).toContain(profile.model);
  if (provider !== 'typesafe') expect(text).toContain(effort);
  else expect(ui.some(node => node.props['aria-label'] === '思考等级')).toBe(false);
  expect(ui.some(node => node.props.className === 'gd-decision-configured')).toBe(true);
});
it('shows the group’s retained model instead of presenting shared configuration as active', () => {
  props.value = {kind: 'llm', backend: codex.id, model: 'legacy-model', effort: 'high'};
  props.configuration = {kind: 'ready', configuration: {byProvider: {[codex.id]: {model: 'shared-model', effort: 'low'}}}};
  const values = render().find(node => node.props.className === 'gd-decision-config-values')!;
  const text = renderToStaticMarkup(<>{values.props.children}</>);
  expect(text).toContain('legacy-model'); expect(text).toContain('high'); expect(text).not.toContain('shared-model');
});
it('does not invent a model or show configured when shared configuration cannot be read', () => {
  props.value = {kind: 'provider', provider: codex.id};
  props.configuration = {kind: 'failed'};
  const ui = render();
  expect(ui.some(node => node.props.className === 'gd-decision-config-values')).toBe(false);
  expect(ui.some(node => node.props.className === 'gd-decision-configured')).toBe(false);
  expect(ui.some(node => node.props.children === '配置读取失败')).toBe(true);
});
