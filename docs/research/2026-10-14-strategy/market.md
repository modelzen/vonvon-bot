# Vonvon Bot: competitive landscape and positioning (as of 2026-10-14)

## Bottom line

1. **Driving your own agent from your phone is now a free vendor feature. It is a poor place for Vonvon to compete.** Claude Code Remote Control is on Pro, Max, Team and Enterprise. Its server mode runs up to 32 concurrent sessions and it sends push notifications ([docs](https://code.claude.com/docs/en/remote-control.md)). Codex has had remote control from the ChatGPT phone app since 2026-05-14, on all plans including Free ([9to5mac](https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/); [docs](https://learn.chatgpt.com/docs/remote-connections.md)). Paseo and Happy cover the same ground for free as open source.
2. **"A team channel shares one agent" is now a vendor feature too, but only in Slack and only in vendor cloud sandboxes.**
   - Claude Tag (Slack, Team/Enterprise plans, ephemeral sandbox, one shared identity per channel) ([docs](https://claude.com/docs/claude-tag)).
   - Copilot in Slack: shared sessions in a cloud sandbox, preview since 2026-08-21 ([changelog](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack)).
   - Slack Code channels for agents, since 2026-08-20 ([The New Stack](https://thenewstack.io/slack-code-agent-channels/)).
   - Codex in Slack, which runs in Codex Cloud ([docs](https://learn.chatgpt.com/docs/third-party/slack)).
   - None of these supports Feishu, and Anthropic does not serve mainland China, Hong Kong or Macau ([supported countries](https://www.anthropic.com/supported-countries)).
3. **Inside Feishu, the bridge is a small player, and Feishu itself is shipping the building blocks.** Monthly npm downloads (2026-09-13 to 2026-10-12):

   | Package | Downloads |
   |---|---:|
   | `@modelzen/feishu-codex-bridge` | 1,106 |
   | `botmux` | 16,636 |
   | `cc-connect` | 5,808 |
   | `lark-channel-bridge` | 4,077 |
   | `@openclaw/feishu` | 70,001 |

   Feishu's own pieces are the official `@larksuite/channel` SDK (48,541 a month), `lark-cli` (465,927 a month), an official OpenClaw plugin, and aily, which can now take in third-party local agents.
4. **Bridge users ask for team collaboration, scheduled delivery and more agents or models.** No external user has asked for a desktop app, accounts or a remote relay (section 2).
5. **Vonvon's real differentiation is narrow but real.** It is Feishu-native team workflows on a machine the team controls, using the subscriptions or domestic models the team already pays for. On top of that come native-protocol run cards, OS-enforced permission tiers, native Windows support and deep Codex features. The cloud accounts, encrypted relay and much of the daemon, desktop and service work are complexity copied from Paseo. Paseo needs it because it is a remote-client product. Vonvon is not one, because Feishu is already its remote client.
6. **Recommended first release:** feature parity with the bridge, a one-command import, three team features, scheduled tasks, and one generic ACP engine with custom model support. Cut V10 and V11, defer the Electron app, and shrink the service and permission acceptance work to what competitors ship.

---

## 1. Landscape

### 1a. Vendor first-party offerings

| Product | For | Where the agent runs | Chat surface | Team or solo | Multi-agent | Pricing | Date and traction |
|---|---|---|---|---|---|---|---|
| Claude Code Remote Control | Claude subscribers | **User's machine** | claude.ai/code, Claude mobile app | Solo (one account) | Claude only | Pro, Max, Team, Ent; **no API keys; off when `ANTHROPIC_BASE_URL` points at a non-Anthropic host** ([docs](https://code.claude.com/docs/en/remote-control.md)) | Announced 2026-02-24 ([Gigazine](https://gigazine.net/gsc_news/en/20260225-claude-code-remote-control)); server mode up to 32 sessions, worktrees, push |
| Claude Code Channels | Claude subscribers | User's machine (running session) | Telegram, Discord, iMessage; custom channels possible | Solo with allowlist | Claude only | Research preview; only allowlisted channel plugins ([docs](https://code.claude.com/docs/en/channels.md)) | 2026-03-20 ([Implicator](https://implicator.ai/anthropic-ships-its-openclaw-rival-connecting-claude-code-to-telegram-and-discord)) |
| Claude Tag (replaces Claude in Slack) | Organizations | Anthropic sandbox; can route to self-hosted runners ([docs](https://code.claude.com/docs/en/self-hosted-environments.md)) | Slack | **Team, one shared channel identity** | Claude only | Team/Ent; usage-billed with spend limit ([docs](https://claude.com/docs/claude-tag)) | Beta 2026-06-23 ([Techstrong](https://techstrong.ai/articles/anthropic-launches-claude-tag-to-turn-slack-channels-into-agentic-ai-workspaces/), secondary) |
| Codex remote in ChatGPT mobile | ChatGPT users | User's machine (Codex app on macOS or Windows; SSH hosts) | ChatGPT iOS/Android | Solo; "no shared team sessions" | Codex only | All plans incl. Free and Go | 2026-05-14 ([9to5mac](https://9to5mac.com/2026/05/14/openai-brings-codex-control-to-chatgpt-for-iphone-and-android/); [docs](https://learn.chatgpt.com/docs/remote-connections.md)) |
| Codex in Slack | ChatGPT workspaces | **Codex Cloud** (workspace-shared environment) | Slack (`@ChatGPT`) | Team, but approvals stay private to the requester | Codex only | Bundled with ChatGPT plans (price details only from third parties, e.g. [Jetadmin](https://www.jetadmin.io/blog/codex-pricing-current-costs-usage-limits-and-realistic-budgets-2026/)) | [docs](https://learn.chatgpt.com/docs/third-party/slack) |
| Cursor Cloud Agents | Cursor teams | Cloud VMs; self-hosted machines and team pools since 2026-09-02 | Slack, Linear, GitHub/Bitbucket, iOS, web, API | Team | Many models, one harness | Paid plan plus API-priced usage ([docs](https://cursor.com/docs/cloud-agent)) | [changelog](https://cursor.com/changelog/self-hosted-machines) |
| GitHub Copilot in Slack | GitHub organizations | Cloud sandbox | Slack, Slack Code channels | **Team, shared sessions** | Copilot only | Copilot Business/Enterprise | Preview 2026-08-21 ([changelog](https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack)) |
| Devin | Teams | Cloud VM | Slack, Linear, Jira | Team | Devin only | Third-party reports: Free, Pro $20, Max $200, Teams $80 plus $40/seat (July 2026), **unverified** ([Automation Atlas](https://automationatlas.io/answers/devin-pricing-explained-2026/)); devin.ai/pricing returned 404 | — |
| Kiro Crew | Developers | Gateway runs on the user's configured machine | Slack (Socket Mode) | **Single owner only**; non-owner messages dropped | Kiro | Credit plans from $20 (third-party) | Doc updated 2026-09-25 ([docs](https://kiro.dev/docs/crew/interfaces/slack/)) |

**Pattern.** The vendors split cleanly into two groups:
- **Solo remote control runs on your machine.** Claude Remote Control, Claude Channels and Codex mobile are all tied to one person's account.
- **Team chat runs in the vendor's cloud.** Claude Tag, Codex in Slack, Cursor, Copilot and Devin are all Slack-first and enterprise-billed.

Nobody offers team chat on a local machine, in Feishu, with domestic models.

### 1b. Independent remote clients

| Product | For | Runs | Surface | Team | Multi-agent | Pricing | Traction |
|---|---|---|---|---|---|---|---|
| Paseo | Developers running many agents | User's machine (daemon); optional end-to-end encrypted relay | Desktop, iOS/Android, web, CLI; Paseo Hub adds Slack, GitHub and Discord triggers ([Hub docs](https://paseo.sh/docs/hub/self-hosting/slack-app.md)) | Partial (Hub) | Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, Muse Code, plus ACP | Free and open source; funded by sponsors and Hub ([site](https://paseo.sh)) | 20,810 stars; `@getpaseo/cli` grew from 3,212 in March to 51,107 in September |
| Happy | Subscription users | User's machine; encrypted sync | iOS, Android, web, desktop | **"Natively multiplayer"**: invite a colleague into a session | Claude, Codex, Grok | Free, MIT ([README](https://github.com/slopus/happy)) | 24,131 stars; README badges claim 4.9 stars from 1,000+ App Store ratings |
| Omnara | Was a mobile console for Claude Code and Codex | Was the user's machine | Mobile and web | — | — | At its 2025 launch: free for 10 sessions, then $20 a month ([YC page](https://ycombinator.com/companies/omnara)) | Repo now reads "open-source managed agent platform" ([README](https://github.com/omnara-ai/omnara)). **A pivot is inferred, not announced.** |

### 1c. Feishu and Chinese-IM coding bridges (open source)

Stars are from the GitHub API on 2026-10-14. Downloads are npm, last month.

| Project | Stars | npm/month | What it is | Notes |
|---|---:|---:|---|---|
| [cc-connect](https://github.com/chenhg5/cc-connect) | 15,918 | 5,808 (peak 26,743 in May) | Go hub; 13 IM platforms; 10+ agents plus ACP; cron; multi-bot relay; web admin on :9820 | Sponsored by Kimi and about 15 API-relay resellers, which is how this category monetizes |
| [botmux](https://github.com/deepcoldy/botmux) | 1,638 | 16,636 | **Feishu-only**; 20+ CLIs driven through a terminal emulator and tmux; multi-bot groups; separate per-person sessions in one group; multi-topic orchestration; web terminal; schedules and webhooks; on-call mode | **No native Windows** ("请在 WSL2 里安装"); releases almost daily (v3.43.0 on 2026-10-14) |
| [lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (`lark-channel-bridge`) | 2,691 | 4,077 (peak 18,285 in July) | Claude or Codex; streaming card; doc comments; QR setup of a "PersonalAgent" app; services on all three OSes | Author has 14.7k GitHub followers, so it spreads through an influencer |
| [OpenClaw](https://github.com/openclaw/openclaw) plus Feishu plugins | 391,931 | `@openclaw/feishu` 70,001; `@larksuite/openclaw-lark` 9,727 | General personal agent; the official Feishu plugin launched 2026-03-05 with topic-per-session and streaming cards ([feishu.cn](https://www.feishu.cn/content/article/7613711414611463386)) | Not coding-specific, but it set what Feishu users expect a bot to do |
| [cc-haha](https://github.com/NanmiCoder/cc-haha) | 15,001 | — | Local desktop workbench with WeChat, Feishu and DingTalk remote access | Desktop app for people who don't use a CLI |
| [Claude-to-IM-skill](https://github.com/op7418/Claude-to-IM-skill) | 2,892 | — | Claude or Codex to Telegram, Discord or Feishu | Stale since 2026-03-23 |
| **feishu-codex-bridge** | **81** | **1,106** | Codex plus Claude; group = project, topic = session | See section 2 |

### 1d. Chinese platform vendors

- **Feishu**
  - `lark-cli` was open-sourced 2026-03-25 and has 17,662 stars ([repo](https://github.com/larksuite/cli)).
  - `@larksuite/channel` was first published 2026-06-04 ([npm](https://www.npmjs.com/package/@larksuite/channel)). It handles connection management, message normalization, policy, streaming cards and QR app registration ([README](https://github.com/larksuite/channel-sdk-node)). **The Feishu plumbing is now commodity.**
  - The aily upgrade on 2026-07-23 added team-shared agents in project groups and multi-agent work, and can take in "approved third-party local agents" ([Xinhua](https://www.news.cn/tech/20260723/5a84c09560134a5c9937a825773fba95/c.html)). How that third-party connection works is not public, and that is a platform risk.
- **DingTalk Wukong** (2026-03-17): DingTalk was rebuilt so the agent drives it through CLI commands, and Wukong can be invoked remotely from a computer or phone. Coding is not its focus ([China Daily](https://cn.chinadaily.com.cn/a/202603/17/WS69b96b88a310942cc49a3af7.html)).
- **Tencent WorkBuddy** (2026-03-09): a desktop agent built on CodeBuddy that you remote-control from WeCom, QQ, Feishu or DingTalk. It uses domestic models and gives 5,000 free credits ([IT之家](https://www.ithome.com/0/927/230.htm)).
- **ByteDance TRAE SOLO mobile** (around early May 2026): shared context across phone, desktop and web, plus scheduled tasks and Feishu docs through `lark-cli`. Where it executes is not stated ([掘金](https://juejin.cn/post/7637058516456652834)).

## 2. Demand signals from feishu-codex-bridge

**Downloads** ([last-week](https://api.npmjs.org/downloads/point/last-week/@modelzen/feishu-codex-bridge), [last-month](https://api.npmjs.org/downloads/point/last-month/@modelzen/feishu-codex-bridge), [last-year](https://api.npmjs.org/downloads/point/last-year/@modelzen/feishu-codex-bridge)):
- Last week (10-06 to 10-12): **108**. Last month: **1,106**. Last year: **11,495**.
- By month: May (from 5/29) 362, **June 6,110**, July 3,072, August 675, September 1,115. The peak week was 2026-06-08 at 2,363.
- The China mirror npmmirror adds 910 downloads in total since launch.
- GitHub: 81 stars and 22 forks. The last release was 0.6.14 on 2026-09-24.
- The vonvon-bot package is not on npm (the registry returns 404).

**Category trend** (npm monthly, [range API](https://api.npmjs.org/downloads/range/2026-03-01:2026-09-30/botmux)):

| | Mar | Apr | May | Jun | Jul | Aug | Sep |
|---|---:|---:|---:|---:|---:|---:|---:|
| cc-connect | 9,189 | 13,532 | 26,743 | 22,004 | 15,042 | 9,867 | 5,792 |
| botmux | 6,273 | 4,270 | 20,937 | 20,037 | 20,830 | 20,732 | 14,176 |
| lark-channel-bridge | — | — | 5,970 | 13,937 | 18,285 | 8,767 | 5,356 |
| feishu-codex-bridge | — | — | 362 | 6,110 | 3,072 | 675 | 1,115 |
| @getpaseo/cli | 3,212 | 10,345 | 12,270 | 16,838 | 24,265 | 36,382 | 51,107 |

The IM-bridge category peaked in May to July and is falling, while Paseo's rich client keeps growing. The cause is **unknown**. One hypothesis is the vendors' mobile remote launches (Codex on 05-14, Claude Remote Control on all plans). npm counts include CI runs and automatic updates, and botmux and cc-connect also ship binaries outside npm. **Treat these numbers as directional, not as user counts.**

**Issues and PRs** (`gh issue list -R modelzen/feishu-codex-bridge --state all --limit 100`: 21 issues and 24 PRs; about 9 external authors in 4.5 months):

| Theme | Items | Count |
|---|---|---:|
| **Team and group collaboration** | #8 non-admins can't trigger via doc comments; #43 group members can't fetch a teammate's deliverable files; #5 notify the requester when done (shipped 0.6.9); #10 confusion over "admins only"; PR #3 sender identity in the prompt (merged); PR #19 configurable group context; PR #20 comment-trigger policy | 7 |
| **More agents and models** | #12 Grok via ACP; PR #13 DeepSeek Harness; #24 Kimi quota reset time; #37, #38, #40, #41 model catalog, custom models, `ANTHROPIC_BASE_URL`, qwen | 7 |
| **Proactive or scheduled delivery to a group** | #42 | 1 |
| Media and files (fixed) | #11, #14 | 2 |
| Platform and operations | #1 WSL service; #9 Windows troubleshooting; #6 converting a group between topic and single-session mode | 3 |
| **Desktop app, accounts, cloud, relay** | No external user. Only maintainer #36 ("desktop parity") | **0** |

## 3. Table stakes vs differentiators (Feishu coding bot, October 2026)

| Table stakes (every serious competitor has it) | Real differentiators (few or none have it) |
|---|---|
| Codex plus Claude Code | Feishu-native team semantics: **group = project, topic = session**, the bot creates the group and pins instructions ([bridge README](https://github.com/modelzen/feishu-codex-bridge), lines 71–82) |
| Streaming card, stop button, queued input | **Run cards built from the agent's own protocol** (Codex app-server: steer, goal, compact, quota) instead of terminal screenshots, which is botmux's approach |
| Images and files in, files back out | **OS-enforced permission tiers** that let colleagues trigger an agent on your machine (Codex Seatbelt and Windows sandbox, already in the bridge). botmux has a narrower "file sandbox" |
| Background service on macOS, Linux, Windows; QR app setup | **Native Windows** (botmux is WSL-only) |
| Doc-comment trigger (bridge, lark-channel-bridge) | Works with **domestic models and API relays**. Claude Remote Control explicitly refuses a non-Anthropic `ANTHROPIC_BASE_URL` ([docs](https://code.claude.com/docs/en/remote-control.md)) |
| **Scheduled tasks** (cc-connect, botmux, Claude Tag, TRAE) | Group-level collaboration controls: who may trigger, deliverables posted to the group, who-asked-what audit. Requested in the issues and missing from vendors' Feishu support (they have none) |
| Several agents through ACP (cc-connect, Paseo, botmux) | — |
| Multiple bots in one group (cc-connect, botmux) | — |

## 4. Where Vonvon is actually different, and a product shape to pin down

**Recommended shape:** "飞书群里的 AI 编程同事" (an AI coding teammate in a Feishu group):
- It runs on a machine the team controls, such as a lead's Mac or an always-on Mac mini or devbox.
- It uses the team's existing Codex, Claude Code, Kimi, DeepSeek or Qwen access.
- Anyone the project allows can hand it work in a topic.
- Results and files land back in the group.

The target user is a small Chinese development or product team on Feishu (roughly 3 to 30 people) with code on internal Git, plus the one person who owns the machine.

**Why this shape and not "remote control for me":**
- Solo remote control is owned by Claude, Codex, Paseo, Happy and TRAE. Team chat agents exist, but only in Slack and the vendors' cloud.
- Feishu teams in mainland China get neither: the vendors have no Feishu support, and Anthropic doesn't serve the region.
- The bridge's own users are pulling in this direction (section 2).

**What is not differentiating:**
- Multi-provider breadth. cc-connect lists 10+ agents and botmux 20+.
- A desktop app. cc-haha, WorkBuddy and nexu all have one.
- Remote management. Feishu itself is the remote client, and the bridge already has a DM menu that serves as a console (README line 79).
- "Copying Paseo" is not a market position. Paseo is free, growing fast, and already adds Slack triggers.

**Terms risk for the team shape:**
- Anthropic's consumer terms say "You also may not make your Account available to anyone else" ([terms](https://www.anthropic.com/legal/consumer-terms)).
- The Agent SDK docs say third parties may not "offer claude.ai login or rate limits for their products… including agents built on the Claude Agent SDK" without approval ([docs](https://code.claude.com/docs/en/agent-sdk/overview.md)).
- A group sharing one person's Pro or Max account is therefore exposed. Treat API keys and custom base URLs or domestic coding plans as first-class.
- I could not fetch OpenAI's terms (blocked), so the equivalent Codex question is **unknown**.

**Platform risk.** Feishu now ships `@larksuite/channel`, the OpenClaw plugin, and aily connecting local agents. The defensible part is coding depth that Feishu won't build: protocol-level cards, sandbox tiers, process hygiene, and the project = group model.

## 5. Planned features: what differentiates and what is copied-in complexity

| Planned item | Verdict | Reason |
|---|---|---|
| Daemon as single writer with a WebSocket API (V3, merged) and local web UI (V4, merged) | **Keep (done)** | The bridge and cc-connect already have local web consoles; this is table stakes |
| Electron desktop: window, tray, updater, packaging (V5a) | **Defer** | No external demand. Signing, notarization and auto-update cost a lot. If non-developer onboarding becomes the goal, a single-binary installer like botmux's is cheaper |
| System service with Gate L/M, drain rounds and a four-step manager-owner proof (V5b, 12 of 15 sub-PRs per #285) | **Simplify** | The bridge already had launchd, systemd and Windows services. Competitors ship plain per-profile services (lark-channel-bridge README). Make acceptance "survives reboot, restarts on crash, uninstall leaves nothing" ([architecture.md:55](docs/architecture.md)) |
| Process holder and orphan cleanup (V6a) | **Keep, scoped to real bugs** | Maintainer issues #31 and #33 are real leaks, and users notice them |
| Provider layer redesign (V6a/V6b, 14 sub-PRs per #281) | **Keep the core, ship Codex and Claude first** | Parity matters before breadth |
| Six providers (Codex, Claude, Cursor, Grok, Pi, custom ACP) ([roadmap.md:20](docs/roadmap.md)) | **Reorder** | Codex, then Claude with custom models and base URL, then **one generic ACP engine** (Grok #12; Kimi CLI, Qwen Code, OpenCode if they speak ACP, unverified). There is no issue evidence for Cursor or Pi |
| Permission table proven cell by cell: provider × 3 tiers × 2 read scopes × OS, up to 108 cells ([architecture.md:129](docs/architecture.md)) | **Simplify** | Trust is a real differentiator for team use. But the cell-by-cell proof requirement blocks shipping. Ship Codex's existing OS-sandbox tiers, give other agents full access with a clear warning, and add proofs later |
| Bridge import (V8/V9) | **Keep and move earlier** | It is the only way current users switch |
| Accounts and machine list (V10) ([roadmap.md:25](docs/roadmap.md)) | **Cut or defer indefinitely** | No demand. It needs a cloud service whose hosting platform isn't chosen ([roadmap.md:125](docs/roadmap.md)) |
| Encrypted remote relay (V11) | **Cut** | Paseo, Happy and the vendors own remote clients, and Feishu already is one. The roadmap accepts an unauthenticated key exchange and MITM risk ([roadmap.md:121](docs/roadmap.md)) |

**On the four days of work.** None of the 26 commits on main dated 2026-10-13 and 10-14 adds anything a Feishu user would see (`git log`). #249 is a security fix for a bridge path bug (#114); the rest is service transactions, the process holder, desktop scaffolding, CI and handoff tooling.

## 6. What a first release must contain to beat staying on the bridge

**Vonvon Bot 1.0 = bridge 0.6.14 parity + import + the following:**

1. **Publish to npm with no regressions** on Codex and Claude: cards, steer, goal, files, doc comments, completion reminders, multiple bots, services.
2. **`vonvon import feishu-codex-bridge` in one command**, with the old service stopped.
3. **Team mode per project:**
   - Who may trigger the bot, including from doc comments (#8, PR #20).
   - Final deliverables posted automatically to the topic from an admin-approved folder (#43).
   - Requester attribution and an audit of who ran what (PR #3 is already in).
   - Configurable group context (PR #19).
4. **Scheduled tasks bound to a group or topic** that post text and attachments, with receipts and no duplicate delivery (#42). This is table stakes now.
5. **A generic ACP engine plus custom model and base-URL support**, covering Grok and the domestic-model requests (#12, #24, #37–#41).
6. **A safety story for team use:** sandbox tiers where they are proven, a plain-language "full access" warning elsewhere, and who-ran-what visible in the group.

**Explicitly out of 1.0:** the Electron app, accounts, the relay, Cursor and Pi engines, Windows and Linux permission proofs, and Gate L/M-level service proofs.

**How to judge it:** weekly npm downloads against the 108 a week baseline, imports completed, and new issues per theme. There is no telemetry, so these are proxies.

## 7. Unknowns and caveats

- **npm downloads are not users.** They include CI and mirrors, and binaries ship outside npm. Why the category declined after July is unknown.
- **Unverified third-party pricing:** Devin, Kiro and Codex prices; Omnara's current pricing and its pivot.
- **OpenAI's account-sharing terms** could not be fetched.
- **Feishu "PersonalAgent" app type:** no official documentation found, including whether it skips admin review.
- **aily's "third-party local agent" connection:** no details are public.
- **TRAE SOLO:** where it executes is not stated.
- **Claude Tag launch date:** comes from secondary press.
- **Claude Channels:** whether a custom Feishu channel could get off Anthropic's preview allowlist is unknown.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report's raw data mostly checks out; its positioning argument does not. Re-checked 2026-10-14 against primary sources.

**What checks out**
- Every npm count and monthly trend figure (api.npmjs.org).
- GitHub star counts, within 1 to 3.
- The bridge's 21 issues and 24 PRs.
- The vendor doc quotes on Claude Remote Control, Claude Tag, Copilot in Slack, Codex in Slack and Kiro Crew.
- Anthropic's region list, account-sharing clause and Agent SDK login clause.
- 26 commits on main dated 10-13 and 10-14.

**What is wrong or overstated**
1. **The central gap claim is false.** The report says no one offers team chat on a local machine, in Feishu, with domestic models. botmux already does this (on-call groups any member can @, multiple bots per group, Kimi/DeepSeek/MiniMax adapters, a bubblewrap sandbox), and so does cc-connect. Paseo Hub, Claude Tag self-hosted runners and Cursor team pools also run team-triggered agents on customer machines.
2. **Two named differentiators are weaker than stated.**
   - Native Windows: cc-connect ships Windows binaries and lark-channel-bridge installs a Windows Task Scheduler task.
   - OS permission tiers: botmux has an OS-level sandbox for its group on-call mode.
3. **The demand signal is thin.** About 12 external people in total. One user wrote four of the "more models" items, and those are bug reports. Another user wrote the scheduling and deliverables asks.
4. **Smaller factual fixes.**
   - The "no shared team sessions" quote for Codex could not be found.
   - Codex Free/Go access is supported only by press coverage.
   - Remote Control is not on all plans; Free is excluded.
   - 32 sessions is a default, not a cap.
   - #249 does change behavior a Feishu user can see.
   - Some file:line citations are off: roadmap.md:20 should be :40, and "108 cells" is the report's own arithmetic.
5. **Four "unknowns" are resolvable.** Claude Tag's launch date has a primary source, Devin's pricing page is readable, Omnara's YC page states the pivot, and Team/Enterprise admins can allowlist a custom channel plugin.

**Net effect**
The advice to cut V10/V11, defer Electron and move bridge import earlier still holds. The recommended product shape, an AI coding teammate in a Feishu group, needs a head-to-head with botmux before the owner adopts it. Vonvon's real edge is narrower than the report says: Codex-native protocol cards, macOS and Windows sandbox tiers, and the migration path for existing bridge users.


### 逐条复查

- **属实**：Claude Code Remote Control is on Pro, Max, Team and Enterprise. It doesn't accept API keys and switches off when ANTHROPIC_BASE_URL points at a non-Anthropic host. Server mode runs up to 32 concurrent sessions, supports worktrees and sends push notifications. Section 2 also says 'Claude Remote Control on all plans'.
  - 依据：https://code.claude.com/docs/en/remote-control.md (fetched 2026-10-14): 'available on Pro, Max, Team, and Enterprise plans. API keys are not supported. On Team and Enterprise, an Owner must first enable the Remote Control toggle'. On ANTHROPIC_BASE_URL: 'You point ANTHROPIC_BASE_URL at a host other than api.anthropic.com ... Unset the variable to use Remote Control'. Flags: '--capacity <N> Maximum number of concurrent sessions. Default is 32' and '--spawn worktree'. The page also has a 'Mobile push notifications' section.
- **说过头了**：Codex has had remote control from the ChatGPT phone app since 2026-05-14, on all plans including Free and Go, with 'no shared team sessions'.
  - 依据：Engadget, 2026-05-14 (https://engadget.com/2173235/openai-brings-its-codex-coding-app-to-mobile): available to 'all ChatGPT users, including those using the chatbot through OpenAI's Go and Free tiers'. 9to5mac, 2026-05-14: 'Rolling out today as a preview'; Windows hosts 'coming soon'. https://learn.chatgpt.com/docs/remote-connections.md names no plans and has no 'no shared team sessions' text (grepped for 'shared'/'team'). It now lists Mac or Windows hosts plus SSH hosts.
- **属实**：Claude Tag is Slack-only on Team and Enterprise, runs in an ephemeral sandbox, has one shared identity per channel, is usage-billed with a spend limit, replaces Claude in Slack, and can route to self-hosted runners. The launch date comes only from secondary press.
  - 依据：https://claude.com/docs/claude-tag: 'available on Team and Enterprise plans ... isn't available on individual plans'; 'runs in an ephemeral sandbox, not on your computer'; 'Channel work bills by usage ... under a spend limit'. https://claude.com/docs/claude-tag/concepts/agent-identity: 'In Slack channels ... Claude acts with its own service accounts'. https://www.anthropic.com/news/introducing-claude-tag, dated Jun 23 2026: 'Claude Tag replaces the existing' Claude in Slack app; 'one Claude that interacts with everyone'. https://code.claude.com/docs/en/self-hosted-environments.md: 'Claude Tag sessions can run in them too' (public beta on Team/Enterprise, off by default).
- **有误**：Pattern: team chat runs in the vendor's cloud, and 'Nobody offers team chat on a local machine, in Feishu, with domestic models.' Section 4: 'Team chat agents exist, but only in Slack and the vendors' cloud.'
  - 依据：botmux, running locally (github.com/deepcoldy/botmux README): line 75 'Oncall 模式 — 拉进 oncall 群，任何成员 @ 即在项目目录排查'; line 69 several bots in one group; line 97 adapters include kimi, dsh (DeepSeek), minimax and coco (TRAE). cc-connect README line 54: 'bring Kimi CLI from your local machine into Feishu/Lark'; line 249: Multi-Bot Relay in group chats. Paseo Hub (https://paseo.sh/docs/hub.md): 'Your daemons keep running agents where they always did', with triggers from GitHub, Slack and Discord and 'One place for your team to see all of it'. Claude Tag can run on self-hosted environments (self-hosted-environments.md). Cursor shipped self-hosted machines and team pools on 'Sep 2, 2026' (cursor.com/changelog/self-hosted-machines).
- **说过头了**：Native Windows is a real differentiator (few or none have it); botmux is WSL-only.
  - 依据：botmux README line 45: 'Windows 请在 WSL2 里安装 ... 原生 Windows 跑不了' (confirmed). But cc-connect v1.5.0 (2026-08-16) ships cc-connect-v1.5.0-windows-amd64.zip and windows-arm64.zip (gh api releases/latest). lark-coding-agent-bridge README lines 85-87 install a 'Windows: Task Scheduler task LarkChannelBridge.Bot.<profile>'. The report's own table 3 lists Windows services as table stakes.
- **说过头了**：OS-enforced permission tiers set Vonvon apart; botmux has a narrower 'file sandbox'.
  - 依据：botmux README line 85: an on-call sandbox ('sandbox: true/oncall、读隔离、BOTMUX_SANDBOX') plus a full-root copy-on-write 'scratch' mode. Line 119: 'Linux 开启 sandbox 前需安装 bubblewrap，隔离建立失败时会拒绝启动'.
- **属实**：npm downloads for 2026-09-13 to 2026-10-12: feishu-codex-bridge 1,106; botmux 16,636; cc-connect 5,808; lark-channel-bridge 4,077; @openclaw/feishu 70,001; @larksuite/channel 48,541; 'lark-cli' 465,927. Also the monthly trend table, bridge figures of 108 a week and 11,495 a year, and vonvon-bot returning 404 on npm.
  - 依据：api.npmjs.org/downloads/point/2026-09-13:2026-10-12 returned exactly those figures, and 465,927 for @larksuite/cli. The range API for 2026-03-01 to 2026-09-30 matches every cell of the trend table. Bridge: last-week 108, last-year 11,495. registry.npmjs.org/vonvon-bot returned 404. Bridge latest is 0.6.14, published 2026-09-24. @larksuite/channel was created 2026-06-04.
- **属实**：GitHub stars and activity: cc-connect 15,918; botmux 1,638 with v3.43.0 on 2026-10-14; lark bridge 2,691; OpenClaw 391,931; cc-haha 15,001; Claude-to-IM 2,892, stale since 2026-03-23; bridge 81 stars and 22 forks; Paseo 20,810; Happy 24,131; lark-cli 17,662, open-sourced 2026-03-25.
  - 依据：gh api repos/* on 2026-10-14: 15918, 1638, 2691, 391931, 15000, 2892 (pushed 2026-03-23T17:03Z), 81 with 22 forks, 20813, 24131, and 17662 (created 2026-03-25). botmux v3.43.0 was published 2026-10-14T03:52Z. Happy README: 'Natively multiplayer. Invite a colleague or a friend into the session.'; 'Rated 4.9 stars from 1,000+ ratings'.
- **属实**：Terms risk: Anthropic consumer terms say 'You also may not make your Account available to anyone else'; the Agent SDK bars third parties from offering claude.ai login or rate limits without approval; Anthropic doesn't serve mainland China, Hong Kong or Macau.
  - 依据：https://www.anthropic.com/legal/consumer-terms (effective October 8, 2025) contains the exact sentence. https://code.claude.com/docs/en/agent-sdk/overview.md: 'Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.' https://www.anthropic.com/supported-countries lists none of the three regions (Taiwan, Japan and Singapore are listed).
- **说过头了**：Bridge demand: 21 issues and 24 PRs from about 9 external authors in 4.5 months. Seven items on team collaboration and seven on more agents and models. No external user asked for a desktop app, accounts or a relay; only the maintainer's #36.
  - 依据：gh issue list and gh pr list on modelzen/feishu-codex-bridge: 21 issues and 24 PRs (confirmed). ClayCheung is the maintainer (235 commits) and authored #36 plus desktop PRs #30, #32 and #35. Non-maintainer authors: 9 across issues, 12 across issues and PRs. The seven model items come from 3 people. #37, #38, #40 and #41 are all bug reports from one user (langhua425) about model-catalog fallback and a default port, not feature requests. #23, #24, #42 and #43 all come from one user (asuka-rei-froverEVA); #42 says they already ran scheduled delivery with external Codex desktop schedules plus lark-cli. #10 is a config confusion rather than a team feature.
- **说过头了**：None of the 26 commits on main dated 2026-10-13 and 10-14 adds anything a Feishu user would see. #249 is a security fix for a bridge path bug (#114).
  - 依据：git log --since=2026-10-13 main: 26 commits (confirmed). #249 is titled 'feat(outbound): add the outbound address policy, path gate, and gated remote images (V6a 4/6)'. Its body has a '用户可见的变化' section: 'full 项目在网络开关关闭时，不再拉取远程图片', plus private-address blocking for remote card images. #114 ('Outbound images: symlink escapes the cwd check, and remote fetch ignores the project network setting') is still OPEN. Five of the 26 are process or docs commits (#235, #238, #239, #240, #277). #248 builds a vonvon-bot npm package that has never been published (registry 404).
- **说过头了**：File citations: architecture.md:55 (service acceptance), architecture.md:129 (up to 108 permission cells), roadmap.md:20 (six providers), roadmap.md:25 (V10), roadmap.md:121 (MITM accepted), roadmap.md:125 (cloud platform not chosen); '12 of 15 per #285'; '14 sub-PRs per #281'.
  - 依据：/home/operator/vonvon/vonvon-bot/docs/architecture.md:55 reads only 'V5 的系统服务设计要点如下。'. architecture.md:129 has the per-provider, per-tier, per-read-scope, per-OS cell rule, but the number 108 appears nowhere in the docs. docs/roadmap.md:20 is the V6d row; the six-provider list is at roadmap.md:40. roadmap.md:26 is V11 and :25 is V10 (correct). :121 accepts the MITM risk (correct). :125 says '云端的部署平台还没定' (correct; also architecture.md:185). gh pr list: #285 is 'V5 12/15' and #281 is 'V6b 1/14' (correct).
- **有误**：Unknowns: the Claude Tag date has only secondary sources; Devin pricing is unverified (devin.ai/pricing returns 404); Omnara's pivot is inferred, not announced; whether a custom Feishu channel could leave Anthropic's Channels preview allowlist is unknown.
  - 依据：anthropic.com/news/introducing-claude-tag is dated Jun 23 2026. curl of https://devin.ai/pricing on 2026-10-14 returned 200 and shows 'Free $0', 'Pro $20 per month', 'Max $200 per month', 'Teams $80 /month for team plan + $40/mo per full dev seat'; WebFetch alone got 404. The Omnara YC page now says 'Omnara is an open-source, model-agnostic control plane for managed agents' and 'completely free' on your own compute; the 2025 '10 sessions then $20' pricing is no longer on it. https://code.claude.com/docs/en/channels.md: Team and Enterprise admins can set allowedChannelPlugins to 'approve channels from your own internal marketplace'. Pro and Max users get the Anthropic list or --dangerously-load-development-channels. Channels also accept a Console API key.
- **属实**：Other vendor rows: Copilot in Slack (preview 2026-08-21, shared sessions, cloud sandbox, Business/Enterprise); Codex in Slack (Codex Cloud, @ChatGPT, approvals private to the requester); Kiro Crew (single owner, non-owner messages dropped, Socket Mode, doc updated 2026-09-25); aily on 2026-07-23 taking in 'approved third-party local agents'; Feishu's official OpenClaw plugin on 2026-03-05 with topic-per-session and streaming cards.
  - 依据：github.blog/changelog/2026-08-21: 'in public preview', 'Agent sessions in Slack are shared', 'secure cloud sandbox', 'Copilot Business and Copilot Enterprise', with Slack Code as a launch partner. learn.chatgpt.com/docs/third-party/slack: 'Cloud delegation requires an eligible workspace-shared environment', 'private approval card', '@ChatGPT'. kiro.dev/docs/crew/interfaces/slack: 'locked to KIROCREW_OWNER_ID', 'silently dropped', Socket Mode, 'Page updated: September 25, 2026'. news.cn 2026-07-23: '支持接入符合要求的第三方本地Agent和企业自建Agent'. feishu.cn article dated 2026-3-5, 'OpenClaw飞书官方插件上线'.

### 正文遗漏的事实

- Compare Vonvon directly with botmux. botmux already ships the recommended '飞书群里的 AI 编程同事' shape: on-call groups where any member can @ it, several bots per group, Kimi/DeepSeek/MiniMax/TRAE adapters, schedules, webhooks, a dashboard, self-serve group creation (README line 182), a bubblewrap sandbox, and almost daily releases. The report lists these features but never draws the conclusion.
- Paseo Hub: a hosted Hub account 'needs no card and does not expire', it triggers agents on users' own daemons from GitHub/Slack/Discord, and it gives the team one activity view (paseo.sh/docs/hub.md). Paseo is moving into team-triggered local agents, and adding a Feishu trigger would be a small step for it.
- Claude Tag already runs on customer self-hosted runners (Team/Ent beta), and Anthropic says it wants to bring Claude Tag to 'the many other places they work' (anthropic.com/news/introducing-claude-tag, 2026-06-23). Claude Tag's channel sessions bill to the organization under a service identity, which is the vendor's own answer to the account-sharing problem.
- A sanctioned Claude path exists for a Feishu bridge. Claude Code Channels accept a Console API key, and Team/Ent admins can allowlist internal channel plugins (code.claude.com/docs/en/channels.md). This bears on the terms-risk recommendation.
- Anthropic consumer terms (effective 2025-10-08) also restrict access 'through automated or non-human means, whether through a bot, script, or otherwise' except via an API key or explicit permission.
- Several Vonvon assets already exist and aren't counted. Open PR #226 'feat: add Bridge import transaction and recovery contract'. #248 builds the vonvon-bot npm package, which is unpublished. Open desktop PRs #2 ('deliver 0.7.0 setup, collaboration and scoped settings') and #9-#19 in vonvon-bot, plus bridge PRs #30/#32/#35 adding a vonvon command and desktop. Something the owner can try may be closer than the report implies.
- OpenClaw core had 16,434,626 npm downloads in the same 30 days. @openclaw/feishu (70,001) is community-maintained, so it measures OpenClaw's audience, not Feishu-official adoption.
- Codex remote control now supports Windows hosts as well as macOS and SSH (learn.chatgpt.com/docs/remote-connections.md), which widens the vendors' solo coverage beyond what the table states.
- Remote Control and Channels are both off by default on Claude Team/Enterprise until an Owner enables them. Organizations Vonvon targets may hit admin friction with the vendor tools too.
