# T3 和 T3b：agent 工具、钥匙和两家的通路（两个 PR）

## 1. 做什么

让 agent 在聊天里建、改、停、删任务：schedule 类工具和角色表、grant 现取话题、Claude 的进程内 MCP 加工具、Codex 用 app-server dynamicTools 收工具并把调用绑到这一轮、关掉两家自带的定时。做完这一片，群里对 bot 说"每天 9 点发日报"就能建任务，bot 也能给自己排"20 分钟后回来看"。总设计第 3、9、10、16 节；产品行为 3.13、3.7。基线 T1b 合入后的 `dev`（和 T2 并行；自测第 4 步要 T2，见第 2 节）。

本计划分两个 PR（第 9 节估约 1,545 行，过了 1,500）：

- **T3**（分支 `codex/scheduled-tasks-3-tools`）：工具类和角色表、grant 的 `where()`、`requesterName`、`profileOf` 算 `tools.schedule`、Claude 的进程内 MCP 加工具、关 Claude 自带定时。合入后 Claude 会话的 bot 能在聊天里建任务；Codex 会话还没有任务工具，也不装 skill（T4b 等 T3b）。
- **T3b**（分支 `codex/scheduled-tasks-3b-codex`）：Codex 的 dynamicTools 和 `item/tool/call`、调用按 turnId 绑轮、删 `releaseAfterRun` 授权分支、features 深合并关 Codex 自带自动化。同一个 Codex 会话在 T3 的分支上接着写，T3 合入后 merge `dev` 再开 PR。

下文标【T3】或【T3b】的只属于那个 PR，没标的两个都适用（T3b 只需不破坏它）。

## 2. 范围

- 【T3】新文件：`D/agent/entry/schedule-tools.ts`。
- 【T3】改：`D/agent/entry/{registry,tools,command-tools,ipc-codec}.ts`（registry 只加 schedule 类、`authorizeSchedule`、`where`、actor，不动 169-170 的授权 pick）、`D/agent/types.ts`（拒绝原因枚举）、`D/agent/claude-agent/{backend,thread}.ts`、`D/agent/group-skills.ts`、`D/agent/session-profile.ts`（`tools.schedule`，由 `profileOf` 算，见 4.5）、`D/config/execution.ts`（`executionSessionProfile` 带上 `tools`）、`D/bot/bridge.ts`（`createCommandTools` 的依赖加命令核）、`D/bot/handle-message.ts`（`launchRun` 把 `where()`、在场事实和 `requesterName` 交给 `openTurn`/grant；`QueuedTurn`、`LaunchOpts` 加 `requesterName`）。
- 【T3b】新文件：`D/agent/codex-appserver/dynamic-tools.ts`。改：`D/agent/codex-appserver/{backend,server-requests,memory-config}.ts`、`D/provider/transport/jsonrpc.ts`（`peer.onRequest` 加 `item/tool/call`）、`D/agent/entry/registry.ts`（只删 169-170 的 `releaseAfterRun` 分支）。
- 可以假设：T1b 的命令核、`ScheduleActor`、`TurnFacts.scheduled` 和 `TurnAuth.presence`。不依赖 T2，和 T2 同时开工；只有自测第 4 步（定时回合里改自己）要 T2 的 `runScheduled`，T2 没合入就先做别的步骤，T2 合入后 merge `dev` 再补这一步。
- 不做：skill（T4a/T4b，本片的工具没有说明书，agent 只看工具描述）；桌面端（T5）；设置和飞书工具改走 dynamicTools（s46b 另定）；Codex 的 memory 工具。
- 不改 3.7 的设置规则：只有私聊、只有主人和管理员、开关。

## 3. 现在的代码

