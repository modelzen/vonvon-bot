# D2 `devices-2-secure-channel`：Noise IK 通道、`unpaired` 状态和配对握手

总设计见 `docs/plans/devices.md` 4.3（配对握手）、4.4、4.7、第 16 节第 1 条。共用契约（`P/device.ts`、`CLOSE_CODES`、`Principal`、`Peer` 字段、`ClientRegistry`、`InviteBook`、`completePairing`）在 `docs/plans/devices-1-identity.md` 4.0 和 4.2，本文只引用。缩写同 D1。

## 1. 做什么

用户看不到新界面；这片让"另一台电脑拿着 `vonvon pair` 的链接连上来"在代码里成立：客户端用链接里的服务端公钥起 `Noise_IK_25519_AESGCM_SHA256` 通道，第一次连带 `pairRequest` 完成配对并被写进 `clients.json`，之后每次连都是双向认证、加密的 RPC。本片只在进程内的 loopback http server 上验证（D3 才把它绑到远程地址）。

依赖：D1。被依赖：D3、U1a（客户端传输）。

## 2. 范围

做：`P/secure-channel.ts`（Noise IK 状态机、帧、保活控制帧）、官方向量和坏实现互测、`CL/transport-secure.ts`、`D/server/peer-hub.ts`（从 `ws.ts` 抽出 peers/publish/drain/release）、`D/server/secure-socket.ts`（通道上的 hello、`unpaired`、`pairRequest`、每条 RPC 前的撤销核对、服务端 60 秒空闲关）、客户端关闭码到错误的映射。

不做：绑远程地址、Host/Origin、限流、`/health`、绑定重试、撤销时主动断连（本片只在下一条 RPC 时发现并关）→ D3；桌面端的密钥存储、多连接、设备页 → U1a/U1b；中继 → 以后（`DeviceRoute` 只留类型）。

## 3. 现在的代码

- 仓库没有 tweetnacl/noise 依赖，也不加：全部用 `node:crypto`（`generateKeyPairSync('x25519')`、`diffieHellman`、`createCipheriv('aes-256-gcm')`、`hkdfSync`、`createHash('sha256')`）。Electron 的 BoringSSL 有 AES-GCM 和 X25519。
- `D/server/ws.ts`：`createSocketServer()` 里 peers 集合、`publish`、`beginDrain`、`release`、`closePeers`、`accepted` 都是闭包变量，只服务一个 `http.Server`；`detachments` 按 socket 记 detach。D1 后 `Peer` 已有 `principal/protocolVersion/capabilities/scope/negotiated/address`。
- `D/server/http.ts`：`createSocketServer({ server, credential, info, request, control, detached })` 只调一次。
- `CL/transport-browser.ts`：WHATWG WebSocket 上的文本帧；`ClientConnection { isOpen, onMessage, onClose, onError, send, close }` 是 `createClient(socket)` 唯一要的接口。`CL/transport-local.ts` 用 Node `ws`。
- D1 的 `D/remote/clients.ts`（`byPublicKey` 含墓碑）、`D/remote/pairing.ts`（`InviteBook.redeem/has`、`completePairing`）、`D/remote/device.ts` 的 `deviceKeyPair()`、`P/device.ts` 的 `PairRequest/PairResult/CLOSE_CODES`。
- 测试夹具 `daemon/test/server-fixture.ts` 起的是 loopback 的 `startApi`；本片新加一个"只起 secure server"的夹具。

## 4. 怎么改

### 4.1 `P/secure-channel.ts`（daemon、client、desktop 共用；只依赖 `node:crypto`）

常量：`PROTOCOL_NAME = 'Noise_IK_25519_AESGCM_SHA256'`；`PROLOGUE = Buffer.concat([Buffer.from('vonvon-secure-channel/1','utf8'), Buffer.from([0x01])])`；`CHANNEL_VERSION = 0x01`（第一条消息的首字节，和 PROLOGUE 最后一字节相同）。

