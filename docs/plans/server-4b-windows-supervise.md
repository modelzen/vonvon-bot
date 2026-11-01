# I4b `server-4b-windows-supervise`：`__win-supervise` 监督进程

依据 `docs/plans/devices.md` §7.4 的"监督进程"一段、§13 的 I4b 行、`docs/architecture.md` 55-65 的退出码规则。契约 C5（`current.txt`）、C6（退出码）、C3（`update-status.json`）在 `docs/plans/server-3-update-engine.md` §4.1；任务 XML 和启动器在 `docs/plans/server-4a-windows-task.md`。I3 §4.6 把 Windows 的升级回滚交给本文，这里把它写全。缩写同 `devices.md`。

代码由 Claude 在 Linux 上写；监督逻辑全部是平台无关的进程管理（`spawn`、退出码、定时器、文件），单元测试在 Linux 上用假子进程跑；真 Windows 的行为按 §6 的清单由 Windows Codex 验收，和 I4a、I2b 同一个任务发。

## 1. 做什么

Windows 上计划任务起的不是 daemon 本身，而是一个监督进程 `vonvon __win-supervise --port N`。它起 daemon 子进程、按退出码办事：0 停下不拉；75 看 `current.txt`——变了就把新版本的启动器起成新监督进程然后自己退出，没变就立刻重启；其他退出码 5 秒后重启。升级时新版本起不来，由监督进程切回上一版（Windows 没有 I3 的看门狗）。所有后台起的进程都不弹控制台窗口。

## 2. 范围

做：
- `D/cli/commands/win-supervise.ts`（替换 I4a 的占位）和 `D/host/win-supervisor.ts`（可测的核心：`superviseLoop(deps)`）。
- `<数据目录>\supervisor.lock`（单实例）、`<数据目录>\supervisor.pid`（I4a 卸载时等它）。
- 75 的交接（新启动器成新监督进程）、交接失败的回退、升级回滚（两处）。
- `windowsHide: true` 普查：所有 `detached: true` 的 `spawn`，加一条源码检查测试。
- I4a 卸载第 2 步的补充：`/End` 之后按 `supervisor.pid` `taskkill`（交接后的监督进程不再被任务计划程序跟踪，`/End` 够不着它）。
- 监督进程日志 `<数据目录>\supervisor.log`，1 MiB 轮转一份。

不做：
- 非 Windows 的监督（systemd、launchd 自己管）。`__win-supervise` 在非 win32 上也能跑（测试用），但 `service install` 不会在别的平台写它。
- 任务计划程序之外的拉起（开机未登录）、Windows 服务。
- daemon 的 `daemon run` 行为改动——它已经按 C6 退 0 / 75 / 其他；`VONVON_SERVICE` 的判定（`lifecycle.ts:102`）不改。

## 3. 现在的代码

- `D/host/lifecycle.ts`：`observeShutdown(parentControl)`：`serviceManaged = Boolean(process.env.VONVON_SERVICE) && !process.send`；`parentControl` 为真时 stdin 收到关闭请求（stdin 关闭或一行）就排空退出；托管时 restart 退 75、stop 退 0；win32 下没有 SIGTERM，强杀用 `taskkill /T /F`。
- `D/cli/index.ts`：`daemon run --port <n> [--parent-control]`；隐藏命令用 `{ hidden: true }`。
- `D/cli/commands/daemon.ts` `runStart` 的 detached spawn：`stdio: ['ignore', log, log]`，日志 `paths.appDir/daemon.log`，`delete env.VONVON_SERVICE`。
- `D/service/update.ts` 的 `acquireUpdateLock()`：`O_EXCL` 建锁、写 pid、陈旧按 pid 存活回收——`supervisor.lock` 照抄这个模式（抽成 `D/platform/pid-file-lock.ts` 两边共用）。
- `D/platform/spawn.ts` 的 `crossSpawn` 包装带 `windowsHide: true`；但 `daemon.ts`、`lifecycle.ts`、`restart.ts`、`service-action.ts` 直接用 `node:child_process` 的 `spawn`，没带。
- I1：`runtimeDistribution()` 对 standalone 回 `{ kind: 'standalone', cliPath, installRoot }`；`core/version.ts` 的 `currentVersion()`。
- I3：`current-release.ts` 的 `readCurrent`/`switchCurrent`、`readUpdateStatus`/`finishOwnedUpdate`、`selfEntry()`。
- I4a：任务动作 `conhost.exe --headless "<安装根>\bin\vonvon-server.cmd" __win-supervise --port N --home "<数据目录>"`；占位命令起 daemon 并自己重起（0 停、75 立刻、其他 5 秒）；`renderWindowsLaunchers`；uninstall 等 `supervisor.pid`。
- `D/provider/process/windows-supervisor.ts` 是 Codex provider 的进程监督，名字相近、无关；本文的文件叫 `win-supervisor.ts`。

