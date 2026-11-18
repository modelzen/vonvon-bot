import {Bot, ChevronRight, ChevronsDownUp, ChevronsUpDown, FolderKanban, Plus, Search, X} from 'lucide-react';
import {backendLabel, type Agent, type DesktopSnapshot, type Membership, type MembershipId, type ProjectId} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import './group-directory.css';

type Status = {label: string; tone: 'warning' | 'neutral' | 'success'};
export type ProjectDirectoryState = {query: string; expanded: Record<string, boolean>};
type Props = {
  snapshot: DesktopSnapshot;
  state: ProjectDirectoryState;
  onStateChange: (state: ProjectDirectoryState) => void;
  statusFor: (agent: Agent) => Status;
  onProject: (id: ProjectId) => void;
  onMembership: (id: MembershipId) => void;
  /** Adding a group is what makes a project; left out, no 新建项目 button. */
  onNewProject?: () => void;
  /** 新记忆 per project since its page was last opened (§5.8). */
  newCounts?: Readonly<Record<string, number>>;
};
/** Rows no project owns yet (bound since the last daemon start, or from an older daemon) sit under this key. */
const UNLINKED = 'unlinked';

type Entry = {key: string; id?: ProjectId; name: string; members: Membership[]; empty?: boolean};
/** Projects first as the library lists them, then the bindings no project owns. */
export function projectEntries(snapshot: DesktopSnapshot): Entry[] {
  const entries: Entry[] = (snapshot.projects ?? []).map(project => ({
    key: project.id, id: project.id, name: project.name,
    members: project.bindings.flatMap(binding => snapshot.memberships.find(member => member.agentId === binding.agentId && member.groupId === binding.groupId) ?? []),
    empty: project.bindings.length === 0,
  }));
  const unlinked = snapshot.memberships.filter(member => !member.projectId || !snapshot.projects?.some(project => project.id === member.projectId));
  return unlinked.length ? [...entries, {key: UNLINKED, name: '还没归入项目的群', members: unlinked}] : entries;
}

