# comma 怎么安排 agent 自己的家目录和项目工作区（只读调研，2026-10-16）

路径都相对 `/home/operator/vonvon/references/comma`（commit ba4f55d）。没有构建、没有运行。AGPL：只看思路，不抄代码。
标签：**读源码确认** = 我看了代码；**来自文档** = 只在 docs/README 里看到；**未确认** = 推断或依赖 Claude/Codex CLI 自身行为，没在 comma 代码里验证。
已有调研（`docs/research/2026-10-14-strategy/comma.md`、`persona-memory-skills.md` 第 1 节）里讲过的记忆路径、skill 四层，这里只补充和"家目录 vs 工作区"有关的事实。

## 先说结论（一屏）

- comma 没有"agent 家目录 = 真实磁盘目录"的概念。agent 的"家"是服务器端的**每 Agent 一份的虚拟文件系统（VFS，存在 S3）**，里面放 `/memory/...`；人设是 Agent 控制记录里的一个字符串字段；skill 是 `/.runtime/skills/...` 虚拟路径；MCP 是 Group 级绑定，由服务器（或设备进程）连。这些都**拼进一个大系统提示**，再由设备上的 Go connector 交给 Claude Code / Codex。
- Claude Code / Codex 的 cwd 是 connector 给**每个 Session 新建的空目录** `$HOME/.comma/workspaces/<session_id>`，不是用户项目。用户项目通过 `SALIX_ENV_ROOT`（Mac 桌面版 = 用户 home）去找，提示词要求"改项目文件前，在当前 session 工作区里用/建一个 task 专用 worktree"。
- 启动 Claude Code 不传 `--add-dir`、`--mcp-config`、`--setting-sources`、`--plugin-dir`，也不设 `CLAUDE_CONFIG_DIR`；启动 Codex 不设 `CODEX_HOME`、不传 `-c`。所以用户级 `~/.claude`、`~/.codex` 原样继承，项目级配置因为 cwd 是空目录而基本不生效。

---

## 1. agent 自己的 home/state 目录 vs 用户项目目录

### 1a. 服务器端：agent 的"家"是 VFS，不是目录
- **读源码确认**：`AgentWorkspace` 拥有"the agent's virtual filesystem manifest"，文件体是不可变 blob，存在 SalixStore（S3）（`systems/apps/salix_agent/lib/salix_agent/agent_workspace.ex:1-8`）。按 `agent_id` 分（同文件 `State` 结构 `agent_id`、`vfs`，`:36-40`）。
- **来自文档**：概念表 "Agent Workspace / VFS — The Agent's file workspace. It is not Comma's authorization Workspace."（`docs/architecture/DOMAIN_CONCEPTS.md:647`）。注意 comma 里"Workspace"有两个意思：产品授权范围（= Salix Group）和 agent 的 VFS。
- **读源码确认**：文件后端把路径分三类：普通路径 = agent VFS；`/.runtime/compaction-recovery.md` = 只读的 session 运行时文件；`/.runtime/skills/...` = skill 投影挂载；`/drive/...` = 用户的 Comma Drive（`systems/apps/salix_agent/lib/salix_agent/file_backend.ex:2-10`）。`/.runtime/` "is not the agent workspace"，同一路径在两个 session 里是两份文档（`runtime_files.ex:2-8`）。
- **读源码确认**：Worker 的提示词写明 "Private memory from other sessions and other Agents' filesystems are not automatically accessible."（`salix_agent/lib/salix_agent/tool_policy.ex:245`）——每个 Agent 有自己的文件系统。

### 1b. 设备上（Mac 桌面版 / 自托管 connector）
- **读源码确认**：外部运行时（Claude/Codex/Pi/Kimi）的 session 工作区根目录 = `os.UserHomeDir()/.comma/workspaces`（`systems/connector/salix-connect/external_runtime.go:970-979`），每个 session 一个子目录 `filepath.Join(root, sessionID)`（`:1008-1025`），`MkdirAll(..., 0o700)` 由 connector 建（`:1027-1035`）。session id 必须是单段名（`:1009`）。
- **读源码确认**：一旦某 session 的工作区路径写进持久状态，就以持久值为准，后续输入不能改（`external_runtime.go:1011-1016`；`external_runtime_state.go:1914-1935`）；**来自文档**："Once an identity exists, its command, workspace, and native payload remain authoritative; a later input cannot replace or rebind them."（`systems/connector/README.md:414-416`）。
- **读源码确认**：connector 有两个根：
  - `--root`（`SALIX_CONNECTOR_ROOT`，默认 `.`）"base directory for relative paths"（`salix-connect/main.go:735`），给 agent 时叫 `SALIX_ENV_ROOT`。
  - 运行时状态根 `runtimeStateRoot()`：设备模式用 `device_state_root`，否则 `--state-root`，再否则 `--root`（`device_access.go:15-23`）。bbolt 状态库在 `<state>/external-runtime/state.db`（**来自文档** `systems/connector/README.md:400-410`），Pi 的 session-dir 在 `<state>/external-runtime/pi/<session>`（`pi_runtime.go:313-318`），Kimi 的家在 `<state>/external-runtime/kimi/<session>`（`kimi_runtime.go:232`）。
