# 定时任务：总设计（T1 到 T5）

owner 2026-10-30 定，一次做到位，没有"第一版"（这里的"v1"指产品的第一个版本，不是功能的第一版）。产品行为写在 `docs/product.md` 3.13，本文只写做法、共享契约和切片。八个 PR（T1a、T1b、T2、T3、T3b、T4a、T4b、T5）都从最新 `origin/dev` 开 `codex/<片>` 分支，目标 `dev`（`AGENTS.md`"2026-10-30 起"）。行号按基线 ecd80328；`origin/dev` 已再前进 13 个只改 Windows 安装和更新的提交，不碰本文引用的文件，行号漂了按函数名找。

2026-10-30 两轮审查（对照代码的 28 条、对照决定和格式的 23 条）后改了一版，改了什么见第 17 节。

## 1. 做什么

一种基础能力：定时任务。周期的（每 N 分钟、每天或每周几点、cron）和一次性的。bot 给自己排"20 分钟后回来看"也是一次性任务，由提示词驱动，不另做能力。任务属于一个（bot，群），以那个 bot 的身份跑，卡片发在那个群；按群当时的会话方式决定进哪条会话。谁能建、谁能改、错过和失败怎么算、记录留什么，全在 3.13，本文不重述。

不做：webhook 和事件触发；额度管理（20/200 的上限只防失控，不是额度）；多设备（只留钩子，见 4.4）；后台默默跑（agent 跑起来就一定有卡）。

## 2. 已定的事（出处 3.13）

| 事 | 定法 | 出处 |
|---|---|---|
| 能力 | 周期加一次性；bot 自己的后续动作用一次性任务 | 3.13"是什么" |
| 归属 | （bot，群）；别的群只经连接器查，结果还发在本群 | 3.13"属于谁" |
| 谁能建改 | 能和 bot 说话的人建；主人和管理员管全部；成员只管自己的；无人回合只管自己这一个 | 3.13"谁能做什么" |
| 权限 | 只读档的群也能建；运行时按群当时的档；不存档位 | 3.13"权限" |
| 去哪条会话 | 单会话和智能进主区会话；多会话群和话题群每次新隐藏会话开新话题；**话题里建的一次性任务**回那个话题；说了"开个话题发"每次新话题；说了"就在这个话题里发"周期任务也留在话题 | 3.13"结果发在哪" |
| 卡片 | agent 跑起来就有进度卡，带小字标签；不删空卡；起不来的那一次发一行文字说明 | 3.13"卡片" |
| 错过 | 7 天内只补最近一次，更早的记"错过"；一次性超过 7 天记错过并结束 | 3.13"错过、跳过、失败" |
| 跳过 | 上一次还在跑、群停用、群正在修改：这一次记"跳过"，不排队 | 同上 |
| 失败 | 记录；连续 10 次自动暂停，群里发一条 @ 创建人 | 同上 |
| 记录 | 总次数加最近 20 条；只留最近一次结果的前 500 字 | 3.13"记录" |
| 时区 | 创建时取 daemon 所在电脑的时区，每个任务存 IANA 名；桌面端和工具可以明确给 | 3.13"限制" |
| 最短间隔 | 1 分钟 | 同上 |
| 两家自带定时 | 关掉 | 3.13"关掉两家自带的定时" |
| 无人回合 | 设置工具拒绝；提问卡 15 分钟超时照旧 | 3.13"没人在场" |
| 解绑、移出群 | 都只暂停（`unavailable`），不删；Bot 页能看到并删 | 3.13"属于谁" |

## 3. 架构

```
                 ┌──────────────── bot 子进程 ────────────────┐
 终端 vonvon schedule ──RPC──► host ──IPC──►│ schedule-commands（唯一写入口，查权限） │
 桌面端 任务 tab ─────RPC──► host ──IPC──►│      │                                   │
 agent 工具（Claude MCP / Codex dynamicTools）─►│  schedule/store.ts（schedules.json）  │
                                           │  schedule/scheduler.ts（tick、补跑、跳过）│
                                           │      └──► handle-message runScheduled   │
                                           └──────────────────────────────────────────┘
```

- **一份命令核**：`D/admin/schedule-commands.ts`，照 s47 的 `structured-commands.ts`。终端、桌面端 RPC 和 agent 工具都调它，它是用户请求改 `schedules.json` 的唯一入口，范围和角色在这里查，不在调用方查。调度器的运行时写入和解绑时的 `markUnavailable` 不经命令核，直接走 store 的两个 `mutate` 入口。
- **命令是手，skill 是说明书**：工具只是命令的壳；内置的任务 skill 教 agent 什么时候用、怎么写 spec、怎么算时间，常驻一行，用时再加载（3.6）。
- **agent 不在 shell 里跑命令行**：沙箱连不上 daemon（e04、e04b），命令行拿的是本机主人凭据。Claude 走进程内 MCP `vonvon_bot`（`D/agent/claude-agent/thread.ts:327-343` 组装）；Codex 走 app-server 的 dynamicTools（第 9 节）。
- **四把钥匙**（3.13"谁能做什么"的实现）：
  1. 能和 bot 说话的人：会话本来就只给 `project.allowedUsers` 开，工具不再查一遍。
  2. 授权绑在（bot 进程，群，位置，发起人角色）上：s46 的 grant 已有前三项；位置里的"话题"不能在签发时填（`createWithPermission`，`handle-message.ts:1339`，收到的 place 都是 `{ kind: 'group', chatId }`，bot 自己开的话题要等 `adoptThreadId` 才有 id），所以 grant 带一个**现取**的 `where(): { inTopic: boolean; topicId?: string }`，调工具时才读（第 10 节）。任务工具**不收群参数**，群从 grant 取，话题从 `where()` 取；命令核再按 actor 的 `chatId` 过滤一遍，别的群的任务连 id 都查不到（`not-found`）。
  3. 角色看这一轮：`TurnAuth.role` 是 owner/admin 管全部，member 只管自己的；无人回合（定时运行）只能改或结束自己这一个任务，不能建；被别人插话过的回合、没有发起人的回合（bot 之间、唤醒、重试）不能写（第 8 节"在场"）。
  4. 档位：创建不看档；运行时 `turnPerm(project)` 取群当时的档，任务里不存。

## 4. 数据模型

### 4.1 protocol：`packages/protocol/src/schedule.ts`（zod 3）

```ts
import { z } from 'zod';

export const scheduleRefusalSchema = z.enum([
  'not-group',           // 私聊、评论会话；chat actor 的 listBot
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
  revision: z.string(),                   // 只在配置变化时换（见 4.2）
  name: nameSchema, instruction: instructionSchema,
  spec: scheduleSpecSchema, timeZone: z.string(), placement: schedulePlacementSchema,
  state: z.enum(['active', 'paused', 'finished']), pausedReason: z.enum(['manual', 'failures', 'unavailable']).optional(),
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
  z.object({ action: z.literal('listBot') }).strict(),                                   // 只给桌面端和终端
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
```

RPC：`rpc.ts` 加 `schedule`，参数 `{ botId: agentIdSchema, request: scheduleRequestSchema }`，回复 `scheduleReplySchema`。拒绝走回复的 `refused`，不抛错（和 s47 一样，拒绝是结果不是异常）。

**zod 版本**：protocol 是 zod 3.25，daemon 是 zod 4.6（`z.toJSONSchema` 自带）。daemon 里 agent 工具的入参 schema（`D/agent/entry/tools.ts` 的 `input: z.ZodObject` 是 zod 4）不能嵌 protocol 的 zod 3 对象：`schedule-tools.ts` 用 zod 4 另写一份工具入参（第 10 节的形状），转换成 `ScheduleRequest` 后再过命令核，命令核用 protocol 的 schema 校验。仓库里没有 `zod-to-json-schema`，不加。

### 4.2 存储：`bots/<appId>/schedules.json`（Claude 定）

