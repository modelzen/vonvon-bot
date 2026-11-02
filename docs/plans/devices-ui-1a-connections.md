# U1a `devices-ui-1a-connections`：桌面端记住几台设备、一次连一台、请求按当前设备走

总设计见 `docs/plans/devices.md`（下文简称"设计"）4.3–4.7、6.1、6.4 末行、第 15、16、19 节，本片对应第 13 节的 U1a 行。**U1a 和 U1b（`docs/plans/devices-ui-1b-devices-page.md`）合成一个 PR**，分支 `claude/devices-ui-1`：U1a 单独合入没有用户能看到的东西，Mac 验收也要两片一起才做得了。两份计划各管各的模块，审查也按模块分（第 9 节）。

缩写同 D1：`P/` = `packages/protocol/src/`，`CL/` = `packages/client/src/`，`D/` = `packages/daemon/src/`，`DT/` = `packages/desktop/src/`，`U/` = `packages/ui/src/`。行号以 `origin/claude/devices-integration`（8051b03c；本片引用的 desktop、ui、client、protocol 文件和 a2577fb3 相同）为准；D1 还没合入，它的名字以 `origin/claude/devices-1-identity`（147b2619）为准，写作"D1 分支"。

## 1. 做什么

桌面端能记住几台别的设备（每台一对自己的客户端密钥，私钥用系统钥匙串加密），一次连一台"当前设备"：界面发出的每个请求、收到的每份快照都来自当前设备。连接断了按 `min(30 s, 1 s × 2^n)` 自动重连，重连后比较 `serverInfo` 和 `daemonStatus.pid/startedAt`，知道对面是重启过还是升级过；被撤销、身份变了、密钥读不出来时停下，不再重试。用户看得到的部分（设备页、添加、切换、提示条、维护视图）在 U1b。

依赖：
- D1（未合入）：`P/device.ts` 的 `decodePairingLink`、`pairResultSchema`、`deviceRequestSchema`、`deviceEventSchema`、`CLOSE_CODES`；宽松 `serverInfoSchema`、`PROTOCOL_VERSION = 2`、`MAINTENANCE_KINDS`；`admin.daemonStatus` 的 `startedAt`；`desktop:client:device` 通道；`AttachedDaemon.serverInfo`。
- D2（计划在 `devices-2-secure-channel.md`，还没写代码）：`connectSecure`、`nodeBinarySocket`、`generateStaticKey`、`staticKeyFromBase64url`、`SecureChannelError`。本片先对 4.3 的 `RemoteConnector` 接口写，单测用假连接器；D2 合入后接上真的。4.3 末尾列了本片要 D2 补的三处契约。
- D3：真机验收要它（远程监听、撤销 1 秒内断、4006）。

被依赖：U1b（同 PR）；U2 用 `useActiveDevice()` 和远程时的 shell；U3 用 `onLocalDeviceEvent`；U4 用 `DesktopBridge.localOwner()`/`onLocalOwner`。

## 2. 范围

做：
- `P/desktop-devices.ts`：设备状态、链接预览、添加结果的 schema，主进程和界面共用。
- `DT/device-registry.ts`：设备列表文件 `userData/devices.json`。
- `DT/remote-transport.ts`：`ws` + D2 的 `connectSecure`，把各种失败归成一组错误码。
- `DT/connections.ts`：多设备连接管理：当前设备一条会话、加设备时至多再一条配对连接；切换、重连退避、比较 `serverInfo`、撤销和身份变化、添加、删除。
- `DT/bridge.ts`：请求按当前看的设备走；本机连接和"正在看的那条"分开管，本机换连接和切换交错时不串台；远程时拒绝只对本机有效的外壳操作，但把对面的登录时启动开关（`machine.service install/uninstall`）转过去；切换时旧页面的请求不会打到新设备上。
- `DT/ipc-contract.ts`、`DT/facade.ts`、`DT/preload.ts`：`desktop:devices:*` 通道，`devices`、`localDevice` 事件，按设备绑定的 client。
- `DT/main.ts`：接线、`powerMonitor` 唤醒、退出收尾、本机断线弹窗在看远程时延后。
- `CL/client.ts`：`onDevice`。
- `U/client-context.tsx`：`ActiveDevice`、`useActiveDevice()`、`useDevicesState()`、`deviceCopyName()`、`shellForDevice()`。

不做：
- 设备页、添加对话框、切换标签、状态点、提示条、维护视图、全部文案 → U1b（同 PR）。
- 设计 6.4 表里远程时界面的隐藏和改文案 → U2。本片只在主进程拒绝本机专属操作，并让远程时传给页面的 shell 去掉这几项（4.7），目录选择因此自动走 daemon 侧目录浏览器。
- "允许别的设备连接"面板、生成链接、撤销别的客户端 → U3。
- 桌面端自带服务端的远程升级 → U4；本片保证本机连接一直在，并给出 `localOwner()`。
- 浏览器远程、中继、账号；给非当前设备保持连接或在后台探测状态（SCOPE-1，`product.md` 3.14"不是当前的设备不保持连接"）。
- 启动时恢复上次看的设备：每次启动都从"这台电脑"开始（第 9 节）。

## 3. 现在的代码

- `DT/main.ts`：
  - `startDesktop` 50；测试 HOME 57-60 把 `userData` 设到 `VONVON_DESKTOP_TEST_HOME/userData`。
  - `cleanup` 138-159：隐藏 → 停更新检查 → `restartCancel.abort()` → 等 `starting` → `bridge.dispose()` 或 `owner.dispose()` → 托盘、窗口。`confirmQuit` 173-207；`beforeUpdateInstall` 230-241。
  - `owner = await attachExisting(root)` 283。
  - `reattachReady` 354-368、`restartHost` 370-421、`stopHost` 423-462，这几个等的是本机 pid 锁。
  - `reconnectPassive` 492-532。`recoverConnection` 535-560 恢复失败时直接 `showConnectionLost()`（541、549）；`showConnectionLost` 562-571 弹"daemon 连接中断了"的模态框。
  - `installBridge(owner, current, paths, {...})` 573-654；托盘 655；`loadFile` 670。今天没用 `powerMonitor`。
- `DT/bridge.ts`：
  - `installBridge` 115。状态在 119-130：`activeOwner`、`replacing`、`candidate`、`stoppedStatus`、`lastStatus`、`retainedErrors`。`send` 144-147 只在 `subscribed && currentDocument()` 时发。
  - `onError(error, from)` 168-179：`ConnectionError` 先问 `isExpectedDisconnect()` 和 `recoverConnection(from.identity)`，都不接就发 `error` 事件并调 `actions.connectionLost()`。
  - `client()` 181-184。`bind(current, paused)` 191-224 订 `watchSnapshots`、`onLog`、`onBackendInstall`、`onError`，靠 `activeOwner === current` 防串。
  - 注册在 242-323：
    - `run` 244-247：`restartHost` 走 `actions.restartHost`。
    - `machine` 251-272：`stopHost`，`stoppedStatus` 和 `observeCli` 覆盖在回复上。
    - `close` 280：`activeOwner?.dispose()`。
    - 本机专属：`startHost` 282-287、`service` 288-303、`setLoginItem` 304-311、`repairCli` 312、`chooseExecutablePath` 314、`chooseDirectoryPaths` 315-318。
  - `subscribe` 324-332 重放错误、更新和退出请求。
  - `replaceOwner` 343-377：先 dispose 旧的，暂停绑定新的，等快照，发 `reattached`，再 `activate`。只有一个 `binding` 变量（226），`replaceOwner` 在 await 之后直接 `binding = nextBinding`、发 `reattached`、`activate`，不看别的。
  - `dispose` 384-397。
  - D1 分支：`machine`、`startHost`、`service` 的解析换成 `desktopShellRequestSchema`；加 `register(desktopChannels.device, 1, deviceRequestSchema.parse, value => client().device(value))`。
    - `machine` 的解析（D1 分支 `bridge.ts:251-253`）先 `desktopShellRequestSchema.safeParse(value)`，命中就抛 `Shell-owned machine action`。这个 schema 含 `service`（D1 分支 `ipc-contract.ts:42-48`），所以今天页面发 `machine {type:'service', action:'install'}` 到不了任何 daemon。
- `DT/ipc-contract.ts`：`desktopChannels` 8-36（D1 加 `device: 'desktop:client:device'`）、`SafeFailure` 38-42、`DesktopEvent` 51-59、`DesktopShell` 61-63、`AttachedDaemon` 71-75（D1 加 `serverInfo`）、`DesktopBridge` 77-84、`ShellActions` 86-108。
- `DT/facade.ts`：`createDesktopFacades(transport)` 46；`onEvent` 82-127，`reattached` 让 `connectionEpoch++`；`callClient` 133-146；`client.watchSnapshots` 156-176 只收 `revision` 变大的快照，`connectionEpoch` 变了才把 revision 清零；`shell` 221-265。
- `DT/preload.ts` 20-30：`createDesktopFacades` 后 `exposeInMainWorld('vonvonClient' | 'vonvonShell')`。
- `DT/attach.ts`：`attachExisting(root)` 38-100；D1 分支返回 `serverInfo`，协议不同报 `AttachError('protocol')`。
- `CL/client.ts`（D1 分支）：`VonvonClient` 29-47 有 `device()`；事件分发 126-130 只认 `snapshot`、`log`、`backendInstall`。`eventSchema` 已含 `device` 事件，但没人分发。
- `U/client-context.tsx`：`ShellCapabilities` 5-22、`ClientProvider` 27-29、`useClient` 31-35、`useShellCapabilities` 37-39。
- `U/main.tsx`：`Root` 28-102；桌面端分支在 97，直接用 `window.vonvonClient`。
- `U/directory-picker.tsx` 107-111：有 `shell.chooseDirectoryPaths` 就用原生对话框，没有就用 daemon 侧目录浏览器。
- 依赖和构建：
  - `packages/desktop/package.json` 只依赖 `@vonvon/client`、`@vonvon/protocol`、`electron-updater`、`zod`。
  - `build.mjs` 46-53：esbuild `platform: 'node'`、bundle，`external: ['electron']`。
  - `@vonvon/client` 已依赖 `ws` 8.22.0（`transport-local.ts:5`）。
  - 主进程今天用 `@vonvon/client/browser`（全局 WebSocket）连本机。

旧行为里要留意的两处：
1. facade 只收 revision 变大的快照，换连接靠 `reattached` 清零（facade 160-165）。远程的 revision 和本机无关，换设备时不发 `reattached`，对面的快照就会被丢掉。
2. 请求发给谁，是主进程收到时由 `client()` 决定的。切换那一刻旧页面还在发的请求会打到新设备上，比如定时刷新，或自动保存的编辑器（`settings/DraftGuard.tsx:34`、`settings/BotModelSettings.tsx:19`）发的保存。本片按 4.6 把它堵上。

## 4. 怎么改

