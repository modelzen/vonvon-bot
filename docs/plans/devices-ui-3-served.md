# U3 `devices-ui-3-served`：允许别的设备连接、连接链接、已配对的客户端、扫码任务归属

总设计见 `docs/plans/devices.md`（下文简称"设计"）4.2、4.3、6.2、6.3、第 15 节，本片对应第 13 节的 U3 行。单独一个 PR，分支 `claude/devices-ui-3-served`，从集成分支开、PR 回集成分支。产品行为以 `docs/product.md` 3.14 为准。

缩写同 D1：`P/`、`CL/`、`D/`、`DT/`、`U/` 分别是 protocol、client、daemon、desktop、ui 的 `src/`。行号以 `origin/claude/devices-integration`（8051b03c，代码和 413d78d5 相同）为准；D1 的代码以 `origin/claude/devices-1-identity`（147b2619）为准，写"D1 分支"。D2、D3 还没有代码，按 `devices-2-secure-channel.md`、`devices-3-remote-listen.md` 的接口写。U1a、U1b 的接口以它们的计划为准。

**A1 之后要改的地方（2026-11-02，`docs/plans/remote-single-address.md`，设计第 21 节）。** 本计划写在 A1 之前，下面几条以 A1 为准：
- 地址只开一个：面板里的地址是**单选**，不是勾选列表；选另一个就换掉原来的（daemon 关掉旧地址、它的连接 4006）。没有"用 Tailscale 地址"按钮，`enableErrorText` 里没有 `tailscale_unavailable`。
- 候选：`D/remote/candidates.ts` A1 已经有了（`listCandidates`、`candidateContext`、`defaultCandidate`、`candidateLabel`），和 `vonvon remote candidates` 同一套过滤（虚拟网桥、198.18/15、169.254 默认不列）和排序（tailscale、overlay、lan、cgnat、public）。本片的 `createCandidates` 只在它外面包 30 秒缓存；`candidateSchema` 照 A1 的 `Candidate` 多带 `tool?`（例如 ZeroTier），隐藏的不进 `device.status`。
- 分类多了 `overlay`（组网），`KIND_LABEL` 加 `overlay: '组网'`，有 `tool` 时写"组网 · ZeroTier"；组网地址不弹确认框。
- 远程时换地址：调用者正是从当前地址连进来的（`via`），选别的地址前先确认："你现在就是通过这个地址连着「X」的。换成别的地址后这台电脑会马上断开，要在「X」上生成新链接、粘到"添加设备"里更新地址。"
- 验收步骤里"勾 Tailscale 地址""取消勾选"改成"选 Tailscale 地址""关闭远程连接"。

## 1. 做什么

用户能看到的（"应用与启动"页里新的一组"允许别的设备连接"，当前看的是哪台就管哪台）：
- **设备名字。** 别的设备配对时看到的名字，可以改。
- **地址。**
  - 列出这台设备能用的地址，每个标类型："Tailscale（推荐）""局域网""运营商分配的地址""公网地址"。
  - 勾上就开始接受连接，取消勾选就停。右边写状态：监听中、等地址出现、网络变了要确认、开不了（带原因）。
  - 运营商地址和公网地址勾选前要确认，确认框写清楚风险，要勾"我了解风险"。
  - 局域网换了网络时这一行写"网络变了，要确认"，点"确认并重新开启"才重新监听。
  - 没有 Tailscale 地址时，下面给一段 Tailscale 建议。
  - 端口只显示；要改，给一行命令。
- **连接链接。**
  - 点"生成连接链接"出一条链接，旁边"复制"、剩余时间倒数（10 分钟），"再生成一个"。
  - 没开任何地址时按钮是灰的，写"先在上面勾一个地址"。
- **已配对的客户端。**
  - 名字、类型（桌面端、命令行、网页端）、上次连接的时间和地址、是谁带进来的。最近 24 小时新配对的标"新"。
  - 每行"改名""撤销"。撤销有确认框；它带进来过别的设备时，可以勾"同时撤销它带进来的 N 台"。
  - 从别的设备看这台时，自己那一行标"这台电脑"，不给撤销。
- **配对成功提示。** 有新设备配对到这台电脑时，不管界面正在看哪台，都弹一条提示：新设备「X」（类型，来自地址）已经配对；不是你操作的，到「允许别的设备连接」撤销。
- **扫码不再互相打断。**
  - 一台设备正在扫码添加 Bot 时，另一台再点"添加 Bot"，会被告知"另一台设备「X」正在扫码添加 Bot，等它完成后再试"，不会把对方的二维码弄没。今天是后点的把先点的取消掉。
  - 扫码的那台网络断了，任务留 60 秒，同一台重新连上就接着显示二维码，不用重扫。
  - 命令行 `vonvon bot add` 按 Ctrl-C 照旧立刻取消。

依赖：
- D1：`device.*` RPC、`clients.json`、`client-paired` 事件。
- D3：远程监听、`device.enable/disable/status`、撤销断连；`remoteAddressStateSchema` 里的 `failed`（D3 计划 4.5，页面的"开不了"靠它）。
- U1a：`useActiveDevice`、`shell.onLocalDeviceEvent`。
- U1b：`DesktopRoot`、`TailscaleAdvice`。
- U2：`device-copy.ts`；"应用与启动"页在远程时的结构。U2 后合入时，本片的面板照样能放，只是标题少一个设备名。

## 2. 范围

做：
- UI：
  - 新文件：`U/settings/RemoteAccessPanel.tsx`、`U/settings/remote-access-presentation.ts`、`U/devices/PairedToasts.tsx`、`U/settings/remote-access.css`；
  - 改：`U/App.tsx`（应用与启动页）、`U/main.tsx`（U1b 的 `DesktopRoot` 挂提示）、`U/search.ts`。
- protocol `P/device.ts`：`deviceStatusSchema` 加 `candidates`、`via`；`clients` 回复加 `self`；`commandResultSchema` 不变（6.3 用已有的 `refused`）；D3 没给 `remoteAddressStateSchema` 加 `failed` 时由本片加（4.1）。
- daemon：
  - `D/server/rpc/device.ts`、新文件 `D/remote/candidates.ts`；
  - `D/remote/tailscale.ts`：认 macOS、Windows 上 Tailscale 自带的命令行；`isTailscale` 认 Windows 的网卡（下面"Windows 的 Tailscale 地址"）；
  - 新文件 `D/server/peer-label.ts`；
  - `D/server/jobs.ts`、`D/server/rpc/command.ts`；
  - `D/server/peer-hub.ts`（D2）加 `attached` 回调；`D/server/http.ts` 接线；
  - D3 撤销处（`clients.onChange`）加 `jobs.cancelOwner`；
  - `D/cli/commands/bot.ts`：`job_running` 被拒时 exit 4、`lost` 的文字、注释。
- 文档：设计 6.3、第 15 节（已在本计划的 PR 里改，第 7 节）。

不做：
- 改端口的界面：端口一改，所有已配对的客户端手里的地址都失效，只给命令。要做得先让客户端能跟着改，进"v1 之后"。
- 二维码：设计 6.2 不做。
- 远程设备上的 Bot 扫码"接管"：设计 6.3 SCOPE-1 不做。
- 桌面端自带服务端的远程升级：U4。

## 3. 现在的代码

- **`device` RPC**（D1 分支 `D/server/rpc/device.ts`）：
  - `pair`（25-37）用 `remote.json` 里开着的地址拼链接，`invitedBy` 是发起的那台的 `clientId`，本机是 `'local'`；没有地址时报 `no_remote_address`。
  - `clients`（38）回全部记录，包括已撤销的墓碑。
  - `renameClient`（39-42）、`revokeClient`（44，`cascade` 按 `invitedBy` 链往下全撤）、`rename`（45，经 `holdDevice` 排队）。
  - `status/enable/disable/setPort` 由 D3 补（D3 计划 4.7）。
