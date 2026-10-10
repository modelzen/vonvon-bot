# Vonvon Bot v2 plan

Vonvon Bot becomes an independent product with a per-machine daemon, a web UI and an Electron desktop shell as clients, and an optional Vonvon account that lists every machine for remote management. It stops vendoring feishu-codex-bridge, imports a bridge user's data, and then shuts the bridge service down. The rule the program enforces is that the daemon is the only writer of machine data and the cloud never stores settings. The design and its reasons live in `docs/architecture.md` and `docs/roadmap.md` next to this file in `modelzen/vonvon-bot`. The PRs in order are V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. Codex on the operator's Mac runs it. Read `skills/poteto-mode/references/codex-tools.md` for the Codex equivalent of each Claude tool, model, and skill this plan names. The repository's `AGENTS.md` overrides one step of the playbook. Nobody force-pushes or rebases a shared branch. A child syncs its parent by merging the parent branch in, and a child whose parent landed retargets to `main` and merges `main` in. The operator lands every PR. Codex owns the code, the real-window checks, and packaging. Claude Code on the Linux server takes a lane only when the operator asks for it, such as the systemd checks in V5 and V8.

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
- [ ] On the operator's go, write this exact text into the standing orders and restate it in your todolist. "Plan is docs/plan.md in modelzen/vonvon-bot. PRs V1 to V11 in roadmap order. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator lands every PR. No force-push and no rebase of shared branches. Done when V11 is verified and every earlier PR has landed or been parked with a reason."
- [ ] Read these from the installed plugin at program start. Re-read them at every tick.
  - [ ] `skills/poteto-mode/playbooks/autopilot-stack.md`
  - [ ] `skills/swarm/SKILL.md`
  - [ ] `run` (the bundled Claude Code skill) until V4 lands, then `.agents/skills/verify/SKILL.md` in the repository
  - [ ] `skills/poteto-mode/playbooks/opening-a-pr.md`
  - [ ] `skills/how/SKILL.md`, `skills/interrogate/SKILL.md`, `skills/show-me-your-work/SKILL.md`, `skills/create-verification-skill/SKILL.md`
- [ ] Arm the hourly audit tick as a real `/loop` in dynamic mode, which schedules its own wake-up rather than blocking on a sleep. Never leave the cadence to memory. Codex has no `/loop`, so use a Codex scheduled task, or run the tick at the start of every turn and log its time.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from the installed plugin and the standing objective. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names. Owners use branch prefix `codex/`.
- [ ] Follow this dependency graph. Base each child on its parent branch and merge the parent in when it moves.
  - [ ] V1 is first and branches from `main`.
  - [ ] V2 after V1. V3 after V2.
  - [ ] V4 after V3. V6 after V3. V4 and V6 run in parallel.
  - [ ] V5 after V4. V7 after V6. V8 after V4. V10 after V4.
  - [ ] V9 after V8 and after Codex publishes a signed installer. V9 lives in `modelzen/feishu-codex-bridge`, branched from `origin/codex/device-handoff`.
  - [ ] V11 after V10.
