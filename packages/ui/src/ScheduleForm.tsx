import {useId, useState} from 'react';
import type {ScheduledTaskView, ScheduleRequest, ScheduleSpec} from '@vonvon/protocol';
import {Button, FormField, InlineNotice} from './reference/components/ui';
import {Dialog} from './reference/components/ui/Dialog';
import {SettingChoices} from './settings/SettingChoices';
import {browserZone, knownZone, refusalText, scheduleConflict, schedulePlacementText as placementText, shownZone, type ScheduleSend} from './schedule-model';

type Placement = 'follow' | 'newTopic' | 'topic';
export type ScheduleDraft = {
  name: string; instruction: string; when: ScheduleSpec['kind'];
  at: string; minutes: string; time: string; days: number[]; expr: string;
  placement: Placement; timeZone: string;
};

const WORKDAYS = [1, 2, 3, 4, 5];
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const whenChoices = [{value: 'once', label: '一次'}, {value: 'every', label: '每 N 分钟'}, {value: 'daily', label: '每天'}, {value: 'weekly', label: '每周'}, {value: 'cron', label: 'cron'}] as const;

function wall(ms: number, timeZone: string): number {
  const format = new Intl.DateTimeFormat('en-US', {timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'});
  const part = Object.fromEntries(format.formatToParts(new Date(ms)).map(item => [item.type, Number(item.value)]));
  return Date.UTC(part.year!, part.month! - 1, part.day!, part.hour!, part.minute!);
}
/** The `datetime-local` value of `ms` read in `timeZone`. */
export function localInput(ms: number, timeZone: string): string {
  return new Date(wall(ms, timeZone)).toISOString().slice(0, 16);
}
/** The instant a `datetime-local` value names in `timeZone`, not the browser's. A time a clock change skips moves past the gap. */
export function zonedInstant(value: string, timeZone: string): number | undefined {
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? Date.parse(`${value}Z`) : NaN;
  if (Number.isNaN(local)) return undefined;
  const offset = (ms: number) => wall(ms, timeZone) - ms;
  const first = local - offset(local);
  const second = local - offset(first);
  return offset(second) === offset(first) ? second : Math.max(first, second);
}
/**
 * A new form starts in `zone`, the browser's by default. An edit starts from the task; a zone this browser does not know
 * stays in the form, so saving asks for one it knows, and a once time is read in `zone` meanwhile.
 */
export function scheduleDraft(task?: ScheduledTaskView, zone = browserZone()): ScheduleDraft {
  const draft: ScheduleDraft = {name: '', instruction: '', when: 'daily', at: '', minutes: '60', time: '09:00', days: [], expr: '', placement: 'follow', timeZone: zone};
  if (!task) return draft;
  const {spec} = task;
  return {
    ...draft, name: task.name, instruction: task.instruction, when: spec.kind, placement: task.placement.kind, timeZone: task.timeZone,
    ...(spec.kind === 'once' ? {at: localInput(spec.at, shownZone(task.timeZone, zone))} : spec.kind === 'every' ? {minutes: String(spec.minutes)}
      : spec.kind === 'cron' ? {expr: spec.expr} : {time: spec.time, days: spec.kind === 'weekly' ? [...spec.days].sort((a, b) => a - b) : []}),
  };
}

/** The fields of the chosen kind, so switching kinds and back is no change. */
function whenKey(draft: ScheduleDraft): string {
  const fields = {once: [draft.at], every: [draft.minutes], daily: [draft.time], weekly: [[...draft.days].sort(), draft.time], cron: [draft.expr.trim()]}[draft.when];
  return JSON.stringify([draft.when, ...fields]);
}
function specOf(draft: ScheduleDraft, timeZone: string, now: number): ScheduleSpec | string {
  switch (draft.when) {
    case 'once': {
      const at = zonedInstant(draft.at, timeZone);
      if (at === undefined) return '一次性任务要填日期和时间';
      return at <= now ? '一次性任务的时间已经过了' : {kind: 'once', at};
    }
    case 'every': {
      const minutes = Number(draft.minutes);
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080 ? {kind: 'every', minutes} : '间隔最短 1 分钟，最长 7 天';
    }
    case 'cron': return draft.expr.trim().split(/\s+/).length === 5 ? {kind: 'cron', expr: draft.expr.trim()} : 'cron 不合法：要写 5 段，用空格隔开';
    default:
      if (!HHMM.test(draft.time)) return '时间要写成 HH:mm';
      if (draft.when === 'daily') return {kind: 'daily', time: draft.time};
      return draft.days.length ? {kind: 'weekly', days: [...draft.days].sort((a, b) => a - b), time: draft.time} : '星期要在 0 到 6 之间，至少一个';
  }
}

/**
 * The request the form sends, or the first thing wrong with it. `timeZone` is always explicit. An edit sends only what
 * changed against `initial` (the task as the form opened it), so a task left on its topic keeps that placement.
 */
export function scheduleRequest(draft: ScheduleDraft, context: {chatId: string; now: number; task?: ScheduledTaskView; initial?: ScheduleDraft}): ScheduleRequest | {error: string} {
  const {chatId, task, initial} = context;
  const name = draft.name.trim(), instruction = draft.instruction.trim(), timeZone = draft.timeZone.trim();
  if (!name) return {error: '名字不能空'};
  if (name.length > 40) return {error: '名字最多 40 字'};
  if (!instruction) return {error: '要做什么不能空'};
  if (instruction.length > 4000) return {error: '要做什么最多 4000 字'};
  if (!knownZone(timeZone)) return {error: `不认识这个时区：${timeZone}`};
  const zoneChanged = task !== undefined && timeZone !== task.timeZone;
  // A once is a wall-clock time, so a new zone makes it a new instant.
  const specChanged = !task || !initial || whenKey(draft) !== whenKey(initial) || (draft.when === 'once' && zoneChanged);
  const spec = specChanged ? specOf(draft, timeZone, context.now) : undefined;
  if (typeof spec === 'string') return {error: spec};
  if (!task) return {action: 'create', chatId, name, instruction, spec: spec!, placement: {kind: draft.placement === 'newTopic' ? 'newTopic' : 'follow'}, timeZone};
  return {action: 'edit', chatId, taskId: task.id, revision: task.revision, patch: {
    ...(name !== task.name ? {name} : {}),
    ...(instruction !== task.instruction ? {instruction} : {}),
    ...(spec ? {spec} : {}),
    ...(zoneChanged ? {timeZone} : {}),
    ...(draft.placement !== 'topic' && draft.placement !== task.placement.kind ? {placement: {kind: draft.placement}} : {}),
  }};
}

/** The read-only copy of what the user had typed, kept when someone else changed the task first. */
export function draftSummary(draft: ScheduleDraft, dm = false): string {
  const when = {once: `一次 ${draft.at.replace('T', ' ')}`, every: `每 ${draft.minutes} 分钟`, daily: `每天 ${draft.time}`,
    weekly: `每周${draft.days.map(day => DAY_NAMES[day]).join('、')} ${draft.time}`, cron: `cron「${draft.expr}」`}[draft.when];
  return [`名字：${draft.name}`, `什么时候：${when}（${draft.timeZone}）`, ...(dm ? [] : [`发到哪：${placementText[draft.placement]}`]), `要做什么：${draft.instruction}`].join('\n');
}

/**
 * 新建 and 编辑. A conflict loads the task as it is now and keeps what the user typed below it, read-only. `chats`: the
 * private chat's page, where a new task picks whose chat it posts to (a task already has one) and no chat has topics.
 */
export function ScheduleForm({chatId, chats, task: opened, hostTimeZone, send, onClose, now = Date.now}: {
  chatId?: string; chats?: readonly {value: string; label: string}[]; task?: ScheduledTaskView; hostTimeZone: string; send: ScheduleSend; onClose: () => void; now?: () => number;
}) {
  const id = useId();
  const [task, setTask] = useState(opened);
  const [initial, setInitial] = useState(() => opened ? scheduleDraft(opened, hostTimeZone) : scheduleDraft());
  const [draft, setDraft] = useState(initial);
  const [stale, setStale] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [chosen, setChosen] = useState(chats?.[0]?.value);
  const dm = chats !== undefined || Boolean(opened?.dm);
  const set = (change: Partial<ScheduleDraft>) => setDraft(current => ({...current, ...change}));
  async function save() {
    const target = task?.chatId ?? chosen ?? chatId;
    if (target === undefined) {setError('先选发给谁。'); return;}
    const request = scheduleRequest(draft, {chatId: target, now: now(), task, initial});
    if ('error' in request) {setError(request.error); return;}
    setPending(true); setError('');
    try {
      const reply = await send(request);
      if (reply.kind === 'task') return onClose();
      if (reply.kind === 'conflict') {
        const fresh = scheduleDraft(reply.current, hostTimeZone);
        setStale(draftSummary(draft, dm)); setTask(reply.current); setInitial(fresh); setDraft(fresh); setError(scheduleConflict);
      } else setError(reply.kind === 'refused' ? refusalText(reply) : '没有保存，请重试。');
    } catch (failure) {setError(failure instanceof Error ? failure.message : '没有保存，请重试。');}
    finally {setPending(false);}
  }
  const placements = (['follow', 'newTopic', ...(task?.placement.kind === 'topic' ? ['topic' as const] : [])] as const).map(value => ({value, label: placementText[value]}));
  // A once time opened from a zone this browser does not know was read in another; say which while that time and zone are still in the form.
  const unknown = initial.when === 'once' && draft.when === 'once' && draft.timeZone === initial.timeZone && !knownZone(draft.timeZone);
  const field = (key: string) => `${id}-${key}`;
  return <Dialog open title={opened ? '编辑任务' : '新建任务'} onClose={pending ? undefined : onClose}
    footer={<><Button disabled={pending} onClick={onClose}>取消</Button><Button variant="primary" loading={pending} onClick={() => void save()}>保存</Button></>}><div className="schedule-form">
    <FormField label="名字" htmlFor={field('name')}><input id={field('name')} value={draft.name} disabled={pending} autoComplete="off" onChange={event => set({name: event.target.value})}/></FormField>
    {chats && !opened && chosen !== undefined && <FormField label="发给谁"><SettingChoices label="发给谁" value={chosen} choices={[...chats]} disabled={pending} onChange={setChosen}/></FormField>}
    <FormField label="要做什么" htmlFor={field('instruction')}><textarea id={field('instruction')} rows={4} value={draft.instruction} disabled={pending} onChange={event => set({instruction: event.target.value})}/></FormField>
    <FormField label="什么时候"><SettingChoices label="什么时候" value={draft.when} choices={whenChoices} disabled={pending} onChange={when => set({when})}/></FormField>
    {draft.when === 'once' && <FormField label="时间" htmlFor={field('at')}><input id={field('at')} type="datetime-local" value={draft.at} disabled={pending} onChange={event => set({at: event.target.value})}/></FormField>}
    {draft.when === 'every' && <FormField label="间隔（分钟）" htmlFor={field('minutes')}><input id={field('minutes')} type="number" min={1} max={10080} value={draft.minutes} disabled={pending} onChange={event => set({minutes: event.target.value})}/></FormField>}
    {draft.when === 'weekly' && <fieldset disabled={pending}><legend>星期</legend>
      {[1, 2, 3, 4, 5, 6, 0].map(day => <label key={day}><input type="checkbox" checked={draft.days.includes(day)} onChange={event => set({days: event.target.checked ? [...draft.days, day] : draft.days.filter(other => other !== day)})}/>周{DAY_NAMES[day]}</label>)}
      <Button size="sm" variant="ghost" onClick={() => set({days: [...WORKDAYS]})}>工作日</Button>
    </fieldset>}
    {(draft.when === 'daily' || draft.when === 'weekly') && <FormField label="几点" htmlFor={field('time')}><input id={field('time')} type="time" value={draft.time} disabled={pending} onChange={event => set({time: event.target.value})}/></FormField>}
    {draft.when === 'cron' && <FormField label="cron" htmlFor={field('cron')} description="5 段，用空格隔开：分 时 日 月 星期。例如 0 9 * * 1-5 是每个工作日 09:00。"><input id={field('cron')} value={draft.expr} disabled={pending} autoComplete="off" spellCheck={false} onChange={event => set({expr: event.target.value})}/></FormField>}
    {!dm && <FormField label="发到哪"><SettingChoices label="发到哪" value={draft.placement} choices={placements} disabled={pending} onChange={placement => set({placement})}/></FormField>}
    <FormField label="时区" htmlFor={field('zone')} description={<>Vonvon 所在电脑的时区是 {hostTimeZone}{unknown && <><br/>这个时区这里不认识，上面的时间按 {shownZone(draft.timeZone, hostTimeZone)} 显示；换成认识的时区后保存</>}</>}><input id={field('zone')} value={draft.timeZone} disabled={pending} autoComplete="off" spellCheck={false} onChange={event => set({timeZone: event.target.value})}/></FormField>
    {error && <InlineNotice title="没有保存" tone="warning">{error}</InlineNotice>}
    {stale && <FormField label="你刚才填的" htmlFor={field('stale')}><textarea id={field('stale')} rows={6} readOnly value={stale}/></FormField>}
  </div></Dialog>;
}
