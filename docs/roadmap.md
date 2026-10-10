# Vonvon Bot 实施路线

这份文档按顺序列出把 Vonvon Bot 做成独立产品要合并的 PR。每个决定的理由见 [architecture.md](architecture.md)。

## PR 顺序

每个 PR 都是一个可以单独验证的改动。后面的 PR 从它依赖的 PR 分支切出，不用等依赖合并。依赖有新提交时，把依赖分支 merge 进来。依赖合并进 `main` 后，把 PR 的目标改成 `main`，再把 `main` merge 进来。整个过程不 rebase，不 force-push。

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| V1 | 建 monorepo 和 `packages/protocol`。从 `codex/device-handoff` 移植 zod 合同，加握手和机器维度。加托管 CI（V1 当时有 Linux 和 macOS 两个任务，均通过验收；之后按下文“托管 CI”自动运行只留 Linux 任务，常规 macOS 检查改在本地 Mac 上跑，另留一个只能手动请求的可选托管 macOS 任务） | 无 |
| V2 | 建 `packages/daemon`。用脚本从 bridge `446b2a4` 复制完整 `src/` 和 `test/`，暂留 `src/web` 以保持可运行基线；数据目录改成 `~/.vonvon-bot`。`vonvon daemon run` 能在前台跑起 Bot | V1 |
| V3 | daemon 的 API 服务。WebSocket、本机凭据、pid 锁、RPC 处理、快照请求和快照事件、无损的 `admin` 状态请求、目录浏览 RPC、`vonvon daemon start/stop/status` 和停止、重启的生命周期规则（等已接受的操作做完、确认 Bot、npm 和 Codex 进程都已退出才放锁，重启保持原端口，`vonvon service` 命令在 V5 之前一律拒绝），以及 lane 要用的本机最小 `packages/client`；旧网页管理路由改成 RPC，只读预览和旧网页页面退役，私聊菜单去掉旧控制台按钮，然后删除 `src/web` | V2 |
| V4 | 补全 `packages/client`，新建 `packages/ui`。移植界面，`window.bridge` 换成注入的客户端，daemon 在本机提供网页 | V3 |
| V5 | `packages/desktop`。Electron 外壳拉起或连接 daemon，加载界面，托盘，开机自动运行，自动更新。Vonvon 自己的系统服务（服务标识、安装和卸载、原生验收）也在这里第一次提供 | V4 |
| V6 | Claude Code provider。移植 Paseo 的实现和 `AgentSession` 到 `AgentBackend` 的适配器，删除 bridge 的 Claude 后端 | V3 |
| V7 | 其他 provider。通用 ACP 和 Copilot、OpenCode、Pi | V6 |
| V8 | 导入 bridge 数据并关停旧服务。macOS、Linux、Windows 三个平台，界面引导和 `vonvon import feishu-codex-bridge` | V4 |
| V9 | feishu-codex-bridge 仓库的收尾版本。引导用户安装 Vonvon Bot，发现已迁移标记时拒绝启动 | V8，以及 Mac 发布的安装包 |
| V10 | 账号和机器登记。`packages/cloud`、飞书和 Lark 登录、`vonvon login`、桌面端登录、机器列表和在线状态 | V4 |
| V11 | 远程访问。daemon 向云端的出站连接、转发、端到端加密、云端托管网页、桌面端连接其他机器 | V10 |

V6 和 V7 可以和 V4、V5 并行。V10 可以在 V8 之前开始。

## 谁来做

分工按仓库根目录的 `AGENTS.md`。Linux 上的 Claude Code 通常负责这三份文档，不写产品代码。2026-10-10 Claude Code CLI 认证返回 HTTP 401 后，用户明确授权 Codex 直接修订这次 V2 澄清并继续。Mac 上的 Codex 负责全部实现和检查，也负责打包、签名、公证。V9 需要的安装包下载地址来自 Mac 的发布。

