> 原始深挖，没有逐条复核；和 report.md 冲突时以 report.md 为准。

# Slack/team-chat 接入，对照我们的飞书接入

Rakazo 固定在 b884f43（`<home>/vonvon/references/rakazo-b884f43`），对照 vonvon-bot main 898d3c5。Rakazo 路径都相对它的仓库根，写成 `路径:行号`；我们的代码写 `packages/daemon/src/...:行号`，规格写 `docs/product.md:行号` 或切片号。

标注：【确认】是读源码确认的；【推断】是从代码推出来、没有运行验证的。整轮只读：没有运行 Rakazo 的任何代码，没装依赖，没联网，没改 vonvon-bot。Rakazo 依赖的 `chat`、`@chat-adapter/slack`、`chat-adapter-lark` 没装，源码不在仓库里，所以 Slack 验签、`isMention`、线程 id 的编码只能从调用方和测试推。我们这边的飞书 SDK 行为，读的是 `<home>/vonvon/worktrees/accept/node_modules/@larksuiteoapi/node-sdk`（1.71.1，和 `packages/daemon/package.json:38` 锁的版本一致）的 `lib/index.js`。

## 0. 结论

1. **上一轮说 Rakazo 没有外部 IM，这是错的。** e55263f 里已经有 Slack 的 team-chat 接入（`apps/api/src/team-chat-bridge.ts` 1297 行、`team-chat-judge.ts` 342 行），还有一条"个人线路"，接 iMessage/SMS、Slack、WhatsApp、Telegram 和飞书私聊。上一轮说的 team-chat 判断，其实只给 Slack 房间用，不是 app 内群聊的机制。详见第 1 节。
2. 在飞书侧，Rakazo 的 team-chat **整体上没有我们完整**：没有流式，也不编辑消息；不处理 429；一个 Slack 频道的所有线程共用一条对话；任何 Slack 成员 @ 网关 bot 都能用主人的身份跑一轮；别的 bot @ 它没有跳数上限；回复发送失败一次，这条回复就丢了。这些地方我们已有的做法更好，不要往回学。
3. 值得借的是 6 个具体机制，都小，都在入站一侧：
   - 历史里的链接保留目标（3ac1f80）。我们的记录块和引用会丢 `href`。
   - 附件下载失败时，要在提示里写明。我们在"有文字又有附件"时，失败的附件会悄悄消失。
   - 附件要放在会话读得到、下一轮还在的地方（22aed2a）。我们的附件放在全局目录，1 小时后删掉，而且按代码注释，Codex 的只读档读不到。
   - 前几条消息的附件，按"新的优先、最多 4 个"一起带进这一轮（65a06c8）。
   - 入站分类的测试，要走真实的 SDK 解析（b3a5d36 的教训）。
   - 智能模式下主动接话的那一轮：带上判断理由；没话说或失败时不在群里出卡。另外，可以先去抖、再成批判断。这两条要改 product.md。
4. 不建议复用 Rakazo 的代码。能独立拿出来的纯函数只有 `newestFirstFileLimits`（14 行），自己写一样快。真要复制，就照 `packages/daemon/src/server/atomic-file.ts:1-2` 和根 `NOTICE` 的先例标来源，见第 4 节。

## 1. 纠正上一轮

| 上一轮的说法 | 实际情况【确认】 |
|---|---|
| `docs/research/2026-10-17-rakazo/product-ux.md:112` 说没对外部渠道下结论；上一轮的交接笔记（本机，不在仓库） §2 写"自有 Web、桌面和移动端聊天，不接第三方 IM"；`report.md` 的对比表写"主要交互：自有 Web、桌面和移动聊天" | e55263f 已经有两条外部 IM 路线：`git show e55263f:apps/api/src/team-chat-bridge.ts` 有 1297 行，`team-chat-judge.ts` 342 行，`packages/adapters/src/messaging-platforms.ts` 314 行（里面已经有 Lark），`apps/web/src/pages/ExternalConversationSettings.tsx` 260 行。所以这不是后来新加的功能，是上一轮漏看了 |
| `product-ux.md:49` 和交接笔记 §2 的"群聊"一行，把 team-chat judge 当成 Rakazo 群聊的主动参与机制 | `ModelTeamChatEngagementJudge` 只有 TeamChatBridge 一个调用方（`apps/api/src/app.ts:815-834`，`apps/api/src/team-chat-bridge.ts:1099-1111`），只判断 Slack 房间里没 @ 的"环境消息"。app 内群聊（ChatGroup）走 `packages/core/src/group-mentions.ts` 和 handoff，不调判断 |
| 上一轮没提飞书 | Rakazo 接了飞书/Lark，但只接私聊：`packages/adapters/src/messaging-platforms.ts:176-195` 的 `capabilities: { direct: true, groups: false }`，群消息在 `packages/adapters/src/chat-sdk-surface.ts:297` 被丢掉；只走 webhook，不走长连接（`:183-189`，`.env.example:222-233`）；绑定靠在私聊里发链接码（`apps/api/src/messaging-inbound.ts:78-166`） |
| Rakazo 自己的文档也有误：`docs/self-host.md:432` 写"Groups stay iMessage-only"，`CHANGELOG.md:27` 写"Group conversations remain iMessage-only" | 这只对个人线路成立。配了 `TEAM_CHAT_BOT_ID` 以后，Slack 频道走 team-chat（`apps/api/src/team-chat-startup.ts:18-28`）。上一轮可能被这两处文档带偏了 |
| 代码地图【推断】：Slack 429 "只能靠 SDK 内部处理，或者走失败重试" | 读源码追下来，**失败后不会重发**。`deliverCompletion` 抛错后，`retry()` 让这一行留在 `delivering`（`team-chat-bridge.ts:1543-1549`），约 2 秒后对账再进 `deliverCompletion`（`:917-919`）。`reserveDelivery` 认不了领（状态已经不是 `running`，`:1474-1481`），就走"租约过期、没有 handle"那个分支，标成 `delivered/"unconfirmed"`（`:1493-1509`），回复丢掉。这是静态追路径得出的，没运行 |

