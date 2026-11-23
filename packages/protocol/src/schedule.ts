import { z } from 'zod';

export const scheduleRefusalSchema = z.enum([
  'not-group',           // 评论会话；群里点名别的群、群里的 listBot
  'not-found',           // 没有这个任务，或者它不属于这个群（跨群一律按不存在）
  'not-task-owner',      // 成员改别人建的
  'scheduled-run-scope', // 无人回合碰别的任务
  'no-human-create',     // 无人回合建任务
  'not-human-turn',      // 被别人插话过的回合、bot 之间、唤醒、重试这些没有在场发起人的回合写任务
  'task-limit', 'bad-schedule', 'running', 'bot-not-running',
  'topic-pending',       // 话题还没建好（卡片刚发、飞书还没回 thread id），稍后再试
]);
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number().int() }).strict(),                               // epoch ms
  // anchor：请求里可省略；命令核在创建和改 spec 时填为当时向上取整到整分的 epoch ms；存储里一定有。slot = anchor + k × minutes，k ≥ 1
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(10080), anchor: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('daily'), time: hhmmSchema }).strict(),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), time: hhmmSchema }).strict(), // 0=周日
  z.object({ kind: z.literal('cron'), expr: z.string().trim().min(9).max(100) }).strict(),               // 标准 5 段
]);
export const schedulePlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('follow') }).strict(),                            // 跟群的会话方式
  z.object({ kind: z.literal('newTopic') }).strict(),                          // 每次开新话题
  z.object({ kind: z.literal('topic'), topicId: z.string().min(1) }).strict(), // 回这个话题
]);
export const scheduleRunStatusSchema = z.enum(['done', 'failed', 'missed', 'skipped', 'interrupted']);
export const scheduleRunRecordSchema = z.object({
  runId: z.string(), slot: z.number().int(), trigger: z.enum(['schedule', 'catchUp', 'manual']),
  status: scheduleRunStatusSchema, startedAt: z.number().int().optional(), endedAt: z.number().int().optional(),
  durationMs: z.number().int().optional(), messageId: z.string().optional(), topicId: z.string().optional(),
  link: z.string().url().optional(),      // daemon 结算时解析的飞书链接（照 outbound-files 的 message_position 做法），没有就不填
  error: z.string().max(200).optional(),
  reason: z.enum(['running', 'disabled', 'updating', 'held']).optional(), // 只在 skipped 上：上一次没跑完 / 群停用 / 群正在修改或恢复 / 桌面端要改群先让路
  count: z.number().int().optional(),     // 只在合并的 missed 记录上
  by: z.enum(['shutdown', 'crash', 'user']).optional(), // 只在 interrupted 上
}).strict();
export const scheduleCreatorSchema = z.object({
  via: z.enum(['chat', 'desktop', 'cli']), openId: z.string().optional(), name: z.string().optional(),
  role: z.enum(['owner', 'admin', 'member']).optional(), messageId: z.string().optional(), text: z.string().max(500).optional(),
}).strict();
const nameSchema = z.string().trim().min(1).max(40);
const instructionSchema = z.string().trim().min(1).max(4000);
export const scheduledTaskViewSchema = z.object({
  id: z.string(), botId: z.string(), chatId: z.string(),
  dm: z.object({ name: z.string().optional() }).strict().optional(), // chatId 是这个 Bot 的一个私聊时才有：私聊里的那个人，不存盘（dm-agent 第 8 节）
  revision: z.string(),                   // 只在配置变化时换（见 4.2）
  name: nameSchema, instruction: instructionSchema,
  spec: scheduleSpecSchema, timeZone: z.string(), placement: schedulePlacementSchema,
  state: z.enum(['active', 'paused', 'finished']), pausedReason: z.enum(['manual', 'failures', 'unavailable', 'admin-removed']).optional(),
  createdBy: scheduleCreatorSchema, createdAt: z.number().int(), updatedAt: z.number().int(),
  nextRunAt: z.number().int().optional(), running: z.boolean(),
  counts: z.object({ runs: z.number().int(), missed: z.number().int(), skipped: z.number().int(), consecutiveFailures: z.number().int() }).strict(),
  lastResult: z.object({ at: z.number().int(), status: scheduleRunStatusSchema, excerpt: z.string().max(500), messageId: z.string().optional(), link: z.string().url().optional() }).strict().optional(),
  recent: z.array(scheduleRunRecordSchema).max(20),
  describe: z.string(), // 人话："每个工作日 09:00"
}).strict();

const target = { taskId: z.string() };
const patchSchema = z.object({ name: nameSchema, instruction: instructionSchema, spec: scheduleSpecSchema, placement: schedulePlacementSchema, timeZone: z.string() }).partial().strict();
export const scheduleRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), chatId: z.string() }).strict(),
  z.object({ action: z.literal('listBot') }).strict(),                                   // 给桌面端、终端和私聊
  z.object({ action: z.literal('create'), chatId: z.string(), name: nameSchema, instruction: instructionSchema, spec: scheduleSpecSchema,
    placement: schedulePlacementSchema.optional(), timeZone: z.string().optional() }).strict(),
  z.object({ action: z.literal('edit'), chatId: z.string(), ...target, revision: z.string(), patch: patchSchema }).strict(),
  z.object({ action: z.literal('pause'), chatId: z.string(), ...target }).strict(),
  z.object({ action: z.literal('resume'), chatId: z.string(), ...target }).strict(),
  z.object({ action: z.literal('delete'), chatId: z.string(), ...target, revision: z.string() }).strict(),
  z.object({ action: z.literal('runNow'), chatId: z.string(), ...target }).strict(),
]);
export const scheduleReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tasks'), tasks: z.array(scheduledTaskViewSchema), now: z.number().int(), timeZone: z.string() }).strict(), // now 和 daemon 的时区给 agent 算时间
  z.object({ kind: z.literal('task'), task: scheduledTaskViewSchema }).strict(),
  z.object({ kind: z.literal('deleted'), taskId: z.string() }).strict(),
  z.object({ kind: z.literal('started'), taskId: z.string(), runId: z.string() }).strict(),
  z.object({ kind: z.literal('conflict'), current: scheduledTaskViewSchema }).strict(),
  z.object({ kind: z.literal('refused'), reason: scheduleRefusalSchema, message: z.string() }).strict(),
]);

export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>;

export function describeRecurringSchedule(spec: Exclude<ScheduleSpec, {kind: 'once'}>): string {
  switch (spec.kind) {
    case 'every': return spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`;
    case 'daily': return `每天 ${spec.time}`;
    case 'weekly': {
      const days = [...new Set(spec.days)].sort((a, b) => a - b);
      const interval = days.join(',') === '1,2,3,4,5' ? '每个工作日' : `每周${days.map(day => '日一二三四五六'[day]).join('、')}`;
      return `${interval} ${spec.time}`;
    }
    case 'cron': return `cron「${spec.expr}」`;
  }
}
export type SchedulePlacement = z.infer<typeof schedulePlacementSchema>;
export type ScheduledTaskView = z.infer<typeof scheduledTaskViewSchema>;
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>;
export type ScheduleReply = z.infer<typeof scheduleReplySchema>;
export type ScheduleRefusal = z.infer<typeof scheduleRefusalSchema>;
export type ScheduleRunRecord = z.infer<typeof scheduleRunRecordSchema>;
