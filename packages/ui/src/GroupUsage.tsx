import {useState} from 'react';
import type {Conversation} from '@vonvon/protocol';
import {SettingChoices} from './settings/SettingChoices';

// Keep these scopes aligned with daemon/card/command-cards.ts buildHelpCard.
export function groupCommands(conversation: Conversation, topic: boolean) {
  const inSession = topic || conversation !== 'threads';
  return {
    common: [
      ['/goal <目标>', '持续处理，直到完成目标'],
      ...(inSession ? [['/model', '切换本群允许的模型与 Effort'], ['/context', '查看上下文用量'], ['/compact', '整理上下文']] : []),
      ['/help', '查看当前位置可用的命令'],
    ],
    admin: topic ? [] : [
      ...(conversation !== 'threads' ? [['/new', '开始新对话，保留飞书消息']] : []),
      ['/resume', '恢复历史对话'], ['/settings', '调整群设置'],
    ],
  };
}

export function GroupUsage({conversation, botName}: {conversation: Conversation; botName: string}) {
  const [location, setLocation] = useState<'main'|'topic'>('main');
  const commands = groupCommands(conversation, location === 'topic');
  return <div className="group-usage-guide">
    <p>{conversation === 'smart' ? `${botName} 会按回复规则接话；需要它处理时，可以直接 @ 它。` : `@ ${botName}，说出你想做什么。`}</p>
    <SettingChoices label="命令使用位置" value={location} onChange={setLocation} disabled={false} choices={[{value:'main',label:'群主区'},{value:'topic',label:'话题内'}]}/>
    {location === 'main' && conversation === 'threads' && <p className="group-control-note">主区 @ Bot 开启新话题，模型与上下文在话题内调整。</p>}
    <dl className="group-command-list">{commands.common.map(([command,description]) => <div key={command}><dt><code>{command}</code></dt><dd>{description}</dd></div>)}</dl>
    {commands.admin.length > 0 && <details className="group-command-admin"><summary>管理员命令</summary><dl className="group-command-list">{commands.admin.map(([command,description]) => <div key={command}><dt><code>{command}</code></dt><dd>{description}</dd></div>)}</dl></details>}
  </div>;
}
