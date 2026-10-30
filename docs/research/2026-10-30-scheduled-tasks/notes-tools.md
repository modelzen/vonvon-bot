# 定时任务调研：命令核、工具通道、Codex dynamicTools 实测（代码笔记）

2026-10-30 只读代码笔记加 Codex 0.156.1、0.163.0 的离线探测（假 provider，没登录），基线 `e87a49c4`。计划见 `docs/plans/scheduled-tasks.md`，冲突以计划为准。原文英文。

Base: these notes are from the read-only worktree `<worktree>`, at the same commit as `<vps-path>` main, c560fe72. Line numbers are from that tree.
`D` = `<worktree>/packages/daemon/src`
`P` = `<worktree>/packages/protocol/src`
`C` = `<worktree>/packages/client/src`
`HM` = `D/bot/handle-message.ts`
I ran the probes in `T=$(mktemp -d)` directories under /tmp and removed them with `rm -rf -- "${T:?}"`. I changed nothing in the repository.

## 0. Findings that change the settled design

1. **Codex dynamic tools work on 0.156.1, and on 0.163.0 too.** This reverses the rejection in `docs/plans/s46.md` §4.1 row E, around line 207: "只有 ThreadStartParams 有，ThreadResumeParams 没有 … 0.156.1 没验证".
   - Tools passed to `thread/start` are saved in the rollout `session_meta.dynamic_tools`.
   - A resume from disk in a new app-server process restores them, and calls work.
   - `dynamicTools` passed to `thread/resume` are silently ignored.
   - So a thread's tool set is fixed when the thread is created. Codex sessions created before this ships will never have the tools.
2. **`CLAUDE_CODE_DISABLE_CRON=1` is not enough.** It removes CronCreate, CronList and CronDelete but not ScheduleWakeup. `disallowedTools` is required.
   - The bundled `loop` skill stays listed even after the tools are disallowed. It needs `settings.skillOverrides`.
3. **The Claude permission builder returns early in full mode.** `D/agent/claude-agent/permission.ts:90` returns `if (access.mode==='full' && !sandbox) return base;`. A `disallowedTools` list added only in `permissionOptions` never reaches full-access Claude sessions. Merge it in `thread.ts` after `...cfg.permission`.
4. **Codex turn binding is wrong for scheduled runs.** For Codex the registry always authorizes with `grant.firstTurn` (`D/agent/entry/registry.ts:169-170`). Scheduled runs reuse a thread and queue turns, so a later turn would be authorized as the first turn's requester. This must be fixed before any write tool goes to Codex (§3.5).
5. **Codex must not get memory tools in this project.** Otherwise `D/agent/bridge-instructions.ts:6` would switch Codex from hidden blocks to `memory_add`, and the `via:'tool'` path can write at Bot scope (§5).

## 1. Command core, CLI path and VONVON_SESSION refusal (s47 pattern)

### 1.1 The pattern today

- `D/admin/structured-commands.ts` (22 lines) holds thin transport-independent functions: `settingsGet(service:{read}, scope)` returns `{view}`, plus `settingsSet(service:{save}, edit, options?)`, `feishuGroups`, `feishuMembers` and `settingsAccess`.
- The CLI calls them over RPC (`D/cli/commands/settings.ts`). The agent tools call them in-process (`D/agent/entry/command-tools.ts:45-109`).
- Add `D/admin/schedule-commands.ts`, or extend structured-commands. It should hold `scheduleCreate/List/Get/Update/Pause/Resume/Delete/RunNow/History(service, request, actor)`.
  - The actor is `{kind:'local'}` for RPC and `{kind:'agent', botId, chatId, role, requesterOpenId, presence, taskId?}` for tools.
  - The core is the only writer and checks scope and role at commit time.

### 1.2 Wiring list, in order

1. **Protocol.** Add `P/schedule.ts`.
   - It holds a zod discriminated union on `op` (create, list, get, update, pause, resume, delete, run-now, history), the task view and the run-history view.
   - The protocol uses zod 3.25.76 and the daemon uses zod 4.6.5. Keep the schemas in the protocol package; do not share zod instances.
   - Export it from `P/index.ts`.
   - In `P/rpc.ts`, add a `schedule` member to `requestSchema`, the discriminated union on `method` at lines 15-27.
   - Add one response const next to the others at 30-40, and list it in the `responseSchema` type annotation at 41-43. Without that, TS7056 fires.
