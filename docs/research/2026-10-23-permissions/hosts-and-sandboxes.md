# 多 agent 宿主 / 协议 / 沙箱层如何抽象权限（调研 C）

调研日期 2026-10-23。只查资料，未安装、未运行任何工具。标注：**文档** = 官方文档页，**源码** = 官方仓库源码，**推断** = 我的判断。浅克隆的 commit 写在来源后面。没查到的明说。

---

## 1. Agent Client Protocol (ACP)

来源：https://agentclientprotocol.com 各页；仓库 agentclientprotocol/agent-client-protocol 浅克隆（HEAD 2026-10-23 01:32 UTC）的 `docs/rfds/`、`docs/protocol/`。

### 1.1 v1（当前稳定）

- **`session/request_permission`**（文档，/protocol/tool-calls）：agent 发给 client。参数 `sessionId`、`toolCall`（ToolCallUpdate，必填）、`options: PermissionOption[]`。每个 option 有 `optionId`、`name`、`kind`。
- **`PermissionOptionKind`** 四个值（文档）：`allow_once`、`allow_always`（"允许并记住"）、`reject_once`、`reject_always`。`kind` 只是 UI 提示（图标和样式），协议里没有定义"记住"的范围（本次会话 / 本项目 / 永久）和存放位置（文档 + `docs/protocol/v1/tool-calls.mdx:229`，没写范围）。
- **响应**：`{outcome:"selected", optionId}` 或 `{outcome:"cancelled"}`。turn 被取消时，client 必须对挂着的请求回 `cancelled`。文档明说"Clients may automatically allow or reject requests based on user settings"，即 client 可按用户设置自动放行或拒绝，不必弹窗。
- **没有标准的"权限档"**。协议只有两类通用机制：
  - **Session Modes**（文档 /protocol/session-modes）：`availableModes`（`id`/`name`/`description`）、`currentModeId`、`session/set_mode`、agent 可推 `current_mode_update`。文档示例 id 是 `ask`、`architect`、`code`，只是例子，语义由各 agent 自己定。
  - **Session Config Options**（文档 /protocol/session-config-options）：`configOptions[]`，每项 `id`/`name`/`category`/`type`(select 或 boolean)/`currentValue`/`options`。类别 `mode`、`model`、`model_config`、`thought_level`，`_` 开头留给自定义；类别只用于 UX，client 必须容忍未知类别。改值用 `session/set_config_option`，agent 返回完整的 option 列表，因为选项之间可能联动。文档写明：Config Options 取代 Modes，"Modes will be removed in a future version"，过渡期 agent 两个都发，支持 configOptions 的 client 忽略 modes。
- **client 能力**（文档 /protocol/initialization）：`clientCapabilities.fs.readTextFile`、`fs.writeTextFile`、`terminal`。agent 据此决定能不能发 `fs/read_text_file`、`fs/write_text_file`、`terminal/*`。理论意义：client 代办文件读写和命令执行，宿主就能在这个口子上做拦截、审计、路径限制，不依赖 agent 自带沙箱（推断）。
- **`additionalDirectories` RFD**（`docs/rfds/additional-directories.mdx:12-33,286,373`，源码）：会话生命周期请求可声明额外工作区根。RFD 自己写明"不是沙箱"：`cwd` 和 `additionalDirectories` 只表达意图范围，"实际访问仍由沙箱、审批、OS 权限决定"；agent 不能授予时必须报错而不是静默忽略。

### 1.2 v2（草案，RFD 在 `docs/rfds/v2/`，有 `docs/protocol/v2/` 与 `draft/`）

`docs/rfds/v2/overview.mdx` 列出的 v2 变化，和本题相关的：

1. **删除 Session Modes API**（`modes` 字段、`session/set_mode`、`current_mode_update`），mode 类状态一律走 Config Options。
2. **删除 client 的 fs / terminal 执行面**（`docs/rfds/v2/client-filesystem-terminal-capabilities.mdx`，2026-06-02 起草，07-14 修订）。理由（原文）：没有被 client 和 agent 广泛采用；IDE 之外的 client 多数提供不了，IDE 支持也参差；要求 agent 的工具同时支持两套实现，实际上"多数仍用自己的标准实现"；"很多 agent 正转向自己的沙箱和执行配置"。RFD 的"Shiny future"写："我们会探索 agent 沙箱与文件系统访问的配置"，即协议层目前**没有**这个标准。想要特殊工具的 client 可以自己暴露一个 MCP server。
3. **权限请求扩展**（`docs/rfds/v2/permission-requests.mdx`，2026-07-02 起草，07-14 加 command）：必填 `title`、可选 `description`、可选 `subject` 联合体（`tool_call` / `command{command, cwd(绝对路径), toolCallId?, terminalId?}`），无 subject 的请求允许存在（例如"是否以更高权限继续？"）；`options` 仍是 agent 给的选项列表；未知 subject 类型要保留，client 看不懂时显示通用提示或按策略拒绝。
4. 其他：Terminal Output 改为 agent 自有的只读展示；Enum Variant Extension；Streamable HTTP / WebSocket 远程传输（`docs/rfds/streamable-http-websocket-transport.mdx`）等。

