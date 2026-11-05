import {useEffect, useState} from 'react';
import type {AgentId, DesktopSnapshot, MembershipId, ScheduledTaskView} from '@vonvon/protocol';
import {useClient} from './client-context';
import {settingAnchor} from './search';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {Button, InlineNotice} from './reference/components/ui';
import {ScheduleDeleteDialog} from './ScheduleTab';
import {listOf, scheduleSummary, type ScheduleList} from './schedule-model';

export type ScheduleGroup = {chatId: string; name: string; memberId?: MembershipId; dm?: boolean; tasks: ScheduledTaskView[]};
/** This Bot's tasks by group. A group it is no longer bound to has no page to open, and may have no name left; a private chat has the private chat's page. */
export function scheduleGroups(tasks: readonly ScheduledTaskView[], agentId: AgentId, snapshot: DesktopSnapshot): ScheduleGroup[] {
  const byChat = new Map<string, ScheduledTaskView[]>();
  for (const task of tasks) byChat.set(task.chatId, [...byChat.get(task.chatId) ?? [], task]);
  return [...byChat].map(([chatId, tasks]) => {
    const dm = tasks[0]?.dm;
    if (dm) return {chatId, tasks, dm: true, name: dm.name ? `私聊 · ${dm.name}` : '私聊'};
    const group = snapshot.groups.find(item => item.id === chatId);
    const member = snapshot.memberships.find(item => item.agentId === agentId && item.groupId === chatId);
    return {chatId, tasks, memberId: group && member?.id, name: group ? `${group.name}${member ? '' : '（已解绑）'}` : '已解绑的群'};
  });
}

/** The Bot page's 任务 pane: it only lists; a task is made and changed on its group's or the private chat's 任务 tab. */
export function BotScheduleGroups({list, agentId, snapshot, onOpen, onOpenDm, onDelete}: {
  list: ScheduleList; agentId: AgentId; snapshot: DesktopSnapshot; onOpen: (memberId: MembershipId) => void; onOpenDm?: () => void; onDelete: (task: ScheduledTaskView) => void;
}) {
  if (list.kind === 'loading') return <p className="group-control-note" role="status">正在读取任务…</p>;
  if (list.kind === 'refused') return <p className="group-control-note" role="status">{list.message}</p>;
  const groups = scheduleGroups(list.reply.tasks, agentId, snapshot);
  if (!groups.length) return <SettingsGroup label="任务" footer="在群详情页或私聊页的「任务」里新建。"><SettingsRow title="这个 Bot 还没有任务"/></SettingsGroup>;
  return <>{groups.map(({chatId, name, memberId, dm, tasks}) => <SettingsGroup key={chatId} label={name}>
    {tasks.map(task => {
      const description = scheduleSummary(task, list.reply.timeZone, list.reply.now);
      const open = dm ? snapshot.agents.find(item => item.id === agentId)?.dm && onOpenDm : memberId && (() => onOpen(memberId));
      return open
        ? <SettingsRow key={task.id} title={task.name} description={description} onClick={open}/>
        : <SettingsRow key={task.id} title={task.name} description={description} trailing={<Button size="sm" variant="ghost" onClick={() => onDelete(task)}>删除</Button>}/>;
    })}
  </SettingsGroup>)}</>;
}

/** Reads when opened and after a delete, with no polling. A failed read offers 重试; when nothing was read yet, that is all it shows. */
export function BotSchedules({agentId, snapshot, onOpen, onOpenDm}: {agentId: AgentId; snapshot: DesktopSnapshot; onOpen: (memberId: MembershipId) => void; onOpenDm?: () => void}) {
  const client = useClient();
  const [list, setList] = useState<ScheduleList>({kind: 'loading'});
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<ScheduledTaskView>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    client.schedule(agentId, {action: 'listBot'}).then(listOf).then(next => {if (active) {setList(next); setError('');}},
      failure => {if (active) setError(failure instanceof Error && failure.message ? failure.message : '任务读取失败。');});
    return () => {active = false;};
  }, [client, agentId, version]);
  const retry = <Button size="sm" onClick={() => {setError(''); setVersion(value => value + 1);}}>重试</Button>;
  return <section id={settingAnchor('任务')} aria-label="任务">
    {error && <InlineNotice title="任务读取未完成" tone="warning" actions={retry}>{error}</InlineNotice>}
    {!(error && list.kind === 'loading') && <BotScheduleGroups list={list} agentId={agentId} snapshot={snapshot} onOpen={onOpen} onOpenDm={onOpenDm} onDelete={setDeleting}/>}
    {deleting && <ScheduleDeleteDialog key={deleting.id} task={deleting} send={request => client.schedule(agentId, request)} onClose={() => {setDeleting(undefined); setVersion(value => value + 1);}}/>}
  </section>;
}
