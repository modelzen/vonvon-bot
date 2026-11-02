# S1 `settings-dm-only` 计划：设置只在私聊，撤掉飞书和设置 skill，补两处权限

owner 2026-11-02 定。总设计 `docs/plans/devices.md` 第 20 节；和第 5 节开头、5.2、第 9 节、K1（`docs/plans/skills-scope.md`，#650）冲突时以本片为准。基线是集成分支 `claude/devices-integration` eb6d55a6（带 K1 #650、C5 #651、D3 #646、U1 #647）。行号按 eb6d55a6，漂了按函数名找。

## 1. 做什么

owner 原本的诉求是"通过对话读配置、改配置，只有主人或管理员能改，所以只在私聊里有这个能力"。群里没有这个能力：不给群会话设置工具，不给 skill，也不往别的 skill 里塞设置规则。"飞书是别人的 Skill"：飞书官方 lark-cli 自带 `lark-*` skill，vonvon 不发自己叫"飞书"的 skill。私聊的 agent 会话（M9 的 s49、s54a）这一批不做；owner 在自己的 agent 里调 `vonvon` 命令行改配置。

用户能看到的：
- 群会话里不再有 vonvon 的飞书 skill、设置 skill，也没有 `settings_get`、`settings_access` 两个工具；只留任务 skill。
- 群里有人要改设置，Bot 说的是"群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"；经命令行在群会话里读、改设置，被拒的也是这句。
- 私聊卡片「设置 → 管理员」：只有主人能加、移本机管理员，别的管理员看到的名单只读（审计 252-1）。
- 飞书开放平台上的应用管理员，20 分钟没刷新成功就不再按管理员算（审计 252-4）。

依赖：K1 #650、D4a、D4b #648、C5 #651（都已在集成分支）。被依赖：无（整批验收）。

## 2. 范围

做：
1. 撤掉 K1 的 skill 改动：删 `builtin-skills/feishu.ts`、`settings.ts`、`session-rules.ts`；`scheduled-tasks.ts` 回到 K1 之前（fc12bdaf）；群那一套只有任务 skill，私聊那一套去掉。`VONVON_SCOPE` 环境变量留着；会话里不带 `--scope` 时的拒绝文字直接说"带上 `--scope "$VONVON_SCOPE"`"。
2. Claude 群会话去掉 `settings_get`、`settings_access`；`session_info` 去掉"要改设置之前先调它"，群里的结果不带设置那一项（工具留着）。`feishu_groups`、`feishu_members`、记忆、任务工具和 Codex 的工具不动。私聊的开关过滤照旧。
3. `NOT_DM_MESSAGE` 换成 owner 定的那句，host 拒命令行也用它。D4a、D4b 的拒绝都留着。
4. 审计 252-1（P1）：私聊卡片加、移管理员只认主人。
5. 审计 252-4（P2）：飞书来的管理员只在最近一次成功刷新后的 20 分钟（两个刷新间隔）内算数；主人、扫码的人、本机名单不受影响；启动时读到的快照按它的 `fetchedAt` 判。
6. 文档：`product.md` 3.5、3.6、3.7、3.8、第 6 节、决定记录；`v1-plan.md` 的 s48 和 2026-11-02 一条；`architecture.md` 的设置一行；`devices.md` 第 20 节；`skills-scope.md` 开头标作废。

不做：
- 群里的 `/settings` 卡片（审计 252-2）：owner 没定，默认保留，`product.md` 3.7 写成例外。
- 审计 252-3（令牌按轮发、按轮作废的细节）、252-5：记进 `product.md` 3.8"留下的风险"，不改代码。
- 3.5 的"查飞书上下文"（按会话 id 查话题、查主区更早的消息）：以后做，`product.md` 标出来，形式到时候再定。
- 私聊会话（s49）、设置 skill（s54a）：M9。
- 云文档评论会话：本来就没有设置工具，不动。

