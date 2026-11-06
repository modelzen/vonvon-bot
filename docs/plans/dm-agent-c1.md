# dm-agent-c1 计划：权限表

设计在 `dm-agent.md` 第 6 节，这里只写落到代码上的做法。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

私聊 Agent 的 `vonvon` 命令行能管这台电脑上所有 Bot，不用 `--scope`；碰注册、凭据、服务、安装、密钥、配对和管理员名单时被拒，拒绝文字说去哪里做。依赖 D2（#710，基线就是它的分支）。

## 2. 范围

做：6.1 范围、6.2 权限表、6.3 `dmTurn`、6.4 飞书 id 跨 Bot、`session_info` 的 `settings` 和 `authz.ts` 里过时的注释。

不做：私聊记忆（D3）；定时任务（C2，表里已是 `bot`，工具还藏着，只留了接口）；跨 Bot 的飞书路由和 `vonvon feishu members`（F2）；Skill（C3）；页面（D4）。

## 3. 现在的代码

- `D/server/authz.ts`：`RULES` 每行三格；`withinReach`、`checkSessionScope` 按 Bot 和群查范围；`sessionActionOf` 把 ★ 请求翻成问 Bot 进程的动作；`sessionView`、`sessionReply` 给私聊裁读到的内容。
- `D/server/snapshot-filter.ts`：私聊用 `filterSnapshot`，只看自己的 Bot。
- `D/agent/entry/registry.ts`：`authorizeNow`、`adminTurn`、`authorizeSchedule` 各判一遍；`memory` 只认这个 Bot 的项目。
- `D/project/lifecycle.ts`：`createProject` 用 `ownerOpenId` 拉人。
- `D/bot/handle-message.ts`：`sessionEnv` 给私聊也写 `VONVON_SCOPE`；`collaboration()` 里 `resolveOwner` 决定拉谁。
- `D/cli/daemon-client.ts`：握手时不带 scope 本来就行；`bindingsHidden` 把"这个 Bot 没有绑定"当成"会话看不到绑定"。

## 4. 怎么改

**范围。** `withinReach` 开头 `who === 'session' && principal.place === 'dm'` 直接过。要带 `who`：`scopedOwner` 把 owner 的 `--scope` 算成 `place: 'dm'`，不带就把它的范围也放开了。`checkSessionScope` 私聊提前返回，给了 scope 也不起作用。`sessionSnapshot(snapshot, principal)` 少一个参数，私聊走 `dmSnapshot`，只去掉 `crashes` 和 `diagnostics`；`filterSnapshot` 只剩 owner 的 `--scope` 在用。`sessionView`、`sessionReply`、`settingsShown` 删掉：Skill 要读完整设置，包括智能提示词。

**表。** `DM_ONLY` 是 `{ dm: 'bot', group: 'deny', comment: 'deny' }`，`WRITE` 是 `{ dm: 'bot', group: 'not-dm', comment: 'not-dm' }`。`deny` 的行照 6.2。`dmRefusal(kind)` 按行给文字，`settings.act.adminMember` 单独一句。`command.setAgentEnabled` 在 `authorizeSession` 里比 `action.agentId` 和 `principal.appId`。没有专门动作的 ★ 行走 `adminRead`，也就是这一轮还在、发起人是管理员。

**`dmTurn`。**

```ts
function dmTurn(auth: TurnAuth): Failure | undefined {
  if (!auth.human && auth.presence !== 'scheduled') return refused('not-human-turn');
  if (!opts.isAdmin(auth.facts.requesterOpenId ?? '')) return refused('not-admin');
}
```

私聊定时任务的 `requesterOpenId` 是创建人（C2 填）。`authorizeNow`、`adminTurn`、`authorizeSchedule` 的私聊分支都调它。`session_info` 走 `authorizeNow`，所以任务回合也如实回答。

**跨 Bot 的人。** `acrossBots` 在问完 Bot 进程之后跑，只对私聊：