## 4. 怎么改

### 4.1 进入和单实例

`__win-supervise --port <n>`：
1. `distribution = runtimeDistribution()`；不是 `standalone` → stderr 一行、退 64（配置错；任务就此结束，不会再被拉起：`RestartOnFailure` 只管任务起不来，不看退出码，I4a 审查 F4）。`installRoot`、`ownVersion = currentVersion()`。
2. `acquireFileLock(<数据目录>\supervisor.lock)`（`O_EXCL`、写 `{ pid, startedAt }`；已存在 → 读 pid，活着 → **退 0**（已有监督进程，`IgnoreNew` 之外的第二道；比如交接后的孤儿还在跑而用户又登录了一次）；死了 → 删掉重建）。拿不到也不是活的（EACCES 等）→ 退 64。
3. 写 `supervisor.pid`（`{ pid, startedAt, version: ownVersion }`，`.tmp` + `rename`）。
4. 日志：`<数据目录>\supervisor.log` 追加，每行 `<ISO 时间> [supervise] …`；超过 1 MiB 时在下一次写之前 `rename` 成 `supervisor.log.1`（覆盖旧的 `.1`）。
5. 进程自身的退出：`process.on('exit')` 删 `supervisor.pid`、放 `supervisor.lock`（只在是自己写的时候：比 pid）。Windows 下控制台事件只有 `SIGINT`/`SIGBREAK`（任务是隐藏窗口，基本不会有），收到就对子进程走 §4.4 的停止，然后退 0。被 `taskkill /F` 杀掉时什么都跑不了：锁和 pid 文件留下，下一次按 pid 存活回收。

### 4.2 起子进程