## 3. 现在的代码

- `D/agent/builtin-skills/registry.ts:11` `builtinSkillsOfSet(set: 'group' | 'dm')`：群 = `[scheduledTasksSkill, feishuSkill]`，私聊 = `[scheduledTasksSkill, feishuSkill, settingsSkill]`。`session-rules.ts` 的 `SESSION_RULES` 被三个 skill 拼在开头。`claude-agent/thread.ts` 的 `BUILTIN_SKILL_NAMES` 从群那一套推出来。
- `D/agent/entry/registry.ts:53` `NOT_DM_MESSAGE = '设置只能在私聊里改。请对方去私聊里跟我说。'`；`session_info` 在登记表里算，群里也带 `settings: {allowed, reason}`。
- `D/agent/entry/tools.ts:48` `session_info` 的说明："查这条会话在 vonvon 里属于哪里，以及这一轮能不能改 vonvon 的设置。要改设置之前先调它……"。
- `D/agent/entry/command-tools.ts:41-53` `settings_get`（群里只给本群、各段标只读）、`settings_access`（群里回 `not-dm`），`class: 'read'`，群和私聊都列出来。
- `D/server/authz.ts:52` `SCOPE_MISSING` 叫人写 `--scope bot=<appId>[,group=<chatId>]`；`:83` `read.project` 群令牌 `host` 放行，`sessionView`（`:385`）把各段标只读。
- `D/bot/handle-message.ts:6292-6330` 私聊卡片 `DM.addAdminForm`、`DM.addAdminSubmit`、`DM.rmAdmin`：只要能点到这张卡（主人或管理员）就能加、移本机管理员。
- `D/card/dm-cards.ts:1506` `buildAdminsCard(cfg, names)`：总带 🗑 移除和 ➕ 加管理员。
- `D/config/app-roles.ts:9` `APP_ROLE_CACHE_MS = 10 分钟`；刷新失败后同样等 10 分钟才再试；`roles.admins` 不看快照新旧，直接用：`config/schema.ts:364` `isAdmin`、`bot/ask-coordinator.ts:74`、`handle-message.ts:5349`、`admin/settings.ts:648, 1120`、`dm-cards.ts:1517`。

## 4. 怎么改

### 4.1 skill

- `git rm` 三个文件；`scheduled-tasks.ts` 用 `git show fc12bdaf:` 的内容（只有 K1 de033df6 改过它）。
- `builtinSkillsOfSet(set: 'group')` 只返回 `[scheduledTasksSkill]`；去掉 `'dm'`（没有调用方）。注释写明：vonvon 不发飞书 skill，设置是私聊会话的事，以后做。
- `config/session-env.ts`、`handle-message.ts` 的 `sessionEnv` 注释不再提内置 skill；`VONVON_SCOPE` 本身不动。
- `server/authz.ts`：`SCOPE_MISSING` 改成"这次调用来自 Bot 会话，要带上 `--scope "$VONVON_SCOPE"`（vonvon 给这条会话设好的范围，照抄，不要自己拼），不能比会话本身的范围大。"；范围超出那句后面加"改用 `--scope "$VONVON_SCOPE"`，不要重试更大的范围。"。`cli/index.ts` 的 `--scope` 帮助（英文，和其余帮助一样）结尾加 `a Bot session's commands must carry it: --scope "$VONVON_SCOPE"`。

### 4.2 会话工具

- `AgentTool` 加 `places?: readonly AgentPlace['kind'][]`：写了就只在这些地方列出、能调；没写就照它的类。`settings_get`、`settings_access` 写 `places: ['p2p']`。
- 登记表 `tools()` 和 `call()` 都先看 `places`：不在的地方不列；硬调回 `unknown-tool`（和工具不存在一样，不说"私聊能改"，免得模型去试）。
- `command-tools.ts`：`visible` 只认私聊里的主人或管理员；`settings_access` 的群里分支、"设置只能在私聊里改。"那段死代码删掉。
- `session_info`：说明改成"查这条会话在 vonvon 里属于哪里（群、私聊还是文档评论），以及现在这一轮是不是有人发消息触发的。平时不用调。"；结果只有私聊带 `settings`。
- Codex 群会话本来只有任务工具，不动。

