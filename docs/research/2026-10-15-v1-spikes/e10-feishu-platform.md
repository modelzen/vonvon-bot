# e10：飞书平台的几种行为

`docs/v1-plan.md` 第 4 节的 e10，对应 product.md 第 9 节第 6、14、15、16 项和第 17 项后半。s09 之前要做完，s14、s18、s22、s27、s49、s57 也用它的结果。2026-10-15 北京时间 19:51 到 20:17 在 JP-VPS 上实测，用的是验收环境：detach 在旧 main 上的验收 worktree、它的数据目录和里面唯一的测试 bot（下文写 `<bot>`）。lark-cli 1.0.97。

## 结论先行

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 机器人能不能自己进一个已有的群 | **部分**：公开群能，私有群不能 | `PATCH /open-apis/im/v1/chats/:chat_id/members/me_join`。公开群返回 `code 0`，之后 `is_in_chat` 为 true；私有群返回 HTTP 400、`code 232008`，`chat is not public`。自己进群也会推 `im.chat.member.bot.added_v1`，操作人就是 bot 自己 |
| 2 | 拉历史带 `with_sender_name` 拿不拿得到名字 | **能**，真人和 bot 都有 | 带上以后，`sender` 多出 `sender_name` 和 `sender_i18n_names`；bot 还多一个 `open_bot_id`（`ou_` 开头）。不带就只有 id。系统消息没有发送者 |
| 3 | 能不能拉到别的 bot 卡片回答的正文 | **能**，要带 `card_msg_content_type` | 不带时，2.0 卡片（包括 CardKit 流式卡片）只返回标题和"请升级至最新版本客户端，以查看内容"，1.0 卡片能拿到正文。带 `user_card_content` 返回发送时的卡片 JSON，带 `raw_card_content` 返回 `json_card` 包装；别的 bot 发的卡片也一样能拿到。lark-cli 的 `+chat-messages-list` 已经返回 2.0 卡片正文 |
| 4 | 话题里引用某一条消息，分不分得出是哪条 | **能**（接口层面） | 在话题里回复话题里的某一条 T1：`parent_id` 是 T1，`root_id` 是话题根，`thread_id` 是话题。直接在话题里发的消息，`parent_id` 是话题根。事件和 `GET /im/v1/messages/:id` 一致 |
| 5 | 勾了"同时发送到群"收到几次事件 | 两次（2026-10-16 补测，见文末） | 回复接口只有 `reply_in_thread` 和 `uuid`，lark-cli 也发不出这种消息，由 Codex 在 owner 的客户端里发 |
| 6 | 私聊里的话题 | **能**，事件带 `thread_id` | 用户在和 bot 的私聊里用话题回复，事件 `chat_type=p2p`，带 `thread_id`、`root_id`、`parent_id`。bot 用 `reply_in_thread: true` 回私聊消息也成功，响应带 `thread_id`；用户在这个话题里回复，事件也带 `thread_id` |
| 7 | 机器人能不能给没开过会话的人发私聊 | **没测到** | owner 2026-10-15 已经私聊过这个测试 bot，测不干净。留给 owner 和一位同事 |
| 8 | daemon 断线期间的消息，重连后会不会补推 | **这次补推了，但不是 daemon 一重连就到**：在消息发出约 5 分 16 秒后才到，只有一个样本 | 断线时发的两条 @bot，daemon 重连后 3 分 18 秒内一条都没收到；停掉 daemon、换上自己的长连接后，在消息创建 316.0 秒和 317.2 秒后收到，事件头的 `create_time` 仍是原来的时间 |

## 怎么测的

- **应用身份调接口。** 探测脚本放在仓库外的临时目录，用 jiti 加载验收 worktree 里 daemon 自己的代码：`config/bots.ts` 取当前 bot，`config/paths.ts` 的 `useBotDir`，`config/store.ts` 的 `loadConfig`，`config/secret-resolver.ts` 的 `resolveAppSecret`。拿到 App Secret 后在进程里换 `tenant_access_token`，再用 `fetch` 调 OpenAPI。Secret 和 token 只留在内存里，所有输出先把 id 截短再打印。
- **真人身份发消息。** lark-cli `--as user`，也就是 owner。只用为这次实验新建的三个群和 M1 复验用的测试群，私聊只发给测试 bot。新建的群（群名不写进仓库，下文用占位）：
  - `<私有群>`：`im +chat-create --as user`，默认私有，不带 bot；
  - `<公开群>`：同上加 `--type public`；
  - `<两个 bot 的群>`：带 `<bot>` 和 lark-cli 自己的应用（下文写 `<另一个 bot>`，是另一个飞书应用）。
