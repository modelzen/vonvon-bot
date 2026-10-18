> 对抗审查，对 report 的原稿（综合报告初稿，没进仓库）；和 report.md 冲突时以 report.md 为准。

# 对第二轮 Rakazo 研究综合报告的对抗审查

对照：Rakazo `b884f43`（`<home>/vonvon/references/rakazo-b884f43`），我们 main `302e8e5`，s23c 看分支 `claude/s23c-judge-settings`（worktree `<home>/vonvon/worktrees/s23c`，`bd15ab8`）。Rakazo 路径相对它的仓库根，我们的路径 `D/` 指 `packages/daemon/src/`。全部只读源码，没运行任何东西。

标注：【确认】= 我按行号读到了；【推断】= 读了但结论依赖运行时行为或没追完；【未核】= 没去查。

## 0. 总判断

1. **Rakazo 一侧的引用基本属实。** 我核了 A1 到 D、复用清单、第六节涉及的全部 Rakazo 行号（约 45 处），只有两处有问题：A2 的"回复目标到投递时才读"证据不成立（见 A2）；A6 的"收口方向"和 Rakazo 相反，报告的复用表自己也写了"方向不同"，不算错，但正文表里的"先同档再往低再往高"读起来像 Rakazo 的做法，要改措辞。
2. **我们一侧的"没有"大多属实，但报告把"给未开工切片的设计约束"和"现在能改的代码"混在一张表里。** 22 条"现在就该改"里，真正能对 main 动手的只有 B2（链接丢 href、附件下载失败不提示）、C1 的小修（`/resume` 列表不过滤）和 A6 的一小半（s23c 分支上存下的推理档位不按模型校验）。其余 19 条是 s25 到 s56a 的开工要点，应当写进 `docs/v1-plan.md` 第 5 节各片的"做法"，而不是算成"现在改"的工作量。约行数加起来 2500 到 3300 行，没有哪一条能单独成 PR。
3. **A4 的代价被低估，并且和运行卡的生命周期冲突**，建议换成便宜得多的替代方案（见 A4）。A2 的"同一位置已开一轮就不回"和 product.md 3.5 的"插话或排队"承诺冲突，要收窄。
4. **8 条 owner 决定里，真正要 owner 定的是 4 条**（轮数、收件目录与保留期、/resume 列谁的会话、3.7 能改清单）；其余 4 条是实现细节或措辞补充，可以由 Claude 在切片 PR 里顺手改 product.md，不必单独问。
5. **第六节对上一轮的纠正属实**：上一轮的交接笔记（本机，不在仓库）原话"不接第三方 IM。材料里没有出现 Slack……"，而 `apps/api/src/team-chat-bridge.ts` 在 e55263f 时已有 1297 行（`git show e55263f:...| wc -l`）【确认】。

## 1. "现在就该改的"逐条

### A1 没点名消息的判断不堵被 @ 的回复 —— 成立

- Rakazo：`reconcile()` 顺序执行 `mirrorMissingMessages → recoverExpiredDeferredMessages → evaluateAmbient → 取 received 排队`（`team-chat-bridge.ts:870-901`），`DEFAULT_TIMEOUT_MS = 20_000`（`team-chat-judge.ts:29`）【确认】。
- 我们：SDK 的按群队列确实存在，代码里已经知道要躲它：`D/bot/bridge.ts:69-75`（关 600ms 合并，"dedup + chat queue stay on"）、`D/bot/handle-message.ts:2862-2864`（`/resume` 列会话要 detach，否则"sibling topics + ⏹ card-actions stall"）【确认】。`JUDGE_TIMEOUT_MS.main = 20_000`（`D/judge/judge.ts:14`）。s25 的描述（`v1-plan.md:763`）没写这一点。
- 判断：s25 开工要点，必须写。但它是现有模式（`trackTask` + detach）的延伸，不是新机制；60 到 100 行偏多，核心是把判断调用挪出 `onMessage` 的等待链，再给"落地"排一条按位置的小队列。

### A2 判断落地前复核；回复目标入站时定 —— 部分成立

