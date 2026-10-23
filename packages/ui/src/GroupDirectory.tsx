import {Bot, ChevronRight, ChevronsDownUp, ChevronsUpDown, Search, X} from 'lucide-react';
import {backendLabel, type Agent, type DesktopSnapshot, type GroupId, type MembershipId} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
import './group-directory.css';

type Status = {label: string; tone: 'warning' | 'neutral' | 'success'};
export type GroupDirectoryState = {query: string; expanded: Record<string, boolean>};
type Props = {
  snapshot: DesktopSnapshot;
  state: GroupDirectoryState;
  onStateChange: (state: GroupDirectoryState) => void;
  statusFor: (agent: Agent) => Status;
  onMembership: (id: MembershipId) => void;
};

// Intent: find a group, expand its Bots, and configure the exact membership.
// Hierarchy: group names anchor a Finder-like outline; indented Bot rows are the actions.
// Palette/surfaces: existing macOS paper and graphite tokens; blue only for interaction.
// Depth: one inset white list, quiet group separators and connecting tree lines.
// Typography: 13px semibold groups, medium Bot names, 11px secondary metadata.
// Normal connection is silent; only exceptions appear beside the Bot name, with no status column.
// Spacing: 4px rhythm, 52px group rows, 44px Bot rows; secondary columns hide on narrow views.
export function GroupDirectory({snapshot, state, onStateChange, statusFor, onMembership}: Props) {
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const directory = snapshot.groups.map(group => ({group, members: snapshot.memberships.filter(member => member.groupId === group.id)}));
  const query = state.query.trim().toLocaleLowerCase();
  const visible = directory.filter(({group, members}) => !query || [group.name, ...members.flatMap(member => [agents.get(member.agentId)?.name ?? member.agentId, backendLabel(member.backend)])].some(text => text.toLocaleLowerCase().includes(query)));
  const initialGroup = directory.find(item => item.members.length > 1)?.group.id ?? directory[0]?.group.id;
  const isExpanded = (id: GroupId) => state.expanded[id] ?? (query ? true : id === initialGroup);
  const hasExpanded = visible.some(({group}) => isExpanded(group.id));
  const toggle = (id: GroupId, expanded = !isExpanded(id)) => onStateChange({...state, expanded: {...state.expanded, [id]: expanded}});
  const search = (value: string) => onStateChange({query: value, expanded: {}});
  const botCount = new Set(visible.flatMap(({members}) => members.map(member => member.agentId))).size;
  return <section className="group-directory" aria-label="群聊列表">
    <header className="group-directory-heading">
      <div><h1>群聊</h1><span>{snapshot.groups.length} 个群聊</span></div>
      {directory.length > 0 && <label className="group-directory-search"><Search size={14} aria-hidden="true"/>
        <input aria-label="搜索群聊或 Bot" placeholder="搜索群聊或 Bot" value={state.query} onChange={event => search(event.target.value)}/>
        {state.query && <button type="button" aria-label="清除群聊搜索" onClick={() => search('')}><X size={13}/></button>}
      </label>}
    </header>
    {directory.length > 0 && <div className="group-directory-surface">
      <div className="group-directory-columns" aria-hidden="true"><span>群聊与 Bot</span><span>Provider</span><span>会话方式</span></div>
      {visible.length ? <ul className="group-directory-list">
        {visible.map(({group, members}) => {
          const expanded = isExpanded(group.id);
          const listId = `group-directory-bots-${encodeURIComponent(group.id)}`;
          return <li className="group-directory-item" key={group.id}>
            <div className="group-directory-group-row">
              <button type="button" className="group-directory-identity" aria-expanded={expanded} aria-controls={listId} onClick={() => toggle(group.id)}
                onKeyDown={event => {if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault(); toggle(group.id, event.key === 'ArrowRight');}}}>
                <ChevronRight className="group-directory-disclosure" size={13} aria-hidden="true"/>
                <GroupAvatar group={group}/><span className="group-directory-name" title={group.name}>{group.name}</span>
                <span className="group-directory-count">{members.length} 个 Bot</span>
                <span className="group-directory-avatar-stack" aria-hidden="true">
                  {members.slice(0, 4).map(member => {const agent = agents.get(member.agentId); return agent ? <AgentAvatar key={member.id} agent={agent}/> : <span key={member.id} className="collaboration-avatar agent"><Bot size={12}/></span>;})}
                  {members.length > 4 && <span className="group-directory-overflow">+{members.length - 4}</span>}
                </span>
              </button>
            </div>
            <ul className="group-directory-bots" id={listId} aria-label={`${group.name}的 Bot`} hidden={!expanded}>
              {members.map(member => {
                const agent = agents.get(member.agentId);
                const status: Status = member.stale ? {label: '状态过期', tone: 'warning'} : agent ? statusFor(agent) : {label: 'Bot 暂不可用', tone: 'warning'};
                const provider = backendLabel(member.backend);
                const icon = member.backend === 'codex-appserver' ? './agent-icons/codex-light.png' : member.backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
                return <li key={member.id}><button type="button" className="group-directory-bot" aria-label={`设置 ${group.name} 中的 ${agent?.name ?? member.agentId}`} disabled={!agent} onClick={() => onMembership(member.id)}>
                  <span className="group-directory-bot-identity">{agent ? <AgentAvatar agent={agent}/> : <span className="collaboration-avatar agent"><Bot size={15}/></span>}<strong title={agent?.name ?? member.agentId}>{agent?.name ?? member.agentId}</strong>{status.tone !== 'success' && <span className="group-directory-status" data-tone={status.tone}>{status.label}</span>}</span>
                  <span className="group-directory-provider" title={provider === member.backend ? `${provider}（暂不支持修改）` : provider}>{icon && <img src={icon} alt=""/>}{provider === member.backend ? `${provider}（暂不支持修改）` : provider}</span>
                  <span className="group-directory-mode">{{threads: '多会话', shared: '单会话', smart: '智能'}[member.conversation]}</span>
                  <span className="group-directory-trailing"><ChevronRight size={13} aria-hidden="true"/></span>
                </button></li>;
              })}
              {!members.length && <li className="group-directory-no-bot">暂无 Bot</li>}
            </ul>
          </li>;
        })}
      </ul> : <div className="group-directory-empty">没有找到匹配的群聊或 Bot</div>}
      <footer className="group-directory-footer"><span>{visible.length} 个群聊<span aria-hidden="true"> · </span>{botCount} 个 Bot</span>
        <button type="button" disabled={!visible.length} onClick={() => onStateChange({...state, expanded: {...state.expanded, ...Object.fromEntries(visible.map(({group}) => [group.id, !hasExpanded]))}})}>
          {hasExpanded ? <ChevronsDownUp size={13}/> : <ChevronsUpDown size={13}/>}{hasExpanded ? '全部收起' : '全部展开'}
        </button>
      </footer>
    </div>}
  </section>;
}
