# 四家 provider 原生权限模型调研（A 组：Codex / Claude / Gemini CLI / Qwen Code）

调研日期 2026-10-23。只读调研，没有改仓库，没有安装或运行任何 CLI。

## 0. 版本与资料来源

| 对象 | 版本或快照 | 资料 |
|---|---|---|
| OpenAI Codex | GitHub 最新发布 `rust-v0.164.0`（2026-10-23 发布）；源码读的是 main `d681745`（2026-10-23） | 文档 `https://learn.chatgpt.com/docs/*.md`（permissions、sandboxing、sandboxing/auto-review、agent-approvals-security、agent-configuration/rules、app-server、extend/mcp、config-file/config-reference）；源码 `openai/codex` 的 `codex-rs/` |
| Claude Code / Agent SDK | 文档里写到 Claude Code v2.1.302（2026-10-23 抓取）；SDK 版本没单独查 | `https://code.claude.com/docs/en/{permissions,permission-modes,sandboxing,settings-reference,hooks,agent-sdk/permissions,agent-sdk/user-input,agent-sdk/typescript,agent-sdk/claude-code-features}.md`；Claude Code 闭源，没有源码可读，所以 Claude 一节全部是**文档** |
| Gemini CLI | main `a713410`（2026-10-22），`package.json` 版本 `0.67.0-nightly.20261020` | 仓库 `google-gemini/gemini-cli` 的 `docs/` 和 `packages/` |
| Qwen Code | 文档取自 main（2026-10-23 抓取）；最近一次发布标签是 `sdk-typescript-v0.1.22`（2026-10-22），CLI 本体版本号没查到 | `https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/{features/approval-mode,features/sandbox,features/headless,configuration/settings,configuration/trusted-folders}.md`、`docs/developers/sdk-typescript.md`。源码浅克隆两次都超时，**Qwen 只读了文档，没读源码** |

标注：**文档** = 官方文档；**源码** = 官方仓库代码；**推断** = 我由事实推出，没有直接证据。

先读过的已有调研：`approval-ux.md`（审批体验）、`multi-workspace.md`（多目录）、现有映射代码 `permission.ts`、`workspace-policy.ts`、`backend.ts` 的 `sandboxParams`。本报告不重复审批卡片的体验细节，只补权限模型本身，并在第 7 节列出对旧结论的更正。

---

## 1. 对照表

图例：OS = 操作系统级沙箱（子进程跑不出去）；进程内 = 只在 agent 进程里按规则拦（模型换个工具、换个写法可能绕过）。

| | Codex | Claude Code / Agent SDK | Gemini CLI | Qwen Code |
|---|---|---|---|---|
| **a. 维度，哪些独立** | 文件读范围、文件写范围、网络（开关加域名）、命令级放行（execpolicy 规则）、问人策略（approval policy）、问人的人（user 或 auto_review）、MCP/应用工具审批模式，都是独立旋钮。新版 permission profile 把读、写、网络放进一个命名对象；旧的 `sandbox` 三档把读写绑在一起，读固定全盘可读 | 权限模式（管问不问）、allow/ask/deny 规则（管哪个工具、哪个路径）、沙箱（只管 Bash 的读写网络）、附加目录，四套互相独立。读范围在沙箱外只能靠 `Read` deny 规则，在沙箱内靠 `denyRead` | 审批模式（default/auto_edit/yolo/plan）、policy 规则（按工具名加参数正则）、沙箱（整个进程或单个工具）、受信文件夹，互相独立。没有按路径的读写规则，路径限制来自内置工具对"工作区"的硬编码校验 | 和 Claude 很像：审批模式、`permissions.allow/ask/deny` 规则、Linux 工具沙箱 `tools.executionSandbox`（读写和网络各一个值）、受信文件夹。读范围没有独立旋钮 |
| **b. 原生档位** | 旧：沙箱 `read-only` / `workspace-write` / `danger-full-access`，审批 `untrusted`（已退役）/ `on-request` / `granular{…}` / `never`。新：内置 profile `:read-only`、`:workspace`、`:danger-full-access`，自定义 `[permissions.<名字>]`，可 `extends`。界面预设：Read Only、Auto（workspace-write+on-request）、Full Access | 权限模式 `default`（界面叫 Manual）、`acceptEdits`、`plan`、`dontAsk`、`auto`、`bypassPermissions`。沙箱两种：auto-allow（沙箱内的 Bash 免问）和 regular | `--approval-mode`：`default`、`auto_edit`、`yolo`、`plan`；配置文件里 `yolo` 不能设，只能命令行。沙箱 macOS 六个 Seatbelt profile；Docker/Podman/gVisor(runsc)/LXC | 五个模式：`plan`、`default`（界面叫 Ask Permissions）、`auto-edit`、`auto`（LLM 分类器，开箱默认）、`yolo` |
| **c. 强制方式、读能不能限** | **OS 级**：macOS Seatbelt；Linux bwrap+seccomp（旧 Landlock 选项对受限策略被拒）；Windows MXC。管所有 Codex 起的命令子进程，不管 MCP、web search、应用连接器、浏览器、Computer Use。**读可以限**：profile 里 `":root"="deny"` 加 `":minimal"="read"`，Linux 和 macOS 都支持；旧的 `sandboxPolicy` 里受限读已被源码拒绝 | 沙箱 **OS 级但只包 Bash/PowerShell/Monitor 及其子进程**：macOS Seatbelt，Linux/WSL2 bubblewrap。内置 Read/Edit/Write/WebFetch/WebSearch、本地 MCP、hooks 在沙箱外，只靠权限规则（进程内）。沙箱内默认**全盘可读**，可用 `denyRead` 收窄；沙箱外的 Read 工具用 `Read(...)` deny 规则，文档自己说是"尽力而为"，对 Python/Node 脚本间接读文件无效 | 默认**进程内**：内置 read/write/edit 工具校验路径必须在工作区（加项目临时目录）内，读和写都限；shell 工具不受此限。OS 级沙箱可选：Docker/Podman/runsc/LXC（整个 CLI 进到容器，只看得到挂载进去的目录，读写都被限）、macOS Seatbelt（`strict-*` profile 限读）、新的工具级沙箱 `security.toolSandboxing`（默认**关**；Linux bwrap 是 `--ro-bind / /`，读全盘） | 进程内规则加可选 OS 沙箱。Linux 工具沙箱：bwrap 或 Landlock，覆盖 shell 与 Read/Write/Edit 等；文档明说"读仍然很宽，不隐藏宿主机密钥"。macOS 只有整个 CLI 进 Seatbelt（只限写）；Docker/Podman 同 Gemini。ACP 和 `qwen serve` 明确拒绝工具沙箱 |
| **d. 程序化宿主能设什么、粒度** | app-server：`thread/start` 设 `cwd`、`runtimeWorkspaceRoots`、`approvalPolicy`、`approvalsReviewer`、`sandbox`（旧三档）或 `permissions`（命名 profile，实验）、`config`（任意配置覆盖）。`turn/start` 和实验的 `thread/settings/update` 能**每轮改**同样这些。粒度：进程、线程、轮都可 | SDK `query()` 选项：`permissionMode`、`allowedTools`、`disallowedTools`、`sandbox`、`additionalDirectories`、`settingSources`、`managedSettings`、`hooks`、`canUseTool`。运行中：`setPermissionMode()`（需 streaming input）、`applyFlagSettings()`（改 `permissions`、`hooks`，下一轮生效）。粒度：会话、轮 | 命令行 `--approval-mode`、`--sandbox`、`--policy`、`--admin-policy`、`--include-directories`；环境变量 `GEMINI_SANDBOX`、`GEMINI_CLI_HOME`。ACP：`setSessionMode` 运行中切模式（含 yolo）。沙箱和策略文件只能按进程定 | SDK：`permissionMode`、`canUseTool`、`allowedTools`、`excludeTools`、`setPermissionMode()`（运行中）；headless 命令行 `--approval-mode`、`--yolo`、`--safe-mode`。工具沙箱只能在 User/System 设置里开，工作区设置不能动它 |
| **e. 问人：宿主能不能答、选项、无人时默认** | 能。`item/commandExecution/requestApproval` 等四类服务端请求；回答 `accept` / `acceptForSession` / `acceptWithExecpolicyAmendment`（永久写规则）/ `applyNetworkPolicyAmendment`（永久写域名规则）/ `decline`（继续）/ `cancel`（中断）。无人时看策略：`never` 直接拒；其余无人回答就一直等 | 能。`canUseTool` 回调，返回 `allow`（可带 `updatedInput`、`updatedPermissions` 写规则，目的地可选 session/本地/项目/用户设置）或 `deny{message, interrupt}`。无回调时需要问的调用直接被拒；SDK 自 v2.1.302 起不设模式就是 default，同样拒。`permissionPrompts:'none'` 强制全拒 | 能（ACP）。`requestPermission`，选项 `allow_once`、`allow_always`（本会话）、`allow_always`+保存（永久写策略）、`reject_once`。headless 下 `ask_user` 当 `deny` | 能。SDK `canUseTool`，超时 1 分钟自动拒；headless 默认模式下写工具被拒，除非 `allowedTools` 或 `--yolo` |
| **f. 读不读用户全局配置、会不会放宽** | 会。配置层优先级：用户 `~/.codex/config.toml`（20）< 项目 `.codex/`（25，需信任）< 会话参数 `thread/start.config`（30）< 旧版托管（40/50）。所以宿主传的值压得过用户和项目配置，但**用户的 `~/.codex/rules/*.rules` 里的 allow 规则会让命令绕过沙箱直接执行**（源码，见 2.7） | 会。默认读用户、项目、本地三层设置，含 allow 规则和 hooks。`settingSources: []` 全关；托管策略、`~/.claude.json`、自动记忆、claude.ai 连接器**不受它控制**。deny 任何一层都压过 allow | 会。`~/.gemini/settings.json`、`~/.gemini/policies/*.toml`（用户层，优先级 4）。项目层要受信文件夹。`GEMINI_CLI_HOME` 整个换掉 | 会。`~/.qwen/settings.json`、项目 `.qwen/settings.json`（需受信）。`--safe-mode` 关掉自定义；`QWEN_HOME` 换目录 |
| **g. 已知缺口** | 见 2.8。要点：profile 里开了网络但没开 `features.network_proxy`，域名规则不生效；MCP、web search、连接器不受沙箱约束；glob 型 deny-read 只在进程启动时快照；文档与源码在受限读上矛盾 | 见 3.8。要点：沙箱只包 Bash；`denyRead` 不拦 Read 工具；域名前置可绕域名过滤；`bypassPermissions` 下沙箱外重试免问 | 见 4.8。要点：默认 shell 不受路径校验；工具沙箱默认关且读全盘；Workspace 策略层文档说"不可用" | 见 5.6。要点：工具沙箱仅 Linux 且读很宽；ACP 拒绝沙箱；`yolo` 不开沙箱 |

