# cli-7-environment 计划：本机环境和 Provider（C7）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 8.2 节 C7 一行和第 13 节 C7 一行；约定照 `docs/plans/cli-1-conventions.md`（C1），长任务的 JSON Lines 和 Ctrl-C 照 C1 第 4 节 `bot add --json` 那条；共用改动和落点照 `docs/plans/cli-2-bot.md` 4.6。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2。

## 1. 做什么

用户看得到的变化：网页"本机环境"页上的事都能在终端里做——看 Codex、Claude、lark-cli 装没装、什么版本、登没登录（`vonvon env scan`）；托管安装、更新、卸载（`vonvon env install|update|uninstall`）；Provider 组件的安装和检查（`vonvon env backend …`）；lark-cli 的登录和应用配置（`vonvon env login lark-cli`、`vonvon env profile …`）；取消正在进行的安装或登录（`vonvon env cancel`）；看某个 Provider 有哪些模型（`vonvon provider models`）。`vonvon bot status` 里"去本机环境"那一步直接给出 `vonvon env scan`。依赖：C1（已合入）。

## 2. 范围

做：16 条命令（4.1 表；`env profile init` 另有 `--status`、`--cancel` 两种用法），从白名单挪掉 24 个 kind：`collaboration.providerModels`，以及 `environment.*` 除 `openVerification`（D1 删）以外的全部 23 个。`D/cli/commands/bot.ts` `ACTION_COMMAND` 的 `environment` 一行（C2 4.4）。

不做：替 Codex、Claude 发起登录（vonvon 不发起这两家的登录，`docs/product.md` 3.1，2026-10-28；`env scan` 只显示登没登录、怎么登）；`environment.openVerification`（D1 删）；会话里的权限（5.2：`environment.*` bot-session 全部 ✗，D4a 判）。

## 3. 现在的代码

- 命令行没有环境命令；`bot status` 的"本机环境"一步打"在网页里点「…」（vonvon open）"。
- `P/environment.ts`：
  - 工具（`codex`、`claude`、`lark-cli`）：`scan` → `tools{tools[{tool, installation: missing|managed|external, executable, version, latestVersion, updateAvailable, canUninstall, runtimeStatus?, source?, updateInstructions?, compatibility?}]}`；`install / update{tool}` 起一个安装任务，`toolInstallStatus` → `toolInstall{operation: running{id, tool, update} | succeeded|failed|cancelled{id, message} | null}`；`cancelInstall{operationId}`；`uninstall{tool}`。
  - 登录（只有 lark-cli 用）：`authStatus{tool}` → `auth{state: signedIn|signedOut|unknown, message}`；`startLogin{tool}`、`loginStatus` → `operation{running{id, purpose, url?} | succeeded|failed|cancelled|timedOut{id, message} | null}`；`cancelLogin{operationId}`。
  - lark-cli 的应用配置：`profileList` → `profiles[{name, appId, brand, active, effective?, user?, tokenStatus?}]`；`profileUse{name}`；`profileAdd{name, appId, appSecret, brand, use}`；`profileInit{name}`、`profileInitStatus`、`profileInitCancel{operationId}`（走同一种 `operation`）。
  - Provider 组件：`backendCatalog` → `backends{entries}`；`backendVersion{id}`；`backendInstall{id, update}` → `backendInstall{operationId, attached, replay, omittedBytes?}`，之后 daemon 往这个连接推 `backendInstall` 事件（`P/events.ts`，`{operationId, id, update, item: log{chunk} | done | error{code, message}}`）；`backendInstallStatus{id}`；`cancelBackendInstall{operationId}`；`backendUninstall{id}`；`backendLogin{id, refresh}` → `backendLogin{state: signedIn|signedOut|notRequired|unknown, message, account?}`。
  - 回复里还有 `applied{message}`、`refused{code, message}`。
