# D3 `devices-3-remote-listen`：远程监听、地址分类、限流、`vonvon remote`、撤销断连

总设计见 `docs/plans/devices.md` 4.2、4.3（频率限制、撤销立即生效）、4.7（`remote_disabled`）、第 15 节的地址文案。共用契约在 `docs/plans/devices-1-identity.md` 4.0（`remote.json` 形状、`device.status/enable/disable/setPort`、`deviceStatusSchema`、`remote` 能力名、CLI 表）；通道和 `createSecureSocketServer` 的钩子在 `docs/plans/devices-2-secure-channel.md` 4.4。缩写同 D1。

## 1. 做什么

用户能做的：`vonvon remote enable --tailscale`（或 `<ip>`、`--allow-public`）后，daemon 在那个地址的 7767 端口接受配对过的客户端；`vonvon pair` 真的能让另一台电脑连上；`vonvon remote status` 看地址状态（在听、等地址出现、网络变了要确认）；`vonvon remote disable <ip>`、`vonvon remote port <n>`；`vonvon clients revoke` 后那台的连接 1 秒内断。没开远程的用户什么都不变：loopback 照旧。

依赖：D2（D1 间接）。被依赖：U3、K1 的真机验收、整批的 Mac 验收。

## 2. 范围

做：设计 4.2 全部、4.3 的频率限制和撤销断连、4.7 的 4006、12 节诊断事件里 `remote-bind-waiting / remote-bind-failed / remote-network-changed / rate-limited / handshake-rejected / pairing-refused / client-revoked`、8.3 表里 `remote *` 的双路、D1 预留的四个 `device.*` 实现。

不做：桌面端的"允许别的设备连接"面板、`cgnat/public` 确认框、`jobRunning` → U3；维护子集执行、`--scope` → D4a；中继 → 以后；Tailscale 身份校验（whois）、`tailscale serve` → 不做（设计 4.2）。

## 3. 现在的代码

- `D/server/http.ts`：`listen` 只绑 `127.0.0.1`（约 206、211）；`release()` 只关 `acquiredServer`（约 97-114）；请求处理器是 `serveWebUi`（约 136-143）。D2 后它持有 `hub`、`secureDeps`（`device/clients/invites/completePairing/info`）。
- `D/server/ws.ts:13-20,31`：loopback 的 Host/Origin 403，不动。
- D1：`D/remote/config.ts` 只有 `readRemoteConfig`；`D/remote/clients.ts` 的 `onChange(listener(generation, revokedIds))`、`get(clientId)`；`D/server/rpc/device.ts` 的 `status/enable/disable/setPort` 回 `unsupported`；`capabilities()` 只有 `['device']`；`D/cli/parity-allowlist.ts` 的 `pending('D3')` 四条。
- D2：`createSecureSocketServer({ admit, onHandshake, onHandshakeFailed, … })`、`PeerHub.closeWhere/publish`、`Peer.address`。
- `D/server/jobs.ts` 的 `detach(peer)`（取消它拥有的注册任务）、`D/server/logs.ts` 的 `LogFollowers.detach(peer)`。
- `D/server/snapshot.ts` 的 `platform` 判定；`D/core/logger.ts` 的 `log.info/warn/fail(phase, event, fields)`；诊断 `diagnostics.accept`。
- `D/cli/command-error.ts` 的 `rpcErrorKind`；`D/cli/commands/pair.ts`（D1）里连 daemon 和双路写法可照抄。

## 4. 怎么改

### 4.1 `D/remote/config.ts`（写入侧）

`writeRemoteConfig(home, config)`：`remoteConfigSchema.parse` → `writeFile(tmp, { mode: 0o600 })` + `rename`。纯函数：`enableAddress(config, { host, kind, iface?, network? })`（已存在同 `host` 就替换，`enabledAt = now`）、`disableAddress(config, host)`（不存在抛 `RpcError('invalid_request','这个地址没有开启。')`）、`setPort(config, port)`（1024..65535）。`host` 必须 `net.isIP(host) !== 0`（设计：只接受字面 IP，不接受主机名；错误文字"只接受 IP 地址，不接受主机名。"）。

### 4.2 `D/remote/address.ts`

```ts
export interface AddressContext { interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>; tailscale: { installed: boolean; ips: string[] } }
export function classifyAddress(host: string, ctx: AddressContext): AddressKind | 'invalid';
export function interfaceFor(host: string, interfaces): { name: string; mac: string } | undefined;
export function hostHeader(host: string, port: number): string;        // IPv6 加方括号
export function exposure(kind: AddressKind): 'private' | 'exposed';   // cgnat/public → exposed
export async function networkIdentity(ifaceName: string, platform = process.platform): Promise<string | undefined>;
```

分类顺序：`invalid`（不是字面 IP）→ `loopback`（127/8、`::1`）→ `0.0.0.0`/`::` → `public` → `tailscale`（4.3 的判定）→ `lan`（10/8、172.16/12、192.168/16、169.254/16、`fc00::/7`、`fe80::/10`）→ `cgnat`（100.64/10 剩下的）→ `public`。`networkIdentity`：Linux 读 `/proc/net/route` 找 flags 含 RTF_GATEWAY、目的 0 的默认网关，再在 `/proc/net/arp`（或 `ip neigh show <gw>`）取 MAC，返回 `gw:<mac 小写>`；拿不到或非 Linux 返回 `undefined`（设计 4.2："拿不到就只记网卡名"）。

### 4.3 `D/remote/tailscale.ts`