V5 和 V8 里有 systemd 检查，Mac 上跑不了。Codex 在 Linux 虚拟机或有用户会话的 Linux 环境里跑这几条，托管 CI 不能顶替。V5 的原生服务检查要用专门的系统测试用户，不在用户自己的账号里跑。按目前的环境报告，Mac 上只有用户自己的账号有图形会话，也没有运行中的、带 systemd 用户会话的 Linux，所以 V5 开始前要请用户提供。

Codex 可以并行开发，本机同时最多一个根代理加三个工作代理。根代理是唯一的 Git 和 forge 写入者，负责建工作树、集成、提交、推送、开 PR、合并和 Shipping。工作代理各用根代理建的工作树，只改分给自己的文件，各自运行 npm ci，不提交、不推送。每个 PR 先由各工作代理写测试、做组件验证，根代理集成后跑一次完整检查，再做独立审查，冻结 head 后才跑十路实时、性能、原生检查和 Shipping。连着测试 Bot 的检查仍然逐个跑，用独立数据目录的检查可以同时跑。并行不改变 PR 顺序、依赖、架构、数据形状和验证门槛，合并仍按路线顺序。V10 在 V4 合并后就可以开始开发，但按路线顺序要等 V9 合并后才合并，不需要另问用户。merge `main` 之后，patch-id 不变只是审查结论继续有效的必要条件：基线、依赖版本或相关证据变了，就要重跑受影响的检查，并重新拿独立审查结论。具体分工见 [plan.md](plan.md) 的 *Parallel execution*。

此后实现时发现计划要改架构、数据形状或 PR 顺序，Codex 在 PR 里写明，按 `AGENTS.md` 交给 Claude Code 更新。上述授权只适用于这次 V2 澄清。

用户已授权 V2 及后续版本在全部验证通过后继续合并，无需等待个人界面复核或手动点击合并。截图和视频仍须留存，单元测试、十路实时检查、性能检查、独立审查与准确 head 的 Shipping 判定仍是合并条件。不得 force-push、rebase 已推送分支，也不设置小时审计。

逐项的步骤和验证标准见 [plan.md](plan.md)。

## 托管 CI

托管 CI 只有一个不带路径过滤的 workflow。自动运行只有一个 GitHub 托管的 Ubuntu 任务，不分配托管 macOS；另有一个可选的 `macos-latest` 任务，只在手动请求时运行（见下文）。目标为 `main` 的 PR 在 opened、synchronize、reopened 时和 push 到 `main` 时自动运行；功能分支的 push 不触发，也不设定时任务。同一个 PR 有新运行时取消旧的；`main` 和手动运行各用唯一的并发组，不会被取消。改目标到 `main` 不一定触发运行，改目标或 merge `main` 之后当前 head 没有运行时，手动触发 `workflow_dispatch`，它一律跑 Linux 全套，`run_macos` 保持默认的 `false`，除非这个 head 需要托管 macOS。