2. **Client.** In `C/client.ts`, add `schedule(req)` to the `VonvonClient` interface (:28-46), to `replySchemas` (:48-53) and to the send table (:175-185).
3. **Host server.** `D/server/http.ts:161-178` dispatches requests. :170 is the memory case. The `default: never` check at :178 forces you to add a `case 'schedule'`.
   - Create `D/server/rpc/schedule.ts` following `D/server/rpc/memory.ts`.
   - Reads return `{kind:'read'}` and writes return `{kind:'mutation'}` through `finish(peer, outcome, envelope)`.
   - Use `requireRunningAgent(service, id)` from `D/server/rpc/ownership.ts`. It throws `RpcError('conflict','Bot 没启用或没在运行')`.
   - Writes to a stopped bot are refused. There is no local-owner fallback: the storage belongs to the bot child, unlike `settings-service.ts:98-140`, which has one.
4. **Admin service.** In `D/admin/service.ts`, the interface is at :119-140; `collaboration?(botId, request)` is the precedent. Add `schedule?(botId, req)`.
   - The implementation goes near :664 and calls a new `deps.executeSchedule`.
5. **Supervisor.**
   - `D/bot/supervisor.ts:282` builds a `createAdminIpcCaller` for each child.
   - The executors are at :522-552. `executeCollaboration` calls `child.ipc.call({kind:'collaboration', request}, 180_000)` and refuses when the bot is paused or not running. Add `executeSchedule` the same way.
   - Use a timeout well under the 30 s CLI local timeout. `ADMIN_IPC_TIMEOUT_MS=15_000` is at `D/admin/ipc.ts:46`.
6. **IPC op.** Add `{kind:'schedule'; request: ScheduleRequest}` to the `AdminIpcOp` union at `D/admin/ipc.ts:27`.
   - Error codes are restored on the caller side, so a `RpcError('refused'|'conflict'|'bad-args')` thrown in the child reaches the CLI unchanged.
7. **Child responder.** `D/cli/commands/run.ts:127-140` dispatches child IPC; :132 handles `if (op.kind==='collaboration') return handle.collaboration(op.request)`. Add the schedule case.
   - The inline single-bot `createAdminService({executeCollaboration, …})` at :148+ needs `executeSchedule` too.
   - There is a precedent for telling the supervisor after a change: at :120 the child sends `fcb.connection` (`process.send({ fcb: 'fcb.connection' }, …)`), and `supervisor.ts:289-298` turns it into `api?.invalidate()`.
   - A `fcb.schedule` notice can invalidate the desktop 任务 tab the same way.
8. **Bot bridge.** `D/bot/bridge.ts:80-94` builds `createAgentEntries({appId, isAdmin, isOwner, tools: createCommandTools({...settings:{read: scope=>orchestrator.settings.read(scope), …}})})`.
   - These are lazy closures over `orchestrator`, which is declared at :95, so there is no TDZ problem.
   - Add `schedule: {…: req => orchestrator.schedule.x(req)}` the same way.
   - The returned handle at :219 gets `schedule(request)` for the IPC responder.
   - Wrap it in `admit(...)` like the other entries at `HM:9205-9263`.

### 1.3 CLI command group

- `D/cli/index.ts`:
  - :15 `const structured = ['settings','feishu'].includes(process.argv[2])`. Add `'schedule'`. This turns on `exitOverride` and JSON failure output.
  - :28 is the data-lease skip list (service, bot, group, settings, feishu). Add `schedule`, because the CLI only talks RPC.
  - :103 is `io`; :104 is the `BOT` option; :176 the settings commands; :202 the feishu commands.
  - Register a `schedule` command with subcommands create, list, get, update, pause, resume, delete, run-now and history, plus `--bot` and `--group`.
  - :253-272 is the existing catch. It prints `{ok:false, error:{kind, message, current?}, exitCode}` through `commandFailure`.
- Create `D/cli/commands/schedule.ts` modeled on `D/cli/commands/settings.ts`:
  - `runScheduleX(target, io, daemon = withDaemon)`;
  - `daemon(async call => …)`, and `call('读取定时任务', c => c.schedule({...}))` with `want(...)`;
  - resolve scope with `pickBot` and `pickGroup` (`D/cli/daemon-client.ts:124`, `:142`);
  - print with `print(io, human, json)` (:150);
  - show times through `localTime` (:159) and in the task's IANA zone.
  - Validate cron, interval and time zone locally before connecting, as `parseAssignments` does in settings.ts. Throw `CommandError('bad-args')`.
- `D/cli/daemon-client.ts:63`: add `schedule: 'schedule'` to the `METHODS` map. Then extend `checkRequests` at :71.
  - `TIMEOUTS = {local:30_000, feishu:75_000}`. Schedule is `local`.
