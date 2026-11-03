# cli-3-groups 计划：建群、改群、解绑、选文件夹和项目（C3）

2026-11-01，Claude 写，计划和代码同一个 PR。总设计是 `docs/plans/devices.md` 第 8.2 节 C3 一行、8.3 节第一行（`group bind` 的本地 `stat`、`project list` 读文件）和第 13 节 C3 一行；约定照 `docs/plans/cli-1-conventions.md`（C1）；共用改动和落点照 `docs/plans/cli-2-bot.md` 4.6（C2 4.6）。行号按集成分支 `claude/devices-integration` 0e5be4a1。路径缩写同 C2：`D/`、`P/`、`U/`、`T/`。

## 1. 做什么

用户看得到的变化：网页上"新建群""群设置里的启用 / 会话方式 / 文件夹 / 换项目""解绑""浏览文件夹""项目改名、删除、改工作区"都能在终端里做：`vonvon group create|set|unbind|show`、`vonvon dir list|suggest`、`vonvon project rename|remove|workspace`。`vonvon group bind` 不再要求 `--folder`（不写就用默认文件夹），能用 `--project` 加入已有项目；它不再在命令行这台机器上查文件夹在不在，改由 daemon 判（远程设备上的路径只有 daemon 那台机器知道）。`vonvon project list` 在 daemon 跑着时问 daemon。依赖：C1（已合入）；C2 的 4.6 先合入最好，不先合入就照抄那几处。

## 2. 范围

做：
- 9 条新命令、`group bind` 两个新选项、`project list` 改走 RPC（4.1 表），从白名单挪掉 9 个 kind：`collaboration.createProject / project / editProject / removeProject`、`directory.list / suggest`、`library.workspace / rename / delete`。
- daemon 一处修正：`D/server/directory-browser.ts` `canonical()` 把 `ENOENT`、`ENOTDIR`、`ELOOP` 变成 `RpcError('invalid_directory', '找不到这个目录，请检查路径。')`（今天原样抛出，经 `getRpcErrorCode` 成了 `operation_failed`，网页显示"操作失败"）。
- CLI 把 `invalid_directory`、`outside_home`、`invalid_folder_token` 当参数错（exit 2）：`D/cli/command-error.ts` `rpcErrorKind` 加一个 `BAD_ARGS` 集合。
- `D/cli/daemon-client.ts` 两处共用：`METHODS` 加 `library`、`memory`、`contextPreview`（4.6）；新的 `runningBot()`（4.6，C4 也用）。

不做：会话里谁能建群、改群（D4a/D4b 按 5.2 判；本片不加 CLI 侧拒绝）；建群时选决策模型 `judge`（建好后 `settings set --group … judge.selection=…`，4.7）；"完全访问"警告改用 U2 的 `TierInfo.warning`（U2 做，本片先放第 15 节原文）；网页的"上次的项目"（`library.previous`，白名单里是 unused，不动）。

## 3. 现在的代码

