# dm-agent-d4 计划：私聊页面和 `--dm`

设计在 `dm-agent.md` 第 10 节，私聊项目在第 4 节，私聊记忆在第 5 节，任务在第 8 节。`D/` = `packages/daemon/src/`，`U/` = `packages/ui/src/`，`T/` = `packages/daemon/test/`，`UT/` = `packages/ui/test/`。

## 1. 做什么

Bot 的群列表最上面多一行"私聊"，打开是和群一样的工作区，四个标签：模型与权限、能力、记忆、任务。命令行的 `settings`、`schedule` 能用 `--dm` 指这一行。依赖 D1 到 D3、C1、C2（#719），都在集成分支上。

## 2. 范围

做：快照的 `dm`；列表第一行；路由；`dmMode` 的工作区；按人分组的记忆和"新"标记、"模型看到什么"；任务选管理员；`--dm` 命令。

不做：新的设计样式；Skill（C3，`vonvon-config` 要教 `--dm`、`--to`）；第一次见面（D5 已合入）。

## 3. 现在的代码

- `D/project/registry.ts`：`dm` 行不进 `listProjects`，`dmProject()`、`dmPersonList()`、`dmChatId()` 已有。
- `D/admin/settings.ts`：`projectName = oc_dm_<appId>` 已能读写，只有 `model`、`speed`、`modelAccess`、`skills` 能存；读的时候其余各节还显示可写。
- `D/admin/memory.ts`：`memory.dmPeople` 只有 `openId`、`name`、`at`、`used`。`D/admin/memory-seen.ts` 和 `newCounts` 不含私聊。`D/admin/context-preview.ts` 只有群。
- `D/admin/schedule-commands.ts`：私聊的任务要写真实的 p2p chat，合成的行 id 一律 `not-found`。
- `U/BotGroupList.tsx`、`U/GroupWorkspace.tsx`、`U/collaboration-navigation.ts`：只认 `Membership`。`U/ScheduleTab.tsx` 读一个群。`U/BotSchedules.tsx` 的私聊分组只能删除。

## 4. 怎么改

**快照。** `agentSchema` 加 `dm?: membershipSchema`。`D/admin/service.ts` 的 `dmRow?(botId)` 给出这一行，`sessionCount` 数 `dm.people` 里所有 chat。`D/server/projection.ts` 投影，读不出时留上一份、标 `stale`。`--scope` 指定了群时不带它，群和评论会话的快照本来就只挑字段，也没有。

**权限。** 私聊会话走现有的 `withinReach`。主人的 `--scope` 不带群时，等于这个 Bot 的私聊能到的范围：能读写这一行的设置和各人的任务。`memory.dmPeople` 只有主人能读，不变。

**设置。** 读 `dm` 行时 `DM_SECTIONS` 以外各节的 access 是 `{ readonly, reason: 'dm-fixed' }`。Provider 和模型的默认值建行时取一份，之后不跟 Bot 默认（4.1），代码不用改，加测试钉住。

**列表。** `BotGroupList` 在 `.bot-group-list__rows` 最上面放一行，沟通方式那格留空。`dmRowOf(agent, status)` 决定 Provider 和异常，计数只数 `memberships`。没群时这一行在"尚未绑定飞书群"上面。

**路由。** `{ kind: 'dm', agentId, tab, from? }`，`from` 是从 Bot 的任务页点进来时回去的地方。

**工作区。** `workspaceTabs(dmMode)`。`dmMode` 不读项目，不显示飞书链接、Bot 选择、对话记录、使用说明、解绑、启用开关。模型与权限下面 `dmFixedRows(view)` 显示"完全访问"和目录，没有编辑入口。能力页没有语音。

**记忆。** `U/dm-people.ts` 读 `memory.dmPeople`，它多回 `chatId`、`fresh`、`admin`。`U/DmMemory.tsx` 列人，只有一个人时直接打开，下面是这个人的 `MemoryMap`（scope `dm`，有 Bot 记忆入口，没有"移到项目"）和折叠的"模型看到什么"。`seen` 的 page 加 `dm`，键 `dm:<botId>:<openId>`。`newCounts` 有内容时才带 `dm`，老 daemon 没有这一项时按空算。`contextPreview` 的 place 加 `{ kind: 'dm', openId }`，段是身份、Bot 记忆和 `dmMemory`。

