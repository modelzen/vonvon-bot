# T4b：内置能力包交给两家

## 1. 做什么

把 T4a 生成的内置能力包原生交给 Codex 和 Claude：最小的能力包交付（今天两家都是 `capabilityPackages: false`）、只读和读写档的读入口、版本矩阵、仓库能不能关掉插件的实测、核验。做完这一片，有任务工具的群会话里两家都有"任务"skill，常驻一行、用时加载。总设计第 11 节；产品行为 3.6、3.13、第 9 节第 21、22 项。基线 T3、T3b 和 T4a 合入后的 `dev`，分支 `codex/scheduled-tasks-4b-delivery`。

## 2. 范围

- 改：`D/agent/session-profile.ts`（`capabilityPackages` 的能力位和元素形状）、`D/agent/claude-agent/{backend,thread}.ts`（`plugins`、`enabledPlugins`、skills 白名单）、`D/agent/group-skills.ts`、`D/agent/codex-appserver/{backend,workspace-policy}.ts`（`selectedCapabilityRoots`、读入口）、`D/bot/handle-message.ts:1120`（`profileOf` 组 profile 时调 `ensureBuiltinPackage` 并填 `capabilityPackages`）。
- 可以假设：T3 的 `profile.tools.schedule` 和工具名、T3b 的 Codex dynamicTools（Codex 会话有任务工具）；T4a 的生成器和 skill。
- 不做：s39d 的用户能力包（skill 和 MCP）；`mcpServers` 的交付（`resolveSessionProfile` 对它照旧抛）；s48、s54a 的内容。
- 和 s39d 的关系：两个根（Claude 定，总设计 15 第 12 条）。s39d 到时加 `kind: 'user'` 的第二项，Codex 的 `selectedCapabilityRoots` 和 Claude 的 `plugins` 都是数组，放得下。

## 3. 现在的代码

- `session-profile.ts:12` `capabilityPackages: readonly { path: string }[]`；`:22` `SessionProfileCapabilities.capabilityPackages: false`；`:31` `resolveSessionProfile` 对非空 `capabilityPackages` 抛错。`config/execution.ts:252` 和 `handle-message.ts:1120` 传的都是 `[]`。
- Claude：`claude-agent/backend.ts:334` `capabilityPackages: false`；`thread.ts:345-371` 组 `Options`，今天没有 `plugins`；`skills` 白名单在 `backend.ts` 两处（`profile.skills.enabledNames`）和 `group-skills.ts:92-99`。SDK 0.3.296 的 `sdk.d.ts`：`Options.plugins?: SdkPluginConfig[]`（`{ type: 'local'; path; skipMcpDiscovery?: boolean }`，5650-5664）、`settings.enabledPlugins`（7436）、`settings.skillOverrides`（7008）。
- Codex：`codex-appserver/backend.ts:760` `capabilityPackages: false`；`codexSessionParams`（78-104）今天没有 `selectedCapabilityRoots`；`workspace-policy.ts:119、135` 按路径给读写权限；`listSkills`（766）走 `skills/list`，实测列不出能力根里的 skill。生成类型里 `selectedCapabilityRoots` 的形状：`[{ id, location: { type: 'environment', environmentId: 'local', path } }]`。
- `CODEX_MIN_VERSION = '0.156.1'`（`codex-appserver/version.ts:8`）。product.md 第 9 节第 21 项：0.163.0 上 `selectedCapabilityRoots` 实测能用，0.156.1 没跑过；第 22 项：仓库的 `.claude/settings.json` 写 `enabledPlugins` 能不能关掉 vonvon 的插件，没实测。

## 4. 怎么改

### 4.1 profile

- `SessionProfile.capabilityPackages: readonly { path: string; kind: 'builtin' }[]`；`SessionProfileCapabilities.capabilityPackages: boolean`；两家置 `true`；`resolveSessionProfile` 在 `capabilities.capabilityPackages` 为真时放行，否则照旧抛；`mcpServers` 照旧抛。
- `handle-message.ts:1114` 的 `profileOf`：`profile.tools.schedule`（T3 在同一个函数里算好，和带不带任务工具是同一个开关）为真时 `await ensureBuiltinPackage(appId, 'group', builtinSkillsOfSet('group'))`，成功就 `capabilityPackages: [{ path, kind: 'builtin' }]`；抛错记诊断 `builtin-package-failed`，`capabilityPackages: []`，会话照常起。

### 4.2 Claude

- `thread.ts` 组 `Options`：有包就 `plugins: packages.map(p => ({ type: 'local', path: p.path, skipMcpDiscovery: true }))`；`settings.enabledPlugins['vonvon@inline'] = true`（写在 `AUTO_COMPACT_SETTINGS` 之上的合并里，plan 变体同）；skills 白名单（`enabledNames` 在时）加 `vonvon:scheduled-tasks`。
- 第 9 节第 22 项实测：在工作区放 `.claude/settings.json` 写 `{ "enabledPlugins": { "vonvon@inline": false } }`，起一条会话看 skill 还在不在。在就记"仓库关不掉"，第 22 项改成已测；不在就看 `settings` 里的 `enabledPlugins: true` 能不能压过（SDK 文档说 `--settings` 的优先级高于项目），能压就这样做，不能就写进 3.6"留下的风险"，PR 里写明。

### 4.3 Codex

