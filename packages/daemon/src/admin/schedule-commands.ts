import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  scheduleRequestSchema,
  type ScheduledTaskView, type ScheduleRefusal, type ScheduleReply, type ScheduleRequest, type ScheduleSpec,
} from '@vonvon/protocol';
import type { RunNowResult, Scheduler } from '../bot/schedule/scheduler';
import { clampUnits, type ScheduleStore } from '../bot/schedule/store';
import { ceilToMinute, describeSpec, nextSlotAfter, normalizeTimeZone, validateSpec } from '../bot/schedule/time';
import type { StoredTask } from '../bot/schedule/types';

/** Who asks. `chat`: a person in a group turn; `scheduled`: the task's own unattended run; `local`: the owner on this machine. */
export type ScheduleActor =
  | { kind: 'chat'; openId: string; name?: string; role: 'owner' | 'admin' | 'member'; chatId: string; topicId?: string; messageId?: string; text?: string }
  | { kind: 'scheduled'; taskId: string; runId: string; chatId: string }
  | { kind: 'local'; via: 'desktop' | 'cli' };

export interface ScheduleCommandsDeps {
  store: ScheduleStore;
  scheduler: Scheduler;
  botId: string;
  now: () => number;
  hostTimeZone: () => string;
  /** Defaults 20 per group, 200 per bot. */
  limits?: { perChat: number; perBot: number };
}

