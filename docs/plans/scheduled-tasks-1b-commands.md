# T1b：定时任务的命令核、IPC/RPC、client 和终端

## 1. 做什么

把 T1a 的存储和调度器接成能用的东西：唯一写入口的命令核、host 到 bot 子进程的 IPC、RPC、client 方法、终端 `vonvon schedule`。这一片做完能用终端建、改、看任务，但任务不会运行：调度器的 tick 由 T2 启动。总设计第 3、6、13 节；产品行为 3.13。基线 T1a 合入后的 `dev`，分支 `codex/scheduled-tasks-1b-commands`，目标 `dev`。

## 2. 范围

- 新文件：`D/admin/schedule-commands.ts`、`D/server/rpc/schedule.ts`、`D/cli/commands/schedule.ts`。
- 改：`packages/protocol/src/rpc.ts`、`packages/client/src/client.ts`、`D/admin/{ipc,service}.ts`、`D/bot/supervisor.ts`、`D/cli/commands/run.ts`、`D/server/http.ts`、`D/cli/index.ts`、`D/cli/daemon-client.ts`、`D/bot/handle-message.ts`（只加 store 和调度器的构造、`schedule` 执行入口；注入的 `run` 抛 `runner-not-wired`，不 `start()`）、`D/agent/entry/registry.ts`（`TurnFacts.scheduled`、`TurnAuth.presence`，见 4.4；原在 T2，挪到这里让 T2 和 T3 能同时开工）。
- 可以假设：T1a 的 schema、`ScheduleStore`、`createScheduler`、`time.ts`。
- 不做：运行（T2）、agent 工具和角色表里"无人回合""不在场"两行的实际调用方（T3，命令核这里先把规则写全）、skill（T4a/T4b）、桌面端（T5，桌面端的 ipc-contract/bridge/facade 三层也留给 T5）。
- 本片不启动 tick：`runNow` 回 `bot-not-running`（调度器回 `'not-started'`）。
- 后面的片可以假设：命令核签名、`ScheduleActor`、IPC op、RPC 方法、client 方法按总设计第 13 节存在，不再改名。

## 3. 现在的代码

- 结构化命令的样板：`D/admin/structured-commands.ts`（s47，22 行）和 `D/cli/commands/settings.ts`（300 行：人类输出、`--json`、退出码表 failed=1、bad-args=2、connection=3、refused=4、conflict=5、outcome-unknown=6）。
- IPC：`D/admin/ipc.ts:27` 的 `AdminIpcOp` 联合和 `createAdminIpcCaller`（默认 15 秒超时）；`D/bot/supervisor.ts:522-546` `executeCollaboration`、`executeGroups`、`executeLibrary` 的接线样板；`D/cli/commands/run.ts:130-137` 单 bot 进程里内联服务的 `op.kind` 分发。
- RPC 六层里的四层在本片：`protocol/src/rpc.ts:15-41` 方法表，`client/src/client.ts:40-53、175-184`，`D/server/http.ts:162-178` 的 `switch (request.method)`，`D/server/rpc/*` 一个文件一组。
- 终端：`D/cli/index.ts:15` 的 `structured = ['settings', 'feishu']`（`--json` 时压掉 commander 的错误输出）；`:28` 的 preAction 跳过名单（这些命令只走 RPC，不建数据目录、不拿 lease）；`:176-196` 的 `settings` 命令组（`--bot`、`--group`、`--json`，`io(options)`）；`D/cli/daemon-client.ts` 的 `withDaemon`、`pickBot`、`pickGroup`、`print`、`localTime`。
- orchestrator 返回对象：`D/bot/handle-message.ts` 约 9253 起（`adminExecute: admit(adminExecute)`、`libraryExecute`、`settings`、`shutdown`）；`admit` 在 1516。
- `turnPerm(project: Project | undefined)`（2990）收的是 `Project`，不是 chatId。

## 4. 怎么改

### 4.1 命令核：`schedule-commands.ts`

