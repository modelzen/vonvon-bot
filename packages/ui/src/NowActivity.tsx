import {useEffect, useMemo, useRef, useState} from 'react';
import {CornerDownRight, GitBranch, MessageCircle, Minus} from 'lucide-react';
import type {DesktopSnapshot} from '@vonvon/protocol';
import {conversationTime} from './conversation-time';
import {decisionLabels, decisionTrigger, nowDecisions} from './now-activity';
import './now-activity.css';

const icons = {skip: Minus, main: MessageCircle, reply: CornerDownRight, topic: GitBranch};

export function NowActivity({snapshot}: {snapshot: DesktopSnapshot}) {
  const incoming = useMemo(() => nowDecisions(snapshot), [snapshot]);
  const [shown, setShown] = useState(incoming);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const animate = useRef(false);
  // Do not replace the list beneath the pointer, keyboard focus, or a reader
  // who scrolled into its history. The newest snapshot is applied on return.
  useEffect(() => {
    if (hovered || focused || scrolled) return;
    animate.current = shown.length > 0 && incoming[0]?.key !== shown[0]?.key;
    setShown(incoming);
  }, [incoming, hovered, focused, scrolled]);
  const connected = snapshot.host.kind === 'connected' && !snapshot.stale;
  const supported = snapshot.agents.some(bot => bot.diagnostics?.decisions !== undefined);
  return <section className="today-home-section now-activity" aria-label="群动态">
    <header><h2>群动态</h2></header>
    {shown.length ? <div className="now-activity-stream" tabIndex={0} aria-label="群动态记录"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={event => {if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false);}}
      onScroll={event => setScrolled(event.currentTarget.scrollTop > 2)}>
      <div className="now-activity-items" key={shown[0]?.key} data-arriving={connected && animate.current || undefined}>
        {shown.map(entry => {
          const Icon = icons[entry.decision];
          const time = conversationTime(entry.decidedAt);
          return <article key={entry.key} className="now-decision" data-decision={entry.decision}>
            <span className="now-decision-icon" aria-hidden="true"><Icon size={15}/></span>
            <div className="now-decision-copy">
              <div className="now-decision-heading"><span className="now-decision-label">{decisionLabels[entry.decision]}</span><span className="now-decision-group" title={entry.group}>{entry.group}</span><time dateTime={time?.dateTime} title={time?.title}>{time?.label}</time></div>
              <div className="now-decision-context"><span title={entry.bot}>{entry.bot}</span><i aria-hidden="true"/><span>{decisionTrigger(entry)}</span></div>
            </div>
          </article>;
        })}
      </div>
    </div> : <p className="now-activity-empty">{!connected ? '连接恢复后显示群动态' : supported ? '暂时没有新动态' : '新动态将在智能模式判断后显示'}</p>}
  </section>;
}
