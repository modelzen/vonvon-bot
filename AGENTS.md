# Agent guide for vonvon-bot

vonvon-bot is the Vonvon Bot desktop app, an Electron 44 and React 19 client for a local Feishu collaboration Host. The Electron main process starts or attaches to the bundled Bridge Core and projects its state into a sandboxed renderer through a typed preload API. Read these before you change anything:

- `DEVELOPMENT.md` covers build, test, the reviewed Core pin, preview packaging and native verification.
- `docs/handoff/2026-10-09/CONTINUE.md` gives the current baseline and direction, in Chinese.
- `docs/parity/README.md` holds the parity cases that define complete behavior.
- `.github/workflows/desktop.yml` lists exactly what CI runs.
- `desktop/main/index.ts`, `desktop/main/host.ts` and `desktop/preload.ts` show the process boundary.

## Two hosts share the work

| Host | Agent | Display | Runtime | What it can prove |
| --- | --- | --- | --- | --- |
| Mac (any Apple Silicon Mac) | Codex | Yes | `npm run prepare:runtime` works for `darwin-arm64`, so the Host connects | Everything CI runs, plus the native runners (`npm run test:native`, `test:controls`, `test:settings-ui`), packaging, and the live Host in the real window |
| Linux server, Ubuntu 24.04 x86_64 | Claude Code | None, Xvfb only | None for Linux, so the window shows `Bridge 尚未就绪` with `打包运行时不可用` | `npm run typecheck`, `npm test`, `node scripts/parity-report.mjs --check`, `npm run build`, and the UI shell through the `verify` skill |

Git is the only channel between the hosts. Each host runs its own `npm ci`. Never copy `node_modules`, `dist`, `build` or `release` between machines.

## One branch per change, handed between hosts

- Each change lives on one branch, and both agents work on that same branch, one at a time. The prefix only records which agent created it: `claude/*` on Linux, `codex/*` on the Mac.
- The usual flow is that the Linux agent writes the change, runs its checks and pushes. The Mac agent then pulls the same branch, starts the app, checks the real window and reports what it saw in the PR.
- If the Mac agent finds a problem that only the Mac shows, it fixes it on the same branch and pushes. The Linux agent pulls before its next edit.
- Pull before you start and push when you stop. Never force-push a branch the other host may have pulled.
- Stack each PR on its parent branch. The current line is `codex/device-handoff`.
- Write Conventional Commits in the repo's style, such as `fix(desktop): ...` or `docs(agents): ...`.

## Done means checked on your host

A change is done when the checks in your host's row pass. Put each command and its result in the PR body.

If a Linux change alters what the window shows, add the line `Mac window check: pending` to the PR body. The Mac agent runs the app, then replaces that line with what it saw.

## Core boundary

- The Core is `@modelzen/feishu-codex-bridge`, vendored as a reviewed tarball in `vendor/core`. Update it only with `scripts/pin-core.mjs` from reviewed inputs, as `DEVELOPMENT.md` describes. Never edit the Core from this repo.
- Keep Core access inside `desktop/main`. Main imports the Core's `dist/host.js` as `HostModule` and sends HTTP through `HostHandle.request`. Renderer and shared code never import the Core. The owner plans to replace the Core, and this boundary keeps that swap local to `desktop/main`.
- Each host uses its own Feishu test bot. Feishu long connections run in cluster mode, so when two clients share one bot, each event reaches only one random client.

## Linux host notes

- **Electron binary.** The Electron download is too slow here and times out. Seed the cache by hand for each new Electron version:
  1. Download `electron-v<version>-linux-x64.zip` from the Electron GitHub release.
  2. Compare its SHA-256 with the entry in `node_modules/electron/checksums.json`.
  3. Put the zip in `~/.cache/electron/<hash>/`, where `<hash>` is the SHA-256 of the string `https://github.com/electron/electron/releases/download/v<version>`.
  4. Run `node node_modules/electron/install.js`.
- **Launch flags.** Run Electron under `xvfb-run -a -s "-screen 0 1280x800x24"` with `--no-sandbox --disable-gpu --disable-dev-shm-usage`. Without `--no-sandbox` Electron aborts, because `chrome-sandbox` is not root-owned and sudo is blocked. Without `--disable-dev-shm-usage` it hangs.
- **Tray icon.** On Linux, `new Tray()` with a `.ico` path never returns, and the app passes `vonvon-tray.ico` on every platform except macOS. A PNG works, with or without a D-Bus session. The `verify` helper swaps the `.ico` path for the bundled `.png` before it loads `dist/main.cjs`. Until `desktop/main/index.ts` picks a PNG on Linux, launch the app on this host only through the helper.
- **Processes.** `timeout xvfb-run ...` leaves Electron children alive. Kill the process group you started, never by name. The `verify` helper does this for you.
- **Fonts.** The server has no CJK fonts, so screenshots show boxes for Chinese text. Read text from the DOM.
- **npm warnings.** npm 11 prints `install-scripts` warnings for `esbuild` and `electron-winstaller` during `npm ci`. They are harmless.

## Skills

- `.agents/skills/<name>/SKILL.md` is the only source for project skills. Codex reads `.agents/skills` directly.
- `.claude/skills` is a committed relative symlink to `../.agents/skills`, so Claude Code sees the same skills.
- Add skills only under `.agents/skills`.
- `verify` launches the built app in an isolated home, clicks a sidebar item and captures evidence on either host. Its feature map lives in `.agents/skills/verify/features/`.