```ts
export type ScheduleActor =
  | { kind: 'chat'; openId: string; name?: string; role: 'owner' | 'admin' | 'member'; chatId: string; topicId?: string; messageId?: string; text?: string }
  | { kind: 'scheduled'; taskId: string; runId: string; chatId: string }
  | { kind: 'local'; via: 'desktop' | 'cli' };
export function createScheduleCommands(deps: {
  store: ScheduleStore; scheduler: Scheduler; botId: string; now: () => number; hostTimeZone: () => string;
  limits?: { perChat: number; perBot: number };   // 默认 20 / 200
}): { execute(actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply> };
```

规则（3.13"谁能做什么"，第 16 节的文案）：
- 请求先过 protocol 的 `scheduleRequestSchema`，不过回 `refused bad-schedule`（不抛）。
- **范围**：`chat` 和 `scheduled` 的 `request.chatId` 必须等于 `actor.chatId`，不等回 `not-group`；`listBot` 对它们回 `not-group`。**按 id 找任务也只在 `actor.chatId` 的任务里找**：`store.get(taskId)` 找到的任务 `chatId !== actor.chatId` 一律回 `not-found`（跨群连 id 都不认，T3 验收要点"跨群没有任何入口"靠这一条）。
- `local`：全部动作，`listBot` 只给它。
- `chat`：owner/admin 全部；member 的 `edit/pause/resume/delete/runNow` 要 `task.createdBy.openId === actor.openId`，否则 `not-task-owner`。
- `scheduled`：`list` 只回自己这一个；`edit`、`delete` 只对自己这一个，其余 `scheduled-run-scope`；`create` 回 `no-human-create`；`pause/resume/runNow` 回 `scheduled-run-scope`。
- `create`：`timeZone` 省略取 `hostTimeZone()`；`every` 没 `anchor` 填 `ceilToMinute(now)`；`validateSpec` 不过回 `bad-schedule`；超限回 `task-limit`（文案按超的是群还是 bot）；`placement` 省略时 `follow`（T3 的工具层决定 `topic`/`newTopic`，命令核不猜）；`createdBy` 按 actor 填（`chat` 填 `openId`、`name`、`role`、`messageId`、`text`；`local` 填 `via`）；`cursor = createdAt`；`id = 'st_' + 16 位随机十六进制`；写完 `scheduler.wake()`。
- `edit`：`revision` 不等回 `conflict` 带 current；改了 `spec`：`every` 重新填 `anchor = ceilToMinute(now)`、`cursor = now`、`consecutiveFailures = 0`、`finished` 的任务改回 `active`（Claude 定）；改 `timeZone` 要 `validateSpec` 认识。
- `pause`/`resume`：`resume` 把 `cursor = now`（暂停期间的不补）、清 `consecutiveFailures`、`pausedReason`；`once` 的 `at` 已过去 → 直接 `finished`，回复里的 `describe` 带"（已过期）"。
- `delete`：`revision` 不等回 `conflict`；正在跑也能删，调度器结算时发现任务没了就丢掉。
- `runNow`：转 `scheduler.runNow`，`running` → `running`，`not-started` → `bot-not-running`，`not-found` → `not-found`。
- 视图：`toView(task, now)` 填 `nextRunAt`（`nextSlotAfter(spec, tz, cursor)`，paused/finished 不填）、`running = !!inflight`、`describe = describeSpec(spec, tz, hostTimeZone())`；`tasks` 回复带 `now` 和 `timeZone: hostTimeZone()`。

### 4.2 IPC、service、RPC