// Intent: find a project, see which groups and Bots share it, open the project or one binding.
// The list is the group directory's outline with the project as the parent row (owner leads the final visual pass).
export function ProjectDirectory({snapshot, state, onStateChange, statusFor, onProject, onMembership, onNewProject, newCounts}: Props) {
  const agents = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const groups = new Map(snapshot.groups.map(group => [group.id as string, group]));
  const directory = projectEntries(snapshot);
  const query = state.query.trim().toLocaleLowerCase();
  const nameOf = (member: Membership) => groups.get(member.groupId)?.name ?? member.name;
  const visible = directory.filter(entry => !query || [entry.name, ...entry.members.flatMap(member => [nameOf(member), agents.get(member.agentId)?.name ?? member.agentId, backendLabel(member.backend)])].some(text => text.toLocaleLowerCase().includes(query)));
  const initial = directory.find(entry => entry.members.length > 1)?.key ?? directory[0]?.key;
  const isExpanded = (key: string) => state.expanded[key] ?? (query ? true : key === initial);
  const hasExpanded = visible.some(entry => isExpanded(entry.key));
  const toggle = (key: string, expanded = !isExpanded(key)) => onStateChange({...state, expanded: {...state.expanded, [key]: expanded}});
  const search = (value: string) => onStateChange({query: value, expanded: {}});
  const groupCount = new Set(visible.flatMap(entry => entry.members.map(member => member.groupId))).size;
  return <section className="group-directory project-directory" aria-label="项目列表">
    <header className="group-directory-heading">
      <div><h1>项目</h1><span>{snapshot.projects?.length ?? 0} 个项目</span></div>
      {onNewProject && <button type="button" className="project-directory-new" onClick={onNewProject}><Plus size={13} aria-hidden="true"/>新建项目</button>}
      {directory.length > 0 && <label className="group-directory-search"><Search size={14} aria-hidden="true"/>
        <input aria-label="搜索项目、群或 Bot" placeholder="搜索项目、群或 Bot" value={state.query} onChange={event => search(event.target.value)}/>
        {state.query && <button type="button" aria-label="清除项目搜索" onClick={() => search('')}><X size={13}/></button>}
      </label>}
    </header>
    {directory.length > 0 && <div className="group-directory-surface">
      <div className="group-directory-columns" aria-hidden="true"><span>项目、群与 Bot</span><span>Provider</span><span>会话方式</span></div>
      {visible.length ? <ul className="group-directory-list">
        {visible.map(entry => {
          const expanded = isExpanded(entry.key);
          const listId = `project-directory-bindings-${encodeURIComponent(entry.key)}`;
          return <li className="group-directory-item" key={entry.key}>
            <div className="group-directory-group-row">
              <button type="button" className="group-directory-identity" aria-expanded={expanded} aria-controls={listId} onClick={() => toggle(entry.key)}
                onKeyDown={event => {if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault(); toggle(entry.key, event.key === 'ArrowRight');}}}>
                <ChevronRight className="group-directory-disclosure" size={13} aria-hidden="true"/>
                <span className="collaboration-avatar"><FolderKanban size={15} aria-hidden="true"/></span><span className="group-directory-name" title={entry.name}>{entry.name}</span>
                <span className="group-directory-count">{entry.empty ? '没有群' : `${new Set(entry.members.map(member => member.groupId)).size} 个群 · ${new Set(entry.members.map(member => member.agentId)).size} 个 Bot`}{entry.id && newCounts?.[entry.id] ? ` · 新 ${newCounts[entry.id]}` : ''}</span>
                <span className="group-directory-avatar-stack" aria-hidden="true">
                  {[...new Map(entry.members.map(member => [member.agentId, member])).values()].slice(0, 4).map(member => {const agent = agents.get(member.agentId); return agent ? <AgentAvatar key={member.agentId} agent={agent}/> : <span key={member.agentId} className="collaboration-avatar agent"><Bot size={12}/></span>;})}
                </span>
              </button>
              {entry.id && <button type="button" className="project-directory-open" aria-label={`打开项目 ${entry.name}`} onClick={() => onProject(entry.id!)}>项目页<ChevronRight size={13} aria-hidden="true"/></button>}
            </div>
            <ul className="group-directory-bots" id={listId} aria-label={`${entry.name}的群和 Bot`} hidden={!expanded}>
              {entry.members.map(member => {
                const agent = agents.get(member.agentId);
                const groupName = nameOf(member);
                const status: Status = member.stale ? {label: '状态过期', tone: 'warning'} : agent ? statusFor(agent) : {label: 'Bot 暂不可用', tone: 'warning'};
                const provider = backendLabel(member.backend);
                const icon = member.backend === 'codex-appserver' ? './agent-icons/terminal.png' : member.backend === 'claude-agent' ? './agent-icons/code.png' : undefined;
                return <li key={member.id}><button type="button" className="group-directory-bot" aria-label={`设置 ${groupName} 中的 ${agent?.name ?? member.agentId}`} disabled={!agent} onClick={() => onMembership(member.id)}>
                  <span className="group-directory-bot-identity">{agent ? <AgentAvatar agent={agent}/> : <span className="collaboration-avatar agent"><Bot size={15}/></span>}<strong title={`${groupName} · ${agent?.name ?? member.agentId}`}>{groupName} · {agent?.name ?? member.agentId}</strong>{status.tone !== 'success' && <span className="group-directory-status" data-tone={status.tone}>{status.label}</span>}</span>
                  <span className="group-directory-provider" title={provider === member.backend ? `${provider}（暂不支持修改）` : provider}>{icon && <img src={icon} alt=""/>}{provider === member.backend ? `${provider}（暂不支持修改）` : provider}</span>
                  <span className="group-directory-mode">{{threads: '多会话', shared: '单会话', smart: '智能'}[member.conversation]}</span>
                  <span className="group-directory-trailing"><ChevronRight size={13} aria-hidden="true"/></span>
                </button></li>;
              })}
              {!entry.members.length && <li className="group-directory-no-bot">没有群在用这个项目</li>}
            </ul>
          </li>;
        })}
      </ul> : <div className="group-directory-empty">没有找到匹配的项目、群或 Bot</div>}
      <footer className="group-directory-footer"><span>{visible.length} 个项目<span aria-hidden="true"> · </span>{groupCount} 个群</span>
        <button type="button" disabled={!visible.length} onClick={() => onStateChange({...state, expanded: {...state.expanded, ...Object.fromEntries(visible.map(entry => [entry.key, !hasExpanded]))}})}>
          {hasExpanded ? <ChevronsDownUp size={13}/> : <ChevronsUpDown size={13}/>}{hasExpanded ? '全部收起' : '全部展开'}
        </button>
      </footer>
    </div>}
  </section>;
}
