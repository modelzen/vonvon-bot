# cli-8-machine 计划：MCP、旧版导入、登录时启动、日志、状态和诊断（C8）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 8.2 节 C8 一行、8.3 节第一行（`daemon logs`、`daemon status` 读文件）和第 13 节 C8 一行；约定照 `docs/plans/cli-1-conventions.md`（C1）；共用改动和落点照 `docs/plans/cli-2-bot.md` 4.6，`METHODS` 照 `docs/plans/cli-3-groups.md` 4.6。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2。

## 1. 做什么

用户看得到的变化：
- 网页"本机 → MCP"能在终端里列、加、删 Codex 和 Claude 的 MCP 服务（`vonvon mcp`）。
- 从旧版 bridge 导入能在终端里做（`vonvon import …`，只在有旧版 bridge 的 Mac 上有东西可导）。
- "跳过登录时启动"用 `vonvon service skip`。
- `vonvon daemon logs` 和 `vonvon daemon status` 在 daemon 跑着时问 daemon，`daemon logs --follow` 能一直跟着看。
- `vonvon context show` 看"模型看到什么"，`vonvon secrets test` 试一次某个密钥，`vonvon now` 看 Bot 此刻在做什么、在关注哪些群，`vonvon snapshot --json` 拿到网页用的完整状态。
- `vonvon bot status` 里"跳过登录时启动""重新检测"两步直接给命令。

依赖：C1（已合入）；C2 的 `ACTION_COMMAND` 表和 C3 的 `METHODS` 一行（没合入就照抄，见 9）。

## 2. 范围

做：
- 13 条新命令和 2 条改走 RPC 的命令（4.1 表）。
- 从白名单挪掉 12 个 kind：`machine.mcp.list / add / remove`、`machine.bridgeImport.detect / preflight / start / status / rollback`、`machine.setServiceSkipped`、`admin.followLogs`、`contextPreview.get`，以及原来标 `superseded` 的 `admin.logs`（改由 `daemon logs` 用，4.2）；`machine.logs` 反过来标 `superseded`。
- `ACTION_COMMAND` 的 `serviceSkip`、`serviceRecheck` 两行（C2 4.4）。

不做：
- 单独的 `refresh` 命令（4.6）；
- `update`（I3）；
- `machine.service start|stop`、`startHost`（desktop-only，白名单不动）；
- 会话里的权限（5.2：`machine.*`、`admin.*` 除 `daemonStatus`、`negotiate` 外 bot-session ✗，`contextPreview.get` ✗，D4a 判）。

## 3. 现在的代码

- `D/cli/commands/daemon.ts`：
  - `runStatus()` 读文件，输出 `source:'files'`（`daemon.ts:173` 注释写着"经 RPC 的答复（C8）标 `source:'daemon'`"）。
  - `runLogs(tail)` 读日志文件尾部，输出 `source:'files'`；`daemon logs` 注册时 `covers('machine.logs')`（`index.ts:97`），但并不发它。
- `D/server/rpc/admin.ts:38`：`logs{maxBytes}` 读 1 KB 到 256 KB；`followLogs{follow}` 之后 daemon 往这个连接推 `log{lines}` 事件（`P/events.ts`）。`D/server/rpc/machine.ts:42` 的 `machine.logs` 固定 64 KB。
- `P/admin.ts` `daemonStatus` → `{distribution?, platformName?, installed, running, selfHosted, pid?, lastExit?, version, uptimeMs?, servicePath?, stdoutPath?, stderrPath?, supported}`；快照的 `application` 有 `dataPath`、`version`、`platform`、`crashes`。
- `P/mcp.ts`：
  - 请求：`list{provider}`、`add{provider, name, revision, config: stdio{command, args, env?} | http{url, bearerTokenEnvVar?}}`、`remove{provider, name, revision}`。
  - 回复：`{provider, configPath, revision, status: ready|unavailable|conflict, cliAvailable, message?, changed?, entries[{name, transport, command?, argumentCount?, urlOrigin?, envNames, headerNames…}]}`。只回名字，不回值。
