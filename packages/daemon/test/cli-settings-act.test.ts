import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import { defaultCardDisplay, type SettingsRequest } from '@vonvon/protocol';
import { commandFailure } from '../src/cli/command-error';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { adminIpcTimeout, type AdminIpcOp } from '../src/admin/ipc';
import { runProviderModels } from '../src/cli/commands/provider';
import {
  runSettingsAdmin, runSettingsCommentInstructions, runSettingsGet, runSettingsMember, runSettingsModels, runSettingsSet, runSettingsVoice, type Stdin,
} from '../src/cli/commands/settings';

/** cli-6-settings: `settings act` (the settings page's buttons) and `settings models`, through the real withDaemon and a fake client. */
const section = (stored: object) => ({ stored, effective: stored, revision: `rev-${Object.keys(stored)[0]}`, access: { kind: 'writable' }, apply: [] });
const voice = { enabled: true, feishu: { state: 'granted', message: '已开通' }, result: '', grantUrl: '' };
const agentView = (over: object = {}) => ({
  scope: { kind: 'agent', botId: 'cli_a' }, sections: {}, ownerOpenId: 'ou_owner',
  administrators: { openIds: ['ou_owner', 'ou_local'], revision: 'a1' },
  voice, commentInstructions: { content: { kind: 'default', text: '默认的评论指令' }, revision: 'c1', maxEditLength: 30000 },
  ...over,
});
const projectView = (openIds: string[] = ['ou_b'], over: object = {}) => ({
  scope: { kind: 'project', botId: 'cli_a', projectName: '研发' }, sections: {},
  identity: { chatId: 'oc_dev', backend: 'codex-appserver', cwd: '/home/u/dev', kind: 'multi' },
  members: { openIds, revision: 'm1', roster: { state: 'complete', entries: [{ openId: 'ou_b', name: '小北', kind: 'person' }], otherBots: false } },
  ...over,
});
const savedWith = (view: object, warnings: string[] = []) => ({ kind: 'acted', result: { kind: 'saved', view, effects: [{ fields: [], when: 'immediate', detail: '设置已保存' }], warnings } });

