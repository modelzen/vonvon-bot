# Where development time went, 2026-10-10 to 2026-10-14, and what the user already knows

## Key findings

- There was no product merge for 50.3 h of the ~100 h window. That is the time between V4 (#69, merged 10-11 01:58Z) and #237 (merged 10-13 04:18Z). In that gap, 10-12 had 7 merges and every one was docs or process (#116, #118, #120, #210, #214, #217). Two finished Codex branches were also thrown away: `codex/v6-claude-provider` (+45,652 lines) and `codex/v7-providers` (+98,935 lines), measured with `git diff --shortstat 21a21fa origin/<branch>`. The 10-12 redesign voided them (docs/roadmap.md:40, "原来复制 Paseo provider 闭包的 V6 和 V7 作废").
- Since Claude took over implementation (#235, 10-13 02:33Z), 25 PRs merged. 12 of them (48%) are service and process-lifecycle internals (launchd, systemd, Windows Run, holder, supervisor, drain, Gate L and M). They account for 13,406 lines, 49% of the lines merged in that period.
- **The user has nothing they can install.** `npm view vonvon-bot` and `npm view @modelzen/vonvon-bot` both return E404. `gh release list` is empty. README.md on main still only describes the V1 protocol package (README.md:1-9). Only 2 merged PRs produce a new screen: #69 (web UI) and #257 (Electron window). Both need a source build.
- The user is out of the loop because the plan was written that way. plan.md:11 says "authorized Codex to merge V2 and later planned PRs when verified, without personal UI review". AGENTS.md:37 says "不在版本边界等用户确认". The screenshots and videos are evidence for the agents' audit lanes (plan.md:48-66), not demos for the user.
- **Windows CI is the main thing breaking CI.** Since 2026-10-12 there were 71 full-chain CI runs and 32 failed. The Windows job failed in 21 of them, the macOS job in 7 (2 runs failed on both), and Linux in 6. Source: `gh api .../actions/runs?created=>=2026-10-12` and then `/runs/<id>/jobs` for every failed run.
- Remaining work is about 56 to 70 more product PRs plus 12 version gates. 24 product PRs have merged so far. At the Claude-period rate that is about 3 days of round-the-clock work. At the whole-program rate it is 10 to 12 days, before gates and user-blocked items.

---

## 1. PRs since #21, by category

Source: `gh pr list --state all --limit 200 --json number,title,state,createdAt,mergedAt,closedAt,additions,deletions,labels,headRefName`. That returned 78 PRs. I left out #2–#19 (the old app), #20 (closed before #21) and the dependabot PRs #80 and #81, which leaves **63 PRs: 53 merged, 6 open, 4 closed unmerged**. The categories are my own reading of each PR's title and body.

| Category | PRs | Merged / open / closed | Merged lines (+/−) | Open→merge hours, merged PRs (share) |
|---|---|---|---|---|
| A. Process, tooling, CI, process docs | #38 39 51 57 59 91 100 210 214 217 235 238 239 240 277 284 | 15 / 1 (#100) / 0 | 4,481 | 7.8 h (10%) |
| B. Design docs and plan | #21 35 37 49 64 79 82 107 108 109 113 115 116 118 120 121 223 | 14 / 0 / 3 | 5,631 | 9.5 h (12%) |
| C. Foundation port (V1–V3) | #22 24 34 | 3 / 0 / 0 | 102,446 (#24 is a scripted copy of bridge: 25,378 test lines, 3,972 lockfile lines) | 19.6 h (26%) |
| D. Service and process-lifecycle internals | #246 255 259 262 266 268 270 271 272 274 275 276 281 285 | 12 / 2 (#281, #285) / 0 | 13,406 | 20.1 h (26%) |
| E. Provider core internals | #237 241 244 249 117 234 | 4 / 1 (#234) / 1 (#117) | 4,779 | 5.9 h (8%) |
| F. User-facing (UI, desktop, install, import) | #69 248 251 254 257 226 | 5 / 1 (#226) / 0 | 31,069 (#69 = 22,928; #251 is 3,259 of 4,735 lockfile) | 13.1 h (17%) |
| F/D split source | #110 (+17,177/−2,281, open, owner:claude) | 0 / 1 / 0 | – | – |

**By period:**
- Before 10-13 02:33Z: 28 merged. 14 were design (B), 10 process (A), 3 foundation (C) and 1 user-facing (F, #69).
- From 10-13 02:33Z on: 25 merged. 12 D, 4 E, 4 F (#248, #251, #254, #257) and 5 A.

**Product merges per UTC day:**

| Day | Product PRs merged | All merges |
|---|---|---|
| 10-10 | 3 (#22, #24, #34) | 13 |
| 10-11 | 1 (#69) | 7 |
| 10-12 | 0 | 7 |
| 10-13 | 16 | 20 |
| 10-14 (to 05:30Z) | 4 | 6 |

**Rework and discarded work:**
- #110 (V5, 17,177 lines) is being re-landed in 15 pieces. The split table is in comment 6139553795; 11 of the 15 pieces have merged.
- In #117 (V6a, 7,485 lines), the process code was rejected because it assumed Node owns the child. It was rewritten around a native C holder (comment 6137396662, section "进程代码").
- The V6 and V7 branches above were abandoned.
- #226 (V8 import, 2,215 lines) has been open since 10-12. It is over the 1,500-line cap.

**What the user could see or try from the 53 merged PRs:**
- A new screen: #69 (`vonvon open` shows the Bot list in the old app's style, plan.md:839-840) and #257 (Electron window). Codex built a signed packaged `.app` on its Mac for acceptance, showing fixture bots (#257 comments). There is no record of it being given to the user.
- Behavior changes only at the edges: #34 removed the old console buttons from the DM menu (roadmap.md, V3 row). #249 blocks symlinked or remote images (plan.md:1319).
- Nothing that can be installed (npm E404, no releases).
- 44 of the 48 files in `packages/ui/src` have the same paths as the old app's `desktop/renderer` files (`comm -12` on `git ls-tree`), so the V4 UI is the old UI ported.

## 2. Remaining plan and projection

**Board, issue #122** (updated 2026-10-14T04:21Z). Tasks done per version: V5 5/11, V6a 1/8, V6b 0/8, V6c 0/3, V6d 0/3, V7a 0/5, V7b 0/4, V7c 0/4 (parked), V8 0/7, V9 0/3, V10 0/6, V11 0/5. The task issues #136–#202 cover 67 version tasks, of which 61 are open (`gh issue list`). The board's open-defect column adds up to 40. The board's V5 count (5/11) lags the sub-PR count (11/15).

**Sub-PR splits that are already defined:**
- **V5:** 15 PRs (comment 6139553795). 11 merged, #285 (piece 12) open, pieces 13–15 not opened. That is 4 PRs left, plus T8 and T9 native acceptance, the T10 gate, and T11 (signed, notarized installers and a public download page).
- **V6a:** 9 PRs merged (#237, 241, 244, 249, 255, 259, 262, 266, 272). Still open: T5, the native helper's five-platform build and signing pipeline (#151, at least 1 PR), and the T8 gate.
- **V6b:** "fourteen PRs and a deletion step" (docs/plan.md V6b *Split.* on `origin/claude/v6b-process-cutover`). So at least 15, and only #281 is open.
- **V6c–V11:** no split yet. They have 24 code tasks, not counting gate, native-lane and probe tasks. The observed expansion from tasks to PRs was 1.5× (V6a) to 2.1× (V5, V6b), which gives 36–50 PRs.

**Total remaining: about 56–70 product PRs**, against 24 product PRs merged so far. On top of that come 12 frozen-head gates (V5–V11). Each needs ten live lanes, perf, at least two audit lanes and an exact-head Shipping verdict (plan.md:209-212), and none has been done for V5 onward. There are also four open user tasks: #206 (Mac <Mac 测试用户> login), #207 (Cursor and Grok accounts), #208 (Windows host), #209 (cloud platform).

**Projection.** This is extrapolation, not a measurement.

| Rate used | Rate | Time for the PRs alone |
|---|---|---|
| Claude period: 20 product PRs between #237 merging (10-13 04:18Z) and #276 merging (10-14 03:47Z) | about 20 per day | about 3–3.5 days of 24-hour operation |
| Whole program: 24 product PRs in 4.2 days | about 5.7 per day | about 10–12 days |

Gate time after V4 is unknown. For reference, V3 (#34) took 13.45 h from open to merge and V4 (#69) took 3.75 h, both including their lanes. V10 and V11 cannot ship until #209 (cloud platform) is decided.

## 3. Handoff overhead

Source: all issue comments on #21+, read with `gh api repos/.../issues/<n>/comments`. I counted comments containing `交接：X → Y，head` (the format written by scripts/handoff.mjs:38) and `本 PR 第 N 次交接，等待额度阻塞：…` (scripts/handoff.mjs:42).

- **Handoffs:** 24 PRs had at least one, from #240 to #285. That is 71 handoff comments, **2.96 per PR** on average, or 2.95 across the 22 merged ones. The maximum is #257 with 9 handoffs, 25 comments in all.
- **Codex returning work to Claude:** 22 times, on 13 of the 24 PRs. 18 of those returns were on PRs opened 10-13, which matches the "18 次" in the collaboration notes.
  - At least 5 returns were caused by Windows: #251 (Windows native coverage put it on HOLD), #255 (Windows breakaway contract), #262 twice (Windows stdout and EOF), and #266 (#269, Windows spawn timeout).
- **Open to merge, Claude-period product PRs (n=20):** median 1.60 h, mean 1.77 h, maximum 5.65 h (#257).
- **Quota wait:** only recorded since #277. All 11 records say `0`. Before that it is unknown.
- **Comment volume:** #237–#285 carry 283 comments and about 480k characters, roughly 17.8k characters per PR. Tests are 56% of the added lines in 16 sampled product PRs (9,468 of 16,798, from `gh pr view --json files`).
- **CI cost:** 71 full-chain runs since 10-12, median about 15 minutes, maximum 80 minutes (`38469306960`), about 18 h of wall-clock time in total.
  - There were also 10 one-off Windows workflow runs for #251 and #255 ("PR 251 Windows diagnostics", "native probe", "fixture verification").
  - Open issues that are only about Windows CI or Windows runtime: #213, #215, #216, #222, #279, #288. There are two macOS CI issues, #212 and #286.

## 4. The baseline the user already knows

**feishu-codex-bridge.** Published on npm as `@modelzen/feishu-codex-bridge` 0.6.14 (modified 2026-09-24, from `npm view`). There is a local checkout at /home/operator/vonvon/feishu-codex-bridge at commit `6698118`. Per its README:
- A Feishu group is a project and a thread is a session.
- Codex and Claude Code backends (README.md:71).
- Streaming cards with stop, steer, `/goal`, images and files, local-file fetch, "咖啡一下" (handing local CLI approvals to Feishu, :77), doc-comment replies, and multiple bots (:80).
- Three sandbox tiers (:81).
- A resident service on macOS, Windows and Linux with login autostart and crash restart (:82).
- A web console and a DM console, plus voice-to-text.

**Old Electron app.** This is the codex/* stack #2–#19, tip `origin/codex/device-handoff`, none of it merged. #2 alone is "deliver 0.7.0…", +47,021 lines. Per its README:
- Agent page with the registered bots and their groups (README.md:9).
- Group page, environment page (Codex install and device-code login), and new bindings with folder, tool and session mode.
- Tray, keeps running after the window closes (:13).
- CLI registration, and update, usage, log, machine and history panels.
- It used bridge data directly, with no import step ("无需导入").
- It never shipped: "目前尚未发布正式安装包" (:5).
- #10–#18 (10-05 to 10-06) are small "align with Bridge" UI tweaks. My guess is that they came from the user reviewing the app, but that is not recorded.

**What v2 adds, from the user's point of view** (docs/architecture.md, docs/roadmap.md, the plan's "You see" boxes):

| Item | Type | Version |
|---|---|---|
| Daemon, web UI and desktop | Parity or rebuild. Architecture.md:51-53 says the gain is that a single writer removes lock conflicts. The web UI is the old app's screens; the desktop app and service are rebuilt under a new identity. | V2–V5 |
| Bridge data import and stopping the bridge | Migration. The old app did not need an import at all. | V8, V9 |
| Read-scope choice, reliable stop and outcome note, steer queue | New, small | V6b (plan.md:1413-1416) |
| Run card: subagent area, per-subagent stop, progress line, images | New | V6c |
| Claude read-only and read-write tiers, re-proven | New, small | V6d |
| Cursor, Grok, custom ACP, Pi | New | V7a, V7b |
| Accounts, machine list, remote management over an encrypted relay | New, the biggest addition | V10, V11, last in the chain |

So the first change a bridge user would notice in Feishu arrives with V6b's 12th sub-PR.

## 5. How rigorous the plan is compared with what a first version needs

docs/plan.md is 422,685 bytes, with 601 checkboxes and none ticked. The docs folder totals 763,644 bytes. Every version, V1 to V11, needs at least 10 live lanes (V3 and V6b need 12), perf, at least 2 audits and Shipping. The CLI evidence bundle needs sha256 manifests, terminal replay and an independent rerun (plan.md:58-66).

Five examples of work that hardens edge cases rather than enabling first use:

1. **Manager-owner proof and drain rounds** (plan.md:986; pid-reuse traces (a)–(f) at plan.md:1132-1135; #270, 656 lines). Before stopping a lock owner during an install rollback, the code makes four ordered observations to prove the owner is the service manager's child. This matters only if a pid is reused mid-transaction.
2. **Gate L** (plan.md:1065, 2113; #276). On Linux, a self-update under systemd needs its update helper to run in a `systemd-run --user --scope` and be proven ready from `/proc/<pid>/cgroup` before the daemon exits with code 75. plan.md:1063 says an earlier review "proved two paths unsafe".
3. **Gate M** (plan.md:1096; #271, +1,121/−215; composed traces in #276). Ordering of macOS launchd load, replace and rollback unload. Bootout happens only after the definition is withdrawn and the drain is done.
4. **The native process holder** (providers.md:493-540; #255, #259, #262, #266, #272: five PRs, about 5.1k added lines). A C11 `vonvon-holder` acts as the POSIX parent, a Windows supervisor uses Job Objects, and there is a five-stage ledger, StartTokens, `EXIT_REPORT_HOLD_MS` and `sweepOrphans`. The goal is to never signal a recycled pid and never leave orphan agents after a crash. V3 had accepted best-effort process-group signalling as a known limit (roadmap.md, "已知风险").
5. **Pre-lock guard edge cases** from #285. Open issues #287 (a PID-reuse misjudgment stops the service's automatic retry) and #288 (a Windows Run-key read through Add-Type blocks startup). On top of that, V6a-T5 (a five-platform build and signing pipeline for the helper) and V7c (Windows sandbox proof cells) are still to do.

The bridge already shipped resident services on all three operating systems (bridge README.md:82). Most of category D's 13.4k merged lines are a rewrite of that feature under a new identity with stronger guarantees, not new capability.

---

**Unknowns:**
- Whether the user ever ran the old app or the #257 packaged build.
- Quota waits before #277.
- How long the gates take from V5 onward.
- The real PR expansion for V6c–V11.

My working files are in （调研代理的本地临时目录，未归档） (prs.json, comments.jsonl, runs.jsonl, issues.json, cat.json with my category for each PR, an.py).


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：I re-checked 12 of the report's claims. Five hold up: the 50-hour stretch with no product merge, the 49% share for service and process work, the handoff numbers, the port of the old UI (stronger than reported: 24 of 44 files are byte-identical), and the bridge feature baseline.

**Overstated or wrong:**
- **Discarded branches:** the two sizes overlap, since v7 contains v6, and about 60% of the lines are Paseo code that was copied in.
- **Nothing to try:** no package or release is published, but a source build already runs a real Feishu bot, serves the old-style web UI, and can be packed into a tarball or a signed .app.
- **Who left the user out:** the "no personal review" rule is an authorization the user gave and the agents recorded, not a choice the agents made alone.
- **Windows CI numbers:** the counts are off and "Linux failed in 6" is wrong (0). The conclusion holds and is stronger: Windows failed in 22 of 26 failed full runs, and was the only failing platform in 20.
- **Windows-caused returns:** 4 are clearly Windows, not 5.

**Not supported:** the projection of about 3 days of work uses a rate inflated by re-landing code that was already written (15 of 20 PRs), and "the first Feishu-visible change comes with V6b piece 12" has no source.

**Missing context for the Windows CI decision:**
- Windows and macOS already run only on frozen heads.
- GitHub requires only the `linux` check to merge, so the Windows gate exists only in policy text (plan.md:212, roadmap.md:101, AGENTS.md:29). Dropping it is a documentation change.
- AGENTS.md:29 itself generates Windows development work.
- Windows CI found several real Windows-only bugs. Most of its failures, though, were test-fixture timeouts and EBUSY errors, per the #284 body.


### 逐条复查

- **属实**：There was no product merge for 50.3 h, from #69 (merged 10-11 01:58Z) to #237 (merged 10-13 04:18Z). 10-12 had 7 merges and all of them were docs or process.
  - 依据：gh pr list --state all --json mergedAt: #69 merged 2026-10-11T01:58:25Z and #237 merged 2026-10-13T04:18:15Z, which is 50.33 h apart. The 10-12 merges were #115, #116, #118, #120, #210, #214 and #217, all titled docs(...) or ci(...). The report says 7 but names only 6; #115 is the one left out. Product work did happen in that gap, but on branches that did not merge (#110, #117, codex/v6 and codex/v7).
- **说过头了**：Two finished Codex branches were thrown away: codex/v6-claude-provider (+45,652 lines) and codex/v7-providers (+98,935 lines).
  - 依据：git diff --shortstat 21a21fa origin/<branch> gives the same 45,652 and 98,935. git merge-base --is-ancestor origin/codex/v6-claude-provider origin/codex/v7-providers returns true, and the v6-to-v7 diff is +53,324. git diff --numstat 21a21fa origin/codex/v7-providers shows 60,184 of the 98,935 added lines on paths matching paseo or vendor. The two largest files are agent/paseo/protocol/messages.ts (+7,642) and paseo/closure.json (+2,980).
- **属实**：Since #235 (10-13 02:33Z), 25 PRs merged. 12 of them (48%) are service and process-lifecycle internals, with 13,406 lines, which is 49% of the lines merged.
  - 依据：Excluding #235 itself, 25 PRs merged after 02:33:09Z. #246, 255, 259, 262, 266, 268, 270, 271, 272, 274, 275 and 276 add up to 13,406 lines (additions plus deletions) out of 27,307, which is 49.1%. Counting additions only, it is 11,106 of 24,160 (46%). 1,358 of those lines are pure deletions in #268, which retired the bridge-era Windows service. The category itself is the report's own judgment: five of the twelve are V6a provider process-holder PRs (#255, 259, 262, 266, 272).
- **说过头了**：The user has nothing they can install. npm returns E404 for both names, there are no GitHub releases, and the README only describes V1.
  - 依据：`npm view vonvon-bot` and `npm view @modelzen/vonvon-bot` both return E404. `gh release list` prints nothing. README.md is 9 lines about @vonvon/protocol. Root package.json has the scripts `pack:vonvon-bot` and `check:daemon-package`. In the #24 comment of 2026-10-10T07:55Z, Codex reports seeing the v0.7.0 management card in native Feishu after a real DM `/menu`. plan.md:839-841 is V4's 'You see' box: `vonvon open` shows the Bot list. In the #257 comments of 2026-10-13T13:35Z and 17:03Z, `npm run package:dir` produces a Mac arm64 .app signed with Developer ID and not notarized.
- **说过头了**：The user is out of the loop because the plan was written that way (plan.md:11, AGENTS.md:37).
  - 依据：plan.md:11 says 'The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review or a manual merge click.' AGENTS.md:37 says '用户已授权连续执行后续版本 … 不在版本边界等用户确认'. #39 (merged 10-10 12:22Z) added that rule. plan.md:46 says '…proceed through independent review and guarded Shipping without waiting for personal review'. plan.md:205 makes the window check an agent step: 'The Mac agent replaces it with what it saw.'
- **有误**：Windows CI is the main thing breaking CI: 71 full-chain runs since 10-12, 32 failed, the Windows job failed in 21, macOS in 7 (2 on both), Linux in 6.
  - 依据：gh api actions/runs?created=>=2026-10-12 returned 349 CI runs. I then read /actions/runs/<id>/jobs for all 349 and classified each run by the conclusions of its windows-2025, self-hosted and ubuntu-latest jobs. The report's own runs.py defines a full chain as any run longer than 8 minutes, which is a proxy and does not match the actual jobs. All 22 Windows failures were in the step 'Run npm test'. The #284 PR body says that across 40 frozen full runs on 10-13 and 10-14, 22 test jobs failed, 'mostly from test fixtures, the product code itself was fine': 15 were timeouts too tight for the platform and 4 were Windows EBUSY. Each of those needed another freeze.
- **属实**：24 PRs had handoffs, with 71 handoff comments (about 2.96 per PR). Codex returned work to Claude 22 times on 13 PRs, 18 of them on 10-13. #257 had the most, at 9. All 11 quota-wait records say 0.
  - 依据：I fetched comments for issues 21 to 290 and matched the HANDOFF_LINE regex from scripts/handoff.mjs:39. That gives 24 PRs (#240 to #285) and 74 handoff lines spread over 71 comments; three comments on #249 contain more than one line. There are 22 codex→claude returns on 13 PRs, and 18 of them are dated 2026-10-13. #257 has 9. The recordLine pattern from :42 matches 11 times, all with the value 0, on #277, #281, #284 and #285.
- **说过头了**：At least 5 returns were caused by Windows: #251, #255, #262 twice, and #266.
  - 依据：From the codex→claude comment bodies: #251 at 10-13T08:28Z, #255 at 13:27Z, #262 at 17:24Z, and #266 at 20:40Z, where full CI 38461671897 shows 'Linux success, Mac failure, Windows failure'. The #262 comment at 16:23Z says '上面是跨平台 Node 生命周期证据，不冒充 Windows 原生执行', and its P1 is an unhandled spawn ENOENT reproduced on Mac.
- **unsupported**：About 56 to 70 product PRs remain. At the Claude-period rate of about 20 per day, that is about 3 to 3.5 days.
  - 依据：#246 body: '代码来自 codex/v5-desktop 的 cf485db，原样带过来'. #271 body: '对源文件不做改动'. #237 body: '与 #117 在 212bac6 的同名文件逐字节相同'. #241 body: '原样搬自 #117'. The V5 split table is in comment 6139553795. On the V6b split, docs/plan.md:1370 on origin/claude/v6b-process-cutover says 'fourteen PRs and a deletion step', which confirms that part. roadmap.md:22 and :33 say V7c parks with no Windows host and blocks nothing. #209 (OP-5, cloud platform) is open.
- **属实**：44 of the 48 files in packages/ui/src have the same paths as the old app's desktop/renderer, so the V4 UI is the old UI ported.
  - 依据：Running comm -12 on the git ls-tree output for origin/main:packages/ui/src and origin/codex/device-handoff:desktop/renderer finds 44 shared paths. The content is even closer than the paths suggest: 24 of the 44 files are byte-identical, and the whole set differs by only 625 diff lines over 19,131 lines. The 4 new files are client-context.tsx, directory-picker.tsx, features.ts and url-actions.ts.
- **属实**：The bridge already ships resident services on macOS, Windows and Linux, with login autostart and crash restart (bridge README.md:82). It is published as @modelzen/feishu-codex-bridge 0.6.14.
  - 依据：/home/operator/vonvon/feishu-codex-bridge, commit 6698118. README.md:82 says '跨平台常驻：macOS / Windows / Linux·WSL 均可注册成后台服务、开机或登录自启、崩溃自动拉起'. :71 covers the two backends, :77 咖啡一下, :80 multiple bots and :81 the three sandbox tiers. `npm view` shows version 0.6.14, time.modified 2026-09-24T14:12:37Z.
- **unsupported**：The first change a bridge user would notice in Feishu arrives with V6b's 12th sub-PR.
  - 依据：docs/plan.md:1370 on origin/claude/v6b-process-cutover gives the order of pieces 10 to 14. roadmap.md:13, in the V3 row, says '旧网页管理路由改成 RPC，只读预览和旧网页页面退役，私聊菜单去掉旧控制台按钮'.

### 正文遗漏的事实

- CI already runs Windows and macOS only on frozen heads, not on every push. In .github/workflows/ci.yml:85-86 the windows job runs only `if: needs.linux.outputs.full == 'true'`, and in .github/scripts/ci-scope.mjs, isFullRunEligible requires the `frozen` label or a manual dispatch. docs/ci-costs.md describes the same behavior. What Windows actually costs is a merge gate, not frequent runs. Every Windows failure after a freeze means another fix-and-refreeze cycle (see the #284 body).
- The GitHub ruleset on main requires only the `linux` status check. `gh api repos/modelzen/vonvon-bot/rules/branches/main` shows required_status_checks [{context: linux}] with strict on. The Windows and macOS requirement exists only in policy text: plan.md:212, roadmap.md:101 and AGENTS.md:29. Lightening Windows CI is therefore a change to those documents, with no repository setting to change.
- AGENTS.md:29 creates Windows development work, not only CI time. It requires Claude to write Windows-only behavior as real-process or real-registry tests that run in the Windows CI job. #251 was put on HOLD under exactly this rule (comment 2026-10-13T08:28Z), and the #251/#255 work also needed 10 one-off Windows diagnostic workflow runs.
- Windows CI caught real Windows product defects, not only flaky tests. #264 and #265 are bug-labeled issues in the Windows supervisor (pipe blocking, stdout EOF), found on #262. #269 is a Windows ProcessHost launch failure whose root cause is still unconfirmed (#279). #288, still open, is a Windows Run-key read through Add-Type that blocks daemon start when no service is installed. The #110 split table predicted the PowerShell cost on Windows (comment 6139553795, 风险 section). Deferring Windows CI defers this class of bug.
- Native Windows acceptance is already deferred in the plan. V7c is a leaf that parks when there is no Windows host (roadmap.md:22, :33), and #208 (OP-4, whether to provide a Windows host) is open with the needs-operator label. There is also a precedent for lightening CI: on 2026-10-10, when Actions minutes ran out, the operator authorized merges without GitHub results (roadmap.md:103, and the plan.md CI policy 'Temporary CI waiver').
- Something can already be tried from source today. #24 (comment 2026-10-10T07:55Z) verified the V2 daemon with a real Feishu bot via /menu. V4 adds the web UI through `vonvon open` (plan.md:839). `npm run pack:vonvon-bot` builds an installable tarball (root package.json). A signed .app was built on the Codex Mac (#257 comments). It is unknown whether a fresh user can register a bot through the v2 UI.
- The user was at the Mac during #257 acceptance and authorized adding a localhost certificate to the login keychain (#257 comment 2026-10-13T14:51Z), but nothing records them seeing or using the app.
- The old-app PRs #2 to #19 are still OPEN, not closed (gh pr list), so in repository terms the old Electron app is neither merged nor abandoned.
- The board in issue #122 is confirmed: V5 5/11, V6a 1/8, everything else 0. The 67 task issues #136 to #202 include 12 gate tasks and 61 open ones. The user tasks #206 to #209 are all open with needs-operator (gh issue list).
