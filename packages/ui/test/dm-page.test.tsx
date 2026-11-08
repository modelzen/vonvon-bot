import {permissionValue} from './permission-fixture';
import {expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentIdSchema, groupIdSchema, membershipIdSchema, type Agent, type ContextPreviewReply, type DesktopSnapshot, type Membership, type ProjectSettingsView} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {BotGroupList, dmRowOf} from '../src/BotGroupList';
import {ClientProvider} from '../src/client-context';
import {ContextPanelView} from '../src/ContextPanel';
import {injectedLine, panelRows} from '../src/context-model';
import {DirectoryPickerProvider} from '../src/directory-picker';
import {DmPeopleList} from '../src/DmMemory';
import {dmChats, dmPersonLabel, dmPersonRow, type DmPerson} from '../src/dm-people';
import {GroupWorkspace} from '../src/GroupWorkspace';
import {memoryScopeKey} from '../src/memory-model';
import {dmScheduleSummary, dmTasksOf, listOf} from '../src/schedule-model';
import {ScheduleTaskList} from '../src/ScheduleTab';
import {DraftGuardProvider} from '../src/settings/DraftGuard';
import {dmFixedRows, GroupSettingsContent, type GroupSettingsTab} from '../src/settings/GroupDesignSettings';
import {scheduleTask, tasksReply} from './schedule-fixture';

// dm-agent 10 (D4): the private chat on the Bot page and its own page. main 必败, every one: neither existed.
const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const botId = agentIdSchema.parse('cli_dm');
const rowId = groupIdSchema.parse('oc_dm_cli_dm');
const row = (over: Partial<Membership> = {}): Membership => ({
  id: membershipIdSchema.parse('private'), agentId: botId, groupId: rowId, name: '私聊', directory: '/data/projects/dm', backend: 'claude-agent', conversation: 'shared',
  response: 'all', permission: {administrator: 'full', member: 'full', network: true}, stale: false, ...over,
});
const agent = (over: Partial<Agent> = {}): Agent => ({id: botId, name: '小支', enabled: true, running: true, connection: 'connected', activation: 'active', dm: row(), ...over});
const group = {id: groupIdSchema.parse('oc_team'), name: '研发群'};
const member = row({id: membershipIdSchema.parse('team'), groupId: group.id, name: '研发群', backend: 'codex-appserver', conversation: 'threads'});
const snapshotOf = (bot: Agent, memberships: Membership[]) => ({agents: [bot], groups: memberships.length ? [group] : [], memberships, tools: [], application: {platform: 'macos'}, revision: 1}) as unknown as DesktopSnapshot;
const running = {label: '运行中', tone: 'success'} as const;
const list = (bot: Agent, memberships: Membership[], extra: {dmNew?: number} = {}) => renderToStaticMarkup(<BotGroupList snapshot={snapshotOf(bot, memberships)} agent={bot} busy={false} status={running} onJoin={() => {}} onMembership={() => {}} onDm={() => {}} {...extra}/>);

it('puts the private chat at the very top of the group list, with its Provider and way of talking, counted as no group', () => {
  const html = list(agent(), [member]);
  expect(html.indexOf('私聊')).toBeGreaterThan(-1);
  expect(html.indexOf('私聊')).toBeLessThan(html.indexOf('研发群'));
  expect(html).toContain('bot-group-list__count">1<');
  expect(html).toContain('aria-label="设置 小支 的私聊，Provider：Claude，沟通方式：连续交谈"');
  expect(html).toContain('和 小支 的私聊');
  expect(html).toContain('bot-group-list__mode">连续交谈<');
  expect(list(agent({dm: row({conversation: 'smart'})}), [member])).toContain('bot-group-list__mode">智能<');
  expect(html).toContain('collaboration-avatar agent');
  expect(html.match(/<button[^>]*bot-group-list__row/g)).toHaveLength(2);
});

it('stays with no group bound, above 尚未绑定飞书群, and the count is 0', () => {
  const html = list(agent(), []);
  expect(html.indexOf('私聊')).toBeGreaterThan(-1);
  expect(html.indexOf('私聊')).toBeLessThan(html.indexOf('尚未绑定飞书群'));
  expect(html).toContain('bot-group-list__count">0<');
});

it('keeps compatibility with an older daemon that supplies neither a private chat nor an error', () => {
  expect(list(agent({dm: undefined}), [member])).not.toContain('私聊');
});

