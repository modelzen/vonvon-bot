# 设备：服务端补齐、安装脚本、远程连接、多设备客户端（总设计，第 3 版：owner 2026-10-31 确认后；2026-11-01 命令行只装服务端，只在 Linux 上做）

owner 2026-10-31 定（`requirements.md` 五轮，后面的轮次覆盖前面的）：四块一起设计、一波实现，开发分支都合到一个集成分支，最后统一跑一次 CI，三平台同一个版本 0.9.0 发布（`AGENTS.md`"2026-10-30 起"）。产品行为以 `requirements.md` 为准，本文只写做法、共享契约和切片。第 2 版第 14 节"待 owner 确认"的各条，owner 2026-10-31 都答了，答案已写进正文，第 14 节改成"owner 已定"表，没有还开着的产品选择；这一轮改了什么见第 18 节。第 1 版经三位审查者（安全、可行性、需求）审过，改了什么见第 17 节；`devices.draft1.md` 是第 1 版原文。2026-11-01 owner 又定：命令行只装服务端只在 Linux 上做，Mac、Windows 只用安装包装全部软件；I2b、I4a、I4b 取消，改了什么见第 19 节，和前面各节、第 17、18 节的记录冲突时以第 19 节为准。2026-11-02 owner 又定：对话读、改设置只在私聊里有，群会话没有设置工具；vonvon 不发自己的飞书 skill 和设置 skill，K1 加的撤掉（S1 `settings-dm-only`），改了什么见第 20 节，和前面冲突时以第 20 节为准。2026-11-02 owner 还定了：远程只开一个地址，去掉 `--tailscale`，不做自定义地址和内网穿透，组网工具的地址单独标"组网"（A1 `remote-single-address`），见第 21 节，和前面冲突时以第 21 节为准。

调研基线：`origin/dev` 32f0d521。路径前缀：`P/` = `packages/protocol/src/`，`D/` = `packages/daemon/src/`，`CL/` = `packages/client/src/`，`DT/` = `packages/desktop/src/`，`U/` = `packages/ui/src/`。行号按 32f0d521，漂了按函数名找。"未核实"是没在代码或实机上确认过的判断。正文引用的调研笔记（远程就绪、安装升级、Paseo、Orca/Tailscale/中继、服务端和命令行清单、功能对照表 156 行及其复核）是英文原文，没进仓库；和本文冲突时以本文为准。

## 1. 做什么 / 不做什么

**做：**
1. 服务端和命令行补齐：页面上客户端能做的，服务端都支持，`vonvon` 命令行都能做；每条命令不交互也能跑完，`--json`、退出码、原因齐全（第 8 节）。
2. 安装脚本（只在 Linux）：`curl -fsSL https://dl.vonvon.cc/bot/server/install.sh | sh`，装服务端 + `vonvon` 命令 + 开机自启的后台服务，自带 Node（第 7 节）。Mac、Windows 不做命令行只装服务端：用户装桌面端安装包，里面自带服务端（owner 2026-11-01："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"）。
3. 远程连接：一台设备的服务端能被别的设备上的桌面端连上管理，配对链接、每台客户端一份可撤销的授权、加密通道（第 4、5 节）。
4. 多设备客户端：桌面端默认连本机，再加别的设备，切换着看（第 6 节）。
5. 升级：客户端里看到服务端版本、直接升级它，桌面端自带的服务端也行（那台的桌面端要开着，6.5）；`vonvon update`；版本对不上连接时提示（第 4.6、7.5 节）。
6. ~~三个内置 Skill（飞书、设置、任务）改成配合新命令行和范围参数（第 9 节）~~ 2026-11-02 作废：只留任务 skill（K1 之前的样子），不发飞书、设置 skill，群会话没有设置工具（第 20 节）；官网一篇"远程连接 / 多设备"说明（第 10 节）。

**不做（本期）：** vonvon 账号；vonvon 运营的中继（relay）；浏览器远程连接（无状态、没账号不知道连哪台，第三轮）；Bot 搬家（第二轮）；命令行远程控制别的设备（`--host`，第三轮）；按同事分权限（第二轮：能连上的都当主人本人）；新增 Skill；Linux 桌面端；设置回执卡和［撤销］（`product.md` 3.7 写了、代码没有，owner 2026-10-31 同意推迟）；Windows 桌面端注册 `vonvon` 和登录自启；Mac、Windows 上用命令行只装服务端，以及为它设计的 Windows 计划任务和监督进程（owner 2026-11-01）。账号和中继要留好位置，以后加进来只是多一种连接方式（4.8）。

**审查后砍掉的（需求没要，第 17 节 SCOPE-1）：** 配对链接的二维码（本期客户端只有桌面端，粘贴就够）；对非当前设备的后台"关注点"连接（owner 选的是一次看一台）；扫码任务的"接管"（`force`、`attachJob`）；`remote.hostnames`（`.ts.net` 后缀，没有入口能配）；和设备无关的两处 UI 修复（行 E、`MigrationBanner` 文案）另开小 PR，不进这一批。

## 2. 已定的事

| 事 | 定法 | 出处 |
|---|---|---|
| 服务端在哪 | Mac、Windows、Linux 上都有服务端，每台都叫"设备"，不叫"服务器"。Mac、Windows 的服务端是桌面端自带的，Linux 的是脚本装的（2026-11-01） | 第四轮、owner 2026-11-01 |
| 装什么 | 脚本只在 Linux 上，只装服务端 + 命令行 + 后台服务；Mac、Windows 只用安装包装全部软件（桌面端自带服务端），没有只装服务端的场景，也不用命令行装；桌面端装了就默认连本机服务端，没有"只当客户端"的电脑 | 目标、第四轮、owner 2026-11-01 |
| 谁来管 | 别的设备上的桌面端连过来管；不是 SSH，不是远程执行命令 | 目标、第三轮 |
| 网络 | 文案建议 Tailscale 等安全网络，不默认直连、不暗示暴露端口，不强制 Tailscale；有 Tailscale 就识别、给提示 | 第三、四轮 |
| 第一次连接 | Orca 式连接链接，每台客户端一条，可单独撤销；装完不打印链接，靠官网一篇说明 | 第三、四轮 |
| 谁能连 | 能连上的都是主人本人；每台客户端单独授权、单独踢掉；同事权限以后加 | 第二轮 |
| 多台设备 | 切换，一次看一台（Orca "Active Server"） | 第三轮 |
| 本机优先 | 桌面端默认连本机服务端 | 第二、四轮 |
| 命令行的用户 | 主要是 Skill 和 AI；功能必须全；全部可不交互、`--json`、明确退出码 | 命令行 |
| 范围参数 | 命令行带一个限制可改范围的参数；会话里的 Skill 一定带（群会话带本群，私聊带本 bot）；服务端把会话标记绑到 Bot/群，上限按会话算，缺了或更大一律拒绝，只能缩小 | 命令行（owner 要求 + Claude 补充已告知）、设计后 owner 回答 |
| 在哪能改设置 | 三层（第 5 节开头的表）：**群会话不改任何设置**（2026-11-02 起也不读设置，第 20 节），经进程内工具、经 `vonvon` 命令行都一样；群里能做的是本群定时任务（3.13）、记忆（只有主人/管理员亲手打的话进 Bot 记忆）、本群和本群成员的只读查询、lark-cli 的飞书操作；**私聊会话**只在主人或管理员触发的那一轮能改本 bot 和它所有群的设置，加管理员只有主人那一轮，"聊天改设置"开关照旧；**vonvon 会话以外**（主人的终端、别的 Agent、在那里调命令行的 Skill）全部能改 | 设计后 owner 回答（2026-10-31，第 14 节） |
| 会话里的命令行 | 和进程内工具同一套规则（同一张表、同一组授权函数），堵上今天"群会话在 shell 里 `vonvon settings set` 以主人身份连上"的洞（5.3） | 设计后 owner 回答 |
| 3.7 照旧 | 设置 skill 只装私聊（2026-11-02：这一批不发设置 skill，私聊会话以后做，第 20 节）；Bot 记忆只收主人/管理员亲手打的话；谁触发的这一轮由 daemon 核对——经命令行也一样（5.3）。3.7 写的设置回执卡和［撤销］今天没做（只有记忆能撤销），**推迟，不进这一批**；这一批 bot 在回复里说清改前 → 改后（第 9 节） | 命令行、设计后 owner 回答 |
| 完全访问的群 | 默认不变（bot 自己建的群是完全访问）；凡是给群选完全访问的地方加一句警示（第 15 节），残留风险照实写（5.3、第 16 节） | 设计后 owner 回答 |
| 升级 | 任何连着的客户端都能升级服务端；命令行也能；默认不自动升级；升级前等现有 drain。**桌面端自带的服务端（bundled）也能远程升级**：daemon 请那台的桌面端外壳跑它自己的更新，桌面端没开就明说要开着（6.5、7.5、U4） | 升级、设计后 owner 回答 |
| 版本号 | macOS、Windows 安装包和服务端包（Linux）同一个版本 0.9.0 | 设计后 owner 回答 |
| Mac/Windows 当被连的设备 | 要有用户登录着（可以锁屏），本期接受；文档写明（7.4、第 10 节）。Mac 靠桌面端的登录项（LaunchAgent，今天就有）；Windows 桌面端这一批不做登录自启，Vonvon Bot 开着时才在线 | 设计后 owner 回答、owner 2026-11-01 |
| 端口 | 远程监听默认 7767（Paseo 默认 6767，Orca 移动端直连默认 6768，vonvon 本机端口随机，不冲突）；撞了 `vonvon remote port <n>` 改 | 设计后 owner 回答 |
| 版本对不上 | 连接时提示 | 升级 |
| 安装包 | 服务端包只有 `linux-x64`、`linux-arm64`（glibc），和 Mac/Windows 安装包同一个 CDN；自带 Node；不发源码（压缩混淆、无 source map、无 TS、无 .d.ts）；三平台一起换，桌面端自带的服务端也一样 | 安装与共存、owner 2026-11-01 |
| 共存 | 不再有：Linux 没有桌面端，Mac、Windows 没有脚本装的服务端（owner 2026-11-01）。Linux 上脚本照旧先查"已装过"（daemon 在跑、服务已注册、装过服务端），命中就跳过；在 macOS 上脚本只打印去下载桌面端安装包的话、退出非零，什么都不动。原来"脚本先装、再装桌面端"那一套作废 | 安装与共存、第五轮、owner 2026-11-01 |
| Provider | 服务器上的 Codex / Claude 用户自己装、自己配；托管安装远程也能用（装在那台设备上）；选目录选的是那台设备的目录 | 第二轮 |
| 不说"登录" | 文案按"在 <设备> 上把 Codex 配置好（账号或自定义 API 都行）"；"能用"的判断和现有检查一致 | 第五轮 |
| 验收资源 | JP-VPS 当 Linux 服务端；Mac mini 当远程客户端；Windows 机器的任务 Claude 写好、owner 转发（2026-11-01 起只剩 Windows 桌面端当设备、被远程升级的验收） | 验收与资源 |
| 说明文档 | 官网 vonvon-site 一篇"远程连接 / 多设备" | 第四、五轮 |

## 3. 架构

```
一台"设备" = 数据目录 ~/.vonvon-bot 上的 daemon（+ vonvon 命令行，+ 可选的桌面端外壳）

  ┌─ 设备 A（Mac，有桌面端）─────────────────┐       ┌─ 设备 B（Linux，脚本装的）────────────┐
  │ 桌面端 ──本机 ws + local-credential──► daemon │       │ daemon（systemd 用户服务）            │
  │ vonvon CLI ─同上─────────────────────► │  A  │       │   loopback 监听：永远开着（CLI、本机）  │
  │ bot 会话 ─本机 ws + 会话令牌（受限）──► │     │       │   远程监听：只在用户开的地址上（100.x） │
  │                                        └──┬──┘       │   clients.json：已配对客户端的公钥   │
  │ 桌面端"设备"列表：这台电脑 ● / JP 服务器 ○ │          │   device.json：设备 id + 静态密钥对     │
  │   切到"JP 服务器" ──Tailscale/局域网───────┼──────────► 加密通道（4.4）──► 同一套 RPC/事件  │
  └────────────────────────────────────────────┘          └────────────────────────────────────────┘
                                             （以后）中继 / 账号：只是客户端到达 daemon 的另一条路，
                                              加密通道和 RPC 不变（4.8）
```

- **一套协议**：本机和远程走同一套 zod RPC 和事件（`docs/architecture.md`"本机和远程走同一套协议"）。远程只多两层：传输（直连，以后中继）和加密通道。RPC 处理器不知道对面是本机还是远程，只看 `peer.principal`（第 5 节）。
- **daemon 是唯一写入者**不变；客户端不碰对面的文件系统，目录、安装、日志全经 RPC（`docs/architecture.md`"目录选择交给 daemon"）。本机 CLI 也一样：daemon 在跑时 `pair`、`clients`、`remote`、`device` 走 loopback 的 `device.*` RPC，只有 daemon 没跑时才在数据租约下直接写文件（8.3）。
- **桌面端只是外壳**：它既是本机 daemon 的外壳，也是别的设备的客户端。连着别的设备时，外壳里"管本机"的那些事（启动本机 daemon、登录项、改 PATH、退出时停 daemon）一律不作用在对面（6.4）。
- **命令行永远只连本机**（第三轮）。远程管理只走客户端 UI。
- **一条连接是本机还是远程，只看它是从哪个 `http.Server` 进来的**（loopback 监听 → 本机规则；远程监听 → 通道规则），不看 Host、remoteAddress 或首帧形状。远程监听上一律不接受 `credential` 和 `session`。

## 4. 设备身份与连接

### 4.1 设备身份

- 每个数据目录一份 `device.json`（0600，首次启动生成，和 `machine-id` 同一个 `persistentValue` 做法，`D/server/local-credential.ts:6-11`）：`{ v: 1, deviceId, name, keypair: { publicKey, secretKey } }`。`deviceId` 直接复用现有 `machine-id`（UUID）；密钥对是 X25519（Node `crypto.generateKeyPairSync('x25519')`，4.4），用于通道。`name` 默认主机名，用户可改（`vonvon device rename`、桌面端"这台设备的名字"）。
- **`device.json`、`clients.json`、`remote.json` 都加进 `ROOT_SECRETS`**（`D/config/read-scope.ts:6` 今天是写死的五个文件名，新文件不会自动进只读、读写档的读拒绝名单；Codex 一侧的读档同样核对）。`read-scope` 加一条测试：数据目录根上凡是 0600 的文件都必须在拒绝名单里，免得以后再漏。D1 验收加：读写档会话里 `cat ~/.vonvon-bot/device.json` 被拒。
- **`local-credential` 每次 daemon 启动都换**（今天 `persistentValue` 生成一次永不轮换，`local-credential.ts:13`）。原因见 4.4"loopback"。`vonvon open --print` 的链接随之只在当前这次运行有效，和 3.10"删掉 local-credential 再 start 就换了"一致。
- `serverInfo` 现在只回 `machineId, version, protocolVersion`（`P/handshake.ts:13-16`），客户端拿到就丢（`CL/transport-browser.ts:46`）。改成 `connect()` 返回 `serverInfo`，并在 v2 形状里加 `deviceName`、`platform`、`capabilities`（4.5）。客户端的设备列表以 `deviceId` 为键，地址只是到达它的路，同一台设备可以记几条地址（Paseo 的"一台主机多条连接"做法，`paseo-remote.md` §6）。

### 4.2 监听模型

- **loopback 永远开着**，端口和今天一样（随机或服务里钉死的，`D/server/http.ts:206,211`），`daemon.pid` 的 `listen` 字段不变。所有 `^127\.0\.0\.1:` 的检查（`vonvon-remote-readiness.md` 第 2 节列了 14 处）照旧，不动。
- **远程监听**是**另外一个** `http.Server`（`D/server/remote-listeners.ts`），只绑用户明确开启的**那一个**地址（A1，owner 2026-11-02：只开一个；再开一个就换掉原来的，原来的马上停止监听、连接 4006），端口固定（`remote.port`，默认 7767，写进配对链接，所以不能随机；撞端口用 `vonvon remote port <n>` 改，改完要重新生成连接链接）。owner 2026-10-31 问过会不会和 Paseo、Orca 冲突：Paseo 默认 6767，Orca 移动端直连默认 6768（stablyai/orca `mobile/src/transport/host-endpoint.ts`），vonvon 的 loopback 端口随机，都不冲突；owner 确认用 7767。配置在 `<dataRoot>/remote.json`：`{ v: 1, port, addresses: [{ host, enabledAt, kind, iface?, network? }] }`（A1 起 `addresses` 最多一项，保留数组形状；A1 之前写的多项读成最后开的那一项）。开启、关闭都在运行中生效（起、停一个 server），不要求重启。
  - 远程 server **用自己的请求处理器**，只有 `GET /health`（回 `{ ok: true, protocolVersion }`，不回设备 id、版本、名字）和 WS 升级；不复用 `serveWebUi`（今天 `http.ts:136-143` 的处理器就是它），不提供静态页面。
  - **生命周期**（LISTEN-1）：`beginDrain` 时停止绑定重试、停止接受新连接（2026-11-02 D3 审查后改：排空时远程监听继续开，和本机一样接新连接、只答排空白名单，见 4.7；只停绑定重试和地址巡检）；`release` 时关掉所有远程 server 并等它们关完（今天 `release()` 只关 `acquiredServer`，`http.ts:97-114`）。`createSocketServer`（`ws.ts:22`）改成支持多个 server，每个 server 带自己的 Host/Origin/身份规则。测试：有待执行的重试时排空，进程能退出（systemd 的 `TimeoutStopSec=infinity` 会把退不掉的进程一直挂着）。
- **地址分类**（照 Orca，`orca-tailscale-relay.md` §A、第四轮）：`loopback`（127/8、::1）、`tailscale`、`overlay`（组网，A1：Tailscale 以外的组网工具的虚拟网卡上的私有地址，以及网卡名认得出工具的 100.64/10 地址；按网卡名认，认不出就按下面的段分）、`lan`（10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10）、`cgnat`（100.64.0.0/10 但不在 Tailscale 或认得出的组网工具网卡上，见下）、`public`（其余）。只接受**字面 IP**，不接受主机名（Orca 的理由：DNS 决定绑到哪块网卡）。`public` 和 `cgnat` 要显式确认：CLI `--allow-public`，桌面端一个带风险说明的确认框（第 15 节）。`0.0.0.0`/`::` 按 `public` 处理（2026-11-02 D3 审查后改：本期开启时直接拒绝，链路本地 IPv6 `fe80::/10` 也拒，见 D3 计划第 11 节第 16 条）。
- **Tailscale 识别**（SEC-8：100.64/10 也是运营商 CGNAT 段，大陆 PPPoE 拨号、云厂商内网都会拿到，只按段认会把 daemon 绑到运营商广域网上）：一个地址算 `tailscale`，要么 `fd7a:115c:a1e0::/48`（只看段），要么是 100.64/10 **且**满足其一：`tailscale ip -4` 输出里有它（macOS 的 `utun*`、Windows 以它为准）；或在名字不区分大小写以 `tailscale` 开头的网卡上（Linux 的 `tailscale0`、Windows 的 `Tailscale`；D3 计划 4.3，2026-11-01 按 U3 计划改）。列候选地址（`vonvon remote candidates`、`vonvon remote enable` 在终端里的选择列表、桌面端的地址列表）都用同一个 `D/remote/tailscale.ts` 认 Tailscale 地址、标"推荐"（A1 去掉了 `--tailscale` 和"用 Tailscale 地址"按钮，不绑死 Tailscale）：先调 `tailscale ip -4`（5 秒超时，命令不存在就算没装），再在网卡里核对；没有 `tailscale` 命令就只认 `tailscale0` 网卡上的 100.x。都不满足的 100.64/10 归 `cgnat`。不做 Tailscale 身份（whois）校验，不做 `tailscale serve`。
- **地址还没出现**（开机时 tailscaled 还没登录）：绑定失败不算错，daemon 每 15 秒重试，状态里写"等待地址 100.x.y.z 出现"；地址消失（`EADDRNOTAVAIL`）同样回到等待。桌面端和 `vonvon remote status` 都能看到。
- **`lan` 地址换了网络不自动重绑**（SEC-8 场景 2：笔记本在咖啡馆拿到和家里一样的 192.168.1.23）：开启 `lan` 地址时记下网卡名和网络标识（默认网关的 MAC；拿不到就只记网卡名，各平台能否拿到 MAC 未核实），重试绑定前核对，不一致进入"需要确认"状态，桌面端和 `remote status` 显示"网络变了，确认后再开"。`tailscale` 地址不做这项检查（地址由 tailnet 分配，不随物理网络变）。`overlay` 地址不比网卡名和网关，只看它还在不在组网工具的网卡上（macOS 的 utun、feth 编号重启后会变，比名字会每次都误报"网络变了"）；跑到普通网卡上（别的网络分到了同一个地址）才进"需要确认"（A1）。
- **Host / Origin / DNS 重绑**：loopback 监听照旧（Host 必须 loopback，Origin 没有或 loopback，`D/server/ws.ts:13-20,31`）。远程监听：Host 必须等于某个已开启的地址（`ip[:port]`，IPv6 带方括号），否则 403；**Origin 必须不存在**，有 Origin 一律 403，因为本期浏览器不远程连。这就把跨站 WebSocket 劫持和 DNS 重绑整个挡在门外。
- 连不上时客户端按对方地址的分类给提示：`tailscale` 给 `tailscale ping` 和"两台都登录同一个 tailnet"；`overlay` 给"两台都在同一个组网里"和 `ping`；`lan` 给"在同一个局域网"；`public` 给"确认防火墙放行 7767"。文案见第 15 节。

### 4.3 配对链接、邀请和授权

- **链接格式**：`vonvon://pair#<base64url(JSON)>`，JSON：

```ts
{ v: 1,
  device: { id: string /* deviceId */, name: string, pk: string /* X25519 公钥 base64url */ },
  addresses: Array<{ host: string; port: number; kind: 'tailscale' | 'overlay' | 'lan' | 'cgnat' | 'public' }>,  // 生成时已开启的远程地址（A1 起只有一条，保留数组）
  invite: { id: string, secret: string /* 32 字节 base64url */, expiresAt: number /* epoch ms */ },
  relay: null,    // 预留：以后 { endpoint, hostId, inviteToken }
  account: null } // 预留：以后 { accountId }
```

  放在 `#` 后面是习惯（Paseo、Orca 都把密文材料放片段里），也允许直接粘 base64url 部分。**输出规矩**（REQ-2，推翻第 1 版"只在 TTY 打印"）：`vonvon pair` 的人类输出和 `--json` 输出都把链接写到 stdout，不管 stdout 是不是终端——命令行的主要用户是 Skill 和 AI，用户让服务器上的 Claude Code 跑 `vonvon pair --json` 就是明确要取凭据。不进 daemon 日志、服务管理器日志和诊断事件。人类输出保留"别发给别人"的提示；官网文档写明"链接会进你的 Agent 的对话记录，用完就作废"。不渲染二维码。
- **邀请**：一次性，10 分钟过期（Orca 的 inviteToken 上限；owner 2026-10-31 确认），同时最多 3 个未用的，**只存在 daemon 内存里**（所以 `pair` 要求 daemon 在跑，没跑 exit 3 并说明）；`vonvon pair [--ttl 10m] [--json]`，RPC `device.pair`。没开任何远程地址时 `pair` 拒绝并说明先 `remote enable`。
- **配对握手**：客户端拿链接，**为这台设备生成一对新的 X25519 密钥**（每台设备一对，不共用，SEC-12：一台客户端电脑被攻破时能逐台撤销、逐台定位），按 4.4 建通道（服务端公钥来自链接，钉死）。通道建立后服务端查客户端静态公钥：
  - 在 `clients.json` 里 → 主体 `owner(paired)`，正常。
  - 不在 → 主体 **`unpaired`**（SEC-6）：不回 `serverInfo`，不进维护子集，只接受一帧 `pairRequest { inviteId, inviteSecret, clientName, clientKind }`，5 秒内没收到或校验失败就关（4002 `unknown_client` / 4007 `pairing_failed`）。服务端只登记**通道里认证过的**客户端静态公钥，`pairRequest` 里不再带 `clientPk`。核对 invite 用常量时间比较、作废它、写 `clients.json`、回 `pairResult { clientId, deviceName }`，连接随即升为 `owner(paired)` 并补发 `serverInfo`。
  - 之后每次连接都是 4.4 的双向认证，没有令牌可泄露。
- **授权存储** `<dataRoot>/clients.json`（0600）：`{ v: 1, generation: number, clients: [{ id: 'cl_…', name, publicKey, clientKind, createdAt, lastSeenAt, lastAddress, pairedVia: 'invite', invitedBy: 'local' | <clientId>, revokedAt?: number }] }`。`invitedBy` 记这条邀请是本机 CLI/桌面端发的还是某个已配对客户端经 RPC 发的（SEC-11 场景 2：笔记本被偷后拿它配进来的客户端能一起撤）。撤销不删条目，写 `revokedAt`（墓碑），这样被撤销的客户端重连时能收到 4003 `client_revoked` 和对应文案，而不是和"从没配过"一样的 4002（CONTRACT-1）。`vonvon clients ls|rename|revoke [--cascade]`，RPC `device.clients|renameClient|revokeClient`。**授权不过期，只能手动撤销**（Paseo、Orca 都这样；owner 2026-10-31 确认）；丢了的电脑靠"最近 24 小时新配对"的提示和 `invitedBy` 级联撤销兜底。
- **撤销立即生效、没有竞态**（SEC-16）：每次写 `clients.json` 都让 `generation` +1；每条连接记下认证时的 `generation`，连接登记后、处理每条 RPC 之前都核对一次这个客户端仍在授权里且未撤销（内存里的 Map 查一次，不读文件）。撤销时：改文件 → 关闭该客户端的所有活连接（4003）→ 取消它发起、还没结束的任务和日志订阅（`jobs.detach`、`logs.detach`）。
- **配对成功要让主人知道**（SEC-11）：诊断事件 `client-paired { clientId, name, kind, address, invitedBy }`；桌面端（被连的那一侧）弹一条"新设备「X」已配对，来自 <地址>。不是你就到「设备」撤销"；`clients ls` 把最近 24 小时配对的标出来。链接已被用掉时的文案专门写（第 15 节）：客户端此时还没配上、看不到对面的列表，所以指到那台设备的「允许别的设备连接」或 `vonvon clients ls` 去看最近配对的客户端（2026-11-01 U1b）。不经 bot 私聊通知（本期不加新的 bot 消息类型）。
- **频率限制**（SEC-7：限流要在做任何 DH 之前，否则第一条握手消息就能把事件循环打满）：
  - 未认证连接数：每个来源 IP 最多 4 条、全局最多 32 条，超了直接关（4004），不读帧。
  - 每个 IP 一个令牌桶：每分钟 20 次握手开始；`handshake_failed`、`unknown_client`、`pairing_failed` 都计数；**带有效 `inviteId`（存在且未过期）的配对握手不计未知公钥**，免得用户自己重试几次把自己封了。超了封 60 秒。
  - 公网/cgnat 地址再加全局每秒 10 次握手的上限。
  - 未认证阶段 `maxPayload` 降到 4 KB（今天 4 MB，`ws.ts:22`），握手超时 3 秒（今天 5 秒，`ws.ts:56`）。
  - 封禁只在内存里，重启清零。
