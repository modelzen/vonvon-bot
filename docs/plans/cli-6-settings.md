# cli-6-settings 计划：设置补齐——整台设备的设置、设置里的按钮、模型目录（C6）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 5.2 节 `settings.*` 两行、8.2 节 C6 一行和第 13 节 C6 一行；约定照 `docs/plans/cli-1-conventions.md`（C1）；共用改动和落点照 `docs/plans/cli-2-bot.md` 4.6。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2。

## 1. 做什么

用户看得到的变化：
- 网页"设置 → 本机"（决策模型的默认服务、Codex 可执行文件）能用 `vonvon settings get|set --host` 看和改。
- 设置页上那几个按钮——语音"测试 / 重新检测权限"、"管理员"加人减人、"响应成员"加人减人和"允许所有成员"、评论指令"恢复默认 / 自定义"——用 `vonvon settings act …` 做。
- 模型下拉框里的候选用 `vonvon settings models` 列出。
- `vonvon settings get` 的人类输出补上语音、管理员、评论指令、Skill、响应成员。
- `vonvon schedule edit` 能改"每次开新话题 / 跟群的会话方式"。

依赖：C1（已合入）。

## 2. 范围

做：
- `settings get/set --host`，`settings act` 下 5 组子命令，`settings models`，`schedule edit --new-topic|--follow`（4.1 表）。
- 从白名单挪掉 8 个 kind：`settings.read.host`、`settings.save.host`、`settings.act.voice / adminMember / projectMember / projectAudience / commentInstructions`、`settings.models`。
- `settings get` 的人类输出补 4.4 列的几段（JSON 本来就全）。

不做：`settings.chooseExecutable / saveExecutable`（D1 删，选 Codex 可执行文件改成 `settings set --host execution.codexBin=…`）；语音的 `enable / disable` 动作（4.6）；会话里的权限（D4a/D4b）。

## 3. 现在的代码

- `D/cli/commands/settings.ts`：`TABLES` 只有 `agent / project / session` 三种范围（`settings.ts:25`）；`resolveScope()` 按 `--group`、`--session`、默认 Bot 选范围；`parseAssignments()` 把 `section.key=value` 按该段的 zod schema 校验；人类输出有权限档、模型、判断、提示词来源等，没有 `view.voice`、`administrators`、`commentInstructions`、`skills`、`members`。
- `D/cli/index.ts:204-231`：`settings get [section]`、`settings access`、`settings set <section.key=value...>`，选项 `--bot / --group / --session / --revision / --reason / --json`。
- `P/settings.ts`：
  - `host` 范围的可改段 `execution{codexBin}`、`judge{defaultProvider?, byProvider}`（`hostSectionSchemas`），视图另有只读的 `runtime{codexBin, fallbackCwd, platform}`。
  - `act` 动作：`voice{action: enable|test|disable|refreshPermission}`、`adminMember{openId, membership: present|absent, revision}`、`projectMember{projectName, openId, membership, revision}`、`projectAudience{projectName, audience:'all', revision}`、`commentInstructions{revision, content: default | custom{text ≤ 30000}}`。结果 `saved{view, effects, warnings} / conflict{view} / rejected{fields} / unavailable{reason}`。
  - `models{query{botId, backend, purpose: project|session|comments|titles|judge, threadId?}}` → `models{catalog}`。
- `revision` 都在视图里：管理员 `view.administrators.revision`，评论指令 `view.commentInstructions.revision`，响应成员 `view.members.revision`（项目视图）。
- 网页：`U/settings/SettingsPanel.tsx` 的"语音转文字"（只发 `test` 和 `refreshPermission`，开关是 `presentation.voiceEnabled` 字段）、"管理员"、"响应成员"（"允许所有成员"发 `projectAudience`）。
- `D/cli/commands/schedule.ts`：`add` 有 `--new-topic`（`placement:{kind:'newTopic'}`），`edit` 的 `patch` 里没有 `placement`。

## 4. 怎么改

### 4.1 命令

