# U4 `devices-ui-4-bundled-update`：远程更新桌面端自带的服务端

总设计见 `docs/plans/devices.md`（下文简称"设计"）6.5、7.5 末尾"桌面端自带的服务端（`bundled`）远程升级"、5.2、8.5、第 15 节，本片对应第 13 节的 U4 行。单独一个 PR，分支 `claude/devices-ui-4-bundled-update`，从集成分支开、PR 回集成分支。产品行为以 `docs/product.md` 3.14 为准。

缩写同 D1：`P/`、`CL/`、`D/`、`DT/`、`U/` 分别是 protocol、client、daemon、desktop、ui 的 `src/`。行号以 `origin/claude/devices-integration`（8051b03c，代码和 413d78d5 相同）为准。I3 的代码以 `origin/claude/server-3-update-engine`（4aca3777）为准，写"I3 分支"；D1 的以 `origin/claude/devices-1-identity`（911dd2c4）为准，写"D1 分支"。U1a、U2、U3 的接口以它们的计划为准。

## 1. 做什么

用户能看到的：
- **从别的设备更新一台 Mac 或 Windows 电脑上的 Vonvon Bot。** 那台的服务端是桌面端自带的。
  - 在"应用与启动"页"「X」的服务端"卡上：
    - 检查更新：看到那台能更新到哪个版本；
    - 点"更新「X」上的 Vonvon Bot"，确认后，那台电脑上的桌面端自己下载更新、等 Bot 做完手上的活、重启；
    - 发起的这台看得到进度（Windows 有下载百分比，macOS 只有阶段），断开一会儿后自动连上，提示"「X」已更新到 0.9.1"。
  - 命令行 `vonvon update` 连着那台时也一样。
- **那台桌面端没开时：** 按钮旁写"要那台电脑上的 Vonvon Bot 桌面端开着才能远程更新…"。点了也是这句，不会卡住。
- **被更新的那台：** 菜单栏 / 托盘和窗口顶部出一句"「X」正在更新这台电脑上的 Vonvon Bot。下载好后会等 Bot 做完手上的活再重启。"不弹确认框、不拦人。Windows 上本机点"安装"时的确认框，远程触发时不弹。
- **出问题时说清楚：**
  - 那台的安装包没有签名更新源（开发版）：原样回它的话；
  - 下载失败、超时、桌面端中途被关掉、重启后没换上新版本：各有一句；
  - 不会一直显示"进行中"。

依赖：
- D1：`admin.negotiate`、权限表、`Peer` 的 `principal`、`capabilities`。
- I3：`coreUpdateStatus`、`update-status.json` 和锁、`settleUpdateAtStartup`、`vonvon update`、`UpdatePanel` 的门控。
- U1a：外壳对本机的连接一直在、`DesktopBridge.localOwner()` 和 `onLocalOwner`。
- U2：`ServerUpdateCard` 留给本片的 `bundled` 渲染位、`update.standalone`/`update.npm` 的能力上报。
- 真机验收要 D3（另一台要能连进来）。

## 2. 范围

做：
- protocol：
  - `P/machine.ts`：`desktopUpdateReport` 请求；`coreUpdate` 回复加 `desktopShell`、`message`；状态加 `via`；`CORE_UPDATE_DETAIL` 加三项。
  - `P/events.ts`：`desktopUpdateRequest` 事件。
- client：`CL/client.ts` 的 `onDesktopUpdateRequest`。
- daemon：
  - 新文件 `D/service/bundled-update.ts`；
  - `D/server/rpc/machine.ts`（I3 分支）的 bundled 分支和 `desktopUpdateReport`；
  - `D/service/update.ts`（I3 分支）的状态 schema；`D/service/standalone-update.ts` 的 `settleUpdateAtStartup`；
  - 权限表一行（D1 的 `authz.ts`）、`D/cli/parity-allowlist.ts` 一行；
  - serverInfo 的 `update.bundled`；
  - `D/server/peer-label.ts` 的 `peerName`（U3 没合入时由本片建这个文件）。
- desktop：
  - 新文件 `DT/remote-self-update.ts`；
  - `DT/main.ts`（接线、`beforeUpdateInstall`、`installDesktopUpdate`）；
  - `DT/tray.ts` 的 `setNotice`；
  - `DT/bridge.ts` 的 `remoteUpdate` 事件。
- UI：
  - `U/management/ServerUpdateCard.tsx` 的 bundled 渲染（U2 留的位）；
  - 新文件 `U/devices/RemoteUpdateNotice.tsx`，挂在 U1b 的 `DesktopRoot`。
- 文档：设计 7.5、第 15 节（已在本计划的 PR 里改，第 7 节）。

不做：
- 桌面端没开时替它启动：daemon 不拉起图形应用（设计 7.5）。
- 0.8 及更早的 bundled：v1 协议，没有 `capabilities`，按 U1b 的版本提示让用户先到那台更新一次。
- 降级、指定版本：只有独立安装的服务端能做（I3 分支 `rpc/machine.ts:71`）。
- 在被更新的那台上"推迟"：点按钮的人就是主人本人（设计 7.5），不在那台再确认。

## 3. 现在的代码

- **I3 分支 `D/server/rpc/machine.ts`：**
  - `checkCoreUpdate`（47-53）只有 `standalone` 走自己的清单，其余（包括 `bundled`）走 `service.checkUpdate()`，也就是查 npm（I3 分支 `D/service/update.ts:101-105`）。对 bundled 来说，这个结果没有意义。
  - `applyCoreUpdate`（60-74）非 `standalone` 走 `service.applyUpdate()` 装 npm 全局包。对 bundled 来说，这是错的。
