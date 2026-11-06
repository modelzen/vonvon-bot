import {beforeEach, expect, it, vi} from 'vitest';
import {isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {ScheduledTaskView, ScheduleReply, ScheduleRequest} from '@vonvon/protocol';
import {ScheduleForm, localInput, scheduleDraft, scheduleRequest, zonedInstant, type ScheduleDraft} from '../src/ScheduleForm';
import {browserZone, scheduleConflict} from '../src/schedule-model';
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
function render(task: ScheduledTaskView | undefined, hostTimeZone = 'UTC') {
  harness.index = 0;
  const all = nodes(ScheduleForm({chatId: 'oc_schedule', task, hostTimeZone, send, onClose, now: () => scheduleNow}));
  return {
    input: (key: string) => all.find(node => node.props.id === `form-${key}`)!,
    choices: (label: string) => all.find(node => node.props.label === label && node.props.choices)!,
    button: (text: string) => all.find(node => node.props.children === text && node.props.onClick)!,
    notice: () => all.find(node => node.props.title === '没有保存')?.props.children,
    zoneNote: () => renderToStaticMarkup(<>{all.find(node => node.props.label === '时区' && node.props.htmlFor)!.props.description}</>),
  };
}
async function save(task: ScheduledTaskView, hostTimeZone?: string) {await render(task, hostTimeZone).button('保存').props.onClick(); for (let i = 0; i < 4; i++) await Promise.resolve();}
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

it('sends only what changed: a new name alone, a daily task\'s zone alone, and a once task\'s zone with the instant it now names', async () => {
  async function change(task: ScheduledTaskView, key: string, value: string) {
    harness.state = [];
    render(task).input(key).props.onChange({target: {value}});
    await save(task);
    return (send.mock.lastCall![0] as Extract<ScheduleRequest, {action: 'edit'}>).patch;
  }
  const daily = scheduleTask();
  expect(await change(daily, 'name', '晨报')).toEqual({name: '晨报'});
  expect(await change(daily, 'zone', 'Asia/Tokyo')).toEqual({timeZone: 'Asia/Tokyo'});
  // 14:00 on 2 November in Shanghai, then 14:00 in Tokyo.
  const once = scheduleTask({spec: {kind: 'once', at: Date.UTC(2026, 10, 2, 6, 0)}});
  expect(await change(once, 'zone', 'Asia/Tokyo')).toEqual({spec: {kind: 'once', at: Date.UTC(2026, 10, 2, 5, 0)}, timeZone: 'Asia/Tokyo'});
});

it('opens a once task in a zone this browser does not know at its time in the daemon\'s zone, says so only for that time, after a conflict too, and does not save that zone', async () => {
  const at = Date.UTC(2026, 10, 2, 1, 0);
  // A daemon zone whose clock is not this machine's, so the browser's zone would show another time.
  const [host, shown] = ([['Asia/Tokyo', '2026-11-02T10:00'], ['America/New_York', '2026-11-01T20:00']] as const).find(([zone]) => localInput(at, zone) !== localInput(at, browserZone()))!;
  const note = `这个时区这里不认识，上面的时间按 ${host} 显示；换成认识的时区后保存`;
  const mars = scheduleTask({spec: {kind: 'once', at}, timeZone: 'Mars/Olympus', revision: 'r2'});
  const opened = render(mars, host);
  expect([opened.input('at').props.value, opened.input('zone').props.value]).toEqual([shown, 'Mars/Olympus']);
  expect(opened.zoneNote()).toContain(note);
  await save(mars, host);
  expect(send).not.toHaveBeenCalled();
  expect(render(mars, host).notice()).toBe('不认识这个时区：Mars/Olympus');
  render(mars, host).input('zone').props.onChange({target: {value: 'Mars/Olymp'}});
  expect(render(mars, host).zoneNote()).not.toContain('不认识');
  harness.state = [];
  // Switched to 每天 there is no 时间 field left for the note to describe.
  render(mars, host).choices('什么时候').props.onChange('daily');
  expect(render(mars, host).zoneNote()).toBe(`Vonvon 所在电脑的时区是 ${host}`);
  harness.state = [];
  const daily: ScheduledTaskView = {...mars, spec: {kind: 'daily', time: '09:00'}};
  expect(render(daily, host).zoneNote()).toBe(`Vonvon 所在电脑的时区是 ${host}`);
  // Picking 一次 on it shows an empty time, so there is no time the note could describe.
  render(daily, host).choices('什么时候').props.onChange('once');
  expect([render(daily, host).input('at').props.value, render(daily, host).zoneNote()]).toEqual(['', `Vonvon 所在电脑的时区是 ${host}`]);
  harness.state = [];
  expect(render(scheduleTask({spec: {kind: 'once', at}, timeZone: 'Asia/Tokyo'}), host).zoneNote()).toBe(`Vonvon 所在电脑的时区是 ${host}`);
  harness.state = [];
  const task = scheduleTask();
  expect(render(task, host).zoneNote()).toBe(`Vonvon 所在电脑的时区是 ${host}`);
  send.mockResolvedValueOnce({kind: 'conflict', current: mars});
  render(task, host).input('name').props.onChange({target: {value: '我改的'}});
  await save(task, host);
  expect(render(task, host).input('at').props.value).toBe(shown);
  expect(render(task, host).zoneNote()).toContain(note);
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

// dm-agent 10 (D4). main 必败: a new task could only go to the chat the page was on
it('asks whose private chat a new task posts to, and offers no topic there', async () => {
  const chats = [{value: 'oc_p2p_a', label: '张三'}, {value: 'oc_p2p_b', label: '李四'}];
  const dmForm = () => {
    harness.index = 0;
    const all = nodes(ScheduleForm({chats, hostTimeZone: 'UTC', send, onClose, now: () => scheduleNow}));
    return {choices: (label: string) => all.find(node => node.props.label === label && node.props.choices), input: (key: string) => all.find(node => node.props.id === `form-${key}`)!, button: (text: string) => all.find(node => node.props.children === text && node.props.onClick)!};
  };
  expect(dmForm().choices('发到哪')).toBeUndefined();
  expect(dmForm().choices('发给谁')!.props.choices).toEqual(chats);
  dmForm().choices('发给谁')!.props.onChange('oc_p2p_b');
  dmForm().input('name').props.onChange({target: {value: '早报'}});
  dmForm().input('instruction').props.onChange({target: {value: '发今天的安排'}});
  await dmForm().button('保存').props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action: 'create', chatId: 'oc_p2p_b', name: '早报'}));
});

it('keeps a private task on its own chat when editing it, with no choice of person', async () => {
  const task = scheduleTask({chatId: 'oc_p2p_a', dm: {name: '张三'}});
  harness.index = 0;
  const all = nodes(ScheduleForm({chats: [{value: 'oc_p2p_b', label: '李四'}], task, hostTimeZone: 'UTC', send, onClose, now: () => scheduleNow}));
  expect(all.some(node => node.props.label === '发给谁' || node.props.label === '发到哪')).toBe(false);
  all.find(node => node.props.id === 'form-name')!.props.onChange({target: {value: '改过'}});
  harness.index = 0;
  await nodes(ScheduleForm({chats: [{value: 'oc_p2p_b', label: '李四'}], task, hostTimeZone: 'UTC', send, onClose, now: () => scheduleNow})).find(node => node.props.children === '保存' && node.props.onClick)!.props.onClick();
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({action: 'edit', chatId: 'oc_p2p_a', taskId: task.id}));
});
