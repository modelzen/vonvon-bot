# Resource inventory and proposals (read-only, checked 2026-10-14 around 05:30Z)

## Main findings

1. **The Tencent host is no bigger than JP-VPS, and it could not be reached today.** It has 4 CPU, 3655 MiB RAM, 1024 MiB swap and runs production services (`docs/native-acceptance-hosts.md:16-17`). From JP-VPS, TCP connections to `<腾讯云生产主机 IP>` on ports 22 and 443 both timed out. WebFetch of `https://bridge.vonvon.cc/` returned `connect ECONNREFUSED <腾讯云生产主机 IP>:443`. `vonvon.cc`, `bridge.vonvon.cc` and `notelet.vonvon.cc` all resolve to that IP (`getent hosts`). I can't tell whether the site is down or blocking these sources.
2. **`win-wuyin` is very likely the Alibaba Wuying cloud PC, and it has already joined the tailnet once.** Its Tailscale hostname is `<设备主机名>`. It was created `2026-10-12T08:29:40Z`, last seen `2026-10-12T10:45:02Z`, and is offline now (`tailscale status --json`). The link to Wuying is my inference from the name and the timing. I did not verify it.
3. **A Feishu bot you can actually talk to has existed since 2026-10-10.** PR #24 (the V2 bot-runtime port) records real-Feishu passes for DM menu, group binding, a Codex `pwd` turn, crash recovery and reconnect. Evidence is under `~/vonvon-review/V2-pr24-baf3cee` (`gh pr view 24`). Since then 53 PRs have merged (10-10: 13, 10-11: 7, 10-12: 7, 10-13: 20, 10-14: 6, from `gh pr list --state merged`). Even so, the README still describes only V1 (`README.md:3`), and the daemon UI listens only on loopback (`packages/daemon/src/server/http.ts:184`, `packages/daemon/src/cli/commands/open.ts:11`).
4. **JP-VPS can already post to Feishu.** `lark-cli auth status` shows both bot and user identities `ready`, with scopes that include `im:message`, `im:message.send_as_user`, `drive:file:upload` and `docx:document:create`.
5. **Windows CI costs very little.** A full run is about $0.13 (`docs/ci-costs.md:50`). The value of a Windows machine is the desktop-only checks CI can't do, not saving CI money.
6. **The Mac mini carries everything, while the MacBook Air sits unused.** The Air is online but has no Paseo daemon (`paseo ls --host <MacBook Air 的 Tailscale IP>:6767` returned `ECONNREFUSED`).
7. **All tailnet traffic goes through a relay.** Pings to `<mac-mini>` and `<macbook-air>` go via DERP `hkg` at 226–796 ms, with "direct connection not established" (`tailscale ping`).

## 1. Resource table

