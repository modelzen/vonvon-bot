# 后台服务：不依赖 Electron 的设计

调研日期 2026-10-14，代码以 `main` 的 `2c60ea0` 为准。`D/` 指 `packages/daemon/src/`，`FCB/` 指 feishu-codex-bridge 0.6.14（`6698118`）。没实测的判断标"推断"，查不到的标"未知"。

> 文中的 `r3/fs/`、`fsdocs/`、`codex-approvals.md`、`permission-modes.md` 这类路径，是调研时存在本机的文档副本，没有存进仓库，原文在飞书开放平台和各家官网。Codex 源码指本机的 0.162.1 快照 `codex-rs/`。

起因是 owner 2026-10-14 的原话："后台服务不要依赖 Electron，因为 Linux 上没有桌面端，它可能就装一个 Daemon 后台服务。"这句话否掉了 `docs/product.md` 3.10 的第三条（"先试 Electron 自带的 `agentService`"）。

## 结论

1. **daemon 自己装服务的代码大部分已经在 main 上，只是没接线。** launchd 和 systemd 的安装、卸载、启动、状态事务（V5 第 8、9 块，#271、#274）、服务定义的编解码（第 1 块，#246）、退出码和 Linux 的 Gate L（第 11 块，#276）都已合入，带确定性测试。`vonvon service install` 和 `uninstall` 目前直接抛错（`D/cli/commands/service.ts:5`）。
2. **自动重启已经写在服务定义里，但没有"连环崩溃就停"的上限。** macOS 的 plist 是 `KeepAlive {SuccessfulExit: false}`、`ThrottleInterval 5`；Linux 的 unit 是 `Restart=on-failure`、`RestartSec=5`，没设 `StartLimit*`（`D/service/definitions.ts:81`、`:85`）。按两边的文档，这样会每 5 秒左右重试，没有次数上限（推断，算法见 3.3）。daemon 里每个 bot 的子进程也在无限重试，退避从 1 秒涨到 30 秒（`D/bot/supervisor.ts:24-28`、`:115-131`）。"10 分钟内崩 3 次就停"必须由 daemon 自己做。
3. **main 上没有任何崩溃上报。** 没有全局的 `uncaughtException` 兜底（代码注释原话："there is no global uncaughtException net"，`D/cli-bridge/ipc.ts:24-25`），也没用 Electron 的 crashReporter。崩溃原因只能从 `service.err.log` 和 `logs/` 里的日志翻。
4. **Electron 的 `agentService` 正好是 owner 不想要的那种依赖。** 它要求 plist 放在 app 包的 `Contents/Library/LaunchAgents` 里（Electron 文档 `docs/api/app.md:1622-1627`），服务的存亡跟着 .app 走，Linux 上也用不了。改成 daemon 自己写 `~/Library/LaunchAgents/com.vonvon.bot.daemon.plist`，这正是 main 上已有的做法（`D/service/identity.ts:33`）。
5. **无桌面的 Linux 已经有一半的路。** daemon 自己提供网页界面；WebSocket 只校验主机是回环地址，不校验端口（`D/server/ws.ts:11-13`、`:29`），界面按 `location.host` 连接（`packages/ui/src/main.tsx:37`），所以用 `ssh -L` 转发出来应该能用（推断，没测）。终端二维码向导也有（`D/bot/wizard.ts:109-140`）。缺的是：`vonvon open` 在无图形界面时会失败，也不打印链接（`D/cli/commands/open.ts:16-24`）；Linux 上界面会显示成"这台 Windows 电脑"（`D/server/snapshot.ts:29`、`packages/ui/src/App.tsx:861-865`）；没有处理 `loginctl enable-linger`。
6. **建议**：v1 的后台服务由 daemon 的命令行装，桌面端只调用它，不管 daemon 的生死。macOS 用用户级 LaunchAgent。Linux 用 systemd 用户服务，代码保留；进不进 v1 由 owner 定（问题 1），我推荐做成"命令行版"进 v1。#285 关掉，把它的拿锁前检查连同 #287 的修复搬进新的切片 PR；#110 关掉，只留作参考。

## 1. main 上现在有什么

### 1.1 服务代码

| 文件 | 行数 | 内容 | 现状 |
|---|---|---|---|
| `D/service/identity.ts` | 43 | 名字和路径：`com.vonvon.bot.daemon`、`vonvon-bot.service`（`:4-5`）；plist 在 `~/Library/LaunchAgents/`（`:33`），unit 在 `${XDG_CONFIG_HOME:-~/.config}/systemd/user/`（`:37`） | 已合入（#246） |
| `D/service/definitions.ts` | 167 | 渲染并解析 plist、unit、Windows `.cmd`/`.vbs`（`:81`、`:85`、`:92`） | 已合入（#246） |
| `D/service/registration.ts` | 89 | 读回定义，分成 `absent`、`ours`、`other-root`、`unrecognized` 四种 | 已合入（#246） |
| `D/service/distribution.ts` | 86 | 判断安装方式：桌面包 `bundled`、全局 npm `global-npm`、开发目录、未知（`:35-58`） | 已合入 |
| `D/service/drain.ts` | 170 | 卸载时先排空，再证明 owner 身份 | 已合入（#270） |
| `D/service/launchd.ts` | 380 | launchd 事务：`gui/<uid>` 域（`:110`），`bootstrap`（`:308`），`kickstart`（`:366`），Gate M 的卸载屏障 | 已合入（#271），**没有调用方** |
| `D/service/systemd.ts` | 380 | systemd 事务：`systemctl --user`（`:58`），`is-system-running` 预检（`:266`），`enable --now`（`:298`） | 已合入（#274），**没有调用方** |
| `D/service/windows.ts`、`win-startup.ts` | 361 + 98 | HKCU Run 和启动器 | 已合入（#275），v1 不用 |
| `D/service/adapter.ts` | 16 | `getServiceAdapter()` 直接抛错（`:15`） | 过渡状态 |
| `D/service/control.ts` | 129 | 检测 bridge 的 launchd 标签、systemd unit 和数据目录（`:6-7`、`:31-52`） | 已合入，导入 bridge 时要用 |

除了 `control.ts`，生产代码里没有任何地方引用 `launchd.ts`、`systemd.ts`、`windows.ts`（`grep` 结果）。桌面端引用了 `identity.ts`、`registration.ts`、`distribution.ts`（`packages/desktop/src/daemon-dependencies.ts:9-11`）。

### 1.2 命令行

- `vonvon service install` 和 `uninstall` 已注册（`D/cli/index.ts:50-56`），执行时抛 `SERVICE_UNAVAILABLE`（`D/cli/commands/service.ts:5`，文案在 `D/host/service.ts:4`）。没有 `service status`。
- `vonvon daemon run | start | stop | status | logs` 可用（`D/cli/index.ts:20-46`）。`daemon start` 以分离进程起 `daemon run`，等到它发布监听地址，最长 25 秒（`D/cli/commands/daemon.ts:26-84`）。它不走服务管理器，这正是 #285 要改的。
- `vonvon open` 没有 daemon 就先起一个，然后用 `open` 或 `xdg-open` 打开带凭据的链接（`D/cli/commands/open.ts:16-24`）。
- `bot init`、`bot list` 和 `doctor` 的代码在，但没有注册（`D/cli/commands/bot.ts`、`doctor.ts`；`v2-fit.md` 第 7 节）。

### 1.3 `host/lifecycle.ts` 和退出码