- `codexSessionParams`：有包就 `selectedCapabilityRoots: packages.map(p => ({ id: 'vonvon-builtin', location: { type: 'environment', environmentId: 'local', path: p.path } }))`，thread/start 和 resume 都带（resume 带了也不生效，但不害）。
- `workspace-policy.ts`：只读、读写档给 `[path]: 'read'`；完全访问档不加。
- 版本矩阵：JP-VPS 装着的 Codex 版本和 `CODEX_MIN_VERSION` 0.156.1 各跑一次自测第 2 步（用 `npx @openai/codex@0.156.1` 或锁定目录的二进制，照 `codex-runtime-refresh.md` 的做法）。0.156.1 不行：抬 `CODEX_MIN_VERSION` 到能用的最低版本，PR 里写明，改 product.md 第 9 节第 21 项。

### 4.4 核验

`skills/list` 列不出，所以不用它。Claude 用 SDK 会话启动回包里的 skill 列表（`plugins_applied` 和 skill 名单）；Codex 用一条真实回合问"你有哪些 skill"，答案里有"任务"记通过，没有报错不开会话（3.6"实验字段的风险"）。核验只在 CI 外的自测里跑；代码里只核能核的（Claude 回包、Codex 包目录存在且可读）。

## 5. 测试

main 必败：`capabilityPackages` 在基线是 `false` 且 `resolveSessionProfile` 抛错；`plugins`、`selectedCapabilityRoots` 在基线不出现。

- `session-profile-packages.test.ts`：`capabilities.capabilityPackages: true` 时 `[{ path, kind: 'builtin' }]` 原样通过；`false` 时抛原来的错；`mcpServers` 非空照旧抛。
- `claude-builtin-skill.test.ts`（锁定 SDK 的假传输）：`profile.tools.schedule` 为真 → `Options.plugins` 一项 `{ type: 'local', path, skipMcpDiscovery: true }`、`settings.enabledPlugins['vonvon@inline'] === true`、白名单含 `vonvon:scheduled-tasks`，三档都一样；为假 → 三样都没有；`AUTO_COMPACT_SETTINGS` 的别的键还在。
- `codex-builtin-skill.test.ts`（假 app-server）：为真 → `selectedCapabilityRoots` 一项、只读和读写档 policy 含 `[path]: 'read'`、完全访问档不含；为假 → 不带、policy 不含。
- `profile-of-builtin.test.ts`：`ensureBuiltinPackage` 抛错 → `capabilityPackages: []`、诊断一条、会话照常起。
- 回归定向：session-profile、workspace-policy、group-skills、claude backend、codex backend、handle-message 的 profile 测试。

## 6. Codex 的自测

JP-VPS，真 Claude 和真 Codex 各一遍，用验收 daemon（Bot 6；环境见 #422 正文第 4 节）。用哪家是群绑定时定的（`vonvon group bind --tool claude|codex`），不是 bot 的设置：从 `test-chats.json` 的登记和 `projects.json` 的当前绑定里挑 Bot 6 绑在 Claude 上的测试群和绑在 Codex 上的测试群，单会话和多会话各要一个（chat id 不打印）；缺哪种就按 #422 正文第 4 节新建测试群、用 `--tool` 绑好并补登记。锁、删除规矩和 lark-cli 用法照 T2 第 6 节抄：

- 先拿目录锁：`mkdir /tmp/accept-user.d`，失败就等；拿到后 `echo "<任务号> $(date -u +%FT%TZ)" > /tmp/accept-user.d/owner`；用完 `rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 发消息用 `say.py`（jojo，`--as user`），读用 `lark-cli im +messages-list --as user --chat-id <登记的 chatId>`。
- 步骤：
  1. 群里问"@Bot 6 你有哪些 skill"：两家都说有"任务"。
  2. 说"@Bot 6 每周一 10 点提醒我交周报"：bot 不先问时区、不问要不要开话题，直接建；回复里有"每周一 10:00"和下一次时间。Codex 这一步在 0.156.1 和现装版本各跑一次。
  3. 只读档的群重复第 2 步（Codex）：能读到 skill 正文（让它复述正文里"像给同事留便签"这句）。
  4. 私聊和评论会话不装：私聊今天不起 agent 会话（T3 4.5），没有真飞书步骤可做；由 T3 的 `schedule-profile.test.ts` 和本片的交付单测证明 `profile.tools.schedule` 为假时 `capabilityPackages` 是 `[]`。私聊起 agent 会话以后的真机复查留给 s54a。
  5. 第 9 节第 22 项：按 4.2 放 `.claude/settings.json` 再问第 1 步，结果写 PR。
  6. Mac 的 Seatbelt 下 Codex 能力根的读入口：JP-VPS 测不了，PR 里记"待 owner 验收"，给 owner 的步骤是第 3 步。
  7. 换回 `dev`，放锁。

## 7. 文档

- `docs/v1-plan.md`：T4b 行的做法和实际行数；s39d 行加一句"内置包的最小交付已由 T4b 做，s39d 只剩用户包和 MCP"。
- product.md 第 9 节第 21、22 项按实测结果改成已测。

## 8. 验收要点

- skill 只在 `profile.tools.schedule` 为真的会话里装：绑定的群有，私聊和评论会话没有。
- 两家都是原生交付；Codex 不靠 `skills/list` 核验，代码里不假装核验通过。
- 包目录会话写不到；只读、读写档给读入口，完全访问档不加。
- 0.156.1 和现装版本都过，或者 `CODEX_MIN_VERSION` 抬了并写明。
- 第 22 项有结论。
- 包生成失败不影响会话启动，有测试。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：错误路径（包目录写失败时会话照起）；macOS 原生（Seatbelt 下的读入口没在 JP-VPS 测过）；版本（0.156.1 可能不支持 `selectedCapabilityRoots`）。预计生产约 380 行（profile 60、Claude 100、Codex 140、profileOf 和诊断 80）、测试约 460 行、文档约 60 行，总计约 900。自审不代替独立审查；不冻结、不合入。
