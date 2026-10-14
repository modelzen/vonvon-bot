# 飞书位置和 Agent 会话怎么对应，每条会话里存什么

2026-10-14。基于 vonvon-bot `main` 的 `2c60ea0`。daemon 代码从上一轮调研用的 `be17859` 到这里没有改过（`git diff --stat be17859..2c60ea0 -- packages/` 为空），所以上一轮报告里的代码行号仍然有效。全程只读：没有改仓库，没有发飞书消息，没有调用写接口。

> 文中的 `r3/fs/`、`fsdocs/`、`codex-approvals.md`、`permission-modes.md` 这类路径，是调研时存在本机的文档副本，没有存进仓库，原文在飞书开放平台和各家官网。Codex 源码指本机的 0.162.1 快照 `codex-rs/`。

怎么读：
- 每条事实后面有出处。"推断"是根据代码或文档推出来、没有实测的；"未知"是查不到的。
- "建议"是我的方案，最后由 owner 定。
- 飞书 id 都写成 `omt_…`、`oc_…` 这种省略形式。

出处缩写：

| 缩写 | 指什么 |
|---|---|
| `D/` | vonvon-bot `packages/daemon/src/`（`2c60ea0`） |
| `FCB/` | feishu-codex-bridge `src/`（v0.6.14，`6698118`） |
| `LSDK` | vonvon-bot 装的飞书 SDK `node_modules/@larksuiteoapi/node-sdk`，1.71.1 |
| `CX` | Codex 源码快照 `codex-rs/`（0.162.1，`092d3ac`，本机副本） |
| `CSDK` | Claude Agent SDK 0.3.296 的 `packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` |
| `FS` | 飞书开放平台文档。`fsdocs/` 是上一轮的本地副本，`r3/fs/` 是今天用 `document_portal` 接口重新拉的 |
| 〔码〕〔飞〕〔模〕〔答〕 | 上一轮报告 `context-code-agents.md`、`context-feishu-products.md`、`context-model.md`、`group-response.md` |

---

## 0. 先回答 owner 的三个问题

**飞书上的位置怎么对应 Agent 会话。** 每个 bot 各算各的。一个 bot 在一个群里：群主区一条会话；它回过话的每个话题各一条会话；私聊里每个主人或管理员一条会话。会话就是一条普通的 Codex 线程或 Claude 会话。这个 bot 第一次在那个位置开口时才建，不提前建。

**上下文关系。** 主区会话和话题会话互不复制历史。话题开出来时，主区会话里只留一行引用：谁、什么时候、在哪条消息下开了话题、话题叫什么、话题 id。话题会话开场带三样：话题第一条消息、话题里已有的消息、主区在第一条消息之前的最近几条。之后两边要看对方的内容，都用 vonvon 飞书 skill 去查。

**哪些存进会话历史。** 只存 bot 真正开始回复时读到的东西，一共四类：
1. 会话开始时的个性和记忆。
2. 每次回复前，这个位置自上次以来的新消息。人说的话带真名，别的 bot 只放最终回答。主区的新消息里包括智能模式判了"不回"的消息，也包括话题引用行。
3. 触发这次回复的消息、它引用的消息、它的附件路径。
4. bot 自己的回答、工具步骤和子 agent 结果，由 Codex 和 Claude 原生记录。

别的话题、别的群、私聊的内容都不进来。消息不是一到就塞进会话，而是等 bot 开口时一起带进去。

下面第 1 到 3 节是现状和平台事实，第 4 节比较几种"存引用"的做法，第 5 节是方案，第 7 节用一个群的时间线把它走一遍，第 8 节列出要 owner 定的问题。

---

## 1. 现在 main 上的代码怎么做

### 1.1 会话键

- 一条记录绑定一个"键"和一个后端会话 id。键的字段名叫 `threadId`，其实存的是话题 id 或群 id（`D/bot/session-store.ts:13-39`）。
- 每个 bot 一个 `bots/<appId>/sessions.json`（`D/config/paths.ts:20-22`、`:41-46`），所以同一个话题里两个 bot 天然是两条会话。
- 多话题群：键是话题的 `thread_id`（`D/bot/handle-message.ts:1091`）。单会话群：键是群的 `chat_id`（`:1031`）。
- 管理员和访客的权限档不同时，键后面加 `#admin` 或 `#guest`，同一个位置会变成两条会话（`D/project/registry.ts:115-126`；`D/bot/handle-message.ts:1246-1253`）。
- 私聊不跑 agent，只弹管理菜单（`D/bot/handle-message.ts:953-966`）。所以私聊今天没有会话键。
- bot 用 `reply_in_thread` 开话题时，话题 id 要等回复发出后再查，查到之前键是 `pending:<触发消息 id>`（`D/bot/handle-message.ts:4205`、`:4380-4400`；查询函数在 `:5773-5791`）。
- 会话记录只用 node 的文件读写（`D/bot/session-store.ts:1-4`），不依赖 Electron。owner 要求后台服务不依赖 Electron，会话映射这一块已经满足。

### 1.2 主区和话题怎么分

- 飞书 SDK 把事件里的 `thread_id` 映射成 `msg.threadId`，`parent_id` 映射成 `msg.replyToMessageId`，`root_id` 映射成 `msg.rootId`（`LSDK lib/index.js:99151-99153`）。
- 代码只看有没有 `threadId`：有就是话题，没有就是主区（`D/bot/handle-message.ts:1070`）。`rootId` 只在私聊的 CLI 桥里用（`:956-958`）。
- 飞书文档写明：在话题里回复的消息都算回复根消息，`root_id` 和 `parent_id` 都是根消息的 id（FS `r3/fs/intro.txt`，消息管理概述"root_id 与 parent_id"一条；`fsdocs/server-docs_im-v1_message_list.md:52-53`）。

### 1.3 single 和 multi 两种群

- `multi`（默认）：主区 @ bot 就用 `reply_in_thread` 开一个新话题、起一条新会话（`D/bot/handle-message.ts:1172`、`:1781-1880`）。话题里的消息是这条会话的一轮（`:1070-1115`）。主区闲聊要 @，命令和 `/goal` 除外（`:1197-1203`）。
- `single`：整群一条会话，键是 `chat_id`，回复用引用不开话题，同一时刻只跑一轮（`:1022-1066`）。
- 单会话群里，如果有人自己开了话题，话题里的消息仍然进整群那条会话（键是 `chat_id`，`:1031`）。同时会按 `thread_id` 去补拉这个话题的消息（`:1516`）。这一点和 `docs/product.md` 3.5"话题是单独一条会话"相反，要改。
- 免 @ 的默认值：只有"被拉进的已有群 + 单会话"默认关，其他都开（`D/project/registry.ts:83-85`）。

### 1.4 context-weave 织进去什么

每条触发消息依次加这些块，都放在用户原文前面（`D/bot/handle-message.ts:1272-1295`）：

| 块 | 内容 | 出处 |
|---|---|---|
| 语音 | 转写的文字 | `:1273` |
| 附件 | 触发消息里的文件下载到本地，给路径清单；图片另外下载交给 agent | `:1275-1285`；`:1333` |
| 引用 | 只要有 `parent_id` 就按 id 取回那条消息，压成一行，最多 800 字 | `:1286-1289`；`D/bot/context-weave.ts:36`、`:77-92`、`:401-411` |
| 发信人 | `[本条消息的发信人：名字（open_id：…）]` | `:1293`；`D/bot/context-weave.ts:445-451` |
| 话题上文 | 只在话题里做，开轮时加在最外面 | `:1516-1524`、`:1626-1634` |

