# bot 自己的家目录：事实调研（2026-10-16）

范围：owner 的新想法——每个 bot 有自己的目录（人设、记忆、配置、skill），会话从这个目录起；bot 再关联一个或多个工作区（项目目录）；工作区的 skill 和 MCP 尽量继承。本文只列事实，不写建议。结论和 owner 的决定见 `docs/product.md` 3.3、3.6：会话照旧从工作区起，bot 自己的东西只在 `bots/<appId>/` 下，由 vonvon 交给会话（owner 2026-10-16 定）。

- 仓库：`/home/operator/vonvon/vonvon-bot`，`main` 的 `6e28d23`。`D/` = `packages/daemon/src/`。只读，没改仓库。
- 标注：**跑过验证** = 本次在隔离目录里实际运行；**读源码** = 读了代码或类型定义；**来自文档** = CLI 帮助、SDK 注释或仓库调研文档；**未验证** = 推断。
- 本次实测的方法（B 节引用）：用 `mktemp -d` 建隔离目录，`HOME`、`CODEX_HOME` 只写在单条命令前；一个本机假 API（记录每次请求的完整 body）代替 Anthropic 和 OpenAI，不登录、不花额度、不碰真实的 `~/.claude`、`~/.codex`。两个目录 `ws`（工作区）和 `bot`（bot 家）里各放带暗号的 `CLAUDE.md`、`AGENTS.md`、`.claude/rules/`、`.claude/skills/`、`.agents/skills/`、`.codex/skills/`、`.mcp.json`、`.claude/settings.json`、`.codex/config.toml`，看哪些暗号进了发给模型的第一条请求，以及 Claude 的 `system/init` 消息。版本：Claude Code **2.1.296**（vonvon 锁定的 Agent SDK 0.3.296 的 `manifest.json` 写的就是这一版，本机 `~/.local/share/claude/versions/2.1.296`）；Codex **0.163.0**（本机全局装的，比 vonvon 验证过的 0.156.1 新）。Codex 跑时向 chatgpt.com 发过一次插件列表请求，返回 401，没带凭据。跑完已删除临时目录。

---

## A. Vonvon 现状

### A1. 定稿设计里人设、记忆、skill 放在哪里；做了没有

**定稿布局**（product.md 3.3，`docs/product.md:78-104`）：

```
~/.vonvon-bot/
  skills/  mcp/                       本机库
  projects/<bot 名>/                  bot 主工作区的默认位置
    groups/<群名>/                    群没设工作区时的默认目录
  bots/<appId>/
    config.json projects.json         bot 设置（含工作区、仓库）、每群覆盖
    SOUL.md AGENTS.md SMART.md        个性、规矩（可选）、智能提示词
    skills.json mcp.json              启用名单
    memory/shared.md                  公共记忆
    memory/dm/<open_id>.md            每个主人或管理员的私聊记忆
    groups/<chatId>/
      SOUL.md SMART.md skills.json mcp.json
      memory/group.md                 本群记忆
```