---

## 2. OpenAI Codex

### 2.1 维度

- **审批策略**（源码 `codex-rs/protocol/src/protocol.rs:1097-1120`）：`untrusted`（内部用，项目标 untrusted 时）、`on-request`（默认）、`granular{sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations}`、`never`。`granular` 里某项为 false 就自动拒绝那类提示（同文件 :1109-1137）。文档说 `approval_policy="untrusted"` 已不再支持（`agent-approvals-security.md`，"Migrate from the retired `untrusted` approval policy"）。
- **沙箱**：旧三档 `read-only` / `workspace-write` / `danger-full-access`（源码 `protocol/src/config_types.rs:104-114`）；`workspace-write` 另有 `writable_roots`、`network_access`、`exclude_tmpdir_env_var`、`exclude_slash_tmp`（`app-server-protocol/src/protocol/v2/permissions.rs:541-567`）。
- **审批人**：`approvals_reviewer` = `user` 或 `auto_review`（旧名 `guardian_subagent`）（`config_types.rs:183-190`）。
- **维度之间的绑定**：旧沙箱里读固定全盘可读，网络是一个布尔值；文档说"权限 profile 不与旧沙箱设置组合，二选一"，只要加载的任何配置里出现 `sandbox_mode`、命令行传了 `--sandbox`，或所选配置 profile 设了 `sandbox_mode`，就用旧设置（`permissions.md` 开头，**文档**）。网络"开关"和"域名过滤"是两个独立的东西：`network.enabled` 只放开网络，真正过滤域名要另外打开 `features.network_proxy`，否则直接连、没有域名限制（`permissions.md` "Network permissions"，**文档**）。

### 2.2 权限 profile（beta，`default_permissions` 与 `[permissions.<名字>]`）

全部来自 `permissions.md`（**文档**），源码里 `app-server-protocol` 对应字段见 2.5。

- 内置：`:read-only`、`:workspace`（写入当前工作区根与系统临时目录）、`:danger-full-access`。自定义 profile 可 `extends` 内置或别的 profile，但不能 extends `:danger-full-access`；拒绝未知父级和循环继承。扩展 `:workspace` 会继承 `.git`、`.agents`、`.codex`、`.aws` 只读的保护。
- 文件系统值只有三种：`read`、`write`、`deny`。更具体的路径压过更宽的；同一路径上 `deny` > `write` > `read`。`deny` 同时禁读和禁写。可以在一个 `deny` 的大目录里再开一个更窄的子目录。
- 特殊键：`:root`（整个文件系统）、`:minimal`（常见工具运行必需的平台和运行时路径）、`:workspace_roots`（当前会话的工作区根加 profile 自带的 `workspace_roots`）、`:tmpdir`、`:slash_tmp`；另有 `/绝对路径`、`~/路径`。`:workspace_roots` 下可带相对子路径作用域，如 `"**/*.env" = "deny"`；子路径不能含 `..`。
- `[permissions.<名字>.workspace_roots]`："路径" = true，把额外目录并入工作区根集合。
- 空的或缺失的 `filesystem` 表 = 文件系统访问仍受限，并启动告警。
- deny 的 glob：Linux、WSL、Windows 上，匹配到的文件在**每个沙箱进程启动时枚举一次**，之后新建的同名文件对这个已运行的进程仍然可读；无上界的 `**` 要设 `glob_scan_max_depth`。`read`/`write` 的 glob 在 Linux 等上"可移植性差"，建议用精确路径。
- 网络：`network.enabled`、`network.domains`（`"host" = allow|deny`，支持 `*.x.com`、`**.x.com`、全局 `*` 仅限 allow，deny 压 allow）、`network.unix_sockets`、`proxy_url`、`allow_local_binding`（默认 false，回环、链路本地、私网默认被挡，主机名解析到私网也挡）。没有 allow 条目时，开了代理会挡掉所有外部目的地。
- 三种网络状态：关 = 不通（代理开不开都一样）；开且代理关 = 直连、无域名限制；开且代理开 = 走代理、按域名规则。
- 托管：`requirements.toml` 里 `allowed_permission_profiles` 一旦存在，没列出的 profile（含未来新增的内置）全部被禁。

### 2.3 命令级规则（execpolicy，`.rules`）

来自 `agent-configuration/rules.md`（**文档**，标注"experimental"）。

