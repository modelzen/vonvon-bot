# 各 agent 原生权限模型调研（B 组，2026-10-23）

范围：Cursor CLI、Grok Build、Pi、OpenCode、Goose、Kimi Code、Copilot CLI、Amp、Factory Droid、Cline/Kilo/Roo、DeepSeek Harness。只查资料，没装、没跑、没登录任何 CLI，没改仓库。

## 0. 说明

- 标注：**文档** = 官方文档页；**源码** = 读了官方仓库的文件；**推断** = 我从上面两类推出来的，没有原文。版本和日期是我取资料的 2026-10-23 当天能看到的最新。
- 官方文档里的 URL 我是用 `.md` 原文或 curl 取的，页面渲染后的文字可能有出入。没取到的写"没查到"。
- 取不到源码的（Cursor、Grok Build、Copilot CLI、Amp、Droid 是闭源或只有文档仓库）只有文档。
- 本机没做实测。所有"行为"都是官方说法，没有验证。
- 仓库里已有的目录加载那部分我没重查，只补权限。

## 1. 对照表

图例：读 = 文件读范围能否限制；"问人"=有没有 ask 这一档；OS 沙箱 = 内核级强制。

| agent（版本） | 独立维度 | 原生档位/模式 | OS 沙箱 | 读能限制吗 | 程序化宿主能设什么 | 问人请求能收到吗 | 无人回答时 | 读用户全局配置放宽? |
|---|---|---|---|---|---|---|---|---|
| Cursor CLI（2026.10.14 / Cursor 3.23+） | 命令规则（Shell/Read/Write/WebFetch/Mcp 的 allow/deny）；批准模式 approvalMode；沙箱（模式、网络、读边界）三者独立 | approvalMode: `allowlist` / `auto-review` / `unrestricted`；`--force`/`--yolo`；ACP 模式 agent/plan/ask | 有：macOS Seatbelt，Linux Landlock+seccomp，Windows 走 WSL2；只管终端命令 | 能：`readBoundary: workspace`，管文件读、搜索和沙箱内命令 | 命令行 `--force`、`--sandbox`、`--mode`；`.cursor/cli.json` 只能放 permissions；沙箱配置在全局 `cli-config.json` 或 `sandbox.json`；没查到运行中改的办法 | ACP：`session/request_permission`，选项 allow-once/allow-always/reject-once | ACP 文档说"不回答会卡住"；`-p` 的行为没查到 | 会：全局 `~/.cursor/cli-config.json`、`~/.cursor/permissions.json`、`~/.cursor/sandbox.json` 都读（合并规则见 §2.1） |
| Grok Build（xAI 官方，约 1.0.60） | 命令规则（`[permission]` allow/ask/deny）；权限模式；沙箱配置三者独立 | 模式 ask / auto / always-approve（headless 另有 dontAsk、acceptEdits、bypassPermissions）；沙箱 off / workspace / read-only / strict / devbox | 有：Linux Landlock，macOS Seatbelt；**默认关**；子进程断网只在 Linux 生效 | 部分：`strict` 限读到 cwd+系统路径；自定义 `deny` 列表可禁读，Linux 要 bubblewrap | `--allow/--deny`、`--permission-mode`、`--sandbox`、`GROK_SANDBOX`；ACP 下能设什么没查到 | ACP 文档里没写权限请求；没查到 | `dontAsk` = 静默拒绝；其他模式 headless 的默认没查到 | 会：项目 `.grok/config.toml` 只贡献 `[permission]`、`[mcp_servers]`、`[plugins]`，`permission_mode` 只认用户级；用户级 `~/.grok` 会读 |
| Pi（pi-mono 1.4.0） | **无**权限系统；只有工具开关和项目信任 | 无档位 | 无（官方叫你自己装容器） | 不能 | 命令行 `--tools/--no-tools/-e`；RPC/SDK；权限门靠扩展的 `tool_call` 钩子 | 靠扩展：`ctx.ui.select/confirm` 在 RPC 下变成 `extension_ui_request` | 对话框可带 `timeout`，超时自动返回 undefined；示例扩展在无 UI 时直接拦 | 会：`~/.pi/agent/extensions/` 的用户扩展自动加载；`-ne` 可关 |
| OpenCode（cli 2.1.3，仓库 anomalyco/opencode） | 每个工具一个权限键（read/edit/bash/webfetch/websearch/task/skill/lsp/external_directory/doom_loop...），每键 allow/ask/deny，可按模式匹配 | 没有"档位"；`--auto`（放行所有没被 deny 的 ask）；agent 级覆盖 | 没查到有 | 只在进程内按规则：`read` 可按路径、`external_directory` 管 cwd 外 | 配置文件、`OPENCODE_PERMISSION`、`OPENCODE_CONFIG_CONTENT`、agent 文件、HTTP 服务会话权限接口、ACP | 能：事件 `permission.asked`，回复 once / always / reject | `opencode run` 无人时自动 reject 并带反馈；`--auto` 则放行 | 会：全局 `~/.config/opencode/opencode.json` 先加载，项目覆盖它；托管配置最高 |
| Goose（v1.55.0，2026-10-16） | 模式（全局）+ 每个工具的权限（按工具名，不按参数） | `auto`（默认）/ `approve` / `smart_approve` / `chat` | 没查到有 | 不能 | `GOOSE_MODE`；`/mode`；ACP `session/set_mode` 按会话改；工具权限写 `permission.yaml` | ACP：四个选项 allow_always/allow_once/reject_once/reject_always | 没查到 | 会：全局 `permission.yaml`；`allow_always` 会写进全局文件 |
| Kimi Code（kimi-code 2.3.0；旧 kimi-cli 1.52.0 已归档） | 模式 + 命令规则 `[[permission.rules]]`（allow/deny/ask，按 `Tool(arg)`）；危险命令守卫是单独开关 | Always Ask（manual，默认）/ Ask When Needed（yolo）/ Never Ask（auto）；Plan 另算 | 没有（官方文档：Tower 的 worktree 不是安全沙箱；上一轮调研也记"没有系统沙箱"） | 不能；`.env`、id_rsa 等敏感文件有硬拦 | `--yolo/--auto/--plan`、`KIMI_CODE_HOME`、ACP `session/set_mode`、规则 scope 分四层 | ACP：`session/request_permission`，选项 Approve once / Approve for session / Reject | `-p` 一律走 `auto`（不问），静态 deny 仍生效 | 会：`~/.kimi-code/config.toml` 的 `default_permission_mode` 和规则（scope=user）都读 |
| Copilot CLI（1.0.103，2026-10-22） | 工具规则（`shell/write/read/url/MCP 名/memory`）、路径权限、URL 权限、沙箱四类 | 模式 default / assisted / allow-all；`--allow-all` = 工具+路径+URL 全放；autopilot | 有（`--sandbox`，2026-10 前后全员开放）；平台细节没在页面查到，changelog 提到 macOS、Linux、Windows 都有 | 路径级读写权限在进程内；沙箱读写策略的细节没查到 | `--allow-tool/--deny-tool/--allow-url/--deny-url/--add-dir/--sandbox`；ACP 可切 allow_all 配置项 | ACP 的权限请求格式文档没写；changelog 说 ACP 能应答并能切 allow-all | `-p` 不再交互提问（changelog 3269 行），具体是拒绝还是别的文档没说清 | 会：`~/.copilot/settings.json`；仓库 `.github/copilot/settings.json`；托管策略可禁用 `--allow-all` |
| Amp（当前文档，2026-09-28 更新） | **默认不问、不拦**；MCP 有 allow/reject 列表；其余靠插件 | 无 | 没查到 | 不能 | 插件 `tool.call` 钩子（allow / reject-and-continue / modify / synthesize / error）；`amp.mcpPermissions` | 插件里 `ctx.ui.confirm`；流式 JSON 里有 `permission_denials` 字段 | 没查到 | 会：全局插件目录 `~/.config/amp/plugins/` |
| Factory Droid（docs.factory.com，2026-10-23 取） | 自治级别 + 命令规则 `permissionRules`（allow/ask/block）+ 沙箱（独立） | 自治 Off / Low / Medium / High；`droid exec` 默认只读，`--auto low|medium|high`；`--skip-permissions-unsafe` | 有：macOS Seatbelt，Linux/WSL2 bubblewrap+seccomp；`per-command` 或 `whole-process` | 能：`sandbox.filesystem.denyRead`；默认读全放开 | `--auto`、SDK `autonomyLevel`、`permissionHandler`、JSON-RPC `droid.request_permission`、`updateSettings` | 能：SDK / JSON-RPC 都有，选项 ProceedOnce / ProceedAlways / Cancel | SDK：没 handler、抛错、返回不可用选项都当作取消 | 会：`~/.factory/settings.json`；组织 > 项目 > 用户的合并；项目规则需工作区信任 |
| Cline / Kilo / Roo | 按动作类别开关（读、写、命令、浏览器、MCP） | Cline：YOLO；Kilo：allow/ask/deny 规则（opencode 同源）；Roo 已停运 | 没有 | 读分"工作区内/全部" | 都是编辑器设置 | 编辑器内 | — | — |
| DeepSeek Harness（dsh 0.2.1-rc.2，2026-10-17） | **沙箱模式**和**批准策略**两个独立旋钮，预设把两者打包 | 沙箱 read-only / workspace-write / danger-full-access；批准 ask / never；预设 workspace-write、danger-full-access（可配）、auto | 有：Linux bwrap 再 Landlock，macOS Seatbelt，Windows ACL；不可用时失败而不是退化 | 沙箱只管**写**（read-only 禁写）；读不限；网络不在词表里 | 按会话改 `sandbox/mode`、`approval/policy`；ACP 只做自动化子集，**不支持 modes** | 能：ACP `session/request_permission` | 没有应答者 = `unavailable` = 拒绝（fail-closed） | 没查到 |

