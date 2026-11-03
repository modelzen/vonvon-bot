# cli-4-sessions 计划：会话管理和用量（C4）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 8.2 节 C4 一行和第 13 节 C4 一行；约定照 `docs/plans/cli-1-conventions.md`（C1）；共用改动和落点照 `docs/plans/cli-2-bot.md` 4.6（C2 4.6），`runningBot()` 和 `METHODS` 照 `docs/plans/cli-3-groups.md` 4.6（C3 4.6）。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2。

## 1. 做什么

用户看得到的变化：网页群设置里"会话管理"那一块（当前会话的上下文用量、压缩、清空、停止任务、结束目标、停子 agent、完成时提醒、历史会话和"接上"）和"用量"页（套餐额度、分享到群、决策模型用量）都能在终端里做：`vonvon session …`、`vonvon usage show|share|judge`。依赖：C1（已合入）；C3 的 `runningBot()`（没合入就照抄 C3 4.6）。

## 2. 范围

做：9 条 `session` 命令、3 条 `usage` 命令（4.1 表），从白名单挪掉 12 个 kind：`collaboration.history / context / clear / compact / resume / stop / stopSubagent / endGoal / reminder / usage / shareUsage`、`admin.judgeUsage`。

不做：开始自主目标（`collaboration.startGoal`，目标在群里发起，白名单里是 unused，不动）；打开飞书群（`collaboration.openGroup`，D1 删）；会话里的权限（D4a/D4b，5.2：`history / context` 读类限自己，其余写类 ✗）。

## 3. 现在的代码

- 命令行没有会话和用量命令。
- `P/collaboration.ts`：`history / context / clear / compact` 带 `target{agentId, projectName, groupId}`，后三个再带 `threadId`；`resume{sessionId, backend}`；`stop / endGoal{runId}`、`stopSubagent{runId, subagentId}`、`reminder{runId, requested}`；`usage{force}` 不带 target；`shareUsage{sections?}`（`stats / heatmap / insights / limits / plan`）。回复：`history{sessions, threads, backend, threadsError?}`、`context{threadId, usage{used, window}|null, run{id, goal, canStop, canEndGoal, canRemind, reminderRequested, subagents?}|null}`、`usage{data}`、`applied{threadId?, messageId?, message?}`、`refused`。
- `D/server/rpc/collaboration.ts:71`：除 `providerModels`、`usage` 外，先 `requireRunningAgent()`，Bot 没在运行回 `RpcError('conflict', 'Bot 没启用或没在运行')`——在命令行会成 exit 5"冲突"，读起来不对，所以本片先查（`runningBot()`，exit 4 `bot_not_running`）。
- `U/management/ConversationPanel.tsx` 是网页的做法：当前会话 = 历史里 `threadId` 对上且没 `detached` 的那条；多会话群（`threads`）不给清空（"清空仅适用于主区会话"）；停止、结束目标、提醒都先读 `context` 拿 `run.id`，按 `canStop / canEndGoal / canRemind` 决定按钮能不能点；"可恢复"列表去掉已经绑着的 `sessionId`。
- `P/admin.ts`：`judgeUsage` 回 `{days[{date, total, sources[{kind, id, label, count}], bots[{agentId, agentName, count}]}], unreadBots, botsUnreadable?}`。

## 4. 怎么改

### 4.1 命令

`--group <group>` 是群 id 或群名（`pickGroup()`），`--bot` 同 C1；`--session <threadId>` 见 4.2 第 1 条。

| 命令 | RPC | `covers` | `--json` 成功 |
|---|---|---|---|
| `session list --group <g> [--resumable]` | `collaboration.history` | `collaboration.history` | `{ok, backend, sessions:[…], threads:[…], threadsError?}` |
| `session context --group <g> [--session <t>]` | `history`（找会话）、`collaboration.context` | `collaboration.context` | `{ok, threadId, usage, run}` |
| `session clear --group <g> [--session <t>]` | `history`、`collaboration.clear` | `collaboration.clear` | `{ok, threadId, message?}` |
| `session compact --group <g> [--session <t>]` | `history`、`collaboration.compact` | `collaboration.compact` | `{ok, threadId, message?}` |
| `session resume <sessionId> --group <g>` | `history`（拿 `backend`）、`collaboration.resume` | `collaboration.resume` | `{ok, threadId?, message?}` |
| `session stop --group <g> [--session <t>]` | `context`（拿 `run`）、`collaboration.stop` | `collaboration.stop` | `{ok, stopped:true\|false, runId?}` |
| `session end-goal --group <g> [--session <t>]` | `context`、`collaboration.endGoal` | `collaboration.endGoal` | `{ok, ended:true\|false, runId?}` |
| `session stop-subagent <subagentId> --group <g> [--session <t>]` | `context`、`collaboration.stopSubagent` | `collaboration.stopSubagent` | `{ok, runId, subagentId}` |
| `session reminder (--on\|--off) --group <g> [--session <t>]` | `context`、`collaboration.reminder` | `collaboration.reminder` | `{ok, runId, requested}` |
| `usage show [--refresh]` | `collaboration.usage{force}` | `collaboration.usage` | `{ok, data}` |
| `usage share --group <g> [--sections a,b,…]` | `collaboration.shareUsage` | `collaboration.shareUsage` | `{ok, messageId?}` |
| `usage judge` | `admin.judgeUsage` | `admin.judgeUsage` | `{ok, days, unreadBots, botsUnreadable?}` |