- [ ] Hold the file boundaries. V1 touches only the root config, `packages/protocol/**`, `.github/**`, `NOTICE`, and `README.md`. V2 and V3 touch only `packages/daemon/**`, `scripts/import-core.mjs`, and `packages/protocol/**`. V4 adds `packages/client/**`, `packages/ui/**`, and `.agents/skills/verify/**`. V5 touches only `packages/desktop/**`. V6 and V7 touch only `packages/daemon/src/agent/**`, provider entries in `packages/protocol/**`, the provider picker in `packages/ui/**`, and `NOTICE`. V8 touches only `packages/daemon/src/import/**`, `packages/protocol/src/import.ts`, and `packages/ui/src/import/**`. V10 and V11 add `packages/cloud/**` and `packages/daemon/src/cloud/**`.
- [ ] Hold the review gate. V3, V4, V5, V6, V7, V8, V9, V10, and V11 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per **Opening a PR**. Use the run's built-in PR tool when it has one, else `origin pr create --status open --base <base-branch>` or `gh pr create --base <base-branch>` according to the resolved forge. A stack child targets its parent branch.
- [ ] Run the repo's lint and typecheck once before the PR-facing push. Push with hooks on.
- [ ] Run `/deslop` before each commit and `/no-comments` before review.
- [ ] Triage every review-bot and security-reviewer comment per `../references/bugbot-triage.md`.
- [ ] Before the code-ready report and babysit, and again after merge prep, record the base and head SHAs prepared by the topology owner under the execution playbook.
- [ ] Add the line `Mac window check: pending` to the body of every PR that changes what a window or page shows. The Mac agent replaces it with what it saw.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] A clean verdict appends the PR to the linear stack in roadmap order. The operator lands the stack bottom-up. A verdict stays valid across a merge-sync only when the stable patch-id of base to head is unchanged under the patch-id rule in `playbooks/shipping.md`.

### Boot recipe, for every live lane

Each live lane runs in its own worktree at the PR head. Drive through the skill path or exact commands recorded in this boot recipe.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `npm ci` and `npm run build` from the repository root. Export `VONVON_HOME=$(mktemp -d)` so no lane touches a real home. From V3 on, start the daemon with `node packages/daemon/bin/vonvon.mjs daemon start --port 0` and wait until `vonvon daemon status --json` reports a `listen` address.
- [ ] Deliver input only through the driver skill's commands. Before V4, run the `vonvon` CLI from the shell and drive the daemon's WebSocket through `packages/client`. From V4 on, use the repository `verify` skill. It drives the web UI in Playwright Chromium (`npx playwright install chromium` once) and the Electron shell in a real macOS window through Playwright's `_electron` launcher. Lanes that need Feishu read the test bot from `~/.vonvon-test/feishu-bot.json`. Read-only diagnostics are `vonvon daemon status --json`, `$VONVON_HOME/logs/`, and `vonvon daemon logs --tail 200`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report. A CLI lane saves its terminal transcript as `<slug>.txt` in the same folder.

## Build the monorepo and the protocol package (V1)

**Depends on.** None.

**Files.**

- [ ] Create `package.json` with npm workspaces `packages/*`, plus `tsconfig.base.json` and `vitest.config.ts`.
- [ ] Create `packages/protocol/src/domain.ts`, `rpc.ts`, `events.ts`, `handshake.ts`, and `index.ts`.
- [ ] Create `packages/protocol/test/protocol.test.ts`.
- [ ] Create `.github/workflows/ci.yml` running on `ubuntu-latest` and `macos-latest`.
- [ ] Create `NOTICE`.
- [ ] Edit `README.md`.

**Build.**

- [ ] Port the zod schemas from `desktop/shared/bridge.ts`, `settings.ts`, `collaboration.ts`, `environment.ts`, `machine.ts`, and `watch.ts` at `origin/codex/device-handoff` into `packages/protocol`. Leave out `quit`, `hideWindow`, `setLoginItem`, and `chooseFolder`.
- [ ] Add the branded `MachineId`, the `hello` and `serverInfo` handshake schemas, and `PROTOCOL_VERSION` in `handshake.ts`.
- [ ] Add the request, response, and event envelopes in `rpc.ts` and `events.ts`.

**You see.**

- [ ] `npm ci && npm run typecheck && npm test` passes on the Mac and in both CI jobs on the PR.

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
- [ ] Lane 9. Read the CI run for the PR head with `gh run view`. Save `ci.txt`. Pass when the Linux and macOS jobs are green.
- [ ] Lane 10. Check `NOTICE` names feishu-codex-bridge (MIT) and Paseo (Apache-2.0). Save `notice.txt`. Pass when both names and licenses appear.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `npm test -w packages/protocol` and the parse time of one full settings snapshot. Trunk has no package, so the diff-added work has an absolute budget.
- [ ] Probe. Run `hyperfine -w 2 -r 10 'npm test -w packages/protocol'` and a 1000-iteration parse loop at head.
- [ ] Baseline. Record that trunk `main` has no test suite and no parse path.
- [ ] Rule. Fail if the test suite takes more than 10 s or one snapshot parse takes more than 2 ms on the Mac.