- `D/cli/commands/group.ts` `runGroupBind`：`--folder` 必填（`index.ts` 里 `requiredOption`），把 `~` 和相对路径按命令行这台机器展开，再 `stat()` 一次（`group.ts:95-99`，8.3 说的绕过）；然后 `directory.choose{path}` 拿 `folderToken`，发 `command.bindGroup{folder:{kind:'existing'}}`。`CONVERSATIONS` 把 `multi/single/smart` 对成 `threads/shared/smart`。
- `D/cli/commands/project.ts` `runProjectList`：只读文件（`libraryOverview()`），输出带 `source:'files'`。
- `P/collaboration.ts`：`createProject{agentId,name,folder,project?,tool,conversation,judge?,response?}`；`project / editProject{expectedRevision, folderToken?, project?, conversation?, enabled?} / removeProject{expectedRevision}` 都带 `target = {agentId, projectName, groupId}`；回复 `project{project}`、`applied{project?, groupEffect?, warning?, message?}`、`refused{code,message}`。
- `D/server/rpc/collaboration.ts`：`createProject` 先把 `folderToken` 解成路径；建群成功但没存下 → `RpcError('created_unsaved')`，别的意外 → `RpcError('outcome_unknown')`。
- `P/directory.ts`：`list{path?}`、`suggest{query}`、`choose{path}`；`D/server/directory-browser.ts` 限在 daemon 用户的主目录里（`outside_home`）。
- `P/library.ts`：`list`、`workspace{projectId, revision, workspace{primary, additional, repositories?}}`、`rename{projectId, revision, name}`、`delete{projectId, revision}`；`D/admin/library.ts` 删除还有群在用的项目抛 `AdminWriteError`（→ `conflict`）。
- `D/cli/daemon-client.ts` `METHODS` 只列了 run、settings、collaboration、environment、machine、admin、directory：`library`、`memory`、`contextPreview` 的请求不先在本地校验，参数错会被当成"版本不一致"（`VERSION_MISMATCH`）。

## 4. 怎么改

### 4.1 命令

| 命令 | RPC | `covers` | `--json` 成功 |
|---|---|---|---|
| `group create <name> --conversation <multi\|single\|smart> [--folder <path>\|default] [--project <p>] [--tool codex\|claude] [--response mention\|all] [--bot]` | `snapshot.get`；有 `--folder <path>` 先 `directory.choose`；`collaboration.createProject` | `collaboration.createProject`、`directory.choose` | `{ok, group:{groupId,name,folder,tool,conversation,response?,enabled,revision}, warning}` |
| `group show <group> [--bot]` | `collaboration.project` | `collaboration.project` | `{ok, group:{…同上}}` |
| `group set <group> [--enable\|--disable] [--conversation …] [--folder <path>] [--project <p>] [--revision <r>] [--bot]` | 没给 `--revision` 先 `collaboration.project`；`--folder` 先 `directory.choose`；`collaboration.editProject` | `collaboration.editProject` | `{ok, group, changed:[…], warning?}` |
| `group unbind <group> [--yes] [--bot]` | `collaboration.project`、`collaboration.removeProject` | `collaboration.removeProject` | `{ok, unbound:{groupId,name}, groupEffect?}` |
| `group bind <oc_…> --conversation … [--folder <path>\|default] [--project <p>] …`（改） | 同今天，`--folder default` 或不写时不发 `directory.choose` | 加 `library.list`（`--project` 按名字找） | 同今天 |
| `dir list [path] [--all]` | `directory.list` | `directory.list` | `{ok, path, parent, entries:[{name,path,hidden}], truncated}` |
| `dir suggest <query>` | `directory.suggest` | `directory.suggest` | `{ok, root, path, parent, entries, truncated}` |
| `project list`（改） | daemon 在跑：`library.list`；没跑：读文件 | 加 `library.list` | `{ok, source:'daemon'\|'files', projects, unlinked, …}` |
| `project rename <project> <name>` | `library.list`、`library.rename` | `library.rename` | `{ok, project:{id,name,revision,workspace}}` |
| `project remove <project> [--yes]` | `library.list`、`library.delete` | `library.delete` | `{ok, removed:{id,name}}` |
| `project workspace <project> [--primary <path>] [--add <path>]… [--remove <path>]… [--repos <path>]… [--default-repos]` | `library.list`、`library.workspace` | `library.workspace` | `{ok, project, changed, rebound:[…]}` |

`<group>` 是群 id（`oc_…`）或群名，按 `pickGroup()` 在这个 Bot 的绑定里找（C1 的写法）；`<project>` 是项目名或 `prj_…`。`--conversation` 照 `group bind` 的 `CONVERSATIONS`（`multi`、`single`、`smart`），`--response` 规则也同 `bind`（`smart` 不收 `--response`）。`--tool` 默认 `codex`。

失败：

