# Vonvon Bot verification map

This directory lists the user-facing pages of the Vonvon Bot window and what proves each one. Read this index first, then use the matching feature file as the recipe. The harness is `node .agents/skills/verify/verify.cjs`, described in [`../SKILL.md`](../SKILL.md).

## Baseline preconditions

- Run `npm run build`, then `node .agents/skills/verify/verify.cjs doctor`, and require every check to print `ok`.
- Every capture starts in a fresh isolated home with no Agents, groups or Feishu credentials.
- On Linux the Host is `blocked` with `打包运行时不可用`. On macOS after `npm run prepare:runtime`, the Host is `connected` and owned by the app.

## Driving conventions

- Reach every page by its sidebar name with `--click`. Names are literal and case-sensitive.
- Read results from `after.txt` and `result.json`. Use screenshots for layout only, because the Linux host has no CJK fonts.
- Compare `before.txt` with `after.txt` to show the click changed the page.

## Proof and skip reporting

- A Linux capture proves the shell. That covers navigation, the page title, static copy, and the blocked-Host notice and empty states.
- A connected-Host result is a macOS proof. From Linux, report it as `Mac window check: pending` and never as verified.
- The Linux proof lines come from real captures on the Linux host. The macOS proof lines come from reading the renderer and `scripts/native-smoke.cjs`, because the helper has not run on macOS yet. The first Mac run corrects them.
- Deep checks on macOS belong to `npm run test:native`, `npm run test:controls` and `npm run test:settings-ui`. Name the runner you used.

## Features

- [Bot list](./bot.md) is the default page with Agent registration and the Agent list.
- [Group chats](./groups.md) lists Feishu groups bound to a working directory.
- [Local environment](./environment.md) detects, installs and authorizes Codex, Claude and the Feishu CLI.
- [Usage](./usage.md) shows Codex account usage and shares a usage card to a group.
- [Status and diagnostics](./diagnostics.md) shows Host version, counts, data directory and Bridge logs.