- **面板要用的三个字段**（U3 计划，2026-11-01）：`device.status` 加 `remote.candidates[{ host, kind, iface?, tool? }]`（这台设备此刻能开的地址，已开的也在里面；daemon 缓存 30 秒，请求带 `refresh: true` 时重列，U3 实现时加，给面板的刷新按钮）和 `via`（调用者连进来的那个监听地址，本机连接没有）；`device.clients` 的回复加 `self`（调用者自己的 `clientId`，本机连接没有）。都是可选字段。D3 的 `tailscale ip` 在 macOS、Windows 上找不到命令时，再试 Tailscale 应用自带的命令（Mac 的应用默认不把命令放进 PATH），由 U3 补。

### 4.4 传输安全：加一层应用层加密，远程一律走它

**决定：远程连接在 WebSocket 之上加一层端到端加密通道，本机 loopback 连接不加，照旧用 `local-credential`（但每次启动轮换，见下）。**

为什么加（Paseo 直连不加密、只建议 Tailscale；Orca 用 NaCl box）：
1. owner 要的是"安全参考 Paseo、Orca"，又不强制 Tailscale。大陆用户 Tailscale 延迟高（目标一节），现实里会有人走局域网甚至公网直连。协议里跑的是 App Secret（`profileAdd`）、决策模型 key（`admin.setSecret`，`D/server/rpc/admin.ts:89-90`）和会话内容，明文 ws 一截就有。
2. `docs/architecture.md`"远程访问端到端加密"已经定了远程端到端加密；本文只是把它从"连云端"提前到"直连"。以后加中继，中继看到的就只有密文，和 Paseo 一样，不用重做（4.8）。
3. 通道自带设备身份钉死（服务端公钥在配对链接里）和客户端身份（配对时登记的公钥），所以**授权就是公钥**，没有 bearer token 可被复制、可在 URL 里泄露；撤销一台不影响别的，这是 Paseo 做不到的（`paseo-remote.md`"Avoid 1"）。
4. TLS 不选：浏览器本期不远程连，TLS 唯一的好处用不上；自签证书在 Node 客户端里钉 SPKI 可以做，但要维护证书轮换，而且挡不住"换了设备公钥"这种身份问题。

怎么做（`P/secure-channel.ts`，daemon、client 共用）。第 1 版打算用 tweetnacl 手搭 Noise XX，审查指出它对不上任何标准套件、没有 AD、没有版本绑定、官方向量测不了（SEC-5），而且仓库今天根本没有 tweetnacl 依赖。改成**标准 Noise，全部用 Node / Electron 自带的 `node:crypto`，不加依赖**：
- 套件 **`Noise_IK_25519_AESGCM_SHA256`**（配对握手和已配对连接都用 IK）：X25519 用 `crypto.diffieHellman`，AEAD 用 `aes-256-gcm` 带 AAD（`h` 作 AD，按 Noise 的 `EncryptAndHash`），HKDF 用 `crypto.hkdfSync`，哈希 SHA-256。AES-GCM 在 Electron 44 的 BoringSSL 下可用；ChaChaPoly 未核实，所以不选。
- 选 IK 不选 XX：客户端已经从链接拿到服务端静态公钥；IK 少一个往返（大陆高延迟链路有用）；服务端静态公钥**不会**发给任何发起握手的人（XX 的第二条消息会，公网扫描器能凭它跨 IP 追踪设备，和 4.2"/health 不回身份"的意图矛盾）；服务端在第一条消息里就知道客户端是谁，未知公钥按 4.3 进 `unpaired`。
- **prologue** = `"vonvon-secure-channel/1"`，第一条消息前缀 1 字节版本号 `0x01`，版本和 prologue 都绑进转录哈希，以后出 `/2` 不能被降级。拒绝低阶点：DH 结果全零即 `handshake_failed`。
- **帧**：`[8 字节计数器][AES-GCM 密文+tag]`，nonce = 4 字节零 + 8 字节计数器，计数器严格递增，重放、乱序直接关 socket（1008）。这补上 Paseo 随机 nonce 没有的会话内防重放（`paseo-remote.md` §3 弱点）。
- **测试**：Noise 官方向量（snow / cacophony 的 `Noise_IK_25519_AESGCM_SHA256` 条目）直接跑，再加"坏实现互测"（篡改 `h`、换 prologue、重放帧）。
- **认证**：客户端把服务端静态公钥和链接里 `device.pk` 比较，不同即 `device_identity_changed`，不是 TOFU、不自动接受（技术决定：重装服务端后每台客户端要重配一次）；服务端按 4.3 处理客户端公钥。前向保密靠临时密钥（ee）。
- 通道之上才是今天的 `hello` / `serverInfo` / RPC 帧，一个字节不改；**握手没完成前不处理任何 RPC**。
- **loopback 不走通道，但第 1 版"同机 OS 权限已经保护住 local-credential"这句不成立**（SEC-4）：loopback 端口全机所有 OS 用户共用；本机客户端一连上就发明文凭据（`owner-verification.ts:37`、`transport-local.ts:31`），之后才核 pid；daemon 重启的空档里（`release()` 先关监听、pid 锁还在）同机别的账号可以抢占端口收凭据。团队共用的多用户 Linux 正是本期要支持的用法。做法：**`local-credential` 每次启动轮换**（4.1，Paseo 就是这样）——空档里截到的是旧凭据，新 daemon 不认；抢占导致新 daemon 绑不上端口时它直接失败退出（服务管理器 5 秒后重试），凭据不会落到抢占者手里。Unix socket / 命名管道和挑战应答留到以后（要改 14 处 `127.0.0.1:` 检查和桌面端 attach），写进第 16 节风险。
- 这段代码单独一片（D2），实现者写完先跑官方向量，再由另一个模型做一轮多角度审查（`AGENTS.md`：涉及并发、错误路径的加一轮）。

### 4.5 握手（hello 兼容 v1，新内容放握手后）

第 1 版把 `PROTOCOL_VERSION` 升到 2 并给 `hello`/`serverInfo` 加字段，审查指出这会让每个从 0.8 升 0.9 的 Mac 桌面用户卡住（PROTO-1，blocker）：今天两个 schema 都是 `.strict()`（`P/handshake.ts:7-16`），v1 服务端收到多字段的 hello 直接 4401（`ws.ts:72-76`），v1 客户端解析多字段的 serverInfo 报 zod 错；而 macOS 桌面端更新时不停 daemon（`DT/main.ts:230-240` 只在 win32 停），新桌面端起来要用 `vonvon daemon stop` 停旧 daemon，`owner-verification.ts:44-46` 要求版本相等，必失败，然后 `daemon-dependencies.ts:79-82`、`daemon-manager.ts:70-72` 抛致命错误。所以：

- **`hello` 形状不变**：`{ type, protocolVersion, clientKind, credential? }`。客户端填 `protocolVersion: 2`。bot 会话令牌放在 `credential` 字段里（形状 `vs1.…`，5.3），v2 服务端按前缀认出来；v1 服务端把它当凭据比较、回 4401，CLI 据此报"这台 daemon 太旧"（exit 3）——正确。
- **服务端按 hello 的 `protocolVersion` 选 serverInfo 形状**：v1 → 今天的三个字段；≥2 → 加 `deviceName`、`platform`、`capabilities: string[]`、`principal`。客户端一律**非严格**解析 serverInfo，枚举按开放字符串。
- **客户端能力声明和范围**放在握手后的第一条请求 `admin.negotiate { capabilities: string[], scope?: Scope }`（新 kind；bot-session 主体在它之前只能发 `admin.daemonStatus`，别的请求回 `scope_required`）。
- **版本不再要求相等**：`PROTOCOL_VERSION = 2`。服务端回 serverInfo 后：版本相同 → 正常；不同 → 连接进入**维护子集**，只接受 `admin.daemonStatus`、`machine.checkCoreUpdate`、`machine.applyCoreUpdate`、`machine.coreUpdateStatus`、`command.restartHost`（第 1 版写成 `machine.restartHost`，协议里它在 `command`，`P/domain.ts:77`），这几个的请求和回复形状从 v2 起冻结：**回复里的枚举客户端按开放字符串解析**（strict 对象 + 封闭 enum 下"只加可选字段"不成立，PROTO-1 第 3 点），`daemonStatus` 加 `startedAt`（4.7、6.4 要比较它，今天 schema 里没有）。别的请求回 `protocol_mismatch { serverProtocol, clientProtocol, serverVersion, clientVersion }`。维护子集的连接不推 `snapshot` 事件。
- **`owner-verification` 的 verify 和 stop 不再要求版本相等**：宽松解析 serverInfo，`daemonStatus` 只取 `pid`，然后 `stopHost`——新桌面端和 CLI 能停掉旧 daemon，旧的也能停新的。`daemon-manager.ts:70-72`、`daemon-dependencies.ts:79-82` 的硬检查改成：本机是 `bundled` 且协议不同 → 照今天走启动修复（换成自己带的）。原来还有一条"本机 daemon 是 `standalone` 且协议不同 → 不报致命错误，按维护子集连上，显示升级条"（REQ-10），2026-11-01 起不做：桌面端只在 Mac、Windows 上，那里没有 `standalone`（第 19 节）。本机协议不同时桌面端怎么说（npm 版旧、其他旧、服务端新三种），以及 Windows 也做启动修复，见 U2 计划 4.8。
- 对面是今天的 v1 服务端（serverInfo 没有 `capabilities`，`protocolVersion: 1`）：客户端显示"那台设备的 Vonvon 太旧（x.y.z），要在它上面升级一次"，不提供按钮。
- `capabilities` 是功能开关的唯一来源，客户端不按版本号猜。
- 回归测试（D1）：0.8 的 bundled daemon 在跑时起 0.9 桌面端，能停掉旧的并换上新的；0.9 CLI 对 0.8 daemon 的 `daemon stop` 成功。

### 4.6 版本提示

客户端连上后比较 `serverInfo.version` 和自己的版本：服务端旧 → 顶部一条"<设备> 的服务端是 x，这台电脑是 y，升级服务端"按钮（走 7.5；对面是 `bundled` 时同样是按钮，由那台的桌面端外壳更新，那台桌面端没开时按钮旁写明要开着，6.5）；客户端旧 → "这台电脑的 Vonvon Bot 需要更新"（指向桌面端自己的更新）；**协议不同**才只保留设备列表和升级面板；只是版本号不同、协议相同，提示不拦（OWNER-1：第 1 版第 14 节第 8 条和这里矛盾，以这里为准）。

### 4.7 保活、重连和关闭码

- **保活**：远程通道上客户端每 20 秒发一帧 `ping`（通道内的控制帧，不进 RPC），30 秒没回算断；服务端 60 秒没收到任何帧关 socket（1001）。loopback 不加保活，今天也没有。
- **重连**：客户端按 `min(30s, 1s × 2^n)` 退避重连当前设备（非当前设备没有连接，SCOPE-1）。重连成功后比较 `serverInfo.machineId`、`daemonStatus.pid/startedAt`，变了就按"重启过"处理（6.4 最后一行）。
- **关闭码**（服务端主动关时带上，客户端据此给文案）：`4001 protocol_mismatch`（维护子集外的请求太多，服务端关掉），`4002 unknown_client`（公钥不在 `clients.json`，也没有在 5 秒内带有效邀请配对），`4003 client_revoked`（墓碑命中），`4004 rate_limited`，`4005 handshake_failed`（通道校验失败），`4006 remote_disabled`（地址被关闭，所有该监听上的连接一起关），`4007 pairing_failed`（邀请无效、过期、已用）。今天的 `1001 server_shutdown`、`1008` 不变。4.3、4.7、第 15 节用同一张表。
- **drain 期间**：服务端排空时远程连接和本机一样只收 `machine.stopHost`、`admin.daemonStatus`、**`machine.coreUpdateStatus`**（DRAIN-1：升级时 `vonvon update` 和界面都在轮询它，今天排空一开始就 `closePeers`、白名单只有前两个，`ws.ts:84-92,138-148`，进度就看不见了），其余回 `draining`。`http.ts` 的 `control()` 同步加这一条；4.5 的维护子集和这里的排空白名单写成同一个常量 `MAINTENANCE_KINDS`。（2026-11-02 D3 复查 248 后改：白名单是 `P/handshake.ts` 的 `DRAIN_KINDS`，和维护子集分成两个常量，另加两条：**`snapshot.get`** 回最后一次建好的快照、`stale: true`，不重建、不问正在停的 Bot 进程，权限照表、Bot 会话照样裁到自己那部分；**`admin.negotiate`** 只记在这条连接上，会话和带 `--scope` 的命令行要先发它才能读快照。原因：排空一开始已有连接照旧 1001 关掉，客户端重连后头一个请求就是快照（`watchSnapshots` 自带一次，桌面 bridge 再要一次），快照不在白名单时又被 1001 关掉，桌面端一直"连上 → 要快照 → 断开 → 重连"，看不到升级进度。白名单外的请求回错误码 `draining`（"daemon 正在停止或重启（比如在升级），这个请求没有处理。等它重新启动后再试。"），**连接不关**；读不懂的请求只要带 id 也回 `draining`，没有 id 可回的帧才 1001 关；协议不同的连接问它本来就不能问的，照 4.5 回 `protocol_mismatch`、连续 20 条 4001 关。命令行把 `draining` 当连接类错误（exit 3），`daemon restart` 照旧报"正在停止或重启"。`release` 时所有连接 1001 关。本机和远程同一套，在共用的 `message-loop.ts` 和 `control()` 里。）

### 4.8 以后的中继和账号怎么接

- 客户端里到达一台设备的路叫 `DeviceRoute = { kind: 'direct', host, port } | { kind: 'relay', … }`（第二种本期只有类型）。通道（4.4）跑在任何一条路上，`hello` 以上不变。中继只是多实现一个 `connectRoute(route)`。
- 配对链接的 `relay`、`account` 两个槽本期恒为 `null`，`v` 不变就能加。`clients.json` 的条目以后加 `accountId?`，账号下的设备自动出现在客户端列表（`source: 'account'`）而不是手动粘链接；撤销和列表逻辑不变。
- `device.json` 的密钥对以后登记到账号，就是 `docs/architecture.md`"远程访问端到端加密"里说的那一步，不用换密钥。

## 5. 授权模型

owner 2026-10-31 定的三层（第 14 节）。**会话里的 `vonvon` 命令行和进程内工具（`settings_*`、`feishu_*`、`memory_*`、`schedule_*`）同一套规则**：同一张表（5.2）、同一组授权函数（`D/agent/entry/registry.ts` 的 `authorizeNow / authorizeMemory / authorizeSchedule`），命令行能做的不比工具多。

| 在哪调 | 主体 | 能做什么 |
|---|---|---|
| vonvon Bot 会话以外：主人的终端、别的 Agent（Codex、Claude Code）、在那里调命令行的 Skill | 本机主人 `owner`（local） | 全部 |
| 别的设备上的桌面端 | 已配对客户端 `owner`（paired） | 全部（第二轮：能连上的都是主人本人） |
| 私聊会话（只有主人和管理员能私聊） | `bot-session`，令牌 `place: 'dm'` | 本 bot 和它所有群的设置，只在主人或管理员亲手触发、还在进行的那一轮（`authorizeNow`）；加、移本机管理员只在主人那一轮；"聊天改设置"开关关了一律拒；建群（3.7）；本 bot 的只读查询（也要主人或管理员那一轮，和 `settings_get` 一样）。不能：密钥、`host` 段、绑已有群和解绑、升级/停服务、配对/远程/设备命令 |
| 群会话 | `bot-session`，令牌 `place: 'group'` | **不写任何设置**。能做：本群定时任务（3.13 的规则，`authorizeSchedule`）；记忆（`authorizeMemory`，只有主人/管理员亲手打的话进 Bot 记忆，3.7）；本群成员的只读查询（`feishu_members` 和 `listGroupMembers`）；2026-11-02 起（s1b）群里改成白名单，其余查询一律拒（下面 5.2 表），`feishu_groups` 只在私聊里有；lark-cli 的飞书操作（走 lark-cli 自己的授权，不经 vonvon，本设计不管）。2026-11-02 起没有 `settings_get`、`settings_access`，命令行读设置也拒（第 20 节）。拒：任何设置读写（含权限档、会话方式、角色设定）、绑群和建群、密钥、升级/停服务、配对/远程/设备命令，命令行 exit 4。设置读写和建群（私聊里能做的）的拒绝文字复用 `not-dm` 那句，2026-11-02 改成 owner 定的"群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"（`registry.ts` 的 `NOT_DM_MESSAGE`）；绑已有群、密钥、运维和设备命令在私聊里也不能做，照 5.2、5.3 回 `permission_denied` / `not_in_session` 的文字，不叫人去私聊 |
| 云文档评论会话 | `bot-session`，令牌 `place: 'comment'` | 和进程内工具今天一样：不写设置（`authorizeNow` 回 `not-dm`），没有任务（`not-group`）和记忆，设置和群的只读查询也拿不到 |

### 5.1 主体

| 主体 | 怎么认出 | 权限 |
|---|---|---|
| 本机主人 `owner`（local） | loopback + `local-credential` 对上 | 全部 |
| 已配对客户端 `owner`（paired） | 远程通道里客户端公钥在 `clients.json` 且未撤销 | 全部（第二轮：能连上的都是主人本人），只少 `machine.desktopUpdateReport`（只收本机桌面端外壳，7.5） |
| 待配对 `unpaired` | 远程通道里客户端公钥不在 `clients.json` | 只收一帧 `pairRequest`，不回 serverInfo，5 秒关（4.3） |
| bot 会话 `bot-session` | loopback + `hello.credential` 是有效会话令牌（`vs1.`） | 受限，按令牌绑的地方分私聊、群、评论（上表、5.2、5.3） |
| 维护 `maintenance` | 任一 owner 身份但协议版本不同 | 只有维护子集（4.5） |

### 5.2 每条 RPC 一行权限表（`D/server/authz.ts`）

`dispatch`（`D/server/http.ts:159-183`）之前先过 `authorize(peer, request)`。表是一个 `Map<'method.type', Rule>`，**表里没有的一律拒绝**（`permission_denied`），新加 RPC 必须登记，测试里有一条"每个 protocol 里的 kind 都在表里"。owner 一列全放；bot-session 一列分两类：host 自己能判的（只看令牌绑的 bot、地方、群和 `--scope`），和**必须问 Bot 进程的**（标 ★）。**群令牌和评论令牌的设置写在 host 就拒**（`not-dm`，文字同 `registry.ts:48`），不问 Bot 进程：进程内 `authorizeNow` 对非私聊也是在核对这一轮之前就回 `not-dm`，结果一样，而且 Bot 进程退了也照样拒。

第 1 版写"复用 registry 的 `authorizeMemory/authorizeSchedule`"、"角色按这一轮"，但这几个函数是 Bot 子进程里的闭包（`D/agent/entry/registry.ts:159-191`），依赖这一轮的 `Grant`/`TurnAuth`（轮次在不在进行、是不是人发的、在场情况、请求者 openId、`isAdmin`、"聊天改设置"开关），host 进程拿不到（SEC-1、AUTHZ-1、REQ-6）。所以 ★ 的请求 host 不自己判：经 IPC 问所属 Bot 进程 `authorizeSessionCall(sessionId, action)`，Bot 进程按 `sessionId` 找到活着的 grant 和当前的 `TurnAuth`，跑**和进程内工具完全相同的** `authorizeNow` / `authorizeMemory` / `authorizeSchedule`，回 `ok | refused(reason)`。没有活着的一轮（轮已结束、grant 已撤）就 `turn-ended`——这也挡住"一轮里起个 `sleep 3600 && vonvon …` 后台进程"（SEC-1 攻击 3）。于是 3.7 的那几条在命令行这条路上和在工具那条路上判法一致：

| RPC（method.type） | owner | bot-session |
|---|---|---|
| `snapshot.get`、事件 `snapshot` | 全量 | 私聊令牌过滤成只含自己 bot 和它的群（`filterSnapshot`）。群令牌、评论令牌（s1b，`sessionSnapshot`）只剩自己 bot 的 id、名字和状态，本群的 id 和名字，本群项目的 id、名字和本群那条绑定（`--group <项目名>`、`memory --project` 解析用）；`memberships`、`tools`、`jobs` 为空，文件夹、数据目录、连接说明留空，不给权限档、模型、别的群和设备；评论令牌连本群也没有 |
| `command.refresh / listPendingGroups / listJoinedGroups / listGroupMembers` | ✓ | 只带自己 `agentId` 的。群令牌（s1b）：只有 `listGroupMembers`，只能查本群（同 `feishu_members`）；`refresh`、`listPendingGroups`、`listJoinedGroups` ✗；私聊令牌：★ 要这一轮是主人或管理员亲手发的（同工具的 `ctx.admin`）；评论令牌 ✗ |
| `command.registerAgent / refreshAgentCredentials / bindGroup / setAgentEnabled / deleteAgent / cancelJob / restartHost / stopHost` | ✓ | ✗（绑群、建 bot、停服务都在禁区，私聊也一样） |
| `settings.read / sessions / models` | ✓ | 群令牌：`read` ✗ `not-dm`（2026-11-02，群会话没有 `settings_get`，第 20 节；原来是只给 `project{本群}`、各段标只读），`sessions`、`models` ✗（s1b；原来只有本群）；私聊令牌：★ 主人或管理员那一轮，范围 `agent{自己}`、`project{自己的任何群}`、`session{自己}`；评论令牌 ✗ |
| `settings.save / act` | ✓ | **群令牌、评论令牌 ✗ `not-dm`**（含权限档、会话方式、角色设定，一律不写）。私聊令牌：★ 过 `authorizeNow`（私聊、这一轮活着、人发的、主人或管理员、"聊天改设置"开关开着），再按范围：`host` 段 ✗；`agent{自己}`、`project{自己的任何群}` 按 3.7 的"能改"表——权限档和网络、允许哪些群用都能改（和工具一样，REQ-6）。`act adminMember add|remove` 再要求这一轮是**主人**触发（3.7："本机管理员名单只有主人触发的那一轮能改"，`TurnAuth.facts.requesterOpenId` 等于 owner）；`projectMember`、`projectAudience` 按 `authorizeNow`（主人或管理员） |
| `collaboration.*`（含 `createProject`） | ✓ | 读类（`history / context / project / providerModels`）私聊令牌限自己，群令牌、评论令牌 ✗（s1b）；`createProject`：群令牌 ✗ `not-dm`，私聊令牌 ★ 过 `authorizeNow`（3.7：建群在私聊能改）；`editProject`（会话方式、启用、目录，3.7 能改表里的项）：群令牌 ✗ `not-dm`，私聊令牌 ★ 同 `settings.save`；`removeProject`（解绑）和别的写类（`clear / compact / stop / …`）✗——3.7 的能改表里没有解绑，和绑群一起留给桌面端和会话以外的终端 |
| `environment.*`、`machine.*`、`admin.*`（含 `secrets*`） | ✓（`machine.desktopUpdateReport` 只收本机 loopback 的桌面端外壳，已配对客户端 ✗，7.5） | 全部 ✗，只放 `admin.negotiate`，私聊令牌再放 `admin.daemonStatus`（s1b：群里的命令行读锁文件就够，回包里有路径） |
| `directory.*`、`library.*`、`contextPreview.get` | ✓ | 私聊令牌 `library.list` 过滤；群令牌、评论令牌 ✗（s1b）；其余 ✗ |
| `memory.*` | ✓ | ★ 过 `authorizeMemory`；范围只有自己 bot 和自己群的项目（群令牌只本群）；群令牌只有 `list / add / edit / archive`（s1b），`list` 和读回的条目去掉作者、最后修改人、事件号和问题清单，只列现行条目，`export`、`events` ✗；评论令牌 ✗（同工具的 `unknown-tool`）；bot 记忆的落点按这一轮的角色（`roleOf(auth)`，主人/管理员亲手打的才进 bot 记忆，3.7）——由 Bot 进程在同一次 IPC 里回 `role`，host 透传给 `memoryAction` |
| `schedule.*` | ✓ | ★ 过 `authorizeSchedule(action, taskId)`；群令牌只本群；私聊、评论令牌 ✗ `not-group`（同工具）；`ScheduleActor` 加一种 `{ kind: 'session', openId, role }`，命令核按它再查一遍（今天 RPC 一律按 `local` 跑，`D/server/rpc/schedule.ts:9-16`） |
| `device.*`（新） | ✓ | ✗ |

bot-session 的 `via`/`origin` 标成 `cli` 加会话信息（今天 memory 走 RPC 一律记 `ui`，`D/server/rpc/memory.ts:13-15`；5.3 把 `peer.principal` 透传进去，顺手修掉这个）。