话题上文的细节：
- 新会话或续不上重建时，拉话题里最近的消息，最多 20 条。已有会话只拉水位 `lastSeenAt` 之后的（`D/bot/handle-message.ts:1626-1634`；`D/bot/context-weave.ts:96-101`）。
- 只拉一页 50 条，倒序，每条截到 280 字，不翻页（`D/bot/context-weave.ts:38-45`、`:111-118`、`:130-135`）。
- 过滤掉 bot 和应用的消息、系统消息、空消息、触发消息本身（`D/bot/context-weave.ts:120-129`）。所以 bot B 永远看不到 bot A。
- 别人消息里的附件只写占位，比如 `[图片]`、`[文件：a.log]`（`D/bot/context-weave.ts:196-205`）。
- 名字：拉历史时读 `sender.sender_name`，没有就写"用户 + open_id 尾 4 位"（`D/bot/context-weave.ts:158-160`）。但拉取时没传 `with_sender_name`（`:111-118`）。飞书 SDK 1.71.1 的 `message.list` 和 `message.get` 有这个参数，返回里有 `sender_name`、`open_bot_id`（`LSDK types/index.d.ts:261982-262017`）。所以今天名字大概都是尾号（推断）。
- 触发人的名字恒为"某用户"，因为建通道时没传 `resolveSenderName`（`D/bot/bridge.ts:59-81`；`LSDK lib/index.js:99134`）。
- 主区：没有任何上文织入，因为 `topicId` 只取 `msg.threadId`（`D/bot/handle-message.ts:1516`）。单会话群里没 @ 也没触发的消息，永远进不了会话（〔码〕1.6）。
- 从主区开新话题：开场只有触发消息本身，不带主区在它之前的消息（`D/bot/handle-message.ts:1820-1833`）。

### 1.5 本机有没有存群消息

没有。
- 没触发的消息在 @ 门直接丢掉（`D/bot/handle-message.ts:976`）。
- 本机只存 `sessions.json` 里的绑定和水位（`D/bot/session-store.ts:13-39`）。内存里有活着的会话、正在跑的轮次和上下文用量（`D/bot/handle-message.ts:758-772`、`:853`），重启就没了。
- 撤回和编辑事件都没有订阅。daemon 里 grep 不到 `recalled`，只订阅了 message、cardAction、comment、botAdded、reaction（`D/bot/bridge.ts:114-118`）。

### 1.6 命令

| 命令 | 单会话群 | 多话题群的话题里 | 多话题群主区 | 出处 |
|---|---|---|---|---|
| `/clear` | 只限管理员。停泊旧会话，换一条新的，旧的能 `/resume` | 拒绝，提示开新话题 | 拒绝 | `D/bot/handle-message.ts:2120-2195`；`:1080-1088`；`:1131-1139` |
| `/new` | 没有这个命令 | — | — | `:1176-1188` |
| `/resume` | 管理员，原地换绑 | 拒绝，提示到主区 | 在新话题里贴历史卡并绑定 | `:3744-3800`；`:1075-1079`；`:3806-3845` |
| `/compact` | 能用，只能在空闲时 | 能用 | 拒绝，要在话题里 | `:2004-2110`；`:1141-1145` |

- `/compact` 时来的消息不进会话，提示重发（`D/bot/handle-message.ts:2101-2106`）。`/clear` 和 `/resume` 期间来的消息也一样（`:2191-2193`、`:3797-3803`）。
- `/clear` 和 `/resume` 后的新记录不写水位（`:2165-2177`、`:3783-3791`）。

### 1.7 话题群

- daemon 里没有任何处理 `chat_mode` 或 `group_message_type` 的代码（grep 无结果）。
- 飞书文档说，话题形式群里发消息，响应里就带 `thread_id`（FS `fsdocs/im-v1_message_thread-introduction.md:27`）。所以话题群里一条新帖子 @ bot，会走"话题里"分支，键是帖子的 `thread_id`（推断，`D/bot/handle-message.ts:1070`）。

### 1.8 运行中来了消息

- 同一个键已经有轮次在跑：默认 steer，也就是插进当前这一轮；设置成 queue 就排到下一轮（`D/bot/handle-message.ts:1322-1361`、`:1369-1385`；默认值见 `D/config/schema.ts:236-238`）。
- Claude 后端不支持 steer，自动改成排队（`D/agent/claude-agent/thread.ts:534-538`）。
- 排队的消息一条一轮，按顺序跑（`D/bot/handle-message.ts:4783-4784`）。
- 不同的键并行，全局默认最多 10 个同时跑（`D/bot/handle-message.ts:780`；`bridge-inventory.md` 1.2）。
- `/goal` 运行中，消息不进会话，直接提示（`D/bot/handle-message.ts:1325-1329`、`:1389-1399`）。
- 空闲 45 分钟的会话进程会被关掉，下一条消息再 resume（`D/bot/handle-message.ts:633`、`:5668-5694`）。

### 1.9 读代码看到的毛病（都没实测）

上一轮已经记过的：名字没进去、单会话群没有补拉、拉历史可能缺权限（〔码〕1.11）。这次新看到五处：

1. **话题里每一轮都把根消息当"引用"再织一遍。** 话题里的消息 `parent_id` 恒为根消息（FS 消息管理概述），而代码只要有 `parent_id` 就取回引用（`D/bot/handle-message.ts:1286-1289`）。推断：话题里每一轮开头都会多一块"用户引用了一条消息"，内容是话题第一条。
2. **话题里"引用某条消息"分不出来。** 原因同上，飞书在话题里只给根消息的 id。`docs/product.md` 3.4 底线 1"引用了谁的消息就只有谁回"，在话题里靠 `parent_id` 做不到。话题里有没有别的字段能分出来：未知，要实测。
3. **bot 自己开的话题没有水位。** 开话题后写记录的 `persist()` 不写 `lastSeenAt`（`D/bot/handle-message.ts:4285-4299`）。下一次在这个话题里开轮时，代码看到"有记录没水位"，就跳过补拉（`:1519`、`:1626`）。推断：bot 开话题以后、下一次被叫到之前，话题里别人说的话会漏掉一次。bridge 也一样（`FCB/bot/handle-message.ts:4202-4216`、`:1588`）。
4. **插话和排队的消息不推进水位。** 水位只在开新一轮时推到触发消息（`D/bot/handle-message.ts:1637`）。插进去或排队送进去的消息，下一次开轮时会被当成"之前已有的消息"再织一遍（推断）。
5. **话题消息超过 50 条就丢。** 只拉一页（`D/bot/context-weave.ts:45`、`:111-118`）。话题接口不能按时间过滤（FS `fsdocs/server-docs_im-v1_message_list.md:32-33`），要多翻几页才能拿全水位之后的消息。

---

## 2. bridge 的单会话群和话题

owner 要智能模式的主区"和 Bridge 里面单会话逻辑一样"。bridge 0.6.14 和 v2 在这块是同一份代码，行为如下：

- 单会话群就是"整群一条连续会话、全程免 @"（`FCB/../README.md:94-95`）。键是 `chat_id`（`FCB/bot/handle-message.ts:986-995`），回复用引用，一次跑一轮。
- 命令：`/clear` 只限管理员，换新会话，旧的能 `/resume`（`FCB/bot/handle-message.ts:2066`）。`/resume` 原地换绑（`:3863`）。`/compact`、`/context`、`/model` 都能用（`:986-1029`）。没有 `/new`。
- 运行中的消息：Codex 插话，Claude 排队（同 1.8）。
- 主区没有补拉。没 @、免 @ 又关着的消息，永远进不了会话（`FCB/bot/handle-message.ts:1478`、`:1161-1167`）。
- 单会话群里有人开了话题：话题消息进整群那条会话，并补拉话题上文（`FCB/bot/handle-message.ts:995`、`:1478-1487`）。这和 owner 现在要的"话题是单独的会话"不一样。
- 多话题群：主区 @ 开话题，一个话题一条会话（`FCB/../README.md:94`）。话题里 `/clear` 被拒，提示回主区开新话题（`FCB/bot/handle-message.ts:1049`）。新话题开场只有触发消息（`:1791`）。