- **原始事件。** daemon 只在 intake 日志里记 `chatType`、`mentionedBot`、`threadId` 和前 40 个字，看不到 `parent_id`、`root_id` 和事件头。所以第 4、6、8 项另写了一个监听脚本：飞书 SDK 1.71.1 的 `WSClient` 加 `EventDispatcher`，用测试 bot 的凭据连长连接，把每个 `im.message.receive_v1` 的事件头和消息字段写成一行。它只在验收 daemon 停着的时候跑，免得两条长连接分走事件。测完 daemon 用 `daemon start --port 37037` 重新起好，留在运行状态。
- 第 1 项：建好两个不带 bot 的群后，应用身份依次调 `GET .../members/is_in_chat`、`PATCH .../members/me_join`、再查一次 `is_in_chat`。
- 第 2 项：在 M1 复验群里，应用身份调 `GET /open-apis/im/v1/messages`（`container_id_type=chat` 和 `thread`），带和不带 `with_sender_name=true` 各一次。
- 第 3 项：
  - `<另一个 bot>` 用 `im +messages-send --as bot` 在两个 bot 的群里发一张 2.0 卡片和一张 1.0 卡片，`<bot>` 用 `GET /im/v1/messages` 和 `GET /im/v1/messages/:id` 读；
  - `<bot>` 照 daemon 的做法发一张 CardKit 流式卡片（`POST /cardkit/v1/cards`，发卡片消息，`PUT .../elements/:id/content` 写最终正文，再关 `streaming_mode`），`<另一个 bot>` 用 `lark-cli api GET /open-apis/im/v1/messages/:id --as bot` 读；
  - 两边都比了不带参数、`user_card_content` 和 `raw_card_content`；
  - 另外读了 `<bot>` 自己在 M1 复验群里的最终回答卡片。
- 第 4 项：在两个 bot 的群里：
  - owner 发根消息 R（@bot）；
  - 用 `+messages-reply --reply-in-thread` 回 R，开出话题，这条是 T1；
  - 再回复 T1 两次，一次不带、一次带 `--reply-in-thread`；
  - 看事件，再用 `GET /im/v1/messages/:id` 核对。
- 第 6 项：owner 用 `+messages-send --as user --user-id <bot 的 open_id>` 私聊 bot，再：
  - 用 `--reply-in-thread` 回这条，开出话题；
  - 不带 `--reply-in-thread` 再回一次；
  - 另发一条，`<bot>` 用 `POST /im/v1/messages/:id/reply`（`reply_in_thread: true`）回它，owner 再回 bot 这条。
- 第 8 项：
  1. 19:59:23 `daemon stop`，19:59:32 停好；
  2. 19:59:40、19:59:41 owner 在 M1 复验群里发两条 @bot（叫它只回 ok）；
  3. 20:00:42 `daemon start`，20:01:03.8 日志记长连接 connected；
  4. 看 intake 日志到 20:04:08；
  5. 20:04:21 再停 daemon，20:04:29 起监听脚本，20:04:46 前就绪。

## 原始现象

id 都截短了；群名和人名用占位写。

**第 1 项**

```
私有群  is_in_chat=false  me_join → HTTP 400, code 232008,
        "Your request specifies a chat whose type is NOT supported currently, ext=chat is not public."
        之后 is_in_chat=false
公开群  is_in_chat=false  me_join → HTTP 200, code 0  之后 is_in_chat=true
daemon: {"phase":"intake","event":"bot-added-nonadmin","chatId":"…9fead1","op":"…e2b684"}
        op 的尾 6 位和 /bot/v3/info 里 bot 自己的 open_id 一样
```

- `is_in_chat` 在 bot 不在群里时也能调，返回 false，不报错。
- 私有群里 bot 不在群时，`GET /im/v1/chats/:id` 返回 `code 0`，但没有 `chat_type` 这类字段。
- 应用当时开通的相关权限有 `im:chat.members:bot_access`、`im:chat.members:write_only`、`im:chat:readonly`。`me_join` 靠哪一个没有单独试。