- `P/machine.ts`：`bridgeImport{action: detect|preflight|start|status|rollback, acceptedChanges?: true}`（`start` 没有 `acceptedChanges` → `invalid_request`，`D/server/rpc/machine.ts:28`），回复 `{detection, preflight, view{txId, step, bots, notes, error?, cleanupPending, canRollback}}`；`setServiceSkipped{skipped}` → `done{message}`。
- `P/context-preview.ts`：`get{agentId, place: group{groupId} | comment, threadId?}` → `preview{running, next{sections, items, tools}, session?{threadId, legacy, redeliverDue, sections, lastTurn?}, judge?}`。
- `P/admin.ts`：`testSecret{keyId}` → `secretTested{keyId, outcome: ok|auth|busy|network|timeout|failed, message, status?}`；`secrets set` 存完已经试一次（`D/cli/commands/secrets.ts` `testText`）。
- 快照 `agents[].diagnostics`（`P/diagnostics.ts`）：`activities`（每群在做什么：`processing / thinking / tool / responding / compacting / waiting / retrying`）、`decisions`、`attention`（每群主区聚焦 / 旁观、话题数、间隔）、`latestAction`。网页的"此刻"就是读这些。

## 4. 怎么改

### 4.1 命令

| 命令 | RPC | `covers` | `--json` 成功 |
|---|---|---|---|
| `mcp list --provider <codex\|claude>` | `machine.mcp{list}` | `machine.mcp.list` | `{ok, provider, configPath, revision, status, entries}` |
| `mcp add <name> --provider <p> (--command <cmd> [--arg <a>]… [--env NAME=VALUE\|NAME]… \| --url <url> [--bearer-env <NAME>])` | `machine.mcp{list}`（拿 revision）、`machine.mcp{add}` | `machine.mcp.add` | `{ok, provider, changed, entries}` |
| `mcp remove <name> --provider <p>` | `list`、`machine.mcp{remove}` | `machine.mcp.remove` | `{ok, provider, changed, entries}` |
| `import detect` | `machine.bridgeImport{detect}` | `machine.bridgeImport.detect` | `{ok, detection}` |
| `import preflight` | `…{preflight}` | `machine.bridgeImport.preflight` | `{ok, preflight}` |
| `import start [--accept]` | `…{preflight}`（预览）、`…{start, acceptedChanges:true}`，轮询 `…{status}` | `machine.bridgeImport.start`、`machine.bridgeImport.status` | JSON Lines：`{event:'step', step}`…，最后 `{ok, event:'result', view}` |
| `import status` | `…{status}` | `machine.bridgeImport.status` | `{ok, view}` |
| `import rollback` | `…{rollback}`，轮询 `status` | `machine.bridgeImport.rollback` | 同 `start` |
| `service skip [--undo]` | `machine.setServiceSkipped{skipped}` | `machine.setServiceSkipped` | `{ok, skipped, message}` |
| `daemon logs [--tail n] [--follow]`（改） | 跑着：`admin.logs{maxBytes}`，`--follow` 再 `admin.followLogs` + `log` 事件；没跑：读文件 | `admin.logs`、`admin.followLogs`（去掉 `machine.logs`） | `{ok, source, text}`；`--follow` 时 JSON Lines `{event:'log', lines}` |
| `daemon status`（改） | 跑着：`admin.daemonStatus` + `snapshot.get`；没跑：读文件 | 同今天（`admin.daemonStatus`） | `{ok, source:'daemon'\|'files', …}` |
| `context show (--group <g>\|--comment) [--session <t>] [--bot]` | `contextPreview.get` | `contextPreview.get` | `{ok, preview}` |
| `secrets test <name>` | `admin.testSecret` | `admin.testSecret` | `{ok, keyId, outcome, message}` |
| `now [--bot]` | `snapshot.get` | `snapshot.get` | `{ok, bots:[{id, name, activities, attention, latestAction?, decisions}]}` |
| `snapshot` | `snapshot.get` | `snapshot.get` | `{ok, snapshot}`（Bot 头像去掉） |