## 2. 每家细节

### 2.1 Cursor CLI

版本：上一轮实测 2026.10.14；沙箱读边界需要 Cursor 3.23 以上（文档）。

a. 维度
- 命令规则：`permissions.allow` / `permissions.deny` 字符串数组，类型 `Shell(commandBase)`、`Read(pathOrGlob)`、`Write(pathOrGlob)`、`WebFetch(domain)`、`Mcp(server:tool)`，deny 优先于 allow，条目是精确字符串。（文档 https://cursor.com/docs/cli/reference/permissions ，configuration 页）
- 批准模式：`approvalMode` = `allowlist` / `auto-review` / `unrestricted`。（文档 https://cursor.com/docs/cli/reference/configuration ）桌面版叫 Auto-review / Allowlist / Run Everything，Auto-review 用云端小模型分类器审，官方写明"不是安全边界"。（文档 https://cursor.com/docs/agent/security/run-modes.md ）
- 沙箱：`sandbox.mode`、`sandbox.networkAccess`、`sandbox.readBoundary`。（文档 configuration 页）网络三档 `sandbox.json Only` / `sandbox.json + Defaults`（默认）/ `Allow All`。（搜索摘要里的文档说法，没读到原页，标 **文档（二手摘要）**）
- 独立旋钮：命令规则、批准模式、沙箱模式、网络、读边界，彼此独立。MCP：所有 MCP 连接要批准，连接后每次工具调用还要批准，可用 MCP allowlist 预批。（文档 https://cursor.com/docs/agent/security.md ）

b. 预设
- `--force` / `--yolo`："Force allow commands unless explicitly denied"（文档 https://cursor.com/docs/cli/reference/parameters ）。注意是"除非显式 deny"，所以 deny 规则在 force 下仍生效。
- `--mode plan|ask`：只读行为。ACP 里 agent / plan / ask 三种模式。（文档 https://cursor.com/docs/cli/acp ）
- `-p`：文档只写"能用写和 shell 工具"，没写没 `--force` 时怎么办。（文档 parameters 页）

c. 强制方式
- 沙箱是 OS 级：macOS Seatbelt（sandbox-exec），Linux Landlock + seccomp，Windows 在 WSL2 里跑 Linux 沙箱。（文档 https://cursor.com/blog/agent-sandboxing ，run-modes 页）
- 只管终端命令。其他工具靠规则和批准。（文档 run-modes 页）
- 读：`readBoundary: workspace` 时，工作区外的文件读要批准，grep 跳过工作区外的文件，沙箱里的命令只能读工作区、读白名单和系统路径，`.cursorignore` 在 Linux 上用"锁住的副本"盖住被忽略的文件。（文档 run-modes 页，blog）。默认是 `system` = 读不限。
- 受保护路径：`.git/config`、`.git/hooks`、`.vscode`、`.cursorignore` 等默认写保护；`.cursor` 下只开放 rules、commands、worktrees、skills、agents 子目录写。（文档 blog，macOS 的描述）

d. 宿主
- `--force`、`--sandbox enabled|disabled`、`--mode`、`--trust`（仅 headless）、`--approve-mcps` 是按进程的命令行参数。`agent sandbox run` 子命令还有 `--allow-paths`、`--readonly-paths`、`--blocked-patterns`、`--network`。（文档 parameters 页）
- 配置文件：全局 `~/.cursor/cli-config.json`；项目 `<project>/.cursor/cli.json`，项目级**只能放 permissions**。`CURSOR_CONFIG_DIR` 能换全局目录。（文档 configuration 页）
- 全局和项目的 permissions 怎么合并，页面没写。
- 运行中能不能改、按会话还是按轮改：没查到。ACP 的 `session/new` 只带 `cwd` 和 `mcpServers`。（文档 acp 页）