| 情况 | 退出码 | `reason` |
|---|---|---|
| 参数错；`--project` 和 `--folder <path>` 一起给；找不到群、项目；`set` 什么都没给 | 2 | — |
| 文件夹不存在、不是文件夹、不在 daemon 用户的主目录里、选择过期 | 2 | `invalid_directory` / `outside_home` / `invalid_folder_token` |
| `unbind`、`project remove` 没带 `--yes` | 2 | `confirm_required`，`partial` 是要删什么（4.2） |
| 连不上 | 3 | — |
| Bot 没在运行（`runningBot()` 先查，4.6） | 4 | `bot_not_running` |
| daemon 回 `refused` | 4 | daemon 的 `code` |
| `project remove` 还有群在用（CLI 先查 `bindings`） | 4 | `project_in_use` |
| `--revision` 过期，或读和写之间别处改了（`conflict`） | 5 | — |
| `group create` 建了群但没存下（`created_unsaved`） | 1 | `created_unsaved`，文字是 daemon 的 |
| `group create` 结果不确定（`outcome_unknown`、超时、断线） | 6 | — |

### 4.2 各命令的细节

- **`group create`**：先 `runningBot()`。`--folder` 不写或写 `default` 发 `{kind:'default'}`；写路径就照今天 `bind` 的展开（`~` 和相对路径按本机，见 4.7）发 `directory.choose`，拿 `folderToken`。`--project` 按名字或 id 在 `library.list` 里找；和 `--folder <path>` 同给 → 2（协议注释：加入已有项目时文件夹不用、必须是 `default`）。发 `createProject`，用 `{ feishu: true, unknown: '群可能已经建好，运行 vonvon group list 查看。' }`。Bot 自己建的群是完全访问（`devices.md` 5.3 owner 定的默认），人类输出最后一行打第 15 节的原文："完全访问的群里，群成员能让 Bot 在这台设备上做任何事，包括改 vonvon 的设置，只给信任的群用。"，JSON 放 `warning`。文字常量放 `P/display.ts` `FULL_ACCESS_WARNING`，U2 换成 `TierInfo.warning` 时只改这一处。
- **`group show`**：人类输出一行：`群名  oc_…  Codex · 多会话 · 已启用  /path`，`revision` 只进 JSON。
- **`group set`**：至少给一项，否则 2。`--enable`、`--disable` 互斥。没给 `--revision` 先读一次（`collaboration.project`）拿 `revision`，紧接着写——人类用的时候不用自己查；给了就原样带上（AI 先 `show --json` 再改时用）。`--folder` 只接路径（`editProject` 只有 `folderToken`，没有"换回默认"）。`conflict` → 5，文字"群设置刚被别处改过，运行 vonvon group show <group> 看最新的再改。"。回复里的 `warning`、`message` 原样打出（例如改会话方式后旧会话归档）。
- **`group unbind`**：不带 `--yes`：读 `collaboration.project`，exit 2 `confirm_required`，`partial: {groupId, name, folder, tool, conversation}`，文字"解绑后 Bot 不再回这个群，群里的会话都归档；项目和记忆留着，以后再绑会接着用。确认后加 --yes 再运行一次。"（和网页确认框同义，网页那句如果不同就照网页）。带 `--yes`：读 `revision` 再发 `removeProject`，`{ feishu: true, unknown: '可能已经解绑，运行 vonvon group list 查看。' }`。`groupEffect`：`left` → "Bot 已退出这个群"；`transferred` → "群主已转给你，Bot 已退出"；`failed` → "已解绑，但 Bot 没能退出飞书群，要自己在飞书里移除"（退出码仍是 0，JSON 带 `groupEffect:'failed'`）。
- **`group bind`（改）**：`--folder` 改成可选，默认 `default`；去掉 `stat()`，路径不对由 `directory.choose` 回 `invalid_directory` → 2，文字是 daemon 的"找不到这个目录，请检查路径。"。新的 `--project <p>`：按 `library.list` 找，和 `--folder <path>` 同给 → 2。`bindGroup` 的 `folder` 为 `default` 时不发 `directory.choose`。
- **`dir list`**：`path` 不写就是 daemon 用户的主目录；人类输出每行一个子文件夹，默认不列隐藏的（`--all` 才列），`truncated` 时最后一行"只列了前 1000 个"。JSON 总是全的。
- **`dir suggest`**：照网页输入框的补全；每行一个路径。
- **`project list`（改）**：先试连 daemon：连上 → `library.list`，人类输出同今天（绑定名单来自 `bindings`，Bot 名字从快照取），JSON `source:'daemon'`；连不上（exit 3 那一类错误）→ 照今天读文件、`source:'files'`。会话里（`inBotSession()`）不读文件：连不上就照常 exit 3（D4a 之后会话不能绕开 daemon，`devices.md` 8.3）。
- **`project rename`**：`library.list` 找到项目和 `revision`，发 `rename`。
- **`project remove`**：`bindings` 非空 → exit 4 `project_in_use`，文字"这个项目还有群在用（群名、群名），先解绑或换到别的项目。"，不发请求。没带 `--yes` → 2 `confirm_required`，`partial: {id, name, workspace}`，文字"删除项目会一起删掉它的项目记忆和记录，不能撤销。确认后加 --yes 再运行一次。"。daemon 仍回 `conflict`（刚有群加入）→ 5。
- **`project workspace`**：从 `library.list` 拿现在的 `workspace`，按选项改：`--primary` 换主文件夹；`--add`、`--remove` 可重复，改 `additional`；`--repos` 可重复，整组换 `repositories`；`--default-repos` 删掉 `repositories`（回到各 Bot 自己的默认）；`--repos` 和 `--default-repos` 互斥；什么都没给 → 2。路径照 `bind` 展开后原样发（daemon 侧 `admitDirectorySettings` 判，不在允许的地方回 `conflict`/`invalid_request`，文字是 daemon 的）。`changed:false` 时人类输出"没有变化"。`rebound` 里 `failed` 的逐条打"群「…」没跟上，daemon 下次启动时会补"。

