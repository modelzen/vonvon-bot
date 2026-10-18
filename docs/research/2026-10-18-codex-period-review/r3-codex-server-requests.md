## 补做的独立审查：#377

审查对象：#377「处理 Codex 服务端提问和拒绝请求（s32）」，合入提交 `a0de2f3`，以今天的 `origin/main`（`42d98d2`）为准。角度：app-server 的 server request（提问、审批、拒绝）怎么回、超时和会话结束时挂着的请求怎么处理、并发的多个请求、卡片回调和 RPC 的对应关系、错误路径，以及 PR 边界里写的"新 CODEX_HOME 的预热 child SQLite 初始化失败"的归因。

**总结论。** 请求接线本身没有查出仍在的缺陷：五种审批的否定回包、未知方法回 `-32601`、提问进同一条有序队列并按线程/回合认领、卡片 id 到原问题 id 和原选项文字的映射、回答/超时/停止/回合结束/EOF/关闭/预热清空各条路径都先同步领取再回包、服务端 `serverRequest/resolved` 撤销卡片且不重复回包、多条并发提问排队逐张出卡，这些我读代码和现有回归都对得上。PR 没归因的那个现象我复现并归因了：它不是预热独有的，而是 `CodexAppServerBackend.spawn()` 在预热池扑空时**同时**拉起冷进程和预热进程，Codex（0.163.0，Mac 上是 0.162.1）两个进程在没有 `state_5.sqlite` 等版本化数据库的 CODEX_HOME 里抢着初始化 sqlite，必有一个 exit 1；输家可以是真实会话的进程，这时用户的第一条消息直接失败。这一条报为中等缺陷（R3-1）。其余边界属于切片写明的范围，不算缺陷，见文末。

### R3-1（中，已复现）首次使用的 CODEX_HOME 里，真实会话进程和预热进程抢着初始化 sqlite，约一半概率是真实会话失败

- 文件：`packages/daemon/src/agent/codex-appserver/backend.ts` 的 `spawn()`（约第 747 到 759 行），配合 `client-pool.ts` 的 `refillWarmPool()`。
- 缺陷：`spawn()` 在 `takeWarmClient()` 扑空时先 `void refillWarmPool()` 再 `new AppServerClient().connect()`。`refillWarmPool` 的 async 函数体在第一个 `await` 之前就 `connect()` 了，所以预热 child 先 spawn，冷 child 紧接着 spawn，两个 `codex app-server` 几乎同时启动。Codex 在进程启动时初始化 `$CODEX_HOME` 下的 sqlite state（`state_5.sqlite`、`logs_2.sqlite`、`goals_1.sqlite` 等，文件名带 schema 版本号）。这些文件还不存在时，两个进程并发创建和迁移，其中一个在回 `initialize` 之前就打印 `Error: failed to initialize sqlite state runtime under <CODEX_HOME>` 并 exit 1。输家是预热 child 时，日志里是 `phase=prewarm: app-server exited (code=1)` 加一条 `resident-close` 清理错误（就是 Mac 任务 30 看到的那条）；输家是冷 child 时，`connect()` 拒绝，`startThread`/`resumeThread` 抛 `app-server exited (code=1 signal=null)`，用户看到这一轮失败。
- 触发条件：CODEX_HOME 里还没有这些版本化的 sqlite 文件。确定会出现的是全新 CODEX_HOME（Mac 任务 28/30 和我的复现都是）；只做过 `codex login` 没跑过会话的用户是否也缺这些文件，我没法在不登录的情况下验证。文件名带版本号，推断 Codex 升级换了 schema 版本后，第一条会话也会回到同样的竞争窗口；这一条是推断，没验证。`refillWarmPool` 只在 `spawn()` 里调用，没有 daemon 启动时的预热，所以 daemon 起来后的第一条会话一定是"扑空 + 并发补位"。
- 复现（都在副本和隔离目录里，真实 codex 0.163.0，没有登录、没有跑回合、没花额度）：
  1. 独立脚本：同一个全新 CODEX_HOME 下并发起两个 `codex app-server --listen stdio://`，各发 `initialize`。10 次里 9 次有一个进程在回 `initialize` 之前 exit 1，stderr 是上面那行；顺序起 3 次全部正常。
  2. 产品路径：副本 worktree 里用 `CodexAppServerBackend.startThread({ cwd, mode: 'full' })`，`CODEX_BIN` 指向真实 codex，每轮新建 CODEX_HOME，轮与轮之间取走并关掉上一轮的热进程。12 轮里 6 轮 `startThread` 抛 `app-server exited (code=1 signal=null)`；再跑 6 轮，4 轮会话失败、1 轮预热失败。日志里 `[agent.spawn] cwd=/tmp`（预热，中性目录）的 pid 总比会话 child 小，证实预热先 spawn；失败那轮是会话 child 的 `[agent.exit] code=1`，紧挨着 `agent.stderr` 的 sqlite 那行。
  3. Mac 任务 30 看到"预热失败、主回合成功"只是这次输家恰好是预热。