**第 2 项**（M1 复验群，`with_sender_name=true`）

```
user: {"id":"ou_71d2…","id_type":"open_id","sender_name":"<owner 名字甲>",
       "sender_i18n_names":{"zh_cn":"<owner 名字乙>"},"sender_type":"user",...}
bot:  {"id":"cli_aa5a…","id_type":"app_id","open_bot_id":"ou_aefd…",
       "sender_name":"<bot>","sender_i18n_names":{"en_us":"<bot>","zh_cn":"<bot>"},"sender_type":"app",...}
system: sender 全空
```

- 不带这个参数时，同一批消息的 sender 只有 `id`、`id_type`、`sender_type`、`tenant_key`。
- owner 的 `sender_name` 和 `sender_i18n_names.zh_cn` 是两个不同的名字。`sender_name` 和 `lark-cli auth status` 里 owner 的 `userName` 相同。
- 话题容器（`container_id_type=thread`）里同样带名字。
- `open_bot_id` 是从调用方应用看到的 open_id：`<bot>` 自己查到的是 `ou_aefd…`，lark-cli 的应用看到的同一个 bot 是 `ou_9721…`。owner 也一样：lark-cli 应用下是 `ou_6bb0…`，测试 bot 收到的私聊事件里是另一个 id（尾号 `…3c30ab`）。

**第 3 项**

```
<另一个 bot> 的 2.0 卡片，不带参数：
  {"title":"e10 另一个 bot 的回答（2.0）","elements":[[{"tag":"img",...},{"tag":"text","text":"请升级至最新版本客户端，以查看内容"},...]]}
同一张，card_msg_content_type=user_card_content：
  {"body":{"elements":[{"content":"E10-CARD2-BODY：这是另一个 bot 的最终回答正文，**加粗**一段。","tag":"markdown",...}]},
   "header":{...},"schema":"2.0",...}
<另一个 bot> 的 1.0 卡片，不带参数：
  {"title":"e10 另一个 bot 的回答（1.0）","elements":[[{"tag":"text","text":"E10-CARD1-BODY：1.0 卡片正文。"}]]}
<bot> 的 CardKit 流式卡片，<另一个 bot> 来读：
  不带参数：只有标题加"请升级至最新版本客户端"
  user_card_content：{"body":{"elements":[{"content":"E10-STREAM-FINAL：流式卡片的最终回答正文。",...}]},"config":{"streaming_mode":false,...},"schema":"2.0"}
  raw_card_content：{"json_card":"{\"body\":{...\"content\":\"E10-STREAM-FINAL：...\"...}}"}
```

- `<bot>` 自己在 M1 复验群里的最终回答卡片也一样：不带参数只剩"请升级…"，带 `user_card_content` 能拿到全部内容，包括折叠面板里的命令和输出。
- `lark-cli im +chat-messages-list --as bot` 的输出里，三张卡片的正文都在，没有"请升级"字样。

**第 4 项**（普通群里的话题，事件字段）

```
R    thread=-    root=-    parent=-     （发 R 时还没有话题；话题开出来后再查 R，已带 thread_id）
T1   thread=omt  root=R    parent=R     "话题第一条 T1"
Q    thread=omt  root=R    parent=T1    "话题里引用 T1 的 Q"
Q2   thread=omt  root=R    parent=T1    "话题里引用 T1 的 Q2（reply-in-thread）"
```

`GET /im/v1/messages/:id` 查 Q 和 T1，结果和事件一样。

**第 6 项**（私聊）

```
P    chat_type=p2p  thread=-    root=-   parent=-
PT1  chat_type=p2p  thread=omt  root=P   parent=P    用户 --reply-in-thread 开的私聊话题
PR   chat_type=p2p  thread=omt  root=P   parent=P    不带 --reply-in-thread，也进了同一个话题
bot 回 P2（reply_in_thread=true）：code 0，响应 thread_id=omt…，parent=root=P2
UT   chat_type=p2p  thread=omt  root=P2  parent=BT   用户在 bot 开的私聊话题里回复
```

