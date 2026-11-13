import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowUpRight, BookOpen, Check, ChevronDown, MessageSquare, MoreHorizontal} from 'lucide-react';
import {Select} from '@base-ui/react/select';
import {modeToConversation, type Agent, type Conversation, type DesktopSnapshot, type Group, type Membership, type ProjectId, type ProjectRecord} from '@vonvon/protocol';
import {useActiveDevice, useClient, useShellCapabilities} from './client-context';
import {whereName} from './device-copy';
import {AgentAvatar} from './AgentAvatar';
import {dmTitle} from './BotGroupList';
import {GroupAvatar} from './GroupAvatar';
import {NavigationIndicator} from './NavigationIndicator';
import {GroupUsage} from './GroupUsage';
import {settingAnchor} from './search';
import {Button, InlineNotice, Toggle} from './reference/components/ui';
import {Dialog, ConfirmDialog} from './reference/components/ui/Dialog';
import {ConversationSlider} from './settings/ConversationSlider';
import {GroupDesignSettings, type GroupSettingsTab} from './settings/GroupDesignSettings';
import {useDraftGuard} from './settings/DraftGuard';
import {ConversationPanel} from './management/ConversationPanel';
import {GroupAttentionStatus} from './management/GroupAttentionStatus';
import {OperationActivity} from './management/OperationActivity';
import {appliedNotice, removalNotice} from './management/ProjectPanel';
import {groupUrl, openExternalUrl} from './url-actions';
import {ProjectMemoryMap} from './ProjectPage';
import {DmMemory} from './DmMemory';
import {ScheduleTab} from './ScheduleTab';
import {GroupRecipeShare} from './community/authoring/GroupRecipeShare';
import {deviceTitle} from './setup/service-toggle';
import './group-workspace.css';

export type GroupDesignTab = GroupSettingsTab | 'memory' | 'schedule' | 'share';
export const groupDesignTabs: readonly [GroupDesignTab, string][] = [['model','模型与权限'],['capabilities','能力'],['response','沟通方式'],['memory','记忆'],['schedule','任务'],['share','分享']];
export function groupTabForSection(section?: string): GroupDesignTab {
  switch (section) {
    case '分享': return 'share';
    case '记忆':
    case '项目记忆': return 'memory';
    case '任务':
    case '定时任务': return 'schedule';
    case '本群角色':
    case '补充职责': return 'role';
    case undefined:
    case '执行模型':
    case '执行权限':
    case '群设置':
    case '模型与权限':
    case '可用模型': return 'model';
    case '权限':
    case '工作目录权限':
    case '能挡到什么':
    case '高级设置': return 'model';
    case '沟通方式':
    case '回复规则':
    case '聊天方式':
    case '决策模型':
    case '判断规则':
    case '群内响应':
    case '新消息处理':
    case '运行中来了消息':
    case '回应谁':
    case '响应成员':
    case '消息与提醒':
    case '回复样式':
    case '消息卡片':
    case '完成提醒': return 'response';
    default: return 'capabilities';
  }
}

type Props = {member: Membership; agent: Agent; group: Group; snapshot: DesktopSnapshot; dmMode?: boolean; initialTab?: GroupDesignTab; focusNew?: number; newMemoryCount?: number; revealHistory?: boolean; onTabChange?: (tab:GroupDesignTab) => void;
  onBot: (member: Membership) => void; onBotProfile: () => void; onProject?: (id: ProjectId) => void; onOpenTools: () => void; onOpenProviders?: () => void; onOpenSecrets: (provider?: string) => void; onChanged: () => Promise<void>};