验收（D4a，host 判的部分）：群令牌 `settings set`、`settings act`、`group create`、`group set` 一律 exit 4，文字是 `not-dm` 那句；群令牌 `settings get` ~~只拿到本群、各段只读~~ 2026-11-02 起 exit 4、`not-dm`（第 20 节）；群令牌 `schedule add`、`memory add` 放行到 ★。验收（D4b，Bot 进程判的部分）：私聊里成员发起的那一轮 `settings set` 被拒；开关关掉时被拒；管理员那一轮 `settings act adminMember add` 被拒、主人那一轮过；私聊主人那一轮改本 bot 另一个群的设置过；非管理员那一轮 `memory add --bot` 落到项目记忆而不是 bot 记忆；一轮结束后同一令牌调用被拒（`turn-ended`）。

### 5.3 范围参数和会话令牌

- **今天**：`VONVON_SESSION=1` 只是个标记（`D/config/session-env.ts:4-10`、`D/agent/session-profile.ts:42`），CLI 用 `inBotSession()` 自己决定拒绝什么（schedule、memory 写、secrets：`cli/index.ts:35`、`schedule.ts:154`、`memory.ts:44`、`secrets.ts:69`），daemon 不认识会话。`inBotSession()` 在只有 `FEISHU_CODEX_BRIDGE=1` 时也为真（所有 provider 子进程都带，`jsonrpc.ts:273`、`claude-agent/backend.ts:92`）。**这是个洞**：`settings`、`group`、`bot` 这些命令在会话里不拦，CLI 照常读 `local-credential` 以主人身份连上；群会话的完全访问档 agent 在 shell 里跑 `vonvon settings set`，就能改进程内 `settings_set` 会拒（`not-dm`）的设置。下面的令牌和范围把命令行拉回和工具同一套规则。
- **改成**：bot 子进程起会话时向 host 要一个令牌 `vs1.<sessionId>.<随机 32 字节 base64url>`（IPC `issueSessionToken`），host 在内存里记 `{ appId, chatId?, place: 'dm' | 'group' | 'comment', threadId?, sessionId, issuedAt }`，会话结束（`revokeSessionToken`）或 bot 进程退出就作废，24 小时没用也作废。令牌放进 `VONVON_SESSION`（`inBotSession()` 仍为真，旧判断不用改）。令牌不落盘。令牌只认"是哪条会话"，**谁触发、这一轮活不活由 Bot 进程在 ★ 请求时判**（5.2）。
- **CLI**：
  - `inBotSession(env)` 为真 → **不读、不发 `local-credential`**，`hello.credential` 只放令牌；没有像令牌的 `VONVON_SESSION`（只有 `FEISHU_CODEX_BRIDGE=1`、还是旧的 `'1'`、令牌没签成、过期）→ **一律拒绝**，exit 4 `session_token_missing`，**绝不退回主人权限**（AUTHZ-2；第 1 版"像令牌才带上"会在这几种情况下悄悄以 owner 连上）。测试覆盖这三种情况。
  - 服务端：loopback 上 `credential` 以 `vs1.` 开头就按 bot-session 处理，不再和 `local-credential` 比较；远程监听上带了 `credential` 一律关（4.4）。
  - `--scope` 全局参数（owner 要求，保留），形状 `bot=<appId>[,group=<chatId>]`，经 `admin.negotiate` 送到。**上限按会话算**，在 daemon：群会话是（自己 bot，本群），私聊会话是（自己 bot，它的所有群）。daemon 核对：缺 → 拒绝（`scope_required`，exit 4）；`bot` 不等于令牌绑的 bot → 拒绝；群令牌而 `--scope` 没写 `group` 或写了别的群 → 拒绝（比会话范围大）；私聊令牌 `--scope bot=X` 即可。**参数只能缩小**：满足上面还可以再缩（私聊令牌带 `group=` 就只能动那个群）。参数只决定范围，不放宽地方的规则：群令牌带对了 `--scope` 也照样不能写设置。没有令牌的人类终端：`--scope` 可选，给了就同样生效，方便本机验证 Skill 的行为。
  - **8.3 里"只能本地"的写类命令在会话里先由 CLI 拒绝**（SEC-2、REQ-8）：`daemon run/start/stop/restart`、`service *`、`update`、`remote *`、`pair`、`clients *`、`device rename`、`bot repair-dir`、`open`——`inBotSession()` 为真就 exit 4 `not_in_session`，写法和今天 `secrets` 一样（`cli/commands/secrets.ts:69`）。今天只有 secrets、memory、schedule 三处拒（`cli/index.ts:35`、`memory.ts:44`、`schedule.ts:154`），群里有人说"bot 卡了你重启一下"，完全访问档的 agent 就能以 owner 身份 `daemon restart`、`update`、`remote enable 0.0.0.0 --allow-public && pair`，链接还回进群里。只读的 `daemon status`、`--version` 放行；隐藏的 `secrets get` 是 lark-cli 取飞书 App Secret 的入口，会话里也放行（D4a 计划"实现时和计划不一样的地方"第 1 项，只给本 Bot 的飞书凭据、决策模型的 key 拒绝，不按群隔离；2026-11-02 Codex 复查 262 记为已知限制）（`service status` 后来也拒，`daemon status` 在会话里只回在不在跑和端口，见第 20 节）。测试：会话环境下这些命令一律 exit 4。
  - `schedule.ts:154`、`memory.ts:44` 今天的整体拒绝改成"有令牌 + `--scope` 就放行，由 daemon 判"（D4a）。
- **群会话经 CLI 能做的**和群里的工具一样：本群定时任务、记忆、本 bot/本群的只读查询；任何设置写、绑群建群、密钥、运维和设备命令都拒（第 5 节开头的表）。私聊会话能改本 bot 和它所有群的设置，3.7 的规则由 Bot 进程判（5.2 ★）。
- **诚实的边界**：完全访问档的 bot 能读这个 OS 用户的任何文件，包括 `local-credential`（当前这次运行的）、`device.json`、`clients.json`，拿到就是 owner。**所以在完全访问的群里，群成员可以诱导 bot 绕开令牌、以主人身份做事，包括改 vonvon 的设置**。令牌和范围挡的是失误和一般越权（写错范围、模型拿别的群的 id、模型照群里一句话去跑 `vonvon settings set` 或运维命令；2026-11-02 起不靠 skill 教，被拒的文字自己说清，第 20 节），挡不住被诱导去读凭据文件、自己连 daemon 的 agent。owner 2026-10-31 定：默认不变（bot 自己建的群仍是完全访问），凡是给群选完全访问的地方加一句"完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。"（第 15 节，U2）。**跨设备的扩散**（SEC-12）：客户端私钥靠 Electron `safeStorage` 保护，Windows 上同一用户的任何进程都能解开（DPAPI 用户级密钥，未在 Electron 版本实测），macOS 会弹钥匙串提示；所以一台装了完全访问档 Bot 的电脑，它配对过的所有设备都在同一个信任范围里。写进 3.7、第 16 节和官网文档。只读、读写档的沙箱连不上 daemon（e04、e04b），CLI 在那两档里本来就用不了，agent 的主路径仍是进程内工具（3.7 第 2 条）；也就是说令牌这条路只在完全访问档里走得到，它让照规矩办事的 agent 和 Skill 拿到和工具一样的结果，不是对完全访问档的安全边界。要彻底挡需要 bot 换 OS 用户跑，本期不做，记进风险。

## 6. 客户端多设备

### 6.1 设备列表、添加、切换

- 设置里新页"设备"：第一行永远是"这台电脑"（本机 daemon，不可删）；下面是加过的设备，每行：名字、平台图标、状态点（在线 / 连不上 / 版本不一致 / 需要重新配对 / 已撤销）、"切换到"。当前设备在主导航旁有一个小标签"<设备名>"，点它也能切。**一次只看一台**（第三轮），切换就是整个界面重新指向另一台的连接：`client-context` 的 `client` 换成那台的；所有页面本来就从 `snapshot` 事件起步，不用逐页改。切换时未保存草稿照旧确认。**非当前设备没有连接**（第 1 版的后台"关注点"连接砍掉，SCOPE-1）。
- 添加：粘贴链接 → 解析（版本、地址列表）→ 填名字（默认链接里的 `device.name`）→ 按地址顺序试连 → 配对（4.3）→ 入列表。失败按地址分类给 Tailscale/局域网/公网提示（第 15 节）。链接已被用掉时给专门文案（第 15 节）。
- 存哪：`userData/devices.json`（0600）：`{ v: 1, devices: [{ deviceId, name, pk, clientId, clientKey: { publicKey, secretKeySealed }, routes: [...], lastRoute, lastConnectedAt, lastKnown, problem }] }`——**每台设备一对客户端密钥**（4.3）。只有私钥用 Electron `safeStorage` 加密，列表本身不加密：钥匙串拒绝访问或应用换了签名时，列表还在，那几台显示"需要重新配对"，不会整个丢掉（U1a 计划 4.2，2026-11-01）。网页端（浏览器）不存，本期不远程。

### 6.2 被连的那一侧（桌面端里管自己这台设备）

设置 →"设备"页、设备列表下面一组"允许别的设备连接"（U3 起先放在"应用与启动"，owner 2026-11-03 问"不应该放在多设备一起？"，照 Orca 的 Remote Orca Servers 一页里既有"Add Server"又有"Advertise this app as a server"，移到"设备"页；管的仍是当前看的那台，网页端的"设备"页只有这一块）：
- 地址：列出本机能用的地址并标分类（`tailscale` 推荐、`overlay` 组网、`lan`、`cgnat`/`public` 需确认），**单选**，选一个即 `device.enable`，换一个就换掉原来的（A1：只开一个；虚拟网桥、代理软件的虚拟地址默认不列，和 `vonvon remote candidates` 同一套）；右边显示状态（监听中 / 等待地址 / 网络变了需确认）。
- "生成连接链接"按钮：`device.pair` → 显示可复制的链接，倒计时 10 分钟，"再生成一个"。不显示二维码。
- "已配对的客户端"：名字、类型、最近连接时间和地址、由谁带进来、最近 24 小时新配对的标出来，"改名""撤销"（带"连它带进来的一起撤销"）。撤销有确认框（第 15 节）。
- 新客户端配对成功时弹一条提示（4.3）。
- 没开任何地址时按钮灰掉，说明先选地址。

### 6.3 一台设备同时连几个客户端

- 快照推送已经让所有客户端同步（`D/server/http.ts:148-158`）。要修：`registerAgent` 任何客户端一发就取消已有的注册任务（`D/server/jobs.ts:66`），改成已有任务、而且发起的不是同一个客户端时回 `{ kind: 'refused', code: 'job_running', message }`，客户端显示"另一台设备「X」正在扫码添加 Bot，等它完成后再试"（第 15 节）；同一个客户端再点照旧重来（U3 计划：不另加 `jobRunning`，网页端的 `run()` 和 `bot add` 已经会显示 `refused` 的文字）；拥有任务的 peer 断开就取消任务（`jobs.ts:216-217`）改成 60 秒宽限，期间同一个客户端重连自动续上（按 `clientId`，本机按 `clientKind`）；同一个 key 还有别的连接连着时不算断开，不起宽限（换网络时新连接常比旧连接的断开先到，U3 计划 4.2 的 `holders`）；被撤销的客户端不留宽限，立刻取消：连着的、已经断开在宽限里的都一样（U3 计划 4.2 的 `jobs.cancelOwner`）。不做"接管"（SCOPE-1）。`bot add` 收到 SIGINT 先发 `cancelJob` 再退出（有了宽限，断开不再等于取消，CONTRACT-1）。
- 两个客户端同时改同一段设置：现有的 revision 冲突机制照旧（`settings.save` 旧 revision 拒绝）。

### 6.4 当前设备是远程时，界面哪里不一样

| 事 | 本机 | 远程 |
|---|---|---|
| 选目录（建群、换目录、工作区） | 桌面端走系统原生选择器（`U/directory-picker.tsx:107-111`，`shell.chooseDirectoryPaths`），网页端走 daemon 侧目录浏览器 | daemon 侧目录浏览器，标题写"<设备> 上的文件夹"；`DT/main.ts:621-627` 的原生目录对话框和 `chooseExecutablePath` 在远程模式不暴露；手动输入路径要认 Windows 路径（今天只认 `/` 开头，`directory-picker.tsx:129`）；家目录限制（`directory-browser.ts:13-16`）放开到该用户能读的任何目录，本机和远程一样（owner 2026-10-31 确认：服务器上代码常在 `/srv`、`/data`；daemon 本来就以该用户运行，限制只防误点），U2 改 |
| 托管安装 Codex / Claude SDK / lark-cli | 装本机 | RPC 本来就作用在对面，文案加"在 <设备> 上安装" |
| Provider 没配好 | "把 Codex 配置好" | "在 <设备> 上把 <Codex / Claude> 配置好（账号或自定义 API 都行），然后点「重新检测」"，检查逻辑不变（`environment.scan`、`backendLogin{refresh}`）。第 1 版末尾那句"Vonvon 不代你登录"删掉（REQ-5）。**现有带"登录"的文案一起改**，列在 U2：`JoinGroupDialog.tsx:150,214`、`settings/useProviderDiscovery.ts:49,56`、`settings/DecisionFields.tsx:41`、`settings/GroupDesignSettings.tsx:113,137,183`、`management/EnvironmentPanel.tsx:143,298,310,314,364`、`management/environmentPresentation.ts:30`、`setup/ProviderSetup.tsx:152,175`、`setup/useClaudeLoginCheck.ts:21`、`management/UsagePanel.tsx:69`、`DiagnosticsPanel.tsx:246`、`search.ts:69,70,98`——统一成"配置好 / 可用 / 检查配置"，远程时带设备名；判断逻辑不动。U2 计划 4.2 逐条核过：`EnvironmentPanel.tsx:358,364`、`environmentPresentation.ts:30`、`search.ts:70` 说的是 lark-cli 的飞书登录，保留并写明"飞书"；`search.ts:98` 的搜索别名保留；daemon 里会原样显示到页面的 Provider"登录"提示（`claude-agent/login.ts`、`codex-appserver/backend.ts:882-886` 等）一起改，见 U2 计划 4.2 第二张表 |
| 登录项开关 `setLoginItem`（`DT/login-item.ts`） | 本机 launchd | 隐藏；改显示对面 `machine.status.service`，macOS 对面可用 `machine.service install/uninstall`（daemon 里已有，`D/host/service-action.ts`），Linux 显示"在那台设备的终端运行 `vonvon service install`"，Windows 显示"这一批 Windows 不做登录自启，那台电脑上的 Vonvon Bot 开着时才在线" |
| 启动 daemon（`startHost`）、服务启动（`service start`） | 本机，**照旧可用**（这两个 kind 不是死代码，见 8.4） | 隐藏：连不上的设备在列表里就是"连不上"，没有能按的 |
| 停止 daemon（`machine.stopHost`） | 照旧 | 保留但确认框写"停止后只能在 <设备> 上重新启动；要重启请用「重启」"；`restartHost` 放在前面（owner 2026-10-31 确认） |
| 修复 `vonvon` 命令、PATH（`repairCli`） | 本机 | 隐藏；`DT/bridge.ts:270-271` 用本机 CLI 状态覆盖 `machine.status.cli` 的行为只在本机做 |
| 桌面端自己的更新 | 照旧 | 照旧，标题改"这台电脑上的 Vonvon Bot 应用" |
| 服务端更新（`UpdatePanel`） | 7.5 | 7.5，标题"<设备> 的服务端"；对面是 `bundled` 时按钮写"更新 <设备> 上的 Vonvon Bot"，走 7.5 末尾的桌面端外壳路径（U4） |
| 在 Finder 里显示 / 打开文件夹 / 打开本机路径 | 有 | 隐藏（路径在对面） |
| 打开飞书链接、浏览器链接（`openExternal`） | 有 | 有（在客户端打开是对的） |
| 退出桌面端 | 停本机 daemon（`DT/quit-daemon.ts`，7.4：另外注册成后台服务、不是桌面端自带的不停） | 不碰对面 |
| 重启 / 停止后的跟踪 | 等本机 pid 锁（`DT/main.ts:370-463`） | 看 socket 断开，重连后比较 `serverInfo` 和 `daemonStatus.pid/startedAt` |

### 6.5 升级按钮今天是死的

`UpdatePanel` 要 `host.ownership === 'attached'`（`U/App.tsx:903`、`U/management/UpdatePanel.tsx:84`），daemon 永远回 `owned`（`D/server/snapshot.ts:57`、`D/server/rpc/machine.ts:40`）。改成看 `serverInfo.capabilities` 含 `update.standalone` 或 `update.npm` 就显示按钮，并按 7.5 的新引擎工作；**含 `update.bundled` 也显示按钮**（owner 2026-10-31：桌面端自带的服务端也要能远程升级）：点了发同一个 `machine.applyCoreUpdate`，daemon 请本机的桌面端外壳跑它自己的应用更新（7.5 末尾，U4）。`checkCoreUpdate` 的回复带 `desktopShell: boolean`（那台的桌面端外壳此刻连着没有），没连着时按钮旁先写"要在 <设备> 上开着 Vonvon Bot 桌面端"，点了回 `desktop_not_running` 和同一句（第 15 节）。0.8 及更早的 bundled 是 v1 协议，没有 `capabilities`，按 4.5 提示到那台升级一次，从 0.9 起才能远程升级。`ownership` 字段保留但不再用来门控。I3 只做 `standalone`/`npm` 的门控，`update.bundled` 的按钮和文案归 U4。

## 7. 安装、后台服务、升级

### 7.1 发行物：`standalone`

- 新发行种类 `standalone`（`Distribution.kind` 在 `D/service/distribution.ts:7`、`P/machine.ts:45` **和 `P/admin.ts:88` 的 `daemonStatus.distribution`**（PROTO-2，第 1 版漏了这处，漏了的话 standalone 上每次连接都解析失败）三处加；客户端按开放字符串解析）。识别靠安装根里的 `standalone.json`（`{ v: 1, version, installRoot }`），**先于** `.git` 祖先检查（今天 development 优先，`distribution.ts:27-33,49`，一个 dotfiles git 仓库下的家目录会误判），不依赖 `npm root -g`。
- 内容（PKG-1 补齐）：`app/{package.json, bin/vonvon.mjs, dist/cli.js, ui/dist/, node_modules/}`——`package.json` 和 `bin/vonvon.mjs` 是 `classifyDistribution`、版本号（`core/version.ts:14`）和 `vonvon hook`（只在 `bin/vonvon.mjs:7-19` 处理）要的；`ui/dist` 是 `vonvon open` 要的（`server/web-ui.ts:7-10,33-37`，没有就 503，而 `open` 是 Linux 服务端上本机唯一的界面）；`node/`（官方 Node 24 LTS 二进制，含 npm）；`LICENSE`、`NOTICE`、paseo 的声明。`dist/cli.js` 用 esbuild `minify: true`，把 `@vonvon/client`、`@vonvon/protocol` 一起打进去，`packages: 'external'` 只留 node_modules 里的第三方；不带 source map、`src/`、`test/`、`.d.ts`（`scripts/stage-daemon.mjs:147-158` 今天 `minify` 关着、client/protocol 以 tsc 输出外置）。**`stageDaemon` 的这些改动对桌面端同样生效**（REQ-11：需求"三个平台一起换"包括桌面端自带的 `Resources/daemon`，`packages/desktop/build.mjs:89` 调的就是同一个 `stageDaemon`）；"不动"只是说发行种类还是 `bundled`。
- **依赖布局**（PKG-2）：原来写 win-* 用 `hoist`、其余用 `compact`，I1 实际六个包都用 `hoist`（I1 计划 4.7）；`build-manifest` 检查里有"包内没有 symlink"。原来的"最长相对路径不超过预算"（按 `%LOCALAPPDATA%\VonvonBot\server\releases\<v>.part\app\node_modules\…` 推算，PS 5.1 的 260 字符限制）是给 Windows 包的，2026-11-01 起用不上。
- 两个包：`linux-x64`、`linux-arm64`（glibc；musl/Alpine 本期不支持，脚本明说，owner 2026-10-31 确认），`.tar.gz`。原来还有 `darwin-arm64`、`darwin-x64`、`win-x64`、`win-arm64`（Windows 用 `.zip`），owner 2026-11-01 定 Mac、Windows 只用安装包装全部软件，这四个不发。I1 写过打这四个包的代码：`scripts/build-server.mjs` 的另外四个目标、`scripts/server-node.json` 的四个 Node、`unpackZip`/`writeZip` 和 `.zip`、Windows 的 Node 和 npm 布局、260 字符预算、大小写重名检查，`bundledNpmCli` 的 Windows 布局，launchd 接受 `standalone`。清理片 I6 已删（第 13、19 节，`server-6-linux-only.md`），`build-server.mjs` 只认 `PUBLISHED_TARGETS` 这两个。桌面端 `RegisteredDaemon.kind` 的 `standalone` 留着：它取自共用的服务定义解码，Linux 的 systemd 单元解出来就是它，Mac、Windows 上读不到。
- macOS、Windows 桌面端和 Linux 服务端包**同一个版本号**，这一批是 **0.9.0**（owner 2026-10-31 定；协议升到 2、Linux 首次有服务端包）。`scripts/product-version.mjs` 已同步 daemon、desktop，I5 让它也管服务端包。

### 7.2 安装布局：稳定的真实路径

| | Linux |
|---|---|
| 安装根 | `~/.local/share/vonvon-bot/server/` |
| 版本目录 | `releases/<version>/{app,node,standalone.json}` |
| 当前 | `current` → 符号链接到 `releases/<version>`（先建 `current.next` 再 `rename` 覆盖，原子） |
| 启动器 | `bin/vonvon`（shell 脚本，exec `current/node/bin/node current/app/bin/vonvon.mjs "$@"`，带标记 `# Vonvon Bot server CLI v1`） |
| PATH | 往 `.zshrc/.zprofile/.bashrc/bash profile` 加和桌面端今天**完全相同的** `# >>> Vonvon Bot CLI >>>` 块（`DT/cli-registration.ts:17-34`，文本两边共用）；非交互 shell 下只提示 |
| 数据 | `~/.vonvon-bot`（默认，脚本不读 `VONVON_HOME`） |

原来表里还有 macOS（和 Linux 同一列）和 Windows 一列：`%LOCALAPPDATA%\VonvonBot\server\`、`current.txt` 指针文件（SEC-10、WIN-1）、`bin\vonvon.cmd` 和 `bin\vonvon-server.cmd` 启动器、`HKCU\Environment\Path`、`%USERPROFILE%\.vonvon-bot`。owner 2026-11-01 定 Mac、Windows 不做只装服务端，这些都不做；I3 里为 Windows 写的 `current.txt` 分支已由清理片 I6 删。

命令和服务定义都 exec `app/bin/vonvon.mjs` 而不是 `app/dist/cli.js`（PKG-1：`hook` 在 `.mjs` 里处理，跳过它旧的 hook 每次工具调用都报错）。服务定义对 `standalone` **不解析 realpath**（今天 `systemd.ts:103,316`、`launchd.ts:114,318` 记 realpath，会钉到版本目录），写成 `current/node/bin/node current/app/bin/vonvon.mjs daemon run --port N`，`PATH` 前置 `current/node/bin`。**不靠 `VONVON_NPM_CLI`**（NPM-1：没有 systemd 时退回 `daemon start`、手动 `daemon run` 都没有这个变量）：`bundledNpmCli()`（`D/platform/npm.ts:13-21`）认出 `standalone`，从 `realpath(process.execPath)` 推出同一 release 里 Node 自带的 npm（`bin/../lib/node_modules/npm/bin/npm-cli.js`；I1 还写过 Windows 的布局，I6 已删），托管安装 Codex 的 `requireTrustedNpm`（`managed-install.ts:53`）就有可信 npm。升级只换 `current` 指向，服务定义不用重写。

### 7.3 安装脚本

`install.sh`（POSIX sh）只在 Linux 上装。`install.ps1` 随 I2b 取消（owner 2026-11-01）。

先看系统：`uname -s` 不是 `Linux` 就什么都不碰、退出非零（2）。是 `Darwin` 时打印第 15 节"安装脚本：在 Mac 上"那句，让用户到 https://vonvon.cc/get/ 下载安装包（里面带了服务端和 `vonvon` 命令）；别的系统（Windows 的 Git Bash 这类）打印"安装脚本：不是 Linux、也不是 Mac"那句。这一步在 root、已装过和公钥的检查之前，不联网、不写文件。然后：
0. **root**：照装，不提示（owner 2026-11-03，和 Paseo、Orca 一样；Claude 在 root 下拒绝 bypassPermissions 是 Claude Code 自己的事）。`vonvon daemon run` 和 `service install` 也不再警告。原来是默认拒绝、`VONVON_ALLOW_ROOT=1` 才放行（SEC-13，owner 2026-10-31），0.9.1 改掉。
1. **已装过？**（REQ-3）任一命中就按第 15 节的文案跳过、退出 0、不动任何东西：
   - 数据目录里 `daemon.pid` 的进程活着；
   - systemd 的服务定义 `vonvon-bot*.service` 在（7.4 的命名）；
   - 安装根的 `current` 在，`bin/vonvon` 也能跑（装过服务端）；
   - PATH 上的 `vonvon` 带 vonvon 自己的标记。
   原来还查桌面端装没装（COEX-1：macOS `/Applications/Vonvon Bot.app`、Windows 的 NSIS 卸载项）、LaunchAgent、Windows 计划任务，并按平台分跳过文案。2026-11-01 起脚本只在 Linux 上装，Linux 没有桌面端，这些不查。
2. 选包：`uname -m`（`linux-x64` 或 `linux-arm64`）；查 `ldd --version` 不是 musl；读 `https://dl.vonvon.cc/bot/server/stable/manifest.json`（7.5 同一份签名清单），**用清单里 `files[os-arch].sha512` 核对压缩包**，不再用同源的 `.sha512` sidecar（SEC-14：sidecar 和包同源，只防传输损坏）；有 openssl 3 就用 `pkeyutl -verify -rawin` 验 Ed25519 签名（公钥写死在脚本里），没有就跳过并明说"没验签名，信任根是 HTTPS 和 dl.vonvon.cc"。`version` 必须匹配 `^[0-9]+\.[0-9]+\.[0-9]+$` 才往路径里拼；解包后检查成员路径没有 `..` 和绝对路径；解到 `releases/<version>.part/` 再改名 `releases/<version>/`，再切 `current`。
3. 写命令和 PATH（7.2）。
4. `vonvon service install --linger --json`：Linux 在管道下 stdin 不是 TTY，今天 linger 会被静默跳过（`D/cli/commands/service.ts:160,189`），所以脚本显式传 `--linger`（能开就开、不问用户，owner 2026-10-31 确认）。**"装好了但 linger 没开成"不再让命令非零退出**（LINGER-1：今天抛错，`service.ts:107`，`set -e` 的脚本会在这里中止、打不出 sudo 提示）：`--json` 回 `{ ok: true, linger: 'off', hint }`，退出 0，脚本按它打印 `sudo loginctl enable-linger <用户名>`，不自己 sudo。退路：没有 systemd（容器）、**用户实例没在跑或没有 `XDG_RUNTIME_DIR`**（`sudo -u` 切过去时常见，`linux-session.ts:77-85` 已经分得出这两种）→ 打印对应提示，退回 `vonvon daemon start` 并明说"崩溃不会自动重启"。原来的 macOS 没有 GUI 登录、Windows 计划任务两种退路随 2026-11-01 的决定不要了。
5. 打印：装好了、版本、`vonvon --version` 试一下、下一步看官网说明（URL 等 W1 定下路径，见第 10 节；不打印连接链接，第四轮）。
- 加固（SEC-14）：脚本内部的 `curl` 一律 `--proto '=https' --tlsv1.2`；整个脚本包进 `main()`、最后一行才调用（管道中途断开不会执行半截）；`set -eu`。
- 脚本自身只做下载、解包、调 `vonvon`，逻辑尽量放在 `vonvon` 里（`service install`、`remote`），脚本好测、好升级。`uninstall.sh` 一并提供（停服务、删服务定义、删安装根、保留数据目录并说明），同样只在 Linux 上动手，第一步就看系统：在 macOS 上打印第 15 节"卸载脚本：在 Mac 上"那句，别的系统打印"卸载脚本：不是 Linux、也不是 Mac"那句，退出非零。
- **脚本里的删除**（SCRIPT-1：第 1 版"不对变量拼的家目录路径用 rm -rf"和 uninstall 要删安装根本身冲突）：`install.sh` 只删自己刚建的 `releases/<version>.part`；`uninstall.sh` 删安装根只走一个受保护的函数：`${HOME:?}` 非空、目标是 `$HOME/.local/share/vonvon-bot/server` 这个字面拼法、不是符号链接、目录里有 `releases/*/standalone.json` 标记，四条都满足才 `rm -rf -- "$target"`；不删数据目录。脚本测试：`HOME` 为空或指向没有标记的目录时拒绝。

