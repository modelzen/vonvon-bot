# Vonvon Bot 实施路线

> **2026-10-14 起停止执行。** owner 重新定义了第一版：macOS 桌面端，每个 bot 有自己的工作区、仓库、skill、记忆和性格。v1 的范围以定稿后的 `docs/product.md` 为准，规则见 `AGENTS.md`。下文的 PR 顺序、合并图、分工、issue #122 看板和三平台 CI 都是历史记录。

这份文档按顺序列出把 Vonvon Bot 做成独立产品要合并的 PR。每个决定的理由见 [architecture.md](architecture.md)。

## PR 顺序

每个 PR 都是一个可以单独验证的改动。2026-10-12 起合并不再按 V1 到 V11 的编号排队，而按下文“合并图”：一个 PR 的合并前提都已合入，它验证通过就可以合。下表的“依赖”是验收和合并的依赖：PR 的实时、性能、原生检查要用到的真实产物和行为来自这些 PR。什么时候能开始写代码另见下一节“开发起点”，通常比验收早。分支有新提交时，把它 merge 进来。被依赖的 PR 合并进 `main` 后，把 PR 的目标改成 `main`，再把 `main` merge 进来。整个过程不 rebase，不 force-push。

| 编号 | 内容 | 依赖 |
| --- | --- | --- |
| V1 | 建 monorepo 和 `packages/protocol`。从 `codex/device-handoff` 移植 zod 合同，加握手和机器维度。加托管 CI（V1 当时有 Linux 和 macOS 两个任务，均通过验收；之后按下文 CI 规则保留托管 Linux，macOS 改为自托管） | 无 |
| V2 | 建 `packages/daemon`。用脚本从 bridge `446b2a4` 复制完整 `src/` 和 `test/`，暂留 `src/web` 以保持可运行基线；数据目录改成 `~/.vonvon-bot`。`vonvon daemon run` 能在前台跑起 Bot | V1 |
| V3 | daemon 的 API 服务。WebSocket、本机凭据、pid 锁、RPC 处理、快照请求和快照事件、无损的 `admin` 状态请求、目录浏览 RPC、`vonvon daemon start/stop/status` 和停止、重启的生命周期规则（等已接受的操作做完、确认 Bot、npm 和 Codex 进程都已退出才放锁，重启保持原端口，`vonvon service` 命令在 V5 之前一律拒绝），以及 lane 要用的本机最小 `packages/client`；旧网页管理路由改成 RPC，只读预览和旧网页页面退役，私聊菜单去掉旧控制台按钮，然后删除 `src/web` | V2 |
| V4 | 补全 `packages/client`，新建 `packages/ui`。移植界面，`window.bridge` 换成注入的客户端，daemon 在本机提供网页。旧界面用到、`H3` 还返回 `unsupported` 的请求逐个定归属：环境页、刷新、机器状态和日志由 daemon 补上；打开和复制链接在浏览器里做；只和桌面应用有关的操作交给 V5 的外壳能力。Codex 可执行文件路径改用现有的主机设置保存 | V3 |
| V5 | `packages/desktop`。Electron 外壳拉起或连接 daemon，加载界面，托盘，开机自动运行，自动更新。Vonvon 自己的系统服务（服务标识、安装和卸载、原生验收）也在这里第一次提供 | V4 |
| V6a | provider 层核心。`provider/` 的类型合同、纯函数的回合状态机、子 agent 和 todo 账本、带证据的权限表、所有 provider 共用的进程托管和传输层，以及修复 #114 的出站路径门。设计见 [providers.md](providers.md) | V3 |
| V6b | 运行时、Codex 引擎、Claude Code 引擎（只开完全访问）、39 个源文件调用方和 72 个测试切到新合同，删除 `agent/`。可靠的停止。没有原生插话时的消息队列。会话标题服务。存量数据迁移，旧 provider 编号改写，已有项目的 `readScope` 记为不限读取 | V6a |
| V6c | 运行卡片的五项基线能力：子 agent 区和单个停止按钮、进度行、图片、结果说明。可靠的停止已在 V6b 落地 | V6b |
| V6d | Claude Code 的 `qa` 和 `write` 档：工具白名单、PreToolUse 路径门、Bash 沙箱，macOS 和 Linux 实测后才开格 | V6b；和 V6c 文件不重叠，先后无关 |
| V7a | ACP 引擎和 Cursor、Grok、自定义 ACP 三个方言；provider 编号和选择器 | V6b；选择器的验收要 V4 的网页；Cursor 和 Grok 的实测要用户提供账号；合并前提只有 V6b |
| V7b | Pi 引擎 | V6b；合并在 V7a 之后 |
| V7c | Windows 和 Linux 的权限实测，把对应的格从拒绝翻成已验证 | V7b；要一台 Windows 主机。没有主机时停放，它是叶子，不挡任何版本 |
| V8 | 导入 bridge 数据并关停旧服务。macOS、Linux、Windows 三个平台，界面引导和 `vonvon import feishu-codex-bridge` | V4 |
| V9 | feishu-codex-bridge 仓库的收尾版本。引导用户安装 Vonvon Bot，发现已迁移标记时拒绝启动 | V8，以及 Mac 发布的安装包 |
| V10 | 账号和机器登记。`packages/cloud`、飞书和 Lark 登录、`vonvon login`、桌面端登录、机器列表和在线状态 | V4；桌面端登录的验收要 V5 的外壳；合并前提是 V5 的外壳（拆分时为 V5a），不等 V9 |
| V11 | 远程访问。daemon 向云端的出站连接、转发、端到端加密、云端托管网页、桌面端连接其他机器 | V10；桌面端连接的验收要 V5 |

