# 机器人市场和“跟机器人聊天来创建机器人”：先例、格式、安全模型和最小可行版本

调研日期 2026-10-14。2026 年的不少事实没有一手来源，只找到二手报道，已逐条标注。

## 结论

1. **“Grok Bot + 机器人市场”是真实存在的产品。** xAI 在 2026-08-11 发布 Grok Bot（[reworked](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)）。分享出去的是模板：对方添加时得到一份副本，拿不到原主人的电脑、登录状态和历史记录（[docs.x.ai](https://docs.x.ai/grok-bot/bots)）。官方市场目前约 39 个模板，作者是点名邀请的知名创作者，页面不显示安装数（[x.ai/bot/marketplace](https://x.ai/bot/marketplace)）。
2. **第一个大型“机器人商店”正在关闭。** OpenAI 在 2026-09-11 宣布退役自定义 GPT，计划 2026-12-11 停用，迁移到插件（插件由 skills 和 MCP 组成）。迁移时 instructions 变成一个 skill；模型选择、Actions、对话记录和分享设置都不迁移（[Virtualization Review](https://virtualizationreview.com/articles/2026/09/28/openai-to-retire-custom-gpts-replace-them-with-plugins.aspx)）。扣子 2.0（2026-01）也把重心放到了 Agent Skills（[aibase](https://news.aibase.com/zh/news/24737)）。行业在 2026 年的方向是“可移植的能力包加一层薄薄的人设”，不再是“人设加提示词的商店”。
3. **格式已经收敛，Vonvon 不需要自造。** SKILL.md 是开放标准，Claude Code、Codex、Cursor、OpenClaw、TRAE 等都支持（[agentskills.io](https://agentskills.io/home)）。AGENTS.md 已被 6 万多个项目采用，由 Linux 基金会旗下的 Agentic AI Foundation 托管（[agents.md](https://agents.md/)）。plugin.json 有跨厂商规范 Agent Plugins 1.0，技术指导委员会成员来自 Amazon、Cursor、Microsoft、OpenAI、Vercel（[agent-plugins.org](https://agent-plugins.org/)）。
4. **开放发布加本机 agent，几周内就会招来恶意软件。** Koi 审计了 ClawHub 上的 2,857 个 skill，其中 341 个是恶意的（[eSecurity Planet，2026-02-03](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub)）。Snyk 扫描 3,984 个 skill，36.82% 至少有一个安全问题（[Snyk，2026-02-05](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub)）。导入别人的 bot，第一版只能允许纯文本。
5. **最便宜的需求测试不需要先建市场。** 一个 bot 就是 git 仓库里的一个文件夹，用 URL 导入。agency-agents 这个“带人格的 agent 文件”仓库源自一个 Reddit 帖子，现在有 159,949 star，桌面 app 是后来才做的（GitHub API，2026-10-14 查询）。
6. **飞书里“聊天创建 bot”的底层能力已经在代码里。** `registerApp` 扫码可以创建 PersonalAgent 应用，并预填名称、描述和头像（`packages/daemon/src/bot/wizard.ts:12`、`:56-58`）。但权限只能在开发者后台点一次授权，无法预填（`packages/daemon/src/config/scopes.ts:7-12`）。

## 0. 两条直接相关的背景

- **竞品。** 飞书官网在 2026-06-04 发布了 Lark Coding Agent Bridge 的教程，模式同样是“一个群对应一个项目，一个话题对应一个会话”（[feishu.cn](https://www.feishu.cn/content/article/7647408304896953549)）。它的 npm 包 `lark-channel-bridge` 在 2026-10-06 到 10-12 这周下载 902 次；同一周 `@modelzen/feishu-codex-bridge` 是 108 次，近 30 天共 1,106 次（npm API）。GitHub star 分别是 2,692 和 81。教程里没有提人格、bot 分享或市场。
- **bridge 的版本。** 最后一个版本是 0.6.14，发布于 2026-09-24（npm registry 时间戳）。

## 1. 先例和结果

| 先例 | 做了什么 | 结果和数据 |
|---|---|---|
| OpenAI GPT Store | 2024-01 上线，两个月内用户建了约 300 万个 GPT（[TechCrunch 2024-03](https://techcrunch.com/?p=2679465)）。承诺 2024 年第一季度按用户参与度给美国创作者分成（[VentureBeat](https://venturebeat.com/ai/openai-launches-gpt-store-but-revenue-sharing-is-still-to-come)）。 | 2024 年 1 月自定义 GPT 占 chat.openai.com 流量 2.7%，周访问量从 1,200 万降到 640 万（[Similarweb](https://www.similarweb.com/blog/insights/ai-news/chatgpt-custom-gpts/)）；2 月仅占 1.5%（[itc.ua 转引 FT](https://itc.ua/en/news/gpt-store-deflated-in-february-customized-chatbots-accounted-for-1-5-of-visits-to-the-chatgpt-website)）。商店里充斥垃圾和侵权 GPT（[OECD 事件库](https://oecd.ai/en/incidents/2024-03-20-709c)）。分成计划没有找到官方的最终结果；有用户在 2025-09 说分成不再扩大，这不是官方说法（[社区帖](https://community.openai.com/t/guidance-for-gpt-store-builders-outside-the-us/1357911)）。2026-09 宣布退役；迁移后有人抱怨 skill 在后续轮次里“不能保持权威”（[社区帖 2026-09-23](https://community.openai.com/t/custom-gpt-plugin-is-not-an-equivalent-migration/1400008)）。 |
| Poe | 2023-10 起，每个订阅拿出 $10/月或 $20/年分给带来转化的创作者，每个订阅用户最多付 $20，只对美国开放；当时月活约 122 万（[TechCrunch](https://techcrunch.com/2023/10/31/quoras-poe-introduces-an-ai-chatbot-creator-economy/)）。2024-04 加了按消息定价（[Poe blog](https://poe.com/blog/new-on-poe-creator-monetization-via-price-per-message)）。满 $10 才能提现（[FAQ](https://help.poe.com/hc/en-us/articles/21921312368020-Poe-Creator-Monetization-FAQs)）。 | **未知。** 没有找到累计或 2025 年的创作者收入数据。 |
| Character.ai | 用户创作角色，2025-08 上线 Feed 信息流（[etcentric](https://www.etcentric.org/tag/karandeep-anand/)）。 | 角色本身就是内容；月活约 2,000 万，但各来源给出的时间不一致（[sacra](https://sacra.com/c/character-ai/)）。2025-10 因诉讼和监管压力，停止 18 岁以下用户的开放式聊天（[Fortune](https://fortune.com/2025/10/29/character-ai-ban-children-teens-chatbots-regulatory-pressure-age-verification-online-harms)）。没有找到官方的创作者分成。 |
| Telegram BotFather | 2015-06-24 发布：跟 @BotFather 聊天，用 `/newbot` 拿到 token（[telegram.org](https://telegram.org/blog/bot-revolution)）。bot 在群里默认开 Privacy Mode，只能看到与自己相关的消息（[core.telegram.org](https://core.telegram.org/bots/features)）。 | 2026-04-03 的 Bot API 9.6 加入 Managed Bots：bot 可以通过 `t.me/newbot` 链接请求创建子 bot，并能获取或替换子 bot 的 token（[changelog](https://core.telegram.org/bots/api-changelog)）。“超过 1000 万个 bot”只有二手来源，而且官方没有 bot 商店，只有 Mini App 精选区（[messengerbot.app](https://messengerbot.app/?p=262283)）。 |
| Discord App Directory | 2022-10 上线，同时设了 $500 万开发者基金；付费订阅只给少数受邀开发者测试（[TechCrunch](https://techcrunch.com/2022/10/17/discord-bots-app-directory-activities/)、[GamesBeat](https://gamesbeat.com/?p=215186)）。 | 2026 年起，特权数据的审核门槛改为“可触达 1 万用户”，并且每年要重新申请（[Discord docs](https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review)）。没有找到目录的使用数据。 |
| 扣子/Coze | 一键发布到飞书、豆包、微信公众号等渠道（[CSDN，可信度低](https://adg.csdn.net/696f2b40437a6b4033698f0b.html)）；模板库可以一键复制（[aibase](https://news.aibase.com/zh/news/12277)）。2.0 版于 2026-01 发布，核心是 Agent Skills（[aibase](https://news.aibase.com/zh/news/24737)）。技能商店可上传 `.zip` 或 `.skill` 文件，收费技能要先开通商户（[少数派，转引自搜索摘要](https://sspai.com/post/105632)）。Coze Studio 以 Apache-2.0 开源，21,708 star。 | 没有找到官方的商店规模或收益数据。征集活动收到“近千份作品”（[人人都是产品经理](https://www.woshipm.com/?p=6361844)）。 |
| 飞书 aily | 2026-07-23：团队共享智能体可以设定角色和资料后加入项目群；管理员能看到每个智能体的来源、负责人和启用状态，并配置使用范围；飞书预置了上百个 Agent，并支持接入第三方本地 Agent（[新华网](https://www.news.cn/tech/20260723/5a84c09560134a5c9937a825773fba95/c.html)）。 | 没有找到公开的智能体市场，走的是企业管理员治理路线。 |
| Claude Code 插件 | 插件市场就是 git 仓库里的一份 `marketplace.json`，用 `/plugin marketplace add owner/repo` 添加（[docs](https://code.claude.com/docs/en/plugin-marketplaces)）。分官方、社区、第三方三层；社区目录的条目几乎都钉在某个 commit SHA 上；第三方市场默认不自动更新（[security](https://code.claude.com/docs/en/plugins/security)、[install](https://code.claude.com/docs/en/plugins/install)）。 | 文档原话：插件“can execute arbitrary code on your machine with your user privileges”（能以你的用户权限在本机执行任意代码）。网页目录显示安装数，并给部分插件标“Anthropic verified”（[docs](https://code.claude.com/docs/en/plugins/anthropic-marketplaces)）。 |
| Codex / ChatGPT 插件 | ChatGPT 和 Codex 共用一个插件目录；插件里的 hooks 要用户审阅并信任后才会运行；公开提交要求远程 HTTPS 的 MCP 服务，带 hooks 的插件进不了公开目录（[developers.openai.com](https://developers.openai.com/plugins/build/plugins)）。 | 没有找到公开数据。 |
| Grok Build 插件（2026-06-11） | 任何人都可以向 `xai-org/plugin-marketplace` 提 PR；安装时校验钉住的 commit SHA（[x.ai](https://x.ai/news/grok-plugin-marketplace)）。 | 首发 6 个合作方插件。 |
| Grok Bot（2026-08-11） | 每个账号一台云端 Linux 机器，账号下所有 bot 共用这台机器和上面的登录状态，被形容为“a real blast radius”（[reworked](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)）。已有的 bot 可以建议或直接创建一个专门的新 bot（[docs](https://docs.x.ai/grok-bot/bots)）；但第一个 bot 是填表创建的（名称、职责、工作方式），不是聊天创建（[get-started](https://docs.x.ai/grok-bot/get-started)）。2026-09-28 推出 Team Bots，可以进 Slack 频道（[releasebot](https://releasebot.io/updates/xai)）。 | 第三方 wiki 说 2026-09-29 的版本在 app 内移除了精选 bot，模板只留在网页上（[grokbotwiki，未核实](https://www.grokbotwiki.com/guides/grok-bot-marketplace-templates)）。 |
| OpenClaw / ClawHub | 发布要求 GitHub 账号够老（具体年龄未公开），有举报和自动扫描（[docs](https://docs.openclaw.ai/clawhub.md)）。2026-02 接入 VirusTotal 扫描（[openclaw.ai](https://openclaw.ai/blog/virustotal-partnership)）。 | 341/2,857 恶意（见上）。Unit 42 在 2026 年 2 到 5 月仍发现能躲过扫描的 skill，例如用 22MB 字符把 README 撑大，超出扫描器的大小上限（[Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/)）。openclaw 仓库 391,934 star。 |
| GitHub 分发和 skills.sh | skills.sh 于 2026-01-20 上线，安装命令 `npx skills add`（[Vercel](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)）。没有提交和审核环节，按安装量排名（[rywalker](https://rywalker.com/research/skills-sh)）。 | star 数：prompts.chat 172,890，anthropics/skills 180,980，obra/superpowers 298,782，agency-agents 159,949（GitHub API）。按安装量排名可以刷，Trail of Bits 也绕过了它的恶意 skill 检测（[rywalker](https://rywalker.com/research/skills-sh)）。 |

### 市场成败的五个因素

- **发现。** 寄生在通用助手里的商店，发现效率很低：GPT 只占 1.5% 到 2.7% 的流量。能起量的分发都走链接和已有渠道：Telegram 的用户名，扣子发布到飞书和微信，GitHub README 里的一行安装命令，Grok Bot 的分享链接。按安装量排名会被刷（skills.sh）。
- **冷启动。** 难点不在“有没有人创作”：GPT 两个月就有约 300 万个，ClawHub 增长也很快。难点在“有没有值得装的”。Grok Bot 用约 39 个点名创作者的模板起步；agency-agents 先由一个作者把一套整理好，app 后补。
- **质量。** 聊天创建和零门槛发布带来的是数量而不是质量，GPT Store 的垃圾和侵权就是例子。只有“人设加指令”的 bot 很容易被基础产品吞掉：OpenAI 最后把它降级成了插件里的一个 skill。这一段是推断，依据是上面 GPT 的结局。
- **变现。** GPT 的分成没有广泛兑现；Poe 的机制是真的，但没有结果数据；扣子的收费技能要开商户。Vonvon 的用户用自己的 Codex 或 Claude 订阅，平台没有一笔收入可以分给创作者。所以 MVP 不做变现。这一段是推断。
- **安全。** ClawHub 的问题来自三者叠加：开放发布、可执行的说明、本机 agent 的权限。Character.ai 说明“更像人”的陪伴类 bot 会带来未成年人和法律责任。Claude、Codex 和 Grok 都用了同一组办法：分层市场、钉住 SHA、信任提示、hooks 默认不运行。

### “跟机器人聊天来创建机器人”的先例

| 先例 | 通过对话得到什么 | 仍需人手做什么 |
|---|---|---|
| BotFather（2015） | 身份和 token | 无 |
| Telegram Managed Bots（2026-04） | 父 bot 用 `t.me/newbot` 链接请求创建子 bot，并管理子 bot 的 token（[changelog](https://core.telegram.org/bots/api-changelog)） | 用户确认 |
| GPT Builder（2023-11） | 对话生成 instructions，并选择网页搜索、画图等能力（[OpenAI](https://openai.com/blog/introducing-gpts)） | 无 |
| OpenClaw 首次启动 | 首轮对话问名字、气质、四选一头像，写入 `IDENTITY.md` 和 `SOUL.md`，然后删除 `BOOTSTRAP.md`，保证只跑一次（[docs](https://docs.openclaw.ai/start/bootstrapping)） | 无 |
| 扣子编程（2026-01） | 用对话构建智能体、工作流和网站，一键部署（[aibase](https://news.aibase.com/zh/news/24737)） | 无 |
| 飞书（Vonvon 当前代码） | 扫码后创建 PersonalAgent 应用，可以预填名称、描述和头像（`wizard.ts:56-58`） | 头像要一个公网图片 URL（`wizard.ts:58`）；权限要去后台点一次（`scopes.ts:7-12`） |

在飞书里，“聊天创建 bot”的现实形态是：聊天 → 二维码卡片 → 点一次权限授权。也就是一段对话加两次人手点击。

## 2. 可分享的 bot 制品应该包含什么

### 现有格式对照

| 格式 | 人设和指令 | 模型/provider | 技能和工具 | 权限 | 头像 | 记忆 |
|---|---|---|---|---|---|---|
| GPT | instructions、知识文件 | 迁移时被丢掉 | Actions（不迁移）、connected apps | 无 | 有 | 不迁移对话（[VR](https://virtualizationreview.com/articles/2026/09/28/openai-to-retire-custom-gpts-replace-them-with-plugins.aspx)） |
| Grok Bot 模板 | 名称、描述、instructions | 文档没提 | skills、routines、部分插件（需重新授权）；不带 MCP、脚本和自定义代码 | 不带登录状态 | 有 | 带“相关记忆”，个人记忆默认不带（[wiki，未核实](https://www.grokbotwiki.com/guides/grok-bot-marketplace-templates)）；复制 bot 时不带记忆（[docs](https://docs.x.ai/grok-bot/bots)） |
| OpenClaw 工作区 | `SOUL.md`（人设、语气、边界）、`IDENTITY.md`、`AGENTS.md`、`USER.md` | 配置里 | `skills/` | `AGENTS.md` 里的工具一节只是指导，不控制权限 | `avatars/` | `MEMORY.md` 只在主私聊会话里加载，不进群聊（[docs](https://docs.openclaw.ai/concepts/agent-workspace)）；onlycrabs.ai 分享的 soul 只含 `SOUL.md`（[README 镜像](https://cnb.cool/openclaw_ai/clawhub/-/blob/main/README.md)） |
| Claude 子代理 `.md` | 正文和 `description` | `model`、`effort` | `tools`、`disallowedTools`、`skills`、`mcpServers`、`hooks` | `permissionMode` | `color` | `memory: user/project/local`（[docs](https://code.claude.com/docs/en/sub-agents)） |
| Codex agent TOML | `developer_instructions` | `model`、`model_reasoning_effort` | `mcp_servers`、`skills.config` | `sandbox_mode` | `nickname_candidates` | 无（[docs](https://developers.openai.com/codex/subagents.md)） |
| SKILL.md | 正文 | `compatibility` | `scripts/`、`references/` | `allowed-tools`（实验性） | 无 | 无（[spec](https://agentskills.io/specification)） |
| Agent Plugins 1.0 | 无 | 无 | `skills/`、`mcp.json` | 厂商扩展目录 | `assets/` | 无（[agent-plugins.org](https://agent-plugins.org/)） |
| A2A AgentCard 1.0 | name、description | 无 | `skills[]` | `securitySchemes` | `iconUrl` | 无；放在 `/.well-known/agent-card.json`，可用 JWS 签名（[spec](https://a2a-protocol.org/latest/specification/)） |
| Character Card V2 | `description`、`personality`、`first_mes`、`system_prompt`、`character_book` | 无 | 无 | 无 | PNG 本身，JSON 存在 PNG 的 tEXt 块 `chara` 里 | lorebook（[spec](https://github.com/malfoyslastname/character-card-spec-v2)） |
| 扣子 | 模板一键复制；技能用 zip 或 `.skill` 上传 | — | — | — | — | **导出格式未知**，没有找到官方说明 |

A2A 是给远程服务互相调用用的，不适合一个在你本机运行的 bot。人格卡（Character Card）说明了一件事：“一个文件就是一个 bot，头像就是这个文件本身”，这种形式能在社区里自发流通。

### Vonvon bot 制品建议（v0）

只用现有标准，Vonvon 自己的部分只有一层很薄的清单：

```
bots/<slug>/
  bot.yaml        # schema: vonvon.bot/v0, name, description, version, author, license
  SOUL.md         # 人设和语气（让 Vonvon bot 更像人）
  AGENTS.md       # 职责和规则
  avatar.png
  skills/<name>/SKILL.md   # v0 只允许纯文本
```

`bot.yaml` 只放这些内容：

- `providers`：如 `[codex, claude]`，只是提示，不强制。GPT 迁移时就丢掉了模型字段。
- `requests`：申请的权限，`mode` 为 `qa`、`write` 或 `full`，加上 `readScope` 和 `network`。这些对应已有的 `Project` 字段（`docs/architecture.md:210-212`）。最终取导入方本地设置和申请值中更严的那个。
- `group`：`response` 为 `mention` 或 `all`，`sessions` 为 `threads` 或 `shared`（`docs/architecture.md:213-214`）。
- `memory: none`。

**绝不进包的东西：** 飞书 appId 和 App Secret（`docs/architecture.md:87`）、open_id、chat_id、cwd、会话、记忆、token。

还有一个设计点要提前定。现有代码会把指令同步写成目录里的 `AGENTS.md` 和 `CLAUDE.md`（`packages/daemon/src/bot/comments.ts:306-315`），bot 级的提示词放在 `comment-instructions.md`（`packages/daemon/src/config/schema.ts:125`）。导入的人设不应该写进用户仓库：那会覆盖用户自己的 AGENTS.md，而且会以项目指令的权威被 agent 读取。应该走 provider 的 developer instructions 通道注入。这一条是推断，需要设计确认。

## 3. 导入别人的 bot、用自己的 coding agent 在本机运行：安全模型

攻击者有两种位置。一种是 bot 作者，属于供应链攻击。另一种是群成员和外部内容，属于间接注入。

| 威胁 | 证据 | v0 控制 |
|---|---|---|
| 脚本、hooks、MCP 在本机直接执行 | Claude 插件能以用户权限运行任意代码（[docs](https://code.claude.com/docs/en/plugins/security)）；带脚本的 skill 有漏洞的概率是纯文本 skill 的 2.12 倍（[arXiv 2601.10338](https://arxiv.org/abs/2601.10338)） | 只收 `.md`、`.yaml` 和图片；拒绝 `scripts/`、`bin/`、hooks、`mcp.json` 和符号链接 |
| 用“先决条件”诱导执行命令 | ClawHavoc 用假的安装前提，引导用户执行 glot.io 上的命令或下载带密码的 ZIP（[eSecurity Planet](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub)） | 静态检查 `curl \| bash`、base64、粘贴站链接等模式，命中就拒绝 |
| 审核后运行时再拉远程指令 | Snyk 发现 17.7% 的 skill 会抓取第三方内容（[Snyk](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub)）；Anthropic 文档专门警告外部来源（[docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)） | 禁止运行时取指令；钉住 commit SHA（Grok Build 和 Claude 社区目录都这样做） |
| 更新时被替换内容 | Claude Code 对第三方市场默认关闭自动更新（[docs](https://code.claude.com/docs/en/plugins/install)） | 不自动更新；用 `update` 命令显示差异，由主人确认 |
| 用超大文件躲过扫描 | 22MB 的 README（[Unit 42](https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/)） | 对单个文件和整包设硬上限，超限拒绝而不是跳过 |
| 改写人设或记忆实现持久化 | Snyk 记录到恶意 skill 改写 `SOUL.md` 和 `MEMORY.md` | 人设文件对 agent 只读，修改要主人在私聊确认 |
| 泄露密钥 | ClawHub 上 10.9% 的 skill 有硬编码密钥（Snyk）；Codex 插件清单不接受 `clientSecret`（[docs](https://developers.openai.com/plugins/build/plugins)） | 导出时扫描密钥；导入方自己扫码创建飞书应用 |
| 权限过大 | Grok Bot 的个人规则“只能更严”（[security](https://docs.x.ai/grok-bot/security)） | 实际权限取申请值和本地 `Project` 设置中更严的那个；`write` 和 `full` 继续走已有的审批（`packages/daemon/src/config/schema.ts:483-485`） |
| 群成员注入 | 外部内容应作为不可信数据交给模型（Grok security，同上） | 默认 `response: mention`；人设不能要求“服从群里任何人” |
| 共享机器的爆炸半径 | Grok Bot 所有 bot 共用一台机器和登录状态（[reworked](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)） | 导入的 bot 默认 `readScope: project`、`network: false` |
| 导入前看不清内容 | Claude 的“Will install”面板；Grok 在 x.ai 上的预览 | 导入前用私聊卡片完整展示全文，以及申请权限和本地上限的对比 |

扫描是兜底，不是保证。ClawHub 接入 VirusTotal 之后仍漏掉了 5 个恶意 skill（Unit 42）。

## 4. 测需求的最小可行版本

**A. 分享和导入（不做市场）**

1. `vonvon bot export <appId>` 把一个 bot 导出成上面的文件夹，并去掉所有 ID 和密钥。
2. `vonvon bot import github:owner/repo/bots/x@ref`，或者把 URL 发给管理 bot。流程是：拉取并钉住 SHA → 校验 → 私聊卡片预览 → `registerApp` 二维码，预填名称和描述 → 权限授权链接 → 选群和项目。
3. 头像是否能用 `raw.githubusercontent.com` 的地址满足“公网图片 URL”的要求，**需要实测**。

**B. 聊天创建**

在私聊里对管理 bot 说“帮我做一个……”。agent 跑一个类似 OpenClaw 首次启动的访谈 skill（问名字、职责、气质、头像、规则），在本地生成同样的文件夹，然后走 A 的导入流程。聊天创建和导入共用一条管线：聊天只负责产出文件夹。

**C. 发现**

- GitHub topic `vonvon-bot`，加一个种子仓库，由主人先放 5 到 10 个“更像人”的工作型 bot（参考 Grok 模板和 agency-agents 的起步方式）。
- 种子仓库里放一份 `marketplace.json`，形状参照 Claude 和 Codex 的目录文件，以后要做界面时可以直接读。

**MVP 不做：** 市场界面、评分、付费、可执行 skill、MCP、hooks、自动更新、云端托管、A2A。

**衡量方式（建议，阈值由主人定）：**

- 种子仓库的 star、fork 和访问量（GitHub 自带）。
- 外部用户贡献 bot 的 PR 数。
- 本机统计每个 bot 的导入次数，以及导入 7 天后是否还启用。不默认上报；如果要上报，做成显式开启。
- 每个用户建了几个 bot。“一个人建第二个 bot”是“bot 要像人、要多个”这个假设最直接的信号。

**在哪里先上线（选项，属于推断）：** v2 还没有用户。bridge 每周约 108 次下载，并且已经有 `registerApp` 和每个 bot 的指令文件。A 的大部分逻辑在两边是同一份代码，在现有用户身上验证最快。按 `AGENTS.md`，两者是独立产品，在哪边先上由主人决定。

## 未知和未核实

- 没有找到 GPT 创作者分成、Poe 创作者收入、扣子商店规模、ClawHub 下载量、Grok Bot 模板安装数的官方数据。
- 扣子的智能体导出格式未知。
- 飞书 aily 是否有公开市场：没有找到。
- “Grok 在 app 内移除精选 bot”只来自第三方 wiki。
- Telegram 的 bot 总数只有二手来源。
- OpenAI 帮助中心页面返回 403，GPT 退役的日期来自二手转述，不同来源给出的创建截止日不一致：9/25 和 10/26。
- 预填头像能否用 GitHub raw URL、Feishu 的 PersonalAgent 应用能否用 API 更换头像，都需要实测。


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：报告的外部事实大部分站得住：Grok Bot 的身份、发布日期、模板副本模型和'bot 创建 bot'，GPT 退役的时间线，ClawHub 和 Snyk 的数字，agency-agents 的起源，npm 下载量和 star，Telegram 和 Grok Build 的细节，都能在一手页面或 API 上核实。但有四类问题。（1）主人点名的 Muse、Today.AI 和 comma 完全没有被识别。其中 Today.AI 是前飞书产品负责人做的、已经接入飞书的个人助理，与 Vonvon 关系最直接。（2）讲'代码已经支持什么'的几条有实质错误。飞书权限其实可以通过 SDK 1.71.1 的 addons 预填（有灰度限制），报告依据的是过时的注释。'write/full 走已有审批'引用的是 CLI 转发审批的配置，与 bot 运行无关，bot 线程的 approvalPolicy 是 never。comment-instructions.md 只用于评论流程，不是 bot 级人设，也不会写进用户仓库。developer instructions 通道已经存在，只是全局常量。头像预填只是 SDK 的能力，代码没有用。（3）个别数字和归因被放大：市场是 35 个 bot、28 个作者，不是约 39 个邀请创作者；插件可以只含 skills 或只含 MCP；Snyk 没有记录实际改写 SOUL.md 的案例；Agent Plugins 规范里没有 assets/。（4）竞品其实是飞书员工的个人项目，2026-09-01 以后也没更新；现成的 `vonvon` CLI 和单应用的配置模型，报告也没提。结论里'MVP 是分享和导入，不做市场'这个方向和证据一致，但'飞书里聊天创建要两次人手点击'这个可行性判断需要按 addons 重新实测。


### 逐条复查

- **属实**：Grok Bot 是 xAI 在 2026-08-11 发布的真实产品；每个账号一台云端 Linux 机器，所有 bot 共用，被称为 "a real blast radius"
  - 依据：reworked.co（文章日期 2026-08-12）写明 xAI 于 2026-08-11 发布，账号下所有 bot 共用一台隔离的云端 Linux 机器及其文件和登录，并引用了 "a real blast radius"。https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/ 。产品认对了：'Grok Bot' 指的就是 xAI 的这个产品。
- **属实**：分享出去的是模板：对方添加时得到副本，拿不到原主人的电脑、登录状态和历史记录；已有 bot 可以建议或直接创建新 bot；第一个 bot 是填表创建的
  - 依据：docs.x.ai/grok-bot/bots 原文："Adding a shared Bot creates a copy on the recipient's account"，不包含 "your computer, logins, or conversation history"；"Your existing Bots can also suggest or create a focused Bot"。get-started 页的创建字段是 Name、Job、Description。补充：分享一节没有提记忆，"不带 learned memory" 只在 Duplicate 一节出现。https://docs.x.ai/grok-bot/get-started
- **说过头了**：官方市场约 39 个模板，作者是点名邀请的知名创作者，页面不显示安装数
  - 依据：https://x.ai/bot/marketplace（2026-10-14 抓取）
- **说过头了**：OpenAI 在 2026-09-11 宣布退役自定义 GPT，2026-12-11 停用，迁移到插件（由 skills 和 MCP 组成）；instructions 变成 skill；模型、Actions、对话和分享设置都不迁移
  - 依据：https://virtualizationreview.com/articles/2026/09/28/openai-to-retire-custom-gpts-replace-them-with-plugins.aspx ；help.openai.com/en/articles/20001519 返回 HTTP 403
- **说过头了**：Koi 审计 ClawHub 2,857 个 skill，341 个恶意；Snyk 扫描 3,984 个，36.82% 有问题；Snyk 记录到恶意 skill 改写 SOUL.md 和 MEMORY.md
  - 依据：https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub ；https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub
- **属实**：agency-agents 有 159,949 star，源自一个 Reddit 帖子，桌面 app 是后来才做的
  - 依据：GitHub API（2026-10-14）：msitarzewski/agency-agents 有 159,951 star，创建于 2025-10-13。README 第 21 行写 "Born from a Reddit thread"。app 仓库 msitarzewski/agency-agents-app 创建于 2026-06-08，有 724 star。
- **属实**：竞品 Lark Coding Agent Bridge 的教程由飞书官网 2026-06-04 发布；lark-channel-bridge 周下载 902 次，@modelzen/feishu-codex-bridge 108 次，后者近 30 天 1,106 次；star 分别是 2,692 和 81
  - 依据：npm API downloads/point 2026-10-06:2026-10-12 和 last-month；gh api repos/zarazhangrui/lark-coding-agent-bridge；https://www.feishu.cn/content/article/7647408304896953549
- **属实**：bridge 最后一个版本是 0.6.14，发布于 2026-09-24
  - 依据：npm registry time['0.6.14']=2026-09-24T14:12:37Z。/home/operator/vonvon/feishu-codex-bridge 的 HEAD 6698118 就是 "chore(release): 0.6.14"，日期 2026-09-24，之后没有新提交。
- **说过头了**：registerApp 扫码可以创建 PersonalAgent 应用，并预填名称、描述和头像（wizard.ts:12、:56-58）
  - 依据：/home/operator/vonvon/vonvon-bot/packages/daemon/src/bot/wizard.ts:12,56-62；node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:312588-312603
- **有误**：权限只能在开发者后台点一次授权，无法预填（scopes.ts:7-12）；所以聊天创建等于一段对话加两次人手点击
  - 依据：node_modules/@larksuiteoapi/node-sdk/types/index.d.ts:312604-312684（AppAddons，含 "Requires the platform gray-scale"）；node_modules/@larksuiteoapi/node-sdk/README.zh.md:746-785；vonvon-bot 代码里没有任何地方用到 addons（grep 结果为空）
- **说过头了**：现有代码把指令同步写成目录里的 AGENTS.md 和 CLAUDE.md（comments.ts:306-315），bot 级提示词放在 comment-instructions.md（schema.ts:125）；导入的人设应该改走 provider 的 developer instructions 通道（推断）
  - 依据：/home/operator/vonvon/vonvon-bot/packages/daemon/src/bot/comments.ts:305-317,355-371；packages/daemon/src/agent/bridge-instructions.ts:1-12；packages/daemon/src/agent/codex-appserver/protocol/generated/v2/ThreadStartParams.ts
- **有误**：write 和 full 继续走已有的审批（schema.ts:483-485）
  - 依据：/home/operator/vonvon/vonvon-bot/packages/daemon/src/config/schema.ts:394-400,483-486；packages/daemon/src/agent/codex-appserver/backend.ts:30-33
- **属实**：Telegram Bot API 9.6（2026-04-03）加入 Managed Bots；Grok Build 插件市场 2026-06-11 上线，开放 PR，安装时校验钉住的 SHA，首发 6 个合作方；Team Bots 2026-09-28 推出，可以进 Slack
  - 依据：https://core.telegram.org/bots/api-changelog（9.6，2026-04-03，t.me/newbot 链接、getManagedBotToken、replaceManagedBotToken）；https://x.ai/news/grok-plugin-marketplace（2026-06-11，MongoDB/Vercel/Sentry/Chrome DevTools/Cloudflare/Superpowers）；https://releasebot.io/updates/xai（Team Bots 2026-09-28，公测，限 Teams/Enterprise 套餐，可进 Slack 频道。这是聚合站，不是一手来源）。另外，releasebot 上没有"2026-09-29 在 app 内移除精选 bot"这一条，2026-09-29 的条目是 Grok Build 1.0.45。所以 wiki 的这个说法仍然没有证据。
- **说过头了**：Agent Plugins 1.0 的 TSC 来自 Amazon/Cursor/Microsoft/OpenAI/Vercel；AGENTS.md 有 6 万多个项目采用，由 AAIF 托管；SKILL.md 获 Claude Code、Codex、Cursor、OpenClaw、TRAE 支持；格式表里 Agent Plugins 的头像放在 assets/
  - 依据：https://agent-plugins.org/ ；https://agents.md/ ；https://agentskills.io/home 的客户端列表

### 正文遗漏的事实

- 报告完全没有找到、也没有分析主人点名的三个产品。Muse：多半是 Meta 的个人 agent app Muse，二手报道说 2026-09-08 在美国上线，覆盖 iOS、Android、web 和 WhatsApp，能代办邮件、订票、购物，上线前 12 天 App Store 下载量第一，Meta Connect 2026 宣布了 Muse Realtime Avatar。来源是 therundown.ai 和 techrepublic，后者抓取时返回 403，我没有拿到 Meta 的一手公告。Today.AI：此间无限，todayai.cn，创始人齐俊元（Teambition 创始人，做过飞书产品、豆包 PC 端），据报道国内版 2026-09-24 上线，已接入飞书和钉钉，产品主打主动推送的'今天'视图；天使轮 1000 万美元，IDG 和阶跃星辰参投（36氪、极客公园，二手）。它和 Vonvon 都做飞书生态，是直接相关的对手，报告漏掉了。comma：GitHub AFK-surf/Comma，2026-09-30 创建，257 star，AGPL-3.0，Elixir，自称'兼容 ChatGPT/codex 和 claude code'，是'Muse, Dots, Instinct, Town 的开源替代'（gh api，2026-10-14）。这三个都是'永远在线、主动、个人助理'这一类，和'bot 市场'是两个方向，报告没有区分。
- 代码里已经有 CLI：packages/daemon/package.json:6-7 的 bin `vonvon`，`vonvon bot init/list/use/rm`（packages/daemon/src/cli/commands/bot.ts:10,27,47,104）。主人要求'支持 CLI'，报告提的 `vonvon bot export/import` 应该说明是扩展这个现成的命令组，而不是从零开始。
- 飞书 SDK 1.71.1 的 registerApp 支持 `addons` 预填权限、事件和回调，也支持对已有 appId 增量补权限（需要平台灰度）。这会改变'聊天创建 bot 要两次人手点击'的判断，报告依据的是过时的代码注释。
- 现在的配置模型是一个 daemon 一个应用：AppConfig.accounts.app 是单个（packages/daemon/src/config/schema.ts:175-180），多 bot 靠 `vonvon bot use` 在 bot 之间切换。'多个 bot 加入不同的群'到底要多少改动，报告没有评估。
- 在现有代码里，人设能走的通道只有一个全局常量 BRIDGE_DEVELOPER_INSTRUCTIONS（codex 的 developerInstructions 加 claude 的 systemPrompt append），还没有按 bot 区分的人设字段。'让 bot 更像人'要从这里加按 bot 的字段，报告没有指出这个具体的落点。
- Lark Coding Agent Bridge 是飞书员工的个人项目，不是飞书官方产品，而且 2026-09-01 以后也没有发新版。也就是说，这个赛道里流量最大的竞品同样停更了一个多月，这和主人担心的'bridge 好久没更新'直接相关。
- 报告没有回应主人的处境本身：v2 自 2026-10-10 起没有交付可用产品，bridge 自 2026-09-24 起没有更新。它只在最后一段把'先在 bridge 上做 A'列为选项。bridge 现在仍有每周约 108 次下载，最近 30 天 1,106 次，而且这些数字部分来自 9 月 20-24 日连发四个版本时用户的更新。报告没有给出'先给现有用户发一个 bridge 版本'这样具体可执行的建议。
