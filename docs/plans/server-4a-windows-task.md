# I4a `server-4a-windows-task`：Windows 计划任务、`.cmd` 启动器、`current.txt`

依据 `docs/plans/devices.md` §7.2（Windows 列）、§7.4 的 Windows 一段、§13 的 I4a 行。契约（`current.txt` 两行格式、任务名 C7、退出码 C6、`current-release.ts` C5）在 `docs/plans/server-3-update-engine.md` §4.1。I4b（监督进程）另有计划，本文只写任务的动作行是什么、监督进程要满足什么。缩写同 `devices.md`。

代码由 Claude 在 Linux 上写、单元测试在 Linux 上跑（全部靠注入的 `schtasks` / `whoami` 运行器和 `platform: 'win32'` 参数）；真跑和修由 Windows Codex 按 §6 的验收清单做，任务由 Claude 写、owner 转发。

## 1. 做什么

Windows 上 `vonvon service install` 注册一个**按用户和数据目录命名**的计划任务，用户登录时以最低权限、隐藏窗口运行 `bin\vonvon-server.cmd __win-supervise --port N`；`service status` / `service uninstall` / `daemon start` 都认这个任务；`bin\vonvon.cmd` 和 `bin\vonvon-server.cmd` 读 `current.txt` 第 1 行选版本、缺了退回第 2 行；`vonvon open` 在 Windows 上能开浏览器；桌面端的 `readRegistration` 认出这个任务，不在同一数据目录上再起 bundled daemon。

## 2. 范围

做：
- `D/service/windows.ts`：`createWindowsService({ root }, deps)` 实现 `ServiceAdapter`（`install`、`uninstall`、`status`）加 `start`（给 `startRegisteredDaemon`）。
- `D/service/identity.ts`：`Target` 加 `{ platform: 'win32'; taskName: string }`；`windowsTaskName(sid, root)`（C7）；`serviceTarget({ platform: 'win32', sid, root })`。
- `D/service/definitions.ts`：`SerializedDefinition` 加 `{ platform: 'win32'; xml: Uint8Array }`；`renderDefinition` 的 win32 分支产生任务 XML；`decodeGeneratedDefinition` 的 win32 分支从 XML 里取回 root / port / distribution / capturedPath。
- `D/service/registration.ts`：`readDefinitionBytes` 的 win32 分支走 `schtasks /Query /XML`。
- `D/service/startup.ts`、`D/service/adapter.ts`：win32 不再抛 / 回 `absent`。
- `D/service/windows-launchers.ts`：`renderWindowsLaunchers(root)` 写 `bin\vonvon.cmd`、`bin\vonvon-server.cmd`（I2 的 `__standalone-setup` 在 win32 调它）。
- `D/cli/commands/open.ts`：win32 用 `rundll32 url.dll,FileProtocolHandler <url>`。
- `D/server/snapshot.ts` 的 win32 → `'windows'`；`P/domain.ts` `application.platform` 枚举加 `windows`。
- `DT/daemon-dependencies.ts` `readRegistration` 的 win32 分支。
- 任务 XML 里的动作行是 `__win-supervise`，这条隐藏命令在 I4b 实现；I4a 里先注册一个**占位**：`__win-supervise` 存在、直接 `daemon run` 同参数（不监督），I4b 换成真的。这样 I4a 单独合入也能在 Windows 上跑通安装、状态、卸载。

不做：
- 监督进程本体（I4b）、`windowsHide` 普查（I4b）、升级（I3）、`.ps1`（I2b）。
- 不用登录就能跑的 Windows 服务（`sc.exe`）——进 `product.md`"v1 之后"。
- 桌面端在 Windows 上注册 `vonvon` 或登录自启（owner 2026-10-31：不做）。

## 3. 现在的代码

- `D/service/adapter.ts` 在 win32 直接抛；`startup.ts` 的 `readStartupRegistration` 在 win32 回 `absent`、`startRegisteredDaemon` 抛。
- `identity.ts`：`Target` 只有 darwin / linux；`serviceName()` 给非默认数据目录加 sha256 前 12 位后缀。
- `definitions.ts`：`Definition = { root, port, distribution, capturedPath }`；`SerializedDefinition` 只有 plist / unit；`decodeGeneratedDefinition` 靠**字节相等**认"我们写的"。
- `registration.ts`：`Registration = absent | ours | other-root | unrecognized`；`readDefinitionBytes(target)` 读文件，上限 1 MiB。
- `systemd.ts` / `launchd.ts`：`Dependencies` 注入 `run(command, args)`（返回 `{ ok, status, stdout, stderr }`）、fs 操作、`now`；事务 `install` = 写定义 → 启用 → 启动 → 等 pid 锁 owner；测试用假 fs 和假 `run`（`service-systemd-transaction.test.ts`）。
- `host/service-action.ts`：daemon 进程里不能直接装卸自己的服务，起 detached 助手跑 `service install|uninstall --keep-running`；`LINUX_SERVICE_REFUSAL`。
- `cli/commands/daemon.ts` `runStart`：有注册 → `startRegisteredDaemon`；没有 → detached spawn。
- `cli/commands/open.ts`：darwin `open`、其余 `xdg-open`；`buildOpenUrl(listen, credential)` 生成带一次性凭据的 loopback URL。
- `server/snapshot.ts`：平台 `macos | linux | unsupported`。
- `DT/daemon-dependencies.ts`：直接 `import` daemon 源码（`../../daemon/src/...`），win32 回 `absent`。
- `platform/spawn.ts` 的 `crossSpawn` 包装已带 `windowsHide: true`；`provider/process/windows-supervisor.ts` 是 Codex provider 的进程监督，和本文的服务监督无关，命名上要避开（本文用 `windows.ts` / `win-supervise.ts`）。
- I1：Windows 包是 zip，`node\node.exe`、npm 在 `node\node_modules\npm`；布局 `hoist`，无 symlink。

## 4. 怎么改

### 4.1 身份：任务名和 SID

