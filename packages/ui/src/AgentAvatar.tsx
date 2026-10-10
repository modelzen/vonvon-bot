import { Bot } from 'lucide-react';
import type { Agent } from '@vonvon/protocol';

export function AgentAvatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return <span className={`collaboration-avatar agent${large ? ' large' : ''}`}>
    <Bot size={large ? 24 : 16} />
    {agent.avatarDataUrl && <img key={agent.avatarDataUrl} alt="" aria-hidden="true"
      className="collaboration-avatar-image" data-loaded="false" src={agent.avatarDataUrl}
      onLoad={event => { event.currentTarget.dataset.loaded = 'true'; }}
      onError={event => { event.currentTarget.dataset.failed = 'true'; }} />}
  </span>;
}
