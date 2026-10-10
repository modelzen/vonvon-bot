# Vonvon Bot v2 plan

Vonvon Bot becomes an independent product with a per-machine daemon, a web UI and an Electron desktop shell as clients, and an optional Vonvon account that lists every machine for remote management. It stops vendoring feishu-codex-bridge, imports a bridge user's data, and then shuts the bridge service down. The rule the program enforces is that the daemon is the only writer of machine data and the cloud never stores settings. The design and its reasons live in `docs/architecture.md` and `docs/roadmap.md` next to this file in `modelzen/vonvon-bot`. The PRs in order are V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/autopilot-stack.md` from the installed plugin. Codex on the operator's Mac runs it. Read `skills/poteto-mode/references/codex-tools.md` for the Codex equivalent of each Claude tool, model, and skill this plan names. The repository's `AGENTS.md` overrides one step of the playbook. Nobody force-pushes or rebases a pushed branch. A child syncs its parent by merging the parent branch in, and a child whose parent landed retargets to `main` and merges `main` in. Codex owns all code, every check in this plan, packaging, and guarded Shipping after verification. Claude Code on the Linux server normally owns this plan and the design docs, and writes no product code. When the plan is wrong or incomplete, Codex says so in the PR. Codex decides a small deviation that leaves the design intact and records why in the PR. A later change to the architecture, a data shape, or the PR order goes back to Claude Code, which updates the docs on a `claude/` branch before Codex continues.

On 2026-10-10 the Claude Code CLI returned HTTP 401 during the docs-only V2 clarification. The operator explicitly authorized Codex to apply that clarification and continue. The operator also authorized Codex to merge V2 and later planned PRs when verified, without personal UI review or a manual merge click. This exception does not waive screenshots, video, unit tests, all ten live lanes, perf checks, independent audits, or the exact-head Shipping verdict. It does not authorize force-push, rebase of pushed branches, or an hourly audit.

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
- [ ] Follow this dependency graph. Base each child on its parent branch and merge the parent in when it moves.
  - [ ] V1 is first and branches from `main`.
  - [ ] V2 after V1. V3 after V2.
  - [ ] V4 after V3. V6 after V3. V4 and V6 run in parallel.
  - [ ] V5 after V4. V7 after V6. V8 after V4. V10 after V4.
  - [ ] V9 after V8 and after Codex publishes a signed installer. V9 lives in `modelzen/feishu-codex-bridge`, branched from `origin/codex/device-handoff`.
  - [ ] V11 after V10.
- [ ] Hold the file boundaries. V1 touches only the root config, `packages/protocol/**`, `.github/**`, `NOTICE`, and `README.md`. V2 and V3 touch only `packages/daemon/**`, `scripts/import-core.mjs`, `packages/protocol/**`, and necessary root package metadata or lockfile changes for workspace integration. V3 also creates the minimal local client in `packages/client/**` that its lanes drive. V4 extends `packages/client/**` and adds `packages/ui/**` and `.agents/skills/verify/**`. V5 touches only `packages/desktop/**`. V6 and V7 touch only `packages/daemon/src/agent/**`, provider entries in `packages/protocol/**`, the provider picker in `packages/ui/**`, and `NOTICE`. V8 touches only `packages/daemon/src/import/**`, `packages/protocol/src/import.ts`, and `packages/ui/src/import/**`. V10 and V11 add `packages/cloud/**` and `packages/daemon/src/cloud/**`.
- [ ] Preserve interaction evidence. V3 through V11 keep their prescribed screenshots and video, then proceed through independent review and guarded Shipping without waiting for personal review or a manual merge click.

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
- [ ] A clean verdict appends the PR to the linear stack in roadmap order. Codex runs guarded Shipping on the contiguous verified stack from the root, bottom-up. A verdict stays valid across a merge-sync only when the stable patch-id of base to head is unchanged under the patch-id rule in `playbooks/shipping.md`.

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

- [ ] Create `packages/daemon/src/server/http.ts`, `ws.ts`, `local-credential.ts`, `pid-lock.ts`, `atomic-file.ts`, `directory-browser.ts`, `snapshot.ts`, and `jobs.ts`.
- [ ] Create `packages/daemon/src/server/rpc/` with one handler file per protocol request group.
- [ ] Create `packages/protocol/src/admin.ts` and `directory.ts`. Edit `domain.ts`, `environment.ts`, `handshake.ts`, `rpc.ts`, `events.ts`, `index.ts`, and `packages/protocol/test/protocol.test.ts` for the contract below.
- [ ] Create `packages/client/package.json`, `packages/client/src/client.ts`, and `transport-local.ts`. This is the minimal local client the V3 lanes drive. V4 extends it.
- [ ] Edit `packages/daemon/src/cli/commands/daemon.ts`.
- [ ] Edit the `src/web` callers and tests that *Deleting `src/web`* lists: `daemon-control.ts`, `run.ts`, `bot/supervisor.ts`, `bot/dm-console.ts`, `bot/handle-message.ts`, `card/dm-cards.ts`, and the named test files.
- [ ] Delete `packages/daemon/src/web/` and `packages/daemon/src/cli/commands/web.ts`, the read-only preview entry. The V2 `vonvon` CLI registers no `web` command, so no command disappears.

