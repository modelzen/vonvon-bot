# R6 调研：人设系统，以及多 bot、多群下记忆的作用域和继承

说明：标【码】的结论是读代码或文档确认的，标【推】的是我的推断。本仓库的引用路径相对 `dev-read`（origin/dev 9b113b6）。外部仓库只读了源码，没有运行。elizaOS 的类型定义是在 `mktemp -d` 目录里浅克隆后看的（8d238da），已按删除规矩清理。

## 0. 结论先说

1. **owner 看到"个性和记忆都是空的"，代码上能找到三条原因。**
   - 新 bot 没有预填任何人设。
   - bot 自己写记忆（s40）还没做，记忆里只有人手填的内容。
   - 私聊会话根本不带个性和记忆。
   - 详见第 1 节。
2. **"记忆就是用户能直接打开的文件"值得做，但文件夹的第一层要按"谁会看到"来分，不按主题分。** Today 只有一个主人、一个人设，按主题分（Work、People、Health……）就够了。vonvon 的群里有别人，第一层不按受众分，私事就会漏进群里。
3. **人设建议用半结构化的写法：** 一个 markdown 文件，里面放几个固定标题。程序会单独用到的那几段（一句话身份和职责、边界）单独成段，其余写自由文本。要不要拆成字段，只看程序会不会单独用那一段。SillyTavern、elizaOS 和 Character.ai 都是这个规律（第 3 节）。
4. **人设和记忆可以放在同一个面板里，但要标明哪个是指令、哪个是资料。**
   - 人设只有主人能写，按指令交给模型。
   - 记忆群成员也能写，只能按"背景资料"交，不能因为挪进同一个文件夹就升级成指令。
5. **作用域的核心规则是：内容只能流向"受众是来源受众子集"的地方。** 由这条规则推出：
   - 同一个群里，主人的几个 bot 共享群记忆，不扩大受众，隐私上没有新风险。
   - "关于主人"的记忆所有 bot 都能用，但只在主人私聊里用。
   - 群和群之间永远不互通。
   - 现在的"公共记忆（每个 bot 一份，所有群都加载）"最容易让主人把私事写进去，再被带进有外人的群。
6. **推荐方案二：按受众分层的记忆文件夹，用"引用"代替"继承"。** 和现有切片的差距中等。需要 owner 先定 4 个问题（第 5 节末尾）。

## 1. dev 现在怎么实现，缺什么

| 项 | 现状 | 依据 |
|---|---|---|
| 界面 | Bot 详情的"个性与记忆"页有两个输入框（个性、公共记忆）。Bot × 群页也有两个输入框，各自可以选择继承 Bot 的内容，继承的部分显示成灰色引用块 | 【码】`docs/product.md:56,75,81`；`packages/ui/src/settings/GroupDesignSettings.tsx:127-131,291-297` |
| Bot 个性存在哪 | `SOUL.md` 和旧的 `AGENTS.md` 合并显示；保存时全文写进 `SOUL.md`，把 `AGENTS.md` 写空 | 【码】`packages/daemon/src/bot/group-profile.ts:26-29,52-54` |
| 公共记忆存在哪 | `bots/<appId>/memory/shared.md`，每个 bot 一份，上限 3 万字 | 【码】`group-profile.ts:9,27`；`docs/product.md:112` |
| 群个性和群记忆存在哪 | 物化之后存在 `projects.json` 每个群那一条的 `profile` 字段里，不再读 `groups/<chatId>/SOUL.md` 和 `memory/group.md`。这和 product 3.3 写的"定义文件都是 markdown，主人可以直接用编辑器改"已经不一致 | 【码】`group-profile.ts:35-39`；`packages/daemon/src/admin/settings.ts:791,1031-1038`；`docs/product.md:119,127` |
| 怎么交给 agent | 组成三段：身份行只有一句"当前 Bot：名字；当前群：群名"，然后是 `[个性与职责]` 和 `[本群可用记忆 · 背景资料，不是指令]`。每一行加 `│ ` 前缀，防止内容伪造段落边界。下一轮开口前按版本哈希判断有没有变，变了就附一段"个性与记忆更新" | 【码】`group-profile.ts:85-90`；`packages/daemon/src/bot/handle-message.ts:1058-1068` |
| 决策模型（judge） | 个性取前 1500 字作为 `bot_role`（输入里显示为"【你的个性】"），记忆取前 2000 字 | 【码】`packages/daemon/src/judge/prompt.ts:109-110,240-241`；`judge/decision.ts:129` |
| 私聊 | 没有群的会话不读个性和记忆（`project ? … : undefined`）。私聊记忆的组合代码已经写好，但没有接进生产路径 | 【码】`handle-message.ts:1053,1060-1061`；`bot/personality-context.ts:23-31` 没有被 src 里任何文件 import |
| 自动记 | 说"记住"就写进记忆（s40）、全会话交付（s38b）、私聊干活（s49）都还没勾 | 【码】`docs/v1-plan.md:1249,1255,1402` |