| Resource | OS | Specs | Reachability (2026-10-14) | Current role | Spare capacity |
|---|---|---|---|---|---|
| **JP-VPS** (10.0.0.10) | Ubuntu 24.04.5 x86_64 | 2 CPU, 3.8 GiB RAM, **0 swap**, 48 G disk with 27 G free (`nproc`, `free -h`, `df -h`) | This host | Claude designs and implements. Paseo 0.11.1 with `claude` and `pi` enabled (`paseo provider ls`). Three idle Claude agents: PR #284 (test timeouts), #281 (Codex children onto ProcessHost), #285 (Pre-lock guard) (`paseo ls`). | Almost none. 2.3 GiB was in use while idle (Paseo 467 MB, each claude process 154–454 MB, `ps`). Measured `npm ci` 470 s and test 257 s (memory note `vonvon-two-host-setup.md`). |
| **Mac mini** (<mac-mini>, 10.0.0.11) | macOS 26.7 ARM64, Xcode 27.0 (`docs/self-hosted-ci.md:11`) | RAM and CPU are not recorded anywhere I could read: **unknown** | Tailscale via DERP hkg, 238–247 ms | Codex reviews, verifies and ships. Paseo 0.11.2 runs inside `/Applications/Paseo.app`, provider codex only, relay disabled (`paseo status --host`). Agents: PR #285 idle, **PR #281 in `error`**. It also hosts the self-hosted runner `mac-mini-isolated` in account `ci-user` (`self-hosted-ci.md:7`) and the daily bridge in `clay` (`native-acceptance-hosts.md:8`). | Paseo browser tools are off by default (`references/paseo-0009/public-docs/browser.md`). The `<Mac 测试用户>` test context is not logged in (OP-2 #206, open). Fallback VM F does not exist (`native-acceptance-hosts.md:410`). |
| **MacBook Air** (<macbook-air>, <MacBook Air 的 Tailscale IP>) | macOS | unknown | Online, relayed, 226–796 ms | None found | The whole machine |
| **win-wuyin** (<win-wuyin 的 Tailscale IP>) | Windows | unknown | Offline since 2026-10-12 10:45Z | None. `AGENTS.md:29` says "没有 Windows 原生环境". OP-4 #208 (Windows host decision) is open. | The only Windows desktop available |
| **Tencent Lighthouse** <腾讯云生产主机 IP> | OpenCloudOS 9.6 x86_64 | 4 CPU, 3655 MiB RAM, 1 GiB swap, 40 G disk with 32 G free (`native-acceptance-hosts.md:16`) | Not a tailnet peer. Ports 22 and 443 timed out from JP-VPS; 443 refused for WebFetch. SSH access exists from the Mac mini. | Production: nginx, `vonvon-account.service` on 127.0.0.1:8787, bt, site_total, postfix (`native-acceptance-hosts.md:17`). Domains account, api, bridge and notelet `.vonvon.cc` (`tencent-resources.md:7`). Planned Linux acceptance host, but the test user does not exist yet (`native-acceptance-hosts.md:18`). | About 2.7 GiB free and load 0.07 at last sample (`tencent-resources.md:5`). Tests would be capped at `MemoryMax=1536M` (`native-acceptance-hosts.md:36`). |
| **Alibaba cloud PC** | Windows (presumed) | unknown | See win-wuyin | — | — |
| **iPhone 15 Pro and "node" (iOS)** | iOS | — | Both offline (last seen 10-10 and 10-14 01:30Z) | None | Paseo mobile can connect "directly with Tailscale" (`references/paseo-0009/public-docs/configuration.md`). Feishu mobile is there for acceptance. |
| **Tailscale** (<tailnet>, client 1.102.4) | — | JP-VPS nearest DERP is tok at 1.5 ms. UDP works, no port mapping (`tailscale netcheck`). | Every peer goes through the hkg relay | Paseo traffic between hosts | Direct paths are not established |
| **lark-cli 1.0.97** (JP-VPS) | — | App `cli_aac99…（已截断）`. User `<飞书用户名>`. Refresh token expires `<约 7 天后>`. | Ready | Not part of the pipeline (not mentioned in `AGENTS.md`) | Sending messages, uploading to Drive, creating docs and slides. **Unknown:** whether this is the daily bridge's App ID. |
| **GitHub Actions** | — | Hosted Linux $0.006/min, Windows $0.010/min, self-hosted Mac $0 (`ci-costs.md:29-31`). 3000 free min/month (`:52`). | — | Full CI only on `frozen` heads | The self-hosted runner can read the screen and create AppKit windows (`self-hosted-ci.md:9`) |
| **Repos** | — | `feishu-codex-bridge` is published as `@modelzen/feishu-codex-bridge` 0.6.14 (`npm view`, modified 2026-09-24). `vonvon-bridge-legacy` has `deploy/tencent` files (`docs/deployment/account-service.md:7,253-254`). `vonvon-platform` and `vonvon-site` are private; their last local commits are 2026-09-18. `references/paseo-0009` holds the Paseo source. | Local | Reference only | `deploy/tencent` is a ready starting point for V10 (accounts and machine list) |

## 2. Proposals, with risks and unknowns

