# Vonvon Bot

Vonvon Bot 把运行在你电脑上的 Codex、Claude Code 等编程助手接入飞书。你可以在飞书群里发起任务、查看进度和继续会话，在桌面端管理 Bot、群和工作目录。

## 安装

- Mac、Windows：从 https://vonvon.cc/get/ 下载桌面端安装包，里面带着服务端。
- Linux（glibc，x64 或 arm64）只装服务端，0.9.0 起可用：从 [官网下载页](https://vonvon.cc/get/) 复制完整安装命令。双源安装方式和发布状态边界见 [Linux 服务端安装](docs/server-install.md)。

  装到 `~/.local/share/vonvon-bot/server`，数据在 `~/.vonvon-bot`。卸载用 `sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/uninstall.sh)"`，数据目录留着。这条命令只给 Linux，在 Mac 上运行只提示去下载安装包。

## 从源码构建

需要 Node.js 22.12+（22.x）、24.x 或 26+。在仓库根目录运行：

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
```

仓库包含桌面端、管理界面、运行 Bot 的 daemon，以及协议和客户端库。构建后可用 `node packages/daemon/bin/vonvon.mjs --help` 查看命令行入口。

## 参与开发

功能建议和一般问题可以通过 GitHub Issues 提交。改动代码前请看 [贡献指南](CONTRIBUTING.md)。安全问题请通过 [私下报告渠道](SECURITY.md) 提交。

## 许可证

Vonvon Bot 自有代码使用 [Apache-2.0](LICENSE)。第三方代码及素材适用各自的许可，见 [NOTICE](NOTICE) 和 [daemon NOTICE](packages/daemon/NOTICE)。