失败：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错（`mcp add` 两种都给或都没给、`--env` 名字不合法、`--env NAME` 而环境里没有它；`--group`、`--comment` 不是正好一个；`secrets test` 名字不认识） | 2 | — |
| `import start` 没带 `--accept` | 2 | `confirm_required`，`partial: {preflight}` |
| 连不上；会话里 `daemon logs`、`daemon status` 而 daemon 没跑；`--follow` 时 daemon 停了 | 3 | — |
| MCP 回 `status:'unavailable'`；导入的 `view.step` 是 `refused` | 4 | `mcp_unavailable` / 导入的 `error.code` |
| 会话里的 `secrets test` | 4 | `not_in_session`（`secrets` 今天的拒绝） |
| MCP 回 `status:'conflict'`（配置文件刚被别处改过） | 5 | `conflict` |
| `secrets test` 的 `outcome` 不是 `ok`、`busy`；导入结束为 `rolled-back`、`rollback-failed` | 1 | `outcome` / `step` |
| 写请求超时、断线 | 6 | — |
| `--follow`、`import start` 时 Ctrl-C | 130 | — |

### 4.2 各命令的细节

- **`mcp add`**：
  - 先 `list` 拿 `revision`。
  - `--env NAME=VALUE` 直接用；`--env NAME`（不带 `=`）从命令行的环境变量里取值，环境里没有 → 2。这样密钥可以不出现在参数里。
  - `--bearer-env` 只写环境变量名（协议本来就只存名字）。
  - `--arg` 可重复，保持顺序。
  - 名字按 `P/mcp.ts` 的 `name` 校验。
  - 人类输出：`已加到 Codex 的配置（<configPath>）`，再列一次全部条目。条目只有名字、命令和变量名，没有值（协议不回值）。
- **`mcp list`**：每行 `名字  stdio  命令（N 个参数）  环境变量：A、B`，或者 `名字  http  https://host`。`cliAvailable:false` 时加一行"没找到 codex 命令，配置照样能改，装好后生效"。
- **`import detect / preflight`**：
  - `detection:null` → "这台设备上没有找到旧版 bridge"，退出 0。
  - `preflight` 把要导入的 Bot、会改的东西（`notes`）逐条列出。
- **`import start`**：
  - 不带 `--accept`：发 `preflight`，exit 2 `confirm_required`，`partial.preflight` 是将要发生的变化，文字"导入会停掉旧版 bridge，把它的 Bot 和群搬过来。看完上面的变化，加 --accept 再运行一次。"——和网页"确认导入后的变化"那一步一样，先看再做。
  - 带了：发 `start{acceptedChanges:true}`，每秒轮询 `status`，`step` 变了打一行（人类输出用网页的中文步骤名），直到 `done`、`rolled-back`、`rollback-failed`、`refused`。
  - Ctrl-C：导入没有取消请求，中途停会留下半截，所以 Ctrl-C 不停导入：打"导入在后台继续，运行 vonvon import status 查看。"，exit 130。
- **`import rollback`**：`canRollback:false` → 4 `cannot_rollback`，不发。跟随方式同 `start`。
- **`service skip`**：发 `setServiceSkipped{skipped:true}`；`--undo` 发 `false`。人类输出是 daemon 的那句（"已跳过登录时启动。"/"已取消跳过。"）。
- **`daemon logs`**：
  - 连得上：`admin.logs{maxBytes: min(256 KB, max(1 KB, tail × 400))}`，取最后 `tail` 行，`source:'daemon'`。
  - 连不上：今天的读文件，`source:'files'`。会话里连不上就 exit 3，不读文件（同 C3 `project list`、C5 的理由）。
  - `--follow`：先打最后 `tail` 行，再 `followLogs{follow:true}`，`c.onLog()` 每来一批写一批（人类输出去掉控制字符）。daemon 关了 → exit 3"daemon 停了"。Ctrl-C 尽量发 `followLogs{follow:false}`（最多 1 秒），然后 130。`--follow` 没有 daemon → 3（文件没法"跟"新写的进程）。
  - 读文件的回退不支持 `--follow`。
- **`daemon status`**：
  - 连得上：`admin.daemonStatus` 加快照的 `application{dataPath, version, platform, crashes}`，人类输出在今天的几行后加 `安装方式：standalone / npm / 桌面端`（`distribution`）和 `数据目录：…`（C2 4.7 挪过来的两项），`source:'daemon'`。
  - 连不上：今天的读文件。会话里同上，不回退。
