# Windows and macOS CI in the current development loop: cost, value, and options

## Summary

- **Windows CI is the slowest and least reliable job in each frozen run.** Since Claude took over implementation on 2026-10-13, the Windows job failed in 18 of 51 frozen runs (35%). Linux failed in 11% and macOS in 10%. On a run where everything passes, Windows adds a median of 7.6 minutes.
- **Its failures were mostly noise.** Of the 18 failures, 5 found real Windows defects. 9 were timeouts or file-lock (EBUSY) errors in tests the PR never touched. 3 were problems in test setup code the PR had changed. 1 was a runner glitch with no log. Windows had to pass before merge, so these failures delayed 9 merged PRs by about 8 to 10 hours in total.
- **Money is not the issue.** The Windows minutes in that period cost about $5 nominally.
- **The real problem is a mismatch with the user's assumption.** The user thinks the operating-system layer is already written. It is not. 12 of the 20 product PRs merged since 2026-10-13 were exactly that layer: the background service (launchd, systemd, the Windows startup entry) and the code that runs and cleans up child processes. More of it is still to come: V5 is at piece 12 of 15, V6b was just split into 14 PRs, and V7c (Windows acceptance) waits for a Windows machine.
- **What the evidence suggests.** Turning off Windows CI is only safe if Windows-specific feature work is also put on hold. Otherwise new Windows code gets written and never run.
- **"Windows build and typecheck only" would not help.** It would have caught none of the 46 Windows failures since 2026-10-10. Every one of them happened while running the tests.
- **Running Windows only for PRs that touch Windows-sensitive paths is easy to add and backed by the data.** It needs one more output from `ci-scope.mjs` and one more condition in `ci.yml`.

Data sources: `gh api --paginate "repos/modelzen/vonvon-bot/actions/runs?per_page=100&created=>=2026-10-10"` returned 468 runs, 445 of them CI. Jobs came from `/actions/runs/<id>/jobs?filter=all`, and failing test names from `/actions/jobs/<id>/logs`. 16 logs had expired (BlobNotFound); only one of those was a Windows job. Data was pulled at 2026-10-14 05:10Z. "Since 10-13" means runs created on or after 2026-10-13T00:00Z, about 26 hours.

## 1. What runs, and when

| Event | linux | Windows checks | macOS checks | Source |
|---|---|---|---|---|
| A PR to `main` is opened, updated, reopened or labelled; changes are docs only | Scope check, its own tests, whitespace check (about 0.2 min) | skipped | skipped | `ci.yml:3-7,34-44`; `ci-scope.mjs:10-13,57` |
| Product change, PR not frozen | Same light checks, then **fails on purpose** ("Require frozen head") | skipped | skipped | `ci.yml:78-82` |
| Product change, `frozen` label, or manual run | Full chain: `npm ci`, build, typecheck, test, lint | Same chain on hosted `windows-2025`; needs Linux to pass first; 30 min timeout | Same chain on the self-hosted Mac, only if `ENABLE_SELF_HOSTED_MACOS_CI` is true and the PR is not from a fork | `ci.yml:45-64,84-117,119-166` |
| Any other label added | Lightweight "informational linux" check; never counts as the required `linux` result | informational Windows job, skipped | informational macOS job, skipped | `ci.yml:13,18`; `docs/ci-costs.md:7` |

- **Merge rule as written.** For a product change, Linux, Windows and macOS must all pass at the exact head being merged (`docs/plan.md:212`, `docs/roadmap.md:101`, `AGENTS.md:28-29`).
- **What GitHub actually enforces.** The "Protect main" ruleset requires only `linux` and requires the branch to be up to date with `main` (`gh api repos/modelzen/vonvon-bot/rulesets/<id>` → `required_status_checks:[{"context":"linux"}]`, `strict_required_status_checks_policy:true`). So the Windows requirement is a written policy, not a GitHub setting. Dropping it needs doc edits, not admin changes.
- **Why Windows is slow.**
  - Since #255, Windows CI runs the tests one file at a time (`packages/daemon/vitest.config.ts:11`, `maxWorkers: 1` when win32 and CI).
  - #284 raised the Windows test timeouts to 60 s (`vitest.config.ts:9-10`) and the job timeout from 20 to 30 minutes (commit be17859).