> 实现时和本节不一样的地方（PATH 块搬进 protocol、`releases/<v>` 已存在时复用）见 `docs/plans/server-2-install-scripts.md` §4.6；2026-11-01 起安装脚本只支持 Linux（owner），见同一文件"只支持 Linux"一节。

### 7.4 后台服务和共存

- **Linux** systemd 用户服务：现有（`D/service/systemd.ts`），只加 `standalone` 种类和 7.2 的不解析 realpath。
- **macOS** LaunchAgent：现有（`D/service/launchd.ts`），只给桌面端自带的服务端用（"登录时启动"，今天就有）。Mac 上没有脚本装的 `standalone`（owner 2026-11-01）；I1 曾让 launchd 接受 `standalone`，I6 改回只装桌面端自带的和 npm 装的。Claude 的钥匙串登录在 launchd 下的行为未核实（`install-update-release.md` §5）。
- **Mac、Windows 当被连的设备时要有用户登录着**（owner 2026-10-31：本期接受）：Mac 靠桌面端的登录项（LaunchAgent），这个用户登录后运行；登录后可以锁屏，Bot 照常在线；机器重启后要有人登录一次。Windows 桌面端这一批不注册 `vonvon`、不做登录自启（owner 2026-10-31 确认），要用户登录着、Vonvon Bot 开着才在线，同样可以锁屏。Skill 在 Windows 桌面端上只用进程内工具（本来就是主路径）。Linux 开了 linger 不需要登录。写进官网文档（第 10 节第 2 条）、`product.md` 3.10（第 11 节）。不用登录也能跑的 Windows 服务 / macOS LaunchDaemon，以及 Windows 的登录自启，进 `product.md`"v1 之后"。
- **Windows**：不做只装服务端，也就不做 `D/service/windows.ts`、按用户和数据目录命名的计划任务、`bin\vonvon-server.cmd` 启动器和 `__win-supervise` 监督进程（owner 2026-11-01，I4a、I4b 取消）。原来的做法（SEC-15、WIN-2）留在 `docs/plans/server-4a-windows-task.md`、`server-4b-windows-supervise.md` 和分支 `claude/server-4a-windows-task` 里作参考，不合入。那两片里顺带的 Windows 小修（daemon 里 detached spawn 加 `windowsHide: true`、`vonvon open` 在 win32 用 `start`）也不进这一批；Windows 桌面端真用得上时另开小 PR。I4a 里"win32 报平台名 `windows`"一项例外，挪给 U2（第 19 节"Windows 的平台名"）。`service/adapter.ts:79` 在 win32 照旧抛错。
- **共存，桌面端一侧**：原来为"脚本装的服务端 + 桌面端在同一台"写了四条（`install-update-release.md` §4）。2026-11-01 起 Mac、Windows 上没有脚本装的服务端，Linux 没有桌面端，只剩第 1 条，而且换个说法：
  1. 退出：`DT/quit-daemon.ts:15-41` 停本机的服务端，只有一种不停——它不是桌面端自带的（`bundled`），又另外注册成了后台服务（比如用户自己 `npm i -g vonvon-bot` 后 `vonvon service install`）。这种停了以后（退 0）服务管理器不会再拉起它（`definitions.ts:75`），所以退出桌面端只断开。桌面端自带的（`bundled`）不管有没有开"登录时启动"（那是桌面端自己注册的 LaunchAgent）都照旧停，和今天一样。Windows 上没有后台服务注册（`service/adapter.ts` 在 win32 抛错），所以这条例外只在 macOS 上用得到；Windows 更新前的 `beforeUpdateInstall`（`DT/main.ts:233-236`）不改，照旧停本机的服务端。
  原来的第 2 到 4 条（登录项开关显示"由独立安装的服务端管理"、启动修复不碰 `standalone`、`observeCli` 认 `# Vonvon Bot server CLI v1`）不做。npm 装的服务注册，桌面端今天就不做启动修复（`login-item.ts:181` 只对 `desktop`），不用改。
- **共存，脚本一侧**：7.3 第 1 步（只在 Linux）。

### 7.5 升级引擎和 `vonvon update`

> 实现时和本节不一样的地方（状态文件、降级、看门狗、`applyCoreUpdate` 先回复）见 `docs/plans/server-3-update-engine.md` §4.11 和文末。

- **清单** `https://dl.vonvon.cc/bot/server/stable/manifest.json`，Ed25519 签名（复用 Windows 清单的签名和校验代码 `DT/windows-update-manifest.mjs`、`scripts/windows-update-signing.mjs`，**用一把单独的服务端密钥**，公钥编进 daemon 和安装脚本）。签名内容照 Windows 的 `validateWindowsUpdatePayload` 那样严格（SEC-9：第 1 版只有 `{version, publishedAt, files}`，每个版本的签名清单又公开放在 `bot/server/<version>/manifest.json`，谁拿到 COS 写权限或配错了就能把旧版本的合法清单放到 stable 回滚所有人）：`{ schemaVersion: 1, product: 'vonvon-bot-server', channel: 'stable', version, publishedAt, files: { 'linux-x64': { url, sha512, size }, … } }`，`url` 必须等于 `https://dl.vonvon.cc/bot/server/<version>/vonvon-server-<version>-<os>-<arch>.<ext>`，`version` 必须是语义版本。`files` 只有 `linux-x64`、`linux-arm64` 两项，`<ext>` 是 `tar.gz`（owner 2026-11-01；I3 计划的 C1 原来写六项，按那里的说明改）。
- **检查**：`machine.checkCoreUpdate` 对 `standalone` 读清单（对 `global-npm` 照旧 `npm view`，`D/service/update.ts:68-91`）；回复加 `distribution.kind: 'standalone'`、`channel`。**只接受比当前和历史最高都新的版本**（`newer()`，照 `windows-updates.ts:108-110`），历史最高和上次见到的 `publishedAt` 记进 `standalone.json`，`publishedAt` 倒退的清单拒绝（防冻结）；降级只能在本机 `vonvon update --allow-downgrade --to <v>` 显式要求。默认不自动升级（升级一节）；daemon 每 24 小时查一次只为了在界面上标"有新版本"。
- **应用**（UPD-1：第 1 版让助手在旧 daemon 退出后才切 `current`，但 launchd `KeepAlive SuccessfulExit=false, ThrottleInterval 5` 和 Windows 监督进程收到 75 立刻拉起、systemd 5 秒后拉起，拉起的都是还指向旧版的 `current`，助手看到"同端口换了 pid"就写 `done`——macOS、Windows 上升级报成功实际跑旧版（2026-11-01 起 `standalone` 只在 Linux，Windows 监督进程、Mac 的 launchd 对它已不适用，systemd 那种照样会发生）。改成和 npm 路径一样"先换文件再重启"，`update.ts:142-153`）：`machine.applyCoreUpdate` → `performStandaloneUpdate`：`update.lock`（已有）→ 下载到 `releases/<v>.part/`（校验 sha512 和清单签名）→ 改名 `releases/<v>/` → **原子切 `current`（rename）** → 把 `{ previous: <旧版> }` 写进 `update-status.json` → `requestRestart(port, update)`（已有：drain → 2026-11-02 起直接中断进行中的对话、最多 30 秒 → 退 75 → systemd 按 `current` 拉起**新版本**，不托管时由助手起）。`__restart-after-exit` 助手（`D/host/restart.ts`）改成：等新 owner 出现后**核对 `serverInfo.version === update.to`**，不只看 pid 变了；成功写 `done`；超时或版本不对 → 切回 `previous`、让管理器再拉起、写 `error`。助手和 Bot 子进程重起自己用的 `process.argv[1]`（`supervisor.ts:86`、`lifecycle.ts:195`、`restart.ts:13`、`service-action.ts:36`、`config/store.ts:59,74`）都改成钉在自己 `realpath` 所在的 release 上，免得排空期间重起的子进程加载新代码。`releases/` 只保留当前和上一版。
- **`vonvon update [--check] [--json] [--allow-downgrade --to <v>]`**：注册到 `cli/index.ts`（今天 `runUpdate` 没注册，`install-update-release.md` §2）。daemon 在跑就发 `machine.applyCoreUpdate` 并轮询 `coreUpdateStatus`（排空期间也放行，4.7）；连接断了（daemon 退出重启那一刻）就改读本机 `update-status.json` 继续显示，直到 `done`/`error` 或 60 秒；"进行中、结果待定"退出码 6。没在跑就直接下载、切 `current`、不启动。`bundled`：daemon 在跑就和别的客户端一样发 `applyCoreUpdate`，由本机桌面端外壳更新（下一条）；桌面端没开或 daemon 没跑，照旧提示"在桌面端里更新"（今天的文案，`cli/commands/update.ts:26-29`）。
- **从任何客户端升级**：就是 6.5 的按钮 + 4.5 的维护子集。
- **桌面端自带的服务端（`bundled`）远程升级**（owner 2026-10-31 要，U4）。bundled 的 daemon 在 `.app` / NSIS 安装目录里，只能随桌面端整包更新，所以 daemon 不自己换文件，而是请同一台电脑上的桌面端外壳跑它已有的应用更新：
  - **通道**：用外壳今天就有的那条本机连接——主进程里 `AttachedDaemon.client` 的 loopback ws（local owner，`clientKind: 'desktop'`），事件和 `onLog`、`onBackendInstall` 一样在 `DT/bridge.ts:206-207` 那里订阅。外壳在 `admin.negotiate` 里声明能力 `desktop.self-update`；只有这台 loopback 上、local 主体、声明了这项能力的连接算"桌面端外壳在"，远程配对来的桌面端客户端（也是 `clientKind: 'desktop'`）不算。界面切到别的设备时外壳对本机的连接仍在（U1a），照样收得到。
  - **检查**：`checkCoreUpdate` 对 `bundled` 发事件 `desktopUpdateRequest { requestId, action: 'check', by: <客户端名> }`，外壳跑 `updater.check()`（macOS `DesktopUpdater`，`DT/updates.ts`；Windows `WindowsDesktopUpdater`，`DT/windows-updates.ts`），用新 RPC `machine.desktopUpdateReport { requestId, state, latest?, message, progress? }` 回结果；daemon 把它放进 `coreUpdate` 回复（`latest`、`hasUpdate`、`desktopShell: true`）。外壳不在 → `desktopShell: false`、`latest: null`；10 秒没回 → 同样按"没回应"处理。
  - **应用**：`applyCoreUpdate` 对 `bundled` 发 `action: 'apply'`，外壳依次 `check()` → `install()`（下载：macOS Squirrel / Windows electron-updater，带原生签名和 Windows 发布签名校验，最多 10 分钟）→ `install()`（`quitAndInstall`，前面照旧跑 `beforeUpdateInstall`，`DT/main.ts:230-241`）。**排空就是现有的那套**：Windows 在 NSIS 换文件前 `stopHost`（2026-11-02 起直接中断进行中的对话，最多 30 秒，`docs/plans/interrupt-and-install-text.md`）；macOS 应用更新时 daemon 照旧跑着，重启后的新桌面端由启动修复用 `stopHost` 停掉旧的 bundled（drain）再起自己的（`login-item.ts:187,225-229`）。远程触发不改这个顺序。Windows 今天手动安装前的本机确认框（`main.ts:633-637`"安装并重启 Vonvon Bot？…可以选择稍后"）远程触发时不弹（2026-11-02 起本机点"重启升级"也不弹了，确认框已去掉）：点按钮的人就是主人本人（第二轮），确认在发起的客户端上做（第 15 节），没人守着的电脑上弹框会一直挂着；外壳改为在托盘和窗口里给一条不拦人的提示"「<客户端名>」正在更新这台电脑上的 Vonvon Bot"。
  - **状态**：外壳每一步都 `desktopUpdateReport`，daemon 映射到 `coreUpdateStatus`（`installing` 带"正在 <设备> 上下载桌面端更新 45%" / `restarting` / `error`；枚举客户端按开放字符串解析，4.5），所以发起的客户端、`vonvon update` 都看得到进度；`restarting` 要在 `beforeUpdateInstall` 里 `cleanup()` 断开本机连接之前报出去（`main.ts:138-158`）。外壳报 `unavailable`（`updater.enabled` 为假：未签名、没配更新源）就原样回它的文字。重启那一刻连接断开，发起的客户端按 4.7 重连，比较 `serverInfo.version` 判成没成。
  - **外壳不在**：`applyCoreUpdate` 回 `desktop_not_running`（exit 4），文字"<设备> 的服务端是桌面端自带的，要那台电脑上的 Vonvon Bot 桌面端开着才能远程更新。在那台电脑上打开 Vonvon Bot 后再试，或者直接在那里更新。"（第 15 节）。
  - **授权**：`machine.desktopUpdateReport` 只收本机 loopback 上声明了 `desktop.self-update` 的外壳连接，已配对客户端和 bot-session 都 ✗（5.2）；它在对齐测试白名单里标 desktop-only（8.5）。`desktopUpdateRequest` 事件只发给那条连接。
  - 不做：桌面端没开时替它启动（daemon 不负责拉起图形应用）；0.8 及更早的 bundled（v1 协议）——它们没有 `capabilities`，要在那台电脑上先更新到 0.9 一次（4.5、6.5）。
  - **U4 计划补的**（2026-11-01，`devices-ui-4-bundled-update.md` 4.2–4.5）：报告到状态的映射（`downloading`/`downloaded` → `installing`，`restarting` 时放锁，`current` → `done`，`unavailable`/`install-pending`/`error` → `error`）；四个看门狗（发出 30 秒没回应、下载 15 分钟没动静、`restarting` 前外壳断开、`restarting` 后 10 分钟旧进程还在或外壳又连回旧进程）；状态记 `via: 'desktop'`，新进程的启动收尾按 `to` 判成败，不需要安装根；远程更新进行中，本机的"安装"按钮先拒；外壳只在本机主连接上 `negotiate`，bridge 不转发页面在本机视图里发的 `negotiate`。检查等外壳回话从 10 秒放到 20 秒：桌面端读更新清单自己就有 15 秒超时。2026-11-02 审查后又补了：能力名改成 `desktop.self-update`（D1 的正则只收小写）；检查和更新各用自己的 id，更新进行中的检查不转给外壳，回上一次的结果，`fresh: false` 也回上一次的；排空期间外壳的 `machine.desktopUpdateReport` 照收（排空白名单），Windows 的 `stopHost` 60 秒没停完就报"后台 1 分钟内没停完"。

### 7.6 发布流水线加什么

- `scripts/build-server.mjs`：复用 `stageDaemon`（加 minify、bundle client/protocol、删 `.d.ts`/`src`/`test`、用 `hoist`），拷 `ui/dist`、`bin`、`package.json`，下载两个 Linux 的 Node 二进制（校验 nodejs.org 的 SHASUMS256），写 `standalone.json`，打 `.tar.gz`，产出 `build-manifest.json` 做确定性核对（照 `pack-vonvon-bot.mjs:54-68`、`check-vonvon-bot-package.mjs`），检查无 symlink、无 `.ts/.d.ts/.map/src`。没有原生模块（调研没找到 `.node` 文件），Linux runner 上两个都能打。只认这两个（`PUBLISHED_TARGETS`；I1 写的另外四个目标 I6 已删，7.1）。
- `scripts/publish-server.mjs`：COS 写入 `bot/server/<version>/…` 禁止覆盖；签名清单**只有 stable 一份**（`channel: 'stable'` 在签名里，`bot/server/<version>/manifest.json` 只放未签名的文件表供脚本和人看）；**切 `bot/server/stable/manifest.json` 和 `install.sh`、`uninstall.sh` 只在 owner 本人确认后**，照 `AGENTS.md`"Mac 发布任务"的 stable 规则，`release-publish.mjs` 的 plan → upload → promote 加 `server` 一项。
- CI：`.github/workflows/ci.yml` 的 Linux 任务加"构建服务端包 + 安装脚本冒烟（在 `mktemp -d` 的 HOME 里跑 `install.sh`，只验证解包、`vonvon --version`、`vonvon open --print` 回 200、`vonvon hook` 退 0、`service install` 在无 systemd 下的退路）"；`ci-scope.mjs` 把 `scripts/install.*`、`scripts/build-server.mjs` 归入全量。
- macOS、Windows 安装包和 Linux 服务端包同版本（`AGENTS.md`"双平台发布版本"扩到服务端包），这一批 0.9.0（owner 2026-10-31 定）。

## 8. 命令行补全

### 8.1 约定（C1 一次改到位）

- 每条命令 `--json`，形状固定：成功 `{ "ok": true, ...payload }`；失败 `{ "ok": false, "error": { "kind", "message" }, "exitCode" }`。今天只有 `settings`、`feishu`、`schedule` 这样（`D/cli/index.ts:16-19`），其余打 stderr 退 1；改成全部走 `command-error.ts`，`structured` 名单去掉、按 `--json` 判断。
- 退出码照现有：2 参数错、3 连不上 daemon、4 被拒绝（含 `scope_required`、`session_token_missing`、`not_in_session`、`permission_denied`、`not-dm`、`desktop_not_running`）、5 冲突（revision）、6 结果不明（含"升级进行中"）、1 未预期。
- 任何命令都能不交互：`bot add --json`（事件流 JSON Lines：qr 的 URL 和过期时间、阶段、结果），非 TTY 不再拒绝（`bot.ts:165` 今天拒绝的理由是"二维码打进日志会被别人扫走"；`--json` 是用户明确要的机器输出，和 `pair --json` 同一条规矩，文档写明别重定向进日志）；`secrets set` 从 stdin 读照旧；`service install` 的 linger 用 `--linger/--no-linger`，非 TTY 没给就 `--no-linger` 并提示。
- 命名三处一致：UI 文案、RPC kind、CLI 子命令用同一个动词（启用 enable、停用 disable、移除 remove、解绑 unbind、改名 rename）；`--bot` 一律接 appId 或名字（`memory` 今天只接 appId，`memory.ts:35,61`）。
- 读默认走 `snapshot`，写完的命令自己发 `command.refresh`（快照 5 秒重建，`snapshot.ts:185-186`），`--fresh` 强制刷新。人类可读输出默认只列活跃条目，`--all` 带上已归档的（PARITY-1：恢复和彻底删除的目标是已归档条目，今天只有 `--json` 看得到）。
- `--scope` 全局（5.3）。
- **C1 先合入**（SLICE-1：D1、D3、I3 的新命令都要登记 `covers` 和白名单，和 C1 同时改 `cli/index.ts`、`command-error.ts` 会冲突、对齐测试会红）；C1 的白名单先登记 `device.*`、`admin.negotiate` 和 `update`，后面各片把它们从白名单挪进 `covers`。

### 8.2 缺口分组（`parity-join.json` 156 行：65 missing、21 partial、16 bypass，经 `completeness-critic.md` 修正）

| 包 | 内容（新命令） | 条数 |
|---|---|---|
| C2 Bot | `bot enable/disable/remove/rescan`（setAgentEnabled、deleteAgent、refreshAgentCredentials）、`bot callback status/confirm/unconfirm`、`bot add --json`（SIGINT 发 `cancelJob`）、`bot status` 补 distribution 和数据目录 | 9 |
| C3 群与项目 | `group create`（createProject）、`group set <oc> --enabled/--conversation/--folder/--project`（editProject）、`group unbind`（removeProject）、`group show`（collaboration.project）、`group bind --project/--folder default`、`dir list/suggest`、`project rename/remove/workspace`（library.*）、修 bind 的本地 `stat`（`group.ts:95-99`） | 16 |
| C4 会话与用量 | `session list/context/clear/compact/resume/stop/end-goal/stop-subagent/reminder`（collaboration.*）、`usage show/share`、`usage judge` | 10 |
| C5 记忆经 RPC | `memory *` 全部改走 `memory` RPC（今天直接读写文件，`memory.ts:20-28`，`origin` 透传）、新 `memory restore/promote/move/confirm/purge/undo/events`、`--dm` 范围、`memory branch-delete`（原子）、`--all` 列已归档。`memory seen/counts` 是纯界面已读状态，进白名单（SCOPE-1） | 15 |
| C6 设置补齐 | `settings get/set --host`（judge 默认、codexBin、fallbackCwd）、`settings act voice/admin add|remove/member add|remove|all/comment-instructions`、`settings models`、人类输出补 `view.skills/voice/administrators/members`、`schedule edit --new-topic/--follow` | 12 |
| C7 环境与 Provider | `env scan`、`env install/update/uninstall <codex|claude|lark-cli>`、`env backend install/uninstall/version/check <id>`、`env login lark-cli`（lark-cli 的授权确实叫登录，保留这个词）、`env profile list/use/add/init [--status/--cancel]`（PARITY-1：`profileInitStatus/profileInitCancel`）、`env cancel`、`provider models` | 15 |
| C8 机器与诊断 | `mcp list/add/remove`、`import detect/preflight/start/status/rollback`、`service skip`、`daemon logs --follow`（admin.followLogs，今天读文件）、`daemon status` 经 RPC（dataPath、distribution、crashes）、`refresh`、`context show`、`secrets test`、`now`（活动、关注）、`snapshot --json`（PARITY-1：Shell 行"Load app state"）。**`update` 只在 I3**，这里不重复（SLICE-1） | 21 |
| | 合计 | 98 |

### 8.3 绕过 daemon 的命令怎么办

| 命令 | 今天 | 定法 |
|---|---|---|
| `memory *`、`project list`、`daemon logs`、`daemon status`（崩溃、发行）、`group bind` 的 `--folder` stat | 直接读写本机文件（`server-and-cli.md` 表 2） | daemon 在跑就走 RPC；`project list`、`memory list/export`、`daemon status` 在 daemon 没跑时保留只读的本地回退并在输出里标 `source: 'files'` |
| `secrets list/set/remove` | 已是"有 daemon 走 RPC" | 不变 |
| `remote enable/disable/status`、`pair`、`clients *`、`device rename` | 新 | **daemon 在跑就走 loopback owner 的 `device.*` RPC**（撤销要立即断连、开关地址要运行中生效、邀请只在 daemon 内存里，CLI-1：第 1 版写"只能本地（文件锁）"和 4.2、4.3 冲突，也违反"daemon 是唯一写入者"）；daemon 没跑时 `remote`、`clients ls/rename/revoke`、`device rename` 在数据租约下直接写文件，`pair` exit 3 要求 daemon 在跑 |
| `daemon run/start/stop/restart`、`service install/uninstall`、`open`、`bot repair-dir`、`secrets get`（隐藏）、`update`（daemon 没跑时）、`hook`、内部命令 | 本地 | 只能本地（信任根、文件锁、服务管理器）；**会话里（`inBotSession()`）一律 exit 4**（5.3），`secrets get` 除外：它是 lark-cli 的凭据入口，会话里放行（5.3） |

### 8.4 死的和只一边有的

