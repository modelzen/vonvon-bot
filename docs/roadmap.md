# Vonvon Bot 实施路线

这份文档按顺序列出把 Vonvon Bot 做成独立产品要合并的 PR。每个决定的理由见 [architecture.md](architecture.md)。

## PR 顺序

每个 PR 都是一个可以单独验证的改动。后面的 PR 从它依赖的 PR 分支切出，不用等依赖合并。依赖有新提交时，把依赖分支 merge 进来。依赖合并进 `main` 后，把 PR 的目标改成 `main`，再把 `main` merge 进来。整个过程不 rebase，不 force-push。

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| V1 | 建 monorepo 和 `packages/protocol`。从 `codex/device-handoff` 移植 zod 合同，加握手和机器维度。加托管 CI（V1 当时有 Linux 和 macOS 两个任务，均通过验收；之后按下文 CI 规则保留托管 Linux，macOS 改为自托管并按用户要求暂停） | 无 |
| V2 | 建 `packages/daemon`。用脚本从 bridge `446b2a4` 复制完整 `src/` 和 `test/`，暂留 `src/web` 以保持可运行基线；数据目录改成 `~/.vonvon-bot`。`vonvon daemon run` 能在前台跑起 Bot | V1 |
| V3 | daemon 的 API 服务。WebSocket、本机凭据、pid 锁、RPC 处理、快照请求和快照事件、无损的 `admin` 状态请求、目录浏览 RPC、`vonvon daemon start/stop/status`，以及 lane 要用的本机最小 `packages/client`；旧网页管理路由改成 RPC，只读预览和旧网页页面退役，私聊菜单去掉旧控制台按钮，然后删除 `src/web` | V2 |
| V4 | 补全 `packages/client`，新建 `packages/ui`。移植界面，`window.bridge` 换成注入的客户端，daemon 在本机提供网页 | V3 |
| V5 | `packages/desktop`。Electron 外壳拉起或连接 daemon，加载界面，托盘，开机自动运行，自动更新 | V4 |
| V6 | Claude Code provider。移植 Paseo 的实现和 `AgentSession` 到 `AgentBackend` 的适配器，删除 bridge 的 Claude 后端 | V3 |
| V7 | 其他 provider。通用 ACP 和 Copilot、OpenCode、Pi | V6 |
| V8 | 导入 bridge 数据并关停旧服务。macOS、Linux、Windows 三个平台，界面引导和 `vonvon import feishu-codex-bridge` | V4 |
| V9 | feishu-codex-bridge 仓库的收尾版本。引导用户安装 Vonvon Bot，发现已迁移标记时拒绝启动 | V8，以及 Mac 发布的安装包 |
| V10 | 账号和机器登记。`packages/cloud`、飞书和 Lark 登录、`vonvon login`、桌面端登录、机器列表和在线状态 | V4 |
| V11 | 远程访问。daemon 向云端的出站连接、转发、端到端加密、云端托管网页、桌面端连接其他机器 | V10 |

V6 和 V7 可以和 V4、V5 并行。V10 可以在 V8 之前开始。

## 谁来做

分工按仓库根目录的 `AGENTS.md`。Linux 上的 Claude Code 通常负责这三份文档，不写产品代码。2026-10-10 Claude Code CLI 认证返回 HTTP 401 后，用户明确授权 Codex 直接修订这次 V2 澄清并继续。Mac 上的 Codex 负责全部实现和检查，也负责打包、签名、公证。V9 需要的安装包下载地址来自 Mac 的发布。

V5 和 V8 里有 systemd 检查，Mac 上跑不了。Codex 在 Linux CI 或 Linux 虚拟机里跑这两条。

此后实现时发现计划要改架构、数据形状或 PR 顺序，Codex 在 PR 里写明，按 `AGENTS.md` 交给 Claude Code 更新。上述授权只适用于这次 V2 澄清。

用户已授权 V2 及后续版本在全部验证通过后继续合并，无需等待个人界面复核或手动点击合并。截图和视频仍须留存，单元测试、十路实时检查、性能检查、独立审查与准确 head 的 Shipping 判定仍是合并条件。不得 force-push、rebase 已推送分支，也不设置小时审计。

