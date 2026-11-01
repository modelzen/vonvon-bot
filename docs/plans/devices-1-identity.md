# D1 `devices-1-identity`：设备身份、客户端授权存储、协议 v2 和 `pair/clients/device` 命令

总设计见 `docs/plans/devices.md`（下文简称"设计"），本片对应设计第 13 节的 D1 行。**本片的 4.0 节是 D1–D4b 五片共用的契约**，D2、D3、D4a、D4b 的计划只引用这里，不再各写一份。实现时先照 4.0 落 protocol，再做其余。

缩写：`P/` = `packages/protocol/src/`，`CL/` = `packages/client/src/`，`D/` = `packages/daemon/src/`，`DT/` = `packages/desktop/src/`，`U/` = `packages/ui/src/`。行号以集成分支 `claude/devices-integration` 合入 C1（PR #617）后的代码为准，写"约"的实现时再核。

## 1. 做什么

用户能看到的：`vonvon pair --json` 在本机出一条 `vonvon://pair#…` 连接链接（还没有人能用它连，D2、D3 之后才能）；`vonvon clients ls|rename|revoke`、`vonvon device rename` 能用；`vonvon daemon status --json` 多了 `startedAt`；0.9 的 CLI 能停掉 0.8 的 daemon；只读、读写档的会话读 `device.json`、`clients.json`、`remote.json` 被拒。看不到但后面每片都踩在上面的：`device.json`、`clients.json`、协议 v2（`PROTOCOL_VERSION = 2`、serverInfo v1/v2 两形状、`admin.negotiate`、`device.*`）、权限表骨架、`local-credential` 每次启动轮换、桌面端外壳形状从协议里搬走后删掉 11 个死 kind。

依赖：C1 `cli-1-conventions`（PR #617，已合入集成分支）。被依赖：D2、D3、D4a、U1a、U2、U4。

## 2. 范围

做：设计 4.1、4.3（除配对握手本身）、4.5、8.4 第一条、5.2 的表骨架、12 节 protocol/文件/终端三行里属于 D1 的，和下面 4.0 的全部契约。

不做，留给谁：
- 远程监听、`remote.json` 的写入、地址分类、限流、`device.status/enable/disable/setPort` 的实现 → D3（本片这四个 RPC 回 `unsupported`，CLI 的 `remote *` 不在本片）。
- Noise 通道、`unpaired` 状态、`pairRequest` 帧、`client-paired` 事件的真实触发 → D2（本片只提供 `completePairing()` 和事件形状，测试直接调函数）。
- 会话令牌、`--scope`、权限表的 bot-session 列、维护子集的**执行**、`filterSnapshot` → D4a；★ 行 → D4b。
- 桌面端的 `device-registry`、多连接、设备页 → U1a/U1b；`daemon-manager.ts:70-72`、`daemon-dependencies.ts:79-82` 的硬检查放宽 → U2（本片不碰桌面端的 daemon 管理，只碰 `ipc-contract.ts` 和 `bridge.ts` 的形状来源）。
- `distribution.kind` 加 `standalone` → I1（集成分支上可能已经有，不要重复加）。
- `registerAgent` 的 `jobRunning`、60 秒宽限 → U3。

## 3. 现在的代码

- `P/handshake.ts:7-16`：`PROTOCOL_VERSION = 1`；`helloSchema`、`serverInfoSchema` 都 `.strict()`，serverInfo 只有 `machineId, version, protocolVersion`。
- `P/rpc.ts`：`requestSchema` 按 `method` 判别（`snapshot/command/settings/collaboration/environment/machine/admin/directory/library/memory/contextPreview/schedule`），`responseSchema` 一个 method 一个常量（TS7056 的注释说明了为什么拆）；`errorEnvelopeSchema { type:'error', id, code, message }`。
- `P/admin.ts`：`adminRequestSchema` 的 type 有 `judgeUsage, state, diagnosis, hostDoctor, setupStatus, cardCallbackStatus, confirmCardCallback, daemonStatus, codexSetup, logs, followLogs, switchBackend, secrets, setSecret, removeSecret, testSecret`；`daemonStatusSchema` 没有 `startedAt`；`adminReplySchema` 有 `refused { code, message }`。
- `P/events.ts`：`eventSchema` strict，`event` 只有 `snapshot / log / backendInstall`。
- `P/rpc-kinds.ts`：`rpcKinds()`（152 个 kind），NESTED 展开 `settings.read/save`、`settings.act`、`machine.mcp/service/bridgeImport`、`schedule`。
- 死 kind（协议里声明、daemon 回 `unsupported`）：`command.openEventSettings/openJobAuthorization/copyJobAuthorization`、`collaboration.openGroup`、`settings.chooseExecutable/saveExecutable`、`environment.openVerification`、`machine.repairCli/checkDesktopUpdate/openReleases/installDesktopUpdate`。daemon 侧分支在 `D/server/rpc/settings.ts:12`、`D/server/rpc/collaboration.ts:70` 一带；UI 在 `U/.../ConversationPanel.tsx:89` 用类型排除；桌面端 `DT/bridge.ts:236-330` 的 `machine` 通道用 `machineRequestSchema` 解析后对 `repairCli/service/startHost/checkDesktopUpdate/installDesktopUpdate` 抛 "Shell-owned machine action"，`startHost`、`service` 两个通道也用 `machineRequestSchema` 解析；`DT/facade.ts:233-245`；`desktop/test/bridge.test.ts:258` 期望 `machine {type:'repairCli'}` 回 `ok:false`。
- `D/server/ws.ts`：`createSocketServer({ server, credential, info, request, control?, detached })`，`Peer extends JobPeer { clientKind?, send }`；hello 只核对 `helloSchema` 和凭据（不比较 `protocolVersion` 的值），成功后 `send(options.info)`；排空白名单写死 `admin.daemonStatus` + `machine.stopHost`；`maxPayload: 4_000_000`；5 秒未认证关 4401。
- `D/server/http.ts`：`startApi(options)` 用 `readLocalIdentity(paths.appDir)` 拿 `{ credential, machineId }`，`info: { type:'serverInfo', machineId, version: bridgeVersion(), protocolVersion: PROTOCOL_VERSION }`；`dispatch(peer, request)`（约 159-183）按 method 分发；`control()` 处理排空；`beginDrain / release / close`。
- `D/server/local-credential.ts`：`persistentValue(file, create)`（`wx`、0600）；`readLocalIdentity(home)` 的凭据生成一次永不轮换。
- `D/server/owner-verification.ts`：`exchangeWithOwner` 发 hello 后要求 `info.protocolVersion === PROTOCOL_VERSION`，`daemonStatus` 回复用 `replyEnvelopeSchema` 严格解析再比 pid。
- `D/server/errors.ts`：`RpcError(code, message)`、`unsupported()`、`getRpcErrorCode`。
- `D/config/read-scope.ts:6`：`ROOT_SECRETS = ['secrets.enc','master.key','.keystore.salt','local-credential','config.json']`；只有 Claude 一侧用它（`D/bot/handle-message.ts:235`、`D/agent/claude-agent/read-scope.ts`）；Codex 一侧的只读/读写档靠原生沙箱的路径排除（`D/agent/codex-appserver/workspace-policy.ts:161` "eight path exclusions"），实现时核对这八条是否整目录排除了数据根；是就不用改，不是就把三个文件加进去。
- `D/admin/service.ts:1063-1066`：`getDaemonStatus` 已有 `deps.daemonStartedAt`，只是没放进回复。
- `CL/transport-browser.ts`、`CL/transport-local.ts`：`connectBrowser({ url, credential, clientKind })` 严格解析 serverInfo 并要求版本相等后**丢掉**它；`connectLocal({ home, cliEntry })` 起 `daemon status --json`、读 `local-credential`。调用方：`D/cli/daemon-client.ts:40`、`D/host/client.ts:90,110`、`DT/attach.ts:74`、`U/main.tsx:64`；测试 `client/test/client.test.ts`、`browser-lifecycle.test.ts`、`desktop/test/attach.test.ts:20`（mock `connectBrowser`）、`ui/test/connection.test.ts`。
- `D/cli/index.ts`（C1 版）：`covers(command, ...kinds)`、`commandList()`、preAction 的租约例外表；`D/cli/command-error.ts`：`CommandError`、`rpcErrorKind(code)` 已把 `permission_denied, scope_required, session_token_missing, not_in_session, not-dm, desktop_not_running, client_revoked, pairing_failed, rate_limited, unauthorized, forbidden` 映到 4，`protocol_mismatch, device_identity_changed` 映到 3，`conflict` 5，`outcome_unknown` 6，`invalid_request` 2。
- `D/cli/parity-allowlist.ts`：`dead('D1')` 十一条；`device.pair/clients/renameClient/revokeClient/rename` 和 `device.status/enable/disable` 都是 `pending` 且 `arrives: 'D1'`；`admin.negotiate` internal、`arrives: 'D1'`。`test/cli-parity.test.ts` 据 `arrives` 容忍协议里还没有的 kind。
- 测试夹具：`packages/daemon/test/server-fixture.ts` 的 `startFixture()` 返回 `{ api, home, credential, control, close }`，`socketClient(port, credential?, version = 1)`；`server-handshake.test.ts`、`owner-verification.test.ts`（假 `createSocketServer`，有 `'wrong-version'` 模式）、`read-scope.test.ts`（断言拒绝名单的精确内容）、`api-listen-lifecycle.test.ts`、`cli-json.test.ts`（43 个 SAMPLES）。

