# 定时任务调研：桌面端、网页和协议（代码笔记）

2026-10-30 只读代码笔记，基线 `e87a49c4`。计划见 `docs/plans/scheduled-tasks.md`，冲突以计划为准。原文英文。

The tasks tab should be a new list-and-dialog component, not a variant of the memory tab: the memory tab is a mind map, not a list. These notes are from reading the detached worktree `<worktree>` (origin/dev e87a49c4). Nothing was built, tested or edited. Line numbers are at that sha. U = `packages/ui/src`, P = `packages/protocol/src`, C = `packages/client/src`, DK = `packages/desktop/src`, D = `packages/daemon/src`.

# Desktop/web UI, protocol and data flow for 定时任务 — implementation notes

## 0. Main recommendations

- **No list pattern to copy from memory.** Copy three existing patterns instead:
  - `management/McpPanel.tsx` for the list, the create/edit dialog, conflicts and the delete confirmation.
  - `management/ConversationPanel.tsx` for history rows with "在飞书打开" and live polling.
  - `MemoryMap.tsx` for polling that stops while a draft is open, and for dropping stale replies.
- **Add a dedicated top-level RPC method `schedule`**, the way `memory` and `contextPreview` were added. Don't fold it into `collaboration`: that requires `projectName` in every request and refuses everything unless the bot is running (`D/server/rpc/collaboration.ts:88`).
- **Return refusals as reply kinds, not thrown errors.** In the Electron app, a thrown RPC error reaches the page with its message only; the code is lost (`DK/facade.ts:18-23`). Memory already does this (`P/memory.ts:131-165`).
- **Put the schedule maths and wording in `P/schedule.ts`** (spec schema, next-slot calculation, Chinese description). UI, CLI, daemon and the card label then share one implementation, as `P/display.ts` already does for times. With that, the form's "下次运行" preview needs no RPC. The daemon still re-validates on every write.

## 1. UI: tabs, routing, components to copy

### 1.1 GroupWorkspace (`U/GroupWorkspace.tsx`)

| Line | What is there now | Change |
|---|---|---|
| 24 | `GroupDesignTab = GroupSettingsTab \| 'memory'` | add `\| 'tasks'` |
| 25 | `groupDesignTabs` = 模型与权限 / 能力 / 沟通方式 / 记忆 | append `['tasks','任务']`. Order is not yet in `docs/product.md` 3.1 item 7 (line 76); update it there. |
| 26-53 | `groupTabForSection`; the default case returns `'capabilities'` | add `case '任务': case '定时任务': return 'tasks';`. Without it, search results for 任务 land on 能力. |
| 64, 96 | normalise `initialTab` (`role`→memory, `permission`→model) | no change; `'tasks'` passes through |
| 128 | `available = agent.running && !!project && !member.stale` | reuse as the write gate |
| 134 | `conversation` (pending ?? project kind ?? member) | pass to the tasks tab for the placement label |
| 164-167 | tab nav with `NavigationIndicator activeIndex={findIndex}` | works for 5 tabs (it measures each button). Narrow CSS is `U/group-workspace.css:21-22, 57-58, 66`. |
| 173-175 | `tab === 'memory' ? <ProjectMemoryMap/> : <GroupDesignSettings tab={tab}/>` | becomes `tab === 'memory' ? … : tab === 'tasks' ? <section id={settingAnchor('任务')} aria-label="任务"><GroupTasks …/></section> : <GroupDesignSettings tab={tab}/>`. TS forces this: `GroupDesignSettings.tab` is `GroupSettingsTab`. |
| 176 | history dialog shows "Bot 运行后可查看对话记录。" | precedent for the bot-stopped wording |
| 178 | 解除群绑定 `ConfirmDialog` | description should say what happens to this group's tasks (open question 2) |

Proposed props: `GroupTasks({member, agent, group, conversation, platform, onOpenApplication?})`. It gets the client and shell from `useClient()` / `useShellCapabilities()` (`U/client-context.tsx:31-39`), and protects its form with `useDraft` (`U/settings/DraftGuard.tsx:95-99`). Tab switches already go through `guard.navigate` (line 166).

### 1.2 App.tsx and Bot page tabs