### 4.1 `P/desktop-devices.ts`（新，从 `P/index.ts` 导出，只有 zod）

只给桌面端主进程和界面用。先例是 `P/machine.ts:28` 的 `desktopUpdateSchema`。界面解析它时不用 import desktop 包。

```ts
export const LOCAL_VIEW = 'local' as const;
export const viewIdSchema = z.union([z.literal('local'), z.string().uuid()]);      // 'local' 或远程设备的 deviceId（= 对方 machineId）
export const deviceAliasSchema = z.string().trim().min(1).max(40).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
export const deviceRouteSchema = z.object({
  host: z.string().min(1).max(64), port: z.number().int().min(1).max(65535),
  kind: addressKindSchema.exclude(['loopback']),
}).strict();
export const deviceProblemSchema = z.enum(['revoked', 'identity_changed', 'unknown_client', 'key_unreadable']);
export const routeFailureSchema = z.object({ route: deviceRouteSchema, code: z.string() /* RemoteConnectCode，按开放字符串 */ }).strict();
export const deviceRowSchema = z.object({
  id: viewIdSchema, name: z.string(), current: z.boolean(),
  status: z.enum(['online', 'connecting', 'reconnecting', 'offline', 'maintenance', 'revoked', 'needs-pairing', 'unknown']),
  platform: z.string().optional(), version: z.string().optional(), protocolVersion: z.number().int().optional(),
  lastConnectedAt: z.number().int().optional(), problem: deviceProblemSchema.optional(),
  routes: z.array(deviceRouteSchema),                         // 本机是 []
}).strict();
export const activeDeviceSchema = z.object({
  id: viewIdSchema,
  phase: z.enum(['connecting', 'ready', 'reconnecting', 'failed']),  // 本机永远 'ready'，本机断线照旧由外壳处理
  mode: z.enum(['full', 'maintenance']).optional(),                  // ready 时有；reconnecting 时保留上次的，U1b 据此决定留着页面还是维护视图
  serverInfo: serverInfoSchema.optional(),                           // 本机：本机的；远程：最近一次连上时的
  attempt: z.number().int().min(0), retryAt: z.number().int().optional(),
  failure: z.object({ code: z.string(), attempts: z.array(routeFailureSchema).max(8), at: z.number().int() }).strict().optional(),
  expected: z.enum(['restart', 'stop']).optional(),
  disabledAt: z.number().int().optional(),                           // 对面以 4006 关了远程连接的时刻；下次连上或切换时才清，之后的 refused、unreachable 不覆盖它
  notice: z.object({ kind: z.enum(['restarted', 'updated']), from: z.string().optional(), to: z.string().optional(),
    at: z.number().int() }).strict().optional(),
}).strict();
export const devicesStateSchema = z.object({
  v: z.literal(1), revision: z.number().int(),
  client: z.object({ version: z.string(), protocolVersion: z.number().int() }).strict(),
  registry: z.enum(['ok', 'newer', 'recovered', 'unreadable']), secureStorage: z.boolean(),
  devices: z.array(deviceRowSchema).min(1),                   // [0] 永远是本机
  active: activeDeviceSchema,
  adding: z.object({ stage: z.enum(['connecting', 'pairing', 'checking']), route: deviceRouteSchema.optional() }).strict().optional(),
}).strict();
export const linkPreviewSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), deviceId: z.string().uuid(), name: z.string(), routes: z.array(deviceRouteSchema).min(1),
    expiresAt: z.number().int(), repair: z.boolean() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['invalid_link', 'link_expired', 'own_link', 'already_added', 'no_secure_storage',
    'registry_newer', 'registry_unreadable', 'too_many']), deviceId: z.string().optional(), name: z.string().optional(),
    routesChanged: z.boolean().optional() }).strict(),
]);
export const addDeviceRequestSchema = z.object({ link: z.string().min(1).max(4096), name: deviceAliasSchema.optional() }).strict();
export const addDeviceResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), deviceId: z.string(), name: z.string(), repaired: z.boolean() }).strict(),
  z.object({ kind: z.literal('updated'), deviceId: z.string(), name: z.string() }).strict(),   // 已加过，只换了地址
  z.object({ kind: z.literal('failed'), code: z.string(), attempts: z.array(routeFailureSchema).max(8) }).strict(),
]);
export const removeDeviceResultSchema = z.object({ revokedRemotely: z.boolean() }).strict();
// 以及各自的 type
```

行状态怎么算（`connections.ts` 的 `rowStatus`）：
- 本机：由 `setLocal` 给，`online`、`connecting` 或 `offline`。
- 当前的远程设备按 `active` 算：
  - `ready`：`full` → `online`，`maintenance` → `maintenance`。
  - `connecting` → `connecting`；`reconnecting` → `reconnecting`。
  - `failed`：`revoked` → `revoked`；其余问题 → `needs-pairing`。
- 非当前的远程设备，按下面的顺序取第一条：
  1. 有问题（连接管理器内存里的 `problems`，没有再看存下的 `problem`，4.4）：`revoked` → `revoked`，`identity_changed`、`unknown_client` → `needs-pairing`。
  2. 这次运行里最后一次连它失败了 → `offline`。
  3. `lastKnown.protocolVersion` 和本机不同 → `maintenance`。
  4. 其余 → `unknown`，界面显示"上次在线 <时间>"。

  不为了状态点去探测（设计 6.1、SCOPE-1）。

### 4.2 `DT/device-registry.ts`（新）

```ts
export interface SecretBox { available(): boolean; seal(plain: string): string /* base64 */; open(sealed: string): string }
export function electronSecretBox(storage: Pick<Electron.SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>): SecretBox;
export interface StoredDevice {
  deviceId: string; name: string /* 本机给它起的名字 */; pk: string /* 链接里的 device.pk */; clientId: string /* pairResult.clientId */;
  clientKey: { publicKey: string; secretKeySealed: string };      // X25519，base64url；私钥 safeStorage 加密后 base64
  routes: DeviceRoute[]; lastRoute?: DeviceRoute;
  addedAt: number; lastConnectedAt?: number;
  lastKnown?: { version: string; protocolVersion: number; platform?: string; deviceName?: string; at: number };
  problem?: { code: 'revoked' | 'identity_changed' | 'unknown_client'; at: number };
}
export type RegistryStatus = 'ok' | 'newer' | 'recovered' | 'unreadable';
export interface DeviceRegistry {
  readonly status: RegistryStatus;
  list(): readonly StoredDevice[];
  get(deviceId: string): StoredDevice | undefined;
  put(device: StoredDevice): Promise<void>;                                    // 新增或整条替换
  update(deviceId: string, patch: (d: StoredDevice) => StoredDevice): Promise<StoredDevice | undefined>;
  remove(deviceId: string): Promise<boolean>;
  sealKey(generated: { publicKeyBase64url: string; privateKeyBase64url: string }): StoredDevice['clientKey'];
  openKey(device: StoredDevice): StaticKey;                                    // 解不开抛 RegistryError('key_unreadable')
}
export async function openDeviceRegistry(path: string, box: SecretBox, opts?: { now?: () => number }): Promise<DeviceRegistry>;
export const MAX_DEVICES = 32;
```

- 文件 `join(app.getPath('userData'), 'devices.json')`，内容 `{ v: 1, devices: StoredDevice[] }`，权限 0600。写入时先写同目录的 `devices.json.tmp-<pid>`（`mode: 0o600`），再 `rename`。所有写入串在一条 Promise 链上；`update` 在链里"读当前内存 → patch → 写"，所以并发的改名和连接成功不会互相覆盖。写失败就抛出，内存不改。
- **只加密私钥，不加密整个文件**，和设计 6.1 不一样，第 7 节改设计。原因：钥匙串拒绝访问，或者应用换了签名、钥匙串里那一项读不出时，整文件加密会让列表整个没了。只加密私钥时列表还在，那几台显示"需要重新配对"，重配一次就好。明文部分（名字、地址、版本）和别的应用配置一样敏感，权限 0600。
- 读文件：
  - 不存在 → 空列表，`ok`。
  - `v > 1` → 用不 strict 的 schema 只取认识的字段，坏的条目跳过，状态 `newer`。所有写入抛 `RegistryError('registry_newer')`，连接照常；连上后不回写 `lastConnectedAt`。
  - JSON 坏了或 schema 不过 → 原文件改名为 `devices.json.broken-<毫秒时间>`，从空列表开始，状态 `recovered`。
  - 读不了（`EACCES` 这类）→ 空列表、只读，状态 `unreadable`。
- `openDeviceRegistry` 不抛错：出问题时 app 照常起来，只是设备功能受限。
- `MAX_DEVICES = 32`，`put` 一台新设备超了就抛 `too_many`。
- `secretKeySealed`：`box.seal(privateKeyBase64url)`。`openKey` 用 `staticKeyFromBase64url(publicKey, box.open(secretKeySealed))`（D2）。`box.available()` 为假，或 `decryptString` 抛错，都报 `key_unreadable`。

### 4.3 `DT/remote-transport.ts`（新）

```ts
export type RemoteConnectCode = 'refused' | 'unreachable' | 'timeout' | 'forbidden' | 'rate_limited' | 'device_identity_changed'
  | 'handshake_failed' | 'unknown_client' | 'client_revoked' | 'pairing_failed' | 'remote_disabled' | 'protocol_mismatch' | 'closed' | 'aborted';
export class RemoteConnectError extends Error {
  constructor(readonly code: RemoteConnectCode, readonly stage: 'socket' | 'handshake' | 'pairing' | 'hello', readonly detail?: { httpStatus?: number; sysCode?: string });
}
export interface RemoteLink {
  client: VonvonClient; serverInfo: ServerInfo; pairResult?: PairResult;
  closed: Promise<{ code: RemoteConnectCode; closeCode?: number }>;   // 连接建立后结束时 resolve 一次；我方 close() 时 code 'closed'
  close(): void;
}
export interface RemoteConnectOptions {
  route: DeviceRoute; device: { id: string; pk: string }; clientKey: StaticKey;
  pairing?: { inviteId: string; inviteSecret: string; clientName: string };
  signal: AbortSignal;
}
export interface RemoteConnector { connect(options: RemoteConnectOptions): Promise<RemoteLink> }
export function secureConnector(deps?: { WebSocket?: typeof import('ws').WebSocket; routeTimeoutMs?: number /* 10_000 */ }): RemoteConnector;
export function routeUrl(route: DeviceRoute): string;   // ws://host:port/，IPv6 加方括号
```

`secureConnector().connect` 的步骤：
1. 新建 `new WebSocket(routeUrl(route), { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 4_000_000 })`。
   - 不设 `origin`。`ws` 默认不发 Origin，D3 的远程监听见到 Origin 就回 403。
   - `Host` 由 `ws` 按 URL 填成 `ip:port`，IPv6 带方括号，正好是 D3 要核对的形状。
   - 主进程不用全局 WebSocket：它报不出 `ECONNREFUSED`、`EHOSTUNREACH` 这些系统码，而第 15 节的提示要按它们分。