### 4.3 命令行（群令牌）

`authz.ts` 的 `RULES`：`read.project` 挪到 `read.agent read.session` 那一行（`WRITE`：私聊 `bot`、群 `not-dm`、评论 `not-dm`）；`models`、`sessions` 照旧群里 `host`。`sessionView` 剩下的只有私聊用，不再标只读。这样群会话经命令行能读到的设置不比工具多（工具一项都没有）。

### 4.4 拒绝文字

`NOT_DM_MESSAGE = '群里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。'`（owner 原话）。host 判 `not-dm` 时用它（`authz.ts` 的 `case 'not-dm'`），工具判 `not-dm` 时也用它。D4a（host）、D4b（Bot 进程）的其余拒绝不动。

### 4.5 管理员卡片（252-1）

- `handle-message.ts`：`dmOwner(openId)` = `resolveOwner(cfg) === openId`；`adminsCard(evt)` 统一出卡，`editable` 只给主人。
- `DM.admins`、`DM.addAdminForm`：不是主人就给只读名单（不出表单）。
- `DM.addAdminSubmit`、`DM.rmAdmin`：不是主人就不写，日志记 `refused: 'not-owner'`，回只读名单（旧卡片、伪造的回调也挡住）。
- `buildAdminsCard(cfg, names, { editable })`（必填）：只读时没有 🗑 移除、➕ 加管理员，只有返回设置，加一行"本机管理员名单只有主人能改。飞书应用拥有者和管理员请在飞书开放平台管理。"。

### 4.6 飞书管理员的有效期（252-4）

- `app-roles.ts`：`APP_ROLE_RETRY_MS = APP_ROLE_CACHE_MS / 2`（5 分钟），`APP_ROLE_TRUST_MS = 2 * APP_ROLE_CACHE_MS`（20 分钟）；`trustedFeishuAdmins(snapshot, now = Date.now())`：快照的 `fetchedAt` 离现在超过 20 分钟（往前往后都算，防时钟回拨）就返回空。
- 刷新失败后 5 分钟再试（原来 10 分钟），保证一次失败不会让 20 分钟窗口过期。`bridge.ts` 的兜底定时器同样用 `APP_ROLE_RETRY_MS`。
- 用 `roles.admins` 的五处都换成 `trustedFeishuAdmins(roles)`。`roles.ownerOpenId`（飞书应用拥有者）、扫码的人、本机名单不受影响。
- 启动时从 `app-roles.json` 读到的快照照样按 `fetchedAt` 判，旧快照里的管理员在第一次刷新成功前不算。

## 5. 测试