- `DetailTabs` (`U/App.tsx:124-129`) is unused dead code.
- `BotDetailTabs` (`App.tsx:130-136`) hard-codes 群聊 / 记忆 / 设置, and `activeIndex` is `groups?0:profile?1:2`. Add `{kind:'tasks', label:'任务'}` and compute the index with `findIndex`.
- `AgentPane` (`U/collaboration-navigation.ts:6`) becomes `{kind:'groups'}|{kind:'profile'}|{kind:'settings'}|{kind:'tasks'}`.
- `routeDetail` (lines 37-41) only maps `settings`, so the render branch at `App.tsx:768` must test `route.pane.kind === 'tasks'` first. Otherwise the tasks pane falls through to `<BotGroupList>`. Target shape: `profile ? <BotMap/> : tasks ? <BotTasks agent snapshot onOpen=…/> : detail.kind !== 'agent-settings' ? <BotGroupList/> : settings`.
- Optional deep link from search: `routeFromSearch` (`collaboration-navigation.ts:80`) plus a new `SearchReveal` value (`U/search.ts:8`).
- Opening a group on its tasks tab: copy `openGroupNewMemory` (`App.tsx:365-376`). It sets `groupTabs[memberId]` (state at line 179), sets a focus token (`newMemoryFocus`, line 180, used at 854) and calls `openMembership` (`collaboration-navigation.ts:49-66`). That function keeps the agent pane as the parent, so Back returns to the Bot's 任务 pane. Add `openGroupTasks(memberId, taskId?)` with a `taskFocus` token passed as a prop.
- `GroupWorkspace` is mounted at `App.tsx:853-859` with `initialTab={searchTarget ? groupTabForSection(...) : groupTabs[member.id]}`.

### 1.3 Closest existing patterns

**The memory tab is not a fit.** `ProjectMemoryMap` (`U/ProjectPage.tsx:86`) → `MemoryMap` (`U/MemoryMap.tsx:55`) is a mind map. Borrow only:
- polling and stale-reply handling: `reload` with a `serial` ref and `sameJson` cache (95-118), a `draftOpen` ref that skips polls while editing (92), and an 8-second poll while the page is visible (122-125, comment: "What the bot writes does not change the snapshot: look again while the page is open");
- revision conflicts that keep the draft (`memory-map-runtime.test.tsx` "freezes the original revision through a conflict").

**List, create/edit and delete: `McpPanel.tsx`.**
- `refresh` with a `sequence` ref (35-63);
- `add` maps conflict and failure (66-75); `remove` uses the revision it saw (76-89);
- header row with refresh `IconButton`, "添加" `Button` and `InlineNotice` on read failure (90-107);
- `McpEntries`: `<details>` rows with a `<dl>` and per-row action buttons (109-125);
- `AddMcpDialog`: `Dialog` + `FormField` + `SettingChoices segmented`; validation runs before sending; a conflict keeps the draft and offers "重新读取并保留草稿"; `useDraft(dirty||pending, {title, discard})` at 171 (127-185);
- `ConfirmDialog tone="danger"` with `pending` and `error` (103).

**History rows: `ConversationPanel.tsx`.**
- `shortTime` / `fullTime` (13-16);
- a 3-second poll only while a run is live (76-87);
- `execute()`: busy → reply → notice → refresh (89-108);
- history rows (170-180), including `<Button size="sm" variant="ghost" onClick={() => openExternalUrl(groupUrl(groupId, threadId),'group',shell)}>在飞书打开<ArrowUpRight/></Button>` at 179;
- note at 196; error, notice and warning `InlineNotice`s at 198-200.

**Read, retry and readonly:**
- `GroupSettingsLoader` (`U/settings/GroupDesignSettings.tsx:62-82`): serial ref, plus `InlineNotice tone="warning" title="读取未完成"` with a retry `IconButton` (79) and "正在读取…" `<p className="gd-empty" role="status">`.
- `useSecrets` (`U/management/SecretsPanel.tsx:18-36`): re-reads on window `focus` / `visibilitychange`, at most once a second.

**Row list look:** `BotGroupList.tsx:23-64` (SettingsGroup with a label and count, an action button, a footer; mode labels at line 40: threads 独立话题, shared 连续交谈, smart 智能).

**Reference components:**
- `U/reference/components/ui/index.tsx`: `Button` (38: variant primary/secondary/ghost/danger, `loading`, `icon`), `IconButton` (56, `label` required), `StatusBadge` (104: tone, `variant="pill"`), `EmptyState` (184), `InlineNotice` (201: title, tone, actions), `FormField` (224: label, description, error, htmlFor), `Toggle` (278), `NumberStepper` (314: min/max/step), `SelectControl` (452), `SegmentedControl` (616), `ChoicePills` (706, single-select only).
- `Dialog.tsx`: `Dialog` (22: size sm|md|lg, footer, initialFocusRef), `ConfirmDialog` (153: children, error, pending, tone).
- `system-settings/index.tsx`: `SettingsGroup` = `PreferenceGroup` (129: label, action, footer, id), `SettingsRow` = `PreferenceRow` (178: title, description, value, trailing, onClick shows a chevron).
- `U/settings/SettingChoices.tsx` (segmented radios).