e. 问人
- ACP：`session/request_permission`，三个选项 `allow-once` / `allow-always` / `reject-once`。（文档 https://cursor.com/docs/cli/acp ）
- 文档原话："If your client does not answer permission requests, tool execution can block."
- ACP 另有阻塞式扩展 `cursor/ask_question`、`cursor/create_plan`，客户端不答也会卡。
- 团队级 MCP 在 ACP 模式不支持。（文档 acp 页）

f. 全局配置
- 会读。全局 `cli-config.json`（含 `approvalMode`、`sandbox.*`）只能在全局设，项目级放不进去，所以宿主若想改只能改全局文件或用命令行参数。`~/.cursor/permissions.json` 和项目的合并；团队在 dashboard 配了 Auto-review 时，团队配置优先并**忽略**用户和项目文件。`sandbox.json`：项目覆盖全局，团队策略和硬编码规则叠在最上面，本地文件削弱不了。（文档 run-modes 页）
- 推断：宿主用 `CURSOR_CONFIG_DIR` 指向隔离目录，可以不吃用户全局配置；文档没明说这样能完全隔离。

g. 缺口
- ACP 下没有"问人"的超时或默认答案。
- `-p` 下无 `--force` 的行为没写。
- 沙箱只管终端命令；文件读写工具走规则。
- `sandbox.json` 的完整 schema 在 https://cursor.com/docs/reference/sandbox.md ，我没取。

### 2.2 Grok Build（xAI 官方）

同名项目：我只查了 docs.x.ai 上 xAI 官方的 Grok Build（命令 `grok`，ACP 入口 `grok agent stdio`）。上一轮记的版本是 1.0.60。没找到公开源码仓库，只有文档。

a. 维度
- 命令规则：`[permission]` 表，`allow` / `ask` / `deny`，也可 `rules = [{action, tool, pattern}]`；支持的 tool 有 Bash、Edit、Read、Grep、MCPTool、WebFetch、WebSearch。顺序 **deny > ask > allow**。（文档 https://docs.x.ai/build/features/permissions.md ，https://docs.x.ai/build/settings/reference.md ）
- 模式：`[ui] permission_mode` = `default` / `ask` / `auto` / `always-approve`。Plan 模式独立。
- 沙箱：独立于权限，"权限决定工具调用跑不跑，沙箱限制已批准的调用能干什么"。（文档 https://docs.x.ai/build/features/sandbox.md ）

b. 预设
- 模式：Ask（默认）= 凡没放行的都问；Auto = 分类器自动批准安全工具；Always-approve = 全批准，但 deny 规则和 PreToolUse hook 仍生效。
- 沙箱档：
  - `off`（默认）：不限。
  - `workspace`：读全放，写只限 cwd、`~/.grok/`、临时目录，子进程网络放开。
  - `devbox`：读全放，除 `/data` 外顶层目录可写。
  - `read-only`：写只限 `~/.grok/` 和临时目录，子进程断网。
  - `strict`：读限 cwd 加系统路径，写同 workspace，子进程断网。
- headless 另有 `--permission-mode dontAsk`（没有显式 allow 的一律静默拒绝）、`acceptEdits`（编辑自动批、shell 要问）、`bypassPermissions`。（文档 https://docs.x.ai/build/enterprise.md ，前两个原文；bypassPermissions 只在企业页的锁定说明里出现）
- 兼容别名：`--allowedTools`、`--disallowedTools`、`--dangerously-skip-permissions`、`--yolo`。（文档 https://docs.x.ai/build/cli/reference.md ）

c. 强制
- Landlock（Linux）、Seatbelt（macOS）。默认关。
- 限制：子进程断网只在 Linux 生效，macOS 上 read-only / strict 的断网是空操作；内置档不保护 `~/.ssh` 这类凭据，要自己写 `deny`；`~/.grok/` 沙箱内也可写；断网设置不挡模型 API 和网页工具。（文档 sandbox 页）
- 读：`strict` 档限读；自定义档的 `deny` 在内核层执行，Linux 上读 deny 需要 bubblewrap。（文档 settings/reference 页）
- 沙箱不可用时怎么办：文档没写。

d. 宿主
- 命令行：`--allow`、`--deny`、`--permission-mode`、`--sandbox <profile>`、`--always-approve`。环境变量 `GROK_SANDBOX`、`GROK_SANDBOX_AUTO_ALLOW_BASH`。
- 自定义沙箱档写在 `~/.grok/sandbox.toml` 或项目 `.grok/sandbox.toml`，字段 `extends`、`restrict_network`、`read_only`、`read_write`、`deny`。
- 按进程。运行中能不能改：Shift+Tab 在 TUI 里切模式；宿主侧没查到。
- ACP 下能设什么：没查到（ACP 文档示例里没有权限相关内容）。

e. 问人
- ACP 里的权限请求：没查到。上一轮实测记过 ACP 会拒绝 `additionalDirectories`，跟权限无关。
- headless 默认：只知道 `dontAsk` 是显式的拒绝模式。

f. 全局配置
- 会读。项目 `.grok/config.toml` 只贡献 `[mcp_servers]`、`[plugins]`、`[permission]`，其他都在用户级。`permission_mode` 只认用户级。企业有 `/etc/grok/requirements.toml` 可锁。（文档 settings/reference，permissions 页）
- 官方特别写明：Claude Code 的 `managed-settings.json` 的 `disableBypassPermissionsMode` **不会**作用到 grok；但会读那个文件里的权限规则、MCP 白名单。即 grok 会吃 Claude 的部分托管配置。（文档 enterprise 页）
- 推断：宿主用 `GROK_HOME` 指到隔离目录可以绕开用户级配置（settings/reference 页写了 `$GROK_HOME/config.toml`）。

g. 缺口
- 沙箱默认关，只能靠宿主显式传 `--sandbox`。
- ACP 权限请求和模式没文档。
- 旧版文档和企业页对档名不一致（企业页只列 off、workspace、devbox），用前核对安装版本。

### 2.3 Pi（badlogic/pi-mono，现在包在 earendil-works 名下）

版本：packages/coding-agent 1.4.0，克隆 HEAD 为 2026-10-23（源码）。

官方立场：不是"YOLO 口号"，而是明确写"没有内置权限系统"：
- README："Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it."（源码 README.md 第 88–92 行）
- docs/security.md："does not ask for approval before every tool call"，"Watching the transcript, using project trust, and reviewing changes do not create a security boundary."；推荐整个进程放进容器/VM/OpenShell。（源码 packages/coding-agent/docs/security.md ）