- `D/cli/command-error.ts`: the exit codes are `bad-args` 2, `connection` 3, `refused` 4, `conflict` 5, `failed` 1, `outcome-unknown` 6. A `run-now` whose IPC times out after the child received it should map to `outcome-unknown`.

### 1.4 VONVON_SESSION refusal

- The detector is `D/config/session-env.ts`: `inBotSession(env) = Boolean(env.VONVON_SESSION) || env.FEISHU_CODEX_BRIDGE==='1'`. `D/agent/session-profile.ts:38` puts `VONVON_SESSION` into the agent's environment.
- The existing pattern is in `D/cli/commands/memory.ts`: the `SESSION_REFUSED` text at :5 and `refusedInSession(ctx)` at :43-48. `D/cli/commands/secrets.ts:13` and `:68-73` repeat it.
- Recommendation: refuse every `vonvon schedule` subcommand inside a bot session, reads included, before connecting. Throw `CommandError('refused', …)`, exit code 4, with a message pointing the agent to the vonvon_bot tools or the 任务 skill.
  - Reads must be refused because the RPC actor is always `local`, which is owner-level. A read from inside a session would leak other groups' tasks.
- Caveat, already known from s46: a full-access agent can unset the variable or read the local credential. `docs/v1-plan.md:466` says that credential is not for agents. The refusal is a convention, not a security boundary. The real scope check is in the in-process tool path.

## 2. Agent tool registry: new schedule class, role rules, grant extensions

### 2.1 Current shapes (`D/agent/entry/registry.ts`, 343 lines)

- :6 is `AgentPlace {kind:'group'|'p2p'|'doc'; chatId?; docId?}`; :7-18 is TurnFacts; :52-64 is TurnAuth; :65-76 is Grant.
  - TurnAuth fields: id, facts, human, kind, steered, botWrites, active, controller.
  - Grant fields: phase, place, thread, turn, firstTurn, origins (a Map of at most 256), active, settingRunning, queue.
- :105-114 `authorizeNow` (settings) checks, in order: revoked, not-dm, unknown-origin, turn-ended, not-human-turn, not-admin, switch-off.
- :116-122 is `authorizeMemory`.
- :123-127 is `roleOf`, which returns bot, owner, admin or member, built from the `isOwner`/`isAdmin` deps. The config helpers are `D/config/schema.ts:355` (resolveOwner) and `:361` (isAdmin).
- :165-167 sets `gated = settings || memory`.
- :169-170 picks the auth: `grant.thread?.releaseAfterRun !== undefined ? grant.firstTurn : origin?.toolUseId ? grant.origins.get(origin.toolUseId) : undefined`.
- :179 returns busy at 4 concurrent calls.
- :226-253 builds the context. `ctx.turn` is set only for memory and settings, and the context includes commit and guard.
- :262 caps results at 256 KiB.
- :294 is the tools() filter: `tool.class==='read' || (tool.class==='memory' ? place.kind!=='doc' : place.kind==='p2p')`.
- :298-301 is `noteToolUse(id)`: `origins.set(id, grant.turn)`, and only while attached.
- :315 computes `human = user && requesterOpenId && triggerMessageId && !retry && !initiative && !wake`.
- :317 sets `kind`.
- :319-324: openTurn ends the previous turn and sets `firstTurn ??= auth`.
- In `D/agent/entry/tools.ts`, :24 is `class: 'read'|'settings'|'memory'`, :12 is `ctx.turn?: {id, requesterOpenId, role, triggerMessageId}` and :19 is `commit?`.

### 2.2 Changes

1. **New class.** Add `'schedule'` to `tools.ts:24`.
   - In the filter at :294, schedule tools are listed only when `place.kind==='group'`. Not in p2p or docs: tasks belong to a (bot, group).
2. **New schedule-tools file.** Create `D/agent/entry/schedule-tools.ts`, modeled on `D/agent/entry/memory-tools.ts:48`, which wraps writes as `committed(ctx, …)` → `ctx.commit(guard => …)`.
   - Tools: schedule_create, schedule_list, schedule_get, schedule_update, schedule_pause, schedule_resume, schedule_delete, schedule_run_now, schedule_history.
   - None of them take a group argument. The group always comes from `grant.place.chatId`.
   - Spread them in `D/agent/entry/command-tools.ts` next to :109 (`...(deps.memory ? createMemoryTools(deps.memory) : [])`). Add `schedule` to the deps at :13-21.