- 登记表：`D/agent/entry/registry.ts`，`createAgentEntries`（grant、`TurnAuth`、`firstTurn`、origins、`authorizeNow`（105）/`authorizeMemory`、`roleOf`、`openTurn` 313-323、`noteSteer` 333-339、70 秒 deadline、commit guard）；工具按类过滤在 294（settings 只给 `p2p`）；授权的 pick 在 169-170：**Codex（`releaseAfterRun !== undefined`）的每一次调用都按 `grant.firstTurn` 授权**，Claude 按 `origins.get(toolUseId)`；`noteToolUse`（298）把 toolUseId 记到当前 `grant.turn`。
- 工具类：`D/agent/entry/tools.ts:24` 的 `class: 'read' | 'settings' | 'memory'`；s47 的 `command-tools.ts:13、109` 把结构化命令包成工具；`D/bot/bridge.ts:80` 给 `createCommandTools` 传依赖。
- 拒绝枚举：`D/agent/types.ts:367` 的 `AgentToolReply.reason` 和 `D/agent/entry/ipc-codec.ts:9` 的 zod 枚举，两处要一起加。
- 签发：`handle-message.ts:1339` 的 `createWithPermission` 在 `entries?.issue(place)` 发 grant；`place` 今天是群级 `{ kind: 'group', chatId }`，没有话题；bot 开的话题（3953）起线程时话题还不存在，`adoptThreadId`（7437）之后才有 thread id；`launchRun` 的 `topicThreadId` 局部变量是认领后的话题 id。
- Claude：`D/agent/claude-agent/thread.ts:327-343` 组 MCP server `vonvon_bot`（`entry.tools()` → `tool(...)`，`_meta['claudecode/toolUseId']` 做 origin，466/471 处 `noteToolUse`）；`:345-371` 组 query 选项（`:364` `...cfg.permission`、settings 用 `AUTO_COMPACT_SETTINGS`）；`backend.ts:97` 的 `sessionClaudeEnv` 已有 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY`；`permission.ts:90` 完全访问档提前返回；`group-skills.ts:92-99` 的 `enabledNames` 白名单。SDK 0.3.296 的 `sdk.d.ts` 有 `disallowedTools`、`settings.skillOverrides`。
- Codex：`D/agent/codex-appserver/backend.ts:78-104` 的 `codexSessionParams`（`config.features` 三处 spread：sandbox 的、`...NATIVE_MEMORY_OFF`、Windows 覆盖）、`362-368` `turn/start` 的应答（`result.turn.id`）、`752-772` 是 `isAlive`/`close`/`profileCapabilities`/`listSkills`（**不是 firstTurn 绑定**）；`server-requests.ts:70` 的 `CodexRequestScope`、`:132` `approvalAnswer`、`:148` `userInputRequest`；分发在 `D/provider/transport/jsonrpc.ts:301-308` 的 `peer.onRequest`，今天只认 `item/tool/requestUserInput`（`app-server-client.ts` 只 re-export）；`memory-config.ts` 的 `NATIVE_MEMORY_OFF`；`session-profile.ts:4-45`。
- 生成类型：`D/agent/codex-appserver/protocol/generated/v2.ts` 的 `DynamicToolSpec = { namespace?, name, description, inputSchema, deferLoading? }`（扁平形状，和实测的 namespace 形状不同）；`ThreadStartParams` 没有 `dynamicTools`；`protocol/index.ts:5` 指的 `npm run codex:protocol:update` 不存在。
- 实测记录（`docs/research/2026-10-30-scheduled-tasks/notes-tools.md`，随总设计 PR 提交）：0.156.1 和 0.163.0 的 `thread/start.dynamicTools` namespace 形状可用，只读沙箱、`approvalPolicy: never` 下 `item/tool/call` 来回正常；resume 从盘上恢复工具；不能往已有线程加；`deferLoading` 要 namespace 形状。探测用的假 provider 没挂 ChatGPT 连接器。
- 会话里的工具调用从哪条会话来：Claude 靠 server 实例绑会话；Codex 靠 `threadId`。
- zod：daemon 4.6（`z.toJSONSchema`），protocol 3.25；`tools.ts` 的 `input: z.ZodObject` 是 zod 4。

## 4. 怎么改

### 4.1 【T3】工具定义：`schedule-tools.ts`

【T3】一份 zod 4 定义导出两样东西：给 Claude SDK MCP 的 tool 列表（`AgentTool[]`，`class: 'schedule'`），和不带任何 Codex 类型的 `scheduleToolSpecs(): { name: string; description: string; inputSchema: object }[]`（JSON schema 用 `z.toJSONSchema(input)`）。T3b 的 `dynamic-tools.ts` 把它包成 `DynamicToolNamespace`，所以 T3 不依赖 T3b 的文件。名字、入参（含 `when`、`where: 'here' | 'thisTopic' | 'newTopic'`、`timeZone?`）、回复和描述按总设计第 10、16 节。`when` → `spec` 的换算：`once.at` 字符串经 `parseLocal(tz, at)`，`inMinutes` 经 `now + m × 60_000`；换算失败回 `bad-schedule` 带 `validateSpec` 的文案。`where` → `placement`：`here` 且 `grant.where().topicId` 在且 `when.kind === 'once'` → `{ kind: 'topic', topicId }`；`here` 其余 → `follow`；`thisTopic` 且 `where().inTopic`、`topicId` 在 → `topic`；`inTopic` 但 `topicId` 还没有（bot 刚开的话题还没认领）→ `topic-pending`；不在话题里（主区）→ 按 `here` 算，不拒；`newTopic` → `newTopic`。

回复文本给 agent 看的是人话加 JSON：第一行一句（第 16 节），下面 JSON 原样。拒绝回 `refused` 和一句中文原因，不抛错。

### 4.2 【T3】登记表和钥匙

- `ToolClass` 加 `'schedule'`。`authorizeSchedule(auth, action)`：按 3.13 的表和总设计第 8 节"在场"，在登记表这一层先查一遍，拒绝不进队列（命令核再查第二遍，两层都不信调用方）：`presence === 'human'` 且 `auth.human`（没被别人插话）→ 全部；`presence === 'scheduled'` → `list`、改自己、删自己；`presence === 'none'` 或 `auth.steered` → 只 `list`，写回 `not-human-turn`。
- grant 的 place 不加 `topicId`；grant 加 `where: () => { inTopic: boolean; topicId?: string }`（`registry.ts` 的 `Grant` 今天没有话题字段，新加），`launchRun` 在 `openTurn` 时把闭包交进去：`() => ({ inTopic: !isMainKey(activeKey, chatId), topicId: topicThreadId && !isMainKey(topicThreadId, chatId) ? topicThreadId : undefined })`，读的是认领后的局部变量：`activeKey`（`handle-message.ts:7176`）在主区是 `chatId`（`isMainKey`，1750），在 bot 新开的话题里先是 `pending:<replyTo>`、`adoptThreadId` 后是 thread id，所以 `inTopic` 一开始就对；`topicId` 要卡片发出去、`adoptThreadId` 之后才有值。
- actor 的组装在登记表里，不在工具里：`{ kind: 'chat', openId, name, role, chatId, topicId: where().topicId, messageId: triggerMessageId, text: typed ? triggerText : undefined }` 或 `{ kind: 'scheduled', taskId, runId, chatId }`。`name` 从 `openTurn` 的 facts 带，本片自己接：`TurnFacts` 加 `requesterName?: string`；`QueuedTurn`、`LaunchOpts` 跟着 `requesterOpenId` 加 `requesterName`，入队处取 `names.peek(msg.senderId) ?? msg.senderName`（同 `senderWho`，`handle-message.ts:1746`）；`launchRun` 的 `openTurn`（7356）传 `currentTurn.requesterName`。没有名字就不填，总设计 7.2 的 `{creator}` 按 `via` 兜底。
- 带不带 schedule 类只看 `profile.tools.schedule`（4.5）；登记表这层是第二道：`tools()` 的过滤加 `grant.place.kind === 'group'`，私聊和评论会话的调用回 `not-group`。
- 过 s46 的接纳、排队、提交点三道检查；`schedule_create` 在提交点用 `ctx.commit(guard => …)`。
- 枚举：`types.ts:367`、`ipc-codec.ts:9` 加 `'not-group' | 'not-human-turn'`（schedule 的其余拒绝在命令核的 reply 里，不在这层枚举）。
- `bridge.ts:80` 给 `createCommandTools` 传 `schedule: commands`（T1b 的命令核）。

### 4.3 【T3】Claude

- `vonvon_bot` MCP server 加 schedule 类工具：`profile.tools.schedule` 为真才带（4.5），再经 `entry.tools()` 按 grant 过滤。
- `thread.ts` 加 `NATIVE_SCHEDULING_TOOLS = ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger']`，组 query 选项时在 `...cfg.permission` 之后合并 `disallowedTools: [...(cfg.permission.disallowedTools ?? []), ...NATIVE_SCHEDULING_TOOLS]`。放 thread.ts 不放 `permission.ts`：`permission.ts:90` 完全访问档提前返回，放那里会被跳过。
- `AUTO_COMPACT_SETTINGS` 和它的 plan 变体加 `skillOverrides: { loop: 'off', schedule: 'off' }`。`group-skills.ts` 的 `enabledNames` 也把这两个过滤掉（白名单里点名它们能不能压过 `off` 没测，两边都做）。
- `sessionClaudeEnv` 加 `CLAUDE_CODE_DISABLE_CRON: '1'` 做第二道。
- 验证：起一条真实会话，让它列工具和 skill，五个工具不在、`loop`/`schedule` 不在；让它试着排一次，期望说没有工具。

