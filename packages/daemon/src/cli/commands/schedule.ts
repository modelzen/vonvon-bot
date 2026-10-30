import { scheduleRequestSchema, type Agent, type Membership, type ScheduleReply, type ScheduleRequest, type ScheduleRunRecord, type ScheduleSpec, type ScheduledTaskView } from '@vonvon/protocol';
import { CommandError } from '../command-error';
import { inBotSession } from '../../config/session-env';
import { formatAt, normalizeTimeZone, parseCron, parseLocal } from '../../bot/schedule/time';
import { pickBot, pickGroup, print, want, withDaemon, type Daemon, type Io } from '../daemon-client';

export type ScheduleAction = 'list' | 'add' | 'edit' | 'pause' | 'resume' | 'delete' | 'run' | 'runs';
export type ScheduleTarget = {
  bot?: string; group?: string; all?: boolean; taskId?: string; instruction?: string; name?: string; revision?: string; tz?: string; newTopic?: boolean;
  every?: string; daily?: string; weekly?: string; at?: string; cron?: string;
};

const SESSION_REFUSED = '定时任务的命令不能在 Bot 的会话里用：在群里跟 Bot 说就能建和改任务；主人在桌面端或者自己的终端里管。';
const NOT_FOUND = '本群没有这个任务。';
const WHEN_FORMS = '--every 30m、--daily 09:00、--weekly mon,wed@10:00、--at "2026-11-01 14:00" 或 --cron "0 9 * * 1-5"';
const later = (what: string): string => `可能已经${what}，运行 vonvon schedule list 查看。`;
/** What each action is called in errors, the reply it expects, and what a lost reply may have done. */
const ACTIONS = {
  list: { what: '读取任务', kind: 'tasks' },
  add: { what: '建任务', kind: 'task', unknown: later('建好了') },
  edit: { what: '改任务', kind: 'task', unknown: later('改好了') },
  pause: { what: '暂停任务', kind: 'task', unknown: later('暂停了') },
  resume: { what: '恢复任务', kind: 'task', unknown: later('恢复了') },
  delete: { what: '删任务', kind: 'deleted', unknown: later('删掉了') },
  run: { what: '运行任务', kind: 'started', unknown: '可能已经开始运行，运行 vonvon schedule runs 查看。' },
  runs: { what: '读取运行记录', kind: 'task' },
} as const satisfies Record<ScheduleAction, { what: string; kind: string; unknown?: string }>;

type When = 'every' | 'daily' | 'weekly' | 'at' | 'cron';
/** `--at` waits for a zone: --tz, or else from a first list the task's own on edit and the daemon's on add, never this terminal's. */
type Parsed = ScheduleSpec | ((zone: string) => ScheduleSpec);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Each time option, checked before connecting. The daemon checks the spec again (validateSpec). */
const WHEN: Record<When, (text: string) => Parsed> = {
  every: text => {
    const match = /^(\d+)(m|h)$/.exec(text.trim());
    if (!match) throw new Error('--every 写成 30m 或 2h。');
    const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1);
    if (minutes < 1 || minutes > 10080) throw new Error('间隔最短 1 分钟，最长 7 天');
    return { kind: 'every', minutes };
  },
  daily: text => {
    if (!HHMM.test(text)) throw new Error('--daily 写成 HH:mm，例如 09:00。');
    return { kind: 'daily', time: text };
  },
  weekly: text => {
    const [names = '', time = '', ...rest] = text.split('@');
    const days = names.split(',').map(name => DAYS.indexOf(name.trim().toLowerCase()));
    if (rest.length || !HHMM.test(time) || days.some(day => day < 0)) throw new Error('--weekly 写成 mon,wed@10:00：星期用 mon 到 sun，时间写成 HH:mm。');
    return { kind: 'weekly', days: [...new Set(days)].sort((a, b) => a - b), time };
  },
  // A date that does not exist is refused by any zone, so UTC checks the text before the zone is known.
  at: text => {
    if (parseLocal('UTC', text) === undefined) throw new Error('--at 写成 "YYYY-MM-DD HH:mm"，例如 "2026-11-01 14:00"。');
    return zone => ({ kind: 'once', at: parseLocal(zone, text)! });
  },
  // The format only; whether it comes within 400 days is the daemon's validateSpec.
  cron: text => { parseCron(text); return { kind: 'cron', expr: text }; },
};

function timeOption(target: ScheduleTarget, required: boolean): Parsed | undefined {
  const given = (Object.keys(WHEN) as When[]).filter(key => target[key] !== undefined);
  if (given.length > 1) throw new Error(`时间只能给一个，这次给了 ${given.map(key => `--${key}`).join('、')}。`);
  const [key] = given;
  if (key) return WHEN[key](target[key]!);
  if (required) throw new Error(`要给时间：${WHEN_FORMS}，选一个。`);
  return undefined;
}

