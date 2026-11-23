import {useState} from 'react';
import {Check} from 'lucide-react';
import type {AgentId, DesktopSnapshot} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {Dialog} from './reference/components/ui/Dialog';
import {Button} from './reference/components/ui';
import './select-join-bot.css';

export function SelectJoinBotDialog({snapshot, onSelect, onClose}: {snapshot: DesktopSnapshot; onSelect: (id: AgentId) => void; onClose: () => void}) {
  const [selectedId, setSelectedId] = useState<AgentId>();
  const selected = snapshot.agents.find(agent => agent.id === selectedId && agent.enabled && !agent.readError);
  return <Dialog open title="选择入群的 Bot" description="选择后，继续创建或连接群聊。" size="sm" onClose={onClose}
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!selected} onClick={() => {if (selected) onSelect(selected.id);}}>下一步</Button></>}>
    <fieldset className="join-bot-picker"><legend className="ui-dialog__visually-hidden">选择 Bot</legend>
      {snapshot.agents.map(agent => {
        const disabled = !agent.enabled || Boolean(agent.readError);
        const count = snapshot.memberships.filter(member => member.agentId === agent.id).length;
        return <label key={agent.id} className="join-bot-picker__option" data-disabled={disabled || undefined}>
          <input type="radio" name="join-bot" value={agent.id} checked={selectedId === agent.id} disabled={disabled} onChange={() => setSelectedId(agent.id)}/>
          <AgentAvatar agent={agent}/><span className="join-bot-picker__copy"><strong>{agent.name}</strong><small>{agent.readError ? '读取失败' : !agent.enabled ? '已停用' : `已连接 ${count} 个群聊`}</small></span>
          <Check className="join-bot-picker__check" size={16} aria-hidden="true"/>
        </label>;
      })}
      {!snapshot.agents.length && <p className="join-bot-picker__empty">请先注册一个 Bot。</p>}
    </fieldset>
  </Dialog>;
}