- `builtin-skill-text.test.ts`：回到 K1 之前的任务 skill 断言；加"设置和命令行留给 daemon"（群那一套只有任务 skill、文本里没有 `settings`、`not-dm` 那句）和 `VONVON_SCOPE` 一组。
- `claude-builtin-skill.test.ts`：群会话的 skill 名单是 `['own-skill', 'vonvon:scheduled-tasks']`。（main 必败）
- 删 `builtin-skill-commands.test.ts`、`helpers/skill-commands.ts`、`manual/skills-probe.ts`（测的是撤掉的 skill 里的命令）；`helpers/cli-commands.ts` 去掉只给它们用的 `loadProgram`。
- `s47-tools.test.ts`：群里管理员那一轮列不到 `settings_get`、`settings_access`，硬调回 `unknown-tool`（main 必败）；私聊列得到；私聊开关关掉时读被拒；私聊非管理员 `settings_access` 不可用。
- `agent-entry-registry.test.ts`：群里 `session_info` 是 `{ v: 1, place: 'group', turn }`，没有 `settings`（main 必败）；私聊非人发的一轮带 `settings: { allowed: false, reason: 'not-human-turn' }`；`places` 一条：列出和调用都看它。
- `message-queue-races.test.ts`：同上的 `session_info` 形状。
- `authz-session.test.ts`：`NOT_DM_MESSAGE` 新文字；群令牌 `settings.read` 被拒 `not-dm`（main 必败）；收窄的检查改用私聊读。
- `cli-bot-session.test.ts`：缺 `--scope`、范围超出的文字带 `$VONVON_SCOPE`（main 必败）；群令牌 `settings set --group`、`settings get --group` 被拒、文字是新那句。
- `app-roles.test.ts`：假时钟（`vi.useFakeTimers({ toFake: ['Date'] })`）走一遍：刷新成功 → 19 分钟还算 → 刷新连续失败 → 21 分钟不算 → 再成功又算（main 必败）；`trustedFeishuAdmins` 往前往后超过 20 分钟都返回空。
- `settings-owner.test.ts`：`buildAdminsCard` 可改和只读两种。
- 新 `dm-admin-owner.test.ts`（main 必败）：经卡片分发器点：管理员点「管理员」看到只读、主人看到按钮；管理员移别的管理员被拒、名单不变，主人能移；管理员从表单或旧卡片加人被拒，主人能加。
- 三个整模块替身（`bridge-session-memory`、`scheduled-run-shutdown`、`bridge-card-callback`）补 `APP_ROLE_RETRY_MS`、`trustedFeishuAdmins`。
- `manual/bot-authz-probe.ts` 的期望文字换成新那句。

## 6. 自测

Claude 在 JP-VPS 上做，不发飞书消息、不碰 `accept-home2`：daemon 的 typecheck、build，上面列的测试文件和受影响的相关文件（skill 包、工具登记、authz、命令行会话、角色、卡片、队列）。真飞书和私聊卡片在整批验收里做。

## 7. 文档

- `product.md`：3.5 "查飞书上下文"标以后做；3.6 内置 skill 只有任务 skill；3.7 群那一行、私聊这一批不跑 agent 会话、命令行不教 skill、设置工具只在私聊、管理员卡片只主人改、`/settings` 卡片例外；3.8 留下的风险加 252-3、252-5；第 6 节角色缓存（10 分钟刷新、失败 5 分钟再试、20 分钟有效、启动快照）；决定记录第 4、26 条和最后的对照表。
- `v1-plan.md`：s48 那一行写"以后做"，加 2026-11-02 一条。
- `architecture.md`：设置那一行。
- `devices.md`：第 20 节和各处指过去的标注；`skills-scope.md` 开头标作废。

## 8. 验收要点

1. 群会话（Claude、Codex）拿到的内置 skill 只有任务 skill；仓库里没有 `feishu.ts`、`settings.ts`、`session-rules.ts`，`scheduled-tasks.ts` 和 fc12bdaf 一样。
2. Claude 群会话的工具列表里没有 `settings_get`、`settings_access`，硬调回 `unknown-tool`；`session_info` 群里没有 `settings`；私聊照旧。
3. 群令牌 `vonvon settings get`、`settings set` 都 exit 4，文字是新那句；`group show`、`session list`、`feishu groups/members` 照旧只给本群。
4. 缺 `--scope`、范围超出的拒绝文字里有 `--scope "$VONVON_SCOPE"`。
5. 私聊卡片：管理员看到只读名单，伪造的加、移回调不改名单；主人照旧能改。
6. 飞书管理员在快照超过 20 分钟后不再算管理员；`roles.admins` 没有地方绕开 `trustedFeishuAdmins` 直接用。
7. 文档和代码一致：拒绝文字、20 分钟、`/settings` 例外、以后做的几项。
8. diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 代码和测试约 +360 / −680 行，文档约 +200 / −30（删得多：三个 skill 和它们的测试），不含 lockfile。
- 风险一栏：错误路径（拒绝文字、`unknown-tool`）、权限（管理员卡片、角色缓存的有效期）。审查按两块：skill 与会话工具；权限修正（管理员名单和角色缓存）。
- 飞书开放平台连续 20 分钟以上刷新失败时，飞书来的管理员暂时变成普通成员；主人和本机名单不受影响，恢复后下一次刷新自动回来。

