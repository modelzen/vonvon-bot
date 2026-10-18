> 原始深挖，没有逐条复核；和 report.md 冲突时以 report.md 为准。

# 对话和线程管理

Rakazo 固定在 b884f43（`<home>/vonvon/references/rakazo-b884f43`），Vonvon 对照 main 7db621a。7db621a 比 898d3c5 只多了一个纯文档提交（#386），代码一样。只读源码，没有运行 Rakazo 的任何代码、测试或脚本，没有装依赖，没有联网。【确认】是读源码确认的，【推断】是从代码推出来、没有运行验证的。

## 0. 结论

1. **Rakazo 的线程模型很简单，没有我们可以照搬的会话结构。** 一个 bot 的 1:1 对话是一条线程，app 内一个群是一条线程，外部的一个会话（一个 Slack 频道）是一条线程，三者都用唯一外键绑定（`packages/db/prisma/schema.prisma:524-541`）。它没有话题分会话，没有 `/new`，也没有 `/resume`。"清空"就是删掉这条线程里的全部消息。我们按飞书位置分会话、停泊后能恢复（`docs/product.md:192-200`、`:278-279`），比它细。
2. **最值得拿来的是"会话归属"这条原则，它暴露出我们一个真实的缺口。** Rakazo 由服务端从"谁"推出线程：客户端只给 botId 或 groupId（`apps/api/src/thread-target.ts:291-328`），读历史时的范围也只能由执行器给，工具参数扩大不了（`packages/db/src/history-retrieval.ts:6-15`、`:55-80`）。我们的 `/resume` 和网页上"可恢复"的列表却**按工作目录**列会话（`packages/daemon/src/bot/handle-message.ts:2880`、`:5063-5064`）。s49 以后，主人和每个管理员的私聊会话都起在 bot 的主工作区（`docs/product.md:615`），管理员在自己的私聊里 `/resume`，就能看到并恢复主人的私聊会话。今天的群里也有两个问题：一是能把另一个话题正在用的会话再绑一次，二是两个群共用一个目录时会互相列出对方的会话。建议见发现 1，要改 product.md 的 `/resume` 定义。
3. **"侧栏时间"（c7a1f01）在我们这边有同类问题。** 网页"历史会话"显示的是 `SessionRecord.updatedAt`（`packages/ui/src/management/ConversationPanel.tsx:112`），换模型、撤回说明、标题任务收尾都会改动它（发现 2）。
4. **压缩和序号连续：机制我们已经有对应的，只差覆盖面。** Rakazo 每次运行都在使用摘要前再核对序号是否连续，再用代号加 CAS 挡住"清空和压缩同时发生"的情况。我们用水位只增不减，会话 id 起到代号的作用（发现 4）。但我们只给主区会话记压缩（`handle-message.ts:1336`），而 product.md 承诺所有会话压缩后都整份重交设置（`docs/product.md:424`），s38 要补上（发现 5）。
5. **s48 读另一条会话，可以直接借用 Rakazo 检索接口的形状和使用指引。** 具体有：字节预算内显式截断，带续读位置，标明覆盖到哪里；无权访问和不存在返回同样的结果；范围从调用方的令牌推出。还有一段经过 eval 调过的"怎么查历史"的指引（发现 8、9）。另外，读 Claude 会话时要说清楚"最终回答"是哪一段，不然会把工具调用前的过渡话也当成回答（发现 6）。
6. **a1c5e4f（多段回答之间留空行）我们已经有了**（发现 7）。Rakazo 的压缩在默认部署里其实不跑，这一点上一轮漏了，见第 2 节。

## 1. 材料与方法

| 项 | 内容 |
|---|---|
| Rakazo 读过的 | `packages/db/prisma/schema.prisma`（Thread、Message、Event 一段 `:500-600`）；`packages/db/src/events.ts:270-370`（`clearThread`）；`packages/db/src/messages.ts`（全文前 95 行）；`packages/db/src/history-retrieval.ts`（全文）；`packages/db/src/repos.ts:1-60,140-200,320-400`；`packages/db/src/thread-listing.ts`；`packages/core/src/message-visibility.ts`（全文）；`packages/adapters/src/history-compaction.ts`（全文）；`runtime-context.ts:1-200,260-300,380-390`；`executor.ts:3570-3850,4145-4260,7160-7340,7540-7560,7650-7690,8380-8385,8440-8520`；`supermemory-memory-provider.ts:180-200`；`user-progress.ts:60-75`；`apps/api/src/router.ts:2215-2285`；`apps/api/src/thread-target.ts:291-330`；`apps/api/src/team-chat-bridge.ts:433-472`；`apps/web/src/pages/Shell.tsx:4620-4645`；`apps/web/src/pages/shell/dialogs.tsx:348-390`；`docs/context-and-evals-tasks.md:1-30`；提交 c7a1f01、a1c5e4f、5b35ea7 的说明和 diff（在 `<home>/vonvon/references/rakazo` 上用 `git show`）；两个测试文件的用例名（`history-compaction.test.ts`、`repos.test.ts`） |
| Vonvon 读过的 | `docs/product.md` 3.2、3.3、3.5、3.12、第 4 节；`docs/v1-plan.md` s09–s15e、s38–s51 的行和开工要点、体验检查 A；`packages/daemon/src/bot/session-store.ts`；`handle-message.ts` 中 `/new`、`/resume`、网页恢复、压缩检测、水位这几段；`card/run-state.ts`、`card/run-card.ts:295-415`、`card/command-cards.ts:150-240`、`card/history-card.ts`；`agent/codex-appserver/backend.ts:605-640,785-840`；`agent/claude-agent/backend.ts:365-400`、`history.ts`、`event-map.ts`；`bot/topic-registry.ts`；`packages/ui/src/management/ConversationPanel.tsx` |
| 避免重复 | 已经由同轮其他报告覆盖的不再展开：Slack 频道到线程的映射、线程回填（`d1-team-chat.md` 第 10、12 条）；5b35ea7 用在 bot 互相交接上（`d2-judge-multibot.md` 发现 13）；记忆跨线程注入、16b99f2（`d4-prompt-memory.md` F1、F5） |

