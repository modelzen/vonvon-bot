import {useEffect, useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {Info} from 'lucide-react';
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
  const [helpOpen, setHelpOpen] = useState(false);
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
    : until !== undefined && until <= now ? '关注状态待更新'
    : undefined;
  const budget = state?.budget?.kind;
  const paused = budget === 'no-glance';
  const interval = state?.main?.intervalMs;
  const intervalText = interval !== undefined && interval % 60_000 === 0
    ? `${interval / 60_000} 分钟` : `${(interval ?? 0) / 1000} 秒`;

  const namedOnly = budget === 'named-only';
  const focus = state?.main?.mode === 'focus';
  // A supported, current snapshot can legitimately have no main-area record
  // before the next arrival. Keep this idle state separate from missing data.
  const idle = !unavailable && !state?.main && !namedOnly && !paused;
  const score = unavailable ? undefined : namedOnly ? 0 : !state?.main ? 0
    : focus ? 100 : paused ? 0 : watchScores[state.main.intervalMs];
  const status = unavailable ?? (namedOnly ? '仅处理真人直接找它的消息'
    : focus ? '专注中' : paused ? '暂停扫视' : idle ? '待互动' : '留意中');
  const description = unavailable ? undefined
    : namedOnly ? '@、引用或回复 Bot 发起的话题根消息仍会判断。'
    : focus ? '新消息到达就判断是否接话。'
    : paused ? '判断额度暂满，恢复后继续查看。'
    : idle ? '收到主区消息后，关注度自动更新。'
    : `攒一批消息再看 · 当前间隔 ${intervalText}`;

  const tone = score === undefined ? 'unknown' : idle ? 'idle' : score === 0 ? 'paused' : focus ? 'focus' : 'watch';
  const segmentLength = Math.PI * 68 / 4;
  return <section className="group-attention" data-tone={tone} aria-label="主区关注度">
    <div className="group-attention__reading">
      <Popover.Root open={helpOpen} onOpenChange={setHelpOpen}>
        <Popover.Trigger className="group-attention__metric" aria-label={`主区关注度 ${score === undefined ? '未知' : `${score} / 100`}，${status}。查看数值说明`} openOnHover delay={200} closeDelay={120}
          onFocus={event => {if (event.currentTarget.matches(':focus-visible')) setHelpOpen(true);}}>
          <svg className="group-attention__dial" viewBox="0 0 88 88" aria-hidden="true">
            <circle className="group-attention__dial-center" cx="44" cy="44" r="28"/>
            {[0, 1, 2, 3].map(index => <circle key={index} className={score !== undefined && score >= (index + 1) * 25 ? 'is-lit' : ''}
              cx="44" cy="44" r="34" fill="none" strokeWidth="4" strokeLinecap="round"
              strokeDasharray={`${segmentLength - 6} ${segmentLength * 3 + 6}`} transform={`rotate(${-85 + index * 90} 44 44)`}/>)}
            {[0, 90, 180, 270].map(angle => <path className="group-attention__dial-tick" key={angle} d="M44 2v3" transform={`rotate(${angle} 44 44)`}/>)}
          </svg>
          <span className="group-attention__value"><strong>{score ?? '—'}</strong>{score !== undefined && <span>/ 100</span>}</span>
          <span className="group-attention__dial-info"><Info size={12} aria-hidden="true"/></span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} className="group-attention__positioner">
            <Popover.Popup className="group-attention__help" initialFocus={false} finalFocus={false}>
              <Popover.Title className="group-attention__help-title">关注度随互动自动变化</Popover.Title>
              <dl>
                <div><dt>100</dt><dd>专注，来消息就判断</dd></div>
                <div><dt>75 / 50 / 25</dt><dd>留意，间隔 1 / 3 / 5 分钟</dd></div>
                <div><dt>0</dt><dd>待互动或暂停主动查看，仍处理真人直接找它的消息</dd></div>
              </dl>
              <Popover.Description>按现有档位折算，不代表回复概率。话题单独关注；消息多时会提前查看。</Popover.Description>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <div className="group-attention__copy"><span className="group-attention__heading">主区关注度</span><strong className="group-attention__status"><span aria-hidden="true"/>{status}</strong>{description && <p>{description}</p>}
        {!unavailable && !namedOnly && state && <p className="group-attention__topics">话题：{state.focusedTopics} 个专注 · {state.watchedTopics} 个{paused ? '暂停扫视' : '留意'}</p>}
      </div>
    </div>
    {!unavailable && paused && <p className="group-attention__note">扫视已暂停，专注中的位置仍会判断新消息。</p>}
  </section>;
}
