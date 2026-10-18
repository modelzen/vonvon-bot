> 原始深挖，没有逐条复核；和 report.md 冲突时以 report.md 为准。

# 首次体验、设置界面和测试验收方法

2026-10-18。读的版本：Rakazo `b884f43`（`<home>/vonvon/references/rakazo-b884f43`），vonvon-bot `main` 的 `2e4ca3a`。任务里写的是 `898d3c5`，两者之间只多了 #386、#387 两个文档提交（交还职责、建群恢复挪到 v1 之后），不影响本文的结论。没有运行 Rakazo 的任何代码、脚本或 npm/pnpm 命令，没有装依赖，没有联网，也没有改 vonvon-bot 仓库。

标注：【确认】是读源码确认的，【推断】是推断出来的，没有源码证据。Rakazo 的路径相对上面的 checkout，我们这边的路径相对仓库根。

## 0. 结论

1. 首次体验上，Rakazo 值得借的不是"先做什么"卡片（它的选项是 Composio 连接器的组合，我们没有对应的东西），而是这一点：建好第一个 bot 后人直接落进对话里，状态一律以系统观察到的为准，不以人自己说的为准。我们的清单停在"全部完成"，没有证明第一条消息真的到了 daemon，"卡片回调"这一步还要人手动勾选。建议在清单末尾加一行"收到第一条消息"，并给出打开私聊的链接（第 6 节 F3）。
2. 测试验收上，Rakazo 最值得借的是 `docs/agent-verification.md` 的分层表和这几条规矩：跳过算"没跑"，不算通过；评分读状态，不读模型的自述；失败不给提示重试；先给失败分类，再改提示词；花钱前先预留额度。我们的 e12、M5、M7 和"认识你的 bot"检查，都能用这些规矩把额度花在刀刃上（F4 到 F8）。
3. 工具上，我们自己的 fake app-server 遇到不认识的方法会回 `{}`，Rakazo 的 emulator 遇到意外请求会回 400。建议改成回 -32601，并记下是哪个方法（F10）。s23c 的 Claude 判断可以让真 CLI 连回环假端点，离线测完错误分类（F9，需要先花 30 分钟做 spike）。
4. 没有值得原样拷的代码。`redact()` 只有 12 行，但要换成飞书 id 的规则，所以按"采纳思路"处理。

## 1. 更正上一轮

- 上一轮的交接笔记（本机，不在仓库）说 Rakazo "不接第三方 IM，材料里没有出现 Slack"，这不对。【确认】Rakazo 有 Slack 团队聊天桥（`apps/api/src/team-chat-bridge.ts`，带测试，`e55263f` 时就有），还有个人消息线路，其中包括飞书/Lark 的私聊：`packages/adapters/src/messaging-platforms.ts:178-186` 在配了 `larkAppId`、`larkAppSecret`、`larkVerificationToken` 时注册 `provider: "lark"`，`capabilities: { direct: true, groups: false }`，走 HTTP webhook，不支持群聊。设置页在 `apps/web/src/pages/MessagingSettingsOverlay.tsx`，e2e 在 `apps/web/e2e/messaging-settings.spec.ts`。这个设置面默认被环境变量关掉，所以 e2e 用 fixture 回 RPC（`messaging-settings.spec.ts:9-14`）。
- `docs/research/2026-10-17-rakazo/product-ux.md:15` 说 "A fresh bot chat initially stays empty"，这只在 scripted 运行时下成立。【确认】真实部署时，`bots.create` 之后会排一轮 "created" 触发的回合（`apps/api/src/router.ts:699-716,1592-1594`）。这一轮没有工具（`packages/adapters/src/executor.ts:4106-4109`），不带历史（`executor.ts:8440-8462`），也不发完成通知（`executor.ts:8481-8483`）。提示词是 "say what you understood your role to be…"。只有 `agentRuntime === "scripted"` 或者还没配模型时才跳过（`router.ts:714-715`）。评测和 fixture 会主动停掉这一轮（`packages/testkit/src/discard-bot-intro.ts:18-28`）。
- 上一轮把"先做什么"卡片说成一个通用的第一步，并不准确。【确认】它的四个选项（day、inbox、research、everything）各自对应一组 Composio 应用（`apps/api/src/onboarding.ts:24-70`）。选完以后 Rakazo 去查连接器目录，只给目录里有的应用出卡片，并显示已连接或待连接（`onboarding.ts:246-285`）。
- `onboarding.ts:12-16` 的文件头注释还写着 greeting，但代码并不发（`onboarding.ts:99-110`），e2e 也断言 greeting 数是 0（`apps/web/e2e/onboarding-conversation.spec.ts:15-17`）。这个 e2e 跑在 scripted 下，所以也覆盖不到上一条说的介绍回合。
- 交接笔记让看 `agent-verification.md:262-351`，那一段讲的是历史检索的资格测试。通用的分层写在 `:9-25` 和 `:119-195`，额度上限在 `:216-236`。
- 评测现在有 16 个用例，不是 15 个：45/45 的基线只覆盖原来 15 个，第 16 个是 Slack 类私聊加两个服务 emulator（`agent-verification.md:155-157`）。
- 上一轮没提的一点：【确认】Rakazo 没有用真实模型评测它自己的团队聊天判断。在 `packages/testkit/src` 里 grep judge 和 Engagement 都没有结果，`team-chat-judge.test.ts` 只测提示词渲染和解析。所以我们的 e12 在这件事上没有现成的参照，只能借它的评测框架。