## 2. 纠正上一轮

1. **外部渠道。** 上一轮说 Rakazo 没有 Slack 一类的外部渠道（`docs/research/2026-10-17-rakazo/product-ux.md:112`；上一轮的交接笔记（本机，不在仓库） §2），这是错的。从对话管理的角度说：一个 Slack 频道对应一个 `ExternalConversation`，再对应一条 Rakazo 线程（`schema.prisma:532`，`apps/api/src/team-chat-bridge.ts:433-471`），e55263f 里就已经有了。所以 Rakazo 的线程不止"一个 bot 一条"，而是 bot 的 1:1、app 内群、外部会话三种。
2. **清空以后摘要还会不会被召回。** `product-ux.md:29` 说，清空时删除外部存储里的摘要是"尽力而为"，所以不能说历史召回已经抹掉。这个说法只看到了删除这一层。【确认】清空时把 `historyCompactionGeneration` 加一（`packages/db/src/events.ts:335`、`:343`）；召回只带当前代号的 history 容器（`packages/adapters/src/supermemory-memory-provider.ts:188-196`，调用处 `executor.ts:3795`）；压缩写回时用游标加代号做 CAS（`history-compaction.ts:428-439`）；压缩期间如果碰上清空，晚到的那次外部写入会再删一遍（`:488-507`）。所以即使删除失败，旧代号的摘要也召回不到，只是可能还留在外部存储里。外部服务是不是严格按 tag 过滤，这一点是【推断】。
3. **压缩在默认部署里不跑。** `runtime-state.md` 说"只有游标之后的序号连续时，本地压缩才会替换旧历史"，这句话没错，但漏了三点。【确认】
   - 默认的上下文策略是 `retrieval`（`packages/adapter-kit/src/types.ts:444`；`docs/context-and-evals-tasks.md:17-18` 写明这是 eval 之后选定的生产默认）。
   - 运行结束后只有在 `current` 策略下才会排队压缩（`executor.ts:7669-7678`）。`contextStrategy` 只能经 `createApp` 的覆盖参数传入（`apps/api/src/app.ts:172`、`:187`），worker 里没有设置它的地方。
   - 压缩只对有 `botId` 的线程做，也就是 bot 的 1:1 线程（`history-compaction.ts:224`）。app 内群的线程和 Slack 外部会话的线程从来不压缩，只靠最近 200 条（`executor.ts:3602`）、Pi 保留的最近 8 个来回（`runtime-context.ts:273`、`:383`）和 `search_history`/`read_history` 两个工具。代码地图 2.7 把压缩写成了常规路径，也要按这个改。
4. **清空是删除，不是停泊。** 地图 2.7 说"清空就是清这条线程，长期记忆保留"，这没错，但没说清空是破坏性的：同一个事务里取消正在跑的运行，删掉全部 Message 和 Event；`nextMessageSeq` 不归零，压缩游标挪到末尾（`events.ts:301-345`）。界面上的确认框写的是"永久删除每一条消息，并停止当前的工作"（`apps/web/src/pages/shell/dialogs.tsx:366-372`）。清空以后没法恢复。
5. **s48 的检索测试没人收。** 上一轮 `runtime-state.md` 排第 1 的建议，是给 s48 做"检索证据精确、可续读"的契约和测试。交接笔记 §3.2（已采纳）和 §3.3（已否决）都没有它，`docs/v1-plan.md:938-941` 里 s48 的开工要点也没写。本轮在发现 8 里给出具体形状，算是重提，不是新点子。

## 3. Rakazo 怎么管对话（读源码）

### 3.1 线程模型【确认】