2. socket 阶段失败的归类：
   - `unexpected-response` 403 → `forbidden`。
   - `unexpected-response` 429 → `rate_limited`：D3 的 `admit` 在未认证连接数超限时回 429（D3 计划 4.5），要按至少 60 秒退避，不能按 1 秒去撞。
   - `ECONNREFUSED` → `refused`。
   - `EHOSTUNREACH`、`ENETUNREACH`、`EADDRNOTAVAIL`、`ENOTFOUND` → `unreachable`。
   - `ETIMEDOUT` 或握手超时 → `timeout`。
   - 其余 → `closed`。
   - 握手前就被关：4004 → `rate_limited`，4006 → `remote_disabled`。
3. `open` 后调 D2 的 `connectSecure({ socket: nodeBinarySocket(ws), device, clientKey, clientKind: 'desktop', pairing })`。`SecureChannelError.code` 一对一映射；`stage` 用 D2 补的 `stage`，没有时按 `pairing` 有没有值推断。
4. 整条路由最多 `routeTimeoutMs`（10 秒，socket 5 秒加握手 5 秒）。
5. `signal` 触发时 `ws.terminate()`，拒绝为 `aborted`。socket 是调用方建的，自己关就行，`connectSecure` 不用认 `signal`。
6. 成功后：
   - `closed` 只由 D2 的 `SecureConnection.closed` 决定。`ConnectionError` 是 `client.ts` 在 socket 关闭回调里同步发的，比 D2 的 Promise 早一个微任务，又不带关闭码；拿先到的定，4003 会被认成普通的 `closed`，走重连，而不是 1 秒内变"已撤销"。
   - 兜底：`client.onError` 收到 `ConnectionError` 后，D2 的 `closed` 250 ms 内还没 settle，才以 `closed` 结束。只 resolve 一次。
   - `close()` 关通道，并把 `closed` 定为 `{ code: 'closed' }`。

`packages/desktop/package.json` 加 `ws: 8.22.0`（和 client 同版本）和 `@types/ws`（devDependency）。构建时核对 esbuild 对 `ws` 里 `bufferutil`、`utf-8-validate` 的可选 require 只报警告，报错就把这两个加进 `build.mjs` 的 `external`。

**要 D2 补的契约**（已在 `devices-2-secure-channel.md` 4.2 末尾补了一段）：
1. `SecureConnection.closed: Promise<SecureChannelError>`：已建立的连接结束时 resolve 一次。错误码按 4.2 那张关闭码表映射（4003 → `client_revoked`，4006 → `remote_disabled`，1001 → `closed`，ping 超时 → `timeout`）。U1a 靠它 1 秒内认出"已撤销"，`ConnectionError` 本身不带关闭码。
2. `SecureChannelError` 加 `stage: 'handshake' | 'pairing' | 'hello' | 'open'`。配对中途断了要靠它决定要不要不带邀请再连一次（4.4"添加"第 5 步）。
3. 导出走子路径：
   - `@vonvon/client/secure` → `transport-secure.js`。它的 client 用 `client.js` 的 `createClient`，所以 `ConnectionError` 和 `@vonvon/client/browser` 里的是同一个类，桌面主进程的 `instanceof` 才认得。
   - `@vonvon/protocol/secure-channel` → `secure-channel.js`，**不从 `P/index.ts` 导出**。界面打包浏览器端时会 import `@vonvon/protocol`，不能把 `node:crypto` 带进去。
   - 两个包的 `package.json` 都要在 `exports` 里加这条子路径（今天 protocol 只有 `.`，client 只有 `.` 和 `./browser`），不加 import 就报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。D2 计划 4.2 已补这一句。

### 4.4 `DT/connections.ts`（新，核心）

```ts
export interface DeviceConnectionsDeps {
  registry: DeviceRegistry; connector: RemoteConnector; box: SecretBox;
  client: { version: string; protocolVersion: number };          // app.getVersion()、PROTOCOL_VERSION
  generateKey?: typeof generateStaticKey;                         // 测试注入
  now?: () => number; timers?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  log?: (event: DeviceLogEvent, fields: Record<string, string | number>) => void;   // 只记设备 id 前 8 位、事件、码、毫秒时间；不记地址、链接、密钥
}
export interface ViewSession { id: string; client: VonvonClient; serverInfo: ServerInfo; mode: 'full' | 'maintenance' }
export type ViewChange =
  | { kind: 'local' }
  | { kind: 'remote'; session: ViewSession; cause: 'opened' | 'reopened' | 'restarted' }
  | { kind: 'waiting'; id: string };   // 当前是远程设备，但此刻没有能用的连接（连接中、重连中、失败）
export interface DeviceConnections {
  state(): DevicesState;
  onState(listener: (state: DevicesState) => void): () => void;
  onView(listener: (change: ViewChange) => void): () => void;
  view(): ViewChange;
  switchTo(id: ViewId): Promise<void>;           // 切过去就返回，不等连上
  retry(): void;                                  // 用户点"重试"
  wake(): void;                                   // 从睡眠恢复
  inspectLink(text: string): LinkPreview;
  add(request: AddDeviceRequest): Promise<AddDeviceResult>;
  cancelAdd(): void;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<RemoveDeviceResult>;
  setLocal(local: { status: 'online' | 'connecting' | 'offline'; serverInfo?: ServerInfo }): void;
  expect(kind: 'restart' | 'stop'): void;
  dispose(): Promise<void>;
}
export function createDeviceConnections(deps: DeviceConnectionsDeps): DeviceConnections;
export type DeviceLogEvent = 'device-opened' | 'device-closed' | 'device-failed' | 'device-added' | 'device-removed';
```

日志一行一件事，形如 `2026-11-01T08:00:00.123Z device-closed id=1a2b3c4d code=client_revoked`。`onClosed` 一进来就写 `device-closed`。U1b 6.2 第 7 步拿它和助手回的 `revokedAt` 相减，只作参考；1 秒的判据以第 6 节第 2 步的探针为准（同一台机器上计时）。

常量：
- 退避 `backoff(n) = min(30_000, 1_000 × 2^n)`，n 从 0 起，依次是 1、2、4、8、16、30、30… 秒。
- `rate_limited` 至少等 60 秒。
- 每条路由 10 秒。
- `daemonStatus` 5 秒；删除时自撤销 3 秒。
- `expected` 两分钟后失效。

内部状态：
- `viewId`；`gen`：每次 `switchTo`、`remove` 当前设备、`dispose` 都加一。
- `seq`：每发起一次连接尝试加一。`open` 每一步都和 `gen` 一起核对，`retry()` 换掉进行中的尝试靠它。
- `session?: { gen; link; route; info; mode; pid?; startedAt? }`。
- `phase`、`attempt`、`retryTimer`、`connecting?: AbortController`、`failure?`。
- `expected?` 和它两分钟的定时器；`notice?`；`disabledAt?`（4006 的时刻，见"断了"）。
- `problems: Map<deviceId, 'revoked' | 'identity_changed' | 'unknown_client'>`：终止类问题的内存副本，同步写；`rowStatus`、`inspectLink`、`switchTo` 先看它。`registry` 的落盘异步跟上。4.2 的 `update` 写成才改内存，不能拿它当同步的真相。
- `lastIdentity: Map<deviceId, { pid?; startedAt?; version }>`：这次运行里每台最后一次连上时的身份。
- `lastFailure: Map<deviceId, code>`。
- `pairing?: { abort: AbortController }`；`removing`：`remove` 当前设备、发了自撤销时为真，`onClosed` 见到 4003 时不记成被撤销。
- `localMachineId`：`setLocal` 记下，`own_link` 用。
- `switchTo` 换设备时清：`session`、`connecting`（abort）、`retryTimer`、`failure`、`expected` 和它的定时器、`notice`、`disabledAt`。`problems`、`lastIdentity`、`lastFailure` 按设备记，不清。

任何时刻最多两条远程连接：当前设备一条，正在添加的一条。

**切换 `switchTo(id)`**：
1. `id === viewId`：
   - `phase` 不是 `failed` → 什么都不做。
   - 是 `failed` → 按 `retry()` 处理。
2. 否则：
   - `gen++`，`connecting?.abort()`，清 `retryTimer`。
   - 有 `session` 就 `session.link.close()` 并清掉；清 `failure`、`expected`（连同定时器）、`notice`、`disabledAt`。不清 `failure` 的话，失败后切走再切回会先显示旧的"连不上"，而不是"正在连接"。
3. `viewId = id`。
   - `local`：发 `{ kind: 'local' }`，发状态，结束。
   - 远程但不在列表里：抛 `unknown_device`。
4. 有问题（`problems` 或存下的 `problem`）→ `phase = 'failed'`，`failure.code` 等于问题码，发 `waiting`，不去连。
5. 否则 `phase = 'connecting'`，`attempt = 0`，发 `waiting`，`seq++`，`void open(gen, seq)`。

**连 `open(myGen, mySeq)`**，每一步之后都核对 `gen === myGen && seq === mySeq`，不等就关掉手上的连接退出（`switchTo` 换设备、`retry()` 换掉旧尝试都会让它不等）：
1. `key = registry.openKey(d)`。抛错 → `fail('key_unreadable', 终止, 不落盘)`。
2. 路由顺序：`lastRoute` 在前，再按 `routes` 原顺序，去重。逐条 `connector.connect({ route, device: { id: d.deviceId, pk: d.pk }, clientKey: key, signal })`，每条失败记进 `attempts`。
   - 碰到 `client_revoked`、`unknown_client` 就不试下一条：对面认出了这把钥匙，换地址也一样。
   - `device_identity_changed`（4005）只说明**这个地址上**的 Vonvon 解不开用链接里那把公钥加密的消息 1（D2 计划 4.2），可能是同一个局域网里换到这个 IP 的另一台，不证明目标设备换了身份。记下，接着试下一条。
3. 都失败 → `onFailure(myGen, 选出的码, attempts)`。选码：
   - 有 `client_revoked` 或 `unknown_client` → 它；
   - 每条都是 `device_identity_changed` → 设备级的 `identity_changed`，终止并落盘；
   - 否则取第一条不是 `device_identity_changed` 的路由的码，照常退避。
4. 核对 `link.serverInfo.machineId === d.deviceId`。不等就关掉，按 `identity_changed` 终止并落盘。D2 的 IK 已经核对过公钥，这一条防的是数据目录被拷到另一台机器。
5. `mode`：`serverInfo.protocolVersion === client.protocolVersion` 时为 `full`，否则为 `maintenance`（设计 4.5）。
6. `status = await withTimeout(link.client.admin({ type: 'daemonStatus' }), 5_000)`，失败当 `undefined`。`daemonStatus` 在维护子集里，两种模式都能发。
7. 和 `lastIdentity.get(id)` 比，得出 `cause`：
   - 之前没有 → `opened`。
   - `status` 有值，且 `pid`、`startedAt` 都一样 → `reopened`。
   - `status` 有值但不一样 → `restarted`。
   - `status` 是 `undefined` → `reopened`，除非版本变了。
