> 原始深挖，没有逐条复核；和 report.md 冲突时以 report.md 为准。

# 工具目录和自我设置

Rakazo 固定在 b884f43（`<home>/vonvon/references/rakazo-b884f43`），对照 vonvon-bot main 898d3c5。Rakazo 路径都相对它的仓库根，写成 `路径:行号`。我们的代码写 `packages/...:行号`，规格写 `docs/product.md:行号` 或切片号。

标注：【确认】是读源码确认的，【推断】是从代码推出来、没有运行验证的。整轮只读：没有运行 Rakazo 的任何代码，没装依赖，没联网，没改 vonvon-bot。

## 0. 结论

1. **差别的根在哪里。** Rakazo 自己管工具循环：63 个内置工具加 3 个跨用户连接工具，按回合过滤后交给 Pi，每个调用在 `executor.ts` 里分派（`packages/adapters/src/executor.ts:5053-6720`），审批也在那里做。我们的"工具"是原生 Codex/Claude 会话里的 Bash 调 `vonvon settings` 和 `vonvon feishu` 命令。权限由 daemon 在一个入口按令牌、私聊、触发人和开关判断（`docs/product.md:447-452`，s46）。所以 Rakazo 的工具 schema、审批表和 Pi 的执行模式都搬不过来。能借的是三类：结果怎么告诉模型发生了什么，版本怎么比，回执里写什么。
2. **Rakazo 的自我设置门槛不统一。** 只有改指令要审批、记改前改后、带撤销（`packages/db/src/bot-instructions.ts:53-111`）。`update_bot` 直接写库，没有撤销（`executor.ts:6507-6589`）。`remember` 每次整篇覆盖 `MEMORY.md`，不比版本（`executor.ts:5539-5551`），旧版本只写不读，界面找不回来。在 Slack 或 iMessage 触发的回合里，改指令被挡住了，但改资料、写共享记忆、建 skill、建 bot、建定时任务都不挡。我们的规格在这些地方更严，不要往回学。
3. **最值得采纳的四条：**
   - **agent 带着它看到的版本来改。** Rakazo 的 `save_shared_memory` 在工具里现读 revision 再提交，挡不住模型读到内容以后别人的修改（测试 `executor-readonly-approval.test.ts:525-540` 也只测了这个毫秒级窗口）。我们 `runSettingsSet` 用的是同一个模式（`packages/daemon/src/cli/commands/settings.ts:160-171`）。我们又没有审批兜底，所以 s47/s56a 的 agent 路径要带 `--revision`，不在 `set` 里现读。我们的 revision 本来就是内容哈希（`packages/daemon/src/admin/settings.ts:19-21`），实现成本很小。
   - **`--json` 下错误也输出 JSON。** 写明结果种类：冲突、拒绝、无权、结果不明；冲突时带上当前内容；还要写回执卡有没有发出去。Rakazo 每个工具都回结构化结果，用 `uncertain`、`note`、`next_step` 告诉模型用户实际看到了什么。我们的命令行今天把错误写成中文纯文本打到 stderr（`packages/daemon/src/cli/index.ts:178`），agent 分不清该重试、停下，还是先去核对。
   - **回执写明"为什么改"。** 写上 daemon 记录的触发消息摘录，再写 agent 自己给的理由。这对 `docs/product.md:518` 说的注入风险是一层便宜的缓解：用户一眼就能看出这次改动和自己说的话对不上。
   - **daemon 按会话把设置命令排成一队。** db4a0b2 只把 schedule 三个工具改成顺序执行，因为模型同一回合里并发调用 create 和 list 时，list 会读到旧状态。我们这边 Codex 也会并行跑工具。
4. **不复用代码。** 能独立拿出来的只有 `instructionUpdateDiff`（10 行）和 `writeBotInstructions`（约 60 行）。前者不是真 diff，后者绑在 Prisma 的行锁上，照思路自己写更省事。万一要复制，按 `packages/daemon/src/server/atomic-file.ts:1-2` 和根 `NOTICE` 的先例标来源，见第 8 节。

## 1. 纠正上一轮

