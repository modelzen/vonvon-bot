# 管理自托管 Mac CI

Linux 检查保留 GitHub 托管。Windows 检查继续使用 GitHub 托管 runner。只有 macOS 使用现有 Mac mini，不增加云端 Mac 计算费用。

## 机器和权限

- GitHub 组织为 `modelzen`，runner group 为 `private-ci`，只允许 `notelet` 和 `vonvon-bot` 两个私有仓库。
- Mac runner 名称为 `clay-mac-mini`，标签为 `self-hosted`、`macOS`、`ARM64`、`modelzen-macos`。
- 当前机器为 macOS 26.7 ARM64，Xcode 27.0，Homebrew 中已有 XcodeGen 和 xcbeautify。Node 22 由工作流安装到 runner 工具目录。
- 安装目录为 `/Users/clay/.local/share/github-actions/modelzen-macos`，工作区为其中的 `_work/`。它与开发 checkout 分开。
- 每台机器一个 runner，一次执行一个 job。两个仓库共用执行槽。服务优先级为 nice 10。
- 没有在腾讯云服务器安装 runner，没有修改 Linux 服务或网络端口。

## 当前暂停状态

用户要求暂不运行 macOS CI。两个仓库的 Actions 变量 `ENABLE_SELF_HOSTED_MACOS_CI` 已设为 `false`，Mac job 会跳过；runner 服务也已停止。手动触发完整 Linux 检查同样不会启动 Mac。跳过结果不能作为 macOS 已验证的证据。

只有用户要求恢复 Mac CI 后，才将对应仓库的 Actions 变量设为 `true`，并启动下述服务。恢复前的完整改动保留 Mac 验证待办，不将其记为通过。

## 启停服务

Mac 使用当前 `clay` 账号的 LaunchAgent，需要账号处于登录状态。已安装的服务在登录后自动启动；当前会话已手动停止，仓库变量仍会阻止 Mac job。

```sh
cd /Users/clay/.local/share/github-actions/modelzen-macos
./svc.sh status
./svc.sh stop
./svc.sh start
```

不使用 sudo。服务通过 `caffeinate -i` 防止闲置睡眠，不修改全局电源设置。停止服务后恢复原来的闲置睡眠行为。手动睡眠、关机或退出登录会使 runner 离线，新的 Mac job 等待机器恢复。

runner 日志在 `/Users/clay/Library/Logs/actions.runner.modelzen.clay-mac-mini/`；job 日志和系统版本在 GitHub Actions 中查看。runner 保持官方自动更新。重装前先在 GitHub 组织 Settings → Actions → Runners 删除或移除旧注册，再使用页面提供的当期下载地址和一次性注册令牌安装，不将令牌写进仓库。

## 检查与计费

PR 改动触发一轮检查，合入 main 后不重复执行。纯文档不启动 Mac。手动 `workflow_dispatch` 可补跑完整 Linux 检查；Mac 还需显式开启上述变量。

Mac job 使用自托管计算。Linux/Windows 仍受组织的托管额度和计费状态约束。已消耗的本月额度不会因迁移 Mac 而退回；若 Linux 仍提示付款或预算问题，需要组织管理员在 Billing 中恢复托管使用。

没有新增 GitHub 构建产物上传。常规日志和摘要保留在 Actions 中。本机 runner 会复用独立工作区，后续 checkout 清理同一仓库的旧构建输出；不要把 runner 目录用作日常开发目录。

一台 Mac 的成功结果只证明当前 macOS 与架构，不能写成 Intel 或其他 macOS 版本已经通过。现有打包、签名、公证和发布兼容性要求仍执行。

官方说明见 [自托管 runner](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)、[组织级注册](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) 和 [服务管理](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)。
