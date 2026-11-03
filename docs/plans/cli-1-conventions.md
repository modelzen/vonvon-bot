# cli-1-conventions 计划：命令行的统一约定和对齐测试（C1）

2026-10-31，Claude 写并实现，计划和代码同一个 PR（`devices.md` 第 13 节）。总设计是 `docs/plans/devices.md` 第 8.1、8.5、12 节和第 13 节 C1 一行。行号按集成分支 `claude/devices-integration` 9020ba38，以后会漂，按函数名找。路径缩写：`D/` = `packages/daemon/src/`，`P/` = `packages/protocol/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

用户看得到的变化：每条命令都能加 `--json`，输出形状一样，失败时退出码说清是哪类错；`bot add --json` 能在脚本里跑；`bot list`、`bot status`、`group list` 加 `--fresh`；`memory list --all` 把已归档的也列出来。对开发者：命令注册时声明它覆盖哪些 RPC（`covers`），对齐测试保证以后加 RPC 忘了加命令 CI 就红。依赖：无。D1、D3、I3 依赖这一片（SLICE-1）。

## 2. 范围

做：
- 全部命令 `--json`，成功 `{ "ok": true, ...payload }`，失败 `{ "ok": false, "error": { "kind", "message", ... }, "exitCode" }`；去掉 `structured` 名单，失败一律经 `D/cli/command-error.ts`。
- 退出码：2 参数错、3 连不上 daemon、4 被拒绝、5 冲突、6 结果不明、1 未预期，加 130 被中断（Ctrl-C）。
- `covers` 元数据、`P/rpc-kinds.ts` 枚举全部 kind、`D/cli/parity-allowlist.ts`、`T/cli-parity.test.ts`；白名单先登记 `device.*`、`admin.negotiate` 和 `update`（`machine.checkCoreUpdate/applyCoreUpdate/coreUpdateStatus`）。
- `bot add --json`（JSON Lines）、`--fresh`、`memory list --all`、本地读文件的命令标 `source: 'files'`。

不做（留给的片）：会话里本地命令一律 exit 4 和全局 `--scope`（5.3，授权那几片）；新命令（C2 到 C8）；`memory --bot` 接名字（C5 改走 RPC 时一起做）；`daemon status` 经 RPC（C8）；`vonvon update`（I3）；`docs/product.md`（D0）。

## 3. 现在的代码

- `D/cli/index.ts`：命令树和入口在一个文件。`structured = ['settings','feishu','schedule']`（:16-19）才 `exitOverride` 和打 JSON 失败；其余命令失败打 stderr、`process.exit(1)`。只有 `daemon status`、`service status`、`bot list/status/repair-dir`、`group *`、`project list`、`memory *`、`settings *`、`schedule *`、`feishu *` 有 `--json`。
- `D/cli/command-error.ts`：`CommandError(kind, message, current?)`；不是 `CommandError` 的错误一律算 `bad-args`（2）。
- `D/cli/daemon-client.ts`：`print(io, human, json)` 原样打 JSON，没有 `ok`；`translate()` 只认 `unauthorized/forbidden` 是拒绝。
- `D/cli/commands/bot.ts` `runBotAdd`：非 TTY 一律拒（:165）；Ctrl-C 写"已取消扫码。"、`exitCode(130)`；断线都退 1。`runBotStatus` 清单读不全时先打成功的 JSON、再退 1。
- `memory.ts`、`secrets.ts`：拒绝用 `ctx.warn` + `ctx.exit(2)`，会话里的拒绝也是 2；`memory` 冲突和拒绝退 1。`secrets list` 读不了 key 时打成功 JSON 再退 1。
- `service.ts`、`daemon.ts`（`stop/restart/logs/start`）、`open.ts`：只有文字输出。`feishu.ts` 的人类输出就是一行 JSON。
- daemon 每个写请求回复前都重建快照（`D/server/http.ts` `finish()` 里 `snapshots.rebuild`），读到的快照不会落后于自己的写。

## 4. 怎么改

1. **`P/rpc-kinds.ts`**：`rpcKinds()` 从 `requestSchema` 枚举 `method.type`。`schedule` 取 `request.action`；`settings.read/save` 按 `scope.kind`、`settings.act` 按 `action`、`machine.mcp/service/bridgeImport` 按子请求展开（`settings.save.host` 归 C6、`machine.service.start` 是 desktop-only，和同一 type 的别的变体去向不同）。共 152 个。
2. **`D/cli/command-error.ts`**：`CommandError(kind, message, { reason?, current?, partial? })`。`reason` 是机器可读的原因（daemon 的错误码、`not_in_session`、`expired_token`、服务结果 `install_refused` 等），`current` 是冲突时的现值，`partial` 是失败前读到的东西（`--json` 只打一行，所以放进失败里）。`rpcErrorKind(code)`：第 12 节的拒绝码（`permission_denied`、`scope_required`、`session_token_missing`、`not_in_session`、`not-dm`、`desktop_not_running`、`client_revoked`、`pairing_failed`、`rate_limited`，加旧的 `unauthorized/forbidden`）→ 4；`protocol_mismatch`、`device_identity_changed` → 3；`conflict` → 5；`outcome_unknown` → 6；`invalid_request` → 2；其余 1。commander 的用法错误 → 2；别的未知错误 → 1（以前是 2）。参数错一律显式 `badArgs()`。
3. **`D/cli/index.ts`**：所有命令都 `exitOverride`；`--json` 时 commander 不往 stderr 写。`covers(command, ...kinds)` 记在 `WeakMap`，`commandList()` 导出每个叶子命令的路径、是否隐藏、`covers`、选项，给测试用。入口统一处理失败：`--json` 打失败 JSON 到 stdout，先设 `process.exitCode`，在写回调里 `process.exit`（macOS 的管道是异步写，直接 exit 会截断；失败时数据租约没释放，不能等事件循环自己结束）；否则照旧 `console.error` 后 `process.exit`，只是退出码按类别。`daemon run` 的退出码规则不变。
4. **各命令**：`daemon start/stop/restart/logs`、`open`、`service install/uninstall`、`secrets set/remove` 加 `--json`。`print()` 统一加 `ok: true`。参数错改 `badArgs`（`group`、`settings`、`schedule`、`feishu`、`pickBot/pickGroup`、cron 解析）。会话里的拒绝（`memory` 写、`secrets`、`schedule`）→ 4 + `reason: 'not_in_session'`。冲突带 `current` → 5。先打结果再失败的（`bot status` 清单读不全、`secrets list` 读不了 key、`service` 失败）：人类输出照旧先打再报错；`--json` 不打成功行，放进 `error.partial`。`settings access`、`feishu` 的人类输出改成一行一项。
5. **`bot add --json`**：每行一个 JSON：`{event:'phase',…}`、`{event:'qr', url, expiresAt, status?}`（链接或状态变了才打），最后 `{ok:true, event:'result', agentId, bot?, setup?, problem?}` 或失败行。非 TTY 加了 `--json` 不再拒；不加照旧拒（exit 2），提示用 `--json`。Ctrl-C 照旧先发 `cancelJob`，然后 exit 130；QR 出来前断线 3、之后 6；扫码失败、在别处被取消、daemon 拒绝（`registration_busy`）照旧 1，带 `reason`。
6. **`service install/uninstall --json`**：一行 `{ok, action, result, detail, retained, restarted?, restartError?, leftovers?, notes}`；Linux 的 linger 和打开网页的说明进 `notes`，不问问题（等于非终端），不打带凭据的链接。
7. **`--fresh`**：先发 `command.refresh {tools:true}` 再读。**`memory list --all`**：人类输出带上已归档的，标"已归档"。**`source`**：`daemon status`、`daemon logs`、`project list`、`memory list/export` 标 `files`；`secrets` 标 `daemon` 或 `files`（看实际走了哪条路）。
8. **白名单**（`D/cli/parity-allowlist.ts`）：每条 `{ reason, note, slice?, arrives? }`。`reason` 在设计的 client-only / desktop-only / internal 之外加 superseded（被已覆盖的 kind 取代）、unused（声明了但没有客户端发）、dead（daemon 回 unsupported，`slice` 删）、pending（`slice` 加命令）。`arrives` 表示协议里还没有、由那一片加。45 个 kind 由命令覆盖，107 个在白名单，另 9 个 `arrives: 'D1'`。

### 和总设计不一样的地方

- **写完不发 `command.refresh`**：daemon 回复写请求前已经重建快照（第 3 节最后一条），再发一次只多一次工具探测。`--fresh` 照做。C8 的独立 `refresh` 命令变成可有可无：`command.refresh` 已被 `--fresh` 覆盖。
- **白名单原因多四种、加 `slice`/`arrives`**，见第 4 节第 8 条；`settings.read/save` 和 `machine.*` 的子请求也展开（设计只说 `settings.act` 和 `schedule`）。
- **退出码多一个 130**（被中断），**失败的 `error` 里多 `reason`、`partial`** 两个字段。
- **`bot add` 不加 `--json` 时非 TTY 照旧拒**（设计写"非 TTY 不再拒绝"，指的是 `--json`）：没有 `--json` 时二维码字符画和链接会进日志。
- **`open --json` 只给地址，不给带凭据的链接**：本机凭据不过期，和配对链接不一样。
- **`bot add --json` 在 C1 做完**，C2 那一行的 `bot add --json` 不再做。
- 退出码变了的（脚本要注意）：未知命令和缺子命令 1 → 2；`bot`、`group` 连不上 daemon 1 → 3；`memory`、`secrets` 在会话里 2 → 4；`memory` 冲突 1 → 5、拒绝 1 → 4；`bot add` 断线 1 → 3 或 6；`pickBot` 找不到 Bot 在 `bot`、`group` 下 1 → 2。

## 5. 测试

- `packages/protocol/test/rpc-kinds.test.ts`（main 必败）：名字不重复；都以 `method.type` 开头；抽样有 `settings.read.host`、`machine.service.start`、`schedule.listBot` 等；被展开的父名不出现；方法集合等于 `requestSchema` 的。
- `T/cli-parity.test.ts`（main 必败）：协议的每个 kind 被覆盖或在白名单，不能两样都有；`covers` 里没有协议外的 kind；`arrives` 的 kind 不在协议里，其余都在；pending/dead 必带 `slice`。红的检查：去掉 `daemon stop` 的 `covers`、加一个 `command.nope`、白名单和 `covers` 重复、协议里出现 `device.pair`、pending 不带 slice，各自报对应的一条。`device.*`、`admin.negotiate` 都 `arrives: 'D1'`，`update` 三个 kind pending I3。除 `daemon run` 和隐藏命令外每个叶子命令都有 `--json`；`bot list/status`、`group list` 有 `--fresh`，`memory list` 有 `--all`。
- `T/cli-json.test.ts`（main 必败）：esbuild 打出入口，临时 HOME 和数据目录、没有 daemon，43 条命令各加 `--json` 跑一遍：退出码对；stderr 为空；stdout 正好一行合法 JSON；`ok` 和退出码一致，失败行带同样的 `exitCode` 和 `error.kind/message`。每个可见叶子命令要么在样本里，要么在"会起 daemon"的豁免里（`daemon run/restart`、`open`）。
- `T/cli-admin.test.ts`：`bot add --json` 非 TTY 照跑，事件 `phase, qr, qr, result`，不画二维码（main 必败）；断线前后 3 和 6（main 必败）；Ctrl-C 抛 `interrupted`；`bot status --json` 清单读不全时 stdout 为空、内容在 `partial`（main 必败）。
- `T/memory-cli.test.ts`：会话里写 → refused + `not_in_session`（main 必败）；冲突 → conflict 带 `current`、`memory-full` → refused、`bad-args` 原因 → bad-args（main 必败）；`--all` 才列已归档，JSON 带 `source: 'files'`（main 必败）。
- `T/cli-secrets.test.ts`：会话里 refused 4（main 必败）；`list --json` 读不了时 stdout 空、列表在 `partial`（main 必败）；`set --json`、`remove --json` 的形状（main 必败）；参数错 bad-args、Ctrl-C interrupted。
- `T/service-cli.test.ts`：`--json` 一行带 Linux 说明、失败时 `partial` 带 `leftovers`、stdout 空（main 必败）。
- `T/daemon-cli.test.ts`：未知命令 2、`bot/group` 连不上 3、`secrets` 会话里 4、`{"ok":true,"bots":[]}`（main 必败）。`s47-cli`、`schedule-cli` 的 JSON 加 `ok: true`。

## 6. 自测和验收

**Linux（JP-VPS，Claude 自测，已做）**：protocol 的 build、typecheck、lint、全部测试；daemon 的 typecheck、build；上面列的测试文件和别的会 import `D/cli/` 的测试；手工把 `daemon stop` 的 `covers` 去掉跑 `T/cli-parity.test.ts` 变红、恢复变绿；用临时 HOME 手跑 `daemon status/logs`、`project list`、`secrets list`、`service status/uninstall`、`memory list`、`secrets set` 的 `--json`。全部命令都不碰在跑的 daemon 和真实数据。

**交给 Mac 上的 Codex，集成分支验收时做**（Linux 的管道是同步写，测不出）：
1. 停掉测试 daemon，`vonvon bot list --json > out.txt; echo $?`：3，`out.txt` 正好一行。
2. 测试 daemon 在跑、日志较大时 `vonvon daemon logs --tail 2000 --json | wc -c` 两次结果相同、`JSON.parse` 成功（输出没被截断）。
3. `vonvon bot add --json > add.txt`，看到 `qr` 行后按 Ctrl-C：退出码 130，最后一行 `"kind":"interrupted"`；不扫码，不建飞书应用。

**交给 Windows 上的 Codex（D 道）**：`vonvon.cmd bot list --json` 在 daemon 没跑时 `%ERRORLEVEL%` 为 3、PowerShell `ConvertFrom-Json` 能解析；`vonvon.cmd nope` 为 2。确认 `.cmd` 包装把退出码传出来。（owner 2026-11-01：Windows 上不做只装服务端，这一批 Windows 上没有注册的 `vonvon`，这条不做；发给 Windows 的任务只有 U4 和 Windows 桌面端当被连的设备的检查，见 `devices.md` 第 19 节。）

## 7. 文档

- `docs/product.md` 不改（这一批的产品文档改动在 D0）；命令行约定以 `devices.md` 8.1 和本计划为准，各命令的 `--help` 写了新选项。
- `docs/v1-plan.md` 不改（这一批按 `devices.md` 第 13 节走）。
- 官网说明文档（`devices.md` 第 10 节）以后写到命令行时，按本计划第 4 节的形状和退出码写。

## 8. 验收要点

1. 任何命令加 `--json`：stdout 只有 JSON（`bot add` 一事件一行），最后一行有 `ok`；失败行的 `exitCode` 等于进程退出码；`--json` 下 commander 的用法错误不写 stderr。
2. 退出码按第 2 节；参数错都是 `badArgs`，会话里的拒绝是 4 带 `not_in_session`，冲突 5 带 `current`。
3. 先打结果后失败的命令，`--json` 下不出现两行，也不出现 `ok:true` 后退非 0。
4. `T/cli-parity.test.ts` 在去掉任一条唯一的 `covers` 时变红；白名单每条有原因，pending/dead 有片号，`device.*`、`admin.negotiate`、`update` 已登记。
5. `bot add --json` 不画二维码、不打带控制字符的文本；`open --json` 不含本机凭据。
6. 人类输出除第 4 节写明的（`settings access`、`feishu` 改成逐行，`bot add` 的"已取消扫码。"挪到 stderr）外不变。
7. `daemon status --json` 只多 `ok`、`source` 两个字段（`CL/transport-local.ts` 是非严格解析，桌面端和脚本只读字段）。
8. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,310 行代码和测试（不含本计划）：`D/cli/` 源码约 830（其中 `index.ts` 220、白名单 148），`P/` 约 90，测试约 390。
- 退出码变了，依赖"失败就是 1"的脚本要改（第 4 节"和总设计不一样的地方"最后一条列全了）；仓库里的脚本和桌面端只看 0 和非 0，或只读 `daemon status --json` 的字段，不受影响。
- `--json` 失败时入口在写回调里 `process.exit`：被测试替身吞掉回调时不退出，只留 `process.exitCode`（`T/schedule-cli.test.ts` 依赖这一点）。人类输出的失败照旧 `console.error` 加 `process.exit`（`T/daemon-stop-retained-lock.test.ts` 依赖这一点）。
- `T/cli-parity.test.ts` 和 `T/cli-json.test.ts` 在进程内加载 `D/cli/index.ts` 时把 `process.argv` 换成 `--version`（入口加载即解析命令行）；`T/cli-json.test.ts` 起 43 个进程，约 35 秒。