- **D3 的 `status`** 回已开启的地址 `{ host, kind, enabledAt, state, detail? }`、端口、`clients.{total, active}`。**没有"这台设备有哪些地址可选"**，面板没法列候选；也不知道调用者是从哪个地址连进来的。`state` 的枚举（D1 分支 `P/device.ts:61` 的 `remoteAddressStateSchema`）只有 `listening`、`waiting`、`needs-confirmation`、`disabled`，可 D3 的监听器遇到别的绑定错误会记 `failed`（D3 计划 4.5）。
- **CLI 被拒时的退出码**：`bot.ts:225` 把 `refused` 抛成 `CommandError('failed', …)`，退出码 1（`cli/command-error.ts:4`：`refused` 是 4，`failed` 是 1）。C2 计划把 `registration_busy` 定成 1（`docs/plans/cli-2-bot.md:54`，`cli-admin.test.ts:217` 在测），别的 `bot` 子命令被拒都是 4。
- **Tailscale 判定**（D3 计划 4.3）：
  - 100.64/10 的地址要在 `tailscale*` 网卡上，或者在 `utun*` 网卡上**且**出现在 `tailscale ip` 的输出里。
  - `tailscale` 命令找不到就当没装。
  - Mac 上的 Tailscale 应用默认不把命令放进 PATH（命令在应用包里），后台服务的 PATH 更短，所以 Mac 当被连的设备时，它的 Tailscale 地址会被认成"运营商分配的地址"，要用户确认风险。这是 D3 漏的，本片补。
- **事件**：配对成功时 daemon 发 `device` 事件 `{ change: 'client-paired', clientId, name, clientKind, address?, invitedBy? }`（D1 分支 `P/device.ts:103-108`）。U1a 在主进程订阅本机连接上的这个事件，经 `shell.onLocalDeviceEvent` 交给页面（U1a 4.5 的 `watchLocal`、4.6 的 `localDevice` 事件和 `shell.onLocalDeviceEvent`）。
- **扫码任务**（`D/server/jobs.ts`）：
  - `startRegistration`（66-109）在 68 行无条件取消已有的注册任务，然后新开一个。任务记 `owner: peer.id`（70）。
  - `detach(peer)`（219-222）在连接断开时取消它拥有的任务。`http.ts:204` 在 socket 关闭时调 `jobs.detach`。D3 在撤销断连时也调（D3 计划 4.6）。
  - 任务状态经快照推给所有客户端（`set` → `changed`），谁都看得到二维码。`cancel(id)`（129-137）不看是谁发的。
  - CLI `bot add` 的 `follow`（`D/cli/commands/bot.ts:128-208`）：Ctrl-C 先发 `cancelJob`（178）；`refused` 照样打印并退出（198-199）。124-126 的注释写着"连接断开由 daemon 取消"。
- **页面里的提示**：`U/PendingGroupToasts.tsx` 是现成的提示写法（右下角、`aria-live`、可关）。

## 4. 怎么改

### 4.1 协议（`P/device.ts`）

```ts
const candidateSchema = z.object({ host: z.string(), kind: addressKindSchema.exclude(['loopback']), iface: z.string().optional() }).strict();
// deviceStatusSchema：
//   remote 里加 candidates: z.array(candidateSchema).optional()   —— 这台设备此刻能开的地址，已开的也在里面
//   顶层加   via: z.string().optional()                           —— 调用者连进来的监听地址；本机 loopback 连接没有
// deviceReplySchema 的 clients 加 self: z.string().optional()      —— 调用者自己的 clientId；本机连接没有
```

都是可选字段。这几个 schema 是 `.strict()` 的：旧客户端解析新服务端的回复会失败。但 `device.*` 不在维护子集里，只在协议相同时才会发，而协议 2 的客户端和服务端都出自这一批，所以没有旧客户端会碰到。

`remoteAddressStateSchema` 要有 `'failed'`：D3 的监听器会给，页面的"开不了"也靠它，没有的话带一个 `failed` 地址的 `device.status` 整条回复解析失败，面板什么都显示不出来。D3 计划 4.5 已经写了这一步；D3 合入时没做，本片在 `P/device.ts` 加，连同一例解析测试（第 5 节）。

### 4.2 daemon

**`D/remote/candidates.ts`（新）**

```ts
export interface Candidate { host: string; kind: Exclude<AddressKind, 'loopback'>; iface?: string }
export interface Candidates { list(): Promise<Candidate[]>; clear(): void }
export function createCandidates(deps: { interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>; tailscale: () => Promise<{ installed: boolean; ips: string[] }>; now?: () => number }): Candidates;
```

- 取全部网卡上 `internal: false` 的地址：
  - IPv4 去掉 169.254/16；
  - IPv6 只留 Tailscale 段 `fd7a:115c:a1e0::/48`（别的 IPv6 局域网地址会变，先不列）。
- 每个用 D3 的 `classifyAddress(host, { interfaces, tailscale })` 分类，`iface` 取 `interfaceFor(host).name`，去掉 `invalid` 和 `loopback`。
- 排序：tailscale、lan、cgnat、public，同类按网卡名。
- 结果缓存 30 秒，`tailscale()` 最多 5 秒（D3 的超时）。缓存挂在 `createCandidates` 建出的对象上，不放在模块里：`http.ts` 建一个放进 `rpc/device.ts` 的 deps，测试各建各的，同一个 vitest 进程里的用例不会互相串。`device.enable/disable` 后 `clear()`。
- 取舍：Tailscale 刚启动时，新地址最多 30 秒后才出现在候选里（面板每 10 秒读一次，不用用户动手）。不加"跳过缓存"的参数：那要改 D1 定的 `device.status` 请求形状，30 秒可以接受。

**`D/remote/tailscale.ts`（补 D3）**

`tailscale ip` 找不到命令（ENOENT）时再按顺序试：
- macOS：`/Applications/Tailscale.app/Contents/MacOS/Tailscale`（Tailscale 文档写的应用自带命令行的位置）；
- Windows：`%ProgramFiles%\Tailscale\tailscale.exe`（从 `process.env.ProgramFiles` 拼，没有这个变量就跳过）。

都找不到才回 `installed: false`。参数照旧，`execFile` 不经 shell。测试注入 `exec`，按路径回结果。

**Windows 的 Tailscale 地址（补 D3 的 `isTailscale`）**

D3 计划 4.3 原来的规则：100.64/10 要么在名字以 `tailscale` 开头的网卡上（区分大小写），要么在 `utun*` 网卡上且 `ts.ips` 含它。Windows 上 Tailscale 的网卡名是 `Tailscale`（大写 T），两条都不命中，面板里就没有"Tailscale（推荐）"那一行。改成（D3 计划 4.3 已同步改，两边一份）：
- `ts.ips` 含这个地址 → `tailscale`，不看网卡名。`tailscale ip` 说是它自己的地址，就是它的。macOS 的 `utun*`、Windows 都靠这一条。
- 否则网卡名不区分大小写以 `tailscale` 开头 → `tailscale`：Linux 的 `tailscale0`、Windows 的 `Tailscale`。没装命令行（`ts.ips` 为空）时靠它。
- 都不满足的 100.64/10 照旧是 `cgnat`。
- D3 合入时已经是这个规则，本片不改；还是原来的规则，本片改 `D/remote/tailscale.ts` 的 `isTailscale` 这一个函数。

**`D/server/rpc/device.ts`**

