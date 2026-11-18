# cli-2-bot 计划：Bot 的启用、停用、移除、重新扫码和卡片回调（C2）

2026-11-01，Claude 写，计划和代码同一个 PR（`devices.md` 第 13 节）。总设计是 `docs/plans/devices.md` 第 8.1、8.2 节 C2 一行和第 13 节 C2 一行；约定照 `docs/plans/cli-1-conventions.md`（下称 C1）。C2 到 C8 七份计划一起写，共用改动的分工见本文 4.6。行号按集成分支 `claude/devices-integration` 0e5be4a1，以后会漂，按函数名找。路径缩写：`D/` = `packages/daemon/src/`，`P/` = `packages/protocol/src/`，`U/` = `packages/ui/src/`，`T/` = `packages/daemon/test/`。

## 1. 做什么

用户看得到的变化：网页 Bot 页上"启用 / 停用""移除 Bot""重新扫码""卡片回调：我已配置 / 撤销确认"这几件事，终端里都能做：`vonvon bot enable|disable|remove|rescan`、`vonvon bot callback status|confirm|unconfirm`；`vonvon bot status` 里原来写"在网页里点「启用 Bot」"的几步，改成直接给出要运行的命令。依赖：C1（#617，已合入）。本片还带三处 C3 到 C8 都要用的小改动（4.6），所以建议最先合入。

## 2. 范围

做：
- 7 条新命令（第 4.1 节表），从白名单挪掉 5 个 kind：`command.setAgentEnabled`、`command.deleteAgent`、`command.refreshAgentCredentials`、`admin.cardCallbackStatus`、`admin.confirmCardCallback`。
- `bot add` 和 `bot rescan` 共用一套扫码跟随（`follow()` 改成接起始请求）。
- `bot status` 每一步的动作按类型给命令（`ACTION_COMMAND` 表，4.4）。
- 共用改动（4.6）：入口的数据租约改成"只有点名的命令拿"；`T/cli-json.test.ts` 按叶子命令的完整路径核对样本；`T/cli-parity.test.ts` 的反例不再借用会被删掉的白名单行。

不做（留给的片）：`bot add --json` 和 SIGINT 发 `cancelJob`（C1 已做）；"另一台设备正在扫码"（`jobRunning`）和 60 秒宽限（U3）；`bot status` 里的安装方式和数据目录（挪到 C8 的 `daemon status`，见 4.7）；会话里这些命令的拒绝（服务端按 5.2 判，D4a）；`bot status` 里"去本机环境"和"跳过登录时启动"两步的命令（C7、C8 各填 `ACTION_COMMAND` 的一行）。

## 3. 现在的代码

- `D/cli/index.ts`：`bot` 下只有 `add`、`list`、`status [bot]`、`repair-dir <bot>`；`preAction` 钩子（`program.hook('preAction', …)`）用一长串 `parent === 'service' || (parent === 'bot' && …) || parent === 'group' || …` 判断谁**不**拿数据租约，每加一组命令都要改这一行。
- `D/cli/commands/bot.ts`：`follow(c, io, d, onStop)` 里写死 `c.run({ type: 'registerAgent' })`；`runBotAdd` 处理 TTY、`--json` 事件流、Ctrl-C 先发 `cancelJob`、断线 3/6。`stepLines()` 对 `open` 打链接、`serviceInstall` 打 `vonvon service install`，其余一律"在网页里点「…」（vonvon open）"。`PAUSED_BOT` 叫人点网页的"恢复运行"。
- `D/server/rpc/command.ts`：`setAgentEnabled` 回 `applied`、`activationPending`（要重启才生效）或 `refused(activation_failed)`；`deleteAgent` 回 `applied` 或 `refused(delete_failed)`（Bot 没停用、还在跑时 daemon 拒，文字在 `D/admin/service.ts` `deleteBot`）；`refreshAgentCredentials` 和 `registerAgent` 走同一个 `jobs.startRegistration`（带 `agentId` 就是给已有 Bot 重新扫码）。
- `D/server/rpc/admin.ts`：`cardCallbackStatus` 只读本机记录（`confirmed`、`verifiedAt`、`configuration`），`confirmCardCallback{confirmed}` 是写。
- `U/project-model.ts` `deleteAgentDescription(name, bindings, memories)`：网页移除确认框的那句话。
- `T/cli-json.test.ts`：`sampled` 只取样本参数的前两个词，三层命令（`bot callback status`）会被当成没取样。`T/cli-parity.test.ts` 的"goes red"用例拿 `command.deleteAgent` 做"pending 不带片号"的反例，本片把这一行删了以后用例会报两条。

