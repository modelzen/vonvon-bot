# 上下文：现有代码怎么算，原生 Codex 和 Claude Code 怎么算，v1 怎么做

调查日期 2026-10-14。只读，没有改任何仓库，没有跑构建和测试，没有发任何消息。lark-cli 只看了 `--help` 和本地技能文档。

## 证据缩写

| 缩写 | 位置 | 版本 |
|---|---|---|
| V2 | `/home/operator/vonvon/vonvon-bot/packages/daemon/src/` | main `be17859` |
| BR | `/home/operator/vonvon/feishu-codex-bridge/src/` | 0.6.14，`6698118` |
| CXG | `V2/agent/codex-appserver/protocol/generated/`，v2 自带的 app-server 协议类型 | 托管安装钉在 0.156.1（`codex-install-lock.json`） |
| CXR | `/home/operator/vonvon/references/openai-codex/codex-rs/` | main `97771b1d`，2026-10-14。比 0.156.1 新 |
| SDK | `/home/operator/vonvon/vonvon-bot/packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` | 0.3.296（实装版本；`docs/providers.md:483` 写的是钉 0.3.246） |
| CC | code.claude.com/docs，2026-10-14 抓取 | 文档未写版本 |
| FS | 飞书开放平台文档，本地副本在 `scratchpad/fsdocs/` | 抓取日未记录 |

bridge 和 v2 在上下文这块是同一份代码。`context-weave.ts` 两边逐字节相同（`diff` 为空）。`session-store.ts` 只差一个 `detached` 字段。下面只写 V2 行号，BR 的对应行能找到时附上。

## 结论

1. 现在一个飞书话题（多会话群）或一个群（单会话群）对应一条原生会话。映射存在 `bots/<appId>/sessions.json`，键是话题 thread_id 或群 chat_id。重启后下一条消息用存的 id 去 resume。
2. 现在的上下文是"触发时拉取"。只有话题里才补拉没触发的消息，最多 20 条，每条 280 字。单会话群里没触发的消息永远进不了会话。
3. 人名基本没进 prompt。触发人只写 open_id，名字恒为"某用户"。话题上文里的人写成"用户+open_id 尾 4 位"。原因是 SDK 没给名字，飞书拉历史的接口也不返回名字。
4. bot 的消息全部被过滤。一是没申请收 bot 消息的权限，二是拉上文时只留 `sender_type=user`。所以 bot B 看不到 bot A。
5. 原生两家都能做到"一条飞书对话 = 一条原生会话"。推断用户也能在 Codex 或 Claude 里打开它，待 Mac 实测：Codex 线程默认算交互来源，会出现在默认列表里；Claude 会话存在 `~/.claude/projects/`，`claude --resume <id>` 能接上。
6. 两家都没有"发言人"字段。多人发言只能写进文本。两家都有"只加历史、不开回合"的接口：Codex `thread/inject_items`，Claude `shouldQuery: false`。但 Codex 注入的内容在 `thread/read` 里不显示，Codex 应用里看不到。
7. 压缩两家都是原生的，自动加手动。v2 的"关闭自动压缩"开关只接了 Codex。按 Codex main 的代码，这个开关的做法（把阈值设成 10 亿）会被 90% 窗口封顶，关不掉（推断，0.156.1 未知）。
8. 子 agent 两家都是原生的。各自有独立上下文，父会话只拿到最终结果。v2 今天把 Codex 子线程的事件全部丢掉，Claude 子 agent 的步骤混在主过程里。V6c 已经计划在运行卡里加"子 agent 区"。
9. 推荐 v1：保持一条飞书对话对一条原生会话；触发时按水位拉增量，统一成带名字的对话记录块；不做持续注入；agent 需要更早的历史时自己用 lark-cli 查；子 agent 只显示在父运行卡里，不另开话题；压缩全用原生，默认开，加 `/compact`，去掉关闭开关。细节和备选见第 3 节。

## 1. 现在的代码

### 1.1 两种群

- 群有 `kind` 字段。`multi`（默认）是一个话题一条会话，键是话题 thread_id。`single` 是整群一条会话，键是 chat_id（`V2/project/registry.ts:23-25`；`V2/bot/handle-message.ts:544-548`）。
- 建群时不设话题模式，是普通群（`V2/project/lifecycle.ts:148-151`）。多会话群的话题由 `reply_in_thread` 回复第一条 @ 消息产生（`handle-message.ts:538`）。
- 多会话群：主区 @ bot 就新开话题并起一条新会话（`handle-message.ts:1781` 起）。话题里的消息是这条会话的一轮（`:1070-1115`）。主区普通闲聊仍要 @ 才响应（`:1197-1205`）。
- 单会话群：整群一条会话，回复用引用而不是话题，同一时刻只跑一轮（`:1019-1065`）。
- 免 @ 默认开。只有"加入的已有群 + 单会话"默认关（`registry.ts:83-85`）。消息 @ 了全体或 @ 了别的人（包括别的 bot），即使开了免 @ 也不接（`handle-message.ts:1199`）。
- 管理员和普通成员档位不同时，同一个话题会拆成两条原生会话，键加 `#admin` 或 `#guest`（`registry.ts:107-126`；`handle-message.ts:1246-1253`）。这破坏了"一条飞书对话一条原生会话"。
- 推断：单会话群里如果有人在某条消息下开了飞书话题，这条话题消息仍进整群那条会话（键用 chat_id），而且会触发拉话题上文（`:1516` 的 `topicId` 取 `msg.threadId`）。