3. **`authorizeSchedule`.** Add it next to `authorizeMemory` (:116-122). Checks, in order:
   - revoked;
   - place is not a group;
   - unknown origin;
   - turn ended;
   - then a presence check: creating is refused when presence is `none`;
   - with presence `scheduled`, writes are allowed only when `targetTaskId === facts.scheduled.taskId`;
   - it does not check the tier. A read-only tier group may create.
   - Add `schedule` to `gated` at :165-167, and fill `ctx.turn` for it at :226-253.
4. **Role rules, enforced in the core under the commit guard (not in the registry).**
   - Use `roleOf` (:123-127).
   - Owner or admin: may change all tasks of the group.
   - Member: may list all tasks, but may change only tasks whose `createdBy.openId` equals the requester's openId.
   - No-human run: may change only its own task, and may not create.
   - Admin is per bot. Check whether project membership (`isUserAllowedInProject`, `D/config/schema.ts:373-382`) gates the member role; the core should call the same helper.
5. **Presence.** Add `presence: 'human'|'scheduled'|'none'` to `ctx.turn`.
   - Recommendation: derive it from the open-time `auth.kind==='human'`, not `auth.human`, because `noteSteer` (`HM:3211`) flips that later.
   - Decide whether a steer cancels a pending create. The recommendation is that it does not, so use the open-time kind.
   - Unattended runs open with `requesterKind` not user, so `human` is false. They map to MemoryTurn kind `initiative`, or `bot` (§5).
6. **TurnFacts.** At :7-18, add:
   - `scheduled?: {taskId: string; runId: string}`;
   - `origin?: () => {sessionKey: string; main: boolean}`.
   - `origin` must read the live `topicThreadId` and `activeKey` from launchRun (`HM:7176-7177`, `let activeKey = opts.knownThreadId ?? \`pending:${opts.replyTo}\``). That key stays `pending:` until `adoptThreadId` at `HM:7437`.
   - Use `isMainKey = (key, chatId) => key === chatId` (`HM:1750`).
   - A create made from a topic records `{sessionKey, main}`, so run routing can follow the conversation mode.
   - Pass both facts from the openTurn call at `HM:7356`, which today passes `{requesterOpenId, requesterKind, triggerMessageId, retry, initiative, wake, typed?, triggerText?}`.
7. **Reply codes.** Extend `AgentToolReply` in `D/agent/types.ts:365-368` and the enums in `D/agent/entry/ipc-codec.ts:8-9` together.
   - Suggested reasons: `not-group`, `not-task-owner`, `scheduled-run-scope`, `no-human-create`, `task-limit`, `bad-schedule`.

### 2.3 Requester identity per provider

- **Claude** (`D/agent/claude-agent/thread.ts`):
  - :327-344 builds an in-process MCP server once per thread from `entry.tools()`, with `tool(spec.name, spec.description, spec.input.shape, …)`. It calls `entry.call(name, args, {toolUseId})` with `toolUseId` from `_meta['claudecode/toolUseId']` (`toolOriginSchema` at :283).
  - At :466 and :471, `noteToolUse` runs on tool_use blocks named `mcp__vonvon_bot__*`, so each call finds the TurnAuth of its own turn.
  - The server is rebuilt on every recreate or resume, so a newly added class shows up on the next turn.
  - Auto mode already allows `mcp__vonvon_bot` (`permission.ts:93`, `:218`).
- **Codex**: today there are no tools. The firstTurn rule at registry :169 must change before Codex gets tools (§3.5).

## 3. Codex tool channel

### 3.1 Verified on 0.156.1 and repeated on 0.163.0

Method: `npm install --prefix "$T" @openai/codex@0.156.1`, `codex app-server generate-ts --experimental --out "$T/ts"`, and a fake Responses provider: `-c model_provider="fake" -c model_providers.fake={…wire_api="responses",requires_openai_auth=false,supports_websockets=false}`.

- **Schema.** `ThreadStartParams.dynamicTools?: Array<DynamicToolSpec> | null` appears only in the experimental output. `ThreadResumeParams` has no `dynamicTools` in either output.
- **Capability.** Without `experimentalApi` the error is `thread/start.dynamicTools requires experimentalApi capability`. vonvon already sends `capabilities:{experimentalApi:true, requestAttestation:false}` (`D/provider/transport/jsonrpc.ts:350-357`).
- **Accepted spec shapes:**
  - the old flat shape `{name, description, inputSchema}`;
  - `{type:'function', name, description, inputSchema, deferLoading?}`;
  - `{type:'namespace', name:'vonvon', description, tools:[{type:'function', …}]}`.
