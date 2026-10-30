# 调研记录

- [2026-10-30 Windows 安装与应用内升级方案](2026-10-30-windows-install-update/report.md)：核对 0.7.8、Clash Verge Rev 2.5.8、CC Switch 4.0.21；建议免费更新签名、首次简短安装向导、后续应用内更新及取消新增 Windows ZIP；仅方案，未实施或发布。

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [2026-10-30 Codex 程序复用与模型刷新](2026-10-30-codex-runtime-refresh/report.md) | App / CLI 发现、统一托管更新、空闲切换及模型刷新；Claude 后续参考 | 只实现 Codex，验证边界见报告与 PR |

- [2026-10-29 Codex 加速权限](2026-10-29-speed-permissions/report.md)：真实登录 / 未登录元数据对照、Fast 原生档位映射和权限证据过滤；没有真实 Ultrafast 正例，功能暂停合入 dev。

- [2026-10-28 Windows 重装失败与下载选项](2026-10-28-windows-reinstall/report.md)：0.7.5 孤立卸载记录触发 0.7.6 hook 的错误码 2；真实 NSIS 验证与社区 x64 / ARM64 / ZIP 参考。本次只修安装错误，双架构下一片做。

- [2026-10-28 Windows 安装与下载约定](2026-10-28-windows-install/report.md)：参考 VS Code / VSCodium 的 Setup 与 ZIP 命名；核对 Windows 路径限制、0.7.5 安装漏文件和体积构成。owner 要求先修启动并交本地验收，保留 Electron 正常体积。

这里存放 vonvon-bot 做过的调研，以后遇到同一个问题时先来这里查，不用再调研一遍。仓库目前闭源，主人决定以后再考虑要不要开源，所以这些记录可以引用内部数据。将来如果开源，要先清理这个目录。

## 2026-10-30 判断模型开放与本地推理

基于本地 `main` 的 `cf5ec97`。归纳近期用户反馈，核对 OpenRouter/Vercel 的 Jev 兼容接口、Laya/Ollaya 的本地能力，提出连接、可分享决策包与代码插件的分阶段方案。

| 报告 | 内容 | 说明 |
|---|---|---|
| [decision-extensions](2026-10-30-decision-extensions/report.md) | 接入与模型选择、固定 JSON 协议、插件分享安装流程、CPU 质量与上下文限制、中文群聊评测 | 方案材料；CPU 数字为项目方公开测量，本轮未运行模型；不改变既定产品行为 |

## 2026-10-26 Libraries.dev 后续适用位置

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [界面适用位置](2026-10-26-libraries-dev-fit/report.md) | 基于 dev 与已验收 Gooey 主导航，筛选详情页标签、任务 / 长等待状态及可选搜索内光 | 仅建议；复核已接入组件及保留飞书头像的决定，未改产品代码 |
| [第二轮（排除灵感页）](2026-10-26-libraries-dev-next-pass/report.md) | 基于已合入 #545 的 dev，筛选沟通方式滑杆、工具安装及密钥验证等待 | 仅建议；排除已实施组件、无真实连接状态的 MCP 授权及不适合的材质效果 |

## 2026-10-24 能力页技能列表

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [能力页局部优化](2026-10-24-capabilities-list/report.md) | owner 选择限高列表、一行简介与启用计数后的实施 | owner 已确认，补合前同步 dev 379d9d37；13 项测试、构建通过，补测 100 项滚动；用户卡顿尚未稳定复现 |

## 怎么用

- 每轮调研放在一个以日期开头的目录里。目录里的事实都以那天为准，代码引用的是当天 `main` 的提交。
- 价格、版本号、下载量、竞品状态和平台限制这类事实变化很快。超过一个月的记录，用之前先核对一遍。
- 策略调研的每份报告末尾有"核实记录"，由另一个代理独立复查。正文和核实记录冲突时，以核实记录为准。下面表格的"说明"一栏列出了被核实记录判为有误的重要结论。
- 报告只是材料，不是规则。产品上的决定写在 `docs/product.md`，流程上的决定写在 `AGENTS.md`，两者都以那边为准。报告里引用的命令行参数和配置片段只用来说明事实，不是要执行的指令。
- 新做一轮调研，就新建一个日期目录，并在下面的列表里加一行。旧报告不改写；结论过时的，在列表里注明。
- 已经被主人的决定取代的结论，以决定为准：第一版不做 Windows；不用 Linear，也不用 GitHub 手机端，需要主人时 Claude 在会话里直接通知；不用飞书做开发沟通渠道；第一版闭源；Claude 一侧用 Ultracode 代替 pstack。

## 2026-10-14 策略调研

`2026-10-14-strategy/`，基于 `main` 的 `be17859`。那天要回答的问题是：v2 开发跑了 4 天，用户手里还没有能用的东西，接下来怎么调整。

