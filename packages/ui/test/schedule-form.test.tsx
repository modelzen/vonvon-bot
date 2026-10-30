import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import type {ScheduledTaskView, ScheduleReply} from '@vonvon/protocol';
import {ScheduleForm, localInput, scheduleDraft, scheduleRequest, zonedInstant, type ScheduleDraft} from '../src/ScheduleForm';
import {scheduleConflict} from '../src/schedule-model';
import {scheduleNow, scheduleTask} from './schedule-fixture';

const harness = vi.hoisted(() => ({state: [] as unknown[], index: 0}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
  useId: () => 'form',
  useState: (initial: unknown) => {
    const index = harness.index++;
    if (!(index in harness.state)) harness.state[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [harness.state[index], (next: unknown) => {harness.state[index] = typeof next === 'function' ? (next as (value: unknown) => unknown)(harness.state[index]) : next;}];
  },
}));
type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...nodes(node.props.children), ...nodes(node.props.footer)];
}
const send = vi.fn(async (_request: unknown): Promise<ScheduleReply> => ({kind: 'task', task: scheduleTask()}));
const onClose = vi.fn();
function render(task: ScheduledTaskView | undefined) {
  harness.index = 0;
  const all = nodes(ScheduleForm({chatId: 'oc_schedule', task, hostTimeZone: 'UTC', send, onClose, now: () => scheduleNow}));
  return {
    input: (key: string) => all.find(node => node.props.id === `form-${key}`)!,
    choices: (label: string) => all.find(node => node.props.label === label && node.props.choices)!,
    button: (text: string) => all.find(node => node.props.children === text && node.props.onClick)!,
    notice: () => all.find(node => node.props.title === '没有保存')?.props.children,
  };
}
async function save(task: ScheduledTaskView) {await render(task).button('保存').props.onClick(); for (let i = 0; i < 4; i++) await Promise.resolve();}
beforeEach(() => {harness.state = []; send.mockClear(); onClose.mockClear();});

const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({...scheduleDraft(undefined, 'Asia/Shanghai'), name: '日报', instruction: '汇总', ...patch});
const create = (patch: Partial<ScheduleDraft>) => scheduleRequest(draft(patch), {chatId: 'oc_schedule', now: scheduleNow});

it('turns each kind of time into its spec and always names the zone', () => {
  expect(create({when: 'once', at: '2026-11-01T14:00'})).toEqual({action: 'create', chatId: 'oc_schedule', name: '日报', instruction: '汇总',
    spec: {kind: 'once', at: Date.UTC(2026, 10, 1, 6, 0)}, placement: {kind: 'follow'}, timeZone: 'Asia/Shanghai'});
  expect(create({when: 'every', minutes: '30'})).toMatchObject({spec: {kind: 'every', minutes: 30}});
  expect(create({when: 'every', minutes: '30'})).not.toHaveProperty('spec.anchor');
  expect(create({when: 'daily', time: '09:00'})).toMatchObject({spec: {kind: 'daily', time: '09:00'}});
  expect(create({when: 'cron', expr: '0 9 * * 1-5', placement: 'newTopic'})).toMatchObject({spec: {kind: 'cron', expr: '0 9 * * 1-5'}, placement: {kind: 'newTopic'}});
});

it('reads a datetime-local value in the form\'s zone, past a skipped hour and on the first of a repeated one', () => {
  expect(zonedInstant('2026-11-01T14:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 1, 5, 0));
  expect(zonedInstant('2026-03-08T02:30', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7, 30));
  expect(zonedInstant('2026-11-01T01:30', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 5, 30));
  expect(zonedInstant('2026-03-29T01:30', 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 0, 30));
  expect(localInput(Date.UTC(2026, 10, 1, 6, 0), 'Asia/Shanghai')).toBe('2026-11-01T14:00');
});

it('checks the form before sending', () => {
  expect(create({name: '  '})).toEqual({error: '名字不能空'});
  expect(create({name: '名'.repeat(41)})).toEqual({error: '名字最多 40 字'});
  expect(create({instruction: '字'.repeat(4001)})).toEqual({error: '要做什么最多 4000 字'});
  expect(create({when: 'once', at: '2026-11-01T11:59'})).toEqual({error: '一次性任务的时间已经过了'});
  expect(create({timeZone: 'Mars/Olympus'})).toEqual({error: '不认识这个时区：Mars/Olympus'});
  expect(create({when: 'weekly', days: []})).toEqual({error: '星期要在 0 到 6 之间，至少一个'});
});

it('keeps a task on its topic unless another placement is chosen, and a new form has two placements', async () => {
  const topic = scheduleTask({placement: {kind: 'topic', topicId: 't1'}, spec: {kind: 'once', at: scheduleNow - 60_000}});
  const choices = render(topic).choices('发到哪').props;
  expect(choices.value).toBe('topic');
  expect(choices.choices.map((choice: {label: string}) => choice.label)).toEqual(['跟群走', '每次开新话题', '固定在原话题']);
  await save(topic);
  expect(send).toHaveBeenLastCalledWith({action: 'edit', chatId: 'oc_schedule', taskId: topic.id, revision: 'r1', patch: {}});
  expect(onClose).toHaveBeenCalledOnce();
  render(topic).choices('发到哪').props.onChange('follow');
  await save(topic);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({patch: {placement: {kind: 'follow'}}}));
  harness.state = [];
  expect(render(undefined).choices('发到哪').props.choices.map((choice: {value: string}) => choice.value)).toEqual(['follow', 'newTopic']);
});

it('sends 工作日 as Monday to Friday', async () => {
  const task = scheduleTask();
  render(task).choices('什么时候').props.onChange('weekly');
  render(task).button('工作日').props.onClick();
  await save(task);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({patch: {spec: {kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00'}}}));
});

it('on a conflict loads the task as it is now and keeps what the user typed, read-only, below', async () => {
  const task = scheduleTask();
  send.mockResolvedValueOnce({kind: 'conflict', current: {...task, name: '别人改的', revision: 'r2'}});
  render(task).input('name').props.onChange({target: {value: '我改的'}});
  await save(task);
  const ui = render(task);
  expect(ui.input('name').props.value).toBe('别人改的');
  expect(ui.input('stale').props.readOnly).toBe(true);
  expect(ui.input('stale').props.value).toContain('名字：我改的');
  expect(ui.notice()).toBe(scheduleConflict);
  expect(onClose).not.toHaveBeenCalled();
  await save(task);
  expect(send).toHaveBeenLastCalledWith(expect.objectContaining({revision: 'r2', patch: {}}));
});

it('shows the daemon\'s bad-schedule text as it is', async () => {
  send.mockResolvedValueOnce({kind: 'refused', reason: 'bad-schedule', message: 'cron 不合法：第 2 段超出范围'});
  const task = scheduleTask();
  render(task).choices('什么时候').props.onChange('cron');
  render(task).input('cron').props.onChange({target: {value: '0 25 * * *'}});
  await save(task);
  expect(render(task).notice()).toBe('cron 不合法：第 2 段超出范围');
});
