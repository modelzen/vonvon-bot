# 各 provider 原生能力矩阵

调查日期 2026-10-12。只读调查，没有改任何仓库。下文的绝对路径是 JP-VPS 上的参考检出和本机安装位置，用来定位证据，不是仓库内的文件。

用户规则是"所有能力，都要评估是不是原生 provider 有。有就在这个 provider 支持"，并且"都不做模拟"。本文给出每个 provider 原生有什么，以及 Paseo 聊天模式对它呈现了什么。Paseo 聊天模式是体验下限。

## 判定和标注

- **是**。provider 有专门的方法、事件或字段承载这项能力。
- **部分**。原生只覆盖一部分。备注写明哪部分原生、哪部分没有。卡片只能显示原生那部分。
- **条件**。协议定义了，但只有 agent 在 `initialize` 里声明或实际发出时才有。运行时按声明开关。
- **否**。没有原生机制。不做模拟。
- **未知**。证据不足。备注写明哪个实测能定下来。
- 【读】表示看过源码、类型声明或录制数据。【推】表示推断。
- 每格斜杠后是 Paseo 聊天模式的呈现。`P是` 表示 Paseo 呈现了，`P部分` 表示呈现不完整，`P否` 表示 Paseo 不呈现。

## 证据来源和缩写

| 缩写 | 位置 | 版本 |
|---|---|---|
| CX | `/home/operator/vonvon/vonvon-bot/packages/daemon/src/agent/codex-appserver/protocol/generated/`（`CX/v2/` 为 v2 目录） | 仓库内生成类型，托管安装钉在 0.156.1（`origin/main:…/managed-install.ts:10`） |
| VB | `git show origin/main:packages/daemon/src/agent/codex-appserver/backend.ts` | main 7a101ce |
| VC | `git show origin/main:packages/daemon/src/agent/codex-appserver/app-server-client.ts` | 同上 |
| SDK | `/home/operator/.local/share/paseo-runtime/0.11.1/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 0.3.246，与 Paseo 钉的版本一致。Orca 用 0.3.284，本机未安装 |
| TOOLS | 同目录 `sdk-tools.d.ts` | 0.3.246 |
| ACP | `/home/operator/.local/share/paseo-runtime/0.11.1/node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`，`ACPI` 为同目录 `index.d.ts` | 0.17.1，与 Paseo 一致 |
| GF | `/home/operator/orca/src/main/acp/fixtures/s*.jsonl`，Orca 录制的真实 Grok 会话 | Grok `agentVersion` 1.0.46（GF `s1-full-notifications.jsonl:2`） |
| GD | `/home/operator/orca/src/main/acp/acp-dialects/` | Orca 本地检出 |
| CUR | https://cursor.com/docs/cli/acp ，Cursor 官方 ACP 文档，2026-10-12 抓取 | 文档未写版本 |
| PIR / PIS / PIA | `/home/operator/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/` 下的 `modes/rpc/rpc-types.d.ts`、`core/agent-session.d.ts`，以及 `node_modules/@earendil-works/pi-ai/dist/types.d.ts` | 本机安装的 pi 0.99.1 |
| P | `/home/operator/vonvon/references/paseo-0009/packages/server/src/server/agent/` | 0009a7e7 |
| PA | `/home/operator/vonvon/references/paseo-0009/packages/app/src/` | 同上 |

本机只装了 `claude`（2.1.296）和 `pi`（0.99.1），没有 `codex`、`cursor-agent`、`grok`。CLI 只跑过 `--help` 和 `--version`。

新版 Paseo（`/home/operator/paseo`，b63a325）和钉住的 0009 在 provider 层只有 Claude 模型发现不同。`diff -rq` 显示 agent 目录下只有 `providers/claude/agent.ts`、`models.ts`、`model-manifest.ts` 不同，新增 `model-discovery.ts`。`agent-sdk-types.ts`、`agent-stream/`、`tool-call-details.tsx` 完全相同【读】。所以下面的 Paseo 结论对两个版本都成立，行号以 0009 为准。

## 矩阵

| # | 能力 | Codex | Claude Code | Cursor | Grok | Pi | 自定义 ACP |
|---|---|---|---|---|---|---|---|
| 1 | 新建会话 | 是 `thread/start` / P是 | 是 `query()` / P是 | 是 `session/new` / P是 | 是 `session/new` / P是 | 是 启动或 `new_session` / P是 | 是 `session/new` / P是 |
| 2 | 恢复会话 | 是 `thread/resume` / P是 | 是 `resume` / P是 | 是 `session/load` / P是 | 是 `session/load`、`resume` / P是 | 是 `--session`、`switch_session` / P是 | 条件 `loadSession` 或 `resume` / P是 |
| 3 | 分叉 | 是 `thread/fork` / P部分 | 是 `forkSession` / P部分 | 未知 / P否 | 否 / P否 | 是 `fork`、`clone` / P部分 | 条件 `fork`（不稳定） / P否 |
| 4 | 列出历史会话 | 是 `thread/list` / P是 | 是 `listSessions()` / P是 | 未知 / P条件 | 是 `session/list` / P是 | 部分 无 RPC，只有会话文件 / P是 | 条件 `session/list` / P是 |
| 5 | 读取历史内容 | 是 `thread/read` / P是 | 是 `getSessionMessages()` / P是 | 是 `session/load` 重放 / P是 | 是 `session/load` 重放 / P是 | 是 `get_messages`、`get_entries` / P是 | 条件 `loadSession` / P是 |
| 6 | 回答文本增量 | 是 `item/agentMessage/delta` / P是 | 是 `stream_event` / P是 | 是 `agent_message_chunk` / P是 | 是 `agent_message_chunk` / P是 | 是 `text_delta` / P是 | 是 `agent_message_chunk` / P是 |
| 7 | 推理增量 | 是 `item/reasoning/*Delta` / P是 | 是 thinking delta / P是 | 未知 / P条件 | 未知 / P条件 | 是 `thinking_delta` / P是 | 条件 `agent_thought_chunk` / P是 |
| 8 | 结构化工具调用 | 是 ThreadItem 分类 / P是 | 部分 按工具名 / P是 | 条件 ACP `kind` / P是 | 是 ACP `kind` 加 `x.ai/tool` / P是 | 部分 按工具名 / P是 | 是 ACP `kind`、diff / P是 |
| 9 | steer | 是 `turn/steer` / P是 | 是 `priority` 输入 / P是 | 否 / P否 | 未知 / P否 | 是 `steer` / P是 | 否 / P否 |
| 10 | 中断 | 是 `turn/interrupt` / P是 | 是 `interrupt()` / P是 | 是 `session/cancel` / P是 | 是 `session/cancel` / P是 | 是 `abort` / P是 | 是 `session/cancel` / P是 |
| 11 | 回合结果和原因 | 是 `Turn.status`、`codexErrorInfo` / P部分 | 是 `subtype`、`terminal_reason` / P部分 | 部分 5 个基础原因 / P部分 | 是 基础原因加 `turn_completed.stop_reason` / P部分 | 是 `StopReason` / P部分 | 部分 5 个基础原因 / P部分 |
| 12 | 子 agent 启动信号 | 是 `collabAgentToolCall` / P是 | 是 `task_started` / P是 | 是 `cursor/task` / P否 | 是 `subagent_spawned` / P否 | 否 / P否 | 否 / P否 |
| 13 | 子 agent 逐条事件 | 是 子 thread 的全部通知 / P是 | 是 `parent_tool_use_id`、`task_progress` / P是 | 部分 `cursor/task` / P否 | 部分 `subagent_progress` / P否 | 否 / P否 | 否 / P否 |
| 14 | 单独停止子 agent | 部分 对子 thread 发 `turn/interrupt` / P否 | 是 `stopTask()` / P否 | 未知 / P否 | 是 `_x.ai/subagent/cancel` / P否 | 否 / P否 | 否 / P否 |
| 15 | todo 清单 | 是 `turn/plan/updated` / P是 | 部分 TodoWrite、Task* 工具 / P是 | 是 `cursor/update_todos` / P否 | 未知 / P条件 | 否 / P否 | 条件 `plan` / P是 |
| 16 | 图片输出 | 是 `imageGeneration`、`imageView`、MCP 图片 / P是 | 部分 tool_result 图片 / P是 | 是 `cursor/generate_image` / P否 | 未知 / P否 | 部分 工具结果图片 / P否 | 条件 image 内容块 / P否 |
| 17 | 图片输入 | 是 `image`、`localImage` / P是 | 是 image 内容块 / P是 | 未知 / P条件 | 否 / P否 | 是 `prompt.images` / P是 | 条件 `promptCapabilities.image` / P条件 |
| 18 | goal | 是（实验） `thread/goal/*` / P部分 | 未知 `/goal` / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 19 | 手动压缩 | 是 `thread/compact/start` / P是 | 是 `/compact` 命令 / P是 | 未知 / P否 | 未知 / P否 | 是 `compact` / P是 | 否 / P否 |
| 20 | 自动压缩和通知 | 是 `thread/compacted` / P是 | 是 `compact_boundary` / P是 | 未知 / P否 | 未知 / P否 | 是 `compaction_start/end` / P是 | 否 / P否 |
| 21 | 上下文窗口用量 | 是 `thread/tokenUsage/updated` / P是 | 是 `getContextUsage()` / P是 | 条件 `usage_update` / P条件 | 部分 只有窗口大小和单次响应 token / P部分 | 是 `get_session_stats` / P是 | 条件 `usage_update`（不稳定） / P是 |
| 22 | 每回合 token | 是 `tokenUsage.last` / P是 | 是 `result.usage` / P是 | 条件 `PromptResponse.usage` / P条件 | 是 `response_completed.usage` / P部分 | 是 消息 usage、`get_session_stats` / P是 | 条件（不稳定） / P条件 |
| 23 | 账户用量和限额 | 是 `account/rateLimits/read` / P部分 | 部分 `rate_limit_event` / P部分 | 否 / P否 | 部分 `rate_limit` 结束原因 / P否 | 否 / P否 | 否 / P否 |
| 24 | 模型列表 | 是 `model/list` / P是 | 是 `supportedModels()` / P是 | 是 `cursor/list_available_models` / P是 | 是 `modelState`、`x.ai/models/list` / P是 | 是 `get_available_models` / P是 | 条件 `models` 或 configOptions / P是 |
| 25 | 推理强度 | 是 `effort` / P是 | 是 `effort` / P是 | 未知 / P条件 | 部分 能读档位，设置方式未知 / P条件 | 是 `set_thinking_level` / P是 | 条件 `thought_level` 选项 / P是 |
| 26 | 运行时模式切换 | 是 每回合的审批和沙箱参数 / P否 | 是 `setPermissionMode()` / P是 | 是 `session/set_mode` / P是 | 部分 plan 模式工具 / P条件 | 否 / P否 | 条件 `session/set_mode` / P是 |
| 27 | 会话标题 | 部分 读和设，生成未知 / P否 | 是 读、设、自动生成 / P否 | 未知 / P否 | 是 读和自动生成，设置未知 / P否 | 部分 读和设，无生成 / P否 | 部分 只能读 / P否 |
| 28 | MCP 配置 | 是 config、`mcpServerStatus/list` / P是 | 是 `mcpServers`、`setMcpServers()` / P是 | 部分 `.cursor/mcp.json` / P是 | 是 `mcpServers` 加 http/sse / P是 | 部分 只有 `pi mcp` CLI / P否 | 是 `session/new.mcpServers` / P是 |
| 29 | 斜杠命令和 skills | 部分 `skills/list` / P是 | 是 `supportedCommands()` / P是 | 是 `available_commands_update` / P是 | 是 `available_commands_update` / P是 | 是 `get_commands` / P是 | 是 `available_commands_update` / P是 |
| 30 | 回退和检查点 | 部分 `thread/rollback` 只回对话 / P是 | 是 `rewindFiles()` 加 `resumeSessionAt` / P是 | 否 / P否 | 否 / P否 | 部分 `fork` 分支，不回文件 / P是 | 否 / P否 |
| 31 | review 模式 | 是 `review/start` / P否 | 未知 / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 32 | 后台任务 | 部分 `process/*` 通知 / P否 | 是 `background_tasks_changed`、`stopTask()` / P否 | 未知 / P否 | 是 `task_backgrounded`、`_x.ai/task/kill` / P否 | 否 / P否 | 否 / P否 |
| 33 | 联网搜索 | 是 `webSearch` 项 / P是 | 是 WebSearch、WebFetch / P是 | 未知 / P条件 | 是 `web_search`、`web_fetch` 工具 / P条件 | 否 / P否 | 部分 只有 `fetch`、`search` 分类 / P条件 |
| 34 | 读限制 | 部分 权限 profile，依 OS / P否 | 部分 `denyRead` 只管 Bash / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 35 | 写限制 | 是 `workspace-write`、profile / P是 | 部分 Bash 沙箱加工具禁用 / P是 | 部分 ask、plan 模式 / P是 | 部分 plan 模式 / P条件 | 部分 只能裁工具 / P否 | 条件 agent 的只读模式 / P条件 |
| 36 | 网络限制 | 是 `networkAccess`、profile network / P是 | 部分 只管 Bash / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 37 | 审批请求 | 是 `*/requestApproval` / P是 | 是 `canUseTool` / P是 | 是 `session/request_permission` / P是 | 是 `session/request_permission` / P是 | 部分 扩展发起的 UI 请求 / P是 | 是 `session/request_permission` / P是 |
| 38 | 登录状态检测 | 是 `account/read` / P是 | 部分 `claude auth status` / P是 | 部分 `authenticate`，状态靠本地文件 / P否 | 部分 `authMethods`、`-32000` / P否 | 是 `pi auth check --json` / P否 | 部分 `authMethods`、`authenticate` / P否 |
| 39 | 开发者和系统指令 | 是 `developerInstructions` / P是 | 是 `systemPrompt` / P是 | 否 / P否 | 未知 / P否 | 是 `--append-system-prompt` / P是 | 否 / P否 |
| 40 | 向用户提问 | 是 `item/tool/requestUserInput` / P是 | 是 `onUserDialog`、AskUserQuestion / P是 | 是 `cursor/ask_question` / P否 | 是 `x.ai/ask_user_question` / P否 | 部分 扩展的 select、input / P是 | 条件 `session/elicitation`（不稳定） / P否 |
| 41 | 自动重试状态 | 是 `error.willRetry` / P否 | 是 `api_retry` / P否 | 未知 / P否 | 是 `retry_state` / P否 | 是 `auto_retry_start/end` / P否 | 否 / P否 |
| 42 | 整回合 diff | 是 `turn/diff/updated` / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 43 | 结构化输出 | 是 `outputSchema` / P是 | 是 `outputFormat` / P是 | 否 / P否 | 否 / P否 | 否 / P否 | 否 / P否 |
| 44 | hooks 事件 | 是 `hook/started`、`hook/completed` / P否 | 是 `hooks`、`hook_*` 消息 / P否 | 否 / P否 | 是 `hook_execution` / P否 | 否 / P否 | 否 / P否 |

第 40 到 44 行是任务清单之外发现的原生能力。产品已决定不做审批卡和计划审批，第 37、40 行只说明 daemon 必须自动应答哪些请求。

## 逐格说明

### 1 到 5 会话

**Codex。** `thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/read` 都在 `ClientRequest` 联合里（CX `ClientRequest.ts:83`）【读】。`ThreadListParams` 支持 `cwd`、`searchTerm`、分页（CX `v2/ThreadListParams.ts`）【读】。`ThreadReadParams.includeTurns` 决定是否带回合（CX `v2/ThreadReadParams.ts`）【读】。Vonvon main 已经在用 list 和 read（VB:574，:606）【读】。Paseo 用 `thread/fork` 和 `thread/rollback` 实现回退（P `providers/codex-app-server-agent.ts:2164`，:2174），没有单独的"分叉"入口，所以记 P部分【读】。

**Claude。** `Options.resume`（SDK:1878）、`sessionId`（:1884）、`forkSession`（:1551），以及函数 `forkSession()`（:723）、`listSessions()`（:977）、`getSessionInfo()`（:752）、`getSessionMessages()`（:782）【读】。子 agent 历史另有 `listSubagents()`（:1032）和 `getSubagentMessages()`（:819）【读】。Paseo 把分叉只用作回退锚点（P `providers/claude/agent.ts:3116` 附近注释），记 P部分【推】。

**Cursor。** CUR 写明 `session/load` 用来"Resume an existing conversation"【读】。`session/list`、分叉、`loadSession` 声明都没写【读】。按 ACP 语义，`session/load` 会把历史以 `session/update` 重放，所以历史可读【推】。

**Grok。** 录制的 `initialize` 回包声明 `loadSession:true`，`sessionCapabilities` 有 `list`、`resume`、`close`，没有 `fork`（GF `s1-full-notifications.jsonl:2`）【读】。

**Pi。** RPC 有 `new_session`（PIR:38）、`switch_session`（:104）、`fork`（:108）、`clone`（:112）、`get_entries`（:118）、`get_tree`（:122）、`get_messages`（:132）【读】。没有列会话的 RPC。会话是 `--session-dir` 下的文件（`pi --help`）【读】。Paseo 的导入列表按文件读，所以记"部分，P是"（P `providers/pi/agent.ts:2702`）【推】。

**自定义 ACP。** 稳定方法有 `session/new`、`session/load`、`session/list`（ACPI:2-16）【读】。`fork`、`resume`、`close` 标为 UNSTABLE（ACP:1297，:2501，:595）【读】。都按 `agentCapabilities.loadSession` 和 `sessionCapabilities.*` 判断（ACP:36，:2600）【读】。Paseo 先 `loadSession`，再退到 `unstable_resumeSession`（P `providers/acp-agent.ts:1843-1858`），列表用 `listSessions`（:1229）【读】。

### 6 到 8 流式和工具

**文本和推理。** Codex 有 `item/agentMessage/delta`、`item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`（CX `ServerNotification.ts:72`）【读】。Claude 要设 `includePartialMessages`（SDK:1702），增量从 `SDKPartialAssistantMessage` 来（:4516）【读】。thinking 是否显示原文由 `thinkingDisplay` 决定（SDK `setMaxThinkingTokens` 签名，:2482 附近）【读】。Pi 的 `AssistantMessageEvent` 有 `text_delta` 和 `thinking_delta`（PIA:564 起）【读】。ACP 有 `agent_message_chunk` 和 `agent_thought_chunk`（ACP:3053，:3055）【读】。Grok 的 6 份录制里没有一条 `agent_thought_chunk`【读 GF grep】，所以 Grok 推理记未知。Cursor 文档只举了 `agent_message_chunk`（CUR）【读】。

**工具调用。**
- Codex 的 `ThreadItem` 自带分类（CX `v2/ThreadItem.ts:26-101`）【读】：
  - `commandExecution`，有 `command`、`cwd`、`aggregatedOutput`、`exitCode`、`commandActions`
  - `fileChange`，有 `changes`，带 diff
  - `mcpToolCall`，有 `server`、`tool`、`result`
  - `dynamicToolCall`
  - `webSearch`，有 `query`、`action`
  - `collabAgentToolCall`
  - `imageView`、`imageGeneration`
  - `enteredReviewMode`、`exitedReviewMode`
  - `contextCompaction`
- Claude 只有 `tool_use` 的工具名和输入，没有协议级分类。各工具的输入输出类型在 TOOLS 里（例如 `TodoWriteInput` TOOLS:999，`TaskCreateInput` :2692）【读】。分类只能按工具名做，这是 Claude 的原生形态，不算模拟。
- ACP 的 `ToolCall` 有 `kind`、`content`、`locations`、`rawInput`、`rawOutput`（ACP:3424-3450）【读】。`ToolKind` 有 read、edit、delete、move、search、execute、think、fetch、switch_mode、other（ACP:3571）【读】。`ToolCallContent` 可以是 content、diff 或 terminal（ACP:3464）【读】。
- Grok 录制里出现的 kind 有 execute、read、edit、search、other（GF grep）【读】。Grok 还在 `_meta["x.ai/tool"].name` 里给真实工具名（GD `grok-dialect.ts:12`，:202）【读】，并有私有的 `tool_call_delta_chunk`（GF）【读】。
- Pi 只有 `tool_execution_start/update/end`，带 `toolName`、`args`、`result`、`isError`（`pi-agent-core/dist/types.d.ts:450` 起），按工具名分类【读】。
- Paseo 呈现。Codex 按 item 类型映射（P `providers/codex/tool-call-mapper.ts:1015-1026`）【读】。Claude 按工具名解析（P `providers/claude/tool-call-detail-parser.ts:70-186`）【读】。ACP 按 kind 映射（P `providers/acp-agent.ts:3787-3886`）【读】。Pi 按工具名映射（P `providers/pi/tool-call-mapper.ts:286-323`）【读】。

### 9 到 11 steer、中断、结果

**steer。**
- Codex 用 `turn/steer`，带 `expectedTurnId`（VB:457，CX `ClientRequest.ts:83`）。不可插入时错误码是 `activeTurnNotSteerable`（CX `v2/CodexErrorInfo.ts`）【读】。
- Claude 的 `SDKUserMessage.priority` 取 `'now' | 'next' | 'later'`（SDK:5032），通过流式输入送入（`streamInput` SDK:2698）。Paseo 用 `priority = "next"`（P `providers/claude/agent.ts:2375`）【读】。
- Pi 有 `steer` 和 `follow_up`（PIR:22，:27），`prompt.streamingBehavior` 也可以选 steer（PIR:19）。另有 `queue_update` 事件（PIS:56）【读】。
- ACP 基础协议没有插入方法（ACPI:2-16）【读】。Orca 的 ACP steer 是先取消再重发（`/home/operator/orca/src/main/acp/acp-structured-turns.ts:1-9`）【读】，属于模拟，不采用。
- Grok 有 `_x.ai/queue/changed`（GF，GD `grok-dialect.ts:131`）【读】。这说明 Grok 原生给提示排队，但录制里看不出是不是插入到正在运行的回合，所以记未知。

**中断。** Codex 用 `turn/interrupt`（VB:465）【读】。Claude 用 `Query.interrupt()`（SDK:2425）【读】。ACP 用 `session/cancel`（ACPI:6）【读】。Pi 用 `abort`（PIR:32）【读】。超时后杀进程树属于生命周期保障，不算模拟。

**回合结果。**
- Codex 的 `TurnStatus` 有 completed、interrupted、failed、inProgress（CX `v2/TurnStatus.ts`）【读】。`TurnError.codexErrorInfo` 细分 contextWindowExceeded、usageLimitExceeded、serverOverloaded、unauthorized、sandboxError 等（CX `v2/CodexErrorInfo.ts`）【读】。
- Claude 的 result `subtype` 有 success、error_during_execution、error_max_turns、error_max_budget_usd、error_max_structured_output_retries（SDK:4643-4700）【读】。另有 `is_error`、`stop_reason`、`terminal_reason`，后者 19 种取值，包括 aborted_streaming、prompt_too_long、max_turns、blocking_limit（SDK:8147）【读】。
- Pi 的 `StopReason` 有 stop、length、toolUse、error、aborted、deferred（PIA:311）。`agent_end.willRetry` 说明是否会自动重试（PIS:48-52）【读】。
- ACP 基础 `StopReason` 只有 end_turn、max_tokens、max_turn_requests、refusal、cancelled（ACP:3216）【读】。出错走 JSON-RPC error。
- Grok 在私有的 `turn_completed` 里额外给 `stop_reason`（可以是 error、rate_limit）、`agent_result` 和 `elapsed_ms`（GD `grok-dialect.ts:18`，:37，:214）。另有 `_x.ai/session/prompt_complete`（:121）【读】。
- Paseo 只分 `turn_completed`、`turn_failed`、`turn_canceled` 三种（P `agent-sdk-types.ts:405-430`）【读】。ACP 的 refusal、max_tokens、max_turn_requests 被并进 `turn_completed`，原因丢了（P `providers/acp-agent.ts:3256-3275`）【读】。所以所有 provider 都记 P部分。

### 12 到 14 子 agent

**Codex。**
- 启动信号是 `collabAgentToolCall`，`tool` 为 spawnAgent、sendInput、resumeAgent、wait、closeAgent，带 `receiverThreadIds`、`prompt`、`model`、`agentsStates`（CX `v2/ThreadItem.ts:64-101`，`v2/CollabAgentTool.ts`）【读】。
- 子 agent 是独立 thread。`Thread.source` 为 `thread_spawn{parent_thread_id, depth, agent_nickname, agent_role}`（CX `v2/SubAgentSource.ts`）【读】。子 thread 的所有 `item/*` 通知带自己的 `threadId`，所以逐条事件是原生的。
- 停止单个子 agent 没有专门方法。Orca 对子 thread 的 turn 发 `turn/interrupt`（`/home/operator/orca/src/main/codex/codex-subagent-interrupts.ts:1-3`）【读】。这是原生方法用在子 thread 上，记部分。
- Paseo 发 `provider_subagent` 事件（P `providers/codex-app-server-agent.ts:5888`），工具行是 `sub_agent` detail（P `providers/codex/tool-call-mapper.ts:950`）。app 用子 agent 轨道和只读面板展示（PA `subagents/track.tsx`，`panels/provider-subagent-panel.tsx`）【读】。

**Claude。**
- 启动、状态、结束分别是 `task_started`（SDK:4924，带 `subagent_type`、`task_type`、`prompt`）、`task_updated`（:4956）、`task_progress`（:4902，带 `last_tool_name`、`summary`、usage）、`task_notification`（:4884，completed、failed、stopped）【读】。
- 子 agent 的消息带 `parent_tool_use_id`（SDK:5026）。`forwardSubagentText` 可转发完整子会话（:1709）【读】。
- 停止单个用 `stopTask(taskId)`（SDK:2703）【读】。
- Paseo 的 `provider_subagent` 在 P `providers/claude/agent.ts:2130`，`sub_agent` detail 在 :5953。全仓 grep 没有 stopTask 或单个子 agent 的停止入口【读】。

**Cursor。** CUR 写有 `cursor/task` 通知，说明是"subagent task updates"，类型有 explore、shell、browser_use 和自定义【读】。字段和粒度没写。停止方法没写。Paseo 的 `extNotification` 只解析扩展命令，其余丢弃（`/home/operator/paseo/packages/server/src/server/agent/providers/acp-agent.ts:2649-2665`）【读】。

**Grok。** 有 `subagent_spawned`、`subagent_progress`、`subagent_finished`，子 agent id 就是子 session id（GD `grok-subagents.ts:2-3`，:15）。停止用 `_x.ai/subagent/cancel`（GD `grok-subagent-stop.ts:15-21`）【读】。录制 `s7-subagent-*.jsonl` 有完整样本【读】。Paseo 不处理。

**Pi 和自定义 ACP。** 没有子 agent 概念。Pi 的 `parentToolCallId` 只表示工具里调用工具（PIS:40-45）【读】。

### 15 todo

- **Codex。** `turn/plan/updated` 带 `explanation` 和 `plan[{step, status}]`（CX `v2/TurnPlanUpdatedNotification.ts`，`v2/TurnPlanStep.ts`）【读】。另有 `plan` 类 ThreadItem 和 `item/plan/delta`，那是计划模式的文档，不是清单。Paseo 把前者映射成 `todo`（P `providers/codex-app-server-agent.ts:1104`），把后者映射成 `plan` detail 的工具行（:1121-1140）【读】。
- **Claude。** 没有专门事件。原生载体是 TodoWrite 的 `todos` 输入，以及 TaskCreate、TaskUpdate、TaskList 工具（TOOLS:29-39，:999，:2692，:2718）【读】。这是原生工具的结构化输入，不是推断。卡片只能在看到这些工具调用时显示清单。Paseo 用 `ClaudeTaskState` 把它们折叠成 `todo`（P `providers/claude/task-state.ts:78-191`）【读】。
- **Cursor。** `cursor/update_todos` 通知，`merge:true` 合并，`false` 替换（CUR）【读】。Paseo 丢弃。
- **Grok。** 工具清单里有 `todo_write`（GF `s1-full-notifications.jsonl` 的 `available_commands_update._meta.tools`）【读】。录制里没有 `plan` 更新，所以不知道它会不会发 ACP `plan`【读 GF grep】。
- **自定义 ACP。** `plan` 更新带 `entries[{content, priority, status}]`，status 为 pending、in_progress、completed（ACP:2096，:2161）【读】。Paseo 映射成 `todo`（P `providers/acp-agent.ts:3047`，:3691）【读】。

### 16 到 17 图片

**输出。**
- Codex 有三种来源，都会显示。`imageGeneration` 带 `savedPath`、`result`、`revisedPrompt`。`imageView` 带 `path`。`mcpToolCall.result.content` 里可能有图片块。另外 `dynamicToolCall` 的输出可以是 `inputImage`（CX `v2/ThreadItem.ts:101`，`v2/DynamicToolCallOutputContentItem.ts`）【读】。Paseo 三种都转成 assistant markdown 图片（P `providers/codex-app-server-agent.ts:1942-1972`，:2039-2047）【读】。
- Claude 只有工具结果里的图片块，例如 Read 读图片、MCP 截图。没有原生生图。Paseo 转成 markdown（P `providers/claude/agent.ts:5444`）【读】。
- Cursor 有 `cursor/generate_image` 通知（CUR）【读】。负载格式没写。
- Grok 有 `image_gen`、`image_edit` 工具（GF `_meta.tools`）【读】，结果怎么回传未知。
- Pi 的 `ToolResultMessage.content` 可以含 `ImageContent{data, mimeType}`（PIA:421，:275）【读】。Paseo 不显示。
- ACP 的 `ContentBlock` 允许 image（ACP:689），可以出现在消息块和工具 content 里【读】。Paseo 把它渲染成文字 `[image]`（P `providers/acp-agent.ts:3636`）【读】。

**输入。**
- Codex 用 `UserInput` 的 `image{url}` 和 `localImage{path}`（CX `v2/UserInput.ts`）。`Model.inputModalities` 标明模型能否接收图片（CX `v2/Model.ts`）【读】。
- Claude 的用户消息可含 image 块（SDK:5023）【读】。
- Pi 用 `prompt.images`（PIR:18），模型 `input` 含 image 时才有效（P `providers/pi/agent.ts:366`）【读】。
- Grok 1.0.46 声明 `promptCapabilities.image:false`（GF `s1-full-notifications.jsonl:2`）【读】。
- Cursor 的声明未知。

### 18 goal

- **Codex。** `thread/goal/set`、`thread/goal/clear`、`thread/goal/get` 是实验接口，不在生成的稳定 `ClientRequest` 里（CX `ClientRequest.ts:83` 无此方法）【读】。要在 `initialize` 里带 `experimentalApi:true` 才能用（VC:155-161）【读】。通知 `thread/goal/updated` 和 `thread/goal/cleared` 在稳定联合里（CX `ServerNotification.ts:72`）【读】。`ThreadGoal` 有 objective、status、tokenBudget、tokensUsed、timeUsedSeconds，status 取 active、paused、budgetLimited、complete（CX `v2/ThreadGoal.ts`，`v2/ThreadGoalStatus.ts`）【读】。Paseo 只把 `/goal` 当文字命令，结果以 assistant 文字回显，不订阅 `thread/goal/updated`（P `providers/codex-app-server-agent.ts:5103-5130`，:5183-5205；grep 无 goal/updated）【读】，记 P部分。
- **Claude。** SDK 导出 `SDKActiveGoalMessage`，注释说它由用户的 `/goal` Stop hook 触发，带 condition、iterations、last_reason（SDK:3053-3066）【读】。但它不在 `SDKMessage` 联合里（SDK:4371）【读】。所以 `/goal` 是 CLI 原生命令，SDK 流里会不会出现进度事件不确定，记未知。V6 用提示词包一轮来模拟 goal，按用户规则删掉。
- **其他。** Cursor、Pi、ACP 都没有 goal。Grok 的 scheduler、monitor、workflow 工具（GF `_meta.tools`）不是 goal 语义【推】。

### 19 到 20 压缩

- **Codex。** 手动压缩用 `thread/compact/start`（CX `ClientRequest.ts:83`，VB:479）【读】。自动压缩完成后发 `thread/compacted{threadId, turnId}`，并生成 `contextCompaction` 项（CX `v2/ContextCompactedNotification.ts`，`v2/ThreadItem.ts:101`）【读】。阈值通过 thread config 设置（`model_auto_compact_token_limit`）【读】；s12 起 Vonvon 不再设它，自动压缩一直开。
- **Claude。** 没有压缩方法。`/compact` 是 CLI 自己处理的斜杠命令，Paseo 原样作为提示发出【推】，所以记"是，原生命令"。压缩过程中 `status` 为 `compacting`，结束带 `compact_result`（SDK:4808-4820）【读】。随后发 `compact_boundary`，带 `trigger` manual 或 auto、`pre_tokens`、`post_tokens`（SDK:3187）【读】。Paseo 映射成 compaction 项（P `providers/claude/agent.ts:4428`，:4459）【读】。V6 把 `/compact` 当普通回合来模拟（见 JP-VPS 笔记 `/home/operator/vonvon/provider-redesign/vonvon-current.md`，不在仓库里，3.1），新设计应该直接发原生命令，并读 `compact_boundary`。
- **Pi。** 有 `compact`、`set_auto_compaction`（PIR:74，:78），以及 `compaction_start` 和 `compaction_end`，reason 为 manual、threshold、overflow（PIS:60，:72）【读】。
- **Cursor、Grok。** 协议里没有压缩，命令清单拿不到（Grok 录制的 `availableCommands` 是空数组，Cursor 未知）。所以记未知。
- **自定义 ACP。** 基础协议没有压缩。

### 21 到 23 用量

- **Codex。**
  - `thread/tokenUsage/updated` 带 `tokenUsage{total, last, modelContextWindow}`（CX `v2/ThreadTokenUsageUpdatedNotification.ts`，`v2/ThreadTokenUsage.ts`）【读】。
  - 账户限额用 `account/rateLimits/read`，变化时推 `account/rateLimits/updated`。`RateLimitSnapshot` 有 primary、secondary、credits、planType、rateLimitReachedType（CX `v2/RateLimitSnapshot.ts`）【读】。
  - Vonvon main 的用量卡直接请求 ChatGPT `wham` 接口（见 `/home/operator/vonvon/provider-redesign/vonvon-current.md`（JP-VPS 上的调研笔记，不在仓库里） 第 4 节）【读】。原生 RPC 已经有了，可以改用。
- **Claude。**
  - `getContextUsage()` 返回分类明细和 totalTokens、maxTokens（SDK:2571，:3391）【读】。
  - result 带 `usage`、`modelUsage`（含 contextWindow）、`total_cost_usd`（SDK:4643 起，:1289-1296）【读】。
  - 账户侧只有回合中的 `rate_limit_event`，带 status、resetsAt、rateLimitType、utilization（SDK:4610-4640）【读】，没有主动查询。`accountInfo()` 只给账户身份（SDK:2618，:23）【读】。
- **Grok。** 窗口大小在 models 的 `_meta.totalContextTokens`（GD `grok-dialect.ts:59-73`）【读】。每次模型响应在私有的 `response_completed.usage` 里报 token（:44）【读】。没有"当前已用"，记部分。录制里没有 ACP `usage_update`【读 GF grep】。
- **Pi。** `get_session_stats` 返回 tokens、cost、`contextUsage{tokens, contextWindow, percent}`（PIR:97，PIS:185-202）【读】。Paseo 每 3 秒轮询一次（P `providers/pi/usage-poller.ts`）【读】。
- **ACP。** `usage_update{size, used, cost}` 和 `PromptResponse.usage` 都是 UNSTABLE（ACP:3648，:2277-2285）【读】。
- **账户用量的协议外来源。** Cursor 和 Grok 没有协议内的账户用量。Orca 通过厂商 HTTP 接口拿（`/home/operator/orca/src/main/rate-limits/cursor-fetcher.ts:16`，`grok-fetcher.ts:17`）【读】。这是厂商的原生账户接口，但不在 agent 协议里，也没有公开文档。要不要算原生，需要产品决定。本表按"协议内没有"记否。Paseo 的用量卡来自插件化的 usage source（P `../plugins/usage-sources/index.ts`），不走 provider 协议【读】，所以 Codex 和 Claude 记 P部分。

### 24 到 26 模型、强度、模式

- **模型列表。**
  - Codex 用 `model/list`，`Model` 带 `supportedReasoningEfforts`、`defaultReasoningEffort`、`inputModalities`（CX `v2/Model.ts`）【读】。
  - Claude 用 `supportedModels()`（SDK:2552），`ModelInfo.supportedEffortLevels`（SDK:1271）【读】。
  - Cursor 用扩展 `cursor/list_available_models`（P `providers/cursor-acp-agent.ts:72`）【读】。
  - Grok 在 `initialize._meta.modelState` 里给模型和 `reasoningEfforts`（xhigh、high、medium、low），另有 `x.ai/models/list` 和 `x.ai/models/update`（GF，GD `grok-model-catalog.ts:2`，:39-40）【读】。
  - Pi 用 `get_available_models`（PIR:53）【读】。
  - ACP 可以在 `NewSessionResponse.models` 里给（不稳定，ACP:2011），也可以给 `configOptions`（稳定，:2001），类别为 model 或 thought_level（:2735）【读】。
- **强度。**
  - Codex 用 `TurnStartParams.effort`（CX `v2/TurnStartParams.ts:35`）【读】。
  - Claude 用 `Options.effort`，档位 low、medium、high、xhigh、max（SDK:1735，:576）【读】。
  - Pi 用 `set_thinking_level` 和 `get_available_thinking_levels`（PIR:56，:63）【读】。
  - Grok 能读到档位，录制里的 `model_changed` 带 `reasoning_effort`（GF）【读】，但不知道用哪个方法设置。
  - Cursor 只知道 Paseo 加了一个 `fast` 特性（P `providers/cursor-acp-agent.ts:27`）【读】。
- **模式。**
  - Codex 每回合可以换 `approvalPolicy`、`sandboxPolicy`、`model`、`effort`（CX `v2/TurnStartParams.ts:16-45`）【读】。Paseo 不提供动态模式（`supportsDynamicModes:false`，P `providers/codex-app-server-agent.ts:235`）【读】。
  - Claude 用 `setPermissionMode()`（SDK:2432），模式有 default、acceptEdits、bypassPermissions、plan、dontAsk、auto（:2220）【读】。
  - Cursor 有 agent、plan、ask 三种模式（CUR）【读】。
  - Grok 有 enter_plan_mode、exit_plan_mode 工具，以及 `_x.ai/exit_plan_mode` 请求（GD `grok-requests.ts:122`）【读】。
  - Pi 没有模式（见 `/home/operator/vonvon/provider-redesign/paseo-and-vonvon-permissions.md`（JP-VPS 上的调研笔记，不在仓库里））【读】。

### 27 会话标题

- **Codex。** 读取用 `Thread.name`（CX `v2/Thread.ts:11`），设置用 `thread/name/set`，变化时推 `thread/name/updated`（CX `ServerNotification.ts:72`）【读】。Codex 会不会自己生成标题未知。Vonvon 现在另起一轮 utility 回合，用 `outputSchema` 生成标题（VB:645 附近；JP-VPS 笔记 `/home/operator/vonvon/provider-redesign/vonvon-current.md` 1.3，不在仓库里）【读】。按用户规则，这是 Vonvon 侧生成，不算原生。
- **Claude。** `SDKSessionInfo.summary` 是"custom title, auto-generated summary, or first prompt"，另有 `customTitle`（SDK:4736-4746）【读】。设置用 `renameSession()`（:2739）或新会话的 `Options.title`（:2159）。`title` 的注释说不设置时会从首条消息自动生成【读】。
- **Grok。** `session_info_update.title` 和私有的 `session_summary_generated` 是 Grok 自动生成的标题（GF）【读】。设置方法未知。
- **Pi。** 有 `set_session_name`（PIR:128）、`session_info_changed`（PIS:66）和启动参数 `--name`【读】。不会自动生成。
- **ACP。** `session_info_update{title, updatedAt}`（ACP:2880）。`SessionInfo.title` 出现在列表里（:2868）【读】。没有设置方法。
- **Paseo。** 标题全部由 Paseo 自己派生，不读 provider 标题（见下文"Paseo 自己合成的东西"）。

### 28 到 29 MCP、命令

- **MCP。**
  - Codex 用 thread config，另有 `mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`（CX `ClientRequest.ts:83`）【读】。
  - Claude 有 `mcpServers`（SDK:1779）、`setMcpServers()`（:2691）、`mcpServerStatus()`（:2564）、`toggleMcpServer()`（:2662）【读】。
  - ACP 的 `session/new` 必须带 `mcpServers`（ACP:1980），http 和 sse 要看 `mcpCapabilities`（:1763）【读】。Grok 声明了 http 和 sse（GF）【读】。
  - Cursor 文档说服务器从 `.cursor/mcp.json` 读，不支持团队级 MCP，没说 ACP 参数是否生效（CUR）【读】。
  - Pi 0.99.1 有 `pi mcp` 子命令（`pi --help`），RPC 里没有 MCP 配置【读】。Paseo 记 `supportsMcpServers:false`（P `providers/pi/agent.ts:163`）【读】。
- **命令。**
  - Codex 只有 `skills/list`（CX `ClientRequest.ts:83`）和输入类型 `UserInput.skill`【读】。`/compact` 和 `/goal` 是客户端命令。Paseo 把 compact、goal、skills 和本地 prompts 合成一个命令列表（P `providers/codex-app-server-agent.ts:5065-5101`）【读】。
  - Claude 有 `supportedCommands()`（SDK:2546）和 `commands_changed` 消息【读】。
  - ACP 有 `available_commands_update`（ACP:3063）【读】。
  - Pi 有 `get_commands`，来源分 extension、prompt、skill（PIR:135-147）【读】。

### 30 到 33 回退、review、后台、搜索

- **回退。**
  - Codex 用 `thread/rollback{numTurns}`，只回对话（CX `v2/ThreadRollbackParams.ts`）【读】。
  - Claude 用 `rewindFiles()`，需要 `enableFileCheckpointing`（SDK:2627，:1535）。对话侧用 `resumeSessionAt`（:1892）【读】。Paseo 三种回退都提供（P `providers/claude/agent.ts:2827-2852`；PA `components/rewind/rewind-menu.tsx`）【读】。
  - Pi 用 `fork` 和 `get_fork_messages` 分支对话（PIR:108，:115）【读】。
- **review。** Codex 有 `review/start`，目标可以是 uncommittedChanges、baseBranch、commit、custom（CX `v2/ReviewTarget.ts`）。对应的 ThreadItem 是 `enteredReviewMode` 和 `exitedReviewMode`【读】。Paseo 没有调用【读 grep】。Claude 的 `/review` 是否在 `supportedCommands()` 里未知。
- **后台任务。**
  - Claude 有 `background_tasks_changed`（SDK:3159）、`backgroundTasks()`（:2716）、`stopTask()`。`task_started.is_backgrounded` 和 `task_type` 区分 Bash 和子 agent【读】。
  - Grok 有 `task_backgrounded`、`task_completed` 和 `_x.ai/task/kill`（GD `grok-background-tasks.ts:182-192`，`grok-background-task-stop.ts:17-20`）【读】。
  - Codex 有 `process/outputDelta`、`process/exited`，`CommandExecutionSource` 含 unifiedExec 类（CX）【读】，但没找到 agent 后台进程的停止方法，记部分。
  - Pi 的 `bash` RPC 是客户端自己跑命令，不是 agent 的后台任务。
- **联网搜索。** Codex 有 `webSearch` 项【读】。Claude 有 WebSearch、WebFetch 工具（P `providers/claude/tool-call-detail-parser.ts:127-186`）【读】。Grok 有 `web_search`、`web_fetch` 工具（GF）【读】。Pi 默认开 read、bash、edit、write 四个工具，`--tools` 还接受 grep、find、ls（`pi --help` 0.99.1 的示例 `--tools read,grep,find,ls`），没有联网工具【读】。

### 34 到 39 权限、审批、登录、指令

- **读写和网络限制。** 详见 `/home/operator/vonvon/provider-redesign/paseo-and-vonvon-permissions.md`（JP-VPS 上的调研笔记，不在仓库里）。
  - Codex 的权限 profile 在 macOS（Seatbelt）上能限制读取，Linux 的 Landlock 不限读，Windows 未验证【读】。`SandboxPolicy` 有 readOnly 和 networkAccess（CX `v2/SandboxPolicy.ts`）【读】。
  - Claude 的 `sandbox.filesystem` 有 `denyRead`、`allowRead`、`allowManagedReadPathsOnly`、`denyWrite`，`network` 有 `allowedDomains`（SDK:2914-2936）【读】。沙箱只管 Bash。Read、Grep、Glob 要靠权限规则【读，见 `/home/operator/vonvon/provider-redesign/paseo-and-vonvon-permissions.md`】。
  - ACP 和 Pi 没有沙箱。Cursor 的 ask、plan 和 Grok 的 plan 模式是 agent 自己遵守的只读约定，不是 OS 隔离【推】。
  - Pi 只能用 `--tools` 或 `--exclude-tools` 裁掉 edit、write，bash 仍然能写【读 `pi --help`】。
- **审批。**
  - Codex 的 `ServerRequest` 有 commandExecution、fileChange、permissions 的 requestApproval，还有 `item/tool/requestUserInput`、`mcpServer/elicitation/request`、旧的 applyPatchApproval 和 execCommandApproval（CX `ServerRequest.ts:19`）【读】。
  - Claude 用 `canUseTool`（SDK:1431）【读】。
  - ACP 用 `session/request_permission`（ACPI:23）【读】。
  - Cursor 另有阻塞的 `cursor/create_plan` 和 `cursor/ask_question`。文档警告不回应会卡住工具执行（CUR）【读】。daemon 必须自动应答这两个，否则回合挂起。
  - Pi 只有扩展发起的 `extension_ui_request`，方法有 select、confirm、input、editor、notify、setStatus、setWidget、setTitle（PIR:407-458）【读】。
- **登录。**
  - Codex 用 `account/read`，回包有 `account` 和 `requiresOpenaiAuth`，另有 `getAuthStatus` 和 `account/updated`（CX `v2/GetAccountResponse.ts`）【读】。
  - Claude 用 CLI `claude auth status`（P `providers/claude/agent.ts:1789`），流里有 `auth_status` 消息（SDK:3147）【读】。
  - Cursor 用 `authenticate` 加 `methodId:"cursor_login"`（CUR）【读】。"是否已登录"没有协议查询。Vonvon 计划读本地 `cli-config.json`（`git show 9612fb0:docs/plan.md` 第 1546 行，在未合入的分支 `claude/v7-provider-priority` 上）【读】。
  - Grok 的 `authMethods` 有 `cached_token` 和 `grok.com`，未登录时 `session/new` 返回 -32000（GF；`git show 9612fb0:docs/plan.md` 第 1547 行）【读】。
  - Pi 用 `pi auth check --json`（`pi auth --help`）【读】。
  - ACP 有 `authMethods` 和 `authenticate`，错误码含 -32000（ACP:210，:1233）【读】。
- **指令注入。**
  - Codex 有 `developerInstructions`、`baseInstructions`（CX `v2/ThreadStartParams.ts:16`），Vonvon 已在用（VB:675）【读】。
  - Claude 有 `systemPrompt`（SDK:2145）【读】。
  - Pi 有 `--system-prompt` 和 `--append-system-prompt`，只能在启动时设【读】。
  - ACP 基础协议没有指令字段（ACP:1976-1980 只有 cwd、mcpServers）【读】。

### 40 到 44 额外能力

- **提问。** Codex 有 `item/tool/requestUserInput`【读】。Claude 有 `onUserDialog`（SDK:1607）【读】。Cursor 有 `cursor/ask_question`【读】。Grok 有 `x.ai/ask_user_question`（GD `grok-requests.ts:128`）【读】。产品不做交互卡，daemon 要自动应答，例如回 skipped 或 cancelled。
- **重试。** Codex 是 `ErrorNotification.willRetry`（CX `v2/ErrorNotification.ts`）【读】。Claude 是 `api_retry`（SDK:3071）【读】。Grok 是私有的 `retry_state`（GD `grok-dialect.ts:25`）【读】。Pi 是 `auto_retry_start` 和 `auto_retry_end`（PIS:79-89）【读】。卡片可以显示"正在重试 2/3"。
- **整回合 diff。** Codex 有 `turn/diff/updated`（CX `ServerNotification.ts:72`）【读】。
- **结构化输出。** Codex 有 `TurnStartParams.outputSchema`（:45），Claude 有 `outputFormat`（SDK:1797）【读】。
- **hooks。** Codex 有 `hook/started` 和 `hook/completed`。Claude 有 `hooks` 选项。Grok 有 `hook_execution` 和 `hook_run_started`（GF）【读】。

## Paseo 聊天模式参考

### 时间线条目类型

定义在 P `agent-sdk-types.ts:390-403`，app 的分发在 PA `agent-stream/view.tsx:866-893`，归一化在 PA `types/stream.ts:1530-1580`【读】。

| 条目 | app 怎么显示 |
|---|---|
| `user_message` | 用户气泡 |
| `assistant_message` | Markdown 回答。provider 图片也走这里，以 markdown 图片出现 |
| `reasoning` | 归一成 `thought`，可折叠的思考块 |
| `tool_call` | 工具行，状态有 running、completed、failed、canceled。可展开 detail，连续调用可合并成组（`OverviewToolCallGroupView`） |
| `todo` | 归一成 `todo_list`，用 `TodoListCard` 显示勾选清单（PA `components/message.tsx:2267`） |
| `error` | 归一成 error 级 `notification` |
| `notification` | info、warning、error 横条（`Notification`） |
| `compaction` | `CompactionMarker`，显示 loading 或 completed、trigger、preTokens（PA `components/message.tsx:2212`） |
| `plugin` | 插件自定义视图 `PluginTimelineItemView` |

时间线之外的流事件（P `agent-sdk-types.ts:405-461`）还有：
- `turn_started`、`turn_completed`、`turn_failed`、`turn_canceled`，app 用它们结束思考块并更新状态。
- `usage_updated`，喂给输入框的上下文用量表（PA `composer/index.tsx:2037`）。
- `mode_changed`、`model_changed`、`thinking_option_changed`，喂给输入框的控件。
- `permission_requested`、`permission_resolved`，生成审批卡（PA `agent-stream/view.tsx:1416` 起，含 plan 和 question 两种）。
- `attention_required`。
- `provider_subagent`，喂给子 agent 轨道和面板。

### 工具 detail 类型

定义在 P `agent-sdk-types.ts:239-336`，渲染在 PA `components/tool-call-details.tsx:676-745`【读】。

| detail | app 怎么显示 |
|---|---|
| `shell` | 命令和输出（`ShellDetailSection`） |
| `read` | 文件内容，带起始行号（`ScrollableTextSection`） |
| `edit` | diff 行（`EditDetailSection`） |
| `write` | 写入内容 |
| `search` | 查询、匹配文件、网页结果（`buildSearchSections`），`toolName` 区分 grep、glob、web_search |
| `fetch` | URL 和结果（`FetchDetailSection`） |
| `worktree_setup` | Paseo 自己的 worktree 初始化日志，与 provider 无关 |
| `sub_agent` | 子 agent 类型、描述、动作行、日志（`SubAgentDetailSection`，:299-353） |
| `plain_text` | 纯文本块 |
| `plan` | 计划卡（PA `components/message.tsx:3180`） |
| `unknown` | 原始 input 和 output JSON |

### 各 provider 在 Paseo 里发出的类型

由 JP-VPS 上一次性的 grep 脚本扫各 provider 文件得到，脚本没有保留，数字是首次出现的行号【读】。

- **Codex**（`providers/codex-app-server-agent.ts`）发出 user_message、assistant_message、reasoning、tool_call、todo（1107）、compaction（2019）、plan detail（1140），以及 turn 和 usage 各事件、permission、provider_subagent（5888）。detail 由 `codex/tool-call-mapper.ts` 生成，有 shell、edit、search、sub_agent、unknown。能力位是 `supportsDynamicModes:false`、`supportsRewindConversation:true`、`supportsRewindFiles:false`（:232-241）。
- **Claude**（`providers/claude/agent.ts`）发出 assistant_message、reasoning、tool_call、compaction（4452）、sub_agent（5953）、provider_subagent（2130）、mode_changed、thinking_option_changed。todo 来自 `task-state.ts`。三种回退都开（:324-333）。
- **ACP**（`providers/acp-agent.ts`，Cursor 和 Grok 共用）发出 todo（来自 plan，3691）、shell、read、edit、search、fetch、plain_text、unknown、mode_changed、model_changed、thinking_option_changed。没有 compaction，没有子 agent，没有图片。不能回退（:269-278）。
- **Pi**（`providers/pi/agent.ts`）发出 compaction（1800）、notification（2019）、error（2235）、tool_call，permission 来自扩展 UI。没有 todo、子 agent、图片。只能回退对话（:159-168）。

### Paseo 自己合成的东西

这些不是 provider 原生给的。按用户规则，Vonvon 不照搬。

1. **会话标题。** 新会话的临时标题从首条提示截出（P `create-agent-title.ts:22-45`）。工作区标题另起一轮结构化 agent 回答生成（`/home/operator/vonvon/references/paseo-0009/packages/server/src/server/workspace-auto-name.ts:135`）【读】。Claude 和 Grok 原生生成的标题，Paseo 都没用。
2. **ACP 取消时的工具状态。** `synthesizeCanceledToolCalls()` 把还在运行的工具行改成 canceled（P `providers/acp-agent.ts:3259`）【读】。provider 没有发这些状态。
3. **ACP 结束原因被并掉。** refusal、max_tokens、max_turn_requests 被并进 `turn_completed`，`turn_canceled.reason` 写死为 "Interrupted"（P `providers/acp-agent.ts:3256-3275`）【读】。这不是合成，但丢了原生信息。
4. **Codex 的 `/goal` 和 `/compact` 回显。** 结果以 Paseo 写的 assistant 文字显示（P `providers/codex-app-server-agent.ts:5103-5130`）【读】。goal 的进度通知没有接。
5. **Codex 的命令列表。** compact 和 goal 两条是 Paseo 写死的，再拼上 skills 和本地 prompt 文件（:5065-5101）【读】。
6. **账户用量。** 来自插件化的 usage source，不走 provider 协议（P `../plugins/usage-sources/index.ts`）【读】。
7. **`attention_required`。** Paseo 自己生成的通知事件（P `agent-sdk-types.ts:452`）【读】。

以下属于把原生信号换一种形式表示，不算模拟。图片转成 markdown 后显示（P `providers/provider-image-output.ts:172`）。Claude 的 TodoWrite 和 Task* 工具折叠成 todo（P `providers/claude/task-state.ts`）。Codex 的子 thread 归入父会话的子 agent 轨道。

### Paseo 没有呈现的原生能力

这些是 Vonvon 超过 Paseo 下限的机会，都有原生依据：
- 单个子 agent 的停止：Claude `stopTask`、Grok `_x.ai/subagent/cancel`。
- Cursor 的 `cursor/task`、`cursor/update_todos`、`cursor/generate_image`。
- Grok 的子 agent、后台任务、自动标题、`turn_completed` 结束原因。
- Codex 的 `thread/goal/updated` 进度、`review/start`、`account/rateLimits/*`、`turn/diff/updated`。
- Claude 的 `rate_limit_event`、`api_retry`、自动标题、后台任务。
- Pi 工具结果里的图片。
- ACP 的 refusal、max_tokens 结束原因。

## 未知格和定案实测

这些实测由 Mac 上的 Codex 跑。每项都只需记录原始 JSON 行，不需要改产品代码。

1. **Cursor 的 initialize。** 抓 `cursor-agent acp` 的 `initialize` 回包，看 `loadSession`、`promptCapabilities.image`、`sessionCapabilities` 下的 list、fork、resume。可以定下第 3、4、17 行的 Cursor 格。
2. **Cursor 跑一个带工具、子 agent 和生图的回合。** 记录有没有 `agent_thought_chunk`、`usage_update`、`PromptResponse.usage`、`session_info_update`，以及工具 kind 的实际取值。再记录 `cursor/task`、`cursor/update_todos`、`cursor/generate_image` 的负载。还要看 `available_commands_update` 里有没有 compact，以及 `configOptions` 里有没有推理强度。可以定下第 7、13、14、16、19 到 22、25、27、33 行。
3. **Grok 跑三个回合。** 第一个让它用 `todo_write`，看会不会发 ACP `plan`。第二个用 `image_gen`，看结果怎么回传。第三个在回合进行中再发一次 `session/prompt`，看是排队（`queue/changed`）还是插入。另外看有没有推理块，有没有 compact 命令，用什么方法设推理强度。可以定下第 7、9、15、16、19、20、25 行。
4. **Codex 的标题。** 新开 thread，跑一轮，不调 `thread/name/set`，看会不会收到 `thread/name/updated`。可以定下第 27 行 Codex 的"生成"。
5. **Claude 的 goal 和 review。** 在流式模式下发 `/goal <条件>`，看原始流里有没有 `type:"active_goal"`。同时看 `supportedCommands()` 里有没有 goal、review、compact。可以定下第 18、31 行 Claude 格，也能确认第 19 行。
6. **Codex 的后台进程。** 让 agent 起一个长时间的 unified exec 进程，看有没有原生停止办法。可以定下第 32 行 Codex 格。
7. **Claude 的读限制。** 在 qa 档配置下，同时设 `sandbox.filesystem.denyRead`、`allowManagedReadPathsOnly`，以及 Read、Grep、Glob 的 deny 规则，在三个系统上测"读 `~/.ssh` 被拒"。这一项沿用 `/home/operator/vonvon/provider-redesign/paseo-and-vonvon-permissions.md` 的结论。可以定下第 34 行 Claude 格。

## 各 provider 缺的能力（按原生判定）

- **Codex。** 缺单个子 agent 的专门停止方法，只能对子 thread 发 interrupt。缺文件回退。会话标题能否自动生成未知。读限制只在 macOS 成立。没有原生 goal 以外的缺口。
- **Claude Code。** 工具调用没有协议级分类，todo 没有专门事件，两者都靠工具名。不能生图。账户限额只能在回合中收到，不能主动查。沙箱只管 Bash。goal 未知。
- **Cursor。** 缺 steer、goal、回退、沙箱、指令注入、协议内账户用量。会话列表、分叉、推理、压缩、用量、标题、图片输入都未知。子 agent、todo、生图是 `cursor/*` 扩展，不是 ACP 基础协议。
- **Grok。** 缺图片输入（1.0.46 声明为 false）、分叉、goal、回退、沙箱、协议内账户用量。steer、推理、todo、生图结果、压缩、强度设置未知。子 agent、后台任务、结束原因、用量是 `x.ai` 扩展。
- **Pi。** 缺子 agent、todo、goal、review、后台任务、联网搜索、沙箱、账户用量、模式、协议内 MCP 配置。标题能读能设，不能生成。图片输出只来自工具结果。
- **自定义 ACP。** 只能依赖基础协议，缺 steer、子 agent、goal、压缩、回退、review、后台任务、沙箱、指令注入、账户用量。分叉、resume、模型、用量是不稳定接口，按 agent 声明开关。