### 4.4 【T3b】Codex：dynamicTools 和调用绑轮

- `dynamic-tools.ts`：手写类型 `DynamicToolNamespace = { type: 'namespace'; name: 'vonvon_bot'; tools: { name; description; inputSchema; deferLoading?: boolean }[] }`、把 T3 的 `scheduleToolSpecs()` 包成它的 `scheduleNamespace()`，和 `ThreadStartParams & { dynamicTools?: DynamicToolNamespace[] }` 的扩展；不改生成文件；在文件头注明生成脚本缺失、这是手写的补丁。
- `backend.ts` 的 thread/start 带 `dynamicTools`（`profile.tools.schedule` 为真才带，4.5；为假就不带这个字段）。resume 不带（盘上恢复）。
- **调用绑轮**：`turn/start` 的应答（`backend.ts:363`）拿到 `result.turn.id` 就 `this.entry?.noteToolUse(turnId)`，并 resolve 一个按 turnId 存的 `turnAcked` promise。`server-requests.ts` 加 `dynamicToolCall(params, id, scope, lookup)`，`jsonrpc.ts:301` 的 `peer.onRequest` 加 `method === 'item/tool/call'` 分支：按 `threadId` 找会话（找不到回 `success: false`"不是本 bot 的线程"）、`await thread.turnAcked(params.turnId, 2000)`（没到就当 `unknown-origin`）、按 `tool` 找入口、`arguments` 过 zod、`entry.call(tool, args, { toolUseId: params.turnId })`（和 Claude 共用 `callTool`），回 `{ contentItems: [{ type: 'inputText', text }], success }`；未知工具回 `success: false` 加一句。`callId` 记日志。线程关闭时 `CodexRequestScope.close()` 照样把挂着的调用答掉。
- `registry.ts:169-170` 删掉 `releaseAfterRun` 分支，两家都 `origins.get(origin.toolUseId)`；`firstTurn` 字段不再用于授权（留着也行，但没有读者就删）。goal 运行（`launchGoalRun`）和子线程不调 `openTurn`，查不到 origin → `unknown-origin` → 拒，正好。
- 上线前已开着的 Codex 会话没有工具，下一条新会话才有；3.13 已写明。Codex 不拿 `session_info`，第 16 节那一行不做；本片不做"换会话"。
- 关掉自带自动化：`codexSessionParams` 的 `config.features` 改成一处深合并（总设计 9.2），`memory-config.ts` 旁加 `NATIVE_SCHEDULING_OFF = { features: { in_app_local_automation: false } }`。真实 ChatGPT 登录下的工具表在自测第 7 步看。

