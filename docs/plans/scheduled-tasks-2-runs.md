# T2：定时任务的运行（放置、上下文、卡片、结算、停机）

## 1. 做什么

把 T1a 的调度器接到 orchestrator：`runScheduled(job)` 按群的会话方式把一次运行放进正确的会话，发带标签的进度卡，带固定头部，经钩子结算成 `ScheduledOutcome`；运行前的门、补跑、跳过、自动暂停的群消息、停机和崩溃的 `interrupted`、群编辑锁只看本群；启动 tick。做完这一片，终端建的任务会真的跑。总设计第 6、7、8 节；产品行为 3.13。基线 T1b 合入后的 `dev`，分支 `codex/scheduled-tasks-2-runs`。

## 2. 范围

- 改：`D/bot/handle-message.ts`（`runScheduled`、`startScheduledTopic`、`scheduleGate`、`holdFiring`、`markUnavailable`、`notifyAutoPause`/`notifyGateFailure` 的实现、`TurnExtra/QueuedTurn/LaunchOpts.scheduled`、`ActiveState.chatId/scheduled`、约 25 处按 `scheduled` 分支的点，见 4.2）、`D/card/run-card.ts` 和 `D/card/run-card-stream.ts`（标签行）、`D/bot/context-weave.ts`（头部）、`D/bot/bridge.ts`（连上飞书后 `orchestrator.scheduler.start()`、关闭顺序）、`D/bot/diagnostics.ts`（`schedule-interrupted`）。`registry.ts`（`presence` 推导、`TurnFacts.scheduled`、记忆回合 `kind` 的 `initiative` 映射）在 T1b，`memory-authority.ts`、`run.ts` 不改。
- 可以假设：T1a 的 `createScheduler`、`ScheduleStore`、`ScheduledJob`、`ScheduledOutcome`、`ScheduledHook`；T1b 的命令核和终端。
- 不做：agent 工具（T3）、skill（T4a/T4b）、桌面端（T5）。`TurnFacts.scheduled` 和 `TurnAuth.presence` 两个字段、`presence` 的推导和记忆回合 `kind` 的 `initiative` 映射在 T1b 已加，本片只在定时回合 `openTurn` 时填 `facts.scheduled`；schedule 工具的角色表在 T3。
- 不改群的会话方式、不加新的设置项。

## 3. 现在的代码

