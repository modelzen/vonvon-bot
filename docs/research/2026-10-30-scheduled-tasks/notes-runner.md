# 定时任务调研：调度和运行路径（代码笔记）

2026-10-30 只读代码笔记，基线 dev `e87a49c4`，行号按当时；计划见 `docs/plans/scheduled-tasks.md`，冲突以计划为准。原文英文。

Scheduler and run-path notes for 定时任务. Repo root: `<worktree>` (origin/dev e87a49c4). D/ = `packages/daemon/src`, HM = `D/bot/handle-message.ts`. Line numbers come from grep at this SHA; a few differ from the task's estimates and are corrected where they come up.

# 0. Recommended shape

New files:
- `D/bot/schedule/time.ts` — pure timezone and next-fire math.
- `D/bot/schedule/store.ts` — persistence, the only writer.
- `D/bot/schedule/scheduler.ts` — tick loop with an injected clock and store, plus a `fire` callback.

Existing files that change:
- **HM** gets a new internal method `runScheduled(job)` that returns the run's outcome, plus small "scheduled" branches at about 20 sites (listed in §3.6).
- **D/bot/bridge.ts** creates the scheduler and orders start and stop.
- **D/card/run-card.ts** gets the label (§5).
- **D/agent/entry/registry.ts** gets the `scheduled` turn fact.
- **D/bot/session-title.ts** gets the header constant and its strip regex.

No new dependencies. The daemon's dependencies (`packages/daemon/package.json`) and the lockfile contain no date or cron library (no luxon, date-fns, dayjs, moment, croner, cron-parser, rrule or Temporal polyfill). The repo has no `Intl`/`timeZone` code at all yet.

# 1. Where the scheduler lives, start/stop, tick, clock, time math

## 1.1 Process
One scheduler per bot child process. The supervisor (`D/bot/supervisor.ts` `runSupervisor`) spawns `vonvon daemon run --bot <appId>`. That reaches `runSingle` in `D/cli/commands/run.ts:68`, which calls `startBridge` at `run.ts:118`. Inline single-bot mode (no supervisor) goes through the same `startBridge`, so both modes behave the same.

The per-bot single-instance lock (`acquireSingleInstanceLock`, run.ts:93) guarantees one process per bot, so no cross-process double firing. A new child waits on `BOT_LOCK_BUSY_EXIT` until the old one releases the lock at run.ts:200-205, after its cleanup.

Pass the file the way `droppedFile` is passed: add `schedulesFile?: string` to `BridgeOptions` (bridge.ts:27-38) and pass `botPaths(ownAppId).schedulesFile` at run.ts:118. With no file there is no scheduler, which keeps unit harnesses unaffected (same convention as droppedFile, documented at HM:1059-1061).

## 1.2 Wiring in `startBridge`
Order in bridge.ts: `mergeTiers`, entries, `createOrchestrator` (98-99), `offCrash` (110), the `shutdown` definition (113-141), `orchestrator.initialize` (143), event handlers, `channel.connect()` (205), `orchestrator.replyDropped()` (209), return (219).

- **Create** the scheduler after the orchestrator: `createScheduler({ store, clock: time, fire: job => orchestrator.runScheduled(job), log })`. Share one clock object: create `time` in the bridge and pass it as `createOrchestrator(..., { time })`. The `options.time` parameter already exists (HM:1062).
- **Start** the scheduler right after `orchestrator.replyDropped()` (209). The comment there ("Only once connected: when this start fails, the file stays as it is for the next one") applies equally: no catch-up firing before the long connection is up.
- **Stop**, in `shutdown` (113-141):
  - call `scheduler.stop()` synchronously before `const orchestratorClosing = orchestrator.shutdown()` (126);
  - inside `closing` (127), after `await orchestratorClosing` (130), add `await scheduler.drain()`, which awaits pending store writes such as the 'interrupted' rows written while runs are being interrupted;
  - the whole child must finish inside `CHILD_SHUTDOWN_GRACE_MS = 8000` (D/host/lifecycle.ts:300).
- **Crash:** `onCrashSync` (110) needs nothing new, because the in-flight marker is already fsynced on disk (§2.3).
- **IPC** for desktop and CLI edits (other area): route a new op kind in run.ts:128-140 (`createAdminIpcResponder`) and add `schedules` to `BridgeHandle` (bridge.ts:40-54, return at 219). Inline mode needs an `executeSchedule` in `createAdminService` (run.ts:146-185).

## 1.3 Orchestrator shutdown
`shutdown()` is at HM:9138. It interrupts every active run (HM:9172), clears `state.queue` without calling `askAgain` (HM:9167) and splices deferred input (HM:9171). After that it loops `while (acceptedTasks.size || runTasks.size)` (HM:9188).

Two rules follow from this:
- **Never** put the promise that waits for a scheduled outcome into `trackTask`/`acceptedTasks` (HM:1503-1514). If any path forgets to settle, shutdown hangs until the supervisor's SIGKILL. Track only the run itself (`trackRun`, HM:1529-1533, which the existing paths already use).
- Keep `pendingScheduled = new Set<ScheduledHook>()` in the orchestrator. Right after the drain loop at HM:9188-9191, settle every hook still pending with `{ status: 'interrupted', reason: 'shutdown' }`. Hooks are idempotent: the first settle wins, so a run that really finished during the drain keeps its real outcome.
- Also settle queued scheduled turns explicitly before `state.queue.length = 0` (HM:9167) and before `state.deferred?.splice(0)` (HM:9171).