| 线程 | 怎么绑 | 出处 |
|---|---|---|
| bot 的 1:1 对话 | `Thread.botId @unique`，一个 bot 只有一条 | `schema.prisma:528` |
| app 内群 | `Thread.groupId @unique`，一个群一条，几个 bot 共用 | `:530` |
| 外部会话（Slack 频道） | `Thread.externalConversationId @unique`；频道里所有 Slack 线程共用这一条，回复位置记在每条 ExternalMessage 上 | `:532`；d1 第 10 条 |
| 个人线路的群（Sendblue） | 不单独建线程：群消息扇进每个成员 bot 的 1:1 线程，标成 `channel_message`；跑的时候只取这个频道的入站消息和本轮自己的输出 | `packages/db/src/messages.ts:5-25`；`executor.ts:8459-8461` |

- 序号：每条消息的 `seq` 在写入事务里由 `nextMessageSeq` 自增分配（`messages.ts:67-83`），`(threadId, seq)` 唯一（`schema.prisma:571`）；事件另有一套 seq（`:591`）。
- 没有话题，也没有一个 bot 开几条对话的做法。新建 bot 的介绍运行（trigger `created`）和定时运行（`routine`）不带线程历史（`executor.ts:8449-8458`）。
- 客户端不能直接按线程 id 操作：它给 botId 或 groupId，服务端用 actor 查出归属再取线程（`thread-target.ts:291-328`）。清空的 `where` 里也带着归属（`events.ts:292-299`）。

### 3.2 清空【确认】

`threads.clear`（`apps/api/src/router.ts:2227-2274`）→ `clearThread`（`packages/db/src/events.ts:287-370`），在一个事务里依次：
1. 取消这条线程上所有活着的运行，回收电脑租约（`:301-322`）；
2. 删掉全部 Message 和 Event（`:324-325`）；
3. `nextMessageSeq` 不归零，把游标挪到 `nextMessageSeq - 1`，清掉摘要，代号加一（`:326-345`）。注释说明了原因：游标留在后面会把删掉的历史再摘要一遍，置空又会马上对新对话触发压缩；
4. 改 bot 或群的 `updatedAt`，追加一条 `thread.cleared` 事件（`:346-358`）。

事务提交以后，只对 bot 线程按"上一代和这一代"两个代号去删语义记忆里的历史摘要，删不掉只记日志（`router.ts:2250-2270`）。长期记忆（MEMORY.md、共享记忆、语义记忆里的 durable 部分）都不动。

### 3.3 压缩和序号连续【确认】

- 什么时候压：未压缩的消息数达到 50+50 条时（`history-compaction.ts:21-30`），而且只在 `current` 策略下（见第 2 节第 3 条）。
- 一批取游标之后的 50 条，序号必须正好接上，有缺口就记一条永久失败，游标不动（`:276-289`）。拼成的转写超过 4 万字符时，只留前面放得下的那几条，游标也只推到最后放进去的那条（`:300-315`）。
- 每次运行用摘要之前，`selectCompactedHistory` 再核对一次：摘要存在、长度不超、游标之后的消息序号连续，三条都满足才用"摘要 + 后面的消息"；否则退回完整的 200 条窗口，"宁可多带，不留缺口"（`:61-85`；调用处 `executor.ts:3747`）。
- 写回：先比对游标和代号再写（CAS，`:428-439`）。清空插进来，代号变了，写回就落空；外部存储里晚到的那次保存，事后再删一遍（`:488-507`）。
- 摘要和召回内容都转义 `<>&`，并标成不可信的历史数据（`:87-93`、`:105-127`）。
- 测试用例名就是验收清单：内部有缺口时退回完整窗口（`history-compaction.test.ts:130`）；不跨过缺口推进游标（`:723`）；清空先赢时不让摘要复活（`:739`）；代号前进后删掉过期的外部保存（`:796`）。

### 3.4 跨线程带什么【确认】

- 带的：bot 级记忆和 user 级共享记忆，注入到所有不是"频道运行"的线程，包括 app 内群和 Slack（`executor.ts:3811-3820`；d4 F1）。非群线程还带 bot 花名册。`message_bot` 和交接会在别的线程里留下带跳数的消息（d2）。语义召回按"bot + 当前代号"取（`:3789-3797`）。
- 不带的：历史检索只查当前线程（`history-retrieval.ts:58`，`t.id = scope.threadId`），没有"读另一条线程"的工具。个人线路群的运行不带摘要、不带记忆，历史只取本频道（`messages.ts:5-25`）。

### 3.5 侧栏时间（c7a1f01）【确认】

- 改动前，侧栏这一行显示 `Bot.updatedAt`，改设置、置顶、移分组、排序都会动它。改动后，取线程最新一条消息的 `createdAt`；线程是空的就用 bot 自己的 `updatedAt`（`packages/db/src/repos.ts:42-46`、`:192`、`:358-361`）。用例见 `repos.test.ts:340`、`:373`。
- 残留的不一致：在 `listSpaceBotsForSpaces` 里，预览取的是过滤过的"用户看得见的"最新一条（会跳过 bot 之间的消息和后台运行，`:363-383`，过滤规则在 `packages/core/src/message-visibility.ts:46-73`），时间却取未过滤的最新一条（`:361`）。所以 bot 之间互发一轮以后，时间会变新，预览还停在旧的那条。【确认，没运行】
- 清空以后消息没了，时间退回 `Bot.updatedAt`，而清空刚把它改成当前时间（`events.ts:338-345`），所以显示的是清空的时间。

