import {useEffect, useState} from 'react';
import {BadgeRack, NowBotBadge} from './NowBotBadge';
import {BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS, type Agent, type BotActivity, type BotLatestAction, type DesktopSnapshot, type Membership} from '@vonvon/protocol';
import {GroupAvatar} from './GroupAvatar';
import {GlowButton} from './GlowButton';
import {nowGroupAttention} from './now-attention';
import {badgeTenure} from './badge-content';
import type {BadgeJoinedGroup} from './useBadgeJoinedGroups';
import './now-bots.css';

export function nowBotActivities(agent: Agent, members: readonly Membership[], live: boolean, now: number): BotActivity[] {
  if (!live || !agent.enabled || !agent.running || agent.connection !== 'connected' || agent.readError) return [];
  return (agent.diagnostics?.activities ?? []).filter(item => now - (item.observedAt ?? item.updatedAt) < BOT_ACTIVITY_STALE_MS
    && members.some(member => member.agentId === agent.id && member.groupId === item.groupId && member.enabled === true && !member.stale))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function nowBotLatestAction(agent: Agent, members: readonly Membership[], live: boolean, now: number): BotLatestAction | undefined {
  const action = agent.diagnostics?.latestAction;
  if (!action || !live || !agent.enabled || !agent.running || agent.connection !== 'connected' || agent.readError || now - action.at >= BOT_LATEST_ACTION_SHOWN_MS) return undefined;
  return members.some(member => member.agentId === agent.id && member.groupId === action.groupId && member.enabled === true && !member.stale) ? action : undefined;
}

export function NowBotList({snapshot, connected, onRegister, disabled, onChangeNumber, joinedGroups}: {
  snapshot: DesktopSnapshot; connected: boolean; onRegister: () => void; disabled: boolean;
  onChangeNumber: (agentId: Agent['id'], value: string) => Promise<string | undefined>;
  joinedGroups: ReadonlyMap<Agent['id'], readonly BadgeJoinedGroup[]>;
}) {
  const [, tick] = useState(0);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const live = connected && !snapshot.stale && snapshot.host.kind === 'connected';
  const now = Date.now();
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {setMotionAllowed(!reduced.matches && !document.hidden); tick(value => value + 1);};
    update();
    reduced.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {reduced.removeEventListener('change', update); document.removeEventListener('visibilitychange', update);};
  }, []);
  // A delayed snapshot must not keep an expired budget or stopped activity
  // looking live. Schedule only the next deadline, rather than polling the UI.
  useEffect(() => {
    const current = Date.now();
    const midnight = new Date(current); midnight.setHours(24,0,0,0);
    const deadlines = snapshot.agents.flatMap(agent => [
      ...(agent.diagnostics?.attention ?? []).flatMap(group => group.budget ? [group.budget.until] : []),
    ]).filter(deadline => deadline > current);
    const next=live ? Math.min(midnight.getTime(),...deadlines) : midnight.getTime();
    const timer = window.setTimeout(() => tick(value => value + 1), next - current + 1);
    return () => window.clearTimeout(timer);
  }, [snapshot, live, now]);
  return <section className="today-home-section now-bot-list" aria-label="你的 Bot">
    <header><h2>你的 Bot</h2><GlowButton disabled={disabled} onClick={onRegister}>添加 Bot</GlowButton></header>
      {snapshot.agents.length ? <BadgeRack>{snapshot.agents.map((agent, index) => {
        const bindings = new Map(snapshot.memberships.filter(member => member.agentId === agent.id).map(member => [member.groupId, member]));
        const joined = joinedGroups.get(agent.id);
        const groups = joined ?? Array.from(bindings.values(), member => ({id: member.groupId, name: member.name, bound: true}));
        const groupSummary = joined ? `已加入 ${joined.length} 个群` : bindings.size ? `已绑定 ${bindings.size} 个群` : '群数待更新';
        const available = live && agent.enabled && agent.running && agent.connection === 'connected' && !agent.readError;
        const connectionStatus=agent.readError?'配置读取失败':!agent.enabled?'已停用':!live?(snapshot.stale?'待更新':'已断开'):!agent.running?'未运行':available?'已连接':agent.connection==='reconnecting'?'重连中':'未连接';
        return <NowBotBadge key={agent.id} agent={agent} index={index} groupSummary={groupSummary}
          status={connectionStatus} tone={available ? 'online' : 'offline'}
          ownerName={agent.ownerName} tenure={badgeTenure(agent.registeredAt, now)}
          jobNumber={agent.badgeNumber} editable={live && !disabled && !!agent.badgeNumber}
          onJobChange={value => onChangeNumber(agent.id, value)}
          showMotion={motionAllowed}>
            {groups.map(group => {
              const binding = bindings.get(group.id);
              const avatarDataUrl = snapshot.groups.find(item => item.id === group.id)?.avatarDataUrl ?? binding?.avatarDataUrl;
              const reading = binding && group.bound ? nowGroupAttention(agent, binding, connected, snapshot.stale, now) : undefined;
              return <li key={group.id}>
                <details className="badge-group-row">
                  <summary><GroupAvatar group={{...group, avatarDataUrl}}/><span>{group.name}</span></summary>
                  <div className="badge-group-status">
                    {reading?.showMeter && <span className="now-attention-meter" data-unknown={reading.level === undefined} aria-hidden="true">
                      {[1, 2, 3, 4].map(level => <i key={level} data-on={reading.level !== undefined && level <= reading.level}/>)}
                    </span>}
                    <span>{reading?.label ?? (group.bound ? '待更新' : '未绑定')}</span>
                  </div>
                </details>
              </li>;
            })}
            {!groups.length && <li className="badge-no-groups">{joined ? '还没有加入群聊' : '群列表待更新'}</li>}
        </NowBotBadge>;
      })}</BadgeRack> : <p className="now-bot-empty">添加 Bot，在飞书里开始交流。</p>}
  </section>;
}