`tailscaleIps({ exec = execFile, timeoutMs = 5000 }): Promise<{ installed: boolean; ips: string[] }>`：跑 `tailscale ip`（两族），ENOENT → `installed:false`；超时、非零退出 → `installed:true, ips:[]`。`isTailscale(host, iface, ts)`：`fd7a:115c:a1e0::/48` 只看段；100.64/10 要满足其一：`ts.ips` 含它（不看网卡名：macOS 的 `utun*`、Windows 都靠这条）；或网卡名**不区分大小写**以 `tailscale` 开头（Linux 的 `tailscale0`、Windows 的 `Tailscale`，没装命令行时靠这条）。（2026-11-01 按 U3 计划改：原来写的"`tailscale` 开头，或 `utun*` 且 `ts.ips` 含它"认不出 Windows 的 `Tailscale` 网卡。）`pickTailscaleAddress(ctx)`：第一个满足 `isTailscale` 的 IPv4。

### 4.4 `D/remote/rate-limit.ts`（全在内存，重启清零，不起定时器，按 `now()` 懒清理）

```ts
export interface RateLimiter {
  connectionOpened(ip: string): 'ok' | 'too_many';            // 未认证：每 IP ≤4、全局 ≤32
  connectionAuthenticated(ip: string): void; connectionClosed(ip: string, authenticated: boolean): void;
  handshakeStarted(ip: string, exposure: 'private' | 'exposed'): 'ok' | 'rate_limited';   // 封禁中 → rate_limited；每 IP 令牌桶 20/分钟；exposed 再过全局 10/秒
  handshakeFailed(ip: string, reason: 'handshake_failed' | 'unknown_client' | 'pairing_failed', validInvite: boolean): void;  // validInvite 为 true 且 reason 是 unknown_client/pairing_failed 时不计
  isBanned(ip: string): boolean;
}
export function createRateLimiter(opts?: { now?: () => number; onBan?: (ip: string) => void }): RateLimiter;
```

桶空时再来一次 → 封 60 秒，`onBan(ip)` 一次（→ `log.warn('remote','rate-limited',{ ip })`）。

### 4.5 `D/server/remote-listeners.ts`

```ts
export type RemoteAddressState = 'listening' | 'waiting' | 'needs-confirmation' | 'disabled' | 'failed';
export interface RemoteListeners {
  sync(config: RemoteConfig): Promise<void>;   // 对照 config：新地址 ensure、少了的 stop(4006)、port 变了全部重绑
  status(): Array<{ host: string; kind: AddressKind; enabledAt: number; state: RemoteAddressState; detail?: string }>;
  beginDrain(): void; release(): Promise<void>; onChange(listener: () => void): () => void;
}
export function createRemoteListeners(deps: {
  hub: PeerHub; secure: SecureDeps; limiter: RateLimiter; log: Logger; now?: () => number;
  classify: (host: string) => Promise<AddressKind | 'invalid'>; networkIdentity: typeof networkIdentity; interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  timers?: { retry?: number /* 15_000 */; watch?: number /* 15_000 */ };
}): RemoteListeners;
```

- `failed` 要进协议：D1 分支 `P/device.ts:61` 的 `remoteAddressStateSchema` 只有 `listening`、`waiting`、`needs-confirmation`、`disabled`。本片把它放宽成五个值（加 `failed`），`detail` 本来就是可选的。不加的话，绑定出了别的错误时 `device.status` 的回复过不了 schema，U3 的页面和 `remote status` 都拿不到状态，U3 写好的 `failed` 文案也用不上。

每个地址一个 `Entry { address, state, detail?, server?: http.Server, secure?: { close() }, timer?: NodeJS.Timeout }`：
- `ensure(address, port)`：`lan` 且 `address.network` 有值 → 先算当前 `networkIdentity(address.iface)`，不等 → `needs-confirmation`，`detail` = 设计 15 节"局域网换了"那句，`log.warn('remote','remote-network-changed')`，**不绑**，直到用户再 `enable` 一次（`enableAddress` 会刷新 `network`）。否则 `http.createServer(handler)`：有 `Origin` 头 → 403；`Host` ≠ `hostHeader(host, port)` → 403；`GET /health` → `200 {"ok":true,"protocolVersion":2}`（不回设备 id、版本、名字）；其余 404 空体。`createSecureSocketServer({ ...secure, server, listenerId: host, admit, onHandshake, onHandshakeFailed })`，其中 `admit(req)`：Origin 存在或 Host 不符 → `{ok:false,status:403}`，`limiter.connectionOpened(ip)` 回 `too_many` → `{ok:false,status:429}`；`onHandshake(ip)` → `limiter.handshakeStarted(ip, exposure(kind))`；`onHandshakeFailed` → `limiter.handshakeFailed` + `log.warn('remote', reason==='pairing_failed' ? 'pairing-refused' : 'handshake-rejected', { ip, reason })`。`server.listen(port, host)`：`listening` → 状态 `listening`、`log.info('remote','remote-listening',{ host, port, kind })`；`error`：`EADDRNOTAVAIL` → `waiting`，detail "等待地址 <host> 出现"，`log.info('remote','remote-bind-waiting')`，15 秒后重试；`EADDRINUSE` → `waiting`，detail "端口 <port> 被占用，每 15 秒重试；可用 `vonvon remote port <n>` 换端口"，`log.warn('remote','remote-bind-failed')`，15 秒重试；其他错误 → `failed`，detail 是错误码，不重试。
- 在听时每 15 秒 `watch`：`host` 不在 `interfaces()` 里了 → 关 server（连接 4006）、回到 `waiting` 并重试（设计 4.2 "地址消失同样回到等待"）。
- `stop(entry, code=4006)`：清 timer、`hub.closeWhere(peer => peer.listener === host, code, 'remote_disabled')`、`secure.close()`、`server.close()` 并等 `close` 事件。
- `beginDrain()`：所有 entry 清 timer（**不再重试**）、`server.close()`（停收新连接，已有连接由 hub 的排空处理）。`release()`：`await Promise.all(stop(entry, 1001))`，之后 `vi.getTimerCount()` 为 0（测试里核）。
- D2 的 `SecureSocketServerOptions` 加 `listenerId?: string`，`Peer` 加 `listener?: string`（loopback 为 `undefined`）——这是对 D2 契约的一个加字段，D2 的计划第 9 节已预留。

