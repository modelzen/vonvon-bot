# e02：Claude 的权限回调、提问、改档、子 agent 的 id、读别的会话、个人指令

2026-10-14 在 JP-VPS 上实测，代码基于 `main` 的 `20d5fec`。对应 `docs/product.md` 第 9 节第 11、12 项里不要沙箱的部分、第 18 项的 Claude 一半，再加上 `claudeMdExcludes`（`docs/v1-plan.md` 的 e02）。影响 3.5、3.6、3.8，以及 s31、s44、s48。沙箱的部分在 Mac 上测（e03）。

## 结论

1. 今天 Claude 的会话里根本没有 AskUserQuestion。只读、读写两档照今天的配置跑，会话的工具列表里都没有 AskUserQuestion、EnterPlanMode、ExitPlanMode，模型只能用文字问；挂上 canUseTool 后三个工具都在。原因推断是 SDK 只在有 canUseTool 时才给 CLI 留提问的通道（`sdk.mjs` 的参数逻辑）；完全访问档今天也没有 canUseTool，推断一样。product.md 3.8 写的"会被拒"不准确。
2. 今天的只读档除了拿掉写文件和上网的工具，还给了沙箱设置（`D/agent/claude-agent/permission.ts:59-65`）。这次没带沙箱：只拿掉工具时，Bash 照样能写工作区内外的文件，也能 curl 出去。沙箱能不能补上，看 e03。
3. 换成 `default` 加 canUseTool 后，写文件的 Bash、联网的 Bash、工作区以外的读写、WebFetch、WebSearch 和提问都会走到回调，vonvon 可以逐个拒绝。`ls`、`find`、`grep` 和工作区里的 Read 不走回调。
4. `acceptEdits` 下，工作区里的写不走回调，Bash 的重定向写也算在内；其余和 `default` 一样。
5. `bypassPermissions` 加 canUseTool 时，只有 AskUserQuestion 走到回调，其余一律放行。
6. 会话运行中 `setPermissionMode` 能升档也能降档，下一轮生效，不用重开会话。升到 `bypassPermissions` 要求会话启动时带了 `allowDangerouslySkipPermissions: true`。resume 不恢复上次的档，以启动时传的为准。
7. 回调拒绝时，模型拿到的就是 vonvon 写的原因，这一轮接着做。带 `interrupt: true` 时，原因被换成通用文字，这一轮以 `error_during_execution` 结束。
8. 子 agent 有一个固定的 id，task_* 消息、子 agent 的消息、hook 和 canUseTool 里都是同一个值。消息上的 `agent_id` 字段 0.3.291 以后才有，s02 锁定的 0.3.296 有。
9. `getSessionMessages` 能读别的工作目录下的会话：`dir` 不传（扫所有项目，约 120 毫秒），或者传那条会话原来的 cwd（约 5 毫秒）。读出来的包含工具步骤，没有"只要用户消息和最终回答"的选项，要自己过滤。子 agent 的消息不在里面。
10. `claudeMdExcludes` 能排除 `~/.claude/CLAUDE.md`，它 @ 引入的文件也一起排除。它是设置项，经 `options.settings` 传。只给 `settingSources: ['project']` 也不会加载个人的 CLAUDE.md。
11. 新发现：bot 的 Claude 会话的工具列表里有主人账号在 claude.ai 的连接器，还有推送通知、远程触发、定时任务、工作流这些 Claude Code 自己的工具，和 `settingSources` 无关。今天的 vonvon 没有关掉它们。这些工具这次没有实际调用过。见第 7 节。
12. 新发现：没人改过名时，`getSessionInfo().customTitle` 返回的是 CLI 自动起的标题。vonvon 的标题协调器会因此以为会话已经有名字，不再写 vonvon 的标题。见第 8 节。

## 怎么测

- 和 e01 一样：SDK 0.3.296，自带 CLI 2.1.296，模型 `claude-haiku-5-5`，JP-VPS 上已有的 Claude 登录，照 vonvon 的写法起常驻的 streaming input `query()`，env 从 `process.env` 拷一份再加 vonvon 的两个标记。
- 不带沙箱。`settingSources` 为空，第 6 节除外。vonvon 今天给会话的是 `['user', 'project']`（`D/agent/claude-agent/backend.ts:48`）。
- 权限部分：一条消息让模型依次做 17 步：工作区内外的 Read、Write、Edit；Bash 的 `ls`、工作区内外的重定向写、`curl`；WebFetch；WebSearch；AskUserQuestion；起一个子 agent 做 Read 和 Write；写 `.claude/` 下的一个文件。canUseTool 记下每次调用的全部参数。每种模式一次，另有拒绝、改档、resume 几次专项，共 11 次。
- 子 agent、读会话、个人指令共 14 次；连接器和工具白名单 3 次。

