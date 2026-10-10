# Vonvon Bot v2 plan

Vonvon Bot becomes an independent product with a per-machine daemon, a web UI and an Electron desktop shell as clients, and an optional Vonvon account that lists every machine for remote management. It stops vendoring feishu-codex-bridge, imports a bridge user's data, and then shuts the bridge service down. The rule the program enforces is that the daemon is the only writer of machine data and the cloud never stores settings. The design and its reasons live in `docs/architecture.md` and `docs/roadmap.md` next to this file in `modelzen/vonvon-bot`. The PRs in order are V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. Codex on the operator's Mac runs it. Read `skills/poteto-mode/references/codex-tools.md` for the Codex equivalent of each Claude tool, model, and skill this plan names. The repository's `AGENTS.md` overrides one step of the playbook. Nobody force-pushes or rebases a pushed branch. A child syncs its parent by merging the parent branch in, and a child whose parent landed retargets to `main` and merges `main` in. Codex owns all code, every check in this plan, packaging, and guarded Shipping after verification. Claude Code on the Linux server normally owns this plan and the design docs, and writes no product code. When the plan is wrong or incomplete, Codex says so in the PR. Codex decides a small deviation that leaves the design intact and records why in the PR. A later change to the architecture, a data shape, or the PR order goes back to Claude Code, which updates the docs on a `claude/` branch before Codex continues.

On 2026-10-10 the Claude Code CLI returned HTTP 401 during the docs-only V2 clarification. The operator explicitly authorized Codex to apply that clarification and continue. The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review or a manual merge click. This exception does not waive the screenshots, video, or CLI evidence bundle that a PR prescribes under *Interaction evidence*, unit tests, all ten live lanes, perf checks, independent audits, or the exact-head Shipping verdict. It does not authorize force-push, rebase of pushed branches, or an hourly audit.

Pin every reference source to the commit below. Clone the ones the Mac does not have.