### 4.6 `http.ts` 接线

- `startApi`：loopback 监听成功后 `remote = createRemoteListeners(...)`，`void remote.sync(await readRemoteConfig(appDir))`（绑定失败不阻塞启动）；`capabilities()` 在 `config.addresses.length > 0` 时加 `'remote'`；`beginDrain` → `remote.beginDrain()`；`release` → `await remote.release()`（在关 loopback 之前或之后都行，但要等完）。
- 撤销断连：`clients.onChange((generation, revokedIds) => { for (const peer of hub.peers) if (peer.principal.kind==='owner' && peer.principal.via==='paired' && revokedIds.includes(peer.principal.clientId)) { jobs.detach(peer); logs.detach(peer); } hub.closeWhere(同条件, 4003, 'client_revoked'); for (id of revokedIds) { publish({ event:'device', change:'client-revoked', clientId:id, name, clientKind }); log.info('device','client-revoked',{ clientId:id }); } })`。`revokeClient` 的 RPC 回复在断连之后发（回复给的是发起撤销的 peer，不是被撤的）。
- `deps.remote` 给 `rpc/device.ts`。

### 4.7 `D/server/rpc/device.ts`（补齐四个）

- `enable`：`host` 和 `tailscale` 恰好一个，否则 `invalid_request`。`tailscale:true` → `tailscaleIps()` + `pickTailscaleAddress`；没有 → `RpcError('tailscale_unavailable', 设计 15 节"Tailscale 提示"原文)`。`host` → `classify`：`invalid` → `invalid_request('只接受 IP 地址，不接受主机名。')`；`loopback` → `invalid_request('回环地址不用开启，本机客户端一直能连。')`；`cgnat` 且 `!allowPublic` → `RpcError('confirm_required', 设计 15 节"100.x 但不是 Tailscale"原文，<host> 代入)`；`public` 且 `!allowPublic` → `RpcError('confirm_required', 设计 15 节"公网地址警告"原文)`；`lan` → `interfaceFor` 记 `iface`，`networkIdentity` 记 `network`。然后 `writeRemoteConfig(enableAddress(...))` → `await remote.sync(config)` → 回 `deviceStatus`。
- `disable { host }` → `disableAddress` → 写 → `sync` → `deviceStatus`。`setPort { port }` → 写 → `sync`（全部重绑，旧连接 4006）→ `deviceStatus`。
- `status` → `{ device:{ id, name, publicKey }, remote:{ port, addresses: remote.status() }, clients:{ total: clients.list().filter(未撤销).length, active: hub 里 paired peer 数 } }`。
- `command-error.ts`：`tailscale_unavailable`、`confirm_required` 加进 exit 4 那组。

### 4.8 `D/cli/commands/remote.ts`