- **`context show`**：
  - 人类输出两栏：
    - "下一次新会话会拿到"：每段一行 `身份 1,234 字`、`Bot 记忆 12 条`……，外加 `工具：…`；
    - "这条会话上次拿到"：每段一行版本是否过期（`stale` → "下一轮会换新的"），`redeliverDue` → "压缩过，下一轮全部重给"。
  - `lastTurn` 有值时再打"上一轮注入 N 条，模型说用了 M 条"。
  - `--session` 不给时 daemon 取这个群最近用过的会话（协议注释）。
- **`secrets test`**：
  - 名字和 `secrets set` 同一套（`service(name)` → `keyId`）。会话里先 `refuseInSession()`（同 `secrets list/set/remove`）。
  - 输出 `message`，退出码见 4.1：`busy` 说明密钥本身是对的，只是服务忙，退出 0。
  - 不拿数据租约（只走 RPC）：不进 `LEASED`。
- **`now`**：每个 Bot 一段，每个有动静的群一行 `研发群：思考中（2 分钟）`、`研发群：在调工具（3 个）`；`activities` 里 `updatedAt` 早于 `BOT_ACTIVITY_STALE_MS` 的标"（可能卡住了）"；再一行"关注：研发群 主区聚焦、2 个话题在看"；`latestAction` 在 `BOT_LATEST_ACTION_SHOWN_MS` 以内时打"刚刚：在 研发群 回复了"。没有任何活动 → "都闲着"。`--bot` 只看一个。
- **`snapshot`**：`--json` 打完整快照（Bot 头像的 data URL 去掉，和别的命令一样用 `withoutAvatar`）。不带 `--json` 只打摘要（版本、几个 Bot、几个群、有没有问题）和一行"完整内容加 --json"。
- **`ACTION_COMMAND`**：`serviceSkip: () => '运行 vonvon service skip'`、`serviceRecheck: () => '运行 vonvon service status'`。

### 4.3 交互和非交互

不读 stdin、不提问。`import start` 用 `--accept`，对应网页的确认那一步。长任务（`import start/rollback`、`daemon logs --follow`）在前台跟，`--json` 时是 JSON Lines。

### 4.4 权限表（5.2）

不加新 kind。会话里（D4a 判）：`machine.*`、`admin.*` 一行 ✗，只放 `admin.daemonStatus`（所以会话里 `daemon status` 能用，快照部分按 `filterSnapshot` 只含自己的 Bot）；`contextPreview.get` 在 `directory.*、library.*、contextPreview.get` 一行，✗；`snapshot.get` 过滤。`now`、`snapshot` 在会话里看到的是过滤后的快照，不用另做。

### 4.5 文件

- 新 `D/cli/commands/mcp.ts`、`import.ts`、`context.ts`、`now.ts`。
- `daemon.ts`（logs、status 改走 RPC）、`secrets.ts`（`runSecretsTest`）、`service.ts`（`runServiceSkip`）、`bot.ts`（两行）。
- `index.ts` 的落点见 C2 4.6 的表：`daemon logs` 在原处改，`service skip` 在 `service status` 后，`secrets test` 在 `secrets remove` 后，`mcp`、`import`、`context`、`now`、`snapshot` 放在 `exitAfterJson` 那段注释之前。
- 白名单：删本片 11 个 `pending('C8', …)` 行；`admin.logs` 的 superseded 行删掉；加 `'machine.logs': { reason: 'superseded', note: 'admin.logs (daemon logs; it takes maxBytes)' }`。

### 4.6 和总设计不一样的地方

- **没有单独的 `refresh`**：C1 已经给 `bot list`、`bot status`、`group list` 加了 `--fresh`（先发 `command.refresh`），8.2 的 `refresh` 只剩"刷新但不看结果"，没有用处（C1 4 节已记）。
- **`daemon logs` 改用 `admin.logs`**：它能带 `maxBytes`，`--tail` 才有意义；`machine.logs` 固定 64 KB，改标 superseded。
- **`import start` 的 Ctrl-C 不取消**：协议没有取消导入的请求，导入中途停会留下半截，回滚另有 `import rollback`。
- **`daemon status` 补安装方式和数据目录**：从 C2 挪过来（C2 4.7）。
- **会话里不读日志、状态文件**：同 C3 4.7。

