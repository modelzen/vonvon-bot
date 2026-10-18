# Rakazo 第二轮：给 v1 后面切片的开工要点

2026-10-18。上一轮（[2026-10-17-rakazo](../2026-10-17-rakazo/report.md)）看的是 e55263f，偏产品方向和交付顺序。这一轮换到 b884f43，七个子代理按专题读源码写深挖，一个代理综合出初稿，另一个模型（Fable）对初稿逐条做对抗审查。本文按审查后的结论写，和附件冲突时以本文为准。全程只读源码，没有运行 Rakazo 的任何代码、测试或脚本，没装依赖；product.md 这次没改。

## 对照的版本和材料

| 项 | 内容 |
|---|---|
| Rakazo | b884f43（上一轮 e55263f）。路径相对它的仓库根，写成 `路径:行号` |
| Vonvon | `main` 的 d187d00，`D/` 指 `packages/daemon/src/`。深挖用的是 898d3c5 到 2e4ca3a，审查用的是 302e8e5 加当时的 s23c 分支；本文我们这边的行号都在 d187d00 上重查过，和附件可能不同 |
| 深挖 | [d1 team-chat 接入](d1-team-chat.md)、[d2 何时回复和多 bot](d2-judge-multibot.md)、[d3 工具目录和自我设置](d3-tools-settings.md)、[d4 指令拼装、防注入和记忆](d4-prompt-memory.md)、[d5 对话和线程管理](d5-conversations.md)、[d6 模型和沙箱](d6-models-sandbox.md)、[d7 首次体验、设置界面和测试](d7-onboarding-testing.md) |
| 审查 | [critique](critique.md)：核对初稿引的约 45 处 Rakazo 行号，把"现在改 main"和"给切片的开工要点"分开，owner 要定的从 8 条减到 4 条。初稿没进仓库，审查里的 A1 到 D 编号沿用到本文 |
| 没进仓库 | 深挖里说的"代码地图"和结构化建议清单，都是本轮的工作材料 |

标注：【确认】按行号读到了；【推断】读了，但结论依赖运行时行为或没追完；【未核】没去查。

## 结论

1. 上一轮说 Rakazo 不接外部聊天，这是错的。它有 Slack team-chat 和一条个人线路，飞书只接私聊。
2. 它的 team-chat 比我们粗糙：一个频道一条对话，没有流式，没有成员白名单，bot 之间 @ 没有总数上限，一次发送失败回复就丢。值得借的是它踩过的坑，不是做法。
3. 现在改 main 的只有三条：B2 小修 s14e，C1 小修 s15f，A6 并进 s23d。其余都是给未开工切片的开工要点，已写进 `docs/v1-plan.md` 各片的说明段。
4. 价值最高的是 s25 到 s27 开工前要守住的几条（判断不占飞书 SDK 的按群队列、判断中合并、主动接话没话说时删卡、bot 之间按位置数轮数），以及 M7 补上的收件目录（新片 s39b）。
5. 要 owner 定的剩 4 条，正在问，见"待 owner 定"。
6. 这一轮不搬任何文件。

## 纠正上一轮