## 2. Rakazo 的 team-chat，端到端

### 2.1 两条路线和路由

- **team-chat**【确认】：部署级只有一个"网关 bot"，由环境变量 `TEAM_CHAT_BOT_ID` 指定（`.env.example:208`）。Slack 凭据也只有一套：`SLACK_BOT_TOKEN` 和 `SLACK_SIGNING_SECRET`（`:204-205`，`messaging-platforms.ts:121-131`）。`prefersTeamChatSurface` 的判断条件是：配了网关 bot，并且消息是 Slack 的，或者带 workspaceId（`team-chat-startup.ts:18-28`）。满足就进 TeamChatBridge（`app.ts:898-916`）。bridge 还没起来时，消息先缓冲，最多 100 条；超出就报错，让 Slack 重推，不落到个人线路（`app.ts:904-915`，`team-chat-startup.ts:4,31-62`）。
- **个人线路**【确认】：没配网关 bot 时，Slack 私聊也走这条。地址要先用链接码绑到某个用户的 bot 上，私聊里的消息进这个 bot 唯一的一条线程。app 里和这个 bot 的对话也是这条线程（`messaging-inbound.ts:111-122`，`Thread.botId @unique` 在 `packages/db/prisma/schema.prisma:528`）。
- Slack 还有第三个身份：Composio/Pipedream 连接器，让 bot 能搜 Slack、发 Slack（`apps/api/src/onboarding.ts:37-64`）。它和上面两条接入路线无关。

### 2.2 入站

| 环节 | 做法 | 出处 |
|---|---|---|
| 事件进来 | 路由是 `/api/v1/messaging/webhook/:provider`，验签在各平台的 SDK 适配器里做（`apps/api/src/messaging-webhook.ts:6-18`）。请求体最多 256 KiB，没有可信的 Content-Length 时边读边截（`chat-sdk-surface.ts:26,249-258,393-409`）。SDK 用 `waitUntil` 登记的工作全部跑完才回 ACK；我们这边的 sink 失败就回 500，让平台重推（`:262-278`）。状态 webhook 要在验签通过以后才解析（`:279-284`） | 【确认】 |
| 不丢第二条消息 | Rakazo 的注释说，SDK 默认的 `drop` 并发模式在锁被占时会静默丢掉第二条消息，所以改成 `concurrent`（`chat-sdk-surface.ts:76-83`）。四个处理器都接到同一个 `deliver` 上（`:98-105`） | 【确认】代码；SDK 的行为是 Rakazo 注释里的说法 |
| @ 识别 | 用 SDK 的 `message.isMention` 或 `app_mention` 事件判断（`chat-sdk-surface.ts:324`，`messaging-platforms.ts:257-263`）。b3a5d36 修了一个 bug：Slack 对同一次 @ 会发 `app_mention` 和 `message.channels` 两个事件，SDK 只保留先到的那个；普通事件先到时，手写的 `authorizations` 查找拿不到数据，@ 被误判成环境消息，bot 不回。修法是删掉手写的匹配，改用 SDK 的标志，并加一条经过真实 Slack 适配器的测试：签名请求，HTTP 传输打桩（`packages/adapters/src/chat-sdk-surface.test.ts:112-190`）。@ 了别人仍算环境消息，照样走监听策略（`messaging-platforms.ts:258-262`）。只有上游没给 kind 时，才用正则 `@word` 兜底（`team-chat-messaging.ts:44-47`） | 【确认】 |
| bot 自己的消息 | `author.isMe` 和系统消息直接丢掉（`chat-sdk-surface.ts:293`）。别的 bot 按 `bot_id`、`bot_profile` 或 `subtype=bot_message` 标成 `senderIsBot`（`messaging-platforms.ts:244-254`） | 【确认】 |
| 频道和线程的映射 | 一个 Slack 频道对应一个 `ExternalConversation`，唯一键是 provider+workspace+channel；对应一条 Rakazo Thread（`schema.prisma:1341-1365`，`:534`）。频道里的所有 Slack 线程共用这一条对话，每条消息只记自己的 `replyThreadId`（`schema.prisma:1377`）。`ExternalConversation.conversationId` 每来一条消息就被改成这条消息的 SDK 线程 id（`team-chat-bridge.ts:456-457`），出站时用它和 `replyThreadId` 拼回目标（`team-chat-messaging.ts:54-66`） | 【确认】 |
| 回复落点的竞态 | `replyThreadId` 为空时（频道根消息），回复目标直接取会话行上的 `conversationId`（`team-chat-bridge.ts:1414`，`team-chat-messaging.ts:58`）。这个值是**投递那一刻**频道里最后一条入站消息的线程 id，不一定是触发这一轮的那条消息的。`team-chat-messaging.test.ts:105-107` 也说明他们知道这个值里会带"过时的线程段" | 【推断】：结果取决于 SDK 怎么编码根消息的线程 id，没验证 |
| 历史回填（76f4259） | 只在被 @ 或私聊的消息**第一次**落进一个没见过的 Slack 线程时触发（`team-chat-bridge.ts:339-368`，`knowsReplyThread` `:370-385`）。最多 50 条，超时 1 秒（`team-chat-messaging.ts:68-106`），用 SDK 的 `fetchMessages(direction:"backward")` 截到当前消息之前（`chat-sdk-surface.ts:174-193`）。同一线程的并发回填合并成一次（`threadBackfills`）。回填进来的消息记成 `ignored/thread_history`，只进转写，不触发运行（`:387-431`）。回填先把一条实时消息记成历史时，会改回来（`:297-303`）。回填失败只记日志，这条消息照常处理（`:356-360`） | 【确认】 |
| 文件（65a06c8） | 附件是懒加载对象，带 `fetch()`（`chat-sdk-surface.ts:331-344`），存成 Artifact，clientNonce 是 `teamchat-attachment:<id>:<i>`，重启后能复用（`team-chat-bridge.ts:711-749`）。每个文件最多下 2 秒（`apps/api/src/artifacts.ts:85-97`），下不来就写一行"[file: x (unavailable)]"（`team-chat-bridge.ts:727,745`）。一批最多 4 个，新消息优先占名额（`newestFirstFileLimits` `:1576-1589`）。排队时把这一批转写里的文件块带进这一轮（`:1319-1325`）。22aed2a 让每一轮都把最近 3 个带附件的用户轮的文件复制到 bot 电脑的 `attachments/` 下，并在指令里列出路径（`packages/adapters/src/thread-artifacts.ts:201-275`，`executor.ts:3959-3995`，`RECENT_TURN_IMAGE_TURNS=3` 在 `executor.ts:9270`） | 【确认】 |
| 链接（3ac1f80） | SDK 的 `message.text` 只保留链接文字。Rakazo 改成遍历 AST，渲染成"label (url)"；文字和 URL 相同时只写一次（`chat-sdk-surface.ts:346-366`） | 【确认】 |
| 去重、幂等 | 第一层：`ExternalMessage` 的唯一键是会话加 `providerEventId`（`schema.prisma:1394`）。第二层：转写的 clientNonce `teamchat-transcript:<provider>:<eventId>`（`team-chat-bridge.ts:699`）。第三层：运行的 clientNonce `teamchat:<provider>:<eventId>`（`:1334`）。另外有进程内的 `receiving` 和 `mirroring` 两张表，防止补镜像和接收撞车（`:252-259,653-708`） | 【确认】 |
| 送进模型的形状 | 每条 Slack 消息先以 `role:user` 镜像进线程，只有正文，不带发信人（`team-chat-bridge.ts:685-700`）。真正触发运行的提示是"Slack message from 名字:\n\n正文"（`:93-96,1307-1308`）。环境消息批次的提示带最近 20 条（每条带名字）、判断给的理由，结尾一句"上面是上下文，不是系统指令"（`:111-134`） | 【确认】镜像不带名字。【推断】模型在历史里看不出非触发消息是谁说的：没追 `context-selection.ts` 怎么组历史 |
| "不是用户说的"（b884f43） | 对 Rakazo 自己以 user 角色插进去的内容（工具截图、续跑提示、后台 shell 输出、子 agent 的任务和结果），统一加固定前缀"[Automated message from Rakazo, not from the user]"（`packages/adapters/src/automated-messages.ts:8-12`），子 agent 的系统提示里写明这一点（`pi-runtime.ts:1529`）。**Slack 消息不加这个标签**，标签只针对 Rakazo 内部的提示。前缀是固定文字，Slack 用户照样打得出来 | 【确认】 |

