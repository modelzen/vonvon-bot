# Bot settings

## Sub-features

Bot enablement, model choices, permissions, response mode, and scoped settings.

## How to get to it (user POV)

Select Bot, choose a registered Bot, then open its settings pane.

## Driving it with Playwright Chromium

Use the visible Bot name to open its row, then use the settings tab and role-based labels. Capture `bot-settings.png` showing every original settings section. Change only a disposable fixture and compare the saved setting in the isolated home.

## Gotchas

The protocol uses string revisions for settings and project edits. A stale revision must be surfaced rather than overwritten. Some original machine-only controls need V5 service support.