## 4. 怎么改

### 4.0 五片共用的契约（D2、D3、D4a、D4b 只引用，不改）

**协议常量和主体。**

| 名字 | 定义 | 谁实现 |
|---|---|---|
| `PROTOCOL_VERSION` | `2`（`P/handshake.ts`） | D1 |
| `helloSchema` | **不变**：`{ type:'hello', protocolVersion:int, clientKind:'desktop'\|'web'\|'cli', credential?:string }`，仍 strict | — |
| `serverInfoV1Schema` | strict `{ type:'serverInfo', machineId, version, protocolVersion }`；**服务端对 `hello.protocolVersion === 1` 的 peer 回这个形状，且 `protocolVersion` 回 `1`**（见 4.3 偏差 1） | D1 |
| `serverInfoV2Schema` | strict，v1 四个字段 + `deviceName:string`、`platform:'macos'\|'linux'\|'windows'\|'unsupported'`、`capabilities:string[]`、`principal:principalWireSchema`；`protocolVersion` 回 daemon 自己的 `2` | D1 |
| `serverInfoSchema` | **客户端用的宽松解析**：`z.object({ type:z.literal('serverInfo'), machineId:string, version:string, protocolVersion:int, deviceName?:string, platform?:string, capabilities?:string[], principal?:string }).passthrough()`。客户端一律用它，不比较版本相等；`protocolVersion !== PROTOCOL_VERSION` 由上层决定（维护子集或"太旧"文案） | D1 |
| `principalWireSchema` | `z.enum(['owner:local','owner:paired','bot-session:dm','bot-session:group','bot-session:comment','maintenance'])`（客户端按开放字符串读）。`unpaired` 不出现在 serverInfo 里（它拿不到 serverInfo） | D1 定，D2/D4a 填值 |
| `MAINTENANCE_KINDS` | `['admin.daemonStatus','machine.checkCoreUpdate','machine.applyCoreUpdate','machine.coreUpdateStatus','command.restartHost','machine.stopHost'] as const`：协议不同的连接只放这些（`stopHost` 是设计 4.5 列表之外加的：0.8 的桌面端和 CLI 停 0.9 的 daemon 靠它，见第 9 节） | D1 定常量，D4a 执行 |
| `DRAIN_KINDS` | `['admin.daemonStatus','machine.stopHost','machine.coreUpdateStatus'] as const`：排空期间只放这些 | D1 定常量，D4a 把 `ws.ts` 写死的两条换成它 |
| `admin.negotiate` | 请求 `{ type:'negotiate', capabilities: z.array(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/)).max(32), scope?: scopeSchema }`；回复 `{ kind:'negotiated', principal: principalWire, scope: Scope \| null }`。一条连接只认第一次，第二次回 `invalid_request`。daemon 记进 `peer.capabilities`、`peer.scope` | D1 请求/回复和记录，D4a 范围核对 |
| `daemonStatusSchema` | 加 `startedAt: z.number().int()`（epoch ms，`deps.daemonStartedAt`）。**对 `protocolVersion === 1` 的 peer，`dispatch` 把 `startedAt` 删掉再回**（0.8 客户端严格解析） | D1 |
| 能力名 | daemon 在 serverInfo v2 的 `capabilities` 里报：`'device'`（本片起恒有）、`'remote'`（D3，开了远程监听才报）、`'session-scope'`（D4a）、`update.*`（I3）。客户端在 `negotiate` 里报：`'desktop.selfUpdate'`（U4）。本片只定义命名空间规则：小写、点分，不按版本号猜功能 | D1 |

**`P/device.ts`**（新文件，全部 strict）。

```ts
export const addressKindSchema = z.enum(['loopback','tailscale','lan','cgnat','public']);
export const scopeSchema = z.object({ bot: z.string().min(1), group: z.string().min(1).optional() }).strict();
export const pairingLinkSchema = z.object({
  v: z.literal(1),
  device: z.object({ id: z.string(), name: z.string(), pk: z.string() /* X25519 公钥 base64url 43 字符 */ }).strict(),
  addresses: z.array(z.object({ host: z.string(), port: z.number().int().min(1).max(65535), kind: addressKindSchema.exclude(['loopback']) }).strict()).min(1),
  invite: z.object({ id: z.string().regex(/^inv_[0-9a-f]{16}$/), secret: z.string() /* 32 字节 base64url */, expiresAt: z.number().int() }).strict(),
  relay: z.null(), account: z.null(),
}).strict();
export const PAIRING_LINK_PREFIX = 'vonvon://pair#';
export function encodePairingLink(link: PairingLink): string;   // prefix + base64url(JSON.stringify(link))
export function decodePairingLink(text: string): PairingLink;   // 接受带 prefix 的和只有 base64url 的；坏的抛 Error('invalid_pairing_link')
export const clientRecordSchema = z.object({
  id: z.string().regex(/^cl_[0-9a-f]{16}$/), name: z.string().min(1).max(40), publicKey: z.string(),
  clientKind: z.enum(['desktop','cli','web']), createdAt: z.number().int(), lastSeenAt: z.number().int(),
  lastAddress: z.string(), pairedVia: z.literal('invite'), invitedBy: z.string() /* 'local' | clientId */,
  revokedAt: z.number().int().optional(),
}).strict();
export const remoteAddressStateSchema = z.enum(['listening','waiting','needs-confirmation','disabled']);   // D3 填
export const deviceStatusSchema = z.object({
  device: z.object({ id: z.string(), name: z.string(), publicKey: z.string() }).strict(),
  remote: z.object({ port: z.number().int(), addresses: z.array(z.object({
    host: z.string(), kind: addressKindSchema, enabledAt: z.number().int(), state: remoteAddressStateSchema, detail: z.string().optional(),
  }).strict()) }).strict(),
  clients: z.object({ total: z.number().int(), active: z.number().int() }).strict(),
}).strict();
export const deviceRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status') }).strict(),
  z.object({ type: z.literal('enable'), host: z.string().optional(), tailscale: z.boolean().optional(), allowPublic: z.boolean().optional() }).strict(),  // host 和 tailscale 恰好一个
  z.object({ type: z.literal('disable'), host: z.string() }).strict(),
  z.object({ type: z.literal('setPort'), port: z.number().int().min(1024).max(65535) }).strict(),
  z.object({ type: z.literal('pair'), ttlMs: z.number().int().min(60_000).max(600_000).optional() }).strict(),
  z.object({ type: z.literal('clients') }).strict(),
  z.object({ type: z.literal('renameClient'), clientId: z.string(), name: z.string().min(1).max(40) }).strict(),
  z.object({ type: z.literal('revokeClient'), clientId: z.string(), cascade: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('rename'), name: z.string().min(1).max(40) }).strict(),
]);
export const deviceReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('deviceStatus'), status: deviceStatusSchema }).strict(),
  z.object({ kind: z.literal('pairingLink'), link: z.string(), inviteId: z.string(), expiresAt: z.number().int() }).strict(),
  z.object({ kind: z.literal('clients'), generation: z.number().int(), clients: z.array(clientRecordSchema) }).strict(),
  z.object({ kind: z.literal('revoked'), revoked: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal('device'), device: z.object({ id: z.string(), name: z.string(), publicKey: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal('refused'), code: z.string(), message: z.string() }).strict(),
]);
export const CLOSE_CODES = {
  protocol_mismatch: 4001, unknown_client: 4002, client_revoked: 4003, rate_limited: 4004,
  handshake_failed: 4005, remote_disabled: 4006, pairing_failed: 4007,
  server_shutdown: 1001, policy_violation: 1008, unauthorized: 4401,
} as const;
export const closeReasonSchema = z.enum(Object.keys(CLOSE_CODES));   // 服务端 close(code, reason) 的 reason 就是这个键名
export const deviceEventSchema = z.object({
  event: z.literal('device'), change: z.enum(['client-paired','client-revoked']),
  clientId: z.string(), name: z.string(), clientKind: z.string(), address: z.string().optional(), invitedBy: z.string().optional(),
}).strict();
```