没有查到：ACP 里任何关于"沙箱档位""网络开关""谁有权批准"的 RFD。`elicitation.mdx` 是向用户收集输入，不是权限。

### 1.3 对 vonvon 的含义（推断）

- ACP 把"权限模式"完全留给 agent：mode/config option 的 id、语义每家不同；client 只能展示并让用户选。**没有跨 agent 的标准权限档**。
- "client 代办文件读写"这条路在 v2 被删，趋势是 agent 自己沙箱。以此为前提的设计会过时。
- `allow_always` 的存放位置和范围未定义，由 agent 或 client 自己实现，所以群聊场景里"谁的 always"必须宿主自己定。

---

## 2. Zed（ACP client）

来源：Zed 浅克隆（`9e84b066`，2026-10-22）；https://zed.dev/docs/ai/external-agents 、/tool-permissions；仓库 `docs/src/ai/sandboxing.md`。

- **外部 agent 配置**（源码 `crates/settings_content/src/agent.rs:850-905`）：`agent_servers.<name>` 支持 `env`、`default_mode: Option<String>`（注释 "Not all agents support modes"）、`default_config_options: {configId: value}`、`favorite_config_option_values`。所以**能**设默认 mode，值是 agent 自报的 mode id，Zed 不翻译。
- **审批 UI**：渲染 agent 给的 `PermissionOption`，按 kind 映射成图标和动作（`crates/agent_ui/.../thread_view.rs:3290`、`10979` 处的 `AllowAlways`/`AllowOnce` 动作；`conversation_view.rs:690-715` 取 option）。
- **"always allow" 存哪**：外部 agent 的 `allow_always` 只是把选中的 optionId 回给 agent，我没有在 Zed 源码里找到 Zed 自己持久化它的地方——**推断**：由 agent 自己记住（没查到证据）。Zed 自带的 Zed Agent 才有自己的规则：`agent.tool_permissions` 的 `default`(confirm/allow/deny)、每工具的 `always_allow` / `always_deny` / `always_confirm` 正则，优先级 内置安全规则 > deny > confirm > allow > 工具 default > 全局 default（文档 /tool-permissions，v0.224.0 起）。文档没说这套是否适用于外部 agent；外部 agent 页写"Tool permissions: Zed ACP/tool forwarding permissions may apply; native tool permissions depend on the agent"。
- **Zed 自己的沙箱**（文档 `docs/src/ai/sandboxing.md`，源码 `crates/sandbox/` 有 `linux_bubblewrap.rs`、`macos_seatbelt.rs`、`windows_wsl.rs`）：只作用于 **Zed Agent 的 `terminal` 和 `fetch` 工具**，"不适用于外部 agent"。默认：读基本不限，写限于打开的项目目录（`.git` 元数据只读），网络默认封，超出需要用户逐次批准提升请求；提升请求的 option id 区分 `allow`/`allow_thread`/`allow_always`/`deny`（`crates/acp_thread/src/acp_thread.rs:170-205`），三档授权生命周期，且 `allow_thread` 与 `allow_always` 都用 `PermissionOptionKind::AllowAlways`，靠 id 区分（说明标准四个 kind 不够表达"本会话 / 永久"）。Linux 要 `bwrap` 在 PATH。
- **要点**：Zed 对外部 agent 是**透传**；对自家 agent 才做沙箱 + 提升请求。

---

## 3. Paseo（getpaseo/paseo）

来源：浅克隆 `4b9b2fe`（2026-10-23）时 git 对象拉取失败，下列内容来自 raw.githubusercontent.com 读取的源文件，未读到全文的地方已标注。2026-10-14 的记录见 `docs/research/2026-10-14-session-approval-service/approval-ux.md` 第 4 节，下面只补新内容。

