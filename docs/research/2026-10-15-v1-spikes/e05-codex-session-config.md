# e05：Codex 的会话级配置

`docs/v1-plan.md` 第 4 节的 e05，对应 product.md 第 9 节第 3 项。挡住 s37（会话参数统一由 profile 给）、s39（多工作区，抬高 s03 的最低版本）和 s44（skill 和 MCP 按名单交给会话）。基于 `main` 的 `bfc01d7`。2026-10-15 在 JP-VPS 上实测，没用飞书。

## 结论先行

1. **会话级 `mcp_servers`：能**（0.139.0、0.148.0、0.156.1、0.162.1 都一样）。`thread/start` 的 `config.mcp_servers.<名字>` 起得来，模型的工具列表里有，能调用；用户全局配的 MCP 在会话层写 `enabled: false` 就不出现。只读、读写档（`approvalPolicy: never` 加沙箱）下，要给 server 配 `default_tools_approval_mode: "approve"`，不然调用直接被拒，回的是"MCP tool call requires approval, but approval policy is never"（0.162.1 实测）。完全访问档不配也能调。真实登录下 0.148.0、0.156.1、0.162.1 各让模型调了一次，都成功。
2. **`runtimeWorkspaceRoots`：能**（4 个版本）。`thread/start`、`thread/resume`、`turn/start` 都收，回包原样回显这组根，沙箱的 `writableRoots` 里多出第二个根。第二个根真能写、根外真被拒，JP-VPS 上测不了：Linux 沙箱（bwrap）在这台机器上起不来，见"没测到的"。
3. **`skills/extraRoots/set`：能**（4 个版本）。对整个 app-server 进程生效，设完以后 `skills/list` 和会话里给模型的 skill 清单都有 bot 的 skill。用户自己的 skill 不会自动消失，要在会话层用 `skills.config` 逐个禁掉，按名字禁有效（4 个版本）；系统 skill 用 `skills.bundled.enabled: false` 关（0.156.1、0.162.1 实测）。
4. **resume 后还在不在：部分。** `mcp_servers`、`skills.config`、memories 的键和 `skills/extraRoots/set` 都不保留：resume 时不重传，用户的 MCP 和个人 skill 就回到这条会话里。`runtimeWorkspaceRoots` 从 0.156.1 起保留，0.139.0、0.148.0 不保留。resume 时把参数全部重传，4 个版本都恢复。另外，resume 时传的新 `developerInstructions` 不生效（4 个版本），模型看到的还是开会话时的那份。
5. **中途换 skill 列表：0.148.0 起能，0.139.0 不能。** 0.148.0、0.156.1、0.162.1 上，会话进行中再调一次 `skills/extraRoots/set`，下一轮开头会追加一条新的 skill 清单，旧清单留在历史里。0.139.0 上 `skills/list` 变了，但会话里给模型的清单不变。
6. **memories 两个键能在会话层关掉：能，但光关这两个键不够。** `memories.use_memories: false` 让这条会话不注入记忆，`memories.generate_memories: false` 让这条会话不被收进记忆（状态库里记成 `disabled`）。但用户全局打开了 memories 时，bot 会话的第一轮仍会触发一次全局整合任务：Codex 用这条 bot 会话的配置（含 bot 的 developer 指令和 skill 清单）起一个"Memory Writing Agent"，花的是用户的额度。会话层再加 `features.memories: false` 才不触发。三个一起传（0.139.0、0.156.1、0.162.1 一致）。
7. **`~/.codex/AGENTS.md` 能按会话不加载：不能**（4 个版本）。会话层的 `project_doc_max_bytes: 0` 只能关掉项目里的 AGENTS.md，全局那份照样加载。`thread/start` 回包的 `instructionSources` 列出了实际加载的文件，可以用来显示。源码里全局指令对每条主会话都会加载，没有开关（`codex-rs/core/src/thread_manager.rs:1916`、`core/src/agents_md_manager.rs:103-106`）。
8. **最低版本建议定 0.156.1**，和托管安装锁的版本、验证过的版本一样。原因：
   - 0.139.0 现在用 ChatGPT 登录跑不了任何模型。它的 `model/list` 只有 gpt-5.5、gpt-5.4、gpt-5.4-mini、gpt-5.3-codex、gpt-5.2；试了 gpt-5.5 和 gpt-5.4-mini，服务端都回"not supported when using Codex with a ChatGPT account"；新模型 gpt-5.6-luna 回"requires a newer version of Codex"。
   - 0.148.0 能跑 gpt-5.6-luna，但 gpt-6-luna 被拒；owner 定的智能判断测试模型是 GPT-6-Luna（product.md 第 11 节 2026-10-15）。0.148.0 的 resume 也不保留 `runtimeWorkspaceRoots`。
   - 0.156.1 本文的各项都通过，真实登录一轮成功（gpt-6-luna）。
   - 服务端按客户端版本放行模型，这条线以后还会往上移。所以最低版本不能只看协议字段，"版本太旧"的判断也要接住"模型要求更新的 Codex"这类报错。