## 4. 怎么改

### 4.1 命令

| 命令 | RPC（都已有） | `covers` | `--json` 成功 |
|---|---|---|---|
| `bot enable [bot] [--bot]` | `command.setAgentEnabled{enabled:true}`，之后 `snapshot.get` | `command.setAgentEnabled` | `{ok, bot, activation:'active'\|'restartRequired', message?}` |
| `bot disable [bot] [--bot]` | 同上 `enabled:false` | `command.setAgentEnabled` | 同上 |
| `bot remove <bot> [--yes]` | `snapshot.get`、`memory.list{bot}`（只数条数）、`command.deleteAgent` | `command.deleteAgent` | `{ok, removed:{id,name}}` |
| `bot rescan [bot] [--bot]` | `command.refreshAgentCredentials{agentId}`，跟随 `snapshot` 事件；Ctrl-C 发 `command.cancelJob` | `command.refreshAgentCredentials`、`command.cancelJob` | JSON Lines，同 `bot add`：`phase`、`qr`…，最后 `{ok, event:'result', agentId, bot?, setup?, problem?}` |
| `bot callback status [bot] [--bot]` | `admin.cardCallbackStatus` | `admin.cardCallbackStatus` | `{ok, bot:{id,name}, cardCallback}` |
| `bot callback confirm [bot] [--bot]` | `admin.confirmCardCallback{confirmed:true}`，再读一次状态 | `admin.confirmCardCallback` | `{ok, bot:{id,name}, confirmed:true, cardCallback}` |
| `bot callback unconfirm [bot] [--bot]` | 同上 `confirmed:false` | `admin.confirmCardCallback` | `{ok, bot:{id,name}, confirmed:false, cardCallback}` |

`bot` 接 appId 或名字（`pickBot`）；`[bot]` 和 `--bot` 同时给且不同 → 2（和 `bot status` 同一句）。只有一个 Bot 时可以不写，`remove` 例外：`<bot>` 必填。`bot` 字段都是 `withoutAvatar(agent)`。

失败（C1 的形状 `{ok:false, error:{kind,message,reason?,current?,partial?}, exitCode}`）：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错、几个 Bot 没指定、名字找不到 | 2 | — |
| `remove` 没带 `--yes` | 2 | `confirm_required`，`partial: {bot:{id,name,enabled,running}, groups, botMemories?}` |
| daemon 没跑、连不上 | 3 | — |
| `enable/disable` 被 daemon 拒 | 4 | `activation_failed`（daemon 的原文） |
| `remove` 时 Bot 还启用着（CLI 先查快照，不发请求） | 4 | `bot_enabled` |
| `remove` 被 daemon 拒（还在跑、已被别处移除） | 4 | `delete_failed`（daemon 的原文） |
| `rescan` 的各种结局 | 同 `bot add`：扫码失败、在别处被取消、`registration_busy` 1；QR 出来前断线 3、之后 6；Ctrl-C 130 | 同 `bot add` |
| 回复超时（写类带 `unknown`） | 6 | — |

### 4.2 各命令的细节