- **Names** must match `^[a-zA-Z0-9_-]+$`.
- **`deferLoading`.** `deferLoading:true` at the top level is rejected: "deferred dynamic tool must include a namespace". Inside a namespace it hides the tool and adds a BM25 `tool_search` tool.
- **Server request.** `item/tool/call` with params `{threadId, turnId, callId, namespace: string|null, tool, arguments}`.
- **Response.** `{contentItems:[{type:'inputText', text}], success:true}`. The text becomes the model's `function_call_output`.
  - `success:false` marks the item failed and still passes the text.
  - A JSON-RPC error makes Codex report "dynamic tool request failed" to the model, and the turn continues. Today's default in vonvon is -32601 "not handled" (jsonrpc.ts:78).
- **Item events.** `dynamicToolCall` items are emitted as started and completed. vonvon already maps them to `tool_use`/`tool_result` with the title `namespace.tool` (`D/agent/codex-appserver/event-map.ts:138-145`, `:183-190`; `backend.ts:1136-1138`).
- **Interrupt.** If `turn/interrupt` arrives while a call is pending, the turn completes as "interrupted". No `serverRequest/resolved` was seen, and a late answer is ignored. The handler must not assume it will be told about the cancellation; tie it to the turn abort.
- **Approval and sandbox.** Calls work with approvalPolicy `never` and sandbox `read-only`. No approval prompt was seen for dynamic tools.
- **Persistence.** Tools are saved in rollout `session_meta.dynamic_tools`. A resume from disk in a fresh app-server process restores them, and calls work. Tools sent on resume are ignored. A thread started without tools cannot gain them.
- **Tool list in an app-server session:** exec_command, write_stdin, request_user_input, apply_patch, view_image, get_goal, create_goal, update_goal, the dynamic tools, tool_search, web_search. There is no automation tool (§4.2).

### 3.2 Vendored protocol is stale

- `D/agent/codex-appserver/protocol/generated` was generated without `--experimental`.
  - `v2/DynamicToolCallParams` matches 0.156.1.
  - `DynamicToolCallResponse` lacks the 0.156.1 `inputAudio` content item, which is harmless.
  - `DynamicToolSpec` is the old flat type.
  - `ThreadStartParams` lacks `dynamicTools`.
  - `ServerRequest.ts` already includes `item/tool/call`.
- `index.ts` mentions `npm run codex:protocol:update`, but no such script exists in package.json.
- Plan step: regenerate with `generate-ts --experimental` from 0.156.1 (`CODEX_MIN_VERSION`, `D/agent/codex-appserver/version.ts`), or hand-write a local `DynamicToolSpec` type plus `ThreadStartParams & {dynamicTools?}`. Also add the missing script, or delete the stale comment.

### 3.3 Wiring

1. **Transport.** `D/provider/transport/jsonrpc.ts:301-308` is `peer.onRequest`: `approvalAnswer` first, then `item/tool/requestUserInput` → `userInputRequest`.
   - Add `method === 'item/tool/call'` → `toolCall(params)`.
   - Answers go through `answerRequest` (:202-215). A throw becomes -32603. Undefined becomes -32601. Null means no reply.
   - Warm pool clients exist before any thread (`backend.ts:1055`), so add `AppServerClient.setToolHandler(threadId → handler)`, or a per-thread map. Options are at :225-236 and the class at :238.
   - Validate params with zod as `server-requests.ts` does (`approvalAnswer` :132-146, `userInputRequest` :148-191).
2. **Thread start.**
   - `startThread` is at `backend.ts:997-1021`: it builds params, calls admit, spawns at :1008, then sends `client.request('thread/start', params)`.
   - `resumeThread` is at :1023-1053 and spawns at :1029; it sends `thread/resume {threadId, ...params}`.
   - Add `dynamicTools: [{type:'namespace', name:'vonvon_bot', description, tools: specs}]` only on `thread/start`.
   - The specs must come from a static list that is independent of the grant phase. `entry.tools()` returns `[]` during the capacity phase, and whatever is sent at start is fixed forever.
   - Convert the zod `spec.input` to JSON Schema (zod 4 `z.toJSONSchema`). UNVERIFIED: whether Codex rejects JSON Schema keywords it does not support.
   - Keep the namespace name within `^[a-zA-Z0-9_-]+$`; `vonvon_bot` is fine.
   - Do not use `deferLoading` at first. Nine schedule tools plus the read tools is small. Revisit if more tools are added.