一个文件，bot 子进程独占写。`D/server/atomic-file.ts` 的 `writeFileAtomic` 只有临时文件加 rename、没有 fsync（仓库里 fsync 的只有 `service/systemd.ts` 和 `import/bridge/*`）：T1a 给它加一个 `{ durable: true }` 选项（写完 `fsync` 临时文件、rename、再 `fsync` 目录），`schedules.json` 用它，别的调用方不变。否则断电、内核崩溃能让 `cursor` 退回去、同一个 slot 再跑一次；"至多一次"只对进程崩溃成立。host 不读不写；桌面端和终端的改动经 RPC → IPC → 子进程 → 命令核。

```ts
type ScheduleStoreFile = { version: 1; tasks: StoredTask[] };   // 没有文件级 revision
type StoredTask = Omit<ScheduledTaskView, 'nextRunAt' | 'running' | 'describe' | 'botId'> & {
  cursor: number;                 // 已处理的最后一个 slot（epoch ms）；下一个 = nextSlotAfter(spec, tz, cursor)
  inflight?: { runId: string; slot: number; trigger: 'schedule' | 'catchUp' | 'manual'; startedAt: number; revision: string }; // revision 是起跑时的配置版本
  noticePending?: true;           // 自动暂停的那条群消息还没发出去，下次 tick 再试
};
```

- **revision 只跟配置走**：`create`、`edit`、`pause`、`resume`，以及调度器自己改 `state`（自动暂停、`finished`）、解绑时 orchestrator 的 `markUnavailable(chatId)` 改 `unavailable`（T2 4.6），都换新；`cursor`、`inflight`、`counts`、`recent`、`lastResult`、`noticePending` 的写入不换。否则每分钟的任务一轮两次写，桌面端表单打开 40 秒就冲突。`store.mutate` 分两个入口（T1a 4.3）。
- `version` 不认识、文件解析失败：移到 `schedules.json.corrupt-<时间>`，从空开始，记诊断（照 `topic-registry.ts:185` `readStore` 的 `corrupt` 做法）。
- 一个 bot 最多 200 个任务，一个群最多 20 个（Claude 定；防失控，不是额度）。`recent` 固定 20 条，什么状态都算，新的挤掉旧的（一次跑 3 分钟的每分钟任务，窗口里大约 7 次运行加 14 条跳过；接受，不另开两个窗口）；`counts.runs` 是开跑过的总次数（done、failed、interrupted），不含 missed 和 skipped。
- 删除任务连记录一起删。bot 被移出群（`onBotRemovedFromChat`，`handle-message.ts:8897`，它调 `removeProject` 等于解绑）、桌面端解绑群和私聊控制台删项目（`DM.rmDo`）：这个群的 `active` 任务改 `paused`、`pausedReason: 'unavailable'`，不删（和"解除关联保留目录、项目及其记忆"一致，3.1 第 7 条）。重新绑同一个群，任务还在，手动恢复。Bot 页的汇总里能看到、能删（Claude 定，第 15 节）。

### 4.3 内部结果和钩子：`D/bot/schedule/types.ts`

```ts
export type ScheduledJob = { task: StoredTask; runId: string; slot: number; trigger: 'schedule' | 'catchUp' | 'manual'; nth: number; late: boolean };
export type ScheduledOutcome =
  | { status: 'done'; excerpt: string; messageId?: string; topicId?: string; durationMs: number }
  | { status: 'failed'; error: string; messageId?: string; topicId?: string; durationMs: number; counts: boolean } // counts=false：飞书连不上、一张卡都没发出去，不计入连续失败
  | { status: 'skipped'; reason: 'disabled' | 'updating' | 'held' }                                                 // 运行前的门没过，不出声
  | { status: 'interrupted'; by: 'shutdown' | 'user'; messageId?: string; topicId?: string };                        // 崩溃的 interrupted 由调度器在启动时写，by: 'crash'
/** 一次定时运行在 orchestrator 里的回执。orchestrator 的每条丢弃路径都要调 settle，所以它幂等：第一次算数。 */
export interface ScheduledHook {
  job: ScheduledJob;
  /** 这一轮所有消息和卡片的落点，替代合成消息的 id：main 用 message.create，不引用；topic 用 reply 到 anchor、reply_in_thread */
  target: { kind: 'main' } | { kind: 'topic'; anchor: string };
  started(info: { messageId?: string; topicId?: string }): void;
  settle(outcome: ScheduledOutcome): void;
}
```

`TurnExtra.scheduled?: ScheduledHook`（`TurnExtra` 在 `handle-message.ts:774`，`queueOnly` 也在那里）→ `QueuedTurn.scheduled`（505）→ `LaunchOpts.scheduled`（6931）→ `launchRun` 里的 `currentTurn.scheduled`。orchestrator 记一个 `scheduledHooks: Set<ScheduledHook>`，`shutdown()` 的排空循环（9188）之后把还没 settle 的全部 `settle({ status: 'interrupted', by: 'shutdown' })`。

### 4.4 多设备的钩子（settled 18）

只留不挡路的：任务 id 是 `st_` 加 16 位随机十六进制，不含机器信息；`schedules.json` 里没有机器名、路径、进程号；`timeZone` 跟任务走。别的不做。

## 5. 时间计算：`D/bot/schedule/time.ts`

只用 `Intl.DateTimeFormat`，不加 cron 库。所有函数纯函数，`now` 由调用方传。

- `nextSlotAfter(spec, timeZone, afterMs): number | undefined`：严格大于 `afterMs` 的下一个 slot。`once` 在 `at > after` 时返回 `at`，否则 undefined。`every`：`anchor + k × minutes`，k ≥ 1 的最小值使结果 > after（纯算术）；创建于 10:00:23 的"每 30 分钟"，anchor 是 10:01:00，第一次 10:31:00，再 11:01:00。`daily`/`weekly`/`cron`：用 `localParts(timeZone, ms)` 取本地年月日时分和星期，按本地时间逐分钟前推，日不匹配就跳到下一天零点，最多推 400 天，推不到返回 undefined（cron 写了 2 月 30 日这种）。
- `latestSlotWithin(spec, timeZone, nowMs, windowMs): number | undefined`：`(now − window, now]` 里最后一个 slot，直接算，不从 cursor 枚举。`every` 算术；`daily`/`weekly` 从 now 的本地日期往前最多 8 天逐日试；`cron` 从 now 所在分钟逐分钟倒推，最多 `window` 那么多分钟（7 天是 10080 步，200 个任务也只在醒来那一次 tick 跑）。
- `countSlotsBetween(spec, timeZone, fromExclusive, toInclusive, cap = 10000): number`：错过了多少个。`every` 算术；`daily`/`weekly` 按天算；`cron` 枚举到 cap 为止，到 cap 就返回 cap（记录里写"10000+"）。
- `instantOf(timeZone, y, m, d, hh, mm)`：本地时间到 epoch ms。夏令时跳过的时间（gap）取跳过后的第一个合法时刻；重复的时间（fold）取第一次。用"猜一个 UTC、用 Intl 反算本地、修正差值、再反算一次"的办法，不依赖 `Date` 的本机时区。
- `parseLocal(timeZone, 'YYYY-MM-DD HH:mm'): number | undefined`：给工具和终端的 `--at` 用，经 `instantOf`。
- `parseCron(expr)`：5 段，支持 `*`、数字、`a-b`、`a,b`、`*/n`、`a-b/n`；星期 0 到 7（7 当 0）；日和星期都给了取并集（标准 cron）。不支持名字（MON、JAN）和 `L`、`W`、`#`。
- `describeSpec(spec, timeZone, hostTimeZone)`：人话。`every 30` → "每 30 分钟"；`every 120` → "每 2 小时"（60 的倍数）；`daily 09:00` → "每天 09:00"；`weekly [1,2,3,4,5] 09:00` → "每个工作日 09:00"；`weekly [1,3] 10:00` → "每周一、三 10:00"；`once` → "10 月 31 日 14:00 一次"（跨年写"2027 年 1 月 2 日 09:00 一次"）；`cron` → "cron「0 9 * * 1-5」"。`timeZone !== hostTimeZone` 时后面加"（Asia/Tokyo）"。
- `validateSpec(spec, now, timeZone): string | undefined`：人话错误，全文见第 16 节。`timeZone` 用 `Intl.DateTimeFormat(undefined, { timeZone })` 试一次认不认识。daemon 的时区用 `Intl.DateTimeFormat().resolvedOptions().timeZone`。
- `formatAt(ms, timeZone, hostTimeZone)`：`YYYY-MM-DD HH:mm`，时区不同加"（Asia/Tokyo）"；`formatHHMM(ms, timeZone)`。头部、卡片标签、终端一行都用这两个。
- `ceilToMinute(ms)`：向上取整到整分，正好整分的不动；命令核在创建和改 spec 时用它填 `every.anchor`（10:00:23 → 10:01:00）。