- orchestrator：`createOrchestrator`（`D/bot/handle-message.ts`，9295 行）。合成消息的样板：`cardTurnMessage`（8925，重试用）、桌面端的 `startGoal`/resume（`desktopTopicReply` 6519、`launchGoalRun` 8017）。入口：`handleTurn`（3106）、`prepareTurn`（3126）、`deliverPreparedTurn`（3193）、`startReservedRun`（3280）、`startTopicDirectly`（3918，含 3921 的门）、`resolveThread`（3786）、`launchRun`（7170，`LaunchOpts` 6931）、`acquireRunSlot`（7041）、`trackRun`（1530，包的是整个 `launchRun`，含它后面的排队续轮）、`admit`（1516）。
- 一轮怎么丢掉而不留痕：`refusedTurn`（3113，静默返回）；`intakeCancelled`（3117、3152）；goal 忙（3139、3166、3329）；`deferred` 的 `early()`（3307）；`endCard`/`askAgain`（7090、7924、7959）；`shutdown()` 的 `state.queue.length = 0`（9167）。`handleTurn` 准备完就返回，运行本身是 `void trackTask(...)`（3170）和 `startReservedRun` 里的 `void trackRun(launchRun(...))`——所以 `handleTurn` 的 promise 不是"这一轮的结果"。
- `QueuedTurn`（505-546）没有能带定时任务的字段；定时回合排在真人后面时（`existing.queue.push`，3342）结果没有路回去。
- 落点：`launchRun` 建卡用 `replyTo = opts.replyTo`（7350、7489），`RunCardStream.create` 有 `replyTo` 就 `message.reply`（`run-card-stream.ts:338-344`）；排队的续轮 `replyTo = finalMsgId`（7894）引用上一张卡；占位卡（7066）和 `state.waiting`（7061，进 dropped.json）、失败消息（3712、7972）、`refuseUnavailableTier`（3024）都回 `msg.messageId`。
- 开话题：`startTopicDirectly` 回 `anchor?.id ?? msg.messageId` 加 `replyInThread: true`（4022-4026），还对那条消息 `runReaction`、`ingestContext`、`pullMainBefore`；`adoptThreadId`（7437）用 `getThreadId` 认领 `pending:` 键；桌面端恢复会话先发一行文字根消息再 reply 卡片（6719-6725），`startGoal` 同（6843）。
- 排队和插话：`queueOnly` 在 `TurnExtra`（774）；`deliverPreparedTurn` 的 steer 判断（3200）；`wovenSkip`（3251）会把"织进上下文就不单独跑"的消息吞掉，定时回合不能走这条。
- 话题开场：`topicOpening`（3738）、`mainSection`（3723）、`pullMainBefore`（3716）；`noteOpenedTopic`（1700）记新开的话题；`recent.addOwn` 记 bot 自己发的主区消息。
- 头部和织入：`weaveTurnRecordBlock`（3032）、`ingestContextImpl`（3055）；`context-weave.ts` 的 57/59/61 是各类固定行的常量。
- 卡片：`run-card.ts` 的标题行和状态（107、166、223、256）、`markInterrupted`；`run-card-stream.ts:62、317-346` 创建和最终更新；`dropSilentCard`（7150，7779 处调用）删空卡，定时回合要绕开；`finalMessageText`（7811）拿最终正文，excerpt 从这里取。
- 门：`turnRefusal(project, chatId)`（5049）：没绑定、`enabled === false`、`projectMutations`、`resumePublications`；`tierInfo(table, env, mode).unavailable`（3012，只在 `onMessage` 的路上经 `refuseUnavailableTier` 查，`handleTurn` 不查）。`turnPerm(project)`（2990）。重试：`retryTurn`（5057）、`retryTurns`（7792）。
- 编辑锁：`editProject`/`removeProject` 的 `active.size > 0`（6589）；`libraryWorkspaceCheck` 同（9225）。`ActiveState`（699）没有 `chatId`。
- 记忆：`memoryTriggerOf`（1656）；`memory-authority.ts:10` 的 `MemoryTurn.kind`（human/wake/initiative/retry/bot）；`registry.ts:313-323` 的 `openTurn` 推 `kind`、`human`。
- 关闭：`shutdown()`（9138）：`closeAll`、`saveDroppedSync(collectLost())`、清队列、`state.interrupt()`、关线程，然后 `while (acceptedTasks.size || runTasks.size)` 等（**没有 60 秒上限**）；顺序在 `D/bot/bridge.ts:113-141`；子进程宽限 `CHILD_SHUTDOWN_GRACE_MS = 8000`（`D/host/lifecycle.ts:300`）。`collectLost`（9124）、`saveDroppedSync`、`restart-dropped.ts`。
- bot 被移出群：`onBotRemovedFromChat`（8897）调 `removeProject`，就是解绑；桌面端解绑在 `editProject/removeProject`（6586 起）；私聊控制台删项目 `DM.rmDo`（5730 起，5738 调 `removeProject`）也是解绑。三处后面都跟着 `forgetAttention(chatId, 'unbind')`。
- 提问卡：`ask-coordinator.ts:151-155` 的 15 分钟超时；`askAgain`（1905）是"排队的被丢了、请重发"的计数，不是提问卡重问。
- 释放：`releaseIdle`（1442）只在 `thread.releaseAfterRun` 时关进程（只有 Codex 声明），Claude 的线程等 45 分钟 reaper（`SESSION_REAP_IDLE_MS`，1019）。
- 并发：`new Semaphore(getMaxConcurrentRuns(cfg))`（1469，默认 10，`D/config/schema.ts:235-239`）；`queueOnly` 只管同一会话内。
- 飞书链接：`D/bot/outbound-files.ts:82` 的 `messageLink`（`message.get` 回的 `message_position` 拼 applink）；这是今天唯一能指到一条消息的链接做法。
- 子进程启动：`D/cli/commands/run.ts` 调 `startBridge`，拿回的是 `BridgeHandle`（不是 orchestrator）；orchestrator 在 `bridge.ts` 里建（95），`await channel.connect()`（205）之后才 `orchestrator.replyDropped()`（209）；关闭经 `bridge.ts` 的 `shutdown`。
- `NormalizedMessage`（`@larksuiteoapi/node-sdk`）的字段是 `messageId`、`chatId`、`senderId`、`senderName?`、`threadId?`、`createTime`；没有 `topicId`。

