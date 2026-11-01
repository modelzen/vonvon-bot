# cli-5-memory-rpc 计划：记忆命令经 daemon，补齐记忆操作（C5）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 5.2 节 `memory.*` 一行、5.3 节、8.2 节 C5 一行、8.3 节第一行和第 13 节 C5 一行；约定照 `docs/plans/cli-1-conventions.md`（C1）；共用改动照 `docs/plans/cli-2-bot.md` 4.6，`METHODS` 照 `docs/plans/cli-3-groups.md` 4.6。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2。

**和 D4a 的关系**：任务要求照 5.3 接 D4a 的 origin 透传，并读 `docs/plans/devices-4a-scope.md`。写本计划时 `claude/devices-1-identity` 不在 origin 上，那份计划还看不到，所以本片按 5.2、5.3 的原文做最小的一步，要和 D4a 对齐的地方列在 4.8，哪一方后合入由哪一方照 4.8 改。

## 1. 做什么

用户看得到的变化：
- `vonvon memory …` 在 daemon 跑着时都经 daemon 做，和网页改的是同一份、同一个锁。daemon 没跑时 `memory list / export / events` 照旧读文件（输出标 `source:'files'`），改记忆的命令提示先启动 daemon。
- 网页记忆页上的"恢复""移到 Bot 记忆""移到别的项目""点成可信""彻底删除""撤销""历史"和"删除分支"都能在终端里做。
- 私聊记忆用 `--dm <openId>` 指定；`--bot` 能写名字。
- `memory forget` 改名 `memory archive`（旧名留作别名），和网页"归档"同名。

依赖：C1（已合入）。D4a 不是硬依赖（4.7）。

## 2. 范围

做：
- 所有 `memory` 命令改走 `memory` RPC（4.2），读类在 daemon 没跑、又不在 Bot 会话里时回退到文件。
- 8 条新命令（4.1 表；另有 `forget` 改名的 `archive`），从白名单挪掉 7 个 kind：`memory.restore / promote / move / confirm / purge / undo / events`。
- 一个新 kind `memory.branchDelete`：一次事务里把一个分支的条目全部归档（4.3）。
- daemon 侧 `memoryRpc` 按连接的 `clientKind` 记来源（`cli` 或 `ui`），修掉"经 RPC 一律记 `ui`"（5.2 表下那句）。

不做：网页的"删除分支"改用 `branchDelete`（今天网页逐条发 N 次 `archive`，`archiveBranchItems`；换成一次请求是网页的改动，留给 U 线，本片只在 PR 描述里提一句）；`memory seen / newCounts`（client-only，白名单不动）；会话里的权限判断（D4a/D4b）。

## 3. 现在的代码

- `D/cli/commands/memory.ts`：`terminalMemoryContext()` 的 `run` 直接在进程里调 `memoryAction(request, { origin: 'cli' })` 读写文件（`memory.ts:20-28`）；`projects()` 读 library 文件；`scopeOf()` 要 `--project`（名字或 id）或 `--bot`（只认 appId，`memory.ts:35`）；写类先 `refuseInSession()`（`not_in_session`，`memory.ts:44`）；`show()` 已经认 `events` 回复，但没有注册 `events` 命令；`list` 的 `--all` C1 已经做了。
- `D/cli/index.ts:182-203`：`list / export / add / edit / forget / reseal / branch-rename / branch-merge`。
- `D/server/rpc/memory.ts`：`memoryRpc(service, request)` 调 `memoryAction(request)`，不传 `origin`，于是经 RPC 的一律是 `via:'ui'`、`actorRole:'desktop'`（`D/admin/memory.ts:85-100`）。
- `D/server/http.ts:171`：`case 'memory': return finish(peer, await memoryRpc(options.service, request.payload), …)`。旁边 `case 'schedule'` 已经把 `peer.clientKind` 传进去（`D/server/rpc/schedule.ts` 的 `VIA`）。
- `D/bot/memory-store.ts`：`archive / restore / confirm / purge / branchRename / branchMerge / undo` 都在 `transact()` 里；`setState(tx, item, 'archive', actor)` 每条记一个 `archive` 事件；空的自建分支在写完时自动去掉（`pruneBranches`）。
- `P/memory.ts`：请求 `list / add / edit / archive / restore / promote{botId, branch?} / move{to:{projectId}, branch?} / branchRename / branchMerge / confirm / purge{itemId} / undo{eventId} / export / reseal / events{itemId} / seen / newCounts`；范围 `project{projectId} / bot{botId} / dm{botId, openId}`；拒绝原因 `memoryRefusalSchema`（含 `fixed-branch`、`no-such-branch`、`not-undoable`）。