失败：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错；`--session` 不在这个群；没写 `--session` 而群里有多条会话；`--on`/`--off` 都没给或都给；`--sections` 有不认识的 | 2 | — |
| 群里没有会话（没写 `--session` 时） | 2 | `no_session` |
| 连不上 | 3 | — |
| Bot 没在运行 | 4 | `bot_not_running` |
| 多会话群 `session clear` | 4 | `not_for_threads` |
| 有在跑的任务但 `canStop` / `canEndGoal` / `canRemind` 为假；子 agent 不存在或不能停 | 4 | `cannot_stop` / `cannot_end_goal` / `cannot_remind` / `cannot_stop_subagent` |
| daemon 回 `refused` | 4 | daemon 的 `code` |
| 写请求超时、断线 | 6 | — |

### 4.2 各命令的细节

1. **找会话**（`context / clear / compact / stop / end-goal / stop-subagent / reminder` 共用 `sessionOf()`）：先 `history`，在 `sessions` 里取 `chatId` 是这个群、`detached` 不为真的。给了 `--session`：不在里面 → 2"这个群没有会话 <t>。vonvon session list --group <g> 列出全部。"；没给：一条就用它，零条 → 2 `no_session`"这个群还没有会话。"，多条 → 2，文字列出每条的 `threadId` 和摘要。和网页"当前会话"同一个判法。
2. **`session list`**：人类输出两段。"群里的会话"：每行 `threadId  摘要  Codex  更新于 HH:mm`，分离的标"（已分离）"；`--resumable` 时再列"可以接上的会话"：`history.threads` 去掉已经绑着（没分离）的 `sessionId`，每行 `sessionId  名字或预览  更新于 …`，最后一行"接上：vonvon session resume <sessionId> --group <g>"。`threadsError` 有值时打一行"读不到可以接上的会话：…"。JSON 总是两段都给（AI 自己筛）。
3. **`session context`**：`上下文 12,345 / 200,000（6%）` 或 `窗口未知`、`暂无可用统计`（`usage:null`）；`run` 有值时再打"正在运行：当前任务 / 自主目标"、子 agent 每行一个（`id  名字  状态`）、"完成时提醒：已开启 / 未开启"，以及能用的下一步命令（`canStop` → `vonvon session stop …`）。
4. **`session clear`**：成员的会话方式是 `threads` → exit 4 `not_for_threads`，文字照网页"多会话支持压缩上下文；清空仅适用于主区会话。"，不发请求。发 `clear`，`unknown: '可能已经清空，运行 vonvon session context --group <g> 看。'`。人类输出"已开始新会话。"（网页原文）。
5. **`session compact`**：`{ feishu: true, unknown: '可能已经在压缩，运行 vonvon session context --group <g> 看。' }`（压缩要等模型，按 75 秒档）。人类输出"上下文已压缩。"。
6. **`session resume`**：`backend` 用 `history.backend`（网页同样传它）；`sessionId` 不在 `history.threads` 里 → 2；已经绑着 → 2"这条会话已经接在群里了"。
7. **`session stop` / `end-goal`**：读 `context`；`run:null` → 退出 0，`stopped:false`（`ended:false`），人类输出"现在没有在跑的任务。"——停一个没在跑的东西，结果和用户要的一致，不算失败；`canStop`（`canEndGoal`）为假 → 4。发请求，人类输出"已请求停止任务。"/"已结束目标。"（网页原文）。读和写之间任务结束了，daemon 回什么照转。
8. **`session stop-subagent`**：在 `run.subagents` 里找 `id`；找不到或 `status` 不是 `running` 或 `stoppable` 为假 → 4 `cannot_stop_subagent`。
9. **`session reminder`**：`run:null` → 4 `cannot_remind`，文字"现在没有在跑的任务，完成时提醒只对在跑的任务有用。"（和 stop 不同：用户要的是"开提醒"，没开成）。已经是目标状态也照样发（daemon 幂等）。
10. **`usage show`**：不要 `--group`、不要 Bot 在运行。人类输出：套餐（`planType`）、主额度每个窗口一行（`5 小时窗口 已用 42% · 14:30 重置`）、`extras` 每个一行、累计 token、连续天数；`--refresh` 发 `force:true`（网页的刷新按钮）。
11. **`usage share`**：往群里发一张用量卡片（网页"分享到群"）。`--sections` 逗号分隔，按 `usageShareSectionSchema` 校验，不写就是 daemon 的默认。`{ feishu: true, unknown: '卡片可能已经发出，去群里看一眼。' }`。
12. **`usage judge`**：每天一行 `2026-10-31  共 128 次`，下面缩进列来源和各 Bot；`unreadBots > 0` 时最后打"有 N 个 Bot 的记录读不了"。