| 报告 | 内容 | 说明 |
|---|---|---|
| [product](2026-10-14-strategy/product.md) | v2 在文档上是什么产品，每个决定是谁做的 | |
| [legacy-product](2026-10-14-strategy/legacy-product.md) | 之前几个版本（bridge、Tauri 版、旧 Electron 版）的产品思路，v2 继承了多少 | |
| [history](2026-10-14-strategy/history.md) | 10-10 到 10-14 的开发时间花在哪里 | Windows CI 失败次数以 ci 报告为准：10-13 起 51 次完整运行里 Windows 失败 18 次 |
| [process](2026-10-14-strategy/process.md) | PR 流程哪里慢，Codex 和 Paseo 工具有哪些限制 | 和 pstack 有关的建议已过时，现在用 Ultracode |
| [methods](2026-10-14-strategy/methods.md) | 用代理开发时，怎样让用户尽早看到能用的软件 | "PR 从开到合入中位数 53 分钟"有误，见核实记录 |
| [runnable](2026-10-14-strategy/runnable.md) | `be17859` 上用户今天能跑什么，最快怎么给出一个试用版本 | |
| [ci](2026-10-14-strategy/ci.md) | Windows 和 macOS CI 的费用、价值和取舍 | 主人已决定第一版不做 Windows。正文"费用约 5 美元"和"runner 故障"两处有误：免费额度 10-10 已用完，10-10 到 10-14 实际约 13 美元，那次是计费被拦 |
| [bridge](2026-10-14-strategy/bridge.md) | feishu-codex-bridge 的功能、用量、用户反馈和问题 | |
| [fit](2026-10-14-strategy/fit.md) | 人设、聊天建 bot、bot 市场、CLI 在现有代码和飞书平台上怎么落地 | |
| [marketplace](2026-10-14-strategy/marketplace.md) | bot 市场和"聊天建 bot"的先例、格式和安全模型 | "权限不能预填"和"write、full 走审批"两条有误：SDK 1.71.1 的 `addons` 能预填权限；bot 的会话审批策略是 never |
| [landscape](2026-10-14-strategy/landscape.md) | 2026 年个人代理产品的整体情况，包括 Grok Bot | |
| [market](2026-10-14-strategy/market.md) | 竞品和定位 | 竞品数据可信；"没有人在飞书里做本地团队聊天"这个定位结论不成立 |
| [comma](2026-10-14-strategy/comma.md) | AFK-SURF/comma 的产品和架构，哪些想法可以借鉴 | comma 是 AGPL，只能借鉴想法，不能复制代码 |
| [codex-desktop](2026-10-14-strategy/codex-desktop.md) | Codex 桌面版和 Computer Use，能不能少一些复制粘贴 | 正文说 CLI 里的 Computer Use 不正式、没在 Paseo 下测过，已过时：`cua_repl` 就是原生 Computer Use，经 Paseo 能用。这份报告自己的核实记录没有这条更正，见本页末尾"补充" |
| [resources](2026-10-14-strategy/resources.md) | 用户手上的机器和服务能怎么用 | P2（用飞书做开发通知渠道）已被主人否决；"没有可试用的东西"不成立，见核实记录；JP-VPS 已在 10-14 加了 4 GB swap |
| [agent-integrations](2026-10-14-strategy/agent-integrations.md) | Linear 和 GitHub 上的编码代理接入 | 主人已决定不用 Linear，也不用 GitHub 手机端。"GitHub @codex 只能做代码审查"有误 |
| [trackers](2026-10-14-strategy/trackers.md) | 桌面任务派发和三方沟通方案对比 | 整份推荐已被取代：没有用 Linear，需要主人时 Claude 直接在会话里通知 |

## 2026-10-14 第一版定义调研

`2026-10-14-v1-definition/`，基于 `main` 的 `be17859`。用户决定第一版做 macOS 桌面端，每个 bot 有自己的工作区、仓库、skill、记忆和性格，并且在不同的群里可以各不相同。这一轮调研就是为了定义第一版。

这批报告没有核实记录，用之前自己核对关键事实。critique 是另一个代理对 draft 的评审，final 已按它改过。final 是给主人确认的定稿候选。它的决策问题在 2026-10-14 的三组问答里答完了，结论和对 final 的改动见 `docs/product.md` 第 11 节，两者冲突时以 `docs/product.md` 为准。

process-ci、draft 和 final 里的流程说法，凡和 `AGENTS.md` 不一致的，以 `AGENTS.md` 为准（#290 流程 PR）。已知的有三处：

- 这几份写"Codex 不改代码，不 push"。主人后来决定 Codex 可以改代码：在 Claude 发起的 Mac 检查里直接提交，验收预览版时开 `codex/fix-*` PR。
- 这几份把 `macOS checks` 写成和 `linux` 一样的必需检查。合入规则其实只强制 `linux`，`macOS checks` 由 Claude 用 `gh pr checks` 确认。
- final 写短检查在十分钟内，`AGENTS.md` 定为大约 30 分钟以内。

