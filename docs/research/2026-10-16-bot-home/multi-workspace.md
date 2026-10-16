# 多工作区和 bot 的东西怎么交：13 个后端（2026-10-16）

范围：bot-home 那一轮之后，owner 又提了三点。一是参考 Codex 的多工作区：一个主工作区，其余是附加的，主人能指定自己的主工作区，甚至多个。二是个性、记忆这些文字放在单独的地方；这一点 #349 已经定了，bot 的东西只放 `bots/<appId>/`，会话从工作区起。三是第一版只有 Codex 和 Claude，以后要接更多后端，方案要通用。本文查 13 个后端一条会话能有几个目录、附加目录里自己加载什么、调用方能直接交什么，再实测 Codex 和 Claude 的细节。本文只列事实。owner 2026-10-16 的决定（1A、2A，第 3 题按 A 做，owner 要求下一轮热生效）和据此写的做法见 `docs/product.md` 3.6 和第 11 节。

- 仓库：`claude/docs-bot-home` 的 `f7044ed`（`main` 的 `5d9327e` 加 #349 的两次提交）。`D/` = `packages/daemon/src/`。没改仓库。
- 标注：**实测** = 2026-10-16 在 JP-VPS 上跑过；**源码** = 读了代码或类型定义，没跑；**文档** = 只读了官方文档、帮助或 changelog。版本号和日期都以 2026-10-16 为准，各家版本变得快，用之前先核对。
- 实测的方法：`T=$(mktemp -d)` 建隔离目录，`HOME`、`CODEX_HOME` 等只写在单条命令前面；本机一个假模型接口记下每次请求的完整 body，不登录、不花额度，不碰真实的 `~/.claude`、`~/.codex` 和 vonvon 数据目录；跑完删掉临时目录。夹具是三个目录：`ws1`、`ws2`（git 仓库）和 `bot`（不是 git 仓库），各放带暗号的 `AGENTS.md`、`CLAUDE.md`、`.claude/rules/`、各家的 skill 目录、`.codex/config.toml`、`.mcp.json` 等，每个 MCP 都是起来时写一个标记文件的小程序。看哪些暗号进了发给模型的请求、哪些 MCP 被拉起。实测编号见附录 C。

## 1. 结论

1. **每家一条会话只有一个主目录。** 13 家都这样。MCP 配置哪家都只从主目录来。
2. **附加目录大多只是"能读写的文件"。** 指令文件和 skill，只有几家会从附加目录加载一部分：Claude（`.claude/skills`；CLAUDE.md 要开环境变量）、Gemini（GEMINI.md，要信任工作区）、Qwen（QWEN.md，要开设置）、Cursor（规则、AGENTS.md、skill，只看了源码）、codex-acp（`.agents/skills`）。Codex 直连什么都不加载。
3. **把个性、记忆放进附加目录、指望 agent 自己读，只有 Claude 能做全**，还要开环境变量。其他家都要调用方自己交。
4. **每家都有让调用方直接交东西的口子**，名字不同：追加系统提示、插件或 skill 目录、按会话的 MCP、每轮注入。
5. **Codex 和 Claude 能原生加载同一个插件形状的目录**（插件清单加 `skills/` 和 `.mcp.json`）：Codex 用 `thread/start` 的 `selectedCapabilityRoots`，Claude 用 SDK 的 `plugins`（实测）。product.md 3.6 把它叫"能力包"。
6. **两家开场指令的通道，恢复会话时都不换。** Codex 不认新传的 `developerInstructions`（e05）；Claude 的 `systemPrompt.append` 在第一次请求时就定住了（实测）。两家都能每轮往消息里加东西。
7. **Codex 的"多个主工作区"只能靠多个环境**：每个环境要一个进程，恢复时丢，还会挂到同一进程的别的线程上（实测）。不适合 vonvon。

## 2. 13 个后端一览

