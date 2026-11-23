# Vonvon Bot 架构

这份文档说明 Vonvon Bot 的目标架构，以及每个关键决定的理由。实施顺序见 [roadmap.md](roadmap.md)。

2026-10-31 起，远程连接和多设备按 [devices.md](plans/devices.md) 做（0.9.0）：远程客户端直连对方设备、走端到端加密通道，账号和云端中继以后再加，加进来只是多一条到达设备的路。产品行为见 [product.md](product.md) 3.7（在哪能改设置）、3.10（Linux 上只装服务端）和 3.14（远程连接和多设备）。2026-11-01 起一条命令只装服务端只在 Linux 上做，Mac、Windows 只用桌面端安装包（[devices.md](plans/devices.md) 第 19 节）。下面"远程连接和多设备"及其后几节是这部分的架构，和下文早先按"经云端远程"写的内容冲突时，以它们为准。

## Vonvon Bot 做什么

Vonvon Bot 让飞书机器人把群聊和私聊消息交给你电脑上的 coding agent 处理，比如 Codex 和 Claude Code。一个飞书群对应一个项目目录，群里的一个话题对应一个 agent 会话。

用户在飞书里和 Bot 对话。Vonvon Bot 的桌面端和网页不聊天，只用来设置 Bot、群、会话和本机环境。

Vonvon Bot 是独立产品。它不依赖 feishu-codex-bridge，不调用用户装的 bridge CLI，也不和 bridge 共用数据目录。bridge 的老用户可以把数据导入 Vonvon Bot，导入成功后 bridge 的服务会自动关停。

## 整体结构

整体结构照搬 Paseo（`getpaseo/paseo`，`0009a7e71`，见它的 `docs/architecture.md`）。每台机器跑一个 daemon，桌面端、网页和 CLI 都是连接 daemon 的客户端。

```text
desktop (Electron)      web UI          vonvon CLI     bot session (vs1 token)
      |                   |                 |              |
      +--- local: WebSocket to 127.0.0.1 ---+--------------+------+
      |                                                           |
      +--- remote (0.9.0): direct WebSocket to the                |
      |    device's remote listener (Tailscale / LAN              |
      |    IP, port 7767), Noise_IK encrypted ---+                |
      |                                          |                |
      +--- later: same channel via relay --+     |                |
                                           |     |                |
                   +--------------+        |     |                |
                   | Vonvon cloud | <------+     |                |
                   |   (later)    |  accounts,   |                |
                   +------^-------+  relay       |                |
                          | outbound             |                |
                   +------+-------+              |                |
                   |    daemon    | <------------+-----------------+
                   | (1 per host) |
                   +------+-------+
          +---------------+----------------+
   Feishu long conn   agent providers   local data
   (1 child per bot)  Codex, Claude,    ~/.vonvon-bot
                      Cursor, Grok, Pi,
                      custom ACP
```

daemon 负责这台机器上的一切。它运行 Bot、管理 agent 会话、保存设置，并通过 WebSocket 提供 API。

客户端只读写 daemon 暴露的 API。桌面端、网页、CLI 用同一套协议，区别只在怎么连上 daemon。CLI 永远只连本机；远程管理只走桌面端（见"远程连接和多设备"）。

云端以后再做，只做三件事。它管理账号，记录账号下有哪些机器以及是否在线，并在客户端和 daemon 之间转发加密后的数据。0.9.0 没有云端：远程客户端直连对方设备的远程监听。

## 关键决定

### daemon 是本机数据的唯一写入者

每台机器只有一个 daemon 进程。它用 `~/.vonvon-bot/daemon.pid` 防止第二个实例启动，做法同 Paseo 的 `packages/server/src/server/pid-lock.ts`。

现在的桌面端、bridge CLI 和 bridge 网页控制台都能改同一份数据，所以 bridge 需要宿主所有权锁和互斥检测。新结构里只有 daemon 写数据，客户端都通过 daemon 改设置，这类冲突不再存在。

Bot 不依赖桌面窗口，关闭窗口只隐藏窗口，飞书里的 Bot 照常回复；macOS 同时隐藏 Dock 图标，从状态栏打开时恢复窗口和 Dock 图标。用户从状态栏、Windows 托盘或 macOS Dock 菜单主动退出桌面应用时，桌面端通过认证的停止请求关闭当前数据目录的 daemon，等待后台及其 Bot 子进程退出后再退出自身。daemon 仍可独立于桌面端从命令行或系统服务运行。开启**开机自动运行**后，daemon 注册为系统服务。代码从 bridge 已有的 launchd、systemd 和 Windows 启动项代码改来，但用 Vonvon 自己的服务标识（`com.vonvon.bot.daemon`、`vonvon-bot.service`），绝不读写 bridge 的服务注册。系统服务从 V5 开始提供，具体设计和原生验收见 [plan.md](plan.md) V5 一节的 *Service gate*。V3 的 `vonvon service install` 和 `uninstall` 一律报错退出，因为复制来的服务代码还在用 bridge 的标识。停止 daemon 不删除系统服务注册，关掉开机自动运行才删除。

V5 的系统服务设计要点如下。

- 每个系统用户最多注册一个 Vonvon 服务。服务定义里写着它的 `VONVON_HOME`，这就是唯一的记录，不新增状态文件。其他数据目录的注册、认不出的定义，一律拒绝改动。
- 注册了服务的数据目录只由系统服务管理器启动，`vonvon daemon start` 也交给管理器，失败就报错，不自己另起进程。
- 管理器只在失败时重新拉起。停止退出 0，不会被拉起，注册保留。重启在排空后退出 75，由管理器按原端口拉起；重启助手起不来时，服务管理下的 daemon 同样退出 75，管理器拉起原来的版本（2026-11-02）。崩溃或其他非零退出在 5 秒后拉起。Windows 没有服务管理器。原来为 Windows 只装服务端设计的计划任务和 `__win-supervise` 监督进程随 2026-11-01 的决定取消（[devices.md](plans/devices.md) 第 19 节）；Windows 桌面端这一批不做登录自启，`service/adapter.ts` 在 win32 照旧报不支持。
- Vonvon 从不通过管理器停止正在运行的 daemon，停止只走 `stopHost`，停止优先的规则和 V3 一样。2026-11-02 起排空有时限（owner：停止、重启、升级直接中断正在进行的对话）：每个 Bot 先中断所有进行中的一轮，等 3 秒让 Codex、Claude 自己收尾，再关它们的进程，卡片最多再等 8 秒；Bot 子进程关 bridge 最多 12 秒；host 等每个 Bot 最多 15 秒，到点强制结束它和它报过的 provider 进程组；`daemon run` 从收到停止起最多 30 秒，到点写下干净退出的记录、刷完日志就自己退出（重启、升级 75，停止 0，不在服务管理下 1）。systemd 单元的 `TimeoutStopSec=45` 只兜底，正常用不到；旧单元里的 `TimeoutStopSec=infinity` 照旧认作自己的。做法见 `docs/plans/interrupt-and-install-text.md`。
- Core 更新后的重启仍由 V3 的重启助手确认新进程，并只完成它自己持有的那条更新记录。在 macOS 和 Windows 上，助手和 V3 一样另起进程组；macOS 的 `launchd.plist(5)` 文档支持这样做，但还要原生验收。Linux 上助手用 `systemd-run --user --scope` 放进单独的 scope。systemd 源码说明这一步不换 pid，但不会通知就绪，所以 daemon 自己查同一个 pid：它已经在这个 scope 里，命令行也已经换成助手，才提交并放锁（Gate L）。在这之前助手失败、超时或收到停止，都按 V3 的规则变成停止，那条更新记录写成 `error`。
- 只装服务端（standalone）的升级（`docs/plans/server-3-update-engine.md`）先换文件再重启：安装根下 `releases/<版本>/{app,node,standalone.json}` 每版一个目录；POSIX 的 `current` 是指向 `releases/<版本>` 的相对符号链接，先建 `current.next` 再 `rename` 覆盖；Windows 没有 standalone（owner 2026-11-01），原来给它写的 `current.txt` 已由 I6 删掉。已经在跑的进程把自己的入口钉在启动时的真实路径上（`core/self-entry.ts`），切 `current` 以后它派生的子进程和重启助手仍是旧版的文件。
- 安装根下的 `update-state.json` 记见过的最高版本和上一次清单的 `publishedAt`，原子写，跨版本只有一份，用来拒绝倒退的清单。数据目录下的 `update-status.json` 是一次更新的进度：`installing`（下载、校验、解包、切换）、`restarting`（带 `previous`，排空、等新版本）、`done`、`error`（`rolledBack` 表示已切回）；排空期间 `machine.coreUpdateStatus` 仍可读。重启助手按 pid 锁里的 `version` 判断新版本起来没有（listen 以后还要活过几秒），没有就切回 `previous`；托管时也是同一个助手（Linux 上在单独的 scope 里）。旧 daemon 退出以后，助手拿住 `update.lock` 直到写出结果，这期间不接新的更新，新进程启动时的收尾也让给它；旧 daemon 在请求重启以后停止、助手丢失或重启被拒，先把 `current` 切回 `previous` 再写 `error`。新进程启动后再核对一次，`current` 已经不指向自己就写"升级和回滚撞上了"。同一个安装根可以有几个数据目录的 daemon：下载、解包、切换和清理 `releases/` 还要拿安装根的 `releases.lock`，每个 daemon 把自己运行的版本登记在 `running/<pid>-<版本>`，清理时留着还活着的那些。