`remote status [--json]`、`remote enable <ip> | --tailscale [--allow-public]`、`remote disable <ip>`、`remote port <n>`；`covers` 按 D1 4.0 的表（`device.status/enable/disable/setPort`）。双路：daemon 在 → RPC；不在 → 走 D1 `D/cli/commands/device.ts` 的 `either()`（导出它复用），在 host 互斥锁下用同一套 `classify/tailscaleIps/enableAddress/...` 直接改 `remote.json`，输出末尾加一行"后台服务没在运行，下次启动时生效。"，`--json` 带 `source:'files'`。`enable` 成功文字：设计 15 节"`remote enable` 成功"，`<kind>` 的中文：tailscale "Tailscale 地址"、lan "局域网地址"、cgnat "运营商地址（已确认）"、public "公网地址（已确认）"。`status` 人类输出一张表：地址、种类、状态（在听 / 等待地址出现 / 网络变了，确认后再开 / 失败）、说明、端口；最后一行"客户端：<total> 台，在线 <active>"。`parity-allowlist.ts` 删 `pending('D3')` 四条。`cli-json.test.ts` SAMPLES 加 `remote status --json`、`remote enable 203.0.113.5 --json`（无 `--allow-public` → exit 4）。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/remote-address.test.ts`（新） | 分类表 | `127.0.0.1`→loopback；`::1`→loopback；`0.0.0.0`、`::`→public；`10.1.2.3`、`172.16.0.9`、`172.31.255.1`、`192.168.1.9`、`169.254.1.1`、`fd00::1`、`fe80::1`→lan；`172.32.0.1`→public；`100.100.1.1` 在 `tailscale0` 上→tailscale；同地址在 `eth0` 上且 ts.ips 不含→cgnat；在 `utun3` 且 ts.ips 含→tailscale；在 `Tailscale`（Windows 的网卡名）上、ts.ips 为空→tailscale；在 `Ethernet` 上且 ts.ips 含→tailscale；`fd7a:115c:a1e0::1`→tailscale；`8.8.8.8`→public；`example.com`、`192.168.1`→invalid。main 必败 |
| 同上 | `hostHeader` | `('192.168.1.9',7767)`→`192.168.1.9:7767`；`('fd00::1',7767)`→`[fd00::1]:7767` |
| `protocol/test/device.test.ts`（改） | 地址状态 `failed` | 带 `state: 'failed', detail: 'EACCES'` 的 `device.status` 回复能被 `deviceReplySchema` 解析，原样回来。main 必败 |
| `daemon/test/remote-tailscale.test.ts`（新） | 命令缺失/超时 | 假 `exec` 抛 ENOENT → `installed:false, ips:[]`；5 s 不回 → `installed:true, ips:[]`；正常输出两行 → 两个 ip |
| `daemon/test/remote-rate-limit.test.ts`（新，假时钟） | 未认证连接数 | 同 IP 第 5 条 `too_many`；`connectionClosed` 后第 5 条 ok；8 个 IP 各 4 条后第 33 条 `too_many` |
| 同上 | 令牌桶和封禁 | 同 IP 1 分钟内第 21 次 `handshakeStarted` → `rate_limited`，`onBan` 调一次，60 s 内都拒，61 s 后 ok；`handshakeFailed(unknown_client, validInvite:true)` 不扣桶，`validInvite:false` 扣 |
| 同上 | exposed 全局 | 20 个 IP 1 秒内各 1 次 `exposed` → 第 11 次起 `rate_limited`；`private` 不受这条限 |
| `daemon/test/remote-config.test.ts`（新） | 写入 | `enableAddress` 新增/替换、`disableAddress` 不存在抛、`setPort(80)` 抛、文件 mode 0600、`readRemoteConfig` 往返 |
| `daemon/test/remote-listeners.test.ts`（新，真 `http.Server`，注入 `classify`、`interfaces`、假时钟） | 在听 | 地址 `127.0.0.2`（Linux 127/8 任何地址可绑；注入的 `classify` 回 `lan`），端口 0 → `status()[0].state === 'listening'`；`GET /health` → 200、体恰好 `{"ok":true,"protocolVersion":2}`，无其他键；`GET /` → 404；带 `Origin` → 403；`Host: 127.0.0.3:…` → 403。main 必败 |
| 同上 | 无通道探针被拒 | 对它开 `ws` 发文本 `hello` → 关 4005（D2 的状态机），`limiter.handshakeFailed` 被调 |
| 同上 | 等待地址 | 地址 `10.255.255.254`（本机没有）→ `EADDRNOTAVAIL` → `waiting`，detail 含"等待地址"；推进 15 s 重试一次（spy `listen` 调两次） |
| 同上 | 排空能退出 | 处于 `waiting` 有待重试 → `beginDrain()` 后推进 60 s `listen` 不再被调；`release()` resolve；`vi.getTimerCount() === 0` |
| 同上 | 网络变了 | `lan` 地址带 `network:'gw:aa:bb…'`，注入 `networkIdentity` 回别的 → `needs-confirmation`，`listen` 未被调，日志 `remote-network-changed` |
| 同上 | 地址消失 | 在听时让 `interfaces()` 不再含该 host，推进 15 s → server 关、状态 `waiting`、已连 peer 收到 4006 |
| 同上 | 关地址 | `sync` 去掉该地址 → 已连 peer 4006 `remote_disabled`，`/health` 连接被拒 |
| 同上 | 换端口 | `sync` 改 port → 旧 peer 4006，新端口 `/health` 200 |
| `daemon/test/rpc-device-remote.test.ts`（新，`startFixture` + 注入 classify/tailscale） | enable 各分支 | `--tailscale` 无地址 → `tailscale_unavailable`；`host:'example.com'` → `invalid_request`；`127.0.0.1` → `invalid_request`；`100.70.1.1`（cgnat）无 `allowPublic` → `confirm_required` 文字含"CGNAT"；`203.0.113.5` 无 → `confirm_required` 文字含"公网"；带 → 写进 `remote.json`、`deviceStatus.remote.addresses[0].kind==='public'`；`192.168.1.9` → `iface`、`network` 记下；hello v2 的 `capabilities` 含 `'remote'` |
| 同上 | disable/setPort/status | `disable` 不存在 → `invalid_request`；`setPort 17767` → 状态里 port 变；`status.clients.total` 等于未撤销条数 |
| 同上 | 撤销断连 | 用 D2 夹具配对一条连接 → `device.revokeClient` → 该 socket 1 s 内收到 4003，`jobs.detach`/`logs.detach` 被调，`device/client-revoked` 事件发出，回复 `revoked:[id]` 在断连之后到发起方。main 必败 |
| `daemon/test/cli-remote.test.ts`（新） | 双路 | 无 daemon：`remote enable 192.168.1.9 --json` 写文件、`source:'files'`；`remote status --json` 各地址 `state:'disabled'`；`remote enable 203.0.113.5` exit 4；`remote port 80` exit 2；有 daemon（fixture）：走 RPC |
| `daemon/test/cli-parity.test.ts`（改） | 白名单 | 无 `pending('D3')`；四个 `device.*` 被 `covers` |

## 6. 自测和验收

Linux 自测：

1. `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/remote-*.test.ts packages/daemon/test/rpc-device-remote.test.ts packages/daemon/test/cli-remote.test.ts packages/daemon/test/cli-parity.test.ts packages/daemon/test/cli-json.test.ts packages/daemon/test/api-listen-lifecycle.test.ts`；typecheck、lint、daemon build 同前。`rm -rf -- "${T:?}"`。
2. 真开一次（设计 13 节 D3 验收行的 Linux 一半；用临时 daemon，不碰 Paseo、`accept-home2`、`~/.vonvon-bot`）：`T=$(mktemp -d)`，前缀 `HOME=$T/home VONVON_HOME=$T/vh` 跑 `vonvon daemon start`，`vonvon remote port 17767`（避开别人可能用的 7767），`vonvon remote enable --tailscale --json` 看到本机 Tailscale 地址、`state:'listening'`；`vonvon remote status`；`vonvon pair --json | cat` 出链接；本机 `curl -si http://<ts-ip>:17767/health` 只有两个键；`curl -si -H 'Origin: http://x' …/health` → 403；`curl -si -H 'Host: 1.2.3.4' …/health` → 403；用 D2 的 `test/manual/secure-probe.ts` 以客户端身份连 `<ts-ip>:17767` 带链接 → 配对成功、`clients ls` 多一条、daemon 日志有 `client-paired`；再用 `wscat`/`node -e` 发明文 `hello` → 4005；连着的探针在另一个终端 `vonvon clients revoke <id>` → 1 秒内断 4003；`vonvon remote enable 100.70.0.1` → exit 4 CGNAT 文字；`vonvon remote enable 0.0.0.0` → exit 4 公网文字；`vonvon remote disable <ts-ip>`，`daemon stop`。压力：`for i in $(seq 1 300); do (printf 'x' | nc -q0 <ts-ip> 17767 &) ; done` 一秒内几百条第一消息，同时 `vonvon daemon status --json` 1 秒内返回（Bot IPC 不卡；临时 daemon 没有 bot，看 `status` 延迟即可）。最后 `rm -rf -- "${T:?}"`。PR 里不贴地址、链接。
3. `status` 的"等待地址出现"：`vonvon remote enable 10.255.255.254` 在没这个地址的机器上 → `state:'waiting'`；`daemon stop` 在 2 秒内退出（有待重试时排空能退）。