`P/rpc.ts` 的 `requestSchema`/`responseSchema` 加 `method:'device'`；`P/events.ts` 的 `eventSchema` 加 `deviceEventSchema`；`P/index.ts` 导出。

**RPC 错误码**（`RpcError.code`，CLI 退出码按 C1 的 `rpcErrorKind`）：本片新增 `pairing_limit`（未用邀请满 3 个）、`no_remote_address`（没开远程地址）→ 都映 4；D4a 新增 `session_token_invalid` → 4。其余沿用 C1 已登记的。`refused` 回复里的 `code` 用同一套名字。

**文件格式**（`device.json`、`clients.json`、`remote.json` 在 `<dataRoot>/devices/` 里，目录 0700、文件 0600，读拒绝按整个目录，路径用 `D/remote/files.ts` 的 `devicesPath(home, 文件名)`；`local-credential` 在根，0600，在 `ROOT_SECRETS`）。三个文件读的时候：`v` 大于 1 报"较新版本写的"、不当损坏；同一个 `v` 里不认识的字段保留、写回时原样带上，RPC 回复只带认识的字段：

| 文件 | 形状 | 写入者 |
|---|---|---|
| `device.json` | `{ v:1, deviceId, name, keypair:{ publicKey, secretKey } }`，两把钥匙都是 32 字节 base64url（JWK 的 `x`/`d`）；`deviceId` = `machine-id` 的 UUID | D1 `D/remote/device.ts`，首次启动生成，`rename` 改名；坏文件**报错退出**不重建（客户端钉了公钥） |
| `clients.json` | `{ v:1, generation:int, clients: ClientRecord[] }`；每次写 `generation + 1`；撤销写 `revokedAt`（墓碑，条目不删） | D1 `D/remote/clients.ts`；daemon 在跑时只有 daemon 写，没跑时 CLI 拿着 host 互斥锁写（`D/cli/commands/device.ts` 的 `either()`） |
| `remote.json` | `{ v:1, port:int, addresses:[{ host, enabledAt, kind, iface?, network? }] }`；缺文件等于 `{ v:1, port:7767, addresses:[] }` | D1 只读（`D/remote/config.ts` 的 `readRemoteConfig`，`pair` 要看有没有地址）；D3 写 |
| `local-credential` | 64 hex，**每次 daemon 启动重写** | D1 `createLocalIdentity` |

**daemon 内部的主体类型**（`D/server/principal.ts`，D1 新建；D2、D4a 加值不改形状）：

```ts
export type Principal =
  | { kind: 'owner'; via: 'local' }
  | { kind: 'owner'; via: 'paired'; clientId: string; generation: number }           // D2 填
  | { kind: 'bot-session'; sessionId: string; appId: string; place: 'dm'|'group'|'comment'; chatId?: string }   // D4a 填
  | { kind: 'maintenance'; protocolVersion: number; inner: 'owner:local' | 'owner:paired' }   // 协议不同
  | { kind: 'unpaired' };                                                             // D2 填
export function principalWire(p: Principal): PrincipalWire;   // maintenance → 'maintenance'，其余按上表
```

`Peer`（`D/server/ws.ts`）加只读字段：`principal: Principal`、`protocolVersion: number`（hello 里的）、`capabilities: readonly string[]`、`scope: Scope | null`、`negotiated: boolean`、`address: string`（远端 `ip[:port]`，loopback 时 `127.0.0.1:<port>`）。D2 的 `createSecureSocketServer` 和 D1 的 `createSocketServer` 都产出同一个 `Peer`，放进同一个 `PeerHub`（D2 抽出；D1 先不抽，只保证 `Peer` 的字段齐）。

**权限表**（`D/server/authz.ts`）：`Map<string, Rule>`，键是 `rpcKinds()` 的 `method.type`（含 NESTED 展开的 `settings.act.voice` 这类）。

```ts
export type BotSessionRule = 'deny' | 'host' | 'bot';   // host = D4a 在 host 判；bot = ★ 问 Bot 进程（D4b）
export interface Rule { owner: 'allow'; botSession: BotSessionRule; maintenance: boolean /* 在 MAINTENANCE_KINDS 里 */ }
export type Decision = { ok: true } | { ok: false; code: 'permission_denied' | 'protocol_mismatch' | 'scope_required' | 'not-dm' | 'not_in_session'; message: string };
export function authorize(peer: Pick<Peer,'principal'|'protocolVersion'|'negotiated'|'scope'>, request: Request, deps: AuthzDeps): Promise<Decision>;
```

D1 填表：所有 kind `owner:'allow'`；`botSession` 一列**全部 `'deny'`**，D4a 按设计 5.2 改成 `host`/`bot`；`maintenance` 按 `MAINTENANCE_KINDS`。D1 的 `authorize` 只做：`owner` → 放；`maintenance`/`bot-session`/`unpaired` → `permission_denied`（D4a 换成真正的判法）；表里没有 → `permission_denied`。**新加 RPC 必须登记**，测试"每个 `rpcKinds()` 的 kind 都在表里、表里的都在 `rpcKinds()` 里"从本片起长期有效。

**CLI 命令和 `covers`**（五片合计；本片只做前五条）：