## 6. 调度循环：`D/bot/schedule/scheduler.ts`

```ts
export function createScheduler(deps: {
  store: ScheduleStore; now: () => number; timers: { setTimeout; clearTimeout };
  run: (job: ScheduledJob) => Promise<ScheduledOutcome>;          // T2 的 runScheduled；T1a 注入的抛 runner-not-wired
  gate: (chatId: string) => 'ok' | 'disabled' | 'updating' | 'held' | 'unbound' | 'tier-unavailable'; // T2 注入（第 8 节）
  notifyAutoPause: (task: StoredTask) => Promise<void>;            // 群里发一条 @ 创建人；抛错表示没发出去
  notifyGateFailure: (task: StoredTask) => void;                  // 门回 tier-unavailable、记完 failed 之后调；T2 注入：发一行文字、按任务限频，调度器不等、不重试
  maxInflight: () => number;                                        // T2 注入 max(1, floor(getMaxConcurrentRuns(cfg) / 2))
  log: Logger; diagnostics: (event) => void;
}): { start(loaded: { interrupted: StoredTask[] }): Promise<void>; stop(): void; drain(ms): Promise<void>; wake(): void; runNow(taskId): 'started' | 'running' | 'not-found' | 'not-started' };
```

返回值的类型从 `scheduler.ts` 导出为 `Scheduler`（`store.ts` 同样导出 `ScheduleStore`），T1b 命令核的 `deps` 用这两个名字。

- **tick**：每 30 秒一次，`setTimeout` 链，每次到点用 `now()` 算，不信任 timer 本身。电脑睡眠时 timer 停，醒来后第一次 tick 就按真实时间补。`wake()` 在命令核每次写完后调，马上 tick 一次。**tick 单飞**：一个在跑时 `wake()` 只置"再来一次"标志，跑完立刻再跑一遍；不会两个 tick 看到同一份快照各发一次。
- **先看缓存**：每个任务缓存 `nextRunAt`（配置变了、跑完了就重算）；`now < nextRunAt` 的任务 tick 里不碰，Intl 只在到点的任务上算。
- **每个任务的判定**（按 3.13"错过、跳过、失败"）：
  1. `state !== 'active'` 跳过。`now < nextRunAt` 跳过。
  2. `latest = latestSlotWithin(spec, tz, now, 7 天)`。没有（最近 7 天里一个 slot 都没有，但 `nextRunAt <= now`，说明错过的都在 7 天之前）：`n = countSlotsBetween(spec, tz, cursor, now)`，`counts.missed += n`，`recent` 加一条 `{ status: 'missed', slot: nextRunAt, count: n }`，`cursor = now`；`once` 改 `finished`。不跑。
  3. 否则 `n = countSlotsBetween(spec, tz, cursor, latest) − 1`，n > 0 就记一条合并的 missed（同上，`count: n`）。然后处理 `latest`：`trigger = now − latest >= 60_000 ? 'catchUp' : 'schedule'`（Claude 定：晚 60 秒以上算补跑，卡片写"原定 HH:MM"）。
  4. **门**（T2 注入的 `gate(chatId)`）：`disabled`、`updating`、`held` → 记 `{ status: 'skipped', reason, slot: latest }`，`counts.skipped++`，`cursor = latest`，不出声；`unbound`、`tier-unavailable` → 记 `failed`（`error` 见第 16 节），走第 7 条的失败计数，`tier-unavailable` 记完再调 `notifyGateFailure(task)` 发一行文字（第 8 节）。
  5. 这个任务 `inflight` 还在（上一次没跑完）：记 `{ status: 'skipped', reason: 'running', slot: latest }`，`counts.skipped++`，`cursor = latest`，不跑。
  6. **在同一个 `mutate` 里认领**：回调里重读 `state`、`cursor`、`inflight`，和 tick 开头看的一样才写 `inflight = { runId, slot: latest, trigger, startedAt: now, revision }`、`cursor = latest`；回调返回 `'claimed'` 才调 `run`，否则放弃（别的 tick 或 `runNow` 抢先了）。原子写成功后才调 `run`，这是"至多一次"。
- **并发上限**（Claude 定）：同一时刻在跑的定时运行不超过 `maxInflight()`；到点但没槽的任务在调度器里排队，有槽就按到点先后起跑，每次起跑间隔 2 秒；排队期间同一任务又到了新 slot，只换成新的：被换掉的旧 slot 在一个 runtime `mutate` 里记 `{ status: 'missed', slot: 旧 slot, count: 1 }`、`counts.missed++`、`cursor = 旧 slot`，不记 skipped；新 slot 起跑时第 3 条的合并 missed 只数旧 slot 之后的，不重复记。不同任务可以同时跑；同一任务同一时刻一个。进会话的排队由 orchestrator 的 `queueOnly` 管。
- **结算**：`run` 返回后在一个 runtime `mutate` 里写 `recent`、`counts.runs++`（done、failed、interrupted 才加）、`lastResult`（done 时 excerpt；failed 时 error 前加"失败："）、清 `inflight`。`done` 把 `consecutiveFailures` 清零；`failed` 且 `counts: true` 加一，到 10 改 `paused`、`pausedReason: 'failures'`（这是配置变化，换 revision）、`noticePending = true`、调 `notifyAutoPause`，成功才清 `noticePending`，失败留着每次 tick 再试，最多 24 小时；`interrupted`（停机、用户停止）不加不减（Claude 定）；`skipped` 不进 `counts.runs`。**`once` 的结束**：结算时任务仍是 `state === 'active'` 且 `nextSlotAfter(spec, tz, cursor) === undefined` 才改 `finished`（运行中被 `markUnavailable` 或手动暂停的，保持 `paused`）——运行里 agent 用 `schedule_edit` 把自己的 `at` 往后挪了，就还是 `active`（"20 分钟后再看一次"靠这一条）；暂停后 `resume` 时 `at` 已过去也改 `finished`。结算发现任务已被删，丢掉。
- **崩溃**：`start(loaded)` 不读盘，处理 `loaded.interrupted`（`load()` 时带 `inflight` 的任务；store 由 orchestrator 在 `initialize()` 里先 load，tick 没起时命令核也看得到盘上的任务，T1b 4.2）：在一个 runtime `mutate` 里按 id 重读，任务已删或 `inflight` 已清就跳过，否则记 `{ status: 'interrupted', by: 'crash' }`、清掉、`counts.runs++`、**`consecutiveFailures` 加一**（Claude 定：每分钟把 bot 进程弄崩的任务也要能自动暂停；干净停机走结算，不会留下 `inflight`，所以这里看到的就是崩溃或超过停机宽限被 SIGKILL）；不重跑（cursor 已过）；`once` 按上一条的规则判 `finished`。记完才起第一次 tick，`start` 的 promise 这时 resolve。`initialize()` load 完到 `start(loaded)` 处理完之间，这些任务在 `list` 里仍显示 `running: true`（`inflight` 还没清）；这段只有几秒，处理完就对了，不另做标记。
- **手动运行**：`runNow` 用 `trigger: 'manual'`，`slot = now`，不动 `cursor`，不影响下一次定时；同样在 `mutate` 里认领，`inflight` 在时返回 `'running'`；`paused`、`finished` 的任务也能手动跑；没 `start()` 返回 `'not-started'`。
- **停机**（顺序在 `D/bot/bridge.ts:113-141` 的 `shutdown`）：`scheduler.stop()` 同步停 timer、置 stopping（不再认领）；然后 `orchestrator.shutdown()`——它马上 `interrupt` 所有运行（`handle-message.ts:9161-9175`），排空后把没 settle 的钩子 settle 成 interrupted；然后 `await scheduler.drain(5000)` 等结算写完，`closing` 里排在 `orchestratorClosing` 之后。子进程只有 `CHILD_SHUTDOWN_GRACE_MS = 8000`（`D/host/lifecycle.ts:300`）就被 SIGKILL，所以 5 秒是上限，没有 60 秒排空。5 秒内没写完的留给下次启动的 `inflight` → interrupted（by: crash，会计一次失败；接受）。

