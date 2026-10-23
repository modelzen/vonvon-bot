import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {agentIdSchema} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DecisionFields, ModelAccessFields, modelAccessProblem} from '../src/settings/GroupDesignSettings';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const botId = agentIdSchema.parse('cli_provider_options');
const render = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ClientProvider, {client, children: child}));

it('keeps a saved unavailable model Provider visible but disabled', () => {
  const html = render(createElement(ModelAccessFields, {botId, value: {backend: 'claude-agent', models: ['haiku'], efforts: []}, onChange: () => {}, disabled: false, providers: []}));
  expect(html).toContain('Claude（当前不可用）');
  expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="claude-agent"/);
  expect(html).toContain('配置已保留');
});

it('explains the retained tier and cleared advanced settings when changing Provider', () => {
  const props = {botId, value: {backend: 'claude-agent', models: [], efforts: []}, onChange: () => {}, disabled: false,
    providers: [{id: 'codex-appserver', displayName: 'Codex'}, {id: 'claude-agent', displayName: 'Claude'}],
    savedBackend: 'codex-appserver', permission: {name: '工作区可写', summary: '能改工作区里的文件，能联网。'}};
  const html = render(createElement(ModelAccessFields, props));
  expect(html).toContain('换 provider 以后，权限还是「工作区可写」（能改工作区里的文件，能联网。）；高级设置会清掉。');
  expect(render(createElement(ModelAccessFields, {...props, value: {...props.value, backend: props.savedBackend}}))).not.toContain('高级设置会清掉');
  const invalid = render(createElement(ModelAccessFields, {...props, permissionInvalid: true, permission: {name: '只读', summary: '不联网。'}}));
  expect(invalid).toContain('恢复原来保存的权限档，可能比当前的只读更宽。建议先在工作区重新选一档。');
  expect(invalid).not.toContain('权限还是「只读」');
});

it('keeps unavailable decision Providers visible and open for setup guidance', () => {
  const html = render(createElement(DecisionFields, {botId, groupBackend: 'codex-appserver', value: {kind: 'llm', backend: 'claude-agent', model: 'haiku'}, effective: {kind: 'default'}, onChange: () => {}, disabled: false, providers: [], services: [{provider: 'actual', displayName: 'Actual', keyId: 'actual-key', models: [{id: 'jev', displayName: 'Jev'}], keySet: false}]}));
  expect(html).toContain('Claude 尚未就绪');
  expect(html).toContain('检查登录');
  for (const provider of ['codex-appserver', 'claude-agent', 'decision:actual']) {
    const input = html.match(new RegExp(`<input[^>]*value="${provider}"[^>]*>`))?.[0];
    expect(input).toBeDefined();
    expect(input).not.toContain('disabled');
  }
});
it('does not validate model access against an offline fallback catalog', () => {
  const catalog = {backend: 'codex-appserver', state: 'fallback' as const, source: 'static-fallback' as const, observedAt: 0, titleEfforts: ['low' as const], models: [{id: 'gpt-6-luna', displayName: 'Luna', description: '', isDefault: true, hidden: false, supportedEfforts: ['low' as const], defaultEffort: 'low' as const}]};
  expect(modelAccessProblem({backend: 'codex-appserver', models: ['gpt-6-luna'], efforts: ['low']}, catalog)).toContain('实时模型目录暂不可用');
});