### 4.5 【T3】`session-profile.ts`

`SessionProfile` 加 `tools: { schedule: boolean }`，`resolveSessionProfile` 缺省 `false`。由 `handle-message.ts:1114` 的 `profileOf` 算：`schedule: Boolean(project) && place !== 'comment'`——绑定的群会话为真，主区和话题都是，只读档也是（3.13：建任务不看档）；评论会话（`place === 'comment'`，没有 `project`）为假；私聊今天不起 agent 会话（`handleDmConsole`），以后的私聊会话也为假。这是唯一的开关：Claude backend（T3）和 Codex backend（T3b）按它带不带 schedule 类工具，T4b 按它装不装 skill；T3 里 Codex backend 还不读它。`executionSessionProfile`（`config/execution.ts:245`）和 `resolveSessionProfile` 都逐字段重组 profile，两处都把 `tools` 带过去。

## 5. 测试

main 必败：

- 【T3】schedule 类、`where()` 在基线不存在；基线的 query 选项里没有 `disallowedTools` 的五个名字、settings 里没有 `skillOverrides.schedule`（这两条基线能跑出来，记"main 必败：会话能看到 CronCreate"）。
- 【T3b】`dynamic-tools.ts`、`item/tool/call` 处理、`turnAcked` 在基线不存在；`registry.ts:169` 的 `releaseAfterRun` 分支在基线会把 Codex 第二轮的调用授权成第一轮（"main 必败：Codex 第二轮按第一轮的人判"）。

