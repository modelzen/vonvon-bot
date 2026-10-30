import type {ScheduledTaskView, ScheduleReply} from '@vonvon/protocol';

/** 2026-11-01 12:00 in Shanghai. */
export const scheduleNow = Date.UTC(2026, 10, 1, 4, 0);
export const scheduleTask = (patch: Partial<ScheduledTaskView> = {}): ScheduledTaskView => ({
  id: 'st_00000000000000a1', botId: 'cli_schedule', chatId: 'oc_schedule', revision: 'r1', name: '日报', instruction: '汇总今天的提交',
  spec: {kind: 'daily', time: '09:00'}, timeZone: 'Asia/Shanghai', placement: {kind: 'follow'}, state: 'active',
  createdBy: {via: 'desktop'}, createdAt: 0, updatedAt: 0, nextRunAt: Date.UTC(2026, 10, 2, 1, 0), running: false,
  counts: {runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0}, recent: [], describe: '每天 09:00', ...patch,
});
export const tasksReply = (tasks: ScheduledTaskView[], timeZone = 'Asia/Shanghai'): Extract<ScheduleReply, {kind: 'tasks'}> =>
  ({kind: 'tasks', tasks, now: scheduleNow, timeZone});
