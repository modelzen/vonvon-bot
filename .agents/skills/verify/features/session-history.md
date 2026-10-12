# Session history

## Sub-features

History list, session context, and compact.

## How to get to it (user POV)

Open a bound group and choose session history.

## Driving it with Playwright Chromium

On a fixture with a known session, open the history row, invoke compact, and capture `history.png` after the state updates. Verify the underlying session state or next read. Capture an error when no session exists rather than claiming a compact pass.

## Gotchas

A fresh home has no history. A real compact may invoke a provider; use the isolated fixture and the prescribed lane only.