| 上一轮的说法 | 实际情况 |
|---|---|
| 上一轮的交接笔记（本机，不在仓库） §2、`product-ux.md:112` 都说 Rakazo 没有外部 IM，或者没下结论 | 【确认】e55263f 就有 Slack 的 team-chat 接入（`apps/api/src/team-chat-bridge.ts`），还有接 iMessage/SMS、Slack、WhatsApp、Telegram 和飞书私聊的个人线路（`packages/adapters/src/messaging-platforms.ts:82-198`，飞书 `capabilities: { direct: true, groups: false }` 在 `:169-186`）。Slack 还有第三个身份：Composio/Pipedream 连接器（`apps/api/src/onboarding.ts:37-64`）。这一节和工具目录有关的一点：team-chat 回合的 trigger 是 `messaging`（`apps/api/src/team-chat-bridge.ts:1333`），源块是 text，不是 `channel_message`，所以不算"频道运行"（`executor.ts:3571-3581`），拿到的是**完整**的内置工具集，见发现 15 |
| 交接笔记 §2 "工具"一行写"改自身指令（需审批，保存改前改后，带 undo 版本）"，读起来像 Rakazo 的设置修改都这样 | 【确认】只有 `propose_instructions_update` 这样。`update_bot` 直接 `prisma.bot.update`，回包只有新值，没有改前、版本和撤销（`executor.ts:6551-6588`）。`skill_create/update/delete`、`save_shared_memory`、`add_mcp_server`（登记那一步）都不在任何审批名单里，默认放行（`packages/core/src/action-approval.ts:3-40,96-106`） |
| 交接笔记 §2 "记忆"一行写"有 revision，记录来源"，§5 第 5 问是"expectedRevision 冲突时用户看到什么" | 【确认】`remember` 不带 expectedRevision，把 `args.content` 整篇写进 `MEMORY.md`（`executor.ts:5539-5551`；`packages/memory/src/index.ts:72-120` 是替换，不是追加）。工具说明只有一句"Store a durable fact"（`packages/adapters/src/builtin-tools.ts:531-542`），没说会覆盖。`MemoryRevision` 只写不读：整个仓库除了写入的地方，没有任何代码读它；记忆的 RPC 只有 list、update、exportMarkdown（`apps/api/src/router.ts:3229-3306`），所以界面上找不回被盖掉的旧内容。人在 Knowledge 页编辑记忆，也不带 expectedRevision（`router.ts:3258-3272`） |
| 交接笔记 §5 第 3 问把 `builtin-tools.ts:755` 叫作"能力清单" | 【确认】那是 `task_catalog`（b884f43 在 `:757-763`）。它是只读清单，列待办、定时任务、教过的 skill、可用的 skill 和本回合暴露的工具（`packages/adapters/src/task-catalog.ts:31-96`），**不列 bot 自己的哪些设置能改**。Rakazo 里 agent 知道"能改什么"，靠的是工具在不在本回合的列表里，加上各工具说明里的字段清单，见第 5 节 |
| `product-ux.md:59` 写 attach_file "checks size and MIME" | 【确认】MIME 只按扩展名推（`packages/core/src/attachments.ts:191-206`，`executor.ts:5294-5295`），不看内容。大小用 `readFile` 的 `maxBytes` 限制（`executor.ts:5288-5290`） |
| 上一轮引的行号（`builtin-tools.ts:310`、`:1038`，`executor.ts:6361-6412`） | 在 e55263f 上是对的，到 b884f43 偏移了 4 到 25 行：`attach_file` 在 `:311-324`，`propose_instructions_update` 在 `:1042-1055`，执行在 `executor.ts:6387-6438` |

## 2. 工具目录（b884f43）

### 2.1 分族

定义在 `packages/adapters/src/builtin-tools.ts:148-1194`，共 63 个；跨用户连接的 3 个在 `:1197-1243`。名单另抄一份在 `packages/contracts/src/builtin-tools.ts:4-71`，用来校验 bot 的禁用列表，由测试保证两边一致（`packages/adapters/src/index.test.ts:174-178`）。【确认】

| 族 | 工具（行号） | 审批类别（`action-approval.ts`） |
|---|---|---|
| 媒体 | generate_image `:150`、generate_video `:161` | 要审批（`:27-29`） |
| 电脑和页面 | computer_observe `:174`、computer_act `:180`、browser_navigate/snapshot/act `:232-278`、open_path `:339`、launch_app `:349`、shell `:326` | 免审批（`:3-16`） |
| 文件 | list_files、read_file、write_file `:280-310`，attach_file `:311-324` | 前三个免审批；attach_file 不在任何名单，默认放行 |
| 和人交互 | ask_user `:372`、message_user `:391`、request_takeover `:362` | 默认放行 / 免审批 |
| 凭据 | request_secret `:412`、list_secrets `:424`、secret_request `:430`、forget_secret `:436` | request_secret 免审批，后两个要审批（`:33-34`） |
| 记忆 | remember `:532`、save_shared_memory `:544`；语义记忆 save/recall/forget_memory `:717-756` | remember 免审批；forget_memory 要审批（`:35`）；其余默认放行 |
| 检索 | web_search `:557`、web_fetch `:574`、search_history `:656`、read_history `:682` | 只读 |
| 工作清单 | task_catalog `:758`、scratchpad_* `:765-831`、board_tickets/ticket_* `:833-908` | 只读或默认放行 |
| 定时 | schedule_create/list/cancel `:910-930` | 免审批（`:22-24`） |
| skill | skill_read/create/update/delete `:951-1013` | 默认放行 |
| 能力扩展 | add_mcp_server `:482-530`、render_plot `:442` | add_mcp_server 默认放行，但"挂到自己身上"要另一张 `mcp_approval` 卡（`executor.ts:5935-5948`） |
| 自我设置 | propose_instructions_update `:1043-1055`、update_bot `:1098-1137` | 改指令**只能人工批**，不能自动审，也不能"一直允许"（`:40,108-111`）；update_bot 默认放行 |
| 建和删 | create_space `:1057`、spawn_bot `:1074`、archive_bot `:1139` | create_space 只能人工批；spawn_bot 免审批；archive_bot 要审批 |
| 子 agent 和别的 bot | run_subagent `:1015`、message_bot `:1156`、handoff_to_bot `:1178` | run_subagent 免审批，其余默认放行 |
| 其他 | cloud_agent_* `:591-654`（要审批）、end_call `:932` | — |