- 由服务管理器拉起的进程，判断条件是有 `VONVON_SERVICE` 且没有 IPC 父进程（`D/host/lifecycle.ts:95`）。
- 正常停止时退出 0（`:161`），重启时退出 75（`:171`）。命令行出错的收尾在 `D/cli/index.ts:110`。
- 被管理的 Linux 进程做核心更新重启时，用 `systemd-run --user --scope` 把重启助手放进单独的 scope，并检查它确实进去了（`:83-92`、`:193-197`），这就是 Gate L。
- **缺的一块**：main 上没有拿锁前检查。`runHostRuntime` 一上来就拿互斥锁和 PID 锁（`D/host/bootstrap.ts:17-20`）。推断：服务装上以后，如果已经有一个自己起的 daemon 在跑，服务管理器拉起的进程拿锁失败，退出 1，然后每 5 秒被重新拉起一次，直到那个 daemon 退出。#285 就是补这块的。

### 1.4 桌面端怎么找到或拉起 daemon

- 启动时调 `manager.ensureReady(0)`（`packages/desktop/src/main.ts:163`）。先找已经在跑、身份验证通过的 daemon，找到就接上（`daemon-manager.ts:71-75`）。
- 没有在跑的，就读服务注册（`daemon-manager.ts:77-96`）：
  - `ours`：跑 `daemon start`；
  - `absent`：用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）分离启动打包内置的 `daemon run`（`daemon-dependencies.ts:69-93`、`:74`）。
- daemon 是分离进程，退出应用后 bot 还在跑（`App.tsx:899` 页脚文案）。
- "登录电脑时启动"开关和"安装并启动后台服务"按钮能点，但会被拒绝（`main.ts:313-321`；`MachinePanel.tsx:85-90`）。
- 打包版注册的 `vonvon` 命令是一个 shell 包装，用 Electron 的 Node 模式执行内置 CLI（`cli-registration.ts:46`）。

### 1.5 崩溃后会不会重启，节流多少

| 层 | 写在哪 | 行为 |
|---|---|---|
| macOS 服务 | `D/service/definitions.ts:81` | `RunAtLoad` true，`KeepAlive {SuccessfulExit: false}`，`ThrottleInterval 5`，不设 `ExitTimeOut` |
| Linux 服务 | `D/service/definitions.ts:85` | `Type=simple`，`Restart=on-failure`，`RestartSec=5`，`TimeoutStopSec=infinity`，`WantedBy=default.target`；没有 `StartLimit*`，没有 `OnFailure=` |
| daemon 内每个 bot 的子进程 | `D/bot/supervisor.ts:24-28`、`:115-131` | 退出就重启，等待从 1 秒翻倍到 30 秒；连续健康 60 秒后退避重置；没有次数上限 |
| 桌面端自己起的 daemon | `daemon-dependencies.ts:69-93` | daemon 本身挂了不会重启（主进程挂了，bot 子进程也没了） |
| bridge 0.6.14（对比） | `FCB/src/service/launchd.ts:60-62`；`FCB/src/service/systemd.ts:57-58` | launchd 用 `KeepAlive true`；systemd 用 `Restart=always`、`RestartSec=5`；装完提示用户自己跑 `loginctl enable-linger $USER`（`FCB/src/cli/commands/daemon.ts:95`） |

服务装上以后，bot 有两层重启：服务管理器管 daemon 主进程，主进程管每个 bot 的子进程。

### 1.6 崩溃上报

没有。
- 没有全局的 `uncaughtException` 或 `unhandledRejection` 处理（`D/cli-bridge/ipc.ts:24-25` 的注释；`grep` 结果）。
- 桌面端没用 `crashReporter`（`grep` 结果）。
- 服务的 stdout/stderr 写到 `~/.vonvon-bot/service.log` 和 `service.err.log`（`D/service/common.ts:31-37`）；结构化日志在 `logs/<日期>.log`，`vonvon daemon logs` 能读（`D/cli/commands/daemon.ts:119-122`）。
- daemon 在 `admin.daemonStatus` 里写死 `installed: false, supported: false`（`D/server/http.ts:178`）。

## 2. 暂停的 PR

### 2.1 #285（V5 第 12/15 块：拿锁前检查和 `daemon start` 改走服务管理器）

- 分支 `claude/v5-prelock-guard-start-routing`，head `3950f90`，+1135/−47，19 个文件。其中源码约 120 行：`host/bootstrap.ts` +33，新文件 `service/startup.ts` +44，`cli/commands/daemon.ts` +24，`core/logger.ts` +12，`cli/index.ts` +6，`service/launchd.ts` +1。其余是测试和 `docs/plan.md`、`program-graph.json`（`gh api .../pulls/285/files`）。
- 做了什么（PR 描述）：
  - 服务拉起的进程在拿锁之前先读注册。注册不是 `ours` 就退出 0，并记 `registration_absent`；已有别的存活进程持锁，也退出 0，并记 `owner_present`。
  - 前台 `daemon run` 遇到注册为 `ours` 时拒绝，退出 1。
  - `daemon start` 在注册为 `ours` 时改走服务管理器，不再分离启动。
  - 退出前把日志写完，否则日志会丢。
- 状态：Mac 上全量测试通过。2026-10-14 05:50 因产品重新对齐暂停，"本 PR 本身没有发现新问题"（PR 评论）。`install` 仍然拒绝。
- 已知缺口，都是"打开安装之前必须修"：
  - #287：持锁进程崩溃后，PID 如果被无关进程复用，拿锁前检查只看 PID，会误判"已有 owner"，退出 0，服务就此停住，不再重试。修法是退出 0 之前先认证持有者。认证函数已经有：`verifyPidLockOwner` 用本机凭据握手（`D/server/owner-verification.ts:12-14`）。
  - #288：Windows 上每次启动都要用 PowerShell 读 Run 值。v1 不做 Windows，这条连同 `startup.ts` 的 Windows 分支一起删掉。

### 2.2 #110（V5 桌面外壳和系统服务，拆分来源）

- 分支 `codex/v5-desktop`，+17177/−2281，111 个文件，2026-10-13 起没有更新。
- 拆分表把它拆成 15 块（issue comment 6139553795）。
  - 第 1 到 11 块已经合入：#246、#248、#251、#254、#257、#268、#270、#271、#274、#275、#276（`git log`）。
  - 第 12 块就是 #285。
  - 第 13 到 15 块还没开：
    - 13 是最终的 adapter 和只读的 `service status --json`；
    - 14 是打开 install 和 uninstall；
    - 15 是桌面端的 `login-item.ts` 和"登录时启动"接线。
- 这三块在 #110 里的源码大约 340 行：`service/adapter.ts` +124，`desktop/src/login-item.ts` +114，`cli/commands/service.ts` +43，`service/startup.ts` +42，`cli/index.ts` +12，`host/service.ts` +6。另有 `login-item.test.ts` 268 行（`gh api .../pulls/110/files`）。其中有一部分是 Windows 的，v1 用不上。

### 2.3 `docs/plan.md` V5 一节剩下的

`docs/plan.md` 从 2026-10-14 起只作参考（`AGENTS.md`"范围和资料"）。V5 一节（`docs/plan.md:889-1286`）的验收项一个都没勾：
- 10 条真实窗口的 lane。其中 lane 6 是 macOS 的登录自启加 Linux 的 `service install`（`:1249`）。
- launchd 和 systemd 的原生验收 12 步，含杀进程后 15 秒内重启、无限期排空、"停止优先"、登录时重新加载、中断后续做卸载。
- 性能对比和 Shipping 审查。