按审查第 4 节核过的：
- **外部聊天**【确认】：上一轮 product-ux.md:112 和上一轮的交接笔记（本机，不在仓库）说没有外部 IM 或没下结论，report.md 的对比表只写"自有 Web、桌面和移动聊天"。实际上 e55263f 就有 `apps/api/src/team-chat-bridge.ts`（当时 1297 行）接 Slack 频道；个人线路 `packages/adapters/src/messaging-platforms.ts` 接 iMessage/SMS、Slack、WhatsApp、Telegram 和飞书私聊。Rakazo 自己的 `docs/self-host.md:432`"Groups stay iMessage-only"只对个人线路成立，上一轮可能被它带偏。
- **判断器**【确认】：product-ux.md:49 把它写成通用的"主动参与群聊"，说它"限制了上下文"。实际只判 Slack 里没点名的消息，默认关（`packages/db/prisma/schema.prisma:430`）；单次 20 条、每条 2000 字符（`apps/api/src/team-chat-judge.ts:26-29`），比我们的 6000 字符总量（`D/judge/prompt.ts:77-84`）宽得多。默认用 bot 的主模型，部署可用 `TEAM_CHAT_JUDGE_PROVIDER/MODEL` 覆盖（`apps/api/src/env.ts:231-232`），所以"判断跟主模型走"只是默认。
- **跳数**【确认】：product-ux.md:35 只写了有上限。它只限链的深度，不限宽度；回送结果也算一跳，c647a04 因为"一次评审来回就用掉大半"把上限 6 改成可配（`packages/core/src/bot-messages.ts:14-21`）。
- **记忆**【确认】：`remember` 每次整篇覆盖 `MEMORY.md`（`packages/adapters/src/executor.ts:5539-5551`）；`memory-context.ts:48-53` 超预算时静默截断，和 product.md:355 冲突，上一轮建议摘取的 UTF-8 截断已经用不上。
- **许可**【确认】：版权行在 `LICENSE:166`，没有 NOTICE 文件。d5、d7 说"LICENSE 没有版权行"是错的。
- 【未核】，只在深挖里出现：Slack 网关 bot 能用 message_bot 私下委托（d2 第 0 节；上一轮 product-ux.md:37 说群里没有）；"改指令要审批"只对 `propose_instructions_update` 成立（d3）；默认上下文策略是 retrieval、压缩只对 1:1 线程（d5）；建 bot 后有一轮介绍回合（d7）；评测 16 个用例、`MemoryRevision` 只写不读（d3、d7）。
- 上一轮复用分析排第 1 的建议（s48 的检索契约）一直没下文，这一轮放进 s48 的要点。

## 现在改 main 的三条

### B2 小修 s14e：链接和下载失败的附件（约 70 行，无依赖）

- 我们【确认】：记录块、话题开场和被引用的消息里，富文本和卡片的 `a` 节点有文字就丢 `href`（`D/bot/context-weave.ts:629`、`:705`），测试把它写死了（`packages/daemon/test/context-weave.test.ts:43-55`、`:113-123`）；同一条消息当触发消息时 SDK 保留链接，两条路不一致。附件只有全部下载失败、正文变空时才提示（`D/bot/handle-message.ts:1922-1932`），有文字又有附件时，下不来的那个悄悄消失。
- Rakazo：3ac1f80 把链接写成"文字 (地址)"（`packages/adapters/src/chat-sdk-surface.ts:346-366`）；65a06c8 给下不来的文件写一行"unavailable"（`apps/api/src/team-chat-bridge.ts:727`、`:745`）。
- 做法：两处改成 `[文字](地址)`，相同时只写一次，截断时不从地址中间截（`LINE_MAX` 280，`D/bot/context-weave.ts:52`）；`collectInboundFiles` 同时返回失败项，清单末尾写"没下载下来：a.log（超过 50 MB）"；顺手改掉那句提示里的旧称"桥"。这是本文最该先做的一条。

### C1 小修 s15f：`/resume` 不列别处正在用的会话（约 60 行，无依赖）

- 我们【确认】：`/resume` 卡列的是 `be.listThreads(cwd)`（`D/bot/handle-message.ts:2880`），同一个群的话题共用 cwd，话题 A 里能选到话题 B 正绑着的会话；单会话群那条路只查目标键有没有回合在跑（`:4837-4846`），网页恢复只查会话在不在这个目录（`:5063-5064`）。两处接着同一条原生会话的后果（Codex 后到的接不上，Claude 两边分叉）是【推断】。
- 做法：候选去掉正绑在别的会话键上的会话；选中时再查一次，卡片的两条恢复路径和网页恢复都查，绑在别处就拒绝并说在哪里用。私聊里只列自己的会话、停泊会话的归属账（d5 发现 1）留给 s49。

### A6 并进 s23d：判断的推理档位按模型收口（约 15 行加测试）