it.each([undefined, row({stale: true})])('shows an unavailable private-chat entry and leaves healthy groups usable after preparation fails (%#)', dm => {
  const bot = agent({dm, dmError: '私聊初始化失败：Bot 目录需要修复'});
  const html = list(bot, [member]);
  expect(html).toContain('私聊和飞书群');
  expect(html).toContain('和 小支 的私聊');
  expect(html).toContain('暂不可用');
  expect(html).toContain('私聊初始化失败：Bot 目录需要修复');
  expect(html).toContain('role="status"');
  expect(html).not.toContain('aria-label="设置 小支 的私聊');
  expect(html).toContain('aria-label="设置 小支 在 研发群 中的行为，Provider：Codex，沟通方式：独立话题"');
  expect(html.match(/<button[^>]*bot-group-list__row/g)).toHaveLength(1);
  expect(html).not.toContain('disabled=""');
  expect(html).toContain('bot-group-list__count">1<');
});

it('keeps the private-chat failure visible with no groups and restores its settings entry when the error clears', () => {
  const failed = list(agent({dm: undefined, dmError: '私聊初始化失败：目录不可写'}), []);
  expect(failed).toContain('和 小支 的私聊');
  expect(failed).toContain('私聊初始化失败：目录不可写');
  expect(failed).toContain('尚未绑定飞书群');
  expect(failed).not.toContain('群配置读取失败');
  const recovered = list(agent(), []);
  expect(recovered).not.toContain('私聊初始化失败');
  expect(recovered).not.toContain('暂不可用');
  expect(recovered).toContain('aria-label="设置 小支 的私聊');
});

it('says what is wrong with the row, and how much is new in its memory', () => {
  expect(dmRowOf(agent(), running)).toMatchObject({provider: 'Claude', exception: undefined});
  expect(dmRowOf(agent({dm: row({stale: true})}), running)).toMatchObject({exception: '状态过期', tone: 'warning'});
  expect(dmRowOf(agent({dmError: '私聊配置读取失败'}), running)).toMatchObject({exception: '暂不可用', tone: 'warning'});
  expect(dmRowOf(agent(), {label: '已停用', tone: 'neutral'})).toMatchObject({exception: 'Bot 已停用'});
  expect(list(agent(), [], {dmNew: 3})).toContain('新 3');
});

const page = (bot: Agent, tab: 'model' | 'memory' | 'schedule' = 'model') => renderToStaticMarkup(<ClientProvider client={client}><DirectoryPickerProvider><DraftGuardProvider>
  <GroupWorkspace dmMode member={bot.dm!} agent={bot} group={{id: rowId, name: '私聊'}} snapshot={snapshotOf(bot, [])} initialTab={tab} onBot={() => {}} onBotProfile={() => {}} onOpenTools={() => {}} onOpenSecrets={() => {}} onChanged={async () => {}}/>
</DraftGuardProvider></DirectoryPickerProvider></ClientProvider>);
it('opens the group workspace without what only a group has', () => {
  const html = page(agent());
  for (const label of ['模型与权限', '能力', '沟通方式', '记忆', '任务']) expect(html).toContain(`>${label}<`);
  expect(html).toContain('aria-label="私聊设置"');
  for (const gone of ['在飞书打开', '对话记录', '使用说明', '解除群绑定', '在本群使用', '选择本群 Bot']) expect(html).not.toContain(gone);
  expect(page(agent({running: false}))).toContain('Bot 未运行');
});

it('opens on 记忆 and 任务 without reading a project', () => {
  for (const tab of ['memory', 'schedule'] as const) {
    const html = page(agent(), tab);
    expect(html).toContain('aria-label="私聊设置"');
    expect(html).not.toContain('项目记忆');
  }
});

