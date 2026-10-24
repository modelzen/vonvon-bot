import {Children, createElement, isValidElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {agentIdSchema, type ProjectSettingsView} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DecisionFields, GroupSettingsContent, ModelAccessFields, modelAccessProblem} from '../src/settings/GroupDesignSettings';
import {Editor} from '../src/settings/SettingsPanel';
import {permissionValue} from './permission-fixture';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const botId = agentIdSchema.parse('cli_provider_options');
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ClientProvider, {client, children: child}));

it('keeps saved unavailable Provider and model choices readable without offering unavailable Provider edits', () => {
  const html = render(createElement(ModelAccessFields, {botId, value: {backend: 'claude-agent', models: ['haiku'], efforts: []}, onChange: () => {}, disabled: false, providers: []}));
  expect(html).toContain('Claude'); expect(html).toContain('当前不可用');
  expect(html).not.toContain('role="radiogroup" aria-label="模型 Provider"');
  expect(html).toContain('haiku'); expect(html).toContain('查看模型');
  expect(html).toContain('选择仍保留');
});

it('explains the retained tier and cleared advanced settings when changing Provider', () => {
  const props = {botId, value: {backend: 'claude-agent', models: [], efforts: []}, onChange: () => {}, disabled: false,
    providers: [{id: 'codex-appserver', displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}],
    savedBackend: 'codex-appserver', permissionName: '工作区可写'};
  const html = render(createElement(ModelAccessFields, props));
  expect(html).toContain('权限仍是「工作区可写」；高级设置会清掉。');
  expect(html).not.toContain('能改工作区里的文件，能联网。');
  expect(render(createElement(ModelAccessFields, {...props, value: {...props.value, backend: props.savedBackend}}))).not.toContain('高级设置会清掉');
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
  expect(html).toContain('权限仍是「只读」；高级设置会清掉。');
  expect(html).not.toContain('恢复原来保存的权限档');
  expect(html).not.toContain('可能比当前的只读更宽');
});

it('keeps unavailable decision Providers visible and disabled while exposing their setup guidance', () => {
  const html = render(createElement(DecisionFields, {botId, groupBackend: 'codex-appserver', value: {kind: 'llm', backend: 'claude-agent', model: 'haiku'}, effective: {kind: 'default'}, onChange: () => {}, disabled: false, providers: [], onOpenProviders: () => {}, services: [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'typesafe-api-key', models: [{id: 'jev', displayName: 'Jev'}], keySet: false}]}));
  expect(html).toContain('Claude 尚未就绪');
  expect(html).toContain('设置 Provider');
  for (const provider of ['codex-appserver', 'claude-agent', 'typesafe']) {
    const input = html.match(new RegExp(`<input[^>]*value="${provider}"[^>]*>`))?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('disabled');
  }
});
it('does not validate model access against an offline fallback catalog', () => {
  const catalog = {backend: 'codex-appserver', state: 'fallback' as const, source: 'static-fallback' as const, observedAt: 0, titleEfforts: ['low' as const], models: [{id: 'gpt-6-luna', displayName: 'Luna', description: '', isDefault: true, hidden: false, supportedEfforts: ['low' as const], defaultEffort: 'low' as const}]};
  expect(modelAccessProblem({backend: 'codex-appserver', models: ['gpt-6-luna'], efforts: ['low']}, catalog)).toContain('实时模型目录暂不可用');
});