- **provider 列表**（页面 `packages/server/src/server/agent/providers/`）：`claude/`、`codex/`、`opencode/`、`pi/`、`omp/`，以及 ACP 系：`acp-agent.ts`、`generic-acp-agent.ts`、`copilot-`、`cursor-`、`kimi-`、`kiro-`、`trae-acp-agent.ts`。`CLAUDE.md` 列支持的 agent：Claude Code、Codex、GitHub Copilot、OpenCode、Pi、Antigravity、Muse Code。
- **mode 来源（ACP 系）**（源码 `acp-agent.ts`，`deriveModesFromACP`）：agent 自报，不写死。顺序：session 响应的 `availableModes` → category 为 `mode` 的 select config option → `fallbackModes`（默认空）。模型取 `availableModels` → `model` option；思考级别取 `thought_level` option。`docs/custom-providers.md`：自定义 ACP provider 在 `agents.providers` 里 `extends: "acp"` + `command`，"Models and modes are discovered dynamically at runtime from the agent process"。
- **Claude / Codex 是写死的**（2026-10-14 记录里的 `claude/agent.ts`、`codex-app-server-agent.ts` 模式表），ACP 系是动态发现。这是同一个产品里"原生写死 + 协议动态"两条路并存。
- **审批**：ACP 的 `requestPermission` 有 **Auto Accept 开关**（每会话启用；无人值守的 agent 默认开启，除非关掉）。开启时直接选第一个 allow 类 option；否则存挂起请求并发 `permission_requested`；"如果 provider 没给 allow option，Paseo 留给你自己答"（`docs/custom-providers.md`，源码 `ACPAgentSession.requestPermission`）。
- **fs/terminal 能力**（源码 `acp-agent.ts` `BASE_ACP_CLIENT_CAPABILITIES`）：默认 `fs.readTextFile=false`、`fs.writeTextFile=false`、`terminal=true`，可被 provider 的 `options.clientCapabilities` 覆盖。即 Paseo 自己**不代办文件读写**，只代办终端（并实现了 terminal 方法）。
- **多用户权限**（`docs/permissions.md`）：daemon 有 principal / credential / 语义权限（`daemon.read`、`workspace.write`、`access.manage`），owner/operator/viewer 是 UI 预设，会展开成显式权限；权限只能加不能减，"缺权限就拒绝"；agent 和 terminal 都算 `workspace.write`。配对邀请是一次性、限时的。**这份文档没有描述"agent 权限请求由谁批准"**，只说明控制 agent 需要 `workspace.write`。未强制的缺口：工作区级别的授权尚未实现。
- 没查到：Paseo 是否把各家 mode 映射成统一档位（看起来没有，直接展示 agent 自报的 mode）。

---

## 4. 其他多 agent 宿主

### Conductor（conductor.build）
- 文档页：https://www.conductor.build/docs 、/docs/concepts/agent-modes。每个任务一个独立工作区 / 分支 / 终端。Agent Modes 页只列 Plan Mode、Fast Mode、思考级别、Codex personalities / goals，**没有权限档、沙箱或 bypass 的说明**。
- 归类：靠工作区隔离，权限没查到公开文档。**没查到**权限相关细节。

### Sculptor（Imbue）
- 没找到 Imbue 官方文档。第三方（rywalker.com/research/sculptor）说每个 agent 一个 Docker 容器、含仓库完整副本，Pairing Mode 双向同步。属二手信息，**未核实**。
- 归类（据二手信息，推断）：容器隔离，不管 agent 内部权限。

### Crystal → Nimbalyst
- Crystal 浅克隆 `1e18e0b`（2026-02-26）：README 写明 2026-02 已弃用，被 Nimbalyst 取代。源码里权限只有二值：`permissionMode?: 'approve' | 'ignore'`（`main/src/types/session.ts:16`、`config.ts:14`），默认 `ignore`（`main/src/events.ts:682`）。只接 Claude Code。
- 归类：二值开关 + worktree 隔离。Nimbalyst 没查。

### Vibe Kanban（BloopAI）
- 浅克隆 `d5cbb53`（2026-09-19）；README 写 "Vibe Kanban is sunsetting"。
- 源码 `shared/types.ts:626-658`：**每个 executor 一套自己的原生字段，没有统一档位**：Claude 有 `plan`、`approvals`、`dangerously_skip_permissions`；Gemini / Qwen 是 `yolo`；Opencode 是 `auto_approve`；Copilot 有 `allow_all_tools`、`allow_tool`、`deny_tool`、`add_dir`；Cursor 是 `force`；Droid 是 `autonomy`（normal/low/medium/high/skip-permissions-unsafe）；Codex 用原生 `sandbox` + `ask_for_approval`。`codex.rs:683-686`：仅当 sandbox=DangerFullAccess 且没配 ask_for_approval 时才 `auto_approve`。另外每家都有 `additional_params` / `base_command_override` 作为逃生口。
- 归类：**透传各家原生旋钮**（配置层是联合类型，每家一个结构），外加 worktree 隔离。UI 上"审批"是 Vibe 自己对接各家 SDK 的统一审批流（`executors/*` 里的 approvals）。

### Claude Squad
- 浅克隆 `ce1ffb4`（2026-08-20）。用 tmux 包裹各 CLI，不接协议：`-y/--autoyes` "实验性：自动接受所有提示"（`main.go:151`），`tmux.go:159-178` 检测"Do you trust the files in this folder?"并回车。
- 归类：不管权限，靠 worktree 隔离 + 往终端里按回车。

### Omnara
- 只有产品页 / 商店页（二手）：后台进程把 Claude Code 的权限请求转发到手机，逐个批准；也镜像 Codex 原生提示；"与规则型工具相反"。会话内容经其后端中转，竞品页称未端到端加密（竞品说法，未核实）。**没找到官方文档或源码**。
- 归类：透传原生提示，由主人在手机上批。