- **Two policy lines that block the easy fixes.**
  - The plan currently forbids path filters and schedules: "The workflow has no path filter, branch-push trigger, or schedule" (`docs/plan.md:220`).
  - `AGENTS.md:29`: there is no Windows machine, so Windows is verified only by the Windows job of the frozen CI run. Behaviour that only happens on Windows must have real-process or real-registry tests that run in that job.

## 2. Actions history

**Full-chain runs (including reruns)**

| Period | Full runs | linux pass / fail | Windows pass / fail / cancelled | Windows fail rate | macOS pass / fail |
|---|---|---|---|---|---|
| 10-10 to 10-12 (Codex implementing; every push ran the full chain until #217) | 56 | 55 / 0 (+1 cancelled) | 15 / 28 / 3 | 61% | 39 / 7 |
| **Since 10-13 (Claude implementing; frozen heads only)** | **57** | **51 / 6** | **32 / 18 / 1** | **35%** | **45 / 5** |

**Job lengths since 10-13** (median for passing jobs)

| Job | Whole job | Test step | Other steps |
|---|---|---|---|
| linux | 4.5 min | 2.9 min | build 0.3, typecheck 0.6 |
| Windows checks | 10.2 min (90th percentile 11.2) | **7.3 min** | npm ci 0.6, build 0.5, typecheck 0.7, lint 0.3 |
| macOS checks | 1.8 min | 0.5 min | — |

- **Wall clock per frozen run.** Across the 28 runs since 10-13 where all three jobs passed, the median from start to finish was 14.8 minutes. Without Windows it would have been 6.5 minutes. Windows finishes a median of **7.6 minutes** after Linux and macOS (90th percentile 10.2).
- **Where Windows failed.** All 46 Windows failures since 10-10 that have a failing step were in the test step. The 46th was the runner glitch with no log. None failed in `npm ci`, build, typecheck or lint.
- **Billable minutes, full-chain runs since 10-10.** Linux 507 and Windows 872, about $11.76 nominal at the rates in `docs/ci-costs.md:29-30`. Since 10-13 alone: Windows 512 minutes, about $5.12.
  - The doc says Windows minutes count double against the free allowance (`docs/ci-costs.md:51`).
  - On that basis, four days used about 2,250 of the 3,000 free minutes a month (`:52`). The actual bill was not checked.
- **What the 57 frozen runs since 10-13 were for**, judged by the newest commit of the head that was tested:

| Head type | Runs |
|---|---|
| Test-only fix commits | 24 |
| Merges from `main` (the branch must be up to date to merge) | 11 |
| First freeze of a PR | 9 |
| Product fixes | 9 |
| Reruns of the same head | 4 |

- **Runs Windows forced.** Up to 17 of the 57 came right after a Windows failure on the same PR.
- **Extra Windows-only workflows.** On 10-13 Codex also ran 10 one-off workflows on side branches: "PR 251 Windows diagnostics/native probe/fixture verification" ×7 and "PR 255 Windows fixture verification" ×3.

**What the 18 Windows failures since 10-13 were**

| Type | Failed jobs | Where |
|---|---|---|
| **Real Windows product or contract defect, in code the PR added** | **5** | #251: a missing Windows startup entry was confused with a failed read, fixed in e056168b. #255: the Windows Job "breakaway" contract was wrong on real Windows; the contract was rewritten in bd43fb6a. #262 ×2: #264, a blocking control pipe, fixed with overlapped I/O in 4d3418ac; #265, missing end-of-output after the child exits, fixed in 05b34361. #266: #269, a ProcessHost launch failure, fixed in 8c0c732a, but its root cause is still unknown (#279) |
| Problem in test setup code the PR had changed | 3 | #272 f54f4fd9; #285 80f41505 and 3950f90a |
| **Flaky test the PR never touched** (timeouts, EBUSY) | **9** | #251 e056168b, #259 39a16525, #266 56cd14d5, #268 8b3d608c, #271 c2092382, #276 ×4 |
| Runner glitch (0 minutes, no log) | 1 | #271 e6c65df3, first attempt |

**Merges delayed by Windows-only failures** (Linux and macOS passed, Windows failed). Delay is measured from the first such failure to the end of the final all-green run.

| PR | Windows-only failed runs | Real Windows defect? | Delay | Who wrote the fixes |
|---|---|---|---|---|
| #251 desktop workspace | 2 | yes | 1.3 h | Codex, 3 commits |
| #255 process identity | 1 | yes | 0.8 h | Codex 2, Claude 1 |
| #259 process holder | 1 | no | 0.4 h | Codex 1 |
| #262 Windows supervisor | 2 | yes ×2 | 1.2 h | Codex 3, Claude 1 |
| #266 ProcessHost | 1, plus 1 Windows+macOS failure | yes (#269) | 0.6 h, plus about 0.7 h for the #269 loop | Claude 1, Codex 1 |
| #268 retire the old Windows service | 1 | no | 0.4 h | Codex 1 |
| #271 launchd | 1, plus the runner glitch | no (a test from #266 that came in with `main`) | about 0.3 h. The raw window is 2.4 h, but most of it was waiting for `main` | Codex 1 |
| #272 HolderProcess | 1 | no | 0.9 h | Codex 2 |
| #276 managed exit codes | 4 | **no; all in tests the PR never touched** | **2.2 h** (Mac acceptance passed 01:15, merged 03:47) | Codex 3 |
| #285 (still open) | 2 | no | open | Codex 1 |

The delays add up to about 8 to 10 hours of PR-level delay within roughly 26 hours, with two PRs in flight at once. 15 Codex commits and 3 Claude commits since 10-13 were direct responses to Windows failures. On top of that, #284 (be17859) was a whole PR fixing timeouts. Its own count: 15 rows of too-tight timeouts (10 of them Windows), 4 EBUSY races (all Windows) and 2 PowerShell timeouts.

**Unknown**
- Whether #284 lowered the flake rate. No frozen run has finished since it merged at 04:43Z.
- How much Codex reviewer time each Windows loop costs. Each new head needs a fresh independent review, a full Mac run and a new freeze (`docs/plan.md:91`).

## 3. Codex to Claude returns (handoff comments, PRs #237 to #285)

There were 24 returns. Some came before `handoff.mjs` existed: #241 has two, found by text match.

| Type | Count | Returns |
|---|---|---|
| Cross-platform process, concurrency, shutdown or lifecycle | 12 | #241 ×2 (#243); #244 (#245); #257 ×3 (#258 restart reconnect, and quit-cancel ordering twice); #259 (#260, which also has a Darwin-only zombie sub-item); #262 first (#263); #266 first (#267); #272 (#273 stderr blocking, plus a minor Windows-coverage item); #281 ×2 (#282, #283) |
| Cross-platform logic, not process-related (TLS) | 2 | #249 ×2 (#250). The second was caught by the Linux frozen CI on Node 22.23.3 |
| **Windows only** | **4** | #251 (native registry and `cmd.exe` tests required by the `AGENTS.md:29` rule); #255 second (breakaway contract); #262 second (#265); #266 second (#269) |
| macOS only | 0 as the main issue | macOS sub-items in #255 (start-time token) and #259 |
| Design or scope gap | 2 | #255 first (5 contract issues); #257 first (updater lane 10 has no update source configured) |
| Other: tooling or docs | 4 | #240 ×2 (handoff script); #275 (Markdown code fence); #277 (#278) |

- Windows-only returns are 4 of 24 (17%). Three were triggered by the frozen Windows CI and one by the policy rule.
- Most Windows CI failures (13 of 18) were never returned to Claude. Codex fixed them directly inside its verification scope (`AGENTS.md:9`).

## 4. How much of the code is platform-specific

| Area | Source files / lines | Test files / lines |
|---|---|---|
| All code under `packages/` (excluding generated files) | 554 files, 96,707 lines (source and tests together) | — |
| Daemon / UI / desktop source | 219 / 43,869 · 48 / 19,328 · 13 / 1,686 | daemon tests 246 / 38,885 |
| **Windows-only modules**: `service/windows.ts` 361, `service/win-startup.ts` 98, `provider/process/windows-supervisor.ts` 425, `windows-command-line.ts` 46, `windows-job-probe.ts` 54, `codex-appserver/windows-job.ts` 144 | **6 / 1,128 (2.6% of daemon source)** | 9 Windows-named test files / 1,556 |
| Background service (`service/*`, including launchd 380, systemd 380, update 304) | 15 / 2,529 | 25 / 6,460 |
| Process holder and host (`provider/process/*`, `native/holder/holder.c` 730, `platform/spawn.ts`, `owned-process.ts`) | 13 / 2,854 | 16 / 2,830 |
| Source files with a `win32` branch | **49 files, 138 places**, spread across config, cli-bridge, core, host, server and more | 61 test files, 204 places |
| Test blocks that **run only on Windows** (`skipIf(process.platform !== 'win32')`) | — | **12 blocks in 11 files** |

The Windows-only modules overlap with the background-service and process rows.

**PRs that were mostly Windows work**, by the share of changed code lines in Windows-named files:
- #275, Windows startup entry and launcher: 100% (1,266 of 1,272 lines)
- #262, Windows supervisor: 70% (805 of 1,153)
- #268, retiring the old Windows service: 47% (663 of 1,421)
- #284: mostly timeout fixes driven by Windows
- Earlier, #59 (restore hosted Windows CI)

**Operating-system layer work since 10-13.** Background-service PRs: #246, #270, #271, #274, #276. Process PRs: #255, #259, #266, #272, plus #262. Together that is 12 of the 20 merged product PRs. Only #251, #254 and #257 (desktop) produced something closer to what a user would see.

## 5. The user's proposal: risks and a lighter check set

**Risks of putting Windows CI off until the end**

1. **Windows code would never run while it is being written.**
   - The 12 Windows-only test blocks run nowhere else: there is no Windows machine (#208 OP-4 open; `AGENTS.md:29`).
   - Windows-sensitive work is still ahead: V5 pieces 13 to 15 (#288 asks for a Windows registry-read contract before service install is turned on), V6b moving Codex child processes onto ProcessHost (#281 open), and V7c is parked (`docs/plan.md:1716-1718`).
   - Writing Windows code with Windows CI off means the code is never executed until the end.
2. **Defects found now change designs; found later, they cost more.**
   - All 5 real Windows defects were caught within hours of being written.
   - Two of them changed a design or contract: the breakaway rewrite in `docs/providers.md` (#255) and the switch to overlapped pipe I/O (#262).
   - One root cause is still unknown (#279), and V6b is about to rely on that code path.
   - At the end there would be many PRs to bisect instead of one head per failure.
3. **The Windows code would decay unseen.** There are 138 `win32` branches across 49 files, plus Windows-specific behaviour such as the 32,767-character command-line limit that #255 hit, EBUSY on open files, and `taskkill`. Refactors like #281 moving `windows-job.ts` would break these silently; typecheck only catches type errors.
4. **Flaky tests would pile up unnoticed.** #284 already needed a whole PR to fix timeouts that showed up only on Windows.
5. **Docs that must change:** `AGENTS.md:28-29`, `docs/plan.md:212` and its CI policy section (`:214-232`, including the "no path filter … schedule" line at `:220`), `docs/roadmap.md:95-101`, and `docs/ci-costs.md`. The GitHub ruleset needs no change.

**What deferring would save:** about 7.6 minutes per frozen run, the 35% failure noise, and about 17 extra frozen runs per day of work. For UI work (19,328 lines of platform-neutral code) Windows CI adds almost nothing.

**Options for a lighter check set**

| Option | Time saved per run | Real defects since 10-13 it would still catch (of 5) | Windows failures it avoids (of 18) | What has to change |
|---|---|---|---|---|
| A. Keep as is | 0 | 5 | 0 | — |
| B. Windows build, typecheck and lint only | about 7.3 min | **0** (46 of 46 failures were in the test step) | 18 | `ci.yml`, docs. Pays for a slow job and gets almost no signal |
| C. **Run full Windows only for PRs touching Windows-sensitive paths** (`windows`, `win32`, `win-startup`, `provider/process/`, `platform/`, `native/`, `packages/desktop/`, package and lockfiles, `.github/`, `vitest.config`) | 7.6 min on PRs that skip | **5** | 6 (#276 ×4, #271 ×2) | `ci-scope.mjs`, its tests, `ci.yml:87`, `plan.md:220`, `AGENTS.md:29` |
| D. Windows runs but does not block merge; each failure becomes an issue | Merge latency only (CI minutes stay the same) | 5 signals kept; fixes come later | 18 stop blocking | Merge-rule docs only |
| E. Windows weekly or nightly on `main` only | 7.6 min on every PR | 5, but late, with a batch of PRs to bisect | 18 | Add a `schedule:` trigger; `plan.md:220` |
| F. On each frozen head, run only the Windows test files (the 11 Windows-only files plus `windows-*` tests) | Not measured. Those files took about 146 s of test time, against 536 s for the whole daemon suite, in green job 115619669404 | Probably 5 (all were in these files) | About 8 (5 of the 9 untouched-test flakes, plus the #285 fixture failures) | `ci.yml` test filter, docs |

Simulating option C on the 21 PRs merged since 10-13: 12 would run Windows and 9 would skip it. The 5 PRs that found real defects all touched those paths.

**Is path-based Windows gating easy?** Yes.
- `determineScope` already collects the changed paths (`ci-scope.mjs:55-57`) and writes `scope`, `base`, `head` and `full` outputs (`:85-88`).
- Adding an `isWindowsPath()` check, a `windows=` output and `&& needs.linux.outputs.windows == 'true'` in `ci.yml:87` is about 20 lines, plus test cases in `ci-scope.test.mjs` (370 lines today).
- Caveat: a rule based on directories misses the 49 files with `win32` branches elsewhere. A rule based on "the file contains `win32`" would match 20 of the 21 PRs, which is useless. So C should be paired with E (a scheduled full Windows run) or a full Windows run before release.

**What the evidence points to.** The cheapest safe change is C plus E, possibly with D for failures in untouched tests. The bigger lever is to order the work Mac-first: put the remaining Windows-specific features on hold, the way V7c already is, so that no Windows code is written while Windows CI is off. Turning Windows CI off while V5 and V6b keep adding Windows code is the risky combination.

**macOS CI.** It is cheap: 1.8 minutes median, self-hosted, no GitHub charge. Since 10-13 its 5 failures were all timeouts in tests the PRs did not touch (#254, #262, #268 ×2, #266). It largely repeats the full Mac test run Codex already does on every head (for example on #276: `VITEST_MAX_WORKERS=1 npm test`, 3,114 passed). It could become informational. It is unknown whether the shared Mac mini runner (`docs/roadmap.md:95`) is the same machine Codex works on; Codex's commits come from `<Mac 账号>@<Mac mini 主机名>`. If it is, the two would compete for that machine.

**Linux.** Keep it. It is the only GitHub-required check, and it caught a real bug (#249, a Node 22.23.3 TLS issue).


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report's main numbers reproduce from the Actions API: 18/51 Windows failures since 10-13, a median of 7.6 minutes added per run, 46 of 46 Windows failures in the test step, a GitHub rule that requires only linux, a 12/9 split under option C, and the code-size counts (6 files and 1,128 lines Windows-only, 49 files and 138 win32 branches, 12 Windows-only test blocks in 11 files). The 9 'flakes in untouched tests' hold when checked against the files each failing head had changed.

Four claims that bear on the decision need correcting:
1. The 'runner glitch' was a billing block. Since 10-10, 29 jobs were never started because of a failed payment or the spending limit.
2. 'Money is not the issue, about $5 nominal, inside the free minutes' is wrong as stated. The free minutes ran out on 10-10. Actual net charges for 10-10 to 10-14 were about $13 (Windows $8.75), and the billing state has stopped CI three times.
3. Option C has a concrete gap: #246 would skip Windows while adding a Windows-only registration test.
4. 'The OS layer is not written' overstates it. Most of it is merged (V5 1-11, all of V6a). It is not finished or switched on: V5 12-15, V6b 1/14 and V7c remain.

The report also treats as unknown that the Mac CI runner is the same Mac mini Codex uses, which the docs answer. And Codex's manual full Mac test run goes against the existing rule that it should not repeat what Mac CI covers.

Net effect on the strategy: the case for making Windows CI lighter or non-blocking is somewhat stronger than the report says, because it also cuts spend and the risk of billing blocks. The case for a path-only rule is weaker unless it also catches win32 in test files or is paired with a scheduled full run.


### 逐条复查

- **属实**：Since 10-13 the Windows job failed in 18 of 51 frozen runs (35%); Linux failed in 11%, macOS in 10%.
  - 依据：I re-pulled `gh api --paginate "repos/modelzen/vonvon-bot/actions/runs?per_page=100&created=>=2026-10-10"` (468 runs, 445 CI) and `/runs/<id>/jobs?filter=all`. A full-chain attempt is one where the linux job's 'Install dependencies' step ran. Attempts started on or after 2026-10-13T00:00Z: 57. Linux 51 passed / 6 failed (10.5%). Windows 32 passed / 18 failed / 1 cancelled, and 6 never ran because Linux failed (18/51 = 35%). macOS 45 / 5 / 1 (9.8%). All 57 were pull_request events. Before 10-13 I count 57 runs, not 56; the extra one is a dependabot run (38103684945) that failed in npm ci, which does not matter here.
- **属实**：On an all-green run Windows adds a median of 7.6 minutes; the Windows test step median is 7.3 minutes.
  - 依据：Same data, 28 attempts since 10-13 where all three jobs passed. The median wall clock was 14.8 min, or 6.5 min without Windows. Windows finished a median of 7.6 min after Linux and macOS (my p90 is 10.5; the report says 10.2, the gap comes from the quantile method). Median 'Run npm test' step over the 32 passing Windows jobs: 7.3 min. Whole-job medians: linux 4.5, Windows 10.2, macOS 1.8. Windows runs after Linux (`ci.yml:86` `needs: linux`), so its time adds to the wait one-for-one.
- **属实**：Of the 18 Windows failures, 5 were real Windows defects, 3 were test setup code the PR had changed, and 9 were flaky tests the PR never touched.
  - 依据：I fetched the logs of all 18 jobs (`/actions/jobs/<id>/logs`) and compared each failing test file with `gh api compare/be17859...<failing sha>`, which shows what the branch had changed at that head. None of the 9 'untouched' cases had changed the failing test file at the failing head. Examples: #276 6c033726 failed web-admin-service and import-core; 8b6604d0 failed holder-process; 51cd3409 failed process-host; #271 c2092382 failed process-host. The final PR diffs do change some of these files, but only as fixes made after the failure. The real defects line up with fix commits: e056168b 'distinguish absent Windows Run registration from read failure', bd43fb6a (breakaway), 4d3418ac (overlapped pipe I/O), 05b34361 (#265), 8c0c732a (#269). One caveat: #284's commit message (be17859) says it is still open whether the Windows failures of 'cancels immediately while the process owner is starting' are a too-tight timeout or a product stall. So some 'flakes' may be real.
- **有误**：The 18th failure was a runner glitch with no log (#271 e6c65df3, first attempt).
  - 依据：`gh api repos/modelzen/vonvon-bot/check-runs/115545795636/annotations` → "The job was not started because recent account payments have failed or your spending limit needs to be increased." Three more CI jobs on #266's branch (claude/v6a-process-host-wire) were blocked the same way at 21:30, 21:33 and 22:01Z on 10-13.
- **有误**：Money is not the issue: Windows minutes since 10-13 cost about $5 nominally. Four days used about 2,250 of the 3,000 free minutes a month.
  - 依据：`gh api "orgs/modelzen/settings/billing/usage?year=2026&month=10&day=DD"` for vonvon-bot. Windows net: 10-10 $1.18, 10-11 $0.80, 10-12 $1.54, 10-13 $3.62, 10-14 $1.61; net equals gross from 10-10 on. Linux net: $0.44, $0.24, $0.68, $2.37, $0.64. Org plan: team (`gh api orgs/modelzen`). `docs/plan.md:234` says Actions minutes were exhausted on 2026-10-10. `docs/ci-costs.md:56-58` estimated about $12 for all work up to V11 and suggested a $20/month limit; vonvon-bot alone passed $12 within five days.
- **属实**：The ruleset requires only `linux`, so the Windows requirement is written policy, and dropping it needs doc edits, not GitHub admin changes.
  - 依据：`gh api repos/modelzen/vonvon-bot/rulesets/24838891` ('Protect main', active) → `required_status_checks:[{"context":"linux","integration_id":15368}]`, `strict_required_status_checks_policy:true`. Classic branch protection returns 404 'Branch not protected'. Merge rule as written: `docs/plan.md:212`, `:230`; `AGENTS.md:28-29`.
- **属实**：A 'Windows build and typecheck only' job would have caught none of the 46 Windows failures since 10-10, because every one was in the test step.
  - 依据：Of the 46 failed Windows full-chain jobs since 10-10 (28 before 10-13, 18 since), 45 failed in 'Run npm test' and 1 had no steps (the billing block above). None failed in npm ci, build, typecheck or lint.
- **说过头了**：The user thinks the operating-system layer is already written. It is not: 12 of the 20 product PRs merged since 10-13 were that layer, and more is to come (V5 at piece 12 of 15, V6b just split into 14 PRs, V7c parked).
  - 依据：`gh pr list --state merged --search merged:>=2026-10-13`: 26 PRs, 20 of them product. 12 is reached only by adding #268 and #275 to the 10 PRs the report actually lists (#246, #270, #271, #274, #276, #255, #259, #266, #272, #262). Open: #285 'V5 12/15', #281 'V6b 1/14'. V7c is parked at `docs/plan.md:1718` ('While no Windows host exists it is parked').
- **说过头了**：Option C (full Windows only for PRs touching Windows-sensitive paths): 12 of 21 merged PRs would run Windows and 9 would skip. All 5 real defects would still be caught, and 6 of 18 failures avoided.
  - 依据：I applied the report's regex to `gh api pulls/<n>/files` for the 21 PRs. RUN: #248, #251, #254, #255, #257, #259, #262, #266, #268, #272, #275, #284. SKIP: #237, #241, #244, #246, #249, #270, #271, #274, #276. `git log -S'Windows native filesystem registration'` → 6c1704c (#246); the block is at `packages/daemon/test/service-definition.test.ts:206`, gated by `describe.skipIf(process.platform !== 'win32')`. #246's added lines mention win32 or Windows 81 times; #237's, 32 times.
- **属实**：The workflow cannot use path filters or schedules today, because `docs/plan.md:220` forbids them.
  - 依据：`docs/plan.md:220`: 'The workflow has no path filter, branch-push trigger, or schedule.' `docs/roadmap.md:99` repeats it (no scheduled run is set). `ci-scope.mjs` (actually at `.github/scripts/ci-scope.mjs`) writes only scope, base, head and full (`:87`); `ci.yml:87` gates Windows on `needs.linux.outputs.full`. `ci-scope.test.mjs` is 370 lines. This is a policy rule, not a technical limit.
- **说过头了**：macOS CI's 5 failures since 10-13 were all timeouts in tests the PRs did not touch.
  - 依据：Logs of macOS jobs 115302198017, 115445532861, 115489307579, 115502883816 and 115520216964; `gh api compare/be17859...232da20e` shows data-access.test.ts untouched at that head; `gh api pulls/268/commits`.
- **有误**：It is unknown whether the self-hosted Mac CI runner is the same machine Codex works on.
  - 依据：`docs/self-hosted-ci.md` (current state section): 'Mac job 由本机 ci-user 标准账户下的 mac-mini-isolated 接单', an ACL set on ~, and 'switching back to clay with fast user switching'. `docs/plan.md:216`: 'One Mac runner runs one job at a time.' Codex commits come from <Mac 账号>@<Mac mini 主机名> (e.g. e056168b), and the #276 evidence is under ~/vonvon-review/.

### 正文遗漏的事实

- Billing has blocked CI three times. Since 10-10, 29 jobs across CI and Native desktop validation were never started because a payment had failed or the spending limit was reached: on 10-10 about 10:22 to 16:00Z, on 10-12 about 09:51 to 11:41Z, and on 10-13 at 21:20 to 22:01Z (1 Windows job on #271, 3 linux jobs on #266's branch). Source: `gh api check-runs/<job id>/annotations` for every failed job with no steps. Under `docs/plan.md:230` a billing failure is 'blocked, never passed'. Part of the #266 and #271 delays that the report puts on Windows came from these billing blocks.
- The free Actions minutes ran out around 10-10, so every minute since then is charged. At the 10-13 rate, about $6 a day net for vonvon-bot (`billing/usage?day=13`: Linux $2.37 + Windows $3.62), a $20 monthly limit like the one `docs/ci-costs.md:58` suggests would have run out within days, and Windows is about two thirds of that spend. Lightening Windows CI therefore also lowers the risk of the spending limit stopping all CI, Linux included.
- Policy already says Codex should not repeat the routine Mac chain that Mac CI covers (`docs/plan.md:228` 'the operator does not rerun an identical manual Mac chain'; `docs/roadmap.md:101`). Yet Codex ran `VITEST_MAX_WORKERS=1 npm test` (3114 passed) on #276 at 01:15Z. So the macOS work is duplicated, and both copies run on the same Mac mini.
- Each Windows-only failure triggers a new head, a new independent review and a new freeze. On #276, three Windows-only failures led to four independent reviews (01:13, 01:52, 02:23 and 03:20Z) and four freezes before the merge at 03:47Z (`gh api issues/276/comments`). That partly answers the report's 'unknown' about Codex reviewer time per Windows loop.
- `AGENTS.md:28` says full three-platform CI runs once per frozen head. In practice the ~21 PRs merged since 10-13 used 57 full runs, about 2.7 per PR: 53 distinct heads plus 4 reruns, 11 of the heads being merges from main (from the run data and `gh api commits/<sha>` parent counts). The one-run assumption behind the cost doc does not hold.
- #268 counts as mostly Windows work, but by deleting it: +63/-1358, removing the old win-startup.ts and win-* tests. Counting tests as well, 85% of its changed lines are in Windows-named files (the report says 47%, source only), and deletions carry little risk without Windows CI.
- #284 (be17859) was itself written by Claude (Co-Authored-By trailer). Its census says the 15 too-tight-timeout rows include 4 at the 5 s default on macOS or Linux, so not all the timeout noise came from Windows.
- Still unmeasured as of 05:34Z: no full run has started since #284 merged at 04:43:21Z (the latest full Linux start was 04:34:25Z), so it remains unknown whether #284 lowered the Windows flake rate.
