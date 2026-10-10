# Daemon source provenance and V2 import blocker

The V2 source import has not run. This file records the pinned source and the
plan conflict that blocks the import. It does not claim that a daemon package,
an importer, or a runnable CLI exists on this branch.

## Source

The planned source is `modelzen/feishu-codex-bridge`, branch
`codex/device-handoff`, commit
[`446b2a40ca75b5f725d7b0baab777b3a8f18b2e0`](https://github.com/modelzen/feishu-codex-bridge/tree/446b2a40ca75b5f725d7b0baab777b3a8f18b2e0).
The source license is MIT, copyright 2026 modelzen. No source files or tests
have been copied yet. The eventual importer must preserve the license and
record the files it copies.

## Conflicting instructions

At main commit `780cd05e740d52de9f485528a29b1c6f9a334553`, the documents give
different V2 boundaries.

- [V2 in plan.md](../../docs/plan.md#copy-the-bot-runtime-into-the-daemon-package-v2)
  requires copying `src/` and `test/`, then running the copied suite against
  the 153 source test files.
- [V3 in plan.md](../../docs/plan.md#serve-the-daemon-api-over-websocket-v3)
  deletes `src/web` after replacing its admin routes with RPC. Its first live
  lane reads V2's existing `GET /api/state` endpoint.
- [architecture.md](../../docs/architecture.md) says not to copy `src/web`.
  [roadmap.md](../../docs/roadmap.md) repeats that exclusion for V2.

These instructions affect the executable and the tests, not just the copy
command. At the pinned source commit:

- [`src/bot/supervisor.ts`](https://github.com/modelzen/feishu-codex-bridge/blob/446b2a40ca75b5f725d7b0baab777b3a8f18b2e0/src/bot/supervisor.ts#L14)
  imports `mountWebConsole`. Its zero-bot path throws if the web console cannot
  start, because the console supplies onboarding.
- [`src/cli/commands/run.ts`](https://github.com/modelzen/feishu-codex-bridge/blob/446b2a40ca75b5f725d7b0baab777b3a8f18b2e0/src/cli/commands/run.ts#L14)
  also imports and mounts the web console.
- [`src/host/discovery.ts`](https://github.com/modelzen/feishu-codex-bridge/blob/446b2a40ca75b5f725d7b0baab777b3a8f18b2e0/src/host/discovery.ts#L36)
  reads `/api/state`. The copied tests include web, discovery, and onboarding
  behavior.

Copying all source temporarily would violate the explicit V2 exclusion.
Removing the console now requires deciding how V2 supplies onboarding and
admin behavior, which affects the work currently assigned to V3. Codex has
not selected either interpretation or changed the design documents.

## Required plan update

Claude Code must reconcile the V2 import boundary, the full-suite requirement,
and the V3 HTTP baseline before implementation resumes. The updated plan can
explicitly allow a temporary V2 compatibility copy and keep the V3 deletion,
or define V2 behavior and test coverage with the console absent. The latter
also needs an explicit decision about V3's `/api/state` baseline.

This follows the operator's instruction to stop when architecture or PR order
needs a decision, and the same division of responsibilities in `AGENTS.md` and
`docs/plan.md`. This report does not authorize merging an incomplete V2.

## Other findings for implementation

These source differences are recorded for the implementation after the plan
update. Codex has not changed them yet.

- `test/keystore.test.ts` does not exist at the pinned source commit. V2 needs
  to add that test file for the renamed-host case.
- `src/config/data-access.ts` creates `~/.vonvon-bridge-access`. The V2 path
  checks must cover this writer as well as `src/config/paths.ts`.
- The source CLI exposes top-level `run`, and its supervisor reexecutes that
  command. `vonvon daemon run` needs coordinated CLI and child routing.
- Repeated imports must preserve the V2 changes to paths, keystore, CLI, and
  tests. A raw recursive copy would overwrite them.
- The performance recipe reads Linux `/proc`. macOS needs an equivalent
  process-tree RSS probe, with the measurement change recorded in the PR.

## Verification status

The source checkout's full SHA matches the pin. `git ls-files
'test/*.test.ts' | wc -l`, run inside that checkout, reports 153 test files.
The dependency findings above are source inspection results. They are not
runtime or test results.

V2 unit tests, live lanes 1 through 10, and the startup and RSS benchmark have
not run. They remain blocked by the plan conflict. The operator authorized
using existing feishu-codex-bridge data for the later live tests, which replaces
the plan's dedicated test Bot fixture requirement. No data has been imported
and no test connection has started. Use an isolated copy when implementation
resumes. Credentials must stay out of Git and PR comments.

V1 PR #22 landed in main as `780cd05e740d52de9f485528a29b1c6f9a334553` before
this branch was created. The merge commit's tree matches the independently
verified V1 head `dddb3d82f371228e13701e865a5672ff1f4b784b`.