## 5. 测试

新文件 `T/cli-mcp.test.ts`、`T/cli-import.test.ts`、`T/cli-machine.test.ts`（`daemon logs/status`、`service skip`、`context show`、`secrets test`、`now`、`snapshot`）：
- `mcp add gh --provider codex --command npx --arg -y --arg gh-mcp --env TOKEN`（注入的环境里 `TOKEN=x`）：先 `list` 拿 `revision:'r1'`，再 `add{revision:'r1', config:{transport:'stdio', command:'npx', args:['-y','gh-mcp'], env:{TOKEN:'x'}}}`；stdout 不含 `x`。环境里没有 `TOKEN` → bad-args、没发 `add`（main 必败）。
- `--command` 和 `--url` 同给 → bad-args；回复 `status:'conflict'` → conflict（main 必败）。
- `import start` 不带 `--accept`：只发 `preflight`，bad-args `confirm_required`、`partial.preflight`；带了发 `start{acceptedChanges:true}`，轮询到 `step:'done'` 成功；`rolled-back` → failed、`reason:'rolled-back'`；Ctrl-C → interrupted、没有别的请求（main 必败）。
- `import detect` 回 `detection:null` → 退出 0、人类输出"没有找到旧版 bridge"（main 必败）。
- `service skip --undo`：发 `setServiceSkipped{skipped:false}`（main 必败）。
- `daemon logs --tail 50`：连得上 → 发 `admin.logs{maxBytes:20000}`、输出最后 50 行、`source:'daemon'`；连不上 → 读文件、`source:'files'`；会话环境里连不上 → connection、没读文件（main 必败）。
- `daemon logs --follow --json`：发 `followLogs{follow:true}`，注入两次 `log` 事件 → 两行 `{event:'log'}`；连接关闭 → connection；Ctrl-C → 发 `followLogs{follow:false}` 后 interrupted（main 必败）。
- `daemon status --json`：连得上 → `source:'daemon'`、带 `distribution`、`dataPath`；连不上 → 今天的输出不变（main 必败）。
- `context show --group 研发`：发 `contextPreview{type:'get', agentId, place:{kind:'group', groupId}}`；`--comment` → `place:{kind:'comment'}`；两个都给 → bad-args（main 必败）。
- `secrets test typesafe`：`outcome:'busy'` → 退出 0；`outcome:'auth'` → failed、`reason:'auth'`；会话环境 → refused `not_in_session`、没连 daemon（main 必败）。
- `now`：快照里一个 `thinking` 的活动、`updatedAt` 早于 60 秒 → 那一行带"（可能卡住了）"；没有活动 → "都闲着"（main 必败）。
- `snapshot --json`：Bot 没有 `avatarDataUrl`；不带 `--json` 只打摘要（main 必败）。
- `bot status` 一步动作 `{kind:'serviceSkip'}` → `运行 vonvon service skip`（main 必败）。
- `T/cli-json.test.ts` 加 13 行样本；`T/cli-parity.test.ts`：11 个 pending kind 和 `admin.logs` 都不在白名单（`admin.logs` 被 `daemon logs` covers），`machine.logs` 在白名单、标 superseded。

## 6. 自测和验收

**Linux（JP-VPS）**：daemon 的 typecheck、lint、build；上面三个测试文件和 `T/daemon-cli.test.ts`、`T/cli-secrets.test.ts`、`T/service-cli.test.ts`。临时数据目录里没有 daemon 时手跑 `daemon status --json`、`daemon logs --json`（`source:'files'`）。

**集成分支验收时，主会话在验收 daemon 上做**（拿目录锁、核对 sha、用完放锁）：
1. `vonvon daemon status --json` 是 `source:'daemon'`，安装方式和数据目录和网页"运行详情"一致。
2. `vonvon daemon logs --follow`，用 lark-cli 在测试群发一句话，日志里出现新行；Ctrl-C 退出 130（devices.md C8 验收一行）。
3. `vonvon mcp list --provider codex` 和网页 MCP 列表一致；`mcp add c8-check --provider codex --command echo` 再 `mcp remove c8-check`，网页同步变化，最后配置文件和开始时一样。
4. `vonvon context show --group <测试群>` 和网页"模型看到什么"一致。
5. `vonvon now`：在测试群 @Bot 6 后马上跑，看到"思考中"或"在调工具"。
6. `vonvon secrets test typesafe` 只在 Jev 的 key 已经存进验收 daemon 时跑（不打印、不贴 key）。
7. `vonvon service skip` 不在验收 daemon 上跑（会改它的登录启动）；只跑 `bot status`，看动作一行给出命令。

