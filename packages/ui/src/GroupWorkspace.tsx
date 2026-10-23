import {useEffect, useRef, useState} from 'react';
import {ArrowUpRight, Check, MoreHorizontal} from 'lucide-react';
import {modeToConversation, type Agent, type Conversation, type DesktopSnapshot, type Group, type Membership, type ProjectRecord} from '@vonvon/protocol';
import {useClient, useShellCapabilities} from './client-context';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
import {GroupUsage} from './GroupUsage';
import {settingAnchor} from './search';
import {Button, InlineNotice, Toggle} from './reference/components/ui';
import {Dialog, ConfirmDialog} from './reference/components/ui/Dialog';
import {SettingChoices} from './settings/SettingChoices';
import {GroupDesignSettings} from './settings/GroupDesignSettings';
import {useDraftGuard} from './settings/DraftGuard';
import {ConversationPanel} from './management/ConversationPanel';
import {GroupAttentionStatus} from './management/GroupAttentionStatus';
import {appliedNotice, removalNotice} from './management/ProjectPanel';
import {groupUrl, openExternalUrl} from './url-actions';
import './group-workspace.css';

export type GroupDesignTab = 'capabilities' | 'profile' | 'model' | 'workspace' | 'response';
export const groupDesignTabs: readonly [GroupDesignTab, string][] = [['capabilities','能力'],['profile','个性与记忆'],['model','模型'],['workspace','工作区'],['response','回复规则']];
export function groupTabForSection(section?: string): GroupDesignTab {
  switch (section) {
    case '个性与记忆': return 'profile';
    case '可用模型': return 'model';
    case '工作区':
    case '工作目录权限': return 'workspace';
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
  onBot: (member: Membership) => void; onBotProfile: () => void; onOpenTools: () => void; onOpenProviders?: () => void; onOpenSecrets: () => void; onChanged: () => Promise<void>};
// Intent: configure one Bot within one group, without exposing session management as navigation.
// Hierarchy: target first, five established pages second. Quiet inset surfaces and system type
// share Today's 4px spacing rhythm; history/help remain contextual actions in the toolbar.
export function GroupWorkspace({member, agent, group, snapshot, initialTab, revealHistory, onTabChange, onBot, onBotProfile, onOpenTools, onOpenProviders, onOpenSecrets, onChanged}: Props) {
  const client = useClient();
  const shell = useShellCapabilities();
  const guard = useDraftGuard();
  const [tab, setTab] = useState<GroupDesignTab>(initialTab ?? 'capabilities');
  const [project, setProject] = useState<ProjectRecord>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const running = useRef(agent.running);
  running.current = agent.running;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'help'|'history'|'remove'|'smart'|null>(null);
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
  useEffect(() => {if (initialTab) setTab(initialTab);}, [initialTab]);
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
  async function update(change: {enabled?: boolean; conversation?: Conversation}, remove = false) {
    if (!project || saving.current || !running.current) return false;
    saving.current = true; setBusy(true); setError(''); setNotice('');
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
    finally {saving.current = false; setBusy(false);}
  }
  const available = agent.running && !!project && !member.stale;
  const conversation = project ? modeToConversation(project.kind) : member.conversation;
  const conversationControl = <div className="group-conversation-layout"><section id={settingAnchor("聊天方式")} className="group-conversation-choice" aria-label="聊天方式">
    <h3>聊天方式</h3><SettingChoices label="聊天方式" value={conversation} disabled={!available || busy} choices={[{value:'threads',label:'多会话'},{value:'shared',label:'单会话'},{value:'smart',label:'智能'}]} onChange={next => guard.navigate(() => {if (next === 'smart' && conversation !== 'smart') setDialog('smart'); else void update({conversation:next});})}/>
    <p className="group-control-note">{conversation === 'smart' ? '按回复规则接话，并判断是否另开话题。' : conversation === 'threads' ? '主区 @ Bot 开启新话题，每个话题独立对话。' : '全群共用一段对话。'}</p>
  </section>{conversation === 'smart' && member.conversation === 'smart' && <GroupAttentionStatus agent={agent} membership={member} connected={snapshot.host.kind === 'connected' && !snapshot.stale}/>}</div>;
  return <div className="group-design-workspace">
    <header className="group-design-heading"><GroupAvatar group={group} large/><h2>{group.name}</h2><Button size="sm" className="group-open-button" aria-label="在飞书打开此群" onClick={() => void openExternalUrl(groupUrl(group.id),'group',shell).catch(error => setError(String(error.message ?? error)))}><span className="group-open-label">飞书</span><ArrowUpRight size={13} aria-hidden="true"/></Button>
      <details ref={menu} className="group-context-menu"><summary aria-label="群操作"><MoreHorizontal size={18}/></summary><div>{([['help','使用说明'],['history','对话记录'],['remove','解除群绑定…']] as const).map(([action,label]) => <button type="button" key={action} disabled={action === 'remove' && !available} onClick={event => {event.currentTarget.closest('details')?.removeAttribute('open'); guard.navigate(() => setDialog(action));}}>{label}</button>)}</div></details>
    </header>
    <div id={settingAnchor("群设置")} className="group-design-context"><div role="group" aria-label="本群 Bot" className="group-bot-picker">{snapshot.memberships.filter(item => item.groupId === group.id).map(item => {const bot = snapshot.agents.find(bot => bot.id === item.agentId); return bot && <button type="button" key={item.id} aria-pressed={member.id === item.id} title={bot.name} onClick={() => guard.navigate(() => onBot(item))}><AgentAvatar agent={bot}/><span>{bot.name}</span>{member.id === item.id && <Check size={12}/>}</button>;})}</div>
      {project ? <Toggle aria-label={`在本群使用 ${agent.name}`} label="在本群使用" checked={project.enabled} disabled={!available || busy} onChange={event => {const enabled=event.target.checked; guard.navigate(() => {void update({enabled});});}}/> : <span className="group-control-note">{!agent.enabled ? 'Bot 已停用' : !agent.running ? 'Bot 未运行' : '读取中…'}</span>}
    </div>
    <nav className="group-design-tabs" aria-label="群设置">{groupDesignTabs.map(([value,label]) => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => guard.navigate(() => {setTab(value); onTabChange?.(value);})}>{label}</button>)}</nav>
    {error && <InlineNotice title="操作未完成" tone="warning">{error}</InlineNotice>}
    {notice && <p role="status" className="group-control-note">{notice}</p>}
    <GroupDesignSettings key={`${member.id}:${version}`} scope={{kind:'project',botId:member.agentId,projectName:member.name}} tab={tab} tools={snapshot.tools} botName={agent.name} groupName={group.name} onOpenTools={onOpenTools} onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets} responseHeader={conversationControl}/>
    <Dialog open={dialog === 'history'} title={`${group.name} · ${agent.name}`} onClose={() => setDialog(null)}><div id={settingAnchor("会话管理")}>{agent.running ? <ConversationPanel agentId={agent.id} groupId={group.id} projectName={member.name} conversation={conversation} request={client.collaboration}/> : <p>Bot 运行后可查看对话记录。</p>}</div></Dialog>
    <Dialog open={dialog === 'help'} title="在群里使用" onClose={() => setDialog(null)}><GroupUsage conversation={conversation} botName={agent.name}/></Dialog>
    <Dialog open={dialog === 'smart'} title="设置智能模式" onClose={() => guard.navigate(() => setDialog(null))}>
      <p className="group-control-note">选择用于判断回复时机的模型。</p>
      {dialog === 'smart' && <GroupDesignSettings scope={{kind:'project',botId:member.agentId,projectName:member.name}} tab="response" tools={snapshot.tools} decisionSetupOnly onOpenProviders={onOpenProviders} onOpenSecrets={onOpenSecrets} onDecisionSaved={async () => {if (await update({conversation:'smart'})) setDialog(null); else throw new Error('决策模型已保存，未能切换聊天方式，请重试。');}}/>}
    </Dialog>
    <ConfirmDialog open={dialog === 'remove'} title="解除这个群的绑定？" confirmLabel="解除绑定" tone="danger" pending={busy} onCancel={() => setDialog(null)} onConfirm={() => {setDialog(null); void update({},true);}} description={`解除 ${agent.name} 与「${group.name}」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。本地目录和文件保留。`}/>
  </div>;
}
