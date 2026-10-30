# T5：桌面端和网页的"任务"

## 1. 做什么

群详情页加"任务"tab，Bot 页加这个 bot 所有群的任务汇总。看、建、改、暂停、恢复、删、立即运行，看总次数和最近 20 条。功能优先，不做样式。总设计第 12、16 节；产品行为 3.13。基线 T1b 合入后的 `dev`（T2 合入后才看得到运行记录，自测的后一半要等 T2），分支 `codex/scheduled-tasks-5-ui`。

## 2. 范围

- 改：`packages/desktop/src/{ipc-contract,bridge,facade}.ts`（`schedule` 一层各一处）、`packages/ui/src/`（新 `ScheduleTab.tsx`、`ScheduleForm.tsx`、`ScheduleRuns.tsx`、`BotSchedules.tsx`；`GroupWorkspace.tsx` 加 tab；`App.tsx` 的 Bot 页加第四个 pane；`collaboration-navigation.ts`、`search.ts`、`url-actions.ts` 加路由和搜索项）。
- 可以假设：T1b 的 protocol、`client.schedule(botId, request)`、host RPC、`tasks` 回复里的 `now` 和 `timeZone`。
- 不做：推送（轮询）；样式；bot 页的建任务（只看和跳转）；私聊的任务。

## 3. 现在的代码

- 桌面端三层：`packages/desktop/src/ipc-contract.ts:18-19`、`bridge.ts:185-186`、`facade.ts:274-275` 的现有方法样板。
- 群详情页：`packages/ui/src/GroupWorkspace.tsx:24-26`（tab 表）、64、128-176（tab 内容和路由）；`ui/test/group-design-settings.test.tsx:77` 断言 tab 顺序 `['模型与权限', '能力', '沟通方式', '记忆']`。
- Bot 页的 pane：`App.tsx:133` 的 `[{kind: 'groups', label: '群聊'}, {kind: 'profile', label: '记忆'}, {kind: 'settings', label: '设置'}]`；`App.tsx:124、130、179-180、365、766-768、853-854` 的分区和 snapshot。
- 列表、对话框、冲突的样板：`McpPanel`（列表、对话框、revision 冲突提示）；历史行加"在飞书打开"：`ConversationPanel`；轮询：`MemoryMap`（定时器在卸载时清）。
- 工具函数：`url-actions.ts:87` 的 `groupUrl(groupId, threadId?)`（只能开群或话题，指不到一条消息）、`allowedExternalUrl('group')`；`@vonvon/protocol` `display.ts:20` 的 `formatTime(value, { timeZone })`；`formatUptime`。
- 搜索和路由：`collaboration-navigation.ts:6、37、49、74`，`search.ts:8、41、55`，`url-actions.ts:17、37、56、87-91`。
- 回复不是异常：UI 侧对 `refused`/`conflict` 的处理照 `McpPanel`。
- 叫法表：`docs/v1-plan.md` 第 5 节"叫法表"，tab 叫"任务"。

## 4. 怎么改

### 4.1 三层接线

`schedule(botId, request): Promise<ScheduleReply>` 在 ipc-contract、bridge、facade 各一处，照现有方法。

### 4.2 群详情页"任务"tab

- tab 表加 `['schedule', '任务']`，排在"记忆"之后；更新 `group-design-settings.test.tsx` 的顺序断言。
- `ScheduleTab`：`schedule list` 的结果一行一个：名字、`describe`、下一次（`formatTime` 按任务时区，和回复里 daemon 的 `timeZone` 不同时加时区名）、状态（运行中 / 已暂停：手动 / 已暂停：连续失败 / 已暂停：群已解绑 / 已结束）、最近一次（状态中文加时间）。行上按钮：编辑、暂停或恢复、立即运行、删除（确认对话框）。
- 展开一行：总次数、错过和跳过次数、最近 20 条表（时间、状态、用时 `formatUptime`、"在飞书打开"用记录里 daemon 解析好的 `link`，没有 `link` 但有 `topicId` 就 `groupUrl(chatId, topicId)`，都没有不显示）、最近一次结果的 500 字。
- 页脚固定一句（总设计第 16 节，`deviceTitle` 用现有的本机名称变量）。
- 轮询：tab 打开时每 10 秒 `list` 一次；切走、卸载清定时器；写操作后立即重拉。
- 空状态：一句"这个群还没有任务"加"新建"按钮。
- `refused bot-not-running`：显示第 16 节"桌面端 bot 没运行"那句，不显示空状态，不显示"新建"。