`runScheduled` must be wrapped like `admit` (HM:1516-1521): it rejects while shutting down, and the scheduler records 'interrupted'.

## 1.4 Clock interface
`IntakeTime { now(); setTimer(fn, ms); clearTimer(h) }` is exported from HM:1047-1051, not from `smart-intake.ts`. smart-intake has the same three members inside `LaneDeps` (smart-intake.ts:63-65). The default implementation is at HM:1230-1234 and calls `timer.unref()`.

Reuse `IntakeTime` as `ScheduleClock`, or move it to a small shared module and re-export it from HM. The test fake to copy is `packages/daemon/test/smart-intake.test.ts:49-60`: a map of handles to `{ fn, at }`, plus `advance(ms)` that fires timers whose `at <= now`. To simulate sleep, bump `now` by hours without firing the timers in between, then advance a little.

## 1.5 Tick design that survives sleep
Node and libuv timers run on the monotonic clock, which stops while the machine sleeps. `D/core/loop-lag.ts:31` says so for this codebase: "Both run on the monotonic clock, which stops while the machine sleeps: a closed lid is no stall." A long `setTimeout` set before a sleep therefore fires late by the length of the sleep.

Design:
- Always arm `setTimer(tick, clamp(nextDue - now, 0, MAX_TICK_MS))` with `MAX_TICK_MS = 30_000`. After a wake, the next tick comes within 30 s of awake time.
- Every tick reads `clock.now()` (wall clock) and recomputes; no wall-clock deadline is cached.
- Wake detection is for logging only: if `now - lastTickAt > armedDelay + 60_000`, log `('schedule', 'wake-gap', { gapMs })`. Correctness does not depend on it, because one rule (below) handles normal ticks, wake and startup.
- The rule, per active task, at time `now`:
  1. `latest = prevAtOrBefore(task, now)`. If `latest <= task.cursor`, there is nothing to do.
  2. Every slot in `(cursor, latest)` becomes one aggregated history row `{ status: 'missed', from, to, count? }`. Do not write one row per slot: a 1-minute task off for 3 days has 4320 missed slots.
  3. If `now - latest <= 7 days`, fire `latest`, with `late = now - latest`. Show "原定 HH:MM" when `late > 60_000` or when firing from startup recovery. Otherwise record `latest` as missed too.
  4. Set `cursor = latest`, so the slot is consumed whatever happens next.
  5. One-off tasks: slot = `at`; after it is handled the task is finished (or "错过" if older than 7 days).
- Previous run still in flight (`task.inflight` or an in-memory running map) → record the slot as 'skipped' and set `cursor = latest`.
- Clock moved backwards: `cursor` never goes down, so nothing fires twice. Clock jumped forward: same as a wake.
- Startup recovery and many due tasks: stagger fires (for example 2-5 s apart) so a laptop opened after a weekend does not post N cards in the same second. A per-chat pacer exists (`pacerFor`, run-card-stream.ts:323), but nothing staggers across chats.
- `MAX_TICK_MS` keeps delays far below `setTimeout`'s 2^31-1 ms limit.

## 1.6 Next-fire math without libraries (Intl only)
Use one cached formatter per time zone: `new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year, month, day, hour, minute, second: '2-digit' })`. Read fields with `formatToParts`. `hourCycle: 'h23'` avoids the "24" hour some engines print at midnight.

The offset at an instant:
```
off(ms) = Date.UTC(fields(ms)) - floor(ms/1000)*1000
```
Wall time to instant, handling DST gaps and folds (I ran this on Node 24.21 in a scratch shell, not in the repo):
```ts
function instantOf(tz, y, m, d, h, mi): { ms: number; kind: 'ok' | 'gap' | 'fold' } {
  const g = Date.UTC(y, m - 1, d, h, mi), H = 36 * 3600e3;
  const oA = off(g - H, tz), oB = off(g + H, tz);              // offsets either side; assumes ≤1 transition in 3 days
  const c = [...new Set([g - oA, g - oB])].filter(t => fieldsEqual(t, tz, y, m, d, h, mi)).sort((a, b) => a - b);
  if (c.length) return { ms: c[0], kind: c.length > 1 ? 'fold' : 'ok' };  // fold → first occurrence
  return { ms: g - oA, kind: 'gap' };                                     // gap → shifted forward by the gap
}
```
Results:

| Zone and wall time | Result |
|---|---|
| America/New_York 2026-03-08 02:30 | gap → 03:30 EDT |
| America/New_York 2026-11-01 01:30 | fold → 05:30Z, the first occurrence |
| Australia/Lord_Howe 2026-10-04 02:15 | 30-minute gap → 02:45 |
| Europe/London 2026-03-29 01:30 | gap → 02:30 |
| Asia/Shanghai | always ok (no DST) |

Policy to state in the plan: a nonexistent time runs once right after the jump; an ambiguous time runs once, at its first occurrence.

Schedule kinds:
- **`interval { everyMs >= 60_000, anchorMs }`**: slots are `anchor + k·every` in elapsed milliseconds, independent of time zone and DST. `prevAtOrBefore` and the missed count are arithmetic.
- **`cron { expr, tz }`**: 5 fields (minute, hour, day of month, month, day of week 0-7), with `*`, lists, ranges and steps. Store daily and weekly as cron (`MM HH * * *`, `MM HH * * D`) with a display kind.
  - Day-of-month and day-of-week use Vixie OR semantics when both are restricted.
  - `next(after)`: walk calendar days from `fields(after + 1 min, tz)`. Do day arithmetic with `Date.UTC(y, m - 1, d + 1)`, and take the weekday from `new Date(Date.UTC(y, m - 1, d)).getUTCDay()`. For each matching day, try the sorted hours and minutes, convert with `instantOf`, return the first one greater than `after`. Cap at about 366×8 days.
  - `prev(atOrBefore)` mirrors this, walking backwards.
  - At creation, reject expressions with no fire in 8 years (for example `0 0 30 2 *`).