## 7. 运行放在哪、带什么（T2）

### 7.1 放置表

| 群的会话方式 | placement `follow` | 落点 `target` |
|---|---|---|
| 规则·单会话 | 主区会话（key 是 chatId），提示词不可见地注入 | `main`：卡片 `message.create`，像平常回复，不引用；排在真人后面的那一轮也不引用前一张卡 |
| 智能 | 同上 | 同上 |
| 规则·多会话 | 每次新建隐藏会话 | 开新话题（下面"开新话题"） |
| 话题群（消息形式是话题） | 同上 | 同上 |
| 任意方式，placement `newTopic` | 每次新建隐藏会话 | 开新话题 |
| 任意方式，placement `topic` | 那个话题的会话（`resolveThread` 按 topicId） | `topic`：anchor 用 `desktopTopicReply`（6519）现取那个话题最近一条消息，reply 加 `reply_in_thread` |

话题的会话找不到了（话题被删、会话被清、`desktopTopicReply` 抛错）：退回 `follow`，头部多一句"原话题找不到了，这次发在这里"（Claude 定）。

**开新话题**：飞书的话题只能靠对一条真实消息 `reply_in_thread` 建出来（`startTopicDirectly` 回的是 `msg.messageId`，4022-4026；`message.create` 发出去的是主区消息，没有 thread_id，`adoptThreadId` 没东西可认）。做法照桌面端恢复会话（6719-6725）和 `startGoal`（6843）：先发一行文字根消息 `⏰ 定时任务「{name}」· 第 {nth} 次{late}{manual}`，`recent.addOwn` 记进主区；再把进度卡 reply 到它、`reply_in_thread: true`；`getThreadId` 拿话题 id，`noteOpenedTopic` 照记。话题的第一条是这行文字，卡片是第二条。3.13 这样写。新写一个 `startScheduledTopic`，不拿合成消息去套 `startTopicDirectly`（它还会 `runReaction`、`ingestContext`、`pullMainBefore` 那条消息）。

**没有合成消息 id**：`runScheduled` 还是造一个 `NormalizedMessage`（`messageId: vsched_${task.id}_${slot}`，`chatId`，`threadId`（放话题时），`senderId` 空，`requesterKind: 'unknown'`）好走 `handleTurn` 的路，但**所有发消息、建卡的地方都按 `hook.target` 落**，不看 `msg.messageId`：`launchRun` 的 `replyTo`（7350、7489）、排队后续轮的 `replyTo = finalMsgId`（7894）、占位卡（7066）和 `state.waiting`（7061，定时回合不设，免得进 dropped.json）、失败消息（3712、7972）、`intakeCancelled` 的两条（3117、3152）、goal 忙的提示、`refuseUnavailableTier`（3024，定时回合不走它）、`early()`（3307）、`endCard`/`askAgain`（7090、7924、7959）。`getThreadId` 对 `vsched_*` 不查飞书。T2 4.2 逐条列。

定时回合从不插话：一律 `queueOnly`，会话正忙就排队，排在真人消息后面。反过来也一样：**定时回合在跑时来的真人消息排队，不插话进去**（`ActiveState.scheduled = true` 时 `deliverPreparedTurn` 按 `queue` 走）——插进去的人会被当成"没人在场"，建任务会被拒。

### 7.2 固定上下文

进已有会话的，正文前加一行（名字和时间由程序填，不让 agent 自报）：

```
（定时任务「{name}」· {describe} · 第 {nth} 次{late}{manual}{fallback}。现在没有人在场：不要提问，不要等人确认；能定的自己定，做不了的直接写出来。）
{instruction}
```

- `{nth}` = 起跑时的 `counts.runs + 1`（手动运行也算一次；错过、跳过不算）。
- `{late}` 在 `trigger === 'catchUp'` 时是 ` · 原定 {HH:MM}，{HH:MM} 开始`，否则空；`{manual}` 在手动运行时是 ` · 手动运行`；`{fallback}` 在话题找不到时是 ` · 原话题找不到了，这次发在这里`。
- 时间用 `formatHHMM`/`formatAt`，按任务的时区，和 daemon 时区不同时加"（Asia/Tokyo）"。

新建隐藏会话的，先走话题的正常开场（`topicOpening`：角色设定、记忆、主区最近几行），再接：

```
（定时任务「{name}」· {describe} · 第 {nth} 次{late}{manual}。现在没有人在场：不要提问，不要等人确认；能定的自己定，做不了的直接写出来。）
任务内容：{instruction}
由 {creator} 在 {createdAt} 创建{original}
{previous}
```

- `{creator}`：`createdBy.name`（聊天里建的，从消息的 `senderName` 取）；没有名字时按 `via`：chat → "群成员"，desktop → "桌面端"，cli → "终端"。`{createdAt}` 用 `formatAt`。
- `{original}` 在创建人原话存在时是 `，原话："{text ≤500 字}"`。
- `{previous}` 在有上一次结果时是 `上次结果（{formatAt(at)}，{status 中文}）：{excerpt ≤500 字}` 加一行飞书链接（`lastResult.link`，没有链接就写"（在本群的话题里）"或"（在本群主区）"）；没有上一次结果就不写。状态中文：done 完成、failed 失败、missed 错过、skipped 跳过、interrupted 中断。

### 7.3 卡片标签

进度卡顶部小字行：`⏰ 定时任务「{name}」`，补跑加 ` · 原定 {HH:MM}`，手动加 ` · 手动运行`。最终卡保留这一行。不删空卡（`dropSilentCard` 对定时回合直接返回 false）；agent 一个字没写卡片就照原样留着，不另写"这次没有输出"（settled 6 只说留卡）。

## 8. 门、失败、自动暂停、在场

- **运行前的门**（调度器的 `gate(chatId)`，T2 注入，在起跑前查，不占会话）：`turnRefusal(project, chatId)`（5049）的四种——没绑定 → `unbound`；`project.enabled === false` → `disabled`；`projectMutations`、`resumePublications` → `updating`；再加 `tierInfo(table, env, mode).unavailable`（`refuseUnavailableTier` 3012 用的那个判断，今天只在 `onMessage` 的路上查，`handleTurn` 不查）→ `tier-unavailable`；桌面端要改这个群、碰上有运行时登记的 `holdFiring(chatId, 60 秒)` → `held`。都过了才 `runScheduled`。
- **门没过怎么记**：`disabled`、`updating`、`held` → `skipped`，不出声（停用的群 bot 不该说话）；`tier-unavailable` → `failed`，群里发一行文字（第 16 节），计入连续失败，10 次照常暂停；`unbound` → `failed`，不出声（解绑时任务已经 `unavailable` 暂停了，走到这里只可能是竞争）。自动暂停的 @ 消息不往停用、未绑定的群发。
- **运行中的失败**：`failed` 包括后端失败、空闲超时（600 秒）、建卡失败、最终卡片更新失败。`error` 是短原因，≤200 字。`counts: false` 的 failed（飞书连不上、一张卡都没发出去）记录但不计入连续失败——Wi-Fi 断 10 分钟不该把每分钟的任务停掉。
- **中断**：停机（`shuttingDown`）→ `interrupted by shutdown`；用户按卡片的停止 → `interrupted by user`（`markInterrupted` 已有）。都不动连续失败计数。崩溃见第 6 节。
- **自动暂停**：连续 10 次自动暂停。群里发一条文字（不是卡片），文案见第 16 节；创建人有 `openId` 放 at 节点，没有就纯文字。发不出去 `noticePending`，下次 tick 再试，最多 24 小时。恢复后计数清零。
- **在场**（`TurnAuth.presence`，T1b 加字段和推导，T2 填 `facts.scheduled`，T3 用）：`openTurn`（`registry.ts:313-323`）时推导：先看 `facts.scheduled`，在 → `'scheduled'`（合成的定时轮怎么都不会算成 `'human'`）；再看 `kind === 'human'` → `'human'`；其余（`bot`、`wake`、`initiative`、`retry`）→ `'none'`。`noteSteer`（333-339）被别人插话后 `auth.human = false`、`steered = true`，任务工具的写动作按 `not-human-turn` 拒；`list` 照常。定时回合是无人回合：`TurnFacts.scheduled = { taskId, runId }`，memory 工具照常（记忆回合的 `kind` 映射到已有的 `initiative`，不加枚举值、不迁移，Claude 定），提问卡照旧 15 分钟超时（`ask-coordinator.ts:151-155`）、超时后这一轮按"没人回答"继续。设置类工具只在私聊签发（`registry.ts:294` 的过滤，`authorizeNow` 第一条就是 `not-dm`），定时回合都在群里，"设置工具拒绝无人回合"天然成立，不改 `authorizeNow`、不加测试。
- 任务里不存档位：运行时 `turnPerm(project)`。完全访问档的群里定时任务也完全访问，没人看着也不会问，3.13 写明。
- **群的编辑锁**：`editProject`/`removeProject`（6589）和 `libraryWorkspaceCheck`（9225）今天看 `active.size > 0`——这个 bot 任何群有运行都挡。每分钟跑 40 秒的任务会让所有群的桌面端编辑和解绑三分之二时间失败。T2 改成只看本群：`ActiveState` 记 `chatId`，锁只数 `chatId === project.chatId` 的运行；碰上本群有运行时 `holdFiring(project.chatId, 60_000)`，调度器这 60 秒里不给这个群起新运行（记 `skipped held`），用户重试就能成功。