| Source | Repository | Commit |
| --- | --- | --- |
| Bot runtime | `modelzen/feishu-codex-bridge` | `446b2a4` on `codex/device-handoff` |
| Current UI and zod contracts | `modelzen/vonvon-bot` | `fab5237` on `codex/device-handoff` |
| Providers, pid lock, relay crypto | `getpaseo/paseo` | `0009a7e71` |
| Import and old-service control | `modelzen/vonvon-bridge-legacy` | `3a16853` |
| Feishu and Lark login | `modelzen/vonvon-platform` | `3427634` |

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] On the operator's go, record in standing orders and the todolist that V1 to V11 follow roadmap order. Tests alone do not verify a PR. Codex merges only after unit, all live, perf, independent audit, and exact-head Shipping checks pass. No force-push or rebase of pushed branches. The program ends when V11 is verified and earlier PRs have landed or been parked with a reason.
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `run` (the bundled Claude Code skill) until V4 lands, then `.agents/skills/verify/SKILL.md` in the repository
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/how/SKILL.md`, `skills/interrogate/SKILL.md`, `skills/show-me-your-work/SKILL.md`, `skills/create-verification-skill/SKILL.md`
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owners use branch prefix `codex/`.
- [ ] Follow the dependency table in *Dependencies* under *Parallel execution*. It separates where a branch starts from what its acceptance needs and when it merges. Merges stay in roadmap order, V1 to V11. A branch never rebases. It merges its parent branch in when the parent moves, and merges `main` in after its parent lands.
  - [ ] V1 and V2 are merged. Nothing in this graph rebases, retargets, or reopens them, and open PRs keep their branches.
  - [ ] V9 lives in `modelzen/feishu-codex-bridge`, branched from `origin/codex/device-handoff`.
- [ ] Hold the file boundaries. V1 touches only the root config, `packages/protocol/**`, `.github/**`, `NOTICE`, and `README.md`. V2 and V3 touch only `packages/daemon/**`, `scripts/import-core.mjs`, `packages/protocol/**`, and necessary root package metadata or lockfile changes for workspace integration. V3 also creates the minimal local client in `packages/client/**` that its lanes drive. V4 extends `packages/client/**` and adds `packages/ui/**`, `.agents/skills/verify/**`, `packages/daemon/src/server/web-ui.ts`, and `packages/daemon/src/cli/commands/open.ts`, and edits `packages/daemon/src/server/http.ts` only to mount `web-ui.ts`. V4 also edits `packages/daemon/src/server/rpc/command.ts`, `environment.ts`, `machine.ts`, and `settings.ts` only for the branches its *Browser coverage* assigns to the daemon. It creates `packages/daemon/src/environment/**` and the three daemon tests that V4's Files names. V5 touches `packages/desktop/**` and, for its *Service gate*, the daemon's service files `packages/daemon/src/service/launchd.ts`, `systemd.ts`, `win-startup.ts`, `adapter.ts`, and `common.ts` and `packages/daemon/src/cli/commands/service.ts`. The gate also creates `service/identity.ts` and `service/registration.ts`. It edits `packages/daemon/src/host/service.ts`, `host/lifecycle.ts`, `cli/commands/daemon.ts`, and `cli/commands/run.ts`, each only for the change that *Daemon files* in V5 names, and it creates the test files that section names. V5 never edits `service/control.ts`, which V8 uses, `service/codex-bin.ts`, `service/update.ts`, or `cli/commands/daemon-control.ts`. V6 and V7 touch only `packages/daemon/src/agent/**`, provider entries in `packages/protocol/**`, the provider picker in `packages/ui/**`, and `NOTICE`. They also own their test files under `packages/daemon/test/`, which V6's and V7's sections name. V8 touches only `packages/daemon/src/import/**`, `packages/daemon/src/cli/commands/import.ts`, `packages/protocol/src/import.ts`, and `packages/ui/src/import/**`. V10 and V11 add `packages/cloud/**` and `packages/daemon/src/cloud/**`. V10 also adds `packages/ui/src/account/**` and `cli/commands/login.ts`, and V11 also adds `packages/client/src/transport-relay.ts`, `packages/client/src/e2ee/**`, and the machine switcher in `packages/ui/src/`. Each PR's edits to the shared integration files under *Shared files* go through the root.
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

This section says how Codex runs work in parallel and where each branch starts. It changes no merge order, architecture, wire or storage shape, or evidence gate. The local runtime supports the root plus three active Codex agents.

*Roles.*

- The root is the only Git and forge writer. It creates every branch and worktree, integrates worker patches, commits, pushes, opens, dispatches CI, merges, and runs guarded Shipping.
- A worker gets one root-created worktree at the integration base and an explicit list of files it owns. It edits only those files and runs `npm ci` in its own worktree. It never commits, pushes, rebases, stashes, or touches a forge. It returns its uncommitted diff and its test transcripts to the root. Nobody copies `node_modules`, `dist`, `build`, or `release` between worktrees.
- Two workers never own the same file. If one worker needs a change in another worker's file, that change becomes a handoff point, which the root writes and freezes before the workers start.

*Runtime isolation.*

- Each concurrent unit run, probe, or proof uses its own `VONVON_HOME`, with port 0 or a port it has just found free. No two concurrent runs share a data root, a Bot, a fixed port, or a service identity.
- Lanes that connect the fixture Bot stay serial, per the V2 fixture rules. In V3 those are lanes 1, 5, 6, 8, and 10 and the connected perf probe.
- Native service acceptance, from V5 on, stays serial, because one test user has one service identity.
- Perf probes run with no other lane, proof, or build active on the Mac, so the timings measure the change.
- Audit lanes only read, so they can run beside anything.

*Validation order, for every PR.* The expensive gates run once, on a frozen head.

1. Interface freeze. The root commits the handoff stubs and shared fakes that the partitions need.
2. Test-first components. Each worker first writes its unit tests, then makes them pass, then runs its targeted tests and lint and typecheck. A worker may rehearse a live proof on its own build. That run is rehearsal, not evidence.
3. Integration. The root merges the partitions in the stated order and runs targeted tests after each one. It then runs the clean chain once: `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`.
4. Review before freeze. At least two independent audit lanes read the integrated diff and the component evidence. Findings go back to the owning worker, and the root repeats steps 3 and 4.
5. Freeze. The root pushes the head. The CI results under *CI policy*, the ten live lanes, the lifecycle proofs, perf, native checks where the PR names them, the interaction evidence, and the exact-head swarm and Shipping verdict all run on that head. Any patch change makes a new head, which needs a fresh swarm, except for results that stay valid under the patch-id rule together with the context check in *After V3*.

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
- Merge order. V1 to V11 in roadmap order, unchanged. A verified PR waits until every earlier PR has merged.

Freeze points. A freeze point is a pushed commit at which the named interface is fixed. It is an interface commitment, not a verdict. The root records its SHA. If the interface changes after it, the owner tells the root, and every branch that started from it merges the new commit in.

- `H3`. The V3 head after the root merges the current `main`, with this plan, into the V3 branch. The root read the V3 product head as `8c0adb4` before that merge, and records `H3` when it creates the branches below. V3 is code-complete. If its Shipping finds a defect, the repair makes a new V3 head, and every branch started from `H3` merges it in.
- `F4`. The V4 commit that fixes four things: the `packages/client` exports for browser and Electron preload use, added beside the Node-only `connectLocal` without changing any RPC or event shape; the injected-client API of `packages/ui/src/client-context.tsx`, including the optional shell-capability object from V4's *Shell capabilities*; the build script and output path `packages/ui/dist`; and one UI feature registration file, where a later feature adds one entry.
- `F6`. The V6 commit with the full `agent/paseo/agent-sdk-types.ts`, copied whole with only its specifiers changed and every type it imports resolved inside the closure, and with `session-backend.ts` in place, typecheck clean, and `session-backend.test.ts` passing. V7 consumes the whole `AgentClient` and `AgentSession` contract, so `F6` never freezes a subset of it.
- `F10`. The V10 commit with the device enrollment, device credential, and outbound link interfaces in `packages/daemon/src/cloud/` and `packages/cloud/src/devices.ts`, and `devices.test.ts` passing.

| PR | Branch | Development baseline | Waits for, per part | Acceptance inputs | Merges after |
| --- | --- | --- | --- | --- | --- |
| V4 | `codex/v4-web-ui` | `H3` | Nothing | A running daemon at V4 head, the old renderer at `fab5237`, Playwright Chromium | V3 |
| V5 | `codex/v5-desktop` | V4 branch at `F4` | The shell files need `F4`. The *Service gate* design is written, so the service files and `login-item.ts` need nothing more | Real `packages/ui/dist` in a real Electron window, an older daemon build, the dedicated Mac test user with a GUI session, a dedicated Linux user with a systemd user session | V4 |
| V6 | `codex/v6-claude-provider` | `H3` | Nothing | The Feishu fixture Bot, the real Claude Code CLI, V3 head for lane 1 and perf | V5 |
| V7 | `codex/v7-providers` | V6 branch at `F6` | The provider IDs and the picker need V4 merged and the root's provider-ID handoff | V4's web UI for lane 7, the installed providers, the Feishu fixture Bot | V6 |
| V8 | `codex/v8-bridge-import` | `H3`, or `main` once V3 has merged | `packages/ui/src/import/**` needs `F4` | Bridge `446b2a4` installed as a service under the dedicated test user on the Mac and on Linux, the Feishu fixture Bot, V4's web UI | V7 |
| V9 | `codex/v9-owner-notice` in `modelzen/feishu-codex-bridge` | `origin/codex/device-handoff` | Nothing. The marker name `migrated-to-vonvon-bot.json` is fixed in `architecture.md` | The signed installer URL published from V5's release, V8 merged | V8 |
| V10 | `codex/v10-accounts` | `H3`, or `main` once V3 has merged | `packages/ui/src/account/**` needs `F4` | Two daemons, a local cloud with Postgres and dev auth, the V5 shell for lane 8 | V9 |
| V11 | `codex/v11-relay` | `main` | `packages/client/src/e2ee/**` and its test need nothing. Everything else needs `F10`, and `transport-relay.ts` and the switcher need `F4` | V10's cloud, the V5 shell for lane 7 | V10 |

A branch whose development baseline is not its merge predecessor merges each predecessor in when it needs that code, and `main` once it lands. It opens its PR ready at code-ready against the newest unmerged branch it contains, or `main`, and retargets as those land, as *Spawn owners* says.

Evidence-grade gates follow the merge order. A PR runs its frozen-head live lanes, perf, native checks, and swarm when it is the earliest unmerged PR or the next one. Earlier gates would mostly be rerun after the earlier merges change its base or lockfile. Its unit tests, typecheck, lint, rehearsals, and audits of its own diff may run at any time.

*Shared files.* After V3 the root owns these and writes every change to them as a frozen handoff or at integration. Owners own the leaf files they add.

- `packages/protocol/src/index.ts`, `domain.ts`, `rpc.ts`, `events.ts`, and `handshake.ts`. V7's provider IDs go into `domain.ts`, whose `toolSchema` allows only `codex` and `claude` today. V8's owner writes `import.ts`, and the root adds its export and request-group registration. No existing shape changes. A change to an existing shape goes back to Claude Code.
- `packages/daemon/src/cli/index.ts`. One registration line per command: V4 `open`, V8 `import`, V10 `login` and `logout`. V5 needs none, because `service` stays registered from V3. Owners own `cli/commands/<name>.ts`.
- The root `package.json` and `package-lock.json`. V5 returns the desktop package's dependencies. V6 returns `@anthropic-ai/claude-agent-sdk` at exactly `0.3.246`, moved from `devDependencies` to `dependencies` of `packages/daemon`, plus every external package its closure imports, at Paseo's range. A worker returns the dependencies it adds. The root applies them and regenerates the lockfile with `npm install` after each integration or merge that touches it, never by hand. A lockfile change is a context change under the patch-id rule.
- `NOTICE`. Each PR appends its section, and the root resolves the merge.
- The UI feature registration file from `F4`. The root adds one entry each for V8's import flow, V10's account pages, and V11's machine switcher. After `F4`, the client owner implements those feature directories or explicitly hands off the disjoint `ui/src/import/**` or `ui/src/account/**` directory; `client-context.tsx` and the registration file stay reserved.
- `packages/daemon/src/server/http.ts`, after V4's `web-ui.ts` mount, and `server/snapshot.ts`. V3's tools probe reads the `claude-agent` backend. When V6 deletes `claude-agent/`, the root checks the `createBackend('claude-agent')` lookup at integration and updates it only if the registered backend ID changes; the `tools` rows keep their meaning.
- `packages/daemon/src/agent/index.ts` and `agent/catalog.ts`. The registry comment calls `catalog.ts` authoritative and its test expects matching IDs. As the explicit exception to root-written shared files, the providers owner keeps both through V6 and V7 and root integrates their changes, so no two branches edit them at once.

*Owners.* Three long-lived owners keep one module area each, so later milestones reuse what they learned. Each may split a milestone into worker partitions only along disjoint files, with root integration and the same validation order.

- Client surfaces: `packages/client/**`, `packages/ui/**`, `packages/desktop/**`, and `server/web-ui.ts`. V4, then V5, then V11's client transport and switcher.
- Providers: `packages/daemon/src/agent/**`. V6, then V7. After V7, V9 in the bridge repository.
- Machine platform: V3's frozen-head gates first, then `packages/daemon/src/import/**` for V8, then `packages/cloud/**` and `packages/daemon/src/cloud/**` for V10 and V11.

*Slots.* The root plus three agents.

- The earliest unmerged PR gets gate and audit capacity first. Its two or more audit lanes come from agents that did not write it. An owner pauses its implementation for such an audit, which only reads.
- Implementation fills the other slots.
- A slot moves from gates or audits to implementation when the PR it served has no work left that needs an agent, so every swarm lane has returned and only root items remain: CI, Shipping, and merge. It moves back when the earliest or next unmerged PR freezes.
- While a perf probe runs, no other slot builds, tests, or runs a daemon on the Mac. Those slots may edit and read.
- Bot-connected lanes are serial across the whole program, not only within a PR: one connection to the fixture Bot at a time, from any PR. Native service acceptance is serial too.

*Wave 1.* Starts when the root has merged this plan and recorded `H3`.

- Root. Merges `main` into the V3 branch to make `H3`, gets the full CI results under *CI policy*, decides which V3 checks the new base requires under the context rule below, integrates, and runs Shipping. Creates `codex/v4-web-ui` and `codex/v6-claude-provider` in their own worktrees at `H3`. Checks the currently available dedicated Mac test user and Linux systemd user session read-only, then asks the operator once only for missing capabilities that V5 and V8 need, and records the result. The `github-ci` account remains reserved for CI and is never used for service acceptance. The answer is not on the path of V4 or V6.
- Agent 1, machine platform. V3's frozen-head gates at `H3`: the reruns that the root names and the CLI evidence bundle. It does not audit its own bundle.
- Agent 2, client surfaces. V4 from `H3`, client exports and `client-context.tsx` first, to reach `F4` early. Then the UI port, `web-ui.ts`, `open.ts`, and the `verify` skill.
- Agent 3, providers. V6 from `H3`, to `F6` first, then the rest of V6.
- Agents 2 and 3 take V3's independent audit lanes and the bundle's independent check, one each, and pause their own work only for that.
- Claude Code, outside the slots, writes V5's *Service gate* design on a `claude/` branch. It is written on `claude/v5-service-design`, together with V4's *Browser coverage* and V6's import closure and permission mapping.

*Wave 2.* Starts when V3 has merged, which frees agent 1.

- Root. Merges `main` into the V4 and V6 branches and retargets them to `main`. Freezes the protocol registration for V8's `import.ts`.
- Agent 1, machine platform. V8's daemon side from `main`: `import/bridge/**`, `service-control/**`, `legacy-keystore.ts`, `hooks.ts`, `cli/commands/import.ts`, `protocol/src/import.ts`, and `import-bridge.test.ts`. The UI import flow waits for `F4`. When V4 is code-ready, it gives V4 one audit lane.
- Agent 2, client surfaces. V4 to code-ready and its evidence-grade gates, since V4 is now the earliest unmerged PR. Agents 1 and 3 run V4's audits and help with its lanes. After V4 is verified, V5's shell from `F4`.
- Agent 3, providers. V6 to code-ready, with unit tests and rehearsals. Its evidence-grade gates wait until V6 is the earliest or next unmerged PR. Then V7's provider code from `F6` on `codex/v7-providers`.
- The next free slot takes V10 from `main`, then V9 in the bridge repository. V11's `e2ee/**` port is filler for any free slot.

*Critical path.* Merges are linear, so the program ends when the slowest chain of merge inputs ends: V4, then V5, which needs the dedicated Mac test user's GUI session, a dedicated Linux user with a systemd user session, and signing, then the published installer for V9, then V10 and V11. Code for V6, V7, V8, V10, and V11 can be ready before its turn. What stays serial per PR is its frozen-head evidence and Shipping.

*After V3.*

- A verified PR waits until every earlier PR in this repository has merged. When an earlier merge moves its base, the root merges `main` in. An unchanged stable patch-id is necessary for the verdict to stand, but it is not sufficient. The root also confirms the new base, the dependency versions in the lockfile, and that the evidence relevant to the PR still applies in the new context. If that context changed, the root reruns the affected checks and gets a fresh independent verdict, even when the patch-id matches. If the patch-id changed, the PR gets a fresh swarm. All of this applies on top of `playbooks/shipping.md`, never in place of it. Disjoint file ownership keeps patch-ids stable, but it does not keep context unchanged.
- Known overlaps.
  - V8 and V10 both add commands, and the root writes each registration in `packages/daemon/src/cli/index.ts` as one additive line under *Shared files*. A merge conflict there changes the patch and needs a fresh swarm.
  - V7 edits the provider picker in `packages/ui/src/`, which exists only after V4. V7's UI part therefore waits until V4 has landed and V7 has merged `main` in.
  - V5 edits the daemon's service files, and V8 uses `service/control.ts` beside them. V5 never edits `control.ts`.
- Operator action for V5 and V8, requested in wave 1 so it stays off the critical path. V5's native acceptance and V8's service lanes need a dedicated OS test user on the Mac and a Linux systemd user session. V5's service design from Claude Code is also a precondition for V5's service files, per *Service gate*.
- V10 and V9. V10 merges only after V9 has landed, following the existing V1 to V11 roadmap order, even though V9 merges in `modelzen/feishu-codex-bridge`. This needs no operator question and changes no PR order.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.
- [ ] Add the line `Mac window check: pending` to the body of every PR that changes what a window or page shows. The Mac agent replaces it with what it saw.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, apply the merge-front scheduling rule under *Dependencies*: component tests and independent diff audits run immediately, and the full evidence-grade swarm runs when the PR is earliest or next unmerged. Run that swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] A clean verdict appends the PR to the linear stack in roadmap order. Codex runs guarded Shipping on the contiguous verified stack from the root, bottom-up. A verdict stays valid across a merge-sync only when the stable patch-id of base to head is unchanged under the patch-id rule in `playbooks/shipping.md`, and the new base, dependency versions, and relevant evidence are confirmed unchanged in effect. If that context changed, the affected checks rerun and a fresh independent verdict is required.
- [ ] Merge only when the GitHub-hosted Linux job succeeded at the exact head being merged, and for a `full` change the hosted Windows job and the self-hosted Mac job succeeded at that head, per *CI policy*. A docs-only run is recorded as lightweight, never as a full-suite pass.

### CI policy

CI maintenance does not change the V1 to V11 order, product architecture, unit, live, perf, native, independent audit, or Shipping requirements. CI does not replace a real desktop, launchd, or systemd acceptance check.

*Runners.* The `linux` job uses GitHub-hosted `ubuntu-latest`. The `windows` job uses GitHub-hosted `windows-2025`. The `macos` job uses the shared organization runner labelled `self-hosted`, `macOS`, `ARM64`, `modelzen-macos`, and `modelzen-macos-isolated`. Full changes run all three platforms. Notelet is a macOS app and keeps Linux repository checks plus its self-hosted Mac build. The original Windows native job remains in the legacy desktop branch workflow; its desktop packaging and native UI checks are separate from this main-workflow chain. The organization runner group permits only `modelzen/vonvon-bot` and `modelzen/notelet`. One Mac runner runs one job at a time. Setup and service commands are in [self-hosted-ci.md](self-hosted-ci.md). Pricing and trigger examples are in [ci-costs.md](ci-costs.md).

*Triggers.* `.github/workflows/ci.yml` runs for PRs targeting `main`, on `opened`, `synchronize`, and `reopened`, and by `workflow_dispatch`. It has no path filter, branch-push trigger, or schedule. PR checks validate the proposed merge; repeating the same suite after that merge adds no platform coverage. Use a manual full run for an exceptional direct commit, a retargeted PR, or a changed base when no current run exists. A newer PR run cancels the old one. Manual runs retain separate records.

*Scope.* `.github/scripts/ci-scope.mjs` is the only classifier. It uses full Git history and `git diff --name-only --no-renames -z`. A PR compares the merge-base of the event base and head with the head. It reports `docs` only when every path is root `README.md`, `AGENTS.md`, `CLAUDE.md`, or `docs/**/*.md`. Everything else is `full`. Manual dispatch, unknown events, missing SHAs, empty, malformed, oversized or ambiguous differences select `full`. Git collection failure cannot authorize a lightweight pass.

*Linux job.* The job first runs the classifier's regression tests and collects the scope with the runner's bundled Node. A `docs` change runs `git diff --check`, without setting up Node, restoring npm cache, installing dependencies, or running product tests. A `full` change sets up Node 22 and npm cache, then runs `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint`, stopping on the first failure. The daemon's former `lint` script repeated `tsc --noEmit`; daemon type checking now runs once through `typecheck`. Protocol lint remains in `npm run lint`.

*Windows job.* After Linux succeeds with `full` scope, `Windows checks` checks out the exact PR head, or the dispatched commit, without persistent Git credentials. It runs the same Node 22 install, build, typecheck, test and lint chain on `windows-2025`, then records the source SHA, runner, Windows, architecture and Node version. Documentation changes skip this job. Windows service and native UI acceptance remains separate.

*Mac job.* The job requires `ENABLE_SELF_HOSTED_MACOS_CI=true` in repository Actions variables. Both repositories now set it to `true`. The shared runner uses the dedicated standard `github-ci` account without release credentials. Its LaunchAgent inherits the logged-in GUI session, and the account cannot traverse the daily user home. After a reboot, log into `github-ci` once and keep that session open in the background, as described in the service guide. Fork PRs are excluded, and the job checks the account before checkout. Linux checks continue independently. After full Linux checks succeed, the self-hosted Mac checks out the exact PR head, or the dispatched commit, and runs the same clean Node 22 chain. It records the source SHA, runner, macOS, architecture and Node version in the job summary. Documentation changes skip this job. A successful self-hosted job supplies the routine Mac check, so the operator does not rerun an identical manual Mac chain. Native, interactive and platform-specific acceptance from each milestone remains separate.

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
  - Limits. If a Bot child or the daemon dies abnormally, from a crash or an operator's SIGKILL, its detached provider groups can remain. V3 does not adopt them, never signals them from a recorded pid, and claims nothing about them. Their stdio pipes close with the dead parent. The Claude backend's CLI child is spawned inside the Claude Agent SDK, which gives the daemon no handle, so V3 does not confirm it. V6 replaces that backend, and its design states how those processes join this rule.
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
  - If the old `openGroup` link, or the old copied text, needs data that no snapshot or reply carries, it is a blocker. Leave only that control gated, write the missing field in the PR, and hand it back to Claude Code. Everything else proceeds.
- Shell-owned, implemented by V5 through *Shell capabilities*. `settings.chooseExecutable` and `saveExecutable`, `machine.service`, `startHost`, `repairCli`, `checkDesktopUpdate`, and `installDesktopUpdate`, plus the old window-only `setLoginItem`, `hideWindow`, `quit`, and `onQuitRequested`. Each one manages the desktop app, its window, or an OS registration. A browser page cannot reach them, and a daemon cannot install, uninstall, or update the app that runs it. These daemon branches stay `unsupported`, and `machine.service` keeps V3's refusal. In the web build each control in the old pane stays visible. It shows the desktop edition note and the CLI equivalent where one exists: `vonvon daemon start` for `startHost`, and from V5 `vonvon service install` and `uninstall` for the service section. The core-update rows (`checkCoreUpdate`, `applyCoreUpdate`, `coreUpdateStatus`) and `stopHost` already work in the web build.

*Executable path.* The old pane's Codex executable row stays. It shows the host settings' effective `codexBin`, whether it comes from the saved value or the default.

- Change opens a path dialog prefilled with the current value. Save sends the existing `settings save` with scope `host`, section `execution`, the section's `revision`, and patch `{codexBin: <path>}`. **Use default** sends `{codexBin: null}`. A `conflict` reply reloads the section, as the other settings sections do.
- When the shell capability `chooseExecutablePath` exists, Change opens the native file dialog instead and saves the returned path the same way. Without it, the browser uses the path dialog.
- `settings-executable.test.ts` first records what the `H3` host save does with a bad path. If it does not already reject one, V4 adds a check in `server/rpc/settings.ts`. The path must be absolute and resolve through `realpath` to a regular file. On macOS and Linux it must be executable, and on Windows it must end in `.exe` or `.cmd`. A path that fails gets the existing `saved` reply with `rejected` and `fields: [{field: 'codexBin', message}]`, and nothing is written. Every case is tested: missing, relative, a directory, not executable, a symlink to an executable, a valid path, and `null`.
- `chooseExecutable` and `saveExecutable` stay `unsupported`. No client sends them. The old renderer used them only to get an Electron file-dialog token, and the path flow above replaces that token.

*Shell capabilities.* `F4` freezes, in `client-context.tsx`, one optional object that the UI receives beside the `VonvonClient`. It is a UI-local interface, not an RPC, and it changes no protocol shape.

- `openExternal(url)`, `chooseExecutablePath(): Promise<string | null>`, `setLoginItem(enabled)`, `hideWindow()`, `quit()`, `onQuitRequested(listener)`, `service(action)` for `install`, `start`, `stop`, and `uninstall`, `startHost()`, `repairCli()`, `checkDesktopUpdate()`, and `installDesktopUpdate()`.
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

**Depends on.** V4. The shell files start from V4's branch at `F4`. The *Service gate* design below is complete, so the service files and `login-item.ts` may start from the same base. Acceptance needs the real `packages/ui/dist`, the dedicated test users, and a Linux systemd user session, per *Native acceptance environment*. V5 merges after V4.

**Files.**

- [ ] Create `packages/desktop/src/main.ts`, `daemon-manager.ts`, `tray.ts`, `updates.ts`, and `preload.ts`.
- [ ] Create `packages/desktop/electron-builder.yml`.
- [ ] Create `packages/desktop/src/login-item.ts`, which runs `vonvon service install` and `uninstall` per *Service gate*.
- [ ] Create and edit the daemon files that *Daemon files* names, and no others.

*Service gate.* V3 refuses `vonvon service install` and `uninstall`, and its service adapters still carry the bridge identity. V5 is the first PR that installs a Vonvon service. This design settles every point the gate requires. V3's drain, ownership, cleanup, and stop-wins rules carry over unchanged. Nothing here changes a protocol or wire shape, the pid lock, `status --json`, `update-status.json`, or any existing file under `VONVON_HOME`.

- Identity. All Vonvon names live in the new `service/identity.ts`. The adapters import their names only from it, and never import `service/control.ts`.
  - macOS. A launchd agent with label `com.vonvon.bot.daemon` and plist `~/Library/LaunchAgents/com.vonvon.bot.daemon.plist`, in the `gui/<uid>` domain.
  - Linux. A systemd user unit `vonvon-bot.service` at `${XDG_CONFIG_HOME:-~/.config}/systemd/user/vonvon-bot.service`.
  - Windows. The value `Vonvon Bot` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Its launcher files are `vonvon-bot.vbs` and `vonvon-bot.cmd` in `VONVON_HOME\service\`. V5 creates no scheduled task, and it does not use `relaunch.json` or `__win-relaunch`.
  - No install, status, start, stop, or uninstall reads or writes a bridge label, unit, plist, unit file, Run value, scheduled task, or bridge file. V3's `__win-relaunch` and `__daemon-control` keep refusing as V3 defines them.
- One registration per OS user. The names above are fixed, so each OS user has at most one Vonvon registration, for one data root.
- Data-root ownership.
  - The definition records its data root. The plist's `EnvironmentVariables`, the unit's `Environment=`, and the `.cmd` each set `VONVON_HOME` to the `realpath` of the data root at install, and set `VONVON_SERVICE` to `launchd`, `systemd`, or `windows`. The definition is the only record, and V5 adds no new state file.
  - `service/registration.ts` reads the definition back through the identity. It reports one of four states: `absent`, `ours` (same `realpath` data root), `other-root` (a different one), and `unrecognized` (the file exists but does not parse as a Vonvon definition).
  - Every service command and every launch decision for a data root goes through that check. `other-root` and `unrecognized` refuse every change, and V5 never overwrites or removes either one. The refusal names the recorded root, or the unparsed file. A data root without its own registration runs self-hosted, exactly as V3 does.
- The definition.
  - Program: the Node executable and CLI entry of the distribution that ran `install`, with `daemon run --port <P>`. The npm install uses its `node` and `bin/vonvon.mjs`. The desktop app uses its Electron binary with `ELECTRON_RUN_AS_NODE=1` and its bundled entry. Install refuses the `development` and `unknown` distributions that `service/distribution.ts` reports.
  - Port `P` is fixed at install. It is the running daemon's port if one runs, or else `--port` if given, or else a free port chosen at install. A later launch never uses another port.
  - Environment: `VONVON_HOME`, `VONVON_SERVICE`, and the `PATH` captured at install. V5 drops V3's `CODEX_BIN` passthrough, because the daemon already reads `codexBin` from the host settings.
  - Logs: `service.log` and `service.err.log` in `VONVON_HOME`, as `common.ts` already names them.
  - launchd: `RunAtLoad` true, `KeepAlive` set to `{SuccessfulExit: false}`, and `ThrottleInterval` 5. It sets no `ExitTimeOut`, because `launchd.plist` documents 0 as infinite and says not to use it.
  - systemd: `Type=simple`, `Restart=on-failure`, `RestartSec=5`, `TimeoutStopSec=infinity`, and `WantedBy=default.target`.
  - Windows: the Run value runs `wscript.exe //B <vbs>`, which starts the `.cmd` hidden. The `.cmd` runs the daemon in a loop. Exit 0 ends the loop. On any other exit, it first checks that the `Vonvon Bot` Run value still exists and ends the loop if not. Otherwise it waits 5 s, by a method that works without a console such as `ping -n 6 127.0.0.1 >nul`, and runs the daemon again.