a. 维度
- 没有读写命令网络的权限维度。
- 只有：工具开关（默认 `read,bash,edit,write`，`--tools`、`--no-tools`、`--exclude-tools`）和"项目信任"（决定要不要加载项目里的 `.pi/settings.json`、扩展、skill、MCP 配置，**不**限制工具能做什么）。（源码 docs/cli.md，security.md）
- 工作目录"不阻止命令访问进程能访问的其他路径"。

b. 预设：无。

c. 强制：无沙箱。官方给了 Docker、Docker Sandboxes、OpenShell、Gondolin（把内置工具路由到本地微虚机）。（源码 docs/containerization.md ）

d. 宿主
- 命令行：`--tools`、`--no-tools`、`-e <扩展>`、`-ne`（关掉发现的扩展，显式 `-e` 仍加载）、`-a/--approve`、`-na`、`--mode json|rpc`。
- RPC、SDK（`createAgentSession`）。
- 权限门靠扩展：`pi.on("tool_call")` 可 `{block: true, reason}`、改参数。官方示例有 `permission-gate.ts`（危险 bash 命令先问）、`protected-paths.ts`（拦写 `.env`、`.git/`）、`confirm-destructive.ts`、`project-trust.ts`。（源码 examples/extensions/ ，docs/extensions.md）
- 粒度：扩展是进程级加载，钩子按每次工具调用。

e. 问人
- 扩展的 `ctx.ui.select/confirm/input`，在 RPC 模式变成 stdout 的 `extension_ui_request` 加 stdin 的 `extension_ui_response`；对话框可带 `timeout`，超时由 agent 一侧自动返回默认值（select 返回 undefined）；客户端也可回 `cancelled: true`。（源码 docs/rpc-extension-ui.md ）
- `ctx.hasUI` 在 RPC 下为 true。示例扩展在 `!ctx.hasUI` 时直接 block。
- 没有任何原生的"批准卡"。要问人必须自己写扩展。

f. 全局配置
- 会：`~/.pi/agent/extensions/` 的用户扩展自动加载；`-ne -e <自己的>` 可只留宿主扩展。项目信任决定存在 `~/.pi/agent/trust.json`；print/json/rpc 下没有提示，`defaultProjectTrust` 为 "always" 才会加载项目受保护资源，"ask"/"never" 跳过。（源码 security.md）
- 上下文文件（AGENTS.md、CLAUDE.md）不论信任都加载。

g. 缺口
- 官方就是这个立场；任何限制都要宿主自己做（容器）或自己写扩展。
- 扩展拦的是 `tool_call`，bash 里的任意命令只能靠正则或模型，不是 OS 强制。

### 2.4 OpenCode

仓库：sst/opencode 已迁到 anomalyco/opencode（GitHub API 返回）。本节按 dev 分支 2026-10-23：packages/cli 版本 2.1.3。1.x 文档页上带有"In OpenCode 1"的字样，说明 1.x 的差异仍写在文档里。

a. 维度（文档 packages/web/src/content/docs/permissions.mdx ）
- 每个动作一个键：`read`、`edit`（含 write、patch）、`glob`、`grep`、`bash`（按解析后的命令匹配）、`task`、`todowrite`、`skill`、`lsp`、`question`、`webfetch`、`websearch`、`external_directory`（工具碰到工作目录外的路径时触发）、`doom_loop`（同一调用重复 3 次）。
- 每个键取 `allow` / `ask` / `deny`；对象语法按参数模式匹配，通配符 `*`、`?`，**最后一条匹配的规则生效**；`~` 和 `$HOME` 可展开。
- 默认几乎全 allow；`doom_loop`、`external_directory` 默认 ask；读 `.env` 默认 ask。
- 独立旋钮：每个工具键各自独立，路径靠 `external_directory` 和 `read`/`edit` 的路径模式组合。

b. 预设：没有。有 `--auto`（"自动批准没被显式 deny 的请求"，`opencode run --auto` 也行；别名 `--yolo`、`--dangerously-skip-permissions`，源码 packages/cli/src/commands/handlers/run.ts 第 27 行）。另可用 `"permission": "allow"` 一次全放。

c. 强制：文档和源码里没查到 OS 沙箱；只在 agent 进程里按规则拦。读：`read` 可按路径模式；`bash` 里的读靠命令模式。`external_directory` 管到 cwd 之外的路径，规则里一旦放行，该目录继承和工作区一样的默认（读默认 allow）。

d. 宿主
- 配置层次（后者覆盖前者）：远程 `.well-known/opencode` → 全局 `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` → 项目 `opencode.json` → `.opencode` 目录 → `OPENCODE_CONFIG_CONTENT`（内联）→ 托管文件 → macOS 托管偏好。（文档 config.mdx）
- 环境变量 `OPENCODE_PERMISSION`（内联 JSON 权限）。（文档 cli.mdx）
- agent 级覆盖：配置里 `agent.<名>.permission`，或 Markdown agent 文件的 frontmatter `permission:`；与全局合并，agent 规则优先。
- 服务器/SDK：HTTP 接口 `GET /api/permission/request`（待决请求列表）、`GET/POST /api/session/:id/permission`（创建、列出）、`POST /api/session/:id/permission/:requestID/reply`，body `{decision: once|always|reject, message?}`；还有 `/api/permission/saved` 管"always"保存的规则。（源码 packages/protocol/src/groups/permission.ts ，标"experimental"）
- 事件 `permission.asked`、`permission.replied`；请求字段 `action`、`resources[]`、`save[]`、`metadata`、`source`。（源码 packages/schema/src/permission.ts ）
- 会话级规则：schema 里权限请求带 sessionID，`merge`/`evaluate` 把规则集叠加，找不到匹配时默认 `ask`（源码 packages/core/src/permission.ts 第 67–79 行）；会话创建时能不能直接传规则集我没查到。

e. 问人
- 宿主能收到并回答：事件加 reply 接口，三种答案。"always" 的范围："当前 OpenCode 会话内"对工具给出的模式生效（文档）。
- ACP：packages/cli/src/acp/permission.ts 把 once / always / reject 映射成 ACP 的 allow_once / allow_always / reject_once 选项（源码第 40–44 行）。
- `opencode run` 无人时：没有 `--auto` 就**自动 reject**，并给模型一条反馈"This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action."（源码 packages/cli/src/run/noninteractive.ts 第 73–74、158–185 行）；V1 兼容模式下拒绝后整轮终止。有 `--auto` 则 once 放行。

f. 全局配置：会读全局配置；项目配置、内联配置、托管配置覆盖它。想要隔离只能靠 `OPENCODE_CONFIG_CONTENT`（优先级比全局高）加 deny 规则，或换 HOME；全局文件里放宽的规则，如果宿主没写对应的 deny，会继续生效（推断：规则是合并后取最后匹配）。

