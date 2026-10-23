import {useEffect, useState} from 'react';
import type {Agent, Membership} from '@vonvon/protocol';
import './GroupAttentionStatus.css';

// Display-only equivalents of the existing main-area tiers, not a new attention
// algorithm or a reply probability. Topics keep their independent state.
const watchScores: Readonly<Record<number, number>> = {60_000: 75, 180_000: 50, 300_000: 25};

/** A read-only view of the selected Bot's live attention in this group. */
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

  const namedOnly = budget === 'named-only';
  const focus = state?.main?.mode === 'focus';
  const score = unavailable ? undefined : namedOnly ? 0 : !state?.main ? undefined
    : focus ? 100 : paused ? 0 : watchScores[state.main.intervalMs];
  const status = unavailable ?? (namedOnly ? '仅处理真人直接找它的消息'
    : !state?.main ? '主区暂无关注状态' : focus ? '专注中' : paused ? '暂停扫视' : '留意中');
  const description = unavailable ? undefined
    : namedOnly ? '@、引用或回复 Bot 发起的话题根消息仍会判断。'
    : !state?.main ? undefined
    : focus ? '新消息到达就判断是否接话。'
    : paused ? '判断额度暂满，恢复后继续查看。'
    : `攒一批消息再看 · 当前间隔 ${intervalText}`;

  return <section className="group-attention" aria-label="主区关注度">
    <div className="group-attention__heading"><span>主区关注度</span><small>自动变化</small></div>
    <div className="group-attention__reading">
      <div className="group-attention__value"><strong>{score ?? '—'}</strong>{score !== undefined && <span>/ 100</span>}</div>
      <div className="group-attention__copy"><strong>{status}</strong>{description && <p>{description}</p>}</div>
    </div>
    {!unavailable && !namedOnly && <p className="group-attention__topics">话题：{state?.focusedTopics ?? 0} 个专注 · {state?.watchedTopics ?? 0} 个{paused ? '暂停扫视' : '留意'}</p>}
    {!unavailable && paused && <p className="group-attention__note">扫视已暂停，专注中的位置仍会判断新消息。</p>}
    <details className="group-attention__help">
      <summary>数值说明</summary>
      <p>100 专注 · 75 / 50 / 25 留意（间隔 1 / 3 / 5 分钟）· 0 暂停主动查看。</p>
      <p>按现有档位折算，不代表回复概率。话题单独关注；消息多时会提前查看。</p>
    </details>
  </section>;
}