## 4. 怎么改

### 4.1 `runScheduled(job): Promise<ScheduledOutcome>`

在 orchestrator 里新增，T1b 构造调度器处换成注入它、`gate: scheduleGate`、`maxInflight: () => Math.max(1, Math.floor(getMaxConcurrentRuns(cfg) / 2))`、`notifyAutoPause`、`notifyGateFailure`（4.2）；`bridge.ts` 在 `channel.connect()` 之后、`orchestrator.replyDropped()` 旁调 `await orchestrator.scheduler.start()`（T1b 暴露的句柄，内部是 `scheduler.start(await loadStore())`；store 已在 `initialize()` 里 load 过，T1b 4.2；`start` 不读盘，处理 `loaded.interrupted` 后起 tick）。

1. 造钩子：`const hook: ScheduledHook = { job, target, started, settle }`，`settle` 幂等、第一次 resolve 返回的 promise；`scheduledHooks.add(hook)`，settle 后删。**这个 promise 不进 `admit`/`trackTask`/`trackRun`**，否则 `shutdown()` 的排空循环等它、它等排空，直到 8 秒 SIGKILL。
2. 决定放置（总设计 7.1）：读群的会话方式和消息形式（`chat.get` 的话题群缓存，s14b）。`follow` 在单会话、智能 → 主区会话，`target: { kind: 'main' }`；多会话、话题群 → 新隐藏会话开新话题；`newTopic` → 同上；`topic` → `resolveThread` 按 topicId，`anchor = await desktopTopicReply(chatId, topicId)`，`target: { kind: 'topic', anchor }`；`desktopTopicReply` 抛错或会话没了 → 退回 `follow` 并 `fallback = true`。
3. 合成消息：`NormalizedMessage` 的 `messageId: vsched_${task.id}_${slot}`，`chatId`，`threadId`（放话题时），`senderId: ''`，`createTime: now`；`requesterKind: 'unknown'`。正文是 7.2 的头部加任务内容。`TurnExtra = { scheduled: hook, queueOnly: true }`。
4. 启动：主区和话题 → `handleTurn` 路径（跳过 `wovenSkip`、judge、响应成员名单、表情、完成提醒，见 4.2）。新隐藏会话 → `startScheduledTopic(hook, project, text)`：`channel.send(chatId, { text: 根消息文案 })`，`recent.addOwn`，然后 `launchRun` 带 `replyTo: root.messageId, replyInThread: true, openTopic: {...}`，`adoptThreadId` 照旧认领；开场用 `topicOpening` 再接 7.2 的新会话块；`noteOpenedTopic` 照记。不复用 `startTopicDirectly`。
5. 结束：`launchRun` 里这一轮（`currentTurn.scheduled` 在的那一轮）终结时调 `hook.settle`：后端 done → `done`（`finalMessageText` 前 500 字做 excerpt，`messageId`/`topicId` 从卡片取，照 `outbound-files.ts` 用 `message.get` 解析 `link`，3 秒超时，失败不填只记日志）；失败、空闲超时、建卡失败、最终卡片更新失败 → `failed`，`counts: true`，`error` 用现有的中文说明；飞书调用在建卡前就失败（`ECONNREFUSED`、`ENOTFOUND`、超时）→ `failed`，`counts: false`；`shuttingDown` → `interrupted by shutdown`；用户按停止（`markInterrupted` 那条路）→ `interrupted by user`。排队续轮切到下一个 `currentTurn` 时，上一个的 `scheduled` 在那一刻 settle，不等后面真人的轮。
6. 跑完的隐藏会话（新话题）：settle 后若 `state.queue` 为空、没人在这个话题里发过消息（`active.get(key)` 还是本 state 且没有 `requesterOpenId` 变化），`sessions.delete(key)` 加 `thread.close()`——Claude 的进程不等 45 分钟 reaper。会话记录留着，有人回话题照常 resume。
7. 定时回合不进 `retryTurns`（失败不自动重试；下一次定时就是重试）。