### 合并图

合并前提只看真实依赖，形成三条链，各自推进，谁先验完谁先合。

- 客户端与云端：V5 → V10 → V11。V10 只要 V5 的外壳；V11 等 V10。
- provider：V6a → V6b；从 V6b 分出 V6c、V6d、V7a，三者互不作为合并前提；V7a → V7b → V7c。V6a 和 V5 都只等已合入的 V4。V7c 是叶子，没有 Windows 主机时停放，不挡任何版本。
- 导入：V8 → V9。V8 只等已合入的 V4；导入写入 bridge 原有的 provider 编号，由 V6b 的加载时迁移处理，所以和 V6b 先后无关。V9 另要 V5 发布的签名安装包。

V5 可以按验收条件拆成 V5a 外壳和 V5b 服务两个 PR，V5b 排在 V5a 之后，`service install` 和 `uninstall` 在 V5b 之前保持拒绝。2026-10-13 起由 Claude 按 `AGENTS.md` 的 PR 大小上限拆分并写进 PR。协议汇总文件、`cli/index.ts`、根 `package.json`、`NOTICE` 和界面登记文件仍由根代理写，跨链合并的冲突只会落在这些文件上，按 patch-id 规则重新 swarm。正式检查的排队也按这张图：前提都已合入或已冻结的 PR 才排进十路实时、性能和 Shipping，两个都能跑时先跑未合入下游更多的那个。细则见 [plan.md](plan.md) *Parallel execution* 的 *Dependencies*。

### 推后的 provider

2026-10-12 的 provider 层重设计（见 [providers.md](providers.md)）把 provider 定为 Codex、Claude Code、Cursor、Grok、Pi 和自定义 ACP 命令。Copilot 和 OpenCode 推后：Copilot 走 ACP，以后只需加一条注册和一个方言；OpenCode 以后单独设计。DeepSeek、Kimi、GLM、Qwen 通过 Claude Code 的用户设置（`~/.claude/settings.json`）路由到模型，不需要单独的 provider，所以 Claude 引擎的 `settingSources` 保留 `user`。原来复制 Paseo provider 闭包的 V6 和 V7 作废，分支 `codex/v6-claude-provider` 和 `codex/v7-providers` 只作参考，不从它们或 Paseo 复制任何代码。

