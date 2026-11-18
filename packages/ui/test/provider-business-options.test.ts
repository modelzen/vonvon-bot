import {Children, createElement, isValidElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {agentIdSchema, type ProjectSettingsView} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DecisionFields, GroupSettingsContent, ModelAccessFields, modelAccessProblem} from '../src/settings/GroupDesignSettings';
import {Editor} from '../src/settings/SettingsPanel';
import {SelectControl} from '../src/reference/components/ui';
import {permissionValue} from './permission-fixture';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const botId = agentIdSchema.parse('cli_provider_options');
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ClientProvider, {client, children: child}));
const providerProps = {botId, value: {backend: 'codex-appserver', models: ['alpha'], efforts: ['low' as const]}, onChange: () => {}, disabled: false, providers: [{id: 'codex-appserver', displayName: 'Codex'}]};
function nodes(node: ReactNode): Array<ReturnType<typeof createElement>> {
  return Children.toArray(node).flatMap(child => isValidElement<{children?: ReactNode}>(child) ? [child, ...nodes(child.props.children)] : []);
}
const selector = (props = providerProps) => nodes(ModelAccessFields(props)).find(node => node.type === SelectControl)!;

it('keeps a single available Provider in the original segmented control with its icon', () => {
  const html = render(createElement(ModelAccessFields, providerProps));
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('src="./agent-icons/terminal.png"');
  expect(html).toContain('type="radio"');
  expect(html).toContain('>Codex</span>');
  expect(selector().props.options).toEqual([{value: 'codex-appserver', label: 'Codex', disabled: false}]);
});

it('offers available Providers and clears dependent choices only for a valid different Provider', () => {
  const changed = vi.fn();
  const control = selector({...providerProps, onChange: changed, providers: [...providerProps.providers, {id: 'claude-agent', displayName: 'Claude'}]});
  expect(control.props.options.map((item: {value: string}) => item.value)).toEqual(['codex-appserver', 'claude-agent']);
  const html = render(createElement(ModelAccessFields, {...providerProps, providers: [...providerProps.providers, {id: 'claude-agent', displayName: 'Claude'}]}));
  expect(html).toContain('role="radiogroup"');
  expect(html).toContain('src="./agent-icons/terminal.png"');
  expect(html).toContain('src="./agent-icons/code.png"');
  control.props.onChange('codex-appserver'); control.props.onChange('unknown-provider');
  expect(changed).not.toHaveBeenCalled();
  control.props.onChange('claude-agent');
  expect(changed).toHaveBeenCalledExactlyOnceWith({backend: 'claude-agent', models: [], efforts: [], modelEfforts: {}, modelServiceTiers: {}, defaultModel: undefined, defaultEffort: undefined});
});

it('disables readonly Provider changes without clearing saved model choices', () => {
  const changed = vi.fn(); const props = {...providerProps, disabled: true, onChange: changed, providers: [...providerProps.providers, {id: 'claude-agent', displayName: 'Claude'}]};
  const control = selector(props);
  expect(control.props.disabled).toBe(true);
  control.props.onChange('claude-agent'); expect(changed).not.toHaveBeenCalled();
  const html = render(createElement(ModelAccessFields, props));
  const radios = html.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
  expect(radios).toHaveLength(2);
  expect(radios.every(radio => radio.includes('disabled=""'))).toBe(true);
  expect(html).toContain('1 个模型');
  expect(props.value.models).toEqual(['alpha']);
});

it('keeps saved unavailable Provider and model choices readable without offering unavailable Provider edits', () => {
  const html = render(createElement(ModelAccessFields, {botId, value: {backend: 'claude-agent', models: ['haiku'], efforts: []}, onChange: () => {}, disabled: false, providers: []}));
  expect(html).toContain('Claude'); expect(html).toContain('当前不可用');
  expect(html).toContain('role="combobox"');
  const control = selector({...providerProps, value: {backend: 'claude-agent', models: ['haiku'], efforts: []}, providers: []});
  expect(control.props.options).toEqual([{value: 'claude-agent', label: 'Claude（当前不可用）', disabled: true}]);
  expect(html).toContain('1 个模型'); expect(html).toContain('aria-label="配置可用模型"');
  expect(html).toContain('选择仍保留');
});