另外两道门【确认】：
- webhook 触发的回合只能用 `UNATTENDED_SAFE_BUILTIN_TOOLS` 里的只读工具，别的一律要人批（`action-approval.ts:42-58,113-124`）。
- 改指令只认 user、routine、follow_up、call_end 四种 trigger（`packages/db/src/bot-instructions.ts:13-16`）。follow_up 还要求源消息是用户发的（`executor.ts:4511-4521`）。所以 Slack/iMessage 的 `messaging` 回合和 bot 之间的 `bot_message` 回合都改不了指令。**其他自我设置工具没有这道门。**

### 2.2 每回合给哪些工具

`selectBuiltinToolsForRun`（`executor.ts:8046-8112`）按这些条件筛：
- 有没有图形界面；
- 在不在群里（handoff 只给群，message_bot 只给非群，`schedule-tools.ts:24-37`）；
- trigger：routine 不能再建定时任务（`schedule-tools.ts:16-21`），后台回合去掉对外发消息的工具；
- 有没有语义记忆（有就把 remember 换成 save/recall/forget，`memory-tools.ts:5-12`）；
- 媒体、看板、语音、历史检索的开关；
- 是不是个人线路的频道运行（是就去掉记忆、scratchpad、ticket）；
- bot 的禁用名单 `disabledBuiltinTools`。

系统提示里每个工具的用法说明也只在工具被提供时出现：`offeredBuiltinClause`（`executor.ts:8328-8334`），各条在 `:8390-8424`。【确认】

## 3. 结果和错误的形状

【确认】工具结果都是 JSON 对象，只有三种：
- 成功：`{ ok: true, ...具体 id 和新值 }`。比如 update_bot 回新的名字、标题、简介、头像和通知开关（`executor.ts:6580-6588`）；add_mcp_server 回 `server_id`、`assigned_to_self:false` 和一句 `next_step`，说明还要等用户批（`:5965-5974`）。
- 失败：`{ error: "可以照着改的英文句子" }`。错误会点名字段，或者列出可选项，比如 update_bot 的"Provide at least one of name, title, …"（`:7840-7844`），schedule 的各种时间错误（`schedule-tools.ts:80-178`）。
- 结果不明：`{ error, uncertain: true }`，并且明说"没有重放，先去核对目标"（`approval-effect.ts:387-391`）。

另外两种补充信号【确认】：
- `note`：message_user 没发出去或被截断时，结果里写明"用户没看到"或"只看到截断版"（`executor.ts:6598-6602,6614-6621`；`user-progress.ts:49-53` 的注释写明要把截断告诉模型，不能报成功）。
- 统一的重试规矩：同样的参数失败了不再原样重试，只改一次具体字段，再失败就停下说明（`task-catalog.ts:28`）。另有一个硬保护：同一工具同一参数连续 6 次，判定卡住并停下（`tool-loop.ts:21-33`）。

对照我们：`want()` 认得 `refused`、`outcomeUnknown`、`activationPending`（`packages/daemon/src/cli/daemon-client.ts:111-118`），protocol 的保存结果分 saved、conflict（带 `current`）、rejected（带 `fields`）、unavailable（`packages/protocol/src/settings.ts:415-427`），种类其实比 Rakazo 全。问题出在命令行这一层：`--json` 只管成功输出，错误统一变成 `Error` 的中文文字，打到 stderr，退出码 1（`daemon-client.ts:7-8`，`settings.ts:173-175`，`index.ts:178`）。冲突时 protocol 回来的 `current` 也被丢掉了，只说"重新运行一次"。见发现 3。

## 4. 自我设置的几条写路径

| 写什么 | 怎么写 | 版本和冲突 | 回执 | 撤销 | 谁能触发 |
|---|---|---|---|---|---|
| 指令（`propose_instructions_update`） | 先占位：每个 bot 同时只能有一个待定提议（`bot-instructions.ts:30-50`）；人点"应用"后，在同一个事务里锁线程、核对运行仍在、写指令、写回执消息（`executor.ts:6391-6430`） | 提议时记下当前全文 `previousInstructions`（`executor.ts:4534-4541`），提交时全文比对，不同就报"Instructions changed"（`bot-instructions.ts:70-74`）；内容没变时不写，也不出回执（`:86-93`） | 审批卡显示理由、全部旧行加 `-`、全部新行加 `+`（`approval-ask.ts:14-34`，`instruction-diff.ts:2-10`）；人可以先改再批（`AskCard.tsx:171-191`）。批完的回执只有"Instructions updated · Undo"（`AskCard.tsx:105-134`） | 只撤最新一次：当前内容必须等于这张回执的 after，并且这张回执是历史第一条（`bot-instructions.ts:67-79`）；撤销本身也记一版（reason "Restore"）；最多留 20 版（`:104`） | user、routine、follow_up、call_end；凭据出现在文本里就拒写（`executor.ts:4529-4533`） |
| 资料（`update_bot`：名字、标题、简介、头像、完成通知） | 校验长度后直接写库（`executor.ts:6507-6589`，`parseUpdateBotPatch` 在 `:7825-7870`） | 无 | 只有工具结果和一条 `bot.updated` 事件 | 无 | 任何 trigger |
| bot 记忆（`remember`） | 整篇写进 `MEMORY.md` 或指定路径（`executor.ts:5539-5551`） | 无 | `{ok:true}` | 无（历史只写不读） | 任何非频道运行 |
| 共享记忆（`save_shared_memory`） | 整篇替换，单篇最多 4000 字（`builtin-tools.ts:1246-1256`） | 工具内部现读 revision 再提交（`executor.ts:5557-5572`） | `{ok, path, revision}` | 无 | 任何非频道运行 |
| skill（`skill_*`） | 用户级，所有 bot 共用 | — | 工具结果 | 无 | 任何 trigger |
| MCP（`add_mcp_server`） | 先登记，再出 `mcp_approval` 卡，人批了才挂到 bot 上（`executor.ts:5860-5975`）；远端地址先做 SSRF 检查（`:5868-5882`） | 同名报唯一冲突 | `next_step` | — | 任何 trigger |