## 实现时和计划不一样的地方

这份计划和代码同一个 PR 写成，下面几条是动手时定下、计划正文已经照着写了的取舍，单列出来方便审查：

1. **群令牌读设置也拒（4.3）。** owner 说的是"群里没有设置工具"；命令行那条路如果还能读本群设置，群会话经完全访问档的 shell 就比工具多一项能力，所以 host 也拒，`not-dm`。`group show`（`collaboration.project`）、`session list`、`models`、`feishu groups/members` 仍给本群，它们不是设置。owner 要是想让群里还能读本群设置，把 `read.project` 挪回 `{ dm: 'bot', group: 'host', comment: 'not-dm' }` 那一行即可。
2. **刷新失败后 5 分钟再试（4.6）。** 原来是 10 分钟；有效期 20 分钟时，一次刷新失败再等 10 分钟，碰上第二次失败就过期了。改成 5 分钟，偶尔一次失败不会让管理员掉权限。
3. **用 `places` 字段，不是在 `command-tools.ts` 里按地方返回不同列表。** 列出和调用走同一个判断，硬调和列表一致；以后私聊会话加别的私聊专用工具也用它。
4. **`session_info` 的 `settings` 只在私聊带。** 评论会话原来也带，一起去掉了（评论会话本来就不能改设置）。
5. **不是主人看到只读名单，而不是一句"只有主人能改"。** 管理员仍能看谁是管理员；旧卡片上的按钮点了也只回只读名单。
6. **`context-weave.ts` 里"需要时用 vonvon 飞书 skill 查"那几句没改。** 那是 s14 时的开场提示（早于 K1），说的正是 3.5 以后做的查询；改它会动话题开场的文字和一批测试，不在本片范围，留给做 3.5 查询的那一片一起定。
7. **评论会话被拒也是这句"群里不能改设置……"。** `NOT_DM_MESSAGE` 只有一句，评论会话原来用的也是同一个常量；评论会话里几乎碰不到设置，这一批不单写一句。

## S1b：群里只给干活要用的（owner 2026-11-02 晚）

S1 做完、送审查之前，owner 又定了几条，在同一个分支上接着做：
- 群里不管经工具还是经命令行，凡是改配置的都禁止，而且要在命令行和工具这一层挡，不靠 skill 的文字。
- 查询也要管：隐私信息查不到，但不能影响功能，比如定时任务的查询不能禁。
- vonvon 自己的 skill 都以 `vonvon` 开头。
- 群里的 `/settings` 去掉。
- 飞书消息的格式改成 skill，开场说明只留每一轮都要守的。
- 两个 skill 的描述要写到该用时一定会被打开，并用两家的真实模型测过。

### 做了什么

1. **群改成白名单（`D/server/authz.ts` 的 `RULES`）。** 群这一格只留干活要用的，其余默认拒绝：
   - `schedule.*`（Bot 进程判）；
   - `memory list/add/edit/archive`（Bot 进程判）；
   - `command.listGroupMembers`（只查本群）；
   - `admin.negotiate`；
   - `snapshot.get`（收窄过的快照）。

   被拒的有：
   - `command.refresh/listPendingGroups/listJoinedGroups`、`settings.models/sessions`；
   - `collaboration.history/context/project/providerModels`、`library.list`；
   - `memory.export/events`、`admin.daemonStatus`。

   改设置的回 `not-dm` 那句，其余回 `SESSION_DENIED`（"这个操作不能从 Bot 会话里做。"），不透露有什么。评论这一格核对过，只有 `snapshot.get`（只剩 bot 本身）和 `admin.negotiate` 放行。`test/authz-session.test.ts` 加了一个探针：群令牌把 `rpcKinds()` 的每一种都调一次，白名单里的放行，其余全拒。