- **读源码确认**：Mac 桌面版（Electron）给 connector 的配置：`root = app.getPath("home")`（即用户 home），`connectorsRootDir = <userData>/connectors`（`clients/apps/electron/src/main/index.ts:1617-1618`）；每个 Comma Workspace 一个目录 `<userData>/connectors/<workspaceStateDirName>`，配置里 `device: true`、`device_state_root: <这个目录>`、`workspace_id`（`clients/apps/electron/src/main/modules/connector-runtime/index.ts:752-758, 1333-1346`）。所以在 Mac 上：`SALIX_ENV_ROOT = ~`，状态在 Electron userData 下，session cwd 在 `~/.comma/workspaces/<session>`。
- **读源码确认**：闲置 session 工作区默认 72 小时后打包成 `~/.comma/workspace-archives/<session>.tar.zst` 并从磁盘删掉，新输入来时先解包（`workspace_archive.go:18-30`；`main.go:726` 开关 `--workspace-archive`）。**来自文档**：打包前会结束 cwd 在该 session 工作区里的残留进程；`node_modules` 等可再生目录不打包，源码、配置和 `.git` 打包（`systems/connector/README.md:655-698`）。
- **读源码确认**：设备模式默认只读（scope `local_file_read`），要用户在设置里开 "Allow operations" 才能跑原生 agent（`main.go:780-782`；**来自文档** `systems/connector/README.md:31-36`）。
- **来自文档**："`--root` is the base directory for relative paths. Absolute paths are resolved as absolute OS paths. The production connector does not impose a filesystem jail"（`systems/connector/README.md:649-653`）。

### 1c. 云端运行时
- **读源码确认**（外部 Worker 镜像）：`install -d -o node /workspace`、`ENV HOME=/workspace`、`WORKDIR /workspace`、`USER node`，构建时断言 `/workspace/.claude` 和 `/workspace/.claude.json` 不存在（`systems/runtime-images/external/Dockerfile:110-124`）。connector 的 `--root` 默认 `.`，所以 root = HOME = `/workspace`。
- **来自文档**："Target uid1000, HOME/WORKDIR=/workspace, cwd=`/workspace/.comma/workspaces/<session>`."（`docs/compute-devices.md:187`）。迁移表：Codex 只把选中的 rollout 移进目标 `CODEX_HOME` sessions，"Do not fork or copy the whole home/auth store"；Claude 移 project JSONL、subagents、sidecars；Pi 移进 connector 的 `external-runtime/pi/<session>`（`docs/compute-devices.md:191-195`）。
- **读源码确认**：云端外部 Worker 的 `salix` CLI shim 放在 `c.root`（因为镜像根只读），设备上放系统临时目录（`main.go:5800-5822`）。
- **来自文档**：Cloudflare 云 VM：`/home/sprite` 链到 `/workspace/.salix/sprite-home`；"Its HOME and Connector state are under `/home/sprite/.local/share/salix/connector-home`. Its command and file root remains `/workspace`."（`docs/architecture/DOMAIN_CONCEPTS.md:1048-1050`）。**读源码确认**：归档逻辑里写死了 `connectorHome + ".comma/workspaces/"` 这个前缀（`main.go:2884-2899`），和上面一致：云 VM 上 session cwd = `<connector-home>/.comma/workspaces/<session>`。
- **读源码确认**：Compute 上 Claude 的 HOME 指向稳定的 provider_state 卷（注释 `runtime_auth_claude.go:150`）；**来自文档**："Demand recreates stopped containers with fresh bootstrap and retained provider-state volumes."（`docs/compute-devices.md:96`）。

