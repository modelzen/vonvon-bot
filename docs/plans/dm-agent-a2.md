# A2：管理员页和候选人

设计见 `docs/plans/dm-agent.md` 第 3.3 到 3.6 节，产品行为见 `docs/product.md` 第 6 节。`D/` 指 `packages/daemon/src/`。

## 1. 做什么

全局"设置"里多一个"管理员"页，列出每个 Bot 的管理员，能添加、移除，至少留一个。添加时选人：候选人（创建者、飞书应用的管理员和开发者、私聊被拒的人）和群成员，不填 Open ID。非管理员私聊 Bot 时回一句话并被记下来，进候选人。依赖 A1（#707，已合入集成分支）。D2 在私聊入口调用本片的 `createDmRefusal`。

## 2. 范围

做：

- `AgentSettingsView.administrators` 加 `names`、`candidates`，去掉 A1 留下的 `feishu`、`scannerOpenId`；
- 候选人的组装（`D/admin/admin-candidates.ts`）和飞书名字的读取（`D/bot/names.ts` 的 `createPersonNames`）；
- 被拒的人：`D/bot/dm-refused.ts`，文件 `<botDir>/dm-refused.json`、回话、上限、过期；
- 设置的一级页"管理员"，排在"飞书连接"后面，加进搜索；删掉 Bot 设置里原来的管理员区和手填 Open ID；
- `/menu` 的管理员卡只读：A1 已经做了，这一片只把卡上那句"在哪里改"指到新页面。

不做：

- 私聊进 Agent、`handle-message.ts` 的 p2p 分支（D2）；`dm-console.ts` 里旧的拒绝话（D2 接手后不再走到）；
- 私聊页面和群列表最上面一行（D4）；
- 移除时的第 3 到 5 步（D2、C2）。

## 3. 现在的代码

- A1 之后视图是 `administrators: { feishu?, scannerOpenId?, openIds, revision }`，`settings.ts` 的 `read` 里组装；`feishu` 只有 Bot 页的管理员区用，那一区把创建者和飞书来的人的移除按钮藏了起来。
- 名字只有卡片路径会读：`bot/names.ts` 的 `resolveNames`（`contact/v3/users/batch`），一次传全部 id。
- 群和群成员已有命令：`command.listJoinedGroups`、`command.listGroupMembers`，经 `service.joinedGroups`、`groupMembers` 到 Bot 进程。
- `onBotMenu`（`handle-message.ts`）对非管理员发"⛔ 仅管理员可在私聊里管理项目。"。
- 设置页的一级页：`collaboration-model.ts` 的 `Page`、`TodayHome.tsx` 的 `settingsEntries`、`App.tsx` 的 `titles` 和渲染、`search.ts` 的 `pages`。

## 4. 怎么改

**视图。** `administrators` 变成 `{ openIds, names?, candidates?, revision }`，后两个可选（旧 daemon 没有）。`names` 是名单上的人在飞书的名字，读不到的没有条目。`candidates` 不含名单上的人。私聊会话读设置时 `authz.ts` 本来只留 `openIds`、`revision`，名字和候选人不会漏给 Agent。

**名字。** `createPersonNames(channel)` 返回 `(ids) => Map`：`resolveNames` 每 50 个一批（`contact` 一次最多 50 个，一批失败不影响别的批），答案和没答案都缓存 5 分钟，超过 3 秒就用手上有的，过期后读失败时保留旧名字。`settings.ts` 的 `read` 对名单、创建者、飞书名单的并集问一次；Bot 没在运行（本机只读）时没有这个依赖，名字只剩被拒的人记下的。

**候选人。** `adminCandidates({ admins, creator, feishu, refused, names })`：创建者永远在，名字读不到写"创建者"；飞书的人（所有者加管理员和开发者，只信 `trustedFeishuAdmins` 认得的）读不到名字就不列；被拒的人用记下的名字；同一个人的来源合并；名单上的人不列。

**被拒的人。** `createDmRefusal({ channel, appId })` 返回 `(visitor) => Promise<void>`，`visitor = { openId, chatId?, replyTo? }`，永不抛：

1. 回 `DM_REFUSED_MESSAGE`：有 `chatId` 就在那个聊天里引用原消息回，没有（机器人菜单）就按 `open_id` 发；同一个人 10 分钟一次，发送失败不算回过。
2. 记进 `dm-refused.json`（`{ v: 1, people: [{ openId, name, at }] }`）：已有就只更新 `at`；没有就按 `contact`，再按"这个私聊的成员"读名字，3 秒内读不到就不记，10 分钟内不再问。最多 20 人（留最近的），30 天过期，同一个 Bot 的写按顺序排队，原子写。