- **I3 的状态和锁**（I3 分支 `D/service/update.ts`）：
  - `acquireUpdateLock`（194）：创建即占有；
  - `updateStatusSchema`（235-244）：`detail` 是封闭枚举；
  - `writeUpdateStatus`/`readUpdateStatus`/`clearUpdateStatus`（362-383）；
  - `restartPending`（I3 分支 `standalone-update.ts:174`）：重启还没结束时不让开新的更新。
- **`settleUpdateAtStartup`**（I3 分支 `standalone-update.ts:345`）：新进程起来时，把没人持锁的 `installing` 记成"上次更新中断"，把 standalone 的 `restarting` 按版本记成成功或失败。bundled 的 `restarting` 没人收。
- **I3 的 CLI**（I3 分支 `D/cli/commands/update.ts`）：bundled 且 daemon 在跑时已经发 `applyCoreUpdate` 并跟进度；不在跑时说"这个命令行随 Vonvon Bot 桌面应用提供，请在桌面应用里更新"。本片不改 CLI，只让 daemon 那头真的能做。
- **I3 分支 `U/management/UpdatePanel.tsx:16`** 的 `coreUpdatable` 只认 `standalone`、`global-npm`。U2 把服务端卡抽成 `ServerUpdateCard`，bundled 时写一句文字，留了 `bundled` 渲染位。
- **桌面端的更新器：**
  - macOS `DesktopUpdater`（`DT/updates.ts:40-170`）：
    - `check()` 同一时间只查一次；
    - `install()` 第一次下载（最多 10 分钟，原生签名校验），回 `downloaded`；第二次先跑 `beforeInstall` 再 `quitAndInstall`；
    - `enabled` 要求签名和清单地址都有；
    - 没有下载进度。
  - Windows `WindowsDesktopUpdater`（`DT/windows-updates.ts:64` 起）接口相同，`onUpdate` 回调带下载进度。
- **`DT/main.ts`：**
  - `beforeUpdateInstall`（230-241）：Windows 先 `stopHost`（排空）再 `cleanup()`；macOS 只 `cleanup()`。
  - `cleanup`（138-158）会断开本机连接。
  - `installDesktopUpdate`（630-650）在 Windows 已下载时弹本机确认框（633-637）。
  - `noteUpdate`（258-261）把结果写到托盘。
- **macOS 更新后旧 daemon 怎么停：** 新桌面端起来时，启动修复用 `stopHost` 停掉旧的自带服务端（`DT/login-item.ts:174-190,208-244`），再起自己的。这一步本身就是排空。
- **托盘** `DT/tray.ts` 只有 `setUpdate(notice)`。
- **能力：**
  - serverInfo 的 `capabilities`（D1 分支 `D/server/http.ts:65`）只有 `device`，U2 加 `update.standalone`、`update.npm`。
  - 客户端在 `admin.negotiate { capabilities }` 里声明自己的能力，一条连接只认第一次（D1 计划 4.1）。
  - 桌面端主进程今天不发 `negotiate`。

## 4. 怎么改

### 4.1 协议

**`P/machine.ts`（在 I3 的版本上）**

```ts
// machineRequestSchema 加：
z.object({ type: z.literal('desktopUpdateReport'), requestId: z.string().regex(/^dur_[0-9a-f]{16}$/),
  state: z.enum(['available', 'current', 'unavailable', 'install-pending', 'downloading', 'downloaded', 'restarting', 'error']),
  latest: z.string().optional(), message: z.string().max(1024),
  progress: z.object({ transferred: z.number().nonnegative(), total: z.number().nonnegative() }).strict().optional() }).strict(),
// coreUpdate 回复加：desktopShell: z.boolean().optional(), message: z.string().optional()
// coreUpdateStatusSchema 加：via: z.string().optional()
// CORE_UPDATE_DETAIL 加：
//   'desktop-checking': '正在检查桌面端更新', 'desktop-downloading': '正在下载桌面端更新',
//   'desktop-downloaded': '下载好了，等 Bot 做完手上的活后重启'
```

`machineReplySchema` 的分支不是 `.strict()`，加可选字段对旧客户端无害。

**`P/events.ts`**

```ts
export const desktopUpdateRequestEventSchema = z.object({ type: z.literal('event'), event: z.literal('desktopUpdateRequest'),
  payload: z.object({ requestId: z.string(), action: z.enum(['check', 'apply']), by: z.string().max(80) }).strict() }).strict();
```

进 `eventSchema` 的联合。daemon 只发给一条连接（4.2），不 `publish`。

**`CL/client.ts`**：`onDesktopUpdateRequest(listener: (payload) => void): () => void`，写法同 `onLog`、`onBackendInstall`。

### 4.2 daemon：`D/service/bundled-update.ts`（新）

```ts
export interface DesktopShellPeer { readonly id: string; readonly open: boolean; event(event: Event): void }
export interface BundledUpdateDeps {
  shells: () => readonly DesktopShellPeer[];      // hub 里 principal 是本机 owner、clientKind 'desktop'、capabilities 含 'desktop.selfUpdate' 的连接，按连上的先后
  version: string;                                 // 当前 daemon 的版本
  log: Logger;
  now?: () => number;
  setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
  status?: { read: typeof readUpdateStatus; write: typeof writeUpdateStatus; lock: typeof acquireUpdateLock };
}
export interface BundledUpdate {
  check(by: string): Promise<{ current: string; latest: string | null; hasUpdate: boolean; desktopShell: boolean; message?: string }>;
  apply(by: string): Promise<string>;              // 回"开始更新…"；外壳不在 → RpcError('desktop_not_running', 设计第 15 节原文)
  report(peer: DesktopShellPeer, report: DesktopUpdateReport): void;
  shellAttached(peer: DesktopShellPeer): void;     // 重启中看到外壳又连上 → 没换上
  shellDetached(peer: DesktopShellPeer): void;
  close(): void;                                   // 清定时器
}
export function createBundledUpdate(deps: BundledUpdateDeps): BundledUpdate;
```