- Rakazo 证据：`:1019-1031` 只查 `status: "observed"`，所以被 @ 的（status 不同）和 bot 自己的话不在判断批里【确认】。但"回复目标到投递时才读"不成立：`:1414` 读的是 `message.replyThreadId`，这是每条消息自己的字段；`:456-457` 更新的是频道 id，不是回复目标。报告自己标了"推断"，这里应改成"不成立"。
- 我们：判断的三个结果里已经含"回在哪里"（`D/judge/prompt.ts:27-31`），开话题的锚点就是触发消息（`replyTo: msg.messageId`）。"回复目标入站时定"在我们的架构里本来如此，不用另写。
- 冲突：报告说"同一位置这个 bot 已开过或排上一轮，就不按这次结果回"。product.md:272 和 :75 承诺"运行中来了消息：插话或排队"，3.5 例子第 3 行就是"判断：回 → 插进正在跑的这一轮"。按 A2 做，这一行就不成立了。
- 怎么改：只保留"同一条消息不重复落地"（例如判断期间它已被另一路径回了）；"已有一轮在跑"时按群的插话或排队设置走，不是"不回"。s26 的"候选 bot 用枚举"保留。

### A3 判断中合并 —— 部分成立，不需要 owner 定

- Rakazo：安静 15 秒才判一批（`:26`、`:1053`、`:1084`）【确认】。
- 我们：判断已经带最近约 20 行上下文（`JUDGE_INPUT_LIMITS.contextLines = 20`，`D/judge/prompt.ts:78`），"前几条作上下文"本来就有。product.md:166 说"一条消息只调一次"，合并是更少的调用，和"控制成本"一致，不是承诺变更。
- 弊端评估偏轻：开话题的锚点会落在最新一条上，前面真正问 bot 的那条得不到话题。Rakazo 用 `asked_by` 字段解决（`team-chat-judge.ts:104-109`），报告把它推到"M5 若发现再加"，我认为应该一开始就加：输出里多一个枚举字段，成本小。
- 怎么改：降为 s25 开工要点；加 `asked_by` 式锚点一起做；不问 owner。

### A4 主动接话那一轮没话说不出卡 —— 部分成立，建议换方案

- Rakazo：环境消息那一轮空回答标 `silent`、失败标 `silent-failure`（`:1406-1430`）【确认】；`silent-reply.ts:4` 的 `NO_RESPONSE` 哨兵【确认】。但 Rakazo 的 Slack 线路本来没有流式卡，"不出字就不发"对它零成本。
- 我们：卡在 `turn/start` 之后、首字之前就建（`D/bot/handle-message.ts:5630-5632`），CardKit 流式实体、占位卡翻面、建卡失败要 abort 子进程这一整套都挂在"开局建卡"上（同处注释）。把建卡推迟到首段文字，等于改运行卡的生命周期：工具调用过程面板、⏹、插话都在首字之前没有落点。150 到 250 行是低估，而且碰并发和清理顺序，是高风险改动。
- "reason 不进提示词"成立：reason 由读过不可信群消息的小模型写，不该直接进 agent 提示词；我们的 reason 上限 80 字（`D/judge/types.ts:58`），用 daemon 固定的一句说明代替即可。
- 替代方案：卡照常开；判断主动接话的那一轮结束时若没有文字回答（今天显示"（未返回内容）"，`D/card/run-card.ts:344`），daemon 删掉这张卡（飞书 `im.message.delete`），诊断页记一条。约 30 到 50 行，不改生命周期，被 @ 的不受影响。失败那一轮仍保留卡，因为失败要让人看见。
- 这样就不需要 owner 定第 2 条。

### A5 入站分类测试走真实 SDK normalize —— 部分成立（已有先例，是扩展不是新建）

- Rakazo：`b3a5d36` "use the SDK's mention flag for channel messages" 存在【确认】。
- 我们：s14d 的测试已经"用 SDK 自己的 `EventDispatcher` 和 `normalize` 走一遍"（`v1-plan.md:776`，`packages/daemon/test/sync-copy.test.ts:5`）【确认】。报告也引了这个先例。
- 怎么改：s22、s25 开工时把这个 helper 抽出来复用，加报告列的 5 种事件；40 行合理。不算"现在改"。

### A6 推理档位按模型收口；模型列表缓存和翻页 —— 部分成立