- macOS 上，`launchctl bootout` 只出现在一处“卸载屏障”里，也就是卸载时的“撤下定义、排空、再卸载”。安装时替换已加载的任务、回滚时卸载本次加载的任务，都走这道屏障。任务没加载时只做 `bootstrap`。回滚后旧任务留在磁盘上但不加载，等 `vonvon daemon start` 或下次登录（Gate M）。`bootout` 发出后失败、超时，或之后查询仍找到任务，就把状态当作未知：不写回定义，注册保持撤下，不再发第二次，报告未完成。
- 每次卸载、安装替换和回滚在开始时定下排空范围，一直用到结束。从 `ours` 开始的卸载和安装替换停止数据目录的任何 daemon。安装回滚和从 `absent` 续做的卸载只停止能证明是本次任务子进程的 daemon，其他锁主人保留：不停止、不发信号、不等待，也不阻止卸载完成。证明按顺序做四次观察：读锁、查管理器的 pid、再读锁、经认证向那个端点核实 pid 后才发 `stopHost`。前三步对不上就保留这个主人，此时没有发过停止；同一个主人连续两次在前三步证明不了就报告未完成。证明依赖两条假设：管理器报告的 pid 是准的，`(pid, startedAt)` 只对应一个进程。前者要原生验收确认。Windows 查不到任务的 pid，所以这类事务在 Windows 上从不停止 daemon。
- 管理器拉起的进程在拿 host 互斥锁和 pid 锁之前就检查注册和锁的主人（在 `host/bootstrap.ts` 里）：注册不属于自己，或者已经有别的 daemon 在运行，就直接退出 0。Bot 子进程不做这项检查。
- 安装和卸载都是事务，失败时回滚或列出残留，重跑可以收敛。服务定义文件还在、但管理器里已经没有这个任务时，不算已安装。已安装但被手动停止的服务，再次安装时保持停止。
- 卸载先撤下服务定义，再停止 daemon 并等它排空，最后才卸载服务。管理器启动的进程第一件事就是检查注册，发现不属于自己就在拿锁之前退出 0。所以卸载期间即使发生重新拉起，也不会有已接受的工作被打断。这一点依赖管理器查到的 pid 是准的。卸载命令发出之前，查询出错一律当作“有进程”，不卸载，并写回本次撤下的定义。macOS 上 `bootout` 发出之后出错，按上面的“未知”处理，不写回。Linux 和 Windows 的卸载命令不发信号，失败时照 *Outcomes* 写回本次撤下的定义；安装回滚成功卸载后，也照表写回安装前的定义。
- 停止请求沿用 V3 的 `stopVerifiedOwner`，接口不变。它只在收到 `done` 回复后才算成功；超时、连接出错或断开时，`stopHost` 可能已经发出并被接受，调用方分不清。所以任何一次停止请求失败都当作“停止未确认”：立即结束排空，不再发停止，不卸载，不写回定义，注册保持撤下，报告未完成并写明这个 pid。这样不会在可能正在排空的 daemon 之上卸载任务或恢复能重新拉起它的注册；它若已接受停止，就按没有时限的排空自行退出 0。每种失败对应的结果、注册状态和保留的主人列在 plan.md 的 *Outcomes* 表里。

具体设计和原生验收步骤见 [plan.md](plan.md) V5 一节的 *Service gate*。

V3 的 daemon 都由 CLI 启动，没人会再拉起它。停止和重启都先等已经接受的操作做完，并确认它启动的子进程都已退出，才释放 pid 锁，不为赶时间提前放锁。这些子进程包括 Bot 子进程、npm，以及 Codex app-server 和它的进程组。确认不了子进程退出时宁可一直占着锁。2026-11-02 起这条有上限：停止最多 30 秒（见上面"排空有时限"），到点强制结束 Bot 子进程和它报过的 provider 进程组后退出，没报上来的进程组可能留下。关闭 Codex 进程的调用在确认进程退出之前不会返回，清理出错只在确认退出之后才报告，所以上层缓存或忽略这个错误也不会提前放锁。daemon 排空期间仍接受本机凭据认证的连接，但只回答状态查询和停止请求，所以新开的 CLI 能先核实身份再请求停止，不会按 pid 文件里的数字直接发信号。重启后端口不变：一个没有时限的重启助手等旧进程退出后在原端口拉起新进程。旧 daemon 放锁之前收到的停止请求会取消重启：daemon 立即结束重启助手，确认助手已退出后才放锁。具体规则见 [plan.md](plan.md) V3 一节的 *Lifecycle ownership*。

### Bot 运行内核是 vonvon-bot 自己的源码

现在的桌面端 vendor 了 feishu-codex-bridge 的构建产物，并通过 HTTP 调用它。新结构把内核源码复制进 `packages/daemon`，之后两边各自演进。

复制的起点是 feishu-codex-bridge 的 `codex/device-handoff` 分支（`446b2a4`）。现在桌面端 vendor 的就是这个分支，它比 bridge `main` 多 49 个提交，包括桌面端要用的接口、咖啡 Hook 设置和 Codex 用量。

V2 先复制 `446b2a4` 的完整 `src/` 和 `test/`，包括 `src/web`，保留能运行、能对比的 bridge 基线。V2 不增加网页功能。V3 把旧网页控制台的管理路由改成 daemon RPC，然后删除 `src/web`。daemon 没运行时的只读预览页和它的“启动 daemon”按钮一起退役，改用 `vonvon daemon start`，V4 起用 `vonvon open` 打开新界面。私聊菜单卡里指向旧控制台的“网页控制台”按钮也在 V3 去掉，其他按钮不变。等 V4 真正提供新网页后，才考虑加回指向新界面的链接。旧测试里仍然有效的管理行为改成 RPC 测试保留，只有旧页面、静态资源和只读预览的断言可以删除。最终架构不依赖 bridge 的网页控制台。

这样做的理由是独立。vendor 构建产物时，每改一处内核都要在 bridge 仓库提交、发版、再 pin 版本。复制源码以后，一个功能在一个分支里就能改完。

