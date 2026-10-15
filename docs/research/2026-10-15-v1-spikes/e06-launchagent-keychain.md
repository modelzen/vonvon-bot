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

待 Mac 检查完成后填写。
