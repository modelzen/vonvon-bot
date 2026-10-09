# Group chats

The group chats page lists Feishu groups that an Agent has joined and bound to a working directory. Each row opens the group's Agents and per-group settings.

## Sub-features

- `groups-empty` shows `还没有连接的飞书群` when no group is bound.
- `groups-list` lists bound groups by their local binding name.

## How to get to it (user POV)

- Choose `群聊` in the sidebar.

## Driving it with verify.cjs

Preconditions:

- The doctor passes.

- **Open the page.** Run `node .agents/skills/verify/verify.cjs capture --click 群聊`. `result.json` shows `after.title` equal to `群聊`.
- **Linux proof.** `after.txt` contains `已连接的飞书群` and `还没有连接的飞书群`.
- **macOS proof.** With a connected Host and a fresh home, the same empty state appears without `Bridge 尚未就绪`. A populated list needs the existing-user fixture from `npm run test:native`.

## Gotchas

- The page shows local binding names, which can differ from the current Feishu group name.
- The setup guide from the Bot page also appears here while no Agent exists.