## 1. 哪些请求走到回调

| 操作 | `default` | `acceptEdits` | `bypassPermissions` | 今天的只读档去掉沙箱 |
|---|---|---|---|---|
| 工作区里的 Read | 直接放行 | 直接放行 | 直接放行 | 直接放行 |
| 工作区外的 Read | 回调 | 回调 | 直接放行 | 直接放行 |
| Bash 的 `ls`、`find`、`grep` | 直接放行 | 直接放行 | 直接放行 | 直接放行 |
| 工作区里的 Write、Edit | 回调 | 直接放行 | 直接放行 | 没有这两个工具 |
| 工作区外的 Write | 回调 | 回调 | 直接放行 | 没有这个工具 |
| Bash 重定向写到工作区里 | 回调 | 直接放行 | 直接放行 | 写成了 |
| Bash 重定向写到工作区外 | 回调 | 回调 | 直接放行 | 写成了 |
| Bash 的 `curl` | 回调 | 回调 | 直接放行 | 连上了 |
| WebFetch、WebSearch | 回调 | 回调 | 直接放行 | 没有这两个工具 |
| AskUserQuestion | 回调 | 回调 | 回调 | 没有这个工具 |
| 写 `.claude/` 下的文件 | 回调 | 回调 | 直接放行 | 没有 Write |
| 子 agent 的 Write | 回调，带子 agent 的 id | 直接放行 | 直接放行 | 没有这个工具 |

最后一列指 `bypassPermissions` 加 `allowDangerouslySkipPermissions`，关网时 `disallowedTools` 是 Write、Edit、NotebookEdit、WebFetch、WebSearch，没有 canUseTool（`D/agent/claude-agent/permission.ts:67-76`）。今天的配置还带沙箱设置（`:59-65`），这次没带，所以这一列不是今天的完整行为，带沙箱的结果看 e03。读写档关网时只去掉 WebFetch 和 WebSearch，提问也一样没有。

- 回调的参数里有 `suggestions`、`blockedPath`、`decisionReason`、`toolUseID`、`agentID`、`requestId`、`description` 等。`decisionReasonType`（`workingDir`、`safetyCheck`、`subcommandResults`）和 `requiresUserInteraction`（只在 AskUserQuestion 上为 true）运行时有，sdk.d.ts 的类型里没有。`title` 一直是空的。
- 回答 AskUserQuestion：回调返回 allow，`updatedInput` 里加 `answers`，键是问题原文，值是选中的选项。模型收到"Your questions have been answered: …"。
- 这一版 CLI 的 SDK 会话里没有 Glob、Grep、TodoWrite 工具，调用时报"No such tool available … find files with `find` via the Bash tool instead"。找文件靠 Bash 的 `find`、`grep`，在 `default` 下不走回调。
- WebFetch、WebSearch 是延迟加载的工具，模型先调 ToolSearch 再调它们。ToolSearch 不走回调。

## 2. 拒绝

- 回调返回 deny 并带一段说明时，模型收到的 tool_result 就是这段说明，原样，没有前缀，这一轮接着做。被拒的调用列在 result 的 `permission_denials` 里。不会发 `system/permission_denied` 消息；那条消息只在没有回调、CLI 自己拒绝时才发。
- 加上 `interrupt: true` 时，模型看到的是通用的"The user doesn't want to proceed with this tool use… STOP what you are doing…"，vonvon 写的原因丢了。接着来一条"[Request interrupted by user]"，这一轮以 `error_during_execution` 结束。query 还活着，下一轮能照常用。
- 推断：vonvon 的 `thread.ts` 把不是 success 的 result 当成失败，除非是用户按了 ⏹。s31 拒绝时不要用 `interrupt`。

## 3. 中途改档和 resume

- 以 `default` 加 canUseTool 启动。`setPermissionMode('acceptEdits')` 成功，马上来一条 `system/status`，下一轮的 `system/init` 写着 acceptEdits，工作区里的 Write 不再走回调。
- 启动时没带 `allowDangerouslySkipPermissions` 的会话，`setPermissionMode('bypassPermissions')` 报错："Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"，档不变。
- 启动时带上它、起始档是 `default` 的会话，回调照常工作；之后升到 `bypassPermissions`、降回 `default`、再换到 `acceptEdits` 都成功，每次都是下一轮生效。
- resume：上次停在 acceptEdits，resume 时传 `default` 或者不传，新会话的 init 都是 default。档不从记录里恢复，vonvon 每次 resume 都要明确传档。
- streaming input 下每一轮开头的 `system/init` 带着当前的档，可以用来确认改档生效了。