- **`once { atMs, tz }`**.

Each task stores its IANA zone, read at creation from `Intl.DateTimeFormat().resolvedOptions().timeZone`. My scratch shell printed `UTC` there, so test with explicit zones.

Probe at startup: `new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai' })` throws a RangeError without ICU time-zone data. The packaged daemon runs on Electron with `ELECTRON_RUN_AS_NODE=1` (`packages/desktop/src/daemon-dependencies.ts:25`).

Display strings ("每天 09:00", "每周一 09:00", "每 30 分钟") go in a `describeSchedule()` in time.ts, used by the header, card label, desktop and CLI.

# 2. Persistence

## 2.1 Path
Add `schedulesFile: join(dir, 'schedules.json')` to `botPaths()` (`D/config/paths.ts:33-58`) and its return type. Add a `get schedulesFile()` getter to `paths` if wanted (pattern at paths.ts:68-78). Use the explicit `botPaths(appId)` form: the comment at paths.ts:24-27 warns against switching `useBotDir` inside the daemon process.

For the Bot-page aggregate, add a read-only `listSchedulesIn(file)` like `listSessionsIn` (session-store.ts:302-306), so the host can read a bot whose child is down.

## 2.2 Atomic write pattern to copy
- **In-process lock:** the promise-chain `withLock` from `D/bot/session-store.ts:309-317`.
- **Write:** durable temp-then-rename, as in `D/bot/role-files.ts:155-163` (`patchState`: tmp named `${path}.tmp-${pid}-${uuid}`, opened `wx` with mode 0o600, `file.sync()`, `rename`, unlink tmp on error). For directory durability also call `syncDirectory(dirname)`, as `D/config/bots.ts:77-100` `publish` does.
- **Not enough:** `session-store.ts` `write` (319-329) does not fsync, and neither does `writeAtomicSync` (`D/host/crash-store.ts:145-152`). The in-flight marker must be fsynced before anything is posted.
- **Validation:** use zod with `.strict()` and size caps, as `D/bot/restart-dropped.ts:35-41` does. A corrupt file is renamed to `.corrupt` (topic-registry.ts:288 does this) and the error is logged. Never silently start empty and then overwrite.
- **Only writer:** the bot child; desktop and CLI go through IPC.
- **Future multi-device:** keep `v`, random task ids, `rev` per task (an optimistic `expectedRev`, like `projectRevision` in `D/admin/collaboration.ts:25`) and `updatedAt`. Do not encode host-local state into ids.

## 2.3 Schema sketch
```jsonc
{ "v": 1, "tasks": [{
  "id": "t_…", "chatId": "oc_…", "name": "…", "instruction": "…",
  "schedule": {"kind":"cron","expr":"0 9 * * 1-5","tz":"Asia/Shanghai"} | {"kind":"interval","everyMs":1800000,"anchorMs":…} | {"kind":"once","atMs":…,"tz":"…"},
  "placement": {"kind":"auto"} | {"kind":"newTopic"} | {"kind":"topic","threadId":"omt_…"},
  "creator": {"openId":"ou_…","role":"owner|admin|member","words":"≤N chars","via":"chat|desktop|cli","messageId":"om_…?"},
  "state": "active|paused|finished|orphaned", "pausedReason": "user|failures|group-gone",
  "rev": 3, "createdAt": …, "updatedAt": …,
  "cursor": <ms of last slot handled>,
  "inflight": {"runId":"…","slot":…,"firedAt":…,"catchUp":true,"manual":true} /* optional */,
  "runCount": 12, "consecutiveFailures": 0,
  "lastResult": {"excerpt":"≤500 code points","at":…,"status":"done","link":{…}} /* optional */,
  "history": [ /* ≤20, newest last */ {"runId","slot","startedAt","endedAt","durationMs","status":"done|failed|timeout|interrupted|refused|skipped|missed","reason","messageId","threadId","position","count","from","to","manual","catchUp"} ]
}]}
```

## 2.4 Avoiding double fire across a crash
**Commit point:** under the store lock, write `cursor = slot`, `runCount += 1`, `inflight = { runId, slot, firedAt }` and fsync, before posting anything or starting a provider. Then call `fire`. On settle, push the history row, clear `inflight`, update `consecutiveFailures` and `lastResult`, fsync.

**Startup:** every task with `inflight` gets a history row `{ status: 'interrupted', reason: 'Vonvon 中途停了' }`, `inflight` is cleared, and nothing is re-run because the slot is consumed. Then the missed-slot rule from §1.5 runs. The guarantee is at most once.

**Feishu idempotency, second line of defence:** derive `uuid = 'vs-' + sha256(appId\ntaskId\nslot\npurpose).slice(0, 40)`, like `droppedUuid` (restart-dropped.ts:127-130). The comment there says Feishu answers one uuid once within an hour, verified 2026-10-16 on the reply API. The SDK's `im.v1.message.create` data accepts `uuid?` (`node-sdk 1.71.1 types/index.d.ts:261716-261720`). Use it on the root text message of a new topic (§3.3), which has the same content on every attempt.

