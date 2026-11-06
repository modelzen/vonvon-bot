import {ChevronRight} from 'lucide-react';
import {backendLabel, type Agent, type DesktopSnapshot, type Membership, type MembershipId} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
import {JoinGroupButton} from './JoinGroupButton';
import {newTag} from './new-counts';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import './bot-group-list.css';

type Status = {label: string; tone: 'warning' | 'neutral' | 'success'};
type Props = {
  snapshot: DesktopSnapshot;
  agent: Agent;
  busy: boolean;
  status: Status;
  onJoin: () => void;
  onMembership: (id: MembershipId) => void;
  onDm: () => void;
  /** New entries in the private chats' memory. */
  dmNew?: number;
};

const modeOf = (member: Membership) => ({threads: '独立话题', shared: '连续交谈', smart: '智能'}[member.conversation]);

const providerOf = (backend: string) => {
  const label = backendLabel(backend);
  return {
    provider: label === backend ? `${label}（暂不支持修改）` : label,
    icon: backend === 'codex-appserver' ? './agent-icons/codex-light.png' : backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined,
  };
};

/** A row's exception beside its name: only what is wrong with this row, for a group or the private chat alike. */
function rowStatusOf(member: Membership, status: Status, disabled: string): Status {
  return member.stale ? {label: '状态过期', tone: 'warning'}
    : member.enabled === false ? {label: disabled, tone: 'neutral'}
    : status.label === '已停用' ? {...status, label: 'Bot 已停用'} : status;
}

/** A private chat is named after who is on the other side, as Feishu shows it, and carries that Bot's face. */
export const dmTitle = (agent: Pick<Agent, 'name'>): string => `和 ${agent.name} 的私聊`;

/** The private chat's settings metadata; older daemons may omit it. It counts as no group. */
export function dmRowOf(agent: Agent, status: Status) {
  if (!agent.dm) return undefined;
  const {provider, icon} = providerOf(agent.dm.backend);
  const rowStatus: Status = agent.dmError ? {label: '暂不可用', tone: 'warning'} : rowStatusOf(agent.dm, status, '私聊已停用');
  return {provider, icon, tone: rowStatus.tone, exception: rowStatus.tone !== 'success' ? rowStatus.label : undefined};
}

// Intent: find a group and compare this Bot's Provider and communication mode.
// Hierarchy: 13px semibold group names, 12px secondary metadata, exceptions beside names.
// Palette/depth/surfaces: existing graphite text and semantic colors on one SettingsGroup.
// Spacing: 54px rows with aligned metadata; narrow windows move metadata to a second line.
// No column heading: the owner approved the compact list without a table header.
export function BotGroupList({snapshot, agent, busy, status, onJoin, onMembership, onDm, dmNew}: Props) {
  const members = snapshot.memberships.filter(member => member.agentId === agent.id);
  const groups = new Map(snapshot.groups.map(group => [group.id, group]));
  const dm = dmRowOf(agent, status);
  const dmMode = agent.dm && modeOf(agent.dm);
  const dmRow = agent.dmError ? <div className="bot-group-list__row bot-group-list__row--failed" data-unavailable role="status">
    <span className="bot-group-list__identity">
      <AgentAvatar agent={agent}/><strong title={dmTitle(agent)}>{dmTitle(agent)}</strong>
      <span className="bot-group-list__status" data-tone="warning">暂不可用</span>
    </span>
    <p className="bot-group-list__error">{agent.dmError}</p>
  </div> : dm && agent.dm && <button
    type="button"
    className="bot-group-list__row"
    data-unavailable={dm.tone !== 'success' || undefined}
    aria-label={`设置 ${agent.name} 的私聊，Provider：${dm.provider}，沟通方式：${dmMode}${dm.exception ? `，${dm.exception}` : ''}`}
    onClick={onDm}
  >
    <span className="bot-group-list__identity">
      <AgentAvatar agent={agent}/><strong title={dmTitle(agent)}>{dmTitle(agent)}</strong>
      {dm.exception && <span className="bot-group-list__status" data-tone={dm.tone}>{dm.exception}</span>}
      {newTag(dmNew) && <span className="bot-group-list__status" data-tone="neutral">{newTag(dmNew)}</span>}
    </span>
    <span className="bot-group-list__provider" title={dm.provider}>{dm.icon && <img src={dm.icon} alt=""/>}<span>{dm.provider}</span></span>
    <span className="bot-group-list__mode">{dmMode}</span>
    <ChevronRight className="bot-group-list__chevron" size={14} aria-hidden="true"/>
  </button>;
  return <SettingsGroup
    className="bot-group-list"
    label={<><span>{dmRow ? '私聊和飞书群' : '已加入的飞书群'}</span><span className="bot-group-list__count">{members.length}</span></>}
    action={<JoinGroupButton disabled={busy || !agent.enabled || Boolean(agent.readError)} onClick={onJoin}/>}
    footer={members.length ? dm && !agent.dmError ? '点开调整这个 Bot 在私聊或群里的设置。' : '点击群聊，调整这个 Bot 在该群中的设置。' : undefined}
  >
    {members.length ? <div className="bot-group-list__rows">
      {dmRow}
      {members.map(member => {
        const group = groups.get(member.groupId);
        if (!group) return null;
        const {provider, icon} = providerOf(member.backend);
        const mode = modeOf(member);
        const rowStatus = rowStatusOf(member, status, '本群已停用');
        const exception = rowStatus.tone !== 'success' ? rowStatus.label : undefined;
        return <button
          type="button"
          className="bot-group-list__row"
          data-unavailable={rowStatus.tone !== 'success' || undefined}
          key={member.id}
          aria-label={`设置 ${agent.name} 在 ${group.name} 中的行为，Provider：${provider}，沟通方式：${mode}${exception ? `，${exception}` : ''}`}
          onClick={() => onMembership(member.id)}
        >
          <span className="bot-group-list__identity">
            <GroupAvatar group={group}/><strong title={group.name}>{group.name}</strong>
            {exception && <span className="bot-group-list__status" data-tone={rowStatus.tone}>{exception}</span>}
          </span>
          <span className="bot-group-list__provider" title={provider}>{icon && <img src={icon} alt=""/>}<span>{provider}</span></span>
          <span className="bot-group-list__mode">{mode}</span>
          <ChevronRight className="bot-group-list__chevron" size={14} aria-hidden="true"/>
        </button>;
      })}
    </div> : <>
      {dmRow && <div className="bot-group-list__rows">{dmRow}</div>}
      <SettingsRow title={agent.readError ? '群配置读取失败' : '尚未绑定飞书群'}/>
    </>}
  </SettingsGroup>;
}