名字只从飞书读。消息内容里的名字一概不用。D2 在 p2p 分支 `isAdmin` 为假处，转写和下载之前：`await dmRefusal({ openId: msg.senderId, chatId: msg.chatId, replyTo: msg.messageId })`。`handle-message.ts` 里已经建好 `dmRefusal`，`onBotMenu` 已经改用它。

**页面。** `management/AdministratorsPanel.tsx`，每个 Bot 一段：

- 读 `settings.read(agent)`；名单行：名字、创建者小标签、"移除"。只剩一个时移除按钮不能点；Bot 没在运行时都不能点，写明原因；名单为空显示"这个 Bot 还没有管理员"。
- 移除要确认，写明私聊会停、私聊任务会暂停。
- "添加管理员"弹窗：搜索框，"候选人"（带来源），"从群里选"（`listJoinedGroups` 选群，再 `listGroupMembers` 选人，都能分页）。点"添加"走 `settings.act.adminMember`，用的 revision 来自刚读的视图；成功后重新读。
- 页底一句"管理员能通过私聊操作这台电脑和这台电脑上的所有 Bot"。没有风险标签、没有填 Open ID 的入口。
- 人的头像用名字的第一个字，不去拉飞书头像。

`SettingsPanel.tsx` 里 Bot 设置的管理员区和 `search.ts` 里对应的一组搜索项删掉，改成一级页的搜索入口。

## 5. 测试

- `dm-refused.test.ts`：回话和记录；10 分钟内只回一次但仍更新时间且不重复问名字；没有名字不记、10 分钟内不再问；机器人菜单没有 `chatId` 走 `open_id`；发送失败下次再回；20 人上限和同时被拒的两个人都写进去；30 天过期、文件损坏当没人。
- `admin-candidates.test.ts`：创建者永远在、读不到名字写"创建者"；飞书的人没有名字不列；来源合并；名单上的人不列。
- `settings-owner.test.ts`：视图带名字和候选人，`personNames` 只问一次；创建者被移除后仍是候选人；Bot 没在运行时只有创建者和被拒的人。
- `names.test.ts`：`resolveNames` 分批、一批失败；`createPersonNames` 缓存、过期保留旧名字、超时给手上有的。
- `authz-session.test.ts`：私聊会话读设置，`names`、`candidates` 被裁掉。
- `administrators-panel.test.tsx`：创建者和飞书来的人也有移除按钮（A1 时藏着）；只剩一个时不能点；名字读不到显示 id 尾号；候选人带来源；没有 Open ID 输入。
- `search.test.ts`、`application-ui.test.tsx`：一级页的入口和位置。
- 无头 Chromium：用假客户端挂上整页，点添加（候选人、群成员）和移除（含确认），搜索能过滤，停着的 Bot 不能点。

## 8. 验收要点

- 一级页"管理员"在"飞书连接"后面；Bot 设置里没有管理员区；没有手填 Open ID 的入口。
- 创建者和飞书来的人有移除按钮，只剩一个时不能移除。
- 候选人：创建者任何时候都在；读不到名字的飞书应用管理员不列；被拒的人最多 20 个、30 天过期。
- 名字只来自飞书（`contact`、被拒私聊的成员），不来自消息内容。
- 非管理员私聊的回话是设计 3.5 的原话，同一个人 10 分钟一次；`createDmRefusal` 在转写之前能调，永不抛。
- 私聊会话读设置拿不到名字和候选人。
- 改名单只走 `settings.act.adminMember`，没有新的写入口。
- `/menu` 的管理员卡没有增删按钮。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

净增约 570 行（源码约 330，测试约 240）。

- 被拒的人的名字读不到就不记，这个人私聊一次也进不了候选人；`im/v1/chats/<p2p>/members` 对通讯录范围外的人是否读得到，2026-11-05 只对一个人实测过，这一片没有真飞书可测，要 D2 合入后在测试 Bot 上用一个外部账号再测一次。
- 停着的 Bot 读不到飞书的名字，管理员显示 id 尾号，也不会有飞书来的候选人；它本来就不能改名单。
- 读视图多一次 `contact` 调用（有缓存），读不到时页面照常出来。
- D2 若在 p2p 分支另写拒绝逻辑，会和这里重复；约定是调 `dmRefusal`。