## 2. Rakazo 的首次体验怎么走【确认】

1. 选模型。如果已经有默认模型，就跳过这一步（`apps/web/src/pages/Onboarding.tsx:215`，`setStep(me.needsModel ? "model" : integrations?.needsSetup ? "integrations" : "bot")`）。目录为空或加载失败时，这一步挡住，不让往下走（`apps/web/e2e/onboarding-model-required.spec.ts:4-60`）。
2. 预检连接（`apps/web/src/lib/model-connection-preflight.ts`）。失败会被分成几类：timeout、rate_limit、unauthorized、unavailable_model、unreachable、needs_sign_in、missing_fields、unknown（`:4-18`）。每类都给 `{outcome, message, nextAction}`（`:42-113`）。错误文本里的 `sk-`、`Bearer`、`api_key=` 会被抹掉（`:22-35`）。
3. 自动建第一个 bot。不让人填表单，名字固定叫 "Chief"，spawnKey 是 `onboarding:first`（`Onboarding.tsx:60-62`）。幂等靠两层：Web Locks，加一个模块级的 promise（`:77-115`）。建好后跳进它的对话（`:525-548`）。e2e 断言 bots/create 的请求体（`onboarding-model-auto-skip.spec.ts:4-62`）。
4. "先做什么"卡片。第一个 bot 立刻出；之后建的 bot 等 10 秒再出，这期间发一条消息就取消（`apps/web/src/lib/focus-prompt.ts:3-28`，`apps/web/src/pages/Shell.tsx:2446-2497`，`apps/web/e2e/new-bot-ux.spec.ts:171-212` 用 `page.clock` 测）。卡片在事务里加 `FOR UPDATE` 锁之后发，已经有用户消息或者已经选过时就不发（`apps/api/src/onboarding.ts:120-162`）。不花 token。
5. 选完回一句 "I'll see what's already connected so I don't make you set something up twice"（`onboarding.ts:242`），然后以 15 秒为超时查目录，给应用出卡片。授权成功后，`markAppConnected` 把卡片改成 Connected（`:305-341`）。e2e 检查两件事：刷新以后状态还在；后端 `connections/list` 里确实是 connected（`onboarding-conversation.spec.ts:68-90`）。保存成功但刷新失败时，选项还能再点（`:117-133`）。还有 zh-CN 的用例（`:92-115`）。
6. 真实部署里，建 bot 之后还有一轮介绍回合（见第 1 节）。源码注释说的理由是：不这样，角色理解错了要等到真干活才发现（`router.ts:702-707`）。

## 3. 设置界面【确认】

- 消息平台设置：配对码在任何操作之后都清掉（`MessagingSettingsOverlay.tsx:25-80`）。Slack 团队聊天的接入靠环境变量配置，没有扫码建应用这类引导。
- 本机设置（`apps/web/e2e/local-settings.spec.ts`）和设置外壳：总数未知时显示"—"，不显示 0（`apps/web/e2e/settings-shell.spec.ts:4-26`）。
- bot 整理：置顶、分组、拖拽排序，持久化（`apps/web/e2e/bot-organization.spec.ts`）。
- 对照我们这边：清单的每一步都有状态、原因和下一步动作（`packages/protocol/src/setup-steps.ts:40-80`）。诊断页的每个"没回"原因都有固定文案和下一步（`packages/protocol/src/diagnostics.ts` 的 `NOT_REPLIED_TEXT`）。在"失败要给出原因和下一步"这件事上，我们和 Rakazo 的预检分类做得一样细，有的地方更细。