顺带发现的几件事，都会影响 s37、s39、s44：

- **主人的 ChatGPT 连接器默认挂在每条 bot 会话上。** 用 owner 的登录时，会话里有一个 `codex_apps` MCP server，0.162.1 上有 197 个工具，含 GitHub 合并 PR、改文件、建 issue 这类写操作。会话层 `features.apps: false` 能去掉（0.162.1，用真实登录，没跑回合）。这和 Claude 一侧的 claude.ai 连接器是同一类问题（product.md 第 9 节第 19 项）。
- **`thread/start` 会改用户的 `config.toml`。** cwd 没有信任设置、沙箱可写时，Codex 把这个项目写成 trusted，存进用户的 `config.toml`：cwd 在 git 仓库里时 0.139.0 和 0.162.1 都写；不在 git 仓库里时 0.139.0、0.148.0 写，0.156.1、0.162.1 不写。会话层传 `projects.<cwd>.trust_level` 后都不写（`trusted` 和 `untrusted` 都试过）。注意 `untrusted` 会跳过项目里的 AGENTS.md（源码 `codex-rs/core/src/agents_md.rs:64-66`，没实测）。
- **拼错的字段不报错。** 顶层字段名拼错、`config` 里的键名拼错，app-server 都静默忽略；值的类型错了才报错。没打开 `experimentalApi` 时，`runtimeWorkspaceRoots` 会报"requires experimentalApi capability"，`skills/extraRoots/set` 不要求它；目录不存在时 `skills/extraRoots/set` 也不报错。所以"实验字段失败就报错"要靠 vonvon 自己核对回包：`runtimeWorkspaceRoots` 看回显，MCP 看 `mcpServerStatus/list`，skill 看 `skills/list`。
- **resume 时要换指令，有两条路。** `thread/inject_items` 塞一条 developer 消息，或者 `turn/start` 带 `additionalContext`（实验字段）。两种 4 个版本都会进模型的请求，并留在历史里。

## 怎么测的

版本：JP-VPS 上 `~/.local/bin` 的 0.162.1（owner 登录的那份）；s03 的 `CODEX_MIN_VERSION` 0.139.0（`packages/daemon/src/agent/codex-appserver/version.ts`）；为了找边界又装了 0.148.0 和 0.156.1（`CODEX_INSTALL_VERSION`）。旧版本用 npm 装在 scratch 的临时前缀里，没有覆盖 `~/.local/bin`。没跑 `codex login`。直接对 `codex app-server --listen stdio://` 讲 JSON-RPC，`initialize` 和 daemon 一样带 `experimentalApi: true`（`packages/daemon/src/provider/transport/jsonrpc.ts:316-321`）。重命令都加了 `flock /tmp/vonvon-heavy.lock`。脚本放在 scratch，没进仓库。

**A. 假模型（不花 owner 的额度，不碰 `~/.codex`）。** 用一个临时 `CODEX_HOME`，`config.toml` 里配一个自定义 `model_provider`，指向本机端口上的假 Responses 服务（`wire_api = "responses"`，假 token）。假服务记下 Codex 每次发给模型的完整请求（工具列表、注入的 developer 和 user 消息），再按脚本回工具调用或一句"OK"。临时 home 里放了：
- 全局 `AGENTS.md`、`memories/memory_summary.md`，各带一个标记串；`[features] memories = true`，模拟用户自己开了 memories；
- 一个全局 MCP（`global_probe`）和 `$CODEX_HOME/skills` 下的一个个人 skill；
- 主工作区和第二个根各放一份带标记的 `AGENTS.md`；
- 真实 HOME 的 `~/.agents/skills` 里本来就有 28 个 `lark-*` 个人 skill，Codex 照样会扫到。

探针 MCP server 是一个 stdio 小程序，记下自己被谁拉起、收到哪些调用。每个版本跑同一套流程：

```
P1: skills/extraRoots/set [A] → thread/start T0（不带会话配置）→ 一轮
    → thread/start T1（带会话配置）→ 一轮（调 bot_probe）
    → skills/extraRoots/set [B] → 一轮 → skills/extraRoots/set [] → 一轮
P2（新进程）: thread/resume T1，只带 cwd 和沙箱（vonvon 今天 resume 时传的）→ 一轮
P3（新进程）: skills/extraRoots/set [A] → thread/resume T1，全部重传 → 一轮
    → T3：config.project_doc_max_bytes=0 → 一轮
    → T4：turn/start 带 runtimeWorkspaceRoots → 一轮
```