```
spawn(process.execPath, [selfEntry(), 'daemon', 'run', '--port', String(port), '--parent-control'], {
  env: { ...process.env, VONVON_SERVICE: 'windows', VONVON_HOME: <数据目录> },
  stdio: ['pipe', daemonLog, daemonLog],   // daemon.log，和 daemon start 用同一个文件
  windowsHide: true, detached: false,
})
```
- 用 **`spawn` 不用 `fork`**：`fork` 建 IPC 通道让 `process.send` 存在、`serviceManaged` 为假，daemon 就会在 restart 时自己起助手而不是退 75。
- `process.execPath` 和 `selfEntry()` 是**监督进程自己的版本**（`releases\<ownVersion>\…`）：子进程和监督进程永远同一版本，交接（§4.3）保证 `current.txt` 变了之后监督进程换成新版本。不读 `current.txt` 来选子进程版本：那样老监督进程会一直占着老 `node.exe` 又跑着新代码，I3 §4.10 的清理永远删不掉老版本。
- `--parent-control`：stdin 是管道，监督进程要停 daemon 时写一行 `shutdown\n` 并关 stdin（`lifecycle.ts:157` 那条路径——核对它接受的具体字节；今天桌面端是关 stdin），daemon 排空后退 0。这样监督进程不需要凭据就能让 daemon 排空退出（Windows 没有 SIGTERM）。
- 记 `childStartedAt = now()`。`spawn` 的 `error` 事件（ENOENT：`releases\<ownVersion>\` 被删了）→ 当作"其他退出码"处理（§4.4），但等待 30 秒而不是 5 秒。

### 4.3 退出码 75：交接

子进程退 75：
1. `cur = readCurrent(installRoot)`（C5；`null` → 当作没变，记日志）。
2. `cur.version === ownVersion` → **立刻**再起子进程（§4.2），`consecutiveFailures = 0`。这是 `daemon restart` 和"升级后新进程又 restart"的路径。
3. 不同（升级切了 `current.txt`）：
   a. 放 `supervisor.lock`（删文件；`supervisor.pid` 先留着，等新的来覆盖）。
   b. `spawn('<installRoot>\\bin\\vonvon-server.cmd', ['__win-supervise', '--port', port], { detached: true, stdio: 'ignore', windowsHide: true, shell: false })`，`unref()`。`.cmd` 要经 `cmd.exe`：Node 对 `.cmd` 文件的 `spawn` 在 `shell: false` 时会报 EINVAL（Node 20+ 的 CVE-2024-27980 修复），所以这里 `spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', '"<installRoot>\\bin\\vonvon-server.cmd" __win-supervise --port <port>'], { windowsVerbatimArguments: true, … })`——路径加引号、参数只有我们自己拼的数字，没有用户输入。
   c. 等 `supervisor.pid` 的 `pid !== 自己` 且 `version === cur.version` 且那个 pid 活着，每 500 毫秒查、**10 秒**。
   d. 出现 → 记日志 `handed over to <version> pid <n>`，退 **0**。（任务计划程序看到任务进程退 0，任务结束；新监督进程是没人跟踪的孤儿，直到下次登录任务再起、被 `supervisor.lock` 挡回去——它退 0。见 §4.7。）
   e. 10 秒没出现 → **交接失败**：
      - 试重拿 `supervisor.lock`；拿不到且持有者活着 → 新的其实起了只是慢，退 0。
      - 拿到了 → 读 `update-status.json`：`phase === 'restarting'` 且 `to === cur.version` → 这是升级，新版本起不来 → **回滚**：`switchCurrent(installRoot, status.previous ?? ownVersion)`，`finishOwnedUpdate(status, 'error', '新版本的监督进程没起来，已切回 <previous>')`，`rolledBack: true`，事件写进日志（daemon 不在跑，没法发诊断事件；新 daemon 起来后 I3 的 bootstrap 读到 `error` 状态会补发 `update-standalone-rolled-back`）。不是升级（有人手改了 `current.txt`）→ 只记日志，不动 `current.txt`。
      - 然后重写 `supervisor.pid`，继续用**自己的版本**起子进程（第 2 条）。

### 4.4 退出码 0 和其他

- **0**：daemon 被 `daemon stop` / `machine.stopHost` / `service uninstall` 停下，或 bootstrap 发现注册不是自己的（`architecture.md`"管理器拉起的进程…退出 0"）。监督进程删 `supervisor.pid`、放锁、退 0。任务计划程序：任务结束，直到下次登录。
- **其他**（崩溃、`spawn` error、被 `taskkill` 杀）：`consecutiveFailures += 1`；等待 = 子进程活了不到 60 秒且 `consecutiveFailures >= 5` → **30 秒**，否则 **5 秒**；`spawn` error 固定 30 秒。等待后：
  - 先看升级回滚（Windows 没有看门狗，监督进程兼任 I3 §4.6 的 90 秒规则）：`update-status.json` 是 `restarting` 且 `to === ownVersion`（我是新版本，是交接过来的），且距 `status.at` 已超过 **90 秒**或 `consecutiveFailures >= 3` → `switchCurrent(previous)`、`finishOwnedUpdate(status, 'error', '新版本起不来，已切回 <previous>')` `rolledBack: true`，然后按 §4.3 第 3 条交接给 `previous` 的启动器（`cur.version` 现在是 previous ≠ ownVersion），交接失败就只能继续起自己的版本并记日志（这时两个版本都起不来，用户要 `vonvon daemon start` 或重装）。
  - 不是升级 → 再起子进程。
  - 子进程活过 60 秒 → `consecutiveFailures = 0`。
- 永不放弃（devices：5 秒后重启）；30 秒的退避只是让一个坏掉的安装不要每 5 秒写一次日志。

### 4.5 停止监督进程本身