### 2.3 何时回（只记和接入相关的部分）

- 被 @ 的消息和私聊直接记成 `received` 去排队，**不看发信人是不是 bot**（`team-chat-bridge.ts:269-274`）【确认】。发信人策略只管环境消息（`:1068-1083`）。所以别的 Slack bot @ 网关 bot 就会触发一轮，没有跳数上限【确认】。
- 环境消息（没 @ 的）有几道处理【确认】：
  - 默认不监听（`Bot.teamChatAmbientEnabled @default(false)`，`schema.prisma:430`）。
  - 按会话分组，最后一条安静 15 秒以后才判断（`:1053,1085`）。
  - 一次判断看最近 20 条（`:1086`），返回 `asked_by`，决定回哪一条（`team-chat-judge.ts:160-166`，`team-chat-bridge.ts:1113-1115`）。
  - 判断不回，整批标成 ignored（`:1116-1118`）。
- 两个副作用【推断】：频道一直有人说话时，环境消息一直等不到判断；一批超过 20 条时，前面的消息不进判断，但会跟着整批被标成 ignored。

### 2.4 出站

| 环节 | 做法 | 出处 |
|---|---|---|
| 流式、编辑 | 都没有。`MessagingSurface` 只有 `sendToThread`、`openDirectThread`、`sendTyping` 和可选的 `fetchThreadHistory`（`packages/adapter-kit/src/interfaces.ts:382-433`）。Slack 的 typing 是 false（`messaging-platforms.ts:124`）。team-chat 只在运行结束后发一条：取这一轮最后一条 bot 消息里的 text 块（`team-chat-bridge.ts:98-109,1392-1419`）。个人线路是运行结束后把这一轮的每条 bot 消息都发出去，即分段发（`messaging-delivery.ts:41-121`，`background-job-handlers.ts:57-69`） | 【确认】 |
| 长度上限 | `message_user` 的上限可以用 `RAKAZO_MESSAGE_USER_MAX_CHARS` 配（da0a7c0）。但 team-chat 只发最终回复，`message_user` 的进度消息根本不到 Slack。`sendToThread` 不切分长文（`chat-sdk-surface.ts:134-148`） | 【确认】；超过 Slack 上限时会怎样是【推断】：抛错后按上面的路径丢掉 |
| 幂等键 | `createMessagingTeamChatSender` 把 `idempotencyKey` 传下去（`team-chat-messaging.ts:123-129`），但 `ChatSdkMessagingSurface.sendToThread` 根本不用它（`chat-sdk-surface.ts:134-148`）。发送的 signal 永远不会 abort，没有超时（`team-chat-messaging.ts:121`） | 【确认】 |
| 最多发一次 | 先认领 `delivering`，存了 handle 再改状态（`sendOnce` `:1446-1469`）。租约过期又没有 handle 时，标成 `unconfirmed`，宁可丢回复也不重复发（`reserveDelivery` `:1471-1511`）。结合上面的 `retry()`，**任何一次发送抛错，这条回复都会丢**。委托回复（`deliverDelegatedReplies` `:927-978`）反过来，是先发后标记，崩溃时可能重发 | 【确认】代码；"一次报错就丢"是静态追路径得出的 |
| 限流 | Slack 没有 429 或 Retry-After 处理，bridge 自己的退避是 `min(60s, 1s·2^n)`（`:1526-1566`）。整个代码里唯一的平台上限，是 Sendblue 的连续外发 140 条（`messaging-delivery.ts:19`） | 【确认】 |
| 失败时用户看到什么 | 被 @ 的那一轮失败时，发固定的英文"X could not complete that request. Open Rakazo for details."（`:1421-1439`）。环境消息那一轮，失败不说话，没写回答也不说话（`:1406-1409,1427-1430`）。这一轮问人（`ask_user`）时，运行处在 `waiting_input`，bridge 只在 completed/failed/cancelled 时投递（`:917-922`），Slack 里什么都看不到；`ask_user` 在 team-chat 里没被去掉（`executor.ts:8046-8112`） | 【确认】；`ask_user` 那一轮"卡住"是【推断】 |
| 并发 | team-chat 用 `allowParallelRun:true`（`team-chat-bridge.ts:1336`），跳过插话和排队（`packages/db/src/events.ts:229-232,422-434`），同一频道的几轮在同一条线程上并行跑 | 【确认】 |

