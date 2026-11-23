import {useEffect, useState} from 'react';
import {describeRecurringSchedule, type RecipeTaskSummary} from '@vonvon/protocol';
import {useAccount} from '../account-context';
import {SettingsGroup, SettingsRow} from '../reference/components/system-settings';
import {Button} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {schedulePlacementText} from '../schedule-model';
import type {RecipeDisplay} from './RecipeContent';
import {richText} from './RichConfiguration';
import {useCommunity} from './community-context';

function cadence(task: RecipeTaskSummary) {
  if (task.spec.kind !== 'once') return describeRecurringSchedule(task.spec);
  const timeZone = task.timeZone.kind === 'recommended' ? task.timeZone.iana : 'UTC';
  const date = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short', timeZone}).format(task.spec.at);
  return task.timeZone.kind === 'recommended' ? `${date} 一次` : `${date} UTC 一次`;
}

export function RecipeTasks({recipe}: {recipe: RecipeDisplay}) {
  const shell = useCommunity()?.shell;
  const {status} = useAccount();
  const accountId = status?.kind === 'signedIn' ? status.accountId : undefined;
  const {recipeId, versionId, state} = recipe;
  const count = recipe.preview?.taskCount ?? recipe.rich?.content.tasks.length ?? 0;
  const eligible = Boolean((recipe.owned || recipe.acquired) && state === 'listed' && recipe.format === 'rich-v2' && count);
  const identity = eligible && accountId && recipeId && versionId ? [accountId, recipeId, versionId].join('/') : undefined;
  const [result, setResult] = useState<{identity: string; tasks?: RecipeTaskSummary[]}>();
  useEffect(() => {
    if (!shell || !identity || !recipeId || !versionId || !accountId) return;
    let active = true;
    void shell.request({type: 'recipeTaskSummaries', accountId, recipeId, versionId}).then(reply => {
      if (active) setResult({identity, tasks: reply.versionId === versionId && reply.recipeId === recipeId ? reply.tasks : undefined});
    }).catch(() => {if (active) setResult({identity});});
    return () => {active = false;};
  }, [shell, identity, accountId, recipeId, versionId]);
  const [selectedId, setSelectedId] = useState<string>();
  const tasks = recipe.rich?.content.tasks ?? (result?.identity === identity ? result?.tasks : undefined) ?? [];
  const selected = tasks.find(task => task.itemId === selectedId);
  const local = recipe.rich?.content.tasks.find(task => task.itemId === selectedId);
  return <SettingsGroup label="任务">
    {tasks.map(task => <SettingsRow key={task.itemId} title={task.name}
      description={cadence(task)} onClick={() => setSelectedId(task.itemId)}/>)}
    {!tasks.length && <SettingsRow title={count ? `包含 ${count} 项任务` : '未预设定时任务'}
      description={count ? identity && result?.identity !== identity ? '正在读取任务安排…' : '交给 Bot 时可查看完整安排。' : '应用后可在群聊中添加任务。'}/>}
    <Dialog open={Boolean(selected)} title={selected?.name ?? '任务'} onClose={() => setSelectedId(undefined)}
      footer={<Button onClick={() => setSelectedId(undefined)}>完成</Button>}>
      {selected && <dl className="recipe-task-facts">
        <div><dt>什么时候</dt><dd>{cadence(selected)}</dd></div>
        <div><dt>时区</dt><dd>{selected.timeZone.kind === 'recommended' ? selected.timeZone.iana : '安装时选择'}</dd></div>
        <div><dt>发到哪</dt><dd>{schedulePlacementText[selected.placement]}</dd></div>
        <div className="recipe-task-instruction"><dt>要做什么</dt><dd>{local && recipe.rich ? richText(local.instruction, recipe.rich) : '交给 Bot 时读取任务指令。'}</dd></div>
      </dl>}
    </Dialog>
  </SettingsGroup>;
}