Linux 任务里一个不依赖 npm 包的脚本判定范围，只有 `docs` 和 `full` 两种。脚本在完整历史上用本地 Git 加 `--no-renames -z` 计算改动路径：PR 取事件里 base 和 head 的 merge-base 到 head，`main` 的 push 取 before 到 after。全部路径都是根目录的 `README.md`、`AGENTS.md`、`CLAUDE.md` 或 `docs/**/*.md` 时是 `docs`；其他路径，包括协议源码和测试，都是 `full`。手动触发，以及空的、异常的、有歧义的、取不到的或超出脚本上限的差异，都是 `full`，脚本不会截断列表后报 `docs`。`docs` 只跑轻量检查（脚本自身的回归测试和 `git diff --check`），不装依赖、不跑产品全套；`full` 用 Node 22 和 npm 缓存，依次跑干净的 `npm ci`、`npm run build`、`npm run typecheck`、`npm test`、`npm run lint`。任务摘要写明是轻量通过还是全套通过。没用 GitHub 原生路径过滤，是因为它只比较前 3000 个改动文件（[官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#git-diff-comparisons)），被过滤掉的 workflow 还会让必需检查挂起；这里用本地 Git 列路径，没有这个上限。

常规 macOS 检查在本地 Mac 上跑。凡是 `full` 的改动，代码和配置维护以及各里程碑，Codex 都在 Mac 上对准确的 PR head 从干净的工作树跑同一条链，把 head SHA、系统和 Node 版本、每条命令的结果和日志写进 PR。纯文档改动的本地全套记为不适用，不算通过。托管 macOS 不再自动跑，但保留为可选任务。`workflow_dispatch` 有一个布尔输入 `run_macos`，默认 `false`。只有手动运行且 `run_macos` 为 `true`、并且同一次运行的 Linux 任务（手动时一律全套）成功后，才分配 `macos-latest`；PR、push 到 `main`、手动但为 `false`、或 Linux 失败时，这个任务都跳过，不花 Mac 分钟。它用 Node 22 和 npm 缓存，限时 15 分钟，从干净检出跑同一条链 `npm ci`、build、typecheck、test、lint，不打包、不签名、不公证。只在需要时有意请求：发布准备、桌面打包相关工作、原生依赖变更，或要在干净的托管 macOS 环境里复现问题；请求人在 PR 里写明原因和运行链接。不按路径自动分配 Mac，不设定时任务，不加额外的路由任务。它只是补充，不替代本地 Mac 检查，也永远不算原生验收：Electron 窗口、launchd、十路实时、性能、打包、签名、公证仍在 Mac 上做。

合并前要求当前 head 的托管 Linux 成功，`full` 还要求本地 Mac 检查通过。PR 一旦请求过托管 macOS，合并的那个 head 也要有一次成功的托管 macOS；head 变了就要重新请求。没请求的 PR 记为“未请求”，不算通过也不算失败。因额度、拿不到 runner、超时等原因没跑成的托管 Linux 或已请求的托管 macOS 记为受阻，不合并；不能撤回请求、换到没请求的 head，或拿本地 Mac 顶替。本地 Mac 只替代原来自动运行的托管 macOS，不能替代托管 Linux，也不能替代已请求的托管 macOS。

2026-10-10 组织共用的 Actions 额度用完，用户授权暂时跳过托管 CI。授权有效期间，head 可以不跑托管 CI 就推送和合并，记录写“托管 Linux：已跳过（用户授权，额度用完）”，不算通过。其他门槛都不变：`full` 改动在准确 head 上的本地 Mac 检查、十路实时检查、生命周期验证、性能检查、截图和视频、独立审查和准确 head 的 Shipping 判定。不改分支保护，也不拿托管 macOS 顶替。用户撤回授权后，所有未合并的 head 重新按完整的合并规则检查。

这项改动是一个分支上的文档、workflow、范围脚本和条件用例维护，不是新的里程碑，不改 PR 顺序、架构和数据形状，不改订阅、计费、分支保护，也不配置 runner 服务。它本身是 `full`，合并前要有 actionlint、有意义的脚本用例、托管 macOS 条件的用例、本地 Mac 干净全套、独立审查和实际跑通的托管 Linux，不跑无关的 Bot 十路实时和性能检查。条件用例直接读 `ci.yml` 里的条件，覆盖 PR 和 push 到 `main` 时跳过、手动 `false` 时跳过、手动 `true` 且 Linux 成功时运行、手动 `true` 但 Linux 失败时跳过。这次改动不为了验证规则去请求托管 macOS，PR 里写明实际的托管 macOS 任务没有跑过，条件只靠用例和 actionlint 验证。各里程碑的十路实时检查、性能检查、原生桌面和 launchd、systemd 检查、独立审查和准确 head 的 Shipping 判定照旧。完整规则见 [plan.md](plan.md) 的 *Hosted CI policy*。

## 现有 PR 栈怎么处理

新结构从 `main` 开始。PR #2 到 #19 先保持打开，作为移植界面时的参考。V4 合并、界面移植完成后，关闭这些 PR，不合并。

## 要验证的事

这些事现在只是推断，要在对应的 PR 里用实际运行证明。

- 飞书长连接模式下，同一个 Bot 的两个客户端只有一个收到事件。在 V8 里用两个进程连同一个测试 Bot 验证，结果决定导入时是否必须先暂停 bridge。
- `AgentSession` 到 `AgentBackend` 的适配器能完整映射文本流、工具调用、权限请求、中断和追加消息。在 V6 里用真实的 Claude Code 跑一遍飞书卡片的完整流程。
- launchd 和 systemd 在 daemon 正常停止、异常退出、崩溃或 `kill -9` 后是否重新拉起。V3 不装系统服务。V5 的服务设计定下拉起策略后，用专门的系统测试用户在 Mac 和 Linux 上实测。实测之前，所有和系统服务有关的结论都只来自源码和文档。
- bridge `446b2a4` 的已测基线为 153 个测试文件，其中 152 个通过、1 个有意跳过；1683 个用例通过、15 个有意跳过。搬进 `packages/daemon` 后，V2 要核对通过数和跳过数。跳过的 provider 实时测试不算作运行验收。V3 删除 `src/web` 后不再要求这个文件数，改为全部测试通过，并在 PR 里附上旧测试到 RPC 测试的映射表。

## 已知风险

- 远程访问信任云端分发的 daemon 公钥。云端被攻破时可能被中间人攻击。V11 可以加一个可选的指纹核对，在 daemon 本机界面和远程客户端上显示同一串指纹。
- 桌面端内置的 daemon 和 npm 全局安装的 daemon 版本可能不同。V5 要处理协议版本不兼容时的提示和重启。
- 云端的部署平台还没定。vonvon-bridge-legacy 有 `deploy/tencent` 可以参考。
- V3 起后端安装的输出只保留最后 256 KiB，`omittedBytes` 记下丢掉的字节数。从中途接上的客户端看不到更早的输出，失败原因仍由错误尾部给出。V3 不限制 npm 的运行时长。npm 卡住时，它会占着一个进程和对应的安装槽，直到 npm 退出或 daemon 停止。V3 起后端的安装、更新、卸载排队逐个执行，所以卡住的 npm 还会挡住排在后面的所有后端操作。等界面需要取消安装时，再定超时和取消的语义。
- V2 合并后运行中的 daemon 没有接上停止和重启的回调，旧网页的这两个接口都返回 501（PR #24 和旧测试有记录）。复制来的源码里那段“停止时卸载服务”的辅助代码从没在 daemon 上运行过，不能当作旧版能用的证据。V3 第一次真正提供停止和重启，只针对用 CLI 启动的 daemon。复制来的服务代码仍用 bridge 的服务标识，运行它可能覆盖或删除原 bridge 的注册，所以 V3 的 `vonvon service install` 和 `uninstall` 一律报错退出，什么也不改。V2 时期如果有人用过 `vonvon service install`，留下的注册 V3 不检测也不删除。
- V3 只在正常停止和重启时确认 Codex 进程组已退出。Bot 子进程或 daemon 异常退出（崩溃、被手动 `kill -9`）时，它启动的 Codex 进程组可能留下来，V3 不接管、不按记录的 pid 发信号，也不对它们做任何保证。Claude 后端的 CLI 子进程由 Claude Agent SDK 启动，daemon 拿不到它的句柄，V3 不确认它退出；V6 换掉这个后端时再说明这些进程怎么纳入同一条规则。私聊菜单的“重启”和“更新”在 V3 仍只发说明卡片，不执行重启或更新。
- V3 重启时，旧 daemon 放锁之后、新 daemon 拿到锁之前有一小段时间没有进程负责这个数据目录。这时运行 `vonvon daemon stop` 会报“已停止”，新 daemon 仍会起来，再运行一次 `vonvon daemon stop` 即可。放锁之前收到的停止请求一定会取消重启。