function harness(settings: (request: SettingsRequest) => unknown) {
  let out = '';
  const snapshot = vi.fn(async () => ({
    agents: [{ id: 'cli_a', name: 'Test' }],
    memberships: [{ agentId: 'cli_a', groupId: 'oc_dev', name: '研发', conversation: 'threads', backend: 'codex-appserver', directory: '/home/u/dev' }],
  }));
  const send = vi.fn(async (request: SettingsRequest) => settings(request));
  const connect = vi.fn(async () => ({ snapshot, settings: send, close: async () => {} }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  const failure = async (run: Promise<void>) => commandFailure(await run.then(() => undefined, (error: unknown) => error));
  const acts = () => send.mock.calls.map(([request]) => request).filter(request => request.type === 'act');
  return { send, acts, connect, daemon, failure, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, json: () => JSON.parse(out), clear: () => { out = ''; } };
}
const pipe = (text: string): Stdin => ({ isTTY: false, read: async () => text });

it('validates reminder format before connecting and saves format and timing in one project revision', async () => {
  const presentation = section({cardDisplay:null,completionMode:'failures',longTaskMinutes:3,completionTemplate:null});
  const h = harness(request => request.type === 'read' ? {kind:'view',view:projectView([],{sections:{presentation}})}
    : {kind:'saved',result:{kind:'saved',section:{},effects:[]}});
  expect(await h.failure(runSettingsSet(['presentation.completionTemplate={{unknown}}','presentation.longTaskMinutes=10'],{group:'研发'},h.io(),h.daemon))).toMatchObject({exitCode:2,error:{message:expect.stringContaining('未知提醒变量')}});
  expect(h.connect).not.toHaveBeenCalled();
  await runSettingsSet(['presentation.completionMode=long','presentation.longTaskMinutes=10','presentation.completionTemplate="{{task}} {{status}}\\n用时 {{elapsed}}"'],{group:'研发'},h.io(),h.daemon);
  expect(h.send).toHaveBeenLastCalledWith({type:'save',edit:{scope:{kind:'project',botId:'cli_a',projectName:'研发'},section:'presentation',revision:presentation.revision,patch:{completionMode:'long',longTaskMinutes:10,completionTemplate:'{{task}} {{status}}\n用时 {{elapsed}}'}}});
  expect(h.send.mock.calls.filter(([request]) => request.type === 'save')).toHaveLength(1);
});

it('requires the read-time revision for full card snapshots before connecting, for groups and private chats', async () => {
  const h=harness(()=>{throw new Error('must not connect');});
  const assignment=`presentation.cardDisplay=${JSON.stringify(defaultCardDisplay())}`;
  for(const target of [{group:'研发'},{dm:true}])for(const revision of [undefined,'','   ']){
    expect(await h.failure(runSettingsSet([assignment],{...target,revision},h.io(),h.daemon))).toMatchObject({
      exitCode:2,error:{message:expect.stringContaining('view.sections.presentation.revision')},
    });
  }
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
});

it('preserves an explicit snapshot revision despite a newer read and returns conflict without retrying', async () => {
  const cardA=defaultCardDisplay();
  cardA.blocks.find(block=>block.kind==='context')!.slot='bottom-left';
  const cardB=defaultCardDisplay();
  cardB.blocks.find(block=>block.kind==='tools')!.mode='off';
  const presentationB={...section({cardDisplay:cardB}),revision:'revision-B'};
  const scope={kind:'project',botId:'cli_a',projectName:'研发'};
  const current={scope,section:'presentation',value:presentationB};
  const h=harness(request=>request.type==='read'
    ? {kind:'view',view:projectView([],{sections:{presentation:presentationB}})}
    : {kind:'saved',result:{kind:'conflict',current}});
  expect(await h.failure(runSettingsSet([`presentation.cardDisplay=${JSON.stringify(cardA)}`],{group:'研发',revision:'revision-A'},h.io(true),h.daemon))).toMatchObject({
    exitCode:5,error:{kind:'conflict',current},
  });
  expect(h.send.mock.calls.map(([request])=>request)).toEqual([
    {type:'read',scope},
    {type:'save',edit:{scope,section:'presentation',revision:'revision-A',patch:{cardDisplay:cardA}}},
  ]);
  expect(presentationB.effective).toEqual({cardDisplay:cardB});
});

it('still permits an explicit reset to default without a held revision', async () => {
  const presentation={...section({cardDisplay:defaultCardDisplay()}),revision:'revision-current'};
  const h=harness(request=>request.type==='read'
    ? {kind:'view',view:projectView([],{sections:{presentation}})}
    : {kind:'saved',result:{kind:'saved',section:{},effects:[]}});
  await runSettingsSet(['presentation.cardDisplay=null'],{group:'研发'},h.io(),h.daemon);
  expect(h.send).toHaveBeenLastCalledWith({type:'save',edit:{scope:{kind:'project',botId:'cli_a',projectName:'研发'},section:'presentation',revision:'revision-current',patch:{cardDisplay:null}}});
});

// dm-agent 10 (D4). main 必败: settings had no --dm
describe('settings --dm', () => {
  const dm = { kind: 'project', botId: 'cli_a', projectName: 'oc_dm_cli_a' };
  const fixed = (stored: object) => ({ ...section(stored), access: { kind: 'readonly', reason: 'dm-fixed', message: '私聊只有完全访问一档' } });
  const view = {
    scope: dm, identity: { chatId: 'oc_dm_cli_a', backend: 'claude-agent', cwd: '/data/projects/dm', kind: 'single' }, members: { openIds: [], revision: 'm1' }, skills: [],
    sections: {
      model: section({ selection: { kind: 'default' } }), speed: section({ tier: 'inherit' }), modelAccess: section({ backend: 'claude-agent', models: ['m'], efforts: ['low'] }), skills: section({ disabledPaths: [] }),
      permission: fixed({ mode: 'full', options: { tiers: [], fields: [{ key: 'sandbox', label: '沙盒', kind: 'switch' }] } }), workspace: fixed({ primary: '/data/projects/dm', directories: [], repositories: [] }),
      response: fixed({ noMention: true }), conversation: section({ mode: 'smart' }), smartRules: section({ respond: '', newTopic: '' }), judge: section({ selection: { kind: 'default' } }),
    },
  };
  const reads = (request: SettingsRequest) => request.type === 'read' ? { kind: 'view', view } : { kind: 'saved', result: { kind: 'saved', section: {}, effects: [], warnings: [] } };

  it('reads the private chat by oc_dm_<appId>, and shows only what it has', async () => {
    const h = harness(reads);
    await runSettingsGet(undefined, { dm: true }, h.io(), h.daemon);
    expect(h.send).toHaveBeenCalledWith({ type: 'read', scope: dm });
    expect(h.send.mock.calls.some(([request]) => request.type === 'sessions')).toBe(false);
    const lines = h.out().split('\n');
    expect(lines[0]).toBe('Bot Test（cli_a）的私聊 · Claude · /data/projects/dm');
    for (const name of ['[model]', '[speed]', '[modelAccess]', '[skills]', '[permission]（只读：私聊只有完全访问一档）', '[workspace]（只读：私聊只有完全访问一档）']) expect(lines).toContain(name);
    expect(h.out()).not.toContain('[response]');
    for (const name of ['[conversation]', '[smartRules]', '[judge]']) expect(lines).toContain(name);
    expect(h.out()).not.toContain('高级设置');
    expect(h.out()).not.toContain('响应成员');
    expect(await h.failure(runSettingsGet('response', { dm: true }, h.io(), h.daemon))).toMatchObject({ exitCode: 2 });
  });

  it('saves through the same save, and takes no --group or --session', async () => {
    const h = harness(reads);
    await runSettingsSet(['model.selection={"kind":"default"}'], { dm: true }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'save', edit: expect.objectContaining({ scope: dm, section: 'model' }) });
    await runSettingsSet(['conversation.mode=single'], { dm: true }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'save', edit: expect.objectContaining({ scope: dm, section: 'conversation', patch: { mode: 'single' } }) });
    for (const target of [{ dm: true, group: '研发' }, { dm: true, session: 'th_1' }, { dm: true, host: true }]) expect(await h.failure(runSettingsGet(undefined, target, h.io(), h.daemon))).toMatchObject({ exitCode: 2 });
  });

  it('lists the models of its own Provider, for the project picker', async () => {
    const h = harness(() => ({ kind: 'models', catalog: { backend: 'claude-agent', state: 'ready', models: [] } }));
    const dmAgent = { dm: true };
    expect(await h.failure(runSettingsModels(dmAgent, h.io(), h.daemon))).toMatchObject({ exitCode: 2, error: { message: '这个 Bot 还没有私聊：启动过一次才有。也可以用 --backend 指定。' } });
    await runSettingsModels({ ...dmAgent, backend: 'claude' }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'models', query: { botId: 'cli_a', backend: 'claude-agent', purpose: 'project' } });
    expect(await h.failure(runSettingsModels({ ...dmAgent, purpose: 'judge' }, h.io(), h.daemon))).toMatchObject({ exitCode: 2 });
  });
});