agent **改不了**的【确认】：模型、电脑模式、禁用工具名单、审批规则、team-chat 的监听规则、记忆 provider。这些只在网页设置里改（`apps/api/src/router.ts:1113-1574` 和各 Overlay）。

## 5. agent 怎么知道"现在能改什么"

Rakazo 没有一张"设置能力表"，靠的是四件事【确认】：
1. **工具在不在本回合的列表里**（第 2.2 节），说明也只在提供时出现。
2. **工具说明里列字段**：update_bot 的说明列出能改的 5 项（`builtin-tools.ts:1098-1100`），没给参数时，错误里再列一遍（`executor.ts:7840-7844`）。
3. **"没调工具不许说改好了"**，在说明和系统提示里反复写：update_bot（`:1100`）、create_space（`executor.ts:8393`）、通用的"Prefer tools over claiming you already did the work"（`:8425`）、定时任务"建完 list 一下，在列表里才算成功"（`task-catalog.ts:27`）。
4. **`task_catalog` 当"真相来源"**：列出本回合暴露的工具和 `readOnly` 标记（`task-catalog.ts:59-70`）。

我们已有的：
- 设置视图每一节带 `access`（可写，或只读加原因和一句话，`packages/protocol/src/settings.ts:98-105`）和 `apply`（改了什么时候生效，`:106-128`）。
- 命令行出错时列出可改的节和项（`settings.ts:42,78`）。
- 设置 skill 只装在私聊里（`docs/product.md:394,451`），各入口只列已交付的命令（`docs/v1-plan.md:936`）。

缺的是：
- `access` 不知道调用的是哪条会话、哪个人。私聊开关关了、这一节不允许在聊天里改，`get` 都看不出来。
- skill 还没写"拿到 `saved` 才说改好了"。

见发现 13、14。

## 6. db4a0b2：schedule 工具同一回合顺序执行

【确认】Pi 默认把一回合里的多个工具调用并发执行。模型同时发 `schedule_create` 和 `schedule_list` 时，list 可能先读到没有新任务的表，bot 就会说"没有定时任务"。修法是给三个 schedule 工具标 `executionMode: "sequential"`（`packages/adapters/src/pi-runtime.ts:1061-1065`）。注释说，一批里只要有一个顺序工具，Pi 就把整批按顺序跑；测试在 `pi-runtime-tool-dispatch.test.ts:783`。

【确认】只有 `SCHEDULE_TOOL_NAMES`（`schedule-tools.ts:14`）这三个。scratchpad_add 加 scratchpad_list、ticket_create 加 board_tickets、skill_create 加 task_catalog 这些"写完就读"的组合仍然并发。【推断】它们有同样的竞态，只是还没人报。

对我们的含义见发现 11。

## 7. 逐条发现

### 发现 1：工具按回合暴露，说明只在提供时出现——我们已有

- **Rakazo**：`selectBuiltinToolsForRun`（`executor.ts:8046-8112`）、`offeredBuiltinClause`（`:8328-8334,8390-8424`）。
- **我们**：设置 skill 只在私聊装，开关关掉就不装；飞书 skill 每个会话都装（`docs/product.md:394,451-453`）。各入口只列已交付命令，不把令牌拼进提示词（`docs/v1-plan.md:936`）。谁能改由 daemon 在调用时判断（`docs/product.md:447`）。
- **差别**：Rakazo 按十来个条件逐个工具筛。我们按位置决定装不装整个 skill，再由 daemon 拦每一次调用。原生会话的工具列表不归我们管，按 skill 粒度做是对的。
- **建议**：不改。

### 发现 2：名单只有一份来源，由测试保证——采纳思路

- **Rakazo**：`BUILTIN_TOOL_NAMES`（`contracts/src/builtin-tools.ts:4-71`）和实际工具列表由 `index.test.ts:174-178` 比对，少一个多一个都会挂。
- **我们**：命令能接受哪些节和项，单一来源是 protocol 的 `agentSectionSchemas` 等（`packages/protocol/src/settings.ts:37-`），由 `parseAssignments` 校验（`settings.ts:56-93`）。设置 skill 的 SKILL.md（s54a）和飞书 skill（s48）是手写文字，以后会和命令漂开。
- **建议**：s54a 加一个测试，从设置 skill 的 SKILL.md 里抽出所有 `vonvon settings set …` 示例，逐条用 `parseAssignments` 解析，必须通过。再反过来查：可在聊天里改的每一节，skill 里都要出现，不在聊天里改的节一节都不出现。s48 对飞书 skill 做同样的检查。约 40 行测试。
- **切片**：s54a、s48。

### 发现 3：`--json` 下的错误也要结构化——采纳思路