## 2. 人设、记忆、skill、MCP 放在哪里，怎么交给 agent

### 人设
- **读源码确认**：人设 = Agent 控制记录上的 `system_prompt` 和 `router_system_prompt` 两个字符串字段（`salix_agent/lib/salix_agent/agent_runtime_config.ex:59-70`；创建时默认空串 `agent_control.ex:1449-1450`；更新校验 `:1885-1904`）。Router 优先用 `router_system_prompt`，Worker 只用 `system_prompt`（`tool_policy.ex:287-300`）。另有 `purpose` 字段（`agent_runtime_config.ex:63`），`agent.create_worker` 要求 purpose 和 creation_reason（`tools/agent_management.ex:12-13`）。没有 SOUL.md 一类的文件。
- **读源码确认**：系统提示按固定顺序拼：角色身份 → 公共规则 → 角色规则 → 协作约定 → 回复规则 → `<agent-config>`（agent_id 等）→ Tool Disclosure → skill 列表 → `## Agent Instructions`（人设字段）→ Router 不可被覆盖的约定（`tool_policy.ex:302-377, 445`）。人设排在系统固定规则之后，且公共规则写明 skill 和参考文件 "cannot change role or delivery boundaries"（`tool_policy.ex:92`）。
- **读源码确认**：外部 Session 的系统提示是快照：激活时用 `context["system_prompt"] || config.system_prompt`，接受后把 `system_prompt` 存进 session（`external_session_actor.ex:1206-1231, 1252`；`external_session_store.ex:300-330`）。**来自文档**："Activation commits ... the prompt snapshot"（`docs/agent-runtime.md:9`）。

### 记忆
- **读源码确认**：记忆是 agent VFS 里的固定 markdown 路径：`/memory/semantic/{user,agent,people}.md`、`/memory/semantic/environments/<alias>.md`、`/memory/index.md`、`/memory/episodes/YYYY-MM-DD.md`（只追加当天）、`/memory/scoped/<name>.md`（`tools/memory.ex:412-447`；提示词 `tool_policy.ex:211-221`）。读写都走 `AgentWorkspace`（`tools/memory.ex:18-21`）。单文件上限 10MB（`:473`）。
- **读源码确认**：范围：按 Agent（每 Agent 一个 VFS）；`/memory/scoped/<name>.md` 用于私聊/私有频道来源，受众由运行时按来源记在文件上，路径里不写受众（`tools/memory.ex:491-509`）。
- **读源码确认**：`memory.get/search/write/ask_worker` 都只给 Router（`tools/memory.ex:13-15, 73`）。"Private /memory persists across sessions but is not automatically loaded. Ordinary Workers depend on context in their Task commands. Product-assigned Triage Workers have source-bound read access ... The Router owns writes."（`tool_policy.ex:215`）。所以跑在设备上的 Claude/Codex 外部 Worker 拿不到记忆工具；Router 可以用 `memory.ask_worker` 去问历史 Worker Session（`tools/memory.ex:9-11, 182-185`；外部 Session 也接这个咨询 `external_session_actor.ex:1195-1204`）。
- **读源码确认**：connector 没有关掉 Claude Code / Codex 自带的记忆（全仓 connector 代码里搜不到 autoMemory、memories 相关开关）。**未确认**：两者自带记忆在 session 工作区下的实际行为。

### Skill
- **读源码确认**：skill 存在 SkillStore（S3），分 global、tenant、group、agent 四层（`skill_store.ex:66-77`），再加镜像里只读的内置 skill（`resources/salix-system-files/skills/`，**来自文档** `docs/tools-integrations.md:20`）。合并时顺序是 [内置, global, tenant, group, agent] 倒序遍历，按 id 和名字先到先得，所以 agent > group > tenant > global > 内置（`skill_projection.ex:346-378`）。
- **读源码确认**：agent 自己建的 skill 写在 **group 层**（`origin: "agent_created"`、`created_by_agent_id`），同组 agent 都能看到（`skill_store.ex:79-120`）。
- **读源码确认**：交付方式：系统提示里列出 skill 名、描述和位置 `/.runtime/skills/<id>/SKILL.md`，正文按需读（`skill_projection.ex:113-152`；`tool_policy.ex:316-318`）。`/.runtime/skills` 是虚拟路径，"not physical S3 keys"（`skill_store.ex:5-7`）。外部运行时通过 `"$SALIX_CLI" tool call <工具> --json ...` 调 Salix 文件工具去读（`tool_disclosure.ex:303-305`）；fs 工具没有按运行时类型屏蔽（只有 history、recommendations 限 internal：`tools/history.ex:45-51`、`tools/recommendations.ex:11`）。**未确认**：实测外部 Worker 是否真的去读。
- **读源码确认**：connector **不把 Salix skill 写成 Claude/Codex 的原生 skill 目录**（connector 代码里除 Kimi 外没有 skills 相关逻辑）。

