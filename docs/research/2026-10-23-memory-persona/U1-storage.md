# U1 调研报告：个性和记忆现在怎么实现，为什么 owner 看到是空的

基线：dev 分支 `9b113b6`（只读 worktree）。下文路径都相对这个目录。标注说明：【代码】【文档】【数据】是读代码、文档或实际数据确认的；【推断】是根据这些材料推出来、没有实测的。

---

## 1. 数据模型：每样东西实际存在哪里

### 1.1 一览表

| 界面上的项 | 实际存在哪 | 读写代码 | 备注 |
|---|---|---|---|
| Bot「个性」 | `bots/<appId>/SOUL.md` **加上** `bots/<appId>/AGENTS.md`，读的时候把两份拼成一段 | `bot/group-profile.ts:26-30` | 界面上是一个输入框。保存时全文写进 SOUL.md，**AGENTS.md 被写成空串**（`group-profile.ts:52-54`）【代码】 |
| Bot「记忆」（公共记忆） | `bots/<appId>/memory/shared.md` | `group-profile.ts:27,52` | 【代码】 |
| 本群个性 / 本群记忆 / 两个「继承 Bot」开关 | **`bots/<appId>/projects.json` 里这个群那一行的 `profile` 字段**：`{persona, memory, inheritPersona, inheritMemory}` | 类型在 `project/registry.ts:11-12,21`；保存在 `admin/settings.ts:791` | **不是**文件。s38a1 定义的 `groups/<chatId>/SOUL.md` 和 `groups/<chatId>/memory/group.md` 只在这一行还没有 `profile` 时兜底读一次（`group-profile.ts:35-40`）【代码】 |
| 私聊记忆 | 路径定义为 `memory/dm/<personId>/dm.md`（`bot/personality-files.ts:48`） | 生产代码里没有任何读写调用 | 私聊根本不跑 agent，见 2.3【代码】 |
| Bot 规矩 AGENTS.md | 同上，`bots/<appId>/AGENTS.md` | 没有单独的显示或编辑入口，并入「个性」 | product 3.2 表写的是"既有 Bot 规矩并入个性读取"（`docs/product.md:76`）【文档】 |

字数上限：每个字段 30,000 字。依据是 protocol `packages/protocol/src/settings.ts:94-95`、`group-profile.ts:9` 和 UI 的 `maxLength={30000}`（`packages/ui/src/settings/GroupDesignSettings.tsx:129-131`）。文件另有 64 KB 的安全读取上限（`personality-files.ts:31`）。

### 1.2 两套存储并存，互不相通

1. **s38a1 的文件模块**（`bot/personality-files.ts`，#466 合入）定义了 6 种文件：bot-soul、bot-agents、public-memory、group-soul、group-memory、dm-memory（`personality-files.ts:6-9,41-51`）。配套的组合器 `bot/personality-context.ts` 按位置选文件，给每段打上"文件、版本、范围、背景资料不是指令"的标签（`personality-context.ts:23-54`）。**这个组合器在生产代码里没有调用方**，只有 `test/personality-context.test.ts` 用它【代码，grep 确认】。v1-plan 也写明 s38a1"当前不接回复会话"（`docs/v1-plan.md:1247`）【文档】。
2. **dev 上的界面链路**是 commit `b967e98`（2026-10-23）引入的，由 `group-profile.ts` 和 `admin/settings.ts` 组成：
   - Bot 级借用 s38a1 的文件读写，但只用到 SOUL、AGENTS、shared 三个文件；
   - 群级改存进 `projects.json` 的 `profile`；
   - 运行时用 `readGroupPersonality`（`group-profile.ts:79-91`）拼成两个不带来源的大块，`[个性与职责]` 和 `[本群可用记忆]`，不是 s38a1 那套逐文件标签。