2. **快照（`D/server/snapshot-filter.ts` 的 `sessionSnapshot`）。** 私聊令牌照旧用 `filterSnapshot`。群令牌和评论令牌只剩：
   - 本 bot 的 id、名字和状态；
   - 本群的 id 和名字；
   - 本群项目的 id、名字和本群那一条绑定。

   `memberships`、`tools`、`jobs` 都是空的，文件夹、数据目录、连接说明填空字符串。`http.ts` 推的 `snapshot` 事件也走同一个函数。
3. **记忆回包（`groupMemoryReply`）。** 群令牌看记忆，回包收窄到和 `memory_list` 工具一样：
   - 只列现行条目；
   - 去掉最后修改人、来源里的 bot 和 openId、事件号、新增 id、问题清单；
   - 分支不带创建人。

   `export`、`events` 里有作者和改前的原文，只在私聊里给。
4. **进程内工具。** `feishu_groups` 只在私聊里有（`places: ['p2p']`），`feishu_members` 只在群和私聊。群里的工具剩 `session_info`、`feishu_members`、`memory_*`、`schedule_*`。Codex 群会话本来只有 `schedule_*`，没动。
5. **命令行。**
   - `not-dm` 只打那一句，不加"读取设置失败："（S1 的第 5 个待定问题）。
   - 会话的快照里看不到任何绑定时（群会话、评论会话），`pickGroup` 回 `SESSION_DENIED`（exit 4），不说"没有绑定"。`settings` 在这种情况下把 `--group` 原样交给 daemon，daemon 回 `not-dm` 那句。
   - `schedule --group <项目名>`、`memory --project` 在会话里从快照的 `projects` 解析，不读 `library.list`。
6. **`/settings` 只在私聊里有。**
   - 群里三处 `/settings` 分支（单会话群的主区、话题里、多会话群的主区）都改成回 `NOT_DM_MESSAGE`，不发卡、不看是不是管理员。
   - `GS.*` 五个回调（免 @、旧的自动压缩、回群设置卡、默认模型、默认模型表单）一律把卡变成这句话，什么也不写。这些卡只在群里发过，回调里分不出位置，也不用分。
   - `/help`、欢迎卡和"本群默认需 @"那一行都去掉了 `/settings`。

   顺带查了还有没有别的，在群里发出来就能改持久设置的卡片或命令，结果只有 `GS.*` 一组：
   - `/model`（`MC.*`）只改当前会话；
   - 新群的绑定卡发给 open_id，也就是私聊；
   - `DM.*` 只在私聊；
   - `/new`、`/clear`、`/compact`、`/context`、`/resume`、`/goal` 是会话操作。
7. **skill。**
   - `scheduled-tasks.ts` 用 `git mv` 改成 `schedule.ts`：名字 `vonvon-schedule`，标题"定时任务"，描述照 s1b 的草稿。正文不变。
   - 新加 `feishu-message.ts`：名字 `vonvon-feishu-message`，标题"飞书消息格式"。正文照 `card/markdown-render.ts`、`report-render.ts`、`file-refs.ts` 实际支持的写：
     - 能显示的写法，含表格（最多 5 张，格子里的图片挪到末尾，不放进 `feishu-card`）和 `<font color>`；
     - 发文件；
     - 图片和截图；
     - `feishu-card` 卡片；
     - 不要 `codex-followup`。
   - `builtinSkillsOfSet('group')` 返回这两个 skill。
   - 名字不用迁移：内置 skill 的名字每次开会话都从代码算，不写到盘上；群的禁用名单只记用户 skill 的路径。
   - 文件改成 0444。内容没变也会把权限改回 0444；覆盖或删除前先改成 0644，因为 Windows 不让 rename 或 unlink 只读文件。