这套验收要求一个专用的 Linux 测试用户和一台腾讯云主机，并且不能用 `operator` 账号（`:1186`）。按 2026-10-14 的新流程，这一套不必照搬，见 6.7。

## 3. 平台事实

### 3.1 macOS：LaunchAgent 还是 LaunchDaemon

- **LaunchAgent**：属于某个登录用户，用户登录后才运行，注销时收到 `SIGTERM`。plist 放在 `~/Library/LaunchAgents` 或 `/Library/LaunchAgents`（Apple《Creating Launch Daemons and Agents》）。
- **LaunchDaemon**：属于整个系统，plist 在 `/Library/LaunchDaemons`，安装要管理员权限（同上）。daemon 不能可靠地访问用户的家目录，也不能连窗口服务器（TN2083）。
- 会话类型：GUI 代理跑在 `Aqua` 会话；SSH 登录对应 `StandardIO`；还有每个用户一个的 `Background`。plist 没写 `LimitLoadToSessionType` 时默认是 `Aqua`（TN2083 表 1）。安全上下文跟着会话走（TN2083 "Security Context"）。main 的代码装在 `gui/<uid>` 域（`D/service/launchd.ts:110`）。
- **登录信息**：
  - Claude 在 macOS 上把登录信息存在钥匙串里；钥匙串写不进去（比如 SSH 会话里被锁住）时，改存 `~/.claude/.credentials.json`（code.claude.com/docs/en/authentication，"Storage location"）。
  - Codex 默认把登录信息存在 `CODEX_HOME/auth.json`，也可以配成钥匙串（`codex-rs/config/src/types.rs:136-146`，默认值是 `File`）。
  - 推断：放在 `gui/<uid>` 的 LaunchAgent 跑在用户登录后的会话里，能读到解锁的登录钥匙串，也就能用主人本机的 Claude 和 Codex 登录。LaunchDaemon 跑在全局上下文，读不到用户的登录钥匙串，还会碰上家目录归属的问题。所以**选 LaunchAgent**。代价是用户登录桌面后 bot 才启动。Mac 设成自动登录时等于开机启动（product.md 3.1.3）。推断：开了 FileVault 的 Mac 不能自动登录（Apple 社区帖 discussions.apple.com/thread/256199871，没有官方出处）。
- **重启和节流**（launchd.plist(5)）：
  - `SuccessfulExit: false` 表示退出码非 0 时重启。推断：被信号杀掉也算非 0 并重启，plan.md 原生验收第 4 步就是验这个，还没在真机上做过。
  - `ThrottleInterval` 默认"不会每 10 秒启动超过一次"；"退出得快又频繁的任务会被节流"。
  - 手册里**没有**"重启多少次就放弃"的配置项。Apple 归档文档提到过旧版 launchd 会因"respawning too fast"放弃，现在的 macOS 还会不会这样：未知。
  - `ExitTimeOut` 是发 `SIGTERM` 后等多久再发 `SIGKILL`，默认值由系统决定，0 表示无限，手册说不要用 0。
- **macOS 13 以后的后台项目管理**：系统装进登录项、LaunchAgent、LaunchDaemon 时会通知用户，用户能在"系统设置"里看到并管理这些项目（Apple Platform Deployment《Manage login items and background tasks on Mac》）。推断：自己写进 `~/Library/LaunchAgents` 的 plist 也会弹"已添加后台项目"的通知，用户在"登录项与扩展 → 允许在后台"里能关掉它；关掉以后 `launchctl print` 显示成什么、它下面显示 "Vonvon Bot" 还是 "node"，要在 Mac 上实测。
- **SMAppService 和 Electron 的 `agentService`**：plist 必须在 app 包的 `Contents/Library/LaunchAgents` 里（Electron 文档 `docs/api/app.md:1624`；Apple SMAppService 文档）。也就是说，服务登记在 .app 名下，Linux 上没有对应的东西，和 owner 的要求冲突。

### 3.2 Linux：systemd 用户服务还是系统服务

- **用户服务**（`~/.config/systemd/user/*.service`，`systemctl --user`）：
  - 不要 root，能直接用用户的家目录、`~/.codex`、`~/.claude/.credentials.json`。
  - 默认用户第一次登录时用户管理器才起来，最后一个会话退出时关掉。
  - `loginctl enable-linger` 让"用户管理器开机就起，注销后保留"，没登录的用户也能跑长期服务（loginctl(1)）。
  - 在 JP-VPS（Ubuntu 24.04，systemd 255）上，polkit 对 `org.freedesktop.login1.set-self-linger` 的默认值是 `allow_any=yes`，用户给自己开 linger 不用 sudo（`/usr/share/polkit-1/actions/org.freedesktop.login1.policy:127-135`）。其他发行版的默认值：未知。
- **系统服务**（`/etc/systemd/system`，可以写 `User=`）：安装要 root，和 `vonvon service install` 由普通用户执行、免管理员的思路不一致。v1 不选。
- **重启语义**（systemd.service(5)）：
  - `Restart=on-failure`：退出码非 0、被信号杀掉、超时、看门狗超时都重启。退出码 0 和 `SIGHUP`/`SIGINT`/`SIGTERM`/`SIGPIPE` 算正常退出，不重启。用 `systemctl stop` 停的也不重启。
  - 所以 daemon 正常停止退出 0，不会被拉起来；重启时退出 75，会被拉起来。这和 main 的退出码设计一致（`D/host/lifecycle.ts:161`、`:171`）。
- **连环崩溃的上限**：
  - 每个 unit 的启动次数受 `StartLimitIntervalSec=` 和 `StartLimitBurst=` 限制，超过就不再自动重启（systemd.unit(5)）。默认值来自 `DefaultStartLimitIntervalSec=10s`、`DefaultStartLimitBurst=5`（systemd-system.conf(5)）。
  - 推断：main 的 unit 是 `RestartSec=5`，10 秒里最多启动两三次，永远到不了 5 次，所以等于无限重试。
  - `RestartSteps=` 和 `RestartMaxDelaySec=` 能让重启间隔指数变长，从 systemd 254 开始才有（systemd.service(5)）。JP-VPS 上是 255。更老的发行版有没有：推断没有（比如 systemd 249 的 Ubuntu 22.04，未核实）。
  - `OnFailure=` 能在 unit 进入 failed 状态时拉起另一个 unit（systemd.unit(5)）。
- **停止超时**：main 的 unit 用了 `TimeoutStopSec=infinity`，好让排空不被打断（`docs/plan.md` V5 *Stop*）。JP-VPS 上 `user@.service` 自己带 `TimeoutStopSec=120s`，还有一个 drop-in 改成 5 秒（`systemctl cat user@.service`）。推断：关机时整个用户管理器有自己的超时，这个 unit 拖不住关机。
- **本机的先例**：JP-VPS 上的 Paseo 就是这样跑的。`~/.config/systemd/user/paseo.service` 写着 `Restart=always`、`RestartSec=10`、`StartLimitIntervalSec=0`，用户开了 linger（`systemctl --user cat paseo.service`、`loginctl show-user` 显示 `Linger=yes`，2026-10-14 观察）。Paseo 的文档对无头机器也是"`npm install -g` 后直接跑 daemon"（`paseo-0009/public-docs/index.md:21-28`）。

