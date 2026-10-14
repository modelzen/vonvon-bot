# e01：子 agent 和 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`

2026-10-14 在 JP-VPS 上实测，代码基于 `main` 的 `20d5fec`。对应 `docs/product.md` 第 9 节第 1 项，影响 3.9 和 s35。

## 结论

- 这个变量有效。经 Agent SDK 给会话设上 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 后，子 agent 都在前台跑，主回合的 result 等最慢的子 agent 结束才来，一条用户消息只有一个 result。同一条消息里的几个子 agent 仍然并行。
- 不设这个变量（今天的 vonvon）时，子 agent 默认在后台跑。主回合约 6 秒就出 result，每个后台任务结束后 CLI 自己再起一轮，又出一个 result。一条用户消息出了 4 到 6 个 result。
- 代价是后台 Bash 没了。模型带 `run_in_background` 调 Bash 会直接报参数错误，命令不执行；模型去掉参数重试后，命令在前台跑完，这一轮跟着等。
- 3.9 可以定下来：第一版在 bot 的 Claude 会话里打开这个变量，s35 不做"已回复，还有 N 个在跑"的备选。前提是 s35 开工时补测的 ⏹ 没问题：前台子 agent 跑着时按 ⏹ 还没测，这是这个做法最主要的风险（见"对第一版的影响"）。

## 怎么测

- Claude Agent SDK 0.3.296，自带的 CLI 是 2.1.296，模型 `claude-haiku-5-5`，用 JP-VPS 上已有的 Claude 登录。
- 调用方式照 vonvon 今天的写法：一条常驻的 streaming input `query()`（`D/agent/claude-agent/thread.ts`）；env 从 `process.env` 拷一份，再加 vonvon 的两个标记（`D/agent/claude-agent/backend.ts:68-74`）；完全访问档，也就是 `bypassPermissions`；关闭时和 vonvon 一样，先关输入，再 abort，再 close。
- 和 vonvon 不同的两处：`settingSources` 为空，vonvon 今天给的是 `['user', 'project']`（`D/agent/claude-agent/backend.ts:48`）；每次都挂了一个只记录、一律放行的 canUseTool，vonvon 今天没有。
- 一条消息让模型在同一条回复里发三个调用：两个 Agent 子 agent，分别等 25 秒和 35 秒后回话；一个后台 Bash，等 45 秒后写一个文件。然后马上回复。
- 带和不带变量各跑一次。另有几种变体：显式传 `run_in_background: true`；关闭时还有后台任务在跑；用 `default` 模式让 canUseTool 真的被调用。共 8 次。
- 每条 SDK 消息记下到达时间，另起探针看进程树。不设变量时，CLI 会拦"前台 `sleep N && …`"（见下文），所以不设变量的几次让子 agent 用 `python3 -c 'time.sleep(…)'` 等待。

## 不设变量时

- Agent 工具默认在后台跑，工具说明里写着"Agents run in the background by default"。tool_result 立刻回来，文字是 `Async agent launched successfully`，`tool_use_result.status` 为 `async_launched`，带子 agent 的 id。
- 第一个 result 在约 6 秒时到。这时两个子 agent 和后台 Bash 都还在跑。
- 每个后台任务结束时，依次来三条系统消息：
  - `task_updated`：status 变成 completed；
  - `task_notification`：`tool_use_id` 指回原来的 Agent 或 Bash 调用，`summary` 是子 agent 的最后一段话，或者"Background command … completed"，子 agent 的还带用量；
  - `background_tasks_changed`：还剩下的后台任务全集，空数组表示一个都不剩。
- 然后 CLI 自己起一轮，没有用户消息：重发 `system/init`，模型回一段话，再来一个 result。这个 result 的 `origin` 是 `{kind: 'task-notification', ...}`，`result_index` 依次加一。
- 子 agent 报了 completed 也不一定是最后一次。有一次子 agent 自己把命令放到后台、先结束了，命令跑完后它又被唤醒：同一个 task_id，新的 run_id，再报一次 completed，主线程又多一轮。
- `default` 模式下，后台子 agent 的工具调用在主回合 result 之后还会走到 canUseTool，参数里带着子 agent 的 id。也就是说，运行卡已经收尾了，还可能来提问或要拒绝的请求。
- 推断，读代码得出，没有在 vonvon 上跑：`thread.ts` 每到一个 result 就清掉当前回合的 sink，sink 为空时 pump 直接丢消息。所以 CLI 自己起的那几轮，要么整轮丢掉，要么在用户下一轮进行时混进去，让那一轮的运行卡提前结束。

## 设了变量时

