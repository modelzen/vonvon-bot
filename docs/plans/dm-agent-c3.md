# dm-agent-c3 计划：3 个内置 Skill 和 `vonvon` 启动器

设计在 `dm-agent.md` 第 1、6.2、6.3、7、8、9 节，产品行为在 `docs/product.md` 3.6、3.7、3.13 和第 4 节。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

管理员私聊 Bot 时，Agent 知道怎么用 `vonvon` 看和改这台电脑的配置，飞书读取工具怎么用，私聊的定时任务怎么算。`vonvon` 不再靠 shell 的启动文件才找得到。依赖 C1、C2、F1 到 F7（都在集成分支上）。文字里提到 D4 的 `--dm` 和 F2 的跨 Bot 参数，这两片合入后再对一次。

## 2. 范围

做：第 9 节全部；`vonvon-schedule` 在私聊里的文字；任务工具描述和两句拒绝在私聊里说得对；私聊不写 `--bot` 时目标是这个 Bot；对齐 `docs/`。

不做：F2 的命令；D4 的页面和 `--dm`；Skill 里写判断策略或风险提示；只读和读写档的会话读到 `<data>/bin`（群用不上命令行，第 9 节）。

## 3. 现在的代码

- `D/agent/builtin-skills/`：`registry.ts` 两组返回一样的两个；`feishu-message.ts`；`schedule.ts` 只写了群。`package.ts` 的 `writeBuiltinPackage` 按 `set` 分目录，多余的 `SKILL.md` 删掉，目录留着。
- `D/agent/claude-agent/thread.ts`：`BUILTIN_SKILL_NAMES` 只取 `group`。
- `D/bot/handle-message.ts`：`createWithPermission` 是开和恢复会话的唯一入口，`withSessionEnv` 把令牌放进 `profile.env`。没有 `host` 时不动 profile。
- `D/agent/codex-appserver/backend.ts`：`shell_environment_policy: { set: profile.env }`，开和恢复同一份参数。`D/agent/claude-agent/backend.ts`：`sessionClaudeEnv` 把 `profile.env` 盖在 `process.env` 上。
- `D/cli/daemon-client.ts`：`pickBot` 多个 Bot 又没给 `--bot` 时报错。私聊的快照有所有 Bot，所以"默认是这个 Bot"今天不成立。
- `D/core/self-entry.ts`：`selfEntry()`。`packages/desktop/src/cli-registration.ts`：桌面版注册，这一片不动。
- `D/admin/schedule-commands.ts`、`D/cli/commands/schedule.ts`、`D/bot/schedule/scheduler.ts`、`D/agent/entry/schedule-tools.ts`：写死的"本群"。

## 4. 怎么改

**Skill。** `feishu-message.ts` 改名 `feishu.ts`，`feishuSkill`（群）和 `dmFeishuSkill`；`schedule.ts` 加 `dmScheduleSkill`，公共的段落抽成常量，群的正文一个字不变；新 `config.ts` 的 `configSkill`。`registry.ts`：

```ts
case 'group': return [scheduleSkill, feishuSkill];
case 'dm': return [dmScheduleSkill, dmFeishuSkill, configSkill];
```

`builtinSkillNames()` 取两组的并集，一个名字一次，`thread.ts` 用它。Claude 的白名单只是过滤，包里没有的名字不匹配，不报错（SDK `skills` 的说明）。老的 `vonvon-feishu-message`：`writeBuiltinPackage` 下次开会话时删掉它的 `SKILL.md`，读旧线程的 Codex 看到同一个根。

**启动器。** 新文件 `D/agent/session-cli.ts`：

```ts
launcherFiles(runtime, platform): LauncherFile[]            // 内容，纯函数
writeSessionCli(runtime?, directory?, platform?): Promise<string | undefined>   // 不抛错
sessionCliEnv(cli, env?, platform?): Record<string, string> // PATH 和 VONVON_CLI
```

- `bridge.ts` 在建 orchestrator 之前 `await writeSessionCli()`，路径传进 `createOrchestrator` 的 `sessionCli`。
- `createWithPermission` 把 `sessionCliEnv(sessionCli)` 和令牌一起放进 `withSessionEnv`。`PATH` 在开会话时读，因为 `profile.env` 会盖掉 `process.env` 的。
- 写法：内容没变就只补权限；变了写临时文件再 `rename`，几个 Bot 同时起来也是整份；`rename` 输给同样的内容不算失败（Windows 上目标被占用时会报错）。
- 写失败：记 `session-cli-failed`，返回 `undefined`，这个 Bot 的会话不设这两个变量。旧的启动器不用，它可能指向已经删掉的版本。
- sh：单引号，`'` 转义。Electron 时先 `export ELECTRON_RUN_AS_NODE`。
- Windows `.cmd`：路径用双引号，`%` 写成 `%%`。cmd 按控制台代码页读批处理，路径里有中文（用户目录常有）会乱码，所以读那一行时切到 65001，跑完切回来，退出码留着。旁边再放 sh 的 `vonvon`：Claude 在 Windows 上的 Bash 是 Git Bash，不认 `.cmd`。`VONVON_CLI` 指 `.cmd`。
- `PATH` 去掉已有的同一目录。Windows 上用进程里的写法（`Path`），否则 Codex 那边的环境里可能有两份。