describe('settings act voice', () => {
  // main 必败: settings act did not exist
  it('refresh sends refreshPermission and prints the permission, the result and where to grant it', async () => {
    const after = agentView({ voice: { ...voice, enabled: false, feishu: { state: 'missing', message: '还没开语音识别权限' }, result: '检测完成', grantUrl: 'https://open.feishu.cn/app/x/auth' } });
    const h = harness(request => request.type === 'act' ? savedWith(after) : { kind: 'view', view: agentView() });
    await runSettingsVoice('refresh', {}, h.io(), h.daemon);
    expect(h.acts()).toEqual([{ type: 'act', action: { kind: 'voice', botId: 'cli_a', action: { action: 'refreshPermission' } } }]);
    expect(h.out()).toBe('语音转文字：关\n飞书语音权限：还没开语音识别权限\n检测完成\n开权限：https://open.feishu.cn/app/x/auth\n');
    h.clear(); await runSettingsVoice('test', {}, h.io(true), h.daemon);
    expect(h.acts()[1]).toEqual({ type: 'act', action: { kind: 'voice', botId: 'cli_a', action: { action: 'test' } } });
    expect(h.json()).toEqual({ ok: true, result: 'saved', warnings: [], voice: after.voice });
    expect(await h.failure(runSettingsVoice('enable', {}, h.io(true), h.daemon))).toMatchObject({ exitCode: 2 });
  });

  // main 必败
  it('a bot that is not running is refused with its reason and the daemon\'s words', async () => {
    const message = '这个 Bot 没在运行，运行起来后才能改设置';
    const h = harness(() => ({ kind: 'acted', result: { kind: 'unavailable', reason: { kind: 'readonly', reason: 'owner-offline', message } } }));
    expect(await h.failure(runSettingsVoice('refresh', {}, h.io(true), h.daemon))).toEqual({ ok: false, exitCode: 4, error: { kind: 'refused', reason: 'owner-offline', message } });
  });
});