- 收口：s23c 分支的 `parseStoredJudge` 只按后端校验档位（`getSessionTitleEfforts(v.backend)`，`worktrees/s23c/.../judge/model.ts:118`），`:142` 把存下的档位原样用。手填以外的模型若不支持这一档，调用会被拒。这一点成立，约 15 行，应在 s23c 合入前改。Rakazo 的方向是同档→往高→往低（`model-providers.ts:35-43`，`THINKING_LEVELS` 从 off 往上，`:5-14`）【确认】；给判断用往低优先是对的，但正文表里要写明这是我们自己的选择。
- "目录没就绪时不清掉已存的档位"：s41/s42 还没写，是未来 UI 的注意项，不是现在的缺陷。
- 缓存过期：`listModels` 进程内永久缓存（`D/agent/codex-appserver/backend.ts:585`）【确认】。模型列表很少变，daemon 重启就刷新，15 分钟过期价值低。
- 翻页：`model/list` 只取 `limit: 50`（`:589`）【确认】，但 Codex 的模型列表远不到 50 条；我们的调研文档里也没有 `model/list` 带 cursor 的记录（`docs/research/2026-10-15-v1-spikes/` 里 grep 不到）。翻页是不成立的建议，除非先证明接口会分页。
- 怎么改：只留"按模型收口"这一项进 s23c；其余删。

### A7 e12 改成带标注评测；fake app-server 回 -32601 —— 成立

- Rakazo `evals/report.ts`、`model-emulator.ts:81-83`（没写的步骤 `assert.ok(step, "Unexpected model request")`）【确认】；`agent-verification.md:25` "Missing live credentials mean not run"【确认】。
- 我们：e12 今天只写"各跑 50 次……记延迟分布和额度变化"（`v1-plan.md:1038`），没有标注用例，`JudgeResult` 没有 usage（`D/judge/types.ts:54-70`）【确认】。`codex-judge.test.ts:142` 的兜底我没核【未核】。
- 判断：合理，属于 e12 的做法，不是产品改动。160 行偏多：12 条用例加报告约 100 行。

### A8 s27 的轮数、唤醒说明、去重、空回答 —— 成立（数法是实现细节，上限是 owner 的）

- Rakazo：`DEFAULT_BOT_MESSAGE_MAX_HOPS = 6`、`botMessageHopExhausted` 只比深度（`bot-messages.ts:14-47`）【确认】；唤醒提示词把正文转义并标为不可信（`:136-187`）【确认】；c647a04 存在【确认】。
- 我们：product.md:168 "最多来回 3 轮"、:182 "bot 回合 +1"【确认】。"小码写、小审查"：真人 @小P → 小P @小审（1）→ 小审 @小P（2）→ 小P @小审（3，到顶）。第二次审查发生在第 3 轮，到顶后停下——报告说"第二次审查就会到顶"属实，但第二次审查还是做了的，弊端没那么重。
- 按飞书可见历史数轮数：对，因为不同机器上的 bot 没有共享内存（product.md:172），只有这样两边数出来一样。但要注意每轮多一次 `message.list` 或话题分页调用，s27 的额度估算要记上。
- 怎么改：数法、唤醒说明、去重、空回答进 s27 开工要点；3 还是 6 由 owner 定（见第 2 节）。

### B1 附件收件目录 —— 成立，是真缺口

- Rakazo：`22aed2a`、`thread-artifacts.ts:200-275`（最近 `maxTurns` 轮附件按新的优先重新落地）【确认】。
- 我们：`MEDIA_TTL_MS = 60 分钟`（`D/bot/media.ts:33`），`inboundDir` 是全局临时目录（`D/config/paths.ts:122-125`），注释写明"只读、读写档读不到，接受这个限制"（`media.ts:242-246`）【确认】。被拉进的已有群默认只读（product.md:461），所以"把日志发给 bot 看"在这类群里今天不可用。
- 放行方式可行：s40 已计划对 Codex "按路径给写权限，不加进 runtimeWorkspaceRoots"（`v1-plan.md:893`），收件目录用同一机制给读权限。
- 保留期和"每轮列最近 3 轮"：后者和 L1 重叠，B1 把 L1 的一半装进来了，应合并成一条。
- 怎么改：新开 s39b 合理；依赖 s37、s39、s31；owner 只需定保留期。

### B2 小修 s14e —— 成立，可以现在做

- Rakazo：`3ac1f80`、`chat-sdk-surface.ts:346-366` 在标签后补 `(url)`【确认】；`65a06c8` 存在【确认】。
- 我们：`D/bot/context-weave.ts:628-629` 和 `:704-705` 两处 `a` 节点有文字就丢 `href`【确认】；只有"附件全部下载失败"才提示（`D/bot/handle-message.ts:1925-1931`），文字加失败附件时静默丢【确认】。
- 70 行合理，不依赖别的片。这是本报告里最该先做的一条。