### 4.3 交互和非交互

全部不读 stdin、不提问。`clear` 网页也没有确认框，命令行同样不要 `--yes`（会话历史还在 provider 那边，能 `resume` 接回来）。

### 4.4 权限表（5.2）

不加新 kind。5.2 `collaboration.*` 一行：读类（`history / context`）限自己（群令牌只本群），别的写类 ✗；`admin.judgeUsage` 在 `admin.*` 一行，✗。`collaboration.usage`、`shareUsage` 也是 `collaboration.*` 的写类以外——`usage` 是读但不在"读类"那三个里：**提请 D4a 在表里补明 `collaboration.usage` 的 bot-session 一格**，建议 ✗（套餐额度是主人账号的信息，和 `admin.*` 同理），`shareUsage` ✗（往群里发东西）。哪一方后合入，哪一方把这两格写进 `D/server/authz.ts`。

### 4.5 文件

新 `D/cli/commands/session.ts`（`sessionOf()`、9 个 `run…`）、`D/cli/commands/usage.ts`；`D/cli/index.ts` 的 `session`、`usage` 两组放在 `schedule` 组之后、`feishu` 组之前（C2 4.6 的落点表）。`target` 由 `runningBot()` + `pickGroup()` 拼：`{agentId, projectName: membership.name, groupId: membership.groupId}`。

### 4.6 和总设计不一样的地方

- **`session stop / end-goal` 没在跑时退出 0**（`stopped:false`），`reminder` 没在跑时退出 4：理由见 4.2 第 7、9 条。
- **`session list --resumable`**：8.2 没写；"可恢复"是网页历史会话的筛选项，`resume` 要的 `sessionId` 只在这一段里，人类输出默认不列免得太长。
- **`usage` 不挂在 `session` 下**：用量是账号的，不属于哪个群；8.2 本来就写 `usage show/share`。

## 5. 测试

新文件 `T/cli-session.test.ts`、`T/cli-usage.test.ts`（假客户端，快照里一个运行中的 Bot、一个 `shared` 群、一个 `threads` 群）：
- `session list --group 研发 --json`：发 `history{agentId, projectName:'研发', groupId}`，输出两段；`--resumable` 人类输出去掉已绑的 `sessionId`（main 必败）。
- 找会话：一条 → 用它；两条不给 `--session` → bad-args、文字含两个 `threadId`；零条 → bad-args `no_session`；`--session` 不在 → bad-args（main 必败）。
- Bot `running:false` → refused `bot_not_running`，一个请求都没发（main 必败）。
- `session clear --group 多会话群` → refused `not_for_threads`，没发 `clear`；`shared` 群发 `clear{threadId}`（main 必败）。
- `session stop`：`context.run:null` → 退出 0、`{"ok":true,"stopped":false}`、没发 `stop`；`run{canStop:false}` → refused `cannot_stop`；`run{id:'r1', canStop:true}` → 发 `stop{runId:'r1'}`（main 必败）。
- `session reminder --on`：`run:null` → refused `cannot_remind`；有 run → `reminder{requested:true}`；`--on --off` → bad-args（main 必败）。
- `session stop-subagent s9`：子 agent `status:'completed'` → refused；`running + stoppable` → 发 `stopSubagent{runId, subagentId:'s9'}`（main 必败）。
- `session compact` 超时（注入 `timeouts.feishu = 10`）→ outcome-unknown，文字带"session context"（main 必败）。
- `session resume th_1 --group 研发`：`backend` 取自 `history.backend`；`th_1` 不在 `threads` → bad-args（main 必败）。
- `usage show --refresh`：发 `usage{force:true}`，Bot 没在运行也照发（main 必败）。
- `usage share --group 研发 --sections stats,plan`：发 `shareUsage{sections:['stats','plan']}`；`--sections foo` → bad-args（main 必败）。
- `usage judge --json`：`{"ok":true,"days":[…],"unreadBots":0}`（main 必败）。
- `T/cli-json.test.ts` 加 12 行样本；`T/cli-parity.test.ts`：12 个 kind 不在白名单。