describe('settings act admin', () => {
  // main 必败
  it('reads the revision first unless given one, and prints who is an administrator', async () => {
    const after = agentView({ administrators: { ...agentView().administrators, openIds: ['ou_owner', 'ou_local', 'ou_x'], revision: 'a2' } });
    const h = harness(request => request.type === 'act' ? savedWith(after) : { kind: 'view', view: agentView() });
    await runSettingsAdmin('add', 'ou_x', {}, h.io(), h.daemon);
    expect(h.send.mock.calls.map(([request]) => request)).toEqual([
      { type: 'read', scope: { kind: 'agent', botId: 'cli_a' } },
      { type: 'act', action: { kind: 'adminMember', botId: 'cli_a', openId: 'ou_x', membership: 'present', revision: 'a1' } },
    ]);
    expect(h.out()).toBe('已加上管理员 ou_x。\n管理员：ou_owner（创建者）、ou_local、ou_x\n');
    h.send.mockClear(); h.clear();
    await runSettingsAdmin('remove', 'ou_local', { revision: 'a0' }, h.io(true), h.daemon);
    expect(h.send.mock.calls.map(([request]) => request)).toEqual([{ type: 'act', action: { kind: 'adminMember', botId: 'cli_a', openId: 'ou_local', membership: 'absent', revision: 'a0' } }]);
    expect(h.json()).toEqual({ ok: true, result: 'saved', warnings: [], administrators: after.administrators });
  });

  // main 必败
  it('a stale revision is a conflict 5 with the list as it is now; a bad Open ID never connects', async () => {
    const now = agentView({ administrators: { ...agentView().administrators, revision: 'a9' } });
    const h = harness(() => ({ kind: 'acted', result: { kind: 'conflict', view: now } }));
    expect(await h.failure(runSettingsAdmin('add', 'ou_x', { revision: 'a0' }, h.io(true), h.daemon))).toMatchObject({ exitCode: 5, error: { kind: 'conflict', reason: 'conflict', current: { revision: 'a9', openIds: ['ou_owner', 'ou_local'] } } });
    const offline = harness(() => { throw new Error('not called'); });
    for (const [op, id] of [['add', '123'], ['add', 'ou_'], ['drop', 'ou_x']]) {
      expect(await offline.failure(runSettingsAdmin(op!, id!, {}, offline.io(true), offline.daemon)), `${op} ${id}`).toMatchObject({ exitCode: 2, error: { kind: 'bad-args' } });
    }
    expect(offline.connect).not.toHaveBeenCalled();
  });

  it('a refusal the daemon gives as rejected is 2 with the fields', async () => {
    const fields = [{ field: 'settings', message: '飞书应用管理员和注册者不能在本机移除' }];
    const h = harness(request => request.type === 'act' ? { kind: 'acted', result: { kind: 'rejected', fields } } : { kind: 'view', view: agentView() });
    expect(await h.failure(runSettingsAdmin('remove', 'ou_owner', {}, h.io(true), h.daemon)))
      .toEqual({ ok: false, exitCode: 2, error: { kind: 'bad-args', reason: 'rejected', message: '没有保存：settings：飞书应用管理员和注册者不能在本机移除', partial: { fields } } });
  });
});