- **协议里声明、daemon 回 unsupported 的 kind**（`command.openEventSettings/openJobAuthorization/copyJobAuthorization`、`settings.chooseExecutable/saveExecutable`、`collaboration.openGroup`、`environment.openVerification`、`machine.repairCli/checkDesktopUpdate/openReleases/installDesktopUpdate`）：**删**，趁 `PROTOCOL_VERSION` 升 2。**`machine.startHost` 和 `machine.service start|stop` 不删**（REQ-1、SLICE-1：daemon 对它们回 unsupported，但桌面端外壳的 IPC 用同一个 `machineRequestSchema` 解析这几个请求，`DT/bridge.ts:251-256,282-292`、`facade.ts:233-236`，界面上的"启动 daemon""仅运行此 Bot""启动服务"都靠它，`MachinePanel.tsx:71,82,92`）。D1 把这几个形状挪进 `DT/ipc-contract.ts` 自己的 schema（`desktopShellRequestSchema`），桌面端 IPC 不再 import `machineRequestSchema`，然后才从协议里删 `repairCli` 等；`startHost`、`service start|stop` 留在协议里给本机外壳用，白名单标 desktop-only。D1 验收加：本机"启动 daemon""启动服务"仍可用。
- **死 UI**：`AgentProfileSettings`（导出未挂载）删；**旧的 `command.installCodex/startCodexLogin` 任务面板和这两个 kind**（vonvon 不发起登录，3.1 2026-10-28；界面早已不显示，`EnvironmentPanel.tsx:29` 不解构 `codexJobs`）删——**托管安装不动**（走 `environment.install tool:'codex'`，`useProviderSetup.ts:139`），远程照样能用（REQ-1：第 1 版"删 Codex 安装/登录面板"的说法容易被读成删托管安装）。这两处删除归 **U2**。`MigrationBanner` 文案和行 E 另开小 PR（第 1 节）。
- **只有 CLI 的**保留并进白名单：`feishu members`、`open`、`daemon run`、`service install`、`bot repair-dir`、`secrets get`，以及 Bot 级 `profile/cards/completion/paths/judge`、项目级 `profile/model/speed`、`run.pendingPolicy` 这些没界面的设置段（不加 UI）。
- **只有 UI 的**（client-only、desktop-ipc）：导航、搜索、原生对话框、托盘退出、`memory seen/counts`、`MigrationBanner` 的聚合（client-only，原因：N×RPC 的汇总和 localStorage 里的已读）、`startHost`/`service start|stop`（desktop-only），白名单每条带原因。

### 8.5 对齐测试

`packages/daemon/test/cli-parity.test.ts`：从 protocol 的 zod 判别联合枚举出全部 `method.type`（含 `settings.act` 的子 action 和 `schedule` 的 action）；每个 CLI 子命令在注册时声明 `covers: ['command.setAgentEnabled', …]`（`cli/index.ts` 的 `.command()` 包一层记录）；断言：每个 kind 要么被某条命令 `covers`，要么在 `CLI_PARITY_ALLOWLIST`（`D/cli/parity-allowlist.ts`，每条带原因：client-only / desktop-only / internal）。反向：`covers` 里有协议没有的 kind 也失败。这样以后加 RPC 忘了加命令，CI 就红。

## 9. 内置 Skill

**2026-11-02 作废（第 20 节）**：K1 照本节加的飞书 skill、设置 skill 和三个 skill 共用的开头都撤掉了，任务 skill 回到 K1 之前；下面是原来的打算。

只改三个（命令行一节）：`D/agent/builtin-skills/{feishu,settings,scheduled-tasks}.ts`。
- 工具优先：有进程内工具（Claude MCP、Codex dynamicTools）就用工具；只有完全访问档、工具不可用时才用 `vonvon` 命令行，而且**每次都带 `--scope bot=<appId>[,group=<chatId>]` 和 `--json`**，范围值从 `session_info` 工具的输出里取，不自己猜。缺 `--scope` 会被拒绝（exit 4），skill 里写明。
- 飞书 skill：`feishu groups/members`、新的 `group show`、`session list` 只读查询的用法和 `--json` 形状；群里只查得到本群（和工具一样）。lark-cli 的飞书操作照旧，不归 vonvon 管。
- 设置 skill（只装私聊，3.7 照旧）：改成新命令名（`settings act …`、`group set`、`project workspace`），写明"只有主人或管理员发起的这一轮能改本 bot 和它的群，加管理员只有主人那一轮，和工具一样"（3.7），不教 `secrets`、`remote`、`pair`、`update`、`service`、`daemon`。**改完在回复里说清改了哪个范围、改前 → 改后、什么时候生效**（3.7 的回执卡和［撤销］推迟，第 14 节；这一批靠 bot 的回复交代）。
- 任务 skill：命令名不变，加 `--scope` 和 `schedule edit --new-topic/--follow`。
- 每个 skill 开头几行写清：命令行只是工具的备用，规则和工具完全一样；**群里不改任何设置**，群里有人要改设置就回"设置只能在私聊里改。请对方去私聊里跟我说。"（`not-dm` 那句），不去试命令行；群里能用命令行做的只有任务、记忆和只读查询；把范围写错会被服务端拒绝，不要重试更大的范围；运维命令（重启、升级、开远程、配对）在会话里一律被拒，不要替用户跑，也不要去读 vonvon 数据目录里的凭据文件。

## 10. 说明文档（官网）

仓库 modelzen/vonvon-site。**第 1 版看的是过时的本地 worktree（`claude/bot-site-v3` 2b3b3e8），`origin/main`（0b7bd42）已经是 `site/` 结构**（REQ-4）：官网域名 vonvon.cc，bot.vonvon.cc 整站 301 到它；`site/scripts/deploy-config.mjs` 的 `HOST_SCOPED_PATHS` 把 `/docs/` 划给 bridge.vonvon.cc，`LEGACY_PATH_REDIRECTS` 把 `/docs` 301 到 `https://bridge.vonvon.cc/docs/`。所以第 1 版的 `https://vonvon.cc/docs/remote/` 会跳到 bridge 的文档站。W1 按 `origin/main` 重做：路径用 **`/guide/remote/`**（2026-11-03 owner 改：旧的 bridge 文档移除，Bot 文档改放 **`/docs/`**，远程连接是 `/docs/remote/`，`/guide/` 不保留）（不和 bridge 的 `/docs/` 冲突；`HOST_SCOPED_PATHS` 加 `['/guide/', BOT_DOMAIN]`），样式照 `site/` 里现有页面，怎么进构建由实现者看 `site/` 的构建脚本定。Linux 的安装脚本和 CLI 打印的 URL 用 **`https://vonvon.cc/guide/remote/`**（0.9.1 起是 `https://vonvon.cc/docs/remote/`），W1 定稿前脚本先写这个值，W1 改了路径再一起改。W1 验收加：在 vonvon.cc 和 bot.vonvon.cc 上打开这个 URL 都能到这页。**发布官网要 owner 点头**，PR 开好等确认。

提纲：
1. 这是什么：一台设备上的 Vonvon Bot，用别的电脑上的 Vonvon Bot 桌面端来管。什么时候需要（服务器上 24 小时跑、代码在服务器上、几台电脑、团队共用）。
2. 装：**Mac、Windows 下载桌面端安装包**（https://vonvon.cc/get/），它自带服务端，装好打开就是一台能被连的设备，不用命令行；**Linux 一行命令只装服务端**（`curl … | sh`），装完 `vonvon --version`；在 Mac 上跑这条命令只会提示去下载安装包（owner 2026-11-01）。Linux 一段写：~~不要用 root 装~~（2026-11-03 去掉：root 照装，不提示）；只支持 glibc 发行版（Alpine 等 musl 不支持）；首次安装的信任根是 HTTPS 和 dl.vonvon.cc；装完会自动开 linger，退出登录也照常跑。**Mac、Windows 当设备要保持这个用户登录着**（可以锁屏；重启后要有人登录一次）：Mac 打开"登录时启动"；Windows 这一批不做登录自启，要 Vonvon Bot 开着。
3. 让它能被连上：先把两台设备放进同一个安全网络——推荐 Tailscale（装、登录、`tailscale ip -4`；大陆用户可能延迟高，也可以用局域网）；然后 Linux 上 运行 `vonvon remote enable` 从列出的地址里选一个（脚本里 `vonvon remote enable <ip>`，Tailscale 用户可以写 `vonvon remote enable "$(tailscale ip -4)"`；蒲公英、ZeroTier、EasyTier 这类组网工具选它的虚拟地址；只能开一个，再开一个就换掉原来的，已配对的设备粘一次新链接更新地址），Mac、Windows 在桌面端设置 →"设备"页 →"允许别的设备连接"里选一个地址（2026-11-03 从"应用与启动"移过来，0.9.0 还在"应用与启动"）；公网地址的风险和为什么不建议；100.x 地址不一定是 Tailscale（运营商 CGNAT）。
4. 配对：Linux 上 `vonvon pair` 拿链接，Mac、Windows 在桌面端点"生成连接链接"；客户端设置 → 设备 → 添加 → 粘贴 → 起名；链接 10 分钟有效、只用一次；一台客户端一条；链接会进你的 Agent 的对话记录；配对成功后被连的那台会提示，不是你就撤销。
5. 切换和日常：切换设备、"在 <设备> 上把 Codex 配置好"是什么意思、选目录选的是那台设备的、托管安装装在那台设备上。
6. 撤销和改名：在被连的那台设备上（桌面端"允许别的设备连接"或 `vonvon clients ls/revoke`）；授权不会过期，不用的客户端要自己撤销；一台客户端电脑上装了完全访问档的 Bot，它配对过的设备都在同一个信任范围里；完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。
7. 升级：客户端里一键、`vonvon update`、版本对不上的提示；桌面端自带的服务端也能从别的设备一键更新，前提是那台电脑上的 Vonvon Bot 桌面端开着（它会下载，再重启，正在进行的对话会被中断，owner 2026-11-02）；0.8 及更早的要先在那台电脑上更新一次。
8. 连不上怎么办：按地址类型（Tailscale：`tailscale ping`、都登录了吗；局域网：同一网段、防火墙、换了网络要重新确认；公网：端口）；"设备身份变了"的含义（重装、换了数据目录）→ 重新配对。
9. 命令速查：`remote`（含 `remote port <n>`：默认 7767，撞了就换）、`pair`、`clients`、`device`、`update`、`service`，每条一行。

## 11. `docs/product.md` 要改的节

本表是 D0 当时（2026-10-31）的改法，已经合入。2026-11-01 owner 定命令行只装服务端、只在 Linux 上做，`product.md` 第 1 节、3.1、3.10、3.14、第 7 到 10 节又按第 19 节改了一次（第 11 节记了这次的问答）；下表里"Mac、Windows、Linux 都可以只装服务端""Windows 服务端的登录启动用计划任务""`install.sh/.ps1`""Windows 计划任务"这些说法以第 19 节为准。

| 节 | 改什么 |
|---|---|
| 1 一句话、不给谁用 | "Linux 只有命令行版"保留；加"Mac、Windows、Linux 都可以只装服务端（一条命令），用别的设备上的桌面端连过来管"；"想要云端托管"仍不给，但"自己有服务器"的给 |
| 3.1 第 1 条 | "daemon 只监听 127.0.0.1、第一版不开放远程"改成：默认只监听本机；用户开启的地址上接受已配对客户端，加密通道，见新的 3.14 |
| 3.1 第 3、5、10 条 | 后台服务三平台；建 bot 在任何连着的客户端里都行；"没有 Windows"已被 2026-10-28 的说明覆盖，这里统一改成"Windows 有桌面端和服务端；服务端的登录启动用计划任务（本设计）"。Windows 桌面端这一批不注册 `vonvon`、不做登录自启（owner 2026-10-31 确认） |
| 3.7 | 补"在哪能改设置"三层（第 5 节开头的表，owner 2026-10-31）：vonvon 会话以外全部能改；私聊会话主人或管理员那一轮能改本 bot 和它所有群，加管理员只有主人那一轮，开关照旧；**群会话不改任何设置，工具和命令行都一样**，群里能做的是任务、记忆、只读查询、lark-cli 的飞书操作，拒绝文字用 `not-dm` 那句。补"会话里的命令行和工具同一套规则：`--scope`、会话令牌、daemon 把 ★ 请求交给 Bot 进程按这一轮核对"一段，能改/不能改表不变。回执卡和［撤销］那几条标"还没做，推迟（owner 2026-10-31），这一批 bot 在回复里说改前 → 改后"，并挪进第 10 节。补"完全访问档的 Bot 等于本机 owner，也等于这台电脑配对过的所有设备的 owner；完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置" |
| 3.8 权限 | "默认值不变"一条后加：凡是给群选完全访问的地方（群设置的执行权限、建群和拉进新群的对话框、私聊里改权限档和建群的回复、`group create`/`settings set` 的输出）都带一句"完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。"（U2） |
| 3.10 | 加 Windows 一段（计划任务 + 监督进程、0/75 规则、启动器和 `current.txt`）；"Linux 上只装后台服务"改成三平台"只装服务端"的步骤（脚本、`service install`、自动开 linger、不打印链接、看官网说明、不用 root、Linux 只支持 glibc）；**加"Mac、Windows 当服务端要有用户登录着（可以锁屏），重启后要有人登录一次；Linux 开 linger 后不需要"**；"要补的"里 ssh -L 那条删掉（`open --print` 保留但不再是主路径；`local-credential` 每次启动轮换）；加共存规则（7.4） |
| 3.11 | 补"远程时 Provider 配置在服务端所在设备上做；文案不说登录" |
| 新 3.14 远程连接和多设备 | 设备、配对（链接 10 分钟、一次性）、授权（不过期、只能手动撤销）、撤销、切换、远程选目录不限家目录、升级（含桌面端自带的服务端：那台桌面端开着时远程更新）、版本提示、端口 7767 和 `remote port`、不做的（账号、中继、浏览器远程、搬家、同事权限） |
| 7 第一版不做 | "云端账号和远程中继"保留；加"浏览器远程连接（和账号一起）""Bot 搬家""按同事分权限""关注点（非当前设备的状态点）""设置回执卡和［撤销］（推迟）""Windows 桌面端注册 `vonvon` 和登录自启""musl Linux" |
| 8 发布条件 | 三平台同版本 0.9.0；服务端包签名清单（含产品、通道、回滚保护）；`install.sh/.ps1` 在干净机器上走通；桌面端自带的服务端也压缩、无源码 |
| 9 要实测 | launchd 下 Claude 钥匙串；Windows 计划任务在锁屏/未登录时的行为；Tailscale 用户态网络模式下绑 100.x；Electron 44 下 `safeStorage` 在 Windows 的保护强度；远程触发的桌面端自更新在真实 Squirrel、NSIS 换包上的行为（0.9.0 之后第一个 0.9.x 上验，第 16 节） |
| 10 v1 之后 | 账号下设备自动出现、中继、浏览器远程、同事权限、bot 换 OS 用户跑、loopback 改 Unix socket / 挑战应答、关注点、设置回执卡和［撤销］、不用登录也能跑的 Windows 服务 / macOS LaunchDaemon |
| `docs/architecture.md` | "远程访问端到端加密"一节：从"连云端 + tweetnacl"改成"直连就加密、Noise_IK on node:crypto、中继以后复用"；"本机和远程走同一套协议"加维护子集；"在哪些系统上能跑"加服务端包；第 59-60 行 Windows "`.cmd` 循环"改成监督进程 + 启动器 |

## 12. 共享契约汇总

| 东西 | 名字 |
|---|---|
| protocol | `P/handshake.ts`：`PROTOCOL_VERSION = 2`，`helloSchema` **不变**，`serverInfoSchema` 分 v1/v2 两个（v2 加 `deviceName`、`platform`、`capabilities`、`principal`），客户端用非严格解析；`P/admin.ts`：`negotiate { capabilities, scope? }`、`daemonStatus` 加 `startedAt`、`distribution.kind` 加 `standalone`；`P/device.ts`：`pairingLinkSchema`、`scopeSchema`、`deviceRequestSchema`（`status / enable / disable / pair / clients / renameClient / revokeClient / rename`）、`deviceReplySchema`、`clientRecordSchema`（含 `invitedBy`、`revokedAt`）、`addressKindSchema`（加 `cgnat`）；`P/secure-channel.ts`：`createInitiator / createResponder / Frame`（Noise_IK_25519_AESGCM_SHA256）；`P/machine.ts`：`distribution.kind` 加 `standalone`，`coreUpdate` 回复加 `channel`、`desktopShell?`，新请求 `desktopUpdateReport { requestId, state, latest?, message, progress? }`、新事件 `desktopUpdateRequest { requestId, action: 'check' | 'apply', by }`（U4）；能力名 `update.standalone / update.npm / update.bundled`（daemon 报）、`desktop.self-update`（桌面端外壳在 `negotiate` 里报）；`P/domain.ts`：`registerAgent` 的 `jobRunning` 回复；`P/rpc.ts` 加 `device`；错误码加 `protocol_mismatch / permission_denied / scope_required / session_token_missing / not_in_session / not-dm（复用进程内工具的 reason 和文字）/ client_revoked / device_identity_changed / pairing_failed / rate_limited / desktop_not_running`；`MAINTENANCE_KINDS` 常量 |
| client | `CL/transport-browser.ts`、`transport-local.ts`：`connect()` 返回 `{ client, serverInfo }`，不读 `local-credential` 当 `inBotSession()`；新 `CL/transport-secure.ts`（通道上的 ws）；`CL/device-store.ts` 类型（存储由桌面端实现） |
| daemon | `D/server/authz.ts`（权限表 + ★ 转 Bot 进程）、`D/server/remote-listeners.ts`、`D/remote/{config,address,tailscale,pairing,clients,rate-limit}.ts`、`D/server/rpc/device.ts`、`D/host/session-tokens.ts`（host 侧令牌表 + IPC `issueSessionToken / revokeSessionToken / authorizeSessionCall`）、`D/agent/entry/registry.ts` 暴露 `authorizeSessionCall`、`D/server/snapshot-filter.ts`、`D/cli/commands/{remote,pair,clients,device,update}.ts`、`D/cli/parity-allowlist.ts`、`D/service/distribution.ts` 的 `standalone`、`D/service/update.ts` 的 `performStandaloneUpdate`、`D/config/read-scope.ts` 的 `ROOT_SECRETS` 加三个文件、`D/server/local-credential.ts` 每次启动轮换、`D/service/bundled-update.ts`（找本机外壳连接、发 `desktopUpdateRequest`、把 `desktopUpdateReport` 映射到 `coreUpdateStatus`，U4）、`D/agent/permission/types.ts` 的完全访问群警示（`TierInfo.warning`，U2） |
| 文件 | `<dataRoot>/device.json`、`clients.json`、`remote.json`（都 0600、都在 `ROOT_SECRETS`）；Linux 安装根 `releases/<v>/standalone.json`、`current`（symlink）、`bin/vonvon` |
| 桌面端 | `DT/device-registry.ts`（safeStorage，每设备一对密钥）、`DT/connections.ts`（多设备连接管理）、`ipc-contract.ts` 加 `desktopShellRequestSchema`（接管 `startHost`、`service`、`repairCli` 的形状）、`desktop:devices:*`、`desktop:client:device`；`client-context.tsx` 加 `activeDevice`、`isRemote`；`quit-daemon.ts` 按来历决定停不停（7.4，另外注册成后台服务、不是自带的不停）；`DT/remote-self-update.ts`（收 `desktopUpdateRequest`、驱动 `DesktopUpdater` / `WindowsDesktopUpdater`、回 `desktopUpdateReport`、远程触发时不弹本机确认框、给不拦人的提示，U4） |
| UI | `U/settings/DevicesPanel.tsx`（客户端侧）、`U/settings/RemoteAccessPanel.tsx`（被连侧）、`U/device-switcher.tsx`、`U/management/UpdatePanel.tsx` 改门控（`bundled` 的按钮和"要开着桌面端"归 U4）、6.4 列的"登录"文案、执行权限选完全访问时的群警示（`SettingsPanel.tsx:1058` 一带和建群/拉进新群对话框，U2） |
| 终端 | `vonvon remote enable [<ip>] [--allow-public] / candidates [--all] / disable [<ip>] / status / port <n>`、`vonvon pair [--ttl]`、`vonvon clients ls|rename|revoke [--cascade]`、`vonvon device rename <name>`、`vonvon update [--check] [--allow-downgrade --to <v>]`、全局 `--scope`、`--json`；第 8.2 节的新子命令 |
| CDN | `bot/server/<version>/vonvon-server-<version>-linux-{x64,arm64}.tar.gz`、`bot/server/<version>/manifest.json`（未签名文件表）、`bot/server/stable/manifest.json`（签名，含 product/channel）、`bot/server/install.sh`、`bot/server/uninstall.sh` |
| 脚本 | `scripts/build-server.mjs`、`scripts/publish-server.mjs`、`scripts/install.sh`、`scripts/uninstall.sh` |
| 诊断事件 | `remote-bind-waiting`、`remote-bind-failed`、`remote-network-changed`、`pairing-refused`、`client-paired`、`client-revoked`、`handshake-rejected`、`rate-limited`、`update-standalone-{downloaded,swapped,rolled-back}`、`update-bundled-{requested,no-desktop,reported}` |

## 13. 切片

集成分支 `claude/devices-integration`，从最新 `origin/dev` 开；每片 `claude/<片>` 从集成分支开、PR 回集成分支，不跑 CI；全部合入后一个 `frozen` 的集成 → `dev` PR 跑一次 CI（三平台，`ci:all`）；再 `dev → main`，三平台同一个版本发布（`AGENTS.md`"2026-10-30 起"）。每片 ≤1,500 行（不含 lockfile）。**owner 2026-10-31 定：每片的计划和实现都由 Claude 自己写**（先按 `docs/plans/README.md` 写 `docs/plans/<片>.md`，计划和代码同一个 PR），分支一律 `claude/<片>`；Codex 只做两件事：**独立审查**（JP-VPS Codex 审 Claude 的计划和 PR，不同模型；连接、加密、权限这类高风险片再加一轮 Claude 多角度审查）和**真机验收**（Mac mini Codex 有桌面界面和 Computer Use，做桌面端和 macOS 验收；Windows Codex 由 Claude 写任务、owner 转发）。额度用完就暂停，刷新后接着做，不转给 Codex 实现。下表"道"一栏保留原来的分组，只表示**哪类机器验收、按什么顺序做**：**A** = 协议、密码学、授权；**B1** = 命令行；**B2** = Linux 上能自测的服务端片；**C** = 要 Mac Codex 验收的桌面片；**D** = 要 Windows Codex 跑和验的片（2026-11-01 起只剩 U4 的 Windows 验证）。

审查后的变化（SLICE-1 ×2、SLICE-2）：U1、D4、I4 各拆成两片；D1 的撤销验收挪到 D3；K1 补上 C3、C4、C6 依赖；I2 的 ps1 部分依赖 I4a；`update` 只在 I3；C1 先于 D1、D3、I3 合入；I1、I3、I5 和 I2 的 sh 部分从 A 道挪到 B2（只在 Linux 上做、JP-VPS 能自测），A 道只留协议、密码学、授权和 skill 这些关键片加审查，不再占总量一半。

owner 确认后的变化（2026-10-31，第 18 节）：加 U4（桌面端自带的服务端远程升级，C 道 + D 道验证）；U2 加完全访问群警示和放开家目录限制（~1,300 → ~1,400）；D0、D4a、D4b、K1 按"群会话不写设置"的三层改内容和验收。

owner 2026-11-01 的变化（第 19 节）：Mac、Windows 只用安装包装全部软件，命令行只装服务端只在 Linux 上做。I4a、I4b 和 I2 的 `.ps1` 部分（I2b）取消，从表里拿掉，计划留作记录；I2 只剩 I2a（Linux 的 `install.sh`、`uninstall.sh`）；加 I6，在 I3、U2 合入后删掉 Mac、Windows 只装服务端留下的代码，I5 等它；U2 的桌面侧共存只剩退出一条（~1,400 → ~1,300），另接 I4a 里"win32 报平台名 `windows`"一项。

U1 计划后的变化（2026-11-01，`devices-ui-1a-connections.md`、`devices-ui-1b-devices-page.md`）：U1a、U1b 合成一个 PR `claude/devices-ui-1`，计划仍分两份、审查按模块分；协议不同时的维护视图从 U2 挪进 U1b（D4a 计划里写的"桌面端维护子集界面 → U2"以此为准）；U1a 加了"请求带上所属设备"（切换那一刻旧页面的请求不会落到新设备上）和"看远程时本机断线弹窗延后"。U1a ~1,100 → ~1,900，U1b ~1,000 → ~1,500，合计和 C 道各多约 1,300（合计约 26,650，C 道约 6,300）。D2 要补三处契约（`SecureConnection.closed`、`SecureChannelError.stage`、子路径导出），写在 D2 计划 4.2 末尾。

U2–U4 计划后的变化（2026-11-01，`devices-ui-2-remote-mode.md`、`devices-ui-3-served.md`、`devices-ui-4-bundled-update.md`）：三片仍各是一个 PR，不合并（U2 碰文案、删除和退出规则，U3 碰扫码任务的并发，U4 碰外壳更新和关闭顺序，审查重点不同）；U2、U3 的 Mac 验收可以合成一个 #322 任务，U2、U3 的 Windows 项并进 U4 的 Windows 任务（#631）。行数：U2 ~1,300 → ~1,700（daemon 里显示到页面的 Provider 文案设计没列、`ServerUpdateCard` 的抽取、退出规则的页面提示），按 `AGENTS.md`"硬限制"（2026-11-01）过 1,500 不拆，审查按 daemon+protocol、desktop、UI 三块分，另加一个读整个 diff 的；U3 ~1,000 → ~1,150（候选地址、Tailscale 命令的补丁）；U4 ~600 → ~1,150（看门狗、外壳身份的核对、启动收尾）。三片合计多约 1,100（合计约 27,750，C 道约 7,400）。和设计的出入：6.3 的 `jobRunning` 改用已有的 `refused`（U3 4.2）；6.4 的"登录"清单里 lark-cli 那几处保留（U2 4.2）；U2 行的"`createProject` 的回复带上警示"不做，新建的群一律是完全访问，命令行、网页建群对话框、私聊建群完成卡已经各自写了（U2 4.10）。U1 计划跟着补了三处：U1b 的维护视图用 U2 的 `ServerUpdateCard`；`shellForDevice` 远程时也去掉 U2 的 `quitKeepsDaemon`；bridge 远程的 `machine.service install/uninstall` 先 `expect('restart')` 再转给对面（U1a 做：`machine` 通道的外壳专属检查只在看本机时拦），本机视图里页面发的 `admin.negotiate` 不转发（U4 要在主连接上声明 `desktop.self-update`）。