/** Same bounds as the protocol's nameSchema and instructionSchema, in words. */
function words(label: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${label}要 1 到 ${max} 个字。`);
  return trimmed;
}

function zoneOf(tz: string | undefined): string | undefined {
  if (tz === undefined) return undefined;
  try { return normalizeTimeZone(tz); } catch { throw new Error(`不认识这个时区：${tz}`); }
}

/** The client parses the request with this schema too, and its ZodError would read as a version mismatch. */
function checked(request: ScheduleRequest): ScheduleRequest {
  const parsed = scheduleRequestSchema.safeParse(request);
  if (parsed.success) return request;
  const issue = parsed.error.issues[0];
  throw new CommandError('bad-args', `命令行给的参数不对（${issue ? `${issue.path.join('.')}：${issue.message}` : parsed.error.message}）。`);
}

const STATES = { active: '已启用', finished: '已结束' } as const;
const PAUSED = { manual: '已暂停（手动）', failures: '已暂停（连续失败）', unavailable: '已暂停（群已解绑）' } as const;
const STATUS = { done: '完成', failed: '失败', missed: '错过', skipped: '跳过', interrupted: '中断' } as const;
const SKIPPED = { running: '上一次还没跑完', disabled: '群已停用', updating: '群正在修改', held: '群正在修改' } as const;
const BY = { shutdown: '停机', crash: '崩溃', user: '手动停止' } as const;
/** MM-DD HH:mm in the task's own zone; describe already names a zone that is not the daemon's. */
const when = (ms: number, zone: string): string => formatAt(ms, zone, zone).slice(5);

/** One task, word for word as 总设计第 16 节"终端一行". */
export function taskLine(task: ScheduledTaskView): string {
  return [
    `${task.id} ${task.name}`, task.describe,
    task.nextRunAt === undefined ? undefined : `下次 ${when(task.nextRunAt, task.timeZone)}`,
    task.state === 'paused' ? PAUSED[task.pausedReason ?? 'manual'] : STATES[task.state],
    task.lastResult && `上次 ${STATUS[task.lastResult.status]} ${when(task.lastResult.at, task.timeZone)}`,
  ].filter(Boolean).join(' · ');
}

function seconds(ms: number): string {
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}

/** One record: `11-01 09:00 · 完成 · 12 秒 · <链接或"—">`. */
export function runLine(record: ScheduleRunRecord, zone: string): string {
  const detail = record.status === 'failed' ? record.error
    : record.status === 'skipped' ? record.reason && SKIPPED[record.reason]
    : record.status === 'interrupted' ? record.by && BY[record.by]
    : record.status === 'missed' && (record.count ?? 1) > 1 ? `${record.count} 次` : undefined;
  return [
    when(record.startedAt ?? record.slot, zone), `${STATUS[record.status]}${detail ? `（${detail}）` : ''}`,
    record.durationMs === undefined ? '—' : seconds(record.durationMs), record.link ?? '—',
  ].join(' · ');
}

function runLines(task: ScheduledTaskView): string[] {
  const { runs, missed, skipped } = task.counts;
  const others = [missed ? `错过 ${missed} 次` : '', skipped ? `跳过 ${skipped} 次` : ''].filter(Boolean).join('，');
  return [
    `${task.id} ${task.name} · 共运行 ${runs} 次${others ? `（${others}）` : ''}`,
    ...(task.recent.length ? task.recent.map(record => runLine(record, task.timeZone)) : ['还没有运行记录。']),
  ];
}

/** listBot: the tasks under their group; a group no longer bound shows by its id. */
function groupLines(tasks: readonly ScheduledTaskView[], names: ReadonlyMap<string, string>): string[] {
  return [...new Set(tasks.map(task => task.chatId))].flatMap(chatId => [
    names.has(chatId) ? `群 ${names.get(chatId)}（${chatId}）` : `群 ${chatId}（没有绑定）`,
    ...tasks.filter(task => task.chatId === chatId).map(task => `  ${taskLine(task)}`),
  ]);
}

/** These also take the raw id of a group no longer bound, whose tasks list --all still shows; the rest would act in it. */
const UNBOUND = new Set<ScheduleAction>(['list', 'runs', 'delete', 'pause']);
function chatOf(memberships: readonly Membership[], bot: Agent, group: string, action: ScheduleAction): string {
  const bound = memberships.some(m => m.agentId === bot.id && (m.groupId === group || m.name === group));
  // The bot process still checks the scope: an id it has no such task under is not-found.
  return !bound && UNBOUND.has(action) && /^oc_/.test(group) ? group : pickGroup(memberships, bot, group).groupId;
}

export async function runSchedule(action: ScheduleAction, target: ScheduleTarget, io: Io, daemon: Daemon = withDaemon, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Before connecting: a sandbox cannot reach the daemon, and the terminal's credentials are the owner's.
  if (inBotSession(env)) throw new CommandError('refused', SESSION_REFUSED);
  const all = action === 'list' && Boolean(target.all);
  if (all && target.group !== undefined) throw new Error('--group 和 --all 只能选一个。');
  if (!all && target.group === undefined) throw new Error(`要给 --group <群>（群 id oc_… 或项目名）${action === 'list' ? '，或者用 --all 看这个 Bot 的全部任务' : ''}。`);
  const tz = zoneOf(target.tz);
  const spec = action === 'add' || action === 'edit' ? timeOption(target, action === 'add') : undefined;
  const name = words('--name ', target.name, 40);
  const instruction = words('任务内容', target.instruction, 4000);
  if (action === 'add' && (name === undefined || instruction === undefined)) throw new Error('要给 --name <名字> 和任务内容。');
  if (action === 'edit' && target.revision === undefined) throw new Error('要给 --revision：vonvon schedule list --json 里这个任务的 revision。');
  if (action === 'edit' && spec === undefined && name === undefined && instruction === undefined && tz === undefined) throw new Error(`没有要改的：给 --name、时间（${WHEN_FORMS}）、--tz 或新的任务内容。`);
  const taskId = target.taskId ?? '';
  const { what, kind } = ACTIONS[action];

  const { reply, names } = await daemon(async (call): Promise<{ reply: ScheduleReply; names?: ReadonlyMap<string, string> }> => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const bot = pickBot(snapshot.agents, target.bot);
    // Checked outside the call, whose own errors all become connection, failed or outcome-unknown.
    const send = (request: ScheduleRequest, as: { what: string; unknown?: string } = ACTIONS[action]) => {
      const valid = checked(request);
      return call(as.what, c => c.schedule(bot.id, valid), as.unknown ? { unknown: as.unknown } : {});
    };
    if (all) return { reply: await send({ action: 'listBot' }), names: new Map(snapshot.memberships.filter(m => m.agentId === bot.id).map(m => [m.groupId, m.name])) };
    const chatId = chatOf(snapshot.memberships, bot, target.group!, action);
    // A list before the change itself is only a read: a lost reply to it changed nothing.
    const list = async () => want(ACTIONS.list.what, await send({ action: 'list', chatId }, ACTIONS.list), 'tasks');
    const find = async () => {
      const task = (await list()).tasks.find(task => task.id === taskId);
      if (!task) throw new CommandError('refused', `${what}没有完成：${NOT_FOUND}`);
      return task;
    };
    // edit keeps the task's zone, as the daemon reads --daily, --weekly and --cron in it.
    const resolved = async () => typeof spec === 'function' ? spec(tz ?? (action === 'edit' ? await find() : await list()).timeZone) : spec;
    switch (action) {
      case 'list': return { reply: await send({ action: 'list', chatId }) };
      case 'add': return { reply: await send({
        action: 'create', chatId, name: name!, instruction: instruction!, spec: (await resolved())!,
        ...(target.newTopic ? { placement: { kind: 'newTopic' } as const } : {}), ...(tz ? { timeZone: tz } : {}),
      }) };
      case 'edit': {
        const next = await resolved();
        const patch = { ...(name ? { name } : {}), ...(instruction ? { instruction } : {}), ...(next ? { spec: next } : {}), ...(tz ? { timeZone: tz } : {}) };
        return { reply: await send({ action: 'edit', chatId, taskId, revision: target.revision!, patch }) };
      }
      case 'pause': case 'resume': return { reply: await send({ action, chatId, taskId }) };
      case 'run': return { reply: await send({ action: 'runNow', chatId, taskId }) };
      // Without --revision the current one: a delete still refuses a task changed after this list.
      case 'delete': return { reply: await send({ action: 'delete', chatId, taskId, revision: target.revision ?? (await find()).revision }) };
      // No request of its own: the task's counts and recent records from the list.
      case 'runs': return { reply: { kind: 'task', task: await find() } };
    }
  });

  if (reply.kind === 'conflict') {
    const [undone, then] = action === 'delete' ? ['没有删除', '再删'] : ['没有保存', '再改'];
    throw new CommandError('conflict', `这个任务刚在别处改过，${undone}。现在的 revision 是 ${reply.current.revision}，先看过现在的内容${then}。`, reply.current);
  }
  const done = want(what, reply, kind);
  let human: string[];
  if (done.kind === 'tasks') {
    human = done.tasks.length ? names ? groupLines(done.tasks, names) : done.tasks.map(taskLine) : [all ? '这个 Bot 还没有定时任务。' : '本群还没有定时任务。'];
  } else if (done.kind === 'task') human = action === 'runs' ? runLines(done.task) : [taskLine(done.task)];
  else if (done.kind === 'deleted') human = [`已删除 ${done.taskId}，连同它的运行记录。`];
  else human = [`已开始运行 ${done.taskId}，结果会发在群里。`];
  print(io, human, done);
}