- 两个子 agent 都在前台跑（`task_started` 的 `is_backgrounded` 为 false），彼此并行，tool_result 是普通的结果。只有一个 result，约在第 45 秒，也就是最慢的子 agent 结束之后。没有 CLI 自己起的轮次，也没有 `background_tasks_changed`。
- 子 agent 的进度消息照样有：`task_started`、`task_progress`、`task_updated`、`task_notification`，`tool_use_id` 指回 Agent 调用；子 agent 自己的消息带 `parent_tool_use_id`。长的 Agent 或 Bash 调用每 30 秒有一条 `tool_progress` 心跳。3.9 的子 agent 区靠这些就够了。
- `run_in_background` 参数从 Agent 和 Bash 的工具定义里去掉了。CLI 代码里按这个变量把参数 omit 掉；工具列表本身不变，带不带变量都是同样 31 个名字。
- 模型硬要带这个参数时：Agent 忽略它，照样在前台跑；Bash 报 `InputValidationError: Bash failed due to the following issue: An unexpected parameter run_in_background was provided`，命令不执行。让模型去掉参数重试，命令在前台跑满 45 秒，这一轮跟着等。
- 不设变量时，CLI 拦住前台的 `sleep 25 && echo …`，提示改用后台或 Monitor；设了变量就不拦了。
- SDK 的 `query.backgroundTasks()` 这时报"Background tasks are disabled in this session."，不设变量时返回 false。可以用它确认变量生效了。

## 关闭会话时

- 不设变量、还有后台任务时按 vonvon 的顺序关闭，约 2 秒后消息迭代结束，10 秒内 CLI 和它起的 bash、sleep、python 都没了。后台任务要写的文件到最后也没出现。SDK 没有发任何"任务被停掉"的消息。
- 设了变量时，result 之后不剩任务，没有东西要杀。

## 对第一版的影响

- 3.9 按"打开变量"做，s35 不做备选。s35 开工时先补测 ⏹；前台子 agent 停不下来的话，回头再定。
- 运行卡在这一轮唯一的 result 到达时收尾。子 agent 区用 task_* 消息和 `parent_tool_use_id`。
- bot 不能在后台起开发服务器再结束这一轮，3.9 已经写了这个代价。模型带后台参数调 Bash 时会先失败一次，多一次工具调用。
- 还没测的，s35 开工时补：
  - 子 agent 在前台跑时按 ⏹ 多久能停下。vonvon 的注释说阻塞的工具在跑时 `interrupt()` 可能卡住，现在整个子 agent 都算一个阻塞的工具；
  - 设了变量后 Monitor 工具还能不能用；
  - 关闭的三步里，是哪一步杀掉了子进程。

## 顺带看到的

- streaming input 模式下，每一轮开头都会重发一次 `system/init`，不只是会话开始的时候。
- SDK 里的 CLI 会挂上账号在 claude.ai 的连接器，和 `settingSources` 无关，见 e02 第 7 节。

## 核实记录

另一个代理（Sonnet）读了脚本和原始日志，逐条核对，没有重跑。

| 结论 | 判定 | 说明 |
|---|---|---|
| 不设变量时，result 先于子 agent 结束到达；CLI 自己起后续轮次 | 核实 | 显式和不显式后台的两次各有 4 个 result，第一个在约 6 秒，探针显示 sleep 都还活着；task_notification、`background_tasks_changed` 的空数组和后面的 result 都在日志里 |
| 设了变量时，result 等两个子 agent 都结束 | 核实 | 只有一个 result，两个子 agent 都是 `is_backgrounded: false`，Bash 的后台参数报参数错误 |
| `run_in_background` 被从工具定义里去掉 | 部分核实 | 依据是压缩过的 CLI 代码和间接表现：带变量时模型把它写成字符串"true"，Bash 报多余参数。没有导出实际发给 API 的工具定义。"Agent 忽略这个参数"是从它在前台跑推出来的 |
| 设变量时后台 Bash 被拒；不设时它比这一轮活得久；关闭会话时被杀 | 核实 | 两次带变量的运行里文件都没出现；去掉参数重试的那次在前台等了约 45 秒；不设变量时 result 之后 sleep 还在；关闭后 10 秒、60 秒、110 秒都没有残留进程，文件没出现。只测了 vonvon 的那一种关闭顺序，报告自己说了 |
| 其他影响：sleep 拦截、result 之后的 canUseTool、vonvon 会错把后续轮次算进别的回合 | 部分核实 | sleep 拦截、心跳、每轮的 init、子 agent 的进度消息有日志支持。vonvon 的错路由是读代码的推断，报告标了。result 之后的 canUseTool 只看了日志摘录 |

缺口：

- 工具参数是模型生成的，工具定义没有导出，"参数被去掉"是推断。
- 不设变量的几次用 python 等待，和真实用户的任务不一样；设了变量后 sleep 拦截也关了，两组之间不完全是"只差一个变量"。
- 只测了一种关闭顺序，没分开是哪一步杀的子进程。
- 没测前台子 agent 跑着时的 `interrupt()`，也就是 ⏹。这是这个做法最主要的风险。
- 没用 vonvon 真实的 `thread.ts` 跑；每种情况只跑了一次，时间受模型影响；没测 Monitor。
- 实验去掉了父会话自己的 `CLAUDE*` 环境变量，真实的 daemon 没有这些变量，但和 vonvon 拼出来的 env 不一定完全一样。