- 签名：`deviceRpc(deps, peer: Pick<Peer, 'principal' | 'listener'>, request)`。
- `peer.listener`：D3 加的（D3 计划 4.5 末尾：D2 的 `SecureSocketServerOptions.listenerId` 记到 `Peer.listener`），是这条连接进来的那个监听地址；loopback 连接没有。
- `status`：在 D3 的回复上加：
  - `remote.candidates = await deps.candidates.list()`；
  - `via: peer.listener`。
- `clients`、`renameClient`：principal 是 `owner` 且 `via === 'paired'` 时加 `self: principal.clientId`。
- `enable`、`disable` 成功后 `deps.candidates.clear()`。

**`D/server/peer-label.ts`（新）**

```ts
export interface PeerOwner { key: string; label: string }
/** "这台电脑上的桌面端 / 命令行 / 网页端"，不认识的 clientKind 是"这台电脑上的客户端"。U4 的 peerName 也用它。 */
export function localPeerLabel(clientKind: string | undefined): string;
/** 配对来的客户端的名字，找不到是"未知设备"。U4 的 peerName 也用它。 */
export function pairedPeerName(clientId: string, clients: Pick<ClientRegistry, 'get'>): string;
/** 扫码任务的归属（设计 6.3）：配对来的按 clientId，本机按 clientKind。bot 会话、维护连接没有。 */
export function peerOwner(peer: Pick<Peer, 'principal' | 'clientKind'>, clients: Pick<ClientRegistry, 'get'>): PeerOwner | undefined;
// 配对来的：{ key: `paired:${clientId}`, label: `另一台设备「${pairedPeerName(clientId, clients)}」` }
// 本机：    { key: `local:${clientKind ?? 'unknown'}`, label: localPeerLabel(clientKind) }
```

"这台电脑上的…"的对照表只在 `localPeerLabel` 里有一份。U4 在同一个文件里加 `peerName`（"「<名字>」"或 `localPeerLabel(...)`），本片先合入，U4 从合了本片的集成分支开（设计第 13 节 U4 行已加这条依赖）。

**`D/server/jobs.ts`（设计 6.3）**

```ts
interface Registration { /* 原有 */ owner: string; ownerKey?: string; ownerLabel?: string; holders?: Set<string>; grace?: NodeJS.Timeout; agentId?: string }
startRegistration(peer: JobPeer, agentId?: string, owner?: PeerOwner): CommandResult;
attach(peer: JobPeer, owner: PeerOwner | undefined): void;     // 新
detach(peer: JobPeer): void;                                   // 签名不变，行为加宽限
cancelOwner(ownerKey: string): void;                           // 新：撤销时用
```

`holders` 是同一个 key 下现在连着的连接（peer id）。有 `ownerKey` 的任务按它判断"还有没有人在"，不再只看开任务的那一条连接；没有 `ownerKey` 的任务照今天只看 `owner`。

- `startRegistration`（68 行那一句改掉）：已有未结束的注册任务 `current` 时：
  - `owner` 缺或 `current.ownerKey` 缺，或 `owner.key === current.ownerKey` → 照今天：取消旧的，开新的。同一台点两次"添加 Bot"就是重来。
  - 否则回 `{ kind: 'refused', code: 'job_running', message }`，不动旧任务。`message`：
    - 添加：`${current.ownerLabel}正在扫码添加 Bot，等它完成后再试。`
    - 重新扫码（`current.agentId` 有值）：`${current.ownerLabel}正在为一个 Bot 重新扫码，等它完成后再试。`
- 新任务记 `ownerKey`、`ownerLabel`、`agentId`；有 `ownerKey` 时 `holders` 是开任务的这条连接，加上同一个 key 下此刻连着的全部连接。`Jobs` 为此记一张"连接 id → key"的表（`connected`）：`attach` 记上，`detach` 删掉。只放开任务这一条不够：两个本机网页标签页（都是 `local:web`）先连上，在一个里开始扫码，两个都看到二维码；关掉开任务的那个，另一个一直连着，任务却只记了前一条，60 秒后照样被取消（Codex 审查 267-1、268-1）。
- `detach(peer)`（219-222）：
  - 先从 `connected` 删掉这条连接。
  - 对未结束的注册任务：
    - 任务没有 `ownerKey` → `owner === peer.id` 时照今天立刻取消；
    - 有 → `holders.delete(peer.id)`；删完空了，`entry.grace = setTimeout(() => this.cancelRegistration(entry), 60_000)`，`unref()`；还有别的持有者就什么都不做。
  - 后端安装的 peer 照旧移除。
- `cancelOwner(ownerKey)`：`ownerKey` 相同的未结束注册任务立刻取消，不管它的连接还在、还是已经断开在宽限里；先 `clearTimeout(entry.grace)`。
- `attach(peer, owner)`：`owner` 有值时，先把这条连接记进 `connected`（之后同 key 开的任务也算它一份），再对每个 `ownerKey === owner.key` 的未结束注册任务：`holders.add(peer.id)`；有 `grace` 就 `clearTimeout`、清掉。**不管任务在不在宽限里都加。** 换网络时常见的顺序是新连接先连上、服务端过一会儿才发现旧连接断了；只在宽限里才接手的话，旧连接随后的 `detach` 会给一个同 key 客户端还连着的任务起 60 秒宽限，然后把它取消。
- 取舍：同一个 key 下的任何连接都算持有者，包括本机 `vonvon bot list` 这类短命令（key 都是 `local:cli`）。任务的主人还连着时没有影响，短命令断开后还有别的持有者；任务已经在宽限里时，来一条短命令会把 60 秒重新算一次。上限是二维码自己的 10 分钟有效期，到了 SDK 照样让任务失败。不按连接用途区分：daemon 分不出一条连接是不是在看这个任务。
- `cancelRegistration`（110-115）、`close`（223-237）：先 `clearTimeout(entry.grace)`。
- 结束（`finally`，103-107）时也清。

和设计的出入：设计写回新的 `{ kind: 'jobRunning', jobId, owner }`，本片用已有的 `refused` 加 `code: 'job_running'`。理由：
- 网页端的 `run()`（`U/App.tsx:321-345`）和 CLI 的 `follow`（`bot.ts:198-199`）已经把 `refused` 的 `message` 显示出来，不用改显示；
- `jobId` 对拒绝方没有用（任务在快照里本来就看得到）。
设计 6.3 已按这个改（第 7 节）。

CLI 只改退出码：`bot.ts:225` 的 `case 'refused'` 改成 `code === 'job_running'` 时抛 `CommandError('refused', …)`（exit 4），和别的 `bot` 子命令被拒一致；其余的 `refused`（今天只有 `registration_busy`）照 C2 计划留在 `failed`（exit 1），`cli-admin.test.ts:217` 不用改。`runBotAdd` 的注释补一句"4 when another client is scanning"。

**接线**

- D2 的 `createPeerHub(options: { detached(peer), attached?(peer) })`：`add(peer)` 末尾调 `attached`。
- `http.ts:204` 一带：
  - `attached: peer => jobs.attach(peer, peerOwner(peer, clients))`；
  - `detached` 照旧调 `jobs.detach(peer)`。
- D3 撤销处（D3 计划 4.6 的 `clients.onChange` 回调）开头先 `` for (const id of revokedIds) jobs.cancelOwner(`paired:${id}`) ``，再照 D3 走 `jobs.detach`、`closeWhere(4003)`。
  - 这样被撤销的客户端名下的任务马上取消，它此刻连着、或已经断开在宽限里都一样。
  - 只靠断连时的 `detach` 不够：先断开、后撤销时，撤销关不到任何连接，任务要等 60 秒宽限满了才停，而被撤的那台已经连不回来。
  - 先取消再 `detach`：`detach` 看到任务已经结束，不会再给它起宽限的定时器。