## 4. 怎么改

### 4.1 命令

范围选项（`memoryScope()`，每条都有）：`--project <名字或 prj_…>`、`--bot <appId 或名字>`、`--dm <openId>`（要和 `--bot` 一起给）。`--project` 和 `--bot` 必须正好一个。

| 命令 | RPC（`memory.…`） | `covers` | `--json` 成功 |
|---|---|---|---|
| `memory list [--all]`（改） | `list` | 同今天 | `{ok, source:'daemon'\|'files', …list}` |
| `memory export`（改） | `export` | 同今天 | `{ok, source, files}` |
| `memory events <itemId>` | `events` | `memory.events` | `{ok, source, events}` |
| `memory add / edit / reseal / branch-rename / branch-merge`（改） | 同今天，经 RPC | 同今天 | 同今天 |
| `memory archive <itemId> --revision <n>`（`forget` 改名，`forget` 留作别名） | `archive` | `memory.archive` | `{ok, item, branchApplied?}` |
| `memory restore <itemId> --revision <n>` | `restore` | `memory.restore` | `{ok, item, branchApplied?, newBranch?}` |
| `memory confirm <itemId> --revision <n>` | `confirm` | `memory.confirm` | `{ok, item}` |
| `memory promote <itemId> --revision <n> [--to <bot>] [--branch <b>]` | `promote` | `memory.promote` | `{ok, item, branchApplied?}` |
| `memory move <itemId> --revision <n> --to <project> [--branch <b>]` | `move` | `memory.move` | `{ok, item, branchApplied?}` |
| `memory purge <itemId> [--yes]` | `list`（预览）、`purge` | `memory.purge` | `{ok, purged:itemId}` |
| `memory undo <eventId>` | `undo` | `memory.undo` | `{ok, item}` 或 `{ok, branches, moved}` |
| `memory branch-delete <name> [--expected <n>]` | `branchDelete`（新） | `memory.branchDelete` | `{ok, branches, moved}` |

失败（`show()` 今天的映射不变：`conflict` → 5 带 `current`；`refused` 的 `bad-args` → 2，其余 → 4 带 `reason`）：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 范围没给对、`--dm` 没带 `--bot`、项目或 Bot 找不到、`--revision` 不是正整数 | 2 | — |
| `purge` 没带 `--yes` | 2 | `confirm_required`，`partial: {item:{id, text, branch, state}}` |
| 写类命令而 daemon 没跑；会话里任何命令而 daemon 没跑 | 3 | — |
| 会话里的写类（D4a 之前） | 4 | `not_in_session`（今天的文字） |
| 记忆拒绝（满了、像密钥、重复、没这条、固定分支、不能撤销…） | 4（`bad-args` 为 2） | 记忆的 `reason` |
| 版本对不上；`branch-delete` 的 `--expected` 和分支里的条数不一样 | 5 | `conflict` |
| 写请求超时或断线 | 6 | — |

### 4.2 经 daemon，读类回退

`MemoryContext` 的形状不变（`io`、`env`、`projects()`、`run()`），多两样：`bots(): Promise<{ id, name }[]>`（`--bot` 按名字找）和 `source: 'daemon' | 'files'`。`terminalMemoryContext(io, kind: 'read' | 'write')`：

1. 先连 daemon（`connectLocalDaemon()`）。连上：`run` = `call('读写记忆', c => c.memory(request), 写类 ? { unknown: '可能已经改了，运行 vonvon memory list 查看。' } : {})`；`projects()` = `library.list`；`bots()` = 快照里的 `agents`；`source = 'daemon'`。
2. 连不上（`connection` 那一类，不含超时、断线）：
   - `kind === 'write'` 或 `inBotSession(env)` → 原样 exit 3，文字加一句"改记忆要 daemon 在运行：vonvon daemon start。"（会话里的读也不回退：读文件就绕过了 D4a 给会话的过滤，8.3 的回退只给会话以外的终端）。
   - 否则走今天的文件路径（`memoryAction(request, { origin: 'cli' })`、`readLibrary()`、`loadBots()` + `botLabel()`），`source = 'files'`。