8. 得出 `notice`：
   - 版本变了 → `{ kind: 'updated', from, to }`。
   - `restarted`，而且不是 `expected` → `{ kind: 'restarted' }`。
   - `expected` 用掉即清。
9. `await registry.update(id, …)`：写 `lastRoute`、`lastConnectedAt`、`lastKnown`，清 `problem`。写失败只记日志。
10. 再核对 `gen` 和 `seq`。然后存 `session`，`phase = 'ready'`，`attempt = 0`，清 `failure`、`disabledAt`，`problems.delete(id)`，`lastFailure.delete(id)`。
11. 订 `link.closed.then(c => onClosed(myGen, session, c))`。
12. 先发 `{ kind: 'remote', session, cause }`，再发状态。顺序要紧：bridge 先换好绑定，界面收到 `ready` 后发的请求才有地方去。

**断了 `onClosed(myGen, s, c)`**：
1. `gen !== myGen` 或 `s !== session` → 忽略，这是我方自己关的。
2. 把这次的 `pid`、`startedAt`、`version` 记进 `lastIdentity`，`session = undefined`，发 `waiting`。
3. 按码处理：
   - `client_revoked`（4003）：**在同一个回调里** `problems.set(id, 'revoked')`（内存，同步），`registry.update` 落盘异步，`phase = 'failed'`，发状态，不设任何定时器。正在删除这台、刚发了自撤销时（`removing` 标记）跳过这一步。
   - `unknown_client`：同样终止，`problems` 同步写、落盘异步。（4005 只在消息 2 之前出现，连上以后不会以 `device_identity_changed` 结束。）
   - 其余（`remote_disabled` 4006、`closed`、1001、`timeout`、`protocol_mismatch` 4001 等）：`phase = 'reconnecting'`，按退避排下一次。
   - `remote_disabled` 另记 `disabledAt = now`，直到下次连上或切换才清；之后重连失败得到的 `refused`、`unreachable` 只改 `failure`，不动它。D3 关了地址以后新连接是被拒（`ECONNREFUSED`），不是 4006；不这样记，提示条第一次重连失败后就改成"Vonvon 可能没在运行"。
4. 排下一次：`attempt` 从 0 起，`retryAt = now + delay`，定时器到了就 `seq++`、`open(gen, seq)`，前提是 `gen` 没变。

**失败 `onFailure(myGen, code, attempts)`**：
- 终止码：`client_revoked`、`unknown_client`、`key_unreadable`，以及 `open` 第 3 步选出的设备级 `identity_changed`。
  - `phase = 'failed'`；除 `key_unreadable` 外都 `problems.set` 并落盘为 `problem`；`key_unreadable` 不落盘，只记 `lastFailure`。
- 其余：`phase` 保持 `connecting`（还没连上过）或 `reconnecting`（连上过又断了），`attempt++`。
  - `delay = backoff(attempt - 1)`，`rate_limited` 时取 `max(60_000, 退避值)`。
  - 记 `lastFailure`，排定时器。`failure` 一直带着 `attempts`，界面据此按地址给提示。

**`retry()` 和 `wake()`**：
- `retry()`：当前是远程，`phase` 不是 `ready` 时：`connecting?.abort()`、`seq++`、清定时器、`attempt = 0`，马上 `open(gen, seq)`。旧尝试的结果回来时 `seq` 已经不等，被关掉、不发事件，打开的远程链接仍不超过当前一条加配对一条。
  - `failed` 只对 `key_unreadable` 重试，用户可能刚在钥匙串里点了允许。
  - `revoked`、`identity_changed`、`unknown_client` 要重新配对，`retry()` 什么都不做。
- `wake()`（`powerMonitor` 的 `resume`）：有进行中的尝试（`connecting` 有值）就什么都不做，正在连的那次就是要的；否则对 `connecting`、`reconnecting` 清定时器、`seq++`、马上 `open`。对 `ready` 不做事，死连接由 D2 的 30 秒保活发现。
- 内部的 `reconnectNow()`：清这一台的 `problems`、`failure`、`disabledAt`，`phase = 'connecting'`，`attempt = 0`，`connecting?.abort()`、`seq++`、清定时器，`open`。只给"添加"里的重新配对用（第 7 步），不受 `retry()` 对终止码的限制。

**`expect(kind)`**：bridge 在远程会话上转发 `restartHost`、`stopHost` 前调。记 `expected = kind`，两分钟后或下次连上后清。断开时文案按它写，见 U1b。

**`setLocal`**：更新本机那一行和 `active`（本机时）的 `serverInfo`，并记下本机 `machineId`（`localMachineId`），`own_link` 要用。本机断线时，`machineId` 仍用最后一次见到的。

**添加：`inspectLink(text)`**，纯函数，不联网，按顺序检查：
1. 超过 4096 字符或 `decodePairingLink` 抛错 → `invalid_link`。`device.id` 不是 UUID 也算。
2. `invite.expiresAt <= now` → `link_expired`，名字照样回。
3. `device.id` 等于本机 `machineId` → `own_link`。
4. 已在列表里、可以修 → 允许，`repair: true`，就是重新配对。可以修指下面任一条：有问题（`problems` 或存下的 `problem`）；这次运行里 `lastFailure` 是 `key_unreadable`；`registry.openKey` 现在就抛错。`key_unreadable` 不落盘，只看存下的 `problem` 会把它当成好的，U1b 给的"重新配对"就只能得到 `already_added`。
5. 已在列表里、好好的 → `already_added`。`routesChanged` 表示链接里的地址和存的不一样。
6. 下面几条都拒：
   - `!box.available()` → `no_secure_storage`。重新配对也要钥匙串：钥匙串用不了（`key_unreadable` 的常见原因）时仍回它，U1b 的文案说明。
   - 列表状态 `newer` → `registry_newer`；`unreadable` → `registry_unreadable`。
   - 新设备会超过 32 台 → `too_many`。

链接里有邀请密钥。主进程只在内存里用它，不进日志、不进状态、不落盘。

**`add({ link, name })`**：
1. 已有 `pairing` → `failed: busy`。
2. 预览：
   - `already_added`，地址变了 → 把链接里的地址放前面，和旧地址合并后写回，回 `updated`，**不用掉邀请**。
   - `already_added`，地址没变 → `failed: already_added`。
   - 其他拒绝码 → `failed: <码>`。
3. 生成密钥 `generateKey()`，建 `pairing = { abort }`，发状态 `adding.stage = 'connecting'`。
4. 按链接里的地址顺序试，每条：
   `connect({ route, device: link.device, clientKey, pairing: { inviteId, inviteSecret, clientName: 本机设备名截到 40 字 }, signal })`。
   本机设备名取本机 `serverInfo.deviceName`，没有就用 `os.hostname()`。开始配对后，状态改成 `pairing`。失败按码处理：
   - `pairing_failed`（4007）→ 停下。`now >= expiresAt` 时回 `link_expired`，否则回 `link_used`。什么都不存。
   - `device_identity_changed` → 记下，试下一条：那个地址上不是链接里那台设备，别的地址可能是。每条都是它 → 回 `identity_changed`。
   - `rate_limited` → 停下。
   - `stage === 'pairing'`，码是 `closed` 或 `timeout`：`pairRequest` 可能已经被收下、邀请已作废，只是 `pairResult` 没回来。于是在同一条路由上**用同一把密钥、不带邀请**再连一次：
     - 连上了 → 已配对，`clientId` 用 `device.clients` 的回复里 `publicKey` 等于我方公钥的那条。
     - 回 4002 → 服务端没登记，带邀请再配一次，最多一次。
   - 其余 → 记下，试下一条。
5. 核对 `serverInfo.machineId === link.device.id`，状态改成 `checking`。
6. 写一条 `StoredDevice`：`clientKey: registry.sealKey(…)`，`routes = link.addresses`，`lastRoute` 是成功的那条，`lastKnown` 取自 `serverInfo`。`repair` 时整条替换，换新密钥、清问题。
   写失败就尽力在这条连接上 `device.revokeClient(自己)`，回 `failed: registry_write_failed`，别让对面留着一个本机已经忘了的客户端。
7. 关掉配对连接，清 `pairing`，发状态。
   - **不自动切过去。**
   - 只有 `repair` 的正好是当前设备、且它处于 `failed` 时，才用新钥匙连：调内部的 `reconnectNow()`，不调公开的 `retry()`（它对 `revoked`、`identity_changed`、`unknown_client` 什么都不做）。
8. 回 `added`。

**`cancelAdd()`**：`pairing.abort.abort()`，`add` 回 `failed: aborted`。如果 `pairRequest` 已经发出，对面可能已经登记了这把我们丢掉的钥匙，那条记录要在对面撤销（第 9 节风险）。

**`remove(id)`**（`local` 抛错）：
1. `revokedRemotely = false`。
2. 如果 `viewId === id`，`phase === 'ready'`，`mode === 'full'`：
   - 设 `removing = true`，`await withTimeout(session.client.device({ type: 'revokeClient', clientId: d.clientId }), 3_000)`。
   - 回了，或者连接以 4003 结束，都算 `revokedRemotely = true`。
3. 是当前设备 → `await switchTo('local')`。
4. `registry.remove(id)`，清 `lastIdentity`、`lastFailure`，发状态，回 `{ revokedRemotely }`。

不是当前设备、或在维护模式时，不为了撤销专门去连。U1b 会提示用户到那台设备上撤销。

**`rename(id, name)`**：只改本地名字（`deviceAliasSchema`）。`local` 抛错，这台电脑的名字由 U3 用 `device.rename` 改。

**`dispose()`**：
1. `gen++`，`connecting?.abort()`，`pairing?.abort.abort()`，清所有定时器。
2. `session?.link.close()`。
3. 等进行中的 `open`、`add` 结束，最多 2 秒。
4. 之后 `switchTo` 等调用都抛 `disposed`。

dispose 后不发任何事件，测试核 `vi.getTimerCount() === 0`。

### 4.5 `DT/bridge.ts`

签名改成 `installBridge(owner, window, paths, actions, devices: DeviceConnections)`。`DesktopBridge` 加：
- `localOwner(): AttachedDaemon | null`
- `onLocalOwner(listener: (owner: AttachedDaemon) => void): () => void`
  - 每次新的本机连接就绪后调用一次，参数就是它（非空）。看本机、看远程两条路都调（见下面 `replaceOwner` 第 4 步）。
  - 本机断开时不调：这时 `localOwner()` 回 `null`，断线照旧由 `localLost` 和 `main.ts` 处理。
  - 订阅者抛错只记日志，不影响别的订阅者和 `replaceOwner`。
  - U4 照这个签名用（U4 计划 4.4），不另定。