- `settings.act.projectMember`（`present`，目标不是会话的 Bot）：`knowsMember` 翻完这个群的成员。查到才放行；查不到 `foreignOpenId`；查询失败 `memberUnchecked`，都不写入。
- `collaboration.createProject`：目标是会话的 Bot，`invitee` 用 open_id；否则用 union_id；没有 union_id 就 `cannotInvite`，不建群。`Decision.invitee` 经 `collaborationRpc` 进 `CollaborationRequest`，host 到 Bot 的 IPC 校验 `inviteeSchema`。桌面端和终端没有 `invitee`，照旧 `primaryAdmin`。
- `refuseIfLeftOut`：union_id 建群后查成员，确定人不在才解散群，抛 `CreationRefusedError`；查询失败或列表没读完时留下群，没有证据说人不在。飞书直接拒绝时也用 `cannotInvite`，后面接飞书的原话。

**union_id 从哪来。** `rememberDmChat` 把事件的 `sender_id.union_id` 记进 `dm.people[chatId].unionId`，回合开始时读出来放进 `TurnFacts.requesterUnionId`。放在 `dm.people` 而不是 `QueuedTurn`：C2 的私聊任务也要用，而且排队和重启都不会丢。

**跨 Bot 的记忆。** `SessionAction` 的 `add`、`edit` 带 `otherBot`，新增 `op: 'manage'` 给除了读和增改的行。`otherBot` 时 `MemoryLanding` 不带 open_id，带 `source.actorName`（协议加这一个可选字段）。`memoryAction` 在 `bot` 范围用请求写的 `botId`，不再用 `landing.source.botId`。

**出错。** Bot 进程没回答、查询超时都是拒绝。解散群失败只记日志，拒绝照常给用户。

## 5. 测试

- `T/authz-session.test.ts`：每一行私聊格对照 6.2 全表；`setAgentEnabled` 自己的和别的；scope 不起作用；跨 Bot 的 `knowsMember` 三种结果；经 daemon 翻第二页才查到（main 必败）。
- `T/agent-entry-session.test.ts`：`a private chat's turn`：任务和人一样、创建人不是管理员、唤醒回合、结束的回合、跨 Bot 记忆。（main 必败）
- `T/agent-entry-registry.test.ts`：`session_info` 在任务回合说 `allowed: true`，创建人被移出后说 `not-admin`。（main 必败）
- `T/dm-turn.test.ts`：真的 orchestrator：环境有令牌、没有 `VONVON_SCOPE`，回合带 `requesterUnionId`，`dm.people` 记下来。（main 必败）
- `T/project-create.test.ts`：union_id 建群：拉到人、飞书拒绝、人没进群就解散、查询失败或列表没读完时留下群。
- `T/cli-bot-session.test.ts`：私聊不带 `--scope` 能跑，没有群的 Bot 按"没有"回答；`admin add` 被拒并说去哪里。
- `T/memory-admin.test.ts`：落在请求写的 Bot 上，带名字，不带 open_id。（main 必败）
- `T/dm-project.test.ts`、`T/desktop-collaboration.test.ts`、`T/snapshot-filter.test.ts`、`T/schedule-authorize.test.ts`、`T/admin-groups.test.ts`：对应的单元用例。

## 8. 验收要点

- 6.2 表里每一行私聊格都是 `deny`，其余都是 `bot`，只有下面"和计划不一样的地方"列的几行例外。
- 群和评论的格子没变。可以把新旧 `RULES` 打包后逐行比，本片比过：151 行，0 格变化。
- owner 带 `--scope` 仍然被限制，没有被私聊的直通放开。
- 关掉自己 Bot 的 `setAgentEnabled` 被拒，别的 Bot 能关。
- `askBot` 的第一个参数还是会话的 Bot，不是目标 Bot。
- 跨 Bot 写名单、写记忆，不把 A 的 open_id 写进 B。
- 跨 Bot 建群确定拉不到人时，不留下群。
- 删掉 `sessionView`、`sessionReply` 之后，群和评论的回复没变宽。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码约 470 行（+304 −170），测试约 620 行（+435 −183）。风险在权限表和合入门禁一类，要多角度审查。最容易漏的是 owner 的 `--scope` 被当成私聊，和跨 Bot 时 `askBot` 问错 Bot；第 8 节都列了。

## PR 描述草稿

### 用户能看到的变化

