# D4a `devices-4a-scope`：会话令牌、`--scope`、host 能判的权限表、维护子集、本地命令在会话里拒

总设计见 `docs/plans/devices.md` 5.1、5.2（host 判的部分）、5.3、4.5（维护子集）、4.7（排空白名单）、8.3、第 15 节的会话文案。共用契约在 `docs/plans/devices-1-identity.md` 4.0（`Principal`、`authz.ts` 的 `Rule/Decision`、`admin.negotiate`、`scopeSchema`、`MAINTENANCE_KINDS`、`DRAIN_KINDS`、IPC 通道名 `fcb.host.req/res`、错误码）。缩写同 D1。

## 1. 做什么

用户能看到的：完全访问档的 Bot 在 shell 里跑 `vonvon …` 时，不再悄悄以主人身份连 daemon——它必须带会话令牌和 `--scope bot=<appId>[,group=<chatId>]`，范围不能比会话大；群会话里 `settings set`、`settings act`、`group create`、`group set` 一律被拒且文字是"设置只能在私聊里改。请对方去私聊里跟我说。"；会话里 `daemon restart`、`update`、`remote enable`、`pair` 等运维命令一律 exit 4；群会话的 `snapshot`、`settings get` 只看到自己 bot 和本群。协议不同的客户端只能用维护子集；排空期间 `coreUpdateStatus` 仍能查。

依赖：D1。被依赖：D4b、C5（memory 的 `origin`）、K1、U2（维护子集的界面）。

## 2. 范围

做：host 侧令牌表和 bot→host IPC；bot 子进程起会话时拿令牌放进 `VONVON_SESSION`；服务端按 `vs1.` 前缀认 bot-session 主体；CLI 在会话里不读不发 `local-credential`、没令牌即拒；全局 `--scope` 经 `admin.negotiate`，daemon 核上限；权限表 bot-session 列里 host 能判的行（含群/评论令牌设置写一律 `not-dm`）、`filterSnapshot`、维护子集执行、`DRAIN_KINDS` 替换写死的两条、memory `origin` 透传、8.3 本地命令在会话里拒、`schedule.ts`/`memory.ts` 的整体拒绝改放行。

不做：★ 行问 Bot 进程（本片 ★ 行**在范围内放行**，见 4.6，D4b 换成真判）、`adminMember` 的主人判定、`ScheduleActor` 的 `session` 种类、memory 角色透传 → D4b；skill 文字 → K1；桌面端维护子集界面 → U2。

## 3. 现在的代码

- `D/config/session-env.ts`：`SESSION_ENV='VONVON_SESSION'`；`inBotSession(env)` = `Boolean(env[SESSION_ENV]) || env.FEISHU_CODEX_BRIDGE === '1'`。
- `D/agent/session-profile.ts:42`：`env: { [SESSION_ENV]: '1', ...input?.env }`（`input.env` 能覆盖）；`D/config/execution.ts:249` 的 `executionSessionProfile` 透传 env。
- `D/bot/handle-message.ts` 约 1395-1407：线程创建循环——`profileOf(...)` 算 profile，`entries?.issue(place)` 发 `AgentEntry`，`create({...opts, entry})`，`entry?.attach(thread)`；`profileOf` 在 1152、1401、3713、3981、4019 被调，但都汇到这个 `create`。
- `D/agent/entry/registry.ts`：`createAgentEntries(opts)` 里 `grants: Set<Grant>`，`issue(place)` 建 grant，`revoke(grant)`（151）在线程死、`closeAll` 时调；`Grant.place.kind` 是 `'p2p' | 'group' | 'doc'`。
- `D/admin/ipc.ts`：`ADMIN_IPC_REQ/RES`（host→bot）、`AdminIpcOp`、`createAdminIpcCaller(send)`、`createAdminIpcResponder(execute, send)`、`ADMIN_IPC_TIMEOUT_MS=15_000`；`D/bot/supervisor.ts:283-300` 给每个子进程接 caller 和 `fcb.connection`/诊断；`D/cli/commands/run.ts:120-150` 子进程侧接 responder。
- `D/server/ws.ts`：hello 的凭据比较（`timingSafeEqual`）；排空白名单写死 `admin.daemonStatus`、`machine.stopHost`；`http.ts` 的 `control()` 同样写死。
- `D/server/authz.ts`（D1）：所有 kind `botSession:'deny'`，`authorize` 对非 owner 一律 `permission_denied`。
- `D/server/rpc/memory.ts:13-15`：`memoryAction(request)` 不带 origin（总是 `'ui'`）；`D/admin/memory.ts:84` 的 `memoryAction(request, deps:{ origin?: 'ui'|'cli' })`。`D/server/rpc/schedule.ts:9-16`：`VIA = { desktop:'desktop', web:'desktop', cli:'cli' }`。
- `D/server/snapshot.ts`：快照形状（`agents`、项目/群、`jobs`、`diagnostics`、`host`、`platform`…）；`http.ts:148-158` 把快照推给所有 peer；D2 后是 `hub.publish(event, shape?)`。
- `D/cli/index.ts`：preAction 的租约例外表；`D/cli/daemon-client.ts`：`connectLocalDaemon(home, cliEntry)` → `connectLocal`，`withDaemon(fn, connect, timeouts)`；`CL/transport-local.ts` 自己读 `local-credential`。
- 今天的会话拒绝：`cli/index.ts:35`（secrets）、`commands/schedule.ts:154-157`、`commands/memory.ts:42-44`、`commands/secrets.ts:69` 的 `refuseInSession`（`CommandError('refused', SESSION_REFUSED, { reason:'not_in_session' })`）。
- `D/cli/command-error.ts` 的 `rpcErrorKind` 已含 `scope_required / session_token_missing / not_in_session / not-dm / permission_denied → 4`、`protocol_mismatch → 3`。
- `D/agent/entry/registry.ts:48` 的 `not-dm` 文字：`设置只能在私聊里改。请对方去私聊里跟我说。`；schedule 的 `not-group` 文字在 `scheduleRefusalMessages`。

## 4. 怎么改

### 4.1 `D/host/session-tokens.ts`（host 进程内存表）

```ts
export interface SessionRecord { appId: string; chatId?: string; place: 'dm' | 'group' | 'comment'; threadId?: string; sessionId: string; issuedAt: number; lastUsedAt: number }
export interface SessionTokens {
  issue(input: Omit<SessionRecord,'issuedAt'|'lastUsedAt'>): string;      // 'vs1.' + sessionId + '.' + base64url(randomBytes(32))；同 sessionId 再 issue 就替换
  resolve(token: string): SessionRecord | undefined;                     // 形状不对、不存在、secret 不等（timingSafeEqual 比 sha256）、24 h 没用 → undefined（过期的顺手删）
  revoke(sessionId: string): void; revokeAll(appId: string): void; size(): number;
}
export const SESSION_TOKEN_RE = /^vs1\.(ses_[0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
export function looksLikeSessionToken(value: string | undefined): boolean;
export function createSessionTokens(opts?: { now?: () => number; idleMs?: number /* 86_400_000 */ }): SessionTokens;
```