- `deferLocalLost(): boolean`
- `viewId(): ViewId`

状态：
- `activeOwner` 改名 `localOwner`，生命周期和今天一样。
- 新增 `view: { kind: 'local' } | { kind: 'remote'; session: ViewSession } | { kind: 'waiting'; id: string }`。
- 今天的一个 `binding` 拆开：
  - `localWatch`：本机连接的订阅（`watchLocal`，见下），只跟着 `localOwner` 换；
  - `viewBinding`：正在看的那条的绑定，可以为空；
  - `replaceOwner` 的候选绑定只在 `replaceOwner` 里，确认视图仍是本机才放进 `viewBinding`。
- 新增 `viewSeq`（每次 `onView` 加一）、`localGen`（每次 `replaceOwner` 开始时加一）、`localLostPending`。`replacing` 照旧。

两类订阅分开：
- `watchLocal(owner)`：只要有本机连接就订着，不管正在看哪台。
  - `owner.client.onError`：收到 `ConnectionError` 就走 `localLost(error, owner)`，即今天 `onError` 里的那一支。
  - `owner.client.onDevice`：发 `{ type: 'localDevice', value }`，U3 的"新设备已配对"提示用它。
  - `replaceOwner` 成功和 `dispose` 时换掉、退订。
- `bind(target, paused)`：和今天一样，只是对象换成"正在看的那条"。`target = { view: ViewId; client: VonvonClient }`。
  - 发出的 `snapshot`、`log`、`backendInstall`、`device` 事件都带 `view` 字段（4.6）。
  - 发事件的条件从今天的 `activeOwner === current` 改成"`viewBinding` 就是这份绑定，而且没暂停"。换下来的、过期的绑定即使还没退订完，也发不出东西。
  - 它的 `onError` 只转发非连接错误。远程的 `ConnectionError` 交给 `connections` 处理，不发给界面，也不弹窗。

`localLost(error, from)`：
1. `from !== localOwner` → 忽略。
2. `isExpectedDisconnect()` 或 `recoverConnection(from.identity)` 接了 → 返回。
3. 否则 `devices.setLocal({ status: 'offline' })`。
   - 正在看本机：和今天一样，发 `error` 事件，再 `connectionLost()`。
   - 正在看远程：设 `localLostPending = true`，等切回本机时再弹。

`deferLocalLost()` 给 `main.ts` 用：正在看远程时设 `localLostPending` 并返回 `true`，本机时返回 `false`。

`devices.onView(change)`：
1. `const seq = ++viewSeq`；`viewBinding?.dispose()`，`viewBinding = null`。
2. 按 `change.kind` 处理：
   - `local`：
     - `view = local`。
     - `replacing` 进行中：到此为止。`replaceOwner` 收尾时看到视图是本机，会发 `reattached` 并激活新连接（下面第 5 步）。
     - 有 `localOwner`：记下 `owner = localOwner`、`gen = localGen`；`b = bind(local, true)`，`viewBinding = b`（暂停着，不发）；`await owner.client.snapshot()`；然后 `seq === viewSeq` 且 `gen === localGen` 才 `send({ type: 'reattached', view: 'local' })` 并 `b.activate`，否则 `b.dispose()`、退出。顺序和 `replaceOwner` 一样。
     - 没有 `localOwner`：只发 `reattached`；`localLostPending` 为真时清标记，`actions.connectionLost()`。
   - `remote`：
     - `view = remote`。
     - `mode === 'full'`：`b = bind(session, true)`，`viewBinding = b`，`await session.client.snapshot()`，`seq` 没变才 `send({ type: 'reattached', view: id })` 并 `activate`。
     - `maintenance`：不订快照，维护连接不推快照，`snapshot` 也不在维护子集里，只发 `reattached`。
     - `snapshot` 失败（刚连上又断）就丢掉，`connections` 会再发 `waiting`。
   - `waiting`：`view = waiting`，不绑定。页面留着旧快照，U1b 显示重连条，请求回 `device_unavailable`。
3. 每个 `await` 之后 `seq !== viewSeq` 就 dispose 刚建的绑定、退出。A → B → 本机连着切时，只有最后一次生效。

`client()`：
- `local`：同今天。
- `remote`：返回 `session.client`。
- `waiting`：抛 `DeviceUnavailable`，文字"还没连上「<名字>」。"，`safeFailure` 归为 `{ kind: 'connection', code: 'device_unavailable' }`。

各通道在远程时：
- `run`：`restartHost` 先 `devices.expect('restart')`，再 `client().run(value)`。不走 `actions.restartHost`，那条路等的是本机 pid 锁。
- `machine`：
  - 解析：D1 分支的外壳专属检查（`desktopShellRequestSchema` 命中就抛 `Shell-owned machine action`）改成看视图：
    - 看本机：照旧，全部拦下。
    - 看远程（`view.kind === 'remote'`）：只放行 `service` 的 `install`、`uninstall`（对面的登录时启动开关，U2 4.4.3 的 `toggleService` 在远程时 shell 没有 `setLoginItem`，就发这个）。转发前先 `devices.expect('restart')`：daemon 回完就被助手换掉（I3 分支 `rpc/machine.ts:75-81`），断开显示成"正在重启"，不算连不上。
    - 看远程时其余命中的（`startHost`、`service start/stop`、`repairCli`、两项桌面更新）照旧拦：它们由外壳做，只对这台电脑有意义。
    - `waiting` 时照 `client()` 回 `device_unavailable`。
  - `stopHost` 先 `devices.expect('stop')`，再直接转发。
  - `status` 原样返回对面的回复：不套 `stoppedStatus`，不用 `observeCli` 覆盖，`lastStatus` 只记本机的。
- `close`：远程时什么都不做。不能从远程视图 dispose 本机连接。
- 不论看哪台，页面发来的 `admin.negotiate` 一律不转发，抛 `LocalOnlyRefusal`，文字"能力由桌面端自己声明。"一条连接只认第一次 `negotiate`，U4 要在本机主连接上声明 `desktop.self-update`（U4 计划 4.4），页面不能抢先。
- 只对本机有效的六个通道——`startHost`、`service`、`setLoginItem`、`repairCli`、`chooseExecutablePath`、`chooseDirectoryPaths`——在 `view` 不是本机时抛 `LocalOnlyRefusal`。U2 加的 `quitKeepsDaemon`（退出时停不停本机服务端，U2 计划 4.7）同样只对本机有效，由 U2 加进这一组。这里说的 `service` 是外壳自己的 `desktop:shell:service` 通道，和上面 `machine` 通道里转给对面的 `service` 不是一回事。
  - `safeFailure` 映射成 `{ kind: 'validation', code: 'local_only', message: '现在看的是「<名字>」，这个操作只对这台电脑有效。先切回这台电脑。' }`。
  - 这是第二道防线，U2 会把入口藏起来。

`replaceOwner(next)`：看哪台都走同一条路，每个 `await` 之后按**此刻的** `view` 决定发不发：
1. `localGen++`；`localWatch` 退订；视图是本机时 `viewBinding?.dispose()`、`viewBinding = null`（远程的绑定不动）。
2. `previous = localOwner`，`localOwner = null`，`await previous?.dispose()`，失败照今天抛。
3. `candidate = bind({ view: 'local', client: next.client }, true)`，不放进 `viewBinding`；`initial = await next.client.snapshot()`；连接失败照今天：`candidate.dispose()`、`next.dispose()`、抛。
4. `localOwner = next`，`watchLocal(next)`，`stoppedStatus = undefined`，`connectionLost = false`，`devices.setLocal({ status: 'online', serverInfo: next.serverInfo })`，通知 `onLocalOwner` 的订阅者。两种视图都走这一步：U4 靠它在每条新的本机连接上重新声明 `desktop.self-update`，本机 daemon 重启或升级后也一样。
5. 再看 `view`：
   - 本机：`viewBinding = candidate`，`send({ type: 'reattached', view: 'local' })`，`candidate.activate(initial)`。顺序和今天一样。
   - 远程或 `waiting`：`candidate.dispose()`，**不发 `reattached`，不发快照**。以后切回本机，由 `onView(local)` 用 `localOwner`（就是 `next`）重新绑定。

和切换交错时：
- 看远程时 `replaceOwner` 在等快照，用户切回本机：`onView(local)` 看到 `replacing`，不绑；`replaceOwner` 第 5 步看到视图已是本机，发 `reattached{local}` 和 `next` 的快照。
- 看本机时 `replaceOwner` 在等快照，用户切到远程：`onView(remote)` 绑远程、发 `reattached{B}`；`replaceOwner` 第 5 步看到视图是远程，丢掉候选，什么都不发。
- `onView(local)` 正在等旧本机连接的快照，`replaceOwner` 开始：第 1 步 dispose 了 `viewBinding`（就是那份 `b`），`localGen` 也变了，`onView` 醒来后直接退出，旧连接的快照不发；之后同第一种。
- 所以渲染端在 `reattached{view: X}` 之后收到的快照只来自 X 的连接。
- `replaceOwner` 失败：照今天抛，`main.ts` 按今天的路径处理断线；视图此刻是本机时 `deferLocalLost()` 回假，照常弹。

`subscribe`：在今天的重放之后，再发 `{ type: 'devices', value: devices.state() }`。另外订 `devices.onState` 一次，之后每次变化都发 `{ type: 'devices', value }`。

`dispose`：先退订 `devices`，再按今天的顺序收尾。`devices.dispose()` 由 `main.ts` 的 `cleanup` 在它之前调用（4.8）。

### 4.6 IPC、facade、preload：请求带上"给哪台"

`DT/ipc-contract.ts`：
- `desktopChannels` 加 `devicesState: 'desktop:devices:state'`、`devicesInspect`、`devicesAdd`、`devicesCancelAdd`、`devicesRename`、`devicesRemove`、`devicesSwitch`、`devicesRetry`，前缀都是 `desktop:devices:`。
- `DesktopEvent` 改成：

```ts
| { type: 'reattached'; view: ViewId }
| { type: 'snapshot'; view: ViewId; value: DesktopSnapshot }
| { type: 'log'; view: ViewId; value: LogEventPayload }
| { type: 'backendInstall'; view: ViewId; value: BackendInstallEventPayload }
| { type: 'device'; view: ViewId; value: DeviceEventPayload }
| { type: 'localDevice'; value: DeviceEventPayload }
| { type: 'devices'; value: DevicesState }
| 原来的 update / error / quitRequested
```