## 开发起点

开发依赖只看代码要用到的接口。接口在上游分支的某个提交上固定（冻结点）后，下游就从那里开分支写代码，不等上游审查通过或合并。冻结点只是接口承诺，不是验收结论；接口之后再变，下游把新提交 merge 进来。验收用的十路实时、性能、原生检查和 Shipping 按合并图排队：PR 的合并前提都已合入或已冻结时才跑正式检查，之前只做单元测试、审查和预演，预演不算证据。

| 编号 | 从哪里开始写 | 部分工作要等 |
| --- | --- | --- |
| V4 | V3 的当前 head（`H3`，根代理把最新 `main` merge 进 V3 后记录） | 无 |
| V5 | V4 冻结点 `F4`（客户端浏览器和 preload 入口、注入客户端接口和可选的外壳能力对象、`ui/dist` 构建路径、界面功能登记文件）；外壳的本机认证连接单元只依赖 `F4`，和 Gate L、Gate M 无关 | 系统服务文件和 `login-item.ts`（包括 `service/drain.ts`、Gate L 和 Gate M，设计已定）也从 `F4` 开始；`install` 和 `uninstall` 在事务、拿锁前检查、两道 Gate 和它们的测试全部集成之前一直拒绝；只有原生验收等测试账号（Mac 上按用户 2026-10-11 的授权可用 `clay`，Linux 仍要专门用户） |
| V6a | `H3` 或 V3 合并后的 `main` | 无 |
| V6b | V6a 冻结点 `F6`（`provider/model.ts`、`engines/engine.ts`、`registry.ts`、`policy/enforcement.ts` 四个合同文件和它们的单元测试） | 调用方切换等 V6a 写完；`domain.ts` 的 `readScope` 由根代理交接 |
| V6c、V6d | V6b 写完后的分支，两者文件不重叠，可以并行 | 无 |
| V7a | ACP 客户端和帧翻译从 `F6` 开始；引擎接入等 V6b 写完 | provider 编号、`customAcpCommand` 设置和选择器等 V4 合并；Cursor 和 Grok 的实测等用户账号 |
| V7b | V6b 写完后的分支，与 V7a 文件不重叠 | 无 |
| V7c | V7b 写完后的分支 | Windows 主机 |
| V8 | `H3` 或 V3 合并后的 `main`：导入执行器、旧服务控制、`vonvon import`、`import.ts` | 界面引导等 `F4` |
| V9 | bridge 仓库 `origin/codex/device-handoff`，只依赖已定的标记文件名 | 下载链接的验收等 Mac 发布的签名安装包 |
| V10 | `H3` 或 `main`：`packages/cloud`、设备仓库接口及其 Postgres 和内存实现、daemon 云端连接、`vonvon login` | 账号界面等 `F4` |
| V11 | `main`：端到端加密的移植（含 `base64.ts`）和测试 | 其余等 V10 冻结点 `F10`，客户端转发和机器切换还要 `F4` |

上表里不等上游验收就能先做的叶子：V5 外壳的认证连接单元，V5 的服务标识、定义编解码、读回和排空（纯逻辑，管理器查询注入），V6a 的纯核心（不依赖任何东西），V7a 的 ACP 客户端和帧翻译以及 V7b 的 Pi 帧翻译（从 `F6` 开始），V10 的设备仓库，V11 的加密移植。先做只是开发，不满足任何验收项，也不改变合并顺序。

协议的汇总文件（`index.ts`、`domain.ts`、`rpc.ts`、`events.ts`、`handshake.ts`）、`cli/index.ts` 的命令登记、根目录的 `package.json` 和 lockfile、`NOTICE`、界面功能登记文件是共享文件。在飞 PR 最多两个，后合入的 PR 在 merge `main` 后解决这些文件的冲突。分支起点和文件归属见 [plan.md](plan.md) *Parallel execution* 的 *Dependencies*。

