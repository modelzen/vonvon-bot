import {Fragment, useEffect, useRef, useState} from 'react';
import {Plus} from 'lucide-react';
import type {ScheduledTaskView, ScheduleRequest} from '@vonvon/protocol';
import {useClient} from './client-context';
import {settingAnchor} from './search';
import {SettingsGroup, SettingsRow} from './reference/components/system-settings';
import {Button, InlineNotice} from './reference/components/ui';
import {ConfirmDialog} from './reference/components/ui/Dialog';
import {ScheduleForm} from './ScheduleForm';
import {ScheduleRuns} from './ScheduleRuns';
import {listOf, refusalText, scheduleFooter, scheduleSummary, type ScheduleList, type ScheduleSend} from './schedule-model';
import './schedule.css';

export type ScheduleSession = {write: ScheduleSend; stop(): void};
/** Reads the group's tasks now and every `everyMs` until stopped (no push, overview section 12); each write reads them again once answered. */
export function startScheduleSession(send: ScheduleSend, chatId: string, show: {list: (list: ScheduleList) => void; error: (message: string) => void}, everyMs = 10_000): ScheduleSession {
  let latest = 0;
  let stopped = false;
  async function read() {
    const mine = ++latest;
    try {
      const list = listOf(await send({action: 'list', chatId}));
      if (!stopped && mine === latest) show.list(list);
    } catch (failure) {
      if (!stopped && mine === latest) show.error(failure instanceof Error && failure.message ? failure.message : '任务读取失败。');
    }
  }
  void read();
  const timer = setInterval(() => void read(), everyMs);
  return {
    async write(request) {
      try {return await send(request);}
      finally {if (!stopped) void read();}
    },
    stop() {stopped = true; clearInterval(timer);},
  };
}

type RowAction = 'edit' | 'pause' | 'resume' | 'runNow' | 'delete' | 'expand';
/**
 * The list as it reads: one row a task, its buttons, and the opened task's runs. A refused list replaces the page, so there is no 新建.
 * 已结束 has no 恢复: the daemon leaves a finished task as it is, and a new time in 编辑 starts it again.
 */
export function ScheduleTaskList({list, deviceTitle, expanded, busy, notices, onCreate, onAction}: {
  list: ScheduleList; deviceTitle: string; expanded?: string; busy?: string; notices: Readonly<Record<string, string>>;
  onCreate: () => void; onAction: (action: RowAction, task: ScheduledTaskView) => void;
}) {
  if (list.kind === 'loading') return <p className="group-control-note" role="status">正在读取任务…</p>;
  if (list.kind === 'refused') return <p className="group-control-note" role="status">{list.message}</p>;
  const {tasks, now, timeZone} = list.reply;
  return <SettingsGroup label="任务" action={<Button size="sm" icon={<Plus size={13} aria-hidden="true"/>} onClick={onCreate}>新建</Button>} footer={scheduleFooter(deviceTitle)}>
    {tasks.length ? tasks.map(task => <Fragment key={task.id}>
      <SettingsRow title={task.name} description={scheduleSummary(task, timeZone, now)} trailing={<>
        <Button size="sm" variant="ghost" aria-expanded={expanded === task.id} onClick={() => onAction('expand', task)}>记录</Button>
        <Button size="sm" disabled={busy === task.id} onClick={() => onAction('edit', task)}>编辑</Button>
        {task.state !== 'finished' && <Button size="sm" disabled={busy === task.id} onClick={() => onAction(task.state === 'active' ? 'pause' : 'resume', task)}>{task.state === 'active' ? '暂停' : '恢复'}</Button>}
        <Button size="sm" disabled={busy === task.id} onClick={() => onAction('runNow', task)}>立即运行</Button>
        <Button size="sm" variant="ghost" disabled={busy === task.id} onClick={() => onAction('delete', task)}>删除</Button>
      </>}/>
      {notices[task.id] && <p className="group-control-note schedule-note" role="status">{notices[task.id]}</p>}
      {expanded === task.id && <ScheduleRuns task={task} hostZone={timeZone} now={now}/>}
    </Fragment>) : <SettingsRow title="这个群还没有任务"/>}
  </SettingsGroup>;
}