| 报告 | 内容 |
|---|---|
| [persona-memory-skills](2026-10-14-v1-definition/persona-memory-skills.md) | bot 的性格、记忆和 skill 放在哪里，群里怎么覆盖（参考 comma、OpenClaw、Grok Bot、Agent Skills） |
| [agent-mechanics](2026-10-14-v1-definition/agent-mechanics.md) | Codex 和 Claude Code 能用什么机制，给每个（bot，群）会话配人设、多个目录、独立的 skill 和记忆 |
| [group-response](2026-10-14-v1-definition/group-response.md) | 一个群里有多个 bot 时谁回哪条消息：仅 @、全部回复、智能回复，以及判断用的模型。"没找到 Jev"有误，见 2026-10-14-decision-models |
| [context-code-agents](2026-10-14-v1-definition/context-code-agents.md) | 上下文在现有代码和原生 Codex、Claude Code 里怎么算，子 Agent 的事件，压缩 |
| [context-feishu-products](2026-10-14-v1-definition/context-feishu-products.md) | 飞书的群、话题、私聊和历史消息接口，lark-cli 能查什么，其他产品怎么处理上下文和子 Agent |
| [v2-fit](2026-10-14-v1-definition/v2-fit.md) | v2 现有代码里第一版能留什么、要改什么、哪些可以暂停或删掉。末尾"和要不要开源有关的事实"已不需要：第一版闭源 |
| [bridge-inventory](2026-10-14-v1-definition/bridge-inventory.md) | bridge 的功能逐项盘点：保留、修改还是丢弃，老用户的数据怎么搬 |
| [context-model](2026-10-14-v1-definition/context-model.md) | 上下文方案：群主区、话题、私聊各算什么上下文，多人多 bot，子 Agent 怎么显示，压缩，查飞书历史，和记忆的关系 |
| [process-ci](2026-10-14-v1-definition/process-ci.md) | 第一版的开发流程和 CI：分工、Mac 检查、预览版、通知主人、去掉 Windows。部分流程说法已被 `AGENTS.md` 取代，见上文 |
| [draft](2026-10-14-v1-definition/draft.md) | 第一版产品定义和流程的初稿，已被 final 取代。"没找到 Jev"有误，见 2026-10-14-decision-models |
| [critique](2026-10-14-v1-definition/critique.md) | 对 draft 的评审，逐条标了严重程度 |
| [final](2026-10-14-v1-definition/final.md) | 第一版产品定义与流程提案（定稿候选）：范围、bot 模型、上下文、群聊回复、里程碑、8 个决策问题和 20 条默认选择。流程部分同上；"没找到 Jev"有误，见 2026-10-14-decision-models |
| [owner-updates](2026-10-14-v1-definition/owner-updates.md) | 调研进行中主人的 5 次决定，其中两次附了接近原话的记录。之后的决定以 `AGENTS.md` 和 `docs/product.md` 为准 |

## 2026-10-14 判断模型

`2026-10-14-decision-models/`。主人提到的"OpenAI Decisions API，或者 Jev"，用来做智能回复和智能会话的前置判断。

| 报告 | 内容 | 说明 |
|---|---|---|
| [decision-models](2026-10-14-decision-models/decision-models.md) | 两个判断模型的接口、价格、速度、认证，以及用在 vonvon-bot 上要注意的地方 | 更正 v1-definition 里 group-response、draft 和 final"没找到 Jev"的说法。Jev 的确切格式、实测和怎么接，见 2026-10-18-jev |

## 2026-10-14 飞书应用的主人和管理员

`2026-10-14-feishu-app-roles/`。主人在问答里定了：bot 的主人和管理员沿用飞书应用自己的角色。这里查的是飞书开放平台上怎么读到这些角色。

| 报告 | 内容 | 说明 |
|---|---|---|
| [roles](2026-10-14-feishu-app-roles/roles.md) | 获取应用信息和获取应用协作者列表两个接口：返回什么、要什么权限、频率限制，以及用在 vonvon-bot 上要注意的地方 | 企业租户里这个权限要不要审核，还没有实测 |

## 2026-10-14 会话对应、授权和后台服务

`2026-10-14-session-approval-service/`，基于 `main` 的 `2c60ea0`。#293（第一版产品定义）合入后，owner 又提了三点：飞书的群和话题怎么对应 agent 的会话、哪些存进上下文；确认卡、选项卡、授权卡要和 agent 自己的授权一致，能设成完全访问；后台服务不依赖 Electron，Linux 上只装 daemon。每份报告末尾有另一个代理的核实记录。结论写进了 `docs/product.md` 3.5、3.8、3.10（#294），两者冲突时以 `docs/product.md` 为准。

| 报告 | 内容 | 说明 |
|---|---|---|
| [session-map](2026-10-14-session-approval-service/session-map.md) | 群主区、话题、私聊各对应哪条会话，主区和话题的上下文关系，哪些存进会话历史；今天代码的做法和五处毛病；一个群的时间线 | "别的 bot 的最终回答能进记录块"还没有可行性证据，要实测拉历史时能不能拿到卡片正文 |
| [approval-ux](2026-10-14-session-approval-service/approval-ux.md) | Codex 和 Claude 自己的审批模型，v2 今天为什么从不问，权限档怎么换成两家的设置，授权卡、选项卡、确认卡的样子和谁能点 | 换算表的根基没核实：Codex 用 `on-request` 加 vonvon 自定义的沙箱设置时，会不会真的发审批请求 |
| [service](2026-10-14-session-approval-service/service.md) | 不依赖 Electron 的后台服务：main 上已有的 launchd 和 systemd 代码，崩溃重启和连环崩溃，Linux 只装 daemon，#285 和 #110 怎么处理 | 崩溃私聊依赖"机器人能直接给主人发私聊"，没核实 |

## 2026-10-14 第一版实验 e01、e02

`2026-10-14-v1-spikes/`，基于 `main` 的 `20d5fec`。`docs/v1-plan.md` 第 4 节的两个实验，在 JP-VPS 上用 Claude Agent SDK 0.3.296（自带 CLI 2.1.296）和 haiku 实测。每份末尾有另一个代理（Sonnet）对照原始日志的核实记录。

| 报告 | 内容 | 说明 |
|---|---|---|
| [e01-background-tasks](2026-10-14-v1-spikes/e01-background-tasks.md) | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 能不能让主回合等子 agent，后台 Bash 会怎样，关闭会话时后台任务会怎样 | 前台子 agent 跑着时按 ⏹ 还没测 |
| [e02-claude-permissions-sessions](2026-10-14-v1-spikes/e02-claude-permissions-sessions.md) | 三种模式下哪些请求走到 canUseTool，今天的 AskUserQuestion，拒绝，中途改档和 resume，子 agent 的 id，读别的工作目录下的会话，`claudeMdExcludes` | 没带沙箱，沙箱看 e03。第 7 节（claude.ai 连接器和 Claude Code 自己的工具）和第 8 节（会话标题）是顺带发现，没经过核实那一轮 |