### 4.3 交互和非交互

全部不读 stdin、不提问。`unbind`、`project remove` 用 `--yes`。`group create` 慢（要在飞书建群），超时按 `feishu` 档（75 秒）。

### 4.4 权限表（5.2）

不加新 kind。会话里的结果由 D4a/D4b 按已有的行判：`collaboration.createProject` 群令牌 ✗ `not-dm`、私聊令牌 ★；`editProject` 同 `settings.save`；`removeProject` ✗；`collaboration.project` 读类限自己；`directory.*`、`library.*` 除 `library.list`（过滤）外 ✗。`project list` 在会话里走 `library.list`，D4a 给它的过滤就够了。

### 4.5 文件夹路径

`dir`、`group create/set/bind --folder`、`project workspace` 的路径一律按命令行这台机器展开 `~` 和相对路径（今天 `bind` 的写法，抽成 `D/cli/commands/group.ts` 里的 `folderPath(raw, host)` 给几处共用），是不是文件夹由 daemon 判。

### 4.6 共用改动

C2 4.6 的三件照抄（C2 先合入就不用）。本片另加两处，C4、C5、C8 要用时照抄：

```ts
// D/cli/daemon-client.ts
const METHODS = {
  run: 'command', settings: 'settings', collaboration: 'collaboration', environment: 'environment', machine: 'machine', admin: 'admin', directory: 'directory',
  library: 'library', memory: 'memory', contextPreview: 'contextPreview',
} as const;

/** A bot that answers now: collaboration requests go to its process, which a stopped or paused bot does not have. */
export function runningBot(agents: readonly Agent[], wanted?: string): Agent {
  const agent = pickBot(agents, wanted);
  if (!agent.running) throw new CommandError('refused', `Bot「${printable(agent.name)}」没在运行。运行 vonvon bot enable ${agent.id}，或者 vonvon bot status ${agent.id} 看原因。`, { reason: 'bot_not_running' });
  return agent;
}
```