### 设置只存在 daemon 上，云端不存

设置、Bot 列表、群、会话都只存在 daemon 所在的机器上。客户端连上 daemon 才能读到设置，连不上就读不到。这和 Paseo 一样。

理由有三条。第一，设置里有本机路径和 Bot 的 App Secret，不应该离开这台机器。第二，只有一份数据就不需要同步，也不会有冲突。第三，机器离线时 Bot 本来也不在运行，这时改设置没有意义。

### 本机和远程走同一套协议

客户端和 daemon 之间是一套用 zod 定义的 RPC 和事件，跑在 WebSocket 上。本机客户端直连 `127.0.0.1`，用 daemon 写在 `~/.vonvon-bot/local-credential`（权限 0600，每次 daemon 启动都换）里的凭据认证。远程客户端直连对方设备的远程监听，先在 WebSocket 上建端到端加密通道，再在通道里跑同一套帧；以后经云端中继也是同一条通道（见"远程连接和多设备"）。两条路径上的消息完全一样，RPC 处理器不知道对面是本机还是远程，只看这条连接的主体（见"谁能做什么"）。

协议的起点是现在 `desktop/shared` 下的 zod 合同，也就是 `bridge.ts` 的 `commandSchema` 以及 settings、collaboration、environment、machine 四组请求。`commandSchema` 里的 `quit`、`hideWindow`、`setLoginItem`、`chooseFolder` 只和桌面窗口有关，留在桌面端，不进协议。

在此基础上加两样东西。一是握手，客户端发 `hello`，daemon 回自己的 `machineId`、版本和协议版本。二是机器维度：客户端记着几台设备，以 `deviceId` 为键，一台设备可以记几条地址；0.9.0 一次只连当前那一台（product.md 3.14"切换"）。

**协议版本 2 和维护子集（0.9.0）。** `PROTOCOL_VERSION` 升到 2，但不能让 0.8 的桌面端和 daemon 互相卡死：今天两边的握手 schema 都是 strict，`owner-verification` 还要求版本相等，新桌面端会停不掉旧 daemon。所以：
- `hello` 的形状不变（`{ type, protocolVersion, clientKind, credential? }`）；bot 会话令牌也放在 `credential` 里，靠 `vs1.` 前缀认出。
- daemon 按 `hello.protocolVersion` 选 `serverInfo` 的形状：v1 回原来的三个字段，v2 加 `deviceName`、`platform`、`capabilities`、`principal`。Bot 会话的连接（会话令牌，总是 v2）只回 `version`、`protocolVersion`、`principal`，不给设备名、`machineId`、平台和能力（S1b）；客户端解析时 `machineId` 可以没有。客户端一律宽松解析 `serverInfo`，枚举按开放字符串解析。客户端的能力和范围放在握手后的第一条请求 `admin.negotiate { capabilities, scope? }` 里。`capabilities` 是功能开关的唯一来源，客户端不按版本号猜。
- 版本不再要求相等。协议相同、版本号不同只提示；协议不同，连接进入**维护子集**：只收 `admin.daemonStatus`、`machine.checkCoreUpdate`、`machine.applyCoreUpdate`、`machine.coreUpdateStatus`、`command.restartHost`，别的回 `protocol_mismatch`，不推 `snapshot`。这几个请求和回复的形状从 v2 起冻结，`daemonStatus` 加 `startedAt`。排空期间的白名单（`stopHost`、`daemonStatus`，加上 `coreUpdateStatus`，升级时要看进度）和维护子集写成同一个常量 `MAINTENANCE_KINDS`。
- `owner-verification` 的核实和停止不再比版本：宽松解析 `serverInfo`，只取 pid，再 `stopHost`。本机 daemon 是桌面端自带的（`bundled`）且协议不同，就照旧换成自己带的。原来"本机是独立安装的服务端（`standalone`）就按维护子集连上、显示升级条"一条，2026-11-01 起 Mac、Windows 上没有 `standalone`，不做。

### 远程连接和多设备

一台"设备"就是一个数据目录上的 daemon，加上 `vonvon` 命令，可能还有桌面端外壳。别的设备上的桌面端连过来管它；CLI 永远只连本机。完整设计、文件格式和关闭码在 [devices.md](plans/devices.md) 第 3、4 节，用户看到的行为在 [product.md](product.md) 3.14。

```text
  device A (Mac, desktop)                          device B (Linux, install script)
  desktop shell --loopback + local-credential--> daemon A    daemon B (systemd user service)
  vonvon CLI ----same--------------------------> daemon A      loopback listener: always on
  bot session --loopback + vs1 session token---> daemon A      remote listener: only on user-enabled IPs
                                                               device.json / clients.json / remote.json
  "Devices": This computer * / Linux server o
     switch to "Linux server" --Tailscale / LAN--> Noise channel --> same RPC and events
```

**设备身份。** 每个数据目录一份 `device.json`（0600，首次启动生成）：`deviceId`（就是原来的 `machine-id`）、名字（默认主机名）、一对 X25519 静态密钥。已配对的客户端存在 `clients.json`，开启的远程地址存在 `remote.json`。三个文件都加进只读、读写档会话的读拒绝名单 `ROOT_SECRETS`，并有测试保证数据目录根上 0600 的文件都在名单里。`local-credential` 每次 daemon 启动都换，daemon 重启的空档里被同机别的账号截走的旧凭据就没用了。

**两种监听。** 一条连接是本机还是远程，只看它从哪个 `http.Server` 进来，不看 Host、来源地址或第一帧的样子。
- loopback 监听永远开着，端口和 `daemon.pid` 的 `listen` 字段都不变，现有对 `127.0.0.1:` 的检查都不动。
- 远程监听是另外一个 server，只绑用户明确开启的那一个字面 IP（A1：只开一个，再开一个就换掉原来的，旧的先关、连接 4006），端口固定（默认 7767，写进配对链接，所以不随机）。它有自己的请求处理器：只有 `GET /health`（回 `{ ok, protocolVersion }`，不回设备 id、名字和版本）和 WebSocket 升级，不提供网页。Host 必须等于一个已开启的地址，请求带 Origin 一律 403（本期浏览器不远程连），跨站 WebSocket 和 DNS 重绑在门外就挡住了。远程监听上不接受 `credential`，也不接受会话令牌。
- 地址分 `loopback`、`tailscale`、`overlay`、`lan`、`cgnat`、`public`。100.64/10 也是运营商 CGNAT 段，所以要在 Tailscale 网卡上、或在 `tailscale ip` 的输出里才算 `tailscale`，否则归 `cgnat`。`overlay` 是别的组网工具（ZeroTier、蒲公英、EasyTier、NetBird、WireGuard 等）网卡上的地址，按网卡名认（A1）。`public`、`cgnat` 要显式确认，`0.0.0.0`、`::` 和链路本地 IPv6 直接拒绝。地址还没出现时每 15 秒重试；`lan` 地址记下网卡和网络标识，换了网络进入"需要确认"，不自动重绑；`overlay` 地址只核对它还在组网网卡上（编号变了不算）。开关在运行中生效。候选地址（`vonvon remote candidates`）默认不列虚拟网桥和代理软件的 fake-IP。
- 生命周期：开始排空时停止绑定重试、不接新连接；释放时关掉所有远程 server 并等它们关完。

**加密通道。** 远程连接一律走端到端加密通道，本机 loopback 不走。做法见下面"远程访问端到端加密"。握手没完成前不处理任何帧；通道之上是原来的 `hello`、`serverInfo` 和 RPC 帧，一个字节不改。