- 我们【确认】：s23c 已合入（#366）。`parseStoredJudge` 只按后端的档位集合校验（`D/judge/model.ts:118`），存下的档位原样发出（`:142`）。存了这个模型不支持的档位，调用会被拒，还可能进 5 分钟冷却【推断】。
- 做法：模型在缓存的列表里时，档位先同档、再往低、再往高收口；手填的、不在列表里的照旧原样传（s16 的规矩）。往低优先是我们为省额度定的，Rakazo 的 `clampCatalogThinkingLevel` 是同档、往高、往低（`packages/core/src/model-providers.ts:24-44`），方向相反。命令行保存时模型目录没读到，也不清掉已存的档位。
- 初稿另两条删掉：模型列表缓存过期价值低，daemon 重启就刷新（`D/agent/codex-appserver/backend.ts:584-591`）；`model/list` 翻页没有证据说明接口会分页。

## 按切片的开工要点

这些已按片写进 `docs/v1-plan.md`（"开工要点（Rakazo 第二轮，2026-10-18）"），这里写理由和证据。行数是建议值，表里的约行数开工时再量。

### s25 智能模式的入站

1. **判断不占 SDK 的按群队列（A1）**：SDK 按群串行调 `onMessage`，我们关了 600 ms 合并但队列还在（`D/bot/bridge.ts:69-75`），`/resume` 已因此改成分离任务（`D/bot/handle-message.ts:2862-2866`）；主区判断最长 20 秒（`D/judge/judge.ts:17`）。Rakazo 先跑完判断才启动被 @ 的回合（`apps/api/src/team-chat-bridge.ts:870-901`），被 @ 的跟着等。做法：没点名的主区消息交给判断后挪出队列，按位置另排，同一位置按消息顺序落地；被 @、底线已定的消息和卡片按钮不等判断。验收：假后端把一次判断卡 20 秒，同群话题里 @ bot 照样马上回。
2. **落地前复核，收窄（A2）**：只保证同一条消息不重复落地。已有一轮在跑时按群的"运行中来了消息"插话或排队（product.md:75、:272），不能改成"不回"。初稿说 Rakazo 的回复目标到投递时才读，不成立：`team-chat-bridge.ts:1414` 读的是每条消息自己的 `replyThreadId`。
3. **判断中合并（A3）**：同一位置有判断在进行时，后来的没点名消息先排着，回来后只判最新一条，前几条作上下文（本来就带最近 20 条，`D/judge/prompt.ts:78`）。不设固定等待。输出一开始就加一个从输入里选锚点的字段（JSON schema 枚举），开话题锚在它指的那条，对应 Rakazo 的 `asked_by`（`apps/api/src/team-chat-judge.ts:104-109`）。这是实现细节，和 3.4"控制成本"一致，不问 owner，s25 的 PR 里给 3.4 补一句。
4. **主动接话没话说时删卡（A4 换方案）**：初稿要"出第一段文字才建卡"，会改运行卡的生命周期（`D/bot/handle-message.ts:5622-5644`：建卡在 turn/start 之后、首字之前，建卡失败要中断子进程），碰并发和清理顺序。换成：卡照常开；判断主动接话的那一轮结束时没有文字回答（今天显示"（未返回内容）"，`D/card/run-card.ts:345`），daemon 删掉这张卡，诊断页记一条；失败的那一轮留着卡。约 30 到 50 行。daemon 今天没有删自己消息的调用，接口和权限开工时核对【未核】。
5. **判断的 reason 不进 agent 提示词**：它由读过不可信群消息的小模型写（上限 80 字，`D/judge/prompt.ts:86`），Rakazo 把它原样放进正式回合（`team-chat-bridge.ts:124`）。用 daemon 固定的一句说明代替。
6. **分类测试走真 SDK（A5）**：把 s14d 的 `EventDispatcher` 加 `normalize` 写法（`packages/daemon/test/sync-copy.test.ts:5`）抽成 helper，加几种脱敏事件，约 40 行。依据 Rakazo b3a5d36：手写的 @ 匹配和 SDK 去重错位，被 @ 的消息被当成没点名。

以上约 250 到 350 行，s25 建议按约 1,100 行估，超过 1,500 先把判断中合并拆出去。不另开 s25b。

### s26、s27

