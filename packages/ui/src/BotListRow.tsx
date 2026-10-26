import type {ReactNode} from 'react';
import type {Agent} from '@vonvon/protocol';
import {ArrowUpRight} from 'lucide-react';
import {AgentAvatar} from './AgentAvatar';

/** Shared compact Bot row: identity leads, group count and state stay secondary. */
export function BotListRow({agent, groupCount, onSelect, status, newLabel, action}: {
  agent: Agent;
  groupCount: number;
  onSelect: () => void;
  status?: ReactNode;
  newLabel?: string;
  action?: ReactNode;
}) {
  return <div className="today-entity-row today-bot-row">
    <button type="button" className="today-bot-info" onClick={onSelect} aria-label={`查看 ${agent.name}`}>
      <AgentAvatar agent={agent}/>
      <span className="today-entity-copy"><strong title={agent.name}>{agent.name}</strong></span>
      <span className="overview-bot-meta" title={agent.readError || undefined}>
        <span>{groupCount} 个群聊</span>
        {newLabel && <><span aria-hidden="true">·</span><span>{newLabel}</span></>}
        {status && <><span aria-hidden="true">·</span><span className="today-bot-status">{status}</span></>}
      </span>
      {!action && <span className="today-bot-open" aria-hidden="true"><ArrowUpRight size={17}/></span>}
    </button>
    {action}
  </div>;
}
