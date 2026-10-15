# e07：用 bridge 的锁格式占住 processes.json（预查）

`docs/v1-plan.md` 第 4 节的 e07，对应 product.md 第 9 节第 10 项的预查，挡住 s61（导入事务上半段）。基于 `main` 的 `bfc01d7`。2026-10-15 北京时间 20:38 在 JP-VPS 上实测（Linux，Node 24.21.0，procps-ng 4.0.4 的 `ps`）。真机部分（Mac 上装好的 bridge 0.6.14、launchd、多 bot 模式）是 e08。

## 结论先行

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | v2 的 `acquireSingleInstanceLock` 能不能写出 bridge 格式的锁 | **能**，但要显式传 bridge 的路径 | 写出的文件是一行 `{"pid":…,"appId":"cli_…","startedAt":<毫秒>}` 加换行，键和 bridge 0.6.14 一样。v2 的默认路径是 `~/.vonvon-bot/…/processes.json`（`D/config/paths.ts:75`、`D/config/data-root.ts:24`），不是 bridge 的，所以要传 `~/.feishu-codex-bridge/bots/<appId>/processes.json` |
| 2 | bridge 0.6.14 同名函数去抢，会不会抛 `BridgeAlreadyRunningError` | **会** | 连抢 3 次，3 次都是 `BridgeAlreadyRunningError`（bridge 自己的类，`instanceof` 成立），`pid` 是 v2 持有者的 pid，锁文件一个字节都没变。bridge 和 `run.ts:141` 一样先 `useBotDir(appId)` 再用默认路径，算出来的路径和 v2 写的同一个 |
| 3 | 持有者退出后锁是不是失效 | **是**，三种退出都失效 | 正常退出（`process.exit`）时 exit 回调删掉锁文件，bridge 直接抢到。SIGTERM（没装处理器）和 SIGKILL 时锁文件留着，但 pid 已死，bridge 当残留锁删掉重抢，抢到。v2 的 `readSingleInstanceHolder` 对这两种残留都返回空 |
| 4 | startedAt+15s 那条判断 | **和代码一致，实际余量在 14 到 15 秒之间** | 对同一个活进程手写 `startedAt = 进程启动时刻 + delta`：delta 为 +1 小时、0、-10 s、-14 s 时 bridge 拒绝；-14.5 s、-15.5 s、-16 s、-20 s、-60 s 时 bridge 判为"pid 被复用"，删锁抢到。`ps -o etime=` 只到秒，向下取整，所以边界会往里缩最多 1 秒 |
| 5 | 反过来，bridge 在跑时 v2 去抢 | v2 **立即抛错**，不等 | v2 的 `acquireSingleInstanceLock` 遇到活的持有者第一次就抛 v2 自己的 `BridgeAlreadyRunningError`。模拟 bridge 收到 SIGTERM 后 2 秒才退，v2 每 100 毫秒重试，第 18 次（SIGTERM 后 2096 毫秒）抢到 |
| 6 | 同时抢一把空锁 | 每次**恰好一个**赢 | v2 一个、bridge 两个进程在同一时刻抢，20 轮每轮恰一个赢（v2 赢 14 轮）。再跑 10 轮看输家，20 个输家全是 `BridgeAlreadyRunningError` |
| 7 | 锁里的字段写错会怎样 | 都会**让 bridge 当成残留锁抢走** | appId 写成别的 bot：持有者还活着，bridge 照样删锁抢到。`startedAt` 用秒而不是毫秒：抢到。pid 是别的用户的进程（pid 1，`kill(1, 0)` 报 EPERM）：bridge 当成死进程，抢到。`startedAt` 缺失或是字符串时只看 pid 死活，拒绝 |
| 8 | 能不能"防止有人手动 run" | **部分**：能挡住第二条长连接，挡不住 `start` 重新装回自启 | 见下文"对设计的影响"。`run` 单 bot 时被拒后退出码 1；多 bot 时是 supervisor 的子进程被拒、按退避重启；`start` 不看锁，照样写 plist、bootstrap。这三条是读代码得到的，没跑 bridge 的 CLI，Mac 上由 e08 实测 |

## 怎么测的