g. 缺口
- 无 OS 沙箱。
- 权限接口标 experimental。
- 上一轮记的"2.0.30 附加目录只做权限放行"与本次看到的 2.1.3 不矛盾，但我没重查附加目录。

### 2.5 Goose（block/goose）

版本：最新 release v1.55.0（2026-10-16，GitHub API）。

a. 维度
- 两层：全局"模式" + 每个工具一档权限。工具权限只按**工具名**，没有按参数、路径、命令模式的匹配。（文档 documentation/docs/guides/managing-tools/goose-permissions.md、tool-permissions.md ；源码 crates/goose/src/config/permission.rs 的 `PermissionConfig{always_allow, ask_before, never_allow}`）
- 没有独立的文件读/写、网络维度。

b. 预设（文档 goose-permissions.md ；环境变量页）
- `auto`（Completely Autonomous，**默认**）：全放行。
- `approve`（Manual Approval）：每个工具先问，支持逐工具权限。
- `smart_approve`：只读的自动放，其余问；判断用 MCP 工具注解的 `read_only_hint`，没有注解时用 LLM 判断，并缓存。（源码 crates/goose/src/permission/permission_inspector.rs ）
- `chat`：只聊天，不用扩展和改文件。
- 环境变量 `GOOSE_MODE`，默认 "auto"。

c. 强制：没查到 OS 沙箱（仓库里只有一张博客图叫 sandbox.png）。全是进程内逻辑。读不能限制。

d. 宿主
- 环境变量、CLI `/mode`、ACP `session/set_mode`（按会话切模式，源码 crates/goose/src/acp/server.rs 第 2527–2543 行）。
- 工具权限写在配置目录的 `permission.yaml`（全局文件）。
- 桌面端每个会话有自己的模式，设置只改新会话的默认。（文档）

e. 问人
- ACP：权限请求带四个选项 allow_always / allow_once / reject_once / reject_always（源码 server.rs 第 1567–1579 行）；always 会写进全局 `permission.yaml`（推断：测试名 `allow_always_maps_to_always_allow`、`reject_always_maps_to_always_deny`）。
- 无人回答的默认：没查到。

f. 全局配置：会读全局 `permission.yaml` 和 config；ACP 下的 always 答案会改全局文件，**会影响以后所有会话**——对 bot 场景是个坑（推断）。

g. 缺口：没有路径、参数粒度；没有沙箱；默认模式是全放行。

### 2.6 Kimi Code（MoonshotAI/kimi-code）

版本：kimi-code 2.3.0（源码 apps/kimi-code/package.json，克隆 HEAD 2026-10-22）。旧的 Python kimi-cli 1.52.0 于 2026-09-22 归档，迁移到 kimi-code。（源码 kimi-cli CHANGELOG）

a. 维度（文档 docs/en/guides/interaction.md、configuration/config-files.md ）
- 模式（三选一）和命令/工具规则 `[[permission.rules]]`（`decision` allow/deny/ask，`scope` turn-override / session-runtime / project / user，`pattern` 如 `Bash(rm -rf*)`、`Read`；按顺序，第一条匹配生效）。
- 危险命令守卫 `dangerous_command_guard`（默认开）：危险命令、敏感文件（`.env`、`id_rsa`）、git 控制路径要确认；Never Ask 下不生效。`Read/Write/Edit` 碰密钥文件是**硬拦**，关守卫也不解除。
- MCP 工具、AgentSwarm 只能按名字匹配，不能按参数。

b. 预设
- Always Ask（旧名 Manual，默认）：只读自动，其余逐个问。
- Ask When Needed（旧名 YOLO，`--yolo`、`/yolo`）：常规调用自动批，敏感文件、危险命令、退出 Plan 仍问，agent 仍可向用户提问。
- Never Ask（旧名 Auto，`--auto`、`/auto`）：全自动，包括敏感文件，也不向用户提问；Plan 的退出批准仍要人。
- 配置键 `default_permission_mode` = manual / yolo / auto。

c. 强制：没有 OS 沙箱（上一轮调研记"没有系统沙箱"；官方 Tower 文档说 worktree "不是安全沙箱"）。读不能限制，除了敏感文件硬拦。

d. 宿主
- 命令行 `--yolo/--auto/--plan`；`-p` 不能和这些组合，`-p` 固定走 auto 策略、静态 deny 仍生效。（文档 reference/kimi-command.md ）
- ACP：`session/set_mode`、`session/set_config_option`（mode）；模式 id 为 `default` / `plan` / `auto` / `yolo`（源码 packages/acp-server/src/modes.ts ）。`session/new` 返回 `modes`。
- 规则按 scope 分层，`turn-override` 和 `session-runtime` 看起来是为宿主按轮/按会话叠加设计的；怎么从 ACP 传进去我没查到。
- `KIMI_CODE_HOME` 可换配置根。（文档 configuration/overrides.md ）

e. 问人
- ACP：`session/request_permission`，选项 Approve once（allow_once）/ Approve for this session（allow_always）/ Reject（reject_once）；同一通道也用于 ask-user 问题，客户端声明 elicitation.form 时走原生表单。（文档 reference/kimi-acp.md ；源码 packages/acp-server/src/approval.ts 第 66–72 行）
- 无人时：`-p` 直接 auto 不问；ACP 下客户端不答会怎样，没查到。

f. 全局配置：会读 `~/.kimi-code/config.toml` 的 `default_permission_mode` 和用户级规则。优先级：命令行 > 其他（文档 overrides.md 的"从高到低"列表我只读了第 1 条）。宿主想隔离用 `KIMI_CODE_HOME`。

g. 缺口：无沙箱；`-p` 默认全放，对 bot 很危险；Never Ask 下连危险命令守卫都不生效。

### 2.7 GitHub Copilot CLI

版本：1.0.103（2026-10-22，changelog）。闭源，仓库 github/copilot-cli 只有 README 和 changelog，所以 **源码** 一栏全是 changelog，其余是 docs.github.com 的 CLI command reference（2026-10-23 取）。

a. 维度
- 工具规则：`--allow-tool` / `--deny-tool`，格式 `Kind(argument)`，Kind 有 `shell`（`shell(git:*)` 按词干匹配）、`write`（`write(src/*.ts)`，deny 的路径不支持 glob，只做精确/末段匹配）、`read`、`url`、`memory`、MCP 服务器名（`MyMCP(create_issue)`）。**deny 永远压过 allow，包括 `--allow-all`**。
- 路径权限：`--allow-all-paths`；`--add-dir`；默认只允许 cwd 和临时目录（`--disallow-temp-dir` 可关临时目录）。
- URL 权限：`--allow-url` / `--deny-url`（deny 优先），`--allow-all-urls`。
- 沙箱：独立，`--sandbox` / `--no-sandbox`，配置 `sandbox.*`。
- 还有 `--available-tools` / `--excluded-tools`（决定模型看得到哪些工具），`--no-ask-user`。（文档 command reference）