Do not reuse one uuid across `RunCardStream.create` retries: each retry creates a new CardKit entity (run-card-stream.ts:326-365), so a deduplicated send could point at a dead card. If a card uuid is wanted, use it on the first attempt only (UNVERIFIED how Feishu treats a uuid whose first send failed).

## 2.5 Missed slots after a wake
These are handled by the same per-tick rule; no separate path.

# 3. The new orchestrator method and the three placements

## 3.1 Interface
Add `runScheduled(job: ScheduledJob): Promise<ScheduledOutcome>` to `Orchestrator` (HM:866-900) and to the returned object (HM:9244-9269), wrapped like `admit`. Also add a failure-notice method, `noticeSchedule(chatId, threadId | undefined, creatorOpenId, text)`, that posts a `post` message with `{ tag: 'at', user_id }`. The same content shape is used at `D/bot/ask-coordinator.ts:157-158` and `D/bot/completion-reminder.ts:85-88`.

```ts
interface ScheduledHook {
  taskId: string; runId: string; slot: number; label: string;  // card label
  post: 'plain' | { replyTo: string };                         // where cards/notices go when no real trigger exists
  started(at: number): void;                                   // slot acquired / turn_started
  settle(o: ScheduledOutcome): void;                           // idempotent, first call wins
}
type ScheduledOutcome = { status: 'done'|'failed'|'timeout'|'interrupted'|'refused'|'skipped'; reason?: string;
  startedAt?: number; endedAt: number; cardMessageId?: string; threadId?: string; position?: string; answer?: string };
```

Gates in `runScheduled`, read at run time:
1. `project = getProjectByChatId(chatId)`. None → `refused`, and the scheduler marks the task `orphaned`.
2. `project.enabled === false` → `skipped` ("群已停用"), not counted as a failure.
3. `isChatAllowed(cfg, chatId)`.
4. `turnRefusal(project, chatId)` (HM:5049-5055: unbound, disabled, `projectMutations`, `resumePublications`) → `skipped`, transient, not a failure. Optionally retry within the slot for up to 5 minutes.
5. Tier: do **not** call `refuseUnavailableTier` (HM:3007). It posts an explanation replying to `msg.messageId` (HM:3024), which would be the fake id. Use its predicate directly: `tierInfo(permissionTable(be.id), tableEnv(be), turnPerm(project).mode ?? 'full').unavailable` with `be = groupBackend(project)` → `refused`, counted as a failure.
6. `turnPerm(project)` (HM:2990-2994) at run time. That satisfies "current tier"; `resolveThread` also re-reads the project and evicts a live thread whose permission fingerprint changed (HM ~3790-3800).

Placement (pure, at run time):

| Condition | Placement |
|---|---|
| `task.placement.kind === 'topic'` | (c) back into that topic |
| `task.placement.kind === 'newTopic'` | (b) new hidden session in a new topic |
| `await topicCtx.noMainArea(chatId)` (topic-context.ts:208, HM:1742) | (b) |
| `ruleKind(project) === 'single'`, i.e. single or smart (project/registry.ts:137) | (a) main-area session |
| otherwise (multi) | (b) |

## 3.2 The synthetic message, for (a) and (c)
```ts
const msg: NormalizedMessage = {
  messageId: `vsched_${taskId}_${slot}`,  // NEVER the anchor id and never 'om_…' (see wovenSkip below)
  chatId, chatType: 'group', senderId: creator.openId,  // becomes state.requesterOpenId → ⏹ by creator or admin
  content: instruction, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true,
  threadId /* (c) only */, rootId /* (c): the topic's first message id */, createTime: firedAt,
  // no `raw`: fromBot()=false (D/bot/baselines.ts:45), askRequesterKind → 'unknown' (HM:1653-1657)
};
```

Why `requesterKind 'unknown'`:
- `openTurn` sets `human = false` and `kind = 'bot'` (registry.ts:315-318).
- `roleOf` returns `'bot'` (registry.ts:123-127), so memory writes become untrusted (memory-authority.ts:43-50, `botWriteGate` at 92-100).
- `askRequesterKind` returns `'unknown'`, so only the owner and admins are eligible to answer asks (ask-coordinator.ts:72-77).

**Security:** if anyone sets `raw.sender.sender_type = 'user'` (as retry does at HM:5086), `requesterKind` becomes `'user'` with a creator openId and a trigger id. That makes `human = true`, and memory treats the turn as the creator typing. The `scheduled` fact below must force `human = false` regardless.

Call it like the 🔁 retry precedent (HM:5101-5117) and the 👍 continue precedent (HM:9003-9005, with `cardTurnMessage` at HM:8925-8950):
```ts
await handleTurn(msg, instruction, sessionKey, flat, project, turnPerm(project), { queueOnly: true, summary: name, scheduled: hook });
```
`TurnExtra` is defined at HM:768-782. `queueOnly` is read only at HM:3200 (`deliverPreparedTurn`): it never steers, so a busy session queues the turn (HM:3342-3357).

**wovenSkip pitfall** (`wovenSkip` defined at HM:3251-3255, used at 3199 and 3338). If the synthetic id equaled a real message woven into the running turn's record block, as an anchor or the topic root easily is, the scheduled turn would be dropped silently and never settled. Hence the unique `vsched_` id, with the real anchor carried separately in `hook.post`. The unique id is also safe for `recalledSkip` (HM:3244), `markSeen` (bounded and harmless) and dropped.json, whose schema requires `^om_` (restart-dropped.ts:36).