- `D/server/rpc/command.ts` 的 `registerAgent`、`refreshAgentCredentials` 两个分支把 `peerOwner(peer, clients)` 传给 `startRegistration`。
- `D/cli/commands/bot.ts:124-126` 的注释改成"连接断开后 daemon 留 60 秒，同一个客户端回来就接着，不回来就取消"。Ctrl-C 那一路（178）不变。
- `bot.ts` 的 `case 'lost'`（二维码出来前断线，exit 3）原来写"和 daemon 的连接断了，扫码已经取消"，有了宽限就不对了。改成"和 daemon 的连接断了。扫码任务要是已经开了，会再留 60 秒，之后自动取消；重新运行 `<again>` 会重新开始。"（断在 `registerAgent` 回复之前时任务可能还没开；同一个 key 再开就是取消旧的、开新的。）

### 4.3 UI：`U/settings/remote-access-presentation.ts`（纯函数，全部文案）

```ts
export const KIND_LABEL: Record<'tailscale' | 'lan' | 'cgnat' | 'public', string>;
// { tailscale: 'Tailscale（推荐）', lan: '局域网', cgnat: '运营商分配的地址', public: '公网地址' }
export const STATE_LABEL: Record<'listening' | 'waiting' | 'needs-confirmation' | 'disabled' | 'failed', string>;
// { listening: '监听中', waiting: '等地址出现', 'needs-confirmation': '网络变了，要确认', disabled: '已关闭', failed: '开不了' }
export interface AddressRow { host: string; kind: string; iface?: string; enabled: boolean; state?: string; detail?: string; current: boolean }
/** 已开的和候选合在一起：已开的排前面；已开但网卡上已经没有的也列出来（state 是 waiting）。current：调用者就是从它连进来的。 */
export function addressRows(status: DeviceStatus): AddressRow[];
export function needsRiskConfirm(kind: string): boolean;       // cgnat、public
export function riskText(row: AddressRow): string;             // 设计第 15 节"100.x 但不是 Tailscale"或"公网地址警告"（桌面端那半句）
export function linkCountdown(expiresAt: number, now: number): string;   // "还剩 9 分 12 秒" / "已过期"
export const CLIENT_KIND_LABEL: Record<string, string>;        // desktop 桌面端，cli 命令行，web 网页端
export function liveClients(reply: Extract<DeviceReply, { kind: 'clients' }>): ClientRecord[];   // 去掉墓碑，按 lastSeenAt 倒序
export function isRecent(client: ClientRecord, now: number): boolean;  // createdAt 在 24 小时内
export function invitedByText(client: ClientRecord, all: ClientRecord[]): string;
// 'local' → "在这台设备上生成的链接"；别的 → "由「<名字>」带进来"；找不到 → "由一台已删除的设备带进来"
export function cascadeCount(all: ClientRecord[], clientId: string): number;   // 只数没撤销的、沿 invitedBy 往下的全部
export function revokeConfirmText(name: string): string;      // 设计第 15 节"撤销确认"
export function pairedToastText(event: DeviceEventPayload): string;   // 设计第 15 节"新客户端配对成功"
export function enableErrorText(code: string, message: string): string;   // tailscale_unavailable、confirm_required、invalid_request 原样；别的"开不了：<message>"
```

`riskText` 末尾"确定要开启请加 `--allow-public`（桌面端：勾选"我了解风险"）"在界面上只留"勾选「我了解风险」后再开启"。

### 4.4 UI：`U/settings/RemoteAccessPanel.tsx`

挂在"应用与启动"页（`U/App.tsx:898-920`）的最后一组。本机和远程都显示，管的是当前设备（`useClient().device`）。标题：
- 本机："允许别的设备连接"；
- 远程："允许别的设备连接「X」"。

```tsx
export function RemoteAccessPanel(): JSX.Element
```

状态：`status`（`device.status`）、`clients`（`device.clients`）、`link`（`{ text, expiresAt }`，只在组件 state 里）、`confirm`（风险、关当前地址、撤销三种确认）、`busy`、`message`。

读数据：
- 挂上时各读一次。
- 页面在显示时每 10 秒读一次 `status` 和 `clients`；`document.visibilityState` 变成 hidden 就停。
- 本机时，`shell.onLocalDeviceEvent` 来事件就立刻读一次 `clients`。
- 读失败：`unsupported` 写"「X」上的 Vonvon Bot 太旧，不支持这里的设置"；其他错误照原文。

**设备名字**：一行"设备名字：<status.device.name>"，[改名] → 行内输入（1–40 字）→ `device.rename`。说明："别的设备配对时看到的名字。"

**地址**：`addressRows(status)` 每行：
- 勾选框、`host`、`KIND_LABEL`、网卡名（小字）、状态（`STATE_LABEL` + `detail`）。
- 勾上：
  - `needsRiskConfirm(kind)` → 开风险确认框：正文 `riskText(row)` + 勾选框"我了解风险"，勾了"开启"才可点 → `device.enable { host, allowPublic: true }`。
  - 否则 → `device.enable { host }`。
  - 回 `confirm_required`（比如两次读之间网卡变了，分类变成 cgnat）→ 同样开风险确认框，正文用回复的 `message`。
- 取消勾选：
  - `row.current`（远程时就是从这个地址连进来的）→ 先确认："你现在就是通过这个地址连着「X」的。关掉后这台电脑会马上断开，要到那台设备上重新开启。"
  - → `device.disable { host }`。
- `needs-confirmation` 行多一个按钮"确认并重新开启" → `device.enable { host }`。D3 重新记网络标识。
- 每次操作后用回复里的 `deviceStatus` 刷新。

地址下面：
- 端口一行："端口 7767"。说明：本机"要改端口，在终端运行 `vonvon remote port <端口>`；已配对的设备要重新配对。"；远程把"在终端"换成"在「X」的终端"。
- 候选里没有 `tailscale` 时，放 U1b 的 `<TailscaleAdvice/>`。

**连接链接**：
- [生成连接链接]：已开的地址里没有 `listening` 的就灰掉，旁边写"先在上面勾一个地址"。
- 点了 → `device.pair` → 显示链接（只读输入框，点一下全选）、[复制]（`navigator.clipboard.writeText`）、`linkCountdown` 每秒刷新、[再生成一个]。
- 到期后链接清掉，写"链接过期了，再生成一个"。
- 说明一句（设计第 15 节 `vonvon pair` 输出的前半句）："把这条链接粘到另一台电脑的 Vonvon Bot → 设置 → 设备 → 添加。10 分钟内有效，只能用一次，别发给别人。"
- 错误：`pairing_limit`、`no_remote_address` 显示回复原文。
- 链接不写日志，不放进 `localStorage`；离开页面就没了。

**已配对的客户端**：`liveClients(reply)`，每行：
- 名字（`isRecent` 时后面一个"新"）、`CLIENT_KIND_LABEL`；
- "上次连接 <相对时间>，来自 <lastAddress>"；
- `invitedByText`；
- `clientId === reply.self` → 名字后标"这台电脑"，没有撤销按钮，写"要断开，到「设备」页删除这台"；
- [改名] → 行内输入 → `device.renameClient`；
- [撤销] → 确认框：`revokeConfirmText(name)`；`cascadeCount > 0` 时加勾选框"同时撤销它带进来的 N 台"（默认不勾）→ `device.revokeClient { clientId, cascade }` → 回复的 `revoked` 写进提示"已撤销 N 台"，再读一次列表。
- 没有客户端："还没有别的设备连过来。"

**搜索**：`U/search.ts` 加一项 `{ page: 'application', section: '允许别的设备连接', fields: ['地址', 'Tailscale', '连接链接', '已配对的客户端', '撤销', '设备名字'] }`。

### 4.5 UI：配对成功提示 `U/devices/PairedToasts.tsx`

