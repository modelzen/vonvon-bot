# What the user can run today on main (be17859), and the shortest path to a first build they can try

## Bottom line

- **The code on main already covers the full loop on a Mac.** The steps are: start the daemon, open the web UI or the desktop window, register a Feishu bot by QR code, bind a group to a folder, @ the bot, and get a Codex reply card. Codex has seen every step working on its Mac during PR acceptance, with one exception. Nobody has finished registering a new bot by QR scan end to end in v2: #69 showed the QR code but says it does not claim a completed scan.
- **What is missing is a build in the user's hands, not code.** There is no published npm package, no GitHub release and no CI artifact. No PR so far has asked the user to try anything.
- **The live agent path is the bridge-era `agent/` code**, with Codex as the default backend. The new `provider/` layer is only partly wired in. Claude Code is registered and can be picked in the UI, but I found no record of a real Claude turn in any v2 acceptance.
- **None of the open or planned work is needed for a first trial build.** That covers V5 12–15, V6b 1–14, V6c, V6d, V7, and V8 to V11. One open PR, #281, would break Codex in packaged builds unless the native holder binary is also packaged. Cut the trial build from current main before #281 merges, or package the holder first.

## 1. Can the user clone main and run something today?

### Prerequisites (per code)
- **Node:** `^22.12.0 || ^24 || >=26` (root `package.json` engines).
- **Codex CLI:** must be installed and logged in, because the catalog treats Codex as an external CLI (`packages/daemon/src/agent/catalog.ts:93-99`). The alternative is the 本机环境 page's install and login jobs, `installCodex` and `startCodexLogin` (`packages/ui/src/App.tsx:853`).
- **Feishu account:** it must be allowed to create an app through the Lark SDK `registerApp` QR flow (`packages/daemon/src/bot/wizard.ts:1,70`).
- **Electron binary:** `npm ci` on the Mac downloads it. It is absent on JP-VPS (`node_modules/electron/dist` is missing), so the desktop app cannot run there.

### Path A: daemon plus web UI (V3 #34, V4 #69)
```sh
git clone https://github.com/modelzen/vonvon-bot.git && cd vonvon-bot   # main = be17859
npm ci
npm run build                                   # protocol, client, daemon (tsup), ui (vite), desktop (esbuild + stage)
node packages/daemon/bin/vonvon.mjs daemon start   # prints "running PID <pid> at 127.0.0.1:<port>"
node packages/daemon/bin/vonvon.mjs open           # opens the browser at http://127.0.0.1:<port>/#credential=<hex>
# later: node packages/daemon/bin/vonvon.mjs daemon stop
```
Sources: `packages/daemon/src/cli/index.ts:21-50`, `cli/commands/daemon.ts:26-89`, `cli/commands/open.ts:10-24`. `vonvon` is not on PATH in a checkout; `bin/vonvon.mjs` only imports `dist/cli.js`.