## 2026-10-15 第一版实验 e05、e06、e07、e10、e11、e14

`2026-10-15-v1-spikes/`。`docs/v1-plan.md` 第 4 节的实验。e06 基于 `main` 的 `f1c2fb8`，在 owner 的 Mac 上经 Paseo 的检查会话实测；e05、e07、e10、e11 基于 `bfc01d7`，在 JP-VPS 上实测；e14 基于 `5a37103`，在 JP-VPS 上实测。这几份没有核实记录，用之前自己核对关键事实。

| 报告 | 内容 | 说明 |
|---|---|---|
| [e05-codex-session-config](2026-10-15-v1-spikes/e05-codex-session-config.md) | Codex 会话级的 `mcp_servers`、`runtimeWorkspaceRoots`、`skills/extraRoots/set` 和 memories 能不能用，resume 后还在不在，中途能否换 skill，`~/.codex/AGENTS.md` 能否按会话不加载，最低版本该定多少；顺带发现主人的 `codex_apps` 连接器挂在每条会话上，`thread/start` 会往用户的 `config.toml` 写信任记录 | 测了 0.139.0、0.148.0、0.156.1、0.162.1。第二个根真能写、根外被拒没测到：JP-VPS 上 bwrap 起不来，归 s39 的 Mac 检查 |
| [e06-launchagent-keychain](2026-10-15-v1-spikes/e06-launchagent-keychain.md) | LaunchAgent 起的 daemon 能不能用主人的 Claude 和 Codex 登录，读钥匙串会不会弹窗，`kill -9` 后多久拉起、退出码记在哪，"允许在后台"里显示什么，怎么判断重新登录过 | 没打包，用 worktree 里的 Electron 跑。owner 的凭据都在文件里，钥匙串那条路没验证到；重新登录的判断只查了资料 |
| [e07-bridge-lock](2026-10-15-v1-spikes/e07-bridge-lock.md) | v2 的 `acquireSingleInstanceLock` 写出 bridge 格式的锁，bridge 0.6.14 的同名函数抢不抢得到；持有者退出、startedAt+15s、同时抢锁；锁挡不挡得住 `run` 和 `start` | 只测了从发布包里切出来的锁函数，没跑 bridge 的 CLI。`run`、`start` 和多 bot 模式的表现是读代码得到的，真机在 e08 |
| [e10-feishu-platform](2026-10-15-v1-spikes/e10-feishu-platform.md) | 机器人能否自己进已有的群，`with_sender_name` 拿不拿得到名字，能否拉到别的 bot 卡片的正文，话题里的引用，私聊里的话题，断线期间的消息会不会补推 | "同时发送到群"和给没开过会话的人发私聊没测到，留给 owner。补推只有一个样本，daemon 自己能不能收到补推没测 |
| [e11-codex-thread-read](2026-10-15-v1-spikes/e11-codex-thread-read.md) | 另起一个 utility app-server 进程、不加载线程，能不能读到别的进程的线程；能否只拿用户消息和最终回答；正在跑、没跑过回合、旧格式、压缩过的线程读出来是什么样 | 只测了 JP-VPS 上的 CLI，没测子 agent 和很长的会话 |
| [e14-resume-same-session](2026-10-15-v1-spikes/e14-resume-same-session.md) | 用 `claude --resume` 和 `codex exec resume` 打开 bot 的会话，看到的和 bot 是否一样；两边都写会怎样；手动压缩后摘要里还留不留引用行 | 只在 JP-VPS 上测了终端，没测 Codex 桌面端；压缩只有一个样本；空闲回收后 Claude 接上哪一支是推测 |

## 2026-10-16 bot 自己的目录和工作区

`2026-10-16-bot-home/`。owner 提出"会话从 bot 自己的目录起，工作区作为关联目录，继承工作区的 skill 和 MCP"，这一轮查现状、两家 CLI 实际加载什么、comma 怎么做。基于 `main` 的 `6e28d23`；Claude Code 2.1.296 和 Codex 0.163.0 在 JP-VPS 上用假 API 实测，没登录、没花额度。结论：会话照旧从工作区起，owner 2026-10-16 同意（`docs/product.md` 3.3、3.6）。同一天第二轮（multi-workspace）：owner 又提出参考 Codex 的多工作区、方案要能接更多后端，查了 13 个后端，实测 Codex 0.163.0 和 Claude 2.1.296、2.1.301，基于 #349 分支的 `f7044ed`。owner 2026-10-16 选了 1A、2A，第 3 题按 A 做（owner 要求下一轮热生效）：bot 的文字当指令交，skill 和 MCP 打成能力包交，附加目录只给文件访问，设置改了下一轮生效（`docs/product.md` 3.6、第 11 节）。