### 3.3 两边对比

| | macOS LaunchAgent（main 的定义） | Linux 用户服务（main 的定义） |
|---|---|---|
| 什么时候启动 | 用户图形登录后（`RunAtLoad`） | 用户管理器起来时；开了 linger 就是开机 |
| 崩溃重启 | 非 0 退出后重启，最快每 5 秒一次 | 非 0 退出或被信号杀后，等 5 秒重启 |
| 连环崩溃上限 | 没有可配置的上限（手册） | 默认 10 秒 5 次，在 5 秒间隔下推断碰不到 |
| 正常停止 | 退出 0 不重启 | 退出 0 不重启 |
| 能用用户的登录信息 | 能（在用户会话里） | 能（以用户身份运行） |
| 安装要不要管理员 | 不要 | 不要；linger 在 Ubuntu 上本人也能开 |

结论：两边都不会自己在"10 分钟 3 次"时停下。这个上限由 daemon 自己判断，两边就能用同一套逻辑。

### 3.4 桌面端和服务的关系

- 服务的唯一拉起者是 launchd 或 systemd。桌面端和 `vonvon daemon start` 只是"请它启动"（launchd 用 `kickstart`，systemd 用 `start`），不自己生成第二个 daemon。这正是 #285 的启动路由，也是 plan.md V5 *One launcher per data root* 的规则（`docs/plan.md` V5 一节）。
- 桌面端打开时先接上正在跑的 daemon（现有的 `ensureReady`）。没有服务时，提出帮用户装；用户不装，就按今天的做法起一个分离的 daemon，这种 daemon 崩了不会自动重启。
- 退出桌面端不停 daemon（今天已经是这样，`App.tsx:899`）。"停止 bot"用 `vonvon daemon stop`，daemon 退出 0，管理器不会重启它，注册还在，下次登录会再起来。"关闭登录时启动"用 `vonvon service uninstall`。

## 4. 没有桌面的 Linux

### 4.1 已有的

| 能力 | 出处 | 说明 |
|---|---|---|
| daemon 自带网页界面 | `D/server/web-ui.ts`；`D/server/http.ts:184` 只监听 `127.0.0.1` | npm 包里带 `ui/dist`（`scripts/pack-vonvon-bot.mjs`） |
| 网页能经 SSH 转发打开 | `D/server/ws.ts:11-13`、`:29` 只校验主机是 `127.0.0.1`、`localhost` 或 `[::1]`，端口不限；`packages/ui/src/main.tsx:37` 用 `ws://${location.host}` | 推断：`ssh -L 18080:127.0.0.1:<P> 服务器`，再在自己电脑上打开 `http://127.0.0.1:18080/#credential=…` 就能用。没测过 |
| 网页扫码建 bot | `D/server/jobs.ts:83` 把飞书的扫码链接转成二维码图片 | 经 SSH 转发后在笔记本上显示，用手机飞书扫 |
| 终端扫码 | `D/bot/wizard.ts:109-140`，`:115` 用 `qrcode-terminal` 画二维码，同时打印链接 | 只有在终端里前台跑 `vonvon daemon run`、并且一个 bot 都没有时才会走到（`D/cli/commands/run.ts:33-36`）。`bot init` 没注册；提示文字还写着 `feishu-codex-bridge bot init`（`D/bot/onboarding.ts:80-85`；`D/cli/commands/bot.ts:30`） |
| 状态和日志 | `vonvon daemon status [--json]`、`vonvon daemon logs`（`D/cli/index.ts:39-46`） | 只有运行与否、PID 和地址，没有服务和崩溃信息 |
| 无头登录 Codex 和 Claude | `codex login --device-auth`（`codex-rs/cli/src/login.rs:122`）；Claude 在 Linux 上把登录信息存在 `~/.claude/.credentials.json`（code.claude.com/docs/en/authentication） | 用户自己在终端里登录一次 |
| npm 包 | `scripts/pack-vonvon-bot.mjs` 打 `vonvon-bot-<版本>.tgz`；`distribution.ts:52-56` 认 `npm root -g` 下的 `vonvon-bot` | 没有发布到任何仓库（`docs/plan.md:1164`）。要 Node `^22.12 \|\| ^24 \|\| >=26`（`packages/daemon/package.json` 的 `engines`） |

### 4.2 缺的

1. `vonvon open` 在没有图形界面的机器上，`xdg-open` 会失败，链接也不打印（`D/cli/commands/open.ts:24`）。要加 `vonvon open --print`：打印链接、端口和一行 `ssh -L` 示例。注意凭据就在链接的 `#` 后面，提示用户别把它贴给别人。
2. Linux 上 daemon 报的平台是 `unsupported`（`D/server/snapshot.ts:29`），协议的枚举里没有 Linux（`packages/protocol/src/domain.ts:151`），界面就显示成"这台 Windows 电脑"（`packages/ui/src/App.tsx:861-865`）。
3. `service install` 没检查 linger。没开 linger 的话，用户退出 SSH 后 bot 就停了（loginctl(1) 的语义）。
4. 用 `sudo -u`、`su` 进来的会话没有用户管理器的总线，`systemctl --user` 连不上。main 的预检会报 `User manager unavailable`（`D/service/systemd.ts:266-268`），但不会告诉用户该怎么做。
5. Linux 上 Codex 的"项目内只读""项目内读写"两档直接拒绝启动，因为 Linux 沙箱限不住读取（`D/agent/codex-appserver/backend.ts:44-48`、`:78-82`）。Linux 上的 Codex 只能用"完全访问"。Claude 那边用 bubblewrap（`docs/research/2026-10-14-strategy/bridge.md` 核实记录第 4 条），这一点 v1 没有重新核实。
6. 首次运行清单（product.md 3.1.4）现在只设计了桌面窗口。Linux 上它就是同一套网页，经 SSH 转发打开。

### 4.3 建议的无头流程

1. `npm i -g vonvon-bot`，或者装下载的 tgz。
2. 在终端登录 Codex 或 Claude：`codex login --device-auth`，或者 `claude` 里的 `/login`。
3. 跑 `vonvon service install`。它装 systemd 用户服务；发现没开 linger，就问一句再执行 `loginctl enable-linger`；最后打印 `vonvon open --print` 的结果。
4. 在自己电脑上执行打印出来的 `ssh -L …`，打开链接，走首次运行清单：扫码建 bot、开权限、检查事件订阅。
5. 以后查看用 `vonvon daemon status`（加上服务状态和崩溃记录）、`vonvon daemon logs`，或者再开一次隧道。

终端扫码只做兜底，用于用户连 SSH 转发都弄不了的情况。daemon 不监听局域网地址，这和 product.md 3.1.1 一致。

## 5. 范围：v1 要不要带上"Linux 只装 daemon"

### 5.1 已有和缺的

