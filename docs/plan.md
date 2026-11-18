# Vonvon Bot v2 plan

> **2026-10-14 起停止执行。** owner 重新定义了第一版：macOS 桌面端，每个 bot 有自己的工作区、仓库、skill、记忆和性格。v1 的范围以定稿后的 `docs/product.md` 为准，规则见 `AGENTS.md`。本文只作历史参考，其中的清单不再勾选，也不再按它开 PR。

Vonvon Bot becomes an independent product with a per-machine daemon, a web UI and an Electron desktop shell as clients, and an optional Vonvon account that lists every machine for remote management. It stops vendoring feishu-codex-bridge, imports a bridge user's data, and then shuts the bridge service down. The rule the program enforces is that the daemon is the only writer of machine data and the cloud never stores settings. The design and its reasons live in `docs/architecture.md` and `docs/roadmap.md` next to this file in `modelzen/vonvon-bot`. The provider layer's design is in `docs/providers.md`. The planned PRs are V1, V2, V3, V4, V5, V6a, V6b, V6c, V6d, V7a, V7b, V7c, V8, V9, V10, and V11; their merge order follows the dependency graph below.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. Codex on the operator's Mac runs it. Read `skills/poteto-mode/references/codex-tools.md` for the Codex equivalent of each Claude tool, model, and skill this plan names. The repository's `AGENTS.md` overrides one step of the playbook. Nobody force-pushes or rebases a pushed branch. A child syncs its parent by merging the parent branch in, and a child whose parent landed retargets to `main` and merges `main` in. Codex owns all code, every check in this plan, packaging, and guarded Shipping after verification. Claude Code on the Linux server normally owns this plan and the design docs, and writes no product code. When the plan is wrong or incomplete, Codex says so in the PR. Codex decides a small deviation that leaves the design intact and records why in the PR. A later change to the architecture, a data shape, or the PR order goes back to Claude Code, which updates the docs on a `claude/` branch before Codex continues.

On 2026-10-10 the Claude Code CLI returned HTTP 401 during the docs-only V2 clarification. The operator explicitly authorized Codex to apply that clarification and continue. The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review or a manual merge click. This exception does not waive the screenshots, video, or CLI evidence bundle that a PR prescribes under *Interaction evidence*, unit tests, all ten live lanes, perf checks, independent audits, or the exact-head Shipping verdict. It does not authorize force-push, rebase of pushed branches, or an hourly audit.

Pin every reference source to the commit below. Clone the ones the Mac does not have.

| Source | Repository | Commit |
| --- | --- | --- |
| Bot runtime | `modelzen/feishu-codex-bridge` | `446b2a4` on `codex/device-handoff` |
| Current UI and zod contracts | `modelzen/vonvon-bot` | `fab5237` on `codex/device-handoff` |
| Pid lock, relay crypto, chat-mode parity reference for `docs/providers.md` | `getpaseo/paseo` | `0009a7e71` |
| Import and old-service control | `modelzen/vonvon-bridge-legacy` | `3a16853` |
| Feishu and Lark login | `modelzen/vonvon-platform` | `3427634` |

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, record in standing orders and the todolist that merges follow the merge graph under *Dependencies*, and that the GitHub issues under *Program tracking* carry each version's state. Tests alone do not verify a PR. Codex merges only after unit, all live, perf, independent audit, and exact-head Shipping checks pass. No force-push or rebase of pushed branches. The program ends when V11 is verified and earlier PRs have landed or been parked with a reason.
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `run` (the bundled Claude Code skill) until V4 lands, then `.agents/skills/verify/SKILL.md` in the repository
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/how/SKILL.md`, `skills/interrogate/SKILL.md`, `skills/show-me-your-work/SKILL.md`, `skills/create-verification-skill/SKILL.md`
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owners use branch prefix `codex/`.
- [ ] Follow the dependency table in *Dependencies* under *Parallel execution*. It separates where a branch starts from what its acceptance needs and when it merges. Merges follow the merge graph under *Dependencies*: a PR merges once its merge predecessors have merged, in whatever order the chains finish. A branch never rebases. It merges its parent branch in when the parent moves, and merges `main` in after its parent lands.
  - [ ] V1 and V2 are merged. Nothing in this graph rebases, retargets, or reopens them, and open PRs keep their branches.
  - [ ] V9 lives in `modelzen/feishu-codex-bridge`, branched from `origin/codex/device-handoff`.
- [ ] Hold the file boundaries. V1 touches only the root config, `packages/protocol/**`, `.github/**`, `NOTICE`, and `README.md`. V2 and V3 touch only `packages/daemon/**`, `scripts/import-core.mjs`, `packages/protocol/**`, and necessary root package metadata or lockfile changes for workspace integration. V3 also creates the minimal local client in `packages/client/**` that its lanes drive. V4 extends `packages/client/**` and adds `packages/ui/**`, `.agents/skills/verify/**`, `packages/daemon/src/server/web-ui.ts`, and `packages/daemon/src/cli/commands/open.ts`, and edits `packages/daemon/src/server/http.ts` only to mount `web-ui.ts`. V4 also edits `packages/daemon/src/server/rpc/command.ts`, `environment.ts`, `machine.ts`, and `settings.ts` only for the branches its *Browser coverage* assigns to the daemon. It creates `packages/daemon/src/environment/**` and the three daemon tests that V4's Files names. V5 touches `packages/desktop/**` and, for its *Service gate*, the daemon's service files `packages/daemon/src/service/launchd.ts`, `systemd.ts`, `win-startup.ts`, `adapter.ts`, and `common.ts` and `packages/daemon/src/cli/commands/service.ts`. The gate also creates `service/identity.ts`, `service/definition.ts`, `service/registration.ts`, and `service/drain.ts`, and edits `service/distribution.ts`. For the `global-npm` package, V5 also edits `packages/daemon/src/server/web-ui.ts` only for its UI root resolution, and creates `scripts/stage-daemon.mjs`, `scripts/pack-vonvon-bot.mjs`, `scripts/check-vonvon-bot-package.mjs`, `scripts/smoke-vonvon-bot-package.mjs`, `scripts/vonvon-bot-install-scripts.json`, and `scripts/package-tools.test.mjs`, per *Package* in V5. It edits `packages/daemon/src/host/service.ts`, `host/lifecycle.ts`, `host/bootstrap.ts`, `cli/commands/daemon.ts`, and `cli/commands/run.ts`, each only for the change that *Daemon files* in V5 names, and it creates the test files that section names. V5 never edits `service/control.ts`, which V8 uses, `service/codex-bin.ts`, `service/update.ts`, or `cli/commands/daemon-control.ts`. V6a to V6d and V7a to V7c touch `packages/daemon/src/provider/**`, `packages/daemon/src/outbound/**`, the `card/` and `bot/` consumer files and the `admin/`, `host/`, `project/`, `server/`, `cli/`, and `config/` files that V6b's *Files* names, the provider ids and `readScope` in `packages/protocol/src/domain.ts` and `settings.ts` through the root, the provider picker in `packages/ui/**`, `scripts/prove-enforcement.mjs`, `scripts/record-fixture.mjs`, and `docs/proofs.md`. They delete `packages/daemon/src/agent/**`. They own their tests under `packages/daemon/test/provider/`. They touch no `NOTICE` section and no `tsconfig`, because nothing is copied from Paseo. V8 touches only `packages/daemon/src/import/**`, `packages/daemon/src/cli/commands/import.ts`, `packages/protocol/src/import.ts`, and `packages/ui/src/import/**`. V10 and V11 add `packages/cloud/**` and `packages/daemon/src/cloud/**`. V10 also adds `packages/ui/src/account/**` and `cli/commands/login.ts`, and V11 also adds `packages/client/src/transport-relay.ts`, `packages/client/src/e2ee/**`, and the machine switcher in `packages/ui/src/`. Each PR's edits to the shared integration files under *Shared files* go through the root.
- [ ] Preserve interaction evidence under *Interaction evidence* below, then proceed through independent review and guarded Shipping without waiting for personal review or a manual merge click.

### Interaction evidence

The evidence a PR keeps for review follows the surface a user meets in that PR. It adds to the unit, live, lifecycle, perf, native, CI, independent audit, and exact-head Shipping gates and replaces none of them.

- A browser page, an Electron window, or a Feishu card. Keep the screenshots that the PR's lanes and **Review evidence** name, taken from the real page, window, or Feishu client, and the 30 to 60 second video. These surfaces have layout, rendering, and timing, such as a streaming card, a launch, or an import flow, that only an image or a recording shows. V4 to V11 keep their screenshots and video as written.
- A command line or the WebSocket API only. Keep the CLI evidence bundle below. A terminal screenshot or a screen video is not required, because it only renders text the bundle already holds byte for byte, binds to no SHA, and cannot be checked by a script. V3 is the only PR whose whole surface is the CLI and the API.
- A required capture that cannot be produced leaves its box unchecked, and the PR stays blocked. An authorization is never recorded as a capture or a pass. Nothing is staged, edited, or synthesized.
- A failed or missing capture stays recorded at the head where it happened. A later run that corrects it is a separate receipt at its own head, and neither one rewrites the other.

*CLI evidence bundle.* One bundle per frozen head, produced by one agent and checked by another.

- Build. A fresh worktree at the exact head, `npm ci`, then `npm run build`. Fresh `VONVON_HOME` and `HOME` temporary folders, no registered Bot, and no Feishu connection.
- Terminal pass. Run the PR's step list in a pseudo-terminal recorder that keeps the raw output bytes with their timing and can replay them, such as macOS `script -r`, replayed with `script -p`. The commands see the terminal as their standard input, output, and error, as a user's would. After each step the driver prints one line `@@step <n> exit=<code>`. Save `terminal.typescript`. The recorder runs inside the agent's own shell. It needs no control of a terminal app, no screen recording, and no accessibility automation, and it does not stand in for a tool the runtime has denied. If the runtime refuses the recorder too, the box stays unchecked.
- Structured pass. Run the same steps again in another fresh home with the same build. Save each step's raw standard output and standard error as `NN-<slug>.stdout` and `NN-<slug>.stderr`, and one line per step in `steps.jsonl`: step number, argv, working directory, start and end times, exit code, and the sha256 of both output files.
- Checker. A script reads only the bundle files and writes `assertions.json` with every assertion of the step list and its result. It never reads the PR body. The bundle includes raw PID-lock, process birth and command, host census, and service/home before-and-after receipts. Compare stable process identity fields, not changing CPU or elapsed-time counters. Record the credential length and SHA-256, never its plaintext; check absence by hashing candidate hex strings in decoded PTY output and raw command outputs.
- Manifest. `manifest.json` records the head SHA, the PR base and merge-base SHAs, that `git status --porcelain` was empty, the macOS, Node, and npm versions, the sha256 of `package-lock.json`, the sha256 of `packages/daemon/bin/vonvon.mjs` and of every file under each workspace's `dist`, and the sha256 of every bundle file except `manifest.json` itself, including the driver, checker, snapshot script, and auxiliary receipts. The PR body records the manifest's own sha256. A changed file, head, or lockfile invalidates the bundle.
- Independent check, by an audit lane that did not produce the bundle. It verifies every hash in the manifest and that its head, base, and lockfile equal the head under verdict. It reruns the checker. It replays `terminal.typescript` and confirms that the step markers and exit codes equal `steps.jsonl`. It then runs the structured pass itself, from its own fresh worktree, build, and homes at the same head, and gets the same exit code and the same result for every assertion. Values that differ by run, such as a pid, a port, or a time, are compared only through the assertions. It saves its own `manifest.json`. A difference in a source hash or an assertion fails the bundle. A difference in a `dist` hash with equal source and lockfile is a finding that the auditor explains before the verdict.
- Pass when every assertion holds in each pass the PR's step list assigns it to, every structured-pass result is reproduced by the independent run, every hash verifies, and both manifests name the frozen head. At minimum, every assertion holds in the structured pass, and an assertion that the step list marks *both* also holds in the terminal pass. An implementation may check more assertions in both passes than the step list requires. Anything else fails, including a missing file.

### Parallel execution

This section says where each branch starts and how the two machines share the work. It changes no architecture, wire or storage shape, or evidence gate. On 2026-10-12 the linear V1 to V11 merge order was replaced by the merge graph under *Dependencies*. On 2026-10-13 the root-plus-workers model was retired; `AGENTS.md` is the rule.

*Roles, from 2026-10-13.*

- Claude Code on the Linux host designs and implements. One `claude/<task>` branch per task partition, implemented and checked on Linux, then handed to Codex through the PR's `owner:` label.
- Codex on the Mac reviews, verifies on macOS and Windows, runs native and real-window acceptance, freezes the head, dispatches the full CI run, runs Shipping, merges, and maintains the board. Codex fixes platform-only breakage inside the verification scope and records it in the PR. Anything else goes back to Claude as a PR comment with a reproduction.
- At most two product PRs are in flight. One session per in-flight PR on each machine. Only the `owner:` side pushes. Each machine keeps one worktree per branch and deletes it at merge.
- The partition tables below keep their file ownership. Where they name a root or a worker, read Claude for the writing and Codex for the integration checks.

*Runtime isolation.*

- Each concurrent unit run, probe, or proof uses its own `VONVON_HOME`, with port 0 or a port it has just found free. No two concurrent runs share a data root, a Bot, a fixed port, or a service identity.
- Lanes that connect the fixture Bot stay serial, per the V2 fixture rules. In V3 those are lanes 1, 5, 6, 8, and 10 and the connected perf probe.
- Native service acceptance, from V5 on, stays serial, because one test user has one service identity.
- Perf probes run with no other lane, proof, or build active on the Mac, so the timings measure the change.
- Audit lanes only read, so they can run beside anything.

*Validation order, for every PR.* The expensive gates run once, on a frozen head.

1. Design in the PR. Claude writes or updates the plan section the PR implements, in the same PR.
2. Test-first implementation on Linux. Claude writes the unit tests, makes them pass, and runs the clean chain once: `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`. The PR description lists the commands, their results, and the Mac checks still needed.
3. Review and platform verification. Codex reads the diff independently, runs the same chain on macOS, and runs the real-window and native checks the PR names. Findings go back through the PR as comments or as in-scope fixes.
4. Freeze. Codex labels the head `frozen`. The CI results under *CI policy*, the live lanes, the lifecycle proofs, perf, native checks where the PR names them, the interaction evidence, and the exact-head Shipping verdict all run on that head. Any patch change makes a new head, which needs a fresh verdict, except for results that stay valid under the patch-id rule together with the context check in *After V3*.

*V3 repair partitions.* What remains for V3 is the repair of issues 44 to 48 under *Lifecycle ownership*, *Jobs*, and *Events*, and of issue 50 under *Provider processes* in *Lifecycle ownership*. All six are in scope. With the service commands failing closed, the service half of issue 44 is a small refusal, and the drain control is the new transport work. They split into three disjoint workers.

- Worker L, lifecycle, for issues 44 and 45. It owns these files under `packages/daemon/src`:
  - `host/lifecycle.ts`, `host/restart.ts`, `host/bootstrap.ts`, and `host/service.ts`
  - `cli/index.ts`, `cli/commands/daemon.ts`, `cli/commands/daemon-control.ts`, `cli/commands/service.ts`, and `cli/commands/run.ts`
  - `bot/supervisor.ts`, `server/rpc/machine.ts`, `server/rpc/command.ts`, and `service/update.ts`

  It also owns `daemon-lifecycle.test.ts` and the retargets of `daemon-cli.test.ts` and `daemon-control-stop.test.ts`. It rehearses the long-drain restart, stop-wins, port-mismatch, and service-refusal proofs.
- Worker D, drain control, for the transport half of issue 44. It owns `server/ws.ts`, `server/http.ts`, and `server/owner-verification.ts`, and `server-drain-control.test.ts`.
- Worker J, jobs and logs, for issues 46, 47, and 48. It owns `agent/installer.ts`, `agent/backend-loader.ts`, `agent/index.ts`, `admin/service.ts`, `server/jobs.ts`, `server/rpc/environment.ts`, and `server/logs.ts`. It also owns `backend-installer-queue.test.ts`, `server-logs.test.ts`, and any change to `server-backend-install.test.ts`. It rehearses the serialized-install and log-burst proofs. The root may split J into an installer agent and a log agent, because `server/logs.ts` and `server-logs.test.ts` share no file with the rest. That split changes no contract.
- Handoff points, which the root freezes in step 1.
  - In `server/http.ts`, the root writes the drain interface that `startApi` returns: one call that starts the drain and keeps the restricted listener, and one call for the release step that closes the listener. It also writes a fake of that interface. D implements it, and L calls it from the host runtime and tests against the fake.
  - In `server/owner-verification.ts`, the root writes the signature of the verified stop: authenticate, check identity, send `stopHost`, and resolve on `done` or throw the existing verification error. D implements it, and L's `runStop` calls it.
  - The `daemon-restart` and `daemon-shutdown` outcome names live in `host/lifecycle.ts`, which L owns.
  - J has no handoff with L or D.
- Issue 50 round. L, D, and J finished the first round. Issue 50 adds worker P and reopens L and D on the same worktree rules. J's agent is free to take P.
  - Worker P, provider ownership. It owns these files under `packages/daemon/src`: `agent/codex-appserver/owned-process.ts`, `windows-job.ts`, `app-server-client.ts`, `client-pool.ts`, `backend.ts`, and `managed-install.ts`, and `bot/handle-message.ts` and `bot/bridge.ts`. It owns the new `provider-ownership.test.ts`, which takes over issue 50's diagnostic and its two failing regressions. J's `agent/installer.ts`, `backend-loader.ts`, and `index.ts` are disjoint from P's files.
    - `managed-install.ts` is an adjacent consumer of `exited`. P migrates only `runSetupChild` to the `exited` contract under *Provider processes*, and changes nothing else in that file.
    - P also owns every change to an existing test file of the pool, the backend, or `managed-install.ts` that needs a fresh module graph after a terminal registry shutdown, under *Registry*. The PR lists those files in the mapping table.
  - L adds the runner side: `cli/commands/run.ts`, `bot/supervisor.ts`, `host/lifecycle.ts`, and `host/bootstrap.ts`, with new cases in `daemon-lifecycle.test.ts`.
  - D adds `ApiCleanupError` and the release classification in `server/http.ts`, with new cases in `server-drain-control.test.ts`. D keeps its first-round ownership of `server/ws.ts` and reopens it for the failed-termination repair under *Listener release*. No other worker edits `ws.ts`.
  - Handoff points, which the root writes and freezes before P, L, and D start. In `owned-process.ts`: the signatures of `closeOwnedCodexProcesses()` and `unconfirmedCodexPids()`, and a fake registry for L. In `server/http.ts`: the exported `ApiCleanupError` class. The `fcb.owned-work` message passes between `run.ts` and `supervisor.ts`, which L both owns, so it needs no handoff. `BridgeHandle.shutdown` keeps its signature.
  - The root owns the new `provider-lock-retention.test.ts`, written at integration after P and L are merged, because it drives P's real orchestrator through L's real runner.
- Integration order. J first, because it is independent, then D, then L, because L consumes D's implementation. For issue 50: D, then P, then L, because L consumes D's `ApiCleanupError` and P's registry, and then the root's `provider-lock-retention.test.ts`.
- Critical path. Interface freeze, then L, which is the largest partition, then integration, review, and the frozen-head gates. When D and J finish early, their agents become audit lanes for the partitions they did not write.
- Frozen-head waves, with three agents. One agent runs the Bot-connected lanes 1, 5, 6, 8, and 10 one at a time. The other two run lanes 2, 3, 4, 7, and 9 and the lifecycle proofs, each on its own data root. The CLI evidence bundle runs on its own homes beside them, and its independent check comes from another agent. Both perf probes run last, alone. The audit lanes run between the others. V3 has no native wave.

*Dependencies.* A PR has three kinds of input, and only the first decides when its work starts.

- Development baseline. The code a branch needs to compile and test its own files. A branch starts from its parent branch's pushed head once the interface it consumes is frozen, without waiting for the parent's verdict or merge.
- Acceptance input. A real artifact or behavior that a live, perf, or native check needs: a built UI, a real Electron shell, a signed and published installer, the Feishu fixture Bot, a dedicated OS test user, or a Linux systemd user session. The PR's evidence-grade gates wait for it. A worker may rehearse earlier, and a rehearsal is never evidence.
- Merge graph. A PR merges after its merge predecessors in the table's *Merges after* column, and after nothing else. The predecessors are real dependencies, not the roadmap numbering. The client and cloud chain is V5, V10, V11. The provider chain is V6a, V6b, then three independent successors V6c, V6d, and V7a; V7b follows V7a, and V7c follows V7b. The import chain is V8, V9. V6a and V5 both follow V4 and land in whichever order they finish. V7c is a leaf and blocks nothing. Shared files under *Shared files* are root-written, so a cross-chain merge conflict is confined to them and is handled by the patch-id rule.

Freeze points. A freeze point is a pushed commit at which the named interface is fixed. It is an interface commitment, not a verdict. The root records its SHA. If the interface changes after it, the owner tells the root, and every branch that started from it merges the new commit in.

- `H3`. The V3 head after the root merges the current `main`, with this plan, into the V3 branch. The root read the V3 product head as `8c0adb4` before that merge, and records `H3` when it creates the branches below. V3 is code-complete. If its Shipping finds a defect, the repair makes a new V3 head, and every branch started from `H3` merges it in.
- `F4`. The V4 commit that fixes four things: the `packages/client` exports for browser and Electron preload use, added beside the Node-only `connectLocal` without changing any RPC or event shape; the injected-client API of `packages/ui/src/client-context.tsx`, including the optional shell-capability object from V4's *Shell capabilities*; the build script and output path `packages/ui/dist`; and one UI feature registration file, where a later feature adds one entry.
- `F6`. The V6a commit with `provider/model.ts`, `provider/engines/engine.ts`, `provider/registry.ts` (the `Registration` type only, no `REGISTRY`), and `provider/policy/enforcement.ts` matching the listings in `providers.md`, typecheck clean, and `turn-machine.test.ts` and `enforcement.test.ts` passing. V6b, V7a, and V7b consume the whole `Engine` and `RunEvent` contract, so `F6` never freezes a subset of it.
- `F10`. The V10 commit with the device enrollment, device credential, and outbound link interfaces in `packages/daemon/src/cloud/` and `packages/cloud/src/devices.ts`, and `devices.test.ts` passing.

| PR | Branch | Development baseline | Waits for, per part | Acceptance inputs | Merges after |
| --- | --- | --- | --- | --- | --- |
| V4 | `codex/v4-web-ui` | `H3` | Nothing | A running daemon at V4 head, the old renderer at `fab5237`, Playwright Chromium | V3 |
| V5 | `codex/v5-desktop` | V4 branch at `F4` | The shell files, including the native authenticated attach unit, need only `F4` and are independent of Gates L and M. The service files and `login-item.ts` start now, including `service/drain.ts`, Gate L, and Gate M under *Service gate contracts*, whose designs are closed. `install` and `uninstall` stay refused on every head until the transactions, the *Pre-lock guard*, both gates, and their tests are all integrated | Real `packages/ui/dist` in a real Electron window, an older daemon build, a Mac GUI session, which is the operator's account `clay` under the user's override in *Native acceptance environment*, a dedicated Linux user with a systemd user session | V4 |
| V6a | `codex/v6a-provider-core` | `H3`, or `main` once V3 has merged | Nothing | The Mac and the Linux host for the process tests, the Feishu fixture Bot for the uploader lanes | V4 |
| V6b | `codex/v6b-provider-runtime` | V6a branch at `F6` | The engines and the runtime start at `F6`. The consumer cut-over needs V6a code-ready. `readScope` in `domain.ts` is a root handoff | The Feishu fixture Bot, the managed Codex, the real Claude Code CLI, the Linux host for lane 6 | V6a |
| V6c | `codex/v6c-run-card` | V6b branch at code-ready | Nothing | The Feishu fixture Bot, Codex, Claude | V6b |
| V6d | `codex/v6d-claude-confinement` | V6b branch at code-ready | Nothing. Disjoint from V6c | The real Claude Code CLI on the Mac, the Linux host with `bwrap` | V6b. Either order with V6c |
| V7a | `codex/v7a-acp` | `F6` for the client and translation, V6b code-ready for the engine | The provider ids and the picker need V4 merged and the root's `domain.ts` and `settings.ts` handoff | `cursor-agent` and `grok` on the Mac with user-supplied accounts, V4's web UI for lane 9, the Feishu fixture Bot | V6b |
| V7b | `codex/v7b-pi` | V6b branch at code-ready | Disjoint from V7a. The `pi` id in `toolSchema` is a root handoff | `pi` on the Mac or the Linux host, the Feishu fixture Bot | V7a |
| V7c | `codex/v7c-proofs` | V7b branch at code-ready | Nothing | A Windows host with Codex and Claude Code, the Linux host | V7b. A leaf: parked while no Windows host exists, blocks nothing |
| V8 | `codex/v8-bridge-import` | `H3`, or `main` once V3 has merged | `packages/ui/src/import/**` needs `F4` | Bridge `446b2a4` installed as a service under the dedicated test user on the Mac and on Linux, the Feishu fixture Bot, V4's web UI | V4 |
| V9 | `codex/v9-owner-notice` in `modelzen/feishu-codex-bridge` | `origin/codex/device-handoff` | Nothing. The marker name `migrated-to-vonvon-bot.json` is fixed in `architecture.md` | The signed installer URL published from V5's release, V8 merged | V8 |
| V10 | `codex/v10-accounts` | `H3`, or `main` once V3 has merged | The device repository interface, its memory and Postgres implementations, and their shared contract tests need nothing. `packages/ui/src/account/**` needs `F4` | Two daemons, a local cloud with Postgres and dev auth, the V5 shell for lane 8 | V5, for its shell. V5a if V5 splits |
| V11 | `codex/v11-relay` | `main` | `packages/client/src/e2ee/**`, its copied `base64.ts`, and its test need nothing. Everything else needs `F10`, and `transport-relay.ts` and the switcher need `F4` | V10's cloud, the V5 shell for lane 7 | V10 |

Early leaves. These may be implemented before their predecessors are accepted, because they consume only a frozen interface or nothing: V5's shell attach unit from `F4`; V5's pure service identity, codec, readback, and `service/drain.ts`, on the V5 branch now; V6a's pure core, which depends on nothing; V7a's ACP client and translation and V7b's Pi translation from `F6`; V10's device repository; V11's `e2ee/**` port. Early work is development only. None of it satisfies an acceptance box, and none of it changes the merge order.

Status reported by the root for this revision, recorded here and not established by this plan. V5's pure service identity, definition, and readback are reviewed and pushed at `51f5d1e`, with local integration at 2065 pass and 32 skip. That is neither native nor full V5 acceptance. V10's contract gap is issue 75, answered in its section below. The earlier V6 and V7, which copied Paseo's provider closure, were withdrawn on 2026-10-12 in favor of `providers.md`; their branches `codex/v6-claude-provider` and `codex/v7-providers`, issue 74, and the type-edit ledger are reference only and satisfy no box. V9's marker and delivery are pushed at `05e2635` in the bridge repository.

A branch whose development baseline is not its merge predecessor merges each predecessor in when it needs that code, and `main` once it lands. It opens its PR ready at code-ready against the newest unmerged branch it contains, or `main`, and retargets as those land, as *Spawn owners* says.

Evidence-grade gates follow the merge graph. A PR is gate-ready when every merge predecessor has merged or is itself at a frozen head. A gate-ready PR runs its frozen-head live lanes, perf, native checks, and swarm. When two PRs are gate-ready, the one with more unmerged dependents in the graph goes first, and roadmap order breaks a tie. Gates run earlier would mostly be rerun after a predecessor's merge changes the base or lockfile. Its unit tests, typecheck, lint, rehearsals, and audits of its own diff may run at any time.

*Shared files.* After V3 the root owns these and writes every change to them as a frozen handoff or at integration. Owners own the leaf files they add.

- `packages/protocol/src/index.ts`, `domain.ts`, `rpc.ts`, `events.ts`, and `handshake.ts`. This plan approves exactly these changes to existing shapes. V6b adds `readScope` to `domain.ts` `setPermission` and to `membershipSchema.permission`. V7a adds `cursor`, `grok`, and `custom-acp` to `domain.ts` `toolSchema`, which allows only `codex` and `claude` today, and `execution.customAcpCommand` to `settings.ts`. V7b adds `pi` to `toolSchema`. V8's owner writes `import.ts`, and the root adds its export and request-group registration. Any other change to an existing shape goes back to Claude Code.
- `packages/daemon/src/cli/index.ts`. One registration line per command: V4 `open`, V8 `import`, V10 `login` and `logout`. V5 adds no command, because `service` stays registered from V3, but V3's registration declares neither `install --port <P>` nor `status --json`. The root adds exactly those two options to the existing `service` registration as a V5 handoff, and changes nothing else there. Owners own `cli/commands/<name>.ts`.
- The root `package.json` and `package-lock.json`. V5 returns the desktop package's dependencies. V6b returns `@anthropic-ai/claude-agent-sdk` at exactly `0.3.246`, moved from `devDependencies` to `dependencies` of `packages/daemon`. V7a returns `@agentclientprotocol/sdk` `^0.17.1` as a `devDependency` for its types only. A worker returns the dependencies it adds. The root applies them and regenerates the lockfile with `npm install` after each integration or merge that touches it, never by hand. A lockfile change is a context change under the patch-id rule.
- `NOTICE`. Each PR appends its section, and the root resolves the merge.
- The UI feature registration file from `F4`. The root adds one entry each for V8's import flow, V10's account pages, and V11's machine switcher. After `F4`, the client owner implements those feature directories or explicitly hands off the disjoint `ui/src/import/**` or `ui/src/account/**` directory; `client-context.tsx` and the registration file stay reserved.
- `packages/daemon/src/server/http.ts`, after V4's `web-ui.ts` mount, and `server/snapshot.ts`. V3's tools probe reads the `claude-agent` backend. When V6b deletes `agent/`, the root rewrites the `createBackend('claude-agent')` lookup in `snapshot.ts` to `ProviderRuntime.list()`; the `tools` rows keep their meaning.
- `packages/daemon/src/provider/registry.ts`, which replaces `agent/index.ts` and `agent/catalog.ts` in V6b. As the explicit exception to root-written shared files, the providers owner keeps it through V6a to V7b and root integrates its changes, so no two branches edit it at once.

*Owners.* Three long-lived owners keep one module area each, so later milestones reuse what they learned. Each may split a milestone into worker partitions only along disjoint files, with root integration and the same validation order.

- Client surfaces: `packages/client/**`, `packages/ui/**`, `packages/desktop/**`, and `server/web-ui.ts`. V4, then V5, then V11's client transport and switcher.
- Providers: `packages/daemon/src/provider/**` and `outbound/**`. V6a to V6d, then V7a to V7c. After V7c, V9 in the bridge repository.
- Machine platform: V3's frozen-head gates first, then `packages/daemon/src/import/**` for V8, then `packages/cloud/**` and `packages/daemon/src/cloud/**` for V10 and V11.

*Dispatch.* The slot and wave assignments of 2026-10-11 and 2026-10-12 are retired. The order of work is the merge graph under *Dependencies* and the ready tasks on the board. Claude takes the ready task whose version is nearest the front of its chain, one PR at a time, and starts a second PR only while Codex holds the first. Bot-connected lanes stay serial across the program, and so does native service acceptance.

*Critical path.* The merge graph has three independent chains after V4; the program finishes when the slowest chain passes its own acceptance and Shipping gates. V5 needs Gate L and Gate M native acceptance, a Mac GUI session for its service tests, now `clay` under the user's override, and a dedicated Linux user with a systemd user session. V10 follows the V5 shell, then V11 follows V10. V9 follows V8 and needs the published signed installer from V5, but V10 does not wait for V9. Provider work follows V6b into V6c, V6d, and V7a independently; V7a waits for neither V6c nor V6d. Each PR runs its frozen-head evidence and Shipping gates before merging.

*After V3.*

- A verified PR waits until its merge predecessors have merged. When any merge moves its base, the root merges `main` in. An unchanged stable patch-id is necessary for the verdict to stand, but it is not sufficient. The root also confirms the new base, the dependency versions in the lockfile, and that the evidence relevant to the PR still applies in the new context. If that context changed, the root reruns the affected checks and gets a fresh independent verdict, even when the patch-id matches. If the patch-id changed, the PR gets a fresh swarm. All of this applies on top of `playbooks/shipping.md`, never in place of it. Disjoint file ownership keeps patch-ids stable, but it does not keep context unchanged.
- Known overlaps.
  - V8 and V10 both add commands, and the root writes each registration in `packages/daemon/src/cli/index.ts` as one additive line under *Shared files*. A merge conflict there changes the patch and needs a fresh swarm.
  - V7a edits the provider picker in `packages/ui/src/`, which exists only after V4. V7a's UI part therefore waits until V4 has landed and V7a has merged `main` in.
  - V5 edits the daemon's service files, and V8 uses `service/control.ts` beside them. V5 never edits `control.ts`.
- Operator action for V5 and V8, requested in wave 1 so it stays off the critical path. V5's native acceptance and V8's service lanes need the Linux test user `accept-user` on the Tencent host, which the root prepares under the user's root SSH grant per [native-acceptance-hosts.md](native-acceptance-hosts.md). V8's Mac lanes also need `test-user` in a GUI session on `clay`. On the Mac, V5's service tests may instead run in `clay` under the user's override in *Native acceptance environment*. V8's Mac lanes run as `test-user` in `gui/502`, because the protected daily bridge occupies the bridge's exact label in `clay`'s domain. Logging `test-user` into a GUI session is the only user action here. V5's service design from Claude Code is also a precondition for V5's service files, per *Service gate*.
- V10 and V9. V10 merges after V5's shell and does not wait for V9, which merges in `modelzen/feishu-codex-bridge` after V8 and the published installer. V8 does not wait for the provider chain: the importer writes the bridge's provider ids unchanged, and V6b's load-time `migrateProviderId` handles them whether V8 lands before or after V6b.
- Ready work under the revision of 2026-10-11.
  - V11, now, from `main`. The two assertions, the in-file modification notice, `closure.json`, `e2ee-closure.test.ts`, `scripts/type-only-identity.mjs`, and the root's `NOTICE` sentence, per V11's *Compiler contract*.

*Program tracking.* From 2026-10-12 the program's state lives in GitHub issues of this repository, generated from `docs/program-graph.json` by `scripts/program-graph-sync.mjs`.

- Structure. The pinned board issue #122 is the parent of one issue per version, #124 V5 to #135 V11 and #123 tooling, and of the operator issues #205 to #209. Each version issue is the parent of its task issues, one per file-disjoint partition, gate, or root handoff, and of its defect issues. `blocked by` relations carry the merge graph between versions and the dependencies between tasks. The GitHub project "Vonvon Bot v2" holds every issue.
- Board. Codex maintains pinned issue #122 with `node scripts/program-graph-sync.mjs board`; its body holds the version merge graph, a progress table, and the task dependency graph. The local progress page TOOL-1 (#203) and its refresh schedule stopped on 2026-10-13; Codex closes #203 with that reason. No other tracking surface exists.
- State. A task issue is open or closed. Codex adds `state:in-progress` when a worker takes a task and closes the issue when the partition is integrated and its tests pass. A version issue carries at most one of `state:code-ready`, `state:frozen`, and `state:verified`, and closes when the PR merges. Codex changes these labels at the four transitions. A defect found mid-task gets a new issue under its version and the `version:<id>` label.
- Changing the graph. A new partition, a changed dependency, or a split such as V5a and V5b is an edit to `docs/program-graph.json` followed by `node scripts/program-graph-sync.mjs sync`. The sync is idempotent: it creates missing issues, updates titles and bodies, adds links and labels, and deletes nothing. Codex may add tasks and task dependencies that change no architecture, data shape, or merge edge. A change to a merge edge goes back to Claude Code with the plan.
- Assignment at this revision, 2026-10-13. Claude takes over `codex/v6a-provider-core` (#117) as the first in-flight PR and drives it to handoff, folding the open design notes of #121 and #223 into it or closing them. The second slot is the V5 split: `codex/v5-desktop` (#110) is cut into task-partition PRs that each fit the size limit, starting with the partition that unblocks V10. Codex verifies #117 while Claude cuts V5. Operator items OP-2 to OP-5 stay off the critical path.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.
- [ ] Add the line `Mac window check: pending` to the body of every PR that changes what a window or page shows. The Mac agent replaces it with what it saw.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, apply the merge-front scheduling rule under *Dependencies*: component tests and independent diff audits run immediately, and the full evidence-grade swarm runs when the PR is gate-ready under *Dependencies*. Run that swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] A clean verdict marks the PR verified, with the `state:verified` label on its issue under *Program tracking*. Codex runs guarded Shipping on every verified PR whose merge predecessors have landed, predecessors first within a chain. A verdict stays valid across a merge-sync only when the stable patch-id of base to head is unchanged under the patch-id rule in `playbooks/shipping.md`, and the new base, dependency versions, and relevant evidence are confirmed unchanged in effect. If that context changed, the affected checks rerun and a fresh independent verdict is required.
- [ ] Merge only when the GitHub-hosted Linux job succeeded at the exact head being merged, and for a `full` change the hosted Windows job and the self-hosted Mac job succeeded at that head, per *CI policy*. A docs-only run is recorded as lightweight, never as a full-suite pass.

### CI policy

CI maintenance does not change the merge graph, product architecture, unit, live, perf, native, independent audit, or Shipping requirements. CI does not replace a real desktop, launchd, or systemd acceptance check.

*Runners.* The `linux` job uses GitHub-hosted `ubuntu-latest`. The `windows` job uses GitHub-hosted `windows-2025`. The `macos` job uses the shared organization runner labelled `self-hosted`, `macOS`, `ARM64`, `modelzen-macos`, and `modelzen-macos-isolated`. Full changes run all three platforms. Notelet is a macOS app and keeps Linux repository checks plus its self-hosted Mac build. The original Windows native job remains in the legacy desktop branch workflow; its desktop packaging and native UI checks are separate from this main-workflow chain. The organization runner group permits only `modelzen/vonvon-bot` and `modelzen/notelet`. One Mac runner runs one job at a time. Setup and service commands are in [self-hosted-ci.md](self-hosted-ci.md). Pricing and trigger examples are in [ci-costs.md](ci-costs.md).

*Triggers.* From the revision of 2026-10-12, the full three-platform run happens once per frozen head, not once per push. `.github/workflows/ci.yml` runs for PRs targeting `main` on `opened`, `synchronize`, `reopened`, and `labeled`, and by `workflow_dispatch`. Every PR event runs the classifier and the `docs` checks. The `full` Linux, Windows, and Mac chain runs only when the PR carries the `frozen` label, or on `workflow_dispatch`. The root adds `frozen` when it freezes a head, removes it before pushing a patch that changes the head, and adds it again at the next freeze. Before the freeze, workers run targeted tests locally, the root runs the clean chain at integration, and a Linux chain may run on the JP-VPS over SSH; none of those is a GitHub check. Codex implements the workflow change as TOOL-2 (#204). Until it lands, the root may skip pushes between freezes but must not merge without the frozen head's run. The workflow has no path filter, branch-push trigger, or schedule. PR checks validate the proposed merge; repeating the same suite after that merge adds no platform coverage. Use a manual full run for an exceptional direct commit, a retargeted PR, or a changed base when no current run exists. A newer PR run cancels the old one. Manual runs retain separate records.

*Scope.* `.github/scripts/ci-scope.mjs` is the only classifier. It uses full Git history and `git diff --name-only --no-renames -z`. A PR compares the merge-base of the event base and head with the head. It reports `docs` only when every path is root `README.md`, `AGENTS.md`, `CLAUDE.md`, or `docs/**/*.md`. Everything else is `full`. Manual dispatch, unknown events, missing SHAs, empty, malformed, oversized or ambiguous differences select `full`. Git collection failure cannot authorize a lightweight pass.

*Linux job.* The job first runs the classifier's regression tests and collects the scope with the runner's bundled Node. A `docs` change runs `git diff --check`, without setting up Node, restoring npm cache, installing dependencies, or running product tests. A `full` change sets up Node 22 and npm cache, then runs `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`, stopping on the first failure. The daemon's former `lint` script repeated `tsc --noEmit`; daemon type checking now runs once through `typecheck`. Protocol lint remains in `npm run lint`.

*Windows job.* After Linux succeeds with `full` scope, `Windows checks` checks out the exact PR head, or the dispatched commit, without persistent Git credentials. It runs the same Node 22 install, build, typecheck, test and lint chain on `windows-2025`, then records the source SHA, runner, Windows, architecture and Node version. Documentation changes skip this job. Windows service and native UI acceptance remains separate.

*Mac job.* The job requires `ENABLE_SELF_HOSTED_MACOS_CI=true` in repository Actions variables. Both repositories now set it to `true`. The shared runner uses the dedicated standard `ci-user` account without release credentials. Its LaunchAgent inherits the logged-in GUI session, and the account cannot traverse the daily user home. After a reboot, log into `ci-user` once and keep that session open in the background, as described in the service guide. Fork PRs are excluded, and the job checks the account before checkout. Linux checks continue independently. After full Linux checks succeed, the self-hosted Mac checks out the exact PR head, or the dispatched commit, and runs the same clean Node 22 chain. It records the source SHA, runner, macOS, architecture and Node version in the job summary. Documentation changes skip this job. A successful self-hosted job supplies the routine Mac check, so the operator does not rerun an identical manual Mac chain. Native, interactive and platform-specific acceptance from each milestone remains separate.

*Merge rule.* The merge owner requires the current Linux result, plus both Windows and Mac results for a `full` change. Record a documentation run as lightweight and its skipped Windows and Mac jobs as not applicable. If Mac CI is paused again, full changes retain Mac verification as pending, not passed. A billing failure, unavailable runner, timeout or absent run is blocked, never passed. Branch protection stays enabled. A manual local chain may help diagnose a blocked job but is not a successful GitHub check.

*Evidence.* Each PR records the exact head, changed paths, scope and Linux run URL. Full changes also record both the hosted Windows and self-hosted Mac results and tested platforms. CI maintenance requires actionlint, the scope regressions, the full chains, and independent review before merge. It does not require unrelated Bot live or perf lanes. New source heads require new evidence. No subscription, spending limit, product-release signing or notarization changes are part of this policy.

*Temporary CI waiver, 2026-10-10, withdrawn.* While the organization's Actions minutes were exhausted, the operator authorized pushes and merges without GitHub results, recorded as `SKIPPED, operator authorization` and never as PASS, with a local Mac clean chain as required evidence. `main` at `48251d9` restored the full Linux, hosted Windows, and self-hosted Mac CI, and the operator withdrew the waiver. The merge rule above applies in full to every unmerged head. Records made under the waiver keep their `SKIPPED` wording. They are not converted to passes and do not count for any head merged from now on.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill path or exact commands recorded in this boot recipe.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `npm ci` and `npm run build` from the repository root. Export `VONVON_HOME=$(mktemp -d)` so no lane touches a real home. From V3 on, start the daemon with `node packages/daemon/bin/vonvon.mjs daemon start --port 0` and wait until `vonvon daemon status --json` reports a `listen` address.
- [ ] Deliver input only through the driver skill's commands. Before V4, run the `vonvon` CLI from the shell and drive the daemon's WebSocket through `packages/client`. From V4 on, use the repository `verify` skill. It drives the web UI in Playwright Chromium (`npx playwright install chromium` once) and the Electron shell in a real macOS window through Playwright's `_electron` launcher. Feishu lanes use an isolated `VONVON_HOME` fixture from existing bridge data as specified in V2. Read-only diagnostics are `vonvon daemon status --json`, `$VONVON_HOME/logs/`, and `vonvon daemon logs --tail 200`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. A CLI lane saves its terminal transcript as `<slug>.txt` in the same folder.

## Build the monorepo and the protocol package (V1)

**Depends on.** None.

**Files.**

- [ ] Create `package.json` with npm workspaces `packages/*`, plus `tsconfig.base.json` and `vitest.config.ts`.
- [ ] Create `packages/protocol/src/domain.ts`, `rpc.ts`, `events.ts`, `handshake.ts`, and `index.ts`.
- [ ] Create `packages/protocol/test/protocol.test.ts`.
- [ ] Create `.github/workflows/ci.yml`. V1 shipped it with automatic `ubuntu-latest` and `macos-latest` jobs; *CI policy* now replaces them with a GitHub-hosted Linux job, a hosted Windows job, and a gated self-hosted Mac job.
- [ ] Create `NOTICE`.
- [ ] Edit `README.md`.

**Build.**

- [ ] Port the zod schemas from `desktop/shared/bridge.ts`, `settings.ts`, `collaboration.ts`, `environment.ts`, `machine.ts`, and `watch.ts` at `origin/codex/device-handoff` into `packages/protocol`. Leave out `quit`, `hideWindow`, `setLoginItem`, and `chooseFolder`.
- [ ] Add the branded `MachineId`, the `hello` and `serverInfo` handshake schemas, and `PROTOCOL_VERSION` in `handshake.ts`.
- [ ] Add the request, response, and event envelopes in `rpc.ts` and `events.ts`.

**You see.**

- [ ] `npm ci && npm run typecheck && npm test` passes on the Mac, and hosted CI succeeds at the PR head. History: V1 was accepted with both its hosted Linux and hosted macOS jobs green. Later PRs gate on hosted Linux plus, for a `full` change, hosted Windows and the self-hosted Mac job, per *CI policy*.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/protocol/test/protocol.test.ts` parses `tests/fixtures/agent-settings.json` from `origin/codex/device-handoff`, rejects a `bindGroup` with a `/` in the project name, and rejects a `hello` without `protocolVersion`. Run `npm test -w packages/protocol`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk `main` has no package code, so record that and gate a clean `npm ci && npm run build` at head. Save `build.txt`. Pass when the build exits 0 and `packages/protocol/dist/index.js` exists.
- [ ] Lane 2. Import the built package from a scratch Node script and parse every command variant from a generated sample list. Save `commands.txt`. Pass when every variant parses and the four desktop-only commands are absent.
- [ ] Lane 3. Feed a real bridge `projects.json` shape from `origin/codex/device-handoff` fixtures into the project schema. Save `projects.txt`. Pass when it parses with no unknown-key error.
- [ ] Lane 4. Feed a `hello` with a newer `protocolVersion`. Save `hello-newer.txt`. Pass when the schema accepts it and exposes the version for negotiation.
- [ ] Lane 5. Feed a `hello` with a missing `clientKind`. Save `hello-bad.txt`. Pass when parsing fails with a path that names `clientKind`.
- [ ] Lane 6. Round-trip a settings view for each of the four scopes through `JSON.stringify` and parse. Save `scopes.txt`. Pass when every scope parses back equal.
- [ ] Lane 7. Parse a `MachineId` built from a random UUID and from an empty string. Save `machine-id.txt`. Pass when the UUID parses and the empty string fails.
- [ ] Lane 8. Run `npm run typecheck` with `strict` on. Save `typecheck.txt`. Pass when it exits 0 with no `any` in exported types, checked by `grep -n ": any" packages/protocol/src`.
- [ ] Lane 9. Read the hosted CI for the PR head with `gh run view`. Save `ci.txt` with the head SHA and each hosted job's result. Pass when every hosted job succeeded at the head. History: V1 ran both its Linux and macOS jobs and both were green.
- [ ] Lane 10. Check `NOTICE` names feishu-codex-bridge (MIT) and Paseo (Apache-2.0). Save `notice.txt`. Pass when both names and licenses appear.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `npm test -w packages/protocol` and the parse time of one full settings snapshot. Trunk has no package, so the diff-added work has an absolute budget.
- [ ] Probe. Run `hyperfine -w 2 -r 10 'npm test -w packages/protocol'` and a 1000-iteration parse loop at head.
- [ ] Baseline. Record that trunk `main` has no test suite and no parse path.
- [ ] Rule. Fail if the test suite takes more than 10 s or one snapshot parse takes more than 2 ms on the Mac.

**Review gate.** V1 needs the independent verdict and exact-head Shipping check; no personal UI review is prescribed.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V1 only after the exact-head independent Shipping verdict is clean.

## Copy the bot runtime into the daemon package (V2)

**Depends on.** V1.

**Files.**

- [ ] Create `scripts/import-core.mjs`.
- [ ] Create `packages/daemon/` with the full copied `src/**`, including `src/web/**`, the full `test/**`, and `PROVENANCE.md`. V3 removes `src/web` after RPC parity.
- [ ] Create `packages/daemon/bin/vonvon.mjs`.
- [ ] Edit `packages/daemon/src/config/paths.ts` and `packages/daemon/src/config/keystore.ts`.

**Build.**

- [ ] `scripts/import-core.mjs` takes the path of a feishu-codex-bridge checkout, copies all of `src/` and `test/` at `446b2a4` into `packages/daemon`, and writes the source SHA into `PROVENANCE.md`. Keep `src/web` temporarily for V2 startup and V3 HTTP comparison. Rerunning the script on a clean tree gives the same bytes.
- [ ] Point `appDir` in `paths.ts` at `VONVON_HOME`, defaulting to `~/.vonvon-bot`.
- [ ] Replace the hostname-derived key in `keystore.ts` with a random key in `$VONVON_HOME/master.key`, mode 0600.
- [ ] Rename the CLI entry to `vonvon` in `bin/vonvon.mjs` and keep `vonvon daemon run` as the foreground runner.

**You see.**

- [ ] `VONVON_HOME=$(mktemp -d) node packages/daemon/bin/vonvon.mjs daemon run` starts, logs the supervisor ready line, and creates no file outside `VONVON_HOME`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The copied suite matches or improves the measured `446b2a4` baseline. Run `npm test -w packages/daemon` and compare with 153 test files, 152 passing and one intentionally skipped, plus 1683 passing cases and 15 intentionally skipped cases. Record every skip; skipped provider live tests do not count toward live verification.
- [ ] `packages/daemon/test/data-root.test.ts` gains a case that `VONVON_HOME` wins and that nothing is written under `~/.feishu-codex-bridge`.
- [ ] Add `packages/daemon/test/keystore.test.ts`, which does not exist in the source tree. Test that a renamed host still decrypts. Run `npm test -w packages/daemon -- keystore`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Prepare the V2 Feishu fixture from existing bridge data under an isolated `VONVON_HOME`. Prefer a saved inactive Bot; validate its credentials before connecting. Read its old secret with the bridge keystore and register the plaintext in the new isolated keystore, without copying old ciphertext under the new random `master.key`. This is test setup, not the V8 production importer. Preserve the original bridge data and both active Bot connections. Create a private test group containing only the operator and the selected Bot. Run all Bot-connected lanes serially, with baseline and daemon never connected to that Bot at the same time. Keep credentials out of reports.
- [ ] Lane 1. Regression lane against trunk. Run the bridge at `446b2a4` with `node bin/feishu-codex-bridge.mjs run` and the daemon at head with `vonvon daemon run` in separate, serial turns on the fixture Bot. Save `startup.txt`. Pass when each reaches the bot connected log line.
- [ ] Lane 2. Send a DM to the test bot and open the DM menu card. Save `dm-menu.txt`. Pass when the daemon log shows the card sent and the Feishu API returns success.
- [ ] Lane 3. Bind a test group to a temp folder through the DM card flow. Save `bind.txt`. Pass when `$VONVON_HOME/bots/<appId>/projects.json` lists the group.
- [ ] Lane 4. Mention the bot in the test group with `pwd`. Save `codex-turn.txt`. Pass when the run card finishes and its text contains the temp folder path.
- [ ] Lane 5. Kill the codex app-server child mid-turn. Save `codex-crash.txt`. Pass when the run card shows an error and the next mention succeeds.
- [ ] Lane 6. Start a second `vonvon daemon run` against the same `VONVON_HOME`. Save `second-instance.txt`. Pass when the second process exits with the single-instance error.
- [ ] Lane 7. Run the daemon with `HOME` and `VONVON_HOME` both set to fresh temp folders, then list what exists under each. Save `paths.txt`. Pass when `$HOME/.feishu-codex-bridge` does not exist and every new file is under `VONVON_HOME`.
- [ ] Lane 8. Register the fixture Bot secret in the isolated keystore, then restart the daemon with `node --require` of a shim that makes `os.hostname()` return a different name. Save `rename.txt`. Pass when the bot reconnects.
- [ ] Lane 9. Run `node scripts/import-core.mjs` twice on a clean tree. Save `import-core.txt`. Pass when `git status --porcelain` is empty after the second run.
- [ ] Lane 10. Send SIGTERM to the supervisor. Save `shutdown.txt`. Pass when every child exits within 10 s and the lock files are gone.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from process start to the bot connected log line, and supervisor plus child RSS after 60 s idle with one bot.
- [ ] Probe. Interleave five serial runs of the bridge at `446b2a4` and five of the daemon at head. Time from process start to the connected log line. After each reaches a 60 s idle window, use macOS `ps` to sum supervisor and child process-tree RSS in KiB. Never keep both clients connected to the same Bot.
- [ ] Baseline. Record the bridge numbers first.
- [ ] Rule. Fail if the median start time is more than 10% slower or the RSS is more than 10% higher than the bridge.

**Review gate.** V2 needs the independent verdict and exact-head Shipping check; no personal UI review is prescribed.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V2 only after the exact-head independent Shipping verdict is clean.

## Serve the daemon API over WebSocket (V3)

**Depends on.** V2.

**Files.**

- [ ] Create `packages/daemon/src/server/http.ts`, `ws.ts`, `local-credential.ts`, `pid-lock.ts`, `atomic-file.ts`, `directory-browser.ts`, `snapshot.ts`, `jobs.ts`, and `logs.ts`, the log follower in *Events*.
- [ ] Edit `packages/daemon/src/host/lifecycle.ts`, `host/restart.ts`, `host/bootstrap.ts`, `src/cli/index.ts`, `cli/commands/run.ts`, `bot/supervisor.ts`, `server/owner-verification.ts`, `server/rpc/machine.ts`, `server/rpc/command.ts`, and `service/update.ts` for *Lifecycle ownership*. The new `server/ws.ts` and `http.ts` carry its drain control.
- [ ] Edit `packages/daemon/src/cli/commands/service.ts`, and `host/service.ts` if any V3 path reaches it, so that V3's service commands refuse, per *Lifecycle ownership*. V3 leaves `service/launchd.ts`, `systemd.ts`, `win-startup.ts`, `adapter.ts`, `common.ts`, and `control.ts` unchanged. V5 owns the Vonvon service identity, and `service/control.ts` stays the legacy-bridge control for V8.
- [ ] Edit `packages/daemon/src/agent/codex-appserver/owned-process.ts`, `windows-job.ts`, `app-server-client.ts`, `client-pool.ts`, `backend.ts`, and `managed-install.ts`, and `bot/handle-message.ts` and `bot/bridge.ts`, for *Provider processes* in *Lifecycle ownership*. `run.ts`, `bot/supervisor.ts`, `host/lifecycle.ts`, and `host/bootstrap.ts` carry its runner side.
- [ ] Create `packages/daemon/src/server/rpc/` with one handler file per protocol request group.
- [ ] Create `packages/protocol/src/admin.ts` and `directory.ts`. Edit `domain.ts`, `environment.ts`, `handshake.ts`, `rpc.ts`, `events.ts`, `index.ts`, and `packages/protocol/test/protocol.test.ts` for the contract below.
- [ ] Create `packages/client/package.json`, `packages/client/src/client.ts`, and `transport-local.ts`. This is the minimal local client the V3 lanes drive. V4 extends it.
- [ ] Edit `packages/daemon/src/cli/commands/daemon.ts`.
- [ ] Edit the copied backend installer that defines `installBackendDep`, for the output decoding and the serialized mutations in *Jobs*, and `admin/service.ts` `uninstallBackend`, whose precheck moves into the queue. `server/jobs.ts` and `server/rpc/environment.ts` reserve queue turns at admission. Edit `agent/backend-loader.ts` and `agent/index.ts` for the presence checks of issue #48.
- [ ] Edit the `src/web` callers and tests that *Deleting `src/web`* lists: `daemon-control.ts`, `run.ts`, `bot/supervisor.ts`, `bot/dm-console.ts`, `bot/handle-message.ts`, `card/dm-cards.ts`, and the named test files.
- [ ] Delete `packages/daemon/src/web/` and `packages/daemon/src/cli/commands/web.ts`, the read-only preview entry. The V2 `vonvon` CLI registers no `web` command, so no command disappears.

**Contract.** Codex implements these shapes as written. A change to them goes back to Claude Code. Appendix B records the rejected alternatives.

The snapshot stays the V1 `DesktopSnapshot` for the future UI. The old administrative state gets its own lossless reply, `admin` `state`. Sessions are read separately through the existing `settings` `sessions` request.

*Transport and handshake.*

- The daemon listens on `127.0.0.1` only, on `--port` (0 picks a free port). It refuses an upgrade whose `Host` or `Origin` is not loopback, as the old console did. It does not negotiate permessage-deflate.
- `$VONVON_HOME/local-credential` holds 32 random bytes in hex, mode 0600. The daemon creates it on first start and keeps it across restarts.
- The first client frame is `hello`. `hello` gains an optional `credential` string, and the local transport always sends it. If the credential is missing or wrong under a constant-time compare, if another frame comes first, or if no `hello` arrives within 5 s, the daemon closes the socket with code 4401 and reason `unauthorized`. A good `hello` gets `serverInfo`.
- `vonvon daemon start` spawns a detached `vonvon daemon run --port <n>` and returns once it listens. It installs no OS service, and V3's `vonvon service` commands refuse, per *Lifecycle ownership*. `stop` asks the verified owner to stop with `machine` `stopHost` and waits until it releases the lock, per *Lifecycle ownership*. `status --json` prints `{running, pid?, listen?, version?, startedAt?}`, with `listen` as `127.0.0.1:<port>`. The pid lock `$VONVON_HOME/daemon.pid` records `pid`, `startedAt`, and `listen`.
- `restartHost` and `applyCoreUpdate` restart in place on the same port, per *Lifecycle ownership*. The daemon spawns a detached helper, then drains and shuts down. The helper waits for the lock to clear, with no deadline, and starts the daemon on the same port.

*Lifecycle ownership.* This defines how the V3 daemon stops and restarts, and what V3 does with OS service commands. It changes no protocol or wire shape, and no pid-lock, `status --json`, `update-status.json`, or `VONVON_HOME` storage shape. Appendix B records the rejected alternatives.

- Evidence. V3 makes this lifecycle reachable for the first time. It does not port a V2 path that worked. The V2 console declared stop and restart service callbacks, and a service-aware `__daemon-control` helper exists in the copied source. But the running daemon in V2 as merged did not inject those callbacks, so its `POST /api/daemon/stop` and `POST /api/daemon/restart` answered 501. PR #24 and its old tests recorded that 501. V2 as merged is squash `e4ff7fe` on `main`, whose tree is identical to the reviewed V2 head `baf3cee`. `9bacf624` is not an ancestor of `main`. The helper's existence is not evidence of earlier working behavior.
- Reproduction. Root reproduced the gaps at `b1a664a` with the actual packaged CLI, under controlled conditions. A live owner process stood in for a retained drain, not a real slow npm. A fake auto-relaunch manager stood in for launchd and systemd, and it is not a native service proof. The hidden restart helper exited 1 at 30,318 ms while the controlled owner was still alive, and after the owner released the lock, status reported `running: false`. `vonvon daemon stop` exited 0 and printed `stopped` while the fake manager's replacement was running. `restartHost` replied `applied`, and then the delayed helper exited 0 while the manager's replacement won the lock, moving the port from 53767 to 53770. An explicit `vonvon daemon start --port 53767` also accepted the daemon on 53770. Every owned process, lock, and temporary root was cleaned up, and the original bridge process was not touched. Nobody has observed npm corruption for the installer race or memory exhaustion for the log follower.

- Scope. V3 installs no OS service. Every V3 host daemon is self-hosted: `vonvon daemon start` or a foreground `vonvon daemon run` starts it, and nothing relaunches it. V5 owns the Vonvon service, under *Service gate* in V5. This is the smaller and safer choice for four reasons.
  - The V3 plan never required a native service, and V5 already owns **Open at login**.
  - At the V3 source head `b1a664a`, the daemon's service adapters still reuse the bridge identity, `ai.feishu-codex-bridge.bot`, `feishu-codex-bridge.service`, and the `feishu-codex-bridge` Run value, and their `uninstall` calls `stopInstallation`. Any V3 path that ran them could overwrite or remove the protected original bridge's registration.
  - Service semantics would bring install and uninstall transactions, protection against another data root's registration, a manager-driven restart, and a native gate into V3.
  - That native gate needs a dedicated OS test user, and none was available when V3 was planned. At that time the operator's account was the only one on the Mac with a GUI session, and no Linux instance with a systemd user session was running. The current availability is in *Native acceptance environment* under V5.
- Service commands fail closed. `vonvon service install` and `vonvon service uninstall` stay registered, so the refusal is explicit. Each prints `Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.` to stderr and exits 1. It refuses before it loads the service adapter. It writes no file, reads or writes no registry value, and runs no `launchctl`, `systemctl`, `schtasks`, or `reg`.
  - The same refusal covers every other daemon path that would reach the adapter's `install`, `restart`, or `uninstall`: `controlDesktopService` in `host/service.ts`, the `__daemon-control` actions in `daemon-control.ts`, and `restartDaemon` in `service/update.ts`. Each one is either removed, when nothing reaches it, or refuses with that message.
  - The hidden `__win-relaunch` entry is one of these paths. It refuses with the same message and exit 1 before it imports any service adapter module, on every platform. It loads no adapter, spawns nothing, and touches no file or registry value.
  - `admin` `daemonStatus` keeps reporting `installed: false` and `supported: false`.
  - The adapter files keep the bridge identity, and no V3 path calls them. `service/control.ts` stays the legacy-bridge control that V8 uses, with its bridge names and `stopInstallation`, and no V3 path calls it either.
  - V3 neither detects nor removes a registration that V2's `vonvon service install` may have written under the bridge identity.
- One owner per data root. The host mutex and `daemon.pid` keep one host daemon per data root, as today. A Bot child of the supervisor (`daemon run --bot`) is owned by its supervisor, as in V2.
- Drain. A stop or restart request does not shorten the drain. The daemon stops admitting work, then awaits every accepted request, job abort and settlement, queued installer mutation, and Bot child stop, as it does today. No timer releases `daemon.pid` or the host mutex early, and no accepted request is cut to fit a deadline.
- Owned work and cleanup errors are separate outcomes. Owned work is every Bot child, every npm child of the installer, and every Codex app-server that a daemon process spawned through `OwnedCodexProcess`, with its process group or Windows Job. Its end is confirmed only by an observed exit: the child's `exit` or `close` event, or `ESRCH` for a process group. A provider needs both its direct `exit` and the end of its group or Job, per *Provider processes* below. The restart helper is meant to outlive the daemon, so it counts as owned work only after a stop cancels the restart, under *Stop wins* below.
  - Confirmed, with or without errors. A child that needed forced termination or exited non-zero, and a socket, snapshot, or service close that failed, are cleanup errors. The daemon logs each one as `daemon-shutdown` with its reason. Once every owned exit is observed, it releases the lock, then exits 1 if there was a cleanup error and 0 if not.
  - Unconfirmed. When an owned exit is not observed, for example when `stopChild` throws `has not exited after forced termination` or a process group still exists, the daemon keeps `daemon.pid` and the host mutex. It logs `daemon-shutdown` `owned_work_unconfirmed` with each `pid` and checks again every second. It releases only after every exit is observed, then exits 1. No timer turns an unconfirmed exit into a release.
  - Today `runHostRuntime` releases the lock in `finally` whatever `runRun` threw. V3 makes that release follow these rules.
  - If the operator kills a daemon that is waiting on unconfirmed work, its lock goes stale and the next start replaces it, as lane 4 does. A surviving Bot child still holds its per-Bot single-instance lock, so no second connection to that Bot starts.
  - So when `vonvon daemon stop` exits 0, it proves three things: the owner accepted the stop, it released ownership, and its owned work was observed to end. It does not prove that cleanup had no errors. The daemon's log records those.
  - An owner that dies after accepting the stop but still named by `daemon.pid` did not release, so stop cannot prove the second and third points. That happens after `listener_close_unconfirmed` and after an abnormal kill, including one during `owned_work_unconfirmed`. `vonvon daemon stop` then exits 1 with the cleanup-unconfirmed error under *Stop*, never 0.
- Provider processes, issue #50.
  - Evidence. At local feature `a00d993` the root ran the actual `OwnedCodexProcess` and `createOrchestrator` with a `ChildProcess` event shell, an intercepted `process.kill`, and a thread injected into the existing message-queue fixture. No provider, Bot, or OS signal ran. One diagnostic passed and two regressions failed. After SIGTERM then SIGKILL, `OwnedCodexProcess.close` rejected at 6 simulated seconds while the group still existed, and it cached that rejection. A repeated close returned the same rejected Promise even after the group disappeared and `exit` and `close` fired. The orchestrator's `shutdown` cleared its sessions, dropped the rejection through `Promise.allSettled`, and resolved while the real owned group was live. From source only: `AppServerClient.close` caches its own Promise and forwards to `owned.close`, the Codex thread's `close` forwards to the client, and `startBridge`'s `shutdown` sets `closed` before awaiting, so a retry returns at once. L's runner ordering cannot recover a death that these layers already swallowed.
  - Further source inventory, not run. Some provider processes are held by no session at shutdown. The idle reaper, chat eviction, and the adopt-failure and goal-turn closes remove a thread from `sessions` and discard its close result. The utility client and warm pool in `client-pool.ts` are never closed by the Bot's shutdown, only by a process `exit` hook that sends SIGKILL to the leader pid and confirms nothing. The title job's client closes in a `finally`. `createOrchestrator` prewarms the model list before `startBridge` connects, so a failed `startBridge` can already own a provider, and `runSingle` releases the per-Bot lock in that `catch`.
  - Birth. An `OwnedCodexProcess` whose spawn returned a `pid` is born, and it joins a registry in `owned-process.ts` for its own process. If `pid` is undefined, the spawn failed and no child exists. The instance never joins, `close` resolves, nothing is signaled, and the caller sees the spawn error as today. On Windows the Job directory is disposed.
  - `exited`. It fulfills only on an actual `exit` event, with the code and signal. It no longer fulfills with an error result, so its type has no error variant. A birthless instance's `exited` rejects promptly with the original spawn error. The instance attaches its own internal rejection observer, because `AppServerClient` never consumes `exited` and the rejection must not surface as unhandled. A generic `error` after birth leaves `exited` pending. It records a cleanup error, and `AppServerClient` fails every pending and later RPC request on that unusable process, without a cast.
    - `runSetupChild` in `managed-install.ts` keeps its race of `exited` against abort and its 300-second timer. A birthless spawn therefore rejects with the original spawn error at once, not at the timer. P removes the branch that read an error result from `exited`, because that result no longer exists. A post-birth `error` reaches the caller only through the existing `close` and its `CodexProcessCleanupError`. Nothing else in `managed-install.ts` changes.
  - Death. On POSIX, a provider is dead once its direct child's `exit` event has been observed and `process.kill(-pid, 0)` throws `ESRCH`. `EPERM` counts as still existing. On Windows, it is dead once the Job host's `exit` has been observed and the Job proof file verifies empty. A host that exits without that proof stays unconfirmed, because the daemon cannot query that Job again. It is retained like any other unconfirmed work. An `error` event after birth is not death but a cleanup error.
  - Close. `close()` returns one cached Promise per instance, and that Promise stays pending until death. It sends SIGTERM to the group, waits the grace, then sends SIGKILL, as today. If the group still exists when the SIGKILL wait ends, the instance becomes unconfirmed. It checks again every second and sends SIGKILL to the group again while the group exists. After death, `close` resolves if there was no cleanup error. Otherwise it rejects with `CodexProcessCleanupError`, which lists the errors. Cleanup errors are: SIGKILL was needed, an `error` event after birth, a signal that failed with anything other than `ESRCH`, and pipes still open 500 ms after death, which means some escaped process holds them. A rejection always follows death, so caching it is safe. Repeated and concurrent closes all get the same Promise. `AppServerClient.close` and the thread's `close` keep forwarding and caching, so they inherit this contract.
  - Signals. An instance signals only `-pid` of the group it leads, and only while its direct `exit` is unobserved or its last probe found the group. It never signals a pid read from a file, a log, or IPC. A descendant that leaves the group with `setsid` is outside what V3 observes, as before. If it still holds the pipes, that shows up as a cleanup error.
    - Best effort. Numeric group targeting is best effort wherever V3 cannot prove that the group still has the same generation, and V3 has no OS handle for a group's generation. A process group ID cannot be reused while its group exists, but a probe that finds the number does not prove that the same group persisted since the previous probe or since spawn. Reaping the direct child and running the instance's `exit` listener are distinct events, so V3 does not claim that a signal sent before the observed `exit` reaches the original group either.
    - ESRCH latch. The first `ESRCH` for its group latches death of the group in the instance, permanently. After it the instance never probes or signals that number again, even if a later probe would succeed. This latch is the only signal exclusion that V3 guarantees.
    - Limit, accepted for V3. A normal shutdown can run this sequence: the direct `exit` is observed, a probe finds the descendant group, its last member exits, an unrelated new group takes the same number, and the next probe succeeds. The next SIGTERM or SIGKILL then reaches that unrelated group, and no `ESRCH` was observed in between. A probe just before each signal narrows the interval but cannot remove it. The same reuse can make the death check count the unrelated group as the provider's, which keeps the instance unconfirmed and the locks held while that group lasts. That half fails closed.
    - Decision. V3 keeps the numeric group ID, the signal and close policy above, and this limit. Closing it would need a per-process OS handle that Node does not expose, and V3 adds no such mechanism. It needs the number to be freed and reassigned to a new group during a normal shutdown. So V3 claims only that no probe or signal follows an observed `ESRCH`. It does not claim that any group signal reaches the original group. The PR states this limit. It is separate from the abnormal-exit limit under *Limits*.
  - Registry. A thin module-level Set of born instances that have not died. Each instance keeps its own death state, including the `ESRCH` latch. The registry has two internal functions, frozen at the handoff, with no wire or storage shape. It has no reset function, and none is added for tests. A test that needs births after a terminal `closeOwnedCodexProcesses` imports a fresh module graph instead.
    - `closeOwnedCodexProcesses(): Promise<void>`. The first call stops new births: a later constructor throws before it spawns, and callers already handle spawn errors. It closes every registered instance, joining any close that already began elsewhere, and waits until the registry is empty. It then resolves, or rejects with an `AggregateError` of the cleanup errors of the instances it waited on. Every call returns the same Promise. An instance that settled before the first call was a runtime event, and its caller logged it.
    - `unconfirmedCodexPids(): number[]` lists the instances that are past their SIGKILL wait without confirmed death.
  - Orchestrator and bridge. The orchestrator's `shutdown` caches one Promise. It closes the live sessions, awaits the run tasks, stops the warm pool and utility client through `shutdownResidentClients`, and awaits `closeOwnedCodexProcesses`. Only after the registry is empty does it settle. It then rejects with every close rejection plus the registry's aggregate, or resolves if there were none. `startBridge`'s `shutdown` replaces the `closed` flag with one cached Promise. It awaits the orchestrator, then the CLI bridge and the channel disconnect as today, and rejects with the aggregate.
    - Startup failure. `startBridge` defines that cached shutdown before it starts connecting. If startup then throws, `startBridge` joins the same cached shutdown before it rejects, so accepted orchestrator work drains and the orchestrator settles under the rule above. It rejects with the original startup error when cleanup had no error. Otherwise it rejects with an `AggregateError` whose errors are the original startup error first, then every cleanup error. No new export or parameter is added, and `BridgeHandle.shutdown` keeps its signature. The `client-pool.ts` exit hook may stay as a best effort at crash time. It signals only registered instances whose death is unconfirmed, confirms nothing, and plays no part in this rule.
  - Callers. Every runtime close may log a rejection and continue, because a rejection comes only after death. The registry holds ownership, not the caller. The runtime closes are the idle reaper, chat eviction on a settings or backend switch, the adopt-failure close in `launchRun` and `launchGoalRun`, the goal-turn close, run abort, utility discard, the warm pool's stale disposal, and the title job. Restart, `applyCoreUpdate`, and stop all reach the same cached shutdown. So do the managed Bot child (`daemon run --bot`) and runs started with `managed`. The PR lists every caller of `OwnedCodexProcess.close`, `AppServerClient.close`, the thread's `close`, `shutdownResidentClients`, the orchestrator's `shutdown`, `BridgeHandle.shutdown`, and `closeOwnedCodexProcesses`, with the path each one now takes.
  - Inline runner. `runSingle` awaits `handle.shutdown()` and then `closeOwnedCodexProcesses()` before it releases the per-Bot lock. It awaits `closeOwnedCodexProcesses()` there too when `startBridge` threw. The host runtime then applies the release rules above. While `unconfirmedCodexPids()` is not empty, a standalone host logs `daemon-shutdown` `owned_work_unconfirmed` with each pid every second and keeps the per-Bot lock, `daemon.pid`, and the host mutex.
  - Supervisor runner. The supervisor host also awaits its own `closeOwnedCodexProcesses()` before it releases anything. A managed Bot child does the same as the inline runner and then exits, non-zero if there was any cleanup error. During its shutdown it sends `{fcb:"fcb.owned-work", pids, settled}` on the existing IPC channel: once when shutdown starts, every second after that, and once with `settled: true` when `closeOwnedCodexProcesses` has settled. The message is internal IPC and adds no wire shape. The supervisor sends SIGKILL to a Bot child, at host shutdown or toggle-off, only after that child has reported `settled: true`. Before that, it waits for the child's `exit` with no deadline, because killing the child cannot prove its provider groups have ended. From the end of the grace period, every second, it logs `daemon-shutdown` `owned_work_unconfirmed` with the child's pid and the provider pids it last reported. The child's observed exit confirms it. A non-zero exit is a cleanup error. After `settled`, today's grace and forced termination apply, and forced termination is a cleanup error.
  - Limits. If a Bot child or the daemon dies abnormally, from a crash or an operator's SIGKILL, its detached provider groups can remain. V3 does not adopt them, never signals them from a recorded pid, and claims nothing about them. Their stdio pipes close with the dead parent. The Claude backend's CLI child is spawned inside the Claude Agent SDK, which gives the daemon no handle, so V3 does not confirm it. V6a and V6b replace that backend, and `providers.md` *Process host* states how those processes join this rule.
- Listener release. D's `release()` keeps its signature. It terminates every drain connection and then closes the HTTP listener. The cutoff is confirmed when `server.close`'s callback fires with no error or with `ERR_SERVER_NOT_RUNNING`. `release()` resolves when everything closed cleanly. If the cutoff is confirmed but a connection close or terminate failed, it rejects after the cutoff with `ApiCleanupError`, which `server/http.ts` exports. Any other rejection means the cutoff was not confirmed. A listener belongs to the daemon's own process, so it is never owned work and neither case waits.
  - Failed termination, in D's `ws.ts`. Every `terminate` on the release path is caught, including the one in the timer that ends drain sockets which did not close in time. A throw there must not escape the release Promise, and it must not leave `release()` waiting forever for the `WebSocketServer` close callback that the failed termination was meant to trigger. A known failed termination is recorded as a cleanup failure. Once the HTTP cutoff is observed, `release()` rejects with `ApiCleanupError` without waiting for that callback. When the cutoff is unknown, that outcome dominates: `release()` rejects with an error that is not `ApiCleanupError`, even if a termination also failed. When no termination failed, the existing wait for the callback stays. The accepted-request drain and the restricted `daemonStatus` and `stopHost` replies do not change. No public API is added.
  - On `ApiCleanupError`, the host logs `daemon-shutdown` with the reason, releases `daemon.pid` and then the host mutex, and exits 1. This is the plan's existing rule for a confirmed cleanup error.
  - On any other rejection, it logs `daemon-shutdown` `listener_close_unconfirmed`, releases nothing explicitly, and exits 1 at once. Process exit closes the socket. The lock is left naming an owner that does not run. The helper and the next start already treat that as released, as lane 4 does. A `vonvon daemon stop` waiting on that owner reports the cleanup-unconfirmed error and exits 1, under *Stop*, and leaves the lock alone. Releasing first could let a replacement try the port while the old socket is still bound.
  - L's cached `completeShutdown` keeps caching. It classifies the cached rejection once, so it never waits on a rejected release.
- Control during drain. Today `ws.ts` refuses every new connection once shutdown starts, so a fresh CLI cannot verify the owner while it drains. V3 keeps the listener open in a restricted mode through the drain, until the release step.
  - Existing connections close with 1001 `server_shutdown`, as today.
  - A new connection passes the same `hello` and credential check, with the same 4401 refusals.
  - An authenticated drain connection may send only `admin` `daemonStatus` and `machine` `stopHost`. Any other request closes the socket with 1001 `server_shutdown`. The daemon answers both from its own lock identity, without a snapshot rebuild, and sends no `snapshot` event on a drain connection. `daemonStatus` keeps its reply shape, and `stopHost` replies `done`, as today.
  - Drain connections are not accepted work, and the drain does not wait for them.
  - Release step. The daemon becomes eligible for it only when the drain has settled and every owned exit is observed, including a cancelled helper's exit under *Stop wins*. In one synchronous step it rechecks the stop state, commits the restart only if no stop has been accepted, closes the listener, and terminates every drain connection. If the recheck finds an accepted stop whose helper exit is not yet observed, the step commits nothing and closes nothing. The daemon cancels the helper under *Stop wins* and becomes eligible again only after that exit. Once the step completes, the daemon releases `daemon.pid`, then the host mutex, and exits. The listener closes before the lock goes, so a replacement can bind the same port.
- Stop. `machine` `stopHost`, SIGTERM, and SIGINT each request a stop. `vonvon daemon stop` works in four steps.
  1. It reads `daemon.pid`. If no running owner holds it, it prints `already stopped` and exits 0.
  2. It connects to the lock's `listen`, authenticates with the local credential, and reads `admin` `daemonStatus`. The reply's `pid` must equal the lock's. After the reply, the lock must still hold the same `pid`, `startedAt`, and `listen`, with that owner running, as `verifyPidLockOwner` checks today. It then sends `machine` `stopHost` on the same socket. The `done` reply means that owner accepted the stop.
  3. It never signals a process picked from pid text. If it cannot authenticate, or the socket closes before `done`, it signals nothing, prints the existing `Cannot verify daemon owner` message, and exits 1.
  4. After `done` it waits for that owner, identified by `pid` and `startedAt`, and prints a progress line every 5 s. On each check it reads `daemon.pid` and applies the first rule that matches.
     - The lock names a different owner, by `pid` or `startedAt`, that runs. It exits 1 and names that owner's `pid` and `listen`. A replacement is never reported as stopped.
     - The acknowledged owner still runs, by the existing liveness check. It keeps waiting, with no deadline.
     - The acknowledged owner no longer runs, and the lock is gone or names a different owner that does not run. It exits 0.
     - The acknowledged owner no longer runs, and the lock still names it. The owner died without releasing, so neither the release nor the end of its owned work was observed. It prints `Daemon <pid> exited without releasing daemon.pid. Cleanup was not confirmed; see vonvon daemon logs.` to stderr and exits 1 at once, with no further progress line.

     In every case it signals nothing, and it never deletes or rewrites the lock. The next `daemon start` and the restart helper still replace a lock whose owner does not run, as lane 4 does. `runStop` keeps its signature and needs no new lock or RPC field. Interrupting the CLI leaves the stop requested.

  Sending `stopHost` instead of SIGTERM uses an existing request. It also removes the gap between verifying a pid and signaling it.
- Start. `daemon start` keeps today's detached spawn and readiness wait. `daemon start --port <n>` with `n` other than 0 succeeds only when the ready owner listens on `127.0.0.1:<n>`. Otherwise it exits 1, names the running `listen`, and starts nothing. With no port or port 0 it accepts any ready owner, as lane 3 expects.
- Restart. `restartHost` and `applyCoreUpdate` reply first, as they do today. The daemon then spawns the detached helper and keeps its `ChildProcess` handle. Through the hidden `__restart-after-exit` arguments, the helper gets three things: the port the daemon actually bound, the daemon's lock identity (`pid` and `startedAt`), and, for `applyCoreUpdate` only, the `update-status.json` record that the update wrote. Those internal arguments are not a wire or storage shape. The daemon then requests shutdown.
  - The helper has no wall-clock deadline. It waits as long as `daemon.pid` names that identity and the existing liveness check says it runs. It reads the lock only to wait and never signals any process.
  - When the lock is gone, or names an owner that does not run, the helper runs `daemon start --port <port>`. The restart succeeds only when the next ready owner is not the old identity, passes owner verification as in *Stop*, and listens on `127.0.0.1:<port>`. A racing start that wins on the same port also leaves one daemon on that port, and counts as success.
  - If the old daemon dies without releasing, for example by SIGKILL, the helper still starts the replacement.
- Stop wins until the release step. The restart is committed at the release step, when the daemon closes its listener. Until then a stop can cancel it.
  - A stop that the old owner accepts before the commit cancels the restart. That covers `stopHost`, SIGTERM, SIGINT, and `vonvon daemon stop`, whose `stopHost` arrives over a drain connection. As soon as it accepts that stop, the daemon sends SIGTERM to the helper through its handle, without waiting for the rest of the drain. If the helper has not exited 5 s later, the daemon sends SIGKILL and keeps waiting. SIGKILL is an escalation only, never a release. Until it observes the helper's exit, the daemon keeps the restricted listener, `daemon.pid`, and the host mutex, and it is not eligible for the release step. So the helper, which waits while that lock is held, can never start a replacement after an accepted stop. The daemon logs `daemon-restart` `cancelled`.
  - If the helper exits before the release step without a stop, the daemon logs `daemon-restart` `helper_lost` and finishes as a stop. Nothing restarts.
  - After the commit the old daemon accepts no request. A SIGTERM that arrives then is logged and does not cancel the committed restart.
  - The window. Between the release and the replacement taking the lock, no process answers for the data root. A `vonvon daemon stop` in that window finds no owner, prints `already stopped`, and exits 0, and the replacement still starts. Once the replacement holds the lock, a stop follows *Stop* against it, and exits 1 with the verification message until the replacement listens. V3 adds no intent file to close this window, per Appendix B. The PR states the window.
- Failure. The helper never kills or replaces a foreign owner and never retries on another port. After the release, if another owner is ready on a different port, the helper spawns nothing and logs `superseded`. If the new daemon cannot bind the port or the start command fails, it logs `start_failed`. A same-port success logs `replaced`. Each `daemon-restart` line in `$VONVON_HOME/logs/` carries the old and new `pid` and `listen`. After reconnecting, a client reads the outcome with `vonvon daemon status --json` and `vonvon daemon logs`, and for an update with `machine` `coreUpdateStatus`.
- Update status. `update-status.json` keeps its shape `{phase, ok?, message?, from?, to?, at}` and its four phases, and V3 adds no generation field. A restart writes only the `restarting` record that its own `applyCoreUpdate` wrote.
  - Ownership is checked against the record itself. A write is allowed only while the file still equals the record the helper received, field for field. A plain `restartHost` passes no record and never touches the file, so an unrelated restart cannot mark a stale `restarting` record `done`.
  - Each compare and write holds the existing `update.lock`, which `performCoreUpdate` also takes before it clears the file. If a live update holds that lock, the record no longer belongs to this restart. The writer skips it and logs that.
  - The helper writes `done` after a verified same-port replacement, and `error` with the outcome after `superseded` or `start_failed`.
  - Before it releases the lock, the old daemon writes `error` with message `重启已被停止取消` when a stop cancels the restart, and `error` after `helper_lost`.
  - If the helper dies after the commit without writing, the record stays `restarting`. V3 does not reconcile it at startup. `coreUpdateStatus` reports `restarting` until the next `applyCoreUpdate` clears it, and the PR states this.
- Callers. Every stop, restart, and update entry point uses these paths. The DM 重启 and 更新 entries are not such entry points. At source `b1a664a`, the card actions `DM.restart`, `DM.restartDo`, `DM.update`, and `DM.updateDo` and the Bot-menu events `DM.restart` and `DM.update` in `bot/handle-message.ts` only send guidance cards, from `buildForegroundRestartCard` and `renderForegroundUpdate`. They call no restart or update. V3 keeps them as guidance only and adds no DM restart or update behavior. A later change that makes them act goes back to Claude Code first, and it must use these paths. No V3 path calls the adapter's `install`, `restart`, or `uninstall`, `launchctl kickstart -k`, or `stopInstallation`. The PR lists every caller of `requestStop`, `requestRestart`, `spawnDaemonControl`, `runDaemonControl`, `restartDaemon` in `service/update.ts`, `controlDesktopService`, the `__win-relaunch` entry, and the adapter's `install`, `restart`, and `uninstall`, with the path each one now takes.
- `applyCoreUpdate` needs a global npm installation, so a checkout cannot run it for real. V3 proves its restart through the unit cases below and through the shared helper path that the real `restartHost` proof drives. V3 has no real-process `applyCoreUpdate` proof, and the PR says so.
- No architecture or storage change is needed. The drain connection mode, the release step, the helper's arguments, the provider registry, the `fcb.owned-work` IPC message, and `ApiCleanupError` are internal. `stopHost`, `daemonStatus`, the 1001 and 4401 closes, `update.lock`, and every file shape already exist. Two behaviors are visible to users. `vonvon daemon stop` waits with no deadline while its owner runs, and exits 1 when it finds a replacement or an owner that died without releasing. `vonvon service install` and `uninstall` refuse until V5.

*Requests.* All use the V1 envelopes: `{type:"request", id, method, payload}`, answered by `{type:"response", id, method, payload}` or `{type:"error", id, code, message}`.

- `snapshot`. Payload `{type:"get"}`. The reply payload is the current `DesktopSnapshot`. The daemon returns its cached snapshot and never probes tools or Feishu inline.
- `admin`, a new group in `admin.ts`, for old routes that have no V1 home. Each read reply carries the old JSON body unchanged.
  - `{type:"state"}` replies `{kind:"state", state}`. `state` is the old `GET /api/state` body, `{version, generatedAt, bots}`. Each bot is an `AdminBot` with `projects: AdminProject[]` and an optional `projectsError`. Every field of `AdminBot` and `AdminProject` in `packages/daemon/src/admin/service.ts` gets a zod type, `completionReminder` included. The handler is the moved `handleState`, with its 2,000,000-character avatar budget and its `projectsError` fallback.
  - `{type:"diagnosis", agentId?}` replies `{kind:"diagnosis", bot?, backends, event?, eventConfigUrl?}`.
  - `{type:"hostDoctor"}` replies `{kind:"hostDoctor", doctor}`.
  - `{type:"setupStatus", agentId}` replies `{kind:"setupStatus", status}`.
  - `{type:"daemonStatus"}` replies `{kind:"daemonStatus", status}`.
  - `{type:"codexSetup"}` replies `{kind:"codexSetup", setup}`.
  - `{type:"logs", maxBytes?}` replies `{kind:"logs", text}`. `maxBytes` is clamped to 1 KiB to 256 KiB and defaults to 64 KiB.
  - `{type:"followLogs", follow}` replies `{kind:"following", follow}`.
  - `{type:"switchBackend", agentId, projectName, backend}` replies `{kind:"applied", revision}`, where `revision` is the numeric snapshot revision, as in the `command` `applied` result.
- `directory`, a new group in `directory.ts`.
  - `{type:"list", path?}` lists the subdirectories of `path`, which defaults to the daemon user's home. It replies `{kind:"entries", path, parent, entries:[{name, path, hidden}], truncated}`, sorted by name and capped at 1000 entries. `parent` is null at home.
  - `{type:"choose", path}` replies `{kind:"folderChosen", folder}` using the V1 `folderChoiceSchema`. The token is valid only in this daemon process, only for 10 minutes, and only for `bindGroup`, `createProject`, and `editProject`.
  - The daemon resolves `path` with `realpath` first. A path outside home after resolution gets error code `outside_home`.
- The five V1 groups keep their shapes, apart from the additive job and backend-install fields below. Their string revisions keep their V1 meaning, as *Snapshot and revision* states. A V1 variant that the route inventory does not use is outside the V3 gate. V3 answers it with error code `unsupported`. The PR whose UI first needs it adds the handler, and a file-boundary conflict goes back to Claude Code.
- An unknown `method` gets error code `unknown_method`. A payload that fails its schema gets `invalid_request`. Neither closes the socket.

*Events.* `{type:"event", event, payload}`. `events.ts` becomes a union on `event`.

- `snapshot` with a `DesktopSnapshot` goes to every authenticated connection on each revision bump. There is no subscribe step and no unsolicited first event. A client reads `snapshot` `get` once per connection.
- `log` with `{lines}` goes to connections that turned `followLogs` on. The payload shape does not change. The old SSE and the V3 source read the whole backlog into one event, so a burst became one unbounded event. V3 bounds it like backend-install live pieces. A slow consumer still gets 1013 `slow_consumer`.
  - Replay. The follower takes one size snapshot `R`, the replay end, and reads the replay window from `max(0, R - 16 KiB)` to `R`. When that window starts after offset 0, the bytes up to and including its first newline are a partial first line and are suppressed, as the old SSE did. Suppression applies only inside the window. If the window has no newline, the whole window is suppressed, and suppression clears at `R` anyway. It never carries into live reads. The remaining window bytes go through the follower's decoder. An incomplete code point at `R` stays in the decoder's carry and is emitted, completed, with the first live output. Live reads start at `R`. The replay event is sent only when its text is not whitespace-only, as before. When it is not sent, the fidelity rule below starts where the replay's decoded text would have ended.
  - Reads. Each later read takes at most 64 KiB (65,536 bytes). One `StringDecoder('utf8')` per follower decodes the replay and every later read. So a code point split across two reads, including one cut at the end of the replay, is emitted whole in the next event.
  - Event size. For valid UTF-8, decoding a 65,536-byte read can yield up to 65,539 bytes: 3 carried bytes plus the read, whose first byte completes the carried code point. Invalid bytes can expand further, because each U+FFFD takes 3 bytes. The daemon splits all decoded text, the replay included, into consecutive events of at most 65,536 bytes of UTF-8 each, cutting only between code points. That limit holds unconditionally, for invalid input too. No event's `lines` is longer than 65,536 bytes.
  - Fidelity. Take a log file of valid UTF-8 that grows only by appends. The replay's `lines` followed by every later event's `lines` equal the file's bytes from the first replayed byte to the last byte read, in order, with nothing dropped, including whitespace-only text. Bytes that are not valid UTF-8 decode to U+FFFD, and the guarantee does not cover them.
  - Discontinuity. The day's file name can change, or the file can shrink below the follower's offset. Either way the follower drops its pending carry, at most 3 bytes of an incomplete code point, starts a fresh decoder, and reads the current file from offset 0. It sends no marker. Bytes appended to the previous day's file after its last read are not delivered, and neither are bytes lost to truncation. A same-path replacement that does not shrink the file is not detected, and the guarantee does not cover it.
- `backendInstall` with `{operationId, id, update, item}` goes to connections attached to that install. `item` is `{type:"log", chunk}`, `{type:"done"}`, or `{type:"error", code, message}`. A live `chunk` is at most 64 KiB, per *Jobs*. The item shapes do not change.

*Snapshot and revision.*

- `snapshot.ts` builds `agents`, `groups`, `memberships`, and `stale` with `projectState` ported from the pinned `desktop/main/projection.ts`. It applies it to the admin state, not to a `stateSchema` parse. `host` is `{kind:"connected", ownership:"owned", version}`. `application` has the platform mapped to the V1 enum, the daemon version, `loginItem: false` until V5, and `dataPath` set to `VONVON_HOME`. `tools` come from `CodexSetupService.setup()` and the `claude-agent` backend probe, refreshed at start, every 60 s, and when a tool job settles. `jobs` come from `jobs.ts`. `diagnostics` hold the last `inspectAgent` result per agent. `observedAt` is the build time.
- Besides each write, as below, the daemon rebuilds the snapshot on each Bot process or connection change, on each job phase change, and every 5 s, the old console's poll period.
- `revision` is a counter per daemon process. It starts at 1 and increases by 1 only when a rebuilt snapshot differs from the previous one, ignoring `revision` and `observedAt`.
- Every write handler, in any group, rebuilds the snapshot before it replies. When that rebuild bumps the revision, the daemon sends the `snapshot` event on the writer's socket before the reply, and to every other connection.
- The numeric snapshot revision goes into a reply only through a field already defined as that number. There are two such fields: the `applied` result's `revision` in `commandResultSchema` (`domain.ts`) and `admin` `switchBackend`'s `applied` `revision`. Each carries the revision after its own rebuild.
- Every other `revision` keeps its V1 meaning and wire shape, and the daemon never derives it from or compares it with the snapshot counter. The string revisions in `settings.ts` are optimistic-concurrency tokens for one section or record, compared against the stored value. They cover section `revision`, `administrators`, `members`, `cliRuntime`, `commentInstructions`, and host `coffee` in the views. They also cover the `revision` that `save`, `saveExecutable`, and the revisioned `act` actions send. A stale token gets the same reply as in V1. The string `revision` of `projectRecordSchema` in `collaboration.ts`, which `editProject` and `removeProject` send back as `expectedRevision`, stays a per-project token. V3 adds no snapshot revision to `settings`, `collaboration`, `environment`, or `machine` replies. A client of those groups reads the new snapshot revision from the event that came before the reply.
- A client starts a fresh `watchSnapshots` on each new connection, seeded by `snapshot` `get`. A restarted daemon starts again at 1, so a client never carries a revision across connections. Two clients on one daemon see the same revision sequence.

*Jobs.*

- `jobSchema` gains four optional fields: `status` on `qr`, `verificationUrl` on `authorizing`, `agentId` on `succeeded`, and `code` on `failed`.
- The `backendInstall` reply in `environment.ts` gains one optional field, `omittedBytes: z.number().int().nonnegative().optional()`. The daemon always sends it. A reader treats an absent value as 0. No other wire shape changes for backend install.
- QR registration. `registerAgent` and `refreshAgentCredentials` reply `started {jobId}`, and each creates a `registerAgent` job. The job moves from `running` to `qr`, then ends `succeeded`, `failed`, or `cancelled`. In `qr`, `image` is a PNG data URL of `url`, `expiresAt` is now plus `expireIn` seconds, and `status` is the latest SDK status. `succeeded` carries `agentId`. The other old `done` fields are readable from `admin` `state`, the agent settings view, and `admin` `setupStatus`. `failed` carries `code`. The job belongs to the connection that started it. When that socket closes, the daemon aborts the registration and the job ends `cancelled`, as an SSE disconnect did. A new registration aborts a running one. `cancelJob` from any connection aborts it, as `DELETE /api/bots/register-qr` did. With 32 unsettled registrations the command replies `refused` with code `registration_busy`. V3 may add a QR encoder dependency to `packages/daemon`.
- Codex install and login. `installCodex` and `startCodexLogin` reply `started {jobId}`. The `CodexSetupService` job maps onto `jobSchema` as `installCodex` or `loginCodex`, and `authorizing` carries `userCode` and `verificationUrl`. A disconnect does not affect these jobs, as the old polling did not. `cancelJob` cancels one. A setup conflict replies `refused` with code `conflict`.
- Terminal jobs stay in `snapshot.jobs` for 10 minutes, then leave with a revision bump.
- Backend install. `environment` `backendInstall {id, update}` replies `{kind:"backendInstall", operationId, id, update, attached, replay, omittedBytes}`. One job runs per `id` and `update` pair. The handler keeps the existing order. It selects the operation with `selectBackend`, which starts `installBackend` for a new pair, though npm itself waits for the installer queue below. It then awaits the mutation's snapshot rebuild, and only then attaches inside the reply closure with `attachBackend`. `attached` records the selection: `false` for the request that created the operation, `true` for a request that found it running. Attach and reply happen in one tick, so later events on that socket continue exactly after `replay`. That tick is the attach, after the rebuild, not the selection. A socket close only detaches. npm runs to the end and nothing rolls back. The job settles with `done`, or with `error` whose code is `install_failed`, `aborted`, or `unknown`. Settlement frees the `id` and `update` slot, so a later request starts a fresh install and `backendCatalog` shows the result. An admission selected before settlement still holds its operation and reads the retained tail and terminal item at its attach. The operation is released after that.
- Backend install output is bounded. The operation keeps a tail of the most recent output, not every item. V2 kept every item, and V3 deliberately does not.
  - Decoding. The installer decodes stdout and stderr with one `StringDecoder('utf8')` per stream and flushes each at close. A code point split across two reads is emitted whole, never as U+FFFD. Every cut the daemon makes in install output falls on a code point boundary, so no string it emits has a lone surrogate. All sizes below are UTF-8 bytes, measured with `Buffer.byteLength`.
  - Live items. The daemon splits any decoded chunk larger than 64 KiB into consecutive pieces of at most 64 KiB, in order. Each piece is one live `{type:"log", chunk}` event. Concatenating the live chunks reproduces npm's combined output exactly, in the order the daemon read it.
  - Retained tail. The operation retains at most the last 256 KiB (262,144 bytes) of output. When output passes that size, the oldest bytes are dropped. If the cut lands inside a code point, the whole code point is dropped, so the retained text is between 262,141 and 262,144 bytes. The retained text is always a contiguous suffix of the full output. The operation also counts `omittedBytes`, the bytes emitted but no longer retained. Memory per running operation is the retained tail, at most one 64 KiB piece in flight, a bounded number of internal entries, and the installer's existing error tail of 8,192 UTF-16 code units. It does not grow with install length.
  - Replay. Every reply reports the operation as observed at its attach, for fresh and attached admissions alike. `replay` holds at most one `log` item, whose `chunk` is the whole retained tail at attach. That item is absent when nothing had been emitted by then. A terminal item follows when the operation settled before the attach, whether in the selection tick or while the snapshot rebuild was awaited. A settled operation adds no peer, so that socket gets no later event for it. `omittedBytes` in the reply is the count at attach, and is 0 when replay is complete.
  - Fresh admission. A new operation starts with nothing retained and `omittedBytes` 0. That is its state at creation, not necessarily its first reply. `installBackend` can emit or settle before the attach. Its first reply then carries that output in `replay`, with `omittedBytes` above 0 if more than 256 KiB came before the attach, and the terminal item if it settled. The reply has empty `replay` and `omittedBytes: 0` only when nothing was emitted and the operation had not settled by the attach. Output emitted before the attach reaches the socket only through `replay`, because the socket is not a peer until the attach.
  - Continuation. Write `S` for the full output. At attach, `omittedBytes + byteLength(replay chunk)` equals the bytes emitted so far. The replay chunk equals the bytes of `S` from `omittedBytes` up to that point. Live events on that socket then continue at that offset with no gap or duplicate. A client whose attach found nothing emitted sees all of `S` through live events. A client whose attach found output sees the retained part in `replay` and the rest live, and the omitted head only as the count. This holds for the creating request as for any later one.
  - Error message. `Jobs` bounds the final `error` item's `message` itself, whatever the source: the installer's `tail`, the installer's verification-failure text, or a thrown error's `message`. The message is the longest suffix of the source that is at most 8 KiB (8,192 bytes) and starts on a code point boundary. A lone surrogate at the start of the source is dropped with the cut, so the message is well-formed. The installer does not guarantee this on its own. Its `tail` is `slice(-2000)` in UTF-16 code units, which can start inside a surrogate pair. The verification-failure path appends text and the package name to that tail, and the spawn, mkdir, and thrown-error paths carry an error message of any length.
  - Socket budget. A 256 KiB tail serializes to at most 1.5 MiB of JSON. The worst case is control characters, each escaped as `\u00XX` in six bytes. The whole reply frame stays under 2 MiB, well below the server's existing 8,000,000-byte `bufferedAmount` slow-consumer limit. A live piece is at most 384 KiB of JSON. V3 keeps the existing rule that closes a slow consumer with 1013 `slow_consumer`. That close only detaches, and the client reattaches with a new tail and `omittedBytes`.
  - Long or stalled installs. V3 adds no wall-clock or output-volume limit on npm. Verbose output costs bounded memory. A stalled npm holds one npm process and its `id` and `update` slot, which still attaches, until npm exits or the daemon stops. Because installer mutations are serialized, it also holds back every queued install, update, and uninstall for that time. Roadmap 已知风险 tracks this.
- Installer mutations are serialized. These calls change `paths.backendsDir`, its `package.json`, its `package-lock.json`, or its `node_modules`: `installBackendDep` for an install or an update, `uninstallBackendDep`, and the rollback inside a failed install. They run one at a time, in the order they were called, through one queue in the installer module of the host process. Each queued operation runs as one critical section, from its first check to its last write.
  - An install or update runs all of these in one turn: `ensureBackendsDir`, the npm child until `close`, and then either the rollback after a failure, or the verify, the rollback if verify fails, and `fixNativeHelperPerms`.
  - An uninstall runs its precheck and its removal in one turn. The mutable precheck, `isBackendInstalledInUserDir` in `admin/service.ts` `uninstallBackend`, moves inside the queued operation, so it sees the state that every earlier queued mutation left. An uninstall queued behind an install of the same package, absent when both were called, therefore removes it. If the package is absent at the uninstall's turn, it replies with the existing `并未装在用户目录，无需卸载` message and changes nothing. The static checks, which are the catalog lookup, `external-cli`, and installability, stay before the queue, and their replies do not change.
  - Call order is admission order, fixed synchronously. Today `selectBackend` enters `installBackend` in a later microtask, while `environment` calls uninstall synchronously, so an uninstall can overtake an earlier install. In V3, when `selectBackend` creates an operation, it reserves that install's queue turn in the same synchronous call, before it returns. The `environment` handler reserves an uninstall's turn synchronously when it accepts the request. A synchronous throw from the service while it reserves or starts an install becomes the operation's existing terminal `error` item, never a thrown selection. When it reserves a turn, the installer logs `backend-queue` `reserved` with the operation kind, the package, and the queue position. The live proof below observes admission through that log line, and it is not a wire field.
  - Selection, replay, and the wire do not change. `operationId` and `attached` keep their meaning, and an identical request still attaches to the existing operation without reserving a second turn. Replay, terminal cleanup of the `id` and `update` slot, and `Jobs.close` ownership of install operations stay as specified above. A queued operation has emitted nothing, so an attach before npm starts gets empty `replay` and `omittedBytes: 0`. The continuation rule holds from there.
  - `backendUninstall` waits for its turn and replies after its removal. An uninstall queued behind a running install replies after that install settles.
  - Abort. A queued install checks its abort signal when it reaches the head of the queue, before `ensureBackendsDir`. If a stop aborted it, it settles `error` with code `aborted` without touching the prefix. The existing check after `ensureBackendsDir` stays. A running npm gets SIGTERM, and its rollback runs inside the same turn. A stop does not cancel a queued uninstall. It is an accepted RPC, so the accepted-request drain in `ws.ts` awaits it, not `Jobs.close` alone. It runs in its turn after the operations ahead of it settle.
  - Rollback. The queue guarantees only that no other mutation runs during a rollback. It does not prove the prefix is restored, because rollback swallows its own errors and deletes `package-lock.json`. V3 claims the ordering, not a restored state or restored metadata.
  - Presence checks, issue #48. The production check `isBackendDepInstalled` in `agent/backend-loader.ts` trusts a successful `resolve()` without checking that its target still exists. A standalone Node 22 probe showed a deleted package still resolving from the resolver cache in one process. That probe is not evidence about the production helper, so the PR first runs a regression against the production helper on a real filesystem: install a fixture package in a temporary `backendsDir`, check it, delete it, and check again. The regression records the helper's answer before the repair. Separately, `uninstallBackendDep` verifies removal with `isBackendDepInstalled`, which can find a package outside the user directory, for example a development dependency. V3 repairs both with a fresh check of the user directory only, read from the filesystem at the time of the check with no cache. A library backend is present when `backendsDir/node_modules/<pkg>/package.json` exists. A bin backend is present when `backendsDir/node_modules/.bin/<binName>` exists, so the existing package-versus-bin rule holds. The uninstall precheck, the removal check, and the post-install verify use it. `agent/index.ts` changes only as far as its exports and callers need. Where install verify also checks loadability, it confirms that the resolved target exists on disk.
  - Reads are not queued. `backendCatalog` and `backendVersion` only read, and `npm view` does not touch the prefix.
  - Version probe. `installer.latestNpmVersion` keeps its signature, `Promise<string|null>`, and its one SIGTERM at 8 s. The 8 s is when it tries to stop npm, not a response deadline. Its `npm view` child is owned work of the installer, and its end is observed only at `close`, as `service/update.ts` `latestVersion` already does.
    - A spawn that never gets a `pid` resolves null at once.
    - The 8 s timer and an `error` event after birth only mark the probe failed. The timer also sends the SIGTERM and logs `backend-version` `term_sent` once, with the package and the `pid`. Neither resolves the Promise.
    - The Promise settles only at the child's `close`: with today's parsed result after a clean exit, and with null after a marked failure or a non-zero exit.
    - So an accepted `environment` `backendVersion` request stays pending until npm closes, and the accepted-request drain in `ws.ts` holds `daemon.pid` and the host mutex for it, like any accepted request. If npm ignores SIGTERM, the request and the drain stay pending. Nothing escalates.
    - No periodic diagnostic. The probe is accepted work inside the drain, not `owned_work_unconfirmed` after it, and the drain logs no other accepted request periodically either. The single `term_sent` line names the `pid` that holds the drain. No second child registry, process group, wire or storage field, or queue turn is added, and the mutation queue is unchanged.
  - Rationale. The copied V2 `web/server.ts` keyed concurrent installs by `id` and `update` in `installJobs` and uninstalled directly, and V3 inherited that design. It is not a new migration regression, and nobody has observed corruption. Concurrent npm runs on one prefix, while a rollback deletes `package-lock.json` and rewrites `package.json`, are unsafe by construction. The queue is small and leaves every shape alone, so V3 serializes now.
  - Scope. The host process is the only writer. Only the two host forms inject `installBackendDep` and `uninstallBackendDep` into `AdminService`: the supervisor host and the standalone single-Bot host in `cli/commands/run.ts`. A managed Bot child, `daemon run --bot` under a supervisor, does not, and the candidate has no DM backend-install action. The host mutex keeps one host per data root, so a process-local queue covers every writer. The PR confirms this inventory and lists every caller of both functions. A writer found outside the host process is a plan gap that goes back to Claude Code. The queue is not silently widened into a cross-process lock.
- `vonvon daemon stop` aborts running registrations and waits for them, as the old `close()` did.

*Route inventory.* Every old route either moves to the V3 request in this table or is marked retired, before `src/web` is deleted. `rpc-parity.test.ts` iterates the rows that name a V3 request. Retired rows have no RPC and no parity case.

| Old route | V3 request |
| --- | --- |
| `GET /api/state` | `admin` `state` |
| `GET /api/project/:name/sessions?bot=` | `settings` `sessions` |
| `GET` and `PATCH` on `/api/bots/:id/settings`, `/api/project/:name/settings?bot=`, `/api/bots/:id/sessions/:thread/settings`, `/api/settings/host` | `settings` `read` and `save` |
| `PATCH /api/bots/:id/settings/:section` | `settings` `save` of that agent section. The old server answers `GET` on this path with 405, so it has no read case |
| `POST /api/bots/:id/settings/actions`, `POST /api/settings/host/actions` | `settings` `act` |
| `GET /api/bots/:id/models` | `settings` `models` |
| `GET /api/bots/:id/voice` | `settings` `read` of the agent scope, field `voice` |
| `POST /api/bots/:id/voice` | `settings` `act` with `voice` |
| `POST /api/bots/:id/completion-reminder` | `settings` `save` of agent section `completion` |
| `POST /api/project/:name/permission` | `command` `setPermission` |
| `POST /api/project/:name/no-mention` | `command` `setResponse` |
| `POST /api/project/:name/auto-compact` | `settings` `save` of project section `compact` |
| `POST /api/project/:name/backend` | `admin` `switchBackend` |
| `PATCH /api/bots/:id` | `command` `setAgentEnabled` |
| `DELETE /api/bots/:id` | `command` `deleteAgent` |
| `POST /api/bots/:id/collaboration` | `collaboration` |
| `GET /api/account/codex/usage?force=` | `collaboration` `usage` |
| `GET /api/bots/:id/pending-groups` | `command` `listPendingGroups` |
| `GET /api/bots/:id/joined-groups` | `command` `listJoinedGroups` |
| `POST /api/bots/:id/bind-group` | `directory` `choose`, then `command` `bindGroup` |
| `GET /api/tools/codex/setup` | `admin` `codexSetup` |
| `POST /api/tools/codex/install`, `POST /api/tools/codex/login` | `command` `installCodex`, `startCodexLogin` |
| `GET /api/tools/codex/jobs/:id`, `DELETE` on the same path | `snapshot.jobs`, `command` `cancelJob` |
| `GET /api/bots/register-qr/stream`, `GET /api/bots/:id/refresh-qr/stream` | `command` `registerAgent`, `refreshAgentCredentials` |
| `GET /api/bots/register-qr?sessionId=`, `DELETE /api/bots/register-qr` | `snapshot.jobs`, `command` `cancelJob` |
| `GET /api/bots/:id/setup-status` | `admin` `setupStatus` |
| `GET /api/diagnosis` | `admin` `diagnosis`. `command` `inspectAgent` fills `snapshot.diagnostics` |
| `GET /api/daemon` | `admin` `daemonStatus` |
| `POST /api/daemon/restart` | `command` `restartHost` |
| `POST /api/daemon/stop` | `machine` `stopHost` |
| `GET /api/update/check`, `GET /api/update/status`, `POST /api/update` | `machine` `checkCoreUpdate`, `coreUpdateStatus`, `applyCoreUpdate` |
| `GET /api/host-doctor` | `admin` `hostDoctor` |
| `GET /api/logs`, `GET /api/logs/stream` | `admin` `logs`, `admin` `followLogs` with the `log` event |
| `GET /api/backends` | `environment` `backendCatalog`. Entries keep every field through `passthrough`, and the old `defaultBackend` is the `isDefault` entry's id |
| `POST /api/backends/:id/install`, `POST /api/backends/:id/update` | `environment` `backendInstall` with `update` false or true |
| `GET /api/backends/:id/version`, `DELETE /api/backends/:id` | `environment` `backendVersion`, `backendUninstall` |
| `POST /api/daemon/start`, `GET /api/console/live` | Retired. They serve the standalone read-only preview in `src/cli/commands/web.ts`, which starts the daemon from the page while no daemon runs, then redirects to it. The daemon's own console answers them with 501 and `{live:false}`. The preview retires with `src/web`. `vonvon daemon start` replaces its start button out of band, and V4's `vonvon open` replaces the page. The preview's `POST /api/update` with no daemon retires too; a running daemon's update is `machine` `applyCoreUpdate` above |
| `GET /`, `/vendor/gsap.min.js`, `/vendor/logo.png` | Retired. The HTML console page and its assets retire with `src/web`. V4 serves the new UI |

*Deleting `src/web`.* After V3, nothing in `packages/daemon/src` or `packages/daemon/test` imports or mocks `src/web`. The callers at the V2 head migrate as follows.

- `src/bot/supervisor.ts` and `src/cli/commands/run.ts` keep building the same `AdminService` in both process forms, supervisor and single-Bot inline. They hand it to the V3 server in `src/server/` instead of calling `mountWebConsole`.
- `src/cli/commands/daemon.ts` and `daemon-control.ts` stop calling `readWebConsole()`. They read `pid` and `listen` from the pid lock `$VONVON_HOME/daemon.pid`. The daemon no longer writes `web-console.json`, and `paths.webConsoleFile` may go with its last reader.
- `src/card/dm-cards.ts` `buildDmMenuCard` drops the `webConsoleUrl` option, the 🌐 网页控制台 row, and the doc comment that describes them. Every other row and button stays: 新建项目, 项目列表, 设置, 用量, 诊断, 重启, 更新. The desktop-release elements, the version badge, and `forward: false` also stay. `src/bot/dm-console.ts` and `renderDmMenuCard` in `src/bot/handle-message.ts` drop the `webConsoleUrl` import and argument. The renderer already omits that row when the URL is absent, so V3's menu card equals the card V2 sends while no console runs. V3 adds no replacement link. A DM link to the new UI may return only after V4 actually serves it. That file is outside V4's listed files, so the change goes back to Claude Code first.

Old tests follow one rule. A test of behavior V3 keeps stays and passes, retargeted to the RPC its route maps to in the inventory or to the moved handler. Importing `src/web` is not a reason to drop it. Only these assertions may be removed: the HTML page and its inline script (`UI_HTML`, `UI_PURE_JS`), the vendor assets, the retired preview and its routes, and the `web-console.json` discovery record. A pid or liveness check that read the discovery record moves to the pid lock. These files touch `src/web` or `web-console.json` at the V2 head and form the starting list.

- Retarget to RPC: `web-server.test.ts`, `web-desktop-capabilities.test.ts`, `web-qr-lifecycle.test.ts`, and `settings-owner.test.ts`.
- Retarget to the pid lock: `daemon-cli.test.ts` and `daemon-control-stop.test.ts`.
- Replace the `src/web` mock with the V3 server: `supervisor-activation.test.ts` and `onboarding-events.test.ts`.
- Removable only for the HTML page, vendor, or retired-preview assertions they hold: `web-ui-pure.test.ts`, `foreground-guidance.test.ts`, `voice-ui.test.ts`, `web-event-rendering.test.ts`, and `web-discovery.test.ts`. A case in one of them that checks kept behavior is retargeted instead.
- Keep unchanged apart from the `webConsoleFile` stub in their paths mock, which goes if `paths.webConsoleFile` goes: `web-admin-service.test.ts`, `web-admin-host.test.ts`, and `admin-ops.test.ts`.

The PR evidence carries a mapping table. Each row names a changed, moved, or removed test file or case, its new test and RPC or its retired subject, and the reason. V2's raw test-file count is not a V3 invariant. V3 requires the suite to pass with every skip recorded and the mapping table complete.

**Build.**

- [ ] Port `pid-lock.ts` and `atomic-file.ts` from Paseo `packages/server/src/server/` with their notices.
- [ ] Accept `hello`, check the credential in `$VONVON_HOME/local-credential`, and reply `serverInfo`, per the contract.
- [ ] Move each route that the route inventory maps to a V3 request into an RPC handler. Retire the routes it marks retired, with the read-only preview. Migrate the callers and tests per *Deleting `src/web`*, then delete `src/web` and `src/cli/commands/web.ts`.
- [ ] Publish revisioned snapshot events per the contract, using the revision rule from `watch.ts`.
- [ ] Add the `directory` RPC rooted at the user's home.
- [ ] Add `vonvon daemon start`, `stop`, and `status --json` per the contract.
- [ ] Add the local client in `packages/client`. It reads `listen` from `vonvon daemon status --json` and the credential from `$VONVON_HOME/local-credential`, sends `hello`, correlates replies by `id`, and delivers events.

**You see.**

- [ ] `vonvon daemon start` returns, `vonvon daemon status --json` shows `listen`, and a `packages/client` script prints the snapshot.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/daemon/test/server-handshake.test.ts` rejects a bad credential and accepts a good one.
- [ ] `packages/daemon/test/rpc-parity.test.ts` calls every RPC that replaced a web console route and checks the reply schema. It iterates the route inventory rows that name a V3 request and skips the retired rows. It also checks that `admin` `state` equals the moved `handleState` output on a fixture whose `projects.json` is corrupt, so `projectsError` matches.
- [ ] `packages/daemon/test/server-jobs.test.ts` checks four things. A QR job ends `cancelled` when its owner socket closes, and a second registration preempts the first. A backend install keeps running after detach, and a second request attaches with the retained tail in `replay` and then live items, with no gap or duplicate under the continuation rule. The revision rises once per changed rebuild and not on an identical one. On the writer's socket the snapshot event comes before the write reply, a `command` `applied` reply's `revision` equals that event's, and a `settings` `save` reply keeps its string section `revision`, not the snapshot number. Run `npm test -w packages/daemon -- server rpc`.
- [ ] `packages/daemon/test/server-backend-install.test.ts` checks the bounded-output rules in *Jobs*. It drives `Jobs` with a fake `installBackend` and real UTF-8 data, and drives the installer with a fake child process. Each case records the full emitted output `S` and checks `omittedBytes + byteLength(replay chunk)` against the bytes emitted at attach time.
  - Small output. 10 KiB, then attach. `omittedBytes` is 0, the replay chunk equals `S`, and later live chunks continue with no gap or duplicate.
  - Adversarial volume. Emit 64 MiB three ways: 1-byte chunks, 64 KiB chunks, and a single 1 MiB chunk repeated. Attach at several points, including mid-stream. Each time the replay has at most one `log` item of 262,141 to 262,144 bytes and equals the matching suffix of `S`. The sum of `omittedBytes` and the replay length equals the bytes emitted so far. The operation's internal retained-entry count stays under a fixed bound that the test reads. Every live chunk is at most 65,536 bytes, and the live chunks concatenate to `S`.
  - Multibyte cut. Fill `S` with 3-byte CJK characters and 4-byte emoji. Shift it so the 256 KiB cut lands on byte offsets 0, 1, 2, and 3 inside a code point. Each time the replay chunk satisfies `isWellFormed()`, has no U+FFFD, is at most 262,144 bytes, and starts on a code point boundary. `omittedBytes` counts the dropped partial code point. Splitting a 1 MiB chunk of emoji into live pieces never cuts a code point.
  - Split reads. A fake child writes one 4-byte emoji across two stdout `data` events, and a CJK character across two stderr events, interleaved. The installer's progress chunks concatenate to the original text with no U+FFFD.
  - Frame budget. Emit 1 MiB of `\x01`, then attach over a real local WebSocket. The reply frame is under 2 MiB, the socket stays open, and later live events arrive in order.
  - Settlement. After `done`, a new request gets a new `operationId`. Its fake `installBackend` is held: it emits nothing and does not settle until the test releases it. The reply has `attached: false`, empty `replay`, and `omittedBytes: 0`, and after release its live chunks are all of `S`.
  - Pre-attach emission and settlement. Call `selectBackend` for a new pair, let the fake `installBackend` act, then call `attachBackend`, the order the handler uses around the snapshot rebuild. Run four variants. It emits 10 KiB, and the reply has `attached: false`, a replay chunk equal to `S` so far, and `omittedBytes: 0`. It emits 1 MiB, and `omittedBytes` plus the replay length equals 1 MiB with the replay chunk the matching suffix of `S`. In both, the socket gets no live event for the pre-attach bytes, and later live chunks continue with no gap or duplicate. It emits 10 KiB and settles `done`, and the reply carries the replay chunk, then the `done` item, and the socket gets no later event for that operation. It settles `done` after a second request has attached to the same pair but before that request's attach, and that reply has `attached: true` and ends with `done`. In each settled variant, the next request gets a new `operationId`.
  - Error bound. Each `error` `message` is at most 8,192 bytes, well-formed, and a suffix of its source. Cover four sources: a thrown error whose message is 1 MiB, an installer `tail` that starts with a lone low surrogate after its `slice(-2000)`, a verification-failure tail with a long package name, and a 2,000-unit tail of 4-byte emoji.
  - Detach. Close the only attached socket during a 64 MiB emission. npm keeps running, a later attach gets the tail, and the job settles with `done`.
  - Run `npm test -w packages/daemon -- server-backend-install`.
- [ ] `packages/daemon/test/backend-installer-queue.test.ts` checks the serialized installer mutations in *Jobs*. It drives the real installer with fake child processes that the test holds and releases, and drives `Jobs` and the `environment` handler above it.
  - Admission order through the real handlers. Through the actual `Jobs` and `environment` RPC handlers, not the installer alone, send `backendInstall` of B and then `backendUninstall` of B in the same tick, with B absent. Each turn is reserved in call order, the install enters the service before the uninstall, and the uninstall removes B. A service that throws synchronously while starting an install settles that operation with the terminal `error` item, and the next turn still runs. An identical install request attaches without a second turn.
  - Order. With B absent, call install of A, update of A, install of B, and uninstall of B back to back. Each fake npm spawns only after the one before it has closed and its verify or rollback has finished, in call order. The uninstall of B runs its precheck after B's install, removes B, and replies with the existing success message. Each operation's replies and live chunks still satisfy the continuation rule.
  - Critical section. Hold `ensureBackendsDir`, the verify, the rollback, and `fixNativeHelperPerms` in turn with test gates. While any one of them is held, no other queued operation runs any step.
  - Absent. An uninstall whose package is absent at its turn replies with the existing `并未装在用户目录` message and leaves `package.json`, `package-lock.json`, and `node_modules` unchanged.
  - Queued attach. A request that attaches to a queued operation gets `attached: true`, empty `replay`, and `omittedBytes: 0`, then every byte live once npm starts.
  - Uninstall. A `backendUninstall` sent while an install runs replies only after that install settles.
  - Failure. A failed install whose rollback runs releases the queue, and the next operation then starts.
  - Stop. `Jobs.close` aborts a queued install at the head of the queue, before `ensureBackendsDir` and without spawning npm. It settles `error` with code `aborted`, and `close` resolves only after the running install settles. A queued uninstall still runs in its turn, and the accepted-request drain, not `Jobs.close`, awaits its reply.
  - Version probe. With a fake `npm view` child that has a `pid` and ignores SIGTERM, `latestNpmVersion` sends exactly one SIGTERM at 8 simulated seconds, to that child only, and logs `backend-version` `term_sent` once. The Promise and the `environment` `backendVersion` handler stay pending past 120 simulated seconds, and resolve null only after `close`. An `error` event after birth likewise stays pending until `close`, then null. A spawn without a `pid` resolves null at once. A clean exit keeps today's result. No case reserves a queue turn.
  - Presence, issue #48. First, on a real temporary filesystem, the production `isBackendDepInstalled` checks a fixture package, the package is deleted, and the helper checks again. The answer before the repair is recorded. After the repair, the user-directory check reports absent right after deletion in the same process, for a library package and for a bin package. A copy of the package outside `backendsDir` does not count as installed, and uninstall's removal check reports success.
  - Run `npm test -w packages/daemon -- backend-installer-queue`.
- [ ] `packages/daemon/test/server-logs.test.ts` checks the `log` event rules in *Events* against a temporary log directory and a fake peer.
  - Replay. The first event is the last 16 KiB without a partial first line, as before.
  - Burst. Append 5 MiB in one write between two pumps. Every later event's `lines` is at most 65,536 bytes, and the later events concatenate to exactly the appended bytes.
  - Multibyte. Place 3-byte CJK characters and 4-byte emoji across the 64 KiB read boundaries. No event holds U+FFFD, and each `lines` satisfies `isWellFormed()`.
  - Maximum carry. Arrange a read that ends 3 bytes into a 4-byte emoji, so the next 65,536-byte read begins with the emoji's fourth byte and decodes to 65,539 bytes. That read becomes two events, each at most 65,536 bytes, and they concatenate to the decoded text.
  - Replay handoff. End the file 2 bytes into a 4-byte emoji when the replay is read, then append the rest. The replay holds no partial code point, and the first later event begins with the whole emoji. Replay plus later events equal the file's bytes from the first replayed byte.
  - Replay without a newline. Make the 16 KiB replay window hold no newline, then append live text that has no newline either. The replay is suppressed, and the first later event carries exactly the appended text.
  - Invalid bytes. Append 64 KiB of lone continuation bytes. Every event's `lines` is at most 65,536 bytes even though the U+FFFD output expands it.
  - Whitespace. A newline-only append is delivered.
  - Day change and truncation. With a partial code point pending, a new day's file and a shrunk file both restart at offset 0 with a fresh decoder. The pending bytes are dropped, and no event holds U+FFFD.
  - Run `npm test -w packages/daemon -- server-logs`.
- [ ] `packages/daemon/test/daemon-lifecycle.test.ts` checks *Lifecycle ownership*. It drives the restart helper, `runStart`, `runStop`, the shutdown control, and the host runtime's release with an injected clock and process table, real lock files in a temporary home, and a recording `spawn` and `spawnSync`.
  - Long drain. The old identity holds the lock for 120 simulated seconds after the restart request. The helper is still waiting at 31 s and at 119 s and has spawned nothing. After release it spawns exactly one `daemon start --port <port>`, and the ready lock shows a new `pid` with the same `listen`.
  - Mismatch. After release, another owner is ready on a different port. The helper spawns nothing and logs `superseded`. A new daemon that cannot bind the port gives `start_failed`. A racing owner ready on the same port gives `replaced`, with one daemon.
  - Stop wins. A stop accepted before the release step, by `stopHost`, SIGTERM, or SIGINT, makes the daemon send SIGTERM to the helper at once, before the rest of the drain settles. Hold the helper's exit, including a helper that ignores SIGTERM until the SIGKILL 5 s later. While it is held, `daemon.pid` and the host mutex stay held, a fresh drain client still gets `daemonStatus` and `stopHost`, and the release step does not run. A stop accepted just before the release step makes the recheck commit nothing until that helper's exit is observed. Nothing is spawned, and the daemon logs `cancelled`.
  - Commit. A SIGTERM after the release step does not stop the helper, which starts the replacement. A helper that exits before the release step without a stop gives `helper_lost`, and nothing restarts.
  - Crash during drain. The old identity dies without releasing the lock, and the helper starts one replacement.
  - Update status. The helper turns its own `restarting` record into `done` only after a verified same-port replacement, and into `error` after `superseded` or `start_failed`. A cancelling stop and `helper_lost` write `error` before release. A plain `restartHost` leaves a stale `restarting` record untouched. When the file no longer equals the helper's record, or a live update holds `update.lock`, the helper writes nothing.
  - Stop. `runStop` sends `stopHost` and no signal. It keeps waiting past 20 s and past 30 s while the owner drains, and returns 0 only after release. It exits 1 and names the new `pid` when a different running owner holds the lock. It exits 0 when, after the owner died, the lock is gone or names a different owner that does not run. When the owner dies after `done` and the lock still names it, by `pid` and `startedAt`, `runStop` prints the cleanup-unconfirmed error once and exits 1 at once: no further progress line, no signal, and the lock file is unchanged byte for byte. A later `runStart` still replaces that lock. When it cannot authenticate, it signals nothing and exits 1. `stopHost` and `vonvon daemon stop` issue no adapter call and no manager command.
  - Cleanup and liveness. A Bot child that exits only after forced termination is a cleanup error. The lock is released after its exit, and the daemon exits 1. A child whose exit is never observed keeps `daemon.pid` and the host mutex held past any simulated time, and they are released only once its exit is observed. A clean drain exits 0.
  - Start. `daemon start --port <n>` against an owner on another port exits 1, names that `listen`, and spawns nothing.
  - Service refusal. `vonvon service install` and `vonvon service uninstall` exit 1 with the refusal message. The recording `spawn` and `spawnSync` see no command, and the temporary home and a fake `HOME` gain no file. The hidden `__win-relaunch` entry, run with the platform simulated as Windows and as macOS, exits 1 with the same message, and mocks of every service adapter module record no import. An existing test that expected these commands to call the adapter moves to this case, and the mapping table records it. Tests of `service/control.ts` and the adapter files are unchanged.
  - Drain. With an accepted request held, `daemon.pid` and the host mutex stay held until it settles, for a stop and for a restart.
  - Provider runners, issue #50, against P's fake registry. In the inline runner, a registry that stays pending keeps the per-Bot lock, `daemon.pid`, and the host mutex past 120 simulated seconds. It logs `owned_work_unconfirmed` with the pid once per simulated second. When the registry rejects, the locks are released and then the daemon exits 1. When `startBridge` throws after a provider was born, the per-Bot lock stays held until the registry settles. A managed Bot child that has not reported `settled: true` gets no SIGKILL past the grace, and the supervisor logs `owned_work_unconfirmed` with the child's pid and its last reported provider pids. After `settled: true`, today's escalation applies. The supervisor host awaits its own registry before release.
  - Listener release. A `release()` that rejects with `ApiCleanupError` gives a logged cleanup error, then release of `daemon.pid` and the host mutex, then exit 1. Any other rejection gives `listener_close_unconfirmed`, no explicit release, and exit 1. A `runStop` that got `done` from that owner then exits 1 with the cleanup-unconfirmed error, and the next start replaces the lock, whose owner no longer runs. Neither case waits.
  - Run `npm test -w packages/daemon -- daemon-lifecycle`.
- [ ] `packages/daemon/test/provider-ownership.test.ts` checks *Provider processes* in *Lifecycle ownership* with the actual `OwnedCodexProcess`, `AppServerClient`, `createOrchestrator`, and `startBridge` shutdown. It uses a `ChildProcess` event shell, an intercepted `process.kill` with a simulated process-group table, an injected clock, and the existing message-queue fixture. No provider, Bot, or OS signal runs. Issue #50's diagnostic and both regressions are cases here, and they pass.
  - Retained group past the grace. The group still exists at 6 and at 120 simulated seconds. `close`, the client's close, the thread's close, the orchestrator's `shutdown`, and `closeOwnedCodexProcesses` all stay pending. `unconfirmedCodexPids()` lists the pid, and SIGKILL is sent again once per second.
  - Eventual death, non-zero outcome. The group then ends and `exit` and `close` fire. Every pending Promise above rejects, with `CodexProcessCleanupError` for the SIGKILL that was needed, and the registry is empty.
  - Generic error after birth. An `error` event with a `pid` and no `exit` leaves `exited` and everything else pending. A pending `AppServerClient` request and a later one both fail. The error is listed as a cleanup error once death follows.
  - Spawn failure. With `pid` undefined, the instance never joins the registry, `close` and `closeOwnedCodexProcesses` resolve, and the intercepted `kill` sees no call. `exited` rejects with the original spawn error, and no unhandled rejection is reported when nothing else observes it.
  - `runSetupChild`. A birthless spawn rejects with the original spawn error well before the 300-second timer. A child that exits 0 returns its output, and a non-zero exit, an abort, and the timer keep today's errors. A post-birth `error` without `exit` does not settle the race. The function has no cast and no branch on an error result.
  - Bridge startup failure. `startBridge` connects after a provider was born and a run task was accepted, and the connect throws. `startBridge` does not reject until that run task settled and the orchestrator's shutdown settled after the provider's death. With a clean close it rejects with the original error object. When a close also failed, it rejects with an `AggregateError` whose first error is the original one, followed by the cleanup error.
  - Repeated and concurrent shutdown. Two concurrent calls to the orchestrator's `shutdown` and to `BridgeHandle.shutdown`, and another call after them, return the same pending Promise. None settles before death, and all settle the same way after it.
  - Unheld providers. A thread removed by the idle reaper or chat eviction, with its close pending, and the utility and warm-pool clients are all awaited by the shutdown. A refill or a new `OwnedCodexProcess` after shutdown starts spawns nothing.
  - Signals and death checks. Every intercepted `kill` targets `-pid` of an instance's own group. Nothing is sent after `ESRCH` and an observed `exit`. `EPERM` on signal 0 counts as existing. Group `ESRCH` without the direct `exit` is not death.
  - ESRCH latch. After one probe throws `ESRCH`, the simulated table makes the same number exist again. The instance sends no further probe or signal to it. The simulated table models the latch only and is not evidence about OS group-ID reuse, which the accepted limit under *Signals* covers.
  - Fresh module graph. A case that needs births after a terminal `closeOwnedCodexProcesses` imports a fresh module graph. Production code has no reset function.
  - Windows, simulated platform. An observed host exit plus a verified Job proof is death. A host exit without the proof stays unconfirmed and keeps the registry pending.
  - Run `npm test -w packages/daemon -- provider-ownership`.
- [ ] `packages/daemon/test/provider-lock-retention.test.ts`, the root's integration case after P and L are merged. The real orchestrator, with the issue #50 shell and an injected thread whose group outlives the grace, runs under the real inline runner and host runtime release. Lock files in a temporary home stay held past 120 simulated seconds while `owned_work_unconfirmed` is logged. Only after the group's `ESRCH` and the observed `exit` are the per-Bot lock, `daemon.pid`, and the host mutex released, and the outcome is exit 1. Run `npm test -w packages/daemon -- provider-lock-retention`.
- [ ] `packages/daemon/test/server-drain-control.test.ts` checks the drain control in *Lifecycle ownership* over a real local WebSocket. During a held drain, a fresh client that authenticates gets `admin` `daemonStatus` with the old `pid`, and `machine` `stopHost` replies `done` with no snapshot rebuild. Any other request closes the socket with 1001 `server_shutdown`. A wrong credential gets 4401. Connections open before the drain close with 1001. The release step closes the listener and the drain connections before `daemon.pid` is released. `owner-verification`'s verified stop resolves on `done`, throws the verification error on a wrong identity or a closed socket, and sends no signal. When a drain connection's terminate throws after the listener closed, `release()` rejects with `ApiCleanupError` only after the cutoff, and a fresh server can bind the same port right away. When the listener's own close fails, `release()` rejects with an error that is not `ApiCleanupError`. When the timer's `terminate` throws for a socket that did not close, no uncaught exception escapes, and `release()` rejects with `ApiCleanupError` after the observed cutoff without waiting for the `WebSocketServer` close callback. When that `terminate` throws and the listener's close also fails, `release()` rejects with an error that is not `ApiCleanupError`. The accepted-request drain and restricted-reply cases above still pass unchanged. Run `npm test -w packages/daemon -- server-drain-control`.
- [ ] `packages/protocol/test/protocol.test.ts` parses every new request, reply, event, and job field in the contract, and still rejects a `hello` without `protocolVersion`. It parses a `backendInstall` reply with and without `omittedBytes`, and rejects a negative or fractional `omittedBytes`. Run `npm test -w packages/protocol`.
- [ ] The full suite passes under `npm test -w packages/daemon` with every skip recorded. The test mapping table from *Deleting `src/web`* is in the PR evidence, and `grep -rnE "\.\./(\.\./)*(src/)?web/" packages/daemon/src packages/daemon/test` finds nothing.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Use the V2 Feishu fixture rules. Lanes 1, 5, 6, 8, and 10 and the connected perf probe connect the fixture Bot. They run serially, one at a time, and no V2 process is connected to that Bot while a V3 process is. The other lanes use a copy of the fixture home with every Bot inactive. Each data root has exactly one daemon writing it at a time.
- [ ] Lane 1. Regression lane against trunk. Prepare fixture home `H` with these contents. The fixture Bot is active and at least one other registered Bot is inactive. The private test group is bound, there are at least two projects, and one project has three or more sessions. Record `sha256sum` of `bots.json` and of every `bots/*/config.json`, `projects.json`, and `sessions.json` under `H`. Send no Feishu message during the lane.
  - At V2 head, run `vonvon daemon run` on `H` and wait for the connected log line. Read the port and token from `H/web-console.json`. Read `GET /api/state`, then `GET /api/project/<name>/sessions?bot=<appId>` for every Bot and project in it. Stop it with SIGTERM and wait until its lock files are gone.
  - At V3 head, run `vonvon daemon start --port 0` on `H` and wait for the connected log line. Read `admin` `state`, then `settings` `sessions` for the same Bots and projects, then `snapshot` `get`.
  - On each side, before the final read, repeat the state read every 5 s until two consecutive reads agree on every `avatarDataUrl`, for up to 60 s. Fail if a side never settles.
  - Save `state-parity.txt` with both raw documents, the normalized diff, and the checksums. Leave out credentials and tokens.
  - Pass when every check below holds.
    - The checksums match before, between, and after the two runs.
    - `state` equals the HTTP body key for key and value for value, with arrays in order. That covers every Bot field, including `avatarDataUrl`, `connection`, and `completionReminder`. It covers every project field, including `sessionCount`, and whether `projectsError` is present. A key present on one side and absent on the other fails.
    - Only these values are exempt from the cross-side comparison, and each is checked on its own side instead. `version` equals the daemon package version at that head. `generatedAt` is an integer inside that read's send-to-receive window. For a running Bot, `pid` is a live process in that head's daemon tree, and `startedAt` lies between that daemon's start and the read. For a Bot that is not running, `pid` and `startedAt` are absent on both sides.
    - For every Bot and project, the `settings` `sessions` array equals the HTTP `sessions` array in order and in every field: `threadId`, `chatId`, `summary`, `backend`, `model`, `createdAt`, and `updatedAt`. Its length equals that project's `sessionCount`.
    - In the `snapshot` `get` reply, `agents`, `groups`, `memberships`, and `stale` equal the ported `projectState` applied to the settled V3 `state`.
- [ ] Lane 2. Connect without a credential. Save `no-cred.txt`. Pass when the socket closes with code 4401.
- [ ] Lane 3. Run `vonvon daemon start` twice. Save `start-twice.txt`. Pass when the second call reports the running instance and no second process exists.
- [ ] Lane 4. Kill the daemon with SIGKILL and run `vonvon daemon start`. Save `stale-lock.txt`. Pass when the stale lock is replaced and the daemon starts.
- [ ] Lane 5. Toggle a bot off through the RPC. Save `toggle.txt`. Pass when the snapshot revision increases and the bot child process exits.
- [ ] Lane 6. Subscribe two clients and change a project setting from one. Save `fanout.txt`. Pass when both receive the new revision.
- [ ] Lane 7. Browse directories from home down two levels. Save `browse.txt`. Pass when entries are listed, and a path outside home and a symlink under home that resolves outside it are both refused with `outside_home`.
- [ ] Lane 8. Browse to a temp folder under home, take its token from `directory` `choose`, and bind a group with `command` `bindGroup`. Save `bind-rpc.txt`. Pass when `projects.json` lists the group with that `cwd`.
- [ ] Lane 9. Send a request with an unknown method. Save `unknown.txt`. Pass when the reply is an error envelope with code `unknown_method` and the socket stays open.
- [ ] Lane 10. Run `vonvon daemon stop`. Save `stop.txt`. Pass when the process exits, the lock file is gone, and bots disconnect.
- [ ] Lifecycle proofs, in addition to the ten lanes and never in place of one. Each runs the actual `vonvon` CLI per the boot recipe, on its own temporary `VONVON_HOME`, with every Bot inactive and no Feishu connection. A fake `npm` placed first on the daemon's `PATH` stands in for npm. On `install` it prints its arguments with start and end times, creates `node_modules/<pkg>/package.json` under `--prefix` and adds the dependency, traps SIGTERM, and sleeps for the time the proof sets. These proofs are controlled, and the PR calls them that.
  - Long-drain restart. Start with `--port 0` and record the port `P`. Start `environment` `backendInstall` for `claude-agent` with the fake npm sleeping 45 s, then send `command` `restartHost`. Save `restart-long-drain.txt`. Pass when all of the following hold. The reply is `applied`. At 35 s the old `pid` is alive, `daemon.pid` still names it with `listen` `127.0.0.1:P`, the helper is alive, and only one host daemon runs for that home. At 35 s `vonvon daemon status --json` also succeeds and reports the old `pid`, which shows that a fresh CLI can verify the owner during the drain. After the fake npm exits and the old daemon releases the lock, exactly one new daemon runs, with a new `pid` and `listen` `127.0.0.1:P`. `backendsDir` holds no partial package after the rollback. The log has `daemon-restart` `replaced`. No second replacement appears within 15 s.
  - Stop during a pending restart. Use the same hold, send `restartHost`, then run `vonvon daemon stop` 20 s into the hold. Save `stop-wins.txt`. Pass when `stop` authenticates without the `Cannot verify daemon owner` message, prints progress, and exits 0 only after the old daemon exits. The lock file must be gone, no helper or daemon may run for that home 15 s later, and the log must have `cancelled`.
  - Port mismatch. With the daemon on `P`, run `vonvon daemon start --port <Q>`. Save `start-port-mismatch.txt`. Pass when it exits non-zero, names `127.0.0.1:P`, and no second process exists.
  - Serialized installs. Install `claude-agent` once with a short fake npm, then set the fake npm to sleep 20 s. Send the next three requests one at a time, sending each only after the previous one's admission is observed, all while the update's npm is held. Send `backendInstall` for `claude-agent` with `update` true from client 1 and wait for its reply, which arrives at admission. Send `backendUninstall` for `claude-agent` from client 2. Its reply waits for the removal, so wait instead for the `backend-queue` `reserved` log line for that uninstall. Then send `backendInstall` for `claude-agent` with `update` false from client 1 and wait for its reply. The recorded admission order comes from those replies and that log line, not from a new wire field. Save `installer-serial.txt`. Pass when the fake npm's intervals never overlap and follow the recorded admission order. The uninstall reply must arrive after the update settled and report the removal, not `并未装在用户目录`. Every `backendInstall` reply and live stream must satisfy the continuation rule.
  - Log burst. Turn `followLogs` on, then append 8 MiB of mixed ASCII, CJK, and emoji lines to today's log in one write. Save `log-burst.txt`. Pass when every `log` event's `lines` is at most 65,536 bytes and no event holds U+FFFD. The replay's `lines` followed by every later event's `lines` must equal the log file's bytes from the first replayed byte to the file's final size, read independently and compared by sha256. The socket must stay open.
  - Service refusal. On the Mac, with a temporary `VONVON_HOME`, record a listing with sha256 of every file in `~/Library/LaunchAgents`. Then run `vonvon service install` and `vonvon service uninstall`. Save `service-refusal.txt`. Pass when each exits 1 with the refusal message and the listing afterwards is identical. The proof runs no `launchctl` or `systemctl` command and touches no bridge identity.

No native service check runs in V3, because V3 installs no service, per *Lifecycle ownership*. Native launchd and systemd acceptance belongs to V5's *Service gate*.

Issue #50 adds no live proof. Holding a real Codex group past its SIGKILL would need a real provider, which these lanes do not run. Its unit and integration cases use a simulated process table, and the PR says so. The ten lanes and the six lifecycle proofs above still run on the final frozen head, which includes the issue #50 repair. CLI transcripts record the product as Vonvon Bot, never Paseo. Every lane leaves the original bridge process and its registrations untouched.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round trip of `admin` `state` and of `snapshot` `get`, each against `GET /api/state`, as p50 and p95 over 200 calls. Also the comparable and wire sizes of `admin` `state` against the HTTP body. `admin` `state` carries the same information as `GET /api/state`. `snapshot` `get` carries different information, so it gets the latency rule and its size is only recorded.
- [ ] Probe, alternating.
  - Copy `H` byte for byte to `H2` and `H3`, and set every Bot inactive in both `bots.json` files.
  - Run V2 head on `H2` and V3 head on `H3` at the same time. Each daemon is the only writer of its own copy, and neither connects to Feishu.
  - Use one Node script with one keep-alive HTTP agent and one authenticated WebSocket. Discard 20 warm-up calls per path.
  - Run 200 rounds. Each round makes one HTTP call, one `admin` `state` call, and one `snapshot` `get` call, rotating their order every round.
  - Time each call from send until the reply is parsed. Take p50 and p95 by nearest rank.
- [ ] Probe, connected.
  - On `H` with the fixture Bot active, run ten serial blocks in the order V2, V3, V3, V2, V2, V3, V3, V2, V2, V3. Only one head runs at a time, started and stopped as in lane 1.
  - Each block waits for the connected line and settled avatars, then discards five calls.
  - Each V2 block then times 40 HTTP calls. Each V3 block times 40 `admin` `state` calls and 40 `snapshot` `get` calls, alternating. That gives 200 calls per path.
- [ ] Payload. Comparable bytes are the UTF-8 length of compact `JSON.stringify` of the HTTP body and of the reply's `state`, after `generatedAt` and every `pid` and `startedAt` are set to 0. Wire bytes are the whole WebSocket text frame including the envelope, against the HTTP status line, headers, and body. Measure both uncompressed. Record the `snapshot` `get` frame size.
- [ ] Baseline. Record the V2 HTTP numbers of each probe first.
- [ ] Rule. Apply each check to both probes.
  - Fail if `admin` `state` p95 or `snapshot` `get` p95 is more than 20% above the HTTP p95.
  - Fail if the comparable bytes of `state` exceed those of the HTTP body.
  - Fail if the wire bytes of `state` exceed those of the HTTP response.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

V3's surface is the CLI and the WebSocket API, so it keeps the CLI evidence bundle under *Interaction evidence* instead of a terminal screenshot and a video.

- [ ] Copy lane 3 and lane 10 transcripts into `~/vonvon-review/V3-review-cli.txt`.
- [ ] Produce the CLI evidence bundle at the frozen head in `~/vonvon-review/V3-cli-evidence/`, with these steps. `<p>` is the port from step 2. Assertions marked *both* hold in both passes, and the rest hold in the structured pass.
  1. `vonvon daemon start --port 0`. Exit 0, *both*.
  2. `vonvon daemon status --json`. Exit 0, *both*. Standard output parses as JSON with `running: true`, a `pid` equal to the one in `$VONVON_HOME/daemon.pid`, that process alive, `listen` matching `127.0.0.1:<p>` with `<p>` above 0, and `version` equal to the daemon package version.
  3. `vonvon daemon start`. The exit code is the same in both passes and in lane 3. Standard output or error names the running `pid` and `listen`. A process listing taken right after shows exactly one host daemon for this `VONVON_HOME`.
  4. The `packages/client` snapshot script from **You see**. Exit 0, *both*. Standard output parses as a `DesktopSnapshot` with the built protocol package, with `revision` 1 or more.
  5. `vonvon service install`. Exit 1, *both*. Standard error contains the refusal message under *Lifecycle ownership* exactly. A listing with sha256 of the operator's real `~/Library/LaunchAgents`, read without writing, and of the whole temporary `HOME`, taken before step 5 and after step 6, is identical.
  6. `vonvon service uninstall`. The same as step 5.
  7. `vonvon daemon stop`. Exit 0, *both*. Afterwards `daemon.pid` is absent and the `pid` from step 2 no longer runs.
  8. `vonvon daemon status --json`. Exit 0, *both*, with `running: false`.
  9. `vonvon daemon stop`. Exit 0, *both*, printing `already stopped`.
  - Across all steps, no output file and no byte of `terminal.typescript` contains the hex text of `$VONVON_HOME/local-credential`, and the product is named Vonvon Bot, never Paseo. The original bridge's process and its registration, read before and after from the operator's account without change, are the same.
- [ ] The independent check of the bundle under *Interaction evidence* passes, by an audit lane that did not produce it.
- [ ] Earlier receipts stay as they were. The capture attempt in which the runtime denied native Terminal automation produced no screenshot and no video, and it stays recorded as an unmet capture at its head. It is not a pass. Old-head results, such as the `b7` lanes, probes, and reviews, are evidence for that head only. The bundle is a new run at the current frozen head, recorded separately.
- [ ] Save the bundle and both manifests with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V3 only after the exact-head independent Shipping verdict is clean.

## Port the UI to a web client served by the daemon (V4)

**Depends on.** V3. Development starts from `H3`, and acceptance and merge follow V3, per *Dependencies*. V4 publishes the freeze point `F4`.

**Files.**

- [ ] Create `packages/ui/` from `desktop/renderer/` at `origin/codex/device-handoff`.
- [ ] Create `packages/ui/src/client-context.tsx`.
- [ ] Extend `packages/client` with the exports a browser page and an Electron preload need. The V3 local transport shells out to the CLI and uses the Node `ws` API, so it cannot run in either. The RPC and event shapes do not change.
- [ ] Create `packages/daemon/src/server/web-ui.ts`, and mount it in `server/http.ts`.
- [ ] Create `packages/daemon/src/cli/commands/open.ts`. The root registers it in `cli/index.ts`.
- [ ] Create `.agents/skills/verify/` through `/create-verification-skill`.
- [ ] Edit `packages/daemon/src/server/rpc/command.ts`, `environment.ts`, `machine.ts`, and `settings.ts` only for the branches *Browser coverage* assigns to the daemon. Create `packages/daemon/src/environment/` for the environment logic ported from the old `desktop/main/environment.ts`.
- [ ] Create `packages/daemon/test/web-rpc-coverage.test.ts`, `environment-rpc.test.ts`, and `settings-executable.test.ts`.

*Browser coverage.* At `H3`, many request variants that the old renderer sent still return `unsupported`. Lane 2 and lane 7 need them to work, and a disabled control does not count as acceptance. No request, reply, or event shape changes. Every variant the old renderer sent gets exactly one of three owners. The old behavior reference is `desktop/main/{index,controller,environment,machine,collaboration}.ts` at `fab5237`.

- Daemon branch, added in V4.
  - `command.refresh`. Rebuild the snapshot and reply `applied` with the new revision, as the old controller's refresh did.
  - Every `environment` variant that is still `unsupported`: `scan`, `install`, `update`, `uninstall`, `toolInstallStatus`, `cancelInstall`, `authStatus`, `startLogin`, `loginStatus`, `cancelLogin`, `profileList`, `profileUse`, `profileAdd`, `profileInit`, `profileInitStatus`, and `profileInitCancel`. Port the logic from the old `desktop/main/environment.ts` into `packages/daemon/src/environment/`. It replies with the existing `tools`, `profiles`, `auth`, `operation`, `toolInstall`, `applied`, and `refused` kinds. Installs and logins run as daemon-owned operations under V3's drain rules, the same as the existing backend install job. A stop waits for them, and a stop never abandons them.
  - `machine.status`. Build the existing `status` reply from `host/service.ts` (at `H3` `installed: false` and `running: false`), the lock owner as `{ownership: 'owned', pid}`, and the CLI path from `resolveCliBinPath()` as `cli.kind: 'ready'`. V5 changes only what `host/service.ts` reports.
  - `machine.logs`. The `logs` reply, read the same way as `admin` `logs`.
  - `settings.save` for the host `execution` section, per *Executable path*.
- UI-local, in `packages/ui`. These old actions only open or copy a URL. In a browser they run in the click handler, so they also work for a remote client after V11, where a daemon-side opener would open a window on the wrong machine. The UI does not send their requests, and the daemon branches stay `unsupported`.
  - `openEventSettings` opens the URL the request already carries. `openJobAuthorization` opens the job's `url` from the snapshot, which exists in the `qr` phase. `environment.openVerification` opens the operation's `url`. `machine.openReleases` opens the releases URL that the old `machine.ts` used. `collaboration.openGroup` opens the group link the old `collaboration.ts` built.
  - `copyJobAuthorization` writes the same job `url` through `navigator.clipboard.writeText`. `127.0.0.1` is a secure context.
  - Every URL first passes the allowlist the old main process applied, ported as a pure function with a unit test. The page opens it with `window.open(url, '_blank', 'noopener')`. The desktop shell routes this to `shell.openExternal`, per *Shell capabilities*.
  - Both are covered by existing data. The independent review read the old sources at `fab5237`. Old `collaboration.ts` builds the group link from the request's `groupId` and optional `threadId`, which the UI already has. Old `index.ts` copies exactly the controller's authorization URL for the job. The snapshot carries that URL as the job's `url`, and Codex confirms in the PR that they are the same value.
- Shell-owned, implemented by V5 through *Shell capabilities*. `settings.chooseExecutable` and `saveExecutable`, `machine.service`, `startHost`, `repairCli`, `checkDesktopUpdate`, and `installDesktopUpdate`, plus the old window-only `setLoginItem`, `hideWindow`, `quit`, and `onQuitRequested`. Each one manages the desktop app, its window, or an OS registration. A browser page cannot reach them, and a daemon cannot install, uninstall, or update the app that runs it. These daemon branches stay `unsupported`, and `machine.service` keeps V3's refusal. In the web build each control in the old pane stays visible. It shows the desktop edition note and the CLI equivalent where one exists: `vonvon daemon start` for `startHost`, and from V5 `vonvon service install` and `uninstall` for the service section. The core-update rows (`checkCoreUpdate`, `applyCoreUpdate`, `coreUpdateStatus`) and `stopHost` already work in the web build.

*Executable path.* The old pane's Codex executable row stays. It shows the host settings' effective `codexBin`, whether it comes from the saved value or the default.

- Change opens a path dialog prefilled with the current value. Save sends the existing `settings save` with scope `host`, section `execution`, the section's `revision`, and patch `{codexBin: <path>}`. **Use default** sends `{codexBin: null}`. A `conflict` reply reloads the section, as the other settings sections do.
- When the shell capability `chooseExecutablePath` exists, Change opens the native file dialog instead and saves the returned path the same way. Without it, the browser uses the path dialog.
- `settings-executable.test.ts` first records what the `H3` host save does with a bad path. If it does not already reject one, V4 adds a check in `server/rpc/settings.ts`. The path must be absolute and resolve through `realpath` to a regular file. On macOS and Linux it must be executable, and on Windows it must end in `.exe` or `.cmd`. A path that fails gets the existing `saved` reply with `rejected` and `fields: [{field: 'codexBin', message}]`, and nothing is written. Every case is tested: missing, relative, a directory, not executable, a symlink to an executable, a valid path, and `null`.
- `chooseExecutable` and `saveExecutable` stay `unsupported`. No client sends them. The old renderer used them only to get an Electron file-dialog token, and the path flow above replaces that token.

*Shell capabilities.* `F4` freezes, in `client-context.tsx`, one optional object that the UI receives beside the `VonvonClient`. It is a UI-local interface, not an RPC, and it changes no protocol shape.

- `openExternal(url)`, `chooseExecutablePath(): Promise<string | null>`, `setLoginItem(enabled)`, `hideWindow()`, `quit()`, `onQuitRequested(listener)`, `service(action)` for `install`, `start`, `stop`, and `uninstall`, `startHost(bot?: string)`, `repairCli()`, `checkDesktopUpdate()`, and `installDesktopUpdate()`.
- `startHost` takes the same optional `bot` as the frozen `machine` request `{type: 'startHost', bot?: string}` in `packages/protocol/src/machine.ts`, so the old machine pane's start control for the selected Bot keeps working on the desktop. The shell forwards the argument unchanged to its handling of that shell-owned request. No protocol, storage, or daemon service shape changes. The web build still shows the desktop-edition state and `vonvon daemon start`.
- Each member is optional. The web build passes no object. The UI checks each member it needs, and when one is missing it shows the desktop-edition state from *Browser coverage*. V5's `preload.ts` supplies the members and keeps the same names and signatures. A missing method or a changed signature goes back to Claude Code.

**Build.**

- [ ] Replace every `window.bridge` call in `App.tsx`, `SettingsPanel.tsx`, `ProjectPanel.tsx`, `JoinGroupDialog.tsx`, and `pending-groups.ts` with the injected `VonvonClient` or a member of the shell-capability object, per *Browser coverage*.
- [ ] Replace the folder picker with the directory browser RPC.
- [ ] Add the daemon branches and the UI-local actions from *Browser coverage*, and the executable path flow from *Executable path*.
- [ ] Serve the built `packages/ui/dist` from the daemon, with the local credential handed over by `vonvon open`.
- [ ] Generate the repository `verify` skill for the web UI and the desktop shell.

**You see.**

- [ ] `vonvon open` opens the browser on the daemon's page, which shows the Bot list in the original style.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The ported `tests/collaboration-navigation.test.ts`, `search.test.ts`, and `environment-presentation.test.ts` pass under `packages/ui`. Run `npm test -w packages/ui`.
- [ ] `packages/daemon/test/web-rpc-coverage.test.ts` sends one valid request for every variant of the `command`, `settings`, `collaboration`, `environment`, and `machine` unions to a daemon with fixture data. It passes when exactly the UI-local and shell-owned variants from *Browser coverage* return `unsupported`, `machine.service` returns V3's refusal, and every other reply parses under the existing reply schema. `environment-rpc.test.ts` covers each new environment branch against fake tool binaries and a fake `lark-cli`, including cancel and a stop that waits for a running operation. `settings-executable.test.ts` covers *Executable path*. Run `npm test -w packages/daemon -- web-rpc-coverage environment-rpc settings-executable`.
- [ ] A UI unit test covers the URL allowlist, and the executable row with and without `chooseExecutablePath`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Render the Bot list in the old Electron app at `origin/codex/device-handoff` with the native fixtures, and in the web UI at head with the same data. Save `bot-list.png`. Pass when both show the same bots, names, and enabled states.
- [ ] Lane 2. Open a Bot's settings pane. Save `bot-settings.png`. Pass when every section from the old pane is present, and every control in it works except the shell-owned controls from *Browser coverage*. Those show the desktop edition note, and V5 exercises them. Change the Codex executable path to a valid path, then to an invalid one, and record that the first saves and the second is rejected with nothing written.
  - Scope. Lane 2 covers the controls of the old Bot settings pane. Global navigation outside that pane is covered by lanes 1 and 8, not by lane 2.
  - The toolbar's forward button. At `fab5237` the old `LocalShell` never passes `onForward` to `SettingsToolbar`, so the button is visible and disabled, and V4 at `8ae4986` keeps that. It is a navigation placeholder, not a settings control. Keeping it disabled is baseline parity. It is neither counted as an accepted control nor as a defect, and V4 adds no forward behavior.
  - Immediate-save retry. A real, reversible failure is a valid method: make an owned copy's Bot directory unwritable (mode 0500), change a setting, see the failure with the config unchanged, restore the permission, use the real **Retry** in the UI, and see the value persisted and the initial preference restored. It uses no fake RPC reply. The result counts once a fresh independent review of that run is recorded.
  - External reauthorization. Lane 2 needs the control's entry, which starts the authorization job, reaches its `qr` phase, and opens or copies the job's `url` under *Browser coverage*, and its cancel, which ends the job with nothing saved. Completing a QR scan is required only on one condition: whether V4's diff changes the daemon's job code that consumes a completed authorization. No recorded V3 or V4 run is claimed to have completed a scan, so the exemption rests only on that code being unchanged at V4's head, which the PR shows from the diff. If V4's diff touches that code, completing the scan becomes required, and it is an operator-only action. The box then stays open until the operator scans, and it is never waived or recorded as passed without that scan.
  - Classification. A control that is unopened, disabled, or unreachable, other than the forward placeholder above and the shell-owned controls, is a code defect and fails the lane. An action only the operator can perform is listed in the PR by name as operator-only, with the exact step left. Neither is waived silently.
- [ ] Lane 3. Open a group and change its response mode to `all`. Save `group-response.png`. Pass when the UI shows the new mode and `projects.json` agrees.
- [ ] Lane 4. Bind a joined group with the directory browser. Save `bind-dialog.png`. Pass when the group appears in the list with the chosen folder.
- [ ] Lane 5. Open session history for a group and run compact. Save `history.png`. Pass when the session shows the compacted state.
- [ ] Lane 6. Open Usage. Save `usage.png`. Pass when the Codex usage windows render or an explicit not-logged-in state shows.
- [ ] Lane 7. Open Environment. Save `environment.png`. Pass when codex, claude, and lark-cli rows show detected versions.
- [ ] Lane 8. Open the search palette and jump to a settings anchor. Save `search.png`. Pass when the page scrolls to the anchor.
- [ ] Lane 9. Stop the daemon while the page is open. Save `disconnected.png`. Pass when the page shows a disconnected state and recovers after `vonvon daemon start`.
- [ ] Lane 10. Load the page without the credential. Save `no-cred.png`. Pass when the page refuses access and shows how to open it with `vonvon open`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from navigation to the Bot list painted, and the gzipped JS bundle size.
- [ ] Probe. Interleave five cold loads of the old renderer under Electron and five of the web UI in headless Chromium, read through the Performance API, plus `du` on both bundles.
- [ ] Baseline. Record the old renderer numbers first.
- [ ] Rule. Fail if the web UI paints more than 20% later or its bundle is more than 10% larger.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 1, 2, 3, and 4 screenshots into `~/vonvon-review/V4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V4-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V4 only after the exact-head independent Shipping verdict is clean.

## Wrap the UI in an Electron shell that runs the daemon (V5)

**Depends on.** V4. The shell files start from V4's branch at `F4`, and the shell's native authenticated attach unit proceeds under `F4` independently of Gates L and M. The service files and `login-item.ts` may start from the same base, including Gate L and Gate M under *Service gate contracts*, whose designs are closed. `install` and `uninstall` keep V3's refusal on every head until the rule in *Daemon files* is met. Gate L and Gate M still need their native acceptance before V5 is accepted. Acceptance needs the real `packages/ui/dist`, a Mac GUI session, which may be `clay` under the user's override, a dedicated Linux test user, and a Linux systemd user session, per *Native acceptance environment*. V5 merges after V4.

*Split.* V5 may land as two PRs when its two halves reach acceptance at different times. V5a, the shell: `packages/desktop/**` except `login-item.ts`, the *Package* files, and the root handoffs; `service install` and `uninstall` keep V3's refusal, which this plan already requires on every head before the gates are integrated, and lanes 6 and 7 stay unchecked. V5b, the service: the *Daemon files*, `login-item.ts`, Gate L, Gate M, and the native acceptance. V5b merges after V5a. V10 and V11 need only V5a. The installer that V9 links comes from a release that includes V5b. Codex decides whether to split from the branch state and records it in the PR. The split changes no design, data shape, or gate.

**Files.**

- [ ] Create `packages/desktop/src/main.ts`, `daemon-manager.ts`, `tray.ts`, `updates.ts`, and `preload.ts`.
- [ ] Create `packages/desktop/electron-builder.yml`.
- [ ] Create `packages/desktop/src/login-item.ts`, which runs `vonvon service install` and `uninstall` per *Service gate*.
- [ ] Create and edit the daemon files that *Daemon files* names, and no others.

*Service gate.* V3 refuses `vonvon service install` and `uninstall`, and its service adapters still carry the bridge identity. V5 is the first PR that installs a Vonvon service. This design settles every point the gate requires, with Gate L and Gate M under *Service gate contracts*. V3's drain, ownership, cleanup, and stop-wins rules carry over unchanged. Nothing here changes a protocol or wire shape, the pid lock, `status --json`, `update-status.json`, or any existing file under `VONVON_HOME`.

- Identity. All Vonvon names live in the new `service/identity.ts`. The adapters import their names only from it, and never import `service/control.ts`.
  - macOS. A launchd agent with label `com.vonvon.bot.daemon` and plist `~/Library/LaunchAgents/com.vonvon.bot.daemon.plist`, in the `gui/<uid>` domain.
  - Linux. A systemd user unit `vonvon-bot.service` at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/vonvon-bot.service`.
  - Windows. The value `Vonvon Bot` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Its launcher files are `vonvon-bot.vbs` and `vonvon-bot.cmd` in `VONVON_HOME\service\`. V5 creates no scheduled task, and it does not use `relaunch.json` or `__win-relaunch`.
  - No install, status, start, stop, or uninstall reads or writes a bridge label, unit, plist, unit file, Run value, scheduled task, or bridge file. V3's `__win-relaunch` and `__daemon-control` keep refusing as V3 defines them.
- One registration per OS user. The names above are fixed, so each OS user has at most one Vonvon registration, for one data root.
- Data-root ownership.
  - The definition records its data root. The plist's `EnvironmentVariables`, the unit's `Environment=`, and the `.cmd` each set `VONVON_HOME` to the `realpath` of the data root at install, and set `VONVON_SERVICE` to `launchd`, `systemd`, or `windows`. The definition is the only record, and V5 adds no new state file.
  - `service/definitions.ts` is the pure codec. It renders the plist, the unit, the `.vbs`, and the `.cmd` from `{dataRoot, port, distribution, path}`, and parses each back to the same fields or to `unrecognized`. It does no I/O. `identity.ts` holds only names and paths, and `registration.ts` holds only the reads and the classification.
  - `service/registration.ts` reads the definition back through the identity and the codec. It reports one of four states: `absent`, `ours` (same `realpath` data root), `other-root` (a different one), and `unrecognized` (the file exists but does not parse as a Vonvon definition).
  - Locators. macOS and Linux have one fixed definition path per OS user, so the path is the locator. On Windows the locator is the one global `Vonvon Bot` Run value. Registration follows it to the `.vbs` it runs, and from there to the `.cmd`, whose `VONVON_HOME` decides `ours` or `other-root`. No Run value means `absent` for every data root, and launcher files never make a root `ours`.
  - Leftover Windows launcher files. A data root's own `VONVON_HOME\service\vonvon-bot.{vbs,cmd}` that the Run value does not name are leftovers of an interrupted install or uninstall of that root. They are not a registration and no launch decision reads them. `service status` lists them, `install` for that root overwrites them in step 2, and `uninstall` for that root removes them as the resumed path below. A root never looks for leftovers under any other root, and V5 keeps no index of data roots.
  - Every service command and every launch decision for a data root goes through that check. `other-root` and `unrecognized` refuse every change, and V5 never overwrites or removes either one. The refusal names the recorded root, or the unparsed file. A data root without its own registration runs self-hosted, exactly as V3 does.
- The definition.
  - Program: the Node executable and CLI entry of the distribution that ran `install`, with `daemon run --port <P>`. The npm install uses its `node` and `bin/vonvon.mjs`. The desktop app uses its Electron binary with `ELECTRON_RUN_AS_NODE=1` and its bundled entry. Install refuses the `development` and `unknown` distributions that `service/distribution.ts` reports. At V3 that file still resolves the bridge's package name and bin. V5 changes only its resolution to the `vonvon-bot` package with `bin/vonvon.mjs`, and to the desktop app's bundled entry, keeping its result kinds. A bridge package or bin is then `unknown`.
  - Port `P` is fixed at install. It is the running daemon's port if one runs, or else `--port` if given, or else a free port chosen at install. A later launch never uses another port.
  - Environment: `VONVON_HOME`, `VONVON_SERVICE`, and the `PATH` captured at install. V5 drops V3's `CODEX_BIN` passthrough, because the daemon already reads `codexBin` from the host settings.
  - Logs: `service.log` and `service.err.log` in `VONVON_HOME`, as `common.ts` already names them.
  - launchd: `RunAtLoad` true, `KeepAlive` set to `{SuccessfulExit: false}`, and `ThrottleInterval` 5. It sets no `ExitTimeOut`, because `launchd.plist` documents 0 as infinite and says not to use it.
  - systemd: `Type=simple`, `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=infinity`, and `WantedBy=default.target`.
  - Windows: the Run value runs `wscript.exe //B <vbs>`, which starts the `.cmd` hidden. The `.cmd` runs the daemon in a loop. Exit 0 ends the loop. On any other exit, it first checks that the `Vonvon Bot` Run value still exists and ends the loop if not. Otherwise it waits 5 s, by a method that works without a console such as `ping -n 6 127.0.0.1 >nul`, and runs the daemon again.
- Exit codes. These are why the managers above relaunch only what they should. A daemon that the manager launched, where `VONVON_SERVICE` is set, ends with one of these codes.
  - 0 when, as its first action and before it touches the lock or opens a listener, it finds the registration is not `ours`. It logs `registration_absent`. This is what keeps uninstall from racing a relaunch, per *Uninstall transaction*.
  - 0 after a completed stop. Any `owned_work_unconfirmed`, `ApiCleanupError`, or `listener_close_unconfirmed` that V3 reports is still logged and returned to the stopping caller, but the code stays 0, so no manager relaunches over a stop.
  - 0 when it finds the data root's lock held by another live owner. This happens when the manager starts it next to a running self-hosted daemon. It exits before it touches anything.
  - *Pre-lock guard.* The first-action check and the live-owner exit both run in `host/bootstrap.ts` `runHostRuntime`, before its `acquireMutex` and `acquirePidLock` (V3 `host/bootstrap.ts:14-16`). `runRun` is too late, because V3 calls it only after both locks (`:25-27`). The order is as follows.
    1. A supervisor's Bot child is exempt. It is the process where `process.send` exists, the same condition under which V3 already skips both locks (`:14`). For it, the guard does nothing.
    2. If `VONVON_SERVICE` is set and `service/registration.ts` reports anything other than `ours`, it logs `registration_absent`, sets `process.exitCode = 0`, and returns. A read error counts as not `ours`.
    3. If `VONVON_SERVICE` is set and V3's `readRunningPidLock(paths.appDir)` returns a live owner, it logs `owner_present` with that owner's pid and returns with exit 0.
    4. If `VONVON_SERVICE` is not set and the registration is `ours`, it refuses as the foreground refusal below, with exit 1.
    5. Otherwise V3 proceeds to `acquireMutex` and `acquirePidLock`. If either throws for a managed launch, the guard reads `readRunningPidLock` again. If a live owner with another pid holds the lock, the launch exits 0 with `owner_present`. Otherwise it rethrows, which is a failure exit.
    - The guard returns inside V3's `try`, so V3's `finally` sees no `owner` and no `lock`. It releases nothing and writes nothing of the other owner's. V3's `preAction` lease from `enterDataAccess` (`cli/index.ts:16-17`) is still taken first and is released when the process exits. It is neither the host mutex nor the pid lock.
  - 75 after a completed restart whose intent survived to the release step. If V3 would not launch a replacement after a cleanup error, it exits 0 instead.
  - Any other code, or a signal, is a failure, and launchd and systemd relaunch it after 5 s. The Windows `.cmd` loop does the same.
- One launcher per data root. When the registration is `ours`, the OS manager, or the Windows `.cmd` loop, is the only launcher.
  - `vonvon daemon start` attaches to a running daemon and keeps V3's port-mismatch refusal. If none runs, it starts the manager's job and waits for readiness on port `P`, up to the same 25 s as V3. It runs `launchctl kickstart gui/<uid>/com.vonvon.bot.daemon` (no `-k`), bootstrapping the plist first if `launchctl print` does not find the job. On Linux it runs `systemctl --user start vonvon-bot.service`. On Windows it runs the registered `wscript.exe //B <vbs>`, detached. If that fails, it reports the manager's output and exits 1. It never falls back to a detached `daemon run`. `--port` other than `P` refuses with V3's mismatch message.
  - A foreground `vonvon daemon run` without `VONVON_SERVICE` refuses while the registration is `ours`, and points to `vonvon daemon start` and `vonvon service uninstall`. A supervisor's Bot child (`daemon run --bot`) is exempt, as V3 defines it.
  - The desktop `daemon-manager.ts` attaches the same way, and when no daemon runs it calls `vonvon daemon start`. It spawns the bundled daemon itself only when there is no `ours` registration.
  - A self-hosted daemon that was already running when `install` ran keeps running. Its next launch goes through the manager. Its V3 restart helper runs `daemon start --port P`, which now goes through the manager.
- Stop. `vonvon daemon stop` is V3's `runStop` unchanged: `stopHost` through the verified owner, then a wait with no deadline. The daemon exits 0 after its drain, so no manager relaunches it. The registration stays. Vonvon never stops a live daemon with `launchctl bootout`, `kill`, or `kickstart -k`, with `systemctl stop`, `restart`, or `kill`, or with `taskkill`. No manager stop timeout can therefore cut a drain. A logout or OS shutdown is outside Vonvon and treats a service-managed daemon the same as a self-hosted one.
- Restart, same port. `restartHost`, and `applyCoreUpdate` after its install, keep V3's drain and stop-wins rules. Once the release step completes, a manager-launched daemon exits 75, and launchd, systemd, or the `.cmd` loop starts the same definition on port `P`. A stop that arrives before the release step wins, and the daemon exits 0. A self-hosted daemon keeps V3's helper unchanged.
  - Plain `restartHost` under a manager. No helper is spawned, because the manager does the relaunch and there is no update record to complete.
  - Managed core update. The completion owner is V3's `__restart-after-exit` helper, unchanged in `host/restart.ts`. `host/lifecycle.ts` spawns it exactly as V3 does, whenever `requestRestart` receives an update record. It passes the exact frozen `restarting` record that `performCoreUpdate` wrote and returned (`phase`, `ok`, `from`, `to`, and `at`), with the old `pid`, `startedAt`, and port `P`.
    - The helper keeps every V3 rule. It waits with no deadline for the old identity to leave, and if no live owner follows, it runs `daemon start --port P`. That call now goes through the manager, and it attaches if the manager's relaunch already won. It then authenticates the replacement on `127.0.0.1:P`. `finishOwnedUpdate` writes `done` only when `update-status.json` still equals that exact record field for field under `update.lock`. It writes `error` for `superseded` and `start_failed`. It writes nothing when the record changed or a live update holds the lock.
    - Cancellation stays V3's. A stop accepted before the release step runs `cancelHelper`, which writes `error` with `重启已被停止取消`, ends the helper and observes its exit before release, and the daemon exits 0. A helper that dies before the release step gives `helper_lost`, writes `error`, and turns the restart into a stop that exits 0.
    - The replacement daemon never completes a record itself, and no process marks an arbitrary `restarting` record `done`. A plain restart leaves a stale `restarting` record untouched, as V3's update-status rule requires.
    - The helper must outlive the old daemon's exit under the manager.
      - macOS and Windows. The helper is spawned detached in its own process group, as V3 does (`host/lifecycle.ts:153`, `detached: true`). For macOS, the local `launchd.plist(5)` documents the premise under `AbandonProcessGroup`: "When a job dies, launchd kills any remaining processes with the same process group ID as the job." The detached helper is not in that group. This is documentary support, not native acceptance. Native acceptance still has to show it.
      - Linux. The helper runs in its own transient scope and must be proven ready before the daemon commits, per **Gate L** under *Service gate contracts*.
- Crash. A crash or failure exit relaunches after 5 s on port `P`, through the policy above. The new process takes the stale lock under V3's rules.
- Install transaction. `vonvon service install [--port <P>]`.
  1. Preflight, which writes nothing. The platform's manager must be usable: `launchctl print gui/<uid>` succeeds, or `systemctl --user is-system-running` reports `running` or `degraded`, or on Windows `reg query` on the Run key succeeds. The registration must be `absent` or `ours`, and the distribution must be eligible. If the registration is `ours` with a different definition, and a manager-launched daemon runs, install refuses and asks for `vonvon daemon stop` first. On macOS that replacement also refuses while any process owns the data root's lock, or while `launchctl print` reports a pid for the job. If the registration is `absent` but `launchctl print` still finds the Vonvon job, which is an interrupted uninstall, install refuses with `install_refused` and asks for `vonvon service uninstall` first.
  - Identical definition. A byte-identical file alone is not proof of an install. Install also reads the manager's state. On macOS, `launchctl print gui/<uid>/com.vonvon.bot.daemon` must find the job. On Linux, `systemctl --user is-enabled vonvon-bot.service` must report `enabled`, and the loaded unit's `FragmentPath` must be the file. On Windows, the Run value must equal the expected command.
  - If all of these hold, install reports `already installed` and exits 0 without starting anything. An installed service that the user stopped with `vonvon daemon stop` therefore stays stopped. `vonvon daemon start` starts it.
  - If any of them fails, as after an `install_incomplete` or a lost manager state, install keeps the file and resumes at step 3, then runs step 4.
  2. Write the definition to a temporary file in the target directory, `fsync` it, and rename it into place. On Windows, write both launcher files this way before setting the Run value. On an update, keep the previous definition until step 4 passes. A macOS replacement of a loaded job does this write inside step 3, after the *Unload barrier*, per Gate M.
  3. Load. On Linux, run `systemctl --user daemon-reload` and `enable --now`. On Windows, set the Run value and, if no daemon runs, start it as `daemon start` does. A job launched next to a running self-hosted daemon exits 0, per *Exit codes*. On macOS, load follows **Gate M** under *Service gate contracts*. A job that is not loaded is only bootstrapped. A loaded job is replaced only through the *Unload barrier*. Install never calls `bootout` outside it.
  4. Verify. The manager reports the job loaded or enabled, and a daemon owns the data root's lock on port `P`. If none ran before, wait up to 25 s for one.
  5. If step 2, 3, or 4 fails, roll back under the `job-only` scope from *Drain scope* below. Rollback runs uninstall's three phases on what this transaction registered: withdraw it, drain, and unload. Then it writes back the previous definition if one existed, without loading or starting it.
     - macOS: Gate M's rollback, under *Service gate contracts*.
     - Linux: withdraw is `systemctl --user disable vonvon-bot.service` and removal of the unit file this transaction wrote. The drain uses the *Manager-owner proof* with `MainPID`. Unload is `daemon-reload` and `reset-failed vonvon-bot.service`. A previous unit is written back and `enable`d without `--now`.
     - Windows: withdraw deletes the Run value. The drain can prove no owner, per the proof's Windows rule. Unload removes the launcher files this transaction wrote. Previous launcher files and Run value are written back.
     - Preflight reads the lock owner's identity `(pid, startedAt)`, or its absence, and keeps it in memory. Rollback uses it only to choose between `install_rolled_back` and `install_incomplete`. It never authorizes a stop.
     - A daemon this transaction launched is stopped only when it passes the *Manager-owner proof*, through `stopHost`, and is then awaited with no deadline. Every other lock owner is retained. Rollback never stops, signals, or waits on it, and it never blocks rollback's completion. A manager process launched beside it exits 0 under the *Pre-lock guard*.
  - Results. `installed` exits 0. `install_refused` means the preflight refused, nothing was written, and the exit is 1. Every other failure ends in exactly one row of *Outcomes* below, which gives its bytes, registration, manager, and owner state, and exits 1.
    - `install_rolled_back` means all of the following hold. The registration is as before install, with the previous job not loaded on macOS and the previous unit enabled but not started on Linux. This transaction's job is unloaded. No daemon that passed the proof still runs. The lock owner's identity equals the one preflight read, or both are absent.
    - `install_incomplete` covers everything else. That includes a rollback that undid every write but finds a lock owner whose identity differs from preflight's, which it names and retains. It prints each leftover item, file, job, Run value, or retained pid.
    - Running `install` or `uninstall` again from any of these states converges.
- Uninstall transaction. `vonvon service uninstall`.
  - The ordering rule. Uninstall first withdraws the registration, and only then stops and unloads.
    - Every manager-launched process checks the registration in the *Pre-lock guard*, before the host mutex, the pid lock, and the listener, and exits 0 when it is not `ours`, per *Exit codes*. So any process the manager starts after step 2 holds no lock and no accepted work, and an exit 0 is never relaunched.
    - Any process started before step 2 is visible as the job's pid and is handled in step 3. This rests on the manager's pid query being authoritative. Native acceptance must verify that, and a fake manager that hides a live process does not model this contract.
    - This needs no manager inhibition command, no recheck, and no new file.
  - Failure kinds. Every failed uninstall, install rollback, or Gate M barrier is one of three kinds, and *Outcomes* maps each to its result.
    - `drain-failed`. No unload command was issued. A manager pid query or a lock read errored, timed out, or returned output that did not parse, and it is never treated as "no pid". Or the drain ended with `owner_unproven`, `foreign_job_pid`, or `stop_unconfirmed`, below.
  - *Stop acknowledgment.* Every stop in every drain goes through V3's `stopVerifiedOwner(home, lock)`, directly or through `runStop`, and its contract stays `Promise<void>`, unchanged. It resolves only after the matching `done` reply (`server/owner-verification.ts:52-55`). It rejects on its 2 s timer, a socket error, or a close (`:29-35`), and those can happen after it sent `stopHost` at `:69-70`, which the owner may have accepted. The caller cannot tell a failure before the send from one after it.
    - Rule. Any rejection of a stop call is `stop_unconfirmed` with the lock's pid. The drain ends at once as `drain-failed`. It sends no second stop and no signal in that invocation, issues no unload, and writes no bytes back, so the registration stays as withdraw left it, `absent`. A relaunch exits 0 at the *Pre-lock guard*, and nothing can unload or relaunch over an owner that may be draining. If the owner accepted the stop, it finishes its drain with no deadline and exits 0. If the stop never reached it, it keeps running. The result names the pid and says which of the two cannot be told.
    - V3's helper contract does not change. A helper that reports whether `stopHost` was sent would be a new design decision, with its own signature and file handoff, and this plan does not make it.
    - The result prints `vonvon service uninstall` as the next step. That rerun resumes from `absent` under `job-only` and converges once the owner has exited or is proven again.
    - `unload-failed`, Linux and Windows only. An unload command failed. These commands signal nothing.
    - `unload-unknown`, macOS only. `bootout` was issued and returned an error or hit its bound, or the `launchctl print` after it errored or still found the job. The manager's state is unknown. Nothing is written back, and no second `bootout` is sent in that invocation.
  - Drain scope. Every transaction fixes one scope at its start and keeps it to the end. The scope governs step 3's waiting and stopping, step 4's unload condition, and step 5's completion. Nothing outside the scope can extend a drain.
    - `all-owners`: an uninstall that started from `ours`, and Gate M's install replacement barrier. Uninstall is a stop of whatever daemon owns the data root.
    - `job-only`: an uninstall resumed from `absent`, and every install rollback on every platform. It stops only a lock owner that passes the *Manager-owner proof*. Every other lock owner is retained. It is never stopped or signaled, the drain never waits on it, and it never blocks steps 4 or 5.
  - *Manager-owner proof.* Under `job-only`, a lock owner is stopped only through one proof attempt. An attempt is four observations in this order, each started after the previous one returned. It reuses nothing from an earlier attempt, and the transaction keeps no set of earlier job pids.
    1. O1, lock. V3's `readRunningPidLock(home)` returns `L1`, with pid `P`, `startedAt` `S`, and a non-null `listen`. No live lock, or a null `listen`, ends the attempt with nothing to stop yet.
    2. O2, manager. The job's current pid, from `launchctl print gui/<uid>/com.vonvon.bot.daemon` on macOS or `systemctl --user show -p MainPID --value vonvon-bot.service` on Linux. It must be exactly `P`.
    3. O3, lock again. `readRunningPidLock(home)` must return a lock equal to `L1` in `pid`, `startedAt`, and `listen`.
    4. O4, owner. V3's `stopVerifiedOwner(home, L1)`, unchanged. It sends `stopHost` only after the authenticated endpoint at `listen` answers `daemonStatus` with `running` and `pid === P`, and only after its own re-read of the lock still equals `L1` with a running owner (`server/owner-verification.ts:58-70`).
    - Why a passing attempt proves the incarnation. Let W be the process that wrote `L1`. V3 writes `pid` and `startedAt` once, when it acquires the lock (`server/pid-lock.ts:89-101`), and `publishPidLock` only adds `listen` for the same owner (`:110-116`). A V3 daemon listens only after it acquires the lock and closes its listener before it releases it (`host/bootstrap.ts:14-41`). The daemon that answered at O4 has pid `P` and serves on `listen`, while the lock still names `(P, S)`. By A2 below, no other incarnation writes `(P, S)`, so that daemon is W, alive at O4. W was alive at `S`, before O1, and a process lives over one interval, so W held pid `P` from O1 through O4. By A1, the pid the manager reports at O2 is held by its own child, live or not yet reaped, and no other process can hold that pid then. So W was the job's process at O2. The proof never links a later lock to an earlier observation.
    - Assumptions.
      - A1, the manager's pid query is authoritative. It reports a pid only while the job's child exists, live or not yet reaped, and the kernel does not reuse a pid before its parent reaps it. Native acceptance must confirm A1, and a fake manager that hides a live process does not model it.
      - A2, `(pid, startedAt)` names one incarnation. `startedAt` is wall-clock milliseconds written at acquisition. Two daemons with the same pid acquire at least one process lifetime and one Node startup apart, so an equal pair needs the wall clock to step backward by exactly that gap. A2 is a residual of V3's existing lock format, which V5 does not extend. If A2 fails, the proof can at worst stop a Vonvon daemon of this data root that answers with this root's credential.
    - Reuse cases. Each one ends with no `stopHost` and no signal to the later process, and with that process's `daemon.pid` and work unchanged. In the second and fourth, the refusal is a rejection of `stopVerifiedOwner` before its send, which the caller sees only as a rejection, so the attempt is `stop-unconfirmed` below. No stop was sent in these traces, and the tests assert that.
      - The earlier job child exits before the attempt, and a self-hosted daemon gets the reused pid `P` and the lock. O2 reports no pid or another pid, because by A1 the manager cannot report a pid its child no longer holds.
      - Reuse between O1 and O2. W exits after O1, and a new manager child gets pid `P`, so O2 reports `P`. O3 may still return W's stale lock as running, because `isPidLockOwnerRunning` only probes the pid. O4 fails, because no daemon answers as `P` on `listen`: the new child exits 0 at the *Pre-lock guard* and never listens.
      - Reuse between O2 and O3. The lock now names another `startedAt`, so O3 differs from `L1`.
      - Reuse between O3 and O4. `stopVerifiedOwner`'s own re-read differs from `L1`, so it throws before `stopHost`.
    - Attempt results.
      - `proven`. O4 sent `stopHost` and got `done`. The drain then waits with no deadline until `readRunningPidLock` no longer returns `(P, S)`, as `runStop` waits.
      - `not-job`. O1 found no live published lock, or O2 reported no pid or another pid. Any lock owner is retained for this attempt.
      - `unproven`. O2 reported `P`, but O3 failed. O4 was never called, so no stop was sent. The owner is retained for this attempt.
      - `stop-unconfirmed`. O4 rejected. A stop may have been sent and accepted. The drain ends at once as `drain-failed` with `stop_unconfirmed` and pid `P`, under the *Stop acknowledgment* rule.
    - Positive path. A manager child that has not yet published the lock is a job pid without the lock. When the same process later publishes it, the next attempt is `proven`, and the child is stopped and awaited with no deadline.
    - Termination. Attempts run at least 250 ms apart. Two consecutive `unproven` attempts on the same `(P, S)` end the drain as `drain-failed` with `owner_unproven` and pid `P`. No stop was sent, because O4 never ran, and nothing is unloaded, because the job may still run a process that holds this root's lock and its work.
    - Windows has no manager query that reports the daemon's pid, so O2 never matches there. Under `job-only` on Windows, no lock owner is ever stopped.
    - No file, field, or wire shape is added. The proof uses only `daemon.pid`, the manager query, and V3's owner verification. It lives in the new `service/drain.ts`, with the manager query injected per platform.
  1. Preflight. `ours` runs every step under `all-owners`. `absent` reports `not installed` and exits 0, unless a leftover remains: on macOS `launchctl print` finds the Vonvon job, on Linux `systemctl --user show -p LoadState vonvon-bot.service` reports anything other than `not-found`, and on Windows this root's own launcher files exist. That is an interrupted uninstall. It skips step 2 and runs steps 3 to 5 under `job-only`, with no kept bytes. `other-root` and `unrecognized` refuse.
  2. Withdraw, without signaling anything. Keep the definition's bytes in memory for rollback.
     - macOS: remove the plist.
     - Linux: `systemctl --user disable vonvon-bot.service`, then remove the unit file.
     - Windows: delete the Run value, which also ends the `.cmd` loop's relaunch.
  3. Drain. It repeats rounds until one round sees nothing to wait for. Each round makes one manager pid query and one lock read, and any failure of either is `drain-failed`.
     - `all-owners`. Wait while the data root's lock has a live owner or the manager reports a job pid. A live owner is stopped through V3's `runStop`, after its readiness, with no deadline and stop-wins. A rejected stop ends the drain as `stop_unconfirmed`, per *Stop acknowledgment*. A job pid that does not own the lock may be a process before its registration check, or one that read `ours` before step 2 and has not yet taken the lock. The drain waits for it with no deadline until it exits 0 or takes the lock, and then stops it as above.
     - `job-only`. Wait only while the manager reports a job pid `J`. The lock is consulted only through proof attempts.
       - If a live lock owner exists, run one *Manager-owner proof* attempt. `proven` stops and awaits it. `not-job` and `unproven` retain it for this round. `stop-unconfirmed` ends the drain.
       - If `J` holds no live lock of this root, the rule depends on the transaction. In an install rollback, `J` is the job this transaction loaded with this root's definition, so the drain waits for it with no deadline until it exits, as it does at the *Pre-lock guard* beside a retained owner, or until it publishes the lock and a later attempt proves it. In an uninstall resumed from `absent`, the definition is gone and `J` may belong to another data root. `J` is never signaled, and the drain ends at once as `drain-failed` with `foreign_job_pid` `J`, asking for `vonvon daemon stop` under that pid's `VONVON_HOME`.
       - A round with no job pid ends the drain, whatever owns the lock. On Windows there is no job pid, so the drain ends after its first lock read.
  4. Unload, only when step 3's last round saw no job pid and, under `all-owners`, no live lock owner. Under `job-only`, the lock is not part of this condition.
     - macOS: `launchctl bootout gui/<uid>/com.vonvon.bot.daemon`. The only process it can still reach is one started after step 2, which holds no lock and no accepted work and is already exiting 0. On macOS, steps 2 to 5 are the *Unload barrier* that Gate M reuses, and this is the only `bootout` call in the code.
     - Linux: `systemctl --user daemon-reload` and `reset-failed vonvon-bot.service`. Neither signals anything.
     - Windows: remove the launcher files.
  5. Verify. The definition and the job must be gone: on macOS a `launchctl print` after `bootout` reports the job not found, on Linux `LoadState` is `not-found`, and on Windows the Run value and this root's launcher files are absent. A macOS failure here is `unload-unknown`, and a Linux or Windows failure is `unload-failed`.
     - Under `all-owners`, a live lock owner seen here is stopped as in step 3, and unload is not repeated. A rejected stop here is `stop_unconfirmed`: nothing is written back, and the result is `uninstall_incomplete` naming the pid.
     - Under `job-only`, the lock is not a completion condition. A retained owner keeps running, the result prints its pid, and the transaction completes.
     - The log files stay.
  - *Outcomes.* Each uninstall, and each install that does not end in `installed`, `install_refused`, `already installed`, or a refusal, ends in exactly one row. An uninstall from `absent` with no leftover reports `not installed` and has no row. "Kept bytes" are the definition bytes that this invocation's own withdraw removed. An uninstall resumed from `absent` has none. "Previous bytes" are the definition that existed before an install, on an update or replacement. Writing bytes back means a temporary file, `fsync`, and rename, then `enable` without `--now` on Linux, or setting the Run value back on Windows. It never loads a macOS job or starts a daemon.
    - In every row, a retained owner keeps its pid, `startedAt`, and work, and receives nothing. A daemon whose stop was confirmed by `done` finishes its drain with no deadline and stays stopped. No daemon is force-stopped.
    - Where bytes may be written back. Only where the row says so: kept bytes after `drain-failed` other than `stop_unconfirmed`, kept bytes after Linux or Windows `unload-failed` of an uninstall, previous bytes after a successful install rollback, and previous bytes after Linux or Windows rollback `unload-failed`. In each of these, every stop the transaction sent was confirmed by `done`, or none was sent.
    - Where nothing is written back. After macOS `unload-unknown`, which includes a `bootout` that errored or hit its bound and a `launchctl print` after it that errored or still found the job, nothing is written back, the registration stays `absent` so any relaunch exits 0 before the lock, and no second `bootout` is sent in that invocation. A later `bootout` happens only in a fresh `install` or `uninstall`, which starts again from withdraw and drain. After `stop_unconfirmed`, likewise nothing is written back and nothing is unloaded, per *Stop acknowledgment*.

    | Transaction | Failure | Bytes written back | Registration after | Manager and daemons after | Result |
    | --- | --- | --- | --- | --- | --- |
    | Uninstall from `ours` | none | none | `absent` | The job is gone. The daemon drained after a confirmed stop and stays stopped. | `uninstalled`, exit 0 |
    | Uninstall from `ours` | `drain-failed`, except `stop_unconfirmed` | the kept bytes | `ours` | Job still loaded or enabled. An owner whose stop was confirmed drains and stays stopped. One not yet asked keeps running. | `uninstall_rolled_back`, naming the error |
    | Uninstall from `ours` | `stop_unconfirmed`, in step 3 or step 5 | none | `absent` | In step 3 nothing was unloaded, and the job may stay loaded with no definition, so a relaunch exits 0 before the lock. In step 5 the job is already gone. Owner `P` drains with no deadline and exits 0 if it accepted the stop, or keeps running if the stop never reached it. | `uninstall_incomplete`, naming `stop_unconfirmed` and `P` |
    | Uninstall from `ours` | `unload-failed` (Linux, Windows) | the kept bytes; on Windows only where the OS permits replacement, per *Windows unload refusal* | `ours`; on Windows `ours` only when both launchers and the Run value equal the kept definition, otherwise `absent` with leftover launcher files | Unit enabled and not started, or Run value back. The daemon stays stopped. | `uninstall_rolled_back`, naming the command; on Windows `uninstall_incomplete`, naming each refused path, when the kept state is not restored and verified |
    | Uninstall from `ours` | `unload-unknown` (macOS) | none | `absent` | One `bootout` was sent. `jobPresent` is `true`, `false`, or `unknown` from one `launchctl print`. The daemon stays stopped. | `uninstall_incomplete` with `jobPresent` |
    | Uninstall resumed from `absent` | none | none | `absent` | The job is gone. A retained owner runs unchanged. | `uninstalled`, exit 0, printing any retained pid |
    | Uninstall resumed from `absent` | `drain-failed`, including `foreign_job_pid`, `owner_unproven`, and `stop_unconfirmed` | none | `absent` | Nothing was unloaded or signaled. A retained owner runs unchanged. After `stop_unconfirmed`, owner `P` may be draining instead, as in the row above. | `uninstall_incomplete`, naming the error or pid |
    | Uninstall resumed from `absent` | `unload-failed` (Linux, Windows) | none | `absent` | A retained owner runs unchanged. | `uninstall_incomplete`, naming the command |
    | Uninstall resumed from `absent` | `unload-unknown` (macOS) | none | `absent` | One `bootout` was sent. A retained owner runs unchanged. | `uninstall_incomplete` with `jobPresent` |
    | macOS install replacement | barrier `drain-failed`, except `stop_unconfirmed` | the kept bytes, which are the previous plist | `ours`, previous definition | The previous job is still loaded. The new plist was never written. | `install_rolled_back` or `install_incomplete` by the owner-identity rule in *Results* |
    | macOS install replacement | barrier `stop_unconfirmed` | none | `absent` | The previous job is still loaded with no plist, so a relaunch exits 0 before the lock. Owner `P` may be draining. The new plist was never written. | `install_incomplete`, naming `P`. The previous definition is not restored. |
    | macOS install replacement | barrier `unload-unknown` | none | `absent` | One `bootout` was sent. The new plist was never written. | `install_incomplete` with `jobPresent`. The previous definition is not restored. |
    | Install rollback, any platform | none | the previous bytes if they existed, otherwise none | `ours` with the previous definition, or `absent` | This transaction's job is unloaded. A daemon that passed the proof is stopped. Any other owner is retained. | `install_rolled_back` or `install_incomplete` by the owner-identity rule |
    | Install rollback, any platform | `drain-failed`, except `stop_unconfirmed` | the kept bytes, which are this transaction's new definition, so the file matches the job still loaded | `ours`, new definition | Nothing was unloaded. Any daemon of the job keeps running. | `install_incomplete`, naming the error and that the previous definition was not restored |
    | Install rollback, macOS or Linux | `stop_unconfirmed` | none | `absent` | Nothing was unloaded. This transaction's job may stay loaded with no definition, so a relaunch exits 0 before the lock. Owner `P` may be draining. Windows never stops under `job-only`, so it has no such row. | `install_incomplete`, naming `P` and that neither the new nor the previous definition was restored |
    | Install rollback, Linux or Windows | `unload-failed` | Linux: the previous unit if it existed, otherwise none. Windows: the previous launchers and Run value, written back only where the OS permits, per *Windows unload refusal* below | Linux: `ours` with the previous definition, or `absent`. Windows: `ours` with the previous definition only when both launchers and the Run value equal it, otherwise `absent` with leftover launcher files | Linux: the manager may still hold this transaction's unit. Windows: no process is affected; a launcher at each refused path keeps this transaction's bytes | Linux: `install_incomplete`, naming the command. Windows: `install_rolled_back` only when the end state is the previous definition exactly, verified by a fresh observation, and the full *Results* predicate holds, including a lock owner identity equal to preflight's or both absent, naming the refused deletion; otherwise `install_incomplete`, naming each refused path with its OS error and any changed owner, which is retained |
    | Install rollback, macOS | `unload-unknown` | none | `absent` | One `bootout` was sent. | `install_incomplete` with `jobPresent`. The previous definition is not restored. |
    | Install rollback, macOS | `loaded` is `false` but `launchctl print` finds the job | the previous bytes if they existed, otherwise the new plist is removed | `ours` with the previous definition, or `absent` | No barrier ran, so no `bootout` and no stop. | `install_incomplete`, naming the job |
    - *Windows unload refusal.* Windows unload and write-back are file operations, and the OS may refuse one of them indefinitely: a deny-delete ACL, a sharing violation from an open handle, or any error other than `ENOENT`. No sequence of calls makes a refused path absent, so the former reading of row 16 as "the previous launchers, otherwise none" on disk was unreachable under such a refusal, and the contract is the exact remnant instead. Rollback's unload attempts the deletion of each launcher this transaction wrote, and only those, per step 5's Windows rule, so a launcher whose bytes already equaled the new definition is never deleted. Each path is attempted independently, in deletion and in write-back alike; one path's error never suppresses the other where independent safe work remains, and every refused path and its error are aggregated into the detail. Write-back restores each previous launcher by atomic replacement, a different operation that a refused deletion does not imply is refused, and writes the Run value only after both launchers equal the previous definition. Where the OS refuses both deletion and replacement, the file keeps this transaction's bytes and the Run value stays absent. The two end states below are stated only for a transaction whose withdrawal was confirmed and whose final observation succeeded: every launcher read and compared, and the Run value read. A read that fails, a Run mutation or its readback that fails, or a mutation that errors after it may have taken effect leaves that path or the Run value unknown. The public result is then `install_incomplete`, naming the unknown path or Run state; a withdrawal that is not confirmed is the internal `withdrawal-failed` removal result, which `install` reports as `install_incomplete` and which prevents any launcher deletion. It never asserts `install_rolled_back`, never writes the Run value back when launcher verification failed, performs no additional Run mutation after a Run command whose readback failed, so the Run state is reported unknown rather than absent or unwritten, and never labels an unreadable path absent. A temporary file that cannot be cleaned is an additional leftover. A launcher or Run value that changed under the transaction, observed by its check before each mutation, ends the transaction fail-closed with no further write at that path and no Run write-back, naming the change, as the existing check-before-mutation rule requires; independent cleanup touches only this root's own two launcher paths after that check. After a successful observation the end state is one of two: the previous definition exactly; or the Run value absent and each launcher absent, equal to the previous bytes, or holding this transaction's bytes at a refused path, which the leftover rule under *Daemon files* already classifies as a leftover launcher file that no launch decision reads. The result's launcher leftovers match the observed files exactly; the result also lists the Run value, a retained pid, and temporary files as it does today. No owner is stopped, signaled, or awaited by any of this, and the transaction's one launch is not repeated. Convergence is by registration, not by a single branch. With the Run value absent, `uninstall` resumes from `absent` under `job-only`, attempts each remaining launcher independently, removes those the OS permits, and returns `uninstall_incomplete` naming each still-refused path while the refusal persists, so the remnant can shrink to the refused paths alone; once the refusal clears, `uninstalled`, then `not-installed`. With the Run value restored, so registration `ours`, `uninstall` runs under `all-owners` and is the `unload-failed` row above: where deletion is refused but replacement permitted it restores the kept launchers and Run value and returns `uninstall_rolled_back`; where a kept launcher cannot be restored, it returns `uninstall_incomplete` with the Run value absent and the exact residual files. `install` over a remnant overwrites it in step 2 when replacement is permitted. Convergence after a fault clears assumes a fresh command, a successful observation, and no intervening foreign registration or file change; nothing converges while the OS keeps refusing. Nothing here renames a refused file aside, keeps a quarantine, or adds a durable record; the remnant is the file itself, and the refusal is reported, not promised away.
  - Results. `uninstalled` exits 0. `uninstall_rolled_back` and `uninstall_incomplete` exit 1. Every `*_incomplete` prints its leftovers, and rerunning `install` or `uninstall` converges.
- **Open at login** and other entry points.
  - `login-item.ts` runs the same `vonvon service install` and `uninstall` that the CLI runs, from the app's own distribution, and shows their result. Turning it on installs. Turning it off uninstalls, which stops the daemon after its drain. The shell then starts a self-hosted daemon through `daemon-manager.ts` while its window is open.
  - The snapshot's `application.loginItem` is true exactly when the registration is `ours`.
  - The snapshot's platform enum has no Linux value and its shape is frozen, so the desktop app offers no login toggle on Linux. Linux users run `vonvon service install`.
  - The daemon's `machine.service` keeps V3's refusal, because a daemon cannot uninstall the service that runs it. The UI sends service actions through the shell capability `service(action)`, which runs the CLI. The web build shows the CLI commands.
  - `vonvon service status [--json]` prints the registration state and the manager's view. `--json` uses the existing `serviceStatusSchema` shape.
  - `host/service.ts` reports `supported`, `installed`, and `running` from the registration and the lock. `machine.status` and `admin` `daemonStatus` read it there, with their shapes unchanged.

*Service gate contracts.* The second independent review proved two paths unsafe as first written: Gate L and Gate M. The contracts below close both designs. Each still needs its deterministic tests and native acceptance, and V5 is accepted only with them, as with every other V5 box.

- **Gate L. Linux managed-core-update helper readiness before release.**
  - The defect it closes. V3 wakes shutdown on the child's `spawn` event (`host/lifecycle.ts:170-174`), and it can then commit and release (`:119-124`). It treats helper death as `helper_lost` only before commit (`:163-167`). Under `systemd-run --user --scope`, `spawn` shows only that `systemd-run` was executed. systemd v255's `src/run/run.c` still sends `StartTransientUnit` (`:1570-1601`), waits for the manager's job (`:1619-1623`), and only then calls `execvpe` (`:1721`). With an empty drain the daemon could exit 75 while `systemd-run` is still in `vonvon-bot.service`'s cgroup.
  - What the source supports. With `--scope`, `systemd-run` puts its own pid in the scope's `PIDs` (`run.c:942-975`) and then replaces itself with the command through `execvpe` (`:1721`). It runs no wrapper process, so the helper keeps the pid of the child that the daemon spawned. Option parsing stops at the first non-option, because the option string starts with `+` (`:254`). `--wait`, `--pty`, `--pipe`, `--remain-after-exit`, and `--service-type` are rejected with `--scope` (`:616-651`), so none is used. `systemd-run` may replace `argv[0]` with an absolute path (`:1927-1938`), so the readiness check below never compares `argv[0]`. The source gives no readiness signal. Readiness is therefore observed from outside, as below.
  - Launch. On a managed core update on Linux, `host/lifecycle.ts` spawns `systemd-run` with exactly `['--user', '--scope', '--quiet', '--unit=<scope>', process.execPath, ...helperArgs]`. `<scope>` is `vonvon-bot-update-<16 lowercase hex from crypto.randomBytes(8)>.scope`. `helperArgs` is V3's exact list: `cliEntry`, `__restart-after-exit`, the port, the pid, `startedAt`, and the JSON update record. The child is spawned `detached: true` with `stdio: 'ignore'`, as V3 does. `systemd-run` is resolved through the service's `PATH`. A spawn error is V3's `error` path, which gives `helper_lost` before commit.
  - The readiness proof. The helper is ready when one poll of the owned child's pid, while V3 has not yet seen that child exit, finds both of the following.
    - Scope entry. `/proc/<pid>/cgroup` has a `0::` line whose path's last component is exactly `<scope>`, and no component of that path is `vonvon-bot.service`.
    - Helper launch. `/proc/<pid>/cmdline`, split on NUL with the trailing empty item dropped, has `slice(1)` exactly equal to `helperArgs`. Before `execvpe`, that pid's command line is `systemd-run`'s own, whose second item is `--user`. Only after `execvpe` succeeds can it match.
    - Any read error, any parse failure, or a host with no `0::` line counts as not ready for that poll. The check is the pure function `linuxHelperReady(cgroup: string, cmdline: string[], scope: string, helperArgs: string[]): boolean`.
    - Readiness is the same standard V3 already applies on macOS and Windows, where `spawn` proves the helper image was executed: here, the helper image was executed inside its own scope. A helper that dies after readiness and commit is V3's existing post-commit case. It is not a launch failure.
  - Internal state, in `host/lifecycle.ts` only. No wire, storage, or file shape changes. `RestartHelper` gains:
    ```ts
    readiness:
      | { kind: 'immediate' }                                    // self-hosted, macOS, Windows: V3's spawn event
      | { kind: 'pending'; scope: string; helperArgs: string[]; deadlineAt: number }
      | { kind: 'ready' };
    settled: Promise<void>; // resolves once readiness leaves 'pending', or the child dies
    poll?: NodeJS.Timeout;
    ```
    - Lifetime and ownership. The `observeShutdown` closure creates the state in `requestRestart` and alone mutates it. It enters `pending` at creation. Polling starts on the child's `spawn` event, every 50 ms, and stops on `ready`, on observed death, or on cancellation. `deadlineAt` is 25 s after `spawn`, the same bound as V3's start readiness. The clock, the timer, and a `readProc(pid, 'cgroup' | 'cmdline')` reader are injected through an internal options argument for tests.
    - Transitions. `pending` becomes `ready` when the proof above holds, which resolves `settled`. Observed death in `pending` keeps V3's `died` handling, which is `helper_lost` before commit, and also resolves `settled`. When `deadlineAt` passes in `pending`, the daemon cancels the helper exactly like `cancelHelper`: it marks it cancelled, writes `error` with `helper_lost` through `finishOwnedUpdate`, sends `SIGTERM` to the owned pid, and sends `SIGKILL` after 5 s. It then sets the intent to stop and wakes. A stop in `pending` runs V3's `cancelHelper` unchanged.
    - The commit barrier. `complete()` gains one check, after V3's wait for a cancelled helper: while a helper exists, is not dead, and is `pending`, await `settled` and loop. So no release step runs before readiness, whatever the drain does. An empty drain only reaches this barrier sooner.
  - Why ownership holds during setup. Moving a pid between cgroups does not change its parent. Through scope setup and after `execvpe`, the daemon's owned child is the same pid. `cancelHelper`'s signals and V3's death observation (`:122`) therefore reach the right process at every stage. A cancelled `systemd-run` leaves at most an empty transient scope named `<scope>`, which is used once.
  - Failures before commit all end as V3's stop with the exact record set to `error`, and none can happen after commit: `systemd-run` missing, a refused `StartTransientUnit`, a failed scope job, a failed `execvpe`, a hang past `deadlineAt`, or a stop.
  - Deterministic tests, in `service-launch.test.ts`, with a fake child, a fake `readProc`, and a fake clock:
    - Delayed scope registration. The cgroup stays in `vonvon-bot.service` for several polls, then moves to `<scope>` while the command line is still `systemd-run`'s, then the command line changes. `release` is not called before the last poll.
    - Scope failure after the OS spawn. The child emits `spawn`, then exits 1 before readiness. The result is `helper_lost`, the exact record becomes `error`, the daemon exits 0, there is no 75, and `release` runs once.
    - A stop during scope setup. A stop in `pending` sends `SIGTERM` to the same pid, and `SIGKILL` after 5 s if the fake ignores it. `release` waits for the observed exit. The record becomes `重启已被停止取消`, and the exit is 0. Also a stop before `spawn`, and a stop after `ready` but before commit.
    - An otherwise empty drain. `completeShutdown` is called right after `requestRestart`. It does not commit until `ready`, then exits 75.
    - Readiness expiry. The proof never holds, and at `deadlineAt` the result is `helper_lost`, the wait for death, and exit 0.
    - `linuxHelperReady` cases: no `0::` line, a path under `vonvon-bot.service`, a different scope name, `argv[0]` rewritten to an absolute path (still ready), extra or missing helper args (not ready), and a read error.
    - The argv and spawn options above, exactly.
- **Gate M. macOS install load, replacement, and rollback unload.**
  - The defect it closes. Calling `bootout` after seeing a loaded job with no pid, while the definition is present, is a check-then-use race. A job in its 5 s crash backoff can relaunch in between, read `ours`, take the lock, and accept work, and `bootout` then subjects that work to launchd's finite `ExitTimeOut`.
  - *Unload barrier.* This is the macOS uninstall's steps 2 to 5, and it is the only code path that calls `bootout`. It is one function, `unloadBarrier(scope, context)`, in `service/launchd.ts`, and its drain is `service/drain.ts`. Its state lives only in memory for one CLI invocation. Nothing is persisted, and there is no wire shape.
    ```ts
    type OwnerIdentity = { pid: number; startedAt: string };   // read from daemon.pid, never persisted by V5
    type DrainScope =
      | { kind: 'all-owners' }   // uninstall from `ours`, and the install replacement barrier
      | { kind: 'job-only' };    // every install rollback, and uninstall resumed from `absent`
    type BarrierContext = 'uninstall' | 'uninstall-resumed' | 'install-replacement' | 'install-rollback';
    type BarrierResult =
      | { kind: 'unloaded'; retained: OwnerIdentity | null }                  // job gone; retained owner untouched
      | { kind: 'drain-failed'; reason: 'query_failed' | 'owner_unproven' | 'foreign_job_pid' | 'stop_unconfirmed'; detail: string } // no bootout
      | { kind: 'unload-unknown'; error: string; jobPresent: boolean | 'unknown' }; // one bootout, outcome unknown
    ```
    - B1 withdraws. Keep the plist's bytes in memory, and remove the plist. From here on the registration is `absent`, so any process launchd starts exits 0 under the *Pre-lock guard*, before the mutex and the pid lock. `uninstall-resumed` has no plist, so B1 does nothing and keeps no bytes.
    - B2 drains, as uninstall step 3 under the given scope. `all-owners` stops any live owner through V3's `stopVerifiedOwner(home, lock)` for the exact lock it just read, then awaits it with no deadline as `runStop` waits, and awaits a job pid without the lock with no deadline. `job-only` stops only through a *Manager-owner proof* attempt and waits only while the job reports a pid. In `install-rollback` a job pid without the lock is awaited with no deadline, and in `uninstall-resumed` it ends B2 as `foreign_job_pid`. Under either scope, a lock that changed between the read and the stop is never stopped, because `stopVerifiedOwner` rereads it before the send. That refusal, like every other rejection of the stop call, ends B2 as `drain-failed stop_unconfirmed`, per *Stop acknowledgment*.
    - B3 unloads. It runs only when B2's last round saw no job pid and, under `all-owners`, no live lock owner. It issues `launchctl bootout gui/<uid>/com.vonvon.bot.daemon` once, with a 30 s bound on the `launchctl` client, then runs one `launchctl print`. A retained owner is not the job's process, so `bootout` cannot reach it. A process launched between B2's last round and B3 holds no lock and no work.
    - Failure. The barrier itself writes nothing back. `drain-failed` means `bootout` was never issued, and the caller writes back the bytes B1 kept, if any, per *Outcomes*, except after `stop_unconfirmed`, where it writes nothing back. `unload-unknown` means `bootout` returned an error or hit its bound, in which case only the `launchctl` client is killed, or the `print` after it errored or still found the job. The barrier sets `jobPresent` from that one `print`, issues no second `bootout`, and returns. The caller writes nothing back, so the registration stays `absent`, and reports the row from *Outcomes*. A later `bootout` happens only in a fresh barrier run, when the user reruns `install` or `uninstall`, and that run starts again at B1 and B2.
  - Install on macOS, step 3, by the job's state from `launchctl print gui/<uid>/com.vonvon.bot.daemon`.
    - Print fails for any reason. The job is treated as not loaded. Write the new plist per step 2, then `launchctl bootstrap gui/<uid> <plist>`. No `bootout`. If the job was in fact loaded, `bootstrap` fails and rollback runs. Rollback has loaded nothing, so it only restores the file. If a later `launchctl print` then finds the job, the result is `install_incomplete`, which names it, and rerunning converges. A wrong "not loaded" therefore can never reach `bootout`.
    - Print finds the job, and the plist is byte-identical. This is step 1's `already installed`.
    - Print finds the job, and the definition differs: a replacement. Step 1 has refused if a daemon owns the lock or the job has a pid. Run `unloadBarrier({kind: 'all-owners'}, 'install-replacement')`. B2 still stops, with no deadline, any process that won a relaunch race since preflight. With the registration `ours`, no self-hosted daemon can start after preflight, because the foreground run refuses and `daemon start` goes through the manager. If the barrier returns `drain-failed` or `unload-unknown`, install stops there with the row from *Outcomes*, and writes no new plist. Then write the new plist per step 2, and `bootstrap`. `RunAtLoad` starts the new daemon, and step 4 verifies it. On an update, step 2's previous definition is the bytes B1 kept.
  - Rollback on macOS, step 5.
    - The transaction keeps `loaded: boolean` in memory. It is `true` only when this transaction's own `launchctl bootstrap` returned success. A `bootstrap` that failed, or hit its 30 s bound, leaves it `false`, even if a later `launchctl print` finds a job. Rollback never unloads a job that this transaction cannot prove it loaded. That case is `install_incomplete`, which names the job, and a rerun of `vonvon service uninstall` resumes from `absent`.
    - If `loaded` is `true`, run `unloadBarrier({kind: 'job-only'}, 'install-rollback')` on the new plist. B2 stops, through `stopHost` with no deadline, only a lock owner that passes the *Manager-owner proof*. A self-hosted owner that ran before install is retained, with its identity and work. Its manager duplicate exits 0 at the *Pre-lock guard*, so the job soon reports no pid and B3 proceeds.
    - After `unloaded`, write back the previous plist's bytes, if there were any, and do not `bootstrap` them. The job stays unloaded with its old definition on disk. `vonvon daemon start` bootstraps it, per *Launch*, and so does the next login. An identical reinstall resumes load, per step 1. The printed reason states that the previous job is unloaded until then.
    - Every result, including `drain-failed` and `unload-unknown`, is the matching install-rollback row of *Outcomes*. A fresh install with a retained self-hosted owner and no prior plist ends `install_rolled_back` with no registration, this transaction's job unloaded, and the owner running with its preflight identity.
    - Installed-but-stopped convergence is unchanged. An identical reinstall of a loaded job stays a no-op.
  - Deterministic tests, in `service-transaction.test.ts`, with a fake `launchctl` whose pid query never hides a live process:
    - Replacement with a relaunch between preflight's no-pid observation and B1. The relaunched process reads `ours` and takes the lock. B2 stops it through `runStop`, with no deadline. `bootout` comes only after that.
    - Replacement with a relaunch after B1. The process reads `absent` and exits 0 before the lock, and is never signaled. `bootout` follows B2's empty observation.
    - Replacement with a relaunch between B2's last observation and B3. It exits 0 before the lock. No process holding the lock or accepted work is ever booted out.
    - The same three interleavings in rollback after a failed step 4, against the job the transaction bootstrapped.
    - A fresh install with a live self-hosted owner. `bootstrap` succeeds, the job's duplicate exits 0 at the *Pre-lock guard*, and the step 4 verify query fails. Rollback runs `job-only`. It sends no `stopHost` and no signal to the original owner, whose `daemon.pid` identity and in-flight fake work are unchanged. It boots out only this transaction's job and removes only the plist it wrote.
    - The same owner with a partial load: `bootstrap` errors or times out, and `launchctl print` then finds the job. `loaded` stays `false`, there is no `bootout` and no stop, and the result is `install_incomplete`. A following `vonvon service uninstall` resumes from `absent` with `job-only`, and it also never stops or signals that owner.
    - Positive proof. In rollback, the self-hosted owner exits during the transaction, and a job process takes the lock and publishes `listen`. O1 to O3 match, and O4 stops it through `stopHost`. The fake keeps its drain open across many simulated minutes; B2 waits with no deadline, and `bootout` comes only after it exits.
    - Pid reuse, each under `job-only` with the fake clock and pid table. (a) An earlier job child exits and an unrelated self-hosted daemon takes the lock with the same pid. (b) A new manager child takes pid `P` between O1 and O2 while W's lock stays on disk, the second reuse case of the *Manager-owner proof*: O2 reports `P`, O3 still equals `L1`, and O4's authenticated status does not answer as `P` on `listen`, so `stopVerifiedOwner` refuses before its send. (c) The manager's pid changes between O2 and O3, after it matched. (d) The lock is replaced between O3 and O4, so `stopVerifiedOwner`'s own re-read refuses. Each asserts zero `stopHost` calls, zero signals, and an unchanged `daemon.pid` and fake work for the owner present at the end. (a) and (c) then reach `unloaded` with that owner retained, or `owner_unproven` when two consecutive attempts on the same identity are `unproven`. (b) and (d) end at once as `drain-failed stop_unconfirmed`, with no `bootout` and nothing written back. (b) needs two tests. The existing stale-lock endpoint mismatch case replaces the fake pid table's generation and makes the authenticated endpoint answer as another pid while the old lock stays on disk and no child exits; it proves the real helper's O4 refusal with zero `stopHost` under a modeled generation and endpoint mismatch, not the child lifecycle. A composed case, not yet written, must model W's exit, a new manager child at pid `P` that reads `absent` and exits 0 at the *Pre-lock guard* without listening, O1 to O3 matching on W's stale lock, and the same O4 refusal. The pre-lock compositions in `service-prelock.test.ts` do not supply that interleaving.
    - A lock that changes between O1 and O2 is not (b). Until 2026-10-12 this bullet named (b) as "the lock changes between O1 and O2" and demanded `stop_unconfirmed` with no `bootout`. That wording contradicted the *Manager-owner proof*'s own results: `stop_unconfirmed` exists only when O4 rejected and a stop may have been sent, and a lock that O3 finds changed is `unproven`. Reporting `stop_unconfirmed` for an attempt that never called O4 would misname the state and leave the job loaded with no plist. The rerun of `uninstall` that the message demands starts a fresh barrier and may observe a live job, a query failure, or a different owner, so nothing about that rerun justifies the change; the reason is the contradiction with the proof's O3 and O4 results. The contract for that change is the proof as written, in two traces, each under `job-only` in rollback with the fake clock and pid table:
      - (e) Old child still visible. O1 reads `(P, S0)` with `listen`. Before O2, another self-hosted process `Q` publishes `(Q, S1)`. O2 reports `P`, so O3 differs from `L1` and the attempt is `unproven`; O4 is never called. The next round reads `(Q, S1)` and O2 still reports `P`, a job pid that does not own the lock, which rollback awaits. When the manager reports no pid, B2 ends `drained` and B3 issues its one `bootout`. `P` is not `owner_unproven`, because its second observation is the job-pid-without-lock branch, not a second `unproven` on `(P, S0)`. The present candidate case reaps `P` at the first pause after the `unproven` attempt, so its next round reads `(Q, S1)` and sees no pid; it covers the O3 mismatch and the empty-manager `bootout` but not the `(Q, S1)` with `P` wait round. Keeping (e) requires new test work that adds that round and asserts, in order: lock `(Q, S1)`, manager `P`, no `stopHost`, no `owner_unproven`, then the reap, lock `(Q, S1)`, manager no pid, one `bootout`.
      - (f) Same pid reused after reap. O1 reads `(P, S0)`. Before O2, that process exits and is reaped, and an unrelated self-hosted process with the reused pid `P` publishes `(P, S1)`. O2 reports no pid, by A1, so B2 ends `drained` on that round without O3 or O4, and B3 issues its one `bootout`. This is (a) with the exit timed inside the attempt.
      - Each of (e) and (f) asserts, in order: withdrawal, the O1 bytes, the published bytes, the O2 pid, and a manager observation of no pid after withdrawal before the one `bootout`. It asserts zero `stopHost` calls, zero endpoint status requests, zero signals, exactly one `bootout`, the final `daemon.pid` bytes and fake work equal to those the new owner published, the plist absent, and the result by the owner-identity rule in *Results*, which is `install_incomplete` when that owner differs from the preflight owner. `bootout` is safe for the reason B3 states: the manager reported no child after withdrawal, so by A1 no job process exists to receive it, and the retained owner is not the job's process. The drain's `retained` value is its last lock snapshot and may be stale after (f); the transaction's result and its `install_rolled_back` versus `install_incomplete` choice come from a fresh lock read after the barrier, and the tests check that read against the final bytes. The fake pid table models A1 and does not prove it: native acceptance must still show a real `launchctl print` reporting no pid once the child is reaped, under *Native acceptance environment*. Replacing the two old-contract assertions in the present candidate, once this contract is accepted, covers (f) and the shortened (e) only; the (e) wait round and the composed (b) lifecycle are separate test obligations, and no test is marked expected-failing meanwhile.
    - Stop accepted, reply lost. Under `all-owners` in replacement and under `job-only` in rollback, the fake owner receives `stopHost`, starts a drain that the fake holds open across many simulated minutes, and its socket closes, or the 2 s timer fires, before `done`. The result is `drain-failed stop_unconfirmed` with exactly one `stopHost` call, no second stop, no signal, no `bootout`, no plist written, and the registration `absent`. The fake owner's drain then runs to its end and it exits 0, with nothing imposing a deadline. A following `vonvon service uninstall` converges.
    - Resumed uninstall on macOS, Linux and Windows, with a live self-hosted owner and a leftover job. Each returns `uninstalled` with exit 0, prints the retained pid, issues exactly one `bootout` on macOS, leaves the registration absent and the owner's identity and work unchanged, and finishes within a bounded number of fake rounds. A leftover job pid that holds no lock gives `drain-failed foreign_job_pid`, with no `bootout` and no signal.
    - A pid query error, timeout, or unparsable output in B2, during replacement and during rollback. The result is `drain-failed query_failed`, no `bootout` is issued, and only the bytes the *Outcomes* row names are written back.
    - `bootout` rejected by the fake, `bootout` that removes the job on the manager side and then exceeds its 30 s bound, and a `print` after `bootout` that errors or still finds the job. Each gives `unload-unknown` with exactly one `bootout` call, no second one, the plist still removed, and the *Outcomes* row naming `jobPresent`.
    - One test per *Outcomes* row that applies to macOS, asserting the result, the exit code, the bytes on disk, the registration, the ordered fake `launchctl` calls, and the retained identity or its absence.
    - Print failure with the job actually loaded. `bootstrap` fails, there is no `bootout`, and the result is `install_incomplete` or `install_rolled_back` as above.
    - An interrupted-uninstall leftover. The job is loaded with no plist, install refuses, and nothing is written.
    - Every fake `bootout` call is preceded in the same transaction by plist removal, and by a round made after that removal that saw no job pid. Under `all-owners`, that round also saw no live lock owner. Under `job-only`, every `stopHost` sent was preceded by O1 to O3 matching on the same identity.

*Daemon files.* V5 creates and edits only these daemon files.

- Create `service/identity.ts` (the names), `service/definitions.ts` (the pure codec), `service/registration.ts` (reading back and classifying a definition), `service/drain.ts` (drain rounds and the *Manager-owner proof*), and `service/windows.ts` (the HKCU Run and launcher transactions).
- Edit `service/distribution.ts`: resolution only, per *Program*.
- Edit `server/web-ui.ts`: the UI root resolution only, per *Package*.
- Edit `service/launchd.ts`, `systemd.ts`, `win-startup.ts`, `adapter.ts`, and `common.ts`: transactions and `start`, rendering through `definitions.ts`. Remove their imports of `control.ts` and `codex-bin.ts`, and the Windows relauncher.
- Edit `cli/commands/service.ts`: `install`, `uninstall`, and `status` in place of the refusal. `status --json` is read-only and may land on any earlier head. `install` and `uninstall` keep V3's refusal on every head until that head has the transactions, the *Pre-lock guard*, Gate L, Gate M, and their deterministic tests. No intermediate head calls a bridge-derived mutating adapter.
- Edit `cli/commands/daemon.ts`: `runStart` routing through the manager. `runStop` is unchanged.
- Edit `host/bootstrap.ts`: the *Pre-lock guard*, meaning the registration check, the live-owner exit 0, and the foreground refusal, before `acquireMutex` and `acquirePidLock`, plus the managed lock-collision exit 0.
- Edit `cli/commands/run.ts` only if the stop exit 0 and restart exit 75 mapping in *Exit codes* is settled there rather than in `host/bootstrap.ts`. It gets no registration check.
- Edit `host/lifecycle.ts`: for a manager-launched daemon, no helper on a plain restart, and the detached helper with its exact update record on a managed core update on macOS and Windows. On Linux, the `systemd-run` scope launch, the readiness state, and the commit barrier of Gate L. Exit 75 after the release step.
- `host/restart.ts` and `service/update.ts` stay unchanged. Managed update completion reuses the helper and `finishOwnedUpdate` as they are.
- Edit `host/service.ts`: status from the registration. Its actions keep refusing.
- Tests. Create `packages/daemon/test/service-identity.test.ts`, `service-definition.test.ts`, `service-transaction.test.ts`, and `service-launch.test.ts`.
- Root handoffs. `cli/index.ts`: add exactly `install --port <P>` and `status --json` to the existing `service` registration, per *Shared files*. The daemon side adds no package dependency. The desktop's own dependencies, such as Electron and electron-builder, go to the root under *Shared files*. The root adds the script `"pack:vonvon-bot": "node scripts/pack-vonvon-bot.mjs"` to the root `package.json`, per *Package*.

*Package.* The `global-npm` distribution is the npm tarball `vonvon-bot-<version>.tgz`. V5 builds it so that the systemd half of the native box can install it. V5 publishes it to no registry. Publication and the registry name are release decisions outside V5. The package adds no wire, storage, or `VONVON_HOME` shape.

- Layout. The package root holds `package.json`, `bin/vonvon.mjs` copied from the daemon, `dist/cli.js` as the daemon bundle, `ui/dist/**` copied from `packages/ui/dist`, the daemon's `LICENSE.bridge`, `LICENSE.paseo`, `NOTICE`, `PROVENANCE.md`, and `import-core.json`, `build-manifest.json`, and `node_modules/**` with every runtime dependency. `dist/cli.js` must sit one level below the root, because `core/version.ts`, `service/update.ts`, and `service/common.ts` read `package.json` and `bin/vonvon.mjs` from the parent of `dist/`, and `classifyDistribution` requires both files.
- `package.json`. `name` is `vonvon-bot`. `version`, `engines`, `license`, `author`, and `dependencies` are copied from `packages/daemon/package.json`, so `status --json` reports the daemon package version. `type` is `module`. `bin` is exactly `{"vonvon": "bin/vonvon.mjs"}`. `bundleDependencies` lists every name in `dependencies`. The file has no `private`, `scripts`, or `devDependencies`.
- Staging. `scripts/stage-daemon.mjs` exports the daemon staging that `packages/desktop/build.mjs` does today: the esbuild bundle of `src/cli/index.ts` to `dist/cli.js` with `packages: 'external'`, `bin/`, the five daemon files, and the recursive copy of the resolved dependency tree. That copy includes the `@vonvon/client` and `@vonvon/protocol` package directories with their built `dist`, and their own nested dependencies such as `zod` 3. `build.mjs` calls it with the `@vonvon/daemon` `package.json` it writes today, and its `stage/daemon` output stays byte-identical. `pack-vonvon-bot.mjs` calls it with the `vonvon-bot` `package.json`. Both distributions therefore ship the same `dist/cli.js` and dependency tree. A later PR that adds a file to the daemon bundle adds it in `stage-daemon.mjs` through a root handoff.
- UI root. `server/web-ui.ts` chooses its root once, at load. It uses the package-local `new URL('../ui/dist/', import.meta.url)` when `index.html` exists there. Otherwise it uses the current `../../ui/dist/`, which serves the workspace and the desktop app. The choice is a pure exported function of the module URL and an existence check.
- `scripts/pack-vonvon-bot.mjs --out <dir>`. It refuses when `git status --porcelain` is not empty, when `--out` is inside the repository, or when `packages/ui/dist/index.html`, `packages/protocol/dist/index.js`, or `packages/client/dist/index.js` is missing. It stages into a fresh temporary directory and copies the UI. It refuses when the staged tree contains a `*.node` file or a `package.json` with `os`, `cpu`, or `gypfile`, because those make the tarball platform-specific. Install scripts follow `scripts/vonvon-bot-install-scripts.json`. Each entry pins a package name, its version, its lockfile `integrity`, the exact lifecycle script string, and the sha256 of every file that script runs. It also states why the package works without the script. The pack refuses any staged `preinstall`, `install`, or `postinstall` script that no entry matches exactly. A matched script stays in the package unchanged and never runs, because every install of the package uses `--ignore-scripts`. At V5 `0dd2a99` the runtime closure has one such script. protobufjs 7.6.6, integrity `sha512-dYDWdjSl5RNb7SgPxGQcRU+GtvP7s2fpkrY0r432PcOIaZ0/rBcxEZnQN67iJhFuQiVw754JDoPruPCNdGsbjg==`, has `postinstall` `node scripts/postinstall`, and `scripts/postinstall.js` has sha256 `5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c`. That script only writes a version-range warning to standard error. It creates no file and makes no network request, so the package works without it. A new entry is a design change returned to Claude Code. It writes `build-manifest.json`, runs `npm pack --ignore-scripts --pack-destination <dir>`, deletes the stage, and writes `<tarball>.manifest.json` with the tarball's sha256.
- `build-manifest.json` is `{schema: 1, package, version, sourceHead, lockfileSha256, node, npm, esbuild, files}`. `files` lists `{path, sha256, mode}` for every file in the package except the manifest itself, sorted by path. It holds no time, host name, or user name, so equal inputs give equal bytes.
- `scripts/check-vonvon-bot-package.mjs <tarball> --head <sha>` reads only the tarball. It checks the layout and the `package.json` fields above. It checks that every non-optional dependency of every bundled `package.json` resolves inside the tarball's `node_modules`, that `sourceHead` equals `--head`, that every file's hash matches the manifest with no unlisted file, that no refused item is present, and that every `preinstall`, `install`, or `postinstall` script in the tarball matches an allowlist entry exactly, including the sha256 of its script file. It prints a JSON report and exits 0 only when every check holds.
- `scripts/smoke-vonvon-bot-package.mjs --installed <dir> --port <P> --manifest <file>` uses a temporary `VONVON_HOME`, or the path given by `--home <absolute path>`. That path must be an existing empty directory owned by the caller whose `realpath` equals the argument. The script prints `{"smokeHome":"<path>"}` as its first stdout line, and removes the home on success as before and runs `<dir>/bin/vonvon.mjs` with `process.execPath`. It runs `daemon start --port <P>`. `daemon status --json` must report `running: true`, `listen` `127.0.0.1:<P>`, and the package version. `GET /` must return 200 with the bytes of `<dir>/ui/dist/index.html`. Then `daemon stop` must exit 0, status must report `running: false`, and `daemon.pid` must not exist. It also checks the installed files against the manifest. It installs no service and replaces no native step.
- Where it runs. The Linux host procedure is *Packaged build of the frozen head* in [native-acceptance-hosts.md](native-acceptance-hosts.md). It covers two packs with equal sha256, the checker, a second clone, an offline install from an empty cache into the user-local Node prefix, the smoke check, and a checkout negative control. On the Mac, Codex runs the pack, the checker, and the smoke check against an `--offline --ignore-scripts` install into a temporary prefix, and records the tarball sha256 beside the Linux one. A checkout build, `npm pack` of `@vonvon/daemon`, or a fixture package never stands in for this package in a native box.

*Native acceptance environment.* Root's read-only preflight, recorded for this design, is the following. On the Mac, the user `test-user` (uid 502) exists but has no `gui/502` domain. `ci-user` is reserved for CI. On Linux, the `operator` user's systemd user manager runs, but no dedicated test user is confirmed.

- Mac. Native acceptance needs a user with a GUI login session, because the product registers in `gui/<uid>`. `test-user` qualifies once someone logs it in through Fast User Switching or Screen Sharing and leaves the session up for the run. `user/<uid>` bootstrapping does not substitute for it. `test-user` is the context for V8's Mac lanes, because they install or import the bridge label `ai.feishu-codex-bridge.bot`, which the daily bridge holds in `clay`'s domain. Logging `test-user` in is user action. The root sets Remote Login and Codex's key for `test-user` when `clay` has administrator rights. Otherwise they join the same user request.
- Mac, user override of 2026-10-11. The user directly authorized testing in the operator's account `clay` in answer to the V5/V8 account question. V5 can use that account for the macOS half of the native box below and lane 6. V8 is also authorized, but its import lanes reach the bridge service of the calling user, and the daily bridge holds that label in this session. V8's lanes therefore run in the dedicated contexts under V8's *Lane context*; this is an operational constraint, not an authorization gap. Neither version may touch or restart the daily bridge. In `clay` these rules hold, and a run that cannot keep one leaves its box unchecked.
  - Owned data only. Every app and CLI invocation in the run gets a run-owned temporary `VONVON_HOME`, never `~/.vonvon-bot`, and the run deletes it at the end.
  - Owned service only. The product label `com.vonvon.bot.daemon` and its plist path are fixed by `identity.ts` and are not renamed. The read-only preflight must find no `gui/<clay uid>/com.vonvon.bot.daemon` job and no plist at that path. Otherwise the run does not start. The run creates that job and plist, and removes them at the end through `uninstall`.
  - Daily services untouched. The run never loads, unloads, kickstarts, signals, or edits `ai.feishu-codex-bridge.bot`, the bridge's data, or any other LaunchAgent, and never changes the mode of `~/Library/LaunchAgents`. It never uses `ci-user`. No production service identity changes.
  - Bridge preserved. Preflight and step 12 record the running bridge's pid, its start time from `ps -o lstart= -p <pid>`, and its TCP listeners from `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN`. Root's evidence names PID 2253. If preflight finds a different pid, the run records that and applies the rule to the current pid. Any difference in pid, start time, or listeners stops the run and fails the box. The bridge is never restarted to repair it. Before the run, the three mutex ports of the run's `VONVON_HOME`, computed as under *Run listeners* in native-acceptance-hosts.md, must be absent from `lsof -nP -iTCP -sTCP:LISTEN`.
  - Step 11 in `clay` injects the failure only through a run-owned path, for example a read-only placeholder file created at the product's exact plist path and removed afterwards. The pass criterion is unchanged.
- The override is the user's, recorded here and not inferred from capacity. On Linux, the user granted root SSH to the Tencent host `203.0.113.10` for independent use. Linux preparation therefore needs no further user permission. It waits only for the accepted design, its independent review, and the root's assignment.
- Linux. The test user is `accept-user` on the Tencent host `203.0.113.10`. It is a regular user with its own home, no sudo rule, `loginctl enable-linger`, and caps on its `user-<uid>.slice`. The run uses that user's own `systemctl --user`, with `XDG_RUNTIME_DIR=/run/user/<uid>`. The root prepares the host, and Codex runs each frozen head there, only by the sequence in [native-acceptance-hosts.md](native-acceptance-hosts.md). That sequence takes the protective record B0 before any write, reads back the slice caps before any user process, takes a checkpoint record after every state change, runs the owned teardown, and compares a final record with B0. Any difference in a compared production field stops the run and leaves the box unchecked. The host shares its kernel, disk, I/O, network, and journal with production, and that document names what is capped and what is only monitored. The fallback is a Linux VM on the Mac with a systemd user session, under the same user and teardown rules. The `operator` account is never the test user.
- Windows. No native host is available. The Windows adapter is covered by unit tests with an injected registry and process runner, and by the hosted Windows CI job. No test writes the real Run key. Windows relaunch stays unverified on a real host, as `roadmap.md` records.
- Only the V5 native box waits for these. All other V5 work proceeds.

**Build.**

- [ ] `daemon-manager.ts` attaches to a running daemon. When none runs, it calls `vonvon daemon start` if the data root's registration is `ours`, and otherwise starts the bundled daemon with `ELECTRON_RUN_AS_NODE=1`, following Paseo `packages/desktop/src/daemon/node-entrypoint-launcher.ts`.
- [ ] The window loads `packages/ui/dist` and passes the local credential and the shell-capability object from V4's *Shell capabilities* through `preload.ts`. `openExternal` uses `shell.openExternal` after the same URL allowlist, and `window.open` from the page goes there through `setWindowOpenHandler`.
- [ ] Port the tray, single-instance lock, and auto-update from `desktop/main/index.ts` and `updates.ts` at `origin/codex/device-handoff`. Pick a PNG tray icon on Linux, because `new Tray()` with an `.ico` path hangs there.
- [ ] Restart from the window. The bridge hands `command` `restartHost` to the shell instead of sending it straight to the daemon. The shell marks the coming disconnect as expected and sends the command over the attached connection. It returns any reply other than `applied` unchanged. After `applied`, the daemon restarts itself through its helper, and the shell never starts a daemon. The shell polls the verified owner of the data root. While the old owner, with the same `pid` and `startedAt`, is still verified, the shell waits for as long as the drain takes. A different verified owner is the successor. The shell attaches it, checks its identity, and replaces the bridge's owner. A quit, or the cleanup before a desktop update installs, cancels the restart at every wait, including while the reply is still pending. The shell checks for cancellation again before it attaches and before it replaces the owner. A reply or an owner read that arrives after the cancellation starts nothing. A connection that `attachExisting` returns after the cancellation is closed. The bridge owns every connection handed to `replaceOwner`. Disposing the bridge closes a candidate that is still waiting for its first snapshot or the login-item read, so the pending request fails at once and the candidate is never activated. If the data root has no verified owner for 60 s, the restart is over. That is what a stop that cancelled the restart or a failed successor start leaves behind. The shell keeps the window, reports that the daemon did not come back, and leaves the disconnect expected, so that **启动 daemon** can start it again. `native-lifecycle.test.ts` covers each case.
- [ ] **Open at login** installs and uninstalls the daemon as an OS service per *Service gate*.
- [ ] Implement every daemon change in *Daemon files*.

**You see.**

- [ ] Launching the app opens the Bot list. Quitting the app leaves the bots running when **Open at login** is on.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/desktop/test/daemon-manager.test.ts` covers attach to a running daemon, start when absent, start through `vonvon daemon start` with no bundled spawn when the registration is `ours`, and refusal on a protocol version mismatch. Run `npm test -w packages/desktop`.
- [ ] `service-identity.test.ts` reads the adapter sources and fails on any bridge identifier, `feishu-codex-bridge` or `ai.feishu-codex-bridge`, or any import of `control.ts` or `codex-bin.ts`. It also fails on any stop command for a live daemon: `kickstart -k`, `systemctl stop`, `restart`, or `kill`, or `taskkill`, and on `bootout` anywhere except the one call in the *Unload barrier*'s B3. The adapter sources must contain exactly one `bootout`, inside `unloadBarrier`, which uninstall, macOS install replacement, and macOS install rollback all call. It also fails if `host/bootstrap.ts` calls `acquireMutex` or `acquirePidLock` before the guard call.
- [ ] `service-definition.test.ts` checks the exact plist, unit, `.vbs`, and `.cmd` that each platform renders for a fixture data root, port, and distribution, including `KeepAlive`, `Restart=on-failure`, `TimeoutStopSec=infinity`, and the `.cmd` loop's exit and Run-value checks. It covers all four registration states and the refusal of `development` and `unknown` distributions.
- [ ] Package tests per *Package*. `packages/daemon/test/web-ui-root.test.ts` checks the UI root choice for the package, workspace, and desktop layouts. `distribution.test.ts` adds three fixtures: the exact package layout under a temporary global root classifies as `global-npm`, the same layout below a directory with `.git` as `development`, and a package named `@vonvon/daemon` at that global root as `unknown`. `node --test scripts/package-tools.test.mjs` checks that two manifests built from the same staged tree are byte-identical, and that the checker rejects a missing file, an unlisted file, a hash mismatch, a `.node` file, an install script with no allowlist entry, an allowlisted package whose script file hash differs, and a wrong head. `npm run build -w packages/desktop` before and after the staging extraction gives the same sha256 listing for `stage/daemon`. These tests never replace the native box.
- [ ] `service-transaction.test.ts` drives install and uninstall against a fake manager, file system, and registry runner. It includes Gate M's deterministic tests. The fake manager never hides a live process. It covers:
  - A fresh install.
  - An identical reinstall with the manager job present, which is a no-op. With the daemon stopped, it stays stopped.
  - An identical leftover definition whose manager job is absent or not enabled, which resumes at load and verify.
  - An update refused while a daemon runs.
  - `other-root` and `unrecognized` refusals that leave the file byte-identical.
  - A failure injected at each step, with the `install_rolled_back` or `install_incomplete` result and its leftover list.
  - An uninstall that waits with no deadline for a held drain, and stop-wins during that wait.
  - Deterministic fake-manager interleavings of uninstall with a crash relaunch: before, during, and after step 2, and between step 3's last observation and step 4. In every one, no process holding the lock or accepted work receives a signal, and a process launched after step 2 exits 0 before the lock.
  - One test per *Outcomes* row on each platform it applies to, asserting the result, the exit code, the bytes written back or not, the registration after, the ordered manager calls, and the retained identity. That includes the successful uninstall from `ours`. After macOS `unload-unknown`, including a failed `launchctl print` after `bootout`, and after `stop_unconfirmed`, no row writes bytes back, and no row issues a second unload or stop in that invocation. Linux and Windows `unload-failed` rows and a successful rollback write back exactly the bytes their rows name, except that Windows writes back only where the OS permits, per *Windows unload refusal*, and those tests assert the exact remnant and leftovers instead.
  - Windows persistent refusal, per *Windows unload refusal*, in install rollback after a failed launch. The fake refuses every attempt at one exact path until the test clears it, and the owner is read as absent after withdrawal and before the first deletion. Each case asserts the ordered mutations, zero `stopHost`, zero signals, exactly one launch, the exact bytes at each path, the Run value, launcher leftovers equal to the observed files, the result kind and its detail naming each refused path, and the CLI formatter's error naming them, then the stated next `uninstall` under the persisting refusal, then convergence after it clears. (a) No previous definition, `cmd` refused: `vbs` removed, `cmd` holds this transaction's bytes, Run absent, `install_incomplete`. Next uninstall resumes from `absent`, attempts `cmd` only, `uninstall_incomplete`, same remnant; after clearing, `uninstalled`, then `not-installed`. (b) No previous definition, `vbs` refused: `cmd` removed, `vbs` holds this transaction's bytes, Run absent, `install_incomplete`; next uninstall as in (a) on `vbs`. (c) A previous definition with `cmd` refused: replacement restores `cmd`, `vbs` was never written so never deleted, Run restored, end state the previous definition exactly, owner absent before and after, `install_rolled_back` naming the refused deletion. Next uninstall runs from `ours` under `all-owners`: withdraw, `cmd` deletion refused, `vbs` deleted, both written back, Run restored, `uninstall_rolled_back`; after clearing, `uninstalled`. (d) A previous definition with `vbs` refused: `vbs` never deleted, `cmd` deleted and restored, `install_rolled_back` with no refusal in the detail. Next uninstall from `ours`: `cmd` deleted, `vbs` refused, `cmd` written back, Run restored, `uninstall_rolled_back`; after clearing, `uninstalled`. (e) A previous definition with both deletion and replacement of `cmd` refused: `cmd` keeps this transaction's bytes, `vbs` keeps the previous bytes, Run absent, `install_incomplete`. Next uninstall resumes from `absent`: `vbs` removed despite the `cmd` refusal, `uninstall_incomplete` naming `cmd`, remnant now `cmd` alone; after clearing, `uninstalled`, then `not-installed`. Negative cases: (f) exact previous bytes and Run restored as in (c) but a lock owner present after rollback whose identity differs from preflight's, giving `install_incomplete` naming and retaining it with zero `stopHost`; (g) uninstall from `ours` where one kept launcher's replacement is refused after its deletion succeeded, giving `uninstall_incomplete` with Run absent and the exact residual files, never `uninstall_rolled_back`; (h) a launcher read that fails during rollback, giving `install_incomplete` naming the unknown path with no Run write-back; a Run withdrawal that is not confirmed, giving the internal `withdrawal-failed` reported as `install_incomplete`, with no launcher deletion; and a Run command whose post-command readback fails, including one the fake lets take effect before the read, giving `install_incomplete` with the Run state reported unknown and no additional Run mutation; none gives `install_rolled_back`; (i) a foreign change to a launcher or the Run value between two observations, ending fail-closed at the check before mutation with no further write at that path and no Run write-back. These cases, including (a) to (i), are in `service-windows-transaction.test.ts`. Native Windows acceptance, when the platform is available, must reproduce one persistent denial, an open handle without delete sharing or a deny-delete ACL on a launcher, show the same result and remnant, and show `uninstall` converging after the handle closes or the ACL is removed.
  - The stop-accepted, reply-lost trace from Gate M, repeated for uninstall from `ours` on all three platforms and for resumed uninstall and rollback on Linux against MainPID.
  - A no-lock job pid that is before its registration check, and one that read `ours` before withdrawal but has not taken the lock. In both, uninstall from `ours` waits, then stops through `runStop`.
  - A manager pid query that errors, times out, or returns unparsable output before step 4. Uninstall never runs step 4, writes the kept bytes back, and names the error.
  - The Gate M pid-reuse and resumed-uninstall traces repeated on Linux against MainPID, and on Windows the `job-only` rule that never stops a process.
  - A foreign manager pid that is never signaled.
  - An interrupted uninstall that resumes.
  - Convergence on rerun.
- [ ] `service-launch.test.ts` covers `daemon start` routed through the manager, with no detached fallback when the manager fails, the port mismatch refusal, the foreground `daemon run` refusal and its `--bot` exemption, and the exit code for each case in *Exit codes*. That includes 75 only when the restart intent survives, 0 under stop-wins, and 0 before the lock when the registration is not `ours`.
  - The real call chain of the *Pre-lock guard*. These cases drive `runHostRuntime` itself, the function that `cli/index.ts`'s `daemon run` action calls, with `config/data-access` and `server/pid-lock` module-mocked to record calls. A standalone guard function does not satisfy them.
    - `VONVON_SERVICE` set and the registration `absent`. Neither `acquireMutex` nor `acquirePidLock` is called, `runRun` is not imported, and the exit code is 0.
    - A live owner already present. Neither lock function is called, and the owner's `daemon.pid` bytes are unchanged. `releasePidLock` and `closeMutex` are not called, and the exit code is 0.
    - A collision found only at `acquirePidLock`, which throws while another live owner holds the lock. The exit code is 0, and `releasePidLock` is not called for that owner.
    - `process.send` present, the supervisor's Bot child. The guard reads nothing and V3's path is unchanged.
    - No `VONVON_SERVICE` and the registration `ours`. This is the foreground refusal, with exit 1 and no lock.
  - One subprocess case runs the built CLI, `node <entry> daemon run --port <P>`, with `VONVON_SERVICE` set for the host platform. It uses a temporary `HOME` and `VONVON_HOME` that have no registration. It asserts exit 0 and that no `daemon.pid` and no host mutex file were created. A second subprocess case writes an `ours` definition and a `daemon.pid` naming the live test-runner process. It asserts exit 0 and that the `daemon.pid` bytes are unchanged.
  - Managed core update, with a fake manager. The helper receives the exact `restarting` record and marks it `done` only after an authenticated same-port replacement. It writes `error` on `superseded` or `start_failed`. It writes nothing when the record changed or `update.lock` is held.
  - A stop before the release step cancels the helper, writes `error`, and exits 0 with no relaunch. A `helper_lost` writes `error` and exits 0.
  - A plain managed restart spawns no helper and leaves a stale `restarting` record untouched. The replacement never writes the record.
  - On macOS and Windows, the managed-update helper is spawned with `detached: true`.
  - On Linux, Gate L's deterministic tests.
  Run `npm test -w packages/daemon -- service-`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Launch the old app at `origin/codex/device-handoff` and the new shell at head with the same fixtures. Save `launch.png`. Pass when both windows show the Bot list.
- [ ] Lane 2. Launch with no daemon running. Save `cold.png`. Pass when the shell starts the bundled daemon and shows the list.
- [ ] Lane 3. Start the daemon from the CLI, then launch the shell. Save `attach.png`. Pass when the shell attaches and no second daemon exists.
- [ ] Lane 4. Close the window. Save `closed.txt`. Pass when the daemon and bots keep running.
- [ ] Lane 5. Launch the app twice. Save `second.png`. Pass when the existing window comes forward and no second app process remains.
- [ ] Lane 6. As the *Service gate*'s test user, which on the Mac may be `clay` under the rules in *Native acceptance environment*, turn on **Open at login**. Save `login-item.txt`. Pass when `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` shows the job loaded. Repeat the lane on Linux, in a VM or host with a systemd user session and never in hosted CI. The app offers no login toggle on Linux, per *Service gate*, so there the lane runs `vonvon service install`, and `systemctl --user is-enabled vonvon-bot.service` must report enabled. Then turn **Open at login** off on the Mac and pass when the job is gone, the daemon drained and stopped, and the shell started a self-hosted daemon.
- [ ] Lane 7. Quit from the tray menu with **Open at login** on. Save `quit.txt`. Pass when the app exits and the daemon keeps running.
- [ ] Lane 8. Version compatibility. The shell attaches to any daemon that declares the shell's `PROTOCOL_VERSION`. It refuses a daemon with a different version through the prompt that `daemon-manager.test.ts` covers. Every daemon built so far declares protocol 1, so no real older build can trigger the prompt yet. Build the oldest WebSocket daemon, `9a8d3aa`, start it from its own CLI, and then launch the shell. Save `older-daemon.png`. Pass when the shell attaches with no second daemon and shows the window. The first change that raises `PROTOCOL_VERSION` adds the refusal lane against the last daemon release that declares the previous version, and saves `mismatch.png`. No lane fakes a protocol value.
- [ ] Lane 9. Bind a group from the desktop window. Save `bind.png`. Pass when the group appears and `projects.json` agrees.
- [ ] Lane 10. Check for updates against a local feed. The committed `packages/desktop/desktop-update.json` stays `{}`, so a preview built from it reports that it has no signed update feed. The published feed belongs to the release work. For this lane, serve `manifest.json` over HTTPS on `localhost` with a certificate that the login keychain trusts. Its `version` is newer than the build, and its `feedURL` has the same origin. Build with `VONVON_DESKTOP_UPDATE_CONFIG` set to a file that holds that `manifestURL` and the signing identity's `teamIdentifier`. Run `package:dir` signed with that Developer ID, and launch the packaged app. The check runs through Electron's `net`, which uses the keychain's trust and the system proxy. The lane replaces nothing in the updater or in its signature check. Save `update.png`. Pass when the update panel shows the feed version and waits for the user's click. Downloading and installing from the feed is not part of this lane.
- [ ] Native service acceptance per *Service gate*, in addition to the ten lanes and never in place of one. It runs on launchd on the Mac and on systemd on Linux, as the test user from *Native acceptance environment*, with a fresh `VONVON_HOME`. On Linux that is a dedicated user with its own uid and home, never `operator`. On the Mac it is a dedicated user or, under the user's override, `clay` with every rule listed there. It never runs in hosted CI, and no CI job or mock replaces it. If `accept-user`, its systemd user session, or a passing containment read-back is missing, the systemd half stays unchecked, and V5 waits for the root's preparation under [native-acceptance-hosts.md](native-acceptance-hosts.md). Use the packaged build of the frozen head. On Linux that is the `global-npm` distribution, packed and installed on the host from a clone at the frozen head, per *Packaged build of the frozen head* in [native-acceptance-hosts.md](native-acceptance-hosts.md). A clone build never replaces it. `native-systemd.txt` begins with record B0, ends with the final record B, and holds every checkpoint record between them. Save `native-launchd.txt` and `native-systemd.txt`, and in each record every command, its exit code, and the pid, port, and manager state it observed.
  1. Before anything else, from the operator's account and read-only, record the bridge's registration (`launchctl print gui/<operator uid>/ai.feishu-codex-bridge.bot`, or `systemctl --user cat feishu-codex-bridge.service` and its `is-enabled` and `is-active`), its definition file's checksum, the checksums of the bridge data files that `control.ts`'s `installationPaths` names, and the bridge process ids with their start times. On the Linux host no bridge runs for V5. There step 1 records that `feishu-codex-bridge.service` is `not-found` for `accept-user`, and takes record B0.
  2. `install` with no daemon running. The manager starts one on port `P`, and the manager's pid equals the lock owner's pid. Run `install` again and see `already installed`. Run `install` from a second `VONVON_HOME` and see a refusal, with the definition's checksum unchanged.
  3. `daemon start` attaches with no second process. `daemon start --port <other>` refuses. A foreground `daemon run` refuses.
  4. Crash. `kill -9` the daemon. A new pid owns the lock on port `P` within 15 s.
  5. Restart. Send `restartHost` through the local credential. The old pid exits 75, and a new pid owns port `P`.
  6. Unlimited drain. Hold the drain fixture from V3's CLI evidence bundle for at least 120 s, longer than launchd's and systemd's default stop timeouts. Run `vonvon daemon stop`. The daemon stays alive, and no `SIGKILL` arrives, until the fixture is released. Then it exits 0 and is not relaunched within 60 s. The registration is still present.
  7. Stop wins. Hold the fixture, send `restartHost`, then run `daemon stop` before releasing it. After the release the daemon exits 0 and nothing relaunches.
  8. Start after stop. `daemon start` starts the manager's job on port `P`.
  9. Login load. With the daemon stopped, unload and load the job the way a login does (`bootout` then `bootstrap`, or `daemon-reload` then `start` of the enabled unit). It starts on port `P`.
  10. Uninstall while the fixture is held. It waits, then removes the job and the definition. `launchctl print` or `systemctl --user cat` no longer finds it, no daemon runs, and a second `uninstall` reports `not installed`.
  10a. Resumed uninstall and A1. `install`, then `daemon stop`, so the job stays loaded with no pid. Remove the definition by hand, leaving the job loaded or the unit loaded, and start a self-hosted daemon with `daemon start`. Run `uninstall`. Pass when it returns `uninstalled`, prints the self-hosted pid, removes the job, and the self-hosted daemon keeps its pid and `startedAt`. Then repeat with the job's own daemon running when the definition is removed: pass when it is stopped through `stopHost` after its drain and the job is removed. Across steps 2 to 10a, every manager pid query taken while a manager child held the lock equals the lock's pid, and none reports a pid after that child exited. That is the native check of A1.
  11. Failure. Make the agent or unit directory unwritable, or in `clay` place a run-owned read-only file at the product's plist path, and run `install`. It reports `install_refused` or `install_rolled_back` and leaves nothing behind. Restore the directory.
  12. Repeat step 1. Pass only when every step held and the bridge records are identical. In `clay` that includes the bridge pid's start time and listeners. Any difference fails the box. On the Linux host, step 12 runs owned teardown T and then the final record B, and every compared field must equal B0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from app launch to the Bot list painted, cold and with a running daemon, and total RSS of app plus daemon.
- [ ] Probe. Interleave five launches of the old app and five of the new shell, timed from process start to the first paint event.
- [ ] Baseline. Record the old app numbers first.
- [ ] Rule. Fail if the new shell is more than 15% slower or uses more than 15% more memory.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 1, 2, and 8 screenshots into `~/vonvon-review/V5-review-<slug>.png`. Include the Linux transcript from lane 6.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V5-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V5 only after the exact-head independent Shipping verdict is clean.

## Provider core, process host, and outbound gate (V6a)

The provider layer is redesigned on 2026-10-12. The design, its data types, the native capability matrix, the enforcement matrix, and the card layout are in [providers.md](providers.md). V6a to V6d and V7a to V7c deliver it. The earlier V6 and V7, which copied Paseo's provider closure, are withdrawn, and the branches `codex/v6-claude-provider` and `codex/v7-providers` are reference only. Nothing is copied from them or from Paseo. Paths below are relative to `packages/daemon/src/` unless they start with `packages/`, `scripts/`, or `docs/`. Tests live under `packages/daemon/test/provider/`, fixtures under `packages/daemon/test/provider/fixtures/<provider>/*.jsonl`.

**Depends on.** V3. Development starts from `H3` or `main`. No acceptance input beyond the Mac and the Linux host for the process tests. V6a merges after V4, which has landed, so it merges when verified, before or after V5. V6a publishes the freeze point `F6`.

*Split.* V6a lands as six PRs from `main`, in this order, because one PR exceeds the 1500-line cap. Each opens after the previous one merges. 1, `claude/v6a-model-policy`: `model.ts` and `policy/**` with their tests. 2, `claude/v6a-runtime`: `engines/engine.ts`, `registry.ts`, and `runtime/**`, with the F6 runtime contract revised in the same PR. 3, `claude/v6a-transport`: `transport/**` and the re-export at the old client path. 4, `claude/v6a-outbound`: `outbound/**` and the two uploaders. #117's inert admission module is not carried; it lands with its first consumer, under the #220 containment design. 5, `claude/v6a-process-identity`: the process contract in `providers.md` *Process host*, settled from #223's draft with #121's four items, and its pure parts `process/ledger.ts`, `process/identity.ts`, `process/holder-protocol.ts`, and `process/exit-hold.ts`, with `UnconfirmedReason`, `Ownership`, and `owned-work-unverified`. 6 passes the cap, so it lands as four PRs, each opened after the previous one merges. 6a, `claude/v6a-process-host`: `packages/daemon/native/holder/holder.c` and its real-process tests, which compile it with the runner's `cc` and drive it through PR 5's `holder-protocol.ts` on Linux and macOS. 6b, `claude/v6a-windows-supervisor`: the Windows supervisor as `process/windows-supervisor.ts`, the command-line builder `process/windows-command-line.ts`, and `process/holder-channel.ts` over both holders, with real-process tests on the Windows CI job and the POSIX holder; today's `windows-job.ts` stays for its callers until 6c. 6c, `claude/v6a-process-host-wire`: `ProcessHost` implementing `OwnedProcess` on PR 5's parts, with the continuation, the retry tail, admission, `sweepOrphans` and the Windows recovery probe, `fake-child.mjs`, `process-host.test.ts`, and the boot sweep with an env-gated test hook for Lane 10. 6d, `claude/v6a-holder-process`: the `HolderProcess` facade over the SDK's `SpawnedProcess` and `adopt`. No consumer moves in V6a; the cut-over is V6b's. Each PR carries the unit boxes for its own files. Lane 1 and the Codex first-token metric go with PR 3, lanes 2 to 7 and the upload metric with PR 4, lanes 8 to 10 with PR 6c, because all three run `process-host.test.ts` or `sweepOrphans`, which 6c creates; 6a and 6b carry the holder's and the supervisor's own real-process tests in CI; PR 5 carries unit boxes and the real-process identity and breakaway tests on the three CI systems. PRs 1 and 2 have no consumer, so they carry unit evidence only. The program graph keeps one V6a node that points at the open piece. `F6` is published when 6d merges.

**Files.**

- [ ] Create `provider/model.ts` with the types of *Data types* and *Supporting types* in `providers.md`: `ProviderId` as `'codex' | 'claude'`, `Tier`, `ReadScope`, `Grant`, `Lane`, `StepDetail`, `Step`, `TodoItem`, `ImageRef`, `SubagentState`, `Failure`, `StopBy`, `Outcome`, `RunEvent`, `Support`, `ProviderFeatures`, and the written-out supporting types.
- [ ] Create `provider/engines/engine.ts` with `Engine`, `EngineSession`, `EngineGoal`, `GoalSink`, `SignalSink`, `TurnVerdict`, `StopProfile`, `TERM_WAIT_MS`, `KILL_CONFIRM_MS`, `stopBoundMs`, and the runtime's process port `OwnedProcess` with `SignalResult`, `ExitFact`, and `ProcessFact`, and `provider/registry.ts` with the `Registration` type only (`codex`, `claude`). PR 2 adds `TreeFate`, `GoalEnd`, `Failure` `transport-lost`, `Outcome.tree`, and the goal event's `timeUsedSeconds` to `model.ts`. `REGISTRY` does not exist until V6b, so every head typechecks.
- [ ] Create `provider/runtime/turn-machine.ts` (`stepTurn`), `runtime/run-channel.ts`, `runtime/subagent-ledger.ts`, `runtime/todo-tracker.ts`, `runtime/image-sink.ts`.
- [ ] Create `provider/policy/enforcement.ts` (`Cell`, `Proof`, `EnforcementTable`, `planEnforcement`, `auditTable`), `policy/proofs.ts` (empty list), `policy/host-probe.ts` (`commandSandbox`, Windows readiness), `policy/messages.zh.ts` (the refusal and notice strings of `providers.md`).
- [ ] PR 5. Create `provider/process/ledger.ts` (`ReservationId`, `StartToken`, `HolderIdentity`, `WindowsControl`, the five-stage `LedgerRecord` union, the stage order per platform, `Ownership` and the pure `ownershipOf`, the `process-owners.json` codec with synchronous write-and-rename and fail-closed parsing, and the legacy `owned-pids.json` rule), `process/identity.ts` (the start-token reader per platform and the host boot time), `process/holder-protocol.ts` (command encoding with framed `launch`, the incremental receipt parser, and validation of a receipt against the issued command into `SignalResult`), and `process/exit-hold.ts` (`EXIT_REPORT_HOLD_MS` and the pure step function behind `watch()`). Add `UnconfirmedReason` to `model.ts` and `owned-work-unverified` with its message to `policy/`.
- [ ] PR 6. Create `packages/daemon/native/holder/holder.c`, `provider/process/holder-process.ts`, and `process/process-host.ts`. Move `agent/codex-appserver/owned-process.ts` and `windows-job.ts` into `provider/process/` with `git mv` and rewrite the supervisor per `providers.md` *Process host*. Leave one-line re-exports at the old paths until V6b.
- [ ] Create `provider/transport/jsonrpc.ts` by moving `agent/codex-appserver/app-server-client.ts` and adding `onNotification`, `onRequest`, `onFrame`, and `closed`. Create `provider/transport/jsonl.ts` for Pi. Re-export at the old path until V6b.
- [ ] Create `outbound/policy.ts` (`judgePath`, `checkUploadPath`, `fetchRemoteImage`), `outbound/address.ts` (blocked address classes). Edit `card/outbound-images.ts` and `bot/outbound-files.ts` to call them. Remove `lexicallyInside` and the lexical-first `insideWorkspace` at `card/outbound-images.ts:117-135`.
- [ ] Create `packages/daemon/test/provider/fixtures/fake-child.mjs`, a scriptable child that can ignore SIGTERM, spawn grandchildren, exit on cue, and emit slow frames. Create `fixtures/fake-process.ts`, an in-memory `OwnedProcess` with scripted receipts, exits, and transport loss, for the runtime tests.
- [ ] Create tests `turn-machine.test.ts`, `run-channel.test.ts`, `subagent-ledger.test.ts`, `enforcement.test.ts`, `process-host.test.ts`, `jsonrpc.test.ts`, `jsonl.test.ts`, `outbound-policy.test.ts`, `outbound-address.test.ts`.

*Contracts.* The TypeScript listings in `providers.md` under *Data types*, *Supporting types*, *Engine and runtime*, and *Registry* are the contract. A field added or renamed there goes back to Claude Code. The types that *Supporting types* lists as free are Codex's to shape under the rule stated there. `stepTurn` is pure and takes `now`. `planEnforcement` is pure and never spawns. The `Proof` rule holds from the first commit: `auditTable` is a unit test that walks every registered table.

*Stop ladder.* `stepTurn` implements the two tables in `providers.md` *Engine and runtime*. The kill row settles `tree: 'unconfirmed'` on its own deadline. Deadlines are absolute and chained. `signalled` is set only by `signal{result: 'sent'}`. One outcome, last, derived from `settled`.

**Build.**

- [ ] Types, pure functions, ledgers, process host, transports, and the outbound gate compile and pass their tests. No consumer except the two uploaders changes behavior.
- [ ] `host/lifecycle.ts` and `bot/handle-message.ts` keep calling the re-exported `closeOwnedCodexProcesses()` and `unconfirmedCodexPids()`; the new `ProcessHost` is not yet wired.

**You see.**

- [ ] Nothing changes in Feishu except that an image reference through a symlink that leaves the project is no longer uploaded, and a remote image is fetched only when the project network switch is on.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `turn-machine.test.ts` is table-driven, one case per cell of the two tables, plus these traces: a grace tick at 5000 after a stop at 0 with `graceMs` 3000 emits `term-tree` and `kill-tree` in one step; a tick at 99,999 settles `unconfirmed` in that same step; a `started` at or after the `openWaitMs` deadline emits `term-tree` and no `interrupt`; `signal{term, sent}` in rung `kill` sets `signalled`; a `signal` for an unissued rung is ignored; a `cancelled` verdict after `accepted`, `refused`, or `unknown` is `tree: 'live'`; an `exit` while stopping is `exited` after any receipt sequence; `completed` after `interrupt` stays `completed`; `transport-lost` in `running` is `failed{transport-lost}` and in `stopping` changes nothing; every input after `settled` is ignored; and `stopBoundMs` gives the bound column.
- [ ] `run-channel.test.ts`, with `fixtures/fake-process.ts` and fake timers: exactly one `outcome`, last, when the engine emits after a verdict, when an exit fact and a verdict race, and when receipts arrive after settlement; a stop on a silent process settles `unconfirmed` at the bound with one `term()` and one `kill()`; `sent` then `cancelled` settles `signalled`; `accepted` then `cancelled` settles `live`; an exit fact replayed at construction settles `failed{process-exit}`; `transport-lost` while running settles `failed{transport-lost}`; `stop-subagents` calls `stopSubagent` for each running entry iff the session has it; a running roster entry gets its final upsert before `outcome`; a subagent-lane step never appears in `events`; subagent-lane answer text folds into the row's `result` (deltas append, a new item starts over, `text-final` replaces) and reasoning, unknown-subagent, and post-outcome text never appears; a synchronous callback from `stopSubagent`, `interrupt`, or `term()` that settles the run makes no later call (including other children), arms no timer, and adds no second outcome, while one that only reports `started` leaves the owed `interrupt`, `term`, and `kill` to run; a todo never produces a step; pushes after the end are dropped and counted; the channel unsubscribes and clears its timer at settlement.
- [ ] `subagent-ledger.test.ts` asserts the caps 64, 5, 200, 600 and the `truncated` flag.
- [ ] `enforcement.test.ts` feeds a stub table and asserts `planEnforcement` refuses every cell `providers.md` marks refuse and plans every enforced cell; a missing key refuses with `unverified-combination`; `auditTable` returns an enforced cell without a proof, a `full` cell with a mechanism or with a native setting narrower than its family's unrestricted one, and a `doc` proof on any cell that is neither an unrestricted `full` cell nor a `qa` or `write` cell whose mechanisms are exactly `['launch-args']`, and it accepts the two eligible kinds; a `live` proof whose `provenFor` excludes the installed version refuses.
- [ ] PR 5. `process-ledger.test.ts`: every stage order is enforced per platform and an illegal transition throws; `ownershipOf` gives `inert` for `intent` and `born`, `bound` only with the live channel, `gone` only for a no-provider fact or a sealed holder with an empty probe, `gone` for a sealed POSIX `attempting` with no probe, and `unknown` for every other case including a sealed Windows `attempting` without a Job proof; the file round-trips; a file that does not parse is reported as unreadable and is not rewritten; a crash between write and rename leaves the old file; a legacy record is listed before the host's boot time passes its `startedAtMs` and retired after. `holder-protocol.test.ts`: `launch` frames bytes containing spaces, newlines, and `=` exactly; the parser handles a receipt split across chunks and two receipts in one chunk; `sent`, `refused`, and `accepted` map to `SignalResult` only when the nonce and command match an issued command; on Windows `term` accepts only `accepted` and `kill` only `sent` or `refused`, on POSIX both rungs accept only `sent` or `refused`, and anything else is dropped; a pid of 0 or past 2^32 − 1, or any number field out of range, is malformed; an unknown or malformed line is dropped. `exit-hold.test.ts`: EOF then exit inside the hold reports the exit alone; EOF and no exit reports `transport-lost` at the hold's end and a later exit after it; an exit that arrives past the hold before any tick reports `transport-lost` then the exit; exit then EOF never reports `transport-lost`; each fact is reported at most once.
- [ ] PR 5. `process-identity.test.ts` against real processes on Linux, macOS, and Windows in CI: a live child's token is stable across two reads; a child born one resolution step later (10 ms on Linux, one second on macOS) reads a different token, while siblings born inside one step may share one, which the contract allows; a macOS `ps` that fails reads `unreadable` for a live pid and `absent` only for a pid the kernel reports gone; an exited and reaped child reads `absent`; on Windows the token equals the creation `FILETIME` a child PowerShell prints for itself, which is what the supervisor's `hello` will carry. `windows-job-breakaway.test.ts`, Windows only: inside today's `WindowsCodexJob`, a probe that `IsProcessInJob` places in the exact Job asks for a grandchild with `CREATE_BREAKAWAY_FROM_JOB`; the request either fails with access denied or creates a process that `IsProcessInJob` places in the same Job, and after the stop the Job's empty proof holds and that process is gone.
- [ ] PR 6. `process-host.test.ts` with `fake-child.mjs`: `spawn` writes `process-owners.json` before returning; a second host after an unclean exit `sweepOrphans` finds the tree gone and reports `gone: 1`; a record whose holder pid carries a different start token stays `unknown` until its probe is empty; `terminateTree` on a child that ignores SIGTERM resolves and `killTree` removes every pid in the group; `adopt` gives the same behavior. POSIX-only and Windows-only cases are tagged.
- [ ] `jsonrpc.test.ts` and `jsonl.test.ts` cover a frame split across chunks, two frames in one chunk, server-initiated requests, per-request timeout, `closed` on EOF, and `onFrame` for every inbound frame.
- [ ] `outbound-policy.test.ts`: a symlink inside cwd pointing outside is rejected; a path inside by name and outside by realpath is rejected; with network off a remote fetch returns before any DNS lookup, in every tier including `full`; with network on, hosts resolving to `127.0.0.1`, `::1`, `10.0.0.5`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `fe80::1`, `100.64.0.1`, `0.0.0.0`, `::ffff:127.0.0.1` are blocked; a redirect from a public host to a blocked address is blocked at the hop; a fourth redirect fails; `text/html` is rejected; over real TLS with a trusted fixture certificate, an IPv4 or IPv6 literal URL is verified against the certificate IP SAN and sends no SNI, a DNS name is sent as SNI and verified while the socket connects to the pinned address, and a certificate that does not name the requested host or is not trusted is rejected. Existing `outbound-images` tests are ported and pass. Run `npm test -w packages/daemon -- provider outbound`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. One Codex turn in a Feishu group at `main` and at V6a head. Save `turn.txt`. Pass when both cards match.
- [ ] Lane 2. In a `write` project, ask Codex to create `link.png` as a symlink to a PNG under `~/`, then reply with `![](link.png)`. Save `symlink.txt`. Pass when the card shows no image and the log has `image-outside-cwd`.
- [ ] Lane 3. Same with a real PNG inside the project. Save `inside.txt`. Pass when the image uploads.
- [ ] Lane 4. Network off, reply with `![](https://example.com/a.png)`, once in a `write` project and once in a `full` project. Save `netoff.txt`. Pass when neither fetches and neither card shows the image.
- [ ] Lane 5. Network on, a URL that resolves to `127.0.0.1` served from a local HTTP server. Save `loopback.txt`. Pass when the fetch is blocked.
- [ ] Lane 6. Network on, a public image URL redirecting to a loopback address. Save `redirect.txt`. Pass when the hop is blocked.
- [ ] Lane 7. Send a file through the file path in `bot/outbound-files.ts` by a symlink leaving the project. Save `file-symlink.txt`. Pass when the send is refused with 文件超出项目可访问范围.
- [ ] Lane 8. On the Mac, run `process-host.test.ts` POSIX cases against real processes and save the transcript as `procs-mac.txt`. Pass when every case passes.
- [ ] Lane 9. On the Linux host, the same. Save `procs-linux.txt`.
- [ ] Lane 10. In a checkout after `npm ci` and `npm run build`, run `npm run build:holder --workspace @vonvon/daemon`, which compiles `holder.c` with the host's `cc` into `packages/daemon/dist/native/<platform>-<arch>/vonvon-holder`, the path `bootstrap.ts` resolves; it is not part of `npm run build` because native distribution is packaging's job. Use an isolated `HOME` and `VONVON_HOME` under `/tmp`. Start `node packages/daemon/bin/vonvon.mjs daemon run --port 0` with `VONVON_TEST_SPAWN_FAKE_CHILD=$PWD/packages/daemon/test/provider/fixtures/fake-child.mjs`; the boot hook spawns a TERM-ignoring tree with one grandchild through the host. Read the provider and holder pids from `$VONVON_HOME/process-owners.json` (stage `running`), then `kill -9` the daemon. Restart it without the hook. Save `sweep.txt` with the daemon log lines `process-host boot-sweep` and `process-host boot-admission` and the pids' liveness. Pass when the holder's daemon-death path has ended the tree before the restart, the sweep reports `gone: 1`, admission logs `allowed`, and the log has no `launch` or signal line from the new daemon. Then start the daemon with the hook again, `kill -9` the holder first and the daemon second, and restart. Pass when the sweep reports `unknown: 1`, admission logs `owned-work-unverified`, and `process-owners.json` keeps the record; then `kill -9` the surviving members, restart, and pass when the sweep reports `gone: 1` and admission logs `allowed`. `doctor` listing the record and a new agent being refused are consumer acceptance and belong to V6b's lanes, because V6a moves no consumer.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a `![](path)` reference to upload start, and Codex first-token latency.
- [ ] Probe. Five turns each at `main` and V6a head, timed from the daemon log.
- [ ] Baseline. Record `main` first.
- [ ] Rule. Fail if either is more than 5% slower.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 2, 3, and 4 into `~/vonvon-review/V6a-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6a-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V6a only after the exact-head independent Shipping verdict is clean.

## Runtime, Codex and Claude engines, and the consumer cut-over (V6b)

**Depends on.** V6a at `F6`. Acceptance needs the Feishu fixture Bot, the managed Codex, and the real Claude Code CLI on the Mac. V6b merges after V6a.

**Files.**

- [ ] Create `provider/runtime/provider-runtime.ts` (`createProviderRuntime`, `ProviderRuntime`, `Conversation`, `Run`, `GoalControl`, `GoalRun`, and the behavior of `providers.md` *Goals*; one `RunChannel` per turn implements `Run`; `GOAL_CLEAR_MS` and `GOAL_IDLE_MS` land here), `provider/index.ts` (the only import path for consumers), `provider/runtime/watchdog.ts` (replaces `bot/watchdog.ts`, outcome `interrupted{watchdog}`). Create `REGISTRY` in `provider/registry.ts` with `codex` and `claude`, `satisfies Record<ProviderId, Registration>`.
- [ ] Create `provider/engines/codex/{engine,translate,sandbox,pool,usage,install}.ts` and move `agent/codex-appserver/{managed-install,managed-tools,locate,setup,client-pool,usage}.ts`, `codex-install-lock.json`, and `protocol/` under `provider/engines/codex/`. `sandbox.ts` builds `NativeSettings` for the Codex rows of `providers.md`.
- [ ] Create `provider/engines/claude/{engine,translate,options,gate,history}.ts`. `gate.ts` is the `PreToolUse` hook over `outbound/policy.ts` `judgePath`. `options.ts` builds `permissionMode`, `tools`, `disallowedTools`, `sandbox`, `managedSettings`, and `settingSources` per tier.
- [ ] Create `provider/engines/codex/table.ts` and `provider/engines/claude/table.ts` with the enforcement cells. In V6b the Codex table carries `full` and the `unrestricted` reads cells; every `full` cell is `enforced` with `mechanisms: []` and the unrestricted `doc` proof of `providers.md` *Data types*, on every OS; `project` reads cells are `refuse` until their probes run in this PR on the Mac. The Claude table carries `full` only; `qa` and `write` are `refuse` with `unverified-combination` until V6d.
- [ ] Create `scripts/prove-enforcement.mjs`, the probe runner. It starts the daemon's engine against the installed provider, asks the agent to read a canary outside the project and to write inside and outside, asserts per cell, and prints a block for `docs/proofs.md`. Create `docs/proofs.md`.
- [ ] Create `card/run-view.ts` (`RunView`, `foldRun`), `card/outcome-note.ts`, `card/messages.zh.ts`. Edit `card/run-card.ts`, `card/run-process.ts`, `card/tool-render.ts` (renders `StepDetail`), `card/history-card.ts`, `card/usage-cards.ts` (reads `Engine.usage`), `card/goal-card.ts` (built from `GoalRun.result()` and `GoalRun.status()`), `card/context-gauge.ts`, `card/command-cards.ts` (command list from `features`). Remove `card/run-state.ts`, `card/run-render.ts`, `card/run-segment.ts`, `card/tool-presentation.ts`.
- [ ] Edit the 39 source consumers of `agent/` on `main`: `bot/handle-message.ts`, `bot/turn-card-events.ts`, `bot/steer-delivery.ts` (steer when `features.steer !== 'none'`; otherwise, and when steer returns `rejected`, the message joins the existing `QueuedTurn` queue, per `providers.md` *Follow-ups during a run*), `bot/supervisor.ts`, `bot/session-store.ts`, `bot/session-title-coordinator.ts` (becomes `TitleService` per `providers.md` *Session titles*), `bot/onboarding.ts`, `bot/outbound-files.ts`, `card/outbound-images.ts`, `card/dm-cards.ts` (`main:card/dm-cards.ts:27-28`, the DM project settings card and the provider picker), `environment/service.ts` (`main:environment/service.ts:8`, the `WindowsCodexJob` import, re-pointed at `provider/process/`), `admin/{groups,host,ops,service,settings,settings-parse,settings-service,settings-types}.ts`, `host/{client,lifecycle}.ts`, `project/{lifecycle,onboarding,registry}.ts`, `server/{errors,http,jobs,snapshot}.ts`, `server/rpc/collaboration.ts`, `cli/commands/{doctor,run}.ts`, `config/schema.ts`, and the card files of the item above.
- [ ] Edit `packages/protocol/src/domain.ts`, written by the root under *Shared files*. `setPermission` and `membershipSchema.permission` gain `readScope: z.enum(["project", "unrestricted"])`, admin only, which guests cannot change. Edit the project panel in `packages/ui/src/` and the DM project settings card in `card/dm-cards.ts` to show and set it, labelled 仅读取项目目录 and 不限读取.
- [ ] Delete `agent/types.ts`, `agent/catalog.ts`, `agent/index.ts`, `agent/backend-loader.ts`, `agent/detect.ts`, `agent/usage.ts`, `agent/claude-agent/*`, `agent/codex-appserver/{backend,event-map}.ts`, the V6a re-exports, and `bot/watchdog.ts`. Codex title generation moves from `agent/codex-appserver/backend.ts` into the Codex engine's `oneShot`, unchanged in behavior. Move `agent/installer.ts`, `agent/native-helpers.ts`, and `agent/bridge-instructions.ts` to `provider/` or `environment/` as the root decides, and record the mapping in the PR.
- [ ] Create tests `provider-runtime.test.ts`, `codex-translate.test.ts`, `codex-sandbox.test.ts`, `claude-translate.test.ts`, `claude-options.test.ts`, `claude-gate.test.ts`, `run-view.test.ts`, `registry.test.ts`, `title-service.test.ts`, `stored-data.test.ts`. Map the 72 test files that import `src/agent` on `main` as *Test mapping* below says. Record fixtures with `scripts/record-fixture.mjs --provider codex|claude` on the Mac.
- [ ] Add the history, model, and usage contract that V6a PR 2 deferred: `Engine.models`, `history`, and `usage` with `ModelInfo` derived from `modelCatalogSchema`, `AccountUsage` as `main`'s `AccountUsageBundle`, `HistoryControl` with `main`'s `ThreadSummary` and `ThreadHistory`, the `ProviderRuntime.models`, `history`, and `usage` accessors, a *History* section in `providers.md`, the Codex `account/rateLimits/read` usage mapping, and the ported `codex-usage` test, as #223 drafted them at `348501d` on `claude/v6a-f6-contract-gaps`.

*Goal rules.* Beside the trigger table of `providers.md` *Goals*. Busy. From `start` until `runs` ends, `send` throws `ConversationBusy`, `steer` returns `rejected`, and `owesWork()` is true. The bot answers with `main`'s goal-busy reply. Stop. `Run.stop(by)` on a goal's run is `GoalRun.stop(by)`. A goal has one stop. Idle. `GOAL_IDLE_MS`, 30 min, in `runtime/watchdog.ts`, covers the whole goal. While `open`, every goal frame and turn frame rearms it, with the running-subagent rule. In `ending`, only the ending run's frames rearm it. With no run draining it is off. Bounds. A `stop(by)` with a live run ends `runs` within `GOAL_CLEAR_MS` plus the ladder bound. A drain under `end()` or a provider end is bounded only by the idle bound. Card. Built from `result()` and `status()`. `terminal` with `isGoalSuccess` is 目标已完成. Other `terminal` is 目标已中止 with the status. `failed` is 目标已中止 with that failure's outcome note, including the `transport-lost` note. `timeout` is 目标已中止 with 运行超过时长上限被中止. `cleared` posts no terminal card. Tokens and seconds come from `status()`, zero when undefined. After `runs` ends the bot calls `Conversation.close()`, a no-op when the goal already closed it. A `thread/goal/cleared` notification after `clear()` is dropped by translation.

*Stored data.* The stored shapes change in three places, each migrated at load, idempotently, so every read of old data gives the same result and the file is rewritten only on the next normal write.

- Project. The stored project is the TypeScript interface `Project` in `project/registry.ts` (`main:project/registry.ts:8-70`), which has no zod schema. It gains `readScope?: ReadScope`. The loader in `project/registry.ts` reads `readScope ?? 'unrestricted'`, so a project stored before V6b loads as `unrestricted`. Project creation in `project/lifecycle.ts` and `project/onboarding.ts` writes `readScope: 'project'`, so a new project defaults to `project`. No zod `.default` expresses this, because the two defaults differ. `Project.backend` keeps its field name and stores the new id.
- Provider ids. `migrateProviderId` maps `codex-appserver` to `codex` and `claude-agent` to `claude`, and leaves `codex` and `claude` unchanged. It applies to `Project.backend` in the project loader and to `SessionRecord.backend` in `session-store.ts` `migrate()` (`main:bot/session-store.ts:112-120`), which already backfills a missing `backend`. The field names `backend` and `sessionId` stay on disk; `providerSessionId` in `providers.md` is the in-memory name for `SessionRecord.sessionId`.
- Titles. `SessionRecord` gains `title?: string`, written by `TitleService` when the provider has no native title set. Existing `titleJobs` keep working. Their key is `${backend}:${sessionId}` (`main:bot/session-store.ts:249-250`), so `read()` rewrites each job's `backend` and `key` through `migrateProviderId`. A pending Codex job then runs through `TitleService` and the Codex `oneShot`, as it would have on `main`.

`stored-data.test.ts` loads a `main`-era `projects.json` and `sessions.json` with both old ids, a project without `readScope`, and a pending Codex title job. It asserts the ids map, the project reads `unrestricted`, a newly created project stores `project`, a session resumes through the mapped id, the job's key is rewritten, and a second load gives identical results.

*Test mapping.* Every one of the 72 files is either deleted, with the new test that covers its behavior, or ported.

- Delete, covered by `registry.test.ts`: `backend-registry`, `backend-catalog`, `backend-picker`, `backend-detect`. By `codex-translate.test.ts`: `event-map`. By `codex-sandbox.test.ts`: `permissions`. By `claude-translate.test.ts`: `claude-event-map`, `claude-api-error`, `claude-user-message`. By `claude-options.test.ts`: `claude-permission`. By `title-service.test.ts`: `backend-session-title`. By `run-view.test.ts`: `run-render`.
- Port, re-pointed at the module's new path under `provider/` with no behavior change: `codex-managed-install`, `codex-process-tree`, `codex-setup-lifecycle`, `codex-setup`, `codex-usage`, `locate`, `managed-tools-pointer`, `helpers/codex-selection-fixture.ts`, `windows-codex-job`, `app-server-liveness`, `appserver-pool`, `eager-turn-start`, `models-prewarm`, `run-liveness`, `turn-stream-isolation`, `native-helpers`, `backend-installer-queue`, `backend-version-lifecycle`, `installer-shutdown`, `server-api-shutdown`, `server-backend-install`, `server-shutdown`, `claude-history`, `host-service-shutdown`, `rpc-ownership`, `server-service-shutdown`, `web-admin-service`.
- Port, re-pointed at `provider/index.ts` and the scriptable fake engine: `admin-ops`, `backend-install-api`, `bridge-startup-drain`, `claude-agent.live`, `claude-resume`, `command-cards`, `comment-settings-card`, `comment-settings-runtime`, `comments`, `daemon-lifecycle-runtime`, `daemon-lifecycle`, `daemon-release-errors`, `desktop-collaboration`, `goal` (Codex cases only; the Claude prompt-loop cases are deleted with the emulation), `history-card`, `issue-14-live-images`, `message-queue-races`, `model-card`, `model-default`, `no-mention-parity`, `onboarding-events`, `provider-lock-retention`, `provider-ownership`, `rpc-retained`, `run-supervisor-dispatch`, `server-fixture.ts`, `session-title-coordinator` (becomes the `TitleService` integration test), `session-title-settings-card`, `settings-owner`, `settings-parity-cases`, `single-session-model-display`, `supervisor-activation`, `usage-cards`.

*Codex mapping.* Per `providers.md` *Codex engine*. Child threads are subagents, `turn/plan/updated` is `todo`, three image sources are `image`, `thread/goal/*` under `experimentalApi: true`, with `thread/goal/set` and `clear` as `EngineGoal` and each goal turn as its own `Run` through `GoalSink.turn()`, `account/rateLimits/read` for the usage card, `error.willRetry` as `notice{retry}`. The utility title thread becomes `oneShot`, `native`. Every `ServerRequest` method has an answer per `providers.md` *Auto-answered requests*. Profile cells check `activePermissionProfile` by a raw parse of the `thread/start` response.

*Claude mapping.* Per `providers.md` *Claude engine*. `spawnClaudeCodeProcess` routed through `ProcessHost.adopt`. `task_*` frames drive the roster only for `local_agent` tasks or a set `subagent_type`, and `parent_tool_use_id` marks subagent-lane steps. `stopTask` is `stopSubagent`. `TodoWrite`, `TaskCreate`, and `TaskUpdate` are `todo`; `TaskList` and `TaskGet` are dropped. `/compact` is the declared native command and `compact_boundary` closes it. `oneShot` is `query` with `tools: []` and `maxTurns: 1`. `settingSources: ['user']`. `full` only in this PR, with `permissionMode: 'bypassPermissions'`.

*Dependencies.* The root moves `@anthropic-ai/claude-agent-sdk` from `devDependencies` to `dependencies` at exactly `0.3.246`.

**Build.**

- [ ] Every consumer imports from `provider/index.ts` only. `git grep -n "from '.*agent/"` in `packages/daemon/src` returns nothing outside `provider/`.
- [ ] No file outside `provider/engines/` names a provider id, a provider tool name, or a wire field. `git grep -nE "(provider|backend)Id ===? '"` in `bot/`, `card/`, `server/`, `host/`, `admin/` returns nothing.
- [ ] The picker, `doctor`, the status list, and the command list are generated from `REGISTRY` and `features`.
- [ ] `host/lifecycle.ts` shutdown calls `ProviderRuntime.closeAll()`; `fcb.owned-work` answers from `ProviderRuntime.owesWork()`.

**You see.**

- [ ] A Codex group and a `full` Claude group answer in Feishu with a streaming run card, accept a follow-up mid-turn where the provider supports steer and queue it as the next turn where it does not, and show a distinct outcome note on stop.
- [ ] Sessions and projects created on `main` resume after the upgrade, and the project settings card and the web project panel offer 仅读取项目目录 and 不限读取.
- [ ] A known window, stated in the PR. From V6b until V6d merges, existing Claude `qa` and `write` projects refuse with `unverified-combination`; on `main` they ran under the Bash sandbox. On Linux, Codex `qa` and `write` with `project` reads refuse as on `main`, and with `unrestricted` reads they run from this PR, because the Linux probes below run here.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `codex-translate.test.ts` replays fixtures for: a plain answer, a command run, a file change, an MCP call with an image result, `imageView`, `imageGeneration`, `turn/plan/updated`, `thread/goal/updated` (asserting `timeUsedSeconds` on the `goal` event), `contextCompaction`, a child thread with `collabAgentToolCall` and child `item/*` frames, `error.willRetry`, a failed turn with each `codexErrorInfo` of the outcome table, an interrupted turn. Child frames become subagent-lane steps and never main-lane steps.
- [ ] `codex-sandbox.test.ts` snapshots `NativeSettings` for every Codex row and OS in `providers.md`; `full` is byte-identical to `main`'s `sandboxParams`; `read-only` carries `networkAccess`.
- [ ] `claude-translate.test.ts` replays fixtures for: streamed text and thinking, `tool_use` of each `StepDetail` kind, `TodoWrite` and `TaskCreate` as `todo` with no step, `TaskList` and `TaskGet` with no step, `task_started`, `task_progress`, `task_notification` of a `local_agent` task as roster, a backgrounded `local_bash` task that creates no roster entry and leaves only its `Bash` step, a `parent_tool_use_id` frame as a subagent step, a `tool_result` image block, `compact_boundary`, `rate_limit_event`, `api_retry`, and each `subtype` and `terminal_reason` of the outcome table, including `aborted_tools` after our interrupt as `interrupted` and an unlisted `terminal_reason` as `failed{provider-error}`.
- [ ] `claude-options.test.ts` snapshots `permissionMode`, `tools`, `disallowedTools`, `managedSettings`, `settingSources` for `full`, where `permissionMode` is `bypassPermissions`; `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` are disallowed; a DeepSeek-style `ANTHROPIC_BASE_URL` in a fixture `settings.json` reaches the child.
- [ ] `provider-runtime.test.ts` with a scriptable fake engine covers: stop before `started`, stop with `started` never arriving, stop with a verdict never arriving, a second `send` while a run is live throws `ConversationBusy`, `steer` absent when `features.steer` is `none`, the watchdog fires `interrupted{watchdog}` after idle with no running subagent and not while a subagent runs, engine exit mid-turn yields `failed{process-exit}` and marks running subagents `interrupted`, `stop` calls `stopSubagent` for each running entry when `subagentStop` is not `none` and never when it is, `closeAll()` yields `interrupted{daemon}`, a forced user stop yields `interrupted{user, tree: 'exited'}`, `features` members exist iff the cell is not `none`. Goal cases cover each row of the *Goals* trigger table, including `transport-lost` before the first turn, between turns, and inside a goal turn, each ending `result()` `failed{transport-lost}` with no idle wait; a goal stop behind a pending clear; an orphan after `ending`; and the keep-or-close rule.
- [ ] Follow-up paths, in the ported `message-queue-races.test.ts`: a message during a run with `steer` accepted joins the turn; with `steer` returning `rejected` it becomes a `QueuedTurn` and runs after `outcome`; on an engine with `steer: none` it becomes a `QueuedTurn` and `send` is never called while the run is live.
- [ ] `title-service.test.ts`: the project's own engine is used when it has `oneShot`; a project on an engine without it falls through to an installed Codex, then Claude; with neither, the title is the first user message cut to 36 chars; an attempt that exceeds 30 s is killed and the next source runs; the result is written through the native title set when the provider has one, else to `SessionRecord.title`.
- [ ] `registry.test.ts` passes `createProviderRuntime` a registry with an extra fake id and asserts the picker, `doctor`, status, and command list show it with no edit outside the test; `toolSchema` equals the `REGISTRY` keys.
- [ ] `run-view.test.ts` snapshots the Feishu JSON for a text answer, each `StepDetail` kind, each outcome note of `providers.md`, and a step still running at `outcome` rendering as 已停止.
- [ ] `scripts/prove-enforcement.mjs codex` on the Mac records `codex.profile.read-denied`, `codex.profile.write-scope`, `codex.readonly.write-denied`, `codex.workspace-write.scope` on darwin, and on the Linux host records `codex.readonly.write-denied` and `codex.workspace-write.scope` on linux, into `docs/proofs.md` and `policy/proofs.ts`. Those darwin and linux cells flip to `enforced`. `codex.workspace-write.scope` denies writes outside `root`, to `/tmp`, and to `$TMPDIR`. `auditTable` stays green. Run `npm test -w packages/daemon -- provider card bot`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Twelve lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The same question in a Codex group at V6a head and at V6b head. Save `turn.txt`. Pass when both cards finish and the V6b card shows the same sections.
- [ ] Lane 2. Codex, click stop during a `sleep 30` command. Save `stop.txt`. Pass when the card shows ⏹ 已停止 within 13.5 s and the next message resumes.
- [ ] Lane 3. Codex, click stop before the first frame arrives. Save `stop-early.txt`. Pass when the run ends `interrupted` and the process is gone.
- [ ] Lane 4. Codex, send a follow-up mid-turn. Save `steer.txt`. Pass when it joins the turn.
- [ ] Lane 5. Codex `qa` with `project` reads on the Mac, ask it to read `~/.ssh/config`. Save `qa-read.txt`. Pass when the read is denied by the sandbox and the card shows the step as failed.
- [ ] Lane 6. Codex `qa` with `project` reads on the Linux host. Save `linux-refuse.txt`. Pass when nothing spawns and the group shows the `read-scope-unenforceable` message.
- [ ] Lane 7. Claude `full` group, one turn with a tool call, one stop. Save `claude.txt`. Pass when the card finishes and stop lands within 6.5 s.
- [ ] Lane 8. Claude `qa` group. Save `claude-qa.txt`. Pass when the group shows the `unverified-combination` refusal and nothing spawns.
- [ ] Lane 9. Kill the Codex process mid-turn with `kill -9`. Save `crash.txt`. Pass when the card shows ⚠ agent 进程意外退出 and the next message starts a new session.
- [ ] Lane 10. Restart the daemon mid-turn. Save `restart.txt`. Pass when the card shows ⏹ Vonvon 正在停止或重启，本轮已中断 and `sweepOrphans` reports no orphan after a clean restart. Then repeat V6a's Lane 10 second tree, `kill -9` the holder before the daemon, and pass when `doctor` lists the `unknown` record and a new agent is refused with `owned-work-unverified` until its members are gone; this consumer half of V6a's Lane 10 belongs here because V6b wires `doctor` and admission to the host.
- [ ] Lane 11. Codex, send a follow-up after the turn has ended but before the card settles, so steer is rejected. Save `queue.txt`. Pass when the queued card appears and the message runs as the next turn.
- [ ] Lane 12. Start the V6b daemon on a copy of a `main`-era data directory with a Codex session, a Claude session, and a project with no `readScope`. Save `upgrade.txt`. Pass when both sessions resume, the project shows 不限读取, and a new project shows 仅读取项目目录.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Codex first-token latency, stop-to-stopped time, and card render time for a 40-step run.
- [ ] Probe. Interleave five Codex turns at V6a head and V6b head.
- [ ] Baseline. Record V6a first.
- [ ] Rule. Fail if first token is more than 5% slower, stop exceeds 13.5 s, or render exceeds 50 ms.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 1, 2, 7, and 8 into `~/vonvon-review/V6b-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6b-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V6b only after the exact-head independent Shipping verdict is clean.

## Baseline capabilities on the run card (V6c)

**Depends on.** V6b. Acceptance needs the Feishu fixture Bot, Codex, and Claude on the Mac. V6c merges after V6b.

**Files.**

- [ ] Create `card/subagent-area.ts`, `card/todo-line.ts`, `card/image-rows.ts`, `card/subagent-history-card.ts` (the 查看完整过程 card). Edit `card/run-card.ts` to compose the nine areas of `providers.md` *Feishu run card*, and create `card/card-budget.ts` with one `{components, bytes}` allocation per area from that table, `CARD_COMPONENT_BUDGET` 170, and `CARD_BODY_BUDGET` 28,000. `card/run-process.ts` takes its process allocation, 113 components and 10,000 bytes, from there.
- [ ] Edit `bot/handle-message.ts` to route the 查看完整过程 button to `run.subagents().history(id)`, and the row's 停止 button to `Run.stopSubagent(id)`. The 停止 button exists iff `features.subagentStop !== 'none'`.
- [ ] Create tests `subagent-area.test.ts`, `todo-line.test.ts`, `image-rows.test.ts`, `card-budget.test.ts`, with event fixtures under `packages/daemon/test/provider/fixtures/card/*.json`.

*Layout.* Per `providers.md` *Feishu run card*, including its allocation table and the overflow rule of each area. Progress line `进度 3/7 · 正在改接口` with a collapsible checklist. Notices in one element. Reasoning in a collapsed panel. Compaction markers in the process area. 子 agent area with at most 6 running and 3 completed rows, 另有 N 个已完成, a collapsible panel of the last 5 steps and the result, the 查看完整过程 button, and the 停止 button where supported. Screenshot images collapsed under their step, generated images expanded after the answer. The outcome note from `card/outcome-note.ts`.

**Build.**

- [ ] The card renders every baseline area from `RunView` alone. No provider id reaches the card.

**You see.**

- [ ] A Codex run that spawns child agents shows the 子 agent area with live rows, a progress line that updates as the plan changes, and a generated image expanded after the answer. Stopping the main run stops the children, and every row still running at the outcome reads 已停止 or 已随主任务停止.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `subagent-area.test.ts`: 2 running plus 5 done renders 2 rows, the 3 most recent done, and 另有 2 个已完成; a run with no roster has no area; subagent steps never appear in the process area; a row shows status, task, step count, elapsed, current step; the button exists iff a history exists.
- [ ] `todo-line.test.ts`: 7 items with 3 done and an active 改接口 renders 进度 3/7 · 正在改接口; the panel expands to the checklist; `null` renders nothing; a todo update produces no tool row.
- [ ] `image-rows.test.ts`: a `step` placement renders collapsed under its step; an `answer` placement renders expanded after the text; every upload passes `checkUploadPath`.
- [ ] `card-budget.test.ts`: the allocations in `card/card-budget.ts` sum to 170 components and 28,000 bytes; the worst-case fixture of `providers.md` renders under both whole-card limits and each area under its allocation after the pass-through rule; each area's overflow rule fires on its own over-budget fixture and leaves its marker (另有 N 项, the head …, 截图已省略, ……（回答过长，已截断）); compaction markers survive process folding; a row's 停止 button exists iff `subagentStop` is not `none`. Run `npm test -w packages/daemon -- card`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. A Codex turn with no subagents at V6b head and V6c head. Save `turn.txt`. Pass when the cards match.
- [ ] Lane 2. Codex, a task that spawns two child agents. Save `subagents.txt`. Pass when two rows appear, update, and complete.
- [ ] Lane 3. Codex, a task with a plan. Save `todo.txt`. Pass when the progress line updates and the checklist expands.
- [ ] Lane 4. Codex, ask for a generated image. Save `image.txt`. Pass when the image renders expanded after the answer.
- [ ] Lane 5. Codex, a child agent running; click stop on the main run. Save `stop-all.txt`. Pass when each child thread receives its own `turn/interrupt` before the main one, the child rows show 已停止, and no child thread is still running after the outcome.
- [ ] Lane 6. Claude `full`, a task that uses the `Agent` tool. Save `claude-subagents.txt`. Pass when a row appears from `task_started` and completes from `task_notification`.
- [ ] Lane 7. Claude `full`, a task that uses `TodoWrite`. Save `claude-todo.txt`. Pass when the progress line appears and no `TodoWrite` tool row exists.
- [ ] Lane 8. Claude `full`, a Read of a PNG. Save `claude-image.txt`. Pass when the image renders collapsed under the Read step.
- [ ] Lane 9. Click 查看完整过程 on a completed child, then 停止 on a running Claude subagent. Save `history.txt`. Pass when a separate card shows the child's steps, and the stopped row reads 已停止 while the main run continues.
- [ ] Lane 10. A run with 8 child agents. Save `budget.txt`. Pass when the card renders with 另有 N 个已完成 and Feishu accepts the update.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Card render time for the worst-case fixture, and update count per minute during a subagent run.
- [ ] Probe. Render the fixture 100 times; run lane 2 and count card updates.
- [ ] Baseline. V6b render time for a 40-step run.
- [ ] Rule. Fail if the worst case exceeds 80 ms or updates exceed the existing throttle.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 2, 3, 4, and 9 into `~/vonvon-review/V6c-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6c-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V6c only after the exact-head independent Shipping verdict is clean.

## Claude confinement (V6d)

**Depends on.** V6b. Can be developed beside V6c; the files do not overlap. Acceptance needs the real Claude Code CLI on the Mac and on the Linux host, with `bwrap` present on Linux. V6d merges after V6b, before or after V6c.

**Files.**

- [ ] Edit `provider/engines/claude/{options,gate,table}.ts` to add the `qa` and `write` cells of `providers.md` *Claude Code* with `permissionMode: 'default'`, the sandbox in `Options.sandbox`, only restrictive locks in `managedSettings`, the host probe for `seatbelt` and `bwrap`, the Bash-off notice, the MCP-off notice, and the pre-spawn `resolveSettings` lock check.
- [ ] Extend `scripts/prove-enforcement.mjs claude` with probes `claude.qa.project`, `claude.qa.unrestricted`, `claude.write.project`, `claude.write.unrestricted`, `claude.subagent-gate`, `claude.sandbox.allowread-override`, `claude.hook-under-lock`, `claude.commands`, `claude.managed-settings-keys`. `claude.hook-under-lock` and `claude.subagent-gate` run under `permissionMode: 'default'`.
- [ ] Create tests `claude-gate.test.ts` (extended), `claude-table.test.ts`, `claude-locks.test.ts`.

*Gate.* `judgePath` for `Read`, `Grep`, `Glob`, `Edit`, `Write`, and `NotebookEdit`. Realpath based. `Glob` with `/`, `~`, or `..` is denied under `project`. `WebFetch` hosts pass through `outbound/address.ts`. The hook returns `permissionDecision` `allow` or `deny` for every call; under `permissionMode: 'default'`, `canUseTool` denies the rest. No MCP server loads under `qa` or `write` (`strictMcpConfig: true`), and the card shows `notice{mcp-off}` when the user has servers configured.

*Bash.* On with Seatbelt or bwrap under the `Options.sandbox` of `providers.md`, the path `main` verified (`main:agent/claude-agent/permission.ts:9-20`). Off with the notice 此机器没有命令沙箱，已关闭 Bash。可读写项目文件，不能运行命令。 on Windows and on Linux without bwrap. If `claude.sandbox.allowread-override` fails, `project` reads keep Bash off on every host and the PR says so.

**Build.**

- [ ] `qa` and `write` cells are `enforced` on darwin and linux only with the proofs recorded in this PR. win32 cells stay `refuse` until V7c.

**You see.**

- [ ] A Claude `qa` group with `project` reads answers questions about the project, is denied when asked to read `~/.ssh`, and refuses to write.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `claude-options.test.ts` snapshots every tier, read scope, and `commandSandbox` combination; `permissionMode` is `default` for every gated cell and `bypassPermissions` for `full`; the sandbox is in `Options.sandbox` and `managedSettings` holds only `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, and `permissions.deny`; `tools` is never `'default'` for `qa` or `write` and includes `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`; Bash is absent when `commandSandbox` is `none` and the plan carries the notice; a user `defaultMode` in a fixture `settings.json` does not change `permissionMode`.
- [ ] `claude-gate.test.ts`: `Read` of `<root>/a.ts` allowed; `<root>/link-to-etc/passwd` denied; `~/.ssh/id_rsa` denied; `Grep` with `path: '/'` denied; `Glob` `../*` denied; `WebFetch` to `http://169.254.169.254/` denied; `Edit` anywhere denied under `qa`; `Write` outside root denied under `write`.
- [ ] `claude-locks.test.ts`: before spawn, a fake `resolveSettings` result missing a required lock from `effective`, or with a policy tier in `sources` that Vonvon did not supply, refuses with `sandbox-not-confirmed` and spawns nothing; a complete result spawns.
- [ ] `scripts/prove-enforcement.mjs claude` on the Mac and on the Linux host records the nine probes into `docs/proofs.md` and `policy/proofs.ts`; the darwin and linux cells flip to `enforced`; `auditTable` stays green. Run `npm test -w packages/daemon -- provider/claude`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. A Claude `full` turn at V6c head and V6d head. Save `turn.txt`. Pass when the cards match.
- [ ] Lane 2. Mac, `qa` `project`, ask Claude to read `~/.ssh/config`. Save `qa-read.txt`. Pass when the step shows 拒绝 and no content appears.
- [ ] Lane 3. Mac, `qa` `project`, ask Claude to `cat ~/.ssh/config` in Bash. Save `qa-bash.txt`. Pass when Seatbelt denies and the step fails.
- [ ] Lane 4. Mac, `qa`, ask Claude to write a file. Save `qa-write.txt`. Pass when no file appears.
- [ ] Lane 5. Mac, `write` `project`, ask Claude to edit a project file and a file in `/tmp`. Save `write.txt`. Pass when the project file changes and the other is denied.
- [ ] Lane 6. Mac, `qa` `project`, a task that uses the `Agent` tool to read `~/.ssh`. Save `subagent-gate.txt`. Pass when the child's read is denied.
- [ ] Lane 7. Linux host with bwrap, lanes 2 and 5. Save `linux.txt`. Pass when both hold.
- [ ] Lane 8. Linux host with bwrap removed from `PATH`, `qa` group. Save `bash-off.txt`. Pass when the run starts, the card carries the Bash-off notice, and `Bash` is absent from the tool list.
- [ ] Lane 9. `qa` with network off, ask for a web fetch. Save `netoff.txt`. Pass when `WebFetch` is absent and the model says so.
- [ ] Lane 10. `qa`, a user hook and a `defaultMode: 'acceptEdits'` in `~/.claude/settings.json`, and one MCP server in `~/.claude.json`. Save `hooks.txt`. Pass when one turn produces one card, the gate still denies `~/.ssh`, `Edit` is still denied, and the card shows the MCP-off notice.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Hook latency per tool call, and first-token latency under `qa`.
- [ ] Probe. Five `qa` turns with 20 tool calls each; read hook timings from the log.
- [ ] Baseline. V6c `full` turns.
- [ ] Rule. Fail if the hook adds more than 20 ms per call or first token is more than 10% slower.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 2, 5, and 8 into `~/vonvon-review/V6d-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6d-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V6d only after the exact-head independent Shipping verdict is clean.

## ACP engine with Cursor, Grok, and custom ACP (V7a)

**Depends on.** V6b for the runtime. The ACP client and translation may start at `F6`. The provider ids and the picker need V4 merged and the root's `domain.ts` handoff. Acceptance needs `cursor-agent` and `grok` installed on the Mac with user-supplied accounts, and V4's web UI for the picker lane. V7a merges after V6b.

**Files.**

- [ ] Create `provider/engines/acp/{client,engine,translate,dialect}.ts` and `provider/engines/acp/dialects/{cursor,grok,custom}.ts`. `client.ts` is the thin client over `transport/jsonrpc.ts` described in `providers.md` *ACP engine and dialects*.
- [ ] Create `provider/engines/acp/tables.ts` with the cells of `providers.md` *ACP agents and Pi* for cursor, grok, and custom-acp.
- [ ] Edit `provider/model.ts` to add `'cursor' | 'grok' | 'custom-acp'` to `ProviderId`, and `provider/registry.ts` with the three registrations. Edit `packages/protocol/src/domain.ts` `toolSchema` to `["codex", "claude", "cursor", "grok", "custom-acp"]` and `packages/protocol/src/settings.ts` for `execution.customAcpCommand: { command: string; args: string[]; env?: Record<string, string> }`, both written by the root under *Shared files*. Edit the picker in `packages/ui/src/` to list providers from the daemon's `ProviderRuntime.list()`.
- [ ] Extend `scripts/prove-enforcement.mjs` with `grok.qa-gate` and `cursor.acp-permissions`, and `scripts/record-fixture.mjs --provider cursor|grok` for the probes `cursor.initialize`, `cursor.full-turn`, `grok.three-turns` of the audit. The Grok and Cursor fixtures under `packages/daemon/test/provider/fixtures/` are recorded fresh with this script. Orca's MIT fixtures are not copied, so `NOTICE` does not change for them.
- [ ] Create `packages/daemon/test/provider/fixtures/fake-acp.mjs`, a scriptable ACP agent, and tests `acp-client.test.ts`, `acp-translate.test.ts`, `grok-dialect.test.ts`, `cursor-dialect.test.ts`, `custom-acp.test.ts`, `acp-tables.test.ts`.
- [ ] Add `@agentclientprotocol/sdk` `^0.17.1` to `devDependencies` as a type-only import.

*Client.* Parses the JSON-RPC envelope, validates known `session/update` kinds against the SDK types, and passes every unknown kind, every `_meta`, and every non-standard method to the dialect. Advertises no `fs` and no `terminal` capability. Answers `session/request_permission` from the plan at once.

*Dialects.* Per `providers.md`. Grok: subagents, `x.ai/tool`, `turn_completed.stop_reason`, `retry_state`, `_x.ai/subagent/cancel`, refused `x.ai/*` requests, `--always-approve` for `full` only. Cursor: `cursor/task` as completed roster rows only, because it is a completion notification, `cursor/update_todos`, `cursor/generate_image`, all three after the probe records their payloads; `cursor/ask_question` declined with the payload's cancel or skip value or a JSON-RPC error, never an option; `cursor/create_plan` rejected; `cursor/list_available_models`. Custom: base translation, features from `initialize`, command from host settings.

**Build.**

- [ ] A Grok fixture containing `subagent_spawned` produces a roster entry where the stock `ClientSideConnection` throws.
- [ ] A test passes `createProviderRuntime` a registry with an extra `copilot` key, one object plus an empty dialect, and it passes the fake-agent conformance with no edit outside the test. The test stays as the addable-by-registration guard. Shipping Copilot for real needs these edits too: `'copilot'` in `ProviderId`, its `REGISTRY` entry, its cells in `acp/tables.ts`, its id in `toolSchema`, and its display name and login hint in `policy/messages.zh.ts`.

**You see.**

- [ ] A `full` group bound to Cursor, Grok, or 自定义 ACP answers a question with a run card, stops within 5.5 s, and shows a Chinese login hint when the CLI is not logged in.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `acp-client.test.ts`: unknown `session/update` kinds reach the dialect; the `initialize` body advertises no `fs` and no `terminal`; `session/request_permission` is answered synchronously and never pending; `session/cancel` before the prompt response ends the run `interrupted`; a fake agent that never answers `cancel` is tree-killed at 5.5 s.
- [ ] `acp-translate.test.ts`: each `StopReason` maps per the outcome table, `refusal` is `failed{refused}`, an unknown value is `failed{provider-error}` with the raw value; `plan` is `todo`; an `image` block is `image`; `tool_call` kinds map to `StepDetail`.
- [ ] `grok-dialect.test.ts` replays the fresh Grok recordings, a subagent turn and the three-turn probe: roster from `subagent_*`, `stopSubagent` sends `_x.ai/subagent/cancel`, `turn_completed.stop_reason` rate_limit is `failed{limit rate-limit}`, `retry_state` is `notice{retry}`, `-32000` on `session/new` is `not-logged-in` with the grok hint, `x.ai/ask_user_question` is refused with `notice{question-declined}`, a `todo_write` call produces no step, a compact command in `available_commands_update` turns on `compact`.
- [ ] `cursor-dialect.test.ts` replays the `cursor.full-turn` recording: `cursor/task` as a completed roster row and never a running one, `cursor/update_todos` merge and replace, `cursor/generate_image` image, `cursor/ask_question` declined at once without choosing any option, `cursor_login` failure hint. When the recording is not yet available the test is skipped with the probe named, and the cells stay `none`.
- [ ] `custom-acp.test.ts`: a registration from `execution.customAcpCommand` `{command, args, env}` passes conformance with `fake-acp.mjs`; unset and invalid commands refuse at open with the Chinese text; `qa` and `write` refuse; features derive from `initialize`.
- [ ] `acp-tables.test.ts`: every ACP cell matches `providers.md`; `grok:qa:unrestricted` is `refuse` until `grok.qa-gate` lands; `auditTable` is green. Run `npm test -w packages/daemon -- provider/acp`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe. Lanes 2 to 7 need user-supplied Cursor and SuperGrok accounts on the Mac. Until provided, they are recorded as not run and the PR stays blocked on them, while every other box proceeds.

- [ ] Lane 1. Regression lane against trunk. A Codex turn at V6d head and V7a head. Save `codex.txt`. Pass when the cards match.
- [ ] Lane 2. Grok `full`, one turn with a tool call. Save `grok.txt`. Pass when the card finishes with an answer.
- [ ] Lane 3. Grok, a task that spawns a subagent. Save `grok-subagents.txt`. Pass when a row appears and completes, and the probe recording `grok.three-turns` is saved.
- [ ] Lane 4. Grok, click stop mid-turn. Save `grok-stop.txt`. Pass when the card shows ⏹ 已停止 within 5.5 s.
- [ ] Lane 5. Cursor `full`, one turn. Save `cursor.txt`. Pass when the card finishes, and the `cursor.initialize` and `cursor.full-turn` recordings are saved.
- [ ] Lane 6. Cursor, a task that uses todos. Save `cursor-todo.txt`. Pass when the progress line appears after the dialect is updated from the recording.
- [ ] Lane 7. Log out of `grok` and send a message. Save `grok-login.txt`. Pass when the group shows the grok login hint and nothing hangs.
- [ ] Lane 8. Custom ACP with `fake-acp.mjs` as the command, set under host settings. Save `custom.txt`. Pass when a `full` group answers.
- [ ] Lane 9. Open the provider picker in the web UI with only Codex installed. Save `picker.png`. Pass when only Codex is offered.
- [ ] Lane 10. Bind a `qa` group to Grok. Save `grok-qa.txt`. Pass when the group shows the `tier-unenforceable` refusal and nothing spawns.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Codex first-token latency at both heads, and first token for Grok and Cursor.
- [ ] Probe. Interleave five Codex turns at V6d head and V7a head, then five turns per ACP provider.
- [ ] Baseline. V6d Codex.
- [ ] Rule. Fail if Codex is more than 5% slower, or an ACP provider's first token takes more than 15 s.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 2, 3, 5, and 9 into `~/vonvon-review/V7a-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V7a-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V7a only after the exact-head independent Shipping verdict is clean.

## Pi engine (V7b)

**Depends on.** V6b. May be developed beside V7a; the files do not overlap. Acceptance needs `pi` installed on the Mac or the Linux host. V7b merges after V7a.

**Files.**

- [ ] Create `provider/engines/pi/{engine,translate,table}.ts` over `transport/jsonl.ts`. Edit `provider/model.ts` to add `'pi'` to `ProviderId` and `provider/registry.ts` with the registration. The root adds `"pi"` to `packages/protocol/src/domain.ts` `toolSchema` under *Shared files*.
- [ ] Run probe `pi.no-tools-title` with `scripts/record-fixture.mjs --provider pi`: one `--mode rpc --no-tools` prompt that asks for a title. When it returns text with no tool call, `oneShot` flips to `native` in this PR; otherwise it stays `none` and the PR records why.
- [ ] Create `packages/daemon/test/provider/fixtures/fake-pi.mjs` and tests `pi-translate.test.ts`, `pi-engine.test.ts`, `pi-table.test.ts`. Record fixtures from the installed `pi` with `scripts/record-fixture.mjs --provider pi`.

*Mapping.* Per `providers.md` *Pi engine*. `steer` and `compact` native, `get_session_stats` for context, tool-result images, `auto_retry_*` as notices, `agent_end.willRetry` not terminal, `extension_ui_request` cancelled. `qa` with unrestricted reads launches `--tools read,grep,find,ls --no-extensions`.

**Build.**

- [ ] Pi appears in the picker when installed and offers `full` and `qa` unrestricted only.

**You see.**

- [ ] A `full` Pi group answers with a run card and stops within 3.5 s.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `pi-translate.test.ts` replays fixtures for a text answer, thinking, a bash tool, an edit tool, a `toolResult` with an image, `compaction_start/end`, `auto_retry_start/end`, `agent_end` with each `stopReason`, and a process exit.
- [ ] `pi-engine.test.ts`: `steer` and `compact` send `{type:'steer'}` and `{type:'compact'}`; `abort` ends the run `interrupted`; a fake Pi that never answers `abort` is tree-killed at 3.5 s; `extension_ui_request` is cancelled with a `notice`.
- [ ] `pi-table.test.ts`: `qa` unrestricted launches with the tool list; `qa` project and `write` refuse with the Chinese text; `auditTable` is green. Run `npm test -w packages/daemon -- provider/pi`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. A Codex turn at V7a head and V7b head. Save `codex.txt`. Pass when the cards match.
- [ ] Lane 2. Pi `full`, one turn with a bash tool. Save `pi.txt`. Pass when the card finishes.
- [ ] Lane 3. Pi, click stop mid-turn. Save `pi-stop.txt`. Pass when the card shows ⏹ 已停止 within 3.5 s.
- [ ] Lane 4. Pi, send a follow-up mid-turn. Save `pi-steer.txt`. Pass when it joins the turn.
- [ ] Lane 5. Pi, `/compact` in a long session. Save `pi-compact.txt`. Pass when the card shows the compaction.
- [ ] Lane 6. Pi, ask it to read a PNG. Save `pi-image.txt`. Pass when the image renders collapsed under the step.
- [ ] Lane 7. Pi `qa` unrestricted, ask it to write a file. Save `pi-qa.txt`. Pass when the tool is absent and no file appears.
- [ ] Lane 8. Pi `write`. Save `pi-write.txt`. Pass when the group shows the `tier-unenforceable` refusal.
- [ ] Lane 9. Kill the Pi process mid-turn. Save `pi-crash.txt`. Pass when the card shows the process-exit note and the next message resumes.
- [ ] Lane 10. Restart the daemon and reply in a Pi topic. Save `pi-resume.txt`. Pass when the reply has prior context.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Codex first-token latency at both heads, and Pi first token.
- [ ] Probe. Five Codex turns at each head, five Pi turns.
- [ ] Baseline. V7a Codex.
- [ ] Rule. Fail if Codex is more than 5% slower or Pi's first token takes more than 15 s.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 2 and 3 into `~/vonvon-review/V7b-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V7b-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V7b only after the exact-head independent Shipping verdict is clean.

## Cross-OS proofs and Windows acceptance (V7c)

**Depends on.** V7b. Acceptance needs a Windows host with Codex and Claude Code, and the Linux host. V7c merges after V7b. It is a leaf in the merge graph and blocks nothing. While no Windows host exists it is parked, with its Windows lanes unchecked.

**Files.**

- [ ] Edit `policy/proofs.ts`, the engine tables, and `docs/proofs.md` with the results. No product code changes except cell flips, unless a probe fails in a way that changes the design, which goes back to Claude Code per `AGENTS.md`.
- [ ] Extend `process-host.test.ts` Windows cases for the Job Object helper.

*Probes.* Windows: `codex.profile.read-denied`, `codex.profile.write-scope`, `codex.readonly.write-denied`, `codex.workspace-write.scope` with `windowsSandbox/readiness`, and `claude.qa.project`, `claude.write.project` with Bash off. Linux: the Codex probes already ran in V6b; lanes 7 and 8 recheck them at this head. Any probe from V6b, V6d, V7a, or V7b that did not run yet.

**Build.**

- [ ] Every cell marked `enforced` in `providers.md` has a `live` proof, or a `doc` proof of one of the two eligible kinds in `providers.md` *Data types* (an unrestricted `full` cell, or a `launch-args` cell), or is `refuse`. `auditTable` is green.

**You see.**

- [ ] On Windows, a Codex `qa` group with `project` reads either runs with the restricted-token sandbox proven, or refuses with the readiness or `unverified-combination` message.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/prove-enforcement.mjs` prints pass or fail per probe with the provider version; a pass flips its cell; a fail leaves `refuse` and the PR records the observed behavior.
- [ ] `process-host.test.ts` on Windows: a grandchild tree is killed through the Job Object; the helper closes the job when the daemon pid dies within 5 s.
- [ ] `enforcement.test.ts` asserts that every cell in `docs/proofs.md` has a matching `Proof` in `policy/proofs.ts`. Run `npm test -w packages/daemon -- provider`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe. Lanes 2 to 6 run on the Windows host and are marked as such.

- [ ] Lane 1. Regression lane against trunk. A Codex turn at V7b head and V7c head on the Mac. Save `codex.txt`. Pass when the cards match.
- [ ] Lane 2. Windows, Codex `qa` `project`, read `%USERPROFILE%\.ssh\config`. Save `win-qa-read.txt`. Pass when denied, or when the group refuses with the readiness message and the PR records which.
- [ ] Lane 3. Windows, Codex `write` `project`, write inside and outside. Save `win-write.txt`. Pass when inside succeeds and outside is denied, or the cell refuses.
- [ ] Lane 4. Windows, Claude `qa` `project`. Save `win-claude-qa.txt`. Pass when the run starts with the Bash-off notice and `~/.ssh` is denied by the gate.
- [ ] Lane 5. Windows, kill the Codex process mid-turn. Save `win-crash.txt`. Pass when the card shows the process-exit note and the Job Object leaves no grandchild.
- [ ] Lane 6. Windows, `kill` the daemon, start it again. Save `win-sweep.txt`. Pass when `sweepOrphans` reports the orphan killed.
- [ ] Lane 7. Linux, Codex `qa` unrestricted, write a file. Save `linux-ro.txt`. Pass when the write is denied.
- [ ] Lane 8. Linux, Codex `write` unrestricted with network off. Save `linux-ww.txt`. Pass when a write inside succeeds, writes outside `root`, to `/tmp`, and to `$TMPDIR` are denied, and a `curl` fails.
- [ ] Lane 9. Mac, every provider installed, open the picker. Save `picker.png`. Pass when all six are offered with their tiers.
- [ ] Lane 10. Mac, `vonvon doctor`. Save `doctor.txt`. Pass when each provider shows installed, version, auth, and the tiers this host offers.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Daemon boot time with `sweepOrphans` and the host probe.
- [ ] Probe. Ten cold boots at V7b head and V7c head.
- [ ] Baseline. V7b.
- [ ] Rule. Fail if boot is more than 200 ms slower.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy screenshots of lanes 2, 4, and 9 into `~/vonvon-review/V7c-review-<slug>.png`, with the OS in the slug.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V7c-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V7c only after the exact-head independent Shipping verdict is clean.

## Import bridge data and shut the bridge down (V8)

**Depends on.** V4 for the UI import flow and acceptance. The daemon side, `import/**`, `cli/commands/import.ts`, and `protocol/src/import.ts`, starts from `H3` or `main`, and `packages/ui/src/import/**` waits for `F4`. V8 merges after V4, which has landed, so it merges when verified. It does not wait for the provider chain; see *After V3* on provider ids.

**Files.**

- [ ] Create `packages/daemon/src/import/bridge/preflight.ts`, `journal.ts`, `execute.ts`, `legacy-keystore.ts`, and `hooks.ts`.
- [ ] Create `packages/daemon/src/import/bridge/service-control/launchd.ts`, `systemd.ts`, and `windows.ts`.
- [ ] Create `packages/protocol/src/import.ts`.
- [ ] Create `packages/ui/src/import/`.
- [ ] Create `packages/daemon/src/cli/commands/import.ts` for `vonvon import feishu-codex-bridge`. The root registers it in `cli/index.ts`.

**Build.**

- [ ] Port preflight, journal, and receipts from vonvon-bridge-legacy `packages/runtime/src/cli-migration-preflight.ts`, `cli-migration-transaction.ts`, and `cli-migration-service.ts`.
- [ ] Read `secrets.enc` with the bridge key derivation in `legacy-keystore.ts` and re-encrypt under `master.key`.
- [ ] Detect and stop the bridge on all three platforms. Port launchd from legacy `legacy-cli-control.ts`, and write systemd and Windows Run key control from the bridge's own `src/service/`.
- [ ] Run the phases pause, copy, hooks, start, verify connected, disable autostart, write marker. Restore the bridge on any failure.
- [ ] Add the import step to first-run onboarding in the UI.

**You see.**

- [ ] On a machine with a running bridge, the import screen lists bots, groups, and sessions, and after confirm shows every bot connected in Vonvon Bot while the bridge service is gone.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/daemon/test/import-bridge.test.ts` crashes the executor after each phase and checks that a rerun converges to the same end state, and that a failure before verify restores the bridge files. Run `npm test -w packages/daemon -- import-bridge`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- Lane context. Every V8 lane runs in a dedicated test context, never in `clay`. On the Mac that is `test-user` in `gui/502`. On Linux it is `accept-user` on the Tencent host. Import pauses and disables the bridge service that it finds through `launchctl list` or `systemctl --user` of the calling user (`service/control.ts` `inspectInstallation`), and it rewrites the hooks under `HOME`. In `clay` it would therefore reach the daily bridge even with another `HOME`. Each lane's preflight in its context must find no `ai.feishu-codex-bridge.bot` job or `feishu-codex-bridge.service` unit, no bridge definition file, no `~/.feishu-codex-bridge`, and no Vonvon job or unit. On the Mac, the preflight also checks as `test-user` that `test -w` fails for `/Users/clay`, `/Users/clay/Library/LaunchAgents`, and `/Users/clay/.feishu-codex-bridge`. Lanes connect only the dedicated test bot, under *Exclusive test bot* in [native-acceptance-hosts.md](native-acceptance-hosts.md). Every lane ends with owned teardown T from that document. Before and after every Mac lane, from `clay`'s account and read-only, record the daily bridge's pid, `ps -o lstart=`, `lsof` listeners, `launchctl print` summary, and plist checksum. Any difference fails the lane, and the bridge is never restarted to repair it. The daily bridge's data files are not compared byte for byte, because the running bridge writes them during normal use. The `test -w` check is their protection. If `gui/502` does not exist, every Mac lane stays unchecked and V8 does not merge. Lane 1 and lane 3 need both contexts, lane 2 needs the Mac, and lanes 4 to 10 pass in either context.
- [ ] Lane 1. Regression lane against trunk. Trunk has no import, so record that. On the Mac as `test-user` in `gui/502`, install bridge `446b2a4` as its LaunchAgent with the test bot, import at head with a run-owned `VONVON_HOME`, and message the bot. Save `import-happy.png`. Pass when the reply comes from Vonvon Bot, `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` fails, and `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist` is gone. Repeat the lane on Linux as `accept-user`, where the bridge installs its user unit `feishu-codex-bridge.service`. Save `import-happy-linux.txt`. There it passes when the reply comes from Vonvon Bot, `systemctl --user show -p LoadState feishu-codex-bridge.service` prints `not-found`, the unit file is gone, and `~/.feishu-codex-bridge/migrated-to-vonvon-bot.json` exists.
- [ ] Lane 2. As `test-user`, with the test bridge `446b2a4` installed as its LaunchAgent and running, and with no message sent to the test bot during the lane, run preflight only. Save `preflight.png`. Pass when the bridge keeps running, with the same pid and start time and its job still loaded, and the source checksum is unchanged. The source checksum covers every file that import would copy.
- [ ] Lane 3. As `test-user`, with the test bridge installed as its LaunchAgent and running, use a wrong App Secret in the bridge data. Save `bad-secret.png`. Pass when verify fails and the bridge service is running again: `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` shows a pid, the plist has its preflight checksum, no `migrated-to-vonvon-bot.json` exists, and no imported Bot runs in Vonvon Bot. Repeat the lane on Linux as `accept-user` with the bridge's user unit. Save `bad-secret-linux.txt`. There it passes when verify fails, `systemctl --user is-enabled feishu-codex-bridge.service` prints `enabled`, `is-active` prints `active`, the unit file has its preflight checksum, and no marker exists. Restore the correct secret before teardown.
- [ ] Lane 4. Kill the daemon during the copy phase and restart it. Save `crash-resume.txt`. Pass when the import resumes or rolls back and the bot answers from exactly one process.
- [ ] Lane 5. Import twice. Save `twice.png`. Pass when the second attempt reports the existing receipt.
- [ ] Lane 6. Check the coffee hooks after import. Save `hooks.txt`. Pass when `~/.claude/settings.json` and `~/.codex/hooks.json` call `vonvon hook` and nothing else changed.
- [ ] Lane 7. Run `feishu-codex-bridge run` by hand after import. Save `old-run.txt`. Pass when Vonvon Bot's UI shows a warning that the bridge is running.
- [ ] Lane 8. Import a legacy flat layout without `bots.json`. Save `flat.png`. Pass when the bot and its projects import.
- [ ] Lane 9. Import with `vonvon import feishu-codex-bridge --yes` from the CLI. Save `cli-import.txt`. Pass when the CLI reports the same receipt as the UI path.
- [ ] Lane 10. Confirm the two-client event split with two processes on the test bot and 20 messages. Save `event-split.txt`. Pass when the counts are recorded per process, which settles the open question in Appendix A.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Downtime from bridge pause to all bots connected in Vonvon Bot, on a fixture of 3 bots, 10 projects, and 230 sessions.
- [ ] Probe. Run five imports on fresh fixture copies and read the journal timestamps.
- [ ] Baseline. Record that trunk has no import path, so the budget is absolute.
- [ ] Rule. Fail if the median downtime is over 30 s.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 1, 2, and 3 screenshots into `~/vonvon-review/V8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V8-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V8 only after the exact-head independent Shipping verdict is clean.

## Ship the bridge release that points users to Vonvon Bot (V9)

**Depends on.** V8, and the Mac agent's signed installer URL, for acceptance and merge. Development may start at any time from `origin/codex/device-handoff`, because it needs only the marker name, which `architecture.md` fixes. Until the installer is published, the link is a configuration candidate, and lane 10 cannot pass. No placeholder, staging, or unpublished URL satisfies lane 10.

**Files.**

- [ ] Edit `src/service/desktop-release.ts`, `src/card/dm-cards.ts`, `src/cli/index.ts`, and `src/cli/commands/run.ts` in `modelzen/feishu-codex-bridge`.
- [ ] Edit `src/cli/commands/daemon.ts` and `src/cli/commands/update.ts`, which print the notice per **Build**, and `src/web/ui.ts`, which holds the existing web console overview banner that lane 6 checks. These three were missing from this list. Using the existing banner is not a new UI surface.
- [ ] Create `src/bot/owner-notice.ts` and `test/owner-notice.test.ts`.

**Build.**

- [ ] Change the desktop release notice from commit `8c11067` to point to Vonvon Bot and its import.
- [ ] Send each bot owner one Feishu DM card on daemon start, guarded by a flag file.
- [ ] Print the notice on `start`, `status`, and `update`.
- [ ] Refuse `run` when `migrated-to-vonvon-bot.json` exists, with a message that names Vonvon Bot.

**You see.**

- [ ] A bot owner gets one DM card that links to the Vonvon Bot download, and a migrated machine's bridge refuses to start.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `test/owner-notice.test.ts` sends once, skips on restart, and refuses `run` with the marker. Run `npm test -- owner-notice` in the bridge repo.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Start the bridge at `446b2a4` and at head with the test bot. Save `startup.txt`. Pass when both connect and only head sends the notice.
- [ ] Lane 2. Restart head. Save `no-repeat.txt`. Pass when no second notice is sent.
- [ ] Lane 3. Open the DM menu card. Save `dm-menu.png`. Pass when it shows the Vonvon Bot entry.
- [ ] Lane 4. Run `feishu-codex-bridge update`. Save `update.txt`. Pass when the output names Vonvon Bot.
- [ ] Lane 5. Write the marker and run `feishu-codex-bridge run`. Save `refuse.txt`. Pass when it exits non-zero with the Vonvon Bot message.
- [ ] Lane 6. Open the web console overview. Save `console.png`. Pass when the banner shows.
- [ ] Lane 7. Run with the release feed unreachable. Save `offline.txt`. Pass when startup still succeeds.
- [ ] Lane 8. Run the bridge suite. Save `suite.txt`. Pass when every test passes.
- [ ] Lane 9. Run `feishu-codex-bridge status`. Save `status.txt`. Pass when the notice prints once.
- [ ] Lane 10. Follow the card link. Save `download.png`. Pass when it opens the published installer page.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from process start to the bot connected log line.
- [ ] Probe. Interleave five starts at `446b2a4` and five at head.
- [ ] Baseline. Record the `446b2a4` number first.
- [ ] Rule. Fail if head is more than 200 ms slower in the median.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 3, 5, and 6 captures into `~/vonvon-review/V9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V9-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V9 in the bridge repo after the exact-head independent Shipping verdict is clean and V8 has landed. Publish the npm release only after its release checks and required external gates are satisfied.

## Add accounts and the machine list (V10)

**Depends on.** V4 for `packages/ui/src/account/**`, which waits for `F4`. `packages/cloud/**`, `packages/daemon/src/cloud/**`, and the login commands start from `H3` or `main`. Lane 8 needs the V5 shell. V10 merges after V5's shell, or V5a if V5 splits. It does not wait for V9. V10 publishes the freeze point `F10`.

**Files.**

- [ ] Create `packages/cloud/src/server.ts`, `oauth.ts`, `accounts.ts`, `devices.ts`, `store/repository.ts`, `store/postgres.ts`, and `store/memory.ts`.
- [ ] Create `packages/daemon/src/cloud/enroll.ts`, `link.ts`, and `credential.ts`.
- [ ] Create `packages/cloud/test/devices.test.ts` and `packages/cloud/test/repository-contract.test.ts`.

*Device contract (issue 75).* The private storage shape is in `architecture.md` under *云端私有存储*. It is the only cloud storage V10 adds. It holds no settings and does not copy vonvon-bridge-legacy's login-bound session, device, or snapshot model.

- Repository. `store/repository.ts` declares one interface: `upsertAccount(provider, subject)`, `getAccount`, `createDevice`, `rotateDevice`, `findActiveDevice(accountId, machineId)`, `getDeviceCredential(deviceId)`, `renameDevice`, `revokeDevice`, `listDevices(accountId)`, `setPresence(deviceId, linkState, heartbeatAt)`, and `getPresence`. `store/memory.ts` and `store/postgres.ts` implement it, and `repository-contract.test.ts` runs the same cases against both. Postgres runs in that test only where a database URL is configured. Lane 7 and the perf probe use Postgres.
- Enrollment. The daemon generates a 32-byte device secret and its X25519 key pair locally. It sends the secret's SHA-256, never the secret, with its `machineId`, name, and public key, under the user's login session. The cloud creates a device, or, for the same account and `machineId` with an active device, rotates that device in place: same `deviceId`, new secret hash and public key, and the old credential stops working at once. A device of another account is never read or changed.
- Credential validation. Each time the link connects, it presents `deviceId` and the secret itself, transiently, to authenticate. This is the only time the secret leaves the daemon. The cloud hashes the received secret, compares the hash with the stored hash in constant time, and then drops the secret. It never stores or logs the secret, and its storage keeps only `secretHash`. It refuses a revoked or unknown device with `device_revoked` or `device_unknown`. The login session never authenticates the link, and logout does not revoke the device. No challenge-response protocol is added.
- Revocation. Removing a machine sets `revokedAt` and closes its open links with `device_revoked`. The daemon then deletes its local credential file, per lane 5. Enrolling that machine again creates a new `deviceId`.
- Presence. The link sends a heartbeat every 15 s. The device is online while its link is open and its last heartbeat is at most 45 s old, and offline otherwise, which keeps lane 3 and the perf rule's 45 s bound for a link that dies without a close. A cloud restart marks every link closed, and daemons reconnect with their stored credential, per lane 9. The public `lastSeenAt` is derived from presence.
- Daemon storage. `credential.ts` keeps `{cloudUrl, accountId, deviceId, secret, x25519PrivateKey}` in `cloud/device.json`, mode 0600, with the secret and the private key encrypted under `master.key`. The X25519 private key never leaves the daemon. The secret reaches the cloud only as the transient link credential above, and the cloud persists only its hash.
- [ ] Create `packages/ui/src/account/`.
- [ ] Create `packages/daemon/src/cli/commands/login.ts` for `vonvon login` and `vonvon logout`. The root registers them in `cli/index.ts`.

**Build.**

- [ ] Port Feishu and Lark SSO from vonvon-platform `src/oauth.ts`.
- [ ] Store accounts, devices, credentials, and presence behind the one repository interface in *Device contract*, with Postgres and memory backends.
- [ ] Validate the daemon-generated device credential at the link, separate from the user session, per *Device contract*. vonvon-bridge-legacy `packages/account-service` is a reference for the separation only. Its login-bound records are not copied.
- [ ] Keep presence from the daemon's outbound link, per *Device contract*. Store no settings.
- [ ] Add login and the machine list to the UI. Offline machines show offline and nothing else.

**You see.**

- [ ] After `vonvon login` on two machines, the web UI lists both under one account with online states.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/cloud/test/devices.test.ts` covers enroll, rename, revoke, and a revoked credential being refused. It also covers re-enrollment rotating in place with the old secret refused, a second account never touching the first account's device, a wrong secret refused, presence going offline at once on link close and after 45 s without a heartbeat, and re-enroll after revoke getting a new `deviceId`. `repository-contract.test.ts` runs the repository cases against memory and Postgres. Run `npm test -w packages/cloud`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Use the UI at V4 head and at V10 head without logging in. Save `no-login.png`. Pass when both show the local Bot list and nothing asks for login.
- [ ] Lane 2. Run `vonvon login` with dev auth on two daemons. Save `two-machines.png`. Pass when the machine list shows both online.
- [ ] Lane 3. Stop one daemon. Save `offline.png`. Pass when it shows offline within 45 s and no settings appear for it.
- [ ] Lane 4. Rename a machine. Save `rename.png`. Pass when the new name shows after reload.
- [ ] Lane 5. Remove a machine from the account. Save `revoke.txt`. Pass when its daemon logs revocation and deletes its credential.
- [ ] Lane 6. Log out in the UI. Save `logout.png`. Pass when the local machine keeps running and stays manageable locally.
- [ ] Lane 7. Query the cloud database tables. Save `db.txt`. Pass when no row holds a path, bot name, secret, or setting.
- [ ] Lane 8. Log in on the desktop shell through the browser handoff. Save `desktop-login.png`. Pass when the machine list appears.
- [ ] Lane 9. Restart the cloud server. Save `restart.txt`. Pass when daemons reconnect without logging in again.
- [ ] Lane 10. Send 50 login attempts in a minute. Save `rate.txt`. Pass when the limiter refuses the excess.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from daemon start to online in the machine list, and from daemon stop to offline.
- [ ] Probe. Ten start and stop cycles against a local cloud server.
- [ ] Baseline. Record that trunk has no cloud, so the budget is absolute.
- [ ] Rule. Fail if online takes more than 5 s or offline more than 45 s in the median.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 2, 3, and 8 screenshots into `~/vonvon-review/V10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V10-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V10 only after the exact-head independent Shipping verdict is clean.

## Manage any machine remotely through an encrypted relay (V11)

**Depends on.** V10. `packages/client/src/e2ee/**` and `e2ee.test.ts` may start from `main` at any time. Everything else waits for `F10`, and `transport-relay.ts` and the switcher also wait for `F4`. Lane 7 needs the V5 shell. V11 merges after V10.

**Files.**

- [ ] Create `packages/cloud/src/relay/`.
- [ ] Create `packages/daemon/src/cloud/relay-transport.ts` and `machine-key.ts`.
- [ ] Create `packages/client/src/transport-relay.ts` and `e2ee/` from Paseo `packages/relay/src/crypto.ts`, `e2ee.ts`, `encrypted-channel.ts`, and `base64.ts`, which the other three import. The root adds `tweetnacl` `^1.0.3` and `base64-js` `^1.5.1` to `packages/client`, Paseo's ranges, under *Shared files*.

*Handshake (issue 71).* V11 keeps Paseo's pinned handshake and adds no cryptography.

- What the pinned code does. The daemon's public key comes from the cloud's device row. The client sends its own public key, and the daemon answers with a plaintext `e2ee_ready`, which is not authenticated. A client given a different but valid 32-byte key still accepts `e2ee_ready`, and the channel fails only when the first encrypted frame does not decrypt. A key of the wrong length fails earlier, at key import. These are separate cases.
- Product rule. `e2ee_ready` never means authenticated. `transport-relay.ts` reports the machine connected only after the first frame from the daemon decrypts and parses as the RPC `serverInfo` reply. Before that, no RPC request is sent and no state is shown. A decrypt failure closes the channel with a handshake error. This uses the existing messages. It changes no protocol message and no executable JavaScript of the pinned crypto files. The only source differences from the pin are the two erased non-null assertions and the modification-notice comment that *Compiler contract* below records.
- Residual risk, recorded in `architecture.md` and `roadmap.md`. The cloud supplies the daemon's public key, so a cloud that substitutes both the key and the daemon side can read the traffic. V11 accepts this risk, as Paseo does. Detecting it would need an authenticated handshake or out-of-band key verification, which is a later design, not V11.

*Compiler contract.* The client type-checks `src/**` under `tsconfig.base.json`, which sets `noUncheckedIndexedAccess`. The pinned `encrypted-channel.ts:576`, `difference |= a[i] ^ b[i];`, reports two TS2532 under that flag. V11 applies rule E1 below twice, a postfix `!` after `a[i]` and after `b[i]`, adds the notice of *Modification notice* below at offset 0, above the existing `/// <reference lib="dom" />` line, which stays valid because only comments precede it, and changes nothing else in the four files. `packages/client/src/e2ee/closure.json` records each file with its pinned SHA-256 and integrated SHA-256, the three unchanged files as `pinned`, and `encrypted-channel.ts` as `type-only` with `preTypeEditSha256`, `integratedSha256`, the two edits with start, end, line, column, form, replaced and inserted text, and the owned diagnostic, and its `modificationNotice`. The kind is `type-only`, never `adapted`, which marks a logic edit. `packages/client/test/e2ee-closure.test.ts` checks every on-disk hash, that exactly one file is `type-only` with exactly those two edits and one notice that meets the *Modification notice* rule below, and that forward replay on the pinned bytes reproduces the integrated hash and reverse replay on the on-disk bytes reproduces the pinned hash, both under the *Ledger* rule below, where the two `!` are its insertion case with empty `replacedText`. It applies the *Type and directive rule* below with a stricter bound. Each of the four files parses with zero `AnyKeyword` nodes and zero suppression directives, so the English word any in the pinned comments at `encrypted-channel.ts:265` and `:388` passes and stays. Its negative cases are a third edit, a non-`!` edit, a changed hash, an edit whose offset does not point at its `insertedText`, a one-byte change to any file, a missing or second notice, a notice line that contains `@`, ` as any` at line 576, and an added `// @ts-expect-error` line, each applied to an in-memory copy so the named check fails on its own. The two edits sit at pre-edit offsets 18451 and 18458. With a notice of length L at offset 0 they are integrated offsets 18451 + L and 18459 + L, and the ledger records the pre-edit values. `scripts/type-only-identity.mjs`, a Vonvon-owned root script, rebuilds the pre-edit text by that reverse replay and asserts its SHA-256 equals `preTypeEditSha256` before transforming anything. It then proves two results under the esbuild options of *Identity proof* below and under `ts.transpileModule` with `module` `NodeNext` and `target` `ES2022`, because `tsc` is the client's emitter. First, the integrated text with only the notice reverted gives byte-identical output to the pre-edit text under both tools. Second, the full integrated text gives byte-identical esbuild output, and byte-identical `ts.transpileModule` output with `removeComments` set, so the notice adds only comments. The notice comment in `tsc`'s `dist` output is the only allowed output difference. The script records both tool versions and every hash in `identity-proof.json`. No `compilerOptions`, `include`, `exclude`, or tsconfig file under `packages/client` changes, and `tsc --showConfig -p packages/client` matches `main`. `NOTICE`, root-owned, names the file and the two assertions. Never allowed: an `any` type, a suppression directive, a tsconfig change, a wrapper that alters the pinned call, or any byte in the four files other than the two `!` and the notice. The expected pinned hash of `encrypted-channel.ts` is `2b0d31520917d24993644fc30f065be4d46d3517475f8821388a2263ced3e6a6`, and `fcdae791dce9f732f4d765aaf94c9e1a799d4dff9b471e73cd0d713290523516` is the expected hash after the two `!` and before the notice. Codex recomputes the integrated hash and the offsets on the branch and does not copy them from this plan.

These rules belonged to the withdrawn V7 of 2026-10-11 (`git show 7a101ce:docs/plan.md`, lines 1438 to 1454). V11 is now their only user, so they are restated here and apply to the four e2ee files only.

- E1, non-null assertion. A postfix `!` on an expression that the diagnostic reports as possibly `undefined`. In V11 only TS2532 qualifies, and only at `encrypted-channel.ts:576`. Under Paseo's own settings an indexed access already has the non-undefined type, so E1 restores the type upstream compiled with. No other edit form is allowed.
- Modification notice. `packages/daemon/LICENSE.paseo` section 4(b) requires modified files to carry prominent notices stating that the files were changed. So `encrypted-channel.ts` carries an in-file notice as well as the `NOTICE` entry, and the ledger records it as the file's `modificationNotice`, form `N`, with `replacedText` empty and pre-edit `start` 0. `insertedText` is one to three whole lines, each `// ` followed by printable ASCII and a line feed. The first line starts with `// Modified from Paseo`, and the lines state that the file has type-only edits erased at compile time and give the path `packages/client/src/e2ee/closure.json`. No inserted line contains `@`, `/*`, `*/`, `eslint`, or `<reference`, so the notice is not a legal comment that esbuild keeps and not a TypeScript, JSX, or lint directive. `N` owns no diagnostic and is not a type-only edit, but replay includes it. The closure test scans `insertedText` with `ts.createScanner`, keeping trivia, and accepts only `SingleLineCommentTrivia`, `NewLineTrivia`, and `WhitespaceTrivia`. No upstream byte is deleted or rewritten for the notice.
- Ledger. Each edit records `start`, `end`, line, column, form, `replacedText`, `insertedText`, and the codes and positions of the diagnostics it resolves. Every `start` and `end` is an offset in the pre-edit text, whose SHA-256 is `preTypeEditSha256`. `end` minus `start` is the length of `replacedText`, which is empty for an insertion such as the two `!`. The edits and the notice are listed in strictly ascending `start`, and no `end` exceeds the next `start`. Forward replay works on the pre-edit bytes in descending `start` order. Before each edit it asserts that the slice from `start` to `end` equals `replacedText`, then replaces it with `insertedText`. Reverse replay works on the integrated bytes in ascending `start` order. Every earlier edit is already reverted, so the edit's integrated slice begins at its pre-edit `start` and has the length of `insertedText`. The tool asserts the slice equals `insertedText`, then replaces it with `replacedText`. A slice that differs, a wrong order, or a stale offset fails by naming the edit instead of producing a wrong hash. Forward replay must reproduce `integratedSha256` and reverse replay `preTypeEditSha256`.
- Identity proof, esbuild options. `esbuild.transform` from the repository's esbuild, with `loader: "ts"`, `format: "esm"`, `target: "es2022"`, no minification, no source map, and `tsconfigRaw` `{"compilerOptions": {"verbatimModuleSyntax": false, "useDefineForClassFields": true}}`. esbuild prints from the syntax tree, so an erased type or a grouping parenthesis is not a difference, and it drops the notice as a non-legal comment.
- Type and directive rule. The test parses the pre-edit and integrated text of each file with `ts.createSourceFile` and counts `SyntaxKind.AnyKeyword` nodes, which are exactly the `any` type. It collects every comment from the parsed tree with `ts.getLeadingCommentRanges` at each node's full start and `ts.getTrailingCommentRanges` at its end, over every node and token from `getChildren`, deduplicated by position. A raw `ts.createScanner` pass over a whole file is not used, because it loses sync at template literals and regular expressions. A comment that contains `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, or `eslint-enable` is a suppression directive. The word any in a comment, a string, or an identifier is not an `any` type and passes, because the rule reads syntax kinds, not substrings. V11's stricter bound is zero of each in all four files.

- [ ] Edit `packages/ui/src/` to add the machine switcher, and edit `NOTICE`.

**Build.**

- [ ] The daemon registers its X25519 public key at enrollment and keeps one outbound relay socket.
- [ ] The client opens a relay channel per machine and runs the same RPC over the encrypted channel.
- [ ] The cloud hosts `packages/ui/dist` and forwards ciphertext only.
- [ ] The UI warns when one `appId` is enabled on two online machines.

**You see.**

- [ ] From the hosted web UI, the user switches to another machine and changes a group setting, and the change shows on that machine.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/client/test/e2ee.test.ts` checks that a tampered frame is rejected. With a different valid public key, it checks that `e2ee_ready` arrives, the first encrypted frame fails to decrypt, the channel closes with a handshake error, and the transport never reports connected or sends an RPC. With a public key of the wrong length, it checks the early import failure as its own case. Run `npm test -w packages/client`. The run includes `e2ee-closure.test.ts`, `tsc -p packages/client --noEmit` exits 0, the `showConfig` comparison against `main` is unchanged, and `identity-proof.json` is saved with the PR.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Change a group setting locally at V10 head and remotely at V11 head. Save `remote-edit.png`. Pass when both changes land in `projects.json`.
- [ ] Lane 2. Capture relay traffic on the cloud side. Save `capture.txt`. Pass when no plaintext setting or path appears.
- [ ] Lane 3. Open a machine that is offline. Save `offline.png`. Pass when the UI says the machine is offline and shows no settings.
- [ ] Lane 4. Enable the same bot on two machines. Save `same-bot.png`. Pass when the warning shows.
- [ ] Lane 5. Drop the daemon's relay socket. Save `reconnect.png`. Pass when the client reconnects within 10 s.
- [ ] Lane 6. Revoke the machine while a client is connected. Save `revoked.png`. Pass when the client loses access at once.
- [ ] Lane 7. Use the desktop shell to open a remote machine. Save `desktop-remote.png`. Pass when the remote Bot list shows.
- [ ] Lane 8. Browse folders on the remote machine and bind a group. Save `remote-bind.png`. Pass when the remote `projects.json` lists it.
- [ ] Lane 9. Replace the daemon public key in the cloud row with another valid key. Save `mitm.txt`. Pass when the client closes the channel at the first encrypted frame, shows a handshake error, and no RPC or setting crossed. This shows key substitution is detected when the daemon side is genuine. It does not show the handshake is authenticated.
- [ ] Lane 10. Hold two clients on one remote machine and edit from one. Save `fanout.png`. Pass when the other sees the new revision.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Snapshot round trip p50 and p95 for a local client and for a relay client on the same host.
- [ ] Probe. Interleave 200 local and 200 relay snapshot requests.
- [ ] Baseline. Record the local numbers first.
- [ ] Rule. Fail if relay p95 exceeds local p95 plus 150 ms on the same host.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 1, 3, 4, and 7 screenshots into `~/vonvon-review/V11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V11-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V11 only after the exact-head independent Shipping verdict is clean.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

No prototype ran before this plan. Three questions stay unproven, and each one has a lane that settles it.

- Whether two clients on one Feishu app split events. V8 lane 10 measures it. Until then the design assumes the split, which is why import pauses the bridge first.
- Whether the Claude `PreToolUse` gate confines `Read`, `Grep`, and `Glob`, including inside subagents, and whether the sandbox `allowRead` overrides a `denyRead` parent. V6d's probes `claude.qa.project`, `claude.subagent-gate`, and `claude.sandbox.allowread-override` prove it. Until they run, the Claude `qa` and `write` cells refuse.
- Whether the copied bridge suite passes unchanged after the data root move. V2's unit box proves it.

The facts below were read from source this session, not run.

- The bridge data root is fixed at `~/.feishu-codex-bridge` in `src/config/paths.ts`, and the key derives from `hostname|username` at `src/config/keystore.ts:75`.
- The bridge Claude backend reports `steer: false` and `approvals: false` in `src/agent/claude-agent/backend.ts:201` and `:206`, and uses `bypassPermissions` in `permission.ts:56`.
- The Core fork `codex/device-handoff` is 49 commits ahead of bridge `main` and holds 153 test files.

## Appendix B. Alternatives rejected

- Keep vendoring the bridge Core. Every Core change needs a bridge release and a pin, and the product stays dependent on another package.
- Adopt Paseo's Expo and React Native Web UI. It would replace the whole UI and lose the original style the owner wants to keep.
- Make Paseo's `AgentSession` the bot-facing contract. Its shape carries Paseo's session, permission, and timeline types into the bot. V6b instead moves the 39 source consumers onto Vonvon's own `ProviderRuntime`, whose types `providers.md` defines.
- Store settings or snapshots in the cloud. The owner decided against it, and it would put paths and secrets off the machine.
- Require login, as in vonvon-bridge-legacy ADR 0012. The owner chose optional login.
- Keep the cloud in the vonvon-platform repo. Protocol changes would need two branches in two repos.
- Copy data while the bridge keeps running. The bridge writes `sessions.json` during a turn, and two clients on one bot split events.
- Widen V3's `DesktopSnapshot` to carry the old `GET /api/state` bots and projects. Every snapshot event would carry process fields and avatars to every client. Pid and session-count changes would bump the UI revision, and the V4 UI contract would change. V3 instead keeps the snapshot as is and adds the lossless `admin` `state` reply.
- Compare V3's `DesktopSnapshot` projection with `GET /api/state` in lane 1. The projection drops `tenant`, `current`, `pid`, `startedAt`, `completionReminder`, `blank`, `branch`, `origin`, `autoCompact`, `allowedUsersCount`, `sessionCount`, and `createdAt`, so the regression lane would stop checking them.
- Keep the read-only preview and its page-driven `POST /api/daemon/start`. It would keep a second HTTP server outside the daemon, with its own token and direct file reads, after V3 moves administration to the daemon's WebSocket. `vonvon daemon start`, V4's `vonvon open`, and V5's shell starting the daemon cover the stopped case.
- Mirror every old route in one new RPC group. It would duplicate the V1 groups the V4 UI already speaks and leave two write paths for one setting. V3 adds `admin` only for routes with no V1 home.
- Keep V2's complete backend-install replay and bound output admission by killing npm at an output cap. A verbose but healthy install would fail and roll back, which breaks the rule that installs run to the end. Output volume is not a failure signal. V3 instead keeps a bounded tail and counts what it drops.
- Spool the full install output to disk and page it through a new request. That adds a request, a disk budget, and cleanup, and the disk use is still unbounded. Install output is progress, and the installer's error tail already keeps the failure diagnosis.
- Mark the dropped head with in-band text in the first replay chunk. npm output could contain the same text, so a client could not tell the marker from real output. The optional `omittedBytes` count is exact.
- Cap npm's wall-clock time in V3. Memory is already bounded without a cap. A timeout would need cancel semantics for a request that has no job id, and a slow network makes a timeout value arbitrary. Roadmap 已知风险 tracks the stalled case.
- Bring the Vonvon service into V3: its identity, definition, manager-driven restart, and native acceptance. The V3 plan never required a native service, and V5 owns **Open at login**. It would add install transactions, cross-root registration protection, and a native gate that needs a dedicated test user nobody can provide now. V3 instead refuses the service commands and leaves the service to V5's *Service gate*.
- Keep the copied `__daemon-control` stop, which uninstalls an installed service. No V2 daemon ever ran that path, because the routes answered 501. It also reaches the adapters that carry the bridge identity. V3 removes it or makes it refuse.
- Keep the helper's 30 s deadline, or persist restart intent in a new file under `VONVON_HOME`. A deadline leaves no replacement after a long, legitimate drain. A file adds a storage shape. The helper process already holds the intent for exactly as long as the old owner lives, and the old daemon can cancel it because it spawned it. The cost is the short window after the release step, when a stop finds no owner.
- Let `vonvon daemon stop` signal the pid from `daemon.pid` when it cannot authenticate, or verify the owner with a pid check alone. A reused pid would make it signal an unrelated process. V3 keeps the listener open in a restricted mode during the drain and stops the verified owner with `stopHost`.
- Add an update generation field to `update-status.json`. It changes a storage shape. Comparing the whole record under the existing `update.lock` gives the same ownership.
- Release the lock after a cleanup error whatever happened to owned children, as `runHostRuntime` does today. A child whose exit was never observed might still write the data root while a new owner starts.
- Let a provider's `close` reject at its SIGKILL deadline and add a separate death-confirmation call. Every layer that caches or drops the early rejection would then need the second call, and issue #50 shows three such layers. A `close` that stays pending until death keeps one contract, and caching it stays safe.
- Prove the target of every group signal in V3 with an OS generation handle for each descendant. Node exposes no such handle, and adding one would bring a native mechanism into V3. V3 keeps numeric group targeting as best effort, guarantees only the `ESRCH` latch, and states the limit under *Signals*.
- Track providers only through the orchestrator's `sessions`. Reaped, evicted, adopt-failed, goal, title, utility, and warm-pool processes are not in it. A per-process registry in `owned-process.ts` sees every birth.
- SIGKILL a Bot child after its grace, whatever it reports. Its provider groups are detached, so they would outlive it, and the supervisor would release with them unobserved.
- Treat any `release()` rejection as owned work, or as a reason to retry. The listener belongs to the daemon's own process, so process exit ends it. Waiting would hold the lock forever over a socket error.
- Keep backend install pairs concurrent and uninstall direct, as V2 did. Concurrent npm runs on one prefix race on `package.json`, `package-lock.json`, and `node_modules`.
- Defer the log follower bound. The fix is local to a V3 file, changes no shape, and matches the backend-install bound.
- Keep the bridge's `KeepAlive true` and `Restart=always` in V5, and stop a service-managed daemon through the manager. A manager stop has a timeout that ends in `SIGKILL`, which cuts the unlimited drain, and an always-relaunch policy restarts a daemon the user just stopped. V5 instead relaunches only on failure, maps stop to exit 0 and restart to exit 75, and stops only through `stopHost`.
- Use V3's `__restart-after-exit` helper for every managed restart, or none. A plain restart needs no helper, because exit 75 lets the manager relaunch. A core update needs the helper, because it alone holds the exact `restarting` record. Letting the replacement daemon mark whatever `restarting` record it finds would break V3's stale-record rule. So only a managed core update spawns the helper. On Linux it runs under `systemd-run --user --scope`, and the daemon commits only after Gate L's readiness proof.
- Inhibit the manager during uninstall, or check for a pid and then `bootout`. A recheck cannot close the gap between the check and the use. Withdrawing the definition first, and having every launched process check it before the lock, means a relaunch exits 0 without work. This needs no manager-specific inhibition command and no new file.
- Have the Linux helper report readiness over an inherited pipe or a new file. A pipe needs `systemd-run` to keep extra file descriptors across its `execvpe`, and the provided `run.c` does not show what its main wrapper does to them. A file adds a storage shape. Reading the owned pid's cgroup and command line needs neither.
- Bootstrap the previous plist again on a macOS install rollback. `RunAtLoad` would start a daemon the user had left stopped. Leaving it unloaded matches uninstall's rollback, and `vonvon daemon start` recovers it.
- Pass the identical reinstall on the file alone. A leftover file from a failed load would report installed with no loaded service.
- Copy Paseo's provider closure for Claude, ACP, OpenCode, and Pi, the V6 and V7 of 2026-10-11. About 40,000 lines Vonvon would own but did not write, a type-edit ledger to compile them under the daemon's strict settings, Paseo's merged ACP outcomes as the floor, and no place to enforce the read scope. Replaced on 2026-10-12 by `providers.md`, about 7,000 new lines with every capability native.
- Keep `AgentBackend` and add capability fields. The optional shape is the problem; consumers read `capabilities?.x ?? true` and a new field would be optional too.
- A Vonvon-owned OS sandbox launcher around Pi, Grok, and Cursor. It would turn their refusals into enforced cells and is the largest single extension. Recorded as future work in `providers.md`.
- Emulate a missing capability, such as goal as a prompt loop. The user excluded emulation, so a cell is native or absent. A slash command the agent declares, such as Claude's `/compact` in `supportedCommands()`, counts as native.
- Port the bridge's Windows relauncher, with its scheduled task, `relaunch.json`, and `taskkill /T /F` after a grace period. V5 never kills a daemon, so the relauncher's only remaining job is relaunching, and a `.cmd` loop gated on the Run value does that without a second registration.
- Record the service registration in a new file under `VONVON_HOME`. That adds a storage shape. The definition already carries `VONVON_HOME` and is the one record the manager acts on.
- Open URLs from the daemon for V4's open actions. After V11 a remote client would open a window on the daemon's machine. The browser already holds every URL and opens it in the click handler.
- Implement `chooseExecutable` and `saveExecutable` in the daemon with a server-side file browser. The protocol's token flow exists only to carry an Electron dialog's result. The existing host `settings save` of `execution.codexBin`, with a daemon-side check, covers it without a new picker.
- Answer provider permission requests by asking in Feishu. It needs a new card, routing, and wire shapes, and the user excluded approval cards. The daemon answers every request from the enforcement plan at once, per `providers.md` *Auto-answered requests*.

## Appendix C. Risks

- V2, V6a to V7c, V8, and V9 need an isolated Feishu fixture from existing bridge data. Prefer a saved inactive Bot and a private group with only the operator and that Bot. Verify credentials and run Bot-connected lanes serially. Preserve the original data and both active Bot connections. Never connect concurrent baseline and daemon clients to the same Bot.
- Ten parallel lanes that each start a daemon, Chromium, or Electron may exhaust the Mac's memory. Run lanes in waves when `vm_stat` shows free pages running low. V5 lanes run one at a time because they share the login item.
- Remote access trusts the cloud to hand out the right daemon key. V11 lane 9 checks a swapped key fails, and a fingerprint check in the local UI is a follow-up.
- A desktop-bundled daemon and an npm-installed daemon may differ in version. V5 lane 8 watches it.
- Enforcement cells ship as `refuse` until their live probe runs. On a fresh host most `qa` and `write` combinations refuse until V6d and V7c land their proofs, and Cursor and Grok live lanes need user-supplied accounts. The cost is a one-tap setting change; the alternative is a tier that is promised and not kept. If `claude.sandbox.allowread-override` or `claude.hook-under-lock` fails, the design goes back to Claude Code per `providers.md` *Open questions*.
- Cursor's `cursor/task`, `cursor/update_todos`, and `cursor/generate_image` payloads are undocumented. V7a writes the dialect against the probe recording, and those cells stay `none` until it exists.
- Gate L's readiness proof reads `/proc/<pid>/cgroup` and `/proc/<pid>/cmdline`, and it assumes the unified (`0::`) cgroup line, as on a systemd v255 host. It also assumes that stopping or restarting `vonvon-bot.service` does not reach a separate transient scope. A host without that line never becomes ready, and its managed core update ends as `helper_lost` with a stop. Native acceptance on the Linux test user must show the helper surviving the unit's exit 75. Gate M's rollback leaves the previous job unloaded until `vonvon daemon start` or the next login, and native acceptance must show that state and its recovery. The macOS detached-helper premise has documentary support in `launchd.plist(5)` (`AbandonProcessGroup`), and still needs native acceptance.
- Uninstall assumes the manager's pid query is authoritative. A failed query fails closed and never counts as "no pid". Native acceptance must verify the query.
- V5's native service acceptance, V5 lane 6, and V8 lane 1 also need Linux for the systemd path. `systemctl --user` needs a user session, which hosted CI does not provide and never substitutes for. V5's acceptance and V8 lane 1 also need a dedicated OS test user on the Mac and on Linux, because the bridge service that V8 lane 1 installs uses the same label as the original bridge. The user's override of 2026-10-11 authorizes `clay` for V5 and V8. V5's macOS service tests may use owned data and labels there with the bridge's pid, start time, and listeners preserved. V8's lanes run as `test-user` in `gui/502` and as `accept-user` on Linux, never in `clay`, because import reaches the bridge service of the calling user. This is not a missing permission. Linux runs on the Tencent host under the user's root SSH grant, per [native-acceptance-hosts.md](native-acceptance-hosts.md). A read-only refresh on 2026-10-12 recorded systemd 255 and a unified `cgroup2fs` hierarchy there, which matches Gate L's assumption. Record B0 records them again before each run, and a different version or mode stops the run. If a native step fails only on that host, Codex may rerun the whole box on the fallback VM and report both. A box is checked only when every step held on one host. An earlier environment report found neither: only the operator's Mac GUI session was available, and no Linux systemd user session was running. The current preflight and requests are under V5's *Native acceptance environment*. Recheck current availability read-only before requesting user action; `ci-user` stays reserved for CI. If the operator has to provide them, only the native box waits for that. The Windows Run-key path stays unverified until a Windows host exists.
- V3's stop has a short window after the release step of a restart, when no process answers for the data root. A stop in that window reports `already stopped`, and the replacement still starts. Running `vonvon daemon stop` again stops it.
- The cloud deploy target is undecided. V10 runs against a local Postgres until the operator picks one.

## Appendix D. Links and reading list

- `docs/architecture.md` and `docs/roadmap.md` in this folder.
- Paseo `docs/architecture.md`, `docs/providers.md`, `docs/hub.md`, `docs/permissions.md`, `docs/data-model.md`, and `SECURITY.md` in `getpaseo/paseo` at `0009a7e71`.
- feishu-codex-bridge `src/agent/types.ts`, `src/config/`, and `src/service/` at `446b2a4`.
- vonvon-bridge-legacy `packages/runtime/src/cli-migration-*.ts`, `legacy-cli-control.ts`, and `docs/adr/`.
- vonvon-platform `src/oauth.ts`.
- `docs/providers.md` in this folder, and the native capability audit `native-capabilities.md` of 2026-10-12 that it cites.
- V3, V6b, and V11 get `skills/how/SKILL.md` before code and `skills/interrogate/SKILL.md` before merge-ready.
- Each owner keeps a decision trail per `skills/show-me-your-work/SKILL.md`, uncommitted, returned in its report.