## 4. Rakazo 的测试分层【确认】

| 层 | 真的部分 | 替身 | 读到的位置 |
|---|---|---|---|
| 单元和集成 | 代码、数据库 | scripted 运行时、模型 emulator | `agent-verification.md:9-17` |
| web e2e | 浏览器、API、数据库 | scripted 运行时；平台关掉的页面用 `page.route` 回 fixture | `apps/web/e2e/*.spec.ts`，`messaging-settings.spec.ts:9-14` |
| 桌面 e2e | Electron | 同上 | `apps/desktop/e2e/smoke.spec.ts:11-60`（preload 白名单、renderer 没有 node 全局） |
| canary | 真的 provider | 无 | `packages/testkit/src/cli/canary.ts:8-15`，`providers.canary.test.ts:16-28`，要 `VERIFY_PROVIDERS` 加 key |
| 真实评测 | 真模型、本地服务 emulator | 文件工具真跑，shell 明确报错 | `agent-verification.md:119-195` |

几条规矩：

- PR 和默认测试从不花推理费（`:19-23`）。缺真实凭据时记为 **not run**，不算通过（`:24`）。`packages/testkit/src/pin-test-env.ts:1-29` 作为 vitest 的 setupFile（`vitest.config.ts:41`），没设 `VERIFY_PROVIDERS` 时强制只用 emulator。
- 评分读文件、服务记录、记下的副作用和持久化的产品状态；模型说"做完了"不算数；失败不给修复提示，不教（`:174-177`，`packages/testkit/src/evals/runner.ts:60` "No coaching retries"）。
- 失败分成 agent、product、provider、harness、incomplete 五类。先读分类和证据，再怪提示词。几次 trial 只能定一个初始基线，不是精确的可靠性估计（`:184-187`，`packages/testkit/src/evals/report.ts:8`）。
- 报告（`report.ts:9-118`）分别记 planned、attempted、passed、failed、notRun 和 firstAttemptPassed，以及 p50/p95 延迟。拿不到的 token 和费用记为 null；其中任何一项未知，总和也是 null。`assisted: false` 写死。
- 功能判据保持确定性。只有直接没法评的质量才用模型当评委，而且要有带版本的 rubric 和人工校准；评委不能推翻"有禁止的副作用"或"缺产物"这类结论（`:193-195`）。
- 额度上限：默认 5 美元，每次调用前先按估计最大花费预留；定价未知就不跑（`:216-236`）。
- 第一次基线是 41/45，原因有两个。一是假沙箱把一条 shell 命令假报成功了；二是三个结果本来是对的，却被过窄的措辞检查判了失败。修好以后是 45/45，原始报告单独保留（`:145-149`）。现在评测沙箱遇到 shell 会明确报错，不假装执行（`:167-170`）。
- 录制：字段是封闭词表（`packages/testkit/src/computer-recording.ts:44-63`）。花钱的录制要同时给 `--live` 和 `--record`（`cli/computer-replay.ts:8-16`），而且真跑和紧接着的离线回放都通过，才落盘成 fixture（`agent-verification.md:83-94`）。
- 模型 emulator（`packages/testkit/src/model-emulator.ts`，196 行）：回环的 OpenAI SSE 服务。按顺序列出每一步期望的请求（`:34-47`），检查 POST、端点、鉴权、2 MiB 上限、模型名和 stream（`:66-83`）。意外请求回 400，而且不把断言细节写进响应（`:185-195`）。用完调 `assertComplete`（`:171-175`）。
- scripted 运行时（`packages/adapters/src/scripted-runtime.ts`，614 行）：消息里出现 "fail this run"、"keep working" 这类关键词，就触发对应脚本。
- e2e 的写法：截图按检查点编号（`golden.spec.ts`，`helpers.ts:69-78`）；刷新后状态还在；用 `rpc()` 读回持久化状态，配合 `toMatchObject` 断言（`routine-execution.spec.ts:5-49`）；"Test run" 刷新后还在（`:121-182`）；时间用 `page.clock` 控制。PR 截图评论只给这个 PR 碰到的 spec 里新增或变了的帧，最多 8 张（`packages/testkit/src/playwright-pr-screenshot-comment.ts:3-62`）。

## 5. 我们这边的现状【确认】