| 命令 | covers | 片 | daemon 没跑时 |
|---|---|---|---|
| `vonvon pair [--ttl <分钟>] [--json]` | `device.pair` | D1 | exit 3，文字见设计第 15 节"daemon 没跑时 `pair`" |
| `vonvon clients ls [--json]` | `device.clients` | D1 | host 锁下读文件，`source:'files'` |
| `vonvon clients rename <clientId> <name>` | `device.renameClient` | D1 | host 锁下写文件 |
| `vonvon clients revoke <clientId> [--cascade]` | `device.revokeClient` | D1 | host 锁下写文件（没有连接要断） |
| `vonvon device rename <name>` | `device.rename` | D1 | host 锁下写 `device.json` |
| `vonvon remote status [--json]` | `device.status` | D3 | host 锁下读 `remote.json`，`source:'files'`，各地址 `state:'disabled'`（daemon 不在） |
| `vonvon remote enable <ip>\|--tailscale [--allow-public]` | `device.enable` | D3 | host 锁下写 `remote.json`（用 D1 的 `either()`） |
| `vonvon remote disable <ip>` | `device.disable` | D3 | 同上 |
| `vonvon remote port <n>` | `device.setPort` | D3 | 同上 |
| 全局 `--scope bot=<appId>[,group=<chatId>]` | （不是命令；经 `admin.negotiate`） | D4a | — |

`admin.negotiate` 在白名单里标 `internal`（CLI 的 `withDaemon` 自己发，不是子命令）。

**IPC（host ↔ bot 子进程）**：D4a 新增 bot→host 的请求/响应对 `fcb.host.req` / `fcb.host.res`（泛型 caller/responder，和今天 `fcb.admin.req/res` 对称），op：`issueSessionToken`、`revokeSessionToken`；D4b 在 host→bot 的 `AdminIpcOp` 加 `authorizeSessionCall`。形状写在 D4a/D4b 的计划里，这里只定通道名。

**设备事件和日志**：`eventSchema` 的 `device` 事件只推给 `owner` 主体的 peer（D4a 的过滤器之前，D1 先无条件推给所有已认证 peer，D4a 收口）；同时 `log.info('device', 'client-paired' | 'client-revoked', { clientId, name, clientKind, address, invitedBy })` 进诊断（设计 12 节诊断事件表的前两条；`handshake-rejected`、`rate-limited`、`pairing-refused` 在 D2/D3）。**配对链接、邀请 secret 不进任何日志**。

### 4.1 `P/`：协议

1. `P/handshake.ts`：按 4.0 改 `PROTOCOL_VERSION`、加 `serverInfoV1Schema`、`serverInfoV2Schema`、把 `serverInfoSchema` 改成宽松版、加 `principalWireSchema`、`MAINTENANCE_KINDS`、`DRAIN_KINDS`，类型 `ServerInfo = z.infer<typeof serverInfoSchema>`、`ServerInfoV2`。
2. `P/admin.ts`：`adminRequestSchema` 加 `negotiate`；`adminReplySchema` 加 `negotiated`；`daemonStatusSchema` 加 `startedAt`。
3. `P/device.ts` 新建（4.0 原文）；`P/rpc.ts` 加 `device`；`P/events.ts` 加 `device` 事件；`P/rpc-kinds.ts` 不用改（`device` 的 type 是平的）。
4. **删死 kind**（设计 8.4）：先做 4.4 的桌面端形状搬家，再从 `P/domain.ts`、`P/settings.ts`、`P/collaboration.ts`、`P/environment.ts`、`P/machine.ts` 删 `command.openEventSettings/openJobAuthorization/copyJobAuthorization`、`collaboration.openGroup`、`settings.chooseExecutable/saveExecutable`、`environment.openVerification`、`machine.repairCli/checkDesktopUpdate/openReleases/installDesktopUpdate`（请求和对应回复）；daemon 的 `rpc/settings.ts:12`、`rpc/collaboration.ts:70` 等 `unsupported()` 分支随之删；`U/.../ConversationPanel.tsx:89` 的类型排除删；白名单的 `dead('D1')` 十一条删。**保留** `machine.startHost`、`machine.service start|stop`（白名单 desktop-only 不动）。`rpcKinds()` 的数量从 152 变成 152 − 11 + 10（`device` 9 个 + `admin.negotiate`）= 151，测试里的具体数字跟着改。

### 4.2 `D/remote/`：身份、授权存储、邀请、远程配置只读

- `D/remote/device.ts`：`loadOrCreateDevice(home, machineId): Promise<DeviceIdentity>`——文件在就 `deviceIdentitySchema.parse`（坏了抛 `Error('device.json 损坏：…')`，daemon 启动失败并在日志里说明，不重建）；不在就 `generateKeyPairSync('x25519')`，`export({ format:'jwk' })` 取 `x`、`d`，名字 `os.hostname()` 截 40 字符，用和 `persistentValue` 同样的 `wx` + 0600 写；写失败 `EEXIST`（两个进程同时首次启动）就重读。`renameDevice(home, name)`：读 → 改 `name` → `writeFile(tmp, 0600)` + `rename`。`deviceKeyPair(identity): { publicKey: Buffer; privateKey: KeyObject }` 给 D2 用（`createPrivateKey({ key: { kty:'OKP', crv:'X25519', x, d }, format:'jwk' })`）。
- `D/remote/clients.ts`：`createClientRegistry(home): Promise<ClientRegistry>`，接口：`generation`、`list()`、`get(clientId)`、`byPublicKey(publicKey)`（**含墓碑**，D2 据 `revokedAt` 回 4003 还是 4002）、`add({ name, publicKey, clientKind, address, invitedBy })`（同一公钥已存在且未撤销 → 更新 `lastSeenAt/lastAddress` 返回原条目；已撤销 → 抛 `RpcError('client_revoked')`）、`rename(clientId, name)`、`revoke(clientId, { cascade })` 返回被撤销的 id 列表（`cascade` 沿 `invitedBy` 递归，已撤销的跳过）、`touch(clientId, address)`（只改内存，`save()` 节流到每分钟最多一次落盘，`close()` 时 flush）、`onChange(listener(generation, revokedIds))`（D3 的断连靠它）。每次 `save()`：`generation + 1`、`writeFile(tmp, { mode:0o600 })` + `rename`。文件缺 → `{ v:1, generation:0, clients:[] }`；坏 → 抛。`clientId` = `'cl_' + randomBytes(8).toString('hex')`。
- `D/remote/pairing.ts`：`createInviteBook({ now = Date.now }): InviteBook`——`create({ ttlMs = 600_000, invitedBy }): Invite { id:'inv_'+16hex, secret: base64url(randomBytes(32)), expiresAt, invitedBy }`，未用且未过期的满 3 个 → `throw new RpcError('pairing_limit', '已经有 3 条没用过的连接链接了，先用掉或等它们过期（10 分钟）。')`；`redeem(id, secret): Invite | undefined`——先 `prune()`，按 id 找，`timingSafeEqual` 比 secret（长度不同先补齐再比、结果强制 false），成功即删；`has(id)`（D3 限流用：带有效 `inviteId` 的握手不计未知公钥）；`size()`。`completePairing(deps: { invites, clients, device, publish, log }, input: { publicKey, request: PairRequest, address }): Promise<{ clientId, deviceName }>`——`redeem` 失败抛 `PairingError('pairing_failed')`；成功 `clients.add(...)`、`publish({ event:'device', change:'client-paired', … })`、`log.info('device','client-paired',…)`。`PairRequest` 的 zod（`{ type:'pairRequest', inviteId, inviteSecret, clientName: 1..40, clientKind }`）和 `PairResult` 也放在 `P/device.ts`，D2 在通道里用。
- `D/remote/config.ts`：`remoteConfigSchema`（4.0 的形状）、`readRemoteConfig(home): Promise<RemoteConfig>`（缺文件给默认值；坏文件抛）。写入函数 D3 加。
- `D/config/read-scope.ts`：拒绝名单加 `<dataRoot>/devices` 整个目录（审查后从三个文件名改成目录，见文末）；`test/read-scope.test.ts` 的精确名单跟着改。

### 4.3 `D/server/`：凭据轮换、v1/v2 握手、权限表骨架、`device` RPC

