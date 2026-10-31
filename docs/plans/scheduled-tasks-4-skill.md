# T4a：内置能力包生成器和任务 skill 的文本

## 1. 做什么

一个内置能力包生成器（稳定目录、插件形状、永不删）和第一份内置 skill"任务"的文本：教 agent 什么时候建任务、`when` 怎么写、怎么算时间、无人回合的规矩、不用两家自带的定时。本片只生成文件，不交给两家（T4b）；用户看不到变化。s48 飞书 skill、s54a 设置 skill 以后复用生成器。总设计第 11、16 节；产品行为 3.6、3.13。基线 T1a 合入后的 `dev`（只依赖 T1a 的类型；和 T1b 并行），分支 `codex/scheduled-tasks-4-skill`。

## 2. 范围

- 新文件：`D/agent/builtin-skills/{package,registry,scheduled-tasks}.ts`。
- 改：`D/config/paths.ts`（`botPaths(appId).capabilities`）。
- 可以假设：T1a 的类型。T3 的工具名按总设计第 10 节写进文本（T3 不改名）。
- 不做：两家交付、读入口、`session-profile` 的改动（T4b）；s39d 的用户能力包；s48、s54a 的内容；桌面端显示内置 skill。

## 3. 现在的代码

- `packages/daemon/src` 里**没有**任何 `plugins`、`enabledPlugins`、`skipMcpDiscovery`、`selectedCapabilityRoots`、`skillOverrides` 的用法；两家 backend 的 `profileCapabilities.capabilityPackages` 都是 `false`（`claude-agent/backend.ts:334`、`codex-appserver/backend.ts:760`）；`session-profile.ts:31` 收到能力包就抛"额外根、能力包和 MCP profile 交付尚未支持（s39）"；`docs/v1-plan.md` 的 s39d（1296）、s44a（1420）都是 `[ ]`。交付在 T4b。
- `D/config/paths.ts` 的 `botPaths(appId)` 是 `bots/<appId>/` 下文件和目录的显式清单；3.6 说能力包放会话写不到的地方。
- 原子写：`D/server/atomic-file.ts`（T1a 加了 `durable`，这里不需要）。
- 实测事实（`docs/research/2026-10-30-scheduled-tasks/notes-skill.md`，随总设计 PR 提交）：Codex 的能力根要插件形状（`skills/<name>/SKILL.md`），发现过程在沙箱内跑，只读、读写档要给包目录读权限；Codex 的 rollout 记起线程时的能力根路径，resume 不重读；Claude 的本地插件 `vonvon@inline` 能装、白名单能控；两家都按 frontmatter 的 `description` 决定要不要加载正文。

## 4. 怎么改

### 4.1 生成器：`package.ts`

```ts
export interface BuiltinSkill { name: string; title: string; description: string; body: string }
export async function ensureBuiltinPackage(appId: string, set: 'group' | 'dm', skills: BuiltinSkill[]): Promise<{ path: string; changed: boolean }>;
```

- 目录 `bots/<appId>/capabilities/builtin/<set>/`，`set` 是稳定名（今天只有 `group`；s54a 加 `dm`）。**不用内容哈希、不删旧目录**：Codex resume 用的是起线程时记下的路径。
- 写 `.claude-plugin/plugin.json`（`name: 'vonvon'`，`version` 取内容哈希前 12 位，只是信息）和 `skills/<name>/SKILL.md`（frontmatter `name`、`description`，正文 `body`）。内容没变不重写（先读再比）；变了原地整文件 rename 覆盖。多出来的旧 skill 文件（名单里没有的）删掉，目录留着。目录 `0o700`、文件 `0o644`，不给会话可写（会话的沙箱策略不含这个目录的写）。
- 写失败抛错，调用方（T4b）记诊断、不带 skill 起会话，不让会话起不来。
- `registry.ts`：`builtinSkillsOfSet(set: 'group'): BuiltinSkill[]`，今天 `group` 只有 `[scheduledTasksSkill]`，包内名单只由 set 决定；T4b 按 `profile.tools.schedule` 决定挂不挂包。

### 4.2 skill：`scheduled-tasks.ts`

