## 补做的独立审查：#368、#372

审查对象：#368（s18d 子进程排空上限和占锁提示，合入提交 3333fa8）、#372（s18f daemon 崩溃后桌面自动重连，合入提交 0befaf8）。以 origin/main `d187d00` 为准判断问题还在不在：两片之后改过相关文件的只有 a328892（lifecycle.ts 改了函数名）、0cfc95e（run.ts 一行）和 1cd945d（daemon-dependencies.ts 一行），都没碰本次的逻辑，下面两条发现在 `d187d00` 上仍然存在。复现在 origin/main 的临时副本里做，隔离 HOME 和 VONVON_HOME，做完已删。

总结论：两片的主路径都对，没有发现会让桌面连错 daemon、或让排空上限失效的问题。s18f 的被动重连有这些保护：重连前重新读 PID 锁、核对 owner、读凭据、核对 daemonStatus 里的 PID 和锁文件一致，所以 daemon 换了 PID 以后桌面连上的是对的那个。候选连接在第一份快照前就断了，client 会把断线错误留着，bind 时补发，所以照样会重试。成功激活和 `starting` 清空都在同一轮微任务里完成，不会和下一次断线交错。退出或更新时会取消等待，迟到的候选也会关掉。s18d 的 20 秒上限在子进程启动早期就挂上，计时器 unref，不会拖住正常退出。退出 75 和崩溃退避分开计，关闭时会清掉重试计时器。

不过 s18f 有一处行为回退（R1-1，中）：用户在桌面点"停止 daemon"，或在终端 `vonvon daemon stop` 时，桌面也走"崩溃后被动重连"这条路。之后 60 秒里点"启动 daemon"都被拒绝，提示 "Desktop startup is unavailable."，到 60 秒又弹出"连接丢失"的错误框。s18d 有一处诊断缺口（R1-2，低）：孤儿子进程排空时，日志里永远看不到卡住的 provider PID，被 20 秒截断以后也没有任何记录说明留下了哪个进程。两条都写了先失败的测试来复现。

### R1-1（中，已复现）桌面自己的"停止 daemon"被当成崩溃，60 秒内不能重新启动，到点还弹"连接丢失"

- 位置：`packages/desktop/src/main.ts` 第 356 行 `recoverConnection`、第 400 行 `startHost` 的拒绝；`packages/desktop/src/bridge.ts` 第 226–236 行，machine 通道没有把 `stopHost` 当成 shell 自己的操作。
- 缺陷：
  - daemon 的 machine status 一律返回 `host.ownership: 'owned'`（`packages/daemon/src/server/rpc/machine.ts`），所以桌面"机器"页的"停止 daemon"按钮在连着时总是可点。它发出的 `stopHost` 经 bridge 的 machine 通道直达 daemon，没有任何地方把"预期断开"设成 true。
  - daemon 按要求退出，退出码是 0。launchd 设了 `KeepAlive.SuccessfulExit=false`，所以不会再拉起它。
  - 桌面收到 ConnectionError 后，`isExpectedDisconnect()` 是 false，于是进入 `recoverConnection`。没有服务助手在跑，就走被动重连：设置 `starting`，60 秒内每 250 毫秒重新 attach 一次。
  - 这期间用户点"启动 daemon"（停止后状态刷新失败，status 变成 undefined，按钮就可点了），`startHost` 因为 `starting` 已设置，抛出 `StartHostRefusal('Desktop startup is unavailable.')`。到 60 秒，`showConnectionLost()` 再弹出模态框 "The daemon connection was lost. Check the daemon, then start it again in Vonvon Bot."，而停止是用户自己要的。
  - 在终端 `vonvon daemon stop` 也一样：等 60 秒才给提示，这期间启动被拒。
- 修之前（0befaf8 的父提交）：没有服务助手时，`followForeignHelper` 直接返回 false，不设 `starting`。bridge 当场报告断线，"启动 daemon"立刻可用。所以这是 s18f 带进来的回退。
- 复现（origin/main 副本，隔离 HOME/VONVON_HOME）：
  - `bridge.test.ts` 加用例：先经 machine 通道发 `{type:'stopHost'}`，再发一个 ConnectionError，断言不应调 `recoverConnection`。结果失败："expected vi.fn() to not be called at all, but actually been called 1 times"。
  - `native-lifecycle.test.ts` 加用例：attach 一直返回 `AttachError('owner')`，`recoverConnection` 之后在 1、20、39 秒各调一次 `startHost`，结果三次都是 `"Desktop startup is unavailable."`。推到 61 秒后，`showMessageBoxSync` 被调了 1 次。