### 4.3 表单：`ScheduleForm`

字段：名字（≤40）、要做什么（多行，≤4000）、什么时候（单选：一次 / 每 N 分钟 / 每天 / 每周 / cron；一次用 `<input type="datetime-local">`，每天每周用 `<input type="time">`，每周加七个 checkbox 加"工作日"快捷，cron 一个文本框加一行说明）、发到哪（单选：跟群走 / 每次开新话题）、时区（文本框，默认浏览器的 `Intl.DateTimeFormat().resolvedOptions().timeZone`，旁边一行小字"Vonvon 所在电脑的时区是 {daemon 的 timeZone}"）。`datetime-local` 按表单里填的时区转 epoch（不按浏览器默认），`timeZone` 明确发给 daemon。提交前本地校验（空、超长、一次性时间已过、时区名 `Intl` 认不认识），服务端 `bad-schedule` 的 message 直接显示。编辑带 `revision`；`conflict` 时显示第 16 节"桌面端冲突"那句：表单填入 `current`，用户刚才填的内容放在下面一个只读框里，不丢。

### 4.4 Bot 页"任务"pane

`App.tsx:133` 的 pane 表加 `{kind: 'schedule', label: '任务'}`，排在"记忆"之后。`BotSchedules`：`listBot` 的结果按群分组（已解绑的群也列，群名取不到写"已解绑的群"），每行名字、`describe`、下一次、状态，点击跳到群详情页的任务 tab（`collaboration-navigation` 加 `group/<id>/schedule`）；已解绑的群没有详情页，行上直接给"删除"。只有主人和管理员看到（页面本来就只给他们）。

### 4.5 搜索和 URL

搜索索引加"任务"项（群详情页任务 tab 的入口和每个任务的名字）；`url-actions` 支持 `#group/<id>/schedule`。

## 5. 测试

main 必败：tab、组件、三层方法在基线不存在；`group-design-settings.test.tsx` 的顺序断言在基线是四项；`App.tsx` 的 pane 在基线是三项。

ui 包只有 vitest，没有 jsdom，照现有 `renderToString` 和纯函数的测法。每条写输入和期望：

- `schedule-tab.test.tsx`：五种状态各一行的文字（`paused manual` → "已暂停：手动"，`paused unavailable` → "已暂停：群已解绑"…）；任务 `Asia/Tokyo`、daemon `Asia/Shanghai` → 下一次带"（Asia/Tokyo）"，相同不带；展开表 20 行；"在飞书打开"的三种来源（`link` → 原样，无 `link` 有 `topicId` → `groupUrl`，都无 → 没有链接），href 经 `allowedExternalUrl`；空状态那句；`refused bot-not-running` → 那句、没有"新建"；页脚那句逐字。
- `schedule-form.test.tsx`：五种 spec 的表单到 request：一次 `2026-11-01T14:00` 加时区 `Asia/Shanghai` → `spec.once.at` 等于那个 epoch 且 `timeZone: 'Asia/Shanghai'`；每 30 分钟 → `{ kind: 'every', minutes: 30 }`（不填 anchor）；每天 `09:00`；每周勾"工作日" → `days: [1,2,3,4,5]`；cron 原样。本地校验：名字空、41 字、内容 4001 字、一次性时间已过、时区 `Mars/Olympus` 各一条错误文字。`conflict` → 表单是 `current` 的值、只读框是用户刚才的值、提示那句。
- `bot-schedules.test.tsx`：两个群四个任务 → 两组；点击路径 `group/<id>/schedule`；已解绑的群组名"已解绑的群"、行上有"删除"没有跳转。
- `schedule-polling.test.ts`：定时器建和清（假时钟）；写操作后立即 `list`。
- `desktop-ipc-schedule.test.ts`：三层透传。
- `group-design-settings.test.tsx`：顺序改成五项；App 的 pane 测试改成四项。
- 回归定向：collaboration-navigation、search、url-actions、App 的 snapshot 测试。