// Intent: configure one Bot within one group, without exposing session management as navigation.
// Hierarchy: target first, Bot/project scope next, then compact settings pages. System type
// share Today's 4px spacing rhythm; history/help stay visible, and the group name opens Feishu.
export function GroupWorkspace({member, agent, group, snapshot, dmMode, initialTab, focusNew, newMemoryCount, revealHistory, onTabChange, onBot, onBotProfile, onOpenTools, onOpenProviders, onOpenSecrets, onChanged}: Props) {
  const client = useClient();
  const shell = useShellCapabilities();
  const where = useActiveDevice();
  const guard = useDraftGuard();
  const [tab, setTab] = useState<GroupDesignTab>(initialTab === 'role' ? 'memory' : initialTab === 'permission' ? 'model' : initialTab ?? 'model');
  const [project, setProject] = useState<ProjectRecord>();
  const [busy, setBusy] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [pendingConversation, setPendingConversation] = useState<Conversation | null>(null);
  const saving = useRef(false);
  const running = useRef(agent.running);
  running.current = agent.running;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'help'|'history'|'remove'|null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const ownerDocument = menu.current?.ownerDocument;
    if (!ownerDocument) return;
    function closeOutside(event: PointerEvent) {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && menu.current?.open) {
        event.preventDefault();
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    }
    ownerDocument.addEventListener('pointerdown', closeOutside);
    ownerDocument.addEventListener('keydown', closeOnEscape);
    return () => {ownerDocument.removeEventListener('pointerdown', closeOutside); ownerDocument.removeEventListener('keydown', closeOnEscape);};
  }, []);
  const [version, setVersion] = useState(0);
  useEffect(() => {if (revealHistory) setDialog('history');}, [revealHistory]);
  const target = {agentId: member.agentId, groupId: member.groupId, projectName: member.name};
  useEffect(() => {if (initialTab) setTab(initialTab === 'role' ? 'memory' : initialTab === 'permission' ? 'model' : initialTab);}, [initialTab]);
  useEffect(() => {
    // The private chat has no group to read, leave or switch off: its settings go through GroupDesignSettings alone.
    if (!agent.running || dmMode) return;
    let active = true;
    void client.collaboration({action:'project', ...target}).then(reply => {
      if (!active) return;
      if (reply.kind !== 'project') throw new Error(reply.kind === 'refused' ? reply.message : '无法读取群状态。');
      setProject(reply.project);
    }).catch(error => {if (active) setError(error instanceof Error ? error.message : '无法读取群状态。');});
    return () => {active = false;};
  }, [client, member.id, member.name, agent.running]);
  const sameProject = (other: ProjectRecord) => project && ['name','chatId','cwd','kind','backend','enabled'].every(key => other[key as keyof ProjectRecord] === project[key as keyof ProjectRecord]);
  async function update(change: {enabled?: boolean; conversation?: Conversation; project?: ProjectId}, remove = false) {
    if (!project || saving.current || !running.current) return false;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    if (change.enabled !== undefined) setPendingEnabled(change.enabled);
    if (change.conversation !== undefined) setPendingConversation(change.conversation);
    try {
      const current = await client.collaboration({action:'project', ...target});
      if (!running.current) throw new Error('Bot 已停止，操作未保存。');
      if (current.kind !== 'project') throw new Error(current.kind === 'refused' ? current.message : '无法读取群状态。');
      if (!sameProject(current.project)) {setProject(current.project); throw new Error('群设置已在别处修改，已更新，请重新选择。');}
      const reply = await client.collaboration(remove ? {action:'removeProject', ...target, expectedRevision:current.project.revision} : {action:'editProject', ...target, expectedRevision:current.project.revision, ...change});
      if (reply.kind !== 'applied') throw new Error(reply.kind === 'refused' ? reply.message : '操作未保存。');
      if (reply.project) setProject(reply.project);
      setNotice(remove ? removalNotice(reply) : appliedNotice('已保存。',reply,''));
      setVersion(value => value + 1);
      await onChanged();
      return true;
    } catch (failure) {setError(failure instanceof Error ? failure.message : '操作未保存。'); return false;}
    finally {saving.current = false; setBusy(false); setPendingEnabled(null); setPendingConversation(null);}
  }
  const available = agent.running && !!project && !member.stale;
  const tabs = dmMode ? groupDesignTabs.filter(([value]) => value !== 'share') : groupDesignTabs;
  const groupBots = snapshot.memberships.filter(item => item.groupId === group.id).flatMap(item => {
    const bot = snapshot.agents.find(candidate => candidate.id === item.agentId);
    return bot ? [{item, bot}] : [];
  });
  const memberProject = snapshot.projects?.find(item => item.id === member.projectId);
  const conversation = pendingConversation ?? (project ? modeToConversation(project.kind) : member.conversation);
  const conversationControl = (ordinaryResponse: ReactNode) => <div className="group-conversation-layout"><section id={settingAnchor("聊天方式")} className="group-conversation-choice" aria-label="聊天方式">
    <h3>聊天方式</h3><ConversationSlider label="聊天方式" value={conversation} disabled={!available} pending={busy} onChange={next => guard.navigate(() => {void update({conversation:next});})}/>
  </section>{conversation === 'smart' ? member.conversation === 'smart' && <GroupAttentionStatus attentionModel={snapshot.attentionModel} agent={agent} membership={member} connected={snapshot.host.kind === 'connected' && !snapshot.stale}/> : ordinaryResponse}</div>;
  return <div className="group-design-workspace">
    <header id={settingAnchor("群设置")} className="config-header">
      <div className="config-header-identity">
        <div className="config-group-title" data-dm={dmMode || undefined}>{dmMode ? <AgentAvatar agent={agent} large/> : <GroupAvatar group={group} large/>}<h2>{dmMode ? <span title={dmTitle(agent)}>{dmTitle(agent)}</span> : <button type="button" className="config-group-link" title="在飞书打开此群" aria-label={`在飞书打开 ${group.name}`} onClick={() => void openExternalUrl(groupUrl(group.id),'group',shell).catch(error => setError(String(error.message ?? error)))}><span>{group.name}</span><ArrowUpRight size={14} aria-hidden="true"/></button>}</h2></div>
        {!dmMode && <span className="config-context-divider" aria-hidden="true"/>}
        {!dmMode && <Select.Root items={groupBots.map(({item,bot}) => ({value:item.id,label:bot.name}))} value={member.id} onValueChange={value => {
          if (!value || value === member.id) return;
          const selected = groupBots.find(({item}) => item.id === value);
          if (selected) guard.navigate(() => onBot(selected.item));
        }}>
          <Select.Trigger className="header-bot-select" aria-label="选择本群 Bot" title={agent.name}>
            <AgentAvatar agent={agent}/><Select.Value className="header-bot-select-value"/><Select.Icon><ChevronDown size={13} aria-hidden="true"/></Select.Icon>
          </Select.Trigger>
          <Select.Portal><Select.Positioner align="start" alignItemWithTrigger={false} sideOffset={6} collisionPadding={8} className="ui-select-control__positioner header-bot-positioner">
            <Select.Popup className="ui-select-control__popup header-bot-popup"><div className="header-bot-popup-label">本群 Bot · {groupBots.length}</div><Select.List className="ui-select-control__list">
              {groupBots.map(({item,bot}) => <Select.Item value={item.id} key={item.id} className="ui-select-control__option"><Select.ItemIndicator className="ui-select-control__indicator"><Check size={13} aria-hidden="true"/></Select.ItemIndicator><Select.ItemText>{bot.name}</Select.ItemText></Select.Item>)}
            </Select.List></Select.Popup>
          </Select.Positioner></Select.Portal>
        </Select.Root>}
        {!dmMode && <div className="config-header-actions">
          <Button size="sm" className="config-history" icon={<MessageSquare size={14} aria-hidden="true"/>} onClick={() => guard.navigate(() => setDialog('history'))}>对话记录</Button>
          <Button size="sm" variant="ghost" className="config-help" icon={<BookOpen size={14} aria-hidden="true"/>} onClick={() => guard.navigate(() => setDialog('help'))}>使用说明</Button>
          <details ref={menu} className="group-context-menu"><summary aria-label="群操作"><MoreHorizontal size={18}/></summary><div>{([['history','对话记录'],['help','使用说明']] as const).map(([action,label]) => <button className="group-menu-shortcut" type="button" key={action} onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); guard.navigate(() => setDialog(action));}}>{label}</button>)}<button type="button" disabled={!available} onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); guard.navigate(() => setDialog('remove'));}}>解除群绑定…</button></div></details>
        </div>}
      </div>
      <div className="config-header-navigation">
        <nav className="group-design-tabs config-tabs gooey-tabs" aria-label={dmMode ? '私聊设置' : '群设置'}>
          <NavigationIndicator activeIndex={tabs.findIndex(([value]) => tab === value)}/>
          {tabs.map(([value,label]) => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => guard.navigate(() => {setTab(value); onTabChange?.(value);})}>{value === 'memory' && newMemoryCount ? <>{label}<span className="group-memory-tab-new" aria-label={`${newMemoryCount} 条新记忆`}>新 {newMemoryCount}</span></> : label}</button>)}
        </nav>
        {dmMode ? (!agent.running && <span className="group-control-note">{agent.enabled ? 'Bot 未运行' : 'Bot 已停用'}</span>) : project ? <span className="config-enable group-enable-control"><span role="status" className="group-save-status">{notice === '已保存。' && <><Check size={12} aria-hidden="true"/>已保存</>}</span>{pendingEnabled !== null && <OperationActivity key={`${member.id}:${pendingEnabled}`} label={pendingEnabled ? '本群启用中' : '本群停用中'} state={pendingEnabled ? 'connecting' : 'working'}/>}<Toggle aria-label={`在本群使用 ${agent.name}`} label="在本群使用" checked={project.enabled} disabled={!available || busy} onChange={event => {const enabled=event.target.checked; guard.navigate(() => {void update({enabled});});}}/></span> : <span className="group-control-note">{!agent.enabled ? 'Bot 已停用' : !agent.running ? 'Bot 未运行' : '读取中…'}</span>}
      </div>
    </header>
    {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
    {notice && notice !== '已保存。' && <p role="status" className="group-control-note">{notice}</p>}
    {tab === 'share' ? dmMode ? null : <GroupRecipeShare botId={agent.id} groupId={group.id}/> : tab === 'memory' ? <section id={settingAnchor('记忆')} aria-label="记忆">
      {dmMode ? <DmMemory key={member.id} agent={agent} revision={snapshot.revision} onBotProfile={() => guard.navigate(onBotProfile)}/> : memberProject ? <ProjectMemoryMap key={memberProject.id} focusNew={focusNew} groupsInitiallyOpen={false} initialRoleMembershipId={initialTab === 'role' ? member.id : undefined} selectedAgentId={member.agentId} selectedGroupId={member.groupId} onBotProfile={() => guard.navigate(onBotProfile)} project={memberProject} snapshot={snapshot} onMembership={id => {const target = snapshot.memberships.find(item => item.id === id); if (target) guard.navigate(() => onBot(target));}}/> : <p className="group-control-note">这个群的项目记忆暂不可用。</p>}
    </section> : tab === 'schedule' ? <ScheduleTab key={member.id} botId={member.agentId} {...dmMode ? {dm: true} : {chatId: member.groupId}} deviceTitle={deviceTitle(snapshot.application.platform)}/>
    : <GroupDesignSettings key={member.id} refreshVersion={version} dm={dmMode} scope={{kind:'project',botId:member.agentId,projectName:dmMode ? member.groupId : member.name}} tab={tab} tools={snapshot.tools} agent={agent} botName={agent.name} groupName={group.name} onOpenTools={onOpenTools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets} responseHeader={dmMode ? undefined : conversationControl}/>}
    <Dialog open={dialog === 'history'} title={<span className="conversation-dialog-title">对话记录</span>} description={`${group.name} · ${agent.name}`} onClose={() => setDialog(null)}><div id={settingAnchor("会话管理")}>{agent.running ? <ConversationPanel agentId={agent.id} groupId={group.id} projectName={member.name} conversation={conversation} request={client.collaboration}/> : <p>Bot 运行后可查看对话记录。</p>}</div></Dialog>
    <Dialog open={dialog === 'help'} title="在群里使用" onClose={() => setDialog(null)}><GroupUsage conversation={conversation} botName={agent.name}/></Dialog>
    <ConfirmDialog open={dialog === 'remove'} title="解除这个群的绑定？" confirmLabel="解除绑定" tone="danger" pending={busy} onCancel={() => setDialog(null)} onConfirm={() => {setDialog(null); void update({},true);}} description={`解除 ${agent.name} 与「${group.name}」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。${whereName(where)}上的目录和文件保留。`}/>
  </div>;
}