Mac 后验（整批，U1b/U3 的任务里）：Mac 桌面端或 Mac 上的通道探针连 JP-VPS 的 Tailscale 地址能连；无通道探针被拒；`clients revoke` 后 Mac 那边 1 秒内断并显示"已撤销"文案。Windows：无专项（Windows 上网卡名是 `Tailscale`，按 4.3 不区分大小写的前缀认；`tailscale.exe` 不在 PATH 里时由 U3 补的安装位置取 `ts.ips`；I4a 已取消（owner 2026-11-01），改成在 Windows 的验收任务里顺带看一次 Windows 桌面端"允许别的设备连接"认不认 Tailscale 地址）。

## 7. 文档

- `docs/product.md` 本片不改；D0 的 3.14 写"允许别的设备连接"、地址种类和 `--allow-public`、`/health`、7767。
- 官网 `/guide/remote/` → W1（0.9.1 起是 `/docs/remote/`）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. loopback 监听的代码路径没变（`^127\.0\.0\.1:` 的 14 处检查未动，`daemon.pid` 的 `listen` 不变）。
2. 远程 server 的处理器只有 `/health` 和 WS 升级，不 import `serveWebUi`；`/health` 体恰好两个键。
3. Host 必须等于 `ip[:port]`（IPv6 带方括号），Origin 存在一律 403；`admit` 在 DH 之前。
4. 限流数值：4/IP、32 全局、20 次/分钟/IP、封 60 秒、exposed 10 次/秒；带有效 `inviteId` 的失败不计。
5. `EADDRNOTAVAIL`、`EADDRINUSE` 进 `waiting` 每 15 秒重试；`beginDrain` 后没有定时器；`release` 等所有远程 server 关完。
6. `lan` 地址开启时记 `iface`/`network`，重试前核对，不一致进 `needs-confirmation` 且不绑；`tailscale` 地址不做这项。
7. 100.64/10 的判定按 4.3（在 `tailscale ip` 输出里，或网卡名不区分大小写是 `tailscale*`），其余归 `cgnat` 要 `--allow-public`。
8. 撤销：改文件 → 关连接 4003 → `jobs.detach`、`logs.detach`，1 秒内；事件 `client-revoked` 发出。
9. 关地址、换端口的连接收 4006。
10. `remote *` 四条双路，daemon 没跑时在 host 互斥锁下写文件并提示"下次启动时生效"。
11. 文案和设计第 15 节一致（成功、Tailscale 提示、CGNAT、公网、网络变了）。
12. 行数 ≤1,500；diff 里没有真实 id、密钥、本机路径、Tailscale 地址。

## 9. 风险和行数

- 估计约 1,300 行（config 80、address 150、tailscale 80、rate-limit 150、remote-listeners 300、http 接线 60、rpc 120、CLI 180、测试 450 的一部分压缩后）。超过就把 CLI `remote.ts` + 它的测试拆成 D3b。
- `networkIdentity` 只在 Linux 实现（`/proc/net/route` + arp）；macOS/Windows 回 `undefined`，`lan` 地址只记网卡名——设计 4.2 已允许"拿不到就只记网卡名"，但这意味着 Mac 笔记本换网络不会进 `needs-confirmation`。写进 PR 和 product.md（D0）。
- 地址消失的侦测靠 15 秒 `watch` 轮询 `os.networkInterfaces()`，不是事件；最坏 15 秒内 server 还挂在失效地址上（不会收到流量）。
- `ws` 的 `verifyClient` 是同步/回调式；`admit` 保持同步。
- 用 `127.0.0.2` 做测试地址依赖 Linux 的 127/8 全可绑；macOS 上这些测试会 `EADDRNOTAVAIL`（CI 的 macOS 任务）：测试里先 `try bind` 探测，不行就 `test.skip` 并在 Linux 上跑全量。
- `nc` 压测只验证 daemon 的 `status` 不被拖慢；真实的 Bot IPC 不卡由整批验收在 Bot 6 上看一次。

## 10. 审查后改了什么

2026-11-02，#640 上 Sonnet 审查 U1a–U4 计划时，提到本片的一条，接受：

- 监听器会把地址记成 `failed`，U3 也给它写了文案，可 D1 的协议枚举没有这个值，没有哪一片负责加。由本片加进 `remoteAddressStateSchema`，并加一条解析测试（4.5、第 5 节）。U3 计划写明：本片没加时由 U3 补。

## 11. 实现时和计划不一样的地方