### 1.2 私聊

- 私聊不跑 agent，只弹管理菜单卡。非管理员收到"仅管理员可在私聊里管理项目"（`V2/bot/dm-console.ts:9-22`；`handle-message.ts:953-966`）。
- 私聊还承接本机 CLI 桥的回复：用户回复任务完成卡时，文本喂回本机 agent，抢在菜单前处理（`handle-message.ts:954-963`）。

### 1.3 映射和存储

- 一条记录 = 一个话题（或一个群）绑一个后端会话 id。字段有 `threadId`（键）、`chatId`、`cwd`、`sessionId`（Codex thread id 或 Claude session UUID）、`backend`、`model`、`effort`、`lastSeenAt`（`V2/bot/session-store.ts:42-73`）。
- 文件是每个 bot 一份 `sessions.json`（`V2/config/paths.ts:41-46`、`:61-63`）。
- 新会话：先起原生线程，再写记录，`lastSeenAt` 设为触发消息的时间（`handle-message.ts:1554-1581`）。
- 话题的 thread_id 要在回复发出后再查，查不到就留在 `pending:` 键下（`handle-message.ts:4380-4398`）。
- Codex 每条会话一个 app-server 进程（`V2/agent/codex-appserver/backend.ts:668-694`；`handle-message.ts:2153-2154` 的注释）。Claude 每条会话一个常驻的流式输入 `query()`，会话 id 由我们自己指定（`V2/agent/claude-agent/thread.ts:219-233`）。

### 1.4 重启后恢复

- 内存里的线程没了。下一条消息先查 `sessions.json`，再调后端的 resume（Codex `thread/resume`，`backend.ts:682-694`）（`handle-message.ts:1697-1729`）。
- resume 失败就起一条新线程，把记录指向新 id，并标记 `recreated`（`:1735-1752`）。话题会话在这种情况下重新织入最近 20 条话题消息当开场（`:1617-1634`）。单会话群没有这一步，历史就丢了（推断，来自同一段代码只对 `topicId` 生效）。
- 项目目录改了也当作重建（`:1718`）。
- `/context` 用的用量只在内存里（`:853-855`），重启后显示 0，直到下一轮出用量（`:1981-1986`）。

### 1.5 触发时织入什么

每条触发消息在 `ingestContextImpl` 里依次加这些块，都加在用户原文前面（`handle-message.ts:1272-1295`）：

1. 语音转写（音频消息）。
2. 附件的本地路径清单（`weaveFileManifest`）。
3. 引用的那条消息：按 id 用 `im.v1.message.get` 拉回，压成一行，最多 800 字（`V2/bot/context-weave.ts:36`、`:77-92`、`:401-411`）。
4. 发信人：`[本条消息的发信人：名字（open_id：ou_xxx）]`（`context-weave.ts:445-451`）。

另外在开轮时织入话题上文（`handle-message.ts:1516-1524`、`:1626-1634`）：

- 只在消息属于某个飞书话题时做。
- 新会话或重建：拉话题最近的消息，最多 20 条。
- 已有会话：只要比 `lastSeenAt` 新的消息。
- 拉一页 50 条（飞书上限），按时间倒序，过滤后保留最近 20 条，每条压成一行 280 字（`context-weave.ts:38-45`、`:103-141`）。
- 过滤掉 bot 和应用的消息、系统消息、空消息和触发消息本身（`:120-129`）。
- 格式是一个块：`[话题中在此之前已有的消息（按时间先后排列，供你理解上下文）：\n张三：……\n]`（`:417-429`）。
- 每轮结束前把 `lastSeenAt` 推到本条消息的时间（`handle-message.ts:1637`）。
- `/goal` 不织话题上文（`:1621-1625` 的注释）。
- 所有拉取都是尽力而为，失败只记日志（`context-weave.ts:88-91`、`:137-140`）。

运行中又来的消息：有 steer 就塞进当前回合，没有就排队成下一轮（`handle-message.ts:1322-1361`、`:1366-1402`）。排队和 steer 的消息也走同一个 `ingestContext`，带发信人块。

### 1.6 没触发的消息

- 没 @ 且不满足免 @ 的消息，在 @ 门直接丢掉（`handle-message.ts:976`）。
- 多会话群：这些消息还留在飞书里，下一次有人在同一话题触发时，按水位补拉进来（见 1.5）。超过一页 50 条或过滤后超过 20 条的，更早的就丢了（`context-weave.ts:130-135` 只记日志）。
- 单会话群：没有补拉。免 @ 关着时（加入的已有群默认关），没 @ 的消息永远不进会话。
- 主区的消息不会被拉进任何话题会话。

### 1.7 人名怎么进 prompt