8. **开场说明（`bridge-instructions.ts`）。** 只留：
   - 第一句；
   - 红线和不复述开场；
   - 记忆约定；
   - 设置更新只认最前面那份；
   - 自动消息；
   - 交付文件那一句（`FILE_DELIVERY`）。

   卡片和图片的写法挪进 skill。`codex-file-citation` 那句去掉，因为 `file-refs.ts` 已经把它转成文件链接。`codex-followup` 没有处理，所以写进 skill 的"别的"一节。
9. **评论会话的拒绝句。** `NOT_DM_COMMENT_MESSAGE`："评论里不能改设置。私聊我可以改，也可以在 Vonvon Bot 客户端或命令行里改。"按位置选句子，工具和 daemon 都用 `notDmMessage(place)`（S1 的第 4 个待定问题）。
10. **`context-weave.ts`。** 删掉"需要时用 vonvon 飞书 skill 查""更多话题用 vonvon 飞书 skill 列"这几处，因为那个 skill 不存在。留下的都是事实：哪些内容不在这里、哪些没带进来（S1 的第 2 个待定问题）。
11. **252-3。** S1 已经记进 3.8"留下的风险"，这次不改代码。

### 和 s1b 的要求不一样的地方

1. **群快照不给 `memberships`。** s1b 说的是"命令行解析名字需要的字段"。但 `membershipSchema` 的权限档、目录、后端、会话方式都是必填，填假值会让命令行和读快照的 agent 读错，所以给空数组。解析名字改用 `projects` 里本群项目的那一条绑定，`schedule` 和 `memory` 两个命令按它解析。代价：群会话里 `vonvon group list` 是空的，`--group` 写错名字时回"这个操作不能从 Bot 会话里做。"。
2. **`admin.daemonStatus` 在群里也拒。** s1b 让按实际调用确认要不要放行。实际情况：会话里的 `vonvon daemon status` 读锁文件，不发这条 RPC（`cli-bot-session.test.ts` 有这一步），回包里有本机路径，所以拒。`snapshot.get` 照旧放行，命令行每条命令都先读它。
3. **记忆的 `list`、`item` 回包也收窄。** s1b 只要求核对 `export`、`events`。但 `list` 的回包也带最后修改人、来源 openId 和事件号，比 `memory_list` 工具给的多，所以一起收窄。`export`、`events` 拒绝。
4. **飞书消息格式 skill 的正文比开场说明里原来那段多。** 多了能显示的写法（标题、表格、颜色）和 `codex-followup`，都是照渲染器实际支持的写的。
5. **S1 里"实现时和计划不一样的地方"第 1、6、7 条被这一节改掉了。** `group show`、`session list`、`models`、`feishu groups` 在群里也拒；话题开场那几句改了；评论会话有它自己的句子。第 8 节验收要点第 3 条也照这一节改。

### 触发测试

脚本 `packages/daemon/test/manual/skill-trigger-eval.ts`，开头写了怎么跑。每条消息各开一个短会话，开法和 vonvon 开群会话一样：
- Claude 走 Agent SDK，带内置插件；Codex 走 app-server，带 `selectedCapabilityRoots`。
- 只读档；工具是群的那一套，每次调用都回"没有执行"；用户消息前面加一段群的记录块。

用的是 JP-VPS 上已登录的账号，HOME 没改，用后端的默认模型：Claude 是 `claude-opus-5-5`（Agent SDK 0.3.296），Codex 是 `gpt-6.1-sol`（0.163.0）。

怎么算"打开了"：
- Claude 看 `Skill` 调用。
- Codex 读的是线程的 rollout。它通过 `skills.read` 读 skill 正文，经常写在 code-mode 的 `exec` 脚本里，和任务工具在同一个脚本里调；这种调用不在 app-server 推来的事件里，所以只看事件会全部判成没打开。

