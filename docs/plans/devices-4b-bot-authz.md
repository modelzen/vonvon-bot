# D4b `devices-4b-bot-authz`：★ 请求经 IPC 问 Bot 进程、`ScheduleActor.session`、memory 角色透传

总设计见 `docs/plans/devices.md` 5.2（★ 行和 D4b 验收）、3.7 的三层、第 15 节"这一轮已结束"。共用契约在 `docs/plans/devices-1-identity.md` 4.0；host 侧的表、`askBot` 钩子、令牌和 IPC 通道在 `docs/plans/devices-4a-scope.md` 4.2、4.5、4.6。缩写同 D1。

## 1. 做什么

用户能看到的：私聊里让 Bot 用命令行改设置时，和让它用工具改一样——成员发起的那一轮被拒、主人/管理员那一轮放行、"聊天改设置"开关关着被拒、管理员名单只有主人那一轮能改、一轮结束后同一令牌再调被拒（"这次调用对应的那一轮对话已经结束，不能再改设置。"）；群里成员那一轮 `vonvon memory add --bot` 落到项目记忆而不是 bot 记忆；命令行建的定时任务记下是哪条会话里谁触发的。

依赖：D4a。被依赖：K1。

## 2. 范围

做：`AdminIpcOp` 加 `authorizeSessionCall`；`registry.ts` 暴露 `authorizeSessionCall(sessionId, action)` 跑**同一套** `authorizeNow / authorizeMemory / authorizeSchedule`；私聊只读查询的主人/管理员判定（同工具 `ctx.admin`）；`act adminMember` 的主人判定；`ScheduleActor` 加 `session`；`executeSchedule` 从 `via` 改成 actor；memory 的 `role`/`openId` 透传；host 的 `askBot` 接上并把 D4a 的临时放行翻成"没有 Bot 进程就拒"。

不做：skill 文字 → K1；回执卡和［撤销］→ 推迟（设计 16.16）；完全访问档读凭据绕过 → 不解决（设计 16.2）。

## 3. 现在的代码

- `D/agent/entry/registry.ts`：`authorizeNow(grant, auth)`（159-168：revoked → `not-dm`（非 p2p）→ `unknown-origin` → `turn-ended` → `not-human-turn` → `not-admin` → `switch-off`）、`authorizeMemory(grant, auth)`（170-176）、`authorizeSchedule(grant, auth, action, taskId)`（181-192）、`roleOf(auth)`（193-197：非 user 或无 openId → `'bot'`；owner/admin/member）、`scheduleActor(grant, auth)`（199）；`grant.turn` 是当前 `TurnAuth`；`ToolContext.admin` getter（私聊只读查询用的"主人或管理员亲手发的这一轮"判定）；`messages` 表里的 refusal 文字（48 行 `not-dm`，`turn-ended` 等）；D4a 后 `grant.sessionId`、`AgentEntry.sessionId`、`opts.sessions`。
- `D/admin/ipc.ts`：`AdminIpcOp` 联合（`collaboration/write/group/settingsRead/settingsModels/library/schedule{via,request}/status`）；D4a 泛化后的 caller/responder；`D/bot/supervisor.ts:535-539` `executeSchedule → child.ipc.call({ kind:'schedule', via, request })`；`run.ts` 子进程侧 `createAdminIpcResponder(execute, send)` 把 op 分发到 bridge 的 `adminExecute/schedule/...`。
- `D/admin/schedule-commands.ts`：`ScheduleActor = { kind:'chat', openId, name?, role, chatId, topicId?, messageId?, text? } | { kind:'scheduled', taskId, runId, chatId } | { kind:'local', via }`；`mayCreate`、`denial`、`creator`（`createdBy.via`）；`P/schedule.ts:38-41` `scheduleCreatorSchema { via:'chat'|'desktop'|'cli', openId?, name?, role?, messageId?, text? }`。
- `D/bot/handle-message.ts:9712-9728`：`schedule(via, request)` / `scheduleAs(actor, request)`。
- `D/admin/service.ts`：`AdminService.executeSchedule(botId, via, request)`、`createAdminService(deps)`；`D/server/rpc/schedule.ts` 的 `scheduleRpc(service, clientKind, payload)`。
- `D/admin/memory.ts:84`：`memoryAction(request, deps:{ origin? })`，actor role 今天是 `'cli'|'desktop'` 一类的本地角色；`D/bot/memory-store.ts:42` `MemoryActor { openId?, role: MemoryActorRole }`；`memory-authority.ts` 的 bot 记忆落点规则（主人/管理员亲手打的才进 bot 记忆）。
- D4a：`authz.ts` 的 `Rule.botSession === 'bot'` 行、`AuthzDeps.askBot?`、临时放行；`SessionTokens.resolve` 给出的 `SessionRecord`。