- 挂在 U1b 的 `DesktopRoot`（`U/main.tsx`），和 `DeviceGate` 并列，所以切到别的设备时也看得到。
- 订阅 `shell.onLocalDeviceEvent`，只收 `change === 'client-paired'`，最多同时显示 2 条，按 `clientId` 去重。
- 样式同 `PendingGroupToasts`：
  - 正文 `pairedToastText(event)`；
  - 按钮 [查看]：只在当前是本机时给，跳到应用与启动页的"允许别的设备连接"（`settingAnchor`）；
  - [关闭]。
- 不自动消失，用户关掉为止。没看到的，列表里还有"新"的标记。
- 网页端没有 `onLocalDeviceEvent`，不显示。网页端本来只连本机。

### 4.6 "应用与启动"页的位置

- `App.tsx` 应用与启动页在 `UpdatePanel` 之后放 `<RemoteAccessPanel/>`。
- U2 已合入时，放在远程的"后台服务"组之后、本机的"启动选项"组之后。
- 这一组不进"高级运行设置"，因为配对是常用操作。

### 4.7 顺序

1. 协议（4.1）、`candidates.ts`、`tailscale.ts` 的补丁、`rpc/device.ts`。
2. `peer-label.ts`、`jobs.ts`、接线、CLI 注释。
3. presentation、面板、提示、搜索。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/remote-candidates.test.ts`（新） | 列候选 | 注入网卡：`en0` 192.168.1.9、`utun4` 100.64.0.10（`tailscale ip` 含它）、`eth1` 100.70.0.3（不在输出里）、`lo0` 127.0.0.1、`en1` 169.254.3.4、`en0` fe80::1 → `[{100.64.0.10, tailscale, utun4}, {192.168.1.9, lan, en0}, {100.70.0.3, cgnat, eth1}]`。main 必败 |
| 同上 | 缓存 | 同一个 `createCandidates` 对象 30 秒内第二次不调 `interfaces`；`clear()` 后再调；两个对象互不影响 |
| `daemon/test/remote-tailscale.test.ts`（D3 的，改） | 应用自带的命令 | 注入 `platform:'darwin'`，`tailscale` 回 ENOENT、应用包路径回 `100.64.0.10` → `installed: true, ips: ['100.64.0.10']`；win32 同理用 `ProgramFiles`；都 ENOENT → `installed: false`。main 必败 |
| `daemon/test/remote-address.test.ts`（D3 的，改） | Windows 的网卡 | `100.100.1.1` 在 `Tailscale` 网卡上、`ts.ips` 为空 → `tailscale`；在 `Ethernet` 上、`ts.ips` 含它 → `tailscale`；在 `utun3` 上、`ts.ips` 含它 → `tailscale`；在 `eth0` 上、`ts.ips` 不含 → `cgnat`。main 必败 |
| `daemon/test/remote-candidates.test.ts` | Windows | 按 Windows 的样子注入网卡：`Tailscale` 100.64.0.10（`ts.ips` 含它）、`Ethernet` 192.168.1.9 → 第一行 `{100.64.0.10, tailscale, Tailscale}`，"允许别的设备连接"里就有"Tailscale（推荐）"那一行 |
| `daemon/test/rpc-device-remote.test.ts`（D3 的，改） | 撤销取消任务 | 配对连接 A 开注册任务后断开（任务进宽限），本机连接 `device.revokeClient` A → 快照里任务马上是 `cancelled`，不等 60 秒。main 必败 |
| 同上 | status 加字段 | 本机连接 → 有 `candidates`、没有 `via`；配对连接经 100.64.0.10 进来 → `via: '100.64.0.10'` |
| 同上 | self | 配对连接调 `clients` → `self` 是它的 `clientId`；本机没有 |
| `daemon/test/peer-label.test.ts`（新） | 归属 | 配对 `cl_…`、名字"Clay 的 MacBook" → `paired:cl_…`、"另一台设备「Clay 的 MacBook」"；本机 `cli` → `local:cli`、"这台电脑上的命令行"；bot 会话 → `undefined` |
| `daemon/test/server-jobs.test.ts`（改） | 不同客户端 | A 开注册 → B（不同 key）开 → `refused`、`code: 'job_running'`、message 含"另一台设备「A」正在扫码添加 Bot"；A 的任务还在 `qr`。main 必败 |
| 同上 | 同一客户端 | A 开 → A（同 key，新连接）开 → 旧的 `cancelled`、新的 `started` |
| 同上 | 重新扫码的文字 | A 用 `refreshAgentCredentials` 开 → B 开 → message 含"重新扫码" |
| 同上 | 宽限 | 假时钟：A 开 → `detach(A)` → 59 秒仍是 `qr`；60 秒 → `cancelled`。main 必败 |
| 同上 | 回来续上 | A 开 → `detach(A)` → 30 秒时 `attach(A2, 同 key)` → 再过 60 秒仍是 `qr`；`detach(A2)` 后 60 秒 `cancelled` |
| 同上 | 先连上、后发现旧的断了 | A 开 → `attach(A2, 同 key)` → `detach(A)` → 60 秒后仍是 `qr`，没有宽限定时器；`detach(A2)` 后 60 秒 `cancelled`。main 必败 |
| 同上 | 短命令 | A 开 → `attach(B, 同 key)` → `detach(B)` → 60 秒后仍是 `qr`（A 还连着）；`attach(C, 不同 key)` 不进持有者 |
| 同上 | 撤销（连着） | A 开 → `cancelOwner('paired:A')` → 立刻 `cancelled`；之后 `detach(A)` 不起定时器（`vi.getTimerCount()` 为 0） |
| 同上 | 撤销（宽限中） | A 开 → `detach(A)` → 10 秒后 `cancelOwner('paired:A')` → 立刻 `cancelled`，宽限的定时器清掉；`cancelOwner('paired:B')` 不动 A 的任务 |
| 同上 | 没有 key | `startRegistration(peer)` 不传 owner（旧测试的写法）→ 行为同今天：后开的取消先开的，断开立刻取消 |
| 同上 | 关闭 | 宽限中 `close()` → 定时器清掉，进程能退出（`vi.getTimerCount()` 为 0） |
| `daemon/test/peer-hub.test.ts`（D2 的，改） | attached | `add(peer)` → `attached` 被调一次 |
| `daemon/test/cli-bot.test.ts`（改） | 被拒 | `registerAgent` 回 `refused job_running` → 打印 message、exit 4（`CommandError('refused')`），没有发 `cancelJob`。main 必败（今天是 exit 1） |
| 同上 | 断线的文字 | 二维码出来前断线 → exit 3，文字含"会再留 60 秒"，不再说"扫码已经取消" |
| `daemon/test/cli-admin.test.ts:217` | 不改 | `registration_busy` 仍 exit 1 |
| `protocol/test/device.test.ts`（改，D3 已加就不重复） | 地址状态 | `device.status` 带 `{ state: 'failed', detail: 'EACCES' }` 的地址往返解析通过。main 必败 |
| `ui/test/remote-access-presentation.test.ts`（新） | 地址行 | 已开 tailscale（`listening`）+ 候选 lan、cgnat → 三行、tailscale 在前且勾上；已开但候选里没有的 → 仍列出、`state` 为 `waiting`；`via` 等于某行 → 那行 `current`。main 必败 |
| 同上 | 级联数 | A（local）、B（A）、C（B）、D（A，已撤销）→ `cascadeCount(A) = 2`；`cascadeCount(C) = 0` |
| 同上 | 带进来的 | `invitedBy: 'local'` → "在这台设备上生成的链接"；`invitedBy: A` → "由「A」带进来"；A 已不在 → "由一台已删除的设备带进来" |
| 同上 | 新 | `createdAt` 23 小时前 → 真；25 小时前 → 假 |
| 同上 | 提示文字 | `{name: '工作笔记本', clientKind: 'desktop', address: '100.64.0.10'}` → "新设备「工作笔记本」（桌面端，来自 100.64.0.10）已经配对…"；没有 `address` → 没有"来自" |
| 同上 | 用词 | 导出的文案里没有"服务器" |
| `ui/test/remote-access-panel.test.tsx`（新，假 client） | 风险确认 | 勾 cgnat → 确认框、"开启"灰；勾"我了解风险" → 可点 → 发 `enable {host, allowPublic: true}`。main 必败 |
| 同上 | `confirm_required` | 勾 lan，假 client 回 `confirm_required` → 确认框出现、正文是回复的 message |
| 同上 | 关当前地址 | 远程、`via` 是这行 → 取消勾选先出确认框；本机没有 |
| 同上 | 网络变了 | `needs-confirmation` 行 → "确认并重新开启"、发 `enable {host}` |
| 同上 | 链接 | 没有 `listening` → 按钮灰；有 → 点了显示链接和倒数；`expiresAt` 已过 → 链接清掉、"链接过期了" |
| 同上 | 撤销 | A 有两台下游 → 确认框有"同时撤销它带进来的 2 台"；勾上 → `revokeClient {cascade: true}` |
| 同上 | 自己那行 | `self` 是 B → B 行"这台电脑"、没有撤销 |
| `ui/test/paired-toasts.test.tsx`（新） | 提示 | `onLocalDeviceEvent` 发 `client-paired` → 出现；同一 `clientId` 两次 → 一条；`client-revoked` → 不出现；当前是远程 → 没有"查看" |
| `ui/test/search.test.ts`（改） | 搜索 | 搜"连接链接" → 应用与启动页的"允许别的设备连接" |

## 6. 自测和验收

**删除文件的硬规矩**（`~/.claude/CLAUDE.md`，原样照抄）：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

### 6.1 Claude 在 JP-VPS 上

1. 单测：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run <第 5 节列出的文件>`，然后在锁里跑 protocol、daemon、ui 的 `typecheck`、`lint`、`build`。最后 `rm -rf -- "${T:?}"`。
2. 验收 daemon 上的真流程。先拿锁、切 sha，同 U1b 6.2 的准备 1、2 步。然后：
   - `vonvon remote status --json` 有 `candidates`，Tailscale 地址标 `tailscale`；
   - 扫码归属要两个**不同的** key：两个终端里的 `vonvon bot add` 都是 `local:cli`，按 4.2 是同一个客户端，第二个会接手、不会被拒。所以：
     - 用 U1a 的探针以配对客户端身份发 `registerAgent`（key `paired:<id>`），快照里任务到 `qr`；再在本机跑 `VONVON_HOME=<验收数据目录> vonvon bot add --json` → 立刻 exit 4，输出含"另一台设备「…」正在扫码添加 Bot"；探针的任务还是 `qr`。探针发 `cancelJob`。
     - 反过来：本机先跑 `vonvon bot add --json`，探针再发 `registerAgent` → `refused`、`code: 'job_running'`，message 含"这台电脑上的命令行正在扫码添加 Bot"；本机的二维码链接还在刷新。
     - 同一个 key 接手：另一个终端也跑 `vonvon bot add --json` → 第一个的任务 `cancelled`、第一个命令 exit 1（"扫码被取消了…"），第二个出新的二维码链接。
   - 第二个 Ctrl-C → 任务 `cancelled`。
   - 宽限：用 U1a 的探针以配对客户端身份开注册任务，断开探针，35 秒内用同一份客户端密钥重连：快照里任务仍是 `qr`。再断开，70 秒后是 `cancelled`。