| 后端和版本 | 一条会话的目录 | 附加目录里自己加载什么 | 调用方能直接交的 | 来源 |
|---|---|---|---|---|
| Codex 0.163.0（第一版） | 主目录加附加目录（实验字段） | 什么都不加载 | 开场指令（恢复时不换）；能力包（skill 和 MCP，只在开线程时给，恢复后保留，实验字段）；按会话的 MCP；每轮的附加上下文 | 实测 |
| Claude 2.1.296、2.1.301（第一版） | 主目录加附加目录 | `.claude/skills`、agents、commands（要 `project` 来源）；CLAUDE.md 要开环境变量 | 追加系统提示（第一次请求时定住）；插件（skill、MCP、hook）；按会话的 MCP；每轮注入的 hook | 实测 |
| Cursor CLI 2026.10.14 | 命令行能加附加目录，ACP 不行 | 每个根的规则、AGENTS.md、skill | 插件目录；没有公开的系统提示参数 | `--help` 和 ACP 握手实测，加载行为看源码 |
| Kimi Code 2.2.0 | 能加；ACP 只在新会话认，恢复时忽略 | 不加载，只把目录列给模型 | 自定义 agent 文件（只对新会话）；skill 目录（会顶掉它自己找到的） | 源码 |
| Gemini CLI 0.64.0 | 只能按进程加，ACP 不认（不报错，直接忽略） | GEMINI.md（要信任工作区） | 只能整段替换系统提示；设置文件 | 实测 |
| Qwen Code 0.25.2 | 只能按进程加，ACP 不认 | 默认不加载；开设置后只加载 QWEN.md | 追加系统提示；MCP 配置 | 实测 |
| OpenCode 1.19.2 / 2.0.30 | 1.19.2 没有；2.0.30 有，只做权限放行 | 不加载 | 配置里的指令文件、skill 路径（按进程） | 源码 |
| Grok Build 1.0.60 | 只有一个；ACP 收到附加目录直接报错 | — | 追加系统提示；插件目录；ACP 的 MCP | `--help` 和 ACP 报错实测 |
| Pi 1.3.0 | 只有一个 | — | 追加系统提示；skill 路径；MCP 要写扩展 | 实测 |
| Goose 1.54.0 | 只有一个 | — | recipe（指令、扩展）；ACP 的 MCP | 源码 |
| DeepSeek Harness 0.2.1-alpha.4 | 只有一个；ACP 收到附加目录报错 | — | ACP 的 MCP；别的没查清 | 源码 |
| ACP 协议 1.12.0 | 附加目录是可选能力，要先看对方声明；恢复时必须重发 | 协议不规定 | MCP 是标准的（只强制 stdio）；系统提示字段还是草案 | 文档 |
| 两个 ACP 适配器：claude-agent-acp 0.91.0、codex-acp 2.2.2 | 都能加 | claude-agent-acp 给 `.claude/skills`，开环境变量后给 CLAUDE.md；codex-acp 只给 `<根>/.agents/skills` | claude-agent-acp 经 `_meta` 能交追加系统提示、`settingSources`、插件 | 实测 |

各家细节见第 5 节。

## 3. Codex

版本：Codex CLI 0.163.0（npm `latest`，2026-10-15 发布；`alpha` 标签是更旧的 0.163.0-alpha.11，没有更新的版本）。实测都用它。源码对照 `rust-v0.163.0`、`rust-v0.156.1` 和 2026-10-16 的 main，提交号见附录 A。

### 3.1 "主工作区"是什么

- **桌面应用里**（文档）：Codex 桌面应用 26.715（2026-07-23）起，一个项目能挂多个文件夹。新聊天从主文件夹开始，Git 操作和自动发现 `AGENTS.md`、skill、`config.toml` 都只用主文件夹；其余文件夹只能搜、读、改。点"Make primary"换主文件夹。一个项目、一条聊天只有一个主文件夹，没有按文件夹的沙箱规则。
- **CLI 和 app-server 里**（源码）：没有"主文件夹"字段。主文件夹就是线程的 `cwd`，其余是 `runtimeWorkspaceRoots`。`--add-dir` 的帮助写的是"Additional directories that should be writable alongside the primary workspace"。core 里唯一叫 primary 的是第一个环境（3.4）。
- 0.156.1 到 0.163.0 的 release notes 里没有多文件夹的条目，只有内部的环境和 capability root 改动（0.162.0 的 #51221、#51422、#51493，0.163.0 的 #52676）。第三方博客说 0.146 带了多文件夹，0.146.0 的 release notes 里没有。

### 3.2 从主目录、附加目录加载什么（实测）

`thread/start {cwd: ws1, runtimeWorkspaceRoots: [ws1, ws2, bot]}`，换几种信任设置（A、B、C、F）：

| 东西 | 主目录 ws1 | 附加目录 ws2、bot |
|---|---|---|
| `$CODEX_HOME/AGENTS.md` | 加载 | — |
| `AGENTS.md` | 加载；会话层传 `untrusted` 时不加载 | 不加载 |
| `.agents/skills`、`.codex/skills` | 加载；`untrusted` 时也加载 | 不加载 |
| `.codex/config.toml` 的 `developer_instructions` 和 `mcp_servers` | 信任时加载 | 标了 trusted 也不加载 |
| `.mcp.json` | 不加载 | 不加载 |

- 附加目录只列给模型（`<filesystem><workspace_roots>`），可写，其中 `.git`、`.agents`、`.codex`、`.aws` 只读。基础提示里有一句：在 cwd 以外的目录工作时，看看那里有没有适用的 AGENTS.md。
- **会话层信任在 app-server 里有效**，bot-home D4 的分歧到这里有了答案。`thread/start` 传 `config.projects.<cwd>.trust_level = "trusted"`，cwd 的 `.codex/config.toml` 就加载：`developer_instructions` 进了请求，`mcp_servers` 被拉起，用户的 `config.toml` 不变（B）。传 `untrusted`，cwd 的 AGENTS.md 和项目配置都不加载，skill 照样加载（C）。
- **信任不随恢复保留。** 恢复时不传，项目 MCP 就没了（R2，13 个工具剩 9 个）；再传又回来（R3）。
- 不传信任时，`thread/start` 把 ws1（git 仓库）当 trusted 写进用户的 `config.toml`，同一线程里就加载了 ws1 的项目 MCP（A，和 e05 一致）。
- 会话层信任时，`mcpServerStatus/list {threadId}` 不列项目里的 MCP，模型却有这些工具；带 `serverName` 能查到。会话配置里的 `mcp_servers` 和写在 `config.toml` 里的信任照常列出。拿它核对 MCP 起没起时要注意这一点。