### 2.5 管理面

- **接进工作区**【确认】：运维填两项 Slack 环境变量加 `TEAM_CHAT_BOT_ID`，一个部署只有一个 Slack 应用、一个网关 bot（`.env.example:202-213`）。仓库里没有 Slack 应用清单、scope 列表或 OAuth 安装流程（grep `chat:write`、`app_mentions:read`、`manifest` 都没有结果）。
- **选频道**【确认】：没有频道选择。bot 被拉进哪个频道，哪里就有人能用；频道在第一条消息到达时自动出现在"Team conversations"里（`MessagingSettingsOverlay.tsx:334-382`），没有消息之前显示"No team conversations yet."。
- **每个频道的策略**【确认】（`ExternalConversationSettings.tsx`）：
  - 监听有三态：继承 bot 默认、监听、仅 @（`:15-23,97-121`）。
  - 房间规则最多 4000 字，可以一键恢复默认（`:124-157`）。
  - 自动发件人有四种处理：忽略、汇总（每 N 小时）、总是处理、当成真人（`:58-63`；`packages/contracts/src/domain.ts:214-240`）。列表从这个频道最近 100 条 bot 消息里自动发现（`packages/db/src/external-conversations.ts:33-38,69-76`）。
- **权限**【确认】：任何 Slack 成员 @ 网关 bot 或私聊它，都会以网关 bot 主人的 userId 跑一轮（`team-chat-bridge.ts:451-453`），用主人的工具和记忆。只有"唤醒例行任务"要求发信人已经绑定（`apps/api/src/messaging-inbound.ts:263-298`）。

## 3. 对照我们，建议

| # | 专题 | 建议 | 切片 | 改 product.md 承诺 | 把握 |
|---|---|---|---|---|---|
| 1 | 记录块和引用里的链接保留目标 | 采纳思路 | s14a 跟进（小修） | 否 | 高 |
| 2 | 附件下载失败要写进提示 | 采纳思路 | 小修 | 否 | 高 |
| 3 | 附件放在会话读得到、下一轮还在的地方 | 采纳思路 | s31、s39，或单独一片 | 是（变强） | 中 |
| 4 | 前几条消息的附件按"新的优先、最多 4 个"一起带 | 采纳思路 | s14a 跟进、s25 | 是（多做） | 中 |
| 5 | 入站分类测试走真实 SDK 的 `normalize` | 采纳思路 | s25、s27 | 否 | 高 |
| 6 | 智能模式主动接话的那一轮：带判断理由；没话说或失败时不在群里出卡 | 采纳思路 | s25 | 是 | 中 |
| 7 | 智能模式没点名的消息：去抖后成批判断，由判断选回哪一条 | 采纳思路 | s25、e12 | 是 | 中 |
| 8 | 自动发件人策略（忽略、汇总、总是处理、当成真人） | 不采纳（v1），写进 §10 | — | 采纳就会变 | 中 |
| 9 | 回复投递：最多发一次，确认不了就标 unconfirmed | 我们已有（更好） | — | 否 | 高 |
| 10 | 一个频道一条对话、并行跑、回复落点取会话行 | 不采纳 | — | 否 | 中 |
| 11 | 去重、幂等、排除 bot 自己的消息、启动时缓冲 | 我们已有 | — | 否 | 高 |
| 12 | 进入新线程时回填历史 | 我们已有 | — | 否 | 高 |
| 13 | 出站：流式、长度、限流、失败时的提示 | 我们已有 | — | 否 | 高 |
| 14 | 谁能触发；bot 互相 @ 没有跳数上限 | 我们已有 | — | 否 | 高 |
| 15 | 管理面：接入、选频道、每个频道的策略 | 我们已有 | — | 否 | 高 |
| 16 | 把频道里的全部消息镜像进本地库 | 不采纳 | — | 否 | 高 |
| 17 | 自动消息加固定标签（b884f43） | 我们已有更强的设计 | s38 | 否 | 中 |
| 18 | Rakazo 的飞书接入：只做私聊、webhook、链接码 | 不采纳 | — | 否 | 高 |

### 1. 记录块和引用里的链接保留目标（采纳思路）

- **Rakazo**：`chat-sdk-surface.ts:346-366` 把链接渲染成"label (url)"。
- **我们**：触发消息由 SDK 解析，富文本里的 `a` 节点渲染成 `[label](href)`，链接是保留的（SDK `lib/index.js:98779-98781`）。但记录块、话题开场和被引用消息走的是我们自己的 `extractMessageText`（`packages/daemon/src/bot/context-weave.ts:545-583`，调用在 `:485`）。它对 `a` 节点只要有文字就丢 `href`：富文本在 `context-weave.ts:628-629`，卡片在 `:704-705`。现有测试把这个行为写死了（`packages/daemon/test/context-weave.test.ts:43-55` 期望"你好链接"，`:113-123` 期望"查看文档"）。
- **后果**：群里有人发"见[设计文档](飞书文档链接)"，bot 在记录块里只看到"见设计文档"，用 skill 也查不到这篇文档。同一条消息作为触发消息时却带链接，两条路径的行为不一致。【确认】
- **做法**：
  - 两处改成和 SDK 一样的 `[label](href)`；文字和 URL 相同时只写一次。
  - 改那两条测试的期望。
  - 注意 `LINE_MAX=280`（`context-weave.ts:52`）会截断长 URL。可以在截断时保住 URL，或者至少不从 URL 中间截。