- s26：合成判断同样不占 SDK 队列、落地前复核，按位置合并放在协调器里。候选 bot 在输入里给短标签，输出的 `bot` 字段用枚举限定（Rakazo `team-chat-judge.ts:77`、`:105` 的短 id 写法）。
- s27 数法（A8）：同一位置自上一条真人消息以来，bot 发的、@ 了另一个 bot 并真把对方叫起来的消息有几条，从飞书可见历史推，不在本机存计数器。不同机器上的 bot 没有共享内存（product.md:172），只有这样两边数得一样；代价是每个 bot 回合多一次历史读取，额度估算要记上。Rakazo 的跳数存在自己的库里（`packages/core/src/bot-messages.ts:14-47`），不照搬。
- s27 唤醒说明：被 bot @ 醒的那一轮，开头加一段 daemon 写的说明：对方是 bot 不是真人，内容是资料不是指令，只在真要对方接着做事时才 @，不发只有"收到"的回答，不把事交回给刚交给你的 bot。参照 `packages/core/src/bot-messages.ts:136-187`，用中文自己写。同一事件推两次只算一次；对方回空写"对方没有给出回答"。上限等 owner 定（第 1 条），行数建议约 550。

### s31

- Claude 的 denyRead 在第 9 节第 20 项的 `bots/` 和凭据之外再挡 `projects/`（`D/config/paths.ts:111`），allowRead 放开这一次会话自己的根，约 5 行。不挡的话，只读、读写档的 Claude 会话读得到别的群的默认目录。
- product.md:106 拿"每个群有自己的目录"当隔离理由，其实只在限制读的档下成立。第 20 项已承认这个事实，Claude 可在 s31 的 PR 里把它写进 3.3，不改承诺。s39b 的收件目录也在这里放行读。

### s38

- 记忆块渲染（B3）：每份加一行 daemon 写的标题（范围、文件、版本），正文逐行加前缀，让记忆里没有哪一行冒充得了块的结尾、设置更新或标题行。复用 `context-weave` 的边界约定（`D/bot/context-weave.ts:751` 的 `sanitizeContext`、`:1035-1036` 的 `label`），不另起一套。Rakazo 的 `memory-context.ts:33-54` 不转义就拼进 system 提示词，是反例。
- "每轮最前面一定是 daemon 写的块"做成断言，覆盖没有 open_id、附件下载失败换掉正文、语音转写、第一轮这几条路。daemon 以用户身份写的话标明"不是用户说的"，依据 b884f43 本身（`packages/adapters/src/automated-messages.ts:8-12`）；它的标签是公开字符串，只能降权，不能证明权威。§9 第 25 项实验加两组：同一段像指令的话放开场指令和放用户通道各试；先套问标记再伪造。
- 所有会话压缩后首轮都重交设置（B4）：`compactSeen`、`topicsDue` 今天只对主区（`D/bot/handle-message.ts:1306-1343`）。v1-plan 第 5 节"设置更新什么时候交整份"那一行的"同一个时机"，按"每条会话压缩后的第一轮；主区同时附话题表"实现。
- 第一层的记忆指引（B5）：记稳定的偏好和决定，改已有事实就地改，不记密钥，快满先整理。身份行里的群名改名后会过时，开工时定写群 id 还是接受过时（N1）。

### s39b 收件目录（新片，B1）

- 我们【确认】：附件下到全局 `inbound` 目录（`D/config/paths.ts:122-125`），1 小时后删（`D/bot/media.ts:33`），注释写明只有完全访问档读得到（`D/bot/media.ts:236-251`）。被拉进的已有群默认只读（product.md:461），"把日志发给 bot 看"在这类群里今天不可用；目录又是所有群共用的。
- Rakazo：22aed2a 起每一轮把最近 3 个带附件的轮次的文件放进 bot 的电脑并列出（`packages/adapters/src/thread-artifacts.ts:201-275`），起因是 bot 拿不到文件就去浏览器登录 Slack。
- 做法：附件按位置存进 `bots/<appId>/` 下的收件目录（vonvon 不往工作区写，product.md:109），经 s37 的 profile 作为只读额外根交给会话：Codex 按路径给读（同 s40 记忆目录的办法），Claude 在 s31 的方案里 allowRead；每轮列出最近几轮的附件，写清哪些已清掉（上一轮"前几条附件一起带"并进这里）。保留期等 owner 定（第 2 条）。
- 风险【推断】：第 9 节第 20 项要在 Mac 上测。如果"挡住 `bots/` 再放开其中一个目录"在 Mac 上做不到，Claude 只读、读写档的 Bash 读不到收件目录，只能靠 canUseTool 放行 Read 工具，`grep`、`tail` 看日志不行；那时要么把收件目录挪出 `bots/`，要么在 3.5 写明 Claude 这两档只能用 Read 看附件。