| 命令 | RPC | `covers` | `--json` 成功 |
|---|---|---|---|
| `settings get [section] --host` | `settings.read{scope:{kind:'host'}}` | 加 `settings.read.host` | `{ok, view}`（同其他范围） |
| `settings set <section.key=value…> --host [--revision] [--reason]` | `settings.save{edit:{scope:{kind:'host'}, …}}` | 加 `settings.save.host` | 同其他范围 |
| `settings act voice test\|refresh [--bot]` | `settings.act{voice{action:'test'\|'refreshPermission'}}` | `settings.act.voice` | `{ok, result:'saved', warnings, voice}` |
| `settings act admin add\|remove <openId> [--bot]` | `settings.read`（拿 revision）、`settings.act{adminMember}` | `settings.act.adminMember` | `{ok, result:'saved', administrators}` |
| `settings act member add\|remove <openId> --group <g> [--bot]` | `settings.read`、`settings.act{projectMember}` | `settings.act.projectMember` | `{ok, result:'saved', members}` |
| `settings act member all --group <g> [--bot]` | `settings.read`、`settings.act{projectAudience}` | `settings.act.projectAudience` | `{ok, result:'saved', members}` |
| `settings act comment-instructions (--default\|--text <t>\|--stdin) [--bot]` | `settings.read`、`settings.act{commentInstructions}` | `settings.act.commentInstructions` | `{ok, result:'saved', commentInstructions}` |
| `settings models --backend <b> --purpose <p> [--session <t>] [--bot]` | `settings.models` | `settings.models` | `{ok, catalog}` |
| `schedule edit <taskId> … [--new-topic\|--follow]`（改） | 同今天，`patch.placement` | 同今天 | 同今天 |

`--host` 和 `--bot / --group / --session` 互斥（2）。`settings act` 的几组都接 `--revision <r>`（可选，4.2）。

失败：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错；`--host` 和别的范围一起给；`--default / --text / --stdin` 不是正好一个；`--new-topic --follow` 同给；`--stdin` 读到空 | 2 | — |
| 结果 `rejected` | 2 | `rejected`，`partial: {fields}` |
| 连不上 | 3 | — |
| 结果 `unavailable`（只读：`preview`、`owner-offline`、`unsupported-host`、`stale`，文字用 `access.message`） | 4 | `access.reason` |
| 结果 `conflict` | 5 | `conflict`，`current` 是最新的那一段 |
| 写请求超时、断线 | 6 | — |

### 4.2 各命令的细节

- **`--host`**：`Kind` 加 `'host'`，`TABLES.host = hostSectionSchemas`（可改的两段）。`resolveScope()` 遇到 `--host` 直接回 `{scope:{kind:'host'}}`，不读快照、不要 Bot（没有 Bot 时也能改）。人类输出：`本机设置`，然后 `execution.codexBin`（不写 = 自动找）、`judge` 默认服务和每家的模型、只读的 `runtime`（实际用的 Codex、找不到文件夹时的默认目录、平台）。`settings set --host execution.codexBin=null` 回到自动找。
- **`settings act` 的 revision**：不给 `--revision` 就先读一次这一范围的视图，取对应段的 `revision` 紧接着发（同 C3 `group set` 的做法）；给了原样带上。
- **`voice`**：`test` 测一次识别（网页"测试"），`refresh` 发 `refreshPermission`（网页"重新检测"）。人类输出：`语音转文字：开 / 关`，`飞书语音权限：<view.voice.feishu.message>`，`result` 非空时再打一行。需要去飞书开权限时（`grantUrl` 非空）打"开权限：<grantUrl>"。
- **`admin add|remove`**：`openId` 校验 `openIdSchema`（`ou_` 开头），不对 → 2。已经在 / 已经不在也照样发（daemon 幂等）。人类输出管理员名单（主人、飞书管理员、扫码的人分开标）。
- **`member add|remove|all`**：`--group` 必填。`all` 只在名单非空时有意义（网页按钮只在名单非空时出现）：名单已空 → 退出 0，"已经是所有成员都能用"，不发请求。人类输出：`响应成员：所有成员` 或名单。
- **`comment-instructions`**：`--default` 发 `{kind:'default'}`；`--text` 发 `custom`；`--stdin` 读完整个 stdin（去掉末尾一个换行），给长文本和 AI 用。超过 `view.commentInstructions.maxEditLength` → 2，不发。
- **`settings models`**：`--backend` 是 `codex-appserver`、`claude-agent` 这样的 id，也接 `codex`、`claude`（映射到前两者，和 `--tool` 一致）。`--purpose session` 时要 `--session`。人类输出每行一个模型 `id  名字`，`state` 是 `fallback` 时首行写"daemon 没拿到最新目录，这是内置的"，`unavailable` → 4 `models_unavailable`。
- **`schedule edit --new-topic|--follow`**：`patch.placement = {kind:'newTopic'}` 或 `{kind:'follow'}`；"没有要改的"那句检查把 placement 也算进去，提示里加上这两个选项。