| 报告 | 内容 | 说明 |
|---|---|---|
| [bot-home](2026-10-16-bot-home/bot-home.md) | vonvon 今天和定稿往哪里写文件、cwd 怎么选；两家从 cwd 和附加目录各加载什么（指令文件、skill、MCP、设置）；不写进工作区就能交给会话的办法；待定问题 | D4（Codex 会话层 `trust_level` 加不加载项目配置）已由 multi-workspace 实测：app-server 会话层传 `trusted` 会加载。B2、D9 说 Claude 的 append 快照"只对开了这项的账号生效"已过时，默认就开；D9 的 CLAUDE.md 重读也有了答案。见 multi-workspace 4.4 |
| [multi-workspace](2026-10-16-bot-home/multi-workspace.md) | 13 个后端一条会话能有几个目录、附加目录里加载什么、调用方能直接交什么；Codex 的主文件夹、`selectedCapabilityRoots`、多个环境、按路径的权限；Claude 2.1.296 以后的变化、从附加目录加载什么、交个性和 skill 的几种办法及恢复时的表现；每个后端一个适配的做法 | 没测：`selectedCapabilityRoots` 在 0.156.1 上、`never` 下能力包的 MCP 会不会被拒；`enabledPlugins` 能不能关掉插件；macOS 和 `:minimal` 读档下按路径的权限。Cursor、Kimi、Goose、OpenCode、DeepSeek Harness 多数只看了源码 |
| [comma-home](2026-10-16-bot-home/comma-home.md) | comma 的 agent 家目录、人设、记忆、skill、MCP 放在哪里，Claude Code 和 Codex 用什么 cwd 和参数起 | AGPL，只看思路。comma 用每个会话一个空目录当 cwd，不继承工作区的配置 |

## 2026-10-17 Codex 服务端请求

`2026-10-17-codex-requests/`，基于 `main` 的 `07ff9e4` 和当前仓库生成协议。s32 接线时补核对不同审批的否定回复，不重复 e05 的会话配置实验。

| 报告 | 内容 | 说明 |
|---|---|---|
| [negative-replies](2026-10-17-codex-requests/negative-replies.md) | 命令、文件、旧协议与权限配置审批的不同回复；问题答案如何回传 | 空权限子集的含义据官方文档推断；真实 Codex 拒绝后继续执行仍须 Mac 验证 |

## 2026-10-17 Rakazo 源码比较

`2026-10-17-rakazo/`。owner 提供 Rakazo 后，由三个 Astra 分析方向对照固定源码与 Vonvon `bbb329b`，主会话另执行 8 项纯源码检查。没有运行上游完整应用或改变已定产品范围。

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-17-rakazo/report.md) | 产品建议、M/s 顺序、可复用模块与许可边界 | 建议优先完整私聊/个性/记忆体验；调整依赖与新增范围仍需按主计划决策 |
| [architecture](2026-10-17-rakazo/architecture.md) | 消息、执行、停止、恢复和状态归属 | 中文架构解释，保留原生后端边界 |
| [product-ux](2026-10-17-rakazo/product-ux.md) | Astra 产品与聊天体验分析 | 源码分析附件，含首次体验与范围重考虑 |
| [runtime-state](2026-10-17-rakazo/runtime-state.md) | Astra 运行时与持久状态分析 | 不将数据库重放视为任意外部动作恰好执行一次 |
| [reuse-engineering](2026-10-17-rakazo/reuse-engineering.md) | Astra 模块复用、依赖与测试分析 | 区分小函数提取、适配与不采用 |
| [probes](2026-10-17-rakazo/probes.md) | 8 项实际源码检查与可重现程序 | 局部 helper 结果，不是产品或安全验收 |

本轮索引经独立 gpt-6-astra 核对；各报告末尾保留核实记录。

## 2026-10-18 飞书建群操作恢复

`2026-10-18-feishu-creation/`。s36c2c4 开工前核对官方建群去重合同，源码起点为 `main` 的 `fae1c32`。只读查文档、CLI schema 和安装的 SDK，没有创建真实飞书群。

| 报告 | 内容 | 说明 |
|---|---|---|
| [uuid-contract](2026-10-18-feishu-creation/uuid-contract.md) | 去重键、10 小时窗口、50 字符上限、未知结果的恢复边界和 SDK 请求行为 | 不承诺重复请求返回原群号；真实飞书验收仍待后续 |

## 2026-10-18 Rakazo 第二轮

`2026-10-18-rakazo-2/`。Rakazo 换到 `b884f43`，对照 Vonvon `main`（本文行号按 `d187d00` 重查）。七个子代理按专题读源码写深挖，一个代理综合出初稿，Fable 对初稿逐条做对抗审查；report 按审查后的结论写。只读源码，没有运行 Rakazo 的代码或测试，这一轮不搬文件，product.md 没改。深挖里说的"代码地图"和初稿没进仓库。

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-18-rakazo-2/report.md) | 纠正上一轮、现在改 main 的三条（s14e、s15f、s23d）、按切片的开工要点、待 owner 定的 4 条、复用和许可 | 以它为准；开工要点已写进 `docs/v1-plan.md` 各片说明 |
| [d1-team-chat](2026-10-18-rakazo-2/d1-team-chat.md) | Slack team-chat 和个人线路的接入、投递和失败处理 | 原始深挖，没有逐条复核 |
| [d2-judge-multibot](2026-10-18-rakazo-2/d2-judge-multibot.md) | 何时回复的判断器、多 bot 和跳数 | 同上 |
| [d3-tools-settings](2026-10-18-rakazo-2/d3-tools-settings.md) | 工具目录和自我设置（每回合给哪些工具、改指令、密钥） | 同上 |
| [d4-prompt-memory](2026-10-18-rakazo-2/d4-prompt-memory.md) | 指令拼装、防注入和记忆 | 同上 |
| [d5-conversations](2026-10-18-rakazo-2/d5-conversations.md) | 对话和线程管理（恢复、压缩、查历史） | 同上；"LICENSE 没有版权行"有误，见 report |
| [d6-models-sandbox](2026-10-18-rakazo-2/d6-models-sandbox.md) | 模型和沙箱的选择（模型目录、推理档位、读写范围） | 同上 |
| [d7-onboarding-testing](2026-10-18-rakazo-2/d7-onboarding-testing.md) | 首次体验、设置界面和测试验收方法 | 同上；许可一句同 d5 |
| [critique](2026-10-18-rakazo-2/critique.md) | 对初稿的对抗审查：逐条核对、删减、owner 问题从 8 条减到 4 条 | 审查的是初稿，不是 report；行号按当时的 `main` |

