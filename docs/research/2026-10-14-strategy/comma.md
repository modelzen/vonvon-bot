# AFK-SURF/comma: reference report (read-only review, 2026-10-14)

Paths are relative to `/home/operator/vonvon/references/comma` unless written as absolute. I did not run or build any of its code.

## Summary

- Comma is a hosted personal agent with an open-source (AGPL) server you can run yourself. You talk to one coordinating agent (the "Router") per workspace, and it sends larger work out as Tasks to Worker agents. It does not tie a session to a chat or topic. It also offers a Mac app and a device connector that can run Codex or Claude Code on your Mac (README.md:31-73, docs/architecture/PRODUCT_MODEL.md:96-129).
- The personal Comma product does not open Feishu: "Feishu is not open for installation in Comma yet" (systems/apps/comma_core/lib/comma/plugins.ex:115-116). Its chat channels are Telegram, private WeChat (through ClawBot), private iMessage, Signal and Slack.
- The same monorepo has a team product, **Bridge For Teams (BFT)**, which does connect a Feishu group bot to an "External Codex" agent running on a team Mac. That is the closest overlap with Vonvon. BFT is invite-only with SSO, and the self-host compose file does not include it (compose.yaml:10).
- It is very large and mature, but the public history is shallow. The public repo has 5 commits from 2026-09-30 to 10-02, all mirror syncs of a private repo. The code is roughly 0.6M lines of Elixir, 0.6M lines of Elixir tests, 107k Go, 79k Lean, about 670k TypeScript and 52k Swift.
- AGPL-3.0-only means Vonvon cannot copy its code into the MIT daemon (`/home/operator/vonvon/vonvon-bot/packages/daemon/package.json:63`). Ideas can be reused by writing your own code. `spinfoam` is a separate MIT repo and is safe to use.

---

## 1. The product from a user's view

**Core idea.** "Conversations are just interfaces. Tasks are the persistent execution state" (README.md:31-34). Quick questions get answered in chat, and bigger requests become Tasks. Each Task runs a plan, execute, review and verify loop until it is done (README.md:36-39, 56-58).

