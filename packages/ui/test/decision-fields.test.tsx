import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DecisionModelsView, type JudgeSelectionView} from '@vonvon/protocol';
import {DecisionFields, providerDecisionProblem} from '../src/settings/DecisionFields';
import {SettingChoices} from '../src/settings/SettingChoices';

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
  choice().props.onChange(codex.id);
  expect(changed).toHaveBeenCalledExactlyOnceWith({kind: 'provider', provider: codex.id});
  expect(choice().props.value).toBe(codex.id);
  expect(render().some(node => node.props.label === '决策模型' || node.props.label === '决策 Effort')).toBe(false);
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
