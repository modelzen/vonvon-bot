# 管理自托管 Mac CI

> 2026-10-14 起，vonvon-bot 的 CI 不再有 Windows 任务。下文提到托管 Windows 的地方是历史记录。

两个仓库当前 `main` 的 Linux 检查保留 GitHub 托管，macOS 检查使用本机自托管 runner。vonvon-bot 的 Windows 检查原先使用 GitHub 托管 `windows-2025`，2026-10-14 已移除。

## 当前状态

两个仓库的 Actions 变量 `ENABLE_SELF_HOSTED_MACOS_CI` 均已设为 `true`。Mac job 由本机 `ci-user` 标准账户下的 `mac-mini-isolated` 接单，安装目录为 `/Users/ci-user/.local/share/github-actions/modelzen-macos`。

该账户不是管理员，不配置发布凭据。本机已在 `/Users/clay` 设置 `user:ci-user deny list,search` ACL；[直接 runner 探针](https://github.com/modelzen/notelet/actions/runs/38071263850) 已确认日常用户目录不可访问，并能读取屏幕、创建 AppKit 窗口。快速用户切换回 `clay` 后，后台图形会话仍可执行这些检查。

旧 `clay-mac-mini` 注册和服务已移除。不能把旧安装目录中的注册凭据复制到新账号。当前验证平台为 macOS 26.7 ARM64、Xcode 27.0；其他 macOS 版本和 Intel 的发布验证仍需要对应机器的运行证据。跳过结果不能作为 macOS 已验证的证据。

2026-10-11 的完整 `main` 检查均已通过，包括 [Notelet 的 XCTest、Universal 构建与启动检查](https://github.com/modelzen/notelet/actions/runs/38071328950) 和 [vonvon-bot 的安装、构建、类型检查、测试与 lint](https://github.com/modelzen/vonvon-bot/actions/runs/38071332092)。两个运行也都通过了托管 Linux 检查。

vonvon-bot 原有的 [Native desktop validation](https://github.com/modelzen/vonvon-bot/actions/workflows/desktop.yml) 位于旧桌面分支的 `.github/workflows/desktop.yml`，包含托管 `windows-2025` 和 `macos-15` 两项。此次没有删除 Windows，也没有迁移这条旧分支工作流。当前 `main` 的新架构使用 `.github/workflows/ci.yml`，已补回托管 Windows 检查，与 Linux、专用 Mac 运行同一套 Node 检查。上面的历史成功结果早于 Windows 恢复，不包含 Windows 原生验证。

## 重装专用账户的 runner

现有服务已安装并通过图形会话验证。需要重装时执行以下步骤，注册期间先暂停两个仓库的 Mac job。

1. 在 macOS 系统设置的用户与群组中确认或创建短名称为 `ci-user` 的标准用户。该账户不能属于管理员组，也不配置 sudo、Developer ID、Sparkle 私钥、公证凭据或生产 SSH 授权。不复制日常账户的钥匙串和凭据。
2. 登录该用户的图形会话。AppKit 检查需要该会话，不使用 root 服务。安装工作流需要的 XcodeGen 和 xcbeautify，确认已核验的 Xcode 可用。当前机器为 macOS 26.7 ARM64、Xcode 27.0，Node 22 由工作流安装。
3. 在 GitHub 组织 Settings → Actions → Runners 中，使用当期官方 ARM64 下载地址、校验值和一次性注册令牌，在 `/Users/ci-user/.local/share/github-actions/modelzen-macos` 中安装。令牌只用于注册，不写入仓库或文档。
4. 选择 `private-ci` runner group，名称设为 `mac-mini-isolated`，自定义标签为 `modelzen-macos` 和 `modelzen-macos-isolated`，工作目录为 `_work`。每台机器只有一个 runner，一次执行一个 job。
5. 在 `ci-user` 用户的图形登录会话运行 `./svc.sh install`。启动前删除生成的 LaunchAgent 中的 `SessionCreate` 键，检查 plist 语法，再运行 `./svc.sh start`。保留官方 `runsvc.sh` 入口；本机使用 `caffeinate -i` 包装服务，并设置 `Nice=10`。
6. 从实际 runner job 检查账户、日常用户目录访问限制和 AppKit 窗口创建。通过后再将仓库变量设为 `true`，手动运行受信任的 `main` 验证完整工作流。

官方服务模板的 `SessionCreate=true` 会新建安全会话。本机实测该会话没有图形权限，导致 `NSScreen.screens` 为空。删除该键后，服务继承 `ci-user` 已登录的图形会话；再次安装服务时须重新检查。仅看到 runner 在线或注册成功，不能证明 AppKit 可用。

安装服务后、首次启动前，在 `ci-user` 的终端执行：

```sh
plist="$HOME/Library/LaunchAgents/actions.runner.modelzen.mac-mini-isolated.plist"
/usr/libexec/PlistBuddy -c 'Delete :SessionCreate' "$plist"
/usr/bin/plutil -lint "$plist"
```

如果服务已在运行，先等待当前 job 完成，再用下节命令停止和启动服务，使 plist 改动生效。

工作流只允许同仓库 PR 或有权限的维护者手动触发的 Mac job，排除 fork PR。手动执行前确认所选 ref 已受信任。Mac job 先检查账户名称和管理员组，再 checkout 或执行仓库代码。账户检查用于防止配置错误，不能替代专用账户和 runner 权限隔离。

`private-ci` 仅允许 `modelzen/notelet` 和 `modelzen/vonvon-bot` 两个私有仓库，禁止公开仓库。两个仓库共用执行槽。没有在腾讯云服务器安装 runner，没有修改 Linux 服务或网络端口。

## 管理服务

以下命令只在完成上述配置后的 `ci-user` 登录会话中运行，不使用 sudo。

```sh
cd /Users/ci-user/.local/share/github-actions/modelzen-macos
./svc.sh status
./svc.sh stop
./svc.sh start
```

重启机器后先登录 `ci-user` 一次，LaunchAgent 随登录启动。可以快速用户切换回 `clay`，保留 `ci-user` 在后台，不要注销。手动睡眠、关机或退出该账号会使 runner 离线，新的 Mac job 排队等待。服务已用 `caffeinate -i` 防止闲置睡眠，不修改全局电源设置。

日志位于专用用户的 `~/Library/Logs/actions.runner.modelzen.mac-mini-isolated/`，job 日志和平台信息在 GitHub Actions 中查看。runner 保持官方自动更新。重装前移除旧注册，再使用新的一次性注册令牌。

## 检查与计费

PR 改动先触发一轮 Linux 检查，完整改动随后运行托管 Windows 和自托管 Mac。Notelet 只运行 Linux 和 Mac。合入 main 后不重复执行，文档改动不启动 Windows 或 Mac。手动 `workflow_dispatch` 可补跑完整 Linux 检查；Mac 还需开启上述变量并满足来源与账户要求。

Linux 和 Windows 仍受组织托管额度和计费状态约束。迁移不退回已消耗的额度。自托管 Mac 不增加云端 Mac 计算费用。单价、分钟取整和触发示例见 [ci-costs.md](ci-costs.md)。

没有新增 GitHub 构建产物上传。runner 的 `_work` 与日常开发 checkout 分开，后续 checkout 清理同一仓库的旧构建输出，不把 runner 目录用作开发目录。现有打包、签名、公证和发布兼容性要求仍执行。

官方说明见 [自托管 runner](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)、[组织级注册](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) 和 [服务管理](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)。