## 3.3 Placement (a): the main-area session of a single or smart group
`sessionKey = chatId`, `flat = true`, `hook.post = 'plain'`. `startReservedRun` (HM:3280-3716) then does everything normally:
- `resolveThread`, model defaults;
- the record block of unread main-area lines (`place = 'main'`, pull `before: msg.createTime`, `excludeMessageId`);
- `triggerAt` (HM:3359-3360), which makes a smart verdict's `mainWillWeave` see the run;
- `markSeen` advance on `turn_started` (HM:7669-7680).

Posting without quoting: `RunCardStream.create` already sends `message.create` to the chat when `opts.replyTo` is falsy (run-card-stream.ts:339-350). `LaunchOpts.replyTo` is required (HM:6935), so keep it, and resolve each send target from the hook (site list in §3.6).

## 3.4 Placement (b): a new hidden session that opens a new topic
**Recommendation:** post a short root text as the bot, then let the run card reply in thread to it. Do not make the card the root. In a normal group, a root card would put the whole streaming output in the main area, and a topic exists only once something replies in thread. This is exactly the desktop-resume precedent at HM:6719-6725: `channel.send(chatId, { markdown })`, `recent.addOwn(...)`, `sendManagedCard(..., root.messageId, true)`, `getThreadId(channel, sent.messageId, 4)`, `noteOpenedTopic(...)`. Desktop startGoal does the same at HM:6843-6844.

Add `startScheduledTopic(job, project, hook)`, cloned from `startTopicDirectly` (HM:3918-4068) with these differences:
- Same synchronous gate and counter: `if (resumePublications.has || projectMutations.has) → settle skipped` (HM:3921-3925), then `pendingTopics++` (3926), decremented in `finally` (4063-4066). `pendingTopics` is what makes the desktop edit lock (HM:6589) refuse during preparation.
- Run in parallel:
  - `threadP` as at HM:3949-3954 (`pickGroupDefault`, `startWith(..., serviceTier: 'standard', profile: await profileOf(project, cwd, be, perm.mode))`; the profile carries persona and memory);
  - `rootP = rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: rootText }), uuid } })`. Check `code === 0` and `data.message_id`, then `recent.addOwn(chatId, chatId, { id, at, text })` so smart judgements see it. `rootText` is something like `⏰ 定时任务「日报」`, plus ` · 原定 09:00` on a catch-up, and also becomes the topic's title;
  - `sectionP` = `pullMainBefore(chatId, rootCreateTime, rootId)` + `mainSection` (HM:3714-3728), skipped when `noMainArea`.
- No image download, `ingestContext` or reaction.
- `firstText = scheduledOpening(job)`: header, instruction, creator and their original words, previous excerpt and link (§3.7). Weave it with `weaveTurnRecordBlock(firstText, undefined, { place: { group, me, topic: { title: topicTitle(rootText) } }, entries: [], now, opening: { pointer, main }, quotes, moreTopics })`, as at HM:3990-4002.
  - Pointer: `TopicPointer` (context-weave.ts:957-966) renders via `pointerLine` (1088-1100). Add a `scheduled?: { name }` variant so the line reads like "这个话题是定时任务「X」按时自动开的", rather than reusing `botOpened`, whose text says "就是下面这条".
