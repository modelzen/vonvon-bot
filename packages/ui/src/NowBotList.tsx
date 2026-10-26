import {useEffect, useId, useState} from 'react';
import {Tooltip} from '@base-ui/react/tooltip';
import {Collapsible} from '@base-ui/react/collapsible';
import {ThinkingOrb} from 'thinking-orbs';
import {Check, ChevronRight, Hourglass, Leaf, MessageCircle, Minimize2, RotateCw, Wrench} from 'lucide-react';
import {BOT_ACTIVITY_STALE_MS, BOT_LATEST_ACTION_SHOWN_MS, type Agent, type BotActivity, type BotLatestAction, type DesktopSnapshot, type Membership} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {GroupAvatar} from './GroupAvatar';
import {GlowButton} from './GlowButton';
import {nowAttentionSummary, nowGroupAttention, type NowAttention} from './now-attention';
import './now-bots.css';

const toolLabels = {command: '执行命令', file: '读写文件', search: '搜索中', tool: '使用工具'} as const;
const activityLabels: Record<BotActivity['phase'], string> = {
  processing: '正在处理', thinking: '思考中', tool: '使用工具', responding: '组织回复',
  compacting: '压缩上下文', waiting: '等待确认', retrying: '正在重试',
};

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

function AttentionStatus({name, reading}: {name: string; reading: NowAttention}) {
  const [open, setOpen] = useState(false);
  return <Tooltip.Root open={open} onOpenChange={setOpen}>
    <Tooltip.Trigger type="button" closeOnClick={false} onClick={() => setOpen(true)} className="now-attention-status" aria-label={`${name}：${reading.label}`}>
      {reading.showMeter && <span className="now-attention-meter" data-unknown={reading.level === undefined} aria-hidden="true">
        {[1, 2, 3, 4].map(level => <i key={level} data-on={reading.level !== undefined && level <= reading.level}/>)}
      </span>}
      <span>{reading.label}</span>
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="top" align="end" sideOffset={7} collisionPadding={12} className="now-attention-positioner">
      <Tooltip.Popup className="now-attention-tooltip">{reading.description}</Tooltip.Popup>
    </Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}

function ActivityIcon({activity, moving}: {activity: BotActivity; moving: boolean}) {
  if (activity.phase === 'thinking') return <ThinkingOrb state="breathing" theme="light" size={20} paused={!moving}/>;
  const Icon = activity.phase === 'tool' ? Wrench : activity.phase === 'compacting' ? Minimize2
    : activity.phase === 'waiting' ? Hourglass : activity.phase === 'retrying' ? RotateCw : MessageCircle;
  return <Icon size={13} aria-hidden="true"/>;
}