- 触发人：发信人块用 `msg.senderName`（`context-weave.ts:445-451`）。SDK 只在调用方传了 `resolveSenderName` 时才填这个名字（`/home/operator/vonvon/vonvon-bot/node_modules/@larksuiteoapi/node-sdk/lib/index.js:99137`）。v2 建通道时没传（`V2/bot/bridge.ts:59-81`）。所以名字恒为"某用户"，只有 open_id 是真的。
- 话题上文：飞书 `message.list` 的 `sender` 只有 id、id_type、sender_type、tenant_key，没有名字（FS `server-docs_im-v1_message_list.md:61-66`）。代码回退成 `用户<open_id 尾 4 位>`（`context-weave.ts:159-160`）。
- 正文里的 @ 会被换成名字，因为 `mentions` 带名字（`context-weave.ts:355-363`）。
- 结论：今天 agent 分得清"是不是同一个人"，但不知道是谁。

### 1.8 bot 消息

- 收事件：v2 申请的是 `im:message.group_at_msg:readonly` 和 `im:message.group_msg`（`V2/config/scopes.ts:23-24`）。飞书说这两个都不含机器人发的消息；要收别的 bot 的消息得申请 `im:message.group_at_msg.include_bot:readonly` 或 `im:message.group_msg.include_bot:read`（FS 接收消息事件，https://open.feishu.cn/document/server-docs/im-v1/message/events/receive ，本地副本 `:12-22`）。
- 拉上文：只留 `sender_type === 'user'`（`context-weave.ts:125`、`:165`）。
- 卡片正文：bot 的回复是 CardKit 2.0 卡片。`message.get` 只回卡片标题，正文被换成"请升级至最新版本客户端"（`context-weave.ts:277-310`）。要拿正文得带 `card_msg_content_type=raw_card_content` 再查一次，v2 已有这个函数，但只用于收到的交互卡（`V2/bot/card-content.ts:15-21`、`:32-45`）。
- 推断：没申请 include_bot 权限，所以今天两个 bot 在同一群里不会互相触发，也不会成环（另见 `scratchpad/v1/v2-fit.md:70-71`）。

### 1.9 命令和 autoCompact

- 命令只认 `/resume /model /settings /help /compact /context /clear`（`handle-message.ts:1176-1188`），另有 `/goal`。
- `/compact`：只能在会话空闲时用。Codex 调 `thread/compact/start`，然后一直读到回合结束（`backend.ts:468-512`）。Claude 把 `/compact` 当提示词发，看 `compact_boundary`（`V2/agent/claude-agent/thread.ts:543-585`）。卡片显示"压缩中"，结束时改成"旧% → 新%"（`handle-message.ts:2004-2108`）。压缩期间进来的消息不进会话，会提示重发（`:2101-2106`）。
- `/context`：显示最近一次的用量，来源是 Codex `thread/tokenUsage/updated` 的 `last.totalTokens`（`V2/agent/codex-appserver/event-map.ts:50-60`）或 Claude 的 `getContextUsage()`（`thread.ts:376`、`:495`）。
- `/clear`：只在单会话群，只限管理员。停泊旧会话，换一条新原生会话，旧的可 `/resume`（`handle-message.ts:2110-2190`）。多会话群里提示"开新话题"（`:1080-1088`）。
- `/resume`：列出这个目录下的原生会话（包括用户自己在 CLI 里开的），选中后在新话题里贴一张历史卡并绑定（`:3734`、`:3812-3840`）。单会话群是原地换绑（`:3744-3800`）。
- autoCompact：每个群一个开关，默认开（`registry.ts:51-55`；群设置卡 `V2/card/dm-cards.ts:1392-1407`）。关的时候把 Codex 的 `model_auto_compact_token_limit` 设成 10 亿（`backend.ts:55-71`）。Claude 后端没有用这个字段（`grep autoCompact V2/agent/claude-agent` 无结果）。
- 运行卡上自动压缩会出一行"上下文已自动压缩"（`V2/card/context-gauge.ts:127-130`）。

### 1.10 子 agent 现状

- Codex：回合事件按 `threadId` 和 `turnId` 过滤，子线程的通知全部丢掉（`backend.ts:333-337`；BR `agent/codex-appserver/backend.ts:335`）。`collabAgentToolCall` 项也没有映射（`event-map.ts` 里没有 collab）。用户在卡上看不到子 agent。
- Claude：子 agent 的工具调用和主线一样显示成工具行，`Task` 显示为"子任务：描述"（`V2/agent/claude-agent/event-map.ts:92-123`、`:258-259`）。`parent_tool_use_id` 只用来区分出错（`:99`）。推断：子 agent 的流式文字也可能混进主回答，因为 `stream_event` 没看 `parent_tool_use_id`（`:89-90`）。
- 用户要求过子 agent 可见。bridge 用户说"开 5 个子进程，结果一个完成会话就结束了"（`scratchpad/results/bridge.report.md:177`）。

### 1.11 看到的问题（都没在真实环境验证）

- 名字没进 prompt（1.7）。
- 单会话群没有补拉（1.6）。
- 未知：按飞书文档，应用身份调 `message.list` 要先有 `im:message`、`im:message:readonly` 或 `im:message.history:readonly` 之一，群聊还要 `im:message.group_msg`（FS `server-docs_im-v1_message_list.md:18`）。v2 的必需权限里没有前三个（`scopes.ts:18-38`）。拉取失败只记日志，所以话题上文可能一直是空的。要在 Mac 上看日志里有没有 `thread-context-failed`。
- 话题拉取不支持时间范围（FS `message_list.md:32-33`），只拉一页，活跃话题里两轮之间超过 50 条就会丢。
- 推断：autoCompact 关闭在新版 Codex 上无效（见 2.1）。

