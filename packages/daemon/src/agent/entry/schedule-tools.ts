import { z } from 'zod';
import type { SchedulePlacement, ScheduleRefusal, ScheduleReply, ScheduleRequest, ScheduleSpec } from '@vonvon/protocol';
import { scheduleRefusalMessages, type ScheduleActor, type ScheduleCommands } from '../../admin/schedule-commands';
import { formatAt, hostTimeZone, parseLocal } from '../../bot/schedule/time';
import type { TurnWhere } from './registry';
import { ToolRefusal, type AgentTool, type ToolContext } from './tools';

/**
 * 定时任务的 agent 工具（总设计第 10 节）：命令核（admin/schedule-commands.ts）的壳，Claude 的 MCP 和 Codex 的
 * dynamicTools（T3b）共用这一份定义。工具不收群参数：群从 grant 取，话题从 `where()` 现取；谁能做什么由登记表
 * 先查一遍，命令核再查一遍。回复是给模型看的一行人话加 JSON；拒绝也是回复，不抛错。
 */

const MINUTE = 60_000;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const whenSchema = z.union([
  z.object({ kind: z.literal('once'), at: z.string().max(40) }).strict(),
  z.object({ kind: z.literal('once'), inMinutes: z.number().int().min(1).max(525_600) }).strict(),
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(10_080) }).strict(),
  z.object({ kind: z.literal('daily'), time: hhmm }).strict(),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: hhmm }).strict(),
  z.object({ kind: z.literal('cron'), expr: z.string().min(9).max(100) }).strict(),
]).describe('什么时候。一次：{kind:"once",at:"YYYY-MM-DD HH:mm"}（按 timeZone）或 {kind:"once",inMinutes:20}；'
  + '每 N 分钟：{kind:"every",minutes:30}；每天：{kind:"daily",time:"09:00"}；每周：{kind:"weekly",days:[1,2,3,4,5],time:"09:00"}（0 是周日）；'
  + 'cron：{kind:"cron",expr:"0 9 * * 1-5"}（5 段）');
const whereSchema = z.enum(['here', 'thisTopic', 'newTopic']).describe('发到哪。here（默认）：话题里建的一次性任务回这个话题，其余跟群的会话方式；'
  + 'thisTopic：用户说了"就在这个话题里发"；newTopic：用户说了"开个话题发"，每次开新话题');
const zoneSchema = z.string().min(1).max(64).describe('IANA 时区名，比如 Asia/Shanghai；不写就用 daemon 所在电脑的时区');
const taskId = z.string().min(1).max(64).describe('任务 id，来自 schedule_list');
const revision = z.string().min(1).max(200).describe('schedule_list 里这个任务的 revision');
const name = z.string().min(1).max(40);
const instruction = z.string().min(1).max(4000).describe('到点时要做什么，写给到时候的自己看');

const createInput = z.object({ name, instruction, when: whenSchema, where: whereSchema.optional(), timeZone: zoneSchema.optional() }).strict();
const editInput = z.object({ taskId, revision, patch: z.object({ name: name.optional(), instruction: instruction.optional(),
  when: whenSchema.optional(), where: whereSchema.optional(), timeZone: zoneSchema.optional() }).strict() }).strict();
const targetInput = z.object({ taskId }).strict();
const deleteInput = z.object({ taskId, revision }).strict();

/** Section 16's descriptions, verbatim. */
const definitions = [
  { name: 'schedule_list', action: 'list', input: z.object({}).strict(), description: '列出本群这个 Bot 的定时任务，含现在的时间和时区。' },
  { name: 'schedule_create', action: 'create', input: createInput, description: '给本群建一个定时任务，或给自己排一个稍后回来的一次性任务；时间用 when 写，不用算毫秒。' },
  { name: 'schedule_edit', action: 'edit', input: editInput, description: '改任务的名字、内容、时间或发到哪；要带 list 里的 revision。' },
  { name: 'schedule_pause', action: 'pause', input: targetInput, description: '暂停。' },
  { name: 'schedule_resume', action: 'resume', input: targetInput, description: '恢复。' },
  { name: 'schedule_delete', action: 'delete', input: deleteInput, description: '删除，连记录一起；要带 revision。' },
  { name: 'schedule_run_now', action: 'runNow', input: targetInput, description: '马上跑一次，不影响下一次定时。' },
] as const satisfies readonly { name: string; action: ScheduleRequest['action']; input: z.ZodObject; description: string }[];