**Review gate.** None. V1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V1 to the stack and the operator lands it bottom-up.

## Copy the bot runtime into the daemon package (V2)

**Depends on.** V1.

**Files.**

- [ ] Create `scripts/import-core.mjs`.
- [ ] Create `packages/daemon/` with the copied `src/**`, `test/**`, and `PROVENANCE.md`.
- [ ] Create `packages/daemon/bin/vonvon.mjs`.
- [ ] Edit `packages/daemon/src/config/paths.ts` and `packages/daemon/src/config/keystore.ts`.

**Build.**

- [ ] `scripts/import-core.mjs` takes the path of a feishu-codex-bridge checkout, copies `src/` and `test/` at `446b2a4` into `packages/daemon`, and writes the source SHA into `PROVENANCE.md`. Rerunning it on a clean tree gives the same bytes.
- [ ] Point `appDir` in `paths.ts` at `VONVON_HOME`, defaulting to `~/.vonvon-bot`.
- [ ] Replace the hostname-derived key in `keystore.ts` with a random key in `$VONVON_HOME/master.key`, mode 0600.
- [ ] Rename the CLI entry to `vonvon` in `bin/vonvon.mjs` and keep `vonvon daemon run` as the foreground runner.

**You see.**

- [ ] `VONVON_HOME=$(mktemp -d) node packages/daemon/bin/vonvon.mjs daemon run` starts, logs the supervisor ready line, and creates no file outside `VONVON_HOME`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The copied suite runs green. Run `npm test -w packages/daemon` and record the pass count against the 153 files at `446b2a4`.
- [ ] `packages/daemon/test/data-root.test.ts` gains a case that `VONVON_HOME` wins and that nothing is written under `~/.feishu-codex-bridge`.
- [ ] `packages/daemon/test/keystore.test.ts` gains a case that a renamed host still decrypts. Run `npm test -w packages/daemon -- keystore`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the bridge at `446b2a4` with `node bin/feishu-codex-bridge.mjs run` and the daemon at head with `vonvon daemon run`, each with the test bot. Save `startup.txt`. Pass when both reach the bot connected log line.
- [ ] Lane 2. Send a DM to the test bot and open the DM menu card. Save `dm-menu.txt`. Pass when the daemon log shows the card sent and the Feishu API returns success.
- [ ] Lane 3. Bind a test group to a temp folder through the DM card flow. Save `bind.txt`. Pass when `$VONVON_HOME/bots/<appId>/projects.json` lists the group.
- [ ] Lane 4. Mention the bot in the test group with `pwd`. Save `codex-turn.txt`. Pass when the run card finishes and its text contains the temp folder path.
- [ ] Lane 5. Kill the codex app-server child mid-turn. Save `codex-crash.txt`. Pass when the run card shows an error and the next mention succeeds.
- [ ] Lane 6. Start a second `vonvon daemon run` against the same `VONVON_HOME`. Save `second-instance.txt`. Pass when the second process exits with the single-instance error.
- [ ] Lane 7. Run the daemon with `HOME` and `VONVON_HOME` both set to fresh temp folders, then list what exists under each. Save `paths.txt`. Pass when `$HOME/.feishu-codex-bridge` does not exist and every new file is under `VONVON_HOME`.
- [ ] Lane 8. Store the test bot secret, then restart the daemon with `node --require` of a shim that makes `os.hostname()` return a different name. Save `rename.txt`. Pass when the bot reconnects.
- [ ] Lane 9. Run `node scripts/import-core.mjs` twice on a clean tree. Save `import-core.txt`. Pass when `git status --porcelain` is empty after the second run.
- [ ] Lane 10. Send SIGTERM to the supervisor. Save `shutdown.txt`. Pass when every child exits within 10 s and the lock files are gone.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from process start to the bot connected log line, and supervisor plus child RSS after 60 s idle with one bot.
- [ ] Probe. Interleave five runs of the bridge at `446b2a4` and five of the daemon at head, timing with the log timestamps and reading RSS from `/proc/<pid>/status`.
- [ ] Baseline. Record the bridge numbers first.
- [ ] Rule. Fail if the median start time is more than 10% slower or the RSS is more than 10% higher than the bridge.