**发给 daemon 的通道都多带一个参数**：最后一个参数是调用方所属的 `ViewId`，或者 `'current'`。这些通道是 snapshot、run、settings、collaboration、environment、machine、admin、memory、contextPreview、directory、library、schedule、device、close。
- bridge 用 `registerClient(channel, arity, parse, invoke)` 注册它们：要求 `arity + 1` 个参数，最后一个过 `viewIdSchema.or(z.literal('current'))`。
- 不是 `'current'`，又不等于此刻的 `viewId()` → 回 `{ ok: false, error: { kind: 'connection', code: 'device_switched', message: '已经切到另一台设备，这次操作没有发出。' } }`。
- 这样一个页面实例只能操作它挂载时那台设备，切换瞬间的旧请求不会落到新设备上。
- 外壳通道（`startHost` 这一类、桌面端更新、`hide`、`quit`、`external`、`desktop:devices:*`）不带这个参数。

`DT/facade.ts`：
- 内部改成 `makeClient(view: ViewId | 'current')`。
  - 每个绑定的 client 调用时在最后附上自己的 `view`。
  - 只收 `view` 等于自己的事件；`'current'` 收全部。
  - 各自记自己的 `connectionEpoch`：`reattached` 的 `view` 等于自己时才加一（`'current'` 见到任何一个都加）。
  - 各自有 `clientClosed`。
- `createDesktopFacades` 仍回 `{ client, shell }`。`client` 是绑定 `'current'` 的那个，给旧代码和测试用。
- `shell.devices` 是一个 `DevicesShell`（4.7）：
  - `clientFor(view)` 按 `view` 缓存。
  - `onState` 订阅时先给最近一次状态，和 `onDesktopUpdate` 一样。
  - 其余八个方法各调一个通道，回复用 4.1 的 schema 解析。
- `shell.onLocalDeviceEvent(listener)` 收 `localDevice` 事件。
- `onEvent` 认新的事件形状，每种都用 schema 解析；解析失败照旧发 `Invalid desktop event`。

`DT/preload.ts`：不变，仍暴露 `vonvonClient` 和 `vonvonShell`。`contextBridge` 能代理函数返回的、带函数的对象，所以 `shell.devices.clientFor(view)` 返回的 client 在页面里能用。

`CL/client.ts`：`VonvonClient` 加 `onDevice(listener: (event: DeviceEventPayload) => void): () => void`，事件分发 126-130 加 `case "device"`。改的是 D1 加的那份。

### 4.7 `U/client-context.tsx`

```ts
export type DevicesShell = {
  state(): Promise<DevicesState>; onState(listener: (state: DevicesState) => void): () => void;
  clientFor(view: string): VonvonClient;
  inspect(link: string): Promise<LinkPreview>; add(request: AddDeviceRequest): Promise<AddDeviceResult>; cancelAdd(): Promise<void>;
  rename(id: string, name: string): Promise<void>; remove(id: string): Promise<RemoveDeviceResult>;
  switchTo(id: string): Promise<void>; retry(): Promise<void>;
};
// ShellCapabilities 加：devices?: DevicesShell; onLocalDeviceEvent?: (listener: (event: DeviceEventPayload) => void) => () => void;
export type ActiveDevice = {
  id: string; isRemote: boolean; name: string; platform?: string;
  mode: 'full' | 'maintenance'; version?: string; capabilities: readonly string[];
};
export const LOCAL_ACTIVE_DEVICE: ActiveDevice;      // { id: 'local', isRemote: false, name: '这台电脑', mode: 'full', capabilities: [] }
export function activeDeviceFrom(state: DevicesState): ActiveDevice;   // 名字取行的 name；platform/version/capabilities 取 active.serverInfo，缺了取行上的
export function ClientProvider(props: { client: VonvonClient; shell?: ShellCapabilities; device?: ActiveDevice; devices?: DevicesState; children: ReactNode }): JSX.Element;
export function useActiveDevice(): ActiveDevice;     // 没给时是 LOCAL_ACTIVE_DEVICE（网页端）
export function useDevicesState(): DevicesState | undefined;
export function deviceCopyName(device: Pick<ActiveDevice, 'isRemote' | 'name'>): string;   // 远程"「名字」"，本机"这台电脑"
export function shellForDevice(shell: ShellCapabilities | undefined, device: ActiveDevice): ShellCapabilities | undefined;
```

`shellForDevice` 在远程时去掉 `chooseExecutablePath`、`chooseDirectoryPaths`、`setLoginItem`、`service`、`startHost`、`repairCli`，其余原样。U2 加 `quitKeepsDaemon` 时一起加进去掉的名单；U4 加的 `onRemoteUpdate` 说的是这台电脑，不去掉。设计 6.4 表里"原生目录对话框在远程模式不暴露"因此一并做到：`directory-picker.tsx:107` 拿不到 `chooseDirectoryPaths`，就走 daemon 侧目录浏览器。U2 只需改它的标题和 Windows 路径输入。

`useClient()` 不变，返回 context 里的 client，就是 U1b 用 `clientFor(active.id)` 传进来的那个。**U2–U4 只用这几个 hook，不直接碰 `window.vonvonShell.devices`。**

### 4.8 `DT/main.ts`

1. `attachExisting` 之后（283 后）、`installBridge` 之前：
   - `registry = await openDeviceRegistry(join(app.getPath('userData'), 'devices.json'), electronSecretBox(safeStorage))`。
   - `devices = createDeviceConnections({ registry, connector: secureConnector(), box, client: { version: app.getVersion(), protocolVersion: PROTOCOL_VERSION }, log })`。
   - 桌面端今天没有自己的日志文件，只有 daemon 的 `daemon.log`（`daemon-dependencies.ts:48`）。`log` 写 `userData/devices.log`：0600，追加；超过 1 MB 就改名为 `devices.log.1`，覆盖旧的。只按 4.4 的字段记。
   - `devices.setLocal({ status: 'online', serverInfo: owner.serverInfo })`。
2. `installBridge(owner, current, paths, actions, devices)`。
3. `powerMonitor.on('resume', onResume)`，`onResume = () => devices.wake()`；`cleanup` 里移除。
4. `cleanup` 在 `await starting` 之后、`bridge.dispose()` 之前 `await devices.dispose()`。远程连接先关，退出时就不会再触发重连定时器。退出桌面端不碰对面的 daemon（设计 6.4"退出桌面端"一行）。
5. `recoverConnection` 的两处 `showConnectionLost()`（541、549）改成 `if (!bridge?.deferLocalLost()) showConnectionLost();`。
6. 本机生命周期里的 `setLocal`：`stopHost`、`service stop` 写 `stoppedStatus` 时 `offline`，`startHost` 开始时 `connecting`。`replaceOwner` 成功时 bridge 自己会调。
7. `confirmQuit`、`beforeUpdateInstall`、托盘：不改。主进程发 `quitRequested` 的路径不变；今天只有 `App` 里订了它，连接页、加载页、维护页不渲染 `App`，那时按 Cmd+Q 没人回应。这个由 U1b 4.1 的 `OutsideWindow`（里面订退出）补上，本片不动主进程。退出确认的文字说的是本机，U2 再看远程时要不要改。U2 计划 4.7 的结论：退出没有确认框，`confirmQuit` 不改；只改"应用与启动"页的页脚，远程时写"退出这台电脑上的 Vonvon Bot 不影响「X」"。

### 4.9 顺序

1. 4.1 和 `CL` 的 `onDevice`。
2. 4.2 加测试。
3. 4.3 用假 `ws` 服务器测；D2 没合入时 `secureConnector` 先留空实现，只跑假连接器的测试。
4. 4.4 用假连接器、假时钟测。
5. 4.5 和 4.6 加 bridge、facade 测试。
6. 4.7、4.8。
7. 接 D2，跑 4.3 的真通道测试。
8. U1b。
9. D3 合入后跑第 6 节的探针，再发 Mac 验收。

## 5. 测试