### Happy（slopus/happy）及其分支 Happier
- Happy 的 README 只说明支持 Claude、Codex、Grok、端到端加密、手机远程、"multiplayer sessions"（邀请别人观看、两人都能 steer），**没有写权限处理**；浅克隆失败，没读到权限相关源码。
- Happier（docs.happier.dev/sessions/permissions，**应为 Happy 的分支，推断**）文档给出了本题最接近的"统一档位"实现：规范档位 `read_only`、`default`、`auto`、`yolo`；plan 是会话 mode 而不是权限；按 provider 映射到"最接近的原生策略"：Claude 有额外的 Plan mode，退出 plan 时可选 Accept Edits / Bypass；Codex 映射到当前后端（App Server / ACP / MCP）最接近的 approval + sandbox；Devin 映射 ask/smart/bypass/plan；**Pi 的 read-only 只是工具白名单，Auto/Default/YOLO 不传 `--tools`，保留完整工具含 shell**，文档明说 "Auto is therefore not a workspace-confinement boundary for Pi"；Gemini / OpenCode / Kilo 文档没有描述映射。read_only 在 Happier 作为审批人时"拒绝写类动作"，即靠宿主做审批者来兑现。
- 搜索结果里还出现 HAPI（tiann/hapi）的 default / read-only / safe-yolo / yolo 四档，未深入。
- 归类：统一档位 + 逐 provider 尽力翻译 + 诚实标注哪些不是边界。

### CodexMonitor
- 浅克隆 `dd61b9a`（2026-03-26）。`src-tauri/src/shared/codex_core.rs:491-513`：UI 的 `accessMode` 三值 `read-only` / `current` / `full-access`，翻成 Codex app-server 的 `sandboxPolicy`（readOnly / workspaceWrite 带 `writableRoots:[工作区]` 和 `networkAccess:true` / dangerFullAccess）和 `approvalPolicy`（full-access→never，其余 on-request）。只接 Codex。
- 归类：单 provider 的三档翻译。**和现在 vonvon 的三档几乎同构**（"current"档默认开网络，是一个值得对照的差异）。

### OpenClaw（IM 里的个人 agent）
来源：https://docs.openclaw.ai/gateway/security 、/security/access-control 、/security/tool-permissions 、/tools/exec-approvals 、/tools/exec-approvals-advanced。仓库浅克隆失败。
- **信任边界**：文档明说"一个 gateway 一个信任边界：一个操作者，或互相信任的团队"；互不信任的用户要分开 gateway、凭据，最好分 OS 用户或主机。会话隔离"是消息上下文边界，不是主机管理员边界"。
- **谁能说话**：`dmPolicy`: `pairing`(默认，陌生人拿配对码，1 小时过期，每渠道最多 3 个待处理) / `allowlist` / `open` / `disabled`；群里 `groupPolicy: allowlist|open` + `groupAllowFrom`，先判策略再判 @/回复激活，"回复机器人的消息不能绕过 groupAllowFrom"。
- **谁能执行命令**：斜杠命令只对授权发送者生效（`commands.allowFrom`）；渠道白名单为空或含 `*` 时命令等于对所有人开放。
- **谁能批准**：Discord / Telegram / Slack 用 `channels.<x>.execApprovals.approvers`；未设时可由 `commands.ownerAllowFrom` 推断。"只有解析出的审批人能批准或拒绝"；同聊天里 `/approve` 一般要求发送者已有命令授权，显式审批人可以没有。"向一个会话发提示不代表会话里每个人都有批准权"。发起人不必是审批人。默认超时 30 分钟，超时按拒绝；没有可达 UI 时 `askFallback` 默认 deny。Owner 专属的群命令的审批提示私下发给 owner，群里只看到简短确认。Telegram 审批默认发到审批人私聊（`target: dm`），可设 channel / both。
- **隔离**：每个 agent 一套 sandbox + tool 策略（full / read-only / 无）：`sandbox.mode: off|all`，`scope: agent|session|shared`，`workspaceAccess: none|ro|rw`；示例里"个人 agent"沙箱关、"家庭 / 工作"agent 沙箱开且 `ro`，"公共"agent 无文件系统、无 shell。`tools.elevated` 是逃出沙箱的口子，要求 `tools.elevated.allowFrom` 收紧，"不要对陌生人开启"。`gateway` 工具"仅 owner"。
- 没查到：文档没有专门写"群会话默认沙箱"。
- 归类：**宿主自定权限（工具 allow/deny + 容器沙箱 + 提升）**，不透传 agent 的原生 mode；审批人是显式配置的身份名单。