**Other helpers:**
- `U/url-actions.ts`: `groupUrl(groupId, threadId?)` (87-92; thread link only for `omt_` ids), `openExternalUrl(url,'group',shell)` (56-61). The `'group'` allowlist (36-39) checks only host `applink.feishu.cn` and path `/client/chat/open` or `/client/thread/open`. A message link with `&position=` therefore passes.
- Daemon-side message-link builder: `messageLink()` in `D/bot/outbound-files.ts:82-88` (not exported). It builds `https://applink.feishu.cn/client/chat/open?openChatId=…&position=<message_position>`. Export it or move it to a shared module, and store the link on each run.
- `P/display.ts:20` `formatTime(ms, {timeZone})` gives "14:05" today, "10月18日 14:05" this year.
- `P/crash.ts:26` `formatUptime(ms)` gives "3 分 12 秒" (reuse for run duration).
- `U/setup/service-toggle.tsx:36-38` `deviceTitle(platform)` gives 这台 Mac / 这台 Linux 主机 / 这台电脑.

### 1.4 New files

- `U/schedule-model.ts` (pure): draft↔spec conversion, `draftProblem()` validation, placement, status and run-status labels, `runLink(groupId, run)` = `run.messageLink ?? (run.threadId ? groupUrl(groupId, run.threadId) : undefined)`, `canWrite`.
- `U/GroupTasks.tsx` + `U/group-tasks.css`: the `useGroupSchedules` hook, the list, `TaskDialog` (create and edit share one dialog), `TaskRuns`, delete `ConfirmDialog`.
- `U/BotTasks.tsx`: the aggregate, grouped by group using snapshot names and `GroupAvatar`. A row opens `openGroupTasks`.
- `U/search.ts`:
  - add to `membershipGroups` (41-56): `{title:'任务', aliases:['定时任务','定时','例行任务','计划任务','提醒'], fields:[item('新建任务',['添加任务']), item('立即运行'), item('运行记录',['运行历史'])]}`;
  - map `'任务'` in `groupTabForSection`;
  - the existing alias `任务卡片` on 消息与提醒 (line 55) will also match a search for 任务, which is acceptable.

## 2. Protocol, client and data flow

### 2.1 Current state

**Snapshot loop:**
- The host rebuilds every 5 s (`D/server/snapshot.ts:185`; tools every 60 s, 186). `build()` (121-153) deep-compares with revision and observedAt zeroed (145-147) and publishes only on change (151).
- The snapshot is sent as WS `event: snapshot`. Events are only `snapshot`, `log` and `backendInstall` (`P/events.ts:11-15`); there is no per-feature push.
- The client keeps only higher revisions (`C/client.ts:163-174`); the UI subscribes at `U/App.tsx:273-283`.
- Every mutation RPC rebuilds the snapshot before replying (`D/server/http.ts:147-157` `finish`). Errors are also sent after a rebuild (182-186).
- The host already reads per-bot files on every rebuild (`D/server/recent-conversations.ts:6-21` reads `bots/<appId>/sessions.json`). That is precedent for host-side reads of a child-owned file.
- A child can already wake the host: the child sends `{fcb:'fcb.connection'}` (`D/cli/commands/run.ts:119`) and the supervisor calls `api?.invalidate()` (`D/bot/supervisor.ts:294-297`).

**Memberships and topic groups:**
- Memberships carry `agentId`, `groupId`, `name` (project name), `conversation` (threads/shared/smart), `enabled?` and `stale` (`P/domain.ts:161-181`).
- The UI cannot tell a topic-style group apart: that is looked up at run time in `D/bot/topic-context.ts:173-174`. The daemon must therefore return the resolved placement.

**Write path today (collaboration):**
1. UI `client.collaboration`;
2. `D/server/rpc/collaboration.ts:76-121` (`requireRunningAgent` at 88);
3. `AdminService.collaboration` (`D/admin/service.ts:121`, implementation 664-671, dep `executeCollaboration` 456);
4. supervisor `executeCollaboration` → `child.ipc.call({kind:'collaboration',request},180_000)` (`supervisor.ts:522-527`);
5. child responder (`run.ts:126-141`) → `handle.collaboration` (`D/bot/bridge.ts:41-55, 219`) → `Orchestrator` (`D/bot/handle-message.ts:869-895`; return object 9253-9271; mutations wrapped in `admit()`).

IPC: the op union is `D/admin/ipc.ts:27`; the default timeout is 15 s (45-46); only codes ADMIN_WRITE_REJECTED, GROUP_UPSTREAM, INVALID_GROUP_INPUT and CREATED_UNSAVED survive the IPC hop as typed errors (104-105). The standalone single-bot mode wires the same calls separately (`run.ts:147-188`).

**Errors:**
- Thrown errors become `{type:'error', code, message}`, with codes from `D/server/errors.ts:15-22`; the client raises `RpcError(code, message)`.
- An unknown method from a newer UI to an older daemon gets `code:'unknown_method'`, message "未知 RPC 方法。" (`D/server/ws.ts:92-95`).
- In the desktop app the code does not reach the page (`DK/facade.ts:18-23`), so match on the message or use reply kinds.
- UI convention: `catch (e) { setError(e instanceof Error ? e.message : '…') }`, then show an `InlineNotice`.
- Read-only preview process: `service.readonlyPreview` makes writes throw `NotWiredYetError` (`D/server/rpc/memory.ts:12-17`).