**Review gate.** None. V2 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V2 to the stack and the operator lands it bottom-up.

## Serve the daemon API over WebSocket (V3)

**Depends on.** V2.

**Files.**

- [ ] Create `packages/daemon/src/server/http.ts`, `ws.ts`, `local-credential.ts`, `pid-lock.ts`, `atomic-file.ts`, and `directory-browser.ts`.
- [ ] Create `packages/daemon/src/server/rpc/` with one handler file per protocol request group.
- [ ] Create `packages/client/src/client.ts` and `transport-local.ts`.
- [ ] Edit `packages/daemon/src/cli/commands/daemon.ts`.
- [ ] Delete `packages/daemon/src/web/`.

**Build.**

- [ ] Port `pid-lock.ts` and `atomic-file.ts` from Paseo `packages/server/src/server/` with their notices.
- [ ] Accept `hello`, check the credential in `$VONVON_HOME/local-credential`, and reply `serverInfo`.
- [ ] Move each route of the old web console's admin backend into an RPC handler, then delete `src/web`.
- [ ] Publish revisioned snapshot events, using the revision rule from `watch.ts`.
- [ ] Add a directory browser RPC rooted at the user's home.
- [ ] Add `vonvon daemon start`, `stop`, and `status --json`.

**You see.**

- [ ] `vonvon daemon start` returns, `vonvon daemon status --json` shows `listen`, and a `packages/client` script prints the snapshot.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/daemon/test/server-handshake.test.ts` rejects a bad credential and accepts a good one.
- [ ] `packages/daemon/test/rpc-parity.test.ts` calls every RPC that replaced a web console route and checks the reply schema. Run `npm test -w packages/daemon -- server rpc`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. At V2 head read state through the old console's `GET /api/state`, and at V3 head read the snapshot RPC, on the same `VONVON_HOME`. Save `state-parity.txt`. Pass when bots, projects, and sessions match field for field.
- [ ] Lane 2. Connect without a credential. Save `no-cred.txt`. Pass when the socket closes with the auth error code.
- [ ] Lane 3. Run `vonvon daemon start` twice. Save `start-twice.txt`. Pass when the second call reports the running instance and no second process exists.
- [ ] Lane 4. Kill the daemon with SIGKILL and run `vonvon daemon start`. Save `stale-lock.txt`. Pass when the stale lock is replaced and the daemon starts.
- [ ] Lane 5. Toggle a bot off through the RPC. Save `toggle.txt`. Pass when the snapshot revision increases and the bot child process exits.
- [ ] Lane 6. Subscribe two clients and change a project setting from one. Save `fanout.txt`. Pass when both receive the new revision.
- [ ] Lane 7. Browse directories from home down two levels. Save `browse.txt`. Pass when entries are listed and a path outside home is refused.
- [ ] Lane 8. Bind a group through the RPC with a browsed path. Save `bind-rpc.txt`. Pass when `projects.json` lists the group with that `cwd`.
- [ ] Lane 9. Send a request with an unknown method. Save `unknown.txt`. Pass when the reply is an RPC error and the socket stays open.
- [ ] Lane 10. Run `vonvon daemon stop`. Save `stop.txt`. Pass when the process exits, the lock file is gone, and bots disconnect.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Round trip of the snapshot request, p50 and p95 over 200 calls, and the snapshot payload size.
- [ ] Probe. Interleave 200 `GET /api/state` calls at V2 head with 200 snapshot RPCs at V3 head on the same data.
- [ ] Baseline. Record the V2 HTTP numbers first.
- [ ] Rule. Fail if the RPC p95 is more than 20% above the HTTP p95 or the payload is larger.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3 and lane 10 transcripts into `~/vonvon-review/V3-review-cli.txt`, and save a screenshot of the terminal session as `V3-review-cli.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V3-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V3 to the stack and the operator lands it bottom-up.

