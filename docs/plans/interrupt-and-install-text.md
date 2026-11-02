# interrupt-and-install-text 计划：停止、重启、升级直接中断，安装只说人话（R1）

2026-11-02，Claude 写，计划和代码同一个 PR，PR 回 `claude/devices-integration`。owner 2026-11-02 定：退出、重启、升级都直接中断进行中的对话，告诉用户"会中断会话"；`vonvon update` 一步做完、不问；桌面端分两步（先下载，再"重启升级"，旁边说明会中断）；第一次安装照旧开机自动启动，装好只说人话。调研和方案在 Claude 的工作目录 `linux-server/interrupt-design.md`（不在仓库里，结论抄在下面第 3 节）。产品行为以 `docs/product.md` 开头 2026-11-02 一条和 3.10 为准。

缩写：`D/`、`DT/`、`P/`、`U/` 分别是 daemon、desktop、protocol、ui 的 `src/`。

## 1. 做什么

用户看得到的变化：
- 停止服务、重启服务、升级都不再等 Bot 做完手上的活。正在进行的每一轮马上中断，卡片最后一行写原因：
  - 重启："服务端重启了，这一轮被中断，请再发一次"；
  - 升级："服务端升级了，这一轮被中断，请再发一次"；
  - 停止："Bot 停止运行了，这一轮被中断，等它恢复后请再发一次"；
  - 定时任务那一轮不请人再发。
- 卡片没来得及写上这一行的（飞书没回、进程先被结束），Bot 回来后在群里补一句"刚才重启了，这条没处理完，请再发一次"，和排队没开始的消息同一份名单。
- 整个停止最多 30 秒，一般几秒。网络卡住、飞书不回时也不会一直挂着。
- `vonvon update` 照旧一步做完，不问；服务端在跑、真要升级时，在第一步前说一句"升级会重启服务端，正在进行的对话会被中断，卡片上会请发消息的人再发一次。"
- 桌面端下载完的按钮叫"重启升级"，悬停和设置里说明会中断正在进行的对话；Windows 点了不再弹确认框。
- 停止、重启的说明（终端帮助、网页"这台设备"、设置搜索）都写"会中断正在进行的对话"；排空阶段显示"正在中断进行中的对话"。
- 安装脚本装好说"装好了。Vonvon Bot 已在后台运行，开机自动启动。"；`vonvon service install` 装好说"已在后台运行，开机自动启动。"（macOS 是"登录后自动启动"）。不提 systemd、linger、sudo。只有少数开不了开机自动启动的系统，才多一句可选的提示和那条命令。

## 2. 范围

做：
- daemon 的停止链有时限：Bot 进程里先中断、等 3 秒、再关 agent 进程；卡片最多再等 8 秒；关 bridge 最多 12 秒；host 等每个 Bot 最多 15 秒，到点强制结束 Bot 子进程和它报过的 agent 进程组；`daemon run` 最多 30 秒。
- 被中断的那一轮：卡片写原因，没写上的进 `dropped.json`。
- 停止原因（stop / restart / update）从发起处传到卡片：`stopHost` 加可选 `reason: 'update'`，Mac 桌面端升级后修旧服务端用隐藏的 `vonvon daemon stop --for-update`。
- 重启助手起不来时，服务管理下退出 75，systemd 拉起原来的版本。
- systemd 单元 `TimeoutStopSec=45`；旧单元的 `infinity` 照旧认作自己的。
- 文字：`vonvon update`、桌面端更新按钮和设置、停止和重启的说明、排空阶段、安装脚本和 `vonvon service install` 的完成提示。
- 去掉 Windows 桌面端"安装并重启"前的确认框。

不做：
- Windows 远程升级（0.9.0 不做）。
- 已装好、正在跑的旧单元不就地改写（见第 9 节和"实现时和计划不一样的地方"）。
- "现在有 N 个对话在进行"的人数、`update-status.json` 里被中断的对话数、`RestartSec` 改小。
- 给飞书 SDK 的每个请求加超时：只给整个停止加上限。
- 安装失败、没有 systemd 时的退回提示不变。

## 3. 现在的代码