`service uninstall`（I4a）走的是 `stopHost` → daemon 退 0 → 监督进程退 0，不需要直接杀监督进程。但有两处要能停它：
- I4a 卸载第 2 步 10 秒超时的兜底改成：`schtasks /End`（任务还跟踪着的话有效）→ 读 `supervisor.pid`，活着就 `taskkill /PID <pid> /F`（不 `/T`：先单杀监督进程，免得 daemon 在排空中被打断），再读 daemon 的 pid 锁，还活着 → 再等 10 秒 → `taskkill /T /F /PID <daemon pid>`。
- 监督进程收到 `SIGINT`/`SIGBREAK`：对子进程写 `shutdown\n` 关 stdin，等 **30 秒**，没退就 `taskkill /T /F`，然后自己退 0。

### 4.6 `windowsHide` 普查

- `daemon.ts` 的 detached daemon、`lifecycle.ts` 的助手、`restart.ts`、`service-action.ts`、I3 的看门狗、I4a 的 `rundll32`、本文的全部 `spawn`：都带 `windowsHide: true`。
- `packages/daemon/test/spawn-hidden.test.ts`：读 `src/**/*.ts`，找每个 `spawn(`/`execFile(`/`spawnSync(` 调用的选项对象字面量（简单正则：同一语句内 `{ … }` 里有 `detached: true` 或文件在 `host/`、`service/`、`cli/commands/` 下），要求同一个对象里有 `windowsHide: true`，或者调用的是 `platform/spawn.ts` 的包装；白名单列出确有理由不隐藏的（目前没有）。

### 4.7 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.4 "监督进程自己 `exec` 新版本的启动器后退出" | `spawn`（经 `cmd.exe /c`）新启动器、等它写 `supervisor.pid`、再退 0 | Node 没有 `execve`；`.cmd` 不能直接 `spawn`（EINVAL） |
| 没写交接后任务计划程序怎么看 | 新监督进程是任务不跟踪的孤儿：`schtasks /Query` 的 `Status` 会显示 `Ready`，`/End` 够不着它；下次登录任务再起的实例被 `supervisor.lock` 挡回去 | 不想靠 `RestartOnFailure` 的 1 分钟延迟换版本；状态判定本来就按 pid 锁（I4a §4.3），卸载按 `supervisor.pid` 杀 |
| §7.4 "别的退出码 → 5 秒后重启" | 连续 5 次 60 秒内崩 → 30 秒 | 坏安装不要每 5 秒刷日志和 CPU；仍不放弃 |
| I3 §4.6 的看门狗 90 秒 | Windows 由监督进程做，条件是"90 秒或连续 3 次崩" | 监督进程就在现场，直接看子进程退出比定时读文件准；两个人改 `current.txt` 会打架 |
| §7.4 子进程"用 `spawn`"没写 stdin | `--parent-control` + stdin 管道，停 daemon 写 `shutdown\n` | Windows 没有 SIGTERM，监督进程又没有凭据发 RPC |

## 5. 测试