3. **Session flag.** Store a per-session `toolsVersion` (for example `codexTools: 1`) wherever the Codex thread id is kept, so old sessions are known to lack tools. That decides whether to add the 任务 skill root (§6) and which instructions to inject.
   - Optional: when an old session meets a user's schedule request, start a new thread. That is a product decision; do not do it silently.
4. **Child threads and goals.** Whether Codex subagents receive the parent's dynamic tools is UNVERIFIED. Goal-continuation turns (`backend.ts:439` runGoal, `HM:8280`) start with turn ids vonvon has not recorded. With §3.5 those calls are refused with `unknown-origin`, which is the safe default.
5. **Close.** `close()` (`backend.ts:751`) calls `this.entry?.revoke('closed')`. Pending tool calls then fail through the registry's revoked path, so the handler should answer `success:false` rather than throw.

### 3.4 What the s46b stdio MCP design becomes

- The s46b design is `docs/plans/s46.md` §4.9-4.13: a 0600 token file, `agent-mcp.mjs`, the host route `POST /agent/v1/bots/<appId>/call`, the `agentCall` IPC op, and timeouts 70 < 75 < 80 < 90 s.
- Dynamic tools make all of that unnecessary for Codex:
  - calls come back on the same app-server pipe, which lives in the bot child;
  - nothing is exposed on the host;
  - there is no token for a full-access agent to steal.
- Recommendation: use dynamic tools. Keep s46b only as a fallback, if a later Codex version drops the experimental field.
- Keep the 70 s registry deadline. Codex showed no tool-call timeout of its own in the probe, but that is UNVERIFIED for long calls.

### 3.5 Codex turn binding fix (required)

- The `firstTurn` rule at `registry.ts:169-170` attributes every call on a Codex thread to the first turn opened on that grant.
- The `for(;;)` queued-turn loop in launchRun (`HM:7170`) runs later turns on the same thread. Scheduled runs and steers would therefore carry the wrong requester and presence.
- Fix:
  - In `CodexThread`, the `turn/start` response handler (`backend.ts:363-368`, `.then(result => { activeTurnId = result.turn.id; … self.onDisk = true })`) calls `this.entry?.noteToolUse(result.turn.id)`.
  - The `item/tool/call` handler calls `entry.call(tool, arguments, {toolUseId: params.turnId})`. If the turn id is not yet known, it first awaits that turn's start promise.
  - Remove the `releaseAfterRun` branch at :169. `releaseAfterRun` (`types.ts:346`, `backend.ts:319` `get releaseAfterRun() { return this.onDisk }`) then only governs release, not auth.
  - `origins` holds at most 256 entries. One entry per turn is fine.

## 4. Disabling native scheduling

### 4.1 Claude (SDK `@anthropic-ai/claude-agent-sdk` 0.3.296, claudeCodeVersion 2.1.296, pinned at `packages/daemon/package.json:49`)

- **Verified with an API-key login.**
  - Default tools include CronCreate, CronDelete, CronList and ScheduleWakeup. RemoteTrigger is absent, because it needs a claude.ai login (`docs/research/2026-10-14-v1-spikes/e02-claude-permissions-sessions.md:112-118` lists it under the owner login).
  - `CLAUDE_CODE_DISABLE_CRON=1` removes only the Cron* tools. The bundled code is `vE(){return!a.CLAUDE_CODE_DISABLE_CRON&&hz("tengu_kairos_cron",…)}`.
  - `disallowedTools:['CronCreate','CronList','CronDelete','ScheduleWakeup','RemoteTrigger']` removes all of them.
  - The bundled `loop` skill is still listed after that. `settings.skillOverrides: {loop:'off', schedule:'off'}` removes it.
- **Steps:**
  1. `D/agent/claude-agent/backend.ts:97-99` `sessionClaudeEnv` already adds `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS:'1'` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1'`. Add `CLAUDE_CODE_DISABLE_CRON:'1'` as defence in depth. It may also stop the durable scheduler for `.claude/scheduled_tasks.json`, but that is UNVERIFIED.
  2. In `D/agent/claude-agent/thread.ts:345-371`, merge `disallowedTools: [...(cfg.permission.disallowedTools ?? []), ...NATIVE_SCHEDULING_TOOLS]` after `...cfg.permission` at :364.
     - Do this in thread.ts, because `permission.ts:90` returns early in full mode and would skip a list added there.
     - Put `NATIVE_SCHEDULING_TOOLS` next to `NATIVE_MEMORY_OFF` (thread.ts:82-91).
  3. The `settings` option at :360 is `AUTO_COMPACT_SETTINGS` (defined at :87) or its plan-mode variant. Add `skillOverrides: {loop:'off', schedule:'off'}` to both.
  4. `helperQueryOptions` (`backend.ts:112-130`) already uses `tools: []` and needs nothing.