- **Rakazo**：结果只有 `ok`、`error`、`error+uncertain` 三种，另有 `note` 和 `next_step`（第 3 节）。重试规矩写在指引里（`task-catalog.ts:28`）。
- **我们**：成功走 `print`，输出一行 JSON（`daemon-client.ts:149-152`）；错误全部是中文纯文本，打到 stderr，退出码 1（`index.ts:172-182`）。conflict 回来的 `current` 被丢掉（`settings.ts:173`）。
- **差别**：agent 拿到退出码 1 和一段中文，分不清三种情况：版本冲突（重读后再试一次）、无权或开关关了（停下说明）、结果不明（先 `get` 核对，不要重发）。
- **建议**：s47 让 agent 路径和 `--json` 下的错误输出一行 JSON，格式如 `{"ok":false,"kind":"conflict|rejected|refused|unavailable|outcomeUnknown|connection","message":"…","fields":[…],"current":{…}}`，按种类给不同的退出码，例如 2 是冲突、3 是无权、4 是结果不明。成功时再加一项 `receipt`（`posted`、`failed` 或 `pending`）。回执卡没发出去时，agent 可以照实说"已改好，回执卡没发出，撤销请到桌面端"，这是 `docs/product.md:450`"回执发送失败与设置失败分开记录"在 agent 那一侧的落点。这个格式和传输方式无关，e04 不通、改走 MCP 时（`docs/v1-plan.md:937`）照用。设置 skill 里写重试规矩：冲突就重读一次再改，无权就停下，结果不明就先核对。
- **工作量**：约 120 行，在 `packages/daemon/src/cli/daemon-client.ts`、`commands/settings.ts`、`index.ts`，加测试。
- **切片**：s47（格式），s54a（skill 里的规矩）。

### 发现 4：agent 要带着它看到的版本来改——采纳思路（最重要）

- **Rakazo**：
  - `save_shared_memory` 在处理函数里先读 revision 再按它提交（`executor.ts:5557-5572`），只挡住这几毫秒里的并发。模型做决定时看到的是回合开始时注入的内容，标题里明明写着 revision（`memory-context.ts:42`），工具却不收这个 revision。测试名"does not overwrite shared memory that changed after it was read"里的 "read"，指的是处理函数自己的读（`executor-readonly-approval.test.ts:525-540`）。
  - 改指令要好一些：提议时记下全文，提交时比对，期间还有人看差异审批（`bot-instructions.ts:70-74`）。
- **我们**：`runSettingsSet` 先 `readView` 取 revision，紧接着 `save`（`settings.ts:163-170`），和 Rakazo 的毛病一模一样。今天的设置都是字段补丁，影响不大。s56a/s54a 要加 SOUL、AGENTS、SMART 和公共记忆的整段文字：agent 回合开始时拿到旧版本，主人在桌面端改了一版，agent 再整段写回，桌面端那版就被悄悄盖掉。我们又不加审批（`docs/product.md:450`），没有人看差异兜底。
- **建议**：
  - s47 的 agent 路径中，`set` 接受 `--revision <从 get --json 拿到的值>`。整段文字字段**必须**带，不带就拒绝，提示"先 get 看当前内容"。
  - 在 `set` 里不再现读。没带 revision 时，退一步用 daemon 记下的"这条会话已经拿到的版本"：s38 本来就要为"设置更新"记这个版本（`docs/product.md:422`），也不用 `set` 那一刻现读的版本。
  - 我们的 revision 是节内容的 sha256（`packages/daemon/src/admin/settings.ts:19-21,169-172`），agent 拿着旧哈希来，就等于在比对它看到的内容。
  - 冲突时按发现 3 把 `current` 交给 agent。
  - 终端里人用的路径可以保持现状，因为人输的是字段补丁。
- **工作量**：约 60 行，在 `commands/settings.ts`、`daemon-client.ts`，加 s56a writer 的校验和测试。
- **切片**：s47、s56a、s54a。
- **对规格**：这是把 s56a"daemon 校验权限和当前版本"（`docs/v1-plan.md:960`）落实到"当前版本"该从哪来，不改承诺。

### 发现 5：记忆整篇被盖掉——我们的回执要把删除写出来（采纳思路）

- **Rakazo**：`remember` 整篇覆盖，没有版本，说明也没讲（第 1 节）。【推断】模型照"存一条事实"的字面意思调一次，就会把之前的 `MEMORY.md` 清掉，界面还找不回来。没有运行验证模型实际会不会这样调。
- **我们**：s40 让 agent 用原生编辑工具直接改记忆文件，daemon 在一轮前后比对，按行三方合并（`docs/product.md:360-377`）。agent 看得到原文，比 Rakazo 安全；可它照样能用 Write 整份重写。卡片只写了"已记到本群记忆：…［撤销］"（`docs/product.md:354`），删除怎么显示没定。
- **建议**：
  - s40 的卡片分开列出"加了"和"删了"。这一轮删掉的行超过原来的一半，或者整份重写时，卡片上单独写一行"这次删掉了 N 行，原有内容大部分被替换"，旁边就是［撤销］。
  - 第一层约定加一句"改记忆用编辑，不要整份重写"。
  - 撤销已经能把内容拿回来，这条只是让人注意到。
- **工作量**：约 30 行卡片渲染，加一句提示词。
- **切片**：s40、s38（提示词）。
- **对规格**：要改 `docs/product.md:354` 的卡片文案，算回执承诺变得更清楚。

### 发现 6：指令写入器的细节——我们已有