Linux 上跑：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/win-supervisor*.test.ts packages/daemon/test/spawn-hidden.test.ts`。`superviseLoop(deps)` 的 `deps`：`spawnChild(version) → FakeChild`（`exit(code)`、`stdin` 可写、`startedAt`）、`spawnLauncher(version)`、`readCurrent`、`switchCurrent`、`readUpdateStatus`、`finishOwnedUpdate`、`now`/`setTimeout`（假时钟）、`fs`（mkdtemp 真目录）、`pid`、`isAlive(pid)`、`log`。不碰真 `schtasks`、`cmd.exe`、`taskkill`，不起真 daemon。

| 用例 | 输入 → 期望 | main 必败 |
|---|---|---|
| 启动 | 非 standalone → 退 64；`supervisor.lock` 被活 pid 占 → 退 0、不起子进程；被死 pid 占 → 回收、起子进程；`supervisor.pid` 内容 `{ pid, startedAt, version }` | 是 |
| 子进程参数 | `spawnChild` 收到 `['daemon','run','--port','7788','--parent-control']`、env 含 `VONVON_SERVICE: 'windows'`、`VONVON_HOME`、`windowsHide: true`、`stdio[0] === 'pipe'`、没有 IPC（不是 fork） | 是 |
| 退 0 | 子进程 `exit(0)` → 循环结束、退 0、`supervisor.pid` 和 `.lock` 都删了、没有再 spawn | 是 |
| 退 75 同版本 | `readCurrent` 回自己 → 立刻（假时钟 0 毫秒）再 spawn，`consecutiveFailures` 为 0 | 是 |
| 退 75 换版本，成功 | `readCurrent` 回 `1.0.1`（自己 `1.0.0`）→ 顺序：锁文件删了 → `spawnLauncher('1.0.1')` 被调（命令是 `ComSpec`、参数含 `"<root>\bin\vonvon-server.cmd" __win-supervise --port 7788`、`windowsHide`、`detached`）→ 假的新监督在 2 秒后写 `supervisor.pid{ pid: 999, version: '1.0.1' }` 且 `isAlive(999)` → 退 0，日志含 `handed over` | 是 |
| 交接失败：升级 | 10 秒没有新 pid；`update-status.json` 是 `restarting to 1.0.1 previous 1.0.0` → `switchCurrent('1.0.0')` 被调、`finishOwnedUpdate(…, 'error', …)` 的 message 含 `1.0.0`、`rolledBack: true`、锁重拿、`supervisor.pid` 重写、再 spawn 自己版本的子进程 | 是 |
| 交接失败：非升级 | 状态文件不存在 → 不调 `switchCurrent`，日志一条，继续起自己 | 是 |
| 交接慢 | 10 秒后锁被活 pid 占 → 退 0，不回滚 | 是 |
| 其他退出码 | `exit(1)` → 5 秒后再 spawn；连续 5 次每次活 1 秒 → 第 6 次等 30 秒；活了 61 秒后崩 → 回到 5 秒；`spawnChild` 抛 ENOENT → 30 秒 | 是 |
| 升级回滚（我是新版本） | 自己 `1.0.1`，状态 `restarting to 1.0.1 previous 1.0.0 at = now - 95s`，子进程 `exit(3)` → 5 秒后：`switchCurrent('1.0.0')`、`error rolledBack`、`spawnLauncher('1.0.0')`；`at = now - 10s` 且这是第 1 次崩 → 不回滚、再起；第 3 次崩 → 回滚 | 是 |
| 回滚后的交接也失败 | `spawnLauncher('1.0.0')` 后 10 秒没新 pid → 继续起 `1.0.1`（自己），日志含"两个版本都" | 是 |
| SIGINT | 触发 → 子进程 stdin 收到 `shutdown\n` 且被关 → 子进程 2 秒后 `exit(0)` → 监督退 0；子进程不退 → 30 秒后 `taskkill /T /F /PID` 被调 | 是 |
| 日志轮转 | 写满 1 MiB + 1 → `supervisor.log.1` 存在、`supervisor.log` 只有新的一行 | 是 |
| `spawn-hidden.test.ts` | 当前源码里所有 `detached: true` 的调用都带 `windowsHide: true`；人为去掉 `daemon.ts` 那一处（测试里对源码字符串做替换后再跑检查函数）→ 报出文件和行 | 是（`daemon.ts` 等四处今天没带） |
| I4a 卸载兜底（`service-windows-transaction.test.ts` 扩） | 10 秒 `supervisor.pid` 不消失 → 顺序 `/End` → `taskkill /PID <sup> /F` → daemon 锁还活 → 10 秒 → `taskkill /T /F /PID <daemon>` → `/Delete` | 是 |
| `lifecycle` 的 stdin 协议 | `observeShutdown(true)` 收到 `shutdown\n` 或 stdin 关闭 → 触发停止（已有测试，补一条写 `shutdown\n` 的） | 看现状 |

## 6. 自测和验收

JP-VPS：构建、typecheck、lint、§5 全绿；另外在 Linux 上**真跑一次监督循环**（不碰服务管理器）：`T=$(mktemp -d)`，用 I1 的 linux-x64 包解成 `$T/root/releases/1.0.0`，`ln -s releases/1.0.0 $T/root/current`（Linux 上 `readCurrent` 走 POSIX 分支读符号链接；`current.txt` 的两行解析只在单元测试里按注入的 `platform: 'win32'` 跑；交接那一步在 Linux 上 `spawnLauncher` 起的是 `bin/vonvon`，逻辑相同），`HOME=$T/home VONVON_HOME=$T/home/.vonvon-bot $T/root/releases/1.0.0/node/bin/node $T/root/releases/1.0.0/app/bin/vonvon.mjs __win-supervise --port <p>` 在前台跑 → 另一个终端 `vonvon status` 连得上 → `kill -9 <daemon pid>` → 5 秒内 `status` 又连得上 → `vonvon daemon restart` → 立刻回来、pid 变了 → `vonvon daemon stop` → 监督进程退 0。`rm -rf -- "${T:?}"`。

**Windows 验收清单**（接 I4a 的清单，同一个任务；前提同 I4a，I4b 合入后的包）：
1. `service install` 后：任务管理器里 `node.exe` 两个（监督 + daemon），都没有窗口；`%USERPROFILE%\.vonvon-bot\supervisor.pid` 的 pid 是监督进程；`supervisor.log` 有 `started` 一行。
2. 用任务管理器**结束 daemon 的 `node.exe`**（pid 来自 `daemon.pid`）→ 5 秒内 `vonvon status --json` 又连得上，pid 变了；`supervisor.log` 记了退出码和 `restart in 5s`。
3. 连续结束 5 次 → 第 6 次等了约 30 秒；之后让它跑满 1 分钟再结束 → 又是 5 秒。
4. `vonvon daemon restart` → 1 秒内回来，监督进程 pid 不变。
5. `vonvon daemon stop` → daemon 和监督进程都退出；`supervisor.pid`、`supervisor.lock` 不在；任务 `Status` 是 `Ready`；**1 分钟内不会自己回来**。`vonvon daemon start` → 两个进程又在。
6. 升级交接（I3 合入后；本机假 CDN 用 hosts 指 `dl.vonvon.cc` 到 loopback 的 HTTPS 服务器 + 自签证书装进用户信任库，或者直接手工模拟：把 1.0.1 解到 `releases\1.0.1`、把 `current.txt` 改成 `1.0.1\n1.0.0\n`、写 `update-status.json` `{ phase: 'restarting', to: '1.0.1', previous: '1.0.0', from: '1.0.0', at: <now> }`，然后 `vonvon daemon restart`）→ 旧监督进程退出、新监督进程的 `node.exe` 路径是 `releases\1.0.1\node\node.exe`（任务管理器"打开文件所在位置"或 `wmic process get ProcessId,ExecutablePath`）、`vonvon --version` 是 1.0.1、`update-status.json` 变 `done`；`schtasks /Query` 的 `Status` 是 `Ready`（孤儿，预期）。
7. 接着**注销再登录** → 只有一组进程（锁挡住了第二个监督进程），`supervisor.log` 里有一行 `another supervisor is alive, exiting`。
8. 回滚：把 `releases\1.0.2` 的 `app\bin\vonvon.mjs` 改成 `process.exit(3)`，`current.txt` 改 `1.0.2\n1.0.1\n`，状态文件 `restarting to 1.0.2 previous 1.0.1`，`vonvon daemon restart` → 新监督进程（1.0.2）起 daemon 失败三次 → `current.txt` 回到 `1.0.1`、状态 `error rolledBack: true`、监督进程又是 1.0.1 的 `node.exe`、`vonvon status` 连得上。
9. 回滚（新 node.exe 坏）：把 `releases\1.0.3\node\node.exe` 换成空文件，`current.txt` 改 `1.0.3\n1.0.1\n`，状态同上 → 10 秒后旧监督进程回滚、`current.txt` 回 `1.0.1`、daemon 回来。
10. `current.txt` 改到一半（只写第 1 行 `1.0.9`、没有第 2 行、`releases\1.0.9` 不存在）然后 `taskkill /F` 掉监督进程和 daemon，再注销登录 → `.cmd` 退 70、任务 `Last Result` 非 0、任务结束且不再被拉起（`RestartOnFailure` 不看退出码）；恢复 `current.txt` 后 `vonvon daemon start` 能起。（这条验证的是"坏到底时不会无限拉起"，不是自愈——第 2 行有值时才能自愈，I4a 第 8 条已验。）
11. `service uninstall` 在 daemon 排空中（起一个 20 秒的假任务）→ 等排空结束才删任务；再来一次让 daemon 卡死（`taskkill /F` 不行——用 `PsSuspend` 或调试器挂起 daemon）→ 10 秒后 `taskkill` 监督进程、再 10 秒 `taskkill /T` daemon、任务删除。
12. 锁屏 10 分钟、睡眠再唤醒 → 两个进程都在；Bot 在飞书里能回。
13. 把 `supervisor.log` 和 `daemon.log` 的相关段（打码）贴回任务。

## 7. 文档

- `docs/product.md` 3.10：Windows 一段加"崩了 5 秒内回来、连续崩会慢一点、`vonvon daemon stop` 后不回来；升级起不来自动切回上一版"。
- `docs/architecture.md` 55-65：Windows 的 `.cmd` 循环那句换成本文 §4.2–4.4 的三条规则和交接；加"交接后的监督进程不被任务计划程序跟踪"。
- `docs/plans/devices.md` §7.4 加一行指到本文 §4.7。

## 8. 验收要点

- 子进程用 `spawn`、带 `VONVON_SERVICE=windows`、`--parent-control`、`windowsHide`、stdin 管道；没有 IPC。
- 0 / 75 / 其他三条规则和 §4.3、§4.4 一致；75 时先读 `current.txt` 再决定；交接顺序是 放锁 → 起新启动器 → 等 `supervisor.pid` 10 秒 → 退 0；失败回退含升级回滚。
- 升级回滚两处（交接失败、新版本子进程崩）都写 `error rolledBack: true`、切回 `previous`，并有测试；Windows 不起 I3 的看门狗（I3 `platform === 'win32'` 分支）。
- `supervisor.lock` 单实例（活 pid → 退 0），`supervisor.pid` 内容和 I4a 卸载读的一致。
- `windowsHide` 普查测试存在且今天跑红（四处没带）、改完跑绿。
- 等待值（5 秒、30 秒、60 秒、10 秒、90 秒、3 次、5 次）都有测试；永不放弃。
- Windows 验收 13 条写进任务，结果（打码）贴回。
- 测试不起真 daemon、不碰任务计划程序；`HOME`/`VONVON_HOME` 只在命令前。diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 孤儿监督进程（§4.7）让 `schtasks` 的 `Status` 不可信：I4a 的状态判定已经按 pid 锁；但"任务计划程序历史"里会显示任务已结束，用户看着会疑惑——写进 `product.md`。另一条路（退特定码让 `RestartOnFailure` 拉起）走不通：它只管任务起不来，不看退出码（I4a 审查 F4）。
- `.cmd` 经 `cmd.exe /c` 起：安装根带 `&`、`^`、`%` 这类字符时 `cmd` 会解释——路径加了引号能挡住大多数，但 `%` 在引号里仍会展开 `%VAR%`。安装根是 `%LOCALAPPDATA%\VonvonBot\server`，用户名含 `%` 极少见；I4a 启动器测试里加一条带 `%` 的路径看 `.cmd` 行为，不行就记为已知限制。
- `--parent-control` 的 stdin 协议要核对 `lifecycle.ts:157` 到底接受什么（关闭 / 一行文本）；两种都支持最稳。
- `taskkill /F` 杀监督进程时锁和 pid 文件留下，靠 pid 存活回收；pid 被复用的窗口期（Windows 复用快）可能误判"活着"而退 0——`supervisor.pid` 带 `startedAt`，`isAlive` 用 `wmic`/PowerShell 核 `CreationDate` 太重，接受这个窄窗口，下次登录会再试。
- 行数估计 ~900（`win-supervisor.ts` 260、`win-supervise.ts` 40、`pid-file-lock.ts` 50（从 update.ts 抽）、`windowsHide` 普查改动 20、I4a uninstall 补充 30、lifecycle stdin 10、测试 ~450）。不拆。