Noise 原语（按 Noise 规范 rev 34）：
- `h` 初值：`PROTOCOL_NAME` 28 字节 < 32，补零到 32；`ck = h`；`MixHash(PROLOGUE)`；预消息：发起方 `MixHash(rs)`，响应方 `MixHash(s)`（IK 的 `<- s` 预消息）。
- `MixKey(ikm)`：`hkdfSync('sha256', ikm, ck, '', 64)` → `ck = out[0..32]`，`k = out[32..64]`，`n = 0`（RFC 5869 的 salt=ck、info 空正好等于 Noise 的 HKDF，不另写 HMAC）。
- `EncryptAndHash(p)`：`k` 存在时 AES-256-GCM，nonce = 4 字节零 ‖ 8 字节大端 `n`，AAD = `h`，输出密文‖16 字节 tag；`MixHash(密文)`；`n++`。`DecryptAndHash` 对称。`k` 不存在时明文直传并 `MixHash`。
- DH：`diffieHellman({ privateKey, publicKey })`，结果 32 字节**全零即抛 `HandshakeError('handshake_failed')`**（低阶点）。
- IK 消息：`-> e, es, s, ss`、`<- e, ee, se`。消息 1 字节布局：`[0x01][e 32][enc(s) 48][enc(payload) ≥16]`；消息 2：`[e 32][enc(payload) ≥16]`。发起方先核对第一字节等于 `CHANNEL_VERSION`，不等即 `handshake_failed`（版本已在 PROLOGUE 里绑进 `h`，这一字节是早失败）。本期两条 payload 都是空 Buffer。
- `Split()`：`hkdfSync('sha256', '', ck, '', 64)` → `c1`（发起方发）、`c2`（发起方收）。握手哈希 `h` 暴露为 `channel.handshakeHash`（测向量用）。

导出：

```ts
export interface StaticKey { publicKey: Buffer /* 32 */; privateKey: KeyObject }
export function staticKeyFromBase64url(pub: string, priv: string): StaticKey;      // 复用 D1 deviceKeyPair 的 JWK 做法
export function generateStaticKey(): { key: StaticKey; publicKeyBase64url: string; privateKeyBase64url: string };
export interface HandshakeOptions { ephemeral?: StaticKey /* 只给测试向量注入 */ }
export function createInitiator(local: StaticKey, remoteStaticPublicKey: Buffer, opts?: HandshakeOptions): {
  message1(payload?: Buffer): Buffer;
  finish(message2: Buffer): { channel: Channel; payload: Buffer };       // 解不开 → HandshakeError('handshake_failed')
};
export function createResponder(local: StaticKey, opts?: HandshakeOptions): {
  readMessage1(bytes: Buffer): { remoteStaticPublicKey: Buffer; payload: Buffer };   // 版本字节、长度、tag 任一不对 → handshake_failed
  message2(payload?: Buffer): { bytes: Buffer; channel: Channel };
};
export interface Channel {
  encrypt(plaintext: Buffer): Buffer;      // [8 字节大端计数器][密文‖tag]，AAD 空，nonce 同上；计数器 = 加密前的 n（BigInt，2^64−2 封顶，到顶抛 ChannelError('exhausted')）
  decrypt(frame: Buffer): Buffer;          // 帧首 8 字节必须等于期望的 n，否则 ChannelError('replay')；tag 不对 ChannelError('tamper')；成功后 n++
  readonly handshakeHash: Buffer;
}
export class HandshakeError extends Error { code: 'handshake_failed' }
export class ChannelError extends Error { code: 'replay' | 'tamper' | 'exhausted' | 'frame' }
// 帧内容：第 1 字节类型，后面是正文
export const FRAME = { json: 0x00, ping: 0x01, pong: 0x02 } as const;
export function encodeFrame(type: FrameType, body?: Buffer): Buffer;
export function decodeFrame(plain: Buffer): { type: FrameType; body: Buffer };  // 未知类型 → ChannelError('frame')
```

通道之上仍是今天的 JSON 文本（`hello`、`serverInfo`、`request`、`response`、`event`、`error`，加 `pairRequest`/`pairResult`），全部走 `FRAME.json`，UTF-8。`ping`/`pong` 正文空。

