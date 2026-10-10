# 管理自托管 Mac CI

Linux 检查保留 GitHub 托管。未来 Windows 检查继续使用托管 runner。macOS 工作流保留为自托管，不使用付费云端 Mac。

## 当前状态

用户要求暂不运行 macOS CI。两个仓库的 Actions 变量 `ENABLE_SELF_HOSTED_MACOS_CI` 均为 `false`，手动触发也不会运行 Mac。

审查发现日常开发账号会让 CI 代码接触本机用户数据，因此已删除旧 `clay-mac-mini` 的组织注册并卸载其 LaunchAgent。目前没有可接单的 Mac runner。旧安装文件仍在 `/Users/clay/.local/share/github-actions/modelzen-macos`，不能把其中的注册凭据复制到新账号。

跳过结果不能作为 macOS 已验证的证据。完整应用改动仍保留 Mac 验证待办，其他 macOS 版本和 Intel 的发布验证也需要对应机器的证据。

## 恢复前配置专用账户

只有用户要求恢复 Mac CI 后，才执行这些步骤。

1. 在 macOS 系统设置的用户与群组中创建短名称为 `github-ci` 的标准用户。该账户不能属于管理员组，也不配置 sudo、Developer ID、Sparkle 私钥、公证凭据或生产 SSH 授权。不复制日常账户的钥匙串和凭据。
2. 登录该用户的图形会话。AppKit 检查需要该会话，不使用 root 服务。安装工作流需要的 XcodeGen 和 xcbeautify，确认已核验的 Xcode 可用。当前机器为 macOS 26.7 ARM64、Xcode 27.0，Node 22 由工作流安装。
3. 在 GitHub 组织 Settings → Actions → Runners 中，使用当期官方 ARM64 下载地址、校验值和一次性注册令牌，在 `/Users/github-ci/.local/share/github-actions/modelzen-macos` 中安装。令牌只用于注册，不写入仓库或文档。
4. 选择 `private-ci` runner group，名称设为 `mac-mini-isolated`，自定义标签为 `modelzen-macos` 和 `modelzen-macos-isolated`，工作目录为 `_work`。每台机器只有一个 runner，一次执行一个 job。
5. 在 `github-ci` 用户的图形登录会话安装并启动 LaunchAgent。完成该用户下的连通和平台验证后，再将需要的仓库变量设为 `true`。这些验证当前尚未执行。

工作流只允许同仓库 PR 或有权限的维护者手动触发的 Mac job，排除 fork PR。手动执行前确认所选 ref 已受信任。Mac job 先检查账户名称和管理员组，再 checkout 或执行仓库代码。账户检查用于防止配置错误，不能替代专用账户和 runner 权限隔离。

`private-ci` 仅允许 `modelzen/notelet` 和 `modelzen/vonvon-bot` 两个私有仓库，禁止公开仓库。两个仓库共用执行槽。没有在腾讯云服务器安装 runner，没有修改 Linux 服务或网络端口。

## 管理服务

以下命令只在完成上述配置后的 `github-ci` 登录会话中运行，不使用 sudo。

```sh
cd /Users/github-ci/.local/share/github-actions/modelzen-macos
./svc.sh status
./svc.sh stop
./svc.sh start
```

LaunchAgent 在该账号登录后启动。手动睡眠、关机或退出该账号会使 runner 离线，新的 Mac job 排队等待。需要防止闲置睡眠时使用 `caffeinate -i` 包装服务，不修改全局电源设置。

日志位于专用用户的 `~/Library/Logs/actions.runner.modelzen.mac-mini-isolated/`，job 日志和平台信息在 GitHub Actions 中查看。runner 保持官方自动更新。重装前移除旧注册，再使用新的一次性注册令牌。

## 检查与计费

PR 改动触发一轮 Linux 检查，合入 main 后不重复执行。文档改动不启动 Mac。手动 `workflow_dispatch` 可补跑完整 Linux 检查；Mac 还需开启上述变量并满足来源与账户要求。

Linux 和 Windows 仍受组织托管额度和计费状态约束。迁移不退回已消耗的额度。自托管 Mac 不增加云端 Mac 计算费用。

没有新增 GitHub 构建产物上传。runner 的 `_work` 与日常开发 checkout 分开，后续 checkout 清理同一仓库的旧构建输出，不把 runner 目录用作开发目录。现有打包、签名、公证和发布兼容性要求仍执行。

官方说明见 [自托管 runner](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)、[组织级注册](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners) 和 [服务管理](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)。