### MCP
- **读源码确认**：MCP 定义分系统级和租户级；绑定是 **Group 级**记录 `ctl_mcp_group_binding(tenant, group, binding_id)`，字段有 `placement`（服务器或 `device`）、`device_runtime_id`、`config_values`、`root_grants` 等（`systems/apps/salix_mcp/lib/salix_mcp/store.ex:299-338`）。`device` 放置时：stdio 或 streamable-http、在设备上起进程、`filesystem_roots = root_grants`（`store.ex:588-600`）。设备进程的 working_dir 必须在 root_grants 内（`salix-connect/main.go:6673-6685`）。
- **读源码确认**：MCP 工具进 Tool Disclosure，外部运行时同样用 `$SALIX_CLI tool call` 调（`round_config.ex:325-340, 365-399`；**来自文档** `docs/tools-integrations.md:10`）。
- **读源码确认**：正式启动 Claude 时**没有** `--mcp-config` / `--strict-mcp-config`；只有鉴权自检的一次性调用用了 `--safe-mode --setting-sources "" --strict-mcp-config --mcp-config {"mcpServers":{}} --disable-slash-commands --tools "" --no-session-persistence --system-prompt ...`，cwd 是临时目录（`runtime_auth_claude.go:376-396`）。Codex 侧遇到 `mcpServer/elicitation/request` 一律回 decline（`main.go:6225-6226`）。

## 3. 用什么 cwd、什么参数和环境变量启动

### Claude Code（`systems/connector/salix-connect/claude_runtime.go`）
- **读源码确认** 参数（`:420-468`）：
  - 可选前缀 `--settings <CLAUDE_CONFIG_DIR 或 ~/.claude>/salix-auth-settings.json`：只在这个鉴权载体文件存在时加（`runtime_auth_claude.go:16, 151-163, 225-231`）；内容只允许 `{"env":{一个鉴权变量}}`（`runtime_auth_claude.go:30-40`）。用托管凭证时不加 `--settings`，改为注入 `ANTHROPIC_BASE_URL` + 一个鉴权变量，并过滤掉继承的同类变量（`claude_runtime.go:412-427, 484-495`；`runtime_auth_claude.go:233-270`）。
  - `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions`
  - `--session-id=<预生成 id>` 或 `--resume=<id>`；可选 `--model`、`--effort`。
  - `--append-system-prompt-file <os.TempDir()/salix-claude-system-prompt-*>`，内容 = 服务器系统提示 + connector 的主机说明（`claude_runtime.go:448-468`；`main.go:6623-6639`）。原因注释："Linux bounds each exec argument."
  - **没有**：`--add-dir`、`--mcp-config`、`--setting-sources`、`--plugin-dir`、`--system-prompt`（正式启动时）。全 connector 搜 `add-dir`、`writableRoots`、`--cd` 都没有。