### 3.3 能力包：`selectedCapabilityRoots`（实测）

- **字段**（源码）：`thread/start` 的 `selectedCapabilityRoots: [{id, location: {type: "environment", environmentId: "local", path}}]`，实验字段，协议注释是"Capability roots selected for this thread by the hosting platform"。发现时认 `SKILL.md`、`.mcp.json`、`.app.json` 和 `plugin.json`。
- **目录要做成插件的样子**：`.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json`，加 `skills/`、`.mcp.json`。这样 Codex 给这一条线程加上包里的 skill，名字是 `<插件名>:<skill 名>`；拉起包里的 MCP，工具描述里写着"This tool is part of plugin …"；`mcpServerStatus/list {threadId}` 列得出（H5、H6、H7）。两种清单都认，Claude 的那种两家都能用。
- **没有插件清单时**，路径直接指 `bot`：只加载 skill（列成 `executor package: e0/…`，多一个 `skills` 工具），`.mcp.json` 不加载（H1）。路径指 `bot/skills` 时只加载那里的 skill（H3）。
- **不要特性开关**：开不开 `executor_capability_discovery` 结果一样（H1 和 H2，H5 和 H6）。源码里从这些根发现 MCP 要这个开关，实测带插件清单时不要。
- **按线程**：同一进程里另一条线程看不到（H5 到 H7）。
- **恢复后保留**：新进程里 `thread/resume` 不用再传，它也没有这个字段，包还在（H5 到 H7）。
- **只在开线程时定**：`turn/start`、`thread/resume` 都没有这个字段。第一轮之后往包里加 skill 和 MCP，同一进程的第二、三轮看不到；新进程里恢复以后，新 skill 进了清单，新 MCP 被拉起（H8）。
- 不读包里的 `AGENTS.md`。
- **没测**：最低版本 0.156.1 上能不能用。源码里 0.156.1 的协议已有这个字段，但 0.162.0、0.163.0 都有 capability root 的改动，旧版本的行为可能不同。`approvalPolicy: "never"` 下调包里的 MCP 工具会不会被拒：假接口没发出带命名空间的 MCP 调用。
- 对照：`skills/extraRoots/set {extraRoots}` 对整个进程生效（源码；e05 实测能用），只管 skill，不管 MCP。

### 3.4 多个"主工作区"：多个环境（实测，不适合）

- 唯一的办法是多个环境。每个环境一个 cwd，各自的 `AGENTS.md` 都加载，分别标着"for `<id>` with root …"（G1）。`exec_command` 多一个 `environment_id` 参数，不带就在主环境里跑。
- 但 `.agents/skills` 只从第一个环境来，`.codex/config.toml`、`.codex/skills` 和 MCP 只从线程的 `cwd` 参数来（G1、G2）。
- 每个额外环境要一个 exec-server 进程：用 `environment/add` 指向本机的 websocket，或者在 `$CODEX_HOME/environments.toml` 里写 `program = "codex"`，让 Codex 自己起（G5）。本机的 exec-server 不带 `--ws-auth` 也接受连接。
- **恢复时环境丢了**：`thread/resume` 没有 `environments` 字段。不注册就退回只有 `local`，Codex 注入一段"replace all previously provided"的 AGENTS 块；注册了又会把每个环境都挂上，cwd 全变成线程的 cwd（G4）。
- **会串到别的线程**：注册过的环境会挂到同一进程里每一条不带 `environments` 的新线程上，`instructionSources` 里同一个 AGENTS.md 列了三次（G4c、G5）。
- 同一个 id 写两次报 ``duplicate turn environment id `local` ``。
- 要让 agent 读某个仓库的 `AGENTS.md`，在指令里写更简单。

### 3.5 中途换主目录和恢复（实测）

- `turn/start {cwd: ws2, runtimeWorkspaceRoots: [ws2, ws1]}` 重新注入 AGENTS 块（标着"replace all previously provided"）和 ws2 的 `.agents/skills`，但不加载 ws2 的 `.codex/config.toml`、`.codex/skills` 和 MCP，ws1 的 MCP 还在。旧的 AGENTS 块留在历史里（S 的第 2 轮）。之后不带覆盖的一轮什么都不变，cwd 是粘住的（S 的第 3 轮）。
- 只带 `threadId` 恢复：cwd 和根是最后一轮的；沙箱回来时成了只读（开线程时是 workspace-write）；项目 MCP 没了，因为信任不保留（S2）。
- 恢复时再传 cwd、根和信任，AGENTS.md、skill 和 MCP 都回来（S3）。传 `untrusted`，AGENTS 块换成只有全局那份，MCP 没了（R4）。

### 3.6 按路径的权限（实测，Linux bwrap；macOS 没测）

- **bot 目录不当根、按路径给权限**（Q8e）：`:root` 读、`:workspace_roots` 写、`<bot>` 读、`<bot>/groups/g2/memory` 写，根是 `[ws1, ws2]`。
  - 写 `bot/SOUL.md` 被拒；写本群记忆、在记忆目录里建新文件放行；写别的群的记忆被拒。
  - ws1、ws2 能写，其中 `.codex`、`.git`、`.agents` 被拒；`git commit` 失败（`.git/index.lock` 只读）。
  - 回包里 `activePermissionProfile` 是这份配置，`writableRoots` 是记忆目录和 ws2；规则以 `<permission_profile>` 列给模型。