上一轮"没有外部聊天"的说法由本轮更正，上一轮的 report 和 product-ux 已加更正行。

## 2026-10-18 第一版实验 e12

`2026-10-18-e12-judge/`，基于 `main` 的 `d187d00`（含 s23a、s23b、s23c）。`docs/v1-plan.md` 第 4 节的 e12，在 JP-VPS 上用真实登录跑判断：Codex 0.163.0 的 gpt-6-luna（low）154 条，Claude CLI 2.1.296 的 haiku 137 条。没有核实记录，用之前自己核对关键事实。

| 报告 | 内容 | 说明 |
|---|---|---|
| [e12-judge-latency](2026-10-18-e12-judge/e12-judge-latency.md) | 两家判断的延迟分布（按变体和上下文条数）、冷启动、排队、token 和额度、Claude 那次额外调用的原因（CLI 自动起标题）和关法、判错的例子、内存，对 s25 的建议 | 在 JP-VPS 上量的，不是 product.md 3.4 写的 Mac；额度只有上界（精度 1 个百分点），没请 owner 看账户页面 |

## 2026-10-18 决策模型 Jev

`2026-10-18-jev/`，基于 `main` 的 `8e166a6`。owner 想让智能模式的判断用 TypeSafe 的 Jev，Claude 读了它的全部文档和条款，在 JP-VPS 上用 owner 给的测试 key 调了 116 次，和 e12 的订阅小模型比。实测脚本、原始数据和下载的文档留在 JP-VPS 本机，不进仓库，测试 key 也不进仓库。没有核实记录，用之前自己核对关键事实。

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-18-jev/report.md) | Jev 的接口、错误码、价格和数据条款；31 个用例判得对不对、把握度、延迟、一次问几个问题、并发和多个 bot、错误；怎么接进 `D/judge/`、要改的文件和行数、s25 要预留的三处、风险；问 owner 的 5 题 | owner 10-18 第 3 题选了不提示、第 4 题选了照现有的兜底，和报告建议不同，以 `docs/product.md` 3.4 为准；延迟只代表从日本连 Cloudflare 东京节点，Mac 和中国大陆没测 |

## 2026-10-18 补做审查：Codex 代班期间的 PR

`2026-10-18-codex-period-review/`，基于 `main` 的 `d187d00` 到 `c82fd22`。10-17 到 10-18 Codex 代班时合入的 #368 到 #385 只有同厂商的审查，Claude 接回后用另一家的模型补做了一遍，中级以上的发现再逐条对抗复核。report.md 是复核结论和排进哪一片，以它为准；r1 到 r7 是各份审查报告。

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-18-codex-period-review/report.md) | 7 条中级以上发现的复核结论、严重度调整、放进哪一片和行数 | R4-1 与 R6-1 是同一个缺陷，复核后定为高；R3-1 的代码出自 10-10 的预热池，不是 #377 |
| [r1-drain-reconnect](2026-10-18-codex-period-review/r1-drain-reconnect.md) | #368 子进程排空上限、#372 桌面在 daemon 崩溃后重新连接 | |
| [r2-crash-queue](2026-10-18-codex-period-review/r2-crash-queue.md) | #369 崩溃时保存排队消息、补发暂停私聊 | 没有发现 |
| [r3-codex-server-requests](2026-10-18-codex-period-review/r3-codex-server-requests.md) | #377 Codex 服务端请求的接线；空 `CODEX_HOME` 下预热和会话同时首启 | |
| [r4-registration-dirs](2026-10-18-codex-period-review/r4-registration-dirs.md) | #379 注册表单写入者、#381 bot 稳定目录和账本 | |
| [r5-registry-binding](2026-10-18-codex-period-review/r5-registry-binding.md) | #382、#383 项目表写入和目录准入 | |
| [r6-stable-dirs-journal](2026-10-18-codex-period-review/r6-stable-dirs-journal.md) | #384 群的稳定目录、#385 建群操作记录；给 s36d1 的提醒 | |
| [r7-product-clauses](2026-10-18-codex-period-review/r7-product-clauses.md) | #381 对 product.md 的六处改动逐处分类 | R7-1、R7-2 复核后降为低，处理写进 s27、s56a 的开工要点 |

## 2026-10-18 网页端打底审查

`2026-10-18-ui-foundation/`，基于 `main` 的 `2e2c161`。`docs/v1-plan.md` 第 1 节"界面分三段调"第一段的只读审查：隔离的临时 daemon 加假 Bot，Playwright 在 1280 和 390 两种宽度下截了 204 个场景，四个审查者各看一个角度（视觉、极端数据、流程、样式体系和叫法），Fable 抽查源码和截图后合成。截图留在 JP-VPS 本机，不进仓库。没改代码，没改 v1-plan；u 片表等 owner 挑完再加。

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-18-ui-foundation/report.md) | 去重后的 55 条问题（F01 到 F55）、建议的 u01 到 u10、叫法表草稿、要 owner 定的 11 件事（D1 到 D11）、带行为改动的条目（第 1 节 G）、留给最后一轮的 | v1-plan 记着的"会话方式叫法不一样"已核对为一致；死样式的行数以删前的 CSS coverage 为准 |

