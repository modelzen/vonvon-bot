import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  scheduleRequestSchema,
  type ScheduledTaskView, type ScheduleRefusal, type ScheduleReply, type ScheduleRequest, type ScheduleSpec,
} from '@vonvon/protocol';
import type { RunNowResult, Scheduler } from '../bot/schedule/scheduler';
import { dmChatId } from '../project/registry';
import { clampUnits, type ScheduleStore } from '../bot/schedule/store';
import { ceilToMinute, describeSpec, nextSlotAfter, normalizeTimeZone, validateSpec } from '../bot/schedule/time';
import type { StoredTask } from '../bot/schedule/types';

/**
 * Who asks. `chat`: a person in a group turn; `session`: the same person's turn through a Bot session's command line
 * (devices-4b 4.4), with the same rights, recorded as made from the terminal; `dm`: a private chat's turn, a person's or
 * their task's (dm-agent 6.3), by its tools or (`via: 'cli'`) its command line, which reaches every chat of every Bot;
 * an actor from another Bot's private chat has no `openId`, that being its own Bot's (6.4); `scheduled`: a group task's
 * own unattended run; `local`: the owner on this machine.
 */
export type ScheduleActor =
  | { kind: 'chat'; openId: string; name?: string; role: 'owner' | 'admin' | 'member'; chatId: string; topicId?: string; messageId?: string; text?: string }
  | { kind: 'session'; openId: string; name?: string; role: 'owner' | 'admin' | 'member'; chatId: string; messageId?: string }
  | { kind: 'dm'; via: 'chat' | 'cli'; openId?: string; name?: string; chatId: string; messageId?: string; text?: string }
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
  /**
   * What a chat is to this Bot: a private chat with its person, a bound group, or none it can post in. Only a private
   * chat's command line can name a chat nothing else has checked.
   */
  chatOf?(chatId: string): { kind: 'dm'; name?: string } | { kind: 'group' } | undefined;
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
  'not-task-owner': '这个任务是别人建的，只有建它的人和管理员能改。',
  'scheduled-run-scope': '定时任务运行时只能改或结束自己这一个任务。',
  'no-human-create': '定时任务运行时不能新建任务；要再来一次就改自己这个任务的时间。',
  'not-human-turn': '这一轮不是由在场的人发起的，不能改任务。',
  running: '这个任务正在运行，等它结束再试。',
  'bot-not-running': 'Bot 没在运行，任务暂时看不到；启动后再来。',
  'topic-pending': '话题还没建好，稍等几秒再试。',
};
const RUN_NOW_REFUSALS: Record<Exclude<RunNowResult['kind'], 'started' | 'not-found'>, FixedRefusal> = {
  running: 'running', 'not-started': 'bot-not-running',
};
const MAX_CREATOR_TEXT = 500; // scheduleCreatorSchema.text
/** A private chat's command line named a chat this Bot has no window on. */
const NO_CHAT = '这个 Bot 不在这个群里，也没有这个私聊，任务建不了。';
const NO_DM_PERSON = '私聊的任务要指定发给谁：选一位管理员的私聊。';

/** `not-found`'s words where the chat is a private chat. */
export const DM_NOT_FOUND = '这个私聊没有这个任务。';

const refused = (reason: ScheduleRefusal, message: string): Refused => ({ kind: 'refused', reason, message });
const refuse = (reason: FixedRefusal): Refused => refused(reason, scheduleRefusalMessages[reason]);
/** The reply for a bot that is not running or is stopping: the supervisor, `vonvon run` and the orchestrator answer it themselves. */
export const botNotRunning = (): Refused => refuse('bot-not-running');

/** Thrown inside a store write to leave memory and the file as they were and answer with `reply` instead. */
class Answer extends Error {
  constructor(readonly reply: ScheduleReply) { super(reply.kind); }
}

/** `every` counts from the next whole minute after it is made or its time changes (overview 4.1); a caller's anchor is never used. */
function anchored(spec: ScheduleSpec, now: number): ScheduleSpec {
  return spec.kind === 'every' ? { ...spec, anchor: ceilToMinute(now) } : spec;
}

/** Whether an edit changes when the task runs. Re-sending the same `every`, with or without the view's anchor, does not. */
function sameSpec(next: ScheduleSpec, current: ScheduleSpec): boolean {
  if (next.kind === 'every' && current.kind === 'every') return next.minutes === current.minutes;
  return isDeepStrictEqual(next, current);
}