结果：第一轮两家 46 条全对，描述就用 s1b 的起点草稿，没有改。

花了大约 57 次调用。其中 11 次是在修判定：
- 第一次接 Claude 的 SDK 消息没接上；
- Codex 第一版只看事件。
这两次跑的结果都作废。

| # | 消息 | 应该打开 | Claude | Codex |
|---|---|---|---|---|
| s1 | 每天早上 9 点在群里发一下昨天的进度 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s2 | 20 分钟后再看看构建结果 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s3 | 本群有哪些定时任务 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s4 | 把下周一的提醒停掉 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s5 | 每个工作日下午 6 点提醒大家填日报 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s6 | 明天上午十点提醒我跟进一下合同 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s7 | 每隔两小时检查一下线上告警，有问题就在群里说 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s8 | 把周报那个任务改成每周五下午 4 点 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| s9 | 部署完了，你过半小时回来看看日志有没有报错 | 定时任务 | ✓ 定时任务 | ✓ 定时任务 |
| f1 | 用卡片总结一下这次改动：登录页改版、修了导出的乱码、接口超时从 10 秒改成 30 秒 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f2 | 把报告文件发给我 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f3 | 截个图放上来 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f4 | 把 Redis、Memcached、本地缓存三个方案的优缺点做成表格发群里 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f5 | 做一张本周的 changelog 卡片 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f6 | 把刚才生成的 CSV 导出给我下载 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f7 | 回复里把关键风险用红色标出来：数据库迁移没有回滚脚本、证书下周过期 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f8 | 画个部署架构图放到回复里 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| f9 | 帮我把这周的进展整理成周报，用标题和分隔线排好版：完成支付对账、上线灰度、修复 3 个线上问题 | 飞书消息格式 | ✓ 飞书消息格式 | ✓ 飞书消息格式 |
| n1 | 解释一下这段代码：`const total = items.reduce((sum, item) => sum + item.price, 0)` | 都不打开 | ✓ 都没打开 | ✓ 都没打开 |
| n2 | 帮我看下这个 bug：登录成功后跳到了 404 页面，可能是什么原因 | 都不打开 | ✓ 都没打开 | ✓ 都没打开 |
| n3 | 今天天气怎么样 | 都不打开 | ✓ 都没打开 | ✓ 都没打开 |
| n4 | TypeScript 里 interface 和 type 有什么区别？ | 都不打开 | ✓ 都没打开 | ✓ 都没打开 |
| n5 | JS 的 setInterval 和 setTimeout 有什么区别？ | 都不打开 | ✓ 都没打开 | ✓ 都没打开 |

旁注：
- Claude 在 n2 跑了一次 `Bash`，看工作目录。
- Codex 在 f2、f6 也去列了工作目录；f8 同时打开了这台机器上用户自己的 `gstack-diagram` skill，还调了生图；n3 回问用户在哪个城市。

限制：
- 每条消息每家只跑了一次。
- Claude 打开第一个 skill 就停，看不到它后来还会不会打开另一个。
- 用的是这台机器的个人设置，`~/.claude` 和 `~/.codex` 里个人 skill 很多。owner 的 Mac 上没测。

### 验收要点（S1b）

1. 群令牌按 `rpcKinds()` 每种 RPC 各调一次：白名单里的放行，其余全拒。被拒的文字里不出现别的群、路径和模型。
2. 群会话的快照里，没有别的群、文件夹、权限档、模型和设备。
3. 群里 `/settings` 只回那句话、不发卡；旧群设置卡被点后，设置不落盘；私聊 `/settings` 照旧。
4. 群会话的内置 skill 是 `vonvon-schedule`、`vonvon-feishu-message`，文件是 0444；开场说明里没有卡片的写法，有交付文件那一句。
5. 触发测试的结果写在 PR 里。