- `windowsTaskName(sid: string, root: string): string` = `\VonvonBot\${h(sid)}-${h(canonicalWin(root))}`，`h = sha256 → hex 前 12 位`，`canonicalWin(root)` = `path.win32.normalize(root)` 小写、去掉末尾 `\`。**默认数据目录也带两个哈希**（和 C7 一致，不像 darwin/linux 默认不带后缀——Windows 任务是全机命名空间，不带 SID 就撞）。
- SID：`deps.run('whoami', ['/user', '/fo', 'csv', '/nh'])` → 输出一行 `"<域\用户>","S-1-5-21-…"`，取第二列，必须匹配 `^S-1-[0-9-]+$`，否则抛 `SidUnavailable`。进程内缓存一次。
- `Target` 加 `{ platform: 'win32'; taskName: string }`；`serviceTarget({ platform: 'win32', sid, root })`。

### 4.2 定义：任务 XML

`renderDefinition` 的 win32 分支产生（UTF-16LE 带 BOM，CRLF；`schtasks /XML` 要这个编码）：

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>vonvon-bot service v1 {"root":"…","port":N,"distribution":{…},"capturedPath":"…"}</Description>
  </RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-…</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>S-1-5-21-…</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <Enabled>true</Enabled>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>C:\…\VonvonBot\server\bin\vonvon-server.cmd</Command>
    <Arguments>__win-supervise --port N</Arguments>
    <WorkingDirectory>C:\…\VonvonBot\server</WorkingDirectory>
  </Exec></Actions>
</Task>
```
- `Description` 里的 JSON 和 darwin/linux 定义里记的四项相同（`root`、`port`、`distribution`、`capturedPath`），JSON 里的 `"`、`<`、`&` 做 XML 转义。`Command` 是 **启动器**（`<安装根>\bin\vonvon-server.cmd`），不是 `releases\<v>\…`；安装根 = `distribution.kind === 'standalone'` 时 `distribution.installRoot`（I1 的 `Distribution` 有它），不是 standalone → `renderDefinition` 抛 `InvalidDefinitionInput('Windows 只支持 standalone 的服务')`（bundled 在 Windows 不注册服务）。`WorkingDirectory` 是安装根（`.cmd` 用 `%~dp0` 不依赖它，写上只为 `schtasks` 不报缺字段）。
- `RestartOnFailure` 是**监督进程**自己崩了（不是 daemon）的兜底；daemon 的 5 秒重启由监督进程做（I4b）。`AllowHardTerminate true` 让 `/End` 能杀；`IgnoreNew` 保证同一任务不会起两个监督进程。
- `decodeGeneratedDefinition(target, { platform: 'win32', xml })`：`schtasks /Query /XML` 吐回的 XML 是任务计划程序**重新序列化**的，和我们写的不字节相等，所以 win32 分支**不比字节**：解 UTF-16（有 BOM 看 BOM，没有当 UTF-16LE）→ 用正则取 `<Description>`、`<Command>`、`<Arguments>`、Principal 的 `<UserId>`、`<RunLevel>`（不引 XML 库：五个固定元素、我们自己写的结构）→ `Description` 必须以 `vonvon-bot service v1 ` 开头、后面是合法 JSON 且四项齐全；`Command` 和 `安装根\bin\vonvon-server.cmd` 不区分大小写相等；`Arguments` 是 `__win-supervise --port <port>`；`RunLevel === 'LeastPrivilege'`。任一不对 → `unrecognized`，`reason` 写哪一项。和总设计不一样：见 §4.8。
- `readDefinitionBytes(target)` win32：`run('schtasks', ['/Query', '/TN', taskName, '/XML'])`；exit 0 → `{ platform: 'win32', xml: stdout 的字节 }`；exit 1 且 stderr 含 `cannot find the file` / `找不到` / 错误码 `0x80070002` → `null`（absent）——**语言相关**，所以先 `run('schtasks', ['/Query', '/TN', taskName, '/FO', 'CSV', '/NH'])` 判存在（exit 0 存在，exit 1 不存在，和语言无关），存在再 `/XML`。stdout 超 1 MiB → `unrecognized`。

### 4.3 适配器 `D/service/windows.ts`

`createWindowsService({ root }, deps)`，`deps = { run, fs, now, sleep, home, sid?, tmpdir, readLock, verifyOwner, stopHost }`，`run` 的超时 15 秒（`schtasks` 卡住常见于任务计划程序服务没起来），超时算失败。

**install({ port })**，事务顺序和失败：
1. SID（§4.1）；`sid` 拿不到 → `failed`、`reason: 'sid_unavailable'`。
2. 现状：`readRegistration` → `ours` → 可以 `/F` 覆盖；`other-root`（同一用户、同名？不可能——名字含 root 哈希；但 `Description` 里的 root 和请求的 root 不一致也归这类）→ `conflict`、`reason: 'task_other_root'`；`unrecognized`（名字撞上但不是我们写的）→ `conflict`、`reason: 'task_foreign'`、**不带 `/F`**；`absent` → 创建。
3. `renderDefinition` → 写到 `deps.tmpdir` 下 `mkdtemp` 的目录里 `task.xml`（UTF-16LE BOM）。
4. `run('schtasks', ['/Create', '/TN', taskName, '/XML', file, '/F'])`（**只这一种写法**，不和 `/SC`、`/RL`、`/RU` 混用——WIN-2）。exit 非 0：stderr 含 `Access is denied` / `拒绝访问` / `0x80070005` → `refused`、`reason: 'schtasks_denied'`、`fallback: 'detached'`（组策略禁了用户建任务；I2b 的 `.ps1` 据此走 `daemon start`）；其他 → `failed`、`reason: 'schtasks_create_failed'`，stderr 进 `message`。无论成败 `rm` 掉那个 mkdtemp 目录（它是本函数刚建的）。
5. 交接：数据目录的 pid 锁有活着的 owner（detached 起的 daemon）→ `deps.stopHost(listen)`（走 loopback 的 `machine.stopHost`，和今天 Linux 交接一样）→ 等它退出（最多 15 秒，到了就 `taskkill /T /F /PID`，和 `lifecycle.ts` 的 Windows 分支同一招）。`--keep-running` 时跳过这一步并在结果里说"下次登录才由任务接管"。
6. `run('schtasks', ['/Run', '/TN', taskName])` → exit 非 0 → `failed`、`reason: 'schtasks_run_failed'`（任务建好了，结果里写"已注册，下次登录生效；现在 `vonvon daemon start`"）。
7. 等 pid 锁出现新 owner（`readLock` + `verifyOwner`，每 500 毫秒，**30 秒**），到了 → `outcome.kind = 'installed'`，带 `endpoint`；没到 → `installed` 但 `warning: '任务已启动，daemon 30 秒内没起来；看 vonvon daemon logs'`（不回滚任务：定义是对的，可能机器慢）。
崩在第 4 步之后、第 6 步之前：任务在、daemon 没跑；下次登录任务会跑；`service status` 显示 `installed, not running`，`daemon start` 走 `/Run`。崩在第 5 步之后：旧 daemon 停了、任务没跑，同上。