export function NowBotList({snapshot, connected, onRegister, disabled}: {
  snapshot: DesktopSnapshot; connected: boolean; onRegister: () => void; disabled: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [, tick] = useState(0);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [pointerMotion, setPointerMotion] = useState(false);
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
    if (!live) return;
    const current = Date.now();
    const deadlines = snapshot.agents.flatMap(agent => [
      ...(agent.diagnostics?.attention ?? []).flatMap(group => group.budget ? [group.budget.until] : []),
      ...(agent.diagnostics?.activities ?? []).map(activity => (activity.observedAt ?? activity.updatedAt) + BOT_ACTIVITY_STALE_MS),
      ...(agent.diagnostics?.latestAction ? [agent.diagnostics.latestAction.at + BOT_LATEST_ACTION_SHOWN_MS] : []),
    ]).filter(deadline => deadline > current);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => tick(value => value + 1), Math.min(...deadlines) - current + 1);
    return () => window.clearTimeout(timer);
  }, [snapshot, live, now]);
  const toggle = (agentId: string, open?: boolean) => setExpanded(previous => ({...previous, [agentId]: open ?? !previous[agentId]}));
  return <section className="today-home-section now-bot-list" aria-label="你的 Bot" data-motion={motionAllowed && !disabled && live} data-pointer-motion={pointerMotion}
    onPointerDownCapture={event => setPointerMotion(event.pointerType === 'mouse')} onKeyDownCapture={() => setPointerMotion(false)}>
    <header><h2>你的 Bot</h2><GlowButton disabled={disabled} onClick={onRegister}>添加 Bot</GlowButton></header>
    <Tooltip.Provider delay={300} closeDelay={100}>
      {snapshot.agents.length ? <div className="today-list-surface">{snapshot.agents.map(agent => {
        const members = snapshot.memberships.filter(member => member.agentId === agent.id)
          .filter((member, index, all) => all.findIndex(other => other.groupId === member.groupId) === index);
        const readings = members.map(member => nowGroupAttention(agent, member, connected && snapshot.host.kind === 'connected', snapshot.stale, now));
        const available = live && agent.enabled && agent.running && agent.connection === 'connected' && !agent.readError;
        const activities = nowBotActivities(agent, members, live, now);
        const activity = activities[0];
        const latestAction = activity ? undefined : nowBotLatestAction(agent, members, live, now);
        const actionGroup = activity?.groupId ?? latestAction?.groupId;
        const groupName = actionGroup ? snapshot.groups.find(group => group.id === actionGroup)?.name
          ?? members.find(member => member.groupId === actionGroup)?.name : undefined;
        const label = activity ? activity.phase === 'tool' ? toolLabels[activity.toolKind ?? 'tool'] : activityLabels[activity.phase]
          : latestAction?.kind === 'replied' ? '已回复' : latestAction ? '新增了一条记忆' : '';
        const fallback = agent.readError ? '配置读取失败' : !agent.enabled ? '已停用' : !agent.running ? '未运行'
          : !connected || snapshot.host.kind !== 'connected' || agent.connection !== 'connected' ? '等待连接恢复'
          : snapshot.stale ? '' : agent.diagnostics?.activities?.length === 0 ? '安静等候' : '';
        const summary = nowAttentionSummary(readings, members.length);
        const listId = `${id}-${agent.id}`, open = !!expanded[agent.id];
        return <Collapsible.Root className="now-bot-node" key={agent.id} data-motion={available && !disabled} open={open} onOpenChange={next => toggle(agent.id, next)}>
          <Collapsible.Trigger type="button" className="now-bot-row" aria-controls={listId}
            aria-label={`${agent.name}，${label ? `${label}${groupName ? ` · ${groupName}` : ''}，` : ''}${summary}，${open ? '收起' : '展开'}群关注`}
            onKeyDown={event => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {event.preventDefault(); toggle(agent.id, event.key === 'ArrowRight');}
            }}>
            <span className="now-bot-identity"><ChevronRight className="now-bot-disclosure" size={13} aria-hidden="true"/><AgentAvatar agent={agent}/><strong title={agent.name}>{agent.name}</strong></span>
            <span className="now-bot-activity" data-active={!!activity} key={activity ? `${activity.id}:${activity.phase}:${activity.toolKind ?? ''}` : latestAction?.id ?? fallback}>
              {activity || latestAction ? <><span className="now-bot-activity-icon" aria-hidden="true">{activity ? <ActivityIcon activity={activity} moving={motionAllowed && !disabled && available}/> : latestAction?.kind === 'replied' ? <Check size={14}/> : <Leaf size={14}/>}</span>
                <span className="now-bot-action">
                  <span>{label}</span><small title={groupName}>{groupName}</small>
                  {activities.length > 1 && <small className="now-bot-parallel">另有 {activities.length - 1} 项</small>}
                </span></> : fallback ? <span className="now-bot-idle">{fallback}</span> : null}
            </span>
            <small className="now-bot-summary" data-focused={available && readings.some(reading => reading.tone === 'focus')}>{summary}</small>
          </Collapsible.Trigger>
          <Collapsible.Panel render={<ul/>} keepMounted className="now-bot-children" id={listId} aria-label={`${agent.name} 关注的群`}>
            {members.map((member, index) => {
              const group = snapshot.groups.find(item => item.id === member.groupId) ?? {id: member.groupId, name: member.name, avatarDataUrl: member.avatarDataUrl};
              return <li className="now-bot-child" key={member.groupId}>
                <span className="now-bot-group"><GroupAvatar group={group}/><strong title={group.name}>{group.name}</strong></span>
                <AttentionStatus name={group.name} reading={readings[index]!}/>
              </li>;
            })}
            {!members.length && <li className="now-bot-no-groups">还没有加入群聊</li>}
          </Collapsible.Panel>
        </Collapsible.Root>;
      })}</div> : <p className="now-bot-empty">添加 Bot，在飞书里开始交流。</p>}
    </Tooltip.Provider>
  </section>;
}
