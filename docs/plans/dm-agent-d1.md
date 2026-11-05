# dm-agent-d1 计划：私聊项目

设计在 `dm-agent.md` 第 2、4 节，产品行为在 `docs/product.md` 第 4 节和 3.3，这里只写落到代码上的做法。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

每个 Bot 的 `projects.json` 多一行私聊项目，启动时自动建，目录是 Bot 目录下的 `dm`。用户看不到变化，所有群相关的功能都看不见这一行。无依赖；D2、D3、D4、C2 接着用。

## 2. 范围

做：`Project.dm`、注册表的读写、`ensureDmProject`、`settings save.project` 对这一行的限制、所有绕过 `listProjects` 的地方。

不做：私聊进 Agent 的路由和 `rememberDmChat` 的调用（D2）；`profileOf`（D2）；快照、界面和 `--dm`（D4）。

## 3. 现在的代码

- `D/project/registry.ts`：`read()` 就是 `listProjectsIn()`，写的函数都是读出全部行、改、整个写回。
- 按名字改行：`updateProject`、`removeProject`、`mutateProject`、`resetProjectDirectoryOverride`。没有按 `chatId` 改行的函数，`dm-agent.md` 4.2 说的"统一走 `rowIndexOf`"实际只有新加的函数。
- 绕过 `listProjects` 的地方见第 4 节的表。
- Bot 目录：`D/config/bots.ts` 的 `allocations`，新 Bot 注册时分配，老 Bot 第一次建默认目录的群时才分配。
- 设置的范围用 `projectName` 指行，见 `D/admin/settings.ts`。

## 4. 怎么改

**注册表。** `read()` 留给写的函数和按 chat 查，继续返回全部行，否则一次写就把私聊行丢了。`listProjectsIn()`、`listProjects()` 过滤。按名字的函数都走 `namedRow()`，不看 `dm` 行，所以群也可以叫"私聊"。`rowIndexOf()` 先看 `chatId`，再看 `dm.people`。新增 `dmChatId`、`dmProject`、`addDmProject`、`rememberDmChat`、`mutateProjectByChatId`。

`rememberDmChat` 第一次记 `at`，以后只更新名字；没有变化不写文件，D2 每条消息都可以调。

**绕过 `listProjects` 的地方：**

| 地方 | 处理 |
|---|---|
| `storedRows` | 不过滤，它要校验整个文件；由下面的调用者处理 |
| `getProjectByChatIdSync` | 走 `rowOfChat`，和异步版同一份映射 |
| `withStoredRows` | 只把群行交给回调，私聊行原样写回。调用者：`admin/library.ts` 的 `linkBot`、`migrateBotMemory`，`project/judge-snapshots.ts`。回调只改键，不增删行 |
| `splitTierChats` | 跳过，`tierMergePending` 写了它也不算 |
| `listProjectsIn` 的调用者 | 过滤后自动跳过：`admin/library.ts` 全部、`admin/service.ts` 全部、`admin/secrets.ts`、`admin/context-preview.ts`、`admin/settings-service.ts`、`project/lifecycle.ts`、`project/judge-snapshots.ts` |
| `directory-audit.ts` | 不读行，cwd 来自 `admin/service.ts` 和 `project/lifecycle.ts`，上一行已跳过 |
| `addProject`、`bindProject` | 名字重复只和群比；`chatId` 重复和所有行比 |
| `removeProject`、`updateProject`、`mutateProject`、`resetProjectDirectoryOverride` | `namedRow`，名字碰不到私聊行，所以不能解绑、不能删、不能改名 |
| `materializeGroupSettings` | 走 `listProjects`，跳过 |
| `import/bridge/*`、`config/bots.ts` 的搬文件 | 读的是 bridge 的文件或整文件搬，不看行 |

**`D/bot/dm-project.ts` 的 `ensureDmProject()`。** 行已有：只补目录。行没有：`ensureBotDmDirectory()` 建目录，取默认值，`addDmProject()`。全部包在 try 里，失败只记日志。默认值由 `handle-message.ts` 的 `dmDefaults()` 算，在 `initialize` 里放后台跑：列模型可能冷启动 Provider，不能挡住 Bot 上线。

**目录。** `ensureBotDmDirectory()`（`D/config/bots.ts`）在 `bots` 锁里拿 Bot 目录（没有就分配，和建群同一段代码，抽成 `readyBotDirectory()`），再 `ensureDurableDirectory(<Bot 目录>/dm)`。名字固定，Bot 目录下只有 Bot 自己分配，所以不像群那样记 `bots.json`。

**设置。** `scope.projectName === 'oc_dm_<appId>'` 时读写走 `readChatProject`、`mutateChatProject`；`model`、`speed`、`modelAccess`、`skills` 以外的分区返回错误。成员动作仍只走按名字的写，碰不到。这一行存盘后要让每个人的 p2p 会话重建，不是 `oc_dm_` 这个 id 的。

## 5. 测试

`T/dm-project.test.ts`：
- 读：列表和按名字看不见；p2p chat_id 返回带真实 id 的行，异步和同步一样；`oc_dm_` 返回原行；没记过的 id 和 `constructor` 找不到；手改成没有 `people` 不崩。
- `rememberDmChat`：`at` 不变、名字更新、没变化不写、没有行时报错。
- 写：群的增、改、绑、删之后私聊行还在；叫"私聊"的群能建、能改、能删，碰不到私聊行。
- 绕过的地方：`withStoredRows` 不交出私聊行；`splitTierChats` 跳过；项目库不建项目、不写 `projectId`、不进概览。
- `ensureDmProject`：新 Bot 的行逐字段等于 4.1；老 Bot 加一行；再跑一次文件不变、不取默认值；目录被删后补回；之后建群的目录还在同一个 Bot 目录下；自定义根；失败只记日志，下次能建好；Bot 重新注册过时只记日志。
- 停着的 Bot：设置能读，能改私聊行，同名的群不受影响。

`T/settings-owner.test.ts`：四个分区能存；其余八个分区拒绝且行不变；`mode` 还是 `full`；每个人的 chat 都驱逐；读的时候不向飞书要群成员；成员动作碰不到。

全量回归：所有引用注册表、`bridge`、编排器、设置、项目库、`config/bots` 的测试文件。

## 8. 验收要点

- 写的函数读的都是全部行，一次群操作不会丢私聊行。
- 第 4 节的表和 `grep -E "listProjectsIn|withStoredRows|storedRows|projectsFile"` 的结果对得上。
- 新 Bot 和老 Bot 走同一条路；幂等；失败不挡启动。
- 群叫"私聊"时一切照旧。
- `save.project` 以外没有路能改这一行的档位和目录。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

约 400 行，一半是测试。

风险：
- 漏过滤会让私聊行进项目库或群列表；反过来在写路径上过滤会丢行。两边都有测试。
- `allocations` 现在在启动时就分配，老 Bot 比以前早。父目录用 Bot 配的 `projectsRootDir`，和第一次建群时一样，以后的群目录不变。

留给 D2：
- p2p 行的 `name` 是"私聊"，`chatId` 是 p2p id。`refreshBranch` 这类拿 `project.name` 回写的路径，在私聊下会写到同名的群，或者不写，要在 `dm` 行上跳过。
- `settings.ts` 读会话设置时用 `listProjects` 按 `s.chatId` 找群，私聊会话找不到，和今天一样。