**配对。** 被连的那台生成连接链接 `vonvon://pair#<base64url(JSON)>`，JSON 里有 `v`、设备的 `id`、`name` 和静态公钥 `pk`、开启的地址列表、一次性邀请 `{ id, secret, expiresAt }`，以及恒为 `null` 的 `relay`、`account` 两个预留槽。邀请只存在 daemon 内存里，10 分钟过期，用一次就作废，同时最多 3 个没用的，所以生成链接要 daemon 在跑（`device.pair`）。客户端为这台设备生成一对新的 X25519 密钥，按链接里钉死的设备公钥建通道。通道建好后，daemon 查客户端的静态公钥：在 `clients.json` 里就是已配对的主人；不在就是 `unpaired`，不回 `serverInfo`，只收一帧 `pairRequest { inviteId, inviteSecret, clientName, clientKind }`，5 秒内没有或核对失败就关。核对邀请用常量时间比较，只登记通道里认证过的公钥，成功后这条连接升为已配对、补发 `serverInfo`。之后每次连接都是通道的双向认证，没有能被复制的令牌。

**授权和撤销。** `clients.json` 每条记名字、公钥、类型、配对时间、最近连接时间和地址、`invitedBy`（本机发的邀请，还是哪个已配对客户端经 RPC 发的，用于级联撤销）。授权不过期，撤销不删条目，写 `revokedAt` 墓碑，被撤销的客户端重连收到 `client_revoked` 而不是"从没配过"。每次写文件 `generation` 加一；每条连接记下认证时的 `generation`，处理每条 RPC 前在内存里核对一次这个客户端仍有效。撤销时先改文件，再关掉它的所有连接，再取消它发起、还没结束的任务和日志订阅。新客户端配对成功发诊断事件 `client-paired`，被连的那台桌面端弹提示。

**挡滥用。** 限流在做任何 DH 之前：每个来源 IP 最多 4 条、全局最多 32 条未认证连接；每个 IP 一个令牌桶（每分钟 20 次握手，失败都计数，带有效邀请的配对握手不计未知公钥）；公网和 `cgnat` 地址再加全局每秒 10 次。未认证阶段 `maxPayload` 4 KB、握手超时 3 秒。封禁只在内存里。

**保活、重连和关闭码。** 远程通道上客户端每 20 秒发一帧通道内的 `ping`，30 秒没回算断；daemon 60 秒没收到任何帧就关。客户端按 `min(30s, 1s × 2^n)` 退避重连当前设备，重连后比较 `machineId` 和 `daemonStatus` 的 pid、`startedAt` 判断对方是否重启过。关闭码：4001 `protocol_mismatch`、4002 `unknown_client`、4003 `client_revoked`、4004 `rate_limited`、4005 `handshake_failed`、4006 `remote_disabled`、4007 `pairing_failed`，原来的 1001、1008 不变。

**CLI 的设备命令。** `vonvon remote`、`pair`、`clients`、`device` 在 daemon 跑着时走 loopback 的 `device.*` RPC（撤销要立即断连、开关地址要运行中生效、邀请只在 daemon 内存里），daemon 是唯一写入者这条不变；daemon 没跑时，除 `pair` 以外在数据租约下直接写文件。

**客户端一侧。** 桌面端用 Electron `safeStorage` 加密保存设备列表 `userData/devices.json`：每台设备的 `deviceId`、名字、公钥、为它生成的那对客户端密钥和几条到达它的路。一次只连当前设备，切换就是把界面的客户端对象换成那一台的；不是当前的设备不保持连接。网页端不存设备，本期不远程。当前设备是远程时，外壳里只管本机的事（启动本机 daemon、登录项、改 PATH、退出时停 daemon、原生目录对话框、在 Finder 里显示）一律不作用在对面，选目录走 daemon 的目录浏览 RPC。外壳对本机 daemon 的那条连接在切到别的设备时仍保留。

**以后的中继和账号。** 到达一台设备的路叫 `DeviceRoute = { kind: 'direct', host, port } | { kind: 'relay', … }`，本期只有第一种。通道跑在任何一条路上，`hello` 以上不变；中继只是多实现一个 `connectRoute(route)`，它看到的只有密文。配对链接的 `relay`、`account` 两个槽以后填上，`v` 不变；`clients.json` 的条目以后加 `accountId?`，账号下的设备自动出现在客户端列表；`device.json` 的密钥对直接登记到账号，不用换密钥（见"远程访问端到端加密"和"账号不是使用前提"）。

### 谁能做什么：主体和权限表

每条连接认证后有一个主体，每条 RPC 在 `dispatch` 之前先过 `authorize(peer, request)`（`packages/daemon/src/server/authz.ts`）。完整的表在 [devices.md](plans/devices.md) 第 5 节，产品规则在 [product.md](product.md) 3.7"在哪能改设置"。

| 主体 | 怎么认出 | 权限 |
|---|---|---|
| 本机主人 `owner`（local） | loopback + `local-credential` 对上 | 全部 |
| 已配对客户端 `owner`（paired） | 远程通道里客户端公钥在 `clients.json` 且没撤销 | 全部（能连上的都当主人本人），只少 `machine.desktopUpdateReport`（只收本机桌面端外壳） |
| 待配对 `unpaired` | 远程通道里公钥不在 `clients.json` | 只收一帧 `pairRequest`，5 秒关 |
| bot 会话 `bot-session` | loopback + `hello.credential` 是有效的会话令牌（`vs1.` 开头） | 按令牌绑的地方分私聊、群、云文档评论，见下 |
| 维护 `maintenance` | 任一主人身份但协议版本不同 | 只有维护子集 |

- 权限表是一个 `Map<'method.type', Rule>`，表里没有的一律拒绝（`permission_denied`），测试保证协议里的每个 kind 都在表里。bot 会话这一列分两类：daemon 自己能判的（只看令牌绑的 bot、地方、群和 `--scope`），和必须问 Bot 进程的。
- 必须问 Bot 进程的那类，daemon 经 IPC `authorizeSessionCall(sessionId, action)` 交给所属 Bot 进程，由它按这条会话活着的那一轮跑和进程内工具完全相同的 `authorizeNow`、`authorizeMemory`、`authorizeSchedule`，回 `ok` 或 `refused(reason)`；没有活着的一轮就 `turn-ended`，挡住"一轮里起个后台进程过一小时再调"。记忆落点要的这一轮角色也由 Bot 进程在同一次 IPC 里回。
- 群令牌和评论令牌的设置读写、建群在 daemon 就拒，回 `not-dm`（文字复用进程内工具的"群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"），不问 Bot 进程，Bot 进程退了也照样拒。群会话没有设置工具，也不读设置（2026-11-02，`docs/plans/settings-dm-only.md`）。绑已有群、解绑、密钥、`environment.*`、`machine.*`、`admin.*`（只放 `daemonStatus`、`negotiate`）、`device.*` 对所有会话令牌都拒。群令牌只给干活要用的（s1b，owner 2026-11-02，白名单）：本群定时任务、本群项目和 Bot 的记忆（`list / add / edit / archive`，读回的条目不带作者）、本群成员、`admin.negotiate`，加一份只剩本 bot 和本群名字的快照（`sessionSnapshot`）；群列表、待绑定的群、模型、会话、项目列表、群详情、记忆导出和历史、daemon 状态都拒。私聊令牌的读也要主人或管理员那一轮。
- 会话令牌 `vs1.<sessionId>.<随机 32 字节>`：Bot 进程起会话时经 IPC `issueSessionToken` 向 daemon 要，daemon 在内存里记它绑的 bot、群、地方和会话，会话结束（`revokeSessionToken`）、Bot 进程退出或 24 小时没用就作废，不落盘。令牌放进会话的 `VONVON_SESSION`。会话里的 CLI 不读、不发 `local-credential`，只发令牌；看起来在会话里却没有有效令牌就退出 4（`session_token_missing`），绝不退回主人身份。
- `--scope bot=<appId>[,group=<chatId>]` 经 `admin.negotiate` 送到，上限按会话算（群会话是本 bot 加本群，私聊会话是本 bot 加它的所有群），缺了或更大一律拒绝，只能缩小；范围不放宽地方的规则。运维和设备类的本地命令（`daemon run|start|stop|restart`、`service *`、`update`、`remote *`、`pair`、`clients *`、`device rename`、`bot repair-dir`、`secrets get`、`open`）在会话里由 CLI 先拒（`not_in_session`）。
- 边界照实写：完全访问档的会话能读这个系统账号的任何文件，包括 `local-credential`、`device.json`、`clients.json`，拿到就是主人；客户端私钥靠 `safeStorage`，Windows 上同一用户的进程能解开，所以一台装了完全访问档 Bot 的电脑，它配对过的设备都在同一个信任范围里。令牌和范围挡的是失误和一般越权，不是完全访问档的安全边界；只读、读写档的沙箱本来连不上 daemon。彻底挡要让 Bot 换系统账号跑，以后再做（product.md 第 10 节）。