/** The Claude backend lists these only in sessions whose profile has `tools.schedule`. */
export const scheduleToolNames: ReadonlySet<string> = new Set(definitions.map(tool => tool.name));

/** The same tools without any provider's types, for Codex dynamicTools (T3b). */
export function scheduleToolSpecs(): { name: string; description: string; inputSchema: object }[] {
  return definitions.map(({ name, description, input }) => ({ name, description, inputSchema: z.toJSONSchema(input) }));
}

type When = z.infer<typeof whenSchema>;
type Where = z.infer<typeof whereSchema>;
const refuse = (reason: ScheduleRefusal, message: string): ScheduleReply => ({ kind: 'refused', reason, message });

/** `when` to a spec: the model never counts milliseconds. A string is what bad-schedule says. */
function specOf(when: When, zone: string, now: number): ScheduleSpec | string {
  if (when.kind !== 'once') return when;
  if ('inMinutes' in when) return { kind: 'once', at: now + when.inMinutes * MINUTE };
  try {
    const at = parseLocal(zone, when.at);
    return at === undefined ? '一次性任务的时间要写成 YYYY-MM-DD HH:mm，比如 2026-11-01 14:00' : { kind: 'once', at };
  } catch {
    return `不认识这个时区：${zone}`; // validateSpec's words; parseLocal throws on a zone Intl does not know
  }
}

/** 3.13"结果发在哪": a once made in a topic goes back to it; a recurring one follows the group unless told to stay. */
function placementOf(where: Where | undefined, once: boolean, here: TurnWhere): SchedulePlacement | 'topic-pending' {
  if (where === 'newTopic') return { kind: 'newTopic' };
  // In the main area `thisTopic` reads as `here`; a topic the bot just opened has no id until Feishu answers.
  if (where === 'thisTopic' && here.inTopic) return here.topicId ? { kind: 'topic', topicId: here.topicId } : 'topic-pending';
  return once && here.topicId ? { kind: 'topic', topicId: here.topicId } : { kind: 'follow' };
}

const nextAt = (ms: number, zone: string) => `${formatAt(ms, zone, zone).slice(5)}（${zone}）`;
function headline(reply: ScheduleReply, done: string): string {
  switch (reply.kind) {
    case 'refused': return reply.message;
    case 'tasks': return `现在 ${formatAt(reply.now, reply.timeZone, reply.timeZone)}（${reply.timeZone}）· 本群 ${reply.tasks.length} 个任务`;
    case 'task': {
      const { task } = reply;
      return `${done}：${task.name} · ${task.describe}${task.nextRunAt === undefined ? '' : ` · 下次 ${nextAt(task.nextRunAt, task.timeZone)}`}`;
    }
    case 'conflict': return '这个任务刚被改过，revision 对不上；下面是现在的内容，看过再决定要不要改。';
    case 'deleted': return `已删除：${reply.taskId}`;
    case 'started': return '已开始运行，不影响下一次定时。';
    default: { const exhaustive: never = reply; return exhaustive; }
  }
}
/** One line, then the reply as JSON; a list keeps each task's last 3 runs. */
function answer(reply: ScheduleReply, done = ''): string {
  const shown = reply.kind === 'tasks' ? { ...reply, tasks: reply.tasks.map(task => ({ ...task, recent: task.recent.slice(-3) })) } : reply;
  return `${headline(reply, done)}\n${JSON.stringify(shown)}`;
}