## 4. 子 agent 的 id

- 子 agent 有一个 17 位十六进制的 id。同一个值出现在：task_* 消息的 `task_id`；子 agent 的 assistant、user 消息的 `agent_id`；hook 输入的 `agent_id`；canUseTool 的 `agentID`；Agent 调用结果里的 `agentId`；`listSubagents()`；记录文件名 `subagents/agent-<id>.jsonl`。
- 子 agent 的消息带 `parent_tool_use_id`，指向父 agent 的那次 Agent 调用，还带 `agent_id`。`session_id` 是主会话的，子 agent 没有自己的会话 id。主线程的消息 `parent_tool_use_id` 为 null，没有 `agent_id`。
- `task_started` 带 `tool_use_id`，把子 agent 的 id 和父调用连起来。hook、canUseTool、`task_updated` 只带子 agent 的 id，要经 `task_started` 对上。
- 子 agent 没有流式的 partial 消息，`stream_event` 全是主线程的。子 agent 思考时的 `thinking_tokens`、`status` 消息不带 id，分不出是谁的。
- canUseTool 不是完整的活动记录：直接放行的调用不经过它。运行卡要看消息流，不能靠回调。
- 版本：只看类型文件，查了 8 个版本的 sdk.d.ts。canUseTool 的 `agentID`、`getSessionMessages`、`claudeMdExcludes` 在 0.3.178 就有；`SessionMessage.parent_agent_id` 是 0.3.198 到 0.3.204 之间加的；assistant、user 消息上的 `agent_id` 是 0.3.291 到 0.3.296 之间加的。CLI 运行时从哪一版开始发这些字段没有查。s02 锁定的 0.3.296 都有。

## 5. 读另一条会话

对应第 18 项的 Claude 一半。

- 在工作目录 X 里建一条会话，再从工作目录是 Y 的另一个进程去读：
  - `dir` 不传：读到 9 条，约 120 毫秒，因为扫了所有项目目录；
  - `dir` 传 X：读到 9 条，约 5 毫秒；
  - `dir` 传 Y：0 条，不报错。
  - `getSessionInfo`、`listSessions` 也一样。读的进程自己的 cwd 不影响结果。
- 读出来的是按顺序排的 user 和 assistant 条目，每个内容块一条：用户消息、tool_use、tool_result、思考块、最终回答。子 agent 的消息不在里面，要用 `listSubagents` 和 `getSubagentMessages` 读。后台任务完成的通知以一条带 `origin` 的合成 user 消息出现。
- 选项只有 `dir`、`limit`、`offset`、`includeSystemMessages`、`sessionStore`。没有"只要用户消息和最终回答"的选项，vonvon 要自己过滤：去掉只含 tool_result 的 user 条目和合成的通知条目，去掉 tool_use 和思考块。
- 记录放在 `~/.claude/projects/<cwd，非字母数字的字符都换成 ->/<会话 id>.jsonl`，子 agent 的在 `<会话 id>/subagents/` 下。CLI 还会写 `~/.claude/session-env/<会话 id>` 和 `/tmp/claude-<uid>/<cwd 换算的名字>/<会话 id>/`，这些会越积越多。
- s48 的做法：每条会话记住它的 cwd，读的时候传 `dir`。

## 6. 个人指令和 `claudeMdExcludes`

- 测法：不让用工具，问模型几个只有 `~/.claude/CLAUDE.md` 和它引入的两个文件里才有的事实；工作目录里另放一个带暗号的项目 CLAUDE.md。没有改 `~/.claude/CLAUDE.md`。每种配置跑一次。
- 结果：

| `settingSources` | 个人的 CLAUDE.md | 项目的 CLAUDE.md |
|---|---|---|
| 空 | 没读到 | 没读到 |
| `['project']` | 没读到 | 读到 |
| `['user', 'project']`，今天 vonvon 的设置 | 读到，连同两个引入文件 | 读到 |
| `['user']` | 读到 | 没读到 |
| `['user', 'project']` 加 `claudeMdExcludes` 写个人 CLAUDE.md 的绝对路径 | 没读到，两个引入文件也没读到 | 读到 |
| 同上，改用 glob `**/.claude/CLAUDE.md` | 没读到 | 读到 |
| 同上，只排除一个引入文件的绝对路径 | 只少了那个文件 | 读到 |