- 清单：`packages/ui/src/setup/SetupChecklist.tsx:92-101` 每个 bot 一组，做完显示"全部完成"。每 10 秒轮询一次；读失败时保留上一次读到的好结果（`useSetupStatus.ts`）。各步见 `packages/protocol/src/setup-steps.ts:40-80`："事件订阅"只通过接口读配置（`event.state`），"卡片回调"因为飞书没有读接口，要人手动勾选（`packages/protocol/src/admin.ts:70-71`，`setup-steps.ts:64-66`）。daemon 的命令行提示是"若消息未送达，检查事件订阅方式是否为长连接"（`packages/daemon/src/bot/onboarding.ts:192`）。按 bot 记录"第一次收到入站消息"的代码没有：grep 只找到会话级的 `lastSeenAt`（`packages/daemon/src/bot/session-store.ts:40`）和诊断里的"没回"记录（`packages/protocol/src/diagnostics.ts`）。
- 真实测试靠环境变量开启：`VONVON_REAL_JUDGE` 和 `VONVON_REAL_JUDGE_RUNS`（`packages/daemon/test/judge-real-codex.test.ts:13-20,69`），`CLAUDE_LIVE`（`packages/daemon/test/claude-agent.live.test.ts:9-14,26`）。真实判断的测试只有三条固定消息（`judge-real-codex.test.ts:28-32`），只断言决定落在 `JUDGE_ALLOWED` 里（`:110-119`），再加副作用检查（`:141-147`）。`JudgeResult` 里没有 usage 字段（`packages/daemon/src/judge/types.ts:56-70`），token 数只写在日志里（`judge.ts:282-284`）。
- fake app-server：用 `MODE:` 控制行为，最后有一条兜底，什么方法都回 `reply(msg.id, {})`（`packages/daemon/test/codex-judge.test.ts:142,146`）；`codex-server-requests.test.ts:83` 也是每个请求都回 `{id, result:{}}`。草稿分支 `origin/claude/s23c-judge-settings` 上有 `test/helpers/fake-claude-cli.ts`：用真的 SDK 传输层驱动假 CLI，对照真 CLI 2.1.296 校过。
- `packages/daemon/vitest.config.ts` 没有 setupFiles。数据目录取 `VONVON_HOME`，没设时用 `<home>/.vonvon-bot`（`src/config/data-root.ts:9-14`）。
- 无头网页检查：`.agents/skills/verify/scripts/web.mjs` 能截 bot-list 和 no-cred 两页。fake bot 永远连不上，所以挂在 `requireRunningAgent` 后面的 RPC 都会被拒。机器上没有中文字体，中文显示成方框。lockfile 里有 Playwright 1.64.0（`package-lock.json:8026-8028`）。
- CI：`.github/workflows/ci.yml` 有 linux 任务（`:18-83`），macOS 任务（`:85-122`）跑在自托管 runner 上，用户是标准用户 `ci-user`，执行 `npm test`。没有 Electron 冒烟测试。
- 验收文字：M5 第 1 到 3 步（`docs/v1-plan.md:173-175`），M7 第 1 步和第 5 步（`:212,216`），"认识你的 bot"检查（`:219-237`），M9 第 3 步（`:260`），e12（`:1025`），判断默认用 gpt-6-luna（`:790,1059-1062`），§7 预览版（`:1131-1173`），§9 开发做法（`:1191-1199`）。发布标准里的"第一次对话走通"见 `docs/product.md:698`，清单各步见 `:47`。

## 6. 发现

### F1 "先做什么"卡片：不采纳（v1）

- Rakazo：`apps/api/src/onboarding.ts:24-70,120-162,200-303`，`apps/web/src/lib/focus-prompt.ts:3-28`，`apps/web/src/pages/Shell.tsx:2446-2497`。
- 理由：选项是 Composio 应用组合，我们没有连接器目录。私聊干活要等 s49。`docs/product.md:621` 定了私聊不再弹管理菜单，额外的引导卡片和它相抵触。"可选的本地聊天或首次任务体验"已经写在 `docs/product.md:736`（§10，v1 之后）。上一轮留下的第 2 个待定项，就此结论为 v1 不做。
- 可以记下的实现细节，留到 v1 之后用：在事务里加锁判断"用户已经开口就不发"；第一个 bot 立刻出，之后的 bot 延迟出；发消息就取消。这些是不打断人的写法。
- 置信度高。不改变产品承诺。

### F2 建 bot 时的介绍回合：作为产品行为不采纳，作为验收探针采纳（见 F6）