- **With no bot registered, the daemon still serves the UI.** `daemon start` runs `daemon run` detached and without a TTY (`daemon.ts:52-56`), so `runRun` skips terminal onboarding (`cli/commands/run.ts:33`). The supervisor then starts the API with zero bots (`bot/supervisor.ts:166`).
- **What the user sees:**
  - The old Vonvon Bot 0.7.0 management UI, ported with its original styles (#69 body: "提供原桌面的 Bot 管理界面…保留原样式").
  - Sidebar: Bot / 群聊 / 本机环境 / 用量 / 咖啡一下 / 应用与启动 / 状态与诊断 (`packages/ui/src/LocalShell.tsx:8-10`).
  - An empty Bot list with an 添加 Bot button (`App.tsx:572,625`), which opens a 飞书扫码注册 QR modal (`App.tsx:1060-1077`).
  - The daemon reports version 0.7.0 (`packages/daemon/package.json`).
- **Chat happens in Feishu, not in the UI.** `docs/architecture.md:9`: "桌面端和网页不聊天，只用来设置 Bot、群、会话和本机环境". The terminal hint lists the user commands: DM `/new <名>` to create a project, then @ the bot in the project group (`run.ts:69-70`).

### Path B: desktop window (V5 #257)
- **B1, dev attach:** start the daemon with Path A, then run `npm start -w packages/desktop` (`electron .`, `packages/desktop/package.json:11`). An unpackaged shell can only attach to a running daemon. Without one it throws "The packaged Vonvon daemon is unavailable. Build and open the desktop application." (`packages/desktop/src/daemon-dependencies.ts:71-72`).
- **B2, packaged app:** after `npm run build`, run `npm run package:dir -w packages/desktop` (electron-builder `--dir`, output under `packages/desktop/dist/package/`, `electron-builder.yml:5`; I did not verify the exact subfolder name).
  - On open, the app starts its bundled daemon with `ELECTRON_RUN_AS_NODE=1` (`daemon-dependencies.ts:73-90`).
  - It registers the `vonvon` CLI (`main.ts:162`).
  - The daemon keeps running after the app quits (`App.tsx:899` footer).
  - There is no OS service or autostart yet: `service install` throws `SERVICE_UNAVAILABLE` (`cli/commands/service.ts:5`, `host/service.ts:4`), so the daemon does not survive a reboot.

### Path C: terminal-only, like the old bridge
- **Command:** `npm start -w packages/daemon` (= `daemon run`).
- **Behaviour:** in a TTY with no bot, it runs a terminal QR registration (`run.ts:33-36` → `bot/onboarding.ts:89`).
- **Stale command names:** messages in this path still name `feishu-codex-bridge bot init` and `bot list` (`onboarding.ts:81,86,95`). `vonvon` registers no `bot` command (`cli/index.ts`). I counted 48 non-comment `feishu-codex-bridge` strings in `packages/daemon/src`, for example `cli/commands/doctor.ts:75,86`, `admin/service.ts:249` and `card/dm-cards.ts:436,455`.

### Works per code and tests vs proven on a real machine

| Step | Code on main | Real-machine evidence (Codex's Mac) |
|---|---|---|
| daemon start, status, stop | `cli/index.ts:21-46` | #34 Shipping PASS+NOTES (comment 2026-10-10T21:40): real CLI start/stop, 1956 tests |
| Web UI served by the daemon | `server/web-ui.ts`, `cli/commands/open.ts` | #69: 10 live lanes on a *copied* real bot fixture (settings, folder binding, compact, usage, environment, search, reconnect, no-credential rejection); Shipping https://github.com/modelzen/vonvon-bot/pull/69#issuecomment-6104398598 |
| Desktop app | `packages/desktop/src/main.ts`, `electron-builder.yml` | #257: Developer ID-signed arm64 package, **not notarized**; real-window restart, quit, and attach to a CLI-started daemon (https://github.com/modelzen/vonvon-bot/pull/257#issuecomment-6150859802) |
| **Register a new bot by QR** | `server/jobs.ts:61-99`, `admin/service.ts:797-839` | **Not proven end to end.** #69: QR shown and decoded, cancel tested, "不声称完成扫码" |
| Bind a group to a folder | DM card, UI | #24 Live3 (DM card); #69 Live 4 (UI); #257 Lane 9 in the packaged window: 10 groups listed, bound, 本群使用说明 welcome card (https://github.com/modelzen/vonvon-bot/pull/257#issuecomment-6152496794) |
| Codex reply in a group | `bot/handle-message.ts:668-677` → `agent/codex-appserver` | #24 Live4/Live5 (`pwd` completion card, crash recovery); #244 Lane 1: real @Bot gave a `TRANSPORT_OK` card on main and head (https://github.com/modelzen/vonvon-bot/pull/244#issuecomment-6139948672); #249: six scenarios with real `codex-appserver/gpt-6.1-sol` replies, image upload and CardKit updates (https://github.com/modelzen/vonvon-bot/pull/249#issuecomment-6142224658) |
| Claude reply in a group | `agent/claude-agent/*` | None found in #24, #34, #69, #244, #249 or #257 |
| Packaged app, then a Codex turn, in one run | — | Not recorded. #257 bound a group and saw the welcome card but logged no Codex turn from the packaged app |

All real-machine runs used an isolated `VONVON_HOME` and an existing test bot or an isolated copy of it. None used a fresh default `~/.vonvon-bot`, and none used a newly QR-registered bot.

## 2. Which agent path is live today

- **The live path is the bridge-era `agent/` code.**
  - `handle-message.ts:24,668-677` calls `createBackend()` from `agent/index.ts`.
  - The registry there holds `codex-appserver` and `claude-agent` (`agent/index.ts:19-22`).
  - The default is `codex-appserver` (`agent/types.ts:14`).
- **Only three pieces of the new `provider/` layer are live:**
  - The JSON-RPC transport, re-exported for Codex (`agent/codex-appserver/app-server-client.ts:1-2`).
  - The outbound path and image gate (`bot/outbound-files.ts:14`, `card/outbound-images.ts:6`).
  - A `ProcessHost` that the daemon builds at boot, but only for `sweepOrphans` and admission logging plus a test hook (`host/bootstrap.ts:22-30`).
- **Codex child processes do not go through ProcessHost yet.** #281 (V6b 1/14) makes that move. It is open with owner:codex, and its independent Shipping verdict at `a1bc7ee` is PASS+NOTES.
- **Claude Code works per code and unit tests. I found no real-machine evidence.**
  - The `claude-agent` backend is in the catalog and not hidden (`catalog.ts:101-117`).
  - It can be picked per project in the UI (`ui/src/settings/SettingsPanel.tsx:1230,1323`).
  - It uses `@anthropic-ai/claude-agent-sdk`, which bundles its own Claude Code runtime and reuses the local login (`catalog.ts:104-116`).
  - In a dev checkout the SDK is a devDependency (`packages/daemon/package.json:48`) and is installed at `packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk`.
  - Packaged builds leave devDependencies out (`scripts/stage-daemon.mjs:22`), so the user has to download about 265 MB from the 本机环境 page (`EnvironmentPanel.tsx:269`).
  - Tests: 6 Claude test files plus an opt-in live test (`test/claude-agent.live.test.ts:14`, needs `CLAUDE_LIVE=1`).
- **V6b will temporarily take away Claude modes users have on main.** From V6b PR 12 until V6d, Claude `qa`/`write` projects will refuse; on main they run under the Bash sandbox (`docs/plan.md:1417`).

## 3. UI pages in packages/ui and their wiring

Pages are defined in `ui/src/collaboration-model.ts:2`. All of them are wired to the daemon through the injected WebSocket client: `client.settings` ×13 in SettingsPanel, plus `collaboration`, `environment`, `machine`, `run` and `watchSnapshots` in App.tsx. The daemon handlers are in `server/rpc/{admin,collaboration,command,environment,machine,ownership,settings}.ts`.

| Page | Content | Wiring |
|---|---|---|
| Bot / 群聊 (collaboration) | Bot and group lists; details (overview/settings tabs); sessions (`ConversationPanel`); project management (`ProjectPanel`); 添加 Bot QR; join-group dialog | `client.collaboration`, `run({type:"registerAgent"…})` (`App.tsx:283,831-841`) |
| 本机环境 | Codex, Claude and lark-cli detection; install and login jobs; backend download | `client.environment` (`App.tsx:853`) |
| 用量 | Usage (#69 Live 6 showed "未登录") | `client.collaboration` (`App.tsx:855`) |
| 咖啡一下 | Host settings, coffee category | `SettingsPanel scope="host"` (`App.tsx:854`) |
| 应用与启动 | Device, restart daemon, login item (desktop only, refused for now), machine, update and execution settings, hide and quit (desktop only) | `client.machine`, shell capabilities (`App.tsx:856-903`) |
| 状态与诊断 | Version, bot and group counts, data path, logs | Snapshot plus `LogPanel` (`App.tsx:905-`) |

- The plugin-feature slot is empty (`ui/src/features.ts:10`).
- There are 8 UI test files.
- Only #69 and #257 have ever touched `packages/ui` (`git log -- packages/ui`).

## 4. What is missing for a minimal "user can try it" build

**No product PR is required for a trial on the user's own Mac.** What remains:

1. **A build in the user's hands** (Codex, about one session). Build from main at be17859 or any commit before #281 merges, then hand over either the packaged `.app` (Path B2) or the Path A commands. Codex already produced a signed package in #257, at `~/vonvon-review/pr257-20261013/round5/`. Whether it still exists, and whether it matches main at be17859 rather than #257's head `6bb438b`, is unknown.
2. **First end-to-end acceptance of the real user flow.** Never done in v2:
   - QR-register a new bot.
   - Enable it, then bind a group.
   - @ the bot: one Codex turn, then one Claude turn (Claude needs the SDK download in the packaged app).
   - Do it in the default home, from the packaged app.

   If any step fails, that is a bug-fix PR. My estimate is 0–2 PRs; the real number is unknown.
3. **Optional polish, about one small PR.** Replace the 48 bridge-era command strings and the missing `vonvon bot` command (§1 Path C). They only show up in the terminal path, `doctor` and the DM help card, and would confuse a trial user.
4. **Only if #281 merges first: package the holder binary, one PR.**
   - After #281, Codex starts go through `ProcessHost`, which launches `vonvon-holder` on POSIX (`provider/process/holder-channel.ts:125-127`). A missing binary is a spawn error.
   - `npm run build` does not build the holder (`packages/daemon/scripts/build-holder.mjs:2-3`), and neither the staging script nor the npm pack includes it.
   - In #281's branch nothing calls `ProcessHost.available()`, so nothing falls back.
   - Result: packaged desktop and npm builds would fail every Codex turn. I found this by reading the code and did not run it. The planned fix is task V6a-T5 (native helper build and signing pipeline, `docs/program-graph.json`).
5. **Distributing to anyone else's Mac** needs a notarized dmg and a download page (task V5-T11). The dmg and zip targets already exist in config (`electron-builder.yml` mac.target), but the only script is `package:dir`. This is not needed for a trial on the user's own Mac.

**Planned items not needed for a first build:**
- **V5 12/15 (#285), 13, 14, 15:** pre-lock guard, service status, service install/uninstall, open-at-login (split table in #110, comment 6139553795). They only matter for an OS service and autostart. Without them the daemon is not restarted after a reboot.
- **V6b 1–14 plus a deletion phase:** a re-architecture of a Codex and Claude path that already works (split paragraph in #281's `docs/plan.md`). It also opens the Claude qa/write refusal window noted in §2.
- **V6c:** run-card subagent, todo and image areas.
- **V6d:** Claude qa/write confinement.
- **V7a, V7b, V7c:** Cursor, Grok, Pi and custom ACP engines; cross-OS proofs and Windows acceptance.
- **V8 and V9:** importing bridge data and shutting the bridge down. Only needed to migrate the user's existing bots; a trial can use a new bot.
- **V10 and V11:** accounts and the remote relay.

At least 28 PRs remain in the plan (V5: 4; V6b: at least 15; V6c to V11: at least 9, not yet split).

**Pace:** 21 product PRs merged between 2026-10-13T04:18Z (#237) and 2026-10-14T04:43Z (#284). Almost none changed what a user sees: `packages/ui` has 2 commits ever, and `daemon/src/bot` plus `card` have 5.

**Trial caveat:** the user's daily bridge is still running ("在用 Bridge PID 2253", #69 body). The v2 single-instance lock lives in v2's own data root (`core/single-instance.ts:118`), so it cannot detect the bridge running the same Feishu app. Use a newly registered bot, not a copy of a daily one.

## 5. Packaged installer or npm package

- **npm package (#248, merged):** the tooling builds `vonvon-bot-0.7.0.tgz` locally.
  - Command: `npm run pack:vonvon-bot -- --out <dir outside the repo>`. It requires a clean tree (`scripts/pack-vonvon-bot.mjs:11,20`).
  - Install: `npm install -g <tgz>`. The #248 Linux smoke test returned `{"ok":true,...}`.
  - **Not published:** `npm view vonvon-bot` returns E404.
- **Desktop packaging (#257, merged as 54637c9):** electron-builder config with mac dmg/zip, win nsis and linux AppImage targets.
  - Codex built a Developer ID-signed, un-notarized arm64 app on its Mac and accepted it (comments 6150859802, 6152496794).
  - `desktop-update.json` is `{}`, so the update check reports "没有配置签名更新源" (#257 body).
  - **Not published:** GitHub releases = 0 (`gh api repos/modelzen/vonvon-bot/releases --jq length`). `.github/workflows/ci.yml` uploads no artifacts.
- **Local `dist/` on JP-VPS:** present for all 5 workspaces, built 2026-10-14 04:57 UTC, after be17859's commit time of 04:43 UTC. There is no Electron binary and no holder binary, so nothing here can be handed to the user as is.

## Unknowns

- Whether QR registration of a new PersonalAgent bot works end to end, and whether Feishu then needs manual scope or publish steps. The code points to a scope link (`onboarding.ts:104-107`), but no v2 run completed a scan.
- Whether Claude turns work on main on a real machine.
- Whether the old 0.7.0 desktop app, if it is still installed on the Mac, clashes with the new app's single-instance lock or app ID (`com.vonvon.bot.desktop`).
- Whether Codex's signed #257 package still exists on the Mac.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：I re-checked 13 claims: 9 hold, 4 are overstated, none is wrong.

**What holds:**
- Nothing is distributed: no npm package, no GitHub release, no CI artifact.
- No PR has asked the user to try anything. A keyword scan of comments found only the Actions budget request, and AGENTS.md:37 tells Codex not to wait for the user.
- The live path is the bridge-era `agent/` code, with Codex as the default.
- In v2 there is no real Claude turn and no completed QR scan.
- #281 would break Codex turns wherever the holder binary is missing. That gap is recorded nowhere in the PR, its known gaps, or its PASS+NOTES verdict.
- The pace numbers and the count of 28+ remaining PRs check out.

**What is overstated:**
- **"Codex has seen every step working":** each step was seen once, in a different PR at an older head, with test or copied bots. It was never one run and never at be17859. The turn-path code has changed by only 3 lines since #249, the last real Codex turn, so the risk is low, but it is not proven.
- **"Replace 48 bridge strings":** most of those occurrences are compatibility identifiers that must stay. Only about 10-18 are visible to users, and some sit in commands main does not register.
- **"#257's signed package is at a known path":** that path holds evidence, not the app. Any trial build must be rebuilt from be17859.

**What the report missed that matters for the decision:**
- **v2 is mostly the bridge the user already runs.** The daemon was copied from feishu-codex-bridge 446b2a4. The QR wizard, onboarding and Claude backend are still byte-identical to it, and the UI is the old 0.7.0 one. A trial build today would look like the bridge plus the old management UI.
- **A product shape is already written down,** in docs/architecture.md:7-9, by agents on 2026-10-10. It is unknown whether the user ever reviewed it.
- **#281's breakage also hits a plain checkout.** `npm run build` wipes the holder binary, so `build:holder` (which needs a C compiler) has to run after every build. #281 can also merge without the user being asked, so the chance to cut a trial build before it may close soon.
- **The CI facts bear on the user's first question.** Windows and macOS jobs already run only at the frozen head. In the last 9 full runs, Windows took 10-14 minutes against about 5 for Linux, and 5 of those 9 Windows jobs failed. On 2026-10-13 the $10/month Actions budget ran out and blocked Windows CI; the user then raised it to $20.


### 逐条复查

- **说过头了**：The code on main covers the full loop on a Mac, and Codex has seen every step working on its Mac during PR acceptance, with one exception (QR scan).
  - 依据：Each step was seen in a different PR at a different head, never as one run, and never at be17859. #24: Live3 bind, Live4 pwd card, Live5 crash recovery. #69: 10 live lanes on copied fixtures. #244 comment 6139948672: TRANSPORT_OK. #249 comment 6142224658: six scenarios with gpt-6.1-sol. #257 comment 6152496794: Lane 9 bind plus welcome card, no Codex turn. The last real Codex turn is #249, merged 2026-10-13T09:45Z. Sixteen PRs merged after it (gh pr list --state merged). The turn path barely changed since then: `git diff --stat 9b065b5 be17859 -- src/agent src/bot src/card src/provider/transport` shows only supervisor.ts, +1/-2. The report's own table also lists Claude turns and packaged-app-plus-Codex-turn as unproven, so 'every step' is true only for the Codex path.
- **属实**：There is no published npm package, no GitHub release and no CI artifact.
  - 依据：`npm view vonvon-bot` returns E404. `gh api repos/modelzen/vonvon-bot/releases --jq length` returns 0. `.github/workflows/ci.yml` has no upload-artifact step. docs/ci-costs.md last paragraph: '当前 main CI 没有新增 artifact 上传'. The daemon package itself is `"private": true` (packages/daemon/package.json).
- **属实**：No PR so far has asked the user to try anything.
  - 依据：I scanned the 477 issue and PR comments since 2026-10-10 (gh api issues/comments?since=2026-10-10, paginated) for 请用户/用户试/让用户/需要用户/用户确认/用户决定. The only user-directed asks were about the Actions budget (#205 comment 6155850614, #271 comment 6155548795). PR bodies were not scanned exhaustively. This matches the process rule: AGENTS.md:37, added by #39 and merged 2026-10-10T12:22Z, says Codex merges and continues '不在版本边界等用户确认'.
- **属实**：The live agent path is the bridge-era agent/ code with Codex as default. Only three pieces of provider/ are live (transport, outbound gate, a boot-time ProcessHost), and Codex children do not go through ProcessHost yet.
  - 依据：agent/index.ts:19-22 registers codex-appserver and claude-agent. agent/types.ts:14 sets DEFAULT_BACKEND_ID = 'codex-appserver'. handle-message.ts:24 and :674 call createBackend. Outside src/provider, the only provider/ importers are bot/outbound-files.ts, card/outbound-images.ts, agent/codex-appserver/app-server-client.ts:1-2 (re-export) and host/bootstrap.ts. bootstrap.ts:22-31 only sweeps and logs, plus the VONVON_TEST_SPAWN_FAKE_CHILD hook. On main, ProcessHost construction and sweepOrphans do not touch the holder binary (process-host.ts:179-190, 407-420).
- **属实**：#281 would break every Codex turn in packaged desktop and npm builds unless the holder binary is packaged; nothing in #281 calls ProcessHost.available().
  - 依据：This comes from reading the code; I did not run it. In #281 (head a1bc7ee), `AppServerClient.connect()` calls `this.opts.host.spawn('codex', ...)` (diff of provider/transport/jsonrpc.ts). The POSIX setUp calls `spawnPosixHolder(this.options.holderPath)` (process-host.ts:227), which spawns the binary directly (holder-channel.ts:124-126). `git grep '\.available()' pr/281 -- packages/daemon/src` returns nothing. stage-daemon.mjs, pack-vonvon-bot.mjs, package-tools.mjs, desktop/build.mjs and electron-builder.yml never reference the holder. build-holder.mjs:2-3 says it is not part of `npm run build`. The risk is not recorded anywhere: neither #281's body nor its Known gaps mention it, and neither does its PASS+NOTES verdict (comment 6159909313).
- **属实**：Claude Code works per code and unit tests, but no real Claude turn appears in any v2 acceptance (#24, #34, #69, #244, #249, #257).
  - 依据：I grepped the bodies and comments of those six PRs for claude-agent, CLAUDE_LIVE and Claude turn or reply: zero hits. The other 'Claude' mentions are handoffs, the #250 TLS fix, and 'hidden Claude SDK children' notes in #34. The tests are 6 files plus test/claude-agent.live.test.ts, which skips unless CLAUDE_LIVE=1. Two details the report leaves out. claude-agent/backend.ts has the same sha256 (d87b8a3b…) as its import-core.json entry, so it is byte-identical to bridge 446b2a4. And in packaged builds the SDK comes from an on-demand `npm install` (agent/installer.ts:27 spawns 'npm'), because stage-daemon.mjs:22 stages only dependencies and optionalDependencies, and tsup.config marks the SDK external.
- **属实**：Nobody has finished registering a new bot by QR scan end to end in v2 (#69: '不声称完成扫码').
  - 依据：#69 body line 13: QR displayed and decoded, cancel tested, '按 #79 条款不要求完成外部扫码，也不声称完成扫码'. The report misses that bot/wizard.ts (sha256 97a81252…) and bot/onboarding.ts (e90a780b…) match their import-core.json hashes, so both are unchanged bridge 446b2a4 code. `git log` shows only #24 touching them. The QR path is therefore the bridge's own code, not new v2 code. wizard.ts:61 also gives each newly registered Feishu app a description ending in '（feishu-codex-bridge）'.
- **说过头了**：There are 48 non-comment `feishu-codex-bridge` strings in packages/daemon/src, and an optional polish PR should replace these 48 bridge-era command strings.
  - 依据：`grep -rn feishu-codex-bridge packages/daemon/src` finds 59 occurrences, and about 46 lines remain after dropping comment-led lines. Many of these are compatibility identifiers that must not be replaced. Examples: service/control.ts:6-10,55,91,122 (the bridge launchd label, systemd unit, Run key and process detection), config/data-compatibility.ts, legacy-data-root.ts and data-root-migration.ts (the legacy ~/.feishu-codex-bridge root), the cli-bridge/hooks.ts regexes, clientName and CLAUDE_CODE_ENTRYPOINT. About 18 lines are user-facing command hints. Several of those sit in commands that main does not register: cli/index.ts registers no bot, doctor or update command, and `doctor` is only added in #281. The doctor strings are therefore unreachable on main.
- **属实**：Pace: 21 product PRs merged between #237 (2026-10-13T04:18Z) and #284 (2026-10-14T04:43Z). packages/ui has 2 commits ever, and daemon/src/bot plus card have 5.
  - 依据：`gh pr list --state merged` shows 23 merges in that window, which is 21 once #240 and #277 (handoff tooling) are excluded. #284 is test-only. `git log -- packages/ui` lists 54637c9 (#257) and 21a21fa (#69). `git log -- src/bot src/card` lists 5 commits (#24, #34, #249, #268, #276). The #268 and #276 changes are 1-2 lines in supervisor.ts.
- **属实**：At least 28 PRs remain (V5: 4; V6b: at least 15; V6c to V11: at least 9).
  - 依据：The arithmetic matches docs/program-graph.json versions (V6c, V6d, V7a, V7b, V7c, V8, V9, V10 and V11 are unsplit, which makes 9) and #110's V5 15-PR split, where 12-15 remain and 12 is #285, still open. The V6b count of '14 PRs and a deletion step' exists only in #281's branch (plan.md *Split.* paragraph). It is not on main. The total counts open #281 and #285. The graph has 67 tasks and is stale: its V5 node still points at #276 as 'current 11/15' and V6a at #272, though both have merged.
- **属实**：From V6b PR 12 until V6d, Claude qa/write projects will refuse; on main they run under the Bash sandbox (docs/plan.md:1417).
  - 依据：main docs/plan.md:1417: 'From V6b until V6d merges, existing Claude qa and write projects refuse with unverified-combination; on main they ran under the Bash sandbox.' The 'PR 12' opening point comes only from #281's plan.md: 'The known window opens when PR 12 merges.' catalog.ts:114 lists supportedModes ['qa','write','full'] on main.
- **说过头了**：Codex already produced a signed package in #257, at ~/vonvon-review/pr257-20261013/round5/.
  - 依据：#257 comment 6150859802 says that directory holds evidence: signature and asar digests, receipts, screenshots and a renderer video. It does not say the .app is stored there. The package was built at head fd9058a and later transferred to 6bb438b by hash comparison (comment 6152496794). Several PRs touching daemon and service code have merged since #257 (#268, #270, #271, #274, #275, #276, #284).
- **属实**：No OS service or autostart yet: `service install` throws SERVICE_UNAVAILABLE, so the daemon does not survive a reboot.
  - 依据：host/service.ts:4 defines SERVICE_UNAVAILABLE. cli/commands/service.ts:4-6 always throws it. cli/index.ts:50-56 wires install and uninstall to it. One related detail: `vonvon open` starts the daemon itself when none is running (cli/commands/open.ts:18), so Path A's separate `daemon start` step is optional.

### 正文遗漏的事实

- The v2 daemon is a one-time seed of the bridge the user already runs. PROVENANCE.md:3 says it was imported from feishu-codex-bridge at 446b2a4. wizard.ts, onboarding.ts and claude-agent/backend.ts still match their import-core.json sha256 byte for byte. So a trial build would mostly show the bridge's Feishu behaviour plus the old 0.7.0 management UI (#69: '保留原样式'). For a user asking 'what will it look like', that is the honest answer for today.
- A written product shape already exists. docs/architecture.md:7-9 says chat happens in Feishu; desktop and web are only for setting up bots, groups, sessions and the local environment; one group is one project folder. Accounts, machines and the encrypted relay come in V10/V11 (architecture.md diagram; program-graph V10, V11). Agents wrote it in commit 20b3224 on 2026-10-10. Whether the user ever reviewed it is unknown, and the user says they never discussed the product shape.
- The process rule blocks heavy user involvement. AGENTS.md:37, from #39 merged 2026-10-10T12:22Z, lets Codex merge and continue without waiting for the user at version boundaries. Showing the user intermediate builds would need this rule changed.
- #281 also breaks the dev checkout (Path A), not only packaged builds (read from config, not run). The holder path is dist/native/<platform>-<arch>/vonvon-holder (process-host.ts:133-135, build-holder.mjs:11). The tsup cli config has `clean: true` on outDir 'dist', so every `npm run build` deletes the holder. After #281, the user would need `npm run build:holder -w packages/daemon` after every build, plus a C compiler (Xcode CLT on Mac). Otherwise every Codex turn fails.
- The window for cutting a build before #281 may close without anyone asking. #281 is open with owner:codex, PASS+NOTES at a1bc7ee (comment 6159909313), and no frozen label (gh pr list). Under AGENTS.md:37 Codex can freeze and merge it on its own. The packaging gap is not recorded in #281's body, its Known gaps, or the verdict.
- Context for the CI question, outside this report's scope. Full Windows and macOS jobs already run only at a frozen head or on manual dispatch (ci.yml; docs/ci-costs.md table). In the last 9 full runs, Windows took 570-858 s against 270-351 s for Linux, and 5 of 9 Windows jobs failed: #276 three times (runs 38494699651, 38498165268, 38501062805) and #285 twice (38509583067, 38512080737). #284 was a test-only platform-timeout fix. On 2026-10-13 the org Actions budget ($10/month) hit 100% and blocked Windows CI for #271 (#205, comment 6155851056). The user then approved $20/month (#205, 2026-10-13T22:04Z).
- Packaged Claude needs `npm` on the daemon's PATH. The SDK download spawns 'npm' (agent/installer.ts:27). A packaged app launched from Finder may not inherit a PATH that contains npm, and Codex CLI detection has the same question. This is unverified and belongs on the trial checklist.
- The old 0.7.0 desktop app line is still open as PRs #2 and #9-#19 (gh pr list --state open). The v2 UI is a port of it (packages/ui/src/reference). The user may already have seen this UI there; unknown.
- Minor citation slips. The /new and @ hint is at run.ts:67-68, not 69-70. #34's Shipping comment 6102463723 reports 'Windows daemon tests 1,949 passed and 36 skipped', not 1956 tests. The 'PR 12' detail comes from #281's branch, not main's plan.md:1417.