- **bot 目录当根，整个可写**（Q8f）：根是 `[ws1, ws2, bot]`、`:workspace_roots` 写时，`SOUL.md`、本群记忆、别的群的记忆都能写。再加 `<bot>` 读也盖不住根的写；只有更具体的 `<bot>/SOUL.md` 读才挡得住那一个文件。
- **vonvon 真用的读档没测到**：同一份配置换成 `:minimal` 读（vonvon `feishu` 权限配置的样子），线程能起，每条命令都失败，bwrap 找不到 codex 的辅助程序；Codex 还提示 `CODEX_HOME` 在 /tmp 下时不建辅助程序。
- `:minimal` 下 bwrap 会留下空的占位目录：ws1、ws2 里的 `.aws`，可写的记忆目录里的 `.git`、`.agents`、`.codex`、`.aws`。3 次里有 2 次，`:root` 读时没有。

### 3.7 其他

- `projectId` 不决定 cwd 和根，只做校验和记录。项目记录写进 `$CODEX_HOME/state_5.sqlite`，不写别处；id 不存在时报"project not found"（P）。把 bot 的线程归到主人 Codex 应用里的项目下，要往主人的 Codex 状态里写，和 product.md 3.6"不改用户的全局配置"不符。
- 非模型请求没监控。bot-home 那一轮在同样的设置下看到过一次不带凭据的插件列表请求。

## 4. Claude

版本：仓库钉的 Agent SDK 0.3.296（`D/agent/catalog.ts:31`，带 Claude Code 2.1.296）；2026-10-16 最新是 SDK 0.3.301（2026-10-15 发布，带 2.1.301），npm `@anthropic-ai/claude-code` 的 `stable` 标签是 2.1.292。2.1.297、2.1.298 和 SDK 0.3.297、0.3.298 没发布。第 4.2、4.3 节的实测两个版本结果一样，都在 Linux、假接口、`bypassPermissions` 下跑。

### 4.1 2.1.296 以后的变化

- **2.1.299 修了一个和插件有关的洞**（文档，changelog）："Fixed a sandboxed shell command being able to write into a `--plugin-dir` folder, whose code Claude Code reloads and runs outside the sandbox." 仓库钉的 2.1.296 还有这个洞。用插件交东西时，要么抬到 2.1.299 以上，要么保证沙箱里的 Bash 能写的根（工作区、记忆目录、临时目录）都不包含插件目录。Linux 沙箱下没复现过，只看了 changelog。
- **2.1.300 起会话记录多记了请求**（文档；实测）：2.1.301 的记录里有 `api-request-shape`、`api-request-blob`、`api-request` 几种记录，2.1.296 没有。两个版本都记 `prompt_snapshot`（记下的系统提示，含 append）和 `instructions`（CLAUDE.md 的内容），所以个性和记忆的原文都以明文留在 `~/.claude/projects/<cwd 换算的名字>/<会话 id>.jsonl` 里。
- 2.1.299：`/reload-skills` 重发完整的 skill 清单，用来在压缩后找回 skill。2.1.301：修了 `/rewind` 后 skill 不再列出（文档）。
- SDK 0.3.301 的类型文件比 0.3.296 多了：`reloadPlugins({ addPlugins })`，给运行中的会话加插件，路径要绝对，沙箱挡不住 Bash 写插件目录时拒绝；MCP 配置里按工具的 `always_ask`、`always_deny`。`additionalDirectories`、`projectConfigRoot`、`register_repo_root`、`plugins` 没变（源码）。
- 2.1.299 到 2.1.301 的 changelog 里没有 `--add-dir`、CLAUDE.md、AGENTS.md、`.claude/rules` 或信任规则的条目。

### 4.2 从主目录、附加目录加载什么（实测）

| 东西 | 主目录 `cwd` | 附加目录（SDK `additionalDirectories`，即 `--add-dir`） |
|---|---|---|
| `CLAUDE.md`、`.claude/CLAUDE.md`、`.claude/rules/*.md`、`CLAUDE.local.md` | 加载（`project` 来源） | 设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 才加载 |
| `AGENTS.md` | cwd 和上级目录都没有 `CLAUDE.md` 时才加载 | 不加载，开了环境变量也不加载 |
| `.claude/skills` | 加载 | 加载（有热加载），要有 `project` 来源 |
| `.claude/agents`、`.claude/commands` | 加载 | 加载，没有热加载 |
| `.mcp.json` | 经 SDK 不问批准就拉起 | 不加载 |
| `.claude/settings.json` | 加载，hook 会跑 | 只读 `enabledPlugins`（只认 `true`）和 `extraKnownMarketplaces`，hook 不跑 |