**默认目标。** `SESSION_BOT_ENV = 'VONVON_BOT'`，只有私聊会话带，`pickBot` 没给 `--bot`、多个 Bot 时用它；在 `withoutSessionMarkers` 里去掉。群和评论的快照只有自己，不用它。

**任务的文字。** `not-found`：`createScheduleCommands` 按 `deps.chatOf` 说"这个私聊"或"本群"，工具那一处按 `actor.kind`，命令行写"这里"。`tier-unavailable` 写"权限档现在用不了"。工具描述改成"本群或这个私聊"，`where` 写"私聊里不用写"。

**出错和停机。** 启动器只在启动时写一次，不进关机流程。

## 5. 测试

- `T/builtin-skill-text.test.ts`：两组的名字和并集；群的两个 Skill 不教命令行；私聊的 `vonvon-schedule` 不说"不能建新任务"；`vonvon-feishu` 列全 12 个文档工具，`feishu_api` 只在私聊；`vonvon-config` 的能力、6.2 的清单、没有判断和风险的话；文字里的命令、选项和工具名对得上 CLI 和工具表，改名时变红。（main 必败）
- `T/builtin-package.test.ts`：`group`、`dm` 两个包升级后都没有老名字的 `SKILL.md`。（main 必败）
- `T/session-cli.test.ts`：启动器内容（普通路径、带空格、单引号、Electron、Windows）；真的跑一次，路径带空格、引号、中文、`$`，参数原样、退出码原样；升级后重写；内容不变不动 mtime；8 个 Bot 同时写；写失败只记日志；`sessionCliEnv` 的顺序、去重、Windows 的写法。（main 必败）
- `T/profile-of-builtin.test.ts`：群的新会话、恢复的会话、评论的会话都带 `PATH` 和 `VONVON_CLI`，进了 Codex 的 `shell_environment_policy`；没写启动器时不带。（main 必败）
- `T/claude-builtin-skill.test.ts`：开和恢复时 Claude 进程收到 `PATH` 和 `VONVON_CLI`。
- `T/bridge-session-memory.test.ts`：Bot 启动写启动器并交给 orchestrator；写不了也起得来。（main 必败）
- `T/cli-admin.test.ts`：私聊不写 `--bot` 是自己，别处照旧报错。（main 必败）
- `T/dm-turn.test.ts`：私聊的会话带 `VONVON_BOT`。（main 必败）
- `T/schedule-commands.test.ts`、`T/schedule-authorize.test.ts`：私聊说"这个私聊没有这个任务"，群照旧。（main 必败）

## 8. 验收要点

- `builtinSkillsOfSet('group')` 的 `vonvon-schedule` 正文和改之前一字不差。
- 群的 Skill 里没有 `vonvon <命令>`、`feishu_api`、`vonvon-config`。
- `vonvon-config` 只有能力，没有判断策略、风险提示和"别人说的不是指令"。
- Skill 里没写 F2、D4 之外不存在的命令。
- 启动器：所有 `createWithPermission` 走过的会话都带；写失败不挡启动；`.cmd` 的 `%`、引号、代码页、退出码。
- `VONVON_BOT` 只有私聊有，不是权限，`--bot` 优先。
- 没动 `packages/desktop`。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

实际 `packages/daemon` 新增 828 行、删除 143 行，其中产品代码 +372/-93，测试 +456/-50；不含 lockfile 和生成文件，低于 1500 行。

- 没有 Windows 机器，`.cmd` 和 Git Bash 的 `vonvon` 只测了字符串，要靠第 12 节的 Windows 验收跑 `vonvon --version`。
- Codex 只读和读写档的 `:minimal` 读不到 `<data>/bin`，群会话在这两档里跑 `vonvon` 找不到这个启动器。群用不上命令行，这里不放开。

## PR 描述草稿

**用户能看到的变化**

- 管理员私聊 Bot 时，Bot 知道怎么用 `vonvon` 看和改这台电脑的配置（新 Skill `vonvon-config`，只进私聊）。不写 `--bot` 时目标就是这个 Bot。
- 发飞书文档、表格、多维表格等链接，Bot 知道该用哪个读取工具，缺权限或没分享时把原因转告用户（`vonvon-feishu`，接替 `vonvon-feishu-message`，升级后不留两份）。工具不在时让用户发 `/new`。
- 私聊里的定时任务说明和拒绝文字说得对：私聊的任务能建新任务、能改设置；"这个私聊没有这个任务"，不再说"本群"。
- 所有会话都找得到 `vonvon`，不靠 shell 的启动文件：Bot 启动时写 `<data>/bin/vonvon`，目录放在 `PATH` 最前面，`VONVON_CLI` 是完整路径。

