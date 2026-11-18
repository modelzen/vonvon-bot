# Vonvon Bot v2: what the product is on paper, and who decided it

Sources are from this host (repo at `main` be17859, read on 2026-10-14). I ran nothing heavy and built nothing.

## 0. Key facts first

- **No document describes the finished product from the user's side.** The plan's only per-milestone user statement is a "You see" box with 1 to 3 bullets. There are 16 of them in 2128 lines (`grep -n 'You see' docs/plan.md`: lines 264, 319, 629, 839, 1197, 1317, 1413, 1483, 1545, 1611, 1673, 1731, 1794, 1853, 1923, 1999).
- **Most of the plan is mechanics.** V3, the daemon lifecycle, takes 429 lines (plan.md:359-787). V5, the shell and OS service, takes 400 lines (plan.md:887-1286). Together that is 39% of plan.md.
- **The definition of done is a checklist.** It is "Every box above is checked with its evidence" (plan.md:2042), with no release or beta milestone in between.
- **The plan builds in no point where the owner looks at the product.** Every milestone says "personal review is optional" (14 times, plan.md:779, 878, 1278, 1357, …, 2031). Merging without personal UI review is the user's own earlier authorization (plan.md:11, roadmap.md:79, AGENTS.md last bullet "不在版本边界等用户确认"). That conflicts with the new wish for heavy involvement.
- **Something tryable already exists, but it was never packaged or handed over.**
  - V4 (#69, the local web UI) merged 2026-10-11. `vonvon open` is registered at `packages/daemon/src/cli/index.ts:47`.
  - V2 (#24) runs the copied bridge bot in Feishu.
  - `gh release list` returns nothing. README.md:3 describes only the protocol package, not how to run anything.
  - The V4 screenshots were saved on the Mac under `~/vonvon-review/` (plan.md:875-878).
- **Every product PR since then is internal plumbing.** 20 product PRs merged after #69: 11 V5 pieces (#246 … #276) and 9 V6a pieces (#237 … #272), per `git log --oneline main`. None changes what a Feishu user sees, apart from the V6a outbound gate, which per plan.md:1319 only stops symlinked and ungated images.
- **The commit log is about half docs.** `main` has 57 commits: 24 `feat`, 23 `docs`, 4 `chore`, 2 `ci`, plus the initial commit and 3 others (`git log --format=%s main`).

## 1. What the finished v2 product looks like, per the docs

**Who it is for.** The only statement is a memory note: "Vonvon Bot's users already run Codex, Claude Code, Cursor, Grok (xAI Grok Build), or DeepSeek" (memory `vonvon-provider-priority.md`). Bridge users are a second group, through the import (architecture.md:11). No doc defines the persona, team versus individual use, or how technical the user is. The old desktop branch had a goal: "让新老用户都能在不打开终端的情况下完成第一次飞书协作" (`git show origin/codex/device-handoff:README.md`, line 3). The v2 docs do not carry it over.

**Install.** Two channels (architecture.md:189-193, :295):
- An Electron desktop app with a bundled daemon (V5). Signed installers come from Codex's Mac release (roadmap.md:24, :69).
- `npm i -g vonvon-bot` for headless servers. The CLI is `vonvon daemon start|stop|status`, `vonvon service install|uninstall|status`, `vonvon import feishu-codex-bridge`, `vonvon login`, `vonvon open`.

One daemon runs per machine with data in `~/.vonvon-bot` (architecture.md:39, :139). The bot keeps running after the window closes. With **开机自动运行** on, the daemon becomes a launchd, systemd or Windows Run-key service (architecture.md:53). Linux desktop gets no autostart toggle; Linux users run `vonvon service install` (roadmap.md:123).

**In Feishu.** All chat happens in Feishu. The desktop app and web UI "不聊天，只用来设置 Bot、群、会话和本机环境" (architecture.md:9).
- **Group = project directory, topic = agent session** (architecture.md:7).
  - Per group: provider, mode `qa|write|full`, `readScope` (`project` or `unrestricted`), `network`, `response` (`mention` or `all`, i.e. 免@), and `sessions` (`threads` or `shared`) (architecture.md:204-215).
  - The UI calls the two session modes 按话题独立会话 and 整群连续会话 (`packages/ui/src/App.tsx:827`).
- **Commands**, inherited from the bridge runtime copied in V2, listed in the `/help` and welcome cards (`packages/daemon/src/card/command-cards.ts:272-380`):
  - `@bot + text` in the main area starts a new topic.
  - Inside a topic: `/model` switches model or reasoning effort, `/context` shows context use, `/compact` compresses it.
  - `/goal <目标>` runs autonomous multi-turn work. Per the provider redesign it is Codex-only; the Claude prompt-loop goal is deleted (plan.md:2098).
  - Admin only: `/clear`, `/resume`, `/settings` (the 免@ toggle). `/help` is the quick-reference card.
- **DM menu card**, for admins: 新建项目, 项目列表, 设置, 用量, 诊断, 重启, 更新 (plan.md:607; `dm-cards.ts:170-202`).
  - The header still reads "🤖 Codex Bridge 管理台" (`dm-cards.ts:192`).
  - The welcome card still says "欢迎使用 ${agentName} Bridge" (`command-cards.ts:347`).
- **Run card**, the streaming reply. Nine areas, top to bottom (providers.md:764-781):
  1. Frame: header, stop button, context gauge.
  2. Progress line `进度 3/7 · 正在改接口` with a collapsible checklist.
  3. Notices, up to 4 lines.
  4. Reasoning, collapsed.
  5. Process steps.
  6. **子 agent area**: at most 6 running and 3 completed rows. Each row shows status, task, `N 步`, elapsed time and current step. The panel holds the last 5 steps, a 查看完整过程 button (posts a 200-step card) and a per-subagent 停止 button where the provider supports it (providers.md:783).
  7. Answer text.
  8. Up to 12 images.
  9. Outcome note: 已停止, 上下文已满…, 账户额度已用完, and others (providers.md:791-809).

  Limits are 170 components and 28,000 bytes. A follow-up message during a run steers the run if the provider supports it, and otherwise queues as the next turn (architecture.md:123).
- **Permissions.** Exactly three tiers and no approval cards (architecture.md:129; providers.md:15).
  - Labels: 🔒 项目内只读, ✏️ 项目内读写, ⚠️ 完全访问 (`dm-cards.ts:1500-1504`).
  - Read scope is set per project: 仅读取项目目录 or 不限读取 (plan.md:1379).
  - Any combination not proven on that OS is refused with a Chinese message and nothing starts (architecture.md:129). "On a fresh host most `qa` and `write` cells refuse until the probes land in V6d and V7c" (providers.md:836).
  - Joined external groups default to `qa` (`packages/daemon/src/project/lifecycle.ts:206`).
  - Guests are clamped to a guest tier (providers.md:670; `project/registry.ts:47`).
- **Providers:** Codex, Claude Code, Cursor, Grok, Pi, and a custom ACP command. DeepSeek, Kimi, GLM and Qwen work through Claude Code settings (providers.md:15). A capability appears only where the provider has it natively (architecture.md:127).
- **Inherited features no v2 doc discusses:**
  - voice (`packages/daemon/src/voice/`)
  - 咖啡一下, "离开接管": forwards local Claude Code and Codex sessions to Feishu when you are away (`dm-cards.ts:905-910`)
  - document-comment prompts (`dm-cards.ts:1143`, `:1268`)
  - watchdog and completion reminders (`dm-cards.ts:1340`, `:1362`)
  - admins and allowlist (`dm-cards.ts:1434`, `:1769`)
  - usage cards

**Desktop app and web UI.** One UI build serves the local web page, the Electron window and the cloud-hosted page (architecture.md:109). It keeps the old React UI and its style (architecture.md:107).
- Sidebar (`packages/ui/src/LocalShell.tsx:8-21`): **Bot**, **群聊**, **本机环境**, **用量**, **咖啡一下**, **应用与启动**, **状态与诊断**, and search (⌘K). The account row reads "本地使用 · 无需登录".
- Screens checked in V4's live lanes (plan.md:853-866):
  - Bot list.
  - Bot settings pane, with 连接与权限, the Codex executable path and 移除 Bot (App.tsx:707, :737).
  - Group detail, with 这个群中的 Bot, 群内协作, 快捷操作 and 历史会话 (App.tsx:791-839).
  - Response-mode change.
  - Bind-group dialog with a directory browser.
  - Session history with compact.
  - Usage (Codex usage windows).
  - Environment (codex, claude and lark-cli versions).
  - Search palette.
  - Disconnected state, and the no-credential refusal.
  - The first-bot entry "邀请你的第一个 Bot" with a QR "完整注册链接" (App.tsx:475, :1080).
- Desktop-only additions: tray, single instance, auto-update, 登录电脑时启动, 隐藏到托盘, and 退出 (quitting leaves the daemon and bots running) (architecture.md:191; App.tsx:894-901). The web build shows "桌面版提供" for these.

**Remote management (V10/V11).** Optional.
- Log in with Feishu or Lark SSO: a browser on desktop, or `vonvon login` with a link and code on servers (architecture.md:163-165).
- The cloud stores only accounts and machines (name, OS, version, public key, last seen). It never stores settings (architecture.md:173).
- V10: "After `vonvon login` on two machines, the web UI lists both under one account with online states" (plan.md:1925).
- V11: "From the hosted web UI, the user switches to another machine and changes a group setting" (plan.md:2001). Traffic is end-to-end encrypted, with a known cloud man-in-the-middle risk (architecture.md:177). The UI warns when one `appId` is enabled on two online machines (plan.md:2034).
- The deploy platform is undecided (#209, roadmap.md:125).

**Bridge import (V8/V9).**
- V8: a read-only preflight lists bots, groups, sessions and settings. After you confirm, it pauses the bridge, copies the data and re-encrypts secrets, rewrites the 咖啡 hooks to `vonvon hook`, starts the bots and confirms they connect, then removes bridge autostart and writes `migrated-to-vonvon-bot.json`. Any failure restores the bridge (architecture.md:147-155). The UI flow: "the import screen lists bots, groups, and sessions, and after confirm shows every bot connected" (plan.md:1796). An import step is added to first-run onboarding (plan.md:1792).
- V9 ships in the bridge repo: "A bot owner gets one DM card that links to the Vonvon Bot download, and a migrated machine's bridge refuses to start" (plan.md:1855).

## 2. Product decisions and who made them

| Decision | Where written | Attribution | Evidence |
|---|---|---|---|
| Vonvon Bot is independent of feishu-codex-bridge | architecture.md:11 | **User** | memory `vonvon-bot-v2-architecture.md`: "On 2026-10-10 the owner decided vonvon-bot is an independent product" |
| One daemon per machine; desktop, web and CLI are clients | architecture.md:15-43 | Unknown (agent-written, "like Paseo") | PR #21 body: "改成 Paseo 那样的结构". Not listed among owner decisions or agent calls |
| Login optional | architecture.md:161-169; plan.md:2065 | **User** | memory: "Owner decisions: login is optional"; plan.md:2065 "The owner chose optional login" |
| Cloud stores no settings | architecture.md:83-87; plan.md:2064 | **User** | memory "Owner decisions … the cloud stores no settings"; plan.md:2064 "The owner decided against it" |
| End-to-end encrypted relay for remote access | architecture.md:171-179 | **Agent** | PR #21 body: "它们是我替你做的决定，你可以改"; memory: "My calls the owner may still override: end-to-end encrypted relay" |
| Cloud code in this repo (`packages/cloud`) | architecture.md:181-185 | **Agent** | same PR #21 list and memory line |
| Feishu/Lark SSO as the only login | architecture.md:165 | Unknown | no attribution |
| Import bridge data, then shut the bridge down; the last bridge release points to Vonvon | architecture.md:145-159; roadmap.md:23-24 | **User** | memory "Owner decisions: … Import bridge data, then shut the bridge service down; the bridge's last release points users to Vonvon Bot" |
| Pause before copying during import | architecture.md:157 | **Agent** | PR #21 body list; memory "pause-before-copy import order" |
| Keep the old React UI and its style | architecture.md:105-111; plan.md:2062 | **User** | plan.md:2062 "lose the original style the owner wants to keep" |
| Desktop and web do not chat, only configure | architecture.md:9 | Unknown | no attribution anywhere |
| Desktop app is "只是外壳", with a bundled daemon and tray | architecture.md:187-193 | Unknown/agent | no attribution |
| Providers: Codex, Claude Code, Cursor, Grok, Pi, custom ACP; Copilot and OpenCode deferred | providers.md:15; roadmap.md:38-40 | **User** | providers.md:15 "The user decided the following, recorded in the arena frame"; memory "The user says … users already run Codex/Claude Code/Cursor/Grok/DeepSeek, and wants Pi kept" |
| DeepSeek, Kimi, GLM, Qwen via Claude Code settings | providers.md:15 | **User** (as recorded) | providers.md:15, same sentence |
| Redesign every provider on Paseo/Orca with no compatibility constraint | providers.md:3 | **User** | memory: "the user wants every provider (Codex included) redesigned on Paseo and Orca … v2 is a new product, so old features stay only where they make the experience better" |
| Native capabilities only, no emulation | architecture.md:127; native-capabilities.md:5 | **User** | native-capabilities.md:5 quotes "都不做模拟"; plan.md:2098 "The user excluded emulation" |
| Exactly three tiers, no approval cards, fail closed | providers.md:15, :851 | **User** | providers.md:851 "Excluded by the user" |
| Read scope per project; old projects load `unrestricted`, new ones `project` | providers.md:857 | **User** | providers.md:855 "The user decided these on 2026-10-12" |
| Claude without a sandbox runs qa/write with Bash off | providers.md:858 | **User** | same |
| Agent-declared slash commands count as native | providers.md:859 | **User** | same |
| Vonvon generates its own session titles | providers.md:860 | **User** | same |
| Subagents, todo, images, outcome and interrupt are baseline | providers.md:13 | **User** (goal) | memory: "The user has long wanted subagents and wants a good way to show them in Feishu" |
| Run-card layout (9 areas, 6+3 subagent rows, byte budgets) | providers.md:764-809 | **Agent** | providers.md:3 "produced by an arena of four candidate designs … synthesized by hand" |
| Unproven permission cells refuse (most qa/write on a fresh host) | providers.md:836 | **Agent** tradeoff, derived from the user's fail-closed rule | listed under "Tradeoffs accepted" |
| Cursor/Grok vendor usage excluded | providers.md:864 | **Agent** default, still open | "Open, each with the default this design assumes" |
| No Windows host; Windows checked only by frozen-head CI; Windows desktop items "未验", not blocking | AGENTS.md hard limits; PR #239 | **User** | memory `vonvon-testing-split.md`: "Windows (2026-10-13, user decision): there is no Windows host and the user won't set one up". #208 is still open |
| Full 3-OS CI only on frozen heads | roadmap.md:97; PR #210/#217 | Agent proposal answering the user's request to speed up | memory `vonvon-program-tracking.md`: "the user asked to speed up development. Decisions, written in PR #210". Whether the user chose the specifics is unknown |
| Merge without personal UI review; continue across versions without confirmation | plan.md:11; roadmap.md:79; AGENTS.md | **User** | plan.md:11 "The operator also authorized Codex to merge … without personal UI review"; commit acf4bc3 (#39) |
| Claude implements, Codex verifies | AGENTS.md | **User** | memory `vonvon-role-split.md` (2026-10-13 upgrade to Max 20x) |
| Split V5 into 15 PRs | /home/operator/vonvon/v5-split/plan.md:15-29 | **Agent** | memory `vonvon-v5-split-decision.md`: the user said "你决定" |
| Split V6b into 14 PRs plus a deletion step | PR #281 plan diff ("*Split.* V6b lands as fourteen PRs") | **Agent** | PR #281 |
| Cloud deploy platform | roadmap.md:125; #209 | **Open** (user item) | #209 OP-5, open |
| Who creates the Feishu test bot | PR #21 body | **Open** | "还没定的：云端部署在哪里，以及飞书测试 Bot 由谁创建" |
| Which inherited bridge features stay (voice, 咖啡一下, comments, watchdog, reminders, /goal) | nowhere | **Never decided** | V2 copied all of the bridge `src/` (plan.md:301-315). Only the user's general rule in memory ("old features stay only where they make the experience better") |

## 3. Product questions nobody put to the user, or still open

1. **Target user and their setup.** No doc defines it. The grep for pricing, team, tenant, persona and target-user terms over architecture, roadmap, plan and providers finds nothing relevant. Open points:
   - Solo developer on their own Mac, or a team sharing one bot? The data model has a single `ownerOpenId` per bot (architecture.md:202), but admins and guests exist in code (`dm-cards.ts:1434`; registry.ts:47).
   - Does the user need Feishu tenant admin rights to create a bot app?
   - Is the main machine a laptop or a headless server?
   - The old "no terminal needed" goal (old README:3) was dropped without discussion.
2. **First-run flow from install to first reply.** No v2 doc covers it. The pieces exist in code: the QR bot registration "邀请你的第一个 Bot" (App.tsx:475, :1080) and group binding (plan.md lane 4). The only onboarding line in the plan is the V8 import step (plan.md:1792). Bot creation is open (PR #21 body).
3. **What the desktop app is for when chat happens in Feishu.** architecture.md:9 limits it to settings. V5 is still 15 PRs (11 merged, #285 in flight) and 400 plan lines, mostly OS-service transactions (v5-split plan.md:15-29). Nobody asked whether a web UI plus `vonvon service install` is enough for a first release, or which OS gets the desktop app first.
4. **What the first release must contain, and when it ships.** There is no release milestone. "Done" means every box checked (plan.md:2042), and AGENTS.md says to continue without pausing at version boundaries. V9 needs a signed installer (roadmap.md:24), and no release exists (`gh release list` is empty).
5. **Whether cloud and remote management (V10/V11) belong in v1.** Nobody asked whether a solo user needs it. The deploy platform is undecided (#209). The cost, the operator and the privacy stance of a hosted service are not discussed. The MITM risk was accepted by the agent (architecture.md:177).
6. **Pricing and accounts.** Never mentioned. Is the cloud free? Is there a paid tier? Will Lark users outside China be supported (architecture.md:165 mentions Lark SSO only in passing)?
7. **Which inherited bridge features to keep.** Voice, 咖啡一下 离开接管, doc-comment prompts, watchdog, completion reminders and `/goal` (Codex only after V6b) all ship by default because V2 copied the whole bridge. The user's rule (keep only features that improve the experience; memory `vonvon-provider-priority.md`) was never applied feature by feature.
8. **Feishu branding and copy.** The cards still say "Bridge" (`command-cards.ts:347`, `dm-cards.ts:192`). No naming or copy decision exists for the Feishu side, which is where users spend their time.
9. **Permission UX on first use.**
   - New joined groups default to `qa` (lifecycle.ts:206). Per providers.md:836, most `qa` and `write` cells refuse on a fresh host until V6d and V7c. A new user's first message may therefore get a refusal.
   - From V6b until V6d merges, existing Claude `qa` and `write` projects refuse (plan.md:1417).
   - The label 项目内只读 ("只能查看项目文件夹里的内容", dm-cards.ts:1501) reads oddly next to `unrestricted` read scope, which upgraded projects get by default (providers.md:857).

   None of this was presented to the user as UX.
10. **Provider priority for the first release.** Do all six providers need to ship? Cursor and Grok need user accounts (#207) and are mostly `none` until probed (providers.md:842). Pi and custom ACP are `full`-only (architecture.md:129).
11. **The owner's role during development.** The plan's only user checkpoint is "State the protocol and this plan to the operator, then stop" (plan.md:29). That covers protocol and plan, not product shape. Evidence goes to `~/vonvon-review/` on the Mac, with personal review optional. No step hands the owner a build.
12. **Is Windows a launch platform?** The user said there will be no Windows host (memory), but #208 asks the user to decide and is still open. V7c is parked. The Windows startup loop has only unit tests (roadmap.md:116). Linux desktop is half-supported (roadmap.md:123).
13. **How much import matters.** How many bridge users exist? Is V8/V9 a must for the first release? Draft #226 (+2215/-10, opened 2026-10-12) sits outside the WIP flow with no owner label (`gh pr list`).
14. **The docs contradict each other on who writes code.** plan.md:7 still says "Codex owns all code … Claude Code … writes no product code". AGENTS.md (2026-10-13) says Claude implements.

## 4. Milestones: can the user see or try anything when each merges?

Status comes from `git log main`, `gh pr list` and issues #124-#135 (all still OPEN).

| Milestone | Status | When it merges, the user… | Visible? |
|---|---|---|---|
| V1 protocol package (#22) | merged 10-10 | sees nothing; "`npm ci && npm run typecheck && npm test` passes" (plan.md:266) | Internal |
| V2 bridge runtime copied into the daemon (#24) | merged 10-10 | can run `vonvon daemon run` and the Feishu bot works as it did under the bridge (plan.md:321, lane 2 :333) | Visible but identical to the bridge |
| V3 daemon WebSocket API (#34) | merged 10-11 | gets CLI only: `daemon start`, `status --json`, and a script printing a snapshot (plan.md:631) | CLI only |
| V4 web UI (#69) | merged 10-11 | can run `vonvon open` and see the Bot list "in the original style", plus settings, groups, history, usage and environment (plan.md:841, lanes :853-866) | **Visible, never handed to the user** |
| V5 desktop shell and OS service | 11/15 merged, #285 (piece 12) in review | at the end: "Launching the app opens the Bot list. Quitting the app leaves the bots running when Open at login is on" (plan.md:1199) | Visible only once the pieces below land and a build is packaged |
| V5 piece 1 service codec (#246) | merged | — | Internal |
| V5 piece 2 npm package (#248) | merged | could `npm i -g vonvon-bot` once published; not published | Potentially visible |
| V5 pieces 3-4 desktop runtime and IPC (#251, #254) | merged | — | Internal |
| V5 piece 5 window, tray, updater, packaging (#257) | merged | a dev build of the desktop window is possible; no signed release | Visible in a dev build only |
| V5 pieces 6-11 Windows service retirement, drain, launchd, systemd, Windows transactions, Gate L/M (#268, #270, #271, #274, #275, #276) | merged | — | Internal |
| V5 piece 12 pre-lock guard, start routing (#285) | in review | — | Internal |
| V5 piece 13 `service status` | local branch | `vonvon service status` | CLI, minor |
| V5 piece 14 install/uninstall unlocked | local branch | `vonvon service install` works | CLI-visible |
| V5 piece 15 Open at login | local branch | 登录电脑时启动 toggle works on desktop | Visible |
| V6a provider core: 1/6-5/6 plus 6a-6d (#237, #241, #244, #249, #255, #259, #262, #266, #272) | 9 pieces merged; parent #125 still open | "Nothing changes in Feishu except" symlinked images are not uploaded and remote images need network on (plan.md:1319) | Internal |
| V6b runtime cut-over: 14 PRs plus deletion (PR #281 split) | 1/14 open (#281) | PRs 1-11: nothing (4-6, 8 and 10 have no consumer, unit only). PR 12 (runs): Codex and `full` Claude answer with the new streaming card, steer or queue follow-ups, distinct stop notes (plan.md:1415), and Claude qa/write starts refusing (plan.md:1417). PR 13: titles. PR 14: the 仅读取项目目录/不限读取 setting (plan.md:1416) | Only PRs 12-14 are visible; PR 12 also brings a regression window |
| V6c baseline card features | not started | 子 agent area with live rows, progress line, images after the answer, stop cascades (plan.md:1485) | **Visible, the first new Feishu feature** |
| V6d Claude qa/write | not started | Claude `qa` answers but is denied `~/.ssh` and refuses to write (plan.md:1547) | Visible (restores tiers) |
| V7a Cursor, Grok, custom ACP | not started; needs accounts (#207) | a `full` group on Cursor, Grok or 自定义 ACP answers, stops within 5.5 s, shows a Chinese login hint (plan.md:1613) | Visible |
| V7b Pi | not started | `full` Pi group answers, stops within 3.5 s (plan.md:1675) | Visible |
| V7c Windows proofs | parked (#131) | on Windows, Codex qa either runs sandboxed or refuses (plan.md:1733) | Windows-only, parked |
| V8 bridge import | draft #226, no owner label | import screen, then every bot connected and the bridge gone (plan.md:1796) | Visible to bridge users |
| V9 bridge farewell release | not started (bridge repo) | DM card linking to the download; migrated bridge refuses to start (plan.md:1855) | Visible to bridge users; needs a signed installer |
| V10 accounts and machine list | not started | `vonvon login` on two machines, both listed online in the web UI (plan.md:1925) | Visible; needs a cloud deploy (#209) for real use |
| V11 encrypted remote management | not started | switch machines in the hosted web UI and change a group setting remotely (plan.md:2001) | Visible; needs a hosted cloud |

**Bottom line for section 4:**
- Two merged milestones were user-visible: V2 (the bot, same as the bridge) and V4 (the web UI). Neither was packaged or shown to the owner.
- The 20 product PRs since 2026-10-11 were all internal.
- On the current chain order, the next new thing in Feishu is V6b piece 12, 11 PRs away (#281 is piece 1 of 14). The first genuinely new feature, the subagent card, is V6c, after all 14 V6b pieces.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report's numbers hold up. The You-see count, the plan line shares, the 14 'personal review is optional' lines, the commit-type counts, the 11 V5 + 9 V6a merges, the empty release list, the open #208/#209/#226 and the V6b piece-12 timing all check out against the repo and gh. The decision attributions I sampled match PR #21, #210, #239 and the memory notes. The weak spots are framing. 'No document describes the product' ignores architecture.md:5-11. 'About half docs' is really 40%, and docs were concentrated on 10-11 and 10-12. 'Every PR since #69 is internal' ignores the #257 desktop window. The first-use refusal risk skips that 新建项目 defaults to full (lifecycle.ts:138). Two citations are wrong (plan.md:321, :2034). For the strategy decision, the report's biggest omission is the CI and serialization evidence. That evidence directly answers the user's question 1: 40 frozen CI rounds with 22 failed test jobs, mostly timeouts and Windows EBUSY; Windows jobs 7-10x slower than macOS; and V5 and V6b landing as strict serial chains of 15 and 14 PRs under a 2-PR WIP limit. The report also misses the existing 0.7.0 desktop app and the 17k-line #110 as concrete product references the owner may already have seen.


### 逐条复查

- **说过头了**：No document describes the finished product from the user's side. The only per-milestone user statement is a 'You see' box, 16 of them in 2128 lines (plan.md:264 … 1999).
  - 依据：`grep -n 'You see' docs/plan.md` gives 16 headers at the listed lines (a 17th hit, line 770, is a cross-reference). `wc -l docs/plan.md` = 2128. But architecture.md:5-11 has a short user-side description under 'Vonvon Bot 做什么': bots hand Feishu group and DM messages to local coding agents, group = project directory, topic = session, chat only in Feishu, desktop and web only for settings. The old README (origin/codex/device-handoff:README.md:3-15) lists desktop-preview features.
- **属实**：V3 takes 429 lines (plan.md:359-787) and V5 takes 400 lines (plan.md:887-1286), together 39% of plan.md.
  - 依据：The plan.md headings are V3 at :359, V4 at :788, V5 at :887 and V6a at :1287. 429 + 400 = 829 lines, and 829/2128 = 38.96%.
- **属实**：Every milestone says 'personal review is optional' (14 times), and merging without personal UI review is the user's own earlier authorization (plan.md:11, roadmap.md:79, AGENTS.md last bullet, #39).
  - 依据：`grep -c` finds 14 hits, at plan.md:779 (V3) through :2031 (V11). V1 and V2 have none, so it is every milestone from V3 on. plan.md:11 says 'The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review'. roadmap.md:79 and the last bullet of AGENTS.md say the same. Commit acf4bc3 (#39) changed AGENTS.md (+2 lines). Nuance: Codex recorded plan.md:11 while Claude was returning HTTP 401, so the docs carry the authorization as reported by agents.
- **属实**：Something tryable already exists: V4 (#69) merged 2026-10-11, `vonvon open` is at cli/index.ts:47, `gh release list` is empty, README.md:3 covers only the protocol package, and the V4 screenshots were saved under ~/vonvon-review/ (plan.md:875-878).
  - 依据：`gh pr view 69` shows mergedAt 2026-10-11T01:58:25Z. cli/index.ts:47 is `program.command('open')`. `gh release list` prints nothing and exits 0. README.md:3 is the V1 protocol text. plan.md:875-878 only prescribes the copy, but the #69 body (evidence table row) says the four screenshots and the 51.52 s video were copied to ~/vonvon-review/ with SHA-256 manifests.
- **说过头了**：Every product PR since #69 is internal plumbing: 20 product PRs merged, 11 V5 pieces (#246…#276) and 9 V6a pieces (#237…#272), none changing what a Feishu user sees except the outbound gate.
  - 依据：`git log --oneline main` confirms 11 V5 PRs (#246 #248 #251 #254 #257 #268 #270 #271 #274 #275 #276) and 9 V6a PRs (#237 #241 #244 #249 #255 #259 #262 #266 #272). But #257 adds 'the desktop window, tray, updater, packaging and UI restart', and packages/desktop/package.json has `start: electron .` and `package:dir`. That is user-visible in a dev build, as section 4 of the report itself says. #284 (test-only) also merged, and ~/.claude/vonvon-collaboration.md counts it as a product PR for the WIP limit. All 20 merged on 10-13 and 10-14 (git log dates).
- **说过头了**：The commit log is about half docs: main has 57 commits, 24 feat, 23 docs, 4 chore, 2 ci, plus the initial commit and 3 others.
  - 依据：`git log --format=%s main` gives 57 commits: 24 feat, 23 docs, 4 chore, 2 ci, 1 test, 1 refactor, 1 '#39 Record…', 1 Initial. That is 23/57 = 40% docs. By day (committer date): 10-11 had 7 docs + 2 feat, 10-12 had 7 docs + 2 ci + 0 feat, 10-13 had 10 feat + 3 docs, 10-14 had 10 feat + 1 refactor + 1 test.
- **说过头了**：Joined external groups default to `qa` (lifecycle.ts:206), so a new user's first message may get a refusal.
  - 依据：lifecycle.ts:206 is `assertBackendUsable(input.backend, input.mode ?? 'qa'); // 外部群默认「只读」档`. But lifecycle.ts:138, the createProject path behind 新建项目 in the DM menu, is `input.mode ?? 'full' // 创建默认「完全访问」档`, and `full` is not refused. providers.md:836 ('most qa and write cells refuse until the probes land') describes post-V6b behavior.
- **属实**：On the current chain order, the next new thing in Feishu is V6b piece 12, 11 PRs after #281 (piece 1 of 14). The first new feature, the subagent card, is V6c after all of V6b.
  - 依据：`gh pr diff 281` adds '*Split.* V6b lands as fourteen PRs and a deletion step … Each opens after the previous one merges'. PR 12 (`claude/v6b-runs`) carries 'You-see boxes 1 and 3', 'The known window opens when PR 12 merges', and 'PRs 4 to 6, 8, and 10 have no consumer'. The roadmap.md:33 graph is V6b → V6c. Not in the report: pieces 2-5 already exist as local branches and worktrees (claude/v6b-rehome, -provider-ids, -runtime, -goals, per `git worktree list`).
- **属实**：No Windows host and Windows checked only by frozen-head CI is a user decision, yet #208 still asks the user to decide.
  - 依据：The #239 body says '用户 2026-10-13 决定：目前没有 Windows 环境，也不为此部署新环境，不让 Windows 拖慢进度'. Memory vonvon-testing-split.md says the same. `gh issue view 208` shows OPEN 'OP-4 决定是否提供 Windows 主机（V7c）'. V7c is parked (roadmap.md:22, :33).
- **属实**：Full 3-OS CI only on frozen heads was an agent proposal answering the user's request to speed up. Whether the user chose the specifics is unknown.
  - 依据：The #210 body (Claude-authored) says 'Full three-platform runs happen only when the PR carries the `frozen` label'. Memory vonvon-program-tracking.md says 'On 2026-10-12 the user asked to speed up development. Decisions, written in PR #210'. The workflow landed in #217 (roadmap.md:97). Nothing records the user approving the specifics.
- **属实**：plan.md:7 still says Codex owns all code and Claude writes no product code, contradicting AGENTS.md.
  - 依据：plan.md:7 says 'Codex owns all code, every check in this plan … Claude Code on the Linux server … writes no product code'. AGENTS.md (分工) says Claude '按计划写产品代码和测试'.
- **属实**：Draft #226 (+2215/-10, opened 2026-10-12) sits outside the WIP flow with no owner label.
  - 依据：`gh pr list --state open` shows `226 draft=true +2215/-10 2026-10-12 codex/v8-bridge-import []`. The same listing has a second unlabeled draft, #234 (V6b SDK handoff, +37/-119), which the report did not mention.
- **有误**：V2 You-see: the Feishu bot works as it did under the bridge (plan.md:321). The UI warns on one appId on two machines (plan.md:2034).
  - 依据：plan.md:321 says only that `vonvon daemon run` 'starts, logs the supervisor ready line, and creates no file outside VONVON_HOME'. The Feishu behavior is in the V2 live lanes at plan.md:332-335 (DM menu, bind, `pwd` turn). The appId warning is at plan.md:1997, and plan.md:2034 is blank.

### 正文遗漏的事实

- CI cost data that bears on the user's Q1: the #284 body says the frozen heads of 2026-10-13 and 10-14 ran 40 full CI rounds and 22 test jobs failed. 15 failures were platform-tight unit timeouts and 4 were Windows EBUSY (directory deleted before a process exited). Each failure meant a fix plus a re-freeze. #276 hit the same EBUSY again. `gh run view` on recent full runs shows the Windows job takes 11-14 min and macOS 1-2 min. 3 of the 5 recent full runs (#285 twice, #276 once) failed only on Windows, and macOS passed all 5.
- Until the `frozen` label is set, the Linux CI job fails by design, so PR checks look red during development (memory vonvon-program-tracking.md; ci.yml:78-81 'Full-scope PR checks are deferred').
- A visible predecessor exists. The old Electron app 0.7.0 (PR #2, 'macOS PKG and Windows NSIS bundle Node and Core 0.7.0') sits on the stack up to #19 (origin/codex/device-handoff, package.json version 0.7.0). Its README:3 targeted 'Windows 和 macOS'. roadmap.md:107 says to close #2-#19 after V4, and they are all still open (`gh pr list`).
- #110 (codex/v5-desktop, +17,177/-2,281, opened 2026-10-11, owner:claude) is a complete V5 desktop+service implementation used as a split source. It is being re-landed as 15 serial PRs, each opened only after the previous one merges (/home/operator/vonvon/v5-split/plan.md:10). V6b is also strictly serial (#281 diff). With the WIP limit of 2 product PRs (AGENTS.md), this serialization explains much of the slowness.
- Pace by day: the V1-V4 PRs (#22, #24, #34, #69) all merged between 2026-10-10T02:37Z and 2026-10-11T01:58Z. 10-12 had zero product merges and 9 docs/CI merges (memory vonvon-role-split.md; git log). Product merges resumed on 10-13 under the new split. The collaboration file records 18 handoff returns on 10-13 (/home/operator/.claude/vonvon-collaboration.md).
- V5a (shell pieces 1-5, #246-#257) is fully merged, so V10 is already unblocked (roadmap.md:32 'V10 只要 V5 的外壳'). packages/desktop/package.json has `package:dir` (electron-builder --dir), so an unsigned build for the owner is possible today.
- What the CLI actually offers on main differs from the architecture list. `vonvon login` and `vonvon import` are not registered (cli/index.ts command list). `service install` and `uninstall` exist but throw SERVICE_UNAVAILABLE (host/service.ts:4) until V5 piece 14.
- A practical limit on handing the owner a build: the owner's live bridge runs on the Mac (`clay`, roadmap.md:79 area and V5 test constraints). Whether two clients on one Feishu bot both get events is still unverified (roadmap.md:113). Trying Vonvon therefore needs a separate test bot, and who creates it is still open (#21 body: '飞书测试 Bot 由谁创建').
- There is a product tension the report does not raise. The inherited 咖啡一下 feature forwards local Claude Code/Codex sessions to the DM when 'it 要审批、要问你' (dm-cards.ts:880), while providers.md:851 records 'Approval cards in Feishu. Excluded by the user.'
- The user rejected Feishu and the bridge as the dev or handoff channel and prefers GitHub or Linear (memory no-feishu-dev-channel.md, 2026-10-14). This matters for how intermediate builds reach the owner.
- Scale for the review load: the Mac full suite is 3120 passed / 51 skipped at #284 (#122 board body). The daemon source is about 49k lines and the UI source about 6.7k (`wc -l` over packages/daemon/src and packages/ui/src).
