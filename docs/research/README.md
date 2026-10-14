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

这批报告没有核实记录，用之前自己核对关键事实。critique 是另一个代理对 draft 的评审，final 已按它改过。final 是给主人确认的定稿候选，里面的 8 个决策问题还没有答，主人的回答写进 `docs/product.md`。

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
| [draft](2026-10-14-v1-definition/draft.md) | 第一版产品定义和流程的初稿，已被 final 取代 |
| [critique](2026-10-14-v1-definition/critique.md) | 对 draft 的评审，逐条标了严重程度 |
| [final](2026-10-14-v1-definition/final.md) | 第一版产品定义与流程提案（定稿候选）：范围、bot 模型、上下文、群聊回复、里程碑、8 个决策问题和 20 条默认选择。流程部分同上 |
| [owner-updates](2026-10-14-v1-definition/owner-updates.md) | 调研进行中主人的 5 次决定，其中两次附了接近原话的记录。之后的决定以 `AGENTS.md` 和 `docs/product.md` 为准 |

## 2026-10-14 判断模型

`2026-10-14-decision-models/`。主人提到的"OpenAI Decisions API，或者 Jev"，用来做智能回复和智能会话的前置判断。

| 报告 | 内容 | 说明 |
|---|---|---|
| [decision-models](2026-10-14-decision-models/decision-models.md) | 两个判断模型的接口、价格、速度、认证，以及用在 vonvon-bot 上要注意的地方 | 更正 v1-definition 里 group-response 和 final"没找到 Jev"的说法 |

## 补充

codex-desktop 报告写完以后，对照 openai/codex 源码又核实了一次。`codex mcp list` 里的 `cua_repl` 来自内置插件 `unified-computer-use@openai-bundled`，就是原生 Computer Use；显示为 disabled 的 `computer-use` 是旧通道。经 Paseo 调用时，Mac 锁屏会失败（getpaseo/paseo#3346），`full-access` 模式会自动批准打开应用。process 报告里的相关说法和这里一致。