### 2.2 Wiring a new `schedule` method (files to touch, following memory and contextPreview)

1. `P/schedule.ts` (new) and export it from `P/index.ts`.
2. `P/rpc.ts`:
   - add `method:"schedule"` to `requestSchema` (15-27);
   - add `scheduleResponse` and append it to `responseSchema` **and to the explicit tuple type on line 41** (it exists because of TS7056).
3. `C/client.ts`:
   - interface (29-46): `schedule(request: ScheduleRequest): Promise<ScheduleReply>`;
   - `replySchemas` (48-54): `schedule: scheduleReplySchema`;
   - binding (175-184): `schedule: request => send("schedule", request)`.
4. Desktop:
   - `DK/ipc-contract.ts:8-35`: `schedule: 'desktop:client:schedule'`;
   - `DK/bridge.ts:274`: `register(desktopChannels.schedule, 1, v => scheduleRequestSchema.parse(v), v => client().schedule(v))`;
   - `DK/facade.ts:185`: `schedule: r => callClient(desktopChannels.schedule, v => scheduleReplySchema.parse(v), r)`.
5. `D/server/http.ts:159-180`: `case 'schedule': return finish(peer, await scheduleRpc(options.service, request.payload, peerKind), …)`. New `D/server/rpc/schedule.ts`:
   - `READS = {list, listBot}` return `{kind:'read'}`;
   - other types are mutations;
   - `readonlyPreview` refuses writes;
   - writes require a running agent (`D/server/rpc/ownership.ts:4-7`).
6. `D/admin/service.ts`: `schedule?(botId, op)` in the interface (118-121), `executeSchedule` in deps (451-460), implementation next to `collaboration` (664).
7. `D/bot/supervisor.ts`, next to 522: `executeSchedule` (same guards and paused message), timeout about 15 s.
8. `D/admin/ipc.ts:27`: add `AdminScheduleOp = {kind:'schedule'; request: ScheduleRequest; via:'desktop'|'web'|'cli'}`.
9. `D/cli/commands/run.ts`:
   - responder (127-140): `if (op.kind==='schedule') return handle.schedule(op)`;
   - standalone `createAdminService` (147-188): `executeSchedule`.
10. Bridge and orchestrator: `BridgeHandle` / `Orchestrator`: `schedule: admit(scheduleExecute)`, which calls the shared command core with `actor = {role:'owner', via}`.
11. Recording who created a task: the server parses `hello.clientKind` (desktop/web/cli; `C/transport-browser.ts:58`, `C/transport-local.ts:31`, `DK/attach.ts:74`) at `ws.ts:66-77`, but does not store it on `Peer` (`ws.ts:8-10`). Store it so the RPC can stamp `creator.via` without trusting a request field.

### 2.3 Proposed protocol types (P/schedule.ts, zod 3.25 like the rest of protocol)