- Rakazo：`apps/api/src/router.ts:699-748,1588-1594`，`packages/adapters/src/executor.ts:4106-4109,8440-8483`，`packages/testkit/src/discard-bot-intro.ts:18-28`。
- 理由：每次建 bot 都花一轮额度；我们改个性、改名不建新 bot，要覆盖就得再触发一轮。它还是一条主人没要的消息。`docs/product.md:621` 的方向是私聊里只干主人要的事。
- 它想解决的问题（角色理解错了没人发现）是真的。我们的办法是在验收里问一次，不在产品里每次都问（F6 第 4 点）。
- 置信度高。不改变产品承诺。

### F3 清单全绿之后：加"收到第一条消息"一行，并给出打开私聊的入口（采纳思路）

- Rakazo：`Onboarding.tsx:525-548`（建好就落进对话）；`onboarding.ts:305-341` 加 `onboarding-conversation.spec.ts:68-90`（卡片状态跟实际连接走，刷新后从后端读回）；`model-connection-preflight.ts:42-113`（每个失败都有下一步）；`routine-execution.spec.ts:121-160`（"试跑一次"）。
- 我们：`SetupChecklist.tsx:92-101` 到"全部完成"就结束了。"事件订阅"只读配置（`setup-steps.ts:57-63`），"卡片回调"手动勾选（`:64-66`）。`docs/product.md:47` 列了清单各步，`:698` 的发布标准是"第一次对话走通"，但清单本身证明不了这一点。`onboarding.ts:192` 只给了一句文字提示。
- 差别：Rakazo 的终点是一段可以开始的对话，状态以观察到的为准。我们的终点是一组配置读数。长连接通了、订阅配了、版本发了，消息仍可能到不了：比如订阅方式不是长连接，或者发的版本不对。这种情况现在只能靠人自己去发一条试试。
- 建议：
  1. 清单末尾加一行"收到第一条消息"。daemon 第一次收到这个 bot 的入站消息（私聊或群里 @ 它）时，只记一个时间戳，不记正文（和 `diagnostics.ts` 不记正文的规矩一致），这一行就变绿。还没变绿时，给一个"在飞书里打开和它的私聊"的按钮，并提示"发一句话"。
  2. 顺带一点：daemon 第一次真收到这个 bot 的 `card.action.trigger` 时，自动把"卡片回调"标成已确认，人手动勾选保留为后备。
  3. 打开私聊的链接，我推测可以用飞书 applink 的 bot 打开格式（`applink.feishu.cn/client/bot/open?appId=…`）【推断，没查文档】。实现前先查官方文档，再用 lark-cli 或 Mac Codex 试一次。
- 影响切片：要新开一个小切片，挂在 M2 清单（s04）之后，或者并进 UI 轮；第一句话最自然的地方是私聊，和 s49 有关，没有 s49 时，私聊里第一句话只能得到现在的回复；验收里"认识你的 bot" A 第 1 步（`docs/v1-plan.md:224`）可以直接看这一行。
- 工作量：daemon 记时间戳并经 admin 状态带出，约 40 行；`setup-steps.ts` 加一行，约 20 行；UI 加按钮，约 20 行；测试约 50 行。合计 100 到 150 行。
- 清单多了一步，会改变 owner 看到的承诺，要 owner 决定。置信度中：要等 applink 格式核实，还要确认长连接下私聊事件能不能拿来当这个信号。

### F4 测试分层表，"跳过算没跑"（采纳思路）

- Rakazo：`docs/agent-verification.md:9-25`，`packages/testkit/src/pin-test-env.ts:1-29`，`packages/testkit/src/cli/canary.ts:8-15`。
- 我们：`docs/v1-plan.md:1191-1199`（§9）和 `:1131-1173`（§7）分散写着，没有一张表。真实测试有 `judge-real-codex.test.ts:69` 的 `describe.skipIf(!REAL)`，没开时显示为 skipped，在 vitest 输出里和"通过"放在同一份绿色报告里。
- 建议：
  1. 在 `docs/v1-plan.md` §9 加一张约 7 行的表：单元、fake app-server/fake CLI、无头网页、frozen CI、JP-VPS 真实飞书（lark-cli）、真实判断（e12）、Mac 检查和预览版。每层写清真的部分、替身、命令、谁跑、花不花额度。
  2. 写一条规矩："没开环境变量而跳过的真实测试，验收记录写'没跑'，不写'通过'"。
  3. 可选，低优先级【推断】：给 daemon 的 vitest 加一个 setupFile，`VONVON_HOME` 没设时指向 `mkdtemp` 建的临时目录，并拒绝真实的 `~/.vonvon-bot`。这样就不会有测试意外写到真实数据目录，和 2026-10-16 那次 home 被删之后定的规矩方向一致。动手前先确认现有测试有没有依赖默认路径。