describe('settings act member', () => {
  // main 必败
  it('add and remove change one Open ID in the group\'s list with its revision', async () => {
    const h = harness(request => request.type === 'act' ? savedWith(projectView(['ou_b', 'ou_c'])) : { kind: 'view', view: projectView() });
    await runSettingsMember('add', 'ou_c', { group: 'oc_dev' }, h.io(), h.daemon);
    expect(h.send.mock.calls.map(([request]) => request)).toEqual([
      { type: 'read', scope: { kind: 'project', botId: 'cli_a', projectName: '研发' } },
      { type: 'act', action: { kind: 'projectMember', botId: 'cli_a', projectName: '研发', openId: 'ou_c', membership: 'present', revision: 'm1' } },
    ]);
    expect(h.out()).toBe('已加上响应成员 ou_c。\n响应成员：ou_b（小北）、ou_c\n');
  });

  // main 必败
  it('all over an empty list sends nothing; over a list it sends projectAudience', async () => {
    const empty = harness(() => ({ kind: 'view', view: projectView([]) }));
    await runSettingsMember('all', undefined, { group: '研发' }, empty.io(true), empty.daemon);
    expect(empty.acts()).toEqual([]);
    expect(empty.json()).toMatchObject({ ok: true, result: 'unchanged', members: { openIds: [] } });
    empty.clear(); await runSettingsMember('all', undefined, { group: '研发' }, empty.io(), empty.daemon);
    expect(empty.out()).toBe('已经是所有成员都能用，没有改。\n');

    const h = harness(request => request.type === 'act' ? savedWith(projectView([])) : { kind: 'view', view: projectView() });
    await runSettingsMember('all', undefined, { group: '研发' }, h.io(), h.daemon);
    expect(h.acts()).toEqual([{ type: 'act', action: { kind: 'projectAudience', botId: 'cli_a', projectName: '研发', audience: 'all', revision: 'm1' } }]);
    expect(h.out()).toBe('已改成所有成员都能用。\n响应成员：所有成员\n');
  });

  it('needs --group and an Open ID for add and remove, none for all, before connecting', async () => {
    const h = harness(() => { throw new Error('not called'); });
    for (const [op, id, group] of [['add', 'ou_c', undefined], ['add', undefined, '研发'], ['remove', 'x', '研发'], ['all', 'ou_c', '研发'], ['some', 'ou_c', '研发']] as const) {
      expect(await h.failure(runSettingsMember(op, id, group === undefined ? {} : { group }, h.io(true), h.daemon)), `${op} ${id}`).toMatchObject({ exitCode: 2 });
    }
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('a conflict carries the group\'s list as it is now', async () => {
    const h = harness(() => ({ kind: 'acted', result: { kind: 'conflict', view: projectView(['ou_z']) } }));
    expect(await h.failure(runSettingsMember('remove', 'ou_b', { group: '研发', revision: 'm0' }, h.io(true), h.daemon))).toMatchObject({ exitCode: 5, error: { current: { openIds: ['ou_z'], revision: 'm1' } } });
    expect(h.send.mock.calls.filter(([request]) => request.type === 'read')).toEqual([]);
  });
});

describe('settings act comment-instructions', () => {
  // main 必败
  it('--stdin sends the piped text less one trailing newline, --default the default', async () => {
    const custom = agentView({ commentInstructions: { content: { kind: 'custom', text: '写短一点' }, revision: 'c2', maxEditLength: 30000 } });
    const h = harness(request => request.type === 'act' ? savedWith(custom, ['回复规则已保存，但部分历史评论目录同步失败。']) : { kind: 'view', view: agentView() });
    await runSettingsCommentInstructions({ stdin: true }, {}, h.io(), h.daemon, pipe('写短一点\n'));
    expect(h.acts()).toEqual([{ type: 'act', action: { kind: 'commentInstructions', botId: 'cli_a', revision: 'c1', content: { kind: 'custom', text: '写短一点' } } }]);
    expect(h.out()).toBe('已保存。评论指令：自定义「写短一点」\n回复规则已保存，但部分历史评论目录同步失败。\n');
    h.clear(); await runSettingsCommentInstructions({ default: true }, { revision: 'c7' }, h.io(true), h.daemon);
    expect(h.acts()[1]).toEqual({ type: 'act', action: { kind: 'commentInstructions', botId: 'cli_a', revision: 'c7', content: { kind: 'default' } } });
    expect(h.json()).toMatchObject({ ok: true, result: 'saved', commentInstructions: { revision: 'c2' } });
  });

  // main 必败
  it('takes exactly one source, refuses a terminal, an empty pipe and a text too long, without sending', async () => {
    const h = harness(() => ({ kind: 'view', view: agentView({ commentInstructions: { content: { kind: 'default', text: 'x' }, revision: 'c1', maxEditLength: 5 } }) }));
    const run = (source: object, stdin = pipe('')) => h.failure(runSettingsCommentInstructions(source, {}, h.io(true), h.daemon, stdin));
    expect(await run({ default: true, text: 'x' })).toMatchObject({ exitCode: 2, error: { message: '--default、--text <文字>、--stdin 正好给一个，这次给了 --default、--text。' } });
    expect(await run({})).toMatchObject({ exitCode: 2 });
    expect(await run({ stdin: true }, { isTTY: true, read: async () => 'x' })).toMatchObject({ exitCode: 2, error: { message: expect.stringContaining('cat 说明.md | vonvon settings act comment-instructions --stdin') } });
    expect(await run({ stdin: true }, pipe('\n'))).toMatchObject({ exitCode: 2, error: { message: '--stdin 没读到内容。' } });
    expect(await run({ text: 'x'.repeat(30001) })).toMatchObject({ exitCode: 2 });
    expect(h.connect).not.toHaveBeenCalled();
    // the view's own limit, once read
    expect(await run({ text: '六个字的指令' })).toMatchObject({ exitCode: 2, error: { kind: 'bad-args', message: '评论指令最多 5 个字，这次没有发出。' } });
    expect(h.acts()).toEqual([]);
  });
});

describe('settings models', () => {
  // main 必败
  it('takes codex for codex-appserver, lists the visible models, and says when the list is the built-in one', async () => {
    const catalog = (state: string) => ({ backend: 'codex-appserver', state, source: 'backend-provided', observedAt: 'x', titleEfforts: [], models: [
      { id: 'gpt-6', displayName: 'GPT-6', description: '', supportedEfforts: ['low'], defaultEffort: 'low', isDefault: true, hidden: false },
      { id: 'gpt-old', displayName: 'Old', description: '', supportedEfforts: ['low'], defaultEffort: 'low', isDefault: false, hidden: true },
    ] });
    let state = 'ready';
    const h = harness(() => ({ kind: 'models', catalog: catalog(state) }));
    await runSettingsModels({ backend: 'codex', purpose: 'project' }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'models', query: { botId: 'cli_a', backend: 'codex-appserver', purpose: 'project' } });
    expect(h.out()).toBe('gpt-6  GPT-6（默认）\n');
    state = 'fallback';
    h.clear(); await runSettingsModels({ backend: 'claude-agent', purpose: 'session', session: 'omt_1' }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'models', query: { botId: 'cli_a', backend: 'claude-agent', purpose: 'session', threadId: 'omt_1' } });
    // --refresh asks the Provider again (#641's explicit refresh), as the settings page's 刷新 does.
    h.clear(); await runSettingsModels({ backend: 'codex', purpose: 'project', refresh: true }, h.io(), h.daemon);
    expect(h.send).toHaveBeenLastCalledWith({ type: 'models', query: { botId: 'cli_a', backend: 'codex-appserver', purpose: 'project', refresh: true } });
    expect(h.out()).toBe('daemon 没拿到最新目录，这是内置的\ngpt-6  GPT-6（默认）\n');
    h.clear(); await runSettingsModels({ backend: 'codex', purpose: 'judge' }, h.io(true), h.daemon);
    expect(h.json()).toEqual({ ok: true, catalog: catalog('fallback') });
    state = 'unavailable';
    expect(await h.failure(runSettingsModels({ backend: 'codex', purpose: 'project' }, h.io(true), h.daemon))).toMatchObject({ exitCode: 4, error: { kind: 'refused', reason: 'models_unavailable' } });
  });

  // main 必败
  it('needs --backend, a known --purpose, and --session for session, before connecting', async () => {
    const h = harness(() => { throw new Error('not called'); });
    for (const target of [{ purpose: 'project' }, { backend: 'codex' }, { backend: 'codex', purpose: 'chat' }, { backend: 'codex', purpose: 'session' }]) {
      expect(await h.failure(runSettingsModels(target, h.io(true), h.daemon)), JSON.stringify(target)).toMatchObject({ exitCode: 2 });
    }
    expect(h.connect).not.toHaveBeenCalled();
  });
});