**uninstall()**：
1. `readRegistration`：`absent` → `{ kind: 'not-installed' }`（幂等，exit 0，`reason: 'not_registered'` 在 `--json` 里给 I2 的 `uninstall.ps1` 用）；`unrecognized` / `other-root` → `conflict`，不删别人的任务。
2. daemon 在跑（pid 锁活着）→ `stopHost(listen)`（排空，daemon 退 0 → 监督进程按 C6 退 0）→ 等 `<数据目录>\supervisor.pid`（I4b 写的）消失或其 pid 死掉，**10 秒**；没退 → `run('schtasks', ['/End', '/TN', taskName])`（结束任务的进程 = 监督进程），再看 daemon 的 pid 还活着 → `taskkill /T /F /PID <daemon pid>`。
3. `run('schtasks', ['/Delete', '/TN', taskName, '/F'])` → exit 非 0 且不是"不存在" → `failed`、`reason: 'schtasks_delete_failed'`。
4. 回 `{ kind: 'uninstalled', leftovers: [] }`。顺序是**先停再删**：先删任务再停，监督进程仍在而且无人管；先停再删，中间崩了任务还在、下次登录又拉起来，`service uninstall` 再跑一次就好（幂等）。

**status()**：`readRegistration` → `absent` → `not-installed`（带"daemon 由 `daemon start` 起的在跑"那句如果 pid 锁活着）；`ours` → 再 `run('schtasks', ['/Query', '/TN', taskName, '/FO', 'CSV', '/V', '/NH'])` 取 `Status` 列（`Running` / `Ready` / `Disabled`，**语言相关**，只用来显示，不用来判逻辑）；`installed` 的子状态按 pid 锁：owner 活着 → `running`；不活 → `installed-not-running`，提示 `vonvon daemon start`。`Disabled`（有人在任务计划程序里禁了）→ `disabled`，提示"在任务计划程序里启用，或重新 `vonvon service install`"。

**start({ port, staleOwner })**（给 `startRegisteredDaemon`）：`run('schtasks', ['/Run', '/TN', taskName])` → 等 pid 锁 owner（30 秒）→ `HostEndpoint`。任务 `Disabled` 时 `/Run` 会失败（exit 1）→ 抛"服务被禁用"。

`host/service-action.ts`：daemon 内的 `machine.service install|uninstall` 在 win32 照 Linux 一样起 detached 助手（`spawn(execPath, [selfEntry(), 'service', action, '--keep-running'], { detached: true, windowsHide: true })`）；不再拒绝。

### 4.4 启动器 `D/service/windows-launchers.ts`

`renderWindowsLaunchers(root): { 'bin\\vonvon.cmd': string; 'bin\\vonvon-server.cmd': string }`，`writeWindowsLaunchers(root, fs)` 写 `.cmd.tmp` 再 `rename`。两个文件内容相同，只有第二行的标记不同（`rem Vonvon Bot server CLI v1` / `rem Vonvon Bot server supervisor v1`），分开是让任务的命令行和用户的命令行各自能改。

```bat
@echo off
rem Vonvon Bot server CLI v1
setlocal EnableExtensions DisableDelayedExpansion
set "VONVON_ROOT=%~dp0.."
set "VONVON_VER="
set "VONVON_PREV="
for /f "usebackq delims=" %%L in ("%VONVON_ROOT%\current.txt") do (
  if not defined VONVON_VER ( set "VONVON_VER=%%L" ) else if not defined VONVON_PREV ( set "VONVON_PREV=%%L" )
)
if not defined VONVON_VER ( echo Vonvon Bot: current.txt is empty 1>&2 & exit /b 70 )
if not exist "%VONVON_ROOT%\releases\%VONVON_VER%\standalone.json" (
  if defined VONVON_PREV ( set "VONVON_VER=%VONVON_PREV%" ) else ( echo Vonvon Bot: release %VONVON_VER% is missing 1>&2 & exit /b 70 )
)
if not exist "%VONVON_ROOT%\releases\%VONVON_VER%\standalone.json" ( echo Vonvon Bot: no usable release 1>&2 & exit /b 70 )
set "PATH=%VONVON_ROOT%\releases\%VONVON_VER%\node;%PATH%"
"%VONVON_ROOT%\releases\%VONVON_VER%\node\node.exe" "%VONVON_ROOT%\releases\%VONVON_VER%\app\bin\vonvon.mjs" %*
exit /b %ERRORLEVEL%
```
- `for /f` 跳过空行，所以首次安装 `current.txt` 第 2 行为空时 `VONVON_PREV` 不定义，正好。`DisableDelayedExpansion` 让 `!` 不被吃；`%*` 原样透传（含引号）。`exit /b %ERRORLEVEL%` 让 **75 / 0 / 其他** 透传给任务计划程序和监督进程（I4b 的监督进程是 `node.exe` 直接 `spawn` 子进程，不经 `.cmd`，但 `__win-supervise` 自己是经 `.cmd` 起的，退出码透传让 `RestartOnFailure` 能判）。
- 路径里有空格、中文、括号：全部加引号；`%~dp0` 带尾 `\`，所以 `%~dp0..` 是 `bin\..`。`)` 在 `if ( … )` 块里出现在变量值中会出问题，但我们只在块里 `set`、`echo` 固定文字，值的展开在块外。
- 测试在 Linux 上只能做文本断言 + "`current.txt` 两行解析"的 TS 等价实现（`parseCurrentTxt`，I3 的 `readCurrent` 用同一个）；真跑在 §6。

### 4.5 `daemon start`、`open`、`snapshot`、桌面端

- `startup.ts`：win32 → `serviceTarget({ platform: 'win32', sid, root })` + `readRegistration`；`startRegisteredDaemon` → `createWindowsService(...).start(...)`。`runStart` 不变（有注册走服务，没有 detached spawn，detached spawn 加 `windowsHide: true`——I4b 普查前先把这一处加上）。
- `open.ts` win32：`d.launch('rundll32.exe', ['url.dll,FileProtocolHandler', url])`。先校验 `url`：`^http://127\.0\.0\.1:\d{1,5}/[A-Za-z0-9._~!$'()*+,;=:@/?%#-]*$`（无空白、无 `"`、`&`、`|`、`^`、`<`、`>`——`cmd.exe` 的元字符，虽然不经 cmd，仍不放行），不匹配抛"地址不合法"。和总设计不一样：§7.4 说 `start`，见 §4.8。
- `snapshot.ts`：win32 → `'windows'`；`P/domain.ts` 的 `application.platform` 枚举加 `'windows'`（客户端按开放字符串解析的话这条只是补枚举）。UI 里按 `platform` 分的文案（登录项、服务开关）对 `windows` 显示"由计划任务管理"——这个在 U2 做，这里只让值合法。
- `DT/daemon-dependencies.ts` `readRegistration`：删 win32 的早退，`serviceTarget({ platform: 'win32', sid, root })`，SID 用 daemon 的同一个函数（desktop 直接 import daemon 源码）；`ours` 时按今天的形状回 `{ kind, executable: '<根>\\bin\\vonvon-server.cmd', entry: '<根>\\current.txt', port }`。桌面端见到 `ours` 就不起 bundled daemon（`daemon-manager.ts:88` 的现有逻辑），U2 再加"由独立安装的服务端管理"的文案。