1. `local-credential.ts`：`readLocalIdentity(home)` 改名 `createLocalIdentity(home): Promise<{ credential, machineId }>`——`machine-id` 照旧 `persistentValue`；`local-credential` **每次**调用都 `randomBytes(32).toString('hex')`，`writeFile(tmp, { mode:0o600 })` + `rename`（不用 `wx`）。保留 `readMachineId(home)` 给 `loadOrCreateDevice`。`http.ts` 改调它。注意顺序：先 `createLocalIdentity`，再 `listen`，再写 pid 锁（今天的顺序是这样就不动），这样客户端读到新凭据时端口已在。
2. `ws.ts` 的 hello 分支：核对凭据后，`protocolVersion = hello.data.protocolVersion`；`principal = protocolVersion === PROTOCOL_VERSION ? { kind:'owner', via:'local' } : { kind:'maintenance', protocolVersion, inner:'owner:local' }`；`options.info` 从常量改成 `info(peer): ServerInfo`——`http.ts` 里实现：`peer.protocolVersion === 1` → `serverInfoV1Schema.parse({ …, protocolVersion: 1 })`；否则 `serverInfoV2Schema.parse({ type, machineId, version, protocolVersion: PROTOCOL_VERSION, deviceName: device.name, platform, capabilities: capabilities(), principal: principalWire(peer.principal) })`。`platform` 从 `snapshot.ts` 的同一个判定来（加 `'windows'`，I4a 前 Windows 仍可能是 `unsupported`，不在本片管）。`peer.address` 取 `req.socket.remoteAddress`/`remotePort`。
   - **偏差 1**：设计 4.5 说 v1 peer 回"今天的三个字段"，没说 `protocolVersion` 填几。这里填 `1`（hello 里的值），原因：0.8 的 `owner-verification.ts:44-46` 要求等于它自己的 `PROTOCOL_VERSION`（1），不这样 0.8 桌面端停不掉 0.9 的 daemon，违背 4.5 "旧的也能停新的"。v2 peer 填 daemon 自己的 2。
   - **偏差 2**（同一原因）：`dispatch` 对 `protocolVersion === 1` 的 peer 的 `admin.daemonStatus` 回复删掉 `startedAt`——0.8 的 `replyEnvelopeSchema` 是 strict 的。只做这一个字段；`distribution.kind` 的新值归 I1/U2。
3. `ws.ts` 加 `admin.negotiate` 处理（在 `dispatch` 之前、`authorize` 之后，`http.ts` 里）：已 `negotiated` → `RpcError('invalid_request','negotiate 只能发一次。')`；否则记 `capabilities`、`scope`（本片不核对范围，原样记），回 `negotiated`。`device` 事件：`publish` 给所有 `open` 的 peer（D4a 收口到 owner）。
4. `authz.ts`（4.0）。`http.ts` 的 `dispatch` 开头：`const decision = await authorize(peer, request, deps); if (!decision.ok) throw new RpcError(decision.code, decision.message);`。`getRpcErrorCode` 认 `RpcError.code` 原样透传，已经如此。
5. `D/server/rpc/device.ts`：`deviceRpc(deps, peer, payload)`——`pair`：`readRemoteConfig` 没有地址 → `RpcError('no_remote_address', <设计 15 节"没开远程时 pair"原文>)`；有 → `invites.create({ ttlMs, invitedBy: peer.principal.kind==='owner' && peer.principal.via==='paired' ? peer.principal.clientId : 'local' })`，`encodePairingLink({ v:1, device:{ id, name, pk }, addresses: config.addresses.map(a => ({ host, port: config.port, kind })), invite, relay:null, account:null })`，回 `pairingLink`。`clients` → `{ kind:'clients', generation, clients: list() }`；`renameClient` → 改后回 `clients`；`revokeClient` → `revoke` 后回 `revoked`（断连在 D3 的 `onChange` 里）；`rename` → `holdDevice` 的 `rename`（一次一个，见"审查后改了什么"最后一条）后回 `device`，同时更新 serverInfo 用的 `device.name`。`status/enable/disable/setPort` → `unsupported()`（D3 实现）。
6. `http.ts` 的 `startApi`：启动时 `await createLocalIdentity`、`loadOrCreateDevice(appDir, machineId)`、`createClientRegistry(appDir)`、`createInviteBook()`，装进 `deps`；`close()`/`release()` 时 `await clients.close()`（flush `lastSeenAt`）。`capabilities()`：`['device']`（D3 加 `'remote'`，D4a 加 `'session-scope'`）。`platform` 用 `snapshot.ts` 的判定。`daemonStatus` 回复加 `startedAt: deps.daemonStartedAt`。
7. `owner-verification.ts`：`serverInfoSchema`（宽松）解析，**不再比较版本**；`daemonStatus` 的回复用 `z.object({ type:z.literal('response'), id, method:z.literal('admin'), payload: z.object({ kind:z.literal('daemonStatus'), status: z.object({ running:z.boolean(), pid:z.number() }).passthrough() }).passthrough() }).passthrough()` 解析；其余不变（pid 锁核对、`stopHost`）。`test/owner-verification.test.ts` 的 `'wrong-version'` 模式改成"版本不同也能停"。

### 4.4 `CL/`、`DT/`、`U/`：`connect()` 返回 serverInfo；外壳形状搬家

1. `CL/transport-browser.ts`：`connectBrowser` 用宽松 `serverInfoSchema.parse`，不比较版本，返回 `{ client, serverInfo }`（原来返回 `client`）。`CL/transport-local.ts` 的 `connectLocal` 同样返回 `{ client, serverInfo }`；读 `local-credential` 的位置不变（D4a 加 `inBotSession()` 分支）。四个调用方跟着改：`D/cli/daemon-client.ts:40`（`withDaemon` 把 `serverInfo` 放进上下文，D4a 要用）、`D/host/client.ts:90,110`、`DT/attach.ts:74`（`AttachedDaemon` 加 `serverInfo`）、`U/main.tsx:64`；测试 `client.test.ts`、`browser-lifecycle.test.ts`、`desktop/test/attach.test.ts`、`ui/test/connection.test.ts` 的 mock 返回值改形状。`CL/index.ts`、`CL/browser.ts` 导出 `ServerInfo`。
2. `DT/ipc-contract.ts` 加 `desktopShellRequestSchema = z.discriminatedUnion('type', [ startHost, service{action:'start'|'stop'}, repairCli, checkDesktopUpdate, installDesktopUpdate ])`（只这几个，形状照抄今天 `machineRequestSchema` 里对应的）；`DT/bridge.ts:236-330` 的 `machine`、`startHost`、`service` 通道改用它解析；`machine` 通道对 `desktopShellRequestSchema` 命中的 type 照旧抛 "Shell-owned machine action"，其余交给 daemon 的 `machineRequestSchema`；`DT/facade.ts:233-245` 的类型跟着改。`desktop/test/bridge.test.ts:258` 的用例改成发 `repairCli` 走 `desktopShell` 的形状仍回 `ok:false`。**做完这步再删协议里的 `repairCli` 等**（4.1 第 4 条），顺序不能反，否则桌面端编不过。

### 4.5 `D/cli/`：`pair`、`clients`、`device`