**任务。** `ScheduleTab` 用 `listBot` 过滤 `task.dm`。`ScheduleForm` 加 `chats`：只有新建时显示"发给谁"，选项是还是管理员、有私聊的人（`dmChats`），不显示"发到哪"。Bot 的任务页点私聊任务进这个页的任务标签，这个 Bot 没有私聊行时只能删除，和原来一样。

**命令行。**

- `settings get|set|models --dm`：解析成 `oc_dm_<appId>`，不和 `--group`、`--session`、`--host` 一起用。`models --dm` 的 Provider 默认取私聊自己的。
- `schedule list|add|pause|resume|run|rm|edit --dm`：`list` 按人列；按 id 操作时用任务自己的 chat；`add` 用 `--to <openId>` 指人，只有一位管理员的私聊时不用写。在私聊会话里发行 id，daemon 读成这个窗口。
- `context show --dm <openId>`。`memory --dm <id>` 已有。

没有新的 RPC 种类，`cli/parity-allowlist.ts` 不用改。

## 5. 测试

新增的都是 main 必败，那时这些东西都没有。

- `UT/dm-page.test.tsx`：第一行有群、没群；计数；没有行时不显示；异常和"新"；四个标签；隐藏项；权限和目录只显示；能力页没语音；按人列、已不是管理员；预览；任务只列私聊的。
- `UT/collaboration-navigation.test.ts`：路由、返回。`UT/schedule-form.test.tsx`：选人、编辑时不换人。`UT/bot-schedules.test.tsx`：点开和没有行时只能删。`UT/schedule-polling.test.ts`：`listBot` 过滤。`UT/memory-model.test.ts`：动作。`UT/memory-new-marks.test.tsx`：计数。
- `T/server-state.test.ts`、`T/snapshot-filter.test.ts`：快照不进 `memberships`，群 scope 看不到。
- `T/memory-admin.test.ts`、`T/memory-seen.test.ts`、`T/context-preview.test.ts`：多回的字段、新计数、两个人的预览分开。
- `T/settings-owner.test.ts`：只读原因、不跟 Bot 默认。`T/authz-session.test.ts`：`--scope` 的范围。
- `T/schedule-commands.test.ts`、`T/dm-schedule.test.ts`：行 id 的三种人。`T/schedule-cli.test.ts`、`T/cli-settings-act.test.ts`、`T/cli-machine.test.ts`：`--dm` 命令和冲突。

## 8. 验收要点

- `memberships`、群目录、搜索里没有 `oc_dm_`，计数不含它。
- 没绑群的 Bot 也有这一行，在"尚未绑定飞书群"上面。
- 私聊页只有四个标签，没有沟通方式、飞书链接、解绑、对话记录。
- 权限只有"完全访问"，页面上没有改的地方，命令行改被拒。
- 记忆按人分，A 的条目不出现在 B 下面；被移除的人还在名单上，新建任务选不到。
- 新建私聊任务时结果落在选的人的 p2p chat 上，不是 `oc_dm_`。
- 群会话的 `--dm` 被拒，`--scope` 指定了群时碰不到私聊行。
- Bot 默认模型变了，私聊的模型不变。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码 +621 −245，测试 +523 −12，加这份计划。没到 1,500 行，一次审完。风险在权限：`dmRow` 和 `wholeBot` 让主人的 `--scope` 多到了私聊行，`schedule-commands` 把行 id 映射到窗口。这两处都有反证。

## PR 描述草稿

标题：dm-agent D4：私聊页面和 `--dm`

### 用户能看到的变化

- Bot 的群列表最上面固定一行"私聊"，显示 Provider，没有沟通方式。没绑群时也有，不算进群数。
- 打开是四个标签：
  - 模型与权限：Provider、模型、强度和群一样能改；权限只显示"完全访问"，目录只显示。
  - 能力：Skill 和 MCP，没有语音。
  - 记忆：按人列，带"新"标记，打开一个人是他的私聊记忆、Bot 记忆入口和"模型看到什么"，没有项目记忆。被移除的管理员还在，标"已不是管理员"。
  - 任务：这个 Bot 的私聊任务，新建时选发给谁。Bot 的任务页点私聊任务会到这里。
