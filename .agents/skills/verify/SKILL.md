---
name: verify
description: Launch the built Vonvon Bot Electron app in an isolated home, click a sidebar item, and capture a screenshot plus the page text as evidence. Works headless on the Linux host through Xvfb and runs plainly on macOS. Use to prove a renderer or main-process change in the real window, or to check what a page shows before and after a change.
---

# Verify Vonvon Bot

The surface is the Electron desktop window built from `desktop/` into `dist/`. The helper `verify.cjs` in this directory runs one capture per call. It starts the app, waits for the Host to leave `starting`, optionally clicks one sidebar item with a real mouse event, captures evidence, quits the app through its own quit path, and stops every process it started.

Run all commands from the repository root.

## Launch

```sh
npm run build
node .agents/skills/verify/verify.cjs capture --click 本机环境
```

`capture` runs the doctor first and refuses to launch when a check fails. Flags:

- `--click <name>` clicks the sidebar item whose accessible name matches exactly. Names are `Bot`, `群聊`, `本机环境`, `用量`, `咖啡一下`, `应用与启动`, `状态与诊断`. Omit it to capture only the start page.
- `--slug <slug>` names the evidence directory. The default is the click name, or `launch`.
- `--timeout <seconds>` bounds the drive. The default is 60.

The app is ready when `window.bridge.watch` reports a Host state other than `starting`. On Linux the Host is always `blocked` with `打包运行时不可用` because no runtime exists for Linux. On macOS with `npm run prepare:runtime` done, expect `connected`.

Platform recipe, applied by the helper:

- Linux runs `xvfb-run -a -s "-screen 0 1280x800x24"` with `--no-sandbox --disable-gpu --disable-dev-shm-usage`. Before it loads `dist/main.cjs`, the helper wraps `electron.Tray` so that a `.ico` path becomes the `.png` beside it. The app passes `vonvon-tray.ico` on every platform except macOS, and on Linux `new Tray()` with a `.ico` never returns. The real Tray still runs with the PNG. The swap lives only in this helper. The app fix belongs in `desktop/main/index.ts`.
- macOS runs Electron directly with no flags and no Tray swap. The app finds `build/runtime/mac-arm64` on its own.

Each run uses a fresh home under `.audit/verify/<timestamp>-<slug>/home` with `HOME`, `USERPROFILE`, `CODEX_HOME`, `XDG_*` and `VONVON_DESKTOP_TEST_HOME` pointing into it. The app checks this isolation in test mode, sets its own `userData` inside it, and refuses login-item and PATH changes. Two captures can run side by side.

## Doctor

```sh
node .agents/skills/verify/verify.cjs doctor
```

It is read-only and exits 1 when any check fails. It checks three things:

- `dist/main.cjs` is newer than every file under `desktop/`. A fresh checkout can fail this check without a source change. Rebuild.
- The Electron binary from `node_modules/electron` exists. On Linux a missing binary needs the manual seed in `AGENTS.md`.
- `xvfb-run` is on `PATH` (Linux only).

The `runtime` line is informational. It tells you whether to expect a live Host.

## Drive

`--click` is the only action. It finds the button under `aside[aria-label="应用侧栏"] nav`, sends `mouseMove`, `mouseDown` and `mouseUp` at its center, then waits until that button has `aria-current="page"` and the page text stays unchanged for one second. An unknown name fails and lists the available names in `error.txt`.

For anything deeper than one click, such as dialogs, forms, settings saves or Agent fixtures, use the native runners on macOS. Do not grow this helper into a second test suite:

- `npm run test:native` covers fresh and existing-user homes against the live Host, hide-to-tray, and owned Host shutdown.
- `npm run test:controls` and `npm run test:settings-ui` drive the renderer against fixture IPC.
- `node scripts/test-parity-native.mjs --os-service-fixture=absent` covers migration and lifecycle parity probes.

The feature map in [`features/README.md`](features/README.md) lists what each page shows and which host can prove what.

## Evidence

A successful capture prints JSON with `ok: true` and leaves these files in `.audit/verify/<timestamp>-<slug>/`:

- `before.png` and `before.txt` hold the start page as a screenshot and as `document.body.innerText`.
- `after.png` and `after.txt` hold the page after the click. They exist only with `--click`.
- `result.json` records the platform, whether the Tray icon was swapped, the Host state, the Agent count, the click, and each page's `main` title.
- `app.log` holds Electron's stdout and stderr. D-Bus errors in it are expected on Linux.

A failed capture also keeps `error.txt` and `home/`.

Proof standards:

- Compare `before` with `after`. The action and the resulting state together are the proof, not the final screen alone.
- Read Chinese text from the `.txt` files. The Linux host has no CJK fonts, so screenshots show boxes for Chinese characters. Layout, icons and Latin text in the screenshots are still valid.
- On Linux a page proves only the shell and its blocked-Host state. Anything that needs a connected Host is a macOS proof. Write `Mac window check: pending` in the PR body instead of claiming it.

## Cleanup

`capture` cleans up after itself. It runs Electron in its own process group, waits for the app's graceful quit, then sends `SIGTERM` and `SIGKILL` to that group until no member remains. It removes `home/` only after a clean run and never deletes evidence.

If a capture was interrupted, run:

```sh
node .agents/skills/verify/verify.cjs cleanup
```

It reads the `pgid` file that each unfinished run leaves behind. It stops a process group only when a member's command line contains this helper's path, so it never touches the user's own app or another tool's Electron. Never kill by process name. Running `cleanup` twice is safe.

## Gotchas

- `timeout xvfb-run ...` by hand leaves Electron children alive. Use the helper, or kill the process group you started.
- A main process blocked in native code cannot run the driver's own deadline, so `error.txt` is missing and `exit` reads `timeout`. The helper then waits `--timeout` plus 20 seconds and stops the process group.
- Interrupted Linux runs can leave `/tmp/.X<n>-lock` and `/tmp/xvfb-run.*`. `xvfb-run -a` picks the next free display, so they do no harm.
- On macOS the owned Host is a detached process outside the helper's process group. It shuts down when the app quits or when its stdin pipe from the app closes. If `capture` reports a non-zero exit on macOS, check for a leftover `feishu-codex-bridge.mjs host --parent-control` process before the next run.