## 4. 怎么改

### 4.1 契约：`SessionAction` 和 IPC op（`D/admin/ipc.ts`，`P/` 不动）

```ts
export type SessionAction =
  | { kind: 'settingsWrite' }                                     // settings.save、settings.act.*（除 adminMember）、collaboration.createProject/editProject → authorizeNow
  | { kind: 'adminMember' }                                       // settings.act.adminMember → authorizeNow + 这一轮的 requester 是主人
  | { kind: 'adminRead' }                                         // 私聊只读查询：command.listJoinedGroups/listGroupMembers/listPendingGroups/refresh、settings.read/sessions/models → 同 ToolContext.admin
  | { kind: 'memory' }                                            // memory.* → authorizeMemory，回 role/openId
  | { kind: 'schedule'; action: ScheduleRequest['action']; taskId?: string };   // schedule.* → authorizeSchedule，回 session actor
export type SessionAuthz =
  | { ok: true; role: 'owner' | 'admin' | 'member' | 'bot'; openId?: string; actor?: ScheduleActor }
  | { ok: false; reason: string; message: string };              // reason 用 registry 的 refusal 名（not-dm / turn-ended / not-human-turn / not-admin / switch-off / not-owner / unknown-origin / revoked / not-group / …）
export type AdminIpcOp = … | { kind: 'authorizeSessionCall'; sessionId: string; action: SessionAction };
// 回复 { kind: 'sessionAuthz', result: SessionAuthz }
```

`ScheduleActor` 加 `{ kind: 'session'; openId: string; role: 'owner'|'admin'|'member'; chatId: string; name?: string; messageId?: string }`；`AdminScheduleOp` 从 `{ kind:'schedule', via, request }` 改成 `{ kind:'schedule', actor: ScheduleActor, request }`（桌面端/CLI 的 owner 调用传 `{ kind:'local', via }`，行为不变）。

### 4.2 Bot 进程：`registry.ts` 的 `authorizeSessionCall`

`createAgentEntries` 返回值加 `authorizeSessionCall(sessionId, action): SessionAuthz`：
1. 在 `grants` 里按 `sessionId` 找 grant；没有（轮已结束被 `revoke`、grant 从未存在）→ `{ ok:false, reason:'turn-ended', message: 设计 15 节"这一轮已结束" }`。有但 `grant.thread && !grant.thread.isAlive()` → 先 `revoke(grant)` 再同样回 `turn-ended`（和三个 authorize 函数开头一致）。
2. `auth = grant.turn`（当前 `TurnAuth`；没有进行中的轮 → `undefined`，下面的函数会回 `unknown-origin`/`turn-ended`，统一映成 `turn-ended` 文字）。
3. 按 `action.kind`：
   - `settingsWrite` → `authorizeNow(grant, auth)`；失败 → `{ ok:false, reason, message: messages[reason] }`；成功 → `{ ok:true, role: roleOf(auth), openId }`。
   - `adminMember` → 先 `authorizeNow`，再 `opts.isOwner(auth.facts.requesterOpenId ?? '')`，不是 → `{ ok:false, reason:'not-owner', message:'本机管理员名单只有主人能改。' }`（新文字，加进 `messages`；3.7 "本机管理员名单只有主人触发的那一轮能改"）。
   - `adminRead` → 把 `ToolContext.admin` 的判定抽成 `isAdminTurn(grant, auth): Failure | undefined`（两边共用，工具侧行为不变），跑它；成功回 `role`。
   - `memory` → `authorizeMemory(grant, auth)`；成功 `{ ok:true, role: auth ? roleOf(auth) : 'bot', openId: auth?.facts.requesterOpenId }`。
   - `schedule` → `authorizeSchedule(grant, auth, action.action, action.taskId)`；成功 `{ ok:true, role, actor: sessionActorOf(grant, auth) }`，`sessionActorOf` 复用 `scheduleActor(grant, auth)` 的取值但 `kind:'session'`（`chatId` 来自 `grant.place.chatId`）。