b. 预设
- `/permissions default|assisted|allow-all`。assisted 是"LLM 辅助批准"：仍逐个请求，但附 LLM 安全建议，认为可接受的自动批。
- `--allow-all` = `--allow-all-tools --allow-all-paths --allow-all-urls`；`--yolo` 同义；环境变量 `COPILOT_ALLOW_ALL`（设成确切的 `true` 时还会**无提示地信任工作目录**，加载其 skill、插件、MCP、hook）。
- autopilot：agent 持续干直到完成；"autopilot 对 preToolUse hook 的 ask 决定直接拒绝，而不是停在没人看的弹窗上"（changelog 128 行）。

c. 强制
- 沙箱是 OS 级，有 `/sandbox`、`--sandbox`，提供代理 CA、网络主机规则、本地网络开关，Windows、macOS、Linux 都有对应 changelog 条目；具体 OS 原语（Seatbelt/bubblewrap/…）页面没写，没查到。
- 沙箱允许"一次性绕过"提示：命令被沙箱拦住时可提示在沙箱外重跑（`allowBypass`，默认开）；企业策略可设 `sandbox.failIfUnavailable` 做成沙箱建立不了就拒绝执行。（文档 command reference）
- 读：路径验证在进程内；沙箱自动给工具链目录只读授权。沙箱对读的限制细节没查到。

d. 宿主
- `-p` 或管道输入做无头；所有 `--allow-*` / `--deny-*` 都是按进程。
- ACP：`copilot --acp [--stdio|--port]`（公共预览）。changelog 说 ACP 客户端可通过会话配置切换 allow-all（`allow_all` 配置项），ACP 会话遵守 `--sandbox/--no-sandbox` 和保存的沙箱设置；托管策略也对 ACP 生效。（changelog 320、561、1475、1869、4 行）
- 仓库设置 `.github/copilot/settings.json` 和 `.local.json`；用户设置在 `~/.copilot`（可用 `COPILOT_HOME` 换）。

e. 问人
- 交互里弹窗，选项含"本次/本会话/记住到目录"（changelog 1879 行"按位置的权限持久化默认开启"）。
- ACP 的请求格式文档没写；changelog 说 ACP 里待决权限在会话恢复后仍可回答。
- `copilot -p` 不再交互提问（changelog 3269 行）；官方要求无头程序化使用必须 `--allow-all-tools`（command reference：`--allow-all-tools`"Required when using the CLI programmatically"）。没批准的工具在 `-p` 下具体是拒绝还是别的，文档没写，没查到。
- `-p` 下加载仓库的扩展和工作区 MCP 默认关，需要 `--trust-folder` 或两个环境变量。

f. 全局配置
- 会读用户 `settings.json`、保存的沙箱设置、保存的"信任文件夹"和按位置的权限批准（会让你以前批准过的目录继续放行）。托管设置（账户级、企业、MDM）最高。`permissions.disableBypassPermissionsMode: "disable"` 能让所有 `--allow-all*` 失效。（文档）
- 推断：宿主要隔离，需 `COPILOT_HOME` 指到空目录。

g. 缺口：闭源，细节靠文档；"保存的批准"跨会话存在，可能放宽宿主意图；`deny write` 无 glob。

### 2.8 Amp（Sourcegraph/ampcode）

版本：docs 页 `lastModified: 2026-09-28`（Tools 页）。

**与你给的描述不一致的地方**：当前官方文档**没有** allow / ask / reject / delegate 这套 `amp.permissions` 规则。Tools 页写的是"By default, Amp does not ask for approval before running tools."，Permissions 一节只有"用自定义插件控制工具使用"。（文档 https://ampcode.com/docs/markdown/tools ）旧版 manual 里有 `amp.permissions`（我在当前设置页 https://ampcode.com/docs/markdown/cli/settings 里没找到这个键，只找到 `amp.mcpPermissions`）；旧版内容我没取到旧页，不写。

a. 维度
- 工具调用：默认全放行，没有原生规则。
- MCP：`amp.mcpPermissions` 规则列表，`matches`（command/args/url 通配）+ `action`（allow / reject），第一条匹配生效，没匹配则允许。
- 其余都靠插件。

b. 预设：无。

c. 强制：没查到 OS 沙箱；文档建议"隔离的开发环境"。读不能限制。

d. 宿主
- 插件 API（`@ampcode/plugin`）：`amp.on('tool.call', handler)` 返回 `allow` / `reject-and-continue`（带 message）/ `modify`（改参数）/ `synthesize`（不执行直接给结果）/ `error`。官方示例"禁止破坏性 git 操作"插件。（文档 https://ampcode.com/docs/markdown/customize/plugins ，plugin-api）
- 工作区管理员可发布"全局工作区插件"统一下发。
- `amp -x` 执行模式和流式 JSON：`permission_denials` 字段、线程状态 `awaiting-approval`、MCP 状态 `awaiting-approval`。（文档 streaming-json）

e. 问人：插件里 `ctx.ui.confirm({...})`；没有原生的批准请求。headless 下怎么办：没查到。

f. 全局配置：会读个人/工作区全局插件（`~/.config/amp/plugins/`）。想让宿主设的限制不被放宽，只能把拦截逻辑放在宿主自己的插件里并确认加载顺序（没查到加载顺序规则）。

g. 缺口：没有原生权限；闭源。

### 2.9 Factory Droid

版本：docs.factory.com 2026-10-23 取，没有版本号。

a. 维度（文档 /autonomy-and-safety/auto-run、permission-rules、sandbox）
- 自治级别（风险阈值，不是工具开关）。
- 命令规则 `permissionRules`：`allow` / `ask` / `block`，按有序命令前缀匹配，带正反例；来源 组织 > 运行时 > 文件夹 > 项目 > 用户，不同 ID 的规则叠加，`block > ask > allow`。旧的 `commandAllowlist` / `Denylist` / `Blocklist` 已弃用但仍生效。
- 沙箱：`sandbox.enabled`、`mode`（per-command 默认 / whole-process）、`filesystem.allowWrite|denyWrite|denyRead`、`network.allowedDomains`。
- MCP 和 hooks：分开管；hooks 可做阻断。
- 官方原话：命令规则"不是操作系统隔离"。

b. 预设（自治级别）
- Off：只允许内置读工具和策略允许的命令。
- Low：加文件编辑和低风险命令。
- Medium：加可回退的工作区改动（`npm install`、`git commit`、`mv`、`cp`、构建）。
- High：高风险动作（`docker compose up`、允许时的 `git push`、迁移、自定义脚本），除非安全检查要求批准。
- `droid exec` 默认只读；`--auto low|medium|high`；`--skip-permissions-unsafe`（跳过所有提示，但命令 block 仍生效，不能和 `--auto` 同用）。（文档 droid-exec/overview）
- 子代理默认继承父级自治级别，可单独设，且不超过组织上限。

