# R4：Letta、mem0、LangMem 的记忆设计（源码调研）

标注说明：【码】表示读代码或官方文档确认过，【推】表示我的推断或建议。本仓库路径都相对于 dev-read（9b113b6）。

## 0. 读的版本
- **Letta**：`letta-ai/letta` 的 main 只剩一个落地页。README 写明现行源码在 `letta-ai/letta-code`（letta/README.md:7），旧的 V1 服务端只留在 `archive` 分支。所以我以 letta-code（6c8b08f，2026-10-22）为主。经典的 memory block、sleep-time 服务端定义只能从 archive（56ba9c2）里读，下文标"历史版"。这两份浅克隆放在 mktemp 目录里，读完已按删除规矩删掉。
- **mem0**：读的是给定的克隆（2c81af3）。OpenMemory 已经从主仓库删掉（docs/docs.json:1183-1193 把 `/openmemory/*` 重定向到首页），所以另外读了 v1.0.9 标签（b8a5ca1，2026-03）里的 `openmemory/`。
- **LangMem**：读的是给定的克隆（48e3c11）。

## 1. vonvon 现在怎么做（对照用）
- 个性和记忆各是一整块文本：
  - Bot 级：persona 由 SOUL.md 加 AGENTS.md 拼成，公共记忆存在 `memory/shared.md`。
  - 群级：各一段文本，外加两个继承开关。
  - 组合时直接拼接（`packages/daemon/src/bot/group-profile.ts:26-29,79-89`），每段上限 30000 字（同文件:9）。
- 没有条目、没有来源、没有历史。bot 自己写记忆的 s40 还没做（`docs/v1-plan.md:1245-1248`，s38 未勾）。从 bridge 迁移过来的 bot，个性和记忆导入后本来就是空的（`docs/product.md:715`）。所以面板只能显示两个空输入框【码】。
- 产品定义让 agent 直接改整份 `group.md`/`dm.md`。为了处理并发，不得不设计"监视文件 + diff3 三方合并 + 撤销连带"（`docs/product.md:418-435`）【码】。

## 2. Letta

### 2.1 数据模型
- **历史版的 block**：
  - 字段有 `label/value/limit/description/read_only/metadata/tags`，`limit` 默认 100000 字符。另外记录 `created_by_id/last_updated_by_id`（letta@archive/letta/schemas/block.py:19-41,73-77；constants.py:435）。
  - 官方文档说 `description` 是"agent 用来决定怎么读写这块的主要信息"；同一个 block 用 `block_ids` 挂到多个 agent，用 `blocks.agents.list` 查谁在用，并发写是 last-write-wins（docs.letta.com/guides/agents/memory-blocks）【码】。
- **现行 Letta Code 把 block 变成了 git 仓库里的 Markdown 文件，叫 MemFS**：
  - 新 agent 仍然只有 `persona` 和 `human` 两块（letta-code/src/agent/memory.ts:16）。human 的初始文本是 "I haven't gotten to know this person yet"（src/agent/prompts/human.mdx）。
  - v2 布局：根目录下的 `.md` 每轮都在提示词里（core）；`MEMORY.md` 是根索引；子目录要有自己的 `MEMORY.md` 才算记忆，按需读取（deferred）（src/agent/memory-format.ts:10-21；src/backend/local/system-prompt-compilation.ts:154-199）。
  - frontmatter 在 v2 只允许 `name/description`，v1 允许 `description/read_only/limit`。`read_only` 是受保护字段，agent 不能设、不能改、不能删（src/memory-frontmatter.ts:63-120）。
  - 容量由 `.memfs.config.json` 限制，包括 `maxFileCharacters`（默认 2 万）、`maxCoreMemoryCharacters`、`readOnlyFiles`，由 pre-commit hook 强制（src/memory-constraints.ts:11-19；src/skills/builtin/maintaining-deferred-memory/SKILL.md）【码】。

