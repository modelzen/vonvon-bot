# K1 `skills-scope`：三个内置 Skill 配合新命令行，群里不改设置，带 `--scope`

> 2026-11-02 作废（owner）：本片加的飞书 skill（`feishu.ts`）、设置 skill（`settings.ts`）和三个 skill 共用的开头（`session-rules.ts`）都由 S1 `settings-dm-only` 撤掉了，任务 skill 回到本片之前；群会话也不再有设置工具。见 `docs/plans/settings-dm-only.md` 和 `docs/plans/devices.md` 第 20 节。下面是本片当时的计划，留作记录。

总设计见 `docs/plans/devices.md` 第 5 节开头（会话里的命令行和工具同一套规则）、5.2（★ 行）、5.3（范围参数和会话令牌）、第 9 节（内置 Skill）、第 14 节第 2–5 条（群会话不写设置、私聊照 3.7、会话以外全能改、会话里的命令行同一套规则）、第 15 节（文字）。命令行在会话里实际怎么拒，以 D4a（`devices-4a-scope.md`）、D4b（`devices-4b-bot-authz.md`）合入后的代码为准；C3、C4、C6 给了 `group show/set`、`session list`、`feishu groups/members`、`settings act`、`schedule edit --new-topic/--follow` 这些命令。缩写同 D1：`D/` 是 `packages/daemon/src/`，`P/` 是 `packages/protocol/src/`。

## 1. 做什么

用户能看到的：Bot 在群里被要求改设置（权限档、会话方式、成员名单）时，回"设置只能在私聊里改。请对方去私聊里跟我说。"，不去试命令行；被要求重启、升级 vonvon 时说明会话里不能做、请对方去那台设备上或桌面端里做；完全访问档、工具用不了时，Bot 照 skill 用 `vonvon` 命令行建、改本群的定时任务和做只读查询，每条都带这条会话自己的 `--scope` 和 `--json`，范围写错被拒后不换更大的范围重试。私聊改设置的 skill（改完说清范围、改前 → 改后、什么时候生效）写好了，等私聊有会话（s54a）时交过去。

依赖：C1、C3、C4、C6、D4b（D4a 在 D4b 之下）。被依赖：无（整批验收）。

## 2. 范围

做：
- 三个 skill 共用的开头几行（`D/agent/builtin-skills/session-rules.ts`，新）。
- 任务 skill（`scheduled-tasks.ts`）：开头几行，加"没有任务工具时"一节，教 `vonvon schedule …` 带 `--group`、`--scope`、`--json`。
- 飞书 skill（`feishu.ts`，新）：只读查询的工具和命令行、`--json` 的形状、被拒时怎么说；lark-cli 照旧。
- 设置 skill（`settings.ts`，新）：私聊里谁能改、先读再改再说清改前 → 改后、命令行备用、不在聊天里做的事。
- `registry.ts`：群的那一套是任务 + 飞书；新加私聊那一套（飞书 + 设置），这一批没有地方交出去。
- 会话的环境变量加 `VONVON_SCOPE`（`D/config/session-env.ts`、`D/bot/handle-message.ts` 的 `sessionEnv`），skill 照抄它当 `--scope` 的值；vonvon 自己起的子进程连同令牌一起去掉。
- 测试：skill 文字、每行命令在真命令树上解析得通、`VONVON_SCOPE` 的值；手动探针在临时 daemon 上真跑每一行。

不做：
- 私聊会话本身（今天私聊不跑 Agent 会话，走 `dm-console`）→ s54a；那时由它把 `dm` 那一套交给私聊会话，"聊天改设置"关着时不交设置 skill。
- 记忆的命令行（`vonvon memory …` 在会话里到 C5 之前整体拒）→ C5 合入后在 skill 里补。
- `product.md` 3.5 的话题和会话管理写进飞书 skill → s48。
- 设置回执卡和［撤销］→ 推迟（设计第 14 节第 7 条）。
- 新的 Skill：不加（`requirements.md`："本期只把三个内置 Skill 改成配合新命令行、带范围参数；不新增 Skill"）。

## 3. 现在的代码