## 9. 两家的工具通路和自带定时

### 9.1 Claude（T3）

进程内 SDK MCP `vonvon_bot` 加 schedule 类工具（第 10 节）。关掉自带定时（2026-10-30 在锁定的 SDK 0.3.296 上实测；`sdk.d.ts` 里 `disallowedTools`、`settings.skillOverrides`、`plugins`、`skipMcpDiscovery`、`enabledPlugins` 都在）：`D/agent/claude-agent/thread.ts:345-371` 组 query 选项时，在 `...cfg.permission` 之后合并 `disallowedTools: [...已有, 'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger']`，放在 thread.ts 而不是 `permission.ts`，因为 `permission.ts:90` 完全访问档提前返回，放那里会被跳过；`AUTO_COMPACT_SETTINGS` 和它的 plan 变体加 `skillOverrides: { loop: 'off', schedule: 'off' }`（自带的 `loop`、`schedule` skill 在 disallowedTools 之后还会列出来）；群的 skill 白名单（`group-skills.ts:92-99` 的 `enabledNames`）也过滤掉 `loop`、`schedule`；`sessionClaudeEnv`（`backend.ts:97`）加 `CLAUDE_CODE_DISABLE_CRON: '1'` 做第二道。验证：起一条会话让它列工具，这五个不在，skill 里没有 loop 和 schedule。

### 9.2 Codex：app-server dynamicTools（T3b）

0.156.1（`CODEX_MIN_VERSION`）和 0.163.0 都实测过（笔记随 PR 进 `docs/research/2026-10-30-scheduled-tasks/`，第 18 节）：`thread/start` 带 `dynamicTools: [{ type: 'namespace', name: 'vonvon_bot', tools: [...] }]`，只读沙箱、`approvalPolicy: never` 下都能调；工具在 thread/start 时固定，resume 从盘上恢复，不能往已有线程加。`deferLoading` 要 namespace 形状。调用来的是服务端请求 `item/tool/call { threadId, turnId, callId, namespace, tool, arguments }`，回 `{ contentItems: [{ type: 'inputText', text }], success }`。

- 本设计只把 schedule 类工具放上这条通路。设置和飞书工具的 Codex 一侧仍按 s46b 另定；dynamicTools 已证明可用，s46b 开工时优先考虑它，沙箱外 MCP 退为备选（Claude 定；`docs/plans/s46.md` 4.1 的 E 项由本实测推翻，那份计划不改）。
- 生成的协议类型（`D/agent/codex-appserver/protocol/generated/`）没有 `dynamicTools` 字段，`protocol/index.ts:5` 指的 `codex:protocol:update` 脚本不存在。做法：手写 `D/agent/codex-appserver/dynamic-tools.ts` 的类型和 schema，不改生成文件。服务端请求的分发在 `D/provider/transport/jsonrpc.ts:301-308` 的 `peer.onRequest`（`app-server-client.ts` 只是 re-export），今天只认 `item/tool/requestUserInput`；`item/tool/call` 的处理函数放 `server-requests.ts`，在 `approvalAnswer`、`userInputRequest` 旁边。
- **调用绑到这一轮**：今天 `registry.ts:169-170` 对 Codex（`releaseAfterRun !== undefined`）的每一次调用都按 `grant.firstTurn` 授权，不是"恢复线程的第一轮绑错"，是整条线程永远按第一轮的人算；真人开的线程上后来跑定时回合，`schedule_create` 会按真人的第一轮放行。改法：`turn/start` 的应答到了（`backend.ts:363` 拿到 `result.turn.id`）就 `entry.noteToolUse(turnId)`，把这一轮登记成 origin；`item/tool/call` 用 `params.turnId` 当 `toolUseId` 调 `entry.call`，应答还没到就等它最多 2 秒；删掉 `registry.ts:169` 的 `releaseAfterRun` 分支，两家都走 `origins`。goal 运行（`launchGoalRun` 8017）和子线程不调 `openTurn`，查不到 origin 就是 `unknown-origin`，拒掉，正好。
- 本功能上线前已经开着的 Codex 会话，没有任务工具，要等下一条新会话。3.13 写明；`session_info` 的回复里也说（第 16 节）。Codex 不拿 memory 工具（`hiddenBlocksFor` 的分支不动）。
- 关掉自带自动化：实测用的是假 provider（`requires_openai_auth=false`），没挂主人 ChatGPT 账号的 `codex_apps` 连接器，所以"工具表里没有自动化工具"只在没登录时成立。T3b 自测里在 JP-VPS 真实 ChatGPT 登录下列一次工具表（一条真实回合让模型列出它的工具，或读 `thread/start` 后的工具事件），有自动化、定时类的就加进关闭名单再合入。会话层 config 仍加 `features.in_app_local_automation = false`：`codexSessionParams`（`backend.ts:95-101`）的 `features` 今天是三处 spread（sandbox 的 `features`、`...NATIVE_MEMORY_OFF`、Windows 的覆盖），直接再 spread 一个会把 `memories: false` 盖掉或在 Windows 上丢掉——改成一处深合并 `features: { ...sandbox.features, ...NATIVE_MEMORY_OFF.features, ...NATIVE_SCHEDULING_OFF.features, ...(win32 非完全访问 ? { prefer_mxc: false } : {}) }`，`memory-config.ts` 旁加 `NATIVE_SCHEDULING_OFF`。只核 config 里带了它，不做真实回合的探测。

## 10. agent 工具（T3；Codex 的接法在 T3b）

类 `'schedule'`，`D/agent/entry/tools.ts:24` 的 `class` 加这一项。入参用 daemon 的 zod 4 写在 `D/agent/entry/schedule-tools.ts`，JSON schema 用 `z.toJSONSchema`，两家共用同一份定义。哪些会话带这类工具只看 `profile.tools.schedule`：T3 在 `profileOf`（`handle-message.ts:1114`）里算，绑定的群会话为真（主区和话题都是，只读档也是），评论会话和私聊为假；T4b 装不装 skill 看同一个字段；登记表再按 `grant.place.kind === 'group'` 挡一道（`not-group`）。