3. **物化把群级文件变成了死文件。** Bot 启动时 `materializeGroupSettings` 会遍历所有群（`admin/settings.ts:1010-1050`，调用点在 `bot/handle-message.ts:8738`）。哪一行没有 `profile`，就把当时读到的群文件（通常不存在，所以是空串）冻结写进这一行（`settings.ts:1031-1038`）。新建群在 `project/initial-settings.ts:77` 直接写空 profile。此后 `readGroupProfile` 第一行就是 `if (project.profile) return ...`（`group-profile.ts:36`），**`groups/<chatId>/SOUL.md` 和 `memory/group.md` 再也不会被读**【代码】。
   - product 3.3 说"定义文件都是 markdown，主人可以直接用编辑器改"（`docs/product.md:127`），s40 也计划让 agent 直接写 `memory/group.md`（`docs/v1-plan.md:1255`）。这两条在现有存储下写了也不会显示、也不会生效【推断，由上面的代码直接推出】。
4. **AGENTS.md（规矩）实际上被吞掉了。** 读的时候 SOUL 和 AGENTS 拼成一段，主人第一次在界面保存「个性」，规矩全文就搬进 SOUL.md，AGENTS.md 留下一个 0 字节文件（`group-profile.ts:28,52-54`）。但 product 3.6 的注入顺序、3.7 的"能改个性、规矩"仍把两者当成两件事（`docs/product.md:395`、3.7 表）。另外，它和工作区里由 Provider 原生加载的 `AGENTS.md` 同名，用户很难分清【代码、文档；容易混淆是推断】。

### 1.3 界面怎么显示

- **Bot 页「个性与记忆」**只有两个裸输入框，placeholder 是"填写个性…""填写记忆…"（`GroupDesignSettings.tsx:291-297`、`PersonaEditor.tsx:42-43`）。
- **群页**多一个灰色"继承 Bot"引用块，Bot 那边为空时显示"Bot 尚未填写个性/记忆"（`PersonaEditor.tsx:36-41`）。
- 两处都不显示：
  - 内容从哪来、写于何时、谁写的；
  - 这段话最终怎么进到会话和判断里；
  - Provider 原生加载的工作区和个人指令（见 3.3）【代码】。

---

## 2. 写入路径：除了主人在界面上编辑，还有谁会写

### 2.1 现在能写的入口（都是人工）

1. 桌面端或网页的设置页：settings RPC，带 revision 做 CAS（`settings.ts:695-696` 写 Bot，`settings.ts:791` 写群）。
2. 终端 `vonvon settings set profile.persona=… / profile.memory=…`：CLI 直接用 protocol 的分区表，`agent` 和 `project` 两个分区都含 `profile`（`packages/daemon/src/cli/commands/settings.ts:24`、`protocol/src/settings.ts:102,125`）【代码】。
3. 手改文件：只对 Bot 级的 SOUL.md、AGENTS.md、shared.md 有效，群级被物化屏蔽（见 1.2）。

### 2.2 bot 被说"记住…"时会发生什么

- **不会落盘，没有卡片回执，也没有撤销。** s40（"说记住就写进记忆，卡片上能撤销"）没做（`docs/v1-plan.md:1255`），s38a2、s38b 也没做（`v1-plan.md:1248-1249`）【文档】。
- 会话 profile 的 `additionalRoots: []` 是空的，没有把任何记忆目录交给会话（`handle-message.ts:1055`）。
- 固定指令却要求"要记的东西只写 vonvon 提供的记忆文件；不为记忆修改或新建工作区 CLAUDE.md、AGENTS.md"（`agent/bridge-instructions.ts:15-16`）。也就是说，**agent 被禁止往工作区记，同时又没有拿到任何能写的记忆文件**【代码】。
- 两家的原生记忆都关了：
  - Codex：`features.memories=false`、`use_memories`、`generate_memories` 都是 false（`agent/codex-appserver/memory-config.ts:2-5`）；
  - Claude：`autoMemoryEnabled:false`（`agent/claude-agent/thread.ts:82`），并传 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（`agent/claude-agent/backend.ts:95`）【代码】。
