# 每个（bot，群）会话怎么拿到人设、目录、技能、记忆和隔离：Codex 与 Claude Code 的具体机制

调研日期 2026-10-14。只读，没有运行任何构建或测试。

**依据的版本**
- vonvon-bot：main `be17859`。
- Codex 源码：`/home/operator/vonvon/references/openai-codex`，`git log -1` = `97771b1d78cf6366bc3946fe9e4bbca4ebee31d1`（2026-10-14，shallow clone，只有 `rust-v0.162.1` 一个 tag）。
  - 关键字段又对照了 Mac 上跑的 0.162.1（scratchpad `codex-src-0162`，`Cargo.toml:163` 写的是 0.162.1）。
  - 也对照了 vonvon 锁定的 0.156.1（从 GitHub raw 拉了 `rust-v0.156.1` 的 `thread.rs`、`host_roots.rs`、`common.rs`）。
- Claude Agent SDK：仓库里装的是 0.3.296（`packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）。`package.json:48` 写的是 `^0.3.178`，`docs/providers.md:483` 计划锁到 0.3.246（Paseo 自带的就是 0.3.246）。
- 本机 Claude Code CLI 是 2.1.299。
- 文档取自 code.claude.com，取于 2026-10-14。

下文引用的 Codex 路径都相对 `codex-rs/`。SDK 指上面那份 0.3.296 的 `sdk.d.ts`。

---

## 结论

1. **人设：两边都有原生的追加指令字段，按会话传，不碰用户全局配置。**
   - Codex 用 `thread/start` 的 `developerInstructions`，以 developer 角色注入。
   - Claude 用 `systemPrompt: {type:'preset', preset:'claude_code', append}`。
   - v2 今天这两个字段里只放了一段写死的飞书输出约定。把"约定 + bot 人设 + 群覆盖"拼进去就行。
   - 坑在新的 provider 合同：`OpenSpec` 只有 `{cwd, resume, model, effort}`（`provider/engines/engine.ts:52`），没有放指令的字段。
2. **目录：两边都支持"1 个 cwd + n 个额外根目录"，读写由沙箱管。**
   - Codex 用实验字段 `runtimeWorkspaceRoots`，0.156.1 已经有。它会把权限配置里的 `:workspace_roots` 展开成这一组目录。
   - Codex 权限配置也接受绝对路径，所以可以逐个目录给 read 或 write。
   - Claude 用 `additionalDirectories`，SDK 会转成 `--add-dir`。Bash 沙箱默认允许写这些目录。
   - v2 的 `Grant` 只有一个 `root`，要改成数组。
3. **技能：两边都能给每个会话单独挂一组技能，但默认都会把用户自己的全局技能一起带进来。**
   - Claude 最干净。可以由 vonvon 为每个 bot 生成一个本地 plugin 目录，经 `plugins` 选项加载；再用 `skills: [...]` 白名单把用户的个人技能挡在模型视野外。
   - Codex 没有"只用这些技能根"的开关。能做的是：
     - 用 `skills/extraRoots/set` 加 bot 技能目录。它对整个进程生效，vonvon 本来就是一个会话一个进程。
     - 用每个 thread 的 `config.skills.config` 规则逐个禁用用户的技能。
4. **记忆：Claude 有原生的、可以指定目录的 auto memory；Codex 没有按会话的记忆，要 vonvon 自己管文件。**
   - Claude 用 `settings.autoMemoryDirectory` 给每个（bot，群）指定一个目录。
   - Codex 自带的 memories 功能是整个 `$CODEX_HOME` 共用一份，默认关闭，不适合 bot。
5. **隔离：不建议在 v1 用"每个 bot 换一个 CODEX_HOME 或 CLAUDE_CONFIG_DIR"。**
   - 两边的登录凭据都跟着这个目录走，换了目录就要重新登录。
   - 会话历史、模型路由配置也会一起分家。
   - 推荐做法：共用用户的登录，用会话级参数把技能、记忆、指令、目录切开。剩下几处已知泄漏写在第 5 节。

---

## 0. 现状：v2 今天怎么启动这两个代理

**Codex**（`packages/daemon/src/agent/codex-appserver/backend.ts`）
- `thread/start` 和 `thread/resume` 只传这几个参数（`:665-692`）：
  - `cwd`；
  - `approvalPolicy:'never'`；
  - 沙箱参数；
  - `developerInstructions: BRIDGE_DEVELOPER_INSTRUCTIONS`；
  - 可选的 `model`。
- 沙箱分三档（`:73-100`）：
  - `full` 用 `danger-full-access`。
  - `qa` 和 `write` 用自定义权限配置 `feishu`，内容是 `':minimal':'read'` 加 `':workspace_roots': {'.': read|write}`。
  - 不是 macOS 或 Windows 时直接拒绝。
- 每个会话独占一个 `codex app-server` 进程（`:695-708`）。
  - 预热池里的进程用中性目录 `tmpdir()` 启动，并先开一个 ephemeral thread（`client-pool.ts:211-243`）。
  - 子进程环境是 daemon 的环境加上 `FEISHU_CODEX_BRIDGE=1`（`provider/transport/jsonrpc.ts:256-258`）。
  - initialize 时打开了 `experimentalApi: true`（`jsonrpc.ts:316-320`），所以能用实验字段。
- 历史里以 `# AGENTS.md instructions` 开头的 user 消息会被当作样板过滤掉（`backend.ts:711-713`）。这说明 AGENTS.md 是以 user 消息注入的。

