# 参与 Vonvon Bot

欢迎用中文参与。第一次贡献可以在已有 Issue 里补充自己遇到问题的复现步骤，在另一种系统上验证修复，或把一段难懂的使用说明改清楚。

小修复和文档改进可以直接提 PR（Pull Request，修改提案）。如果想做新功能或较大的行为改动，建议先在 Issue 里讲讲谁遇到了什么问题，和维护者确认范围后再动手。每个 PR 集中解决一件事，方便其他人试用和评审。

## 用 AI 一起开发

欢迎用 Vonvon Bot、Codex、Claude Code 或其他模型读代码、写实现、补测试和改文档。无论用了什么工具，提交者都需要读过最终改动，理解它为什么能解决问题，并在评审时回答问题、跟进修改。

提交代码前，亲自跑与改动相关的测试，或照用户的操作步骤试一遍。在 PR 里用自己的话写下改了什么、怎样验证、实际看到了什么。比如修了运行卡上的按钮，可以写「在 Windows 自定义运行卡后启动任务，点停止，任务已结束。macOS 尚未验证」。只列出自己确认过的结果。

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