- Exit codes. These are why the managers above relaunch only what they should. A daemon that the manager launched, where `VONVON_SERVICE` is set and the registration is `ours`, ends with one of three codes.
  - 0 after a completed stop. Any `owned_work_unconfirmed`, `ApiCleanupError`, or `listener_close_unconfirmed` that V3 reports is still logged and returned to the stopping caller, but the code stays 0, so no manager relaunches over a stop.
  - 0 when it finds the data root's lock held by another live owner. This happens when the manager starts it next to a running self-hosted daemon. It exits before it touches anything.
  - 75 after a completed restart whose intent survived to the release step. If V3 would not launch a replacement after a cleanup error, it exits 0 instead.
  - Any other code, or a signal, is a failure, and launchd and systemd relaunch it after 5 s. The Windows `.cmd` loop does the same.
- One launcher per data root. When the registration is `ours`, the OS manager, or the Windows `.cmd` loop, is the only launcher.
  - `vonvon daemon start` attaches to a running daemon and keeps V3's port-mismatch refusal. If none runs, it starts the manager's job and waits for readiness on port `P`, up to the same 25 s as V3. It runs `launchctl kickstart gui/<uid>/com.vonvon.bot.daemon` (no `-k`), bootstrapping the plist first if `launchctl print` does not find the job. On Linux it runs `systemctl --user start vonvon-bot.service`. On Windows it runs the registered `wscript.exe //B <vbs>`, detached. If that fails, it reports the manager's output and exits 1. It never falls back to a detached `daemon run`. `--port` other than `P` refuses with V3's mismatch message.
  - A foreground `vonvon daemon run` without `VONVON_SERVICE` refuses while the registration is `ours`, and points to `vonvon daemon start` and `vonvon service uninstall`. A supervisor's Bot child (`daemon run --bot`) is exempt, as V3 defines it.
  - The desktop `daemon-manager.ts` attaches the same way, and when no daemon runs it calls `vonvon daemon start`. It spawns the bundled daemon itself only when there is no `ours` registration.
  - A self-hosted daemon that was already running when `install` ran keeps running. Its next launch goes through the manager. Its V3 restart helper runs `daemon start --port P`, which now goes through the manager.