## Port the UI to a web client served by the daemon (V4)

**Depends on.** V3.

**Files.**

- [ ] Create `packages/ui/` from `desktop/renderer/` at `origin/codex/device-handoff`.
- [ ] Create `packages/ui/src/client-context.tsx`.
- [ ] Create `packages/daemon/src/server/web-ui.ts`.
- [ ] Create `.agents/skills/verify/` through `/create-verification-skill`.

**Build.**

- [ ] Replace every `window.bridge` call in `App.tsx`, `SettingsPanel.tsx`, `ProjectPanel.tsx`, `JoinGroupDialog.tsx`, and `pending-groups.ts` with the injected `VonvonClient`.
- [ ] Replace the folder picker with the directory browser RPC.
- [ ] Serve the built `packages/ui/dist` from the daemon, with the local credential handed over by `vonvon open`.
- [ ] Generate the repository `verify` skill for the web UI and the desktop shell.

**You see.**

- [ ] `vonvon open` opens the browser on the daemon's page, which shows the Bot list in the original style.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] The ported `tests/collaboration-navigation.test.ts`, `search.test.ts`, and `environment-presentation.test.ts` pass under `packages/ui`. Run `npm test -w packages/ui`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Render the Bot list in the old Electron app at `origin/codex/device-handoff` with the native fixtures, and in the web UI at head with the same data. Save `bot-list.png`. Pass when both show the same bots, names, and enabled states.
- [ ] Lane 2. Open a Bot's settings pane. Save `bot-settings.png`. Pass when every section from the old pane is present.
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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, 3, and 4 screenshots into `~/vonvon-review/V4-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V4-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V4 to the stack and the operator lands it bottom-up.

## Wrap the UI in an Electron shell that runs the daemon (V5)

**Depends on.** V4.

**Files.**

- [ ] Create `packages/desktop/src/main.ts`, `daemon-manager.ts`, `tray.ts`, `updates.ts`, and `preload.ts`.
- [ ] Create `packages/desktop/electron-builder.yml`.
- [ ] Create `packages/desktop/src/login-item.ts`, which calls the service installer in `packages/daemon/src/service/`.

**Build.**

- [ ] `daemon-manager.ts` connects to a running daemon or starts the bundled one with `ELECTRON_RUN_AS_NODE=1`, following Paseo `packages/desktop/src/daemon/node-entrypoint-launcher.ts`.
- [ ] The window loads `packages/ui/dist` and passes the local credential through `preload.ts`.
- [ ] Port the tray, single-instance lock, and auto-update from `desktop/main/index.ts` and `updates.ts` at `origin/codex/device-handoff`. Pick a PNG tray icon on Linux, because `new Tray()` with an `.ico` path hangs there.
- [ ] **Open at login** installs the daemon as an OS service through `packages/daemon/src/service/`.

**You see.**

- [ ] Launching the app opens the Bot list. Quitting the app leaves the bots running when **Open at login** is on.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/desktop/test/daemon-manager.test.ts` covers attach to a running daemon, start when absent, and refusal on a protocol version mismatch. Run `npm test -w packages/desktop`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on the configured `swarm workers` model at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Launch the old app at `origin/codex/device-handoff` and the new shell at head with the same fixtures. Save `launch.png`. Pass when both windows show the Bot list.
- [ ] Lane 2. Launch with no daemon running. Save `cold.png`. Pass when the shell starts the bundled daemon and shows the list.
- [ ] Lane 3. Start the daemon from the CLI, then launch the shell. Save `attach.png`. Pass when the shell attaches and no second daemon exists.
- [ ] Lane 4. Close the window. Save `closed.txt`. Pass when the daemon and bots keep running.
- [ ] Lane 5. Launch the app twice. Save `second.png`. Pass when the existing window comes forward and no second app process remains.
- [ ] Lane 6. Turn on **Open at login**. Save `login-item.txt`. Pass when `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` shows the job loaded. Ask Claude Code on the Linux server to repeat the lane with `systemctl --user is-enabled vonvon-bot.service`.
- [ ] Lane 7. Quit from the tray menu with **Open at login** on. Save `quit.txt`. Pass when the app exits and the daemon keeps running.
- [ ] Lane 8. Start an older daemon build, then launch the shell. Save `mismatch.png`. Pass when the shell shows the version prompt instead of a blank window.
- [ ] Lane 9. Bind a group from the desktop window. Save `bind.png`. Pass when the group appears and `projects.json` agrees.
- [ ] Lane 10. Check for updates against a local feed. Save `update.png`. Pass when the update panel shows the feed version and waits for the user's click.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from app launch to the Bot list painted, cold and with a running daemon, and total RSS of app plus daemon.
- [ ] Probe. Interleave five launches of the old app and five of the new shell, timed from process start to the first paint event.
- [ ] Baseline. Record the old app numbers first.
- [ ] Rule. Fail if the new shell is more than 15% slower or uses more than 15% more memory.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 8 screenshots into `~/vonvon-review/V5-review-<slug>.png`. Include the Linux screenshots if Claude Code ran the systemd lane.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V5-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V5 to the stack and the operator lands it bottom-up.