- **Rakazo**：全文比对；内容没变就不写、不出回执；每个 bot 同时只有一个待定提议；只能撤最新一次，而且当前内容要等于回执里的 after；撤销本身也记一版；最多留 20 版（第 4 节表格，`bot-instructions.ts:30-111`，`AskCard.tsx:105-134`，`router.ts:1787-1807`）。
- **我们**：s56a 已经写了"daemon 校验权限和当前版本；重复请求不重写、旧回执不覆盖新改动"（`docs/v1-plan.md:960`），`docs/product.md:450` 也写了"撤销核对当前版本和操作人的权限"。
- **建议**：照 s56a 做，可以把 Rakazo 这段当审查参照。"只撤最新""撤销也记一版""版本留有上限"三个细节，s56a 开工时直接写进验收。代码绑在 Prisma 的 `FOR UPDATE` 上，我们是文件加原子 rename，不复制。

### 发现 7：文字里带凭据就拒写——采纳思路（小）

- **Rakazo**：把指令和理由各脱敏一遍，有变化就说明里面有凭据，拒绝"Instruction proposals cannot contain credentials."（`executor.ts:4529-4533`）。
- **我们**：聊天里不收 key（`docs/product.md:444`），但 SOUL、AGENTS、SMART 和记忆的文字没有检查。会话令牌（s46）或 bot 的 App Secret 一旦被写进 SOUL，以后每条会话的提示词里都有它。
- **建议**：s56a 的 writer 写文字前查一遍：含有本 bot 的 App Secret、任何活着的会话令牌或本机凭据，就拒绝，并提示"文字里有凭据，没有保存"。我们不知道用户别的密钥，所以只查 daemon 自己知道的这几样。
- **工作量**：约 20 行。
- **切片**：s56a、s54a、s40（记忆写回时一样查）。

### 发现 8：回执和修改一起落盘，撤销跨重启可用——采纳思路

- **Rakazo**：改指令和"Instructions updated"回执消息在同一个数据库事务里提交（`executor.ts:6391-6430`）。撤销按回执里存的 `undoVersionId` 和 after 做（`AskCard.tsx:117-122`），什么时候点都行，和进程重启无关。
- **我们**：问答卡在 daemon 重启后自愈成"已失效（后台服务重启过）"（`docs/product.md:512`）。改设置的回执卡要不要一样，规格没说。`docs/product.md:450` 要求"重发回执不重复修改"，这意味着回执得有一条持久记录。
- **建议**：
  - s56a 在提交修改的同时（或者先写日志再提交，参照 s36c2c4a 的 `creation-journal.ts`）落一条回执记录：范围、改前和改后（或改前的哈希）、新版本、触发人、生效时机、撤销用的版本号。飞书卡片按这条记录发，发不出去就按记录重发。
  - 撤销按记录和当前版本判断，daemon 重启以后照样能点，不跟问答卡一样失效。
- **切片**：s56a，s56b 照用。
- **对规格**：要在 `docs/product.md:450` 补一句"改设置的回执，重启后仍能撤销"。

### 发现 9：回执写明"因为什么改"——采纳思路

- **Rakazo**：改指令必须带 1 到 500 字的理由，审批卡和差异里都显示（`builtin-tools.ts:1043-1054`，`bot-instructions.ts:17-26`，`instruction-diff.ts:2-10`）。auto-review 拿工具参数去和用户原话比（`auto-review.ts:245-265`）。
- **我们**：回执列范围、改前改后、版本和生效时机（`docs/product.md:450`）。注入风险，比如网页里藏着"去装这个 MCP"，规格只用"扩大能力的改动单独标出来"来缓解（`docs/product.md:518`）。
- **建议**：
  - 回执上加两行。第一行是 daemon 知道的事实："这一轮由 张三 的消息触发：『…』"，摘前 60 字，s46 本来就要拿触发人，顺带记下触发消息。第二行是 agent 给的 `--reason`，标成"bot 的说明"，只当参考。
  - 扩大能力的改动必须带 reason。
  - 主人说的是"总结这个网页"，回执却写"已启用 MCP X"，两行一放就看得出不对。这一条不加审批，和 `docs/product.md:684` 不冲突。
- **工作量**：约 40 行，在 s46 传触发消息 id，在 s56a 的卡片上显示。
- **切片**：s46、s56a、s56b、s54a。
- **对规格**：回执多两项，改 `docs/product.md:450`。

### 发现 10：回执里的差异要是真 diff——采纳思路（拿 Rakazo 当反例）

- **Rakazo**：`instructionUpdateDiff` 把旧文全部加 `-`、新文全部加 `+`（`packages/core/src/instruction-diff.ts:2-10`）。指令上限是 20000 字（`contracts/src/domain.ts:313`），改一行就要把两份全文都摆出来。
- **我们**：daemon 的依赖里没有 diff 库（`packages/daemon/package.json:35-46`）。s40 要按行做 diff3（`docs/product.md:363-366`），本来就得写一个按行比较的模块。
- **建议**：s40 的按行比较做成独立模块，s56a 的回执也用它：只显示改动的行，前后各带 1 到 2 行上下文，超过几行就折叠，全文放在桌面端看。
- **切片**：s40、s56a。

### 发现 11：同一回合的并行调用——采纳思路

