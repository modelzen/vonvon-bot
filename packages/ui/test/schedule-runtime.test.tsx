import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {agentIdSchema, type DesktopSnapshot, type ScheduleReply, type ScheduleRequest} from '@vonvon/protocol';
import {BotScheduleGroups, BotSchedules} from '../src/BotSchedules';
import {ScheduleDeleteDialog} from '../src/ScheduleTab';
import {scheduleTask, tasksReply} from './schedule-fixture';

const h = vi.hoisted(() => ({state: [] as unknown[], effects: [] as Array<{deps?: unknown[]}>, pending: [] as Array<() => void>, si: 0, ei: 0, client: {schedule: vi.fn()}}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useState: (initial: unknown) => {const i = h.si++; if (!(i in h.state)) h.state[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [h.state[i], (next: unknown) => {h.state[i] = typeof next === 'function' ? (next as (old: unknown) => unknown)(h.state[i]) : next;}];},
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {const i = h.ei++; const old = h.effects[i]; if (old?.deps && deps && deps.every((value, at) => Object.is(value, old.deps![at]))) return; h.pending.push(() => {h.effects[i] = {deps}; effect();});},
}));
vi.mock('../src/client-context', () => ({useClient: () => h.client, useShellCapabilities: () => ({})}));

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.actions)];
}
function render(make: () => ReactNode): Element[] {
  h.si = 0; h.ei = 0;
  const all = nodes(make());
  for (const effect of h.pending.splice(0)) effect();
  return all;
}
const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
beforeEach(() => {h.state = []; h.effects = []; h.pending = []; h.client.schedule.mockReset();});

it('deletes with the revision a conflict brought, after saying the task was just changed', async () => {
  const task = scheduleTask();
  const send = vi.fn(async (_request: ScheduleRequest): Promise<ScheduleReply> => ({kind: 'deleted', taskId: task.id}));
  send.mockResolvedValueOnce({kind: 'conflict', current: {...task, revision: 'r2'}});
  const onClose = vi.fn();
  const dialog = () => render(() => ScheduleDeleteDialog({task, send, onClose}))[0]!;
  dialog().props.onConfirm();
  await flush();
  expect(dialog().props.error).toBe('这个任务刚被改过；还要删就再点一次。');
  expect(onClose).not.toHaveBeenCalled();
  dialog().props.onConfirm();
  await flush();
  expect(send.mock.calls.map(([request]) => (request as {revision: string}).revision)).toEqual(['r1', 'r2']);
  expect(onClose).toHaveBeenCalledOnce();
});

it('on the Bot page shows only the error and 重试 after a failed first read, and 重试 reads again', async () => {
  const agentId = agentIdSchema.parse('cli_schedule');
  const snapshot = {groups: [], memberships: []} as unknown as DesktopSnapshot;
  const page = () => render(() => BotSchedules({agentId, snapshot, onOpen: () => {}}));
  h.client.schedule.mockRejectedValueOnce(new Error('Daemon connection closed')).mockResolvedValueOnce(tasksReply([scheduleTask()]));
  page();
  await flush();
  const failed = page();
  expect(failed.find(node => node.props.title === '任务读取未完成')?.props.children).toBe('Daemon connection closed');
  expect(failed.some(node => node.type === BotScheduleGroups)).toBe(false);
  failed.find(node => node.props.children === '重试')!.props.onClick();
  page();
  await flush();
  const read = page();
  expect(h.client.schedule.mock.calls).toEqual([[agentId, {action: 'listBot'}], [agentId, {action: 'listBot'}]]);
  expect(read.some(node => node.props.title === '任务读取未完成')).toBe(false);
  expect(read.find(node => node.type === BotScheduleGroups)?.props.list).toMatchObject({kind: 'tasks'});
});