- `D/server/rpc/environment.ts`：`backendInstall` 把连接挂到安装任务上（`attachBackend(admission, peer)`），所以事件只推给发起或接上的连接。
- `P/collaboration.ts` `providerModels{backend}` → `providerModels{state: ready|unavailable, models, message?}`。
- 网页：`U/management/EnvironmentPanel.tsx`（装了的工具逐个查 `authStatus`；lark-cli 才有登录和应用配置）。
- 隐藏输入：`D/core/terminal-input.ts` `readHidden()`，`secrets set` 已经在用（`D/cli/commands/secrets.ts:38`：TTY 隐藏提示，否则读整个 stdin）。

## 4. 怎么改

### 4.1 命令

`<tool>` 是 `codex | claude | lark-cli`；`<id>` 是 Provider 组件 id（`env backend list` 列出）。

| 命令 | RPC（`environment.…`，另注） | `covers` | `--json` 成功 |
|---|---|---|---|
| `env scan` | `scan`，装了的工具各一个 `authStatus` | `scan`、`authStatus` | `{ok, tools:[…+auth?]}` |
| `env install <tool>` | `install`，轮询 `toolInstallStatus`；Ctrl-C 发 `cancelInstall` | `install`、`toolInstallStatus`、`cancelInstall` | JSON Lines：`{event:'progress', …}`…，最后 `{ok, event:'result', tool, version?}` |
| `env update <tool>` | `update`，同上 | `update`、`toolInstallStatus`、`cancelInstall` | 同上 |
| `env uninstall <tool>` | `uninstall` | `uninstall` | `{ok, message}` |
| `env login lark-cli` | `startLogin`，轮询 `loginStatus`；Ctrl-C 发 `cancelLogin` | `startLogin`、`loginStatus`、`cancelLogin` | JSON Lines：`{event:'url', url}`，最后 `{ok, event:'result', auth}` |
| `env profile list` | `profileList` | `profileList` | `{ok, profiles}` |
| `env profile use <name>` | `profileUse` | `profileUse` | `{ok, message}` |
| `env profile add <name> --app-id <id> [--brand feishu\|lark] [--use]` | `profileAdd`（app secret 隐藏输入或 stdin） | `profileAdd` | `{ok, message}` |
| `env profile init <name>` | `profileInit`，轮询 `profileInitStatus`；Ctrl-C 发 `profileInitCancel` | `profileInit`、`profileInitStatus`、`profileInitCancel` | JSON Lines：`{event:'url', url}`，最后 `{ok, event:'result', message}` |
| `env profile init --status` | `profileInitStatus` | 同上 | `{ok, operation}` |
| `env profile init --cancel` | `profileInitStatus`、`profileInitCancel` | 同上 | `{ok, cancelled:true\|false}` |
| `env backend list` | `backendCatalog` | `backendCatalog` | `{ok, entries}` |
| `env backend version <id>` | `backendVersion` | `backendVersion` | `{ok, id, installed, latest, hasUpdate}` |
| `env backend install <id> [--update]` | `backendInstall` + `backendInstall` 事件；断线重连不做；Ctrl-C 发 `cancelBackendInstall` | `backendInstall`、`backendInstallStatus`、`cancelBackendInstall` | JSON Lines：`{event:'log', chunk}`…，最后 `{ok, event:'result', id, version?}` |
| `env backend uninstall <id>` | `backendUninstall` | `backendUninstall` | `{ok, message}` |
| `env backend check <id> [--refresh]` | `backendLogin{refresh}` | `backendLogin` | `{ok, id, state, message, account?}` |
| `env cancel install\|login\|backend <id>` | 先查状态（`toolInstallStatus` / `loginStatus` / `backendInstallStatus`）拿 `operationId`，再发对应的取消 | `cancelInstall`、`cancelLogin`、`cancelBackendInstall` | `{ok, cancelled:true\|false}` |
| `provider models <codex\|claude>` | `collaboration.providerModels` | `collaboration.providerModels` | `{ok, backend, state, models}` |