4. 任何分支都不改 grant/turn 状态（只读），除了第 1 条的 `revoke`。

`run.ts` 子进程侧的 responder 加 `authorizeSessionCall` 分支 → `entries.authorizeSessionCall(...)`，回 `{ kind:'sessionAuthz', result }`。同进程分支直接调。

### 4.3 host：`askBot` 接上、临时放行翻转

- `supervisor.ts`：`askBot(appId, sessionId, action)` → 找 `appId` 的子进程；没有或 `!proc.connected` → `{ ok:false, reason:'turn-ended', message: 设计 15 节"这一轮已结束" }`；有 → `child.ipc.call({ kind:'authorizeSessionCall', sessionId, action }, { ms: 5_000 })`；超时/IPC 错 → 同样 `turn-ended`（**拒绝是安全方向**）。同进程模式直接调 `entries.authorizeSessionCall`。装进 `AuthzDeps.askBot`。
- `authz.ts`：`bot` 行在 host 范围核对（D4a 4.5）之后调 `askBot`；`askBot` **缺** → `permission_denied`（翻转 D4a 4.6 的临时放行，删掉那段注释）；`ok:false` → `RpcError(reason === 'not-dm' ? 'not-dm' : 'permission_denied', message)`，`details.reason = reason`；`ok:true` → `Decision` 带 `{ role, openId, actor }` 给 handler。kind → `SessionAction` 的映射表写在 `authz.ts`：`settings.save`、`settings.act.*`（非 adminMember）、`collaboration.createProject/editProject` → `settingsWrite`；`settings.act.adminMember` → `adminMember`；私聊令牌的 `command.refresh/listPendingGroups/listJoinedGroups/listGroupMembers`、`settings.read/sessions/models` → `adminRead`；`memory.*` → `memory`；`schedule.*` → `schedule { action: payload.request.action, taskId: payload.request.taskId }`。
- `http.ts` 的 `dispatch` 把 `decision.grant`（`role/openId/actor`）传给 `rpc/memory.ts`、`rpc/schedule.ts`、`rpc/settings.ts`。

### 4.4 schedule：actor 代替 via

- `AdminService.executeSchedule(botId, actor: ScheduleActor, request)`；`supervisor.ts:535-539` → `child.ipc.call({ kind:'schedule', actor, request })`；`handle-message.ts:9712-9728` 的 `schedule(via, request)` 删掉，只留 `scheduleAs(actor, request)`；`rpc/schedule.ts` 的 `scheduleRpc(service, actorFor(peer, decision), payload)`：owner → `{ kind:'local', via: VIA[clientKind] }`；bot-session → `decision.actor`（`kind:'session'`）。
- `schedule-commands.ts`：`mayCreate/denial/creator` 认 `session`：权限按 `role`（和 `chat` 一样：成员能不能碰别人的任务、跨群 id），`chatId` 必须等于任务的群；`creator(actor)` → `{ via:'cli', openId, name, role, messageId }`（`scheduleCreatorSchema` 的 `via` 枚举已有 `cli`，不改 protocol；`text` 不填）。界面上"由谁创建"因此显示命令行 + 人名。

### 4.5 memory：角色透传

- `rpc/memory.ts`：`memoryAction(request, { origin: clientKind==='cli' ? 'cli' : 'ui', actor: decision ? { openId: decision.openId, role: decision.role } : undefined })`；`admin/memory.ts:84` 的 `deps` 加 `actor?: MemoryActor`，有就用它当 `MemoryActor` 传进 `memory-store`/`memory-authority`（落点规则照旧：role 是 owner/admin 且 openId 有值才进 bot 记忆，member/bot 进项目记忆），没有照今天的本地角色。

### 4.6 顺序