所以"和 bridge 单会话一样"能照搬的是：一条会话一直接着聊、`/clear` 换新、`/resume` 换回、`/compact`、自动压缩、运行中插话或排队。要改的是：话题拆出去；主区要补拉没触发的消息；加 `/new`；`/compact` 运行中改成排到这一轮之后，压缩时来的消息排队，不再让人重发（`docs/product.md` 3.5"压缩"）。

---

## 3. 飞书平台事实

### 3.1 话题消息在事件里长什么样

- 接收消息事件 `im.message.receive_v1` 里有 `chat_id`、`chat_type`（p2p 或 group）、`thread_id`、`root_id`、`parent_id`、`mentions`、`sender.sender_type`（FS `fsdocs/server-docs_im-v1_message_events_receive.md:55-80`）。
- `thread_id` 不返回，就不是话题消息（同上）。`root_id`、`parent_id` 只在回复时有值（同上）。
- 在话题里回复，`root_id` 和 `parent_id` 都是根消息（FS `r3/fs/intro.txt`）。
- 话题有 `thread_id`，同时也有 `message_id`（同上，thread_id 一条的注意事项）。

### 3.2 用 reply_in_thread 开话题

- 回复接口传 `reply_in_thread: true` 就以话题形式回复。被回复的消息已经是话题消息时，默认就在话题里回复（FS `fsdocs/server-docs_im-v1_message_reply.md:42`）。
- 回复的响应里带 `thread_id`（同上 `:80`）。v2 没用这个返回值，而是回复后再用 `message.get` 查，最多重试几次（`D/bot/handle-message.ts:5773-5791`）。

### 3.3 话题和消息的链接

- 文档里的 AppLink"打开聊天页面"只能打开一个群或单聊：`https://applink.feishu.cn/client/chat/open?openChatId=oc_…`。只能打开用户已加入的群（FS `r3/fs/chatpage.txt`，即 open.feishu.cn/document/common-capabilities/applink-protocol/supported-protocol/open-a-chat-page）。
- 飞书 SDK 的 `message.get` 和 `message.list` 返回里有 `message_app_link`、`message_position`、`thread_message_position`（`LSDK types/index.d.ts:262036-262038`）。lark-cli 内置的接口说明里，`message_app_link` 的例子是 `https://xxxx/client/thread/open?chatid=xxx&threadid=xxx&thread_position=xxx`（lark-cli 1.0.97 二进制里的接口元数据）。
- 官方 lark-cli 的源码：服务端没给 `message_app_link` 时自己拼。话题消息拼成 `/client/thread/open?openthreadid=…&openchatid=…&thread_position=…`，主区消息拼成 `/client/chat/open?openChatId=…&position=…`（github.com/larksuite/cli `shortcuts/im/convert_lib/content_convert.go:288-322`，PR #668）。
- 所以 bot 可以自己拼出一个跳到话题的链接（推断，`thread/open` 和 `position` 不在公开文档里，要实测）。
- 客户端"复制消息链接"得到的是 `client/message/link/open?token=…`，token 是加密的，开放接口不能生成，也不能反解（github.com/larksuite/cli/issues/1031，到 2026-10-12 仍未解决）。

### 3.4 bot 能不能收到群里每个话题的消息

- 有 `im:message.group_msg` 权限时，事件推送"群聊中所有用户消息，不包含机器人消息"（FS `fsdocs/server-docs_im-v1_message_events_receive.md:18-19`）。
- 话题里的回复也是群消息。bridge 的"话题里免 @"就靠这个收到不 @ 的话题回复（`D/bot/handle-message.ts:1197-1203`）。推断能收到每个话题，包括用户自己开、bot 没参与的话题。
- 例外：群关了"新成员可查看历史消息"，而话题在 bot 进群前就有了，这个话题对 bot 不可见，要被 @ 才订阅（FS `fsdocs/im-v1_message_thread-introduction.md:57-59`；`fsdocs/server-docs_im-v1_message_list.md:130`，错误码 230073）。推断这种话题的事件也收不到。
- 别的 bot 的消息收不到，除非申请 `include_bot` 类权限（FS 接收消息事件 `:14-19`）。事件文档的权限表里还列了一个 `im:message.group_bot_msg:readonly`"获取群组中其他机器人发送的消息"（同上，事件基本信息表）。它和 `include_bot` 的区别：未知。
- bot 对 bot 用话题回复时，可能被收进群成员看不到的"话题视图"（〔答〕1.5，来自飞书官方 OpenClaw 插件的注释，没实测）。

### 3.5 话题群

- 话题群（`chat_mode=topic`）只能在客户端建，建好后只能发话题。话题形式群（`chat_mode=group`、`group_message_type=thread`）可以在对话消息和话题消息之间切换。官方推荐后者（FS `fsdocs/im-v1_message_thread-introduction.md:61-75`）。
- 话题形式群里，所有消息都以话题发出，回复只能在话题里（同上 `:42`）。所以话题群里实际没有"主区对话"，每个帖子就是一个话题。

### 3.6 拉一个话题的消息、只拉主区的消息

- `GET /im/v1/messages`：`container_id_type=thread` 拉一个话题，不能按时间过滤；`container_id_type=chat` 拉群（FS `fsdocs/server-docs_im-v1_message_list.md:30-33`）。
- 普通群里按 `chat` 拉，只能拿到话题的根消息，拿不到话题里的回复（同上 `:30`）。所以"只拉主区"就是按 `chat` 拉：主区的消息，加上每个话题的根消息（根消息本来就是主区里的一条）。
- 一页 1 到 50 条，翻页时不能换排序（同上 `:34-35`）。限流每分钟 1000 次、每秒 50 次（同上 `:16`）。
- SDK 还有两个公开文档没写的参数：`only_thread_root_messages` 和 `with_sender_name`（`LSDK types/index.d.ts:261992-261993`）。官方 lark-cli 拉消息时就带 `with_sender_name=true`（lark-cli 1.0.97 二进制）。lark-cli 的 skill 说明写着：读接口返回 `sender_name`，用户和 bot 都有，不需要通讯录权限（`lark-cli skills read lark-im`，"Sender Name Resolution"一节）。和上一轮"拉历史不返回名字"的结论（〔码〕1.7）不同，以实测为准。
- 用应用身份读群消息的权限：先要 `im:message`、`im:message:readonly`、`im:message.history:readonly` 之一，再加 `im:message.group_msg`（同上 `:18`）。`docs/product.md` 3.11 已经把 `im:message:readonly` 列为新增必需。
- 返回里每条有 `deleted` 和 `updated`。撤回的消息 `content` 固定是 `This message was recalled`（同上 `:54-58`）。

### 3.7 撤回和编辑

- 撤回有事件 `im.message.recalled_v1`，只收得到 bot 所在会话里的撤回，要 `im:message` 或 `im:message:readonly`（FS `r3/fs/_server-docs_im-v1_message_events_recalled.txt`）。
- 用户编辑消息：没找到事件。消息事件文档目录里只有接收、已读（只有单聊）、撤回三个（FS `fsdocs/messaging.txt:20-23`）。编辑只能在拉历史时从 `updated`、`update_time` 看出来。
- 编辑接口只能改自己发的文本和富文本，最多 20 次（FS `r3/fs/_server-docs_im-v1_message_update.txt`）。

