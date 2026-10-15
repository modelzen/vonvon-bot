# e06：LaunchAgent 里的 daemon 和钥匙串

`docs/v1-plan.md` 第 4 节的 e06，对应 product.md 第 9 节第 5 项。挡住 s07（`vonvon service install`）和 s17（崩溃记录）。基于 `main` 的 `f1c2fb8`。

## 要测什么

product.md 3.10 说：macOS 上用用户级 LaunchAgent 跑 daemon，"用户登录后启动，能用钥匙串里的 Claude 登录和 Codex 的登录（推断，要实测）"。服务用 app 里的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑。要回答：

1. LaunchAgent 起的进程（`gui/<uid>` 域）能不能用主人的 Claude 登录和 Codex 登录：用产品自己的检测（s03 的 Claude 登录检测、Codex 的 `account/read`），和终端里跑的结果比。钥匙串里有没有 Claude、Codex 的条目，只看有没有，不读内容。
2. 读钥匙串时会不会弹出"允许访问"的系统对话框。
3. `kill -9` 以后多久被拉起；正常退出（退出码 0 和非 0）时 `launchctl print` 的哪些字段记了退出码和信号，`KeepAlive` 和 `ThrottleInterval` 怎么影响拉起。
4. 系统设置"登录项与扩展"的"允许在后台"里，这个 LaunchAgent 显示成什么；在那里关掉以后，`launchctl print` 和 `launchctl list` 显示什么。
5. 怎么判断用户重新登录过（s17 的崩溃计数"下次登录或开机时重新计数"要用）。

## 怎么测

在 Mac 的检查会话里做，约 30 分钟。不打包：用 worktree 里 `npm ci` 装好的 Electron（`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`），以 `ELECTRON_RUN_AS_NODE=1` 跑探测脚本。打包版的签名不同，第 2、4 项的显示可能不一样，结果里写明。

- LaunchAgent 的 label 用 `com.vonvon.e06.probe`，plist 放 `~/Library/LaunchAgents/`，日志写临时目录，测完 `launchctl bootout` 并删掉 plist 和临时目录。
- 探测脚本放在仓库外，用 jiti 跑 `packages/daemon/src` 的源码：`createBackend('claude-agent').loginStatus({ refresh: true })` 和 `new CodexSetupService().setup()`，只打印状态、版本和不含凭据的说明。HOME 用主人真实的 HOME，因为凭据在那里；`VONVON_HOME` 用临时目录。
- 钥匙串只用 `security find-generic-password -s <服务名>`，不加 `-w`，输出丢掉，只记退出码。
- 不碰 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon` 和 bridge。

## 结果

2026-10-15 在 owner 的 Mac（macOS，uid 501）上由 Paseo 检查会话实测，北京时间 10:47 到 11:03。没打包：`npm ci` 后 worktree 里没有 Electron 二进制，单独跑 `node node_modules/electron/install.js` 补齐（原因没查，可能和 s04 记的一样，是 npm 11 跳过了 postinstall）。终端对照和 LaunchAgent 用同一个探测脚本、同一个 Electron。

### 1. 登录：LaunchAgent 下和终端一样，都是已登录

| | 终端 | LaunchAgent |
|---|---|---|
| HOME、USER | 真实值 | 真实值，launchd 给的 |
| PATH | 带 nvm、Homebrew 等目录 | 只有 `/usr/bin:/bin:/usr/sbin:/sbin` |
| Claude（s03 的检测） | 已登录，凭据来自 `ANTHROPIC_AUTH_TOKEN` | 同左 |
| Codex（`account/read`） | 已安装、已登录，`codex-cli 0.162.1`，用的是 nvm 下的 codex | 同左 |
| 钥匙串里服务名为 `Claude Code-credentials` 的条目 | 没有（退出码 44） | 同左 |
| 钥匙串里服务名为 `Codex Auth` 的条目 | 没有（退出码 44） | 同左 |

- Claude 的凭据来自 `ANTHROPIC_AUTH_TOKEN`。v1-plan 里 s03（#301 Claude 登录检测）留下的记录说，owner 把它写在 `~/.claude/settings.json` 的 `env` 里；这次没核对文件。Codex 的登录来源没查，只知道钥匙串里没有 `Codex Auth` 这个服务名。所以这次**没有验证到"读钥匙串"这条路**：LaunchAgent 下的结果和终端一样，说明 launchd 给的真实 HOME 够用，但说明不了钥匙串。
- 两边都只做了登录检测，没有发真实的模型请求，凭据本身是否还有效没验证。
- PATH 很短，codex 照样找到了 nvm 下的那个。按 s03 的说明，找 codex 时会查 nvm 等目录（推断，这次没看是哪条路找到的）。
- 截屏时没看到钥匙串访问的系统对话框（只在截屏那一刻看过）。钥匙串里本来就没有这两个条目，这一点也说明不了用钥匙串登录的人会不会弹窗。

### 2. `kill -9` 和退出码

这次的 plist 是 `KeepAlive=true`、不设 `ThrottleInterval`。`launchctl print gui/501/com.vonvon.e06.probe` 的字段：

| 事件 | 多久出现新进程 | print 里怎么记 |
|---|---|---|
| 首次加载 | — | `state = running`、`runs = 1`、`last exit code = (never exited)`、`minimum runtime = 10` |
| `kill -9` | 约 1 秒（每秒看一次） | `runs = 2`、`last terminating signal = Killed: 9` |
| 退出码 3 | 约 1 秒 | `last exit code = 3`、`runs = 3` |
| 3 秒后再退出码 3 | 约 7 秒 | `last exit code = 3`、`runs = 4` |
| 8 秒后退出码 0 | 约 9 秒 | `last exit code = 0`、`runs = 5` |

- 两次启动之间至少隔约 10 秒，和 `minimum runtime = 10`（默认节流）一致。日志里只看到 `service inactive: com.vonvon.e06.probe`，没有明确写"节流"的字样。
- `KeepAlive=true` 下退出码 0 也会被拉起。产品的 plist（`D/service/definitions.ts`）是 `KeepAlive = {SuccessfulExit: false}`、`ThrottleInterval = 5`。照字面意思，退出 0 不会被拉起、节流是 5 秒，但这次没用产品的 plist，**这两点都没测**，留给 s07 的 Mac 检查（"`daemon stop` 后不再拉起"）。

### 3. "允许在后台"

- 系统设置"通用 → 登录项与扩展 → App 后台活动"里显示为 **Electron**，说明是"项目来自身份不明的开发者"；"在访达中显示"指向 worktree 里的 Electron。打包签名后的 app 应该显示 app 名和开发者，这次没验证。
- 在那里只关掉这一项后：`launchctl print` 退出码 113（"Could not find service"），`launchctl list | grep e06` 为空。服务从 launchd 里消失了，表现和卸载一样，不是"已加载但停用"。
- 重新打开后，11:02:44 查时服务在跑，`runs` 重新从 1 计数；恢复用了多久没测。
- 不用 sudo 时，`sfltool dumpbtm` 两分钟没返回，只能放弃。产品里不要依赖它。

### 4. 怎么判断用户重新登录过（只查了资料，没实测）

- 首选：用 Security 框架的 `SessionGetInfo(callerSecuritySession, …)` 取当前安全会话 id，存下来，下次比较。Apple 的多用户文档说重新登录会得到不同的 id（[System Contexts](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/SystemContexts.html)、[Fast User Switching](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPMultipleUsers/Concepts/FastUserSwitching.html)）。区分重启还要再加开机标识，没验证。
- `launchctl print gui/<uid>` 里的 ASID 可以人工看，但手册说这个输出不是稳定接口。`who`、`last` 只能辅助。`$TMPDIR` 不保证每次登录都变，不能用。

### 5. 清理

`launchctl bootout` 返回 0（卸载是异步的，紧接着还短暂看到旧记录）；之后 `launchctl list` 里没有、`print` 返回 113、探测进程都已退出，plist、临时目录、Mac 上的 worktree 和本地分支都已删除。检查只用了自己的 label、plist 和临时目录；任务要求不碰 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon` 和 bridge，回复里没有逐项确认。