T1 的会话参数（路径已略）：

```json
{
  "cwd": "<ws>/main",
  "runtimeWorkspaceRoots": ["<ws>/main", "<ws>/root2"],
  "approvalPolicy": "never",
  "sandbox": "workspace-write",
  "config": {
    "projects": { "<ws>/main": { "trust_level": "trusted" } },
    "mcp_servers": {
      "bot_probe": { "command": "node", "args": ["<mcp-probe.mjs>", "bot_probe", "<log>"], "default_tools_approval_mode": "approve" },
      "global_probe": { "command": "node", "args": ["…"], "enabled": false }
    },
    "memories": { "use_memories": false, "generate_memories": false },
    "skills": { "config": [{ "name": "lark-im", "enabled": false }, { "name": "user-skill-x", "enabled": false }] }
  }
}
```

另外几组小测试：memories 四种组合，每种用一个新的临时 home（不覆盖、两个键、`features.memories: false`、全部）；trust 回写；字段拼错和没开 `experimentalApi`；`skills.bundled`；resume 时换指令；Linux 沙箱能不能起。

**B. 真实登录（花了 owner 一点额度）。** 不设 `CODEX_HOME`，用 `~/.codex` 和 owner 的登录。会话用 `ephemeral: true`，不留会话记录。会话层带上面那组参数，另加 `features.memories: false` 和 `projects` 的信任覆盖。每个版本一轮极短的对话：让模型调一次 `bot_probe_echo`，再回一行"TOOL=…; BOT_SKILLS=…; LARK_IM=…"。`model/list`、`mcpServerStatus/list`、`features.apps` 那一项只起会话，不跑回合。每次前后比 `~/.codex/config.toml` 的 sha256。

## 原始现象

### 1. 版本对照（假模型）

| 项 | 0.139.0 | 0.148.0 | 0.156.1 | 0.162.1 |
|---|---|---|---|---|
| 会话级 MCP 起得来、模型看得到、能调用 | 能 | 能 | 能 | 能 |
| 会话层 `enabled: false` 关掉全局 MCP | 能 | 能 | 能 | 能 |
| `runtimeWorkspaceRoots` 回显、`writableRoots` 多出第二个根 | 能 | 能 | 能 | 能 |
| `turn/start` 带 `runtimeWorkspaceRoots`，请求里出现新根 | 能 | 能 | 能 | 能 |
| `skills/extraRoots/set` 后会话里有 bot 的 skill | 能 | 能 | 能 | 能 |
| `skills.config` 按名字禁个人 skill | 能 | 能 | 能 | 能 |
| 中途换 extraRoots，下一轮追加新清单 | 不能 | 能 | 能 | 能 |
| 只带 cwd 和沙箱 resume：`runtimeWorkspaceRoots` 还在 | 不在 | 不在 | 在 | 在 |
| 只带 cwd 和沙箱 resume：MCP、skill 禁用、extraRoots 还在 | 都不在 | 都不在 | 都不在 | 都不在 |
| 全部重传后 resume 恢复 | 能 | 能 | 能 | 能 |
| resume 时传新的 `developerInstructions` 生效 | 不 | 不 | 不 | 不 |
| `thread/inject_items`、`additionalContext` 进请求 | 进 | 进 | 进 | 进 |
| 全局 `AGENTS.md` 加载（任何会话参数下） | 加载 | 加载 | 加载 | 加载 |
| `project_doc_max_bytes: 0` 关掉项目 AGENTS.md | 能 | 能 | 能 | 能 |
| 第二个根里的 AGENTS.md 加载 | 不 | 不 | 不 | 不 |
| 不带信任覆盖时改临时 home 的 `config.toml`（cwd 不在 git 仓库里） | 改 | 改 | 不改 | 不改 |

只带 cwd 和沙箱 resume 后，那一轮新注入的 skill 清单里出现了 `lark-im` 和 `user-skill-x`，bot 的 skill 没有了；工具列表里只有 `global_probe`。

中途换 skill（0.162.1，那一轮新注入的内容）：

```
换成 B 之后：message/developer <skills_instructions> 只含 bot-skill-b
清空之后：  message/developer <skills_instructions> 不含 bot skill
0.139.0：  这一轮没有新注入的消息
```

### 2. memories（每种组合一个新的临时 home，用户层 `features.memories = true`）