失败：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错；`env login` 不是 `lark-cli`；`profile add` 读不到 app secret；`--status --cancel` 同给 | 2 | — |
| 连不上；轮询或等事件时连接断了而任务还没开始 | 3 | — |
| daemon 回 `refused`（已有别的安装在跑、不能卸载、id 不认识…） | 4 | daemon 的 `code` |
| `providerModels` 回 `unavailable` | 4 | `models_unavailable` |
| 任务结束为 `failed` / `cancelled`（在别处取消） / `timedOut` | 1 | `install_failed` / `cancelled` / `timed_out`，文字是任务的 `message` |
| 任务已经开始后连接断了 | 6 | — |
| Ctrl-C | 130 | — |

### 4.2 长任务怎么跟

`D/cli/commands/env.ts` 里一个 `follow()`，四类任务（工具安装、登录、应用配置、组件安装）共用：
1. 发起请求；回 `refused` → 4。
2. 工具安装、登录、应用配置：每秒轮询一次对应的 `…Status`，只认 `id` 等于发起时那个任务的结果（别处又起了一个，不混进来）。人类输出：开始时一行（"正在安装 Codex…"），登录和应用配置有 `url` 时打"在浏览器里打开：<url>"（TTY 再画一个二维码，和 `bot add` 一样用 `qrcode`）；JSON 只在 `url` 变了时打一行 `{event:'url', url}`，状态变了打 `{event:'progress', state}`。
3. 组件安装：先 `c.onBackendInstall()` 挂监听，再发 `backendInstall`；回复里的 `replay` 先按顺序打出（`attached:true` 表示接上了别人起的安装），之后每个事件：`log` → 原样写（人类输出去掉控制字符，JSON `{event:'log', chunk}`），`done` → 成功，`error` → 1（`aborted` 算 `cancelled`）。事件只推给发起的连接，所以不轮询 `backendInstallStatus`；只在连上后发现已有同一组件的安装时（`attached:true`）照样跟。
4. Ctrl-C：先发对应的取消（最多 5 秒），再 exit 130；取消没回也照样 130（C1 的规矩）。
5. 断线：任务已经开始（拿到了 `operationId`）→ 6，文字"安装可能还在进行，运行 vonvon env scan 看。"（登录：`env scan`；组件：`env backend list`）；还没开始 → 3。
6. 不设总超时：安装可能要几分钟；单次轮询用本地档（30 秒）。

非 TTY 不要求 `--json`（输出里没有要藏的东西，和 `bot add` 不同）。

### 4.3 各命令的细节

- **`env scan`**：每个工具一行：`Codex  0.128.0（托管，有新版本 0.129.0）  已登录` / `Claude  没装` / `lark-cli  1.2.3（系统里的，npm）  没登录：运行 vonvon env login lark-cli`。`installation:'external'` 且有 `updateInstructions` 时缩进打出怎么更新。`compatibility` 不兼容时打它的说明。Codex、Claude 没登录时只说"在终端里运行 codex login / claude 登录"（vonvon 不发起）。`authStatus` 某个失败不影响整条命令（`Promise.allSettled`，和网页一样），那个工具的登录状态写"查不到"。
- **`env uninstall`**：只能卸托管安装的（`canUninstall`），否则 daemon 回 `refused`。不要 `--yes`：能重装，网页也没有确认框。
- **`env login lark-cli`**：`<tool>` 写别的 → 2，文字"vonvon 只管 lark-cli 的登录；Codex、Claude 在它们自己的命令行里登录。"。成功后再查一次 `authStatus`，结果放 `auth`。
- **`env profile add`**：app secret 不接受参数（会进 shell 历史和进程列表）：TTY 用 `readHidden('App Secret：')`，非 TTY 读整个 stdin（`printf %s "$SECRET" | vonvon env profile add …`），读到空 → 2。`--brand` 默认 `feishu`。人类输出、JSON、错误里都不出现 secret。
- **`env profile init --status`**：没有在跑的就打"没有在进行的应用配置"，`operation:null`。**`--cancel`**：先查状态拿 `operationId`，没有在跑的 → 退出 0、`cancelled:false`。
- **`env cancel`**：同 `--cancel` 的做法；`backend <id>` 用 `backendInstallStatus{id}` 拿 `operationId`。
- **`env backend list`**：每行 `id  名字  已装 1.2.3 / 没装  可以装`，`hint` 有值时缩进打出。
- **`env backend check`**：`--refresh` 让 daemon 重新检查（网页"重新检测"），不给就读缓存。
- **`provider models`**：`codex` → `codex-appserver`，`claude` → `claude-agent`。每行一个模型。和 C6 的 `settings models` 的区别写进两条命令的帮助：这条是 Provider 自己报的全部模型，那条是某个 Bot 某个用途下拉框里的候选。
- **`bot status` 的动作**：`ACTION_COMMAND.environment = () => '运行 vonvon env scan'`（C2 4.4 的表，只改这一行）。