PR 进话题和回复接口文档一致："如果要回复的消息已经是话题形式的消息，则默认以话题形式进行回复"。

**第 8 项**（北京时间）

```
19:59:40.2 / 19:59:41.2  两条 @bot 发出（消息 create_time）
20:01:03.8  daemon 长连接 connected
20:01:03 到 20:04:21  daemon 的 intake 日志没有这两条，也没有 duplicate 拒绝
20:04:46 前  监听脚本就绪
20:04:56.2  收到第 1 条：消息创建后 316.0 秒；事件头 create_time=19:59:40.6
20:04:58.4  收到第 2 条：消息创建后 317.2 秒；事件头 create_time=19:59:41.5
其余事件（第 4、6 项和后面重启后的 @bot）都在消息创建后 0.5 到 3 秒内到
```

## 对设计的影响

- **s57 和 product.md 3.7。** 3.7 写的是"机器人自己进不了已有的群"，测到的是公开群能自己进、私有群不能。改成"公开群 bot 自己进"是承诺变强，属于 v1-plan 4.2 的第 3 类，s57 开工前用【需要你决定】问 owner，不直接改。lark-cli 建的群默认私有；客户端里建群默认是不是私有没查，所以不知道已有的群里有多少还要人拉。owner 同意以后的做法：
  - 先调 `me_join`，返回 232008 时再回"拉 bot 进群的步骤"；
  - `me_join` 成功也会推 `bot.added`，操作人是 bot 自己。今天的代码把它当"非管理员拉的"，只记 `bot-added-nonadmin`，什么也不做（`handle-message.ts` 的 `onBotAddedToChat`）。s57 要把 bot 自己进群和别人拉它进群分开处理，绑定的流程不要靠这个事件触发；
  - 自己进群还要哪一个权限，s57 开工时用只开一个权限的应用试一次。
- **s09。** 拉历史带 `with_sender_name=true` 就能拿到真人和 bot 的名字，不用为换名字再申请 `contact:user.base:readonly`。
  - 真人的名字用 `sender_name`，它和 lark-cli 显示的名字一致；`sender_i18n_names.zh_cn` 可能是另一个名字；
  - bot 的 `open_bot_id` 能把消息列表里的 bot（`app_id`）和事件 `mentions` 里的 open_id 对上；
  - open_id 按应用区分，不能拿 lark-cli 看到的 id 去比 daemon 收到的 id。
- **s14 和 s27：别的 bot 的最终回答。** 拉历史和查引用都要带 `card_msg_content_type`：
  - 不带的话，2.0 卡片和 CardKit 流式卡片的正文拿不到；今天 daemon 的卡片就是这两种，所以别的 bot 的回答会变成一行"请升级至最新版本客户端"；
  - 两种取值都能拿到别的 bot 卡片的正文。`user_card_content` 是发送格式的 JSON，更好解析。`raw_card_content` 是 main 上 `bot/card-content.ts` 已经在用的 `json_card` 包装；
  - session-map 报告里"别的 bot 的最终回答能进记录块还没有可行性证据"那一条，现在有了。
- **s14 和 s22：话题里的引用。** session-map 报告和 product.md 3.5"今天的代码和这里不一样"第 4 条说话题里每条消息的 `parent_id` 都是话题第一条，这只对直接在话题里发的消息成立。在话题里回复某一条时，`parent_id` 是被回复的那条。所以：
  - 判断引用：`parent_id` 不等于 `root_id` 就是引用了话题里的某一条，按 `parent_id` 查是谁的消息。`parent_id` 等于 `root_id` 时，分不出是引用了话题第一条还是普通的话题消息，按普通消息处理；
  - 第 4 条的修法：只有 `parent_id` 不等于 `root_id` 时才放引用。
- **s49 和 product.md 3.5"私聊里的话题"。** 私聊里有话题，用户开的和 bot 开的事件里都带 `thread_id`，可以按 `thread_id` 单独成会话，和群里一样。bot 在私聊里也能用 `reply_in_thread` 开话题。
- **product.md 第 9 节第 17 项后半和 s09 的水位。** 这次断线期间的消息补推了，但晚了约 5 分钟，daemon 重连后 3 分多钟里一条都没收到。只有一个样本，补推到的时候连着的是监听脚本。
  - 补推的消息可能在 bot 已经按水位补拉过、甚至回复过以后才到，到的时候已经是几分钟前的消息。daemon 要把补推的消息和水位对一下：已经进过记录块或回复过的，按 message_id 跳过；
  - 去重今天在内存里（`RecentIdCache` 和 SDK 自带的去重），重启后就没了，所以要持久化，或者直接比水位；
  - 晚到很久的 @，要不要回、怎么说明晚了，s09 定。