测试文件：

- 【T3】`schedule-tools.test.ts`：七个工具的入参校验（`when.once.at: '2026-11-01 14:00'` → `spec.once.at` 等于 `parseLocal` 的值；`inMinutes: 20` → `now + 20 分钟`；`at: '2026-13-01 00:00'` → `bad-schedule`）；回复第一行逐字；`scheduleToolSpecs()` 有七项、每项 `inputSchema.type === 'object'`；拒绝不抛错。
- 【T3】`schedule-where.test.ts`：`where: 'here'` 在主区（`where()` 回 `{ inTopic: false }`）→ `follow`；在话题、`once` → `topic`；在话题、`every` → `follow`；`thisTopic` 在话题 → `topic`，在 bot 刚开、还没认领的话题（`{ inTopic: true }`）→ `topic-pending`，在主区 → `follow`（和 `here` 一样，不拒）；`newTopic` → `newTopic`；`where()` 在主区回 `{ inTopic: false }`，bot 开的话题认领前回 `{ inTopic: true }`、认领后带 thread id（用 `launchRun` 的夹具）。
- 【T3】`schedule-authorize.test.ts`：角色表每一格（owner/admin 全部；member 自己的能、别人的 `not-task-owner`；scheduled 建 `no-human-create`、改别的 `scheduled-run-scope`、list 只有自己；`presence: 'none'` 写 → `not-human-turn`、list 可以；被别人插话（`noteSteer`）后写 → `not-human-turn`；私聊 `not-group`；评论会话 `not-group`）；提交点回合已结束不写；两层各一遍（登记表拒了命令核的 spy 没被调；绕过登记表直接调命令核也拒）。
- 【T3】`claude-schedule-entry.test.ts`（锁定 SDK 的假传输）：工具在 `vonvon_bot` 里，`profile.tools.schedule` 为假时没有，grant 是私聊时也没有；三档的 query 选项都带五个 `disallowedTools`，已有的 `cfg.permission.disallowedTools` 不丢；settings 带 `skillOverrides.loop/schedule = 'off'`；`enabledNames` 过滤掉 `loop`、`schedule`；env 有 `CLAUDE_CODE_DISABLE_CRON`。
- 【T3b】`codex-dynamic-tools.test.ts`（假 app-server）：thread/start 带 namespace 形状；`profile.tools.schedule` 为假不带字段；resume 不带；`item/tool/call` 来回、未知工具、zod 不过、按 threadId 找错会话拒、线程关闭时挂着的调用被答掉；`config.features` 同时有 `memories: false`、`in_app_local_automation: false`，Windows 非完全访问还有 `prefer_mxc: false`。
- 【T3b】`codex-turn-origin.test.ts`：两轮各一个 `turn/start` 应答 → 第二轮的 `item/tool/call`（`turnId` 是第二轮的）按第二轮的 `TurnAuth` 授权（main 必败）；`turn/start` 应答还没到时调用等到它；2 秒没到 → `unknown-origin`；goal 线程的调用 → `unknown-origin`。
- 【T3】`schedule-profile.test.ts`：`profileOf` 对绑定的群（只读档也算）给 `tools.schedule: true`，评论会话给 `false`；`executionSessionProfile` 加了附加根后 `tools` 还在；`tools.schedule` 为真时 Codex 的 `thread/start` 参数里也没有 `dynamicTools`（T3 里 Codex backend 不读它，T3b 再改这条断言）。
- 回归定向：【T3】agent-entry-registry、agent-entry-commit、claude-agent-entry、s47-tools、memory 工具授权；【T3b】codex-backend、codex-jsonrpc、agent-entry-registry、memory 工具授权。