全部在 `packages/desktop/test/` 和 `packages/ui/test/`，用 vitest。"main 必败"指今天的集成分支上会失败，多半因为模块或行为还不存在。

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `device-registry.test.ts`（新，mktemp 目录，假 `SecretBox`） | 往返 | `put` 两台 → 重新 `openDeviceRegistry` 读回一样；文件 mode 0600；文件里搜不到私钥明文。main 必败 |
| 同上 | 并发写 | `update(a, 改名)` 和 `update(a, lastConnectedAt)` 同时发 → 读回两项都在 |
| 同上 | 坏文件 | 写 `{` → `status: 'recovered'`、列表空、目录里多一个 `devices.json.broken-*` |
| 同上 | 新版本文件 | `{ v: 2, devices: [合法一台, 坏一台] }` → `newer`、读出一台、`put` 抛 `registry_newer` |
| 同上 | 钥匙串 | 假 box 的 `open` 抛错 → `openKey` 抛 `key_unreadable`，列表照常；`available()` 为假 → 同上 |
| 同上 | 上限 | 第 33 台 `put` 抛 `too_many` |
| `remote-transport.test.ts`（新，本机 `ws` 服务器 + D2 的 `createResponder` 搭假服务端，见下面的 helper） | URL | `{ host: 'fd7a:115c:a1e0::1', port: 7767 }` → `ws://[fd7a:115c:a1e0::1]:7767/` |
| 同上 | 不发 Origin | 假服务端记下请求头 → 没有 `origin`，`host` 等于 `127.0.0.1:<port>` |
| 同上 | 403 | 假服务端 `verifyClient` 回 403 → `RemoteConnectError('forbidden', 'socket')`，`httpStatus: 403` |
| 同上 | 拒绝 | 连一个刚关掉的端口 → `refused`，`sysCode: 'ECONNREFUSED'` |
| 同上 | 取消 | 假服务端接了连接不回消息 2，50 ms 后 `abort()` → `aborted`，服务端看到连接关闭 |
| 同上 | 配对 + 撤销 | 带邀请连 → `pairResult.clientId`；之后服务端 `close(4003)` → `closed` 在 50 ms 内以 `client_revoked` resolve；`client.onError` 收到 `ConnectionError` 且 `instanceof` 的是 `@vonvon/client/browser` 的类。main 必败 |
| 同上 | 4006 | 服务端 `close(4006)` → `remote_disabled` |
| `connections.test.ts`（新，假连接器 + 假时钟） | 切换 | `switchTo(A)` → 先 `waiting`，假连接成功后 `remote(opened)`、状态 `ready/full`；`switchTo('local')` → 链接被 `close()`、`local`。main 必败 |
| 同上 | 路由顺序 | A 的 `routes [r1, r2]`、`lastRoute r2` → 尝试顺序 r2, r1；r2 `refused`、r1 成功 → `lastRoute` 变 r1 |
| 同上 | 退避 | 每次都 `unreachable` → 相邻两次尝试的间隔依次 1000、2000、4000、8000、16000、30000、30000 |
| 同上 | 限流 | `rate_limited` → 下一次在 60000 ms 后，不早于 |
| 同上 | 快速切换 | `switchTo(A)`、A 还没连上就 `switchTo(B)`、再 `switchTo('local')`；随后让 A、B 的假连接都成功 → A、B 的链接都被 `close()`；没有发出 `remote`；最后 `view()` 是 `local`；任何时刻打开的链接不超过 2 条 |
| 同上 | 撤销 | `ready` 时假链接以 `client_revoked` 结束 → **同一个微任务轮次内**状态 `failed`、行 `revoked`（读内存的 `problems`）；`vi.getTimerCount() === 0`；`await` 落盘后 `registry.get(A).problem.code === 'revoked'`；再 `retry()` 不发起连接。main 必败 |
| 同上 | 撤销：错误先到 | 假链接先发 `ConnectionError`，下一个微任务才以 `client_revoked` settle `closed` → 状态是 `revoked`，不是 `reconnecting`；没有排重连 |
| 同上 | 撤销后修复 | A 是当前设备、`revoked` → 粘 A 的新链接 `inspectLink` 回 `repair: true`，`add` 成功后立刻用新钥匙连（没走 `retry()`）→ `ready` |
| 同上 | 身份变了 | 连上但 `serverInfo.machineId` 不是 A → 链接被关、`failed`、`identity_changed` 落盘 |
| 同上 | 某个地址上是别的机器 | `routes [r1, r2]`，r1 回 `device_identity_changed`、r2 成功 → `ready`，`lastRoute` 是 r2，没有落盘问题；两条都回它 → `identity_changed` 落盘 |
| 同上 | 4006 后恢复 | `remote_disabled` → `reconnecting`、1 s 后重试；第二次成功 → `ready`、`cause: 'reopened'`（pid、startedAt 没变） |
| 同上 | 4006 记住 | `remote_disabled` 后连续两次 `refused` → `active.disabledAt` 还在，`failure.code` 是 `refused`；再连上 → `disabledAt` 清掉 |
| 同上 | 429 | `unexpected-response` 429 → `rate_limited`，下一次不早于 60000 ms |
| 同上 | 重启 | 断开后重连，`daemonStatus` 的 `startedAt` 变了 → `cause: 'restarted'`、`notice.kind === 'restarted'`；先 `expect('restart')` 再断 → 没有 `notice`、断开期间 `expected === 'restart'` |
| 同上 | 升级 | 重连后 `serverInfo.version` 从 0.9.0 变 0.9.1 → `notice: { kind: 'updated', from: '0.9.0', to: '0.9.1' }`，`lastKnown.version` 落盘 |
| 同上 | 维护 | `serverInfo.protocolVersion` 3 → `mode: 'maintenance'`、行 `maintenance` |
| 同上 | 钥匙读不出 | `openKey` 抛 → `failed`、`key_unreadable` 不落盘；`retry()` 再试一次；这时粘同一台的新链接 → `inspectLink` 回 `repair: true`，不是 `already_added` |
| 同上 | 失败后切走再切回 | A `failed`（`unreachable`）→ `switchTo('local')` → `switchTo(A)` 的第一条状态是 `connecting`、没有 `failure` |
| 同上 | 退出时正在连 | 假连接挂着时 `dispose()` → 2 s 内 resolve；之后再让假连接成功 → 链接被关、没有事件；`vi.getTimerCount() === 0` |
| 同上 | 唤醒 | `reconnecting` 且下一次在 16 s 后，`wake()` → 立刻重试；尝试进行中时 `wake()` → 不新发起 |
| 同上 | 重试换掉旧尝试 | `connecting` 时 `retry()` → 旧尝试的 `signal` 被 abort；之后旧尝试成功 → 链接被关、没有事件；打开的链接不超过 2 条 |
| 同上 | 添加：各种拒绝 | 坏字符串 → `invalid_link`；过期 → `link_expired`；`device.id` 等于本机 → `own_link`；已加过 → `already_added`（地址变了时 `add` 回 `updated` 且没调 `connect`）；`available()` 假 → `no_secure_storage` |
| 同上 | 添加：成功 | 合法链接 → 用新生成的公钥连、带 `pairing`、`clientName` 是本机名截到 40 字；`put` 的条目里 `clientId` 来自 `pairResult`、`secretKeySealed` 是 box 加密的；没有切换；配对链接已关 |
| 同上 | 添加：链接用过 | 假连接抛 `pairing_failed` → `failed: link_used`，`registry.list()` 不变 |
| 同上 | 添加：配对中途断 | 第一次抛 `closed`（stage `pairing`）；第二次（无 `pairing`）成功，`device.clients` 回含我方公钥的一条 → `added`，`clientId` 是那一条的 id |
| 同上 | 添加：并发 | 第一个 `add` 挂着时第二个 → `failed: busy` |
| 同上 | 添加：取消 | `cancelAdd()` → `failed: aborted`，不写列表 |
| 同上 | 删除当前设备 | `ready/full` 时 `remove(A)` → 先发 `device.revokeClient(自己的 clientId)`，回 `revokedRemotely: true`；随后链接以 4003 结束**不**把状态变成 `revoked`；`view()` 是 `local`；列表里没有 A |
| 同上 | 删除非当前设备 | → 不调 `connect`，`revokedRemotely: false` |
| `bridge.test.ts`（改，沿用 mock electron 的写法） | 路由 | 看远程时 `settings` 请求到远程假 client，本机假 client 没收到。main 必败 |
| 同上 | 旧页面的请求 | 视图已切到 B，带 `view: A` 的 `settings` → `device_switched`，两边都没收到。main 必败 |
| 同上 | 本机专属 | 看远程时 `startHost`、`service`、`setLoginItem`、`repairCli`、`chooseDirectoryPaths`、`chooseExecutablePath` → `local_only`，`actions.*` 没被调 |
| 同上 | 远程重启、停止 | 看远程时 `run(restartHost)` → `devices.expect('restart')` 后转发，`actions.restartHost` 没被调；`machine(status)` 回远程原样，不带 `observeCli` 的覆盖 |
| 同上 | 换设备发 `reattached` | 本机快照 revision 50，切到 B 后 B 的快照 revision 3 → 先发 `reattached{view:B}`，再发 `snapshot{view:B, revision 3}`。main 必败 |
| 同上 | 远程的服务开关 | 看远程 A 时 `machine {type:'service', action:'install'}` → 先 `devices.expect('restart')`，A 的假 client 收到这条，本机假 client 没收到。看本机时同一条 → `Shell-owned machine action`，两边都没收到。看远程时 `machine {type:'repairCli'}`、`{type:'service', action:'start'}` → 仍是 `Shell-owned machine action`。main 必败 |
| 同上 | 看远程时本机换连接 | `replaceOwner(next)` → 没发 `reattached`、没发本机快照；`localOwner()` 是 next；`onLocalOwner` 收到 next；切回本机 → 发 `reattached{view:'local'}` 和 next 的快照 |
| 同上 | 看本机时本机换连接 | `replaceOwner(next)` → 发 `reattached{view:'local'}` 和 next 的快照；`onLocalOwner` 也收到 next（U4 靠它重新声明能力）。main 必败 |
| 同上 | 交错一：看远程 B，换连接中切回本机 | `replaceOwner(next)` 的快照挂着时 `onView(local)`，再放行快照 → 渲染端依次收到 `reattached{view:'local'}`、next 的快照，各一次；`reattached{local}` 之后没有 B 的快照 |
| 同上 | 交错二：看本机，换连接中切到 B | `replaceOwner(next)` 的快照挂着时 `onView(remote B)` 完成，再放行 next 的快照 → 渲染端最后一条 `reattached` 是 `{view:'B'}`，之后只有 B 的快照，没有 `reattached{local}`、没有 next 的快照；`localOwner()` 是 next，`onLocalOwner` 收到 next |
| 同上 | 交错三：切回本机等快照时本机换连接 | `onView(local)` 等旧本机连接的快照时 `replaceOwner(next)` 完成，再放行旧快照 → 旧连接的快照没发出去；`reattached{local}` 只一次，之后是 next 的快照 |
| 同上 | 交错的共同断言 | 上面三例里，渲染端每条 `snapshot` 的 `view` 都等于它前面最近一条 `reattached` 的 `view`，值也来自那台的假 client |
| 同上 | 看远程时本机断了 | 本机假 client 报 `ConnectionError`、`recoverConnection` 回假 → `connectionLost` 没调；切回本机后调一次 |
| 同上 | 远程断了不弹窗 | 远程假 client 报 `ConnectionError` → 不发 `error`、不调 `connectionLost` |
| 同上 | 本机设备事件 | 看远程时本机 client 发 `device` 事件 → 发 `localDevice` |
| 同上 | 订阅重放 | `subscribe` → 收到一条 `devices` |
| `facade.test.ts`（改） | 按设备过滤 | `clientFor('A').watchSnapshots` 只收 `view: 'A'` 的快照；`reattached{view:'B'}` 不清 A 的 revision；调用时最后一个参数是 `'A'`。main 必败 |
| 同上 | 状态订阅 | 先来 `devices` 事件、后订 `onState` → 立刻收到；坏形状 → `Invalid desktop event` |
| `ui/test/client-context.test.tsx`（改） | 默认本机 | 不给 `device` → `useActiveDevice().isRemote === false`、`deviceCopyName` 是"这台电脑" |
| 同上 | 远程 shell | `shellForDevice(shell, 远程)` 没有那六项，`openExternal`、`devices` 还在 |
| 同上 | 状态换算 | `activeDeviceFrom(状态)`：远程 ready 取 `serverInfo.platform/capabilities`；`connecting` 时取行上的 `platform` |

测试 helper `packages/desktop/test/helpers/fake-secure-server.ts`：`ws` 的 `WebSocketServer` 绑 `127.0.0.1:0`。它用 D2 的 `createResponder` 做 IK，认得配对，能回 `pairResult`、v2 的 `serverInfo`、`admin.daemonStatus`、`device.clients`、`device.revokeClient`，还能按需 `close(code)`。只用到 D2 公开导出的东西。

## 6. 自测和验收

U1a 和 U1b 是一个 PR，Mac 上只发一次验收，写在 U1b 第 6 节。U1a 的模块由 Claude 在 JP-VPS 上无头验证。

**删除文件的硬规矩**（`~/.claude/CLAUDE.md`，原样照抄）：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

1. 单测：
   `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/desktop/test/device-registry.test.ts packages/desktop/test/remote-transport.test.ts packages/desktop/test/connections.test.ts packages/desktop/test/bridge.test.ts packages/desktop/test/facade.test.ts`
   `HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npm test -w packages/ui -- test/client-context.test.tsx`
   根目录的 `vitest.config.ts` 只收 `*.test.ts`，`.tsx` 的界面测试要在 ui 包里跑（它用默认的 include）。
   然后在 `flock /tmp/vonvon-heavy.lock` 下跑 protocol、client、desktop、ui 的 `typecheck`、`lint`、`build`。最后 `rm -rf -- "${T:?}"`。