- **工作量**：约 10 行代码加 2 条测试，`packages/daemon/src/bot/context-weave.ts`。

### 2. 附件下载失败要写进提示（采纳思路）

- **Rakazo**：每个下不来的文件，都在文字里写一行"[file: x (unavailable)]"（`team-chat-bridge.ts:727,745`）。
- **我们**：`weaveFileManifest` 只列下载成功的文件，先用 `stripFileTokens` 删掉 `<file/>` 占位（`packages/daemon/src/bot/media.ts:374-393`）。只有附件、没有文字，而且全部下载失败时，`handle-message.ts:1928-1931` 会补一句"没能下载"。可是有文字又有附件、或者几个附件只下到一部分时，失败的那个从提示里**悄无声息地消失**。agent 会当用户没发文件，或者把"附件"说成另一个。图片也一样：`collectInboundImages` 失败只记日志（`media.ts:69-77`，`:185-189`）。【确认】
- **做法**：
  - `collectInboundFiles` 同时返回失败项，带上名字和原因（超过 50 MB、飞书拒绝、超时）。
  - 清单末尾加一行"〔没下载下来〕a.log（超过 50 MB）"。
  - 顺手把 `handle-message.ts:1930` 里的旧称"桥"改掉。
- **工作量**：约 20 行代码加约 30 行测试，`media.ts` 和 `handle-message.ts`。

### 3. 附件放在会话读得到、下一轮还在的地方（采纳思路）

- **Rakazo**：
  - 附件按 space、用户、bot 存成 Artifact（`team-chat-bridge.ts:711-749`）。
  - 每一轮把最近 3 个带附件的用户轮的文件复制到 bot 电脑上，并在指令里列出路径（`thread-artifacts.ts:201-275`，`executor.ts:3959-3995`）。
  - 22aed2a 的起因：bot 想把 Slack 里的图片附到工单上，但它的电脑上没有这个文件，只好去浏览器登录 Slack。
- **我们**：
  - 文件下到全局目录 `~/.vonvon-bot/inbound`，图片下到 `~/.vonvon-bot/media`（`packages/daemon/src/config/paths.ts:122-125`），1 小时后清掉（`media.ts:33,213-229`）。所有 bot、所有群共用这两个目录。
  - `media.ts:236-251` 的注释自己写明：这个目录在任何工作区之外，**只有完全访问档读得到**。Codex 在 macOS 上的只读、读写档只放行工作区根和 `:minimal`（`packages/daemon/src/agent/codex-appserver/backend.ts:52-73`）。
  - 被拉进来的群默认是只读、关网（`docs/product.md:461`）。所以在默认的群里，用户发一个日志文件，Codex 打不开。
  - Claude 那边，s31 之后只读、读写档"工作区以外的读写都会先到 canUseTool"（`docs/product.md:479`），按 s31 的规则会被拒。s31 的验收条款（`docs/v1-plan.md:827`）只列了记忆目录，没列附件。
  - 图片不受影响：图片作为 `localImage` 输入交给模型，是 daemon 读的文件，不是 agent 在沙箱里读（`backend.ts:95-100`）。
  - 另一个问题：1 小时以后，下一轮说"把刚才那个日志再看一下"，会话历史里的路径已经失效。【确认】代码；只读档读不到，依据是代码注释和沙箱配置，没在 Mac 上跑过。
- **做法**：
  1. 附件按会话放在 `bots/<appId>/` 下 daemon 管的目录里，比如 `inbound/<会话键哈希>/`。不放进工作区，因为 product.md 3.3 规定 vonvon 不往工作区写文件（`docs/product.md:109`）。
  2. 这个目录在每一档都只读放行：Codex 在 `permissions.feishu.filesystem` 里加一条 `'<dir>': 'read'`，做法同 s40 给记忆目录放写权限；Claude 的 canUseTool 对这个目录放行 Read。
  3. 照 Rakazo 的办法，保留最近 3 个带附件的轮次，不按墙钟 1 小时删；会话 `/new` 或停泊后再清。
  4. product.md 3.5 第 3 条的"附件路径"后面补一句：附件放在哪里、保留多久、每一档都读得到。
- **工作量**：约 150-200 行（`media.ts`、`paths.ts`、`backend.ts`，s31 的 canUseTool，加测试）。可以并进 s31（Claude）和 s39（Codex），也可以单独开一片；这一片要加"子进程、错误路径"的多角度审查。

### 4. 前几条消息的附件，按"新的优先、最多 4 个"一起带（采纳思路）

- **Rakazo**：一批里的文件块按"新消息优先、总数 4 个"带进这一轮（`newestFirstFileLimits` `team-chat-bridge.ts:1576-1589`，`:1319-1325`）。
- **我们**：只下载触发消息和它引用的消息里的附件（`docs/product.md:222`）。记录块里别人或自己前一条的附件只是占位，写成"[文件：a.log]"或"[图片]"（`context-weave.ts:563-571`）。
- **场景**：先发一个文件，再发一句"这报错什么意思？"。用户没有引用前一条，bot 就拿不到文件。【确认】
- **做法**：只对**同一个发信人**、在触发消息之前 N 分钟内、而且在这一轮记录块里的附件，按新的优先下载，最多 4 个；超出的留占位，写"可以引用那条再问"。智能模式下（发现 7），这一批消息就是范围。
- **工作量**：约 80-120 行（`context-weave.ts`、`media.ts`，加测试）。这一条扩大了 3.5 第 3 条，要先改 product.md。

### 5. 入站分类的测试，走真实 SDK 的 `normalize`（采纳思路）