### 4.2 handle-message 里要分支的点（按 `extra.scheduled` / `currentTurn.scheduled` / `state.scheduled` 判）

逐个过，不漏：
- **落点**（都按 `hook.target`，不看 `msg.messageId`）：`launchRun` 建卡的 `replyTo/replyInThread`（7350、7489：main → 都不设；topic → anchor 加 `true`）；排队续轮的 `replyTo = finalMsgId`（7894：定时轮不引用，重新按 target）；占位卡（7066）；`state.waiting`（7061：定时回合不设）；`runFailureMessage` 的两处（3712、7972）；`intakeCancelled` 的两条（3117、3152：定时回合不发，直接 settle interrupted by shutdown）；`replyGoalBusy`（3139、3166、3329：定时回合不发，settle `skipped reason updating`）；`early()`（3307：settle `skipped updating`）；`endCard`/`askAgain`（7090、7924、7959：队列里的定时轮 settle `interrupted by shutdown` 或 `{ status: 'failed', error: '前一轮出错', durationMs: 0, counts: true }`（7959 那条；没开跑，用时 0；和后端失败一样计入连续失败），不计入 `people`，不发"请重发"）；`refuseUnavailableTier` 定时回合不走（门已查）。
- **丢弃就 settle**：`refusedTurn`（3113：门已查，走到这里是竞争，settle `skipped updating`）；`shutdown()` 清队列（9167）里的定时轮 settle `interrupted by shutdown`；排空循环之后 `for (hook of scheduledHooks) hook.settle({ status: 'interrupted', by: 'shutdown' })`。
- `wovenSkip`、`recalledSkip` 跳过；judge 跳过（智能群不经 judge，直接跑）；响应成员名单跳过；表情不挂；完成提醒不发（已有 bot 发起不提醒的分支扩到 scheduled）；`dropSilentCard` 返回 false；`retryTurns` 不记；记忆回合的 `kind` 不在这里改（T1b 的 `openTurn` 已按 `facts.scheduled` 推成 `initiative`）；`collectLost`/`saveDroppedSync` 不把 `vsched_*` 当丢失消息存；`restart-dropped` 不重发；`getThreadId` 对 `vsched_*` 不查飞书；`retrySessionTitleAfterTurn` 照常；`openTurn` 的 `TurnFacts.scheduled = { taskId, runId }`。
- **真人不插进定时轮**：`ActiveState.scheduled = true` 在定时轮跑着时置上，`deliverPreparedTurn` 看到就走 `queue`，不 steer；轮结束清掉。
- **编辑锁只看本群**：`ActiveState.chatId` 在 `launchRun`/`launchGoalRun` 设上；6589 和 9225 的 `active.size > 0` 改成 `[...active.values()].some(s => s.chatId === project.chatId)`（library 那处按 `mine` 的 chatId 集合）；碰上本群有运行时先 `holdFiring(project.chatId, 60_000)` 再抛"Agent 正在执行任务…"。
- **门** `scheduleGate(chatId)`：`turnRefusal` 的四种映射成 `unbound/disabled/updating/updating`；`tierInfo(...).unavailable` → `tier-unavailable`；`holds.get(chatId) > now` → `held`；都没有 → `'ok'`。
- **`tier-unavailable` 的一行文字**：调度器记 failed 后调注入的 `notifyGateFailure(task)`（总设计第 6 节的依赖；不并进 `gate`：`gate` 只收 `chatId`，文字要任务名、限频按任务），本片的实现发第 16 节那一行到主区（`channel.send`，不是卡，发不出去记日志）；每个任务每小时最多一条（免得每分钟刷）。

