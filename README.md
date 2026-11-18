<p align="center">
  <img src="packages/desktop/assets/macos-icon.png" width="88" height="88" alt="Vonvon Bot 的猫咪图标">
</p>

<h1 align="center">Vonvon Bot</h1>

<p align="center">在飞书里交代任务，用自己设备上的 Codex 或 Claude Code 来做。</p>

<p align="center">
  <a href="https://vonvon.bot/get/">下载</a> ·
  <a href="https://vonvon.bot/docs/quickstart/">快速开始</a> ·
  <a href="https://vonvon.bot/docs/">使用文档</a> ·
  <a href="https://vonvon.bot/changelog/">更新日志</a>
</p>

Vonvon Bot 把飞书机器人连到你配置好的编程助手。比如在群里说「查一下这次构建失败的原因」，Bot 会在这个群配置的工作目录里查文件、跑命令，再把进度和结果发回飞书。群成员可以直接在飞书里使用，Bot 运行所在的设备需要开着并联网。

## 能做什么

- **在飞书里跟进任务。** 看运行进度、回答 Bot 的追问、停止任务，或接着之前的会话继续做。
- **按群分配工作。** 为不同的群选择工作目录、模型和执行权限。可以让 Bot 只读文件，也可以允许它修改工作区。
- **在另一台设备运行。** 可以把 Bot 部署在 Linux 服务器上，再从 Mac 或 Windows 桌面端连接和管理。

## 让第一位 Bot 进群

1. 在运行 Bot 的设备上安装 Vonvon Bot，并完成 Codex 或 Claude Code 的登录或 API 配置。
2. 打开 Vonvon Bot，按引导用飞书扫码注册机器人，开通所需权限并发布。已有机器人可按应用提示接入。
3. 将 Bot 加入一个飞书群，为群选好工作目录。第一次可以选只读权限，然后在群里 @ Bot，说「读一下这个项目的 README，告诉我怎么启动」。

| 平台 | 安装方式 |
| --- | --- |
| macOS | 下载桌面端，按 Apple 芯片或 Intel 选择安装包。 |
| Windows | 下载桌面端，按 x64 或 ARM64 选择安装包。 |
| Linux | 支持 glibc 2.28+ 的 x64 和 arm64。按下载页的命令安装服务端，用命令行或其他设备上的桌面端管理。 |

安装前可查看 [下载与系统要求](https://vonvon.bot/get/)。连接服务器见 [远程连接指南](https://vonvon.bot/docs/remote/)，旧 Bridge 用户可查看 [迁移指南](https://vonvon.bot/docs/bridge-import/)。

## 反馈和贡献

遇到安装、登录或连接问题，可以先查 [常见问题与排错](https://vonvon.bot/docs/troubleshooting/)。欢迎报告 Bug、提出功能建议，或帮忙改进中文文档。[新建 Issue](https://github.com/modelzen/vonvon-bot/issues/new/choose)

如果想从源码构建或提交代码，可以从 [贡献指南](CONTRIBUTING.md) 开始。参与讨论时请遵守 [社区行为准则](CODE_OF_CONDUCT.md)。发现安全漏洞时，请走 [私下报告渠道](SECURITY.md)。

## 许可证

Vonvon Bot 自有代码采用 [Apache-2.0](LICENSE)。第三方代码和素材适用各自的许可，见 [项目声明](NOTICE)、[daemon 声明](packages/daemon/NOTICE) 和 [UI 第三方声明](packages/ui/public/THIRD-PARTY-NOTICES.txt)。