### 3.8 客户端里的话题（帮助中心）

来自 www.feishu.cn/hc/zh-CN/articles/423295624296"使用话题回复"：
- 对话群和**单聊**里都能给某条消息创建话题。上一轮"单聊能不能开话题：未知"（〔飞〕1.5），从用户这边看是能的。bot 能不能在单聊里 `reply_in_thread`：仍未知。
- 5.30 以上的客户端，话题回复直接显示在那条消息下面，最多显示最近 5 条。
- 回复话题时可以勾"同时发送到群"（单聊里叫"同时发送到会话"），让没参与的成员也收到。接口里对应 `sync_to_chat_info`，类型 1 是话题回复，类型 2 是同步到群里的那条（lark-cli 1.0.97 内置的消息接口元数据）。
- 回复话题时不能加本地文件和文件夹附件，只能加云文档链接或已上传的文件链接。

---

## 4. "把话题引用存进主区会话"有几种做法

前提：主区会话是一条原生 Codex 线程或 Claude 会话。主人可能在 Codex 应用里或用 `claude --resume` 打开它（`docs/product.md` 3.5）。

| 做法 | 怎么做 | 模型看不看得到 | 在 Codex 应用或 claude --resume 里看不看得到 | 代价 |
|---|---|---|---|---|
| **A. 下一次主区回复时写进对话记录块（推荐）** | 主区下一次开轮时，记录块里按时间插一行"某人在某条消息下开了话题 T" | 看得到 | 看得到，是那一轮用户消息的一部分 | 不用多拉进程。引用要等主区下次回复才进会话，在那之前打开会话看不到 |
| B1. Codex `thread/inject_items` 立即追加 | 话题一开就往主区线程追加一条 user 项，不开回合（`CX app-server-protocol/src/protocol/common.rs:875-880`） | 看得到 | **看不到**。线程历史投影只保留 hook 提示，别的注入 user 项被丢掉（`CX app-server-protocol/src/protocol/thread_history.rs:477-501`） | 线程要先加载（`CX app-server/src/request_processors/turn_processor.rs:990`）。空闲 45 分钟的会话已经被关（`D/bot/handle-message.ts:633`），追加一行就要起一个 app-server 进程。违背"看到的和 bot 一样" |
| B2. Claude `shouldQuery: false` 立即追加 | 往主区会话写一条不触发回合的 user 消息，合进下一条真正的提问（`CSDK:6352-6355`） | 看得到（和下一条一起） | 看得到，落盘成普通 user 条目（`CSDK:2137-2139`） | 要求会话的流式 query 活着，空闲关掉后要重新拉起。只有 Claude 有，两家行为不一致 |
| C. Codex `turn/start.additionalContext` | Codex 0.162 新加的实验字段：按 key 去重的上下文片段，分"不可信"和"应用"两种（`CX app-server-protocol/src/protocol/v2/turn.rs:104-119`、`:207-210`；`CX core/src/state/additional_context.rs:15-34`） | 看得到 | 推断看不到：它变成 ResponseItem，不是用户消息事件，投影规则同 B1 | v2 生成的 0.156.1 协议里没有这个字段（`D/agent/codex-appserver/protocol/generated/v2/TurnStartParams.ts`）。实验字段，Codex.app 升级可能改名 |
| D. 合成一轮 | 话题一开，就给主区会话发一轮"记一下：开了话题 T"，让它回一句 | 看得到 | 看得到，多出一来一回 | 每开一个话题就多跑一轮 agent，占额度；模型可能顺手做别的事；占着主区会话，真有人说话时要排队 |
| E. 不存，全靠 skill | 主区会话里什么都不留，要时 bot 自己查本群话题列表 | 只有查了才看得到 | — | bot 不知道有话题，就不会去查。主区有人问"刚才那个话题怎么样了"时容易答错 |

建议 A。理由：
1. 只有 A 在两家都一样，而且原生应用里看到的和模型看到的完全一致。
2. 不用为了加一行字去拉起一个会话进程。
3. 它就是"上次回复以后的新消息"这条规则的自然延伸：话题的根消息本来就是主区的一条消息，只是渲染时多一个"已转到话题"的标记。

A 唯一的缺点是：主区下次开口之前，引用不在会话里。但这段时间里主区会话没有在思考，模型看不看得到都没影响。

压缩以后引用可能被摘要掉。补救办法见第 6 节第 13 条。

---

## 5. 方案

### 5.1 对应表

每个 bot 各算各的，下表是"一个 bot 在一个位置上"。

| 飞书位置 | 智能模式 | 规则模式"连续" | 规则模式"开话题" | 会话键 | 什么时候建 |
|---|---|---|---|---|---|
| 群主区 | 一条会话 | 一条会话 | 没有会话 | `chat_id` | 这个 bot 第一次在主区回复时 |
| 话题（用户开的、bot 开的、话题群的帖子） | 一条会话 | 一条会话 | 一条会话 | `thread_id` | 这个 bot 第一次在这个话题里回复时 |
| 私聊（主人、每个管理员） | 每人一条 | 同左 | 同左 | 单聊的 `chat_id`（每人不同） | 第一次私聊时 |
| 私聊里的话题 | 一条会话（建议，要实测） | 同左 | 同左 | `thread_id` | 同话题 |
| 云文档评论 | 每篇文档一条，今天已有 | | | 文档 | 今天的做法 |

- 群里给访客设了不同的权限档时，键后面加 `#guest`，访客另走一条会话，和今天一样（`docs/product.md` 3.5）。影响见第 6 节第 10 条。
- 不在同一个位置里悄悄换会话。只有 `/new`、`/clear`、`/resume` 会换（`docs/product.md` 3.5）。

### 5.2 每条会话里存什么

**主区会话**

| | 内容 |
|---|---|
| 开场（第一轮） | 个性和记忆（会话层指令）。主区最近的消息，按字数预算截断，建议最多 20 条，带话题引用行。然后是触发消息、它引用的消息、附件路径 |
| 之后每一轮 | 水位以后主区的新消息：真人的话（带真名，包括判"不回"的），别的 bot 的最终回答（标"某某（bot）"，截到几百字），水位以后新出现的话题的引用行。然后是触发消息、它引用的消息、附件 |
| 不放 | 话题里的回复，包括 bot 自己在话题里说的话；别的群；私聊；别的 bot 的过程和子 agent；bot 自己在主区的回复（原生会话里已经有了） |

**话题会话**

| | 内容 |
|---|---|
| 开场 | 个性和记忆。一行回指："这个话题开在群主区 HH:MM 某人的消息下，主区更早的内容需要时用 vonvon 飞书 skill 查"。主区在根消息之前的最近几条（建议 10 条，按字数截）。话题根消息，它的附件按引用消息处理。话题里已有的消息，按字数截，保留最近的。最后是触发消息 |
| 之后每一轮 | 水位以后这个话题里的新消息：真人的话，别的 bot 的最终回答。然后是触发消息和附件 |
| 不放 | 根消息之后主区的消息；别的话题；不重复放根消息（今天每轮都放，见 1.9 第 1 条） |

**私聊会话**：个性加这个人的私聊记忆；每轮是这个人的消息、引用和附件。私聊里只有一个人，用不着对话记录块的署名。