c. 强制
- 沙箱是 OS 级：macOS Seatbelt，Linux/WSL2 bubblewrap + seccomp，网络走过滤代理。**不可用时拦截而不是裸跑**；whole-process 模式下 Droid 拒绝启动。
- 读：能限制。默认读全放开，`denyRead` 列出的路径被拒；`Read`、`Grep` 等文件工具在调用前检查。默认写只放 cwd，网络默认只放 Factory 自己的域名。

d. 宿主
- `droid exec --auto`、`--input-format stream-jsonrpc --output-format stream-jsonrpc`（JSON-RPC：`droid.initialize_session`、`droid.add_user_message`、`droid.request_permission`、`droid.ask_user`，另有更新设置的方法）；`--output-format acp`；TypeScript SDK `@factory/droid-sdk` 和 Python `droid-sdk`。
- SDK 创建会话时设 `autonomyLevel`、`interactionMode`、`permissionHandler`、`askUserHandler`、工具开关；`updateSettings` 运行中改（`session.updateSettings({interactionMode})`）。恢复会话可换新的 handler。（文档 sdk/typescript）
- 粒度：按会话，可运行中改；沙箱设置在 settings 里，宿主能否按会话传没查到。

e. 问人
- SDK `permissionHandler({toolUses, options})`，返回 `ProceedOnce` / `ProceedAlways` / `Cancel`，可用选项随请求而变；ExitSpecMode 也走这里。
- 没 handler、handler 抛错、返回不可用选项，都当作**取消**。（文档 sdk/typescript 第 842–900 行）
- `droid exec` 的设计："对权限违规快速失败并给出明确错误"。

f. 全局配置：会读 `~/.factory/settings.json`、项目 `.factory/settings.json`、`settings.local.json`；项目和文件夹规则需要**工作区信任**；组织设置最高且 `denyRead/denyWrite` 并集合并、下游删不掉。"Allow always" 会把当前自治级别**抬高**到该提示所需级别（auto-run 页），即用户的一次点击改变后续会话的批准范围。

g. 缺口：规则功能需要组织开通（permission-rules 页提示"确认你的组织已启用权限规则"）；沙箱按会话怎么传没查到。

### 2.10 IDE 类参照：Cline / Kilo Code / Roo Code

- **Cline**（文档 https://docs.cline.bot/features/auto-approve ）：Auto Approve 按每次工具调用、按类别判断。类别：读工程文件、读所有文件（工作区外，依赖前者）、编辑工程文件、编辑所有文件（依赖前者）、执行安全命令、执行所有命令（依赖前者）、浏览器、MCP。命令被分成"安全"与"需批准"两类。另有 YOLO 模式。维度 = 动作类别 × 工作区内外 × 命令风险，没有路径模式。
- **Kilo Code**（opencode 同源，源码 packages/kilo-docs/pages/customize/agent-permissions.md ）：`permission:` 键，allow / ask / deny，可按模式，"最后匹配生效"，Markdown agent 文件里按 agent 配，全局在 `kilo.jsonc`。
- **Roo Code**：GitHub 仓库 RooCodeInc/Roo-Code 已归档（pushed_at 2026-05-15），README 写"The Roo Code Extension was shut down on May 15th"。不再作为参照。

### 2.11 DeepSeek

有官方编码 CLI：**DeepSeek Harness**（deepseek-ai/deepseek-harness，MIT，命令 `dsh`，包 `@deepseek-ai/dsh`），开发者预览，最新 tag dsh-v0.2.1-rc.2（2026-10-17）。上一轮记 0.2.1-alpha.4。不要和 holasoymalva/deepseek-cli（第三方、基于 Gemini CLI）混淆。

a. 维度（源码 docs/subsystems/permission-presets.md、sandbox.md、approval.md ）
- 两个独立旋钮：**沙箱模式**（只管文件效果）和**批准策略**。网络、进程可见性"在这个词表之外"，是否单独做 `network_mode` 文档里写"留到需要的阶段"。
- 沙箱模式 `read-only`（只允许 `/dev/null` 这类必要写入）/ `workspace-write`（工作区加后端承诺的临时区）/ `danger-full-access`（绕过）。
- 批准策略 `ask` / `never`；批准结果 `allowed-once` / `rejected` / `cancelled` / `unavailable`，调用方对后三者都拒绝。

b. 预设：`PermissionPresetService` 把两者打包：默认 `workspace-write`（workspace-write + ask）和 `danger-full-access`（danger-full-access + never）；`auto` 预留给自动审查；`custom` 是派生状态（两旋钮不匹配任何预设时显示）。这和 Codex 的 read-only / workspace-write / danger-full-access 几乎同名同义。

c. 强制：OS 级，Linux bwrap → Landlock，macOS Seatbelt，Windows ACL（有"部分强制"缺口）；找不到可用后端时抛 `SANDBOX_UNAVAILABLE`，**不退化为裸跑**。读：沙箱词表只管写，读不限（推断自"SandboxMode governs filesystem effects only"和模式描述只讲写）。fs 工具走同一词表，由 `dsh-fs-sandbox` 按模式拦写。

d. 宿主
- 按会话：`sandbox/mode`、`approval/policy`、`permission/preset` 事件。
- ACP（`@deepseek-ai/dsh-acp`，标准 ACP v1 自动化子集）：`session/new|list|resume|close|prompt|cancel|set_config_option`、`session/request_permission`；**不支持** `session/load`、`delete`、`fork`、附加目录、modes、commands、terminals、客户端文件系统、elicitation。配置项只有 model 和 reasoning_effort，没有权限配置项。（源码 .agents/notes/archived/feature/2026-08-22-standard-acp-automation-controls.md ）
- 推断：通过 ACP 不能改沙箱模式，只能在启动时配置；这点文档没有明说，是从"modes 不支持、配置项只有 model/effort"推出来的。

e. 问人：ACP 的 `session/request_permission` 加"一次性"回答；没有应答者、应答者抛错、不合规都变成 `unavailable`，等于拒绝（fail-closed）。（源码 docs/subsystems/approval.md ）

f. 全局配置：没查到。

g. 缺口：开发者预览，破坏性变更频繁；ACP 下改不了权限；网络未纳入沙箱词表。

## 3. 跨 agent 的共性（作为设计事实）