| 工具 | 入参 | 回复 |
|---|---|---|
| `schedule_list` | `{}` | 第一行"现在 {formatAt(now)}（{timeZone}）· 本群 {n} 个任务"，下面 JSON：本群本 bot 的任务（无人回合只有自己这一个），每条带 `describe`、`nextRunAt`、`lastResult`、最近 3 次 |
| `schedule_create` | `{ name, instruction, when, where?: 'here' \| 'thisTopic' \| 'newTopic', timeZone? }` | 新任务；第一行"已创建：日报 · 每个工作日 09:00 · 下次 11-02 09:00（Asia/Shanghai）"，下面 JSON |
| `schedule_edit` | `{ taskId, revision, patch: { name?, instruction?, when?, where?, timeZone? } }` | 改后的任务，或 conflict |
| `schedule_pause` / `schedule_resume` | `{ taskId }` | 任务 |
| `schedule_delete` | `{ taskId, revision }` | `{ deleted: taskId }` |
| `schedule_run_now` | `{ taskId }` | `{ runId }` 或 `running` |

- `when`（给 agent 的时间写法，daemon 换算成 `spec`）：`{ kind: 'once', at: 'YYYY-MM-DD HH:mm' }` 或 `{ kind: 'once', inMinutes: 1..525600 }`；`{ kind: 'every', minutes }`；`{ kind: 'daily', time: 'HH:mm' }`；`{ kind: 'weekly', days: [1..5], time }`；`{ kind: 'cron', expr }`。不让模型算 epoch 毫秒。
- `where`：省略是 `here`。`here` 且 `grant.where().topicId` 在、`when.kind === 'once'` → `{ kind: 'topic', topicId }`；`here` 且周期 → `follow`（话题里说"每天 9 点发日报"也跟群走，每次开新话题）；`thisTopic`（用户说"就在这个话题里发"）：`where().inTopic` 且 `topicId` 在 → `{ kind: 'topic', topicId }`，`inTopic` 但 `topicId` 还没有（bot 刚开的话题，卡片发了、飞书还没回 thread id）→ 拒 `topic-pending`，不在话题里（主区）→ 按 `here` 算，不拒；`newTopic` → `newTopic`。`where()` 带 `inTopic`，是因为只看 `topicId` 分不出主区和还没认领的话题。
- `timeZone`：可选，IANA 名，`validateSpec` 认不认识；省略取 daemon 的。回复里总带时区，agent 看得出 daemon 在 UTC 的 VPS 上。
- `TurnAuth` 加 `presence: 'human' | 'scheduled' | 'none'`（T1b 加字段和推导）和 `scheduled?: { taskId, runId }`；登记表的 `authorizeSchedule(auth, action)` 实现 3.13 的角色表和第 8 节"在场"。拒绝按 s46 的方式返回结构化 reply，不抛错。
- 和 s46 一样过接纳、排队、提交点三道检查；`schedule_create` 在提交点再查一次这一轮还开着。
- actor 在登记表里组装：`{ kind: 'chat', openId, name, role, chatId, topicId, messageId, text }`（`name` 是 `TurnFacts.requesterName`，T3 加字段并在 `launchRun` 填；`text` 是触发消息的原话 ≤500 字，`typed` 为真时才带，照记忆的来源检查）或 `{ kind: 'scheduled', taskId, runId, chatId }`。

## 11. 内置 skill（T4a、T4b）

- 名字 `scheduled-tasks`，Claude 里是 `vonvon:scheduled-tasks`，标题"任务"。frontmatter 的 `description` 一行常驻："创建、修改、暂停、删除本群的定时任务，或给自己排一个稍后回来看的一次性任务。用户提到定时、每天、每周、提醒、稍后、过一会再看时读本 skill。"正文按需加载，必须有的句子在 T4a 4.2。
- **今天没有交付代码**：`packages/daemon/src` 里没有 `plugins`、`enabledPlugins`、`skipMcpDiscovery`、`selectedCapabilityRoots`、`skillOverrides` 的任何用法；两家 backend 的 `profileCapabilities.capabilityPackages` 都是 `false`，`session-profile.ts:31` 收到任何能力包就抛"尚未支持（s39）"；`docs/v1-plan.md` 的 s39d、s44a 都是 `[ ]`。所以 T4b 自己做最小交付：`SessionProfileCapabilities.capabilityPackages` 改成 `boolean`，两家置 `true`；`resolveSessionProfile` 放行 `capabilityPackages`（`mcpServers` 照旧抛）；`SessionProfile.capabilityPackages` 的元素加 `kind: 'builtin'`（以后 s39d 加 `'user'`），不另发明 `profile.builtinSkills`。
- 生成器 `D/agent/builtin-skills/package.ts`（`ensureBuiltinPackage(appId, set, skills[])`），写到 `bots/<appId>/capabilities/builtin/<set>/`，`set` 是**稳定名**（今天只有 `group`；s54a 加 `dm`），不是内容哈希：Codex 的 rollout 记的是起线程时的能力根路径，resume 不重读 `selectedCapabilityRoots`，哈希目录一换，老线程指向被删的目录，skill 就没了。内容变了原地重写；**永远不删**目录。插件形状：`.claude-plugin/plugin.json`、`skills/<name>/SKILL.md`。s48 飞书 skill、s54a 设置 skill 复用这个生成器。和 s39d 的用户能力包是两个根（Claude 定，第 15 节；s39d 写的"唯一能力包"指用户装的那个包，本文明确分开）。
- Codex：`selectedCapabilityRoots: [{ id: 'vonvon-builtin', location: { type: 'environment', environmentId: 'local', path } }]`；只读、读写档在 `workspace-policy.ts` 给 `[path]: 'read'`；`skills/list` 列不出能力根里的 skill，核验改看一条真实回合里 Codex 能不能按 description 找到并读到正文。版本矩阵 0.156.1 和 0.163.0 都要过（product.md 第 9 节第 21 项今天说 0.156.1 没跑过）；0.156.1 不行就抬 `CODEX_MIN_VERSION`，PR 里写明。
- Claude：`plugins: [{ type: 'local', path, skipMcpDiscovery: true }]`，`enabledPlugins['vonvon@inline'] = true`，skills 白名单加 `vonvon:scheduled-tasks`。第 9 节第 22 项（仓库的 `.claude/settings.json` 写 `enabledPlugins` 关掉 vonvon 的插件）在 T4b 实测一次，能关就在 `settings` 里再写一遍 `enabledPlugins` 压过去，压不过写进 3.6。
- 装不装跟工具走：`profile.tools.schedule` 为真才装，和带不带 schedule 类工具是同一个开关（第 10 节）。

## 12. 桌面端和网页（T5）

- 群详情页加"任务"tab：列表（名字、描述、下一次、状态、最近一次结果一行）；新建和编辑对话框（名字、要做什么、什么时候：一次 / 每 N 分钟 / 每天 / 每周 / cron，发到哪：跟群走 / 每次开新话题（编辑已固定在话题的任务时多一个只读的"固定在原话题"，不改选就保留；新建不能选），时区：默认浏览器的时区、可改、总显示 daemon 的时区）；暂停、恢复、删除、立即运行；展开看总次数和最近 20 条（时间、状态、用时、"在飞书打开"）。页脚固定一句："{deviceTitle}关机、睡眠，或 Vonvon 没在运行时，任务不会运行。错过的只补最近一次（7 天内），更早的记为"错过"。"
- `timeZone` 由表单明确发（`datetime-local` 按浏览器时区解析，所以任务时区默认就是浏览器的；daemon 在 UTC 的 VPS 上，上海的用户建"每天 9 点"也是上海的 9 点）。
- Bot 没在运行：`schedule` 回 `refused bot-not-running`，tab 显示"Bot 没在运行，任务暂时看不到；启动后再来"，不显示空状态。
- Bot 页加"任务"分区（第四个 pane，和"群聊、记忆、设置"并列）：这个 bot 所有群的任务，一行一个，点进去到群详情页的任务 tab；解绑了的群的任务也列出来，状态写"已暂停：群已解绑"，能删。只给主人和管理员。
- 刷新：tab 打开时每 10 秒重拉一次 `schedule list`，关闭清定时器（Claude 定：不做推送）。
- 功能优先，不做样式；表单用原生 `<input type="datetime-local">`、`<input type="time">`。

## 13. 共享契约汇总

