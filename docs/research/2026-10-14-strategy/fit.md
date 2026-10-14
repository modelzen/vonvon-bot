# Vonvon Bot："像人的 bot、聊天建 bot、bot 市场、CLI"在现有代码和飞书平台上能怎么落地

## 结论

- **大部分底子已经有了。** 一台机器能跑多个 bot，每个 bot 一个进程。新增 bot 靠扫码，网页和 CLI 都能扫。每个 bot 有自己的设置，同一个群可以进多个 bot。**真正缺的是"人设"**：现在每个 bot 收到的系统提示词是同一段写死的常量，也没有名字、简介、头像、口吻这些可编辑的字段。
- **"跟 bot 聊天建一个新 bot"在飞书上做得到，但至少要人点一次确认。** 每个"人"就是一个独立的飞书自建应用。建应用的唯一路线是扫码，或在飞书里点开一个注册链接，再由本人确认。确认之后，还可能要人工开权限、订阅事件、发布版本。企业租户另外要管理员审核。
- **代码里有一条已经过时的假设，正好压在最关键的环节上。** 代码注释写着"飞书没有 API 能声明权限，也没有 API 能订阅事件"（`config/scopes.ts:7`、`:193`，`bot/wizard.ts:57`）。但仓库已经装着的 SDK 1.71.1 提供两样东西：
  - 扫码时预填权限、事件和回调的 `addons`，要平台给你的账号开灰度才生效；
  - 一组 `application v7` 接口，能改应用名称、简介和头像，能改权限和事件，还能发布版本。

  这组 v7 接口在公开文档索引里查不到，能不能调、需要什么权限，都要实测。它决定了"聊天建 bot"最后剩 1 步人工还是 4 步。
- **可分享的 bot 定义**应该是一份不含任何凭据、本机路径和人员 ID 的文件。内容包括名称、简介、头像链接、人设文字、默认 agent 和模型、权限档位上限、卡片和运行偏好，以及要申请的飞书权限。导入时一定会新建一个飞书应用，所以导入流程本身就是"扫码注册"，只是带上了预填内容。
- **和 v2 架构基本是复用关系，不冲突。** 有三处要改设计：
  - 新 provider 合同里打开会话的参数（`OpenSpec`）没有放提示词的字段；
  - 私聊控制台按设计不跑 agent，"聊天建 bot"是一种新的对话方式；
  - 市场需要云端存模板，这超出了现在规定的云端只存"账号和机器"两种记录。

---

## 1. 现在已经有、和设想对得上的部分

| 设想 | 现状 | 依据 |
|---|---|---|
| 一台机器多个 bot | 可以多选同时运行，每个 bot 一个独立子进程 | `packages/daemon/src/config/bots.ts:17-25`、`:108-113`；`bot/supervisor.ts:59-61`、`:89` |
| 不重启就加一个新 bot | 可以。启用一个原来不在运行集合里的 bot 时，当场起一个子进程 | `bot/supervisor.ts:170-195` |
| 扫码加 bot | 命令行和网页共用同一个扫码函数。扫码人自动成为 owner 和管理员 | `bot/wizard.ts:5-20`、`:69-83`；`bot/register-bot.ts:83-121`、`:140`；`admin/service.ts:797-840`；`packages/ui/src/App.tsx:493-498`、`:563-573` |
| 扫码时预填名称和简介 | 已经在用，但写死成"Codex Bridge"。头像能预填，没用 | `bot/wizard.ts:56-62`；SDK `types/index.d.ts:312588-312598`（头像 1 到 6 个公网图片链接，名称支持 `{user}` 占位） |
| 刷新凭据 | 走同一条扫码流程，并校验扫码人必须是原 owner 或管理员 | `bot/refresh-bot.ts:31-36` |
| 每个 bot 自己的设置 | 卡片、运行、完成提醒、本机 CLI 桥、评论、会话标题、路径、允许的群 | `packages/protocol/src/settings.ts:52-70` |
| 每个群自己的设置 | 权限三档、免 @、自动压缩、模型。群的记录里还有 agent 后端、默认模型、推理强度、单会话或多话题 | `settings.ts:71-80`；`project/registry.ts:8-79` |
| 一个群里多个 bot | 界面明确支持："同一个群可以有多个 Bot，各自保留工作目录和群内配置" | `ui/src/App.tsx:512`；`protocol/src/domain.ts:117-123` |
| 群里有人 @ 别的 bot 时不插嘴 | 开了免 @ 也一样，消息 @ 了别人时这个 bot 不接 | `bot/handle-message.ts:1197-1199` |
| bot 进不同的群 | 三种方式：bot 自己建项目群；人把 bot 拉进已有群后，bot 推一张绑定卡；网页里列出 bot 已在的群再绑定 | `project/lifecycle.ts`；`project/pending-groups.ts`；`protocol/src/domain.ts:38`、`:45-66` |
| 可编辑的提示词文件（现成可抄的做法） | 每个 bot 一份 `comment-instructions.md`，同步成 `AGENTS.md` 和 `CLAUDE.md` | `config/paths.ts:76-87`；`bot/comments.ts:251-315` |
| **人设和系统提示词** | **没有。** 每个 bot 都只注入同一段写死的输出约定 | `agent/bridge-instructions.ts:12-32`；Codex 后端 `codex-appserver/backend.ts:675`、`:689`；Claude 后端 `claude-agent/backend.ts:362`、`:378` |
| **CLI 管理 bot** | bridge 有 `bot init\|list\|use\|rm`（`feishu-codex-bridge/README.md:118`）。v2 的 `vonvon` 命令**没有注册 `bot` 子命令**，`cli/commands/bot.ts` 文件还在但没人调用 | `packages/daemon/src/cli/index.ts:20-104` |
| bot 之间能看到对方的消息 | **没有。** 没申请飞书相应的权限，读话题上下文时也把 bot 发的消息过滤掉了 | `config/scopes.ts:18-38`；`bot/context-weave.ts:125`、`:165` |