### 4.4 交互和非交互

`env profile add` 在 TTY 上隐藏提示输入 app secret，非 TTY 读 stdin，从不从参数读。其余命令不读 stdin。长任务在前台跟到结束，Ctrl-C 取消。

### 4.5 权限表（5.2）

不加新 kind。`environment.*` 在 5.2 的 `environment.*、machine.*、admin.*` 一行：bot-session 全部 ✗；`collaboration.providerModels` 在 `collaboration.*` 一行，不是那三个读类，✗。D4a 照表判，本片不加 CLI 侧拒绝。

### 4.6 文件

新 `D/cli/commands/env.ts`（`follow()` 和各 `run…`，约 450 行）、`D/cli/commands/provider.ts`（约 40 行）；`D/cli/index.ts` 的 `env`、`provider` 两组放在 `feishu` 组之后、`secrets` 组之前（C2 4.6 的落点表）。

### 4.7 和总设计不一样的地方

- **`env cancel` 不管应用配置**：8.2 写了 `env cancel` 和 `env profile init --cancel` 两处；只留后者，免得一件事两个命令。`env cancel` 管安装、登录、组件安装。
- **组件安装不轮询状态**：事件已经推到这个连接上，轮询只会重复；`backendInstallStatus` 用在 `env cancel backend <id>` 找 `operationId`。
- **非 TTY 不强制 `--json`**：`bot add` 强制是因为二维码会进日志；这里的链接是一次性的登录页，没有凭据。

## 5. 测试

新文件 `T/cli-env.test.ts`（假客户端，`onBackendInstall` 注入事件；假时钟推进轮询）：
- `env scan --json`：发 `scan`，再对 `installation !== 'missing'` 的工具发 `authStatus`；其中一个 `authStatus` 抛错，整条命令仍成功、那个工具 `auth` 缺省（main 必败）。
- `env install codex --json`：发 `install{tool:'codex'}`，轮询看到 `running{id:'op1'}` → `succeeded{id:'op1'}`；输出 `progress` 行和最后 `{"ok":true,"event":"result",…}`；状态里出现 `id:'op2'` 的别的任务不当成自己的结束（main 必败）。
- 结束为 `failed{message:'网络不通'}` → failed、`reason:'install_failed'`；`refused{code:'busy'}` → refused、`reason:'busy'`（main 必败）。
- Ctrl-C：发 `cancelInstall{operationId:'op1'}` 后 interrupted；拿到 `op1` 之后断线 → outcome-unknown；之前断线 → connection（main 必败）。
- `env login codex` → bad-args，什么都不发；`env login lark-cli --json`：`url` 行只在变化时打（main 必败）。
- `env profile add p1 --app-id cli_x`，stdin 注入 secret：发 `profileAdd{appSecret:<注入值>, brand:'feishu', use:false}`；stdout、stderr 都不含 secret；stdin 为空 → bad-args（main 必败）。
- `env profile init --cancel`：状态 `null` → 退出 0、`cancelled:false`、没发取消；`running{id}` → 发 `profileInitCancel{operationId:id}`（main 必败）。
- `env backend install cbridge --json`：先挂监听再发请求（顺序断言）；`replay` 两行先打，事件 `log`、`done` → 成功；事件 `error{code:'aborted'}` → failed、`reason:'cancelled'`；别的 `operationId` 的事件不打（main 必败）。
- `env cancel backend cbridge`：先 `backendInstallStatus{id}` 再 `cancelBackendInstall`（main 必败）。
- `provider models claude`：发 `providerModels{backend:'claude-agent'}`；`unavailable` → refused `models_unavailable`（main 必败）。
- `bot status` 一步动作 `{kind:'environment'}` → 打 `运行 vonvon env scan`（main 必败）。
- `T/cli-json.test.ts` 加 16 行样本；`T/cli-parity.test.ts`：24 个 kind 不在白名单。