- **Rakazo**：b3a5d36 的根因，是手写的判断和 SDK 的真实行为对不上。修完以后，用签名请求经过真实的 Slack 适配器做测试，HTTP 传输打桩（`chat-sdk-surface.test.ts:112-190`）。
- **我们**：只有 `packages/daemon/test/sync-copy.test.ts:5,88` 把原始事件喂给真实的 `normalize`（s14d）。另有 15 个测试文件手写 `NormalizedMessage`，比如 `mentionedBot: true`。可是我们的判断依赖 SDK 的几处细节【确认】：
  - `mentionedBot` 取决于 `botIdentity.openId`（SDK `lib/index.js:98290-98320`）。
  - "飞书常常不给 `@所有人` 的 mentions 数组"，要扫正文兜底（`:99116-99118`）。
  - `sender_type` 是 `app` 还是 `bot`（`packages/daemon/src/bot/baselines.ts:34-37`）。
  - `parent_id`、`root_id`、`thread_id` 的组合。

  这一类错位（比如 SDK 升级后 mentions 的形状变了），手写的测试测不出来。
- **做法**：给 s25、s27 写一个测试工具，把 e10 实测记下的原始事件（去掉 id）过一遍真实的 `normalize`。至少覆盖：别的 bot @ 我、@所有人不带 mentions、话题里引用某一条、话题第一条。
- **工作量**：测试工具约 40 行，加脱敏后的样本，放在 `packages/daemon/test/`。

### 6. 智能模式主动接话的那一轮：带判断理由；没话说或失败时不在群里出卡（采纳思路）

- **Rakazo**：
  - 环境消息那一轮的提示里写"Why this may need you: <判断给的理由>"，理由截到 240 字（`team-chat-bridge.ts:123`，`team-chat-judge.ts:101-103`）。
  - 这一轮没写回答就不说话（`:1406-1409`），失败也不说话（`:1427-1430`）。被 @ 的那一轮失败才发提示。
- **我们**：
  - 运行卡在这一轮一开始就建，回复在触发消息下面（`packages/daemon/src/bot/handle-message.ts:5630-5632`）。
  - product.md 3.4 只规定判断"回"或"不回"（`docs/product.md:164`），没说判断要回、agent 却没什么可说，或者这一轮失败时，群里出现什么。
  - 按现在的代码，没人问的话题下会冒出一张空卡或错误卡，正好是智能模式最该避免的噪音。【确认】代码；s25 还没开工，所以这是对现状的推演。
- **做法**（只针对"判断主动接话"的那一轮；被 @、接着聊、规则模式都不变）：
  1. 触发消息下面附一行"〔判断〕可能需要你：<理由>"，截到 200 字，标成判断模型的看法、不是用户的话。这一行由 daemon 写；理由是模型从不可信的消息里得出的，按记录块的单行规则清洗。
  2. 运行卡等出现第一段回答文字才建；这一轮结束时一个字没写，或者在出字之前就失败，群里什么都不发，诊断页"最近没回的消息"记一条"判断要回、agent 没写回答"或失败原因（s19 的原因码）。代价是出字之前没有 ⏹；主人可以在桌面端停。
  3. 指令里允许 agent 用约定的整句（比如 `NO_REPLY`）表示没什么要说。Rakazo 的 `NO_RESPONSE` 哨兵（`packages/adapters/src/silent-reply.ts:4-30`）只对例行任务开放（`executor.ts:8505-8507`），team-chat 那一轮没用上，只能靠"没写回答"。我们可以做得更明确。
- **工作量**：约 100-150 行，`handle-message.ts` 的开局路径加测试，归 s25。改的是 3.4 和 3.8 的承诺（运行卡出现的时机、失败的显示），要先改 product.md。

### 7. 智能模式没点名的消息：去抖后成批判断，由判断选回哪一条（采纳思路）

- **Rakazo**：最后一条消息安静 15 秒后，一次判断看最近 20 条，返回 `asked_by` 指定回哪一条，同批其他消息标成 ignored（`team-chat-bridge.ts:1016-1145`，`team-chat-judge.ts:63-114`）。
- **我们**：s25 是一条消息判断一次，每群每小时最多 60 次（`docs/v1-plan.md:750`，`docs/product.md:166`）。
- **为什么值得**：飞书群里一个人常常连发几条短消息。逐条判断会多花判断次数，也可能在别人话没说完时就接话。去抖加成批判断，正好对上 3.4"控制成本"的目标。
- **Rakazo 的两个坑**（【推断】，读代码看出来，没运行）：
  - 频道一直有人说话时，判断会一直等下去。
  - 一批超过 20 条时，前面的消息不进判断，却跟着整批被标成 ignored。

  我们要设最长等待（比如从第一条起最多 60 秒），超过 20 条就分批判断。
- **范围**：只用于主区没点名的消息。被 @ 的和话题里只有一个真人在聊的照旧直接走。
- **验证**：e12 量两种做法的判断次数和延迟。
- **说明**："何时回复"专题的报告可能也会提这一条；这里只从接入一侧说明 Rakazo 的做法。
- **工作量**：约 150-250 行，可以在 s25 里拆成 s25b。要先改 product.md 3.4 的"控制成本"。

### 8. 自动发件人策略（不采纳 v1，写进 §10）

- **Rakazo**：别的 bot 的消息在每个频道可以设成四种处理：忽略（默认）、按 N 小时汇总、总是处理、当成真人（`domain.ts:214-240`，`ExternalConversationSettings.tsx:58-63,159-229`，`team-chat-bridge.ts:1068-1099,1166-1199`）。被处理的 bot 列表从频道里自动发现（`external-conversations.ts:69-76`）。
- **我们**：3.4 第 3 条底线规定"别的 bot 发的消息，只有 @ 我才算"（`docs/product.md:154`）；s27 只收智能模式下的 bot @。
- **价值**：飞书群里 CI、监控、多维表格这类通知 bot 很多，"监控 bot 报警就去查"有真实需求。
- **不采纳的理由**：
  - 和 3.4 的底线冲突。
  - "总是处理"等于让一个外部 bot 无限次触发主人的 agent；Rakazo 也没给它加次数上限。
  - "按 N 小时汇总"需要定时任务，而 §10 已经把例行任务放在 v1 之后。