### s40

- 卡片分列"加了"和"删了"，一次删掉一半以上另外提示（product.md:354 的细化，在切片 PR 里改措辞）。按行比较做成独立模块给 s56a 复用；Rakazo `packages/core/src/instruction-diff.ts:2-10` 整篇 `-`、`+`，是反例。
- 新增行里出现 daemon 知道的密钥原值（App Secret、会话令牌、判断的 key）就不保存，卡片不回显，只做精确匹配。不加 `wx`：临时文件名已带 pid 和 UUID（`D/server/atomic-file.ts:10`）。
- 验收开工时补：M7 第 5 步再说"发版改到周五"，只剩周五；体验检查 A 第 4 步加随机码泄漏探针（d7 F6）。行数建议约 600。

### s46、s47、s48

- s46（C3）：设置命令按会话排队（Rakazo db4a0b2 因为一批工具调用并发跑、读到还没写进去的数据，改成按顺序跑，`packages/adapters/src/pi-runtime.ts:1061-1065`）；不是人触发的回合一律拒，包括 s27 的 bot 回合、完成提醒、恢复续跑、压缩引出的一轮和两轮之间的后台进程，product.md:447 没点出这一类；令牌和它的 base64、URL 编码形式登记，运行卡渲染前替换（运行卡能显示工具调用，`packages/protocol/src/settings.ts:39`；Rakazo `packages/adapters/src/bot-secrets.ts:155-180`）；记下触发消息 id 给 s56a。约 90 行。
- s47（C2 瘦身）：`set` 接受 `--revision`，整段文字必须带。今天 `runSettingsSet` 内部现读版本再存（`D/cli/commands/settings.ts:160-170`），挡不住拿旧内容整段写回，和 Rakazo `save_shared_memory`（`executor.ts:5553-5580`）同病。`--json` 下错误也输出 JSON，写明种类、冲突时带当前内容，按种类给退出码；今天是中文文字打到 stderr（`D/cli/index.ts:178`）。`access` 按调用方算，无权和不存在同形。读输出的预算和续读放 s48。行数建议约 500。
- s48：输出约 1 万字节内，超了显式截断并给续读位置，带覆盖范围和稳定 id，范围从令牌推出（Rakazo `packages/db/src/history-retrieval.ts:6-15`、`:28-50`）；写一个公用的"一轮的最终回答"，Claude 读取和运行卡同一条规则（d5 发现 6）；SKILL.md 写查历史的指引，参考 `executor.ts:8381-8384` 改写并注明出处。

### s54a、s56a

- s54a（C5）：测试从设置 skill 的 SKILL.md 抽出全部 `vonvon settings set` 示例，逐条用 `parseAssignments` 解析，再反查能改的节都出现、不能改的都不出现，约 40 行（Rakazo 用测试保证两份工具名单一致，`packages/contracts/src/builtin-tools.ts:4-71`）。能改哪几节等 owner 定（第 4 条）。
- s56a（C4）：回执加不加触发摘录等 owner 定（第 4 条）。重启后能撤销不是新承诺：按钮带版本号、撤销按当前版本核对即可；product.md:512 说的是提问卡。差异用 s40 的模块；文字里有 daemon 知道的凭据就拒写（Rakazo 对指令这样做，`executor.ts:4529-4533`）。

### e12（A7，只作参考）