export function createScheduleTools(deps: { commands: ScheduleCommands; now?: () => number; hostTimeZone?: () => string }): AgentTool[] {
  const now = deps.now ?? Date.now;
  const daemonZone = deps.hostTimeZone ?? hostTimeZone;
  const turnOf = (ctx: ToolContext) => {
    const turn = ctx.schedule?.();
    if (!turn) throw new ToolRefusal({ ok: false, code: 'refused', reason: 'not-group', message: scheduleRefusalMessages['not-group'] });
    return turn;
  };
  /** Writes pass the registry's commit point: the guard, then the command core with nothing awaited in between. */
  async function write(ctx: ToolContext, request: ScheduleRequest, done = ''): Promise<string> {
    const { actor } = turnOf(ctx);
    if (!ctx.commit) throw new ToolRefusal({ ok: false, code: 'refused', message: '目标不存在或没有权限。' });
    return answer(await ctx.commit(async guard => { guard(); return deps.commands.execute(actor, request); }), done);
  }
  const listFor = (actor: Exclude<ScheduleActor, { kind: 'local' }>) => deps.commands.execute(actor, { action: 'list', chatId: actor.chatId });
  const runs: Record<(typeof definitions)[number]['action'], AgentTool['run']> = {
    list: async (_args, ctx) => answer(await listFor(turnOf(ctx).actor)),
    async create(args, ctx) {
      const input = createInput.parse(args);
      const { actor, where } = turnOf(ctx);
      const spec = specOf(input.when, input.timeZone ?? daemonZone(), now());
      if (typeof spec === 'string') return answer(refuse('bad-schedule', spec));
      const placement = placementOf(input.where, spec.kind === 'once', where);
      if (placement === 'topic-pending') return answer(refuse('topic-pending', scheduleRefusalMessages['topic-pending']));
      return write(ctx, { action: 'create', chatId: actor.chatId, name: input.name, instruction: input.instruction, spec, placement,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}) }, '已创建');
    },
    async edit(args, ctx) {
      const { taskId: id, revision: rev, patch } = editInput.parse(args);
      const { actor, where } = turnOf(ctx);
      // `when` reads in the task's zone and `where` by its kind, so look at the task as list shows it first
      const listed = patch.when || patch.where ? await listFor(actor) : undefined;
      const task = listed?.kind === 'tasks' ? listed.tasks.find(candidate => candidate.id === id) : undefined;
      const spec = patch.when ? specOf(patch.when, patch.timeZone ?? task?.timeZone ?? daemonZone(), now()) : undefined;
      if (typeof spec === 'string') return answer(refuse('bad-schedule', spec));
      const placement = patch.where ? placementOf(patch.where, (spec ?? task?.spec)?.kind === 'once', where) : undefined;
      if (placement === 'topic-pending') return answer(refuse('topic-pending', scheduleRefusalMessages['topic-pending']));
      return write(ctx, { action: 'edit', chatId: actor.chatId, taskId: id, revision: rev, patch: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.instruction !== undefined ? { instruction: patch.instruction } : {}),
        ...(spec ? { spec } : {}), ...(placement ? { placement } : {}),
        ...(patch.timeZone ? { timeZone: patch.timeZone } : {}),
      } }, '已修改');
    },
    pause: (args, ctx) => write(ctx, { action: 'pause', chatId: turnOf(ctx).actor.chatId, ...targetInput.parse(args) }, '已暂停'),
    resume: (args, ctx) => write(ctx, { action: 'resume', chatId: turnOf(ctx).actor.chatId, ...targetInput.parse(args) }, '已恢复'),
    delete: (args, ctx) => write(ctx, { action: 'delete', chatId: turnOf(ctx).actor.chatId, ...deleteInput.parse(args) }, '已删除'),
    runNow: (args, ctx) => write(ctx, { action: 'runNow', chatId: turnOf(ctx).actor.chatId, ...targetInput.parse(args) }),
  };
  return definitions.map((tool): AgentTool => ({ ...tool, class: 'schedule', run: runs[tool.action] }));
}