## 2. 原生能力

### 2.1 Codex app-server

**线程模型**

- 线程是持久会话。`Thread` 有 `id`、`sessionId`（同一棵会话树共享）、`forkedFromId`、`ephemeral`、`cwd`、`source`、`agentNickname` 等（CXG `v2/Thread.ts`）。
- 方法：`thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/read`、`thread/compact/start`、`thread/inject_items`、`thread/rollback`，回合是 `turn/start`、`turn/steer`、`turn/interrupt`（CXG `ClientRequest.ts:83`）。
- `thread/fork` 可以按 thread_id 分叉，并能覆盖 model、cwd、sandbox、developerInstructions、ephemeral（CXG `v2/ThreadForkParams.ts`）。CXR 的文档说还能从更早的回合分叉（CXR `app-server/README.md:387`）。
- `thread/rollback` 在 0.156.1 有，只删对话不回滚文件（CXG `v2/ThreadRollbackParams.ts`）。CXR main 已删掉，改用 `thread/revert`（CXR `app-server/README.md:449-458`）。

**不开回合加内容**

- `thread/inject_items`："把原始 Responses API 项追加到线程历史，不开用户回合"（CXR `app-server-protocol/src/protocol/common.rs:888-893`；CXG `v2/ThreadInjectItemsParams.ts`）。
- 实现会落盘（`checkpoint_preparation`）（CXR `core/src/codex_thread.rs:829-834`）。
- 要求线程已加载（CXR `app-server/src/request_processors/turn_processor.rs:999`）。
- 注入的 user 消息不进 `thread/read` 的投影，只有 hook 提示会显示（CXR `app-server-protocol/src/protocol/thread_history.rs:478-501`）。推断：Codex 应用和 VS Code 插件里看不到这些内容，模型却看得到。

**一轮里放多人的话**

- `turn/start` 的 `input` 是 `UserInput[]`。文本项只有 `text` 和 UI 用的 `text_elements`，没有发言人字段（CXG `v2/UserInput.ts`；`v2/TurnStartParams.ts`）。
- 所以多人只能写进文本，或者拆成多个文本项。

**压缩**

- 手动：`thread/compact/start`，参数只有 `threadId`，不能带说明（CXG `v2/ThreadCompactStartParams.ts`）。
- 通知：`contextCompaction` 项；`thread/compacted` 已标为弃用（CXG `v2/ThreadItem.ts:101`；`v2/ContextCompactedNotification.ts`）。
- 自动：配置项 `model_auto_compact_token_limit`（CXR `core/src/config/mod.rs:653-658`）。CXR main 里还有回合结束压缩和后台压缩的百分比（`:660-665`）。
- CXR main 里，配置的阈值会写进模型信息（CXR `models-manager/src/model_info.rs:29-31`），再和"窗口的 90%"取小（CXR `protocol/src/openai_models.rs:529-540`）。推断：v2 设 10 亿来关自动压缩，在这个版本上会变成 90% 窗口，等于没关。0.156.1 是否一样未知；v2 的注释写的是旧顺序"配置 → 模型默认 → i64::MAX"（`backend.ts:55-60`）。

**上下文用量**

- `thread/tokenUsage/updated` 带 `threadId`、`turnId`、`last`、`total`、`modelContextWindow`（可为 null）（CXG `v2/ThreadTokenUsageUpdatedNotification.ts`；`v2/ThreadTokenUsage.ts`）。v2 用 `last.totalTokens` 当"现在多满"（`event-map.ts:50-60`）。

**在 Codex 应用里打开**

- app-server 默认 `--session-source vscode`（CXR `app-server/src/main.rs:50-55`）。`thread/list` 不传来源时只列交互来源，交互来源包括 Cli 和 VSCode（CXR `rollout/src/lib.rs:88-94`；`app-server/src/filters.rs:1-30`；`app-server-protocol/src/protocol/v2/thread.rs:1425-1428`）。
- v2 用默认的 `~/.codex`（`V2/agent/codex-appserver/usage.ts:55`），没换 CODEX_HOME。
- 推断：bot 开的线程会出现在用户 Codex 应用的历史里。子线程来源是 SubAgent，默认列表不含它。

### 2.2 Claude Code（Agent SDK）

**会话**

- `resume`、`sessionId`、`continue`、`forkSession`、`persistSession`（SDK `:2092`、`:2098`、`:1599`、`:1714`、`:1822`）；`resumeSessionAt` 可从某条消息处分叉（`:2106`）。
- 会话存在 `~/.claude/projects/<编码后的 cwd>/<id>.jsonl`。可以从任何目录 resume，但只限同一台机器（CC https://code.claude.com/docs/en/agent-sdk/sessions ）。
- v2 的正式会话用默认持久化；标题和工具用的一次性查询才设 `persistSession: false`（`V2/agent/claude-agent/backend.ts:254`、`:334`）。推断：用户在终端 `claude --resume <id>` 能接上 bot 的会话。