- 停止、重启、升级本来就走同一条收尾，也本来就是中断，不等做完：Bot 进程一开始收尾就对每一轮调 interrupt（`D/bot/handle-message.ts` 的 `shutdown`），同时关掉所有 agent 进程（`closeOwnedProviderProcesses`、`thread.close()`）。"等 Bot 做完手上的活"只在界面文字（`P/machine.ts` 的 `draining`）和设计文档里。
- 问题有四处：
  1. 收尾没有时限：Bot 进程等所有卡片写完，飞书请求不带超时；host 等 Bot 子进程超时只打警告（`D/bot/supervisor.ts`）；systemd 单元 `TimeoutStopSec=infinity`（`D/service/definitions.ts`）。
  2. 正在跑的那一轮只写"⏹ 已被中断"（`D/card/run-card.ts`），也不进 `dropped.json`：`collectLost` 只收没开始的。
  3. interrupt 和关进程同一刻发，Codex、Claude 来不及自己收拾起的命令。
  4. 重启助手起不来时（比如没有 `systemd-run`），服务管理下的 daemon 退出 0，systemd 不拉起，重启变成停机（`D/host/lifecycle.ts`）。
- `vonvon update` 已经一步做完、不问（`D/cli/commands/update.ts`）；桌面端已经先下载、再点安装（`DT/updates.ts`、`DT/windows-updates.ts`），Windows 安装前多一个确认框（`DT/main.ts` `installDesktopUpdate`）。
- 安装脚本完成时说"后台服务已启动，登录后自动运行"，linger 没开时说"请执行一次 `sudo loginctl enable-linger`"（`scripts/install.sh`）；`vonvon service install` 打印 linger 和 systemd 的细节（`D/cli/commands/service.ts`、`D/service/linux-session.ts`）。

## 4. 怎么改

### 4.1 停止原因

- `D/host/lifecycle.ts` 加 `StopReason = 'stop' | 'restart' | 'update'`，`ShutdownControl.reason` 读当前原因。`requestRestart` 是 `restart`，升级的重启是 `update`，`requestStop(reason?)` 只接受 `update`（桌面端升级前停旧服务端）。重启之后又来的停止改回 `stop`。
- 原因经 IPC `{ type: 'bridge:shutdown', reason }` 和 SIGTERM 一起发给 Bot 子进程，子进程的 `observeShutdown` 读它，传给 `bridge.shutdown(reason)` → `orchestrator.shutdown(reason)`。
- `P/machine.ts` 的 `stopHost` 加可选 `reason: 'update'`；HTTP 和 RPC 两处 `requestStop(payload.reason)`；`stopVerifiedOwner(home, lock, reason?)` 只在给了时才发。0.8 的 daemon 不认这个字段，按普通停止处理。
- 桌面端：Windows `beforeUpdateInstall` 发 `{ type: 'stopHost', reason: 'update' }`；Mac 升级后启动修复停旧服务端时加 `--for-update`（隐藏选项），挪了 app 位置重装的那次不加；U2（#649）加的 Windows 启动修复直接停旧服务端，也带 `reason: 'update'`。

### 4.2 Bot 进程里：先中断，3 秒后关进程

`orchestrator.shutdown(reason)`：
1. 不再接受新的 agent 进程（`stopAcceptingProviderProcesses`），`collectLost` 照旧写 `dropped.json`，记下正在跑的每一轮（`ActiveState.inFlight`）。
2. 对每一轮调 interrupt。
3. 等这些轮最多 `SHUTDOWN_INTERRUPT_GRACE_MS = 3_000`，到点或都结束后才关 agent 进程、常驻客户端和 thread。
4. 整个收尾等最多 `SHUTDOWN_DRAIN_MS = 8_000`；被中断的卡片写上 `stoppedLine`，写上了的从名单里划掉；到点还没划掉的写进 `dropped.json`。
5. 定时任务照旧记"中断"，调度器等它最多 3 秒（`bridge.ts` `SCHEDULER_DRAIN_MS`）。

崩溃（没走到 shutdown）时，`collectLost` 加上正在跑的那几轮一起存，`saveSync` 一个进程只写一次。

### 4.3 Bot 子进程和 host 的上限