| 片 | 做什么 | 依赖 | 道 | 约行数 | 验收一行 |
|---|---|---|---|---|---|
| D0 `devices-0-docs` | 本文进 `docs/plans/devices.md`；`product.md` 第 11 节的改动（3.7 按 owner 2026-10-31 的三层写，回执卡标推迟）；`architecture.md` | — | A | ~900（文档） | 两份文档改完、互相引用对；`product.md` 里不再有"群会话能改本群设置"的说法 |
| C1 `cli-1-conventions` | 全部命令 `--json`/退出码统一、`covers` 元数据、对齐测试 + 白名单（先登记 `device.*`、`negotiate`、`update`）、`bot add --json`、`--fresh`、`--all`、本地回退标 `source` | — | B1 | ~900 | 对齐测试跑红（故意删一条 covers）再跑绿；每条命令 `--json` 都是合法 JSON |
| D1 `devices-1-identity` | `device.json`、`clients.json`（代数、墓碑、`invitedBy`）、邀请、`local-credential` 轮换、`ROOT_SECRETS` 三文件 + 0600 测试、`P/device.ts`、serverInfo v1/v2、`negotiate`、`PROTOCOL_VERSION = 2`、`owner-verification` 放宽、`ipc-contract` 接管外壳形状再删死 kind、`authz.ts` 骨架（owner 全放、未知拒绝）、`vonvon pair/clients/device`（经 RPC）、`device.*` RPC、`client-paired` 事件 | C1 | A | ~1,300 | 本机 `vonvon pair --json`（非 TTY）出链接；0.8 bundled daemon 在跑时 0.9 CLI `daemon stop` 成功；读写档会话 `cat device.json` 被拒；本机"启动 daemon"按钮仍可用 |
| D2 `devices-2-secure-channel` | `P/secure-channel.ts`（Noise_IK on `node:crypto`、prologue、帧）、官方向量 + 坏实现互测、`CL/transport-secure.ts`、`unpaired` 状态和 `pairRequest` 绑定、关闭码表；另一个模型多角度审查 | D1 | A | ~1,000 | 官方向量通过；两个进程间配对 + 加密 RPC 往返；篡改一帧即断；换公钥报 `device_identity_changed`；未知公钥拿不到 serverInfo |
| D3 `devices-3-remote-listen` | `remote.json`、地址分类（含 `cgnat`）、Tailscale 网卡核对、`lan` 网络标识、额外监听和生命周期、Host/Origin 规则、`/health`、绑定重试、DH 前限流、`vonvon remote`、`device.enable/disable/status`、撤销断连 | D2 | A | ~1,200 | JP-VPS 开 100.x，Mac 上无通道探针被拒、带通道的客户端能连；`cgnat`/`public` 不带 `--allow-public` 拒；每秒几百条第一消息时 Bot IPC 不卡；`clients revoke` 后那条连接 1 秒内断；有待重试时排空能退出 |
| D4a `devices-4a-scope` | host 侧令牌表 + IPC、`VONVON_SESSION` 换令牌、CLI 不发凭据 / 没令牌即拒、`--scope` 经 `negotiate`（上限按会话）、host 能判的那部分权限表（含群令牌、评论令牌的设置写一律 `not-dm`）、`filterSnapshot`、维护子集 + `MAINTENANCE_KINDS`、`origin` 透传、8.3 本地命令在会话里拒、`schedule.ts:154`/`memory.ts:44` 改放行 | D1 | A | ~1,100 | 缺 `--scope` 拒 exit 4；只有 `FEISHU_CODEX_BRIDGE=1` 时拒不退回 owner；会话里 `daemon restart`、`update`、`remote enable`、`pair` 一律 exit 4；群令牌 `--scope bot=X` 拒、`bot=X,group=Y` 过（用 `schedule add`，它已走 RPC）；群令牌 `settings set`、`group create` exit 4、文字是 `not-dm` 那句 |
| D4b `devices-4b-bot-authz` | ★ 请求经 IPC `authorizeSessionCall` 到 Bot 进程跑 `authorizeNow/Memory/Schedule`、私聊只读查询的主人/管理员判定（同工具的 `ctx.admin`）、`adminMember` 的主人判定、`ScheduleActor` 加 `session`、`memory` 的角色透传、测试 | D4a | A | ~900 | 私聊成员那一轮 `settings set` 拒；开关关了拒；管理员那一轮 `act adminMember add` 拒、主人过；私聊主人那一轮改本 bot 另一个群的设置过；非管理员那一轮 `memory add --bot` 不进 bot 记忆；一轮结束后同令牌拒 |
| C2 `cli-2-bot` | 8.2 C2（9 条） | C1 | B1 | ~700 | `bot disable/enable` 后 `bot list --json` 状态变；`bot add` Ctrl-C 后任务已取消 |
| C3 `cli-3-groups` | 8.2 C3（16 条） | C1 | B1 | ~1,300 | `group create` 在 Bot 6 的测试群建群绑定；`group unbind` 回 `groupEffect` |
| C4 `cli-4-sessions` | 8.2 C4（10 条） | C1 | B1 | ~900 | `session context --json` 和界面一致；`usage share` 在测试群出卡 |
| C5 `cli-5-memory-rpc` | 8.2 C5（15 条） | C1、D4a（origin） | B1 | ~1,100 | `memory add` 经 RPC 后事件 actor 记 `cli`；daemon 停了 `memory list` 带 `source: files`；`memory list --all` 列已归档 |
| C6 `cli-6-settings` | 8.2 C6（12 条） | C1 | B1 | ~1,000 | `settings act admin add` 后 `settings get --json` 的 `administrators` 多一条 |
| C7 `cli-7-environment` | 8.2 C7（15 条） | C1 | B1 | ~1,300 | `env install lark-cli` 进度 JSON Lines 到 done；`env profile init --status` 和界面一致 |
| C8 `cli-8-machine` | 8.2 C8（21 条） | C1 | B1 | ~1,100 | `mcp add/remove` 改到 Codex 配置；`daemon logs --follow` 实时出行；`snapshot --json` 合法 |
| I1 `server-1-standalone`（已合入） | `standalone` 种类（三处 + 开放解析）、`standalone.json` 识别、`build-server.mjs`（minify、bundle、删 d.ts、`ui/dist`、`bin`、`package.json`、Node、按目标平台 hoist/compact、无 symlink、路径预算）、不解析 realpath、`bundledNpmCli` 认 standalone。六个包里 darwin、win 四个和 Windows 的那些检查 2026-11-01 起用不上，I6 删 | — | B2 | ~1,100 | 产出六个包；解开后 `node app/bin/vonvon.mjs --version` 对、`vonvon open --print` 的页面能开、`vonvon hook` 退 0；包里和桌面端 `Resources/daemon` 里都无 `.ts/.d.ts/.map/src`，`dist/cli.js` 已压缩；win 包无 symlink |
| I2 `server-2-install-scripts`（只剩 I2a `server-2a-install-sh`） | `install.sh`、`uninstall.sh`（只在 Linux；在 macOS 上打印去 https://vonvon.cc/get/ 下载安装包的话、退出非零、什么都不动）、受保护删法、命令和 PATH（同桌面端的块）、已装过检测（Linux）、root 拒绝、清单 sha512 + 可选 Ed25519、TLS/`main()`/版本格式/解包路径加固、linger `--json`、无 systemd / 用户实例不可用退路、脚本测试（Node 测试在 `mktemp -d` HOME 里跑 sh）。`.ps1`（I2b）取消 | I1 | B2 | ~1,150 | JP-VPS 干净用户 `curl \| sh` 后 `systemctl --user status` 运行中、linger 已开（或打印 sudo 提示且退出 0）；再跑一次说"已经装过了"；root 下拒绝；`HOME=` 空时 uninstall 拒绝；`uname` 不是 Linux（Darwin、FreeBSD、Git Bash）时两个脚本都第一步退出非零、什么都没写 |
| I3 `server-3-update-engine`（已拆成 I3a `server-3a-update-core` #632、I3b `server-3b-update-helper` #633，I3b 叠在 I3a 上） | 签名清单（product/channel/url/回滚保护；`files` 只有 Linux 两项，2026-11-01：I3a 已写的 `SERVER_TARGETS` 六项连同 `fake-cdn` 和测试在 I3 里改成两项，和 I2a 的脚本一致）、下载校验、先切 `current` 再 `requestRestart`、助手按版本判成功、回滚、`performStandaloneUpdate`、`vonvon update`（断线后读 `update-status.json`）、`checkCoreUpdate` 回复、排空白名单加 `coreUpdateStatus`、子进程钉 release、UI 门控（6.5） | I1、C1 | B2 | ~1,300 | 本地起假 CDN：从 v 到 v+1 升级，重启（2026-11-02 起中断进行中的对话），新进程版本是 v+1；旧版本的合法清单放到 stable 被拒；坏签名拒；起不来回滚；排空期间 `vonvon update` 一直显示进度 |
| I6 `server-6-linux-only`（已合入） | 删 Mac、Windows 只装服务端留下的代码（2026-11-01）：`build-server.mjs` 的 `TARGETS` 只留 `linux-x64`、`linux-arm64`，删 `unpackZip`/`writeZip` 和 `.zip`、Windows 的 Node 和 npm 布局、260 字符预算、大小写重名检查，`server-node.json` 只留两个；`bundledNpmCli` 的 Windows 布局；launchd 接受 `standalone` 的分支；I3 的 `current.txt` 分支和 `extractZip`；对应的测试。清单两项不等 I6：I2a 的脚本已经是两项，I3 自己改 `SERVER_TARGETS`；I3 万一按六项合入，I6 先改它，I5 产出第一份清单之前两边必须一致。I6 在 U2 之后合入：U2 的退出规则要读服务注册的种类（`DT/daemon-manager.ts` 的 `RegisteredDaemon.kind`），原来打算由 I6 删其中的 `standalone`，实现时留下了（Linux 的 systemd 单元解出来就是它，理由见 `server-6-linux-only.md` 第 4 节），两片没有碰同一处 | I2a、I3、U2 | B2 | ~400（多是删除） | `build-server.mjs` 只认两个目标；I3 自测第 2 步的端到端升级照旧过；服务端代码和脚本里搜不到 `current.txt`、`win-x64`、`darwin-arm64` |
| I5 `server-5-release` | `publish-server.mjs`、`release-publish.mjs` 的 server 项、CI 构建包 + 脚本冒烟、`ci-scope.mjs`、三平台同版本门（macOS、Windows 安装包和 Linux 服务端包） | I1、I2a、I3、I6 | B2 | ~900 | dry-run 列出两个包、构建摘要和清单；stable 不经 owner 不切 |
| U1a `devices-ui-1a-connections`（和 U1b 一个 PR `claude/devices-ui-1`） | `device-registry`（每设备一对密钥，私钥 safeStorage）、`remote-transport.ts`、`connections.ts` 多设备连接管理（切换、退避、撤销、添加、删除）、请求按设备路由并带上所属设备、`desktop:devices:*`、`client-context` 的 `useActiveDevice`、重连和 `serverInfo` 比较、本机断线弹窗在看远程时延后 | D1、D2（可先用桩）；真机验收要 D3 | C | ~1,900 | 探针：JP-VPS 上加设备、切换拿到对面快照、`clients revoke` 后 1 秒内 `revoked`、4006 后自动重连 |
| U1b `devices-ui-1b-devices-page`（和 U1a 一个 PR） | 设备页、添加/粘贴/配对、起名、切换标签、状态点、版本提示条（4.6）、协议不同时的维护视图（原写在 U2）、连不上整页说明和重连提示条、按分类的连不上提示、链接已用掉文案、Tailscale 建议 | U1a | C | ~1,500 | Mac 桌面端经 Tailscale 粘链接加 JP-VPS，切过去看到 Bot 6；撤销后 1 秒内变"已撤销"并给文案 |
| U2 `devices-ui-2-remote-mode` | 6.4 全表：隐藏/改造 IPC 功能、"登录"文案全部改掉并带设备名、目录浏览标题和 Windows 路径输入、放开 `directory-browser.ts` 的家目录限制、服务开关路由、7.4 桌面侧的退出规则（2026-11-01 起共存只剩这一条）、删 `AgentProfileSettings` 和旧 Codex 任务面板；**完全访问群警示**（`TierInfo.warning` 只在群的完全访问档上有值，执行权限选择、建群和拉进新群对话框、`settings_set`/`createProject` 的回复和 `group create`/`settings set` 的输出都带上，第 15 节）；**Windows 的平台名**（第 19 节，原是 I4a 的一项）：`D/server/snapshot.ts` 的平台判定在 win32 回 `windows`（今天回 `unsupported`），`P/domain.ts` 的 `application.platform` 加 `windows`，serverInfo v2 的 `platform` 同源（D1 的 schema 已有 `'windows'`）；只改平台名，`machine.status.service` 在 win32 照旧是不支持；另加（U2 计划）：daemon 里会显示到页面的 Provider"登录"提示一起改、`ServerUpdateCard`（远程时"<设备> 的服务端"，U1b 的维护视图也用它）、远程的"<设备> 的后台服务"组、本机协议不同时说清楚哪边旧（三种）和 Windows 的启动修复、serverInfo 报 `update.standalone`/`update.npm` | U1a、D1（协议）；I3（服务端卡上的更新按钮，没合入时卡上只有版本和检查） | C | ~1,700 | 远程时退出桌面端 JP-VPS 不停；本机是另外注册成后台服务的 npm 版 daemon 时退出桌面端不停它，桌面端自带的照旧停；Provider 文案带设备名、不含"登录"；远程目录浏览能进 `/srv`；给群选完全访问时看到警示，私聊里让 bot 把群改成完全访问，回复里也有这句；注入 `win32` 时 snapshot 和 serverInfo 的 `platform` 是 `windows`、服务状态仍是不支持（Windows 桌面端当被连的设备时对面认出是 Windows，D 道一起看） |
| U3 `devices-ui-3-served` | 6.2 "允许别的设备连接"面板（地址分类、`cgnat`/`public` 确认框、网络变了确认、关掉自己连着的地址先确认、设备名字）、生成链接、客户端列表（`invitedBy`、最近配对标记、自己那行不给撤销）、撤销（含 `--cascade`）、配对成功提示（挂在 `DesktopRoot`，看别的设备时也弹）、6.3 的扫码归属（回 `refused`、`code: 'job_running'`）和 60 秒宽限；另加（U3 计划）：`device.status` 的 `candidates`、`via` 和 `clients` 的 `self`（4.3），Mac、Windows 上 Tailscale 应用自带命令的位置（补 D3） | D1、D3；U1a、U1b（`onLocalDeviceEvent`、`DesktopRoot`、`TailscaleAdvice`） | C | ~1,150 | Mac 上开 Tailscale 地址（标"Tailscale（推荐）"）、生成链接，JP-VPS 的通道探针配对成功、出现在列表、Mac 弹出提示；探针带进来的第二台写"由「…」带进来"，级联撤销后两台都断；两个客户端同时扫码时后点的被拒、先点的二维码还在，断开 60 秒内回来续上 |
| U4 `devices-ui-4-bundled-update` | 7.5 末尾"桌面端自带的服务端远程升级"：`D/service/bundled-update.ts`（找本机声明了 `desktop.self-update` 的外壳连接、`desktopUpdateRequest` 事件、`machine.desktopUpdateReport` 和它的权限表行、映射到 `coreUpdateStatus`、`checkCoreUpdate` 带 `desktopShell`、`desktop_not_running`）、`DT/remote-self-update.ts`（在本机连接上订阅、驱动 `DesktopUpdater`/`WindowsDesktopUpdater` 的 check → 下载 → `quitAndInstall`、沿用 `beforeUpdateInstall` 的排空、远程触发不弹 Windows 本机确认框、托盘和窗口里给提示）、6.5 `update.bundled` 的按钮和"要开着桌面端"文案、对齐测试白名单、假更新驱动的测试 | D1（`negotiate`、权限表）、I3（`coreUpdateStatus`、6.5 门控、`vonvon update`）、U1a（外壳对本机的连接一直在）、U2（`ServerUpdateCard`）、U3（`peer-label.ts`、hub 的 `attached`，U3 先合入）；真机验收要 D3 | C（计划，macOS）+ D（Windows 验证） | ~1,150 | 假驱动测试里远程 `applyCoreUpdate` 走完检查 → 下载 → 排空 → `quitAndInstall`，四个看门狗各自收尾，外壳不在时回 `desktop_not_running`；真机上 Mac（C）和 Windows（D）用不签名的目录包当被更新的那台，从另一台已配对客户端点检查和更新，回到发起方的是那台更新器的原话（Mac 没签名，是"没有可用的签名更新源…"；Windows 的目录包构建时用 `VONVON_WINDOWS_UPDATE_CONFIG` 换上一把临时公钥，验不过真实的更新清单，是"检查桌面更新失败…"，不会下载）、托盘出提示、Windows 不弹本机确认框，退出桌面端后再点给"要在那台打开桌面端"；Windows 任务同时验 U2 的平台名和启动修复、U3 的 Windows 当被连的设备；真实换包在 0.9.0 之后第一个 0.9.x 上验（第 16 节） |
| K1 `skills-scope` | 第 9 节三个 skill（群里不改设置、拒绝时说 `not-dm` 那句；私聊改完说改前 → 改后）。2026-11-02 由 S1 `settings-dm-only` 撤掉（第 20 节） | C1、C3、C4、C6、D4b | A | ~500 | Bot 6 群里让 Claude 用命令行建任务，带 `--scope` 成功、改大范围被拒；让它"重启 vonvon"被拒并解释；群里让它改本群设置被拒、回"设置只能在私聊里改…"、不去试命令行；私聊里主人让它改某个群的设置成功，回复写清改前 → 改后 |
| W1 `site-remote-doc` | 第 10 节（vonvon-site 仓库 `origin/main` 的 `site/`，`/guide/remote/`（0.9.1 起 `/docs/remote/`），单独 PR，等 owner 点头发布） | 全部合入后定稿 | A | ~300 | 按文档从零在一台干净机器上连上；vonvon.cc 和 bot.vonvon.cc 上打开打印出的 URL 都到这页 |

**验收怎么跑**（验收与资源一节）：JP-VPS 当 Linux 服务端——在一个干净的测试用户下用 SSH 登录跑 `install.sh`（不用 `sudo -u`，免得没有 `XDG_RUNTIME_DIR`；不碰 `accept-home2` 和 Bot 6 的数据目录；要用验收 daemon 时按 #422 的目录锁 `mkdir /tmp/accept-user.d`），开 Tailscale 地址、`pair`。Mac mini 当远程客户端——Mac Codex 用桌面端粘链接配对、切换、在远程模式下走 6.4 的每一行、撤销后看断开；Mac 上跑 `install.sh`、`uninstall.sh` 只打印去下载桌面端安装包的话、退出非零、什么都不动；0.8 桌面端升到候选版本能停掉旧 daemon；U4 的 macOS 一侧（用 Mac 测试环境里的桌面端，不碰 owner 的 `/Applications/Vonvon Bot.app` 和 `~/.vonvon-bot`；桌面端开着时，从 Windows 桌面端或 JP-VPS 上的通道探针点升级这台 Mac，再退出桌面端点一次）。Windows 机器——Claude 把 Windows 的验证写成一份带开始/结果标记的提示词，owner 转发给 Windows 上的 Codex（2026-11-01 起 I4a、I4b、I2 `.ps1` 取消，只剩桌面端）：Windows 桌面端当被连的设备（在"允许别的设备连接"里开地址、生成链接、被 Mac 桌面端配对，桌面端开着、锁屏后 Bot 仍在线）；从 Mac 桌面端点升级这台 Windows 的桌面端自带服务端（开着、关着各一次，开着时不弹本机确认框）。三台机器都装同一个 0.9.0 候选版本号，验收通过的 SHA 记进集成 PR 描述；一次 CI 之后才 `dev → main`。

合计约 27,750 行、26 片（2026-11-01 U1–U4 写完计划后重算：U1 多 1,300，U2、U3、U4 多 1,100。代码约 26,550：A 道 6,000；B1 8,300；B2 4,850；C 7,400；D 0，只剩 U4 的 Windows 验证。在这之前 2026-11-01 重算为 25,350：去掉 I4a、I4b，I2 只剩 I2a，加 I6，U2 少 100。文档约 1,200：D0、W1，也在 A 道）。第 3 版原来是 27,200 行、27 片；第 2 版写的"26,400、A 道 7,000"是加错的（按表应为 26,500、A 道代码 6,000）。**并行道**：C1 立刻开（B1），I1 立刻开（B2）；A 的 D1 等 C1，然后 D1 → D2 → D3，D4a 叠在 D1 上、D4b 接 D4a；B1 的 C2–C7 在 C1 之后两两并行（测试环境按目录锁排队），C8 等 C1；B2 的 I1 → I3 → I6 → I5，I2a 在 I1 之后（I6 也等它，还等 C 道的 U2）；C 的 U1a 用 D1 的 protocol 和 D2 的客户端传输（桩）开工，U1b、U2 紧接，U3 等 D3，U4 等 I3 和 U1a（真机验收等 D3）；D 道只剩 U4 的 Windows 验证（含 Windows 桌面端当被连的设备），和 U4 一起发给 Windows。CI 一次：全部合入集成分支后，Claude merge 最新 `dev`、打 `frozen` + `ci:all`。

## 14. owner 已定（2026-10-31）

第 2 版这一节列的 12 条和设计后追问的群设置，owner 2026-10-31 都答了（`requirements.md`"设计后的 owner 回答"；群设置一条以本表为准：owner 最后定群会话不写设置，那里记的"群里能改本群设置、加护栏"的设想不采用）。下表是答案和落在哪；**没有还开着的产品问题**。

| # | 事 | owner 的回答 | 落在哪 |
|---|---|---|---|
| 1 | 这一批的版本号 | 0.9.0，macOS、Windows 和服务端包同号 | 7.1、7.6、I5、`product.md` 第 8 节 |
| 2 | 群会话改设置 | **不写任何设置**，经进程内工具、经 `vonvon` 命令行都一样；2026-11-02 起也不读（第 20 节）。群里能做：定时任务（3.13 的规则，现有 `schedule_*`）、记忆（只有主人/管理员亲手打的话进 Bot 记忆）、只读查询（`feishu_groups`、`feishu_members` 和只限本 bot/本群的只读命令）、lark-cli 的飞书操作（不经 vonvon）。拒：任何设置写（含权限档、会话方式、角色设定）、绑群和建群、密钥、升级/停服务/后台服务、配对/远程/设备命令；拒绝文字复用 `not-dm` 那句（`registry.ts:48`） | 第 5 节开头、5.2、5.3、第 9 节、D4a、K1 |
| 3 | 私聊会话改设置 | 能改本 bot 和它所有群的设置，只在主人或管理员触发的那一轮（现有 `authorizeNow`）；加管理员只有主人那一轮；"聊天改设置"开关照旧。不比 3.7 更严，也不更松 | 5.2、D4b |
| 4 | vonvon 会话以外 | 主人的终端、别的 Agent（Codex、Claude Code）、在那里调命令行的 Skill：全部能改（本机主人） | 第 5 节开头 |
| 5 | 会话里的命令行 | 和进程内工具完全同一套规则，堵上"群会话在 shell 里 `vonvon settings set` 以主人身份连上"的洞；保留 owner 要的 `--scope`：群会话带本群、私聊带本 bot，上限按会话算，参数只能缩小 | 5.3、D4a |
| 6 | 完全访问的残留风险 | 照实写：完全访问会话能读这个 OS 用户的任何文件，包括本机凭据，群成员可以诱导它以主人身份做事。默认不变（bot 自己建的群仍是完全访问）；凡是给群选完全访问的地方加一句"完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。" | 5.3、第 15 节、第 16 节第 2 条、`product.md` 3.7/3.8、U2 |
| 7 | 设置回执卡和［撤销］ | `product.md` 3.7 写了、代码没有（只有记忆能撤销）。**推迟，不进这一批，不做计划**；这一批 bot 在回复里说清改前 → 改后 | 第 9 节、第 11 节、K1 |
| 8 | 桌面端自带的服务端能不能远程升级 | 要：daemon 请那台的桌面端外壳跑它自己的应用更新（macOS Squirrel、Windows electron-updater NSIS），沿用现有停止（2026-11-02 起直接中断进行中的对话）；那台桌面端没开就明说要开着 | 6.5、7.5、U4 |
| 9 | Mac/Windows 当服务端要用户登录着 | 本期接受（可以锁屏），写进文档 | 7.4、第 10 节第 2 条、`product.md` 3.10 |
| 10 | 远程端口 | 7767。Paseo 默认 6767，Orca 移动端直连默认 6768（stablyai/orca `mobile/src/transport/host-endpoint.ts`），vonvon 的 loopback 端口随机，不冲突；撞了 `vonvon remote port <n>` 改 | 4.2 |
| 11 | 邀请 | 10 分钟、一次性 | 4.3 |
| 12 | 授权过期 | 不过期，只能手动撤销 | 4.3 |
| 13 | 远程选目录 | 不限家目录，该用户能读的都能选，本机和远程一样 | 6.4、U2 |
| 14 | root 安装 | 照装，不提示（owner 2026-11-03，和 Paseo、Orca 一样；原来默认拒绝，`VONVON_ALLOW_ROOT=1` 才放行） | 7.3、I2 |
| 15 | Linux libc | 只支持 glibc，musl/Alpine 脚本明说不支持 | 7.1、I2 |
| 16 | linger | 安装脚本能开就自动开，要 sudo 就打印命令，不问 | 7.3、I2 |
| 17 | 远程"停止 daemon" | 保留，带"只能在那台设备上重新启动"的确认，"重启"放前面 | 6.4、U2 |
| 18 | Windows 桌面端的 `vonvon` 命令和登录自启 | 这一批都不做 | 7.4、`product.md` 3.1 |
| 19 | Mac、Windows 上用命令行只装服务端（2026-11-01 追加） | 不做："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"。命令行只装服务端只在 Linux 上做；I2b、I4a、I4b 取消 | 第 19 节 |

Claude 按这些答案自己定的细节（不算新问题，PR 里能改）：群令牌的设置写在 host 就拒、不问 Bot 进程（5.2）；私聊会话的只读查询也要主人或管理员那一轮，和 `settings_get` 一样（5.2）；`removeProject`（解绑）在会话里一律拒，因为 3.7 的能改表里没有解绑（5.2）；群里被拒的事中，绑已有群、密钥、运维和设备命令私聊里也不能做，拒绝文字不用 `not-dm`（不叫人去私聊），只有设置写和建群用 `not-dm`（第 5 节开头）；云文档评论会话照进程内工具今天的判法，不写设置、没有任务和记忆（第 5 节开头）；远程触发桌面端自更新时不弹 Windows 本机的"安装并重启？"确认框，确认在发起的客户端上做，被更新的那台给不拦人的提示（7.5）。