- 新文件 `D/cli/commands/pair.ts`、`clients.ts`、`device.ts`，在 `index.ts` 注册并 `covers`（4.0 的表）。`pair`：`withDaemon` 连本机；连不上 → `CommandError('connection', <设计 15 节"daemon 没跑时 pair"原文>)`（exit 3）；`--ttl` 单位分钟，1..10，默认 10；人类输出两行（设计 15 节"`vonvon pair` 输出"原文 + 链接），`--json` 回 `{ ok:true, link, inviteId, expiresAt }`；**链接写 stdout，不管是不是 TTY**（设计 4.3 REQ-2）；`no_remote_address`、`pairing_limit` 经 `rpcErrorKind` 成 exit 4，`command-error.ts` 把这两个码加进 4 的那组。
- `clients ls`：daemon 在 → `device.clients`；不在 → host 互斥锁下 `createClientRegistry(home).list()`，输出标 `source:'files'`（C1 的回退约定）。表格列：id、名字、种类、配对时间、最近连接、`invitedBy`、`revokedAt`；最近 24 小时配对的行末标"新"。`clients rename|revoke`：同样双路；`revoke --cascade` 输出被撤销的全部 id。`device rename`：双路。租约路径用 `enterDataAccess(home)`，preAction 的例外表**不加**这三条（它们本来就要租约）。
- `parity-allowlist.ts`：删 `device.pair/clients/renameClient/revokeClient/rename` 五条（命令 `covers` 了）；`device.status/enable/disable` 改成 `pending('D3')`、加 `device.setPort` 同款，**去掉 `arrives`**（协议里已有）；`admin.negotiate` 去掉 `arrives`，保留 `internal`；删 `dead('D1')` 十一条。`test/cli-parity.test.ts` 里断言 `arrives:'D1'` 的那几条改成断言这些 kind 已被 `covers` 或在 `pending('D3')`。
- `test/cli-json.test.ts` 的 SAMPLES 加 `pair --json`（daemon 不在 → `ok:false, exitCode:3`）、`clients ls --json`、`device rename x --json`。

### 4.6 顺序

4.1 第 1-3 条 → 4.2 → 4.3 → 4.4 第 1 条 → 4.4 第 2 条 → 4.1 第 4 条（删死 kind）→ 4.5 → 测试。每一步 `typecheck` 过再走下一步；删死 kind 那步单独一个 commit，方便审查对照。

## 5. 测试

全部用 vitest，在 `packages/protocol/test`、`packages/daemon/test`、`packages/client/test`、`packages/desktop/test`。"main 必败"= 集成分支今天的代码上会失败。

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `protocol/test/device.test.ts`（新） | 配对链接往返 | `encodePairingLink(x)` 以 `vonvon://pair#` 开头；`decodePairingLink` 对带前缀和裸 base64url 都回 `x`；少 `invite` 抛 `invalid_pairing_link`；`addresses` 含 `loopback` 被拒。main 必败 |
| 同上 | `CLOSE_CODES` 和 `closeReasonSchema` 一致 | 每个键的码唯一；`closeReasonSchema.parse('client_revoked')` 过 |
| `protocol/test/handshake.test.ts`（新） | 三个 serverInfo schema | v1 strict 拒多字段；v2 strict 要求 `principal`；宽松版接受 v1、v2 和多一个未知字段。main 必败 |
| `protocol/test/rpc-kinds.test.ts`（改） | 数量 | `rpcKinds().length === 151`，含 `device.pair`、`admin.negotiate`，不含 `machine.repairCli`。main 必败 |
| `daemon/test/remote-device.test.ts`（新） | 首次生成 | 空目录 → `device.json` 存在、mode `0o600`、`deviceId === machineId`、公钥 43 字符；再调一次内容不变 |
| 同上 | 坏文件 | 写入 `{}` → `loadOrCreateDevice` 抛，文件不被覆盖 |
| 同上 | 改名 | `renameDevice(home,'A')` 后重读 `name === 'A'`，mode 仍 0600 |
| `daemon/test/remote-clients.test.ts`（新） | 代数 | 空 → `generation 0`；`add` → 1，文件 mode 0600；`rename` → 2；`revoke` → 3 且条目仍在、`revokedAt` 有值 |
| 同上 | 级联 | A（`invitedBy:'local'`）、B（`invitedBy:A`）、C（`invitedBy:B`）：`revoke(A,{cascade:true})` 回 `[A,B,C]`；`revoke(A)` 只回 `[A]` |
| 同上 | 墓碑查询 | `byPublicKey(已撤销的 pk)` 回带 `revokedAt` 的条目；`add` 同一 pk 抛 `client_revoked` |
| 同上 | 节流 | 60 次 `touch` 只写一次文件；`close()` 后 `lastSeenAt` 落盘 |
| `daemon/test/remote-pairing.test.ts`（新） | 邀请上限 | 连建 3 个过，第 4 个抛 `pairing_limit`；把 1 个 redeem 掉后第 4 个过 |
| 同上 | 过期和一次性 | 假时钟推进 10 分 1 秒 → `redeem` 回 undefined；同一邀请 redeem 两次第二次 undefined；secret 差一位 undefined |
| 同上 | `completePairing` | 有效邀请 → `clients.json` 多一条、`publish` 收到 `device/client-paired`、`log.info` 被调；无效 → `PairingError('pairing_failed')`，不写文件、不发事件 |
| `daemon/test/read-scope.test.ts`（改） | 名单 | 拒绝名单含 `<dataRoot>/devices`；**新增**：起 `startFixture()`，`clients.json` 出现前的线程拒绝名单已含 `devices/`；`devices/` 0700、里面的文件都 0600；数据根上 mode `0o600` 的文件每个都在 `ROOT_SECRETS`。main 必败 |
| `daemon/test/local-credential.test.ts`（新） | 轮换 | 连调两次 `createLocalIdentity` 凭据不同、`machineId` 相同、文件 mode 0600 |
| `daemon/test/server-handshake.test.ts`（改） | v1 hello | `socketClient(port, cred, 1)` 收到的 serverInfo 恰好三个字段且 `protocolVersion === 1`；之后 `admin.daemonStatus` 回复**没有** `startedAt`。main 必败 |
| 同上 | v2 hello | `version 2` 收到 `deviceName`、`platform`、`capabilities` 含 `'device'`、`principal 'owner:local'`、`protocolVersion 2`；`daemonStatus` 有 `startedAt`，等于夹具的 `daemonStartedAt` |
| 同上 | negotiate | 第一次回 `negotiated { principal:'owner:local', scope:null }`；第二次 `error invalid_request` |
| 同上 | 坏凭据 | 仍 4401（回归） |
| `daemon/test/authz.test.ts`（新） | 覆盖 | `rpcKinds()` 每个 kind 都在 `RULES`，`RULES` 每个键都在 `rpcKinds()`（双向）。main 必败 |
| 同上 | 判定 | owner + 任意 kind → ok；`{kind:'maintenance'}` + `command.refresh` → `permission_denied`（D4a 改成 `protocol_mismatch`）；不存在的 kind → `permission_denied` |
| `daemon/test/rpc-device.test.ts`（新） | pair 无地址 | `remote.json` 缺 → `error no_remote_address`，文字含"vonvon remote enable" |
| 同上 | pair 有地址 | 夹具写 `remote.json {port:7767, addresses:[{host:'192.168.1.9', kind:'lan', enabledAt}]}` → `pairingLink`，`decodePairingLink(link).addresses[0]` 等于它，`device.pk` 等于 `device.json` 的公钥，`invitedBy` 内部为 `'local'` |
| 同上 | clients/rename/revoke/rename | 走 RPC 后文件内容和回复一致；`device.rename` 后再 hello v2 的 `deviceName` 是新名字 |
| 同上 | status/enable/disable/setPort | 回 `unsupported` |
| `daemon/test/owner-verification.test.ts`（改） | 版本不同能停 | 假服务端回 `protocolVersion:1` 的 serverInfo + 带多余字段的 daemonStatus → `stopVerifiedOwner` 成功。main 必败 |
| `daemon/test/cli-parity.test.ts`（改） | 白名单 | 无 `arrives:'D1'`；`device.*` 五条被 `covers`；`device.status/enable/disable/setPort` 在 `pending('D3')` |
| `daemon/test/cli-json.test.ts`（改） | 三条新样本 | 合法 JSON；`pair` 在无 daemon 时 `exitCode 3` |
| `daemon/test/cli-clients.test.ts`（新） | 文件回退 | 无 daemon：`clients ls --json` 回 `source:'files'`；`clients revoke cl_x` 后文件 `revokedAt` 有值；`device rename B --json` 后 `device.json.name === 'B'` |
| `client/test/client.test.ts`、`browser-lifecycle.test.ts`（改） | 返回形状 | `connectBrowser` 回 `{ client, serverInfo }`；serverInfo `protocolVersion: 1` 时**不抛**。main 必败 |
| `desktop/test/bridge.test.ts`（改） | 外壳形状 | `startHost`、`service start` 经 `desktopShellRequestSchema` 仍到 `ShellActions`；`machine { type:'repairCli' }` 回 `ok:false` |