- **读源码确认** cwd：`cmd.Dir = input.workspace`，即 session 工作区（`claude_runtime.go:472`）。
- **读源码确认** 环境：先继承 connector 进程的全部环境（`execEnv` 从 `os.Environ()` 起，`main.go:4367-4397`），再覆盖 `PATH`（前面加 salix CLI 目录）、`SALIX_CONNECT_URL`、`SALIX_CLI`、`SALIX_ENV_ROOT = connector root`、`SALIX_RUNTIME_CONTEXT`（`claude_runtime.go:477-483`）。不设 `CLAUDE_CONFIG_DIR`、不改 `HOME`。（README 只说 Codex/Pi/Kimi 拿 `SALIX_ENV_ROOT`（`systems/connector/README.md:233-235`），代码里 Claude 也拿。）
- **读源码确认**：托管凭证时，若 session 工作区下 `.claude/settings.json` 或 `settings.local.json` 含鉴权键（`ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、`apiKeyHelper`），或用户 Claude 配置目录里有非空 `.credentials.json`/鉴权设置，就拒绝启动（`claude_runtime.go:413-419, 584-636`；`runtime_auth_managed.go:238-252`）。

### Codex（`systems/connector/salix-connect/main.go`）
- **读源码确认** 进程：`codex app-server --disable tool_suggest --listen ws://127.0.0.1:<端口>`（`main.go:3760-3762`），**cwd = connector root**（`cmd.Dir = c.root`，`main.go:5720`），环境同样继承全部再加 `SALIX_CONNECT_URL`、`SALIX_CLI`、`SALIX_ENV_ROOT`、`PATH`（`main.go:5721-5726`）。每个 Codex 命令路径一个共享 app-server，多个 thread 共用（`main.go:423-431, 5663-5668`；**来自文档** `systems/connector/README.md:671-675`）。
- **读源码确认** `CODEX_HOME`：正常路径传空，不设（`main.go:5696-5698, 5728-5730`）；只在迁移校验时指向暂存 home（`external_runtime_migration.go:1542-1543`），以及 API key 登录时用一次性临时目录当 `HOME`/`CODEX_HOME`（`runtime_auth_codex.go:84-96`）。所以正常运行用用户自己的 `CODEX_HOME` 或 `~/.codex`。
- **读源码确认** `thread/start` 参数（`main.go:5973-5983`）：`approvalPolicy:"never"`、`sandbox:"danger-full-access"`、`serviceName:"salix"`、`cwd: <session 工作区>`、`baseInstructions: <服务器系统提示>`、`developerInstructions: codexDeveloperInstructions()`、`ephemeral:false`。`thread/resume` 同样带 cwd、baseInstructions、developerInstructions（`:5995-6003`）。`turn/start` 每轮带 `approvalPolicy:"never"` 和 model/effort（`:6042-6066`）。**没有** `-c` 覆盖、没有 writable roots。
- **读源码确认**：`developerInstructions` 内容：外部 Worker 身份、主机说明、"Assistant text ... is not visible"、用 `"$SALIX_CLI" tool call` 做 Salix 操作、IM 回复必须走工具（`main.go:6612-6621`）。
- **读源码确认**：模型和 effort 的默认值用 `config/read` 按 thread 的 cwd 读，注释写 "so a workspace `.codex/config.toml` applies"（`main.go:7400-7432`）——这里的 workspace 是 session 工作区。
- **未确认**：`baseInstructions` 在 Codex 里是替换内置基础指令（按 Codex app-server 协议推断，comma 代码没写效果）。

### connector 给所有外部运行时的主机说明（`main.go:6632-6639`，读源码确认）
"Run commands on this connector host directly with your native shell. The current working directory is an isolated session workspace and may be empty. SALIX_ENV_ROOT is the Connector-managed local environment root. When work needs an existing local project, inspect SALIX_ENV_ROOT first. Before modifying project files, use or create a task-specific worktree in the current session workspace; do not guess from unrelated temporary directories or another session's workspace. Use env.exec only for a different connected environment."
**来自文档**："Every native runtime keeps the Connector-assigned session workspace as its cwd ... An empty session workspace therefore does not make a provider guess project context from temporary directories or another session."（`systems/connector/README.md:233-239`）

### Pi 和 Kimi（对照用）
- **读源码确认** Pi：`--mode rpc --session-dir <state>/external-runtime/pi/<session> [--session ...] [--provider/--model/--thinking] --append-system-prompt <session-dir 里的提示文件>`，cwd = session 工作区（`pi_runtime.go:313-395`）。托管凭证时另建 `managed-pi/<session>` 目录并设 `PI_CODING_AGENT_DIR`（`pi_runtime.go:346-356, 487-503`）。探测时才加 `--no-extensions --no-skills --no-prompt-templates --no-themes`（`runtime_discovery.go:480`），正式运行不加。
- **读源码确认** Kimi：**每个 session 一个独立的 `KIMI_CODE_HOME`** = `<state>/external-runtime/kimi/<session>`；把用户 Kimi 家里的 `config.toml`、`credentials`、`skills`、`plugins` 符号链接进去（目标已存在就跳过）；`AGENTS.md` 重新生成 = 用户全局 `AGENTS.md` + 系统提示拼接；cwd = session 工作区（`kimi_runtime.go:232-254, 842-897`）。这是 comma 里唯一一个"给 agent 造一个继承用户全局配置的独立 home"的实现。