**Mac**：导入只在 Mac 上有东西可导。集成分支验收时，请 Mac 上的 Codex 在隔离的 HOME 和数据目录里，照 `T/import-bridge-preflight.test.ts` 的做法摆一份假的旧版 bridge 目录，跑 `import detect / preflight / start --accept / status / rollback`。**不碰 owner 的 bridge 和它的数据**，提示词里原样写明。`service skip` 在隔离的数据目录里跑一次，`service status` 显示已跳过。

**Windows**：`daemon logs --follow`、`service skip` 归 D 线的 Windows 验收。（owner 2026-11-01：Windows 上不做只装服务端，这一批 Windows 上没有注册的 `vonvon`，这条不做；发给 Windows 的任务只有 U4 和 Windows 桌面端当被连的设备的检查，见 `devices.md` 第 19 节。）

## 7. 文档

- `docs/product.md`：本片不改（D0 统一写）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 13 条新命令有 `--json`；`daemon logs/status` 在 daemon 跑着时 `source:'daemon'`，会话里不读文件。
2. `mcp add` 的密钥值能从环境变量来，不出现在输出里。
3. `import start` 不带 `--accept` 只预览；Ctrl-C 不中断导入。
4. `--follow` 在 daemon 停掉时 exit 3，Ctrl-C 130。
5. `secrets test` 在会话里拒绝，`busy` 算成功。
6. 白名单：本片 11 个 pending 行没了，`admin.logs` 被覆盖，`machine.logs` 标 superseded。
7. `bot status` 的"跳过登录时启动""重新检测"两步给出命令。
8. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,150 行：
- `mcp.ts` +130，`import.ts` +150，`context.ts` +90，`now.ts` +90；
- `daemon.ts` +120，`secrets.ts` +35，`service.ts` +20，`bot.ts` 2 行，`index.ts` +110；
- `daemon-client.ts` 1 行（C3 的 `METHODS`，C3 先合入就不用）；
- 白名单 −12 +1；
- 测试约 600。

超过 1,500 时拆：C8a（`mcp`、`import`、`service skip`）和 C8b（日志、状态、`context`、`secrets test`、`now`、`snapshot`），C8b 后合入。

风险：
- `daemon logs --follow` 挂着连接：Ctrl-C 和 daemon 关闭两条路都要关连接，测试里断言进程不挂住（`client.close()` 被调用）。
- 导入会停掉旧版 bridge：验收只在隔离 HOME 和假目录里做。
- `now` 依赖诊断字段，字段缺省（旧 daemon）时整段跳过，不报错。

## 和计划不一样的地方