```ts
export const SCHEDULE_NAME_MAX = 40, SCHEDULE_INSTRUCTION_MAX = 4000 /* = startGoal objective, P/collaboration.ts:29 */,
  SCHEDULE_RUNS_KEPT = 20, SCHEDULE_EXCERPT_MAX = 500, SCHEDULE_FAILURES_TO_PAUSE = 10, SCHEDULE_CATCH_UP_DAYS = 7;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const wallClock = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/); // in the task's timezone
const timeZone = z.string().min(1).max(64).refine(z => { try { new Intl.DateTimeFormat('en',{timeZone:z}); return true; } catch { return false; } });
export const scheduleSpecSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("once"), at:wallClock}).strict(),
  z.object({kind:z.literal("every"), every:z.number().int().min(1).max(10_080), unit:z.enum(["minute","hour"])}).strict(), // >= 1 min
  z.object({kind:z.literal("daily"), time:hhmm}).strict(),
  z.object({kind:z.literal("weekly"), days:z.array(z.number().int().min(1).max(7)).min(1).max(7), time:hhmm}).strict(), // ISO 1=周一
  z.object({kind:z.literal("cron"), expression:z.string().trim().min(9).max(120)}).strict(), // 5-field
]);
export const schedulePlacementSchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("follow")}).strict(),     // 跟着沟通方式
  z.object({kind:z.literal("newTopic")}).strict(),   // creator said “开个话题发”
  z.object({kind:z.literal("topic"), threadId:z.string().regex(/^omt_[A-Za-z0-9_-]+$/)}).strict(), // one-off created in a topic
]);
export const resolvedPlacementSchema = z.enum(["main","newTopic","topic"]);
export const scheduleCreatorSchema = z.object({
  via: z.enum(["chat","desktop","web","cli","agent"]),           // agent = the bot's own follow-up
  role: z.enum(["owner","admin","member","bot"]),
  openId: z.string().optional(), name: z.string().max(100).optional(), // name captured at creation; UI cannot resolve open ids
  words: z.string().max(2000).optional(),                          // creator's original words
});
export const taskRunSchema = z.object({
  id: z.string(), trigger: z.enum(["schedule","catchUp","manual"]),
  scheduledFor: z.number(), startedAt: z.number().optional(), endedAt: z.number().optional(),
  status: z.enum(["queued","running","succeeded","failed","skipped","missed"]),
  count: z.number().int().positive().optional(), until: z.number().optional(), // collapses consecutive missed/skipped slots
  error: z.string().max(200).optional(), threadId: z.string().optional(), messageLink: z.string().url().optional(),
});
export const scheduledTaskSchema = z.object({
  id: z.string().regex(/^tsk_[0-9a-z]{8,32}$/), botId: agentIdSchema, groupId: groupIdSchema,
  name: z.string(), instruction: z.string(), schedule: scheduleSpecSchema, timezone: timeZone,
  placement: schedulePlacementSchema, resolvedPlacement: resolvedPlacementSchema.optional(), // only from a running child
  status: z.enum(["active","paused","autoPaused","done"]), consecutiveFailures: z.number().int().nonnegative(),
  creator: scheduleCreatorSchema, createdAt: z.number(), updatedAt: z.number(), revision: z.number().int().min(1),
  anchorAt: z.number().optional(), nextRunAt: z.number().optional(),
  runCount: z.number().int().nonnegative(), runs: z.array(taskRunSchema).max(SCHEDULE_RUNS_KEPT),
});
const target = {botId: agentIdSchema, groupId: groupIdSchema};
const ref = {...target, taskId: z.string().min(1).max(64), revision: z.number().int().min(1)};
const fields = {name: /*1..40 code points*/, instruction: /*1..4000*/, schedule: scheduleSpecSchema, timezone: timeZone.optional(), placement: schedulePlacementSchema};
export const scheduleRequestSchema = z.discriminatedUnion("type", [
  z.object({type:z.literal("list"), ...target}).strict(),
  z.object({type:z.literal("listBot"), botId:agentIdSchema}).strict(),
  z.object({type:z.literal("create"), ...target, ...fields}).strict(),
  z.object({type:z.literal("edit"), ...ref, ...partial(fields)}).strict(),
  z.object({type:z.literal("pause"), ...ref}).strict(), z.object({type:z.literal("resume"), ...ref}).strict(),
  z.object({type:z.literal("delete"), ...ref}).strict(), z.object({type:z.literal("runNow"), ...ref}).strict(),
]);
export const scheduleReplySchema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("list"), tasks:z.array(scheduledTaskSchema), botRunning:z.boolean(), machineTimezone:z.string(), observedAt:z.number()}),
  z.object({kind:z.literal("task"), task:scheduledTaskSchema}),
  z.object({kind:z.literal("deleted"), taskId:z.string()}),
  z.object({kind:z.literal("started"), task:scheduledTaskSchema}),
  z.object({kind:z.literal("conflict"), current:scheduledTaskSchema.optional(), message:z.string()}),
  z.object({kind:z.literal("refused"), reason:z.enum(["bad-args","not-found","not-allowed","too-many","bot-stopped","group-disabled","still-running","past-time"]), message:z.string()}),
]);
// pure, browser-safe helpers shared by UI/CLI/daemon/card label:
export function describeSchedule(spec: ScheduleSpec): string;              // 每天 09:00 / 每周一、三 09:00 / 每 15 分钟 / 10月31日 09:00 一次
export function nextSlots(spec, timezone, after: number, anchorAt?: number, n = 3): number[];
export const runStatusLabel: Record<TaskRun['status'], string>;            // 排队中/运行中/成功/失败/跳过/错过
```

Notes on these types:
- `once`, `daily` and `weekly` store wall-clock time plus the IANA timezone; the daemon computes `nextRunAt`. The UI shows the stored wall clock as is, and formats epochs with `formatTime(ms, {timeZone: task.timezone})`.
- `display.ts`'s `partsOf` (9-12) is private. Export it, or add `wallClockOf(ms, tz)` to fill and limit the `datetime-local` value.
- There is no cron library among the daemon dependencies (`packages/daemon/package.json`). The cron parser would be hand-written in `P/schedule.ts`, or the 自定义 mode dropped.

### 2.4 Reads when the bot is stopped, and keeping the list fresh

**Reads.** Two options:
- (a) When the child is not running, the host reads `bots/<appId>/<schedules file>` directly and returns `botRunning:false` with no `resolvedPlacement`. Precedent: `recent-conversations.ts`. Writes stay child-only.
- (b) Refuse with `bot-stopped`.