1. **`createRemoteListeners` 的依赖**：不要 `classify`（监听器用 `remote.json` 里记下的 `kind`，不再分类一次）；`hub` 在 `secure` 里；多一个 `secureTimers`（测试把通道的超时调短）。`beginDrain()` 返回 Promise，直接把每个地址整个关掉（连接 1001），不只 `server.close()`：hub 的排空同一时刻也在关这些连接，效果一样，少一种中间状态。（Codex 审查 232-2 后改掉了：排空时远程监听继续开，`release` 才关，见文末"Codex 审查后改了什么"第 2 条。）
2. **关地址、换端口、地址消失**：用 D2 的 `secure.close('remote_disabled')`（D2 计划第 11 节第 4 条）关这个监听器自己的连接，没有另外 `hub.closeWhere(listener === host)`；`Peer.listener` 照计划加了（U3 的 `via` 用得上）。关完通道连接后，再把这个 server 剩下的 TCP 连接全部 `destroy`：升级过的 socket 不在 `closeAllConnections` 管的列表里，一个被拒了升级、自己不关的客户端会让 `server.close()` 一直等下去，关地址、换端口、`daemon stop` 都跟着卡住（写探针时发现，加了测试）。D2 的 `refuseUpgrade` 同理改成回完状态码 1 秒后还没关就 `destroy`。
3. **未认证连接数**：D2 的 `SecureSocketServerOptions` 除了 `listenerId`，再加一个 `onAuthenticated(request)`（hello 通过、进 hub 时调）。计数按 TCP 连接：`admit` 放行时记一条，连接的 `close` 事件减掉，hello 通过时提前减掉。这样升级被 `ws` 自己拒掉（坏的 `Sec-WebSocket-Key`）的连接也不会把名额占住。
4. **局域网地址的网络核对**：拿不到当前网络（没有默认路由、ARP 表里没有网关，比如开机时 DHCP 还没好）时照"等待地址出现"处理、15 秒后再试，不进 `needs-confirmation`；不然服务器开机就卡在"网络变了"，要人去重开。在听的时候 15 秒一次的 `watch` 也核对网络（笔记本睡醒换了网络、拿到同一个 IP 时，地址没有消失过）。（Codex 审查 233-1 后加：先核对当前承载这个地址的网卡，和记下的不同就算网络变了，见文末第 3 条。）
5. **日志**：状态变了才记一行，15 秒一次的重试不重复记。多两个事件：`remote-server-error`（在听之后 server 出错，只记不处理），`remote-config-unreadable`（启动时读不了 `remote.json`：daemon 照常起，远程不开）。
6. **限流的计法**：一次握手开始扣 1 个令牌，失败再扣 1 个（带有效邀请的 `unknown_client`/`pairing_failed` 不扣），所以同一 IP 一分钟内 20 次正常连接、或约 10 次失败就封 60 秒；桶空时的失败也会触发封禁。公网/CGNAT 的全局每秒 10 次只拒、不封 IP。
7. **`/health` 的 server**：`headersTimeout`、`requestTimeout` 设成 10 秒。
8. **撤销断连的顺序**：断连的 `clients.onChange` 监听登记在 `followRevocations` 之前，被撤销的那条连接先断，收不到 `client-revoked` 事件；`jobs.detach`、`logs.detach` 经 hub 的 `detached` 调（`closeWhere` → 连接的 detach → `hub.remove`），没有另写一遍。`followRevocations` 挪到 hub 建好之后，经 hub 发事件。
9. **IPv6 地址统一写法**：开、关地址时把 IPv6 写成小写短格式（`FD00:0::1` → `fd00::1`），客户端发的 Host 和它比较。
10. **`--tailscale`**：取网卡上第一个算 Tailscale 的 IPv4，不取只在 `tailscale ip` 输出里、网卡上没有的地址（绑不上）。
11. **设计第 15 节没写到的文字**（本片自定）：`enable` 同时给或都不给 IP 和 `--tailscale`："给一个 IP 地址，或者用 --tailscale，二选一。"；端口范围："端口要在 1024 到 65535 之间。"；`remote status` 的表头"地址  种类  状态  说明  端口"、种类名（Tailscale 地址、局域网地址、运营商地址、公网地址）、daemon 没运行时的状态"没在听"；`enable` 之后地址没在听时加一行"现在：<状态>，<说明>。"；`disable` 的"已关闭 <地址>，经这个地址的连接都已断开。"（没运行时"已关闭 <地址>。"）；`port` 的"远程端口改成了 <n>，已配对的设备要重新配对。"（A1 之后换端口只要粘新链接，0.9.0 发布前改成"远程端口改成了 <n>，已配对的设备要粘一次新链接（`vonvon pair` 生成），只会更新地址，不用重新配对。"，和面板的端口说明一致）；没开任何地址时 `remote status` 用 D1 的"没开远程时 pair"那句。
12. **`device.status` 的端口**每次读 `remote.json`，地址的状态取监听器的。
13. **`remote *` 四条进 `LEASED`**（数据租约），和 `clients *` 一样，daemon 没跑时它们自己写 `devices/`。
14. **测试的接缝**：`startApi` 加 `remote?: RemoteSeams`（网卡、Tailscale、局域网网络、分类、计时），`startFixture` 第 4 个参数传它。`rpc-device-remote.test.ts` 里会真去绑的局域网地址用 `10.255.255.253`，不用 `192.168.1.9`：开发机上可能真有这个地址，测试就真在局域网上听了。`cli-remote.test.ts` 的"有 daemon"一路用夹具加手写的 pid 锁。
15. **第 6 节第 2 步没在 Tailscale 地址上真开**：这片的规矩是不在这台机器的 Tailscale、公网地址上开监听，改用 `test/manual/remote-probe.ts` 在 `127.0.0.2:17767`（注入的分类把它当局域网地址）上跑同样的步骤；真开 Tailscale 地址留到真机验收。第 3 步（`10.255.255.254` 等待地址、`daemon stop` 很快退出）用真 daemon 跑了。
16. **通配地址和链路本地 IPv6 开启时直接拒绝**（Codex 审查 232-1、234-1、234-2 后加）：设计 4.2 原写"`0.0.0.0`/`::` 按 `public` 处理"，第 6 节第 2 步也写了"`remote enable 0.0.0.0` → exit 4 公网文字"。可通配地址不是别的设备能拨的地址：配对链接里带的就是它，客户端用真实 IP 连时发的 Host 又对不上，403。链路本地 IPv6（`fe80::/10`，带不带 `%zone`）要客户端带上它自己的网卡名，现在的链接和 `ws://` URL 都装不下。这一批两种都不支持，在写配置之前拒绝（`invalid_request`，exit 2，和"只接受 IP 地址"同一类），RPC 和没有 daemon 时直接改文件两条路都在 `resolveEnable` 里拒。文字（本片自定，照第 15 节的写法）：通配地址"不能开启 <地址>：它代表这台设备的所有地址，别的设备拿它连不上。改用 `vonvon remote enable --tailscale`（推荐）或 `vonvon remote enable <这台设备的 IP>`。"；链路本地"不能开启 <地址>：现在还不支持链路本地的 IPv6 地址（fe80:: 开头）。改用 `vonvon remote enable --tailscale`（推荐）或 `vonvon remote enable <这台设备的局域网 IP>`。"。分类表（第 5 节）不变：`classifyAddress` 仍把它们分成 `public`、`lan`，拒绝在开启这一步。

