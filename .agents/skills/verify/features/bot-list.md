# Bot list

## Sub-features

Bot names, enabled state, connection state, group count, and refresh.

## How to get to it (user POV)

Open with `vonvon open`, then select Bot in the sidebar.

## Driving it with Playwright Chromium

Use `web.mjs capture bot-list` for a screenshot. On a seeded fixture, use `page.getByRole('button', {name:/Bot/})` in the sidebar and inspect the Bot rows. Compare names and enabled states with the same fixture in the pinned `fab5237` renderer.

## Gotchas

A fresh home has no Bot. An empty page proves startup only. The V4 comparison lane requires the isolated native fixture and a matching original-renderer capture.
