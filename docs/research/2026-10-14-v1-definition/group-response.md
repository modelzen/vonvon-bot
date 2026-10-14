# 一个群里有多个 bot：谁回哪条消息（v1 设计）

范围：主人在更新 1 里定的三档回复方式（仅 @ 时回复、全部回复、智能回复）。本报告只定三档的行为、默认值、权限和多 bot 规则。判断提示词、模型和阈值按主人的意思留到实现时定（`scratchpad/v1/owner-updates.md` 更新 1）。上下文怎么拼接见同目录 `context-code-agents.md` 第 3.4、3.5 节，这里不重复。

代码路径都相对 `/home/operator/vonvon/vonvon-bot`（main `be17859`）。bridge 路径相对 `/home/operator/vonvon/feishu-codex-bridge`（`v0.6.14`）。

## 结论

1. **三档都能在现有代码上做，不需要新的飞书权限。** "仅 @"和"全部回复"就是 bridge 今天的两档：免 @ 关和免 @ 开（`packages/daemon/src/bot/handle-message.ts:1197-1203`）。智能回复要用的"读群里不 @ 的消息"权限 `im:message.group_msg` 已经在必需列表里（`packages/daemon/src/config/scopes.ts:24`）。迁移过来的 bot 都已经有这个权限。判断模型可以直接复用会话标题服务那条"不带工具的单次调用"（Codex `agent/codex-appserver/backend.ts:163-191`，Claude `agent/claude-agent/backend.ts:321-350`）。
2. **多 bot 时，三档共用三条底线。** 它们回答"这条消息是对谁说的"，然后才轮到三档各自的规则：
   - 规则 1，点名：@ 了谁、回复（引用）了谁，就只有谁回。@ 了别人、@所有人，其他 bot 都不回。
   - 规则 2，接着聊：话题里没点名的消息，归最近在这个话题说过话的 bot。
   - 规则 3，bot 消息：别的 bot 发的消息，只有 @ 了我才触发，而且连续 bot 回合有上限，真人说话就清零。
3. **今天的代码在多 bot 群里有三个现成的毛病（推断，看代码得出，没有实测）。** 开了免 @ 的 bot 会在别的 bot 开的话题里回话；主区不带 @ 的 `/help` 这类命令，每个开了免 @ 的 bot 都回；单会话群里每个开了免 @ 的 bot 都回每条消息。上面三条规则正好修掉这三个毛病。
4. **"Jev 模型 / 选择 API"没有找到对应的 OpenAI 产品。** 最接近主人描述的有两个。一个是 ChatGPT 群聊自己"判断什么时候接话、什么时候不说话"（2025-11 推出）。这是 ChatGPT 产品里的行为，不对开发者开放。另一个是开源的安全分类模型 gpt-oss-safeguard（2025-10-29），它是做内容安全分类的，官方建议别的用途用普通 gpt-oss。两者都不适合 v1 直接用。**推荐用用户自己的 Codex 或 Claude 订阅里的小模型**（Codex 的 GPT-6-Luna，Claude 的 Haiku 5.5），走现有的单次调用。
5. **智能回复的成本按"每台机器每条消息最多一次判断"来控制。** 判断只在三种情况下都满足时才跑：这一档是智能、消息来自白名单里的真人、三条规则定不下来。同一台机器上的几个智能 bot 合成一次"选谁回"的调用。另外有每群每小时上限，判断超时或出错一律不回。
6. **默认值沿用 bridge。** 新群和迁移群都按 bridge 的 `defaultNoMention` 换算（`packages/daemon/src/project/registry.ts:83-85`）：免 @ 开的换成全部回复，关的换成仅 @。智能回复永远不默认开，要管理员手动开。开的时候 bot 在群里发一次说明："我会读群消息，合适时接话。"
7. **建议主人拍板 4 件事**，见第 8 节：判断用谁的额度、v1 要不要支持 bot 互相 @、被拉进的已有群默认用哪档、判断结果要不要包含"只回表情"。

---

## 1. 飞书平台事实

### 1.1 收消息要什么权限

来源：[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)。

| 想收到的消息 | 权限 |
|---|---|
| 真人在群里 @ 当前 bot | `im:message.group_at_msg` 或 `im:message.group_at_msg:readonly` |
| 真人**和其他 bot** @ 当前 bot | `im:message.group_at_msg.include_bot:readonly` |
| 群里所有**真人**消息（不含 bot 消息） | `im:message.group_msg`（"获取群组中所有消息"） |
| 群里所有真人**和其他 bot** 的消息 | `im:message.group_msg.include_bot:read`，"不包含当前机器人自己发送的消息" |