## 合入 D2（带集成分支）

2026-11-02，D2（#644）合进了集成分支（I3 升级引擎、D4a 会话令牌），本片把新的 D2（`88e351af`）merge 进来，单独一个提交。冲突四处，两边的行为都留：

- `cli/index.ts`：`LEASED` 两边合起来（`remote *` 和 `update` 都持数据租约）。D4a 的 `LOCAL_ONLY` 本来就列了 `remote status/enable/disable/port`，现在这四条命令有了，会话里一律 exit 4 `not_in_session`。`cli-bot-session.test.ts` 的会话拒绝清单加上这四条，"`LOCAL_ONLY` 里还没有的命令"从四条变成零条。
- `server/http.ts`：用 D2 的写法（hub 带 `view`，`createSocketServer` 传 `sessions`，会话令牌作废经 `hub.closeWhere` 关 4401），再加回本片的撤销即断（`clients.onChange` 在 `followRevocations` 之前登记，两者都在 hub 建好之后）、远程监听和 `device` 的 `remote` 依赖；`settings`、`collaboration` 的回复照 D4a 过 `shown`。`capabilities` 合成 `device`、`session-scope`，开了地址时再加 `remote`。
- `test/server-fixture.ts`：`startApi` 同时传 `sessionTokens` 和 `remote`。
- `test/cli-json.test.ts`：两边的样例都留。

另外核对了 D4a 的权限表：`device` 一行（`status enable disable setPort pair clients renameClient revokeClient rename`）没给会话写格子，Bot 会话一律拒；CLI 在会话里先由 `LOCAL_ONLY` 拒。`package-lock.json` 没变。排空白名单原来缺 `machine.coreUpdateStatus`（PR 描述的已知限制），D2 合入后远程连接也走共用的 `DRAIN_KINDS`，这条没了。

## 合入集成分支（D2 #644、D4b #648 合入后）

2026-11-02，D2 合入了集成分支，PR 的基从 D2 改成 `claude/devices-integration`。本片把集成分支（`774592ad`：D2、D4a 会话令牌和权限表、D4b 的 ★ 请求转 Bot 进程、I3 升级引擎）merge 进来，单独一个提交 `0ca07b1a`。冲突两处，两边的行为都留：

- `server/http.ts`：`startApi` 的选项两边各加了一个，合成 `askBot?: AuthzDeps['askBot']; remote?: RemoteSeams`。本片的远程监听、排空保留监听、`control()` 白名单，D4a 的会话令牌和 `MAINTENANCE_KINDS`/`DRAIN_KINDS`，I3 的 `coreUpdateStatus`，D4b 的 `askBot`、`memoryItem`、memory 落点和 schedule actor 都在。
- `test/server-fixture.ts`：`startFixture` 的第 4 个参数两边各占了一个（本片的 `remote`、D4b 的 `askBot`）。改成第 4 个 `remote`、第 5 个 `askBot`，D4b 那三处按位置传 `askBot` 的调用（`authz-session.test.ts` 两处、`cli-bot-session.test.ts` 一处）补一个 `undefined`。

合并后 build、typecheck 通过，daemon 里 D3、D4a、D4b、D2 相关的 42 个测试文件 401 条通过。`package-lock.json` 没变。

## Codex 审查后改了什么（任务 232–234、248）

2026-11-02，JP-VPS 上的 Codex 分三份审查本片（232 通读全部 diff，233 远程监听和撤销，234 地址、限流、配置、命令行），去重后 4 条，都复现了，都接受：