### 2.2 三层记忆
系统提示词里分三层（src/agent/prompts/letta.md:12,26-41）【码】：
- recall：全部消息历史，自动存，不可修改；
- memory blocks：提示词里可以编辑的段；
- external：skill（程序性记忆）、普通文件和共享记忆。

历史版的 archival 是向量库加 `archival_memory_insert/search`（archive base.py:164-194）。现行版用"deferred 文件 + recall 搜索子 agent"取代了它。

### 2.3 写入
- **历史版的热路径工具**：`core_memory_append/replace`、`memory_replace`、`memory_insert`、`memory_rethink`，还有一个综合的 `memory` 工具（archive base.py:10,246-520）。
- **历史版开了 sleep-time 以后**：
  - 对话 agent 只剩 `send_message`、`conversation_search`、`archival_memory_search` 三个工具；
  - 改记忆的工具全部交给后台的 sleep-time agent（`memory_replace/insert/rethink/finish_edits`），频率由 `sleeptime_agent_frequency` 控制（archive constants.py:132-143；schemas/group.py:43）【码】；
  - 这是"前台只读、后台整理"的彻底分工。
- **现行版改成文件加 git**：
  - memory 工具已经删掉（src/tools/removed-tools.ts:13-14），agent 用 Bash/Edit 改文件，再 `git commit`；
  - 提示词只从已提交的版本编译，"改记忆不影响本轮，下次重编译才生效"（letta.md:56；system-prompt-compilation.ts:65-81）。
- **现行版的后台整理叫 reflection / dreaming**：
  - 触发方式有 `off`、`step-count`、`compaction-event` 三种，合并方式有 `auto`、`explicit` 两种（src/reflection-settings.ts:1-18；src/cli/helpers/post-turn-reflection.ts:50-80）；
  - 反思子 agent 在私有 worktree 里改，由 harness 合回主 checkout（letta.md:62）；
  - 优先级依次是：错误和纠正、偏好、新事实、矛盾、可复用的流程。一次性的状态不记，相对日期改写成绝对日期（src/agent/subagents/builtin/reflection-v2.md:29-37）；
  - 提交作者固定写 "Reflection Subagent"，正文列出看过的对话记录和每条改动的理由（同文件:54-68）。也就是说，提交历史就是来源记录【码】。

### 2.4 共享
现行版有组织级的"shared memory 仓库"（src/cli/subcommands/shared-memory.ts:14-27,53-80；src/skills/builtin/managing-shared-memory/SKILL.md:34,85）【码】：
- 支持 `attach/detach/history`；
- 每个 agent 有自己的挂载点，别的 agent 的挂载被隔开；
- 每轮结束后推送，冲突时 rebase 重试一次，脏文件不自动处理。

### 2.5 用户怎么看、怎么改
- `/memory`、`/palace` 打开一个只读的"记忆宫殿"网页：文件树，最多 500 条提交，最近 50 条带 diff（src/cli/commands/registry.ts:130-147；src/cli/app/command-routing.ts:42；src/web/generate-memory-viewer.ts:41-44）。要改，只能让 agent 改，或者人直接用 git。
- 历史版有 BlockHistory（archive services/block_manager.py:842-905,952,1004）【码】：
  - 每次 checkpoint 记一个 `sequence_number` 和 `actor_type`（是 agent 改的还是 user 改的）；
  - 支持线性的撤销和重做；
  - 用版本列做乐观并发。

### 2.6 对 vonvon 的启示【推】
- persona 和 human 两块，正好对应 owner 问的"个性"和"关于主人"。
- 每块带一句 description 说明这块干什么，值得照搬。
- "前台不改、后台改"，以及用"提交者 + 理由"记来源，都可以借。
- 不足：Letta 的单位是整块文本，条目级的来源要靠 git diff 才看得出，普通用户看不懂。

## 3. mem0