落点照 C2 4.6 的表：`group create/set/unbind/show` 跟在 `group bind` 后；`dir` 组紧跟 `group` 组；`project rename/remove/workspace` 在 `project list` 后。

### 4.7 和总设计不一样的地方

- **`group set` 的选项写成 `--enable/--disable`**（8.2 写 `--enabled`）：命名照 8.1"启用 enable、停用 disable"，和 `bot enable/disable` 一致。
- **多了 `--revision`（可选）和 `--yes`**：`--revision` 给"先看再改"的调用方做乐观锁；`--yes` 同 C2 4.7。
- **`group create` 不收 `--judge`**：选决策模型已经有 `settings set --group … judge.selection=…`，建群这一步只放网页建群对话框里的必填项，少一套参数校验。
- **路径展开留在命令行这台机器**：远程设备（D3）上 `~` 应该按对方的主目录。本片不改，D3 接远程连接时让 CLI 原样发 `~/…`、`canonical()` 按 `root` 展开；这里记下，D3 计划要写进去。
- **`project list` 在会话里不读文件**：8.3 说"daemon 没跑时保留只读回退"，没说会话；会话里读文件就绕过了 D4a 的过滤，所以只在会话以外回退。

## 5. 测试

新文件 `T/cli-group.test.ts`、`T/cli-dir.test.ts`，`T/cli-project-list.test.ts` 加用例；daemon 侧 `T/server-directory.test.ts` 加用例：
- `group create 研发 --conversation multi`：发 `createProject{folder:{kind:'default'}, tool:'codex', conversation:'threads'}`，不发 `directory.choose`；成功输出带 `warning`，人类输出最后一行是第 15 节原文（main 必败）。
- `--folder ~/x`：先 `directory.choose{path:<home>/x}`，再 `createProject{folder:{kind:'existing', folderToken}}`；`choose` 抛 `RpcError('invalid_directory')` → bad-args `reason:'invalid_directory'`，没发 `createProject`（main 必败）。
- `--project 某项目 --folder ~/x` → bad-args，什么都不发（main 必败）。
- `createProject` 抛 `RpcError('created_unsaved','…')` → failed、`reason:'created_unsaved'`；抛 `outcome_unknown` → outcome-unknown；Bot `running:false` → refused `bot_not_running`，没发请求（main 必败）。
- `group set 研发 --disable`：先 `project`（拿 `revision:'r1'`），再 `editProject{expectedRevision:'r1', enabled:false}`；`--revision r0` 时不读、直接发 `r0`；`editProject` 抛 `RpcError('conflict')` → conflict；什么都不给 → bad-args（main 必败）。
- `group unbind 研发`：不发 `removeProject`、bad-args `confirm_required`、`partial.groupId`；`--yes` 回 `applied{groupEffect:'failed'}` → 退出 0、人类输出含"没能退出飞书群"（main 必败）。
- `group bind oc_x --conversation multi` 不带 `--folder`：发 `bindGroup{folder:{kind:'default'}}`、不发 `choose`；带一个不存在的 `--folder`：不在本地报错，发 `choose`，daemon 回 `invalid_directory` → bad-args（main 必败：今天必填、本地 `stat`）。
- `dir list --json`：`{"ok":true,"path":…,"entries":[…]}`；人类输出不含隐藏文件夹，`--all` 含（main 必败）。
- `project list`：注入的连接成功 → `source:'daemon'`、不读文件；连接抛 `ConnectionError` → `source:'files'`；会话环境里连接失败 → exit 3，没读文件（main 必败）。
- `project remove p1`：`bindings` 非空 → refused `project_in_use`；空 + 不带 `--yes` → bad-args；带 `--yes` 发 `delete{projectId, revision}`（main 必败）。
- `project workspace p1 --add ~/y --default-repos`：发 `workspace{additional:[…旧的, <home>/y]}`、没有 `repositories`；`--repos a --default-repos` → bad-args（main 必败）。
- daemon：`createDirectoryBrowser(tmp).choose('<tmp>/nope')` 抛 `RpcError` `code:'invalid_directory'`（main 必败：今天是原始 `ENOENT`）；`list('<tmp>/file')` 同。
- `T/cli-json.test.ts`：`SAMPLES` 加 `group create/show/set/unbind`、`dir list/suggest`、`project rename/remove/workspace` 各一行（都 3）；`T/cli-parity.test.ts`：9 个 kind 不在白名单。
- `rpcErrorKind('invalid_directory') === 'bad-args'`（main 必败）。