3. `show()` 里写死的 `source: 'files'` 换成 `ctx.source`；`events` 回复也带 `source`。

`--bot` 先按 id 再按名字找（`pickBot()` 的规则：名字重复时 exit 2 列出来）。读类命令用 `kind:'read'`：`list`、`export`、`events`；其余都是 `'write'`。

### 4.3 新 kind `memory.branchDelete`

- **schema**（`P/memory.ts` `memoryRequestSchema` 里，挨着 `branchMerge`）：
  ```ts
  /** Archives every active entry of a branch in one transaction (the web page's 删除分支); each gets its own archive event, undone one by one. */
  z.object({type:z.literal("branchDelete"),scope:memoryScopeRefSchema,name:z.string().min(1).max(200),expected:z.number().int().min(0).optional()}).strict(),
  ```
  回复用已有的 `branches{branches, moved}`，不加回复种类。
- **handler**：`D/bot/memory-store.ts` 新方法 `branchDelete({ name, expected?, actor })`，在一个 `transact()` 里：找分支（没有 → `no-such-branch`）；固定分支 → `fixed-branch`"固定分支不能删"；取分支里 `state === 'active'` 的条目，`expected` 给了而条数不同 → `{ ok:false, reason:'conflict', message:'分支里的条目刚变过，重新看一次再删' }`；逐条 `setState(tx, item, 'archive', actor)`；回 `{ ok:true, branches: orderBranches(…), moved: n }`。分支空了由 `pruneBranches` 照常去掉。`D/admin/memory.ts` `memoryAction` 加一个 `case 'branchDelete'`，和 `branchMerge` 同样的结果转换。`memoryRpc` 不用改：不在 `READS` 里就是写。
- **不加新事件种类、不加 `reason`**：每条一个 `archive` 事件，`undo` 逐条撤销，和网页今天逐条归档留下的记录一样，网页的"历史"和撤销不用改。
- **权限表（5.2）新加一行**：

  | RPC | owner | bot-session |
  |---|---|---|
  | `memory.branchDelete` | ✓ | ✗ `permission_denied`（Bot 的记忆工具只有 add、update、forget、list，没有对应的；不进维护子集） |

  本片和 D1（`D/server/authz.ts` 在 `claude/devices-1-identity`）谁后合入，谁把这一行加进表；D1 的"每个 protocol 里的 kind 都在表里"测试会在缺这一行时变红，不会漏。

### 4.4 来源（origin）

`D/server/rpc/memory.ts`：

```ts
/** The desktop app and the browser page are the same owner UI; `cli` is `vonvon memory`. */
const ORIGIN = { desktop: 'ui', web: 'ui', cli: 'cli' } as const satisfies Record<Hello['clientKind'], 'ui' | 'cli'>;
export async function memoryRpc(service: AdminService, request: MemoryRequest, via: { clientKind?: Hello['clientKind'] } = {}): Promise<RpcOutcome<MemoryReply>> {
  const deps = { origin: via.clientKind ? ORIGIN[via.clientKind] : 'ui' } as const;
  …memoryAction(request, deps)…
}
```

`D/server/http.ts`：`memoryRpc(options.service, request.payload, { clientKind: peer.clientKind })`。第三个参数做成对象，D4a 把 `principal` 加进同一个对象（4.8 第 1 条）。

### 4.5 其余命令的细节

- **`archive`**：`forget` 用 commander 的 `.alias('forget')`，帮助里只显示 `archive`。
- **`promote`**：只对项目记忆的条目（网页"移到 Bot 记忆"）；`--to` 不写时用这个项目唯一绑着的 Bot，多于一个 → 2 列出来。
- **`move`**：`--to` 是项目名或 id，和 `--project` 同一个找法。
- **`purge`**：先 `list`（带归档）找到这条，找不到 → 2；没带 `--yes` → 2 `confirm_required`，文字"彻底删除后找不回来，记录里的原文也会换成占位。确认后加 --yes 再运行一次。"；带了就发。不核对 revision（网页同样不核对，store 注释"主人在桌面端一键做"）。
- **`undo`**：`eventId` 来自 `memory events --json`。`not-undoable` → 4。
- **`events`**：人类输出照 `show()` 现在的一行一条，补上操作者（`actor.role`）。
- **`branch-delete`**：人类输出"已归档「X」分支的 N 条；要找回用 vonvon memory list --all 和 memory restore。"。`--expected` 给"先看再删"的调用方。