1. **通配地址（232-1、234-1）→ 接受。** `remote enable 0.0.0.0`/`::` 成功，配对链接里也是通配地址，客户端用真实 IP 连时 Host 对不上，403。这一批不做完整的通配语义，`resolveEnable` 在写配置前拒绝（exit 2），RPC 和直接改文件两条路都拒，文字见第 11 节第 16 条。测试：`remote-address`、`rpc-device-remote`（拒了以后 `remote.json` 没写）、`cli-remote`（文件没变）、`cli-json`（真 CLI exit 2）。
2. **排空一开始就销毁远程监听（232-2）→ 接受。** 原来 `beginDrain` 直接关掉每个远程 server，排空期间远程客户端连 TCP 都建不了，`admin.daemonStatus`、`machine.stopHost`、`machine.coreUpdateStatus` 都问不到，和设计 4.7"远程连接和本机一样"冲突。改成：`beginDrain` 只停绑定重试和地址巡检（之后不再绑新地址，`sync` 不动），远程 server 继续开，新连接照常走同一套 Host/Origin、限流和通道认证，进 message-loop 的排空分支（`DRAIN_KINDS`）；`release` 才关所有远程 server，连接 1001。排空开始时已有的连接照 hub 的排空处理，和本机一样 1001 关掉，客户端重连后能问那三样；排空期间连上的留到 `release`。没有另外让已有连接留着：那要改 hub 对本机连接也一样的排空规则，超出这条。测试：`remote-listeners` 的"排空时继续听、不巡检、`release` 才关"，`server-drain-control` 加远程版（真 daemon API 上开 `127.0.0.2`，排空中经安全通道问 `daemonStatus`、`coreUpdateStatus`，`release` 后连不上）。
3. **局域网地址换了网卡（233-1）→ 接受。** 原来只在记下了 `network` 时用旧网卡名查网关，巡检也只看 IP 还在不在。改成绑定前和巡检时先查出当前承载这个地址的网卡：记下过 `iface` 而现在不同，就停监听、已有连接 4006、进 `needs-confirmation`（和"网络变了"同一个状态和文案）；地址不在照旧 `waiting`；同一块网卡再按网关标识判断（拿不到网关时，绑定前照旧等待、巡检中照旧保持）。测试：`remote-listeners` 加"只记了网卡名""网关已知、旧网卡没了""开机/地址回来时在另一块网卡上不重绑"三条。
4. **带 zone 的 IPv6（234-2）→ 接受。** `fe80::1%eth0` 能开、进链接，客户端 `new URL('ws://[fe80::1%eth0]:7767/')` 直接报错，服务端的网卡名也不是客户端那边的 zone。这一批不支持链路本地 IPv6（`fe80::/10`，带不带 zone），开启时拒（exit 2），文字见第 11 节第 16 条，和第 1 条一起测。

设计 `devices.md` 4.2 的两句（"`0.0.0.0`/`::` 按 `public` 处理"、LISTEN-1"排空时停止接受新连接"）加了改动说明。

**复查（任务 248）的 P2：排空期间桌面端重连后被初始化快照再次踢掉 → 接受。** 第 2 条之后，排空开始时已有的连接 1001 关掉，客户端自动重连、认证、`daemonStatus` 都能过；可客户端一连上头一个请求就是快照（`watchSnapshots` 自带一次 `snapshot.get`，U2 的桌面 bridge 再显式要一次），快照不在 `DRAIN_KINDS`，`message-loop.ts` 的排空分支对白名单外的一律 `peer.close(1001)`，于是"连上 → 要快照 → 1001 → 重连"一直循环，bridge 拿不到初始快照就不发 `reattached`，升级进度看不到。设计 4.7 写的是"其余回 `draining`"，代码却是关连接。改成：

- `P/handshake.ts` 的 `DRAIN_KINDS` 加 `snapshot.get` 和 `admin.negotiate`。快照回最后一次建好的那份，`stale: true`（现成字段，界面显示"正在更新…"，不加新协议字段）：只读缓存，不重建、不问正在停的 Bot 进程；权限照表走 `authorize`，Bot 会话照样裁到自己那部分。`negotiate` 只记在这条连接上，Bot 会话和带 `--scope` 的命令行要先发它才能读快照。
- `message-loop.ts`：排空时带 id 的请求都交给 `control`，读不懂的（未知方法、参数不对）回 `draining`；没有 id 可回的帧才 1001 关。
- `http.ts` 的 `control()`：`DRAIN_KINDS` 照答，其余回错误码 `draining`（`errors.ts` 的 `drainingError()`），连接不关。白名单外的请求不做权限判断（★ 那几行会去问正在停的 Bot 进程），只有协议不同的连接照 D4a 先判：它本来就不能问的回 `protocol_mismatch` 并记一次，连续 20 条照旧 4001 关，排空与否一样。
- 命令行：`draining` 归连接类错误（exit 3，和原来连接被关时一样）；`daemon restart` 遇到它照旧报"daemon 正在停止或重启，等它结束后再试。"。
- 排空开始时已有的连接照旧 1001 关（排空期间 hub 不再推事件，关掉、重连拿一份标了 `stale` 的快照，页面才知道在排空）；`release` 时所有连接 1001 关；本机和远程同一套。

测试：`server-drain-control.test.ts` 加"重连后拿到快照、跟着看升级进度、白名单外回 `draining` 不断开"（真 `startApi`，本机用真 `connectLocal`、远程用真 `connectSecure` 经 `127.0.0.2`，都走 `watchSnapshots` 加显式 `snapshot()`；中途改进度再读一次；真命令行 `withDaemon` 发 `restartHost` 得 `connection`/`draining`；`release` 后两条都 1001），"Bot 会话排空中 negotiate 后只读到自己那部分快照，协议不同的连接 20 次越界后 4001"；原来"白名单外 1001"的那组改成回 `draining`、连接还开着，"读不懂的请求"分成"没有 id 的 1001"和"带 id 的回 `draining`"；`secure-socket.test.ts` 两条排空用例照新规则改（远程排空中快照回 `stale: true`，`release` 后通道里收到 1001）；`daemon-restart.test.ts` 加 `draining` 那一路。新加的两条在改动前都失败（快照请求把连接 1001 关了）。另用 U2（`95e21996`）的真 connections、bridge 对本片的 daemon 跑了一遍复查的探针（只把 Electron 的 IPC 和窗口换成替身，探针放在临时目录，没动审查 worktree）：排空中重连 1 次、`reattached` 1 次、收到 `stale: true` 的快照、`phase` 停在 `ready`，两次读 `coreUpdateStatus` 看到进度变化，`settings` 回 `draining`，`release` 后 1001。U2 还没合进集成分支，这一层仍由之后的复查用 U2 源码核对。
