## 补做审查的复核

> 排片以 `docs/v1-plan.md` 为准（2026-10-18）：R3-1 并进 s23e，没有另开 s18h；R4-2、R5-1 和几条低级发现（R4-3、R5-2、R6-2、R6-3）合成 s36c2d；R1-1 和 R1-2 合成 s18g。

基准是 origin/main `c82fd22`（#392 之后）。复现都在 origin/main 的 detach 副本里做：依赖链到同一份锁文件的 node_modules，HOME 和 VONVON_HOME 用隔离目录，vitest 加 `--maxWorkers=2`，复现完删掉副本。没改主仓库和任何在用的 worktree，没 push，也没在 PR 上评论。R4-1 和 R6-1 是同一个缺陷，合成一行。

| 优先级 | id | PR | 严重度（原 → 复核后） | 结论 | 建议放进哪片 | 行数 |
|---|---|---|---|---|---|---|
| 1 | R4-1 + R6-1 | #381、#384 | 中 → 高（安全口子） | 成立 | s36d1（在飞，合入后缺陷消失），要补回归用例；s36d1 推迟的话，先在 resolveCwd 加守卫 | 用例约 40；临时守卫约 15 |
| 2 | R3-1 | 写在 #377 名下，实际是 2026-10-10 预热池的代码 | 中 → 中高（第一条消息失败） | 成立，归属的 PR 写错了 | 新开小修片 s18h（Codex 首启不并发），或并进 s23e | 代码 5–15，用例约 30 |
| 3 | R5-1 | #383 | 中（安全口子，只有 owner 能触发） | 成立 | 新开小修片 s36c2d（目录准入补漏），和 R4-2 放一起 | 代码约 10，用例约 15 |
| 4 | R4-2 | #381 | 中（错的状态，没有恢复路径） | 成立 | s36c2d（目录准入补漏），排在 s36d1 之后 | 最小改法约 25；加修复命令共 40–80，另加测试 |
| 5 | R1-1 | #372 | 中 → 中低（错的状态，60 秒内启动不了） | 成立；"主动停止却弹连接丢失"在 #372 之前就有 | 新开小修片 s18g | 代码约 25，用例约 30 |
| 6 | R7-1 | #381 | 中 → 低（文档待定项） | 部分成立：只有"显示位置没写"成立，"超出报告"一点驳回 | s27 开工要点 | 1 |
| 7 | R7-2 | #381 | 中 → 低 | 大部分驳回：#391 已在 s56a 开工要点里覆盖；只剩卡片长度策略没定 | s56a 开工要点 | 1–2 |

已被后续提交修掉的：代码类发现一条也没有，main 上都还在。R7-2 的"重启后仍能撤销"已由 #391 写进 v1-plan 的 s56a 开工要点。

---

### 1. R4-1 + R6-1：旧建群入口的默认目录会撞上 bot 的稳定目录，也会落进数据目录

**结论：成立。**