- **`enable` / `disable`**：一条 RPC。`applied` → 读快照（daemon 回复写请求前已重建快照，C1 第 3 节最后一条），打 `已启用「X」` + `botLine()`；`activationPending` 不算失败：退出 0，`activation:'restartRequired'`，人类输出打 daemon 的那句话（`want()` 今天把它当拒绝，这里单独接）。`enable` 对已启用但崩溃暂停的 Bot 也发（网页的"恢复运行"发的就是 `setAgentEnabled{enabled:true}`，`DiagnosticsPanel.tsx`），所以 `PAUSED_BOT` 改成"…或运行 vonvon bot enable <id>"。对已经是目标状态的 Bot 照样发，daemon 是幂等的。超时文字：`可能已经改了，运行 vonvon bot list 查看。`
- **`remove`**：不交互。没带 `--yes`：连上 daemon 读快照数群绑定、发 `memory.list{scope:{kind:'bot',botId}}` 数 Bot 记忆的活跃条目（失败就不写条数，和网页一样），然后 exit 2，`message` = `deleteAgentDescription(name, groups, memories)` + `确认后加 --yes 再运行一次。`，不发 `deleteAgent`。带 `--yes`：快照里 `enabled` 为真 → exit 4 `bot_enabled`，文字"先运行 vonvon bot disable <id>，等它停下来再移除。"；否则发 `deleteAgent`。`deleteAgentDescription` 从 `U/project-model.ts` 挪到 `P/display.ts`，`U/project-model.ts` 改成 `export { deleteAgentDescription } from '@vonvon/protocol'`，网页的调用不动（同一句话，8.1"命名三处一致"）。
- **`rescan`**：`follow(c, io, d, start, onStop)` 多一个 `start: Command`，`bot add` 传 `{type:'registerAgent'}`，`rescan` 传 `{type:'refreshAgentCredentials', agentId}`；`runBotAdd` 的主体抽成 `runRegistration(kind: 'add' | 'rescan', …)`，两条命令只差起始请求、提示语（"给「X」重新扫码，换一套飞书凭据"）、`expired_token` 时叫人重跑的命令名，以及成功那一行（`✓ 已更新「X」的飞书凭据。`）。非 TTY 不带 `--json` 照旧 exit 2（二维码进日志的理由不变）。
- **`callback`**：`status` 的人类输出两行：`卡片回调：已收到过真实回调（YYYY-MM-DD HH:mm）` / `你已确认配置，还没收到真实回调` / `还没确认`；`开发者后台：已配置（长连接）` / `没配置` / `配成了 <mode>，要改成长连接` / `没检查`（`configuration` 缺省或 `unchecked`）。`confirm`、`unconfirm` 写完再读一次状态，打同样两行。命名照 C2 一行：网页"我已配置 / 撤销确认"对应 `confirm / unconfirm`。

### 4.3 交互和非交互

除 `rescan` 外都不读 stdin、不问问题，非 TTY 照常跑。`rescan` 同 `bot add`：TTY 画二维码；非 TTY 必须 `--json`（输出别进日志）；Ctrl-C 先发 `cancelJob`（最多 5 秒）再 130。`remove` 用 `--yes` 代替确认框。

### 4.4 `bot status` 的动作 → 命令

`stepLines()` 里的 if 链换成一张表，键是 `StepAction['kind']` 的全部取值，一行一个，值是 `(action, bot) => string | undefined`，`undefined` 就退回今天的"在网页里点「…」（vonvon open）"：

```ts
const ACTION_COMMAND: Record<StepAction['kind'], (action: StepAction, bot: string) => string | undefined> = {
  reauthorize: (_a, bot) => `运行 vonvon bot rescan ${bot}`,
  open: a => a.kind === 'open' ? `${a.label}：${a.url}` : undefined,
  enable: (_a, bot) => `运行 vonvon bot enable ${bot}`,
  confirmCallback: (a, bot) => a.kind === 'confirmCallback' ? `运行 vonvon bot callback ${a.confirmed ? 'confirm' : 'unconfirm'} ${bot}` : undefined,
  environment: () => undefined,      // C7 填：运行 vonvon env scan
  codexLogin: () => undefined,
  claudeLogin: () => undefined,
  serviceInstall: () => '运行 vonvon service install',
  serviceSkip: () => undefined,      // C8 填：运行 vonvon service skip
  serviceRecheck: () => undefined,   // C8 填：运行 vonvon service status
};
```

`bot` 用 Bot 的 id（名字可能有空格）。`stepLines` 要多一个 `bot` 参数；`runBotAdd` 里的调用一并传。

### 4.5 权限表（5.2）

本片**不加新 kind**。用到的 kind 在 5.2 已有行，会话里的结果由 D4a/D4b 在服务端判，本片不加 CLI 侧的拒绝：`command.setAgentEnabled / deleteAgent / refreshAgentCredentials / cancelJob` → bot-session ✗（"绑群、建 bot、停服务都在禁区"那一行）；`admin.cardCallbackStatus / confirmCardCallback` → ✗（`admin.*` 一行）；`memory.list`（`remove` 数条数）→ ★。

### 4.6 共用改动（C3 到 C8 都会碰的地方）

本片先做下面三件，代码逐字写在这里：后面的片如果在本片合入前开工，照抄同样的文字，git 合并时两边相同的改动不冲突。

1. **数据租约改成点名**（`D/cli/index.ts` `preAction`）：今天的逻辑是"除了列出来的都拿租约"，C3 到 C8 加的 `dir`、`session`、`usage`、`env`、`provider`、`mcp`、`import`、`context`、`now`、`snapshot` 都得往那一行里加，七片改同一行。改成"只有会自己写数据目录的命令拿"，名单和今天实际拿租约的命令完全一样：