- **那个环境变量不受 `settingSources` 管**，文档没写：给 `[]` 或 `['user']` 再加上这个变量，附加目录的 CLAUDE.md 和 rules 照样加载，cwd 的反而不加载。不加变量的对照组不加载。
- 这个变量对所有附加目录都生效。要排除某个目录，经 SDK 传 `settings: { claudeMdExcludes: ['<目录>/**'] }`（实测）。
- 每会话一个开关能让 cwd 的 CLAUDE.md 和 AGENTS.md 都加载：`settings.pluginConfigs['cc-plugin-agents-md@builtin'].options.instructionFiles = 'claude-md-and-agents-md'`（实测）。它只从用户设置、`--settings`（SDK 的 `settings`）或托管设置读。附加目录的 AGENTS.md 开了也不加载。
- 只有一个主目录：环境块里写"Primary working directory: …"和"Additional working directories: …"。文档说 `/cd` 能换主目录并换用新目录的项目配置，经 SDK 能不能用没查。`projectConfigRoot` 能把项目配置换到另一个目录，只能换一个，CLAUDE.md 和 rules 仍从 cwd 读。`register_repo_root` 只收 cwd 或启动时附加目录的子目录。
- 用 SDK 起会话不往 `~/.claude.json` 写信任记录：跑完以后临时 HOME 里的这个文件没有 `projects` 键。这一点和 Codex 不同。
- 要信任才用的几样（文档，没测）：附加目录里 agent 文件的 hook 和内联 `mcpServers`、`@skills-dir` 插件、`extraKnownMarketplaces`，在 `-p` 或 SDK 下、目录不受信任时不用。

### 4.3 不进工作区就能交个性、记忆和 skill 的办法（实测）

| 办法 | 进到哪里 | 恢复会话时 | 会话中途改了 |
|---|---|---|---|
| A. `systemPrompt.append`（vonvon 今天用的） | 系统提示 | 第一次请求时定住：恢复时传新的被忽略，不传也照发旧的。恢复那次带 `snapshot: false`，这一次用新的；下一次不带，又回到原来的记录。压缩会重新渲染（文档） | 放进下一条用户消息，或者用 hook 的 `additionalContext` |
| B. bot 目录当附加目录，开环境变量，个性和记忆写成 CLAUDE.md | 第一条用户消息里的 system-reminder，标成"project instructions, checked into the codebase" | 每次启动都重读，包括恢复：变了的文件以"Instruction files were re-read when this session started; these differ from their earlier copies — each replaces its earlier copy…"加新内容的形式追加；删了的写"Instructions no longer present: <路径>"；旧的留在历史里。文档没写 | 中途不重读：改完下一轮还是旧的 |
| C. SDK `plugins: [{type:'local', path}]` | 带命名空间的 skill（`<插件>:<skill>`）、agent、MCP 工具（`mcp__plugin_<插件>_<server>__<工具>`）、hook 的输出 | 每次启动都要传。带着插件恢复：新加的 skill 以增量通知；已有 skill 改了描述不再通知。不带插件恢复：MCP 工具消失，agent 收到"不再可用"，skill 没有移除通知，旧清单留在历史里，hook 不跑 | 改插件里的 `SKILL.md`，下一轮看不到；要 `reloadSkills()` 或 `reloadPlugins()` |
| C2. 插件里的 SessionStart 命令 hook 返回 `additionalContext` | 对话里的上下文 | 开始和恢复时都跑；恢复时内容变了才追加，没变不重复（2.1.301） | — |
| D. SDK `hooks.UserPromptSubmit` 回调返回 `additionalContext` | 每轮加一段 | 开始和恢复都有效 | 每轮都加，占 token，适合小段 |
| SDK `hooks.SessionStart` 回调 | — | 流式输入（0.3.301）下开始和恢复都没触发，文档说 TypeScript 支持，原因没查到 | — |

- **插件不需要信任，也不挑 `settingSources`**：空 HOME 下插件的 hook 跑了，MCP 起了；`settingSources` 给 `[]`、`['user']`、`['user','project']` 都加载。`2026-10-14-v1-definition/agent-mechanics.md` 里这一项待查，到这里有了答案。
- SDK 的 `skills` 白名单收 `<插件>:<skill>` 这种名字，会把工作区和附加目录的 skill、command 从给模型的清单里滤掉，agent 不滤。
- 插件的风险（文档，没测）：任何设置文件里写 `"<名字>@inline": false` 都能关掉这个插件，包括工作区的 `.claude/settings.json`；它还会悄悄顶掉同名的已安装插件；hook 在沙箱外跑（见 4.1 的洞）。
- 插件 `settings.json` 里写 `{"agent": "<插件里的 agent>"}`，或 SDK 的 `agent`，会整段替换 Claude Code 的系统提示，像 `--system-prompt`（文档，没测）。写代码用的那部分提示就没了。

### 4.4 对 bot-home 的更正

- B2、D9 说 append 的快照"只对开了这项的账号生效"，过时了。文档说 2.1.265 起默认开，2.1.268 起不拉特性开关的会话也算。关掉非必要流量（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）时，2.1.296 和 2.1.301 实测仍然定住，新的 append 连会话记录都不进。
- D9 问 CLAUDE.md 中途改了会不会重读：中途不重读，每次启动（包括恢复）重读并提示差异（4.3 的 B）。
- B1：附加目录还加载 `.claude/agents` 和 `.claude/commands`；那里的 CLAUDE.md 和 rules 只看环境变量，不看 `settingSources`。
- D4：app-server 会话层传 `trusted` 会加载 `.codex/config.toml`（3.2）。`codex exec -c` 不加载是 `exec` 的行为。
- product.md 3.3 写"Claude 只在没有 CLAUDE.md 时才读 AGENTS.md"：默认如此，4.2 的每会话开关能让它两份都读。