- `D/cli/commands/run.ts`：关 bridge 最多 `BRIDGE_STOP_LIMIT_MS = 12_000`，到点记 `bridge_stop_limit`，接着放锁退出。
- `D/bot/supervisor.ts`：`stopBot(child, reason)` 一个截止时间 `BOT_STOP_LIMIT_MS = 15_000`；到点记 `bot_stop_limit`，SIGKILL 子进程，再按它报过的 agent 进程组 pid（`owned-work` 报告里的 `pids` 和新加的 `registered`）`process.kill(-pid, 'SIGKILL')`，记 `agent_groups_reaped`。
- `D/host/lifecycle.ts` `armHostStopLimit`：`daemon run` 收到停止起最多 `HOST_STOP_LIMIT_MS = 30_000`，到点写干净退出的记录、刷日志（最多 1.5 秒），退出：服务管理下重启和升级 75、停止 0，不在服务管理下 1。挂在 `daemon run` 命令里（不在 `runHostRuntime` 里），Bot 子进程和测试里的假控制不受影响。

### 4.4 重启助手失败

`lifecycle.ts` 的 `helperFailed`：服务管理下保持重启意图，退出 75，systemd 拉起原来的版本；不在服务管理下照旧当停止。

### 4.5 systemd 单元

`TimeoutStopSec=45`。`decodeGeneratedDefinition` 也认旧的 `TimeoutStopSec=infinity`，`systemd.ts` 安装、卸载时拿磁盘上的原字节判断"是不是自己的"和回滚，旧单元照旧能卸载、能被新安装替换。

### 4.6 文字

- `D/card/run-card.ts` `stoppedLine`，`D/bot/restart-dropped.ts` `droppedText` 改成"没处理完"。
- `D/cli/commands/update.ts` `UPDATE_INTERRUPTS`，只在文字模式、真要升级时打一次；npm 路径的重启那句也说会中断。
- `D/cli/index.ts` `daemon stop`、`restart`、`update` 的说明。
- `U/DesktopUpdateButton.tsx` 导出 `INTERRUPTS`，按钮"重启升级"/"正在重启升级"；`U/management/UpdatePanel.tsx`、`U/management/ServerUpdateCard.tsx`（U2 后"更新外部 Core"和远程"更新"在这里，旁边写会中断）、`U/search.ts`、`U/management/MachinePanel.tsx`（本机、远程两种停止说明和确认框）、`U/App.tsx` 跟着改；`DT/updates.ts`、`DT/windows-updates.ts` 的状态文字。
- `DT/main.ts` 去掉 Windows 确认框。
- 安装：`scripts/install.sh` 完成时分三种（直接启动一次 / 开机自动启动 / 开不了开机自动启动多一句可选提示）；`vonvon service install` 用 `installedLine(running, bootStart)` 一句话，linger 的提示只在开不了时出现，问句改成"要让 Vonvon Bot 开机自动启动、退出登录后也继续运行吗？[Y/n]"。

## 5. 测试

- 停止链：`restart-dropped-orchestrator.test.ts` 新增"a stop cuts the turns in flight short"（卡片写原因、3 秒内不关进程、没写上的进名单、定时任务不请重发、崩溃时也记下）；`scheduled-run-shutdown.test.ts`；`run-render.test.ts` 的 `stoppedLine`。
- 子进程和时限：`daemon-lifecycle.test.ts`（15 秒到点强杀子进程并收进程组、按时结束不杀、晚到的结果不再处理）、`host-stop-limit.test.ts`（新：30 秒到点退出码、刷日志超时、解除；`reapReportedGroups`）、`managed-runner-exit.test.ts`（关 bridge 12 秒上限）、`lifecycle-owned-work.test.ts`（`registered`）、`cli-lifecycle-exit.test.ts`（`daemon run` 挂上限）。
- 停止原因和退出码：`host-lifecycle.test.ts`（真子进程经 IPC 收到原因）、`service-launch.test.ts`（助手失败 75、原因）、`machine-lifecycle.test.ts`、`server-drain-control.test.ts`、`owner-verified-stop.test.ts`。
- 单元和安装：`service-definition(s).test.ts`、`service-systemd-transaction.test.ts`（旧单元）、`service-cli.test.ts`、`linux-session.test.ts`、`scripts/install.test.mjs`。
- 文字：`cli-update.test.ts`、`restart-dropped.test.ts`、UI 的 `desktop-update-button`、`application-ui`、`search`；桌面端 `login-item.test.ts`（`--for-update`）、`native-lifecycle.test.ts`（不弹框）。

