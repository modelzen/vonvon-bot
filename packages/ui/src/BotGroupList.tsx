import {ChevronRight} from 'lucide-react';
import {backendLabel, type Agent, type DesktopSnapshot, type MembershipId} from '@vonvon/protocol';
import {GroupAvatar} from './GroupAvatar';
import {JoinGroupButtonCandidates} from './JoinGroupButton';
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
};

// Intent: find a group and compare this Bot's Provider and communication mode.
// Hierarchy: 13px semibold group names, 12px secondary metadata, exceptions beside names.
// Palette/depth/surfaces: existing graphite text and semantic colors on one SettingsGroup.
// Spacing: 54px rows with aligned metadata; narrow windows move metadata to a second line.
// No column heading: the owner approved the compact list without a table header.
export function BotGroupList({snapshot, agent, busy, status, onJoin, onMembership}: Props) {
  const members = snapshot.memberships.filter(member => member.agentId === agent.id);
  const groups = new Map(snapshot.groups.map(group => [group.id, group]));
  return <SettingsGroup
    className="bot-group-list"
    label={<><span>已加入的飞书群</span><span className="bot-group-list__count">{members.length}</span></>}
    footer={members.length ? '点击群聊，调整这个 Bot 在该群中的设置。' : undefined}
  >
    <JoinGroupButtonCandidates disabled={busy || !agent.enabled || Boolean(agent.readError)} onClick={onJoin}/>
    {members.length ? <div className="bot-group-list__rows">
      {members.map(member => {
        const group = groups.get(member.groupId);
        if (!group) return null;
        const label = backendLabel(member.backend);
        const provider = label === member.backend ? `${label}（暂不支持修改）` : label;
        const icon = member.backend === 'codex-appserver' ? './agent-icons/codex-light.png'
          : member.backend === 'claude-agent' ? './agent-icons/claude-code.svg' : undefined;
        const mode = {threads: '独立话题', shared: '连续交谈', smart: '智能'}[member.conversation];
        const rowStatus: Status = member.stale ? {label: '状态过期', tone: 'warning'}
          : member.enabled === false ? {label: '本群已停用', tone: 'neutral'}
          : status.label === '已停用' ? {...status, label: 'Bot 已停用'} : status;
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
    </div> : <SettingsRow title={agent.readError ? '群配置读取失败' : '尚未绑定飞书群'}/>}
  </SettingsGroup>;
}
