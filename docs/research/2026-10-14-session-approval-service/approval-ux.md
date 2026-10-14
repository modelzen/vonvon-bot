# 飞书里的"需要用户确认"：和 agent 自带的审批一致，用户可以设成完全访问

2026-10-14，基于 vonvon-bot `main` 的 `2c60ea0`。只读调研，没有改仓库。

> 文中的 `r3/fs/`、`fsdocs/`、`codex-approvals.md`、`permission-modes.md` 这类路径，是调研时存在本机的文档副本，没有存进仓库，原文在飞书开放平台和各家官网。Codex 源码指本机的 0.162.1 快照 `codex-rs/`。

## 结论

1. owner 要的东西，两个 agent 都已经有现成的模型：Codex 有"审批策略 + 沙箱"两件套，界面上合成三个预设（只读、默认、完全访问）；Claude Code 有一组权限模式（手动、自动接受编辑、计划、自动、跳过权限）和 `canUseTool` 回调。两边的"完全访问"都是"从不问"。所以 vonvon 不用自己发明一套规则：用户选一个档，vonvon 把它换算成两个 agent 的原生设置，agent 自己决定什么时候问，vonvon 只负责把"问"变成飞书卡片，再把点击送回去。
2. 今天 v2 两边都不问。Codex 写死了 `approvalPolicy: 'never'`（`D/agent/codex-appserver/backend.ts:30`），Claude 三档都用 `bypassPermissions`（`D/agent/claude-agent/permission.ts:56`、`:73`），代码里没有任何 `canUseTool`。Codex 发来的服务端请求一律回报错（`D/provider/transport/jsonrpc.ts:197-206`），所以连 Codex 在计划模式下的提问也收不到。`docs/product.md` 3.8 写的"agent 自己的工具调用不弹审批"要按 owner 这次的话改掉。
3. 推荐的设置：一个权限档（只读 / 读写 / 完全访问）加一个开关"超出权限时：问我 / 直接拒绝"。完全访问时这个开关隐藏，含义就是"从不问"。新 bot 默认"读写 · 问我"，和 Codex 默认预设、Claude 的"自动接受编辑"对应。bridge 迁来的群换算成"直接拒绝"，行为和今天一样。
4. 推荐的卡片：授权卡、选项卡、确认卡用同一种版面和同一套状态（待确认 → 谁在几点点了什么 → 超时 / 已停止 / 已失效）。授权卡的按钮是［允许］［本会话不再问］［拒绝］，回复这张卡等于拒绝并附上说明，运行卡上的 ⏹ 等于拒绝并停止。不给"以后都允许"这类会写进用户全局配置的选项。
5. 越权的授权卡只有主人和管理员能点。访客永远批不了自己的越权，访客档默认"直接拒绝"。选项卡由发起人回答，管理员也能代答。
6. 今天的咖啡一下卡片有三个问题，新卡片要避开：用户看不懂按钮（社区群 #518、#566、#580）；超时后按钮还挂着（`D/cli-bridge/service.ts:391-399`）；不检查是谁点的（`D/cli-bridge/service.ts:505-516`）。
7. 有几处只能在 Mac 上验证，最要紧的是：Codex 在"按需审批 + vonvon 自定义沙箱 profile"下越权时会不会真的发审批请求；Claude 从 `bypassPermissions` 换到 `acceptEdits` 加 `canUseTool` 后实际会问哪些事。另外，今天 Claude 只读和读写档下的关网、写文件限制可能有缺口（推断，见 3.3），这次改动正好能补上。

## 0. 约定

- `D/` 指 `packages/daemon/src/`。行号以 `2c60ea0` 为准。
- Codex 源码指 0.162.1 的快照 `codex-rs/`（本机副本）。Claude SDK 指 `@anthropic-ai/claude-agent-sdk` 0.3.296 的 `sdk.d.ts` 和 `sdk-tools.d.ts`（vonvon 声明的是 `^0.3.178`）。Paseo 指本机参考仓库 `paseo-0009` 的 `0009a7e7`。bridge 指 feishu-codex-bridge 0.6.14（`6698118`）。
- Claude SDK 从另一棵 worktree 的 `node_modules` 读。
- 线上文档的本地副本：Codex 的 agent-approvals-security 存为本机的 `codex-approvals.md`；Claude 的 sdk-user-input、sdk-permissions、permission-modes、sandboxing、settings-reference 存为同名 `.md`；飞书卡片回调文档存在 `r3/fs/`。
- 每条事实后面标来源。没写状态的是已核实（读过代码或文档原文）；写"推断"的是从代码推出来、没跑过；写"未知"的是没查到。

## 1. Codex 自己的审批体验

### 1.1 两件套和三个预设

- 审批策略 `AskForApproval` 有四个值：`untrusted`、`on-request`、`granular{sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}`、`never`（`codex-rs/app-server-protocol/src/protocol/v2/shared.rs:206-224`）。线上文档说 `untrusted` 已经退役（`codex-approvals.md:17-19`）。
- 沙箱 `SandboxMode` 有三个值：`read-only`、`workspace-write`、`danger-full-access`（`v2/shared.rs:335`）。审批人 `ApprovalsReviewer` 可以是 `user` 或 `auto_review`（`v2/shared.rs:274`）。
- 界面上的三个预设（`codex-rs/utils/approval-presets/src/lib.rs:28-60`）：
  - Read Only：`read-only` + `on-request`；
  - Default（id 是 `auto`，注释写 "Identical to Agent mode"）：`workspace-write` + `on-request`；
  - Full Access：`never` + `danger-full-access`。
- TUI 的权限菜单还有"Ask for approval"和"Approve for me"两个审批人标签，后者就是 `auto_review`（`codex-rs/tui/src/chatwidget.rs:459-460`；`permissions_menu.rs:170-174`）。文档说自动审会多花用量（`codex-approvals.md`）。
- 默认预设下，要改工作区以外的文件或者要联网时才问（`codex-approvals.md`）。`workspace-write` 下 `.git`、`.agents`、`.codex`、`.aws` 是只读的（`codex-approvals.md:293-298`）。`never` 可以和任何沙箱搭配（`codex-approvals.md`，常见组合表在 `:357-363`）。

### 1.2 app-server 发给客户端的请求

app-server 把"要问用户"的事做成服务端请求，客户端回什么，agent 就按什么走（`codex-rs/app-server-protocol/src/protocol/common.rs:1780-1849`）。

