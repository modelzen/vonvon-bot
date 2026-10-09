# Local environment

The local environment page detects the execution tools on this machine, Codex and Claude, plus the Feishu CLI. It offers install, update and authorization actions for them.

## Sub-features

- `env-detect` lists each tool with its installation and authorization state.
- `env-recheck` re-runs detection with `重新检测`.
- `env-feishu-cli` manages the Feishu CLI login identity.

## How to get to it (user POV)

- Choose `本机环境` in the sidebar.
- Choose `打开本机环境` on the Usage page.

## Driving it with verify.cjs

Preconditions:

- The doctor passes.

- **Open the page.** Run `node .agents/skills/verify/verify.cjs capture --click 本机环境`. `result.json` shows `after.title` equal to `本机环境`.
- **Linux proof.** `after.txt` contains `重新检测`, `本机环境操作失败，请重试。` and the `Bot` and `飞书 CLI` section headings.
- **macOS proof.** With the prepared runtime, the tool list replaces `正在检测本机工具…` and shows the Codex and Claude rows. The isolated home has no Codex login, so expect an unauthorized Codex state. That is the correct result, not a failure.

## Gotchas

- On Linux `正在检测本机工具…` stays on screen forever. The page shows it whenever the tool list is empty, and the list stays empty because detection fails without the bundled Node runtime.
- Install and authorization actions change the machine. Do not run them from a capture.