### 4.3 交互和非交互

只有 `comment-instructions --stdin` 读 stdin，读的是管道，不提问；stdin 是 TTY 而给了 `--stdin` → 2"--stdin 要从管道读，例如 cat 说明.md | vonvon settings act comment-instructions --stdin"。其余不读 stdin。

### 4.4 `settings get` 补的人类输出

Bot 范围（`agent` 视图）在现有各段后面加：
- `语音转文字：开（飞书语音权限：…）`；
- `管理员：ou_…（主人）、ou_…（飞书管理员）…`，`管理员改动：vonvon settings act admin add|remove <openId>`；
- `评论指令：默认` 或 `评论指令：自定义「前 40 个字…」`；
- `Skill：N 个（停用 M 个）`，每个一行 `名字  来源  已停用`；`skillsError` 有值时打它。

群范围（`project` 视图）加：`响应成员：所有成员` 或 `响应成员：ou_…、ou_…`。只改人类输出，`--json` 不变。

### 4.5 权限表（5.2）

不加新 kind。会话里的结果按 5.2 已有的行（D4a/D4b 判）：`settings.read.host`、`settings.save.host` → bot-session 的 `host` 段 ✗；`settings.act.adminMember` ★ 且要主人那一轮；`projectMember`、`projectAudience` ★ 过 `authorizeNow`；`voice`、`commentInstructions` 在 `settings.save / act` 一行，★；群令牌、评论令牌的 `act` 一律 ✗ `not-dm`；`settings.models` 在 `settings.read / sessions / models` 一行。

### 4.6 和总设计不一样的地方

- **不做语音的 `enable / disable` 动作**：网页不发它们，语音的开关是 `presentation.voiceEnabled` 字段，`settings set presentation.voiceEnabled=true` 已经能改；两条路改同一件事会让 AI 不知道用哪个。`settings.act.voice` 被 `test / refresh` 覆盖，对齐测试照过。
- **8.2 写的 `fallbackCwd` 不能改**：它在 `hostView.runtime` 里，是只读的推出值，`settings get --host` 显示它，不能 `set`。
- **`member all` 名单已空时不发请求**：和网页按钮的显示条件一致。

## 5. 测试

`T/cli-admin.test.ts` 里 settings 的用例不动，新文件 `T/cli-settings-act.test.ts`、`T/cli-settings-host.test.ts`，`T/schedule-cli.test.ts` 加用例：
- `settings get --host --json`：发 `read{scope:{kind:'host'}}`，不读快照；没有 Bot 时也成功（main 必败）。
- `settings set --host execution.codexBin=/usr/local/bin/codex`：发 `save{edit:{scope:{kind:'host'}, section:'execution', patch:{codexBin:'/usr/local/bin/codex'}}}`；`judge.defaultProvider=nope` → bad-args（schema 不认）（main 必败）。
- `--host --group 研发` → bad-args（main 必败）。
- `settings act voice refresh`：发 `act{voice{action:'refreshPermission'}}`；结果 `unavailable{reason:{kind:'readonly', reason:'owner-offline', message:'…'}}` → refused、`reason:'owner-offline'`、文字是那句 `message`（main 必败）。
- `settings act admin add ou_x`：先 `read`（`administrators.revision:'a1'`）再 `act{adminMember{openId:'ou_x', membership:'present', revision:'a1'}}`；`--revision a0` 时不读；结果 `conflict` → conflict、`current` 是 `administrators`；`admin add 123` → bad-args（main 必败）。
- `settings act member all --group 研发`：名单空 → 退出 0、没发 `act`；名单非空 → `projectAudience{audience:'all', revision}`（main 必败）。
- `settings act comment-instructions --stdin`（stdin 注入"写短一点\n"）→ `custom{text:'写短一点'}`；`--default --text x` → bad-args；超长 → bad-args、没发（main 必败）。
- 结果 `rejected{fields:[{field:'text', message:'…'}]}` → bad-args、`partial.fields`（main 必败）。
- `settings models --backend codex --purpose project`：`query.backend === 'codex-appserver'`；`--purpose session` 不带 `--session` → bad-args（main 必败）。
- `settings get`（Bot 范围）的人类输出含"语音转文字""管理员""评论指令""Skill"；群范围含"响应成员"（main 必败）。
- `schedule edit t1 --revision 3 --follow`：`patch:{placement:{kind:'follow'}}`；只给 `--new-topic` 也不再报"没有要改的"；`--new-topic --follow` → bad-args（main 必败）。
- `T/cli-json.test.ts` 加样本（三层命令 `settings act voice test` 等）；`T/cli-parity.test.ts`：8 个 kind 不在白名单。