| 项 | 已有 | 缺 | 估计改动 |
|---|---|---|---|
| systemd 事务 | `D/service/systemd.ts`（380 行）；`test/service-systemd-transaction.test.ts`（651 行） | 接到 `service install/uninstall/status` | 和 macOS 共用一个 PR |
| Gate L（Linux 上的更新重启） | `D/host/lifecycle.ts:83-92`、`:193-197`；`test/service-launch.test.ts`（313 行） | 无 | 0 |
| 拿锁前检查和启动路由 | #285（约 120 行源码） | #287 的修复；删掉 Windows 分支 | 和 macOS 共用 |
| linger 和总线检查 | 无 | 检查 `loginctl show-user`、执行 `enable-linger`、清楚的报错 | 约 60 行源码、60 行测试（推断） |
| 平台显示 | 无 | 协议加 `linux`；界面文案；隐藏 Linux 上没有的"登录时启动"开关 | 约 30 行加测试（推断） |
| 无头打开 | 无 | `vonvon open --print` | 约 30 行加测试（推断） |
| 分发 | 打包、检查、冒烟脚本都在 | 发布渠道（npm 公开包，或者下载地址）是发布决定；v1 闭源 | owner 定 |
| Codex 受限档 | 在 Linux 上拒绝（fail-closed） | 界面说明 Linux 上只能用完全访问 | 文案 |
| bridge 的 Linux 用户迁移 | `D/service/control.ts:39-43` 能检测 bridge 的 systemd unit | 迁移流程 product.md 第 5 节只写了 macOS | 不做（建议） |
| 原生验收 | 无 | 在一台真实的 systemd 主机上：安装、`kill -9` 后重启、停止后不重启、重启机器后启动、卸载 | 人工，一次 |

CI 方面，`linux` 任务跑在 GitHub 托管的 `ubuntu-latest` 上，冻结后跑全量单元测试（`.github/workflows/ci.yml`），systemd 事务的测试用的是假的 `systemctl`，已经在跑。CI 里不跑真的 `systemctl --user`。托管 runner 有没有可用的用户管理器：未知。原生验收要另找机器。JP-VPS 本身就是一台有用户管理器、开了 linger 的 Ubuntu 24.04（3.2 节），Claude 自己就能验，不需要 Mac 检查。

估计：在 macOS 服务切片之外，Linux 命令行版再多一个 PR，约 200 行源码、200 行测试，外加一次原生验收（推断）。

### 5.2 和 v2-fit 的"约 4,650 行可以暂停"对一下

v2-fit 第 7 节的 4,650 行由四块组成。我按 `wc -l` 重算：

| 块 | 行数 | 按本提案 |
|---|---|---|
| Windows 服务和进程监管（`service/windows.ts`、`win-startup.ts`、`provider/process/windows-*.ts`、`agent/codex-appserver/windows-job.ts`） | 1,128 | 仍然暂停，可以删 |
| holder 和进程托管（`native/holder/holder.c`、`provider/process/process-host.ts` 等） | 2,033 | 仍然暂停（#281 关闭，见 product.md 第 9 节末尾） |
| launchd 事务（`launchd.ts`、`drain.ts`、`definitions.ts`、`registration.ts`、`identity.ts`、`common.ts`、`adapter.ts`） | 982 | **启用**，它就是 macOS 的后台服务 |
| systemd 事务（`systemd.ts`）和 `lifecycle.ts` 里 Linux 的部分 | 380 加一部分 | **保留**；Linux 进 v1 就启用，不进也不删 |

v2-fit 写"如果自启改用 Electron 登录项，这条线整体暂停"（第 7 节表格）。owner 现在否掉了 Electron 这条路，所以这个前提不成立了。可以暂停的从约 4,650 行降到约 3,160 行（Windows 加 holder）。服务定义和注册里 Windows 的分支（`definitions.ts:92` 起、`registration.ts` 的 win32 部分、桌面端 `daemon-dependencies.ts:31-64` 的 Run 值读取）可以在一个只做删除的 PR 里去掉。

## 6. 提案：v1 的后台服务

### 6.1 原则

1. 服务由 daemon 的命令行装和卸：`vonvon service install | uninstall | status`。桌面端只调用打包内置的同一个命令行，不用 SMAppService，也不用 Electron 的 `agentService`。
2. 每个系统用户最多一个注册，对应一个数据目录（`docs/plan.md` V5 *One registration per OS user*，main 的代码已经这样）。
3. 注册以后，系统的服务管理器是唯一的拉起者。`daemon start` 和桌面端都请管理器去启动（#285 的路由）。
4. 谁也不用 `kill`、`launchctl bootout` 或 `systemctl stop` 停一个活着的 daemon。停止走 `vonvon daemon stop`：先排空，再退出 0（main 已有，`D/cli/commands/daemon.ts:90-111`）。

### 6.2 macOS

- 用户级 LaunchAgent `com.vonvon.bot.daemon`，放在 `gui/<uid>` 域，plist 在 `~/Library/LaunchAgents/`。这些都沿用 main 的代码。
- 运行时：
  - 从 dmg 装的，用 app 里的 Electron 二进制，以 Node 模式运行（`ELECTRON_RUN_AS_NODE=1`，`definitions.ts:81` 里 desktop 分支）；
  - 从 npm 装的，用用户自己的 `node`。
  - 这是"用 Electron 当 Node 用"，不是"依赖 Electron 应用在运行"：服务由 launchd 管，桌面窗口开不开都一样。代价：app 被删掉或挪走以后，plist 指向的程序没了，服务起不来（推断，launchd 会按节流不停重试）。是否接受见问题 4。
- 保留 `KeepAlive {SuccessfulExit: false}` 和 `ThrottleInterval 5`。

### 6.3 Linux

- 用户服务 `vonvon-bot.service`，沿用 main 的定义。
- `service install` 时：
  - 先检查 `loginctl show-user $USER -p Linger`。是 `no` 时，在终端里问一句，同意就执行 `loginctl enable-linger`，执行失败就打印命令让用户自己跑。加 `--linger` 和 `--no-linger` 两个参数，给脚本用。
  - 连不上用户管理器时，提示"请用 SSH 直接登录这个用户，不要用 sudo 或 su 切过来"。
- 没有桌面端，Linux 上不显示"登录时启动"开关（plan.md lane 6 本来就这么写）。

### 6.4 崩溃重启和连环崩溃

分两层，两边平台用同一套逻辑。

1. **记下每次崩溃。**
   - daemon 主进程和每个 bot 子进程都加全局的 `uncaughtException` 和 `unhandledRejection` 处理：同步写一条 `~/.vonvon-bot/crash/<时间>-<pid>.json`（版本、哪个 bot、错误第一行、栈顶几帧、运行了多久），然后退出 1。
   - 下次启动时，如果发现上一个 owner 没释放 PID 锁就没了，也没留下崩溃记录，就记一条"被系统强制结束，没有留下错误信息（可能是内存不足或被强制退出）"。Linux 上可以再读 `systemctl --user show vonvon-bot.service -p Result -p ExecMainStatus` 补上原因；macOS 上读 `launchctl print` 里的上次退出码（推断有这个字段，要在 Mac 上看）。
2. **主进程这一层。** 启动时先数最近 10 分钟的崩溃记录：
   - 少于 3 次：正常启动。
   - 到了 3 次：进入**暂停**状态。网页界面和本机 API 照常起来，不连飞书、不跑 agent，诊断页和 `vonvon daemon status` 显示"10 分钟内崩溃 3 次，已暂停"以及最近一次的原因。进程活着，管理器就不再反复拉它。
   - 暂停状态下又崩了：下次启动直接退出 0，管理器就此停手（launchd 和 systemd 对退出 0 都不重启）。下次登录或开机时会重新启动；那时如果离上次崩溃已经超过 10 分钟，就正常启动。
   - 恢复的办法：桌面端或网页里点"恢复运行"，或者执行 `vonvon daemon restart`（新命令）。它清掉计数后退出 75，让管理器重启。
