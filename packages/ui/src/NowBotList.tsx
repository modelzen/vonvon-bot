import {useEffect, useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {BadgeRack, NowBotBadge} from './NowBotBadge';
import {BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS, type Agent, type BotActivity, type BotLatestAction, type DesktopSnapshot, type Group, type Membership} from '@vonvon/protocol';
import {GroupAvatar} from './GroupAvatar';
import {BadgeName} from './BadgeName';
import {nowGroupAttention, type NowAttention} from './now-attention';
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

function AttentionStatus({name, reading}: {name: string; reading: NowAttention}) {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="badge-group-status" aria-label={`${name}：${reading.showMeter ? `群注意力${reading.score === undefined ? '' : ` ${reading.score} / 100`}，` : ''}${reading.label}`}
      openOnHover delay={200} closeDelay={120}
      onFocus={event => {if (event.currentTarget.matches(':focus-visible')) setOpen(true);}}>
      {reading.showMeter && <span className="now-attention-meter" data-unknown={reading.level === undefined} data-score={reading.score} aria-hidden="true">
        {[1, 2, 3, 4].map(level => <i key={level} data-on={reading.level !== undefined && level <= reading.level}/>)}
      </span>}
      <span>{reading.label}</span>
    </Popover.Trigger>
    <Popover.Portal><Popover.Positioner side="top" align="start" sideOffset={7} collisionPadding={12} className="now-attention-positioner">
      <Popover.Popup className="now-attention-tooltip" initialFocus={false} finalFocus={false}>
        <Popover.Title>{reading.showMeter ? '群注意力' : '聊天方式'}</Popover.Title>
        <Popover.Description>{reading.description}</Popover.Description>
        {reading.showMeter && <p>主区和话题共用群注意力；Bot 接话后升高，随后逐步下降，30 分钟后保留 10 分的低度留意。普通消息合批查看。</p>}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}

function badgeConnection(agent: Agent, live: boolean, stale: boolean): string {
  if (agent.readError) return '配置读取失败';
  if (!agent.enabled) return '已停用';
  if (!live) return stale ? '待更新' : '已断开';
  if (!agent.running) return '未运行';
  switch (agent.connection) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'reconnecting': return '重连中';
    case 'failed': return '连接失败';
    case 'idle':
    case 'stopped':
    case 'disconnected': return '未连接';
    default: return '待更新';
  }
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

/** `share`: the share card's, with no way to reach the Bots from the image. */
export function NowBotList({snapshot, connected, disabled, onChangeNumber, share = false}: {
  snapshot: DesktopSnapshot; connected: boolean; disabled: boolean;
  onChangeNumber: (agentId: Agent['id'], value: string) => Promise<string | undefined>; share?: boolean;
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
      {snapshot.agents.length ? <BadgeRack>{snapshot.agents.map((agent, index) => {
        const bindings = [...new Map(snapshot.memberships.filter(member => member.agentId === agent.id).map(member => [member.groupId, member])).values()];
        const confirmed = live && !agent.readError && bindings.every(member => !member.stale);
        let groupSummary = `已加入 ${bindings.length} 个群`;
        if (!confirmed) groupSummary = bindings.length ? `上次记录 ${bindings.length} 个群` : '群数待更新';
        const connectionStatus = badgeConnection(agent, live, snapshot.stale);
        return <NowBotBadge key={agent.id} agent={agent} index={index} groupSummary={groupSummary}
          status={connectionStatus} tone={connectionStatus === '已连接' ? 'online' : 'offline'}
          ownerName={agent.ownerName} tenure={badgeTenure(agent.registeredAt, now)}
          jobNumber={agent.badgeNumber} editable={live && !disabled && !!agent.badgeNumber}
          onJobChange={value => onChangeNumber(agent.id, value)} contact={!share}
          showMotion={motionAllowed}>
            {bindings.map(binding => {
              const group = snapshot.groups.find(item => item.id === binding.groupId) ?? {id: binding.groupId, name: binding.name};
              const avatarDataUrl = group.avatarDataUrl ?? binding.avatarDataUrl;
              const reading = nowGroupAttention(agent, binding, connected, snapshot.stale, now, snapshot.attentionModel === 'group');
              return <li key={group.id}>
                <details className="badge-group-row">
                  <BadgeGroupSummary group={{...group, avatarDataUrl}} motion={motionAllowed}/>
                  <AttentionStatus name={group.name} reading={reading}/>
                </details>
              </li>;
            })}
            {!bindings.length && <li className="badge-no-groups">{confirmed ? '暂无已绑定的群' : '群列表待更新'}</li>}
        </NowBotBadge>;
      })}</BadgeRack> : <p className="now-bot-empty">添加 Bot，在飞书里开始交流。</p>}
  </section>;
}