**不开回合加内容**

- `SDKUserMessage.shouldQuery: false`：追加到记录，不触发助手回合，合并进下一条要查询的用户消息（SDK `:6311`、`:6352-6355`）。这类追加会落盘成普通 user 条目（SDK `:2137-2139`）。推断：`claude --resume` 里能看到。
- 用户消息也没有发言人字段，内容是 Messages API 的 `MessageParam`（SDK `:6311-6320`）。

**压缩**

- 自动压缩在窗口快满时触发，事件是 `compact_boundary`（CC https://code.claude.com/docs/en/agent-sdk/agent-loop ）。字段有 `trigger: manual|auto`、`pre_tokens`、`post_tokens`（SDK `:3776-3784`）。
- 手动：把 `/compact` 当提示词发（同上）。
- 可以关：设置项 `autoCompactEnabled`、`autoCompactWindow`（SDK `:9320`、`:9084`，属于 `Settings`，`:6767`），经 `Options.settings` 传入（`:2231`）。
- 压缩会丢早期的指令。官方建议长期规则写进 CLAUDE.md，它每次请求都会重新带上（CC agent-loop）。

**上下文用量**

- `getContextUsage()` 返回分项用量，含 `isAutoCompactEnabled` 和 `autoCompactThreshold`（SDK `:3055-3058`、`:4054-4055`）。

### 2.3 对照

| 需要的能力 | Codex | Claude |
|---|---|---|
| 一条飞书对话对一条原生会话 | 有，thread id | 有，session id，可自定 |
| 重启后接上 | `thread/resume` | `resume` |
| 分出新会话 | `thread/fork` | `forkSession`、`resumeSessionAt` |
| 不开回合加历史 | `thread/inject_items`，应用里看不到 | `shouldQuery: false`，下一条一起发 |
| 发言人字段 | 没有 | 没有 |
| 手动压缩 | `thread/compact/start`，不带说明 | `/compact` 提示词 |
| 自动压缩开关 | 配置阈值；新版被 90% 封顶（推断） | `autoCompactEnabled` |
| 用量 | `thread/tokenUsage/updated` | `getContextUsage()`、result usage |
| 用户在原生应用里打开 | 推断能，默认来源 vscode | 推断能，`claude --resume` |

## 2b. 子 agent

### Codex

- 父线程用协作工具：`spawnAgent`、`sendInput`、`resumeAgent`、`wait`、`closeAgent`（CXG `v2/CollabAgentTool.ts`）。客户端收到的是父线程上的 `collabAgentToolCall` 项，带 `senderThreadId`、`receiverThreadIds`、`prompt`、`model`、`reasoningEffort`、`agentsStates`（CXG `v2/ThreadItem.ts:64-101`）。子 agent 状态有 pendingInit、running、interrupted、completed、errored、shutdown、notFound（CXG `v2/CollabAgentStatus.ts`）。
- 每个子 agent 是一条独立线程，来源是 `thread_spawn{parent_thread_id, depth, agent_path, agent_nickname, agent_role}`（CXG `SubAgentSource.ts`）。子线程的 `item/*` 通知带自己的 `threadId`，Orca 和 Paseo 就是这样拿到子 agent 进度的（`/home/operator/vonvon/vonvon-bot/docs/native-capabilities.md:149-151`）。
- 停止：没有专门方法。对子线程的回合发 `turn/interrupt`，或由父线程 `closeAgent`（`native-capabilities.md:150`）。
- 上下文：旧版工具 `spawn_agent` 的 `fork_context` 默认不分叉，子 agent 只拿到首条任务（CXR `core/src/tools/handlers/multi_agents_spec.rs:627-632`）。新版 `multi_agent_v2` 的 `fork_turns` 默认 `all`，继承父线程全部历史（`:665-669`）。CXR main 里 `multi_agent` 是稳定且默认开，`multi_agent_v2` 默认关（CXR `features/src/lib.rs:1471-1482`）。0.156.1 的默认未知。
- 上限：默认最多 6 个线程，深度 1（CXR `core/src/config/mod.rs:255`、`:265`）。
- 推断：子线程有自己的 `thread/tokenUsage/updated`，不占父线程的窗口；父线程只多了子 agent 的最终结果。

### Claude Code

- 父 agent 用 `Agent` 工具（旧名 `Task`）。子 agent 产生的消息带 `parent_tool_use_id`，新 SDK 还带 `agent_id`，等于任务事件的 `task_id`（CC https://code.claude.com/docs/en/agent-sdk/subagents ）。
- 任务事件：`task_started`（`description`、`subagent_type`、`is_backgrounded`、`spawn_depth`、`parent_task_id`、`prompt`）、`task_progress`（`usage`、`last_tool_name`、`summary`）、`task_updated`、`task_notification`（`completed|failed|stopped`、`summary`、`usage`）（SDK `:6056-6170`）。
- 一行状态：`agentProgressSummaries` 开了以后，`task_progress.summary` 给一句现在在做什么（SDK `:2078-2087`）。
- 停止单个：`stopTask(taskId)`（SDK `:3235-3238`）。客户端声明 `perTaskStopAffordance` 后，中断主回合不会杀掉后台子 agent；不声明时会一起杀（SDK `:1796-1813`）。
- 后台：文档说子 agent 默认在后台跑，结果在之后的回合以完成通知送给 Claude（CC https://code.claude.com/docs/en/sub-agents ；agent-sdk/subagents）。推断：主回合可能先结束，子 agent 还在跑，之后 Claude 自己再起一轮。
- 上下文：子 agent 从空白开始，只拿到 Agent 工具里的提示词，加自己的系统提示和 CLAUDE.md；看不到父会话历史。fork 例外，它继承全部对话（CC sub-agents；agent-sdk/subagents）。父会话只拿到最终报告（同上）。
- 子 agent 有自己的窗口，满了自己压缩；记录单独存在 `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`（CC sub-agents）。
- 上限：嵌套默认 3 层，同时 20 个（CC agent-sdk/subagents）。