const section = <const T,>(stored: T, access: object = {kind: 'writable'}) => ({stored, effective: stored, revision: 'r', access, apply: []});
const fixed = {kind: 'readonly', reason: 'dm-fixed', message: '私聊只有完全访问一档'};
const view = (): ProjectSettingsView => ({
  scope: {kind: 'project', botId, projectName: rowId},
  identity: {chatId: rowId, backend: 'codex-appserver', cwd: '/data/projects/dm', kind: 'single'},
  skills: [{name: '实际技能', description: '', path: 'claude:actual', source: 'provider', enabled: true}],
  sections: {
    permission: section(permissionValue(), fixed), response: section({noMention: true}, fixed), model: section({selection: {kind: 'default'}}),
    modelAccess: section({backend: 'codex-appserver', models: ['actual-a'], efforts: ['low']}), skills: section({disabledPaths: []}),
    presentation: section({voiceEnabled: false, showToolCalls: true, showModel: 'running', completionMode: 'failures', longTaskMinutes: 3}), run: section({pendingPolicy: 'default'}),
    workspace: section({primary: '/data/projects/dm', directories: [], repositories: []}, fixed),
    conversation: section({mode: 'smart'}), smartRules: section({respond: '私聊的规则', newTopic: ''}),
  }, members: {openIds: [], revision: 'm'},
} as unknown as ProjectSettingsView);
const settings = (tab: GroupSettingsTab) => renderToStaticMarkup(<ClientProvider client={client}><DirectoryPickerProvider><DraftGuardProvider>
  <GroupSettingsContent dm agent={agent()} tab={tab} view={view()} refresh={async () => {}} botName="小支" onOpenTools={() => {}}/>
</DraftGuardProvider></DirectoryPickerProvider></ClientProvider>);

it('uses the group\'s 聊天方式 slider with the two ways a private chat has, and the group\'s other settings', () => {
  const html = settings('response');
  for (const shown of ['聊天方式', 'type="range"', '连续交谈', '智能', '每条都看，只回需要回的', '回复卡片样式', '此私聊使用旧版默认展示', '完成提醒', '回应谁', '只有管理员可以私聊这个 Bot', '这台设备及设备上的所有 Bot']) expect(html).toContain(shown);
  for (const gone of ['独立话题', '响应成员', '免 @']) expect(html).not.toContain(gone);
  expect(html).toContain('max="1"');
});

it('shows the private chat\'s own rules while it is smart, none on 连续交谈', () => {
  const smart = view(); smart.identity = {...smart.identity, kind: 'smart'} as never;
  const render = (value: ProjectSettingsView) => renderToStaticMarkup(<ClientProvider client={client}><DirectoryPickerProvider><DraftGuardProvider>
    <GroupSettingsContent dm tab="response" view={value} refresh={async () => {}} botName="小支" onOpenTools={() => {}}/>
  </DraftGuardProvider></DirectoryPickerProvider></ClientProvider>);
  expect(render(smart)).toContain('判断规则');
  expect(render(view())).not.toContain('判断规则');
});

it('shows the tier and the folder on 模型与权限, and nothing there to change them', () => {
  const [tier, folder] = dmFixedRows(view());
  expect(tier).toMatchObject({title: '执行权限', value: '完全访问'});
  expect(folder).toMatchObject({title: '目录', value: '/data/projects/dm'});
  const html = settings('model');
  expect(html).toContain('模型设置');
  expect(html).toContain('完全访问');
  expect(html).toContain('/data/projects/dm');
  for (const gone of ['只读', '工作区可写', '高级设置', '添加目录', '私聊只有完全访问一档', '群内通过']) expect(html).not.toContain(gone);
});

it('keeps Skill, tools and 语音 on 能力', () => {
  const html = settings('capabilities');
  expect(html).toContain('实际技能');
  expect(html).toContain('安装与授权');
  expect(html).toContain('语音');
});

const person = (over: Partial<DmPerson>): DmPerson => ({openId: 'ou_abcdef123456', at: 1, used: 0, ...over});
it('lists each person with their count and what is new, and someone no longer an admin stays', () => {
  expect(dmPersonLabel(person({name: '张三'}))).toBe('张三');
  expect(dmPersonLabel(person({}))).toBe('…123456');
  expect(dmPersonRow(person({name: '张三', used: 4, fresh: 2, admin: true}))).toEqual({title: '张三', meta: '4 条 · 新 2'});
  expect(dmPersonRow(person({used: 1, admin: false}))).toMatchObject({meta: '1 条 · 已不是管理员'});
  const onSelect = vi.fn();
  const html = renderToStaticMarkup(<DmPeopleList people={[person({openId: 'ou_a', name: '张三', used: 4, fresh: 2}), person({openId: 'ou_b', name: '李四', admin: false})]} selected="ou_a" onSelect={onSelect}/>);
  expect(html.indexOf('张三')).toBeLessThan(html.indexOf('李四'));
  expect(html).toContain('4 条 · 新 2');
  expect(html).toContain('已不是管理员');
  expect(renderToStaticMarkup(<DmPeopleList people={[]} onSelect={onSelect}/>)).toContain('还没有人和这个 Bot 私聊过');
});