3. 页面截图（可选，给审查者看）：用 U1b 的 `devices-fake-shell.ts` 注入假状态，截"允许别的设备连接"的三种状态（没开地址、开了 tailscale 并生成链接、cgnat 确认框）和配对提示。只用假名字和文档地址段。
4. 收尾：验收 worktree 切回原来的 sha，重启验收 daemon，放锁。

### 6.2 Mac 上的 Codex（#322）

这一片要 Mac 当**被连的设备**：开 Tailscale 地址、生成链接，让另一台连进来。U2 的 Mac 验收还没发出去时，两片合成一个任务（U2 第 6 节）。

**网页控制**（Mac 上的网页端连 Mac 上的隔离 daemon）能做的：
1. 应用与启动 →"允许别的设备连接"：候选里 Tailscale 地址标"Tailscale（推荐）"。这一步验 4.2 对应用自带 Tailscale 命令的补丁：Mac 的 Tailscale 命令默认不在 PATH 里。
2. 勾 Tailscale 地址 → "监听中"。第一次在非回环地址上监听时，如果 Mac 开了应用防火墙（系统设置 → 网络 → 防火墙），会问是否允许传入连接：点允许（这一下要用 Computer Use）。没开就不会问。结果里写防火墙开没开、问没问；后面 JP-VPS 配对超时时先看是不是这里挡了。
3. 生成连接链接 → 有链接和倒数；复制按钮可用；再生成一个 → 换了一条。
4. 隔离 daemon 所在的 Mac 有局域网地址时，勾它 → "局域网"，不弹确认框。有 100.x 的非 Tailscale 地址时才验确认框；没有就写"没有这种地址，靠单测"。

**JP-VPS 当客户端**：
- Mac 生成的链接不经 GitHub。由 Mac 上的 Codex 用 `curl -fsS -X POST --data-binary @- http://<JP-VPS 的 Tailscale 地址>:<助手端口>/pair-remote` 发给 U1b 的验收助手。
- 本片给助手加三个接口，都不记链接：
  - `/pair-remote`：用 U1a 的通道探针以 `cli` 身份配对这条链接，回 `{ ok, clientName }`；
  - `/chain`：见第 7 步；
  - `/bot-add`：见第 9 步。
5. 配对成功后 3 秒内，Mac 的页面右下角出现"新设备「…」（命令行，来自 100.x…）已经配对…"。
6. 列表里出现这一台，标"新"，"在这台设备上生成的链接"。
7. `curl -fsS -X POST http://<JP-VPS 的 Tailscale 地址>:<助手端口>/chain`：探针以刚配上的身份连 Mac、调 `device.pair` 拿第二条链接，再用一份新钥匙配对它，名字"第二台" → Mac 的列表里第二台写"由「<第一台的名字>」带进来"。
8. 撤销第一台，勾"同时撤销它带进来的 1 台" → 两台都没了；助手 `/status` 显示两台都 `revokedAt`。
9. 扫码不打断：Mac 网页端点"添加 Bot" → 出现二维码 → 助手 `/bot-add`（探针以配对身份发 `registerAgent`）→ 回"另一台设备…正在扫码"，Mac 上的二维码还在。Mac 上取消扫码。

**Computer Use**（开发版桌面端）：
10. 开发版桌面端切到 JP-VPS 那台，"允许别的设备连接「验收设备 1」"能看到 JP-VPS 的地址；自己那一行标"这台电脑"、没有撤销。
11. 取消勾选 JP-VPS 的 Tailscale 地址 → 出"你现在就是通过这个地址连着…"的确认框 → 取消（不真的关）。
12. 看着 JP-VPS 那台时，Mac 本机发生配对（重复第 5 步）→ 提示照样出现，没有"查看"按钮。

提示词贴进 PR，任务贴 #322，任务号用 `next-mac-task.sh` 取。提示词写清：
- 第 0 步查开始和结果标记；开始前、每次 push 前都看有没有取消。
- 隔离：临时 worktree、隔离数据目录、开发版桌面端的前缀照 #322 正文，不 export。
- 不碰：owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和它的数据、飞书客户端。
- 隔离 daemon 开的远程地址在任务结束前全部关掉：`VONVON_HOME=<临时目录>/vh vonvon remote disable <地址>`。
- 上面三条删除规矩原样写进去。
- 打码：不贴链接、地址、群名、完整 id。