### 4.2 `CL/transport-secure.ts`

```ts
export interface BinarySocket {    // Node ws 和 WHATWG WebSocket 的最小适配，二进制帧
  send(bytes: Uint8Array): void; close(code?: number, reason?: string): void;
  onMessage(cb: (bytes: Uint8Array) => void): void; onClose(cb: (code: number, reason: string) => void): void; onError(cb: (e: Error) => void): void;
  isOpen(): boolean;
}
export function nodeBinarySocket(ws: import('ws').WebSocket): BinarySocket;
export function webBinarySocket(ws: WebSocket): BinarySocket;   // binaryType = 'arraybuffer'
export interface SecureConnectOptions {
  socket: BinarySocket;                                // 调用方已 open 的 socket（url 由调用方拼：ws://ip:port/）
  device: { id: string; pk: string };                  // 来自配对链接或设备列表
  clientKey: StaticKey; clientKind: 'desktop' | 'cli';
  pairing?: { inviteId: string; inviteSecret: string; clientName: string };
  timers?: { ping?: number /* 20_000 */; pong?: number /* 30_000 */; handshake?: number /* 5_000 */ };
}
export interface SecureConnection { client: VonvonClient; serverInfo: ServerInfo; pairResult?: PairResult; close(): void }
export async function connectSecure(opts: SecureConnectOptions): Promise<SecureConnection>;
export class SecureChannelError extends Error { code: SecureChannelErrorCode; closeCode?: number }
export type SecureChannelErrorCode = 'device_identity_changed' | 'handshake_failed' | 'unknown_client' | 'client_revoked'
  | 'pairing_failed' | 'rate_limited' | 'remote_disabled' | 'protocol_mismatch' | 'timeout' | 'closed';
```

步骤：`createInitiator(clientKey, base64url→Buffer(device.pk))` → 发 `message1()` → 等 `message2` → `finish`；然后 `pairing` 有值就发 `pairRequest`（JSON 帧）等 `pairResult`；再发 `hello { type, protocolVersion: PROTOCOL_VERSION, clientKind }`（**不带 `credential`**）等 `serverInfo`（宽松 `serverInfoSchema`）；之后把 `Channel` 包成 `ClientConnection`（`send` = `encodeFrame(json)` → `encrypt`；`onMessage` = `decrypt` → `decodeFrame`：`json` 给上层、`ping` 回 `pong`、`pong` 清超时），`createClient(connection)`。保活：每 `ping` 毫秒发 `ping`，`pong` 毫秒内没收到任何帧 → `close(1001)` 并以 `SecureChannelError('timeout')` 结束连接。`decrypt` 抛 `ChannelError` → `close(1008, 'policy_violation')`。

关闭码到错误（握手阶段、配对阶段、hello 阶段都用这张表；`CLOSE_CODES` 的键名就是 reason）：4005 在**消息 2 到来之前**关 → `device_identity_changed`（那个地址上有 vonvon，但它的静态公钥解不开我们用链接里 `pk` 加密的消息 1；IK 下服务端换了钥匙只能这样表现，设计 4.4 "不同即 `device_identity_changed`" 在 IK 里就是这条）；消息 2 到了但 `finish` 失败 → `handshake_failed`；4002 → `unknown_client`；4003 → `client_revoked`；4007 → `pairing_failed`；4004 → `rate_limited`；4006 → `remote_disabled`；4001 → `protocol_mismatch`；其他 → `closed`。

### 4.3 `D/server/peer-hub.ts`（从 `ws.ts` 抽出）