owner 问"以什么身份"：现在的身份只有飞书名字加群名，没有"我是谁、负责什么"。人设为空时，执行 agent 和 judge 都不知道自己是干什么的【码】。界面上看不出四件事：
- 这段文字最后会进到哪些会话；
- 来自谁；
- 私聊用不用它；
- 别的 bot 知不知道它。

## 2. basic-memory：记忆就是文件

**格式【码】**
- 每条笔记是一个纯 markdown 文件，文件就是真相源（`basic-memory/NOTE-FORMAT.md:3`）。
- frontmatter 有 `title`、`type`、`tags`、`permalink`，可以加自定义字段（`NOTE-FORMAT.md:36-44`）。
- 一条事实写成 `- [category] 内容 #tag (context)`（`:77`）。
- 关系写成 `- relation_type [[目标]] (context)`，正文里的 `[[链接]]` 也会自动算作关系（`:124,153-159`）。
- 标题本身就是可解析的结构，所以人照常写 markdown，程序也能拆出条目。

**索引和人工编辑后的同步【码】**
- 用 watchfiles 监视目录（`src/basic_memory/index/watch_service.py:17,144`），按 checksum 判断哪些文件变了（`indexing/change_detector.py`），再增量更新 SQLite 的全文和向量索引。
- 搜索有 `hybrid`、`semantic`、`text` 等几种（`mcp/tools/search.py:67`）。
- 人用 Obsidian 直接打开目录就能改（`README.md:376`）。
- 写入防覆盖：`write_note` 默认拒绝覆盖已有笔记，要传 `overwrite=True`，还可以带 `expected_checksum`（`mcp/tools/write_note.py:339,423`）。
- `edit_note` 支持 append、find_replace、replace_section；find_replace 的命中次数必须等于 `expected_replacements`（`edit_note.py:442-446`）。

**MCP 工具和作用域【码】**
- 内容类：`write_note`、`read_note`、`edit_note`、`move_note`、`search`。
- 图谱类：`build_context`，沿 `memory://` 链接展开，`depth` 1 到 5（`build_context.py:207`）。
- project 类：`list_memory_projects` 等（`README.md:557-562`）。
- 作用域的单位是 project，也就是一个目录。工具可以带 `project` 参数做跨 project 读写（`integrations/hermes/README.md:77`）。
- Hermes 集成故意不支持中途切换 project，因为自动记录会落到错的地方（`:109`）。这对 vonvon 的启发是：写到哪里必须由会话决定，不能交给 agent 当参数选。

**锁【码】**
- frontmatter 写 `locked: true` 以后，API 层拒绝修改，返回 423。
- 但它明确说只管 API，直接改文件就能绕过（`docs/LOCKED_NOTES.md:24-31`）。
- vonvon 已经用沙箱和真实路径挡住会话写人设文件（`docs/product.md` 3.6），比打一个 frontmatter 标记可靠。

**对 vonvon 的评估**
- **好处**
  - 透明，能直接纠错。Today 那篇文章强调的就是这一点："有哪些记忆想要纠正，我直接点开就能看到"（article.txt）。
  - Codex 和 Claude 本来就擅长改文件。
  - 能接 git 和外部编辑器。
  - vonvon 每一轮都重新读文件、比哈希【码 `group-profile.ts:79-90`，`handle-message.ts:1062-1063`】，所以主人在外部编辑器里改了，下一轮就生效，不需要另加 watcher【推】。