- `AdminIpcOp` 加 `{ kind: 'schedule'; via: 'desktop' | 'cli'; request: ScheduleRequest }`，回 `ScheduleReply`；子进程 `onMessage` 分发到 orchestrator 的 `schedule(via, request)`。
- `AdminService` 加 `executeSchedule(botId, via, request): Promise<ScheduleReply>`；supervisor 照 `executeGroups` 接（bot 没在运行回 `{ kind: 'refused', reason: 'bot-not-running', message }`，不抛）；`run.ts:130-137` 内联服务加 `if (op.kind === 'schedule') return handle.schedule(op.via, op.request)`。
- `server/rpc/schedule.ts` 一个文件：从 RPC 的 `clientKind` 推 `via`（desktop/browser → `desktop`，cli → `cli`），调 `service.executeSchedule(botId, via, request)`；`http.ts` 的 switch 加 `case 'schedule'`；`client.ts` 加 `schedule(botId, request)`。
- host 侧 actor 固定 `{ kind: 'local', via }`：RPC 带本机凭据的都是主人（和 settings 一样）。
- orchestrator 返回对象加 `schedule: admit((via, request) => commands.execute({ kind: 'local', via }, request))`；构造 `createScheduleStore(paths.bots(appId).schedules)`、`createScheduler({ run: () => { throw new Error('runner-not-wired'); }, gate: () => 'ok', notifyAutoPause: async () => {}, maxInflight: () => 1, ... })`，不 `start()`。

### 4.3 终端：`vonvon schedule`

```
vonvon schedule list   --bot <bot> --group <群>              [--json]
vonvon schedule list   --bot <bot> --all                      # listBot
vonvon schedule add    --bot <bot> --group <群> --name <名> --every 30m | --daily 09:00 | --weekly mon,wed@10:00 | --at "2026-11-01 14:00" | --cron "0 9 * * 1-5" [--new-topic] [--tz Asia/Tokyo] <要做什么>
vonvon schedule edit   --bot <bot> --group <群> <taskId> --revision <r> [同上的时间选项] [--name] [--tz] [<要做什么>]
vonvon schedule pause|resume|run|delete <taskId> --bot <bot> --group <群> [--revision <r>]
vonvon schedule runs   <taskId> --bot <bot> --group <群>     # 总次数加最近 20 条
```

时间选项互斥，只能给一个；`--every` 接受 `30m`、`2h`；`--weekly` 的星期用 `mon..sun`；`--at` 按 `--tz`（省略时按 daemon 回的时区——先 `list` 一次拿 `timeZone`，不按终端所在机器的时区）解析成 epoch。人类输出一行一个任务，逐字按总设计第 16 节"终端一行"；`runs` 一行一条记录：`11-01 09:00 · 完成 · 12 秒 · <链接或"—">`。`--json` 原样输出 reply。退出码沿用 s47 的表，`refused` 退 4，`conflict` 退 5。bot 会话里（`VONVON_SESSION` 环境在，`inBotSession`）直接拒绝，和 `vonvon memory` 一样。`index.ts:15` 的 `structured` 加 `'schedule'`，`:28` 的跳过名单加 `parent === 'schedule'`，帮助文字加一组例子。

### 4.4 在场的两个字段（给 T2、T3 用）

- `registry.ts` 的 `TurnFacts` 加 `scheduled?: { taskId: string; runId: string }`；`TurnAuth` 加 `presence: 'human' | 'scheduled' | 'none'`，`openTurn` 里推导：`kind === 'human'` → `'human'`；`facts.scheduled` 在 → `'scheduled'`；其余（`bot`、`wake`、`initiative`、`retry`）→ `'none'`。`noteSteer` 不改（它已经把 `human` 置 false）。`memoryTurn` 的 `kind` 对 `scheduled` 回 `initiative`（总设计第 8 节）。
- 本片没有调用方填 `facts.scheduled`：T2 的 `runScheduled` 填，T3 的工具读。

## 5. 测试

main 必败：命令核、IPC op、RPC 方法、终端命令在基线不存在。

- `schedule-commands.test.ts`（内存 store、假调度器），每格一条：
  - owner/admin 的 8 个动作都允许；member 建 → 允许，改别人的 → `not-task-owner`，改自己的 → 允许；scheduled `create` → `no-human-create`，改别的任务 → `scheduled-run-scope`，`list` 只回自己，`edit` 自己 → 允许；chat 的 `request.chatId` 不等 → `not-group`；chat 用另一个群的任务 id `edit/delete/runNow/pause` → `not-found`；local `listBot` → 全部，chat `listBot` → `not-group`。
  - 第 21 个（同群）→ `task-limit` 文案"本群已有 20 个任务…"；第 201 个（跨群）→ "这个 Bot 已有 200 个任务…"。
  - `every` 请求没 `anchor` → 存储里有、等于 `ceilToMinute(now)`；`describe` 等于 "每 30 分钟"；`tasks` 回复带 `now`、`timeZone`。
  - 坏 spec → `bad-schedule` 带 `validateSpec` 的文案；旧 revision → `conflict` 带 current；`edit` 改 spec 后 `cursor = now`、`anchor` 重填、`finished` 回 `active`；`resume` 的 `cursor` 推到 now，过期的 `once` 直接 `finished`。
  - `runNow` 在调度器 `'not-started'` 时 → `bot-not-running`。
  - 请求不过 schema → `bad-schedule`，不抛。