## 6. 自测和验收

本片在这台 Linux（JP-VPS）上自测，不需要 Mac。实现者是 Claude 自己；审查由 JP-VPS Codex 做（计划和 PR）；下面标"Mac 后验"的由 Mac mini Codex 在整批合入、预览版装好后做。

自测（都在隔离目录；重命令前缀 `flock /tmp/vonvon-heavy.lock`；临时目录只用 `T=$(mktemp -d)` 建、只用 `rm -rf -- "${T:?}"` 删；`HOME`/`VONVON_HOME` 只写在单条命令前，不 export）：

1. `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/protocol/test packages/daemon/test/remote-*.test.ts packages/daemon/test/authz.test.ts packages/daemon/test/rpc-device.test.ts packages/daemon/test/server-handshake.test.ts packages/daemon/test/owner-verification.test.ts packages/daemon/test/read-scope.test.ts packages/daemon/test/cli-parity.test.ts packages/daemon/test/cli-json.test.ts packages/daemon/test/cli-clients.test.ts packages/client/test packages/desktop/test/bridge.test.ts packages/desktop/test/attach.test.ts`；然后 `flock /tmp/vonvon-heavy.lock npm run typecheck --workspaces` 和 `lint`，`build` 只跑 protocol、client、daemon。
2. 真跑一次：`T=$(mktemp -d); mkdir -p $T/vh; mkdir -p -m 700 $T/vh/devices; printf '{"v":1,"port":7767,"addresses":[{"host":"192.168.1.9","enabledAt":0,"kind":"lan"}]}' > $T/vh/devices/remote.json; HOME=$T/home VONVON_HOME=$T/vh node packages/daemon/dist/cli.js daemon start`，然后同样前缀跑 `vonvon pair --json | cat`（非 TTY）看到 `ok:true` 和 `vonvon://pair#` 链接；`vonvon pair` 连跑 4 次第 4 次 exit 4；`vonvon clients ls --json` 为空表；`vonvon device rename 测试机 --json` 后 `daemon status --json` 的 `startedAt` 是数字；`ls -l $T/vh $T/vh/devices` 看 `local-credential`、`devices/device.json`、`devices/clients.json` 都是 `-rw-------`，`devices` 是 `drwx------`；`daemon stop`，再 `daemon start`，`local-credential` 内容变了。最后 `daemon stop`，`rm -rf -- "${T:?}"`。这个临时 daemon 和 Paseo、`accept-home2` 无关，不碰它们。
3. 旧 daemon 兼容（设计 4.5 回归，Linux 上能做一半）：在另一个 mktemp 目录里用 `git worktree`（或 `npm pack` 的 0.8.x 包）跑一个 **v1 的 daemon**，再用本片的 CLI 对它 `daemon status`、`daemon stop`，都要成功；反过来（v1 CLI 停 v2 daemon）同样做一次，看 `owner-verification` 的 v1 路径收到 `protocolVersion:1` 的 serverInfo。做不到就在 PR 里写"未验，靠 server-handshake 和 owner-verification 测试"。
4. 读档拒绝：`read-scope.test.ts` 的 0600 用例代替真会话；真会话的 `cat device.json` 被拒属于整批验收（Bot 6 的只读群），本片不做。

Mac 后验（写进整批的 Mac 验收任务，本片 PR 里标"待 Mac 验收"）：0.8 bundled daemon 在跑时起 0.9 桌面端，能停掉旧 daemon 并换上新的；本机"启动 daemon""仅运行此 Bot""启动服务"按钮仍可用；桌面端连上后 `attach` 拿到 serverInfo v2。Windows Codex：本片无专项。

## 7. 文档

- `docs/product.md` **本片不改**。这一批的 product.md 改动都在 D0 `devices-0-docs`（设计第 11 节）。D0 写的内容里和本片有关的：3.10（`local-credential` 每次启动轮换、`vonvon open --print` 只在本次运行有效）、新 3.14（设备和远程、配对链接、客户端列表和撤销）、第 8 节（`pair/clients/device` 命令）。D0 还没合入时，本片 PR 描述里提一句"product.md 由 D0 改"。
- `docs/v1-plan.md` 不改（设计第 13 节代替它记这一批的进度）。
- `docs/plans/devices.md` 不改；本片的偏差写在本文 4.3 和第 9 节，由集成 PR 描述汇总。

## 8. 验收要点

1. `P/handshake.ts`：`PROTOCOL_VERSION === 2`；`helloSchema` 的 diff 为空；存在 `serverInfoV1Schema`（strict）、`serverInfoV2Schema`（strict）、宽松 `serverInfoSchema`、`MAINTENANCE_KINDS`、`DRAIN_KINDS`，内容和本文 4.0 一字不差。
2. `P/device.ts` 的 schema 和 4.0 一致；`CLOSE_CODES` 七个 4xxx 码和设计 4.7 一致。
3. v1 hello 得到三字段 serverInfo 且 `protocolVersion: 1`，`daemonStatus` 回复无 `startedAt`；v2 hello 得到 v2 形状、`startedAt` 有值。
4. `local-credential` 每次启动不同，mode 0600；`device.json`、`clients.json` mode 0600，在 0700 的 `<dataRoot>/devices/` 里，这个目录在拒绝名单里；"0600 文件都在名单里"的测试存在。
5. `authz.test.ts` 的双向覆盖测试存在且过；`dispatch` 之前调用了 `authorize`。
6. 删掉的 11 个死 kind 在 protocol、daemon、ui、白名单里都没有残留（`grep -rn openEventSettings packages/` 为空）；`machine.startHost`、`machine.service` 仍在协议里；`DT/bridge.ts` 不再 import `machineRequestSchema` 解析外壳动作。
7. `connectBrowser`/`connectLocal` 返回 `{ client, serverInfo }`，四个调用方和四个测试都改了；`owner-verification` 不再比较版本。
8. `vonvon pair --json | cat` 出链接；无 daemon exit 3、无地址 exit 4、第 4 条邀请 exit 4，文字和设计第 15 节一致。
9. 配对链接和邀请 secret 不出现在 `log.*`、诊断事件或 pid 锁里（grep `invite.secret`、`link` 的日志调用）。
10. 白名单里没有 `arrives: 'D1'`；对齐测试绿。
11. 改动行数 ≤1,500（不含 lockfile）；删死 kind 单独一个 commit。
12. diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 估计约 1,350 行（协议 250、`D/remote` 300、server 250、CLI 220、客户端和桌面端形状 130、测试 400、删除约 −200 不计入上限）。超过 1,500 就把"4.4 第 2 条 + 4.1 第 4 条（外壳形状搬家和删死 kind）"拆成 D1b 先合，D1 本体跟上。
- `serverInfoSchema` 从 strict 改宽松会让仍 import 它做严格断言的测试跑红：全仓 grep `serverInfoSchema` 一次改完。
- `local-credential` 用 `writeFile`+`rename` 覆盖：daemon 重启空档里客户端读到旧值会 4401 一次，`daemon-client.ts` 的 `connectLocalDaemon` 本来就重试（`freshDaemon`），确认它在 4401 后重读文件而不是缓存。
- Codex 一侧的读档：若 `workspace-policy.ts` 的八条排除没覆盖数据根上的单个文件，要加三条路径，行数 +30；在 PR 里写明核对结果。
- 偏差汇总（审查后加的三条）：`device.json`、`clients.json`、`remote.json` 放进 `<dataRoot>/devices/`（设计写在根），读拒绝按目录；`MAINTENANCE_KINDS` 加 `machine.stopHost`（设计 4.5 的列表没有它，但"旧的也能停新的"要它）；CLI 直接写这几个文件时拿 host 互斥锁，不是数据租约。
- 偏差汇总：偏差 1、2（v1 peer 的 `protocolVersion` 回 1、`daemonStatus` 去 `startedAt`）；`remote.json` 的只读在 D1（设计放 D3，`pair` 要看地址）；`device.setPort` 是设计 `device.*` 列表之外的第 9 个 kind（`vonvon remote port` 在 daemon 跑着时必须经 RPC，否则违反"daemon 是唯一写入者"）；`DRAIN_KINDS` 和 `MAINTENANCE_KINDS` 分成两个常量（两组内容不同：排空放 `stopHost` 不放 `apply`，维护反之），设计 4.7 "同一个常量"按"同一处定义"理解；`pairing_limit`、`no_remote_address` 两个错误码是设计没列的，补在 4 那组。