/**
 * dev #641 gave the bot's settings calls 120 s over admin IPC: a read, a save, a model list or an action may start a
 * Provider (validateModelAccess, effectiveSelection). A terminal waiting less said 「可能已经保存」 while the daemon still
 * saved, and the web page, with no limit of its own, finished the same save.
 */
describe('settings calls that may start a Provider wait past the daemon\'s own budget', () => {
  const budget = (kind: AdminIpcOp['kind']) => adminIpcTimeout({ kind } as AdminIpcOp);
  const late = <T>(ms: number, value: T) => new Promise<T>(done => { setTimeout(() => done(value), ms); });
  const BUDGET = { read: budget('settingsRead'), save: budget('settingsPatch'), models: budget('settingsModels'), act: budget('settingsAction') };
  const access = section({ backend: 'codex-appserver', models: ['gpt-6'], efforts: ['low'], defaultModel: 'gpt-6' });
  const accessView = projectView(['ou_b'], { sections: { modelAccess: access } });
  const catalog = { backend: 'codex-appserver', state: 'ready', source: 'backend-provided', observedAt: 'x', titleEfforts: [], models: [
    { id: 'gpt-6', displayName: 'GPT-6', description: '', supportedEfforts: ['low'], defaultEffort: 'low', isDefault: true, hidden: false },
  ] };
  /** The real withDaemon with its own waits; each settings request answers `ms(request)` later, or never. */
  function slow(ms: (request: SettingsRequest) => number | undefined, collaboration = async () => ({ kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: catalog.models })) {
    let out = '';
    const reply = (request: SettingsRequest) => request.type === 'models' ? { kind: 'models', catalog }
      : request.type === 'save' ? { kind: 'saved', result: { kind: 'saved', section: { scope: accessView.scope, section: 'modelAccess', value: access }, effects: [] } }
        : request.type === 'act' ? savedWith(agentView())
          : request.type === 'sessions' ? { kind: 'sessions', sessions: [] }
            : { kind: 'view', view: request.scope.kind === 'project' ? accessView : agentView() };
    const settings = vi.fn((request: SettingsRequest) => { const wait = ms(request); return wait === undefined ? new Promise(() => {}) : late(wait, reply(request)); });
    const snapshot = async () => ({
      agents: [{ id: 'cli_a', name: 'Test' }],
      memberships: [{ agentId: 'cli_a', groupId: 'oc_dev', name: '研发', conversation: 'threads', backend: 'codex-appserver', directory: '/home/u/dev' }],
    });
    const daemon: Daemon = fn => withDaemon(fn, async () => ({ snapshot, settings, collaboration, close: async () => {} }) as unknown as VonvonClient);
    return { daemon, settings, io: { json: false, write: (text: string) => { out += text; } }, out: () => out };
  }
  /** Runs `run` to its end, moving the fake clock `by` at a time; returns the error, if any. */
  async function settle(run: Promise<void>, by: number): Promise<unknown> {
    let ended = false;
    const result = run.then(() => undefined, (error: unknown) => error).finally(() => { ended = true; });
    for (let i = 0; i < 10 && !ended; i++) await vi.advanceTimersByTimeAsync(by);
    expect(ended).toBe(true);
    return result;
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  // 035848d2 必败: settings get and set waited 30 s, settings models and provider models 75 s
  it('a read, a save, a model list and an action answered just inside the daemon\'s budget complete', async () => {
    const wait = (request: SettingsRequest) => request.type === 'save' ? BUDGET.save - 1 : request.type === 'models' ? BUDGET.models - 1
      : request.type === 'act' ? BUDGET.act - 1 : request.type === 'read' ? BUDGET.read - 1 : 0;
    const set = slow(wait);
    expect(await settle(runSettingsSet(['modelAccess.defaultModel=gpt-6'], { group: '研发' }, set.io, set.daemon), 60_000)).toBeUndefined();
    expect(set.settings.mock.calls.map(([request]) => request.type)).toEqual(['read', 'save']);
    expect(set.out()).toBe('已保存 modelAccess.defaultModel = gpt-6。\n');
    const get = slow(wait);
    expect(await settle(runSettingsGet('modelAccess', { group: '研发' }, get.io, get.daemon), 60_000)).toBeUndefined();
    const models = slow(wait);
    expect(await settle(runSettingsModels({ backend: 'codex', purpose: 'project' }, models.io, models.daemon), 60_000)).toBeUndefined();
    expect(models.out()).toBe('gpt-6  GPT-6（默认）\n');
    const voice = slow(wait);
    expect(await settle(runSettingsVoice('refresh', {}, voice.io, voice.daemon), 60_000)).toBeUndefined();
    // no admin IPC budget here: the daemon itself starts the Provider, as the web page's Provider list does
    const provider = slow(() => 0, () => late(BUDGET.models - 1, { kind: 'providerModels', backend: 'codex-appserver', state: 'ready', models: catalog.models }));
    expect(await settle(runProviderModels('codex', provider.io, provider.daemon), 60_000)).toBeUndefined();
    expect(provider.out()).toBe('gpt-6  GPT-6（默认）\n');
  });

  it('a daemon that never answers still ends the command, after its budget, as outcome unknown', async () => {
    const h = slow(request => request.type === 'save' ? undefined : 0);
    const run = runSettingsSet(['modelAccess.defaultModel=gpt-6'], { group: '研发' }, h.io, h.daemon);
    let ended = false;
    const result = run.then(() => undefined, (error: unknown) => error).finally(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(BUDGET.save);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ended).toBe(true);
    expect(commandFailure(await result)).toMatchObject({ exitCode: 6, error: { kind: 'outcome-unknown', message: expect.stringContaining('可能已经保存，运行 vonvon settings get 查看。') } });
  });
});

describe('settings get: what the buttons change (4.4)', () => {
  // main 必败: get printed none of these
  it('a bot\'s voice, administrators and comment instructions; a group\'s members and skills; --json unchanged', async () => {
    const custom = { content: { kind: 'custom', text: '只回和代码有关的评论，'.repeat(6) }, revision: 'c2', maxEditLength: 30000 };
    const skills = [
      { path: '/s/a', name: 'review', description: '', source: 'workspace', enabled: true },
      { path: '/s/b', name: 'deploy', description: '', source: 'user', enabled: true },
      { path: '/s/c', name: 'lint', description: '', source: 'provider', enabled: false },
    ];
    const group = projectView(['ou_b'], { sections: { skills: section({ disabledPaths: ['/s/b'] }) }, skills });
    const h = harness(request => request.type === 'sessions' ? { kind: 'sessions', sessions: [] }
      : { kind: 'view', view: request.type === 'read' && request.scope.kind === 'project' ? group : agentView({ commentInstructions: custom }) });
    await runSettingsGet(undefined, { bot: 'cli_a' }, h.io(), h.daemon);
    expect(h.out()).toBe([
      'Bot Test（cli_a）的设置',
      '语音转文字：开（飞书语音权限：已开通）',
      '管理员：ou_owner（创建者）、ou_local',
      '管理员改动：vonvon settings act admin add|remove <openId> --bot cli_a',
      `评论指令：自定义「${Array.from(custom.content.text).slice(0, 40).join('')}…」`, '',
    ].join('\n'));
    h.clear(); await runSettingsGet(undefined, { group: '研发' }, h.io(), h.daemon);
    expect(h.out()).toContain('[skills]\n  disabledPaths = ["/s/b"]\n还没有会话。\n响应成员：ou_b（小北）\nSkill：3 个（停用 2 个）\n  review  本群工作区\n  deploy  用户目录  已停用\n  lint  Provider  已停用\n');
    h.clear(); await runSettingsGet(undefined, { group: '研发' }, h.io(true), h.daemon);
    expect(Object.keys(JSON.parse(h.out()))).toEqual(['ok', 'view', 'sessions']);
    // one section asked for: only that section
    h.clear(); await runSettingsGet('skills', { group: '研发' }, h.io(), h.daemon);
    expect(h.out()).toContain('[skills]');
    expect(h.out()).not.toContain('语音转文字');
  });

  it('an empty list is everyone; a skills error shows instead of the list', async () => {
    const h = harness(request => request.type === 'sessions' ? { kind: 'sessions', sessions: [] } : { kind: 'view', view: projectView([], { skillsError: '暂时无法读取技能目录' }) });
    await runSettingsGet(undefined, { group: '研发' }, h.io(), h.daemon);
    expect(h.out()).toContain('响应成员：所有成员\nSkill：暂时无法读取技能目录\n');
  });
});

// main 必败: the eight kinds were pending C6 in the allowlist
it('the settings kinds C6 brings are covered by a command and gone from the allowlist (devices 8.5)', async () => {
  const commands = await loadCommands();
  for (const kind of ['settings.read.host', 'settings.save.host', 'settings.act.voice', 'settings.act.adminMember', 'settings.act.projectMember', 'settings.act.projectAudience', 'settings.act.commentInstructions', 'settings.models']) {
    expect(Object.hasOwn(CLI_PARITY_ALLOWLIST, kind), kind).toBe(false);
    expect(commands.some(command => command.covers.includes(kind)), kind).toBe(true);
  }
  const options = (path: string) => commands.find(command => command.path === path)?.options;
  for (const path of ['settings get', 'settings set']) expect(options(path), path).toContain('--host');
  expect(options('schedule edit')).toEqual(expect.arrayContaining(['--new-topic', '--follow']));
});

describe('vonvon settings act through the CLI entry', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.doUnmock('../src/config/data-access'); vi.doUnmock('../src/host/lifecycle'); });

  // main 必败: the command did not exist, and a third-level command fell through to the data lease
  it('with no daemon reports only the connection: no data root, no lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'settings-act-cli-'));
    try {
      const enter = vi.fn();
      vi.resetModules();
      vi.doMock('../src/config/data-access', () => ({ enterDataAccess: enter }));
      vi.doMock('../src/host/lifecycle', () => ({ observeShutdown: () => ({ dispose() {} }) }));
      const fake = Object.assign(Object.create(process), {
        argv: ['node', '/cli', 'settings', 'act', 'voice', 'test', '--json'], exitCode: undefined,
        env: { HOME: join(root, 'home'), VONVON_HOME: join(root, 'data') },
      }) as NodeJS.Process;
      vi.stubGlobal('process', fake);
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(text => { out += String(text); return true; });
      await import('../src/cli/index');
      await vi.waitFor(() => expect(fake.exitCode).toBe(3));
      expect(JSON.parse(out)).toMatchObject({ ok: false, exitCode: 3, error: { kind: 'connection' } });
      expect(enter).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


it('reads and patches ordinary work rules through the generic role command with the original revision', async () => {
  const role = section({ supplement: '现有职责', workRules: '现有工作规则' });
  const h = harness(request => request.type === 'read'
    ? { kind: 'view', view: projectView([], { sections: { role } }) }
    : request.type === 'sessions' ? { kind: 'sessions', sessions: [] } : { kind: 'saved', result: { kind: 'saved', section: {}, effects: [] } });
  await runSettingsGet('role', { group: '研发' }, h.io(true), h.daemon);
  expect(h.out()).toContain('现有工作规则');
  h.clear();
  await runSettingsSet(['role.workRules="先核对\\n再执行"'], { group: '研发', revision: 'original-snapshot' }, h.io(), h.daemon);
  expect(h.send).toHaveBeenLastCalledWith({ type: 'save', edit: {
    scope: { kind: 'project', botId: 'cli_a', projectName: '研发' }, section: 'role', revision: 'original-snapshot', patch: { workRules: '先核对\n再执行' },
  } });
});