- **找 daemon 时只读文件**：`connectLocal` 靠子进程跑 `daemon status --json` 找 daemon，`daemon status` 改走 RPC 后会绕回自己。所以 `P/client` 的 `transport-local.ts` 给这个子进程加了环境变量 `VONVON_STATUS_FROM_FILES=1`，带了它 `daemon status` 照旧读文件。`T/client` 加了一条用例（main 必败），`T/daemon-cli.test.ts` 在真 daemon 上核对了 `source:'daemon'`。
- **`daemon status --json` 的形状**：保留今天读文件的那些字段（`running`、`pid`、`listen`、`paused`、`pausedBots`、`crashes`，时间都是 ISO），再加 `source`、`version`、`distribution`、`dataPath`、`platform`、`uptimeMs` 和 `service{installed, supported, …}`。人类输出的"安装方式"多一个"开发目录"（`development`）。
- **`T/daemon-restart.test.ts` 跟着改了**：`runStatus` 改成接 `io`，用例里注一个连不上的 daemon，走读文件那条路，期望不变。`T/cli-admin.test.ts` 里"跳过"一步的期望改成 `运行 vonvon service skip`。
- **`daemon logs --follow` 去重**：daemon 跟日志的第一批是今天文件末尾最多 16 KB 的重放。已经打过的尾巴不论在重放里面，还是比重放长，都不再打一遍（`afterPrinted`，按整行比）。`--json` 的第一行 `{event:'log'}` 就是那段尾巴。读文件的回退照旧（`tail × 200` 字节）。
- **`mcp add/remove` 先按列表查名字**：已有的名字再 `add`、没有的名字 `remove`，退出码是 2，列出现有的名字，不发请求（不等 daemon 回 conflict 5）。`cliAvailable:false` 那一行写成"没找到 X 的命令行：配置能看，加和删要先装好它。"，因为 daemon 这时回 `unavailable`，改不了（4 `mcp_unavailable`）。
- **`import start` 预检不过**：`canImport:false` 时，不带 `--accept` 也是 4 `preflight-refused`，不是 2。`import rollback` 跟到 `rolled-back` 算成功，退出 0。`detect` 回 `not-found` 时和 `null` 一样，都打"没有找到"、退出 0。
- **`now` 的"可能卡住了"**：用活动的 `observedAt`（最近一次心跳，和网页一样），没有时才用 `updatedAt`。
- **`snapshot --json`**：Bot、群和成员关系的头像都去掉。
- **`secrets test` 失败的提示**：`auth` 提示 `vonvon secrets set <id>` 换一个 key，其他失败提示稍后 `vonvon secrets test <id>`。
- **`T/cli-json.test.ts` 多了两条反例**：`mcp add` 两个都不给（2）、`context show` 不给群（2）。`T/cli-parity.test.ts` 加了一条用例：本片的 kind 都被覆盖，`machine.logs` 标 superseded，`daemon logs` 有 `--follow`。

## 审查后改了什么

Codex 审查（任务 203）两条 P2、一条 P3：

- **P2 导入的 Ctrl-C 没盖住首个回复，等状态时出错会盖掉中断** → 新文件 `P/daemon/src/cli/interrupt.ts`（`interrupts`）：第一次 Ctrl-C 就定下结果 130，经它等的请求（`until`）当场结束，之后 daemon 回什么、超时还是断线都不改结果；`stop` 摘掉处理器。`import start --accept` 和 `import rollback` 在发 `start`、`rollback` 之前装上，整个跟随共用一个：首个回复没到时 Ctrl-C 也是 130 加"导入在后台继续"，`--json` 有最后一行错误；等状态时 Ctrl-C 不再等满 30 秒。每秒一次的停顿随 Ctrl-C 结束，不留计时器。连上 daemon 之前（还没发请求）的 Ctrl-C 照旧由 Node 处理，和其他一来一回的命令一样。
- **P2 日志 Ctrl-C 后等退订时断线，130 变成 3** → `daemon logs --follow` 从第一个请求（读尾巴）起用同一套：Ctrl-C 后断线、请求失败都还是 130，之后来的日志不再打印；等退订最多 1 秒，第二次 Ctrl-C、断线或请求失败当场结束；1 秒的计时器、日志和断线的监听在结束时都摘掉。读尾巴时按 Ctrl-C 也是 130，不再发 `follow:true`。
- 两处一样：结果定下、处理器摘掉以后（命令在关连接，最多 1 秒），再按 Ctrl-C 由 Node 处理，立即退出。
- 本片别的命令：只有 `import start/rollback` 和 `daemon logs --follow` 有轮询或订阅；`now`、`snapshot`、`context show`、`secrets test`、`service skip`、`mcp`、`daemon status` 都是一来一回，没有改。
- **P3 PR 描述试用步骤 3 的 MCP 写法** → PR 描述已改成 `--provider codex --command echo`，代码不用改。
- 新测试（改前都失败）：`T/cli-import.test.ts` 两条，首个回复没到时 Ctrl-C（start 和 rollback），等状态时 Ctrl-C 之后断线、超时或 daemon 不回；`T/cli-machine.test.ts` 两条，Ctrl-C 后退订没回时断线或请求失败，第二次 Ctrl-C 当场结束和读尾巴时 Ctrl-C。