3. **bot 子进程这一层。** supervisor 现在无限重试（`D/bot/supervisor.ts:115-131`）。改成 10 分钟内退出 3 次就不再拉这个 bot，标成"已暂停（崩溃过多）"，别的 bot 照常运行。

阈值"10 分钟 3 次"来自 product.md 3.10，见问题 2。

### 6.5 怎么告诉主人

| 情况 | 桌面端 | 私聊 | Linux 无头 |
|---|---|---|---|
| 崩了一次，已自动恢复 | 诊断页显示一条，原因一行 | bot 给它的主人发一张卡片："刚才崩溃过一次，已自动恢复。原因：…" | `vonvon daemon status` 显示最近一次崩溃 |
| 连环崩溃，已暂停 | 诊断页置顶红条，附"恢复运行"按钮 | 一张卡片："10 分钟内崩溃 3 次，已停止自动重启，请打开桌面端或运行 `vonvon daemon status`" | 同上，加恢复命令 |
| 暂停状态下又崩，进程已停 | 桌面端连不上 daemon 时，读 `crash/` 目录显示原因 | 不发（进程已经不在了） | `vonvon daemon status` 读 `crash/` 显示 |

- 私聊用 bot 的应用身份调发消息的 REST 接口，不走长连接，所以暂停状态下也能发。收件人是 bot 的主人（`preferences.access.ownerOpenId`，扫码时写入，`D/bot/wizard.ts:133-139`）。推断：机器人能给它可用范围内的用户直接发私聊，不需要用户先开过会话。要实测。
- 防刷屏：每个 bot 每 10 分钟最多一条崩溃私聊；连环崩溃这一轮只发一次。主进程崩溃时所有 bot 一起下线，由谁来发见问题 3。
- 卡片里只写一行原因，不放栈和本机路径，路径可能带用户名和项目名。完整信息只在本机。
- v1 不上传崩溃信息，没有遥测，这和 bridge 一样。可以在诊断页加"导出诊断包"，让用户自己发给开发者（建议，不是必需）。

### 6.6 桌面端和服务的关系

- 首次运行清单里加一步"登录电脑时自动运行 bot（推荐）"，执行 `vonvon service install`。跳过就按今天的做法起一个分离的 daemon，并提示"这样崩溃后不会自动重启"。
- 打开桌面端：先接上正在跑的 daemon；注册是 `ours` 就请管理器启动；都没有才自己起。
- 设置页的"登录电脑时启动"开关对应 `service install` 和 `uninstall`。"后台服务"一栏里的按钮（`MachinePanel.tsx:85-90`）接上真实状态。
- 桌面端退出、更新时都不停 daemon。桌面更新换掉二进制后，请 daemon 重启（退出 75），管理器就用新程序拉起它。协议版本不一致时的提示已经有（`daemon-manager.ts:60-62`）。

### 6.7 切片和验收

按 `AGENTS.md`，每个 PR 不超过 1500 行：

1. **后台服务：daemon 自己装 launchd 和 systemd。** 内容：
   - 移植 #285 的拿锁前检查和启动路由，加上 #287 的修复：只有认证通过的持有者才算"已有 owner"，认证不了就退出 1，让管理器继续重试；
   - 移植 #110 第 13、14 块里 macOS 和 Linux 的部分：最终的 adapter、`service status --json`、打开 install 和 uninstall；
   - 移植第 15 块的 `login-item.ts`，让桌面开关调用命令行；
   - 改 `admin.daemonStatus`（`D/server/http.ts:178`）。

   估计源码约 450 行、测试约 900 行（推断），超过上限就把桌面接线拆成第二个 PR。
2. **崩溃记录、连环崩溃暂停和通知**，即 6.4、6.5。估计源码约 400 行、测试约 500 行（推断）。
3. **（如果 Linux 进 v1）Linux 命令行版**：linger、平台显示、`open --print`、无头文档。估计源码约 200 行、测试约 200 行（推断）。
4. **只做删除**：Windows 服务代码和桌面端读 Run 值的代码。没有用户可见的变化，理由是少维护约 1,100 行，并且去掉每次启动都要读注册表的那条路径。

验收：
- 不再照搬 plan.md V5 的 12 步原生验收和腾讯云测试用户。改成：
  - 一次 Mac 检查会话，跑第 8 节的项目；
  - Linux 进 v1 的话，Claude 在 JP-VPS 上用隔离的 `VONVON_HOME` 跑一遍安装、`kill -9`、停止、卸载、重启机器后启动。JP-VPS 是 Paseo 在用的机器，用 `operator` 账号要 owner 同意，见问题 6。
- 确定性测试已经覆盖 Gate M 和 Gate L 的交错情况，保留。

### 6.8 #285 和 #110 怎么办

- **#285**：关闭，不合入。它的源码（约 120 行）和三个测试文件搬进切片 1，删掉 Windows 分支（#288 随之不再适用），按 #287 修好。理由：它改的 `docs/plan.md` 和 `docs/program-graph.json` 已经停止更新（`AGENTS.md`"硬限制"），标签 `owner:codex` 也是旧流程的；新 PR 从 `main` 开，审查按新规则走。关闭时在 #285 里写明代码搬到了哪个 PR，#287 跟着新 PR 关闭，#288 以"v1 不做 Windows"关闭。
- **#110**：关闭，只留作参考。第 1 到 11 块已经合入，第 12 块就是 #285，第 13 到 15 块需要的部分在切片 1 里重写。分支保留，不删（`AGENTS.md` 说 2026-10-14 之前的 `codex/*` PR 是旧桌面版的参考栈）。

### 6.9 `docs/product.md` 要改的地方

- 3.10 第三条：改成"后台服务由 daemon 的命令行注册：macOS 是用户级 LaunchAgent，Linux 是 systemd 用户服务。桌面端只调用它，不用 Electron 的登录项"。
- 3.10 第二条：补上"暂停状态"和"恢复运行"。
- 第 9 节第 5 项：删掉，不再需要实测 `agentService`。换成"Mac 上实测 LaunchAgent 能读到钥匙串里的 Claude 登录"。
- 第 11 节"由 Claude 定的事"第 3 条：改写。
- Linux 进 v1 的话，还要改第 1 节"不给谁用"、3.1.9、第 7 节的 "systemd"，以及第 5 节"失去"里的 Linux。

## 7. 要 owner 确认的问题

**问题 1：Linux 只装 daemon，算不算 v1？**
- a. 不算。v1 正式只支持 macOS，Linux 写进第 10 节"v1 之后"的第一项。systemd 代码不删，单元测试照跑。
- b. 算，做成"命令行版"：systemd 用户服务，经 SSH 转发打开网页，终端扫码兜底。不做 Linux 的 bridge 迁移，Linux 上 Codex 只能用完全访问。分发渠道和 macOS 一起定。
- c. 算，正式支持：再加上 bridge 的 Linux 和 WSL 用户迁移，以及 Linux 上 Codex 的受限档。
- 推荐 b。代码大部分已经合入，比 a 多一个约 400 行的 PR，Claude 能在 JP-VPS 上自己验，不占 Mac 检查。按 `AGENTS.md`，定稿以后的新范围要 owner 在 `docs/product.md` 的 PR 里认可。

**问题 2：连环崩溃以后怎么办？**
- a. 10 分钟内崩 3 次就进入暂停：网页和桌面端能看原因，bot 不连飞书；不自动恢复，等主人点"恢复运行"，下次登录或开机时重新开始计数。
- b. 同 a，但暂停一小时后自动再试一次。
- c. 直接退出，进程停掉，只留崩溃文件。
- 推荐 a。c 最省事，但桌面端和 Linux 用户都只能面对一个连不上的 daemon。

