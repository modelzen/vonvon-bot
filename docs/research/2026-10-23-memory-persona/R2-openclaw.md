# R2：OpenClaw 的个性、身份与记忆实现调研（只读源码）

调研对象是 OpenClaw 的浅克隆，HEAD 为 `6fb9c2e`（2026-10-22），本地路径（本地拉取的源码）。下文用 `openclaw/路径:行号` 引用它，用 `docs/...:行号` 引用 vonvon dev 分支（9b113b6）。

依据分三种标注：
- 【代码】：读源码确认的。
- 【文档】：只读了 OpenClaw 自己的文档，没逐行核对代码。
- 【推断】：根据代码或文档推出来的，没有验证。

## 0. 要点

1. **个性、身份和用户画像都是工作区里的纯 Markdown 文件。**
   - 包括 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、`USER.md`、`MEMORY.md`，加上只在首次运行时出现的 `BOOTSTRAP.md`。
   - 按固定顺序拼进系统提示的 "Project Context" 段，单文件上限 2 万字符，总共 6 万，`USER.md` 单独 4000。【代码】
2. **群聊不加载主人的长期记忆，`USER.md` 照常加载。**
   - 群、频道、子 agent、cron 会话会把 `MEMORY.md` 过滤掉，这是硬编码的。【代码】
   - `SOUL.md`、`USER.md` 群里照常加载。
3. **群里非主人说的话，记成"不可信"。**
   - 每条记忆都带来源等级 `owner / agent / untrusted / system`，存在 SQLite 列里。
   - 非主人发言，以及回复非主人的那一轮里 agent 写的记忆文件，都记成 `untrusted`。
   - `untrusted` 的内容永远不自动注入，也不晋升进 `MEMORY.md`。【代码】
4. **记忆分三层。**
   - 每日笔记 `memory/YYYY-MM-DD.md`：随手记，靠 `memory_search` / `memory_get` 按需取。
   - `MEMORY.md`：精选长期事实，每次开会话注入。
   - 后台整理（dreaming）：夜里按规则打分、带门槛地把每日笔记晋升进 `MEMORY.md`，过程写进 `DREAMS.md` 供人审阅。【文档 + 部分代码】
5. **压缩前有一轮"记忆冲刷"（memory flush）。**
   - 静默跑一轮，让 agent 把要紧的东西**追加**进当天的每日笔记。
   - 这一轮里 `SOUL.md`、`MEMORY.md` 按只读处理。【代码】
6. **没有任何代码挡住 agent 改自己的 `SOUL.md`。** 模板反而鼓励它"自我演化"，只用提示词要求"改了要告诉用户"。【代码 + 模板】
7. **界面上主人能直接编辑这些文件。**
   - 控制台 Settings → Agents → Files 能看和改 AGENTS / SOUL / USER / MEMORY，身份走单独的表单，有预览和哈希冲突检测，写入要管理员权限。
   - `/context list` 列出这一轮实际注入了哪些文件、原始和注入后各多大。【代码 + 文档】
8. **有飞书渠道，是官方插件，做到生产可用。**
   - 支持多个机器人账号、按私聊或群路由到不同 agent、每个群单独的 `systemPrompt`，以及 `groupSessionScope`（按群 / 群+人 / 话题 / 话题+人切会话）。【代码 + 文档】

## 1. 个性和身份文件

### 1.1 文件清单和用途

| 文件 | 用途 | 默认模板要点 |
|---|---|---|
| `AGENTS.md` | 操作规矩、记忆使用办法、群聊约定；原来的 `TOOLS.md` 已并进它的 `## Tools` 段 | 红线、"会话开始先用运行时给的上下文"、Memory 一节、Group Chats 一节（`openclaw/docs/reference/templates/AGENTS.md:12-97`；`TOOLS.md` 已退役，见 `templates/TOOLS.md:8-12`） |
| `SOUL.md` | 人格、语气、边界 | "你不是聊天机器人，你在成为某个人"；有观点、少客套；"别把私事带进群"；"改了这个文件要告诉用户""这个文件归你演化"（`templates/SOUL.md:10-44`） |
| `IDENTITY.md` | 名字、物种、气质、emoji、头像 | 五个 `- 标签: 值` 字段；没填的占位文字不算值（`templates/IDENTITY.md:12-31`） |
| `USER.md` | 用户画像，写成"指令"形式 | 每条前面一行 `<!-- observed: 日期 \| status: active -->`，用 Always / Never / Prefer 开头；偏好变了就把旧条标 `superseded`，就地重写，不追加矛盾条目；上限 4000 字符（`templates/USER.md:14-24`） |
| `BOOTSTRAP.md` | 首次"孵化"仪式，做完即删 | 见 1.3 |
| `MEMORY.md` | 精选长期事实和决定，可选 | 见第 2 节 |
| `HEARTBEAT.md`、`BOOT.md` | 心跳和启动清单，可选 | 与本题无关 |