## 6. 自测和验收

**Linux（JP-VPS）**：protocol、daemon 的 typecheck、lint、build；上面的测试文件和 `T/cli-admin.test.ts`、`T/daemon-cli.test.ts`。临时 HOME 和数据目录里手跑每条新命令的 `--json`（没 daemon，退 3）。

**集成分支验收时，主会话在验收 daemon 上做**（拿 `/tmp/accept-user.d` 目录锁、核对 sha、用完放锁；只用 Bot 6 和它已绑好的测试群）：
1. `vonvon group create C3验收 --conversation single --bot <Bot 6>`：飞书里出现新群、Bot 在里面；`group show`、网页群列表一致；输出有完全访问那句（devices.md C3 验收一行）。
2. `vonvon group set C3验收 --disable`，网页显示已停用；`--enable` 回来。
3. `vonvon group unbind C3验收 --yes`：Bot 退出这个新群（只对本步新建的群做，不碰已绑好的测试群）。
4. `vonvon dir list`、`vonvon dir suggest vonvon` 和网页选文件夹对话框看到的一样。
5. `vonvon project list --json` 在 daemon 跑着时 `source:'daemon'`。
6. `project rename`、`project workspace` 只对第 1 步建出来的项目做，做完 `project remove --yes` 删掉。

**Mac、Windows**：不需要。Windows 路径（`C:\…`、`~` 在 Windows 上）由 `path.resolve` 处理，和今天 `bind` 一样；Windows 的真机检查归 D 线的 Windows 验收。（owner 2026-11-01：Windows 上不做只装服务端，这一批 Windows 上没有注册的 `vonvon`，这条不做；发给 Windows 的任务只有 U4 和 Windows 桌面端当被连的设备的检查，见 `devices.md` 第 19 节。）

## 7. 文档

- `docs/product.md`：本片不改（D0 按 `devices.md` 第 11 节统一写"命令行能做页面上的事"）。`group bind` 不再要 `--folder` 这一点，如果 3.10 或别处的例子写了 `--folder`，同一个 PR 里把例子改成可选。
- `docs/v1-plan.md` 不改。

## 8. 验收要点

1. 9 条新命令有 `--json`，失败的 `exitCode` 和 `reason` 照 4.1。
2. `group bind`、`group create` 不在命令行这台机器上 `stat` 文件夹；不存在的文件夹是 exit 2、文字来自 daemon。
3. `unbind`、`project remove` 不带 `--yes` 一定不发写请求；`project remove` 有群在用时不发。
4. `group create` 的输出带完全访问那句，文字和第 15 节一字不差。
5. `project list` 在会话里不读文件。
6. `METHODS` 含 `library`、`memory`、`contextPreview`，三者的参数错是 exit 2 而不是"版本不一致"。
7. 白名单里没有本片的 9 个 kind。
8. diff 里没有真实 id、密钥、IP、本机路径。

## 9. 风险和行数