**问题 3：主进程崩溃，所有 bot 一起下线，崩溃私聊由谁发？**
- a. 只由最早加入的 bot 发给它的主人，卡片里列出受影响的 bot。
- b. 每个 bot 各发给自己的主人。同一个主人有几个 bot，就会收到几条。
- c. 不发私聊，只在桌面端显示。
- 推荐 a。open_id 按应用区分，没法判断几个 bot 的主人是不是同一个人（推断）。私聊不发路径和栈。

**问题 4：macOS 上的服务用 app 里的 Electron 二进制当 Node 跑，可以吗？**
- a. 可以。dmg 不用另带 Node；app 被删或挪走后服务起不来，桌面端提供"关闭登录时启动"，文档写清卸载步骤。
- b. dmg 里另带一份独立的 Node 运行时，服务指向它。安装包会变大（推断约 100 MB）。
- c. 要求用户自己装 Node。这和 product.md 第 1 节"不一定会装 Node"冲突。
- 推荐 a。这只是"借 Electron 的 Node 用"，服务的生死不归桌面应用管。

**问题 5：#285 和 #110 怎么处理？**
- a. 都关闭。#285 的源码按 6.8 搬进新的切片 PR，修好 #287；#110 只作参考。
- b. 恢复 #285，去掉 Windows 部分后合入，再按旧拆分表开第 13 到 15 块。
- c. 全部丢掉，重写一个更简单的服务。
- 推荐 a。b 要带着已停用的 plan.md 和进度图改动走旧流程；c 浪费已经合入、带测试的事务代码。

**问题 6：Linux 的真机验收在哪里跑？**（只在问题 1 选 b 或 c 时需要）
- a. JP-VPS 的 `operator` 账号，用隔离的 `VONVON_HOME`，只装 `vonvon-bot.service`，不碰 Paseo。
- b. 在 JP-VPS 上建一个专用测试用户，需要 owner 输入 sudo 密码。
- c. 另找一台 Linux 机器或虚拟机。
- 推荐 a。`vonvon-bot.service` 在 `operator` 下还不存在，验完就卸载；旧计划禁用 `operator` 是因为当时那台机器上有生产 bridge，这台没有。

## 8. 要在 Mac 上实测的

1. 打包版执行 `vonvon service install`：plist 写进 `~/Library/LaunchAgents`，`launchctl bootstrap gui/<uid>` 成功，daemon 在固定端口起来，桌面端能接上。
2. 系统有没有弹"已添加后台项目"的通知；"登录项与扩展 → 允许在后台"里显示的是 "Vonvon Bot" 还是 "node" 或开发者名。用户在那里关掉以后，`launchctl print` 显示什么，daemon 状态能不能反映出来。
3. `kill -9` daemon 以后，多久被拉起，端口是否不变，桌面端会不会自动重连。
4. `vonvon daemon stop` 以后，daemon 退出 0，管理器不再拉起；`vonvon daemon start` 又能拉起来。
5. 注销再登录、重启再自动登录，daemon 都能起来；LaunchAgent 里的 Claude 回合能读到钥匙串里的登录，Codex 能读到 `auth.json`。
6. 以 `ELECTRON_RUN_AS_NODE=1` 被 launchd 拉起的进程：没有 Dock 图标，也不弹窗口。
7. 删掉或挪走 app 以后，launchd 怎么处理这个服务（日志、重试频率），重新安装 app 后能不能恢复。
8. 桌面端自动更新换掉二进制时，正在跑的 daemon 不受影响；请它重启以后跑的是新版本。
9. `launchctl print gui/<uid>/com.vonvon.bot.daemon` 的输出里，上次退出码和终止信号是什么字段，用来补崩溃原因。
10. 人为让 daemon 10 分钟内崩 3 次：进入暂停，桌面端显示红条，主人只收到一条私聊；点"恢复运行"后恢复。
11. bot 给主人发崩溃私聊：在测试租户里，主人没和 bot 开过会话时能不能收到。

## 9. 来源

代码和仓库（`main` `2c60ea0`）：文中逐处写了 `文件:行`。
- PR 和 issue：
  - https://github.com/modelzen/vonvon-bot/pull/285 （描述、文件列表、2026-10-14 05:50 的暂停评论）
  - https://github.com/modelzen/vonvon-bot/pull/110 （描述、文件列表）
  - 拆分表 https://github.com/modelzen/vonvon-bot/pull/110#issuecomment-6139553795
  - https://github.com/modelzen/vonvon-bot/issues/287 、https://github.com/modelzen/vonvon-bot/issues/288
- 之前的调研：`docs/research/2026-10-14-v1-definition/v2-fit.md` 第 3、7 节；`bridge-inventory.md` 第 1 节；`final.md` 问题 7；`critique.md` 2.13。
- launchd：
  - launchd.plist(5) https://keith.github.io/xcode-man-pages/launchd.plist.5.html （KeepAlive、SuccessfulExit、ThrottleInterval、ExitTimeOut、LimitLoadToSessionType）
  - Apple《Creating Launch Daemons and Agents》 https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
  - TN2083《Daemons and Agents》 https://developer.apple.com/library/archive/technotes/tn2083/_index.html
  - Apple《Manage login items and background tasks on Mac》 https://support.apple.com/guide/deployment/manage-login-items-background-tasks-mac-depdca572563/web
- Electron `app.setLoginItemSettings`：https://raw.githubusercontent.com/electron/electron/main/docs/api/app.md （`:1583-1627`）
- systemd：
  - https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html （Restart=、RestartSteps=）
  - https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html （StartLimitIntervalSec=、OnFailure=）
  - https://www.freedesktop.org/software/systemd/man/latest/systemd-system.conf.html （DefaultStartLimit*、DefaultTimeoutStopSec）
  - https://www.freedesktop.org/software/systemd/man/latest/loginctl.html （enable-linger）
- JP-VPS 本机观察（2026-10-14）：Ubuntu 24.04.5、systemd 255、polkit 的 `set-self-linger` 默认值、`user@.service` 的停止超时、`paseo.service` 用户服务、`Linger=yes`。
- 登录信息：
  - Claude https://code.claude.com/docs/en/authentication
  - Codex `codex-rs/config/src/types.rs:136-146`、`codex-rs/cli/src/login.rs:122`（本地源码快照）
- bridge：`FCB/src/service/launchd.ts:60-62`、`FCB/src/service/systemd.ts:57-58`、`FCB/src/cli/commands/daemon.ts:91-95`。
- Paseo：`paseo-0009/public-docs/index.md:15-28`、`nix/module.nix:223-245`。

---

## 核实记录

另一个代理（Sonnet）独立复查了这份报告，只拿到报告本身和仓库，没有作者的推理过程。下面是它逐条核对的结论和它指出的缺口，原样保留，只改了格式。正文和这里冲突时，以这里为准。