### B3 记忆块渲染和"每轮最前是 daemon 块"不变式 —— 部分成立

- Rakazo：`memory-context.ts:33-54` 不转义直接拼进 `<durable_memory>`【确认】。
- 我们：s38 没开工。但已有同一类防线：`sanitizeContext` 一行化防 `\n]\n[fake]`（`context-weave.ts:751-761`、`:778-783`）、`label()` 去掉 daemon 专用标记 `〔〕「」→`（`:1034-1037`）。记忆是多行正文，不能一行化，所以"每行加前缀"是对的新规则，但应该复用现有标记约定而不是另起一套。
- "每轮最前一定是 daemon 块"做成断言：好，便宜。§9 第 25 项实验加两组：成本是 4 到 6 次真实回合，可以。
- 怎么改：进 s38 开工要点，要求复用 `context-weave` 的边界函数。

### B4 所有会话压缩后第一轮都重交设置 —— 成立，小

- 我们：`compactSeen`、`topicsDue` 都只对 `isMainKey` 生效（`D/bot/handle-message.ts:1306-1343`）【确认】；`v1-plan.md:1092` 把"重交设置"和"主区附话题表"绑在"同一个时机"，容易被实现成只主区。
- 40 行合理。进 s38。

### B5 记忆指引和可机器评分的验收 —— 成立，纯文字

- Rakazo `remember` 整篇覆盖（`executor.ts:5539-5551`），`save_shared_memory` 带 `expectedRevision`（`:5553-5580`）【确认】。
- 我们 M7 第 5 步、体验检查 A 第 4 步（`v1-plan.md:218`、`:229`）确实没有"改了只剩新值"和泄漏探针。可以。

### B6 s40 diff 模块、卡片分列、密钥拒绝、wx —— 部分成立

- Rakazo：`instruction-diff.ts:2-10` 整篇 `-`/`+`【确认】；`executor.ts:4529-4533` 用 `redactSecrets` 拒绝含凭据的指令【确认】。
- diff 模块给 s56a 复用：合理。卡片分列"加了/删了"：是 product.md:354 "已记到本群记忆：…" 的细化，可以在切片 PR 里改措辞，不必 owner 定。
- 密钥扫描：daemon 知道的原值只有各 bot 的 App Secret、会话令牌（s46）和判断 key；只做精确匹配。有用但窄，80 行偏多。
- `wx`：`writeFileAtomic` 的临时名已带 pid 和 UUID（`D/server/atomic-file.ts:10`），`wx` 几乎没有增益，删掉。
- "一次删掉一半以上另外提示"：合理。

### B7 分目录不等于隔离；s31 挡 `projects/` —— 成立，但大半已在 product.md 第 9 节第 20 项

- 我们：product.md:723 第 20 项已经写了 Claude 只读、读写档的 `denyRead` 挡 `bots/` 和凭据，再 `allowRead` 放开本会话的目录【确认】；`projectsRootDir = appDir/projects`（`D/config/paths.ts:111`）不在那个清单里；Codex 的只读、读写档读已经限在 workspace roots（`D/agent/codex-appserver/backend.ts:36-73`），完全访问档是 `danger-full-access`。
- 所以：Claude 一侧补 `projects/` 进 denyRead，约 5 行，进 s31；product.md:106 的措辞"分目录只在限制读的档下起隔离作用"可以由 Claude 在 s31 的 PR 里顺手改；不必 owner 定。

### C1 `/resume` 按归属过滤 —— 小修成立，s49 部分是设计

- 我们：`postResumeCard` 用 `be.listThreads(cwd)` 列出 cwd 下全部会话（`D/bot/handle-message.ts:2872-2878`），同一个群的所有话题共用 cwd，所以话题 A 里能选到话题 B 正在用的会话；flat 路径只检查目标键 `active.get(sessionKey)`（`:4836`），不检查被选中的会话是否绑在别的键上【确认】。两处恢复同一条原生会话的后果（两个 app-server thread 同一份 rollout）我没追到底【推断】。
- 60 行的小修（候选去掉正绑在别处的、选中时再查一次）成立，可以现在做（s15f）。
- s49 的 `parked[]`、私聊只列自己的：是设计，等 s49。"主人在终端开的会话要不要出现在管理员私聊里"确实要 owner 定（见第 2 节）。