### 4.3 头部和标签

- `context-weave.ts` 加 `scheduledHeader(job, hostTimeZone, fallback)` 和 `scheduledOpening(job, task, previous?)`，文本按总设计 7.2 逐字；`nth`、`late`、`manual`、`fallback`、`creator`、`createdAt`、`original`、`previous` 的规则也在 7.2。时间用 `time.ts` 的 `formatHHMM`/`formatAt`。
- `run-card.ts` 的标题行加小字标签（总设计 7.3），进度卡和最终卡都带；`run-card-stream.ts` 创建时传入。空输出：卡片照原样留着，不加字。

### 4.4 在场

- `TurnFacts.scheduled`、`TurnAuth.presence` 和推导在 T1b（它的 4.4）。本片在定时回合 `openTurn` 时填 `facts.scheduled = { taskId, runId }`。
- 设置类工具只在私聊签发（`registry.ts:294`），定时回合在群里，不用改 `authorizeNow`，不加测试。
- 提问卡：定时回合发的提问卡 15 分钟没人答，超时分支照旧把"没人回答"交回 agent，不另做。

### 4.5 自动暂停和群消息

`notifyAutoPause(task)` 在本片注入实现：发一条文字消息（`post`，不是卡片）到主区，内容按总设计第 16 节；创建人有 `openId` 时放 at 节点，没有就纯文字。发送失败抛错让调度器置 `noticePending`，下个 tick 重试（调度器管重试和 24 小时上限）。

### 4.6 停机、崩溃、移出群和解绑

- 关闭顺序（`bridge.ts:113-141` 的 `shutdown`，调度器经 `orchestrator.scheduler` 拿）：`scheduler.stop()` 同步；`orchestratorClosing = orchestrator.shutdown()`（它 interrupt 所有运行、排空、settle 剩下的钩子）；`closing` 里 `await orchestratorClosing` 之后 `await scheduler.drain(5000)`。没有 60 秒排空；8 秒宽限是硬上限。
- 崩溃：T1a 的 `start(loaded)` 对 `loaded.interrupted`（`load()` 时带 `inflight` 的任务）记 `interrupted by crash`、计一次失败，本片在 `D/bot/diagnostics.ts` 加第六个事件名 `schedule-interrupted`（T1a 只加了另外五个），在这条崩溃路径上发。
- 三处解绑：`onBotRemovedFromChat`（8897）、`removeProject` 的桌面端路径（6586 起）、私聊控制台 `DM.rmDo`（5738），在 `forgetAttention(chatId, 'unbind')` 旁都调本片在 orchestrator 里加的 `markUnavailable(chatId)`：用 T1b 构造的 `store` 的 `mutateConfig`，这个群的 `active` 任务改 `paused`、`pausedReason: 'unavailable'`、`touch`（配置变化，换 revision）。不删；不经命令核（它只有 `execute`），也不加调度器方法；写失败记日志，不挡解绑。

## 5. 测试

main 必败：`runScheduled`、钩子、头部、标签、`presence`、`scheduleGate`、编辑锁按群在基线不存在；注入 `run` 的调度器在基线下抛 `runner-not-wired`。