e12 在另一个 PR 里做，v1-plan 的 e12 那一行不动。建议：从 3.4 例子表取约 12 条带期望决定的用例，只评决定；硬上限 50 次，遇到额度用完或没登录就停，剩下的记"没跑"；token 拿不到记空不记 0（`JudgeResult` 没有 usage，`D/judge/types.ts:63-76`）。fake app-server 遇到没写的方法今天回 `{}`（`packages/daemon/test/codex-judge.test.ts:146`），改回 -32601 并记方法名（Rakazo 的模拟器遇到意外请求就失败，`packages/testkit/src/model-emulator.ts:81-83`）。

### 测试规矩（D）

- v1-plan 第 9 节以后加一张测试分层表（单元、fake、无头网页、frozen CI、JP-VPS 真实飞书、真实判断、Mac 检查），写清真的部分、替身、谁跑、花不花额度（Rakazo `docs/agent-verification.md:9-25`）。
- 没开环境变量而跳过的真实测试记"没跑"，不记"通过"；有模型参与的步骤先记第一次结果，重跑不加提示，写成 k/n；确定性步骤只跑一次。
- daemon 的 vitest 加 setupFile 指向临时 `VONVON_HOME`：先量再做。`packages/daemon/vitest.config.ts` 没有 setupFiles，256 个测试文件里 21 个提到 `VONVON_HOME`，很多用 `vi.mock` 加 mkdtemp（`packages/daemon/test/sync-copy.test.ts:10-13`）。
- 只验"谁回、回在哪里"的验收群用小模型。

这几条这次没写进 v1-plan，等下一个碰测试流程的 PR。

## 待 owner 定的 4 条

正在问，没答。v1-plan 相关要点写"等 owner 定"，答复后另开 PR 改 product.md。

### 1. bot 之间的轮数

- 原文：product.md:168"没有真人插话时，bot 之间最多来回 3 轮"；:182 例子写"bot 回合 +1"，读起来每条 bot @ bot 算一次。
- A：维持 3，每条叫醒对方的 @ 算一次。"小码写、小审查"：真人 @小P → 小P @小审（1）→ 小审 @小P（2）→ 小P @小审（3，到顶），第二次审查还会做，做完就停。
- B：自上一条真人消息以来，同一位置最多 6 条 bot 叫醒 bot 的 @，约等于"来回 3 轮"的字面，也是 Rakazo 的默认值；到上限时最后被叫醒的照常回答，只是再 @ 也叫不醒对方。
- 利弊：A 省额度，复杂的评审要真人再说一句；B 一次评审来回够用，最坏多花 3 轮额度。两种都按飞书可见历史数，每轮多一次历史读取。
- Claude 的建议：B，改了要同步改 :182 的"+1"。

### 2. 收件目录的保留期

- 原文：product.md:222 只写"附件路径"，没写保留多久；今天 1 小时后删。
- A：固定 7 天。B：跟会话走，到 `/new` 或 `/clear` 为止，另设上限（比如 30 天）。C：别的天数。
- 利弊：A 简单可预期，7 天后旧会话里的路径失效，每轮清单会写明已清掉；B 和"会话还在就能再看"一致，但停泊的会话能 `/resume` 回来，归属要跟着记，也可能长期占盘。
- Claude 的建议：A。另建议把"附件按位置放在 bot 目录下，每一档都读得到"一起写进 3.5。

### 3. `/resume` 归属和终端会话可见性

- 原文：product.md:279"原地换回以前的会话"；第 4 节（:615、:620）私聊用 bot 的主工作区，主人和每个管理员各一条私聊会话。按目录列会话的话，s49 以后管理员在自己的私聊里能列出并恢复主人的私聊会话，开场里还带着主人的私聊记忆（d5 发现 1）。
- 一起确认：私聊里只列这个人自己的会话。要定的是：主人在终端里开的、vonvon 不知道归属的会话，要不要出现在管理员的私聊列表里。A：不出现，只在群里和主人私聊里列。B：出现。
- 利弊：A 守住私聊记忆的边界，代价是管理员恢复不了主人在终端开的会话；B 方便，但把私聊边界交给了目录。
- Claude 的建议：A。

### 4. 3.7 聊天里能改什么，回执加不加触发摘录