【代码】prompt 的顺序在两处定义：
- `openclaw/src/agents/workspace-bootstrap-policy.ts:30-37` 是加载清单。
- `openclaw/src/agents/system-prompt-context-files.ts:7-15` 是排序表：agents 10 → soul 20 → identity 30 → user 40 → tools 50 → bootstrap 60 → memory 70。

### 1.2 怎么注入系统提示

**拼装方式。**【代码】`buildProjectContextSection` 先写 `# Project Context`，再按存在的文件各写一句定位说明，然后逐个贴 `## <路径>` 加全文（`system-prompt-context-files.ts:72-97`）。三句说明分别是：
- "SOUL.md: persona/tone. Follow it unless higher-priority instructions override."
- "MEMORY.md: durable non-profile facts and decisions …"
- "USER.md: durable user preferences …"

**截断规则。**
- 【代码】单文件默认 20000 字符（`embedded-agent-helpers/bootstrap-limits.ts:3`），总量 60000，`USER.md` 4000（`embedded-agent-helpers/bootstrap.ts:87-91`）。
- 【代码】超长文件保留前 75%、后 25%（同文件 `:96-97`）；`AGENTS.md` 另有一套"策略摘要"截断（同文件 `:101-104`）。
- 【文档】截断时提示里一定附一句通用提示"有文件被截断，请直接读原文件"，但不列具体是哪个文件（`docs/concepts/system-prompt.md:187-194`）。
- 【文档】用户的个人 `USER.md` 超限就整份不注入，不做部分注入（`docs/concepts/user-model.md:93-96`）。

**按会话类型过滤。**【代码】`filterBootstrapFilesForSession`（`openclaw/src/agents/workspace.ts:987-1007`）：
- 群、频道、子 agent、cron 都算"非私密"，去掉 `MEMORY.md`。
- 子 agent 只留 `AGENTS.md`（`:950`）。
- cron 留 AGENTS / SOUL / IDENTITY / USER（`:952-957`）。
- 也就是说，群里照样有 SOUL 和 USER，没有 MEMORY。

**来源门槛。**【代码】`MEMORY.md` 和 `USER.md` 进自动注入之前，还要查它记录的来源等级，只有 `owner` 或 `agent` 才放行（`openclaw/src/agents/bootstrap-files.ts:193-258`；`openclaw/packages/memory-host-sdk/src/host/types.ts:78-82`）。

**执行目录和配置工作区分开。**【文档】会话在别的目录或 worktree 里跑时，只追加那个目录的 `AGENTS.md`，绝不从执行目录读 SOUL、IDENTITY、USER、MEMORY、BOOTSTRAP（`docs/concepts/system-prompt.md:166-168`）。这和 vonvon"bot 目录不当工作区"是同一个思路。

**Codex 后端的特殊路径（对 vonvon 很有参考价值）。**【文档】`docs/plugins/codex-harness-reference/workspace-bootstrap-files.md`：
- `:24-26`：在原版 Codex 上，`thread/resume` 时传 `developerInstructions` 不会刷新模型看到的指令。这和 vonvon e05 的实测结论一样。
- `:118-120`：OpenClaw 的办法是在指令变了以后"冷恢复"，也就是确认原生会话已经卸载，再带着完整的新指令恢复。
- `:59-73`：`MEMORY.md` 不贴进 Codex 的每轮输入，只放一个指向记忆的提示，让模型自己调 `memory_search`；新线程、冷恢复、压缩后，或内容变了，再重新带一次。