**Claude**（`packages/daemon/src/agent/claude-agent/backend.ts`）
- 启动参数（`:353-383`）：
  - `cwd`；
  - `systemPromptAppend: BRIDGE_DEVELOPER_INSTRUCTIONS`；
  - `settingSources: ['user','project']`（`:48`）；
  - 环境是 `process.env` 加两个标记（`:68-74`）。
- `thread.ts:261-271` 把它们转成 `systemPrompt:{type:'preset',preset:'claude_code',append}`。
- 权限分档（`permission.ts:55-75`）：
  - `full` 用 bypass。
  - `qa` 用沙箱加 `denyWrite:[cwd]`，并去掉写入工具。
  - 两档都只认一个 cwd。

**新 provider 层（V6/V7 设计，还没实现）**
- `provider/engines/` 下只有 `engine.ts`。
- `Grant` 只有一个 `root`（`docs/providers.md:56-59`）。但 `EnforcementPlan` 的 `readableRoots` 和 `writableRoots` 已经是数组（`providers.md:212-216`）。
- Claude engine 的设计把 `settingSources` 定为 `['user']`（`providers.md:483`、`:696`），理由是让 `~/.claude/settings.json` 里的 DeepSeek、Kimi 等模型路由生效。这一点会影响第 3、4 节。
- 设计里"developer instructions"只用来装飞书格式约定（`providers.md:622`）。

---

## 1. 人设和额外系统指令

### Codex

- **机制：`thread/start`、`thread/resume`、`thread/fork` 的 `developerInstructions`。**
  - 定义在 `app-server-protocol/src/protocol/v2/thread.rs:106`、`:414`、`:617`。
  - 注入时角色是 `developer`（`core/src/context/developer_instructions.rs:27-29`）。
  - 每个 thread 一份，所以每个（bot，群）可以不同。
- **不要用 `baseInstructions`**（`thread.rs:104`）。它替换的是 Codex 的基础提示，会丢掉工具用法等默认内容。
- **`personality` 已废弃**（`thread.rs:107-109`："`friendly` and `pragmatic` no longer select a style"）。
- **AGENTS.md 会和人设同时出现：**
  - 项目级：从项目根（默认标记是 `.git`）到 cwd，每一层的 `AGENTS.override.md` 或 `AGENTS.md` 都会拼进来（`core/src/agents_md.rs:7-18`、`:272-280`）。
  - 全局：`$CODEX_HOME/AGENTS.override.md` 或 `AGENTS.md`（`codex-home/src/instructions/mod.rs:40-79`）。
  - 两者都以 user 角色注入（`core/src/context/user_instructions.rs:20-21`）。
  - 推断：developer 角色比 user 角色优先，所以人设应该压得住 AGENTS.md。这一点没有实测。
  - 稳妥做法：人设里写明"冲突时以本人设为准"。