bridge 的同一套代码点在同样的行号上：`feishu-codex-bridge/src/agent/bridge-instructions.ts:12`、`codex-appserver/backend.ts:675/689`、`claude-agent/backend.ts:362/378`、`bot/wizard.ts:58-61`。所以下面任何一个小功能，都能直接发给 bridge 的现有用户。bridge 最新版 0.6.14 发布于 2026-09-24，上周（10-06 到 10-12）下载 108 次（npm registry 和 api.npmjs.org）。

## 2. "跟 bot 聊天建新 bot"在飞书上的完整步骤

| # | 步骤 | 谁来做 | 依据和约束 |
|---|---|---|---|
| 1 | 用户私聊已有的 bot："帮我建一个产品经理 bot，说话简短……" | 人 | 现在的私聊控制台只发卡片，"never runs codex"（`bot/dm-console.ts:9-14`；菜单只有新建项目、设置、用量、诊断等，`card/dm-cards.ts:179-187`）。要新加一种"造 bot"对话 |
| 2 | 生成名称、简介和人设草稿 | 机器 | 可以复用不带工具的单次调用（`provider/engines/engine.ts:64-65`；`architecture.md:127` 的标题服务就是这么做的） |
| 3 | 调 `registerApp`，带上预填的名称、简介、头像，和要申请的权限、事件、回调 | 机器 | `wizard.ts:69-76` 能直接扩展。头像必须是公网链接（SDK types `:312589-312593`）。`addons` 只能在默认模板上加，**而且要平台开灰度，否则整组参数被忽略**（SDK types `:312600-312650`；[官方一键创建文档](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/create-an-app-in-one-click-java.md)）。SDK 写死建的是 `archetype: 'PersonalAgent'`（`lib/index.js:95830`） |
| 4 | bot 把注册链接做成卡片发到私聊 | 机器 | 链接"在飞书/Lark中打开"即可，不一定要扫码（SDK `README.zh.md:715`）。默认 600 秒过期（`wizard.ts:26-27`） |
| 5 | **点开链接，在飞书页面确认创建**（名称等还能改） | **人，必须** | [官方文档](https://open.feishu.cn/document/mcp_open_tools/scan-to-create-an-app-in-one-click.md)要求用户本人授权；带 `addons` 时还要在确认页再确认一次 |
| 6 | 拿到凭据并登记：校验、存加密密钥库、写配置和 bot 列表、启动子进程 | 机器 | `register-bot.ts:56-133`；`supervisor.ts:170-195`。要加一条校验：扫码人必须是发起私聊的那个人，做法同 `refresh-bot.ts:34` |
| 7 | 开权限 | 有 `addons` 灰度时由机器预填。没有时要**人点一次授权链接** | `config/scopes.ts:211-219`，一个链接一次勾全 |
| 8 | 订阅长连接事件（收消息、卡片回调、菜单点击），然后**发布版本** | 现在只能**人在开发者后台操作** | `cli/commands/bot.ts:18-22`；`onboarding.ts:204-205` 会检测出"未发布"状态。**可能的自动化**：SDK 里有改配置（`subscription_type` 可设为长连接）和发布版本的 v7 接口（types `:9829-9912`、`:9913-9940`）。这两个接口在 [llms 文档索引](https://open.feishu.cn/llms-docs/zh-CN/llms-app-information.txt)里找不到，需要的权限和是否开放**未知** |
| 9 | 企业租户：**管理员审核版本** | **企业租户下是人，必须** | 改基础信息、权限、能力或事件后要发新版本，"并且通过企业管理员的审核后才能生效"（[自建应用开发流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process.md)）。管理方可以用一个有 `application:application.app_version` 权限的同租户自建应用，调接口批准版本（[更新应用审核状态](https://open.feishu.cn/document/server-docs/application-v6/application/patch-2.md)）。个人租户是否等于"自己批"：**未查到官方说法** |
| 10 | 新 bot 进群 | 机器，有前提 | 已在群里的 bot 可以用 `member_id_type=app_id` 把新 bot 拉进来，前提见下表 |

第 10 步拉 bot 进群的前提：

| 方式 | 约束 | 依据 |
|---|---|---|
| 已在群里的 bot 拉新 bot | 每次最多 5 个，群里 bot 总数不超过 15 个。新 bot 必须开了机器人能力并已发布。调用方必须在群里。群若设成"仅群主和管理员可添加"，只有建群的 bot 带 `im:chat:operate_as_owner` 权限才能拉 | [拉人或机器人入群](https://open.feishu.cn/document/server-docs/group/chat-member/create.md) |
| 建群时直接带上 bot | 用 `bot_id_list`，同样每次最多 5 个、总数最多 15 个。建群的 bot 自动成为群主 | [创建群](https://open.feishu.cn/document/server-docs/group/chat/create.md) |
| bot 自己入群 | 只能进公开群，开了进群验证的群不行 | [主动入群](https://open.feishu.cn/document/server-docs/group/chat-member/me_join.md) |

SDK 类型里还有一个开关字段 `allow_invited_to_group_by_other_app_switch_open`（types `:9785`），看名字是"允许被其他应用拉进群"，具体含义未确认。

**参照：飞书官方 OpenClaw 插件（2026-03-05）也是同样的人工步骤。** 扫码"一键创建飞书机器人"之后，文章仍然让用户手动导入权限，再点"创建版本"和"确认发布"（[飞书官网文章](https://www.feishu.cn/content/article/7613711414611463386)）。官方自己目前也没把这几步做到零人工。

**让多个 bot 在群里互相对话，还需要：**
- 申请 `im:message.group_msg.include_bot:read`（收群里所有用户和其他 bot 的消息）或 `im:message.group_at_msg.include_bot:readonly`（收其他 bot @ 自己的消息）。消息里的发送者类型会是 `"user"` 或 `"bot"`（[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)）。
- 加一个防循环的保护：两个开了免 @ 的 bot 可能互相触发。这是推断，没有实测。

**"像人"在飞书这一侧能动的地方：**
- 名称、简介、头像：创建时预填；创建后可能能用 v7 改基础信息（types `:9800-9826`）；
- 机器人菜单：v7 能力接口里的 `bot_menus`（types `:9766`）；
- 斜杠命令：本机 `lark-cli application +slash-command-*`，每个应用最多 100 条（lark-cli 1.0.97 `--help` 输出）；
- 人设文字：代码里还没有这个功能。

## 3. 可分享的 bot 定义可以长什么样

现有字段可以分两类：

| 能放进可分享文件 | 绝不能放 |
|---|---|
| bot 的短名称（`bots.ts:11`） | appId、App Secret、租户（`schema.ts:17-21`）。凭据和租户绑定 |
| 卡片、运行、完成提醒、会话标题、评论用的后端和模型（`settings.ts:52-70`） | owner、管理员、白名单里的 open_id（`schema.ts:84-91`；`registry.ts:36-38`）。这些 ID 只在本租户有效 |
| 评论助手提示词 `comment-instructions.md` | 本机路径：项目目录、项目根目录（`registry.ts:16-17`；`schema.ts:96-98`） |
| 群模板：单会话或多话题、免 @、后端、默认模型和推理强度、自动压缩（`registry.ts:22-79`） | 群 ID、会话记录、本机 CLI 桥设置 |

建议的格式（推断，不是现有代码）。对齐飞书 manifest 的字段，SDK 注释说 `addons` 的字段名"align with the app manifest"（types `:312600-312603`）：

```json
{ "format": "vonvon.bot/1",
  "profile": { "name": "", "description": "", "avatarUrls": ["https://…"] },
  "persona": "markdown，追加到系统提示词",
  "defaults": { "provider": "codex", "model": null, "effort": null,
                "maxTier": "qa", "network": false, "response": "mention", "sessions": "threads" },
  "agent": { "cards": {}, "run": {}, "completion": {}, "titles": {} },
  "comments": { "instructions": "" },
  "feishu": { "addons": { "scopes": {}, "events": {}, "callbacks": {} } } }
```

**导入的安全底线（推断）：**
- 人设就是提示词，导入别人写的 bot 等于把别人的指令注入进来；
- 老项目没设权限档位时默认是 `full`（`registry.ts:89-91`）。所以导入时权限档位只能降不能升，`full` 必须本人另行确认；
- 带 skills 等于带可执行的指令和文件，第一版先不带。

作为对照，Grok Bot 的模板包含"Profile, description, skills, routines, and identity"，不包含"Conversation history, learned memories, chat attachments, and your computer or login credentials"，密钥要作者自己删（[oflight](https://www.oflight.co.jp/en/columns/grok-bot-marketplace-create-publish-guide-2026)，二手来源，2026-08 至 09）。

## 4. 分阶段路线

工期都是估计。按 `AGENTS.md`：Linux 上只跑定向测试，真实飞书验收在 Mac 上由 Codex 做，在飞产品 PR 最多两个。

**1 到 2 天能演示（在现有代码上，bridge 和 vonvon 都能做）**
1. 每个 bot 加一份 `persona.md`，追加到那段写死的提示词后面，改的是 Codex 和 Claude 两个后端各两处。读文件的方式照搬 `comment-instructions.md`。
2. 把写死的扫码预填 `APP_PRESET` 改成参数，名称、简介、头像都能传。
3. 导出导入：导出 = 第 3 节的 JSON。导入 = 拿 JSON 里的预填去扫码注册，再写入人设和设置。
   - v2：`vonvon` 要新增 `bot export/import` 子命令，走 daemon 的接口，因为 daemon 是唯一能写数据的进程（`architecture.md:47-51`、`:91`）；
   - bridge：直接扩展现有的 `bot init`。

   演示的局限：还是扫码，还是要手动订阅事件和发布版本。
4. 如果想尽快让用户用上东西，可以先发一个 bridge 小版本，包含上面三点。这要产品负责人拍板，因为 bridge 按计划只剩 V9 一个收尾版本（`roadmap.md:24`）。

**1 到 2 周**
- 私聊里的"造 bot"对话（第 2 节第 1 到 6 步），包括扫码人必须是发起人的校验和"新 bot 已上线"的卡片。
- 实测 `addons` 灰度，以及 v7 改配置、发布版本接口能不能用。能用的话，人工步骤压到"点链接确认"，企业租户再加管理员审核。
- 新 bot 自动进群：用现有 bot 拉，或建群时带上。
- 群里 bot 互相对话：申请 include_bot 权限、读上下文时保留 bot 消息、加防循环。
- 把人设接进新的 provider 层：给打开会话的参数加一个提示词字段，否则 V6b 删掉旧的 `agent/` 目录时人设会一起丢。

**大赌注**
- 市场：云端模板目录、作者身份、审核下架、版本、导入计数。云端包（V10、V11）还没落地，部署平台也没定（`roadmap.md:25-26`、`:125`）。
- 不管市场做得多顺，每次导入仍然要新建一个飞书应用，第 5 步的确认和企业租户的管理员审核绕不过去。所以"一键导入"的体验上限由飞书定。
- 飞书商店应用（ISV 分发）是另一条路，这次没调研。
- 另一个省事的思路（推断，未验证）：一个应用挂多个人设，用卡片标题区分。人工步骤少，但在飞书里看起来还是同一个头像、同一个名字，不太"像人"。

## 5. 和 v2 daemon 架构是复用还是冲突

**复用：**
- 每个 bot 一个目录：`bots.json` 加 `bots/<appId>/`（`architecture.md:141`）；
- 每个 bot 一个飞书长连接子进程（`architecture.md:33-34`）；
- 现成的 bot 注册任务和扫码阶段（`protocol/src/domain.ts:40`、`:131-140`）；
- 设置按 bot 分区（`architecture.md:227-231`），人设正好是新加的一个 bot 级设置段；
- 一个群里多个 bot 的数据结构；
- 每个 bot 只能在一台机器上运行的规则（`architecture.md:179`）。导入总是新建一个应用，所以不冲突。

**冲突或要改设计：**
1. **新 provider 合同。** 打开会话的参数只有 `{cwd, resume, model, effort}`（`provider/engines/engine.ts:54`），而 V6a 已经发布、冻结了这份合同（`plan.md:1293`）。人设要加字段，要走一次合同变更。
2. **协议形状。** 计划只批准了列出的那几处形状改动，其余都要回到设计（`plan.md:159`）。设计文档只能为还没开始的版本写，最多领先实现一个版本（`AGENTS.md`）。
3. **聊天入口。** 桌面端和网页"不聊天"（`architecture.md:9`），私聊控制台不跑 agent（`dm-console.ts:13`）。"聊天建 bot"要明确定成一种新入口。
4. **云端存什么。** 现在规定云端只存账号和机器两种记录，不存设置（`architecture.md:83-87`、`:238-253`）。市场的公开模板不含密钥，所以不违反"设置不上云"，但它是新的云端数据形状。
5. **进程成本。** 每个 bot 一个 Node 进程。"很多个人"会线性增加内存，具体数字没测。

## 未知，需要实测

- `addons` 灰度在你的账号上开没开。
- v7 的改基础信息、改配置、发布版本、上传头像接口需要什么权限，自建应用能不能改自己。
- 扫码创建的 PersonalAgent 应用在个人租户下是否免审核。
- 每个租户、每个用户能建多少个应用：官方文档没写。
- include_bot 消息在长连接下的真实表现。

Muse、Today.AI、AFK-SURF/comma 这次没有调研。

## Sources
- 本地代码：上文各处 `file:line`。
- SDK：`node_modules/@larksuiteoapi/node-sdk` 1.71.1（`types/index.d.ts`、`lib/index.js`、`README.zh.md`），2026-10-12 发布的 1.75.0 也看过。
- [一键创建应用（Python）](https://open.feishu.cn/document/mcp_open_tools/scan-to-create-an-app-in-one-click.md)，[一键创建应用（Java）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/create-an-app-in-one-click-java.md)
- [自建应用开发流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process.md)，[更新应用审核状态](https://open.feishu.cn/document/server-docs/application-v6/application/patch-2.md)，[应用信息文档索引](https://open.feishu.cn/llms-docs/zh-CN/llms-app-information.txt)
- [拉人或机器人入群](https://open.feishu.cn/document/server-docs/group/chat-member/create.md)，[创建群](https://open.feishu.cn/document/server-docs/group/chat/create.md)，[主动入群](https://open.feishu.cn/document/server-docs/group/chat-member/me_join.md)，[接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)
- [OpenClaw 飞书官方插件（2026-03-05）](https://www.feishu.cn/content/article/7613711414611463386)
- [Grok Bot 市场指南（二手来源）](https://www.oflight.co.jp/en/columns/grok-bot-marketplace-create-publish-guide-2026)


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：I checked 15 claims against the repo code and primary sources: 9 confirmed, 5 overstated, 1 wrong.

**Confirmed.** The code claims hold, file by file:
- The persona is a single hard-coded constant, at the same lines in the bridge.
- The installed SDK 1.71.1 has `addons` and application v7 APIs that patch base info and config and publish versions.
- The v2 CLI has no `bot` subcommand.
- The context filter drops bot messages, and no include_bot scope is requested.
- OpenSpec has no prompt field.
- The cloud stores only Account and Device records.
- Bridge 0.6.14 was released 2026-09-24, with 108 downloads in the week of 10-06 to 10-12.
- The Feishu group limits (5 per add, 15 per group, operate_as_owner) and the enterprise admin-review rule match the official docs.
- The no-@ behaviour is correct, though not for the reason the code comment gives: the SDK sets isBot only for the bot itself.

**Wrong (1).** The OpenClaw claim. The 2026-03-05 article's install flow has no manual permission import, event subscription or publish step; those appear only in its insufficient-permissions FAQ. So the report's 'even Feishu needs manual steps' is unsupported, and the code's assumption that events must be subscribed by hand may be outdated. This needs a real test.

**Overstated (5).**
- The gray-rollout requirement for `addons` comes only from an SDK code comment, not from the official docs the report also cites.
- In v2 the CLI can scan only the first bot, through `vonvon daemon run`; adding more bots is web-only.
- A primary xAI guide (2026-09-08) contradicts the secondhand Grok Bot template description: memories are included, and the guide says templates do not include secrets.
- The new provider design already carries the fixed instructions, but Cursor, Grok and custom ACP get none, so a persona could not reach those providers.
- The scan or link is the only programmatic route to create an app, not the only route.

**Product identities.** Grok Bot was the right product (xAI, beta since 2026-08-11). The report skipped Muse, Today.AI and comma, which are:
- **Muse:** Meta's personal agent, launched 2026-09-08.
- **Today:** todayai.cn.
- **Comma:** the GitHub repo AFK-surf/Comma, AGPL-3.0, created 2026-09-30, 257 stars, works with Codex and Claude Code.

**Gaps that matter most.**
- Grok Bot already does 'chat to create a bot' (its Dr. Eggbot listing).
- Grok Bot groups hold 2 to 6 bots, but they live inside xAI's own app and run on a cloud VM, not Feishu or the user's machine. That is Vonvon's differentiator.
- The 'Grok' coding provider already planned in Vonvon's roadmap (V7a) is Grok Build, a different product from Grok Bot.


### 逐条复查

- **属实**：There is no persona. Every bot gets the same hard-coded system-prompt constant, injected at codex-appserver/backend.ts:675/689 and claude-agent/backend.ts:362/378, and the bridge has the same code at the same line numbers.
  - 依据：packages/daemon/src/agent/bridge-instructions.ts:12 `export const BRIDGE_DEVELOPER_INSTRUCTIONS`. Injected at codex-appserver/backend.ts:675 and :689 (`developerInstructions`) and claude-agent/backend.ts:362 and :378 (`systemPromptAppend`). Lines and text are identical in /home/operator/vonvon/feishu-codex-bridge/src (same files and lines; wizard.ts:58-61 has the same APP_PRESET).
- **属实**：Code comments say Feishu has no API to declare scopes or subscribe events (scopes.ts:7, :193, wizard.ts:57). SDK 1.71.1 does have `addons` (only with a platform gray rollout) and application v7 APIs that patch base info (name, description, avatar), config (scopes, events with websocket, callbacks) and publish.
  - 依据：The comments are at scopes.ts:7, :192-193 and wizard.ts:57. The installed SDK is 1.71.1 (node_modules/@larksuiteoapi/node-sdk/package.json). Its types/index.d.ts:312600-312650 defines AppAddons, with the comment "Requires the platform gray-scale ... otherwise the whole param is ignored". `applicationBase.patch` (i18ns name/description, avatar_url) is at ~:9800-9826, `applicationConfig.patch` (add_scopes, event.subscription_type 'websocket', callback) at ~:9828-9912, `applicationPublish.create` at ~:9913-9940, and `bot_menus` and `allow_invited_to_group_by_other_app_switch_open` at ~:9766 and :9785. lib/index.js:95830 hard-codes archetype 'PersonalAgent'.
- **说过头了**：`addons` only works when the platform enables a gray rollout for the account. The report cites the SDK types and the official one-click-create (Java) doc for this.
  - 依据：SDK types/index.d.ts:312615-312616. Fetched https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/create-an-app-in-one-click-java.md and .../scan-to-create-an-app-in-one-click.md on 2026-10-14: no 灰度, no auto-publish, no admin-review text.
- **属实**：The v7 config and publish APIs do not appear in the public llms doc index, so their availability and required scopes are unknown.
  - 依据：Downloaded https://open.feishu.cn/llms-docs/zh-CN/llms-app-information.txt (15 KB). grep for v7, application.config, 发布应用 and 基础信息 finds only v6 entries (get.md, publish_apply event). A web search found no official v7 page.
- **说过头了**：Bots are added by QR scan, from both the web UI and the CLI. The v2 `vonvon` CLI does not register a `bot` subcommand, and cli/commands/bot.ts is orphaned.
  - 依据：packages/daemon/src/cli/index.ts registers only daemon, open, service, secrets (hidden), hook (hidden) and internal commands. grep finds no importer of runBotInit or runBotList. bot/onboarding.ts:113-121 contains the stale bridge command text. admin/service.ts:797-803 and server/jobs.ts:62-93 are the web path.
- **属实**：The latest bridge release is 0.6.14, published 2026-09-24, with 108 downloads in the week 10-06 to 10-12.
  - 依据：registry.npmjs.org/@modelzen/feishu-codex-bridge: dist-tags.latest = 0.6.14, time['0.6.14'] = 2026-09-24T14:12:37Z. api.npmjs.org/downloads/point/last-week returns {downloads:108, start:2026-10-06, end:2026-10-12}. Local release commit 6698118 is dated 2026-09-24. Downloads are not users.
- **属实**：A bot with no-@ mode on still stays silent when a message @-mentions another bot.
  - 依据：handle-message.ts:1199 returns false when `msg.mentions.some((m) => !m.isBot)`. In the SDK, isBot is true only for THIS bot (`openId === botOpenId`, node-sdk lib/index.js:98305), so @-ing a different bot counts as not-isBot and the bot stays quiet. The code comment at handle-message.ts:1195 says '(非机器人)用户', which is misleading. Behavior matches the report.
- **属实**：Bots cannot see each other's messages: the include_bot scopes are not requested, and context-weave drops bot messages. The needed scopes are im:message.group_msg.include_bot:read and im:message.group_at_msg.include_bot:readonly, and sender_type is user or bot.
  - 依据：config/scopes.ts:18-38 REQUIRED_SCOPES has no include_bot (grep for include_bot or group_bot_msg in src finds nothing). bot/context-weave.ts:125 filters `m.fromUser`, and :165 sets `fromUser = sender_type === 'user'`. https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md lists both include_bot scopes and a third, im:message.group_bot_msg:readonly, which the report missed.
- **属实**：Group limits: at most 5 bots per add and 15 bots per group. The bot must have bot capability and be published, and the caller must be in the group. Owner/admin-only groups need the group-creating bot to hold im:chat:operate_as_owner. With bot_id_list on create, the creating bot becomes owner.
  - 依据：https://open.feishu.cn/document/server-docs/group/chat-member/create.md ('最多同时邀请 5 个机器人', '不能超过 15 个', operate_as_owner text, app_id for bots). https://open.feishu.cn/document/server-docs/group/chat/create.md ('不填时指定建群的机器人为群主', bot_id_list max 5).
- **有误**：Reference: the official OpenClaw Feishu plugin (2026-03-05) still makes users import permissions by hand, then click 创建版本 and 确认发布 after the one-click scan, so even Feishu has not reached zero manual steps.
  - 依据：https://www.feishu.cn/content/article/7613711414611463386 (fetched 2026-10-14). The install-section quote is '验证是否安装成功：在飞书对话中发送 /feishu start'. The manual steps sit under '如果在使用插件时出现权限不足…'.
- **说过头了**：Grok Bot templates include 'Profile, description, skills, routines, and identity' and exclude conversation history, learned memories, attachments and credentials, and authors must strip secrets themselves (oflight, secondary).
  - 依据：https://x.ai/bot/guides/templates-for-grok-bot (dated Sep 8, 2026). Secondary sources conflict among themselves (oflight vs basenor).
- **属实**：Enterprise tenants need admin review of each new version. A same-tenant app with application:application.app_version can approve versions by API. There is no official statement on personal tenants.
  - 依据：https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process.md ('…都需要发布新的应用版本，并且通过企业管理员的审核后才能生效'). The same page says a self-created test enterprise gives '权限免审', which the report missed. https://open.feishu.cn/document/server-docs/application-v6/application/patch-2.md: PATCH app_versions, status 1 = approved, scope application:application.app_version, custom apps in the same enterprise.
- **说过头了**：OpenSpec has only {cwd, resume, model, effort}, so a persona needs a contract change, or it is lost when V6b deletes agent/.
  - 依据：packages/daemon/src/provider/engines/engine.ts:54; docs/providers.md:622, :840; docs/plan.md:1293 (F6 published when 6d merges); git log shows 02d4732 (#272, V6a 6d); docs/plan.md:159 lists the approved shape changes.
- **属实**：The cloud stores only two record types (Account, Device), and settings and the bot list stay on the daemon. The private-chat console never runs an agent.
  - 依据：docs/architecture.md:83-87 (设置只存在 daemon 上，云端不存), :238-253 (Account and Device types), :9 (desktop and web 不聊天). bot/dm-console.ts:13 ('The console never runs codex').
- **说过头了**：The only way to create an app is the QR scan or a registration link opened in Feishu.
  - 依据：config/scopes.ts:9-11 (developer-console 'apply scope' page); cli/commands/bot.ts:18 (https://open.feishu.cn/app).

### 正文遗漏的事实

- Muse is Meta's personal agent, launched 2026-09-08. It is US-only for adults 18+, works as a standalone app and inside WhatsApp, and acts for the user (email, travel booking, forms, purchases) from a Muse Secure VM, with approval required for sensitive actions. Sources: https://www.pbs.org/newshour/nation/meta-launches-personal-ai-agent-muse-to-help-with-everyday-tasks (2026-09-08), https://www.techrepublic.com/article/news-meta-muse-ai-agent-us-launch/. Pricing tiers ($20/$100) are reported only by secondary sources and unconfirmed.
- Today.AI is 'Today' at https://todayai.cn, tagline 「懂你所想，为你先行的个人 AI 助理」. It is proactive (a Today view with next steps), has memory, tasks, connectors, a cloud computer and community Skills, a free basic tier, and 100M tokens plus one month of Pro for new users. The founder is reportedly Qi Junyuan (ex-ByteDance, Teambition co-founder), from secondary source hub.baai.ac.cn/view/58389, which was unreachable for verification. The page names no Feishu or WeChat integration.
- AFK-SURF/comma is https://github.com/AFK-surf/Comma (homepage comma.surf). GitHub API on 2026-10-14: created 2026-09-30, last push 2026-10-03, 257 stars, 17 forks, Elixir, AGPL-3.0. Description: 'Always-on, proactive, sessionless... Compatible with ChatGPT/codex and claude code. Selfhost your open source alternative to Muse, Dots, Instinct and Town.' It is the closest open-source analog to the owner's idea, since it also drives Codex and Claude Code. The license is AGPL, so do not copy code.
- Grok Bot identity: xAI's Grok Bot, early beta 2026-08-11, open to SuperGrok Heavy, Cursor Ultra and Cursor Teams Premium on desktop and iOS. Each account runs on its own cloud Linux VM, not the user's laptop, and has 220 plugins (https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/, 2026-08-12). xAI describes a bot as 'an agent with its own computer'.
- Grok Bot already has the 'create a bot by chatting' idea: the official 'Dr. Eggbot' listing reads 'Designs a tight Grok Bot for one job, then creates it' (https://x.ai/bot/guides/getting-started).
- Grok Bot group chats run inside xAI's own app, not Slack or Feishu: 'select two to six Bots', @ one bot or @everyone, and 'Bots can post into the group and pass work among themselves' (https://docs.x.ai/grok-bot/chat-and-collaboration). This is the direct comparison for 'bots join groups' and shows Vonvon's difference: real Feishu groups and the user's own machine and agents.
- No Grok Bot CLI was found. xAI's CLI is Grok Build (https://docs.x.ai/build/cli/reference), a separate coding product. Vonvon's roadmap V7a already plans 'Grok' as an ACP coding provider (docs/roadmap.md:20; providers.md:840). That is Grok Build, not Grok Bot, and the report does not warn against conflating them.
- Marketplace traction figures (69 bots, 43 creators, 9 categories as of 2026-09-09) appear only in secondary sources and are unverified. The marketplace and template launch is dated 2026-08-28 by secondary reports (blockchain.news cites an X relay, not xAI).
- There is a third bot-message scope, im:message.group_bot_msg:readonly ('获取群组中其他机器人发送的消息'), listed in the receive-message doc.
- The OpenClaw install flow suggests the platform base template for one-click PersonalAgent apps may already include message events and publishing. If true, steps 7-8 shrink without the v7 APIs. Test this before building on the v7 config/publish APIs.
- The Feishu self-built app doc says creating a new test enterprise gives permission 免审. This matters for the personal-tenant 'self-approve' question.
- SDK dates: 1.71.1 was published 2026-07-14 and 1.75.0 on 2026-10-12 (registry.npmjs.org). The repo is three minor versions behind, and newer SDKs may add or document these APIs.
- The persona design should account for providers.md:840: Cursor, Grok and custom ACP get no Vonvon instructions. The 'bots feel like people' principle therefore depends on the provider unless another delivery channel is designed.
- Product framing gap: every named competitor (Muse, Today, Grok Bot, Comma) is a proactive, always-on personal agent with its own cloud computer, memory and routines. None is a Feishu-group coding bridge. The report does not judge which of the owner's ideas these products validate versus which are Vonvon's own niche.