- 所以只开 `im:message.group_msg` 的 bot 收不到别的 bot 的消息，也就不会被别的 bot 触发。这是 bridge 今天不会出现 bot 互相循环的原因。
- **审核。** 自建应用申请权限，"需要通过租户管理员的审核"。管理员可以把一部分权限设成免审，免审的申请后立即生效（[权限介绍](https://open.feishu.cn/document/server-docs/application-scope/introduction.md)）。
  - `im:message.group_msg` 默认是不是需审核：**未知**。权限列表页是动态加载的，我抓不到（[scope-list](https://open.feishu.cn/document/server-docs/application-scope/scope-list.md) 只返回空表格）。
  - bridge 的代码注释把它标成"高敏感"（`scopes.ts:24`）。
  - 个人租户是不是自己批：**未知**（`results/fit.report.md` 第 2 节也没查到）。

### 1.2 事件里的 @、引用、话题、@所有人和发送者类型

- `sender.sender_type` 是 `user` 或 `bot`，用它区分真人和 bot（接收消息事件文档）。
- `mentions[]` 每项有 `key`（如 `@_user_3`）、`id`、`name`、`tenant_key`（同上）。
- `root_id`、`parent_id` "仅在回复消息场景会有返回值"。`thread_id` 只有话题消息才有（同上）。
- @所有人：事件文档没提。SDK 把 `key` 为 `@_all` 的项当成 @所有人。飞书有时不给 `mentions`，所以 SDK 还会扫一遍正文（`node_modules/@larksuiteoapi/node-sdk/lib/index.js:98288-98300`、`:99115-99120`）。
- **SDK 的 `isBot` 字段意思是"@ 的就是我自己"，不是"@ 的是任意 bot"**（`lib/index.js:98305`：`openId === botOpenId`）。
- 回复的是谁的消息，事件里看不出来，要用 `parent_id` 去查那条消息。[获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get.md) 返回 `sender.sender_type`（`user`、`app`、`anonymous`、`unknown`）。发送者是应用时，`id_type` 为 `app_id`。所以"引用的是哪个 bot 的消息"能精确判断。
- 群信息接口返回 `user_count`、`bot_count`、`chat_mode`（`group`、`topic`、`p2p`）和 `group_message_type`（`chat`、`thread`）。需要 `im:chat:readonly` 等权限之一（[获取群信息](https://open.feishu.cn/document/server-docs/group/chat/get-2.md)）。v2 已经把 `im:chat:readonly` 列为可选权限（`scopes.ts:77-80`）。

### 1.3 发送限频

- "向同一用户发送消息的限频为 5 QPS、向同一群组发送消息的限频为群内机器人共享 5 QPS"。接口本身限 1000 次/分钟、50 次/秒。超限返回 230020（[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)）。
- 推断：三个 bot 同时在一个群里刷流式卡片，会共用这 5 QPS。卡片更新算不算在里面：**未知**。

### 1.4 bot 能给出的"正在处理"信号

- 没找到飞书给 bot 用的"正在输入"接口（**未找到**）。
- v2 用表情回应代替：排队时加 `OneSecond`，运行时加 `Typing`（`handle-message.ts:900-903`）。

### 1.5 bot 之间的特殊坑（来自飞书团队的 OpenClaw 插件）

- `@larksuite/openclaw-lark@2026.7.16`（MIT，ByteDance）的代码注释说：bot 对 bot 用话题方式回复时，飞书会把回复收进一个群成员看不到的"话题视图"，人看不到 bot 之间在说什么（`scratchpad/oclark/package/src/messaging/inbound/bot-content.js:8-12`，issue #32980）。
- 插件的处理是：除非本来就在话题会话里，bot 对 bot 的回复强制发到主区（同文件 `:105-116`）。这个行为我们没实测。

## 2. bridge 和 v2 今天怎么做

| 项 | 现状 | 依据 |
|---|---|---|
| 两档 | 免 @ 关（只回 @）和免 @ 开 | `handle-message.ts:1197-1203`；bridge `src/bot/handle-message.ts:1161-1167`，逻辑相同 |
| 默认值 | 被拉进的已有单会话群默认免 @ 关，其他情况默认开 | `project/registry.ts:83-85` |
| 多话题群的免 @ | 只在话题里免 @。主区闲聊仍要 @，因为"开新话题是明确意图"。斜杠命令和 `/goal` 除外 | `handle-message.ts:1189-1203` |
| 单会话群的免 @ | 整群每条都回 | 同上 `:1201` |
| @ 了别人 | 开了免 @ 也不接：@所有人、或 @ 了任何别人（包括别的 bot），这个 bot 都不回。原因是 SDK 的 `isBot` 只标自己 | `handle-message.ts:1199`；SDK 见 1.2 |
| 话题上文 | 首轮拉话题里最近 50 条，丢掉 bot、应用和系统消息，留最近 20 条真人消息 | `bot/context-weave.ts:40-46`、`:110-128` |
| 权限 | 必需 `im:message.group_at_msg:readonly` 和 `im:message.group_msg`。没有 include_bot 类权限。安装时一直等到必需权限全部开通 | `scopes.ts:16`、`:18-38` |
| 谁能改 | `/settings` 只有 bot 管理员能用 | `handle-message.ts:1214-1219` |
| 协议 | `response: "mention" \| "all"`，存成 `noMention` | `packages/protocol/src/domain.ts:72`、`:120`；`packages/protocol/src/settings.ts:78`；`docs/architecture.md:213` |
| 死代码 | bot 级 `requireMentionInGroup` 没有调用方 | `config/schema.ts:116`、`:233`（`v2-fit.md` 第 1 节也记了） |

**多 bot 下的三个毛病**（推断，看代码得出，没有实测）：

1. 话题没有归属判断。开了免 @ 的 bot 在**任何**话题里都回，包括别的 bot 开的话题。它会按这个 `threadId` 在自己的目录里另起一个会话（`handle-message.ts:1070-1113`、`:1202`）。
2. 主区不带 @ 的斜杠命令（`/help` 等），每个开了免 @ 的 bot 都回（`:1202`）。
3. 单会话群里每个开了免 @ 的 bot 都回每条消息（`:1201`）。

另外：
- 多 bot 场景没有测试。免 @ 的测试只有 5 个单 bot 用例（`packages/daemon/test/no-mention-parity.test.ts:77-100`）。
- 读取消息列表时会返回 bot 的消息。代码要专门把它们过滤掉，注释写着 "drop the bot's own replies, other apps"（`context-weave.ts:125`、`:165`）。推断：不申请 include_bot 权限，也能通过拉列表看到别的 bot 的回复。

## 3. 别的产品怎么决定开口

| 产品 | 群里怎么决定回不回 | 来源 |
|---|---|---|
| ChatGPT 群聊 | "follows the flow of the conversation and decides when to respond and when to stay quiet"。消息里写 "ChatGPT" 一定回。会用表情回应。由 ChatGPT 5.1 Auto 回复。限频只算 ChatGPT 的回复，不算人之间的聊天。搜索摘要还说管理员可以改成只在被 @ 时回复，但帮助中心原文我打不开（403），没核实 | [gsmarena，2025-11-14](https://m.gsmarena.com/openai_chatgpt_group_chats-news-70295.php)；[帮助中心](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)（未打开） |
| Grok Bot 群聊（自家 app） | 群里 2 到 6 个 bot。"Write normally to let the participating Bots decide who should respond"。@ 指定一个，"Reply on a Bot's message to direct your answer to that Bot"。bot 之间可以交接，建议"Ask for a single owner at each stage" | [docs.x.ai chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration.md) "Start a group chat"、"Let Bots hand work off" 两节 |
| Grok Team Bots（Slack） | 频道里被 @ 才回，之后跟着这个话题回，不用再 @。"ignores top-level messages that don't mention it"。要每条都回，得配一个频道监听 routine | [docs.x.ai team-bots](https://docs.x.ai/grok-bot/team-bots) |
| OpenClaw 核心 | 群里默认要 @。群主可以用 `/activation mention\|always` 切换。没 @ 的消息"store for context only"。`silentReply.group: "allow"` 后允许回 `NO_REPLY`。多个 agent 同群时，靠每个 agent 自己的 `mentionPatterns` 区分，没有更完整的多 bot 协议 | [docs.openclaw.ai/channels/groups](https://docs.openclaw.ai/channels/groups) |
| 飞书官方 OpenClaw 插件 | 每群可配 `requireMention`、`respondToMentionAll`、`allowBots`（`false`、`true`、`'mentions'`，默认 `'mentions'`）。防循环：每个"群加话题"最多连续 10 轮 bot 回合，真人一发言就清零，闲置 10 分钟也清零。超限时发一次不带 @ 的提示："已达连续 10 轮自动对话上限……需要继续请在群里发一条消息" | `scratchpad/oclark/package/src/core/config-schema.js:108`、`:125-138`；`src/messaging/inbound/gate.js:47-60`、`:181-193`；`src/messaging/inbound/bot-loop-guard.js:26-29`；`src/messaging/inbound/handler.js:212-256` |
| botmux（飞书） | 群里只有一个人加一个 bot 时不用 @。多人群就算只有一个 bot 也要 @。bot 之间只能显式 @ 才会触发。读群上下文默认关。另有"ambient"模式：不 @ 也聊，只 @ 了别人时不说话 | [botmux multi-bot](https://deepcoldy.github.io/botmux/multi-bot)；`scratchpad/botmux.md:180-182` |
| comma Bridge For Teams（AGPL，只借思路） | Worker 先私下判断 ACT、MAYBE 或 SKIP。"Silence is the normal choice when you have nothing useful to add"。MAYBE 只回一个表情。不公开解释为什么回或不回。不说话时记原因码：`already_handled`、`no_useful_addition`、`insufficient_evidence`。@ 消息和以"？"结尾的真人提问走快速通道。其他不点名的消息默认防抖 180 秒后批量判断 | `references/comma/systems/apps/salix_agent/lib/salix_agent/slack_participation_prompt.ex:117-125`、`:181-197`；`references/comma/docs/bridge-for-teams/design.md:74-82`；`systems/apps/salix_im/lib/salix_im/triage/addressing_evidence.ex:69-79`、`:117`；`.../triage/runtime.ex:331` |
| Agno（Slack 框架） | 2025-11-14 把默认改成只回 @，`reply_to_mentions_only=False` 恢复全回。理由是频道少刷屏 | [agno](https://www.agno.com/articles/control-slack-bot-engagement-with-mention-only-replies-by-default.md) |
| Character.AI 群聊 | 没找到官方的"谁接话"设置 | 搜索未果 |
| 论文 | "Speak or Stay Silent"（2026-03，场景是语音助手）：8 个 LLM 零样本做"该不该说话"时"consistently fail"，加推理轨迹做监督微调后，平衡准确率最多提高 23 个百分点。"Time to Talk"（2025-06，狼人杀类游戏）：把"什么时候说"和"说什么"拆成两个模块 | [arXiv 2603.11409](https://arxiv.org/abs/2603.11409)；[arXiv 2506.05309](https://arxiv.org/abs/2506.05309) |

**几点共识：**

1. 默认要 @ 或只在被点名时回，是行业通行做法（Grok Team Bots、OpenClaw、Agno、botmux 多人群）。"自己判断要不要说"只出现在 ChatGPT 和 Grok 的自家 app 里。
2. 引用（回复）某个 bot 的消息，等于点名它（Grok）。
3. 不说话是正常结果，判断理由不公开（comma、OpenClaw `NO_REPLY`）。
4. bot 互相触发要有硬上限，真人发言就清零（飞书官方插件）。
5. 零样本的判断会经常判错（论文）。所以 v1 要保守，判错时宁可不回，并记下原因，方便以后调。

## 4. "Jev 模型 / 选择 API"可能指什么

没找到一个叫 Jev 的模型，也没找到 OpenAI 专门给开发者用的"该不该回"API（多次搜索未果）。候选：

| 候选 | 是什么 | 怎么调用 | 许可和费用 | 本地能跑吗 | 适不适合"该不该回" |
|---|---|---|---|---|---|
| ChatGPT 群聊的接话判断 | ChatGPT 产品里的行为，2025-11 试点，有报道说 2026 年对个人各档开放 | 不对开发者开放 | 包含在 ChatGPT 订阅里 | 否 | 正是主人描述的效果，但拿不到。推断：主人说的"OpenAI 也推出了"很可能是这个 |
| gpt-oss-safeguard-20b / -120b | 开源权重的安全推理模型，按开发者写的策略做分类，2025-10-29 发布 | HF Transformers、vLLM（OpenAI 兼容接口）、量化版可用 Ollama 和 LM Studio。只认 harmony 格式。搜索摘要说兼容 Responses API 和结构化输出（OpenAI 原文 403，没核实） | Apache 2.0，免费 | 20b 是 21B 参数、3.6B 激活，"fits into GPUs with 16GB of VRAM" | 能用来分类，但它是为内容安全设计的。模型卡说其他用途建议用普通 gpt-oss。还要用户装推理环境、下载十几 GB（推断），桌面普通用户门槛高 |
| OpenAI API 小模型（GPT-5.4-nano 等） | 通用小模型 | 要用户自己的 OpenAI API key | 第三方价格表：$0.20/百万输入，$1.25/百万输出 | 否 | 适合，但非开发者用户不会去配 key |
| Codex 订阅里的 GPT-6-Luna | Codex 0.162 自带目录里的"Fast and affordable model for easier tasks"，推理强度最低可设 low。GPT-5.4-mini 会被迁到它 | 走用户本机 Codex 登录，v2 已有单次调用代码 | 计入用户的 Codex 用量，单次消耗多少：**未知** | 否（模型在云端） | 适合，**推荐给 Codex bot 用** |
| Claude 订阅或 API 里的 Haiku 5.5 | `claude-haiku-5-5`，API 价 $0.10/百万输入，$0.50/百万输出（10 万 token 以内） | 走用户本机 Claude 登录（Agent SDK），v2 已有单次调用代码 | 订阅额度或 API 计费 | 否 | 适合，**推荐给 Claude bot 用** |

来源：
- gpt-oss-safeguard：[HF 模型卡](https://huggingface.co/openai/gpt-oss-safeguard-20b)、[Help Net Security 2025-10-29](https://www.helpnetsecurity.com/2025/10/29/openai-gpt-oss-safeguard-safety-models/)。
- GPT-5.4-nano：[pricepertoken（2026-03-21）](https://pricepertoken.com/pricing-page/model/openai-gpt-5.4-nano)、[morphllm](https://morphllm.com/openai-api-pricing)。都是第三方来源。
- GPT-6-Luna：`scratchpad/codex-src-0162/codex-rs/models-manager/models.json`（`gpt-6-luna` 条目）、`.../tui/src/app/startup_prompts.rs:134`。这是本地 0.162 源码自带的目录，账号上实际有哪些模型以服务端为准。
- Haiku 5.5：claude-api 技能的模型表（缓存于 2026-10-06）。

**一个和整个 Claude 后端有关的风险（不只是判断）。** Agent SDK 文档写着："Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"（[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)）。v2 的 Claude 后端复用本机的 Claude 登录（`agent/claude-agent/backend.ts:183-184`、`:237`）。另一份报告记录说 10-07 的帮助文档又允许 Agent SDK 用订阅额度（`results/agent-integrations.report.md:121`）。两份文档说法冲突，结论**未定**。这件事影响所有 Claude bot，智能回复只是让调用次数多了。

## 5. 判断怎么调用、花多少、多慢

**能直接复用的代码：**
- Codex 判断：每次起一个 app-server，开一个 `ephemeral` 线程。沙箱只读，关掉联网搜索、hooks、多 agent，用 `outputSchema` 约束输出（`codex-appserver/backend.ts:163-191`、`:648-662`）。
- Claude 判断：`tools: []`、`skills: []`、`mcpServers: {}`、`settingSources: []`、`maxTurns: 1`、`persistSession: false`，加 JSON schema 输出（`claude-agent/backend.ts:321-350`）。不带工具，也不加载用户的技能和设置。
- 两边的超时都是 30 秒（`codex-appserver/backend.ts:109`，`claude-agent/backend.ts:97`）。
- 新合同里有 `oneShot?(prompt, {timeoutMs})`，定义是"A separate process with no tools"，还没接线（`provider/engines/engine.ts:64-65`）。
- 标题服务的回退顺序可以照搬：先用本群 provider，再用别的已装 provider（`docs/architecture.md:127`）。

**延迟：未知，要实测。**
- 组成：合并等待 + 起进程 + 模型首字。
- Codex 路径每次调用都新起一个 app-server（`backend.ts:651`）。Agent SDK 每次查询都启动 Claude Code 二进制（Agent SDK overview："A library that runs the Claude Code binary"）。所以冷启动很可能是大头（推断）。
- 实现时在 Mac 上量 p50 和 p95。冷启动太慢的话，每个 provider 常驻一个判断进程（推断）。

**花费（推断，按 API 价算）：**
- 一次判断按 2,000 输入 token、50 输出 token 算。Haiku 5.5 约 $0.000225 一次，1,000 次约 $0.23。GPT-5.4-nano 约 $0.00046 一次。
- 走订阅时计入用户额度，一次占多少：**未知**。

**为什么不让主 agent 自己判断：** OpenClaw 的做法是正常跑一轮 agent，让它回 `NO_REPLY`。这样每条群消息都要跑一轮完整 agent，贵，慢，还会把没回的消息写进原生会话。`context-code-agents.md` 第 3.4 节的设计是"判为不回的消息不进原生会话"，和单独判断更合得来。

## 6. v1 设计

### 6.1 三档的行为

下表是"这个 bot 对这条消息回不回"。三条底线（6.2）先算，表里已经包含它们的结果。

| 消息 | 仅 @ 时回复 | 全部回复 | 智能回复 |
|---|---|---|---|
| @ 我 | 回 | 回 | 回，不调判断 |
| 回复（引用）我发的消息，没 @ | 不回（和 bridge 一样） | 回 | 回，不调判断 |
| @ 了别人、@所有人、回复别人的消息 | 不回 | 不回 | 不回，不调判断 |
| 话题里没点名的消息，最近在这个话题说话的 bot 是我 | 不回 | 回 | 话题里只有一个真人在聊：直接回。否则调判断 |
| 话题里没点名的消息，最近说话的 bot 是别人 | 不回 | 不回 | 不回，不调判断 |
| 多话题群主区，没点名的普通消息 | 不回 | 不回（和 bridge 一样，开新话题要明确意图） | 调判断。判为回就开一个新话题回 |
| 单会话群，没点名的普通消息 | 不回 | 最近说话的 bot 不是别人时回 | 调判断，并告诉判断"最近谁在跟谁聊" |
| 主区不带 @ 的斜杠命令 | 不回 | 群里只有我一个 bot 时回；`bot_count > 1` 时要 @ | 同全部回复 |
| 别的 bot 发的消息 | 只有它 @ 我才回，受循环上限约束 | 同左 | 同左 |
| 不在群白名单里的人发的消息 | 不回（今天的白名单门，`handle-message.ts:977`） | 同左 | 同左，不调判断 |

- "全部回复"沿用 bridge 免 @ 开的效果，只多了"别的 bot 的话题不进"和"多 bot 群里命令要 @"两处。
- "智能回复"判为不回的消息，下一次触发时作为增量带进会话（`context-code-agents.md` 第 3.4 节）。

### 6.2 三条底线（三档共用）

1. **点名。** 消息 @ 了谁、回复（引用）了谁的消息，就只有被点到的 bot 回。@ 了两个 bot，两个都回（Grok 的说法："Mention multiple Bots when the request genuinely needs each of them"）。@ 了别人、@所有人、回复别人的消息，其他 bot 都不回。
   - 例外：仅 @ 档里，回复我的消息不算点名。这是为了和 bridge 保持一致。
   - "回复的是谁"用 `parent_id` 查（1.2）。这一查要一次接口调用，只在消息有 `parent_id`、而且这个 bot 不是仅 @ 档时才做。
2. **接着聊。** 话题里没点名的消息，归最近在这个话题说过话的 bot。
   - 判断方法：拉一次话题消息列表，看最近一条 bot 消息的 `sender.id` 是不是自己的 `app_id`。
   - v2 首轮本来就会拉话题列表（`context-weave.ts:110-118`），所以这一步多数时候是复用。
   - 不同机器上的 bot 也能用同一个方法，不用互相通信。
3. **bot 消息。** 别的 bot 发的消息只有 @ 我才触发。每个"群加话题"连续 bot 回合有上限，真人发言就清零。超限时在原位置发一次不带 @ 的提示。上限数值实现时定，飞书官方插件用的是 10。

### 6.3 默认值

| 情况 | 默认档 | 依据 |
|---|---|---|
| bot 自己建的群（单会话或多话题） | 全部回复 | bridge `defaultNoMention`，`registry.ts:83-85` |
| 被拉进的已有群，多话题 | 全部回复（只对自己的话题生效，加上规则 2 后不会进别人的话题） | 同上 |
| 被拉进的已有群，单会话 | 仅 @ | 同上 |
| 迁移的 bridge 群 | 按有效的 `noMention` 换算：开 → 全部回复，关 → 仅 @ | `registry.ts:26-28`、`:83-85` |
| 智能回复 | 永远不是默认，管理员手动开 | 第 3 节共识 1、5 |

**迁移用户会感到的变化**要写进迁移说明：
1. 多 bot 群里，bot 不再在别的 bot 的话题里回话。
2. 多 bot 群里，主区命令要 @。
3. 全部回复档里，引用 bot 的消息就算点名它。

### 6.4 智能回复：发给判断什么，判断返回什么

**发给判断（固定形状，内容截断上限实现时定）：**
- 候选 bot：名字、一段角色或个性摘要、技能名、关联的仓库和工作区名。只给名字和摘要，不给全文。
- 群：群名、单会话还是多话题、消息在主区还是话题里。
- 新消息：发送者名字、真人还是 bot、文字、@ 了谁、回复了谁、附件类型。用名字，不给 open_id。
- 最近 N 条（同一话题或主区）：发送者名字、真人或哪个 bot、截断后的文字。包括别的 bot 的最终回答，不包括它们的运行卡和工具步骤（和 `context-code-agents.md` 第 3.5 节做法 1 一致）。
- 状态：最近说话的 bot 是谁；这条消息之后是不是已经有 bot 回了；我上次在这里说话是什么时候。
- 不给：工具、文件内容、记忆全文、原生会话历史。

**判断返回（JSON schema 约束）：**

```json
{ "decision": "reply" | "skip",
  "bot": "<app_id，本机有多个候选时必填>",
  "reason": "asked_me" | "my_conversation" | "can_help" | "not_for_me" | "already_answered" | "small_talk" | "no_value" | "unsure" }
```

- 原因码只记在本机诊断里，**不发到群里**（comma："Do not explain your participation decision publicly"，`slack_participation_prompt.ex:120-121`）。
- `unsure` 按不回处理。
- 群消息是不可信输入。判断提示里要把它们当数据，不当指令。判断进程没有工具，最坏的后果是多回一条。真正的回复仍受本群权限档位约束。

### 6.5 成本和延迟的上限

1. 只在智能档、只对白名单里的真人消息、只对三条底线定不下来的消息调判断。
2. **同一台机器一条消息只调一次。** 本机所有智能档候选 bot 放进一次"选谁回"的调用，最多选一个 bot。
3. 合并：同一个人短时间内连发几条，合成一次判断。等多久实现时定。comma 的 180 秒对聊天太慢（`runtime.ex:331`）。
4. 话题里只有一个真人和我在聊时直接回，不调判断。这一条省掉个人使用时的大部分调用（推断）。
5. 每群每小时判断次数有上限。超了这个群暂时按仅 @ 处理，并在私聊里告诉管理员一次。
6. 判断有截止时间，超时或出错一律不回。沉默是安全的失败方式。
7. "用量"页显示每个群的判断次数。

### 6.6 多个 bot 都开全部回复或智能回复时

- **同一台机器**：每个 bot 是一个子进程，和 supervisor 之间已经有 IPC 通道（`bot/supervisor.ts:87-104`）。要新加一条"认领这条消息"的子进程到父进程消息，由 daemon 仲裁（推断）。
  - 全部回复：只放行一个。优先最近在这里说过话的 bot；都没说过时，选最早绑定这个群的。
  - 智能回复：用 6.5 第 2 条的一次调用选出最多一个 bot。
- **不同机器**：bot 之间不能直接协调，只能看消息。
  - 规则 1 和规则 2 只看消息本身，各机器得出的结论一样。
  - 智能回复第一次接一条没点名的消息时，可能两台机器都判"回"。处理办法：随机等一小段时间，在发出第一条可见内容之前再查一次。查法是取一次触发消息或它的话题，如果已经有别的 bot 回了，就放弃。等多久实现时定。
  - 全部回复在"还没有 bot 说过话"的单会话群里，第一条消息可能被两台机器各回一次。v1 接受这个情况，界面上提示。
- **界面提示**：`bot_count > 1` 的群里把某个 bot 设成全部回复时提示："群里还有别的 bot。几个 bot 都开全部回复会抢着回。建议只给一个 bot 开，其他用智能回复或仅 @。"
- **开启说明**：开全部回复或智能回复时，bot 在群里发一次说明（例："我会看群里的消息，合适时接话。管理员可以用 /settings 改回仅 @"）。智能回复会把没点名的群消息发给模型服务商，所以这条说明是必须的。

### 6.7 防循环

- 规则 3 已经是硬上限。另外两条：
  - bot 回别的 bot 时，回复发到主区并引用原消息，不用话题回复。除非本来就在话题里。这是为了避开 1.5 的隐藏话题问题（照飞书官方插件的做法，未实测）。
  - bot 自己的消息不会推给自己（1.1，飞书本身排除了）。
- 不申请 `im:message.group_msg.include_bot:read`，bot 就收不到别的 bot 的普通消息，也就不会被它们触发。只有 @ 能触发，靠 `im:message.group_at_msg.include_bot:readonly`（见 6.9）。

### 6.8 例子：一个多话题群，3 个 bot，5 条消息

群里有真人张三、李四。三个 bot 都在主人的 Mac 上，同一个 daemon：
- 小码：Codex，编码，全部回复
- 小P：Claude，产品，智能回复
- 小审：Claude，审查，仅 @

| # | 消息 | 小码（全部回复） | 小P（智能） | 小审（仅 @） | 判断调用 |
|---|---|---|---|---|---|
| 1 | 张三在主区："@小码 登录接口为什么 500？" | 回，开话题 T1（规则 1） | 不回（点名了别人） | 不回 | 0 |
| 2 | 李四在 T1 里，没 @："是不是昨天改了 token 过期时间？" | 回，T1 里最近说话的 bot 是它（规则 2） | 不回（T1 归小码） | 不回 | 0 |
| 3 | 张三在主区，没 @："下周发布要不要先砍掉导出功能？大家怎么看" | 不回（主区闲聊要 @） | 判断，大概率判 `reply / can_help`，开话题 T2 回 | 不回 | 1 |
| 4 | 李四在主区："哈哈今天食堂的红烧肉不错" | 不回 | 判断，判 `skip / small_talk`，不回 | 不回 | 1 |
| 5 | 小码在 T1 里发："@小审 帮我看下这个 diff" | — | 不回（bot 消息没 @ 它） | 回（规则 3，要可选权限）。T1 的 bot 连续回合 +1 | 0 |

- 第 5 条之后，如果小审和小码互相 @ 到上限，就暂停并发一次提示。张三或李四说一句话后恢复。
- 再加两条：
  - "@所有人 明天十点开会"：三个都不回。
  - 李四在 T2 里引用小P 的回答说"优先级再排一下"：只有小P 回（规则 1，不调判断）。
- 三个 bot 如果在三台不同的机器上：第 1、2、4、5 条结果一样。第 3 条如果另一台机器上也有智能 bot 判了"回"，晚的那个在发出前复查，发现已有回复就放弃（6.6）。

### 6.9 主人看到的群设置

每个 bot 在每个群里一份，位置在桌面端群详情和飞书 `/settings` 卡片。只有 bot 管理员能改，和今天 `/settings` 的门控一样（`handle-message.ts:1214-1219`）。

- **回复方式**（三选一，每项一行说明）：
  - 仅 @ 时回复：只有 @ 我才回。
  - 全部回复：单会话群里每条都回；多话题群里，我开的话题不用 @。
  - 智能回复：我自己判断要不要接话。会读群里的消息，消耗你的 Codex 或 Claude 额度。
- **智能回复的附加项**（折叠）：
  - 判断用的模型：默认"跟随本群 agent 的小模型"。
  - 每小时最多判断几次。
- **允许别的 bot @ 我**：开关。缺权限时显示授权链接。
- **诊断**（桌面端"状态与诊断"页）：最近没回的消息和原因码；今天的判断次数。
- **数据形状**：
  - `response` 从 `{ noMention }`（`settings.ts:78`）改成 `{ mode: 'mention' | 'all' | 'smart', smart?: { model?, hourlyCap? }, allowBotMentions: boolean }`。
  - `domain.ts:72`、`:120` 的枚举加 `smart`。
  - 删掉死代码 `requireMentionInGroup`。

### 6.10 需要的飞书权限

| 用途 | 权限 | 状态 |
|---|---|---|
| 收 @ 我的消息（三档都要） | `im:message.group_at_msg:readonly` | 已必需（`scopes.ts:23`） |
| 收不 @ 的消息、拉话题和主区历史（全部回复、智能回复、上下文） | `im:message.group_msg` | 已必需（`scopes.ts:24`）。迁移 bot 已开通，因为安装时会一直等到它开通（`scopes.ts:16`） |
| 判断群里有几个 bot、群类型 | `im:chat:readonly` | 已是可选（`scopes.ts:77-80`）。缺了就按"可能有多个 bot"处理 |
| 别的 bot @ 我时能收到 | `im:message.group_at_msg.include_bot:readonly` | **新增，可选**。缺了就是今天的行为：bot 之间不能 @ |
| 收别的 bot 的所有消息 | `im:message.group_msg.include_bot:read` | v1 **不申请**，理由见 7.4 |
| 发消息、加表情 | `im:message:send_as_bot`、`im:message.reactions:write_only` | 已必需 |

企业租户里，新增的权限要发新版本，并经管理员审核才生效。具体某个权限默认需不需要审核：**未知**（1.1）。

## 7. 备选方案和取舍

**7.1 判断放在哪里**
- A1 单独的小模型单次判断（**推荐**）：便宜，能限流，不污染会话，能记原因。代价是多一次调用和一段延迟。
- A2 主 agent 自己判断，回 `NO_REPLY`（OpenClaw）：少一个组件。但每条消息都跑一轮完整 agent，贵，慢，还会写进原生会话。
- A3 本地开源模型（gpt-oss-safeguard-20b 或 gpt-oss-20b）：不花额度，数据不出机器。但要 16 GB 显存级别的机器，要装推理环境，下载量大（推断）。v1 不做。
- A4 用户自己的 API key：便宜稳定。但多一步配置，目标用户大多不会填。可以以后做成高级选项。

**7.2 同一台机器上的多个智能 bot**
- B1 一次"选谁回"的调用（**推荐**）：每条消息一次调用，本机不会两个 bot 同时回。缺点是判断只能用一个 provider 的模型，人设靠摘要表达。
- B2 每个 bot 各自判断，daemon 取一个：调用次数乘以 bot 数，好处是每个 bot 用自己的模型看自己的人设。

**7.3 不同机器之间去重**
- C1 发出前复查，加随机等待（**推荐**）：只多一次读接口。竞态窗口小，但不是零。
- C2 用表情占位：先加 `Typing` 表情表示"我接了"，别的 bot 看到就退。要读表情的权限和事件，竞态仍在，没验证。
- C3 不处理：最简单，偶尔会两个 bot 回同一条。

**7.4 bot 之间能不能互相看见、互相 @**
- D1 v1 支持 @，用可选权限 `group_at_msg.include_bot`，加循环上限（**推荐**）：能做"小码写、小审查"。普通消息不推给别的 bot，事件量不变。别的 bot 的回答靠拉列表看到（推断，第 2 节末尾）。
- D2 再加 `group_msg.include_bot:read`：每个 bot 实时收到所有 bot 的消息。上下文更全，但事件量随 bot 数成倍增长，要处理的循环情况也更多。
- D3 v1 完全不支持：就是今天的行为，最安全，但做不了 bot 之间的交接。

**7.5 `im:message.group_msg` 必需还是可选**
- E1 保持必需（bridge 现状）：行为统一。但企业租户审批不过时，整个 bot 起不来。
- E2 改成可选（**推荐给新安装**）：一键授权链接里照样预选。缺了只能用仅 @，另外两档灰掉并给授权链接，话题上文也拉不到。迁移用户本来就有这个权限，不受影响。

**7.6 智能 bot 能不能插进别的 bot 正在聊的话题**
- F1 v1 不能（**推荐**）：省调用，少抢话，规则简单。
- F2 能，交给判断：更像人，但调用更多，更容易两个 bot 同时说话。可以以后再开。

**7.7 判断结果要不要有"只回一个表情"**
- G1 v1 只有"回"和"不回"（**推荐**）：行为少，好验收。
- G2 加"只回表情"：ChatGPT 群聊和 comma 的 MAYBE 都有，更像人，几乎没有成本。但多一种行为要定规则、要验收。

## 8. 要主人拍板的问题

1. 智能回复的判断，用本群 agent 所属 provider 的小模型（**推荐**），还是固定用一个 provider？
2. v1 要不要支持 bot 互相 @？要的话得新增一个可选权限，企业租户还要管理员审核。推荐支持（7.4 D1）。
3. 被拉进的已有群默认用哪档：沿用 bridge（多话题群全部回复，单会话群仅 @，**推荐**），还是一律仅 @？
4. 智能回复的判断结果要不要包含"只回一个表情"（7.7）？

## 未知，要实测

- 判断的延迟（冷启动加首字）p50 和 p95，以及订阅下一次判断占多少额度。
- `im:message.group_msg` 和两个 include_bot 权限在企业租户里默认需不需要审核，个人租户是不是自己批。
- 同一个群、同一条消息，在不同应用看来 `chat_id` 和 `message_id` 是不是一样。推断是一样，v2 的数据结构已经这样假设（`domain.ts:117-123`），但没有找到官方原文。
- 拉消息列表是不是总会返回别的 bot 的消息。代码过滤逻辑暗示会（`context-weave.ts:125`），没实测。
- bot 作为发送者时，接收事件里 `sender_id` 的形状。规则 3 计数要用。
- bot 之间话题回复被藏进"话题视图"的问题（1.5），在我们的流程里会不会出现。
- 主人说的"Jev / 选择 API"到底指什么。
- Agent SDK 能不能用订阅登录（第 4 节末尾）。

## 来源

- 本地代码：上文各处的 `file:line`。
- 飞书：[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)、[获取指定消息](https://open.feishu.cn/document/server-docs/im-v1/message/get.md)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)、[获取群信息](https://open.feishu.cn/document/server-docs/group/chat/get-2.md)、[权限介绍](https://open.feishu.cn/document/server-docs/application-scope/introduction.md)、[权限列表（动态页，未取到）](https://open.feishu.cn/document/server-docs/application-scope/scope-list.md)。
- 其他产品：[docs.x.ai chat-and-collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration.md)、[docs.x.ai team-bots](https://docs.x.ai/grok-bot/team-bots)、[docs.x.ai bots](https://docs.x.ai/grok-bot/bots)、[OpenClaw groups](https://docs.openclaw.ai/channels/groups)、[botmux multi-bot](https://deepcoldy.github.io/botmux/multi-bot)、[Agno](https://www.agno.com/articles/control-slack-bot-engagement-with-mention-only-replies-by-default.md)、[gsmarena ChatGPT 群聊](https://m.gsmarena.com/openai_chatgpt_group_chats-news-70295.php)、[OpenAI 群聊帮助（403，未打开）](https://help.openai.com/en/articles/12703475-group-chats-in-chatgpt)。
- 飞书官方 OpenClaw 插件：`scratchpad/oclark/package`（npm `@larksuite/openclaw-lark@2026.7.16`，MIT）。
- comma（AGPL，只借思路）：`/home/operator/vonvon/references/comma` 下上文所列文件。
- 模型：[gpt-oss-safeguard-20b 模型卡](https://huggingface.co/openai/gpt-oss-safeguard-20b)、[Help Net Security](https://www.helpnetsecurity.com/2025/10/29/openai-gpt-oss-safeguard-safety-models/)、[pricepertoken GPT-5.4-nano](https://pricepertoken.com/pricing-page/model/openai-gpt-5.4-nano)、[morphllm](https://morphllm.com/openai-api-pricing)、Codex 0.162 源码 `models.json`、claude-api 技能模型表、[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)。
- 论文：[arXiv 2603.11409](https://arxiv.org/abs/2603.11409)、[arXiv 2506.05309](https://arxiv.org/abs/2506.05309)。
- 本会话其他报告：`results/fit.report.md`、`results/agent-integrations.report.md`、`v1/v2-fit.md`、`v1/context-code-agents.md`、`v1/persona-memory-skills.md`、`v1/owner-updates.md`。