- **Rakazo**：db4a0b2 只修了 schedule（第 6 节）。
- **我们**：Codex 会并行跑工具（`docs/research/2026-10-14-session-approval-service/approval-ux.md:294`）。同一回合里两次并行的 `vonvon settings set` 改同一节时，两个都先读到旧 revision，后一个保存就会冲突，命令行说"这项设置刚在别处改过"（`settings.ts:173`）。可冲突其实是它自己造成的，这句提示会误导 agent。改不同节时，会连着出两张回执卡。
- **建议**：
  - s46 的入口按会话把设置命令排成一队，先到先处理，同一条会话的命令不并发。
  - `set --json` 已经回提交后的整节（`settings.ts:177`），skill 里写"set 的输出就是结果，不用再 get；要 get 等 set 返回再发"。
  - 一回合连改几项要不要合成一张回执卡，s54a 开工时定。飞书对一个群里所有 bot 有每秒 5 条的共用限额（`docs/product.md:522`）。
- **工作量**：约 30 行。
- **切片**：s46、s54a。
- **置信度**：中。Claude 会不会并行跑两个改东西的 Bash，没查证。

### 发现 12：没有人触发的回合不能改设置——采纳思路

- **Rakazo**：改指令按 trigger 白名单放行；follow_up 要核对源消息是用户发的；webhook 回合只给只读工具（第 2.1 节）。
- **我们**：daemon 按"这一轮是谁的消息触发的"判断（`docs/product.md:447`），s46 依次校验令牌、私聊、触发人和开关。令牌按会话发，触发人按回合定，这两者要对上。
- **建议**：s46 写清这几种情况一律拒绝：
  - 这条会话当前没有在跑的回合，比如上一轮留下的后台进程在两轮之间调命令；
  - 当前回合不是由人的消息触发的，比如恢复后续跑的一轮、压缩引出的一轮、只附了"设置更新"的一轮；
  - 当前回合的触发人已经不是主人或管理员，比如中途被移除了管理员。

  验收加一条：第 N 轮起的后台进程，在第 N 轮结束后调 `settings set`，被拒。
- **工作量**：约 30 行。
- **切片**：s46。
- **置信度**：中。Codex 能不能让进程跨轮活着是推断。

### 发现 13：让 `get --json` 就是能力表——采纳思路

- **Rakazo**：见第 5 节，靠工具在不在、字段清单、"别空口说改好了"和 task_catalog。
- **我们**：每节已经有 `access` 和 `apply`。只读的原因今天只有 preview、owner-offline、unsupported-host、stale（`packages/protocol/src/settings.ts:98-105`），都和调用方无关。
- **建议**：
  - s47 的 agent 路径按调用方算 `access`，新增 `not-dm`、`chat-settings-off`、`not-authorized`、`desktop-only`（不在 3.7"能改"里的节）四种原因，message 里写去哪里改。
  - 输出顶层加一段 `caller`，含会话种类、触发人身份、开关状态。
  - skill 写明：先看 `access`；没拿到 `kind:"saved"` 不说已改好；`apply` 写着下一条会话才生效的，照实告诉用户。不另做 task_catalog 那样的工具。
- **工作量**：约 60 行，在 protocol 和 `packages/daemon/src/admin/settings.ts`。
- **切片**：s47、s54a。

### 发现 14：3.7 的"能改"和命令行已有的节对不上——采纳思路，要 owner 定

- **Rakazo**：聊天里能改资料和"跑完通知我"（update_bot 的 `notifyOnFinish`，`builtin-tools.ts:1131-1134`），模型、电脑模式和禁用工具只在网页改（第 4 节）。
- **我们**：3.7 的"能改"列了个性、规矩、智能提示词、判断模型、记忆、名单、工作区、会话方式、权限档和网络、建群拉人（`docs/product.md:444`）。命令行已经支持、3.7 却没提的有：卡片显示 `cards`、完成提醒 `completion`、运行设置 `run`、评论 `comments`、标题 `titles`、路径 `paths`、允许的群 `access.allowedChats`，群层的主模型 `model.selection` 和插话排队（`packages/protocol/src/settings.ts:37-62`）。3.2 又把"后端、模型""运行中来了消息"列为 bot 设置（`docs/product.md:74-77`）。s54a 的 skill 写不写它们，规格没定。
- **建议**：在 3.7 写清楚。
  - 建议能在聊天里改的：完成提醒、卡片显示、插话或排队、主模型。都是用户看得到的、可撤销的。
  - 建议只在桌面端改的：允许的群（相当于扩大谁能用 bot）、路径、运行并发、评论、标题。
  - 只在桌面端改的，`access` 回 `desktop-only`（发现 13）。
- **切片**：s54a、s55。
- **对规格**：改 `docs/product.md:444` 的表。

### 发现 15：Rakazo 的门槛按工具各写各的，漏了——我们已有，当反面例子

- **Rakazo**【确认】：
  - trigger 白名单只套在改指令上（`bot-instructions.ts:13-16`）。
  - team-chat 回合的 trigger 是 `messaging`（`team-chat-bridge.ts:1333`），不算频道运行（`executor.ts:3571-3581`），拿到完整工具集（`:8099-8110` 只对频道运行去掉记忆类工具）。
  - spawn_bot、schedule_* 免审批（`action-approval.ts:3-25`），update_bot、skill_*、save_shared_memory 不在任何名单，默认放行（`:96-106`）。

  【推断】所以在 Slack 里能触发网关 bot 的人，可以让它改名、往所有 bot 共用的共享记忆里写东西、建 skill、建 bot、建定时任务。没运行验证，审批规则表里如果配了"要审批"会拦住一部分。