**Windows**（D 道）：Windows 桌面端当被连的设备（开地址、生成链接、被 Mac 配对、锁屏后仍在线），并进 U4 的 Windows 任务（U4 第 6 节），不单独发。

Claude 收尾：停助手；撤销验收中配对的客户端；验收 daemon 的 `remote disable`；验收 worktree 切回原来的 sha；放锁。

## 7. 文档

本计划的 PR 里已改：
- 设计 6.3：`jobRunning` 改成"回 `refused`、`code: 'job_running'`"，写理由；宽限的 key 写成 `paired:<clientId>`、`local:<clientKind>`；撤销不留宽限。
- 设计第 15 节：
  - "另一台正在扫码"一行改成三种：另一台设备、这台电脑上的别的客户端、重新扫码；
  - 加"关掉当前连着的地址"确认；
  - 加"改端口提示"。
- 设计 4.3 末尾：加 `device.status` 的 `candidates`、`via` 和 `clients` 的 `self`。

实现 PR 里改：
- `docs/product.md` 3.14 的"被连的设备"一段：面板的样子、扫码互不打断。
- 合入时在设计第 13 节 U3 行标"已合入"。

## 8. 验收要点

1. 面板管的是当前设备，本机和远程都能用；远程时关掉自己连着的地址要先确认。
2. 运营商地址、公网地址不经"我了解风险"开不了；daemon 回 `confirm_required` 也走同一个确认框。
3. 链接只在组件 state 里，不写日志、不存盘，过期就清。
4. 撤销的级联数按 `invitedBy` 链往下算，只数没撤销的；自己那行不给撤销。
5. 配对提示挂在 `DesktopRoot`，切到别的设备也看得到；不自动消失。
6. 扫码任务：
   - 不同客户端被拒，原任务不动；
   - 同一客户端重开就是重来；
   - 同一个 key 还有连接在（`holders` 不空）就不起宽限；全断了留 60 秒，同一个 key 回来续上，先连上后断开的顺序也一样；
   - 撤销立刻取消，连着的和已经断开在宽限里的都是（`clients.onChange` 里按 `ownerKey` 取消）；
   - 关闭时定时器清干净。
7. 没传归属时 `jobs` 的行为和今天一样（旧测试不改也过）。
8. Mac、Windows 上 Tailscale 自带的命令也能认出 Tailscale 地址；`ts.ips` 含的地址不看网卡名，网卡名按不区分大小写的 `tailscale` 前缀认（Windows 的 `Tailscale`）。
9. 新字段都是可选的；`remoteAddressStateSchema` 有 `failed`。
10. CLI 被别的客户端挡住（`job_running`）时 exit 4，`registration_busy` 仍是 1；二维码出来前断线的文字不再说"已经取消"。
11. 候选地址的缓存挂在对象上，测试互不串；"这台电脑上的…"的称呼只有 `localPeerLabel` 一份。
12. diff 里没有真实 id、密钥、本机路径和地址；示例地址只用文档段（100.64.0.0/10 的示例、192.168.1.x）。

## 9. 风险和行数

- 估计约 1,150 行（原估 ~1,000）：
  - 协议 20、`candidates.ts` 70、`tailscale.ts` 补丁 30、`rpc/device.ts` 30、`peer-label.ts` 30、`jobs.ts` 90、接线 30；
  - presentation 170、面板 380、提示 70、css 60、搜索 10、验收助手两个接口 60；
  - 测试约 450，压缩写，不计在上面。
  - 多出来的是候选地址（设计没有）和 Tailscale 命令的补丁。
- 审查：一个读整个 diff；`jobs.ts` 碰并发、定时器和关闭顺序，加一轮多角度审查（AGENTS.md）。
- **候选地址的 IPv6：** 只列 Tailscale 段。用户要用局域网 IPv6 只能用命令 `vonvon remote enable <地址>`。先不做，没人要。
- **宽限期间别人点"添加 Bot"：** 会被拒 60 秒。文案写了是哪台；要马上开，可以在任何一台上点二维码旁的"取消"（`cancelJob` 不看是谁发的，这是今天的行为，本片不收紧）。
- **Mac 上 Tailscale 命令的位置**按 Tailscale 文档写的应用包路径。Homebrew 装的开源版在 PATH 里，走原来的路径。Mac 验收第 1 步专门看这一条。
- **10 秒轮询：** 只在页面显示时跑，读的是内存里的状态，加一次网卡枚举（有 30 秒缓存），开销可以忽略。
- **防火墙：** 被连的那台第一次在非回环地址上监听时，macOS 的应用防火墙（开着时）和 Windows 防火墙会问要不要放行。不放行，表现是对面配对超时。真机验收里写了怎么点（6.2 第 2 步，Windows 在 U4 6.3 第 2 步）；给用户的提示归设计第 15 节"客户端连不上"那几句，本片不另加。

## 10. 审查后改了什么

2026-11-02，#640 上 Sonnet 审查（读整个 diff 一位，读 U2–U4 一位）。下面每条都接受了：

- 验收里两个终端各跑一次 `vonvon bot add`、期望第二个被拒，做不出来：两个都是 `local:cli`，按本片的规则第二个会接手。改成探针（`paired:<id>`）和本机命令行互相挡，另加同 key 接手的一步（6.1 第 2 步）。
- 计划和测试写 CLI 被拒时 exit 4，可 `bot.ts:225` 把 `refused` 抛成 `failed`（exit 1），计划又说 CLI 不用改。改成 `job_running` 时抛 `CommandError('refused')`，`registration_busy` 照 C2 计划留 1（4.2、第 5 节）。
- `attach` 原来只接手正在宽限里的任务。换网络时常见的顺序是新连接先连上、旧连接后断开，旧连接的 `detach` 会给一个同 key 客户端还连着的任务起宽限并取消它。改成任务记同 key 的全部连接（`holders`），全断了才起宽限；`attach` 不管在不在宽限都加进去。另一位审查者指出"随手一条短命令会续 60 秒"：写成取舍，上限是二维码的 10 分钟（4.2）。加了两例测试。
- `lost` 的文字说"扫码已经取消"，有了宽限不对，改了（4.2 接线）。
- 页面有"开不了"（`failed`），D3 的监听器也会给 `failed`，可 D1 的 `remoteAddressStateSchema` 没有这个值，带它的 `device.status` 会整条解析失败。D3 计划 4.5 加了这一步；本片写明依赖，D3 没做就由本片加（4.1、第 5 节）。
- 候选地址的 30 秒缓存放在模块里，同一个 vitest 进程的用例会互相串。改成挂在 `createCandidates` 建的对象上；没加"跳过缓存"的参数，理由写在 4.2。
- `peer-label.ts` 和 hub 的 `attached` 回调原来写成 U3、U4 谁先合入谁建，"这台电脑上的…"对照表也写了两份。改成本片先合入、导出 `localPeerLabel` 和 `pairedPeerName`，U4 用它们（4.2）。
- Mac 当被连的设备时没提应用防火墙，补了一句（6.2 第 2 步、第 9 节）。
- D1 的 sha 更新到 147b2619。

## 11. 实现时和计划不一样的地方

2026-11-02 实现时（A1 和 R1 之后）：

