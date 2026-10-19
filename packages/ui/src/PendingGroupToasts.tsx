import {useState} from 'react';
import {X} from 'lucide-react';
import type {Agent, PendingGroup} from '@vonvon/protocol';
import type {PendingAgentGroups} from './pending-groups';
import {Button, IconButton, InlineNotice} from './reference/components/ui';
import './pending-groups.css';

export function PendingGroupToasts({pages, agents, hidden, onContinue}: {
  pages: PendingAgentGroups[];
  agents: Agent[];
  hidden: boolean;
  onContinue: (agent: Agent, group: PendingGroup) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const entries = pages.flatMap(page => {
    const agent = agents.find(item => item.id === page.agentId);
    return agent ? page.groups.map(group => ({agent, group, key: `${agent.id}:${group.chatId}:${group.addedAt}`})) : [];
  }).filter(entry => !dismissed.has(entry.key)).slice(0, 2);
  if (hidden || !entries.length) return null;
  function dismiss(key: string) {setDismissed(previous => new Set([...previous, key]));}
  return <aside className="pending-group-toasts" aria-label="飞书群绑定通知" aria-live="polite">
    {entries.map(({agent, group, key}) => <InlineNotice key={key} title={`${agent.name} 已加入 ${group.name}`} actions={<>
      <Button onClick={() => onContinue(agent, group)}>继续绑定</Button>
      <IconButton label={`关闭 ${group.name} 的绑定通知`} onClick={() => dismiss(key)}><X size={14} /></IconButton>
    </>}>还没设置好：选会话方式就能用。稍后也可从待绑定列表继续。</InlineNotice>)}
  </aside>;
}
