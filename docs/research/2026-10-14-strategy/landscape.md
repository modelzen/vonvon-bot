# The 2026 personal-agent wave (state as of 2026-10-14)

## Bottom line

- In about eight months, every large vendor shipped the same product shape: an always-on agent with its own cloud computer, reached through chat apps, with approval gates, routines and memory. Google Gemini Spark was announced 2026-05-19, xAI Grok Bot entered beta 2026-08-11, Meta Muse launched 2026-09-08 and OpenAI Dots launched 2026-09-29. In China, ByteDance shipped Coze 3.0 (2026-05-29) and Doubao Work Partner inside Feishu 8.0 (2026-09-15). Tencent shipped WorkBuddy (2026-03-09) and a WeChat ClawBot plugin (2026-03-22). Sources are in section 1.
- The "Grok Bot" the owner describes is a real product. xAI's Grok Bot gives each bot a name and an avatar, has a Marketplace with "Import Bot", and lets you share a bot as a template. Existing bots "can also suggest or create a focused Bot". Bots work in group chats, and you can tag @bot on X. Team Bots work in Slack. The CLI is a separate product, Grok Build. [docs.x.ai/grok-bot/bots](https://docs.x.ai/grok-bot/bots), [docs.x.ai/grok-bot](https://docs.x.ai/grok-bot)
- The closest competitor to Vonvon is **Coze 3.0** (ByteDance, which also owns Feishu). In one project you can @ Codex, Claude Code or OpenClaw, running locally or on Coze's cloud computers, and bind Feishu with one click. [docs.coze.cn FAQ](https://docs.coze.cn/cozespace_coze_app_faq), [news.qq.com 2026-06-01](https://news.qq.com/rain/a/20260601A08OVP00), [docs.coze.cn start](https://docs.coze.cn/cozespace_start_use). Feishu's own Doubao Work Partner joins Feishu groups with its own identity. [cnr.cn 2026-09-15](https://tech.cnr.cn/techph/20260915/t20260915_527814511.shtml)
- Owner's current position, for context:
  - Vonvon's core model is "one Feishu group = one project folder, one topic = one agent session" on the user's own machine ([docs/architecture.md:7](/home/operator/vonvon/vonvon-bot/docs/architecture.md)).
  - Roadmap V1–V11 is all infrastructure: protocol, daemon, desktop shell, provider layer, import, accounts, remote access ([docs/roadmap.md:11-26](/home/operator/vonvon/vonvon-bot/docs/roadmap.md)). A grep of architecture.md and roadmap.md for marketplace/skill/memory/scheduling terms found no product feature.
  - The bridge's last release is 0.6.14, dated 2026-09-24 (`git log` in /home/operator/vonvon/feishu-codex-bridge).
  - It had 108 npm downloads in the week of 2026-10-06 to 10-12 ([npm API](https://api.npmjs.org/downloads/point/last-week/@modelzen/feishu-codex-bridge)).

---

## 1. Products

### 1.1 Meta Muse (the personal agent) and the name collisions

| "Muse" | What it is | Date | Source |
|---|---|---|---|
| **Muse** (app) | Meta's personal AI agent | launched 2026-09-08 | [about.fb.com](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) |
| Muse Spark | Meta Superintelligence Labs model that powers Muse | 2026-04-08 | [llm-stats](https://llm-stats.com/models/muse-spark), [moguravr](https://www.moguravr.com/?p=307248) |
| **Muse Code** | Meta's terminal coding agent (`muse` CLI, macOS/Linux), on Muse Spark 1.2 | beta 2026-08-05 | [decrypt](https://decrypt.co/375001/muse-code-meta-ai-coding-agent-claude-codex), [propakistani](https://propakistani.pk/2026/08/06/meta-launches-cheaper-coding-agent-to-punch-openai-and-anthropic/) |
| Microsoft Muse | Game world model (WHAM), published in *Nature*. Unrelated. | 2025-02 | [etcentric](https://www.etcentric.org/muse-could-be-a-gamechanger-for-xbox-players-developers/) |

- **Paseo's "Muse Code" provider** is Meta's coding CLI, not the personal agent. Paseo 0.11.1 ships a built-in `muse-provider` plugin with `id: "muse"`, `label: "Muse Code"`, `command: ["muse"]` (`/home/operator/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/server/dist/server/builtin-plugins/muse-provider/server/provider.ts:34-37`).
- **Muse Code pricing:** pay-as-you-go at $1.25 per million input tokens and $4.25 per million output tokens at beta ([propakistani](https://propakistani.pk/2026/08/06/meta-launches-cheaper-coding-agent-to-punch-openai-and-anthropic/)). One source says it left beta on 2026-08-31 with plans from $5/month ([runtimewire](https://runtimewire.com/article/meta-muse-code-out-of-beta-monthly-plans)); not verified elsewhere.

**Muse, the agent** ([Meta newsroom](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), updated 2026-09-30):
- **Where it runs:** "Muse runs on Muse Secure VM, a dedicated secure computer with its own browser." A separate "Sentinel agent" on the same machine is isolated from Muse at the system level. An encrypted "Muse Confidential VM" is planned "later this year".
- **Surfaces:** the Muse app (iOS, Android), WhatsApp and muse.ai. Talking to it "works just like messaging another person". AI glasses are "coming soon". US only at launch.
- **Features:**
  - Memory, with a "forget" command.
  - Proactive suggestions.
  - "keeps working after people close the app".
  - Approval before sending email or buying.
  - A full audit trail.
  - Checkout through Link by Stripe one-time cards.
- **Pricing:** "free for most of what people need, with subscription plans" (Meta). The $20 and $100 tiers come from one secondary source only ([tech-insider](https://tech-insider.org/meta-muse-personal-ai-agent-launch-2026/)).
- **Traction:**
  - Sensor Tower *projected* 5M downloads about 22 days after launch, and Muse held #1 free on the US App Store for 12 days.
  - Meta ramped ad spend on 2026-09-16, and Muse took up to 50% of Meta's daily house-ad impressions ([9to5mac 2026-09-30](https://9to5mac.com/?p=1072173)).
  - Apptopia counted about 2.8M worldwide installs in the first 12 days ([Fortune](https://fortune.com/2026/09/30/noah-shinn-instinct-ai-assistant-meta-muse-alexandr-wang-tech-series-c-ai-agent-mark-zuckerberg/)).

### 1.2 Today (today.ai)

- **What:** "an AI personal agent with living memory" that "remembers your life, notices changes, and acts before you ask" ([today.ai, 2026-09-15](https://today.ai/articles/blog/what-is-today)).
- **Who:** "Today AI" (site footer). The launch date is not stated.
- **Runs on:** Mac, iOS and Android, with memory shared across devices.
- **Design:**
  - Memory is stored as editable structured facts, not chat transcripts.
  - It speaks proactively only twice a day, in a morning brief and an evening close-out.
  - It "will not send email, move calendar events, or message others without your explicit confirm."
- **Integrations:** calendar, mail, notes, files, HealthKit / Health Connect.
- **Pricing:** free for now.
- **Traction:** unknown.
- **Possible mix-up:** an App Store app called "today ai: personal agent" is published by *Since Kindly, Inc.* and links to oneintent.today. It is a "daily menu of ideas" app with 1 rating and costs $12.99/month or $49.99/year ([App Store](https://apps.apple.com/us/app/today-ai-personal-agent/id6767525653)). It appears to be a different product.

### 1.3 "Grok Bot" = xAI Grok Bot (built on Cursor)

- **What:** "Bots you can keep around: AI teammates with names, jobs, and context that compounds over time." Each bot works on "a persistent cloud computer with a browser, filesystem, and terminal" ([docs.x.ai/grok-bot](https://docs.x.ai/grok-bot)).
- **Who:**
  - xAI markets it. Cursor handles sign-in, billing and the data terms ([Digital Applied](https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026)).
  - SpaceX/xAI's acquisition of Cursor reportedly closed on 2026-08-14 ([mezha.ua](https://mezha.ua/en/news/spacex-oficiyno-zavershila-pridbannya-cursor-314230/)); secondary sources only.
- **Launch:** beta 2026-08-11 for SuperGrok Heavy, Cursor Ultra and Cursor Teams Premium ([Reworked 2026-08-12](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)).
- **Access now:** "included with every paid individual Cursor plan and with the Cursor Teams plan". You can also link SuperGrok, SuperGrok Plus or SuperGrok Heavy. Usage resets weekly ([docs](https://docs.x.ai/grok-bot)).
- **Surfaces:** macOS, Windows, Linux, iOS and Android, plus tagging @bot on X ([docs](https://docs.x.ai/grok-bot)). At launch it was desktop and iOS only ([Reworked](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)).
- **The features the owner described** ([docs.x.ai/grok-bot/bots](https://docs.x.ai/grok-bot/bots)):
  - **Marketplace:** "The sidebar's Marketplace lists Bots you can add… 'Import Bot'".
  - **Sharing:** "Create template" makes a public or team-only link. "Adding a shared Bot creates a copy on the recipient's account." Chat history, learned memory and logins are not copied.
  - **Create by chatting:** "Your existing Bots can also suggest or create a focused Bot". Bots can also learn a workflow from a recorded demonstration and save it as a scheduled skill ([docs](https://docs.x.ai/grok-bot)).
  - **Bots in groups:** group chats where bots hand work to each other. The docs' example is a coordinator, an editor and an analyst.
  - **Team Bots:** one bot for a whole team, in the app or in Slack, with "its own Slack app that posts as itself". Each person's chats stay private. Team memory is shared ([docs.x.ai/grok-bot/team-bots](https://docs.x.ai/grok-bot/team-bots)). Public beta started 2026-09-28 ([Releasebot](https://releasebot.io/updates/xai)).
  - **CLI:** not part of Grok Bot. Grok Build is xAI's separate coding CLI, in early beta since mid-May 2026 for SuperGrok Heavy ([pulse2](https://pulse2.com/xai-grok-build-launches-early-beta-coding-agent-cli/)).
- **Marketplace launch date:** reportedly 2026-08-28, with 11 categories and up to 50 bots and group chats per account ([Basenor, citing an X post](https://www.basenor.com/blogs/news/grok-bot-template-marketplace-everything-you-need-to-know)). Secondary only.
- **Plugins:** 220 at launch ([Reworked](https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/)).
- **Isolation:** "Bots have separate roles and conversations, but they share the computer" ([docs](https://docs.x.ai/grok-bot/bots)). The docs also say: "Do not use separate Bots as a security boundary" ([Digital Applied](https://www.digitalapplied.com/blog/grok-bot-ai-teammates-launch-cloud-computer-2026)).
- **Traction:** no figures published.
- **Not the same thing:**
  - Grok "companions" (Ani and others), launched 2025-07-14 ([Euronews](https://www.euronews.com/2025/07/17/elon-musks-grok-releases-two-new-ai-companions-including-an-anime-girlfriend)).
  - The May 2025 Telegram–xAI deal ([hespress](https://fr.hespress.com/426250-xai-de-musk-signe-un-partenariat-de-300-m-avec-telegram-pour-integrer-grok.html)). Its status in 2026 is unknown.

### 1.4 OpenAI Dots

- **Launch:** DevDay, 2026-09-29. "always-on agents built to handle everything", on GPT-6 Astra ([TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)).
- **Runs on:** its "own cloud computer, web browser, and connections to apps", over 4,000 of them ([NBC](https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338)).
- **Surfaces:**
  - Launched from ChatGPT and Codex. Slack, Teams and other workplace apps can send it work. Text messages are "coming soon" ([TechCrunch](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/)).
  - OpenAI staff bring Dots into group chats "from the get-go" ([NBC](https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338)).
- **Model:** you name your primary dot. OpenAI describes "specialist Dots" and "teams of Dots".
- **Plans:**
  - Pro ($100–500/month per NBC) and Business Premium (CBS reports $20/month) ([CBS](https://www.cbsnews.com/news/sam-altman-openai-dots-chatgpt-agents-safety/)).
  - Not available in the EU or UK ([NBC](https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338)).
- **Safety context:** OpenAI held back GPT-6.1 Astra over "staying within scope and authorization" ([NBC](https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338)).
- **Gaps:** I could not fetch the openai.com post. No usage figures are published.

### 1.5 Instinct

- **What:** a personal agent you text or call, "with no new interface required" ([PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/personal-ai-agent-instinct-quadruples-valuation-to-10-billion-in-1-month/)).
- **Who:** founder Noah Shinn, 23. Private beta began February 2026; an invite-only beta opened August 2026. It is free and users get five invites each ([Fortune 2026-09-30](https://fortune.com/2026/09/30/noah-shinn-instinct-ai-assistant-meta-muse-alexandr-wang-tech-series-c-ai-agent-mark-zuckerberg/)).
- **Funding:**
  - $250M at a $2.5B valuation in August, then a $1B Series C at $10B on 2026-09-28 ([Bloomberg](https://www.bloomberg.com/news/articles/2026-09-28/ai-agent-startup-instinct-raises-1-billion-at-10-billion-value), [Fortune](https://fortune.com/2026/09/30/noah-shinn-instinct-ai-assistant-meta-muse-alexandr-wang-tech-series-c-ai-agent-mark-zuckerberg/)).
  - Leads were Sequoia, Benchmark and Coatue, per a secondary source ([aiweekly](https://aiweekly.co/alerts/ai-personal-agent-startup-instinct-raises-1b-series-c-at-10b-from-sequoia)).
- **Traction:**
  - More than 100k invite-only users (The Information, 2026-09-15, via [PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/personal-ai-agent-instinct-quadruples-valuation-to-10-billion-in-1-month/)).
  - Nearing $1B annual transaction volume, about half of it travel, with "$0 on marketing" ([Fortune](https://fortune.com/2026/09/30/noah-shinn-instinct-ai-assistant-meta-muse-alexandr-wang-tech-series-c-ai-agent-mark-zuckerberg/)).
- **New features:** a "Trusted Person Network" where users' agents coordinate plans with each other, location sharing, and Concierge ([PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/personal-ai-agent-instinct-quadruples-valuation-to-10-billion-in-1-month/)).

### 1.6 Town

- **Funding:** $55M Series A led by a16z, announced 2026-06-03. Founders are Jean-Denis Greze (ex-Plaid) and Tony Vincent (ex-Google AI). The assistant is called a "Townie" ([GlobeNewswire via Yahoo](https://finance.yahoo.com/sectors/technology/articles/town-raises-55m-series-a16z-134500847.html)).
- **Surfaces** ([town.com](https://town.com)):
  - iMessage, including group texts.
  - Slack, as a bot and as a "Persona that can … send as you".
  - Its own @town.com email address.
  - macOS and iPhone apps.
  - WhatsApp and Telegram, inbound only.
- **Features:** routines, more than 50 integrations, and Town Teams. "Town never sends emails or calendar invites without your approval." One review says Townies can join group chats with other users' Townies ([eesel](https://www.eesel.ai/blog/town-ai-review)).
- **Pricing:** not on town.com. One review lists free, $15 and $49 tiers ([eesel](https://www.eesel.ai/blog/town-ai-review)); unverified.
- **Traction:** not disclosed.

### 1.7 Big-vendor entries the owner did not name

- **Google Gemini Spark:**
  - Announced at I/O on 2026-05-19. "always-on agentic AI assistant built on Gemini 3.5 and the Antigravity harness", running on dedicated Google Cloud VMs.
  - You can send it tasks at its own Gmail address. It connects through MCP.
  - Ships with Google AI Ultra, cut from $250 to $100/month ([TNW](https://thenextweb.com/news/google-gemini-spark-agentic-assistant-gmail-io-2026)).
- **Anthropic Claude Code Channels** (research preview):
  - An MCP server pushes chat into a *running local* session, with Telegram, Discord and iMessage plugins.
  - "Events only arrive while the session is open, so for an always-on setup you run Claude in a background process."
  - Permission prompts can be relayed to the chat ([code.claude.com/docs/en/channels](https://code.claude.com/docs/en/channels)). No Feishu plugin.

### 1.8 Open-source personal agents

- **OpenClaw:**
  - About 392k stars and 82.4k forks. MIT license. Stewarded by the OpenClaw Foundation (a 501(c)(3)) with no paid tier.
  - A local Gateway connects to WhatsApp, Telegram, Slack, Discord, Signal, iMessage and "20+ more". ClawHub hosts plugins. Native device apps add camera, screen and voice ([GitHub](https://github.com/openclaw/openclaw)).
  - Latest release v2026.10.3 on 2026-10-13 ([GitHub API](https://api.github.com/repos/openclaw/openclaw/releases/latest)).
  - History: started as Warelay on 2025-11-24, then Clawdbot, then Moltbot, renamed OpenClaw on 2026-01-30. Creator Peter Steinberger joined OpenAI on 2026-02-14 ([Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)).
  - Risks: a malicious skill found by Cisco in January; China restricted state bodies from running it in March; The Register criticized 2.0 for unencrypted secrets ([Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)).
  - **Feishu:** the official plugin `larksuite/openclaw-lark` (2.4k stars, by the Lark/Feishu Open Platform team) covers messages, docs, Base, Sheets, calendar and tasks, and acts "under your user identity". It *recommends using the bot as a private assistant and not adding it to group chats* ([GitHub](https://github.com/larksuite/openclaw-lark)).
- **Hermes Agent** (Nous Research):
  - About 253.6k stars, MIT, Python ([GitHub API](https://api.github.com/repos/NousResearch/hermes-agent)).
  - Agent-curated memory, skills it creates and improves itself (agentskills.io compatible), a cron scheduler, subagents, a TUI, and gateways for Telegram, Discord, Slack, WhatsApp, Signal and email. No Feishu ([GitHub](https://github.com/nousresearch/hermes-agent)).
  - Public launch 2026-02-25 per secondary sources ([gradually.ai](https://www.gradually.ai/en/hermes-agent-statistics/)).
- **Comma** (AFK-surf):
  - Repo created 2026-09-30 and last pushed 2026-10-03. 257 stars, Elixir, AGPL-3.0 ([GitHub API](https://api.github.com/repos/AFK-surf/Comma)).
  - Its About line: "Selfhost your open source alternative to Muse, Dots, Instinct and Town."
  - "Sessionless": Tasks, not conversations, hold the state. Loops watch inboxes and repos.
  - Its Salix connector lets Comma reach a Mac and delegate to Codex, Claude Code, Pi or Kimi. You can use a ChatGPT or Claude plan ([GitHub](https://github.com/AFK-surf/Comma)).
  - Signal and Telegram channels. The hosted tier is free, with a paid Pro tier ([comma.surf](https://comma.surf)).
  - Traction: tiny.
- **Lightweight forks** (as of 2026-03-26): nanobot about 36k stars, ZeroClaw about 29k, PicoClaw about 26k, NanoClaw about 25k ([OSSInsight](https://ossinsight.io/blog/the-openclaw-forks-wave-2026)).

### 1.9 China

- **Feishu aily → 豆包工作伙伴 (Doubao Work Partner):**
  - The 智能伙伴 assistant launched around 2026-03 as an "OpenClaw-like" bot in the Feishu contact list ([QbitAI](https://www.qbitai.com/2026/03/389311.html)). An early test found 响应不稳定 (unstable responses) ([DoNews](https://www.donews.com/news/detail/4/6475520.html)).
  - Renamed in mid-August after ByteDance's 2026-07-30 merger of the Feishu and Doubao product teams. The developer console keeps the "飞书 aily" name ([Sohu/新黄河 2026-08-18](https://www.sohu.com/a/1064329056_121347613)).
  - Feishu 8.0 (2026-09-15): agents get "独立身份" (their own identity), join group chats, collaborate with each other, and admins set unified permissions ([cnr.cn](https://tech.cnr.cn/techph/20260915/t20260915_527814511.shtml)).
  - Currently in "定向共创" (co-creation with selected companies), not generally available ([toutiao](https://www.toutiao.com/article/7686017767585120804/), via search snippet).
  - Feishu also open-sourced `lark-cli` (v1.0.0 on 2026-03-28) with agent skills ([jimmysong](https://jimmysong.io/ai/lark-cli/)); version 1.0.97 is installed on this host.
- **Coze / 扣子 (ByteDance):**
  - 2.0 (2026-01-19) added an Agent Skills store. 2.5 (2026-04-07) gave agents email, a cloud computer and a cloud phone. Both per secondary sources ([cnblogs](https://www.cnblogs.com/jinjiangongzuoshi/p/20299120)).
  - **3.0 (2026-05-29):** "多人多 Agent 协作" (several people and several agents working together). Claude Code, Codex CLI, OpenClaw and Hermes run on Coze cloud computers (2–32 vCPU) "不依赖本地电脑" (no local PC needed), but cannot reach local files. Feishu and WeChat are IM channels. Memory carries across channels ([docs.coze.cn FAQ](https://docs.coze.cn/cozespace_coze_app_faq)).
  - A "本地 Agent" option connects the user's own local agents through "Coze Bridge" ([news.qq.com](https://news.qq.com/rain/a/20260601A08OVP00)).
  - 一键绑定飞书 (one-click Feishu binding); a 虾评 skill community. Pricing from free to ¥999/month, with team and enterprise plans ([docs.coze.cn start](https://docs.coze.cn/cozespace_start_use)).
  - A tester noted the @-handoffs were manual, "并没有完全自动化" (not fully automated) ([news.qq.com](https://news.qq.com/rain/a/20260601A08OVP00)).
- **Tencent:**
  - **WorkBuddy** (2026-03-09): a local desktop agent compatible with OpenClaw skills, with MCP and a choice of models (Hunyuan, DeepSeek, GLM, Kimi, MiniMax) ([TechNode](https://technode.com/2026/03/09/tencent-launches-openclaw-like-workplace-ai-agent-workbuddy/)).
  - Global launch 2026-05-29, with remote tasks through Slack, Telegram, Discord and WeChat ([TechNode](https://technode.com/2026/05/29/tencent-launches-workbuddy-productivity-ai-agent-for-global-users/)).
  - Pricing and traction come only from weak sources.
  - **WeChat ClawBot plugin** (2026-03-22, experimental): connects OpenClaw to *personal* WeChat ([中国基金报](https://www.chnfund.com/article/AR2a4f15aa-3409-21bb-b403-3a2026cd67c7)).
- **Kimi (Moonshot):**
  - OK Computer (2025-09-26).
  - Kimi Claw: a browser-based, always-online OpenClaw with access to the 5,000+ skill ClawHub, public beta mid-February 2026.
  - Agent Swarm: up to 300 subagents.
  - Kimi Work desktop app; K3 model on 2026-07-16 ([kimi.com help](https://www.kimi.com/en/help/agent/agent-overview)).
- **Manus:**
  - Meta's acquisition (announced December 2025) was blocked by China's NDRC on 2026-04-27. Manus said on 2026-08-11 it will operate independently. Run-rate revenue was $125M in December 2025 ([Wikipedia](https://en.wikipedia.org/wiki/Manus_(AI_agent))).
  - A 2026-10-08 raise of $500M+ is single-sourced ([KuCoin](https://kucoin.com/fr/news/flash/manus-raises-500m-after-buyback-from-meta)).
- **Genspark** (Palo Alto):
  - Genspark Claw, its "first AI employee" with a dedicated cloud computer, launched 2026-03-12 with a $200M+ run rate and a valuation near $1.6B ([Business Wire](https://secure.businesswire.com/news/home/20260312641003/en/Genspark-Claw-Launches-as-Gensparks-First-AI-Employee-Alongside-Genspark-AI-Workspace-3.0-as-the-Company-Surpasses-%24200M-Annual-Run-Rate-and-Extends-Series-B-to-%24385M-and-Reaches-near-%241.6B-Valuation)).
  - Desktop version on 2026-04-08 ([Business Wire](https://secure.businesswire.com/news/home/20260408545044/en/Genspark-Launches-Genspark-Claw-for-Desktop-and-Microsoft-Office-Integration-with-AI-Workspace-4.0-Bringing-AI-to-Local-Files-and-Everyday-Work-Apps)).
- **MiniMax:**
  - MaxClaw: a one-click cloud OpenClaw on M2.5 with long-term memory, launched around 2026-02-25 ([press release](https://markets.financialcontent.com/stocks/article/247pressrelease-2026-2-27-minimax-launches-maxclaw-a-one-click-agent-system-powered-by-minimax-25-with-built-in-long-term-memory)).
  - Personal WeChat support from 2026-03-23 ([Baidu Baike](https://baike.baidu.com/en/item/MaxClaw/1490433)).
  - MiniMax listed on HKEX on 2026-01-09 with 2025 revenue of $79M ([Wikipedia](https://en.wikipedia.org/wiki/MiniMax_(company))).

---

## 2. What is converging

| Pattern | Who ships it (sources above) |
|---|---|
| **Own cloud computer, always on** | Muse (Secure VM), Dots, Grok Bot (one VM per account), Gemini Spark, Genspark Claw, Coze 3.0, Kimi Claw, MaxClaw |
| **Proactive work and routines** | Muse, Dots, Town routines, Today (twice a day), Grok Bot routines, Comma Loops, Hermes cron |
| **Task, not session** | Comma ("sessionless", Tasks board), Muse ("keeps working after people close the app"), Dots (continuous goals), Grok Bot (durable bots) |
| **Memory the user can edit** | Muse ("forget"), Today (fact store), Grok Bot (memory, not copied with templates), Hermes, Coze (memory across channels), Doubao Work Partner (team memory) |
| **Bridge to the user's own machine** | OpenClaw nodes, Comma Salix, Coze 本地 Agent, WorkBuddy, Genspark Claw Desktop, Claude Code Channels |
| **Lives in chat apps** | WhatsApp (Muse), X @bot and Slack (Grok Bot), Slack/Teams (Dots), iMessage group texts (Town), SMS/calls (Instinct), Gmail address (Spark), Feishu (Doubao, Coze, openclaw-lark), WeChat (ClawBot, MaxClaw) |
| **Skills, plugins, marketplaces** | Grok Bot Marketplace and templates, ClawHub, Hermes Skills Hub (agentskills.io), Coze skill store and 虾评, WorkBuddy (OpenClaw skills), Dots (4,000+ apps) |
| **Multi-agent and group chats** | Grok Bot group chats and Team Bots, Dots teams, Coze @-teams, Doubao Work Partner groups, Instinct agent-to-agent network, Kimi Swarm |
| **"More like a person"** | Names and avatars (Grok Bot), its own email (Town, Spark), phone number (Instinct), its own Slack identity (Team Bots), its own org identity (Doubao Work Partner) |

The owner's principle "让 Vonvon bot 更像人" (make Vonvon bots more like people) and the "bots join different groups / create a bot by chatting / marketplace" idea are the same pattern set that xAI, OpenAI, Meta and ByteDance shipped in August–September 2026.

## 3. Hype vs durable

**Durable:** at least four independent vendors converged, and it is visible in shipped docs.
1. **A dedicated computer per user or agent.** It is now the default architecture. It costs the vendor compute, so it is a scale game.
2. **Approval gates plus an audit trail as the trust model.** Muse has an audit trail; Town's site says it "never sends … without your approval"; Today requires explicit confirmation; Grok Bot has an "approval boundary"; Spark asks consent for high-impact actions.
3. **Chat apps as the main interface, and the agent as something you can address.** It has an email address, a handle, or a place in a group.
4. **Skills as portable files** (agentskills.io, ClawHub, Coze, WorkBuddy's OpenClaw compatibility). This is the real extension unit.
5. **Schedules and routines.** Every serious entry has them.

**Hype or unproven:**
1. **Traction claims.**
   - Instinct's valuation went up four times in about a month on more than 100k invite-only users, with no active-user count disclosed.
   - Muse's download curve was partly bought with house ads (up to 50% of impressions).
   - Grok Bot and its marketplace publish no usage figures; Dots publishes none either.
2. **"Teams of agents."**
   - Grok Bot's docs say bots share one computer and are not a security boundary.
   - A Coze 3.0 tester had to @ agents by hand.
3. **Proactivity as a selling point.** Today limits itself to two set times a day ("every proactive message must be something you would have wanted a person to tell you"), which suggests notification noise is the failure mode.
4. **Safety at scale.**
   - OpenClaw had a Cisco-found exfiltration skill, unencrypted secrets in 2.0, and state-sector restrictions in China.
   - OpenAI withheld GPT-6.1 Astra.
   - Reworked described Grok Bot's shared machine as "a real blast radius".
5. **Bot template marketplaces.** None of the sources gives install counts, and templates leave out the parts that hold value: memory, logins and history (see Grok Bot's docs).

## 4. What a small team can own vs what vendors will give away

**Given away or bundled ($0–$100/month, or free in OSS):**
- Model, cloud VM, generic memory and app connectors (Dots 4,000+; Grok Bot 220 plugins; MCP everywhere).
- Bot creation by chat, templates and marketplaces (Grok Bot, Coze).
- Presence in the vendor's own network: WhatsApp (Muse), X (@bot), Feishu (Doubao Work Partner is built in; Coze binds in one click), WeChat (official ClawBot plugin).
- A chat bridge to *local* coding agents: Claude Code Channels (Telegram, Discord, iMessage), Coze 3.0 local agents and Coze Bridge, Comma Salix, and OpenClaw with the official Feishu plugin. All free or bundled.

**Plausibly ownable by a small team:** each gap is narrow, and each is backed by a cited limitation.
- **Multi-person Feishu group workflows around a real repo on the user's own machine.**
  - The official OpenClaw Feishu plugin advises against groups ([larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)).
  - Coze's cloud-hosted Codex and Claude Code cannot reach local files ([docs.coze.cn](https://docs.coze.cn/cozespace_coze_app_faq)).
  - Claude Code Channels has no Feishu plugin and only works while the session runs ([docs](https://code.claude.com/docs/en/channels)).
  - The gap closes if Coze's local-agent path or Doubao Work Partner matures.
- **Running on the user's own subscriptions and providers (Codex, Claude Code, Cursor, Grok, Pi, ACP).** Vendor agents are tied to one model. Comma is the only cited product that delegates to several local coding agents.
- **Reliability and operational quality in one channel.** Early aily was "响应不稳定" (unstable).
- **Bot definitions as plain files you can share,** using the existing skill standards, rather than running a marketplace. Two-sided marketplaces depend on distribution, which xAI, Meta and ByteDance already have. That last part is my inference; no source here measures marketplace outcomes.

**Not realistic for a small team:** per-user cloud VMs at consumer prices, a general-purpose "do everything" consumer agent, or a bot marketplace inside Feishu competing with Feishu's own parent company (Coze and Doubao Work Partner).

## Unknowns

- Muse prices (only "free for most" is official).
- The openai.com Dots post (could not fetch).
- Grok Bot's marketplace launch date and its per-tier limits (secondary sources only); the x.ai changelog returned 403.
- How Coze Bridge works.
- When Doubao Work Partner becomes generally available.
- Town's and WorkBuddy's official prices.
- Instinct's exact channels (SMS vs iMessage).
- Hermes' public launch date (secondary sources only).
- Whether Grok is still integrated in Telegram in 2026.
- Traction for Today, Town, Comma, Grok Bot and Dots.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The product identities are correct. Muse is Meta Muse (Meta newsroom, 2026-09-08), not Microsoft's Muse or the Muse Code CLI that Paseo wraps. Today.AI is today.ai, the 'living memory' agent from Today AI. AFK-SURF/comma is github.com/AFK-surf/Comma. 'Grok Bot' is the real Grok Bot product whose docs match the owner's description almost feature for feature: marketplace, import, templates, creating bots by chat, group chats, avatars. It is now sold under SpaceXAI, runs on Cursor's cloud, and has no CLI of its own. Most dates and traction numbers check out against primary or named sources (Muse, Dots, Grok Bot beta, Comma, the bridge release and npm count, local file:line citations).

The main errors are in the competitive analysis. First, the report misreads Coze 3.0. The official FAQ shows Coze already runs the user's local Claude Code, Codex, OpenClaw or Hermes with access to the local repo and terminal, and binds Feishu. So 'cloud Coze cannot reach local files' is not a gap, and Comma is not the only multi-local-agent product. The Coze tester's manual @ was a choice; the real limitation, from the FAQ, is that agents cannot @ other agents. Second, two Grok Bot details are overstated. The 220-plugin figure and the 'blast radius' quote come from the bot's own answers to a reporter, and 'no traction figures' ignores a third-party count of 69 public bots from 43 creators. Third, the report leaves out Feishu platform facts that decide feasibility: Feishu 8.0's own 'Agent 像人一样' positioning, agents added to groups by name search, and bot-to-bot group messages via the include_bot permissions. It also never checks what the code already supports: the bridge already has multiple QR-registered bots, bot-created groups, a reverse approval bridge and a CLI.


### 逐条复查

- **属实**：The 'Grok Bot' the owner describes is xAI's Grok Bot: named bots with avatars, a Marketplace with 'Import Bot', share-as-template, 'existing Bots can also suggest or create a focused Bot', group chats, @bot on X, Team Bots in Slack.
  - 依据：docs.x.ai/grok-bot/bots (fetched 2026-10-14): 'Marketplace in the sidebar also lists Bots that you can add… open it and choose Import Bot'; 'Your existing Bots can also suggest or create a focused Bot when a job should have a long-lived owner'; 'Put Bots in a group chat when the handoff itself needs to be visible'; Edit Profile sets 'name, label, description, and avatar'. A template carries 'the profile, settings, enabled skills, routines, and avatar' and 'does not copy conversation history, learned memory, or chat attachments'. docs.x.ai/grok-bot: 'Grok Bot runs on macOS, Windows, Linux, iOS, and Android'; @bot on X needs a connected X account and is 'not yet available in every region'. docs.x.ai/grok-bot/team-bots: the Slack app 'posts as itself, not as the owner'; 'Every conversation stays private'; 'Team memory is read by every teammate's conversation'.
- **属实**：Grok Bot entered beta on 2026-08-11 for SuperGrok Heavy, Cursor Ultra and Cursor Teams Premium, desktop and iOS only at launch; it is now included with every paid Cursor plan or a linked SuperGrok plan, and usage resets weekly.
  - 依据：Reworked, 2026-08-12: 'Released Aug. 11, 2026' for 'SuperGrok Heavy, Cursor Ultra, and Cursor Teams Premium'; platforms at launch were desktop and iOS. docs.x.ai/grok-bot: 'included with every paid individual Cursor plan and with the Cursor Teams plan'; 'Usage resets weekly'. The Cursor acquisition closing on 2026-08-14 is not secondary-only as the report says: search results cite Cursor's own post (aiweekly.co, vktr.com).
- **说过头了**：Grok Bot had 220 plugins at launch (Reworked); Reworked described the shared machine as 'a real blast radius'.
  - 依据：Reworked 2026-08-12: the 220 figure, 'none installed by default', comes from Grok Bot's own answer when the reporter asked it. 'The product itself called the shared computer "a real blast radius."' Neither is a vendor or journalist finding.
- **unsupported**：Grok Bot docs say 'Do not use separate Bots as a security boundary' (cited via Digital Applied).
  - 依据：The current docs.x.ai/grok-bot/bots page, fetched 2026-10-14, does not contain that sentence. It says 'Bots have separate roles and conversations, but they share the computer' and 'Keep external actions behind a clear approval boundary.' I did not fetch the Digital Applied article.
- **说过头了**：The Grok Bot marketplace launched 2026-08-28 with 11 categories and up to 50 bots and group chats per account (Basenor, secondary); Grok Bot and its marketplace publish no usage figures.
  - 依据：Basenor (2026-09-04) gives 8/28, eleven domains and 50 bots, citing an @SawyerMerritt X post dated 2026-09-04. Runtime Wire's 8/28 piece reports a leak by @blankspeaker that SpaceXAI 'appears to be preparing' a marketplace. Dragos Roua (2026-08-29) says templates had just become shareable and the marketplace would come 'as early as next week'. explainx.ai (as of 2026-09-05) counts '69 public bots from 43 creators' from third-party trackers, explicitly 'not an xAI-published figure', and says there is no documented revenue share.
- **属实**：Grok Bot has no CLI; Grok Build is xAI's separate coding CLI, in early beta since mid-May 2026 for SuperGrok Heavy.
  - 依据：pulse2.com, dated 'May 15, 2026': 'early beta for SuperGrok Heavy subscribers'. docs.x.ai/build/cli/reference documents the `grok` binary with subcommands login, models, mcp, plugin, `plugin marketplace`, sessions, memory, worktree, `agent stdio`, wrap and others. None of them refers to Grok Bot, bots or cloud computers.
- **属实**：Meta Muse launched 2026-09-08: Muse Secure VM with a Sentinel agent, app plus WhatsApp plus muse.ai, US only, memory with 'forget', approvals, audit trail, Stripe Link; traction: Sensor Tower projected 5M downloads, 12 days at #1, ads ramped 9/16, up to 50% of house-ad impressions; Apptopia 2.8M installs in 12 days.
  - 依据：about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ was published 2026-09-08 and updated 2026-09-30, with Secure VM, Sentinel, a Confidential VM due 'later this year', the Muse app, WhatsApp, muse.ai, US only, 'forget', approvals, audit trail, Link by Stripe, and 'free for most… with subscription plans'. 9to5mac 2026-09-30: Sensor Tower projects Muse 'crossed 5 million downloads', a 12-day #1 streak, ad ramp on 'Wednesday, September 16, 2026', and up to 50% of house-ad impressions from 9/14 to 9/27. Fortune 2026-09-30: '2.8 million installs worldwide in its first 12 days' (Apptopia). Paseo's 'Muse Code' provider is at provider.ts:34-37 (`id: "muse"`, `label: "Muse Code"`, `command: ["muse"]`).
- **属实**：Today (today.ai) is 'an AI personal agent with living memory', free on Mac, iOS and Android, speaking proactively twice a day, with explicit confirmation before email, calendar changes or messages.
  - 依据：today.ai/articles/blog/what-is-today, dated 2026-09-15 by The Today Team: 'an AI personal agent with living memory'; 'Free on Mac, iOS, and Android'; 'speaks first at two daily anchors, morning and evening'; 'will not send email, move calendar events, or message others without your explicit confirm'; footer '© Today AI 2026'. No launch date or traction is given.
- **属实**：Comma (AFK-surf): repo created 2026-09-30, last pushed 2026-10-03, 257 stars, Elixir, AGPL-3.0, About includes 'Selfhost your open source alternative to Muse, Dots, Instinct and Town'; sessionless Tasks, Loops, Salix delegates to Codex, Claude Code, Pi or Kimi.
  - 依据：api.github.com/repos/AFK-surf/Comma (fetched 2026-10-14): created_at 2026-09-30T08:39:30Z, pushed_at 2026-10-03T06:32:04Z, 257 stars, 17 forks, Elixir, AGPL-3.0. The quoted phrase is part of a longer description. README: 'Tasks are the persistent execution state'; 'A Loop is a small program that your agent writes'; Salix can 'hand work to Codex, Claude Code, Pi, or Kimi'; 'Bring your own API key, or a ChatGPT or Claude plan'. The README does not mention Signal or Telegram channels; I did not check comma.surf for them.
- **有误**：A Coze 3.0 tester had to @ agents by hand ('并没有完全自动化'), so agent handoffs are manual.
  - 依据：news.qq.com 2026-06-01: '这里我为了测试单个 Agent 的执行准确结果，所以采取了 @ 的方式，并没有完全自动化' (the tester chose @ in order to test single-agent accuracy). The real limitation is in the official FAQ (docs.coze.cn/cozespace_coze_app_faq): agents can @ humans, but '暂不支持直接 @ 其他 Agent'.
- **有误**：Ownable gap: Coze's cloud-hosted Codex and Claude Code cannot reach local files, and the gap closes only 'if Coze's local-agent path matures'; Comma is the only cited product that delegates to several local coding agents.
  - 依据：The official Coze FAQ (docs.coze.cn/cozespace_coze_app_faq) says Coze 3.0 (2026-05-29) already ships '本地 Agent' supporting Claude Code CLI, Codex CLI, OpenClaw and Hermes '部署在本地电脑上'. These can use '你授权的本机文件、代码仓库、终端环境' through 'a background service (bridge)' set up by the Coze desktop app. Coze also 'creates a bot app for your authorized Feishu account'. Media date the general release to 2026-06-01 (tmtpost.com/8021226.html, bbtnews 2026-06-01).
- **属实**：Doubao Work Partner (formerly Feishu Aily 智能伙伴, renamed mid-August) shipped with Feishu 8.0 on 2026-09-15: own identity, joins group chats, admin-set permissions, currently in 定向共创.
  - 依据：cnr.cn 2026-09-15 (decoded as GB18030): '豆包工作伙伴…拥有独立身份、权限和记忆，能像同事一样加入飞书群聊。企业统一配置其权限、能力和用量'; '目前，豆包工作伙伴处于与企业定向共创阶段'. Primary source for this, so the toutiao snippet is not needed. Sohu/新黄河 2026-08-18: '原飞书「Aily智能伙伴」改名为「豆包工作伙伴」'; the developer console keeps '飞书 aily'; the ByteDance reorganization was on 7月30日.
- **属实**：The official larksuite/openclaw-lark plugin (about 2.4k stars, Lark/Feishu Open Platform team) acts under the user's identity and recommends private use, not group chats.
  - 依据：github.com/larksuite/openclaw-lark: '2.4k stars'; 'developed and maintained by the Lark/Feishu Open Platform team'; 'OpenClaw will act under your user identity'; 'Do not add it to group chats or allow other users to interact with it'.
- **属实**：Bridge last release 0.6.14 on 2026-09-24; 108 npm downloads for 2026-10-06 to 10-12; Vonvon core model at docs/architecture.md:7; roadmap V1–V11 at docs/roadmap.md:11-26 is all infrastructure, with no marketplace, skill, memory or scheduling feature.
  - 依据：/home/operator/vonvon/feishu-codex-bridge: tag v0.6.14 dated 2026-09-24. The registry time for 0.6.14 is 2026-09-24T14:12:37Z, and latest is 0.6.14. api.npmjs.org last-week: {downloads:108, start:2026-10-06, end:2026-10-12}. architecture.md:7 is the '一个飞书群对应一个项目目录…一个话题对应一个 agent 会话' line. The roadmap.md table rows V1–V11 are at lines 11-26. Grepping architecture.md and roadmap.md for marketplace, skill, memory, schedule and persona returns nothing.
- **属实**：OpenAI Dots launched at DevDay 2026-09-29 on GPT-6 Astra, with its own cloud computer, 4,000+ apps, Slack and Teams, Pro ($100–500) and Business Premium, not in the EU or UK; GPT-6.1 Astra was held back. Claude Code Channels requires a running session and has no Feishu plugin.
  - 依据：TechCrunch 2026-09-29: 'always-on agents built to handle everything', GPT-6 Astra, 'text message support coming soon', 'specialist Dots', 'teams of Dots'. NBC 2026-09-29: 'their own cloud computer', 'over 4,000 applications', 'we bring our Dots into group chats from the get-go', 'Pro offering, which costs $100 to $500 a month', 'unavailable in Europe and the United Kingdom', 'didn't quite meet the bar in terms of staying within scope and authorization'. code.claude.com/docs/en/channels: 'Events only arrive while the session is open…'; 'Telegram, Discord, and iMessage are included in the research preview'; permission relay is supported. I did not check the CBS figure of $20 for Business Premium.

### 正文遗漏的事实

- Feishu 8.0 (cnr.cn 2026-09-15) uses the owner's own principle almost word for word: '让 Agent 在飞书里"像人一样"工作'. Any agent can be added to a group by searching its name ('用户搜索名字即可将 Agent 拉进群'), several agents can collaborate in a group, and agent permissions always equal the user's. Feishu's CLI grew from 247 to 767 agent-accessible functions since March. So 'more like a person' is Feishu's own 8.0 positioning, not just a pattern among Western vendors.
- Feishu platform: the official im.message.receive_v1 doc (open.feishu.cn/document/server-docs/im-v1/message/events/receive) now lets a bot receive other bots' group messages, through `im:message.group_at_msg.include_bot:readonly` or `im:message.group_msg.include_bot:read` (the latter excludes the bot's own messages). `sender_type` tells users from bots. Duplicate deliveries mean deduplicating by message_id, not event_id. Receiving all group messages is a sensitive permission. This decides whether 'bots in groups handing work to each other' can be built on Feishu, and the report has no Feishu platform limits at all.
- Existing code already covers parts of the owner's new idea, which the report does not check. The bridge README (/home/operator/vonvon/feishu-codex-bridge/README.md:80,118) lists 多飞书机器人: one machine registers several bots by QR scan and runs them at once, with `feishu-codex-bridge bot init|list|use|rm`. README:92: from a private-chat menu the bot creates the project group and invites you. It also has a reverse bridge, 咖啡一下 (README:77,104), which sends local Claude Code or Codex approvals and questions to Feishu, the same job as Claude Code Channels' permission relay. Other features are doc-comment @bot replies (README:78), `/goal` autonomous runs, and a CLI. vonvon-bot's protocol already models several bots (packages/protocol/src/admin.ts:29 `bots: z.array(...)`, settings.ts botId fields), and architecture.md plans a `vonvon` CLI.
- npm trend context: weekly downloads of @modelzen/feishu-codex-bridge were 1,724 and 2,363 in the weeks of 2026-06-01 and 06-08. They fell to 58–261 in late August to mid-September, jumped to 619 in the 0.6.11–0.6.14 release week (2026-09-21), then held around 100–105 (api.npmjs.org/downloads/range). Downloads follow releases, so the stalled bridge directly shows up as lost reach.
- Grok Bot templates carry profile, settings, enabled skills, routines and avatar, but not memory, history or attachments (docs.x.ai/grok-bot/bots). That gives a concrete schema for a shareable 'bot as file', which the report suggests but does not spell out.
- Coze FAQ details that matter for Vonvon: Coze creates a Feishu bot app for the authorized Feishu account. Conversations are not shared across channels, but memory is ('各个渠道对话不是打通的，但记忆打通'). Agents cannot @ other agents. Prices range from ¥0 to ¥999 a month for individuals, team plans start at ¥142 a month, and enterprise from ¥980 to ¥8,980 (docs.coze.cn/cozespace_start_use).
- Grok Bot's per-account limits and marketplace categories rely only on Basenor, which cites an X post by @SawyerMerritt, not SpaceXAI. Grok Bot templates became shareable around 2026-08-29 (dragosroua.com). Nothing shows paid templates or creator payouts as of 2026-09-05 (explainx.ai).
