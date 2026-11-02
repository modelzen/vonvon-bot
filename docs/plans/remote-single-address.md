# remote-single-address 计划：远程只开一个地址，不绑 Tailscale（A1）

2026-11-02，Claude 写，计划和代码同一个分支，PR 回集成分支 `claude/devices-integration`（不跑 CI）。总设计是 `docs/plans/devices.md` 4.2、4.3、6.2、第 15 节，这一片的改动记在第 21 节。行号按集成分支 5278514d。路径缩写同设计：`P/` protocol、`D/` daemon、`DT/` desktop、`U/` ui 的 `src/`。

owner 2026-11-02 定：远程连接的体验和能力和 Orca、Paseo 差不多或稍好就行，以后主打账号中继；不做自定义地址和内网穿透。Tailscale 只是建议，不绑死：去掉 `--tailscale`；不让用户填网卡名；只开一个地址。

## 1. 做什么

用户看得到的变化：
- `vonvon remote enable` 不给地址时，在终端里列出这台设备的地址让人选，标签是人话："Tailscale（推荐）· 100.x""组网 · ZeroTier · 10.x""局域网 · 192.168.x""公网 · …（要确认）"。不在终端里时退出码 2，列出地址和示例命令。
- 新命令 `vonvon remote candidates [--all] [--json]`，和上面同一个列表。Docker、虚拟机的网桥，代理软件的 fake-IP 默认不列。
- 只开一个地址：再开一个就换掉原来的，原来的马上停止监听。有已配对的设备时，输出里写怎么让它们跟到新地址。
- 蒲公英、ZeroTier、EasyTier、NetBird、WireGuard 这类组网工具的地址标"组网"，不用确认；macOS 上虚拟网卡重启后换了编号，不再误报"网络变了"。
- `--tailscale` 没有了。`remote disable` 不给地址时关掉开着的那个。

依赖：D3（#646）、U1（#647）、U2（#649）已在集成分支。

## 2. 范围

做：
- protocol：`addressKindSchema` 加 `overlay`；`device.enable` 只收 `{ host, allowPublic? }`。
- daemon：`D/remote/address.ts`（组网识别、文案、`resolveEnable`）、新文件 `D/remote/candidates.ts`、`D/remote/config.ts`（单地址）、`D/server/remote-listeners.ts`（组网地址的网卡核对）、`D/server/rpc/device.ts`（文案）、`D/cli/commands/remote.ts`、`D/cli/index.ts`、`D/cli/command-error.ts`。
- ui：`U/devices/devices-presentation.ts` 的地址标签、连不上的提示、`remote_disabled` 文案。
- 文档：`docs/product.md` 3.14、`docs/plans/devices.md`（4.2、4.3、6.2、第 10、12、15 节，加第 21 节）、U3 计划文首、U1a/U1b 验收命令。

不做：
- 桌面端"允许别的设备连接"面板（U3）。本片只保证协议和 daemon 是单地址，U3 计划文首写了要改的地方。
- 自定义地址、内网穿透（owner 不做）。
- 连着的客户端自动跟到新地址：要服务端先推一条"新地址"、桌面端改记的地址，是新协议加桌面端改动，第 4.5 节说为什么现在不做。
- `device.status` 里带候选：U3 加（`remote.candidates`）。

## 3. 现在的代码

