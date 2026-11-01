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

`tailscaleIps({ exec = execFile, timeoutMs = 5000 }): Promise<{ installed: boolean; ips: string[] }>`：跑 `tailscale ip`（两族），ENOENT → `installed:false`；超时、非零退出 → `installed:true, ips:[]`。`isTailscale(host, iface, ts)`：`fd7a:115c:a1e0::/48` 只看段；100.64/10 要满足其一：网卡名以 `tailscale` 开头；或网卡名以 `utun` 开头**且** `ts.ips` 含它。`pickTailscaleAddress(ctx)`：第一个满足 `isTailscale` 的 IPv4。

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
| `daemon/test/remote-address.test.ts`（新） | 分类表 | `127.0.0.1`→loopback；`::1`→loopback；`0.0.0.0`、`::`→public；`10.1.2.3`、`172.16.0.9`、`172.31.255.1`、`192.168.1.9`、`169.254.1.1`、`fd00::1`、`fe80::1`→lan；`172.32.0.1`→public；`100.100.1.1` 在 `tailscale0` 上→tailscale；同地址在 `eth0` 上且 ts.ips 不含→cgnat；在 `utun3` 且 ts.ips 含→tailscale；`fd7a:115c:a1e0::1`→tailscale；`8.8.8.8`→public；`example.com`、`192.168.1`→invalid。main 必败 |
| 同上 | `hostHeader` | `('192.168.1.9',7767)`→`192.168.1.9:7767`；`('fd00::1',7767)`→`[fd00::1]:7767` |
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

Mac 后验（整批，U1b/U3 的任务里）：Mac 桌面端或 Mac 上的通道探针连 JP-VPS 的 Tailscale 地址能连；无通道探针被拒；`clients revoke` 后 Mac 那边 1 秒内断并显示"已撤销"文案。Windows：无专项（Windows 的 `tailscale ip` 和 `utun` 不适用，`isTailscale` 在 Windows 上只靠 `ts.ips`，I4a 后由 Windows Codex 顺带验一次 `remote enable --tailscale`）。

## 7. 文档

- `docs/product.md` 本片不改；D0 的 3.14 写"允许别的设备连接"、地址种类和 `--allow-public`、`/health`、7767。
- 官网 `/guide/remote/` → W1。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. loopback 监听的代码路径没变（`^127\.0\.0\.1:` 的 14 处检查未动，`daemon.pid` 的 `listen` 不变）。
2. 远程 server 的处理器只有 `/health` 和 WS 升级，不 import `serveWebUi`；`/health` 体恰好两个键。
3. Host 必须等于 `ip[:port]`（IPv6 带方括号），Origin 存在一律 403；`admit` 在 DH 之前。
4. 限流数值：4/IP、32 全局、20 次/分钟/IP、封 60 秒、exposed 10 次/秒；带有效 `inviteId` 的失败不计。
5. `EADDRNOTAVAIL`、`EADDRINUSE` 进 `waiting` 每 15 秒重试；`beginDrain` 后没有定时器；`release` 等所有远程 server 关完。
6. `lan` 地址开启时记 `iface`/`network`，重试前核对，不一致进 `needs-confirmation` 且不绑；`tailscale` 地址不做这项。
7. 100.64/10 的判定按 4.3（网卡名 `tailscale*`，或 `utun*` 且在 `tailscale ip` 输出里），其余归 `cgnat` 要 `--allow-public`。
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