### 3.1 add() 管线
- **现行 OSS 的 `add()` 已经不是 ADD/UPDATE/DELETE/NONE 四选一了**：代码注释写 `V3 PHASED BATCH PIPELINE`（mem0/memory/main.py:918），文档写 "single-pass ADD-only extraction: one LLM call, no UPDATE/DELETE… nothing is overwritten"（docs/api-reference/memory/add-memories.mdx:7）【码】。
- **流程**（main.py:918-1100）：
  1. 取本会话最近 10 条消息；
  2. 向量检索已有记忆的前 10 条，并把 UUID 换成 "0"、"1"……，防止模型编造 id；
  3. 调一次 LLM 抽取，用 `ADDITIVE_EXTRACTION_PROMPT`（mem0/configs/prompts.py:468 起）。提示词要求按"观察日期"把相对时间落成绝对日期，标注 `attributed_to`（user 还是 assistant），并给出 `linked_memory_ids`；
  4. 批量嵌入；
  5. 用 md5 哈希去重；
  6. 批量写入，同时写 ADD 历史；
  7. 实体抽取和链接。
- **题目里说的四操作提示词**：`DEFAULT_UPDATE_MEMORY_PROMPT`（prompts.py:176）和 `get_update_memory_messages`（prompts.py:406）都还在，但在 mem0 包里已经没有调用方（全包 grep）【码】。
- **两个细节**：
  - 模型给的 `linked_memory_ids` 在 OSS 里没有存进记忆本身，只存了 `attributed_to`（main.py:1038-1039）；
  - `infer=False` 时逐条原样写入（main.py:881-916）。
- **矛盾和重复交给平台版的 "Dream"**（docs/platform/features/dream.mdx:33,55,60-70,143），都不破坏原数据：
  - Supersede：旧事实标成 superseded，链到新事实，默认仍然可见；
  - Merge：重复项标成 merged，默认隐藏但保留；
  - Synthesis：一个用户攒够 20 条以后定期生成"模式记忆"，链回证据，只处理纯 `user_id` 范围的记忆。

### 3.2 作用域
- 写入时 `user_id/agent_id/run_id` 至少要给一个（main.py:314-405）。调用方在 metadata 里夹带的这些键会被剥掉，防止记忆被写进没请求的范围（main.py:143 `_strip_identity_keys`）【码】。
- 查询按传了的键做 AND 过滤，没传的键不限制（docs/platform/features/entity-scoped-memory.mdx:43）。
- **平台版的一个坑**：按说话人拆归属。user 说的只带 `user_id`，assistant 说的只带 `agent_id`，所以用 user AND agent 查会查不到（同文件:80-84）。OSS 则把传入的 id 都写上（main.py:1007-1045）。
- **群聊**：消息上的 `name` 字段不改变归属，要按人分开存，就得每人调一次 add（docs/platform/features/group-chat.mdx:17,68）【码】。

### 3.3 历史和分类
- **历史**：
  - SQLite 的 `history` 表字段为 `memory_id, old_memory, new_memory, event, created_at, updated_at, is_deleted, actor_id, role`（mem0/memory/storage.py:108-119）；
  - ADD、UPDATE、DELETE 都会写（main.py:1078-1098,2052-2142），用 `history(memory_id)` 读（main.py:1960）。
- **分类**：OSS 核心里没有。OpenMemory 在每次插入、更新后调 gpt-4o-mini 打分类，给 20 个预设，也允许模型自造（mem0@v1.0.9/openmemory/api/app/models.py:190-243；utils/categorization.py:27-31；utils/prompts.py:1-30）【码】。

### 3.4 OpenMemory
- **数据模型**（models.py:30-188）【码】：
  - `App`：同一个主人下按名字唯一，`is_active` 就是暂停开关；
  - `Memory`：`app_id` 就是来源 app，`state` 取值 active/paused/archived/deleted，另有 `archived_at/deleted_at`；
  - `Category`：和记忆多对多；
  - `AccessControl`：subject 是 app，object 是 memory，effect 是 allow 或 deny；
  - `ArchivePolicy`；
  - `MemoryStatusHistory`：谁把状态从什么改成了什么；
  - `MemoryAccessLog`：哪个 app 在什么时候、以什么方式读过。