- `scheduled-run-placement.test.ts`（假后端、假飞书，照 `handle-message` 现有测试的夹具），输入 → 期望：
  - 单会话群 `follow` → 卡片经 `message.create`（没有 `reply`），同一个 key `chatId`；智能群同，且 judge 的 spy 没被调。
  - 多会话群 `follow` → 先一条文字根消息（文案逐字第 16 节"话题根消息"），卡片 `reply` 到它、`reply_in_thread: true`，`getThreadId` 后 `active` 的 key 是 thread id，`noteOpenedTopic` 一次。
  - 话题群 `follow` → 同上；`newTopic` 在单会话群 → 同上。
  - `topic` → `desktopTopicReply` 的返回做 anchor，`reply_in_thread: true`；`desktopTopicReply` 抛 → 退回 `follow`，头部含"原话题找不到了"。
  - 主区正忙（真人轮在跑）→ 定时轮排进 `queue`，不 steer；轮到它时卡片 `message.create`，不 `reply` 到上一张卡。
  - 定时轮在跑、真人消息到 → 排队不 steer（steer 的 spy 没被调）。
  - `wovenSkip` 对 `vsched_*` 不吞；完成提醒的 spy 没被调；`runReaction` 没被调。
- `scheduled-run-hook.test.ts`：
  - 正常跑完 → `settle` 一次，`status: 'done'`，`excerpt` 是最终正文前 500 字，`messageId` 是卡片 id。
  - 排在真人后面、真人轮结束后定时轮跑完 → settle 的 excerpt 是定时轮的正文，不是真人的；真人轮后又排一个真人 → 定时轮 settle 在切到下一个 `currentTurn` 时发生。
  - 后端抛错 → `failed counts: true`；建卡前飞书 `ECONNREFUSED` → `failed counts: false`。
  - `shutdown()` 时在队列里 → `interrupted by shutdown`，`collectLost` 里没有 `vsched_*`；跑着 → `interrupted by shutdown`；用户按停止 → `interrupted by user`。
  - `refusedTurn` 竞争、`replyGoalBusy`、`early()` → `skipped updating`，没有发任何消息。
  - `settle` 调两次只算第一次；`shutdown()` 结束时 `scheduledHooks` 为空。
  - `shutdown()` 不等钩子的 promise：有一个永不 settle 的消费者时 `shutdown()` 仍在排空后返回。
- `scheduled-run-context.test.ts`：头部逐字（`late`、`manual`、`fallback` 三种变体，例如 `（定时任务「日报」· 每个工作日 09:00 · 第 3 次 · 原定 09:00，09:07 开始。现在没有人在场：…）`）；新会话开场包含角色设定、主区最近行、任务内容、`由 张三 在 2026-10-30 10:00 创建，原话："…"`、`上次结果（2026-10-29 09:00，完成）：…` 加链接；没有上次结果不写那一段；创建人没名字写"群成员"/"桌面端"/"终端"；excerpt 500 字截断。
- `scheduled-run-card.test.ts`：标签行在进度卡和最终卡；补跑带"原定 09:00"；手动带"手动运行"；空输出卡片保留、正文不变、`dropSilentCard` 返回 false。
- `scheduled-run-gate.test.ts`：`enabled: false` → `disabled`；`projectMutations` → `updating`；`resumePublications` → `updating`；没绑定 → `unbound`；`tierInfo.unavailable` → `tier-unavailable` 且 `notifyGateFailure` 发一行文字、一小时内第二次不发；`holdFiring` 后 60 秒内 → `held`，之后 `ok`。
- `scheduled-run-lock.test.ts`：群 A 有运行时 `editProject(B)` 成功、`editProject(A)` 抛"Agent 正在执行任务"且 `holdFiring(A)` 被调；`libraryWorkspaceCheck` 只看本项目的群。
- `scheduled-run-presence.test.ts`：经 `runScheduled` 起的那一轮，`openTurn` 收到 `facts.scheduled`、`presence` 是 `'scheduled'`；memory 工具照常。（推导本身的单测在 T1b。）
- `scheduled-run-release.test.ts`：Claude 后端的新话题运行 settle 后 `thread.close()` 被调、`sessions` 里没了；期间有人在话题里发了消息 → 不关。
- `scheduled-run-shutdown.test.ts`：`bridge.shutdown` 的顺序 `scheduler.stop` → `orchestrator.shutdown` → `scheduler.drain`（spy 调用顺序）；关闭后文件里 `inflight` 清掉、记录是 `interrupted by shutdown`；重启看到 `inflight` 记 `interrupted by crash` 不重跑；移出群、桌面端解绑、私聊控制台删项目 → 这个群的任务 `paused unavailable`，别的群不动，revision 变。
- `scheduled-auto-pause.test.ts`：10 次失败发一条文字、带 at 节点、文案逐字；创建人无 `openId` 不带；发送失败 → `noticePending`，下个 tick 重试成功后清掉。
- 回归定向：handle-message 相关（topic、queue、judge、reminder、dropped、goal）、run-card、context-weave、memory-authority、ask-coordinator、bridge 关闭。按实际文件名执行。