### 3.6 多段回答怎么拼（a1c5e4f、5b35ea7）【确认】

- a1c5e4f：一次运行里，工具调用把 assistant 的文字分成几段。拼回最终回复时，前后两段之间要是都没有空白，就补一个空行（`packages/adapters/src/user-progress.ts:66-75`）。工具调用会把 `assistantTurnBreakPending` 置上（`executor.ts:7330`），下一段文字来时补上空行（`:7176-7185`）。
- 5b35ea7：bot 对 bot 的运行里，工具调用前的过渡文字不存成气泡（`executor.ts:8514-8516`）。最终回复为空时，用最后一段被压下的过渡文字顶上（`:7550-7558`）。

## 4. 发现

### 发现 1：会话归属。`/resume` 和"可恢复"按目录列，私聊上线以后会串人（采纳思路）

**Rakazo【确认】**：每个对话存储只有一个归属者，用唯一外键保证（`schema.prisma:528-532`）。客户端报"谁"，服务端推出线程（`thread-target.ts:291-328`）。读历史的范围只由执行器给，工具参数扩大不了；锚点和相邻消息用同一个可见性谓词判断（`history-retrieval.ts:6-15`、`:55-80`、`:199-218`）。

**我们【确认】**
- `/resume` 卡列的是 `be.listThreads(cwd)`，也就是这个目录下最近 15 条原生会话（`handle-message.ts:2866-2900`；Codex 用 `thread/list` 按 cwd 过滤，`agent/codex-appserver/backend.ts:611-631`；Claude 用 `listSessions({dir})`，`agent/claude-agent/backend.ts:369-381`）。卡上不标哪条已经绑在别的位置上（`card/command-cards.ts:189-210`）。
- 选中以后，卡片路径（`handle-message.ts:4822-`）不检查这条会话是不是正绑在别的键上。网页恢复只核对"这个目录下有没有这条"（`:5063-5064`，报错文案就是"历史会话不属于当前项目"）。网页列表只在界面上滤掉本项目已经绑定的会话（`ConversationPanel.tsx:91-92`），daemon 端没有这一步。
- `sessions.json` 一个键只存一条记录。`/new` 用新会话把记录整条替换掉（`session-store.ts:355-361`，`handle-message.ts:3179-3192`），停泊的那条会话 id 不在本机留任何归属记录，只能再从目录里找到。
- 私聊：主人和每个管理员各一条私聊会话（`docs/product.md:620`），都用 bot 的主工作区（`:615`）。群的工作区可以覆盖（`:66`），没找到"两个群不能选同一个文件夹"的校验（在 `packages/daemon/src/project/`、`handle-message.ts` 里搜了，没搜到）。

**会出的问题**（都是【推断】，没有运行）
- A，今天就有：多话题群里，在主区 `/resume`，卡上会列出话题 T1 正在用的那条会话。管理员点了，daemon 开一个新话题 T3，绑到同一条原生会话上。之后 T1 和 T3 各自开口：Codex 只许一个写入方，后到的那边接不上；Claude 那边两边分叉。
- B，s49 以后：管理员在自己的私聊里 `/resume`，卡上列出主人的私聊会话，标题就是主人发的第一句话。点了以后，恢复卡把那条会话的最近几轮贴进管理员的私聊，管理员也能接着聊。这条会话的开场里还有主人的私聊记忆（s38 在开场整份交）。这和体验检查 A 第 4 步"另一管理员……不能得到这份个人记忆"（`docs/v1-plan.md:227`）冲突。第 4 步现在只核对记忆文件的范围，不核对会话本身。
- C：一个群的工作区改成了 bot 主工作区，或者两个群选了同一个文件夹，这时群里的 `/resume` 卡（全群都看得见）会列出私聊会话或另一个群的会话标题。这和 3.5"不存：别的话题、别的群、私聊的内容"（`docs/product.md:225-226`）冲突。

**建议**
1. 给停泊的会话记归属：`SessionRecord` 加一个可选的 `parked: {sessionId, backend, summary, parkedAt}[]`，每个键最多留 20 条。`/new`、卡片恢复、网页恢复替换绑定的时候，把被换下的那条写进去。旧文件没有这一项，照常读，不迁移。
2. 由 `sessions.json` 算出"这条会话属于哪个键"：现在绑着的，加上 `parked` 里的。`/resume` 和网页"可恢复"的候选，等于目录里的列表减去属于别的键的会话。私聊里只列这个人自己的私聊键和私聊话题键下的会话。
3. 选中时 daemon 再查一次：这条会话正绑在别的键上就拒绝，回"这条会话正在话题 X（或别处）里用"；不属于这个位置也拒绝。不能只靠界面上的过滤。
4. 主人在终端里开的、vonvon 不认识归属的会话，要请 owner 定：群里和主人的私聊照旧列出（bridge 的老行为，`agent/claude-agent/backend.ts:369-370` 的注释），管理员的私聊不列。
5. 体验检查 A 第 4 步加一句："另一个管理员在自己的私聊里 `/resume`，看不到主人的私聊会话。"