- 影响：§9 文档，约 15 行；setupFile 约 20 行，加 `vitest.config.ts` 1 行。不改变产品承诺。置信度高。

### F5 e12 做成带标注的评测（采纳思路）

- Rakazo：`packages/testkit/src/evals/cases.ts:9-49`（用例类型），`report.ts:8-118`（分类、notRun、首次通过、p50/p95、未知记 null），`runner.ts:60`，`agent-verification.md:174-187,216-236`。
- 我们：`judge-real-codex.test.ts:28-32,110-119`，三条消息，只看决定落不落在允许集合里；`types.ts:56-70` 没有 usage；e12 写在 `docs/v1-plan.md:1025`，由 owner 看额度页；默认模型见 `:790,1059-1062`；例子表在 `docs/product.md:112-187`（§3.4）。
- 差别：只看"在允许集合里"，判断有没有判对是测不出来的，比如该开话题的判成了不回，照样通过。e12 要回答的是延迟和额度，但每次调用花了多少 token，现在只能去翻日志。
- 建议：
  1. 从 §3.4 的例子表里取大约 12 条，标上期望的决定集合：哪些只能是 skip，哪些只能是 topic，哪些 main 或 topic 都算对。
  2. 每次调用记一行 JSON：决定、对没对、毫秒数、是否冷启动、输入/缓存/输出 token（拿不到就记 null，不要记 0；在 `JudgeResult` 上带出 usage，或者从日志里读）、错误分类。
  3. 硬上限 50 次（e12 原来就说 50 次）。遇到第一个结构化的额度用完或没登录错误，立刻停，剩下的记为 notRun。
  4. 失败的报告也要保留，放进 `docs/research/` 的日期目录，和 Rakazo 那份 41/45 原始报告单独保留是同一个思路。
  5. 不要用措辞匹配来评分；只评决定，这个判断本来就是结构化输出。
  6. Rakazo 没有用真模型评测过它自己的团队聊天判断（第 1 节），这部分只能借框架，借不到数据。
- 影响切片：e12、s25（智能模式的入站）、s23c（Claude 判断）、s23d。工作量：测试文件和用例约 120 行，usage 字段约 20 行。不改变产品承诺。置信度高。

### F6 让模型相关的验收步骤可以机器评分（采纳思路）

- Rakazo：`packages/testkit/src/evals/cases.ts:104-123`（workspace-memory-isolation：塞一个外来代码 MARIGOLD-773，要求老实回答 UNKNOWN，并检查回复、记忆和文件里都没有这个代码），`:345-381`（记住偏好、改偏好、记住工作流程），`agent-verification.md:174-177`。
- 我们：M7 第 1 步写个性，第 5 步"记住：发版在周四"（`docs/v1-plan.md:212,216`）；"认识你的 bot" A4、A5、B6（`:227-231`）；M9 第 3 步（`:260`）。现在多数靠人看"说话简短了没有"。
- 建议：
  1. 每次验收生成一个随机代码，例如 `K7Q2-…`，让 bot "只回这个代码，或者回 UNKNOWN"。用 lark-cli 读回回复，用 grep 检查：另一个群的回复、另一个群的记忆文件和私聊里都不能出现这个代码。
  2. 先说"记住 X=A"，再说"改成 X=B"，然后 `/new`，问 X，只能回 B。
  3. 个性用机器看得出的特征来验，例如"每条回复最后一行写 —— 小V"，不用"简短""活泼"这类要人判断的词。人工判断的那一项留给 owner。
  4. 可选：新建或改了个性以后，问一句"用一句话说说你理解的自己的角色"，代替 F2 的介绍回合，只在验收时问。
- 影响：M7 第 1、2、5 步；"认识你的 bot" A4、A5、B6；M9 第 3 步；s40 的测试。文档约 20 行，探针脚本约 50 行。不改变产品承诺。置信度高。

### F7 模型相关步骤：先记第一次的结果，先分类再重跑（采纳思路）

- Rakazo：`runner.ts:60`，`report.ts:107-114`（firstAttemptPassed），`agent-verification.md:184-187`。
- 我们：M5 第 2 到 4 步（`docs/v1-plan.md:174-176`）和 M7 第 1、2 步，没写失败了怎么办。
- 建议：先记第一次的结果。失败了，先分清是判断问题、产品问题还是平台问题，再决定重不重跑。重跑用同样的措辞，不加提示，最多 3 次，结果写成 k/n。确定性的步骤（权限、绑定、撤销）只跑一次，必须过，不能用重跑凑。
- 影响：§9 加 5 行，各里程碑的验收记录照这个格式写。不改变产品承诺。置信度高。