- `P/device.ts`：`addressKindSchema` 五种（loopback、tailscale、lan、cgnat、public）；`deviceRequestSchema` 的 `enable` 是 `{ host?, tailscale?, allowPublic? }`，两个给一个；`deviceStatusSchema.remote.addresses` 是数组；`pairingLinkSchema.addresses` 是数组、至少一项。`P/desktop-devices.ts` 的 `deviceRouteSchema.kind` 由 `addressKindSchema` 去掉 loopback 得来。
- `D/remote/address.ts`：`classifyAddress`（不是 IP、回环、通配、Tailscale、LAN、CGNAT、公网）；`pickTailscaleAddress`（`--tailscale` 用）；`resolveEnable` 处理 `tailscale` 分支，报 `tailscale_unavailable`；文案常量里有 `--tailscale`。
- `D/remote/config.ts`：`enableAddress` 同一个 host 替换，别的追加。
- `D/server/remote-listeners.ts`：每个地址一个 server；`sync` 对照配置，少了的先关（4006）再开新的；`lan` 地址绑定前和每 15 秒核对网卡和网关（`lanCheck`），别的分类只看地址在不在。
- `D/cli/commands/remote.ts`：`enable` 要 IP 和 `--tailscale` 二选一；`disable <ip>` 必须给。
- `DT/connections.ts`：链接里的设备已经加过、地址变了时（`already_added` + `routesChanged`），`add` 只更新它记的地址（新的排前面，旧的留后面，最多 8 个），不用掉邀请；`U/devices/AddDeviceDialog.tsx` 这时自动提交。这就是"换了地址后已配对的设备怎么跟上"现成的路。
- `U/devices/devices-presentation.ts`：`routeKindLabel`、`routeHint` 按分类写；`remote_disabled` 的文案里有 `--tailscale`。

## 4. 怎么改

### 4.1 协议
- `addressKindSchema` 加 `overlay`，放在 tailscale 后面。链接、设备状态、桌面端记的地址都跟着认。0.9.0 还没发布，没有旧客户端要兼容。
- `enable` 改成 `{ type: 'enable', host: string, allowPublic?: boolean }`。
- `remote.addresses`、链接的 `addresses` 形状不变，注释写"最多一项"。不加 `.max(1)`：daemon 那边保证，协议不收紧，免得以后加中继、账号的连接方式时又要改。

### 4.2 分类和组网（`D/remote/address.ts`）
- `overlayOf(iface)`：按网卡名认组网工具，认得出名字的给 `tool`：ZeroTier（`zt…`、macOS `feth…`、Windows `ZeroTier One […]`）、NetBird（`wt0`）、EasyTier（Windows `et_0`）、蒲公英（`oray…`/`pgy…`，没在真机上核实）、Hamachi（`ham0`、`Hamachi`）、WireGuard（`wg…`）。`tun0`、`utun3`、`tap0` 这类普通隧道算组网，但没有名字。
- `classifyAddress`：Tailscale 照旧先判。之后私有段在组网网卡上 → `overlay`；100.64/10 只有网卡名认得出工具时才是 `overlay`，普通隧道上的照旧 `cgnat`（任务要求"CGNAT 段里不是组网工具的照旧要确认"）；公网段在什么网卡上都是 `public`（有的 VPN 把能从公网连到的地址放在隧道网卡上）。
- `resolveEnable`：去掉 `tailscale` 分支；`overlay` 不要确认，也不记网卡和网关。
- 文案：`TAILSCALE_HINT`、`cgnatWarning`（"不在 Tailscale 或别的组网工具的网卡上"）、通配和链路本地的拒绝文案都不再提 `--tailscale`，改成"在终端里运行 `vonvon remote enable` 选一个……"。CGNAT 和公网的风险句单独导出（`cgnatRisk`、`PUBLIC_RISK`），终端里问的时候不带"请加 `--allow-public`"。

### 4.3 候选（`D/remote/candidates.ts`，新）
```ts
export interface Candidate { host: string; kind: Exclude<AddressKind, 'loopback'>; iface: string; tool?: string; hidden?: 'bridge' | 'proxy' | 'self-assigned' }
export function listCandidates(ctx: AddressContext, options?: { all?: boolean }): Candidate[];
export async function candidateContext(deps): Promise<AddressContext>;   // 只在需要时跑 tailscale ip
export function defaultCandidate(list): Candidate | undefined;            // Tailscale 的 IPv4，没有就第一个不用确认的
export function candidateLabel(candidate, recommended?): string;
```
- 取所有非 internal 的地址，用 `classifyAddress` 分类，去掉回环和不是 IP 的。IPv6 只留 Tailscale 段（U3 计划同样这么定）。
- 默认不列：虚拟网桥（docker、br-、virbr、vmnet、vboxnet、veth、lxcbr、lxdbr、incusbr、podman、cni、flannel、macOS 的 `bridge100` 起、Windows 的 `vEthernet (Default Switch|WSL…|DockerNAT)`、VMware、VirtualBox Host-Only）；198.18.0.0/15（Clash、mihomo、sing-box 的 fake-IP）；169.254/16。`--all` 才列，排在最后，标签写原因。Windows 外部交换机（`vEthernet (<名字>)`）带的是真局域网，不算网桥。
- 排序：不隐藏的在前；tailscale、overlay、lan、cgnat、public；IPv4 在 IPv6 前；再按网卡名、地址。
- `tailscale ip` 只在有 100.64/10 地址、又没有 `tailscale*` 网卡名时跑：Linux 服务器上 `tailscale0` 已经说明了，不起子进程。