- `registerSessionTitle(be, sessionId, cwd, { text: name, rawContentType: 'text' })`.
- Re-check the project revision before launching (HM:4011-4017; the task's "~4045" is 4013 here).
- `launchOpts` as at HM:4019-4060 with:
  - `replyTo: rootId`, `replyInThread: true`, no `knownThreadId` (so `activeKey = 'pending:' + rootId`, HM:7176);
  - `triggerId: msg-like id`, `origin` undefined;
  - `requesterOpenId: creator.openId`, `requesterKind: 'unknown'`;
  - `requestedAt: firedAt`, `seenAt: rootCreateTime`, `from: section.main[0]?.createTime || rootCreateTime`;
  - `openTopic: { id: rootId, from: { kind: 'self' }, at, text: rootText }`;
  - `summary: name`, `scheduled: hook` (`post: { replyTo: rootId }`).
- Topic adoption is existing behaviour: the first card's reply in thread creates the topic. `adoptThreadId(cardMsgId)` (HM:7437-7455) calls `getThreadId(..., 3)` (HM:9277), moves the reservation off `pending:`, `persist`s the session, and calls `noteOpenedTopic` (HM:1700-1704), which calls `attention.replied` and `smartLanes.rearm` and writes the topic registry.
- Topic groups: a root posted with `message.create` in a topic-mode group should itself be a new post, with the reply going into it (UNVERIFIED in this repo).

## 3.5 Placement (c): back into an existing topic and its session
**Anchor:** resolve it live with `desktopTopicReply(chatId, threadId)` (HM:6519-6527). It calls `im.v1.message.list({ container_id_type: 'thread', container_id, page_size: 1 })`, checks the chat and thread ids, and throws "无法定位原飞书话题…" when the topic is gone. Map that error to `failed` ("话题已不在了"); a one-off then ends.

Use the result as `hook.post = { replyTo: anchor }` and as `msg.rootId`. In `startReservedRun`, `rootId` is derived from `msg.rootId` (HM:3428), so a fresh or recreated session gets the topic's first message in its opening. Call `handleTurn(msg, …, sessionKey = threadId, flat = false, …)`.

If the topic's record was archived (`detached`), `getSession` returns undefined and `resolveThread` returns `{ thread: undefined }`. A fresh session is then bound to that topic key with the opening back-fill: fine.

## 3.6 Every site that needs a "scheduled" branch
Plumbing: `TurnExtra.scheduled` (HM:768) carries into `QueuedTurn.scheduled` (HM:505-546, set in the queue push at HM:3342-3357) and into `LaunchOpts.scheduled` (HM:6931-7027, set at HM:3648-3695). In `launchRun`, `currentTurn` (HM:7325-7345) gets `scheduled: opts.scheduled`.

Sites where a reply would target the fake id or a person:
- **`handleTurn`** HM:3117-3121 (`owner.intakeCancelled` sends "请重发") → settle `interrupted`, send nothing.
- **`prepareTurn`**:
  - HM:3139-3143 and HM:3164-3168 (`replyGoalBusy`) → settle `skipped` "目标运行中". A goal session never consumes its queue.
  - HM:3153-3159 (`intakeCancelled` after ingest) → settle.
- **`startReservedRun`**:
  - HM:3307-3315, the deferred `early()` branch → settle `skipped`. The `go()` branch is fine.
  - HM:3316-3329 (goal / `isGoal`) → settle `skipped`.
  - HM:3367: `const reaction = goal || extra?.scheduled ? undefined : runReaction(msg.messageId, …)`. `runReaction` (HM:1856) adds emoji to the trigger.
  - Catch HM:3699-3715: settle `failed`, and send the failure line to `hook.post`, not to `msg.messageId`.
  - `launchOpts.replyTo` (HM:3651): for (c) use the anchor (`hook.post.replyTo`). For (a) keep the synthetic id and let the send sites go plain.
- **`ingestContextImpl`** (HM:3055): early `if (extra?.scheduled) return { text: extra.scheduled.prompt }`. This skips voice, files, quote, `weaveSender` (context-weave.ts:1219-1235; it would label the instruction as sent by the creator just now), the AT hint and notes. Widen the `extra` type at 3032, 3051 and 3055.
- **`memoryTriggerOf`** (HM:1665-1668): return `{}` when `extra?.scheduled`. Otherwise `typedCandidate` (HM:1658-1662) marks the instruction as typed.
- **`originFor`**: keep `origin` undefined for scheduled turns. Otherwise:
  - `collectLost` (HM:9124-9136, line 9127) pushes it to dropped.json at shutdown;
  - `acquireRunSlot` `state.waiting` (HM:7061-7064) does the same; add `&& !opts.scheduled`;
  - `launchRun`'s early shutdown return (HM:7175) and `askAgain` count it as a person.
- **`askAgain`** (HM:1905-1915): `if (turn.scheduled) { turn.scheduled.settle({ status: 'interrupted', reason: why }); continue; }`, before the `people++` count. This covers queue-dropped after a ⏹ (HM ~7917-7928), run-failed (HM:7959) and `acquireRunSlot` `endCard` (HM:7090).
- **`acquireRunSlot`** (HM:7041-7125): the queue placeholder card `stream.create(…, { replyTo: opts.replyTo })` at HM:7066-7069 → plain for (a). Add the task label to `queueCard`. A `null` return (cancelled while queued) is handled in `launchRun` at HM:7195-7198 → settle `interrupted`.
- **`launchRun`**:
  - HM:7175 early shutdown → settle `interrupted`; HM:7199-7206 (shutdown after slot) → same.
  - HM:7356-7361 `openTurn` facts: add `scheduled: currentTurn.scheduled && { taskId, runId }`.
  - HM:7422-7435 `rc`: add `taskLabel`. Never set `initiativeCard`, so `dropSilentCard` (HM:7130-7155) never deletes a scheduled card.
  - HM:7489 `stream.create(channel, chatId, card, { replyTo, replyInThread })`: for a scheduled `currentTurn` with `post === 'plain'`, use `{ replyTo: undefined, replyInThread: false }`. A queued turn otherwise quotes the previous card, because `replyTo = finalMsgId` at the end of each turn (~7895).
  - HM:7629-7630 `askTurn` placement: `replyTo: currentTurn.scheduled ? cardMsgId : (currentTurn.seen?.id ?? opts.replyTo)`. Asks keep the 15-minute timeout (ask-coordinator.ts:155).
  - HM:7792-7799 `retryTurns.set`: skip for scheduled, so no 🔁 button. A retry would replay the "nobody is present" prompt as a human turn.
  - HM ~7840-7852 `sendCompletionReminder`: skip for scheduled. With `'unknown'`, the non-smart path can still @ the requester (completion-reminder.ts:51-72).
  - `completionReminderView` (HM:1793) / `reminderButtonOffered` (completion-reminder.ts:37-43): hide the 🔔 button for scheduled. Add `ActiveState.scheduled` or check it in `rc` construction.
  - Catch HM:7955-7975: settle `failed` for `noted?.scheduled`; the failure message (HM:7972-7974) goes to `hook.post`.
  - Finally HM:7976-8001: safety settle `interrupted` if not yet settled.
- **`shutdown`** HM:9167 and 9171, and the final sweep (§1.3).

## 3.7 The 'scheduled' turn fact and the prompt header
- **`D/agent/entry/registry.ts:7-18`:** add `scheduled?: { taskId: string; runId: string }` to `TurnFacts`. In `openTurn` (313-327): `human: … && !facts.scheduled`, and `kind: facts.scheduled ? 'bot' : …` (or add `'scheduled'` to `MemoryTurn['kind']` in memory-authority.ts:10; `isHuman` treats every non-human kind alike).
- **`D/agent/entry/tools.ts:6-20`:** add `scheduledTaskId?: string` to `ToolContext`, filled in `registry.ts` `execute()` (~229) from `auth.facts.scheduled`. Settings tools already refuse group turns and non-human turns (`authorizeNow`, registry.ts:98-107). The task tools need the current place at turn time; a new topic's thread id is unknown at `openTurn` and only appears after `adoptThreadId`, so pass a getter (for example `facts.where = () => topicThreadId`).
- **Header**, next to `INITIATIVE_NOTE` (`D/bot/session-title.ts:39`): export `SCHEDULED_NOTE({ name, scheduleText, nth, plannedHHMM, actualHHMM })`, one line in fullwidth brackets, for example:
  > （定时任务「日报」· 每个工作日 09:00 · 第 12 次 · 原定 09:00，09:03 开始。现在没有人在场：不要提问，不要等人确认，做完把结果写出来。）
  - Add an anchored `BRIDGE_SCHEDULED_PREFIX` regex and include it in `stripBridgeMessageEnvelope` (session-title.ts:78-93), so session titles and previews drop it.
  - Sanitize the name with `sanitizeContext(name, 30, true)` (context-weave.ts:833).
  - Run the instruction and the previous excerpt through `escapeInboundMarkers` (hidden-blocks.ts:287), as the inbound path does at HM:2620. The previous excerpt is earlier model output: present it as quoted material.
- **Existing session, (a) and (c):** `SCHEDULED_NOTE` + `\n\n` + instruction. The record block is still woven around it by `startReservedRun`.
- **New session, (b):** the header, the instruction, `创建人：<name>（open_id …）原话：「…」`, and `上一次的结果（前 500 字）：…` with its link.

# 4. Learning the outcome for history

## 4.1 Where to hook
Per turn in `launchRun`, because a queued scheduled turn may run inside someone else's run loop (`currentTurn = state.queue.shift()`, HM:7945):
- **start:** `hook.started(Date.now())` after the slot is acquired (`reaction?.started()`, HM:7208), or at `turn_started` (HM:7669).
- **terminal:** known after `settleOrdinaryTurnRender(…)` (HM:7741-7748) and `rc.rs = segmentSnapshot()`. The `interrupted`, `timedOut`, `killed` and `procDead` flags are computed at HM:7736-7740.
- **settle:** call it just before `retrySessionTitleAfterTurn()` (HM:7892), so it happens after terminal delivery and is recorded even if delivery throws. Use `finalMsgId` (HM:7777). Hoist `answerText` (HM:7811) into a `let` outside the inner `try`.

## 4.2 Status mapping
| Condition | Status |
|---|---|
| `interrupted` (⏹, graceful or forced) | 'interrupted' (`reason: 'shutdown'` when `shuttingDown`) |
| `rs.terminal === 'done'` | 'done' |
| `'error'` | 'failed' (`reason: rs.errorKind` / `rs.errorMsg`) |
| `'idle_timeout'` | 'timeout' |
| Thrown before or after card creation (catch HM:7955) | 'failed' |
| Gate refusals (§3.1) | 'refused' / 'skipped' |

## 4.3 Duration
`endedAt - startedAt`. `doneAt` is at HM:7727, `turnStartAt` at HM:7408, and `RunState.startedAt` / `completedAt` are in run-state.ts:89-90.

## 4.4 Final text
`finalMessageText(rc.rs)` (D/card/run-state.ts:132-138; the HM call is at 7811). Hidden blocks are already removed by `hiddenBlockFilter`. For the excerpt use `Array.from(redactTokens(text)).slice(0, 500).join('')` (`D/core/token-redact.ts:11`).

If a person steers into a running scheduled turn, `splitCard` (HM:7543-7600) rotates `cardMsgId`. Record the turn's first card id, captured at HM:7489, as the history link, and the last card's text as the excerpt.

## 4.5 Feishu link
- Extend `RunCardStream.create` (run-card-stream.ts:317-365) to keep `data.message_position`, `data.thread_message_position` and `data.message_app_link` from the create and reply responses. The SDK types list them (types/index.d.ts:261763-261764 and ~261844). Expose `stream.linkInfo()`.
- Store raw `{ messageId, threadId?, position? }` in history and build URLs in the UI:
  - main area: `https://applink.feishu.cn/client/chat/open?openChatId=…&position=…`, as `messageLink()` in `D/bot/outbound-files.ts:82-88` builds it (not exported; export it or move it to utils);
  - topic: `groupUrl(chatId, threadId)` in `packages/ui/src/url-actions.ts:88-92` (`/client/thread/open?...&thread_position=0`);
  - the UI's `allowedExternalUrl('group')` (url-actions.ts:36-39) already allows both paths.
- `topicThreadId` is known after adoption (HM:7437-7455; it is `rc.threadId`).

# 5. Card label
`D/card/run-card.ts`:
- Add `taskLabel?: string` to `RunCardState` (107-172).
- Render it as `noteMd(taskLabel)` right after the meter, in the same slot as `sessionNotice`: `renderRunning` HM-equivalent lines 256-260 and `renderTerminal` 332-335.
- `buildRunCard` (223-229) could prefix the chat-list summary (`card(..., { summary })`).
- `buildRunCardPlain` (448-450) and `splitCard` (HM:7550-7558, `...rc`) keep the label automatically.
- Also add `taskLabel?` to `QueuedCardState` (453-477) and to `buildQueuedCard` (482-503), so the "⏳ 排队中" placeholder is labelled. `acquireRunSlot`'s `queueCard` builder is at HM:7049-7055.
- Label text: `⏰ 定时任务「name」`, plus ` · 原定 HH:MM` on a catch-up or a late fire, plus ` · 手动运行` for run-now.

# 6. Smart mode and multiple bots

- **(b) new topic:** `noteOpenedTopic` already calls `attention.replied` (HM:1700-1704) when the topic is adopted, exactly as human-triggered topics do.
- **(a) smart main area:** minimal hook in `runScheduled` on settle:
  ```ts
  if (sessionModeOf(project) === 'smart' && o.status === 'done' && o.answer?.trim()) attention.replied({ chatId, place: chatId }, time.now());
  ```
  This mirrors the landing at HM:2467: focus for `mainFocusMs = 10 min` (attention.ts:26 and 209-211), so replies to the scheduled post get judged quickly. The judge already sees the bot's words through `recent.addOwn(topicThreadId, …)` (HM:7814).
- No `takeUpTo` is needed: while the run is reserved, `triggerAt` (HM:3359-3360) feeds `mainWillWeave`; after `turn_started`, the `markSeen` advance makes `alreadySeen` true.
- **Multiple bots:** fully independent. Each child has its own store file, scheduler, semaphore (`new Semaphore(getMaxConcurrentRuns(cfg))`, HM:1469; default 10, config/schema.ts:235-239) and attention. Bot A's scheduled card reaches bot B as a bot message, which wakes B only in a smart group when it @-mentions B (HM:2524). Card and markdown `<at>`s of bots are stripped by the at-guard (HM:1499-1502). The smart `handOff` (HM:6862) still works for scheduled turns in smart groups.

# 7. Gotchas

1. **Desktop edit lock is global.** `editProject` / `removeProject` refuse when `active.size > 0` (HM:6589): any active run of this bot in any group. `libraryWorkspaceCheck` does the same (HM:9225). A frequent task makes desktop edits fail with "Agent 正在执行任务". Options: (i) accept it; (ii) give `ActiveState` a `chatId` and narrow both checks to the edited chat; (iii) hold scheduled firing for a chat while the desktop edits it. `turnRefusal` already refuses during `projectMutations`, but the lock is the opposite direction.
2. **Shutdown with runs in flight:** record 'interrupted' (§1.3; HM:9167, 9171, 9172, 9188). Interrupted does not count toward the 10 failures.
3. **Group unbound, deleted or bot removed.** Three removal sites all call `forgetAttention(chatId, 'unbind')`: DM 解绑 (HM:5738-5739), desktop `removeProject` (HM:6597-6602), bot-removed event (HM:8905-8906; `forgetAttention` is at 2009). Add a `schedules.groupGone(chatId)` call there (delete, or mark `orphaned`; owner decision). The fire-time "no project" check is the safety net for removals done outside the child (library or host paths). `enabled === false` → 'skipped', not a failure.
4. **One-off topic deleted** → `desktopTopicReply` throws → 'failed' "话题已不在了"; the task finishes.
5. **Tier change:** handled at run time (§3.1). Tier unavailable on the backend → 'refused', counted as a failure. A model no longer allowed throws at HM:7394-7396, caught → 'failed'. A session open in the terminal or Codex app (`SessionInUseError`, HM:3842) → 'failed'.
6. **Bot removed but not yet unbound:** Feishu sends fail → 'failed' until the removal event unbinds it.
7. **Daemon off for days:** at most one catch-up per task, if within 7 days; everything else becomes one aggregated 'missed' row. Stagger catch-ups.
8. **Network down on a laptop:** with a 1-minute task, 10 consecutive failures arrive in 10 minutes and auto-pause it. Consider not counting failures that are "Feishu unreachable before any card" (owner decision).
9. **Session busy with `/goal`:** the queue is never consumed (HM:3139, 3325) → 'skipped'. `/compact` or `/new` holding the session → deferred, then runs (HM:3307).
10. **Don't call** `refuseUnavailableTier`, `replyGoalBusy`, `denyGoal` or `runReaction` with the synthetic message; they all post or react to `msg.messageId`.
11. **ID hygiene:** the synthetic id must not equal any real message id (wovenSkip), and the anchor must be passed separately.
12. **Retry and continue on scheduled cards:** hide 🔁 (HM:7792). 👍 continue (HM:9003) stays a normal human turn, which is fine.
13. **Placement is decided at run time:** a group switched between multi and single after creation follows its current mode.
14. **Dropped-replies file:** keep `origin` / `waiting` unset for scheduled turns, or the next start replies "刚才重启了，请再发一次" to a non-message.

# 8. UNVERIFIED
- Whether Feishu honours `uuid` on `im.v1.message.create`. The type has it; only reply was verified (restart-dropped.ts:126). Also how a uuid behaves after a failed first attempt.
- That `message_position` / `message_app_link` are populated in responses for interactive (card) messages.
- Topic-mode groups: whether `message.create` creates a new post, and whether the create response carries `thread_id`. HM:9273 says the reply response omits it, so keep `getThreadId`.
- Lark-tenant applink host (`applink.larksuite.com`?); the repo hardcodes `applink.feishu.cn`.
- That Electron's ELECTRON_RUN_AS_NODE runtime has full ICU time-zone data (add the startup probe), and the exact libuv clock source on macOS. The design does not depend on either.
- App Nap or timer throttling of the launchd-run daemon on macOS.

# 9. Owner decisions the plan should list
- Interval anchor: creation time, or a chosen start.
- What happens to tasks when the group is unbound: delete, or keep paused as "orphaned".
- Whether network or Feishu-unreachable failures count toward the 10.
- Whether a creator who has left `allowedUsers` still has their tasks run.
- Whether a run that fails before any card posts a short line in place (recommended, since "no silent runs") or only writes history.
- Whether to narrow the global desktop edit lock.