## 6. 自测和验收

**Linux（JP-VPS）**：daemon 的 typecheck、lint、build；上面两个测试文件和 `T/cli-admin.test.ts`、`T/daemon-cli.test.ts`。

**集成分支验收时，主会话在验收 daemon 上做**（拿目录锁、核对 sha、用完放锁；Bot 6 的测试群）：
1. 用 lark-cli 以 owner 身份在测试群 @Bot 6 让它跑一个要几十秒的任务；跑的时候 `vonvon session context --group <测试群>` 显示"正在运行"，`vonvon session stop --group <测试群>` 后群里显示已停止（devices.md C4 验收一行）。
2. `vonvon session compact --group <测试群>` 和网页"压缩上下文"效果一样（群里有压缩提示）。
3. `vonvon usage show`、`vonvon usage judge` 和网页"用量"页的数字一致。
4. `vonvon usage share --group <测试群>`：测试群里出现用量卡片（只发到测试群）。
5. `session clear` 只在 `shared` 的测试群做一次，做完 `session list --resumable` 能看到原会话、`session resume` 能接回来。

**Mac、Windows**：不需要。

## 7. 文档

- `docs/product.md`：本片不改（D0 统一写）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 12 条命令都有 `--json`；失败的 `exitCode`、`reason` 照 4.1。
2. 没写 `--session` 时的选法和网页"当前会话"一致；多条时 exit 2 并列出来，不猜。
3. Bot 没在运行时是 exit 4 `bot_not_running`，不是 5"冲突"。
4. 停止类命令先读 `context` 拿 `runId`，按 `can…` 判；多会话群不能清空。
5. 白名单里没有本片的 12 个 kind；4.4 提的两格写进 PR 描述，提醒 D4a。
6. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 900 行：`session.ts` +320，`usage.ts` +130，`index.ts` +70，白名单 −12，测试约 390。
- 停止和清空是真操作：验收只在测试群、只对自己刚起的任务做。
- `history` 在 provider 那边读可恢复会话，可能慢：用 `feishu` 档（75 秒）超时，读类超时 exit 3 不是 6（C1 的规矩：读没有"可能已经做了"）。

## 和计划不一样的地方

- **时间打成 `YYYY-MM-DD HH:mm`**（`localTime()`，4.2 写 `HH:mm`）：历史会话和 7 天限额的重置时间常常不在今天。
- **分离的会话标"（已归档）"**（4.2 写"已分离"）：网页历史会话、daemon 的报错都叫"已归档"，三处一致（8.1）。
- **`usage show` 的窗口名照网页 `usageWindowLabel`**："5 小时限额：已用 42% · 2026-11-01 14:30 重置"；第一行多了账号名（网页同），最后一行"读取于 …"。
- **`clear`、`resume` 也用 `feishu` 档（75 秒）**：两者都要起或接 provider 会话、往群里发回执；`resume` 的 `unknown` 是"可能已经接上，运行 vonvon session list … 看。"。`usage show` 读账号也走网络，同样 `feishu` 档，读类超时 exit 3；daemon 回 `usage_unavailable`（没登录等）照 C1 是 exit 1，`reason` 带码。
- **写类回复的 `warning` 也给**：`clear / compact / resume` 的 JSON 带 `warning?`，人类输出多一行"飞书回执未确认：…"（网页同样显示）。
- **`resume` 读不到可恢复列表（`threadsError`）而 id 不在里面时 exit 1**，文字是读不到的原因，不说"没有这条会话"。
- **提示里的命令带上要的参数**：`--group` 用群 id；有几个 Bot 时带 `--bot <id>`；用户给了 `--session` 时带 `--session`。`session context` 第一行是会话 id 和摘要，没在跑时打"现在没有在跑的任务。"。
- **"12 个 kind 被 `covers`、不在白名单"放在 `T/cli-session.test.ts`、`T/cli-usage.test.ts`**，同 C2 的做法，不改 `T/cli-parity.test.ts`。
- **`usage judge` 只列今天和有判断的日子**（网页同）；全是 0 时打"最近 14 天没有判断。只有智能群会判断。"，`botsUnreadable` 另打一行。
- **`runningBot()` 放在 `pickBot()` 紧后面**，`METHODS` 照 C3 4.6 原文。