- 建议改法（约 20–30 行，含测试）：
  - bridge 的 machine 通道遇到 `stopHost`，先让 shell 把这次断开记成预期的。比如在 `ShellActions` 加一个 `expectStop()`，把 `controlledDisconnect` 设成 true，并像 service `stop` 那样写入 `stoppedStatus`，断开后直接显示已停止。
  - `startHost` 和 service `start` 遇到正在进行的被动重连时，不要拒绝：先 `restartCancel.abort()`，等 `starting` 结束，再走 `reattachReady`。
  - 两处都补用例：停止后不弹框，启动立刻可用。

### R1-2（低，已复现）孤儿排空时看不到卡住的 provider PID，被截断后也不留记录

- 位置：`packages/daemon/src/host/lifecycle.ts` 第 38–41 行（`closeOwnedProviders` 里的孤儿分支）；`packages/daemon/src/host/crash-guard.ts` 的 `capOrphanDrain`，它的 `orphan-drain-cut` 只记 `waitedMs`。
- 缺陷：
  - 孤儿分支只在第一次 `report` 时记一条 `owned-work-orphan`，带上当时的 `pids`，之后都不再记。
  - 第一次 `report` 在关闭刚开始时调用。而 `OwnedProviderProcess.stop()` 要等 SIGTERM、宽限期、SIGKILL 和 2 秒等待都过了（至少约 6 秒）才把进程组标成 unconfirmed，所以这条日志里的 `pids` 实际总是 `[]`。
  - 后面真卡住的 PID 不会再出现在日志里。连着父进程时，每秒的 `owned_work_unconfirmed` 警告会带上这些 PID；孤儿分支把这条警告也一起去掉了。
  - 20 秒到点 `process.exit(0)` 时也不记剩下的 PID。触发截断的恰好就是"provider 进程组杀不掉或排空卡住"这种情况，事后查日志看不出留下了哪个进程。
- 复现（同一副本）：`lifecycle-owned-work.test.ts` 加用例，`process.connected=false`。前 7 秒 unconfirmed 是 `[]`，之后变成 `[4242]`，一共推 20 秒。全部日志只有 `[["daemon-shutdown","owned-work-orphan",{"pids":[]}]]`，断言 "包含 4242" 失败。
- 建议改法（约 5–10 行）：孤儿分支在 `pids` 集合变化时再记一条（只在变化时记，不每秒记），或者在 `orphan-drain-cut` 里带上 `unconfirmedProviderPids()`。补一个先空后非空的用例。

### 查过、不报的

- 凭据轮换：`local-credential` 用 `wx` 只创建一次，崩溃重启不会换，所以 `credential` 错误不重试不会误判。
- 快照 RPC 在启动早期失败：daemon 先建好快照库再 listen，被动重连拿首份快照不会碰到暂时的 RpcError。
- `liveServiceActionRecord` 抛错会让 `controlledDisconnect` 一直是 true：它里面的读取已经吞掉错误，不会抛。
- 服务管理器拉起太慢：launchd 的 `ThrottleInterval` 和 systemd 的 `RestartSec` 都是 5 秒，在 60 秒期限内。
- 占锁提示过期：子进程拿到锁以后，在第一次飞书连接事件之前，诊断页仍显示旧的占锁 PID。不过 SDK 的 `connectWebSocket` 有 15 秒超时，还会发 `reconnecting` 事件，这个窗口很短，不报。
- 截断以后 Codex 进程组可能留下：它们是 detached 进程组，stdin 关掉后大概率自己退出。没法确定，不报；R1-2 补上日志以后可以观察。
- 每次占锁重试的子进程都会先跑 `ProcessHost.sweepOrphans()`，再做早查锁：这是 s18d 之前就有的顺序，不在这两片的改动里。
- 断开期间请求显示 "Desktop request failed"，以及超时以后不再自动重连：两者都是 s18f 之前就有的提示和设计，v1-plan 写明"超时仍提示连接失败"。只有和 R1-1 叠加时才误导用户，已并入 R1-1。