各链分别推进。客户端和云端链是 V4、V5 外壳、V10、V11；V5 的服务验收需要 Gate L、Gate M、Mac 图形会话（按用户授权可用 `clay`）和 Linux 专门测试用户的 systemd 用户会话。导入链是 V8、V9；V9 的发布还需要 V5 签名安装包。V10 不等 V9。测试用户和 systemd 环境在第一波就准备，不等 V4 开始。

## 谁来做

分工按仓库根目录 `AGENTS.md` 的 2026-10-13 版。JP-VPS 上的 Claude 设计并实现，在 Linux 上跑完检查后交接。Mac 上的 Codex 做独立审查、在 macOS 和 Windows 验证、真实窗口和原生服务验收、冻结、Shipping 和合入，也负责打包、签名、公证和发布。V9 需要的安装包下载地址来自 Mac 的发布。2026-10-10 到 2026-10-12 的根代理加工作代理模式已停用。

V5 和 V8 里有 systemd 检查，Mac 上跑不了。Codex 在 Linux 虚拟机或有用户会话的 Linux 环境里跑这几条，托管 CI 不能顶替。V5 的原生服务检查通常用专门的系统测试用户，Mac 上可按下文的用户授权在 `clay` 中使用隔离的数据和 Vonvon 服务标识。V8 安装旧 bridge 服务的检查和原 bridge 用同一个服务标识，也要在专门的测试用户里跑，不碰用户账号里在用的 bridge。较早的环境报告只确认了日常用户的 Mac 图形会话，也没有确认可用的 Linux systemd 用户会话。第一波先只读检查现有专用测试环境，只向用户请求缺少的能力；`ci-user` 保留给 CI，不用于系统服务验收。第一波的只读检查结果：Mac 上有用户 `test-user`（uid 502），但它没有图形会话（`gui/502` 不存在）；Linux 上 `operator` 的 systemd 用户会话在运行，但还没有专门的测试用户。所以要有人用快速切换用户或屏幕共享把 `test-user` 登录进图形会话，并在验收期间保持登录；Linux 用腾讯云主机 203.0.113.10 上的专门用户 `accept-user`。用户已授权 root SSH，根代理按 [native-acceptance-hosts.md](native-acceptance-hosts.md) 准备，不再另向用户要许可。只有 V5 的原生验收等这两样，V4、V6a 和 V5 的其他工作不等。

2026-10-11 用户回答 V5/V8 的测试账号问题，直接授权在 `clay` 中测试。V5 的 macOS 系统服务测试（原生 launchd 检查和第 6 路的 Mac 部分）因此不再等 `test-user`。条件是：只用这次运行自建的临时 `VONVON_HOME`；产品服务标识 `com.vonvon.bot.daemon` 不改名，开跑前只读确认 `clay` 里没有这个任务和 plist，运行结束用 `uninstall` 删掉；不碰 `ai.feishu-codex-bridge.bot`、bridge 数据和其他 LaunchAgent，不改 `~/Library/LaunchAgents` 的权限，不用 `ci-user`；开跑前和结束后记录在用 bridge（根代理记录为 PID 2253）的 pid、启动时间和 TCP 监听，有任何变化就停止并判失败，不重启 bridge。V8 同样已获 `clay` 测试授权，但导入会找到并暂停调用用户自己的 bridge 服务，在 `clay` 里会碰到在用 bridge。所以 V8 的各路检查都在 `test-user`（`gui/502`）和 Linux 的 `accept-user` 里跑，不在 `clay` 里跑。把 `test-user` 登录进图形会话是用户操作。这是操作约束，不是缺少用户授权；不能触碰或重启在用 bridge。Linux 由用户授权的腾讯云 root SSH 准备，细则见 [native-acceptance-hosts.md](native-acceptance-hosts.md)。细则见 [plan.md](plan.md) V5 的 *Native acceptance environment*。