- **Allowlist interplay.** Group skill profiles give Claude an `enabledNames` allowlist (`D/agent/group-skills.ts:92-99`; `backend.ts:667`, `:698` `...(profile.skills?.enabledNames ? { skills: [...] } : {})`).
  - With an allowlist, `loop` is already hidden unless it is listed. Without one, skillOverrides is needed.
  - Whether skillOverrides `off` also wins over an allowlist entry that names `loop` is UNVERIFIED. Filter `loop` and `schedule` out of enabledNames too.

### 4.2 Codex

- The app-server tool list has no automation tool on 0.156.1 or 0.163.0.
- `codex features list` shows `in_app_local_automation` as stable `true`. Overriding `config.features.in_app_local_automation=false` on thread/start is accepted and does not change the tool list. The feature looks like it belongs to the Codex desktop app.
- Recommendation: add `in_app_local_automation: false` to the features block in `codexSessionParams` (`D/agent/codex-appserver/backend.ts:78-104`), next to `...NATIVE_MEMORY_OFF` and the win32 `prefer_mxc` at :99-100. It is cheap and protects against future versions.
- Also add a `NATIVE_SCHEDULING_OFF` const in `D/agent/codex-appserver/memory-config.ts` style.
- `codex_apps` connectors stay as product.md §9-19 decided. Only automations are turned off.

### 4.3 product.md reversal

- `docs/product.md:870` (§9 item 19) records the owner decision of 2026-10-15: keep connectors and Claude Code's own tools (push, remote trigger, scheduled tasks) plus Codex `codex_apps`, "第一版两家都留着，不关".
- The amendment should narrow that to "connectors and the remaining built-in tools stay. Since 定时任务, native scheduling (Claude CronCreate/CronList/CronDelete/ScheduleWakeup/RemoteTrigger and the loop/schedule skills; Codex automations) is turned off, because vonvon's scheduler owns scheduling." Cite the new decision date.
- Other product.md lines to change:
  - :825 (§7, 定时任务 not in v1);
  - :888 and :916 (Q15 answered "a 不做");
  - §3.7, lines 516-544, especially item 2 at :522 and the Codex token/MCP text at :537. It should say Codex gets tools as app-server dynamic tools fixed at thread creation, with no token.

## 5. Memory once Codex has tools (no memory migration)

- **Today.**
  - `HM:1095` `hiddenBlocksFor = backendId => backendFor(backendId).id !== 'claude-agent'` sends Codex down the `<vonvon-remember>` hidden-block path.
  - `profileOf` (`HM:1116-1124`) builds the opening with hiddenBlocks and the skills profile.
  - The blocks are parsed under the condition at `HM:1384`.
  - `D/agent/bridge-instructions.ts:6` tells the model to use memory_add/update/forget and to fall back to `<vonvon-remember>` only when those tools are missing.
  - `D/bot/memory-authority.ts:116` has `via: 'tool'|'hidden_block'|'ui'|'cli'`. `decideAdd` (:122) carries the comment "隐藏块永远写不了 Bot 范围": hidden blocks can never write Bot scope, but `via:'tool'` can, subject to `botWriteGate` (:92-100).
  - Codex native memory stays off through `NATIVE_MEMORY_OFF = {features:{memories:false}, memories:{use_memories:false, generate_memories:false}}`.
- **Recommendation.** Codex's dynamic set contains only the `read` class tools (`session_info` and the settings/feishu reads) plus the `schedule` class.
  - Filter by class when building `dynamicTools`, for example `codexToolClasses = new Set(['read','schedule'])`.
  - Leave `hiddenBlocksFor` and bridge-instructions unchanged.
  - Make sure the Codex instruction text does not say memory tools exist. Check the opening built by profileOf, which reads the hidden-block flag rather than the tool list. If any instruction is generated from the real tool list, pass Codex's filtered list.
  - Codex memory behaviour then stays the same: hidden blocks only, never Bot scope.