- `D/agent/builtin-skills/package.ts`：`BuiltinSkill { name, title, description, body }`；`ensureBuiltinPackage(appId, set, skills)` 写 `bots/<appId>/capabilities/builtin/<set>/skills/<name>/SKILL.md`，frontmatter 只有 `name`、`description`（`JSON.stringify` 过），不写 `hooks`、`allowed-tools`。
- `D/agent/builtin-skills/registry.ts`：`builtinSkillsOfSet('group')` 今天只回 `[scheduledTasksSkill]`；没有 `dm` 那一套。设计第 9 节写的 `feishu.ts`、`settings.ts` 在代码里不存在。
- `D/bot/handle-message.ts` `profileOf`：只有绑定群、非评论的会话（`schedule` 为真）拿内置包（`builtinPackage`，约 1180 行）；Claude 经 `vonvon@inline` 插件加载，白名单 `BUILTIN_SKILL_NAMES`（`D/agent/claude-agent/thread.ts:120`，取自 `builtinSkillsOfSet('group')`）；Codex 经 `selectedCapabilityRoots`（`D/agent/codex-appserver/backend.ts:108`）。
- `D/bot/handle-message.ts` `sessionEnv`（约 1407 行，D4a）：向 host 要会话令牌，放进 `VONVON_SESSION`，经 `profile.env` 进会话的 shell。
- `D/config/session-env.ts`：`SESSION_ENV`、`inBotSession`、`withoutSessionMarkers`（vonvon 自己起子进程时去掉会话标记，`supervisor.ts`、`daemon.ts`、`lifecycle.ts`、`restart.ts`、`service-action.ts` 用）。
- `D/cli/index.ts`：全局 `--scope <spec>`（88 行），`preAction` 里经 `admin.negotiate` 交给 daemon；`LOCAL_ONLY`（65 行）在会话里直接 exit 4 `not_in_session`。
- `D/server/authz.ts`：群令牌的范围只能是本群，私聊、评论令牌是 `bot=<appId>`；`SCOPE_MISSING`（52 行）、`scopeExceeded`（53 行）、`ONE_GROUP_ONLY`（116 行）、`SESSION_DENIED`；群、评论令牌的设置写由 host 先拒 `not-dm`；★ 行经 D4b 的 `askBot` 问 Bot 进程。
- `D/agent/entry/registry.ts`：`NOT_DM_MESSAGE`（53 行）和 `not-admin`、`switch-off`、`turn-ended`、`not-group` 的文字；进程内工具 `session_info`（不给 id，s46 4.3）、`settings_get/set/access`（写只在私聊）、`feishu_groups/members`、`schedule_*`（只在群里）。Codex 只拿到 `schedule_*`，没有 `session_info`（T3b）。
- `P/display.ts`：`FULL_ACCESS_WARNING`。

## 4. 怎么改

### 4.1 范围值：`VONVON_SCOPE`

`session-env.ts` 加 `SESSION_SCOPE_ENV = 'VONVON_SCOPE'` 和 `sessionScope(appId, chatId?)`：群是 `bot=<appId>,group=<chatId>`，私聊和评论是 `bot=<appId>`，正好是这条会话能到的最大范围。`sessionEnv` 发令牌的同时把它放进 env。`withoutSessionMarkers` 连它一起去掉。它不是权限：daemon 照令牌核 `--scope`，env 写什么都一样。

skill 一律写 `--scope "$VONVON_SCOPE"`，要群 id 时先 `echo "$VONVON_SCOPE"`，取 `group=` 后面那段。

### 4.2 三个 skill 共用的开头几行（`session-rules.ts`）

`SESSION_RULES` 是六行，三个 skill 的正文都以它开头：
1. vonvon 的事先用工具；命令行只是备用，规则和工具一样，能做的不比工具多。
2. 只有没有工具、shell 能跑 `vonvon`（完全访问档）时才用命令行；每条带 `--scope "$VONVON_SCOPE"` 和 `--json`；照抄，不拼、不换；它是空的，这条会话就不能用命令行。
3. 群里不改任何 vonvon 设置；有人要改就回 `not-dm` 那句（从 `registry.ts` 的 `NOT_DM_MESSAGE` 拼进来，不另写一份），不去试命令行。
4. 群里用命令行能做的只有本群的定时任务和只读查询；记忆照开场的记忆约定做，不用命令行。
5. 范围不对会被拒（exit 4），不换更大的范围，不去掉 `--scope`。
6. 重启、升级、停止、后台服务、远程、配对在会话里一律被拒，不替用户跑，告诉用户去那台设备上或桌面端里做；不读数据目录里的凭据文件，不绕开命令行自己连 vonvon。

### 4.3 任务 skill

原有八节和描述一字不改，开头加 `SESSION_RULES`，在"谁能改"前加一节"没有任务工具时"：`schedule list/add/edit/pause/resume/run/delete`，每条带 `--group <chatId> --scope "$VONVON_SCOPE" --json`；时间选项（`--every/--daily/--weekly/--at/--cron`、`--tz`）、`--new-topic`/`--follow`；id 和 `revision` 从 `schedule list --json` 的 `tasks` 取；exit 4 把 `error.message` 原话告诉用户。