| 请求 | 什么时候来 | 客户端能回什么 | 来源 |
|---|---|---|---|
| `item/commandExecution/requestApproval` | 命令要越出沙箱，或要联网 | `accept`、`acceptForSession`、`acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`、`decline`（回合继续）、`cancel`（回合也中断） | `v2/item.rs:66-88` |
| `item/fileChange/requestApproval` | 改文件要越权 | `accept`、`acceptForSession`、`decline`、`cancel` | `v2/item.rs:115-124` |
| `item/permissions/requestApproval` | agent 主动申请更多权限 | `{permissions, scope: turn 或 session, strictAutoReview}` | `v2/permissions.rs:773-808` |
| `item/tool/requestUserInput`（实验） | agent 问带选项的问题 | `answers: {题目id: {answers: [...]}}` | `v2/item.rs:1755-1830` |
| `mcpServer/elicitation/request` | MCP 工具要审批，或 MCP 服务器要用户填表、打开网址 | `{action: accept/decline/cancel, content, _meta}` | `v2/mcp.rs:380-384`、`:420`、`:787-840`、`:901` |
| `item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`currentTime/read` | 动态工具和账号、时间之类 | 和审批无关 | `common.rs:1780-1849` |
| 旧的 `applyPatchApproval`、`execCommandApproval` | 老协议 | | 同上 |

请求被处理完（包括被别处处理掉）时，app-server 发 `serverRequest/resolved` 通知，带 `threadId` 和 `requestId`（`common.rs:1997`；`v2/notification.rs:74-77`）。

命令审批的参数里有：`kind`（command 或 writeStdin）、`threadId`、`turnId`、`itemId`、`approvalId`、`reason`、`networkApprovalContext{host, protocol}`、`command`、`cwd`、`commandActions`、`proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments`，以及实验字段 `additionalPermissions`、`availableDecisions`（`v2/item.rs:1555-1617`）。文件改动审批只带 `reason` 和不稳定的 `grantRoot`（`v2/item.rs:1638-1653`），改了哪些文件要按 `itemId` 去对应的 fileChange item 里找（推断）。

`request_user_input` 的题目结构：`{id, header, question, isOther, isSecret, options[{label, description}]}`，外加 `isBlocking`（`v2/item.rs:1755-1830`）。

### 1.3 TUI 里的选项文案

这是"和 agent 一致"最直接的参照（`codex-rs/tui/src/bottom_pane/approval_overlay.rs`）：

- 命令（`:832-917`）："Yes, proceed"；联网时 "Yes, just this once"；"Yes, and don't ask again for commands that start with `x`"；"Yes, and don't ask again for this command in this session"；"Yes, and allow this host for this conversation"；"Yes, and allow this host in the future"；"No, and block this host in the future"；"No, continue without running it"；"No, and tell Codex what to do differently"。
- 文件改动（`:1015-1033`）、权限申请（`:1036-1066`，含 "grant for this turn with strict auto review"）。
- MCP 表单（`:1074-1107`）："Yes, provide the requested info"、"No, but continue without it"、"Cancel this request"。
- 子 agent 发起的审批会标上线程名，例如 "Robie [explorer]"（`:1593`）。

可以看出 Codex 的选项分三层：只这一次、本会话、以后都（写进规则）。"以后都"会改用户自己的 Codex 规则，在飞书群里不该给（见 6.3）。

### 1.4 谁先处理、`never` 时会怎样

- 处理顺序：先跑 PermissionRequest hook，再跑 guardian / 自动审，最后才问用户（`codex-rs/core/src/tools/approvals.rs:479-525`）。用户自己配的 hook 可能在 vonvon 看到之前就批掉或拒掉（推断）。
- `never` 下，需要问的提示直接被拒（`codex-rs/core/src/exec_policy.rs:216-238`）；`request_permissions` 返回空授权（`codex-rs/core/src/session/mod.rs:2912-2958`）。这个工具受 feature `request_permissions_tool` 控制，状态 UnderDevelopment，默认关（`codex-rs/features/src/lib.rs:1303-1307`）。
- 客户端回报错时，Codex 都按失败处理，偏安全：`request_user_input` 当作空答案（`codex-rs/app-server/src/bespoke_event_handling.rs:1652-1667`），elicitation 当作 Decline（`:1777-1783`），文件改动审批当作 denied "approval request failed"（`:1947-1951`）。
- Codex 内部把审批超时映射成 Decline（`v2/item.rs:103`）。Codex 本身没有给客户端设审批的等待上限（推断：没找到）。

### 1.5 MCP 工具

- MCP 工具的审批走 elicitation（`v2/item.rs:91-93` 的注释）。
- 没有注解的工具默认要审批，`destructive` 缺省当作 true（`codex-rs/core/src/mcp_tool_call.rs:2461-2478`）。审批模式有 Auto / Prompt / Writes / Approve（`mcp_tool_call.rs:2480-2491`；`codex-rs/config/src/mcp_types.rs:28-34`），可以按服务器配 `default_tools_approval_mode`（`mcp_tool_call.rs:1258-1302`）。
- 审批选项是 "Allow"、"Allow for this session"、"Allow and don't ask me again"、"Cancel"（`mcp_tool_call.rs:1457-1461`）。
- `never` 下要审批的 MCP 调用返回 denied，文案 "MCP tool call requires approval, but approval policy is never"（`mcp_tool_call.rs:1615-1619`）。`approval_mode = Approve`，或者 `never` 加全盘可写时，自动批准（`codex-rs/codex-mcp/src/mcp/mod.rs:91-110`）。
- 所以（推断）：今天 vonvon 的只读、读写档（`never` + 自定义沙箱）下，没有 `readOnlyHint` 的 MCP 工具在 Codex 上会被拒；完全访问档能用。`docs/product.md` 第 9 节第 2 条打算在连不上 daemon 时改用 vonvon 自己的 MCP 工具，这条会受影响。给 vonvon 装的 MCP 配 `approve` 可以绕开。

### 1.6 提问只在计划模式下有

`request_user_input` 只在 Plan 模式可用，除非打开 feature `default_mode_request_user_input`（UnderDevelopment，默认关）（`codex-rs/features/src/lib.rs:1739-1743`；`codex-rs/tools/src/tool_config.rs:17-25`；`request_user_input_spec.rs:91-103`）。它和审批策略无关，完全访问下也会问。咖啡一下的代码注释也写了这点（`D/cli-bridge/service.ts:335-340`）。

### 1.7 中途改设置

`turn/start` 可以带 `approvalPolicy`、`approvalsReviewer`、`sandboxPolicy` 和实验的 `permissions`（命名 profile），对这一轮和之后的轮都生效（`v2/turn.rs:227-242`）。所以改档不用重开会话（推断：没跑过）。

## 2. Claude Code / Agent SDK 自己的审批体验

### 2.1 权限模式

- SDK 的 `PermissionMode`：`default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto`（`sdk.d.ts:2503`）。不传时默认 `auto`（`sdk.d.ts:1985-1999`）。`bypassPermissions` 要同时传 `allowDangerouslySkipPermissions`（`sdk.d.ts:2011`）。
- 界面上的叫法：CLI 状态栏是 "manual mode on / accept edits on / plan mode on / auto mode on / don't ask on / bypass permissions on"（`permission-modes.md:146`）；VS Code 是 Manual / Edit automatically / Plan / Auto / Bypass permissions（`permission-modes.md:183-190`）；Manual 就是 `default`（`permission-modes.md:25`）。
- `dontAsk` 拒掉一切没预先允许的调用，包括 AskUserQuestion（`permission-modes.md:557`）。`auto` 模式在 SDK 里直接拒掉删除关键路径（`permission-modes.md:750-760`）。

### 2.2 `canUseTool` 怎么被调用

- 评估顺序（`sdk-permissions.md:21-50`）：hooks → deny 规则 → ask 规则（`bypassPermissions` 下也问）→ AskUserQuestion 和 `requiresUserInteraction` 的工具一定走回调 → 权限模式 → allow 规则 → `canUseTool`。自动批准的调用不会走到回调（`sdk-user-input.md:11`、`:52`、`:55`）。
- 任何模式都不会自动批准的几类（`permission-modes.md:33-43`）：ask 规则、组织设成 ask 的 connector、AskUserQuestion 和 `requiresUserInteraction` 的 MCP 工具、删除关键路径的 `rm`/`rmdir`、跨会话消息。
- 回调拿到的选项（`sdk.d.ts:217-300`）：`signal`、`suggestions`（`PermissionUpdate[]`，用户选"始终允许"时整组原样放进 `updatedPermissions` 返回）、`blockedPath`、`mcpServer{name, source}`、`decisionReason`、`title`、`displayName`、`description`、`defaultToNo`、`suppressAlwaysAllowRule`、`toolUseID`、`agentID`（子 agent）、`requestId`、`matchedAskRule`。
- 返回值（`sdk.d.ts:2526-2539`）：`allow{updatedInput, updatedPermissions, decisionClassification}` 或 `deny{message, interrupt}`。
- `PermissionUpdate` 可以加、换、删规则，切模式，加、删目录（`sdk.d.ts:2545-2573`）；`destination` 可以是 `userSettings`、`projectSettings`、`localSettings`、`session`、`cliArg`（`sdk.d.ts:2574`）。
- 权限提示没有等待上限，回调不返回就一直卡着（`sdk.d.ts:210-216`）。`askUserQuestionTimeout` 默认不超时（`sdk.d.ts:9113`），另有 `dialogExpiry`（`sdk.d.ts:9117`）。
- 没有 `canUseTool` 时，需要"问"的调用直接终止，SDK 发 `SDKPermissionDeniedMessage`（`sdk.d.ts:5574`）。
- `setPermissionMode()` 能在运行中切模式，只在 streaming input 模式下可用（`sdk.d.ts:2886`）。vonvon 的 Claude 会话正好是一条常驻的 streaming input `query()`（`D/agent/claude-agent/thread.ts:222-231`、`:281`）。

### 2.3 提问、计划和 MCP 表单

- AskUserQuestion：1 到 4 题，每题 2 到 4 个选项，`header` 不超过 12 字，可以多选，选项可以带预览（`sdk-tools.d.ts:2680-2697`）；答案通过 `updatedInput` 里的 `answers` 送回（`sdk-tools.d.ts:1131` 起），输出带 `answers` 和 `response`（`sdk-tools.d.ts:3954-3970`）。预览格式由 `toolConfig.askUserQuestion.previewFormat` 控制（`sdk.d.ts:1700-1709`、`:9832-9843`）。自定义工具列表时要把 AskUserQuestion 包含进去（`sdk-user-input.md:416`）；子 agent 里不能用（`sdk-user-input.md:824`）。
- ExitPlanMode：计划文字在 `input.plan`（`sdk-tools.d.ts:843`）。vonvon 现在把它显示成"提交方案"（`D/agent/claude-agent/event-map.ts:262`）。
- MCP 表单走 `onElicitation`，不提供就自动 decline（`sdk.d.ts:1740-1756`）。请求里有 `serverName`、`message`、`mode`（form 或 url）、`url`、`elicitationId`、`requestedSchema`、`title`、`displayName`、`description`（`sdk.d.ts:722-742`）。

### 2.4 沙箱和权限模式是两回事

- Claude 的沙箱只管 Bash：默认几乎全盘可读，网络走代理加允许的域名（`sandboxing.md:29-34`）。Read、Edit、Write、WebFetch，以及本地 MCP 服务器和 hooks，都在沙箱外面跑，由权限模式管（`sandboxing.md:38-51`）。
- 不进沙箱的重试：`bypassPermissions` 不问就跑；Manual 和 `acceptEdits` 弹 "Bash command (unsandboxed)"（`sandboxing.md:214-230`）。
- 访问不在允许名单里的主机：`bypassPermissions` 下放行，除非开了 `strictAllowlist` 或 `allowManagedDomainsOnly`；Manual 和 `acceptEdits` 会问；`dontAsk` 拒（`sandboxing.md:585-596`）。`strictAllowlist` 的作用域是 "User or managed"（`settings-reference.md:2642-2660`）；SDK 能通过 `managedSettings` 强制收紧（`sdk.d.ts:2240-2258`、`:3461-3496`）。

## 3. v2 今天怎么做

### 3.1 权限档和网络

- 三档 `qa | write | full`，默认 `write`（`D/agent/types.ts:20-35`）。项目上有 `mode`、`guestMode`、`network`（`D/project/registry.ts:42`、`:47`、`:50`）。老数据没写 `mode` 时按 `full` 算（`D/project/registry.ts:93-95`）。
- 访客档：`turnTier` 在设了不同访客档时，管理员和访客各走一条会话（`D/project/registry.ts:115` 起；调用在 `D/bot/handle-message.ts:1240`）。
- 并发上限默认 10（`D/config/schema.ts:227-230`）。空闲超时默认 120 秒（`D/config/schema.ts:318`），product.md 3.12 要改成 10 分钟。

### 3.2 Codex 一侧

- `APPROVAL_POLICY = 'never'`（`D/agent/codex-appserver/backend.ts:30`），开会话和恢复会话都传它（`:673`、`:687`），连接池也是（`client-pool.ts:230`）。
- 沙箱（`backend.ts:73-100`）：完全访问用 `danger-full-access`；只读、读写用自定义 profile `feishu`（只读挂 `:minimal`，读写挂 `:workspace_roots`，再加 `network.enabled`）；不是 macOS 或 Windows 时直接抛错（`:78-82`）。所以 Linux 上今天只有完全访问档能跑 Codex。owner 说 Linux 上可能只装 daemon，这一点和审批卡无关，但要单独处理。
- 连接只设了 `onNotification` 和 `onInvalidFrame`，没有 `onRequest`（`D/provider/transport/jsonrpc.ts:277`、`:280`），所以 Codex 发来的所有服务端请求都回 `-32601 'not handled'`（`jsonrpc.ts:197-206`）。初始化时开了 `experimentalApi: true`（`:316-320`）。
- 事件类型里给审批留了位置：`approval_request`，注释写"L-1 审批转发切片"（`D/agent/types.ts:153-158`）；能力位 `capabilities.approvals`（`types.ts:401-403`）。

### 3.3 Claude 一侧

- `permission.ts:47-78`：完全访问用 `bypassPermissions` + `allowDangerouslySkipPermissions`；只读、读写也用 `bypassPermissions`，加沙箱 `{enabled, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false}`；只读再加 `denyWrite: [cwd]`，去掉 Write、Edit、NotebookEdit；关网时去掉 WebFetch、WebSearch。注释承认读取没有关在 cwd 里，Bash 断网是"尽力而为"（`permission.ts:27-32`）。
- 代码里没有 `canUseTool`，也没有 `onElicitation`（grep 结果为零；`thread.ts:272` 的注释提到了 `canUseTool`，但没有传）。`backend.ts:206` 报 `approvals: false`。设置来源是 `['user', 'project']`（`backend.ts:48`），用户自己的 Claude 设置和仓库里的 `.claude` 设置都会生效。
- 由 2.2 和 2.4 推出的三个缺口（推断，要在 Mac 上测）：
  - 关网时 Bash 可能仍能连任意主机，因为 `bypassPermissions` 下不在名单里的主机放行（`sandboxing.md:585-596`）。可以用 `managedSettings` 开 `strictAllowlist` 补。
  - 读写档下 Edit、Write 在沙箱外跑，`bypassPermissions` 不拦，可能写到 cwd 外面。
  - 今天 Claude 会话里的 AskUserQuestion 会被拒，因为没有 `canUseTool`（`sdk.d.ts:5574`）。

### 3.4 咖啡一下已有的卡片

咖啡一下把电脑上 CLI 的审批转到主人私聊（`D/cli-bridge/service.ts:88-89`），是 v2 里唯一已有的审批卡片。

- 审批卡按钮：✅ 允许 / 🔁 始终允许 / ⛔ 拒绝（`D/cli-bridge/cards.ts:253-259`）；状态 pending / approved / denied / timeout / local（`cards.ts:45`、`:240-244`）；命令截到 3000 字（`cards.ts:118-120`）。
- 问题卡是一个表单：每题一个下拉框加一个自定义文本框，一个"✅ 提交"（`cards.ts:282-336`）。只支持 Claude（`service.ts:335-340`）。空提交时卡片保持可点（`service.ts:453-454`）。答案保留原题目再加 `answers`（`service.ts:456-461`）。
- "始终允许"其实是存在内存里的会话缓存（`service.ts:67`、`:410-416`）。拒绝带 `interrupt: true`（`service.ts:418-423`）。
- 回到电脑上处理时，卡片收成"已转交本机"（`service.ts:364-366`、`:396-398`）。
- 超时后卡片不更新，按钮还挂着（`service.ts:391-399`，超时返回 `fallback_local`，`D/cli-bridge/store.ts:108-113`）。只存在内存（`store.ts:28-34`），25 小时清理（`store.ts:41`）。超时默认 86400 秒，回复窗口 600 秒，允许缓存（`D/config/schema.ts:483-494`）。
- 点击处理不检查是谁点的（`service.ts:505-516`）。在私聊里问题不大，搬进群里就不行。

### 3.5 卡片点击的通用做法

- 卡片回调只走长连接（`D/card/dispatcher.ts:22-27`）；分发器不统一检查点击人，只记点击人的尾号（`dispatcher.ts:43-73`）。
- `/model`、`/resume` 的待确认只认原发起人，30 分钟过期（`D/bot/handle-message.ts:2233`、`:2300-2321`）。
- 卡片点击后要等飞书的交互窗口过去再改卡，`CARD_SETTLE_MS = 500`（`handle-message.ts:2244-2255`、`:2268`）。原因是 SDK 把回调处理函数的返回值丢掉了，回不了 toast，也回不了新卡片（`handle-message.ts:2384-2397` 的注释；SDK 1.71.1 的 `lib/index.js:99588-99598`，执行完处理函数返回 `undefined`）。
- ⏹ 只有发起人或管理员能点（`handle-message.ts:2372-2382`）；别人点了，回贴一条去重的小注（`:2384-2397`）。点到已经没了的运行卡时自愈（`healDeadRunCard`，`:2398` 起）。领文件也要发起人或管理员（`:2225-2231`）。
- `isAdmin`、`isChatAllowed`、`isUserAllowedInProject` 在 `D/config/schema.ts:349`、`:334`、`:358`。多选下拉要飞书客户端 7.4 以上（`D/card/cards.ts:595-599`）。

## 4. Paseo 怎么做（同时接两个 agent 的参照）

- Claude 模式：Plan Mode、Always Ask（default）、Accept File Edits、Auto mode、Bypass；Bedrock、Vertex 下没有 Auto（`packages/server/src/server/agent/providers/claude/agent.ts:336-362`、`:960-978`）。每次都传 `canUseTool` 和 `allowDangerouslySkipPermissions: true`（`:3348-3386`），所以中途能切到任何模式。
- 回调把请求分成 tool、plan、question 三类，带上 `suggestions`，计划文字取 `input.plan`（`agent.ts:4809-4900`）。计划的操作是 Reject / Implement / "Implement with Bypass"（`:1110-1136`）。通过后切到 `acceptEdits` 或 bypass，问题的答案合并进 `updatedInput`（`:2652-2710`）。运行中用 `setPermissionMode` 切模式（`:2480`）。
- 用户不点按钮、直接发新消息时，挂着的请求按拒绝处理，文案 "The user answered with a message instead of approving. Their message follows."（`agent.ts:387-388`、`:2385-2410`、`:2639-2650`）。
- Claude 这边没有 `onElicitation`（零处匹配）。
- Codex 模式：Default Permissions（on-request + workspace-write）、Auto-review（加 auto_review）、Full Access（never + danger-full-access），另有一个不显示的只读预设（`codex-app-server-agent.ts:244-260`、`:300-320`）。
- 注册的服务端请求：命令、文件改动、requestUserInput、MCP elicitation、旧的 tool/requestUserInput；没有处理 `item/permissions/requestApproval`（`codex-app-server-agent.ts:3946-3964`）。只把允许 / 拒绝映射成 accept / decline / cancel，不用 `acceptForSession`（`:627-633`、`:4671-4745`）。MCP 表单：url 模式和有必填字段的表单自动 decline，其余显示成审批（`:7101-7140`）。没找到审批的超时（推断）。
- 应用里只有两个按钮：拒绝 / 接受，计划时是"实施"（`packages/app/src/agent-stream/view.tsx:1430-1453`）。中文文案：拒绝、接受、实施、需要权限、你想如何继续？（`packages/app/src/i18n/resources/zh-CN.ts:235-247`）。

Paseo 说明两件事：两个 agent 可以放进同一个"允许 / 拒绝"的界面；它没做的（本会话允许、权限申请、超时、多人谁能点）正是飞书群里要补的。

## 5. bridge 和用户反馈

- bridge 的服务端请求也一律回 `-32601`（bridge `src/agent/codex-appserver/app-server-client.ts:273-279`）。README 写着始终 `approvalPolicy: never`，沙箱是唯一的安全闸门；三档叫 🔒 项目内只读、✏️ 项目内读写、⚠️ 完全访问；"完全访问 = 任何能给机器人发消息的人都能以你的身份在这台机器上执行任意命令"（bridge `README.md:150-159`）。这三档的名字用户已经熟悉。
- 社区群里对咖啡一下按钮的困惑（消息按 message_position 编号）：#518 "咖啡一下到底怎么用"；#566 问"等待确认"和"直接回复"两个按钮"按了会怎么样？不按会怎么样"；#580 "我实在搞不懂……等待确认这个按钮，作用到底是什么？"。教训：按钮要写清后果，卡片上要说"不点会怎样"。
- #953 想在同一会话里按发信人分权限，Codex 支持在新消息前切权限。这和 1.7 的每轮覆盖、`turnTier` 的做法一致。
- GitHub issue 里没有和审批有关的，也没找到用户要求逐条审批的证据（未知：需求来自 owner 本人）。

## 6. 方案

### 6.1 原则

1. vonvon 不比 agent 自己多问，也不少问。什么时候问由 agent 的原生设置决定，vonvon 不加自己的规则。完全访问下 agent 自己仍会问的几类（AskUserQuestion、ask 规则、删除关键路径，见 2.2），照样发卡。
2. 所有"要人点"的卡片一个样：同样的版面、同样的状态、同样的"谁能点"规则。设置的授权卡（product.md 3.8）也并进来。
3. 卡片上写清后果：点允许会怎样，点拒绝会怎样，不点会怎样。
4. 不给会长期生效、写进用户全局配置的选项。

### 6.2 设置

**用户看到的**：一个权限档选择（沿用 bridge 的名字）加一个开关。

- 权限档：只读 / 读写 / 完全访问（从不问）。
- 超出权限时：问我（发授权卡）/ 直接拒绝。只在只读和读写下显示。
- 网络开关照旧。关网又选了"问我"时，agent 要联网会发授权卡问这一次（推断：Codex 会带 `networkApprovalContext`，Claude 会问不在名单里的主机）。
- 访客档另有一个同样的开关，默认"直接拒绝"，可改成"交给管理员确认"。
- 层级：bot 默认 → 群覆盖 → 私聊用 bot 默认（product.md 3.2、第 4 节）。数据上在 `Project` 的 `mode`、`guestMode`、`network` 旁边加两个字段（推断的写法：`escalation?: 'ask' | 'deny'`、`guestEscalation?`）。

**换算到两个 agent**（推断，要在 Mac 上测，见第 8 节）：

| 用户的选择 | Codex | Claude |
|---|---|---|
| 只读 · 问我 | `on-request` + 今天的只读 profile | `default` + 今天的只读沙箱，保留 Write/Edit 工具以便它来问，`allowUnsandboxedCommands: true`（出沙箱要先问），`canUseTool` 发卡 |
| 只读 · 直接拒绝 | `never` + 只读 profile（今天的行为） | `default` + 同样的沙箱，`canUseTool` 一律回拒绝并说明原因 |
| 读写 · 问我（推荐默认） | `on-request` + 今天的读写 profile，约等于 Codex 的默认预设 | `acceptEdits` + 今天的读写沙箱，`allowUnsandboxedCommands: true`，`canUseTool` 发卡 |
| 读写 · 直接拒绝 | `never` + 读写 profile（今天的行为） | `acceptEdits` + 同样的沙箱，`canUseTool` 一律回拒绝 |
| 完全访问（从不问） | `never` + `danger-full-access`（今天的行为） | `bypassPermissions`（今天的行为） |

说明：

- Claude 的"直接拒绝"建议不再用 `bypassPermissions`，改成和"问我"同一个模式，只是回调自动拒绝。这样 3.3 的三个缺口在两档下都补上了（推断）。没选 `dontAsk`，因为它连 AskUserQuestion 也拒（`permission-modes.md:557`）。代价：今天 bypass 下能用的 WebFetch、cwd 外写文件会变成被拒。开网时给 WebFetch、WebSearch 加 allow 规则，免得每个域名都问。
- Codex 的"直接拒绝"保留 `never`，因为 `never` 下模型知道不能申请，不会白白尝试；如果改成 `on-request` 再自动拒，模型会多走几轮（推断）。
- "问我"档下 vonvon 自己装的 MCP 建议配 `approve`（1.5），它自己在 daemon 里判断权限；主人通过授权卡装的 MCP 按 Codex 默认规则问。"直接拒绝"档下已装的 MCP 也建议配 `approve`，否则在 Codex 上会被拒（推断，1.5）。
- 中途改档：Codex 用 `turn/start` 的每轮覆盖（1.7），Claude 用 `setPermissionMode`（2.2），都不用重开会话（推断）。沙箱设置的改动在 Claude 上可能要重开 `query()`（未知）。
- "问我"档还能顺带解决 product.md 第 9 节第 4 条：`workspace-write` 下 `.git` 只读，`git commit` 会越权，"问我"时就是一张授权卡，而不是直接失败（推断）。
- 迁移：bridge 迁来的群换算成"直接拒绝"，和今天一样。新 bot 默认"读写 · 问我"。product.md 第 5 节要加这一条。
- 第四种"让 agent 自己审"（Codex `auto_review`，Claude `auto`）推荐放到 v1 之后：多花用量，Claude 的 `auto` 在 Bedrock、Vertex 下没有（Paseo `agent.ts:960-978`）。

### 6.3 卡片家族

三种卡片，同一个版面：

- **授权卡**：agent 要越权（命令、改文件、联网、MCP 工具、权限申请），以及 product.md 3.8 的设置类授权（装 MCP、装含脚本的 skill、加目录、改权限档和网络）。
- **选项卡**：agent 问问题（Claude 的 AskUserQuestion，Codex 的 `request_user_input`，简单的 MCP 表单）。
- **确认卡**：只要"是 / 否"的确认，比如 Claude 的计划（ExitPlanMode），以及 vonvon 自己的不可撤销操作。

**版面**（授权卡为例）：

```
需要确认：运行命令                                  [读写 · 问我]
张三 的这一轮，等 @李四 或其他管理员确认
命令    npm publish --tag next
目录    ~/work/app（工作区内）
原因    Codex：发布需要联网
如果拒绝  这条命令不会运行，agent 会换个办法或停下来问你
不处理  15 分钟后按拒绝处理