### 快照给界面，管理状态单独读

daemon 提供两种读状态的方式。`snapshot` 请求和 `snapshot` 事件用 V1 的 `DesktopSnapshot`，供界面使用，带递增的数字 revision。这个数字只出现在快照里，以及 `command` 和 `admin` 里本来就定义为数字 revision 的 `applied` 回复里。settings 和 collaboration 里的字符串 revision 仍是各自设置段或项目的并发令牌，含义和形状都不变。`admin` 组的 `state` 请求原样返回旧网页控制台 `GET /api/state` 的内容。其中 Bot 的字段包括进程号、启动时间和完成提醒，项目的字段包括话题数、分支和创建时间。会话列表走 `settings` 组的 `sessions` 请求。

分开读有三个理由。界面只需要投影后的数据，快照事件不必每次带上进程字段和头像。旧状态的字段一个不丢，V3 能逐字段核对新旧两条读路径。快照形状不变，V4 移植界面时不用改合同。

请求、事件、任务和 revision 的具体规则写在 [plan.md](plan.md) 的 V3 一节。

### 界面沿用现在的 React 界面

界面保留现在的 React 19 + Vite 代码和 `desktop/renderer/reference` 里的 UI 组件，也就是原来的样式。改动是把直接调用 `window.bridge` 的地方换成注入的客户端对象。

同一份界面构建产物用在三个地方：daemon 在本机提供的网页、Electron 桌面窗口、云端托管的网页。

Paseo 的界面是 Expo 和 React Native Web，搬过来要重写全部界面，所以不用。

### 目录选择交给 daemon

现在的桌面端用 Electron 的原生对话框选项目目录，再把结果包成 `FolderToken`。远程客户端打不开另一台机器上的原生对话框，所以新结构由 daemon 提供目录浏览 RPC，所有客户端用同一个。Paseo 的 `directory_suggestions_request` 是同样的做法。目录浏览不限家目录，daemon 所在账号能读的都能选，本机和远程一样（owner 2026-10-31：服务器上的代码常在家目录以外；daemon 本来就以这个账号运行，原来的限制只防误点）。手动输入的路径按 daemon 所在系统解析，也认 Windows 路径。

Codex 可执行文件也一样不用原生对话框的令牌：界面让用户填路径，用现有的主机设置保存 `execution.codexBin`，由 daemon 检查路径。桌面端多提供一个原生文件对话框，选出的路径走同一条保存流程。打开链接和复制链接在客户端里做，因为远程连接时 daemon 打开的窗口会出现在另一台机器上。退出、隐藏窗口、开机自动运行、桌面端更新这些只和桌面应用有关的操作，通过界面里可选的外壳能力对象交给桌面端，网页版不提供它们，只显示说明。

### Provider 层只接原生能力，权限按格验证

设计全文在 [providers.md](providers.md)，这里只说决定和理由。2026-10-12 的重设计取代了原来复制 Paseo provider 闭包的方案。

Bot 层只看一个对象 `ProviderRuntime`。它为一个项目和一个群打开 `Conversation`，发送用户输入，得到一个 `Run`，`Run` 是 `RunEvent` 的异步流。卡片用纯函数把事件折成 `RunView` 再渲染。`provider/` 以外的代码不出现 provider 编号、工具名和协议字段。原来的 `AgentBackend`、`AgentThread`、`AgentRun`（`packages/daemon/src/agent/types.ts`）和它的两个后端在 V6b 删除，39 个源文件调用方和 72 个测试切到新合同。没有原生插话的 provider，运行中收到的新消息进 `QueuedTurn` 队列，本轮结束后按顺序发出。

每个 provider 是一个小的 `Engine`。它只做两件事：把协议帧翻译成 `RunEvent`（纯函数 `translate`，用录下的 `.jsonl` 固定样本测试），以及把权限计划变成启动参数。回合状态机、停止梯、子 agent 和 todo 账本、图片落盘、进程托管都在运行时里，每个 provider 共用一份。停止在每个引擎上都有时间上限：先发原生中断，超时后 SIGTERM，再超时 SIGKILL，Codex 最长 11.5 秒。

能力只接原生的，一项不模拟。`ProviderFeatures` 是类型化的数据，每格是 `native`、`partial` 或 `none`，审计里标“未知”的格按 `none` 发布，并记下要跑的实测。五项基线（子 agent、todo、图片输出、回合结果和原因、可靠中断）也按这个规则：provider 没有原生信号，卡片就不显示那一块。Paseo 聊天模式是从原生信号显示内容的下限，Vonvon 另外接上 Paseo 没接的原生能力：Claude 的 `stopTask` 和 Grok 的 `_x.ai/subagent/cancel` 单独停一个子 agent，Cursor 的 `cursor/task`、`cursor/update_todos`、`cursor/generate_image`，Grok 的子 agent 和结束原因，Codex 的 `account/rateLimits`。ACP 的 `refusal`、`max_tokens`、`max_turn_requests` 是三种不同的失败，不再并成完成。agent 自己声明的斜杠命令算原生能力，所以 Claude 通过 `supportedCommands()` 里的 `/compact` 原生压缩，Grok 的压缩按同一规则，等实测确认。现有 Claude 后端用提示词循环模拟 goal，这一处删掉不搬。Cursor 的 `cursor/task` 是子 agent 完成信号，只能显示已完成的子 agent。会话标题是 Vonvon 自己的功能，不是 provider 能力，也不算模拟。daemon 的 `TitleService` 在第一轮开始后跑一次不带工具的单次调用，先用项目自己的 provider，再用已安装的 Codex 或 Claude，都不行就截取第一条消息的前 36 个字，限时 30 秒，有原生标题就写回 provider，否则写进会话记录。停止时先逐个停能单独停的子 agent，再走主回合的中断梯，到结束时还在跑的子 agent 记为已中断。

权限只有 `qa`、`write`、`full` 三档，没有审批卡。读取范围是项目级设置，“仅项目目录”或“不限读取”。每个 provider、每档、每种读取范围、每个操作系统是权限表里的一格。一格只有带证据（在那个系统上对已安装版本跑过实测并提交了记录）才算“已验证”，否则是“拒绝”，拒绝时不启动进程，在群里发中文说明。构建时的测试检查每个已验证的格都有证据。Codex 用 `feishu` 权限 profile 和沙箱策略，macOS 的 Seatbelt 能限读，Linux 的 Landlock 不能，所以 Codex 在 Linux 上的“仅项目目录”拒绝。Claude Code 的沙箱只管 Bash，所以 `Read`、`Grep`、`Glob`、`Edit`、`Write` 由 daemon 的 PreToolUse 钩子按真实路径放行或拒绝。`qa` 和 `write` 用 `permissionMode: 'default'`，沙箱通过 SDK 的 `Options.sandbox` 传入，`full` 用 `bypassPermissions`。没有 Seatbelt 或 bwrap 的机器上，`qa` 和 `write` 照常运行但关掉 Bash，并在群里发中文说明，文件工具仍由钩子限制。`qa` 和 `write` 不加载 MCP 服务器（`strictMcpConfig`），同样发中文说明。ACP agent 和 Pi 没有沙箱，默认只支持完全访问，Grok 的只读档要等实测证明它在改文件前会先问。provider 的每个请求（审批、向用户提问、计划模式）都由 daemon 按计划立刻自动应答，卡片从不等待。