导出 `{ name: 'scheduled-tasks', title: '任务', description, body }`。description 逐字按总设计第 11 节那一行。正文中文、≤140 行，八段，每段必须含下面的句子（测试按这些句子断言）：

1. **什么时候用**："用户说定时、每天、每周、提醒、稍后、过一会，就用这里的工具。""你自己要过一会再看（比如等一个构建、等一个回复），也用 `schedule_create` 给自己排一个一次性任务，不要在这一轮里等。"
2. **时间换算**："先调 `schedule_list`，回复第一行是现在的时间和时区，按它算。""一次性的用 `when: { kind: 'once', at: 'YYYY-MM-DD HH:mm' }` 或 `inMinutes`；不要自己算毫秒。""用户说的时区和这里不一样，填 `timeZone`。""'工作日'是 `weekly` 的 `days: [1,2,3,4,5]`；'每半小时'是 `every` 30。"
3. **怎么写 `when`**：五种各一个例子（`once`、`every`、`daily`、`weekly`、`cron`），cron 只在用户自己给了表达式时用。
4. **怎么调**："先 `schedule_list` 看有没有重名或重复的任务。""建完在回复里说名字、时间和下一次运行时间。""改和删要带 `revision`，从 `schedule_list` 里取。""发到哪：默认跟群走；用户说'开个话题发'填 `where: 'newTopic'`，说'就在这个话题里发'填 `where: 'thisTopic'`。"
5. **谁能改**："成员只能改自己建的；被拒了就把拒绝原因告诉用户，不要绕。"
6. **在定时回合里**："没有人在场：不要提问，不要等人确认；能定的自己定，做不了的写出来。""要再来一次，用 `schedule_edit` 改自己这个任务的时间；不能建新任务，不能改设置。"
7. **不用两家自带的定时**："不要用 Claude Code 的 CronCreate、ScheduleWakeup，也不要用 Codex 的自动化；这里关着，用了也不会跑。"
8. **任务内容写给未来的自己看**："写清目标、输出形式、发到哪里，像给同事留便签。"

### 4.3 路径

`paths.ts`：`botPaths(appId)` 加 `capabilities: join(dir, 'capabilities')` 和 `builtinPackage(set)`。

## 5. 测试

main 必败：生成器和 skill 在基线不存在。

- `builtin-package.test.ts`（真实临时目录）：生成 → `plugin.json` 的 `name: 'vonvon'`，`skills/scheduled-tasks/SKILL.md` 的 frontmatter 有 `name`、`description`（一行、≤200 字）；再生成同内容 → `changed: false`、mtime 不变；改 body → `changed: true`、同一路径、文件内容更新、目录还在；名单去掉一个 skill → 那个 `SKILL.md` 被删、目录在；权限位 `0o700`/`0o644`；目录只读时抛错。
- `builtin-skill-text.test.ts`：正文含 4.2 八段里的每个引号句子；不含真实 id、群名、密钥；行数 ≤140；description 逐字等于总设计第 11 节。
- 回归定向：paths。

## 6. Codex 的自测

JP-VPS，离线隔离，不发飞书消息，不调真实 provider，不用 Bot 6/7/8 和 `accept-home2`，不拿共享验收锁。

- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
- 重命令加 `flock /tmp/vonvon-heavy.lock`。跑第 5 节两个测试和 typecheck、lint。

## 7. 文档

- `docs/v1-plan.md`：T4a 行的做法和实际行数；s48、s54a 的内容栏加一句"用 T4a 的生成器"。
- 3.6 已改成三个内置 skill；本片对不上的在 PR 写明。

## 8. 验收要点

- 目录名固定、不删目录；内容变了原地更新；有测试。
- `BuiltinSkill` 是数据，生成器不含和任务有关的分支，s48、s54a 能直接复用。
- skill 正文含八段的关键句；description 一行；没有真实 id、群名、密钥。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

风险：错误路径（写失败要抛给调用方）。预计生产约 260 行（package 120、skill 文本 130、paths 10）、测试约 300 行、文档约 40 行，总计约 600。自审不代替独立审查；不冻结、不合入。