- Stop. `vonvon daemon stop` is V3's `runStop` unchanged: `stopHost` through the verified owner, then a wait with no deadline. The daemon exits 0 after its drain, so no manager relaunches it. The registration stays. Vonvon never stops a live daemon with `launchctl bootout`, `kill`, or `kickstart -k`, with `systemctl stop`, `restart`, or `kill`, or with `taskkill`. No manager stop timeout can therefore cut a drain. A logout or OS shutdown is outside Vonvon and treats a service-managed daemon the same as a self-hosted one.
- Restart, same port. `restartHost`, and `applyCoreUpdate` after its install, keep V3's drain and stop-wins rules. A manager-launched daemon does not spawn V3's `__restart-after-exit` helper. Once the release step completes, it exits 75, and launchd, systemd, or the `.cmd` loop starts the same definition on port `P`. Under systemd this also matters because the unit's cgroup is killed when its main process exits, so a helper would not outlive the daemon. A stop that arrives before the release step wins, and the daemon exits 0. A self-hosted daemon keeps V3's helper.
- Crash. A crash or failure exit relaunches after 5 s on port `P`, through the policy above. The new process takes the stale lock under V3's rules.
- Install transaction. `vonvon service install [--port <P>]`.
  1. Preflight, which writes nothing. The platform's manager must be usable: `launchctl print gui/<uid>` succeeds, or `systemctl --user is-system-running` reports `running` or `degraded`, or on Windows `reg query` on the Run key succeeds. The registration must be `absent` or `ours`, and the distribution must be eligible. If the registration is `ours` and the definition it would write is byte-identical, install reports `already installed` and exits 0. If the registration is `ours` with a different definition, and a manager-launched daemon runs, install refuses and asks for `vonvon daemon stop` first.
  2. Write the definition to a temporary file in the target directory, `fsync` it, and rename it into place. On Windows, write both launcher files this way before setting the Run value. On an update, keep the previous definition until step 4 passes.
  3. Load. On macOS, run `launchctl bootout` only when `launchctl print` shows the job loaded and with no pid, then run `bootstrap gui/<uid> <plist>`. On Linux, run `systemctl --user daemon-reload` and `enable --now`. On Windows, set the Run value and, if no daemon runs, start it as `daemon start` does. A job launched next to a running self-hosted daemon exits 0, per *Exit codes*.
  4. Verify. The manager reports the job loaded or enabled, and a daemon owns the data root's lock on port `P`. If none ran before, wait up to 25 s for one.
  5. If step 2, 3, or 4 fails, roll back what this transaction wrote, in reverse order, and restore the previous definition on an update. A daemon this transaction launched is stopped through `stopHost` and awaited with no deadline before unloading. Nothing is signaled.
  - Results. `installed` exits 0. `install_refused` means the preflight refused, nothing was written, and the exit is 1. `install_rolled_back` means the system is back to its prior state, the reason is printed, and the exit is 1. `install_incomplete` means rollback could not finish. It prints each leftover item, file, job, or Run value, and exits 1. Running `install` or `uninstall` again from any of these states converges.