### 4.4 飞书 skill（新，群和私聊两套都有）

描述："查本 Bot 的群、群成员、本群在 vonvon 里的绑定、会话和设置（只读）；群里有人要改 vonvon 的设置，或者让你重启、升级 vonvon 时，也先读本 skill。"——群里有人要改设置、要重启时，模型靠描述找到它，读到开头几行。

正文：什么时候用；有工具先用工具（`feishu_groups`、`feishu_members`、`settings_get`、`session_info`）；命令行只读五条（`feishu groups`、`feishu members <chatId>`、`group show <chatId>`、`session list --group <chatId>`、`settings get --group <chatId>`）和各自 `--json` 的字段（探针核过）；被拒了怎么说（第 4.7 节的文字）；exit 3 连不上就告诉用户；lark-cli 的飞书操作照旧。

### 4.5 设置 skill（新，只在私聊那一套）

- 谁能改：主人或管理员发消息触发的这一轮；加、去掉本机管理员只有主人那一轮；开关关着不能改。由 vonvon 判，被拒了原话告诉对方，不换命令行再试。
- 先读，再改，再说清楚：先 `settings_get`（或 `settings get`）记下改前的值和 `revision`；带 `revision` 改；回复写清范围（整个 Bot 还是哪个群）、改前 → 改后、什么时候生效（照 `effects[].detail`，不猜）。例句照第 15 节。权限档对照 `qa` 只读、`write` 工作区可写、`full` 完全访问；给群选完全访问（含 `group create` 建的群）时加 `FULL_ACCESS_WARNING`。
- 命令行（备用）：`settings get`、`settings get --group`、`settings set --group … permission.mode=qa --revision … --reason …`、`settings set cards.showToolCalls=false --revision …`、`settings act member add|all`、`settings act admin add`、`settings act comment-instructions --text`、`group show/set/create`。
- 不在聊天里做的：密钥（有人发了 key：不存、不复述、提醒换新的）、本机设置、建新 Bot、改别的 Bot、绑已有的群、解绑、换项目或群的文件夹、"聊天改设置"开关、运维。

### 4.6 交给谁（`registry.ts`）

`builtinSkillsOfSet('group')` = `[scheduledTasksSkill, feishuSkill]`：绑定群的会话从下一次建包起多一个飞书 skill，Claude 的白名单跟着多 `vonvon:feishu`。`builtinSkillsOfSet('dm')` = `[feishuSkill, settingsSkill]`，这一批没有调用方。

### 4.7 文案（逐字，不新写）

| 场合 | 文字 | 出处 |
|---|---|---|
| 群里有人要改设置（skill 让 Bot 说的，也是 host 拒的） | 设置只能在私聊里改。请对方去私聊里跟我说。 | `registry.ts` `NOT_DM_MESSAGE`，设计第 15 节 |
| 缺 `--scope` | 这次调用来自 Bot 会话，必须带 `--scope bot=<appId>[,group=<chatId>]`，而且不能比会话本身的范围大。 | `authz.ts` `SCOPE_MISSING` |
| 超范围 | 范围超过了这条会话（只能是 bot=<X>, group=<Y>）。不要重试更大的范围。 | `authz.ts` `scopeExceeded` |
| 会话里跑运维命令（`not_in_session`） | 这条命令（`vonvon daemon restart`）不能在 Bot 会话里运行。告诉用户去设备上或桌面端里做。 | `cli/index.ts` |
| 这一轮已结束 | 这次调用对应的那一轮对话已经结束，不能再改设置。 | D4b |
| 私聊改完（Bot 的回复，写法不是固定文字） | 已把「支付组」的权限从「工作区可写」改成「只读」，<生效时机，照工具回的写>。 | 设计第 15 节 |
| 给群选完全访问 | 完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。 | `P/display.ts` `FULL_ACCESS_WARNING` |