**Contract.** Codex implements these shapes as written. A change to them goes back to Claude Code. Appendix B records the rejected alternatives.

The snapshot stays the V1 `DesktopSnapshot` for the future UI. The old administrative state gets its own lossless reply, `admin` `state`. Sessions are read separately through the existing `settings` `sessions` request.

*Transport and handshake.*

- The daemon listens on `127.0.0.1` only, on `--port` (0 picks a free port). It refuses an upgrade whose `Host` or `Origin` is not loopback, as the old console did. It does not negotiate permessage-deflate.
- `$VONVON_HOME/local-credential` holds 32 random bytes in hex, mode 0600. The daemon creates it on first start and keeps it across restarts.
- The first client frame is `hello`. `hello` gains an optional `credential` string, and the local transport always sends it. If the credential is missing or wrong under a constant-time compare, if another frame comes first, or if no `hello` arrives within 5 s, the daemon closes the socket with code 4401 and reason `unauthorized`. A good `hello` gets `serverInfo`.
- `vonvon daemon start` spawns a detached `vonvon daemon run --port <n>` and returns once it listens. It installs no OS service, which stays with `vonvon service install`. `stop` sends SIGTERM and waits until the lock is gone. `status --json` prints `{running, pid?, listen?, version?, startedAt?}`, with `listen` as `127.0.0.1:<port>`. The pid lock `$VONVON_HOME/daemon.pid` records `pid`, `startedAt`, and `listen`.
- `restartHost` and `applyCoreUpdate` restart in place. The daemon spawns a detached helper that waits for the lock to clear and runs `vonvon daemon start` with the same port, then the daemon shuts down.

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
- `log` with `{lines}` goes to connections that turned `followLogs` on. The first event replays the last 16 KiB of today's log without a partial first line, as the old SSE did.
- `backendInstall` with `{operationId, id, update, item}` goes to connections attached to that install. `item` is `{type:"log", chunk}`, `{type:"done"}`, or `{type:"error", code, message}`.

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
- QR registration. `registerAgent` and `refreshAgentCredentials` reply `started {jobId}`, and each creates a `registerAgent` job. The job moves from `running` to `qr`, then ends `succeeded`, `failed`, or `cancelled`. In `qr`, `image` is a PNG data URL of `url`, `expiresAt` is now plus `expireIn` seconds, and `status` is the latest SDK status. `succeeded` carries `agentId`. The other old `done` fields are readable from `admin` `state`, the agent settings view, and `admin` `setupStatus`. `failed` carries `code`. The job belongs to the connection that started it. When that socket closes, the daemon aborts the registration and the job ends `cancelled`, as an SSE disconnect did. A new registration aborts a running one. `cancelJob` from any connection aborts it, as `DELETE /api/bots/register-qr` did. With 32 unsettled registrations the command replies `refused` with code `registration_busy`. V3 may add a QR encoder dependency to `packages/daemon`.
- Codex install and login. `installCodex` and `startCodexLogin` reply `started {jobId}`. The `CodexSetupService` job maps onto `jobSchema` as `installCodex` or `loginCodex`, and `authorizing` carries `userCode` and `verificationUrl`. A disconnect does not affect these jobs, as the old polling did not. `cancelJob` cancels one. A setup conflict replies `refused` with code `conflict`.
- Terminal jobs stay in `snapshot.jobs` for 10 minutes, then leave with a revision bump.
- Backend install. `environment` `backendInstall {id, update}` replies `{kind:"backendInstall", operationId, id, update, attached, replay}`. One job runs per `id` and `update` pair. A request for a running pair attaches to it, sets `attached: true`, and returns every buffered `log` item in `replay`. Attach and reply happen in one tick, so later events on that socket continue exactly after `replay`. A socket close only detaches. npm runs to the end and nothing rolls back. The job settles with `done`, or with `error` whose code is `install_failed`, `aborted`, or `unknown`. The settled job is dropped, so a later request starts a fresh install and `backendCatalog` shows the result.
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
- [ ] `packages/daemon/test/server-jobs.test.ts` checks four things. A QR job ends `cancelled` when its owner socket closes, and a second registration preempts the first. A backend install keeps running after detach, and a second request attaches with the full `replay` and then live items, with no gap or duplicate. The revision rises once per changed rebuild and not on an identical one. On the writer's socket the snapshot event comes before the write reply, a `command` `applied` reply's `revision` equals that event's, and a `settings` `save` reply keeps its string section `revision`, not the snapshot number. Run `npm test -w packages/daemon -- server rpc`.
- [ ] `packages/protocol/test/protocol.test.ts` parses every new request, reply, event, and job field in the contract, and still rejects a `hello` without `protocolVersion`. Run `npm test -w packages/protocol`.
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