- **MCP 怎么用**：
  - 入口是 `/{client_name}/sse/{user_id}`，`client_name` 就是 app（mcp_server.py:435）；
  - 写入时，暂停的 app 被拒写，`mcp_client` 写进 metadata（mcp_server.py:83-95）；
  - 搜索时对这个用户的全部记忆做向量检索，再按 ACL 过滤，每条命中记一条访问日志（mcp_server.py:169-215）；
  - 所以默认是跨 app 全共享，ACL 只能往小收。
- **ACL 的实际情况**：
  - 规则语义：没有规则就全可读；allow 不指定对象就全可读；deny 不指定对象就全不可读（routers/memories.py:60-97）；
  - 但是整个仓库没有任何创建 `AccessControl` 的接口，只有类定义（grep）【码】；
  - 真正能用的控制是暂停 app 和改记忆状态。`/actions/pause` 可以全局暂停、按 app、按条、按分类暂停（memories.py:415-485）。
- **UI**：记忆表格列出内容、分类、来源 App、创建时间，每行有暂停、归档、编辑、删除（ui/app/memories/components/MemoryTable.tsx:140-151,227,253-291）。详情页有访问日志和相关记忆。
- **两个缺陷**【码】：
  - 编辑接口 `PUT /memories/{id}` 只改 SQL 里的 content（memories.py:517-530），而搜索读的是向量库里的 payload，所以改完以后 agent 搜到的还是旧文本；
  - `MemoryStatusHistory` 只记状态变化，不记内容改动。
- **教训**【推】：一条记忆只能有一个真相源。人改和 agent 改要走同一条写入路径，而且都进历史。

### 3.5 对 vonvon 的启示【推】
- 条目化、每条带来源 app、有状态机（暂停、归档）、有访问日志，正是 owner 要的"显式显示、用户可改"。
- 但 mem0 默认全共享，作用域又靠调用方自觉传 id，这不适合有隐私边界的飞书群。

## 4. LangMem
- **三种记忆**（docs/docs/concepts/conceptual_guide.md:26-28,105-108,177）【码】：
  - semantic：事实，存成 profile 或 collection；
  - episodic：成功的经历，存成 collection；
  - procedural：行为规则，放在提示词里。
  - profile 是一份按 schema 写的"当前状态"文档，新信息来了就更新它；collection 是条数不限的条目，需要检索和合并。文档明说 profile "容易拿给用户手改"。
- **namespace**：
  - 是一个元组模板，store manager 的默认值是 `("memories", "{langgraph_user_id}")`（src/langmem/knowledge/extraction.py:1678）；也支持 `("org","{user_id}","code_assistant")` 这样的多级（conceptual_guide.md:360-376）；
  - 占位符在运行时从 config 填；
  - 工具和管理器在创建时就绑定了 namespace，模型选不了写到哪里（knowledge/tools.py:25-38）【码】。
- **hot path（前台写）**：
  - `create_manage_memory_tool` 给 agent 增、改、删三个动作，可以用 `actions_permitted` 收窄。默认说明是"发现新偏好、被要求记住、或发现旧记忆过时，就调用"（tools.py:25-38）；
  - 配套有 `create_search_memory_tool`（tools.py:362）；
  - 文档承认它会增加延迟，也会让 agent 分心（conceptual_guide.md:316-318）。
- **background（后台写）**：
  - `create_memory_store_manager` 先检索已有记忆（可以让模型并行生成查询）；
  - 然后 `MemoryManager` 多步抽取，可用的工具有插入、patch、删除（删除默认关）和 `Done`，可以再接多个阶段，最后统一 put 或 delete（extraction.py:217-226,1000-1090,1230-1281）；
  - 提示词要求给不确定的内容标置信度 p(x)，并压缩冗余（extraction.py:185-207）；
  - `ReflectionExecutor` 按 thread 去抖：同一个 thread 的新提交会取消还没开始的旧任务（src/langmem/reflection.py:254-330，取消在 311 行）。配上 `after_seconds`，就是"安静 N 秒以后再整理"。