- `schedule-cli.test.ts`：参数解析（时间选项给两个 → 退 2；`--every 2h` → `minutes: 120`；`--weekly mon,wed@10:00` → `days: [1,3], time: '10:00'`；`--at` 用 daemon 的时区）；人类输出逐字一行；`--json` 原样；各退出码；daemon 不在只报 connection、不建数据目录；`VONVON_SESSION` 下拒绝。
- `schedule-rpc.test.ts`：真实 http 服务到假 service 的 `schedule` 一来一回，`clientKind: 'cli'` → `via: 'cli'`；supervisor 在 bot 没运行时回 `refused bot-not-running`；`run.ts` 内联分发 `schedule` 到 `handle.schedule`。
- `orchestrator-schedule-wiring.test.ts`：orchestrator 构造了 store 和调度器、`start()` 没被调（spy）、`schedule` 入口能 `list`。
- `turn-presence.test.ts`：`openTurn` 带 `facts.scheduled` → `presence: 'scheduled'`、`scheduled.taskId` 在；真人轮 → `'human'`；bot、wake、initiative、retry 轮 → `'none'`；定时轮的 `memoryTurn` kind 是 `initiative`。main 必败。
- 回归定向：cli-admin、cli-admin-rpc、admin-ipc、run-supervisor-dispatch、host-settings、client 的 rpc 表测试。按实际文件名执行，记录写 PR。

## 6. Codex 的自测

JP-VPS，离线隔离，不发飞书消息，不调真实 provider，不用 Bot 6/7/8 和 `accept-home2`，不拿共享验收锁。

- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 重命令加 `flock /tmp/vonvon-heavy.lock`：build、typecheck、lint、定向测试。全量交 CI。
- 终端走一遍：在 `$T/vh` 下 `vonvon daemon start` 加一个假 bot（照 `cli-admin.test.ts` 的做法起假子进程），`schedule add --every 1m`、`list`、`edit --revision`、`pause`、`resume`、`delete`，看文件 `bots/<appId>/schedules.json` 的内容（`every.anchor` 在、没有顶层 `revision`）和 `.corrupt` 旁置。`run` 要回 `bot-not-running`（本片没 runner）。

## 7. 文档

- `docs/v1-plan.md`：T1b 行的做法和实际行数，验收完才勾。
- 不改 `docs/product.md`。
- `D/cli/index.ts` 的帮助文字里加 `schedule` 一组的例子。

## 8. 验收要点

- `schedules.json` 只有 bot 子进程写；host、终端、桌面端没有直接读写它的代码。
- 角色表和 3.13 一致：member 只管自己的，scheduled 不能建、不能碰别的任务，chat 跨群一律 `not-group`，别的群的任务 id 一律 `not-found`。
- 拒绝是回复不是异常；文案逐字等于总设计第 16 节。
- 终端的 `--json` 错误、退出码和 s47 的表一致；daemon 不在不建目录、不自启；`--at` 用 daemon 的时区。
- tick 没启动：有测试证明 `start()` 没被调。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：IPC 超时下的 `outcome-unknown`（和 settings 一样处理）、`via` 一路传对。预计生产约 560 行（commands 220、IPC/service/RPC/client 120、CLI 220）、测试约 520 行，总计约 1,100，低于 1,500。超限先把终端 `schedule` 拆成 T1c，不删测试。自审不代替独立审查；不冻结、不合入。