### v2 已有和已计划

- 合同里已有子 agent 车道、`SubagentState` 和 `subagent` 事件（`docs/providers.md:71-73`、`:100-111`、`:138`），以及 `stopSubagent`（`:310`）。`SubagentLedger` 已合入：每次运行最多 64 个，每个留最近 5 步、200 步历史、600 字结果（`V2/provider/runtime/subagent-ledger.ts:1-7`）。
- Codex 引擎计划：子线程就是子 agent，子线程的 `item/*` 是子 agent 步骤，停止发 `turn/interrupt`（`providers.md:479`）。
- Claude 引擎计划：`task_*` 只在 `local_agent` 或有 `subagent_type` 时进名单，带 `parent_tool_use_id` 的是子 agent 步骤，停止用 `stopTask`（`providers.md:483`）。
- 运行卡第 6 区"子 agent"：最多 6 行运行中、3 行已完成，再写"另有 N 个已完成"；每行有状态、任务、步数、用时、当前步骤；面板里是最近 5 步和结果；有"查看完整过程"和"停止"按钮（`providers.md:775`、`:783`；`docs/plan.md:1467-1504`）。
- 冲突：`providers.md:617` 说"后台子 agent 随运行结束"。这和 Claude 子 agent 默认后台跑、在主回合之后才完成相矛盾。需要定。

## 3. v1 方案

### 3.1 原则

1. 一条飞书对话对一条原生会话，每个 bot 各一条。用户能在 Codex 或 Claude 里打开它，看到的内容和 bot 一样。
2. 飞书是原文的唯一来源。原生会话里只放触发时 bot 真正读到的东西。
3. 不模拟原生能力。压缩、子 agent、分叉都用原生的。

### 3.2 会话单位

建议把"群类型"换成"每个对话容器一条会话"：

| 容器 | 会话 | 键 |
|---|---|---|
| 飞书话题 | 每个 bot 一条 | bot + thread_id |
| 群主区，设为"连续" | 每个 bot 一条 | bot + chat_id |
| 群主区，设为"开话题" | 主区不留会话，@ 就开话题 | 无 |
| 私聊（如果做） | 每个 bot 每个人一条 | bot + p2p chat_id |

- 这样旧的两种群就是主区的两种设置。话题群（飞书 `chat_mode=topic`）天然全是话题。
- "群里的消息再生成一个单独的会话"：连续主区里有人开飞书话题，就是一条新会话。两种开场：
  - A（推荐默认）：新会话，开场带话题根消息和主区最近若干条。干净，便宜。
  - B：从主区会话分叉（Codex `thread/fork`，Claude `forkSession`）。上下文完整，但把整段主区历史复制过去，费 token；Codex 应用里会显示 `forkedFromId`。可以做成话题里的 `/fork` 命令。
- 管理员和访客分档：现在一个话题拆两条会话（1.1）。建议 v1 改成一条会话、按群定一个档位，访客不能改档位。否则"在原生应用里打开"会看到两条。
- 私聊：做的话是最简单的情况，一个人，不用署名。代价是管理菜单要搬到 bot 菜单或 `/menu`，私聊没有项目目录，要用 bot 的主工作区。CLI 桥的回复按 `parentId` 先匹配，不受影响（`handle-message.ts:954-963`）。

### 3.3 多人署名

- 两家都没有发言人字段（2.1、2.2），只能写进文本。
- 建议把今天的三个块（发信人、引用、话题上文）合成一个对话记录块，按时间排，最后一行是触发消息：

```
[飞书群「支付组」· 话题「接口报 500」 · 你是 bot「小V」]
10:31 张三：订单接口报 500
10:32 李四 → @王五：看下日志
10:33 张三（ou_…a1b2）→ @小V：帮忙查一下
[/飞书]
```

- 名字要真名。触发人用 SDK 的 `resolveSenderName`，上文用群成员列表或通讯录换名字，按 open_id 缓存。需要的权限未知，要查（候选：`im:chat.members:read` 或 `contact:user.base:readonly`）。查不到再退回 open_id 尾号。
- 只给触发人写 open_id，方便 agent @ 回去。其他人只写名字，省 token。
- 继续用今天的单一清洗边界：每条压成一行，防止伪造块（`context-weave.ts:375-384`）。
- Codex 可以把记录块和触发消息拆成两个 `UserInput` 文本项；Claude 拆成两个 content block。推断：原生应用里显示成同一条用户消息的两段。