- **代价**
  - 文件多了，不能每一轮全量注入。basic-memory 靠检索，Letta 靠"根目录常驻、子目录有索引按需读"（[Letta MemFS](https://docs.letta.com/concepts/memfs)）。vonvon 只要保证每个会话实际装载的文件不超过四五份，就可以继续全文交付【推】。
  - 每多一个可写文件，就多一处链接和 FIFO 攻击面。现有的 `O_NOFOLLOW` 方案可以照搬【码 `docs/product.md` 3.6】。
  - 群个性和群记忆现在在 JSON 里，要先改回文件，或者至少让"打开文件"能定位到它【码，见第 1 节】。
- **最关键的一点【推】**：Today 只有一个主人、一个人设"缪斯"，截图 08 的文件夹（缪斯的角色设定、关于卡尔、Work、People、Health……）全是按主题分的。vonvon 第一层必须按受众分，主题只能放在第二层。

## 3. 人设怎么定义

| 来源 | 人设的写法 | 依据 |
|---|---|---|
| SillyTavern 角色卡 | 所有字段都是自由文本，但每个字段进提示词的位置和规则不同：<br>- description、personality、scenario 每次都发<br>- 首条消息只发一次，模型会模仿它的长度和风格<br>- 示例对话以 `<START>` 分块，上下文不够时一块一块丢掉<br>- Character's Note 按深度插进对话里，用来强化特质<br>官方不规定格式，只提醒注意 token 预算 | [characterdesign](https://docs.sillytavern.app/usage/core-concepts/characterdesign/) |
| SillyTavern World Info | 条目由关键词触发，有次关键词逻辑、概率、互斥组和插入位置（角色定义前后、示例前后、作者注、按深度、Outlet）。作用域分四种：全局、角色（导出卡片时一起带走）、Persona（用户身份）、单个聊天 | [worldinfo](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)、[personas](https://docs.sillytavern.app/usage/core-concepts/personas/) |
| elizaOS Character | 全是字符串数组：`bio[]`、`adjectives[]`、`topics[]`、`messageExamples`、`postExamples`；`style{all,chat,post}` 按场景分；`knowledge`、`documents` 指向文件或目录，目录可以标 `shared`。当前类型里已经没有 `lore` | 【码】`eliza/packages/core/src/types/agent.ts:61-82`、`documents.ts:9-13` |
| Character.ai | 名字、问候语、短描述、长描述，加一个 0 到 32000 字的自由文本 Definition。Definition 最常见的用法是写 `{{char}}:` 开头的示例对话；对话变长时会被截断，所以要把重要的写在最前面 | [book.character.ai Definition](https://book.character.ai/character-guide/character-attributes/definition.md) |
| OpenClaw | `IDENTITY.md` 按 `- Name:` 这样的行解析（名字、Vibe、Emoji、头像）；`SOUL.md` 写自由文本，只放语气、立场和边界，操作规矩放 `AGENTS.md` | 【码】`openclaw/docs/reference/templates/IDENTITY.md`；`docs/concepts/soul.md:14-20,64-70` |
| Hermes | `SOUL.md` 是系统提示的第一段；没有这个文件时自动生成一份默认人设 | 【码】`hermes-agent/website/docs/user-guide/features/personality.md:9-38` |
| Letta | `persona.md`、`human.md` 就是记忆根目录下的文件，每一轮都在上下文里 | [Letta MemFS](https://docs.letta.com/concepts/memfs) |
| Today | "缪斯的角色设定"是记忆面板里的一个文件夹 | 截图 08.jpeg |

**提炼【推】**
- **按程序会不会单独用那一段来决定拆不拆。** SillyTavern 拆字段，是因为位置和丢弃规则不同；elizaOS 用数组，是为了抽样，以及按 chat 和 post 场景挑风格。vonvon 会单独用的有两处：
  - judge 只吃前 1500 字（`judge/prompt.ts:109`）。与其截断，不如单独有一段"身份和职责（什么时候该我说话）"给 judge 和身份行用。
  - "边界（不做什么）"也值得单独成段，因为群里的语气要合场合（OpenClaw `soul.md:66-70`）。
- 建议一个 `角色设定.md`，固定几个标题：一句话身份和职责、说话方式、边界、示例对话（0 到 3 段，可选）、补充。界面上显示成分段的表单，磁盘上仍是一个 markdown 文件。
- 新 bot 用飞书简介预填一份模板，学 Hermes 自动生成和 OpenClaw 的首次引导，不要再是空框。
- **人设和记忆的边界。** 呈现上可以学 Today 和 Letta，人设作为面板里的一个文件。语义上必须分开：
  - 人设只有主人和管理员能写，按指令交（现在的 `[个性与职责]`）；
  - 记忆群成员也能写，只能按"背景资料"交（`group-profile.ts:87-88`）。
  - 群成员写的东西不能经由"记忆"流进指令那一层（Rakazo 第二轮调研 F3，`docs/research/2026-10-18-rakazo-2/d4-prompt-memory.md`）。

## 4. 多 bot、多群的作用域：别人怎么做

| 产品或框架 | 同一个 bot 的多个群，记忆互通吗 | 群里某个人的私事会不会被带走 | 多个 bot 共享关于主人的信息吗 | 依据 |
|---|---|---|---|---|
| OpenClaw | 每个群默认是独立会话（`groupScope: per-group`）；私聊默认全部合进主会话，官方警告这样 A 的私话 B 能看到，推荐改成 per-channel-peer | `MEMORY.md` 只在主人私聊里加载，群里和有别人的会话里都不加载；`USER.md` 按人分：`users/<profile-id>/USER.md` | 多 agent 完全隔离，跨 agent 搜索已经删掉；要共享就显式放进 `extraPaths` 目录 | 【码】`concepts/session.md:118,130-136,170`；`reference/templates/AGENTS.md:67`；`concepts/user-model.md:57-58`；`concepts/multi-agent.md:260-268` |
| Hermes | 群里默认每人一个会话（`group_sessions_per_user: true`） | 记忆按 profile 分，没找到"进群就不加载"的逻辑（grep 没命中）【推：群里也会加载主人的 USER.md】 | 不共享；官方明确反对两个进程共用一个家目录 | 【码】`user-guide/sessions.md:1006-1030`；`features/memory.md:23` |
| Slack AI / Slackbot | 只用提问者此刻有权限看到的数据 | 按提问者的权限过滤；但它是"一人一个助手"，受众就是提问者本人 | — | [Slack AI 安全](https://slack.com/help/articles/28310650165907) |
| 飞书知识问答 | 按提问者的权限取数，同一个问题不同人得到的答案不同 | 同左 | — | 媒体报道，非官方规格：[头条](https://www.toutiao.com/zixun/7516390821076387903/) |
| ChatGPT 项目 | 建项目时可以选"仅项目记忆"：既不读外面的记忆，也不往外带；建好后不能改 | — | — | [Simon Willison](https://simonwillison.net/2025/Aug/22/project-memory/)、[OpenAI Academy](https://academy.openai.com/public/clubs/work-users-ynjqu/resources/projects) |
| elizaOS | 有一套作用域等级：`shared`、`room`、`owner-private`、`user-private`、`agent-private` 等；默认 `owner-private`，拿不准就不放 | 按"在场成员里权限最低的那个人"决定能不能披露（min-over-members） | 可以按实体单独授权 | 【码】`eliza/packages/core/src/types/memory.ts:35-42,55-68` |
| CrewAI | 统一的 `Memory`，按路径分层（`/agent/x`、`/project/y`）；`scope()` 限定子树，`slice(read_only)` 跨几个分支只读 | 条目标 `private=True` 时，只有 `source` 匹配才召回 | crew 里默认所有 agent 共用；agent 也可以只拿一个子树 | [CrewAI memory](https://docs.crewai.com/en/concepts/memory) |
| Letta | — | — | 同一个 block 挂给多个 agent，一方改了另一方马上看到；`read_only` 只能对整个 block 设；`rethink` 是后写覆盖先写，多个 agent 同时改会丢更新 | [shared blocks](https://docs.letta.com/guides/agents/multi-agent-shared-memory) |
| mem0、LangGraph、AutoGen | mem0 按 `user_id`、`agent_id`、`app_id`、`run_id` 打标签；群聊要每个人分开调用 `add`，`name` 字段不决定归属；LangGraph 用命名空间元组，例如 `("memories","{user_id}","user_profile")`；AutoGen 的 `memory=[…]` 按实例挂 | — | 共享与否看是不是同一个 ID 或实例 | 【码】`mem0/docs/platform/features/group-chat.mdx`；`langmem/src/langmem/knowledge/tools.py:193`；[AutoGen memory](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/memory.html) |

Discord、Telegram 上的通用 AI bot 没有查到可靠的公开说明，所以没有列。

**四种作用域模型【推】**

| 模型 | 例子 | 隐私 | 体验 | 实现代价 |
|---|---|---|---|---|
| 完全隔离 | Hermes 的 profile、OpenClaw 多 agent | 最好 | 同一件事要在每个 bot、每个群各说一遍 | 最低 |
| 层级继承（上层自动流到下层） | vonvon 现在的"Bot → 群可选继承"、SillyTavern 全局 → 角色 → 聊天 | 上层只要写了私事，就会流到所有下层 | 直观，但"继承"会让人以为下层也拥有一份副本 | 低 |
| 共享池加访问控制（条目级） | elizaOS、CrewAI 的 private、Slack | 规则对了很细致，自动分类一旦出错就会漏 | 最灵活，但要审核每条标签，很难当成普通文件来改 | 高 |
| 引用而非复制（一份原文，多处挂载） | Letta 的 block 和共享仓库、OpenClaw 的 extraPaths、basic-memory 的 project | 挂载时做一次受众检查，就可控 | 改一处，所有挂载的地方下一轮都生效，来源一目了然 | 中 |

## 5. vonvon 的候选方案

**统一规则：** 一份内容只能装载到受众是它来源受众子集的会话里。
- 主人私聊的受众是 {主人}。
- 群的受众是群成员。
- 主人的几个 bot 都在同一个 daemon 里，bot 本身不算受众。所以同一个场合下 bot 之间共享，不扩大泄漏面【推】。

### 方案一：保留现在的三份记忆，补可见性

做法：
- 群个性和群记忆改回文件；
- 私聊接上个性和私聊记忆；
- 新 bot 预填人设模板；
- 每个页面显示"这里实际会交给 agent 的内容和来源"；
- 按计划交付 s38b、s40、s49。

用户的感受：
- 好处：每个页面还是两个框，知道私聊也用；说"记住"后卡片显示"已记到本群记忆"。
- 告诉 bot A 的偏好，bot B 不知道。
- 两个 bot 在同一个群里，一件事要各记一遍。
- 主人很可能把"我的作息、家人"写进"公共记忆"，然后它出现在每个有外人的群里。

代价：最低，大部分在现有切片里。

### 方案二（推荐）：按受众分层的记忆文件夹，用引用代替继承

```
记忆/                         （主人一份，Today 式面板）
  关于我/      所有 bot 共享，只在主人私聊里装载
  公共/        所有 bot、所有群；只有主人和管理员写（团队术语、产品事实）
  Bot/<名字>/角色设定.md       人设，按指令交；群补充：群/<群>/<名字>.md
  群/<群名>/群记忆.md          本群里主人所有 bot 共享（是否每个 bot 各一份待定）
  私聊/<人>/私聊记忆.md        这个人的私聊里用
```

用户的感受：
- 打开一个面板，就能看到 bot 知道的所有东西，文件夹名直接写明"谁会看到"。
- 每个 Bot × 群页面列出"这里会用到"的几份文件，每份带来源标签，点一下就打开原文。
- 改一份文件，所有引用它的地方下一轮生效。
- bot A 在支付组记住"周四发版"，同群的 bot B 也知道，别的群都不知道。
- 主人在私聊里跟任何一个 bot 说过的偏好，其他 bot 在私聊里也知道。
- 想把"关于我"里的某一条用到群里，要把它移到"公共"。界面提示"这个群里还有其他人，他们会看到这条"。没有能把私事挂进群的开关。

代价：中等（行数是推断，要拆片）。
- 数据从 `bots/<appId>/memory` 迁到主人一级；
- daemon 按场合算出装载清单；
- 群记忆变成多个 bot 共写，并发写由 s40 已设计的 diff3 合并承担；
- 界面加文件树；
- 现有的防链接和原子写可以沿用（`bot/personality-files.ts`）；
- 要改 product 3.6 里"同一个群里几个 bot 各有一份本群记忆，不共享"那一条（`docs/product.md:407`）。

### 方案三：共享池，每一条标可见范围

做法：
- 每条记忆写成一行，学 basic-memory 的 `- [范围:主人] 内容 (来源 日期)`；
- bot 写入时自动标范围；
- daemon 读时按"在场成员里权限最低的人"过滤，学 elizaOS。

用户的感受：
- 一个平铺的列表，可以按"谁能看到"筛选。
- 某一条可以单独放给某个群用。
- 自动标错就漏，主人要定期审核标签。
- 当普通文件改时，容易把标签弄坏。

代价：高。条目解析、误标防护、标签界面和测试都要做。

**人设怎么继承（三个方案通用）【推】：**
- 保留 Bot 人设加群补充（追加）；
- bot 之间不继承，各是各的角色；
- 可以加一份"所有 bot 的共同规矩"，放在 `公共/` 下，按指令交，只有主人写。

**要和 owner 讨论时需要定的问题：**
1. 同一个群里，主人的几个 bot 共享一份群记忆，还是各一份？
2. "关于我"是所有 bot 共享（只在主人私聊里用），还是每个 bot 各一份？
3. 管理员和 bot 私聊的记忆，几个 bot 之间要不要共享？
4. 现在每个 bot 一份的"公共记忆"，是改名为"公共（所有群可见）"、提升到主人一级，还是保留每个 bot 一份？

未核实的事项：
- elizaOS 的 min-over-members 规则只读到了类型注释，没读实现。
- Slack 和飞书只有官方说明或报道，没有实测。
- Hermes 在群里会不会加载 USER.md 是推断。