- **地址是单选加按钮，不是"勾上就开"。** 照 A1 和 owner 定的样子（Orca 那样）：一组单选，推荐的排第一；没开过时默认选推荐的，开着时选开着的那个。下面一个按钮按情况写"开启""换成这个地址""确认并重新开启"，旁边"关闭远程连接"。选了别的地址时按钮旁写"换了以后 <旧地址> 不再接受连接，已配对的设备要粘一次新链接。"。标签用 A1 `candidateLabel` 的说法："Tailscale（推荐）""组网 · ZeroTier""局域网""运营商地址（要确认）""公网（要确认）"，不是 4.3 的"运营商分配的地址""公网地址"。
- **换地址也先确认。** 有已配对的设备、或者调用者正是从旧地址连进来的，"换成这个地址"先弹确认：本机时写 A1 的"已配对的 N 台设备要换到新地址…只会更新地址，不用重新配对"；远程又正连着旧地址时写文首那句。运营商地址、公网地址的风险确认框里把这段接在后面，一个框问完。没有已配对的设备时直接换。
- **刷新按钮。** 组标题旁一个刷新按钮。daemon 的候选地址缓存 30 秒，按钮要能马上重列，所以 `device.status` 加了可选的 `refresh: true`（4.1 写的是不加跳过缓存的参数）；缓存仍挂在 `createCandidates` 建的对象上，测试不串。
- **列表跟着变化重读，本机和远程都一样。** 计划写"本机时 `shell.onLocalDeviceEvent` 来事件就读 `clients`"。实现用 `client.onDevice`：主连接上的设备事件本机和远程都有，远程页面也能马上看到新配对的设备。10 秒轮询和 `visibilitychange` 照计划。
- **称呼按"本机 / 设备名"（owner 2026-11-02，产品 3.14）。**
  - 组标题：本机"允许别的设备连接本机"，远程"允许别的设备连接「X」"。
  - `invitedByText` 的 `local`：本机页面"在本机生成的链接"，远程"在「X」上生成的链接"（计划是"在这台设备上生成的链接"）。
  - 端口说明用 U2 的 `onDeviceText`：本机"要改端口，在终端运行 `vonvon remote port <端口>`；改完已配对的设备要粘一次新链接。"，远程"在「X」的终端运行"。计划写"已配对的设备要重新配对"，A1 之后换端口只要粘新链接（A1 的 `remote port` 输出也这么说）。
  - 自己那行（只在远程页面出现）标"这台电脑"，写"这是你现在用的这台电脑。要断开，到「设备」页删掉「X」。"：远程页面不说"本机"。
  - 配对提示不管看哪台都弹，说的总是用户面前这台，所以标题"有新设备配对到这台电脑"、正文"可以管理这台电脑的 Vonvon Bot"，和设计第 15 节一致，不用"本机"。
  - 扫码被拒的称呼（`D/server/peer-label.ts`）：本机连接"本机的桌面端/命令行/网页端/客户端"（计划是"这台电脑上的…"）；被拒的是另一台设备时，本机连接的扫码写成"「<设备名>」上的…"（`PeerOwner.far`），免得远程页面上出现"本机"。配对客户端照旧"另一台设备「X」"。设计第 15 节那一行已改。
- **已配对的设备单独一组，搜索分两节。** 客户端列表放在"已配对的设备"组（不叫"已配对的客户端"），有自己的锚点；`U/search.ts` 分成"允许别的设备连接"（设备名字、地址、端口）、"连接链接"和"已配对的设备"三节（"连接链接"单列见下面 269-2），"已配对的客户端""撤销"作别名。
- **配对提示的"查看"从 App 外面跳。** `PairedToasts` 挂在 `DesktopRoot`，在 `App` 外面，拿不到 App 的导航。加了一个窗口事件 `OPEN_SETTING_EVENT`（`U/search.ts`），App 收到后打开"应用与启动"并滚到"已配对的设备"。
- **配对提示放右上角**（顶栏下面 96px），不是验收第 5 步写的右下角：右下角已经是新群提示（`PendingGroupToasts`），两种同时出现会叠在一起。
- **确认框用 `Dialog` 加自己的按钮，不用 `ConfirmDialog`。** `ConfirmDialog` 的 `pending` 会把"取消"也灰掉、按钮转圈；这里要的是"勾了我了解风险才能点开启"，取消一直可点。
- **CLI 的 `bot add` 测试在 `cli-admin.test.ts`**（第 5 节写的是 `cli-bot.test.ts`，`bot add` 的测试本来就在 `cli-admin`）。
- **两个旧测试跟着改了：**
  - `server-jobs-retained.test.ts`"拥有任务的连接断开就取消"：有了宽限，断开后任务留着；改成断开后任务没被取消，`api.close()` 时才取消、并等持久化完成。宽限本身用假时钟在 `server-jobs.test.ts` 测。
  - `cli-remote.test.ts` 的 `remote status --json`：多了 `candidates`（验收第 1 步要的），断言加上它，并核对没有 `hidden`。
- **Codex 审查 267、268、269 之后（2026-11-02）：**
  - 扫码前就连着的同 key 连接也算持有者（267-1、268-1）。4.2 原来写新任务的 `holders` 只有开任务的那一条，`attach` 又只补给已经开着的任务，两个本机网页标签页先连上、再在一个里扫码时，关掉开任务的那个，另一个连着也会在 60 秒后被取消，违背设计 6.3。`Jobs` 加了 `connected`（连接 id → key，`attach` 记、`detach` 删），开任务时同 key 的全部连接一起进 `holders`；之后的 `attach`/`detach` 增减、撤销先 `cancelOwner` 再 `closeWhere`、`close()` 立刻取消都没变。测试：`server-jobs.test.ts` 假时钟两例（先连两条、后扫码、断一条过 60 秒仍在，最后一条断开才起 60 秒；扫码前已经断开的连接不算），`server-jobs-retained.test.ts` 真回环 WebSocket 一例（两个 `web` 连接加一个 `cli` 连接，连上后换假时钟）。
  - 连接链接跟着生成时的地址和端口（267-2、269-1）。4.4 只写了到期清掉。现在链接记下生成时开着的地址和端口；操作的回复、刷新、10 秒一次的读取（别的客户端改的也一样）发现开着的不是那个地址、不在监听或端口变了，就清掉链接，那一行写"地址变了，刚才那条链接用不了了，再生成一个。"。"再生成一个"也受 `linkBlocked` 管，和"生成连接链接"一样在没有监听中的地址时灰掉。切到别的设备时整个页面按设备重建（`DeviceGate` 以设备 id 为 key），链接本来就不带过去。已知限制：别的客户端刚换了地址、面板还没读到（最多 10 秒）时点生成，链接按面板上的旧地址记，下一次读取会把这条其实能用的链接清掉，再生成一次就好。测试：`remote-access-link.test.tsx` 按手驱动钩子挂真组件（生成 → 换地址、生成 → 关闭、轮询读到别处改端口和地址），`remote-access-presentation.test.ts` 的 `linkUsable`，`remote-access-panel.test.tsx` 的"再生成一个"灰掉。
  - "连接链接"一组有自己的搜索锚点（269-2）。它和"允许别的设备连接"是相邻的两个组，App 只在条目指定的组里找控件，原来搜"连接链接"等约 3.5 秒后说"这项设置当前不可用"。现在这一组 `id` 是 `settingAnchor('连接链接')`，`U/search.ts` 把它单列一节；"允许别的设备连接"一节留设备名字、地址、端口，"已配对的设备"不变。`remote-access-panel.test.tsx` 加一例：本面板每个搜索条目，有链接和没链接两种状态下，都按 App 的找法在它指定的组里找得到。无头浏览器实际点过：搜索"连接链接"后焦点落在"生成连接链接"，没有出现"当前不可用"。
- **R1（#657，退出、重启、升级直接打断对话，不等）。** 设计 6.3 的 `job_running` 和 60 秒宽限说的是扫码任务在客户端断线时留多久，不是退出时等活干完：`jobs.close()` 照旧立刻取消所有扫码任务、清掉宽限的定时器（`server-jobs.test.ts`"关闭"一例），定时器 `unref()`，不拖住进程退出。所以这里不用改成"提前提醒"，PR 里写明。