【代码】Codex 的原生记忆：只在 Responses OAuth 这条路由上显式关掉 `features.memories`（`openclaw/extensions/codex/src/app-server/thread-requests.ts:421-431`）。【文档】其余情况每个 agent 有自己的 `codex-home`（`docs/concepts/agent-workspace.md:118`）。vonvon 选择不换 `CODEX_HOME`，这条不能照搬。

### 1.3 谁能改、首次孵化

**主人手改。**
- 【文档】控制台 Settings → Agents → Files（`docs/concepts/agent-workspace.md:68`）。
- 【代码】后端 `agents.files.set` 只接受这几个固定文件名，单文件不超过 2 MiB，带 `expectedHash` 做冲突检测（`openclaw/src/gateway/server-methods/agents-files.ts:42-52`、`:360-440`）。
- 【代码】写入要 `operator.admin` 权限（`openclaw/src/gateway/methods/core-descriptors.ts:186`）。

**身份。**
- CLI `openclaw agents set-identity` 写进配置；表单保存时同时写回 `IDENTITY.md`，配置里的值优先（`ui/src/i18n/locales/en-settings.ts:73`；`templates/IDENTITY.md:33`）。

**首次孵化。**【文档】`templates/BOOTSTRAP.md`：
- 只在全新工作区种下（`:12`）。
- "用户的请求永远优先，仪式不是门槛"（`:14-18`）。
- 四步：问用户想叫它什么，不许自己起名（`:23-27`）；给一句气质描述和一个 emoji（`:29-32`）；有生图能力就出 2×2 四个头像让用户挑（`:38-75`）；推荐插件（`:101-153`）。
- 保存时同时写 `IDENTITY.md` 加 `SOUL.md`，再跑 `set-identity` 写配置（`:77-97`）。
- 做完删掉 `BOOTSTRAP.md`。三个画像文件里任一个偏离模板，或出现 `memory/` 目录，就算配置完成，不再重建（`:157-165`；代码见 `workspace.ts:277`、`:465`）。

**agent 自己改。**
- 【代码】没有专门挡 agent 写 SOUL 或 AGENTS 的代码。能不能写只看这个会话的工具策略和沙箱。
- 【文档】模板和文档都鼓励自改。`docs/concepts/soul.md:36-53` 提供一段 "Molty prompt"，让 agent 自己重写 `SOUL.md`。
- 【文档】唯一的提醒是 `soul.md:64-69`："人格不等于可以马虎，规矩放 AGENTS，语气放 SOUL"。
- 【文档】`docs/concepts/memory-architecture.md:57` 把指令层标为"只由人写"，但这只是约定。【推断】代码层面没有强制。

## 2. 记忆

### 2.1 分层

【文档】`docs/concepts/memory-architecture.md:53-73`：

| 层 | 载体 | 谁写 | 何时进上下文 |
|---|---|---|---|
| 指令 | AGENTS.md 等 | 人 | 每次开会话 |
| 精选核心 | `MEMORY.md`、`USER.md` | dreaming 整理，或用户直接要求 | 开会话时，来源合格、有预算才进 |
| 情节 | `memory/YYYY-MM-DD.md`、会话记录 | agent 干活时、冲刷时、记录抓取 | 只在检索时 |
| 前瞻 | standing intents、定时任务 | `intent` 工具 | 触发时 |
| 审阅 | `DREAMS.md` | dreaming | 从不进，只给人看 |

【文档】文档里写的五条设计原则（`memory-architecture.md:28-51`）：
1. 没有隐藏状态，一切都是可编辑的文件。
2. 难的是"写"，不是"检索"，所以把整理挪到后台。
3. 写入路径就是安全边界。
4. 固定规则在外，模型判断只在规则里面做。
5. 记忆坏了不阻塞回复。

### 2.2 读写记忆的工具