/** 删除 asks first. A change made meanwhile is a conflict: the dialog takes the new revision and asks again. */
export function ScheduleDeleteDialog({task, send, onClose}: {task: ScheduledTaskView; send: ScheduleSend; onClose: () => void}) {
  const [revision, setRevision] = useState(task.revision);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function confirm() {
    setPending(true); setError('');
    try {
      const reply = await send({action: 'delete', chatId: task.chatId, taskId: task.id, revision});
      if (reply.kind === 'deleted') return onClose();
      if (reply.kind === 'conflict') {setRevision(reply.current.revision); setError('这个任务刚被改过；还要删就再点一次。');}
      else setError(reply.kind === 'refused' ? refusalText(reply) : '没有删除，请重试。');
    } catch (failure) {setError(failure instanceof Error ? failure.message : '没有删除，请重试。');}
    finally {setPending(false);}
  }
  return <ConfirmDialog open title={`删除任务「${task.name}」？`} description="连同运行记录一起删除，不能撤销。" confirmLabel="删除" tone="danger"
    pending={pending} error={error} onCancel={onClose} onConfirm={() => void confirm()}/>;
}

/** The group page's 任务 tab: every write goes through `client.schedule`; refusals show where the action was. */
export function ScheduleTab({botId, chatId, deviceTitle}: {botId: string; chatId: string; deviceTitle: string}) {
  const client = useClient();
  const [list, setList] = useState<ScheduleList>({kind: 'loading'});
  const [error, setError] = useState('');
  const [form, setForm] = useState<{task?: ScheduledTaskView; hostTimeZone: string}>();
  const [deleting, setDeleting] = useState<ScheduledTaskView>();
  const [expanded, setExpanded] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notices, setNotices] = useState<Record<string, string>>({});
  const session = useRef<ScheduleSession>(undefined);
  useEffect(() => {
    const current = startScheduleSession(request => client.schedule(botId, request), chatId, {list: next => {setList(next); setError('');}, error: setError});
    session.current = current;
    return () => current.stop();
  }, [client, botId, chatId]);
  // Rows and 新建 appear only once the session's first list is in.
  const write: ScheduleSend = request => session.current!.write(request);
  async function act(task: ScheduledTaskView, request: ScheduleRequest, done = '') {
    setBusy(task.id); setNotices(current => ({...current, [task.id]: ''}));
    let notice = done;
    try {
      const reply = await write(request);
      if (reply.kind === 'refused') notice = refusalText(reply);
    } catch (failure) {notice = failure instanceof Error ? failure.message : '操作没有完成，请重试。';}
    setBusy(undefined); setNotices(current => ({...current, [task.id]: notice}));
  }
  function onAction(action: RowAction, task: ScheduledTaskView) {
    if (action === 'expand') setExpanded(current => current === task.id ? undefined : task.id);
    else if (action === 'edit') setForm({task, hostTimeZone: list.kind === 'tasks' ? list.reply.timeZone : task.timeZone});
    else if (action === 'delete') setDeleting(task);
    else void act(task, {action, chatId, taskId: task.id}, action === 'runNow' ? '已开始运行，结果会发到群里。' : '');
  }
  return <section id={settingAnchor('任务')} aria-label="任务">
    {error && <InlineNotice title="任务读取未完成" tone="warning">{error}</InlineNotice>}
    <ScheduleTaskList list={list} deviceTitle={deviceTitle} expanded={expanded} busy={busy} notices={notices} onAction={onAction}
      onCreate={() => list.kind === 'tasks' && setForm({hostTimeZone: list.reply.timeZone})}/>
    {form && <ScheduleForm chatId={chatId} task={form.task} hostTimeZone={form.hostTimeZone} send={write} onClose={() => setForm(undefined)}/>}
    {deleting && <ScheduleDeleteDialog key={deleting.id} task={deleting} send={write} onClose={() => setDeleting(undefined)}/>}
  </section>;
}
