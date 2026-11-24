import {ArrowUpRight, Bot, ChevronRight, Search, X} from 'lucide-react';
import {backendLabel, type Agent, type DesktopSnapshot, type GroupId, type Membership, type MembershipId} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
import {JoinGroupButton} from './JoinGroupButton';
import './group-directory.css';

type Status = {label: string; tone: 'warning' | 'neutral' | 'success'};
export type GroupDirectoryState = {query: string; expanded: Record<string, boolean>};
type Props = {
  snapshot: DesktopSnapshot;
  state: GroupDirectoryState;
  onStateChange: (state: GroupDirectoryState) => void;
  statusFor: (agent: Agent) => Status;
  onMembership: (id: MembershipId) => void;
  onNewMemory?: (id: MembershipId) => void;
  onJoin: () => void;
  joinDisabled?: boolean;
  newCounts?: Readonly<Record<string, number>>;
};

// Keep the group → Bot tree and its membership navigation. The sticky toolbar keeps search
// and the join entry reachable; each group retains its own expansion control.
// Existing canvas/surface tokens, 13px names and 11px metadata preserve the compact Mac layout.
// Only groups with no available Bot are muted; partially available groups retain their name contrast.
export function GroupDirectory({snapshot, state, onStateChange, statusFor, onMembership, onNewMemory, onJoin, joinDisabled, newCounts}: Props) {
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const directory = snapshot.groups.map(group => ({group, members: snapshot.memberships.filter(member => member.groupId === group.id)}));
  const query = state.query.trim().toLocaleLowerCase();
  const visible = directory.filter(({group, members}) => !query || [group.name, ...members.flatMap(member => [agents.get(member.agentId)?.name ?? member.agentId, backendLabel(member.backend)])].some(text => text.toLocaleLowerCase().includes(query)));
  const initialGroup = directory.find(item => item.members.length > 1)?.group.id ?? directory[0]?.group.id;
  const isExpanded = (id: GroupId) => state.expanded[id] ?? (query ? true : id === initialGroup);
  const toggle = (id: GroupId, expanded = !isExpanded(id)) => onStateChange({...state, expanded: {...state.expanded, [id]: expanded}});
  const search = (value: string) => onStateChange({query: value, expanded: {}});
  const botCount = new Set(visible.flatMap(({members}) => members.map(member => member.agentId))).size;
  const memberStatus = (member: Membership): Status => {
    const agent = agents.get(member.agentId);
    if (member.stale) return {label: '状态过期', tone: 'warning'};
    if (member.enabled === false) return {label: '本群已停用', tone: 'neutral'};
    if (!agent) return {label: 'Bot 暂不可用', tone: 'warning'};
    const status = statusFor(agent);
    return status.label === '已停用' ? {...status, label: 'Bot 已停用'} : status;
  };
  return <section className="group-directory group-directory--groups" aria-label="群组列表">
    <header className="group-directory-heading">
      <div><h1>群组</h1><span>{query ? `${visible.length} / ${snapshot.groups.length}` : snapshot.groups.length} 个群聊 · {botCount} 个 Bot</span></div>
      {directory.length > 0 && <label className="group-directory-search"><Search size={14} aria-hidden="true"/>
        <input aria-label="搜索群聊或 Bot" placeholder="搜索群聊或 Bot" value={state.query} onChange={event => search(event.target.value)}/>
        {state.query && <button type="button" aria-label="清除群聊搜索" onClick={() => search('')}><X size={13}/></button>}
      </label>}
      <JoinGroupButton disabled={joinDisabled} onClick={onJoin}/>
    </header>
    {directory.length > 0 && <div className="group-directory-surface">
      {visible.length ? <ul className="group-directory-list">
        {visible.map(({group, members}) => {
          const expanded = isExpanded(group.id);
          const exceptions = members.map(memberStatus).filter(status => status.tone !== 'success');
          const unavailable = members.length > 0 && exceptions.length === members.length;
          const labels = [...new Set(exceptions.map(status => status.label))];
          const summary = !exceptions.length ? undefined : labels.length === 1 && unavailable ? labels[0] : `${exceptions.length} 个 Bot 不可用`;
          const summaryTone = exceptions.some(status => status.tone === 'warning') ? 'warning' : 'neutral';
          const newCount = [...new Set(members.flatMap(member => member.projectId ?? []))].reduce((sum, id) => sum + (newCounts?.[id] ?? 0), 0);
          const freshMember = members.find(member => member.projectId && (newCounts?.[member.projectId] ?? 0) > 0 && agents.has(member.agentId));
          const listId = `group-directory-bots-${encodeURIComponent(group.id)}`;
          return <li className="group-directory-item" data-unavailable={unavailable || undefined} key={group.id}>
            <div className="group-directory-group-row">
              <button type="button" className="group-directory-identity" aria-expanded={expanded} aria-controls={listId} onClick={() => toggle(group.id)}
                onKeyDown={event => {if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault(); toggle(group.id, event.key === 'ArrowRight');}}}>
                <ChevronRight className="group-directory-disclosure" size={13} aria-hidden="true"/>
                <GroupAvatar group={group}/><span className="group-directory-name" title={group.name}>{group.name}</span>
                <span className="group-directory-count">{members.length} 个 Bot</span>
                {summary && <span className="group-directory-summary" data-tone={summaryTone}>{summary}</span>}
                {!expanded && <span className="group-directory-avatar-stack" aria-hidden="true">
                  {members.slice(0, 4).map(member => {const agent = agents.get(member.agentId); return agent ? <AgentAvatar key={member.id} agent={agent}/> : <span key={member.id} className="collaboration-avatar agent"><Bot size={12}/></span>;})}
                  {members.length > 4 && <span className="group-directory-overflow">+{members.length - 4}</span>}
                </span>}
              </button>
              {freshMember && newCount > 0 && onNewMemory && <button type="button" className="group-directory-new-memory" onClick={() => onNewMemory(freshMember.id)} aria-label={`查看 ${group.name} 中的 ${newCount} 条新记忆`}>{newCount} 条新记忆<ArrowUpRight size={13} aria-hidden="true"/></button>}
            </div>
            <ul className="group-directory-bots" id={listId} aria-label={`${group.name}的 Bot`} hidden={!expanded}>
              {members.map(member => {
                const agent = agents.get(member.agentId);
                const status = memberStatus(member);
                const provider = backendLabel(member.backend);
                const icon = member.backend === 'codex-appserver' ? './agent-icons/codex-light.png' : member.backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
                return <li key={member.id}><button type="button" className="group-directory-bot" data-unavailable={status.tone !== 'success' || undefined} aria-label={`设置 ${group.name} 中的 ${agent?.name ?? member.agentId}`} disabled={!agent} onClick={() => onMembership(member.id)}>
                  <span className="group-directory-bot-identity">{agent ? <AgentAvatar agent={agent}/> : <span className="collaboration-avatar agent"><Bot size={15}/></span>}<strong title={agent?.name ?? member.agentId}>{agent?.name ?? member.agentId}</strong>{status.tone !== 'success' && <span className="group-directory-status" data-tone={status.tone}>{status.label}</span>}</span>
                  <span className="group-directory-provider" title={provider === member.backend ? `${provider}（暂不支持修改）` : provider}>{icon && <img src={icon} alt=""/>}{provider === member.backend ? `${provider}（暂不支持修改）` : provider}</span>
                  <span className="group-directory-mode">{{threads: '独立话题', shared: '连续交谈', smart: '智能'}[member.conversation]}</span>
                  <span className="group-directory-trailing"><ChevronRight size={13} aria-hidden="true"/></span>
                </button></li>;
              })}
              {!members.length && <li className="group-directory-no-bot">暂无 Bot</li>}
            </ul>
          </li>;
        })}
      </ul> : <div className="group-directory-empty">没有找到匹配的群聊或 Bot</div>}
    </div>}
  </section>;
}