- 【代码】读：`memory_search`（语义加关键词）和 `memory_get`（按文件和行取片段）（`openclaw/extensions/memory-core/src/memory-tool-contract.ts:92-126`）。
- 【代码】系统提示里有一段 "Memory Recall" 指引：问题涉及以前的工作、决定、日期、人、偏好、待办，而当前上下文里没有时，才去搜；已有上下文能答就别重复检索（同文件 `:133-170`）。
- 写：**没有专门的写记忆工具**。agent 用通用的 write / edit 改文件。
  - 【文档】模板规定"被要求记住就更新每日笔记或相关文件"（`templates/AGENTS.md:71-77`）。
  - 【代码】每次写记忆文件都会被观察器记下来源等级（`openclaw/src/agents/memory-write-provenance.ts`）。
- 【文档】多人场景另有 `personal_instructions` 工具，只能改**发请求那个人**自己的 `users/<id>/USER.md`，写入目标不由模型指定（`docs/concepts/user-model.md:36-46`）。

### 2.3 检索方式

【文档】`docs/concepts/memory-search.md:140-196`、`:245-272`：
- 向量相似度、BM25 关键词、文件名三路合并。
- 再乘时间衰减（每日笔记半衰期 30 天，`MEMORY.md` / `USER.md` 不衰减）和重要度。
- 最后用 MMR（λ=0.7）去掉重复片段。
- 默认用 OpenAI 的 embedding；设 `provider: "none"` 就只用关键词。
- 中文搜不到时要重建全文索引（`:333`）。

存储默认是 SQLite，PostgreSQL 是实验性的（`docs/concepts/memory.md:152-176`）。

### 2.4 压缩前的记忆冲刷

【代码】`openclaw/extensions/memory-core/src/flush-plan.ts`：
- `:13-14`：在压缩线以下 4000 token 时触发，或会话记录超过 2 MiB 时强制触发。
- `:16-38`：提示词要求只写 `memory/YYYY-MM-DD.md`、只追加；`MEMORY.md`、`DREAMS.md`、`SOUL.md`、`AGENTS.md` 一律只读；没东西可记就回 `NO_REPLY`。

【文档】其他行为：
- 冲刷用的是会话的私有副本，这轮的内务消息不会进后续对话（`docs/concepts/memory.md:286-288`）。
- 这一轮里 `write` 只能追加新文本，整段重放会被拒（`:294-299`）。
- 冲刷失败不影响压缩（`:309-311`）。
- 32K 窗口的具体例子见 `docs/reference/session-management-compaction/housekeeping.md:49-56`。

### 2.5 什么时候自动写记忆

1. 压缩前冲刷，见上。
2. 【文档】`/new`、`/reset`、按天或闲置自动重置时，`session-memory` 钩子把上一段对话最后 15 条存成 `memory/日期-时分.md`（`openclaw/src/hooks/bundled/session-memory/HOOK.md:20-33`）。
3. 【文档】dreaming 默认开，每晚跑一次。
   - 分 light → REM → deep 三个阶段，只有 deep 写 `MEMORY.md`。
   - 门槛：分数、召回频次、查询多样性；`untrusted` 和 `system` 来源的候选直接排除，不进打分。
   - 整理结果要过结构校验，不能丢太多已有条目；用哈希做乐观锁，写之前保存改前原文，过程写进 `DREAMS.md`（`docs/concepts/memory.md:337-362`；`memory-architecture.md:172-221`）。
4. 【文档】Active Memory：只在"问的是过去的事、而规则检索没有强命中"时，才跑一个阻塞的回忆子 agent（`docs/concepts/active-memory.md:10-16`）。

### 2.6 私聊和群聊：隐私

- 【代码】群里不加载 `MEMORY.md`，见 1.2。模板也写着 MEMORY "只在主会话（和主人的私聊）加载，绝不在群里加载"（`templates/AGENTS.md:65-69`）。
- 【代码】来源分级（`openclaw/packages/memory-host-sdk/src/host/session-provenance.ts:4-24`）：
  - 用户消息：发送者是主人才算 `owner`，否则算 `untrusted`。
  - 助手消息：回复主人的那一轮算 `agent`，否则继承那一轮的等级。
  - 这一轮读过网页的（被"污染"了），算 `untrusted`。