## 6. 自测和验收

**Linux（JP-VPS）**：daemon 的 typecheck、lint、build；`T/cli-env.test.ts`、`T/cli-admin.test.ts`、`T/cli-bot.test.ts`（C2 合入后）。

**集成分支验收时，主会话在验收 daemon 上做**（拿目录锁、核对 sha、用完放锁）：
1. `vonvon env scan` 和网页"本机环境"一致（工具、版本、登录状态）。
2. `vonvon env backend list`、`vonvon env backend check <一个已装的组件>` 和网页一致。
3. `vonvon env profile list` 只看，不改。
4. `vonvon provider models codex` 和网页 Provider 模型列表一致。
5. 安装类只做取消路径：在验收 daemon 上不装新东西；如果有可以更新的工具，`env update <tool>` 开始后 Ctrl-C，退出 130，`env scan` 显示没在安装（devices.md C7 验收一行的 Linux 部分）。
6. `env login lark-cli` 只到出链接，然后 Ctrl-C（不用 owner 的账号登录）。

**Mac**：托管安装和组件安装在 macOS 上走的路径不同（`D/` 里的安装脚本按平台分），集成分支验收时请 Mac 上的 Codex 在隔离的数据目录里跑一次 `env install lark-cli` 到成功、`env uninstall lark-cli`（devices.md C7 验收一行"真装一次"）。**Windows**：同样一次 `env install lark-cli`，归 D 线的 Windows 验收（Windows Codex）。

## 7. 文档

- `docs/product.md`：本片不改（D0 统一写）。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 16 条命令都有 `--json`；长任务是 JSON Lines，最后一行有 `ok`。
2. 长任务只认自己的 `operationId`；Ctrl-C 先取消再 130；开始后断线是 6。
3. app secret 只来自隐藏输入或 stdin，任何输出里都没有。
4. `env login` 只接受 `lark-cli`。
5. `bot status` 的"本机环境"一步给出 `vonvon env scan`。
6. 白名单里没有本片的 24 个 kind。
7. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,280 行：`env.ts` +460，`provider.ts` +40，`index.ts` +110，`bot.ts` 1 行，白名单 −24，测试约 650。超过 1,500 时拆：C7a（工具、登录、应用配置、`env cancel`）和 C7b（`env backend`、`provider models`），C7b 在 C7a 后合入。
- 长任务的测试依赖时间：用假时钟和注入的轮询间隔，不 `sleep`。
- 真装要联网、改这台机器：Linux 自测不真装；真装只在 Mac、Windows 的隔离数据目录里做。

## 和计划不一样的地方

