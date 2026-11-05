# dm-agent-c2 计划：私聊里的定时任务

设计在 `dm-agent.md` 第 8 节和 6.3、6.4，产品行为在 `docs/product.md` 3.13"私聊里的任务"和第 6 节。这里只写落到代码上的做法。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

管理员在私聊里说"每天早上汇总一下这个群"：任务建在这个私聊，运行时发在这个私聊，能读能改设置，和本人在场时一样。也能让 Agent 用命令行给别的群、别的 Bot 建任务，建好就是普通群任务。管理员被移除时，他的私聊任务暂停。依赖 C1（#715，基线是它的分支）。

## 2. 范围

做：第 8 节全部；6.3 里任务回合的身份；6.4 的"跨 Bot 建的任务不记 open_id、失败提醒不 @"；`listBot` 带私聊标记；任务页和终端那一处"创建人已不是管理员"。

不做：私聊页面、`--dm`、任务页的"给哪位管理员的私聊"（D4）；`vonvon-schedule` 和 `vonvon-config` 的内容（C3）；调度算法；多个 chat 共享任务。

## 3. 现在的代码

- `D/admin/schedule-commands.ts`：`ScheduleActor` 四种；`execute` 里 `request.chatId !== actor.chatId` 答 `not-group`；`listBot` 只给 `local`。
- `D/agent/entry/registry.ts`：`tools()` 的任务工具只列给群；`authorizeSchedule` 私聊走 `dmTurn`；`scheduleActor` 看到 `facts.scheduled` 就是 `scheduled`；`dmTurn` 读 `facts.requesterOpenId`，定时回合现在是空的。
- `D/bot/handle-message.ts`：`placeScheduled` 写死 `chatType: 'group'`、`senderId: ''`；`scheduleGate` 只看 chat；`endDmOf` 末尾留了暂停任务的位置；`dmShut` 放过定时回合。
- `D/bot/schedule/scheduler.ts`：门是 `gate(chatId)`，`FailGate` 记一次失败。
- `D/server/authz.ts`：私聊的 `withinReach` 直通；`acrossBots` 管跨 Bot 的 id。
- `packages/ui/src/BotSchedules.tsx`：按 chat 分组，不认识的 chat 显示"已解绑的群"。

## 4. 怎么改

**协议。** `pausedReason` 加 `admin-removed`。`ScheduledTaskView` 加可选的 `dm: { name? }`，只在视图上，不存盘：有它就是这个 Bot 的私聊，`name` 是私聊里的人。

**命令核。** `ScheduleActor` 加

```ts
{ kind: 'dm'; via: 'chat' | 'cli'; openId?: string; name?: string; chatId: string; messageId?: string; text?: string }
```

`via`、`messageId`、`text` 是 `createdBy` 要的，和 `chat`、`session` 两种一样。`dm` 和 `local` 一样不查 `chatId`，能 `listBot`，能动这个 Bot 所有 chat 的任务，id 仍只在请求写的 chat 里找。`dm` 建的任务 `role: 'admin'`；没有 `openId`（跨 Bot）时也不写 `role`：第 13 节，那个人在目标 Bot 上不一定是管理员。

`deps.chatOf(chatId)` 回答这个 chat 是什么：`{ kind: 'dm', name? }`、`{ kind: 'group' }` 或 `undefined`。私聊的命令行能写任何 `oc_` id，范围又不查，所以 `dm` 建任务时要它不是 `undefined`，否则拒绝。私聊行自己的 `oc_dm_<appId>` 没有地方发，也算 `undefined`。它读项目文件，列表里一个 chat 只读一次。

**工具和这一轮。** `tools()` 把任务工具也列给私聊。`scheduleActor` 在 `p2p` 先判断，不管是人还是任务都给 `dm`；只有人发的消息才带 `messageId` 和 `text`。`authorizeSessionCall` 把它改成 `via: 'cli'`，不带 `text`，`sessionAuthzSchema` 收这一种。

**跨 Bot。** `acrossBots` 里，`schedule` 请求的目标不是会话的 Bot 时，去掉 actor 的 `openId` 和 `messageId`，留名字。

**运行。** `dmRunner(task, project)`：`createdBy.openId`，没有时取这个私聊的人（桌面端建的、别的 Bot 建的）。

