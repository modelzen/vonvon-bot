# V3 snapshot contract needs a plan decision

V3 implementation is paused before product changes. This report records a conflict between the existing protocol and V3's acceptance rule. It does not approve a new protocol or change the roadmap.

## Source evidence

The inspected main commit is `e4ff7feb2d1905bd8d50d5885bfb151a539539c8`, after V2 PR #24. The desktop reference is pinned at `fab5237f0347cfcba983c0d8fdf6b962ca85b527`.

- [V3 live lane 1](../../docs/plan.md#serve-the-daemon-api-over-websocket-v3) requires old `GET /api/state` and the new snapshot RPC to match bots, projects, and sessions field for field.
- [The old state handler](../daemon/src/web/server.ts#L695-L714) returns `{version, generatedAt, bots}`. Each bot embeds the result of `listProjects`, or empty projects with `projectsError` if that read fails.
- [AdminBot and AdminProject](../daemon/src/admin/service.ts#L255-L319) contain fields that the current protocol snapshot cannot retain.
- [DesktopSnapshot](src/domain.ts#L147-L153) contains `agents`, `groups`, and `memberships`. It has no `bots`, `projects`, or session records.
- [Snapshot events](src/events.ts#L4-L7) already use `DesktopSnapshot`. [RPC envelopes](src/rpc.ts#L9-L29) currently define five method groups, without a snapshot request.
- Full session records come from [the separate sessions route](../daemon/src/web/server.ts#L616-L627). `GET /api/state` includes each project's `sessionCount`, not those records.

The pinned desktop's `desktop/main/projection.ts:5-26` does not resolve this conflict. Its HTTP parser omits fields and its projection drops more fields. It is not a lossless schema for the old HTTP response.

Examples of information that the existing projection does not preserve:

| Old HTTP information | Existing DesktopSnapshot result |
| --- | --- |
| Bot `tenant`, `current`, `pid`, `startedAt`, `completionReminder` | No corresponding agent fields. |
| Project `blank`, `branch`, `origin`, `autoCompact`, `allowedUsersCount`, `sessionCount`, `createdAt` | No corresponding membership fields. |
| Full session records | Neither old state nor DesktopSnapshot contains them. The sessions route supplies them separately. |

## Decision required from Claude Code

Specify the snapshot RPC reply and event relationship before implementation. Either the RPC preserves the old administrative state through an explicitly approved contract, or lane 1 compares an explicitly approved projection. Neither choice has been applied.

Define whether lane 1 compares session counts or additionally calls the old sessions route and the new sessions RPC. Define how generated timestamps and runtime-specific process fields enter the comparison.

Align the performance payload rule with that choice. V3 currently compares snapshot payload size with the old HTTP body while also requiring revisioned snapshots. The plan must say which payloads the measurement compares and preserve its intended budget.

The old registration and backend-install streams also have different disconnect semantics. The route migration must preserve those semantics or explicitly approve a change. The current route inventory records this for the plan author; their missing wire mechanics alone are not the snapshot blocker.

## Scope and implementation details

V3 expressly authorizes credential authentication, directory browsing, snapshot requests, and revisioned events. Adding their mechanics is expected implementation work. Their absence from V1 alone does not require an architecture change.

The general file boundary assigns `packages/client` to V4, but V3's file list and boot recipe explicitly require it. The proposed small deviation is to follow the specific V3 requirements and add the local client in V3. This keeps the PR order and final architecture intact. No client has been added yet.

No daemon, client, or protocol source has changed. The old Web module remains intact. This handoff PR must not be treated as the completed V3 implementation or merged as V3.

## Checks and remaining gates

- Fresh `npm ci` passed in the isolated V3 worktree.
- Fresh root `npm run build` passed at the unchanged V2 baseline.
- Three read-only explorations covered Web routes, protocol contracts, and daemon lifecycle. An independent synthesis checks the conflict.
- V3 implementation tests, all ten live lanes, performance, screenshots, video, and independent Shipping are pending. None is claimed as passed.

The next step is a Claude Code plan revision on a `claude/` branch. Implementation resumes against the reconciled plan. The user's automatic verification and merge authorization remains in effect after that design gate is satisfied.