- **工具安装按回复定结局**：daemon 对 `install` / `update` 请求要等安装结束才回（`D/environment/service.ts` `install()` 返回整个安装的 promise），回复里没有任务 id。请求不设超时，结局只看它的回复；轮询里的状态只用来打进度和 Ctrl-C 时取消，哪个状态是自己的靠请求号认（审查后改，见下一节"任务 202"）。
- **协议加一个可选字段 `requestId`**（4.5 说不加新 kind，kind 确实没加）：`install`、`update`、`backendInstall` 三个请求可以带；daemon 记在它为这次请求开始的任务上，`toolInstallStatus` 的任务（进行中和结束后）、`backendInstallStatus` 的任务里原样带回。接到别人已经开始的组件安装（`attached`）不改它。字段两头都可选：旧的网页和桌面不带照样能用；旧 daemon 的请求 schema 是 strict 的，会回 `invalid_request`，命令行这时去掉字段再发一次（没开始任何任务，重发安全；已经 Ctrl-C 就不重发）。
- **失败的 `reason` 分开写**：工具安装、组件安装是 `install_failed`；登录是 `login_failed`，应用配置是 `profile_init_failed`（4.1 表里都写 `install_failed`，登录失败读成"装失败"会误导脚本）。
- **登录和应用配置共用一个状态**：轮询看到别的 id，说明自己的已经结束、又开始了别的，结果没看到：退 6，文字同断线那句。
- **Ctrl-C 时还不知道 id**：工具安装再读一次状态，组件安装用 `backendInstallStatus{id}`（所以 `env backend install` 的 `covers` 里的 `backendInstallStatus` 确实用到），只认带着这次请求号的任务；找不到就不发取消、直接 130，文字说任务如果开始了会继续进行、怎么看、怎么取消。只有 Ctrl-C 后查找还没结束时到的组件安装回复（不是 `attached`、带着这次请求号）才补发取消；查找结束以后才到的回复不再处理，命令已退 130，文字照上面说任务会继续进行（独立核对的 P3：计划原先写"5 秒之内到了就补发取消"，代码没这样做，按代码改计划）。
- **JSON Lines 多几个字段**：`progress` 行带 `operationId`；组件安装的 `progress` 行还带 `attached`、`omittedBytes`；`env install` 的结果行多 `message`（daemon 的原话）；`env profile use / add` 的成功行多 `profiles`（daemon 回的就是新列表）。
- **`env scan` 多打两种说明**：Claude 装了但 `--version` 失败；Codex 比验证过的版本新（`compatibility.status: newer`）。
- **组件安装的输出**：人类输出里 `\r\n`、单独的 `\r` 都当换行，其余控制字符去掉；最后一段没换行时先补一个，结果另起一行。
- **"24 个 kind 被 `covers`、不在白名单"放在 `T/cli-env.test.ts`**（同 C2 的做法），`T/cli-parity.test.ts` 不改。`T/cli-admin.test.ts`、`T/cli-bot.test.ts` 里"在网页里点「去本机环境」"的三处期望改成 `运行 vonvon env scan`。
- **`settings models` 的帮助加一行**，说明和 `provider models` 的区别（4.3 说两条命令的帮助都写）。

## 审查后改了什么

Codex 审查（#628 任务 201）两条 P2，都改在四类长任务共用的 `track()` / `follow()` 里。

- **busy 被别人的结果改成成功**（`env install` / `env update`）：原来请求回 `refused` 后再读一次状态，只要状态的 id 不是开始前那个，就把它的结束当成自己的；另一个调用者在这期间装完，busy 就变成了退出 0。改成：工具安装的结局只看自己请求的回复，轮询读到的结束一律不算（状态不说是谁起的）。`applied` → 成功；`install-cancelled` → `cancelled`（1）；`install-failed`、`install-incomplete`、`install-not-selected`、`npm-missing`、`explicit-codex` 这几种只有开始了的安装才会回（`performInstall`）→ `failed`（1，`install_failed`）；其余（`busy` 等）是开始前就被拒 → 4，`reason` 是 daemon 的 code。
- **Ctrl-C 等取消时，断线或轮询失败盖掉 interrupted**（四类都有）：原来第一次 Ctrl-C 后，断线的 `onError` 会先结束成 `lost`（6），正在飞的轮询失败会先 `fail`。改成：第一次 Ctrl-C 之后，只有取消有了回复（含因断线失败）、5 秒上限到了、第二次 Ctrl-C 这三件能结束，结局都是 interrupted（130）；断线、轮询或请求失败、任务自己的结束都不再结束它；轮询停下，不再读也不再打进度；第二次 Ctrl-C 时清掉 5 秒的计时。
- **测试**（`T/cli-env.test.ts`，在改之前的代码上都失败）：busy 后状态里是别人的成功、别人同工具的安装先被轮询认领又先结束再收到 busy → 都是 4；四类任务各跑四种交错：认领后 Ctrl-C、取消回复前断线 → 130；Ctrl-C 时有请求在飞、它随后失败 → 130 且之后不再读；第二次 Ctrl-C → 立即 130 且第一次之后不再读；取消一直不回 → 假时钟下 4999 ms 还没结束、5 秒时 130，期间不再读。组件安装没有轮询，"第二次 Ctrl-C""取消不回"两种在原代码上本来就对，留作回归。测试桩的 `drop()` 改成和真客户端一样：先让在飞的请求失败，再报连接错误。