## 对后面切片的影响

- **s07**：LaunchAgent 下 Claude 和 Codex 的登录检测和终端一样，3.10 里"能用钥匙串里的 Claude 登录和 Codex 的登录"只验证了不走钥匙串的情况。钥匙串那一半等有人用钥匙串登录时再看。s03 留下的"读不到钥匙串时改成无法确认"仍然要做：s03 预计读不到时 CLI 会报没有凭据，检测就会显示未登录；这一点没测，s07 要在用钥匙串登录的账号上验证。`vonvon service status` 可以把"plist 在、但 `launchctl print` 找不到服务"显示成"已在系统设置里关掉后台运行"。不要用 `sfltool`。产品 plist 的 `SuccessfulExit=false` 和 5 秒节流要在 s07 的 Mac 检查里实测。
- **s17**：崩溃后约 1 秒被拉起，节流按启动间隔算；`last exit code` 和 `last terminating signal` 可以区分正常退出和被杀。"下次登录时重新计数"用安全会话 id，s17 开工时先在 Mac 上验证一次注销再登录。
- **s08**：桌面端的"登录时启动"开关和系统设置里的开关是两处，用户在系统设置里关掉时服务会被卸载，桌面端要把这个状态读出来。

## 核实记录

另一个代理（Sonnet）对照 Mac 检查会话的原始回复和 `definitions.ts`、`login.ts` 逐条核对了"结果"一节和 v1-plan 的改动。数字、字段名和时间（约 1、7、9 秒，`runs` 计数，退出码 113，`minimum runtime = 10`）都和回复一致，没有和回复矛盾的说法。有 9 处是把推断写成了事实或缺少依据，都已按核实意见改了措辞：Electron 二进制缺失的原因、凭据放在哪个文件、Codex 登录的来源、为什么短 PATH 也找到了 codex、关掉后台活动后的"卸载"、重新打开后多快恢复、没碰哪些东西、产品 plist 的行为、钥匙串读不到时检测会怎样。另补了两条限定：对话框只在截屏时看过；登录检测没有发真实模型请求。
