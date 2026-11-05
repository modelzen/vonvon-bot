import {useEffect, useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {Info} from 'lucide-react';
import type {Agent, Membership} from '@vonvon/protocol';
import {nowGroupAttention, type NowAttention} from '../now-attention';
import './GroupAttentionStatus.css';

/** A read-only view of the selected Bot's live attention in this group. */
export function GroupAttentionStatus({agent, membership, connected, attentionModel}: {
  agent?: Agent;
  membership?: Membership;
  connected: boolean;
  attentionModel?: 'group';
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
  const reading: NowAttention = matching
    ? nowGroupAttention(agent, membership, connected, false, now, attentionModel === 'group')
    : {label: '待更新', description: '暂无注意力状态。', tone: 'unknown', showMeter: true};
  const {score, tone, label: status, description} = reading;
  const segmentLength = Math.PI * 68 / 4;
  return <section className="group-attention" data-tone={tone} aria-label="群注意力">
    <div className="group-attention__reading">
      <Popover.Root open={helpOpen} onOpenChange={setHelpOpen}>
        <Popover.Trigger className="group-attention__metric" aria-label={`群注意力 ${score === undefined ? '未知' : `${score} / 100`}，${status}。查看数值说明`} openOnHover delay={200} closeDelay={120}
          onFocus={event => {if (event.currentTarget.matches(':focus-visible')) setHelpOpen(true);}}>
          <svg className="group-attention__dial" viewBox="0 0 88 88" aria-hidden="true">
            <circle className="group-attention__dial-center" cx="44" cy="44" r="28"/>
            {[0, 1, 2, 3].map(index => {
              const fill = score === undefined ? 0 : Math.min(1, Math.max(0, (score - index * 25) / 25));
              return <g key={index} transform={`rotate(${-85 + index * 90} 44 44)`}>
                <circle cx="44" cy="44" r="34" fill="none" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${segmentLength - 6} ${segmentLength * 3 + 6}`}/>
                {fill > 0 && <circle className="is-lit" cx="44" cy="44" r="34" fill="none" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${(segmentLength - 6) * fill} ${segmentLength * 4}`}/>}
              </g>;
            })}
            {[0, 90, 180, 270].map(angle => <path className="group-attention__dial-tick" key={angle} d="M44 2v3" transform={`rotate(${angle} 44 44)`}/>)}
          </svg>
          <span className="group-attention__value"><strong>{score ?? '—'}</strong>{score !== undefined && <span>/ 100</span>}</span>
          <span className="group-attention__dial-info"><Info size={12} aria-hidden="true"/></span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} className="group-attention__positioner">
            <Popover.Popup className="group-attention__help" initialFocus={false} finalFocus={false}>
              <Popover.Title className="group-attention__help-title">群注意力随互动自动变化</Popover.Title>
              <dl>
                <div><dt>100</dt><dd>接话后 2 分钟内，普通消息短暂合批</dd></div>
                <div><dt>75 / 50 / 25</dt><dd>接话后 2–10 / 10–20 / 20–30 分钟，按 1 / 3 / 5 分钟节奏合批</dd></div>
                <div><dt>10</dt><dd>30 分钟未接话，低度留意；有新消息时仍会查看</dd></div>
              </dl>
              <Popover.Description>主区和话题共用注意力，只有 Bot 实际接话才升高。普通消息合批查看；真人 @、引用和短期接续优先。没有待看消息时不调用判断模型。</Popover.Description>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <div className="group-attention__copy"><span className="group-attention__heading">群注意力</span><strong className="group-attention__status"><span aria-hidden="true"/>{status}</strong>{description && <p>{description}</p>}
      </div>
    </div>
  </section>;
}
