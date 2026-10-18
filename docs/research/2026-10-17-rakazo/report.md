# Rakazo 对 Vonvon 产品与实现的启发

> 更正（2026-10-18）：Rakazo 接外部聊天。e55263f 就有 Slack 频道的 team-chat，另有一条个人线路接 iMessage/SMS、Slack、WhatsApp、Telegram 和飞书私聊；它的判断器只判 Slack 里没点名的消息，默认关，部署可换模型；bot 之间的跳数只限链的深度。本文对比表和附件 product-ux 里相关的说法以第二轮为准，见 [../2026-10-18-rakazo-2/report.md](../2026-10-18-rakazo-2/report.md)。

2026-10-17，按 owner 提供的项目做源码研究。三个分析方向均由 `gpt-6-astra` 执行，Codex 主会话核对源码、运行小范围检查并汇总。本报告提出调整建议，尚未修改产品范围、切片依赖或产品代码。

最值得采用的是它把 bot 做成可持续相处的同事：第一次就能做事，个性和记忆可以查看、纠正，工作进展保持安静，修改和交接都有记录。Vonvon 的定稿已经包含其中许多设计，但集中在尚未完成的 M7–M9。当前最大的改进机会是交付顺序和验收体验。

推荐保留飞书入口和原生 Codex/Claude 会话，先完成必要基础，再尽早交付一条完整的“认识你的 bot”体验。代码复用以小模块和故障场景为主。Rakazo 的 Pi 运行时、数据库任务系统和整套聊天前端不适合整体搬入。

## 研究对象与证据范围

