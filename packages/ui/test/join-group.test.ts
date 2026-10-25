import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {agentSchema, toolStateSchema} from '@vonvon/protocol';
import {CONVERSATIONS, JoinGroupDialog, conversationsFor, keptResponse, projectNameProblem, sentResponse, shownResponse, judgeSetupProblem, initialGroupProvider} from '../src/JoinGroupDialog';
import {canSaveAll, DraftGuardProvider} from '../src/settings/DraftGuard';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DirectoryPickerProvider} from '../src/directory-picker';

it('rejects the names the protocol would refuse, before submit', () => {
  for (const name of ['前端/后端', 'a\\b', '换\n行', '制\t表']) {
    expect(projectNameProblem(name)).toBeDefined();
  }
  expect(projectNameProblem('前端/后端')).toContain('/ 或 \\');
  // The dialog trims the local binding name before sending it.
  for (const name of ['研发群', '（未命名群）', 'A-B_C.d 1', ' 末尾换行\n']) {
    expect(projectNameProblem(name)).toBeUndefined();
  }
});

it('offers 保存并离开 only when every open draft can be saved', () => {
  const save = async () => true;
  expect(canSaveAll([{save}, {save}])).toBe(true);
  // JoinGroupDialog requires the user to choose and bind a group explicitly.
  expect(canSaveAll([{}])).toBe(false);
  expect(canSaveAll([{save}, {}])).toBe(false);
});

it('uses the same communication vocabulary as Bot settings, and 智能 has no 免@ to show or send', () => {
  expect(CONVERSATIONS).toEqual([
    {value: 'threads', label: '独立话题', description: '主区 @ Bot 开启新话题，每个话题独立交谈、各自记住上下文。'},
    {value: 'shared', label: '连续交谈', description: '全群接着聊，共用一段对话和上下文。'},
    {value: 'smart', label: '智能', description: '根据判断规则，自己决定何时接话、何时另开话题。'},
  ]);
  expect(shownResponse(undefined, undefined)).toBeUndefined();
  expect(shownResponse('threads', undefined)).toBe('all');
  expect(shownResponse('shared', undefined)).toBe('mention');
  // A hand pick made under another 会话方式 is not carried into 智能.
  expect(shownResponse('smart', 'all')).toBeUndefined();
  // Nor out of it: picked 关 under 多会话, then 智能, then 多会话 again shows 多会话's default (审查低).
  expect(shownResponse('threads', keptResponse('threads', keptResponse('smart', 'mention')))).toBe('all');
  expect(keptResponse('shared', 'all')).toBe('all');
  expect(sentResponse('smart', shownResponse('smart', 'all'))).toEqual({});
  expect(sentResponse('shared', 'mention')).toEqual({});
  expect(sentResponse('shared', 'all')).toEqual({response: 'all'});
  expect(sentResponse('threads', 'all')).toEqual({});
});

it('s36b2: offers topic conversations and keeps threads 免 @ on by default', () => {
  expect(conversationsFor(true)).toEqual([
    {value: 'threads', label: '独立话题', description: '主区 @ Bot 开启新话题，每个话题独立交谈、各自记住上下文。'},
    {value: 'smart', label: '智能', description: '根据判断规则，自己决定何时接话、何时另开话题。'},
  ]);
  expect(conversationsFor(false)).toEqual(CONVERSATIONS);
  expect(shownResponse('threads', undefined)).toBe('all');
});

it('s36b2: shows topic binding choices and read-only permissions when binding', () => {
  const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
  const agent = agentSchema.parse({id: 'cli_join', name: 'Test Bot', enabled: true, running: true, connection: 'connected', activation: 'active'});
  const render = (bind: boolean, topic = true) => renderToStaticMarkup(
    createElement(ClientProvider, {client, children: createElement(DirectoryPickerProvider, {children:
      createElement(DraftGuardProvider, {children: createElement(JoinGroupDialog, {
        agent, tools: [{tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '1'}], ...(bind ? {initialGroup: {chatId: 'oc_topic', name: 'Topic', addedAt: 0, topic}} : {}),
        onClose: () => {}, onChanged: async () => {},
      })}),
    })}),
  );
  const topic = render(true, true);
  expect(topic.match(/role="radio"/g)).toHaveLength(2);
  expect(topic).toContain('独立话题');
  expect(topic).toContain('沟通方式');
  expect(topic).not.toContain('会话方式');
  expect(topic).not.toContain('连续交谈');
  expect(topic).toContain('只读（不联网）');
  expect(topic).not.toContain('网络关闭');
  expect(topic).not.toContain('连接后，在群设置中改为完全访问才能使用。');
  const existing = render(false);
  expect(existing).toContain('在飞书群的');
  expect(existing).toContain('查找已经加入的群');
  expect(existing).not.toContain('创建群聊');
  expect(existing).not.toContain('创建并连接');
  expect(existing).not.toContain('沟通方式');
  expect(render(true, false).match(/role="radio"/g)).toHaveLength(3);
});

it('accepts the host default only after configuration and its provider are ready', () => {
  const defaultSelection = {kind: 'default'} as const;
  const codexConfiguration = {kind: 'ready', configuration: {defaultProvider: 'codex-appserver', byProvider: {'codex-appserver': {model: 'gpt-6-luna'}}}} as const;
  expect(judgeSetupProblem(defaultSelection)).toBeDefined();
  expect(judgeSetupProblem(defaultSelection, undefined, ['codex-appserver'], {kind: 'failed'})).toBeDefined();
  expect(judgeSetupProblem(defaultSelection, undefined, ['codex-appserver'], {kind: 'ready', configuration: {byProvider: {}}})).toBeDefined();
  expect(judgeSetupProblem(defaultSelection, undefined, ['codex-appserver'], codexConfiguration)).toBeUndefined();
  expect(judgeSetupProblem(defaultSelection, undefined, ['claude-agent'], codexConfiguration)).toContain('不可用');
  const services = [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'key', models: [{id: 'jev', displayName: 'Jev'}], keySet: false}];
  const jevConfiguration = {kind: 'ready', configuration: {defaultProvider: 'typesafe', byProvider: {typesafe: {model: 'jev'}}}} as const;
  expect(judgeSetupProblem(defaultSelection, services, [], jevConfiguration)).toContain('密钥');
  expect(judgeSetupProblem(defaultSelection, [{...services[0]!, keySet: true}], [], jevConfiguration)).toBeUndefined();
});

it('starts with a ready Provider and rejects an unavailable setup suggestion', () => {
  const states = [
    toolStateSchema.parse({tool: 'codex', installation: 'missing', authentication: 'signedOut', version: null}),
    toolStateSchema.parse({tool: 'claude', installation: 'installed', authentication: 'signedIn', version: '1'}),
  ];
  expect(initialGroupProvider(undefined, states)).toBe('claude');
  expect(initialGroupProvider('codex', states)).toBe('claude');
  expect(initialGroupProvider(undefined, states.map(item => item.tool === 'codex' ? {...item, installation: 'installed', authentication: 'signedIn'} : item))).toBe('codex');
  expect(initialGroupProvider(undefined, states.map(item => ({...item, authentication: 'unknown'})))).toBeUndefined();
  expect(initialGroupProvider(undefined, states.map(item => ({...item, compatibility: {status: 'tooOld', minimumVersion: '2'}})))).toBeUndefined();
});
