import {useEffect, useState} from 'react';
import {BadgeRack, NowBotBadge} from './NowBotBadge';
import {BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS, type Agent, type BotActivity, type BotLatestAction, type DesktopSnapshot, type Group, type Membership} from '@vonvon/protocol';
import {GroupAvatar} from './GroupAvatar';
import {BadgeName} from './BadgeName';
import {GlowButton} from './GlowButton';
import {nowGroupAttention} from './now-attention';
import {badgeTenure} from './badge-content';
import './now-bots.css';

function BadgeGroupSummary({group, motion}: {group: Group; motion: boolean}) {
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const active = hovered || keyboardFocused;
  return <summary data-read-name={active || undefined}
    onPointerEnter={event => setHovered(event.pointerType !== 'touch')}
    onPointerLeave={() => setHovered(false)}
    onPointerDown={() => setKeyboardFocused(false)}
    onFocus={event => setKeyboardFocused(event.currentTarget.matches(':focus-visible'))}
    onBlur={() => setKeyboardFocused(false)}>
    <GroupAvatar group={group}/>
    <BadgeName text={group.name} active={active} motion={motion} tooltip={!motion}/>
  </summary>;
}

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

export function NowBotList({snapshot, connected, onRegister, disabled, onChangeNumber}: {
  snapshot: DesktopSnapshot; connected: boolean; onRegister: () => void; disabled: boolean;
  onChangeNumber: (agentId: Agent['id'], value: string) => Promise<string | undefined>;
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
        const bindings = [...new Map(snapshot.memberships.filter(member => member.agentId === agent.id).map(member => [member.groupId, member])).values()];
        const groupSummary = `已加入 ${bindings.length} 个群`;
        const available = live && agent.enabled && agent.running && agent.connection === 'connected' && !agent.readError;
        const connectionStatus=agent.readError?'配置读取失败':!agent.enabled?'已停用':!live?(snapshot.stale?'待更新':'已断开'):!agent.running?'未运行':available?'已连接':agent.connection==='reconnecting'?'重连中':'未连接';
        return <NowBotBadge key={agent.id} agent={agent} index={index} groupSummary={groupSummary}
          status={connectionStatus} tone={available ? 'online' : 'offline'}
          ownerName={agent.ownerName} tenure={badgeTenure(agent.registeredAt, now)}
          jobNumber={agent.badgeNumber} editable={live && !disabled && !!agent.badgeNumber}
          onJobChange={value => onChangeNumber(agent.id, value)}
          showMotion={motionAllowed}>
            {bindings.map(binding => {
              const group = snapshot.groups.find(item => item.id === binding.groupId) ?? {id: binding.groupId, name: binding.name};
              const avatarDataUrl = group.avatarDataUrl ?? binding.avatarDataUrl;
              const reading = nowGroupAttention(agent, binding, connected, snapshot.stale, now);
              return <li key={group.id}>
                <details className="badge-group-row">
                  <BadgeGroupSummary group={{...group, avatarDataUrl}} motion={motionAllowed}/>
                  <div className="badge-group-status">
                    {reading.showMeter && <span className="now-attention-meter" data-unknown={reading.level === undefined} aria-hidden="true">
                      {[1, 2, 3, 4].map(level => <i key={level} data-on={reading.level !== undefined && level <= reading.level}/>)}
                    </span>}
                    <span>{reading.label}</span>
                  </div>
                </details>
              </li>;
            })}
            {!bindings.length && <li className="badge-no-groups">暂无已绑定的群</li>}
        </NowBotBadge>;
      })}</BadgeRack> : <p className="now-bot-empty">添加 Bot，在飞书里开始交流。</p>}
  </section>;
}