## 15. 用户看得到的文字

| 哪里 | 文字 |
|---|---|
| `vonvon pair` 输出 | 把下面这条链接粘到另一台电脑的 Vonvon Bot → 设置 → 设备 → 添加。10 分钟内有效，只能用一次，别发给别人；如果是让 AI 替你运行的，它的对话记录里会留着这条链接。\n`vonvon://pair#…` |
| 没开远程时 `pair` | 这台设备还没允许别的设备连接。先在终端里运行 `vonvon remote enable`，选一个别的设备能连到的地址。 |
| daemon 没跑时 `pair` | 后台服务没在运行，连接链接要由它生成。先运行 `vonvon daemon start`。 |
| `remote enable` 成功 | 已在 100.x.y.z:7767 接受连接（Tailscale 地址）。只有配对过的客户端能连上，接下来运行 `vonvon pair` 生成连接链接。 |
| `remote enable` 在终端里、没给地址（A1） | 别的设备用哪个地址连这台设备？只能开一个，已经开着别的会被换掉。\n  1) Tailscale（推荐）· 100.x.y.z  tailscale0\n  2) 组网 · ZeroTier · 10.147.17.5  zt…\n  3) 局域网 · 192.168.1.23  wlan0\n  4) 公网 · 203.0.113.9（要确认）  eth0\n选一个 [1]: |
| `remote enable` 不在终端里、没给地址（A1，退出码 2） | 没给地址。别的设备能用这些地址连这台设备（只能开一个）：\n  Tailscale（推荐）· 100.x.y.z\n  局域网 · 192.168.1.23\n选一个运行，例如：vonvon remote enable 100.x.y.z |
| 换了地址（A1） | 已把远程地址从 192.168.1.23 换成 100.x.y.z，192.168.1.23 不再接受连接，经它的连接已断开。（有已配对的设备时再加）已配对的 N 台设备要换到新地址：运行 `vonvon pair` 生成连接链接，粘到那台电脑的 Vonvon Bot → 设置 → 设备 → 添加，只会更新地址，不用重新配对。 |
| 组网地址跑到了普通网卡上（A1） | 10.147.17.5 现在不在组网工具的网卡上了（可能是别的网络分到了同一个地址）。确认现在的网络是你信任的，再重新开启。 |
| Tailscale 提示（没找到能用的地址） | 推荐用 Tailscale 这类组网工具把两台设备连起来：两边都装上、登录同一个账号，再运行 `vonvon remote enable` 选它的地址。不用组网工具也可以：两台在同一个局域网里时，选局域网地址。 |
| 100.x 但不是 Tailscale | 100.x.y.z 不在 Tailscale 或别的组网工具的网卡上，可能是运营商分配的地址（CGNAT），开启后同一运营商的其他用户也可能连到这台设备。确定要开启请加 `--allow-public`。 |
| 公网地址警告（CLI 和桌面端） | 这是公网地址。开启后互联网上任何人都能尝试连接这台设备；虽然只有配对过的客户端能连上、内容加密，但你的服务端会直接暴露在扫描和攻击之下。建议改用 Tailscale 或局域网地址。确定要开启请加 `--allow-public`（桌面端：勾选"我了解风险"）。 |
| 局域网换了 | 这台设备所在的网络变了（之前在另一个局域网开启了 192.168.x.x）。确认现在的网络是你信任的，再重新开启。 |
| 客户端连不上（按分类） | tailscale：连不上 <设备>（100.x）。两台设备都登录了同一个 Tailscale 账号吗？在这台电脑上运行 `tailscale ping <那台的地址>` 看看。/ overlay：连不上 <设备>（10.x）。两台设备都连在同一个组网（ZeroTier、蒲公英这类工具）里吗？先在这台电脑上 ping 10.x 看看通不通。/ lan：连不上 <设备>（192.168.x）。两台设备在同一个局域网里吗？那台设备开着吗？/ cgnat：连不上 <设备>（100.x）。这是运营商分配的地址，一般从外面连不进去，建议两台都装上 Tailscale。/ public：连不上 <设备>（x.x.x.x）。那台设备的防火墙放行了 <端口> 端口吗？（2026-11-01 U1b：`tailscale ping` 改在这台电脑上对那台的地址跑，客户端知道对面的地址、不一定知道自己的；加 cgnat；客户端一侧的完整文案见 `devices-ui-1b-devices-page.md` 4.9） |
| 链接已被用掉 | 这条链接已经被用掉了。如果不是你用的，请马上到 <设备> 上撤销它：在那台设备的「允许别的设备连接」里，或者运行 `vonvon clients ls` 查看最近配对的设备、`vonvon clients revoke <id>` 撤销。然后生成一条新链接。（2026-11-01 U1b：客户端此时还没配上，看不到对面的客户端列表，所以不列"最近配对的"，改为指过去看） |
| 新客户端配对成功（被连的桌面端） | 新设备「X」（<类型>，来自 <地址>）已经配对，可以管理这台电脑的 Vonvon Bot。不是你操作的？到「允许别的设备连接」撤销。 |
| 设备身份变了 | <设备> 的身份和配对时不一样了（可能重装过，或换了数据目录）。为安全起见已断开。确认是你自己的设备后，重新配对。 |
| 被撤销 | <设备> 已取消这台电脑的访问。要再连，请在那台设备上重新生成连接链接。 |
| 在远程设备上配 Provider | 在 <设备> 上把 <Codex / Claude> 配置好（账号或自定义 API 都行），然后点「重新检测」。 |
| 查更新：清单签名不对（`refused: signature`） | 没查到新版本：发布清单的签名不对，没有应用 |
| 查更新：清单比上次看到的旧（`refused: rollback`） | 没查到新版本：发布清单比上次看到的旧，没有应用 |
| 查更新：连不上（`refused: network`） | 没查到新版本：连不上 dl.vonvon.cc |
| 版本不一致（服务端旧，协议相同） | <设备> 的服务端是 0.9.0，这台电脑是 0.9.1。可以继续用；建议升级服务端。[升级 <设备>] |
| 版本不一致（协议不同，服务端旧） | <设备> 的服务端是 0.8.0，这台电脑是 0.9.0，两边不能一起工作。升级服务端后才能继续管理。[升级 <设备>] |
| 版本不一致（协议不同，对面是 0.8 及更早的桌面端自带服务端） | <设备> 的服务端是桌面端自带的（0.8.0），要先在那台电脑上更新一次 Vonvon Bot；之后就能从这里更新。 |
| 远程更新桌面端自带的服务端（确认，发起的客户端） | 更新 <设备> 上的 Vonvon Bot？那台电脑上的桌面端会下载更新，再重启，正在进行的对话会被中断，期间这里会断开一会儿。[更新] |
| 那台桌面端没开（按钮旁 / `desktop_not_running`） | <设备> 的服务端是桌面端自带的，要那台电脑上的 Vonvon Bot 桌面端开着才能远程更新。在那台电脑上打开 Vonvon Bot 后再试，或者直接在那里更新。 |
| 远程更新进行中（发起的客户端） | 正在 <设备> 上下载桌面端更新（45%）… / 下载好了，正在重启（会中断正在进行的对话）/ <设备> 已更新到 0.9.1。 |
| 被远程更新的那台（托盘和窗口里的提示，不拦人） | 「<客户端名>」正在更新这台电脑上的 Vonvon Bot。下载好后会直接重启，正在进行的对话会被中断。 |
| 版本不一致（客户端旧） | 这台电脑的 Vonvon Bot（0.8.0）比 <设备>（0.9.0）旧。先更新这台电脑上的应用。 |
| 服务端太旧（v1） | <设备> 上的 Vonvon Bot（0.7.x）不支持远程管理，请在那台设备上升级一次。 |
| 安装脚本：开始 | 正在安装 Vonvon Bot 服务端 0.9.0（linux-x64）… |
| 安装脚本：已装过 | 这台机器已经装过 Vonvon Bot，不用再装。直接用：`vonvon --version`。 |
| 安装脚本：在 Mac 上（退出非零，什么都不动） | Mac 请下载安装包：https://vonvon.cc/get/ ，安装包里已经带了服务端和 vonvon 命令。这个脚本只用于 Linux，什么都没动。 |
| 安装脚本：不是 Linux、也不是 Mac（退出非零，什么都不动） | 这个安装脚本只支持 Linux（这台是 <`uname -s` 的结果>）。Mac、Windows 请下载 Vonvon Bot 桌面端安装包：https://vonvon.cc/get/ |
| 卸载脚本：在 Mac 上（退出非零，什么都不动） | 这个脚本只卸载 Linux 上的服务端。Mac 上的 Vonvon Bot 是桌面端安装包装的，说明见 https://vonvon.cc/get/ |
| 卸载脚本：不是 Linux、也不是 Mac（退出非零，什么都不动） | 这个脚本只卸载 Linux 上的服务端（这台是 <`uname -s` 的结果>），什么都没动。 |
| 安装脚本：完成（2026-11-02 改，不提 systemd、linger、sudo） | 装好了。Vonvon Bot 已在后台运行，开机自动启动。\n试一下：`vonvon --version`\n要从别的电脑连过来管理？看 https://vonvon.cc/docs/remote/ |
| 安装脚本：没验签名 | 这台机器没有 openssl 3，没能核对发布签名；已核对下载内容的哈希，来源是 https://dl.vonvon.cc。 |
| 安装脚本：开不了开机自动启动（少数系统，2026-11-02 改；替换"完成"的第一行） | 装好了。Vonvon Bot 已在后台运行。\n这台机器没让它开机自动启动，退出登录后它会停。需要的话运行一次：`sudo loginctl enable-linger <用户名>` |
| `vonvon service install` 装好（2026-11-02） | 已在后台运行，开机自动启动。（macOS："登录后自动启动"；装好但没在运行："后台服务已经装好，开机自动启动；现在没在运行，下次开机时启动。"） |
| `vonvon update`：开始重启前（文字模式，2026-11-02） | 升级会重启服务端，正在进行的对话会被中断，卡片上会请发消息的人再发一次。 |
| 被中断的那一轮（卡片最后一行，2026-11-02） | 服务端重启了，这一轮被中断，请再发一次 / 服务端升级了，这一轮被中断，请再发一次 / Bot 停止运行了，这一轮被中断，等它恢复后请再发一次（定时任务那一轮不带"请再发一次"） |
| 安装脚本：没有 systemd | 这台机器没有 systemd（可能是容器）。已改为直接启动，崩溃后不会自动重启；需要时运行 `vonvon daemon start`。 |
| 安装脚本：用户实例不可用 | 连不上这个账号的 systemd（用 sudo 切过来时常见）。已直接启动一次；用这个账号 SSH 登录后运行 `vonvon service install` 装成后台服务。 |
| 撤销确认（桌面端） | 取消「Clay 的 MacBook」的访问？它会立刻断开，要再连得重新配对。[同时撤销它带进来的 2 台] |
| 另一台正在扫码（`refused`、`job_running`，U3） | 另一台设备「<客户端名>」正在扫码添加 Bot，等它完成后再试。/ 本机的<桌面端/命令行/网页端/客户端>正在扫码添加 Bot，等它完成后再试（被拒的是另一台设备时写「<设备名>」上的<…>，U3 实现时改：远程页面不说"本机"）。/ 重新扫码时：…正在为一个 Bot 重新扫码，等它完成后再试。 |
| `--scope` 缺失 | 这次调用来自 Bot 会话，必须带 `--scope bot=<appId>[,group=<chatId>]`，而且不能比会话本身的范围大。 |
| `--scope` 超范围 | 范围超过了这条会话（只能是 bot=<X>, group=<Y>）。不要重试更大的范围。 |
| 会话里跑运维命令 | 这条命令（`vonvon daemon restart`）不能在 Bot 会话里运行。告诉用户去设备上或桌面端里做。 |
| 会话里没有令牌 | 这是 Bot 会话，但没有有效的会话令牌，不能以主人身份运行。 |
| 这一轮已结束 | 这次调用对应的那一轮对话已经结束，不能再改设置。 |
| 群会话里改设置（工具和命令行一样，`not-dm`，exit 4） | 群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。（owner 2026-11-02 定，`registry.ts` 的 `NOT_DM_MESSAGE`） |
| 给群选完全访问（执行权限选择、建群和拉进新群对话框、私聊里 bot 的回复、`group create`/`settings set` 的输出） | 完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。 |
| 私聊里改完设置（bot 的回复，不是固定文字；私聊会话以后做，第 20 节） | 已把「支付组」的权限从「工作区可写」改成「只读」，<生效时机，照工具回的写>。 |
| 远程停止确认 | 停止 <设备> 的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。 |
| 远程设备的后台服务（"应用与启动"页脚，U2） | 退出这台电脑上的 Vonvon Bot 不影响 <设备>。 |
| 退出桌面端不停另外装的后台服务（"应用与启动"页脚和确认框，U2） | 退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 `vonvon daemon stop`。 |
| 本机服务端协议不同（桌面端启动时，U2） | npm 版旧：这台电脑上另外装的 Vonvon Bot 服务端（npm 版）比桌面端旧。运行 `npm i -g vonvon-bot@latest` 再 `vonvon daemon restart`；或者 `vonvon service uninstall` 去掉它，让桌面端用自带的。/ 其他旧：正在运行的服务端比桌面端旧，没能自动换掉。退出 Vonvon Bot 再打开一次；还不行就运行 `vonvon daemon stop` 后再打开。/ 服务端新：正在运行的服务端比这个桌面端新。到 https://vonvon.cc/get/ 下载最新的 Vonvon Bot。 |
| 关掉当前连着的地址（确认，U3） | 你现在就是通过这个地址连着 <设备> 的。关掉后这台电脑会马上断开，要到那台设备上重新开启。 |
| 改端口（面板里的说明，U3） | 要改端口，在终端运行 `vonvon remote port <端口>`；改完已配对的设备要粘一次新链接。（远程时"在「X」的终端运行"；A1 之后换地址、换端口都只要粘新链接，不用重新配对，U3 实现时改） |
| 远程更新失败（发起的客户端，U4） | 那台电脑上的 Vonvon Bot 没有回应更新请求。/ 下载桌面端更新超时。/ 那台电脑上的 Vonvon Bot 在更新完成前关掉了。/ 桌面端重启后没有换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。 |
| 被远程更新的那台，本机点安装（U4） | 正在按另一台设备的请求更新，下载好后会自动安装并重启。 |
| 远程检查没回应（发起的客户端，U4） | 那台电脑上的 Vonvon Bot 没有回应，稍后再试。 |
| 桌面端重开了但没换上（发起的客户端，U4） | 桌面端重新打开了，但服务端还是 <version>，没能换上新版本。在那台电脑上退出 Vonvon Bot 再打开一次。 |
| 上一次更新还没完（U4） | 上一次更新还在重启，稍后再试。/ 已有更新正在进行。 |
| 被更新的那台正在退出（U4） | 那台电脑上的 Vonvon Bot 正在退出。 |
| 被更新的那台排空超时（U4；2026-11-02 起停止最多 30 秒，正常到不了这一步） | 那台电脑上的后台 1 分钟内没停完，这次没有安装更新。稍后再试。 |
| 别的连接报告更新进度（`forbidden`，U4） | 只有这台电脑上的桌面端能报告更新进度。 |
| 远程更新的状态行（U4） | 在 <设备> 上 <`coreStatusLine` 的原文> |
| 排空中不收的请求（错误码 `draining`，4.7，D3 复查 248） | daemon 正在停止或重启（比如在升级），这个请求没有处理。等它重新启动后再试。 |

## 16. 风险

1. **自己接 Noise**：套件是标准的、原语是 `node:crypto` 的，但状态机（转录哈希、密钥派生顺序、prologue）仍是自己写。缓解：官方向量、坏实现互测、另一个模型的多角度审查、不处理握手完成前的任何帧、`unpaired` 状态只收一帧。
2. **完全访问档的 bot 就是 owner**（5.3）：它能读这个 OS 用户的任何文件，包括本机凭据，所以**完全访问的群里，群成员可以诱导 bot 以主人身份做事，包括改 vonvon 的设置**——"群会话不写设置"在完全访问的群里挡的是照规矩办事的 agent，挡不住被诱导去读凭据文件的 agent。一台客户端电脑上的 bot 还等于它配对过的所有设备的 owner（Windows 的 `safeStorage` 同用户进程可解，未在 Electron 44 实测）。令牌和范围参数只防失误和一般越权。owner 2026-10-31 定：默认不变（bot 自己建的群仍是完全访问），给群选完全访问的每个地方都带第 15 节那句警示（U2），写进 `product.md` 3.7、3.8 和官网文档，不夸大也不淡化。彻底挡要 bot 换 OS 用户跑，进"v1 之后"。
3. **loopback 仍是 TCP**：多用户机器上别的账号能在 daemon 重启空档抢端口。凭据每次启动轮换把损失限制在"那一次重启失败"；Unix socket / 挑战应答留到以后。文档写明"团队共用的服务器上，每个人用自己的账号装"。
4. **Windows 当设备**：原来这里是 Windows 计划任务、`irm | iex`、启动器 `.cmd` 的风险，随 I4a、I4b、I2b 取消（owner 2026-11-01）。剩下的是 Windows 桌面端开着、锁屏或快速切换用户时 Bot 是不是一直在线（"要有用户登录着、可以锁屏"是 owner 接受的限制，7.4），在 U4 的 Windows 验收里顺带看。
5. **Tailscale 用户态网络模式**（容器、NAS）没有 100.x 网卡，绑不上；`tailscale ip` 能拿到地址但网卡核对不过。文档让用户用局域网地址或宿主机。
6. **launchd 下 Claude 的钥匙串**（`login.ts:36-45`）：Mac 桌面端的"登录时启动"今天就是 LaunchAgent，Mac 当设备时一样；文档说明。原来"只 SSH 的 Mac 装不了 LaunchAgent、脚本退回直接启动"一条随 2026-11-01 的决定不要了。
7. **CLI 98 条缺口的工期**：7 片 B1 道，每片一个 Codex 会话，测试环境是瓶颈；靠 `--json` 的单元测试多、真飞书只验几条。
8. **协议升到 2**：hello 不变、serverInfo 分形状、owner-verification 放宽后，旧桌面端连新 daemon 和新桌面端停旧 daemon 都有回归测试；但 0.7.x 的桌面端对新 daemon 仍会在界面上报协议不一致（它自己硬比版本），只能靠"桌面端先更新"。
9. **安装根和桌面端同一个 `vonvon` 路径**：2026-11-01 起不会发生（Linux 没有桌面端，Mac、Windows 没有脚本装的服务端），这一条作废。
10. **公网直连**：用户确认后仍可能被扫。DH 前限流、加密、`/health` 不回身份，但不做入侵检测；文档明说不建议。
11. **升级的回滚窗口**：先切 `current` 再重启，新版本起不来时助手切回旧版再让管理器拉起；最坏是服务停 5-10 秒。
12. **多客户端的扫码**：一台在扫时别的只能等；60 秒宽限内断线的客户端重连能续上，不做接管。
13. **安装脚本写入用户 shell rc**：和桌面端一样加一块；用户用 fish 等别的 shell 时只提示不写（未核实 fish 用户比例）。
14. **100.64/10 的判定依赖 `tailscale` 命令或网卡名**：macOS 上 Tailscale 的网卡是 `utun*`，只能靠 `tailscale ip` 核对；没装 `tailscale` 命令的 macOS 100.x 会被归成 `cgnat` 要求确认，这是保守的一面。
15. **远程触发桌面端自更新（U4）的真实换包这一批验不全**：Squirrel、NSIS 只认已签名、已发布的更新源（macOS 的 `update-config.json` 打在包里，Windows 的源和公钥写死），0.9.0 发布前没有更新的版本可换；这一批靠假更新驱动的测试和"走到外壳、回进度"的真机检查，真实换包在 0.9.0 之后第一个 0.9.x 上验（写进 `product.md` 第 9 节）。远程一点，那台电脑上的桌面端会重启、窗口会关；Windows 不再弹本机确认框，靠托盘和窗口提示说明是谁在更新。
16. **设置回执卡和［撤销］推迟**：`product.md` 3.7 写的回执卡这一批不做，私聊里改错了只能再说一遍改回去，或到桌面端改；诱导出来的修改靠 bot 回复里的"改前 → 改后"让人看出来，没有回执卡上"由谁的哪条消息触发"那两行。

## 17. 审查后改了什么

三位审查者（安全 16 条、可行性 16 条、需求 13 条，共 45 条），接受 44 条、部分接受 1 条、驳回 0 条。多条审查者从不同角度指出同一件事的，合并处理。本节是第 2 版的记录，表里说的"第 14 节第 N 条""待 owner 确认""待定"指第 2 版的待确认清单；owner 的答案见现在的第 14 节：REQ-7（群设置）owner 定的和第 2 版建议的 B 同向，而且更彻底（群会话一律不写设置，经工具、经命令行都一样）；REQ-9（bundled 远程升级）第 2 版建议不支持，owner 定要做（U4）。改了什么见第 18 节。

| 编号 | 结论 | 一句话 |
|---|---|---|
| SEC-1 | 接受 | ★ 请求经 IPC 到 Bot 进程跑 `authorizeNow/Memory/Schedule`，`adminMember` 要主人那一轮，轮结束即拒（5.2、5.3、D4b） |
| SEC-2 | 接受 | 会话里 CLI 不读、不发 `local-credential`；loopback 上 `vs1.` 前缀即 bot-session；8.3 本地写类命令在会话里 exit 4（5.3） |
| SEC-3 | 接受 | `device.json`、`clients.json`、`remote.json` 进 `ROOT_SECRETS`，加 0600 文件必在名单的测试（4.1） |
| SEC-4 | 接受 | `local-credential` 每次启动轮换；4.4 那句改掉；Unix socket / 挑战应答进风险和"v1 之后"（4.1、4.4、16.3） |
| SEC-5 | 接受 | 改 `Noise_IK_25519_AESGCM_SHA256` on `node:crypto`，prologue + 版本字节，官方向量；tweetnacl 不引入（4.4） |
| SEC-6 | 接受 | 加 `unpaired` 主体；只登记通道里认证过的公钥；统一关闭码表；带有效邀请的握手不计未知公钥；本机/远程只看接入的 server（3、4.3、4.7、5.1） |
| SEC-7 | 接受 | DH 前限流：每 IP/全局未认证连接数、令牌桶、`handshake_failed` 计数、maxPayload 4 KB、3 秒超时（4.3） |
| SEC-8 | 接受 | 100.64/10 要在 Tailscale 网卡上或 `tailscale ip` 里才算 tailscale，否则 `cgnat` 要确认；`lan` 记网卡和网关 MAC，网络变了不自动重绑（4.2） |
| SEC-9 | 接受 | 签名内容加 product/channel/schemaVersion/url 校验，照 Windows 的 validate；只接受比历史最高新的版本，`publishedAt` 不倒退；单独密钥；`--allow-downgrade` 显式（7.5） |
| SEC-10 | 接受 | Windows 不用联接，用 `current.txt` + 固定启动器；监督进程收到 75 看 `current.txt` 变了就 exec 新版本；被占用目录跳过（7.2、7.4） |
| SEC-11 | 部分接受 | 加 `client-paired` 事件、桌面端提示、链接已用掉的专门文案、`invitedBy` 和级联撤销；**不加** `--print-secret`（和 REQ-2 冲突，`pair --json` 必须让 AI 拿到链接，改为文案提醒会进 Agent 对话记录）；不经 bot 私聊通知 |
| SEC-12 | 接受 | 每台设备一对客户端密钥；信任范围写进 5.3、16.2、文档；列表显示最近地址 |
| SEC-13 | 接受 | 脚本 euid=0 照装、不提示，`daemon run`/`service install` 也不警告（owner 2026-11-03 改，原来默认拒绝并警告）；列第 14 节第 9 条 |
| SEC-14 | 接受 | 用签名清单的 sha512 不用 sidecar；可选 openssl 3 验 Ed25519；`--proto =https --tlsv1.2`；`main()`；版本格式；解包路径检查（7.3） |
| SEC-15 | 接受 | 计划任务名 `\VonvonBot\<sid-hash>-<root-hash>`，只认本用户本目录，不 `/F` 覆盖别人的（7.4） |
| SEC-16 | 接受 | `clients.json` 加 `generation`，每条 RPC 前核对；撤销取消任务和日志订阅（4.3） |
| PROTO-1 | 接受 | hello 形状不变、serverInfo 分 v1/v2、能力和范围放 `negotiate`、owner-verification 不比版本、枚举开放解析、`command.restartHost`、`startedAt`、维护子集不推 snapshot、0.8→0.9 回归测试（4.5） |
| UPD-1 | 接受 | 先切 `current` 再 `requestRestart`；助手按 `serverInfo.version` 判成功；子进程钉自己的 release（7.5） |
| WIN-1 | 接受 | 并入 SEC-10：启动器 + `current.txt`，监督进程 re-exec（7.2、7.4） |
| AUTHZ-1 | 接受 | 并入 SEC-1；D4 拆成 D4a（host 令牌 + scope）和 D4b（Bot 侧授权） |
| AUTHZ-2 | 接受 | `inBotSession()` 为真而没有有效令牌一律 exit 4，绝不退回 owner；三种情况测试（5.3） |
| COEX-1 | 接受 | 并入 REQ-3：脚本查桌面端安装包和包装标记（7.3） |
| PKG-1 | 接受 | 包里加 `ui/dist`、`bin/vonvon.mjs`、`package.json`；一律 exec `bin/vonvon.mjs`；I1 验收加 `open --print`、`hook`（7.1、7.2） |
| DRAIN-1 | 接受 | 排空白名单加 `coreUpdateStatus`，和维护子集同一个常量；CLI 断线后读 `update-status.json`；退出码 6（4.7、7.5） |
| LISTEN-1 | 接受 | `remote-listeners.ts` 生命周期：drain 停重试和新连接，release 关所有 server；多 server 的 `createSocketServer`；远程用自己的请求处理器（4.2） |
| SLICE-1（可行性） | 接受 | D1 撤销验收挪到 D3；死 kind 先挪进 `ipc-contract`；U1 加 D3（经 U1b→U3 链）、K1 加 C3/C4/C6、I2 ps1 加 I4a；U1、D4、I4 拆片；死 UI 归 U2（13） |
| COEX-2 | 接受 | `observeCli` 认服务端标记回 `ready`"由服务端安装提供"；脚本写同一个 PATH 块（7.2、7.4） |
| PROTO-2 | 接受 | `P/admin.ts:88` 加 `standalone`，客户端开放解析（7.1） |
| NPM-1 | 接受 | `bundledNpmCli` 认 standalone、从 `process.execPath` 推 npm，不靠环境变量（7.2） |
| WIN-2 | 接受 | 监督进程设 `VONVON_SERVICE=windows`、spawn 不 fork；只用 `/Create /XML /F`，XML 里 `UserId`；所有 detached spawn 加 `windowsHide`（7.4） |
| LINGER-1 | 接受 | "装好但 linger 没开"退出 0、`--json` 回 `linger: 'off'`；退路补用户实例不可用；验收用 SSH 登录测试用户（7.3、13） |
| CLI-1 | 接受 | daemon 在跑时 `remote/pair/clients/device` 走 RPC；邀请只在内存，`pair` 要求 daemon 在跑（8.3） |
| CONTRACT-1 | 接受 | 统一关闭码；墓碑 `revokedAt` 回 4003；`jobRunning` 进契约（`force`、`attachJob` 按 SCOPE-1 砍）；`--json` 非 TTY 输出规矩写明；`bot add` SIGINT 发 `cancelJob`（4.3、4.7、6.3、8.1、12） |
| DIR-1 | 接受 | Windows 路径输入在 U2 修；6.4 本机一列改成原生选择器；家目录限制列第 14 节第 6 条 |
| PKG-2 | 接受 | `build-server` 按目标平台选 hoist/compact；检查无 symlink 和路径预算（7.1） |
| PARITY-1 | 接受 | `--all` 列已归档；`env profile init --status/--cancel`；`MigrationBanner` 进白名单（client-only）；`snapshot --json`（8.1、8.2、8.4） |
| SCRIPT-1 | 接受 | uninstall 的受保护删法四条件；`HOME` 为空拒绝的脚本测试（7.3） |
| REQ-1 | 接受 | `startHost`、`service start|stop` 不删，形状挪进 `ipc-contract`；"删 Codex 面板"改成只删旧 `installCodex/startCodexLogin` 任务面板，托管安装不动，归 U2（8.4） |
| REQ-2 | 接受 | `pair` 不管 TTY 都输出链接，只不进日志；D1 验收加非 TTY `pair --json`（4.3） |
| REQ-3 | 接受 | 已装过检测加桌面端安装包和包装标记；跳过文案按平台分；Windows 桌面端的 `vonvon`/自启列第 14 节第 8 条（7.3） |
| REQ-4 | 接受 | 按 vonvon-site `origin/main` 重做 W1：`/guide/remote/`，`HOST_SCOPED_PATHS` 加 `/guide/`；脚本 URL 改；验收加两个域名（10） |
| REQ-5 | 接受 | 删"Vonvon 不代你登录"；模板带 Codex/Claude Code；U2 列出全部"登录"文案改掉（6.4） |
| REQ-6 | 接受 | 并入 SEC-1：私聊令牌经 CLI 的授权和 3.7 一致，权限档/网络/建群能改；要更严列第 14 节第 3 条（5.2） |
| REQ-7 | 接受 | 第 2 节那行标"待 owner 确认"；第 14 节第 2 条改成真正的二选一，引两句原话，建议 B 并说明；D0 的 3.7 改动标待定 |
| REQ-8 | 接受 | 并入 SEC-2（5.3） |
| REQ-9 | 接受 | bundled 设备远程升级列第 14 节第 4 条，建议不支持并给文案；6.5、4.6 按它显示 |
| REQ-10 | 接受 | `daemon-manager`/`daemon-dependencies` 对 standalone 协议不同不报致命错误，按维护子集连上显示升级条；U2 验收（4.5、7.4） |
| SLICE-1（需求） | 接受 | D4 验收改用 `schedule add`；`schedule.ts:154`/`memory.ts:44` 改放行归 D4a；K1 依赖补齐；C1 先合入；`update` 只在 I3（8.1、13） |
| SLICE-2 | 接受 | I1、I3、I5 和 I2 的 sh 挪到 B2（JP-VPS Codex 第二个会话）；A 道从 ~11,900 降到 ~7,000（13） |
| SCOPE-1 | 接受 | 砍二维码、后台关注点连接、接管/`force`/`attachJob`、`remote.hostnames`；行 E 和 `MigrationBanner` 另开小 PR；`seen/counts` 进白名单（1、6.1、6.3、8.2） |
| OWNER-1 | 接受 | 技术决定（端口、加密、安装路径、关注点、TOFU、死 kind）移出第 14 节；补 bundled 升级、CLI 严格度、登录后运行、Windows 桌面端命令、授权过期、目录限制、root；版本号明说要 owner 定；第 8 条和 4.6 的矛盾按 4.6 改（4.6、14、15） |
| REQ-11 | 接受 | 7.1 写明 `stageDaemon` 的 minify/bundle 对桌面端同样生效；I1 验收加桌面端 `Resources/daemon` 检查 |

