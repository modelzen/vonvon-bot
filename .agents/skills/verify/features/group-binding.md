# Group binding

## Sub-features

Joined-group discovery, response mode, work directory selection, and project binding.

## How to get to it (user POV)

Select a Bot and choose to join or bind a group. The directory browser appears after selecting an existing directory.

## Driving it with Playwright Chromium

Choose an isolated fixture group, click `选择文件夹`, navigate directory entries by their visible names, and select the current directory. Capture `bind-dialog.png`. After saving, inspect the group's row and its saved `projects.json`. For response mode, open the group settings and select `all`; capture `group-response.png` and verify the saved mode.

## Gotchas

The directory RPC issues a short-lived token. Use the picker immediately before saving; never reuse a token from another daemon or home. Feishu fixture lanes require the separate test Bot and must not reach the operator's live Bot.