不落盘，不进日志（`log` 只记 `sessionId`，不记 token）。

### 4.2 bot → host IPC（`D/admin/ipc.ts`）

把 `createAdminIpcCaller/Responder` 的实现泛化成 `createIpcCaller<Op,Reply>(reqChannel, resChannel, send, timeoutMs)` / `createIpcResponder(...)`，原来的两个导出保持签名不变（内部调泛型）。新增：

```ts
export const HOST_IPC_REQ = 'fcb.host.req' as const; export const HOST_IPC_RES = 'fcb.host.res' as const;
export type HostIpcOp = { kind: 'issueSessionToken'; appId: string; chatId?: string; place: 'dm'|'group'|'comment'; threadId?: string; sessionId: string } | { kind: 'revokeSessionToken'; sessionId: string };
export type HostIpcReply = { kind: 'token'; token: string } | { kind: 'ok' } | { kind: 'error'; message: string };
export interface HostApi { issueSessionToken(input): Promise<string>; revokeSessionToken(sessionId: string): Promise<void> }
export function createHostIpcCaller(send): HostApi & { onMessage(msg: unknown): void };
export function createHostIpcResponder(api: HostApi, send): { onMessage(msg: unknown): void };
```

- `supervisor.ts`（283-300 一带）：每个子进程 `proc.on('message', hostResponder.onMessage)`，`hostResponder = createHostIpcResponder({ issueSessionToken: tokens.issue 包装（校验 `appId === c.bot.appId`，不等抛）, revokeSessionToken }, msg => proc.send(msg))`；子进程退出（`exit` 处理处）→ `tokens.revokeAll(appId)`。
- `run.ts` 子进程分支：`hostApi = createHostIpcCaller(msg => process.send!(msg))`，`process.on('message', hostApi.onMessage)`，传进 `createBridge` 的 deps；host 和 bot 同进程的分支（如果 `run.ts` 里有）直接传 `{ issueSessionToken: async i => tokens.issue(i), revokeSessionToken: async id => tokens.revoke(id) }`。
- `tokens` 由 `startApi` 创建并放进 `deps`（服务端要 `resolve`）；supervisor 和 `startApi` 在同一个 host 进程里，共用同一个实例。

### 4.3 bot 进程：起会话拿令牌，会话结束作废

- `registry.ts`：`issue(place)` 时生成 `sessionId = 'ses_' + randomBytes(8).toString('hex')` 存进 `grant.sessionId`，`AgentEntry` 暴露 `readonly sessionId`；`createAgentEntries(opts)` 加 `opts.sessions?: { revoke(sessionId: string): void }`，`revoke(grant)`（151）末尾调 `opts.sessions?.revoke(grant.sessionId)`（幂等）。
- `handle-message.ts` 线程创建循环：`entries.issue(place)` 之后、`create(...)` 之前，`const token = await hostApi.issueSessionToken({ appId, chatId: place.chatId, place: placeOf(place.kind) /* p2p→dm, group→group, doc→comment */, sessionId: entry.sessionId })`，`opts = { ...opts, profile: withEnv(opts.profile, { [SESSION_ENV]: token }) }`（`profile` 为空时建一个只有 env 的）。`issueSessionToken` 失败（IPC 断）→ 不起会话，抛错并 `entry.revoke('start-failed')`——不退回 `'1'`。`createBridge` 的 deps 把 `hostApi` 传给 `handle-message` 和 `createAgentEntries({ sessions: { revoke: id => void hostApi.revokeSessionToken(id).catch(() => {}) } })`。
- `session-profile.ts:42` 不改（`input.env` 已能覆盖 `'1'`）。`inBotSession()` 仍为真。

### 4.4 服务端：认令牌、negotiate 核范围、维护子集、排空白名单

- `ws.ts` hello（loopback）：`credential` 以 `vs1.` 开头 → `tokens.resolve(credential)`；`undefined` → `close(4401, 'invalid_session_token')`；成功 → `principal = { kind:'bot-session', sessionId, appId, place, chatId }`，v2 serverInfo `principal 'bot-session:<place>'`。不以 `vs1.` 开头 → 照旧和 `local-credential` 比。D2 的远程路径已对任何 `credential` 关 4401。
- `admin.negotiate`（D1 只记录）加核对，bot-session 主体：`scope` 缺 → `RpcError('scope_required', 设计 15 节"--scope 缺失")`；`scope.bot !== appId` → `RpcError('scope_required', 设计 15 节"--scope 超范围"，`<X>`=appId、`<Y>`=chatId 或"（私聊会话，不限群）"）`；`place==='group'` 且（`scope.group` 缺或 ≠ `chatId`）→ 同上；`place==='dm'` 且 `scope.group` 有值 → 记下（只能缩小）；`place==='comment'` → 只允许 `bot=appId`，`group` 有值拒。记 `peer.scope`，`peer.negotiated = true`。owner 主体给了 `scope` 也记（人类终端自验 skill 用），不核上限。
- `authorize`（`authz.ts`）：
  1. `peer.principal.kind === 'maintenance'` → kind 在 `MAINTENANCE_KINDS` 里放（它含 `machine.stopHost`，0.8 的桌面端和 CLI 停 0.9 的 daemon 靠它，D1 审查 R2），否则 `RpcError('protocol_mismatch', …)` 附 `{ serverProtocol, clientProtocol, serverVersion, clientVersion }`（放进 `message` 后的结构化字段：`errorEnvelopeSchema` 加可选 `details?: Record<string, unknown>`——契约小加项，客户端宽松解析不受影响）。连续 20 条维护子集外的请求 → `close(4001,'protocol_mismatch')`。维护子集的连接不收 `snapshot` 事件（`hub.publish` 的 `shape` 对 maintenance peer 回 `null`）。
  2. `bot-session`：`!peer.negotiated` 且 kind 不是 `admin.daemonStatus`/`admin.negotiate` → `scope_required`；然后查表 `RULES.get(kind).botSession`：`deny` → `permission_denied`（通用文字"这个操作不能从 Bot 会话里做。"；表里标了专用文字的行用专用的：设置写 `not-dm`，schedule 在私聊/评论 `not-group`）；`host` → 4.5 的 host 判定；`bot` → 4.6。
  3. `owner` → 放。
- `DRAIN_KINDS`：`ws.ts`、`message-loop.ts`（D2）和 `http.ts` 的 `control()` 都改用它（多了 `machine.coreUpdateStatus`）。
- `capabilities()` 加 `'session-scope'`。