- 原文：product.md:444 的"能改"没有完成提醒、卡片显示、插话或排队、主模型、允许的群、路径、评论、标题，命令行都支持（`packages/protocol/src/settings.ts:37-55`）；:450 回执列范围、改前改后、版本和生效时机。
- A：前四项能在聊天里改；允许的群（等于扩大谁能用 bot）、路径、评论、标题只在桌面端改。B：维持现在的清单，表外的都只在桌面端。C：都能在聊天里改。
- 顺带：回执加两行，"由谁的哪条消息触发（摘前 60 字）"和"bot 的说明"。
- 利弊：A 放开看得见、能撤销的，扩大使用范围的留在桌面端；B 最保守；C 最省事，但允许的群也可能被诱导改。加两行能让"主人说总结网页，回执却是启用了 MCP"一眼看出（product.md:518 的残余风险），代价是卡片多两行。
- Claude 的建议：A，加两行。s54a 开工前要有结论。

不再单独问的（审查认为是实现细节或已有承诺的细化）：判断中合并、主动接话没话说时删卡、3.3 分目录的措辞、记忆卡片分列和不存密钥。

## 不采纳的

- 按 bot 发件人设策略（忽略、汇总、直接触发、当真人）：和 3.4 第 3 条底线冲突，Rakazo 也没有次数上限。以后要做，带每小时上限、按 app_id 设。
- team-chat 本身的做法：一个频道一条对话、群消息全量镜像进本地库、确认不了就丢的"最多发一次"、私下委托、飞书只接私聊和 webhook。
- 托管型产品的做法：清空即删除、"先做什么"引导卡、建 bot 后的介绍回合、判断跟主模型走、自动切备用模型（Claude SDK 的 `fallbackModel` 在 s44a 顺手核对）、托管登录和端点探测、"只挡内网"的出网档。人工审批 owner 已定不做。
- 初稿里被审查删掉或换掉的：出字才建卡、"已有一轮在跑就不回"、`silent-reply.ts` 哨兵、模型列表缓存过期和翻页、`wx`、另开 s25b。
- 我们已经有的：入站去重、补拉历史、流式和限流、成员白名单、判断防伪造、本机多 bot 仲裁、记忆三方合并、文件防逃逸。

排到更后面的：按模型能不能看图决定图片怎么交（先在 Mac 上用经网关的 Claude bot 发一张图）；"使用默认模型"写明现在是哪个（s41、s42、s50）；网页"历史会话"按最后一条消息的时间（s51b）；首次运行清单加"收到第一条消息"（改 3.1 的承诺，等 UI 轮）；Electron 冒烟测试等低优先项。

## 复用和许可

这一轮不搬文件。候选都有调用方，但形状不同，重写更省事：

| Rakazo 文件 | 行数 | 给谁 | 判断 |
|---|---|---|---|
| `packages/core/src/model-providers.ts:24-44` | 21 | s23d | 档位集合和方向都不同，重写约 15 行 |
| `packages/db/src/history-retrieval.ts:30-50`（`bounded`） | 21 | s48 | 我们按"轮"不按"消息"，重写约 25 行 |
| `apps/api/src/team-chat-bridge.ts:1576-1589` | 14 | s39b | 无依赖，短到自己写更省事 |
| `packages/adapters/src/silent-reply.ts` | 115 | 无 | 换成删卡以后不需要 |
| `packages/testkit/src/model-emulator.ts` | 196 | e12 | OpenAI 协议，只借"按步期望、意外请求就失败" |

以后真要改编：文件头照 `packages/daemon/src/server/atomic-file.ts:1-2` 写两行，`// Adapted from elie222/rakazo <路径> at b884f43.` 和 `// Copyright 2026 Rakazo contributors. Licensed under Apache-2.0; see NOTICE.`；根目录 `NOTICE` 加一段，写明哪个文件、哪个提交、改了什么；加 `packages/daemon/LICENSE.rakazo`，同 `LICENSE.paseo`。改写的文字（比如 s48 的查历史指引）在末尾注一行出处。

## 没做的

没运行 Rakazo，我们这边也没跑复现。标【推断】的开工时要坐实，尤其是 s15f 两处接同一条会话的后果、s39b 在 Mac 上 Claude 读不读得到、删卡用的接口。附件里没经审查复核的说法，用之前自己核对。