## 5. 其他后端

除注明的以外，都只查了文档或源码。DeepSeek 和 Kimi 的模型第一版走 Claude 的设置（product.md 3.11），跟着 Claude。

- **ACP 协议**（v1.12.0、稳定 schema v1.26.0，文档）：`session/new`、`load`、`resume` 带 `cwd`（主目录，相对路径的基准）和可选的 `additionalDirectories`。后者 2026-06-01 起是稳定字段，要先看 agent 有没有声明 `sessionCapabilities.additionalDirectories` 才能发；恢复时必须重发。协议只说 agent 应该（SHOULD）在附加目录里做同样的发现，发现不等于信任。`session/prompt` 只带用户内容，系统提示字段还是草案（不稳定）。MCP 是标准的，只强制 stdio。
- **claude-agent-acp 0.91.0**（2026-10-15，包 SDK 0.3.300；实测）：附加目录给 `.claude/skills`，不给 CLAUDE.md；经 `_meta.claudeCode.options.env` 设上面的环境变量后给。`_meta.systemPrompt.append`、`options.settingSources: ['user']`、`options.plugins` 都能用。只给 `['user']` 时附加目录的 skill 不加载，skill 要走插件。
- **codex-acp 2.2.2**（2026-10-10，带 Codex 0.160.1；实测加源码）：附加目录的 `.agents/skills` 进了请求，`AGENTS.md` 和 `.codex/skills` 没有（`.codex/skills` 只出现在 ACP 的斜杠命令清单里）。它把附加目录映射成 trusted 项目和 `writable_roots`，没用 `runtimeWorkspaceRoots`。
- **Cursor CLI 2026.10.14**：`--add-dir` 只在命令行（`--help` 实测；官方参数页没列，论坛里员工回复过），ACP 的 `initialize` 只声明 `sessionCapabilities.list`（实测），新会话只用 cwd（源码）。源码里每个根的 `.cursor/rules`、`AGENTS.md`、skill 和 `.cursor/agents` 都加载，MCP 只从主目录的 `.cursor/mcp.json` 和用户的来；`--worktree` 会丢掉附加目录；命令行恢复要重传附加目录。没有公开的系统提示参数：`--system-prompt` 的帮助写着只给内部团队，能交的是 `--plugin-dir`（规则、skill、agent、MCP、hook）。ACP 的 `mcpServers` 认（源码）。加载行为要登录才能测，没测。
- **Kimi Code 2.2.0**（源码）：`--add-dir`；ACP 声明了附加目录，但只在 `session/new` 认，`load`、`resume`、`fork` 忽略并警告。附加目录按 cwd 记，同一进程里同一 cwd 的会话合在一起，不会删。附加目录只在系统提示里列一下，`AGENTS.md`、skill、MCP 都只从 cwd 来。`--agent-file` 只对新会话；`--skills-dir` 会顶掉它自己找到的用户和项目目录。没有系统沙箱。旧的 Python 版 kimi-cli 1.52.0 已归档。
- **Gemini CLI 0.64.0**（实测加源码）：`--include-directories` 加上信任工作区时，加载附加目录的 GEMINI.md，不加载 skill；不信任时两个目录都不加载。ACP 的 `initialize` 不声明附加目录，收到这个字段直接忽略，不报错。只能整段替换系统提示。
- **Qwen Code 0.25.2**（实测加源码；Gemini CLI 的分支）：`--include-directories` 默认什么都不加载；开 `context.loadFromIncludeDirectories` 只加载 QWEN.md。ACP 只声明 list、resume，新会话只读 cwd 和 `mcpServers`。
- **OpenCode**（源码）：1.19.2 没有附加目录，只能用 `external_directory` 权限；2.0.30（npm `@opencode/cli`）有，只做权限放行，不加载东西。
- **Grok Build 1.0.60**（实测加文档）：只有 `--cwd`。ACP 的 `session/new` 带 `additionalDirectories` 返回 -32602"additionalDirectories is not supported: a session works only in its cwd"，恢复时也拒（源码）。规则从仓库根一路读到 cwd（`AGENTS.md`、`CLAUDE.md`、`.grok/rules` 等）。能交的：`--rules`（即 `--append-system-prompt`）、`--system-prompt-override`、`--plugin-dir`、ACP 的 `mcpServers`。沙箱默认关，额外路径只能写在 `sandbox.toml` 的配置里。
- **Pi 1.3.0**（实测）：命令行、RPC、SDK 都只有一个 cwd，也不是安全边界，没有内置沙箱。cwd 和上级目录的 `AGENTS.md` 不用信任就加载；项目的 skill 要信任（`--approve`），无头时默认跳过。能交的：`--append-system-prompt`、`--system-prompt`、`--skill`、`--no-context-files`；MCP 要用 `-e` 加载一个扩展，调 `pi.registerMcpServer`。都不往工作区写文件。没有原生 ACP。
- **Goose 1.54.0**（源码）：没有附加目录，也没有目录边界。recipe 交指令和扩展；ACP 的 `mcpServers`。
- **DeepSeek Harness 0.2.1-alpha.4**（源码；开发者预览版）：ACP 收到附加目录报"additionalDirectories is not supported"；沙箱的可写根是工作区和临时目录。指令从工作目录往上读 `AGENTS.md`、`CLAUDE.md`。ACP 的 `mcpServers` 认；按会话交系统提示的办法没查清。