### 4.6 交互和非交互

全部不读 stdin、不提问。`purge` 用 `--yes`；`branch-delete` 只是归档（能恢复），和网页一样不要确认。

### 4.7 和总设计不一样的地方

- **不等 D4a**：第 13 节写 C5 依赖 D4a（origin）。来源只要知道是不是命令行，`peer.clientKind` 已经够（schedule 早这么做了），所以本片先做；会话里由谁触发、什么角色，是 D4a/D4b 往同一个参数里加 `principal` 的事。
- **写类没有 daemon 时 exit 3**：今天直接写文件也能成；8.3 只给读类留了回退，"daemon 是唯一写入者"。
- **`forget` 改名 `archive`**：8.1 命名三处一致（网页按钮"归档"、kind `memory.archive`）；旧名留作别名，已有的脚本不坏。
- **`purge` 要 `--yes`**：同 C2 4.7。
- **新 kind 只加 `branchDelete`**：8.2 写"`memory branch-delete`（原子）"，协议里没有能一次做完的请求；逐条 `archive` 不原子，中途断了会删一半。

### 4.8 和 D4a 要对齐的地方（`devices-4a-scope.md` 出来后核对）

1. **`memoryRpc` 的第三个参数**：本片是 `{ clientKind }`；D4a 加 `principal`（bot-session 时 `origin:'cli'` 加会话信息和 Bot 进程回的 `role`，5.2）。后合入的一方把两者合成 `{ clientKind, principal }`，`principal` 在时以它为准。
2. **`refuseInSession()`**：本片保留（新写类命令也先调它）。D4a 照 5.3 换成"有令牌 + `--scope` 就放行，由 daemon 判"，同时删掉这个函数和 `SESSION_REFUSED`。
3. **会话里不读文件**：本片已经做了（4.2 第 2 条），D4a 不用再改。
4. **权限表**：`memory.branchDelete` 一行（4.3）。另外提请 D4a/D4b：5.2 的 `memory.*` 一行写"★ 过 `authorizeMemory`"，但 `authorizeMemory` 只认 add、update、forget、list；建议 `export`、`events` 按 list 的 ★ 判，其余没有工具对应的写类（`restore / promote / move / confirm / purge / undo / branchRename / branchMerge / reseal / branchDelete`）bot-session 一律 ✗。
5. **`http.ts` 的 `case 'memory'` 一行**：两边都改它，合并时以 4.8 第 1 条的合成为准。

## 5. 测试