### C2 s47 的 JSON 契约 —— 部分成立，要瘦身

- 我们：`runSettingsSet` 在内部现读 revision（`D/cli/commands/settings.ts:160-167`），错误是抛 `Error` 文字（`:172-174`），顶层按 `formatErrorTree` 打印（`D/cli/index.ts:178`）【确认】。agent 用这个接口时拿不到结构化错误，也没法带它刚读到的版本——这两点成立，是 s47 必须有的。
- "读类输出有字节预算、能续读"：对应 Rakazo `history-retrieval.ts:28-50` 的 `bounded`【确认】。这是 s48（查历史）的事，不是 s47。
- "无权和不存在同形"：对。
- 340 行把 s47 从 380 涨到 720，接近翻倍。拆：`--revision` 和结构化错误（约 120 行）留 s47，预算和续读进 s48。

### C3 s46 按会话排队、无人触发的回合拒绝、令牌打码 —— 成立

- product.md:447 已说"只有主人和管理员触发的那一轮能改设置"，但 s27 的 bot 触发回合、s18 的完成提醒、以后的定时任务都不是"人触发"，s46 的描述（`v1-plan.md:940`）没有点出这一类。写明是对的。
- 令牌打码：运行卡能显示工具调用（`cards.showToolCalls`，`packages/protocol/src/settings.ts:38`），Bash 命令行里的令牌会上卡。成立。Rakazo `bot-secrets.ts:155-180` 连 base64、URL 编码形式一起登记【确认】。
- 90 行合理。

### C4 s56a 回执落盘、重启后能撤销、写明触发 —— 部分成立

- Rakazo `executor.ts:6391-6430` 把 before/after/reason/undoVersionId 一起持久化【确认】。
- 我们：s56a 已要求 writer 输出"目标、前后值、版本"（`v1-plan.md:972`），product.md:450 要求撤销核对当前版本。只要卡片按钮带版本号、版本在文件里，重启后撤销天然可用——这部分是 s56a 已有设计的推论，不是新增。product.md:512 说的"重启后挂着的请求没了"指待回答的提问卡，不是回执。
- 新增且有价值的只有"回执写明由谁的哪条消息触发（摘前 60 字）+ bot 的 reason"，它是 product.md:518 残余风险最便宜的缓解。
- 怎么改：只保留触发摘录这一项；是否上卡由 owner 一句话定（见第 2 节）。

### C5 3.7 能改清单对齐命令；SKILL.md 一致性测试 —— 成立

- product.md:444 的表没有完成提醒、卡片显示、插话或排队、主模型、允许的群、路径、评论、标题；CLI 的 `agentSectionSchemas` 全都有（`packages/protocol/src/settings.ts:37-55`）【确认】。
- 这是 s54a 开工前必须定的，owner 要定（见第 2 节）。测试 40 行合理。

### D 测试和验收规矩 —— 部分成立

- 分层表、跳过记为没跑、模型步骤记 k/n：对，便宜。
- `setupFile` 指向临时 `VONVON_HOME`：daemon 的 vitest 没有 setupFiles（`packages/daemon/vitest.config.ts`）【确认】；251 个测试文件里 20 个提到 `VONVON_HOME`，很多测试走 `vi.mock('../src/config/paths')` 用 mkdtemp（`sync-copy.test.ts:10-13`）。有多少测试不 mock 又不设变量，报告自己也说"要先查"。在 2026-10-16 删掉 `<home>` 之后，这条值得做，但先量再做。
- "只验路由的群用小模型"：合理。

### N1 开工时记一笔 —— 成立，无成本

## 2. "要 owner 定的"逐条