**找外壳：** 取 `shells()` 的最后一个 `open` 的。同一台上只会有一个桌面端主进程连着本机；万一有两个（交接中途），用新的那个。

**检查 `check(by)`：**
- 没有外壳 → `{ current: version, latest: null, hasUpdate: false, desktopShell: false }`。
- 有 → 生成 `requestId = 'dur_' + 16 位十六进制`，发事件 `{ requestId, action: 'check', by }`，等这个 `requestId` 的报告，最多 20 秒（设计写 10 秒；桌面端读更新清单自己就有 15 秒超时，`DT/updates.ts` 的 `fetchManifest`，10 秒会把慢网络误报成"没有回应"）：
  - `available` → `latest`、`hasUpdate: true`；`current` → `hasUpdate: false`；
  - `unavailable`、`install-pending`、`error` → `latest` 照报告、`hasUpdate: false`、`message` 用报告的文字；
  - 20 秒没回 → `message: '那台电脑上的 Vonvon Bot 没有回应，稍后再试。'`。
  - 都带 `desktopShell: true`。
- 同时只有一个检查在等；第二个检查直接共用。

**应用 `apply(by)`：**
1. 没有外壳 → `RpcError('desktop_not_running', 设计第 15 节"那台桌面端没开"原文，<设备> 用这台的设备名)`。
2. `restartPending(read(), now)` → `RpcError('conflict', '上一次更新还在重启，稍后再试。')`。
3. `lock()` 拿不到 → `RpcError('conflict', '已有更新正在进行。')`。
4. 写状态：`{ phase: 'installing', detail: 'desktop-checking', via: 'desktop', from: version, at: now }`。发事件 `{ requestId, action: 'apply', by }`。回"开始更新…"。
5. 之后按报告改状态（每次写都带 `via`、`from`，`at` 取当下）：

| 报告 | 状态 |
|---|---|
| `downloading` | `installing`，`detail: 'desktop-downloading'`，`progress` 照报告 |
| `downloaded` | `installing`，`detail: 'desktop-downloaded'`，`to: latest` |
| `restarting` | `restarting`，`detail: 'draining'`，`to: latest`；**放锁**（这个进程马上要被换掉，新进程在 `settleUpdateAtStartup` 里收尾） |
| `current` | `done`，`message: '已是最新版本'`；放锁 |
| `unavailable`、`install-pending`、`error` | `error`，`message` 用报告的文字；放锁 |
| `available` | 不改（外壳检查完马上会开始下载） |

6. 看门狗（定时器都 `unref`）：
   - 发出后 30 秒没有任何报告 → `error`"那台电脑上的 Vonvon Bot 没有回应更新请求。"
   - `installing` 期间 15 分钟没有新报告 → `error`"下载桌面端更新超时。"（外壳自己最多下载 10 分钟。）
   - 外壳在 `restarting` 之前断开（`shellDetached`）→ `error`"那台电脑上的 Vonvon Bot 在更新完成前关掉了。"
   - `restarting` 之后：
     - 10 分钟这个进程还活着 → `error`"桌面端重启后没有换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。"
     - 期间又有外壳连上（`shellAttached`）→ 同样记 `error`，文字换成"桌面端重新打开了，但服务端还是 <version>，没能换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。"
     - 正常的路径是这个进程先被停掉，轮不到这两条。
   - 写 `error` 时只在文件仍是自己写的那条记录时写（同 I3 的 `finishOwnedUpdate` 的比较），不覆盖别人的。
7. `report` 只收当前 `requestId` 的、来自发出事件的那条连接的，别的回 `invalid_request('这次更新已经结束或不是发给你的。')`。

**诊断**（`log.info('update', …)`）：
- `update-bundled-requested { action, by }`；
- `update-bundled-no-desktop`；
- `update-bundled-reported { state }`；
- `update-bundled-watchdog { reason }`。
不记版本以外的东西。

### 4.3 daemon：接线

- **`D/server/rpc/machine.ts`（I3 分支）**，`distribution = await runtimeDistribution()` 之后：
  - `checkCoreUpdate`：`bundled` → `{ type: 'coreUpdate', distribution, dev: false, ...await bundled.check(by) }`。
  - `applyCoreUpdate`：`bundled` → 先照 71 行拒 `version`/`allowDowngrade`，再 `{ kind: 'read', value: { type: 'done', message: await bundled.apply(by) } }`。
  - `desktopUpdateReport`：调用者不是"本机 owner + `clientKind: 'desktop'` + 声明了 `desktop.selfUpdate`" → `RpcError('forbidden', '只有这台电脑上的桌面端能报告更新进度。')`；是 → `bundled.report(peer, request)`，回 `done`。
  - `by` 用 `peerName(peer, clients)`：配对来的是"「<名字>」"，本机是"这台电脑上的<桌面端|命令行|网页端>"。和 U3 的 `peerOwner` 放在同一个 `D/server/peer-label.ts`。
  - `machineRpc` 的参数加 `peer` 和 `bundled`：`MachineServiceContext` 里加 `bundled?: BundledUpdate`，`peer` 由 `http.ts` 的分发处传进来。今天 `rpc.ts` 已经把 peer 传给 `command`，照抄。