I recommend (a), so the tab can still show the list read-only with a notice. Add a `schedulesFile` to `botPaths` (`D/config/paths.ts:33-58`). The child writes with `writeFileAtomic` (`D/server/atomic-file.ts`).

**Freshness, option A (recommended):** a change signal in the snapshot.
- After every task-store write and every run start or end, the child sends `{fcb:'fcb.schedule'}`.
- The supervisor's message handler (next to `supervisor.ts:294`) bumps a per-bot counter and calls `api.invalidate()`. Snapshot `build` exposes the counter the way it does `crashes.paused` (`snapshot.ts:47, 132-134`), as `agent.scheduleRevision?: number` (`P/domain.ts:146-155`, optional so older daemons still parse).
- The UI refetches when it changes: `useGroupSchedules(agent.id, group.id, agent.scheduleRevision)`, the same idea as `useLibraryProject(projectId, snapshot.revision)` (`U/ProjectPage.tsx:28-43`).
- Also refetch on focus / visibilitychange (useSecrets pattern) and after each mutation reply.
- Standalone mode calls `api?.invalidate()` with an in-process counter.

**Freshness, option B (minimal):** poll every 5 s while the tab is visible and no draft is open (MemoryMap 122-125 pattern), and every 3 s while any run is `running` or `queued` (ConversationPanel 76-87).

In either option:
- Use a serial ref so a stale reply never overwrites a newer one.
- After a write, use the task returned in the reply instead of waiting for the list.
- On a `conflict` reply, replace the stored task and keep the user's draft (McpPanel `AddMcpDialog` pattern).

## 3. Form design

There are **no date or time inputs or pickers anywhere in packages/ui**: no `datetime-local`, `type=time`, `type=date` or picker library. Only number inputs exist (`GroupDesignSettings.tsx:158` `settings-field`, `NumberStepper`).

Use native inputs inside `FormField`. They are styled by `U/reference/styles/components.css:600-604` (`.ui-form-field input:not([type=checkbox]):not([type=radio])`). The `.ss-row__trailing` selector (605-606) covers only text, number, password and url, so a time input placed in a `SettingsRow` trailing slot gets no styling unless that selector is extended.

**List (tab body):**
- Header: "定时任务 · N", a refresh `IconButton`, and "新建任务" (disabled unless `agent.running && !member.stale`).
- One `SettingsRow` per task:
  - `title` = name;
  - `description` = `describeSchedule` · placement · "下次 {formatTime(nextRunAt,{timeZone})}";
  - `value` = `StatusBadge` (启用 success / 已暂停 neutral / 自动暂停 warning / 已完成 neutral / 运行中);
  - `onClick` opens the dialog.
- Sort by `nextRunAt`; paused and done last.
- Empty state: `EmptyState` or `<p className="gd-empty">还没有任务。可以在群里对 Bot 说“每天 9 点…”，或点“新建任务”。</p>`.

**Dialog (`size="lg"`, create and edit):**
- 名称: `<input maxLength>`. 要做什么: `<textarea>` with a character count (as `GroupDesignSettings.tsx:131`).
- 什么时候: `SettingChoices segmented` with 一次 / 每隔 / 每天 / 每周 / 自定义.
  - 一次: `<input type="datetime-local" min={now in tz}>`.
  - 每隔: `NumberStepper` min 1 plus `SettingChoices` 分钟 / 小时 (1-minute minimum is enforced by the schema).
  - 每天: `<input type="time">`.
  - 每周: seven `aria-pressed` buttons 一…日 (pattern at `SettingsPanel.tsx:734`, `ProviderSetup.tsx:28`), at least one, plus `<input type="time">`.
  - 自定义: cron text plus a `description` hint.
  - Below the fields: "下次：…" from `nextSlots` (3 slots) or the validation error (`FormField error`).
- 时区: read-only text "{task.timezone}（本机时区）". If it differs from `machineTimezone`, say so.
- 发到哪里: `SettingChoices` with 跟着沟通方式（现在：主区 / 每次开新话题） and 每次开新话题.
  - Current mode: shared or smart → 主区; threads or a topic group → 新话题. Prefer `resolvedPlacement` when present.
  - A `topic` placement is shown read-only as "回到原来的话题" with an 在飞书打开 button (`groupUrl(groupId, threadId)`).
- 创建者 (read-only `<dl>`, as in `McpEntries`): "{name}（群成员 / 管理员 / 主人）在群里创建 / 桌面端 / 命令行 / Bot 自己的跟进", with the original words in a quote block.
- Status: a `Toggle` 启用 (active↔paused). For `autoPaused`: `InlineNotice tone="warning" title="已自动暂停"` "连续失败 10 次，已暂停并在群里提醒了创建者。" plus a "恢复" button.
- Footer: 删除… (opens `ConfirmDialog tone="danger"`), 立即运行 (disabled while running or queued, or when the bot is stopped), 取消, 保存.
- `useDraft(dirty, {title:'任务', save, discard})`.