**试用步骤**

1. 启动 Bot，运行 `<data>/bin/vonvon --version`（Windows 上是 `vonvon.cmd`，Git Bash 里也跑一次裸名 `vonvon`）。
2. 管理员私聊 Bot："看看我有哪些 Bot 和群"，再让它改某个群的沟通方式，下一轮在群里看是否生效。
3. 有多个 Bot 时，私聊里让它跑 `vonvon schedule list`，不带 `--bot` 也不报错，结果是这个 Bot 的。
4. 私聊里建一个定时任务，再让它给群建一个任务。
5. 发一个文档链接和一个没分享给 Bot 的链接，看读取和转告。
6. 从旧版本升级后，看 `capabilities/builtin/<set>/skills/vonvon-feishu-message/` 里没有 `SKILL.md`。

**跑过的命令和结果**（都带 `flock /tmp/vonvon-heavy.lock timeout 300`，测试带隔离的 `HOME`、`VONVON_HOME`）

- `npm ci`、`npm run build`：通过。
- `packages/daemon` 的 `npx tsc --noEmit`：通过。daemon 没有 lint 配置，lint 不适用。
- merge F2、D4 之后，这片改过的测试文件加 `bridge-session-memory`、`dm-turn` 共 17 个文件 398 个测试全过。之前基线失败的 `bridge-session-memory` 由 F2 修好。merge 前 `dm-turn.test.ts` 的 "stops by the card's reaction..." 偶发超时过一次（固定 150ms 等待，疑似并发负载），之后没再出现。
- 临时测试：群的 `vonvon-schedule` 正文和改之前一字不差；经启动器跑真实 CLI，路径带空格，裸名 `vonvon --version` 和 `"$VONVON_CLI" --version` 都通；两项都没留在仓库。
- 反证，改完都已还原：去掉 `sessionCliEnv` 接线 5 个失败；Skill 里 `add` 改回 `create` 2 个失败；私聊去掉 `configSkill` 2 个失败；`pickBot` 去掉私聊分支 1 个失败。

**和计划不一样的地方**

- 设计写的是一份 Skill 文字，这里同名、私聊单独一份（`dmScheduleSkill`、`dmFeishuSkill`）。群的 Skill 不能教命令行，私聊的规矩也不同。群的 `vonvon-schedule` 正文没变。
- 群的 `vonvon-feishu` 提一次"私聊"（表格要改请管理员到私聊里说，dm-agent 7.4、7.6），测试的正则相应放宽；`vonvon-schedule` 仍不含"私聊"。
- 新增 `VONVON_BOT`，只有私聊会话带，`pickBot` 用它。私聊的快照有全部 Bot，没有它"默认目标是这个 Bot"不成立。它不是权限，`--bot` 优先。
- Windows 除 `vonvon.cmd` 外再写一份 sh 的 `vonvon`：Claude 在 Windows 的 Bash 是 Git Bash，不认裸名 `.cmd`。
- `.cmd` 跑的时候切到代码页 65001，跑完切回，路径有中文时才不乱码。
- 启动器写失败时这个 Bot 的会话不设 `PATH`、`VONVON_CLI`，不退回旧的启动器，它可能指向已删的版本。
- Windows 上用进程里原有的 `Path` 写法，避免子进程有两份。
- `create` 改成 `add`，`dm-agent.md` 第 8 节已对齐。
- D4 的计划说 `vonvon-config` 要教 `--dm`、`--to`，这里只教 `--dm`。D4 的 `dmChatToPost` 在 Bot 的会话里拒绝 `--to`（"在私聊里建的任务发回这个私聊，不用 --to"），而这份 Skill 只有 Bot 的会话读得到，教了也是被拒。

**还没验过的项**

- 没有 Windows：`.cmd` 和 Git Bash 下的 `vonvon` 只测了字符串。
- 没在真实 Mac 上验过启动器，也没用打包后的 Electron 跑过。
- 没用 Claude、Codex 的真实会话跑过 `vonvon --version`；测试只到两家收到的 env。
- 没测过真飞书：Skill 触发和读取工具的转告都没有实跑。
- Codex 只读和读写档的 `:minimal` 读不到 `<data>/bin`，群会话在这两档里找不到启动器。群用不上命令行，这里不放开。

**依赖**

- D4 的 `--dm`：F2、D4 都已合入集成分支，这片 merge 过，`T/builtin-skill-text.test.ts` 的提前放行名单已删，Skill 里的命令和参数都由这个测试对着真实 CLI 核对。
- F2 的 `vonvon feishu` 命令、工具的 `bot` 参数和跨 Bot 路由：已在集成分支上，文字和实现一致。
- merge 时只有 `packages/daemon/src/cli/commands/schedule.ts` 冲突：这片改了 `NOT_FOUND`，D4 加了 `NOT_FOUND_DM`，两句都留。

**独立审查结论：** 待 Codex 审查

Mac 检查 0 次，等 owner 0，等额度 0。