- 私聊里的 Agent 用 `vonvon` 命令行不用带 `--scope`，能看到、能改这台电脑上所有 Bot 的群、设置、记忆，能停别的 Bot。
- 注册 Bot、凭据、服务、更新、安装和登录、密钥、配对、管理员名单这些事，在私聊里被拒，文字说要去客户端或终端做。
- 不能在私聊里关掉自己这个 Bot。
- 让另一个 Bot 建群时，拉的是发起人；拉不到时不建群，并说可以自己建群再绑定。
- 把人加进另一个 Bot 的名单时，id 必须是那个 Bot 查到的。

### 试用步骤

1. 管理员私聊 Bot："列出所有 Bot 的群"，看到所有 Bot 的。
2. 私聊："把 Bot B 暂停"，B 停；"把你自己暂停"，被拒。
3. 私聊："加一个管理员"，被拒，说去「设置 → 管理员」。
4. 私聊："让 Bot B 建一个叫测试的群"，B 建好群，你在群里。第一次要先给这个 Bot 发过一条消息，它才记得你的 union_id。
5. 群里的会话行为不变：不带 `--scope` 仍然被拒。

### 跑过的命令和结果

JP-VPS，都用 `flock /tmp/vonvon-heavy.lock`，测试用隔离的 `HOME`、`VONVON_HOME`：

- `npx tsc --noEmit -p .`：`packages/daemon`、`packages/protocol`、`packages/ui`、`packages/client` 都通过。
- `npx vitest run`（`packages/daemon` 的 43 个相关文件）：42 个文件通过，1 个跳过；743 条通过，5 条跳过。
- `npx vitest run`（`packages/protocol`）：17 个文件，122 条通过。
- 新旧 `RULES` 逐行比：151 行，群和评论 0 格变化；私聊 73 格变化（`deny` 到 `bot` 60，`host` 到 `bot` 5，`not-group` 到 `bot` 8）。
- lint：`packages/daemon` 没有 lint 脚本，没跑。

全量交给 CI。

### 和计划不一样的地方

- `machine.status` 留在 `deny`。计划没列它，照"其余一律 `bot`"该放开；但 `docs/product.md` 3.7 说 `service status` 在所有会话里都拒绝，它返回服务定义和日志路径，`service status` 也在 `LOCAL_ONLY` 里。
- `snapshot.get`、`admin.negotiate`、`admin.daemonStatus` 留在 `host`：在任何回合之前就要用。
- `environment.backendInstallStatus`、`toolInstallStatus`、`loginStatus` 是 `bot`（只读）；`profileInitStatus` 跟 `profile*` 是 `deny`；`command.cancelJob` 是 `bot`。
- `daemon-client.ts` 本来就能不带 scope 握手。实际改的是记下 `context.dm`，让 `bindingsHidden` 在私聊里为假。
- `sessionView`、`sessionReply` 删掉了，私聊读完整的设置视图。
- union_id 存在 `dm.people`，回合开始时读，不经 `QueuedTurn` 传。
- 建群多了 `refuseIfLeftOut`：飞书可能不报错但没把人拉进来，所以建完查一次成员。
- 记忆跨 Bot 用 `otherBot`、`manage`、`actorName`（协议多一个可选字段）。编辑只记角色，`lastEditedBy` 没有名字；跨 Bot 写入要降级时拒绝，不落到这个 Bot 的项目里。
- 跨 Bot 建群、从没发过消息（这版之前也算）的人没有 union_id，拒绝，要先给这个 Bot 发一条消息。

### 还没验过的项

- 真飞书：另一个组织的 Bot 用 union_id 建群时飞书怎么回答。这一片没发飞书请求，`refuseIfLeftOut` 是按两种可能都写的。
- 真的私聊回合里跑 `vonvon`：只在测试里用真 CLI bundle 跑过。
- Mac、Windows 上的行为。

过渡状态，等后面的片：

- `vonvon feishu members` 还没有（F2），`foreignOpenId` 的文字先提到了它。
- 定时任务（C2）：表里是 `bot`，私聊的定时工具还藏着；命令行点名另一个群时核心按 `not-group` 拒绝；命令行写私聊的 `oc_` id 时，C2 之前 `placeScheduled` 可能处理不对；跨 Bot 任务的 `createdBy` 不带 open_id 也是 C2。

### 独立审查结论

待 Codex 审查

### 记录

Mac 检查次数 0；等 owner 0；等额度 0。