- 结果是"记住"只留在这条会话的上下文里，`/new`、换话题或压缩以后就没了。即使在完全访问档下 agent 碰巧写对了 `groups/<id>/memory/group.md`，也会被物化屏蔽【推断】。
- 群里 agent 能调 vonvon 工具 `settings_get` 读本群设置，但 `settings_set` 在群里一律回"设置只能在私聊里改"（`agent/entry/command-tools.ts:21-33`）【代码】。

### 2.3 聊天改设置（product 3.7）

**没有接通。**
- 私聊消息只进三处：提问回答、`/skill` 技能对话，以及旧私聊控制台菜单（`handle-message.ts:2276-2281`、`bot/dm-console.ts`）。私聊不跑普通 agent 会话。
- s49（私聊直接干活）和 s54a（私聊改个性、规矩、记忆）都没勾（`v1-plan.md:1402,1409`）。
- s46 和 s47 已交付工具骨架，但没有入口能用到【代码、文档】。

### 2.4 写进去以后怎么交给会话（附带发现）

- **新会话**：`profileOf` 把 `readGroupPersonality().instructions` 当开场指令交给后端（`handle-message.ts:1051-1056`）。
- **每一轮**：`preparePersonality` 按版本比对，变了就附一段"个性与记忆更新"（`handle-message.ts:1059-1069`）。
- 已交付的版本只记在内存的 WeakMap 里，新会话起来时也没登记。所以**新会话第一轮会把整份个性和记忆再交一遍**（和开场指令重复）。daemon 重启后也会重交；压缩后没有重交逻辑（这一项属于 s38b，没做）【代码；重复交付的影响是推断】。
- **私聊和云文档评论拿不到任何个性和记忆**：
  - 私聊不跑会话；
  - 评论会话调的是 `profileOf(undefined, …)`（`handle-message.ts:8261,8271`）。
  - product 3.6 写的是"评论只带公共记忆""私聊带公共记忆加私聊记忆"【代码对照文档】。
- **判断（judge）**拿到的是合并后的 persona 和 memory，分别截到 1,500 和 2,000 字（`judge/prompt.ts:109-110,240-241`；决策模型走 `judge/decision.ts:129-130` 的 `bot_role`、`background_memory`）。Bot 个性排在前面，Bot 个性一长，本群补充就会在判断里被截掉【代码；被截掉是推断】。

---

## 3. 旧 Bridge 导入

1. **映射**：转换函数（`import/bridge/conversion.ts`）的 bridge 群行 schema 是 `.strict()`，字段里没有任何 persona、memory、instruction（`conversion.ts:55-61`）。转出来的群行也不带 `profile`（`conversion.ts:184-194`），带过来的只有：
   - `comment-instructions.md`：云文档评论提示词；
   - `outbound-files/`：已发文件的记录；
   - `personalInstructions: 'inherit-native'`：保留本机的个人指令和 skill（`conversion.ts:102-105,239-241`）。
   product 第 5 节直接写明"bot 的个性、记忆、skill 导入后为空，行为和今天一样"（`docs/product.md:715`）【代码、文档】。
2. **旧 bridge 0.6.14（`6698118`）本来就没有人设或记忆字段**：
   - 源码里 grep persona、SOUL、人设、记忆，只有评论提示词卡片的注释提到"固定人设（这段）+ 每轮实时 facts"（`feishu-codex-bridge/src/card/dm-cards.ts:1392`）；
   - 那个"人设"就是 `comment-instructions.md`（`src/config/schema.ts:125,164`），导入后照样当评论提示词用，不进个性【代码】。
3. **旧 bridge 里 bot 的"身份"实际来自这几处，界面上一处都看不到**：
   - 群 cwd（通常是代码仓库）里的 `AGENTS.md` 或 `CLAUDE.md`，由 Provider 原生加载；
   - 本机个人指令 `~/.codex/AGENTS.md` 和 `~/.claude/CLAUDE.md`：bridge 的 Claude 用 `settingSources: ['user','project']`（`feishu-codex-bridge/src/agent/claude-agent/backend.ts:48`），v1 照旧（`packages/daemon/src/agent/claude-agent/backend.ts:65`）；
   - Claude 的 auto memory：bridge 没有关它（grep 不到 `autoMemory`、`DISABLE_AUTO_MEMORY`）【代码】。