我试过从下面几处驳回，都驳不倒：
- 分配时有没有避让？`planDirectory` 只在分配 bot 目录那一刻避开已有目录，所以先有同名群目录、后注册 bot 的不会撞。可是 `createProject` 走 `resolveCwd` 的默认分支，就是 `join(projectsRootDir, name)` 加 `mkdir -p`，不查 `allocations`。所以先注册 bot、再建同名群一定会撞。
- 入口有没有挡住？网页的 `projectName` 正则只禁 `/`、`\` 和控制字符，`.` 和 `..` 都能过。私聊建群（`handle-message.ts` 的 `DM.newProjectSubmit`）只做了 trim，`../x` 也能过。
- 后面的提交修掉了吗？main 没改。s36d1 分支（`415a58f`，还没合入）让 `createProject` 改走 `withBotGroupBinding`，目录名经 `componentFor` 把 `/` 换成 `-`，只由点组成的名字换成 `bot`。按代码读，合入后这个问题会消失，但分支里没有这类回归用例。分支上的 `joinExistingGroup` 还留着 `join(root, name)`，它只用在 `bindProject` 的"同一行幂等"比较里，不会拿来当新行的 cwd。

在副本里复现，结果和发现一致，还多了一种：
- 先注册句柄为 `shared` 的 bot，默认绑定群 Alpha，得到 `projects/shared/groups/Alpha`。
- 再 `createProject({name:'shared'})`，cwd 等于这个 bot 的 `namespaceRoot`（`projects/shared`），目录里是 `groups`，档位是 `full`。
- `createProject({name:'..'})` 的 cwd 是数据目录本身。
- `createProject({name:'../escape'})` 的 cwd 是 `<数据目录>/escape`，在数据目录里面。这是私聊入口能走到的，网页入口挡住了 `/`。

影响：只有 owner 能发起建群，但建出来的是完全访问档的群，群成员都能驱动它的会话。这些成员能让 bot 读写别的群的工作区，违反 3.3。`..` 或 `../x` 会让会话跑在数据目录里，能碰到密钥和别的 bot 的配置，违反 3.6。群名和 bot 同名（比如 bot 叫 Jojo，群也叫 Jojo）并不罕见，macOS 不分大小写，范围还更大（这一点是读代码得出的，Linux 上复现不了）。

改法：
- s36d1 合入时补回归用例，大约 40 行。要覆盖这几种群名：等于本 bot 的句柄、等于别的 bot 的句柄、只差大小写（用 folded 比较测守卫逻辑），以及 `.`、`..`、`../x`。每条都断言 cwd 不等于任何 `namespaceRoot` 和 projects 根，也不在数据目录里（`projects/` 下的除外）。
- s36d1 如果推迟，先在 `resolveCwd` 的默认分支加大约 15 行守卫：拒绝 `.`、`..` 和带 `/`、`\` 的名字；按 NFKC 转小写后和 `allocations` 里所有 `namespaceRoot` 的末段比较，同名就拒绝。
- 已经这样建出来的旧行：cwd 等于某个 `namespaceRoot`、等于 projects 根，或者落在数据目录里（不在 `projects/` 下）。这些行在诊断里标出来，大约 20 行，可以放进 s36d2 处理旧数据的部分。实际有没有这样的行没查，不读 owner 的数据。

### 2. R3-1：预热补位和第一条会话同时首启 Codex，空的 CODEX_HOME 下必有一个退出

**结论：成立。归属的 PR 写错了：`backend.ts` 的 `spawn()` 和 `client-pool.ts` 的 `refillWarmPool()` 这段，git blame 是 2026-10-10 预热池那次提交写的，#377 没碰。缺陷现在还在 main 上。**

我试过从下面几处驳回：
- 是不是任何时候都会撞？不是。同一个 CODEX_HOME 先初始化一次，再并发起两个 app-server，6 轮都正常。所以用过 Codex CLI 或应用、已经有 `state_5.sqlite` 的用户碰不到。
- 登录会不会先把数据库建好？`codex login status` 不建 sqlite。真实的 `codex login` 走浏览器授权，这里没法测。所以会碰上的是：新装 Codex 以后，vonvon 的第一条会话。Codex 升级换了 state 的版本号时可能也会碰上，这是推断，没测。
- 有没有重试？调用处直接 `await be.startThread(...)`（`handle-message.ts` 第 2418 行等几处），没有针对 `app-server exited` 的重试。

复现：
- 进程级：真实 codex 0.163.0，同一个空的 CODEX_HOME 并发起两个 `codex app-server`，各发一次 `initialize`。10 轮全都有一个进程 exit 1，stderr 是 `Error: failed to initialize sqlite state runtime under <CODEX_HOME>: failed to initialize state runtime at <CODEX_HOME>`。顺序起 3 轮都正常。
- 后端级：在副本里每轮 `vi.resetModules()`，换一个新的 CODEX_HOME，调 `CodexAppServerBackend.startThread({cwd, mode:'full'})`。8 轮里 5 轮抛 `app-server exited (code=1 signal=null)`。

影响：新用户的第一条消息以报错结束，要重发一次。不会悄悄丢消息，但这是第一次使用时的体验。

改法：
- `spawn()` 冷路径上，把 `void refillWarmPool()` 挪到 `await client.connect()` 之后，命中热进程的路径不变，大约 5 行。
- 判断进程（`judge-process.ts`）和 utility 进程也各自 `new AppServerClient`，daemon 刚起来时可能和第一条会话一起首启。更稳的做法是在 `client-pool.ts` 加一道闸：第一个 app-server 回 `initialize` 之前，其余的排队，大约 15 行。
- 用例：用假的 AppServerClient 断言冷路径的 connect 落定之前不起第二个进程，大约 30 行。
- 放进新开的小修片 s18h。s23e 本来要改 Codex 判断进程的起停，也可以并进去。另外可以向 Codex 上游报这个并发首启的问题。

### 3. R5-1：桌面 editProject 改目录绕过工作区准入（旧行）

**结论：成立。**

我试过从下面几处驳回：
- `writeStored` 会不会复核？只在行里有 `directories.workspaces` 时复核。#383 之前绑定的旧行没有 `directories`，`admitDirectoryChanges(undefined, …)` 直接跳过，cwd 照写。
- 还有没有别的写入口？全仓库改 cwd 的只有 `handle-message.ts` 第 5034 行这一处。
- 是不是外部可利用？不是。editProject 只有本机鉴权的网页和桌面能调，`parseCollaborationRequest` 只挡相对路径，私聊没有改目录的入口。实际风险是 owner 在选目录框里误选了数据目录（它是隐藏目录）。
- 后面的提交修掉了吗？main 没改。

复现：在副本的 `desktop-collaboration.test.ts` 里加了一条用例。
- 旧行（夹具 `demo`，没有 `directories`）改到 `<数据目录>/bots`，返回 `{ok:true}`，落盘的 cwd 就是 `bots`。
- 带 `directories.workspaces` 的行改到同一个目录，或者改到数据目录根，都被 `Invalid directory settings: directories.workspaces.primary` 拒绝。
- 仓库自己的夹具一直用数据目录当 `demo` 的 cwd，编辑也一直成功。

影响：改完以后，这个群（多半是完全访问档）的会话在数据目录里跑，能读写密钥文件和别的 bot 的配置。可能这样落地的旧行，是今天所有在 #383 之前绑定的群。

改法：
- editProject 只在请求带了 `directory` 时，先过 `admitDirectorySettings({workspaces:{primary, additional:[]}}, {dataDir})`。拿到的规范路径同时写进 `patch.cwd` 和 `patch.directories.workspaces`，已有的 `repositories` 保留。这样旧行第一次改目录时就补上了声明。只改别的字段的不过准入，免得已经落在数据目录里的旧行连停用都改不了。大约 10 行。
- 加一条用例：旧行改到数据目录被拒，大约 15 行。
- 放进新开的 s36c2d（目录准入补漏）。

### 4. R4-2：账本里 ready 状态的目录钉死了路径和 dev/inode，正常操作以后就恢复不了

**结论：成立。**

我试过从下面几处驳回：
- 是不是有意的设计？#381 的测试把"目录缺失或被换掉时拒绝"写成了期望。v1-plan 的 s36c2b 写的是"崩溃留下的歧义拒绝自动处理"。可下面三种都不是崩溃留下的歧义，目录不存在时也没有内容需要保护。
- 影响面大不大？默认的 projects 根在数据目录里，用户很少手动去删。但 `preferences.projectsRootDir` 可以指到别处。整机迁移和从备份恢复会让 dev/inode 全部变掉，这些都是正常操作。
- 已经绑定的群受影响吗？不受影响，会话不走 materialize。卡住的是默认目录绑定（今天的"加入已有群"，以及 s36d1 合入以后所有的新建群）和同一个 app 重新注册。s36d1 合入后影响会变大。

复现：在副本里跑了三种场景，结果和发现一致。
- 删掉空的 `projects/shared` 以后绑定群：`ENOENT … realpath '<数据目录>/projects/shared'`。删掉 bot 再用同一个 app 重新注册：同样的 ENOENT。
- 删掉整个 `projects` 以后绑定：`ENOENT … lstat '<数据目录>/projects'`。
- 先 rename 走 `projects`，再整份复制回原路径，然后绑定：`Namespace parent changed`。

改法（放进 s36c2d，排在 s36d1 之后）：
- 最小的一步，大约 25 行：ready 目录不存在、父目录又能通过 `admitNamespaceReservation` 而且身份没变时，就地 `mkdir 0700`，更新 `object`。父目录也不存在、而它就是默认的 projects 根时，按同样的准入重建父目录。身份变了的，给一条中文报错，写明是迁移或恢复导致的，并指向修复入口。
- 修复入口，大约 40–60 行：`vonvon bot repair-dir <bot>`，由 owner 显式执行，按当前路径重新记录 dev/inode，或者换一个新目录。v1-plan 第 955 行说要少做存储和恢复类的工作，所以修复入口可以只做命令行，不做界面。

### 5. R1-1：机器页"停止 daemon"和终端停止被当成意外断线

**结论：成立。和发现不完全一样的是，"主动停止却弹出连接丢失"在 #372 之前就有；#372 新增的是 60 秒内启动被拒，弹框也推迟到了 60 秒以后。**

我试过从下面几处驳回：
- 按钮会不会根本点不了？MachinePanel 的"停止 daemon"只在 `ownership !== 'owned'` 时禁用，而 daemon 回的 `status` 固定是 `ownership:'owned'`，所以按钮一直可点。
- launchd 会不会把它拉起来？plist 写的是 `KeepAlive{SuccessfulExit=false}`，stopHost 正常退出后不会被拉起。直接起的 daemon 更没人管。
- bridge 有没有标记这次断线是预期的？machine 通道的 stopHost 直接转给 `client().machine`，没有调 `expectDisconnect`。服务端在 stop 和 restart 时都用 1001 `server_shutdown` 关连接，客户端靠关闭码也分不出来。
- 停止以后用户还能不能马上点启动？stopHost 返回后，面板会再读一次 status。这次读失败的话，status 被清空，"启动 daemon"变成可点。读成功的话，点"刷新状态"也会失败、清空。所以用户确实能在 60 秒内点到启动，然后被拒。
- 是不是回退？#372 之前，`followForeignHelper` 返回 false，bridge 立刻走 `connectionLost`，弹出同一个模态的"连接丢失"框，但关掉以后马上就能启动。

复现：在副本里加了两条用例。
- `bridge.test.ts`：经 machine 通道发 `stopHost`，再报 `ConnectionError`，结果 `recoverConnection` 被调了 1 次。
- `native-lifecycle.test.ts`：attach 一直抛 `AttachError('owner')`。调 `recoverConnection` 以后，在第 1、20、39 秒各调一次 `startHost`，三次都是 `Desktop startup is unavailable.`。到第 61 秒，`showMessageBoxSync` 被调了 1 次。

改法（放进 s18g）：
- machine 通道遇到 `stopHost` 时，先调一个新的 `ShellActions.expectStop()`：把 `controlledDisconnect` 设成 true，再像设计里的 service stop 那样写入 `stoppedStatus`。
- `startHost` 和 service start 碰上正在进行的被动重连时，先 `restartCancel.abort()`，等 `starting` 落定，再走 `reattachReady`，不再拒绝。这一条也覆盖了终端 `vonvon daemon stop` 之后马上启动的情况。
- 终端停止后 60 秒仍会弹框。要去掉，得让 daemon 留一个"正常停止"的记录，让被动重连读到后安静结束。这一步可选。
- 代码大约 25 行，两条回归用例大约 30 行。

### 6. R7-1：3.4 的交接显示

**结论：部分成立。不是代码缺陷，s27 还没实现。**

- 驳回的部分：报告里写的是，s27 应让人看得见"交给了谁、是否送达、在哪里接着看"，仍只传最终回答，遵守飞书 @ 和三轮上限。product.md 第 170 行的"发送成功只说明已发出，观察到对方响应才说明已开始处理"，是把"是否送达"说得更准、更保守，承诺没有变强。"不另加私有信道、确认循环或新的 bot 身份"对应的就是"仍只传最终回答、遵守飞书 @"。这两点算第 2 类细化，在 owner"接受建议"的范围内，不需要再问 owner。
- 成立的部分：显示在哪里（回答里一行、运行卡，还是单独一张卡），product.md、s27 主表行和 #391 加的 s27 开工要点都没写。
- 改法：s27 开工时补一句显示位置，大约 1 行。如果要做成单独的卡片，那就是新的用户可见界面，按 4.2 第 3 类先问 owner。

### 7. R7-2：3.7 的变更回执

**结论：大部分驳回，或者已被后续的 #391 覆盖。**

- "重启后仍能撤销"没写：#391 在 v1-plan 的 s56a 开工要点里写了"重启后能撤销靠按钮带版本号、撤销按当前版本核对，不是新承诺"。product.md 没写这一句，但按那条判断，这不算新承诺。
- 回执发送失败和设置失败分开记录、重发不重复修改、撤销核对操作人：这些都是不改变用户感受的工程细化，属于第 2 类。s56a 主表行已经写了"daemon 校验权限和当前版本；重复请求不重写、旧回执不覆盖新改动"。
- 前后值怎么显示：#391 定了"差异用 s40 的按行比较模块"。剩下没定的只有一项：飞书卡片有大小上限，SOUL 很长时差异怎么截、截了以后去哪里看全文。
- 改法：s56a 开工时补一句卡片长度策略，大约 1 行。可选在 product.md 3.7 补"重启后仍能撤销"一句，大约 1 行。不用等 owner。