it('keeps each person\'s memory its own on the page', () => {
  expect(memoryScopeKey({kind: 'dm', botId, openId: 'ou_a'})).toBe('dm:cli_dm:ou_a');
  expect(memoryScopeKey({kind: 'dm', botId, openId: 'ou_a'})).not.toBe(memoryScopeKey({kind: 'dm', botId, openId: 'ou_b'}));
  expect(memoryScopeKey({kind: 'bot', botId})).toBe('bot:cli_dm');
});

it('previews a private chat with its own memory and no smart mode', () => {
  const reply: ContextPreviewReply = {
    kind: 'preview', running: true,
    next: {sections: [{key: 'identity', version: 'i', chars: 1}, {key: 'dmMemory', version: 'd', chars: 9, items: 3, branches: 1}], items: {bot: 0, trusted: 2, untrusted: 1}, tools: ['memory_add']},
    session: {threadId: 't', updatedAt: 1, backend: 'claude-agent', legacy: false, redeliverDue: false, sections: [{key: 'dmMemory', version: 'd', stale: false, items: 3}],
      lastTurn: {at: 1, injected: 3, items: {bot: 0, trusted: 2, untrusted: 1}, used: []}},
    judge: {via: 'local', roleChars: 0, memoryItems: 0, memoryChars: 0},
  };
  expect(panelRows(reply).find(row => row.key === 'dmMemory')).toMatchObject({label: '私聊记忆', live: '3 条', next: '可信 2 条 / 待确认 1 条（1 个分支）'});
  expect(injectedLine(reply.session!.lastTurn!, '私聊记忆')).toBe('注入：Bot 记忆 0 条 · 私聊记忆 可信 2 / 待确认 1');
  const html = renderToStaticMarkup(<ContextPanelView dm title="小支 · 张三" groupId="" reply={reply} onOpen={() => {}}/>);
  expect(html).toContain('逐条看私聊记忆');
  expect(html).not.toContain('项目记忆');
  expect(html).not.toContain('智能判断');
  expect(renderToStaticMarkup(<ContextPanelView dm title="x" groupId="" reply={{...reply, session: undefined}} onOpen={() => {}}/>)).toContain('这个私聊现在没有活会话');
});

it('offers a new task the admins with a chat, not someone removed', () => {
  expect(dmChats([person({openId: 'ou_a', name: '张三', chatId: 'oc_a', admin: true}), person({openId: 'ou_b', chatId: 'oc_b', admin: false}), person({openId: 'ou_c', chatId: 'oc_c'}), person({openId: 'ou_d'})]))
    .toEqual([{value: 'oc_a', label: '张三'}, {value: 'oc_c', label: '…ou_c'}]);
});

it('lists every person\'s tasks on the 任务 tab, whose they are first, and no group\'s', () => {
  const tasks = [scheduleTask({id: 'st_group', name: '群日报'}), scheduleTask({id: 'st_dm', name: '早报', chatId: 'oc_p2p', dm: {name: '张三'}}), scheduleTask({id: 'st_other', name: '晚报', chatId: 'oc_p2p_b', dm: {}})];
  const shown = dmTasksOf(listOf(tasksReply(tasks)));
  const html = renderToStaticMarkup(<ScheduleTaskList dm list={shown} deviceTitle="这台 Mac" notices={{}} onCreate={() => {}} onAction={() => {}}/>);
  expect(html).toContain('张三 · 每天 09:00');
  expect(html).toContain('私聊 · 每天 09:00');
  expect(html).not.toContain('群日报');
  expect(dmScheduleSummary(tasks[1]!, 'Asia/Shanghai').startsWith('张三 · ')).toBe(true);
  const none = renderToStaticMarkup(<ScheduleTaskList dm noCreate list={dmTasksOf(listOf(tasksReply([tasks[0]!])))} deviceTitle="这台 Mac" notices={{}} onCreate={() => {}} onAction={() => {}}/>);
  expect(none).toContain('私聊里还没有任务');
  expect(none).toMatch(/<button[^>]*disabled/);
});