| 对象 | 固定版本与用途 |
|---|---|
| Rakazo | [`e55263f5fdfee9b2c48680a78e4487d37b4c04a8`](https://github.com/elie222/rakazo/tree/e55263f5fdfee9b2c48680a78e4487d37b4c04a8)，本地 `/home/operator/vonvon/references/rakazo`，只读研究 checkout |
| Vonvon | `bbb329b9a9eef0dd809ee9468e0b6d1b9bf4a769`，已合入 s36c2a，比较依据为此版本的 [product.md](../../product.md) 和 [v1-plan.md](../../v1-plan.md) |
| Astra 产品分析 | [product-ux.md](product-ux.md)，聊天体验、记忆、设置、交接、首次使用和范围调整 |
| Astra 运行时分析 | [runtime-state.md](runtime-state.md)，消息、执行、取消、恢复、记忆、子 agent 与隔离 |
| Astra 复用分析 | [reuse-engineering.md](reuse-engineering.md)，模块依赖、适配成本、测试和不能照搬的行为 |
| 架构解释 | [architecture.md](architecture.md)，两边端到端执行路径与状态归属 |
| 实际运行证据 | [probes.md](probes.md)，8 项小范围源码检查及可重现程序 |

Rakazo 的 [README](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/README.md) 自称 Grok Bot 替代品。[VISION.md](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/VISION.md) 描述持久 bot、持续对话和安静的界面。代码中确有设置变更、记忆、同伴消息和例行任务的实现路径；这足以支持产品方向比较，不能证明与 Grok 功能等价或线上体验优劣。本轮没有运行 Grok。

已阅读的静态截图用于理解布局，没有作为当前版本的运行证明。没有安装 Rakazo 依赖、运行 Docker/服务、登录第三方、调用付费模型或操作 owner 的飞书、桌面与数据。真实 Claude 调用继续遵守停用期限，本轮没有消费 Claude 配额。

## 两个产品相近，但执行边界不同

| 方面 | Rakazo 源码中的做法 | Vonvon 已定的边界与借鉴方式 |
|---|---|---|
| 主要交互 | 自有 Web、桌面和移动聊天；bot 有持续可见的对话 | 飞书群、话题和私聊；桌面负责管理。借鉴连续的 bot 身份，保留按位置区分的会话 |
| 推理与工具 | Pi 管理工具循环，应用管理运行状态；也有 model OAuth 支持 | 原生 Codex app-server 和 Claude SDK 会话。订阅登录能力和原生权限不能被另一套循环替换 |
| 持久执行 | Postgres、Graphile、运行租约、事件序号和效果记录协作 | 本地 daemon、原生历史、配置和运行协调。重启后的人工提示与恢复规则不能暗中变成自动重放 |
| 记忆 | 带修订和来源的数据库文档，bot/user 等范围 | 文件形式的公共、群、个人私聊记忆；agent 可写指定文件，daemon 核对与合并 |
| 组内协作 | 自有空间和群成员、同伴消息与群内交接 | 飞书结构化 @、智能判断、三轮上限。群成员权限和多人的隐私边界更具体 |
| 首次体验 | 聊天内给一个可选的首个方向，已开始聊天就不打扰 | 先验证本地 provider、飞书注册与服务就绪；之后应更快让人体验 bot 能做什么 |

Rakazo 的 model OAuth 路径见 [`model-oauth.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/core/src/model-oauth.ts)。因此，差异应表述为“谁拥有原生会话与工具循环”，不能简化成“对方只能用 API key”。

## 产品上最值得调整的地方

### 让第一件有用的事更早出现

建议优先交付一个完整故事：已经获授权的主人打开 bot 私聊，交给它一件小任务，看到结果，中途可以停止或补充，下次回来个性和个人记忆仍然正确。随后用聊天修改个性，收到生效时间和撤销入口。

这条路径会比继续增加设置页面更直接地体现产品价值。Rakazo 的首个方向提示会核对线程状态、避免重复，并跳过已发言的用户，见 [`onboarding.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/api/src/onboarding.ts#L99-L161)。Vonvon 可以借鉴这种克制，但不能用一句欢迎语替代 provider、飞书和服务就绪检查。

现有 s49 依赖 s37、s36、s38、s40 和 e10；s40 又依赖 s39、s31。s37 的 Mac 实验 e04 也必须完成。把 s49 直接移到下一步会绕过隔离、记忆和权限的前置条件。建议比较两种安排：

| 安排 | 得到的体验 | 代价与判断 |
|---|---|---|
| 先完成必需 M7 链，再把完整 s49 提到与其无关的 M8 工作之前 | 首次私聊即有真实的个性、个人记忆与连续性 | 推荐。仍有集成成本与 Mac 验证，不删依赖，不提供临时假记忆 |
| 显式拆出暂不含持久个人记忆的基础私聊预览 | 更早试一次任务、停止与结果交付 | 需要 owner 接受阶段性范围；会增加迁移和解释成本。界面不得暗示已会长期记忆 |

这里建议改变开发顺序，不是认定研究已经批准了新依赖图。现有 [v1-plan.md](../../v1-plan.md) 保持有效。

### 用变更回执建立信任

“已记住”“已改好”应来自落盘结果。回执写明改了哪个 bot、哪个群或哪个人的哪一份内容，显示改前改后、生效时间和版本。撤销必须指向已提交版本，并检查后续修改，不能覆盖其他会话的新内容。

Rakazo 的自身指令修改确有事务、旧值核对与 undo 版本，见 [`executor.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/adapters/src/executor.ts#L6361-L6412)。Vonvon 的 s40、s54–56 已承诺类似能力，值得以这份实现作为审查参照。采用回执和撤销；是否要求先审批，继续按 Vonvon 的管理员私聊授权规则处理。

建议把 s54 的“个性、规矩修改”与 skill/MCP 全目录拆分评估。先有一个可信、能力有限的设置命令，可能比等待所有库和安装能力完成更早形成完整体验。它仍依赖 s46/s47 的会话令牌与 daemon 鉴权，不能让模型自己判断谁有权限。

### 让进展简洁，异常和交接清楚

Rakazo 显示近期工具步骤，完成后折叠，省略部分保留计数，见 [`ToolActivityDisclosure.tsx`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/components/ToolActivityDisclosure.tsx#L1-L135)。Vonvon 已有折叠过程面板和有序事件模型，继续扩展即可。

s35 已写明每个子 agent 显示最近五步，沿用这一数量。每个子 agent 要有稳定身份、运行状态和单独停止入口；失败不能随父任务完成而消失。当前父过程卡预算优先保留前面的条目，若要改成近期窗口，应单独定义终态与错误保留规则。

同伴 bot 与临时子 agent 分开呈现。Rakazo 的 [`bot-messages.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/adapters/src/bot-messages.ts#L65-L175) 记录接收者、投递标识和跳数。Vonvon s27 应让人看得见“交给了谁、是否送达、在哪里接着看”，仍只传最终回答，遵守飞书 @ 和三轮上限。s34/s35 则展示同一次原生任务内的临时助手。

### 把记忆做成可检查的事实

Rakazo 的知识页支持查看、编辑和导出，写入记录来源和修订；注入上下文时有字节预算，见 [`KnowledgeSection.tsx`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/apps/web/src/pages/KnowledgeSection.tsx#L98-L205) 与 [`memory-context.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/adapters/src/memory-context.ts#L1-L77)。

Vonvon 应在 s38–42 落实来源、范围、版本、下一轮生效和可恢复编辑。公共、群、个人记忆继续分别授权；个性/规矩与记忆事实保留各自的指令层级。清空对话和删除长期记忆应始终是两件明确的事。无需为借鉴这些体验引入向量库或把文件记忆改成数据库。

### 让成果交付比“我做完了”更可信

Rakazo 的附件路径读取真实文件、检查大小与 MIME、存入成果存储后才返回成果标识，见 [`executor.ts`](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/packages/adapters/src/executor.ts#L5252-L5295)。这证明了存储/发布路径，不证明生成内容正确或 HTML 已打开检查。

Vonvon 已有文件引用识别、内联交付控件和表格输出。可在这些路径补清楚标题、说明与交付结果，把“文件已生成”“已发到飞书”“已打开检查”区分开。可搜索、有版本的成果库属于单独的产品增量，不应塞进记忆切片。

## 范围值得重新考虑，但优先级较低

| 想法 | 用户价值 | 实际成本与建议 |
|---|---|---|
| 可选本地聊天 | 不等飞书注册就试任务，结果可在桌面侧展开 | 要定义本地身份、记忆范围、历史与飞书 DM 的关系，并重复验收停止、提问和附件。先比较本地首任务原型与优化后的飞书首次使用流程；目前不加入 v1 |
| 定时/例行任务 | “每天在这里报一次”更像持续工作的同事 | 本地 Mac 可能睡眠，要定执行机器、漏跑补偿、时区、取消与权限。当前明确排除于 v1，若重新考虑，先做一个可暂停的信息任务 |
| 成果库与 HTML 预览 | 找回、比较、打开 bot 做出的东西 | 涉及授权、版本和清理；HTML 需要 iframe/WebView 隔离，CSP 只是其中一层。先完善已有飞书文件交付 |
| 聊天创建 bot/连接器市场 | 更快扩充能力 | 飞书应用身份、平台授权和当前产品承诺不同。不能把 Rakazo 内部 bot 创建当成飞书应用创建，也不引入其连接器后端 |

这些是 owner 可以评估的具体产品选择。推荐先做完整私聊与记忆，再决定是否增加第二个聊天入口和定时任务。

## 实现上怎样复用

下表区分代码提取候选、设计适配和暂不采用。候选不等于已决定移植；每次提取还需按实际调用者核对语义、许可和行为。

| 源码 | 判断 | Vonvon 落点与关键条件 |
|---|---|---|
| `packages/core/src/approval-effect-key.ts` | 可提取规范 JSON 和去重键的小函数，需适配 | M7 s36c2c 的 daemon 自管建群/绑定操作。必须同时有稳定操作号、持久结果和未知结果恢复；哈希本身不能保证只执行一次 |
| `packages/core/src/async.ts` | 有具体调用者时可直接提取 | 延时取消后会正常返回，不会抛错；后续动作仍须检查取消。当前未证明 Vonvon 有需要它修复的 bug，不加闲置工具 |
| `packages/core/src/answerable-ask.ts` | 只借 ID/标签解析和显示 | M6 s33。继续以 Vonvon 的 FIFO、request/turn/actor 和当前卡片为准；不能按“最新可见问题”重新决定权限 |
| `apps/web/src/lib/tool-activity-view.ts` | 小型展示函数可适配 | s35 的步数、耗时和折叠显示。使用 Vonvon 事件模型与中文文案 |
| `packages/adapters/src/memory-context.ts` | 借格式、来源和 UTF-8 字节截断 | s38/s40。该文件仅通过注入的 MemoryStore 读取，没有直接 Prisma 依赖；适配类型与范围选择，保留我们的公共/群/个人隔离和原生 profile 规则 |
| `packages/testkit/src/model-emulator.ts` | 借场景结构和完成断言 | s31–35。扩展已有假 CLI/JSON-RPC 场景，贯穿真实 transport、coordinator、reducer 和假卡片出口；不用 Pi 测试替代原生协议测试 |
| setup store 的有界/no-follow 读取 | 借边界做法，不当成完整安全读取器 | s38/s40 还要求拒绝硬链接、校验归属、保留隔离证据、处理并发写和撤销。上游单独一段代码未覆盖全部要求 |
| `packages/core/src/message-visibility.ts` | 借“隐藏过程仍保留待处理输入” | s33/s35。它过滤整行消息，既不是内容脱敏器，也不是授权检查 |
| `packages/core/src/artifact-sandbox.ts` | 未来 HTML 预览的参考 | 当前 v1 无对应功能。调用端必须有独立隔离与导航策略，不可只粘贴 CSP |

完整依赖和反例见 [复用分析](reuse-engineering.md)。不要通过包入口引入整个 `@rakazo/core`，它还有图表、cron、Markdown 等依赖；按实际需要提取小文件，并保留来源。

几处具体的不适配已经核实：

- `group-mentions.ts` 的 `@everyone` 会选中全部成员，无点名时回落到第一个 bot。Vonvon 的飞书 @所有人有不同规则；继续信任平台结构化身份和本地仲裁。
- `events.ts` 的一处句末检测使用英文 `. ! ?`，不能直接承担中文 `。！？` 的分段。现有卡片 reducer、pacing 与原生事件身份继续保留。
- Rakazo 文件记忆的名字容易造成误解，追踪到的 MarkdownMemoryStore 是数据库文档实现；不能替代我们的 agent 直接写文件、daemon 合并协议。
- 桌面 adapter 的 host `spawn`、`shell:false` 和 cwd/env 设置不构成操作系统沙箱，不能用于证明读写档和关网。
- Postgres 事务、租约和 fence 可约束遵守协议的数据库写入；不能被翻译成任意外部 Bash/Git 操作的安全自动重放。
- 大型 Shell/executor 与我们已有的长消息处理器都提示要控制模块大小。不要通过移植继续扩大 `handle-message.ts`。

## 对现有 M/s 的具体建议

下列顺序是本轮研究建议，尚未替换主计划。M5 的真实 Claude 待验仍保留，M6 卡片与 M7 权限的真实 Mac/飞书验收继续按原门槛执行。

| 顺序 | 工作 | 与现状的关系 | 做到什么才算成立 |
|---|---|---|---|
| 1 | 完成 s36c2b/c2c/d、s37 的必要基础与 Mac 实验，同时推进不冲突的 M6 s33–35 | 已有 s36a/c1/c2a，尚未有完整目录分配/执行继承；s29/30/32 已合入 | 跨进程、取消、丢 ACK 和身份变化有证据；真实 Mac 权限满足承诺 |
| 2 | s38/s39/s40，以个性和个人记忆为完整 DM 的前置链 | 未完成。采用来源、修订、注入预算和故障场景；维持现定文件写入协议 | A 群内容不进 B 群；多人/话题并发不静默覆盖；写失败不声称记住；下一轮更新可见 |
| 3 | 评估完整 s49 提前，并交付“第一件事”的验收故事 | 需要调整排序，不能删除 s36/s37/s38/s40/e10 依赖 | 真实飞书的首次任务、停止、回访与个人记忆均通过；两家后端分开记录 |
| 4 | 拆分评估 s46/s47 → s54 的个性/规矩 → s56 对应回执 | 范围/依赖调整提案；原 s54 还依赖 s43/s44，s56 还依赖 s55，必须明确重切而非偷跳 | daemon 校验 actor/session；前后值、版本、生效时间可读；旧回执撤销不覆盖新修改 |
| 5 | s41/s42 的记忆/覆盖编辑与恢复入口；s48 的原生历史读取 | 已在范围内。保留桌面/CLI 恢复能力，不要求所有操作只能聊天 | 脏草稿、冲突、分页/会话归属和压缩后历史均有明确行为 |
| 后续 | 可选本地聊天、例行任务、成果库 | 新范围选择，暂不实施 | 有具体需求与验收边界，再调整产品定义 |

当前进度不能因研究建议而增加完成数：M6 是 3/7 个切片已合入，M7 只有 s36a/c1/c2a 三个基础叶子完成，s36 总项仍未完成，M9 仍未开始。

## 许可与实际移植边界

固定提交的根 [LICENSE](https://github.com/elie222/rakazo/blob/e55263f5fdfee9b2c48680a78e4487d37b4c04a8/LICENSE) 是 Apache-2.0，所查 package manifests 也声明此许可。对根项目源码，这支持在闭源产品中复制和修改，但分发时须满足许可条款。保留许可、适用版权/归属说明，标明修改；如果提取范围带 NOTICE，按条款处理。Apache 许可不授予对方商标使用权。依据为 [Apache License 2.0 第 2、4、6 节](https://www.apache.org/licenses/LICENSE-2.0)。

本轮做了根许可与有限源码声明检查，没有完成所有依赖、图片、字体、第三方服务条款的清查。因此建议借代码时逐文件记录上游路径和提交号，分别核对依赖；不复制其品牌与截图素材。本轮没有移植产品代码，也没有把整个上游仓库加入本项目 Git。

## 实际核对结果与仍待验证的事

主会话使用 Node 24 直接导入经过阅读的三个纯源码文件，运行 [8 项检查](probes.md)，全部通过。可迁移程序再次在固定提交运行通过。它们证明群点名、规范 JSON/操作次数和待答问题选择的局部行为，没有证明数据库恢复、真实投递或模型质量。

三名 Astra 分别审查产品、运行状态与工程复用，结论相互对照。报告将工具说明、代码路径、历史测试记录与实际执行分开。上游历史资格报告中的失败或 token 数，不作为当前提交失败率或本项目节省比例。没有测速，没有可报告的开发加速倍数、token 节省比例或线上可靠性数字。

下一步落地时最有价值的验证是两条真实路径：一条从私聊首次任务到回访记忆；另一条从设置修改到下一轮生效、冲突与撤销。它们须在 Vonvon 中通过，Rakazo 的实现或截图不能代替这份验收。

## 核实记录

核实记录（2026-10-17）：独立 gpt-6-astra 按固定 Rakazo/Vonvon 源码抽查了首次使用、指令回执、记忆范围、执行认领、权限边界及 M/s 依赖，并独立复跑本文链接的八项源码探针，全部通过。已修正 memory-context 的依赖归属：它通过注入 MemoryStore 读取，本身无直接 Prisma 依赖。排序与新范围仍为提案，未修改产品计划；此核实不等于运行上游产品或真实 provider/飞书/Mac 验收。
