# dm-agent-d2 计划：私聊回合

设计在 `dm-agent.md` 第 5 节，改名单在 3.3，被拒的人在 3.5，这里只写落到代码上的做法。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

管理员在私聊里直接跟 Bot 说话，就是一个完全访问的 Agent，和单会话群一样跑回合、排队、插话、`/new`、`/resume`。`/menu` 给老菜单。管理员被移出名单时，他的私聊马上停。依赖 D1（#706）、A1（#707）、F1（#705），都已合入集成分支。

## 2. 范围

做：p2p 分支的顺序、`askAnswered`、`isMenuCommand`、`sessionPlace`、`profileOf` 的 `dm` 行、挡路的群检查、`/resume` 只列自己的、`adminRemoved` 接通、删 `chatSettingsOn` 和 `settings_get/access/set`、私聊的 `tools.feishu`。

不做：拒绝文案和候选人记录（A2，留 `refuseDm` 一个调用点）；私聊记忆（D3）；`dmTurn` 权限表（C1）；定时任务（C2，私聊里定时工具仍然藏着，`authorizeSchedule` 仍拒绝）；页面（D4）。

## 3. 现在的代码

- `D/bot/handle-message.ts`：`handleMessage` 的 p2p 分支直接进 `handleDmConsole`，群的路由写在同一个函数里；9 处写死 `{ kind: 'group', chatId }`。
- `D/bot/ask-coordinator.ts`：`dmText` 吃掉提问期间的所有私聊文字；提问默认发到群、@ 人、敏感问题再发私聊副本。
- `D/agent/entry/registry.ts`、`command-tools.ts`：`chatSettingsOn`，三个设置工具。
- `D/admin/settings.ts`：`adminRemoved` 是 A1 留的可选回调，没人接；会话范围用 `listProjects` 找群，私聊行不在里面。
- `D/project/announcement.ts`：`refreshBranch` 按 `project.name` 写。

## 4. 怎么改

**路由。** `handleMessage` 里 `@门` 以下的内容拆成 `routeMessage(msg, project, smart)`，p2p 分支走完门之后调它，所以命令、会话键、`handleTurn` 和单会话群是同一条路。

**位置。** 叫 `sessionPlace(project, chatId)`，`placeOf` 这个名字已经被按消息取位置的函数占了。`dmOpen(project)` 看这一行记的这个人现在是不是管理员。

**自己的提问。** 私聊 Agent 问的问题发在它自己的窗口：`placement.own`，只有发起人能答，不 @、不发私聊副本，敏感问题也直接用表单。打字回答走主区的 `asks.typed`。别的群发来的问题卡，只有引用这张卡的消息才算回答（`carriers` 里查 `quoted`），所以不再需要"你有几个问题"的提示。

**`/resume`。** 只列 `rec.chatId === msg.chatId` 的记录的会话。`/new` 之后这条记录换了 sessionId，旧的就没人认了，所以 `SessionRecord` 加 `earlier`：这个键用过的原生会话，最多 50 个，`put` 和 `patchSession` 里维护。列表先取 200 条再过滤，取前 15 条。

**移出管理员（3.3）。** 名单写完门就关了，`endDmOf` 只收尾：`entries.revokeChat` 吊销这个私聊的所有令牌；清空队列；停掉正在跑的回合（`dropCompact`、`cancelIntake`、`state.interrupt`、`state.evicted`）；关掉活着的 thread。每一步失败只记日志。C2 暂停任务的位置留了注释。

正在准备中的回合不在 `state.interrupt` 上，靠下面几道门挡：

| 时机 | 门 |
| --- | --- |
| 建 thread 前后 | `createWithPermission`：没开门就不建；建好才发现就吊销、关掉，抛 `ThreadPermissionChanged(DM_CLOSED)` |
| 排着队轮到 | `launchRun` 循环：`preparePersonality` 之后看 `dmOpen`，不开就清队列、关 thread |
| `/goal` | `runGoal` 之前同样的门 |
| 进回合 | `handleTurn`、`startReservedRun` 的 `dmShut` |
| 卡片和表情 | `placeOpen`：私聊行看 `isAdmin`，群看 `isChatAllowed` |

**出错。** 私聊行没建好时回一句，不进回合。`ensureDmProject` 还没跑完时 `openDmChat` 先等 `dmReady`。停机时私聊和群走同一套：`dropped.json` 用真实 p2p id，重启后按 `sessions.json` 里的记录 resume。

**F1。** `profileOf` 里 `tools.feishu` 跟着 `schedule`，私聊行也开，下载目录按真实 p2p id。

## 5. 测试

`T/dm-turn.test.ts`：真的 orchestrator、session store、registry、entries，临时目录；假 backend、飞书、卡片、转写。

- 进门顺序：普通话进回合（位置 p2p、完全访问、私聊目录、`tools.feishu`）；bot 不理；非管理员在转写前被拒；`/menu`、`/settings` 给菜单不开回合；`/menus` 和语音进 Agent；私聊行没有时回一句；`allowedChats` 挡不住；两个人两条会话；provider 没有完全访问档时每次都说，`/menu` 还能用。
- 回合中：排队、插话、`/new` 等回合结束、表情停止后接着说、停机写 `dropped.json`、重启 resume。
- `/resume`：列自己的和 `earlier` 里的，别人的和没归属的不列。
- 移出：回合停、队列清、令牌吊销、窗口关；另一个管理员不受影响；建 thread 时移出；转写时移出；加回来后接着原会话；没有私聊的人什么也不发生。
- 单元：`T/ask-coordinator.test.ts`（`dmText` 只认回复卡、own 提问）、`revokeChat`、`earlier`、`fileClaimMode`、`isUserAllowedInProject`、`refreshBranch`、设置的会话范围、帮助卡的 `/menu`。

## 8. 验收要点

- 非管理员的语音在转写之前就被挡下，`fake.voice` 没被调用。
- 管理员的私聊里 `issue` 收到 `{ kind: 'p2p', chatId: <真实 p2p id> }`，不是 `oc_dm_<appId>`。
- 群的行为没变：`T/` 里群相关的测试不用改断言。
- 移出管理员后：令牌吊销、回合停、队列清，同一时刻准备中的回合也开不起来。
- 私聊 Agent 的提问不 @ 人，不发到别的管理员私聊。
- `/resume` 看不到别的管理员的会话。
- 设置工具和 `chatSettingsOn` 没有残留的调用方。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码约 500 行，测试约 500 行。风险在并发和关闭顺序：`endDmOf` 和准备中的回合竞争，靠第 4 节的几道门。`routeMessage` 是把现有代码搬出来，没改逻辑，审查时用 `git diff -w --color-moved`。