- bridge 用的是 npm 上的发布包：在临时目录里 `npm pack @modelzen/feishu-codex-bridge@0.6.14`，`gitHead` 是 `6698118352d7…`，tarball 的 sha256 是 `e70baa8c…`。没装，也没碰真实的 `~/.feishu-codex-bridge`（JP-VPS 上本来就没有这个目录）。
- 发布包的 `dist/cli.js` 是打包好的单文件，锁函数没导出。脚本按 `// src/config/paths.ts`、`// src/platform/spawn.ts`、`// src/core/single-instance.ts` 三个分段注释，把这三段原样切出来，拼成一个可以 import 的模块，三段一共 247 行。改动只有两处：`cross-spawn` 换成绝对路径（仓库 `node_modules` 里的 7.0.6，和 bridge 声明的 `^7.0.6` 一致），末尾加了 export。切出来的锁函数和 bridge 仓库 `6698118` 的 `src/core/single-instance.ts` 逐行对过，逻辑一样。
- v2 一侧用 jiti 直接跑仓库源码 `packages/daemon/src/core/single-instance.ts`。这个文件和它依赖的 `paths.ts`、`data-root.ts`、`spawn.ts` 在 `e55ffbe` 和 `bfc01d7` 上完全一样。v2 的锁函数和 bridge 的只差一个 `readSingleInstanceHolder`，其余逐行相同。
- 脚本都放在 `<scratch>/e07/probe/`，和解开的包分开放：
  - `v2-holder.mjs <appId> <锁文件>`：用 v2 的函数占锁，然后挂着。收到 SIGUSR2 时 `process.exit(0)`，是正常退出；SIGTERM 不装处理器。
  - `bridge-contender.mjs <appId>`：先 `useBotDir(appId)`，再用 bridge 的函数和默认路径去抢，打印抢之前和之后的锁内容、错误名和 pid。
  - `bridge-holder.mjs <appId> <毫秒>`：模拟在跑的 bridge，收到 SIGTERM 后等一会儿再 release 并退出，和 `run.ts` 的优雅退出一样。
  - `run-all.mjs` 把上面几个串起来跑；`s9.mjs` 重跑并发那一项，记下输家的错误名。
- `HOME` 只写在启动编排脚本的那条命令前面：`HOME=<scratch>/e07/homes/run1 flock -w 600 /tmp/vonvon-heavy.lock node <scratch>/e07/probe/run-all.mjs`，没有 export。子进程继承这个 HOME，编排脚本开头先检查 HOME 在临时目录里，不在就停下。
- app id 用的是假的（`cli_…A`、`cli_…B`），不连飞书，不碰任何凭据。
- 测 startedAt 的那一项：先记下 `t0 = Date.now()`，紧接着起一个 `sleep 900` 当"活的持有者"，等 3 秒后，依次手写 `{pid: sleep 的 pid, appId, startedAt: t0 + delta}`，每写一次起一个 bridge 进程去抢。另外找了本用户启动最早的一个进程（etime 是 `2-00:30:44`，带天数），确认 bridge 能解析带天数的格式。

## 原始现象

临时 HOME 写成 `<HOME>`，app id 截短了。

1. v2 写出的锁，bridge 去抢：

```
S1.holder {"pid":1335444,"raw":"{\"pid\":1335444,\"appId\":\"cli_…A\",\"startedAt\":1792067882502}\n","keys":["pid","appId","startedAt"],"endsWithNewline":true}
S1.contend0 {"exit":1,"r":[{"tag":"REFUSED","name":"BridgeAlreadyRunningError","isBridgeErr":true,"pid":1335444,
  "message":"另一个 bridge 进程已在运行 (PID 1335444)。先停掉它（kill 1335444）再启动——两个进程会抢同一 App 的卡片回调，导致按钮时灵时不灵。",
  "file":"<HOME>/.feishu-codex-bridge/bots/cli_…A/processes.json","unchanged":true}]}
（contend1、contend2 相同）
S1.v2.readHolder {"pid":1335444,"startedAt":1792067882502}
S1.fileUnchanged true
```

2. 持有者退出：

```
S2.holderExit {"code":0,"signal":null,"lockExists":false}
S2.contend    WON，before 为 null
S3.SIGTERM.holderExit {"code":null,"signal":"SIGTERM","lockLeft":"{\"pid\":1335490,…}\n","samePid":true}
S3.SIGTERM.v2.readHolder null
S3.SIGTERM.contend WON，before 是留下的旧锁，raw 是 bridge 自己的新锁
S3.SIGKILL.*  和 SIGTERM 一样
```