### 3.4 没 @ bot 的消息

三种做法：

| 做法 | 怎么做 | 好处 | 坏处 |
|---|---|---|---|
| A 触发时拉增量（推荐） | 触发时按水位从飞书拉"上次之后的消息"，织进这一轮 | 平时不花 token、不占进程；Mac 睡眠后也能补；原生会话只含 bot 读过的 | 要分页；话题拉取不支持时间范围（FS `message_list.md:32-33`）；有上限，要截断 |
| B 持续注入 | 每条消息到达就注入原生会话（Codex `inject_items`，Claude `shouldQuery:false`） | 原生会话始终最新 | 每个活跃群都要常驻进程；Codex 应用里看不到注入的内容（2.1）；Claude 反正合并到下一条一起发，收益小；闲聊越多压缩越频繁；daemon 离线时还是要拉 |
| C 本地缓存 + 拉 | daemon 记下收到的每条群消息，触发时从缓存取增量，缺口再拉飞书 | 不受飞书分页限制，拿得到名字 | 本机存一份群聊天记录，要定保留期和隐私说明；daemon 离线时仍有缺口（离线期间事件是否补推未知） |

推荐 A，并补三点：

1. 单会话群也补拉（主区用 `container_id_type=chat` 加 `start_time`，FS `message_list.md:30-33`）。
2. 按 token 预算截断，不按条数。超出时最后加一行"更早还有 N 条，可以用 lark-cli 查"。
3. 给 agent 读历史的能力：在提示里写明 chat_id 和 thread_id，让它需要时自己调 `lark-cli im +chat-messages-list`、`+threads-messages-list`、`+messages-search`，这三个在 lark-cli 1.0.97 里都标为 read（`lark-cli im +chat-messages-list --help`）。bot 身份不能用 `--user-id` 查私聊（`lark-cli skills read lark-im/references/lark-im-chat-messages-list.md:47`）。风险：同一个 lark-cli 也能发消息，靠技能说明约束不了，推断需要只读的包装或单独的只读凭据。

三种回复模式下 A 怎么用：

- 仅 @ 时回复：每次 @ 是一轮。增量 = 上次之后的全部消息 + 这条 @。
- 全部回复：每条消息都是一轮，增量通常为空。回合在跑时，后来的消息 steer 进去或排队；几个人同时说话，排队的几条合成下一轮，按 3.3 署名。
- 智能回复：小模型逐条判断。判为"不回"的消息不进原生会话，下一次触发时作为增量带进去，和仅 @ 一样。判断模型自己要看最近几条，这几条直接从飞书拉或从内存取，不经过原生会话，所以不污染会话（推断：判断用 `oneShot`，`providers.md:164-165`）。

### 3.5 一个群里几个 bot

- 每个 bot 自己一条原生会话（主人已认可）。
- bot B 看不看得到 bot A 的回复：

| 做法 | 说明 | 取舍 |
|---|---|---|
| 1 看最终回答（推荐） | B 的增量里包含 A 的最终回答，标成 `bot·A`，截到几百字，不含 A 的过程和工具步骤 | 能做"A 写、B 审"；要拿卡片正文（`raw_card_content`，`card-content.ts:15-45`），或同机时 daemon 内部直接拿 A 的回答；拉历史时 bot 消息是否返回、要不要 include_bot 权限未知 |
| 2 完全看不到 | 今天的行为 | 最简单，不会互相影响；但用户说"让 B 看看 A 的方案"时 B 不知道 |
| 3 共享一条会话 | 多个 bot 写同一条原生会话 | 违背"每个 bot 自己的会话"，原生应用里也说不清是谁，不推荐 |

- 不论哪种，B 不因为 A 的消息自动触发，除非 A 明确 @ B，并且限制来回次数。防循环的规则在主人的更新 1 里，由 v1 定义（`scratchpad/v1/owner-updates.md` 更新 1）。
- A 的运行卡、子 agent 卡不进 B 的上下文，只进最终回答。

### 3.6 压缩

- 自动：两家都用原生自动压缩，默认开。
- 去掉"关闭自动压缩"开关，理由有三：Codex 新版可能已经关不掉（2.1，推断）；Claude 一直没接；关了以后窗口满会直接失败，卡片只能说"上下文已满"（`providers.md:801`）。如果要保留，就两家都按原生接：Codex 设阈值，Claude 设 `autoCompactEnabled`，并在 Mac 上实测。
- 手动：`/compact`，在话题、连续主区、私聊都能用。Claude 可以带说明，比如 `/compact 保留接口设计`（推断，CLI 的 `/compact` 支持参数；SDK 文档只说可以把 `/compact` 当提示词发）；Codex 的 `thread/compact/start` 不带说明（2.1），只能不带。
- 用户看到的：
  - 运行卡头部的上下文仪表，今天已有（`card/context-gauge.ts`；`providers.md:770` 第 1 区）。
  - 压缩发生时过程区一行"上下文已自动压缩"或"已手动压缩"，最好带"85% → 20%"（`providers.md:774` 第 5 区）。Codex 的数字来自压缩前后的 tokenUsage，Claude 来自 `pre_tokens` 和 `post_tokens`（SDK `:3776-3784`）。
  - 用量过 80% 时卡片底部提示"可以 /compact，或开个新话题"（推断，阈值待定）。
  - `/context` 随时查。用量要写进 `sessions.json`，不要只放内存（1.4）。