- Uninstall transaction. `vonvon service uninstall`.
  1. Preflight. `absent` reports `not installed` and exits 0. `other-root` and `unrecognized` refuse.
  2. If a daemon owns the data root's lock, stop it through V3's `runStop`, with no deadline and stop-wins. Uninstall is a stop.
  3. Unload when the manager reports no running pid for the job. If a crash relaunch started one, repeat step 2 first. On macOS, run `launchctl bootout gui/<uid>/com.vonvon.bot.daemon` and remove the plist. On Linux, run `systemctl --user disable vonvon-bot.service`, remove the unit, and run `daemon-reload`. On Windows, delete the Run value first, which ends the `.cmd` loop's relaunch, then remove the launcher files after the daemon has stopped.
  4. Verify that the definition and the job are gone. If a daemon owns the lock again, repeat step 2. The log files stay.
  - Results. `uninstalled` exits 0. `uninstall_incomplete` prints the leftovers and exits 1, and rerunning converges. A failed uninstall never leaves a daemon force-stopped.
  - Residual risk. On macOS, a crash relaunch can start between the check in step 3 and `bootout`, and `bootout` would then send that fresh process `SIGTERM`. The uninstall unit test covers the recheck. The native run cannot time this race.
- **Open at login** and other entry points.
  - `login-item.ts` runs the same `vonvon service install` and `uninstall` that the CLI runs, from the app's own distribution, and shows their result. Turning it on installs. Turning it off uninstalls, which stops the daemon after its drain. The shell then starts a self-hosted daemon through `daemon-manager.ts` while its window is open.
  - The snapshot's `application.loginItem` is true exactly when the registration is `ours`.
  - The snapshot's platform enum has no Linux value and its shape is frozen, so the desktop app offers no login toggle on Linux. Linux users run `vonvon service install`.
  - The daemon's `machine.service` keeps V3's refusal, because a daemon cannot uninstall the service that runs it. The UI sends service actions through the shell capability `service(action)`, which runs the CLI. The web build shows the CLI commands.
  - `vonvon service status [--json]` prints the registration state and the manager's view. `--json` uses the existing `serviceStatusSchema` shape.
  - `host/service.ts` reports `supported`, `installed`, and `running` from the registration and the lock. `machine.status` and `admin` `daemonStatus` read it there, with their shapes unchanged.

*Daemon files.* V5 creates and edits only these daemon files.

- Create `service/identity.ts` (the names) and `service/registration.ts` (reading back and classifying a definition).
- Edit `service/launchd.ts`, `systemd.ts`, `win-startup.ts`, `adapter.ts`, and `common.ts`: definitions, transactions, and `start`. Remove their imports of `control.ts` and `codex-bin.ts`, and the Windows relauncher.
- Edit `cli/commands/service.ts`: `install`, `uninstall`, and `status` in place of the refusal.
- Edit `cli/commands/daemon.ts`: `runStart` routing through the manager. `runStop` is unchanged.
- Edit `cli/commands/run.ts`: the foreground refusal, and the exit-code mapping in *Exit codes*.
- Edit `host/lifecycle.ts`: no restart helper for a manager-launched daemon.
- Edit `host/service.ts`: status from the registration. Its actions keep refusing.
- Tests. Create `packages/daemon/test/service-identity.test.ts`, `service-definition.test.ts`, `service-transaction.test.ts`, and `service-launch.test.ts`.
- Root handoffs. None for the daemon side. `service` is already registered in `cli/index.ts`, and the daemon side adds no package dependency. The desktop's own dependencies, such as Electron and electron-builder, go to the root under *Shared files*.

*Native acceptance environment.* Root's read-only preflight, recorded for this design, is the following. On the Mac, the user `manzana` (uid 502) exists but has no `gui/502` domain. `github-ci` is reserved for CI. On Linux, the `ops` user's systemd user manager runs, but no dedicated test user is confirmed.

- Mac. Native acceptance needs a dedicated user with a GUI login session, because the product registers in `gui/<uid>`. `manzana` qualifies once someone logs it in through Fast User Switching or Screen Sharing and leaves the session up for the run. Only the operator can do that, so it is part of the operator's open capability request. `user/<uid>` bootstrapping does not substitute for it.
- Linux. A dedicated user, for example `vonvon-accept`, with `loginctl enable-linger`. The run uses that user's own `systemctl --user`, with `XDG_RUNTIME_DIR=/run/user/<uid>`. If the root has the privilege, it creates the user. Otherwise this joins the operator request. The `ops` account is never the test user.
- Windows. No native host is available. The Windows adapter is covered by unit tests with an injected registry and process runner, and by the hosted Windows CI job. No test writes the real Run key. Windows relaunch stays unverified on a real host, as `roadmap.md` records.
- Only the V5 native box waits for these. All other V5 work proceeds.

**Build.**

- [ ] `daemon-manager.ts` attaches to a running daemon. When none runs, it calls `vonvon daemon start` if the data root's registration is `ours`, and otherwise starts the bundled daemon with `ELECTRON_RUN_AS_NODE=1`, following Paseo `packages/desktop/src/daemon/node-entrypoint-launcher.ts`.
- [ ] The window loads `packages/ui/dist` and passes the local credential and the shell-capability object from V4's *Shell capabilities* through `preload.ts`. `openExternal` uses `shell.openExternal` after the same URL allowlist, and `window.open` from the page goes there through `setWindowOpenHandler`.
- [ ] Port the tray, single-instance lock, and auto-update from `desktop/main/index.ts` and `updates.ts` at `origin/codex/device-handoff`. Pick a PNG tray icon on Linux, because `new Tray()` with an `.ico` path hangs there.
- [ ] **Open at login** installs and uninstalls the daemon as an OS service per *Service gate*.
- [ ] Implement every daemon change in *Daemon files*.

**You see.**

