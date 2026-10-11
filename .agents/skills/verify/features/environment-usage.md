# Environment and usage

## Sub-features

Detected codex, claude, and lark-cli versions; authentication state; usage windows; and search navigation.

## How to get to it (user POV)

Select 本机环境 or 用量 in the sidebar. Open search with Command-K and search for a settings anchor.

## Driving it with Playwright Chromium

Capture `environment.png` after all tool rows resolve. Capture `usage.png` with either usage windows or an explicit signed-out state. Search for a visible settings row, select it, and capture `search.png` showing the destination anchor.

## Gotchas

Tool detection is specific to the isolated test environment. A row can legitimately say a tool is missing, but the lane must distinguish missing from a read failure.