## Replace the Claude Code backend with the Paseo provider (V6)

**Depends on.** V3.

**Files.**

- [ ] Create `packages/daemon/src/agent/paseo/agent-sdk-types.ts` and `session-backend.ts`.
- [ ] Create `packages/daemon/src/agent/providers/claude/`.
- [ ] Edit `packages/daemon/src/agent/index.ts` and `NOTICE`.
- [ ] Delete `packages/daemon/src/agent/claude-agent/`.

**Build.**

- [ ] Copy `agent-sdk-types.ts` and `providers/claude/` from Paseo `packages/server/src/server/agent/`, and remove the imports of the Paseo tool catalog and subagent store.
- [ ] `session-backend.ts` wraps any `AgentClient` as an `AgentBackend`. It maps timeline events to `AgentEvent`, `permission_requested` to `approval_request`, `steerActiveTurn` to `steer`, and `interrupt` to `abort`.
- [ ] Map the bridge modes `qa`, `write`, and `full` onto Claude permission modes and `canUseTool` rules.
- [ ] Register the provider in `agent/index.ts` and delete `claude-agent/`.

**You see.**

- [ ] A group bound to Claude Code answers in Feishu with a streaming run card, accepts a follow-up mid-turn, and stops within 2 s.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/daemon/test/session-backend.test.ts` drives a fake `AgentSession` through text, tool call, permission, steer, interrupt, and error, and asserts the `AgentEvent` sequence. Run `npm test -w packages/daemon -- session-backend`.

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

**Review gate.** The operator reviews before merge.

- [ ] Copy Feishu client screenshots of lanes 1, 2, and 3 into `~/vonvon-review/V6-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V6-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V6 to the stack and the operator lands it bottom-up.

## Add ACP, Copilot, OpenCode, and Pi providers (V7)