- [ ] Copy lane 3 and lane 10 transcripts into `~/vonvon-review/V3-review-cli.txt`, and save a screenshot of the terminal session as `V3-review-cli.png`.
- [ ] Record a 30 to 60 second video of the change in a lane worktree. Save it as `~/vonvon-review/V3-review.mp4`.
- [ ] Save the screenshots and video with the PR evidence. Codex proceeds after the independent exact-head Shipping verdict; personal review is optional.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Base and verdict are current under the execution playbook and the patch-id rule in `playbooks/shipping.md`.
- [ ] Codex merges V3 only after the exact-head independent Shipping verdict is clean.

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
- [ ] Lane 6. Turn on **Open at login**. Save `login-item.txt`. Pass when `launchctl print gui/$(id -u)/com.vonvon.bot.daemon` shows the job loaded. Repeat the lane in a Linux environment, such as the Linux CI job or a VM, where `systemctl --user is-enabled vonvon-bot.service` must report enabled.
- [ ] Lane 7. Quit from the tray menu with **Open at login** on. Save `quit.txt`. Pass when the app exits and the daemon keeps running.
- [ ] Lane 8. Start an older daemon build, then launch the shell. Save `mismatch.png`. Pass when the shell shows the version prompt instead of a blank window.
- [ ] Lane 9. Bind a group from the desktop window. Save `bind.png`. Pass when the group appears and `projects.json` agrees.
- [ ] Lane 10. Check for updates against a local feed. Save `update.png`. Pass when the update panel shows the feed version and waits for the user's click.

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

- [ ] Lane 1. Regression lane against trunk. Trunk has no import, so record that. Install bridge `446b2a4` as its LaunchAgent with the test bot, import at head, and message the bot. Save `import-happy.png`. Pass when the reply comes from Vonvon Bot, `launchctl print gui/$(id -u)/ai.feishu-codex-bridge.bot` fails, and `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist` is gone. Repeat the lane in a Linux environment with the bridge's systemd user unit.
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

## Appendix C. Risks

- V2, V6, V7, V8, and V9 need an isolated Feishu fixture from existing bridge data. Prefer a saved inactive Bot and a private group with only the operator and that Bot. Verify credentials and run Bot-connected lanes serially. Preserve the original data and both active Bot connections. Never connect concurrent baseline and daemon clients to the same Bot.
- Ten parallel lanes that each start a daemon, Chromium, or Electron may exhaust the Mac's memory. Run lanes in waves when `vm_stat` shows free pages running low. V5 lanes run one at a time because they share the login item.
- Remote access trusts the cloud to hand out the right daemon key. V11 lane 9 checks a swapped key fails, and a fingerprint check in the local UI is a follow-up.
- A desktop-bundled daemon and an npm-installed daemon may differ in version. V5 lane 8 watches it.
- The Claude provider from Paseo is about 6,600 lines tied to Paseo internals. V6's owner watches for pulled-in modules beyond the provider folder.
- V5 lane 6 and V8 lane 1 also need Linux for the systemd path. `systemctl --user` needs a user session, which a CI runner may not have. Codex checks that before V5 and falls back to a Linux VM. The Windows Run-key path stays unverified until a Windows host exists.
- The cloud deploy target is undecided. V10 runs against a local Postgres until the operator picks one.

## Appendix D. Links and reading list

- `docs/architecture.md` and `docs/roadmap.md` in this folder.
- Paseo `docs/architecture.md`, `docs/providers.md`, `docs/hub.md`, `docs/permissions.md`, `docs/data-model.md`, and `SECURITY.md` in `getpaseo/paseo` at `0009a7e71`.
- feishu-codex-bridge `src/agent/types.ts`, `src/config/`, and `src/service/` at `446b2a4`.
- vonvon-bridge-legacy `packages/runtime/src/cli-migration-*.ts`, `legacy-cli-control.ts`, and `docs/adr/`.
- vonvon-platform `src/oauth.ts`.
- V3, V6, and V11 get `skills/how/SKILL.md` before code and `skills/interrogate/SKILL.md` before merge-ready.
- Each owner keeps a decision trail per `skills/show-me-your-work/SKILL.md`, uncommitted, returned in its report.