## 6. Codex 的自测

JP-VPS，用验收 daemon（Bot 6）。用哪家是群绑定时定的（`vonvon group bind --tool claude|codex`），不是 bot 的设置：从 `test-chats.json` 的登记和 `projects.json` 的当前绑定里挑 Bot 6 绑在 Claude 上的测试群和绑在 Codex 上的测试群，单会话和多会话各要一个（chat id 不打印）；缺哪种就按 #422 正文第 4 节新建测试群、用 `--tool` 绑好并补登记。【T3】在绑 Claude 的群里做第 1 到 6 步和第 8 步；【T3b】在绑 Codex 的群里重做第 1 到 5 步，再做第 7、8 步。锁、临时目录、删除规矩和 lark-cli 的用法同 T2 第 6 节，原文照抄：

- 先拿目录锁：`mkdir /tmp/accept-user.d`，失败就等；拿到后 `echo "<任务号> $(date -u +%FT%TZ)" > /tmp/accept-user.d/owner`；用完 `rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 发消息用 `say.py`（jojo，`--as user`），读用 `lark-cli im +messages-list --as user --chat-id <登记的 chatId>`；看任务用 `VONVON_HOME=/home/operator/vonvon/accept-home2 vonvon schedule list --bot … --group … --json`。
- 步骤：
  1. 主人在单会话群说"@Bot 6 每天早上 9 点发一份日报，内容是今天群里聊了什么"：bot 调 `schedule_create`，回复里有名字、"每天 09:00"、下一次时间和时区；`schedule list --json` 看到它，`placement.kind` 是 `follow`。
  2. 成员（第二个测试账号；没有就让 owner 的另一个 bot 账号发，不行记"待 owner 验收"）说"把日报删了"：bot 调 `schedule_delete` 被拒 `not-task-owner`，回复里有第 16 节那句。
  3. 多会话群的话题里说"@Bot 6 20 分钟后回来看这个"：bot 建 `once`，`placement.kind` 是 `topic`；用 `schedule edit` 改成 2 分钟后，看它回到这个话题。同一个话题里说"每天 9 点在这里发日报"：建出来的是 `follow`（下一次会开新话题）；再说"就在这个话题里每天 9 点发"：是 `topic`。
  4. 定时回合里让 bot 给自己再排一次（任务内容写"做完后把自己这个任务改到 2 分钟后"）：`schedule_edit` 自己这一个成功，`runs` 里看到第二次运行；任务内容写"建一个新任务"：拒 `no-human-create`，回复里有那句。
  5. 跨群：在群 A 把群 B 一个任务的 id 贴给 bot 让它删：拒 `not-found`。
  6. 【T3】Claude：问"你有 CronCreate 吗，有 schedule 或 loop 这两个 skill 吗"，期望都没有；让它用 Cron 排一次，期望说没有工具。
  7. 【T3b】Codex（JP-VPS 的 Codex 是真实 ChatGPT 登录）：一条 T3b 部署前就开着的旧会话里做第 1 步，期望 bot 说没有这个工具；问"把你能用的工具全列出来，只列名字"，结果里有没有 automation、schedule、cron、reminder 这类名字，有就记下来贴 PR，由审查者决定加进关闭名单。
  8. 自测完换回 `dev`，放锁。
- 打码同 T2。

## 7. 文档

- `docs/v1-plan.md`：T3、T3b 两行各写做法和实际行数；`docs/plans/s46.md` 不改，总设计 9.2 已记 dynamicTools 的实测推翻了它 4.1 的 E 项。
- 3.7 的 Codex 通路已在 product.md 改；本片和它对不上的在 PR 写明。

## 8. 验收要点

- 【T3】工具不收群参数；群从 grant 取，话题从 `where()` 现取；跨群没有任何入口（登记表和命令核两层都测了 `not-found`）。
- 【T3】角色表两层都查，测试各覆盖一遍；被插话的回合和无发起人的回合不能写。
- 【T3】定时回合不能建任务、不能碰别的任务；话题里的周期任务默认跟群走，`thisTopic` 才留在话题；主区里的 `thisTopic` 按 `here` 算，还没认领的话题回 `topic-pending`。
- 【T3】Claude 三档的 query 选项都带五个 `disallowedTools`，`loop`、`schedule` skill 关着，真实会话里看不到。
- 【T3b】Codex 的 `config.features` 深合并后三个开关都在。
- 【T3b】Codex 的 dynamicTools 只在 thread/start 带，resume 不带；`item/tool/call` 按 threadId 找会话、按 `turnId` 绑轮，找错拒；`registry.ts` 没有 `releaseAfterRun` 分支了。
- 【T3b】真实 ChatGPT 登录下的工具表看过，结果贴在 PR。
- 【T3b】生成的协议文件没改；手写类型文件头写明原因。
- 【T3】T3 合入后 Codex 会话既没有任务工具也不装 skill（T3 里 Codex backend 不读 `tools.schedule`）。
- 不碰 Mac 的环境。diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：子进程（Codex 服务端请求的分发）、并发（提交点、`turnAcked` 的等待）、错误路径（拒绝不能变成异常让回合挂掉）、权限（`where()` 不能扩大到别的话题）。按 `AGENTS.md` 加一轮多角度审查。预计生产约 735 行（schedule-tools 220、registry 150、claude 60、codex 220、profile/bridge/枚举 50、`requesterName` 透传和 `execution.ts` 透传 35）、测试约 760 行（含 `schedule-profile.test.ts`）、文档约 50 行，总计约 1,545，过了 1,500，所以按第 1 节直接开两个 PR，不停下来问：

- T3 约 1,055：生产约 505（schedule-tools 220、registry 140、claude 60、profile/bridge/枚举 50、`requesterName` 和 `execution.ts` 透传 35），测试约 520（第 5 节标【T3】的五个文件），文档约 30。
- T3b 约 490：生产约 230（codex 220、registry 删分支 10），测试约 240（两个 codex 测试文件），文档约 20。

各按标【T3】【T3b】的测试、自测和验收要点做；T4b 等 T3b。自审不代替独立审查；不冻结、不合入。
