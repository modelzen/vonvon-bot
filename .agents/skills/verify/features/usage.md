# Usage

The usage page shows Codex usage for the Codex account logged in on this machine. All Agents share it. The page can also send a usage card to a chosen Feishu group.

## Sub-features

- `usage-read` reads and refreshes Codex usage with `刷新用量`.
- `usage-share` builds a usage card for a selected group.
- `usage-login-hint` links to the local environment page when Codex is not logged in.

## How to get to it (user POV)

- Choose `用量` in the sidebar.

## Driving it with verify.cjs

Preconditions:

- The doctor passes.

- **Open the page.** Run `node .agents/skills/verify/verify.cjs capture --click 用量`. `result.json` shows `after.title` equal to `用量`.
- **Linux proof.** `after.txt` contains `Codex 用量`, `用量尚未读取`, `打开本机环境` and `Bridge 服务未连接，请稍后重试。`.
- **macOS proof.** With a connected Host, `Bridge 服务未连接` disappears. The isolated home has no Codex login, so `用量尚未读取` with the login hint is the expected state.

## Gotchas

- Real usage numbers need a logged-in Codex account. Never point a capture at the developer's real `CODEX_HOME`.
- Sharing sends a Feishu message. Do not run it from a capture.