```ts
/** The commands that write the data root themselves, so they hold the data lease (cli-2-bot 4.6); every other command
 * talks to the daemon, or reads files published with tmp + rename, and takes none. */
const LEASED = new Set(['daemon run', 'daemon start', 'daemon stop', 'daemon restart', 'bot repair-dir', 'secrets list', 'secrets set', 'secrets remove']);
program.hook('preAction', async (_command, action) => {
  const path = `${action.parent?.name() ?? ''} ${action.name()}`;
  if (path === 'daemon run') {
    const runControl = control = observeShutdown(Boolean(action.opts().parentControl));
    (await import('../host/crash-guard')).installCrashHandlers({ intent: () => runControl.intent ?? (runControl.requested ? 'stop' : 'running') });
  }
  if (!LEASED.has(path)) return;
  // in a Bot's session secrets list, set and remove only refuse (s23g): before the lease, whose socket a sandbox may forbid
  if (action.parent?.name() === 'secrets' && inBotSession(process.env)) return;
  await mkdir(paths.appDir, { recursive: true, mode: 0o700 });
  lease = await enterDataAccess(paths.appDir);
});
```

   今天 `action.name() === 'run'` 也会命中 `schedule run`（它早一步因为 `parent === 'schedule'` 返回了）；新写法按完整路径判，不再依赖顺序。原来各行上的注释（为什么 `secrets get`、`project`、`memory` 不拿）合并进 `LEASED` 上面的那句。
2. **`T/cli-json.test.ts` 按叶子路径核对样本**：

```ts
const leaves = (await loadCommands()).filter(command => !command.hidden).map(command => command.path);
const sampled = (path: string) => SAMPLES.some(([args]) => path.split(' ').every((word, i) => args[i] === word));
expect(leaves.filter(path => !sampled(path) && !STARTS_A_DAEMON.includes(path))).toEqual([]);
```

3. **`T/cli-parity.test.ts`**：`loose` 反例改用永远留在白名单里的 `library.previous`：`{ ...CLI_PARITY_ALLOWLIST, 'library.previous': { reason: 'pending', note: 'x' } }`，期望 `['library.previous: pending needs the slice that ends it']`。

各片动手时的落点（减少冲突，后合入的片照这里放）：

| 文件 | 规矩 |
|---|---|
| `D/cli/index.ts` | 各片只在自己那组命令的末尾加：C2 在 `bot repair-dir` 后；C3 在 `group bind` 后、新的 `dir` 组紧跟 `group` 组、`project` 组末尾；C4 的 `session`、`usage` 组放在 `schedule` 组之后、`feishu` 组之前；C5 在 `memory branch-merge` 后；C6 在 `settings set` 后，`schedule edit` 的选项改在原处；C7 的 `env`、`provider` 组放在 `feishu` 组之后、`secrets` 组之前；C8 的 `daemon logs` 改在原处，`service skip` 在 `service status` 后，`secrets test` 在 `secrets remove` 后，`mcp`、`import`、`context`、`now`、`snapshot` 放在 `exitAfterJson` 那段注释之前。不再改 `preAction` |
| `D/cli/parity-allowlist.ts` | 各片只删自己那一块里写着自己片号的行。C2、C4、C6、C7、C8 的块里夹着 D1（`dead`）和 U2 的行，删除挨着时 git 会报冲突：后合入的一方两边的删除都保留 |
| `T/cli-json.test.ts` | `SAMPLES` 里各片的新样本加在自己那组样本行的末尾；新组的样本各起一行，按上面 `index.ts` 的顺序 |
| `D/cli/commands/bot.ts` `ACTION_COMMAND` | 各片只改自己那一行（C7 `environment`，C8 `serviceSkip`、`serviceRecheck`） |

### 4.7 和总设计不一样的地方

- **`bot status` 不加安装方式和数据目录**（8.2 C2 一行写了）：这两项是整台设备的，网页放在"运行详情"，C8 的 `daemon status` 改经 RPC 时一起出（`distribution`、`dataPath`），一条命令一处，免得两片读同样的字段。
- **`bot add --json`、SIGINT 发 `cancelJob` 在 C1 做完了**，C2 只剩 8 条。
- **`remove` 要 `--yes`**：网页有确认框，命令行不问问题（8.1），删了找不回来的命令用 `--yes` 代替确认；不带时把网页确认框里的那句话放进失败，AI 读到就知道要不要加。C3 的 `group unbind`、`project remove` 和 C5 的 `memory purge` 同一条规矩。
- **`activationPending` 退出 0**：状态已经存下，只是要重启才按新状态跑，和网页一样当成功提示。
- **`bot enable` 兼做"恢复运行"**：网页本来就是同一个请求。