it('explains the retained tier and cleared custom settings when changing Provider', () => {
  const props = {botId, value: {backend: 'claude-agent', models: [], efforts: []}, onChange: () => {}, disabled: false,
    providers: [{id: 'codex-appserver', displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}],
    savedBackend: 'codex-appserver', permissionName: '工作区可写'};
  const html = render(createElement(ModelAccessFields, props));
  expect(html).toContain('权限仍是「工作区可写」；自定义设置会清掉。');
  expect(html).not.toContain('能改工作区里的文件，能联网。');
  expect(render(createElement(ModelAccessFields, {...props, value: {...props.value, backend: props.savedBackend}}))).not.toContain('自定义设置会清掉');
});

it('uses the invalid custom view’s qa tier in the provider-change hint', () => {
  const permission = permissionValue('qa'); permission.options.invalid = true;
  const section = <T,>(stored: T) => ({stored, effective: stored, revision: 'r', access: {kind: 'writable' as const}, apply: []});
  const view: ProjectSettingsView = {scope: {kind: 'project', botId, projectName: 'demo'}, identity: {chatId: 'oc_demo', backend: 'codex-appserver', cwd: '/tmp/demo', kind: 'single'},
    sections: {permission: section(permission), response: section({noMention: false}), model: section({selection: {kind: 'default'}}), modelAccess: section({backend: 'codex-appserver', models: [], efforts: []})}, members: {openIds: [], revision: 'r'}};
  function ChangedProvider() {
    const content = GroupSettingsContent({view, tab: 'model', refresh: async () => {}});
    function findEditor(node: ReactNode): any {
      for (const child of Children.toArray(node)) if (isValidElement<{children?: ReactNode}>(child)) {
        if (child.type === Editor) return child;
        const nested = findEditor(child.props.children); if (nested) return nested;
      }
    }
    return findEditor(content).props.render({...view.sections.modelAccess!.stored, backend: 'claude-agent'}, () => {}, false);
  }
  const html = render(createElement(ChangedProvider));
  expect(html).toContain('权限仍是「只读」；自定义设置会清掉。');
  expect(html).not.toContain('恢复原来保存的权限档');
  expect(html).not.toContain('可能比当前的只读更宽');
});

it('retains an unavailable decision model in the shared picker without provider radio controls', () => {
  const html = render(createElement(DecisionFields, {botId, groupBackend: 'codex-appserver', value: {kind: 'llm', backend: 'claude-agent', model: 'haiku'}, effective: {kind: 'default'}, onChange: () => {}, disabled: false, providers: [], onOpenProviders: () => {}, services: [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', models: [{id: 'jev', displayName: 'Jev'}], keySet: false}]}));
  expect(html).toContain('Claude');
  expect(html).toContain('haiku');
  expect(html).toContain('aria-label="选择决策模型"');
  expect(html).not.toContain('type="radio"');
  const effort = html.match(/<button[^>]*aria-label="决策 Effort"[^>]*>/)?.[0];
  expect(effort).toContain('disabled');
});
it('does not validate model access against an offline fallback catalog', () => {
  const catalog = {backend: 'codex-appserver', state: 'fallback' as const, source: 'static-fallback' as const, observedAt: 0, titleEfforts: ['low' as const], models: [{id: 'gpt-6-luna', displayName: 'Luna', description: '', isDefault: true, hidden: false, supportedEfforts: ['low' as const], defaultEffort: 'low' as const}]};
  expect(modelAccessProblem({backend: 'codex-appserver', models: ['gpt-6-luna'], efforts: ['low']}, catalog)).toContain('实时模型目录暂不可用');
});
