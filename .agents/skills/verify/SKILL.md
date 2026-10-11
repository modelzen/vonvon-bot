---
name: verify
description: Drive Vonvon Bot's built local web UI and future Electron shell, inspect user-visible behavior, and retain screenshots and state evidence.
---

# Verify Vonvon Bot

## Launch

Use a fresh worktree at the exact PR head. Run `npm ci`, `npm run build -w packages/protocol`, `npm run build -w packages/client`, `npm run build -w packages/ui`, and `npm run build -w packages/daemon`. Use an isolated absolute `HOME` and `VONVON_HOME`; never point these at the operator's running Bridge or daemon. Launch `node packages/daemon/bin/vonvon.mjs daemon start`. Readiness is `node packages/daemon/bin/vonvon.mjs daemon status --json` returning `running:true` with a loopback `listen`. The daemon serves the built UI on that same address. No Bot is registered in a fresh home.

Do not put the local credential or the full `vonvon open` URL in a terminal transcript, screenshot caption, log, PR, or document. `vonvon open` transfers the credential in the URL fragment and the page removes it from the address bar. When driving Playwright, the helper reads the credential directly from the isolated home.

## Doctor

Run `node .agents/skills/verify/scripts/web.mjs doctor` before UI work, and again if a page looks stale. It checks the running owner, the built index, and the credential file without printing the credential. Compare the daemon head and UI build with the PR head. If it fails, rebuild and restart the isolated daemon; do not reuse another instance.

## Drive

Install the matching Chromium once with `npx playwright install chromium`. Run `node .agents/skills/verify/scripts/web.mjs capture bot-list /absolute/evidence/bot-list.png` to drive the real credentialed page and capture it. Run `node .agents/skills/verify/scripts/web.mjs capture no-cred /absolute/evidence/no-cred.png` to prove the page rejects a bare URL. The helper uses Playwright Chromium and actual browser navigation. It does not seed data or call internal RPCs. Use the feature map in `features/README.md` for selectors and additional actions. For a longer lane, write a small Playwright script with the same connection recipe as `scripts/web.mjs`, interact with roles and labels, and keep its source beside the lane evidence.

For Electron after V5, use Playwright's `_electron.launch` on the built shell in a real macOS window. Drive the same visible labels. Verify its owned daemon PID and `VONVON_HOME` before interacting. The Electron recipe remains pending until V5 provides the shell's executable and preload path; do not claim Electron acceptance from the browser.

## Evidence

Save captures under an absolute review directory outside the scratch home, such as `~/vonvon-review`. Capture the action and its result, not only the final screen. For writes, compare the visible result with the isolated home's saved JSON or other named state. Keep lane screenshots named by the V4 plan, and record the prescribed 30 to 60 second video at the exact head. A no-credential image must show the explicit `vonvon open` guidance. A Bot list image must show names and enabled states from the fixture, not an empty startup screen. Report the Git head, fixture source, commands, outputs, screenshots, and any inconclusive lane separately.

## Cleanup

Run `node packages/daemon/bin/vonvon.mjs daemon stop` with the same isolated `VONVON_HOME`. Close only Playwright contexts and processes started for this run. Remove scratch homes after the daemon owner has exited. Preserve the review directory and screenshots. Never kill by process name.

## Helpers

`node .agents/skills/verify/scripts/web.mjs doctor` checks the owned instance. `node .agents/skills/verify/scripts/web.mjs capture bot-list /absolute/path.png` and the `no-cred` variant capture a real Chromium page. The helper never prints the credential or full URL.