```ts
export interface PeerHub {
  add(peer: Peer, detach: () => void): void; remove(peer: Peer): void; readonly peers: ReadonlySet<Peer>;
  publish(event: Event, shape?: (peer: Peer) => Event | null): void;    // D4a 用 shape 做 filterSnapshot
  track(promise: Promise<unknown>): void;                              // 原来的 accepted 集合
  beginDrain(): void; readonly state: 'open' | 'draining' | 'released';
  closePeers(code?: number, reason?: string): Promise<void>; release(): Promise<void>;
  closeWhere(pred: (peer: Peer) => boolean, code: number, reason: string): void;   // D3 撤销、关地址用
}
export function createPeerHub(options: { detached(peer: Peer): void }): PeerHub;
```

`createSocketServer(options)` 改成接受 `hub`，只负责 loopback 的 hello/凭据/会话令牌和消息循环；`http.ts` 建一个 hub 传给它（以及 D3 的远程监听）。`publish/beginDrain/release/closePeers` 的现有测试（`api-listen-lifecycle.test.ts`、`server-handshake.test.ts`）行为不变。

### 4.4 `D/server/secure-socket.ts`

```ts
export interface SecureSocketServerOptions {
  server: http.Server; hub: PeerHub; device: StaticKey; deviceName: () => string;
  clients: ClientRegistry; invites: InviteBook; completePairing: typeof completePairing;
  info(peer: Peer): ServerInfo; request(peer: Peer, req: Request): Promise<void>; control?(peer: Peer, req: Request): Promise<void>;
  admit?(req: http.IncomingMessage): { ok: true } | { ok: false; status: 403 | 429 };        // D3：Host/Origin、未认证连接数
  onHandshake?(address: string): 'ok' | 'rate_limited';                                       // D3：DH 前限流
  onHandshakeFailed?(address: string, reason: 'handshake_failed' | 'unknown_client' | 'pairing_failed', validInvite: boolean): void;
  timers?: { handshake?: number /* 3_000 */; pairing?: number /* 5_000 */; idle?: number /* 60_000 */ };
}
export function createSecureSocketServer(options: SecureSocketServerOptions): { close(): Promise<void> };
```

每条连接的状态机（`WebSocketServer({ server, perMessageDeflate: false, maxPayload: 4_000_000 })`，`verifyClient` 调 `admit`）：
1. `handshake`：`onHandshake(address)` 回 `rate_limited` → 立刻 `close(4004,'rate_limited')`，**不读帧**。否则等第一帧，3 秒超时 → 4005。**未认证阶段每帧手动核对长度 ≤ 4096 字节**，超了 4005（`ws` 的 `maxPayload` 是 server 级的，不能按 socket 事后改；全局未认证连接 ≤32 条由 D3 限，见第 9 节）。第一帧必须是文本以外的二进制帧且 `readMessage1` 成功，否则 4005 + `onHandshakeFailed(…,'handshake_failed',false)`。
2. 查 `clients.byPublicKey(rs)`：
   - 有且 `revokedAt` → 回消息 2（让客户端能解出关闭原因前的状态一致）后 `close(4003,'client_revoked')`。
   - 有且未撤销 → 回消息 2，进入 `hello`，`principal = { kind:'owner', via:'paired', clientId, generation: clients.generation }`，`clients.touch(clientId, address)`。
   - 没有 → 回消息 2，进入 `unpaired`，5 秒内只接受一帧 JSON `pairRequest`（`pairRequestSchema`）；别的、超时 → `close(4002,'unknown_client')`，`onHandshakeFailed(…,'unknown_client', invites.has(inviteId))`（第二个参数：帧里带了存在的 `inviteId` 就算 `validInvite`，设计 4.3 的例外）；`completePairing` 抛 `pairing_failed` → `close(4007,'pairing_failed')` + `onHandshakeFailed(…,'pairing_failed', validInvite)`；成功 → 发 `pairResult { type:'pairResult', clientId, deviceName }`，进入 `hello`，principal 同上。`completePairing` 的 `address` 填 `peer.address`。