### 4.4 单地址（`D/remote/config.ts`、`D/server/remote-listeners.ts`）
- `enableAddress` 直接换成 `[address]`。监听器的 `sync` 不用改：旧地址不在新配置里，先 `stop`（连接 4006）再开新的，"旧地址停止监听"在新地址开始之前。
- `readRemoteConfig` 读到多项（A1 之前 D3 写的）时只留 `enabledAt` 最大的一项，下次写回就只剩它。
- 组网地址的核对（`overlayCheck`）：绑定前和每 15 秒的巡检里，看承载这个地址的网卡还是不是组网网卡。是（编号变了也算）→ 照常；不在 → 照旧等地址出现；在普通网卡上 → 停监听、连接 4006、进 `needs-confirmation`，文案"<地址> 现在不在组网工具的网卡上了（可能是别的网络分到了同一个地址）。确认现在的网络是你信任的，再重新开启。"。不比网卡名，是因为 macOS 的 utun、feth 编号重启后会变，比名字每次重启都要人确认；不完全不查，是因为咖啡馆的网络也可能分到同一个私有地址。

### 4.5 已配对的设备怎么跟到新地址
沿用 U1 的"地址变了"：在这台运行 `vonvon pair` 生成链接，粘到那台的"添加设备"里，桌面端只更新它记的地址，不用重新配对。`remote enable` 换了地址、又有已配对的设备时，输出写：

> 已配对的 N 台设备要换到新地址：运行 `vonvon pair` 生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。

客户端收到 4006（`remote_disabled`）时，桌面端文案改成"关闭了远程连接，或者换了地址……换了地址的话，在那台设备上生成新的连接链接，粘到"添加设备"里，只会更新地址，不用重新配对。"。

不做"换之前先给连着的客户端推一条新地址"：要新的事件类型、桌面端收到后改它记的地址、还要想清楚只有当时连着的客户端能收到，没连着的照样要粘链接。owner 说以后主打账号中继，中继上线后地址不再写死在客户端里，这件事就没了。

### 4.6 命令行（`D/cli/commands/remote.ts`、`D/cli/index.ts`）
- `remote enable [<ip>] [--allow-public]`：
  - 给了地址：照 D3，公网和运营商地址要 `--allow-public`，终端里也不问（脚本在终端里跑也不该停下来等人）。
  - 没给、在终端里（stdin、stdout 都是 TTY，不带 `--json`）：打印列表，问"选一个 [1]: "，回车选 `defaultCandidate`；编号以外的输入再问；也能直接打一个 IP。选到运营商、公网地址先问风险，`y` 才开。Ctrl-C、EOF、回答不是 y：退出码 130，"已取消，什么都没改。"。
  - 没给、不在终端里：退出码 2，`reason: 'address_required'`，报错里列出候选和"选一个运行，例如：vonvon remote enable <第一个>"；没有候选时给 Tailscale 建议和 `vonvon remote enable 100.x.y.z`；`--json` 的 `partial.candidates` 带候选。
  - 列表是命令行在本机算的，daemon 用自己的环境再分类一次（后台服务的 PATH 里可能没有 `tailscale`）。两边说法不同、daemon 回 `confirm_required` 时，终端里问一次风险，同意后带 `allowPublic` 再发一次。
  - 换掉原来的地址时：经 daemon 时在同一条连接里先读一次 `status` 再 `enable`；没 daemon 时在写文件的那一步里拿旧地址。输出先写"已把远程地址从 A 换成 B，A 不再接受连接[，经它的连接已断开]。"，有已配对的设备时最后加 4.5 那句。`--json` 多 `replaced`。
