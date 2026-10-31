import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {ScheduleReply, ScheduleRequest} from '@vonvon/protocol';
import {startScheduleSession} from '../src/ScheduleTab';
import {scheduleNotRunning} from '../src/schedule-model';
import {scheduleTask, tasksReply} from './schedule-fixture';

const show = {list: vi.fn(), error: vi.fn()};
beforeEach(() => {vi.useFakeTimers(); show.list.mockClear(); show.error.mockClear();});
afterEach(() => vi.useRealTimers());
const lists = (send: ReturnType<typeof vi.fn>) => send.mock.calls.filter(([request]) => (request as ScheduleRequest).action === 'list').length;

it('reads at once and every 10 seconds, and leaves no timer once stopped', async () => {
  const send = vi.fn(async (_request: ScheduleRequest): Promise<ScheduleReply> => tasksReply([]));
  const session = startScheduleSession(send, 'oc_schedule', show);
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledExactlyOnceWith({action: 'list', chatId: 'oc_schedule'});
  await vi.advanceTimersByTimeAsync(10_000);
  expect(send).toHaveBeenCalledTimes(2);
  session.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledTimes(2);
});

it('reads again as soon as a write is answered, refused or not, and a task deleted meanwhile drops out', async () => {
  const task = scheduleTask();
  let current = [task];
  const send = vi.fn(async (request: ScheduleRequest): Promise<ScheduleReply> => request.action === 'list' ? tasksReply(current)
    : {kind: 'refused', reason: 'running', message: '这个任务正在运行，等它结束再试。'});
  const session = startScheduleSession(send, 'oc_schedule', show);
  await vi.advanceTimersByTimeAsync(0);
  current = [];
  await expect(session.write({action: 'runNow', chatId: 'oc_schedule', taskId: task.id})).resolves.toMatchObject({kind: 'refused'});
  await vi.advanceTimersByTimeAsync(0);
  expect(lists(send)).toBe(2);
  expect(show.list).toHaveBeenLastCalledWith({kind: 'tasks', reply: tasksReply([])});
  session.stop();
});

it('reads again as soon as a write saves or fails, and the failure still reaches the caller', async () => {
  const task = scheduleTask();
  const send = vi.fn(async (request: ScheduleRequest): Promise<ScheduleReply> => request.action === 'list' ? tasksReply([task]) : {kind: 'task', task});
  const session = startScheduleSession(send, 'oc_schedule', show);
  await vi.advanceTimersByTimeAsync(0);
  await expect(session.write({action: 'pause', chatId: 'oc_schedule', taskId: task.id})).resolves.toEqual({kind: 'task', task});
  await vi.advanceTimersByTimeAsync(0);
  expect(lists(send)).toBe(2);
  send.mockRejectedValueOnce(new Error('Daemon connection closed'));
  await expect(session.write({action: 'resume', chatId: 'oc_schedule', taskId: task.id})).rejects.toThrow('Daemon connection closed');
  await vi.advanceTimersByTimeAsync(0);
  expect(lists(send)).toBe(3);
  expect(send).toHaveBeenCalledTimes(5);
  session.stop();
});

it('drops a reply that arrives after a newer read or after stopping', async () => {
  const replies: ((reply: ScheduleReply) => void)[] = [];
  const send = vi.fn((_request: ScheduleRequest) => new Promise<ScheduleReply>(resolve => replies.push(resolve)));
  const session = startScheduleSession(send, 'oc_schedule', show);
  await vi.advanceTimersByTimeAsync(10_000);
  replies[1]!(tasksReply([]));
  replies[0]!(tasksReply([scheduleTask()]));
  await vi.advanceTimersByTimeAsync(0);
  expect(show.list).toHaveBeenCalledExactlyOnceWith({kind: 'tasks', reply: tasksReply([])});
  await vi.advanceTimersByTimeAsync(10_000);
  session.stop();
  replies[2]!(tasksReply([scheduleTask()]));
  await vi.advanceTimersByTimeAsync(0);
  expect(show.list).toHaveBeenCalledOnce();
});

it('shows a stopped bot as its sentence, and a failed read as an error that keeps the list', async () => {
  const send = vi.fn(async (_request: ScheduleRequest): Promise<ScheduleReply> => ({kind: 'refused', reason: 'bot-not-running', message: scheduleNotRunning}));
  const session = startScheduleSession(send, 'oc_schedule', show);
  await vi.advanceTimersByTimeAsync(0);
  expect(show.list).toHaveBeenLastCalledWith({kind: 'refused', message: scheduleNotRunning});
  send.mockRejectedValueOnce(new Error('Daemon connection closed'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(show.error).toHaveBeenCalledExactlyOnceWith('Daemon connection closed');
  expect(show.list).toHaveBeenCalledOnce();
  session.stop();
});