ACP 客户端是 Vonvon 自己的一层薄封装，不用 SDK 的 `ClientSideConnection`，因为后者用 zod 校验每条 `session/update`，Grok 的 `subagent_spawned` 会被拒掉。不认识的更新类型、`_meta` 和非标准方法都交给方言处理。Cursor、Grok、自定义 ACP 各一个方言，加一个 provider 只需一条注册和一个方言。Copilot 和 OpenCode 推后。

进程托管由所有 provider 共用。每个 provider 进程都由一个托管进程（holder）启动：POSIX 上是 Vonvon 自带的原生小程序 `vonvon-holder`，Windows 上是改写后的 `windows-job.ts` 监管进程。holder 是 provider 的父进程，退出前一直持有它不回收，只对自己持有的进程组或 Job 发信号；daemon 只通过管道向 holder 下命令，从不按数字 pid 发信号。Claude 的 CLI 子进程通过 SDK 的 `spawnClaudeCodeProcess` 接到同一个 holder 上。每次启动在 `process-owners.json` 里记一条按预留编号索引的记录，每一步都先落盘再继续。daemon 异常退出时命令管道关闭，holder 自己结束整棵树再退出。下次启动只读记录和存活探测，不发信号；证明已清空的记录删除，证明不了的记为未确认，在 `vonvon doctor` 里列出，并在它清空前拒绝启动新的 agent。旧版 `owned-pids.json` 的记录不发信号、不阻塞启动，主机重启后删除。细则见 [providers.md](providers.md) *Process host*。

出站路径只有一处判断。Claude 的钩子和飞书上传图片、发文件共用 `judgePath`，按真实路径判断是否在项目内，这修掉 #114 里符号链接绕过的问题；远程图片只在项目开了联网时才取，`full` 也一样，联网开关在每一档都由 Vonvon 自己检查，且永远拒绝回环、内网和链路本地地址。

### 数据目录是 `~/.vonvon-bot`

所有系统都用 `~/.vonvon-bot`，可以用 `VONVON_HOME` 覆盖。用户主目录下的固定路径在没有桌面的服务器上也好找，Paseo（`~/.paseo`）和 bridge（`~/.feishu-codex-bridge`）都是这样。

按 Bot 分目录的形状沿用 bridge（`bots.json`、`bots/<appId>/config.json`、`projects.json`、`sessions.json`），导入时基本是复制。读文件时用 zod 校验，写文件时先写临时文件再改名。

密钥用 `~/.vonvon-bot/master.key`（权限 0600，随机生成）加密。bridge 的密钥由主机名和用户名派生（`src/config/keystore.ts:75`），改了主机名就解不开，所以不沿用。

### 导入 bridge 数据时先停旧服务，成功后再永久关停

导入分两步。第一步是只读预检，列出要导入的 Bot、群、会话和设置，并检查 bridge 是否在运行。用户确认后执行第二步，顺序如下。

1. 暂停 bridge 服务。
2. 复制数据，用新密钥重新加密 App Secret。
3. 把 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 里的咖啡 Hook 命令改成 `vonvon hook`。
4. 在 daemon 里启动导入的 Bot，确认每个 Bot 的飞书长连接已经连上。
5. 永久移除 bridge 的开机自启，并在 `~/.feishu-codex-bridge/` 写入 `migrated-to-vonvon-bot.json` 标记。

任何一步失败，导入都会恢复 bridge 原来的服务。整个过程写 journal，进程崩溃后重新运行会接着做或者回滚。`~/.feishu-codex-bridge` 里的原始数据保持不动，作为备份。

先暂停再复制有两个原因。bridge 运行时还在写 `sessions.json`，边写边复制会得到不一致的数据。另外，两个进程连同一个 Bot 时，飞书的事件会分到两边。按飞书对长连接模式的说明，同一应用的多个客户端只有一个会收到某条事件。这一点还没有实测，roadmap 把它列为要验证的事。

实现参考 vonvon-bridge-legacy 的 `packages/runtime/src/cli-migration-*.ts` 和 `legacy-cli-control.ts`。legacy 只处理了 macOS 的 launchd，Linux 的 systemd 和 Windows 的启动项要新写。

### 账号不是使用前提

不登录也能完整使用本机的 Vonvon Bot，包括导入 bridge 数据。0.9.0 没有账号：别的设备上的桌面端靠配对链接连过来管（见"远程连接和多设备"）。以后加账号，登录只用来把这台机器加到账号下，让它自动出现在账号下其他设备的客户端列表里，并能经中继、在网页上管理；配对、授权和加密通道不变。下面是账号以后的做法。

登录用飞书或 Lark 的网页 SSO，实现参考 vonvon-platform 的 `src/oauth.ts`。桌面端打开浏览器登录，然后轮询结果。没有桌面的服务器运行 `vonvon login`，它打印一个链接和验证码，你在任意浏览器里打开链接确认。

机器加入账号时，daemon 生成自己的设备凭据，和用户的登录会话分开。用户退出登录不会让机器掉线。从账号里移除机器时，云端吊销设备凭据。凭据和登录会话分开的做法来自 vonvon-bridge-legacy 的 `packages/account-service`，但不照搬它和登录绑定的会话、设备和快照记录。云端私有存储的形状见下面的“核心数据形状”。

vonvon-bridge-legacy 的 ADR 0012 规定必须登录、暂不做多设备。这份架构推翻了这条决定。

### 远程访问端到端加密

2026-10-31 改：远程加密从"连云端时才加密、移植 Paseo 的 tweetnacl 通道"提前到"直连就加密"，改用 `node:crypto` 上的标准 Noise，不加依赖；以后的中继复用同一条通道（[devices.md](plans/devices.md) 4.4）。原来移植 Paseo `packages/relay` 的方案（XSalsa20-Poly1305、`tweetnacl`、`base64-js`、V11 的 *Compiler contract* 和 `closure.json`）作废，仓库里没有引入过它们。

为什么直连也加密：不强制 Tailscale，现实里会有人走局域网甚至公网直连，而协议里跑的是 App Secret、决策模型的 key 和会话内容，明文 WebSocket 一截就有。通道自带设备身份（设备公钥在配对链接里钉死）和客户端身份（配对时登记的公钥），所以授权就是公钥，没有能被复制、能在 URL 里泄露的 bearer token，撤销一台不影响别的。不选 TLS：浏览器本期不远程连，TLS 唯一的好处用不上，自签证书要维护轮换，也挡不住"设备公钥换了"这类身份问题。