`T/memory-cli.test.ts` 改成注入 `MemoryContext`（`source`、`bots()` 新增）；新文件 `T/cli-memory-rpc.test.ts`；daemon 侧 `T/memory-branches.test.ts`（分支操作已有的测试文件）和 `T/memory-admin.test.ts`（`memoryRpc` 的来源）：
- 连得上 daemon：`memory add 记一下 --project p1` 发 `memory{type:'add', scope:{kind:'project', projectId:'prj_1'}, text:'记一下'}`，不调文件路径；`list --json` 带 `source:'daemon'`（main 必败）。
- 连不上：`list` 走文件、`source:'files'`；`add` → connection、文字含 `daemon start`、文件没变（main 必败）；会话环境里 `list` 也是 connection、没读文件（main 必败）。
- `--bot 小研`（名字）→ `scope.botId` 是对应的 appId；两个同名 → bad-args；`--dm ou_1` 不带 `--bot` → bad-args；`--bot b --dm ou_1` → `scope:{kind:'dm', botId, openId:'ou_1'}`（main 必败）。
- `memory archive` 和 `memory forget` 发同一个 `archive` 请求（main 必败：今天没有 `archive`）。
- `restore / confirm / promote --to <bot> / move --to <project> / undo / events` 各发出对应请求（main 必败）。
- `purge i1` 不带 `--yes` → bad-args `confirm_required`、`partial.item.id === 'i1'`、没发 `purge`（main 必败）。
- 回复 `refused{reason:'not-undoable'}` → refused、`reason:'not-undoable'`（今天的映射，保持）。
- daemon：`memoryRpc(service, {type:'add',…}, { clientKind:'cli' })` 之后事件的 `source.via === 'cli'`、`actor.role === 'cli'`；`{ clientKind:'web' }` → `'ui'`（main 必败：今天一律 `ui`）。
- store `branchDelete`：分支三条（两条 active、一条已归档）→ `moved:2`、两条 `archive` 事件、分支去掉；`expected:3` → `conflict`、什么都没改；固定分支 → `fixed-branch`；不存在 → `no-such-branch`；之后 `undo` 其中一条事件 → 那一条回到 active，分支重新出现（main 必败）。
- `memoryRequestSchema` 认 `branchDelete`；`rpcKinds()` 含 `memory.branchDelete`；`T/cli-parity.test.ts` 绿（新 kind 被 `memory branch-delete` covers）。
- `T/cli-memory-preaction.test.ts` 不变照过（memory 不拿租约）。
- `T/cli-json.test.ts` 加 8 行样本、`memory forget` 那行改成 `memory archive`（和现有的 memory 样本一样不给范围，连 daemon 之前就退 2）；另加一条 `memory add x --project p --json` 在没有 daemon 的临时数据目录里退 3。

## 6. 自测和验收

**Linux（JP-VPS）**：protocol、daemon、ui 的 typecheck、lint、build（ui 只因为协议多了一个 kind，要确认没有穷举 `MemoryRequest['type']` 的 switch 报错）；上面的测试文件，加上 `T/memory-*.test.ts` 全部、`T/cli-admin.test.ts`。临时数据目录里手跑：没 daemon 时 `memory list --project x --json` 回 `source:'files'`，`memory add` 退 3。

**集成分支验收时，主会话在验收 daemon 上做**（拿目录锁、核对 sha、用完放锁；只用测试群的项目记忆）：
1. `vonvon memory add C5验收 --project <测试项目> --branch C5验收`，网页记忆页马上能看到；`vonvon memory events <id> --json` 第一条的操作者是 `cli`（devices.md C5 验收一行）。
2. 停掉之前不碰 daemon；用一个临时数据目录（不在跑 daemon）跑 `memory list --json`，`source:'files'`（验收 daemon 不停）。
3. `memory list --all` 列出已归档的。
4. `memory branch-delete C5验收`，网页那个分支消失；`memory list --all` 里那条是已归档；`memory undo <那条 archive 事件>` 能找回；最后 `memory purge <id> --yes` 清掉。

**Mac、Windows**：不需要。

## 7. 文档

- `docs/product.md`：记忆那一节如果写了"命令行直接改文件"或 `vonvon memory forget`，改成 `archive`、"经 daemon"。只改这几处字面，D0 的命令行段落不动。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. daemon 在跑时，没有一条 `memory` 命令直接读写记忆文件。
2. 读类回退只发生在"连不上 daemon 且不在会话里"；写类没有回退。
3. `branchDelete` 一次事务；`expected` 不对时什么都不改；每条一个 `archive` 事件，能逐条撤销。
4. 经 RPC 的命令行写入记 `via:'cli'`；网页的仍是 `ui`。
5. `purge` 不带 `--yes` 不发请求。
6. 白名单里没有本片的 7 个 kind；`memory.branchDelete` 被 covers；PR 描述写明 4.3 的权限行和 4.8 的对齐清单。
7. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,000 行：`memory.ts`（CLI）+260，`index.ts` +60，`P/memory.ts` +3，`memory-store.ts` +35，`admin/memory.ts` +15，`rpc/memory.ts` +10，`http.ts` 1 行，白名单 −7，测试约 600。
- 写类没有 daemon 就不能用，是行为变化：输出里给出 `vonvon daemon start`，PR 描述写清楚。
- `branchDelete` 一次归档很多条时 `trimArchived` 会按上限清理最旧的已归档条目（和逐条归档一样），测试里放一个上限小的位置核对两种做法结果相同。
- 和 D4a 改同一行（`http.ts`）、同一个文件（`memory.ts`），见 4.8。