- 位置：每个生效配置层旁边的 `rules/` 目录，如 `~/.codex/rules/default.rules`；项目 `<repo>/.codex/rules/` 只有项目 `.codex/` 层受信时才加载。TUI 里选"以后都允许"会写进用户层 `default.rules`。
- 语法 Starlark 的 `prefix_rule(pattern=[...], decision="allow|prompt|forbidden", justification=..., match=[...], not_match=[...])`。多条规则命中取最严的：`forbidden` > `prompt` > `allow`。
- 它管的是"哪些命令可以**在沙箱外**运行"。`bash -lc "a && b"` 这类线性链会被 tree-sitter 拆开逐条判；含重定向、替换、变量赋值、通配符、控制流的脚本不拆，整条当一个调用。
- **源码确认**：命中显式 `allow` 前缀规则且所有拆出的命令段都被显式 allow 时，`bypass_sandbox: true`（`codex-rs/core/src/exec_policy.rs:446-460`）。也就是说 allow 规则 = 不进沙箱直接跑，**不受宿主选的沙箱档位约束**。
- `never` 策略下，需要弹的提示（含规则触发的 prompt）直接被拒（`exec_policy.rs:214-243`，`AskForApproval::Never => Some(PROMPT_CONFLICT_REASON)`）。
- 命令行 `codex exec` 有 `--ignore-user-config`、`--ignore-rules`（源码 `exec/src/cli.rs:45-50`）。app-server 内部有同名 loader 开关（`app-server/src/config_manager.rs:450`，只在"回落到默认配置"路径上设置），**app-server 的 `thread/start` 参数里没找到对应开关**（没查到客户端可用的开关；本报告没有逐个读完 app-server 的启动参数）。

### 2.4 强制方式与平台

- 文档 `permissions.md` "How enforcement works"、`agent-approvals-security.md` "OS-level sandbox"、`sandboxing.md`（**文档**）：
  - macOS：Seatbelt 配置经 `sandbox-exec`；"如果所选策略平台沙箱执行不了，Codex 拒绝运行命令，而不是静默不加沙箱"。
  - Linux 与 WSL2：bubblewrap 加 seccomp。旧 Landlock 选项"无法隔离 app-server 的 Unix socket，对受限文件系统策略会被拒绝"。需要用户命名空间；Ubuntu 24.04 的 AppArmor 限制可能让 bwrap 起不来，要额外装 AppArmor profile 或改 sysctl；容器里可能整个跑不起来，文档建议此时 `danger-full-access` 并让容器做边界。
  - Windows：MXC 为首选，`elevated` 与 `unelevated` 是旧回退，`unelevated` 网络隔离较弱且不能执行所有"读写分开"的切口，受不了的策略直接拒绝。
- 沙箱适用范围：Codex 起的命令子进程（`git`、包管理器、测试跑器都继承）。**不管**：MCP 服务器、连接器/应用、web search、浏览器与 Computer Use、Codex 自己的模型和认证流量（`permissions.md` "What the network proxy does not control"、"What profiles control"）。
- 受保护路径：可写根下的 `.git`（文件或目录；gitdir 指针文件会连带保护解析后的 git 目录）、`.agents`、`.codex`、`.aws` 只读，递归（`agent-approvals-security.md` "Protected paths in writable roots"）。现有 `workspace-policy.ts` 的 `CODEX_PROTECTED_PATHS` 另加了 `.mcp.json`、`.claude/*` 等八项，是 vonvon 自己加的。

### 2.5 app-server 能设什么

源码：`app-server-protocol/src/protocol/v2/thread.rs:62-152`（`ThreadStartParams`）、`v2/turn.rs:170-262`（`TurnStartParams`）、`v2/thread.rs:236-276`（`ThreadSettingsUpdateParams`）。

| 字段 | thread/start | turn/start | thread/settings/update（实验） |
|---|---|---|---|
| `cwd` | 是 | 是（本轮及之后） | 是 |
| `runtimeWorkspaceRoots` | 是 | 是（替换） | 没看到 |
| `approvalPolicy` | 是（嵌套实验标注） | 是 | 是 |
| `approvalsReviewer` | 是 | 是 | 是 |
| `sandbox`（旧三档字符串） | 是 | 否（用 `sandboxPolicy` 对象） | 否 |
| `sandboxPolicy`（旧对象，含 `writableRoots`、`networkAccess`） | 否 | 是 | 是 |
| `permissions`（命名 profile id，实验） | 是（`thread/start.permissions`） | 是（`turn/start.permissions`） | 是 |
| `config`（任意配置覆盖，如 `permissions.<名字>`、`default_permissions`） | 是 | 否 | 否 |

- `permissions` 与 `sandbox`/`sandboxPolicy` 不能同时传。`permissionProfile/list`（带项目 `cwd`）可列出可用 profile 和托管要求是否允许（`app-server.md`，**文档**）。
- 轮级改动"成为同线程之后各轮的默认"（`app-server.md` "Turn start" 一段）。`turn/steer` 不接受这些覆盖。
- **文档与源码矛盾**：`app-server.md` 的 "Sandbox read access (`ReadOnlyAccess`)" 一节仍写 `readOnly.access` / `workspaceWrite.readOnlyAccess` 可以是 `restricted` 加 `readableRoots`。但源码 `v2/permissions.rs:607-649`（main，2026-10-23）在反序列化时对 `Restricted` 直接报错 "…is no longer supported; use permissionProfile for restricted reads"。以源码为准：**受限读只能走 permission profile**。现有 vonvon 代码走的正是 profile（`sandboxParams`），方向正确。
- 回显：线程响应里带 `sandbox`、`approvalPolicy`、`activePermissionProfile{id, extends}`（现有 `verifyCodexWorkspaceEcho` 已在核对，**推断**依据是该代码对回显字段的使用）。

### 2.6 问人