- **历史**：store manager 的文档字符串写着 "maintains a versioned history of all changes"（extraction.py:1685），但代码是直接覆盖 put 和 delete，没有历史（extraction.py:1244-1281）【码】。
- **程序性记忆（prompt optimizer）**：
  - 数据结构是 `Prompt{name, prompt, update_instructions, when_to_update}`（prompts/types.py:7-33）；
  - 优化器有 `gradient/metaprompt/prompt_memory` 三种（prompts/optimization.py:23），多提示词版是 `create_multi_prompt_optimizer`（:471）；
  - 输出只是一段新提示词，存不存、谁批准，由开发者决定。
- **对 vonvon 的启示**【推】：
  - namespace 由运行时决定、模型不能选，是群隔离最需要的性质；
  - "安静一段时间再整理"适合群聊；
  - 改个性应该走"建议，再由主人确认"，不让模型直接改 SOUL。

## 5. 三者对比
| | Letta（现行 Letta Code） | mem0（OSS V3 + OpenMemory） | LangMem |
|---|---|---|---|
| 记忆单位 | 带 description 的 Markdown 块，分常驻和按需 | 一句话一条事实 | profile 文档或条目，schema 自定 |
| 怎么进提示词 | core 块每轮整块常驻 | 每次检索前几条 | 开发者自己决定 |
| 前台写 | agent 改文件加 commit（历史版用 memory_* 工具） | 应用调 add | manage_memory 工具 |
| 后台写 | reflection 子 agent，按步数或上下文压缩触发 | 每次 add 都是一次抽取；平台版有 Dream 整理 | store manager 加去抖执行器 |
| 冲突和重复 | LLM 整理加 git 合并 | 哈希去重；平台版 supersede/merge | LLM patch 或删除 |
| 历史 | git 提交（历史版 BlockHistory 可撤销） | history 表：旧值、新值、事件、actor | 没有（文档说有） |
| 来源 | 提交作者加正文理由 | `actor_id/role/attributed_to`；OpenMemory 有来源 app 和访问日志 | 没有 |
| 作用域 | 每个 agent 一个仓库，可挂共享仓库 | user/agent/run（平台加 app），AND 过滤 | namespace 元组模板 |
| 多 agent 共享 | 同一个 block 或共享仓库挂到多个 agent | 同一个 `user_id` 天然共享 | 同一个 namespace 就共享 |
| 用户可见可改 | 只读网页（带 diff） | 表格：分类、来源、暂停、归档、编辑、删除 | 没有 UI |

## 6. 给 vonvon 的作用域建议【推】
场景是：一个 bot 进多个群，群里有外人；多个 bot 共一个主人。约束是：A 群的东西不进 B 群（`docs/product.md:407`），而且主人要看得懂、改得动。

我建议用"固定的范围键，读的时候组合"，不学 mem0 那种任意 id 组合。分五档：

1. **`owner`：关于主人**（相当于 Letta 的 human 块）
   - 所有 bot 都能读。默认只进主人的私聊和主人勾选的群，因为群里有外人。
   - 只有主人能改，bot 只能提议。
   - 这回答了 owner"bot 是否继承记忆"的问题：关于主人的事实跨 bot 共享，类似 Letta 把一个 block 挂到多个 agent。
2. **`bot`：bot 个性和 bot 公共记忆**
   - 所有群和私聊都能读。
   - 只有主人和管理员能写。bot 在某个群里学到、想升格成公共记忆的内容，要主人点"推广"，并留一条链接回原条目。
3. **`bot×群`：本群记忆和本群个性补充**
   - 只在这个群的会话里读写。
   - 群成员说"记住"，或者 bot 自己判断要记，都写进这一档。