做法（`packages/protocol/src/secure-channel.ts`，daemon 和客户端共用）：
- 套件 `Noise_IK_25519_AESGCM_SHA256`，配对握手和已配对的连接都用它。X25519 用 `crypto.diffieHellman`，AEAD 用带 AAD 的 `aes-256-gcm`，HKDF 用 `crypto.hkdfSync`，哈希 SHA-256；AES-GCM 在 Electron 的 BoringSSL 下可用。
- 选 IK 不选 XX：客户端已经从链接拿到设备公钥；少一个往返；设备的静态公钥不会发给任何发起握手的人（公网扫描器不能凭它跨 IP 追踪设备）；daemon 在第一条消息里就知道客户端是谁，未知公钥进 `unpaired`。
- prologue 是 `"vonvon-secure-channel/1"`，第一条消息前缀 1 字节版本号，两者都进转录哈希，以后出 `/2` 不能被降级。DH 结果全零按 `handshake_failed` 拒。
- 帧是 `[8 字节计数器][AES-GCM 密文和 tag]`，nonce 是 4 字节零加计数器，计数器严格递增，重放、乱序直接关 socket。
- 客户端核对设备公钥和链接里的 `device.pk`，不同就是 `device_identity_changed`，不按首次使用自动信任：重装服务端后每台客户端要重配一次。前向保密靠临时密钥。
- 测试直接跑 Noise 官方向量里的这个套件，再加篡改转录哈希、换 prologue、重放帧的互测；这段代码单独一片，另一个模型再做一轮多角度审查。

本机 loopback 不走通道。loopback 端口全机的系统账号共用，本机客户端一连上就发明文凭据，daemon 重启的空档里同机别的账号能抢端口收凭据。所以 `local-credential` 每次 daemon 启动都换，空档里截到的是旧凭据；抢占让新 daemon 绑不上端口时它直接失败退出，由服务管理器稍后重试。Unix socket、命名管道或挑战应答以后再做（product.md 第 10 节）。

以后加账号时，云端存账号和机器记录，机器记录包括名称、系统、版本、公钥和最后在线时间，不存设置，也读不到转发的内容。daemon 加入账号时把 `device.json` 里那把 X25519 公钥登记到云端，不另生成密钥；中继只转发 Noise 通道的密文。云端分发的公钥要不要再经配对之类的线下方式核对，到时候和账号一起定。

同一个 Bot 只能在一台机器上运行，否则飞书事件会分到两台机器。云端不存 Bot 列表，所以由客户端检查。客户端同时连着多台机器时，如果发现同一个 `appId` 在两台在线机器上都启用了，就提示用户。0.9.0 的客户端一次只连一台，做不了这项检查，等账号下的设备列表一起做。

### 云端代码放在同一个仓库

云端是 `packages/cloud`，和 daemon 共用 `packages/protocol`。改协议的功能在一个分支里就能同时改 daemon、客户端和云端。

vonvon-platform 只有约 1170 行，数据存在一个 JSON 文件里，只能单实例运行。它的飞书和 Lark 登录代码可以直接用，其余部分重写。生产存储用 Postgres，测试用内存实现。部署平台还没定。

### 桌面端只是外壳

桌面端用 Electron。它启动时检查本机 daemon，在运行就直接连上。如果没在运行，而这个数据目录已经注册了系统服务，就交给服务管理器启动；没有注册，才用内置的 daemon 拉起来，方式是用 Electron 自带的 Node 运行（`ELECTRON_RUN_AS_NODE=1`），做法同 Paseo 的 `packages/desktop/src/daemon/node-entrypoint-launcher.ts`。

桌面窗口加载和网页相同的界面。托盘、单实例、自动更新沿用现在 `desktop/main` 的实现。

桌面端既是本机 daemon 的外壳，也是别的设备的客户端（见"远程连接和多设备"）。连着别的设备时，外壳里管本机的事一律不作用在对面。

桌面端内置的 daemon（`bundled`）和 `npm i -g vonvon-bot` 装的 daemon 共用 `~/.vonvon-bot` 和同一把 pid 锁，所以同一时间只会有一个在运行。版本不同时以协议版本判断能否连接（见"本机和远程走同一套协议"的维护子集）。2026-11-01 起安装脚本装的服务端（`standalone`）只在 Linux，Linux 没有桌面端，所以桌面端一侧只剩退出规则：退出时停本机的服务端，只有"不是 `bundled`、又另外注册成后台服务"的不停（比如 npm 装后 `vonvon service install`，它退 0 以后服务管理器不再拉起）。原来的登录项显示、启动修复只提示升级、认 `vonvon` 标记三条不做。安装脚本在 Linux 上发现这台已经装过（daemon 在跑、服务已注册、装过服务端、或 PATH 上有带标记的 `vonvon`）就跳过，什么都不动。

### 服务端独立安装和升级

0.9.0 起，Linux 能一条命令只装服务端、`vonvon` 命令和后台服务（[product.md](product.md) 3.10"只装服务端"，[devices.md](plans/devices.md) 第 7 节）。Mac、Windows 不做只装服务端，只用桌面端安装包（owner 2026-11-01，devices.md 第 19 节）；`install.sh`、`uninstall.sh` 在 macOS 上只打印去 https://vonvon.cc/get/ 下载安装包、退出非零，什么都不碰。
- 新发行种类 `standalone`，靠安装根里的 `standalone.json` 识别，先于 `.git` 祖先检查。包里是 `app/`（`package.json`、`bin/vonvon.mjs`、压缩后的 `dist/cli.js`、`ui/dist/`、第三方 `node_modules/`）和官方 Node 24 LTS 二进制；不带 source map、TypeScript 源码和 `.d.ts`。`stageDaemon` 的这些改动对桌面端自带的 daemon 同样生效。只发两个包：`linux-x64`、`linux-arm64`（只支持 glibc，`.tar.gz`），包里不能有符号链接。I1 的打包脚本原来还能打 darwin、win 四个目标（`.zip`、Windows 的 Node 和 npm 布局、260 字符预算），launchd 也接受 `standalone`；这些已由清理片 I6 删掉，launchd 只装桌面端自带的和 npm 装的服务端。
- 安装根是 `~/.local/share/vonvon-bot/server/`，版本放在 `releases/<version>/`。当前版本是原子替换的符号链接 `current`（原来给 Windows 的指针文件 `current.txt` 不做）。命令和服务定义都指向安装根里固定的启动器，exec `app/bin/vonvon.mjs`；服务定义对 `standalone` 不解析 realpath，升级只换 `current`。托管安装用的可信 npm 从 `process.execPath` 推出同一版本里 Node 自带的那份，不靠环境变量。
- 升级：清单 `bot/server/stable/manifest.json` 用单独的 Ed25519 密钥签名，签名内容含 `product`、`channel`、`version`、`linux-x64` 和 `linux-arm64` 两个包的 URL 和 sha512；只接受比当前和历史最高都新的版本，`publishedAt` 不倒退。`machine.applyCoreUpdate` 在 `update.lock` 里下载、核对、改名到 `releases/<v>/`，**先原子切 `current` 再请求重启**（排空、退 75、管理器拉起的就是新版本）；重启助手核对新进程的 `serverInfo.version`，不对或超时就切回上一版。`vonvon update` 发同一个 RPC，并在 daemon 重启的那一刻改读本机 `update-status.json`。
- 桌面端自带的服务端（`bundled`）不自己换文件：daemon 发事件 `desktopUpdateRequest` 给本机声明了 `desktop.self-update` 能力的外壳连接，外壳跑它已有的应用更新（macOS Squirrel、Windows electron-updater），用 `machine.desktopUpdateReport` 回进度，daemon 映射到 `coreUpdateStatus`；排空沿用现有的 `beforeUpdateInstall` 和启动修复。外壳没连着就回 `desktop_not_running`。
- 安装脚本（`install.sh`，只在 Linux）只做下载、核对、解包和调 `vonvon`，逻辑尽量放在 `vonvon` 里（`service install`、`remote`）。先看系统，不是 Linux 就退出；再看 root，是 root 默认拒绝。
- 安装脚本解包到 `releases/<v>.part`，核对完改名成 `releases/<v>/`，再用包里的 Node 跑隐藏命令 `vonvon __standalone-setup`：它调升级引擎同一个 `switchCurrent`（`D/service/current-release.ts`，[server-3](plans/server-3-update-engine.md) §4.1 的 C5）切 `current`，写跟着 `current` 走的 `bin/vonvon` 和 PATH 块。PATH 块的文本和拼接在 `@vonvon/protocol` 的 `cli-path-block.ts`，桌面端和 daemon 共用（[server-2](plans/server-2-install-scripts.md) §4.3、§4.6）。