### 4.5 权限表的 bot-session 列（`authz.ts` 填值）

| kind | botSession | host 判定（本片） |
|---|---|---|
| `snapshot.get`、事件 `snapshot` | host | 回复/事件经 `filterSnapshot(snapshot, principal, scope)` |
| `command.refresh / listPendingGroups / listJoinedGroups / listGroupMembers` | 群令牌 host；私聊令牌 bot；评论 deny | 请求里的 `agentId` 必须等于 `appId`，否则 `permission_denied`；群令牌 `listJoinedGroups` 结果只留本群、`listGroupMembers` 的 `chatId` 必须是本群 |
| `command.registerAgent / refreshAgentCredentials / bindGroup / setAgentEnabled / deleteAgent / cancelJob / restartHost`、`machine.stopHost` | deny | — |
| `settings.read / sessions / models` | 群令牌 host；私聊 bot；评论 deny | 群令牌：`scope` 只能是 `project{chatId==本群}`（`sessions` 同），回复各段标只读、`reason:'not-dm'`（和 `settings_get` 在群里一致，复用它的标法）；私聊令牌（★ 之后）：`host` 段 deny、`agent{appId}`、`project{本 bot 的群}`、`session{appId}` |
| `settings.save / act.*` | 群、评论 deny（**文字 `not-dm`**）；私聊 bot | 私聊令牌范围：`host` 段 deny；`agent{appId}` 和不带项目的 act（`voice`、`adminMember`、`commentInstructions`）只在 `scope.group` 没给时放（带了 `group=` 就只能动那个群，设计 5.3，这一轮是主人也一样）；`project{本 bot 的群 ∩ scope.group（有的话）}`；`act adminMember` 另在 D4b 要主人 |
| `collaboration.history / context / project / providerModels / usage` | host | 限自己 bot；群令牌限本群（请求里的 `chatId`/项目 id 必须属于本群）；`history` 回复里 provider 按目录列出的 `threads` 只留本群绑定的会话（同目录别的群、主人终端的不给） |
| `collaboration.createProject / editProject` | 群、评论 deny（`not-dm`）；私聊 bot | 私聊：`createProject` 只在 `scope.group` 没给时放（建新群超出那个群）；`editProject` 的项目必须是本 bot 的（∩ scope.group） |
| `collaboration.removeProject / clear / compact / resume / startGoal / stop / stopSubagent / endGoal / reminder / shareUsage` | deny | — |
| `environment.*`、`machine.*`（除 `stopHost` 上面已 deny）、`admin.*`（除 `daemonStatus`、`negotiate`） | deny | — |
| `directory.*`、`library.workspace / rename / previous / delete`、`contextPreview.get` | deny | — |
| `library.list` | host | 过滤成自己 bot（群令牌本群）的项 |
| `memory.*` | 评论 deny；其余 bot | host 先核范围：请求里的 `botId`/`projectId`/`chatId` 属于本 bot（群令牌只本群），不属于 → `permission_denied`；★ 之后进 `memoryAction(request, { origin:'cli', actor })` |
| `schedule.*` | 群令牌 bot；私聊、评论 deny（**文字 `not-group`**，复用 `scheduleRefusalMessages`） | host 先核 `botId === appId`、`chatId === 本群`；★ 之后进 `scheduleRpc` |
| `device.*` | deny | — |
| `admin.daemonStatus`、`admin.negotiate` | host | 放 |

"属于本 bot 的群"从快照/项目表查（`getProjectByChatId`、agents 的 `groups`），`AuthzDeps` 提供 `groupsOf(appId): Promise<Set<string>>`。

### 4.6 ★ 行在本片的处理（临时）

`AuthzDeps.askBot?: (appId, sessionId, action) => Promise<{ ok: true; role: 'owner'|'admin'|'member'|'bot'; actor?: ScheduleActor } | { ok: false; reason: string; message: string }>`。本片**不提供** `askBot`：`authorize` 遇到 `bot` 行且 `askBot` 缺 → 走完 4.5 的 host 范围核对后放行，`role:'member'`。这就是设计 13 节 D4a 验收"群令牌 `schedule add`、`memory add` 放行到 ★"的含义。D4b 接上 `askBot`，并在测试里断言"没有 `askBot` 时 ★ 行拒绝"（把这个临时放行翻过来）。**偏差**：集成分支在 D4a 合入、D4b 未合入的窗口里，私聊令牌的设置写只核范围不核这一轮；窗口内没有发布，D4b 紧接着做。

### 4.7 `filterSnapshot`（`D/server/snapshot-filter.ts`）

`filterSnapshot(snapshot, principal: BotSessionPrincipal, scope: Scope | null): Snapshot`：`agents` 只留 `appId`；项目/群只留本 bot 的，群令牌只留 `chatId`，`scope.group` 有值再缩到它；`jobs` 只留 `agentId === appId`；`diagnostics`、`logs`、`pendingGroups` 清空；`host`、`platform`、`version` 保留；评论令牌：群列表清空，只留 bot 本身。`hub.publish(event, peer => peer.principal.kind==='bot-session' ? filtered(event) : peer.principal.kind==='maintenance' ? null : event)`；`snapshot.get` 的回复同样过滤。`device` 事件只给 `owner`（D1 第 4.0 节预留的收口）。

### 4.8 `D/server/rpc/memory.ts`、`schedule.ts`

`memoryAction(request, { origin: peer.clientKind === 'cli' ? 'cli' : 'ui', actor })`（`actor` 本片对 owner 不传、对 bot-session 传 `{ role }`，D4b 补 `openId`）；`scheduleRpc` 对 owner 照旧 `{ kind:'local', via: VIA[clientKind] }`，bot-session 本片仍走 `local`（D4b 换 `session` actor）。

### 4.9 CLI