Codex 复查（#628 任务 202）一条 P2 和两条 P3。

- **P2：凭"新 id、同工具、同 update"认领，Ctrl-C 会取消别人的安装**（`env install` / `env update`，组件安装 Ctrl-C 前的查找也一样）：本次请求其实被拒 busy、回复还没到时，轮询先看到另一个调用者刚开始的同工具安装，就把它当成自己的，打出它的进度；这时 Ctrl-C 发的是对方 `operationId` 的取消。改成从源头证明归属：命令行每个长任务用 `crypto.randomUUID()` 生成一个请求号，放进开始请求的 `requestId`；daemon 把它记在这次请求开始的任务上，状态里带回（见上一节"协议加一个可选字段"）。命令行只认领、只打进度、只取消 `requestId` 等于自己的任务；`find()` 同样的规则。登录和应用配置的开始回复本来就带着这次开始的任务，不用改。组件安装：回复 `attached:false` 是自己开始的，照旧跟、Ctrl-C 取消；`attached:true` 是别处开始的，照旧跟着打输出，Ctrl-C 只退出（130），不取消，文字说它会继续、怎么取消。被拒（busy）的请求什么都不认领。旧 daemon（不带回 `requestId`）：不猜，不打进度，Ctrl-C 不发取消，直接 130 并说明安装如果开始了会继续；结局仍按请求的回复。
- **P3 a：5 秒取消上限之后还要等关闭握手**（最多再 1 秒）：`withDaemon` 遇到 interrupted 的失败时，关闭连接最多等 200 毫秒，不再等 daemon 回关闭帧（失败时 `index.ts` 本来就直接退出）。别的失败和成功照旧等关闭完成。
- **P3 b：自己的安装开始后回 `environment-closed` 之类被算成 refused（4）**：看到过带自己请求号的 `running` 之后，安装请求回的任何 `refused`（`install-cancelled` 除外）都算失败（1，`install_failed`）；没看到过的照旧按 code 分。
- **前两条修复保持不变**：工具安装的结局只看自己请求的回复；第一次 Ctrl-C 之后只有取消有回复、5 秒上限、第二次 Ctrl-C 能结束，都是 130。
- **测试**（在改之前的代码上都失败）：`T/cli-env.test.ts`：审查者的场景，install 和 update 各一遍——busy 回复延迟、轮询先看到别人带别的请求号的 `running`、Ctrl-C → 不发任何 `cancelInstall`、130、没有进度行；busy 先到 → 4、没有进度行；自己的任务（带自己请求号）→ 进度行和用自己 id 的取消，Ctrl-C 早于轮询时 `find()` 按请求号找到；旧 daemon（拒收字段后重发、或收了不带回）→ 没有进度、结局照回复、Ctrl-C 不发取消且说会继续；自己的安装开始后回 `environment-closed` → 1，没开始 → 4；取消不回且关闭握手不结束 → 5.2 秒内 130；组件安装接上别人的、Ctrl-C 前状态里是别人的或没有请求号的 → 不发取消；旧 daemon 拒收字段 → 去掉后重发、回复里的任务照样能取消。`T/environment-rpc.test.ts`：请求号留在开始的任务上，另一个调用者被拒 busy 后状态不变，取消后的状态也带着。`T/server-jobs.test.ts`：组件安装的请求号经 socket 进来、`attached` 不改它、`backendInstallStatus` 带回。`packages/protocol/test/protocol.test.ts`：三个开始请求带不带都能解析、不是 uuid 不行、别的请求不能带；状态带不带都能解析。原有用例里工具安装的状态改成带请求号，开始前那次状态读取去掉了（不再需要）。