- 【代码】agent 写记忆文件时，非主人那一轮或被污染的轮次都记成 `untrusted`（`openclaw/src/agents/agent-tools.ts:198-216`）。
- 【推断】这有个副作用：群友让 bot 往 `MEMORY.md` 里写一句，整份 `MEMORY.md` 都会被降级、不再自动注入。【文档】文档承认这是故意的："可信行搭不了不可信内容的便车"（`memory-architecture.md:119-124`）。
- 【文档】"跨会话回忆"只在同一个 agent 的私聊之间做，群和频道既不当来源也不当目标（`docs/reference/memory-config.md:43-90`）。
- 【文档】反过来，群里的动态会汇总成简短通知流进主人的主会话（`docs/concepts/main-session.md:67-75`）。所以信息是单向的：群里的事主人能知道，主人的私事不进群。
- 【推断，需复核】有两处没看到按群过滤的代码：
  - `/new` 时预加载的今天和昨天的每日笔记，代码里没见按会话类型过滤（`openclaw/src/auto-reply/reply/startup-context.ts:12-22`、`:245-255`），只标了"不可信背景"。
  - memory-core 的 `memory_search` 执行路径里没看到按私聊或群分区。`memory_search` 只在 coding 工具组里，messaging 组没有它（`openclaw/src/agents/tool-catalog.ts:148-159`）。所以群里能不能搜到主人的每日笔记，取决于这个群的工具策略，不是结构性隔离。

## 3. 多 agent、多渠道、群聊

**隔离单位是 agent。**【文档】
- 一个 agent 有自己的工作区、`agentDir`（认证、模型）和会话库（`docs/concepts/multi-agent.md:9-21`）。
- 内置记忆不跨 agent 搜。确实要共享的资料，放进显式的 `memory.search.extraPaths` 目录（`:260-268`）。
- 跨 agent 访问会话默认是**开着的**，由 `tools.agentToAgent` 管（`:218-227`）。
- agent 之间**没有个性或记忆继承**。团队预设由角色模板（`CLAW.md`）生成各自的完整身份（`:128-155`）。
- 【代码】子 agent 只拿 `AGENTS.md`，见 1.2。

**会话键。**
- 【文档】群的键是 `agent:<id>:<渠道>:group:<群id>`，私聊默认并进 `agent:<id>:main`（`docs/channels/groups.md:219-224`）。
- 【文档】`session.dmScope` 可选 `main`（默认，所有私聊共用一个会话）、`per-peer`、`per-channel-peer`（推荐给多人场景）、`per-account-channel-peer`；多人私聊不隔离会串（`docs/concepts/session.md:111-138`）。
- 【文档】`groupScope` 可以把某个可信群并进主会话（`:163-191`）。
- 文档给的模式是"一个大脑，两种执行姿态"：私聊在宿主机上用全套工具，群里进沙箱、工具受限；要人格完全分开就用第二个 agent（`groups.md:246-265`）。

**群聊行为约定。**
- 【文档】模板 `templates/AGENTS.md:83-97`："什么时候该说话，什么时候该闭嘴"、一次只回一条完整回复、表情回应最多一个。
- 【文档】默认：群要进白名单、要 @ 才回（`groups.md:18-23`）。
- 【代码】每个群的配置有 `requireMention`、`tools`、`toolsBySender`、`skills`、`allowFrom`、`systemPrompt`（`openclaw/src/channels/plugins/config-schema.ts:60-70`）。
- 【代码】系统提示里有一句 "Allowlisted != owner"（`openclaw/src/agents/system-prompt.ts:152-153`），也就是进了白名单不等于是主人。
- 【文档】按发送者限制工具只是纵深防御，挡不住同一群里别人的话影响模型（`docs/gateway/security/hardened-baseline.md:40-44`）。