| # | 报告的问题 | 我的判断 |
|---|---|---|
| 1 判断中合并 | 要定 | **不必问。** 是实现细节，与 product.md:166 的"控制成本"一致；锚点用 `asked_by` 解决。Claude 在 s25 PR 里补一句到 3.4 即可 |
| 2 主动接话没话说不出卡 | 要定 | **换方案后不必问。** 用"结束时无文字就删卡"代替"晚建卡"，不改运行卡生命周期，3.4 不用改承诺 |
| 3 bot 之间轮数 3 还是 6、怎么数 | 要定 | **要问。** 3 轮下第二次审查还是能做，到顶就停；6 轮多花最坏 3 轮额度。给 owner 的两个选项都成立，建议附上"按飞书可见历史数、自上一条真人消息起算"这句，不管选几 |
| 4 收件目录与保留期；分目录只在限制读的档下隔离 | 要定 | **保留期要问**（7 天还是跟会话走）；3.3 的措辞不必问，Claude 在 s31 PR 顺手改，因为只是把 product.md:723 第 20 项已承认的事实写到正文 |
| 5 `/resume` 列谁的会话；终端会话要不要出现在管理员私聊 | 要定 | **要问**，尤其后半句：管理员能否看到主人在终端开的会话，关系到私聊记忆的边界 |
| 6 回执写明触发摘录和 reason | 要定 | **一句话确认即可**，建议合并到第 5 条的消息里问。重启后撤销不是新承诺 |
| 7 聊天里能改什么 | 要定 | **要问**，s54a 开工前必须有结论。报告的建议（前四项可改，允许的群等只在桌面端）合理 |
| 8 记忆卡片分列与密钥不保存 | 要定 | **不必问。** 是 :354 的细化，不改承诺；"出现密钥原值不保存"是 :444 "聊天里不收 key" 的自然延伸 |

## 3. 复用代码清单

| 文件 | 核对 |
|---|---|
| `packages/adapters/src/silent-reply.ts` 115 行 | 【确认】只依赖 `MessageBlock` 类型。按 A4 换方案后不再需要哨兵，这一行可以删 |
| `packages/db/src/history-retrieval.ts:30-50` `bounded` | 【确认】21 行，二分截最长一段直到不超 10 000 字节。给 s48 不是 s47 |
| `packages/core/src/model-providers.ts:24-44` `clampCatalogThinkingLevel` | 【确认】21 行，方向同档→高→低。我们要低优先，重写 15 行，放 s23c 分支的 `judge/model.ts` |
| `team-chat-bridge.ts:1576-1589` `newestFirstFileLimits` | 【确认】14 行，无依赖。给 L1/B1 |
| `packages/testkit/src/model-emulator.ts` 196 行 | 【确认】node:http，OpenAI 协议。只借做法 |
| 改编头格式 | 我们的先例 `D/server/atomic-file.ts:1-2` 属实【确认】；Rakazo 无 NOTICE，版权行在 `LICENSE:166`【确认】 |

结论和报告一致：这一轮不搬文件。

## 4. 第六节"纠正上一轮"核对

- Slack：上一轮的交接笔记（本机，不在仓库）原文"不接第三方 IM……没有出现 Slack"【确认错误】。e55263f 的 `team-chat-bridge.ts` 1297 行【确认】。`docs/self-host.md:432` "Groups stay iMessage-only" 只对个人线路成立【确认】。
- 判断器：默认关（`schema.prisma:430` `teamChatAmbientEnabled @default(false)`）【确认】；用 bot 主模型，但有部署级覆盖 `TEAM_CHAT_JUDGE_PROVIDER/MODEL`（`apps/api/src/env.ts:231-232`、`app.ts:824-825`）——报告 R9 说"判断跟主模型走"是默认行为，不是唯一可能，措辞要补一句。
- 其余（私下委托、跳数只限深度、remember 覆盖、静默截断、评测用例数）我核了 c647a04、`executor.ts:5539`、`memory-context.ts:48-53`；评测 16 个用例和 MemoryRevision 只写不读【未核】。

## 5. 漏掉的或该补的

1. **报告没有区分"现在改 main"和"给切片写要点"。** 这是最大的结构问题，见第 0 节第 2 条。修正后的清单按此重排。
2. **A3 的 `asked_by` 锚点**被推到"以后"，应一开始就做（见 A3）。
3. **A8 按飞书历史数轮数的额度成本**没记：每个 bot 回合多一次历史读取，s27 的"约行数"外还要加到 e12 一类的额度估算。
4. **B1 的放行在 Claude 一侧依赖 s31 的 denyRead/allowRead 顺序**（product.md:723 第 20 项"行不行在 Mac 上测"还没有结论）。B1 的依赖表里有 s31，但没写"若第 20 项在 Mac 上不行，Claude 只读档仍读不到收件目录"这个风险。
5. **Rakazo 的 HEAD 提交 b884f43 "mark automated user-role messages as not from the user"** 正是 B3 里"daemon 以用户身份写的话要标出来"的同一问题，报告引了 `automated-messages.ts` 却没引这条最新提交，可补作依据。
6. 没有发现报告遗漏 Rakazo 的重要机制。e55263f 到 b884f43 共 15 个提交，和我们相关的（76f4259 回填、65a06c8 附件、b3a5d36 mention、16b99f2 缓存）报告都引到了或在 R18 否掉了。