/** A zone a request gives, as stored: one this Intl knows, and a place, not a bare UTC offset (3.13 records an IANA name). */
function givenZone(zone: string): string | undefined {
  let name: string;
  try { name = normalizeTimeZone(zone); } catch { return undefined; }
  return /^[+-]/.test(name) ? undefined : name;
}
const unknownZone = (zone: string): Refused => refused('bad-schedule', `不认识这个时区：${zone}`);

/** The core does not trust its caller (T3): an actor outside the union, a caller's mapping bug, gets no rights. */
const outsideUnion = (_actor: never): undefined => undefined;

/** Who may create (3.13): the local owner, or a person with a role of the table. A chat role outside it (a bot's turn) may not. */
function mayCreate(actor: ScheduleActor): actor is Creator {
  switch (actor.kind) {
    case 'local': case 'dm': return true;
    // A member without an openId could never manage the task it made: no openId, no task.
    case 'chat': case 'session': return actor.role === 'owner' || actor.role === 'admin' || (actor.role === 'member' && !!actor.openId);
    case 'scheduled': return false;
    default: return outsideUnion(actor) ?? false;
  }
}

function creator(actor: Creator): StoredTask['createdBy'] {
  if (actor.kind === 'local') return { via: actor.via };
  const who = actor.kind !== 'dm' ? { via: actor.kind === 'session' ? 'cli' as const : 'chat' as const, openId: actor.openId, role: actor.role }
    // An admin on the Bot of the private chat, and only there (dm-agent 13): without an open_id no role either.
    : { via: actor.via, ...(actor.openId ? { openId: actor.openId, role: 'admin' as const } : {}) };
  return {
    ...who,
    ...(actor.name ? { name: actor.name } : {}),
    ...(actor.messageId ? { messageId: actor.messageId } : {}),
    ...(actor.kind !== 'session' && actor.text ? { text: clampUnits(actor.text, MAX_CREATOR_TEXT) } : {}),
  };
}

/** Section 3.13 "谁能做什么" for a task this group already has: who may touch it with `action`. */
function denial(actor: ScheduleActor, action: TaskAction, task: StoredTask): FixedRefusal | undefined {
  switch (actor.kind) {
    case 'local': case 'dm': return undefined;
    case 'scheduled': return (action === 'edit' || action === 'delete') && task.id === actor.taskId ? undefined : 'scheduled-run-scope';
    case 'chat': case 'session':
      if (actor.role === 'owner' || actor.role === 'admin') return undefined;
      return actor.role === 'member' && actor.openId && task.createdBy.openId === actor.openId ? undefined : 'not-task-owner';
    default: return outsideUnion(actor) ?? 'not-task-owner';
  }
}

