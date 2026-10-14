# Where development time goes, and the Codex/Paseo tooling limits

## Summary

- **The PR loop is fast. Waiting and scope are the slow parts.** 23 product PRs merged in 25.4 h (2026-10-13 03:18Z → 10-14 04:43Z). Each took a median of 71 min from open to merge. Before they were even opened, though, V5 pieces 7–12 sat waiting a mean of **7.7 h** for one of the two in-flight PR slots. The code itself was already written on 10-11 in #110 (the 17,177-line V5 desktop PR now used as the split source). It is being re-landed as 15 serial PRs.
- **Nothing the owner can try has been delivered, but a usable core is already on `main`.** That core is the ported bot runtime (V2), the daemon and its CLI (V3), the web UI (V4), the Electron shell (V5 parts 1–5, last one #257) and an npm tarball builder (#248). Almost all work since 10-13 is hardening that the owner cannot see: service gates, process holders and Windows transactions. The plan has **601 unchecked boxes and 0 checked** (`grep -c` on docs/plan.md).
- **pstack's fixed overhead is real but small on the Claude side.** The panels add roughly 10–30 min of wall time per PR when they run. The heavier per-PR cost is on the Codex side: the full Mac test suite, exact-head Shipping, strict-base re-freezes and Windows CI loops.
- **The owner's premise about Computer Use is partly outdated.** Paseo drives Codex through `codex app-server`, not `codex exec`. A Paseo-driven Codex review session on the Mac already used the computer-use tool `cua_repl` to read the Feishu client's accessibility tree and take screenshots. It also used Playwright `_electron.launch` to drive the real Electron app.

---

## 1. pstack: what each skill requires per task

Source: pstack 0.9.80 at `~/.claude/plugins/cache/pstack-claude/pstack/0.9.80/skills/`. The Mac Codex side runs 0.9.84 (seen in the PR #281 session log paths).

| Skill | Mandatory steps and fan-out | Source |
|---|---|---|
| poteto-mode | Triggers for every task. Nontrivial work goes to `how`. Code that crosses a function boundary goes to `architect`. A contested design goes to `interrogate`. `/deslop` runs before commit, `/no-comments` before review, and `technical-writing` plus `unslop` for PR text. Every reply names the principles applied. Every step of the matched playbook is copied into the todo list verbatim. | poteto-mode/SKILL.md:16-39, 126 |
| Feature playbook | 1. `how`. 2. `architect`. 3. A four-item throughput checkpoint. 4. Delegate the code to a subagent in its own worktree. This step says "Mandatory: no skip-with-reason escape" and may become an `arena` instead. 5. Verify. 6. Rebase. 7. `interrogate` if contested. 8. Opening a PR. | playbooks/feature.md:5-17 |
| how | Simple question: 1 explainer. Complex question: 2–4 explorers plus 1 synthesizer. | how/SKILL.md:20-53 |
| architect | Phase A runs `how`, plus `why` if layering changes. Phase B runs an arena with runners opus, fable, sonnet and haiku, and "Design it twice": at least 2 structurally distinct candidates. Phases C–E follow. | architect/SKILL.md:26-44, 96; pstack-models.md `architect runners` |
| arena | Six phases: frame, fan out N, cross-judge (1 extra agent), pick (read every candidate end to end), graft, verify. | arena/SKILL.md:16-74 |
| interrogate | One reviewer per configured model. Here that is 4: opus, fable, sonnet, haiku. Then a lead-judgment synthesis. | interrogate/SKILL.md:37-46; pstack-models.md |
| swarm | N workers on opus, then aggregate. | swarm/SKILL.md:26-33 |
| Opening a PR | Rebase into small commits, run deslop, no-comments, technical-writing and unslop. A subagent that opens a PR also runs `interrogate`. | playbooks/opening-a-pr.md:64-66, 93 |
| Shipping (Codex) | 11 steps. One independent verifier subagent per PR, with patch-id records, `ship-pr cancel-pending`, a `--match-head-commit` merge and `watch-pr`. | playbooks/shipping.md:43-55 |

Local overrides add more:
- `vonvon-collaboration.md:14` makes `interrogate` mandatory before any handoff touching subprocesses, concurrency, shutdown order, error paths or Windows native code. That covers almost every V5b, V6a and V6b PR.
- `plan.md:209` adds, per PR, an "evidence-grade swarm". It has one gates lane, ten live lanes, one perf lane and two or more audit lanes. `plan.md:272` says "Ten lanes on the configured `swarm workers` model".

**Overhead per feature PR, by the letter of the rules (inference).** On the Claude side that is how (1–5 agents), plus an architect arena (4 runners and 1 judge), plus 1 implementer, plus interrogate (4): about 11–15 subagents in about 4 sequential phases. On the Codex side it is at least 1 verifier, plus the 14-lane plan swarm on gate-ready heads.

**What actually ran (measured from `~/.claude/projects/*/*.jsonl` subagent transcripts):**
- Session `7dd413cc` (10-13 03:06 → 10-14 04:58, covering V6a 2/6 and the V5 split) spawned 17 subagents, 146 subagent-minutes in total. It held one architect arena at 10-13 03:31: opus 15.5 min, sonnet 11.1, haiku 8.2, sonnet judge 2.8. It held two interrogate panels at 10-14 02:42 and 04:01, each 4–8 min per reviewer.
- Session `dad7f6a1` (for #284) spawned 15 subagents (123 min) and held one interrogate panel: opus 6.1, sonnet 2.3, haiku 4.5, fable 6.3 min.
- Panels run in parallel. So an arena costs about 15 min of wall time and an interrogate panel about 8 min, plus the lead's synthesis.
- In practice Claude did not run an arena for every PR. The Claude-side pstack cost is roughly **10–30 min wall per PR**, plus quota from the 4-model panels, which was not measured. That is small next to the waits in section 2.

---

## 2. The PR loop, measured from GitHub (PRs #237–#285)

Method:
- Handoff comments are matched on `交接：X → Y，head …` (scripts/handoff.mjs:38).
- Owner and frozen label times come from `issues/<n>/events`.
- Numbers in the range that are issues were excluded: #242, 243, 245, 247, 250, 252, 253, 256, 258, 260, 261, 263–265, 267, 269, 273, 278–280, 282, 283.
- "→frozen" means minutes from the first handoff to the *first* `frozen` label. "frozen→merge" includes any rework after an unfreeze. #237 predates the handoff script.

| PR | +/− | Opened (UTC) | →frozen | frozen→merge | open→merge (min) | Handoffs (bounces to Claude) |
|---|---|---|---|---|---|---|
| 237 V6a 1/6 | +916/−3 | 10-13 03:18 | – | 14 | 60 | 0 |
| 240 handoff script | +414/−7 | 04:17 | 28 | 11 | 40 | 6 (2) |
| 241 V6a 2/6 | +1436/−64 | 04:25 | 40 | 13 | 54 | 3 (0) |
| 244 V6a 3/6 | +918/−280 | 05:38 | 67 | 47 | 115 | 3 (1) |
| 246 V5 1/15 | +961/−397 | 06:24 | 24 | 13 | 37 | 1 (0) |
| 248 V5 2/15 | +624/−33 | 07:09 | 12 | 33 | 45 | 1 (0) |
| 249 V6a 4/6 | +1049/−113 | 07:37 | 92 | 35 | 128 | 5 (2) |
| 251 V5 3/15 | +4590/−145 | 08:13 | 9 | 115 | 125 | 3 (1) |
| 254 V5 4/15 | +1263/−20 | 12:19 | 17 | 35 | 52 | 1 (0) |
| 255 V6a 5/6 | +1043/−17 | 12:19 | 27 | 72 | 100 | 5 (2) |
| 257 V5 5/15 desktop window | +1436/−30 | 13:17 | 322 | 16 | **339** | **9 (4)** |
| 259 V6a 6a | +1223/−9 | 14:42 | 21 | 50 | 71 | 3 (1) |
| 262 V6a 6b | +1153/−9 | 16:12 | 19 | 92 | 112 | 5 (2) |
| 266 V6a 6c | +1206/−37 | 18:08 | 26 | 264 | **291** | 5 (2) |
| 268 V5 6/15 | +63/−1358 | 19:01 | 8 | 91 | 99 | 1 (0) |
| 270 V5 7/15 | +656/−3 | 20:44 | 4 | 16 | 21 | 1 (0) |
| 271 V5 8/15 | +1121/−215 | 21:09 | 6 | 148 | 154 | 1 (0) |
| 272 V6a 6d | +513/−20 | 23:05 | 22 | 71 | 94 | 3 (1) |
| 274 V5 9/15 | +1024/−209 | 23:50 | 4 | 17 | 21 | 1 (0) |
| 275 V5 10/15 | +1280/−8 | 10-14 00:16 | 26 | 20 | 46 | 3 (1) |
| 276 V5 11/15 | +863/−18 | 01:07 | 8 | 152 | 160 | 1 (0) |
| 277 handoff record | +54/−10 | 01:13 | 13 | 17 | 30 | 3 (1) |
| 284 test timeouts | +346/−135 | 03:55 | 25 | 23 | 48 | 1 (0) |
| 281 V6b 1/14 (open) | +822/−348 | 01:53 | – | – | open | 5 (2) |
| 285 V5 12/15 (open) | +1135/−47 | 03:55 | 9 | – | open | 1 (0) |

**Averages over the 23 merged product PRs (docs-only #238 and #239 excluded):**
- Open→merge: mean 97 min, median 71, max 339 (#257).
- Handoff→first frozen: mean 37, median 21. First frozen→merge: mean 59, median 35.
- Handoffs: mean 2.83 per PR. There were **20 bounces back to Claude across 12 of the 23 PRs**. Bounced PRs averaged 124 min against 68 min for the others.
- Summed label-owned time: `owner:codex` 34.9 h, `owner:claude` 2.4 h. Claude's rework is fast, and Codex verification is the loop's main cost.
- Every `--quota-wait` recorded so far is 0 (handoff comments on #277, #281, #284, #285). Quota was not a recorded blocker.

**The biggest waits, ranked:**

1. **Waiting for a PR slot (WIP cap of 2 plus a serial chain).** Commit author dates against PR creation (`gh api pulls/<n>/commits`):
   - #270: authored 14:19, opened 20:44 (6.4 h).
   - #271: 15:51 → 21:09 (5.3 h).
   - #274: 16:04 → 23:50 (7.8 h).
   - #275: 16:47 → 00:16 (7.5 h).
   - #276: 16:51 → 01:07 (8.3 h).
   - #285: 16:57 → 03:55 (11.0 h).
   - Mean 7.7 h, about 4.8 times the in-loop time. The rules: AGENTS.md:22 (two product PRs in flight at most) and :23 (1500-line cap). The V5 code dates from #110, open since 10-11 18:14Z (`gh pr view 110`). program-graph.json notes "#110 按其拆分表拆成 15 个串行 PR" (split into 15 serial PRs by its split table).
2. **Windows CI as the only Windows test loop.** Since 10-13 03:00 there were 49 full CI runs of 5 min or more. 28 passed and 20 failed, and the mean run took 16.7 min. The failed jobs were Windows only in 15, macOS only in 4, and both in 1 (`gh run view --json jobs`). For example, #276 had three frozen runs fail on Windows (01:15, 01:53, 02:26), giving 152 min frozen→merge. #285 is failing on Windows right now (runs 38509583067 and 38512080737). AGENTS.md:28 allows full CI only on the frozen head, so Windows defects surface only after handoff.
3. **Bounce-backs.** Most bounces are contract defects in processes, concurrency or Windows code, filed as issues #243, #245, #250, #260, #263–265, #267, #269, #273, #282 and #283. #257 bounced 4 times over 5.6 h. Its scope grew to include signed packaging, a local HTTPS update feed with a keychain, and a ±15% perf gate passed with 61 ms of margin (#257 comments 10-13 13:35–18:34). #275 bounced over a plan.md code-fence placement.
4. **Strict base invalidating the other in-flight PR.** The ruleset "Protect main" has `strict_required_status_checks_policy: true` on `linux` (`gh api repos/modelzen/vonvon-bot/rulesets/24838891`). Each merge forces the other open PR to merge `main`, re-freeze and rerun full CI. There are 16 "Merge … origin/main" commits across 15 PRs. Issue #122 records #244 passing three-platform CI on its old head and still being "被 strict base 门拦下" (blocked by the strict-base rule).
5. **Model capacity stalls on the Mac.** Paseo session `e6206e4` ("PR #281") has status `error`. Its log has 8 lines of "Selected model is at capacity", and it was last updated 03:41:27Z (`paseo inspect/logs --host 10.0.0.11:6767`). The independent Shipping verdict PASS+NOTES was posted at 03:01:16Z. At 05:32Z the PR was still `owner:codex` and unmerged, a stall of at least 1 h 51 min with nobody restarting the session.
6. **Verification continuing after a PASS.** After that PASS+NOTES, the same #281 session started "round3" live checks: a stop-contract check, then `cua_repl` inspection of Feishu (log lines 673–708).
7. **The earlier planning phase (10-10 to 10-12).** 17 of 27 merged PRs were docs-only (`gh pr list` grouped by day). `docs/` changed by +5,988/−1,017 lines since 10-10. The provider layer was redesigned (#116, replacing V6/V7), and #117 (7,485 lines) was closed unmerged. docs/native-acceptance-hosts.md alone is 685 lines of test-host rules.

---

## 3. Plan rigor: examples, and what a first usable build needs

Examples of the gates in docs/plan.md:
- **CLI evidence bundle** (plan.md:57-65). A terminal recording pass and a structured pass, a checker script, and a `manifest.json` with the sha256 of every `dist` file. An independent audit then rebuilds from a fresh worktree and must reproduce every assertion.
- **Gate L** (plan.md:1065-1095). Linux managed-core-update helper readiness. It polls `/proc/<pid>/cgroup` and `cmdline` every 50 ms under `systemd-run --scope`, cites systemd v255 `run.c` line numbers, and adds 7 deterministic test families.
- **Gate M** (plan.md:1096-1145). The macOS launchd unload barrier (B1 withdraw, B2 drain, B3 bootout), with pid-reuse traces (a)–(f). One trace is still "not yet written".
- **Manager-owner proof** (plan.md:986). Four ordered observations O1–O4 before any stop. Drain rounds live in `service/drain.ts` (#270).
- **Native service acceptance** (plan.md:1252-1266). 12 steps on launchd and on systemd under a dedicated user. They include a drain held for 120 s or more, a `kill -9` crash recovery within 15 s, and bridge records that must stay byte-identical.
- **Perf gate** (plan.md:1267-1272). Five interleaved launches each of the old and new app. It fails if the new app is more than 15% slower or uses more than 15% more memory.
- **"Tests alone are not sufficient verification…"** is repeated in every version (plan.md:23, 268, 272, 285 …). There are ten live lanes per version.
- **The splits.** V5 has 15 PRs (program-graph.json). V6a has 9, with piece 6 split into 6a–6d (plan.md:1293). V6b has "14 个 PR 加一个删除阶段" (14 PRs plus a deletion phase; PR #281 body).

My judgment (an opinion, not a measurement) of what a first build the owner can try on the Mac needs:

| Needed now (mostly already merged) | Later hardening (can wait for feedback on the product's shape) |
|---|---|
| Bot runtime port (V2, #24). Daemon, pid lock and CLI `daemon start/stop/status`, `open` (V3, #34; packages/daemon/src/cli/index.ts:20-47). Web UI (V4, #69). Electron window, tray and restart (V5 1–5, #246–#257). npm tarball (#248, smoke-installed on the Mac per #251 comments). | Gate L, Gate M with pid-reuse traces (a)–(f), and the manager-owner proof. These only matter for OS-service install, replacement and managed updates. Until then the owner can run `vonvon daemon start` or keep the app open. |
| Not disturbing the owner's daily bridge or Feishu bot, and keeping secrets in the keystore. | Windows Run-key and launcher transactions (#275) and the Windows supervisor (#262). There is no Windows user yet (plan.md:2115: "stays unverified until a Windows host exists"). |
| A 60-second demo video and screenshots that the owner actually sees. Today the evidence sits on the Mac at `~/vonvon-review/…` (#257 comment 17:50). | The ±15% perf gate against the old app, the CLI evidence-bundle hashing, the 12-step native service acceptance, holder.c/ProcessHost orphan reaping (V6a), the V6b engine cut-over, V7 ACP engines, and V10/V11 accounts and relay. |

The current V2 agent backends (`packages/daemon/src/agent/codex-appserver`, `claude-agent`) already run Codex and Claude without the V6 rewrite. The #281 Codex review drove a real Feishu test group with them (session log, lines 233–708).

---

## 4. Codex through Paseo and desktop acceptance

**How Paseo launches Codex.** Paseo 0.11.1 runs `codex app-server` over stdio JSON-RPC. It does not use `codex exec`. The code is in `~/.local/share/paseo-runtime/0.11.1/node_modules/@getpaseo/server/dist/server/server/agent/providers/codex-app-server-agent.js`:
- Line 5767 builds the args `[...launchPrefix.args, "app-server"]`.
- Lines 343-370 resolve `codex` from PATH.
- Lines 54-58 send the client info `codex_app_server_daemon`.

Paseo drives Claude through the Agent SDK's `query` (`providers/claude/query.js:1`), in stream-json mode, which is non-interactive.

**Computer Use status:**
- OpenAI's docs place Computer Use in the ChatGPT desktop app (Work mode) and Codex, on macOS and Windows. Setup is through Plugins > Computer Use, and macOS needs the Screen Recording and Accessibility permissions. It cannot automate terminals, cannot approve security or privacy prompts, and use on a locked Mac is opt-in ([learn.chatgpt.com/docs/computer-use](https://learn.chatgpt.com/docs/computer-use.md)).
- The docs do not say whether the CLI or app-server is supported. A third-party inspection found the bundled `unified-computer-use` plugin registers an MCP server called `cua_repl` in `~/.codex/plugins/cache`. That server is started by `codex app-server`, and `codex mcp list` showed it, because the CLI and the app share `~/.codex` ([codenote.net](https://codenote.net/en/posts/codex-computer-use-cua-repl-vs-trycua-cua-driver/)). Mirrored GitHub issues report the plugin showing as "unavailable" on some installs ([upd.dev #18404](https://upd.dev/openai/codex/issues/18404), [#29372](https://upd.dev/openai/codex/issues/29372)).
- **Local evidence that it works through Paseo.** The PR #281 session log has 6 `[cua_repl.js]` calls, such as `cua.getApp("com.electron.lark")`, `getAXStateAndScreenshot()` and `pressKey("super+k")`, plus a screenshot attachment. In #257, Codex reported a modal dialog "来自 CUA 实际观察" (seen directly through CUA) at 14:51. What the owner experiences as "not easy to use" is therefore probably reliability, permissions or approvals rather than a missing feature. The exact cause is unknown, since the Mac's settings were not inspected.

**Ways to accept real desktop behavior on the Mac:**

| Option | What it covers | Limits | Evidence |
|---|---|---|---|
| Playwright `_electron.launch` | The renderer: DOM, screenshots, video, and main-process `evaluate`. Fully scriptable and repeatable. | Experimental API. It does not capture native menus, tray or window frames. In #257, a call to `app.process()` failed after a native quit. | Already used in #257 (comment 18:35: "drove the actual … bundle using Playwright _electron.launch"; 17:03 records the failure). The 31.92 s video "不包含原生菜单或窗口边框" (excludes native menus and window frames). [Electron testing docs](https://electronjs.org/fr/docs/latest/tutorial/automated-testing) |
| `screencapture` | Native window, tray and full-screen stills. | Needs Screen Recording for the calling process. Whether that is granted on the Mac is unknown. | No local evidence either way. |
| `osascript` / System Events | Clicking tray and menu-bar items, Cmd-Q, native dialogs. Text assertions through the accessibility tree. | Needs Accessibility. It is brittle to UI labels. | No local evidence either way. |
| Codex `cua_repl` (computer use) | The Feishu desktop client rendering cards, and anything visual. | Per-app approvals, capacity errors, no security prompts. Locked-screen use is opt-in. | PR #281 session log, lines 673–708. |
| Claude Code computer use on the Mac | Same scope as above. | macOS only, Pro or Max plan, **interactive session only**, approved per app in the terminal ([code.claude.com/docs/en/computer-use](https://code.claude.com/docs/en/computer-use.md)). Paseo's SDK `query` path is non-interactive, so it is probably unreachable through Paseo (my inference). It would also break the rule against Claude inference on the Mac (vonvon-collaboration.md, Claude 会话 section). | Docs only. |
| A demo build handed to the owner | The real goal: feedback on product shape and fit. | Needs the owner's time. | Codex already builds a Developer ID-signed `package:dir` app and verifies it with `codesign --verify --deep --strict` (#257 comment 15:12). |

**Recommendation for desktop acceptance:**
- Keep Playwright `_electron` as the default automated driver.
- Add `osascript` and `screencapture` scripts for the tray, menus and quit, which Playwright misses.
- Use `cua_repl` only where a visual check of the Feishu client is the point.
- Most importantly, hand the owner a signed preview build plus the 60-second video at each version boundary. The owner's complaint is that nothing reaches them to try, and no automation fixes that.

---

## Process changes the evidence supports (judgment)

1. **Ship a preview from what is already on `main`, then hold a product-shape review before V5b (parts 6–15) and V6b.** Each remaining hardening gate then has to earn its place against real owner feedback.
2. **Add a "preview" verification tier.** It would cover build, targeted tests, the Mac full suite once per batch, and one demo. Gate L, Gate M, the perf ±15% gate, the CLI evidence bundle and the 12-step native acceptance would move to a release tier.
3. **Change the WIP cap for pieces of an already-reviewed split, such as #110's 15 pieces.** Either review consecutive pieces as one batch, or allow more than 2 open when they share a design. The 7.7 h mean queue wait is the largest measured loss.
4. **Run the Windows job before handoff.** A Windows-only CI job on push would catch the 16 of 20 full-run failures that involved Windows before Codex freezes. The Alibaba cloud PC could serve as a Windows runner if it runs Windows, which is unknown.
5. **Recover Mac sessions after capacity errors.** Auto-resume, or fall back to Astra, when a session hits "model at capacity", and stop extra rounds after a PASS (#281).
6. **Trim pstack where the plan already fixes the design shape.** Skip the architect arena when plan.md already gives the types, as it does for `RestartHelper` at plan.md:1080. Consider 2-model panels in `pstack-models.md`. This is a smaller win than items 1–5.

**Unknowns:**
- Whether Screen Recording and Accessibility are granted to codex or node on the Mac.
- Why computer use feels unreliable to the owner.
- The Alibaba cloud PC's OS.
- How long the Mac full test suite takes per round.
- How much quota the 4-model panels use.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report's measurements mostly hold: the merge counts and timings, the slot-wait arithmetic, the CI failure breakdown, owner-label time, the strict-base ruleset, Paseo's app-server path, cua_repl use and the Claude computer-use limits. The biggest errors are in how it explains causes. (1) The 7.7 h V5 queue comes from the serial open-and-merge rule set in the 10-13 06:02Z decision on #110, not the two-PR cap. (2) The rounds after #281's PASS are the live acceptance that the PASS explicitly left to the root owner, not wasted extra rounds. (3) The #281 session was resumed three times, and since 05:50Z both in-flight PRs have been paused by the owner on purpose. (4) The merge-main commit count is 24, not 16. (5) Windows CI can already run before handoff through workflow_dispatch; only the AGENTS.md:28 policy prevents it. The report also misses three facts that matter for strategy: a runnable desktop build existed on #110 on 10-12, there are no releases or tags at all, and CUA has auto-launched apps against the owner's real data root. Its direction (ship a preview from main, add a preview tier, batch the split pieces, run Windows earlier) is supported, and the pause comments show the preview from main is already under way, with a known holder-packaging blocker if #281 lands first.


### 逐条复查

- **属实**：23 product PRs merged in 25.4 h (10-13 03:18Z to 10-14 04:43Z), open to merge mean 97 min, median 71, max 339 (#257).
  - 依据：`gh pr list --state merged` since 10-13, excluding docs-only #235, #238 and #239, gives 23 PRs. First opened #237 at 03:18:12Z, last merged #284 at 04:43:21Z. Computed n=23, mean 97.4 min, median 71.1 (#259), max 338.8 (#257). #240 and #277 are handoff-tooling PRs. AGENTS.md:22 counts them as product PRs, since only dependabot and docs-only PRs are exempt.
- **说过头了**：V5 pieces 7–12 waited a mean of 7.7 h for one of the two in-flight PR slots (cap of 2 plus a serial chain). Changing the WIP cap would recover this.
  - 依据：The numbers check out. `gh api pulls/<n>/commits` gives author dates of 14:19, 15:51, 16:04, 16:47, 16:51 and 16:57 on 10-13 against opens at 20:44, 21:09, 23:50, 00:16, 01:07 and 03:55, a mean of 7.7 h. Committer dates sit minutes before each open, so the branches were rebased just before pushing. Each piece opened 4–8 min after the previous V5 piece merged: #268 merged 20:40 and #270 opened 20:44; #270 21:04 → #271 21:09; #271 23:44 → #274 23:50; #274 00:11 → #275 00:16; #275 01:02 → #276 01:07; #276 03:47 → #285 03:55. The binding rule is the split decision on #110 (comments 10-13 06:02Z and 06:18Z): "各块从 main 开出，串行地开、串行地合" (each piece opens from main; open serially, merge serially). The two-slot cap is not the binding rule.
- **属实**：The V5 code was already written on 10-11 in #110 (17,177 lines), the split source.
  - 依据：`gh pr view 110`: OPEN, created 2026-10-11T18:14:18Z, +17177/−2281, owner:claude, branch codex/v5-desktop. Its commits run 10-10 to 10-12T23:57Z. #251 comment 1 says the piece's "代码与 #110 一致" (code is identical to #110). A 10-12 13:18Z comment on #110 records 127 shell tests, 555 service tests passed with 7 skipped, and a "真实冷启动窗口与包smoke" (real cold-start window and package smoke). A runnable desktop build therefore existed on that branch on 10-12. The report does not draw this out.
- **说过头了**：The plan has 601 unchecked boxes and 0 checked.
  - 依据：`grep -c '- \[ \]' docs/plan.md` = 601 and `grep -c '\[x\]'` = 0. The count is right, but it does not measure progress. V1–V4 are merged (#22, #24, #34, #69), yet their boxes are unchecked too. AGENTS.md:26 says progress is tracked only on issue #122 and in PR state.
- **说过头了**：Summed label time: owner:codex 34.9 h, owner:claude 2.4 h, so Codex verification is the loop's main cost.
  - 依据：My recomputation from `issues/<n>/events` for the 23 PRs gives owner:codex 35.0 h and owner:claude 2.4 h, so the totals hold. Label time is not active verification time, though. It includes CI queueing, re-freezes after strict-base merges, and capacity stalls (#281 sat in Codex-labeled time with status error). It also leaves out all of Claude's implementation time before each PR opens.
- **说过头了**：There were 49 full CI runs of 5 min or more: 28 passed and 20 failed. 15 failures were Windows only, 4 macOS only and 1 both. Windows defects surface only after handoff because AGENTS.md:28 allows full CI only on the frozen head.
  - 依据：`gh run list` since 10-13 03:00, runs of 5 min or more: 28 success, 20 failure, 1 cancelled, mean 16.2 min (the report says 16.7). `gh run view --json jobs` on the 20 failures gives 15 Windows-only, 4 macOS-only and 1 both. #285's failing runs 38509583067 and 38512080737 are both Windows. The tooling, however, already allows earlier runs: ci.yml:7 has `workflow_dispatch`, and ci.yml:81 says "Add the frozen label at the final head or dispatch a full run". Codex already dispatched 10 runs on `codex/pr251-windows-diagnostics-20261013` and `codex/pr255-windows-diagnostics-20261013`.
- **说过头了**：Strict base: ruleset 24838891 sets strict_required_status_checks_policy true on `linux`. There are 16 "Merge … origin/main" commits across 15 PRs, and #122 records #244 being blocked by the strict-base rule.
  - 依据：The ruleset is confirmed: `gh api rulesets/24838891` returns {required_status_checks:[{context:linux}], strict_required_status_checks_policy:true}. #122 body line 18 contains "因 #246 推进 main 被 strict base 门拦下" (blocked by the strict-base rule after #246 advanced main). Counting unique SHAs whose message starts with `Merge.*origin/main` across the PRs' commits gives 24, spread over 15 PRs (#237, 240, 244, 248, 249, 251, 255, 257, 262, 266, 271, 272, 275, 276, 281). Stacked branches such as #266 and #272 share some of them.
- **说过头了**：#281's Mac session e6206e4 is in `error` with 8 "model at capacity" lines, last updated 03:41:27Z, after PASS+NOTES at 03:01:16Z. That was a stall of at least 1 h 51 min with nobody restarting the session.
  - 依据：Confirmed: `paseo inspect e6206e4` showed Status error and UpdatedAt 03:41:27Z. The log (709 lines) has 8 capacity lines (468, 470, 474, 480, 652, 663, 675, 709). It is wrong that nobody restarted it: the log shows three in-session resume prompts, "[User] 上一轮因模型容量不足中断。请先检查…从中断处继续" (the last turn was cut off by model capacity; check what is running and continue from there), and work resumed after each. The Mac schedule 11a57858 "vonvon-bot 每20分钟续接 idle 会话" (resume idle sessions every 20 min) exists, but its prompt skips sessions in `error` and it was paused at 04:48:10Z (`paseo schedule inspect`). At 05:50:17Z both #281 and #285 received "## 暂停冻结和合入" (pause freezing and merging) because "产品负责人正在重新对齐产品形态和开发策略" (the product owner is realigning the product shape and strategy). A later `paseo ls --global` shows e6206e4 as `running`.
- **有误**：#281 verification continued after the PASS: the same session started "round3" live checks.
  - 依据：The 03:01:16Z verdict says: "Real configured Codex and Feishu operation, full macOS and Windows CI, frozen-head checks, and final Shipping acceptance remain with the root owner. This verdict applies only to the recorded head and base." The round3 work (Lane 13 live, stop and continue, multi-bot ledgers, the cua_repl check of the Feishu card) is that remaining required acceptance, not extra rounds after a finished acceptance.
- **属实**：Paseo drives Codex through `codex app-server`, not `codex exec` (codex-app-server-agent.js:5767, 54-58, 343-370), and drives Claude through the Agent SDK `query` (providers/claude/query.js:1).
  - 依据：In ~/.local/share/paseo-runtime/0.11.1/.../codex-app-server-agent.js, line 5767 is `const args = [...launchPrefix.args, "app-server"]`, lines 54-58 set client info `codex_app_server_daemon`, and lines 343-370 resolve `codex` from PATH. The first line of claude/query.js is `import { query } from "@anthropic-ai/claude-agent-sdk"`. Caveat: this is the JP-VPS install. The Mac daemon's version was not checked, although the Mac session's provider shows as `codex/gpt-6.1-sol`.
- **说过头了**：Computer use already works through Paseo on the Mac: #281 made 6 cua_repl calls with a screenshot, and #257 recorded a modal seen "来自 CUA 实际观察" (observed directly through CUA). The owner's difficulty is probably reliability, permissions or approvals.
  - 依据：The calls are confirmed: e62.log lines 673, 674, 704, 705, 706 and 708 are `[cua_repl.js]`, with a screenshot attachment after 706. #257 comment line 101 contains "模态提示来自 CUA 实际观察" (the modal was observed directly through CUA). The report leaves out that CUA broke test isolation in #257. Line 113: "CUA getApp 在隔离应用无窗口时自动启动了额外的 packaged app，未带测试环境，触及既有默认数据根 `~/.vonvon-bot`" (when the isolated app had no window, getApp launched an extra packaged app without the test environment, which touched the owner's real default data root). Line 401: "CUA 在已退出应用上刷新曾三次意外启动默认根" (refreshing an exited app accidentally started the default data root three times). In #281 the cua calls sit next to capacity errors (675, 709).
- **属实**：Claude Code computer use is macOS only, needs a Pro or Max plan, works only in an interactive session, and is probably unreachable through Paseo.
  - 依据：code.claude.com/docs/en/computer-use.md: "It requires an interactive session, so it is not available in non-interactive mode with the `-p` flag". The CLI is macOS only. The report misses that the same page lists the Desktop app as supporting "macOS and Windows", with "Dispatch-spawned sessions can use computer use". It also says browser work goes to Claude in Chrome when that is set up.
- **unsupported**：pstack's Claude-side cost is roughly 10–30 min wall time per PR. Measured: session 7dd413cc had 17 subagents and 146 min with one arena (opus 15.5, sonnet 11.1, haiku 8.2, judge 2.8); session dad7f6a1 had 15 subagents, 123 min and an interrogate panel (opus 6.1, sonnet 2.3, haiku 4.5, fable 6.3).
  - 依据：My recomputation from the subagents/*.jsonl timestamps matches: 7dd413cc has 17 subagents and 145 min, with the arena at 03:31 (opus 15.5, sonnet 11.0, haiku 8.2) and a sonnet judge at 03:46 for 2.8 min. dad7f6a1 has 15 subagents and 123 min, with interrogate at 01:37 matching the report. The arena had no fable runner, although `architect runners` in pstack-models.md lists four models. Two sessions spanning about 26 h of many PRs cannot support a per-PR range. Implementation subagents alone ran 29.8 and 34.6 min. The lead session's own pstack steps (how, deslop, no-comments, technical-writing, unslop) were not measured.
- **属实**：In the planning phase (10-10 to 10-12), 17 of 27 merged PRs were docs-only, and #117 (7,485 lines) was closed unmerged.
  - 依据：Classifying `gh pr list --state merged` files for 10-10..10-12 gives 17 DOCS and 10 CODE. Of the 10 CODE PRs, only #22, #24, #34 and #69 are product code; the rest are CI or program tooling. #117 was +7485/−383 and CLOSED, but at 2026-10-14T00:40:03Z, not during 10-10 to 10-12. docs/native-acceptance-hosts.md is 685 lines (`wc -l`).

### 正文遗漏的事实

- Things changed at 05:50Z. #281 and #285 both received "## 暂停冻结和合入" (pause freezing and merging): "产品负责人正在重新对齐产品形态和开发策略" (the product owner is realigning the product shape and strategy). The #281 comment says the preview for the owner is to be built from main `be17859`. The #285 comment pauses V5 pieces 12–15 (the background service) pending the new strategy. The report's top recommendation is therefore already under way.
- The #281 pause comment names a ship-blocking gap. After #281 merges, POSIX Codex turns would fail because `vonvon-holder` is missing. `npm run build` does not compile it, tsup's `clean: true` deletes it from dist, the stage-daemon, pack-vonvon-bot and electron-builder scripts omit it, and `ProcessHost.available()` is never called. This supports previewing from main before V6b and not after.
- A tryable desktop build existed on 10-12 on #110's branch `codex/v5-desktop`. The comment there (10-12 13:18Z) lists a real cold-start window and package smoke. The 10-13 06:02Z decision then turned #110 into a split source with a serial open-and-merge rule. That decision, not the WIP cap, created the 7.7 h queue.
- There are no GitHub releases and no git tags: `gh release list` and `git tag` both return nothing. Nothing has ever been handed to the owner as a versioned artifact.
- ci.yml already supports full three-platform runs through workflow_dispatch (ci.yml:7, 81), and Codex has used it for Windows diagnostics (10 dispatched runs on codex/pr251-* and codex/pr255-* branches). Moving Windows CI before handoff only needs a change to the AGENTS.md:28 policy.
- Mac schedule 11a57858, "vonvon-bot 每20分钟续接 idle 会话" (resume idle sessions every 20 min), already exists. By its own prompt it skips `error` sessions, and it was paused at 04:48:10Z. The capacity-error recovery the report proposes needs this schedule changed, not something built from scratch. The source of the three in-session resume prompts in the #281 log is unknown.
- In #257, CUA auto-launched an extra packaged app against the owner's real data root `~/.vonvon-bot` three times (#257 comments, lines 113 and 401). Isolating computer use from the owner's own data is a precondition for using it in acceptance.
- #257 also exercised native-menu Quit in a real drain (comment line 391), and Playwright `app.process()` then failed. So native menus were tested in some form; the report's table says there is no local evidence for native UI automation.
- Claude Desktop on macOS and Windows supports computer use, including in Dispatch-spawned sessions (code.claude.com computer-use docs, Differences table). That is a possible route for desktop acceptance, but it conflicts with the user's current no-Claude-inference-on-Mac rule (vonvon-collaboration.md, Claude 会话 section).
- Mac full-suite size: #122 body line 18 records "Mac 串行全量 2215 passed、28 skipped" (serial full suite on the Mac: 2215 passed, 28 skipped). How long a round takes is still unknown.
- JP-VPS `paseo ls --global` lists two non-PR Claude sessions, 8f56569 (V5 native-acceptance port contract) and 9f35435 (V5 perf collection plan), as `running` since 2 days ago, alongside three PR sessions. That may conflict with the two-session rule and the 3.9 GB RAM on JP-VPS. Whether they are actually running or the status is stale was not verified.
- The user's other resources are not assessed. The Tencent Cloud server is not mentioned at all, though it could serve as the Linux systemd/user-session acceptance host the plan requires (plan.md:2115) or as a second build host. JP-VPS also already runs Pi/DeepSeek agents for scheduled chores (schedules e2846e55 and d26007b3).