几条共用的规则：
- 只有 bot 开口时才写会话。判"不回"的消息先留在飞书里，下次开口时一起带上（`docs/product.md` 3.5）。
- 水位记在会话记录里：会话已经读到的最后一条消息的时间和 id。每送进一条就推进，包括触发、插话、排队和记录块里的消息。这样能修掉 1.9 第 3、4 条。
- 拉主区用 `container_id_type=chat` 加 `start_time`，拉话题用 `thread` 并翻页到水位为止。两种都带 `with_sender_name`（实测前是推断，3.6）。
- 别的 bot 的卡片回答要带 `card_msg_content_type` 拿正文（FS `fsdocs/server-docs_im-v1_message_list.md:36`；v2 已有回查函数 `D/bot/card-content.ts:15-45`）。同一台 Mac 上的 bot，daemon 直接拿它的最终回答。
- bot 自己的消息不进记录块，因为原生会话里已经有了。但它可以作为话题的根，这时用 daemon 本机记下的那条最终回答，不去解析卡片。

### 5.3 记录块和引用行长什么样

主区：

```
[飞书 · 群「支付组」· 主区 · 你是「小审」]
09:58 张三：下午三点发版，大家注意
10:01 张三 → @小码：订单接口今天一直报 500，帮忙看下
10:01 〔话题〕小码（bot）在上面这条下开了话题「订单接口 500」，在话题里回复。话题是另一条会话，这里不用接。（话题 id：omt_…）
10:05 张三 → @你：帮我看下 PR 12 的 diff，有没有风险
[/飞书]
```

话题开在一条已经进过会话的消息下时，引用行单独一行，带上那条消息的时间：

```
10:10 〔话题〕李四 在你 10:05 的回复下开了话题「金额为 0」，你在那边另有一条会话。（话题 id：omt_…）
```

- 引用行由 daemon 生成。用户的话都是"时间 名字：内容"压成一行（`D/bot/context-weave.ts:375-384`），所以用户伪造不出一行以"〔话题〕"开头的引用。
- 话题 id 留给 agent 用 skill 查。跳转链接（3.3）在原生应用里能点，但没实测，第一版可以不放。
- 引用行不带话题里的内容。

话题开场：

```
[飞书 · 群「支付组」· 话题「订单接口 500」· 你是「小审」]
这个话题开在群主区 10:01 张三的消息下。主区的其他内容不在这里，需要时用 vonvon 飞书 skill 查。
主区在这之前：
09:58 张三：下午三点发版，大家注意
话题里：
10:01 张三 → @小码：订单接口今天一直报 500，帮忙看下（话题第一条）
10:03 李四：是不是昨天改了 token 过期时间？
10:06 小码（bot）：空指针在 OrderService 第 88 行，已改……
10:12 张三 → @你：你也看下小码的修复有没有问题
[/飞书]
```

### 5.4 daemon 要新记的本机状态

1. **话题登记表**，每个 bot 每个群一份：话题 id、根消息 id、第一次看到的时间、谁开的、标题（根消息开头几个字）、这个 bot 在里面有没有会话。
   - 来源：收到一条带新 `thread_id` 的事件；bot 自己开话题；拉主区时看到带 `thread_id` 的根消息。
   - 用途：给主区会话生成引用行（"上次以后新出现的话题"）；给 skill 列出本群的话题。
   - 为什么要它：话题常常开在一条旧消息下。按时间拉主区拉不到这条"新事件"，因为根消息的创建时间是旧的。
2. **会话水位**：见 5.2。
3. **最近消息的内存缓冲**：每个群留最近几十条，只给判断模型用，不落盘。daemon 重启就清空，回复时以飞书拉到的为准。是否落盘见第 8 节问题 8。

这些都放在 daemon 里，和 `sessions.json` 同一个目录（`D/config/paths.ts:41-46`），不依赖 Electron。

### 5.5 命令

| 命令 | 主区（智能、连续） | 话题 | 私聊 |
|---|---|---|---|
| `/new`、`/clear` | 换新会话，旧的停泊。新会话的水位从这条命令开始，开场不带旧消息。只限管理员（主区会话大家共用） | 不换，提示"要新的就开新话题"（bridge 多话题群就是这样，见第 8 节问题 6） | 换新会话 |
| `/resume` | 原地换回旧会话，和 bridge 单会话群一样 | 不支持，提示到主区 | 原地换 |
| `/compact` | 能用。正在跑时等这一轮结束再压，压缩时来的消息排队 | 同左 | 同左 |

- `/new` 以后，旧会话里的话题引用跟着旧会话走。新会话只收 `/new` 以后新出现的话题。以前的话题用 skill 列。
- 话题会话不受主区 `/new` 影响。

### 5.6 运行中来了消息

- 同一条会话：沿用今天的插话（Codex）或排队（Claude）。
- 智能模式的主区正在跑长任务时，来了一条新的事：建议判断结果里的"在主区接着聊"改成插话或排队，"开新话题"就开一个新话题、起新会话并行做，不挡在长任务后面。被 @ 的消息怎么放，见第 8 节问题 1。
- 引用 bot 正在跑的那张卡片、或者明显是在接着说这件事的，插进当前这一轮。

---

## 6. 边界情况

| # | 情况 | 建议 | 依据 |
|---|---|---|---|
| 1 | 用户自己开了话题，一直没 @ bot | 智能模式：话题里还没有 bot 说过话，每条调判断，只判回不回（`docs/product.md` 3.4）。判"不回"就不建会话。主区会话下次回复时只看到一行引用。后来有人 @ 了，才建话题会话，开场带话题里已有的全部消息（按预算截） | 3.4 |
| 2 | 一个群里几个 bot | 每个 bot 各自的会话、各自的话题登记表、各自的引用行。A 开的话题，B 的主区会话也会看到引用行"A（bot）开了话题"。B 只有在话题里被 @ 才建自己的话题会话，开场里 A 的发言只放最终回答 | `docs/product.md` 3.4 底线 2、3 |
| 3 | 主区在跑长任务 | 见 5.6。新的事开话题并行，不排在长任务后面 | 1.8 |
| 4 | 主区和话题里的 `/new` | 见 5.5 | 1.6 |
| 5 | 话题开在一条已经进过主区会话的消息下（包括 bot 自己的回复） | 主区会话：下次回复时多一行引用，带上那条消息的时间。话题会话：开场照样带这条根消息，所以同一条内容会出现在两条会话里，这是允许的 | 5.3 |
| 6 | 话题群、话题形式群 | 没有主区对话：每个帖子就是一个话题会话，不调"要不要开话题"。话题形式群可以切回对话消息，有 `thread_id` 就当话题，没有就当主区 | 3.5 |
| 7 | 用户勾了"同时发送到群" | 话题里那条照常进话题会话。主区那份副本不单独触发主区会话，渲染成"某人在话题 T 里说：…"的一行，标明来自话题。它会产生几次事件、副本带不带 `thread_id`：未知，要实测 | 3.8 |
| 8 | 撤回 | 还没进会话的：拉历史时 `deleted=true` 就跳过，今天已经这样（`D/bot/context-weave.ts:121`）。已经进了会话的：建议订阅撤回事件，下次开轮时加一行"10:03 李四撤回了一条消息，请不要再用它"。原生会话里的旧内容删不掉 | 3.7 |
| 9 | 编辑 | 没有编辑事件。bot 读到的是开口那一刻的版本。已经进会话的旧版本不更新 | 3.7 |
| 10 | 访客分档 | 同一个主区会有两条会话（管理员的和访客的），各自有水位和引用行，也各自会被同样的话题引用。代价是两边对话互相不知道（`docs/product.md` 3.5 已接受） | 1.1 |
| 11 | 私聊 | 主人和每个管理员各一条。用户在私聊里开了话题：建议也是单独会话，和群一致。bot 能不能在私聊里开话题：要实测 | 3.8 |
| 12 | 文件和图片 | 触发消息、引用消息和话题根消息的附件下载到本地给路径。记录块里别人消息的附件只写名字。话题回复里本来就不能加本地文件 | 1.4；3.8 |
| 13 | 压缩把引用压掉了 | skill 加一个"列出本群话题"（读话题登记表加飞书主区根消息）。可选：检测到压缩（Claude 的 `compact_boundary`、Codex 的 `contextCompaction` 项）后，下一次主区开轮时附一张"本群最近 5 个活跃话题"的短表 | `CSDK:3776-3784`；〔码〕2.1 |
| 14 | daemon 离线时有人开了话题 | 离线期间的事件会不会补推：未知（〔码〕未知第 1 条）。主区新消息靠拉历史补上；离线时开在旧消息下的话题，登记表里会漏。补救：启动时拉主区最近一页，把带 `thread_id` 的根消息补进登记表 | 3.6 |
| 15 | 话题在 bot 进群前就有，群关了"新成员可查看历史" | bot 看不到这个话题，被 @ 后才可见。开场能拉到多少：要实测 | 3.4 |
| 16 | 话题的根消息是 bot 的卡片 | 自己的卡片用本机记下的最终回答；别的 bot 的卡片带 `card_msg_content_type` 去拉 | 5.2 |
| 17 | 话题里引用某条消息 | 飞书只给根消息的 id，分不出引用的是哪条（1.9 第 2 条）。话题里的点名只看 @ | 3.1 |
| 18 | 同一个人在主区和话题里同时说话 | 两条会话各收各的，可以并行 | 1.8 |
| 19 | 话题里超过 50 条 | 翻页拉到水位为止，再按字数预算截断，写"更早还有 N 条，可以查" | 1.9 第 5 条 |
| 20 | 规则模式"开话题"的群 | 主区没有会话，也就没有引用行。话题规则和智能模式一样 | 5.1 |