- `placeScheduled`：`dm` 行 `chatType: 'p2p'`，`senderId` 是 `dmRunner`，`senderName` 是创建人的名字，于是 `facts.requesterOpenId` 就是创建人，`dmTurn` 成立。`newTopic` 在私聊里算主区（第 8 节"不开话题"）。一次性任务回话题照旧。
- 无人回合的文字不用改：`scheduledHeader` 只说没人在场。
- `dmShut`：去掉定时回合的豁免，移除和运行撞上时结算成跳过。

**门。** `gate(chatId, task)`。`dm` 行要这个私聊的人和 `dmRunner` 都还是管理员，否则 `admin-removed`：记一次失败"创建人已不是管理员"，同时暂停，不通知。正常情况下移除时已经暂停了，这里接住暂停写失败和 Bot 没在运行时被移除的情况。手动运行同样记失败。

**移除。** `endDmOf` 收尾调 `pauseDmTasks`：这个人的私聊里的、和他在别人私聊里建的，`active` 的改成 `paused`、`admin-removed`。失败只记日志（3.3）。群任务不动。加回来不恢复，和其他暂停一样手动恢复。

**提醒。** `notifyAutoPause`：私聊不 @，恢复的地方写"跟我说一声，或者到 Bot 页的'任务'里"；群任务没有 `openId` 但有名字（跨 Bot 建的）时写名字，不 @。`notifyGateFailure` 的"本群"在私聊写"私聊"。

**界面。** 任务页和终端加"创建人已不是管理员"。`scheduleGroups` 有 `dm` 时分组名是"私聊 · 张三"，没有页面可开，和已解绑的群一样只有删除。`vonvon schedule list --all` 显示"私聊 · 张三（oc_…）"。

**出错和停机。** 建任务走现有的写入路径。暂停写失败只记日志，门会接住。Bot 停着时命令答 `bot-not-running`，不变。

## 5. 测试

- `T/schedule-commands.test.ts`：`dm` 的 `list`、`listBot`、别的 chat、`createdBy`（有 `openId`、没有）、不认识的 chat 被拒、`oc_dm_` 被拒、私聊的上限文字、`dm` 视图标记；群的 `not-group` 不变。（main 必败）
- `T/schedule-authorize.test.ts`：私聊列出 7 个工具；建任务落在这个私聊；任务回合能建能改别的任务；创建人不是管理员时拒绝；评论的 `not-group` 还在。（main 必败）
- `T/agent-entry-session.test.ts`：私聊命令行的 actor 是 `dm`、`via: 'cli'`，任务回合不带 `messageId`。（main 必败）
- `T/authz-session.test.ts`：跨 Bot 去掉 `openId`，同一个 Bot 留着。（main 必败）
- `T/schedule-scheduler.test.ts`：`admin-removed` 的门记一次失败并暂停，不通知；一次性任务也是暂停；手动运行记失败。（main 必败）
- `T/dm-schedule.test.ts`：真的 orchestrator：任务发在私聊主区，`p2p` 入口，回合的发起人是创建人；`newTopic` 也在主区；没有 `openId` 的按这个私聊的人跑；门；移除暂停私聊任务、不碰群任务、加回来不恢复；`listBot` 的名字。（main 必败）
- `T/scheduled-auto-pause.test.ts`：私聊不 @，跨 Bot 的群任务写名字。
- `T/schedule-cli.test.ts`、`packages/ui/test/bot-schedules.test.tsx`：文案和分组名。

## 8. 验收要点

- 群里调任务工具的行为不变：`group` 分支的 `authorizeSchedule` 和 `scheduleActor` 没动。
- `dm` actor 只来自 `p2p` 的入口；IPC 的 schema 只收 `via: 'cli'`，`local` 仍然进不来。
- 跨 Bot 建的任务 `createdBy` 没有 `openId`、`messageId`、`role`。
- 私聊任务回合 `requesterOpenId` 是创建人，`dmTurn` 放行；创建人不是管理员时门不放行，工具也拒绝。
- 移除管理员只暂停私聊任务，群任务不动；加回来不自动恢复。
- 私聊任务不开话题。
- `dm` 字段不进 `schedules.json`。
- 评论的 `not-group` 还在。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码 +151 -61，测试约 +520 -25（含新文件 `T/dm-schedule.test.ts`）。风险在合入门禁和错误路径一类：`dm` actor 绕过了 chat 检查，要多角度审查。最容易漏的是跨 Bot 留下 open_id，和定时回合的发起人是空的，第 8 节都列了。