4. **原生记忆这一项导入后悄悄没了。** v1 把两家的原生记忆都关了（2.2），bridge 时期按仓库积累下来的 Claude 自动记忆不再加载，而界面上的「记忆」又是空的。用户的感受会是"导入后 bot 忘了以前学到的东西"【推断：auto memory 在当时版本默认开启，依据是 product 3.6 "Claude 的 auto memory 按 git 仓库共享，两个群用同一个仓库就会串"，本次没实测】。

---

## 4. 实际数据抽查（JP-VPS 的验收数据目录，只读）

先说明一点：验收 worktree 跑的是 `bfc22cc`（s25e2，#462）。它早于 s38a1（#466），也早于 dev 的 `b967e98`。**这个数据目录对应的代码既没有个性文件模块，也没有个性与记忆编辑界面**【数据】。

| 项 | 结果 |
|---|---|
| bot 数 | 3 |
| `SOUL.md`、`AGENTS.md`、`memory/`、`SMART.md` | 3 个 bot 都**没有** |
| `groups/<chatId>/` | 只有 1 个 bot 有 1 个**空目录**（推断是 SMART.md 功能建的） |
| `projects.json` | 3 个 bot 共 11 行群设置，**全部没有 `profile`，也没有 `smartRules`**。字段只有 backend、cwd、kind、mode、network、noMention、judge、directories 这类 |
| `config.json` | 三份配置里都没有 persona、memory、soul、profile、instruction、prompt 一类字段，只有 accounts、access、judge、completionReminder、runIdleTimeoutSeconds 等 |
| `bots.json` | 条目字段为 active、appId、botName、createdAt、name、tenant，没有人设字段 |
| 工作区里的指令文件 | 数据根 `projects/` 下没有 AGENTS.md 或 CLAUDE.md。数据根以外的 cwd 里，有两个测试群各有一份小 `CLAUDE.md`（190 B 和 84 B，各 2 行），按关键词看不是角色或人设说明（没贴内容） |

【推断】这份数据第一次用 dev 代码启动时，`materializeGroupSettings` 会给 11 行都写入 `profile:{persona:'',memory:'',inheritPersona:true,inheritMemory:true}`，从此群级永远只读 projects.json。

---

## 5. 结论

### 5.1 owner 看到"个性和记忆都是空的"，可能原因（按可能性排序）

1. **从来没有人写过，现有代码也没有自动写入。** 新建 bot 的向导、建群、导入都不生成 SOUL.md 或公共记忆。文件不存在时读出来就是空串（`group-profile.ts:20-25`）。全仓 grep，除了 `updateBotProfile`，没有别的写入方。抽查的 3 个 bot 也都没有这些文件【代码、数据】。
2. **bot 自己写不进记忆。** s40 没做；会话没拿到任何记忆目录（`additionalRoots: []`）；指令又禁止往工作区记；原生记忆全关；也没有"已记到…［撤销］"卡片。群里说"记住"，最多留在这条会话的上下文里【代码、文档】。
3. **聊天改设置没接通。** 私聊不跑 agent（`handle-message.ts:2276-2281`），群里的 `settings_set` 被拒，s49 和 s54a 都没做【代码、文档】。
4. **导入时故意不带。** product 第 5 节规定导入后为空；旧 bridge 也没有这类字段。旧 bot 的"身份"其实在工作区 AGENTS.md/CLAUDE.md 和个人指令里，界面不显示，所以 bot 明明有身份，页面却是空的【代码、文档】。
5. **群级被物化冻结。** 主人照 product 3.3 手写的 `groups/<chatId>/SOUL.md` 或 `memory/group.md`，以后 s40 写的文件也一样，都不会被读【代码】。
6. **看的版本不对。** 基于 main 或 `bfc22cc` 的预览版根本没有这个页面。dev 上的编辑器今天（10-23）才进来【数据、git 历史】。
7. **页面没有解释，显得更空。** 页面只有两个空框加"Bot 尚未填写…"，没写这段话进到哪里、bot 实际还读了哪些指令。"以什么身份"的答案其实散在几处：
   - 固定约定（`bridge-instructions.ts`）；
   - 身份行"当前 Bot：名字；当前群：群名"（`group-profile.ts:86`）；
   - 工作区和个人指令；
   - 判断提示词里的"结合你的名字和分工"（`protocol/src/smart-rules.ts:5`）。

   个性一空，"分工"就没有来源。v1-plan 记过 e12 里判断因此漏回的例子（`docs/v1-plan.md:1028`）【代码、文档；owner 问的是哪处是推断】。