## 6. 对 vonvon 的含义：每个后端一个适配

这一节是由上面的事实推出的做法，product.md 3.6 按它写，第一版只写 Codex 和 Claude 两个适配。

vonvon 定一条会话要什么：主工作区、附加目录和各自能不能写、指令、skill、MCP、这一次的记忆目录可写。每个适配报出下面几项，做不到的由 vonvon 补：

| 项 | 适配要报的 | 做不到时 vonvon 怎么补 |
|---|---|---|
| 附加目录 | 按会话、按进程，还是没有 | 按进程的，一个进程只跑一条会话；没有的，界面写"这个后端只用主工作区"，也不发这个字段（Grok、DeepSeek Harness 收到会报错） |
| 目录读写 | 能不能按目录分只读、可写 | 分不了的，只给"全可写"或"全只读"，或者不给附加工作区 |
| 指令 | 追加系统提示、整段替换、插件里的规则文件，还是都没有 | 规则文件只对 Cursor、Grok 这类插件带规则的有用；都没有，就放在每条会话第一条消息前面 |
| skill | 插件目录、skill 路径（会不会顶掉它自己找到的） | 都没有，由 vonvon 的 MCP 把 skill 列给 agent |
| MCP | 按会话还是按进程；支持哪些传输（stdio、http、sse） | vonvon 自己的 MCP 按对方支持的传输起 |
| 恢复会话 | 哪些要重传，哪些重传也不生效 | 每轮注入补；补不了的，界面写"要 /new 后生效" |

Codex 和 Claude 两个适配按 2026-10-16 的实测：

| 项 | Codex（app-server 0.163.0） | Claude（SDK 0.3.296、0.3.301） |
|---|---|---|
| 附加目录 | 按会话（`runtimeWorkspaceRoots`，实验字段） | 按会话（`additionalDirectories`） |
| 目录读写 | 能按路径分（权限配置；Linux bwrap 实测，macOS 没测） | 沙箱按路径分（管 Bash）；Write、Edit 靠权限规则或回调 |
| 指令 | `developerInstructions`，恢复时不换 | `systemPrompt.append`，第一次请求时定住 |
| skill | 能力包（`selectedCapabilityRoots`） | 能力包（`plugins`） |
| MCP | 能力包；会话配置 `mcp_servers` | 能力包；`mcpServers` |
| 恢复会话 | 根、MCP 配置、skill 配置、信任每次重传；能力包不用重传，也传不了 | 插件、档、附加目录每次重传 |

## 7. 没测的

- Codex：`selectedCapabilityRoots` 在 0.156.1 上；`approvalPolicy: "never"` 下包里的 MCP 工具会不会被拒；macOS Seatbelt 下按路径的权限，和 `:minimal` 读档；桌面应用实际发了什么（要 owner 的 Mac 和应用）；非主环境里命令的沙箱（G 组用的完全访问）；0.163.0 以外的版本都没重测。
- Claude：工作区 `.claude/settings.json` 里 `"<插件名>@inline": false` 能不能关掉插件；2.1.296 下沙箱里的 Bash 能不能真写插件目录；插件 skill 的热加载要多久；SDK 的 SessionStart 回调为什么不触发、非流式时触不触发；`/cd` 经 SDK 能不能用；压缩；`default`、`acceptEdits` 加沙箱，和 macOS。
- 4.2、4.3 里两条文档没写的行为（环境变量不受 `settingSources` 管、恢复时重读 CLAUDE.md 并提示差异），以后的版本可能变。
- Cursor 按根加载规则和 skill、它的沙箱给不给附加目录写权限（要登录）；Kimi 没装，只看了源码和文档；DeepSeek Harness 按会话交系统提示的办法。

## 附录

### A. 版本和来源