4. **`bot×私聊人`：私聊记忆**。
5. **可选，以后再做：`群×全部 bot` 的群共享记忆**。第一版维持 `docs/product.md:407` 的"同群几个 bot 不共享"。

配套规则：
- **范围由 daemon 按当前会话填，模型不能选**（参照 LangMem 的 namespace 模板和 mem0 的 `_strip_identity_keys`）。agent 只能写当前会话最窄的那一档。
- **继承在读的时候组合，不复制**：今天的 `readGroupPersonality` 已经这样做，保留。但要把"整块继承开关"改成条目级：群页面逐条列出继承下来的内容，每条可以单独设"本群不用"，只对这个群生效，类似 OpenMemory 的按条暂停。
- **前台写记忆改走 vonvon 自己的 MCP 工具**（比如 `remember/update/forget`，范围由 daemon 绑定），不再让 agent 直接改 `group.md`。
  - 好处：每次写入都是一个带来源的事件，`docs/product.md:418-435` 那套监视文件加三方合并，可以简化成对条目的串行写入加乐观并发（参照 Letta BlockHistory 的版本列）。
  - 代价：依赖能力包里的 MCP（`docs/product.md:460` 已规划），而且 Codex 和 Claude 都要能在会话里可靠地调用它。
  - 这一条和 s40"agent 直接写记忆文件"的计划冲突，需要 owner 来定。
- **后台整理第一版只出建议，不自动改**：比如"这两条可以合并""这条过时了""这条可以升格"，主人在面板里点确认（`docs/product.md:408` 写明第一版不做后台自动整理）。以后可以参照 Letta 的 reflection 和 LangMem 的去抖，在群安静 N 分钟后跑一次。

## 7. 最小数据结构【推】

**`MemoryItem`（一条记忆）**：
- `id`：ULID。
- `scope`：`{kind:'owner'|'bot'|'group'|'dm', botAppId?, chatId?, openId?}`，由 daemon 填。
- `type`：`persona`（个性和规矩，属于程序性记忆）、`fact`、`preference`，可选 `episode`。
- `text`：一条一句或一小段，单条有上限，比如 500 字。
- `category`：可选标签，面板按它分文件夹，参照 Today 记忆面板的截图（缪斯的角色设定、关于卡尔、Work、Preferences……）和 OpenMemory 的分类。
- `state`：`active | paused | archived | superseded | deleted`。删除留墓碑，方便撤销和审计。
- `supersededBy?` / `mergedInto?`：指向替代它的新条目（参照 mem0 Dream）。
- `source`：`{via:'owner_ui'|'chat_command'|'member_remember'|'bot_hot_path'|'bot_reflection'|'import', actorOpenId?, botAppId, chatId?, messageId?, sessionId?, turnId?}`。界面上显示成"本群·某成员说'记住'""bot 自己记的""主人在桌面端改的"。
- `evidence?`：触发这条记忆的消息摘录或链接（参照 Letta 反思提交里列出的对话、mem0 模式记忆链回的证据）。
- `createdAt`、`updatedAt`、`revision`（整数，做乐观并发）。
- `exclusions?`：`chatId[]`，表示继承下来、但在这些群里不用。

**`MemoryEvent`（只追加的历史）**：
- `id`、`itemId`、`seq`。
- `op`：`add | update | state | restore | promote | merge`。
- `before`、`after`：`{text, state, category}` 的快照。
- `actor`：和 `source` 同一个形状。
- `at`、`turnId?`、`receiptCardId?`（卡片上的［撤销］按它回滚）、`undoOf?`。

**存储方式**：
- 放在 `bots/<appId>/` 下由 daemon 独占的 SQLite 或 JSONL 里，agent 读不到原文件。
- 会话拿到的是 daemon 渲染好的"背景资料，不是指令"块，版本 hash 照旧按渲染结果计算（group-profile.ts:90）。
- 旧的 `SOUL.md`、`shared.md` 导入时按段拆成条目，标 `via:'import'`，原文件保留（`docs/product.md:75` 要求"不丢旧内容"）。