| 东西 | 名字 |
|---|---|
| protocol | `packages/protocol/src/schedule.ts`，从 `index.ts` 导出；`rpc.ts` 的 `schedule` |
| client | `client.ts` 的 `schedule(botId, request)` |
| 桌面端 | `ipc-contract.ts`、`bridge.ts`、`facade.ts` 各加 `schedule` |
| host | `server/rpc/schedule.ts`；`AdminService.executeSchedule(botId, via, request)`；`AdminIpcOp` 加 `{ kind: 'schedule'; via: 'desktop' \| 'cli'; request }`（15 秒超时）；`via` 由 RPC 的 `clientKind` 推（desktop/browser → `desktop`，cli → `cli`），`server/rpc/schedule.ts` 传给 service |
| 子进程 | orchestrator 的 `initialize()` 里 `await loadStore()`（`store.load()` 只调一次，T1b 4.2）；返回对象和 `Orchestrator` 接口加 `schedule: admit(async (via, request) => { await loadStore(); return commands.execute({ kind: 'local', via }, request); })` 和 `scheduler: { start: async () => scheduler.start(await loadStore()), stop: () => scheduler.stop(), drain: (ms) => scheduler.drain(ms) }`（不经 `admit`；T2 的 `bridge.ts` 连上飞书后调 `orchestrator.scheduler.start()` 起 tick，关闭时调 `stop()`、`drain()`），`BridgeHandle` 加 `schedule`（T1b）；`cli/commands/run.ts:130-137` 的内联分发加 `op.kind === 'schedule'` |
| 终端入口 | `D/cli/index.ts:15` 的 `structured` 加 `'schedule'`（`--json` 的错误输出）；`:28` 的 preAction 跳过名单加 `parent === 'schedule'`（不建数据目录、不拿 lease） |
| 命令核 | `D/admin/schedule-commands.ts`：`createScheduleCommands(deps).execute(actor, request): Promise<ScheduleReply>` |
| actor | `type ScheduleActor = { kind: 'chat'; openId; name?; role; chatId; topicId?; messageId?; text? } \| { kind: 'scheduled'; taskId; runId; chatId } \| { kind: 'local'; via: 'desktop' \| 'cli' }` |
| 存储 | `D/bot/schedule/store.ts`，文件 `bots/<appId>/schedules.json`；路径是 `D/config/paths.ts` 的 `botPaths(appId).schedulesFile` |
| 时间 | `D/bot/schedule/time.ts` |
| 调度 | `D/bot/schedule/scheduler.ts` |
| 钩子 | `D/bot/schedule/types.ts` 的 `ScheduledHook`；`TurnExtra.scheduled`、`QueuedTurn.scheduled`、`LaunchOpts.scheduled` |
| 运行 | `handle-message.ts` 的 `runScheduled(job): Promise<ScheduledOutcome>`、`startScheduledTopic`、`scheduleGate(chatId)`、`holdFiring(chatId, ms)` |
| 工具（T3） | `D/agent/entry/schedule-tools.ts`（含 `scheduleToolSpecs()`）；类 `'schedule'`；名字见第 10 节；拒绝原因加进 `D/agent/types.ts:367` 和 `D/agent/entry/ipc-codec.ts:9` 的枚举 |
| Codex（T3b） | `D/agent/codex-appserver/dynamic-tools.ts`（`scheduleNamespace()`）；`server-requests.ts` 的 `dynamicToolCall`；分发在 `provider/transport/jsonrpc.ts` 的 `peer.onRequest` |
| Claude（T3） | `D/agent/claude-agent/thread.ts` 的 `NATIVE_SCHEDULING_TOOLS`、`skillOverrides` |
| skill | `D/agent/builtin-skills/{package,registry,scheduled-tasks}.ts`；目录 `bots/<appId>/capabilities/builtin/<set>/` |
| 终端 | `vonvon schedule list|add|edit|pause|resume|delete|run|runs`，`--bot`、`--group`、`--json` |
| 诊断事件 | `schedule-missed`、`schedule-skipped`、`schedule-auto-paused`、`schedule-interrupted`、`schedule-store-corrupt`、`schedule-notice-pending`（`schedule-interrupted` 在 T2 加，其余五个在 T1a） |

## 14. 切片和时间

| 片 | 名字 | 做什么 | 依赖 | 机器 | 约行数 | 工期 |
|---|---|---|---|---|---|---|
| T1a | `scheduled-tasks-1-core` | protocol、时间计算、存储（含 durable 原子写）、调度循环（不启动 tick） | — | JP-VPS（#422） | ~1,340 | 10-30 开工，10-31 上午合入 |
| T1b | `scheduled-tasks-1b-commands` | 命令核、IPC/RPC、client、终端 `vonvon schedule`、`cli/index.ts` 接线；`TurnFacts.scheduled` 和 `TurnAuth.presence` 两个字段 | T1a | JP-VPS | ~1,150 | T1a 审查期间在它的分支上接着写，T1a 合入后开 PR；10-31 下午合入 |
| T2 | `scheduled-tasks-2-runs` | `runScheduled` 和钩子、放置、开话题、头部和标签、门、结算、自动暂停、停机和崩溃、编辑锁；启动 tick | T1b | JP-VPS（Bot 6，真 Claude 和 Codex） | ~1,450 | 10-31 下午开工，11-01 合入 |
| T3 | `scheduled-tasks-3-tools` | schedule 工具类和角色表、grant 的 `where()`、`profileOf` 算 `tools.schedule`、Claude MCP、关 Claude 自带定时 | T1b（自测第 4 步要 T2 合入） | JP-VPS（真 Claude） | ~1,055（和 T3b 合计 ~1,545，T3 计划第 9 节） | 和 T2 同时开工，11-01 合入 |
| T3b | `scheduled-tasks-3b-codex` | Codex dynamicTools 和 `item/tool/call`、调用按 turnId 绑轮、删 `releaseAfterRun` 授权分支、features 深合并加 `in_app_local_automation: false` | T3 | JP-VPS（真 Codex） | ~490 | 在 T3 的分支上接着写，T3 合入后开 PR，11-01 合入 |
| T4a | `scheduled-tasks-4-skill` | 生成器（稳定目录）、skill 文本、只依赖 T1a 的类型 | T1a | JP-VPS | ~600 | 和 T1b 同时，10-31 合入 |
| T4b | `scheduled-tasks-4b-delivery` | 两家最小能力包交付、读入口、版本矩阵、`enabledPlugins` 实测、核验 | T3b、T4a | JP-VPS；Mac Seatbelt 一项待 owner 验收 | ~900 | 11-01 开工，11-02 合入 |
| T5 | `scheduled-tasks-5-ui` | 桌面端三层接线、群详情页"任务"tab、Bot 页汇总 | T1b（T2 合入后才有运行记录可看） | Mac（#322，网页控制） | ~1,400 | 10-31 下午开工，11-01 合入 |

并行道（工期按小时排，owner 2026-10-30 要快）：T1a 先做；T1a 在审查时，同一个 Codex 在 T1a 的分支上接着写 T1b，T1a 合入后 merge `dev` 再开 T1b 的 PR；T4a 在 T1a 合入后和 T1b 同时做。T1b 合入后 T2、T3（JP-VPS，各一个 Codex 会话）和 T5（Mac）同时开工；T2 和 T3 的真飞书自测共用验收 daemon，按目录锁排队。T3 只依赖 T1b：`TurnFacts.scheduled`、`TurnAuth.presence` 两个字段放在 T1b；T3 自测第 4 步（定时回合里改自己）要等 T2 合入。T3 预计超过 1,500 行，直接拆：Claude 一侧的 T3 先开，同一个 Codex 会话在它的分支上接着写 Codex 一侧的 T3b，T3 合入后开 T3b 的 PR。T4b 在 T3b、T4a 合入后。目标：11-01 能在聊天里建任务、到点运行，11-02 内置 skill 交付完。在飞 PR 按 `AGENTS.md` 的在飞上限（本功能同时在飞的是 T2、T3 或 T3b、T5 和 T4a 或 T4b）。每片一个 PR，目标 `dev`，≤1,500 行（不含 lockfile）。Codex 开 PR 到 `dev`，Claude 审查、打 `frozen`、合入 `dev`；不合入 `main`。各片能从前面假设什么，写在各自计划的"范围"里。T2 超限先拆自动暂停、编辑锁和移出群为 T2b；T3 已按第 9 节拆成 T3 和 T3b。