- `remote candidates [--all] [--json]`：只读本机网卡，不经 daemon，不拿数据租约。人看的输出列出候选、给一条 `enable` 的例子；有隐藏的时说"另有 N 个一般用不上的地址……运行 `vonvon remote candidates --all` 列出。"。`--json`：`{ ok, candidates: [{ host, kind, iface, tool?, hidden?, label, recommended?, needsConfirmation? }] }`。没有对应的 RPC，`covers` 不写。
- `remote disable [<ip>]`：不给地址时关掉开着的那个，没有开着的退 2"现在没有开启的远程地址。"。
- `LOCAL_ONLY` 加 `remote candidates`（远程连接的命令都只给主人在这台电脑上跑，会话里拒）。`command-error.ts` 去掉 `tailscale_unavailable`。

### 4.7 桌面端
- `routeKindLabel` 加"组网"，`routeHint` 加组网那句（"两台设备都连在同一个组网（ZeroTier、蒲公英这类工具）里吗？先在这台电脑上 ping <地址> 看看通不通。"）。
- `remote_disabled` 文案改成 4.5 那句。
- U1、U2 的代码里没有按"服务端开了几个地址"展示的地方：设备行里的 `routes` 是客户端自己记的、试连的顺序（换过地址时新旧都在），不是服务端开着的地址，不改。

## 5. 测试

| 文件 | 用例 | 期望 |
|---|---|---|
| `protocol/test/device.test.ts` | enable 和 overlay | `enable` 没 host、带 `tailscale` 都解析失败；`overlay` 的链接往返。main 必败 |
| `daemon/test/remote-address.test.ts` | 组网识别 | 各工具的网卡名认出工具；普通隧道没名字；`en0`、`docker0`、`tailscale0` 不算；私有段在组网网卡上是 `overlay`，100.64/10 只在 `wt0` 上是、`utun4` 上仍是 `cgnat`，公网段在 `ham0` 上仍是 `public`。main 必败 |
| 同上 | `resolveEnable` | 文案不再有 `--tailscale`；组网地址不确认、不记网卡 |
| `daemon/test/remote-candidates.test.ts`（新） | 列表 | 注入一台 Mac 的网卡：Tailscale（utun4，IPv4 和 IPv6）、ZeroTier（feth2）、Wi-Fi、代理 TUN 198.18.0.1、bridge100、docker0、169.254、CGNAT、公网 → 默认六项、顺序对、标签对；`--all` 四个隐藏的排最后；Windows 的 WSL、Default Switch、VMware、VirtualBox 不列，外部交换机列；没 Tailscale 时默认第一个不用确认的；`tailscale ip` 只在需要时跑。main 必败 |
| `daemon/test/remote-config.test.ts` | 单地址 | `enableAddress` 换掉原来的；并发三次改端口都生效；旧文件多项读成最后开的那项，写回只剩它。main 必败 |
| `daemon/test/remote-listeners.test.ts` | 组网核对 | 组网地址在 utun3 上在听，换成 utun5 照常在听，跑到 en0 上连接 4006、进 `needs-confirmation`；启动时就在 en0 上不绑。换地址：旧地址的连接 4006、`/health` 连不上。main 必败 |
| `daemon/test/rpc-device-remote.test.ts` | RPC | `enable` 没 host、带 `tailscale` 都是 `invalid_request`；开了公网再开 LAN，状态和文件里只剩 LAN。main 必败 |
| `daemon/test/cli-remote.test.ts` | 命令行 | 没 daemon：换地址的输出、有已配对设备时的"跟着换"那句、`replaced`、`disable` 不给地址；`candidates` 的人话和 JSON、`--all`；不在终端里或 `--json` 没给地址退 2 带候选；终端里回车选 Tailscale、输错再问、选 ZeroTier、选公网问风险、拒绝和 Ctrl-C 退 130 什么都不改、直接打 IP；经 daemon：换地址的输出带"经它的连接已断开"、daemon 和列表说法不同时问一次再发。main 必败 |
| `daemon/test/cli-json.test.ts` | 退出码 | `remote enable`（2）、`remote disable`（2，没开着的）、`remote candidates`（0） |
| `daemon/test/cli-bot-session.test.ts` | 会话里拒 | `remote enable`、`remote candidates` 在会话里退 4 |
| `ui/test/devices-presentation.test.ts` | 文案 | 组网的标签和提示；`remote_disabled` 说"换了地址"、不提 `--tailscale` |