- 四类服务端请求（`app-server-protocol/src/protocol/common.rs:1816-1841`）：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`（agent 用 `request_permissions` 工具申请，可按 `scope: turn|session` 授予子集，可带 `strictAutoReview`）、`mcpServer/elicitation/request`。命令审批的回答枚举 `accept` / `acceptForSession` / `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` / `decline` / `cancel`（`v2/item.rs:68-87`）。
- `auto_review`：只在审批是交互式的（`on-request` 或 `granular`）时有意义；`never` 下无事可审。它只管本来要问人的请求（越权命令、被挡的网络、`request_permissions`、带副作用的 MCP/应用调用），沙箱内的动作不审。是"换审批人"，不扩大 `writable_roots`、不开网络、不削弱受保护路径。连续 3 次拒绝或最近 50 次内 10 次拒绝，会中断本轮。（`sandboxing/auto-review.md`，**文档**）
- MCP 审批模式：`default_tools_approval_mode` 取 `auto` / `prompt` / `writes` / `approve`；`tools.<工具>.approval_mode` 逐工具覆盖（`extend/mcp.md`，**文档**）。更细的行为（无注解默认要审批、`never` 下被拒）见 `approval-ux.md` 1.5，我没有重新核对。
- 无人回答：app-server 没给审批设等待上限（`approval-ux.md` 1.4 的结论，**推断**，本次没复查）。

### 2.7 用户全局配置会不会放宽宿主设置

- 配置层优先级（源码 `config/src/config_layer_source.rs:33-48`）：PackagedDefaults -10 < Mdm 0 < System 10 < EnterpriseManaged 15 < User 20（带 profile 21）< Project 25 < SessionFlags 30 < 旧版托管 40/50。宿主在 `thread/start.config`、`sandbox`、`approvalPolicy` 里传的值属于会话层，压得过用户层和项目层。（**推断**：`thread/start` 参数落在 SessionFlags 层，源码里该枚举的注释写 "Overrides supplied for the current session"，我没有逐行追到 `thread/start` 的合并代码。）
- 放不住的地方：
  1. `~/.codex/rules/*.rules` 的 `allow` 规则不走沙箱判定，直接 `bypass_sandbox`（2.3）。用户若装了 `prefix_rule(["git","push"], decision="allow")`，群里的 Codex 能直接 `git push`，哪怕宿主设了只读。**推断**：`approvalPolicy=never` 只挡"提示"，不挡"allow 规则放行"。
  2. 托管层（System、EnterpriseManaged、旧版托管）比会话层高或相当，宿主压不过。
  3. 项目 `.codex/` 层（25）在项目受信时能覆盖用户层；宿主传 `projects.<cwd>.trust_level="trusted"` 会让它生效（现有 `codexSessionParams` 就这么做）。这对 vonvon 意味着：工作区里的 `.codex/config.toml` 和 `.codex/rules` 会被加载。现有代码把 `.codex` 在可写根下设为只读，是对的。
- 隔离办法：`CODEX_HOME` 环境变量指向独立目录（`find_codex_home()`，`app-server/src/lib.rs:554`），**推断**可让用户层配置和 rules 不生效；命令行 `codex exec` 另有 `--ignore-user-config`、`--ignore-rules`。

### 2.8 已知缺口（官方文档自己写的）

- 开了 `network.enabled` 却没开 `features.network_proxy`：域名规则不生效，是直连（`permissions.md`）。
- 管理员的网络允许名单只对走托管代理的命令生效；"在策略允许完整沙箱升级并被批准的情况下，那次执行可以绕过命令代理"（`agent-approvals-security.md` "Network isolation"）。
- 代理的 DNS 重绑防护"尽力而为，不能杜绝"，对抗敌对 DNS 要在更低层做出口控制（同上）。
- 沙箱不管 MCP、web search、连接器、浏览器（见 2.4）；Windows `unelevated` 不能执行所有切口；Linux 在容器里可能跑不起来。
- deny 的 glob 是进程启动时快照（2.2）。
- GPT-6 Astra 有"异步安全监控，可能在事后暂停任务"，文档说它不替代沙箱（`agent-approvals-security.md`）。
- 官方 issue 我没有逐条搜，**没查到** Codex 沙箱绕过类 issue 清单。

---

## 3. Claude Code / Claude Agent SDK

全部为**文档**（`code.claude.com/docs/en/...`，2026-10-23 抓取，文中版本号 v2.1.xxx 为文档自述）。

### 3.1 权限模式（`permissions.md` "Permission modes"、`permission-modes.md`）

| 模式 | 含义 |
|---|---|
| `default`（界面 Manual；`manual` 是别名） | 每种工具第一次用都问 |
| `acceptEdits` | 自动接受工作目录或附加目录里的文件编辑，以及 `mkdir`、`touch`、`mv`、`cp` 等常见文件系统命令 |
| `plan` | 只读探索，不改源码；只读命令可跑；auto 可用时分类器批准的命令也跑 |
| `auto` | 无常规提示，后台分类器在命令、网络请求等执行前审查 |
| `dontAsk` | 一切本来要问的都自动拒绝；已预先允许的（allow 规则、工作目录内读取）照常跑；`AskUserQuestion`、`requiresUserInteraction` 的 MCP 工具、网络路径读取一律拒 |
| `bypassPermissions` | 跳过提示，包括写 `.git`、`.claude` 这类受保护路径；"任何模式都不自动批准"的几类除外 |

"任何模式都不自动批准"（含 bypass）：ask 规则命中的工具；组织设为 ask 的连接器工具；`AskUserQuestion` 与 `requiresUserInteraction` 的 MCP 工具；识别到的关键路径 `rm`/`rmdir`；跨会话消息保护；开了 `permissions.blockReadsOutsideWorkingDirectories` 时的工作目录外读取与沙箱外重试（`permission-modes.md` "Actions no mode auto-approves"）。

SDK 不设模式时（Claude Code v2.1.302 起）从 `default` 开始，需要批准的调用被拒，除非有 allow 规则、hook、`canUseTool` 或 `--permission-prompt-tool`（`permission-modes.md` "Tool calls denied in `claude -p`…"）。**这条与 `approval-ux.md` 2.1 写的"不传时默认 `auto`"不同，见第 7 节。**

`bypassPermissions` 在 SDK 里要同时传 `allowDangerouslySkipPermissions`（`agent-sdk/typescript.md` options 表）。可用 `permissions.disableBypassPermissionsMode` / `disableAutoMode` = `"disable"` 禁掉这两个模式，放在任何设置层都生效。

### 3.2 规则语法（`permissions.md`）

- 判定顺序：**hooks → deny → ask → 权限模式 → allow → `canUseTool`**（`agent-sdk/permissions.md` "How permissions are evaluated"）。任何一层的 deny 都不能被别层 allow 推翻；PreToolUse hook 返回 `allow` 也不能越过 deny 和 ask 规则。
- 写法 `Tool` 或 `Tool(specifier)`。
  - `Bash(npm run *)`：命令前缀加通配；会拆复合命令、认包装器（`timeout`、`xargs` 之类），"Bash 规则不匹配什么"有专门一节；对重定向有单独处理。
  - `Read(path)`、`Edit(path)`：`Edit` 规则管所有写文件的内置工具；`Write(path)`、`NotebookEdit(path)`、`Glob(path)` 规则**永远不匹配**，要写 `Edit(...)` / `Read(...)`。`Read` deny 同时挡 Edit/Write 对同一路径的操作。路径锚点：`//path` 绝对路径、`/path` 相对规则来源（SDK 的 `allowedTools` 里指会话工作目录）、`~/` 家目录。支持 gitignore 风格通配与 `!` 取反；符号链接另有规则。
  - `WebFetch(domain:example.com)`，沙箱对 `*.` 前缀和单独 `*` 通配生效。
  - MCP：`mcp__server__tool`；allow 规则里的通配只能出现在字面 `mcp__<server>__` 之后；deny 里 `"*"`、`"mcp__*"` 可用。
  - 子代理 `Agent(...)`、`Cd(...)` 规则也有。
- 裸名 deny（如 `Bash`）会把工具从模型上下文里整个拿掉；带限定的 deny 才在运行时判（`agent-sdk/permissions.md`）。
- SDK 里 `allowedTools` 只是预批准，**不限制** `bypassPermissions`：`allowedTools=["Read"]` 加 bypass 仍然批准一切（同上警告）。想"只能用这几个"要配 `permissionMode:"dontAsk"`。
- 项目 `.claude/settings.json` 里的 `permissions.allow` 和 `additionalDirectories` 要用户接受信任对话框之后才生效；`claude -p`/SDK 从不弹对话框，所以这些规则**不生效**（`permissions.md` "Project allow rules and workspace trust"）。但项目里的 hooks、`env`、`apiKeyHelper`、`.mcp.json` 服务器在 SDK 下会被使用。

### 3.3 附加目录（`permissions.md` "Working directories"）

- 来源：`--add-dir`、`/add-dir`、设置里的 `additionalDirectories`。附加目录里文件的读写权限和主目录一样（读免问，写看模式）。
- 只给文件访问，不给配置：仅 `--add-dir`/`/add-dir`/SDK 的 `additionalDirectories` 选项（SDK 内部就是传 `--add-dir`）能额外加载 skills、commands、subagents；设置文件里的 `additionalDirectories` 不加载任何配置。
- `permissions.blockReadsOutsideWorkingDirectories`：让文件工具在所有模式下拒绝读工作目录外的路径；开启后沙箱内命令也失去对家目录等的读权限（`sandboxing.md` "Filesystem isolation"）。

### 3.4 沙箱（`sandboxing.md`、`settings-reference.md`）

- **默认关**。开关 `sandbox.enabled`；SDK `Options.sandbox` 同形。基于开源包 `@anthropic-ai/sandbox-runtime`。
- 只包 Bash、PowerShell、Monitor 的命令及其子进程。**不包**：Read/Edit/Write/WebFetch/WebSearch、本地 MCP 服务器、hooks、LSP、状态栏命令（它们靠权限规则）。`denyRead` 不拦 Read 工具，`allowedDomains` 不限 WebFetch（"What runs outside the sandbox"）。
- 文件系统默认：写 = 工作目录、每用户临时目录、附加目录；受保护路径仍写禁止；读 = **整台机器**（含 `~/.ssh`、`~/.aws/credentials`）。可配 `filesystem.allowWrite/denyWrite/denyRead/allowRead`；`Edit` allow 规则与 `allowWrite` 等价，`Read`/`Edit` deny 规则会并入沙箱配置。`sandbox.filesystem.disabled` 可关文件系统层只保网络层。
- 沙箱自带的受保护路径（命令在跑时也写不了）：工作目录及其上级的 `.claude` 设置、skills/agents/commands/hooks 目录、`.mcp.json`；工作目录里的 shell 启动文件、`.gitconfig`、`.vscode`、`.idea`、`.git/hooks` 与 `.git/config`；让工作目录变成裸仓库的 `HEAD/objects/refs`；`~/.claude`、`~/.claude.json`、`.credentials.json`。
- 网络：Linux/WSL2 在独立网络命名空间里没有出路；macOS 用 Seatbelt 只放行到本机代理的连接；代理按**主机名**核对允许名单（`allowedDomains` 起始为空，可配 `deniedDomains`、`strictAllowlist`、托管 `allowManagedDomainsOnly`）。不读代理变量的工具（普通 ssh、多数数据库驱动）连不出去；UDP、QUIC、ICMP 出不去。主机名解析到本机、链路本地或元数据地址会被拒。
- 允许名单以外的主机怎么办，看权限模式：`bypassPermissions` 放行（除非开了 `strictAllowlist`/托管锁），Manual 与 `acceptEdits` 问，auto 拒（除非命令自带主机并经分类器批准），`dontAsk` 拒。
- 两种沙箱模式：auto-allow（沙箱内的 Bash 命令免问，默认 `autoAllowBashIfSandboxed=true`）与 regular（仍走常规权限流）。
- 逃生口：Claude 可对失败命令带 `dangerouslyDisableSandbox` 重试。`bypassPermissions` 下**免问**；Manual/`acceptEdits` 弹窗；auto 交分类器；`dontAsk` 拒；匹配的 allow 规则也会批准重试。`allowUnsandboxedCommands:false` 关掉这个口子；`failIfUnavailable:true` 让沙箱起不来时拒绝启动而不是裸跑。
- 平台差异：macOS Seatbelt；Linux、WSL2 bubblewrap。Linux 的 `enableWeakerNestedSandbox` 为在 Docker 里跑而削弱隔离；`allowNestedUserNamespaces` 打开后"沙箱内代码可能跑到沙箱外"。macOS 的 `allowAppleEvents` 会让沙箱内命令不经提示启动别的应用，只接受用户、托管或命令行设置，项目设置不行。

### 3.5 hooks 与 `canUseTool`

- PreToolUse hook 在权限提示之前运行，对除 `EndConversation` 外所有工具生效；返回 `permissionDecision` = `allow` / `deny` / `ask` / `defer`（`defer` 让本轮以 `tool_deferred` 结束，之后可续跑），可带 `updatedInput` 改写参数（`agent-sdk/hooks.md`、`hooks.md`）。exit code 2 的阻止在权限规则求值**之前**，所以挡得住 allow 规则。
- hook 的 `allow` 不能越过 deny/ask 规则、不能批准关键路径 `rm`，在 plan 模式下对非只读调用无效。
- `canUseTool(toolName, input, options)`：`options` 含 `signal`、`suggestions`（`PermissionUpdate[]`，Bash 的建议默认目的地是本地设置文件）、`blockedPath`、`mcpServer`、`decisionReason`、`defaultToNo`、`suppressAlwaysAllowRule`、`toolUseID`、`agentID`、`requestId`（`agent-sdk/typescript.md`）。返回 `allow{updatedInput, updatedPermissions}` 或 `deny{message, interrupt}`。
- 关键陷阱：被更早环节自动批准的调用**到不了回调**（allow 规则、`acceptEdits`、`bypassPermissions`）。要对每个调用都把关，只能用 PreToolUse hook（`agent-sdk/user-input.md` 警告；SDK 对"回调被遮蔽"的配置发 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告）。
- 回调默认没有超时（`approval-ux.md` 2.2 的结论，本次未复查）；TS SDK `permissionPrompts:'none'`（v2.1.259 起）让一切本要问的调用直接被拒。
- `AskUserQuestion` 走回调，1 到 4 题、每题 2 到 4 项；子代理里不可用（`agent-sdk/user-input.md` "Limitations"）。

### 3.6 auto 模式分类器（`permission-modes.md` "Eliminate permission prompts with auto mode"）

- 决策顺序：规则先判；工作目录内的只读动作与文件编辑自动批准（受保护路径写、首次读工作目录外除外）；其余交分类器；分类器拦下时 Claude 收到理由。
- 默认拦：外泄、凭据探测、代码来自外部的执行、持久化、削弱安全、强推主分支等（"What the classifier blocks by default"，本次只读了结构）。可通过 `auto-mode-config`（管理员配置可信基础设施）调整。
- 回退：连续拦 3 次或累计 20 次，auto 暂停并回到提示；这两个阈值不可配置。**非交互 `-p` 没有提示可回退，达到阈值时动作不执行，Claude 继续工作，不中止运行。**
- 分类器不可用时：被拒，不放行。需要支持的模型（Opus 4.6+、Sonnet 4.6+、Haiku 5.5、Fable 系列等，Bedrock 等第三方云上更严）。服务端审查可由 `CLAUDE_CODE_AUTO_MODE_SERVER=0` 改回客户端分类器请求。
- 在 SDK 里 auto 模式对关键路径删除默认直接拒绝，不调回调（`agent-sdk/permissions.md`）。

### 3.7 托管设置与全局配置隔离

- 设置优先级：托管最高，命令行也压不过托管 deny；`allowManagedPermissionRulesOnly` 让托管成为权限规则的唯一来源。
- **宿主可以给 SDK 会话提供"策略层"设置**：`Options.managedSettings`（`agent-sdk/typescript.md` options 表）。但在装了管理员托管设置的机器上，只有管理员最高优先级来源设了 `parentSettingsBehavior:'merge'` 才会被合并，并且经过"只允许收紧"的过滤。这意味着 vonvon 作为嵌入宿主可以把 deny 规则放进策略层，用户的 `~/.claude/settings.json` 里的 allow 压不过它。**推断**：这是 SDK 给宿主的最强的"不被用户配置放宽"的手段，具体过滤规则文档指向 `claude-apps-gateway#restrict-parent-settings`，我没有读那一页。
- `settingSources: []` 关掉用户、项目、本地三层；但托管策略、`~/.claude.json`、自动记忆（`~/.claude/projects/<项目>/memory/`）、claude.ai 连接器、`sandbox.credentials` 的 deny 与 mask 条目**照读**。文档原话：不要靠默认 `query()` 选项做多租户隔离，每个租户放独立文件系统，加 `settingSources: []` 与 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（`agent-sdk/claude-code-features.md`）。可用 `CLAUDE_CONFIG_DIR` 换配置目录。
- 运行中改动：`setPermissionMode()`（仅 streaming input）；`applyFlagSettings()` 可在运行中改 `permissions`、`hooks`，**下一轮生效**，没有"删除键"（`agent-sdk/typescript.md`）。

### 3.8 已知缺口（文档自己写的）

- Read/Edit deny 只覆盖内置文件工具、能识别的 Bash 文件命令（`cat`、`head`、`sed`、`tee` 等）与重定向目标；不覆盖 `grep -r pattern .` 这种不点名文件的命令，也不覆盖 Python/Node 脚本自己开文件（`permissions.md` Read and Edit 一节警告）。要全进程拦只能开沙箱。
- 沙箱：代理按主机名放行、默认不检查 TLS，可被域前置绕过；放行 `github.com` 这类大域名有外泄通路。`allowUnixSockets` 放行 `docker.sock` 等于交出宿主。可写目录包含 `$PATH` 中的目录或 shell 配置文件会造成提权。
- 子代理继承：主会话是 `plan`/`acceptEdits`/`auto`/`bypassPermissions` 时子代理继承；"`bypassPermissions` 的子代理拥有完整自治权限"（`agent-sdk/permissions.md`）。
- `bypassPermissions` 下沙箱外重试免问、不在允许名单的主机免问（除非开了严格锁）。
- 本地 MCP、hooks、插件的子进程在沙箱外，以用户完整权限运行（`sandboxing.md`）。
- 没查到 Claude Code 官方 issue 里的绕过清单，本次没有搜 issue。

---

## 4. Gemini CLI

资料：仓库 `google-gemini/gemini-cli` main `a713410`（2026-10-22）的 `docs/` 与 `packages/`。

### 4.1 审批模式

- `--approval-mode` 取 `default`、`auto_edit`、`yolo`、`plan`（源码 `packages/cli/src/config/config.ts:340-346`；文档 `docs/cli/cli-reference.md:57`）。`--yolo` 已弃用。
- 设置项 `general.defaultApprovalMode` 的取值只有 `default`、`auto_edit`、`plan`；"YOLO 只能通过命令行启用"（`docs/reference/configuration.md:134-141`）。`security.disableYoloMode` 可强关 yolo（`:1944`），`security.disableAlwaysAllow` 关掉"总是允许"选项，`security.enablePermanentToolApproval` 才出现"以后所有会话都允许"。
- 含义：`default` 写工具要问；`auto_edit` 编辑类工具自动批；`plan` 严格只读；`yolo` 全自动（`reference/policy-engine.md` "Approval modes"）。信任层级 `plan < default < autoEdit < yolo`：在 plan 模式点的"永久允许"会把规则写成所有模式都生效，在别的模式点则只对当前及更宽松模式生效。

### 4.2 policy engine（`docs/reference/policy-engine.md`，**文档**）

- 规则文件 TOML，`[[rule]]`，字段：`toolName`（可数组，支持 `*`、`mcp_server_*`）、`mcpName`、`subagent`、`toolAnnotations`、`argsPattern`（对参数的稳定 JSON 串做正则）、`commandPrefix`、`commandRegex`、`decision`（`allow` / `deny` / `ask_user`）、`priority`（0 到 999）、`denyMessage`、`modes`、`interactive`、`allowRedirection`。
- 优先级：`最终优先级 = 层基数 + 文件内优先级/1000`；层：Default 1、Extension 2、Workspace 3、User 4、Admin 5。第一条命中的最高优先级规则生效。
- 位置：用户 `~/.gemini/policies/*.toml`；管理员系统目录 Linux `/etc/gemini-cli/policies`、macOS `/Library/Application Support/GeminiCli/policies`；系统目录必须 root 所有且组和其他不可写，否则整个目录被忽略；`--admin-policy` 与 `adminPolicyPaths` 可追加管理员层，但系统目录里一旦有 toml，追加的会被忽略。
- `deny` 且无 `argsPattern` 的全局规则，会把工具整个从模型视野里去掉。
- **没有按路径的读写规则类型**：要限制路径只能对 `read_file`/`write_file` 等的参数写 `argsPattern` 正则（**推断**：文档的规则字段里没有路径字段）。
- **headless（非交互）下 `ask_user` 当 `deny`**（`policy-engine.md` Decisions 一节）。`interactive=false` 的规则可专门为非交互场景定制。
- 默认策略：只读工具允许；写工具和 `run_shell_command` 默认 `ask_user`；`yolo` 有高优先级放行一切的规则；`autoEdit` 放行部分写入。
- 文档矛盾：文档警告 Workspace 层（项目 `.gemini/policies`）"目前不可用"（issue #18186）；但源码 `packages/core/src/policy/config.ts:69-160` 里有 `WORKSPACE_POLICY_TIER`、`workspacePoliciesDir`，且有 `integrity.ts`（用哈希核对项目策略有没有变）与 `workspace-policy.test.ts`。**没查到**当前是否实际启用。设计时不要依赖项目层，也别假设它不存在。

### 4.3 内置文件工具的路径限制（进程内）

源码 `packages/core/src/config/config.ts:3323-3450`：`isPathAllowed` / `validatePathAccess`，路径解析真实路径后必须在工作区目录（`--include-directories` 与设置 `context.includeDirectories` 可加）或项目临时目录内，否则返回 "Path not in workspace"。`read-file.ts`、`write-file.ts`、`edit.ts` 都先调用它。所以**读和写在内置工具上都被限在工作区内**。`run_shell_command` 不走这个校验，靠审批和沙箱。

### 4.4 沙箱（`docs/cli/sandbox.md`）

- 启用：`-s`/`--sandbox`，环境变量 `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`，或设置 `tools.sandbox`。
- macOS Seatbelt：profile 由 `SEATBELT_PROFILE` 选：`permissive-open`（默认，限写、读和网络宽）、`permissive-proxied`、`restrictive-open`、`restrictive-proxied`、`strict-open`（**读写都限**）、`strict-proxied`（读写限，网络走代理）。
- Docker/Podman：整个 CLI 进容器，工作目录按同一绝对路径挂入，容器外的东西看不到；`SANDBOX_MOUNTS=from:to:ro|rw` 额外挂载（默认只读）；`SANDBOX_FLAGS` 加参数。gVisor（`runsc`，仅 Linux，需显式指定，可用 `--network=none`）；LXC（仅 Linux，实验）。Windows 原生用低完整性级别（`icacls`），其改动会持久留在文件上。
- 工具级沙箱 `security.toolSandboxing`：对单个工具执行（如 shell、写文件）而不是整个进程隔离。**默认 `false`**（源码 `packages/cli/src/config/settingsSchema.ts:1835-1844`）。Linux 实现 `packages/core/src/sandbox/linux/bwrapArgsBuilder.ts`：`--unshare-all`，仅在 `networkAccess` 时 `--share-net`，`--ro-bind / /`（**全盘只读可见**），`--tmpfs /tmp`，工作区按 `--bind-try`（可写命令）或 `--ro-bind-try` 绑回；另有 `policyAllowed`、`policyRead`、`policyWrite` 额外挂载。macOS 对应 `sandbox/macos/`，Windows `sandbox/windows/`。
- 沙箱扩展（`sandbox.md` "Sandbox expansion"）：沙箱内命令因权限失败或被主动识别为需要更多权限（如 `npm install`）时，弹"Sandbox Expansion Request"，批准后只对这一次执行放宽。

### 4.5 受信文件夹与全局配置

- 受信文件夹（`docs/cli/trusted-folders.md`）：文档说默认**关**，要在用户设置里 `security.folderTrust.enabled=true`；而设置参考里同一项 `Default: true`（`reference/configuration.md:1983`）。两份文档矛盾，**没查到**真实默认值，需要在源码里再核（`settingsSchema.ts`）。
- 启用后，不受信文件夹进"安全模式"：忽略项目 `.gemini/settings.json` 与 `.env`，不能管理扩展，工具自动接受被禁用，不连 MCP，不加载自定义命令。headless 下遇到不受信文件夹会抛 `FatalUntrustedWorkspaceError` 退出，要绕过需用文档里列的方法（我没读全）。
- 信任记录在 `~/.gemini/trustedFolders.json`。
- 隔离用户配置：`GEMINI_CLI_HOME` 改写 `.gemini` 所在位置（`docs/cli/enterprise.md:215-245`，官方就写的是多租户或任务隔离场景）。管理员系统设置路径可用 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 覆盖。
- 用户层 `~/.gemini/policies/*.toml`（优先级 4）和 `~/.gemini/settings.json` 的 `tools.allowed` 都会被读到。宿主通过 `--admin-policy`（管理员层 5）加的规则压得过用户层，**前提**是系统目录里没有 toml（上面的安全守卫）。

### 4.6 headless 与 ACP

- ACP：`--acp` 启动 JSON-RPC。`setSessionMode` 在运行中切 `default` / `auto_edit` / `yolo` / `plan`（`packages/cli/src/acp/acpUtils.ts:224-250`、`acpSession.ts:215-225`）。`initialize` 里 `currentModeId` 初始为配置里的审批模式。
- 问人：`session/request_permission`，选项（`acpUtils.ts:80-170`）：`allow_once`（"Allow"）、`reject_once`（"Reject"）、`allow_always`（"Allow for this session"）、`allow_always`+保存（"Allow … for all future sessions"，即写进用户策略）、MCP 另有"此服务器所有工具本会话允许"。
- ACP 不声明附加目录：`--include-directories` 只能按进程加（`multi-workspace.md` 已记，本次未复查）。
- 沙箱和 `--policy`/`--admin-policy` 都是启动参数，运行中不能改。

### 4.7 hooks

文档有 `docs/hooks/`，BeforeTool 一类钩子可拦截工具。本次没有深读，**没查到**细节。

### 4.8 已知缺口

- 默认（不开任何沙箱）下 `run_shell_command` 不受路径校验，一旦批准或 `yolo`，命令可读写任何地方（源码 `shell.ts` 只对部分场景用 `isPathWithinWorkspace`，细节未读）。
- 工具级沙箱默认关；开了 Linux 也是读全盘（`--ro-bind / /`）。
- macOS 默认 profile 是 `permissive-open`：限写，不限读，不限网络。
- Workspace 策略层文档说不可用（见 4.2）。
- `run_shell_command` 的重定向默认触发确认，除非规则 `allowRedirection=true`。
- 文档要求 MCP 服务器名不含下划线，否则通配规则"悄悄失效"（`policy-engine.md` Special syntax for MCP tools 的警告）。
- 企业文档自己写：这些控制是"为受管环境设计，不防本机有管理员权限的恶意者"（`docs/cli/enterprise.md:16-17`）。

---

## 5. Qwen Code（Gemini CLI 分支，只写差异）

资料只有文档（见第 0 节），没读源码。

### 5.1 与 Gemini 的差异

- **五个审批模式**：`plan`、`default`（界面叫 Ask Permissions）、`auto-edit`、`auto`（LLM 分类器，"默认开箱体验"）、`yolo`（`features/approval-mode.md`）。循环顺序 plan → default → auto-edit → auto → yolo。`ui.allowedApprovalModes` 可限制界面提供哪些。
- **Auto 模式**：分类器偏向拦截；默认批准只读命令、工作区内文件编辑、构建测试；拦截不可逆破坏、外部代码执行、凭据外泄、持久化、削弱安全、强推。`permissions.deny` 在分类器之前先拦；进 Auto 时过宽的 allow 规则（如 `Bash`）会被暂时剥离；分类器不可用则拦截，连续两次不可用后回到手动；连续 3 次拦截后回到手动。
- **权限规则改成了 Claude 风格**：`permissions.allow / ask / deny`，格式 `ToolName(specifier)`，优先级 `deny > ask > allow`；旧的 `tools.allowed`、`tools.exclude` 已弃用但仍生效、不自动迁移（`configuration/settings.md` 第 400-470 行附近）。示例 `Read(//Users/alice/code/**)`、`Bash(git *)`、`WebFetch(malicious.com)`。整个工具名的 deny 会把工具从注册表里移除（MCP 工具除外）。
- **没有 Gemini 那套 TOML policy engine**：从文档看是 Claude 风格 JSON 规则（**推断**：设置文档里没出现 `policies/*.toml`）。
- **沙箱**（`features/sandbox.md`）：
  - Linux 工具级沙箱 `tools.executionSandbox = {backend: auto|bwrap|landlock, filesystem: read-only|workspace-write, network: closed|open}`，`filesystem` 与 `network` 必填。覆盖 shell、终端 `!`、Monitor、Read/Write/Edit 与部分嵌套调用。bwrap 优先；bwrap 不可用且网络 `open` 时可用 Landlock（需 ABI 3 以上）。Landlock 不能强制 `network: closed`，也不隐藏被遮蔽路径，也不新建 PID/网络命名空间，报告 `partial`。
  - **读很宽**：文档原话 "Reads remain broad: this mode does not hide host secrets"。
  - **工作区设置不能开关或修改它**，即使项目受信；优先级 System > User > SystemDefaults。含错误的这些设置文件会让启动失败（退出码 5）。
  - **ACP、`qwen serve`、web 终端明确拒绝该沙箱**；MCP/LSP、可执行 hooks、扩展等也不在范围内。
  - macOS 只有整个 CLI 进 Seatbelt（默认 `permissive-open`，限写、网络宽）；Docker/Podman 同 Gemini。
  - `qwen sandbox`、`qwen sandbox --verify` 可检查生效的边界。
- **受信文件夹**：和 Gemini 一样默认关；启用后"失败即关"：没做选择时不受信（`configuration/trusted-folders.md`）。
- **headless**：`--approval-mode`（五值）、`--yolo`、`--safe-mode`（关掉自定义：上下文文件、hooks、扩展、skills、MCP、自定义子代理、权限规则、设置里的审批模式覆盖）。文档明确："`--yolo` 不会开沙箱"（`features/headless.md`）。daemon ACP 会话不看 `--max-wall-time`、`--max-tool-calls`。
- **SDK**（`developers/sdk-typescript.md`）：`permissionMode`（`default|plan|auto-edit|auto|yolo`）、`canUseTool`（1 分钟超时自动拒）、`allowedTools`（等价 `permissions.allow`）、`excludeTools`（等价 `permissions.deny`）、`setPermissionMode()` 运行中改。优先链：deny → ask → plan 拦非只读 → yolo → allow。`default` 下写工具被拒，除非回调或 `allowedTools` 批准。

### 5.2 要点

Qwen 比 Gemini 更接近 Claude 的模型；差异说明"Gemini 分支"这个标签已不能直接用 Gemini 的权限知识推 Qwen。ACP 路径下它**没有 OS 沙箱可用**，只剩审批模式和规则。

### 5.6 已知缺口

- 工具沙箱仅 Linux，读很宽，ACP 不支持。
- `yolo` 不开沙箱。
- Landlock 回退下网络不隔离、PID 可见、元数据操作（chmod、chown、xattr、时间戳）限制不全。
- 沙箱外的执行路径（MCP、hooks、扩展、外部 agent、推测执行、文件检查点、自动 skill/记忆维护）不在范围内（`features/sandbox.md`）。
- 源码级核对**没做**。

---

## 6. 横向观察（事实归纳）

1. **只有 Codex 把"读范围"当一等维度，且是 OS 强制的。** 其余三家要么读全盘（Claude 沙箱、Gemini 默认 Seatbelt、Qwen 工具沙箱），要么只在内置工具里按工作区校验（Gemini）。Gemini 的 Docker/Podman 模式因为只挂载工作目录，实际上读被限。
2. **"沙箱"在 Claude、Gemini、Qwen 三家都只包 shell**（Gemini 工具沙箱包 shell 和写文件；Qwen 的覆盖 shell 加 Read/Write/Edit），内置文件工具、MCP、web 抓取走进程内规则。Codex 的沙箱包命令子进程，文件改动（apply_patch）按策略判定；MCP、web search 在沙箱外。
3. **审批策略和沙箱是分开的两个轴**（Codex 最清楚：`never` 不等于放开，只是不问；Claude 的 `bypassPermissions` 才是"不问且全放"）。
4. **用户全局规则放宽宿主设置的路径**：Codex 的 allow 规则（bypass_sandbox）；Claude 的用户 allow 规则、hooks（deny 压不过 allow 的反方向成立：deny 总是赢，所以宿主放 deny 有效）；Gemini 用户策略层（priority 4）；Qwen 用户设置。Claude 和 Codex 都有"托管层"可压用户层，Claude 的 SDK 开了宿主入口 `managedSettings`。
5. **宿主能否运行中改**：Codex 每轮可改且有专门的 `thread/settings/update`；Claude 可改模式和 `permissions`（下一轮）；Gemini ACP 可改模式，沙箱不可改；Qwen SDK 可改模式，沙箱不可改。
6. **无人回答时**：Codex 看策略（`never` 拒），Claude 无回调拒，Gemini `ask_user`→拒，Qwen 默认模式写工具拒。四家都偏向拒绝，没有"默认放行"的情形（除 yolo/bypass 本身）。

---

## 7. 对已有调研的更正和补充

1. **Codex 受限读**：`approval-ux.md`/`multi-workspace.md` 没提；官方 `app-server.md` 还写着旧 `sandboxPolicy.readOnly.access = restricted` 可用，但源码（main，2026-10-23）已改为反序列化时报错，只能用 permission profile。现有 vonvon `sandboxParams` 用 profile，一致。
2. **Claude SDK 不设模式时的默认值**：`approval-ux.md` 2.1 写"不传时默认 `auto`（`sdk.d.ts:1985-1999`）"。当前文档（Claude Code v2.1.302 起）写的是不设模式则从 `default` 开始、需要批准的调用被拒；"v2.1.302 之前，部分不拉特性开关的运行可能默认成 auto"（`permission-modes.md`）。如果依赖版本在 v2.1.302 前后，行为会变，建议代码里始终显式传 `permissionMode`（现有 `permissionOptions` 已显式传）。
3. **Claude 的沙箱读**：现有 `permission.ts` 的 `qa`（只读）档用 `sandbox.filesystem.denyWrite` 加 `PreToolUse` 写文件 hook 实现；读不受限，工作目录外的 Read 工具没有被限制。官方提供 `permissions.blockReadsOutsideWorkingDirectories`、沙箱 `denyRead`、`Read(...)` deny 规则，现有代码都没用（**推断**，依据是 `permission.ts` 里没出现这些键）。
4. **Qwen 已有 auto 分类器模式和 Claude 风格规则**：`multi-workspace.md` 对 Qwen 的描述停在 0.25.2 的 Gemini 分支形态，权限面已大变。
5. **Gemini 文档中的内部矛盾**：受信文件夹默认值、Workspace 策略层是否可用，见 4.2 和 4.5。需要时用源码再核。

---

## 8. 对 vonvon 的启示（全部是推断，由上述事实推出）

1. **"只读 / 读写 / 完全访问 + 网络开关"这套抽象只对 Codex 成立，对其余三家只是近似。** 它是 Codex 旧沙箱的原样搬运；Claude、Gemini、Qwen 的原生模型是"审批模式 + 规则 + 可选的 shell 沙箱"，不存在"只读沙箱"这一档。把三档映射到它们上，实际是用 hook 和规则拼出来的（现有 `permission.ts` 就是这样）。
2. **应把"读范围"拆成独立维度并诚实标注能否强制。** 四家里只有 Codex 能 OS 级限读（profile 的 `:root=deny`）；Claude 能限沙箱内 shell 的读（`denyRead`）但 Read 工具要靠 `Read` deny，且文档称"尽力而为"；Gemini 内置工具限读但 shell 不限；Qwen 的 Linux 沙箱读很宽。设置界面如果提供"只能读工作区"，对后三家需要写"尽力"或不提供。
3. **"问人策略"和"能做什么"应是两个设置，不应揉进同一档。** 现在三档对应 `never`/`bypassPermissions`/`acceptEdits` 这些组合，丢了"允许但要问"这个中间状态；四家原生都有这个状态，而且 Codex 的 `auto_review`、Claude 的 `auto`、Qwen 的 `auto` 都是"不问人也不全放"的第三种。可以考虑先在内部定义自己的维度：读范围、写范围、命令执行、网络、MCP/外部工具、敏感路径、问人方式，再逐家映射，映射不了的维度在设置里置灰并说明。
4. **完全访问档对 Claude 不是"没限制"那么简单。** `bypassPermissions` 在 Claude 里仍有一批"任何模式都不自动批准"的例外（ask 规则、关键路径 `rm`、`requiresUserInteraction` 的 MCP 工具），无人回答时的行为是"拒"而不是"放"。如果群里要求"完全访问就是不会卡住"，需要把这些例外也交给宿主回调或写 hook 处理；现有代码里 `full` 档 `decide()` 对 callback 来源返回 `ask permission` 就是在处理这类例外。
5. **用户自己的全局配置是宿主权限设计的头号漏洞，Codex 上尤其具体。** `~/.codex/rules` 的 `allow` 规则会让命令绕过沙箱（源码 `exec_policy.rs:446-460`），群里设成只读也拦不住。要么给 Codex 子进程独立的 `CODEX_HOME`，要么确认 rules 不被加载；Claude 一侧 `settingSources:[]` 加独立 `CLAUDE_CONFIG_DIR`，并注意自动记忆、`~/.claude.json` 仍会被读；Gemini 用 `GEMINI_CLI_HOME`；Qwen 用 `QWEN_HOME` 或 `--safe-mode`。
6. **宿主想"设了就不被放宽"，Claude 有 `managedSettings`，Codex 有会话层优先于用户层，Gemini 有 `--admin-policy`，各家入口完全不同。** 值得为每家 provider 写明"我们用哪一层来放限制"，并加一个回显核对（现有 Codex 做了 `verifyCodexWorkspaceEcho`，Claude、Gemini、Qwen 目前没有对应物）。
7. **ACP 路径（Gemini、Qwen 以及以后要接的）基本没有 OS 沙箱。** Qwen 明说 ACP 拒绝工具沙箱；Gemini 的沙箱是启动参数，ACP 会话内不可改。所以这类 provider 的"只读""读写"档只能靠审批模式加规则，强度弱于 Codex，设置里应提示"该 agent 无系统级隔离"。
8. **网络开关要分两层讲清楚。** Codex 的 `network.enabled` 只是放开，不过滤；真要按域名放行得开 `features.network_proxy`。Claude 的网络是"沙箱代理按域名 + WebFetch 规则"，且不覆盖 WebFetch 工具本身。"允许网络访问"一个开关对不同 provider 覆盖面不同（web search、MCP、连接器通常在开关之外），可能需要写进说明或拆成"命令联网 / 网页搜索 / 外部工具"。
9. **运行中改档的能力不一致**：Codex 每轮可改且有专用接口；Claude 可改模式与权限规则（下一轮）；Gemini ACP 只能改模式；沙箱类设置（Gemini、Qwen）改了要重启进程。设置页上的"改档立即生效"承诺需要按 provider 区别对待，或统一定为"下一条消息生效"（Codex、Claude 能做到，ACP 类要重开会话）。
10. **headless 无人回答时四家都偏向拒绝，这对飞书群是友好的**；但"拒绝"要把原因回给模型（Claude 的 `deny.message`、Gemini 的 `denyMessage`、Codex 的 `decline`），否则模型会反复试同一个动作。Codex `auto_review` 连续拒绝会中断本轮，Claude auto 模式到阈值后在 `-p` 里是"不执行但继续"，两者行为不同，如果采用 provider 自带的自动审批，要预期中断和卡死两类后果。