逐项的步骤和验证标准见 [plan.md](plan.md)。

## CI

Linux 保留 GitHub 托管的 Ubuntu；macOS 配置为组织共享的 Mac mini 自托管 runner。原有 Windows 原生检查继续托管，保留在旧桌面分支的工作流中；当前 main 的检查不包含 Windows。两个仓库的 `ENABLE_SELF_HOSTED_MACOS_CI` 均已开启，使用无发布凭据的专用标准账户 `github-ci`。重启后先登录该账户一次，再切回日常用户并保留后台图形会话。每台 Mac 只运行一个 runner，两个仓库排队共享。安装位置、权限和服务管理见 [self-hosted-ci.md](self-hosted-ci.md)。

目标为 `main` 的 PR 在 opened、synchronize、reopened 时自动检查，也可手动触发。取消合入 main 后重复跑相同套件的 push 触发，不设置定时任务。同一 PR 的旧运行会被新运行取消。改目标或改基线后没有当前结果时，手动补跑。

范围脚本保留 `docs` 和 `full`，未知或异常差异按 `full` 处理。文档改动只跑范围回归和空白检查，不装依赖，也不启动 Mac。完整改动先在 Linux 跑 Node 22 的安装、构建、类型检查、测试和 lint，再在自托管 Mac 的准确 PR head 跑同一套检查。daemon 原先的 lint 与类型检查完全相同，删除重复的 lint 别名，协议 lint 保留。

合入要求当前 Linux 成功，完整改动还要求 Mac 成功。如果再次暂停 Mac CI，完整改动的 Mac 验证保持待办。计费、离线或超时阻塞不能记为通过。Mac CI 已覆盖的常规命令不再手动重复，里程碑要求的实时、性能、原生桌面、launchd、systemd 和独立审查照旧。完整规则见 [plan.md](plan.md) 的 *CI policy*。

## 现有 PR 栈怎么处理

新结构从 `main` 开始。PR #2 到 #19 先保持打开，作为移植界面时的参考。V4 合并、界面移植完成后，关闭这些 PR，不合并。

## 要验证的事

这些事现在只是推断，要在对应的 PR 里用实际运行证明。

- 飞书长连接模式下，同一个 Bot 的两个客户端只有一个收到事件。在 V8 里用两个进程连同一个测试 Bot 验证，结果决定导入时是否必须先暂停 bridge。
- `AgentSession` 到 `AgentBackend` 的适配器能完整映射文本流、工具调用、权限请求、中断和追加消息。在 V6 里用真实的 Claude Code 跑一遍飞书卡片的完整流程。
- bridge `446b2a4` 的已测基线为 153 个测试文件，其中 152 个通过、1 个有意跳过；1683 个用例通过、15 个有意跳过。搬进 `packages/daemon` 后，V2 要核对通过数和跳过数。跳过的 provider 实时测试不算作运行验收。V3 删除 `src/web` 后不再要求这个文件数，改为全部测试通过，并在 PR 里附上旧测试到 RPC 测试的映射表。

## 已知风险

- 远程访问信任云端分发的 daemon 公钥。云端被攻破时可能被中间人攻击。V11 可以加一个可选的指纹核对，在 daemon 本机界面和远程客户端上显示同一串指纹。
- 桌面端内置的 daemon 和 npm 全局安装的 daemon 版本可能不同。V5 要处理协议版本不兼容时的提示和重启。
- 云端的部署平台还没定。vonvon-bridge-legacy 有 `deploy/tencent` 可以参考。
- V3 起后端安装的输出只保留最后 256 KiB，`omittedBytes` 记下丢掉的字节数。从中途接上的客户端看不到更早的输出，失败原因仍由错误尾部给出。V3 不限制 npm 的运行时长。npm 卡住时，它会占着一个进程和对应的安装槽，直到 npm 退出或 daemon 停止。等界面需要取消安装时，再定超时和取消的语义。