1. **"档位"很少真能展开成文件级策略。** 只有 Codex（上一轮已测）和 DeepSeek Harness 把"读写档"做成 OS 沙箱模式；Cursor、Grok、Droid、Copilot 的沙箱是单独的一层，和"批准"是两件事；OpenCode、Goose、Kimi、Pi、Amp 没有 OS 沙箱。
2. **"问人策略"和"文件范围"在几乎所有 agent 里是两个独立旋钮。** 例外是 Goose、Kimi 的模式（只管问不问）。
3. **读限制很少。** 能限制读的：Cursor（`readBoundary`）、Droid（`denyRead`）、Grok（strict 档、自定义 deny）、Codex（上一轮实测）。OpenCode 只能按路径规则拦工具读。其余不能。
4. **网络多半是单独开关，且实现不一致。** Grok 子进程断网只在 Linux；Cursor、Droid、Copilot 用过滤代理加域名白名单；DeepSeek 暂无。
5. **宿主要回答"问人"，ACP 的标准是 `session/request_permission`**，选项以 allow_once / allow_always / reject_once（+ reject_always）为主：Cursor、Kimi、Goose、OpenCode、DeepSeek 都用它；Droid 用自己的 JSON-RPC 方法；Pi 靠扩展；Amp 靠插件。
6. **无人回答时的默认差别很大**：Cursor ACP 会卡住；OpenCode `run` 自动拒；Droid SDK 取消；DeepSeek 拒；Kimi `-p` 直接放行；Pi 看扩展；Copilot、Goose、Grok ACP 没查到。
7. **"always" 类答案会持久化**：Goose 写全局 `permission.yaml`，OpenCode 写 `permission/saved`（按项目），Copilot 按位置持久化，Droid 抬高自治级别，Cursor 加入 allowlist。宿主若转发 allow_always，会改变 agent 以后的行为。
8. **读全局配置放宽宿主限制**是常态：Cursor（团队策略例外）、Grok、OpenCode、Goose、Kimi、Copilot、Droid 都读用户级配置。能用环境变量换配置根的：Cursor `CURSOR_CONFIG_DIR`、Grok `GROK_HOME`、Kimi `KIMI_CODE_HOME`、Copilot `COPILOT_HOME`、OpenCode `OPENCODE_CONFIG_CONTENT`（优先级更高）。

## 4. 对 vonvon 的启示（全部是推断）

1. **别再把"三档 + 网络开关"当成通用抽象。** 它只对 Codex 和 DeepSeek Harness 是原生概念；其他 agent 的沙箱是单独一层、默认常常关，另有"问人"旋钮。抽象应该拆成三件事：文件范围（读/写）、命令与工具策略、问人策略，再加网络。
2. **读范围要单独建模，并标注每个 provider 能不能做到。** 目前原生能做读限制的只有 Codex、Cursor、Droid、Grok（strict/自定义）。对其余 provider，"只读"其实是"不能写"，vonvon 需要在界面上诚实说明，或者不允许选。
3. **群里的"问人"没有人坐在终端前，要先定义 vonvon 自己的答复者。** 既然多数 agent 要么阻塞、要么拒绝，vonvon 应当对每个 provider 声明"无人回答时的行为"，并保证 daemon 在 5–10 分钟内一定回一个答案（超时拒绝），不让 Cursor ACP 那样永远卡。
4. **ACP 的权限请求可以作为统一的"问人"通道**，覆盖 Cursor、Kimi、Goose、OpenCode、DeepSeek，也大概率覆盖 Grok、Copilot（我没查到它们的请求格式，需要实测）；Pi、Amp、Droid 要各写适配（扩展、插件、SDK handler）。vonvon 这一侧的选项集合取交集即可：允许一次、拒绝；`always` 类先不转发，避免改写 agent 的全局配置（见共性 7）。
5. **不要把 provider 的"全放行"模式当默认。** Kimi `-p`、Goose 默认 auto、OpenCode 默认大部分 allow、Amp 默认不拦、Pi 无权限。这些 agent 的"安全"只能靠 vonvon 的外层隔离（容器、独立用户、独立 HOME）。需要的话，把"没有原生限制的 provider"明确分成一类，限制它能绑哪些群。
6. **宿主传的限制必须能防住用户全局配置放宽。** 每个 provider 用各自的配置根环境变量指到 vonvon 管理的目录（`CURSOR_CONFIG_DIR`、`GROK_HOME`、`KIMI_CODE_HOME`、`COPILOT_HOME`、`OPENCODE_CONFIG_CONTENT` 覆盖），否则用户电脑上的 allow 规则、已保存的"总是允许"会悄悄放宽群权限。这在上一轮 Codex/Claude 调研里已经出现过同类问题。
7. **"强制方式"要作为 provider 的能力字段上报**：OS 沙箱 / 进程内规则 / 无。界面按能力显示可选项：有 OS 沙箱的显示读写范围，只有规则的显示"尽力拦截，非安全边界"（Cursor Auto-review、Droid 命令规则、Pi 扩展都是官方自己这么说的）。
8. **运行中改权限能力差别大。** Droid SDK、Goose ACP `set_mode`、Kimi ACP `set_mode`、Copilot ACP allow-all 配置项能按会话改；Cursor、Grok、DeepSeek ACP、OpenCode 只能起进程时定（或改配置文件）。vonvon 的"改设置后热生效"需求，对这几家要用"重启会话"补，界面要说明（与 product.md 里已有的"要 /new 后生效"思路一致）。
9. **预设名字不要沿用 Codex 的。** 各家的预设语义不同（Kimi 的 yolo 仍会问敏感操作，Grok 的 always-approve 仍受 deny 管，Droid 的 high 仍受安全检查和 ask 规则管）。建议 vonvon 自己定义 3–4 个意图（例如"只看"、"改工作区"、"工作区内自动、越界问人"、"完全放开"），每个 provider 写一张映射表，映射不了的显示为不可选，而不是近似。
10. **每个 provider 的"不能做到什么"要写进适配器清单**，沿用上一轮第 6 节的格式，增加四行：读限制、网络限制、问人通道、无人应答默认值、持久化批准的范围。上面的对照表可以直接作为初稿。

## 5. 没查到 / 需要实测的

- Cursor：`-p` 无 `--force` 的行为；全局与项目 permissions 的合并顺序；`sandbox.json` 完整 schema（https://cursor.com/docs/reference/sandbox.md 没取）。
- Grok Build：ACP 下的权限请求和可设项；沙箱不可用时的行为；headless 非 dontAsk 模式的默认；没有公开源码，所以全是文档。
- Copilot CLI：`-p` 下未批准工具的实际结果；ACP 权限请求格式；沙箱 OS 原语。
- Goose：无人应答的默认；`goose run` 在 approve 模式下的行为。
- Amp：旧 `amp.permissions` 的当前状态；插件加载顺序；无头行为。
- DeepSeek Harness：用户全局配置影响；ACP 之外能否按会话传沙箱模式。
- Kimi：规则 scope `turn-override` / `session-runtime` 从 ACP 怎么传。
- 以上所有"行为"都没在本机实测，上一轮调研对 Codex、Claude 的才有实测。
