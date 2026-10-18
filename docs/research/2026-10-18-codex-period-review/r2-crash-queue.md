## 补做的独立审查：#369

**总结论：没有发现仍存在的真实缺陷。** #369（s18e，崩溃时保存排队消息并补发暂停通知）在当前 `origin/main`（42d98d2）上按四个角度逐段读了 `crash-guard.ts`、`crash-notify.ts`、`crash-store.ts`、`restart-dropped.ts`、`bridge.ts`、`supervisor.ts` 和 `handle-message.ts` 的相关路径，在隔离副本里跑了 6 个相关测试文件（182 项通过）和 `scripts/check-crash-recovery.sh`（D1、D2、D3 通过，需先在副本里 `tsup` 构建 daemon）。PR 描述和 `docs/v1-plan.md` 里写明的两条边界（暂停标记已写、通知未入队的极短窗口；飞书 uuid 去重只有 1 小时）核对后属实，且是有意接受的取舍，不算缺陷。下面按角度记录核查过程、为什么每条怀疑被驳回，以及几处不构成缺陷但值得知道的行为。

### 角度 1：崩溃钩子里的同步写盘（部分写、并发写、磁盘满）

- 钩子链路：`bridge.ts` 在创建编排器后 `onCrashSync(() => orchestrator.saveDroppedSync('crash'))`，关闭的 `closing` promise `finally(offCrash)` 注销；`crash-guard.ts` 的 `crashed()` 在写完崩溃记录、处理完 run marker 之后 `for (const hook of crashHooks) safe(hook)`，再 `process.exit`。钩子抛错被 `safe` 吃掉，不影响退出码；`handling` 标志防止二次异常重入。无 context 的子进程（id 不合法）也会跑钩子，测试 `bot-hook-noctx` 覆盖。
- 写盘：`recordDroppedSync` → `writeAtomicSync`：`mkdirSync` + `writeFileSync(tmp, { flag: 'wx', mode: 0o600 })` + `renameSync`，失败时 `unlinkSync(tmp)` 再抛。磁盘满时 `writeFileSync` 抛 ENOSPC，旧文件原样保留，`saveSync` 捕获并记日志（测试 ⑬、⑭ 覆盖写不进去的情况）。`load` 对超过 64 KB 或解析失败的文件按 corrupt 覆盖，不会因坏文件再崩。
- 并发写：`dropped.json` 只有本 bot 的子进程写（grep 全仓库，host 和 CLI 不写）。子进程持有单实例锁（`acquireSingleInstanceLock`），锁在 `run.ts` 里要等 `bridge.shutdown()` 结束后才释放，所以旧进程排空期间的 `appendSync`/`settle` 与新进程的 `start()` 不会同时写同一个文件；崩溃退出留下的锁由 PID 存活检查判定失效。`unsent-notices.json` 只有持 host 互斥锁的主进程写。
- 一条未报的观察：钩子里 `log.info('bridge','dropped-recorded',{why:'crash'})` 走 `createWriteStream` 的异步写，紧接着 `process.exit`。在副本里实测：流已打开且空闲时 5/5 次都落盘，流还没打开时 5/5 次丢失。真实子进程在崩溃时日志流通常已打开，所以大多数情况下这行会在；但有积压写入时可能丢。只影响日志可观测性，不影响 `dropped.json` 本身，且说不清出现概率，不作为发现。

### 角度 2：快照和重放是否重复或丢消息