- **`D/server/http.ts`：**
  - `createBundledUpdate({ shells: () => [...hub.peers].filter(isDesktopShell), version: bridgeVersion(), log })`；
  - hub 的 `attached` 回调（U3 加的；U3 没合入时本片加）里，`isDesktopShell(peer)` 为真 → `bundled.shellAttached(peer)`；
  - `detached` 里同理调 `shellDetached`；
  - `release` 时 `bundled.close()`。
  - `isDesktopShell` 要在 `negotiate` 之后才为真，所以 `negotiate` 成功时（D1 的处理处）也补一次 `bundled.shellAttached(peer)`。`shellAttached` 只在 `restarting` 期间有作用，重复调用无害。
- **能力：** D1 分支 `http.ts:65` 的 `capabilities()` 在 `distribution.kind === 'bundled'` 时加 `update.bundled`。
- **权限表**（D1 的 `D/server/authz.ts`）：`'machine.desktopUpdateReport': { owner: 'allow', botSession: 'deny', maintenance: false }`。owner 里还要是本机外壳，由上面的处理函数再查。设计 5.2 表里已经写了这一条（`machine.*` 那一行的括号）。
- **白名单**（`D/cli/parity-allowlist.ts:57-60` 一带）：`'machine.desktopUpdateReport': { reason: 'desktop-only', note: "the shell's report on its own update (devices 7.5)" }`。D1 的 RPC 种类计数加 1。
- **状态 schema**（I3 分支 `D/service/update.ts:234-244`）：
  - `updateDetails` 加 `'desktop-checking'`、`'desktop-downloading'`、`'desktop-downloaded'`；
  - `updateStatusSchema` 加 `via: z.enum(['desktop']).optional()`。
- **`settleUpdateAtStartup`**（I3 分支 `standalone-update.ts:345`）：在 standalone 的 `restarting` 分支前加：

```ts
if (status?.phase === 'restarting' && status.via === 'desktop') {
  if (status.to === undefined || status.to === options.version) finishOwnedUpdate(status, 'done');
  else finishOwnedUpdate(status, 'error', `重启后仍是 ${options.version}`);
}
```

  - 它不需要 `installRoot`，要放在 `if (!options.installRoot) return;` 之前。bundled 没有安装根（`bootstrap.ts:34` 只在 standalone 传）。
  - `installing` 且没人持锁 → "上次更新中断"，这一条 I3 已有，bundled 一样适用：比如 Windows 上 `stopHost` 之后安装包没装成。

### 4.4 desktop：`DT/remote-self-update.ts`（新）

```ts
export interface SelfUpdater { check(): Promise<DesktopUpdate>; install(): Promise<DesktopUpdate>; readonly enabled: boolean; readonly busy: boolean }
export interface RemoteSelfUpdateDeps {
  updater: SelfUpdater;
  owner(): AttachedDaemon | null;                               // U1a 的 DesktopBridge.localOwner()
  onOwner(listener: (owner: AttachedDaemon) => void): () => void; // U1a 的 onLocalOwner
  quitting(): boolean;                                          // main.ts 的 quitRequested
  notice(text: string | undefined): void;                       // 托盘 + 窗口
  publish(update: DesktopUpdate): void;                         // 本机"这台电脑上的应用"卡跟着变
  onProgress?(listener: (update: DesktopUpdate) => void): () => void;   // Windows 的 onUpdate
  log(event: string, fields?: Record<string, unknown>): void;
}
export function startRemoteSelfUpdate(deps: RemoteSelfUpdateDeps): {
  /** 远程更新进行中：本机"安装"按钮先等它。 */
  readonly busy: boolean;
  /** beforeUpdateInstall 第一件事：报 restarting，最多等 2 秒。没有进行中的远程更新就什么都不做。 */
  aboutToRestart(): Promise<void>;
  dispose(): void;
};
```

**连上本机就声明能力：**
- 对 `owner()`（启动时）和之后每个 `onOwner` 给的连接，发一次 `admin.negotiate { capabilities: ['desktop.selfUpdate'] }`，再 `client.onDesktopUpdateRequest(handle)`。
- `negotiate` 被拒（旧 daemon 没有这个 kind、或已经声明过）→ 记日志，不订阅。
- 只在这条主连接上做；远程设备的连接（U1a 的 `connections.ts`）不声明这项能力。
- bridge 不转发渲染进程发来的 `admin.negotiate`（本机视图），免得页面抢先在这条连接上声明，导致外壳声明不了。U1a 4.6 的 bridge 路由加一条拒绝。

**`check` 请求：**
- `updater.check()` → 报告 `{ state: update.state, latest: update.latest, message: update.message }`。
- 抛错 → `{ state: 'error', message: error.message }`。

**`apply` 请求：**
1. `quitting()` → 报 `error`"那台电脑上的 Vonvon Bot 正在退出。"，结束。
2. `notice(\`${by}正在更新这台电脑上的 Vonvon Bot。下载好后会等 Bot 做完手上的活再重启。\`)`，`busy = true`。
3. `const found = await updater.check()`，`publish(found)`：
   - `current` / `unavailable` / `install-pending` → 原样报，清提示，结束。
   - `downloaded` → 跳到第 5 步。
   - `available` → 报 `downloading`（Windows 由 `onProgress` 接着报百分比，最多每秒一次；macOS 只报这一次）。
4. `const got = await updater.install()`，`publish(got)`：
   - `downloaded` → 报 `{ state: 'downloaded', latest }`；
   - `current`（源里没有包）→ 原样报，结束。
5. `await updater.install()`：这一次走 `beforeInstall` → `quitAndInstall`。
   - **不经过 `installDesktopUpdate`**，所以 Windows 的本机确认框（`main.ts:633-637`）不弹（设计 7.5）。
   - 任一步抛错 → 报 `error`，文字用错误的 `message`，清提示，`busy = false`。