3. startedAt+15s（活进程启动 3 到 4 秒时）：

| startedAt 相对进程启动 | bridge |
|---|---|
| +1 小时 | 拒绝 |
| 0 | 拒绝 |
| -10 s | 拒绝 |
| -14 s | 拒绝 |
| -14.5 s | 抢到 |
| -15.5 s | 抢到 |
| -16 s | 抢到 |
| -20 s | 抢到 |
| -60 s | 抢到 |
| 用秒写的 `startedAt` | 抢到 |
| 没有 `startedAt` | 拒绝 |
| `startedAt` 是字符串（早 1 小时） | 拒绝 |
| 带天数的老进程，`startedAt` 为现在 | 拒绝 |
| 带天数的老进程，`startedAt` 早于它启动 1 小时 | 抢到 |
| pid 1（别的用户），`startedAt` 为现在 | 抢到 |

bridge 的判断是 `Date.now() - etime秒 * 1000 > startedAt + 15000` 就算 pid 被复用（`src/core/single-instance.ts:63`、`:88`）。etime 向下取整，算出来的启动时刻会比真实值晚 0 到 1 秒，所以 -14.5 s 这次就被判成复用了。

4. 写错 appId：

```
S6.wrongAppId {"holderPid":1335709,"exit":0,"r":[{"tag":"WON",…,"before":"{\"pid\":1335709,\"appId\":\"cli_…B\",…}\n","raw":"{\"pid\":1335738,\"appId\":\"cli_…A\",…}\n"}],"holderAlive":true}
```

持有者还活着，锁已经被 bridge 换掉。持有者退出时，它的 release 先比对 pid，不会误删别人的锁。

5. bridge 在跑，v2 去抢：

```
S8.v2.readHolder {"bridgePid":1335747,"holder":{"pid":1335747,"startedAt":1792067891892}}
S8.v2.firstTry   {"name":"BridgeAlreadyRunningError","pid":1335747}
S8.v2.afterStop  {"msAfterSigterm":2096,"tries":18,"bridgeExit":{"code":0,"signal":null}}
S8.released      {"lockExists":false}
```

6. 并发：

```
S9.summary {"rounds":20,"allExactlyOne":true,"v2Wins":14}
s9 输家错误名 {"BridgeAlreadyRunningError":20}
```

## 对设计的影响

**product.md 第 5 节第 4 步可行**，第 9 节第 10 项的预查结论是"能"。s61 实现时要注意下面几条，前五条是这次实测的，后面是读 bridge 代码得到的。