- `CL/transport-local.ts`：`connectLocal({ home, cliEntry, credential? })`——`credential` 给了就**不读** `local-credential`。`ConnectionError` 加 `closeCode?`、`closeReason?`（握手期间被关时带上）。
- `D/cli/daemon-client.ts` 的 `connectLocalDaemon(home, cliEntry, env = process.env, scope?)`：`inBotSession(env)` → `token = env[SESSION_ENV]`；`!looksLikeSessionToken(token)`（没有、`'1'`、只有 `FEISHU_CODEX_BRIDGE=1`、格式坏）→ **连接之前**抛 `CommandError('refused', 设计 15 节"会话里没有令牌", { reason:'session_token_missing' })`；否则 `connectLocal({ ..., credential: token })`；握手被关且 `closeReason === 'invalid_session_token'` → `CommandError('refused', '会话令牌已失效（会话结束或超过 24 小时没用）。', { reason:'session_token_invalid' })`；`command-error.ts` 把 `session_token_invalid` 加进 4 那组。`verifyPidLockOwner` 在会话里**不跑**（它读 `local-credential`）：会话里只按 pid 锁的 `listen` 连。
- `withDaemon`：连上后，`inBotSession(env) || scope` → 先 `client.admin({ type:'negotiate', capabilities:['cli'], scope })`，`refused`/错误 → 按 `rpcErrorKind` 退出（exit 4，文字是 daemon 的）。
- `program.option('--scope <spec>', 'bot=<appId>[,group=<chatId>]')`，`parseScope(spec)`：形状不对 → `badArgs('--scope 的写法是 bot=<appId>[,group=<chatId>]。')`（exit 2）。放进 `withDaemon` 的上下文。
- `index.ts` preAction：常量 `LOCAL_ONLY = new Set(['daemon run','daemon start','daemon stop','daemon restart','service install','service uninstall','update','remote status','remote enable','remote disable','remote port','pair','clients ls','clients rename','clients revoke','device rename','bot repair-dir','secrets get','open','__daemon-control','__restart-after-exit'])`（命令全路径名，`update` 要等 I3 的命令存在才有效，先登记无妨）；`inBotSession(env)` 且命令在集合里 → `CommandError('refused', 设计 15 节"会话里跑运维命令"，`<命令>` 代入, { reason:'not_in_session' })`。`daemon status`、`--version`、`service status` 不在集合里。`secrets get` 已有自己的拒绝，集合里重复登记无害。
- `commands/schedule.ts:154-157`、`commands/memory.ts:42-44` 的整体 `refuseInSession` **删掉**：会话里有令牌 + `--scope` 就连 daemon，由 daemon 判；`secrets.ts:69` 保留。

### 4.10 顺序