每台机器一个在飞 PR 一个会话，在飞产品 PR 最多两个，一个 PR 一个任务分区。Claude 开发第二个 PR 时 Codex 验证第一个，并行只有这两级。并行只提前开发起点（见上文“开发起点”），不改变合并图、验收依赖、架构、数据形状和验证门槛。V10 的云端部分可以在 V3 之后开始开发，V5 外壳合并并通过自身验证后即可合并 V10，无须等待 V9。merge `main` 之后，patch-id 不变只是审查结论继续有效的必要条件：基线、依赖版本或相关证据变了，就要重跑受影响的检查，并重新拿独立审查结论。

实现中发现的设计缺口在同一 PR 的评论里提出，Claude 在该 PR 里同时改代码和计划，不另开文档 PR。

用户已授权 V2 及后续版本在全部验证通过后继续合并，无需等待个人界面复核或手动点击合并。各版本按用户实际接触的界面留存交互证据：网页、桌面窗口和飞书卡片留真实截图和视频；只有命令行和 API 的 V3 改留 CLI 证据包（伪终端原始录制、每条命令的原始输出和退出码、自动断言、绑定准确 head 和构建哈希的清单，并由另一个代理独立重跑核对），不再要求终端截图和录屏。拿不到规定的证据时这一项保持未完成，授权不能当作通过。单元测试、十路实时检查、性能检查、独立审查与准确 head 的 Shipping 判定仍是合并条件。不得 force-push、rebase 已推送分支，也不设置小时审计。

逐项的步骤和验证标准见 [plan.md](plan.md)。

## 进度跟踪

2026-10-12 起，程序的进度放在本仓库的 GitHub issue 里，由 `docs/program-graph.json` 经 `scripts/program-graph-sync.mjs` 生成和维护。