## 审查后改了什么

两位审查者的 11 条全部接受，其中 D1-SEC-4 和 D1-R1 是同一个问题，合在一处改。

- D1-SEC-1 → 接受。`completePairing` 兑换后核对邀请人：不是 `local` 时必须在 `clients.json` 里且没撤销，否则 `pairing_failed`；`InviteBook.dropInvitedBy(ids)`，`followRevocations`（原 `announceRevocations`）在 `clients.onChange` 里对被撤销的 id 调用。测试：撤销 A 后 A 的邀请都不能配对、名额释放、`clients.json` 不多条目。
- D1-SEC-2 → 接受，用目录做法。三个文件搬进 `<dataRoot>/devices/`（0700），拒绝名单按目录：沙箱对目录是整个 tmpfs 遮挡，目录里的文件被 rename 替换也不会卸掉。本机用 bwrap 复现过：文件级 `--ro-bind /dev/null` 在 rename 后读到新内容，目录级 `--tmpfs` 不会。
- D1-SEC-3 → 接受，同上。daemon 启动时（`host/bootstrap.ts` 拿到 pid 锁后、任何 Bot 起来前，`startApi` 也会做）建好 `devices/`，会话起来时目录一定在，后出现的 `clients.json`、`remote.json` 都在被拒的目录里。
- D1-SEC-4 → 接受，和 D1-R1 一起改。
- D1-SEC-5 → 接受。`device.json` 用 `O_NOFOLLOW` 打开，链接、非普通文件、属主不是当前用户都拒绝启动；权限不是 0600 就改成 0600。`devices/` 目录同样核对，权限不是 0700 就改。测试：0644/0755 加载后变成 0600/0700，链接被拒。
- D1-R1 → 接受。CLI 直接写文件的那条路（`either()`）拿 host 互斥锁：daemon 从启动到退出一直拿着它，所以两个 CLI 轮流读改写，正在启动的 daemon 也要等 CLI 写完才读文件。拿不到锁就再看一次 daemon 在不在，在就走 RPC，10 秒还拿不到报"后台服务正在启动"（exit 3）。测试：6 条并发 revoke 都落盘；有人拿着 host 锁时 CLI 不写，放锁后才写。
- D1-R2 → 接受。`machine.stopHost` 进 `MAINTENANCE_KINDS`，删掉 `authz.ts` 的局部补丁；4.0 的表、第 9 节、D4a 计划第 79 行同步。
- D1-R3 → 接受。`AttachError` 加 `protocol`（带 `serverProtocol`，文字写两边的版本）；`checkProtocol` 遇到它返回对方版本号，交给 `daemon-manager` 现成的协议文案；`startupMessage` 对它不再加"请先启动 daemon"；重连循环把它当可重试，和 D1 之前一样。
- D1-R4 → 接受。首次生成照 keystore：`open(wx, 0600)`、写、`sync()`、`link`、同步目录；`renameDevice` 和 `clients.json` 的每次保存用 `writeFileAtomic(..., { durable: true })`。没加测试（要掉电才看得出）。
- D1-R5 → 接受。三个文件读的时候宽松：同一个 `v` 里不认识的字段保留、写回时带上，RPC 回复只带认识的字段；`v` 大于 1 报"较新版本写的"，不说损坏。测试：带 `accountId` 的条目能加载、撤销后还在，`v:2` 报较新版本；`device.json` 同样。
- D1-R6 → 接受，用目录做法。临时文件和目标在同一个目录（`devices/`），一起被拒；目录做法下不用另外按前缀拒，也不用启动时清理。`local-credential` 的残留临时文件没生效过（rename 前崩溃，下次启动重新生成），不处理。
- 任务 213、215（Codex 审查，同一条 P2：撤销写盘失败后重试误报"之前已经撤销过了"，重启后客户端又有效）→ 接受。`clients.json` 的每个改动（add、rename、revoke，和 touch 攒下的最近使用时间）排成一队：轮到时从已写成的名单复制一份、在副本上改、原子写盘，写成了才换成当前名单、`generation` 加一、通知 `onChange`（邀请清理和 D3 断连都靠它）。写失败（EISDIR、ENOSPC、EIO）就保留原名单，错误交给调用方（RPC 回错误，CLI exit 1），重试是真的重试，不挡后面的改动。touch 的时间先放在内存里的一层，写成了才清，写失败 close() 还会再写。核对邀请人从 `completePairing` 挪进 `add` 轮到时：撤销还在写时兑换的邀请，add 排在撤销后面，照样 `pairing_failed`。其他存储核对过：`device.json` 改名先写盘再换 `identity.current`，写失败什么都不变；`remote.json` 本片只读；邀请只在内存，兑换先用掉再写名单，写失败时这条链接作废、配对报错，不会误报成功（D2 接配对时再定要不要放回）；CLI 直接写文件每次新建名单，失败照样报错。测试：撤销写失败后名单不变、重试落盘并返回被撤销的 id、`onChange` 只一次、重新加载仍是撤销；add、rename 同样；三个并发改动中间一个写失败，不混进下一次写、不挡后面的；touch 写失败后 close() 再写；撤销在写时配对被拒。前四条在改之前的代码上失败。
- 任务 213、215 修复后的独立核对（P3：daemon 里同时两次设备改名，`identity.current` 可能和 `device.json` 不一致）→ 接受。上一条说"`device.json` 改名先写盘再换 `identity.current`"只对单次改名成立：`renameDevice` 先读再原子写，中间不排队，两次改名落盘的先后和两个 await 恢复的先后可能相反，`identity.current`（serverInfo 和配对链接用它）停在 A、磁盘是 B，重启后变 B。只影响显示名，deviceId 和密钥不变。改法：`remote/device.ts` 加 `holdDevice(home, identity)`，`current` 只读，`rename` 和 `clients.json` 一样排成一队：轮到时读文件、写盘，写成了才换 `current`，写失败什么都不变、不挡后面的；`http.ts` 用它持有身份，`deviceRpc` 的 `rename` 走它。CLI 直接写文件那条路已由 host 互斥锁串行，不改。测试：RPC 上 10 轮、每轮 6 次并发改名，每次回复自己的名字，`identity.current.name` 和 `device.json` 一致且是最后一次（改之前的代码上第 3 轮就失败）；`holdDevice` 三次并发中间一次 EIO，结果 A、EIO、C，`current` 和文件都是 C；单次 ENOSPC 后 `current` 和文件不变，重试落盘。