export interface ScheduleCommands {
  execute(actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply>;
}

type Refused = Extract<ScheduleReply, { kind: 'refused' }>;
/** Refusals whose text is fixed; `bad-schedule` carries the validateSpec text and `task-limit` names the limit it hit. */
type FixedRefusal = Exclude<ScheduleRefusal, 'bad-schedule' | 'task-limit'>;
type TaskAction = Extract<ScheduleRequest, { taskId: string }>['action'];
type Creator = Exclude<ScheduleActor, { kind: 'scheduled' }>;

/** Overview section 16, verbatim. The agent tools (T3) answer `not-human-turn` and `topic-pending` with these too. */
export const scheduleRefusalMessages: Record<FixedRefusal, string> = {
  'not-group': '定时任务只能在群里管；要看别的群的任务去那个群说，或者用桌面端。',
  'not-found': '本群没有这个任务。',
  'not-task-owner': '这个任务是别人建的，只有建它的人、主人和管理员能改。',
  'scheduled-run-scope': '定时任务运行时只能改或结束自己这一个任务。',
  'no-human-create': '定时任务运行时不能新建任务；要再来一次就改自己这个任务的时间。',
  'not-human-turn': '这一轮不是由在场的人发起的，不能改任务。',
  running: '这个任务正在运行，等它结束再试。',
  'bot-not-running': 'Bot 没在运行，任务暂时看不到；启动后再来。',
  'topic-pending': '话题还没建好，稍等几秒再试。',
};
const RUN_NOW_REFUSALS: Record<Exclude<RunNowResult['kind'], 'started'>, FixedRefusal> = {
  running: 'running', 'not-started': 'bot-not-running', 'not-found': 'not-found',
};
const MAX_CREATOR_TEXT = 500; // scheduleCreatorSchema.text

const refused = (reason: ScheduleRefusal, message: string): Refused => ({ kind: 'refused', reason, message });
const refuse = (reason: FixedRefusal): Refused => refused(reason, scheduleRefusalMessages[reason]);

/** Thrown inside a store write to leave memory and the file as they were and answer with `reply` instead. */
class Answer extends Error {
  constructor(readonly reply: ScheduleReply) { super(reply.kind); }
}

/** An `every` request without an anchor starts counting from the next whole minute (overview 4.1). */
function anchored(spec: ScheduleSpec, now: number): ScheduleSpec {
  return spec.kind === 'every' && spec.anchor === undefined ? { ...spec, anchor: ceilToMinute(now) } : spec;
}

/** Whether an edit changes when the task runs. Re-sending the same `every` without its anchor (a form saved as it was) does not. */
function sameSpec(next: ScheduleSpec, current: ScheduleSpec): boolean {
  if (next.kind === 'every' && current.kind === 'every' && next.anchor === undefined) return next.minutes === current.minutes;
  return isDeepStrictEqual(next, current);
}

function creator(actor: Creator): StoredTask['createdBy'] {
  if (actor.kind === 'local') return { via: actor.via };
  return {
    via: 'chat', openId: actor.openId, role: actor.role,
    ...(actor.name ? { name: actor.name } : {}),
    ...(actor.messageId ? { messageId: actor.messageId } : {}),
    ...(actor.text ? { text: clampUnits(actor.text, MAX_CREATOR_TEXT) } : {}),
  };
}

/** Section 3.13 "谁能做什么" for a task this group already has: who may touch it with `action`. */
function denial(actor: ScheduleActor, action: TaskAction, task: StoredTask): FixedRefusal | undefined {
  if (actor.kind === 'local') return undefined;
  if (actor.kind === 'scheduled') return (action === 'edit' || action === 'delete') && task.id === actor.taskId ? undefined : 'scheduled-run-scope';
  if (actor.role !== 'member') return undefined;
  return actor.openId && task.createdBy.openId === actor.openId ? undefined : 'not-task-owner';
}

/** The only entry that changes schedules.json on a user's behalf (terminal, desktop and agent tools). */
export function createScheduleCommands(deps: ScheduleCommandsDeps): ScheduleCommands {
  const { store, scheduler } = deps;
  const limits = deps.limits ?? { perChat: 20, perBot: 200 };

  function toView(task: StoredTask, now: number): ScheduledTaskView {
    const { cursor, inflight, noticePending: _pending, noticeSince: _since, ...stored } = task;
    const nextRunAt = task.state === 'active' ? nextSlotAfter(task.spec, task.timeZone, cursor) : undefined;
    return {
      ...stored, botId: deps.botId, ...(nextRunAt === undefined ? {} : { nextRunAt }), running: !!inflight,
      describe: describeSpec(task.spec, task.timeZone, deps.hostTimeZone(), now),
    };
  }
  const tasksReply = (tasks: StoredTask[], now: number): ScheduleReply => (
    { kind: 'tasks', tasks: tasks.map(task => toView(task, now)), now, timeZone: deps.hostTimeZone() }
  );
  const taskReply = (task: StoredTask, now: number): ScheduleReply => ({ kind: 'task', task: toView(task, now) });

  /** One config write. `fn` throws an Answer to refuse without writing; a write that lands wakes the scheduler. */
  async function write(fn: (tasks: StoredTask[], touch: (task: StoredTask) => void) => ScheduleReply): Promise<ScheduleReply> {
    let reply: ScheduleReply;
    try {
      reply = await store.mutateConfig(fn);
    } catch (error) {
      if (error instanceof Answer) return error.reply;
      throw error;
    }
    scheduler.wake();
    return reply;
  }
  /** The task again inside the write: it may have gone since the first look. */
  function find(tasks: StoredTask[], request: { chatId: string; taskId: string }): StoredTask {
    const task = tasks.find(candidate => candidate.id === request.taskId && candidate.chatId === request.chatId);
    if (!task) throw new Answer(refuse('not-found'));
    return task;
  }

  function create(actor: Creator, request: Extract<ScheduleRequest, { action: 'create' }>, now: number): Promise<ScheduleReply> {
    const zone = request.timeZone ?? deps.hostTimeZone();
    const spec = anchored(request.spec, now);
    const invalid = validateSpec(spec, now, zone);
    if (invalid) return Promise.resolve(refused('bad-schedule', invalid));
    const task: StoredTask = {
      id: `st_${randomBytes(8).toString('hex')}`, chatId: request.chatId, revision: '', name: request.name, instruction: request.instruction,
      spec, timeZone: normalizeTimeZone(zone), placement: request.placement ?? { kind: 'follow' }, state: 'active',
      createdBy: creator(actor), createdAt: now, updatedAt: now, cursor: now,
      counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
    };
    return write((tasks, touch) => {
      if (tasks.filter(other => other.chatId === task.chatId).length >= limits.perChat) {
        throw new Answer(refused('task-limit', `本群已有 ${limits.perChat} 个任务，先删掉不用的。`));
      }
      if (tasks.length >= limits.perBot) throw new Answer(refused('task-limit', `这个 Bot 已有 ${limits.perBot} 个任务，先删掉不用的。`));
      touch(task);
      tasks.push(task);
      return taskReply(task, now);
    });
  }

  function edit(request: Extract<ScheduleRequest, { action: 'edit' }>, now: number): Promise<ScheduleReply> {
    return write((tasks, touch) => {
      const task = find(tasks, request);
      if (task.revision !== request.revision) throw new Answer({ kind: 'conflict', current: toView(task, now) });
      const { patch } = request;
      const specChanged = patch.spec !== undefined && !sameSpec(patch.spec, task.spec);
      const spec = patch.spec && specChanged ? anchored(patch.spec, now) : task.spec;
      const zone = patch.timeZone ?? task.timeZone;
      if (specChanged || patch.timeZone !== undefined) {
        const invalid = validateSpec(spec, now, zone);
        if (invalid) throw new Answer(refused('bad-schedule', invalid));
      }
      const timeZone = normalizeTimeZone(zone);
      // A new time starts from now: no catch-up of slots the old time had, a clean failure count, a finished task runs again.
      if (specChanged || timeZone !== task.timeZone) {
        task.cursor = now;
        task.counts.consecutiveFailures = 0;
        if (task.state === 'finished') task.state = 'active';
      }
      task.spec = spec;
      task.timeZone = timeZone;
      if (patch.name !== undefined) task.name = patch.name;
      if (patch.instruction !== undefined) task.instruction = patch.instruction;
      if (patch.placement !== undefined) task.placement = patch.placement;
      touch(task);
      return taskReply(task, now);
    });
  }

  function resume(request: { chatId: string; taskId: string }, now: number): Promise<ScheduleReply> {
    return write((tasks, touch) => {
      const task = find(tasks, request);
      if (task.state === 'active') throw new Answer(taskReply(task, now));
      const expired = task.spec.kind === 'once' && task.spec.at <= now;
      const reply = (): ScheduleReply => {
        const view = toView(task, now);
        return { kind: 'task', task: expired ? { ...view, describe: `${view.describe}（已过期）` } : view };
      };
      if (expired && task.state === 'finished') throw new Answer(reply());
      // Slots that fell in the pause are not caught up; a once whose time passed meanwhile ends here.
      task.state = expired ? 'finished' : 'active';
      delete task.pausedReason;
      task.cursor = now;
      task.counts.consecutiveFailures = 0;
      touch(task);
      return reply();
    });
  }

  return {
    async execute(actor, input) {
      const parsed = scheduleRequestSchema.safeParse(input);
      if (!parsed.success) {
        return refused('bad-schedule', `请求不对：${parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}：${issue.message}`).join('；')}`);
      }
      const request = parsed.data;
      const now = deps.now();
      if (request.action === 'listBot') return actor.kind === 'local' ? tasksReply(store.all(), now) : refuse('not-group');
      if (actor.kind !== 'local' && request.chatId !== actor.chatId) return refuse('not-group');
      if (request.action === 'list') {
        return tasksReply(store.byChat(request.chatId).filter(task => actor.kind !== 'scheduled' || task.id === actor.taskId), now);
      }
      if (request.action === 'create') return actor.kind === 'scheduled' ? refuse('no-human-create') : create(actor, request, now);
      // By id only among this group's tasks: another group's id reads as missing, not as forbidden.
      const task = store.get(request.taskId);
      if (!task || task.chatId !== request.chatId) return refuse('not-found');
      const denied = denial(actor, request.action, task);
      if (denied) return refuse(denied);
      switch (request.action) {
        case 'edit': return edit(request, now);
        case 'resume': return resume(request, now);
        case 'pause': return write((tasks, touch) => {
          const current = find(tasks, request);
          if (current.state !== 'active') throw new Answer(taskReply(current, now));
          current.state = 'paused';
          current.pausedReason = 'manual';
          touch(current);
          return taskReply(current, now);
        });
        // A running task can go too: the scheduler drops a settle whose task is gone.
        case 'delete': return write(tasks => {
          const current = find(tasks, request);
          if (current.revision !== request.revision) throw new Answer({ kind: 'conflict', current: toView(current, now) });
          tasks.splice(tasks.indexOf(current), 1);
          return { kind: 'deleted', taskId: current.id };
        });
        case 'runNow': {
          const result = scheduler.runNow(task.id);
          return result.kind === 'started' ? { kind: 'started', taskId: task.id, runId: result.runId } : refuse(RUN_NOW_REFUSALS[result.kind]);
        }
        default: { const exhaustive: never = request; return exhaustive; }
      }
    },
  };
}