1. **每个 bot 一把锁**。bridge 的锁在 `~/.feishu-codex-bridge/bots/<appId>/processes.json`（`run.ts:141` 之前 `onboarding.ts:92` 先 `useBotDir`），不是一个总的 `processes.json`。导入要给每个 bot 各写一把，`appId` 要和目录名完全一致，写错就会被 bridge 当成残留锁抢走。调 v2 的函数时要传 bridge 的路径，默认路径是 vonvon 自己的数据目录。
2. **持有者要是同一个用户下、活过整个事务的进程**，并且由它自己写锁。持有者的 pid 一死，锁就失效，所以不能让一个跑完就退的辅助进程去写；用别的用户的 pid 也不行，bridge 会当成死进程。v2 的函数在持有者进程里写 `Date.now()`，`startedAt` 一定不早于进程启动，startedAt+15s 那条判断不会误伤。不要复用旧锁记录，也不要自己拼 `startedAt`。
3. **第 3 步到第 4 步之间要等 bridge 退干净**。v2 的函数遇到活的 bridge 立即抛错，不重试。`stop` 之后 bridge 还在优雅退出（关 codex 会话等），s61 要轮询重试到抢到为止，并给一个上限。抢不到时，如果持有者已经不是预检看到的那个 bridge 进程，说明有人在这段空档里手动起了 bridge，按失败回滚。
4. **回滚时先放锁再 `start` bridge**。不然 launchd 起来的 `run` 会被自己的锁拒掉，要等放锁后的下一次拉起（e06 测到 `KeepAlive=true` 时约 10 秒一次）。s61 验收里"回滚后 bridge 重新起来"要算上这段时间。
5. **抢锁是原子的**，空锁上同时抢只会有一个赢，输家都是 `BridgeAlreadyRunningError`，s61 不用另加互斥。
6. **锁挡得住第二条长连接，挡不住 `start`**。按代码：
   - `run`，单 bot：在拿锁前先校验凭据（`onboarding.ts:98`，会请求飞书），拿锁失败时打印上面那句话，退出码 1，不连长连接（`src/cli/commands/run.ts:139-154`）。
   - `run`，多 bot：supervisor 自己不拿锁，子进程 `run --bot` 被拒后按 1 秒到 30 秒的退避一直重启（`src/bot/supervisor.ts:122-136`）。一放锁，子进程最多 30 秒后就连上了。
   - `start`：不看锁，照样写 plist、`launchctl bootstrap`（`src/cli/commands/daemon.ts:56`、`src/service/launchd.ts:80-100`）。plist 是 `RunAtLoad`、`KeepAlive=true`，起来的 `run` 被拒、退出、再被拉起，一直循环。第 3 步删掉的自启就这样被装回来了。
   所以 s61 和 s62 不能只靠锁：写迁移标记前，再查一次 bridge 的 plist 和 launchd 任务还在不在，在的话再调一次 `stop`。v1-plan 的 s62 已经写了"之后每次启动都占 bridge 的锁"，这条要保留：放锁以后，0.6.14 的 `run` 或被装回的 launchd 任务就会连上，和 vonvon 抢同一个 app 的卡片回调。
7. **长期占锁时，0.6.14 给用户的提示会误导人**。它会说"另一个 bridge 进程已在运行 (PID x)。先停掉它（kill x）"，x 是 vonvon daemon 的 pid。用户照做，daemon 一死锁就失效，bridge 抢到；vonvon 的 LaunchAgent 再把 daemon 拉起来时，抢锁会抛 `BridgeAlreadyRunningError`。s62 要处理这种情况：这个 bot 不启动，告诉主人 bridge 正在跑它。s64（bridge 最后一版）要在拿锁之前先看迁移标记，换掉这句提示。
8. **只导入有 `bots.json` 的安装**。没有 `bots.json` 的老式平铺安装，bridge 下次运行时会把顶层的 `processes.json` `rename` 到 `bots/<appId>/processes.json`（`src/config/bots.ts:78-80`、`:180-183`），覆盖掉 vonvon 写的锁。用过 0.6.x 的人应该都已经有 `bots.json`，预检遇到没有的就拒绝导入。
9. 小事：v2 的函数每拿一把锁就挂一个 `process.once('exit')`。一个 daemon 占 11 把以上时，Node 会打 `MaxListenersExceededWarning`。s62 一次给多个 bot 占锁时，改成共用一个 exit 回调。

## 没测到的

- **真实的 bridge CLI**：`run` 在拿锁前要校验真实凭据，假 app 走不到拿锁那一步，所以只测了函数，`run`、多 bot 子进程和 `start` 的表现是读代码得到的。被拒后进程是不是马上退出，取决于还有没有没关的句柄，也没测。这些都归 e08，在 Mac 的测试用户账号里装 bridge 0.6.14 实测。e08 的预期要改：`start` 这条命令本身不会被拒，会重新装好 plist 和 launchd 任务，然后被拉起的 `run` 反复被拒。
- **macOS 的 `ps` 和 `kill(pid, 0)`**：只在 Linux 的 procps 上测了 etime 解析和 EPERM。macOS 的 `ps -o etime=` 格式按手册是一样的，e08 顺带看一下。
- **系统时钟跳变**：推断，没测。Linux 的 etime 按开机以来的时间算，墙上时钟向前跳 15 秒以上时，长期持有的锁会被 bridge 误判成 pid 复用而抢走。macOS 的 `ps` 怎么算 etime 没查。只要 s62 长期占锁，这种情况就会出现，e08 或 s62 的 Mac 检查可以拨一次时钟看看。
- **launchd 的退出顺序**：`launchctl bootout` 先发 SIGTERM，超时再 SIGKILL。SIGKILL 留下的残留锁这次已经确认能被抢到；bridge 实际优雅退出要多久，e08 实测。