- **Scheduled runs.**
  - `MemoryTurn.kind` (`D/bot/memory-authority.ts:10`) is `'human'|'wake'|'initiative'|'retry'|'bot'`, with `isHuman` at :41. It is persisted through `P/memory.ts:31` `memoryTurnKindSchema = z.enum([...])` and used in memory sources at `P/memory.ts:39`.
  - Do not add a `scheduled` kind; that would be a schema and data migration. Map unattended runs to `initiative`, which is non-human, so `botWriteGate` already blocks the trusted writes.
  - Record the task id in run history, not in memory sources.
  - `memoryTurnOf` is at `registry.ts:128-141`, and the memoryTurn is built at `HM:7362`.

## 6. Native 任务 skill delivery (both verified)

- **Claude.** Use the SDK option `plugins:[{type:'local', path:<dir>, skipMcpDiscovery:true}]` with `<dir>/.claude-plugin/plugin.json` (name `vonvon`) and `<dir>/skills/tasks/SKILL.md`. It shows up as `vonvon:tasks`.
  - With `skills:['vonvon:tasks','simplify']`, only those two are listed. The init message's skill list shows everything discovered, not the allowlist.
  - So when a group profile has `enabledNames`, append `vonvon:tasks` to it at backend.ts:667 and :698.
  - Ship the plugin dir with the daemon's runtime files.
  - Non-ASCII skill or plugin names are UNVERIFIED. Use an ASCII name and put "任务" in the description and title.
- **Codex.** Call `skills/extraRoots/set {extraRoots:[absRoot]}` once per app-server process; it returns `{}`.
  - `skills/list` then shows the skill with scope `user`, and the model's skill list includes `- vonvon-tasks: … (file: <root>/vonvon-tasks/SKILL.md)`.
  - It is not written to config.toml.
  - Send it right after initialize in `jsonrpc.ts` (:350-357), or when a warm client is created. It is per process, so every pooled client needs it.
  - Only send it for sessions with tools (§3.3). Pooled clients serve both kinds, so either keep the root always on with a skill text that says "if the vonvon_bot tools are missing, tell the user to start a new conversation", or pool by tools version.
  - Group skill profiles give Codex `disabledPaths` (`backend.ts:101` skills.config). Make sure the skill root is not on that list.
  - For sandboxed tiers, the model may need read access to the SKILL.md file. Add the root to `codexFilesystem` read roots in `D/agent/codex-appserver/workspace-policy.ts:119-136` (`{path:{'.':'read'}}`). UNVERIFIED: whether Codex reads skill files from its own process rather than through the sandboxed tool.

## 7. Storage and write-path notes for the core

- Add `schedule.json` and `schedule-runs.json` (last 20 runs per task) to `botPaths` in `D/config/paths.ts:33-58`.
- `D/server/atomic-file.ts` `writeFileAtomic` has no guard hook. Follow `D/bot/memory-store.ts:556`, which runs a `beforeCommit` callback before the rename, so the registry's commit guard (the 70 s deadline and a revoke) can abort a write at the last moment.
- Only the bot child writes. Desktop and CLI writes go through §1.2 steps 4-7.

## 8. Docs to amend in the plan PR

- `docs/plans/s46.md` §4.1 row E (around line 207): reverse the dynamicTools rejection and cite the 0.156.1 and 0.163.0 probe.
- `docs/plans/s46.md` §4.9-4.13: mark s46b as a fallback only.
- `docs/v1-plan.md:1425`, the s46b row.
- `docs/product.md`: :516-544 (§3.7, items at :522 and :537), :825, :870 (§9-19 narrowed), :888 and :916.
- `docs/plans/s47.md`: add schedule as a third command group under the same rules.

## 9. UNVERIFIED

1. How a real model behaves with namespace tools and with `deferLoading`/`tool_search` under a ChatGPT login. Only the fake provider was used.
2. Whether RemoteTrigger and a bundled `schedule` skill appear under a claude.ai OAuth login. This was tested with an API key only; e02 says RemoteTrigger appears under the owner login.
3. Whether Codex subagent or child threads inherit the parent's dynamic tools.
4. Whether sandboxed Codex reads the extra skill root, or needs the workspace-policy read root.
5. Whether `skillOverrides` off overrides an `enabledNames` allowlist entry.
6. Whether `CLAUDE_CODE_DISABLE_CRON` also stops the durable `.claude/scheduled_tasks.json` scheduler.
7. Non-ASCII skill or plugin names, on both providers.
8. Whether Codex accepts every JSON Schema keyword that zod 4 `toJSONSchema` emits for `inputSchema`.
9. Whether Codex has a timeout for long-pending `item/tool/call` requests. None was seen in the short probe.
10. Whether `in_app_local_automation=false` has any effect in app-server mode. It changed nothing observable.