- **建议**：写进 §10 的候选，要求带每小时上限，并按 bot 的 app_id 设置。

### 9. 回复投递：最多发一次，确认不了就标 unconfirmed（我们已有）

- **Rakazo**：Slack 的 `chat.postMessage` 没有幂等键，`sendToThread` 也不传幂等键（`chat-sdk-surface.ts:134-148`），所以 Rakazo 只能二选一，选了"宁可丢、不重复"（`team-chat-bridge.ts:1471-1511`）。第 1 节说过，这个实现把"肯定没发出去"（比如 DNS 失败、4xx）和"不知道发没发出去"混在了一起，**一次报错就丢回复**；委托回复（`:969-976`）又是先发后标记，两条路的语义不一致。
- **我们**：飞书的消息接口按 `uuid` 在 1 小时内去重（`packages/daemon/src/bot/restart-dropped.ts:118-120` 实测过回复接口）。我们已经这样用：卡片更新（`packages/daemon/src/card/run-card-stream.ts:255,274,379,429,500`，`card/managed.ts:164`）、重启后补发的回复（`restart-dropped.ts:187-193`）、发文件（`bot/outbound-files.ts:440-445`）都带 uuid，可以放心重试。运行卡建不出来时，这一轮直接中止，不重试（`handle-message.ts:5634-5641`）。
- **结论**：不要把"unconfirmed"这一套搬过来。只有一点值得记住：区分"肯定没发出去"和"不知道"。s36c2c4a 的建群账本已经有 prepared、unknown、known 这几种状态。

### 10. 一个频道一条对话、并行跑、回复落点取会话行（不采纳）

- **Rakazo**：
  - 一个 Slack 频道里所有线程的消息进同一条 Rakazo 线程（`schema.prisma:534`，`team-chat-bridge.ts:433-471`）。
  - 同一频道的几轮并行跑（`allowParallelRun:true`，`:1336`）。
  - 根消息的回复落点取投递那一刻的 `conversationId`（`:1414`，见 2.2 节，【推断】有竞态）。
- **我们**：product.md 3.5 规定一个飞书位置一条会话，主区和话题互不复制（`docs/product.md:192-212`）。运行中来了消息，按插话或排队处理（`:272`）。回复目标在开这一轮时就定为触发消息（`replyTo`，`handle-message.ts:5632`）。
- **结论**：我们的设计更细，Rakazo 这套只会带来串话和回错地方。

### 11. 去重、幂等、排除 bot 自己的消息、启动时缓冲（我们已有）

我们有三层【确认】：
- 进程内 10 分钟的 `RecentIdCache`（`handle-message.ts:804-824,1166,1450-1453`）。
- 按会话水位持久化的 `alreadySeen`，重推和乱序到达的消息会被跳过（`handle-message.ts:1281-1294`，`session-store.ts:119-126`）。
- 发送带 uuid。

bot 自己的消息：飞书不把 bot 自己发的消息推回来；历史里用 `kindOf` 分出 self 和 bot（`context-weave.ts:147-151`），入站用 `fromBot`（`baselines.ts:34-37`）。

SDK 默认值的坑：我们在 `packages/daemon/src/bot/bridge.ts:69-75` 关掉了 SDK 的 600 毫秒按群合并，和 Rakazo 把 `drop` 改成 `concurrent` 是同一类问题。

启动时：s18c 在关闭时先断开长连接，没 ACK 的事件由飞书重推（`bridge.ts:86-92`），作用相当于 Rakazo 启动时的缓冲。

飞书 SDK 解析不出 bot 身份时直接报错，不会静默地把所有 @ 当成没 @（SDK `lib/index.js:99507-99535`），所以 b3a5d36 那类"身份信息缺失导致 @ 误判"的问题，在我们这边会表现为连不上。

### 12. 进入新线程时回填历史（我们已有）

Rakazo 只在被 @ 的消息第一次进入陌生线程时，回填 50 条（76f4259）。

我们做得更多：
- s09 把话题补拉翻页拉到水位。
- s14a 让主区按水位补拉，开场最多 20 条。
- s14b 让话题开场带主区 10 条和话题里已有的消息（`docs/v1-plan.md:425,430-431`）。
- s14 处理了乱序到达和"补拉先带进来、事件后到"的情况（`docs/v1-plan.md:510`）。
- 补拉失败时，没点名的消息不回，并记诊断（`docs/product.md:156`）。

不用改。

### 13. 出站：流式、长度、限流、失败时的提示（我们已有）

Rakazo 的 team-chat 没有流式、不编辑消息、不显示 typing，只发最后一段文字；没有 429 处理；失败时只发一句英文"去 Rakazo 看详情"；这一轮问人时 Slack 里看不到问题。

我们有：
- CardKit 流式输出（`run-card-stream.ts:80-120`）。
- 每个群一个发送节拍器，间隔 250 毫秒；遇到 429 整个群退后 1 秒；最后一帧按 1、2、4 秒退避重试（`run-card-stream.ts:24-73`）。
- 运行卡上显示错误和［重试］。
- 选项卡发在群里（3.8）。
- 卡片体积有预算（`card/run-process.ts:9-15`）。

`message_user` 上限可配（da0a7c0）在我们这边没有对应物：进度显示在运行卡的过程区。可以借的一点原则是：截断长度用同一个常量，并且告诉 agent 同一个数。我们记录块的 `LINE_MAX`、`BOT_LINE_MAX`（`context-weave.ts:52-54`）已经是常量。不需要改。

### 14. 谁能触发；bot 互相 @ 没有跳数上限（我们已有）

Rakazo：任何 Slack 成员 @ 网关 bot 或私聊它，都按主人身份跑一轮；别的 bot @ 它直接触发，没有跳数上限（见 2.3、2.5 节）。