- **Sessionless in concrete terms:** each configured Router has exactly one long-running session. Every chat, Task notification and platform message for that workspace goes into it (PRODUCT_MODEL.md:96-118). Messages that arrive from Slack, Feishu, Telegram, WeChat or Signal go straight into that one Router session (PRODUCT_MODEL.md:129). This is the opposite of Vonvon's "one topic = one session" (`/home/operator/vonvon/vonvon-bot/docs/architecture.md:7`).
- **Board:** Tasks move through Backlog, In progress, Needs Review and Done (README.md:61-62). Automated success stops at `ready_for_review`. A Task only becomes `completed` after a person accepts the exact version they reviewed (PRODUCT_MODEL.md:27-28). Each Task has one responsible Worker. The Router owns the status, and Workers post the result messages (docs/salix/tasks-background-execution.md:17-25).
- **Loops:** small integer-only C programs that the agent writes itself. They are compiled with an embedded TinyCC-to-eBPF compiler and run inside the `spinfoam` VM. A Loop watches timers, webhooks or Composio triggers and wakes the agent only through `agent.notify` (tasks-background-execution.md:39-49, 77-90). "A quiet hour uses no large-model tokens" (README.md:65-67). Wake-ups are capped at 6 per 10 minutes per Loop, and quotas are 20 Loops per Agent and 100 per Group (tasks-background-execution.md:65, 102).
- **Routines:** scheduled briefings built from GitHub, Slack, Notion, Gmail, Calendar and Linear. Each run has a 480-second budget and an output cap of six cards (docs/product-features.md:80-185). Comma also "writes first", meaning it can message you proactively (README.md:63-64).
- **Salix device bridge.** "Salix" is the runtime's name. The device agent is the Go program `salix-connect --device`. It starts read-only and finds local agents without starting them. Only after you turn on **Allow operations** can it change files, run commands, and hand work to Codex, Claude Code, Pi or Kimi (README.md:68-70, systems/connector/README.md "Run it"). Comma's app and download page cover the Mac only. iOS and Android are listed as "coming soon", and Windows and Linux are not mentioned ([comma.surf/download](https://comma.surf/download)).
- **Other features:** call recording into Drive plus a summary Task (README.md:71-72), voice calls through Twilio or WebSocket (docs/messaging-voice.md:80-200), and an inbound HTTP API that posts into a Group's Router (product-features.md:55-72). You can bring your own API key or use a ChatGPT or Claude plan (README.md:73).

**Chat surfaces**

| Platform | Status | Source |
|---|---|---|
| Feishu/Lark | **BFT only**, as a group bot through an HTTP event callback. Hidden in the personal Comma product. | comma_core/lib/comma/plugins.ex:115-116; salix_web/lib/salix_web/router.ex:3432; manual_zh.tex:294 |
| Slack | BFT integration with slash commands and triage; Comma plugin | docs/bridge-for-teams/design.md:14-25; tools-integrations.md:38 |
| Telegram | Yes, including a Mini App, Task cards, and forum topics mapped to Tasks | messaging-voice.md:62-78; tasks-background-execution.md:215-223 |
| WeChat | Yes, through Tencent's official ClawBot. **Private chats only, never groups.** | messaging-voice.md:24-33 |
| iMessage | One shared account through a relay. Private chats only. | messaging-voice.md:5-8 |
| Signal | Yes, and can bind Signal groups | messaging-voice.md:202-211 |
| Discord, WhatsApp, DingTalk | Discord appears only as a config section name. There is no provider module (`systems/apps/salix_im/lib/salix_im/provider/` has feishu, imessage, internal, signal, slack, telegram, voice and wechat). I found nothing for WhatsApp or DingTalk. | salix_web/lib/salix/control/tenants.ex:10 |

Hosted pricing: the Value plan costs $0 with unlimited chat and your own key. Pro is $80 a month billed yearly, for about 300-600 agentic tasks a month. Each workspace's cloud computer uses about 74,000 credits per hour, which is about $0.074 at 1M credits = $1 ([comma.surf/pricing](https://comma.surf/pricing)).

## 2. Architecture, and how Codex and Claude Code are invoked

- **Backend:** one Elixir umbrella app and one `mix release comma`, made of three subsystems: Salix (the multi-tenant agent runtime), the Comma product, and BridgeForTeams (systems/README.md:1-13).
  - State is stored as an immutable journal plus a compare-and-swap on a `head.json` file per agent in S3. That ETag is the fencing token that stops a stale owner from writing.
  - Each agent is one OTP state machine (`gen_statem`), placed on a node by a consistent-hash ring. Postgres holds control data and Redis is required (systems/README.md:54-97).
- **Lean:** a "verified kernel" owns how Session events are reduced, the agent loop's decisions, and the provider wire formats (the Anthropic, OpenAI Chat and Responses request bodies, plus stream parsing). Elixir handles I/O (docs/agent-runtime.md:66-105).
- **TLA+:** models the core protocols, under a 5,000-line repo-wide budget (AGENTS.md:110-133).
- **Clients:** React web, Electron for macOS, native Apple apps in Swift, an admin console and a BFT dashboard (clients/apps/).
- **Two ways it reaches coding agents:**
  1. **As a tool.** The built-in `codex` skill tells the agent to run `codex app-server --listen stdio://` on a device through `env.exec`. The bypass flag is applied by default only on the cloud VM (resources/salix-system-files/skills/codex/SKILL.md:1-30).
  2. **As a registered External Worker.** `salix-connect` (Go, about 69k lines) contains the Codex, Claude, Pi and Kimi protocol code (systems/connector/README.md:1-4):
     - **Codex:** it spawns `codex app-server --disable tool_suggest --listen <local websocket>` (systems/connector/salix-connect/main.go:3760-3761, 5714-5718). `thread/start` is called with `approvalPolicy:"never"`, `sandbox:"danger-full-access"` and `ephemeral:false`. It uses `thread/resume` and `thread/read` to check readiness, and `turn/start` re-sends the model and effort on every turn (main.go:5973-6075). Pinned versions are Codex 0.153.0 and Claude 2.1.258 (docs/compute-devices.md:191-195).
     - **Claude Code:** it runs `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions`, with `--session-id` or `--resume`, `--model`, `--effort`, and the system prompt passed in a temp file through `--append-system-prompt-file`, because Linux limits argv length (systems/connector/salix-connect/claude_runtime.go:428-467).
     - **How the agent talks back:** a `salix` CLI is injected into the worker's environment (`SALIX_CLI`). The worker is told that its assistant text is not a reply, and that it must call Salix tools to post IM replies (main.go:6612-6620).
- **Device transport:** the connector holds a WebSocket to one Salix node, and agents on other nodes reach it through Erlang RPC (`:erpc`) (systems/connector/README.md "How it fits").

## 3. What "Bridge For Teams" is

BFT is AFK's B2B team product, hosted at teams.bridge.surf. Login is SSO by organization slug, and new organizations need an invite code (manual_zh.tex:50, 96-118; [teams.bridge.surf](https://teams.bridge.surf)).

- **Structure:** Organization, then Agent Swarm (called `Project` in the code), which maps one-to-one to a Salix Group. Each Swarm has one Router and N Worker agents (docs/bridge-for-teams/design.md:3-9; PRODUCT_MODEL.md:56-66).
- **Message integrations:** Slack and Feishu. A Feishu app is registered once per organization, for dashboard sign-in, for the group bot, or both. **"Only one Feishu app per organization can have the group-bot use turned on, and that bot connects to only one Agent Swarm at a time"** (manual_zh.tex:191-199, 294-307).
- **Runners and devices:** "Fin" registers organization Macs as Runners using a one-time install command. Runners host Devices for **External Codex** agents (manual_zh.tex:200-218, 365-385). Runners use launchd and an "Agent VMM" host (systems/connector/README.md "Runner provisioning installer").
- **Extras:** Slack `/newgpttask` and `/newclaudetask` commands, which still go through the Router (design.md:16-18). Triage, where a Worker decides whether to speak at all and records why it stayed silent (design.md:74-93). Feishu-group Google Calendar and Meet joining (manual_zh.tex:320-340). A Go `bft` CLI with an agent mode (systems/README.md:715-790).
- **Self-hosting:** the self-host compose file runs only `salix,comma_product` (compose.yaml:10). There is no documented self-host path for BFT. Its Feishu setup assumes a public callback or tunnel (systems/README.md:823-835).

## 4. Maturity

- **Public repo:** created 2026-09-30, last push 2026-10-03. 256 stars, 17 forks, and 12 issues or PRs in total, 2 still open (GitHub API, fetched today).
- **Commit history:** 5 commits. The commit messages are "Sync Comma source" from github-actions with a `Comma-source-commit:` trailer, so the public repo mirrors a private one (`git log`). Internal docs cite PR #1734 and issue #1799 (docs/verification.md:29), which suggests a private tracker with about 1.8k items.
- **Contributors:** about 19 co-authors are listed across the sync commits, including "Claude Opus 5.5".
- **Lineage:** BFT's user manual is version 1.5, dated 2026-07-19 (manual_zh.tex:38). The Salix runtime replaced an earlier Go system called "willow", and a `salix_migrate` app imports from it (systems/README.md:123).
- **Size and tests:** about 2,046 `.ex` files (616k lines) and 1,121 `_test.exs` files. Also 102 Go test files, 492 `*.test.ts(x)` files, 451 Lean files (79k lines) and 3.7k lines of TLA+ (my `find` counts; there is no vendored `deps`).
- **Docs vs code:** the docs are terse internal engineering contracts, held to a budget of at most 20 files of at most 20 KB each (AGENTS.md:88-108). They are not user documentation. Only BFT has a user manual, in Chinese.
- **Hosted service:** comma.surf is live with paid plans. There is a Mac download, and mobile is "coming soon".
- **Self-hosting gaps:**
  - Meetings and the Agent VMM need separately distributed runtimes, and the `meetnative` source is private (systems/DEPLOYMENT.md:107-115).
  - The AirDrop helper `OpenDropKit` is a private repo (docs/clients.md:36; the GitHub API returns 404).
  - Memory needs have not been benchmarked (DEPLOYMENT.md:20).
  - The stack is Postgres, Redis, MinIO, ClickHouse and Mailpit, so it is not suitable for the 3.9 GB JP-VPS.
- **Community activity:** small. Examples are issue #8 ("homepage frozen", fixed) and issue #4, a Chinese request for custom APIs that turned out to be posted on the wrong project.

## 5. What Vonvon could borrow, and the AGPL limits

**Concrete ideas, all to be written in Vonvon's own code:**

1. **Topic-to-Task binding that skips the Router.** In Telegram, "Bound topics enter their Task… User/Worker turns skip Router by default", while the general topic goes to the Router (tasks-background-execution.md:215-223). This fits Vonvon's topic = session model, and leaves room for an optional group-level assistant later.
2. **Give the coding agent a product CLI.** An injected `"$SALIX_CLI" tool call <name> --json` lets Codex or Claude post replies, create work, or create bots without MCP (main.go:6617). This matches the "CLI" and "create bots by chatting" asks.
3. **Explicit-send replies.** The agent's text is not automatically a chat message. It must call a send tool (PRODUCT_MODEL.md:111; main.go:6618). This keeps internal reasoning out of multi-person groups.
4. **Router-created bots.** `agent.create_worker` requires a `purpose` and a `creation_reason`. Archiving needs explicit user confirmation, and only the Router can use these tools (systems/apps/salix_agent/lib/salix_agent/tools/agent_management.ex:4-16, 53-55). This is a clean shape for "create a new bot by chatting".
5. **Ideas for "more like a person" (像人):**
   - Triage silence rules: stay silent when there is nothing useful to add, and record a reason code (design.md:76-82).
   - The `opening=on` rule: send one short opening before long work (tools-integrations.md:179-185).
   - The owner can rename the Router (product-features.md:40).
   - Native typing indicators (DOMAIN_CONCEPTS.md:280).
   - Proactive reminders only when the desktop app is inactive (DOMAIN_CONCEPTS.md:1365).
6. **Binding codes:** `comma connect XXXX-XXXX`, single-use, valid for 10 minutes, stored only as a SHA-256 digest. This is a way to bind a group to a project without a UI (messaging-voice.md:207).
7. **Device access:** read-only by default, with explicit "Allow operations" (README.md:68-70).
8. **Agent-mode CLI:** JSON when stdout is not a TTY, stable exit codes (0/2/64/66/69/70), and `--fields`/`--limit` (systems/README.md:745-753).
9. **Claude invocation details:** the system prompt goes in a temp file, the session ID is pre-chosen with `--session-id`, and `--replay-user-messages` is used (claude_runtime.go:396-467). For Codex, model and effort are re-sent every turn because a null effort does not clear an earlier override (main.go:6042-6075). The Codex protocol itself comes from OpenAI's Codex, so learning it is not tied to AGPL.
10. **Not worth copying now:** the Lean kernel, TLA+ models, Loops/eBPF, and the S3 compare-and-swap storage. They solve multi-tenant cloud problems that Vonvon does not have.

**AGPL implications** (not legal advice):

- Copying any Comma code means the whole combined work must be licensed under AGPL (LICENSE:210-216). If you serve a modified version over a network, you must also offer its source to those users (LICENSE:540-551; README.md:239-241).
- That conflicts with Vonvon's MIT daemon and the MIT feishu-codex-bridge (`/home/operator/vonvon/feishu-codex-bridge/package.json:60`), and it rules out any closed edition. The docs are in the same repo, so paraphrase them rather than pasting.
- Safe routes:
  - Reimplement the ideas yourself.
  - Use `AFK-surf/spinfoam`, which is MIT and a separate repo (GitHub API).
  - Integrate only over network APIs, for example the inbound post-message API.
  - Ask AFK for a commercial license. Their CLA lets them relicense contributions under other terms (CLA.md §2).

## 6. What it would take to use Comma instead of building Vonvon

- **Personal Comma (hosted):** it works today from Telegram, WeChat, Signal or iMessage, plus the Mac app, and can hand work to Codex or Claude on your Mac. **It cannot be used from Feishu** (plugins.ex:115-116), and WeChat and iMessage are private chats only. Everything goes through a Router LLM into one session per workspace, not one topic = one native Codex session.
- **BFT:** this does cover "Feishu group → External Codex on our Mac", with these differences:
  - Invite-only, organization-level SSO.
  - One Feishu bot per organization, attached to one Agent Swarm, instead of one group = one project folder (manual_zh.tex:199).
  - Each message goes through a Router LLM, which then creates a Task for a Worker (design.md:16-18).
  - Feishu events arrive by HTTP webhook (router.ex:3432), while the bridge uses the Feishu long connection (WSClient), which works on a laptop behind NAT (`/home/operator/vonvon/feishu-codex-bridge/src/card/dispatcher.ts:26`).
  - Runners are Macs running launchd and the Agent VMM.
  - Codex runs with `danger-full-access` and no approvals (main.go:5974-5976).
- **Self-hosting:** BFT is not in the compose file, Feishu needs public HTTPS, and the server needs four datastores with unmeasured memory. The Agent VMM is not included. None of this can be handed to the bridge's roughly 100 weekly npm users.
- **Forking:** about 2M lines of Elixir, Lean and Go under AGPL, with a CLA for contributions.
- **Overlap verdict: partial.** BFT overlaps on team Feishu-to-Codex. Comma does not serve the bridge's niche: individual, local-first, `npm install`, NAT-friendly long connection, direct passthrough to native Codex and Claude sessions, group = folder, topic = session.

  What the owner's new ideas (a "Grok Bot"-style personal agent, a bot marketplace, "more like a person") would compete with is a roughly 19-person, AI-assisted team that already ships a hosted product with apps. Comma also has no bot marketplace today. The closest things are Skills and Plugins catalogs, `skill-manager` installing from a URL, and public Task share links (resources/salix-system-files/skills/skill-manager/SKILL.md:1-25; docs/clients.md:161-165).

**Unknown:**
- Whether BFT routes Feishu topics to separate Tasks. Thread continuation is documented only for Slack (design.md:144-148).
- BFT pricing and how widely it is used.
- Comma's private repo history and its user numbers.

Sources: [comma.surf](https://comma.surf), [comma.surf/pricing](https://comma.surf/pricing), [comma.surf/download](https://comma.surf/download), [teams.bridge.surf](https://teams.bridge.surf), [bridge.surf](https://bridge.surf), [github.com/AFK-SURF/comma](https://github.com/AFK-SURF/comma) (API metadata and issues #4, #8), [trendshift.io/repositories/273822](https://trendshift.io/repositories/273822), WeChat ClawBot launch on 2026-03-22 ([technews.tw](https://technews.tw/2026/03/23/tencent-enables-openclaw-integration-in-weixin/), [runoob](https://www.runoob.com/ai-agent/openclaw-weixin.html)).


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：## Verdict on the comma report

I checked 19 claims. 13 hold up exactly: the technical, licensing, pricing and Feishu-limit claims all match the code and the live sites as of 2026-10-14. None is outright wrong. 6 claims are overstated:

- **Commit history:** 2 of the 5 commits are human "Initial commit" and "Sync asset", not mirror syncs.
- **Team size:** "19-person team" is drawn from Co-authored-by handles, which include 8 AI tools and some aliases. Headcount is unknown.
- **Connector size:** salix-connect is about 69k lines only when tests are counted; it is about 38k without them.
- **Commercial license:** the CLA permits relicensing, but no evidence was found that AFK offers commercial licenses.
- **"Unknown" on Feishu topics:** this is partly answerable. The Feishu provider handles `thread_id`, `reply_in_thread` and `get_thread_replies`. Whether a topic gets its own Task is still unproven.
- **Line numbers:** the Loop limits are at tasks-background-execution.md:64 and :105, not :65 and :102.

## Claims confirmed against code and sites

- **Personal Comma does not offer Feishu.** plugins.ex:115-116 hides it. The self-host compose runs only `salix,comma_product` (compose.yaml:10).
- **BFT's Feishu limits are real.** One group-bot app per organization, bound to one Agent Swarm (manual_zh.tex:199). Events arrive by HTTP webhook (router.ex:3432). The runner installer accepts only darwin-arm64 (systems/connector/README.md:169).
- **Codex runs with no approvals and full access.** `approvalPolicy:"never"` and `danger-full-access` at main.go:5974-5982. Claude runs with `bypassPermissions` (claude_runtime.go:428-467). Replies go out only through `$SALIX_CLI` (main.go:6612-6620).
- **Pricing and platforms.** Pro is $80/month billed yearly, and the cloud computer uses about 74k credits an hour. Downloads are macOS plus a Web app, with iOS and Android "coming soon" (comma.surf/pricing and /download).
- **Repo traction.** Created 2026-09-30, last push 2026-10-03, 257 stars, 17 forks, 12 issues and PRs (GitHub API).
- **Licenses.** Comma is AGPL. Vonvon's daemon and the bridge are both MIT. spinfoam is MIT.
- **Bridge context.** The bridge's last release was 0.6.14 on 2026-09-24, with 108 downloads in the week 2026-10-06 to 10-12 (npm).

## The biggest gap: who Muse, Today.AI and Grok Bot are

The report never identifies the products the owner named. Comma's own repo description calls it a "Selfhost your open source alternative to Muse, Dots, Instinct and Town".

- **Muse** is Meta's personal agent, launched 2026-09-08. It runs in the app, in WhatsApp and on muse.ai, and is US-only for now.
- **Today AI** comes from the founder of Teambition (齐俊元) and went live in China on 9-24. It already connects to 飞书 (Feishu), but the only source is a secondary review (Huxiu, 2026-10-08).
- **Grok Bot** is xAI's product, in beta since 2026-08-11:
  - Bots can be placed in group chats.
  - Team Bots (2026-09-28) get their own handle in Slack channels.
  - A Marketplace with an "Add" button, plus a Templates guide: "share a bot as a recipe, not a clone".

So the owner's "bot marketplace + bots join groups" idea already ships at xAI. I found no Feishu/Lark support, CLI, or "create a bot by chatting" on xAI's pages.

Two more points matter for the owner:

- **Grok Bot is not the planned Grok engine.** Vonvon's plan V7a "Grok" (docs/plan.md:1589) is a coding-agent engine, not this product.
- **Feishu is still open for a local-first tool.** Of everything checked, only Today AI is on Feishu, and it is a hosted assistant, not a local coding-agent bridge. BFT is invite-only and Mac-only. Comma doesn't support Feishu.

## Sources

- [AFK-SURF/comma on GitHub](https://github.com/AFK-SURF/comma), API metadata and issues, fetched 2026-10-14
- [comma.surf/pricing](https://comma.surf/pricing)
- [comma.surf/download](https://comma.surf/download)
- [teams.bridge.surf](https://teams.bridge.surf)
- [Meta: Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse), 2026-09-08
- [Huxiu review of Today AI](https://m.huxiu.com/article/4895918.html), 2026-10-08
- [xAI: Introducing Grok Bot](https://x.ai/news/introducing-grok-bot), 2026-08-11
- [xAI: Team Bots](https://x.ai/news/team-bots), 2026-09-28
- [Grok Bot Marketplace](https://x.ai/bot/marketplace)
- [Grok Bot Guides](https://x.ai/bot/guides)
- [npm weekly downloads for @modelzen/feishu-codex-bridge](https://api.npmjs.org/downloads/point/last-week/@modelzen/feishu-codex-bridge)


### 逐条复查

- **属实**：The personal Comma product does not offer Feishu: "Feishu is not open for installation in Comma yet" (plugins.ex:115-116).
  - 依据：/home/operator/vonvon/references/comma/systems/apps/comma_core/lib/comma/plugins.ex:115 has that comment, and line 116 `defp product_plugin?(%{"plugin_id" => "feishu"}), do: false` hides it. docs/architecture/PRODUCT_MODEL.md:129 lists Feishu only as a Router-bound inbound path. Only Slack has a Worker-bound Task path.
- **属实**：Self-host compose runs only `salix,comma_product`, so BFT is not self-hostable from it (compose.yaml:10).
  - 依据：compose.yaml:10 `COMMA_SUBSYSTEMS: salix,comma_product`.
- **说过头了**：The public repo has 5 commits from 2026-09-30 to 10-02, all mirror syncs of a private repo.
  - 依据：`git log` in /home/operator/vonvon/references/comma: ba4f55d, f811124, 4461132, f2e37fc, 03c868c.
- **属实**：Repo created 2026-09-30, last push 2026-10-03, 256 stars, 17 forks, 12 issues/PRs, 2 open.
  - 依据：GitHub API, fetched 2026-10-14: created_at 2026-09-30T08:39:30Z, pushed_at 2026-10-03T06:32:04Z, 257 stars (one more than the report), 17 forks, 12 items (#1-#12), 2 open. The open ones are #10 "Support client-side Remote SSH for private/VPN-only Linux hosts" and #12 "Add streaming of computer screen to chat" (https://api.github.com/repos/AFK-SURF/comma/issues?state=all).
- **说过头了**：About 19 co-authors, so Vonvon would compete with a roughly 19-person, AI-assisted team.
  - 依据：`git log --format=%b | grep -i co-authored | sort -u` in the comma repo.
- **属实**：salix-connect starts Codex `app-server` with approvalPolicy never, sandbox danger-full-access, ephemeral false, and re-sends model and effort on every turn. Pinned versions are Codex 0.153.0 and Claude 2.1.258.
  - 依据：systems/connector/salix-connect/main.go:3760-3761 (args `app-server --disable tool_suggest --listen`), 5974-5982 (thread/start never / danger-full-access / ephemeral false), 6042-6065 (startTurn comment and turn/start). docs/compute-devices.md:193-194 has the versions.
- **属实**：Claude Code is run with `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-mode bypassPermissions --allow-dangerously-skip-permissions`, `--session-id`/`--resume`, and the system prompt in a temp file via `--append-system-prompt-file`.
  - 依据：systems/connector/salix-connect/claude_runtime.go:428-467.
- **属实**：BFT allows only one Feishu app per organization with group-bot use, and that bot connects to one Agent Swarm. The manual is v1.5 dated 2026-07-19. BFT is invite-only with SSO.
  - 依据：docs/user_manual/bridge_for_teams/manual_zh.tex:199 (the one-app/one-Swarm sentence), :38 and :48 (date and version 1.5), :99-109 (invite code is single-use). One nuance: the invite code is only needed to create a new organization, and members sign in by org-slug SSO (https://teams.bridge.surf, fetched 2026-10-14).
- **属实**：BFT Feishu events arrive by HTTP webhook (router.ex:3432), while the bridge uses the Feishu long connection (dispatcher.ts:26).
  - 依据：systems/apps/salix_web/lib/salix_web/router.ex:3432 `post "/v1/im/feishu/events"`. For the bridge, the better citation is /home/operator/vonvon/feishu-codex-bridge/src/bot/bridge.ts:44-47 and src/cli/commands/run.ts:16 ("foreground long-connection bot"). dispatcher.ts:25-26 is a comment about card callbacks, and it also says a lark-cli transport exists that does not deliver them.
- **属实**：WeChat (ClawBot) and iMessage are private chats only.
  - 依据：docs/messaging-voice.md:33 ("Only the scanned account's private messages enter its Workspace, never groups") and :8 (iMessage: "private text and images, not groups").
- **属实**：Pricing: Value $0 with unlimited chat and BYOK. Pro $80/month billed yearly, ~300-600 agentic tasks a month. The cloud computer uses ~74,000 credits/hour, and 1M credits = $1.
  - 依据：https://comma.surf/pricing, fetched 2026-10-14. It quotes "~300–600 agentic tasks / month", "about 74,000 credits for each hour" and "1M credits equal US$1". Enterprise is custom.
- **属实**：Download is Mac only. iOS and Android are coming soon, and Windows and Linux are not mentioned.
  - 依据：https://comma.surf/download, fetched 2026-10-14. It also lists a Web app, which the report left out. Separately, the BFT runner installer accepts only `darwin-arm64` (systems/connector/README.md:169).
- **属实**：Loop limits are 6 wakes per 10 minutes per Loop, 20 Loops per Agent and 100 per Group (tasks-background-execution.md:65, 102).
  - 依据：docs/salix/tasks-background-execution.md:64 and :105. The numbers match, but the report's line numbers are off by 1-3.
- **属实**：`agent.create_worker` requires a purpose and a creation_reason, archive needs explicit user confirmation, and only the Router can use these tools.
  - 依据：systems/apps/salix_agent/lib/salix_agent/tools/agent_management.ex:4 (archive prompt), :12-13 (create_worker), :53-55 (`roles: ["router"]`).
- **说过头了**：Comma is AGPL-3.0-only and Vonvon's daemon and the bridge are MIT. spinfoam is MIT. The CLA lets AFK relicense, so a commercial license can be requested.
  - 依据：README.md:239. LICENSE:210-216 and 540-551 (§5c, §13). /home/operator/vonvon/vonvon-bot/packages/daemon/package.json:63 and /home/operator/vonvon/feishu-codex-bridge/package.json:60 are "MIT". GitHub API gives spinfoam license "mit" (created 2026-09-16). CLA.md:10.
- **说过头了**：Code size: about 616k lines of Elixir, 1,121 test files, 107k Go, 79k Lean, ~670k TS, 52k Swift, 3.7k TLA+. salix-connect is about 69k lines of Go.
  - 依据：find/wc in /home/operator/vonvon/references/comma.
- **属实**：Comma has no bot marketplace today.
  - 依据：`grep -ril marketplace` over .md/.ex/.ts/.tsx finds only resources/salix-system-files/skills/ui-designer files, which are unrelated.
- **说过头了**：Unknown whether BFT routes Feishu topics to separate Tasks. Thread continuation is documented only for Slack.
  - 依据：systems/apps/salix_im/lib/salix_im/provider/feishu.ex:66-70, 119, 136; feishu/message.ex:12-20.
- **属实**：(Context) feishu-codex-bridge's last release was 0.6.14 on 2026-09-24, at about 100 downloads a week. Vonvon's design is one group = one folder, one topic = one session.
  - 依据：npm registry time 2026-09-24T14:12:37Z for 0.6.14, and git tag v0.6.14 at 2026-09-24 22:10 +0800. https://api.npmjs.org/downloads/point/last-week/@modelzen/feishu-codex-bridge gives 108 for 2026-10-06..10-12. /home/operator/vonvon/vonvon-bot/docs/architecture.md:7.

### 正文遗漏的事实

- The report never identifies the products the owner named. Comma's own GitHub description says it is a "Selfhost your open source alternative to Muse, Dots, Instinct and Town" (GitHub API, AFK-surf/Comma). Comma is therefore positioned as an open clone of the same wave the owner is reacting to.
- Muse is Meta's personal agent, announced 2026-09-08 and updated 2026-09-30 (https://about.fb.com/news/2026/09/introducing-muse). It is proactive, runs on a "Muse Secure VM", and works in the Muse app, WhatsApp and muse.ai. It is US-only for now, with a free tier and paid plans. The $20/$100 prices come only from secondary search results and are not confirmed on Meta's page.
- Today AI is a Chinese "Personal AI" built by Teambition founder 齐俊元. Its domestic version went live on 9月24日 and it already connects to 飞书、钉钉、腾讯文档 and email (Huxiu, 2026-10-08, https://m.huxiu.com/article/4895918.html, a secondary hands-on review; the official site was not found). That makes it a direct Feishu-surface competitor, which Comma is not.
- Grok Bot is xAI's product (beta 2026-08-11, https://x.ai/news/introducing-grok-bot): always-on bots on their own cloud computer, and "You can also place Bots in a group chat where they can coordinate on their own." Team Bots (2026-09-28, https://x.ai/news/team-bots) are shared bots with their own handle in Slack channels. A Grok Bot Marketplace (https://x.ai/bot/marketplace) lists bots with an "Add" button. Its Templates guide says "Templates share a bot as a recipe, not a clone" and covers publishing and installing (https://x.ai/bot/guides). No xAI page found mentions Feishu/Lark, a CLI for Grok Bot, or creating a bot by chatting with a bot. These are unconfirmed.
- Naming risk: Vonvon's plan already has "ACP engine with Cursor, Grok, and custom ACP (V7a)" (/home/operator/vonvon/vonvon-bot/docs/plan.md:1589). That Grok is a coding-agent engine, a different thing from xAI's Grok Bot product with a marketplace. The owner's "Grok Bot" idea should not be read as the V7a engine.
- Comma's device story is effectively Mac-only. The BFT runner installer accepts only darwin-arm64 (systems/connector/README.md:169), and open issue #10 asks for Linux remote-SSH hosts. The report says Mac only for the app but does not say this blocks Linux and Windows users for the device bridge.
- PRODUCT_MODEL.md:129 says Router-bound Feishu inbound skips Conversation Messages and goes straight into the single Router session. Only Slack has Worker-bound Task sessions. This is stronger evidence than the report gives that Feishu in BFT is Router-first and not topic = session.
- The Huxiu article reports that Muse leaked about 190k user conversation records. This is unverified and secondary, but relevant to a local-first privacy pitch if it can be confirmed from a primary source.
- Not re-checked: the WeChat ClawBot launch date (2026-03-22), the trendshift ranking, routines' 480 s / six-card limits, and docs budget rules (AGENTS.md:88-108). Treat these as unverified.
