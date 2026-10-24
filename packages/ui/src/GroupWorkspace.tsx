import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Check, MoreHorizontal} from 'lucide-react';
import {modeToConversation, type Agent, type Conversation, type DesktopSnapshot, type Group, type Membership, type ProjectId, type ProjectRecord} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from './client-context';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
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
import './group-workspace.css';

export type GroupDesignTab = GroupSettingsTab | 'memory';
export const groupDesignTabs: readonly [GroupDesignTab, string][] = [['model','模型与权限'],['capabilities','能力'],['response','沟通方式'],['memory','记忆']];
export function groupTabForSection(section?: string): GroupDesignTab {
  switch (section) {
    case '记忆':
    case '项目记忆': return 'memory';
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
    case '运行中来了消息':
    case '响应成员':
    case '消息与提醒': return 'response';
    default: return 'capabilities';
  }
}

type Props = {member: Membership; agent: Agent; group: Group; snapshot: DesktopSnapshot; initialTab?: GroupDesignTab; revealHistory?: boolean; onTabChange?: (tab:GroupDesignTab) => void;
  onBot: (member: Membership) => void; onBotProfile: () => void; onProject?: (id: ProjectId) => void; onOpenTools: () => void; onOpenProviders?: () => void; onOpenSecrets: (provider?: string) => void; onChanged: () => Promise<void>};