skill 里只引用前两句和最后两句的原文（`NOT_DM_MESSAGE`、`FULL_ACCESS_WARNING` 从常量拼进来）；其余几种拒绝，skill 写"说……时怎么做"，原文由 daemon 回，Bot 原话转告。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `daemon/test/builtin-skill-text.test.ts`（改） | 任务 skill | 原有句子都在；九节（原来八节）；描述不变 |
| 同上 | 两套 | `group` = 任务 + 飞书；`dm` = 飞书 + 设置；群那一套没有设置 skill。main 必败 |
| 同上 | 开头几行 | 三个 skill 都以 `SESSION_RULES` 开头，含 `not-dm` 那句、`--scope "$VONVON_SCOPE"`、不换更大范围、运维被拒 |
| 同上 | 每行命令 | fenced 块里每行 `vonvon …` 以 ` --scope "$VONVON_SCOPE" --json` 结尾 |
| 同上 | 不教的 | 正文里没有 `vonvon secrets/remote/pair/update/service/daemon/clients/device/open/dir/memory/env/provider/mcp/import/bot`、`project workspace`、`group bind/unbind`、`--folder`、`--host`、`--primary` |
| 同上 | 能安全加载 | 描述一行、≤200 字；正文没有 `` !` ``、没有 `hooks:`、`allowed-tools:` 开头的行；没有真实 id、密钥、本机路径 |
| 同上 | 设置 skill | 改前 → 改后那句、`effects` 的 `detail`、例句、`FULL_ACCESS_WARNING`、管理员只有主人改 |
| 同上 | `VONVON_SCOPE` | `sessionScope('cli_app','oc_chat')` → `bot=cli_app,group=oc_chat`；无群 → `bot=cli_app`；`withoutSessionMarkers` 去掉 `VONVON_SESSION` 和 `VONVON_SCOPE` |
| `daemon/test/builtin-skill-commands.test.ts`（新） | 每行在真命令树上解析 | 取三个 skill 的每行 `vonvon …`，按 sh 的规则分词，沿 `program` 的子命令走到叶子；叶子没有子命令；路径不在 `LOCAL_ONLY`；去掉 `--scope "$VONVON_SCOPE"` 后 `leaf.parseOptions` 的 `unknown` 为空；操作数个数合 `registeredArguments`；必填选项都在；带 `--json`。main 必败（feishu、settings 两个 skill 不存在） |
| `daemon/test/claude-builtin-skill.test.ts`（改） | 白名单 | `options.skills` = `['own-skill','vonvon:scheduled-tasks','vonvon:feishu']` |
| `daemon/test/run-retry.test.ts`（改） | 会话 env | 群会话 `profile.env.VONVON_SCOPE` = `bot=app,group=chat`。main 必败 |

手动探针 `daemon/test/manual/skills-probe.ts`（不是 vitest 文件，照 `bot-authz-probe.ts`）：临时 `VONVON_HOME` 里起真的 host（admin IPC、会话令牌、`authz.ts`），fork 一个假 Bot 进程（真 `createAgentEntries`、真 `authorizeSessionCall`），按 `handle-message` 的做法给群会话、私聊会话发令牌、设 `VONVON_SCOPE`；每行 skill 命令占位符换成值，用 `sh -c` 跑打包的 CLI（`$VONVON_SCOPE` 由 shell 展开）：
- 群那一套用群令牌、私聊那一套用私聊令牌，主人那一轮 → 每行 exit 0。
- 拒绝：不带 `--scope`、`bot=` 比本群大、别的群、`VONVON_SCOPE` 空；成员那一轮建任务（放行）；群里改本群权限、会话方式、响应成员、建群、读整个 Bot 的设置 → `not-dm` 原话；`daemon restart/stop`、`update`、`service install`、`pair` → `not_in_session`；`remote enable` → 没有这条命令（D3 前）；绑别的群、解绑本群 → `permission_denied`；私聊成员那一轮 → `not-admin`；管理员那一轮改群权限放行、加管理员 → 只有主人；`project workspace`、`--folder`、`--host`、绑、解绑、本机设置 → 拒；`secrets list`、`daemon restart` → `not_in_session`；那一轮结束后 → `turn-ended`。

## 6. 自测和验收

Linux 自测（JP-VPS，Claude）：
1. `flock /tmp/vonvon-heavy.lock` 构建 protocol、client、daemon，五个包 typecheck。
2. `T=$(mktemp -d)`；`HOME="${T:?}/home" VONVON_HOME="${T:?}/vh" flock /tmp/vonvon-heavy.lock npx vitest run` 上表的测试文件和相关的（`builtin-package`、`profile-of-builtin`、`codex-builtin-skill`、`cli-bot-session`、`cli-parity`、`agent-entry-session`、`session-profile`）；`rm -rf -- "${T:?}"`。
3. 探针：在 `packages/daemon` 里把 `src/cli/index.ts` 和探针各用 esbuild 打成一个文件（`--bundle --platform=node --format=esm --packages=external`，输出在 `node_modules/.cache` 下 `mktemp -d` 的目录），`HOME="${T:?}/home" VONVON_HOME="${T:?}/vh" node <probe.mjs> <cli.mjs>`，最后一行"全部符合。"，结果贴进 PR。

真飞书（整批验收时在 Bot 6，`accept-home2`，按 #422 目录锁；本片 PR 标"待整批验收"，设计第 13 节 K1 行）：
- Bot 6 的完全访问测试群里，让 Claude 用命令行建任务：带 `--scope` 成功；让它改大范围（`--scope bot=…`）被拒，exit 4，它不再换更大的范围。
- 让它"重启 vonvon"：被拒并解释，叫人去那台设备上或桌面端里做。
- 群里让它改本群设置：被拒，回"设置只能在私聊里改。请对方去私聊里跟我说。"，日志里没有它跑 `vonvon settings set` 的记录。
- 私聊里主人让它改某个群的设置：成功，回复写清改前 → 改后。**这一条要等 s54a**（私聊有 Agent 会话、交 `dm` 那一套）；这一批验不了，PR 里写明。
- 不贴 openId、群号。

Mac 后验：无专项。Windows：无。

## 7. 文档

- `docs/product.md` 不改：3.6 的内置 Skill 和 3.7 的私聊改设置已由 D0 按三层写好；私聊会话在 s54a。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 三个 skill 的正文都以同一份 `SESSION_RULES` 开头；`not-dm` 那句和完全访问警示从常量拼进来，不是第二份文字。
2. 每行 `vonvon …` 都带 `--scope "$VONVON_SCOPE"` 和 `--json`，在真命令树上解析得通，不在 `LOCAL_ONLY`；探针里每行在主人那一轮 exit 0。
3. 群那一套没有设置 skill；群里能用命令行做的只有本群任务和只读查询；skill 不教任何会话里被拒的命令（密钥、运维、远程、配对、`project workspace`、`--folder`、`--host`、绑群、解绑、记忆）。
4. `VONVON_SCOPE` 和令牌一起设、一起被 `withoutSessionMarkers` 去掉；值只是这条会话的最大范围，daemon 照令牌核，不当权限用。
5. 任务 skill 原有的描述和句子一字不改；Claude 的白名单多 `vonvon:feishu`，Codex 从同一个包读。
6. skill 的 frontmatter 只有 `name`、`description`（`package.ts` 写），没有 `hooks`、`allowed-tools`；正文没有 `` !` ``。
7. 设置 skill 写了改前 → 改后、生效时机照 `effects[].detail`、管理员只有主人改、开关关着不能改。
8. diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

