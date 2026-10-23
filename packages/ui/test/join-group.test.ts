import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {agentSchema, collaborationRequestSchema, toolStateSchema} from '@vonvon/protocol';
import {RpcError} from '@vonvon/client/browser';
import {CONVERSATIONS, CREATION_UNKNOWN, JoinGroupDialog, CreationLockNotice, conversationsFor, creationFailure, keptResponse, projectNameProblem, sentResponse, shownResponse, judgeSetupProblem, initialGroupProvider} from '../src/JoinGroupDialog';
import {canSaveAll, DraftGuardProvider} from '../src/settings/DraftGuard';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DirectoryPickerProvider} from '../src/directory-picker';

it('rejects the names the protocol would refuse, before submit', () => {
  for (const name of ['前端/后端', 'a\\b', '换\n行', '制\t表']) {
    expect(projectNameProblem(name)).toBeDefined();
    expect(collaborationRequestSchema.safeParse({action: 'createProject', agentId: 'cli_join', name, folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}).success).toBe(false);
  }
  expect(projectNameProblem('前端/后端')).toContain('/ 或 \\');
  // The dialog sends the trimmed name, like the protocol's own trim.
  for (const name of ['研发群', '（未命名群）', 'A-B_C.d 1', ' 末尾换行\n']) {
    expect(projectNameProblem(name)).toBeUndefined();
    expect(collaborationRequestSchema.safeParse({action: 'createProject', agentId: 'cli_join', name, folder: {kind: 'default'}, tool: 'codex', conversation: 'threads'}).success).toBe(true);
  }
});

it('offers 保存并离开 only when every open draft can be saved', () => {
  const save = async () => true;
  expect(canSaveAll([{save}, {save}])).toBe(true);
  // JoinGroupDialog registers no save: saving would create a real Feishu group.
  expect(canSaveAll([{}])).toBe(false);
  expect(canSaveAll([{save}, {}])).toBe(false);
});

it('s36d1: says a creation may have made a group unless the daemon itself refused it', () => {
  expect(creationFailure(new RpcError('conflict', '项目名「x」已存在'))).toEqual({kind: 'refused', message: '项目名「x」已存在'});
  expect(creationFailure(new RpcError('invalid_folder_token', '目录选择已过期，请重新选择。'))).toEqual({kind: 'refused', message: '目录选择已过期，请重新选择。'});
  for (const failure of [new RpcError('outcome_unknown', 'anything'), new Error('Daemon connection closed'), new Error('Daemon response method or envelope mismatch'), 'thrown']) {
    expect(creationFailure(failure)).toEqual({kind: 'unknown', message: CREATION_UNKNOWN});
  }
  expect(renderToStaticMarkup(createElement(CreationLockNotice, {failure: creationFailure(new Error('Daemon connection closed'))}))).toContain(`${CREATION_UNKNOWN}要重试，关掉这个窗口再建。`);
});

it('s36d1: locks the form on a group created and not saved, with the daemon\'s binding guide and no retry advice', () => {
  const guide = '群「x」已建好，但没存上：project disk failure。请在网页「加入现有飞书群」→「查找已经加入的群」里选它绑定，不要再建。绑回来是只读，要完全访问就到群设置里改';
  // Anything but a refusal locks the form (JoinGroupDialog's catch), so a second click cannot make a second group.
  const unsaved = creationFailure(new RpcError('created_unsaved', guide));
  expect(unsaved).toEqual({kind: 'unsaved', message: guide});
  const notice = renderToStaticMarkup(createElement(CreationLockNotice, {failure: unsaved}));
  expect(notice).toContain(guide);
  expect(notice).toContain('群已建好，但没存上');
  expect(notice).not.toContain('重试');
});

it('s25c: lists the three 会话方式 in 3.4\'s order and words, and 智能 has no 免@ to show or send', () => {
  expect(CONVERSATIONS).toEqual([
    {value: 'threads', label: '@ 我开新会话', description: '在主区 @ 我就开一个话题，一个话题一条会话，几件事各聊各的'},
    {value: 'shared', label: '整群一条会话', description: '主区一条会话，上下文一直连着；想另起一件事，开个话题和我聊'},
    {value: 'smart', label: '智能开话题', description: '主区一条会话，不用 @ 我也会看情况接话；聊到新的事，我自己开话题、起新会话'},
  ]);
  expect(shownResponse(undefined, undefined)).toBeUndefined();
  expect(shownResponse('threads', undefined)).toBe('all');
  expect(shownResponse('shared', undefined)).toBe('mention');
  // A hand pick made under another 会话方式 is not carried into 智能.
  expect(shownResponse('smart', 'all')).toBeUndefined();
  // Nor out of it: picked 关 under 多会话, then 智能, then 多会话 again shows 多会话's default (审查低).
  expect(shownResponse('threads', keptResponse('threads', keptResponse('smart', 'mention')))).toBe('all');
  expect(keptResponse('shared', 'all')).toBe('all');
  for (const kind of ['create', 'bind'] as const) expect(sentResponse(kind, 'smart', shownResponse('smart', 'all'))).toEqual({});
  expect(sentResponse('bind', 'shared', 'mention')).toEqual({});
  expect(sentResponse('create', 'shared', 'mention')).toEqual({response: 'mention'});
  expect(sentResponse('create', 'threads', 'all')).toEqual({});
  expect(collaborationRequestSchema.safeParse({action: 'createProject', agentId: 'cli_join', name: 'n', folder: {kind: 'default'}, tool: 'codex', conversation: 'smart'}).success).toBe(true);
});

it('s36b2: offers topic conversations and keeps threads 免 @ on by default', () => {
  expect(conversationsFor(true)).toEqual([
    {value: 'threads', label: '按话题聊', description: '一个话题一条会话，几件事各聊各的'},
    {value: 'smart', label: '智能开话题', description: '一个话题一条会话，不用 @ 我也会看情况接话'},
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
  expect(topic).toContain('按话题聊');
  expect(topic).not.toContain('整群一条会话');
  expect(topic).toContain('只读（不联网）');
  expect(topic).not.toContain('网络关闭');
  expect(topic).not.toContain('连接后，在群设置中改为完全访问才能使用。');
  const create = render(false);
  expect(create.match(/role="radio"/g)).toHaveLength(3);
  expect(create).not.toContain('只读（不联网）');
  expect(render(true, false).match(/role="radio"/g)).toHaveLength(3);
});

it('requires an explicit ready judgment Provider for smart setup', () => {
  expect(judgeSetupProblem({kind: 'default'})).toContain('请选择');
  expect(judgeSetupProblem({kind: 'provider', provider: 'codex-appserver'}, undefined, ['codex-appserver'])).toBeUndefined();
  expect(judgeSetupProblem({kind: 'provider', provider: 'claude-agent'}, undefined, ['codex-appserver'])).toContain('不可用');
  const services = [{provider: 'typesafe', displayName: 'TypeSafe', keyId: 'key', models: [{id: 'jev', displayName: 'Jev'}], keySet: false}];
  expect(judgeSetupProblem({kind: 'provider', provider: 'typesafe'}, services)).toContain('密钥');
  expect(judgeSetupProblem({kind: 'provider', provider: 'typesafe'}, [{...services[0]!, keySet: true}])).toBeUndefined();
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