## 6. 自测

JP-VPS 上跑 daemon、desktop、ui 的 typecheck 和上面的测试文件。不碰验收 daemon、真实 systemd 和 linger。

## 7. 文档

`docs/product.md` 开头 2026-11-02 一条、第 1 节第 2 条、3.10、3.14"升级和版本"；`docs/architecture.md` 服务一节的时限；`docs/plans/devices.md` 7.5、第 13 节、第 15 节文字表；`docs/plans/devices-ui-4-bundled-update.md`；`docs/windows-release-build.md`、`docs/plans/windows-install-update.md` 里的"稍后"。

## 8. 验收要点

1. 停止、重启、升级时，进行中的那一轮的卡片写对原因；卡片没写上的，Bot 回来后在群里问一次，不重复问。
2. Codex、Claude 有 3 秒自己收尾，之后才关进程；整个停止不超过 30 秒。
3. Bot 子进程 15 秒没停完：子进程和它报过的进程组都被强制结束，日志有 `bot_stop_limit`、`agent_groups_reaped`。
4. 重启助手起不来时退出 75（服务管理下），不在服务管理下当停止。
5. 旧单元（`infinity`）照旧认作自己的，能卸载、能替换。
6. 文字里没有"等 Bot 做完手上的活"；安装和 `service install` 的完成提示不提 systemd、linger、sudo（只在开不了开机自动启动时有可选提示）。
7. Windows 点"重启升级"不弹框。

## 9. 风险和行数

- 涉及子进程、关闭顺序、错误路径和退出码，审查分两块：停止与中断（子进程、时间上限、退出码），文字与安装脚本。
- 30 秒到点退出时，没报上来的 agent 进程组可能留下；systemd 下 45 秒到点由 systemd 对整个 cgroup 兜底，Mac 和不在服务管理下的 Linux 没有这层。
- 已装好、正在跑的旧单元还是 `infinity`，下次 `vonvon service install`（比如升级后重装）才换成 45；daemon 自己 30 秒到点退出，所以实际也不会一直挂着。
- 行数（相对集成分支 `5278514d`）：源码 +468 / −151（含注释），测试 +586 / −115，文档另算。

## 实现时和计划不一样的地方

1. 30 秒的上限挂在 `daemon run` 命令里，不在 `runHostRuntime` 里：挂在后者时，测试里的假控制会被提前读一次 `waitForRequest`，假时钟下还可能 `process.exit`。
2. 设计里只说"停止、重启、升级"用不同的话；实现时给 `stopHost` 加了可选的 `reason: 'update'`，Mac 用隐藏的 `--for-update`，桌面端升级时卡片才能写"服务端升级了"。
3. 调度器的等待从无限改成 3 秒（`SCHEDULER_DRAIN_MS`），否则一条定时任务能把 Bot 进程的上限拖过去。
4. 设计说"已装好的服务要在升级时重写 unit"，没做：正在跑的单元不能就地换（安装事务拒绝替换在跑的单元），改成让新代码认旧单元，host 自己 30 秒到点退出。
5. `vonvon update` 打的那句不带被中断的对话数，`update-status.json` 也没加这个字段：现在拿不到可靠的数（排空一开始连接就断），先只说会中断。
6. `RestartSec` 没从 5 改成 2：和本片的时限无关，留给以后。
7. `vonvon service install` 的输出整理成一句"已在后台运行，开机自动启动。"，linger 的问句和开不了时的提示改成人话；原来那几行 systemd、linger 细节只留在 `vonvon service status` 和 `--json` 里。
8. `provider-lock-retention` 原来"停不下来就一直占着锁"的断言改成：30 秒内照旧占着，到 30 秒退出（退出码 1，进程结束由系统放锁），另加一条测试；它的就绪等待放宽了，这个测试在 JP-VPS 上单独跑时，集成分支上原来就会卡在就绪那一步。