3. `hello`：下一帧必须是 `helloSchema`；`credential` 字段存在 → `close(4401,'unauthorized')`（远程不收任何凭据，设计 4.4、5.3）；`protocolVersion !== PROTOCOL_VERSION` → principal 包成 `maintenance`（执行归 D4a）；`hub.add(peer)`，发 `info(peer)`（v2 形状，`principal 'owner:paired'`）。
4. `ready`：JSON 帧走和 `ws.ts` 相同的消息循环（`requestSchema`、`unknown_method`、`invalid_request`、drain 判断——把这段从 `ws.ts` 抽成 `D/server/message-loop.ts` 的 `handleMessage(hub, peer, raw, options)` 两边共用）；**每条请求前**：`clients.get(clientId)` 不存在或 `revokedAt` → `close(4003)`（D3 再加撤销瞬间的主动断连）。`ping` 帧回 `pong`；任何帧都刷新空闲计时，60 秒无帧 → `close(1001,'server_shutdown')`。`decrypt` 抛 → `close(1008,'policy_violation')`。
5. 任何阶段 socket 关闭 → detach（`hub.remove`、`options.detached`）。握手未完成的连接不进 hub，不收 `publish`。

`http.ts`：本片**不**创建远程监听（D3）；只把 `createPeerHub`、`handleMessage` 接进 loopback 路径，并把 `device/clients/invites/completePairing/info` 装进一个 `secureDeps` 对象供 D3 传给 `createSecureSocketServer`。本片的集成测试自己起一个 `http.createServer()` 在 `127.0.0.1:0` 上挂 `createSecureSocketServer`。

### 4.5 顺序

4.1（先只跑官方向量）→ 4.3（抽 hub，跑旧测试绿）→ 4.4 → 4.2 → 集成测试 → 另一个模型的多角度审查（设计 4.4 末尾、16.1）。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `protocol/test/secure-channel-vectors.test.ts`（新） | 官方向量 | 夹具 `protocol/test/fixtures/noise-ik-25519-aesgcm-sha256.json`：从 cacophony 的 `vectors/cacophony.txt` 抽出 `protocol_name === 'Noise_IK_25519_AESGCM_SHA256'` 的全部条目（含带 prologue 的），夹具旁 `README.md` 写来源 URL、抽取日期和许可。每条：用 `init_static/init_ephemeral/resp_static/resp_ephemeral` 注入，`prologue` 用向量的（这条测试里不用 `PROLOGUE`），逐条 `messages[i].payload` → 密文等于 `ciphertext`，收方解出 payload；`handshake_hash` 相等。**没有这份夹具不合入**。main 必败 |
| `protocol/test/secure-channel.test.ts`（新） | 往返 | 真随机密钥，`PROLOGUE`，两条空 payload；`c1.encrypt('a')` → `c2.decrypt` 回 `'a'`；连发 1000 帧计数器 0..999 |
| 同上 | 坏实现互测 | 响应方 prologue 改成 `…/2` → 发起方 `finish` 抛 `handshake_failed`；消息 1 第一字节改 `0x02` → 响应方 `handshake_failed`；消息 1 改任一密文字节 → `handshake_failed`；发起方拿错的 `rs` → 响应方 `readMessage1` 抛；全零 DH：构造公钥全零 → `handshake_failed` |
| 同上 | 帧 | 重放同一帧 → `ChannelError('replay')`；两帧交换顺序 → `replay`；改 tag 一字节 → `tamper`；`decodeFrame(0x09)` → `frame` |
| 同上 | 密钥格式 | `generateStaticKey()` 的 base64url 43 字符；`staticKeyFromBase64url` 往返 |
| `client/test/transport-secure.test.ts`（新，用进程内假 `BinarySocket` 对）| 配对 + hello | 假服务端（用 `createResponder` + `pairResult` + v2 serverInfo）→ `connectSecure` 回 `pairResult.clientId`、`serverInfo.principal === 'owner:paired'`；`hello` 帧里没有 `credential` |
| 同上 | 关闭码映射 | 服务端在消息 2 前 `close(4005)` → `device_identity_changed`；消息 2 坏 → `handshake_failed`；4002/4003/4007/4004/4006/4001 各对应一个 code |
| 同上 | 保活 | 假时钟：20 s 发出 `ping`；收到 `pong` 不断；30 s 无帧 → `close(1001)`、`timeout` |
| `daemon/test/peer-hub.test.ts`（新） | 抽出后行为 | `publish` 只到 `open` 的 peer；`shape` 回 `null` 的 peer 收不到；`beginDrain` 后 `closePeers`；`release` 等 `track` 的 promise。原 `api-listen-lifecycle.test.ts`、`server-handshake.test.ts` 不改仍绿 |
| `daemon/test/secure-socket.test.ts`（新，真 `http.Server` + 真 `ws`，127.0.0.1:0） | 未知公钥拿不到 serverInfo | 新钥匙、不带 `pairing` → 收不到任何 JSON，5 s（假时钟）后 close 4002；`onHandshakeFailed('unknown_client', false)` |
| 同上 | 配对成功 | 有效邀请 → `pairResult`，`clients.json` 多一条（`invitedBy:'local'`、`lastAddress` 是 127.0.0.1:端口）；随后 `hello` → v2 serverInfo `principal 'owner:paired'`；`hub.peers.size === 1`；再发 `admin.daemonStatus` 得到回复（加密 RPC 往返）。main 必败 |
| 同上 | 邀请坏 | secret 差一位 → 4007，`onHandshakeFailed('pairing_failed', true)`；`inviteId` 不存在 → 4007 且 `validInvite false`；同一邀请第二台 → 4007 |
| 同上 | 墓碑 | 配对后 `clients.revoke(id)`，用同一钥匙重连 → 4003；已连着的那条下一条 RPC 时被关 4003 |
| 同上 | 带凭据的 hello | 已配对钥匙发 `hello { credential:'x' }` → 4401 |
| 同上 | 换了服务端钥匙 | 用另一把 `device` 钥匙起服务端，客户端拿旧 `pk` → 服务端 4005，客户端 `device_identity_changed` |
| 同上 | 篡改一帧 | 配对后从 socket 层改一个密文字节 → 1008，peer 从 hub 消失，`detached` 被调 |
| 同上 | 超时和大小 | 3 s 不发第一帧 → 4005；第一帧 4097 字节 → 4005；连上后 60 s 无帧 → 1001；`ping` 得 `pong` 且计时刷新 |
| 同上 | admit | `admit` 回 `{ok:false,status:403}` → 升级被拒，`onHandshake` 没被调；`onHandshake` 回 `rate_limited` → 4004 且 `readMessage1` 没被调 |
| 同上 | 排空 | `hub.beginDrain()` 后远程 peer 只能发 `DRAIN_KINDS`，其余 1001（和 loopback 同一段 `handleMessage`） |