## 6. 自测和验收

**Linux（JP-VPS）**：daemon 的 typecheck、lint、build；上面的测试文件和 `T/cli-admin.test.ts`、`T/s47-cli.test.ts`。

**集成分支验收时，主会话在验收 daemon 上做**（拿目录锁、核对 sha、用完放锁）：
1. `vonvon settings get --host` 和网页"本机"设置一致；`settings set --host judge.defaultProvider=<当前值>`（原值写回，不改行为）回 `saved`。
2. `vonvon settings act voice refresh --bot <Bot 6>`，网页语音那一行的检测时间更新。
3. `vonvon settings act member add <测试账号 openId> --group <测试群>`，网页"响应成员"多一个；`remove` 回去（devices.md C6 验收一行"改完网页立刻看到"）。
4. `vonvon settings act comment-instructions --text 验收用`，网页评论指令变了；`--default` 恢复。
5. `vonvon settings models --backend codex --purpose project --bot <Bot 6>` 和网页模型下拉一致。
6. `vonvon schedule edit <测试任务> --revision <r> --new-topic`，`schedule list --json` 里 `placement` 变了；改回 `--follow`。
管理员名单不在验收里改（会影响 Bot 6 认谁是管理员）。

**Mac、Windows**：不需要。`execution.codexBin` 的 Windows 路径由 daemon 判，CLI 只转发。

## 7. 文档

- `docs/product.md`：本片不改（D0 统一写）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. `--host` 读写不需要 Bot、不读快照；和其他范围互斥。
2. 每个 `settings act` 结果都映射到 4.1 的退出码；`conflict` 带最新那一段。
3. 没给 `--revision` 时先读后写，给了不读。
4. `settings get` 的人类输出有 4.4 的几段，`--json` 不变。
5. `schedule edit` 能改 placement。
6. 白名单里没有本片的 8 个 kind。
7. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,000 行：`settings.ts` +330（`--host`、`act`、`models`、人类输出），`index.ts` +80，`schedule.ts` +15，白名单 −8，测试约 560。
- 管理员和响应成员是真权限：验收只动测试账号，做完还原。
- 人类输出加长：`settings get` 已经很长，新段落放最后，不打乱现有顺序（已有测试按行断言的不受影响）。

## 和计划不一样的地方

- **`Skill` 那段放在群范围**：`skills`、`skillsError` 只在群视图里（`projectViewSchema`，技能按群的目录和后端找），Bot 视图没有。所以 Bot 范围加语音、管理员、评论指令三段，群范围加响应成员和 Skill 两段。
- **`settings act` 的子命令是三层**：`voice <test|refresh>`、`admin <add|remove> <openId>`、`member <add|remove|all> [openId]`、`comment-instructions`，`add`、`test` 这些是参数，不是第四层命令；`member` 一条命令同时 `covers` `projectMember` 和 `projectAudience`。`voice` 没有 revision，不接 `--revision`。
- **`act` 的 `--json` 都带 `warnings`**：计划只给 `voice` 写了；评论指令同步失败的提示就在 `warnings` 里，其余几个也带上，形状一样。
- **`member all` 名单已空时 `--json` 是 `{ok:true, result:'unchanged', warnings:[], members}`**，和真改了的 `saved` 分开。给了 `--revision` 时照 4.2 不读，直接发。
- **`settings set` 的失败对所有范围都带 `reason`**：`rejected` 带 `reason:'rejected'` 和 `partial.fields`，`unavailable` 带 `access.reason`（以前只有文字），和 `settings act` 共用一个函数。
- **`settings access` 也接 `--host`**：`--host` 加在三条命令共用的选项上，`access --host` 列出本机两节能不能改。
- **共用改动照 `cli-2-bot` 4.6 照抄了两处**：`preAction` 的 `LEASED` 名单（`settings act voice` 的上一级是 `act`，旧写法会让它拿数据租约）和 `T/cli-json.test.ts` 按叶子路径核对样本。4.6 第 3 条（对齐测试的反例）本片用不到，没动。
- **"8 个 kind 不在白名单"的断言写在 `T/cli-settings-act.test.ts`**，不在 `T/cli-parity.test.ts`，免得和别的片在同一处加用例时冲突；`T/cli-parity.test.ts` 原有的总检查照样管着它们。