- 排除之后输入的 token 数和只读项目时一样，旁证确实没加载。
- 只给 `['user']` 也会加载个人的 CLAUDE.md，和 sdk.d.ts 里"要加载 CLAUDE.md 必须包含 project"的说法不一样。
- `claudeMdExcludes` 是设置项，不是 `query()` 的选项，经 `options.settings` 传，可以是对象，也可以是 JSON 文件的路径。按 picomatch 匹配绝对路径，只管用户、项目、本地三层，不管托管层。
- `InstructionsLoaded` 和 `SessionStart` 两个 SDK hook 在这些运行里都没有触发，不能拿来核对加载了哪些文件。
- s44 的做法：新建的 bot 不带个人指令，可以用 `claudeMdExcludes`，也可以只给 `['project']`。选哪个，看还要不要用户层的其他设置，比如插件和权限规则。导入的 bot 照旧用 `['user', 'project']`。

## 7. 新发现：连接器和 Claude Code 自己的工具

- `settingSources` 为空、`tools` 为空时，会话里仍然有 claude.ai 的连接器，是一个来源为 claudeai 的 MCP server（这次是 Claude Docs）。
- 不传 `tools` 时，会话里除了文件、Bash、网页这些工具，还有 CronCreate、CronDelete、CronList、Workflow、PushNotification、RemoteTrigger、SendMessage、ListAgents、DesignSync、ScheduleWakeup、EnterWorktree、ExitWorktree、ReportFindings、Monitor、TaskStop、Skill 等，有一次运行里还有 Artifact 的三个工具。这些是 Claude Code 跟账号和本机相关的功能。
- 推断，只看了工具列表，这些工具一个都没有实际调用：群里的人能让 bot 用主人账号的连接器，给主人的设备发推送，建定时任务，以主人的名义发 claude.ai 页面。今天的 vonvon 没有限制这些：`D/agent/claude-agent/permission.ts` 只按档去掉写文件和上网的工具。bridge 依赖 `^0.3.178`，用户下载的是最新的 SDK，推断 bridge 的会话今天也带着这些。
- 关掉的办法，JP-VPS 上各跑了一次：
  - 一次同时设了四个变量：`ENABLE_CLAUDEAI_MCP_SERVERS=false`、`CLAUDE_CODE_DISABLE_ARTIFACT=1`、`CLAUDE_CODE_DISABLE_CRON=1`、`CLAUDE_CODE_DISABLE_WORKFLOWS=1`。结果连接器没了，Cron 的三个工具和 Workflow 没了；Artifact 两次都不在列表里，看不出效果。四个是一起设的，没有分开测哪个变量去掉了哪个，按名字推断各管各的。CLI 里另有设置项 `disableClaudeAiConnectors`，没测。
  - 这四个变量设了以后，PushNotification、RemoteTrigger、SendMessage、DesignSync、ScheduleWakeup 等还在。所以靠变量关不干净。
  - `query()` 的 `tools` 选项给白名单：传 Read、Write、Edit、Bash、WebFetch、WebSearch、Task、AskUserQuestion 八个，会话里就正好是这八个，连接器另用 `ENABLE_CLAUDEAI_MCP_SERVERS=false` 关。真要关，用这个办法。
- 第一版留不留这些，要主人定，因为是少做一件今天能做的事（`docs/v1-plan.md` 4.2 第 3 条）。建议：bot 的会话用内置工具白名单，连接器默认关掉；主人要用哪个连接器，以后按 3.6 的 MCP 名单加。s31 开工前要定。

## 8. 新发现：会话标题读错了

- SDK 0.3.296 的 `getSessionInfo()` 里，`customTitle` 先取用户改的名字，没有就取 CLI 自动起的 `aiTitle`（`sdk.mjs` 里的取值顺序）。sdk.d.ts 说它是"User-set session title via /rename"，和实际不符。
- CLI 会在 SDK 会话里自动写标题：这次有一条会话没人改过名，读出来的 `customTitle` 是 CLI 起的。
- vonvon 的 `readSessionTitle` 只看 `customTitle`（`D/agent/claude-agent/backend.ts:303-311`），标题协调器读到值就记为已有名字，不写 vonvon 的标题（`D/bot/session-title-coordinator.ts:316-319`）。所以 CLI 先起了名的 Claude 会话拿不到 vonvon 的标题。这是推断，没在 vonvon 上跑。
- 修法：从记录文件里找 `type` 为 `custom-title` 的条目，不用 `customTitle` 字段。

