# 调研记录

这里存放 vonvon-bot 做过的调研，以后遇到同一个问题时先来这里查，不用再调研一遍。仓库目前闭源，主人决定以后再考虑要不要开源，所以这些记录可以引用内部数据。将来如果开源，要先清理这个目录。

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
| [decision-models](2026-10-14-decision-models/decision-models.md) | 两个判断模型的接口、价格、速度、认证，以及用在 vonvon-bot 上要注意的地方 | 更正 v1-definition 里 group-response、draft 和 final"没找到 Jev"的说法 |

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

`2026-10-16-bot-home/`。owner 提出"会话从 bot 自己的目录起，工作区作为关联目录，继承工作区的 skill 和 MCP"，这一轮查现状、两家 CLI 实际加载什么、comma 怎么做。基于 `main` 的 `6e28d23`；Claude Code 2.1.296 和 Codex 0.163.0 在 JP-VPS 上用假 API 实测，没登录、没花额度。结论：会话照旧从工作区起，owner 2026-10-16 同意（`docs/product.md` 3.3、3.6）。同一天第二轮（multi-workspace）：owner 又提出参考 Codex 的多工作区、方案要能接更多后端，查了 13 个后端，实测 Codex 0.163.0 和 Claude 2.1.296、2.1.301，基于 #349 分支的 `f7044ed`。owner 2026-10-16 选了 1A、2A、3A：bot 的文字当指令交，skill 和 MCP 打成能力包交，附加目录只给文件访问，设置改了下一轮生效（`docs/product.md` 3.6、第 11 节）。

| 报告 | 内容 | 说明 |
|---|---|---|
| [bot-home](2026-10-16-bot-home/bot-home.md) | vonvon 今天和定稿往哪里写文件、cwd 怎么选；两家从 cwd 和附加目录各加载什么（指令文件、skill、MCP、设置）；不写进工作区就能交给会话的办法；待定问题 | D4（Codex 会话层 `trust_level` 加不加载项目配置）已由 multi-workspace 实测：app-server 会话层传 `trusted` 会加载。B2、D9 说 Claude 的 append 快照"只对开了这项的账号生效"已过时，默认就开；D9 的 CLAUDE.md 重读也有了答案。见 multi-workspace 4.4 |
| [multi-workspace](2026-10-16-bot-home/multi-workspace.md) | 13 个后端一条会话能有几个目录、附加目录里加载什么、调用方能直接交什么；Codex 的主文件夹、`selectedCapabilityRoots`、多个环境、按路径的权限；Claude 2.1.296 以后的变化、从附加目录加载什么、交个性和 skill 的几种办法及恢复时的表现；每个后端一个适配的做法 | 没测：`selectedCapabilityRoots` 在 0.156.1 上、`never` 下能力包的 MCP 会不会被拒；`enabledPlugins` 能不能关掉插件；macOS 和 `:minimal` 读档下按路径的权限。Cursor、Kimi、Goose、OpenCode、DeepSeek Harness 多数只看了源码 |
| [comma-home](2026-10-16-bot-home/comma-home.md) | comma 的 agent 家目录、人设、记忆、skill、MCP 放在哪里，Claude Code 和 Codex 用什么 cwd 和参数起 | AGPL，只看思路。comma 用每个会话一个空目录当 cwd，不继承工作区的配置 |

## 补充

codex-desktop 报告写完以后，对照 openai/codex 源码又核实了一次。`codex mcp list` 里的 `cua_repl` 来自内置插件 `unified-computer-use@openai-bundled`，就是原生 Computer Use；显示为 disabled 的 `computer-use` 是旧通道。经 Paseo 调用时，Mac 锁屏会失败（getpaseo/paseo#3346），`full-access` 模式会自动批准打开应用。process 报告里的相关说法和这里一致。
