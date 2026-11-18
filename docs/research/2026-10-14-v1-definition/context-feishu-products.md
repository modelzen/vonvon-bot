# 上下文、子 agent 和私聊：飞书平台和其他产品怎么做

调研日期 2026-10-14。只读。没有改任何仓库，没有构建或跑测试，没有发消息。lark-cli 只用了 `--help`、`--dry-run` 和五次只读查询（只取了元数据，见第 2 节）。

文中"推断"是我根据证据推出来的，"未知"是没查到的。飞书文档取自 `open.feishu.cn/document/<路径>.md`，本地副本在 scratchpad 的 `fsdocs/` 下，行号指本地副本。

---

## 结论速览

1. **飞书本身就有"一个话题 = 一段对话"的结构。** 每条消息带 `chat_id`、`chat_type`（p2p 或 group）、`thread_id`（`omt_` 开头）、`root_id`、`parent_id`。拿 `thread_id` 就能把一个话题的全部消息拉回来。按"群 + 话题"切会话，平台完全支持。
2. **拉历史有现成接口，但只能拉机器人所在的群。** `GET /im/v1/messages` 按群或按话题取，每页最多 50 条，按群取时可以按时间过滤，按话题取时不行。机器人不在群里会返回 230002，我实测过。读群消息需要敏感权限 `im:message.group_msg`，bridge 已经申请了。
3. **lark-cli 的用户身份能读用户所在的任何群，机器人不在也能读。** 我实测：本机 lark-cli 用的是 `cli_aac99…（已截断）` 这个应用，社区群里的机器人是另一个应用 `cli_aaab3…（已截断）`。用户身份照样从建群第一条消息读起，机器人身份直接 230002。所以**不能把用户身份的 lark-cli 交给群里的 agent**，否则 A 群的人能让 agent 读出用户在 B 群的聊天。
4. **按需查历史应该由 Vonvon 提供一个窄工具。** 用机器人身份，只能查当前群或当前话题。comma 的飞书接入就是这么做的：给 agent `get_chat_history` 和 `get_thread_replies`，并给读到的内容打上"来自哪个群"的标签。消息搜索接口按文档只支持用户身份，不适合给群里的 agent。
5. **别家的会话单位几乎都是"群"或"线程"，不是"人"。** OpenClaw 在飞书默认一个群一个会话，可选一个话题一个会话。Slack 里的 AI 应用、Cursor、Grok Team Bots 都把一个线程当一个会话。comma 反过来：整个工作区只有一个 Router 会话，但绑定了任务的 Telegram 话题绕过 Router，直接进 Worker 会话。
6. **个人记忆和群是隔开的，这一点各家一致。** ChatGPT 群聊不用个人记忆，也不从群聊生成新记忆。Grok Team Bots 有团队记忆和"跟每个人的私人笔记"两层。OpenClaw 的群会话拿不到私聊内容。
7. **压缩都是"自动加手动命令"两种都有。** OpenClaw 默认自动压缩，`/compact` 可以带重点说明，压缩前先把要点写进记忆文件。Claude Code 和 Codex 原生都有自动压缩和 `/compact`。
8. **子 agent 的显示，主流做法是"挂在父任务下面"，不新开一个会话。** Codex 桌面版有 Subagents 面板，分进行中和已完成。Claude Code 在输入框下方有子 agent 面板，按树状显示。OpenClaw 文档明确说：要求开子 agent 不等于要求新开会话。只有用户要单独跟进时，才把子 agent 放进自己的线程。
9. **飞书卡片放得下子 agent 区，但有几条硬限制。** 一张卡片最多 200 个组件，最大 30 KB。同一个卡片实体每秒最多操作 10 次。流式模式开启 10 分钟后自动关闭。同一个群里所有机器人共享每秒 5 条的发送额度。所以"一个子 agent 一张卡片"在群里很容易撞限流，"一张运行卡里放子 agent 区"更稳。现有计划里已经有这个区（`docs/providers.md:775`）。
10. **私聊：bridge 用户当它是管理台，不是干活的地方。** bridge 的私聊从不跑 agent，非管理员会被拒（`src/bot/dm-console.ts:10-20`）。群里有人问"不支持私聊吗"（#605），有人说"coding 都是要建群"（#43）。建议 v1 只给 bot 主人开私聊会话，其他人私聊时只看到引导卡片。理由和风险见第 4 节。

---

## 1. 飞书平台

### 1.1 会话形态

| 形态 | 怎么识别 | 能不能用 API 创建 | 出处 |
|---|---|---|---|
| 单聊（用户和机器人） | `chat_type = p2p`，群信息里 `chat_mode = p2p` | 机器人给用户发消息时自动有 | `group/chat/intro.md:32`；`message/events/receive.md:70` |
| 普通群，对话消息 | `chat_mode = group`，`group_message_type = chat` | 能 | `group/chat/create.md:59-60` |
| 普通群里的话题 | 消息带 `thread_id`。有人"回复话题"或机器人用 `reply_in_thread: true` 回复时产生 | 能，用回复接口 | `im-v1/message/thread-introduction.md:27-31` |
| 话题形式群 | `chat_mode = group`，`group_message_type = thread`。所有消息都以话题发出，可以切回对话消息 | 能，建群时指定 | `thread-introduction.md:48`、`:69-73` |
| 话题群 | `chat_mode = topic`。建好后只能发话题 | **不能**，只能在客户端建 | `group/chat/create.md:16`；`thread-introduction.md:65-75` |