### Hermes Agent（NousResearch）
来源：https://hermes-agent.nousresearch.com/docs/user-guide/security（仓库浅克隆失败）。
- 先看"谁能和 bot 说话"：每平台 allow-all → DM 配对批准 → 平台白名单（如 `TELEGRAM_ALLOWED_USERS`）→ 全局白名单 → 默认拒绝。
- 危险命令在聊天里审批：agent 把命令发到聊天，回复 yes/approve/ok 放行，no/deny/cancel 拒绝，默认 300 秒无人回复就拒绝。**文档没写群里谁能批**，只描述了白名单；文档自己也提示要自行验证。
- 容器后端（docker / modal / daytona / vercel_sandbox）下跳过危险命令检查，"容器就是安全边界"，文档推荐生产 gateway 用容器后端而免审批。
- YOLO 模式（`/yolo`、`--yolo`、`HERMES_YOLO_MODE=1`）：聊天里会跨 gateway 重启保留；`/new`、`/resume` 恢复审批；不能绕过硬黑名单（`rm -rf /` 等）和 `approvals.deny`，agent 不能停掉自己的 gateway。
- 归类：白名单控制谁能说话 + 聊天内审批危险命令 + 容器当边界时免审批。

---

## 5. 与 agent 无关的沙箱层

### 5.1 Anthropic sandbox-runtime（srt）
来源：浅克隆 `aceba12`（2026-10-21），`package.json` 版本 0.0.81；README 和 https://code.claude.com/docs/en/sandboxing 。
- **独立可用**：`npm i -g @anthropic-ai/sandbox-runtime`，CLI `srt <命令>` 或库 `SandboxManager.wrapWithSandbox`。**标注为 Beta Research Preview**。平台：macOS 用 `sandbox-exec` 动态生成 Seatbelt profile；Linux 用 bubblewrap；Windows 为 alpha（专用本地用户 + WFP 过滤）。依赖 bubblewrap（Linux）。
- **文件系统**：读是"默认全开，可 `denyRead`，再用 `allowRead` 放回"；写是"默认全拒，必须 `allowWrite`，可 `denyWrite`"（README "Dual Isolation Model"）。所以能做只读 / 读写 / 屏蔽敏感目录三种（但"只读"要靠 allowWrite 为空）。
- **网络**：默认全拒；`allowedDomains` / `deniedDomains`；Linux 去掉网络命名空间，流量经 Unix socket 到宿主上的 HTTP / SOCKS5 代理；macOS 只放行到本机某端口。有 `ask` 回调：对没有规则决定的目标可以问用户，只有返回 `true` 才放行（0.0.79 之后行为变严）。支持每条命令的域名白名单，`--control-fd` 运行中更新网络列表（文件系统规则不能更新）。
- **IPC / 其他**：Unix socket 默认封；`credentials.envVars` / `files` 可屏蔽或遮罩凭据；macOS 有违规日志。
- **嵌套**：`enableWeakerNestedSandbox`（给 Docker 环境用的弱模式）、`allowNestedUserNamespaces`（Linux）；默认下 Linux 沙箱内不能再建 user namespace，所以 **Chromium / Electron 沙箱、rootless podman、嵌套 bwrap 或 srt、`unshare -r` 都会 EPERM**（README 平台依赖一节）。以 root 运行需要 `CAP_SETFCAP`。
- **Claude Code 自己的用法**（官方文档）：Claude Code 内置沙箱只包 **shell 命令**；Read/Edit/Write 等文件工具、MCP server、hooks、LSP 等都**在沙箱外**，只受权限规则管；`denyRead` 拦不住 Read 工具。官方给出的办法："要把它们都放在一道边界后面，就把 Claude Code 进程本身放进容器、虚拟机或 sandbox runtime"（https://code.claude.com/docs/en/sandboxing "What runs outside the sandbox"）。这直接说明：**对 Claude 来说，要对文件工具也生效，只能把整个 agent 进程包进外层沙箱**。
- 没查到：srt 对 macOS 钥匙串、`security` 命令访问的专门说明（README 提到 `enableWeakerNetworkIsolation` 为了 Go 程序验证 TLS 证书要放行 `com.apple.trustd.agent`，说明 macOS 上外层沙箱会影响系统服务访问）。