2. 真通道探针 `packages/desktop/test/manual/devices-probe.ts`：进 git；`test/manual/` 不在 vitest include 里；跑法同 D2 的 `secure-probe.ts`。
   - 环境：在 mktemp 的 HOME 和 VONVON_HOME 下起一个临时 daemon，`vonvon remote port 17767`，`vonvon remote enable --tailscale`。不碰 Paseo、验收数据目录、`~/.vonvon-bot`。
   - 探针用 `openDeviceRegistry`（临时目录，测试用的明文 `SecretBox`，只在 `test/helpers` 里）、`secureConnector()` 和 `createDeviceConnections`。依次：
     1. 用 `vonvon pair --json` 的链接 `add`。
     2. `switchTo` 后打印 `admin.daemonStatus` 和快照里 bot 数。
     3. 另一个终端 `vonvon clients revoke <id>`：打印从命令返回到状态变成 `revoked` 的毫秒数，要小于 1000。
     4. 再配一次；`remote disable` 后状态是 `reconnecting`、码 `remote_disabled`；`remote enable` 后 45 秒内回到 `ready`（退避最长 30 秒，加上一次连接最多 10 秒）。
     5. `daemon restart` → `cause: 'restarted'`。
     6. `remove` → `revokedRemotely: true`，`clients ls` 那条带 `revokedAt`。
   - 两个进程都用 `HOME=$T/home VONVON_HOME=$T/vh` 前缀，结束 `rm -rf -- "${T:?}"`。PR 里贴脱敏的输出，不贴地址和链接。

## 7. 文档

- `docs/plans/devices.md`，已在本计划的 PR 里改：
  - 6.1"存哪"改成"只有每台的客户端私钥用 `safeStorage` 加密，列表本身不加密、0600"，写了原因（4.2）。
  - 第 13 节 U1a、U1b 两行和一段说明：合成一个 PR、行数、维护视图挪进 U1b。
- `docs/plans/devices-2-secure-channel.md` 4.2 末尾：本片要的三处补充（4.3），已在本计划的 PR 里加。
- `docs/product.md` 3.14 不用改，`product.md` 的改动见 U1b 第 7 节。
- 这一批不在 `docs/v1-plan.md` 里打勾，进度看设计第 13 节。合入时在 U1a 行标"已合入"。

## 8. 验收要点

1. `P/desktop-devices.ts` 只 import zod 和 `P/` 里的 schema；`P/index.ts` 没有导出 `secure-channel`，D2 若导出了，本片改成子路径。
2. `devices.json` 里没有私钥明文；文件 0600；写入是"临时文件 + rename"，并且串行。
3. 打开列表失败不会让 app 起不来，`openDeviceRegistry` 没有会抛出的路径。
4. 远程只走 `ws` + `connectSecure`，`ws` 不设 `origin`；连接码齐全，每条路由 10 秒封顶，`signal` 能打断。protocol、client 的 `package.json` `exports` 有新的子路径。
5. 任何时刻最多两条远程连接（当前一条，配对一条），测试里有断言。
6. 每个 `await` 之后都核对 `gen` 和 `seq`，过期的连接结果会被关掉，不发事件；`retry()` 会 abort 进行中的尝试，`wake()` 遇到进行中的尝试不重复发起。
7. 4003 在同一个回调里变成 `revoked`（内存 `problems` 同步写，落盘异步），不留定时器；`closed` 只看 D2 的 `SecureConnection.closed`，`ConnectionError` 只作 250 ms 后的兜底；终止码不再自动重试。
   - 4005 按路由处理，只有每条路由都回它才是设备级的 `identity_changed`。
   - `key_unreadable` 或有问题的设备可以用新链接重新配对，当前设备修好后走内部的 `reconnectNow()`。
   - 4006 记下 `disabledAt`，之后的 `refused` 不盖掉它；`switchTo` 清 `failure`、`disabledAt`、`expected`、`notice`。
8. 退避是 1、2、4、8、16、30 秒，`rate_limited`（含 HTTP 429）至少 60 秒，`resume` 会重置。
9. 添加时邀请密钥不进日志、状态和文件；`link_used` 什么都不存；不自动切过去。
10. 删除当前设备会先自撤销（3 秒），4003 不当"被撤销"；删除非当前设备不联网。
11. 发给 daemon 的通道都带 `view`，不匹配的回 `device_switched`；外壳通道不带。
12. 换设备发 `reattached{view}`，而且在第一份快照之前。
13. 看远程时本机换连接不发 `reattached`；本机断线的弹窗推迟到切回本机时。`onLocalOwner` 在看本机、看远程时都会触发。`replaceOwner` 和切换交错时，`reattached{X}` 之后只有 X 的快照：每个 `await` 之后按此刻的视图决定发不发，`onView(local)` 还要核对 `localGen`。
14. 远程视图下 `machine.service install/uninstall` 先 `expect('restart')` 再转给对面；本机视图照旧按外壳专属拦下，远程视图的其他外壳专属请求也拦。
15. 远程时六个本机专属操作在主进程被拒；`shellForDevice` 去掉同样的六项。
16. `cleanup` 先 `devices.dispose()` 再 `bridge.dispose()`；退出不碰远程 daemon。
17. 日志只有设备 id 前 8 位、事件、码、时间。
18. diff 里没有真实 id、密钥、本机路径和地址；示例地址只用文档段（`203.0.113.x`、`fd7a:115c:a1e0::1` 这类）。

## 9. 风险和行数

- 估计约 1,950 行：
  - protocol 130、registry 220、transport 200、connections 560、bridge 净增 290（本机和视图的绑定分开、交错的核对、远程的服务开关）、ipc、facade 和 preload 180、main 50、client 20、client-context 80。
  - 测试约 1,300，按上表压缩。
- 加上 U1b 约 1,500，整个 PR 约 3,450 行：
  - 超过 1,500，所以一个审查者读整个 diff，另加两位按模块读：(a) `DT/` 和 `P/desktop-devices.ts`，(b) `U/`。
  - 涉及并发、关闭顺序、错误路径，再加一轮多角度审查，每条发现先复现或驳回。
  - 没超过 5,000，不拆。
- 每次启动都从"这台电脑"开始。理由：远程设备可能离线，启动就卡在"连不上"不如先能用本机；切一次只要一下。owner 想要恢复，以后在 `devices.json` 加一个 `lastViewed` 字段和一个开关就行。
- 配对中途取消或断线、又没能确认时，对面可能留下一条这台电脑已经丢掉钥匙的客户端记录。它没法被使用，因为私钥已丢，只是列表里多一行。U1b 的失败文案让用户去对面看；U3 的"最近 24 小时新配对"也会标出来。
- `contextBridge` 代理"函数返回的对象里的函数"：依据是 Electron 文档，真机在 Mac 验收第 2 步核。不行就退回"`vonvonClient` 每个方法带 `view` 参数"，由页面自己传。
- `safeStorage` 在未签名的开发版里用的是"Electron Safe Storage"钥匙串项，Mac 验收时可能弹一次钥匙串授权（U1b 第 6 节）。
- 非当前设备的状态点只是上次的结果，可能过时。设计和 `product.md` 3.14 都定了不在后台看，文案写"上次在线 <时间>"，不写"在线"。

## 10. 审查后改了什么

2026-11-02，#640 上 Sonnet 审查（读整个 diff 一位，读 U1a+U1b 一位）。下面每条都接受了：

- `closed` 原来取 D2 的 `closed` 和 `ConnectionError` 先到的那个。`ConnectionError` 同步先到又不带关闭码，4003 会被认成普通断开去重连。改成只看 D2 的 `closed`，`ConnectionError` 只作 250 ms 后的兜底（4.3 第 6 步、第 5 节"撤销：错误先到"）。
- `retry()`、`wake()` 不换代也不 abort 进行中的尝试，两次 `open` 都能过核对，会多存一条链接。加 `seq`：`open` 每步核对 `gen` 和 `seq`；`retry()` 先 abort 再 `seq++`；`wake()` 遇到进行中的尝试不做事（4.4、第 5 节、第 8 节第 6 条）。
- `key_unreadable` 不落盘，`inspectLink` 只看存下的 `problem`，U1b 给的"重新配对"只能得到 `already_added`。可以修的条件加上 `lastFailure` 和 `openKey` 现在就抛错；钥匙串用不了仍先回 `no_secure_storage`（"添加"第 4 至 6 步）。
- 修好当前设备后调 `retry()`，可它对 `revoked` 这类码什么都不做，新钥匙用不上。改成内部的 `reconnectNow()`（4.4"重试和唤醒"、"添加"第 7 步、第 5 节"撤销后修复"）。
- 测试要求撤销后同一个微任务里 `registry.get` 已是 `revoked`，可 `registry.update` 写成才改内存。加内存的 `problems` Map，同步写，`rowStatus` 先看它；测试改成同步看状态、`await` 后看落盘（4.1、4.4、第 5 节）。
- 4006 断开后第一次重连就被 `refused` 盖掉，"对面关了远程连接"的提示条留不住。加 `disabledAt`，下次连上或切换才清（4.1 `activeDeviceSchema`、"断了"、第 5 节"4006 记住"）。
- 单条路由上的 4005 被当作整台设备身份变了、落盘、不试别的地址。改成按路由记，每条都回它才是设备级的 `identity_changed`（"连"第 2、3 步、"添加"第 7 步、第 5 节）。
- 内部状态清单漏了 `removing`、`expected` 和它的定时器、`notice`、本机 `machineId`，也没写切换时清哪些。补齐（4.4"内部状态"）。
- `switchTo` 不清 `failure`，失败后切走再切回会先显示旧的"连不上"。改成清 `failure`、`expected`、`notice`、`disabledAt`（`switchTo` 第 3 步、第 5 节）。
- D3 的 HTTP 429 原来落进 `closed`，按 1 秒退避去撞限流。改成 `rate_limited`（4.3 第 2 步、第 5 节、第 8 节第 8 条）。
- `@vonvon/client/secure`、`@vonvon/protocol/secure-channel` 没说要在 `package.json` 的 `exports` 里加，不加 import 就报错。补上，D2 计划同步改（4.3 约定第 3 条、第 8 节第 4 条）。
- 连接页、加载页不在 `App` 里，Cmd+Q 没人接。本片不改主进程，由 U1b 4.1 的 `OutsideWindow` 补（4.8 第 7 条）。
- 根目录 `vitest.config.ts` 只收 `*.test.ts`，`.tsx` 的界面测试按原命令跑不到。改成在 ui 包里跑（第 6 节第 1 步）。
- 探针"`remote enable` 后 30 秒内"等于退避上限，加一次连接超时可能偶发失败。改成 45 秒（第 6 节第 2 步第 4 项）。
- 撤销到断开的 1 秒原来靠 Mac 上 Computer Use 加跨机计时，量不准。判据改为同机探针，`device-closed` 日志只作参考（4.4 日志一段）。
- U4 的能力名 `desktop.selfUpdate` 过不了 D1 的小写正则，改成 `desktop.self-update`；D1 分支的 sha 更新到 147b2619（开头、4.5）。