**Depends on.** V6.

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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, 4, and 7 screenshots into `~/vonvon-review/V7-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V7-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V7 to the stack and the operator lands it bottom-up.

## Import bridge data and shut the bridge down (V8)

**Depends on.** V4.

**Files.**

- [ ] Create `packages/daemon/src/import/bridge/preflight.ts`, `journal.ts`, `execute.ts`, `legacy-keystore.ts`, and `hooks.ts`.
- [ ] Create `packages/daemon/src/import/bridge/service-control/launchd.ts`, `systemd.ts`, and `windows.ts`.
- [ ] Create `packages/protocol/src/import.ts`.
- [ ] Create `packages/ui/src/import/`.
- [ ] Edit `packages/daemon/src/cli/index.ts` to add `vonvon import feishu-codex-bridge`.

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

- [ ] Lane 1. Regression lane against trunk. Trunk has no import, so record that. Install bridge `446b2a4` as its LaunchAgent with the test bot, import at head, and message the bot. Save `import-happy.png`. Pass when the reply comes from Vonvon Bot, `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` fails, and `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist` is gone. Ask Claude Code on the Linux server to repeat the lane with the systemd unit.
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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 2, and 3 screenshots into `~/vonvon-review/V8-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V8-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V8 to the stack and the operator lands it bottom-up.

## Ship the bridge release that points users to Vonvon Bot (V9)

**Depends on.** V8, and the Mac agent's signed installer URL.

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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 3, 5, and 6 captures into `~/vonvon-review/V9-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V9-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The operator lands V9 in the bridge repo and publishes the npm release after V8 lands.

## Add accounts and the machine list (V10)

**Depends on.** V4.

**Files.**

- [ ] Create `packages/cloud/src/server.ts`, `oauth.ts`, `accounts.ts`, `devices.ts`, `store/postgres.ts`, and `store/memory.ts`.
- [ ] Create `packages/daemon/src/cloud/enroll.ts` and `link.ts`.
- [ ] Create `packages/ui/src/account/`.
- [ ] Edit `packages/daemon/src/cli/index.ts` to add `vonvon login` and `vonvon logout`.

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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 8 screenshots into `~/vonvon-review/V10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V10 to the stack and the operator lands it bottom-up.

## Manage any machine remotely through an encrypted relay (V11)

**Depends on.** V10.

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

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, 4, and 7 screenshots into `~/vonvon-review/V11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] The root appends V11 to the stack and the operator lands it bottom-up.

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

## Appendix C. Risks

- No Feishu test bot exists yet. V2, V6, V7, V8, and V9 lanes need `~/.vonvon-test/feishu-bot.json` on the Mac. The operator creates a test app and writes that file before V2 starts.
- Ten parallel lanes that each start a daemon, Chromium, or Electron may exhaust the Mac's memory. Run lanes in waves when `vm_stat` shows free pages running low. V5 lanes run one at a time because they share the login item.
- Remote access trusts the cloud to hand out the right daemon key. V11 lane 9 checks a swapped key fails, and a fingerprint check in the local UI is a follow-up.
- A desktop-bundled daemon and an npm-installed daemon may differ in version. V5 lane 8 watches it.
- The Claude provider from Paseo is about 6,600 lines tied to Paseo internals. V6's owner watches for pulled-in modules beyond the provider folder.
- V8 lane 1 runs on macOS. The systemd path needs the Linux server, and the Windows Run-key path stays unverified until a Windows host exists.
- The cloud deploy target is undecided. V10 runs against a local Postgres until the operator picks one.

## Appendix D. Links and reading list

- `docs/architecture.md` and `docs/roadmap.md` in this folder.
- Paseo `docs/architecture.md`, `docs/providers.md`, `docs/hub.md`, `docs/permissions.md`, `docs/data-model.md`, and `SECURITY.md` in `getpaseo/paseo` at `0009a7e71`.
- feishu-codex-bridge `src/agent/types.ts`, `src/config/`, and `src/service/` at `446b2a4`.
- vonvon-bridge-legacy `packages/runtime/src/cli-migration-*.ts`, `legacy-cli-control.ts`, and `docs/adr/`.
- vonvon-platform `src/oauth.ts`.
- V3, V6, and V11 get `skills/how/SKILL.md` before code and `skills/interrogate/SKILL.md` before merge-ready.
- Each owner keeps a decision trail per `skills/show-me-your-work/SKILL.md`, uncommitted, returned in its report.