- 约 750 行（skill 和 env 约 160，测试约 150，探针约 290，计划约 150）。
- 群会话多一个飞书 skill：模型多读一份描述，`feishu` 这个名字和用户自己的 skill 重名时，Claude 的白名单带插件前缀（`vonvon:feishu`），Codex 按包路径区分，不互相覆盖；但两边的描述会同时出现在模型面前。
- `VONVON_SCOPE` 只在这一版之后起的会话里有：之前起的、还在复用的会话是空的，skill 写了"空就不能用命令行"，探针里空值 exit 2（`--scope` 的写法不对），不会扩大范围。
- 模型可能仍去试命令行改设置：host 和 Bot 进程两层都拒（D4a、D4b），skill 只是让它不去试、说对的话；最终靠真飞书验收看。
- 私聊那一套这一批不交，设置 skill 的真实效果要等 s54a。

## 实现时和计划不一样的地方

和设计第 9 节不一样的：
- **范围值从 `VONVON_SCOPE` 取，不从 `session_info` 取。** `session_info` 按 s46 4.3 不给 id，Codex 会话也没有这个工具（T3b）；env 里给的就是会话能到的最大范围，Claude 和 Codex 一样能读。
- **`feishu.ts`、`settings.ts` 是新文件**，设计写成"改"，代码里原来只有任务 skill。飞书 skill 加进群那一套，和任务 skill 一起交；设置 skill 只在新的 `dm` 一套里，私聊没有 Agent 会话之前不交（s54a）。
- **设置 skill 不教 `project workspace`**（设计第 9 节写了）：会话里换文件夹一律拒（`library.workspace`、`--folder`，探针核过），教了只会被拒；写进"不在聊天里做的"。
- **群里命令行不教记忆**（设计第 9 节写"任务、记忆和只读查询"）：`vonvon memory` 在会话里到 C5 之前整体拒，记忆照开场的记忆约定（进程内工具）做；C5 合入后补。
- **`group create` 写进设置 skill**：私聊令牌的主人、管理员那一轮能建群（D4a、D4b），群令牌拒（`not-dm`，探针核过）。建出来的群是完全访问，skill 要求加警示。