### 5.2 OpenAI Codex 的沙箱能否单独用
来源：Codex 浅克隆 `d681745`（2026-10-23，`codex-rs/cli/src/main.rs:196,470-491`、`cli/src/lib.rs:51-137`、`protocol/src/protocol.rs:1185-1215`）；https://learn.chatgpt.com/docs/developer-commands?surface=cli ；https://learn.chatgpt.com/docs/sandboxing 。
- 有 `codex sandbox` 子命令，文档称 Stable："Run arbitrary commands inside Codex-provided macOS, Linux, or Windows sandboxes"。源码里按平台分 `SeatbeltCommand` / `LandlockCommand` / `WindowsCommand`，都支持 `--permission-profile/-P <NAME>`（引用配置栈里的命名权限 profile）、`--cd`、`--include-managed-config`。即可以让任意命令吃 Codex 的 permission profile；没查到的是它能不能作为独立的"包住别的 agent 的外壳"推荐用法。
- Codex 文档（sandboxing 页）：macOS 用 Seatbelt；Linux 先用 PATH 里的 `bwrap`，没有就用自带 helper（需要非特权 user namespace，Ubuntu 24.04 可能要 AppArmor profile）；Windows 原生沙箱或 WSL2 用 Linux 实现。三个 sandbox mode：`read-only`、`workspace-write`、`danger-full-access`；审批 `on-request` / `never`。页面里没有 Landlock，没有"嵌套沙箱""在别的沙箱 / 容器里运行"的说明。
- **外部沙箱模式**（源码 `protocol/src/protocol.rs:1197`）：`SandboxPolicy::ExternalSandbox { network_access }`，注释："进程已经在外部沙箱里。允许完整磁盘访问，同时遵守给定的网络设置"。即 Codex 协议里**预留了"我已经被外层包住了"的声明**，Codex 不再套自己的沙箱、只记录网络设置。（该变体在 app-server 配置里是否对外暴露，没核实。）
- 嵌套证据：`sandboxing/src/seatbelt_tests.rs:59,167,240,337,866,1391,2103`（测试代码，当时可读）多处判断 stderr 含 `sandbox-exec: sandbox_apply: Operation not permitted` 并据此跳过，说明**在已经处于 Seatbelt 里的进程中再套 sandbox-exec 会失败**（推断自测试逻辑，没找到苹果官方文字）。

### 5.3 Docker Sandboxes（`sbx`）
来源：https://docs.docker.com/ai/sandboxes/get-started.md（页面，搜索摘要标 Early Access，页面本身没提）。
- microVM，每个沙箱自己的 Docker daemon、文件系统、网络；宿主凭据、SSH key、宿主 docker socket 不在 VM 里。`sbx run --name <n> claude`；默认把当前项目目录读写挂进去（或 clone 模式：私有克隆）。网络策略三档：Open / Balanced（默认拒绝 + 常用开发站点）/ Locked Down，`sbx policy allow network <host>`；Locked Down 下连模型 API 也要手动放行。凭据：OAuth 令牌留在宿主；`sbx secret set` 注入。搜索结果称支持 Claude Code、Codex、Copilot、Cursor、Droid、Gemini、Kiro、OpenCode 等（二手摘要，页面本身没列全）。旧的 `docker sandbox` 命令标 deprecated，被 `sbx` 取代。管理员可通过 Docker Admin Console 集中管理网络和文件策略。
- 代价（推断）：要 Docker 账号登录、microVM 需虚拟化；agent 在 VM 里看不到宿主钥匙串和已有登录态，要重新授权或经注入代理。

### 5.4 container-use（Dagger）
- https://github.com/dagger/container-use ：每个 agent 一个容器 + 一个 git 分支，通过 MCP（`container-use stdio`）接任何兼容 MCP 的 agent；README 称早期实验性；页面没有任何权限 / 审批模型，重点是透明（完整命令历史）。归类：容器隔离，不管权限。

### 5.5 E2B / Daytona 类
只简述：云端沙箱，把 agent 或其工具执行放远程；Hermes 文档把 modal / daytona / vercel_sandbox 列为容器后端（见上）。未单独研究。

---

## 6. Landlock 与 macOS sandbox-exec（只写与外层统一沙箱相关的）

- **Landlock**（https://docs.kernel.org/userspace-api/landlock.html）：Linux 5.13 引入；非特权进程自限（需 `no_new_privs`）；**可叠加，只能更严**，访问需所有层都允许，最多 16 层，子进程继承 → 天然可嵌套，外层再包一层不会和 provider 自己的 Landlock 冲突。能限制读写文件（`READ_FILE`/`READ_DIR` 等）；ABI 4 起有 TCP bind/connect 端口规则，ABI 6 起有抽象 Unix socket 与信号 scope，ABI 9 起 pathname Unix socket，ABI 10 起 UDP。限制：沙箱前已打开的文件不受限，`stat`/`chdir`/`access`/`chmod`/`flock` 等不能限制。网络规则按端口，**不是按域名**。→ 域名级网络仍要靠代理（srt 的做法）。
- **macOS `sandbox-exec`**：man page 标 deprecated 至少自 10.12；Apple DTS 说 profile 语言从未对第三方文档化，不算 API，`<sandbox.h>` 全部 deprecated（搜索结果摘要，来自 jmmv.dev、Swift forums、Apple Developer Forums 页）。但 Claude Code（srt）、Codex、Zed 都仍在用它。嵌套：我没有找到官方文字；只有 Codex 测试代码的间接证据（见 5.2）。**没查到**苹果对"已在沙箱内的进程再 apply"的正式说明。
- **bubblewrap**：Linux 嵌套需要 user namespace；srt 在默认模式下禁止沙箱内再建 user namespace（见 5.1），Codex 自带 helper 也需要非特权 userns（Codex 文档）。Ubuntu 24.04 的 AppArmor 限制非特权 userns 是已知问题（Codex 文档提到需要 AppArmor profile）。

---

## 7. 主流做法归类