| 会话层传了什么 | 注入记忆 | 会话的 memory_mode | 起"Memory Writing Agent" |
|---|---|---|---|
| 什么都不传 | 是 | enabled | 1 次 |
| 两个键 false | 否 | disabled | 1 次 |
| `features.memories: false` | 否 | enabled | 0 次 |
| 三个都传 | 否 | disabled | 0 次 |

0.139.0、0.156.1、0.162.1 三个版本这张表完全一样。只关 `features.memories` 时，这条会话在状态库里仍是 `enabled`，以后用户开着 memories 跑 Codex，可能把 bot 的对话收进全局记忆（推断：源码里挑会话时只要 `memory_mode = 'enabled'` 的，`codex-rs/state/src/runtime/memories.rs:141`、`:241`）。整合任务的请求里带着 bot 会话的 developer 指令和 skill 清单，cwd 是 `$CODEX_HOME/memories`。

### 3. 真实登录

| 版本 | 模型 | 结果 | input / cached / output tokens |
|---|---|---|---|
| 0.162.1 | gpt-6-luna | 调了 `bot_probe_echo`，回"TOOL=bot_probe says e05; BOT_SKILLS=bot-skill-a; LARK_IM=no" | 19692 / 19200 / 26 |
| 0.156.1 | gpt-6-luna | 同上 | 19661 / 19200 / 26 |
| 0.148.0 | gpt-5.6-luna | 同上 | 15924 / 15104 / 65 |
| 0.148.0 | gpt-6-luna | 400："not supported when using Codex with a ChatGPT account" | — |
| 0.139.0 | gpt-6-luna、gpt-5.4-mini、gpt-5.5 | 400："not supported when using Codex with a ChatGPT account" | — |
| 0.139.0 | gpt-5.6-luna | 400："requires a newer version of Codex. Please upgrade…" | — |

- 4 个版本的 `account/read` 都是 `chatgpt`、有套餐，说明 0.139.0 能读 owner 的登录，是服务端不给它模型。所有运行前后 `auth.json` 的 mtime 都没变。
- `model/list`（真实登录，不跑回合）：0.139.0 是 gpt-5.5（默认）、gpt-5.4、gpt-5.4-mini、gpt-5.3-codex、gpt-5.2；0.148.0 是 gpt-5.6-sol（默认）、gpt-5.6-terra、gpt-5.6-luna；0.156.1 多了 gpt-6-astra（默认）、gpt-6-sol、gpt-6-luna；0.162.1 又多了 gpt-6.1-sol（默认）。
- 4 次 400 都在出字之前就失败，turn 没报 token 用量。
- `mcpServerStatus/list`：默认 `codex_apps(197 tools)`；会话层 `features.apps: false` 后为空（0.162.1）。0.139.0、0.148.0、0.156.1 的会话里也都有 `codex_apps`。

### 4. 其他摘录

0.162.1，不带 approve 时（`feishu` 权限配置）：

```
function_call_output: "MCP tool call requires approval, but approval policy is never"
```

`thread/start` 回包（0.162.1，T1，路径已略）：

```json
"runtimeWorkspaceRoots": ["<ws>/main", "<ws>/root2"],
"sandbox": { "type": "workspaceWrite", "writableRoots": ["<ws>/root2"], "networkAccess": false },
"instructionSources": ["<codex-home>/AGENTS.md", "<ws>/main/AGENTS.md"]
```

JP-VPS 上的沙箱：

```
thread/start（feishu 权限配置，读权限受限）:
  error creating thread: failed to load AGENTS.md instructions for environment `local`:
  fs sandbox helper failed with status exit status: 1: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
workspace-write 下的命令: Process exited with code 1 … bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
stderr: Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.
```

Ubuntu 24.04 的 `kernel.apparmor_restrict_unprivileged_userns = 1`。读权限受限时，Codex 经沙箱读项目 AGENTS.md，这一步就失败，会话直接起不来；`project_doc_max_bytes: 0` 能绕过。打开网络和用旧的 `workspace-write` 写法都一样失败。

## 对设计的影响