**工作量**：约 250 行，含测试。`session-store.ts` 约 60 行，`handle-message.ts` 两条恢复路径加列表过滤约 70 行，其余是测试。放在 s49，私聊的 `/resume` 上线之前必须有。群里的 A、C 两个问题可以在同一片里一起修，也可以拆成一个小修复 PR 先做。风险标签：并发、数据迁移（只是新增可选字段）。product.md 的 3.5 命令表 `/resume` 那一行，和第 4 节，要写明"只列这个位置自己的会话"。

**信心**：代码事实高；B 能不能真的发生，取决于 s49 会不会直接复用 `postResumeCard`，所以是中。

### 发现 2：网页"历史会话"的时间是记录的写入时间，不是最后一条消息的时间（采纳思路）

- Rakazo【确认】见 3.5。它修的就是"改设置也会把时间顶上来"，自己还留了一个"时间和预览用的不是同一套过滤"的小问题。
- 我们【确认】：`ConversationPanel.tsx:112` 显示的是 `item.updatedAt`，列表也不排序（`:88-95`）。`patchSession` 每次写都会把 `updatedAt` 改成当前时间（`session-store.ts:383`），触发写入的有：
  - `/model` 卡和网页选模型（`handle-message.ts:3365`、`:3380`、`:3401`、`:6752`）；
  - 撤回说明（`:1748`）；
  - 标题任务收尾（`session-store.ts:390-396`）；
  - 主区压缩标记（`handle-message.ts:1312`、`:1339-1343`）。
- 我们已经做对的：话题登记表的 `lastAt` 用的是消息时间，只往后走，按它从新到旧排（`bot/topic-registry.ts:90`、`:140-141`、`:158`），s48 列话题就用它。
- 建议：
  - "历史会话"的时间改成"最后一条进到这条会话的消息的时间"，取 `max(lastSeenAt, seen[].at)`，没有就取 `createdAt`，并按它从新到旧排。
  - 时间和摘要要用同一个口径，别犯 Rakazo 那个残留的错。
  - 主人在终端里接着聊的轮次反映不到这个时间里，在页面说明里写一句就行。
- 工作量：约 30 行（daemon 视图 10 行，界面 10 行，测试 10 行）。放在 s51b：那一片要删私聊的"话题"卡，网页成了唯一的会话列表。`docs/v1-plan.md:693` 已经说过"`summary` 的去留留给碰会话列表的片定"，可以一起定。不改承诺。信心高。

### 发现 3：清空的语义，Rakazo 是删除并停止，我们是停泊（不采纳，我们已有更合适的）

- Rakazo【确认】见 3.2：删掉全部消息，同时取消正在跑的运行，不能恢复；长期记忆保留。
- 我们【确认】：
  - `/new`、`/clear` 只是停泊旧会话，原生会话还在，能 `/resume` 回来（`handle-message.ts:3121-3192`；`docs/product.md:278`）。
  - 这一轮还在跑时，拒绝并说明，不顺手停掉（`:3143`）。
  - `/new` 之前发的、还在排队的消息不带进新会话，会告诉用户（`:2154`）。
  - "清空会话不删记忆"上一轮已经采纳（`docs/v1-plan.md:227`）。
- 不采纳的理由：会话是原生的 Codex 或 Claude 会话，主人在终端和 Codex 应用里也打得开（`docs/product.md:202`），删了会连带删掉主人能看到的东西。"连带停止"会和原生会话的关闭、s15 的占位顺序抢时机。我们有 ⏹，先停再 `/new` 就够了。
- 可以借的一点（不另开片）：Rakazo 的确认框把后果写全了，"删除所有消息，并停止当前工作"（`dialogs.tsx:366-372`）。我们的清空卡已经写了"飞书聊天记录不受影响，旧会话能 `/resume`"（`card/command-cards.ts:226-245`），s49 私聊的 `/new` 沿用同一张卡就行。信心高。

### 发现 4：压缩和序号连续，我们已有对应的机制（我们已有）