- 飞书官方推荐用"话题形式群"，不推荐"话题群"（`thread-introduction.md:74`）。
- "仅特定人可见卡片"不支持话题群，只支持普通群（`message-card/send-message-cards-that-are-only-visible-to-certain-people.md` 使用限制第一条）。这也是选话题形式群的一个理由。

### 1.2 一条消息事件怎么定位

接收消息事件 `im.message.receive_v1` 的字段（`message/events/receive.md:55-80`）：

- `chat_id`：所在会话。
- `chat_type`：`p2p` 或 `group`。
- `thread_id`：所属话题。不返回说明不是话题消息。
- `root_id`、`parent_id`：只在回复场景有值。`root_id` 是消息树的根，`parent_id` 是上一层。在话题里回复时，`parent_id` 始终是话题根消息（`message/list.md:52-53`）。
- `mentions`：被 @ 的人或机器人，带 `mentioned_type`（user 或 bot）。
- `sender.sender_type`：user 或 bot。

几个要注意的点：

- 事件可能重复推送，要用 `message_id` 去重，不能用 `event_id`（`receive.md:30`）。
- 机器人默认收不到其他机器人的消息。要收，得申请带 `include_bot` 的权限：`im:message.group_at_msg.include_bot:readonly`（别的机器人 @ 我）或 `im:message.group_msg.include_bot:read`（群里所有用户和机器人的消息，不含自己）（`receive.md:14-19`）。这关系到多 bot 群里，一个 bot 能不能看到另一个 bot 说了什么。
- `im:message.group_msg`（收群里所有消息）是敏感权限（`receive.md:38`）。

### 1.3 历史消息接口

`GET /open-apis/im/v1/messages`（`message/list.md`）：

- **容器**：`container_id_type` 取 `chat`（单聊和群）或 `thread`（话题）。在普通群里按 `chat` 取，只能拿到话题的根消息，话题里的回复要再按 `thread` 取（`list.md:30`）。
- **分页**：`page_size` 1 到 50，默认 20（`list.md:35`）。
- **时间过滤**：`start_time`、`end_time` 是秒级时间戳。`thread` 容器不支持时间过滤（`list.md:32-33`）。
- **排序**：按创建时间升序或降序，翻页时不能换（`list.md:34`）。
- **限流**：每分钟 1000 次，每秒 50 次（`list.md:16`）。
- **权限**：用应用身份读群消息，要先有单聊场景的一个权限（`im:message`、`im:message:readonly` 或 `im:message.history:readonly`），再加 `im:message.group_msg`。用用户身份读，要 `im:message` 或 `im:message:readonly`，再按群类型加 `im:message.p2p_msg:get_as_user` 或 `im:message.group_msg:get_as_user`（`list.md:18`）。
  - bridge 申请的权限里有 `im:message.group_msg`，没有文档列出的那三个单聊权限（`feishu-codex-bridge/src/config/scopes.ts:18-38`）。但 bridge 的话题上文功能就是用这个接口拉的（`src/bot/context-weave.ts:111-118`）。文档和 bridge 实际用的组合对不上，**未知**是文档过时还是某些租户会失败。需要在 Mac 上用新应用实测。
- **前提**：机器人必须在群里（`list.md:8`）。不在就返回 230002（`list.md:126`）。
- **入群前的消息**：文档没有直接说机器人能不能读入群前的消息。只在错误码 230073 里写到：如果群关闭了"新成员可查看历史消息"，进群前创建的话题对操作者不可见（`list.md:130`；`thread-introduction.md:57-59`）。**推断**：普通消息同样受这个群设置控制，设置打开时机器人能读到入群前的消息。这个设置的默认值**未知**。
- **能往前读多远**：文档没写上限。实测用户身份能从社区群的第一条消息（2026-06-01 14:22，一条系统消息）读起（见第 2 节）。企业消息保留策略会不会截断，**未知**。
- **读不了的群**：开了保密模式、禁止复制消息的群返回 231203（`list.md:132`）。

### 1.4 消息搜索

