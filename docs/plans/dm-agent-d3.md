# dm-agent-d3 计划：私聊记忆

设计在 `dm-agent.md` 第 5 节"私聊记忆（D3）"，范围和写入规则在 `memory-projects.md` 3.1、3.2、4.7，产品行为在 `product.md` 3.6 的记忆表和第 4 节。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

管理员在私聊里让 Bot 记的事，记进这个人自己的私聊记忆，下一轮和新会话都带着；另一个管理员看不到、改不了。依赖 D2（#710，审查中，这一片以它为基线）。

## 2. 范围

做：`storeFor` 接 `dm`；`decideAdd` 的私聊落点；`memory_update`、`memory_forget`、`memory_list` 能用；开场和每轮更新带私聊记忆；隐藏块的说明和"满了"提示；使用记录；`memory.dmPeople` 接口和 `vonvon memory people`。

不做：权限表（C1）、定时任务（C2）、页面和 `--dm` 设置（D4）、Skill（C3）。移除管理员后的私聊记忆不动（设计没写）。"新"标记（`seen`、`newCounts`）和"模型看到什么"预览不含私聊，要的话 D4 加。

## 3. 现在的代码

- `D/bot/memory-writer.ts`：`storeFor` 遇到 `dm` 抛错；`editLike` 对 `dm` 一律 `out-of-scope`；`list` 没有私聊。
- `D/bot/memory-authority.ts`：`decideAdd` 只有点名 `dm` 才进私聊记忆。没点名时走 `targetProject`，私聊里 Bot 只绑一个项目就写进那个项目，绑几个就拒绝。隐藏块点不了名。
- `D/bot/context-assembly.ts`：D2 已给 `{ kind: 'dm', person }`、不带补充职责和项目记忆，但没读私聊记忆。只有 `bot`、`project` 两种。
- `D/bot/memory-store.ts`：`dmMemoryLocation` 已有。`D/admin/memory.ts`、`D/server/authz.ts`、`vonvon memory --dm`、`registry.ts` 的 `ownDm` 已能按 `{ kind: 'dm', botId, openId }` 读写。

## 4. 怎么改

**落点（`decideAdd`）。** 私聊没有"本群的项目"。只有点名的 `{project}` 进项目；不点名、`dm`、裸 `project`、Bot 记忆的门没过（带 `downgraded`），都进 `{ kind: 'dm', openId: turn.openId }`。这一轮没有人时拒绝。隐藏块点不了范围，所以自然落在这里。

**条目。** `storeFor` 用 `d_<openId>` 作键。`editLike` 改成 `ownDm` 才往下走，别人的 id 和不存在的 id 都回 `out-of-scope`，探不出有没有。

**列表。** `memory_list` 是读类工具，拿不到这一轮的事实，所以 `deps.dmPersonOf(chatId)` 按窗口找人：私聊窗口只属于一个人，id 不从模型来。默认列私聊记忆和 Bot 记忆，`scope: 'dm'` 只列私聊记忆。

**上下文。** `ContextPlace` 的 `dm` 加 `openId`，`handle-message.ts` 的 `contextSourcesFor` 从 `dm.people[chatId]` 取。`loadContextSources` 读它，`MemoryKind` 加 `dm`，开场、增量、压缩后整份重交都走同一套。块排在 Bot 记忆后面，分可信和待确认两块，"群友或 bot 记的"和记忆约定里的说法一致。`[私聊记忆` 进 `INBOUND_BRACKET`，别人的消息伪造不了。`versions.dmMemory` 只有私聊会话有，群的 `SessionContext` 不变。

**隐藏块。** `hiddenBlockInstructions(nonce, 'dm')` 不教 `scope="project"`；满了说 `DM_MEMORY_FULL_NOTICE`。

**接口。** `memory.dmPeople { botId }` 读这个 Bot 的 `dm.people`，按人去重，回 `{ openId, name?, at, used }[]`。权限表：会话一律 `deny`，别的管理员是谁不归这个会话看；有 `--scope` 的主人要 scope 就是这个 Bot、没指定群。读记忆走已有的 `list`。命令行 `vonvon memory people --bot <bot>`，第一列是 `--dm` 要的 id。

并发和出错照条目库的 `'memory'` 互斥，每人一个目录。读不出来时 `failed.dm`，这条会话已有的不动，和另外两份一样。

## 5. 测试

- `T/memory-authority.test.ts`：不点名、`dm`、隐藏块、裸 `project` 都进私聊（裸 `project` main 必败）；门没过带原因；没有人时拒绝；群和评论点 `dm` 拒绝。
- `T/memory-writer.test.ts`：落到 `memory/dm/<openId>`；两个管理员列不出、改不了、删不了对方的，探不出有没有；群里动不了；满了和腾位候选。
- `T/memory-tools.test.ts`：经 registry 走完全部四个工具。
- `T/context-assembly.test.ts`：带什么、不带什么、顺序；没有人的窗口、群、评论都没有；增量；读失败不动；压缩重交；满了的提示。
- `T/dm-turn.test.ts`：真的 orchestrator，两个管理员的开场各有各的记忆。
- `T/memory-admin.test.ts`、`T/memory-cli.test.ts`、`T/authz.test.ts`、`T/authz-session.test.ts`：`dmPeople`。
- `T/usage-marker.test.ts`、`T/hidden-blocks.test.ts`：使用记录和伪造块。