| Rakazo 的做法 | 我们的对应 |
|---|---|
| 每次用摘要前都核对序号连续，不连续就退回完整窗口（`history-compaction.ts:61-85`） | 补拉成功才推进水位，失败只记下触发消息，下一轮从原水位重拉（`docs/v1-plan.md:441`）。`seen` 超过 64 条时丢最旧的，被丢的那条下一轮可能再带一次（`session-store.ts:101-103`）。两边都是宁可重复，不丢 |
| 代号 `historyCompactionGeneration`，清空时加一，压缩写回用 CAS（`:428-439`） | 会话 id 起到代号的作用：`usage`、`topicsDue`、`compactSeen` 都绑在会话 id 上（`session-store.ts:50-62`）；撤回说明只在会话 id 没变时才写（`handle-message.ts:1748`）；标题任务按 key 条件清除，"挡住并发的 /clear 或 /resume"（`session-store.ts:388-396`） |
| 清空不重置序号，把删掉的标成已压缩（`events.ts:326-345`） | `/new` 把水位设在命令那一刻，`from` 设在命令之后，重建也不会往前拉（`handle-message.ts:3179-3192`） |
| 摘要由自己生成、转义、标成不可信 | 压缩交给原生会话，我们不保存摘要；压缩以后在主区附话题表（`docs/product.md:217`） |

结论：机制已经有了，不搬代码。Rakazo 的四个测试用例名（见 3.3）可以当作我们并发测试的提纲，对应到"`/new` 和标题任务、用量写回、撤回说明同时发生"这几种情况。信心高。

### 发现 5：压缩检测只记主区会话，s38 承诺的"压缩以后整份重交"要覆盖所有会话（采纳思路）

- Rakazo【确认】：每个用到摘要的地方，都在用的那一刻重新核对（`executor.ts:3747`，每次运行都调 `selectCompactedHistory`），不信一个存下来的标记。
- 我们【确认】：
  - `noteCompaction` 一开头就是 `if (!id || !isMainKey(...)) return`（`handle-message.ts:1336`），所以 `compactSeen` 只记主区会话（`session-store.ts:59-62` 的注释写着 "Main sessions only"）。
  - 运行中看到压缩时，`markTopicsDue` 也只对主区生效（`:1314-1318`）。
  - `thread.lastCompaction` 对所有会话都拿得到（`agent/types.ts:303`），只是没记下来。
- 冲突：product.md 说"会话压缩以后的第一轮整份再交一遍"，对所有会话都成立（`docs/product.md:424`），而 `docs/v1-plan.md:1080` 写的是"和 3.5 压缩后附话题表同一个时机"。话题表只给主区，照着这句实现，话题会话和私聊会话压缩以后就不会重交设置。
- 建议：
  - s38 给每个会话键都记 `compactSeen`，另加一个绑在会话 id 上的 `settingsDue`。主区的 `topicsDue` 不变，只给主区。
  - 话题会话、私聊会话、私聊话题各测一次：在终端里 `/compact` 以后，下一轮带上整份设置。
  - `docs/v1-plan.md:1080` 改成"每条会话压缩后的第一轮；主区同时附话题表"。
- 工作量：约 40 行加测试，放在 s38。不改承诺，是把已有的承诺实现完整。信心高。

### 发现 6：读另一条 Claude 会话时，"最终回答"要和运行卡、Codex 的 `final_answer` 一致（采纳思路）

- Rakazo【确认】：给发件方的只有最终回复，工具调用前的过渡文字不进历史；最终回复为空时，用最后一段过渡文字顶上（5b35ea7，`executor.ts:8514-8516`、`:7550-7558`）。检索只返回文字类的块，不返回工具痕迹（`history-retrieval.ts:94-116`）。
- 我们【确认】：
  - 承诺是"返回用户的消息和 bot 的最终回答，不含工具步骤"（`docs/product.md:310`、`:819`）。
  - Codex 这一半用 summary 视图，只给 `final_answer`（`docs/v1-plan.md:939`）。
  - Claude 这一半的开工要点只写了"滤掉工具步骤、思考块和合成的通知条目"（`:941`），没提工具调用前的过渡文字。现有的 `foldSessionMessages` 会把一轮里所有 assistant 文字用空行连起来（`agent/claude-agent/history.ts:132-134`），s48 要是复用它，过渡话就会混进"最终回答"。
  - 运行卡的规则是"最后一段非空文字就是回答"（`card/run-card.ts:306`、`:390-396`）。
  - 顺带的问题：恢复卡每一轮显示的是拼好的 assistant 文字的前 800 字（`card/history-card.ts:36`、`:156`）。Codex 那边 `mapTurn` 会把 commentary 排在前面一起拼进去（`agent/codex-appserver/backend.ts:800-802`、`:834`），过渡话一长，真正的回答就被截掉了。【推断】
- 建议：
  - s48 写一个公用函数"一轮的最终回答"：取最后一次工具调用之后的最后一段非空文字，没有就取这一轮最后一段非空文字，再没有就标"这一轮没有文字回答"。Claude 读取和运行卡用同一条规则，Codex 用 `final_answer`。
  - s48 按计划把 `thread/read` 换成 `thread/turns/list`（`docs/v1-plan.md:939`）时，恢复卡也改用这个函数，显示最终回答，不显示开头的过渡话。
- 工作量：约 30 行加测试，放在 s48。不改承诺。信心：规则上的缺口高，对用户的影响中。

### 发现 7：多段回答之间留空行（a1c5e4f）（我们已有）