**飞书渠道。**
- 【文档】官方插件 `@openclaw/feishu`，支持私聊、群、流式卡片和文档 / 知识库 / 多维表格工具，默认走 WebSocket（`docs/channels/feishu.md:9-11`）。
- 【文档】多账号，即多个机器人（`docs/channels/feishu/advanced-configuration.md:16-47`）。
- 【文档】`groupSessionScope` 可选 `group`、`group_sender`、`group_topic`、`group_topic_sender`（`:101-114`）。
- 【文档】`bindings` 把指定私聊或群路由到不同 agent（`:212-252`）。
- 【文档】`dynamicAgentCreation` 给每个私聊用户自动建一个独立的 agent 和工作区（`dynamic-agents.md:10-20`）。
- 【代码】每个群的 `systemPrompt` 作为 `groupSystemPrompt` 进入站上下文（`openclaw/extensions/feishu/src/bot.ts:1279-1281`）；飞书去掉了 `toolsBySender`（`openclaw/extensions/feishu/src/config-schema.ts:216-222`）。
- 【推断】这个 `groupSystemPrompt` 最终渲染成 "## Conversation Context" 段（`system-prompt.ts:915-919`），相当于 vonvon 的"群 SOUL"，不过它是配置字符串，不是文件。

## 4. 界面

- **文件编辑器**：【代码】`ui/src/pages/agents/panels-files.tsx:225-372`。
  - 标题 "Core Files — Bootstrap persona, identity, and tool guidance"（`ui/src/i18n/locales/en-settings.ts:186-187`）。
  - 每个文件一个标签页：AGENTS / SOUL / USER / MEMORY，孵化前还有 BOOTSTRAP；`IDENTITY.md` 不放标签页，改走身份表单（`agents-files.ts:40-47`）。
  - USER、MEMORY 不存在时出现在"Add file…"下拉里，保存即创建（`en-settings.ts:199-201`）。
  - 文本框加 Markdown 预览，有 Save、Reset；冲突时提示"重新加载 / 覆盖"（`:206`）。
  - **每日笔记不在编辑器里**：只接受固定文件名，见 1.3。
- **身份表单**：名字、emoji、头像（可以生成头像），保存时写回 `IDENTITY.md`（`ui/src/pages/agents/agent-identity-editor.ts:117-151`）。
- **记忆和 Dreams 面板**：【代码】`ui/src/pages/agents/memory/`，三个页签（`ui/src/i18n/locales/en-dreaming.ts:4-170`）：
  - Scene：总开关、各阶段状态、补录、去重。
  - Diary：`DREAMS.md` 的叙事日记。
  - Advanced：从每日笔记来的候选、等待晋升的、最近晋升的。
  - 另有 Memory Wiki、导入洞察。
  - dreaming 开关是全局的，弹窗会写明影响所有 agent。
- **个人偏好**：多人网关里，Settings → Profile → Personal instructions 编辑自己的 `USER.md`（`docs/concepts/user-model.md:30-35`）。
- **本轮注入了什么**：【文档】`/context list` 列出每个文件的原始和注入后大小、有没有截断、技能列表、工具 schema 的开销（`docs/concepts/context.md:68-92`）。
- **导入记忆**：Settings → Import Memory，从 Codex、Claude Code、Hermes 导入 Markdown 记忆，单独放进 `memory/imports/` 供检索，不并进 `MEMORY.md`（`docs/concepts/memory.md:69-98`）。
- **macOS app**：菜单栏伴随程序，窗口里嵌的就是这个网页控制台（`docs/platforms/macos.md:10-12`）。

## 5. 对 vonvon：可借鉴的和不该照搬的

vonvon 现状（读 dev 文档确认）：
- 文件布局：`bots/<appId>/SOUL.md`、`AGENTS.md`、`memory/shared.md`、`memory/dm/<id>/dm.md`、`groups/<chatId>/SOUL.md`、`memory/group.md`（`docs/product.md:107-119`）。
- 注入顺序：固定红线 → 身份行 → bot SOUL / AGENTS → 群 SOUL → 记忆（`docs/product.md:392-397`）。
- 三份记忆，"群里能用 bot 的人都能写本群记忆"（`docs/product.md:399-405`）。
- 第一版不做后台整理（`docs/product.md:408`）。

### 5.1 值得借鉴

1. **"这些来源是什么"要能直接看到。**
   - 借 `/context list` 的做法：群详情页和 Bot 页加一块"这一轮交给模型的东西"，逐项列出固定约定、身份行、bot SOUL、AGENTS、群 SOUL、哪份记忆，各自的字数和版本，标明空或缺失。
   - owner 说"个性和记忆都是空的"，空也应该明说"空，点这里写"，而不是什么都不显示。【推断】