## 8. 验收要点

- 私聊里说"记住 X"，不点范围，条目 id 以 `d_<这个人的 openId>:` 开头，项目记忆没变。
- Bot 只绑一个项目时，私聊的话也不进那个项目。`{project}` 点名才进。
- A 的会话开场、增量、`memory_list` 里没有 B 的条目；A 对 B 的 id 回 `out-of-scope`，和不存在的 id 一样。
- 群和评论会话的 `memory_list`、开场里没有私聊记忆，群的 `versions` 没有新键。
- 会话拿 `memory.dmPeople` 被拒。
- 隐藏块的说明在私聊里不教 `scope="project"`。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码 +154 −69，测试 +305 −14，加这份计划。风险在隔离：所有路径都靠 `ownDm` 和按窗口找人，模型给不了别人的 open_id。`context-assembly.ts` 里两种记忆改成三种，群的输出靠现有用例不变来核。

## PR 描述草稿

标题：dm-agent D3：私聊记忆

### 用户能看到的变化

- 管理员在私聊里让 Bot 记事，记进自己的私聊记忆，之后的回合和新会话都带着。
- 另一个管理员的私聊看不到、改不了这些内容；群里和云文档评论也看不到。
- 新命令 `vonvon memory people --bot <bot>` 列出私聊过这个 Bot 的人和各自的条数，第一列是 `vonvon memory list --bot <bot> --dm <id>` 要的 id。桌面端的私聊记忆页在 D4。

### 试用步骤

1. 用 D2 起的 daemon，管理员 A 私聊 Bot："记住周报要先写结论"。
2. `vonvon memory people --bot <bot>` 看到 A 有 1 条，`vonvon memory list --bot <bot> --dm <A 的 id>` 看到这一条。
3. `/new` 后问 Bot 周报怎么写，它记得。
4. 管理员 B 私聊同一个 Bot，问 A 记过什么，它答不出来；`memory_list` 里没有。

### 跑过的命令和结果

都在 JP-VPS 上，隔离的 `HOME` 和 `VONVON_HOME`：

- `npm ci`、`npm run build`（全部包）：通过。
- `tsc --noEmit`：daemon、protocol、client、ui、desktop 通过。daemon 和 protocol 没有 lint 脚本，没跑 lint。
- `packages/protocol` 的 `vitest run`：17 个文件，122 个用例，全过。
- `packages/daemon` 的 `vitest run`，只跑相关的（`test/memory*`、`test/context*`、`test/authz*`、`test/dm-*`、`test/agent-entry*`、`test/cli-memory*`、`test/cli-parity`、`test/rpc-parity`、`test/hidden-blocks`、`test/usage-marker`、`test/bridge-card-callback`、`test/bridge-session-memory`、`test/scheduled-run-shutdown`）：42 个文件，665 个用例，全过。全量留给集成 PR 的 CI。

### 和计划不一样的地方

- 设计写"只需要接通"，实际 `decideAdd` 不点名时走项目，隐藏块又点不了名，所以改了落点：私聊里只有 `{project}` 进项目。旧测试里"私聊裸 `project` 写进唯一的项目"改掉了，否则私聊的话会掉进群读得到的项目记忆。`memory-projects.md` 3.1 写的就是私聊默认进私聊记忆。
- 加了接口 `memory.dmPeople` 和命令 `vonvon memory people`：设计只说"读 `dm.people`"，host 要有接口才能给 D4 用，`cli-parity` 要求接口有命令行。
- `memory_list` 按窗口找人（`dmPersonOf`），不用这一轮的事实：它是读类工具，拿不到。
- 工具说明、记忆约定各加了半句私聊的默认落点，群会话的固定前缀也跟着变了这半句。
- `T/bridge-session-memory.test.ts` 里"`--bot` 没过门落到唯一的项目"改成落到这个人的私聊记忆，同上一条。`rpc-kinds` 的总数从 151 改成 152。
- `product.md` 3.3 的路径从 `memory/dm/<open_id>.json` 改成目录，和代码一致。

### 还没验过的项

- 真实飞书、真实 Codex 和 Claude 的私聊没跑，只有假 backend 的 `dm-turn`。隐藏块路径没在真实 Codex 上验。
- 全量测试和 macOS、Windows 交给集成 PR 的 CI。

### 独立审查结论

待 Codex 审查

🤖 Generated with [Claude Code](https://claude.com/claude-code)