- **s39 / s03**：`CODEX_MIN_VERSION` 从 0.139.0 改成 0.156.1，和 `CODEX_VERIFIED_VERSION` 相同，s03 的版本检查不用改结构。比 0.156.1 新的显示"比验证过的新"，照旧能用。v1-plan 里 s03 那条"0.139 实际跑过"要补一句：2026-10-15 起它用 ChatGPT 登录跑不了模型。起会话和恢复会话都传 `runtimeWorkspaceRoots`，不依赖 0.156.1 起的保留行为；回包里的 `runtimeWorkspaceRoots` 和传的不一致就报错。验收里"第二个根能写、根外被拒、`git commit`"只能在 Mac 上做。
- **s37**：profile 在 `thread/start` 和每次 `thread/resume` 都整份重传：`runtimeWorkspaceRoots`、`mcp_servers`（含禁用用户的全局 MCP）、`skills.config`、`skills.bundled`、`features.memories: false` 加两个 memories 键、`projects.<cwd>.trust_level`，以及进程级的 `skills/extraRoots/set`（预热池的进程要在取出后、`thread/start` 前调）。不重传时用户的 MCP 和个人 skill 会悄悄回来。`developerInstructions` 只在开会话时生效：resume 时要放进新内容（改过的人设、群的 `SOUL.md`、记忆），用 `thread/inject_items` 或 `turn/start` 的 `additionalContext`，或者干脆开新会话。product.md 3.6"记忆在会话开始或恢复时放进去"，Codex 一半要按这个做。
- **s44**：bot 的 MCP 在只读、读写档要配 `default_tools_approval_mode: "approve"`，product.md 第 9 节第 2 项"要给它配 approve"的推断成立（0.162.1）。用户的个人 skill 要先 `skills/list` 列出来，再逐个禁掉。bot 的 skill 和个人 skill 可能重名，按名字禁会连 bot 的一起禁，建议按 `path` 禁（按路径禁没实测）。中途换 skill 名单从 0.148.0 起能下一轮生效，0.156.1 当最低版本就不用为这个开新会话。`~/.codex/AGENTS.md` 关不掉，按 v1-plan 4.2 第 3 条用【需要你决定】问 owner；可以把 `instructionSources` 里有没有全局 AGENTS.md 显示在桌面端。
- **新的 owner 决定项**：bot 的 Codex 会话默认带主人 ChatGPT 账号的连接器（`codex_apps`，含 GitHub 写操作）。留不留，和 Claude 的连接器（第 9 节第 19 项）一起问，s31 开工前问。技术上会话层 `features.apps: false` 能关。
- **product.md 3.6"不改用户的全局配置"**：Codex 会自己把 bot 的工作区写进用户的 `config.toml`。vonvon 每次起会话都要带 `projects` 的会话层覆盖。

## 没测到的

- **第二个根真能写、根外被拒、`.git` 只读时 `git commit` 会不会失败（第 9 节第 4 项）**：JP-VPS 上 bwrap 建不了网络命名空间，沙箱里的命令一律起不来，`feishu` 权限配置连会话都起不来。只能在 Mac 上测，归 s39 的 Mac 检查。macOS 上 `feishu` 配置加 `runtimeWorkspaceRoots` 时，经沙箱读 AGENTS.md 是否正常，也一起看。
- **Mac 上 ChatGPT.app 自带的 codex**（预发布号）：v1-plan 已写在 s39 的 Mac 检查里。
- **边界版本没有逐个二分**：中途换 skill 在 0.140 到 0.148 之间的哪一版开始，resume 保留 roots、能用 gpt-6-luna 在 0.149 到 0.156.1 之间的哪一版开始，都没查。最低版本定 0.156.1 时不需要。
- **用户真的开了 memories 的情况**：owner 的 JP-VPS 没开，只在临时 home 里模拟过。
- **按 `path` 禁 skill、只读档（`read-only`）下的 MCP 审批**：没单独测。
- **模型是否真的照 developer 指令压住全局 AGENTS.md**：不在本实验范围（agent-mechanics 第 1 节的推断还没验证）。

## 副作用和清理

- 0.139.0 第一次用 owner 的 `~/.codex` 启动时，往 `config.toml` 开头写了 `personality = "pragmatic"`，又建了标记文件 `~/.codex/.personality_migration`。已把 `config.toml` 恢复成原来的字节（sha256 前 16 位和事前一致），删了标记文件。之后跑旧版本时，先临时放一个标记文件挡住这次迁移，跑完删掉。每一次真实登录的运行，前后 `config.toml` 都没变。0.156.1 和 0.162.1 会不会做这个迁移，没观察到。
- 旧版本还刷新了 `~/.codex` 下的缓存（`models_cache.json`、`codex_apps` 的工具缓存、`.tmp` 下的插件克隆目录），这些是 Codex 自己管的缓存，没动。
- 真实登录的会话都是 ephemeral，没留会话记录。
- 测试期间，另一个实验用这里装的旧版本 codex 同时在跑 owner 的 `~/.codex`。它运行时 `config.toml` 又多了 `personality` 一行和 3 条 scratch 目录的信任记录，`.personality_migration` 也重新出现。这些不是本实验的进程写的；它还在跑，所以没去动。