## PR 描述草稿

### 用户能看到的变化

- 管理员在私聊里说"每天早上汇总一下这个群"，任务建在这个私聊，到点发在这个私聊的主区，不开话题；运行时和本人在场时一样，能读能改设置。
- 私聊里能让 Agent 用 `vonvon schedule add --bot B --group X` 给别的群、别的 Bot 建任务。建好就是普通群任务，发在群里，按群的权限档跑。别的 Bot 建的任务不记 open_id，失败提醒写名字，不 @。
- 管理员被移除时，他的私聊任务暂停，任务页和终端显示"创建人已不是管理员"。加回来以后手动恢复，不自动恢复。群任务不动。
- 任务页和 `vonvon schedule list --all` 带上私聊任务，标"私聊 · 张三"。D4 之前没有私聊页面，这一组只能删除。
- 私聊任务连续失败暂停时，提醒不 @，写"跟我说一声，或者到 Bot 页的'任务'里能恢复"。

### 试用步骤

1. 管理员私聊 Bot："两分钟后提醒我喝水"。到点在私聊主区收到结果，没有话题。
2. 私聊："每天 9 点把今天要做的写到设置里的 XX"这类要改设置的任务，手动运行一次，确认能改。
3. 私聊："给 Bot B 的 X 群建一个每天 9 点的任务"。到 B 的任务页看任务在 X 群下，发在群里。
4. 桌面端 Bot 页的"任务"里看到"私聊 · 张三"一组。
5. 到"设置 → 管理员"移除这个人：任务页显示"已暂停：创建人已不是管理员"，不再运行。加回来，任务仍是暂停。
6. 群里调任务工具、评论里调任务工具，行为都不变。

### 跑过的命令和结果

@@RESULTS@@

### 和计划不一样的地方

相对 `dm-agent.md` 第 8 节，都是技术上的补充：

- `ScheduleActor` 的 `dm` 比设计多 `via`、`messageId`、`text`：`createdBy` 要它们，和 `chat`、`session` 两种一样。
- 加了 `dmRunner`：任务回合的身份是 `createdBy.openId`，没有时取这个私聊的人。桌面端和别的 Bot 建的私聊任务没有 open_id，不这样 `dmTurn` 不成立。
- 门从 `gate(chatId)` 改成 `gate(chatId, task)`。设计只写了 `endDmOf` 暂停；门另外接住暂停写失败和 Bot 没在运行时被移除的情况：记一次失败，暂停，不通知。
- 加了 `deps.chatOf`：私聊的命令行能写任何 `oc_` id，范围又不查，所以 `dm` 建任务时 chat 必须是这个 Bot 的群或私聊，否则拒绝。私聊行自己的 `oc_dm_<appId>` 也拒绝。
- `ScheduledTaskView` 加可选的 `dm: { name? }`，只在视图上，不存盘，给任务页和终端分组用。
- 跨 Bot 除了 `openId`，也去掉 `messageId`（那条消息在另一个 Bot 上不存在）。`createdBy.role` 同样不写：第 13 节，那个人在目标 Bot 上不一定是管理员。
- 移除时也暂停他在别的管理员私聊里建的任务，不然门到点才暂停，多记一次失败。
- `notifyAutoPause` 改了私聊的文字；群任务没有 `openId` 但有名字时写名字。设计只说不 @。
- 设计写的 `vonvon schedule create`，实际命令是 `vonvon schedule add`。C3 的 skill 要写 `add`。
- 回合的 `requesterKind` 留在 `unknown`，记忆按 Bot 写的算，不改。

### 还没验过的项

- 没有在真飞书上跑过：私聊建任务、到点发在私聊、移除管理员、跨 Bot 建任务。都是用真 orchestrator 加假 channel 测的。
- 桌面端的"私聊 · 张三"只有组件测试，没有在真窗口里看过。
- macOS、Windows 没跑，全量测试留给 CI。

### 独立审查结论

待 Codex 审查

### Mac 检查次数、等 owner 时长、等额度时长

0、0、0。