我们的文字块按 itemId 分开存。Claude 每个内容块单独发一个 itemId（`agent/claude-agent/event-map.ts:231`），Codex 每个 agentMessage 一个 itemId。运行中的卡把各段用 `\n\n` 连起来（`card/run-card.ts:403-410`）；结束的卡只把最后一段当回答，前面的折进过程区（`:295-320`）。历史摘要两边也都用 `\n\n` 连（`agent/codex-appserver/backend.ts:834`；`agent/claude-agent/history.ts:132-134`）。Rakazo 修的"…/drafts/42Nothing has changed…"那种粘连，在我们这里不会出现。不用做。信心高。

### 发现 8：s48 读会话的返回形状，要有预算、标明覆盖范围、能续读、无权和不存在同形（采纳思路，重提上一轮第 1 名）

- Rakazo【确认】，`packages/db/src/history-retrieval.ts`：
  - 范围只由执行器给（`:6-15`），可见性谓词同时管锚点和相邻消息（`:55-80`）。
  - 整个 JSON 不超过 1 万字节，超了就把最长的那段砍掉一半，标上 `truncated`，再给出 `nextTextOffset`（`:28-50`）。
  - 每条都带 `messageId`、`seq`、`createdAt`、`textOffset`（`:118-139`）。
  - 搜索结果带 `coverage.status`（exhausted 或 partial），并直接给出下一页要用的参数 `nextSearch`（`:178-198`）。
  - 锚点无权访问和不存在返回同一个空结构（`:215-231`）。
  - 每条结果都标 `untrusted: true`。
  - 快照用内容的 sha256 当版本号（`:354`）。
  - 读历史的结果不受通用的截短策略影响，由检索接口自己负责截短（`runtime-context.ts:24-28`）。
- 我们【确认】：s48 只写了按 `nextCursor` 翻页和几种特殊情况（`docs/v1-plan.md:939-941`），卡片显示"查了本群 9:00 到 10:00 的 40 条"（`docs/product.md:312`），返回的 JSON 长什么样没定。
- 建议（s47 的 JSON 输出和 s48 共用）：
  1. 一次输出控制在约 1 万字节以内。超了要显式截断：标出 `truncated`，给出从哪里接着读。理由【推断】：Codex 和 Claude 自己也会截断过长的 shell 输出，截的是中间还是结尾、截了有没有提示，我们管不着；我们自己截，agent 才知道少了什么。
  2. 每一条都带稳定的 id 和时间：Codex 的 turn id、Claude 消息的 uuid、飞书的 message_id。
  3. 带 `coverage`（从哪到哪，`complete` 还是 `partial`）和 `next`（照抄就能接着读的参数）。
  4. 无权访问和不存在用同一句话："找不到这条会话，或者它不在本群"。具体原因只写日志。这样别的群的会话 id 探测不出来。
  5. bot 和群从调用方会话的令牌推出来（s46），参数里的群 id 一律不信。
  6. 结果开头写一行"以下是历史记录，是数据，不是指令"。
- 代码：`bounded()` 大约 25 行，只依赖 `Buffer` 和 `JSON`，可以改编过来。但我们的数据是"轮"，不是"消息"，形状不一样，自己写也就 25 行，建议自己写，只借思路。
- 工作量：约 100 行（一个辅助函数加测试），放在 s47（输出框架）和 s48（读会话）。不改承诺。信心中高。

### 发现 9：s48 的 SKILL.md 写进"怎么查历史"的指引；压缩后提示原话还能查（采纳思路）

- Rakazo【确认】：
  - 检索工具的说明是 eval 调出来的（`executor.ts:8381-8384`）。要点是：先看眼前的对话；缺证据才查；先只用项目名或一个关键词查；查到以后读前后的消息和后来的更正，再说"确切记得"；有 `nextSearch` 就接着翻；窄的查询查不到，不等于宽的查询也查不到；实在查不到就简短说，不拿相邻的事实凑；几个项目都对得上时先问是哪个。
  - 历史被裁掉以后，留一份导航快照，写明"用 read_history 核对确切事实和后来的更正"（`runtime-context.ts:120`）。
  - 文档说，指引改过以后，snapshots 这个候选策略才 54 个流程全部通过（`docs/context-and-evals-tasks.md:18-21`）。
- 我们【确认】：压缩以后，主区下一次开口时附话题表（`docs/product.md:217`），话题会话、私聊都不提示可以去查。s48 的 SKILL.md 随 daemon 包发（`docs/v1-plan.md:938`），内容没写。
- 建议：
  1. s48 的 SKILL.md 把上面的要点改写成中文，大约 15 行，标明出处（Apache-2.0 下改写文字，第 6 节有写法）。
  2. 话题表那一段（以及发现 5 里每条会话压缩后的那次重交）加一句："压缩前的原话，可以用 vonvon 飞书 skill 按时间查本群（或本私聊）的消息。"
  3. 私聊会话能不能用这个 skill 查本私聊的消息，product.md 3.5 只写了群（`:311-312`）。s49 和 s48 要补一句。按"bot 查自己看得到的飞书内容"的原则，应当可以查。