- 压缩后 agent 会忘细节。原文还在飞书里，agent 可以按 3.4 用 lark-cli 回查。长期规则放 bot 的记忆和指令文件，不放对话里（CC agent-loop）。
- 子 agent 各自压缩，不影响父会话（CC sub-agents）。

### 3.7 子 agent 怎么显示，上下文怎么算

显示的三种做法：

| 做法 | 说明 | 取舍 |
|---|---|---|
| A 只在父运行卡里（推荐） | 用 V6c 已设计的子 agent 区：一行一个，状态、名字或类型、任务、步数、用时、当前步骤（Claude 用 `summary`），点开看最近 5 步和结果，"查看完整过程"发单独的卡，"停止"按钮 | 和原生应用一致，子 agent 挂在父会话下面；不刷屏；不进群聊上下文 |
| B 每个子 agent 发一条消息或开话题 | 子 agent 自己有一张卡，甚至能单独对话 | 显眼，但 5 个子 agent 就是 5 条消息；飞书话题不能套话题（推断）；会打破"一个话题一条会话"，因为子 agent 是另一条原生线程 |
| C 只在结束时发汇总 | 一张卡列出每个子 agent 的结果 | 最省，但过程看不见，不满足"子 agent 可见" |

上下文的算法（写进产品说明）：

- 子 agent 没有自己的飞书对话。它的上下文是父 agent 给它的任务，加它自己的指令；Codex 新版和 Claude 的 fork 会带上父会话历史（2b）。
- 群里的新消息只给父会话（steer 或排队），从不直接给子 agent。
- 子 agent 的 token 不占父会话的窗口。父会话只多了子 agent 的最终结果（2b）。卡片头部的仪表只显示父会话；子 agent 的用量显示在它那一行（Claude `task_progress.usage`，Codex 子线程的 tokenUsage，推断）。
- 子 agent 的记录跟着父会话存，原生应用里在父会话下面（Codex 子线程带 `parent_thread_id`；Claude 在 `subagents/` 目录）。

要先定的事：

- Claude 子 agent 默认后台跑，主回合结束时可能还没完（2b）。建议：声明 `perTaskStopAffordance`，主回合结束后运行卡的子 agent 区继续更新，直到名单清空；完成通知引起的新一轮，作为同一话题里的新卡发出，标明"子 agent 完成后继续"。这要改 `providers.md:617` 和"运行只由 send 开始"的假设。
- 备选：停止主回合时一并停掉后台子 agent（不声明 `perTaskStopAffordance`，SDK `:1796-1813`），卡片收尾简单，但子 agent 白跑。
- Codex 子 agent 多数由父线程 `wait` 等结果，推断主回合通常比子 agent 晚结束，问题小。

### 3.8 在 Codex 或 Claude 里打开

- 现状已经基本满足（2.1、2.2 的推断）。要在 Mac 上确认两件事：Codex 应用的历史里能看到 bot 开的线程；`claude --resume <id>` 能接上 bot 的会话。
- 用户看到的是织入后的文本，比如对话记录块。所以记录块要写得像人读的，不要塞内部标记。
- 不要用 Codex 的 `inject_items`，否则模型看到的和应用里显示的不一样（2.1）。
- 同一条会话同时在应用和 bot 里继续，会有两个写入方。推断会分叉或乱序。v1 建议只读打开，或者在应用里继续后，bot 下一轮提示"这条会话在别处更新过"。是否能检测未知。

### 3.9 上线前要在 Mac 上实测的点

1. `message.list` 和 `message.get` 用现在的权限能不能拉到话题上文（1.11）。
2. 拉历史时会不会返回别的 bot 的消息；拿到 bot 卡片正文要哪些权限。
3. 换真名要的权限和接口。
4. Codex 0.156.1 上 `model_auto_compact_token_limit=1e9` 能不能关掉自动压缩。
5. Codex 0.156.1 上 `multi_agent` 是否默认开，子线程通知是否都送到同一个连接，`fork_context` 的默认值。
6. Claude 0.3.296 带的 CLI 里，子 agent 是否默认后台；主回合 `result` 会不会等后台子 agent；完成通知引起的新一轮怎么出现在流里。
7. Codex 应用历史里能否看到 bot 线程；`claude --resume` 能否接上 bot 会话；两边同时写会怎样。
8. 注入的 Codex 项在 Codex 应用里确实不显示（如果仍考虑做法 B）。

## 未知

- 飞书长连接在 daemon 离线期间漏掉的事件会不会补推。
- 飞书话题群（`chat_mode=topic`）里主区消息和话题的关系是否和普通群一样。
- bot 身份调用 `+messages-search` 是否真的可用；文档写了 user 或 bot，但搜索接口常要用户身份。
- 换真名需要哪个权限。
- Codex 应用和 Claude 桌面应用的界面具体怎么显示 bot 会话、分叉和子 agent。只看了协议和存储，没看应用。
- 0.156.1 和 CXR main 之间关于压缩、多 agent、分叉的差别。CXR 只有 `rust-v0.162.1` 一个标签。