### 4.6 `__win-supervise` 占位

`D/cli/commands/win-supervise.ts`（I4b 重写）：`program.command('__win-supervise', { hidden: true }).option('--port <n>')` → 直接 `await runDaemon({ port })`（和 `daemon run` 同一个入口），进程退出码照 daemon 的。I4a 合入后在 Windows 上：任务起 `.cmd` → `node.exe … __win-supervise --port N` → daemon 在跑；daemon 退 75 → `.cmd` 退 75 → 任务计划程序认为任务结束（非 0 算失败，`RestartOnFailure` 1 分钟后再起一次、最多 3 次）。够验收 I4a；真正的 0/75/其他处理在 I4b。

### 4.7 CLI 的 `--json` 和 reason

`service install --json` 在 win32 的失败 reason 固定值（I2b 的 `.ps1` 依赖）：`sid_unavailable`、`task_foreign`、`task_other_root`、`schtasks_denied`（带 `fallback: 'detached'`）、`schtasks_create_failed`、`schtasks_run_failed`；`uninstall` 的 `not_registered`、`schtasks_delete_failed`。`service status --json` 加 `task: { name, status: 'Running' | 'Ready' | 'Disabled' | string }`。

### 4.8 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.2 启动器缺版本时退回 `standalone.json` 里记的上一版 | 退回 `current.txt` 第 2 行（C5） | 那个文件在缺失的目录里 |
| §7.4 `vonvon open` 在 win32 用 `start` | `rundll32 url.dll,FileProtocolHandler <url>`，URL 先过白名单正则 | `start` 要经 `cmd.exe`，URL 里的 `&`、`%`、`^` 会被 cmd 解释；rundll32 直接拿参数，不经 shell |
| 定义靠字节相等认"我们写的"（darwin/linux 的做法） | win32 解析五个固定元素比较 | `schtasks /Query /XML` 返回的是重新序列化的 XML，字节一定不同 |
| §7.4 没说 bundled 在 Windows 的服务 | `renderDefinition` 在 win32 只接受 `standalone` | Windows 桌面端不注册服务（owner 2026-10-31） |
| §7.4 任务名的哈希规则"和 `identity.ts:36-41` 一致" | 默认数据目录也带 root 哈希 | 任务是全机命名空间，两个用户都用默认目录时只有 SID 哈希不够区分同一用户的第二个数据目录；统一带两个哈希比"默认不带"少一条分支 |
| 监督进程崩溃的兜底没写 | 任务 `RestartOnFailure PT1M ×3` | daemon 崩由监督进程管，监督进程崩由任务计划程序管 |

## 5. 测试

全部在 Linux 上跑：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/service-windows*.test.ts packages/daemon/test/windows-launchers.test.ts`。`run` 是注入的假运行器：按 `(command, args)` 匹配一张脚本表，返回 `{ ok, status, stdout, stderr }` 并记录调用顺序；fs 用 `mkdtemp` 真目录（路径用 `path.win32` 拼的字符串只出现在 XML 和断言里，不真写 `C:\`）。不调用真 `schtasks`、`whoami`、`rundll32`、`taskkill`。

| 文件 | 输入 → 期望 | main 必败 |
|---|---|---|
| `service-identity-windows.test.ts` | `windowsTaskName('S-1-5-21-1-2-3-1001', 'C:\\Users\\U\\.vonvon-bot\\')` 和不带尾 `\`、大小写不同的同一路径 → 同一个名字，匹配 `^\\VonvonBot\\[0-9a-f]{12}-[0-9a-f]{12}$`；不同 SID → 不同；`whoami` 输出 `"host\\u","S-1-5-21-…"` → 取到 SID；输出乱 → `SidUnavailable` | 是 |
| `service-definitions-windows.test.ts` | `renderDefinition` win32 + standalone → 字节以 `FF FE` 开头、解码后含 `<RunLevel>LeastPrivilege`、`<LogonType>InteractiveToken`、`<Hidden>true`、`<ExecutionTimeLimit>PT0S`、`<MultipleInstancesPolicy>IgnoreNew`、`<Command>` 是 `<根>\bin\vonvon-server.cmd`、`<Arguments>` 是 `__win-supervise --port 7788`、Description 的 JSON 四项；root 含 `&` 和 `"` → XML 转义正确且 decode 还原；bundled → `InvalidDefinitionInput`；decode 对"重新序列化"的 XML（空白、属性顺序、大小写不同的 Command）→ `ours`；Description 缺前缀 / Command 指别处 / RunLevel Highest → `unrecognized` 且 reason 指出哪项；1 MiB + 1 → `unrecognized` | 是 |
| `service-windows-transaction.test.ts` install | 假 `run` 表：`/Query /FO CSV` exit 1 → `/Create … /XML <file> /F` 被调且文件内容和 render 相同、文件在 mkdtemp 目录且事后已删 → `/Run` → `readLock` 序列第 3 次给新 owner → `installed`，调用顺序恰好 `whoami`、`/Query /FO CSV`、`/Create`、`/Run`；`/Create` 不含 `/SC`、`/RL`、`/RU` | 是 |
| 同上 | 已有任务（`/Query /FO CSV` exit 0、`/XML` 回 ours 的 XML）→ 仍 `/Create /F`；回 foreign XML → `conflict task_foreign`，**没有** `/Create`；`/Create` stderr `Access is denied` → `refused schtasks_denied fallback detached`；stderr 其他 → `failed schtasks_create_failed` 且 message 含 stderr；`/Run` exit 1 → `failed schtasks_run_failed`，message 含 `daemon start`；30 秒（假时钟）没 owner → `installed` 带 warning | 是 |
| 同上 | 交接：pid 锁活着 → `stopHost` 被调、等退出；15 秒不退 → `taskkill /T /F /PID <pid>` 被调；`keepRunning` → 不调 `stopHost`，结果有"下次登录" | 是 |
| 同上 uninstall | absent → `not-installed`、`reason not_registered`、没有 `/Delete`；ours + daemon 在跑 + `supervisor.pid` 2 秒后消失 → 顺序 `stopHost`、`/Delete /F`；10 秒不消失 → `/End` 再 `taskkill`，再 `/Delete`；foreign → `conflict`，无 `/Delete`；`/Delete` exit 1 非"不存在" → `failed schtasks_delete_failed` | 是 |
| 同上 status | ours + CSV `Status` 列 `Running` + pid 锁活 → `running`；`Ready` + 锁死 → `installed-not-running` 文字含 `daemon start`；`Disabled` → `disabled`；absent + 锁活 → `not-installed` 文字含"daemon start 起的" | 是 |
| 同上 start | `/Run` → owner 出现 → endpoint；`/Run` exit 1 → 抛含"禁用" | 是 |
| `run` 超时 | 假 `run` 15 秒不回（假时钟）→ 当失败，message 含 `schtasks` 和"超时" | 是 |
| `windows-launchers.test.ts` | 两个文件：第 2 行标记不同、其余相同；含 `%*`、`exit /b %ERRORLEVEL%`、`DisableDelayedExpansion`、每个路径都带引号；`.cmd.tmp` 写后不残留；`parseCurrentTxt('1.0.1\n1.0.0\n')` → `{ version: '1.0.1', previous: '1.0.0' }`，`'1.0.0\n\n'` → `previous: undefined`，`''` → null，`'x\n'` → null | 是 |
| `cli-open.test.ts`（扩） | `platform: 'win32'`：`launch` 被调 `('rundll32.exe', ['url.dll,FileProtocolHandler', url])`；url 含 `&` 或空格 → 抛"不合法"、不调 launch；darwin/linux 不变 | 是 |
| `snapshot.test.ts`（扩） | win32 → `platform: 'windows'`；protocol 枚举接受 | 是 |
| `daemon-dependencies.test.ts`（desktop，扩） | win32 + 假 `run` 回 ours XML → `{ kind: 'ours', executable 以 \\bin\\vonvon-server.cmd 结尾, entry 以 \\current.txt 结尾, port }`；absent → absent | 是 |
| `service-action.test.ts`（扩） | win32 不再拒绝，spawn 带 `windowsHide: true`、`detached: true` | 是 |
| `cli-parity.test.ts` | `__win-supervise` 是隐藏命令，不进对齐 | 否 |