我们：
- 入站先看群白名单和成员白名单（`handle-message.ts:1499-1505`）。
- 规则模式下别的 bot 一律不回（`:1478-1497`，s22）。
- 智能模式的 bot 互相 @ 最多 3 轮（s27，`docs/product.md:168`）。
- 陌生人私聊只回"在群里 @ 我"（s50）。

3.4 第 1 条底线是"@ 了别人，其他 bot 都不回"。Rakazo 的做法是 @ 了别人照样进监听判断（`messaging-platforms.ts:258-262`），比我们宽，不跟。

### 15. 管理面：接入、选频道、每个频道的策略（我们已有）

| 方面 | Rakazo | 我们 |
|---|---|---|
| 接入 | 运维填环境变量，一个部署一个 Slack 应用，没有 scope 清单 | 一个 bot 一个飞书应用，扫码注册，一键开权限，清单检测（s01、s02a、s04） |
| 进频道或群 | 拉进频道就能用，频道在第一条消息后才出现在设置里 | 被拉进群先不干活，私聊发设置卡，选会话方式、工作区和权限档，绑定好之前只回提示（`docs/product.md:138-144`） |
| 每个频道或群的设置 | 监听三态、房间规则（`ExternalConversationSettings.tsx`） | 会话方式、免 @、`SMART.md` 群覆盖、"继承 bot 默认"的显示（s23d、s28） |

不用借。

### 16. 把频道里的全部消息镜像进本地库（不采纳）

Rakazo 把每条 Slack 消息（包括被忽略的环境消息和回填的历史）镜像进 Postgres 和线程（`team-chat-bridge.ts:634-709`），镜像只有正文，不带发信人（`:685-700`）。

product.md 3.5 规定，除了话题标题，群聊内容不存到本机磁盘，判断用的最近消息只放在内存里（`docs/product.md:320`）。我们的记录块每条带真名、压成一行，防止伪造（`context-weave.ts:744-760,1024-1032`）。不采纳。

### 17. 自动消息加固定标签（b884f43）（我们已有更强的设计）

Rakazo 给自己插进去的 user 角色内容加固定前缀（`automated-messages.ts:8-12`）。这能解决"模型把续跑提示当成用户回复"的问题，防不了伪造：Slack 用户照样能打出这个前缀。

我们由 daemon 写的部分（记录块抬头、〔话题〕、〔撤回〕、设置更新）已经在结构上分开。§9 第 25 项给设置更新设计的是**每条会话一个不同的标记**（`docs/product.md:728`），比固定标签强，s38 开工时实测。

可以顺带核对一处：`retryPrompt` 加在开头的"（重试）上一轮因为…"（s15d 提到过）是 daemon 写的文字，要确认它在格式上和用户的话分得开。不需要另加标签。

### 18. Rakazo 的飞书接入：只做私聊、webhook、链接码（不采纳）

Rakazo 的飞书接入：
- 只接私聊，群消息直接丢掉（`chat-sdk-surface.ts:297`）。
- 只走 webhook（`messaging-platforms.ts:176-195`）。
- 用户在私聊里发链接码，把地址绑到自己的 bot 上（`messaging-inbound.ts:97-108`）。
- 收到附件只当 URL 文本处理（`:80-82`）。

我们是每个 bot 一个飞书应用，走长连接，私聊、群、话题、卡片和云文档评论都接了。它这套对我们没有可借之处，只用来说明"Rakazo 接了飞书"这件事的实际范围。

## 4. 复用代码和许可

- **不建议复用代码。** 可以独立拿出来的只有几个小纯函数，而且都和 Slack 或 Chat SDK 的形状绑在一起：
  - `plainTextWithLinks` 依赖 `chat` 包的 AST（`walkAst`、`isLinkNode`、`toPlainText`），飞书富文本是另一种 JSON，自己写 5 行就够。
  - `resolveMessagingThreadId` 只适用于 Slack 的线程 id 编码。
  - `readBoundedText` 用于 HTTP webhook，我们走长连接，用不上。
  - `newestFirstFileLimits`（`team-chat-bridge.ts:1576-1589`，14 行，不依赖其他代码）可以照抄。但它短到自己写更省事，还免了标来源。
- **万一要复制**（比如发现 4 的实现直接用 `newestFirstFileLimits`），照我们的先例：
  1. 文件开头写两行，格式同 `packages/daemon/src/server/atomic-file.ts:1-2`："Adapted from elie222/rakazo apps/api/src/team-chat-bridge.ts at b884f43." 和 "Copyright 2026 Rakazo contributors. Licensed under Apache-2.0; see NOTICE."。版权行取自 Rakazo 的 `LICENSE:166`。Rakazo 没有 NOTICE 文件。
  2. 根 `NOTICE` 加一段，写明复制了哪个文件、哪个提交、做了哪些修改，格式同 Paseo 那段。
  3. 在 `packages/daemon/` 下放 `LICENSE.rakazo`，内容是 Apache-2.0 全文加 Rakazo 的版权行，同 `LICENSE.paseo`。
  4. PR 描述里写明来源。

## 5. 没查到或没验证的

- Slack 适配器怎么编码根消息的线程 id，决定了 2.2 节说的"回复落点竞态"是否真的会发生。SDK 源码不在仓库里，没验证。
- 发现 3 里"Codex 只读档读不到 `~/.vonvon-bot/inbound`"的依据，是 `media.ts:236-251` 的注释和 `sandboxParams` 的配置，没在 Mac 上实测；Claude 一侧会被拒，是按 s31 的设计推出来的。建议在 s31 和 s39 的验收里各加一项："只读档下，群里发的 .log 文件 agent 能打开"。
- 发现 6 和 7 的收益（少花多少次判断、噪音少多少）没有数据，要靠 e12 量。
- 没追 Rakazo 的 `context-selection.ts` 怎么把镜像消息组成历史，所以"历史里看不出是谁说的"只是推断。
- 飞书长连接下，`handler` 出错时 SDK 回 500，飞书会不会重推，没有查。我们的 channel 层吞掉了 `im.message.receive_v1` 处理器里的错误（SDK `lib/index.js:99574-99582`），所以这个问题目前不影响我们。