4.1 → 4.2（先单测 registry）→ 4.3 → 4.4 → 4.5 → 集成测试。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/agent-entries.test.ts`（改/新 `agent-entries-session.test.ts`） | 私聊成员那一轮 | 建 p2p grant、`openTurn` 为成员（`isAdmin` 假）→ `authorizeSessionCall(id,{kind:'settingsWrite'})` → `{ ok:false, reason:'not-admin' }`，message 等于工具的 `not-admin` 文字。main 必败 |
| 同上 | 主人/管理员那一轮 | 管理员 → `ok:true, role:'admin'`；主人 → `role:'owner'` |
| 同上 | 开关关 | `chatSettingsOn: () => false` → `switch-off` |
| 同上 | 群 grant | `place.kind:'group'` + `settingsWrite` → `not-dm`（Bot 进程也拒，host 已先拒；双保险） |
| 同上 | adminMember | 管理员那一轮 → `not-owner`；主人那一轮 → ok |
| 同上 | adminRead | 成员那一轮 → 拒（同 `ctx.admin`）；管理员 → ok；工具侧 `ctx.admin` 的现有测试不变 |
| 同上 | memory 角色 | 成员那一轮 → `ok, role:'member', openId`；bot 自己（`requesterKind !== 'user'`）→ `role:'bot'`；`doc` place → `unknown-tool` |
| 同上 | schedule | 群 grant 成员那一轮 `create` → `ok, actor.kind==='session', actor.chatId===群`；p2p grant → `not-group`；`presence:'scheduled'` 的轮 `create` → `no-human-create`；`edit` 别的 taskId → `scheduled-run-scope` |
| 同上 | 一轮结束 | `openTurn` 结束（`active=false`）→ `turn-ended`；线程 `isAlive()` 假 → `turn-ended` 且 grant 被 revoke（`sessions.revoke` 被调）；不存在的 sessionId → `turn-ended` |
| `daemon/test/admin-ipc.test.ts`（改） | 新 op | `authorizeSessionCall` 往返；`schedule` op 带 `actor` 而不是 `via` |
| `daemon/test/authz-session.test.ts`（改，D4a 的） | 翻转 | 群令牌 `schedule.create` 在**没有** `askBot` 时 → `permission_denied`（D4a 的临时放行用例改成这条）；注入 `askBot` 回 ok → 到达 handler |
| `daemon/test/authz-bot.test.ts`（新，`startFixture` + 假 `askBot` 记录调用） | 映射 | `settings.save` → `askBot` 收到 `settingsWrite`；`settings.act.adminMember` → `adminMember`；私聊令牌 `command.listJoinedGroups` → `adminRead`；`memory.add` → `memory`；`schedule.edit {taskId}` → `schedule{action:'edit', taskId}`；群令牌 `settings.save` **不**调 `askBot`（host 先拒 `not-dm`） |
| 同上 | 拒绝透传 | `askBot` 回 `{ok:false, reason:'turn-ended'}` → 错误 `permission_denied`、`message` 是"这次调用对应的那一轮对话已经结束，不能再改设置。"、`details.reason 'turn-ended'`；回 `not-dm` → 错误码 `not-dm` |
| 同上 | Bot 进程不在 | `askBot` 抛/超时 → `permission_denied` + `turn-ended` 文字；handler 未被调 |
| 同上 | 范围 + 轮 | 私聊主人那一轮 `settings.save project{本 bot 的另一个群}` → 过（设计 D4b 验收第 4 条）；`project{别的 bot 的群}` → host 拒，`askBot` 未调 |
| `daemon/test/schedule-commands.test.ts`（改） | session actor | `creator({kind:'session', …})` → `via:'cli'`、`openId`、`role`；成员 `session` actor 删别人的任务 → 和 `chat` 成员一样被拒；`chatId` 不等 → 拒 |
| `daemon/test/rpc-memory.test.ts`（新或改） | 落点 | 群令牌 + `askBot` 回 `role:'member'` → `memory.add {scope:'bot'}` 落到项目记忆（`memory-store` 的 spy 收到 `actor.role 'member'`）；`role:'admin'` + openId → bot 记忆。main 必败 |
| `daemon/test/supervisor.test.ts`（改） | askBot 接线 | 有子进程 → `ipc.call` 收到 `authorizeSessionCall`；无子进程 → `turn-ended`；`executeSchedule` 发 `actor` |
| 端到端（`daemon/test/cli-session-authz.test.ts`，新，fixture + 假 bot 进程） | 六条验收 | 用假 `askBot` 逐条复现设计 5.2 D4b 验收：成员轮 `settings set` exit 4；开关关 exit 4；管理员轮 `settings act admin add` exit 4、主人轮 exit 0；主人轮改另一个群 exit 0；成员轮 `memory add --bot` 到项目记忆；轮结束后同令牌 exit 4 文字"已经结束" |

## 6. 自测和验收

Linux 自测：

1. `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/agent-entries*.test.ts packages/daemon/test/admin-ipc.test.ts packages/daemon/test/authz-*.test.ts packages/daemon/test/schedule-commands.test.ts packages/daemon/test/rpc-memory.test.ts packages/daemon/test/supervisor.test.ts packages/daemon/test/cli-session-authz.test.ts packages/daemon/test/cli-parity.test.ts`；typecheck、lint、build。`rm -rf -- "${T:?}"`。
2. 真飞书（整批验收时在 Bot 6，`accept-home2`，按 #422 目录锁；本片 PR 标"待整批验收"）：
   - 私聊里 owner 说"用命令行把测试群 A 的权限改成只读"，Claude 跑 `vonvon settings set … --scope bot=…` 成功，回复写改前 → 改后；
   - 测试群里一个成员账号（lark-cli 的另一个 profile，若有）说同样的话 → 被拒，回复含"设置只能在私聊里改"；没有成员账号就用 owner 在群里说，群令牌本来就拒；
   - 关掉"聊天改设置"开关后私聊再试 → 被拒；
   - 私聊里 `vonvon settings act admin add <openId> --scope …`：管理员那一轮拒（需要管理员账号；没有就只验主人那一轮过）；
   - 群里成员那一轮 `vonvon memory add --bot "…" --scope …` → `memory list --json` 里那条在项目记忆；
   - 让 Claude 在一轮里跑 `sleep 70 && vonvon settings set … --scope …` 后台（轮已结束）→ exit 4 "已经结束"。
   不贴 openId、群号。

Mac 后验：无专项。Windows：无。

## 7. 文档

- `docs/product.md` 本片不改；D0 的 3.7 已按三层写（命令行和工具同一套判法、`turn-ended`、管理员名单只有主人）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. `authorizeSessionCall` 调的是 `authorizeNow / authorizeMemory / authorizeSchedule / isAdminTurn` 本身，不是复制的逻辑（diff 里没有第二份"not-dm → unknown-origin → turn-ended…"链）。
2. 没有活着的轮、grant 不存在、线程已死、Bot 进程不在、IPC 超时 → 全部拒绝，文字"这次调用对应的那一轮对话已经结束，不能再改设置。"
3. `adminMember` 要 `isOwner(requesterOpenId)`，管理员那一轮拒。
4. 群令牌的设置写不经 IPC（host 先拒）；私聊令牌经 IPC。
5. D4a 的临时放行已删，`askBot` 缺时 ★ 行拒绝，有测试。
6. `ScheduleActor.session` 在 `mayCreate/denial/creator` 都被认；`creator` 回 `via:'cli'` + openId/role；`scheduleCreatorSchema` 不改。
7. `executeSchedule` 的 `via` 参数已换成 actor，桌面端和 owner CLI 的行为不变（现有 schedule 测试仍绿）。
8. memory 的 `actor` 透传到落点判定；成员那一轮 `--bot` 进项目记忆。
9. `askBot` 超时 5 秒，不用 `ADMIN_IPC_TIMEOUT_MS` 的 15 秒。
10. 行数 ≤1,500；diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 估计约 850 行（ipc 60、registry 150、supervisor/authz 150、schedule 120、memory 60、测试 310）。
- `isAdminTurn` 的抽取可能改动 `ToolContext.admin` 周围代码；现有工具测试是护栏，行为不能变。
- `authorizeSessionCall` 和工具调用并发：都在 Bot 进程的事件循环里同步跑，`grant.turn` 不会在判定中途变；判定结果到 host 再到 handler 之间轮可能结束——窗口里的一次写入和工具的情况一样（工具也是先判后做），设计 5.2 接受。
- `TurnAuth.facts.requesterOpenId` 为空的轮（bot 自己触发、定时运行）：`roleOf` 回 `'bot'`，`settingsWrite` 被 `not-human-turn`/`not-admin` 拒，memory 进项目记忆；和工具一致。
- 真飞书验收里"成员账号"和"管理员账号"依赖测试环境有第二个 lark-cli profile；没有就只能验主人路径，其余靠单测，PR 里写明。
