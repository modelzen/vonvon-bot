import {useEffect, useState} from 'react';
import type {Agent, Membership} from '@vonvon/protocol';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import './settings.css';

/** A read-only view of the selected Bot's live attention, never a group-wide score. */
export function GroupAttentionStatus({agent, membership, connected}: {
  agent?: Agent;
  membership?: Membership;
  connected: boolean;
}) {
  const [, updateClock] = useState(0);
  const matching = agent && membership && agent.id === membership.agentId;
  const state = matching ? agent.diagnostics?.attention?.find(item => item.groupId === membership.groupId) : undefined;
  const until = state?.budget?.until;
  const now = Date.now();
  // The daemon publishes again when its sliding budget changes. If that update
  // is late, stop presenting the expired snapshot as a current state. In
  // particular, falling below 60 does not imply falling below the 45 scan cap.
  useEffect(() => {
    if (until === undefined || until <= Date.now()) return;
    const timer = window.setTimeout(() => updateClock(value => value + 1), until - Date.now() + 1);
    return () => window.clearTimeout(timer);
  }, [until]);

  if (membership && membership.conversation !== 'smart') return null;
  const unavailable = !matching ? '暂无关注状态'
    : !connected ? '连接已断开，暂无关注状态'
    : !agent.enabled || !agent.running ? 'Bot 未运行'
    : agent.connection !== 'connected' ? '连接已断开，暂无关注状态'
    : membership.stale ? '群状态暂不可读'
    : membership.enabled === false ? '项目已停用，暂停关注'
    : membership.enabled === undefined ? '项目状态暂不可读'
    : !agent.diagnostics?.attention ? '当前版本未提供关注状态'
    : !state ? '暂无关注状态'
    : until !== undefined && until <= now ? '关注状态待更新'
    : undefined;
  const budget = state?.budget?.kind;
  const paused = budget === 'no-glance';
  const interval = state?.main?.intervalMs;
  const intervalText = interval !== undefined && interval % 60_000 === 0
    ? `${interval / 60_000} 分钟` : `${(interval ?? 0) / 1000} 秒`;

  return <SettingsGroup label="当前关注状态" className="group-attention" footer="随群内互动自动调整 · 只读">
    {unavailable ? <SettingsRow title={unavailable} />
      : budget === 'named-only' ? <SettingsRow title="仅处理真人直接找它的消息"
        description="@、引用或回复 Bot 发起的话题根消息仍会判断。额度恢复后自动继续。" />
      : <>
        <SettingsRow title="群主区" value={!state?.main ? '暂无关注状态'
          : state.main.mode === 'focus' ? '专注中'
          : paused ? '暂停扫视' : `留意中 · 扫视间隔 ${intervalText}`} />
        <SettingsRow title="话题" value={`${state?.focusedTopics ?? 0} 个专注 · ${state?.watchedTopics ?? 0} 个${paused ? '暂停扫视' : '留意'}`} />
        {paused && <SettingsRow title="扫视已暂停"
          description="判断额度暂满，暂停扫视；专注中的位置仍会判断新消息。" />}
      </>}
    <details className="settings-disclosure">
      <summary>关注状态说明</summary>
      <SettingsRow title="专注" description="新消息到达就判断是否接话。" />
      <SettingsRow title="留意" description="攒一批消息再看，扫视间隔会在 1、3、5 分钟之间自动调整；消息积累较多时会提前查看。" />
      <SettingsRow title="主区和话题分别变化" description="显示此 Bot 在本群的状态，是否回复由 Bot 判断。判断额度受限时，以暂停提示为准。" />
    </details>
  </SettingsGroup>;
}