- **s18（崩溃私聊）。** 第 7 项没测到，3.10 的崩溃通知仍按"推断能发"写。要注意 open_id 按应用区分：给主人发私聊要用测试 bot 这个应用下主人的 open_id，从主人发给 bot 的消息事件里取，或者用 `user_id`、`union_id` 发，不能用 lark-cli 应用下的 open_id。

## 没测到的

- **第 5 项"同时发送到群"，由 owner 在客户端发。** 在两个 bot 的群里，进一个话题，回复时勾"同时发送到群"并 @bot。Claude 在 owner 发之前先停 daemon、起监听脚本，数收到几个 `im.message.receive_v1`，看主区那份带不带 `thread_id`（还要看 session-map 报告里说的 `sync_to_chat_info`，监听脚本今天没记这个字段）。私聊里的"同时发送到会话"同样做一次。
- **第 7 项，由 owner 和一位同事看。** 要一个从没和测试 bot 说过话的人（v1-plan 第 8 节"一位同事或第二个飞书账号"）。Claude 用测试 bot 的应用身份按 open_id 给他发一条私聊，记接口返回码。owner 请同事在客户端里看收没收到、会话列表里怎么显示、有没有通知。
- **第 8 项只有一个样本。**
  - 补推的间隔和重试次数没有对照飞书文档；
  - 没测断线超过 5 分钟、第一次补推时还没连上会怎样；
  - 没测 daemon 自己能不能收到补推：这次 5 分钟时连着的是监听脚本，daemon 在那之前已经停了；
  - 补推事件的 `event_id` 和原来的是否相同没比，只看到事件头的 `create_time` 是原来的时间。
  - s09 开工时，用 daemon 自己的长连接再测一次断线 2 分钟和 10 分钟。
- **客户端里建群的默认类型、开了入群审批的公开群**：只看了 lark-cli 建群默认私有，客户端里建的群默认是什么没查；公开群开了"入群需群主或群管理员审批"时 `me_join` 会怎样也没测。s57 开工时补。
- **话题群（`chat_mode=topic`）里的引用**没测，这次只测了普通群里的话题。s22 要在话题群里补一次。
- 第 4 项是接口层面的结果：用 `+messages-reply` 回复话题里的某一条。客户端里在话题中"回复"某条消息，发出的是不是同一种消息，由 owner 在客户端里回一次，Claude 看 `parent_id`。
- 新建的三个群都留着。`<bot>` 已经加入公开群，`<另一个 bot>` 在两个 bot 的群里。

## 补测：第 5 项"同时发送到群"（2026-10-16）

#322 任务 10 里 Codex 用 owner 的飞书客户端发，JP-VPS 的验收 bot（按话题的 Codex 群）收，Claude 看 daemon 日志并用 owner 身份查消息。

- 在一个已有话题里回复某一条（不是第一条）：一个事件，带 `thread_id`，按话题消息处理。
- 在话题里回复时勾"同时发送到群"并 @bot：两个事件、两条消息，发送时间相同。
  - 话题里那条带 `thread_id`、`root_id`、`parent_id`，`sync_to_chat_info` 是 `{type: 2, related_message_id: 主区那条}`。
  - 主区那条不带 `thread_id`、`root_id`，`sync_to_chat_info` 是 `{type: 1, related_message_id: 话题里那条, thread_id: 原话题}`，消息列表里排在主区。
  - bot 两条都处理了：话题里回了；主区那条被当成新的 @ 去开话题，飞书回 500（code 2200 internal error）。
- 私聊话题里勾"同时发送到会话"：同样两个事件，一条在话题里，一条在私聊主界面。
- `sync_to_chat_info` 是单条查询消息接口返回的字段；飞书 SDK 的类型里没有，长连接事件里带不带没确认。后续见 `docs/v1-plan.md` 的 s14d。