## 5. 测试

新文件 `T/cli-bot.test.ts`（不往 C1 的 `T/cli-admin.test.ts` 里加，免得和别的片冲突），用注入的 `Daemon` 和假客户端：
- `enable cli_a`：发出 `{type:'setAgentEnabled', agentId:'cli_a', enabled:true}`；回 `applied`、快照里 `enabled:true` → stdout `{"ok":true,"bot":{"id":"cli_a",…,"enabled":true},"activation":"active"}`（main 必败）。
- 回 `activationPending{message:'要重启…'}` → 退出 0、`activation:'restartRequired'`、人类输出就是那句话（main 必败）。
- 回 `refused{code:'activation_failed'}` → `CommandError` refused，`reason:'activation_failed'`（main 必败）。
- `disable` 发 `enabled:false`；两个 Bot 不指定 → bad-args，列出两个 Bot（main 必败）。
- `remove cli_a` 不带 `--yes` → bad-args `confirm_required`，`partial.groups === 2`、`partial.botMemories === 5`，没发 `deleteAgent`（main 必败）。`memory.list` 抛错时 `partial` 里没有 `botMemories`、文字里没有"条 Bot 记忆"。
- `remove cli_a --yes`，快照 `enabled:true` → refused `bot_enabled`，没发 `deleteAgent`；`enabled:false` → 发 `deleteAgent`，`{"ok":true,"removed":{"id":"cli_a","name":"…"}}`；daemon 回 `refused{delete_failed}` → refused，文字是 daemon 的（main 必败）。
- `rescan --json` 非 TTY：起始请求是 `{type:'refreshAgentCredentials', agentId:'cli_a'}`，事件 `phase, qr, result`，不画二维码；不带 `--json` 非 TTY → bad-args；Ctrl-C → 发 `cancelJob` 后 interrupted；`bot add` 的起始请求仍是 `registerAgent`（main 必败，前两条）。
- `callback status`：`{confirmed:true, verifiedAt}` → 第一行"已收到过真实回调"；`configuration.state:'wrong-mode', mode:'webhook'` → "配成了 webhook"（main 必败）。`confirm` 发 `{confirmed:true}` 再读状态，JSON 带 `confirmed:true`（main 必败）。
- `bot status`：一步的动作是 `{kind:'enable'}` → 打 `运行 vonvon bot enable cli_a`，不再有"在网页里点「启用 Bot」"；`reauthorize` → `bot rescan`；`confirmCallback{confirmed:false}` → `bot callback unconfirm`（main 必败）。
- `T/cli-json.test.ts`：`SAMPLES` 加 `[['bot','enable'],3]`、`[['bot','disable'],3]`、`[['bot','remove','x'],3]`、`[['bot','rescan'],3]`、`[['bot','callback','status'],3]`、`[['bot','callback','confirm'],3]`、`[['bot','callback','unconfirm'],3]`；按 4.6 第 2 条核对叶子路径（`bot callback status` 这样的三层命令照算，main 必败）。再加一条：数据目录不存在时跑 `bot enable --json`（退 3），之后数据目录仍不存在；跑 `daemon stop --json` 之后它存在（租约照点名拿）。
- `T/cli-parity.test.ts`：照 4.6 第 3 条改反例；5 个 kind 不在白名单、被 `covers`（main 必败）。
- `U/` 里 `deleteAgentDescription` 原有的测试不动，照样过（只换了出处）。

## 6. 自测和验收

**Linux（JP-VPS，Claude 自测）**：protocol、daemon、ui 的 typecheck、lint、build（ui 只因为那一行 re-export）；上面的测试文件，加上会 import `D/cli/` 的 `T/cli-admin.test.ts`、`T/daemon-cli.test.ts`、`T/cli-secrets.test.ts`、`T/cli-memory-preaction.test.ts`（租约改法的回归）。临时 HOME 和数据目录里手跑 `bot enable/remove x/callback status --json`（没 daemon，退 3，各一行 JSON）。不碰在跑的 daemon。