- [ ] Launching the app opens the Bot list. Quitting the app leaves the bots running when **Open at login** is on.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/desktop/test/daemon-manager.test.ts` covers attach to a running daemon, start when absent, start through `vonvon daemon start` with no bundled spawn when the registration is `ours`, and refusal on a protocol version mismatch. Run `npm test -w packages/desktop`.
- [ ] `service-identity.test.ts` reads the adapter sources and fails on any bridge identifier, `feishu-codex-bridge` or `ai.feishu-codex-bridge`, or any import of `control.ts` or `codex-bin.ts`. It also fails on any stop command for a live daemon: `bootout` or `disable` without the no-pid check, `kickstart -k`, `systemctl stop`, `restart`, or `kill`, or `taskkill`.
- [ ] `service-definition.test.ts` checks the exact plist, unit, `.vbs`, and `.cmd` that each platform renders for a fixture data root, port, and distribution, including `KeepAlive`, `Restart=on-failure`, `TimeoutStopSec=infinity`, and the `.cmd` loop's exit and Run-value checks. It covers all four registration states and the refusal of `development` and `unknown` distributions.
- [ ] `service-transaction.test.ts` drives install and uninstall against a fake manager, file system, and registry runner. It covers a fresh install, an identical reinstall, an update refused while a daemon runs, `other-root` and `unrecognized` refusals that leave the file byte-identical, a failure injected at each step with the `install_rolled_back` or `install_incomplete` result and its leftover list, an uninstall that waits with no deadline for a held drain, stop-wins during that wait, the crash-relaunch recheck, and convergence on rerun.
- [ ] `service-launch.test.ts` covers `daemon start` routed through the manager, with no detached fallback when the manager fails, the port mismatch refusal, the foreground `daemon run` refusal and its `--bot` exemption, and the exit code for each case in *Exit codes*. That includes 75 only when the restart intent survives, and 0 under stop-wins. Run `npm test -w packages/daemon -- service-`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Launch the old app at `origin/codex/device-handoff` and the new shell at head with the same fixtures. Save `launch.png`. Pass when both windows show the Bot list.
- [ ] Lane 2. Launch with no daemon running. Save `cold.png`. Pass when the shell starts the bundled daemon and shows the list.
- [ ] Lane 3. Start the daemon from the CLI, then launch the shell. Save `attach.png`. Pass when the shell attaches and no second daemon exists.
- [ ] Lane 4. Close the window. Save `closed.txt`. Pass when the daemon and bots keep running.
- [ ] Lane 5. Launch the app twice. Save `second.png`. Pass when the existing window comes forward and no second app process remains.
- [ ] Lane 6. As the *Service gate*'s dedicated test user, turn on **Open at login**. Save `login-item.txt`. Pass when `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` shows the job loaded. Repeat the lane on Linux, in a VM or host with a systemd user session and never in hosted CI. The app offers no login toggle on Linux, per *Service gate*, so there the lane runs `vonvon service install`, and `systemctl --user is-enabled vonvon-bot.service` must report enabled. Then turn **Open at login** off on the Mac and pass when the job is gone, the daemon drained and stopped, and the shell started a self-hosted daemon.
- [ ] Lane 7. Quit from the tray menu with **Open at login** on. Save `quit.txt`. Pass when the app exits and the daemon keeps running.
- [ ] Lane 8. Start an older daemon build, then launch the shell. Save `mismatch.png`. Pass when the shell shows the version prompt instead of a blank window.
- [ ] Lane 9. Bind a group from the desktop window. Save `bind.png`. Pass when the group appears and `projects.json` agrees.
- [ ] Lane 10. Check for updates against a local feed. Save `update.png`. Pass when the update panel shows the feed version and waits for the user's click.
- [ ] Native service acceptance per *Service gate*, in addition to the ten lanes and never in place of one. It runs on launchd on the Mac and on systemd on Linux, as the dedicated user from *Native acceptance environment*, with its own uid, home, and a fresh `VONVON_HOME`. It never runs in the operator's account or in hosted CI, and no CI job or mock replaces it. If a dedicated user or a Linux systemd user session is missing, the box stays unchecked and V5 pauses for the operator. Use the packaged build of the frozen head. Save `native-launchd.txt` and `native-systemd.txt`, and in each record every command, its exit code, and the pid, port, and manager state it observed.
  1. Before anything else, from the operator's account and read-only, record the bridge's registration (`launchctl print gui/<operator uid>/ai.feishu-codex-bridge.bot`, or `systemctl --user cat feishu-codex-bridge.service` and its `is-enabled` and `is-active`), its definition file's checksum, the checksums of the bridge data files that `control.ts`'s `installationPaths` names, and the bridge process ids with their start times.
  2. `install` with no daemon running. The manager starts one on port `P`, and the manager's pid equals the lock owner's pid. Run `install` again and see `already installed`. Run `install` from a second `VONVON_HOME` and see a refusal, with the definition's checksum unchanged.
  3. `daemon start` attaches with no second process. `daemon start --port <other>` refuses. A foreground `daemon run` refuses.
  4. Crash. `kill -9` the daemon. A new pid owns the lock on port `P` within 15 s.
  5. Restart. Send `restartHost` through the local credential. The old pid exits 75, and a new pid owns port `P`.
  6. Unlimited drain. Hold the drain fixture from V3's CLI evidence bundle for at least 120 s, longer than launchd's and systemd's default stop timeouts. Run `vonvon daemon stop`. The daemon stays alive, and no `SIGKILL` arrives, until the fixture is released. Then it exits 0 and is not relaunched within 60 s. The registration is still present.
  7. Stop wins. Hold the fixture, send `restartHost`, then run `daemon stop` before releasing it. After the release the daemon exits 0 and nothing relaunches.
  8. Start after stop. `daemon start` starts the manager's job on port `P`.
  9. Login load. With the daemon stopped, unload and load the job the way a login does (`bootout` then `bootstrap`, or `daemon-reload` then `start` of the enabled unit). It starts on port `P`.
  10. Uninstall while the fixture is held. It waits, then removes the job and the definition. `launchctl print` or `systemctl --user cat` no longer finds it, no daemon runs, and a second `uninstall` reports `not installed`.
  11. Failure. Make the agent or unit directory unwritable and run `install`. It reports `install_refused` or `install_rolled_back` and leaves nothing behind. Restore the directory.
  12. Repeat step 1. Pass only when every step held and the bridge records are identical. Any difference fails the box.

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

## Replace the Claude Code backend with the Paseo provider (V6)

**Depends on.** V3. Development starts from `H3`. Acceptance needs the Feishu fixture Bot and the real Claude Code CLI. V6 merges after V5, in roadmap order. V6 publishes the freeze point `F6`.

**Files.**

- [ ] Create `packages/daemon/src/agent/paseo/` with `agent-sdk-types.ts`, `session-backend.ts`, `closure.json`, `logger.ts`, and the import closure below.
- [ ] Create `packages/daemon/src/agent/providers/` with `claude/` and the shared provider helpers below.
- [ ] Create `packages/daemon/test/session-backend.test.ts`, `paseo-closure.test.ts`, `claude-permission.test.ts`, and the ported Paseo tests under `packages/daemon/test/paseo/`.
- [ ] Edit `packages/daemon/src/agent/index.ts`, `agent/catalog.ts`, which the registry treats as authoritative, and `NOTICE`. The root checks the `createBackend('claude-agent')` lookup in `server/snapshot.ts`, per *Shared files*.
- [ ] Delete `packages/daemon/src/agent/claude-agent/`.

*Import closure.* A copy of `providers/claude/` alone does not compile. `agent.ts` and its helper tree import about 20 other Paseo modules, about 40 type names from `agent-sdk-types.ts`, and several `@getpaseo/protocol` subpaths. The rule is to copy whole modules and change only their import specifiers. The source is Paseo `0009a7e71`, and its paths are relative to `packages/server/src/server/`.

- Compute the closure first. Starting from `agent/agent-sdk-types.ts` and `agent/providers/claude/agent.ts`, follow every static import, every dynamic `import()`, and every `import type` to its file. Stop at npm packages. Write the result to `agent/paseo/closure.json`. Each entry has the source path, the destination path, the source file's SHA-256 at the pin, and its modification kind: `specifiers` or `adapted`, with a reason. Codex's closure count at `H3` (47 files, 26 of them outside `claude/`) is a check on the result, not a substitute for it.
- Destinations.
  - `agent/providers/**` goes to `packages/daemon/src/agent/providers/**`, keeping the relative path. This holds `claude/**`, `provider-runner`, `diagnostic-utils`, and `provider-image-output`.
  - Every other closure file under `agent/` goes to `packages/daemon/src/agent/paseo/`, keeping its path relative to `agent/`. This holds `agent-sdk-types`, `provider-options`, `prompt-attachments`, `provider-history-timestamps`, `provider-notices`, `provider-session-import`, `provider-refresh-deadline`, `provider-launch-config`, `system-prompt`, `tools/types`, and `executable-resolution/**`.
  - Closure files outside `agent/` go to `agent/paseo/runtime/`, keeping their path relative to `packages/server/src/`. This holds `server/paseo-env` and `utils/{spawn,tree-kill,promise-timeout}`.
  - Every `@getpaseo/protocol` subpath the closure imports, such as `agent-types`, `messages`, `provider-config`, `forge-manifest`, `tool-name-normalization`, and the tool-call display module, is copied from Paseo's protocol package into `agent/paseo/protocol/`, along with its own closure. It does not go into `packages/protocol`, whose shapes stay unchanged.
- Removals, recorded in `closure.json` with a reason.
  - The Paseo tool catalog runtime, meaning `tools/` other than `tools/types.ts`, and the tool policy and serialization modules. An import of these is deleted together with the code that offers Paseo's own tools to Claude. Vonvon has no Paseo tool catalog.
  - The subagent store runtime, `provider-subagents/store.ts`, and the timeline store it imports. The type declarations the closure needs from it, such as `ProviderSubagentInputEvent` and `ProviderSubagentStatus`, are copied verbatim into `agent/paseo/provider-subagents/types.ts`, together with any type they reference. The `claude/subagents/**` sources stay, because they are part of the provider.
  - `pino`. Its only use is `import type { Logger }`. The specifier changes to the new `agent/paseo/logger.ts`, which declares the structural `Logger` interface the closure calls. `session-backend.ts` adapts the daemon's logger to it.
  - No other module is replaced, and nothing is filled in from the old `claude-agent/` or written from scratch. An import that cannot be resolved under these rules is a blocker. Name it in the PR and hand it back to Claude Code, and keep working on everything else.
- Each copied file keeps its Apache-2.0 header. Each changed file gets a modification notice, and `NOTICE` gets the Paseo section.
- Dependencies. The root moves `@anthropic-ai/claude-agent-sdk` from `devDependencies` (`^0.3.178`) to `dependencies`, at exactly `0.3.246`, Paseo's pin. It does this in V6 only. The daemon's `zod` `4.6.5` satisfies Paseo's `^4.4.3`. Any other external package the closure imports, such as `tree-kill` or `which`, is added at Paseo's range, from `closure.json`.
- Tests. Copy every Paseo `*.test.ts` beside a copied file, except e2e and live tests, to the matching path under `packages/daemon/test/paseo/`, and change only their specifiers. A test that imports outside the closure is excluded, and `closure.json` lists it with its reason.

*Permission mapping.* Vonvon keeps V3's Claude permission behavior. It adds no interactive approval in Feishu and changes no wire shape.

- `session-backend.ts` passes each bridge mode to the copied provider as its `modeId` and `providerOptions`. The SDK `Options` the provider builds must equal V3's `claude-agent/permission.ts` table field for field.
  - `full`: `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`.
  - `write`: the same, plus the sandbox `{enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false}`.
  - `qa`: the `write` settings, plus `filesystem.denyWrite: [cwd]` and `disallowedTools` `Write`, `Edit`, and `NotebookEdit`.
  - Network off: also disallow `WebFetch` and `WebSearch`.
  - Every field exists in Paseo's `ClaudeProviderOptionsSchema`. If the copied provider cannot produce one of them from `modeId` and `providerOptions` without changing provider logic, that field is a blocker. The lanes that depend on it, lane 4 or 5, stay gated, and Claude Code decides the fix.
- Any `permission_requested` that still reaches `session-backend.ts`, for example from `AskUserQuestion` or a tool outside the mode's pre-approved set, becomes the existing passive `approval_request` event with the request's id, title, and detail. It is then resolved at once through `AgentSession.respondToPermission` as a denial, with the message that Vonvon Bot does not take interactive approvals in this mode and that Claude should continue without that action. The mode's own rules are already pre-approved through the options above, so denying everything else reproduces V3. `capabilities.approvals` keeps the value V3's `claude-agent` declares.
- `abort` first denies any request still unresolved, then calls `interrupt`. A prompt arriving with a request pending cannot happen, because every request resolves when it arrives. `close` does the same before closing the session.
- `steer` maps to `steerActiveTurn`. Resume maps to the client's resume path with the stored provider session id. Models map to `fetchCatalog` without a turn. Compact maps to the session's compaction path, or to `/compact` if that is what V3's `claude-agent` sent. A missing binary maps from the provider's launch error to V3's not-installed error text. These mappings change no `AgentEvent` or `AgentThread` shape.

**Build.**

- [ ] Compute and copy the closure per *Import closure*, writing `closure.json` first.
- [ ] `session-backend.ts` wraps any `AgentClient` as an `AgentBackend`. It maps timeline events to `AgentEvent`, `permission_requested` to `approval_request` with the resolution in *Permission mapping*, `steerActiveTurn` to `steer`, and `interrupt` to `abort`.
- [ ] Map the bridge modes `qa`, `write`, and `full` per *Permission mapping*.
- [ ] Register the provider in `agent/index.ts` and delete `claude-agent/`.

**You see.**

- [ ] A group bound to Claude Code answers in Feishu with a streaming run card, accepts a follow-up mid-turn, and stops within 2 s.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/daemon/test/session-backend.test.ts` drives a fake `AgentSession` through text, tool call, permission, steer, interrupt, and error, and asserts the `AgentEvent` sequence. A permission yields `approval_request` and then a denial through `respondToPermission`. An abort with a pending request denies it before `interrupt`. Run `npm test -w packages/daemon -- session-backend`.
- [ ] `paseo-closure.test.ts` recomputes the import closure from the copied files. It fails on an unresolved import, on a file missing from `closure.json` or listed there but absent, and on any import of the removed tool catalog, the subagent store runtime, `pino`, or `@getpaseo/*`.
- [ ] `claude-permission.test.ts` captures the SDK `Options` through the provider's injectable `queryFactory` for `qa`, `write`, and `full`, each with network on and off. It asserts them field for field against V3's table.
- [ ] The ported Paseo tests under `packages/daemon/test/paseo/` pass. Run `npm test -w packages/daemon -- paseo-closure claude-permission paseo/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Ask the same question in a Claude group at V3 head and at V6 head. Save `turn.txt`. Pass when both run cards finish and the V6 card shows the same sections.
- [ ] Lane 2. Send a follow-up while a long turn runs. Save `steer.txt`. Pass when the follow-up joins the same turn instead of queueing.
- [ ] Lane 3. Click stop during a `sleep 30` tool call. Save `stop.txt`. Pass when the card shows stopped within 2 s and the next message resumes the session.
- [ ] Lane 4. In `qa` mode ask Claude to write a file. Save `qa-write.txt`. Pass when the write is refused and no file appears.
- [ ] Lane 5. In `write` mode ask Claude to edit a file in the project. Save `write.txt`. Pass when the file changes.
- [ ] Lane 6. Restart the daemon and reply in the same topic. Save `resume.txt`. Pass when Claude answers with context from the earlier turn.
- [ ] Lane 7. Open the model list in the group settings card. Save `models.txt`. Pass when the list comes from the provider catalog without a throwaway turn.
- [ ] Lane 8. Run `/compact` in a long session. Save `compact.txt`. Pass when the card reports compaction.
- [ ] Lane 9. Remove the `claude` binary from `PATH` and send a message. Save `missing.txt`. Pass when the card shows a clear not-installed error.
- [ ] Lane 10. Check that a user hook in `~/.claude/settings.json` does not loop back into the bot. Save `hooks.txt`. Pass when one turn produces one card.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from message receipt to the first streamed token on the card, and time from stop click to stopped.
- [ ] Probe. Interleave five turns on the bridge Claude backend at V3 head and five on the new provider at V6 head, timed from the daemon log.
- [ ] Baseline. Record the V3 numbers first.
- [ ] Rule. Fail if first-token latency is more than 10% slower or stop takes longer than 2 s.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy Feishu client screenshots of lanes 1, 2, and 3 into `~/vonvon-review/V6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V6 only after the exact-head independent Shipping verdict is clean.

## Add ACP, Copilot, OpenCode, and Pi providers (V7)

**Depends on.** V6. The provider code starts from V6's branch at `F6`. The provider IDs and the picker wait until V4 has merged, and the root writes the provider IDs in `domain.ts`. Lane 7 needs V4's web UI. V7 merges after V6.

**Files.**

- [ ] Create `packages/daemon/src/agent/providers/acp/`, `copilot/`, `opencode/`, and `pi/`.
- [ ] Edit `packages/daemon/src/agent/index.ts`, `packages/protocol/src/domain.ts`, and the provider picker in `packages/ui/src/`.
- [ ] Edit `NOTICE`.

**Build.**

- [ ] Copy `acp-agent.ts`, `generic-acp-agent.ts`, `copilot-acp-agent.ts`, `jsonl-rpc-process.ts`, `jsonl-frame-decoder.ts`, `opencode-agent.ts` with `opencode/`, and `pi/` from Paseo, each behind `session-backend.ts`.
- [ ] Add each provider id to `ProviderId` and show only installed providers in the picker.

**You see.**

- [ ] A group bound to each installed provider answers a question in Feishu with a run card.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Port the Paseo unit tests for `jsonl-frame-decoder`, `jsonl-rpc-process`, and `generic-acp-agent`. Run `npm test -w packages/daemon -- providers`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run one Codex turn at V6 head and at V7 head. Save `codex.txt`. Pass when both run cards match.
- [ ] Lane 2. Run one turn on Copilot through ACP. Save `copilot.txt`. Pass when the card finishes with an answer.
- [ ] Lane 3. Run one turn on OpenCode. Save `opencode.txt`. Pass when the card finishes with an answer.
- [ ] Lane 4. Run one turn on Pi. Save `pi.txt`. Pass when the card finishes with an answer.
- [ ] Lane 5. Configure a custom ACP command in host settings and run a turn. Save `custom-acp.txt`. Pass when the card finishes.
- [ ] Lane 6. Stop a turn on each new provider. Save `stop.txt`. Pass when each stops within 2 s.
- [ ] Lane 7. Open the provider picker in the web UI with only Codex installed. Save `picker.png`. Pass when only Codex is offered.
- [ ] Lane 8. Kill each provider process mid-turn. Save `crash.txt`. Pass when each card shows an error and the next turn works.
- [ ] Lane 9. Switch a group from Codex to OpenCode. Save `switch.txt`. Pass when new sessions use OpenCode and old sessions keep Codex.
- [ ] Lane 10. Restart the daemon and resume an OpenCode topic. Save `resume.txt`. Pass when the reply has prior context.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Codex first-token latency at both heads, and first-token latency for each new provider.
- [ ] Probe. Interleave five Codex turns at V6 head and V7 head, then five turns per new provider at V7 head.
- [ ] Baseline. Record the V6 Codex number first.
- [ ] Rule. Fail if Codex is more than 5% slower at V7, or if any new provider's first token takes more than 15 s.

**Review evidence.** Keep the prescribed captures and independent verdict before guarded Shipping.

- [ ] Copy lane 2, 3, 4, and 7 screenshots into `~/vonvon-review/V7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V7-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V7 only after the exact-head independent Shipping verdict is clean.

## Import bridge data and shut the bridge down (V8)

**Depends on.** V4 for the UI import flow and acceptance. The daemon side, `import/**`, `cli/commands/import.ts`, and `protocol/src/import.ts`, starts from `H3` or `main`, and `packages/ui/src/import/**` waits for `F4`. V8 merges after V7.

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

- [ ] Lane 1. Regression lane against trunk. Trunk has no import, so record that. As the dedicated OS test user from V5's *Service gate*, never in the operator's account where the original bridge runs, install bridge `446b2a4` as its LaunchAgent with the test bot, import at head, and message the bot. Save `import-happy.png`. Pass when the reply comes from Vonvon Bot, `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` fails, and `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist` is gone. Repeat the lane in a Linux environment with the bridge's systemd user unit, as a dedicated test user there too.
- [ ] Lane 2. Run preflight only. Save `preflight.png`. Pass when the bridge keeps running and the source checksum is unchanged.
- [ ] Lane 3. Use a wrong App Secret in the bridge data. Save `bad-secret.png`. Pass when verify fails and the bridge service is running again.
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

**Depends on.** V8, and the Mac agent's signed installer URL, for acceptance and merge. Development may start at any time from `origin/codex/device-handoff`, because it needs only the marker name, which `architecture.md` fixes. Until the installer is published, the link is a configuration value, and lane 10 cannot pass.

**Files.**

- [ ] Edit `src/service/desktop-release.ts`, `src/card/dm-cards.ts`, `src/cli/index.ts`, and `src/cli/commands/run.ts` in `modelzen/feishu-codex-bridge`.
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

**Depends on.** V4 for `packages/ui/src/account/**`, which waits for `F4`. `packages/cloud/**`, `packages/daemon/src/cloud/**`, and the login commands start from `H3` or `main`. Lane 8 needs the V5 shell. V10 merges after V9. V10 publishes the freeze point `F10`.

**Files.**

- [ ] Create `packages/cloud/src/server.ts`, `oauth.ts`, `accounts.ts`, `devices.ts`, `store/postgres.ts`, and `store/memory.ts`.
- [ ] Create `packages/daemon/src/cloud/enroll.ts` and `link.ts`.
- [ ] Create `packages/ui/src/account/`.
- [ ] Create `packages/daemon/src/cli/commands/login.ts` for `vonvon login` and `vonvon logout`. The root registers them in `cli/index.ts`.

**Build.**

- [ ] Port Feishu and Lark SSO from vonvon-platform `src/oauth.ts`.
- [ ] Store accounts and devices behind one repository interface with Postgres and memory backends.
- [ ] Issue a device credential at enrollment that is separate from the user session, following vonvon-bridge-legacy `packages/account-service`.
- [ ] Keep presence from the daemon's outbound link. Store no settings.
- [ ] Add login and the machine list to the UI. Offline machines show offline and nothing else.

**You see.**

- [ ] After `vonvon login` on two machines, the web UI lists both under one account with online states.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/cloud/test/devices.test.ts` covers enroll, rename, revoke, and a revoked credential being refused. Run `npm test -w packages/cloud`.

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
- [ ] Create `packages/client/src/transport-relay.ts` and `e2ee/` from Paseo `packages/relay/src/crypto.ts`, `e2ee.ts`, and `encrypted-channel.ts`.
- [ ] Edit `packages/ui/src/` to add the machine switcher, and edit `NOTICE`.

**Build.**

- [ ] The daemon registers its X25519 public key at enrollment and keeps one outbound relay socket.
- [ ] The client opens a relay channel per machine and runs the same RPC over the encrypted channel.
- [ ] The cloud hosts `packages/ui/dist` and forwards ciphertext only.
- [ ] The UI warns when one `appId` is enabled on two online machines.

**You see.**

- [ ] From the hosted web UI, the user switches to another machine and changes a group setting, and the change shows on that machine.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/client/test/e2ee.test.ts` checks that a tampered frame is rejected and a wrong public key fails the handshake. Run `npm test -w packages/client`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Change a group setting locally at V10 head and remotely at V11 head. Save `remote-edit.png`. Pass when both changes land in `projects.json`.
- [ ] Lane 2. Capture relay traffic on the cloud side. Save `capture.txt`. Pass when no plaintext setting or path appears.
- [ ] Lane 3. Open a machine that is offline. Save `offline.png`. Pass when the UI says the machine is offline and shows no settings.
- [ ] Lane 4. Enable the same bot on two machines. Save `same-bot.png`. Pass when the warning shows.
- [ ] Lane 5. Drop the daemon's relay socket. Save `reconnect.png`. Pass when the client reconnects within 10 s.
- [ ] Lane 6. Revoke the machine while a client is connected. Save `revoked.png`. Pass when the client loses access at once.
- [ ] Lane 7. Use the desktop shell to open a remote machine. Save `desktop-remote.png`. Pass when the remote Bot list shows.
- [ ] Lane 8. Browse folders on the remote machine and bind a group. Save `remote-bind.png`. Pass when the remote `projects.json` lists it.
- [ ] Lane 9. Replace the daemon public key in the cloud row. Save `mitm.txt`. Pass when the client handshake fails.
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
- Whether the `AgentSession` to `AgentBackend` adapter keeps full fidelity for steer, interrupt, and permissions. V6 unit test and lanes 2 and 3 prove it.
- Whether the copied bridge suite passes unchanged after the data root move. V2's unit box proves it.

The facts below were read from source this session, not run.

- The bridge data root is fixed at `~/.feishu-codex-bridge` in `src/config/paths.ts`, and the key derives from `hostname|username` at `src/config/keystore.ts:75`.
- The bridge Claude backend reports `steer: false` and `approvals: false` in `src/agent/claude-agent/backend.ts:201` and `:206`, and uses `bypassPermissions` in `permission.ts:56`.
- The Core fork `codex/device-handoff` is 49 commits ahead of bridge `main` and holds 153 test files.

## Appendix B. Alternatives rejected

- Keep vendoring the bridge Core. Every Core change needs a bridge release and a pin, and the product stays dependent on another package.
- Adopt Paseo's Expo and React Native Web UI. It would replace the whole UI and lose the original style the owner wants to keep.
- Make Paseo's `AgentSession` the bot-facing contract. It would rewrite `src/bot/handle-message.ts` (5698 lines) and the Codex backend the owner is happy with.
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
- Keep V3's `__restart-after-exit` helper under a manager. systemd kills the unit's cgroup when the main process exits, which would take the helper with it, and launchd would race the helper with its own relaunch. Exit 75 lets the manager do the relaunch.
- Port the bridge's Windows relauncher, with its scheduled task, `relaunch.json`, and `taskkill /T /F` after a grace period. V5 never kills a daemon, so the relauncher's only remaining job is relaunching, and a `.cmd` loop gated on the Run value does that without a second registration.
- Record the service registration in a new file under `VONVON_HOME`. That adds a storage shape. The definition already carries `VONVON_HOME` and is the one record the manager acts on.
- Open URLs from the daemon for V4's open actions. After V11 a remote client would open a window on the daemon's machine. The browser already holds every URL and opens it in the click handler.
- Implement `chooseExecutable` and `saveExecutable` in the daemon with a server-side file browser. The protocol's token flow exists only to carry an Electron dialog's result. The existing host `settings save` of `execution.codexBin`, with a daemon-side check, covers it without a new picker.
- Answer Claude permission requests by asking in Feishu. It needs a new card, routing, and wire shapes. V3 already pre-approves each mode's actions and sandboxes the rest, so V6 denies anything else and records it as a passive `approval_request`.

## Appendix C. Risks

- V2, V6, V7, V8, and V9 need an isolated Feishu fixture from existing bridge data. Prefer a saved inactive Bot and a private group with only the operator and that Bot. Verify credentials and run Bot-connected lanes serially. Preserve the original data and both active Bot connections. Never connect concurrent baseline and daemon clients to the same Bot.
- Ten parallel lanes that each start a daemon, Chromium, or Electron may exhaust the Mac's memory. Run lanes in waves when `vm_stat` shows free pages running low. V5 lanes run one at a time because they share the login item.
- Remote access trusts the cloud to hand out the right daemon key. V11 lane 9 checks a swapped key fails, and a fingerprint check in the local UI is a follow-up.
- A desktop-bundled daemon and an npm-installed daemon may differ in version. V5 lane 8 watches it.
- The Claude provider from Paseo is about 6,600 lines tied to Paseo internals. V6's *Import closure* copies every module it pulls in, and `paseo-closure.test.ts` fails on any import outside that closure.
- A macOS crash relaunch can start between uninstall's no-pid check and `launchctl bootout`, which then sends the new process `SIGTERM`. The uninstall test covers the recheck, but native acceptance cannot time the race.
- V5's native service acceptance, V5 lane 6, and V8 lane 1 also need Linux for the systemd path. `systemctl --user` needs a user session, which hosted CI does not provide and never substitutes for. V5's acceptance and V8 lane 1 also need a dedicated OS test user on the Mac and on Linux, because the bridge service that V8 lane 1 installs uses the same label as the original bridge. An earlier environment report found neither: only the operator's Mac GUI session was available, and no Linux systemd user session was running. The current preflight and requests are under V5's *Native acceptance environment*. Recheck current availability read-only before requesting user action; `github-ci` stays reserved for CI. If the operator has to provide them, only the native box waits for that. The Windows Run-key path stays unverified until a Windows host exists.
- V3's stop has a short window after the release step of a restart, when no process answers for the data root. A stop in that window reports `already stopped`, and the replacement still starts. Running `vonvon daemon stop` again stops it.
- The cloud deploy target is undecided. V10 runs against a local Postgres until the operator picks one.

## Appendix D. Links and reading list

- `docs/architecture.md` and `docs/roadmap.md` in this folder.
- Paseo `docs/architecture.md`, `docs/providers.md`, `docs/hub.md`, `docs/permissions.md`, `docs/data-model.md`, and `SECURITY.md` in `getpaseo/paseo` at `0009a7e71`.
- feishu-codex-bridge `src/agent/types.ts`, `src/config/`, and `src/service/` at `446b2a4`.
- vonvon-bridge-legacy `packages/runtime/src/cli-migration-*.ts`, `legacy-cli-control.ts`, and `docs/adr/`.
- vonvon-platform `src/oauth.ts`.
- V3, V6, and V11 get `skills/how/SKILL.md` before code and `skills/interrogate/SKILL.md` before merge-ready.
- Each owner keeps a decision trail per `skills/show-me-your-work/SKILL.md`, uncommitted, returned in its report.