**P1. A Feishu demo bot that runs `main` on the Mac mini, so you can try the product.**
- **How:** Codex keeps a `vonvon daemon run` process on the Mac mini, in a dedicated macOS user rather than `clay`. `clay` holds the daily bridge (`native-acceptance-hosts.md:8`), and the plan already requires dedicated contexts for the V8 import lanes (`docs/plan.md:1804`). After each merge, Codex moves the demo to the new `main` and posts "what changed, what to try" in Feishu. You test it from your phone.
- **Risks:**
  - Two processes on one bot split its events (`native-acceptance-hosts.md:406`, `docs/roadmap.md:113`). The demo bot therefore needs its own App ID, separate from both the daily bridge and the V8 acceptance test bot, or the V8 lanes have to be scheduled around it.
  - `main` may break partway through the program. The V6b cut-over of the Codex engine (#281) is in flight.
  - Each update costs Codex quota.
- **Unknown:**
  - Whether today's `main` still passes the #24 Live2–4 flow (DM menu, group bind, `pwd` turn). I found no later live evidence.
  - Which "saved inactive Bot" V2 used (`plan.md:330`).

**P2. lark-cli as the delivery channel for handoff summaries, screenshots and demo notes.**
- **How:** JP-VPS posts with the bot identity rather than `send_as_user`, which would appear to come from you. Codex posts screenshots from the Mac, where the real lark-cli is installed (memory note `vonvon-mac-real-lark-cli.md`).
- **Risks:**
  - `AGENTS.md` says "进度只看 issue #122 看板和 PR 状态。不做本地进度页…定时刷新". Reports must be tied to events (a merge, a demo update), not a recurring progress page, and the rule needs an explicit amendment.
  - Never run `lark-cli event consume` on an app the daily bridge also uses.
  - The user refresh token expires 2026-10-21 if unused.
- **Unknown:** whether the Mac's lark-cli is logged in, and whether its App ID is the daily bridge's.

**P3. Use the Mac mini's GUI to work around Codex having no Computer Use through Paseo.**
- **How:**
  - Turn on Paseo browser tools (`daemon.browserTools.enabled` plus Paseo tools). They drive real tabs inside the Paseo desktop app (`public-docs/browser.md`), and Paseo.app is already the daemon host on the Mac. Codex could then open the Vonvon web UI on the Mac's loopback and take screenshots.
  - For Electron windows and the tray, use `screencapture` from the CLI, or a frozen-head job on the self-hosted runner, which has proven screen access (`self-hosted-ci.md:9`).
- **Risks:**
  - Browser tools see logged-in browser state (the doc warns about this).
  - `self-hosted-ci.md:65` says no new build-artifact uploads, so screenshots from CI would change that policy.
- **Unknown:**
  - The feature docs come from the `paseo-0009` snapshot, while the Mac runs 0.11.2.
  - Whether the Paseo Helper has Screen Recording or Accessibility permission (TCC).

**P4. The MacBook Air as your demo seat.**
- **How:** The cheapest route is Screen Sharing from the Air to the Mac mini over Tailscale, together with P1, so no build has to move. The alternative is an unsigned `package:dir` build (`packages/desktop/package.json`). Signed, notarized builds arrive only with V5-T11 #146.
- **Risks:** `AGENTS.md` forbids copying `dist`, `build` or `release` between machines. That rule is about dev sync, but it needs your explicit OK for demo builds. Gatekeeper will block unsigned apps. The Air sleeps, and its relay latency spikes (796 ms seen).

**P5. win-wuyin for occasional Windows desktop batches, alongside per-PR Windows CI.**
- **How:** Keep hosted Windows CI; it's about $0.10 per run (`ci-costs.md:50`). Use win-wuyin for the deferred "Windows 未验" items: autostart after logon, Electron window, tray (`AGENTS.md:29`). It could also host V7c (cross-OS proofs and Windows acceptance), which needs Codex and Claude Code installed on Windows (#208).
- **Risks:**
  - A cloud PC may power off when you disconnect, so Tailscale must run unattended as a service.
  - Wuying images may restrict installs. A web search found no Wuying documentation that covers Tailscale ([Wuying help](https://help.aliyun.com/en/edsp/use-image-community), [Tailscale on Windows](https://tailscale.com/kb/1022/install-windows)).
  - A virtual display may behave differently from a real desktop for tray and autostart.
  - On 2026-10-13 you said there was no Windows host (memory note `vonvon-testing-split.md`). That decision would need reopening.
- **Unknown:** specs, power policy, and whether a Paseo daemon runs on Windows. The Paseo CLI mentions Windows pipes, but I did not verify daemon support.

**P6. Tencent host: not a build box. Maybe the V10/V11 cloud host (accounts and encrypted relay).**
- **Build box:** No. It has about the same RAM as JP-VPS, test work would be capped at 1.5 GiB, and it carries production.
- **Cloud host:** This is OP-5 #209 (cloud deployment platform). It already has nginx, the domains, the account service and the `deploy/tencent` templates.
- **Linux acceptance:** Moving it to a disposable Linux VM would drop most of the 685-line containment protocol in `docs/native-acceptance-hosts.md`, which exists only because this host is production. The OrbStack VM F command at `:423` was never run.
- **Risks:** Shared with production. Today's 22/443 failures are unexplained. A mainland host may need ICP filing for new subdomains (unknown), and GitHub/npm downloads from it may be slow.

**P7. JP-VPS: add swap or more RAM.** It has 0 B swap, and two sessions share 3.8 GiB, already enforced with `flock /tmp/vonvon-heavy.lock` (memory note `vonvon-heavy-lock.md`). Unknown: whether `operator` has sudo.

**P8. iPhone: Paseo mobile over Tailscale** to watch both hosts' sessions. Unknown: whether the daemons have a password set. The Paseo docs advise one before binding beyond localhost (`public-docs/web-ui.md:81-91`).

**P9. Historical repos.** `feishu-codex-bridge` is the behavior baseline your users already know, so turn its features into the acceptance list for the product shape. Reuse `vonvon-bridge-legacy/deploy/tencent` for V10. Note that V10 deliberately does not copy legacy's login-bound session and device model (`plan.md`, V10 *Device contract*).

## 3. What you need to do to activate each proposal

| Proposal | Needed from you |
|---|---|
| P1 | Create or name a Feishu test app whose App ID differs from the daily bridge and the V8 test bot, or approve the one #24 used. Name the chat. Pick the Mac account for the demo; `<Mac 测试用户>` needs a GUI login (OP-2 #206). Approve Codex time per merge. |
| P2 | Name the target chat. Confirm what `cli_aac99…（已截断）` is. Amend the `AGENTS.md` tracking rule to allow Feishu reports tied to events. Log in to lark-cli again before 2026-10-21 if it sits idle. |
| P3 | Turn on Paseo browser tools and Paseo tools on the Mac host, and keep Paseo.app open. If you want screenshots, grant Screen Recording to Paseo Helper. |
| P4 | Enable Screen Sharing on the Mac mini, or allow unsigned demo builds on the Air. |
| P5 | Confirm that win-wuyin is the Wuying PC. Set it to stay powered and run Tailscale unattended. Install Node 22, Git, Codex and Claude Code with accounts. Decide OP-4 #208 and the 10-13 "no Windows host" call. |
| P6 | Check why <腾讯云生产主机 IP> refused or timed out today. Decide OP-5 #209 and the ICP status. Decide whether Linux acceptance should move off the production host. |
| P7 | Grant sudo for a swap file, or upgrade the VPS plan. |
| P8 | Install Paseo mobile, set daemon passwords, and pair. |

Open unknowns: Mac mini and MacBook Air specs, Wuying power policy, the identity of the lark-cli app, whether current `main` still passes the #24 live flow, why the Mac's PR #281 agent is in `error`, and the Tencent outage.


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：The report's measurements are mostly accurate. Hardware, tailnet state, Paseo agent states, the Tencent unreachability, the #24 live passes, the merge counts and the README/loopback facts all re-checked. Its strategy layer has three real problems. First, P2 (Feishu/lark-cli as the dev reporting channel) goes against a decision the user made today, recorded in memory/no-feishu-dev-channel.md: use GitHub or Linear, not Feishu. Second, 'no later live evidence' and the implied 'nothing to try' are wrong: #34, #69 and #257 carry live Feishu or real-window evidence, and a signed Electron package and the daemon web UI already run on the Mac. The gap is that the user cannot reach them, not that they don't exist. Third, P8's password unknown is already known (neither daemon has auth, by the user's choice), and adding passwords would break handoff.mjs. The report also left out the facts that best explain the slowness: V5, V6a and V6b fanned out to about 39 PRs against an estimate of 14 for V5-V11; #281 has been handed off 5 times; there are 4.7k lines of process docs; and the board shows only V1-V4 done. Several citations point to the wrong file (connectivity.md vs configuration.md, the .audit path, the legacy repo doc), and the $0.13 vs $0.10 Windows CI figures conflate the full run with its Windows part.


### 逐条复查

- **属实**：F1: Tencent host has 4 CPU, 3655 MiB RAM, 1 GiB swap, carries production; from JP-VPS ports 22 and 443 timed out; WebFetch of bridge.vonvon.cc got ECONNREFUSED; the vonvon.cc domains resolve to <腾讯云生产主机 IP>.
  - 依据：docs/native-acceptance-hosts.md:16-17 give the specs and production services. Re-run at about 05:40Z: getent shows vonvon.cc, bridge, notelet, account and api.vonvon.cc all at <腾讯云生产主机 IP>. Bash /dev/tcp to ports 22, 80 and 443 all hit the 8 s timeout (rc=124), and curl to https://bridge.vonvon.cc/ timed out at 15 s. WebFetch returned 'connect ECONNREFUSED <腾讯云生产主机 IP>:443'.
- **属实**：F2: win-wuyin (Tailscale hostname <设备主机名>) joined the tailnet at 2026-10-12T08:29:40Z, was last seen at 10:45:02Z and is offline; it is probably the Alibaba Wuying PC.
  - 依据：tailscale status --json: HostName <设备主机名>, DNSName win-wuyin.<tailnet>.ts.net, OS windows, Online False, Created 2026-10-12T08:29:40.93Z, LastSeen 2026-10-12T10:45:02.1Z. The user's own message fits the inference: they have an Alibaba cloud PC that is hard to reach because the VPN is hard to set up. The Wuying identity is still unverified.
- **属实**：F3a: PR #24 (the V2 bot-runtime port) recorded real-Feishu passes; 53 PRs have merged since 10-10 (13/7/7/20/6).
  - 依据：gh pr view 24: merged 2026-10-10T07:58Z, Live1-Live10 PASS, including Live2 DM menu, Live3 bind, Live4 pwd turn, Live5 crash recovery and Live8 reconnect, evidence root ~/vonvon-review/V2-pr24-baf3cee. gh pr list --state merged gives 10-10:13, 10-11:7, 10-12:7, 10-13:20, 10-14:6, total 53. That is every merged PR in the repo; nothing merged before 10-10.
- **有误**：P1 unknown: 'I found no later live evidence' after #24, and the later framing that there is nothing to try (only loopback, README V1).
  - 依据：PR #34 (V3 WebSocket API, merged 10-10T21:40Z) records 'new head live lane 1-9 PASS', with lanes on a connected bot (.audit/v3-cf2-connected). PR #69 (V4 web client served by the daemon, merged 10-11T01:58Z) records Live 1-10 PASS, including Live 4 directory binding against a real group ID with the bot in the group. PR #257 (V5 5/15, merged 10-13T18:56Z) shipped an Electron window, tray, updater and packaging. Codex's comments on #257 show a real-window restart PASS and a Developer ID-signed packaged app passing the lane-10 update check on the Mac.
- **属实**：F3b: README describes only V1; the daemon UI listens only on loopback (http.ts:184, open.ts:11).
  - 依据：README.md:3 begins 'V1 contains the `@vonvon/protocol` package'. packages/daemon/src/server/http.ts:184 has server.listen(port, '127.0.0.1', ...). packages/daemon/src/cli/commands/open.ts:11 rejects any listen value that is not 127.0.0.1.
- **说过头了**：F4: JP-VPS can already post to Feishu; bot and user identities are ready, with scopes im:message, im:message.send_as_user, drive:file:upload, docx:document:create; refresh token expires <约 7 天后>.
  - 依据：lark-cli 1.0.97 auth status: appId cli_aac99…（已截断）, bot.status ready, user.status ready, refreshExpiresAt <约 7 天后>. All four named scopes are in the 226-entry user scope list. auth status lists no scopes for the bot, so whether the bot identity can send (and to which chats) is not shown. The access token itself expires <约 2 小时后>.
- **有误**：P2: use lark-cli as the delivery channel for handoff summaries, screenshots and demo notes.
  - 依据：Memory note /home/operator/.claude/projects/-home-ops-vonvon-vonvon-bot/memory/no-feishu-dev-channel.md (modified 2026-10-14T05:23:51Z) records that the user rejected Feishu/lark-cli messages and running feishu-codex-bridge as a dev channel: '不要用飞书或者飞书CodeX Bridge'. They want a dev tool such as Linear, or GitHub PRs and issues. Feishu stays 'only as the product's own surface and the real test target.' This note is not linked from MEMORY.md, which may be why the report missed it.
- **说过头了**：F5/P5: Windows CI costs very little; a full run is about $0.13 (F5) and about $0.10 per run (P5), both citing ci-costs.md:50.
  - 依据：docs/ci-costs.md:50: '5 × $0.006 + 10 × $0.010 ≈ $0.13' is the full Linux+Windows run. The Windows part is $0.10, so the two figures cite one line for different things. docs/ci-costs.md:58 also records that 2026-10-12 run failures mentioned a payment failure and the spending limit, and recommends confirming the payment method first.
- **属实**：F6: The MacBook Air is online but runs no Paseo daemon.
  - 依据：tailscale status lists <macbook-air> <MacBook Air 的 Tailscale IP> as active, relayed via hkg. `paseo ls --host <MacBook Air 的 Tailscale IP>:6767` returned 'connect ECONNREFUSED <MacBook Air 的 Tailscale IP>:6767'. Its role is otherwise unknown; the user did not list the Air among their resources.
- **属实**：F7: All tailnet traffic is relayed through DERP hkg; direct connections are not established; JP-VPS nearest DERP is tok.
  - 依据：tailscale ping -c 3: <mac-mini> via DERP(hkg) 643/233/232 ms, <macbook-air> via DERP(hkg) 643/262/2859 ms, both 'direct connection not established'. netcheck at 05:38Z: UDP true, PortMapping empty, nearest DERP Tokyo 1.7 ms, hkg 54.5 ms.
- **说过头了**：Table/P8: JP-VPS runs three idle Claude agents for PR #284, #281 and #285; on the Mac, PR #281's agent is in error; unknown whether the daemons have a password.
  - 依据：paseo ls: 999f9de PR #284 (thinking high), bea807e PR #281 (medium), 47815f0 PR #285 (xhigh), all idle. The Mac host shows f5b9018 PR #285 idle and e6206e4 PR #281 in error, Paseo 0.11.2 running inside /Applications/Paseo.app, relay disabled. #284 merged at 2026-10-14T04:43:21Z, so its session and worktree (/home/operator/vonvon/worktrees/test-timeouts) are stale. vonvon-collaboration.md allows at most two Claude sessions at effort medium. On passwords: ~/.paseo/config.json has no password hash, the supervisor has no PASEO_PASSWORD, and memory note vonvon-paseo-handoff.md says 'Neither has authentication, and the user decided not to add a Tailscale ACL.'
- **说过头了**：P5 risk: on 2026-10-13 you said there was no Windows host; OP-4 #208 is open.
  - 依据：Memory note vonvon-testing-split.md: 'there is no Windows host and the user won't set one up', codified in PR #239 (merged 2026-10-13T04:02Z), with AGENTS.md:29 '没有 Windows 原生环境'. gh issue view 208: OPEN; V7c needs a Windows host with Codex and Claude Code and is otherwise parked as a leaf that blocks nothing.
- **说过头了**：P7: JP-VPS has 0 swap; unknown whether operator has sudo.
  - 依据：free -h shows Swap 0B, 3.8 GiB total, 2.4 GiB used. `id` shows operator in group 27(sudo), but `sudo -n true` says 'a password is required'.
- **说过头了**：P3/P8 citations: Paseo docs say browser tools are off by default (browser.md); Paseo mobile connects 'directly with Tailscale' (configuration.md); the snapshot's version differs from the Mac's 0.11.2.
  - 依据：references/paseo-0009/public-docs/browser.md:26 'Browser tools are off by default', :43 the logged-in-state warning, :47 'Browser tabs are hosted by the Paseo desktop app'. The Tailscale sentence is at public-docs/connectivity.md:11, not configuration.md. references/paseo-0009/package.json is version 0.11.1 (commit 0009a7e7, 2026-10-09). JP-VPS config.json has browserTools.enabled=false and mcp.enabled=false.

### 正文遗漏的事实

- Program progress, from the issue #122 board (synced 2026-10-14T04:21Z): V1-V4 merged, V5 5/11, V6a 1/8, everything else (V6b-V11) at 0. Merged PR titles show V5 split into 15 PRs (11 merged; #285 is 12/15), V6a into about 10 (1/6..5/6 plus 6a-6d), and V6b into 14 (#281 is 1/14). docs/ci-costs.md estimated about 14 PRs for all of V5-V11 on 10-12. This blow-up in PR count matters more for 'why is it slow' than any hardware resource.
- Handoff ping-pong: PR #281 (Codex children onto ProcessHost, opened 01:53Z today) is already on its 5th handoff ('本 PR 第 5 次交接', PR comments). vonvon-collaboration.md records 18 rejections on 2026-10-13.
- Process overhead in docs: docs/*.md total 4667 lines; plan.md alone is 2128 lines and native-acceptance-hosts.md 685 lines, mostly containment rules for a shared production host.
- Something tryable already exists, but only on the Mac: the V4 daemon web UI (#69, 10 live lanes PASS) and V5's Electron window, tray, updater and packaging (#257). Codex built a Developer ID-signed package on 10-13 (#257 comments). P4's 'signed builds arrive only with #146' is too strong: Developer ID signing already works locally, and #146 adds notarization and the public download.
- A dedicated Feishu test chat already exists: /home/operator/vonvon/.audit/design-ownership-20261011T044532Z/reports/lark-test-chat-current.json (10-11) shows a private group with 1 user and 1 bot. #69 used 'two disabled Bots' from saved bridge data. This partly answers P1's 'which test app/chat' unknown; the App ID itself is still unknown.
- User statement the report did not use: Codex on the Mac already does browser work through an 'EGO Browser' skill, so only Computer Use is missing via Paseo/Codex CLI. Memory note no-feishu-dev-channel.md says that for desktop-only tasks the user pastes prompts into the Codex desktop app, which P3 should build on.
- JP-VPS hygiene: 13 git worktrees using about 10 GB (5.0G in ~/.paseo/worktrees, 5.0G in ~/vonvon/worktrees), including branches of merged PRs (test-timeouts, v5-cli-install, v5-login, v5-status) and pre-staged V6b branches (v6b-goals, v6b-provider-ids, v6b-rehome, v6b-runtime). AGENTS.md says to delete a worktree on merge. 26 G of disk is free.
- 18 open PRs, most of them stale: the old Electron stack #2-#19, #100, #110 (split source), #226, #234 and two dependabot PRs. This is noise on the board the user is told to watch.
- The tencent-resources.md citation is at /home/operator/vonvon/.audit/... (outside the vonvon-bot repo), and docs/deployment/account-service.md is in vonvon-bridge-legacy, not vonvon-bot. vonvon-site was pushed on GitHub on 2026-10-10, so the local clone's 09-18 date is stale.
- docs/roadmap.md:111-113 says the 'two clients of one Bot, only one gets events' behavior is still an inference to be proven in V8, while native-acceptance-hosts.md:406 states it as fact. P1's App-ID separation rests on that.
- The Mac mini's CPU and RAM are still not recorded anywhere I could read. The only description is 'ample CPU and memory' in memory note vonvon-testing-split.md.
