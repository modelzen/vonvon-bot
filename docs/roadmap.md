# Vonvon Bot 实施路线

这份文档按顺序列出把 Vonvon Bot 做成独立产品要合并的 PR。每个决定的理由见 [architecture.md](architecture.md)。

## PR 顺序

每个 PR 都是一个可以单独验证的改动。后面的 PR 从它依赖的 PR 分支切出，不用等依赖合并。依赖有新提交时，把依赖分支 merge 进来。依赖合并进 `main` 后，把 PR 的目标改成 `main`，再把 `main` merge 进来。整个过程不 rebase，不 force-push。

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| V1 | 建 monorepo 和 `packages/protocol`。从 `codex/device-handoff` 移植 zod 合同，加握手和机器维度。加 Linux 上的 CI | 无 |
| V2 | 建 `packages/daemon`。用脚本从 bridge `446b2a4` 复制内核源码和测试，数据目录改成 `~/.vonvon-bot`，不复制网页控制台。`vonvon daemon run` 能在前台跑起 Bot | V1 |
| V3 | daemon 的 API 服务。WebSocket、本机凭据、pid 锁、RPC 处理、快照事件、目录浏览 RPC、`vonvon daemon start/stop/status` | V2 |
| V4 | `packages/client` 和 `packages/ui`。移植界面，`window.bridge` 换成注入的客户端，daemon 在本机提供网页 | V3 |
| V5 | `packages/desktop`。Electron 外壳拉起或连接 daemon，加载界面，托盘，开机自动运行，自动更新 | V4 |
| V6 | Claude Code provider。移植 Paseo 的实现和 `AgentSession` 到 `AgentBackend` 的适配器，删除 bridge 的 Claude 后端 | V3 |
| V7 | 其他 provider。通用 ACP 和 Copilot、OpenCode、Pi | V6 |
| V8 | 导入 bridge 数据并关停旧服务。macOS、Linux、Windows 三个平台，界面引导和 `vonvon import feishu-codex-bridge` | V4 |
| V9 | feishu-codex-bridge 仓库的收尾版本。引导用户安装 Vonvon Bot，发现已迁移标记时拒绝启动 | V8，以及 Mac 发布的安装包 |
| V10 | 账号和机器登记。`packages/cloud`、飞书和 Lark 登录、`vonvon login`、桌面端登录、机器列表和在线状态 | V4 |
| V11 | 远程访问。daemon 向云端的出站连接、转发、端到端加密、云端托管网页、桌面端连接其他机器 | V10 |

V6 和 V7 可以和 V4、V5 并行。V10 可以在 V8 之前开始。

## 谁来做

分工按仓库根目录的 `AGENTS.md`。Linux 上的 Claude Code 负责这三份文档，不写产品代码。Mac 上的 Codex 负责全部实现和检查，也负责打包、签名、公证。V9 需要的安装包下载地址来自 Mac 的发布。

V5 和 V8 里有 systemd 检查，Mac 上跑不了。Codex 在 Linux CI 或 Linux 虚拟机里跑这两条。

实现时发现计划要改架构、数据形状或 PR 顺序，Codex 在 PR 里写明，由 Claude Code 更新这三份文档。

逐项的步骤和验证标准见 [plan.md](plan.md)。

## 现有 PR 栈怎么处理

新结构从 `main` 开始。PR #2 到 #19 先保持打开，作为移植界面时的参考。V4 合并、界面移植完成后，关闭这些 PR，不合并。

## 要验证的事

这些事现在只是推断，要在对应的 PR 里用实际运行证明。

- 飞书长连接模式下，同一个 Bot 的两个客户端只有一个收到事件。在 V8 里用两个进程连同一个测试 Bot 验证，结果决定导入时是否必须先暂停 bridge。
- `AgentSession` 到 `AgentBackend` 的适配器能完整映射文本流、工具调用、权限请求、中断和追加消息。在 V6 里用真实的 Claude Code 跑一遍飞书卡片的完整流程。
- bridge `446b2a4` 的 153 个测试文件（用 `git grep` 数出约 1487 个用例）搬进 `packages/daemon` 后，改了数据目录仍然全部通过。在 V2 里验证。

## 已知风险

- 远程访问信任云端分发的 daemon 公钥。云端被攻破时可能被中间人攻击。V11 可以加一个可选的指纹核对，在 daemon 本机界面和远程客户端上显示同一串指纹。
- 桌面端内置的 daemon 和 npm 全局安装的 daemon 版本可能不同。V5 要处理协议版本不兼容时的提示和重启。
- 云端的部署平台还没定。vonvon-bridge-legacy 有 `deploy/tencent` 可以参考。