## 2026-10-19 第一版实验 e03、e04（Mac）

`2026-10-19-mac-spikes/`，基于 `main` 的 `84162db`。`docs/v1-plan.md` 第 4 节里要 macOS 沙箱的两个实验，在 owner 的 Mac 上由 Mac 上的 Codex 实测。Claude 用 Agent SDK 0.3.296（自带 CLI 2.1.296），Codex 用当前版本和最低版本 0.156.1。每份末尾有核实记录。

| 报告 | 内容 | 说明 |
|---|---|---|
| [e03](2026-10-19-mac-spikes/e03.md) | Claude 的只读、读写档换成 `default`、`acceptEdits` 加 macOS 沙箱以后，哪些请求走到 `canUseTool`；关网、开网有没有域名名单、WebFetch、WebSearch；加载和不加载用户设置的差别（没测成）；今天的 `bypassPermissions` 加沙箱能不能 `curl` 出去、写 `/tmp` | 已测。不加载用户设置的对照轮未登录，没测成；用户设置是 owner 的。今天关网档能 `curl` 出去的原因见 e04b |
| [e03b](2026-10-19-mac-spikes/e03b.md) | 只读档用 `denyRead` 加 `allowRead` 限读，bot 目录写不写得进；完全访问档下的 ask、deny 规则；读写档下各根里两家的配置文件挡不挡得住 | 已测。删除关键目录没实测，只读了代码；硬链接没建成 |
| [e04](2026-10-19-mac-spikes/e04.md) | Codex 的只读、读写、关网、完全访问下，会话的 shell 能不能连 127.0.0.1 的 TCP 和 Unix socket，环境变量传不传得进，同版本 Electron 能不能以 node 方式跑，`.git` 只读时能不能 `git commit`，第二个根能不能写 | 已测。打包版 app 没测，用替身；受限档 git 先卡在读 `.gitconfig`，没走到 `.git` |
| [e04b](2026-10-19-mac-spikes/e04b.md) | 同一个探针在 Claude 沙箱里：连本机、环境变量、Electron、git 提交、附加目录能不能写 | 已测。打包版 app 没测，用替身 |

## 补充

codex-desktop 报告写完以后，对照 openai/codex 源码又核实了一次。`codex mcp list` 里的 `cua_repl` 来自内置插件 `unified-computer-use@openai-bundled`，就是原生 Computer Use；显示为 disabled 的 `computer-use` 是旧通道。经 Paseo 调用时，Mac 锁屏会失败（getpaseo/paseo#3346），`full-access` 模式会自动批准打开应用。process 报告里的相关说法和这里一致。

## 2026-10-20 s65 本地 universal 分发

| 报告 | 内容 | 说明 |
|---|---|---|
| [local-distribution](2026-10-20-s65/local-distribution.md) | 签名 dmg/zip、13 个 Mach-O、5 份最窄权限、arm64/Rosetta 启动与本地更新模板 | 首次错误 target 作者停止及 Rosetta 首轮未就绪均保留；未公证/发布/安装 owner app |

## 2026-10-21 能力页与工具连接

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [capabilities-ux](2026-10-21-capabilities-ux/report.md) | 对照 Codex、Claude Code、OpenClaw、VS Code 官方文档，梳理 Skills 来源、工作区增删、CLI 安装授权和 MCP 管理 | 只读文档与源码；用户选择工作区优先；仅交互原型落地，未修改后端 |

## 2026-10-22 Provider 设计参考

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [provider-design](2026-10-22-provider-design/report.md) | HarnessRouter、Magpie 固定源码与 UI 参考；Provider 首次准备、日常管理及群模型范围 | 方案与独立交互设计稿，等待 owner 确认；未改实际应用 |

## 2026-10-23 工作目录权限

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-23-permissions/report.md) | 沿用 bridge 的三档在多 provider 下是否合理；owner 定的方向（透传各家原生设置、越界拒绝、不做外层沙箱）；Codex 在 Linux 上的实测 | 实测证实用户 `~/.codex/rules` 的 allow 规则能绕过沙箱（#486）；0.163.0 的权限 profile 在 Linux 上能挡读 |
| [native-codex-claude-gemini](2026-10-23-permissions/native-codex-claude-gemini.md)、[native-other-agents](2026-10-23-permissions/native-other-agents.md)、[hosts-and-sandboxes](2026-10-23-permissions/hosts-and-sandboxes.md) | 15 家 agent 的原生权限模型；ACP、Zed、Paseo 等宿主和外层沙箱的做法 | 子代理据文档和源码写成，没有核实记录，用前核对 |

## 2026-10-23 个性、记忆与项目

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [README](2026-10-23-memory-persona/README.md) | 十份调研：Today 等消费级产品、OpenClaw、Hermes、Letta/mem0/LangMem、编码 agent 的记忆机制、人设和作用域，以及 vonvon 当前实现（dev `9b113b6`）的存储、运行时和界面 | 子代理据源码和文档写成，没有独立核实记录，用前核对；结论落在 `docs/plans/memory-projects.md` |