// Intent: configure one Bot within one group, without exposing session management as navigation.
// Hierarchy: target first, Bot/project scope next, then compact settings pages. System type
// share Today's 4px spacing rhythm; history/help remain contextual actions in the toolbar.
export function GroupWorkspace({member, agent, group, snapshot, initialTab, revealHistory, onTabChange, onBot, onBotProfile, onProject, onOpenTools, onOpenProviders, onOpenSecrets, onChanged}: Props) {
  const client = useClient();
  const shell = useShellCapabilities();
  const guard = useDraftGuard();
  const [tab, setTab] = useState<GroupDesignTab>(initialTab === 'role' ? 'memory' : initialTab === 'permission' ? 'model' : initialTab ?? 'model');
  const [project, setProject] = useState<ProjectRecord>();
  const [busy, setBusy] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const saving = useRef(false);
  const running = useRef(agent.running);
  running.current = agent.running;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'help'|'history'|'remove'|'project'|null>(null);
  const [nextProject, setNextProject] = useState('');
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
    if (!agent.running) return;
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
    finally {saving.current = false; setBusy(false); setPendingEnabled(null);}
  }
  const available = agent.running && !!project && !member.stale;
  const memberProject = snapshot.projects?.find(item => item.id === member.projectId);
  const otherProjects = (snapshot.projects ?? []).filter(item => item.id !== member.projectId);
  const conversation = project ? modeToConversation(project.kind) : member.conversation;
  const conversationControl = <div className="group-conversation-layout"><section id={settingAnchor("聊天方式")} className="group-conversation-choice" aria-label="聊天方式">
    <h3>聊天方式</h3><ConversationSlider label="聊天方式" value={conversation} disabled={!available || busy} onChange={next => guard.navigate(() => {void update({conversation:next});})}/>
  </section>{conversation === 'smart' && member.conversation === 'smart' && <GroupAttentionStatus agent={agent} membership={member} connected={snapshot.host.kind === 'connected' && !snapshot.stale}/>}</div>;
  return <div className="group-design-workspace">
    <header className="group-design-heading"><GroupAvatar group={group} large/><h2>{group.name}</h2><Button size="sm" className="group-open-button" aria-label="在飞书打开此群" onClick={() => void openExternalUrl(groupUrl(group.id),'group',shell).catch(error => setError(String(error.message ?? error)))}><span className="group-open-label">飞书</span><ArrowUpRight size={13} aria-hidden="true"/></Button>
      <details ref={menu} className="group-context-menu"><summary aria-label="群操作"><MoreHorizontal size={18}/></summary><div>{([['help','使用说明'],['history','对话记录'],['remove','解除群绑定…']] as const).map(([action,label]) => <button type="button" key={action} disabled={action === 'remove' && !available} onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); guard.navigate(() => setDialog(action));}}>{label}</button>)}</div></details>
    </header>
    <div className="group-design-scope"><div id={settingAnchor("群设置")} className="group-design-context"><div role="group" aria-label="本群 Bot" className="group-bot-picker">{snapshot.memberships.filter(item => item.groupId === group.id).map(item => {const bot = snapshot.agents.find(bot => bot.id === item.agentId); return bot && <button type="button" key={item.id} aria-pressed={member.id === item.id} title={bot.name} onClick={() => guard.navigate(() => onBot(item))}><AgentAvatar agent={bot}/><span>{bot.name}</span>{member.id === item.id && <Check size={12}/>}</button>;})}</div>
      {project ? <span className="group-enable-control">{pendingEnabled !== null && <OperationActivity key={`${member.id}:${pendingEnabled}`} label={pendingEnabled ? '本群启用中' : '本群停用中'} state={pendingEnabled ? 'connecting' : 'working'}/>}<Toggle aria-label={`在本群使用 ${agent.name}`} label="在本群使用" checked={project.enabled} disabled={!available || busy} onChange={event => {const enabled=event.target.checked; guard.navigate(() => {void update({enabled});});}}/></span> : <span className="group-control-note">{!agent.enabled ? 'Bot 已停用' : !agent.running ? 'Bot 未运行' : '读取中…'}</span>}
    </div>
    {memberProject && <p className="group-project-line" id={settingAnchor("所在项目")}>项目：<strong>{memberProject.name}</strong>
      {onProject && <button type="button" className="gd-text-action" onClick={() => guard.navigate(() => onProject(memberProject.id))}>项目页</button>}
      <button type="button" className="gd-text-action" disabled={!available || busy || !otherProjects.length} onClick={() => guard.navigate(() => {setNextProject(otherProjects[0]?.id ?? ''); setDialog('project');})}>换到别的项目…</button></p>}</div>
    <nav className="group-design-tabs" aria-label="群设置">{groupDesignTabs.map(([value,label]) => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => guard.navigate(() => {setTab(value); onTabChange?.(value);})}>{label}</button>)}</nav>
    {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
    {notice && <p role="status" className="group-control-note">{notice}</p>}
    {tab === 'memory' ? <section id={settingAnchor('记忆')} aria-label="记忆">
      {memberProject ? <ProjectMemoryMap key={memberProject.id} groupsInitiallyOpen={false} initialRoleMembershipId={initialTab === 'role' ? member.id : undefined} selectedAgentId={member.agentId} selectedGroupId={member.groupId} onBotProfile={() => guard.navigate(onBotProfile)} project={memberProject} snapshot={snapshot} onMembership={id => {const target = snapshot.memberships.find(item => item.id === id); if (target) guard.navigate(() => onBot(target));}}/> : <p className="group-control-note">这个群的项目记忆暂不可用。</p>}
    </section> : <GroupDesignSettings key={`${member.id}:${version}`} scope={{kind:'project',botId:member.agentId,projectName:member.name}} tab={tab} tools={snapshot.tools} botName={agent.name} groupName={group.name} onOpenTools={onOpenTools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets} responseHeader={conversationControl}/>}
    <Dialog open={dialog === 'history'} title={`${group.name} · ${agent.name}`} onClose={() => setDialog(null)}><div id={settingAnchor("会话管理")}>{agent.running ? <ConversationPanel agentId={agent.id} groupId={group.id} projectName={member.name} conversation={conversation} request={client.collaboration}/> : <p>Bot 运行后可查看对话记录。</p>}</div></Dialog>
    <Dialog open={dialog === 'help'} title="在群里使用" onClose={() => setDialog(null)}><GroupUsage conversation={conversation} botName={agent.name}/></Dialog>
    <ConfirmDialog open={dialog === 'project'} title="换到别的项目？" confirmLabel="换过去" pending={busy} onCancel={() => setDialog(null)} onConfirm={() => {setDialog(null); if (nextProject) void update({project: nextProject as ProjectId});}}
      description={`${agent.name} 在「${group.name}」里的记忆、工作区和会话都换成所选项目的，这个群现有的会话会归档，下一轮重新开场。原来的项目和它的记忆保留。所选项目的记忆、工作区文件和会话历史，现在和以后绑在这个项目上的群的人，都能通过 Bot 间接看到。`}>
      <label className="group-control-note">换到 <select aria-label="选择项目" value={nextProject} onChange={event => setNextProject(event.target.value)}>{otherProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    </ConfirmDialog>
    <ConfirmDialog open={dialog === 'remove'} title="解除这个群的绑定？" confirmLabel="解除绑定" tone="danger" pending={busy} onCancel={() => setDialog(null)} onConfirm={() => {setDialog(null); void update({},true);}} description={`解除 ${agent.name} 与「${group.name}」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。本地目录和文件保留。`}/>
  </div>;
}