| 做法 | 代表 | 优点 | 缺点 | 加 provider 的成本 |
|---|---|---|---|---|
| A. 透传原生 mode / config | Zed（外部 agent）、Paseo（ACP 系）、Vibe Kanban（每家一个配置结构）、Omnara | 不丢信息，语义由 agent 自己负责；ACP 下几乎零适配 | 用户面对每家不同的名字和语义；宿主说不清"这个群到底能干什么"；无法做统一的群级策略；mode 名不保证和沙箱有关（ACP 示例 `ask/architect/code` 只是习惯） | 低：ACP 系自动发现；非 ACP 要逐个写适配 |
| B. 宿主自定统一档位，再逐家翻译 | Happier（read_only/default/auto/yolo）、CodexMonitor（单家）、OpenClaw（宿主自己的 tool/sandbox 策略） | 用户只学一套；群级策略可表达、可审计 | 翻译会漏：Pi 的 read-only 只是工具白名单，Auto 不是边界（Happier 文档自认）；各家能力不等价，档位语义被迫取最小公倍数或诚实标注；每家升级都要跟 | 中到高：每个 provider 一份映射 + 测试 + 能力声明 |
| C. 外层统一沙箱（OS 级包住 agent 进程） | srt、`codex sandbox`、Docker `sbx`、Claude 官方文档建议 | 一处实现读 / 写 / 网络三项，对任何 provider 生效，包括 Claude 的文件工具（它们在内置沙箱外） | 嵌套：macOS Seatbelt 不能嵌套（间接证据），所以 provider 自带沙箱要关或改成 external 声明（Codex 有 `ExternalSandbox`）；agent 要访问自己的配置、登录态、钥匙串，要给例外；srt 仍是 beta；macOS `sandbox-exec` 已弃用；网络域名过滤靠代理，TLS 工具要额外放行 | 低：新 provider 只需把启动命令前缀交给外壳；但每家需要一份"必须放行的路径和域名"清单 |
| D. 客户端代办文件 / 终端 | ACP v1 的 `fs/*`、`terminal/*` | 宿主能在文件读写口子上做拦截 | 采用率低，ACP v2 计划删除；agent 的其他工具（自带 shell 等）绕过；Paseo 默认关 fs、只开 terminal | 高且在退化 |
| E. 容器 / 工作树隔离，不管 agent 内部权限 | Sculptor（二手）、container-use、Crystal、Claude Squad、Conductor、Hermes 容器后端（免审批）、OpenClaw 沙箱 | 概念简单；跑偏了可丢弃；Hermes 明确"容器即边界，免审批" | worktree 只隔离分支，不限制读 home 或联网；容器要重新处理登录态、凭据、工作区映射；对 Mac 原生工具链不友好 | 低到中 |

补充观察：
1. 这些做法不是互斥。Zed 对外部 agent 走 A，对自家 agent 走 B+C（自带沙箱，提升请求带 `allow_thread`/`allow_always`）。Hermes 和 OpenClaw 同时用白名单（谁能说话）+ 容器（边界）+ 聊天审批。
2. ACP 协议组织者自己的方向是 A（交给 agent）并预告"将探索 agent 沙箱配置的标准"，**目前没有**标准。

## 8. 群聊 / 多人 / 远程场景：谁能批准

| 产品 | 做法 | 来源 |
|---|---|---|
| OpenClaw | 信任边界按 gateway；先过 `groupPolicy` / `groupAllowFrom` 决定谁能触发；`execApprovals.approvers` 显式审批人，没设就由 `commands.ownerAllowFrom` 推断；发起人不必是审批人；群里提示对全群可见但批准权只属于审批人；owner 专属命令的审批私下走；30 分钟超时按拒绝 | docs.openclaw.ai（文档） |
| Hermes Agent | 先用白名单决定谁能用；危险命令在聊天里等回复；300 秒超时拒绝；**文档没写群里谁能批** | 文档 |
| Happy | 有 multiplayer 会话（邀请别人观看，两人都能 steer）；权限处理文档没写 | README（文档） |
| Paseo | 语义权限 + 配对邀请；owner/operator/viewer 预设；agent 权限请求谁批没写 | `docs/permissions.md`（文档） |
| Omnara | 单人手机，主人批 | 商店页（二手） |
| Zed / Conductor / Vibe Kanban / Crystal / Claude Squad / CodexMonitor | 单人桌面，不涉及 | — |

没有查到任何产品在群聊里给出"发消息的人 ≠ 审批人"之外更细的模型（例如按人分权限档、按动作分审批人）。OpenClaw 是我找到的唯一把"触发者名单、命令授权名单、审批人名单"分成三个独立名单的产品，并明说不隔离互不信任的用户。

---

## 9. 对 vonvon 的启示（均为推断）

