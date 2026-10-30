# T1a：定时任务核心（protocol、时间、存储、调度循环）

## 1. 做什么

定时任务的底座里不碰 host 和终端的那一半：protocol 的 schema、时间计算、`schedules.json` 存储（含 fsync 的原子写）、调度循环（建好不启动 tick）。这一片做完用户看不到任何变化；T1b 接命令核和终端，T2 让任务真的跑。总设计 `docs/plans/scheduled-tasks.md`（下称"总设计"）第 4、5、6、13 节；产品行为 `docs/product.md` 3.13。基线 ecd80328，分支 `codex/scheduled-tasks-1-core`，目标 `dev`。

## 2. 范围

- 新文件：`packages/protocol/src/schedule.ts`、`D/bot/schedule/{types,time,store,scheduler}.ts`。
- 改：`packages/protocol/src/index.ts`（导出）、`D/server/atomic-file.ts`（`durable` 选项）、`D/config/paths.ts`（`schedulesFile`）、`D/bot/diagnostics.ts`（五个事件名）。
- 不做：`rpc.ts` 的方法（T1b）、命令核、IPC/RPC/client、终端（T1b）、运行（T2）、agent 工具（T3）、skill（T4a/T4b）、桌面端（T5）。
- 本片不接进 orchestrator：`createScheduler` 只在测试里构造。T1b 在 `handle-message.ts` 里构造并注入抛 `runner-not-wired` 的 `run`；T2 换成 `runScheduled` 并 `start()`。
- 后面的片可以假设：总设计 4.1 的 schema、4.2 的 `StoredTask`、4.3 的 `ScheduledJob`/`ScheduledOutcome`/`ScheduledHook`、第 5 节的函数名、第 6 节 `createScheduler` 的签名，不再改名。

## 3. 现在的代码

- 原子写：`D/server/atomic-file.ts` 的 `writeFileAtomic`（临时文件加 rename，**没有 fsync**）；仓库里带 fsync 的写法在 `D/service/systemd.ts:186`（`file.sync()`）和 `D/import/bridge/files.ts:35`。
- 坏文件挪开的做法：`D/bot/topic-registry.ts:185` 的 `readStore` 返回 `'corrupt'`，`.corrupt` 旁置。
- 路径：`D/config/paths.ts` 的 `botPaths(appId)` 返回 `bots/<appId>/` 下各文件的显式清单。
- 诊断事件：`D/bot/diagnostics.ts`；supervisor 用 `parseDiagnosticsIpc` 收子进程的事件。
- protocol 用 zod 3.25（`packages/protocol/package.json`），daemon 用 zod 4.6；protocol 里的 schema 只在 daemon 的命令核边界和 host 校验用，不嵌进 agent 工具的入参（总设计 4.1"zod 版本"）。
- 时区格式化的现成函数：`packages/protocol/src/display.ts:20` 的 `formatTime(value, { timeZone })`（界面用的相对格式，不是本片要的 `YYYY-MM-DD HH:mm`）。

## 4. 怎么改

### 4.1 protocol：`schedule.ts`

逐字按总设计 4.1。`index.ts` 导出全部 schema 和推导类型（`ScheduleSpec`、`SchedulePlacement`、`ScheduledTaskView`、`ScheduleRequest`、`ScheduleReply`、`ScheduleRefusal`、`ScheduleRunRecord`）。`every.anchor` 在请求里可省略，存储里必有。不加 `rpc.ts` 的方法（T1b）。

### 4.2 时间：`time.ts`

按总设计第 5 节导出 `nextSlotAfter`、`latestSlotWithin`、`countSlotsBetween`、`instantOf`、`localParts`、`parseLocal`、`parseCron`、`describeSpec`、`validateSpec`、`formatAt`、`formatHHMM`、`hostTimeZone()`。`every` 没有 `anchor` 时 `nextSlotAfter` 抛错（命令核保证存储里有）。`validateSpec` 的文案逐字用总设计第 16 节那一行。

### 4.3 存储：`store.ts`

```ts
export function createScheduleStore(file: string, deps: { now: () => number; log: Logger; diagnostics: (event) => void; newRevision?: () => string }): ScheduleStore;
interface ScheduleStore {
  load(): Promise<{ interrupted: StoredTask[] }>;   // 启动时一次；坏文件挪开、记 schedule-store-corrupt；返回带 inflight 的任务，由调度器记 interrupted
  all(): StoredTask[]; byChat(chatId): StoredTask[]; get(taskId): StoredTask | undefined;
  /** 配置变化：create/edit/pause/resume/state 改变。回调里改到的任务换新 revision、updatedAt = now。串行、原子写。 */
  mutateConfig<T>(fn: (tasks: StoredTask[], touch: (task: StoredTask) => void) => T): Promise<T>;
  /** 运行时状态：cursor/inflight/counts/recent/lastResult/noticePending。不换 revision。 */
  mutateRuntime<T>(fn: (tasks: StoredTask[]) => T): Promise<T>;
  onChange(listener): () => void;                   // 给调度器 wake 和以后的推送
}
```