## 6. Codex 的自测

Mac（#322），用 Mac 自己的测试环境（隔离数据目录、Mac 的测试 bot 和两个已绑的测试群；目录、bot 和群见 #322 正文"Mac 的测试环境"，少于两个群先按那一节再绑一个），不碰 owner 的 `~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和 `/Applications/Vonvon Bot.app`。T2 合入前只做第 1、3、4、5、6 步；T2 合入后补第 2 步。

- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 界面用 Codex 自带的网页控制在网页端做，不写 Playwright，不用 Computer Use（没有外壳行为）。lark-cli 用 Mac 上的，`--as user`，只在 #322 登记的测试群里；读消息用 `lark-cli im +messages-list --as user --chat-id <测试群的 chatId> --page-size 20`（参数名以 `lark-cli im --help` 为准，不会的记"没验到"）。
  1. 群详情页 → 任务 tab：空状态；新建"每 1 分钟"的任务，时区框默认是浏览器的时区、小字显示 daemon 的时区；列表出现，下一次时间对（建的时刻向上取整到整分再加 1 分钟）。
  2. （T2 后）两分钟后展开：两条记录、"在飞书打开"能打开那条卡；`+messages-list` 看群里两张卡。Bot 停掉（隔离目录的 `vonvon daemon stop`）再开 tab：显示"Bot 没在运行…"那句。
  3. 编辑改成每天 09:00：成功；在终端 `VONVON_HOME=<隔离目录> vonvon schedule edit --bot … --group … <id> --revision <r> --name 改过` 改一次后再在网页上保存旧表单：冲突提示、表单回填 current、只读框里是刚才填的。
  4. 暂停、恢复、立即运行、删除各一次；删除后隔离目录的 `bots/<appId>/schedules.json` 里没了。
  5. Bot 页：两个群各建一个，"任务"pane 里两组，点击跳到对应群的任务 tab。
  6. 搜索"任务"能到 tab。
- 打码：不贴群 id、消息 id、`/Users/<u>`。

## 7. 文档

- `docs/v1-plan.md`：T5 行的做法和实际行数；叫法表已加"任务"一行。
- product.md 3.1 第 6、7 条已加"任务"；本片对不上的在 PR 写明。

## 8. 验收要点

- 所有写操作经 `client.schedule`，没有旁路；`refused`/`conflict` 显示成提示，不是未捕获错误；冲突不丢用户填的内容。
- 时间按任务时区显示，和 daemon 时区不同时标出来；`timeZone` 明确发给 daemon，`datetime-local` 按表单时区转。
- `bot-not-running` 有专门的显示。
- 页脚那句原样在；"在飞书打开"用 daemon 给的 `link` 或话题链接，经 `allowedExternalUrl`，前端不自己拼消息链接。
- 轮询卸载清；写操作后立即刷新。
- Bot 页只看不建；已解绑的群能删；跳转路径对。
- 不碰 owner 的环境。diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：macOS 原生没有；错误路径是 `conflict` 回填和轮询期间任务被删。预计生产约 740 行（tab 220、form 240、runs 100、bot 页 100、三层和路由 80）、测试约 620 行、文档约 40 行，总计约 1,400。超限先把 Bot 页汇总和搜索拆成 T5b。自审不代替独立审查；不冻结、不合入。