- Codex：npm `@openai/codex` 0.163.0（2026-10-15 21:37 UTC）。之前的 CLI 版本：0.156.1（09-23）、0.157.0（09-25）、0.157.1（09-26）、0.160.0（10-01）、0.160.1（10-05）、0.161.0（10-07）、0.162.0（10-08）、0.162.1（10-09）。源码对照 tag `rust-v0.163.0`（`83086188ae06`）、`rust-v0.156.1`（`b412ff32c417`），main `6ae8b8aa7c60`（2026-10-16 06:06 UTC）。桌面应用 changelog：26.715（07-23，多文件夹项目）、26.727（07-30，多仓库审查）、26.730（08-04）、26.915（09-17）。文档：learn.chatgpt.com 的 `/docs/projects`、`/docs/changelog`、`/docs/agent-configuration/agents-md`、`/docs/build-skills`。
- Claude：SDK `@anthropic-ai/claude-agent-sdk` 0.3.296（仓库钉的）、0.3.301；CLI 2.1.296、2.1.301。changelog 在 github.com/anthropics/claude-code 的 `CHANGELOG.md`。文档：code.claude.com 的 `/docs/en/permissions`（附加目录、信任表）、`/docs/en/memory`（附加目录、AGENTS.md）、`/docs/en/agent-sdk/plugins`、`/docs/en/plugins/loading`、`/docs/en/hooks`、`/docs/en/agent-sdk/modifying-system-prompts`、`/docs/en/cli-reference`。和附加目录有关的历史（changelog）：2.1.20 加 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`；2.1.32 附加目录的 skill 加载；2.1.45 从附加目录读 `enabledPlugins`；2.1.218、2.1.238 几样东西改成要信任；2.1.219 加 `register_repo_root`；2.1.265、2.1.268 append 快照默认开；2.1.275 加 `projectConfigRoot`；2.1.277 支持 AGENTS.md。
- 其他：ACP 协议 v1.12.0、schema v1.26.0（`e2d8334`）；claude-agent-acp 0.91.0（`c0af592`）；codex-acp 2.2.2（`202e66e`）；Cursor CLI 2026.10.14-941492e；Kimi Code 2.2.0（`472192c`）；Gemini CLI 0.64.0（`4a0749a`）；Qwen Code 0.25.2（`8a415cb`）；OpenCode 1.19.2（`7901b7d`）、2.0.30（`f16ef9a`）；Grok Build 1.0.60；Pi 1.3.0（`71023ae`）、pi-acp 0.0.34（`b0581c9`）；Goose 1.54.0（`cd643d2`）；DeepSeek Harness 0.2.1-alpha.4（`86a4022`）。

### B. Codex 协议字段（源码，0.163.0 的 `app-server-protocol/src/protocol/v2/`）

- `thread/start`：`cwd`；`runtimeWorkspaceRoots`（实验，"Replace the thread's runtime workspace roots"）；`projectId`（实验）；`environments`（实验，非空时第一个是当前环境）；`selectedCapabilityRoots`（实验）。回包有 `cwd`、`runtimeWorkspaceRoots`、`instructionSources`（`thread.rs:81-155`、`:196-204`）。
- `thread/resume`、`thread/fork`：`cwd`、`runtimeWorkspaceRoots`；没有 `environments` 和 `selectedCapabilityRoots`。
- `turn/start`：`environments`、`cwd`（"for this turn and subsequent turns"）、`runtimeWorkspaceRoots`（`turn.rs:215-229`）。
- `skills/list {cwds}`（空时用会话的工作目录）；`skills/extraRoots/set {extraRoots}`，进程级（`plugin.rs:21-43`）。
- `selectedCapabilityRoots` 的形状在 `protocol/src/capabilities.rs:13-18`、`:62-75`；发现时认的文件在 `exec-server/src/capability_discovery.rs:28-31`；MCP 发现的开关 `executor_capability_discovery` 在 `features/src/lib.rs:1626-1630`。
- AGENTS.md 按每个环境的 cwd 读（`core/src/agents_md.rs:58-122`），只在环境选择或信任变了时重新发现（`agents_md_manager.rs:87-99`）。skill 根在 `ext/skills/src/host_roots.rs:28-71`。项目配置和信任在 `config/src/loader/mod.rs:341-421`。`runtimeWorkspaceRoots` 的默认值在 `core/src/config/mod.rs:3669-3682`。

### C. Codex 实测编号

所有 `thread/start` 都带 `approvalPolicy: "never"`，除注明的外都是 `sandbox: "workspace-write"`。

| 编号 | 做了什么 |
|---|---|
| A | `cwd: ws1, runtimeWorkspaceRoots: [ws1, ws2, bot]`，不传信任 |
| B | A 加会话层 `config.projects` 三个都 `trusted` |
| C | A 加 ws1 `untrusted` |
| D | 先 `skills/extraRoots/set` 指向 `bot/skills`、ws2 的两个 skill 目录，再做 B |
| E | `cwd: bot`，根 `[bot, ws1, ws2]`，三个都 trusted（对照：反过来起） |
| F | 对照：信任写进临时的 `config.toml` 文件 |
| G1、G2 | 三个环境（`local`、`ws2env`、`botenv`），完全访问；G2 把 `botenv` 放第一 |
| G4、G4c、G5 | 环境在恢复后、在同一进程的别的线程上、用 `environments.toml` 时怎样 |
| H1 到 H3 | `selectedCapabilityRoots` 直接指 `bot`；H2 开特性开关；H3 指 `bot/skills` |
| H5 到 H7 | 指插件形状的目录：H5 Claude 的清单不开开关，H6 开开关，H7 Codex 的清单开开关 |
| H8 | 第一轮之后往包里加 skill 和 MCP，看同一进程和新进程恢复后 |
| S、S2、S3 | 每轮换 cwd 和根，再在新进程里恢复 |
| R、R2 到 R4 | 恢复时带不带信任、带 `untrusted` |
| P | `project/create` 加 `thread/start {projectId}` |
| Q8e、Q8f | 按路径的权限配置：bot 不当根、当根 |

### D. Claude 实测

- fixture 和 Codex 那组一样，另有 CLAUDE.md、`.claude/rules`、`.claude/settings.json`（带 hook）、插件目录（`.claude-plugin/plugin.json` 加一个 skill、一个 MCP、一个 SessionStart hook）。
- 多数做法在 SDK 0.3.296 和 0.3.301 上各跑一次，C2 只在 0.3.301 上跑。恢复用同一个会话 id 在新进程里接上；改文件放在两轮之间。
- 环境变量和 `settingSources` 的组合：`[]`、`['user']`、`['user','project']` 各加不加环境变量。