| 说法 | 结论 | 说明 |
|---|---|---|
| plist 为 KeepAlive{SuccessfulExit:false}+ThrottleInterval 5;unit 为 Restart=on-failure、RestartSec=5、TimeoutStopSec=infinity,无 StartLimit*、无 OnFailure= | 核实 | packages/daemon/src/service/definitions.ts:81、:85 逐字吻合。 |
| 在 5 秒间隔下碰不到 systemd 默认的 10 秒 5 次上限,等于无限重试 | 核实 | 算术成立(10 秒内最多 2 到 3 次启动)。这是推断,报告也标了。本机 paseo.service 用 StartLimitIntervalSec=0、Restart=always、RestartSec=10,与报告 3.2 所述一致(~/.config/systemd/user/paseo.service)。本机 systemd 为 255.4。 |
| vonvon service install/uninstall 直接抛 SERVICE_UNAVAILABLE | 核实 | D/cli/commands/service.ts:4-5。报告写 :5,实际抛错在第 5 行。 |
| main 上没有全局 uncaughtException 兜底,也没用 crashReporter | 核实 | grep packages/*/src 只有 D/cli-bridge/ipc.ts:25 的注释命中。crashReporter 零命中。补充:Node 对未捕获异常默认退出码 1,所以现状是'崩溃即退出 1',缺的是留痕,不是不会退。 |
| WebSocket 只校验主机是回环地址、不校验端口,UI 按 location.host 连接,所以 ssh -L 可用 | 核实 | D/server/ws.ts:11-13 的正则允许任意端口,upgrade 在 :29 处检查。packages/ui/src/main.tsx:37 用 ws://${location.host}。'能用'仍是未实测的推断。 |
| vonvon open 在无图形界面时会失败,也不打印链接 | 核实 | D/cli/commands/open.ts:24 对非 darwin/win32 直接 run('xdg-open',[url]),没有回退打印。 |
| Linux 上界面显示成'这台 Windows 电脑' | 核实 | D/server/snapshot.ts:29 把 Linux 映射为 unsupported;packages/protocol/src/domain.ts:151 的枚举没有 linux;packages/ui/src/App.tsx:861-865 对非 macos 一律显示 Windows。 |
| bot 子进程无限重试,退避 1 到 30 秒,健康 60 秒后重置 | 核实 | D/bot/supervisor.ts:24-28、:115-131。 |
| 拿锁前没有检查,runHostRuntime 一上来就拿互斥锁和 PID 锁 | 核实 | D/host/bootstrap.ts:17-20,仅在 !process.send 时拿锁。'服务拉起的进程拿锁失败后每 5 秒循环'是推断。D/cli/index.ts:110 在 VONVON_SERVICE 下对 0 和 75 以外的码退 1,与推断相容。 |
| Linux 上 Codex 的项目内只读/读写两档直接拒绝启动 | 核实 | D/agent/codex-appserver/backend.ts:78-82,非 darwin/win32 即抛错。报告引用 :44-48 是注释,抛错的行是 :78 起。 |
| Codex 默认把登录信息存在 CODEX_HOME/auth.json;codex login --device-auth 可无头登录 | 核实 | codex-rs/config/src/types.rs:136-146 默认值为 File;codex-rs/cli/src/login.rs:122 的提示文字提到 --device-auth。 |
| Ubuntu 上 set-self-linger 的 polkit 默认 allow_any=yes,用户自己开 linger 不用 sudo | 核实 | /usr/share/polkit-1/actions/org.freedesktop.login1.policy:127-135。只代表本机,其他发行版未查,报告也说了未知。 |
| bridge 的 launchd 用 KeepAlive true,systemd 用 Restart=always、RestartSec=5 | 核实 | feishu-codex-bridge/src/service/systemd.ts:57-58、launchd.ts:60-62。 |
| owner 的 openId 在扫码时写入 preferences.access.ownerOpenId | 核实 | D/bot/wizard.ts:133-139,取自 creds.operatorOpenId,并同时写进 admins。 |
| Electron agentService 要求 plist 放在 app 包 Contents/Library/LaunchAgents(app.md:1622-1627) | 没核实 | references 下没有 Electron 源码,没能核对。该说法与 Apple SMAppService 文档一致。 |
| Claude 在 macOS 把登录信息存钥匙串、写不进时回退 ~/.claude/.credentials.json;LaunchAgent 能读到解锁的登录钥匙串 | 没核实 | 没有联网核对 code.claude.com 的认证文档。LaunchAgent 能读钥匙串是报告自己标的推断,第 8 节第 5 项也列了要实测。 |
| macOS 上被信号杀掉也算非 0 退出并重启;现代 launchd 没有'重启太快就放弃' | 没核实 | 报告自己标了未知或推断,需在 Mac 上实测(第 8 节 3、9 项)。 |
| v2-fit 重算后可暂停的行数由 4,650 降到约 3,160(1,128+2,033) | 没核实 | 没有重新跑 wc -l。 |

缺口：

- 没有核对 Linux 的 Restart=on-failure 对 SIGKILL 和退出码 75 的行为。SIGKILL 属于'被信号杀掉',会重启,与报告结论一致;但报告没说 systemd 的 SuccessExitStatus 默认不含 75,这里靠的是 75 非 0 即算失败。
- 暂停状态下'退出 0 让管理器停手'的设计有风险:macOS 上 RunAtLoad 加 SuccessfulExit:false 退出 0 后,launchd 在下次登录前不再拉起,用户手动 kickstart 也行。Linux 上 Restart=on-failure 退出 0 后 unit 变成 inactive,不是 failed,systemctl --user status 看不到失败原因。报告没提 status 里该怎么呈现。
- 崩溃计数和 crash/*.json 的并发与磁盘满、HOME 不可写的情形没考虑。uncaughtException 处理器里'同步写文件'在 OOM 和 SIGKILL 下根本跑不到,报告只在下次启动推断补录一句。
- 报告把'10 分钟 3 次'同时用于主进程和 bot 子进程,但没说子进程暂停后重新启用的路径,也没说它与 supervisor 现有 60 秒健康重置如何并存(D/bot/supervisor.ts:24-28)。
- daemonStatus 的 installed:false、supported:false 写死在 D/server/http.ts:178,桌面和网页都靠它决定按钮。报告提了,但没列出 protocol 里 daemonStatus 的 schema 是否要扩字段(暂停状态、最近崩溃),这会牵动 packages/protocol 的版本号和 UI 兼容。
- Linux 无头路径里 ssh -L 要求凭据在 URL 的 # 后面;报告提醒了别外传,但没讨论 daemon 固定端口被占用、多用户同机共用端口的情形,也没说 loginctl enable-linger 在非 systemd 或容器环境下的失败处理。
- 私聊通知依赖'机器人能直接给可用范围内的用户发私聊'这一推断,没有查飞书文档(document_portal get_detail)核对 im/v1/messages 的 receive_id_type=open_id 与可用范围限制。这是崩溃通知方案的关键前提,应先核实再进提案。
- 主进程崩溃时 daemon 已死,'暂停'状态里需要网页界面存活,但崩溃原因多半就是主进程里的异常;暂停态是否复用同一进程、还是用独立的最小服务,报告没给出可行性依据。
- macOS 上服务指向 .app 内 Electron 二进制并设 ELECTRON_RUN_AS_NODE=1:App 自动更新替换二进制时,正在运行的 plist 路径可能是带版本号或被替换的路径,报告只在第 8 节 8 项列出实测,没有推断风险。App 被 Gatekeeper 隔离(quarantine)或首次启动前 launchd 就拉起的情形也没写。
- 没有评估 FileVault 与自动登录的关系之外的情形:用户锁屏、快速用户切换时,gui/<uid> 域里的 LaunchAgent 是否继续运行,报告没覆盖。