- **恢复会话时的坑：**
  - 对一个已经加载、正在运行的 thread 再调 `thread/resume`，新的 `developerInstructions` 和 `config` 会被忽略，只返回一条 mismatch 说明（`app-server/src/request_processors/thread_processor.rs:219-231`）。
  - vonvon 每次 resume 都新起进程，所以新值会进入会话配置（`core/src/session/mod.rs:927`）。
  - 未验证：旧的那条 developer 消息还留在历史里时，模型怎么取舍。

### Claude

- **机制：`systemPrompt: {type:'preset', preset:'claude_code', append}`**（SDK `:2422-2431`）。等价于 CLI 的 `--append-system-prompt(-file)`（[cli-reference](https://code.claude.com/docs/en/cli-reference)）。
  - 文档建议：仍然是编码助手时用 append；用 `--system-prompt` 整个替换会丢掉工具和安全指引（同页 "System prompt flags"）。
- **恢复会话时的坑：**
  - 系统提示在会话第一次请求时渲染并记录。之后同一会话再传不同的 `append`，要到压缩或新会话才生效（SDK `:2382-2405`；cli-reference "System prompt flags in resumed conversations"）。
  - 结果是：群里改了人设，已有话题不会马上变。
  - 0.3.296 有 `snapshot:false` 可以每次重新渲染（SDK `:2422-2431`）。0.3.246 没有这个字段（Paseo 版 `sdk.d.ts:2145-2150`）。
  - 文档还说记录功能"is rolling out"，所以行为可能因账户而异。
- **CLAUDE.md 和人设同时出现：**
  - 用户级 `~/.claude/CLAUDE.md` 和项目级 CLAUDE.md 都是叠加关系，"There is no hard precedence rule between levels"（[agent-sdk/claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)）。
  - 只有 cwd 及其上级目录都没有 CLAUDE.md 时，Claude 才读 AGENTS.md（[memory](https://code.claude.com/docs/en/memory) "When Claude Code reads AGENTS.md"，需要 v2.1.277+）。
- **新合同的缺口：** `OpenSpec` 没有指令字段（`engine.ts:52`）。V6b 删掉旧 `agent/` 目录时，人设没有地方放（之前 fit 报告也指出过）。

---

## 2. 主工作区当 cwd，加 n 个工作区和 0..n 个代码仓库，都能在沙箱里读写

### Codex

**怎么传**
- **主工作区**：`cwd`（`thread.rs:81`）。
- **其余目录**：实验字段 `runtimeWorkspaceRoots: AbsolutePathBuf[]`。
  - thread 级在 `thread.rs:83-85`，turn 级在 `turn.rs:226-229`。
  - 0.156.1 和 0.162.1 都有。
  - 它的作用是**替换**整组工作区根，用来展开权限配置里的 `:workspace_roots`（`core/src/config/mod.rs:334-336`）。
  - 不传时，默认值是 `[cwd] + additional_writable_roots + 旧版 writable_roots`（`mod.rs:3669-3681`）。传了就整组替换，所以必须把 cwd 也写进去。
- **对 `feishu` 配置的意义**：现在的 `':workspace_roots': {'.': 'write'}` 不用改，传了这组根之后，每个根都可读写。

**逐个目录给不同权限**
- 文件系统条目可以是特殊路径（`:minimal`、`:workspace_roots`、`:tmpdir` 等，`core/src/config/permissions.rs:833-846`），也可以是绝对路径（`:646-657`）。
- 取值有 `read`、`write`、`deny`（`protocol/src/permissions.rs:120-126`）。
- 例子：参考仓库给 `read`，记忆目录给 `write`，其余工作区给 `write`。

**旧版沙箱写法**
- `sandbox:'workspace-write'` 加 turn 级 `sandboxPolicy.writableRoots`，同样会把这些目录并入工作区根（`mod.rs:514-527`）。
- 这是 providers.md 里"write + 不限读"那一格用的写法（`providers.md:682`）。

**坑**
- **元数据目录默认只读。**
  - 在 workspace-write 下，每个可写根里的 `.git`、`.agents`、`.codex`、`.aws` 默认只读（`protocol/src/permissions.rs:40-48`、`:860-863`、`:2360-2385`）。
  - 所以在代码仓库里 `git commit` 可能失败。providers.md:684 已经把 `git commit` 列为探针。
  - 用 `feishu` 权限配置时是否同样保护，未验证。
- **额外根不会带入它自己的 AGENTS.md、`.agents/skills` 和 `.codex/`。**
  - AGENTS.md 只看 cwd 一条祖先链（`agents_md.rs:189-260`）。
  - 技能只扫项目根到 cwd（`ext/skills/src/host_roots.rs:137-185`）。
  - 结果是代码仓库自己的约定不会自动加载。
  - 推断的补法：vonvon 把仓库路径和"先读该仓库的 AGENTS.md"写进 developerInstructions。
- **会悄悄改用户全局配置。**
  - 只要 cwd 可写、项目还没有信任设置，`thread/start` 就会把这个项目设为 trusted，并写进 `$CODEX_HOME/config.toml`（`thread_processor.rs:1364-1427`；`core/src/config/mod.rs:2464-2472`）。
  - 每个新 bot 工作区都会在用户的 `~/.codex/config.toml` 里留一条记录。
- **Linux 上不能把读取限制在项目内**，providers.md 设计为拒绝（`providers.md:679`、`:681`）。v1 只做桌面端时，主要影响 Linux 桌面用户。

### Claude

**怎么传**
- **主工作区**：`cwd`。
- **其余目录**：`additionalDirectories: string[]`（SDK `:1533-1536`）。SDK 把每一项作为 `--add-dir` 传给 CLI（[permissions](https://code.claude.com/docs/en/permissions) "Additional directories grant file access, not configuration"）。
- **Bash 沙箱**：默认可写 cwd、每用户的临时目录和所有 add-dir 目录（[sandboxing](https://code.claude.com/docs/en/sandboxing) "What the sandbox restricts"）。
  - 所以 `qa` 档现在的 `denyWrite:[cwd]`（`permission.ts:64`）在有额外目录时不够，要列出全部根。
  - 文件工具（Read、Edit、Write）不受沙箱约束，归权限规则管（同页 "What runs outside the sandbox"）。
  - v2 设计用 PreToolUse 闸门 `judgePath` 对照 `readableRoots`、`writableRoots` 判断（`providers.md:560`、`:693`），本身已经支持多根。

**add-dir 目录会加载哪些配置**（permissions 文档表格）
- 会加载 `.claude/skills`、`.claude/commands`、`.claude/agents`。这三类要走 `project` 设置源。
- 它的 settings 只读 `enabledPlugins` 和 `extraKnownMarketplaces` 两个键。
- CLAUDE.md 只有在设置了 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 时才加载。
- AGENTS.md 即使设了这个变量也不加载（memory 文档 "Where AGENTS.md differs"）。

**hooks**
- 只从 cwd 的 `.claude/` 加载，不往上级找（permissions 文档同节）。
- 把 cwd 定为 vonvon 自己管理的主工作区、代码仓库只当 add-dir，用户 clone 下来的仓库里的 hooks 就不会在 bot 会话里执行。

---

## 3. bot 专属技能：增删都不碰用户的 `~/.codex` 或 `~/.claude`

### Codex：技能从哪里发现

`resolve_skill_roots`（`ext/skills/src/host_roots.rs:28-71`）按这些来源拼技能根：

| 来源 | 位置 | scope | 依据 |
|---|---|---|---|
| 仓库 | 项目根到 cwd 之间每一层的 `.agents/skills` | Repo | `:137-185` |
| 项目配置层 | 每个 `.codex/` 下的 `skills` | Repo | `:86-94` |
| 用户（已弃用位置） | `$CODEX_HOME/skills` | User | `:95-101` |
| 用户 | `~/.agents/skills`，用的是真实 home（`dirs::home_dir()`），**不是 CODEX_HOME** | User | `:35-36`、`:103-108` |
| 内置 | `$CODEX_HOME` 下的系统技能缓存 | System | `:110-113` |
| 系统配置层 | 该层目录下的 `skills` | Admin | `:115-119` |
| 插件 | 插件带的技能根 | — | `:58-62` |
| 额外根 | 见下文 `skills/extraRoots/set` | User | `:63-67` |

### Codex：怎么给 bot 挂自己的技能

**做法 A：`skills/extraRoots/set {extraRoots}`**
- 定义在 `app-server-protocol/src/protocol/common.rs:899-903` 和 `v2/plugin.rs:41-43`。
- 它写进进程级的 `HostSkillsService.extra_roots`（`ext/skills/src/host_service.rs:86`、`:154-163`），并发出 `skills/changed`（`catalog_processor.rs:595-611`）。
- 影响整个 app-server 进程。vonvon 一个会话一个进程，所以实际等于按会话设置。
- 预热池里的进程是通用的，要在取出之后、`thread/start` 之前调用。

**做法 B：把技能放进主工作区的 `.agents/skills`**
- 这样是 Repo scope，排序最前（`ext/skills/src/loader/host_merge.rs:241-266`）。
- 坑 1：如果工作区在某个 git 仓库里面，会一路往上扫到仓库根。
  - 用 thread 级 `config: {project_root_markers: []}` 可以把项目根固定为 cwd（`host_roots.rs:187-213`、`:211-213`；AGENTS.md 一侧见 `agents_md.rs:11-14`）。
  - 这里的标记读取会跳过项目层，但包括会话层。
- 坑 2：`.agents` 在可写根下默认只读（见第 2 节）。
  - 好处是代理不能偷偷改自己的技能。
  - 但"聊天里新建一个 skill"必须由 vonvon 写盘，不能让代理直接写。

**做法 C（未验证）：实验字段 `selectedCapabilityRoots`**
- thread 级（`thread.rs:153-155`；`protocol/src/capabilities.rs:9-74`），由技能扩展的 executor 路径消费（`ext/skills/src/extension.rs:289-321`）。
- 它面向"执行环境"（要 `environmentId`），模型通过 `skills.read` 工具读取。
- 本地桌面场景能不能用、`environmentId` 该填什么，都没核实。

### Codex：怎么把用户自己的技能挡掉

- **按 thread 写禁用规则。**
  - 在 thread/start 的 `config` 里传 `skills.config: [{path 或 name, enabled:false}]`。
  - `config` 会并入 CLI 覆盖，成为会话层配置（`app-server/src/config_manager.rs:451-487`；`config/src/loader/mod.rs:423-429`）。
  - 技能启用规则正好只读用户层和会话层（`config/src/skills_config.rs:159-195`）。
  - 所以按 thread 禁用是可行的。推断：写法和 vonvon 现在传 `permissions` 的嵌套对象一样。
- **关内置技能**：`skills.bundled.enabled=false`（`skills_config.rs:42-44`、`:132-151`）。
- **先列出再禁用**：要先用 `skills/list {cwds}`（`v2/plugin.rs:18-29`）列出这台机器上的全部技能，再把不属于 bot 的逐个禁用。
- **没有"只用这些根"的开关。**
  - `skip_host_skill_discovery` 还在开发中，默认关闭（`features/src/lib.rs:1639-1644`）。
- **不要用 `skills/config/write`。** 它会写进 `$CODEX_HOME` 的配置，变成全局设置（`catalog_processor.rs:681-707`）。

### Codex：沙箱和软链接

- 发现技能时用的是不受限的文件系统，源码里有 TODO 说以后要绑定权限（`ext/skills/src/loader/host.rs:155-157`）。
- 但模型使用文件型技能时，是自己去打开 `SKILL.md` 路径（`ext/skills/src/catalog_prompt.rs:24-30`），要经过沙箱。
- 推断：在"只读项目内"档，技能目录必须在可读范围内。办法是在 `feishu` 配置里给技能目录加一条绝对路径 `read`。
- 软链接：User、Repo、Admin 三类 scope 跟随目录软链接，System 不跟随（`loader/host.rs:164-167`）。
- 推断：软链接指向的真实位置也要在可读范围内。

### Claude：技能从哪里发现

- 个人 `~/.claude/skills`。
- 项目 `.claude/skills`，从 cwd 一路往上到仓库根。
- 下级目录里的嵌套技能，按需加载。
- 插件 `<plugin>/skills`。
- 企业托管目录。
- add-dir 目录的 `.claude/skills`。
- 依据：[skills](https://code.claude.com/docs/en/skills) "Choose where skills load" 和 "Load skills in monorepos"。
- 同名时的优先级："Enterprise over personal, and personal over project"。插件技能带命名空间 `plugin-name:skill-name`，和别的不冲突（同页）。
- 加载方式：项目技能和 add-dir 技能走 `project` 设置源，个人技能走 `user` 设置源（claude-code-features 表格）。

### Claude：怎么给 bot 挂自己的技能

**推荐：每个 bot 一个本地 plugin 目录**
- 由 vonvon 生成，例如 `<botHome>/plugin/skills/<name>/SKILL.md`。
- 用 `plugins: [{type:'local', path}]` 加载（SDK `:2030-2040`、`:5650-5664`）。
- manifest 可选。技能名是 `<plugin>:<skill>`。
- 加载结果看 init 消息里的 `plugins` 和 `skills` 字段。路径不存在时会**静默跳过**（[agent-sdk/plugins](https://code.claude.com/docs/en/agent-sdk/plugins)），所以要检查 init 消息。
- 未验证：`settingSources` 为 `['user']` 或 `[]` 时，plugins 选项还加不加载。文档没写，要探针确认。

**白名单**
- `skills: string[]` 只启用列出的技能（SDK `:2272-2294`）。
- 文档原话："This is a context filter, not a sandbox"。被挡住的技能文件仍然可以用 Read 或 Bash 读到。
- 名字匹配 `name` 或 `plugin:skill`。

**为什么不用项目技能**
- 如果把 bot 技能放进工作区 `.claude/skills`，用户恰好有一个同名的个人技能时，个人技能会胜出。白名单按名字匹配，挡不住。
- 用插件命名空间可以避开这个问题。

**热更新**
- 技能目录有文件监听，增删 `SKILL.md` 在当前会话里就生效（skills 文档 "Edit a skill during a session"）。
- 插件里的 hooks、agents、`.mcp.json` 要重载插件才生效。
- SDK 有一个"添加目录"的控制请求，可以带 `reload_skills` 和 `reload_plugins`（SDK `:4930-4937`）。

**相关设置**
- `skillOverrides`、`disableBundledSkills`（SDK `:7008-7014`）。
- `disableSkillShellExecution`（skills 文档）。

**和 v2 设计的冲突**
- 设计里 `settingSources: ['user']`。这样主工作区的 `.claude/skills` 和 add-dir 目录的技能都**不会加载**（claude-code-features 表格）。
- 要么走插件，要么把 `project` 加回设置源。

---

## 4. 代理能读能改的记忆文件

### Codex

- **没有按会话指定的记忆目录。**
- 自带的 memories 功能（配置键 `memories`）是 Stable 但默认关闭（`features/src/lib.rs:1281-1286`）。
  - 目录固定在 `$CODEX_HOME/memories`（`memories/read/src/lib.rs:13-14`）。
  - 它会跨所有 thread 做全局合并（`memories/README.md` "Phase 2: Global Consolidation"）。
  - 结果是各个 bot 的记忆会混在一起，还会和用户自己用 Codex 的记忆混在一起。
  - 如果用户自己开了这个功能，bot 的 thread 要单独关掉：`memories.use_memories=false`、`generate_memories=false`（`config/src/types.rs:330-333`）。推断：这两个键能走会话层覆盖，未实测。
- **推荐机制：vonvon 自己管理的文件。**
  - 例如 `<memoryDir>/MEMORY.md`。
  - 在 developerInstructions 里写明路径和更新规则。
  - 在 `feishu` 配置里给记忆目录一条绝对路径 `write`（`core/src/config/permissions.rs:646-657`）。
  - 开会话时，可以由 vonvon 把 MEMORY.md 的前若干行直接拼进 developerInstructions。
  - 也可以用 turn 级的实验字段 `additionalContext`（`turn.rs:116-119`、`:210-213`）。
- 不要把记忆放进 `.agents/` 或 `.codex/`，那里默认只读（第 2 节）。
- 需要用户定：`qa` 档承诺"只读"，要不要为记忆目录开一个例外。

### Claude

- **原生 auto memory，可以指定目录。**
  - `autoMemoryDirectory` 可以从任何设置层读取，包括 `--settings`（memory 文档 "Storage location"）。
  - SDK 的 `settings` 选项就是 `--settings` 的 flag 层（SDK `:2214-2231`、`:9224-9230`）。
  - 所以每个会话可以传 `settings: {autoMemoryDirectory: '<botHome>/memory/<group>'}`。
- **加载方式**：启动时载入 `MEMORY.md` 的前 200 行或 25KB，其余主题文件按需读取（memory 文档 "How it works"）。
- **写入方式**：代理用普通的 Write 和 Edit 工具写，所以这两个工具必须开着（claude-code-features "What settingSources does not control"）。
  - `qa` 档会拿掉 Write 和 Edit（`permission.ts:38`；`providers.md:692`），这时记忆存不下来。
  - v2 的 PreToolUse 闸门也必须放行记忆目录（`providers.md:693`）。
- **默认目录按 git 仓库划分**："all worktrees and subdirectories within the same repo share one auto memory directory"（memory 文档）。两个 bot 指向同一个仓库就会共用记忆，所以必须显式指定目录。
- **其他**
  - 主会话的 auto memory 不会带进子代理（memory 文档）。
  - 关闭方法：`autoMemoryEnabled:false` 或 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
  - 也可以用主工作区的 CLAUDE.md 当"人写的记忆"，但这需要 `project` 设置源。

---

## 5. 隔离：一个 bot 的技能和记忆不漏到另一个 bot

### vonvon 内部，bot 之间

- 两边都是每个会话独占一个进程，各自传自己的指令、目录、技能根和记忆目录，所以 bot 之间本身不共享状态。
- 剩下共享的是用户级的家目录：
  - Codex 是 `$CODEX_HOME`，包括会话历史、信任列表和 memories。
  - Claude 是 `~/.claude`，包括会话记录、`~/.claude.json` 和默认的记忆目录。
- 推断：所有 bot 的 Codex thread 都会出现在用户自己的 Codex app 和 CLI 历史里，因为两者共用 `CODEX_HOME`（codex-desktop 报告第 21 行）。

### 用户全局配置漏进 bot 会话

| 漏进来的东西 | Codex | Claude | 切断办法 |
|---|---|---|---|
| 全局指令 | `$CODEX_HOME/AGENTS.md`，app-server 总会加载（`app-server/src/message_processor.rs:358`），源码里没找到按 thread 关掉的开关 | 有 `user` 源时加载 `~/.claude/CLAUDE.md` | Codex 只能在人设里声明优先级。Claude 可以试 `claudeMdExcludes`（SDK `:9283-9286`），文档列的是用户、项目、本地、托管这几层，从 `--settings` 传是否生效未验证 |
| 用户技能 | `~/.agents/skills`、`$CODEX_HOME/skills`、内置技能 | `~/.claude/skills` | Codex 用会话层 `skills.config` 禁用规则和 `bundled.enabled=false`。Claude 用 `skills` 白名单 |
| MCP、插件、hooks | `config.toml` 里的 MCP、插件、hooks | `~/.claude.json` 总会读，claude.ai connectors 也会加载，用户 hooks 也会运行（`claude-agent/backend.ts:40-47`） | Claude 用 `strictMcpConfig:true`（v2 设计在 qa、write 档已经这么做，`providers.md:696`）。Codex 按 thread 关 MCP 的写法未核实 |
| 记忆 | 用户开了 memories 时是全局一份 | 默认按 git 仓库划分 | 见第 4 节 |
| 写回用户配置 | 项目信任会写进 `~/.codex/config.toml` | 未发现类似行为 | Codex 这一项暂时无解，要在文档里说明 |

### 换家目录做硬隔离（不推荐用于 v1）

**Codex：设置 `CODEX_HOME`**
- 这个目录必须已经存在（`utils/home-dir/src/lib.rs:6-21`）。
- 登录会丢：
  - 文件存储的凭据在 `$CODEX_HOME/auth.json`（`login/src/auth/storage.rs:205-230`；vonvon 的 `cli/commands/doctor.ts:43` 也从这里读）。
  - 钥匙串存储的键名，是用 `CODEX_HOME` 真实路径算出的哈希（`storage.rs:246-256`）。
- 推断：把 `auth.json` 软链接过去，在文件存储模式下能用，因为写入用的是带截断的打开方式，会跟随软链接（`storage.rs:214-230`）。钥匙串模式下不行。
- `~/.agents/skills` 还是会加载，因为它看的是真实 home。
- 同时会和用户的 `config.toml` 分家，包括模型提供方和 MCP 设置。
- 预热池也要按环境分开。

**Claude：设置 `CLAUDE_CONFIG_DIR`**
- "Each directory has its own settings, session history, and claude.ai login or API key"（[authentication](https://code.claude.com/docs/en/authentication)）。
- macOS 钥匙串条目也按这个目录区分（同页 "Credential management"）。所以每个 bot 都要单独登录一次。
- 还会丢掉 `~/.claude/settings.json` 里的 DeepSeek 等路由，这正是 v2 设计保留 `user` 源的原因（`providers.md:483`）。
- vonvon 用 `getSessionInfo`、`renameSession` 按目录查会话（`claude-agent/backend.ts:303-319`），也必须带同样的环境。

**Claude：设置 `CLAUDE_CODE_OAUTH_TOKEN`**
- 也不推荐。它会让 claude.ai connectors 失效。有报告说它会覆盖 Max 登录（agent-integrations 报告第 104 行，引 anthropics/claude-code#16238）。

**官方警告**
- "Do not rely on default `query()` options for multi-tenant isolation"。多租户时，文档要求每个租户用独立的文件系统，并设 `settingSources: []` 和 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（claude-code-features）。
- vonvon 的场景是同一个用户自己的多个 bot，不是互不信任的多租户。所以"共用登录、会话级切分"可以接受。这是推断，需要用户确认。

### 群和群之间

- 推断，属于设计建议：同一个 bot 在不同群里面对的是不同的人。
- 记忆默认按（bot，群）分目录。
- 想跨群共享的内容，单独放一个 bot 级文件，按只读引用。

---

## 6. 建议给新 provider 合同补的字段（推断）

```ts
// 在 OpenSpec（engine.ts:52）和 Grant（providers.md:56-59）的基础上扩展
interface SessionShape {
  cwd: string;                                    // 主工作区
  roots: { path: string; access: 'read' | 'write' }[]; // 其余工作区和代码仓库，cwd 也在里面
  instructions: string;                           // 飞书约定 + bot 人设 + 群覆盖
  skills: { dir: string; names: string[] };       // vonvon 生成的 bot 技能目录
  memoryDir: string;                              // 按（bot，群）
}
```

**Codex 映射**
- `instructions` → `developerInstructions`。
- `roots` → `runtimeWorkspaceRoots`，再加 `feishu` 配置里的逐路径条目。
- `skills.dir` → `skills/extraRoots/set`。
- 禁用用户技能 → `config.skills.config`。
- `memoryDir` → 一条 write 路径，加上指令。

**Claude 映射**
- `instructions` → `systemPrompt.append`。
- `roots` → `additionalDirectories`，加沙箱 `allowWrite`、`denyWrite`，加闸门的根列表。
- `skills` → `plugins`，加 `skills` 白名单。
- `memoryDir` → `settings.autoMemoryDirectory`。

---

## 7. 上线前要在 Mac 上实测的探针

1. Codex 0.156.1 下，`runtimeWorkspaceRoots` 配合 `feishu` 配置：第二个根能写，根外被拒。
2. Codex 在 `feishu` 配置下，`.git` 是否只读，`git commit` 能不能成功。
3. Codex `skills/extraRoots/set` 之后：thread 里能看到 bot 技能，模型在"只读项目内"档能读到 `SKILL.md`。
4. Codex 会话层 `skills.config` 禁用规则，能不能挡住 `~/.agents/skills`。
5. Codex：developer 人设和项目 AGENTS.md 冲突时，模型听谁的。
6. Claude 在 `settingSources:['user']` 和 `[]` 下，`plugins` 是否加载，看 init 消息的 `plugins` 和 `skills`。
7. Claude `skills` 白名单配合插件技能名，能不能挡住个人技能。
8. Claude 用 `settings.autoMemoryDirectory` 时：写入和读取都在指定目录，PreToolUse 闸门放行。
9. Claude 恢复会话后换 `append`，是否按文档要到压缩后才生效；0.3.296 的 `snapshot:false` 是否有效。

## 未知

- Codex `selectedCapabilityRoots` 能不能用于本地按 thread 挂技能。
- Codex 按 thread 关闭用户 MCP 服务器的写法。
- Claude `claudeMdExcludes` 从 `--settings` 传是否生效。
- Codex 恢复会话时新旧两条 developer 消息怎么共存。
- Codex 同名技能会不会按名字去重，只看到按 scope 排序。