- 快照一次：`saveSync` 用 `saved` 标志只写一次；关闭路径先 `shuttingDown = true` 再同步 `saveSync(collectLost(),'shutdown')`，之后才清空各队列，所以崩溃钩子在关闭之后调用是空操作，`appendSync` 只在 `saved` 之后生效（测试"appends only after a shutdown saved, and a later crash cannot count it twice"）。
- `collectLost` 用 `new Set(active.values())` 去重同一状态的两个键；`queue` 里已被运行中那轮的记录块带走的（`woven`）不记；`deferred`、`compactAfter`、`waiting` 各记一次。全仓库只有一处 `queue.push`，带 `origin`。
- 正在准备的第一条：`launchRun`/`launchGoalRun` 开头 `if (shuttingDown) appendSync(origin)`，等槽时 `state.waiting` 已在快照里，拿到槽后的 `if (shuttingDown)` 分支不再追加，避免重复（测试 ④ 三个变体覆盖）。桌面协作入口（`handle-message.ts:5158`）不带 `origin`，不会给群里发"请再发一次"。
- 重放：`start()` 只在连上以后、且未 `saved` 时跑一次；`settleDroppedSync` 按 `chatId+messageId+revision` 结案，回复在飞时关闭仍能结案（测试 ⑦）。上面提到的锁保证不会有两个进程同时重放。
- 有意接受、已被测试固化的行为（不算缺陷）：回复在飞时发生关闭、且同一群又有新掉落消息被合并进同一条目，`revision` 加一、uuid 变化，下个进程会在同一条最新消息下再回一次"这条和另外 N 条都没处理"，其中 N 包含已经被告知过的那条（`restart-dropped.test.ts` "keeps an older message merged during an in-flight reply"）。作者选择宁多说一次也不漏，窗口是回复在飞的几秒。
- 崩溃路径不记"正在准备的第一条"和 `onMessage` 预处理阶段的消息：这和 `docs/v1-plan.md` s18e 一行写的"关闭时正在准备的第一条也记"一致，产品文档 3.10 也只对正常关闭作此承诺。

### 角度 3：uuid 去重窗口（1 小时）之外的重发

- 掉落回复：`droppedUuid` 由 appId、chatId、messageId、revision 决定，1 分钟和 5 分钟的重试在窗口内；跨进程重放用同一 uuid。超过 1 小时才重放的只有"回复在飞时进程结束、且下一次连上在 1 小时以后"这一类，24 小时后不再回。PR 描述已写明。
- 暂停通知：`pauseJob` 先写 `unsent-notices.json` 再入队，`complete` 只在"发成功"或"所有候选 bot 都被永久拒绝"时删除；`'later'`（5xx、429、网络错、被关闭切断、2xx 但响应体读不到）都保留。同轮、仍暂停、24 小时内才用原 uuid 补发，`resumed` 或新轮全部作废。D1/D3 实测同一 uuid 只被飞书收一次。超过 1 小时后重放可能重复，仅限"已送达但响应丢失"这一种结果不明的情况，是已写明的边界。可选的改进（不是缺陷）：在 unsent 项上记最后一次尝试时间，供以后判断是否要换 uuid 或放弃。

### 角度 4：关闭和崩溃两条路径的交错

- 崩溃发生在关闭之前：钩子写快照，退出码 70，supervisor 计数后按退避重启，新子进程连上后回复。
- 崩溃发生在关闭排空期间：`saveSync` 已执行，钩子空操作；排空中还没走到 `launchRun` 检查的"第一条"会丢，这是极短窗口，和上面的边界同性质。
- 关闭发生在崩溃钩子执行中：都是同步代码，不可能交错。
- `hostStarted` 在 `startApi` 之前执行，所以暂停的主进程端口被占也能在关闭时把通知发出去或保留在文件里（D1、D3）；`notifier.close()` 是 supervisor 关闭的第一步，等待在飞的暂停通知最多 10 秒，总上限 15 秒。
- 主进程在请求停止期间崩溃：marker 被移除，下次是新轮，unsent 项作废不发——与产品"恢复运行或重启后'已停止自动重启'不再为真"一致。

### 验证记录

- 副本：`git worktree add --detach` 到 `origin/main`，node_modules、protocol/client dist 符号链接自另一棵已安装的 worktree，daemon dist 在副本内 `tsup` 构建。
- `vitest run --maxWorkers=2`（隔离 HOME、VONVON_HOME）：`restart-dropped`、`restart-dropped-orchestrator`、`crash-notify`、`crash-store`、`crash-guard`、`bridge-startup-drain` 共 182 项通过。
- `flock /tmp/vonvon-heavy.lock bash scripts/check-crash-recovery.sh`：D1、D3、D2 全部 PASS。
- 另写两段小脚本验证 `process.exit` 前异步日志写入是否落盘（见角度 1）。
- 没有改动主仓库和任何 worktree，没有 push、评论或发消息；审查结束后删除副本。

### 发现列表

无。上面各角度的怀疑都在代码或测试里被驳回；两条已写明的边界核对属实，属于有意的取舍。