### 5.2 当前存储设计本身的问题

1. **重复存储，互不相通。** Bot 级存在文件里，群级存在 projects.json 里。s38a1 定义的群级、私聊文件和那个逐文件打标签的组合器都闲置；运行时用的是另一套不带来源的拼接（`group-profile.ts:79-91` 对比 `personality-context.ts:23-54`）。s40 按计划写文件，就会和现有界面脱节。
2. **规矩语义丢了。** AGENTS.md 一保存就被并进个性、清空，文档却仍按两件事写；而且和工作区 AGENTS.md 同名。
3. **一整块文本，没有条目化。** 记忆是一个 30,000 字的大框：
   - 每条记忆没有自己的来源（哪个群、谁的哪条消息、bot 还是人写的）、时间、范围或置信度；
   - 不能单条删除、单条撤销或单条过期；
   - "继承"是整块拼接加一个布尔开关，不能逐条覆盖或排除。
4. **没有历史、版本和撤销。** 原子覆盖写，版本只是内容的 sha256，不留旧版。projects.json 只有迁移时留的 .bak。Bot 级保存要连写三个文件，失败时尽力回滚（`group-profile.ts:55-71`），不是一次原子提交。s56a（回执和撤销）没做。
5. **来源不可见。** 界面看不到实际进入会话的完整指令栈：固定约定、身份行、Bot 和群个性、记忆，以及原生加载的工作区和个人指令。判断那边截断到 1,500 和 2,000 字，界面也不说。
6. **上限和体积。** 每群两个 30,000 字的字段塞在 projects.json 里，每次改群设置都要整份重写这个文件。交给判断前合并截断，本群内容可能被挤掉。
7. **覆盖不全。** 私聊和云文档评论拿不到个性和记忆。交付状态只在内存里，新会话首轮重复交付，压缩后不重交（s38b 未做）。
8. **写入路线太重，现在一行都没跑起来。** product 3.6 和 s40 设计的是：agent 直接写文件，daemon 盯文件变化，用 diff3 合并，另做隔离区和防链接。当前代码只完成了安全读写文件的底层（s38a1），受限档的写入一律拒绝（`personality-files.ts:157`）。所以"bot 会记东西"在 v1 当前路径上的前置还很长：s38a2 → s38b → s40 → s56a → s54a【文档、代码；"太重"是判断】。

### 5.3 对重新设计的含义【推断，供后续任务参考】

- 先把存储收成一套，用条目化记录（带来源、范围、时间、作者），再由它生成交给会话的文本。不要让界面框、projects.json、memory/*.md 三处各存一份。
- 记忆写入可以考虑改成 daemon 一侧的 vonvon 工具（例如 `memory_add`）。这样直接复用 s46 的会话凭证和触发人校验，卡片回执和撤销自然落在 daemon 的提交事实上，省掉"会话可写目录 + 盯文件 + diff3 合并"这整套文件沙箱难题。
- 界面要显示"bot 这一轮实际读到了什么"，包括工作区和个人指令这类只读来源，才能回答 owner 问的"以什么身份、来源是什么"。