## 2026-10-24 Designeer 与当前 App UI / UX

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-24-designeer-ui-ux/report.md)、[首批实施](2026-10-24-designeer-ui-ux/implementation.md) | 九项发现，首批实现紧凑模型 / Effort、权限摘要和群页头；Designeer 参考映射；修改与合入均基于 dev | 以当前 App b83acfa2 校正共同基线；432 项 UI 测试通过；网页以隔离演示数据对比，待 owner 验收，其余优化另批实施 |
| [公共组件统一](2026-10-24-designeer-ui-ux/component-foundation.md) | 概览/Bot/群组/设置公共组件、统一控件尺寸及 Libraries.dev 适用位置 | 444 项 UI 测试通过；网页尺寸、多行字段与任务 / Bot / 群聊操作状态绑定的 ThinkingOrb；owner 已要求合入 dev，跳过 CI 并重编译重启 App |
| [模型保存与 Provider 检测](2026-10-24-designeer-ui-ux/save-provider-fix.md) | 修复实时目录误标为 fallback、Claude unknown 未探测即隐藏和不可保存草稿；保留真实目录验证 | UI 460 项、daemon 定向回归及 typecheck 通过；App 实测另记 |

## 2026-10-24 判断规则编辑窗口

| 报告 | 内容 | 说明 |
|---|---|---|
| [rules-editor-height](2026-10-24-rules-editor-height/report.md) | 保留规则正文，默认短窗口、底部展开与收起 | 基于 dev 8a7dabe1；owner 已批准预览设计，实际实现待本地验收；未替换 App |

## 2026-10-24 导图直接编辑组件

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-24-mind-map-editor/report.md) | Mind Elixir、React Flow、SimpleMindMap 对图中编辑和固定结构节点的支持；当前角色与记忆编辑入口差异 | 官方文档与源码调研；后续按 owner 的包体要求沿用自写 HTML/SVG，未引入候选库 |

## 2026-10-25 导图库与画布性能

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-25-mind-map-library/report.md) | Mind Elixir 5.15.1 固定版本、实际包体测量、旧 renderer 闲置轮询的观察器开销与接入约束 | owner 允许引入库；旧版18节点实际测量，最终 UI/App 验收另记 |

## 2026-10-25 macOS App 体积

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-25-app-size/report.md) | 0.7.13 arm64 App 623.76 MB 构成；恢复 Claude 按需托管安装后 0.7.14 实测 365.22 MB、ZIP 156.54 MB | 基线 6f5589b7；签名包与隔离安装、更新、重启、卸载通过，owner 验收待做 |

## 2026-10-29 Windows Codex 权限

| 报告 | 内容 | 说明 |
| --- | --- | --- |
| [report](2026-10-29-windows-codex-permissions/report.md) | Windows 版本误报、MXC 能力探测、原生三档与 start/resume、portable PowerShell、多根路径 | 0.163.0 ARM64 原生与真实模型验证；缺失配置保护边界已实测，owner 要求仍开放可写；整体验收待 owner |

## 2026-10-30 发布提速

| 报告 | 内容 | 说明 |
|---|---|---|
| [report](2026-10-30-release-speed/report.md) | 提前下载、命令级系统代理、并行上传与候选绑定确认 | 小网络/异步实验与隔离回归；完整正式发布耗时待下一轮验证 |

## 2026-10-30 定时任务

`2026-10-30-scheduled-tasks/`。为定时任务（product.md 3.13，`docs/plans/scheduled-tasks.md`）做的调研：业界做法两个方向各一个调研代理、另一个代理逐条核对来源；代码笔记基于 dev `e87a49c4`，四个只读代理；Codex 和 Claude 的通路用隔离 HOME、假模型服务离线实测，没登录、没花钱。笔记是英文原文，和计划冲突时以计划为准。

| 报告 | 内容 | 说明 |
|---|---|---|
| [industry](2026-10-30-scheduled-tasks/industry.md) | ChatGPT、Gemini、Claude（桌面、Cowork、云端、/loop）、Codex、OpenClaw、Cursor、Manus、飞书 aily 的定时任务：创建、每次新会话还是同一会话、错过、管理和上限、无人时的权限、自己排；事件触发谁有、要不要云端、巡检成本；飞书长连接和别的 bot 消息能不能收到 | 本地和桌面版基本只做定时，事件触发都在云端；help.openai.com 403、Manus 文档 404，相关条目来自二手来源 |
| [notes-runner](2026-10-30-scheduled-tasks/notes-runner.md) | 调度器放在哪、睡眠后的计时、补跑算法、三种落点怎么接现有运行路径、停机和崩溃 | 计划审查后改过几处（钩子、落点、开话题），以计划为准 |
| [notes-tools](2026-10-30-scheduled-tasks/notes-tools.md) | 命令核和终端、工具登记表和钥匙、Codex app-server dynamicTools 在 0.156.1 和 0.163.0 上可用、关掉 Claude 自带定时 | 推翻 `docs/plans/s46.md` 4.1 的 E 项；真实 ChatGPT 登录下的工具表留给 T3 自测 |
| [notes-skill](2026-10-30-scheduled-tasks/notes-skill.md) | Codex `selectedCapabilityRoots` 和 Claude `plugins` 交付内置 skill 的 12 条实测：命名、按需加载、只读档要读入口、按会话关不掉、resume 行为、`enabledPlugins` | 回答 product.md 第 9 节第 22 项；macOS Seatbelt 没测 |
| [notes-ui](2026-10-30-scheduled-tasks/notes-ui.md) | 群详情页和 Bot 页的 tab、协议和 RPC、表单输入、文案和测试的现状 | 只读 |