- 看板是置顶的 [issue #122](https://github.com/modelzen/vonvon-bot/issues/122)。正文有版本合并图、进度表和任务依赖图，三者由 `node scripts/program-graph-sync.mjs board` 从 issue 的实际状态重新生成。颜色：绿已完成，黄进行中，白可开始，灰被挡，虚线停放，蓝已冻结或已验证。
- 每个版本一个父 issue（#123 工具，#124 V5 到 #135 V11），子 issue 是按文件不重叠切出的任务分区、证据门、集成交接和该版本的缺陷。版本之间的合并前提和任务之间的依赖都用 GitHub 的 blocked by 关系表示。只有用户能做的事是 #205 到 #209，指派给用户。GitHub 项目 “Vonvon Bot v2” 收录全部 issue，可在那里按状态和版本看板视图。
- 状态由 Codex 维护：任务开始时加 `state:in-progress`，分区集成且测试通过后关闭；版本在四个节点换标签，`state:code-ready`、`state:frozen`、`state:verified`，PR 合入后关闭。实现中发现的缺陷新开 issue 挂到对应版本并打 `version:<编号>` 标签。
- 改任务图（新增分区、改任务依赖、V5 拆分）先改 `docs/program-graph.json` 再运行 `node scripts/program-graph-sync.mjs sync`。同步是幂等的：补建缺的 issue、更新标题和正文、补链接和标签，不删除任何东西。Codex 可以增减不影响架构、数据形状和合并边的任务；要改合并边的交回 Claude Code 改计划。
- 本地进度网页 #203 于 2026-10-13 停止，Codex 关闭该 issue 并记录原因。#122 看板和 PR 状态是唯一进度来源，Codex 在交接和合入时更新。

## CI

Linux 保留 GitHub 托管的 Ubuntu，Windows 用托管的 `windows-2025`；macOS 配置为组织共享的 Mac mini 自托管 runner。完整改动三个平台都跑。原有 Windows 原生检查保留在旧桌面分支的工作流中，桌面打包和原生界面检查不在 main 的检查链里。两个仓库的 `ENABLE_SELF_HOSTED_MACOS_CI` 均已开启，使用无发布凭据的专用标准账户 `ci-user`。重启后先登录该账户一次，再切回日常用户并保留后台图形会话。每台 Mac 只运行一个 runner，两个仓库排队共享。安装位置、权限和服务管理见 [self-hosted-ci.md](self-hosted-ci.md)。

2026-10-12 起完整的三平台运行只在冻结 head 跑一次，不再每次 push 都跑。目标为 `main` 的 PR 每次事件只跑范围分类和文档检查；完整运行只在 PR 带 `frozen` 标签时或手动触发时跑。Codex 冻结 head 时打标签，patch 变了先摘标签、下次冻结再打。冻结之前 Claude 在 JP-VPS 跑 Linux 完整链，Codex 在 Mac 跑 macOS 链，这些都不算 GitHub 检查。取消合入 main 后重复跑相同套件的 push 触发，不设置定时任务。同一 PR 的旧运行会被新运行取消。改目标或改基线后没有当前结果时，手动补跑。工作流已在 #217 落地。

范围脚本保留 `docs` 和 `full`，未知或异常差异按 `full` 处理。文档改动只跑范围回归和空白检查，不装依赖，也不启动 Mac。完整改动先在 Linux 跑 Node 22 的安装、构建、类型检查、测试和 lint，再在托管 Windows 和自托管 Mac 的准确 PR head 跑同一套检查。daemon 原先的 lint 与类型检查完全相同，删除重复的 lint 别名，协议 lint 保留。

合入要求当前 Linux 成功，完整改动还要求 Windows 和 Mac 都成功。如果再次暂停 Mac CI，完整改动的 Mac 验证保持待办。计费、离线或超时阻塞不能记为通过。Mac CI 已覆盖的常规命令不再手动重复，里程碑要求的实时、性能、原生桌面、launchd、systemd 和独立审查照旧。完整规则见 [plan.md](plan.md) 的 *CI policy*，触发示例和费用计算见 [ci-costs.md](ci-costs.md)。

临时豁免（2026-10-10，已撤回）：组织共用的 Actions 分钟数用完时，用户曾授权不等 GitHub 结果就推送和合入，记录写“SKIPPED（用户授权）”，从不记为通过。`main` 的 `48251d9` 恢复了 Linux、托管 Windows 和自托管 Mac 的完整 CI，用户已撤回豁免。所有未合入的 head 按上面的完整规则检查。豁免期间的记录保留 SKIPPED 原文，不改成通过，也不能用于今后合入的任何 head。详见 [plan.md](plan.md) 的 *Temporary CI waiver*。

## 现有 PR 栈怎么处理

新结构从 `main` 开始。PR #2 到 #19 先保持打开，作为移植界面时的参考。V4 合并、界面移植完成后，关闭这些 PR，不合并。

## 要验证的事

这些事现在只是推断，要在对应的 PR 里用实际运行证明。

- 飞书长连接模式下，同一个 Bot 的两个客户端只有一个收到事件。在 V8 里用两个进程连同一个测试 Bot 验证，结果决定导入时是否必须先暂停 bridge。
- Claude Code 的 PreToolUse 路径门能挡住 `Read`、`Grep`、`Glob` 读项目外的文件，子 agent 里也一样；沙箱里 `allowRead` 能覆盖上级目录的 `denyRead`。V6d 用真实的 Claude Code 在 Mac 和 Linux 上实测这几条。实测之前，Claude 的 `qa` 和 `write` 档一律拒绝启动。
- Cursor 的 `cursor/task`、`cursor/update_todos`、`cursor/generate_image` 的负载格式，Grok 用 `todo_write` 时会不会发 ACP `plan`、生图结果怎么回传、回合中再发提示是排队还是插入。V7a 在 Mac 上用用户提供的账号录下原始 JSON 行，再据此写方言。录到之前这些格按“没有”处理。
- launchd 和 systemd 在 daemon 正常停止、异常退出、崩溃或 `kill -9` 后是否重新拉起。V3 不装系统服务。V5 的服务设计已经定下策略：只在失败时拉起（launchd `KeepAlive` 设为 `SuccessfulExit: false`，systemd `Restart=on-failure`），停止退出 0，重启退出 75、由系统服务管理器在原端口拉起；Core 更新另由 V3 的重启助手完成那条更新记录，Linux 上确认助手进了单独的 scope 并已启动后才放锁（Gate L）。macOS 只在“撤下定义、排空”之后才 `bootout`（Gate M）。卸载先撤下服务定义，再停止并卸载服务。Vonvon 自己从不通过管理器停止正在运行的 daemon。这套策略要在 Mac 和 Linux 上实测：Linux 用腾讯云主机上的专门用户 `accept-user`（2026-10-12 只读核对：systemd 255、cgroup2fs 统一层级，与 Gate L 的前提一致；每次运行前 B0 再记录，不一致就停止。只在那里失败的，可整箱在虚拟机上重跑，两边都报告），Mac 按用户 2026-10-11 的授权可在 `clay` 里按上文条件跑。实测之前，所有和系统服务有关的结论都只来自源码和文档。Windows 没有可用主机，它的启动项循环只做单元测试，真实机器上的拉起行为未经验证。
- bridge `446b2a4` 的已测基线为 153 个测试文件，其中 152 个通过、1 个有意跳过；1683 个用例通过、15 个有意跳过。搬进 `packages/daemon` 后，V2 要核对通过数和跳过数。跳过的 provider 实时测试不算作运行验收。V3 删除 `src/web` 后不再要求这个文件数，改为全部测试通过，并在 PR 里附上旧测试到 RPC 测试的映射表。

## 已知风险

- 远程访问信任云端分发的 daemon 公钥。V11 保留 Paseo 的握手，`e2ee_ready` 是明文、没有认证。公钥被换成另一把有效公钥、而 daemon 一端是真的时，第一帧密文解不开，客户端断开并报错，不交换任何数据。云端被攻破、同时换公钥并冒充 daemon 一端时，可能被中间人攻击，V11 接受这个风险。以后可以加一个可选的指纹核对，在 daemon 本机界面和远程客户端上显示同一串指纹，那需要另行设计。
- 桌面端内置的 daemon 和 npm 全局安装的 daemon 版本可能不同。V5 要处理协议版本不兼容时的提示和重启。
- 每个系统用户只能注册一个 Vonvon 服务，对应一个数据目录。用别的 `VONVON_HOME` 安装会被拒绝，那个目录的 daemon 只能用 CLI 启动。快照的平台枚举里没有 Linux，形状又已冻结，所以 Linux 桌面端不提供开机自动运行开关，Linux 用户用 `vonvon service install`。
- V5 的两处服务设计（Gate L、Gate M）已经补上，但依据只有源码和文档。Linux 的就绪确认读 `/proc` 里的 cgroup 和命令行，前提是统一的 cgroup 层级，并且服务退出时不会波及单独的 scope，这两点要在 Linux 测试用户上实测助手能活过 exit 75。macOS 安装回滚后，旧任务不会加载，要等 `vonvon daemon start` 或下次登录，这一点也要原生验收。macOS 上另起进程组的助手不会被 launchd 回收，这一点有 `launchd.plist(5)` 的文档支持，同样要原生验收。安装回滚和续做的卸载只停止经过四步证明的任务子进程，这个证明依赖两条假设：管理器查到的 pid 是准的（要原生验收确认），以及 `(pid, startedAt)` 只对应一个进程。后者沿用 V3 锁文件的格式，只有系统时钟恰好倒退一个进程寿命时才会失效，失效时最多停掉这个数据目录里、用本目录凭据应答的 Vonvon daemon。停止请求如果失败，包括已被接受、只是回复丢了的情况，一律记为“停止未确认”：不再发停止，不卸载，不写回定义，注册保持撤下，结果报未完成并给出 pid，之后再跑一次 `vonvon service uninstall` 收尾。
- 云端的部署平台还没定。vonvon-bridge-legacy 有 `deploy/tencent` 可以参考。
- V3 起后端安装的输出只保留最后 256 KiB，`omittedBytes` 记下丢掉的字节数。从中途接上的客户端看不到更早的输出，失败原因仍由错误尾部给出。V3 不限制 npm 的运行时长。npm 卡住时，它会占着一个进程和对应的安装槽，直到 npm 退出或 daemon 停止。V3 起后端的安装、更新、卸载排队逐个执行，所以卡住的 npm 还会挡住排在后面的所有后端操作。等界面需要取消安装时，再定超时和取消的语义。查询后端最新版本的 `npm view` 也一样：8 秒时只发一次 SIGTERM，请求要等 npm 真正退出才回复；npm 不理 SIGTERM 时，这个请求和停止前的排空会一直等着，日志里有一条带 pid 的记录。
- V2 合并后运行中的 daemon 没有接上停止和重启的回调，旧网页的这两个接口都返回 501（PR #24 和旧测试有记录）。复制来的源码里那段“停止时卸载服务”的辅助代码从没在 daemon 上运行过，不能当作旧版能用的证据。V3 第一次真正提供停止和重启，只针对用 CLI 启动的 daemon。复制来的服务代码仍用 bridge 的服务标识，运行它可能覆盖或删除原 bridge 的注册，所以 V3 的 `vonvon service install` 和 `uninstall` 一律报错退出，什么也不改。V2 时期如果有人用过 `vonvon service install`，留下的注册 V3 不检测也不删除。
- V3 只在正常停止和重启时确认 Codex 进程组已退出。Bot 子进程或 daemon 异常退出（崩溃、被手动 `kill -9`）时，它启动的 Codex 进程组可能留下来，V3 不接管、不按记录的 pid 发信号，也不对它们做任何保证。Claude 后端的 CLI 子进程由 Claude Agent SDK 启动，daemon 拿不到它的句柄，V3 不确认它退出；V6a 的进程托管用 SDK 的 `spawnClaudeCodeProcess` 接管这个子进程，和 Codex 进程一样记进 `owned-pids.json`，V6b 起 Claude 进程纳入同一条规则。私聊菜单的“重启”和“更新”在 V3 仍只发说明卡片，不执行重启或更新。
- V3 正常停止时也有一个已接受的限制。V3 只凭进程组号发信号，没有能证明“还是同一个进程组”的系统句柄，所以按号码发信号只是尽力而为。进程组还在时这个号码不会被复用，但两次探测之间，最后一个后代可能退出、号码又被一个无关的新进程组拿走，下一次探测仍然成功，接着的 SIGTERM 或 SIGKILL 就会打到那个无关进程组；同样的情况也可能让 V3 把它当成未退出的 Codex 进程组，继续占着锁。V3 唯一保证的是：一旦观察到 `ESRCH`，之后不再对这个号码探测或发信号。它不保证任何一次发给进程组的信号都打到原来的进程组，直接子进程退出之前发出的也不保证。这一条和上面异常退出的限制是两回事，详见 [plan.md](plan.md) *Provider processes* 的 *Signals*。
- V3 重启时，旧 daemon 放锁之后、新 daemon 拿到锁之前有一小段时间没有进程负责这个数据目录。这时运行 `vonvon daemon stop` 会报“已停止”，新 daemon 仍会起来，再运行一次 `vonvon daemon stop` 即可。放锁之前收到的停止请求一定会取消重启。
- `vonvon daemon stop` 退出码为 0，才说明 daemon 已放锁、它启动的子进程都确认退出。如果 daemon 接受停止后没放锁就退出了（监听端口关闭得不到确认，或被异常结束），`stop` 报“清理未确认”并退出 1，不发信号，也不删锁文件；下次 `vonvon daemon start` 会照常替换这把锁。