---

## 7. 一个群的时间线

群「支付组」，普通群。真人张三、李四。两个 bot 在同一台 Mac 上，都是智能模式：小码（Codex）、小审（Claude）。

可能出现的会话：码·主、码·T1、审·主、审·T1、审·T2。"历史"是这条原生会话里已经有的；"待带"是下次这条会话开口时会作为新上下文带进去的（还在飞书里，没进会话）。

**#1 09:58 主区，张三："下午三点发版，大家注意"**
- 判断：两个智能 bot 合成一次判断，结果都不回。
- 会话：都还没建。
- 待带：码·主 {#1}；审·主 {#1}。

**#2 10:01 主区，张三："@小码 订单接口今天一直报 500，帮忙看下"**
- 小码被 @，一定回。回在哪里由判断决定（第 8 节问题 1 推荐的做法），结果是开新话题。小码用 `reply_in_thread` 回复 #2，话题 T1 产生，根消息是 #2。
- 小审：@ 了别人，不回，不调判断。
- 码·T1 新建。第一轮输入：回指行 + 主区在 #2 之前的 {#1} + 根消息 #2（也就是触发消息）。
- 话题登记表：T1，根 #2，小码开的，10:01。
- 待带：码·主 {#1, #2, T1 引用行}；审·主 {#1, #2, T1 引用行}。

**#3 10:03 T1，李四（没 @）："是不是昨天改了 token 过期时间？"**
- T1 里最近说话的 bot 是小码（底线 2）。T1 里有两个真人，所以调一次判断，只判小码回不回，结果回。
- 小码第一轮还在跑，Codex 把 #3 插进当前这一轮。
- 码·T1 历史：{开场, #2, 插话 #3}。水位推到 #3。

**10:06 小码在 T1 回复 R1："空指针在 OrderService 第 88 行，已改……"**
- 码·T1 历史：{开场, #2, #3, R1 和工具步骤}。

**#4 10:05 主区，张三："@小审 帮我看下 PR 12 的 diff，有没有风险"**
- 小审被 @，判断放在主区。审·主新建。
- 第一轮输入：主区记录块 {#1, #2, T1 引用行} + 触发 #4。小审在主区引用 #4 回复 R4。
- 审·主历史：{开场块, #4, R4}。水位推到 #4。
- 待带：码·主 {#1, #2, T1 引用行, #4, R4 记为"小审（bot）"的最终回答}。

**#5 10:08 主区，李四："中午吃啥"**
- 判断：都不回。
- 待带：审·主 {#5}；码·主 {…, #5}。

**#6 10:10 李四在小审的回复 R4 下开了话题 T2："@小审 金额为 0 的情况你再展开说说"**
- 小审在 T2 被 @。审·T2 新建。开场：回指行 + 主区在 R4 之前的 {#1, #2, T1 引用行, #4} + 根消息 R4（用本机记下的小审自己的回答）+ 触发 #6。小审回复 R6。
- 审·T2 历史：{开场, #6, R6}。
- 话题登记表：T2，根 R4，李四开的。
- 待带：审·主 {#5, "李四在你 10:05 的回复下开了话题 T2"}。R4 已经在审·主历史里，不重复。码·主 {…, T2 引用行}。

**#7 10:12 T1，张三："@小审 你也看下小码的修复有没有问题"**
- 点名小审，底线 1 优先于底线 2。小码不回。
- 审·T1 新建。开场：回指行 + 主区在 #2 之前的 {#1} + T1 里已有的 {#2, #3, R1 记为"小码（bot）"} + 触发 #7。小审回复 R7。
- 审·T1 历史：{开场, #7, R7}。
- 待带：码·T1 {#7, R7 记为"小审（bot）"}。

**#8 10:15 T1，李四："@小码 按小审说的改一下"**
- 码·T1 第二轮。新上下文：{#7, R7（小审 bot）} + 触发 #8。小码回复 R8。
- 码·T1 历史：{开场, #2, #3, R1, #7, R7, #8, R8}。
- 待带：审·T1 {#8, R8（小码 bot）}。

**#9 10:20 主区，张三："@小码 把迁移脚本整个重写一遍"**
- 小码被 @，判断放在主区。码·主新建，开场：主区记录块 {#1, #2, T1 引用行, #4, R4（小审 bot）, #5, T2 引用行} + 触发 #9。开始一个长任务。

**#10 10:25 主区，张三："@小码 迁移脚本别动 config 目录"**
- 码·主正在跑，这条是接着当前任务说的，Codex 插进当前这一轮。码·主历史加 #10。

**#11 10:40 主区，张三："@小审 把刚才两个话题的结论总结一下发群里"**
- 审·主第二轮。新上下文：{#5, T2 引用行, #9, #10，以及小码在主区的回答（如果已经发出）} + 触发 #11。
- 里面没有 T1、T2 的内容。小审看到两个话题 id，用 vonvon 飞书 skill 去读 T1 和 T2。运行卡显示"查了话题 T1（8 条）、T2（3 条）"。然后在主区回答。
- 查到的内容作为工具结果进了审·主的历史。这是 bot 自己查的，不是 daemon 塞的。

**#12 10:45 主区，张三："@小审 /new"**
- 审·主停泊（能 `/resume`），换成新的审·主′，历史为空，水位从 #12 开始。
- 审·T1、审·T2 不受影响。下次审·主′开口，只带 #12 以后的主区消息和新话题的引用行。

**最后各会话里有什么**

| 会话 | 历史里的飞书内容 | 没进去的 |
|---|---|---|
| 码·T1 | #1（主区背景）、#2、#3、R1、#7、R7、#8、R8 | 主区 #4 以后的一切；T2 |
| 码·主 | #1、#2、T1 引用行、#4、R4、#5、T2 引用行、#9、#10 | T1、T2 里的回复 |
| 审·主（已停泊） | #1、#2、T1 引用行、#4、R4、#5、T2 引用行、#9、#10、#11，以及它用 skill 查到的 T1、T2 内容 | — |
| 审·主′ | 空 | — |
| 审·T1 | #1、#2、#3、R1、#7、R7 | #8、R8（待带） |
| 审·T2 | #1、#2、T1 引用行、#4、R4、#6、R6 | 主区 R4 以后的消息 |

判断调用：#1 一次，#3 一次，#5 一次。#2、#4、#9 各一次，前提是问题 1 选 B。#6、#7、#8 被点名或在自己的话题里被 @，不调判断。#10、#11 被 @ 且接着当前任务或在主区，按问题 1 的做法决定。

---

## 8. 要 owner 确认的问题

每题给选项和推荐。

**问题 1：智能模式下，主区里有人 @ bot，回在哪里？**
- A. 一律在主区回，进主区会话。
- B. 调一次判断，只决定位置：主区接着聊，还是开新话题。判断出错或超时就在主区回。
- C. 让主区会话自己决定，给它一个"移到话题"的工具。
- 推荐 B。`docs/product.md` 3.4 写的是"被 @ 的消息不调判断，一定回"，但没说回在哪里。owner 说过"智能模式就会判断新消息是不是需要创建一个飞书话题"。A 会把所有被 @ 的事都塞进主区会话，越滚越长。C 要先跑一轮完整的 agent，贵。B 每次多一次小模型调用。

**问题 2："主区只留一条引用"指的是什么？**
- A. 只在主区会话里存一行引用，模型看得到，群里不另发消息。
- B. 还要在群主区发一条看得见的消息，带话题链接。
- 推荐 A。飞书 5.30 以上的客户端，话题回复直接显示在那条消息下面，最多 5 条（帮助中心 423295624296），主区的人本来就看得到有个话题。B 多一条消息，还占群里所有 bot 共用的每秒 5 条额度（〔飞〕1.6）。

**问题 3：引用什么时候存进主区会话？**
- A. 主区会话下次开口时，写进对话记录块（第 4 节 A）。
- B. 话题一开就立刻追加（Codex 用 `inject_items`，Claude 用 `shouldQuery:false`）。
- C. 话题一开，就给主区会话发一轮。
- 推荐 A。只有 A 在两家行为一样，主人在 Codex 应用或 `claude --resume` 里看到的和模型看到的一样，而且不用为一行字拉起进程。B 的 Codex 那一半在应用里看不到。C 每个话题多花一轮额度。

**问题 4：引用里带多少？**
- A. 一行：谁、什么时候、在哪条消息下、话题标题、话题 id。
- B. 再带"话题现在有 N 条回复、最后一条说了什么"。
- C. 每次主区回复都附一张"本群活跃话题"表。
- 推荐 A，压缩后补一次 C（第 6 节第 13 条）。B 每次开口都要多查每个话题，内容一多又变成复制话题历史，和"主区只留引用"不符。

**问题 5：新话题开场带多少主区上文？**
- A. 只带话题第一条。
- B. 第一条加主区在它之前的最近 N 条（`docs/product.md` 3.5 的"最近几条"），建议 N=10，按字数截。
- C. 把主区会话整段分叉过去（第一版不做，第 7 节）。
- 推荐 B，请 owner 确认 N。主区新会话的开场建议最多 20 条，也请一起确认。

**问题 6：话题里发 `/new` 怎么办？**
- A. 不换，提示"要新的就开新话题"，和 bridge 多话题群一样。
- B. 在这个话题里换一条新会话，旧的能 `/resume`。
- 推荐 A。一个话题就是一条会话，用户看得懂。B 会让同一个话题在原生应用里对应好几条会话。

**问题 7：主区正在跑长任务时，来了一件新的事？**
- A. 和今天一样，插话或排队。
- B. 智能模式判断：接着当前任务的插话或排队；新的事开话题并行做。
- C. 一律开话题。
- 推荐 B。A 会让一件新的事等长任务跑完，或者打乱长任务。C 会把"顺便说一句"也拆出去。

**问题 8：daemon 要不要把群消息存到本机磁盘？**
- A. 不存盘。内存里每个群留最近几十条，只给判断用；回复时从飞书拉。
- B. 存盘，留 N 天。没有 `im:message:readonly`、或者飞书拉不到时也有上下文。
- 推荐 A。`docs/product.md` 3.11 写了"缺了权限时 bot 只看触发消息和 daemon 本机记下的消息"，A 下"本机记下的"就是内存里自启动以来的那些。B 等于在主人电脑上多一份所有群的聊天记录，要写隐私说明和清理办法。只有话题登记表和水位落盘，它们不含聊天内容。

**问题 9：撤回怎么处理？**
- A. 不处理。还没进会话的自然跳过，已经进了的就留着。
- B. 订阅撤回事件，下次开轮时加一行"某条消息已撤回，请不要再用它"。
- 推荐 B。撤回事件要的权限 `im:message:readonly` 第一版本来就要加（3.7）。编辑没有事件，第一版不跟踪。

**问题 10：用户在私聊里开话题？**
- A. 私聊里的话题也是单独会话，和群一致。
- B. 私聊只有一条会话，话题里的消息也进去。
- 推荐 A，等实测 bot 能不能在私聊里开话题。

---

## 9. 要在 Mac 上实测的

用真实的飞书应用和真实客户端测：
1. `message.list` 和 `message.get` 带 `with_sender_name=true` 时，用应用身份能不能返回 `sender_name`，bot 发的消息有没有 `open_bot_id`。
2. 返回里有没有 `message_app_link`、`message_position`、`thread_message_position`。自己拼的 `client/thread/open?…` 在 Mac 客户端和手机上能不能跳到话题。
3. 话题里的回复事件，`parent_id` 是不是恒为根消息。用户在话题里引用某一条时，事件里有没有别的字段能分出来。
4. 话题形式群和话题群里，新帖子的接收事件带不带 `thread_id`，`root_id` 是不是空的。
5. 有 `im:message.group_msg` 时，用户自己开、bot 没参与的话题里，不 @ 的回复能不能收到。群关了"新成员可查看历史"时，进群前的话题怎么样。
6. 勾了"同时发送到群"以后，bot 收到几次事件，主区那份副本带不带 `thread_id` 和 `sync_to_chat_info`。
7. bot 能不能在私聊里用 `reply_in_thread` 开话题；用户在私聊里开的话题，事件里带不带 `thread_id`。
8. 拉历史时别的 bot 的消息会不会返回（`sender_type=app`），卡片正文要哪个 `card_msg_content_type` 才拿得到。
9. 有 `im:message:readonly` 时能不能收到撤回事件，事件里有哪些字段。
10. Codex 应用里打开 bot 的线程，用户消息里的对话记录块和引用行是不是原样显示。用 `inject_items` 注入的内容是不是真的不显示。`claude --resume` 里 `shouldQuery:false` 追加的内容是否可见。
11. 第一版定的最低 Codex 版本里，有没有 `turn/start.additionalContext`。
12. 压缩以后，主区会话的摘要里还留不留话题引用。
13. daemon 断线期间的消息事件，飞书重连后会不会补推。

---

## 10. 对 docs/product.md 的改动建议

只列跟本题有关的，等 owner 回答第 8 节以后再改：
- 3.4"被 @ 的消息不调判断，一定回"后面补一句：智能模式下主区被 @ 时回在哪里（问题 1）。
- 3.5 补三点：引用行的格式和"下次开口时写进记录块"（问题 2、3、4）；新主区会话和新话题开场各带多少条（问题 5）；话题里的 `/new` 怎么办（问题 6）。
- 3.5"bot 回复时看到什么"的"不放"里加一条：话题里不重复放根消息。
- 3.11 `im:message:readonly` 那一行的用途里加上"撤回事件"（问题 9）。
- 实现清单里加上 1.9 那五个毛病的修复：每轮重复织入根消息、bot 开的话题没有水位、插话和排队不推进水位、话题只拉一页、名字没带 `with_sender_name`。

---

## 核实记录

另一个代理（Sonnet）独立复查了这份报告，只拿到报告本身和仓库，没有作者的推理过程。下面是它逐条核对的结论和它指出的缺口，原样保留，只改了格式。正文和这里冲突时，以这里为准。

| 说法 | 结论 | 说明 |
|---|---|---|
| 会话键:有 threadId 用话题 id,否则 chat_id;主区/话题只看 msg.threadId | 核实 | D/bot/handle-message.ts:1031 turnSession(msg.chatId..)、:1070 if(msg.threadId)、:1091 turnSession(msg.threadId..) 均吻合。 |
| 话题内回复的 root_id 和 parent_id 都是根消息 id | 核实 | 飞书消息管理概述原文:"在话题内回复的消息,都是在回复根消息,所以 root_id 和 parent_id 均是指根消息的 message_id"(document_portal fullPath=/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro)。 |
| 毛病1:话题每轮都把根消息当引用再织一遍 | 核实 | 代码侧成立:handle-message.ts:1286-1289 只要 replyToMessageId 就 fetchQuotedMessage。结论依赖上一条文档事实,属于合理推断,未实测;报告标了推断,恰当。 |
| 毛病3:bot 自己开的话题没有水位(persist 不写 lastSeenAt) | 核实 | persist() 在 handle-message.ts:4285-4299 的 upsertSession 确实无 lastSeenAt;只有新建会话路径 :1578 写。:1519/:1626 的"有记录无水位则跳过补拉"逻辑也对。但 persist 被 :4395 和 :4958 调用,报告没说明 :4958 那条路径是否也是开话题,细节未核。 |
| 毛病5/名字:拉话题只一页50条且未传 with_sender_name | 核实 | D/bot/context-weave.ts:111-118 list 参数只有 container_id_type/container_id/sort_type/page_size,无 with_sender_name,无翻页。LSDK 1.71.1 types 里确有 with_sender_name、only_thread_root_messages、sender_name、message_app_link、thread_message_position(已装版本 package.json 为 1.71.1,与报告一致)。"拉历史不返回名字"本身仍未实测。 |
| daemon 未订阅撤回/编辑事件,只订阅 message/cardAction/comment/botAdded/reaction | 核实 | D/bot/bridge.ts:114-118 五个 channel.on;grep recalled 只命中 card/managed.ts 注释。注意 bridge.ts:119 起还有对 SDK 私有 raw 事件的监听(bot 被移除、菜单),报告 1.5 说"只订阅"五类略不完整,但与撤回无关。 |
| Claude 后端不支持 steer,自动改排队 | 核实 | D/agent/claude-agent/thread.ts:534-538 supportsSteer=false,steer() 抛错并注明改为下一轮。 |
| B1:Codex thread/inject_items 注入的 user 项在线程历史投影中被丢掉(原生应用看不到) | 核实 | CX app-server-protocol/src/protocol/thread_history.rs:477-501 handle_response_item 对 user 消息仅当 parse_hook_prompt_message 成功才产出 HookPrompt,否则 return。common.rs:875-880 inject_items 存在,turn_processor.rs:990 先 load_thread。不过这只证明 app-server 的 thread/read 类投影,Codex.app 实际渲染路径未验(报告第9节第10项已列为待实测)。 |
| B2:Claude shouldQuery:false 追加后合进下一条 user 消息,落盘成普通 user 条目 | 核实 | sdk.d.ts(daemon/node_modules 0.3.296)6350-6352 文档字符串: appended without triggering a turn, merged into next user message that does query;2137-2139 注释称其持久化为 bare user entries。报告引用的是 0.3.296,可核。"原生 claude --resume 里看得见"仍是推断。 |
| C:Codex 0.162 turn/start 有 additionalContext(按 key 去重,分 untrusted/application),v2 的 0.156.1 生成协议没有 | 核实 | CX v2/turn.rs:104-119 AdditionalContextKind/Entry,:210 与 :326 additional_context;core/src/state/additional_context.rs:15-34 merge 按 key 去重并转成 ResponseItem。D/agent/codex-appserver/protocol/generated/v2/TurnStartParams.ts 中 grep additionalContext 为 0。"原生应用看不到"是对 ResponseItem 投影的推断,未验。 |
| 事件权限:im:message.group_msg 只推用户消息不含 bot;另有 include_bot 与 group_bot_msg:readonly | 核实 | 接收消息事件文档(fullPath=/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)列出 im:message.group_msg(不含机器人)、im:message.group_msg.include_bot:read、im:message.group_at_msg.include_bot:readonly、im:message.group_bot_msg:readonly。报告说 group_bot_msg 与 include_bot 区别"未知",诚实。 |
| 主区开新话题时开场只有触发消息;主区没有任何上文织入 | 没核实 | 只确认了 :1516 topicId=msg.threadId 导致主区 history 为空;:1820-1833 的开话题开场内容、以及"单会话群无补拉"未逐行核。 |
| lark-cli 拼出 /client/thread/open 链接、message_app_link 示例、cli issue #1031、官方推荐话题形式群、5.30 客户端最多显示5条回复 | 没核实 | 需要访问 github.com/larksuite/cli 与帮助中心页面,本次未取;报告自己也标了推断/要实测。 |

缺口：

- 全文最关键的产品假设"别的 bot 的最终回答能进记录块"没有可行性证据:当前事件订阅没有 include_bot 权限,bot 消息拉历史靠 card_msg_content_type,卡片正文能否稳定取到只在第9节第8项列为待测,方案 A 的多 bot 场景(7节时间线 #7/#8)依赖它。
- 方案 A(记录块)与 Codex 重启/resume 的交互没分析:记录块是用户消息的一部分,压缩后会被摘要掉(已提及),但 daemon 在 resume 失败重建会话(handle-message.ts:1626 的 recreated 路径)时水位如何重置没说清。
- 水位只存 lastSeenAt 时间戳,而飞书话题根消息创建时间是旧的、消息也可编辑/撤回;时间戳水位对乱序到达和 daemon 离线补拉的去重问题没有讨论(只有登记表一个补丁)。
- 并发与限流:每个主区回复前都要 list 主区加按话题 list,多 bot x 多群的 1000次/分、50次/秒配额没估算;第 3.6 节只抄了限额。
- 权限档 #admin/#guest 把主区拆成两条会话,话题引用行、水位、登记表是否按 key 分开存,5.4 没写数据结构的 key。
- 智能模式"合成一次判断"(7节 #1)两个 bot 合并成一次判断的前提是同机共享 daemon,跨机器/不同 daemon 的 bot 做不到,报告未交代。
- 撤回订阅的权限与事件可达性只引用了文档,没有说明 daemon 离线期间的撤回如何补(拉历史靠 deleted 字段,仅对未进会话的消息有效)。
- 报告声称 daemon 自 be17859 以来没改,依赖 git diff 空结果;行号已抽样核对(1031/1070/1091/1286/1516/1626/1637/4285 均对得上),但 1.9 第4条(插话不推进水位)我只确认了 :1637 位于开新轮路径,未追踪 steer/queue 路径是否另有 patchSession。
