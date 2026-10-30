import {formatTime, type ScheduledTaskView, type ScheduleReply, type ScheduleRequest, type ScheduleRunRecord} from '@vonvon/protocol';
import {allowedExternalUrl, groupUrl} from './url-actions';

/** What the 任务 tab and the Bot page show of scheduled tasks (docs/plans/scheduled-tasks.md sections 12 and 16). */
export type TasksReply = Extract<ScheduleReply, {kind: 'tasks'}>;
export type ScheduleList = {kind: 'loading'} | {kind: 'refused'; message: string} | {kind: 'tasks'; reply: TasksReply};
export type ScheduleSend = (request: ScheduleRequest) => Promise<ScheduleReply>;

export const scheduleNotRunning = 'Bot 没在运行，任务暂时看不到；启动后再来。';
export const scheduleConflict = '别人改过了，已刷新成现在的内容；你刚才填的在下面，要的话再改一次。';
export const scheduleFooter = (device: string) => `${device}关机、睡眠，或 Vonvon 没在运行时，任务不会运行。错过的只补最近一次（7 天内），更早的记为"错过"。`;
export const runStatusText = {done: '完成', failed: '失败', missed: '错过', skipped: '跳过', interrupted: '中断'} as const;
const pausedText = {manual: '已暂停：手动', failures: '已暂停：连续失败', unavailable: '已暂停：群已解绑'} as const;

export const refusalText = (reply: Extract<ScheduleReply, {kind: 'refused'}>) => reply.reason === 'bot-not-running' ? scheduleNotRunning : reply.message;
/** A list reply as the page shows it; anything but tasks or a refusal is a broken reply. */
export function listOf(reply: ScheduleReply): ScheduleList {
  if (reply.kind === 'tasks') return {kind: 'tasks', reply};
  if (reply.kind === 'refused') return {kind: 'refused', message: refusalText(reply)};
  throw new Error('任务读取失败。');
}

/** 已启用, not 运行中: a run in flight is a 运行中任务 (product.md section 2). */
export function scheduleState(task: ScheduledTaskView): string {
  return task.state === 'active' ? '已启用' : task.state === 'finished' ? '已结束' : pausedText[task.pausedReason ?? 'manual'];
}

/** One row: 每个工作日 09:00 · 下次 09:00 · 已启用 · 上次 完成 09:00. Times are in the task's zone, named when the daemon's computer is in another. */
export function scheduleSummary(task: ScheduledTaskView, hostZone: string, now?: number): string {
  const at = (ms: number) => formatTime(ms, {timeZone: task.timeZone, now});
  const zone = task.timeZone === hostZone ? '' : `（${task.timeZone}）`;
  return [
    task.describe,
    task.nextRunAt !== undefined && `下次 ${at(task.nextRunAt)}${zone}`,
    scheduleState(task),
    task.lastResult && `上次 ${runStatusText[task.lastResult.status]} ${at(task.lastResult.at)}`,
  ].filter(Boolean).join(' · ');
}

/** 在飞书打开: the link the daemon resolved for the run, else its topic; the page never builds a message link itself. */
export function scheduleRunLink(record: ScheduleRunRecord, chatId: string): string | null {
  return (record.link ? allowedExternalUrl(record.link, 'group') : null)
    ?? (record.topicId ? allowedExternalUrl(groupUrl(chatId, record.topicId), 'group') : null);
}