[允许这一次]  [本会话不再问这条命令]  [拒绝]
回复这张卡片 = 拒绝，并把你的话告诉 agent
```

**点击后**：按钮去掉，换成一行结果，例如"✅ 李四 允许了（仅这一次）10:03"、"⛔ 李四 拒绝了 10:04"、"⏱ 超时未确认，已按拒绝处理"、"⏹ 已停止"、"已失效（后台服务重启过）"。每条出口都要改卡，避免咖啡一下"超时后按钮还挂着"的问题。

**按钮和 agent 的对应**：

| 请求 | 允许这一次 | 本会话不再问 | 拒绝 | 回复卡片写说明 | 运行卡 ⏹ |
|---|---|---|---|---|---|
| Codex 命令 | `accept` | `acceptForSession`（"这条命令"） | `decline` | `decline`，再把这句话作为插话送进去 | `cancel` |
| Codex 联网（带 `networkApprovalContext`） | `accept` | `acceptForSession`（"这个主机"，推断：TUI 的 "allow this host for this conversation" 对应它） | `decline` | 同上 | `cancel` |
| Codex 改文件 | `accept` | `acceptForSession`（"这些文件"） | `decline` | 同上 | `cancel` |
| Codex 权限申请 | `scope: turn` | `scope: session` | 空授权 | 同上 | 空授权后中断 |
| Codex MCP 工具审批 | `accept` | `accept` 加会话级 `_meta`（推断） | `decline` | 同上 | `cancel` |
| Claude 工具 | `allow` | `allow` + `updatedPermissions`（`suggestions` 的 `destination` 全改成 `session`） | `deny{message}` | `deny{message: 这句话}` | `deny{interrupt: true}` |

- Codex 带了 `availableDecisions` 时，按它取交集显示按钮。Claude 传了 `suppressAlwaysAllowRule` 时不显示"本会话不再问"。
- 不显示 `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`（"以后都允许"、"以后都屏蔽这个主机"），因为它们会改用户自己的 Codex 规则（推断：写进用户的 Codex 配置目录）。Claude 的 `suggestions` 原样返回会写进用户设置或仓库里的 `.claude` 文件（`sdk.d.ts:2574`），所以统一改成 `session`。
- "本会话不再问"后面要写清是哪一类：这条命令、这个主机、这些文件，或者 Claude 规则的白话说法（比如"以 `npm test` 开头的命令"）。不叫"始终允许"，咖啡一下的"始终允许"其实也只是会话缓存（`D/cli-bridge/service.ts:410-416`）。
- "本会话"指这个飞书位置的这条 agent 会话：`/new` 和每个话题会话各自清空。

**选项卡**：沿用咖啡一下的表单（`D/cli-bridge/cards.ts:282-336`），每题一个下拉框，`isOther` 或可自定义时加一个文本框，一个"提交"。改两处：空提交时提示"至少选一项"，并保持可点；点击后卡片换成"张三 选了：方案 B"。Claude 回 `allow{updatedInput: {questions, answers}}`；Codex 回 `answers: {id: {answers: [...]}}`。

**确认卡**：计划全文放进卡片（30 KB 以内，超了截断并附"在桌面端看全文"），按钮［按这个方案做］［不行，我来说］。"不行"等于拒绝，回复卡片写说明等于拒绝并附上说明。批准计划不提权限档，仍按当前档执行（和 Paseo 的"Implement with Bypass"不同）。v1 用不用计划模式要看 `/goal` 等功能（未知）。

**放在哪里**：每张卡单独发一条消息，回复触发这一轮的那条消息（话题里用 `reply_in_thread`），在卡片里 @ 能点的人。运行卡上显示"⏸ 等待 李四 确认（见下方卡片）"。不把按钮塞进运行卡：运行卡在流式更新，按钮会和输出抢更新；卡片里的 @ 才能让人收到提醒（推断，要实测）。

### 6.4 谁能点

| 卡片 | 能点的人 | 卡片 @ 谁 |
|---|---|---|
| 越权授权卡（agent 的工具审批） | 主人和管理员。发起人是管理员时当然能点 | 发起人是管理员时 @ 发起人；否则 @ 主人（加上在群里的管理员，推断要控制人数） |
| 设置授权卡（product.md 3.8） | 发起的那个主人或管理员（product.md 原文） | 发起人 |
| 选项卡 | 发起人，管理员可以代答 | 发起人 |
| 确认卡（计划） | 发起人和管理员 | 发起人 |
| 访客那一轮的越权 | 默认没人（直接拒绝）；设了"交给管理员确认"时只有主人和管理员 | 主人和管理员 |
| bot 触发的那一轮（bot 之间对话） | 只有主人和管理员 | 主人 |
| 私聊 | 私聊的那个人（只有主人和管理员能私聊，product.md 第 4 节） | 不用 @ |
| 云文档评论会话 | 没地方放卡片 | 推荐这类会话固定用"直接拒绝"，或发到发起人私聊（owner 决定） |

- 访客永远批不了自己的越权，否则访客档没意义（访客档的设计见 critique.md 1.1）。普通成员（不是管理员、群里没分访客档）的越权也只有主人和管理员能批：权限档就是主人给群里成员定的上限，越过上限只有主人和管理员能决定。
- 点击人不符时，沿用 ⏹ 的做法回贴一条去重的小注（`D/bot/handle-message.ts:2384-2397`），例如"只有管理员能确认这一步"。
- 第一次有效点击生效。之后的点击回小注"已经处理过了"。
- 谁能点由 daemon 根据点击人的 open_id 判断（`isAdmin`，`D/config/schema.ts:349`），不由 agent 判断，和 product.md 3.7 一致。

### 6.5 等待、排队、超时、重启

- **watchdog**：等待确认时，空闲 watchdog 必须暂停，否则等人点的时候会被当作"没输出"杀掉（`D/bot/watchdog.ts`；`D/config/schema.ts:315-320`）。
- **同一会话同时只显示一张待确认卡**。Codex 并行跑工具时可能一次来几个请求，其余排队，卡上写"后面还有 2 个"。答完一个再发下一张。这样群里不刷屏，也省限额。
- **新消息**：能点的人在同一位置（同一话题或同一会话）发新消息，等于拒绝并附上这句话。Claude 用 `deny{message}`（Paseo 的做法，`agent.ts:2385-2410`）；Codex 先 `decline`，再把消息作为插话送进去。别人的消息照常排队，不影响卡片。
- **⏹ 停止**：取消这一轮所有待确认的请求，卡片改成"已停止"。
- **超时**：推荐默认 15 分钟，可配置，超时按拒绝处理，卡片写"超时未确认，已按拒绝处理"。选项卡超时，告诉 agent"用户没有回答"（Claude 回 `deny{message}`，Codex 回空答案）。两个 agent 自己都没有等待上限（`sdk.d.ts:210-216`；Codex 见 1.4），上限只能由 vonvon 定。咖啡一下的 24 小时（`D/config/schema.ts:483-494`）是给主人自己电脑上的 CLI 用的，群里一个回合挂 24 小时会一直占着会话和一个并发名额（默认 10 个，`D/config/schema.ts:227-230`；占名额是推断）。
- **agent 自己撤掉请求**：Codex 发 `serverRequest/resolved` 时（1.2），卡片改成"已失效"。
- **daemon 重启**：agent 子进程和挂着的请求都没了。点到旧卡时自愈成"已失效（后台服务重启过）"，做法同 `healDeadRunCard`（`D/bot/handle-message.ts:2398` 起）。只把卡片的消息 id 落盘就够，请求本身不用持久化（推断）。
- **子 agent**：Codex 子 agent 线程发来的审批带的是子线程的 `threadId`，要路由到父回合的运行卡，卡上标"子 agent Robie 想运行……"（推断，Codex TUI 的标签见 `approval_overlay.rs:1593`）。Claude 的回调带 `agentID`（`sdk.d.ts:217-300`）。
- **敏感问题**：`isSecret` 的问题不在群里显示输入框，回空答案并在运行卡上说明"这个问题要填敏感信息，请在私聊里回答"。MCP 的 url 模式和带必填字段的表单先 decline，在运行卡上说明（和 Paseo 一样，`codex-app-server-agent.ts:7101-7140`）。
- **上下文**：审批的结果已经进了 agent 自己的会话记录（Codex 的 decline、Claude 的 deny message），卡片本身不用再写进群上下文（推断）。这一点和 owner 问的"哪些要存入上下文历史消息"相关，由上下文那份报告定。

### 6.6 和权限档、网络、访客档、设置授权卡的关系

- 设置授权卡跟着这个设置走：完全访问下不发，直接生效带撤销，因为这一档 agent 本来就能跑任何命令、改任何配置；只读和读写下照常发卡。"直接拒绝"只管 agent 的工具审批，不管设置授权卡，否则在这一档里就没法在聊天里装 MCP 了（列为 owner 问题 6）。
- 降档（比如从读写改成只读、关网）不用卡片，直接生效。
- 改权限档、改"超出权限时"这个开关，本身就是 product.md 3.8 的设置授权卡。

### 6.7 和 owner 另外两点的关系

- 话题是单独的会话：每个话题有自己的待确认队列和"本会话不再问"的范围；卡片发在话题里（`reply_in_thread`），主区只留引用。
- 后台服务不依赖 Electron：审批流程全部在 daemon 里，飞书卡片和 agent 子进程都由 daemon 管，桌面端只负责改设置，不参与审批。Linux 上 Codex 的只读、读写档今天会直接失败（`D/agent/codex-appserver/backend.ts:78-82`），Claude 在 Linux 上用 bubblewrap 做沙箱（推断），要另开一项处理。

### 6.8 飞书平台的限制和实现要点

- 卡片回调必须 3 秒内响应，可以回 toast 或更新卡片（`r3/fs/_feishu-cards_card-callback-communication.md:5`、`:348`）；回调里的 token 有效 30 分钟，最多更新 2 次（`:171`、`:312`）；错误码 200341 超时、200671 非 200、200672 响应体格式错、200530 表单项 name 为空。SDK 丢掉了处理函数的返回值（3.5），所以照今天的做法：先回空，500 毫秒后再改卡（`D/bot/handle-message.ts:2244-2255`）。
- 群里所有 bot 共享每秒 5 条的发消息限额；同一条消息每秒最多改 5 次，14 天内能改；卡片实体每秒 10 次；卡片最多 30 KB、200 个组件；流式更新 10 分钟自动关（`docs/research/2026-10-14-v1-definition/context-feishu-products.md` 1.6；`message/create.md:13`）。授权卡频率低，限额问题不大，但"一次只显示一张"能防止 Codex 并行请求刷屏。
- 表单字段必须有 name（200530）；多选下拉要客户端 7.4 以上（`D/card/cards.ts:595-599`）。
- 卡片里的 @ 会不会触发提醒：未知，要实测。不会的话，发卡时另发一条带 @ 的文字消息。
- 命令和计划要截断：咖啡一下把命令截到 3000 字（`D/cli-bridge/cards.ts:118-120`），可以沿用。

### 6.9 要改 product.md 的地方（在实现 PR 里一起改）

- 3.8：删掉"agent 自己的工具调用不弹审批……审批策略是 `never`"这条，改成 6.1 到 6.5 的内容；设置授权卡并进卡片家族。
- 3.2：表里加"超出权限时"和访客档的开关，默认值和覆盖规则。
- 3.12：空闲 watchdog 在等待确认时暂停。
- 第 5 节：bridge 迁来的群换算成"直接拒绝"。
- 第 9 节：加第 8 节的实测项。

### 6.10 切片建议（推断，每片按 1500 行估）

1. 卡片框架：三种卡片的版面、状态机、谁能点、超时、自愈、watchdog 暂停。先接 Claude 的 AskUserQuestion 选项卡（今天会被拒，用户直接受益）。
2. Claude 授权卡：从 `bypassPermissions` 换到 `default` / `acceptEdits` 加 `canUseTool`，`suggestions` 改 `session`，设置里加"超出权限时"。
3. Codex 授权卡：给连接加 `onRequest`，处理命令、改文件、联网审批，"问我"档换 `on-request`。
4. 选项卡的其余来源：Codex `request_user_input`、MCP 表单、权限申请。
5. 设置界面（桌面端和 `vonvon` 命令行）、迁移、设置授权卡并入卡片家族。

## 7. 要 owner 决定的事

每题附选项和推荐。

1. **新 bot 的默认档**。A 读写 · 问我（推荐，和两个 agent 的默认一致）；B 读写 · 直接拒绝（和 bridge 一样）；C 完全访问。
2. **谁能点越权授权卡**。A 只有主人和管理员（推荐）；B 发起人也能点，不管是不是管理员；C 只有发起人。
3. **访客那一轮要越权时**。A 直接拒绝（推荐）；B 交给主人和管理员确认。
4. **没人点多久算超时，超时后怎样**。A 15 分钟按拒绝（推荐）；B 5 分钟；C 1 小时；D 不超时，一直等。
5. **完全访问下 agent 自己仍会问的几类**（AskUserQuestion、Claude 的 ask 规则、删除关键路径）。A 照样发卡（推荐，和 agent 自己的行为一致）；B 一律自动允许，真正"什么都不问"；C 一律拒绝。
6. **设置授权卡要不要跟着这个设置**。A 完全访问下不发，其余照常（推荐）；B 任何档都发（product.md 3.8 的原样）；C "直接拒绝"档下也不在聊天里改设置。
7. **要不要"让 agent 自己审"这一档**（Codex 的自动审、Claude 的 auto）。A v1 之后（推荐，多花用量）；B v1 就做，标成试验。
8. **要不要"本会话不再问"，要不要"以后都允许"**。A 要"本会话不再问"，不要"以后都允许"（推荐）；B 两个都要；C 只有允许和拒绝，和 Paseo 一样。
9. **授权卡放在哪里**。A 单独发一条并 @，运行卡上显示等待状态（推荐）；B 按钮放进运行卡。
10. **云文档评论会话要越权时**。A 固定"直接拒绝"（推荐）；B 把授权卡发到发起人的私聊。
11. **bridge 迁来的群要不要提示**"现在可以改成问我"。A 迁移后在群里发一次说明，带一个"改成问我"的按钮（推荐）；B 不提示，只在桌面端显示。

## 8. 要在 Mac 上实测

1. Codex `on-request` + vonvon 自定义的 `feishu` profile：越权写文件、跑要越出沙箱的命令时，会不会发 `requestApproval`；关网时能不能触发带 `networkApprovalContext` 的联网审批。
2. Codex `never` + 只读、读写 profile 下，没有 `readOnlyHint` 的 MCP 工具是否被拒；给服务器配 `approve` 能不能修好。
3. Codex feature `default_mode_request_user_input` 能不能在默认模式下打开 `request_user_input`。
4. Codex 子 agent 线程的审批：带的是哪个 `threadId`，能不能路由回父回合。
5. Claude `acceptEdits` / `default` + 沙箱 + `canUseTool` 实际会问哪些事：cwd 外的读和写、不在名单里的主机、不进沙箱的重试、WebFetch。
6. 今天 `bypassPermissions` 下的缺口是否真的存在：关网后 Bash 能不能连外网，Edit/Write 能不能写到 cwd 外；`managedSettings` 的 `strictAllowlist` 能不能修好。
7. 今天 Claude 会话里的 AskUserQuestion 是否被拒。
8. Claude 运行中 `setPermissionMode` 切档，Codex `turn/start` 每轮覆盖切档，是否对下一轮生效、resume 后还在不在。
9. 飞书卡片里的 @ 会不会给被 @ 的人发提醒。
10. 等待确认超过空闲超时时，watchdog 会不会误杀这一轮。
11. daemon 重启后点旧的授权卡，能不能自愈成"已失效"。
12. 同一会话 Codex 并行来几个审批时，排队显示是否正常，群里每秒 5 条的限额会不会被打到。
13. 读写 · 问我下 `git commit` 是否会弹授权卡、批准后能否提交（和 product.md 第 9 节第 4 条一起测）。

## 来源说明

- 仓库代码：vonvon-bot `2c60ea0` 的 `packages/daemon/src/`；`docs/product.md`；`docs/research/2026-10-14-v1-definition/` 下的 bridge-inventory、critique、context-feishu-products。
- Codex：0.162.1 的 `codex-rs/` 快照；线上文档 agent-approvals-security 的本地副本。
- Claude：`@anthropic-ai/claude-agent-sdk` 0.3.296 的 `sdk.d.ts`、`sdk-tools.d.ts`；线上文档 sdk-user-input、sdk-permissions、permission-modes、sandboxing、settings-reference 的本地副本。
- Paseo：参考仓库 `0009a7e7` 的 `packages/server` 和 `packages/app`。
- bridge：feishu-codex-bridge 0.6.14（`6698118`）的代码和 README；社区群消息按 message_position 编号。
- 飞书：卡片回传交互回调、延时更新消息卡片两篇文档的本地副本（`r3/fs/`）。
- 本报告没有跑任何 agent 或飞书接口，所有"推断"都要在 Mac 上实测后再写进 product.md。

---

## 核实记录

另一个代理（Sonnet）独立复查了这份报告，只拿到报告本身和仓库，没有作者的推理过程。下面是它逐条核对的结论和它指出的缺口，原样保留，只改了格式。正文和这里冲突时，以这里为准。

| 说法 | 结论 | 说明 |
|---|---|---|
| Codex 写死 approvalPolicy never(D/agent/codex-appserver/backend.ts:30) | 核实 | backend.ts:30 const APPROVAL_POLICY = 'never'。 |
| Claude 三档都用 bypassPermissions,无 canUseTool(permission.ts:56、:73) | 核实 | permission.ts:56 和 :73 都是 bypassPermissions。全仓 grep canUseTool 只有 thread.ts:272 一条注释,onElicitation 零匹配。 |
| Codex 服务端请求一律回 -32601(jsonrpc.ts:197-206);连接只设 onNotification/onInvalidFrame,无 onRequest(:277,:280) | 核实 | jsonrpc.ts:197-206 在 onRequest 缺省时回 -32601 'not handled';:277、:280 只设了 onNotification、onInvalidFrame;仓库内没有别处设 onRequest。所以接审批只需补 onRequest。 |
| Codex 三个预设:Read Only=read-only+on-request,Default=workspace-write+on-request,Full=never+danger-full-access | 核实 | codex-rs/utils/approval-presets/src/lib.rs:28-60。小出入:Read Only 的描述是'改文件或联网要审批',与报告一致。 |
| AskForApproval 四值(untrusted/on-request/granular/never) | 核实 | v2/shared.rs:206-224。 |
| never 下需要问的提示直接被拒;MCP 审批在 never 下返回 denied | 核实 | exec_policy.rs:216-238 Never=>Some(PROMPT_CONFLICT_REASON);mcp_tool_call.rs:1615-1619 文案与报告一致。 |
| request_user_input 默认只在 Plan 模式;default_mode_request_user_input 与 request_permissions_tool 均 UnderDevelopment、默认关 | 核实 | features/src/lib.rs:1739-1743、:1303-1307。tool_config.rs 的 Plan 限定本次未逐行核对。 |
| Claude SDK:PermissionMode 六值、CanUseTool 无等待上限、setPermissionMode 仅 streaming input、无 canUseTool 时 ask 直接终止 | 核实 | sdk.d.ts:2503、:205-216('permission prompts have no park deadline')、:2882-2886、:5572-5576。读的是 vonvon 实际装的 0.3.296,不是 ^0.3.178 的下限;最低版本下这些接口是否都在未核对。 |
| 咖啡一下点击不检查点击人(service.ts:505-516);超时后卡片不更新(:391-399) | 核实 | service.ts:505-516 的 .on(...) 只传 value.id;resolveAction(:402 起)也没有操作者参数;dispatcher.ts:58 只记尾号。:391-399 只有 LOCAL_RETURN 才关卡,超时结果 fallback_local 不改卡。 |
| SDK 丢弃卡片回调处理函数返回值,回不了 toast,所以先回空、500ms 后改卡 | 没核实 | handle-message.ts:2384-2397 的注释确实这样写,CARD_SETTLE_MS=500 在 :2255(报告写 :2244-2255,基本对)。没去核 node-sdk 1.71.1 lib/index.js:99588-99598;另一棵 worktree 里装的飞书 SDK 是 1.75.0,另一版本的行为没比。飞书文档确实写 3 秒内响应。 |
| Paseo:只映射允许/拒绝,不用 acceptForSession,不处理 item/permissions/requestApproval;新消息按拒绝处理 | 核实 | codex-app-server-agent.ts 里 acceptForSession、item/permissions/requestApproval 均 grep 为零;claude/agent.ts:388 有 'The user answered with a message instead of approving' 文案。:2385-2410 的行号对应的是 enqueueSteer,不是报告说的位置,行号有偏差,结论成立。 |
| 推断:Linux 上 Codex 只读/读写档直接抛错;Claude 缺口(关网后 Bash 可连任意主机,Edit/Write 沙箱外跑) | 没核实 | Linux 抛错属实:backend.ts:76-82 在非 darwin、非 win32 时 throw。两个 Claude 缺口依赖 sandboxing.md 的描述,报告自己标了推断且没实测,我也没能验证。 |

缺口：

- 没有查 Codex app-server 在 on-request 下,自定义 permission profile(feishu)是否真会发 requestApproval。这是方案 6.2 换算表的根基,报告只列进 Mac 实测项。若 profile 不触发审批,'读写·问我'整行不成立。
- 没考虑 Claude 沙箱里 allowUnsandboxedCommands:true 的风险。放开后模型可自己加 dangerouslyDisableSandbox 重试,虽然会走 canUseTool,但卡片上要让人看懂这是'出沙箱运行',报告没写这种卡片的文案。
- settingSources 含 user 和 project(claude-agent/backend.ts:48),用户或仓库 .claude 里的 allow/ask/deny 规则和 hooks 会改变 canUseTool 实际收到的请求。'vonvon 不多问也不少问'受这个影响,报告只在 Codex 一侧提了 hook。
- Codex 的 guardian、自动审以及用户自己的 execpolicy 规则会让部分请求不到 vonvon。群里'本会话不再问'与 Codex 自己的会话缓存如何叠加,未讨论。
- 权限与访客档的组合:同一会话里管理员和访客走不同会话(turnTier),授权卡的'本会话不再问'范围怎么算、访客会话里能否被管理员的放行带出,没说清。
- 点击人身份的安全面:报告要靠 open_id 判断,但卡片 value 里的 id 可被转发或在其他群点击。只提了 daemon 判断 isAdmin,没提校验卡片所属的群和会话,也没考虑卡片被转发给他人的情形。
- daemon 重启后 Codex/Claude 子进程请求丢失,会话是否自动 resume、卡片的'已失效'后 agent 那一轮如何收尾,报告只说'自愈',没说对运行卡和用户消息的处理。
- 超时 15 分钟与并发名额、Claude 的 streaming 会话被卡住期间新消息的排队,只靠推断。没查 handle-message 里这一轮是否真的占并发名额。
- CLI 兼容性:vonvon 声明 ^0.3.178,AskUserQuestion 的 toolConfig、suppressAlwaysAllowRule 等字段在较早版本是否存在没比对,升级下限是否要抬高没提。
- 飞书卡片里 @ 是否提醒、表单必填校验、卡片 30KB 上限对长命令/计划的实际表现,均未实测;'单独发一条卡片消息再 @'的方案没有备选的提醒手段验证。