**最近运行:** "共运行 N 次", then up to 20 rows: time, status badge, duration (`formatUptime(endedAt-startedAt)`), "原定 HH:MM" for `catchUp`, "跳过 N 次" / "错过 N 次 (from–until)" for collapsed records, a short error, and "在飞书打开" when `runLink()` exists.

**Bot 任务 pane:** one `SettingsGroup` per group (label: group avatar and name; action: 打开群设置), with the same rows. A row click calls `openGroupTasks`.

## 4. Strings

- There is no i18n layer. Copy is inline zh-CN in the TSX.
- Copy that the CLI or other surfaces share lives in protocol: `P/display.ts` ("How the web UI and the CLI write backends, times and percentages"), `P/domain.ts` `conversationCopy`.
- Feature models hold reusable sentences: `U/management/secretsModel.ts`, `U/project-model.ts:75-78` `deleteAgentDescription`, `U/settings/readonly-messages.ts`, `U/management/environmentPresentation.ts`.
- Put `describeSchedule` and `runStatusLabel` in `P/schedule.ts` (shared with the CLI and the card label), and UI-only sentences in `U/schedule-model.ts`.

**Conventions:**
- Full sentences ending in 。; product name "Vonvon" / "Vonvon Bot"; "Bot" capitalised; device name from `deviceTitle()`.
- Permanent explanations go in the `SettingsGroup` `footer` (`App.tsx:806`, `MachinePanel.tsx:77`) or `<p className="gd-note">` (also `conversation-panel-note`, `group-control-note`).
- Failures use `InlineNotice` with a short title (读取未完成 / 操作未完成 / 保存未完成) plus the message, and a retry `IconButton` with `RefreshCw`.
- Success uses `<p role="status">`.

**Proposed footer:** "{deviceTitle}关机、睡眠，或 Vonvon 没在运行时，任务不会运行。错过的只补最近一次（7 天内），更早的记为“错过”。"
- On macOS with `!snapshot.application.loginItem`, add "开启「登录电脑时启动」后，登录电脑就能运行任务。" (`MachinePanel.tsx:77` wording).
- Bot stopped: "Bot 没在运行，任务不会运行。启用 Bot 后可以修改。" (`GroupWorkspace.tsx:176` style).
- Old daemon (message "未知 RPC 方法。"): "本机服务版本较旧，请更新后再使用任务。" (like `MissingSection`, `GroupDesignSettings.tsx:46-48`).

**Naming collision (flag for owner and plan):** "任务" already means a run or turn across the UI:
- 停用将结束此 Bot 正在运行的任务 (`App.tsx:781`);
- 当前任务运行中 and 已请求停止任务 (`ConversationPanel.tsx:146,148`);
- 停止当前任务 (`search.ts:137`);
- 不 @ 也能发起任务 (`SettingsPanel.tsx:1330`);
- 同时处理的任务 (`SettingsPanel.tsx:824`);
- the 任务卡片 alias (`search.ts:55`).

Suggestion: keep the tab label 任务 as the owner chose, use "定时任务" as the section heading and search alias, and decide whether the older strings change.

**Docs to amend:** `docs/product.md` line 76 (3.1 item 7, tab order), line 825 (§7 "第一版不做：定时任务"), line 888 (§10), line 916 (Q15 "a：不做"). New defaults go into `docs/v1-plan.md` §5.

## 5. Tests

**Style:**
- vitest only. There is no jsdom and no testing-library anywhere. Playwright is a UI devDependency but no test imports it.
- The package script `packages/ui/package.json` runs `vitest run`. The root `vitest.config.ts` include pattern is `packages/*/test/**/*.test.ts`, which does not match `.tsx`; when run from the root, `.tsx` tests may not be picked up (unverified).

Three kinds of UI test:
1. **Static:** `renderToStaticMarkup` inside `<ClientProvider client={createClient(fakeSocket)}>` with HTML assertions (`group-design-settings.test.tsx:12-38`, `conversation-panel.test.tsx`).
2. **Runtime:** `vi.mock('react')` replaces useState, useRef, useEffect, useCallback and useMemo with a harness. The component is called as a function, the element tree is walked (`nodes()`), and `onClick`/`onChange` are called directly. `client-context` and `DraftGuard` are mocked, and `client.<method>` calls are asserted (`mcp-runtime.test.tsx:1-28`, `memory-map-runtime.test.tsx:1-60`).
3. **Pure model:** `*.test.ts` (`memory-model.test.ts`, `project-model.test.ts`).

**Existing tests that will break:**
- `group-design-settings.test.tsx:76-77` asserts exactly four tab labels.
- `search.test.ts:271-284` maps sections to tabs; add `['新建任务','tasks','任务']`.
- `collaboration-navigation.test.ts` if `AgentPane` changes.