## 4. 一个 session 能不能动别的工作区、多个项目文件夹

- **读源码确认**：外部 Worker 没有固定"项目"概念。cwd 是空 session 目录，项目靠 agent 自己在本机用绝对路径找（主机说明让它先看 `SALIX_ENV_ROOT`），改之前在 session 目录里建 worktree（`main.go:6632-6639`）。connector 不设文件系统隔离（**来自文档** `systems/connector/README.md:649-653`），Codex 用 `danger-full-access`，Claude 用 `bypassPermissions`（上面第 3 节）。所以本机上任何路径都能碰。
- **读源码确认**：碰**别的机器/环境**走 Salix 工具 `env.exec`，参数带 `device_id`、`environment`、`working_dir`（主机说明 `main.go:6638`；内置 codex skill `resources/salix-system-files/skills/codex/SKILL.md:10-12, 90-104`）。connector 侧 `working_dir` 相对 `--root` 解析，设了 `enforce_root`/`root_grants` 才限制在 root 内（`main.go:6673-6685, 4193-4202`）。设备和 VFS 之间可以 `env.copy`（`resources/salix-system-files/skills/connect-device/SKILL.md:31-32`）。
- **读源码确认**：内置 `codex` skill 是另一条路：内部 agent 通过 `env.exec` 在目标仓库根目录起 `codex app-server --listen stdio://`，`thread/start` 的 `cwd` 就是仓库路径，只给 `developerInstructions`，不覆盖 base；只有云 VM 默认加 `--dangerously-bypass-approvals-and-sandbox`（`resources/salix-system-files/skills/codex/SKILL.md:17-20, 90-143`）。这条路下 Codex 直接在用户仓库里工作。
- **读源码确认**：外部 Worker 换目标机器用 `agent.rebind_runtime`，只影响新 Session，老 Session 留在原目标（`tools/agent_management.ex:16-17`；**来自文档** `docs/compute-devices.md:22`）。
- **未发现** `--add-dir`、Codex writable roots 或"多个工作区挂进一个 session"的机制（全 connector、runtime-images、Electron 搜索为空）。

## 5. 工作区级 skill / MCP / CLAUDE.md / AGENTS.md：继承、合并、忽略还是覆盖；会不会往用户项目里写文件

- **读源码确认**：Claude 启动时不限制 setting sources、不指定 MCP、不改 `CLAUDE_CONFIG_DIR` 和 `HOME`（第 3 节）。**未确认**（取决于 Claude Code 默认行为）：用户级 `~/.claude/settings.json`、`~/.claude/CLAUDE.md`、用户 skill、用户 MCP、插件都会加载；项目级的只从 cwd（空的 session 目录）找，所以用户项目的 `CLAUDE.md`、`.claude/skills`、`.mcp.json` 启动时不加载，agent 进到 worktree 子目录读文件时可能按需读到子目录的 `CLAUDE.md`。
- **读源码确认**：Codex 用用户自己的 `CODEX_HOME`（第 3 节），所以用户全局 `config.toml`、`AGENTS.md`、skills、MCP 都在。**未确认**：项目 `AGENTS.md` 按 cwd 查找，session 目录里没有，所以启动时不读用户项目的 `AGENTS.md`；session 目录里的 `.codex/config.toml` 会被 `config/read` 读到（`main.go:7400-7402` 注释明说）。
- **读源码确认**：Kimi 显式"继承用户全局 + 拼上系统提示"：用户 `AGENTS.md` 内容在前、系统提示在后，写成 per-session 的 `AGENTS.md`；`skills`、`plugins`、`config.toml`、`credentials` 用符号链接共享（`kimi_runtime.go:842-878`）。
- **读源码确认**：Salix 自己的 skill 和 MCP 不落盘给原生 CLI，只在系统提示和 `$SALIX_CLI` 工具里出现（第 2 节）；同名 skill 具体层覆盖通用层（`skill_projection.ex:354-378`）。
- **往哪里写文件**（读源码确认）：
  - session 工作区 `~/.comma/workspaces/<session>` 和归档 `~/.comma/workspace-archives/`（`external_runtime.go:970-979`；`workspace_archive.go:18-24`）。
  - Claude 提示文件写系统临时目录（`claude_runtime.go:449`）；salix CLI shim 写系统临时目录（设备）或 connector root（云）（`main.go:5800-5822`）。
  - Claude 鉴权载体 `salix-auth-settings.json` 写进用户的 `CLAUDE_CONFIG_DIR` 或 `~/.claude`，写原生 `.credentials.json` 成功后会删掉这个载体（`runtime_auth_claude.go:16-17, 151-163, 272-302, 315-342`）。
  - Pi/Kimi 的 home 和会话文件写在 connector 状态根下（第 1 节）。
  - connector 代码里没有往用户项目目录写文件的逻辑。**未确认**（git 行为）：agent 按提示在 session 目录里 `git worktree add` 时，会在用户仓库的 `.git/worktrees/` 下写元数据。
