# Bot list

The Bot page is the start page. With no Agents it shows a three-step setup guide and an `添加 Bot` button. With Agents it lists each Agent with its status and opens the Agent's settings.

## Sub-features

- `bot-empty` shows the setup guide and `邀请你的第一个 Bot` in a fresh home.
- `bot-list` lists registered Agents with name and status.
- `bot-register` opens QR registration from `添加 Bot`.

## How to get to it (user POV)

- Open the app. The Bot page is selected by default.
- Choose `Bot` in the sidebar from any other page.

## Driving it with verify.cjs

Preconditions:

- The doctor passes.

- **Open from another page.** Run `node .agents/skills/verify/verify.cjs capture --click Bot`. `result.json` shows `after.title` equal to `Bot`.
- **Linux proof.** `after.txt` contains `Bridge 尚未就绪`, `打包运行时不可用`, `邀请你的第一个 Bot` and `添加 Bot`.
- **macOS proof.** `result.json` shows `host.kind` equal to `connected`, and `after.txt` contains `邀请你的第一个 Bot` without `Bridge 尚未就绪`. `npm run test:native` asserts the same text for a fresh home and the Agent list for an existing-user home.

## Gotchas

- `before` is already the Bot page, so `before.txt` and `after.txt` match. Click another page first when you need to prove navigation.
- Registration needs Feishu. Do not start it from a capture. The QR flow is covered by `npm run test:controls` with fixture IPC.