## 6. 修正后的清单

### 现在就该改的（按优先级，最多 8 条）

1. **B2 小修 s14e**（约 70 行，不依赖任何片，可立即开 PR）：富文本和卡片链接保留目标地址（`context-weave.ts:628`、`:704`）；文字加附件的消息里下载失败的附件写进提示（`handle-message.ts:1925`）。
2. **C1 小修 s15f**（约 60 行，可立即开）：`/resume` 候选去掉正绑在别的会话键上的会话，选中时再查一次，两条恢复路径都查。
3. **A6 的收口**（约 15 行，进在飞的 s23c 分支）：存下的推理档位按模型列表收口，同档→往低→往高；缓存过期和翻页删掉。
4. **A1 + A2（收窄）+ A3 + A5 写进 s25、s26 的开工要点**（`v1-plan.md:763-764` 和第 5 节）：判断调用不占 SDK 按群队列；同一条消息不重复落地，已有回合在跑时按插话或排队走；判断进行中同位置新消息合并，输出带 `asked_by` 锚点；reason 不进 agent 提示词；分类测试复用 s14d 的 SDK normalize helper。不新开 s25b。
5. **A4 换方案写进 s25 要点**：判断主动接话那一轮结束时没有文字就删卡并记诊断页，约 30 到 50 行，不改运行卡生命周期。
6. **B1 新开 s39b 收件目录**（150 到 250 行，依赖 s37、s39、s31；把 L1 的"最近几轮附件"并进来；写明若 product.md:723 第 20 项在 Mac 上不行的后果）。保留期等 owner。
7. **B3 + B4 + B5 + B7 写进 s38、s31 的开工要点和 M7 验收**：记忆块复用 `context-weave` 的边界函数并逐行前缀；"每轮最前是 daemon 块"做断言；所有会话压缩后首轮重交设置（改 `v1-plan.md:1092` 措辞）；Claude denyRead 加 `projects/`；M7 第 5 步加"改到周五只剩周五"，体验检查 A 加泄漏探针。
8. **C2（瘦身）+ C3 + C4（只留触发摘录）+ C5 测试 写进 s46、s47、s48、s54a、s56a 的开工要点**：`--revision` 与结构化错误进 s47（约 120 行），读输出预算进 s48；s46 拒绝非人触发的回合、按会话排队、令牌及编码形式打码；s56a 回执加触发摘录；s54a 加 SKILL.md 示例可解析测试。

A7（e12 评测）和 D（测试分层、setupFile 先量）作为第 9 条和第 10 条跟在后面，不算产品改动。A8 的数法进 s27 要点，等 owner 定上限。

### 要 owner 定的（4 条，建议一条消息问完）

1. **bot 之间的轮数**：维持"最多来回 3 轮"，还是改成"自上一条真人消息以来同一位置最多 6 条 bot 叫醒 bot 的 @"。两种都按飞书可见历史数，不同机器结果一样。
2. **附件收件目录的保留期**：7 天，还是另一个数。目录按位置放在 `bots/<appId>/` 下，每一档都读得到，这一点 Claude 建议直接写进 3.5。
3. **`/resume` 和会话列表的归属**：私聊里只列这个人自己的会话；主人在终端里开的会话要不要出现在管理员的私聊列表里（建议不出现）。
4. **3.7 聊天里能改什么**：完成提醒、卡片显示、插话或排队、主模型这四项能不能在聊天里改；允许的群、路径、评论、标题只在桌面端改（建议如此）。顺带确认回执是否加"由谁的哪条消息触发（摘前 60 字）+ bot 的说明"两行。

不再单独问的：判断中合并（实现细节）、主动接话不出卡（换方案）、3.3 分目录措辞（Claude 在 s31 PR 顺手改）、记忆卡片分列与密钥不保存（:354 和 :444 的细化）。