**集成分支验收时，主会话在验收 daemon（`accept-home2`，Bot 6）上做**（先 `mkdir /tmp/accept-user.d` 拿目录锁、写 owner，核对 `git -C <accept worktree> rev-parse HEAD` 是集成分支的 sha，用完放锁）：
1. `vonvon bot disable <Bot 6> --json` → `bot list --json` 里它 `enabled:false`；`bot enable` 回来，`bot list` 里 `running:true`、`connection` 回到已连接（devices.md C2 验收一行）。
2. `vonvon bot callback status <Bot 6>` 和网页"连接与权限"里卡片回调那一步一致。
3. `vonvon bot rescan <Bot 6>` 出二维码后 Ctrl-C：退出 130，`bot list --json` 的快照里没有在跑的注册任务（devices.md C2 验收一行"Ctrl-C 后任务已取消"）；不扫码。
4. `bot remove` 只跑不带 `--yes` 的那一种，核对文字和网页确认框一致；**不在真 Bot 上带 `--yes`**。

**Mac、Windows**：不需要（纯命令行，没有平台相关的代码；`.cmd` 的退出码 C1 已验）。

## 7. 文档

- `docs/product.md` 3.10 "不开网页也行：…"那句（D0 会按 11 节改写这一段）：本片不改；D0 改写时写"页面上能做的事命令行都能做，`vonvon --help` 列出全部命令"，不逐条列。
- `docs/v1-plan.md` 不改（这一批按 `devices.md` 第 13 节走）。

## 8. 验收要点

1. 7 条命令都有 `--json`，成功一行 `ok:true`；失败的 `exitCode` 和进程退出码一致，`reason` 照 4.1 的表。
2. `bot remove` 不带 `--yes` 一定不发 `deleteAgent`；带了但 Bot 还启用着也不发。
3. `bot rescan` 和 `bot add` 用同一个 `follow()`，非 TTY 规则、Ctrl-C、断线退出码完全一样；起始请求带 `agentId`。
4. `bot status` 里有命令可用的步骤不再叫人去网页点。
5. `preAction` 只有 `LEASED` 名单里的命令拿租约，名单和今天实际拿租约的命令一样；`T/cli-memory-preaction.test.ts` 不变照过。
6. 白名单里没有本片的 5 个 kind；`T/cli-parity.test.ts`、`T/cli-json.test.ts` 绿。
7. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 650 行（不含本计划）：`D/cli/commands/bot.ts` 约 +200（其中 `follow`/`runRegistration` 改造 40、`ACTION_COMMAND` 15），`D/cli/index.ts` 约 +55（含 `preAction` 改写），`P/display.ts` +12、`U/project-model.ts` −10，白名单 −5，测试约 380。
- `preAction` 改写影响所有命令的租约：名单写错会让某条命令该拿不拿（并发写数据目录）或不该拿却拿（沙箱里连不上租约 socket）。测试按"会写数据目录的命令拿、其余不拿"各抽一条核对，`T/cli-memory-preaction.test.ts` 保留。
- `follow()` 多一个参数，`bot add` 的行为不能变：C1 的 `T/cli-admin.test.ts` 里 `bot add` 的用例原样要过。

## 和计划不一样的地方

- **`follow()` 接的是 `{start, purpose, again}`**，不只是起始请求：二维码那一行的用途（"建一个新的飞书应用" / "给「X」换一套飞书凭据"）和叫人重跑的命令（`vonvon bot add` / `vonvon bot rescan <id>`）也随命令变。二维码前已经写了"扫下面的二维码"，所以 `rescan` 的提示语省掉"重新扫码"四个字。
- **QR 出来前断线的那句也换命令名**：除了 `expired_token`，"和 daemon 的连接断了，扫码已经取消。重新运行 …"也写 `vonvon bot rescan <id>`。`bot add` 的文字一字不变。
- **`bot callback` 的 `bot` 字段是 `withoutAvatar(agent)`**（照 4.1"`bot` 字段都是 `withoutAvatar(agent)`"），包含表里写的 `{id, name}`。
- **`stepLines` 导出给测试**：`撤销确认`（`confirmCallback{confirmed:false}`）只出现在已完成的卡片回调一步上，`bot status` 不打已完成步骤的按钮，所以这一行直接测 `stepLines`。
- **"5 个 kind 被 `covers`、不在白名单"放在 `T/cli-bot.test.ts`**，不往 `T/cli-parity.test.ts` 加用例，少碰共用文件；`T/cli-parity.test.ts` 只照 4.6 第 3 条换反例。
- **`T/cli-admin.test.ts` 改了两处期望**：暂停那句的结尾（`vonvon bot enable cli_a`）和卡片回调一步的 `运行 vonvon bot callback confirm cli_a`；`bot add` 的用例原样通过。
- **`remove` 遇到启用中的 Bot**，文字前面加了「X」还启用着：，后面照 4.2。