**`aboutToRestart()`：**
- 有进行中的 `apply` 时，用当前主连接发 `desktopUpdateReport { state: 'restarting', latest }`，`Promise.race` 2 秒；然后返回。
- 必须在 `cleanup()` 断开主连接之前，Windows 上还要在 `stopHost` 之前，否则 daemon 收不到。

### 4.5 desktop：接线（`DT/main.ts`、`DT/tray.ts`、`DT/bridge.ts`）

- `main.ts`，`updater` 建好（244-256）、bridge 装好之后：
  - `remoteUpdate = startRemoteSelfUpdate({ updater, owner: () => bridge?.localOwner() ?? null, onOwner: l => bridge?.onLocalOwner(l) ?? (() => {}), quitting: () => quitRequested, notice, publish: u => bridge?.publishUpdate(noteUpdate(u)), onProgress, log })`。
  - Windows 的 `onUpdate`（249）在原来的 `publishUpdate` 之外也交给 `onProgress` 的监听者。
- `beforeUpdateInstall`（230）第一行：`await remoteUpdate?.aboutToRestart();`，然后照旧。macOS、Windows 都这样。
- `installDesktopUpdate`（630）开头：`remoteUpdate?.busy` → `throw new StartHostRefusal('正在按另一台设备的请求更新，下载好后会自动安装并重启。')`。避免本机和远程同时走到 `quitAndInstall`。
- `cleanup` 里 `remoteUpdate?.dispose()`，放在 `bridge.dispose()` 之前。
- `notice(text)`：
  - `tray?.setNotice(text)`。`DT/tray.ts` 加 `setNotice(text | undefined)`：在菜单顶部放一条不可点的文字，和 `setUpdate` 同样的做法。
  - `bridge?.sendRemoteUpdate(text)`：发 `DesktopEvent { type: 'remoteUpdate', text }`，bridge 里留最后一条，新窗口订阅时补发，同 `publishUpdate` 的 `retainedUpdate`（149 一带）。
- `client-context.tsx` 的 `ShellCapabilities` 加 `onRemoteUpdate?: (listener: (text: string | undefined) => void) => () => void`。`shellForDevice` 不去掉它：它说的是这台电脑。

### 4.6 UI

**`ServerUpdateCard` 的 bundled 渲染**（U2 4.4.2 留的 `bundled` 位，本片在 `App.tsx` 远程时传进去，U1b 的维护视图同样传）：

```tsx
bundled={(core, run) => <BundledUpdateRow core={core} where={where} run={run}/>}
```

- 版本行同 standalone。
- `core.desktopShell === false` → 按钮旁写设计第 15 节"那台桌面端没开"那句。按钮照样可点，点了得到同一句（`desktop_not_running`），用户在那台打开桌面端后不用刷新页面就能再点。
- `core.message` → 原样写在下面（开发版的"没有可用的签名更新源…"、"没有回应"）。
- `core.hasUpdate` → 按钮"更新「X」上的 Vonvon Bot"，点了先确认（设计第 15 节"远程更新桌面端自带的服务端（确认）"）→ `run({ type: 'applyCoreUpdate' })`。
- 跟进度：用 U2 已放宽的条件（`done` + `applyCoreUpdate` 就跟）。状态行用 `coreStatusLine`；`via === 'desktop'` 时前面加"在「X」上"。
- 断开期间轮询失败不报错；U1a 重连后照常读到 `done` 或 `error`。U1b 的提示条会说"「X」已更新到 …"。
- `DeviceVersionNotice`（U1b 4.8）的"升级「X」"按钮已经按 `capabilities` 含 `update.bundled` 给出，跳到应用与启动页，不用改。

**`U/devices/RemoteUpdateNotice.tsx`（新）**：
- 挂在 `DesktopRoot`，订阅 `shell.onRemoteUpdate`。
- 有文字时在窗口顶部放一条 `InlineNotice tone="info"`，不能关，文字清掉就消失。

### 4.7 顺序