- 修法（约 5 到 10 行）：扑空路径上把 `void refillWarmPool()` 挪到 `await client.connect()` 之后（命中路径保持现在的立即补位：这时数据库已经由热进程建好，不会再抢）；或者在 `refillWarmPool` 里等待在途的冷 `connect()` 落定再 spawn。保险起见，`connect()` 在 `initialize` 之前拿到 code 1 退出时可以重试一次，但先改顺序就能消掉主因。同样的并发首启还可能发生在 daemon 启动后判断进程（s23c）和 utility 进程与第一条会话之间，这次没有测，改法一样：首个 app-server 起来之前不并发起第二个。
- 可以向上游报：两个 `codex app-server` 并发首启在空 CODEX_HOME 下必然有一个 exit 1。

### 查过、没有问题的点（不计入发现）

- 否定回包：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 回 `decline`，旧协议 `execCommandApproval`、`applyPatchApproval` 回 `denied`，`item/permissions/requestApproval` 回 `{ permissions: {}, scope: 'turn' }`，类型都用 `satisfies` 对着生成的协议类型；Mac 任务 28/30 用真实 CLI 验过 decline 后能续轮、空权限子集不加权。
- 提问：`inputSchema` 和 `askRequestSchema` 的约束一一对应（header 去空白后非空、label 非空、至少一题一项、题 id 不重复），`parseAskRequest` 不会在合法输入上抛，所以不会出现 `-32603`；`isSecret`、无选项、线程不匹配、解析失败一律立刻回空答案表。答案按下标映射回原问题 id 和原选项文字，原文空白保留。
- 认领和释放：请求到达时同步进入 `CodexRequestScope` 和同一条 `AsyncQueue`，和 `turn/started` 保序；`accepts` 按线程和当前回合过滤，不属于本回合的立刻回空答案；`done`、致命 `error`、`turn/start` 失败、`thread/goal/set` 失败、生成器 `finally`、`events().return()`、`abort()`、EOF、exit、stdin 错误、`closeChild`、`clearNotifications` 都会 `close()`/`finishTurn()`，挂着的请求不会悬空。关闭时 `requestScope.close()` 先于 `peer.close()`，回包落在 `ended` 之后不写管道。
- 服务端撤销：`serverRequest/resolved` 按原 RPC id 匹配，`cancel()` 让 `answerRequest` 得到 `null` 不再回包，`request_cancelled` 事件按 owner 身份只被本次运行消费，协调器用 `providerResolved` 结清卡片和 IdlePause 并推进下一张；还在队列里没消费的问题会在消费时因已被 forget 而丢弃（现有回归覆盖）。
- 并发多条提问：各自 `codex-request-N`，协调器按队列逐张出卡，30 秒发送超时和 15 分钟回答超时都回空答案并释放 IdlePause。
- 停止顺序：`state.interrupt` 先 `askTurn.close('stopped')`（回空答案）再 `turn/interrupt`，`abort()` 里也先 `cancelRequests` 再中断。

### 范围内的边界（不算缺陷）

- `mcpServer/elicitation/request`（MCP server 向用户要输入）现在和其他未知方法一样回 `-32601`，而不是协议里的 `{ action: 'decline', content: null, _meta: null }`。切片 s32 写明未知方法仍回 `-32601`，产品 3.8 也没提 elicitation，所以不计为缺陷；等接 MCP 时可以顺手补一个 decline。
- 自由文本、敏感问题、多选在 s33。

### 复现材料和清理

- 复现在 `mktemp -d` 的副本 worktree 和隔离 HOME/VONVON_HOME/CODEX_HOME 里做，依赖链到 lockfile 相同的本机 worktree；做完已 `git worktree remove --force` 并删掉临时目录。独立脚本和临时测试文件没有留在仓库里。
