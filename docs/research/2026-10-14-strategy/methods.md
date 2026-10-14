# Running agent-driven development so the owner sees working software early: research and an operating model for Vonvon Bot

## Bottom line

- **There has been a working path through the product since 2026-10-10. It never reached the owner.** V2 copied the bridge runtime, and its live lanes go from a Feishu message in a DM, to binding a group, to an @mention, to a Codex run card (/home/operator/vonvon/vonvon-bot/docs/plan.md:332-341). V4 put the web UI on top of it and recorded a 51-second video of it connected (PR #69, the web UI PR, body line 22). After that, the process was set up to keep the owner out ("personal review is optional", repeated in every version section). No build was ever released for him to install.
- **The agent pipeline is fast but pointed at the wrong target.** The 26 PRs opened since 2026-10-13 went from open to merged in a median of 53 minutes. Almost all of them are horizontal layers: V5 service transactions 1-12 of 15, and the V6a provider core whose engines nothing uses until V6b, which has 14 parts. So handoff latency is not the main problem. Missing user focus is. DORA's 2025 research describes this exact case: teams "may just be moving quickly in the wrong direction".
- **The fix is to change what counts as a unit of work, not to add more process.** A unit becomes a thin vertical slice the owner can try in Feishu or on his Mac. Each one ships as a demo build every 1-2 days. The owner looks at a clickable prototype before any code is written. Hardening is triggered by real use instead of being scheduled up front.

---

## 1. Principles from the research

| # | Principle | What the sources say |
|---|---|---|
| P1 | **Build one thin end-to-end path first, then grow it.** | Cockburn's walking skeleton is "a tiny implementation of the system that performs a small end-to-end function… It need not use the final architecture, but it should link together the main architectural components" ([quoted at mattblodgett.com, 2020](https://www.mattblodgett.com/2020/09/start-with-walking-skeleton.html)). Shape Up's *Get One Piece Done* says to integrate one slice across front end and back end, get "something to click on" early, and "start in the middle" ([Basecamp, ch. 11](https://basecamp.com/shapeup/3.2-chapter-11)). For agents specifically, AI Hero (updated 2026-01-22) warns that agents build "entire layers in isolation, without ever testing whether the critical path actually works", which it calls "outrunning your headlights" ([aihero.dev/tracer-bullets](https://www.aihero.dev/tracer-bullets)). |
| P2 | **Verification means running the real product the way a user does.** | Claude Code docs: "Give Claude a check it can run: tests, a build, a screenshot to compare". A good spec ends "with an end-to-end verification step that proves the feature works". Then "Run `/verify` yourself… to confirm the change against the running app" ([code.claude.com best practices](https://code.claude.com/docs/en/best-practices), accessed 2026-10-14). Anthropic, 2025-11-26: keep a list of end-to-end features that all start as failing, work on one feature per session, and test as a human user would with browser automation. Without that instruction, Claude marked features done after only unit tests or curl checks ([Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). Paseo's QA bar: "Tests are evidence only when they exercise the real thing" (/home/operator/vonvon/references/paseo-0009/docs/qa.md:3, :75-84). |
| P3 | **The human steers by using the product.** | OpenAI, 2026-02-11 (Ryan Lopopolo): "Humans steer. Agents execute." Humans turn user feedback into acceptance criteria and check outcomes ([Harness engineering](https://openai.com/index/harness-engineering/); read through a proxy because openai.com returned 403). Simon Willison, 2025-10-07: "you need to be really good at manually testing software", plus "a way to safely preview that feature (without deploying it straight to production)" ([Vibe engineering](https://simonwillison.net/2025/Oct/7/vibe-engineering/)). Peter Steinberger, 2025-12-28: "I need to play with it, touch it, feel it, see it, that's how I evolve it", and "start with the model and a CLI first" ([Shipping at inference speed](https://steipete.me/posts/2025/shipping-at-inference-speed)). Kent Beck "watched the intermediate results of the genie more carefully, ready to intervene" ([Augmented Coding: Beyond the Vibes, 2025](https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes)). |
| P4 | **Prototype before writing production code.** | Boris Cherny built about 20 prototypes of Claude Code's todo list in about two days: "Building and testing 5-10 prototype ideas in a day is possible with AI agents" ([Pragmatic Engineer, 2025-09-23](https://newsletter.pragmaticengineer.com/p/how-claude-code-is-built)). Shape Up puts basic controls before polish (ch. 11 above). Product managers now commonly prototype with AI ([Lenny's Newsletter, 2025-01-07](https://www.lennysnewsletter.com/p/a-guide-to-ai-prototyping-for-product); paywalled, only the summary was visible). |
| P5 | **Fix the time and let the scope vary. Do one item at a time.** | Shape Up: an appetite is "The amount of time we want to spend on a project, as opposed to an estimate", and "When you have a deadline, all of a sudden you have to make decisions" ([ch. 3](https://basecamp.com/shapeup/1.2-chapter-03)). Geoffrey Huntley (2025-07-14): "ask Ralph to do one thing per loop", and he regularly throws the plan away and regenerates it ([ghuntley.com/ralph](https://ghuntley.com/ralph/)). Codex docs list "Using one chat for an entire project instead of one chat per coherent outcome" as a mistake ([learn.chatgpt.com best practices](https://learn.chatgpt.com/guides/best-practices), undated). |
| P6 | **Work in small batches, and keep the user at the center.** | DORA's AI Capabilities Model (2025-09-24) includes both "working in small batches" and "user-centric focus". Without the second, teams "may just be moving quickly in the wrong direction" ([Google Cloud blog](https://cloud.google.com/blog/products/ai-machine-learning/introducing-doras-inaugural-ai-capabilities-model)). "AI's primary role is as an amplifier, magnifying an organization's existing strengths and weaknesses" ([DORA 2025](https://dora.dev/research/2025/dora-report/)). |
| P7 | **Keep merge gates light, release often, and hide unfinished work behind flags.** | OpenAI: "minimal blocking merge gates… corrections are cheap, and waiting is expensive" (harness post). Release toggles "allow incomplete and un-tested codepaths to be shipped to production as latent code" ([Hodgson, martinfowler.com, 2017](https://martinfowler.com/articles/feature-toggles.html)). Feature branches are "short-lived" ([trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/)). Claude Code ships "~60-100 internal releases/day" (Pragmatic Engineer). |
| P8 | **Keep agent instructions short and docs alive.** | "Bloated CLAUDE.md files cause Claude to ignore your actual instructions!" (Claude Code docs). OpenAI's AGENTS.md is "roughly 100 lines" and serves as "the table of contents", not an encyclopedia. "A short, accurate AGENTS.md is more useful than a long file full of vague rules" (Codex docs). Birgitta Böckeler, 2025-10-15: "I'd rather review code than all these markdown files", and "the best way… to stay in control… are small, iterative steps" ([martinfowler.com](https://www.martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)). Paseo's doc rules: "Integrate, don't append", "Don't document logic", one fact in one doc (/home/operator/vonvon/references/paseo-0009/CLAUDE.md:67-80). |
| P9 | **Don't trust activity metrics or scope that reviewers invent.** | METR, 2025-07-10: developers expected AI to speed them up by 24%, actually took 19% longer, and afterwards still believed they had been 20% faster ([metr.org](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/); METR says these results are dated and published an update in Feb 2026, which I did not read). Claude Code docs: "Chasing every finding leads to over-engineering: extra abstraction layers, defensive code, and tests for cases that can't happen." Beck's warning sign: functionality he hadn't asked for, "even if it was a reasonable next step". |
| P10 | **Dogfood: the builders use the product themselves.** | Claude Code went from about 20% to 50% of Anthropic engineering using it within 5 days of the first prototype (Pragmatic Engineer). Happy was "born from the frustration" of its builders ([github.com/slopus/happy](https://github.com/slopus/happy) README, seen through search). Hashimoto (2026-02-05): split work into clear tasks, give agents ways to check their work, and run agents only when they add value ([mitchellh.com](https://mitchellh.com/writing/my-ai-adoption-journey)). |

The minimum viable product, for reference: "that version of a new product which allows a team to collect the maximum amount of validated learning about customers with the least effort" ([Ries, 2009-08-03](http://www.startuplessonslearned.com/2009/08/minimum-viable-product-guide.html)).

---

## 2. Anti-patterns in this repo, with evidence

**A1. The owner is designed out of the loop (violates P3, P10).**
- Every version section ends with "Codex proceeds after the independent exact-head Shipping verdict; personal review is optional" (/home/operator/vonvon/vonvon-bot/docs/plan.md:779, :878, :1278, :1357 … :2031). Line :46 says to proceed "without waiting for personal review", and lines :292 and :350 say "no personal UI review is prescribed".
- The same rule appears in /home/operator/vonvon/vonvon-bot/docs/roadmap.md:79 and /home/operator/vonvon/vonvon-bot/AGENTS.md:37 ("不在版本边界等用户确认", do not wait for user confirmation at version boundaries).
- The only work assigned to the owner is logistics. #206 asks him to log in the `<Mac 测试用户>` test user, #207 to provide Cursor and Grok accounts, #208 to decide on a Windows host, #209 to pick a cloud platform. He is never asked to judge the product.
- Evidence such as the V4 video went to `.audit/…` folders and `~/vonvon-review/` (PR #69 body line 22), not to the owner.

**A2. The product shape is never written down (violates P6).**
- The section headings of /home/operator/vonvon/vonvon-bot/docs/architecture.md (lines 5-309) are all technical decisions: the daemon as single writer, the protocol, the data directory, and so on.
- Searching the docs finds no first user, no MVP and no success metric.
- The program's end condition is technical: "The program ends when V11 is verified" (/home/operator/vonvon/vonvon-bot/docs/plan.md:30).
- By contrast, Paseo opens its docs with a product page that says who it is for and what the core workflow is (/home/operator/vonvon/references/paseo-0009/docs/product.md:1-15).

**A3. Nothing has been released in 5 days (violates P7).**
- `gh release list` is empty, and `npm view vonvon-bot` and `npm view @vonvon/daemon` both return 404.
- The first installable artifact is planned as V5's signed installer (/home/operator/vonvon/vonvon-bot/docs/plan.md:123, :145, :185).
- The owner's own bridge did the opposite. It published 0.1.0 to npm on its first day (2026-05-29, /home/operator/vonvon/feishu-codex-bridge git log), shipped 49 release commits up to 0.6.14 on 2026-09-24, and had 1,106 npm downloads in the 30 days to 2026-10-12 (npm downloads API). Downloads are not the same as active users.
- Paseo, the architecture being copied, shipped 128 releases between 0.1.1 on 2026-02-11 and 0.11.1 on 2026-10-07 (/home/operator/vonvon/references/paseo-0009/CHANGELOG.md).

**A4. After the skeleton, work turned into horizontal layers (violates P1, P5).**
- V4 merged at 2026-10-11 01:58. The next product PR, #237, merged at 2026-10-13 04:18. In those 50 hours, 14 PRs merged and all were docs or CI (#79 through #235). They include the provider redesign (+1,677 lines) and the merge graph (+1,957 lines).
- Since then the work has been layers: V6a parts 1/6 through 6d (#237 to #272), whose engines first get a consumer in V6b. V6b has 14 parts, and part 1 (#281) is still open. V5 has parts 1 through 12 of 15 (#246 to #285).
- The features users would actually notice sit at the far end of the merge chains: the run card (V6c), Cursor and Grok (V7a), and remote access (V10, V11) (/home/operator/vonvon/vonvon-bot/docs/roadmap.md:28-34).
- Of the 53 merged PRs, 28 are docs, CI or process. About 5 changed something a user could touch: #24, #34, #69, #248 and #257.

**A5. Edge cases get acceptance proofs before anyone has used the product (violates P9).**
- **Gate L and Gate M.** These cover a Linux helper that must be proven alive during a managed core update under systemd. They exist because "The second independent review proved two paths unsafe" (/home/operator/vonvon/vonvon-bot/docs/plan.md:1063-1065, :2113). That is a reviewer finding about a path no user runs yet.
- **Updater checks before any release exists.** The updater acceptance lane serves a local HTTPS manifest with a certificate trusted in the login keychain (PR #257 body line 55).
- **Very heavy evidence for CLI changes.** A CLI change must produce a byte-for-byte terminal recording, hash manifests, and an independent rerun (/home/operator/vonvon/vonvon-bot/docs/plan.md:57-65).
- **Every PR runs the full swarm**: ten live lanes, a perf lane and at least two audit lanes (/home/operator/vonvon/vonvon-bot/docs/plan.md:23, :209).
- **Paseo, the reference, has none of this.** At commit `0009a7e71` (2026-10-09) it has no launchd, systemctl, `setLoginItemSettings` or `openAtLogin` code at all (grep of /home/operator/vonvon/references/paseo-0009/packages). Its desktop app manages the daemon itself (/home/operator/vonvon/references/paseo-0009/docs/product.md:17-23). V5 has spent 12 or more PRs on OS service registration.

**A6. Docs grow faster than code and drift out of date (violates P8).**
- `docs/` holds 769 KB, about 104,866 words. plan.md alone is 422 KB, 64,569 words and 2,128 lines.
- The work is tracked as 67 tasks in program-graph.json, and the repo has 210 issues, 166 of them open.
- plan.md is out of date. /home/operator/vonvon/vonvon-bot/docs/plan.md:9 still says "Codex owns all code… Claude Code… writes no product code", which contradicts /home/operator/vonvon/vonvon-bot/AGENTS.md:7.
- Agents are told to re-read eight skill files "at every tick" (/home/operator/vonvon/vonvon-bot/docs/plan.md:31-36).

**A7. A working product is being rewritten toward someone else's end state.**
- Bridge 0.6.14 already does Codex and Claude Code with streaming cards (/home/operator/vonvon/feishu-codex-bridge/README.md:11-13). The old desktop app 0.7.0 lives on the PR stack #2 to #19, kept as reference only (/home/operator/vonvon/vonvon-bot/docs/roadmap.md:105-107).
- v2 "照搬 Paseo" (copies Paseo wholesale, /home/operator/vonvon/vonvon-bot/docs/architecture.md:15). Paseo grew into that shape over about 4 months by a single author: the server first appeared 2025-10-22, the relay 2026-01-14, a Tauri desktop app 2026-01-20 (moved to Electron 2026-03-21), the CLI 2026-01-28 and E2EE 2026-02-01 (git history of /home/operator/vonvon/references/paseo-0009).
- v2 is building the destination without following the path that produced it.

**A8. The implementer never sees the product run (violates P2).**
- Claude on JP-VPS runs only build, typecheck, lint and focused tests (/home/operator/vonvon/vonvon-bot/AGENTS.md:7, :28). Anthropic reports this is exactly the setup in which agents declare features done too early.
- Most of the 18 returns on 2026-10-13 were about subprocesses, concurrency or cleanup (/home/operator/.claude/vonvon-collaboration.md:14). Effort is concentrated in the riskiest, least visible area.

**Not the problem: handoff latency.** The median open-to-merge time is 53 minutes, and the longest is 338 minutes (#257). The owner labels and `scripts/handoff.mjs` work. The ceremony is real, though: #276 was frozen 4 times in 2.7 hours because of Windows test timeouts (its PR comments). But the main loss is in what gets handed off, not how fast.

To be fair, some of the hardening was justified. The outbound path gate fixes a real bug (#114), and protecting data during the bridge import matters. The problem is the order of the work and the size of the gates, not that hardening exists.

---

## 3. A proposed operating model

### 3.1 Reset (next 48 hours)

1. Land or park the two PRs in flight (#281 and #285). Start no new V5 or V6b sub-PR until the owner has chosen Bet 1. Nothing gets reverted.
2. **Codex records "Demo 0" from today's main on the Mac**:
   - build, run `vonvon daemon start` and `vonvon open`;
   - connect the real test bot, bind a group, @mention it, and get a run card;
   - record 60 seconds of video;
   - try `package:dir` to produce an unsigned `.app`;
   - list what breaks.
   It should also send the owner the existing V4 video in `~/vonvon-review/`.
3. **Claude interviews the owner for 30 minutes**, using the interview pattern from the Claude Code docs, and writes `docs/product.md`. It should be at most one page in Paseo's style and cover:
   - the first user (the owner himself, then bridge users);
   - the three jobs the product does;
   - what v2 must do better than bridge 0.6.14;
   - what is out of scope for the next two weeks;
   - the appetite.
4. **Claude builds prototypes the same day**:
   - 2-3 clickable HTML pages as private links: desktop first run, group and provider setup, and the machine list if remote access matters to him;
   - Feishu card mockups sent as static cards to a test group through `lark-cli`, so he sees the real rendering on his phone.
   The owner gives about 15 minutes of feedback per round, with 2-3 rounds.
5. The owner picks **Bet 1** with a one-week appetite.

### 3.2 What a slice is

A slice counts as done only when all of these hold:
- It starts and ends at a surface the owner touches: a Feishu message or card, the web UI, the desktop window, or a CLI command he would actually type.
- It goes through the real pieces (real Feishu, real Codex or Claude). Inside, it can be naive, and unfinished parts stay behind a flag (P7).
- It is at most 1-2 days of agent work and about 800 or fewer non-test lines. The existing 1,500-line cap stays.
- It comes with a "try it" script of 3 steps and a video of 60 seconds or less.
- It has one automated end-to-end check of that same path: Playwright on the web UI, or a fixture bot @mention ending in a run card, like V2 lane 4.

### 3.3 Cadence

- **A demo build every 1-2 days**: a GitHub prerelease `v0.8.0-demo.N` with an npm tarball and an unsigned macOS `.app`, plus the try-it steps and video, posted to one pinned issue or Feishu group. A day with no demo build is the warning signal.
- **The owner spends 10-15 minutes a day** trying the build. Claude turns his replies into acceptance criteria (P3).
- **A weekly bet review of 30-45 minutes**: "what can I do now that I couldn't last week?", answered with a video. Cut scope rather than extend time (P5), then pick the next bet.

### 3.4 How the owner reviews

1. Prototype first: reshape before any code exists.
2. Demo build second: does the real thing match the prototype?
3. Daily use third: does he actually use it instead of the bridge?

Only the owner rules on product shape. Codex rules on safety and correctness.

### 3.5 How Claude and Codex split the work

- **Claude**:
  - acts as shaping partner and writes `product.md` and `bets.md`;
  - builds the prototypes;
  - implements each slice end to end, including its E2E test;
  - runs a Linux smoke check: the daemon plus headless Playwright on the web UI, under `flock /tmp/vonvon-heavy.lock` because JP-VPS has 3.9 GB of memory.
- **Codex**:
  - acts as demo engineer and QA: builds the daily demo, runs the try-it steps on the real Mac and in real Feishu, records the video;
  - reviews for correctness blockers on paths users actually run, not hypothetical ones (the reviewer warning under P9);
  - fixes Mac-only issues and merges;
  - owns signing and notarization at the beta stage.
- **Keep**: owner labels, `handoff.mjs`, at most two PRs in flight, no force-push.

### 3.6 Gates by stage

| Stage | Required |
|---|---|
| Slice merge (daily) | Linux CI chain, Codex review with no correctness blocker, the try-it steps passing once on the Mac |
| Demo build | main builds the artifacts, and a smoke run (fixture bot @mention ending in a run card) passes |
| Beta (external bridge users) | Full three-platform CI on a frozen head, signing and notarization, import safety tests, upgrade and crash recovery for the features being shipped |
| GA | Today's live and perf lanes, limited to the features being shipped |

### 3.7 When hardening and cross-platform work happen

A hardening task enters a bet only if one of these is true:
- a failure was seen during dogfooding or beta;
- there is data-loss or security exposure on a path users actually run (#114 qualifies);
- the next audience requires it (signing before an external beta).

Set aside about 20% of capacity or one day a week for this. Platforms come in this order:
- **macOS first.**
- **Linux next, as a CLI daemon only.** Gate L and Gate M wait until Linux service users exist and receive auto-updates.
- **Windows last.** Keep compile and unit tests in CI. Native acceptance waits for a Windows user (#208).

### 3.8 Docs rules

- AGENTS.md stays at about 100 lines or fewer.
- `product.md` and `bets.md` are one page each, and `bets.md` is rewritten weekly.
- `plan.md` is frozen as a historical reference, and its line 9 is fixed or marked as historical.
- The design for a slice lives in its PR description.

### 3.9 Measuring progress

- **An outcome board**, alongside #122 or replacing it. The rows are capabilities in the user's words, for example "I can install it on my Mac with one command" or "my bridge groups still work after import". The columns are: prototype approved → in the demo build → the owner used it on at least 3 days → beta users used it. As Anthropic does, each row can carry a pass/fail E2E check that agents may only flip.
- **Leading metrics**:
  - days since the owner last tried a build: 2 or fewer;
  - demo builds per week: 3 or more;
  - time from feedback to a fix in a demo build: 1 day or less;
  - share of merged product PRs that change something the owner can see: 50% or more during a bet.
- **Lagging metrics**: the owner's streak of daily use instead of the bridge, then the number of bridge users who migrate.
- **Stop reporting** PR counts, sub-PR fractions like "V5 11/15", lines of code and gates passed (P9).

### 3.10 Candidate bets (the owner chooses)

- **A. "Switch myself" (recommended first).**
  1. Install from a prerelease, run it, open the web UI. This probably works already.
  2. A thin version of V8: import his own bridge data, refusing while the bridge is running.
  3. The desktop `.app` with tray, which reuses the pieces from #251, #254 and #257.
  4. Start at login. Whether the app manages the daemon (as in Paseo) or an OS service does is a product decision for the owner.
- **B. A new provider in Feishu.** Cursor or Grok, using the accounts from #207, behind a flag: plain text plus a stop button in a group. Claude does a one-hour spike to compare the existing `AgentBackend` registry (/home/operator/vonvon/vonvon-bot/packages/daemon/src/agent/index.ts:19-22) with the new engine contract, and picks whichever reaches Feishu within 2 days. This is a hypothesis to test, not a verified plan.
- **C. Run card improvements (V6c).** Very visible in Feishu.
- **D. Remote access from the phone (V10, V11).** Prototype first, and build only if the owner wants it.
- **E. Beta hardening for bridge users.** Signing, import and the V9 notice. Starts once Bet A is stable.

### 3.11 Proposed changes to AGENTS.md

- **Replace :37.** Slices follow the current bet. Codex publishes a demo build within 24 hours of a merge and notifies the owner. No new bet starts until the owner picks it.
- **Add a PR rule.** Each product PR states its user-visible change and its try-it steps. A PR with no visible change must cite a trigger from §3.7.
- **Change :28.** Claude's Linux checks include the end-to-end smoke run.

---

## 4. Unknowns

- Whether main still runs live end to end today. The last live evidence is V4's on 2026-10-11.
- Whether the owner has watched the V4 video.
- How many bridge users are active. Downloads are not users.
- Whether JP-VPS has enough memory for the Playwright smoke run.
- Whether Bet B is feasible on the old backend interface.
- DORA's capability list is taken from Google's blog, not the full report.
- The OpenAI post was read through r.jina.ai, and its date comes from search results.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report is mostly right. Most of its factual claims check out against primary sources, and its main point holds up: the agents have been fast but aimed at horizontal layers, and nothing an owner could see has been shipped. The evidence for that is solid. No releases or tags exist, both npm names return 404, 28 of the 53 merged PRs are docs, CI or process, 15 docs or CI PRs merged in the 50 hours after V4, 'personal review is optional' appears 14 times in plan.md, and V2 and V4 were already working end to end on 2026-10-10 and 10-11. Nearly every quote from outside sources is verbatim and correctly dated (DORA, Claude Code docs, Anthropic harnesses, OpenAI harness via proxy, Willison, Böckeler, Huntley, Beck, Hashimoto).

Three corrections matter for the advice:
1. **The owner opted out of review himself.** He authorized it on 2026-10-10 (PR #39, plan.md:11). The process did not shut him out against his will.
2. **Paseo is a weaker example than the report makes it.** Its author dogfooded it for about 4 months before the first release, mostly alone, and Paseo still asks every PR for real-use evidence. What Paseo skips is OS-service gating. Its lesson is "use it yourself, then release often", not "release from day one".
3. **The docs fix targets the wrong file.** AGENTS.md is already 37 lines. The bloat is in plan.md and in the skill files agents are told to re-read every tick.

The numeric errors are minor and do not change the conclusions:
- The median open-to-merge time is 57 minutes, not 53, and about 96 minutes for product PRs alone.
- The 50-hour window held 15 PRs, not 14.
- The bridge has 56 npm versions, not 49 release commits.
- The 1,106 downloads cluster on release days.
- V6a is partly wired into the runtime already.
- The METR slowdown has been superseded by its Feb 2026 update.

One fact strengthens the reset plan: Demo 0 needs no new code. `vonvon open`, `package:dir` and the npm pack and smoke scripts already exist, and nothing in the plan ever schedules publishing them.


### 逐条复查

- **属实**：A working path has existed since 2026-10-10: V2's live lanes go from a Feishu DM, to binding a group, to an @mention, to a Codex run card (plan.md:332-341).
  - 依据：PR #24 (port the V2 bot runtime) merged 2026-10-10T07:58Z. Its body lines 12-14 record Live2 (DM menu), Live3 (bind a new group through the real DM card) and Live4 (group pwd ends in a completion card) as PASS. The lanes are specified at docs/plan.md:333-335. Caveat: this is the bridge runtime ported into the new repo, run against a fixture bot under an isolated VONVON_HOME.
- **说过头了**：V4 recorded a 51-second connected video (PR #69 body line 22), and the evidence went to .audit and ~/vonvon-review/, not to the owner.
  - 依据：PR #69 body line 22 does list a 51.52 s connected MP4 and a 43.8 s inactive MP4, copied to ~/vonvon-review/. But plan.md:876-877 makes ~/vonvon-review/ the named review folder, and it lives on the operator's own Mac (plan.md:9, 'Codex on the operator's Mac'). The video did reach his machine. What is missing is any notification or request that he watch it.
- **说过头了**：The process was set up to keep the owner out: 'personal review is optional' is repeated in every version section, and plan.md:46, :292 and :350 say not to wait for personal review.
  - 依据：The text is accurate: grep finds 14 occurrences (plan.md:779 through :2031), and lines :46, :292 and :350 match. But the owner granted this himself. plan.md:11 says 'The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review or a manual merge click.' PR #39 ('continue validated milestones without per-version confirmation', merged 2026-10-10T12:22Z) and roadmap.md:79 record the same authorization.
- **有误**：The 26 PRs opened since 2026-10-13 went from open to merged in a median of 53 minutes; the longest was 338 minutes (#257).
  - 依据：gh pr list shows 26 merged PRs created on or after 2026-10-13T00:00Z. Their median is 57.0 minutes, the mean of the 13th (#241, 53.9 min) and 14th (#237, 60.0 min). The longest, #257 at 338.8 min, is correct. Excluding the 6 docs and process PRs (#235, #238, #239, #240, #277, #284), the median for the 20 product PRs is about 96 minutes.
- **属实**：Nothing has been released: gh release list is empty, and npm view vonvon-bot and @vonvon/daemon both return 404.
  - 依据：gh release list returns nothing, git tag returns nothing, and both npm view calls return E404 (run 2026-10-14). The root package.json is private:true, and @vonvon/daemon 0.7.0 is private. Grepping docs/plan.md and docs/roadmap.md finds no npm publish step or prerelease anywhere in the plan. The only publication planned is V5's signed installer (plan.md:123, :145).
- **属实**：The bridge published 0.1.0 to npm on its first day (2026-05-29), shipped 49 release commits up to 0.6.14 on 2026-09-24, and had 1,106 npm downloads in the 30 days to 2026-10-12.
  - 依据：The first commit and the 0.1.0 publish are both dated 2026-05-29 (git log; npm time '0.1.0': 2026-05-29T13:30Z). 0.6.14 is dated 2026-09-24T14:12Z. The npm API returns {downloads:1106, start:2026-09-13, end:2026-10-12}. Two details are missing. npm lists 56 published versions, and '49' is a grep count that includes a non-version commit. About 729 of the 1,106 downloads came on 2026-09-20 to 09-24, the 0.6.11-0.6.14 release days, and daily downloads have been about 8-29 since 09-25 (npm range API). Those spikes look like updates or mirror pulls more than new users.
- **说过头了**：Paseo shipped 128 releases between 0.1.1 on 2026-02-11 and 0.11.1 on 2026-10-07; it grew over about 4 months by a single author (server 2025-10-22, relay 2026-01-14, Tauri 2026-01-20, Electron 2026-03-21, CLI 2026-01-28, E2EE 2026-02-01).
  - 依据：The CHANGELOG has 128 '## ' headings, from 0.1.1 (2026-02-11, line 3033) to 0.11.1 (2026-10-07, line 3), and every component date matches git log of references/paseo-0009. Three corrections. Paseo's first commit is 2025-10-13, and its first tag v0.1.1 came about 4 months later, so Paseo also ran for months without a public release while its author dogfooded it. git shortlog shows Mohamed Boudra with 4,914 commits plus about 190 other authors and bots, so it is mostly one author, not only one. From first commit to the Electron move is about 5 months.
- **说过头了**：Paseo has none of the heavy gating: no launchd, systemctl, setLoginItemSettings or openAtLogin code at 0009a7e71, and its desktop app manages the daemon.
  - 依据：Correct for service registration. grep of packages/ finds those strings only in packages/website/e2e/registry.fixture.json, a third-party launchd plugin fixture, and docs/product.md:23 says 'The app manages its local daemon.' But Paseo's QA bar is not light. docs/qa.md:3 says 'QA is the main bottleneck', qa.md:12 says 'Pull requests without evidence get closed', and it asks for screenshots, video and a per-platform 'Tested' table (qa.md:17-55). Also, the quote 'Tests are evidence only when they exercise the real thing' is at qa.md:71, not :3.
- **属实**：plan.md:9 still says Codex owns all code and Claude writes no product code, contradicting AGENTS.md:7.
  - 依据：plan.md:9: 'Codex owns all code... Claude Code on the Linux server normally owns this plan and the design docs, and writes no product code.' AGENTS.md:7 says Claude designs and implements. Missed: plan.md:73 already says 'Claude Code on the Linux host designs and implements', so plan.md contradicts itself. It was half-updated, not simply left stale.
- **说过头了**：In the 50 hours between V4 (2026-10-11 01:58) and #237 (2026-10-13 04:18), 14 PRs merged, all docs or CI (#79 through #235); 28 of 53 merged PRs are docs, CI or process.
  - 依据：Both timestamps are confirmed (UTC), and 28 of 53 is confirmed by title count. But #79 merged at 01:17, before V4. The PRs merged inside the window are #82, #91, #107, #108, #109, #115, #116, #118, #120, #210, #214, #217, #235, #238 and #239: 15 PRs, all docs or CI. #116 is +1,677 and #210 is +1,957, as stated.
- **说过头了**：V6a is a provider core whose engines nothing uses until V6b.
  - 依据：No module outside src/provider/ imports the engine contract or runtime from #241. But other V6a pieces are already live. The outbound policy from #249 is imported by bot/outbound-files.ts:14 and card/outbound-images.ts:6. The JSON-RPC transport from #244 is re-exported by agent/codex-appserver/app-server-client.ts:1-2. ProcessHost runs a boot sweep and admission check in host/bootstrap.ts:22-26, although real agent spawns do not go through it yet.
- **属实**：docs/ holds 769 KB and about 104,866 words; plan.md is 422 KB, 64,569 words and 2,128 lines; 67 tasks; 210 issues, 166 open.
  - 依据：wc on docs/plan.md gives 2128 lines, 64569 words and 422685 bytes. program-graph.json has 67 tasks. gh issue list gives 210 issues, 166 open. The docs/ total is 810,183 bytes (791 KiB) with 104,559 words in .md files, so the first figure is slightly low. The magnitude is right.
- **属实**：#276 was frozen 4 times in 2.7 hours because of Windows test timeouts.
  - 依据：PR #276 comments show freezes at 01:15, 01:53, 02:26 and 03:26 UTC on 2026-10-14. The PR was opened at 01:07 and merged at 03:47, about 2.67 h. The 01:34 comment records the Windows failure as a 5000 ms timeout in web-admin-service.test.ts:155.
- **属实**：DORA 2025-09-24: 'working in small batches' and 'user-centric focus'; without the latter teams 'may just be moving quickly in the wrong direction'; 'AI's primary role is as an amplifier'.
  - 依据：The Google Cloud blog (Storer and DeBellis, 2025-09-24) lists both among its 7 capabilities and says 'when users aren't the focus, AI-assisted development teams may just be moving quickly in the wrong direction.' dora.dev/research/2025/dora-report/ contains the amplifier sentence. The blog post itself does not.
- **属实**：Claude Code best-practices quotes: 'Give Claude a check it can run', spec 'ends with an end-to-end verification step', 'Run /verify yourself', 'Bloated CLAUDE.md files cause Claude to ignore your actual instructions!', 'Chasing every finding leads to over-engineering', and the interview pattern.
  - 依据：All six appear verbatim at https://code.claude.com/docs/en/best-practices (fetched 2026-10-14), including the 'Let Claude interview you' section with its AskUserQuestion prompt.
- **属实**：Anthropic 2025-11-26: features all start as failing, one feature per session, test as a human user would with browser automation; without that, Claude marked features done after only unit tests or curl.
  - 依据：Effective harnesses for long-running agents (2025-11-26): features were 'all initially marked as failing'. The agent was 'asked to work on only one feature at a time', which is close to but not literally 'per session'. It did well 'once explicitly prompted to use browser automation tools and do all testing as a human user would' (Puppeteer MCP). Otherwise it tested 'with unit tests or curl' and failed to recognize that 'the feature didn't work end-to-end'.
- **属实**：OpenAI harness engineering (2026-02-11, Ryan Lopopolo): 'Humans steer. Agents execute.'; AGENTS.md roughly 100 lines as a table of contents; 'minimal blocking merge gates... corrections are cheap, and waiting is expensive'.
  - 依据：openai.com returned 403. All the quotes check out via r.jina.ai, and the post also says humans 'translate user feedback into acceptance criteria'. The date and author appear only in search results, not on the page body as fetched. Missing context: a team of 3 to 7 engineers, about 1M lines and about 1,500 PRs over about 5 months, building an internal beta that had real users. That is a team with user feedback coming in, unlike a solo owner who is absent.
- **说过头了**：METR 2025-07-10: expected +24%, actually 19% slower, still believed 20% faster; METR has a Feb 2026 update (not read).
  - 依据：The 2025 numbers are verbatim on metr.org, and the page now says 'These results are out of date.' The update (metr.org/blog/2026-02-24-uplift-update, 2026-02-24) reports -18% (95% CI -38% to +9%) for returning developers and -4% (CI -15% to +9%) for new developers. In METR's notation a negative number is a speedup. METR calls this 'some evidence for speedup' but 'only very weak evidence', because of selection effects.
- **说过头了**：Pragmatic Engineer 2025-09-23: about 20 prototypes in about two days; '5-10 prototype ideas in a day'; '~60-100 internal releases/day'; usage went from 20% to 50% of engineering within 5 days of the first prototype.
  - 依据：The first three are verbatim. The adoption line is 'On the first day, around 20% of the Engineering team used it, and by day five, 50%', counted from the November 2024 internal dogfooding release, not from the first prototype.
- **说过头了**：Shape Up ch. 11 says get 'something to click on' early and 'start in the middle'; AI Hero calls agents building layers in isolation 'outrunning your headlights'.
  - 依据：Shape Up ch. 11 has the heading 'Start in the middle', but its phrase is 'have something real to click on', not 'something to click on'. AI Hero (updated 2026-01-22, no author shown) attributes 'outrunning your headlights' to The Pragmatic Programmer. The 'entire layers in isolation' sentence is verbatim. The report missed Shape Up's most relevant line: 'integrating vertically on one small piece of the project instead of chipping away at the horizontal layers.'
- **属实**：Willison 2025-10-07, Steinberger 2025-12-28, Böckeler 2025-10-15, Huntley 2025-07-14, Beck, Hashimoto 2026-02-05 quotes.
  - 依据：All quotes are verbatim at their URLs. Steinberger's page shows no explicit date: it links a 2025-12-17 post and calls GPT-5.2 new, so the 2025-12-28 date is unsupported but plausible. Beck's post is dated 2025-06-25. Huntley also writes 'I throw it out often' about his TODO list.

### 正文遗漏的事实

- The owner chose to drop personal review himself on 2026-10-10 (PR #39; plan.md:11; roadmap.md:79). Bringing him back in reverses his own earlier choice, so the proposal should say why that choice cost him and what it saved him.
- The repo's AGENTS.md is already 37 lines (wc -l), so the proposed rule 'AGENTS.md at about 100 lines or fewer' is already met. The bulk is in plan.md (2,128 lines) and in the eight skill files plan.md:31-36 tells agents to re-read 'at every tick'. Paseo's own CLAUDE.md and AGENTS.md are 194 lines each, so Paseo is not an example of a 100-line file.
- Demo 0 can be done with code that already exists: `vonvon open` (packages/daemon/src/cli/index.ts:47), `package:dir` (packages/desktop/package.json:12), and scripts/pack-vonvon-bot.mjs plus scripts/smoke-vonvon-bot-package.mjs (from #248). No plan document contains an npm publish step at all, which explains why nothing has been published better than slowness does.
- Paseo had about 4 months (2025-10-13 to 2026-02-11) of use by its own author before its first tag. That supports dogfooding (P10) over 'release on day one'. Its fast cadence came after it was already being used daily.
- Of the 1,106 bridge downloads, about 729 fell on the 2026-09-20 to 09-24 release days, and the steady state since is about 8-29 a day (npm range API). That points to a small active user base, perhaps a few dozen, which matters when sizing a beta audience for Bet E.
- The METR Feb 2026 update (2026-02-24) points toward a small speedup with wide intervals. Citing only the 2025 slowdown makes the case look stronger than it is.
- Shape Up ch. 11's line 'integrating vertically on one small piece of the project instead of chipping away at the horizontal layers' describes A4 directly and is stronger evidence than the paraphrases used.
- OpenAI's harness team had internal users giving feedback, and so did Claude Code (Anthropic engineers). Both examples depend on a user being present, which is exactly what Vonvon lacks. The report could say so to support P3.
- Some V6a work is already live on the runtime path: the outbound path gate (#249, an actual security fix) and the JSON-RPC transport. The 'layers nobody uses' count should exclude them.
- There is no evidence either way on whether the owner has opened ~/vonvon-review/ on his Mac. That should be asked, not assumed.