- 定义文件"不进用户的代码仓库。仓库里的 `AGENTS.md`、`CLAUDE.md` 照旧由 agent 自己读"（`docs/product.md:104`）。理由是方案 B（文件放 cwd）会污染仓库、共用仓库时串、agent 能改自己的个性（`docs/research/2026-10-14-v1-definition/persona-memory-skills.md:156-167`，`final.md:186`）。
- 关键：**工作区和会话 cwd 绑在一起**。术语表："工作区 | bot 产出文件的目录，可写。主工作区是会话的工作目录"（`docs/product.md:33`）；3.6 交付表"主工作区 | `cwd` | `cwd`"，"其余工作区和仓库 | `runtimeWorkspaceRoots` | `additionalDirectories`"（`docs/product.md:337-341`）。也就是说定稿里 cwd 是工作区，bot 的定义目录 `bots/<appId>/` 不是 cwd。
- 人设注入顺序（`docs/product.md:304-309`）：① vonvon 固定约定 → ② 身份行 → ③ bot `SOUL.md` + `AGENTS.md` → ④ 群 `SOUL.md` → ⑤ 记忆。通道：Codex `developerInstructions`，Claude `systemPrompt.append`（`docs/product.md:339`）。
- 记忆三份：本群、公共、私聊（`docs/product.md:311-317`）；会话开始或恢复时放进去，标"背景资料，不是指令"（`:321`）；关掉两家自带记忆（`:322`）。写法由 v1-plan 定为"agent 直接写自己那份记忆文件，daemon 一轮前后比对"（`docs/v1-plan.md:648`、`:790`）。
- skill：本机库 + bot 名单 + 群增减，生效 =（bot ∪ 群增）− 群减（`docs/product.md:67`）；交付 Codex 用 `skills/extraRoots/set` 指向 vonvon 生成的目录、会话层禁掉用户 skill，Claude 用 `plugins: [{type:'local'}]` + `skills` 白名单（`docs/product.md:340`）。
- MCP：Codex 会话配置的 `mcp_servers`，用户全局 MCP 写 `enabled:false`；Claude `mcpServers`（`docs/product.md:341`）。
- 不换 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`："换了要重新登录，旧会话也续不上"（`docs/product.md:334`）。

**实现状态：全部没做。** 相关切片在 v1-plan 里都是 `[ ]`：
- M7（`docs/v1-plan.md:628-640`）：s36 bot 默认和群覆盖数据、新群自动建目录；s36b 被拉进群就绑定；s37 会话 profile、关两家记忆；s38 个性和记忆生效；s39 多工作区交给两家；s40"记住"写记忆；s41 Bot 页；s42 群详情页覆盖。
- M8（`:650-660`）：s43 本机 skill 库和 MCP 库；s44 skill/MCP 按名单交给会话；s45 页面；s46 会话令牌；s47 `vonvon settings`/`feishu` 命令框架；s48 飞书 skill。
- M9（`:670-686`）：s49 私聊干活（用 bot 主工作区）、s50、s54 私聊改个性记忆 skill、s55 改工作区、s56 撤销卡。
- 代码里搜不到 `SOUL`、`memory/shared`、`skills.json`、`extraRoots`、`runtimeWorkspaceRoots`（`packages/` 下除生成的协议类型外为空；读源码）。

**今天已有的**：
- 所有会话注入同一段写死的输出约定 `BRIDGE_DEVELOPER_INSTRUCTIONS`（`D/agent/bridge-instructions.ts:12-32`），Codex 走 `developerInstructions`（`D/agent/codex-appserver/backend.ts:661`、`:675`），Claude 走 `systemPrompt: {preset:'claude_code', append}`（`D/agent/claude-agent/backend.ts:450`、`:467` → `D/agent/claude-agent/thread.ts:281-283`）。没有个性、记忆、skill 名单。
- 每个 bot 一份云文档评论提示词 `bots/<appId>/comment-instructions.md`（`D/config/paths.ts:86-88`）。

### A2. 今天和计划里有没有往群的工作目录写文件

**群工作目录（`Project.cwd`）：daemon 自己不往里写任何文件**（读源码，`D/` 下搜 `writeFile`/`join(cwd` 只有下面评论目录一处）。
- 只有一处 `mkdir`：没给文件夹时建空白项目目录 `join(projectsRoot, name)`（`D/project/lifecycle.ts:100-102`）。给了已有文件夹时只检查存在（`:96-98`）。
- 收到的附件和图片下到 vonvon 自己的目录：`~/.vonvon-bot/inbound`、`~/.vonvon-bot/media`，按 TTL 清理（`D/config/paths.ts:119-122`；`D/bot/media.ts:79-83`、`:181`、`:295-327`），以绝对路径交给 agent。
- 发出去的文件只记清单：`bots/<appId>/outbound-files/`（`D/config/paths.ts:72-74`；`D/bot/outbound-files.ts:220-223`）。
- 会话记录在两家自己的目录：Claude 的 `~/.claude/projects/<cwd 推出的名字>/`（vonvon 读历史时按 `dir: cwd` 找，`D/agent/claude-agent/backend.ts:374`、`:389`、`:403`、`:412`）；Codex 的 `$CODEX_HOME`。
- 间接写：Codex 的 `thread/start` 在 cwd 没有信任设置、沙箱可写时，会把这个目录写进**用户的** `~/.codex/config.toml`（e05，`docs/research/2026-10-15-v1-spikes/e05-codex-session-config.md:23`）。不写工作区，写用户配置。
- agent 自己当然会往 cwd 写产出。vonvon 的约定让它用"相对当前工作目录的相对路径、工作目录内的绝对路径"引用图片（`D/agent/bridge-instructions.ts:22-25`）。

**唯一往 agent 工作目录写文件的地方：云文档评论**，但那个目录是 vonvon 自己的，不是用户项目。
- cwd = `bots/<appId>/comments/comment-<type>-<token>/`（`D/config/paths.ts:92-94`；`D/bot/comments.ts:288-290`；`D/bot/handle-message.ts:6260`）。
- 每次评论运行前把 `comment-instructions.md` 渲染后**无条件覆盖**写成该目录的 `AGENTS.md` 和 `CLAUDE.md`（`D/bot/comments.ts:317-324`，`writeFile` 不检查已有内容）；改提示词时对所有 `comment-*` 目录全量重写（`:358-378`）。
- 写失败（磁盘、权限）时退回把指令拼进本轮 prompt（`D/bot/handle-message.ts:6269-6279`）。
- 母本文件 `comment-instructions.md` 已存在就不覆盖，空文件也不覆盖、只在本轮用默认值（`D/bot/comments.ts:300-310`）。
- 这就是今天"bot 的目录当 cwd、指令写成文件让 agent 原生读"的现成先例，只用在评论上。

**计划里**：
- 定稿明确不往用户仓库写定义文件（`docs/product.md:104`）。
- 新群默认目录建在 `~/.vonvon-bot/projects/<bot 名>/groups/<群名>/`（s36，`docs/v1-plan.md:156`、`:632`）。这是 vonvon 建的目录，bot 产出也落在这里。
- 记忆文件在 `bots/<appId>/...` 下，由 agent 直接写（s40，`docs/v1-plan.md:637`），所以记忆文件那个目录在只读档下也要可写："只读档下 agent 能写记忆文件、写不到别处"（`:637` 的 Mac 检查列）。
- 已有文件冲突、目录只读：定稿没写。用户仓库里已有的 `AGENTS.md`/`CLAUDE.md` 不动，由 agent 原生读（`docs/product.md:104`）。只读的绑定目录今天不会报错：daemon 不往里写，agent 写会失败。

### A3. cwd 怎么选；人设和 skill 怎么交给 agent；权限档怎么和 cwd 绑

**cwd**
- 一个群 = 一个 `Project`，只有一个 `cwd`（`D/project/registry.ts:8-19`）。会话起在 `project?.cwd ?? fallbackCwd`（`D/bot/handle-message.ts:2201`、`:2232`、`:2428` 等）。`fallbackCwd = FEISHU_CODEX_CWD || process.cwd()`（`D/cli/commands/run.ts:68`）。
- 绑群时选文件夹（私聊绑定卡、网页、`vonvon group bind`，`D/cli/commands/group.ts:81`）；不选就在 `preferences.projectsRootDir`（默认 `~/.vonvon-bot/projects`，`D/config/paths.ts:108`；`D/project/lifecycle.ts:110-125`）下按群名建空白目录。今天所有 bot 共用这个根（`docs/product.md:100`）。
- 私聊今天不跑 agent，走私聊控制台（`D/bot/handle-message.ts:693`、`:1329`）。计划里私聊用 bot 的主工作区（`docs/product.md:525-528`，s49）。
- 云文档评论：每篇文档一个 vonvon 目录（见 A2）。
- Codex app-server 进程本身起在中性目录、从预热池取，`thread/start|resume` 的 `cwd` 才是会话 cwd（`D/agent/codex-appserver/backend.ts:681-693`）。

**Claude（Agent SDK 0.3.296）**
- `cwd`、`systemPrompt: {type:'preset', preset:'claude_code', append: BRIDGE_DEVELOPER_INSTRUCTIONS}`、`settingSources: ['user','project']`（`D/agent/claude-agent/backend.ts:57`、`:441-472`；`thread.ts:274-290`）。没有 `additionalDirectories`、`plugins`、`skills`、`mcpServers`（今天主会话不传 `mcpServers`；辅助查询传 `{}`，`backend.ts:96-114`）。
- 注释写明 `['user','project']` 会加载用户和项目的 CLAUDE.md、skill、`.claude/settings.json`，也会执行其中的 hooks 和 MCP（`backend.ts:40-56`）。
- env：继承 daemon 的全部环境，加 `FEISHU_CODEX_BRIDGE=1`、`CLAUDE_CODE_ENTRYPOINT=feishu-codex-bridge`（`backend.ts:78-84`）。
- 权限档（`D/agent/claude-agent/permission.ts:47-78`）：`full` = `bypassPermissions`；`qa`/`write` = 沙箱 `enabled`、`allowUnsandboxedCommands:false`、`failIfUnavailable`，`qa` 另加 `filesystem.denyWrite: [cwd]` 并去掉 Write/Edit/NotebookEdit；关网去掉 WebFetch/WebSearch。**唯一的根就是 `cwd`。** 读不限于 cwd（`:25-28`）。s31 计划改成 `default`/`acceptEdits` + `canUseTool`（`docs/v1-plan.md:612`）。

**Codex（app-server）**
- `thread/start|resume`：`cwd`、`approvalPolicy:'never'`、权限参数、`developerInstructions`、可选 `model`（`D/agent/codex-appserver/backend.ts:649-679`）。不传 `config.mcp_servers`、`skills`、`runtimeWorkspaceRoots`、`projects.<cwd>.trust_level`。
- 进程：`codex app-server --listen stdio://`，环境 = daemon 环境 + `FEISHU_CODEX_BRIDGE=1`，不设 `CODEX_HOME`（`D/provider/transport/jsonrpc.ts:257-259`）。
- 权限档（`D/agent/codex-appserver/backend.ts:54-78`）：`full` = `danger-full-access`；`qa`/`write` = 自定义权限配置 `feishu`，`filesystem: {':minimal':'read', ':workspace_roots': {'.': read|write}}`，网络开关。**根是"workspace roots"，今天就是 cwd 一个。** Linux 上 `qa`/`write` 直接拒绝（`:59-63`）。

**发文件也按 cwd 判断**
- 非完全访问档下，能发出去的文件只限 `readableRoots: [realpath(cwd)]`（`D/provider/outbound/policy.ts:20-30`、`:114-119`）。
- 领文件时要求记录的 cwd 等于项目当前 cwd（`D/bot/outbound-files.ts:69-72`）。
- 新 provider 层的权限规划也只有一个 `grant.root`（`D/provider/policy/enforcement.ts:110-113`、`:141-143`），还没接到 bot 路径上（读源码，bot/host/server 里没有 import）。

### A4. 有没有"每个 bot 一个家目录"

- 有 `bots/<appId>/`（`D/config/paths.ts:19-21`），放 daemon 自己的状态：`config.json`、`sessions.json`、`projects.json`、`processes.json`、`setup.json`、`topics/`（`:33-52`），`outbound-files/`（`:72-74`），`comment-instructions.md`（`:86-88`），`comments/comment-*`（`:92-94`）。
- 凭据在根目录：`secrets.enc`、`master.key`、`.keystore.salt`（`:95-97`）。根目录由 `VONVON_HOME`（必须是绝对路径）或 `~/.vonvon-bot` 决定（`D/config/data-root.ts:19-24`）。
- 这个目录今天不是任何群会话的 cwd，只有评论会话的 cwd 在它下面（`comments/comment-*`）。
- 定稿计划往 `bots/<appId>/` 里加 `SOUL.md`、`AGENTS.md`、`SMART.md`、`skills.json`、`mcp.json`、`memory/`、`groups/<chatId>/`（A1），由 vonvon 读出来再注入，不当 cwd。

---

## B. 两家 CLI 的加载行为

### B1. 从 cwd 自动加载什么，从附加目录加载什么

**Claude Code 2.1.296**（vonvon 的 SDK 用的就是这一版）

| 来源 | cwd 里 | `--add-dir`（SDK `additionalDirectories`）里 | 依据 |
|---|---|---|---|
| `CLAUDE.md` | 加载 | **默认不加载**；设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 才加载 | 跑过验证（r1、r2、r3b） |
| `.claude/rules/*.md` | 加载 | 同上，随 env 一起加载 | 跑过验证 |
| `AGENTS.md` | **只在同目录没有 `CLAUDE.md` 时**加载（内置插件 `cc-plugin-agents-md@builtin`，系统提示里标"project instructions, checked into the codebase"）；有 `CLAUDE.md` 时不读 | 不加载（#349 审查复测：add-dir 只放 AGENTS.md，没进请求） | 跑过验证（r1 有两份时没读；r7 只有 AGENTS.md 时读了） |
| `.claude/skills/` | 加载 | **加载** | 跑过验证（r2：`ws-claude-skill` 出现在 init 和请求里） |
| `.agents/skills/` | 不加载 | 不加载 | 跑过验证 |
| `.mcp.json` | 加载；`-p` 和 SDK 下不经批准就拉起，跑在沙箱外 | **不加载** | 跑过验证（r2 只有 `bot_mcpjson`）；不经批准是 #349 审查复测的：空 HOME，`-p --setting-sources user,project`，SDK 0.3.296 的 `bypassPermissions` 和 `default` 加一律拒绝的 `canUseTool`，三种都拉起，init 里 source 是 `project` |
| `.claude/settings.json` | 加载 | **不加载** | 跑过验证（r5/r6：工作区设置里的 `defaultMode: acceptEdits` 在 add-dir 时不生效） |
| 用户层 `~/.claude/CLAUDE.md`、`~/.claude/skills` | 加载 | — | 跑过验证 |

- `--setting-sources user`（只读用户层）时，cwd 的 `CLAUDE.md`、rules、`.claude/skills`、`.mcp.json` 都不加载，用户层的照样加载（跑过验证，r10）。SDK 注释"Must include 'project' to load CLAUDE.md files"（`sdk.d.ts:2262-2271`，来自文档）。e02 测过只给 `['user']` 也会读个人 CLAUDE.md（`docs/research/2026-10-14-v1-spikes/e02-claude-permissions-sessions.md:104`）。
- auto memory 的路径按 cwd 推：`init.memory_paths.auto = $HOME/.claude/projects/<cwd 转成的名字>/memory/`（跑过验证）。文档说同一 git 仓库共用一份（`persona-memory-skills.md:118-122`，来自文档）。
- **`--project-config-root <dir>`**（帮助里不列的隐藏参数；SDK 公开选项 `projectConfigRoot`，`sdk.d.ts:1537-1546`，SDK 会把它转成这个参数，读 `sdk.mjs`）：项目设置、`.mcp.json`、`.claude/skills` 改从这个目录读，**替换**而不是合并 cwd 的；`CLAUDE.md` 和 `.claude/rules` 仍从 cwd 读。
  - 跑过验证（r11）：cwd=ws、`--project-config-root bot`，得到 ws 的 CLAUDE.md 和 rules，加上 bot 的 skill 和 MCP，ws 的 skill 和 MCP 都没了。
  - r12 反过来：cwd=bot、配置根=ws，得到 bot 的 CLAUDE.md 和 rules，加上 ws 的 skill、MCP 和设置。
  - SDK 注释原意是"cwd 是某个受信任检出的 worktree，项目配置从原检出读"。
- 会话中途加目录：SDK 有控制请求 `register_repo_root`，"Add a directory as a working-directory root and optionally reload CLAUDE.md, skills, and plugins"，但目录必须是 cwd 或启动时 add-dir 的子目录（`sdk.d.ts:4930-4937`，来自文档）。

**Codex 0.163.0**

| 来源 | cwd 里 | `--add-dir` / `runtimeWorkspaceRoots` 的第二个根里 | 依据 |
|---|---|---|---|
| `$CODEX_HOME/AGENTS.md` | 总是加载，按会话关不掉 | — | 跑过验证；e05 四个版本同样结论（`e05:13`） |
| 项目 `AGENTS.md` | 默认加载；用户 `config.toml` 里把项目标 `untrusted` 时**不加载** | **不加载** | 跑过验证（c6、c10、c3、a1）；e05 实测第二个根的不加载（`e05:94`） |
| `.agents/skills/`、`.codex/skills/` | 加载（`untrusted` 时也加载） | **不加载** | 跑过验证（c10、c3、c9、a1） |
| `$CODEX_HOME/skills`、`~/.agents/skills` | 加载 | — | 跑过验证 |
| 项目 `.codex/config.toml`（含 `mcp_servers`、`model`、`developer_instructions`） | **只在用户 `config.toml` 里把这个目录标成 `trusted` 时**加载 | 第二个根标了 trusted 也**不加载** | 跑过验证（c8 加载；c6 默认不加载；c9 不加载） |

- 用命令行 `-c 'projects."<cwd>".trust_level="trusted"'` 不会让 `codex exec` 加载项目 `.codex/config.toml`，要写在用户 `config.toml` 里才行（跑过验证，c2、c7）。app-server 会话层传 `config.projects.<cwd>.trust_level` 时会不会加载：e05 读源码说 `trusted` 会加载 `.codex/` 的项目配置、hooks 和 exec policy，没实测（`e05:23`；`docs/v1-plan.md:646`）。两者不一致，未验证。
- app-server 实测（a1，跑过验证）：`thread/start` 用 cwd=bot、`runtimeWorkspaceRoots:[bot, ws]`。
  - 回显的根正确；`instructionSources` 只有 `$CODEX_HOME/AGENTS.md` 和 `bot/AGENTS.md`。
  - 发给模型的请求里只有 bot 的 skill，没有 ws 的 skill 和 AGENTS.md。
  - 但 `skills/list` 带 `cwds:[bot, ws]` 时会分别列出 ws 的 `.agents/skills`、`.codex/skills`。vonvon 能查到工作区有哪些 skill，再用 `skills/extraRoots/set` 加进来。没测 extraRoots 指向工作区 skill 目录这一步。
- `developerInstructions`（会话参数）盖过项目 `.codex/config.toml` 里的 `developer_instructions`（跑过验证：a1 里 bot 已 trusted，请求里只有会话参数的暗号）。
- resume 时新的 `developerInstructions` 不生效（e05，4 个版本，`e05:10`）。

### B2. 不写进工作区就能注入人设、skill、MCP 的办法

**Claude**
- 人设：`--append-system-prompt`（SDK `systemPrompt.append`）、`--system-prompt`（整个替换）、`--append-system-prompt-file`。跑过验证：r8 里暗号进了请求。
  - 注意 **system prompt 快照**：SDK 0.3.296 默认 `snapshot` 打开，会话第一次请求时把渲染好的 system prompt（含 append）记进会话记录，之后 resume 都照记录发，"a different `append` ... passed on a later launch of the same session is ignored until compaction or a new session"；对没开这项的账号无效（`sdk.d.ts:2378-2405`；CLI 2.1.301 帮助 `--system-prompt-snapshot`；来自文档，没实测）。和 Codex resume 不认新 `developerInstructions` 是同一类问题。
- skill：`--plugin-dir <dir>`（SDK `plugins:[{type:'local',path}]`；`skipMcpDiscovery` 时转成 `--plugin-dir-no-mcp`，读 `sdk.mjs`）。插件里的 skill 带命名空间，比如 `vonvonbot:plug-skill`（跑过验证，r8）。`--add-dir` 目录里的 `.claude/skills` 也会加载（跑过验证）。SDK `skills: string[]` 是上下文过滤，不是沙箱（`sdk.d.ts:2272-2294`）。
- MCP：`--mcp-config <json|file>`（SDK `mcpServers`），加 `--strict-mcp-config`（SDK `strictMcpConfig`）只用这些，项目 `.mcp.json` 和用户 MCP 都不加载（跑过验证，r9：只剩 `inject_mcp`）。
- 设置：`--settings <file|json>`（SDK `settings`），能放 `claudeMdExcludes`（e02 实测，`e02:16`、`:99-105`）、`autoMemoryEnabled`、`autoMemoryDirectory`（`sdk.d.ts:9225-9235`，来自文档）、`disableAllHooks`（vonvon 辅助查询已用，`D/agent/claude-agent/backend.ts:108`）。
- 指令文件：`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` + `--add-dir <bot 家>`，bot 家的 `CLAUDE.md` 原生加载（跑过验证，方向和 r3b 相反：r3b 里 add-dir 的是 ws；机制相同）。
- 项目配置换位置：`--project-config-root`（见 B1）。
- `--bare`：跳过 hooks、插件同步、auto memory、CLAUDE.md 自动发现，只认显式给的 `--system-prompt`、`--add-dir`、`--mcp-config`、`--settings`、`--plugin-dir`。但认证只认 `ANTHROPIC_API_KEY` 或 `apiKeyHelper`，不读 OAuth 和钥匙串（CLI 2.1.301 帮助，来自文档），用订阅登录的主人用不了。
- `CLAUDE_CONFIG_DIR`：换了要重新登录（product.md 3.6 不用）。

**Codex**
- 人设：`thread/start.developerInstructions`（今天在用）；`baseInstructions` 替换内置基础指令（comma 在用，见 C3；对 Codex 的效果是按协议推断，未验证）。
- skill：`skills/extraRoots/set`（进程级，e05 实测可用，`e05:9`）、会话 `config.skills.config` 逐个禁、`skills.bundled.enabled:false`（e05）。
- MCP：会话 `config.mcp_servers`，用户的写 `enabled:false`（e05，`e05:7`）。
- 额外根：`runtimeWorkspaceRoots`（实验字段，e05 实测；第二个根的 AGENTS.md、skill、项目配置都不加载，见 B1）。
- 项目信任：会话 `config.projects.<cwd>.trust_level`，可以不往用户 `config.toml` 写信任记录（e05，`e05:23`）。
- `-p/--profile`：把 `$CODEX_HOME/<name>.config.toml` 叠在用户配置上（`codex exec --help`，来自文档），文件仍要放进用户的 `CODEX_HOME`。
- `--ignore-user-config`：不读 `$CODEX_HOME/config.toml`，认证仍用 `CODEX_HOME`（`codex exec --help`，来自文档；app-server 有没有对应开关，未验证）。
- `CODEX_HOME`：换了要重新登录、旧线程续不上（`docs/product.md:334`）。

---

## C. comma 怎么做

完整笔记（带全部 `path:line`）在同目录的 [comma-home.md](comma-home.md)。路径相对 `/home/operator/vonvon/references/comma`（commit ba4f55d）。AGPL，只看思路。以下都是读源码，另标的除外。

### C1. agent 的家和用户项目分开，而且 agent 的"家"不在设备磁盘上
- agent 自己的东西在服务器上：每个 Agent 一份虚拟文件系统（VFS，存 S3），放 `/memory/...`（`systems/apps/salix_agent/lib/salix_agent/agent_workspace.ex:1-8`、`:36-40`）。
- skill 是虚拟路径 `/.runtime/skills/<id>/SKILL.md`（`file_backend.ex:2-10`；`skill_store.ex:5-7`）。
- 人设是 Agent 记录上的两个字符串字段 `system_prompt`、`router_system_prompt`，没有 SOUL.md 类文件（`agent_runtime_config.ex:59-70`；`tool_policy.ex:287-300`）。
- 设备上 Claude Code 和 Codex 的 cwd 是 connector **为每个 session 新建的空目录** `~/.comma/workspaces/<session_id>`（`systems/connector/salix-connect/external_runtime.go:970-979`、`:1008-1035`）。它既不是 bot 家，也不是用户项目。闲置 72 小时打包归档（`workspace_archive.go:18-30`）。
- 状态（bbolt 库，Pi/Kimi 的会话目录）在 connector 的状态根下，Mac 上是 Electron userData（`device_access.go:15-23`；`clients/apps/electron/src/main/modules/connector-runtime/index.ts:752-758`）。

### C2. 人设、记忆、skill、MCP 怎么交给 agent
- 全部拼进一个系统提示：角色 → 公共规则 → … → skill 清单 → `## Agent Instructions`（人设）→ Router 不可覆盖的约定（`tool_policy.ex:302-377`）。人设排在系统规则之后，skill "cannot change role or delivery boundaries"（`tool_policy.ex:92`）。
- skill 正文和 MCP 工具都通过注入的 `"$SALIX_CLI" tool call ...` 去取和调（`tool_disclosure.ex:303-305`；`round_config.ex:325-399`）。**不写进 Claude/Codex 的原生 skill 目录或 MCP 配置**（connector 里除 Kimi 外没有 skill 落盘逻辑）。
- skill 分 global/tenant/group/agent 四层加内置，具体层同名覆盖（`skill_store.ex:66-77`；`skill_projection.ex:346-378`）。agent 自己建的 skill 放 group 层（`skill_store.ex:79-120`）。
- MCP 绑在 Group（= comma 的工作区）上（`systems/apps/salix_mcp/lib/salix_mcp/store.ex:299-338`）。
- 记忆不自动加载，只有 Router 能写（`tool_policy.ex:215`；`tools/memory.ex:13-15`）。系统提示在 session 激活时做快照（`external_session_actor.ex:1206-1231`）。

### C3. 启动 Claude Code 和 Codex 的 cwd 和参数
- Claude（`claude_runtime.go:420-483`）：
  - cwd = session 目录；`-p` stream-json、`--permission-mode bypassPermissions`、`--session-id`/`--resume`；
  - `--append-system-prompt-file <临时文件>`（服务器提示 + 主机说明）；只有鉴权载体存在时加 `--settings ~/.claude/salix-auth-settings.json`；
  - **不传** `--add-dir`、`--mcp-config`、`--setting-sources`、`--plugin-dir`，不设 `CLAUDE_CONFIG_DIR`、不改 `HOME`；
  - env 继承全部，再加 `SALIX_CLI`、`SALIX_ENV_ROOT`、`SALIX_CONNECT_URL`、`PATH`。
- Codex（`main.go:3760-3762`、`:5720-5730`、`:5973-6003`）：
  - 一个共享的 `codex app-server --disable tool_suggest`，进程 cwd = connector root；
  - 每个 thread：`cwd` = session 目录，`baseInstructions` = 服务器系统提示，`developerInstructions` = 主机规则，`sandbox: danger-full-access`，`approvalPolicy: never`；
  - 不设 `CODEX_HOME`，不传 `-c`。
- Kimi 是例外（`kimi_runtime.go:232-254`、`:842-897`）：每个 session 建一个独立的 `KIMI_CODE_HOME`，把用户的 `config.toml`、`credentials`、`skills`、`plugins` **符号链接**进去，已存在就跳过；`AGENTS.md` 每次重新生成 = 用户全局 `AGENTS.md` + 系统提示。这是 comma 里唯一"给 agent 造一个继承用户全局配置的独立 home"的做法。

### C4. 能不能碰别的工作区
- 能，而且不设限：cwd 是空 session 目录，项目靠 agent 自己用绝对路径找。主机说明写"When work needs an existing local project, inspect SALIX_ENV_ROOT first. Before modifying project files, use or create a task-specific worktree in the current session workspace"（`main.go:6632-6639`）。Mac 上 `SALIX_ENV_ROOT` = 用户 home（`clients/apps/electron/src/main/index.ts:1617-1618`）。
- Claude 用 bypass，Codex 用 full access；connector "does not impose a filesystem jail"（`systems/connector/README.md:649-653`，来自文档）。
- 别的机器走 `env.exec`（带 `device_id`、`working_dir`）。
- **没有** `--add-dir`、writable roots 或"一个 session 挂多个工作区"的机制。

### C5. 工作区级的 skill/MCP/CLAUDE.md/AGENTS.md
- comma 不做任何处理：不继承、不合并、不覆盖，也不往用户项目里写文件。
- 用户级 `~/.claude`、`~/.codex` 原样继承。项目级配置因为 cwd 是空目录，启动时大概不加载（未验证，依赖 CLI 行为）。按本文 B1 的实测，它在项目 worktree 子目录里干活时，Claude 不会因此加载那里的 `.claude/skills` 和 `.mcp.json`。
- 唯一的冲突处理是鉴权：托管凭证遇到工作区或用户目录里已有的鉴权设置就拒绝启动，不覆盖（`claude_runtime.go:584-636`）。

### C6. 多个 agent 共用一个工作区
- 一个 Group = 一个 Router + N 个 Worker（`tool_policy.ex:108`）。group 层 skill、MCP 绑定、插件共享；每个 Agent 各有人设字段、VFS（记忆）和 agent 层 skill。
- 同一设备上所有 Worker 共用 `SALIX_ENV_ROOT`、`~/.comma/workspaces/` 根和用户 CLI 配置，只靠每 session 一个子目录隔开（`main.go:6636-6637`）。

---

## D. 待定问题和矛盾

1. **owner 的想法和定稿相反。** 定稿是"主工作区 = 会话 cwd"，定义文件在 `bots/<appId>/` 由 vonvon 注入（`docs/product.md:33`、`:104`、`:337-341`）。新想法是"cwd = bot 家，工作区作为附加目录"。改了就是改承诺和交付表，要按 v1-plan 4.2 走 owner 决定。M7、M8 都没开工（A1），现在改不用回收代码。
2. **"继承工作区的 skill 和 MCP"在 cwd = bot 家时，两家都不会自动做全**（B1，跑过验证）：
   - Claude：`--add-dir` 工作区的 `.claude/skills` 会加载；`CLAUDE.md` 要另设 env；`.mcp.json`、`settings.json` 不加载。`--project-config-root` 能整份换成工作区的项目配置，但会丢掉 bot 家自己的 `.claude/skills` 和 `.mcp.json`，而且是帮助里不列的参数。
   - Codex：第二个根的 AGENTS.md、skill、`.codex/config.toml` 一概不加载。要继承只能由 vonvon 自己读出来（`skills/list cwds:[ws]` 能列，跑过验证），再用 `skills/extraRoots/set`、`mcp_servers` 传进去。
3. **反过来，cwd = 工作区时，工作区的东西两家都原生加载**：Claude 的 CLAUDE.md、rules、skill、`.mcp.json`（非交互下不用批准）、设置；Codex 的 AGENTS.md、skill，trusted 时还有 `.codex/config.toml` 的 MCP。也就是说定稿方案下"继承"是默认行为，新方案下要 vonvon 自己补。
4. **Codex 的信任设置两份资料说法不一。** e05 读源码说会话层 `projects.<cwd>.trust_level: trusted` 会加载 `.codex/` 项目配置（没实测）；本次 `codex exec -c` 同样的覆盖不加载，只有写在用户 `config.toml` 里才加载（跑过验证）。app-server 会话层到底如何，没测。
5. **终端里接着用 bot 的会话（D6，`docs/product.md:168`）和 cwd 绑定。** Claude 会话按 cwd 存在 `~/.claude/projects/<cwd 名>/`，vonvon 读历史也按 `dir: cwd`（`D/agent/claude-agent/backend.ts:374-412`）；e14 是"在 bot 的工作目录里" `claude --resume`（`docs/research/2026-10-15-v1-spikes/e14-resume-same-session.md:20`）。cwd 换成 bot 家，主人要到 bot 家目录里 resume；Codex 应用按 cwd 分组显示（未验证）。
6. **发文件和领文件按 cwd 判断。** 非完全访问档只放行 cwd 下的文件（`D/provider/outbound/policy.ts:20-30`）；图片约定是"相对当前工作目录"（`D/agent/bridge-instructions.ts:22-25`）。cwd = bot 家时，工作区里的产出发不出去，除非放行范围扩到所有根。新 provider 层也只有一个 `grant.root`（`D/provider/policy/enforcement.ts:110-113`）。
7. **权限档和记忆写入。** Claude 只读档是 `denyWrite: [cwd]`（`D/agent/claude-agent/permission.ts:64`）。cwd = bot 家时，只读档下 bot 写不了自己家里的记忆文件；s40 要求"只读档下能写记忆文件、写不到别处"（`docs/v1-plan.md:637`）。两种方案都得给记忆文件单独开一个可写根，只是位置不同。
8. **bot 家放在哪个目录。** 如果直接用 `bots/<appId>/` 当 cwd，里面有 daemon 的 `config.json`、`sessions.json`、`processes.json`、`topics/`（`D/config/paths.ts:33-52`），读写档下 agent 能改。凭据在上一层（`:95-97`），完全访问档本来就能读到（推断）。
9. **人设改了以后老会话用不上，两家都这样。** Codex resume 不认新 `developerInstructions`（e05）；Claude SDK 默认 system prompt 快照，resume 时新的 append 被忽略，直到压缩或新会话（`sdk.d.ts:2378-2405`，来自文档，没实测；只对开了这项的账号生效）。product.md 3.6"记忆在会话开始或恢复时放进去"的 Claude 一半，v1-plan s37 只为 Codex 改过（`docs/v1-plan.md:645`），Claude 一半还没对上。如果人设和记忆做成 bot 家里的原生文件（CLAUDE.md/AGENTS.md），会不会也只在会话开始时读一次：Claude 的 CLAUDE.md 在会话中途改了会不会重读，没测；`register_repo_root` 能 reload CLAUDE.md，只限子目录（`sdk.d.ts:4930-4937`）。
10. **Claude 也读 AGENTS.md，但有条件**（跑过验证，r7）：同目录没有 `CLAUDE.md` 时才读。bot 家里只放 `AGENTS.md` 时，Claude 和 Codex 都会原生加载。用户仓库同时有两份时，Claude 只读 `CLAUDE.md`。product.md 写的"仓库里的 `AGENTS.md`、`CLAUDE.md` 照旧由 agent 自己读"在 Claude 一侧要加这个条件。
11. **评论目录是现成先例，但做法正是定稿想避免的。** 每次运行无条件覆盖 `AGENTS.md`、`CLAUDE.md`（`D/bot/comments.ts:317-324`），所以那个目录只能是 vonvon 独占的；用户手改会被冲掉。
12. **Codex 的读写档在 Linux 上起不来**（`D/agent/codex-appserver/backend.ts:59-63`），和 cwd 放在哪无关，但多根方案的 Mac 检查（s39）照旧只能在 Mac 上做（`docs/v1-plan.md:647`）。
13. **comma 的做法和 owner 的想法不一样。** comma 的 cwd 是每 session 一个空目录，不是 bot 家；bot 的"家"在服务器；项目靠环境变量和提示词指过去；工作区级配置一概不管。只有 Kimi 运行时用了"每 session 一个独立 home，符号链接用户配置，拼一份 AGENTS.md"。
14. 小的引用漂移：product.md 3.3 引的 `D/config/paths.ts:115` 现在是 `:108`（`projectsRootDir`）。