## 对第一版的影响

- s31：
  - 只读用 `default`、读写用 `acceptEdits`、各加 canUseTool，和 3.8 的换算表一致。
  - 所有会话启动时都带 `allowDangerouslySkipPermissions: true`，这样中途升到完全访问不用重开会话。
  - resume 时每次明确传档。
  - 拒绝时不用 `interrupt`。
  - 关网时的 Bash 联网：回调拿不到"这是不是联网"的标记，只能看命令文字，或者交给沙箱，看 e03。
  - 内置工具白名单和连接器，开工前问主人（第 7 节）。
- s35：用第 4 节的 id 和消息组织子 agent 区，配合 e01。
- s44：用 `claudeMdExcludes` 或只给 `['project']`（第 6 节）。
- s48：读另一条会话时传 `dir`，自己过滤掉工具步骤（第 5 节）。
- 会话标题的读法另修，见第 8 节。

## 没测的

- 沙箱下的表现（e03）。
- 完全访问下，Claude 设置里的 ask 规则、删除关键目录会不会走到回调。这次只测了写 `.claude/` 下的文件，`bypassPermissions` 下没走回调。
- vonvon 真实的 `['user', 'project']` 下，用户层的权限规则会不会改变哪些调用走回调。
- 被 CLI 误判成只读的 Bash 命令会跳过回调，没有找这种命令来测。
- 嵌套的子 agent、压缩过的会话、git worktree 里的会话。

## 核实记录

另一个代理（Sonnet）读了脚本和原始日志，逐条核对，没有重跑。第 7、8 节是之后补测的，没有经过这一轮核对；合入前的独立审查读过它们的脚本和输出，第 8 节的取值顺序在 `sdk.mjs` 里核对过。

| 结论 | 判定 | 说明 |
|---|---|---|
| `default` 下哪些走回调 | 部分核实 | 日志支持表里的每一格。Glob、Grep、TodoWrite 三个工具一直不存在，表里这几行没有测到，"这一版 CLI 没有它们"是推断，也可能和去掉的环境变量、空的 `settingSources` 有关，只用 Bash 的 find、grep 代替了 |
| `acceptEdits` 下哪些走回调 | 核实 | 同上的缺口 |
| `bypassPermissions` 加回调时只有提问走到回调 | 核实 | 日志里唯一的回调是 AskUserQuestion，所有写都成功了，SDK 的警告在输出里 |
| 今天的配置下没有 AskUserQuestion，也不发拒绝消息 | 核实 | 两档的 init 工具列表里都没有它，模型收到"No such tool available"，两档都没有 `permission_denied`。调用是提示词逼的，参数是猜的，不影响结论。"因为没有回调才去掉"是从 `sdk.mjs` 的参数逻辑推的 |
| 拒绝和 `interrupt` | 核实 | Edit 没有真的被拒过：前面的 Write 被拒，文件不存在，Edit 先报了文件不存在 |
| 中途改档 | 核实 | 第一次运行分不清 acceptEdits 和 bypass，补的那次分清了 |
| resume 不恢复档 | 核实 | 只在 `settingSources` 为空时测过 |
| 拒绝范围的对比 | 部分核实 | 观察都有日志支持。"回调能代替今天按档去掉工具"这个推广，依赖 CLI 把命令判成非只读；被误判的命令没测，"大概"这个判断合适 |
| 子 agent 的 id | 核实 | 只测了一层子 agent，`parent_task_id`、`parent_agent_id` 一直为空 |
| 字段从哪个版本开始有 | 部分核实 | 只看了 8 个版本的类型文件，给的是区间；0.3.178 以下没查，也不代表 CLI 运行时从那一版开始发 |
| `getSessionMessages` 跨工作目录 | 核实 | 没测 git 仓库和 worktree、压缩过的会话、嵌套子 agent，报告自己说了 |
| `claudeMdExcludes` | 核实 | 每种配置只跑了一次；"引入文件也一起排除"是从模型的回答和 token 数推的，hook 没触发；没测 `~` 开头的写法 |

缺口：

- 第 6 节的测试为了不连网，关掉了主人设置里的一个插件，和真实环境略有不同。
- 第 6 节一个暗号在两个文件里都出现，排除单个引入文件那次要看另外几个暗号。
- 每种模式只跑了一次，模型是 haiku；Bash 只读判断的波动没有量。
- 实验去掉了父会话自己的 `CLAUDE*` 环境变量。