约 1,250 行：`group.ts` +330（create、set、unbind、show、`folderPath`），新 `dir.ts` +80，`project.ts` +200，`index.ts` +90，`daemon-client.ts` +15，`command-error.ts` +4，`directory-browser.ts` +8，`P/display.ts` +3，白名单 −9，测试约 520。贴近上限：超出时把 `project rename/remove/workspace`（约 300 行含测试）拆成 C3b，和 C3 同一个集成分支，C3b 在 C3 后合入。
- `group create` 是真在飞书里建群：测试只用假客户端；验收只在验收 daemon 的 Bot 6 上建一个新群，做完解绑。
- `canonical()` 的错误码变化也影响网页：网页今天对 `operation_failed` 显示"操作失败"，改后显示"找不到这个目录，请检查路径。"——是改好，不是回归；`U/` 里没有按 `operation_failed` 分支的代码（写计划时 grep 过）。

## 和计划不一样的地方

- **`group unbind` 的确认文字照网页确认框原文**（`GroupWorkspace.tsx`："解除 X 与「群名」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。本地目录和文件保留。"）再加"确认后加 --yes 再运行一次。"：4.2 写了"网页那句如果不同就照网页"。
- **`group set` 的 `conflict` 保留 daemon 的原话**，下一行再加"群设置刚被别处改过的话，运行 vonvon group show <group> 看最新的再改。"：daemon 的 `conflict` 还包括"Agent 正在执行任务""正在群里说一句"这类，整句换掉会说错原因。
- **`group set` 在本地多拦两种**（exit 2）：`--folder default`（没有"换回默认"）；`--folder` 和 `--project` 同给（daemon 也拒："换项目和改文件夹要分两次"）。
- **`group bind` 不给 `--folder` 路径时**，人类输出的文件夹从绑定后的快照里取（daemon 回复写请求前已重建快照）；取不到写"默认文件夹"，JSON 里不带 `folder`。
- **`group create` 的免 @ 照网页 `sentResponse('create')`**：单会话的默认（关）也显式发 `response:'mention'`（s21 以前的 daemon 建群一律免 @ 开），多会话的默认不发。
- **`group show` 那一行的会话方式写短名**（"多会话"，同 4.2 的例子）；`create`、`bind` 照旧写"多会话（@ 我开新会话）"。`runningBot()` 也用在 `group show`：读群也要 Bot 进程在跑，不然 daemon 回 `conflict`。
- **`group set`、`group unbind` 的 JSON 多带 daemon 的 `warning`、`message`**（有才带）。
- **`project list` 走 daemon 时 JSON 的 `projects` 是 `library.list` 原样**（`bindings` 带 `agentId`、`groupId`），`unlinked` 是个数，人类输出也只能写个数；读文件的照旧（`unlinked` 是名单，另有 `unreadable`）。连接时抛的 `ConnectionError` 也算连不上，回退读文件（会话里照样 exit 3）。
- **`project workspace`**：`--primary` 换上来的文件夹从附加文件夹里去掉；`--add` 已有的不重复加；`--remove` 不在附加文件夹里的路径 exit 2（按 daemon 给的规范路径比对）；请求超时按 `feishu` 档（扇出到各 Bot、归档会话）。
- **`dir list` 人类输出每行是完整路径**（能直接给 `--folder`），没有子文件夹时说一句，隐藏的有几个、加 `--all` 看。
- **测试落点**：`project` 的新用例放在新文件 `T/cli-project.test.ts`，不放 `T/cli-project-list.test.ts`（它整文件 mock 了 `commands/project` 和 `node:fs/promises`，测入口不拿租约，真模块进不去）；"9 个 kind 被 `covers`、不在白名单"和 C2 一样放在 `T/cli-group.test.ts`，`T/cli-parity.test.ts` 不动；`T/cli-admin.test.ts` 删了 `bind` 本地 `stat` 的两条期望（文件夹不存在、不是文件夹），新行为在 `T/cli-group.test.ts` 测；`METHODS` 的三条（验收要点 6）在 `T/cli-project.test.ts` 测。