1. 协议、client。
2. `bundled-update.ts` 和它的单测（假外壳、假时钟、假状态文件）。
3. `rpc/machine.ts` 接线、权限表、白名单、能力、`settleUpdateAtStartup`。
4. `remote-self-update.ts` 和它的单测（假更新器、假连接）。
5. `main.ts`、托盘、bridge。
6. UI。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/bundled-update.test.ts`（新，假外壳、假时钟、临时状态文件） | 没有外壳 | `check` → `desktopShell: false`、`latest: null`；`apply` → `desktop_not_running`、文字是设计第 15 节那句。main 必败 |
| 同上 | 检查 | 外壳收到 `check` 事件、回 `available 0.9.1` → `hasUpdate: true`、`latest: '0.9.1'`；20 秒不回 → `message` 是"没有回应"，`hasUpdate: false` |
| 同上 | 应用走完 | `apply` → 外壳收到 `apply`；依次报 `downloading`（50/100）、`downloaded 0.9.1`、`restarting` → 状态依次是 `installing/desktop-downloading` 带进度、`installing/desktop-downloaded` 带 `to`、`restarting/draining`；`restarting` 后锁已放 |
| 同上 | 并发 | `apply` 进行中再 `apply` → `conflict`；`restarting` 后 5 分钟再 `apply` → `conflict`（`restartPending`） |
| 同上 | 报告来源 | 别的连接报同一个 `requestId` → `invalid_request`；旧的 `requestId` → `invalid_request` |
| 同上 | 看门狗 | 30 秒没报 → `error`"没有回应更新请求"；报了 `downloading` 后 15 分钟没动静 → `error`"下载桌面端更新超时"；`restarting` 前外壳断开 → `error`"关掉了"；`restarting` 后 10 分钟 → `error`"没有换上新版本"；`restarting` 后外壳又连上 → `error`"服务端还是 0.9.0" |
| 同上 | 不覆盖别人 | 看门狗触发前状态文件被别的记录替换 → 不写 |
| 同上 | 关闭 | `close()` 后 `vi.getTimerCount()` 为 0 |
| `daemon/test/rpc-machine-bundled.test.ts`（新，`startFixture` 注入 `runtimeDistribution` 为 bundled） | 外壳身份 | 本机 desktop 连接 `negotiate ['desktop.selfUpdate']` 后算外壳；本机 cli 声明同一项 → 不算；配对的 desktop 声明 → 不算。main 必败 |
| 同上 | 报告权限 | 配对连接发 `desktopUpdateReport` → `forbidden`；bot 会话 → 权限表拒 |
| 同上 | 端到端 | 配对连接 `applyCoreUpdate` → 外壳连接收到事件 → 外壳报 `restarting` → 配对连接读 `coreUpdateStatus` 是 `restarting` |
| 同上 | 拒指定版本 | bundled `applyCoreUpdate {version}` → `invalid_request` |
| `daemon/test/standalone-update.test.ts`（I3 的，改） | 启动收尾 | 状态 `restarting`、`via: 'desktop'`、`to: '0.9.1'`，`version` 0.9.1 → `done`；0.9.0 → `error`"重启后仍是 0.9.0"；没有 `installRoot` 也收 |
| `daemon/test/server-info.test.ts`（D1 的，改） | 能力 | bundled → `capabilities` 含 `update.bundled` |
| `daemon/test/authz.test.ts`（D1 的，改） | 表 | `machine.desktopUpdateReport` 有一行；"每个 kind 都在表里"的测试仍过 |
| `protocol/test/machine.test.ts`（改） | schema | `desktopUpdateReport` 能解析；`coreUpdate` 带 `desktopShell` 能解析；`coreUpdateStatusText({ phase:'installing', detail:'desktop-downloading', progress: {transferred: 45, total: 100} })` → "正在下载桌面端更新 45%" |
| `desktop/test/remote-self-update.test.ts`（新，假更新器、假连接） | 声明 | 启动时对 `owner()` 发 `negotiate ['desktop.selfUpdate']`；`onOwner` 给新连接 → 再发一次 |
| 同上 | 检查 | 事件 `check` → `updater.check` 回 `available` → 报 `available`、带 `latest` |
| 同上 | 应用 | 事件 `apply`，更新器依次回 `available`、`downloaded`、第二次 `install` → 报 `downloading`、`downloaded`；`install` 被调两次；`notice` 先给文字；没有调 `installDesktopUpdate`（Windows 确认框不弹）。main 必败 |
| 同上 | 已下载 | `check` 回 `downloaded` → 不报 `downloading`，直接第二次 `install` |
| 同上 | 开发版 | `check` 回 `unavailable` → 报 `unavailable`、原文；`install` 没被调；`notice` 清掉 |
| 同上 | 出错 | `install` 抛"桌面更新下载超时" → 报 `error` 带这句；`busy` 变回假 |
| 同上 | 正在退出 | `quitting()` 真 → 报 `error`"正在退出"，不调更新器 |
| 同上 | 重启前报告 | `apply` 进行中 `aboutToRestart()` → 发 `restarting`；假连接 5 秒不回 → 2 秒后返回 |
| 同上 | Windows 进度 | `onProgress` 连发 10 次 → 报告最多 1 秒一条 |
| `desktop/test/main-update.test.ts`（改，或现有 `beforeUpdateInstall` 的测试） | 顺序 | `beforeUpdateInstall` 里 `aboutToRestart` 在 `stopHost` 和 `cleanup` 之前被调 |
| 同上 | 本机按钮 | 远程更新进行中调 `installDesktopUpdate` → 拒，文字"正在按另一台设备的请求更新" |
| `desktop/test/tray.test.ts`（改） | 提示 | `setNotice('x')` → 菜单第一项是 `x`、不可点；`setNotice(undefined)` → 没有 |
| `ui/test/server-update-card.test.tsx`（U2 的，改） | bundled | `desktopShell: false` → 有"要那台电脑上的 Vonvon Bot 桌面端开着"；`hasUpdate` → "更新「X」上的 Vonvon Bot"，点了出确认框，确认 → 发 `applyCoreUpdate` 并开始跟进度；`message` 原样显示 |
| `ui/test/remote-update-notice.test.tsx`（新） | 提示 | `onRemoteUpdate('…正在更新…')` → 显示；`undefined` → 消失 |

## 6. 自测和验收

**删除文件的硬规矩**（`~/.claude/CLAUDE.md`，原样照抄）：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

真实的换包（下载签名包、`quitAndInstall`、新版本起来）要一个已发布、签了名、有更新清单的版本，才能更新到下一个版本。所以：
- 这一批的真机验收只到"通道通了"：开发版的更新器回 `unavailable`，原样回到发起的那台。
- 真实换包在 0.9.0 发布之后的第一个 0.9.x 上验（设计第 16 节）：用装好的 0.9.0 从另一台点更新。验法写进那次发布任务。
- 除此之外靠第 5 节的假驱动测试。

### 6.1 Claude 在 JP-VPS 上

1. 单测：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run <第 5 节列出的文件>`，然后在锁里跑 protocol、client、daemon、desktop、ui 的 `typecheck`、`lint`、`build`。最后 `rm -rf -- "${T:?}"`。
2. 通道：`bundled` 只认打包后的目录结构（`Resources/app.asar` 旁边的 `daemon`，`D/service/distribution.ts:53-66`），JP-VPS 上没有桌面端的包，所以这里的"真通道"就是第 5 节的 `rpc-machine-bundled.test.ts`：
   - 进程内起 daemon，注入安装方式 `bundled`；
   - 一条本机桌面端连接声明 `desktop.selfUpdate`，扮演外壳，按脚本回报告；
   - 一条配对连接（D2 的夹具）发 `checkCoreUpdate`、`applyCoreUpdate`，再跟 `coreUpdateStatus`。
   - 看到"应用走完"的状态顺序；关掉假外壳再点一次 → `desktop_not_running`。