2. **固定文件、标签页编辑，加冲突检测。**
   - OpenClaw 每个文件一个标签页、预览、Save / Reset、`expectedHash` 冲突提示，正好对得上 vonvon 已经定的"实际版本、不静默截断"。
   - 每日笔记不放进编辑器，是为了降低复杂度。
3. **首次孵化。**
   - 新建 bot 后，第一次私聊主人时，问名字或者确认飞书名、要一句气质、写进 SOUL；用户的请求优先，仪式不挡路（`templates/BOOTSTRAP.md:14-36`）。
   - 这能直接解决"个性是空的"。vonvon 可以改成：桌面端给 3 到 4 个个性模板一键选，私聊里再微调。【推断】
4. **USER.md 的"指令 + 观察日期 + active / superseded"格式。** 适合 vonvon 的私聊记忆和公共记忆，解决"偏好改了，旧条还在"的问题（`docs/concepts/user-model.md:385-430`）。
5. **来源分级。**
   - vonvon 的本群记忆谁都能写。可以借鉴的是"每条记下是谁写的"：主人或管理员写的算可信，群友写的标出来源。
   - 群友写的条目不自动晋升到公共记忆；主人在桌面端审阅后才能"提升为公共"。
   - 这比 OpenClaw 那种整份降级更适合多人群。【推断】
6. **压缩前冲刷。** vonvon 已经在压缩后重新交全文；可以在压缩前加一轮"把要记的写进本群或私聊记忆"，并且限定只追加。【推断】
7. **后台整理要有审阅面。** 以后做自动整理，就照 `DREAMS.md` 的做法：保存改前原文，写变更摘要，用乐观锁，失败退回只追加。
8. **Codex 指令刷新。** OpenClaw 证实了 resume 时传 `developerInstructions` 不生效，和 vonvon 实测一致。它用"冷恢复"重新交，vonvon 用"设置更新"块。两条路都可行，可以把 OpenClaw 的冷恢复作为备选再测一次。

### 5.2 不该照搬

1. **agent 自改 SOUL.md。**
   - OpenClaw 的前提是一人一个助手；vonvon 的 bot 在多人群里，任何人都能驱动它。
   - 建议 SOUL 和 AGENTS 只能由主人或管理员改，在桌面端改，或在开了"聊天改设置"的私聊里改；bot 最多"提议修改"，由主人点确认。
   - OpenClaw 只靠一句"改了告诉用户"，这不是保障。
2. **整份降级。** 群友一写，整份就不再注入，在多人群里等于让群记忆失效。vonvon 应该按条记来源，不按文件降级。
3. **"一个大脑"加一个工作区一份 `MEMORY.md`。** vonvon 是 bot × 群的矩阵，现在按群、私聊、公共分区，比 OpenClaw 更细，不要退回去。
4. **群里能搜到每日笔记，和 `/new` 预加载每日笔记。** 第 2.6 节怀疑 OpenClaw 这里没做结构隔离。vonvon 要坚持"daemon 只给这一份文件"。
5. **dreaming、向量检索、embedding 依赖。** SQLite 打分、REM 和 deep 阶段、默认 OpenAI embedding，对 v1 来说太重。vonvon 的记忆每份有字数上限、整份注入，不需要检索。等记忆量上来再考虑只用关键词的检索。
6. **每个 agent 一个 `codex-home`、每个用户动态建 agent。** 和 vonvon"不换 `CODEX_HOME`、不重新登录"的决定冲突。

### 5.3 bot 继承不继承记忆和个性

OpenClaw 的答案是**不继承**：
- 每个 agent 的工作区独立，子 agent 只拿 AGENTS。
- 要共享就显式放进共享资料目录（`extraPaths`）。
- 同一个 agent 的不同群共用 SOUL 和 USER，但群里拿不到 MEMORY。

对 vonvon 的建议【推断】：
- 群个性继承 bot 个性，并在其上补充（现状如此）。
- 公共记忆在 bot 级继承到所有群和私聊（现状如此）。
- bot 之间不继承。真要共享，加一个只读的"本机共享资料"，由主人显式挂到 bot 上。
- 界面上用"继承自 bot / 本群补充"两栏显示，回答 owner"以什么身份、来源是什么"。