- 两个 `mutate` 共一条 promise 链，同一时刻只有一个写；先改深拷贝，`writeFileAtomic(file, json, { durable: true })` 成功再换内存；写盘失败抛错、内存不改。回调的返回值原样返回（调度器用它拿 `'claimed'`）。
- `touch(task)` 才换 revision（16 位随机十六进制）；`mutateConfig` 里没 `touch` 的任务不换。
- 每个任务 `recent` 超过 20 条砍最旧的；`lastResult.excerpt` 截 500 字（按字符，不按字节）。
- `atomic-file.ts`：`writeFileAtomic(path, data, opts?: { durable?: boolean })`，`durable` 时 `open` 临时文件、`writeFile`、`sync()`、`close`、`rename`、再 `open` 父目录 `sync()`（目录 fsync 在 macOS 上可能 `EINVAL`，吞掉只记日志）。默认不变，别的调用方不受影响。
- `paths.ts`：`botPaths(appId)` 加 `schedules: join(dir, 'schedules.json')`。

### 4.4 调度循环：`scheduler.ts`

按总设计第 6 节实现全部判定、认领、并发上限、结算、崩溃、`runNow`、`stop()`/`drain()`。本片测试里注入假的 `run`、`gate`（恒 `'ok'`）、`notifyAutoPause`、`maxInflight`。tick 的时间推进全部经 `deps.now` 和 `deps.timers`，测试用假时钟。`start()` 先 `await store.load()`，把返回的 `interrupted` 任务按第 6 节"崩溃"记录，再起第一次 tick。

## 5. 测试

main 必败：本片的文件和入口在基线不存在，测试文件在基线下编译不过；这是缺功能，不冒称基线已复现安全断言。每条写输入和期望：

- `schedule-time.test.ts`
  - `nextSlotAfter(every 30, anchor 10:01:00, after 10:00:23)` → 10:31:00；`after 10:31:00` → 11:01:00（严格大于）。
  - `nextSlotAfter(once at X, after X−1)` → X；`after X` → undefined。
  - `nextSlotAfter(daily 09:00, Asia/Shanghai, after 2026-11-01 09:00)` → 2026-11-02 09:00 的 epoch。
  - `weekly [1,3] 10:00` 从周一 10:00 之后 → 周三 10:00；从周三 10:00 之后 → 下周一 10:00。
  - 夏令时 gap：`instantOf(America/New_York, 2026-03-08 02:30)` → 03:30 EDT 的 epoch；fold：`instantOf(America/New_York, 2026-11-01 01:30)` → 第一次（EDT）的 epoch。`daily 02:30` 在 3 月 8 日那天的 slot 是 03:30。
  - 跨年：`daily 00:00` 从 2026-12-31 00:00 之后 → 2027-01-01 00:00。
  - cron：`*/15 * * * *` 从 10:07 → 10:15；`0 9 * * 1-5` 从周五 09:00 之后 → 下周一 09:00；`0 9 1 * 1`（日和星期并集）从 11-01（周日）09:00 之后 → 11-02 周一 09:00；`0 0 30 2 *` → undefined；`parseCron('a b c')` 抛"cron 不合法"。
  - `latestSlotWithin(every 1, anchor A, now = A + 7 天 1 小时, 7 天)` → now 所在的那个整分 slot（不是 A + 10000 分钟）；`latestSlotWithin(daily 09:00, now = 周三 08:00, 7 天)` → 周二 09:00；`latestSlotWithin(cron '0 9 1 1 *', now = 6 月, 7 天)` → undefined。
  - `countSlotsBetween(every 1, A, A + 3 小时)` → 180；`countSlotsBetween(cron '* * * * *', A, A + 30 天)` → 10000（封顶）。
  - `describeSpec`：七个例子逐字等于总设计第 5 节；`timeZone` 和 host 不同加"（Asia/Tokyo）"。
  - `validateSpec`：一次性已过、超过一年、`every 0`、`every 10081`、`time '9:00'`、`days []`、`cron '0 0 30 2 *'`、时区 `'Mars/Olympus'` 各一条，文案逐字等于第 16 节。
  - `parseLocal(Asia/Shanghai, '2026-11-01 14:00')` → epoch；`'2026-13-01 14:00'` → undefined。
- `schedule-store.test.ts`（真实临时目录）
  - `load` 空目录 → 0 个任务，文件不建；写一次后文件存在、`version: 1`、没有顶层 `revision`。
  - `mutateConfig` 里 `touch` 的任务 revision 变、没 `touch` 的不变；`mutateRuntime` 改 cursor 后 revision 不变。
  - 两个并发 `mutateConfig` 的结果都在文件里；写失败（目录只读）抛错、内存等于写前。
  - 坏 JSON → 挪到 `.corrupt-<时间>`，`load` 回空，诊断 `schedule-store-corrupt` 一条；`version: 2` 同样。
  - 21 条 `recent` → 20 条、最旧的没了；`excerpt` 501 字 → 500 字。
  - `load` 返回带 `inflight` 的任务。
  - `writeFileAtomic(..., { durable: true })` 调了 `sync`（用 `fs` 的 spy 断言 `fsync` 至少两次）；不带选项不调。
