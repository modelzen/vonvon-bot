# Group binding

## Sub-features

Joined-group discovery, response mode, default or existing work directory selection, and project binding.

## How to get to it (user POV)

Select a Bot and choose to join or bind a group. In `继续绑定`, `目录来源` defaults to `新建空白目录`; choose `使用现有目录` to reveal `选择文件夹` and open the directory browser.

## Driving it with Playwright Chromium

Choose an isolated fixture group, leave `目录来源` at `新建空白目录`, enter the local binding name, and select a conversation mode. Save without opening the folder picker; compare the group's displayed directory and saved `projects.json` with the ready group allocation in the isolated home's `bots.json`. The default binding directory is `<stable Bot directory>/groups/<initial binding name>`, with a suffix on a name collision. For a second fixture group, select `使用现有目录`, click `选择文件夹`, navigate directory entries by their visible names, and select the current directory. Capture `bind-dialog.png` and verify the saved existing path. For response mode, open the group settings and select `all`; capture `group-response.png` and verify the saved mode.

## Gotchas

Stable per-Bot default directories for newly created Feishu groups and stable creation retries remain in s36c2c4; this default-directory check covers binding an existing group. Existing bindings keep their saved cwd. The directory RPC issues a short-lived token for an existing directory. Use the picker immediately before saving; never reuse a token from another daemon or home. Feishu fixture lanes require the separate test Bot and must not reach the operator's live Bot.