## 核心数据形状

daemon 上的数据按机器、Bot、群、会话四层组织。

```ts
type Machine = { machineId: MachineId; name: string; platform: string; version: string };

type Bot = { appId: AppId; name: string; enabled: boolean; ownerOpenId: string };

type Project = {
	appId: AppId;
	chatId: ChatId;
	name: string;
	cwd: string;
	provider: ProviderId;
	mode: 'qa' | 'write' | 'full';
	readScope: 'project' | 'unrestricted';
	network: boolean;
	response: 'mention' | 'all';
	sessions: 'threads' | 'shared';
};

type Session = {
	appId: AppId;
	threadId: ThreadId;
	chatId: ChatId;
	cwd: string;
	provider: ProviderId;
	providerSessionId: string;
	model?: string;
};

type SettingsScope =
	| { kind: 'host' }
	| { kind: 'bot'; appId: AppId }
	| { kind: 'project'; appId: AppId; chatId: ChatId }
	| { kind: 'session'; appId: AppId; threadId: ThreadId };
```

`AppId`（`cli_` 开头）、`ChatId`（`oc_` 开头）、`MachineId` 都是 branded 类型。

上面是逻辑形状。存储里 `Project` 的字段仍叫 `backend`，会话记录仍叫 `backend` 和 `sessionId`，不改名。V6b 在加载时迁移旧编号，`codex-appserver` 变成 `codex`，`claude-agent` 变成 `claude`。没有 `readScope` 的已有项目加载为 `unrestricted`，新建项目写入 `project`，这是显式的加载迁移，不是 zod 默认值。管理员在私聊的项目设置卡片和网页的项目设置里修改读取范围。客户端用 `(machineId, appId, chatId)` 定位一个群。

云端对外只有两种记录。

```ts
type Account = { accountId: AccountId; provider: 'feishu' | 'lark'; subject: string; name: string };

type Device = {
	deviceId: DeviceId;
	accountId: AccountId;
	machineId: MachineId;
	name: string;
	platform: string;
	version: string;
	publicKey: string;
	lastSeenAt: string;
};
```

### 云端私有存储

上面两种是对外的记录。云端另有两张私有表，不出现在任何 API 回复里，也不存设置。`Account` 按 `(provider, subject)` 唯一。同一账号下，同一个 `machineId` 最多一台未吊销的设备。

```ts
type DeviceCredential = {
	deviceId: DeviceId;
	secretHash: string;       // daemon 本地生成的 32 字节密钥的 SHA-256，十六进制
	createdAt: string;
	revokedAt: string | null;
};

type DevicePresence = {
	deviceId: DeviceId;
	linkState: 'open' | 'closed';
	heartbeatAt: string;
};
```

- 校验。daemon 每次建立出站连接时带上 `deviceId` 和密钥原文用于认证，这是密钥离开 daemon 的唯一场合。云端对收到的密钥算哈希，与存的哈希做常量时间比较，然后丢弃原文，不存储也不写日志；云端存储里只有 `secretHash`。吊销或未知的设备被拒绝。登录会话从不用来认证这条连接。不另加挑战应答协议。
- 重新加入。同一账号、同一 `machineId` 再次加入时原地轮换：`deviceId` 不变，换新的哈希和公钥，旧凭据立即失效。别的账号的设备不读也不改。
- 吊销。设置 `revokedAt`，关掉这台设备的连接并回 `device_revoked`，daemon 收到后删除本地凭据。吊销后再加入会得到新的 `deviceId`。
- 在线状态。连接每 15 秒发一次心跳。连接打开、且最近一次心跳不超过 45 秒时算在线，否则离线。对外的 `lastSeenAt` 由这张表推出。云端重启时所有连接记为关闭。
- 存储。一个仓库接口，Postgres 和内存两种实现，用同一套合同测试。
- daemon 本地。`cloud/device.json`，权限 0600，存云端地址、`accountId`、`deviceId`、密钥和 X25519 私钥，其中密钥和私钥用 `master.key` 加密。X25519 私钥从不离开本机。密钥只在上面的连接认证时临时发给云端，云端只保存它的哈希。

## 包结构

仓库是 npm workspaces 的 monorepo。

```text
packages/
  protocol/   zod 合同。领域类型、RPC 方法、事件、协议版本、配对链接、加密通道
  daemon/     运行内核、API 服务、provider、导入、远程监听和授权，以及 `vonvon` 命令
  client/     TypeScript 客户端。本机直连和远程加密通道两种传输
  ui/         React 界面，网页和桌面共用
  desktop/    Electron 外壳
  cloud/      账号、机器登记、转发、托管网页
```

`vonvon` 命令放在 daemon 包里，安装脚本（0.9.0）或 `npm i -g vonvon-bot` 就能在服务器上使用。常用命令有 `vonvon daemon start|stop|status`、`vonvon service install|uninstall|status`（V5 起可用）、`vonvon import feishu-codex-bridge`、`vonvon open`，0.9.0 加 `vonvon remote`、`pair`、`clients`、`device`、`update`；`vonvon login` 等账号一起做。页面上客户端能做的，命令行都能做，每条命令都能不交互、带 `--json` 和明确的退出码，对齐测试保证协议里每个 RPC 要么有命令、要么在带原因的白名单里（[devices.md](plans/devices.md) 第 8 节）。`packages/cloud` 还没有建。

## 代码来源和许可证

| 来源 | 许可证 | 搬进来的部分 |
| --- | --- | --- |
| feishu-codex-bridge `codex/device-handoff` `446b2a4` | MIT | Bot 运行内核、Codex 后端、系统服务 |
| Paseo `getpaseo/paseo` `0009a7e71` | Apache-2.0 | pid 锁、原子写文件、daemon 拉起方式。端到端加密不再移植它的 relay 代码，改用 `node:crypto` 上的 Noise（见"远程访问端到端加密"）。provider 层不再复制 Paseo 代码，只把它的聊天模式当作显示下限的参照 |
| vonvon-bridge-legacy `3a16853` | 自有 | 导入流程、旧服务控制、账号服务的设备凭据做法 |
| vonvon-platform `3427634` | 自有 | 飞书和 Lark 网页登录 |
| vonvon-bot PR 栈 `codex/device-handoff` `fab5237` | 自有 | 界面、UI 组件、zod 合同 |

复制 Apache-2.0 代码时保留原文件的版权声明，在仓库根目录加 `NOTICE`，并在改过的文件里注明改动。

远程连接和多设备参考了 Paseo（一台主机多条地址、凭据每次启动轮换）和 Orca（`stablyai/orca`：连接链接、地址分类、只接受字面 IP）的设计，没有搬它们的代码。

## 在哪些系统上能跑

现在的桌面端在 Linux 上跑不起来，因为内核只打包了 macOS 和 Windows 版本。新结构的 daemon 是普通 Node 程序，网页由 daemon 提供，所以 macOS、Linux、Windows 都能跑完整的 daemon 和网页界面。没有桌面的 Linux 服务器也能用无头 Chromium 打开网页截图验证。

0.9.0 起 Linux 有服务端包（见"服务端独立安装和升级"），自带 Node，`install.sh` 一条命令装好，只支持 glibc 的发行版，后台服务是 systemd 用户服务（开了 linger 不用登录）。Mac、Windows 用桌面端安装包，服务端在里面，不单独装（owner 2026-11-01）；Mac 的登录时启动是桌面端的 LaunchAgent，Windows 桌面端这一批不做登录自启，两边都要有用户登录着（可以锁屏）。macOS、Windows 安装包和 Linux 服务端包用同一个版本号。