- 工作量：约 20 行，放在 s48。不改承诺；私聊能查本私聊这一点要在 product.md 写一句。信心中：他们的 eval 用的是他们的模型和工具，我们要在 M8 的验收里用真实 Codex 和 Claude 各问一次"上周说的端口号是多少"。

### 发现 10：一个 bot 几条线程、跨线程带什么（我们已有，更细）

- Rakazo 见 3.1、3.4：没有话题，没有 `/new`、`/resume`；一个 Slack 频道里的所有线程合成一条对话（d1 第 10 条，不采纳）；跨线程靠记忆和 bot 之间的消息，历史检索不跨线程。
- 我们：
  - 按飞书位置分会话，主区、话题、私聊、私聊话题各一条（`docs/product.md:192-200`；s49 的私聊话题按 `thread_id` 单独成会话，`docs/v1-plan.md:965`）；
  - 主区和话题之间只靠带两边会话 id 的引用行互相找（`docs/product.md:208-217`）；
  - s48 可以读另一条会话，但只限同一个 bot、同一个群（`:311`）；
  - 记忆按位置分（d4 F1）。
- 结论：不改，也不搬。Rakazo"历史检索不跨线程"和我们"私聊的会话在群里读不到"是同一个方向，但我们的切分更细。要守住的是发现 1 和发现 8 里"范围由服务端推出"的原则。信心高。

## 5. 按切片汇总

| 切片 | 要做的 | 来自 |
|---|---|---|
| s49 | 会话归属账（停泊会话记归属），`/resume` 按归属过滤，选中时 daemon 再查；体验检查 A 第 4 步加一句；product.md 3.5 `/resume` 那一行和第 4 节补定义；终端开的会话列不列请 owner 定 | 发现 1 |
| s49（或先出一个小修复 PR） | 群里 `/resume` 和网页恢复不能把正在用的会话再绑一次；共用目录时不列别的群的会话 | 发现 1 |
| s38 | 每条会话都记 `compactSeen` 和 `settingsDue`；`docs/v1-plan.md:1080` 改写 | 发现 5 |
| s47/s48 | 输出预算、覆盖范围、续读参数、id、无权和不存在同形、范围从令牌推出 | 发现 8 |
| s48 | Claude 的"最终回答"规则和运行卡一致，恢复卡也用它；SKILL.md 写查历史的指引；压缩后提示原话可查；私聊能不能查本私聊写进 product.md | 发现 6、9 |
| s51b | "历史会话"的时间改成最后一条消息的时间并排序，顺带定 `summary` 的去留 | 发现 2 |
| 不做 | 破坏性清空，清空时连带停止；按频道合并线程；Rakazo 自管的压缩和上下文策略 | 发现 3、10，d1、d4 |

## 6. 复用代码和许可

这一题没有必须搬的代码。唯一的候选是 `packages/db/src/history-retrieval.ts:28-50` 的 `bounded()`（约 25 行，只依赖 Node 的 `Buffer` 和 `JSON`），建议自己写（理由见发现 8）。万一要搬，或者在 SKILL.md 里改写 `executor.ts:8383` 那段指引文字，照我们已有的先例做：

- 文件开头写两行：`// Adapted from elie222/rakazo packages/db/src/history-retrieval.ts at b884f43.` 和 `// Licensed under Apache-2.0; see NOTICE.`，写法照 `packages/daemon/src/server/atomic-file.ts:1-2`。Rakazo 的 LICENSE 里没有版权行，仓库也没有 NOTICE 文件，所以版权写"Rakazo contributors"。
- 根目录 `NOTICE` 加一段，写明改编了哪个文件、哪个提交、改了什么，格式照现在的 Paseo 那段。
- 包里放一份完整的 Apache-2.0 原文，参照 `packages/daemon/LICENSE.paseo`，起名 `LICENSE.rakazo`。
- 改写的文字（SKILL.md）在 SKILL.md 末尾注一行出处即可。

## 7. 没查的和局限

- 没运行 Rakazo，所有"会出的问题"都是读代码推出来的。发现 1 的 A、B、C 三个场景也没在我们这边实际跑过；B 要等 s49 写出来以后才能验证。
- 发现 1 说的"两个群可以选同一个文件夹"，是在 `packages/daemon/src/project/`、`handle-message.ts` 里没搜到校验得出的，没在界面上试。
- Supermemory 是否严格按 container tag 过滤召回，没读外部服务。
- Codex 和 Claude 截断 shell 长输出的具体规则，这一轮没核实（发现 8 第 1 条）。
- Rakazo 的 `selectContext`、`cache-aware` 投影和 16b99f2 这些上下文策略细节没有展开。它们都是 Rakazo 自管模型输入时才需要的，d4 F5 已判为不适用。
- 移动端（`apps/mobile`）清空和侧栏的实现没看。