### F8 只测路由的验收群用小模型（采纳思路）

- Rakazo：真实评测的几条线都用 Luna（`agent-verification.md:101,145`）。
- 我们：s16 能给每个群单独设模型。§7 的 Claude 验收回合读的是 JP-VPS 运行账号的 `~/.claude` 设置（`docs/v1-plan.md:1131-1173`）。
- 建议：M5 那几步只验"谁回、回在哪里"，测试群的主模型设成小模型，比如 Codex 的 gpt-6-luna 或 Claude 的 haiku，省下主回合的额度。验个性和记忆的步骤照旧用默认模型。
- 影响：§7 加 3 到 5 行。不改变产品承诺。置信度中：要先确认测试群里改了模型以后，其他验收步骤不会继承这个设置。

### F9 s23c：真的 Claude CLI 连回环的假 Anthropic 端点（采纳思路，先做 spike）

- Rakazo：`packages/testkit/src/model-emulator.ts:18-83,171-195`（按步期望、意外请求就失败、`assertComplete`），`agent-verification.md:12,26-37`。
- 我们：s23c 草稿用的是假 CLI（`test/helpers/fake-claude-cli.ts`），测不到真 CLI 收到 401、429、overloaded、超时以后，吐出来的结构化错误长什么样。可是 5 分钟冷却正是按结构化错误码触发的（`docs/v1-plan.md:1061`）。
- 建议：起一个回环 HTTP 服务，模拟 Anthropic Messages 的 SSE 和几种错误码，用 `ANTHROPIC_BASE_URL` 把真 CLI 指过去，离线测完错误分类和冷却。花钱的那一轮真实测试只需要验格式和决定。
- 【推断】SDK 包里自带能跑的 CLI，而且会读 `ANTHROPIC_BASE_URL`。这两点都没验证，先花 30 分钟做 spike；不行就保留假 CLI。
- 影响：s23c 的测试，约 150 行。不改变产品承诺。置信度中。

### F10 fake app-server 遇到没写的方法回 -32601（采纳思路）

- Rakazo：`model-emulator.ts:81-83,185-195`，`agent-verification.md:145-149,167-170`（假沙箱把命令假报成功，就是这一类问题）。
- 我们：`packages/daemon/test/codex-judge.test.ts:142,146`，`packages/daemon/test/codex-server-requests.test.ts:83`。
- 差别：Codex 升级以后，daemon 要是开始调一个新方法，fake 照样回 `{}`，测试仍然是绿的，问题要到真机上才暴露。
- 建议：兜底改成回 JSON-RPC 的 `-32601 Method not found`，同时把方法名记进 fake 的调用日志，测试结束时断言日志里没有意外调用。已知要回空对象的方法逐个列出来。
- 影响：两个 fake 各约 10 行，可能牵出几个测试要补方法。不改变产品承诺。置信度中到高：改完后要跑一遍，才知道有多少测试依赖兜底。

### F11 录真实会话做 fixture（采纳思路，低优先级）

- Rakazo：`packages/testkit/src/computer-recording.ts:44-63`（封闭词表），`cli/computer-replay.ts:8-16`（花钱的录制要同时给 `--live` 和 `--record`），`agent-verification.md:83-94`（真跑和离线回放都通过才落盘）。
- 我们：d1 第 5 条已经提议，把 e10 的原始事件喂进真的 `normalize`。这一条是它的延伸：Codex 或 Claude 升版本时，录一段真实的 app-server 或 SDK 流，只留白名单字段（方法名、类型、id 形状），离线回放通过了才收进 `packages/daemon/test` 的 fixture。
- 影响：s03 版本升级时用，约 200 行，v1 不急。不改变产品承诺。置信度中。

### F12 CI 里的 Electron 冒烟测试（采纳思路，低优先级）

- Rakazo：`apps/desktop/e2e/smoke.spec.ts:11-60`（`_electron`：preload 只暴露白名单里的键，renderer 里没有 node 全局，检查窗口状态），`setup.spec.ts:81-221`。
- 我们：`.agents/skills/verify/SKILL.md` 里 Electron 的做法还没写；CI 没有桌面测试；桌面行为全靠 Mac 检查。
- 建议：用 Playwright 1.64 的 `_electron` 写一个冒烟测试：起应用，连上自己起的临时 daemon，断言 preload 的键和 renderer 里没有 node。Linux 用 xvfb 跑。macOS 先确认 `ci-user` 这个标准用户有没有 GUI 会话。
- 影响：约 80 行 spec，加一个 CI 步骤。能少用几次 Mac 检查。不改变产品承诺。置信度中偏低：xvfb 下我们的 Electron 能不能起来，要试过才知道。

