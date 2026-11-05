# dm-agent-f2 计划：`vonvon feishu` 命令和跨 Bot

设计在 `dm-agent.md` 第 7.2、7.3、7.5、7.6 节，这里只写落到代码上的做法。`D/` = `packages/daemon/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

管理员私聊 Bot 时，Agent 能换一个 Bot 的身份读飞书、调飞书接口；没写 `bot` 时，host 按群的绑定找 Bot，读不到时告诉它还有哪些 Bot。Agent 在 shell 里也能用 `vonvon feishu` 读，结果和工具一样。缺权限的回复写的是真正去读的那个 Bot 的名字和链接。

依赖 F1、F3、F4、F5、F6（#716）、F7（#718）、C1（#715），都在基线里；C2（#719）也已 merge 进来。

## 2. 范围

做：私聊工具的 `bot` 参数和路由；`feishu_api` 的 `bot`；`vonvon feishu` 的读取子命令和 `members`；RPC `command.feishuRead` 和权限表；第 7.5 节的回复在命令行和跨 Bot 时一样。

不做：写操作的命令行（`feishu_api`、`feishu_doc_edit` 都没有命令）；`vonvon feishu` 以外的新命令；飞书读取本身的逻辑；Skill（C3）。

## 3. 现在的代码

- `D/agent/entry/feishu-tools.ts`：`definitions` 是读取工具表，`createFeishuTools` 每个工具一个闭包，都在本进程读。
- `D/agent/entry/registry.ts`：`call` 校验输入、按 `class` 判这一轮；`ctx.admin` 是 `dmTurn`；`ctx.commit` 的 guard 调过以后调用不再被打断；`feishu_api` 走 `authorizeFeishuApi`。
- `D/admin/ipc.ts`：两条 IPC。`fcb.admin.*` 是 host 到 Bot，走子进程的 `process.on('message')`，只有父进程能发；`fcb.host.*` 是 Bot 到 host，每个子进程一个 responder，`hostOpSchema` 严格校验。
- `D/server/authz.ts`：`RULES` 每行三格，★ 请求经 `sessionActionOf` 问 Bot 进程。
- `D/feishu-read/denial.ts`：`denialContext` 在读取的进程里取 app 和名字，所以回复天然是那个 Bot 的。
- `D/cli/commands/feishu.ts`：只有 `groups` 和 `members`，`members` 走 `command.listGroupMembers`。

## 4. 怎么改

**一张读取表。** `readsOf({ members, feishu })` 把每个读取工具写成 `(args, only) => Promise`，`perform` 查表、严格校验参数。工具、host 转来的请求、命令行都走它，所以结果一样。`only` 是读取被限制到的群，由 authz 或位置给，不从参数来，在读取的进程里核对（`chatIn`、`keptTo`、`savedIn`）。

**路由（新文件 `D/admin/feishu-route.ts`）。** `routeFeishuRead(deps, reach, request)` 只在 host 跑：

1. 写了 `bot`：按 App ID、显示名、注册名找；重名或没有就拒绝。
2. 给了 `chat`：当前 Bot 绑定了就用它；否则第一个绑定且在运行的；都没运行就第一个绑定的（回答"没在运行"）；没人绑定就当前 Bot 试。
3. 其他：当前 Bot；命令行没有当前 Bot，要 `--bot`。

没写 `bot`、当前 Bot 读不到（`scope`、`not-shared`、`not-in-chat`）时，回复后面列本机其他 Bot。

**三道门。**

1. A 的工具：私聊用 `withBot(input)`（`AgentTool.dmInput`），群和评论的输入没有 `bot`，写了就是参数错误。`read` 在等待前后都看 `ctx.admin`，也就是 `dmTurn`。
2. host：`hostFeishuRead`、`hostFeishuApi` 查 session 属于这个子进程、位置是 `dm`、还没撤销。Bot 进程说什么都不算数。
3. B：请求只从 `fcb.admin.req` 来，这条 IPC 只有父进程能发，`run.ts` 只在有监管时才接。B 不知道这一轮，也不用知道：是谁的会话已经在 host 判过。

群和评论的工具只在本进程读，不经过 host。

**`feishu_api`（第 7.6 节）。** 不进读取表：`command.feishuRead` 给群也开放，放进去就绕过了"只在私聊"。单独的 `AdminFeishuOp` `feishuApi` 和 `HostIpcOp` `feishuApi`。不写 `bot` 或写的是自己：照 F7 在本进程调，guard 紧贴请求。写别的 Bot：在 `commit` 里先 `guard()`，再 IPC 给 host。guard 过不了进程，所以 `authorizeFeishuApi`（`dmTurn`）和 `feishuApiMessages` 全在 A 这边生效，文字不变；B 的 `checkedPath` 和 `apiRefusalOf` 照常跑，缺权限的回复是 B 的。guard 之后答案丢了，改东西的方法说"不知道生效没有"。

**命令行。** `command.feishuRead { agentId?, tool, args }`，权限表 `{ dm: 'bot', group: 'bot', comment: 'deny' }`。私聊：`feishu: { prefer: 会话的 Bot }`，能指定别的 Bot。群：`feishu: { bot: 会话的 Bot, only: 这个群 }`，指定别的 Bot 超出范围。Bot 进程按 `{ kind: 'feishuRead' }` 判：私聊 `dmTurn`，群要这一轮还在，评论拒绝。

**缺权限。** 回复在读取的进程里生成，只把"这个 Bot"改成名字：`scopeReply`、`apiRefusalOf`、拿不到令牌的那句。

## 5. 测试

- `T/feishu-route.test.ts`（main 必败）：路由顺序；B 没运行；其他 Bot 的清单；host 的检查；各位置的工具；非管理员、结束的回合、被移除的管理员到不了 B；Bot 进程按自己的名字回答；命令行和工具结果一致；每个读取工具都有子命令；`feishu_api` 跨 Bot 的全部路径。
- `T/host-ipc.test.ts`：两种请求和回复，`only`、多余字段被拒。
- `T/authz*.test.ts`、`T/web-rpc-coverage.test.ts`：表格、群的白名单、范围、owner 的 `--scope`。
- `T/agent-entry-session.test.ts`：`{ kind: 'feishuRead' }` 按位置判。
- `T/session-tokens.test.ts`：`session()`。
- `T/s47-cli.test.ts`、`T/cli-json.test.ts`：子命令。

## 8. 验收要点

- 群和评论的工具输入里没有 `bot`，写了被拒，没有任何调用到 host。
- 群和评论的工具表里没有 `feishu_api`；`command.feishuRead` 带 `feishu_api` 被拒。
- `hostOpSchema` 不接受 `only`：它只能由 authz 给。
- `feishu_api` 跨 Bot 时，`guard()` 在 IPC 之前；拒绝文字是 `feishuApiMessages` 的。
- 非管理员、结束的回合、被移除的管理员：host 的路由函数没被调用。
- 缺权限的回复里是目标 Bot 的名字和 `app_id` 链接，没有当前 Bot。
- 群的命令行读别的群、或别的群的消息 id，被 `only` 拒绝。
- `cli/parity-allowlist.ts` 通过，`command.listGroupMembers` 的说明对得上。
- diff 里没有真实 id、密钥、本机路径。

## 9. 风险和行数

产品代码约 730 行（+600 −133），测试约 710 行（+690 −17），另有这份计划。不超过约 1,500 行的审查上限（产品代码算），测试按模块看。风险在权限和进程边界一类，要多角度审查。最容易错的是 `feishu_api` 的 guard 过不了进程，和 `only` 被请求方带进来；第 8 节都列了。

## PR 描述草稿

### 用户能看到的变化

- 管理员私聊 Bot："用 Bot B 看看这篇文档"，Agent 用 B 的身份读，权限和分享按 B 算。
- 私聊里问一个群的消息，不用说哪个 Bot：当前 Bot 绑了这个群就用它，否则用绑定这个群的 Bot。
- 读文档被拒时，回复列出这台电脑上别的 Bot，Agent 能换一个再读。
- 私聊的 `feishu_api` 也能用别的 Bot 的身份调。
- Agent 和终端能用 `vonvon feishu messages|message|file|chat|doc|sheet|base|slides|mindnote|board|minutes|drive|folder|wiki|comments|doc-media|search|members`，结果和工具一样，`--bot` 选 Bot。
- 缺权限的回复写明是哪个 Bot 的应用缺权限，链接是那个 Bot 的。
- 群里没有变化：群只能读本群，换不了 Bot。

### 试用步骤

1. 管理员私聊 Bot A："用 Bot B 读 <一篇只分享给 B 的文档>"，读到。
2. 私聊 A："读 <一篇没分享给 A 的文档>"，回复说没分享，并列出 Bot B。
3. 私聊 A，问一个只有 B 绑定的群最近说了什么，读到。
4. 停掉 B，重复第 1 步，回答"Bot Bot B 没在运行"。
5. 私聊 A："用 B 查一下日历"，B 缺权限时，回复写 B 的名字和 B 的开通链接。
6. 普通成员在群里让 Bot 用 B 读：工具没有这个参数；`vonvon feishu doc x --bot B` 被拒。
7. 终端：`vonvon feishu doc <链接> --bot B`、`vonvon feishu members <群 id> --bot B --json`。

### 跑过的命令和结果

JP-VPS，都用 `flock /tmp/vonvon-heavy.lock`，merge 完 F6、F7、C2 之后的版本（`ca5d293b`）：

- `npm run typecheck`：`packages/protocol`、`packages/client`、`packages/ui`、`packages/desktop`、`packages/daemon` 都通过。
- `npx vitest run`（`packages/protocol`）：改完 `rpc-kinds` 的数之后 17 个文件，122 条通过。
- `npx vitest run`（`packages/daemon` 第一批 23 个文件，权限、IPC、工具、命令行、飞书读取）：629 条通过。
- `npx vitest run`（`packages/daemon` 第二批 15 个文件，`s47-tools`、`comments`、`supervisor-*`、`schedule-*`、`cli-*` 等）：1 条失败，216 条通过。
- 失败的是 `T/bridge-session-memory.test.ts` 的 `counts each project once…`：普通成员私聊 `memory add --bot` 期望落到自己的记忆，实际被拒。这一片没碰它：在没有 F2 的集成分支上（临时 worktree）跑同一个文件，同样失败。原因是 C1 给私聊记忆的命令行加了 `dmTurn`，D3 的这条测试没跟着改。
- `T/cli-json.test.ts`：2 条通过，150 秒。
- 反证，改完马上还原：去掉跨 Bot 前的 `guard()`（4 条失败）；host 不查位置（4 条失败）；群的读取不带 `only`（1 条失败）；群能指定别的 Bot（1 条失败）；缺权限回复不写名字（2 条失败）。
- lint：`packages/daemon` 没有 lint 脚本，没跑。

全量交给 CI。

### 和计划不一样的地方

- RPC 带 `tool` 和 `args`，不是一个请求一个类型。协议包是 zod 3，daemon 是 zod 4，工具的输入不能共用；daemon 用工具自己的严格输入校验，一处定义。
- `vonvon feishu members` 改走 `command.feishuRead`，`command.listGroupMembers` 在 `parity-allowlist.ts` 记为 superseded，网页还在用。群里的 `members` 命令现在要这一轮还在。
- `runFeishu` 改名 `runFeishuGroups`。
- 私聊的读取一律经 host，当前 Bot 自己读也多一跳本机 IPC。这样路由和"列出别的 Bot"只有一份，工具和命令行不会不一样。
- "第一个绑定的 Bot"取第一个在运行的：排在前面的 Bot 停了，不该挡住后面在运行的。都没运行时才回答没在运行。
- `scopeReply` 和 `apiRefusalOf` 在所有情况都写 Bot 的名字，不只是跨 Bot 时：回复在读取的进程里生成，它不知道是谁问的。
- `denial.ts` 多了一个 `not-in-chat`。列别的 Bot 的是 `scope`、`not-shared`、`not-in-chat` 三种，比设计说的"文档没权限"宽：缺权限和不在群里也是换个 Bot 可能就行。
- `feishu_doc_edit` 没有 `bot`：设计只说读取和 `feishu_api`。
- 群的命令行读取要这一轮还在，比工具严：工具的调用本来就在一轮之内，命令行可能留到回合之后。
- 私聊的命令行不写群时回答"要写 chat"。工具默认是这个私聊，命令行不默认：`--bot` 换了 Bot，这个私聊对它没意义。
- `feishu_api` 不写 `bot` 时在本进程调，不经 host，也不列别的 Bot：F7 的 guard 要紧贴请求；设计列别的 Bot 只说读取，能改东西的调用不该提示换一个 Bot 重试。
- `feishu_api` 写别的 Bot 时 guard 在 IPC 之前，答案丢了说"不知道生效没有"。这是跨进程躲不开的，`ctx.commit` 的"紧贴"在这里只到 IPC 为止。
- 新增 `tools.acrossBots`（Codex 工具表要知道给不给 `bot`）、`SessionTokens.session()`、`FeishuReader.isThisBot`。F7 的 `ApiRequest.bot` 和 `thisBot` 删了：路由在工具这一层。
- 跨 Bot 下载存到共用的 `paths.inboundDir`，私聊是完全访问，读得到。
- IPC 时限：host 到 Bot 68 秒，Bot 到 host 69 秒，都在 `feishu_api` 的 60 秒之上。
- `T/cli-json.test.ts` 补了集成分支上漏的 `memory people` 样例（C1 带来的），样例多了 18 条，时限从 180 秒放到 240 秒。

### 还没验过的项

- 真飞书：这一片没发飞书请求，跨 Bot 只在假的 client 和 IPC 上跑过。
- 真的两个 Bot 进程之间转发：`executeFeishuRead`、`executeFeishuApi` 没有 supervisor 级的测试，IPC 两端是分别测的。
- 真的私聊回合里跑 `vonvon feishu`：只用真 CLI bundle 跑到"daemon 不在"这一步，命令行逻辑是进程内测的。
- Mac、Windows 上的行为。

### 独立审查结论

待 Codex 审查

### 记录

Mac 检查次数 0；等 owner 0；等额度 0。