## 6. 自测和验收

Linux 上自测，无需 Mac：

1. `T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/protocol/test/secure-channel-vectors.test.ts packages/protocol/test/secure-channel.test.ts packages/client/test/transport-secure.test.ts packages/daemon/test/peer-hub.test.ts packages/daemon/test/secure-socket.test.ts packages/daemon/test/server-handshake.test.ts packages/daemon/test/api-listen-lifecycle.test.ts`；再 `flock /tmp/vonvon-heavy.lock npm run typecheck --workspaces`、`lint`、protocol/client/daemon 的 `build`。`rm -rf -- "${T:?}"`。
2. 两个进程间的配对 + 加密 RPC（设计 13 节 D2 验收行）：写一个只在本片 PR 里用的脚本 `packages/daemon/test/manual/secure-probe.ts`（进 git，`test/manual/` 不在 vitest include 里）：进程 A 在 mktemp 的数据目录里 `startApi` 并在 `127.0.0.1:0` 挂 `createSecureSocketServer`，用 D1 的 `InviteBook` 造一条链接打印出来；进程 B 读链接 `connectSecure` 带 `pairing`，打印 `pairResult`、`serverInfo`、`admin.daemonStatus` 的回复，然后不带 `pairing` 再连一次成功，最后把 `clients.json` 改成撤销再连 → `client_revoked`。两个进程都用 `HOME=$T/home VONVON_HOME=$T/vh` 前缀，结束 `rm -rf -- "${T:?}"`。PR 描述贴脱敏的输出（不贴链接本身）。
3. 向量文件的来源和许可写进 `fixtures/README.md`；PR 描述写明条数。
4. 多角度审查：另一个模型（Codex）按设计 4.4、16.1 审 `secure-channel.ts` 和 `secure-socket.ts`：转录哈希顺序、nonce 构成、AAD、低阶点、未认证前不处理任何 RPC、`unpaired` 只收一帧、错误路径都关 socket；每条发现先复现再改。