**2026-11-02，#640 上 Sonnet 审查 U1a–U4 计划后**（46 条，全部接受，其中一条部分接受），设计跟着改了这些（细节见各片计划的"审查后改了什么"）：
- 外壳声明的能力名 `desktop.selfUpdate` 带大写，过不了 D1 `negotiate` 的 `/^[a-z][a-z0-9.-]{0,63}$/`，改成 `desktop.self-update`（7.5、12、13、18；D1 计划同步）。
- 6.3：同一个 key 还有连接在就不算断开，不起宽限（U3 4.2 的 `holders`）。
- 7.5"U4 计划补的"：检查和更新分开记 id，更新中的检查不转发；排空白名单加 `machine.desktopUpdateReport`。
- 13：I3 的行注明已拆成 I3a、I3b；U4 依赖加 U3（`peer-label.ts` 和 hub 的 `attached` 只由 U3 建）。
- 15：补 U4 的检查没回应、桌面端重开但没换上、上一次还没完、正在退出、排空超时、`forbidden` 和状态行前缀。
- 地址状态 `failed`：D3 的监听器会记它、U3 有文案，D1 的协议枚举没有。由 D3 加进 `remoteAddressStateSchema`（D3 计划 4.5）。
- D2 的两个子路径 `@vonvon/client/secure`、`@vonvon/protocol/secure-channel` 要在各自 `package.json` 的 `exports` 里登记（D2 计划 4.2）。

## 18. owner 确认后的改动（2026-10-31）

owner 对第 2 版第 14 节各条和设计后追问的回答，按条改进正文。没有新增产品问题。

| 改了哪里 | 改成什么 |
|---|---|
| 版本号 | 0.9.0，macOS、Windows、服务端包同号（第 2 节、7.1、7.6、第 11 节） |
| 授权模型 | 第 5 节开头加三层表（会话以外 / 私聊 / 群，外加云文档评论）；**群会话不写任何设置**，删掉第 2 版里所有让群会话改本群群设置的写法和"待 owner 确认"第 2、3 条；5.2 的 `settings.*`、`command.list*`、`collaboration.*`、`memory.*`、`schedule.*` 按令牌的地方分开写，群令牌的设置写在 host 就回 `not-dm`；私聊的只读查询也要主人或管理员那一轮；5.3 写明今天命令行的洞、`--scope` 上限按会话、完全访问的残留风险和警示 |
| 第 2 节已定的事 | "群里的 Bot 能改什么"换成"在哪能改设置"三层；加"会话里的命令行""完全访问的群""版本号""Mac/Windows 当服务端""端口"几行；"升级"一行改成 bundled 也能远程升级；"3.7 照旧"加回执卡推迟 |
| 设置回执卡和［撤销］ | 推迟、不做计划，进第 1 节"不做"（同一处补上 Windows 桌面端的 `vonvon` 和自启）；设置 skill 要求 bot 在回复里说改前 → 改后（第 9 节、K1）；`product.md` 3.7 标推迟、挪进第 7、10 节（第 11 节）；风险第 16 条 |
| 完全访问警示 | 文案进第 15 节，`product.md` 3.7、3.8 的改法进第 11 节，实现归 U2（`TierInfo.warning`、执行权限选择、建群和拉进新群对话框、bot 回复、CLI 输出）；风险第 2 条重写 |
| bundled 远程升级 | 新片 **U4 `devices-ui-4-bundled-update`**（C 道 Mac Codex，Windows 验证在 D 道，约 600 行，依赖 D1、I3、U1a，真机验收要 D3）；通道是外壳今天对本机 daemon 的 loopback 连接，新事件 `desktopUpdateRequest`、新请求 `machine.desktopUpdateReport`、能力 `desktop.self-update`、错误 `desktop_not_running`；沿用 `beforeUpdateInstall` 和启动修复的排空；远程触发不弹 Windows 本机确认框（4.6、6.4、6.5、7.5、12、15、16） |
| 登录才运行 | 7.4 单列一条；官网文档第 2 条、`product.md` 3.10、安装脚本"完成"文案（第 15 节）都写"Mac/Windows 当服务端要保持登录，可以锁屏" |
| 端口 | 4.2 补 Paseo 6767、Orca 6768、vonvon 本机端口随机、`remote port` |
| 技术默认 | 邀请 10 分钟一次性、授权不过期、远程选目录不限家目录（U2 改 `directory-browser.ts`）、root 默认拒绝、只支持 glibc、自动开 linger、远程停止带确认、Windows 桌面端不注册 `vonvon` 不自启，正文各处去掉"待定"、标 owner 确认 |
| 第 14 节 | 改成"owner 已定（2026-10-31）"表（18 行）和 Claude 按答案定的六处细节 |
| 切片 | 加 U4；U2 ~1,300 → ~1,400；D0、D4a、D4b、K1 的内容和验收按三层改；验收段加 U4 的 Mac、Windows 检查和锁屏后在线；合计按表重算为约 27,200 行、27 片（代码 26,000：A 6,000、B1 8,300、B2 4,600、C 5,100、D 2,000；文档 1,200），第 2 版的 26,400 是加错的 |
| 第 17 节 | 加一句说明：那里的"第 14 节第 N 条"指第 2 版的清单 |

## 19. owner 2026-11-01 的改动：命令行只装服务端，只在 Linux 上做

owner 原话："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装。"本节和前面各节冲突时以本节为准；第 17、18 节是当时的记录，不改。

| 改了哪里 | 改成什么 |
|---|---|
| 范围（第 1、2 节） | 一条命令只装服务端只在 Linux 上做。Mac、Windows 只用桌面端安装包，里面自带服务端；没有脚本装的 `standalone`，也不用命令行装 |
| 取消的片 | I2b（`install.ps1`、`uninstall.ps1`）、I4a（Windows 计划任务、`.cmd` 启动器、`current.txt`）、I4b（`__win-supervise` 监督进程）。计划文件头上标"已取消"，留作记录；分支 `claude/server-4a-windows-task` 不合入，留作参考。I4a 里"win32 报平台名 `windows`"一项不随之取消，挪给 U2（下面"Windows 的平台名"一行）。Windows 桌面端这一批仍不注册 `vonvon`、不做登录自启（owner 2026-10-31），没有别的东西要用 Windows 的计划任务 |
| 安装脚本（7.3） | `install.sh`、`uninstall.sh` 只在 Linux 上动手，第一步就看系统。在 macOS 上打印一句中文，让用户到 https://vonvon.cc/get/ 下载安装包，退出非零，什么都不碰；别的系统打印"只支持 Linux"，同样退出非零、什么都不碰。脚本里不再有 Mac 的 LaunchAgent、桌面端共存、无图形登录这些分支；Linux 照旧查"已装过" |
| 服务端包和清单（7.1、7.5、7.6） | 只有 `linux-x64`、`linux-arm64`（glibc），`.tar.gz`；签名清单的 `files` 只有这两项 |
| 用不上的代码 | I1 已合入的：`build-server.mjs` 的 darwin、win 四个目标，`.zip` 和 `unpackZip`/`writeZip`，Windows 的 Node 和 npm 布局，260 字符预算，大小写重名检查，`server-node.json` 的四个 Node，`bundledNpmCli` 的 Windows 布局，launchd 接受 `standalone`。I3 里的：`current.txt` 分支、`extractZip`。这些已由 I6 删掉；桌面端 `RegisteredDaemon.kind` 的 `standalone` 和几处共用的判断留着，理由见 `server-6-linux-only.md` 第 4 节。I2a 起 `build-server.mjs` 不带 `--targets` 只打两个 Linux 包（`PUBLISHED_TARGETS`）。清单两项不留给 I6：I2a 的脚本已经只认两项，I3a 写的 `SERVER_TARGETS` 六项在 I3 里改（连同 `fake-cdn` 和测试） |
| 共存（4.5、6.4、7.4） | Mac、Windows 上没有脚本装的服务端，Linux 没有桌面端。桌面端一侧原来的四条只剩"退出"：桌面端停本机的服务端，只有"不是桌面端自带、又另外注册成后台服务"的不停（比如自己 npm 装再 `vonvon service install`），因为停了以后服务管理器不会再拉起它；登录项、启动修复、`vonvon` 标记三条不做。4.5 里"本机 `standalone` 协议不同时显示升级条"也不做 |
| Windows 的平台名 | daemon 在 win32 上报 `platform: 'windows'`：`D/server/snapshot.ts` 的平台判定今天把 win32 判成 `unsupported`，`P/domain.ts` 的 `application.platform` 加 `windows`，serverInfo v2 的 `platform` 同源（D1 的 schema 已有 `'windows'`）。原来是 I4a 的一项（`server-4a` 的"`snapshot.ts` 的 win32 → `'windows'`"），I4a 取消后归 U2：6.4 表里登录项那一行 Windows 的说法、U2 的 Windows 路径输入、D 道对 Windows 桌面端当被连的设备的验收，都要客户端认出对面是 Windows。只改平台名，`machine.status.service` 和 `service/adapter.ts` 在 win32 照旧是不支持 |
| 不变 | Mac、Windows 桌面端是能被别的设备连过来管的设备，能经桌面端外壳远程升级（U4）；桌面端自带的服务端；多设备；远程配对；Linux 服务端的全部做法；Mac、Windows 当设备要有用户登录着（Mac 靠桌面端的登录项，Windows 只在应用开着时） |
| 切片（第 13 节） | 表里去掉 I4a、I4b；I2 只剩 I2a；加 I6（依赖 I2a、I3、U2）；U2 ~1,400 → ~1,300，另接 Windows 的平台名；I5 依赖加 I6；D 道只剩 U4 的 Windows 验证（含 Windows 桌面端当被连的设备）；合计重算为约 25,350 行、26 片 |
| 命令行的 Windows 检查 | C1、C3、C7、C8 计划里交给 Windows（D 道）的命令行检查（C1 的 `vonvon.cmd` 退出码，C3 的 Windows 路径，C7 的 `env install lark-cli`，C8 的 `daemon logs --follow`、`service skip`），靠的是 Windows 上只装服务端的 `vonvon.cmd`。这一批 Windows 上没有注册的 `vonvon`，这些检查不做，四份计划里各加了一行说明；发给 Windows 的任务只有 U4 的检查和 Windows 桌面端当被连的设备的检查；Skill 在 Windows 桌面端上只用进程内工具 |
| 官网（第 10 节，W1） | Mac、Windows 下载桌面端安装包；Linux 一条命令；开远程地址、生成链接在 Mac、Windows 上走桌面端；登录着的要求按平台写 |
| 文案（第 15 节） | 去掉 Windows、Mac 的"已装过"、"保持登录"、Mac 无图形登录几条；加安装脚本"在 Mac 上""不是 Linux"和卸载脚本"在 Mac 上""不是 Linux"；这几句和 `install.sh`、`uninstall.sh` 打印的逐字一样，`install.test.mjs` 按全文核对；下载地址是 https://vonvon.cc/get/（新版本只认 vonvon.cc，bot.vonvon.cc 只为 0.7.0 留着 301，`v1-plan.md` 第 10 节） |
| 风险（第 16 节） | 第 4 条换成 Windows 桌面端锁屏时在不在线；第 6 条去掉只 SSH 的 Mac；第 9 条作废；第 11 条去掉 Windows 的 `node.exe` 占用 |
| 别的文档 | `product.md` 第 1 节、3.1、3.10、3.14、第 7 到 10 节（第 11 节记了这次的问答）和 `architecture.md` 的服务管理、维护子集、共存、"服务端独立安装和升级""在哪些系统上能跑"按上面改；`server-1/2/3/5` 的计划在文首说明；`devices-3-remote-listen.md` 里"I4a 后由 Windows Codex 顺带验 `remote enable --tailscale`"改成在 Windows 的验收任务里看桌面端认不认 Tailscale 地址；`devices-1-identity.md` 里 `platform` 那句和 `server-4a` 文首写明 Windows 的平台名归 U2 |

## 20. owner 2026-11-02 的改动：设置只在私聊，群里只给干活要用的（S1 `settings-dm-only`，含 S1b）

owner 原本的诉求是"通过对话读配置、改配置，只有主人或管理员能改，所以只在私聊里有这个能力"。群里没有这个能力：不给群会话任何设置工具，不往 skill 里塞设置规则。"飞书是别人的 Skill"：飞书官方 lark-cli 自带的 `lark-*` skill，vonvon 不发自己叫"飞书"的 skill。私聊的 agent 会话（`docs/v1-plan.md` M9：s49、s54a 等）这一批不做；owner 在自己的 agent 里调 `vonvon` 命令行改配置，这一批不写设置 skill。S1 做完、送审查之前，owner 又定了 S1b：群里不管经工具还是经命令行都只给干活要用的，改配置一律禁止，隐私查不到，挡在命令行和工具这一层；vonvon 自己的 skill 以 `vonvon` 开头；群里的 `/settings` 去掉；飞书消息的格式改成 skill。下表是 S1b 和之后 Codex 审查（任务 256–258）改完的做法，细节、取舍和触发测试见 `docs/plans/settings-dm-only.md`。S1 最初写在这里的表（群里只有任务 skill、`feishu_groups` 不动、群里能查 `settings.sessions/models`、群 `/settings` 默认保留）已被取代。和前面各节冲突时以本节为准。

| 项 | 改成 |
|---|---|
| 内置 skill（第 9 节、K1） | 撤掉 K1 的 `feishu.ts`、`settings.ts`、`session-rules.ts`。群那一套是 `vonvon-schedule`（定时任务，正文和 K1 之前一样）和 `vonvon-feishu-message`（飞书消息格式：卡片、表格、图片、发文件），私聊那一套没有；文件只读。开场说明只留每一轮都要守的，卡片和图片的写法挪进 skill。`VONVON_SCOPE` 留着，会话里不带 `--scope` 时的拒绝文字直接说"带上 `--scope "$VONVON_SCOPE"`" |
| 群会话的工具（第 5 节开头、5.2） | `settings_get`、`settings_access`、`feishu_groups` 只在私聊里有（`places: ['p2p']`），群里列不出，硬调回 `unknown-tool`；`session_info` 群里的结果不带设置那一项。群里剩 `session_info`、`feishu_members`、记忆和任务工具；Codex 群会话本来只有任务工具。设置工具只在私聊里给（现在没有私聊会话） |
| 群令牌的命令行（5.2） | 群这一格是白名单，其余默认拒绝：`schedule.*`、`memory list/add/edit/archive`（Bot 进程判）、`command.listGroupMembers`（只查本群）、`admin.negotiate`、`snapshot.get`（收窄过的快照）。改设置的（`settings.read/save/act`、`collaboration.createProject/editProject`、`command.setResponse/setPermission`）回 `not-dm`，其余回"这个操作不能从 Bot 会话里做。"，不透露有什么。评论这一格只放行 `snapshot.get`、`admin.negotiate`。群和评论的快照只剩本 bot、本群和本群项目的 id、名字；群里看记忆的回包收窄到和 `memory_list` 工具一样 |
| 会话里不经 daemon 的命令（5.3、8.3） | `service status` 读的是服务管理器和本机文件，会话里和 `service install` 一样 exit 4 `not_in_session`；`daemon status` 在会话里只回 `running`、`listen`（命令行找 daemon 要用），不带进程号、启动时间、版本。其余会读本机文件的命令在会话里只走 daemon（`daemon logs`、`project list`、`memory`），或者拒绝（`secrets list/set/remove`） |
| 连接握手（4.5） | Bot 会话的 `serverInfo` 只有 `type`、`version`、`protocolVersion`、`principal`，没有设备名、`machineId`、平台和能力；客户端解析时 `machineId` 可以没有。本机终端、桌面端、远程客户端照旧 |
| 拒绝文字（第 15 节） | 群里改设置："群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"；评论里改设置："评论里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"。工具、daemon 和命令行（`settings`、`group set`）按会话位置用这两句，只打这一句。D4a、D4b 的其余拒绝都留着 |
| 群里的 `/settings`（审计 252-2） | 去掉：群里三处 `/settings` 都只回上面那句，不发卡；以前发出的群设置卡（`GS.*`）谁点都只把卡变成这句话，什么也不写。私聊 `/settings` 照旧 |
| 私聊卡片的管理员名单（审计 252-1） | 只有主人能在「设置 → 管理员」卡片上加、移本机管理员；别的管理员看到的名单只读 |
| 飞书来的管理员（审计 252-4） | 以最近一次成功的刷新为准，20 分钟（两个刷新间隔）没刷新成功就不再认；刷新失败 5 分钟后再试；主人、扫码的人、本机名单不受影响 |
| 审计 252-3、252-5 | 记进 `product.md` 3.8"留下的风险"，不改代码 |

## 21. owner 2026-11-02 的改动：远程只开一个地址，不绑 Tailscale（A1 `remote-single-address`）

owner 2026-11-02 定：远程连接的体验和能力和 Orca、Paseo 差不多或稍好就行，以后主打账号中继；**不做自定义地址和内网穿透**。Tailscale 只是建议，不绑死：去掉 `--tailscale`；不让用户填网卡名（用户没有这个概念）；**只开一个地址**。调研见 `addr-selection-research.md`（Orca、Paseo 怎么选地址、候选怎么过滤）和 `tunnel-design.md` 第 2 节"组网类"（隧道部分不做）。计划在仓库的 `docs/plans/remote-single-address.md`。和前面各节冲突时以本节为准。

| 项 | 改成 |
|---|---|
| 开几个地址（4.2） | 一个。`remote.json` 的 `addresses` 和 `device.status` 的 `remote.addresses` 保留数组形状，最多一项。再开一个就换掉原来的：原来的马上停止监听，经它的连接 4006。A1 之前写了多项的文件读成最后开的那一项 |
| 已配对的设备怎么跟着换 | 沿用 U1 的"地址变了"：在这台运行 `vonvon pair` 生成链接，粘到那台的"添加设备"，只更新它记的地址（新的排前面、旧的留后面），不用掉邀请、不用重新配对。`remote enable` 换了地址、又有已配对的设备时，输出里写这一步；客户端收到 4006 的文案也说"可能换了地址"。连着的客户端自动跟到新地址（换之前先推一条"新地址"）这一批不做 |
| `vonvon remote enable` | `enable [<ip>] [--allow-public]`。不给地址、在终端里：列出候选让人选（编号，回车选第一个；也能直接打 IP），选到运营商地址、公网地址再问一次风险。不给地址、不在终端里（或 `--json`）：退出码 2，报错里列出候选和示例命令 `vonvon remote enable 100.x.y.z`，`--json` 的 `partial.candidates` 带候选。命令行里写了地址的照旧：公网和运营商地址要 `--allow-public`，不在终端里问 |
| `vonvon remote candidates [--all] [--json]`（新） | 和终端里的选择列表同一套：本机网卡上非回环的 IPv4，IPv6 只列 Tailscale 段；排序 Tailscale、组网、局域网、运营商、公网。默认不列虚拟网桥（docker、br-、virbr、vmnet、vboxnet、veth、lxcbr/lxdbr/incusbr、podman、cni、flannel、macOS 的 bridge100 起、Windows 的 Hyper-V Default Switch、WSL、DockerNAT、VMware、VirtualBox 的 Host-Only）、代理软件的 fake-IP（198.18.0.0/15）和 169.254 自动分配的地址，`--all` 才列。只读本机网卡，不经 daemon；`tailscale ip` 只在有 100.64/10 地址、又没有网卡名说明是 Tailscale 时才跑 |
| `vonvon remote disable [<ip>]` | 不给地址就关掉开着的那个 |
| 组网（新分类 `overlay`） | Tailscale 以外的组网工具，按网卡名认：ZeroTier（`zt…`、macOS 的 `feth…`、Windows 的 `ZeroTier One […]`）、NetBird（`wt0`）、EasyTier（Windows 的 `et_0`）、蒲公英（`oray…`/`pgy…`，没在真机上核实）、Hamachi、WireGuard（`wg…`），另外 `tun0`、`utun3`、`tap0` 这类普通隧道算没有名字的组网。私有段的地址在这些网卡上就是组网；100.64/10 的只有网卡名认得出工具时才算组网，普通隧道上的照旧算运营商地址、要确认；公网段的地址在什么网卡上都算公网。认不出的照旧按段分 |
| 组网地址的"网络变了" | 不比网卡名、不比网关，只看它还在不在组网工具的网卡上（macOS 的 utun 编号重启后会变）；跑到普通网卡上进"需要确认"，文案"<地址> 现在不在组网工具的网卡上了（可能是别的网络分到了同一个地址）。确认现在的网络是你信任的，再重新开启。" |
| 协议 | `addressKindSchema` 加 `overlay`（配对链接、设备状态、桌面端记的地址都跟着认）；`device.enable` 只收 `{ host, allowPublic? }`，`tailscale` 字段去掉。桌面端的地址标签加"组网"，连不上的提示加组网那句 |
| 桌面端"允许别的设备连接"（U3） | 地址改成单选，候选和 `remote candidates` 同一套（U3 的 `createCandidates` 包一层 `D/remote/candidates.ts` 的 `listCandidates` 加缓存），不再有"用 Tailscale 地址"按钮。U3 计划文首记了要改的地方，实现时的出入在 U3 计划第 11 节 |