- **我们**：设置命令只在私聊，daemon 在一个入口对所有设置命令统一校验（`docs/product.md:446-452`，s46）。
- **建议**：不改。写 s46 时守住一条：校验放在入口，不要散到各个命令里。新加的设置命令自动受同一道门管，不靠每个命令记得自己检查。

### 发现 16：审批和自动审核——不采纳

- **Rakazo**：
  - 改指令和建 space 只能人工批（`action-approval.ts:40,108-111`）；
  - MCP 挂到 bot 上要人点 `mcp_approval`（`executor.ts:5935-5948`）；
  - 别的有后果的操作可以交给 LLM 自动审核，审核说"ask"就转人工，出错时有后果的操作按"要人批"处理（`auto-review.ts:245-265`，`action-approval.ts:224-251`）。
- **我们**：越权直接拒绝，不发卡请人批准（`docs/product.md:684`）；不做 agent 自己审批（`:685`、`:740`）；聊天改设置不新增审批层（`:450`）。
- **理由**：owner 已经定了。值得记一笔：Rakazo 把人工审批**恰好**留在能力扩展和自身指令上，说明 `docs/product.md:518` 的残余风险是真问题。我们用发现 9 的触发消息摘录，加上已有的"扩大能力单独标出、带撤销"来缓解，不加审批。

### 发现 17：attach_file、message_user、定时、建 bot 等工具族——不采纳或我们已有

- **attach_file**（`executor.ts:5278-5322`）：读文件，按扩展名推 MIME，存进成果库，发消息，同名就算新版本。我们有自己的文件交付：扫描回答里的文件引用，点了才发，发前核对 inode、mtime 和权限档（`packages/daemon/src/bot/outbound-files.ts:18-60`）。成果库和版本放在 `docs/product.md:738`（v1 之后）。我们已有。
- **message_user**（`executor.ts:6590-6623`，每轮最多 3 条，开跑 60 秒后才发，`user-progress.ts:8-25`）：我们的运行卡是流式的，用不上这个工具。它"把用户实际看到什么告诉模型"的做法，已经并进发现 3。
- **schedule/routine**：第一版不做定时（`docs/product.md:677,737`）。db4a0b2 的教训已经并进发现 11。
- **spawn_bot、archive_bot、create_space、cloud_agent、看板和 scratchpad**：聊天里不建 bot（`docs/product.md:675`），其余超出 v1。上一轮已经否决过 spawn_bot，这里不重复建议。

### 发现 18：名单写入从严、读取从宽——采纳思路（小）

- **Rakazo**：禁用名单写入时，不认识的名字直接报错（`contracts/src/builtin-tools.ts:92-106`）；读取时忽略不认识的名字（`:82-90`）。工具改名或删掉以后，旧数据不会让 bot 起不来。
- **我们**：库里删掉 skill 或 MCP 时，"列出还在用它的 bot"（`docs/product.md:382`），删了以后名单里会留下悬空的名字。
- **建议**：s45/s56b 照这个规矩做。写名单时不认识的名字直接拒绝，并列出可选的；生成能力包时跳过悬空的名字，在 Bot 页和群详情页标"已从库里删除"，不报错。
- **工作量**：约 20 行。
- **切片**：s45、s56b。

## 8. 代码复用和许可

结论：**不复用代码**。

| 候选 | 行数 | 依赖 | 为什么不复制 |
|---|---|---|---|
| `packages/core/src/instruction-diff.ts` | 10 | 无 | 不是真 diff（发现 10） |
| `packages/db/src/bot-instructions.ts` 的 `writeBotInstructions` | 约 60 | Prisma 事务和行锁、`@rakazo/contracts` | 我们是文件加原子 rename，按发现 6 的几条规矩自己写 |
| `packages/adapters/src/task-catalog.ts` | 97 | Prisma 和三个 Rakazo 仓储 | 用 `access` 代替（发现 13） |
| `packages/core/src/action-approval.ts` | 约 270 | `@rakazo/contracts` | 我们不做审批 |
| `packages/contracts/src/builtin-tools.ts:82-106` | 25 | zod | 十几行的规矩，自己写更快 |

万一以后要复制（Apache-2.0，根 `LICENSE:166` 写着 "Copyright 2026 Rakazo contributors"，仓库里没有 NOTICE）：
1. 文件头照 `packages/daemon/src/server/atomic-file.ts:1-2` 写两行：`// Adapted from elie222/rakazo <路径> at b884f43.` 和 `// Copyright 2026 Rakazo contributors. Licensed under Apache-2.0; see NOTICE.`
2. 在根 `NOTICE` 加一段，写明哪些文件改编自哪个提交。
3. 加 `packages/daemon/LICENSE.rakazo`，放 Apache-2.0 全文。
4. 在改动处标出改过的地方（Apache-2.0 第 4 节 b）。

## 9. 没查的

- b884f43 的 `automated-messages.ts`（给 Rakazo 自己以 user 角色插进去的消息打标签）和 `docs/product.md:728` 第 25 项"设置更新防伪造"的关系：属于指令拼装专题，这轮没看。
- `auto-review.ts` 的模型调用和超时细节、`approval-effect.ts` 的完整状态机：和我们不加审批的决定无关，只读了入口。
- Pi 是不是真的"批里有一个顺序工具就整批顺序"：Pi 包没装，只能信 `pi-runtime.ts:1061-1064` 的注释。
- 发现 11、12 里 Codex 和 Claude 的并行执行、跨轮后台进程：没在本机实测，要在 s46 开工时测。