- **冲突处理**（读源码确认）：只看到鉴权冲突：托管凭证遇到工作区或用户目录里已有的鉴权设置就拒绝启动，不覆盖（`claude_runtime.go:584-636`；`runtime_auth_managed.go:238-252`）。Kimi 的符号链接遇到已存在的目标就跳过（`kimi_runtime.go:854-857`），`AGENTS.md` 每次启动重写（`kimi_runtime.go:866-878`）。没看到对用户项目里 `CLAUDE.md`/`AGENTS.md` 的任何合并或覆盖逻辑。

## 6. 多个 agent / 人设共用一个工作区

- **读源码确认**：一个 Comma Workspace = 一个 Salix Group，里面一个 Router 加 N 个 Worker（`tool_policy.ex:108`："A workspace is a Group, which owns its Router, Workers, conversations, and VM capabilities."）。Router 一个长期 Session 交错处理所有会话（`tool_policy.ex:53-59`）；Worker 每个 Task 一个新 Session（`tool_policy.ex:65-69`；**来自文档** `docs/architecture/PRODUCT_MODEL.md:102, 112`）。
- **读源码确认**：每个 Agent 各有自己的人设字段、VFS（记忆）和 agent 层 skill；group 层 skill、Group 的 MCP 绑定、插件投影（按 tenant + group，`round_config.ex:450-467`）在组内共享（第 2 节）。
- **读源码确认**：同一台设备上，所有外部 Worker 共用一个 connector root（`SALIX_ENV_ROOT`）、同一个 `~/.comma/workspaces/` 根和用户级 CLI 配置，靠每个 session 一个子目录隔开；提示词让它们别去猜"another session's workspace"（`main.go:6636-6637`）。同一 Codex 命令的多个 session 共用一个 app-server 进程（`main.go:5663-5668`）。
- **来自文档**："Targets share the Group VM trust domain. They are not separate hostile-code sandboxes."（`docs/architecture/DOMAIN_CONCEPTS.md:1054`）。
- **读源码确认**：Mac 上连多个 Comma Workspace 时，每个 Workspace 一个 connector 进程、一个状态目录，但 root 都是用户 home，session 工作区根也都在 `~/.comma/workspaces/`（`clients/apps/electron/src/main/index.ts:1617-1618`；`connector-runtime/index.ts:752-758, 1340-1345`；`external_runtime.go:970-979`）。
- **未确认**：是否允许多个 Worker 绑定同一个设备运行时。`agent.create_worker` 说明里写"Existing Workers are compared by purpose and runtime capabilities"（`tools/agent_management.ex:12-13`），我没找到唯一性限制。
- **来自文档**（已有调研）：BFT 每个组织只能有一个飞书应用开群机器人用途，同时只连一个 Agent Swarm（`docs/user_manual/bridge_for_teams/manual_zh.tex:199`）。

---

## 和 vonvon 新想法对得上的几处事实（只列事实，不展开建议）

- comma 把"agent 自己的东西"（人设、记忆、skill）放在服务器上、按 Agent/Group 分层；设备上 agent 的 cwd 是 connector 自建的**每 session 空目录**，不是 bot 家目录，也不是项目目录。
- 用户项目通过环境变量（`SALIX_ENV_ROOT`）和提示词指过去，不通过 `--add-dir` 或 cwd。
- 继承用户全局配置：Claude/Codex 是"什么都不改，自然继承"；Kimi 是"新建 per-session home，符号链接用户的 config/credentials/skills/plugins，拼接用户 AGENTS.md + 系统提示"。
- 工作区（项目）级的 CLAUDE.md/AGENTS.md/skills/MCP：comma 没有专门处理，因为 cwd 不在项目里，启动时基本不加载（未确认，依赖 CLI 行为）。