## 6. 自测和验收

JP-VPS：`flock /tmp/vonvon-heavy.lock npm run build`、daemon / desktop / protocol typecheck、lint、§5 全部绿。`.cmd` 的文本在 Linux 上用 `cat -A` 看一遍 CRLF（`.cmd` 文件写 CRLF，`cmd.exe` 对 LF 也行，但 `for /f` 读 `current.txt` 时 LF 文件更稳——`current.txt` 由 TS 写 LF，`for /f` 两种都读得了）。

**Windows 验收清单**（Claude 写进任务，owner 转给 Windows Codex；I4a 单独发，或和 I4b、I2b 一起）。前提：一个标准用户 `U1`，一个管理员用户 `U2`，Windows 10/11 x64，PowerShell 5.1，任务计划程序服务在跑。用 I1 的 `win-x64` 包手工解到 `%LOCALAPPDATA%\VonvonBot\server\releases\<v>\`，手工写 `current.txt`（`<v>` + 空行），跑 `releases\<v>\node\node.exe releases\<v>\app\bin\vonvon.mjs __standalone-setup --install-root … --version <v> --json`（I2a 合入后；否则手工把 §4.4 的两个 `.cmd` 放到 `bin\`）。每条记：命令、退出码、关键输出（打码：用户名、机器名、SID 的后半段）。

1. `bin\vonvon.cmd --version` → 版本对；`bin\vonvon.cmd open --print --json` → `ok: true`。
2. `bin\vonvon.cmd service install --json` → `ok: true`；`schtasks /Query /TN "\VonvonBot\<名>" /V /FO LIST` → `Run As User` 是 `U1`、`Logon Mode` 是 `Interactive only`、`Task To Run` 是 `…\bin\vonvon-server.cmd __win-supervise --port <N>`；`Status` 是 `Running`；任务管理器里 `node.exe` 没有控制台窗口；`bin\vonvon.cmd status --json` 连得上。
3. 再跑 `service install --json` → `ok: true`（覆盖，`/F`）。
4. **注销 `U1`，再登录** → 30 秒内 `bin\vonvon.cmd status --json` 连得上，pid 变了。
5. 锁屏 5 分钟 → 仍在跑。
6. `U2` 登录（快速切换，`U1` 不注销）→ 用 `U2` 自己的 `%LOCALAPPDATA%` 再做一遍 1–2 → 任务名不同（哈希不同）、两个 daemon 都在跑、端口不同。
7. `U1`：在任务计划程序里把任务名改一个字母建一个假任务指向 `notepad.exe`，然后把我们的任务删掉、把假任务改回我们的名字 → `service install --json` → `ok: false`、`reason: task_foreign`、假任务还在、notepad 没被改。恢复：删假任务，`service install`。
8. `current.txt` 第 1 行改成不存在的 `9.9.9`、第 2 行是 `<v>` → `bin\vonvon.cmd --version` 仍是 `<v>`；两行都不存在 → 退出码 70、stderr 含 `missing`；恢复。
9. `service status --json` → `running`；用任务管理器结束 `node.exe`（daemon）→ 1 分钟后（I4a 只有 `RestartOnFailure`，I4b 才是 5 秒）`status` 又是 `running`；`vonvon daemon stop` → `status` 是 `installed-not-running`，`Status` 列是 `Ready`，**不再被拉起**（退 0）；`vonvon daemon start --json` → 又在跑（走 `/Run`）。
10. 任务计划程序里"禁用"任务 → `service status --json` 的 `task.status` 是 `Disabled`；`daemon start` → 报"禁用"。启用后恢复。
11. `vonvon open` → 默认浏览器打开 UI；`bin\vonvon.cmd` 在带空格和中文的安装根下（把整个安装根拷到 `%LOCALAPPDATA%\Vonvon 测试 (1)\server`，重新 `__standalone-setup` 并 `service install`）1、2、11 仍过。
12. `service uninstall --json` → `ok: true`；任务没了；daemon 停了；`node.exe` 不在；再跑一次 → `ok: true`、`reason: not_registered`。
13. 组策略 `Prohibit users from creating tasks`（`U2` 用 gpedit 设在 `U1` 上）→ `U1` 的 `service install --json` → `reason: schtasks_denied`、`fallback: detached`。恢复策略。
14. 桌面端（Windows 测试安装包，不碰 owner 的）在 `U1` 装了 standalone 服务的机器上启动 → 它**不**另起 bundled daemon，连上 standalone 的；退出桌面端 → standalone 还在跑。
15. 把测试日志、`schtasks /Query /V /FO LIST` 的输出（打码）贴回任务。

## 7. 文档

- `docs/product.md` 3.10：Windows 一段：计划任务、登录后运行、锁屏不影响、重启后要登录一次、每个用户各一份、管理员账号也行、`vonvon open` 开浏览器；"不用登录也能跑的 Windows 服务"进第 10 节"v1 之后"。
- `docs/architecture.md`：Windows 服务那一段换掉"`.cmd` 循环"的旧描述，指向本文 §4.2–4.4 和 I4b。
- `docs/plans/devices.md` §7.4 加一行指到本文 §4.8。

## 8. 验收要点

- `schtasks /Create` 只有 `/TN /XML /F` 一种写法；`/F` 只在现有任务是 `ours`（或不存在）时用；foreign 任务不覆盖、不删除。
- XML 的 Principal/Trigger/Settings 字段和 §4.2 一致；`Command` 指启动器不指版本目录；bundled 拒。
- decode 不比字节、按五个元素判；`/Query /FO CSV` 判存在、`/XML` 取内容，不靠英文错误文本判"不存在"。
- install / uninstall 的顺序、每一步失败的 reason、超时值（`run` 15 秒、owner 30 秒、交接 15 秒、停监督 10 秒）和 §4.3 一致且都有测试。
- 启动器：两行 `current.txt` 解析、退回第 2 行、退出码透传、全部路径带引号；TS 的 `parseCurrentTxt` 和 `.cmd` 的规则一致（空第 2 行 = 没有 previous）。
- `open` 用 rundll32 且 URL 过白名单；`snapshot` 回 `windows`；桌面端 `readRegistration` 在 win32 认任务。
- 测试全部用注入的 `run`，不碰本机任何服务管理器；`HOME`/`VONVON_HOME` 只在命令前。
- Windows 验收清单 15 条写进任务，结果（打码）贴回。
- diff 里没有真实 id、密钥、本机路径、SID。

## 9. 风险和行数

- `schtasks` 的输出和错误文本随系统语言变：存在性用退出码判，`Status` 列只显示不判逻辑；仍有一处依赖文本——`Access is denied` 的识别（同时匹配英文、中文和 HRESULT `0x80070005`），认不出就落到 `schtasks_create_failed`，不会误判成成功。
- 任务计划程序对 `LogonTrigger` + `InteractiveToken` 的任务在"快速用户切换"下的行为（`U1` 的任务在 `U2` 前台时是否继续跑）要靠第 6 条验收确认；不行的话 `product.md` 要写"只有当前前台用户的 Bot 在线"。
- `RestartOnFailure` 在 daemon 退 75（`.cmd` 透传）时会把升级重启当成失败并延迟 1 分钟——这只在 I4a 占位期间发生，I4b 的监督进程接住 75 后任务不会结束。
- 行数估计 ~1,150（`windows.ts` 320、`identity.ts` 40、`definitions.ts` 120、`registration.ts` 30、`startup.ts`/`adapter.ts`/`service-action.ts` 40、`windows-launchers.ts` 70、`open.ts` 20、`snapshot`/protocol 10、desktop 30、占位 15、测试 ~450）。不拆。

## 10. Windows 验收任务（发给 Windows Codex）

这一节就是任务正文。Claude 贴出时补上任务号、分支、准确 sha 和结果贴到哪里；和 I4b、I2b 一起发时，I4b §6 的清单接在后面，前提和规矩共用。上面 §6 的 15 条按实现改过的版本就是下面的清单，以这里为准。

**第 0 步。** 按派发这份任务的地方（队列 issue 或 PR）的规矩查开始、结果和取消标记：已经有本任务号的结果就不重做；有取消就停。开始前、每次改动测试机器上的计划任务或组策略前，各看一次取消。

**要测的东西。** 在 Windows 测试机上建一个临时目录，`git fetch` 后 detach 到任务给的 sha，`npm ci`、`npm run build`，再 `node scripts/build-server.mjs --out <仓库外的临时目录> --targets win-x64 --allow-dirty` 打出 `vonvon-server-<v>-win-x64.zip`（I1）。只测，不改代码，不 push；发现问题写进结果，由 Claude 修。

**前提。**
- Windows 10 或 11 x64，PowerShell 5.1，任务计划程序服务在跑。
- 两个本地测试账号：标准用户 `U1`、管理员 `U2`。名字自己起，结果里只写 U1、U2。不用 owner 的日常账号，不碰 owner 的 `.vonvon-bot`、装好的 Vonvon Bot 桌面端和它的数据。
- 每个账号各装一份，都在这个账号自己的会话里做：
  1. 把 zip 解到 `$env:LOCALAPPDATA\VonvonBot\server\releases\<v>\`。
  2. 写 `current.txt`：第 1 行是 `<v>`，第 2 行空。用 `Set-Content -Encoding ascii`。
  3. 写启动器。I2a 已经合入的话，用 `releases\<v>\node\node.exe releases\<v>\app\bin\vonvon.mjs __standalone-setup --install-root <根> --version <v> --json`。还没合入的话，在源码 checkout 里跑：
     ```powershell
     node --experimental-strip-types --input-type=module -e "await (await import('./packages/daemon/src/service/windows-launchers.ts')).writeWindowsLaunchers(process.argv[1])" "$env:LOCALAPPDATA\VonvonBot\server"
     ```
- 下文的 `vonvon` 指 `& "$env:LOCALAPPDATA\VonvonBot\server\bin\vonvon.cmd"`。命令不用 PATH，每条记下退出码（`$LASTEXITCODE`）。
- 计划任务是隐藏的。要在任务计划程序里看到它，先打开"查看 → 显示隐藏的任务"，它在 `VonvonBot` 文件夹下。任务名取自 `vonvon service status --json` 的 `task.name`。

**隔离和不碰的东西。**
- 只在 U1、U2 里装和测。
- 计划任务只动两类：`\VonvonBot\` 下本任务装出来的，以及第 7 条自己建的假任务。结束时全部删掉。
- 第 13 条改的组策略，测完恢复，结果里写明已恢复。
- 不碰 owner 账号的计划任务、数据和桌面端。不碰飞书。

删除文件的硬规矩，原样照抄：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

在 Windows 上照同样的意思做：
- 临时目录只在 `$env:TEMP` 下用新的随机名字建，只按刚建的这个字面路径删。
- 不对 `$HOME`、`$env:USERPROFILE`、`$env:LOCALAPPDATA`，或任何可能为空的变量拼出来的路径用 `Remove-Item -Recurse`、`rd /s`、`del /s`。
- 测试账号的安装根用 `vonvon service uninstall` 卸。安装根本身只按 `C:\Users\<u>\AppData\Local\VonvonBot\server` 这样写全的字面路径删。

**打码。**
- 用户名、机器名写成 U1、U2、HOST；路径里的用户名写成 `C:\Users\<u>`。
- SID 只留最后一段（RID），写成 `S-1-5-21-…-1001`。任务名里的两段哈希可以照贴。
- 不贴 IP、凭据、带凭据的链接。

**清单。** 每条记四样：命令、退出码、关键输出（打码）、过、不过或没测。

1. `vonvon --version` → `<v>`。
   - `vonvon daemon start --json` → 起来了；桌面上没有黑色控制台窗口。
   - `vonvon open --print --json` → 退出码 0。
2. `vonvon service install --json`：
   - 输出 `ok: true`、`result: installed`，没有 `warning`。第 1 条起的 detached daemon 被交接，pid 变了。
   - `schtasks /Query /TN "<task.name>" /V /FO LIST`：`Run As User` 是 U1；`Logon Mode` 是 `Interactive only`；`Task To Run` 是 `…\bin\vonvon-server.cmd __win-supervise --port <N> --home "C:\Users\<u>\.vonvon-bot"`；`Status` 是 `Running`。
   - `vonvon service status --json` → `state: running`，`task.status` 有值。`vonvon daemon status --json` 连得上。
   - `.vonvon-bot\supervisor.pid` 在，里面的 pid 是 `__win-supervise` 那个 `node.exe`。`.vonvon-bot\service.log` 有 daemon 的输出。
   - **控制台窗口：** 桌面上和任务栏里有没有一直开着的 `cmd` 或 `node` 窗口，原样写。计划把 `Hidden` 只当作"在任务计划程序里隐藏"，没有保证不弹窗，这一条决定要不要换启动方式。
3. 再跑一次 `vonvon service install --json` → `ok: true`。任务被 `/F` 覆盖，daemon 重启一次后又在跑，pid 变了。
4. **注销 U1，再登录** → 30 秒内 `vonvon service status --json` 是 `running`，pid 变了。登录后有没有弹窗，原样写。
5. 锁屏 5 分钟，解锁 → 仍是同一个 pid。
6. U1 不注销，快速切换到 U2，在 U2 里装好，再做一遍第 1、2 条：
   - 两个任务名不同；
   - 两个 daemon 都在跑，端口不同；
   - 切回 U1 后，U1 的 daemon 还是原来的 pid。U2 在前台时 U1 的 daemon 有没有停过，看 U1 的 `service.log` 和 pid，原样写。
7. 在 U1 里测别人的任务：
   - 先 `vonvon service uninstall --json`；再 `schtasks /Create /TN "<task.name>" /TR notepad.exe /SC ONCE /ST 23:59`，建一个同名的假任务。
   - `vonvon service install --json` → `ok: false`、`reason: task_foreign`；`schtasks /Query /TN "<task.name>" /XML` 里仍是 `notepad.exe`。
   - `vonvon service uninstall --json` → `ok: false`、`reason: task_foreign`，假任务还在。
   - 恢复：`schtasks /Delete /TN "<task.name>" /F`，再 `vonvon service install --json`。
8. 改 `current.txt`：
   - 第 1 行 `9.9.9`、第 2 行 `<v>` → `vonvon --version` 仍是 `<v>`。
   - 两行都是不存在的版本 → 退出码 70，stderr 含 `missing`。
   - 删掉 `current.txt` → 退出码 70，stderr 含 `current.txt is missing`。
   - 恢复原样。
9. 测重启规则：
   - `vonvon service status --json` → `running`。
   - 在任务管理器里结束 daemon 那个 `node.exe`（`daemon run` 的子进程，不是 `__win-supervise`）→ 约 1 分钟后又是 `running`。I4a 只有任务的 `RestartOnFailure`；5 秒重启是 I4b 的事。
   - `vonvon daemon stop --json` → `service status` 是 `stopped`，任务 `Status` 是 `Ready`，2 分钟内**不会**自己回来。
   - `vonvon daemon start --json` → 又在跑（走 `schtasks /Run`）。
10. 测禁用：
    - `vonvon daemon stop --json`，再 `schtasks /Change /TN "<task.name>" /DISABLE` → `service status --json` 是 `state: disabled`。
    - `vonvon daemon start --json` → 失败，错误里有"禁用"。
    - `schtasks /Change /TN "<task.name>" /ENABLE` → `daemon start` 成功。
11. 测打开浏览器和特殊路径：
    - `vonvon open` → 默认浏览器打开界面。
    - 把整个安装根拷到 `$env:LOCALAPPDATA\Vonvon 测试 (1)\server`，在那里重写启动器，用那里的 `bin\vonvon.cmd` 跑第 1、2 条和 `open`。
    - `service status --json` 要是 `running`，不能是 `conflict`。这条同时验管道下 `schtasks /Query /XML` 输出的编码：路径里的中文要能解出来。
    - 恢复：用原安装根的 `vonvon service install --json`，再删拷贝出来的安装根（照上面的删除规矩）。
12. `vonvon service uninstall --json` → `ok: true`、`result: uninstalled`；任务没了，U1 下没有 `node.exe`，`supervisor.pid` 不在。再跑一次 → `ok: true`、`result: not-installed`、`reason: not_registered`。
13. 测组策略拒绝：
    - 在 U2 里用 gpedit 打开"计算机配置 → 管理模板 → Windows 组件 → 任务计划程序 → 禁止创建任务"，`gpupdate /force`。
    - U1 跑 `vonvon service install --json` → `ok: false`、`reason: schtasks_denied`、`fallback: detached`。如果 reason 是 `schtasks_create_failed`，把 `detail` 里 schtasks 的原文照贴，Claude 按它补识别规则。
    - 恢复策略，`gpupdate /force`，再 `service install`。
14. 测桌面端共存：用 Windows 测试安装包（不是 owner 装的那个），在已经装了服务的 U1 里启动桌面端：
    - 它不另起 daemon，`vonvon daemon status --json` 的 pid 不变；
    - 退出桌面端以后，服务端的 daemon 还在跑。
    - 没有测试安装包就写"没测"。
15. 测管理员账号：在 U2 里，任务的 `RunLevel` 是 `LeastPrivilege`（`schtasks /Query /XML`）；装的时候没有 UAC 提示；任务管理器"详细信息"里 daemon 的"已提升"一列是"否"。
16. 收尾：两个账号都 `vonvon service uninstall --json`，确认 `\VonvonBot\` 下没有这次留下的任务。把各条的日志和 `schtasks /Query /V /FO LIST` 的输出（打码）贴进结果。

**结果。**
- 第 1 行是任务的结果标记，第 2 行一句结论；卡住了，第 2 行写"卡住了："加原因。
- 下面按 1 到 16 逐条写：过、不过或没测；不过的贴原文。
- 第 2、4 条的弹窗、第 6 条的快速切换、第 13 条的 schtasks 原文，不管过没过都写。

## 和计划不一样的地方

1. 任务的 `Arguments` 是 `__win-supervise --port N --home "<数据目录>"`，不只是 `--port N`。登录时任务拿到的环境里不一定有 `VONVON_HOME`，非默认数据目录的任务会起到错的目录上。decode 把 `--home` 一起核对；I4b 交接时起新监督进程也要带上它（它的 §4.3 b 现在只写了 `--port`）。
2. `__win-supervise` 占位不在本进程里 `runDaemon`，改成起一个子进程 `node <entry> daemon run --port N`：
   - `VONVON_SERVICE=windows` 和 `VONVON_HOME` 要在 daemon 加载前就设好；
   - stdout 和 stderr 进 `service.log`、`service.err.log`，因为任务没有终端；
   - 写 `supervisor.pid`，`{ pid, startedAt, version }`，`.tmp` 加 `rename`，退出时只删自己写的那份。卸载和交接按它等监督进程退出，格式和 I4b 一样。
   - 子进程的退出码原样返回，被信号杀掉时算 1。
3. 结果的 `kind` 沿用现有的事务结果（`installed`、`install_refused`、`install_incomplete`、`uninstall_refused`、`uninstall_incomplete`、`not-installed`……），Windows 的固定原因放在 `reason`，`--json` 照样输出 `reason`、`fallback`、`warning`。
   - 退出类别：`schtasks_denied` 算 `refused`，`task_foreign` 和 `task_other_root` 算 `conflict`，其余算 `failed`。
   - 比 §4.7 多两个原因：`schtasks_query_failed`（`/Query` 失败但不是"任务不存在"，不当作没装）；`handover_failed`（detached 的 daemon 不回停止请求，或 `taskkill` 后还在）。
   - `/Run` 失败是 `install_incomplete` 加 `schtasks_run_failed`：任务已经注册了，不算失败回滚。
4. 状态没有 `installed-not-running`，协议的 `ServiceState` 里没有这个值。已注册、没在跑是 `stopped`，文字里有 `daemon start`。"禁用"按 XML 里 `Settings` 的 `Enabled` 判，`Status` 列只显示，不参与判断，因为它随系统语言变。
5. `/Run` 5 秒后还没有新 owner，再 `/Run` 一次：上一个实例还没退时，`IgnoreNew` 会把第一次吞掉。交接除了等 pid 锁，也等 `supervisor.pid` 那个进程退出。
6. 卸载：
   - 等 daemon 的锁和 `supervisor.pid` 都消失。
   - `/Delete` 失败时再查一次任务在不在，不在就算卸载成功。
   - 删完任务 daemon 还活着，结果是 `uninstall_incomplete`，并写出 pid。
   - 10 秒没停时，只有回过停止请求的 daemon 才按 pid `taskkill`。不回的可能是陈旧锁上被复用的 pid，只 `/End`，由任务计划程序收它自己的进程，不按 pid 杀。这和交接"不回停止的不按 pid 杀"一致。
7. `vonvon service install --keep-running` 一路传到适配器：有 daemon 在跑时只注册任务、不交接，结果文字说"下次登录才由任务接管"。
8. decode 比计划宽的地方：
   - `RunLevel` 缺省算 `LeastPrivilege`；
   - `Command` 带引号、大小写不同都认；
   - `Principal` 的 `UserId` 只在是 SID 时比较，任务计划程序可能回写成账号名。
   - Description 里的 JSON 把非 ASCII 转成 `\uXXXX`，Description 整行都是 ASCII。
   - 读回的字节按 BOM、UTF-16LE、UTF-8、GB18030 依次试着解。
9. 渲染前校验路径：拒绝 `"`、`%`、结尾的 `\` 和相对路径，因为这些字符在 `cmd.exe` 里会被解释。所以 definitions 测试改测 `&`、`<`、`>` 的 XML 转义，不测 `"`。
10. 启动器：
    - `parseCurrentTxt` 放在 `windows-launchers.ts`，I3 直接 import。
    - 第 2 行不是版本号算没有上一版。
    - 启动器多一道检查：`current.txt` 不在时退 70，报 `current.txt is missing`。
11. `renderWindowsLaunchers()` 不收安装根，路径都相对 `%~dp0`。I2a 的 `__standalone-setup` 调 `writeWindowsLaunchers(installRoot)`：每个文件先写 `.cmd.tmp`，再改名。
12. 读不到 SID（`whoami` 失败）时：
    - `daemon start` 和桌面端的 `readRegistration` 当作没注册：daemon start 走 detached，桌面端照旧起自己的；
    - `service install` 和 `uninstall` 报 `sid_unavailable`。
    - SID 只缓存成功的结果。
13. `controlDesktopService`（桌面端的服务开关）在 win32 上不再拒绝。UI 的 `DEVICE_TITLE` 补上 `windows: '这台 Windows 电脑'`，否则 UI 的类型检查过不了。U2 的文案照旧由 U2 做。
14. 真正的运行器直接起 `%SystemRoot%\System32\<命令>.exe`，`windowsHide`，不经 PATH 和 shell。stdout 最多读 1 MiB。
15. 测试文件名和 §5 表里的不同：
    - `cli-open` 对应 `open-guide.test.ts`；
    - `snapshot` 对应 `server-snapshot.test.ts`；
    - `service-action` 对应 `machine-service-action.test.ts`。
    - 新增 `win-supervise-placeholder.test.ts`、`service-startup-routing.test.ts` 的 win32 用例，以及共用的 `service-windows-fixture.ts`。
    - `cli-parity` 没改，隐藏命令本来就不进对齐。
16. 风险，留给 Windows 验收：
    - 任务的 `Command` 是 `.cmd`，加上 `InteractiveToken`，登录时可能弹出一直开着的控制台窗口（§10 第 2、4 条）。`Hidden` 只在任务计划程序里隐藏任务。真弹窗的话，I4b 要把任务的动作换成不带控制台的启动方式（例如 `conhost.exe --headless`，或一个 GUI 子系统的小启动器），decode 的 `Command` 跟着改。