- 命令行：`vonvon settings get|set|models --dm`、`vonvon schedule … --dm`（`add` 用 `--to <openId>` 指人）、`vonvon context show --dm <openId>`。

### 试用步骤

1. 起一个 daemon，打开有群的 Bot 和没绑群的 Bot，看列表第一行和群数。
2. 点"私聊"，看四个标签。改模型，刷新后还在；再改 Bot 默认模型，私聊的不变。
3. 让两个管理员各私聊一次并记一条，到记忆标签看两个人，打开一个，"新"消失。
4. 到任务标签新建，选一位管理员，到时间看结果发到他的私聊。到 Bot 的任务页点这条，回到私聊页。
5. `vonvon settings get --dm --bot <bot>`；`vonvon settings set 'permission.mode="read"' --dm --bot <bot>` 被拒。
6. `vonvon schedule add --dm --to <openId> --name 早报 --instruction 发今天的安排 --daily 09:00 --bot <bot>`，再 `vonvon schedule list --dm --bot <bot>`。

### 跑过的命令和结果

都在 JP-VPS 上，隔离的 `HOME` 和 `VONVON_HOME`，基线是集成分支 `91a17912`：

- `npm run build`（全部包）：通过。
- `tsc --noEmit`：protocol、daemon、ui、client、desktop 通过。ui 的 `tsc` 不含测试文件。
- `npm run lint --workspaces --if-present`：protocol、client、ui、desktop 通过。daemon 没有 lint 脚本。
- `vitest run`：`packages/ui` 全部 110 个文件 1,105 个用例，`packages/protocol` 17 个文件 122 个用例，`packages/client` 3 个文件 44 个用例，全过。
- `packages/daemon` 只跑相关的（`test/memory`、`test/dm-`、`test/context`、`test/authz`、`test/cli-`、`test/schedule`、`test/settings`、`test/server`、`test/snapshot`、`test/rpc-parity`、`test/project`）：103 个文件 1,634 个用例，全过。其中 `cli-parity` 不用改 allowlist。
- `T/cli-json.test.ts` 跑的时候红了一次：D3 加了 `memory people`，这里的样本漏了，集成分支上同样缺（没单独在集成分支上跑）。这一片补上了，现在过。
- 反证七处，改完马上还原，都有用例变红：群 scope 不去掉 `dm`；`dmRow` 恒假；`wholeBot` 不放行任务；本机发行 id 不拒绝；`dm` 行不标只读；已移除的人进选项；页面上用原来的权限面板。

### 和计划不一样的地方

- `schedule --dm` 是开关，`add` 另有 `--to <openId>` 指人。`--dm [openId]` 这种可选值会吞掉后面的位置参数。
- 加了 `vonvon context show --dm <openId>`：页面有预览，命令行要对得上。
- 加了只读原因 `dm-fixed`，`settings get --dm` 和页面都按它显示。
- `dmRow?` 在 service 接口上是可选的，假的 service 不用改。
- 主人的 `--scope` 不带群时能到这个 Bot 的私聊设置和任务，它等于这个 Bot 的私聊能到的范围。
- 私聊的预览里 `judge` 字段仍是必填，全是 0，页面和命令行都不显示。`items.trusted/untrusted` 放私聊记忆的条数，段的键是 `dmMemory`。
- `dmPersonList` 回这个人最新的 chat，给任务当落点。
- C2 里"在私聊里发行 id 被拒"改了：私聊会话发行 id 读成这个窗口，这样 `schedule add --dm` 不用问 chat。终端发行 id 仍被拒。`T/dm-schedule.test.ts` 跟着改。
- 记忆页的预览按"模型看到什么"做。`ContextPanel` 原来没有挂载的地方，现在私聊页折叠挂着，群页不动。

### 还没验过的项

- 没在真实浏览器里打开过页面，只有 `renderToStaticMarkup` 和逻辑测试，样式、折叠、读取时的状态没看。
- 真实 daemon、真实飞书、真实 Codex 和 Claude 没跑。Mac 和 Windows 交给集成 PR 的 CI 和验收。
- 全量 daemon 测试没跑，交给 CI。

### 独立审查结论

待 Codex 审查

Mac 检查次数、等 owner 时长、等额度时长：0、0、0。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