/** The only entry that changes schedules.json on a user's behalf (terminal, desktop and agent tools). */
export function createScheduleCommands(deps: ScheduleCommandsDeps): ScheduleCommands {
  const inDm = (chatId: string): boolean => deps.chatOf?.(chatId)?.kind === 'dm';
  const notFound = (chatId: string): Refused => inDm(chatId) ? refused('not-found', DM_NOT_FOUND) : refuse('not-found');
  const { store, scheduler } = deps;
  const limits = deps.limits ?? { perChat: 20, perBot: 200 };

  /** Never throws: a stored zone this Intl does not know (a hand edit, another ICU) leaves the next run unknown and is described in the host's zone. */
  function toView(task: StoredTask, now: number, chatOf = deps.chatOf): ScheduledTaskView {
    const { cursor, inflight, noticePending: _pending, noticeSince: _since, ...stored } = task;
    const host = deps.hostTimeZone();
    let nextRunAt: number | undefined;
    try { nextRunAt = task.state === 'active' ? nextSlotAfter(task.spec, task.timeZone, cursor) : undefined; } catch { nextRunAt = undefined; }
    let describe: string;
    try { describe = describeSpec(task.spec, task.timeZone, host, now); } catch { describe = describeSpec(task.spec, host, host, now); }
    // Records are stored as they settle: an interrupted run lands after the skip it caused. Views show them by time.
    const recent = [...stored.recent].sort((a, b) => (a.startedAt ?? a.slot) - (b.startedAt ?? b.slot));
    const chat = chatOf?.(task.chatId);
    const dm = chat?.kind === 'dm' ? { dm: { ...(chat.name ? { name: chat.name } : {}) } } : {};
    return { ...stored, ...dm, recent, botId: deps.botId, ...(nextRunAt === undefined ? {} : { nextRunAt }), running: !!inflight, describe };
  }
  // Once a chat: chatOf reads the project file.
  function tasksReply(tasks: StoredTask[], now: number): ScheduleReply {
    const chats = new Map([...new Set(tasks.map(task => task.chatId))].map(chatId => [chatId, deps.chatOf?.(chatId)]));
    return { kind: 'tasks', tasks: tasks.map(task => toView(task, now, chatId => chats.get(chatId))), now, timeZone: deps.hostTimeZone() };
  }
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
    if (!task) throw new Answer(notFound(request.chatId));
    return task;
  }

  function create(actor: Creator, request: Extract<ScheduleRequest, { action: 'create' }>, now: number): Promise<ScheduleReply> {
    const zone = request.timeZone ?? deps.hostTimeZone();
    const timeZone = givenZone(zone);
    if (timeZone === undefined) return Promise.resolve(unknownZone(zone));
    const spec = anchored(request.spec, now);
    const invalid = validateSpec(spec, now, timeZone);
    if (invalid) return Promise.resolve(refused('bad-schedule', invalid));
    const task: StoredTask = {
      id: `st_${randomBytes(8).toString('hex')}`, chatId: request.chatId, revision: '', name: request.name, instruction: request.instruction,
      spec, timeZone, placement: request.placement ?? { kind: 'follow' }, state: 'active',
      createdBy: creator(actor), createdAt: now, updatedAt: now, cursor: now,
      counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
    };
    return write((tasks, touch) => {
      if (tasks.filter(other => other.chatId === task.chatId).length >= limits.perChat) {
        throw new Answer(refused('task-limit', `${inDm(task.chatId) ? '这个私聊' : '本群'}已有 ${limits.perChat} 个任务，先删掉不用的。`));
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
      // Only a zone the edit gives is normalized: a stored one this Intl does not know still lets the task be renamed.
      let timeZone = task.timeZone;
      if (patch.timeZone !== undefined) {
        const given = givenZone(patch.timeZone);
        if (given === undefined) throw new Answer(unknownZone(patch.timeZone));
        timeZone = given;
      }
      const zoneChanged = timeZone !== task.timeZone;
      // A zone alone does not move a once task's instant, so an edit that keeps the time is not refused for a past one.
      if (specChanged) {
        const invalid = validateSpec(spec, now, timeZone);
        if (invalid) throw new Answer(refused('bad-schedule', invalid));
      }
      // A new time starts from now: no catch-up of slots the old time had, a clean failure count, a finished task runs again.
      if (specChanged || zoneChanged) {
        task.cursor = now;
        task.counts.consecutiveFailures = 0;
        // Only once tasks finish, and a zone alone leaves a once task's instant in the past.
        if (specChanged && task.state === 'finished') task.state = 'active';
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
      // The owner, and a private chat's turn (dm-agent 8): a task of any chat of this Bot, by its id only in that chat.
      const anyChat = actor.kind === 'local' || actor.kind === 'dm';
      if (request.action === 'listBot') return anyChat ? tasksReply(store.all(), now) : refuse('not-group');
      if (!anyChat && request.chatId !== actor.chatId) return refuse('not-group');
      if (request.action === 'list') {
        return tasksReply(store.byChat(request.chatId).filter(task => actor.kind !== 'scheduled' || task.id === actor.taskId), now);
      }
      if (request.action === 'create') {
        if (actor.kind === 'scheduled') return refuse('no-human-create');
        // `--dm` names the private chat, not a person: from a private chat it means that one. Nothing can post to the row's own id.
        const row = request.chatId === dmChatId(deps.botId);
        const chatId = row && actor.kind === 'dm' ? actor.chatId : request.chatId;
        if (actor.kind === 'local' && row) return refused('not-found', NO_DM_PERSON);
        if (actor.kind === 'dm' && deps.chatOf && !deps.chatOf(chatId)) return refused('not-found', NO_CHAT);
        // The nearest text of section 16: a chat role outside the table is a turn no present person started.
        return mayCreate(actor) ? create(actor, { ...request, chatId }, now) : refuse('not-human-turn');
      }
      // By id only among this group's tasks: another group's id reads as missing, not as forbidden.
      const task = store.get(request.taskId);
      if (!task || task.chatId !== request.chatId) return notFound(request.chatId);
      if(store.managed?.review(task.id) && (['edit','resume','delete'].includes(request.action)||request.action==='runNow'&&task.state!=='active'))return refused('bad-schedule','请通过配方设置确认此任务的运行条件');
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
          if (result.kind === 'not-found') return notFound(request.chatId);
          return result.kind === 'started' ? { kind: 'started', taskId: task.id, runId: result.runId } : refuse(RUN_NOW_REFUSALS[result.kind]);
        }
        default: { const exhaustive: never = request; return exhaustive; }
      }
    },
  };
}