## 6. Codex 的自测

JP-VPS，用验收 daemon（`accept-home2`，Bot 6，已绑的测试群；环境和登记见 #422 正文第 4 节，群从 `test-chats.json` 的登记里取一个单会话群和一个多会话群，chat id 不打印）。

- 先拿目录锁：`mkdir /tmp/accept-user.d`，失败就等；拿到后 `echo "<任务号> $(date -u +%FT%TZ)" > /tmp/accept-user.d/owner`；用完 `rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 重命令加 `flock /tmp/vonvon-heavy.lock`。
- lark-cli：profile jojo、`--as user`，发消息照 `/home/operator/vonvon/claude-work/s25c-selftest/say.py` 的写法（第一个参数 chat id，第二个要 @ 的 bot 名）；读群里的消息用 `lark-cli im +messages-list --as user --chat-id <登记的 chatId> --page-size 20`（参数名以 `lark-cli im --help` 为准，不会的就记"没验到"），只看 Bot 6 发的卡和文字。终端命令都带 `--bot <Bot 6 的 app id 前 9 位> --group <登记的群名>`，前面写 `VONVON_HOME=/home/operator/vonvon/accept-home2`。
- 步骤：
  1. 验收 worktree 切到本分支，构建，重启验收 daemon。
  2. 单会话群：`vonvon schedule add --bot … --group … --name 报时 --every 1m "说一句现在几点"`，等两分半，`+messages-list`：两张卡，标签行 `⏰ 定时任务「报时」`，没有引用、没有话题，没有根消息文字。
  3. 多会话群：同样建一个 `--every 1m`，看每次一条文字根消息 `⏰ 定时任务「报时」· 第 N 次` 加一张卡开了新话题；第二次的卡里 agent 提到了"上次结果"（任务内容写"先复述上次结果再报时"）。
  4. 回话题：T3 之前没有在话题里建的入口；验收 daemon 停着时把一个任务的 placement 改成 `{ kind: 'topic', topicId: <第 3 步开出的话题 id> }`（直接改 `schedules.json`，改完再启），看它回到那个话题。
  5. 补跑：`schedule add --daily <2 分钟后的 HH:mm>`，`vonvon daemon stop`，等 5 分钟，再 start：一张卡，标签带"原定 HH:MM"，`schedule runs` 里只有一条 `catchUp`。
  6. 跳过：建一个 `--every 1m` 的任务，内容"等 3 分钟再回答"，`schedule runs` 看第二个 slot 记 `skipped`。
  7. 门：桌面端或 `vonvon settings` 把这个群停用，等两分钟，`runs` 里两条 `skipped`、群里没有新消息；启用回来。把群的后端换成一个装不上的，等 3 分钟：主区出现"这次没跑"那行文字一次（一小时一条），`runs` 里 `failed`；换回后端。
  8. 自动暂停：第 7 步的后端继续坏着等满 10 次（或在测试夹具里把阈值调低、真飞书只看消息格式）：主区一条文字 @ 创建人、任务变暂停；`schedule resume`，再跑一次正常。
  9. 停机：任务跑到一半 `vonvon daemon stop`，看 `schedule runs` 记 `interrupted`，重启不重跑；日志里 `scheduler.stop` 在 `orchestrator.shutdown` 之前、`drain` 在之后。
  10. 编辑锁：`--every 1m` 跑着时在网页端改这个群的设置：可能提示"Agent 正在执行任务"，一分钟内重试成功；改另一个群的设置一次就成。
  11. 真 Claude 和真 Codex 各一遍第 2、3 步（用哪家是群绑定时定的（`vonvon group bind --tool claude|codex`），不是 bot 的设置：从 `test-chats.json` 的登记和 `projects.json` 的当前绑定里挑 Bot 6 绑在 Claude 上的测试群和绑在 Codex 上的测试群，单会话和多会话各要一个（chat id 不打印）；缺哪种就按 #422 正文第 4 节新建测试群、用 `--tool` 绑好并补登记）；Claude 多会话群跑完后 `ps` 看没有多出常驻的 claude 进程。
  12. 自测完把验收 worktree 换回 `dev`，放锁。
- Mac 上的睡眠和唤醒（电脑合盖或 `pmset sleepnow`，醒来只补一次、卡片带"原定"）JP-VPS 测不了，PR 里记"待 owner 验收"，步骤是第 5 步换成睡眠。
- 贴到 GitHub 前打码：不贴群 id、消息 id、open_id。

## 7. 文档

- `docs/v1-plan.md`：T2 行的做法和实际行数。
- 3.13 已写进 product.md；本片实现和 3.13 对不上时在 PR 写明，由审查者在同一个 PR 改 product.md。

## 8. 验收要点

- 每条丢弃路径都 settle，有"排队里被停机""真人后面""goal 忙"三种测试；钩子的 promise 不在 `acceptedTasks`/`runTasks` 里。
- 落点全按 `target`：主区 `message.create` 不引用，话题 reply 到真实 anchor；没有任何发送用 `vsched_*` 当 `replyTo`。
- 开新话题先有文字根消息再有卡；`noteOpenedTopic` 记了。
- 放置表六行都有测试和真飞书证据；定时回合从不插话、真人也不插进定时轮。
- 头部文本和总设计 7.2 逐字一致；时间按任务时区。
- 门五种分类有测试；`tier-unavailable` 的一行文字限频；停用的群不出声。
- `failed` 覆盖后端失败、超时、建卡失败、卡片更新失败；断网不计失败；interrupted 不算失败；崩溃计一次。
- 10 次自动暂停发且只发一次，@ 创建人；无 openId 不 @；发不出去重试。
- 关闭顺序 stop → shutdown → drain，`drain` 有 5 秒上限；重启不重跑；合成消息不进丢失名单。
- 编辑锁只看本群，`holdFiring` 有效。
- Claude 隐藏会话跑完就关。
- 不碰 Mac 的环境；验收 daemon 用完换回 `dev`、放锁。diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：子进程、并发（排队、钩子、停机）、关闭清理顺序、错误路径。每条都有测试，并按 `AGENTS.md` 加一轮多角度审查。预计生产约 720 行（handle-message 480、context-weave 80、run-card 50、bridge、`markUnavailable`、`notifyGateFailure` 110）、测试约 680 行、文档约 50 行，总计约 1,450。超限先把自动暂停消息、编辑锁和移出群/解绑拆成 T2b。自审不代替独立审查；不冻结、不合入。