3. `vonvon update`（I3 的命令）：`cli-update.test.ts` 加一例，连上面的夹具，进度行依次是"正在检查桌面端更新""正在下载桌面端更新 50%""下载好了…"。

### 6.2 Mac 上的 Codex（#322）：macOS 一侧

Mac 当**被更新的那台**，JP-VPS 的探针当发起的那台。U3 已合入时，Mac 开远程地址、配对的步骤照 U3 第 6 节；没合入时这一项等 U3。

`bundled` 只认打包后的目录结构，所以这里不用开发版（`npm start` 跑的是 `development`），用**不签名的目录包**：
- 在临时 worktree 里 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir -w packages/desktop`。前缀只写在这一条命令前，不用钥匙串里的签名身份。
- 打出来的 `.app` 留在临时 worktree 的 `packages/desktop/release/` 下，不拷到 `/Applications`，不打 DMG。
- 没签名，所以更新器是关着的：`DT/update-configuration.ts:11-25` 要 Developer ID 签名和 `update-config.json`，缺一样就回 `unavailable`，不会去查真的更新源、不会下载。
- 启动时前缀 `VONVON_DESKTOP_TEST_HOME=<临时目录>/desk VONVON_HOME=<临时目录>/vh`，直接运行 `.app/Contents/MacOS/` 里的可执行文件。

**Computer Use**（外壳、托盘都在桌面端里，网页端碰不到）：
1. 目录包的桌面端开着，Tailscale 地址已开，JP-VPS 的探针已配对（经验收助手 `/pair-remote`）。
2. 助手 `/check-update`：探针对 Mac 发 `checkCoreUpdate`，回 `desktopShell: true`，`message` 是"这个安装包没有可用的签名更新源…"（开发版没签名）。结果里贴回复的 JSON，打码后。
3. 助手 `/apply-update`：
   - 回 `desktop_not_running` 以外的结果；
   - 菜单栏菜单顶部、窗口顶部出现"「…」正在更新这台电脑上的 Vonvon Bot…"，随后消失；
   - 探针读到的状态是 `error`，文字同上；
   - 没有弹任何确认框。
4. 退出桌面端。隔离的数据目录里没有服务注册，daemon 会跟着停（U2 的退出规则）。
   - 再用包里自带的命令单独起 daemon，这样安装方式仍是 bundled：`ELECTRON_RUN_AS_NODE=1 VONVON_HOME=<临时目录>/vh "<.app>/Contents/MacOS/<可执行文件>" "<.app>/Contents/Resources/daemon/bin/vonvon.mjs" daemon start`。桌面端起自带 daemon 也是这个 Node 模式（`startBundled`）。
   - 助手 `/apply-update` → `desktop_not_running`，文字是设计第 15 节那句。
   - 最后同样的前缀跑 `daemon stop`。
5. 用 Mac 网页端（网页控制）以本机身份打开"应用与启动"：本机 bundled 时这里没有服务端卡，只有"这台电脑上的 Vonvon Bot 应用"，不重复。

提示词贴进 PR，任务贴 #322，任务号用 `next-mac-task.sh` 取。提示词写清：
- 第 0 步查开始和结果标记；开始前、每次 push 前都看有没有取消。
- 隔离：前缀照 #322 正文，不 export。
- 不碰：owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和它的数据、飞书客户端。
- 不替换任何装好的 app：只打目录包、不签名、不打 DMG、不安装，不点任何"安装并重启"。
- 远程地址在任务结束前全部关掉。
- 上面三条删除规矩原样写进去。
- 打码：不贴链接、地址、完整 id。

### 6.3 Windows 上的 Codex（#631）：D 道，包含 U2、U3 的 Windows 项

Windows 只有这一个任务，等 U2、U3、U4 都合入集成分支后发。Claude 把提示词贴进 #631：
- 第一行 `<!-- claude-win-task:<任务号> -->`，任务号用 `next-mac-task.sh` 取，和 #322、#422 共用一套；
- Codex 开始时贴 `<!-- codex-win-start:<任务号> -->`，结果贴 `<!-- codex-win-result:<任务号> -->`；
- 取消是 `<!-- claude-win-cancel:<任务号> -->`；
- owner 转发一行"按 modelzen/vonvon-bot#631 正文做"。

隔离：
- 临时 worktree 取集成分支的 sha，`npm ci`、构建，`npm run package:dir -w packages/desktop` 打不签名的目录包（理由同 6.2：`bundled` 只认打包后的结构），从临时 worktree 里直接运行，不装。
- **打完先查**：包里没有 `resources/app.asar` 里的 `dist/windows-update-config.json`。没有它，`windowsUpdateConfiguration`（`DT/windows-updates.ts:47-54`）不给公钥，更新器是关着的，只会回 `unavailable`。有这个文件就停下，结果写"卡住了：目录包带了更新配置"。否则它会去查真的更新源，可能下载并装上已发布的版本。
- 数据目录的前缀照 #631 正文，只写在单条命令前，不用 `setx`、不改用户环境变量。
- 不碰 owner 装好的 Vonvon Bot 和它的数据目录。
- 删除规矩原样写进去；Windows 上同样只删自己刚建的临时目录，用字面路径。

步骤：
1. **平台名**（U2 4.5）：Mac 的开发版桌面端（或 JP-VPS 探针）连上这台的目录包后，`serverInfo.platform` 是 `windows`；Mac 那边"应用与启动"写"这台 Windows 电脑"、登录时启动一行写"这一批 Windows 不做登录自启…"。
2. **当被连的设备**（U3）：
   - "允许别的设备连接"里列出 Tailscale 地址并标"Tailscale（推荐）"，验 U3 对 `tailscale.exe` 位置的补丁；
   - 勾上 → 监听中；生成连接链接，经验收助手发给 JP-VPS 探针配对 → Windows 上弹"新设备…已经配对"；
   - 锁屏 5 分钟，探针 `/status` 仍连得上；
   - 撤销它 → 探针 1 秒内断。
3. **远程更新**（U4）：
   - 开着：探针 `/check-update`、`/apply-update`，同 6.2 第 2、3 步：托盘提示出现，**不弹**"安装并重启 Vonvon Bot？"确认框；
   - 关掉桌面端、单独起 daemon 后再点一次 → `desktop_not_running`。
4. **启动修复**（U2 4.8）：
   - 在另一个临时 worktree 里打一个版本号更低的目录包（只改那份 worktree 里 `packages/daemon/package.json` 的版本，不提交）；
   - 用它起 daemon；
   - 再打开本任务的目录包 → 它停掉旧的、起自己的，不报协议不同。
   - 做不了就写原因，靠单测。
5. 收尾：关掉远程地址，退出桌面端，用 `git worktree remove` 删临时 worktree。

## 7. 文档

本计划的 PR 里已改：
- 设计 7.5 末尾：
  - 状态映射（报告 → 状态）；
  - 看门狗四条；
  - `via: 'desktop'`；
  - 启动收尾不需要安装根；
  - 本机"安装"按钮在远程更新进行中先拒。
- 设计第 15 节：
  - 加"远程更新失败（没有回应 / 下载超时 / 关掉了 / 没换上新版本）"；
  - 加"被远程更新的那台，本机点安装"。
- 设计 5.2 的权限表已经有 `machine.desktopUpdateReport`（只收本机外壳），不改。

实现 PR 里改：
- `docs/product.md` 3.14 加一句：桌面端自带的服务端可以从别的设备更新，要那台的桌面端开着。
- 合入时在设计第 13 节 U4 行标"已合入"；Windows 任务的结果写进集成 PR 描述。

## 8. 验收要点

1. 只有"本机 owner + `clientKind: 'desktop'` + 声明了 `desktop.selfUpdate`"的连接算外壳，配对来的桌面端不算；`desktopUpdateRequest` 只发给它；`desktopUpdateReport` 只收它的、而且要对得上 `requestId`。
2. 远程触发不走 `installDesktopUpdate`，Windows 的本机确认框不弹；本机按钮在远程更新进行中先拒。
3. `restarting` 在 `stopHost` 和 `cleanup` 之前报出去，最多等 2 秒。
4. 每条路径都会结束：成功由新进程的 `settleUpdateAtStartup` 收；没回应、超时、中途关掉、没换上新版本各有看门狗；看门狗不覆盖别人的记录；关闭时定时器清干净。
5. 锁：开始时拿，`restarting` 或结束时放；`restartPending` 期间不开新的。
6. `update.bundled` 由 daemon 按安装方式报；按钮的可用不看 `desktopShell`，没开时点了得到明确的话。
7. 白名单和权限表各一行，RPC 种类计数加 1。
8. 开发版的 `unavailable` 原样回到发起的那台（这一批的真机验收就看这个）；真实换包写进 0.9.0 之后第一次发布的任务。
9. diff 里没有真实 id、密钥、本机路径和地址。

## 9. 风险和行数

- 估计约 1,150 行（原估 ~600）：
  - 协议和 client 70、`bundled-update.ts` 260、`rpc/machine.ts` 和接线 90、状态 schema 和启动收尾 40、权限表 / 白名单 / 能力 15；
  - `remote-self-update.ts` 200、`main.ts`/托盘/bridge 90；
  - UI 100、验收助手的两个接口 50；
  - 测试约 500，压缩写，不计在上面。
  - 原估没算看门狗、外壳身份的核对和启动收尾。
- 审查：一个读整个 diff；另一个按 daemon、desktop 分。这一片碰子进程退出顺序、关闭清理、并发和锁，再加一轮多角度审查（AGENTS.md），Fable 做（高风险）。
- **macOS 上旧 daemon 在桌面端换包期间一直跑着：**
  - 远程连接要等新桌面端的启动修复停掉旧的才断，期间状态停在 `restarting`。
  - 新桌面端起不来时，靠 10 分钟看门狗报错，旧 daemon 照常工作，Bot 不受影响。
- **Windows 的 `stopHost` 排空可能很久**（Bot 在做长任务）：期间状态是 `restarting/draining`，发起的那台看得到。超过 10 分钟看门狗不会误报：这时旧进程已经停了，看门狗也随它没了。
- **`negotiate` 只认一次：** 主连接由外壳先发；bridge 拒绝页面在本机视图里发 `negotiate`。以后外壳要声明别的能力，就改成在这一处合并发。
- **真实换包只能在发布后验。** 假驱动测试覆盖了调用顺序，`DesktopUpdater` 本身的下载和校验是现有代码，有自己的测试。第一次真用就在发布任务里，有问题可以只发桌面端修复，不影响 standalone、npm 的升级。