- 新接口 `POST /open-apis/im/v1/messages/search`，文档只列了 `user_access_token`，权限 `search:message`，每分钟 100 次，"可见性和套件内搜索一致"（[open.larkoffice.com 文档](https://open.larkoffice.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/search)）。旧接口 `POST /search/v2/message` 同样只收用户 token（`search-v2/suite-search/create.md:15-22`）。
- lark-cli 的 `+messages-search` 有 `--as bot` 选项。我用机器人身份试了一次，报错是应用没开 `search:message` 权限（错误码 99991672）。所以开了权限以后机器人身份能不能搜、搜的范围是不是只限机器人所在的群，**未知**。
- **推断**：搜索是"按人"的能力，范围是这个人能看到的所有会话。不适合作为群里 agent 的工具。

### 1.5 单聊

- **机器人能主动发起单聊。** 只要用户在机器人的可用范围内，就能用 `open_id` 发消息（`message/create.md:5-9`）。不在范围内返回 230013（`list.md:128`）。
- 给同一个用户发消息限每秒 5 条（`create.md:13`）。
- 有两个相关事件：用户第一次和机器人建立会话（`p2p_chat_create`，`group/chat-member/event/bot-events.md:3、13`），用户每次进入和机器人的会话（`im.chat.access_event.bot_p2p_chat_entered_v1`，需要客户端 7.18 以上，`bot_p2p_chat_entered.md:11-19`）。
- **跟随气泡**只在机器人单聊里能用：在机器人最新一条消息下面挂几个可点的建议，点了就变成用户发的一条消息（`im-v1/message/push_follow_up.md`）。适合做私聊里的快捷入口。
- 单聊里能不能开话题（`reply_in_thread`），文档没说，**未知**。OpenClaw 的飞书文档把私聊当作"绑定当前会话"，而不是开子线程（`docs.openclaw.ai/tools/subagents/thread-bound-sessions`）。需要在 Mac 上实测。

### 1.6 发送和卡片限流（和子 agent 显示有关）

| 限制 | 数值 | 出处 |
|---|---|---|
| 同一个群的发送 | **群内所有机器人共享**每秒 5 条 | `message/create.md:13`；`message/reply.md:11` |
| 同一条消息的更新（patch） | 每秒 5 次，只能改 14 天内的消息 | `message-card/patch.md:25-26` |
| 卡片和富文本消息大小 | 最大 30 KB | `patch.md:108` |
| 一张卡片的组件数 | 最多 200 个（JSON 2.0） | `cardkit-v1/card/batch_update.md:84` |
| 同一个卡片实体的操作频率 | 每秒 10 次 | 流式更新概述 `streaming-updates-openapi-overview.md:25` |
| 流式模式 | 开启 10 分钟后自动关闭；流式模式下"不会触发接口的频率限制" | 同上 `:244`、`:53` |
| 卡片实体有效期 | 14 天 | `cardkit-v1/card/create.md:10` |
| 折叠面板 | 容器最多嵌套 5 层；面板里不能放表单 | `card-json-v2-components/containers/collapsible-panel.md:12-16` |
| 用户点卡片按钮期间 | 卡片不能流式更新（200810） | `cardkit-v1/card-element/content.md:91` |
| 仅特定人可见卡片 | 每个群每秒 40 次；话题群不支持；用户收不到通知，只在在线客户端可见 | `send-message-cards-that-are-only-visible-to-certain-people.md` |

流式概述里"每秒 10 次"和"流式模式下不触发频率限制"两句话放在一起。**推断**：后者指接口总限流（每秒 50 次），前者是单个卡片的上限，两者都要守。

---

## 2. lark-cli

### 2.1 本机情况

- 位置 `/home/operator/.local/bin/lark-cli`，版本 1.0.97（有 1.0.98 可更新）。
- `lark-cli whoami`：应用 `cli_aac99…（已截断）`，当前身份 `user`，代表用户"<飞书用户名>"，`defaultAs: auto`，token 状态 `needs_refresh`。

### 2.2 只读的历史和搜索命令

| 命令 | 底层接口 | 要点 | 出处 |
|---|---|---|---|
| `im +chat-messages-list --chat-id oc_…` | `GET /im/v1/messages`，`container_id_type=chat`，`only_thread_root_messages=true` | 每页最多 50；`--page-all` 默认最多 10 页；支持时间范围；会自动展开话题回复（`thread_replies`）；`--user-id` 查单聊**只能用用户身份** | `--help`；`--dry-run`；`skills read lark-im/references/lark-im-chat-messages-list.md` |
| `im +threads-messages-list --thread omt_…` | 同上，`container_id_type=thread` | 不支持时间过滤 | 同上 |
| `im +messages-mget` | 批量取最多 50 条 | 按 message_id 取 | `lark-cli im --help` |
| `im +messages-search --query …` | `POST /im/v1/messages/search` 加 mget | `--page-size` 最多 50，自动翻页最多 40 页；可按群、发送人、@ 谁、时间、单聊或群过滤 | `--help`；`lark-im-messages-search.md` |

### 2.3 身份：它能看到什么

- `--as user` 用 `user_access_token`，"权限取决于应用权限和这个用户自己对目标会话的访问权"。`--as bot` 用 `tenant_access_token`，取决于机器人在不在群里（`lark-cli skills read lark-im`，Identity and Token Mapping 一节）。
- **实测**（只取了元数据）：
  - 社区群 `oc_f212…` 里只有一个机器人，是 `cli_aaab3…（已截断）`（"Vonvon"），不是本机 lark-cli 的应用（`im +chat-members-list --as user --member-types bot`）。
  - 用户身份：`+chat-messages-list --order asc --page-size 1` 成功，第一条是 2026-06-01 14:22 的系统消息，还有更多。
  - 机器人身份：同一条命令返回 230002 "Bot/User can NOT be out of the chat"。
  - 用户身份搜索 `codex` 成功，结果里有话题群的消息。机器人身份搜索因为缺 `search:message` 被拒。
- **结论**：用户身份的 lark-cli 看到的是"这个人在飞书里能看到的一切"，和机器人在不在群里无关。

### 2.4 能不能给 agent 当工具

- 技术上能。lark-cli 自带面向 agent 的说明，每个命令标了 read 或 write 风险，`--jq` 和 `--dry-run` 都有（`lark-cli --help`）。
- 它还专门有 `config bind`，给 OpenClaw、Hermes、Lark Channel 这类 agent 绑定飞书凭据，并要求选身份预设：`bot-only`（更安全，不冒充用户）或 `user-default`（冒充用户）。`config strict-mode bot|user|off` 能锁定身份（`lark-cli config bind --help`；`config strict-mode --help`）。
- 但 Vonvon 的场景里有三个问题：
  1. **跨群泄露。** 如果给群里的 agent 一个用户身份的 lark-cli，群里任何能指挥 bot 的人，都能让它读出 bot 主人在别的群、别的单聊里的消息。
  2. **读了没人对它说的话。** 即使用机器人身份，`im:message.group_msg` 也能读到群里不是对 bot 说的消息。群成员不一定知道 bot 在读。
  3. **凭据落盘。** 机器人身份需要把 app secret 交给 lark-cli 自己保存（`config init` 走 keychain）。Vonvon 的 daemon 本来就有这个 secret，再存一份是多余的暴露面。**推断**。
- **建议**：
  - 群里的 agent 不直接用 lark-cli 查历史。由 daemon 提供一个窄工具，比如 `vonvon history`（命名待定）。它用机器人身份，只能查**当前群或当前话题**，按条数和字符数截断，过滤掉 bot 自己的输出。
  - 这和 comma 的做法一致：它的飞书接入给 agent 的就是 `feishu.get_chat_history` 和 `feishu.get_thread_replies` 两个工具，底层就是这个接口（`references/comma/systems/apps/salix_im/lib/salix_im/provider/feishu.ex:133-137、440-456`）。它还给每次读取打上来源标签，"引用公开频道的内容可以，引用私密频道的内容被拒"（`salix_im/ifc/read_labels.ex:1-30`）。
  - bridge 现在的话题上文功能也只用机器人身份，注释里写明"不需要第二个身份或 lark-cli"（`feishu-codex-bridge/src/bot/context-weave.ts:23-27`）。
  - 用户身份的 lark-cli 只在 bot 主人的私聊会话里、经主人明确开启后才给。

---

## 3. 其他产品

### 3.0 对照基线：bridge（旧产品）怎么做

- **两种群**：多话题群里一个话题一个会话，按 `threadId` 区分；单会话群整群一个会话，按 `chatId` 区分，回复引用原消息、不开话题、轮次串行（`feishu-codex-bridge/src/bot/handle-message.ts:547-557`）。v2 的 daemon 是从这里复制的。
- **话题上文**：在话题里 @bot 时，把 bot 还没见过的"人对人"消息补进开场。
  - 新会话取最近 20 条；已有会话只取上次水位（`lastSeenAt`）之后的增量。
  - 一次只拉一页 50 条，每行截到 280 字，bot 和系统消息过滤掉（`src/bot/context-weave.ts:36-45、95-142`；`handle-message.ts:1578-1601`）。
  - v2 里有同样的代码（`vonvon-bot/packages/daemon/src/bot/context-weave.ts:40`；`handle-message.ts:1507`）。
- **发信人**：每条消息前加 `[本条消息的发信人：名字（open_id）]`，让 agent 知道谁在说话（`context-weave.ts:433-455`）。
- **引用消息**：事件只带被引用消息的 id，内容要用 `message.get` 再取（`context-weave.ts:8-12`）。
- **用户的反馈**：
  - "后者（话题群）每个话题都是一个单独的 session，这样不会污染上下文。自己一个人用，用普通聊天群模式就行。"（#41）
  - "上下文太长会压缩吧，不需要 new，群聊最主要的是可以持久保持上下文。"（#46）
  - 想要单会话群能清空上下文、重启会话（#578、#598），多话题群和单会话群互相转换（#595，issue #6）。
  - 单会话群里管理员和普通成员权限不同，会被拆成两个 Codex 会话，上下文对不上（#953）。
  - 有贡献者"重做了给模型的历史简报"，加了"模型自己判断要不要回复"的模式（#952）。

社区群消息编号见 scratchpad `feishu/texts.txt`（#41 在第 6 行，#46 第 11 行，#952 第 461 行，#953 第 462 行）。

### 3.1 OpenClaw

| 问题 | 做法 | 出处 |
|---|---|---|
| 一个会话是什么 | 私聊默认全部并进"主会话" `agent:<id>:main`；可选按人、按渠道加人隔离。群默认一个群一个会话 `agent:<id>:<channel>:group:<id>` | [session](https://docs.openclaw.ai/concepts/session)；[groups](https://docs.openclaw.ai/channels/groups) |
| 飞书上的会话 | `groupSessionScope`：`group`（默认，一个群一个会话）、`group_sender`、`group_topic`（一个话题一个会话，不在话题里就落回群会话）、`group_topic_sender`。话题键用 `thread_id`；普通群里 OpenClaw 自己开的话题用根消息 id，保证首轮和后续在同一会话 | `docs.openclaw.ai/channels/feishu/advanced-configuration` 第 101-114 行 |
| 回复时看到什么 | 要 @ 才回的群，没 @ 的消息先存成"待处理上下文"，被 @ 时一起给 agent。条数由 `historyLimit` 控制，0 就关掉 | [groups](https://docs.openclaw.ai/channels/groups) |
| Slack 线程 | 新线程会话开始时先拉已有的 20 条（`thread.initialHistoryLimit`），默认不继承频道上下文（`inheritParent: false`） | `channels/slack/threads-and-sessions` 第 22-23 行 |
| Discord | 历史默认 20 条；其他机器人的消息保留为上下文；**自己的输出不进自动历史** | `channels/discord/threads-and-sessions` 第 50-61 行 |
| 安静旁听 | "环境房间事件"：没 @ 的消息当安静上下文，agent 只有显式调用 `message` 工具才发言。飞书**不在**支持列表里 | [ambient-room-events](https://docs.openclaw.ai/channels/ambient-room-events) |
| bot 自己开的话题 | `requireMentionInBotThreads: false` 时，bot 开的话题里不用再 @ | `channels/feishu/access-control` 第 51-55 行 |
| 私聊权限 | `dmPolicy` 默认 `pairing`：陌生人先拿配对码，主人在 CLI 批准 | `channels/feishu/access-control` 第 17-23 行 |
| 群隔离 | `mode: "non-main"` 时群会话跑在沙箱里，私聊在本机。可以按群、按发送人限制工具，拒绝优先 | [groups](https://docs.openclaw.ai/channels/groups) |
| 私聊和群的边界 | 群会话"拿不到私聊内容"。跨会话回忆要显式开 `rememberAcrossConversations`，只建议个人或完全信任的 agent | [session](https://docs.openclaw.ai/concepts/session) |
| 主会话看群 | 默认主会话会"旁观"各群，群里的动静合并成简短通知，下次主会话运行时看到 | [main-session](https://docs.openclaw.ai/concepts/main-session) |
| 重置 | 默认不重置，靠压缩控制长度。可选每天定时、空闲多久、`/new`、`/reset`。可以按私聊、群、线程分别设置 | [session](https://docs.openclaw.ai/concepts/session) |
| 压缩 | 默认自动：快满时或模型报上下文溢出时压缩并重试。`/compact` 手动，可以带重点。保留最近约 2 万 token（`keepRecentTokens`），工具调用和结果不拆开。压缩前先静默跑一轮，把要点写进记忆文件。完整记录留在磁盘，"压缩只改变模型下一轮看到什么" | [compaction](https://docs.openclaw.ai/concepts/compaction) |
| 记忆 | `MEMORY.md` 每个新会话都加载；每日笔记按需搜索；`/new` 时把旧会话结尾存进当天笔记 | [main-session](https://docs.openclaw.ai/concepts/main-session) |

飞书官方给 OpenClaw 做的插件以用户身份操作，并且建议把 bot 当私人助手用，不要拉进群（`results/landscape.report.md:142`，引自 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)）。

### 3.2 comma（AGPL，只借思路）

| 问题 | 做法 | 出处（相对 `/home/operator/vonvon/references/comma`） |
|---|---|---|
| 一个会话是什么 | 每个工作区的 Router 只有一个长期会话。各渠道、各用户的消息都进这一个会话，但每条输入都带来源会话和消息的身份 | `docs/architecture/PRODUCT_MODEL.md:91-110` |
| 任务 | Router 委派任务时，开一个独立的任务会话，Worker 用新会话 | `PRODUCT_MODEL.md:102、112` |
| Telegram 话题 | 普通话题进 Router；**绑定了任务的话题直接进任务**，用户和 Worker 的对话默认绕过 Router | `docs/salix/tasks-background-execution.md:215-223` |
| 回复 | agent 的普通输出不会自动变成聊天消息，必须显式调用发送工具 | `PRODUCT_MODEL.md:111` |
| 飞书群（团队版 BFT） | 单聊总是处理；群里要 @bot；**bot 参与过的话题里不用 @**，参与记录保留 30 天 | `systems/apps/salix_im/lib/salix_im/provider_http.ex:3595-3620`；`provider_connects.ex:2063-2090、2160-2162` |
| 飞书回复位置 | 群里不在话题中的消息，默认用 `reply_in_thread` 开话题回复 | `provider/feishu.ex:658-664` |
| 历史 | 给 agent 两个工具按需拉群历史和话题回复，读取结果按来源打标签 | `provider/feishu.ex:133-137`；`ifc/read_labels.ex:1-30` |
| 不说话 | 分诊 Worker 判断要不要开口，不说时记原因码（已处理、没有补充、证据不足） | `docs/bridge-for-teams/design.md:79-82` |
| Slack 线程续接 | 第一次确认回复后，保存问题、回复和任务上下文；之后线程里的跟进继续同一个任务 | `design.md:144-145` |
| 压缩 | 自动和手动压缩共用同一个续接边界；"上下文摘要不授权额外的披露或工具调用" | `docs/agent-runtime.md:37-46` |

### 3.3 ChatGPT 群聊（OpenAI，2025 年 11 月）

OpenAI 帮助页和公告页直接抓取返回 403。下面几条来自搜索结果里这两页的原文摘录，和一篇转述。

- **一个会话**：一个群聊就是一个会话，最多 20 个参与者（含 ChatGPT）。把已有对话变成群聊时，会复制一份原对话成新群，原对话不变（[iPhone in Canada](https://www.iphoneincanada.ca/2025/11/21/openai-chatgpt-group-chat)）。
- **何时回复**："ChatGPT 是对话的参与者，不会回复每一条消息。它跟随对话的走向，根据群聊上下文决定什么时候回复、什么时候安静。"有人明确提问或求助时一般会回；人和人之间聊天时不插话。任何人提到"ChatGPT"都能叫它出来。群设置里可以关掉自动回复，只在 @ChatGPT 时回（[help.openai.com](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)，经搜索摘录）。
- **记忆**："个人的 ChatGPT 记忆不在群聊里使用，ChatGPT 也不从这些对话里生成新记忆。"每个群可以有自己的自定义指令（[openai.com](https://openai.com/index/group-chats-in-chatgpt/)，经搜索摘录）。
- **额度**：只有 ChatGPT 回复时才算额度，算在它所回复的那个人头上（同上）。
- **能看到什么**：**推断**是群里所有消息，因为它"跟随对话走向"。
- **压缩**：**未知**。

### 3.4 Slack 里的 AI 应用和 Cursor

- **Slack 官方 AI 应用框架**：对话按线程分组，`thread_ts` 是唯一标识。之前的消息用 `conversations.replies` 取，由应用"自己选哪些消息放进提示词"（[docs.slack.dev/ai/developing-ai-apps](https://docs.slack.dev/ai/developing-ai-apps)）。
- **Slack 流式和任务卡**：`chat.startStream` 的 `task_display_mode` 有两种。`timeline` 把任务更新渲染成单独的任务卡，穿插在文字里；`plan` 把任务更新合成一个计划块。任务更新的状态有 `in_progress`、`complete`、`error`，每块最多 256 字。不带 `thread_ts` 的顶层流式消息，只在"整个频道就是一个会话"的频道里支持（[docs.slack.dev chat.startStream](https://docs.slack.dev/reference/methods/chat.startStream/)）。
- **Cursor Cloud Agents**："被调用时读取整个线程作为上下文。"在已有 agent 的线程里再 @Cursor，是给同一个 agent 追加指令；`@Cursor agent …` 才在同一线程开新 agent。运行时在线程下面更新一行简短状态，完成后通知并附 PR 链接。`@Cursor list my agents` 列出自己的 agent（[cursor.com/docs/slack](https://cursor.com/docs/slack)）。

### 3.5 Grok Bot 和 Team Bots

- **Team Bots**：每个队友有自己的对话。在 Slack 里，一个私聊是一个对话，频道和群私聊里"每个线程是自己的对话"。频道里被 @ 后就跟随这个线程，后续不用再 @；没 @ 它的顶层消息不理（[docs.x.ai/grok-bot/team-bots](https://docs.x.ai/grok-bot/team-bots)）。
- **记忆两层**：团队记忆所有队友的对话都读，只有有人说"整个团队都该知道"时才写，而且会告知。跟每个人的笔记只属于那个人，其他队友的对话读不到（同上）。
- **隐私**：主人看不到队友的对话，反之亦然。频道线程共用一台电脑，所以"不要在频道线程里分享不该被整个频道看到的东西"（同上）。
- **多 bot 群聊**：一个群 2 到 6 个 bot。正常写，由 bot 们决定谁回；@ 某个 bot 指定负责人；回复某个 bot 的消息就是对它说。bot 之间可以异步交接，交接过程在群里可见。审批、密钥、草稿不出现在群里（`docs.x.ai/grok-bot/chat-and-collaboration.md` 第 63-111 行）。
- "多个 bot 角色和对话分开，但共用电脑"，"不要把不同 bot 当作安全边界"（`results/landscape.report.md` 1.3 节）。

### 3.6 Character.AI 等多角色群聊

- 群里可以只有 AI 角色，也可以人和 AI 混在一起，最初只对付费用户、只在手机端开放（[Yahoo/TechCrunch 转载](https://sg.finance.yahoo.com/news/character-ai-introduces-group-chats-202445269.html)）。
- 谁来回、上下文怎么算、怎么压缩，官方资料里都没找到，**未知**。参考价值低。

### 3.7 对照表

| 产品 | 一个会话 | 回复时看到什么 | 压缩和记忆 | 私聊和群 |
|---|---|---|---|---|
| bridge | 多话题群一个话题；单会话群一个群 | 原生会话历史，加话题里自上次以来的人对人消息（最多 20 条） | 原生压缩，`/compact` | 私聊只是管理台 |
| OpenClaw | 私聊并入主会话；群一个会话，可选一个话题 | 群里没 @ 的消息存为待处理上下文，被 @ 时注入 | 自动加 `/compact`，压缩前写记忆 | 群拿不到私聊内容；主会话旁观群 |
| comma | 一个工作区一个 Router 会话；任务各自一个会话 | Router 会话加按需工具拉历史 | 自动和手动共用边界 | 绑定任务的话题绕过 Router |
| ChatGPT 群聊 | 一个群一个会话 | 群里所有消息（推断） | 不用也不生成个人记忆；群有自定义指令 | 个人设置不进群 |
| Slack AI、Cursor | 一个线程 | 线程里的消息，由应用挑选或全读 | 未知 | 私聊一个对话 |
| Grok Team Bots | 每人一个；Slack 一个线程 | 被 @ 后跟随线程 | 团队记忆加个人笔记 | 个人笔记不进别人的对话 |

---

## 3b. 子 agent 怎么显示

### 别家怎么显示

| 产品 | 显示方式 | 结果怎么回来 | 出处 |
|---|---|---|---|
| Codex 桌面版 | 每个子 agent 线程都能点开看；Subagents 面板分"进行中"和"已完成"；后台子 agent 有固定的小图标；修过"子 agent 被显示成顶层任务行"的 bug | 子 agent 只回摘要，主线程等所有结果到齐后给一个合并回答 | [learn.chatgpt.com subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)；scratchpad `docs/changelog.txt:633、780` |
| Codex CLI 和 IDE | CLI 用 `/subagents` 在线程间切换；IDE 在输入框上方显示进行中的子 agent，能全部停止或打开一个 | 同上 | 同上 |
| Claude Code | 输入框下方有子 agent 面板，可以选中、打开记录、按 `x` 停止；嵌套的显示成树，带 `(+N)`；完成后行消失，30 秒内能在 `/tasks` 里看 | 后台子 agent 的结果在**之后的回合**以完成通知的形式到达 | [code.claude.com sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Claude Code agent teams | 队友显示在同一个面板，或每人一个 tmux 窗格；可以直接给某个队友发消息 | 队友空闲时通知 lead；**在 `-p` 非交互模式和 Agent SDK 里不会生成队友** | [code.claude.com agent-teams](https://code.claude.com/docs/en/agent-teams) |
| OpenClaw | 父会话里打开 Subagents 面板，分 Running 和 Finished，选中后在旁边看只读记录。"要求开子 agent 不等于要求新的侧栏会话"；只有用户要单独回来跟进时才建可见的独立会话 | 默认把结果"宣告"回父会话 | [tools/subagents](https://docs.openclaw.ai/tools/subagents) |
| OpenClaw 线程绑定 | 子 agent 可以开自己的新线程，线程里的后续消息都进这个子 agent。只有 Discord 和 Matrix 支持；**飞书、Telegram 会拒绝**，只能把结果宣告回原会话。线程绑定的子 agent 默认继承父会话上下文（`fork`），普通子 agent 默认干净上下文（`isolated`） | 线程里直接对话 | [thread-bound-sessions](https://docs.openclaw.ai/tools/subagents/thread-bound-sessions)；[tool-reference](https://docs.openclaw.ai/tools/subagents/tool-reference) |
| comma | 任务有自己的会话和任务卡；Telegram 里一个任务可以绑一个话题，等待时也保留 Worker 身份 | Worker 自己发结果消息 | `tasks-background-execution.md:215-223`；`results/comma.report.md` 第 1 节 |
| Slack | `timeline` 任务卡或 `plan` 计划块 | 流式结束时收尾 | 3.4 节 |
| Cursor in Slack | 线程下一行状态；`list my agents` | 完成通知加 PR 链接 | 3.4 节 |
| Grok Bot | 群聊里 bot 之间的交接可见 | 异步回复 | 3.5 节 |

几个共同点：

- **子 agent 默认是父任务的一部分**，结果回到父任务。单独的会话、线程或话题是例外，给用户要单独跟进的情况。
- **子 agent 默认是干净上下文**，只拿到委派说明。Claude Code 和 OpenClaw 都有"分叉"选项可以继承父对话。
- **后台子 agent 会比主回合活得久。** Claude Code 文档写得很清楚：结果在之后的回合到达。bridge 用户就碰到过："让他开五个子进程，他很快就结束对话了，但后台其他的还在跑"，"但他不回显处理细节吗"（#683、#688，`feishu/texts.txt` 第 338、343 行）。

### 飞书里能用的卡片能力

- **一张运行卡里放子 agent 区**：用折叠面板，一个子 agent 一行，展开看最近几步和结果。现有计划已经这么设计：最多 6 个运行中、3 个已完成，后面写"另有 N 个已完成"；行里有"查看完整过程"按钮，另发一张卡片显示最多 200 步（`vonvon-bot/docs/providers.md:775、783`）。计划给整卡的预算是 170 个组件、28,000 字节（`providers.md:766`），在飞书 200 个组件、30 KB 的上限以内。
- **在话题里回复**：子 agent 的详细记录可以作为话题里的单独消息发，不打扰群主区。
- **仅特定人可见卡片**：可以把只跟发起人有关的东西（比如需要他确认的事）只给他看。话题群不支持（1.1 节）。
- **限流**：一个卡片实体每秒 10 次，流式 10 分钟自动关，群里所有 bot 共享每秒 5 条（1.6 节）。

### 三种做法比较

| 做法 | 好处 | 坏处 |
|---|---|---|
| A. 运行卡里的子 agent 区（现有计划） | 一条消息，不刷屏；合并更新不容易撞限流；和 Codex、Claude、OpenClaw 的"挂在父任务下"一致 | 卡片空间有限；子 agent 很多时只能显示摘要 |
| B. 每个子 agent 一张卡片，发在同一个话题里 | 每个子 agent 信息完整 | 群里 5 条每秒是所有 bot 共享的，5 个子 agent 同时更新就可能被限流；话题里很吵 |
| C. 每个子 agent 开一个新话题，话题里的消息直接进这个子 agent | 用户可以单独跟进、单独停止 | 原生子 agent 不一定能被用户直接寻址（Codex 和 Claude 能不能对子线程单独发起回合，**未知**，属于另一份调研）；OpenClaw 在飞书上就没做这个；群里话题变多 |

**建议**：

- v1 用 A。默认把子 agent 显示在运行卡里。
- 主回合结束、但还有后台子 agent 在跑时，卡片不要显示"完成"，要显示"主任务已回复，N 个子 agent 仍在运行"。子 agent 结束后在同一个话题里补一条结果，或者更新同一张卡片。
- C 可以留到以后，只给"用户明确要单独跟进"的长任务。comma 的"绑定任务的话题"和 OpenClaw 的线程绑定是两个参照。

---

## 4. 私聊要不要做

### 4.1 bridge 用户拿私聊做什么

- bridge 的私聊只是管理台："任何消息都弹出菜单卡，新建、列出、删除项目都靠按钮，管理台从不运行 Codex"。只有管理员能用，其他人看到"仅管理员可在私聊里管理项目"（`feishu-codex-bridge/src/bot/dm-console.ts:10-20`；`handle-message.ts:922-936`）。
- 用户怎么理解：
  - "跟这个 bridge 私聊的话，它就是一个创建项目的作用，不适合在私聊里进行 coding 是这样吗？"回答是"对。coding 都是要建群"（#42、#43）。
  - 私聊还用来看用量卡片（#197）、点诊断（#404、#531）、点重启（#650）。
  - "咖啡一下"把本机 Claude Code 或 Codex 的审批、提问和完成通知推到私聊（#400）。
- 用户的抱怨：
  - 换新电脑后私聊提示"仅管理员可在私聊里管理项目"（#557，issue #10）。
  - "除了管理员，其他人都不能私聊"（#582），"不支持私聊吗"（#605）。
- 没人提过"想在私聊里写代码"。抱怨集中在"非管理员被拒"。**推断**：有人把 bot 当成一般的聊天机器人，私聊被拒让他们困惑。

社区群消息编号见 `feishu/texts.txt`（#42 第 7 行，#43 第 8 行，#557 第 266 行，#582 第 283 行，#605 第 300 行）。

### 4.2 私聊会话会是什么样

- **一个会话**：飞书私聊能不能开话题**未知**（1.5 节）。如果不能，一个私聊就是一个滚动会话，和单会话群一样，靠自动压缩和 `/new` 控制长度。
- **工作区**：用 bot 的默认工作区。不能用某个群的工作区，否则群的文件会被私聊里的人间接拿到。
- **记忆**：bot 的人设和 bot 级记忆照常加载。另外有一份"跟这个人"的私人记忆，只在这个人的私聊里读写。私聊内容不进任何群的上下文，群记忆也不该自动吸收私聊。这和 ChatGPT（个人记忆不进群）、Grok Team Bots（个人笔记不进别人的对话）、OpenClaw（群拿不到私聊内容）一致（3.3、3.5、3.1 节）。
- **能做的事**：私聊里的建议入口可以用跟随气泡（1.5 节）。

### 4.3 风险

1. **谁都能私聊 bot。** bot 可用范围里的任何人都能私聊它（1.5 节）。私聊会话跑在主人的 Mac 上，等于让同事在主人电脑上跑 agent。OpenClaw 默认用配对码挡陌生人（`dmPolicy: pairing`）。
2. **单个会话会越来越长。** 没有话题时只能靠压缩，压缩会丢细节。
3. **私聊读到主人的东西。** 如果私聊会话给了用户身份的 lark-cli 或主人的个人记忆，别人私聊时也可能拿到。私人记忆必须按人分开。
4. **两个入口两套规则。** 群里的回复模式（仅 @、全部、智能）在私聊里没意义，私聊总是回复。这要单独写清楚。

### 4.4 建议

- v1 做私聊，但范围收窄：
  - **bot 主人**：私聊是一个个人会话，用默认工作区，权限沿用 bot 的默认档。管理功能（新建群、诊断、用量）留在同一个私聊里，用卡片按钮进入，和对话分开。
  - **其他人**：默认不跑 agent。回一张卡片，说明"在群里 @ 我"，并列出他所在的、绑了这个 bot 的群。主人可以把某些人加进私聊白名单。
- 理由：
  - 实现成本低。私聊会话和单会话群是同一种会话（按 `chat_id` 一个），只是换了工作区和权限来源。
  - 解决了 #582、#605 这类困惑，又不让陌生人在主人电脑上跑代码。
  - 需要 lark-cli 用户身份的个人能力（查自己的日程、文档、跨群搜索）只能放在主人私聊里。群里永远不给。

---

## 5. 对上下文方案的启示

以下是**推断**，给综合方案参考。

1. **会话单位**：`(bot, 群, 话题)`。不在话题里的消息落到 `(bot, 群)` 的群会话。这把"单会话群"和"多会话群"合成一种群：群主区就是单会话，每个话题是一个独立会话。OpenClaw 的 `group_topic` 就是"按话题分，不在话题里就落回群会话"（`advanced-configuration` 第 109 行），comma 的 Telegram 也是"普通话题进 Router，绑定话题进任务"。
2. **每轮给 agent 的上下文**：原生会话历史，加上这个话题（或群主区）里自上次 bot 回复以来的人对人消息增量，带发信人名字。增量有条数和字数上限，bot 自己的输出不放进去。这就是 bridge 现有的水位机制，可以推广到群主区。
3. **更早的历史**：不预先塞进去。给 agent 一个按需查询的窄工具，机器人身份，只能查当前群和当前话题。
4. **多人**：每条消息带发信人，一个会话里多人共享。会话的权限按群定，不按发消息的人拆会话。#953 说按权限拆会话会让上下文对不上。
5. **多 bot**：每个 bot 在同一个话题里有自己的会话。另一个 bot 的发言要申请 `include_bot` 权限才能收到（1.2 节），收到后当作人对人消息一样进增量。
6. **压缩**：自动压缩为主，保留 `/compact` 命令，卡片上标出"已自动压缩"或"已手动压缩"（现有计划 `providers.md:774` 已有标记行）。压缩前可以先把要点写进记忆，OpenClaw 是这么做的。
7. **记忆**：群记忆、bot 记忆、个人记忆分开。个人记忆只在本人私聊里用。
8. **子 agent**：显示在运行卡里，和主回合的结束分开显示。

---

## 未知和待实测

1. 飞书单聊能不能开话题（`reply_in_thread` 在 p2p 里的行为）。
2. 群设置"新成员可查看历史消息"的默认值，以及它对普通消息（不只是话题）是否同样生效。
3. bridge 只申请 `im:message.group_msg`、没有 `im:message:readonly` 时，`GET /im/v1/messages` 在新应用上能不能用。
4. 消息搜索在机器人身份下开了 `search:message` 后能不能用，范围是否限于机器人所在的群。
5. 企业消息保留策略会不会截断历史接口能读到的范围。
6. Codex 和 Claude 的子 agent 能不能被用户单独发起回合（决定做法 C 是否可行）。
7. ChatGPT 群聊的压缩方式。
8. Character.AI 群聊里谁回、上下文怎么算。