**New tests:**
- `packages/protocol/test/schedule.test.ts`:
  - rejects every=0, weekly with no days, day 0 or 8, `24:00`, an unknown IANA zone, extra keys (strict), and a name or instruction over the limit;
  - `describeSchedule` gives 每天 09:00 / 每周一、三 09:00 / 每 15 分钟;
  - `nextSlots` covers weekly crossing a week, every-N with an anchor, once in the past (none), a DST gap and overlap with `America/New_York`, and cron `*/15 9-18 * * 1-5`;
  - `requestSchema` accepts a `schedule` payload; a response with a mismatched method is rejected (pattern at `protocol.test.ts:279-281`).
- `packages/client/test/client.test.ts`: `schedule()` sends `method:"schedule"` and parses the reply.
- `packages/desktop/test/bridge.test.ts`: the channel is registered and an invalid payload is refused.
- `packages/ui/test/schedule-model.test.ts`:
  - draft↔spec round trip;
  - `draftProblem` (empty name, past once time, interval under 1 minute, weekly with no day);
  - placement label for shared, smart, threads and `resolvedPlacement`;
  - `runLink` prefers `messageLink`, then the thread link, then none;
  - run labels for catch-up (原定 HH:MM) and collapsed missed/skipped records.
- `packages/ui/test/group-tasks-presentation.test.tsx` (static):
  - rows show name, schedule, next run in the task timezone, status badge and the footer notice;
  - bot stopped: writes disabled plus the notice;
  - auto-paused: warning plus 恢复;
  - history shows 共运行 N 次, up to 20 rows and 在飞书打开 only when a link exists;
  - the creator's words are shown;
  - nothing renders an open id.
- `packages/ui/test/group-tasks-runtime.test.tsx`:
  - create sends `{type:'create', botId, groupId, …}` with no `taskId`;
  - edit sends the revision it saw; a `conflict` keeps the draft and the next save uses the fresh revision only after a re-read;
  - Toggle sends pause or resume;
  - delete confirm sends `delete` with the revision;
  - run-now is disabled while a run is running or queued;
  - a stale list reply (lower serial) is ignored;
  - the poll or refetch does not run while the dialog is dirty;
  - a `refused` reply shows its message in an `InlineNotice`;
  - a thrown "未知 RPC 方法。" maps to the update notice;
  - `useDraft` is registered while dirty.
- `bot-tasks` test: groups by group, row click calls `onOpen(memberId, taskId)`, and tasks whose membership is missing from the snapshot are dropped.
- The daemon side (`D/server/rpc/schedule.ts` read vs mutation split, readonlyPreview refusal, IPC wiring) is for the daemon plan author, following `packages/daemon/test/context-preview.test.ts`.

**Self-test for Codex:** use the web UI with Codex's built-in web control (owner preference). Desktop-only items are the Electron native `datetime-local` popup and the channel, run on Mac.

## 6. Open questions

These are product decisions the plan must fix or ask the owner about. Everything below is UNVERIFIED (no decision found in the repo):

1. Do tasks run when the group's "在本群使用" switch is off (`member.enabled === false`), or when the bot is disabled? Suggestion: no, and show "本群已停用，任务暂不运行".
2. Does 解除群绑定 or 移除 Bot delete the group's tasks? If yes, update the copy at `GroupWorkspace.tsx:178` and `project-model.ts:75-78`.
3. 立即运行: is it allowed while paused, does it count in `runCount`, and is it refused if a run is already in flight (suggestion: refuse with `still-running`)?
4. Does pausing stop an in-flight run? Suggestion: no, it only stops future slots.
5. Every-N anchor: creation time, the next whole minute, or a user-chosen start? Does editing reset it?
6. If the machine's timezone changes, do existing tasks keep their stored zone? Item 9 of the design is ambiguous.
7. History flooding: a 1-minute task with long runs fills 20 rows with "跳过", and long sleeps with "错过". Suggestion: collapse consecutive records with `count` / `until`, and count only real runs in `runCount`.
8. Caps on tasks per group and per bot, and the name and instruction lengths, for v1-plan §5. Suggested: 50 per group, 200 per bot, 40 and 4,000 code points.
9. Should the UI show the stored 500-character result excerpt ("上次结果")? It is not in the requested UI items.
10. Should the 任务 tab show a badge (count, or 自动暂停)? That needs data in the snapshot (option A could carry a count).
11. A `/tasks` group command would also need `U/GroupUsage.tsx:5` and daemon `buildHelpCard` kept in sync. Not in the design.

**Also UNVERIFIED:**
- how Electron 44 on macOS renders `datetime-local` / `time`;
- Safari web UI support for those inputs (assumed from 14.1);
- that card-send responses include `message_position`, so a per-run message link is available for main-area cards. The `outbound-files.ts:451` comment suggests yes; there is no deep link to a single message in a topic, only to the topic.