4.1 → 4.2 → 4.3（bot 端）→ 4.4（服务端认令牌、negotiate）→ 4.9（CLI）→ 4.5/4.6/4.7（表和过滤）→ 4.8 → 测试。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/session-tokens.test.ts`（新，假时钟） | 往返 | `issue` 回值匹配 `SESSION_TOKEN_RE`；`resolve` 回记录；改 secret 一位 → undefined；`revoke` 后 undefined；`revokeAll(appId)` 只清该 bot；推进 24 h 1 s → undefined 且 `size()` 减 1；两次 `issue` 同 sessionId 旧令牌失效。main 必败 |
| `daemon/test/host-ipc.test.ts`（新） | caller/responder | 假 `send` 对接：`issueSessionToken` 回令牌；`appId` 不匹配 → `error`；5 s 不回 → reject；`createAdminIpcCaller` 的旧测试不变 |
| `daemon/test/agent-entries.test.ts`（改） | sessionId 和 revoke | `issue(place).sessionId` 匹配 `ses_`；线程死后 `opts.sessions.revoke` 被调一次；`closeAll` 对每个 grant 调 |
| `daemon/test/handle-message-session.test.ts`（新或并入现有线程创建测试） | 令牌进 env | 假 `hostApi` → 线程 `profile.env.VONVON_SESSION` 是令牌，`inBotSession(env)` 为真；`issueSessionToken` 抛 → `create` 不被调、`entry.revoke('start-failed')`。main 必败 |
| `daemon/test/server-handshake.test.ts`（改） | 令牌 hello | `credential:'vs1.…'` 有效 → serverInfo `principal 'bot-session:group'`；坏令牌 → 4401 reason `invalid_session_token`；`local-credential` 照旧 |
| `daemon/test/authz-session.test.ts`（新，`startFixture` + 真令牌） | negotiate 门 | 未 negotiate 发 `command.refresh` → `scope_required`；`admin.daemonStatus` 放 |
| 同上 | 范围 | 群令牌 `--scope bot=X` → `scope_required` 文字含"超过"；`bot=X,group=Y` 过；`bot=Z,group=Y` 拒；`group=其他群` 拒；私聊令牌 `bot=X` 过、`bot=X,group=Y` 过且后续 `settings.save project{别的群}` 拒；评论令牌带 `group` 拒；第二次 negotiate `invalid_request` |
| 同上 | 群令牌设置写 | `settings.save`、`settings.act.voice`、`collaboration.createProject`、`collaboration.editProject` → 错误 `not-dm`，`message === '设置只能在私聊里改。请对方去私聊里跟我说。'`。main 必败 |
| 同上 | 群令牌只读 | `settings.read project{本群}` 过且各段只读 `reason 'not-dm'`；`settings.read agent{X}` 拒；`listGroupMembers` 别的群拒 |
| 同上 | deny 行 | `command.bindGroup`、`machine.stopHost`、`admin.secrets`、`device.pair`、`environment.scan` → `permission_denied`；私聊令牌 `schedule.list` → `not-group` |
| 同上 | ★ 临时放行 | 群令牌 `schedule.create {botId:X, chatId:Y}` 到达 `scheduleRpc`（spy）；`memory.add` 到达 `memoryAction` 且 `origin:'cli'`、`actor.role:'member'`；`botId` 不等 → `permission_denied` 没到 handler |
| `daemon/test/snapshot-filter.test.ts`（新） | 过滤 | 两个 bot、三个群的快照：群令牌只剩 1 bot 1 群、`jobs` 只剩自己、`diagnostics` 空；私聊令牌剩 1 bot 2 群；`scope.group` 再缩到 1；评论令牌 0 群。推送：bot-session peer 收到过滤版，owner 收全量，maintenance 不收 |
| `daemon/test/authz-maintenance.test.ts`（新） | 维护子集 | hello `protocolVersion:1` 后 `command.refresh` → `protocol_mismatch` 且 `details.serverProtocol === 2`；`admin.daemonStatus`、`machine.coreUpdateStatus` 过；连发 20 条 → 4001；不收 snapshot 事件。main 必败 |
| `daemon/test/api-listen-lifecycle.test.ts`（改） | 排空白名单 | 排空中 `machine.coreUpdateStatus` 得到回复而不是 1001。main 必败 |
| `daemon/test/cli-session.test.ts`（新） | 没令牌即拒 | `env {FEISHU_CODEX_BRIDGE:'1'}`、`{VONVON_SESSION:'1'}`、`{VONVON_SESSION:'vs1.bad'}` 三种 → `schedule list --json` exit 4 `reason 'session_token_missing'`，**没有**发生连接（spy `connectLocal` 未调），**没有**读 `local-credential`（spy `readFile`）。main 必败 |
| 同上 | 有令牌 | 有效令牌 + `--scope bot=X,group=Y` → `connectLocal` 收到 `credential` 等于令牌、未读 `local-credential`、第一条请求是 `negotiate`；缺 `--scope` → exit 4 文字含"必须带 `--scope`"；失效令牌（夹具 revoke）→ exit 4 `session_token_invalid` |
| 同上 | 本地命令 | 会话环境下 `daemon restart`、`daemon start`、`service install`、`remote enable 1.2.3.4`、`pair`、`clients ls`、`device rename x`、`bot repair-dir`、`open`、`update`（若已存在）→ 全部 exit 4 `reason 'not_in_session'`，文字含命令名；`daemon status --json`、`--version`、`service status` 正常 |
| 同上 | 不在会话 | 无会话变量：`--scope bot=X` 也发 `negotiate`；不带就不发（第一条请求不是 negotiate） |
| `daemon/test/cli-parity.test.ts`、`cli-json.test.ts` | 回归 | 不变仍绿；`--scope` 坏格式 exit 2 |

## 6. 自测和验收

Linux 自测：

1. `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/session-tokens.test.ts packages/daemon/test/host-ipc.test.ts packages/daemon/test/agent-entries.test.ts packages/daemon/test/authz-*.test.ts packages/daemon/test/snapshot-filter.test.ts packages/daemon/test/cli-session.test.ts packages/daemon/test/server-handshake.test.ts packages/daemon/test/api-listen-lifecycle.test.ts packages/daemon/test/cli-parity.test.ts packages/daemon/test/cli-json.test.ts packages/client/test`；typecheck、lint、build。`rm -rf -- "${T:?}"`。
2. 真走一遍令牌路径（临时 daemon，不碰 Paseo、`accept-home2`）：`T=$(mktemp -d)`，前缀 `HOME=$T/home VONVON_HOME=$T/vh` 起 `vonvon daemon start`；用一个只在本片 PR 里的脚本 `test/manual/session-probe.ts`（进 git，不在 vitest include）直接对 `startApi` 的 `tokens` 发一个群令牌（appId、chatId 用假值），然后：`VONVON_SESSION=<token> vonvon schedule list --json` → exit 4 缺 `--scope`；`… --scope bot=<appId>` → exit 4 超范围；`… --scope bot=<appId>,group=<chatId>` → `ok:true`（空列表）；`VONVON_SESSION=<token> vonvon settings set … --scope bot=…,group=…` → exit 4 文字"设置只能在私聊里改…"；`FEISHU_CODEX_BRIDGE=1 vonvon daemon status --json` 正常、`FEISHU_CODEX_BRIDGE=1 vonvon schedule list --json` exit 4 `session_token_missing`；`VONVON_SESSION=<token> vonvon daemon restart` → exit 4 `not_in_session`；`VONVON_SESSION=<token> vonvon pair`、`remote enable 1.2.3.4` 同样 exit 4。这些环境变量都只写在单条命令前。`daemon stop`，`rm -rf -- "${T:?}"`。
3. 真飞书（整批验收时在 Bot 6 的测试群，按 #422 的目录锁用 `accept-home2`）：群里让 Claude 跑 `vonvon schedule add … --scope bot=…,group=…` 成功、`vonvon settings set …` 被拒且回复里有"设置只能在私聊里改"、`vonvon daemon restart` 被拒；本片 PR 里标"待整批验收"。

Mac 后验：U2 的维护子集界面；本片无专项。Windows：无。

## 7. 文档

- `docs/product.md` 本片不改；D0 改 3.7（三层：进程内工具、命令行同一套规则、完全访问档的诚实边界）、3.8、新 3.14 的"命令行在 Bot 会话里"一段、第 8 节 `--scope`。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 令牌 `vs1.<ses_16hex>.<43 base64url>`，只在 host 内存；`log` 调用里没有 token 字面量（grep `token` 的日志参数）。
2. 会话里 CLI 的三种无效情况（只有 `FEISHU_CODEX_BRIDGE=1`、`'1'`、坏格式）都在**连接前**拒绝，且测试证明没读 `local-credential`。
3. bot 子进程只在 `issueSessionToken` 成功后起会话；失败不退回 `'1'`。
4. 服务端 loopback 对 `vs1.` 前缀不和 `local-credential` 比较；坏令牌 4401 reason `invalid_session_token`。
5. negotiate 的范围核对和 5.3 一致：缺拒、bot 不等拒、群令牌缺 group 或别的群拒、只能缩小；人类终端 `--scope` 可选。
6. 权限表 bot-session 列和 4.5 的表逐行一致；群/评论令牌的 `settings.save/act`、`createProject/editProject` 文字是 `registry.ts:48` 那句（import 同一个常量，不复制字符串）。
7. `filterSnapshot` 对三种令牌的结果和 4.7 一致；维护子集 peer 不收 snapshot。
8. `MAINTENANCE_KINDS`/`DRAIN_KINDS` 是三处（`ws.ts`、`message-loop.ts`、`control()`）唯一的来源，grep 不到写死的 `'stopHost'` 白名单。
9. `LOCAL_ONLY` 集合和设计 8.3 的最后一行一致；`daemon status`、`--version`、`service status` 放行。
10. `schedule.ts`、`memory.ts` 的整体拒绝已删，`secrets.ts:69` 保留。
11. 4.6 的临时放行有注释指向 D4b，且 D4b 的计划里有翻转它的测试。
12. 行数 ≤1,500；diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 估计约 1,250 行（session-tokens 120、IPC 泛化 + host api 150、bot 端 80、服务端认令牌/negotiate/维护 200、authz 表和 host 判定 250、filterSnapshot 120、CLI 200、测试 400 压缩后）。超过就把"维护子集 + DRAIN_KINDS + authz-maintenance 测试"拆成 D4a-2。
- ★ 行临时放行（4.6）是集成分支上的一个窗口，不发布；D4b 必须在同一批合入。
- `handle-message.ts` 四处 `profileOf` 只在一个 `create` 汇合这一判断要实现时核实；若有别的线程创建路径（例如评论/doc 的），同样注入令牌，否则那条路径的 CLI 会以 `session_token_missing` 被拒——这是安全的失败方向。
- `verifyPidLockOwner` 在会话里不跑：会话里连的是 pid 锁里的端口，没有 owner 校验；端口被抢占时最坏是令牌发给了抢占者，令牌只代表这条会话、24 小时失效、不能做运维，和设计 16.3 一致。
- 群令牌的只读 `settings.read` 复用 `settings_get` 在群里的只读标法，具体字段要看 `admin/service.ts` 里它怎么标；若没有现成的"只读 + reason"结构，加一个 `readOnly?: { reason: 'not-dm' }`，行数 +40。
- 完全访问档的 bot 能读 `local-credential` 自己连（设计 5.3、16.2）：本片不解决，文案在 U2，`product.md` 在 D0。

## 实现时和计划不一样的地方

1. **`secrets get` 不进 `LOCAL_ONLY`。** 计划说它"已有自己的拒绝"，但 `secrets.ts:69` 的 `refuseInSession` 只管 `list/set/remove/test`。`secrets get` 是 `secrets-getter` 的 exec 端点：会话里的 lark-cli 靠它取 App Secret，`secrets-get.test.ts` 就是在 `FEISHU_CODEX_BRIDGE=1` 下跑的。放进集合会让每个 Bot 会话里的 lark-cli 都失灵。`index.ts` 里的注释写了原因，`cli-bot-session.test.ts` 断言它不在集合里。
2. **`memory.ts` 的整体拒绝保留，只删了 `schedule.ts` 的。** 这个基线上还没有 C5，`vonvon memory` 是在进程内直接调 `memoryAction(…, { origin: 'cli' })` 写文件，不经过 daemon。删掉拒绝，会话就能以主人终端的身份写记忆。等 C5 把记忆命令改成走 daemon RPC，再删这条拒绝。
3. **会话里的 `daemon status`，有没有令牌都只读 pid 锁**（`source:'files'`，不带崩溃记录和暂停的 Bot），不连 daemon，原因有三：
   - daemon 的快照要 `--scope` 才给；
   - 崩溃文件里有别的 Bot；
   - `verifyPidLockOwner` 会读 `local-credential`。

   这样 `FEISHU_CODEX_BRIDGE=1 vonvon daemon status --json` 也能正常回答（自测 2 第 5 步）。代价是：会话里 daemon 不回应、但锁还在时，以前报连接错误，现在照锁回答"在运行"。`cli-machine.test.ts` 已相应改写：不在会话里的回退照旧，会话的情形另写一条测试。
4. **这个基线上没有 D2 和 D3、I3 的东西。**
   - 没有 `message-loop.ts`（D2）：`DRAIN_KINDS` 目前只在 `ws.ts` 和 `http.ts` 的 `control()` 两处用，D2 合入时它的 message loop 要改用同一个常量。
   - 没有 `remote …`（D3）和 `update`（I3）：这些路径先登记在 `LOCAL_ONLY`。测试断言集合里只有这几条在当前命令树里找不到；自测 2 的 `remote enable 1.2.3.4` 现在得到的是 commander 的"未知命令"（exit 2）。
5. **维护子集的 `protocol_mismatch`。** 错误码从 `permission_denied` 改成了 `protocol_mismatch`，`authz.test.ts` 和 `server-handshake.test.ts` 的旧断言已更新。`details` 由 `ws.ts` 的 `forProtocol1` 对协议 1（0.8 客户端）去掉，因为 0.8 严格解析错误信封；协议不同的其他客户端照常收到 `details`，测试用 `PROTOCOL_VERSION + 1`。"连续 20 条"按字面实现：中间有一条被放行就重新计数。
6. **`AuthzDeps` 的两处改动：**
   - **`groupsOf`** 回 `BoundGroup[]`（`name`、`chatId`、`projectId`），而不是 `Set<string>`：设置和协作请求按项目名指定项目，记忆请求按 `projectId` 指定，都要这几个字段。它读 `service.listProjects(appId)`（项目文件），不读快照，因为快照最多会落后 5 秒。
   - **`askBot`** 的签名是 `(appId, sessionId, kind, request) → { ok, role, openId? } | { ok:false, reason, message }`，`grant` 只带 `role`/`openId`。计划里的 `actor?: ScheduleActor` 留给 D4b 按需要加。
7. **群令牌的 `settings.read`。** 回复的每一段标 `access: { kind:'readonly', reason:'not-dm', message: NOT_DM_MESSAGE }`，`NOT_DM_MESSAGE` 就是 `registry.ts` 里那个常量，工具和 daemon 引用的是同一个。另外去掉了 `decisionModels`：哪些决策模型配了 key 属于本机密钥库的信息，不属于这个群。
8. **测试的文件名和放法：**
   - `cli-session.test.ts` 已经被 `vonvon session` 占用，新文件叫 `cli-bot-session.test.ts`。它是端到端测试：esbuild 打包的 CLI 跑在测试进程里的 `startApi` 上，`local-credential` 设成 0000（任何去读它的命令都会失败），代替计划里对 `connectLocal` 和 `readFile` 的 spy。
   - "不连接"的证明：三种没有令牌的情形都在一个没有 daemon、没有锁的目录里跑。如果拒绝发生在读锁之后，结果会是 exit 3"daemon 没有运行"。
   - `agent-entries.test.ts` 对应现有的 `agent-entry-registry.test.ts`；`handle-message-session` 加在 `run-retry.test.ts`，那里有现成的 orchestrator 测试架子；排空时的回复测在 `server-drain-control.test.ts`，`machine.coreUpdateStatus` 从"1001 关闭"那组挪成单独一条，那组改用 `checkCoreUpdate`。
   - 拿不到令牌时，orchestrator 会先试 resume、再试新会话，每次都有自己的 entry，每个都被作废；测试按"发出的令牌 = 作废的令牌"断言，不断言只有一次。
9. **自测 2 的做法：**
   - 用 `packages/daemon/test/manual/session-probe.ts`，在进程内起 `startApi` 和一个假服务，而不是 `vonvon daemon start`。令牌只在 host 内存里，没有真 Bot 就没有别的办法发出来。
   - `settings set` 换成了 `settings act voice test`：`settings set` 要先读设置视图，假服务没有；两者都是设置写操作，都在进 handler 之前被 `not-dm` 拒绝。
   - 结果：缺 `--scope` exit 4，超范围 exit 4，范围正确 `ok:true`，群里改设置 exit 4 并给出 `not-dm` 那句，`FEISHU_CODEX_BRIDGE=1` 时 `daemon status` 正常、`schedule list` exit 4 `session_token_missing`，`daemon restart` 和 `pair` exit 4 `not_in_session`。
10. **host 作废令牌：**
    - **supervisor 按子进程记账：** 每个子进程只作废自己发出去的那些 sessionId，不按 appId `revokeAll`。这样旧进程退出和新进程起来撞在一起时，不会误作废新进程的会话；`revokeAll` 留在表上备用。
    - **单 Bot 的 `vonvon run`（没有 supervisor）：** 自己持有一张表，交给自己的 `startApi`。
    - **测试和没有 `host` 的调用方：** 会话照旧只带 `'1'` 这个标记，CLI 会以 `session_token_missing` 拒绝。这是安全的失败方向。
11. **`withDaemon` 的 negotiate。** 发的是 `capabilities: ['cli']`。被拒时报的就是 daemon 的原话（不加"核对范围失败："前缀），退出码按 `rpcErrorKind` 算（`scope_required` → 4）。`--scope` 是挂在 `program` 上的全局选项，写在子命令前后都行。`command-error.ts` 把 `session_token_invalid` 和 `not-group` 加进了 exit 4 那组。
12. **令牌握手：** 令牌查不到、对不上或闲置超时，都用 4401 `invalid_session_token` 关闭。令牌对、但 hello 里是别的协议，用 4001 `protocol_mismatch` 关闭：会话里跑的是这台 daemon 自己的 CLI，不给维护子集。

## 审查后改了什么

写作时 Claude 两路自查的 13 条（2026-11-02，不是独立审查；独立审查交给 Codex，见 PR），逐条复核代码，能复现的复现了。

- **D4a-SEC-1 / D4A-R5（令牌作废后已开的连接还能用）→ 接受。** `SessionTokens` 加了 `active(sessionId, use)` 和 `onEnd`；作废、替换、闲置超时都通知，`http.ts` 收到后用 4401 `invalid_session_token` 关掉用这个令牌开的连接。`authorize` 每条请求先查 `sessionActive`（顺手记一次使用），不在了回 `session_token_invalid`；推快照前也查。测试：`session-tokens.test.ts` 新一条，`authz-session.test.ts` 的单元和端到端各一条。
- **D4a-SEC-2（会话里 `service status` 读 `local-credential`）→ 接受。** `getServiceAdapter({ trustLock })`：会话里 systemd 和 launchd 都不验 owner，照锁报运行。`cli-bot-session.test.ts` 在凭据 0000 时断言 `running: true`。
- **D4a-SEC-3（会话能改、删别人的记忆）→ 接受。** `memory.edit/archive` 对会话改成 deny，等 D4b 逐条跑 `decideEdit`，D4b 计划补了 4.5a。
- **D4a-SEC-4 / D4A-R6（群令牌读设置多给了字段）→ 部分接受。** 判断提示词、Skill 和路径、`botProfile`、成员名单的姓名、`decisionModels` 都去掉了。`identity` 和 `members.openIds` 保留：协议 `projectViewSchema` 要求这两项，只回 `{scope, sections}` 的话 CLI 解析回复就会失败，`settings get` 和 `settings set --group` 在群里都会坏掉。留下的都属于本群：本群的群号、后端、会话自己的工作目录，以及本群的响应名单。
- **D4a-SEC-5（`usage` 对会话放行）→ 接受。** `collaboration.usage` 单独一行，会话一律 deny，`providerModels` 照旧。
- **D4a-SEC-6 / D4A-R2（私聊令牌的私聊记忆不核 openId；`session{threadId}` 不受 `group=` 缩小）→ 接受。** 会话的 `kind:'dm'` 记忆先一律拒（`DM_MEMORY_FROM_SESSION`），D4b 计划写明要核 openId。范围缩成一个群时（群令牌，或私聊带 `group=`），请求里点名的会话必须是那个群的（`AuthzDeps.threadsOf` 读 `listSessions`），设置读写和 `models` 的 `threadId` 都核。
- **D4A-R1（群里改 Bot 级设置先读视图，拿到的是通用拒绝）→ 接受。** `settings.read.agent/read.session` 在群和评论里改成 `not-dm`，评论里的 `read.project/models/sessions` 也是。`cli-bot-session.test.ts` 补了 `settings set cards.showToolCalls=…`、`settings act admin add`、`settings act comment-instructions` 三条。
- **D4A-R3（host 自己起的子进程被 `LOCAL_ONLY` 拒）→ 接受。** 加了 `withoutSessionMarkers`，supervisor 起 Bot、`__restart-after-exit`、重启时的 `daemon start`、`runStart` 起的 `daemon run` 都用它去掉 `VONVON_SESSION` 和 `FEISHU_CODEX_BRIDGE`。旧版本升级过来时，旧代码起的 helper 还带着这两个变量，所以 `__restart-after-exit`、`__daemon-control` 移出 `LOCAL_ONLY`；带 IPC 通道的 `daemon run`（supervisor 起的）也不拒。测试：supervisor 带着这两个变量起 Bot，子进程的 env 里没有；`FEISHU_CODEX_BRIDGE=1` 下 `__restart-after-exit` 走到自己的参数检查。
- **D4A-R4（`memoryAction` 不用 actor，按 cli 记成可信）→ 接受。** 有 `deps.actor` 时按它记角色和 openId，只有 owner/admin 的那一轮记成 trusted。会话写 Bot 记忆先拒（`BOT_MEMORY_FROM_SESSION`），等 D4b 的落点规则。4.6 里“以成员身份放行”现在和代码一致了：会话写的记忆记成 member、不可信。
- **D4A-R7（主人带的 `--scope` 不生效）→ 接受。** 按设计 5.3“给了就同样生效”：主人带 `--scope` 时，用 `scopedOwner(scope)` 做和会话一样的范围核对和快照、回复过滤（`filterSnapshot`、`listBot` 裁到那个群），但不套地方规则：主人照样能写本群设置、读完整视图。请求里没有点名 Bot 的（环境、机器、host 设置、`installCodex`）不受限。

## Codex 审查后改了什么（任务 228–230）

JP-VPS 上 Codex 的三份独立审查（228 通读全部 diff，229 安全和权限模块，230 Bot 进程、IPC、CLI、protocol/client），去重后 8 条，全部接受。每条先写失败的测试，在原代码上确认失败，再改。

- **229-1 / 228-1（群会话经 history 读到同目录别的群、主人终端的会话）→ 接受。** 会话和带 `--scope` 的主人调 `collaboration.history`，回复里 provider 按目录列出的 `threads` 只留 sessionId 属于本群绑定会话的（`sessions` 里的），证明不了归属的不给；`http.ts` 的 collaboration 回复套上 `shown`。没给 `--scope` 的主人照旧看完整历史。测试：`authz-session.test.ts` 经真实 wire，两个群共用一个目录、主人在同目录开原生会话，群令牌和带范围的主人都只拿到本群的那条，别的 preview、name、sessionId 都不出现。
- **229-2 / 228-3（私聊令牌带 `group=` 仍能改整个 Bot 的设置、建新群）→ 接受。** 范围只到一个群时（私聊带 `group=`，或主人带 `group=`），`settings.save` 的 `agent` 范围、不带项目的 `settings.act`（`voice`、`adminMember`、`commentInstructions`）和 `createProject` 一律拒，文字是新的 `ONE_GROUP_ONLY`。这一步在问 Bot 进程之前，所以这一轮是主人也照样拒。读整个 Bot 的设置不受影响（只读，不算"动"）。4.5 表的 `settings.save / act.*`、`createProject` 两行已同步。测试：单元的正反用例（含 `askBot` 回 owner），以及 wire 上 `createProject` 被拒、处理函数没被调。
- **229-3 / 228-2（`schedule.listBot` 的回复没套 `decision.narrow`）→ 接受。** `http.ts` 的 schedule 回复改用 `shown(payload)`。测试：wire 上主人 `--scope bot=X,group=A` 的 `listBot` 只回 A；CLI 上 `schedule list --all --scope bot=X,group=A` 只回 A，不带 `--scope` 回 A 和 B。
- **229-4（带范围的主人还能绑别的群、动别的 Bot）→ 接受。** command 按每种命令的目标核：`bindGroup`、`listGroupMembers` 核群；`setResponse`、`setPermission` 从 membershipId（`[appId, chatId]`）核 Bot 和群；`setAgentEnabled`、`deleteAgent`、`refreshAgentCredentials` 只在范围是整个 Bot 时放；`registerAgent` 超出任何范围；不点名 Bot 的（`installCodex`、`restartHost`、`cancelJob`）照旧是机器的。admin 里带 `agentId` 的核 Bot，`switchBackend` 再核项目，`confirmCardCallback` 按整个 Bot 算；library 的 `previous` 核群，`workspace`、`rename`、`delete` 的项目要是范围内的群绑的。测试：单元逐条，CLI 上 `group bind oc_outside … --scope bot=X,group=A` exit 4 且 `bindGroup` 没被调。
- **230-1（Claude 常驻线程在两轮之间退出，令牌没作废）→ 接受。** `ClaudeAgentThread` 的消息流结束或出错（含硬中断之后）时调 `entry.revoke('dead')`，host 随即作废令牌、关掉用它开的连接；`resolveThread` 驱逐死线程时也 `close()` 它。Codex 没有同类路径：线程每轮结束就 release（`close()` 即作废），轮间不留进程；剩下的情况由驱逐时的 `close()` 收掉。测试：`session-token-lifecycle.test.ts` 用真 `ClaudeAgentBackend`（只换 SDK 消息流）、真 entries 和真令牌表，没有在跑的一轮时进程正常结束、出错两种，已开的连接收到 4401、旧令牌再握手也被 4401 关；`message-queue-races.test.ts` 断言驱逐时关了旧线程。
- **230-2（显式凭据的 `connectLocal`，发现子进程仍读主人凭据）→ 接受。** `runStatus` 在 `VONVON_STATUS_FROM_FILES=1`（只有 `connectLocal` 的发现子进程这样跑）时只读 pid 锁，不验 owner、不读 `local-credential`。主人的两个调用方（CLI 的 `connectLocalDaemon`、`host/client.ts` 的 `readHostEndpoint`）连之前自己验过 owner，不受影响。测试：`cli-bot-session.test.ts` 用真打包的 CLI 做发现，`local-credential` 设成 0000，`connectLocal({ credential: 群令牌 })` 拿到 `bot-session:group`。
- **230-3（评论会话 `schedule add` 被本地群解析截住，报 bad-args）→ 接受。** 会话里（serverInfo 的 principal 是 `bot-session:*`）快照是裁过的，本地解析不出的 `oc_` 群 id 原样发给 daemon，由 daemon 说为什么不行：评论、私聊给 `not-group`（exit 4），群会话点别的群给超范围。测试：CLI 上评论令牌 `schedule add … --group oc_y` exit 4 `not-group`。
- **228-4 / 229-5（计划文件末尾多一个空行）→ 接受。** 已删，`git diff --check` 干净。

## 合入集成分支（带 I3）

2026-11-02 把 `claude/devices-integration`（新合入 I3a #632、I3b #633 的升级引擎）merge 进本分支。五处冲突，两边的行为都保留：

- **`D/server/ws.ts`**：取本片的版本。I3 在这里只把排空白名单换成 `DRAIN_KINDS`，本片已经用同一个常量；令牌认证、维护子集、协议不同的处理都在，排空时 `coreUpdateStatus` 照样回复。
- **`D/cli/commands/service.ts`**：import 取 I3 的 `userManagerProblem`（替换 `userManagerHint`），留着本片的 `inBotSession`：会话里 `service status` 只看锁。
- **`D/cli/daemon-client.ts`**：取本片的会话路径：没令牌就在连接前拒，会话不读 `local-credential`，协议也照旧检查。`cliEntry` 的默认值换成 I3 的 `selfEntry()`。
- **`D/cli/index.ts`**：取本片的 `LOCAL_ONLY`、`commandPath` 和 `--scope`。I3 往 `LEASED` 加的 `'vonvon update'` 改成 `'update'`，因为本片的 `commandPath` 不带 `vonvon` 前缀。I3 那行"会话里 update 不拿租约"删了：会话里的 `update` 在 preAction 就被 `LOCAL_ONLY` 拒（exit 4 `not_in_session`）。`runUpdateCommand` 自己的拒绝（I3-SEC-3）留着，算第二道。
- **`D/host/restart.ts`**：取 I3 的重写（`deps.start`、按版本判成功、回滚）。`realDeps.start` 的 spawn 换成 `withoutSessionMarkers(process.env)`，D4A-R3 的处理照旧：助手起的 `daemon start`，回滚时再起的那次也一样，都不带会话标记。

没冲突、但两边的语义要对上的：

- `D/server/http.ts` 的 `control()` 自动合并后，`coreUpdateStatus` 的分支有两段（两边各加了一段），后面那段删了。
- `machine.checkCoreUpdate`、`applyCoreUpdate`、`coreUpdateStatus` 原来就在 `authz.ts` 的表里，会话一律拒，维护子集照 `MAINTENANCE_KINDS`。I3 没有加新的 RPC 名，`parity-allowlist` 里 I3 的三条 pending 由 I3 删了，`cli-parity` 照旧通过。

另起提交补的：

- 会话里 `vonvon update`、`update --check`、`update --allow-downgrade --to <v>` 都 exit 4 `not_in_session`（`cli-bot-session.test.ts`）。断言"`LOCAL_ONLY` 里不在命令树上的只剩 `remote …`"：`update` 已经有了。
- 安装脚本的两个隐藏命令 `__standalone-setup`、`__standalone-teardown`（I2）加进 `LOCAL_ONLY`。前一个会把 `current` 切到本机留着的某个版本，等于换个名字做升级或降级，设计 8.3 里"内部命令会话里一律 exit 4"也包括它们。只有 `install.sh`、`uninstall.sh` 会调这两个命令，host 不会起。
- `D/host/service-action.ts`：桌面端开关登录时启动，host 会起 `service install|uninstall` 助手，这个助手也去掉会话标记。不去掉的话，在会话里起的 host（旧 daemon）起出来的助手会被 `LOCAL_ONLY` 拒。`machine-service-action.test.ts` 补了断言。
- `standalone-restart.test.ts` 补一条：带着会话标记的重启助手，用真的 `start` 起 `daemon start`，子进程的环境里没有 `VONVON_SESSION`、`FEISHU_CODEX_BRIDGE`。
