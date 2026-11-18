# 参与 Vonvon Bot 开发

文档修正、Bug 修复和功能建议都欢迎用中文提交。较大的功能或行为变化可以先开 Issue，说明你想解决的问题和使用场景，方便一起讨论方案。

## 报告问题

先搜索 [现有 Issue](https://github.com/modelzen/vonvon-bot/issues)，看看有没有相同的问题。提交 Bug 时，写明 Vonvon Bot 版本、系统、使用的模型工具、复现步骤和实际结果。截图或日志只需要贴与问题有关的部分，先删去密钥、飞书用户标识和私有资源链接。安全问题请通过 [安全政策](SECURITY.md) 里的私下渠道提交。

## 从源码构建

在 GitHub 上 fork 仓库，克隆你的 fork。用项目的 `dev` 分支作为改动起点。

```sh
git fetch https://github.com/modelzen/vonvon-bot.git dev
git switch -c my-change FETCH_HEAD
```

安装 Node.js 24，再从仓库根目录运行以下命令。也支持 Node.js 22.12 起的 22.x 和 Node.js 26 及以上版本。

```sh
npm ci
npm run build
```

构建完成后，运行 `node packages/daemon/bin/vonvon.mjs --help` 查看命令行入口。

| 目录 | 内容 |
| --- | --- |
| `packages/daemon` | 运行 Bot，接收飞书消息并调用 Codex 或 Claude Code。 |
| `packages/ui` | 管理 Bot、群和设备的界面。 |
| `packages/desktop` | macOS 和 Windows 桌面端。 |
| `packages/protocol`、`packages/client` | 服务端和客户端共用的协议与客户端库。 |

## 提交 PR

1. 运行与改动有关的检查。仓库根目录提供 `npm run typecheck`、`npm test` 和 `npm run lint`。例如只跑管理界面测试时可用 `npm test -w packages/ui`。
2. 把分支推到你的 fork，向本项目的 `dev` 分支提交 PR。写明改动解决了什么问题、怎么验证，以及尚未验证的平台或场景。
3. 引入或移植第三方代码时，在 PR 中注明来源与许可证。提交前确认你有权按项目的 [Apache-2.0 许可证](LICENSE) 提交改动。

CI 根据 PR 的改动选择检查平台。维护者会在准备合入时添加 `frozen`，触发相应的完整检查。讨论和评审遵守 [社区行为准则](CODE_OF_CONDUCT.md)。