1. **三档名字不要再当"对外的权限抽象"硬翻译到每家。** 公开资料里唯一做统一档位的 Happier 自己承认某些 provider 的档位"不是边界"。更稳的拆法是把"意图（读 / 写 / 网络）"和"由谁兑现（外层沙箱 / provider 自带 / 仅靠审批）"分开，在界面上能说清每个群当前由谁兑现。
2. **把真正的边界放在 vonvon 自己控制的外层，而不是依赖每家的 mode。** 理由：Claude 的内置沙箱只管 Bash，文件工具在沙箱外（官方文档），所以 Claude 的"只读"光靠 mode + hook 是软的；外层 OS 沙箱（srt 的 bwrap / Seatbelt，或 Linux 上直接用 Landlock）对所有 provider 一视同仁，加 provider 时不用重新证明"它的只读是不是真的只读"。
3. **provider 自带沙箱要能"让位"。** Codex 协议里有 `ExternalSandbox`（源码），说明厂商也预期被外层包住；macOS Seatbelt 在已有沙箱内再 apply 会失败（Codex 测试间接证据），所以外层包住之后，要把内层关掉或声明为 external，而不是两层都开。需要在 macOS 上实测：srt 包住 Codex / Claude 后是否正常启动、登录态（钥匙串）是否可读。
4. **Linux 上 Codex 沙箱不限制读，这个问题可由外层沙箱绕开。** srt 在 Linux 上支持 `denyRead` / `allowRead`，Landlock 也支持读限制；不必再用"Linux 上直接拒绝启动只读档"来处理。需要验证 srt 在这台 2 CPU VPS 的 bwrap 条件下的行为（本次未运行）。
5. **网络只提供"开 / 关 / 域名白名单"三态，域名过滤要靠代理。** Landlock 的网络规则只到端口（ABI 4+），srt 才有域名级过滤。注意模型 API 本身也要放行（Docker Locked Down 下模型 API 也被封，是同类陷阱）。当前"允许网络访问"开关可以保留，但底层用域名白名单更灵活。
6. **mode 与权限分开建模。** ACP 的方向是 Config Options（category `mode`/`model`/`thought_level`）取代 Modes，v2 删除 modes API。vonvon 如果接 ACP 系 provider，应把 provider 自报的 mode 当作"工作方式"（plan / ask / code）原样透传，不要把它和"权限档"混为一谈；权限档由 vonvon 自己的字段承载。
7. **审批人要有明确的数据模型，OpenClaw 的拆分可借鉴。** 至少区分：谁能触发（群成员白名单）、谁能执行高危命令（命令授权）、谁能批准（审批人，默认 owner，发起人不自动成为审批人）、批准提示发到哪里（群里可见但仅审批人可点，高危的私发）。超时默认拒绝，且写进 agent 的回复让它知道没执行。
8. **"总是允许"的作用域必须自己定义。** ACP 的 `allow_always` 没规定范围和存放；Zed 为此在自家流程里用 option id 区分"本线程"和"永久"。群聊里建议至少区分"本次 / 本会话 / 本群绑定"，且不跨群、不跨人继承，存在 vonvon 一侧而不是 provider 一侧。
9. **不要押注 ACP 的 fs/terminal 代办。** v2 草案要删；Paseo 也默认关 fs。若需要宿主拦截，走外层沙箱或在 vonvon 的审批流里拦截，而不是靠 client capability。
10. **容器 / microVM 作为可选的"更高隔离档"而不是默认。** Docker `sbx`、Hermes 容器后端、OpenClaw 沙箱都说明容器适合远程 / 公共场景（陌生人可触发的群），但会丢本机登录态、钥匙串和 Mac 原生工具链；对"在本机工作区干活"的主场景，OS 级外层沙箱的摩擦更小。可以把"公开群"这类高风险场景预留给容器后端（推断，未做原型验证）。
11. 未验证、建议在落地前各做一次小实验：srt 在 macOS 上包 Codex app-server / Claude Agent SDK 的可行性与钥匙串访问；provider 自带沙箱与外层沙箱同时开时的失败表现；srt beta 版本的稳定性（版本 0.0.81 变化很快，README 提到 0.0.79 后改了 ask 回调语义）。

---

## 附：来源与未覆盖

- 仓库浅克隆（临时目录，已读完）：agent-client-protocol（2026-10-23）、zed `9e84b066`（2026-10-22）、sandbox-runtime `aceba12` v0.0.81（2026-10-21）、vibe-kanban `d5cbb53`（2026-09-19）、crystal `1e18e0b`（2026-02-26）、claude-squad `ce1ffb4`（2026-08-20）、CodexMonitor `dd61b9a`（2026-03-26）、codex `d681745`（2026-10-23，另一位调研者的克隆，只读）。
- 克隆失败（大仓库网络断开）：paseo、happy、openclaw、hermes-agent，改读官方文档和 raw 文件，所以这四个没有行号级源码证据。
- 没查到：Conductor 和 Sculptor 的权限细节；Nimbalyst；Omnara 官方文档；Happy 本体的权限源码；Zed 对外部 agent `allow_always` 的持久化位置；macOS 嵌套 Seatbelt 的苹果官方说明；E2B / Daytona 的细节。