测试只注入假的网卡数据；真监听的用例照 D3 用 `127.0.0.2`，换地址的新地址用一个本机没有的地址（只会进"等待"）。

## 6. 自测

JP-VPS，Claude 自己跑：protocol、client、daemon、ui、desktop 的 typecheck；上面这些测试文件。不在真实的 Tailscale、局域网、公网地址上监听；不碰 Paseo daemon、`accept-home2`、`~/.vonvon-bot`。真机验收（Mac 上 ZeroTier 或蒲公英重启后不误报、Windows 网卡名）留给整批验收。

## 7. 文档

- `docs/product.md` 3.14"让它能被连上"。
- `docs/plans/devices.md`：4.2、4.3、6.2、第 10 节第 3 条、第 12 节终端那行、第 15 节文案，加第 21 节。
- `docs/plans/devices-ui-3-served.md` 文首"A1 之后要改的地方"；`devices-ui-1a`、`devices-ui-1b` 的验收命令去掉 `--tailscale`。

## 8. 验收要点

- 没有 `--tailscale`、没有 `pickTailscaleAddress`、没有 `tailscale_unavailable`；`device.enable` 必须带 host。
- 开第二个地址后 `remote.json` 和 `device.status` 都只有一项，旧地址的连接 4006。
- 不在终端里、`--json` 时 `remote enable` 不会停下来问。
- 运营商地址：普通隧道上的 100.x 仍要确认；公网段在任何网卡上都要确认。
- 组网地址换了隧道编号不进 `needs-confirmation`，跑到普通网卡上进。
- 候选过滤：docker0、br-、virbr、vmnet、vboxnet、veth、Hyper-V Default Switch、WSL、198.18/15 默认不列，`--all` 列。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 900 行（含测试和文档）。审查分两块：地址选择与候选（`address.ts` 的组网识别、`candidates.ts`、命令行）；监听替换与已配对设备（`config.ts`、`remote-listeners.ts`、`rpc/device.ts`、协议、桌面端文案）。

- 网卡名认组网是猜的：蒲公英的网卡名没在真机上看过；Windows 上 WireGuard 的网卡名是用户起的，认不出就按局域网算（照旧可能误报"网络变了"）。
- 普通隧道（`utun`、`tun`）上的私有地址都算组网，公司 VPN 的地址也会标"组网"。它本来就不是局域网，标错的代价只是标签。

## 10. 实现时和计划不一样的地方

- 网桥规则里的 `veth` 不分大小写时会把 Windows 外部交换机 `vEthernet (<名字>)` 也当网桥藏掉（测试抓到的），改成 `veth` 后面不能接 `ernet`。
- 任务原话是组网"按网卡名或地址段认"。只有 Tailscale 按地址段认（`fd7a:115c:a1e0::/48`，100.64/10 加 `tailscale ip` 核对）；别的组网工具只按网卡名认：ZeroTier、蒲公英、EasyTier 的网段都是用户或管理后台自己定的私有段，按段认会把普通局域网也标成"组网"，还会让局域网地址跳过"网络变了"的确认。
- `docs/architecture.md` 的远程监听一段也一起改了（只开一个地址、`overlay` 种类、候选过滤）。