### F13 无头网页检查（采纳思路，低优先级）；PR 截图评论不采纳

- Rakazo：`messaging-settings.spec.ts:9-14`（用 `page.route` 回 fixture），`helpers.ts:69-78`（截图按编号），`playwright-pr-screenshot-comment.ts:3-62`。
- 我们：`web.mjs` 只能截两页，fake bot 连不上，挂在 `requireRunningAgent` 后面的页面看不到。
- 建议：`web.mjs` 用 `page.routeWebSocket` 拦下几个 admin RPC，换成固定回复，这样清单、诊断这些页面就能看到"已连上"的状态；另外装一个用户级的中文字体。
- PR 截图评论不采纳：通知 owner 只用文字（`vonvon-collaboration.md`），审查者看 diff 就够了。
- 影响：约 40 行。不改变产品承诺。置信度低：admin 走的是 WebSocket，还没确认帧格式能不能这样替换。

### F14 消息平台设置、本机设置、预检分类：我们已有

- Rakazo：`MessagingSettingsOverlay.tsx:25-80`，`model-connection-preflight.ts:4-128`，`settings-shell.spec.ts:4-26`。
- 我们：`setup-steps.ts:40-80` 的每一步都有原因和动作；`diagnostics.ts` 的 `NOT_REPLIED_TEXT` 给每个原因配了固定文案和下一步；我们的错误文字多数是固定模板，不原样透传后端错误。Slack 接入在 Rakazo 那边靠环境变量配置，没有可借的引导。
- 一个小差别：`setup-steps.ts:53,54,63,70` 会把后端的原因原样放进 detail。没核对这些原因的长度和内容有没有限制，影响小，不另外开项。
- 置信度中。不改变产品承诺。

### F15 bot 整理（置顶、分组、拖拽排序）：不采纳

- Rakazo：`apps/web/e2e/bot-organization.spec.ts`。
- 我们：product.md 里没有对应的承诺，bot 数量也少。等 UI 轮看实际需要再说。
- 置信度高。不改变产品承诺。

## 7. 复用代码和许可

- 这次没有值得原样拷的代码。
  - `report.ts:123-134` 的 `redact()` 约 12 行，没有依赖，但它的规则针对 API key。我们要的是飞书的 `oc_`、`ou_`、`om_`、`cli_` 和 `/Users/<名字>`。重写比拷来再改更省事，所以按"采纳思路"处理（F5、F11 的报告用得上）。
  - `model-emulator.ts`（196 行）是 OpenAI SSE 格式，我们要模拟的是 Codex app-server（JSON-RPC）和 Anthropic，只借结构（F9、F10）。
- 以后真要拷代码，照 `packages/daemon/src/server/atomic-file.ts` 的先例做：
  1. 文件头写 "Adapted from elie222/rakazo <路径> at b884f43. Licensed under Apache-2.0; see NOTICE."；
  2. 根目录 NOTICE 加一段 Rakazo 的说明；
  3. 加 `packages/daemon/LICENSE.rakazo`，内容是 Apache-2.0 全文，参照 `packages/daemon/LICENSE.paseo`；
  4. 在文件里写明改了什么。
- 【确认】上游 LICENSE 是 Apache-2.0，没有写明版权行，也没有 NOTICE 文件，各 package.json 都声明 Apache-2.0。所以我们的 NOTICE 里写"Copyright the Rakazo authors"，不要编一个具体的版权人。

## 8. 没查的

- 没跑 Rakazo 的 e2e、评测和 emulator，所以第 4 节写的是源码和文档里的说法，没有验证实际效果。
- 飞书 applink 打开私聊的格式（F3），以及 `ANTHROPIC_BASE_URL` 加 SDK 自带 CLI 是否可行（F9），都没有查官方文档，也没有试。
- 没看 Rakazo 的移动端引导、`setup.spec.ts` 的完整断言，以及 golden.spec 513 行里每一个检查点的细节。
- 没统计我们的 fake app-server 兜底被多少测试依赖（F10）。
- 没核对 `ci-user` 用户在 Mac mini 上有没有 GUI 会话（F12）。