Mac 后验（整批）：U1a 的桌面端用 `webBinarySocket`/`nodeBinarySocket` 连 JP-VPS，属于 U1b 的验收。Windows：无专项。

## 7. 文档

- `docs/product.md` 本片不改（D0 写 3.14 "连接是加密的、配对后只认这台设备的钥匙"）。
- `docs/architecture.md` "远程访问端到端加密" 一节由 D0 改成"直连也走通道"；本片不动。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. `P/secure-channel.ts` 只 import `node:crypto`、`node:buffer`；`package.json` 没有新依赖。
2. 官方向量夹具存在、来源写明、测试全绿；`PROLOGUE` 字节是 `76 6f 6e … 2f 31 01`。
3. 消息 1 首字节 `0x01`、长度 1+32+48+16 = 97（空 payload）；消息 2 长度 48；帧 = 8 字节计数器 + 密文 + 16 字节 tag。
4. 服务端在 `readMessage1` 之前已调 `onHandshake`，之后才做任何 DH；未认证连接没进 `hub`，收不到 `publish`。
5. `unpaired` 状态：只收一帧、5 秒、不回 serverInfo、不处理 RPC；`pairRequest` 里没有 `clientPk` 字段，登记的公钥来自通道。
6. 远程 hello 带 `credential` 一律 4401；已配对连接每条 RPC 前核对墓碑。
7. 客户端关闭码映射和 4.2 的表一致；`device_identity_changed` 只在消息 2 之前的 4005 上给。
8. `ws.ts` 和 `secure-socket.ts` 共用 `handleMessage`，排空和维护子集的判断只写一处。
9. 篡改、重放、乱序都以 1008 关闭且 peer 被 detach（`jobs.detach`、`logs.detach` 被调）。
10. 配对链接、邀请 secret、密钥不进日志；`manual/secure-probe.ts` 的输出在 PR 里脱敏。
11. 行数 ≤1,500（不含向量夹具）。
12. diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 估计约 1,350 行（`secure-channel.ts` 300、`transport-secure.ts` 220、`peer-hub.ts` + `message-loop.ts` 抽取净增 120、`secure-socket.ts` 280、测试 430），比设计 13 节的 ~1,000 多，仍在 1,500 内；超了就把 `transport-secure.ts` 和它的测试拆成 D2b。
- **自己写 Noise 状态机**（设计 16.1）：靶子是官方向量 + 坏实现互测 + 另一个模型审查。向量里只有带 `init_prologue` 的条目能顺带验 prologue 处理，`PROLOGUE` 本身的字节由单测钉死。
- `ws` 的 `maxPayload` 只能 server 级：未认证阶段靠手动 4 KB 核对 + D3 的"每 IP 4 条、全局 32 条未认证连接"把最坏内存压到 32 × 4 MB；这是对设计 4.3 "`maxPayload` 降到 4 KB" 的实现偏差，效果一样，写进 PR。
- IK 下服务端换钥匙的表现只能是 4005（它读不出消息 1）；把它映成 `device_identity_changed` 是本片定的，和设计 4.4 的意图一致，但"同地址上换成别的非 vonvon 服务"也会落到这里（那种情况多半没有 4005，而是 1006/升级失败，映到 `closed`）。
- 撤销瞬间的主动断连在 D3（本片只在下一条 RPC 时关），设计 13 节已把撤销验收挪到 D3。
- Electron 侧 `webBinarySocket` 未在本片真机验证（U1a 用它），只有假 socket 单测。