- `schedule-scheduler.test.ts`（假时钟、内存 store）
  - `every 1` 到点 → `run` 调一次，`job.slot` 等于那个整分，`trigger: 'schedule'`，`nth: 1`。
  - 睡 3 小时醒来（时钟跳 3 小时再 tick）→ `run` 一次、`trigger: 'catchUp'`、slot 是最近的；`recent` 里一条 `missed count: 179`，`counts.missed` 179。
  - 睡 8 天 → 不跑；`missed count` 等于 8 天的 slot 数；`cursor = now`；`once` 变 `finished`。
  - `run` 挂着不返回，下一个 slot 到 → `recent` 加 `skipped reason running`，`counts.skipped` 1，`cursor` 推进。
  - 跑前 `inflight` 和 `cursor` 落盘：`run` 回调里读文件能看到 `inflight.runId`、`inflight.revision`。
  - `load` 看到 `inflight` → `interrupted by crash`，`counts.runs` +1，`consecutiveFailures` +1，不重跑。
  - 10 次 `failed counts: true` → `paused`、`pausedReason: 'failures'`、revision 变、`notifyAutoPause` 调一次；第 11 个 slot 不跑；`done` 把计数清零；`failed counts: false` 不加计数；`interrupted by shutdown/user` 不加不减。
  - `notifyAutoPause` 抛错 → `noticePending: true`，下个 tick 再调；成功后清掉；24 小时后不再调。
  - `once` 的结算：`run` 期间把 `spec.at` 改到 20 分钟后 → 结算后仍 `active`、`nextRunAt` 是新时间；没改 → `finished`；`interrupted` 的 `once` → `finished`。
  - `runNow`：`slot = now`、`trigger: 'manual'`、`cursor` 不动、下一次定时不变；`inflight` 在 → `'running'`；没 `start()` → `'not-started'`；`paused` 的任务能跑。
  - tick 单飞：tick 里 `run` 还没被认领时连调 3 次 `wake()` → 同一个 slot 只 `run` 一次、`inflight` 只写一次。
  - 认领：`mutateRuntime` 回调里 `cursor` 已被别人推进 → 不 `run`。
  - 并发上限 2：同一 tick 三个任务到点 → 前两个起跑、第三个等第一个 settle 后起；起跑间隔 2 秒（假时钟）。
  - `gate` 返回 `disabled` → `skipped reason disabled`、不出声、不计失败；`tier-unavailable` → `failed`、计失败；`unbound` → `failed`、计失败。
  - `stop()` 后 `wake()` 不再认领；`drain(5000)` 等 settle 写完返回；超过 5 秒也返回。
- 回归定向：`atomic-file` 的现有测试（按实际文件名）、`topic-registry`、`paths`。

## 6. Codex 的自测

JP-VPS，离线隔离，不发飞书消息，不调真实 provider，不用 Bot 6/7/8 和 `accept-home2`，不拿共享验收锁。

- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 重命令加 `flock /tmp/vonvon-heavy.lock`：build、typecheck、lint、定向测试。全量交 CI。
- 跑第 5 节三个测试文件和回归定向；`flock /tmp/vonvon-heavy.lock npm run typecheck`、`lint`。没有真飞书步骤。

## 7. 文档

- `docs/v1-plan.md`：T1a 行的做法和实际行数，验收完才勾。
- 不改 `docs/product.md`（随总设计 PR 已改）。

## 8. 验收要点

- `schedules.json` 的写只经 `store.ts`，`durable` 原子写有 fsync 的测试证据。
- revision 只在 `touch` 时换；runtime 写不换，有测试。
- 至多一次：`inflight` 和 `cursor` 在 `run` 之前落盘，有真实文件读回的测试；重启不重跑；tick 单飞；认领在 `mutate` 里。
- 睡眠补跑：只补最近一次，`latest` 直接算（每分钟任务睡 7 天 1 小时的用例），更早的一条合并记录带 `count`；7 天外不跑。
- `once` 自己改时间不被结算冲掉；中断的 `once` 变 `finished`。
- 夏令时 gap/fold 两个方向都有测试；`every` 1 分钟能建，0 分钟不能。
- 并发上限和 2 秒间隔有假时钟测试。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：时区数学（gap/fold、倒推、跨年）、存储写入的串行和崩溃一致性、认领和单飞的竞争。都用假时钟和真实文件测试压住。预计生产约 620 行（protocol 120、time 260、store 120、scheduler 240、atomic-file 和 paths 20）、测试约 580 行，总计约 1,200，低于 1,500。超限先把 `cron` 的解析和倒推拆成 T1a2，不删测试。自审不代替独立审查；不冻结、不合入。