## 15. 待 owner 确认

Claude 替 owner 定的，owner 可以在 PR 里改：

1. 每个群每个 bot 最多 20 个任务，每个 bot 最多 200 个（防失控，不是额度）。
2. "每 N 分钟"以创建（或改 spec）时刻向上取整到整分为锚，第一次是锚加 N 分钟，不对齐整点、整半点。
3. 解绑群和 bot 被移出群都只暂停这个群的任务（"已暂停：群已解绑"），不删；在 Bot 页能看到、能删；重新绑回同一个群手动恢复。
4. 晚 60 秒以上算补跑，卡片写"原定"。
5. 停机和用户手动停止的中断不算失败也不算成功；bot 进程崩溃时正在跑的那一次算一次失败（连续 10 次照样暂停）。
6. 手动运行不推进下一次定时；暂停和已结束的任务也能手动运行。
7. 任务名 ≤40 字，任务内容 ≤4000 字，一次性任务最远一年，"每 N 分钟"最长 7 天（10080 分钟），cron 要在 400 天内至少到一次。
8. 同一时刻在跑的定时运行不超过并发上限的一半（默认 10 → 5），多的排队、每 2 秒起一个，给真人留槽。
9. 群的档位用不了（后端装不上等）时，这一次不出卡，发一行文字说明并计一次失败；群停用、正在修改时记"跳过"，不出声。
10. Codex 只有任务工具走 dynamicTools；设置、飞书工具的 Codex 一侧另定（s46b）。
11. 桌面端 10 秒轮询，不做推送。
12. 内置能力包和用户装的能力包（s39d）是两个根；内置包目录名固定、永不删除。
13. 自动暂停的那条消息是文字不是卡片，发在主区；发不出去每次 tick 重试，最多 24 小时。

## 16. 用户看得到的文字

| 哪里 | 文字 |
|---|---|
| 拒绝 `not-group` | 定时任务只能在群里管；要看别的群的任务去那个群说，或者用桌面端。 |
| 拒绝 `not-found` | 本群没有这个任务。 |
| 拒绝 `not-task-owner` | 这个任务是别人建的，只有建它的人、主人和管理员能改。 |
| 拒绝 `scheduled-run-scope` | 定时任务运行时只能改或结束自己这一个任务。 |
| 拒绝 `no-human-create` | 定时任务运行时不能新建任务；要再来一次就改自己这个任务的时间。 |
| 拒绝 `not-human-turn` | 这一轮不是由在场的人发起的，不能改任务。 |
| 拒绝 `task-limit` | 本群已有 20 个任务（或：这个 Bot 已有 200 个任务），先删掉不用的。 |
| 拒绝 `running` | 这个任务正在运行，等它结束再试。 |
| 拒绝 `bot-not-running` | Bot 没在运行，任务暂时看不到；启动后再来。 |
| 拒绝 `topic-pending` | 话题还没建好，稍等几秒再试。 |
| `validateSpec` | 一次性任务的时间已经过了 / 一次性任务最远只能排到一年后 / 间隔最短 1 分钟，最长 7 天 / 时间要写成 HH:mm / 星期要在 0 到 6 之间，至少一个 / cron 不合法：{原因} / 这个 cron 在 400 天内没有一次会到 / 不认识这个时区：{名字} |
| 门没过 `tier-unavailable`（群里一行文字） | ⏰ 定时任务「{name}」这次没跑：本群的权限档现在用不了（{现有 unavailableTierReply 的一句}）。连续 10 次会自动暂停。 |
| 门没过 `unbound` 的 error | 群已解绑 |
| 自动暂停（主区文字） | 定时任务「{name}」连续 10 次失败，已自动暂停。@{创建人} 看一下：{最后一次的 error}。到群设置的"任务"里能恢复。 |
| 话题根消息 | ⏰ 定时任务「{name}」· 第 {nth} 次{late}{manual} |
| 卡片标签 | ⏰ 定时任务「{name}」{ · 原定 HH:MM}{ · 手动运行} |
| 桌面端页脚 | {deviceTitle}关机、睡眠，或 Vonvon 没在运行时，任务不会运行。错过的只补最近一次（7 天内），更早的记为"错过"。 |
| 桌面端 bot 没运行 | Bot 没在运行，任务暂时看不到；启动后再来。 |
| 桌面端冲突 | 别人改过了，已刷新成现在的内容；你刚才填的在下面，要的话再改一次。（旧表单内容显示在只读框里，不丢） |
| 终端一行 | `st_… 日报 · 每个工作日 09:00 · 下次 11-02 09:00 · 已启用/已暂停（手动）/已暂停（连续失败）/已暂停（群已解绑）/已结束 · 上次 完成 11-01 09:00` |
| `session_info`（Codex 旧会话） | 回复里加一行 `tools: { schedule: false, note: '这条会话在任务功能上线前开的，没有任务工具；下一条新会话才有' }` |
| 工具描述（agent 看到的） | `schedule_list`：列出本群这个 Bot 的定时任务，含现在的时间和时区。`schedule_create`：给本群建一个定时任务，或给自己排一个稍后回来的一次性任务；时间用 when 写，不用算毫秒。`schedule_edit`：改任务的名字、内容、时间或发到哪；要带 list 里的 revision。`schedule_pause`/`schedule_resume`：暂停、恢复。`schedule_delete`：删除，连记录一起；要带 revision。`schedule_run_now`：马上跑一次，不影响下一次定时。 |

## 17. 2026-10-30 审查后改了什么

对照代码的审查：结算拿不到自己那一轮的结果（第 4.3、6 节的钩子）；合成消息 id 发不出消息（7.1 的 `target`）；开话题要有真实根消息（7.1）；grant 的话题要现取（第 3 节钥匙 2、第 10 节）；停机顺序和 8 秒宽限（第 6 节）；1 万个 slot 的上限和直接算 `latest`（第 5、6 节）；tick 单飞和在 `mutate` 里认领（第 6 节）；一次性任务自己改时间不被结算冲掉、中断的一次性任务不变僵尸（第 6 节）；revision 只跟配置（4.2）；跨群按 id 查不到（第 3 节）；在场的推导和插话（第 8 节）；运行前的门（第 8 节）；群编辑锁只看本群（第 8 节）；skill 目录稳定名（第 11 节）；Codex 调用绑轮（9.2）；定时运行的并发上限（第 6 节）；Claude 隐藏会话跑完关掉（T2）；fsync（4.2）；设置拒绝天然成立（第 8 节）；Codex features 深合并（9.2）；崩溃计失败（第 6 节）；文件路径和函数名改对（各节）；契约对齐、T1 拆两片（13、14）；时区明确给（10、12）；自动暂停消息重试、断网不计失败（第 8 节）；真实登录下列 Codex 工具（9.2）。

对照决定和格式的审查：T4 的"现在的代码"改成实情、拆 T4a/T4b（第 11、14 节）；话题里建的周期任务改回跟群走（第 2、7、10 节）；agent 用 `when` 给时间（第 10 节）；`every` 的锚进 spec（4.1、第 5 节）；创建人信息经 actor（第 10、13 节）；文案表（第 16 节）；多设备钩子（4.4）；工期和并行道（第 14 节）；3.13 补标记和漏写的行为；叫法表加"任务"。

## 18. 随本 PR 一起提交

- `docs/research/2026-10-30-scheduled-tasks/`：`industry.md`（业界的定时和事件触发，逐条来源和核对结果）、`notes-runner.md`（调度和运行路径）、`notes-tools.md`（命令核、工具通道、Codex dynamicTools 在 0.156.1、0.163.0 上的实测，第 4 节是关掉 Claude 自带定时的核对）、`notes-skill.md`（能力根和插件形状的 12 条实测）、`notes-ui.md`（桌面端和协议），和 `docs/research/README.md` 加一节。笔记是英文原文，行号按 `e87a49c4`；和本计划冲突时以本计划为准。按 `docs/research/README.md` 的规矩，查过的不再重查。
