# U2 `devices-ui-2-remote-mode`：远程模式下的界面、文案、目录、退出规则和完全访问警示

总设计见 `docs/plans/devices.md`（下文简称"设计"）4.5、6.4、6.5、7.4、第 15 节、第 19 节"Windows 的平台名"，本片对应第 13 节的 U2 行。单独一个 PR，分支 `claude/devices-ui-2-remote-mode`，从集成分支开、PR 回集成分支。产品行为以 `docs/product.md` 3.1、3.8、3.10、3.14 为准。

缩写同 D1：`P/`、`CL/`、`D/`、`DT/`、`U/` 分别是 protocol、client、daemon、desktop、ui 的 `src/`。行号以 `origin/claude/devices-integration`（8051b03c，代码和 413d78d5 相同）为准；D1 的代码以 `origin/claude/devices-1-identity`（147b2619）为准；I3 拆成了 I3a `server-3a-update-core`（#632）和叠在它上面的 I3b `server-3b-update-helper`（#633），I3 的以 `origin/claude/server-3b-update-helper`（83550082）为准，I3 合入集成分支后以集成分支为准。文中写明"D1 分支""I3 分支"。U1a、U1b 的接口以 `devices-ui-1a-connections.md`、`devices-ui-1b-devices-page.md` 为准。

## 1. 做什么

用户能看到的：
- **远程时说清楚在哪台。** 切到别的设备后，装工具、配 Provider、选目录这些页面都写"在「X」上…"。本机照旧，不带设备名。
- **不再说"登录"。** Codex、Claude 相关的"登录"一律改成"配置好 / 可用 / 检查配置"，并写明"账号或自定义 API 都行"。飞书（lark-cli）那几处是真的登录飞书，保留，改成"登录飞书"。
- **目录。** 远程时目录浏览器标题写"选择「X」上的文件夹"。手动输入路径认 Windows 写法（`C:\…`、`\\server\share`）和 `~/`。目录不再限制在家目录里，本机和远程一样能进 `/srv`、`/data` 这类目录。
- **"应用与启动"页在远程时：**
  - 上面一张卡是"这台电脑上的 Vonvon Bot 应用"，管桌面端自己的更新，和今天一样。
  - 下面一张卡是"「X」的服务端"：版本、安装方式、检查更新；对面能自己升级（独立安装或 npm 版）时有"更新"按钮。对面是桌面端自带的，先只写文字，按钮在 U4。
  - "「X」的后台服务"一组：
    - 后台运行，带"重启"；
    - 登录时启动：macOS 能开关；Linux 给一行命令；Windows 说明这一批没有。
  - 隐藏"启动 daemon""启动服务""仅运行此 Bot"；"停止"的确认框写清楚停了只能到那台设备上再启动。
- **退出桌面端：** 本机跑的服务端如果不是桌面端自带的，又另外注册成了后台服务（比如 `npm i -g vonvon-bot` 后 `vonvon service install`），退出桌面端不再停它，页脚也这么写。桌面端自带的照旧停。
- **版本对不上时说清楚哪边旧。** 本机服务端和桌面端的协议版本不同时，启动失败的提示写清楚是服务端旧还是桌面端旧、该做什么。
- **删掉两处旧东西：** 旧的"Codex 安装 / Codex 授权"任务面板，和群设置里没人用的 `AgentProfileSettings`。
- **完全访问警示**（设计第 15 节"给群选完全访问"）。凡是给群选完全访问的地方都写这句：
  - 网页端：执行权限选择、建群对话框；
  - 私聊：权限卡和建群完成卡，私聊里把群改成完全访问后 bot 的回复；
  - 命令行：`settings set` 的输出；`group create` 今天已经有。

依赖：U1a（`useActiveDevice`、`shellForDevice`、bridge 的远程路由和 `devices.expect`）、D1（`hostPlatform`、serverInfo 的 `capabilities`、`AttachError('protocol')`）。U1a 和 U1b 是一个 PR，所以 U1 一定先于本片合入；本片把 U1b 维护视图里服务端那一段换成 `ServerUpdateCard`（4.4.2）。I3 已合入时 `ServerUpdateCard` 用它的 `coreUpdatable`、跟进度的写法；没合入时卡上只有版本和检查。

## 2. 范围

做：
- 新文件：`U/device-copy.ts`、`U/management/ServerUpdateCard.tsx`、`U/management/RemoteServiceGroup.tsx`。
- UI 改：
  - 4.2 文案表里的文件；
  - `U/directory-picker.tsx`、`U/DirectorySearchStep.tsx`；
  - `U/App.tsx`、`U/management/UpdatePanel.tsx`、`U/management/MachinePanel.tsx`、`U/setup/service-toggle.tsx`；
  - 平台名用到的地方（4.5）；
  - `U/settings/SettingsPanel.tsx`、`U/JoinGroupDialog.tsx`、`U/settings/GroupDesignSettings.tsx`；
  - 旧 Codex 任务面板的引用（4.9）。
- daemon：
  - `D/server/directory-browser.ts`、`D/server/directory-suggestions.ts`；
  - `D/server/snapshot.ts` 的 `hostPlatform`；
  - 4.2 第二张表的提示文字；
  - `D/server/jobs.ts`、`D/server/rpc/command.ts`、`D/admin/service.ts`、`D/agent/codex-appserver/setup.ts` 的删除；
  - 完全访问警示：`D/agent/permission/types.ts`、`D/admin/settings.ts`、`D/agent/entry/command-tools.ts`、`D/card/dm-cards.ts`、`D/bot/handle-message.ts`；
  - `D/cli/commands/settings.ts`、`D/cli/commands/env.ts`；
  - serverInfo 的 `update.*` 能力（4.11）；
  - 推快照那一处（`D/server/http.ts:148-158`，D2 后是 `peer-hub.ts` 的 `hub.publish(event, shape)`）：维护连接不发 `snapshot` 事件，用 `shape` 做，和 D4a 同一个办法（4.5；D4a 先合入就不做）。
- protocol：`P/domain.ts`、`P/settings.ts`、`scripts/verify-built.mjs`。
- desktop：`DT/quit-daemon.ts`、`DT/main.ts`、`DT/bridge.ts`、`DT/daemon-manager.ts`、`DT/daemon-dependencies.ts`、`DT/login-item.ts`。
- 文档：设计 6.3、6.4、第 15 节的几处（已在本计划的 PR 里改，第 7 节）。

不做：
- 设备页、切换、维护视图的外框：U1b。
- "允许别的设备连接"、生成链接、撤销、改这台电脑的名字、扫码任务的归属：U3。
- 对面是桌面端自带服务端时的"更新"按钮和整条外壳更新通道：U4。本片只给这种情况写一句文字。
- 飞书卡片里的"登录"（`D/card/run-card.ts:423-425`、用量卡）：卡片说的是飞书和 Provider 账号的实际状态，不在设备文案的范围里，不动。
- `vonvon env login lark-cli` 和它的输出：真的是登录飞书，不动。
- 远程设备上的 Windows 登录自启：这一批不做（设计 7.4）。

## 3. 现在的代码

- **文案。** 设计 6.4 列的 UI 行逐条核过：
  - `management/EnvironmentPanel.tsx:358,364`、`management/environmentPresentation.ts:30`、`search.ts:70` 说的是 lark-cli 的飞书登录，不是 Provider。设计把它们一起列进"统一改掉"是列多了，本片保留，见 4.2。
  - daemon 里还有十来处 Provider 的"登录"会原样显示到页面上，设计没列，本片一并改（4.2 第二张表）。
- **目录。**
  - `D/server/directory-browser.ts:20-23` 的 `contained` 把一切 realpath 后不在家目录里的路径拒成 `outside_home`；`list`（36-51）在家目录处 `parent: null`。
  - 搜索建议在子进程里跑（`D/server/directory-suggestions.ts`，脚本是字符串），自己也有一份 `contained`（38-41，44 调用），`parent` 在 57 按家目录截断。
  - UI 的手动路径只认 `/` 开头（`U/directory-picker.tsx:129`），标题写死"添加目录 / 选择目录"（122）。
- **应用与启动页**（`U/App.tsx:898-920`）：
  - `UpdatePanel` 的 `device` 用 `deviceTitle(snapshot.application.platform)`（`U/setup/service-toggle.tsx:37-39`），版本取快照。远程时快照是对面的，所以今天切过去这张卡会把对面的版本当成"这台电脑上的应用"的版本。
  - "启动选项"的页脚（909）写"选择退出会停止后台和所有 Bot"；`MachinePanel` 页脚（`U/management/MachinePanel.tsx:77`）和确认框（104）同样。
  - `MachinePanel` 的"启动 daemon"（71）、"启动服务"（82）、"仅运行此 Bot"（92）靠 `shell.startHost`、`shell.service`。远程时 `shellForDevice` 已经去掉这两项（U1a 4.7），按钮是灰的，但还在。
  - `LoginServiceRow`（`service-toggle.tsx:42-51`）只在 `platform === 'macos'` 时显示，开关走 `toggleService`（14-29）：有 `shell.setLoginItem` 就走外壳，没有就发 `machine.service install/uninstall`。远程时外壳那项被去掉，于是发 `machine.service`。可这一条今天到不了对面：bridge 的 `machine` 通道在转发之前就用 `desktopShellRequestSchema` 把 `service` 拦成 `Shell-owned machine action`（D1 分支 `DT/bridge.ts:251-253`）。U1a 4.5 改成远程时放行（本片 4.6）。
- **平台。** 快照的 `application.platform` 是 `macos | linux | unsupported`（`P/domain.ts:267`）。D1 分支把平台判定提成 `hostPlatform()`（D1 分支 `D/server/snapshot.ts:31`），serverInfo 也用它，win32 仍判成 `unsupported`。界面里用到它的地方：
  - 按平台取值的完整 Record 只有 `U/setup/service-toggle.tsx:37` 的 `DEVICE_TITLE`（加一个值就编不过）；`SetupChecklist.tsx:15` 的 `SERVICE_FOOTER` 是 `Partial`；
  - 其余都是和 `'macos'`、`'linux'` 比相等：`App.tsx:906,909`、`SetupChecklist.tsx:88,96`、`setup/BridgeImportPanel.tsx:102,110`、`service-toggle.tsx:43`。`windows` 自然落进"不是 macOS"那一支。
- **退出。** `DT/quit-daemon.ts:15-41` 的 `stopDaemonForQuit` 循环：读已验证的 owner → `requestStop` → 等它退出 → 再读，直到没有 owner。`DT/main.ts:269-275` 组装依赖。服务注册由 `daemon-dependencies.ts` 的 `readRegistration` 读，`RegisteredDaemon.kind` 是 `npm | desktop | standalone`（`DT/daemon-manager.ts:14-19`）。
- **协议检查。**
  - `DT/daemon-manager.ts:68-75` 的 `checked` 在协议不同时抛"先别关它，把应用和后台更新到互相兼容的版本"。
  - D1 分支里，`attachExisting` 遇到协议不同抛 `AttachError('protocol', …, serverProtocol)`（D1 分支 `DT/attach.ts:83-88`），`checkProtocol` 把它变成返回值（D1 分支 `daemon-dependencies.ts:113-125`）。注释写着"U2 lets it in for maintenance"，但设计 4.5 在 2026-11-01 后已经不做本机的维护模式（第 19 节），本片改这条注释。
  - `readVerifiedDaemon`（`daemon-dependencies.ts:79-82`）失败时说"无法验证…与桌面协议 2 是否匹配"。D1 之后它只验证 owner 身份，不比版本，这句话说错了。
- **旧 Codex 任务面板。** 网页端早就不发起 Codex 登录（`D/server/jobs.ts:117` 直接拒），安装也改走 `environment.install`。还连着它的有：
  - 协议：`P/domain.ts:75-76` 的 `installCodex`、`startCodexLogin` 两个 command，248 的 job 类型；
  - daemon：`D/server/rpc/command.ts:26-27`、`jobs.ts:41,116-128,134,139-147`、`D/admin/service.ts:129-131,654-659`、`D/agent/codex-appserver/setup.ts` 的设备码登录和安装；
  - UI：`App.tsx:894,897,1043-1047`、`EnvironmentPanel.tsx:22`、`SetupChecklist.tsx:37,42,94`、`useProviderSetup.ts:35-36,124-125`；
  - 白名单 `D/cli/parity-allowlist.ts:26-27` 已标 `dead('U2')`。
- **`AgentProfileSettings`**（`U/settings/GroupDesignSettings.tsx:252`）没有任何地方渲染它。
- **完全访问。**
  - `FULL_ACCESS_WARNING` 在 `P/display.ts:50`。目前只有 `group create` 打印（`D/cli/commands/group.ts:262-263`），那是因为新建的群默认就是完全访问（`D/project/lifecycle.ts:224`）。
  - 档位定义 `TierInfo`（`D/agent/permission/types.ts:14-22`）、`permissionTiers`（60-70）。三个后端（`claude.ts:35`、`codex.ts:39`、`generic.ts:9`）都用它，`TableEnv`（25-31）分不出是群还是私聊。
  - 设置保存：`D/admin/settings.ts` 的 `save`（779 起）权限分支在 936 起，回 `saved` 在 1070。
  - 界面：执行权限选择 `PermissionFields`（`U/settings/SettingsPanel.tsx:1053-1074`）、`PermissionSummary`（1077-1110）。
  - 私聊：权限卡 `buildPermissionCard`（`D/card/dm-cards.ts:1601-1627`），保存在 `D/bot/handle-message.ts:6427-6432`；建群完成卡 `buildNewProjectDoneCard`（`dm-cards.ts:661`）。
  - 设置工具 `settings_set`（`D/agent/entry/command-tools.ts:70-89`）。

## 4. 怎么改

### 4.1 `U/device-copy.ts`（新，纯函数）

```ts
import type {ActiveDevice} from './client-context';
type Where = Pick<ActiveDevice, 'isRemote' | 'name'>;
/** 远程："在「X」上安装"；本机原样。 */
export function onDevice(where: Where, action: string): string;
/** 设计第 15 节"在远程设备上配 Provider"：本机去掉"在 … 上"。 */
export function configureProvider(where: Where, provider: 'codex' | 'claude'): string;
// 本机："把 Codex 配置好（账号或自定义 API 都行），然后点「重新检测」。"
// 远程："在「X」上把 Codex 配置好（账号或自定义 API 都行），然后点「重新检测」。"
export const CONFIG_STATE: Record<'signedIn' | 'signedOut' | 'notRequired' | 'unknown', string>;
// { signedIn: '可用', signedOut: '没配置好', notRequired: '可用', unknown: '无法确认' }
export const CHECK_CONFIG = '检查配置';
/** 应用与启动页"这台设备"一行：macos → 这台 Mac，linux → 这台 Linux 主机，windows → 这台 Windows 电脑，其余 → 这台电脑。 */
export function hostTitle(platform: string | undefined): string;
/** 远程时的设备称呼："「X」"；本机："这台电脑"。直接转调 U1a 的 deviceCopyName。 */
export const whereName: (where: Where) => string;
```

`service-toggle.tsx:37-39` 的 `deviceTitle` 改成转调 `hostTitle`，签名放宽到 `string`，原来的调用不用改。

### 4.2 文案

**界面里的 Provider 文案**（远程时都用 `onDevice`/`configureProvider` 带上设备名，`where` 取 `useActiveDevice()`）：

| 位置 | 现在 | 改成 |
|---|---|---|
| `JoinGroupDialog.tsx:150` | 请先安装并登录 Provider。 | 请先`onDevice`安装 Provider 并配置好。 |
| `JoinGroupDialog.tsx:214` | 当前选择不可用，请重新登录或主动选择其他 Provider。/ 请先安装并登录 Codex 或 Claude。 | 当前选择不可用：`configureProvider`，或选别的 Provider。/ 请先`onDevice`安装 Codex 或 Claude 并配置好（账号或自定义 API 都行）。 |
| `settings/useProviderDiscovery.ts:49,56` | Claude 尚未登录，请在 Provider 页面登录后重新检查。 | Claude 还没配置好。`configureProvider(where,'claude')` |
| `settings/DecisionFields.tsx:41` | 此决策 Provider 当前不可用，请先安装并登录。 | 这个决策 Provider 现在不可用，先`onDevice`安装并配置好。 |
| `settings/GroupDesignSettings.tsx:113` | 正在检查 Provider 登录状态… | 正在检查 Provider 是否可用… |
| `settings/GroupDesignSettings.tsx:137` | 此 Provider 当前不可用，请先安装并登录。 | 同 `DecisionFields.tsx:41` |
| `settings/GroupDesignSettings.tsx:183` | 重新检查 Provider 登录状态 | 重新检查 Provider 是否可用 |
| `management/EnvironmentPanel.tsx:143` | 暂时无法检查登录，稍后再点"检查登录"。 | 暂时无法检查配置，稍后再点"检查配置"。 |
| `management/EnvironmentPanel.tsx:298` | `loginLabels`：已登录 / 未登录 / 无需登录 / 无法确认 | 用 `CONFIG_STATE` |
| `management/EnvironmentPanel.tsx:310` | Claude 登录：… | Claude 配置：… |
| `management/EnvironmentPanel.tsx:314` | 检查登录 | `CHECK_CONFIG` |
| `management/EnvironmentPanel.tsx:257`（安装、更新确认框） | Vonvon 会在本机安装并验证托管副本。/ Vonvon 将安装并验证新版本，然后切换到托管副本。 | 远程：Vonvon 会在「X」上安装并验证托管副本。/ Vonvon 将在「X」上安装并验证新版本，然后切换到托管副本。本机照旧 |
| `setup/ProviderSetup.tsx:152` | 请先在 Codex App 或 Codex CLI（`codex`）中完成登录或自定义模型配置… | `configureProvider` 开头，后面接"可以用 Codex App 或 `codex` 命令行配置"。Claude 同理 |
| `setup/ProviderSetup.tsx:175` | 在 Claude Code 中完成登录或自定义 API、模型配置，Vonvon 复用本机已有配置。 | 在 Claude Code 里配置好账号或自定义 API，Vonvon 用`whereName`上已有的配置。 |
| `setup/useClaudeLoginCheck.ts:21` | 暂时无法检查 Claude 登录。 | 暂时无法检查 Claude 的配置。 |
| `management/UsagePanel.tsx:69` | 在 Codex App 或 Codex CLI 中登录后，回到 Vonvon 检测配置。 | 用量只有 Codex 用 ChatGPT 账号时才有。`onDevice`配置好后回来检测。 |
| `management/DiagnosticsPanel.tsx:246` | Provider 每分钟检查一次；Claude 登录可单独检查。 | Provider 每分钟检查一次；Claude 的配置可以单独检查。 |
| `search.ts:69` | Provider 的 fields 里 '登录'、'检查授权'、'重新登录' | 换成 '配置'、'检查配置'；'登录' 留在 98 的别名里，用户搜"登录"仍能找到 Provider 页 |

保留不改：`EnvironmentPanel.tsx:358`（lark-cli 的"登录"按钮改成"登录飞书"）、`364`（"重新登录"改成"重新登录飞书"）、`environmentPresentation.ts:30`（"尚未登录"改成"还没登录飞书"）、`search.ts:70`（lark-cli 的 fields 不动）、`search.ts:98`（别名不动）。

远程时 Provider 页和工具页顶部多一行说明（`EnvironmentPanel`、`ProviderManager` 各一处）："这里装的、检查的都是「X」上的 Codex、Claude 和 lark-cli。"

**daemon 里会显示到页面上的提示**（不带设备名：daemon 不知道谁在看；页面需要时自己在前面加）：

| 位置 | 现在 | 改成 |
|---|---|---|
| `D/agent/claude-agent/login.ts:9` | 未登录。在终端运行 `claude` 登录，或设置 ANTHROPIC_API_KEY。 | 没配置好。在终端运行 `claude` 配置账号，或设置 ANTHROPIC_API_KEY 用自定义 API。 |
| `login.ts:41` | 无法确认：后台服务里没查到 Claude 登录… | 无法确认：后台服务里没查到 Claude 的配置，可能是读不到钥匙串。在终端运行 `claude` 看能不能用，或设置 ANTHROPIC_API_KEY。 |
| `login.ts:95` | 刚才有一轮因为没登录或登录过期失败了。在终端运行 `claude` 登录，再点「检查登录」。 | 刚才有一轮因为 Claude 的配置不可用（没配置或已过期）失败了。在终端运行 `claude` 配置好，再点「检查配置」。 |
| `D/agent/codex-appserver/backend.ts:882-886` | 当前 Provider 不需要 OpenAI 登录。/ 已登录。/ 尚未登录。/ 无法确认 Codex 登录状态。 | 用的是自定义 Provider，可用。/ 可用（OpenAI 账号）。/ 没配置好。/ 无法确认 Codex 的配置。 |
| `D/server/rpc/collaboration.ts:53-55` | 请先登录 Codex…/ 当前 Codex 使用 API Key 登录…/ Codex 登录已失效，请重新登录。 | 这台设备上的 Codex 没有用 ChatGPT 账号，看不到账号用量。/ 当前 Codex 用的是 API Key，没有 ChatGPT 账号的用量可读。/ Codex 的 ChatGPT 账号凭据过期了，在终端运行 `codex login` 后再看。 |
| `D/environment/service.ts:482-483` | 请先在 Codex App 或 Codex CLI 中完成登录或自定义模型配置，再回到 Vonvon 检测。 | 先把 Codex 配置好（账号或自定义 API 都行，用 Codex App 或 `codex` 命令行），再回到 Vonvon 检测。Claude 同理 |
| `D/project/initial-settings.ts:47,49` | 决策 Provider 尚未安装或未登录。/ 尚未登录或无法确认登录状态。 | 决策 Provider 还没装好或没配置好。/ 决策 Provider 没配置好，或者确认不了。 |
| `D/admin/settings.ts:374` | 后端当前不可用，请检查安装或登录状态 | 后端现在不可用，请检查安装和配置 |
| `D/admin/ops.ts:145` | 环境探测失败（未安装或未登录） | 环境探测失败（没装或没配置好） |
| `D/admin/service.ts:1059-1060` | 「X」的登录在它自己的设置里看。/ 无法确认登录状态，请重新检测。 | 「X」的配置在它自己的设置里看。/ 无法确认配置，请重新检测。 |
| `D/admin/service.ts:1265` | 环境探测失败（未安装、未登录或探测超时） | 环境探测失败（没装、没配置好或探测超时） |
| `D/cli/commands/env.ts:97-104` 的 `authText` | 登录状态查不到 / 已登录 / 登录状态不确定：… / 没登录：在终端里运行 codex login（Claude 是"claude 登录"） | 只改 Codex、Claude 那一路：配置状态查不到 / 可用 / 确认不了：… / 没配置好：在终端里运行 `codex` 或 `claude` 配置（账号或自定义 API 都行）。这个函数 lark-cli 也在用（102 行），而 lark-cli 确实要登录飞书：函数开头先按 `tool.tool === 'lark-cli'` 分出去，lark-cli 的四种输出一字不改 |
| `D/cli/commands/env.ts:495` | `LOGIN_STATE` | 可用 / 没配置好 / 可用 / 确认不了 |

`login.ts:29` 的"已登录 claude.ai 账号（<套餐>）"是在说明实际用的账号，保留。`jobs.ts:117` 随 4.9 删掉。

### 4.3 目录

**UI：**
- `directory-picker.tsx:122` 标题：
  - 远程：多选"添加「X」上的文件夹"，单选"选择「X」上的文件夹"；
  - 本机照旧。
  - `where` 取 `useActiveDevice()`，picker 在 `ClientProvider` 里面。
- `directory-picker.tsx:129` 的手动路径判断换成导出的 `looksLikePath(text)`：`/^(\/|~([\\/]|$)|[A-Za-z]:[\\/]|\\\\)/`。占位字改成"搜索此处，或输入路径（如 /srv/app、C:\\work）"。
- `DirectorySearchStep.tsx:80` 的说明：
  - 远程时"Bot 所在设备的目录"改成"「X」上的目录"；
  - 本机照旧；
  - 60-63 的 `browse` 同样用 `looksLikePath`。

**daemon，放开家目录限制**（设计 6.4，owner 2026-10-31）：
- `directory-browser.ts`：
  - 删 `contained`（20-23）和 28 行的调用。
  - `list`、`choose` 收到的路径先过 `expandHome(path, root)`（`D/platform/home-path.ts`，判断用同一个文件的 `isHomeRelative`）：`~`、`~/…`，以及 Windows 上的 `~\…`，接到家目录上，其余原样。不另写一份：`directory-suggestions.ts` 已经按 `isHomeRelative` 的规则认 `~`（它的注释写着两边要一样），再写一份，两处规则会跑偏，Windows 的 `~\` 最容易不一致。
  - 界面的 `looksLikePath` 只决定"当路径打开还是当搜索词"，展开由 daemon 按它自己的平台做。所以 `~\x` 在非 Windows 的 daemon 上照 `isHomeRelative` 当普通名字，回"找不到这个目录"。
  - `list` 的 `parent` 改成 `dirname(resolved) === resolved ? null : dirname(resolved)`，只在文件系统根（`/`、`C:\`）为 `null`。
  - 默认路径仍是 `root`（家目录）。
  - `resolve(token)` 照旧再 `canonical` 一次。
- `directory-suggestions.ts` 的子进程脚本：
  - 删 `contained`（38-41）和 44 的调用；
  - 57 的 `parent` 同上；
  - 76、110 列表里的 `'outside_home'` 留着（旧数据无害）。
  - 不带路径的"发现"仍从家目录开始，预算（4000 项、256 个目录、1.2 秒）不变。
  - 指向家目录外的软链接以前被跳过，现在会列出来；`seen` 照旧防环。
- `D/cli/command-error.ts:33` 的 `outside_home` 留着：新 CLI 连旧 daemon 时还会收到。
- `D/cli/index.ts:261` `vonvon dir` 的说明去掉"inside its user's home"。
- 为什么安全：daemon 本来就以这个用户运行，Bot 在完全访问档下本来就能读这些目录。限制只防误点，owner 已确认放开。

### 4.4 "应用与启动"页

#### 4.4.1 `UpdatePanel`（`U/management/UpdatePanel.tsx`）

- 新 props：`appTitle?: string`（默认"Vonvon Bot"）、`server?: ReactNode`（服务端卡，放在应用卡和 `children` 之间）。
- `App.tsx` 远程时传：
  - `appTitle="这台电脑上的 Vonvon Bot 应用"`，`device="这台电脑"`；
  - `version={devicesState.client.version}`：远程时快照的版本是对面的，不能用（U1a 的 `DevicesState.client.version`）；
  - `externalCoreAvailable={false}`；
  - `server={<ServerUpdateCard variant="remote" …/>}`。
- 本机时 `server` 不传，"外部 Core / CLI"照旧在"高级运行设置"里，改由 `ServerUpdateCard variant="local-advanced"` 渲染（I3 分支 `UpdatePanel.tsx:101` 起的那一组原样搬过去）。

#### 4.4.2 `U/management/ServerUpdateCard.tsx`（新）

```ts
export function ServerUpdateCard(props: {
  request: MachineRequestHandler;
  variant: 'local-advanced' | 'remote';
  where: Pick<ActiveDevice, 'isRemote' | 'name'>;
  /** U4 用：bundled 时的按钮。本片不传，bundled 只写文字。 */
  bundled?: (core: CoreUpdate, run: (operation: MachineRequest) => Promise<void>) => ReactNode;
}): JSX.Element;
export const DISTRIBUTION_LABEL: Record<string, string>; // standalone 独立安装的服务端，global-npm 全局 npm 安装，bundled 桌面端自带，其余 其他安装方式
```

- 状态、`run`、每秒跟进度，都从 I3 的 `UpdatePanel` 里搬出来，逻辑不变。
- `canApplyCoreUpdate`、`coreUpdatable`、`coreStatusLine` 仍从 `UpdatePanel.tsx` 导出：I3 的测试引用它们。
- 跟进度的条件从"`distribution.kind === 'standalone'`"放宽成"`reply.type === 'done'` 且 `operation.type === 'applyCoreUpdate'`"，U4 的 bundled 也要跟。
- `local-advanced`：标题"外部 Core / CLI"，文字和 I3 一样。
- `remote`：
  - 标题"「X」的服务端"；
  - 行：版本 `core.current`（没检查过时取 `useActiveDevice().version`）、安装方式 `DISTRIBUTION_LABEL`、可用版本；
  - 按钮"检查更新"（`checkCoreUpdate`）；`canApplyCoreUpdate` 时再给"更新「X」"；
  - 进度条和状态行同 I3；
  - 进入页面时发一次 `checkCoreUpdate { fresh: false }`，读对面每天的检查结果，不另外打更新源。
- bundled 且没有 `bundled` 渲染函数时，写一句"「X」的服务端是桌面端自带的，在那台电脑上的 Vonvon Bot 里更新。"
- 对面没有 `checkCoreUpdate`（v1 或 I3 前的 daemon，回 `unsupported`）：只显示版本，写"「X」上的 Vonvon Bot 不支持远程更新，请在那台设备上升级一次。"
- U1b 的 `MaintenanceView` 改成渲染 `ServerUpdateCard variant="remote"`，外面照旧包 `maintenanceRequest`（U1b 4.7）。顺序是定的：U1（U1a、U1b 一个 PR）先合入，本片依赖 U1a，合入时把维护视图里服务端那一段换掉。U1b 计划 4.7 已写明。

#### 4.4.3 远程时的"后台服务"：`U/management/RemoteServiceGroup.tsx`（新）

在 `App.tsx` 里替换"启动选项"组（远程时）。数据取对面的快照 `snapshot.application`，再读一次 `machine.status`：

```tsx
<SettingsGroup label={`${whereName(where)}的后台服务`} footer={`退出这台电脑上的 Vonvon Bot 不影响${whereName(where)}。`}>
  <SettingsRow title="后台运行" description="重新加载已保存的 Bot 设置" trailing={<Button onClick={restart}>重启</Button>}/>
  <RemoteLoginRow application={application} where={where} busy={busy} onToggle={...}/>
</SettingsGroup>
```

- "重启"发 `restartHost`：它是 `command`，`RemoteServiceGroup` 收 `App` 传的 `onRestart`（同 4.4.4），自己不发。bridge 在转发之前已经 `devices.expect('restart')`（U1a），断开时提示条写"正在重启"。
- `RemoteLoginRow` 按 `application.platform`：
  - `macos`：同 `LoginServiceRow` 的开关；`onToggle` 调 `toggleService(enabled, client, undefined)`（远程时外壳没有 `setLoginItem`，就发 `machine.service install/uninstall`，bridge 按 U1a 4.5 转给对面，见 4.6）。成功后提示条由 bridge 里的 `expect('restart')` 接管。
  - `linux`：标题"登录时启动"，值取 `serviceStep(application).status`，下面写"在那台设备的终端运行 `vonvon service install`"。没开 linger 时（`application.service.linger`）接 `service.hint`。
  - `windows`：标题"登录时启动"，值"不支持"，说明"这一批 Windows 不做登录自启，那台电脑上的 Vonvon Bot 开着时才在线。"
  - 其他：不显示这一行。

#### 4.4.4 `MachinePanel`（`U/management/MachinePanel.tsx`）

- 新 prop `remote?: Pick<ActiveDevice, 'name'>`、`onRestart?: () => void`。
- 有 `remote` 时：
  - 不渲染"启动 daemon"（71）、"服务运行"整行（80-83）、"仅运行指定 Bot"整行（86-93）；
  - "daemon 服务"一行的按钮变成 [重启] 在前、[停止]（`setConfirm({type:'stopHost'})`）在后；
  - [重启] 调新 prop `onRestart?: () => void`。`MachinePanel` 今天只拿到 `request`（`client.machine`），而 `restartHost` 是 `command`（`P/domain.ts:76`），`App` 自己用 `run` 发（`App.tsx:914`）。所以 `App` 传 `onRestart={() => void run({type: 'restartHost'})}`；没传就不显示 [重启]；
  - 确认框（101-104）的正文换成设计第 15 节"远程停止确认"："停止「X」的后台服务？停止后它不会自动重启，只能在那台设备上重新启动。要重新加载请用"重启"。"
  - 页脚（77）换成"这些设置作用在「X」上。"
- 本机的确认框和页脚按 4.7 的退出规则二选一：
  - 照旧停：原文；
  - 不停（`quitKeepsDaemon` 为真）："退出桌面应用不会停止后台：它是另外装的、注册成后台服务的 Vonvon Bot。要停请运行 `vonvon daemon stop`。"
  - `App.tsx:909` 的"启动选项"页脚同样二选一。

### 4.5 Windows 的平台名（设计第 19 节）

- D1 分支 `D/server/snapshot.ts:31` 的 `hostPlatform` 改成 `hostPlatform(platform = process.platform)`，win32 → `'windows'`。serverInfo 和快照同源，所以都跟着变。
- `P/domain.ts:267` 的 `application.platform` 枚举加 `'windows'`。
  - 旧客户端解析新服务端会失败吗？0.8 的客户端按严格 schema 解析快照，收到 `platform: 'windows'` 会失败，所以快照只能发给同协议的客户端。
    - 设计 4.5 和 PROTO-1 要求维护连接不推 `snapshot` 事件，D4a 计划 4.4 也写了，但 D1 分支还没做：`ws.ts:203` 的 `publish` 发给所有 peer，`forProtocol1`（24-29）只去掉 `device` 事件和 `daemonStatus.startedAt`。
    - D2 把 `publish` 从 `ws.ts` 挪进 `D/server/peer-hub.ts`，签名是 `publish(event, shape?)`（D2 计划 4.3），D4a 用 `shape` 对维护连接回 `null`（D4a 计划 4.4）。所以本片在推快照的那一处（`http.ts:148-158`）给 `hub.publish` 传 `shape`：对 `principal.kind === 'maintenance'` 的 peer 回 `null`。不改 `ws.ts` 的 `send`，D2 之后 `publish` 不在那里。D4a 先合入、已经有这一条时不重复。
    - 有了它，快照只到同协议的客户端，而同协议的客户端都来自这一批，认得 `windows`。
- 界面：
  - `DEVICE_TITLE` 换成 `hostTitle`（4.1），`windows` →"这台 Windows 电脑"；`GroupWorkspace.tsx:179` 经 `deviceTitle` 跟着变。
  - 比相等的几处不用改：`LoginServiceRow`（`service-toggle.tsx:43`）仍只认 `macos`；`App.tsx:909` 的页脚用今天非 macOS 的那句；导入 Bridge 只在 macOS。
- `machine.status.service` 和 `D/service/adapter.ts` 在 win32 照旧是不支持（设计第 19 节）。

### 4.6 `DT/bridge.ts`：远程的服务开关

路由归 U1a（U1a 4.5"各通道在远程时"的 `machine` 一条），本片用它：
- 今天 `machine` 通道在转发之前就用 `desktopShellRequestSchema` 把 `service` 拦成 `Shell-owned machine action`（D1 分支 `bridge.ts:251-253`），4.4.3 的远程开关一点就报错。
- U1a 改成：看远程时放行 `service` 的 `install`、`uninstall`，先 `devices.expect('restart')` 再转给对面；看本机照旧拦。daemon 回完就会被助手换掉（I3 分支 `rpc/machine.ts:75-81`），断开显示成"正在重启"，不算"连不上"。
- `service start/stop` 远程时照旧被拦（U1a 4.5），远程页面上也没有入口。
- 本片在 `bridge.ts` 里只加 4.7 的 `quitKeepsDaemon` 通道。

### 4.7 退出规则（设计 7.4 共存第 1 条，2026-11-01 的写法）

**`DT/quit-daemon.ts`：**

```ts
export interface QuitDaemonDependencies {
  // …原有…
  /** 7.4：另外注册成后台服务、又不是桌面端自带的那台，退出只断开。拿不准就是 false（照旧停）。 */
  keep?(owner: VerifiedDaemon): Promise<boolean>;
}
// 循环里 30 行之后：if (await dependencies.keep?.(owner)) return;
```

每一轮都在读到 owner 之后判断：交接中途冒出来的新 owner 也按同一条规则。

**`DT/main.ts`**（269-275 一起组装）：

```ts
const keepOnQuit = async (owner: VerifiedDaemon): Promise<boolean> => {
  try {
    const registration = await managerDependencies.readRegistration();
    if (registration.kind !== 'ours' || !registration.definition || registration.definition.kind === 'desktop') return false;
    const attached = await attachExisting(root);
    try {
      if (attached.identity.pid !== owner.pid || attached.identity.startedAt !== owner.startedAt) return false;
      const reply = await attached.client.admin({ type: 'daemonStatus' });
      return reply.kind === 'daemonStatus' && reply.status.distribution !== undefined && reply.status.distribution.kind !== 'bundled';
    } finally { await attached.dispose(); }
  } catch { return false; }
};
```

为什么三项都要看：
- 注册的种类：看出"另外注册成后台服务"。用 `kind !== 'desktop'`，不点名 `standalone`；I6 删 `standalone` 时这里不用改（设计第 13 节 I6 行写了 I6 在本片之后合入）。
- 在跑的那份的安装方式：服务注册了、却停着时，桌面端可能自己起了一份自带的（detached），那份要停。
- pid 和 `startedAt`：判断时 owner 换了，就不信。

`attachExisting` 遇到协议不同会抛错，落到 `catch` 返回 `false`，照今天停。

- `beforeUpdateInstall`（230-241）不改：只在 win32 停，Windows 上没有服务注册（设计 7.4 第 1 条）。
- 页面用的判断：外壳新增 `quitKeepsDaemon?: () => Promise<boolean>`（通道 `desktop:quit-keeps-daemon`）。主进程读当前已验证的 owner，没有就回 `false`，有就调同一个 `keepOnQuit`。`shellForDevice` 在远程时把它也去掉（U1a 的去掉列表加一项，U1a 计划已改）。
- 页面在"应用与启动"页打开时读一次，用于 4.4.4 的页脚和确认框。读不到当 `false`。

### 4.8 协议不同时说清楚（设计 4.5 最后一条）

- `DT/daemon-manager.ts` 的 `checked(daemon, port)` 多读一次 `readRegistration()`（只在协议不同时读），抛 `protocolMismatchMessage({ server, client: PROTOCOL_VERSION, registration })`。这个纯函数导出，便于测试：
  - 服务端旧，注册的是 `npm`："这台电脑上另外装的 Vonvon Bot 服务端（npm 版）比桌面端旧。运行 `npm i -g vonvon-bot@latest` 再 `vonvon daemon restart`；或者 `vonvon service uninstall` 去掉它，让桌面端用自带的。"
  - 服务端旧，其他情况："正在运行的服务端比桌面端旧，没能自动换掉。退出 Vonvon Bot 再打开一次；还不行就运行 `vonvon daemon stop` 后再打开。"
    - Mac 上启动修复（`login-item.ts:174-190`）本来会先换掉旧的自带服务端，走到这里说明修复没成。
  - 服务端新："正在运行的服务端比这个桌面端新。到 https://vonvon.cc/get/ 下载最新的 Vonvon Bot。"
- `startupMessage`（D1 分支 `DT/main.ts:44-48`）对 `protocol` 原样显示上面的句子。D1 分支 `DT/attach.ts:82` 的注释改成"不同协议在本机启动时是致命的，由 `daemon-manager` 说清楚哪边旧（设计 4.5）"。
- `daemon-dependencies.ts:79-82` 改成："无法确认正在运行的后台服务（PID N）属于这个数据目录。先别关它，检查本机凭据；详情在 daemon.log。"
- **Windows 的启动修复。**
  - 为什么要加：今天 `repairApplies`（`login-item.ts:166-168`）只在 darwin。Windows 上用户手动装新版本时，旧的自带服务端可能还在跑，新桌面端就会卡在协议不同。
  - 改法：`repairApplies` 放开 win32（打包的才算）。`planStartupRepair` 在 win32 只可能得到 `'stop'`，因为 `readRegistration` 在 win32 回 `absent`。
  - 停的时候不经命令行：win32 时 `stop` 用 `stopVerifiedOwner(root, running)`，就是退出时用的那个。
  - Windows 真机在 U4 的 Windows 任务里验。

### 4.9 删除

- **旧 Codex 任务面板：**
  - UI：
    - `App.tsx:894,897` 去掉 `codexJobs`、`codexBusy`；
    - `JobPanel` 的标题（1043-1047）只剩"飞书扫码注册"；
    - `EnvironmentPanel.tsx:22` 的 Props 去掉两项；
    - `SetupChecklist.tsx:37,42,94`；
    - `useProviderSetup.ts:35-36,124-125`：Codex 配好后的自动核验改成跟 Claude 一样，靠"重新检测"；
    - 测试里传 `codexJobs` 的地方跟着删。
  - 协议：
    - `P/domain.ts:75-76` 删两个 command，248 的 job 类型只剩 `registerAgent`；
    - `scripts/verify-built.mjs:18-19`。
  - daemon：
    - `rpc/command.ts:26-27`；
    - `jobs.ts:41,116-128` 删，134 的分支删，139-147 的循环删（`refresh` 只剩过期清理）；
    - `admin/service.ts:129-131,654-659`；
    - `codex-appserver/setup.ts` 的 `start`、`get`、`cancel` 和设备码登录删掉，留 `setup()`、`close()`（`toolsSettled`、关闭顺序在用）。
  - 白名单 `parity-allowlist.ts:26-27` 两条删掉。D1 加的 RPC 种类计数测试减 2。
  - 测试：`server-jobs.test.ts:45-58`、`host-service-shutdown.test.ts:49-59`、`server-service-shutdown.test.ts:40-46`、`rpc-parity.test.ts:43,76`、`web-rpc-coverage.test.ts:151-152,185` 跟着删或改用 `registerAgent`。
- **`AgentProfileSettings`**：`GroupDesignSettings.tsx:252` 起整个函数删掉，连同只被它用的 import。

### 4.10 完全访问警示（设计第 15 节）

- **档位：**
  - `TierInfo`（`types.ts:14-22`）加 `warning?: string`；
  - `TableEnv` 加 `group?: boolean`；`permissionTiers` 只在 `env.group` 时给 `full` 档设 `warning: FULL_ACCESS_WARNING`（从 `@vonvon/protocol` 引入，不另写一份）；
  - `D/admin/settings.ts` 给群（`project` 范围）算权限表时传 `group: true`，私聊（`agent` 范围）不传；
  - 协议 `permissionTierSchema`（`P/settings.ts:137`）加 `warning: z.string().optional()`。
- **保存结果：**
  - `P/settings.ts` 的 `saveSchema` 里 `saved` 加 `warnings: z.array(z.string()).optional()`；
  - `D/admin/settings.ts` 权限分支（936 起）在新的 `effectMode === 'full'` 且原来不是 `full` 时，把 `FULL_ACCESS_WARNING` 放进 `warnings`，1070 回出去。
- **界面：**
  - `PermissionFields`（1053-1074）：完全访问那个选项下面写 `tier.warning`；选中时再在选项组下出一条 `InlineNotice tone="warning"`。
  - `PermissionSummary`（1077-1110）：当前是完全访问时显示同一句。
  - `SettingsPanel.tsx:203` 的 `accept()` 把 `warnings` 和保存成功的提示一起显示。
  - `JoinGroupDialog`：
    - 建群模式加一行"权限 完全访问"，下面接警示。新建的群默认就是完全访问（`lifecycle.ts:224`），今天对话框里看不出来。
    - 绑定已有群的模式不变，照旧"只读（不联网）"。
- **私聊：**
  - `buildPermissionCard`（`dm-cards.ts:1601`）在完全访问选项旁加 `note(FULL_ACCESS_WARNING)`。
  - `handle-message.ts:6427-6432` 保存成完全访问后，多发一条 markdown 写这句。
  - `buildNewProjectDoneCard`（661）在群是完全访问时加同一个 `note`。
- **工具和命令行：**
  - `settings_set`（`command-tools.ts:70-89`）把 `warnings` 放进返回值，工具描述加一句"返回里有 warnings 时，回复里原样告诉用户"。
  - `D/cli/commands/settings.ts:391` 在成功提示后逐行打印 `warnings`，`--json` 时放进输出对象。
  - `group create` 已打印（`group.ts:262-263`），不动。
- **和设计的出入：** 设计第 13 节 U2 行写的"`createProject` 的回复带上"不做。新建的群一律是完全访问，三个入口已经各自写了：
  - 命令行 `group create`；
  - 网页建群对话框；
  - 私聊建群完成卡。
  回复里再加字段没有人读。

### 4.11 serverInfo 的 `update.*` 能力

D1 分支 `D/server/http.ts:65` 的 `capabilities()` 加：`distribution.kind === 'standalone'` 时 `update.standalone`，`global-npm` 时 `update.npm`。安装方式在启动时读一次（`runtimeDistribution()`），之后缓存。U1b 的版本提示和维护视图靠这两项决定给不给按钮（U1b 4.7、4.8），设计 6.5 也写了，但没人报。`update.bundled` 归 U4。

### 4.12 顺序

1. 4.1、4.2 文案，4.5 平台名：纯改字和枚举，先做，测试跟上。
2. 4.3 目录（daemon 先，UI 后）。
3. 4.9 删除（协议 → daemon → UI，一次提交，避免中间状态编不过）。
4. 4.10 完全访问警示（协议 → daemon → UI → 私聊 → 命令行）。
5. 4.4、4.6 应用与启动页、bridge。
6. 4.7 退出规则，4.8 协议提示。
7. 4.11 能力。

## 5. 测试

| 文件 | 用例 | 输入 → 期望 |
|---|---|---|
| `ui/test/device-copy.test.ts`（新） | 设备名 | 本机 → `configureProvider` 不含"在"；远程「Linux 主机」→ 含"在「Linux 主机」上把 Codex 配置好（账号或自定义 API 都行）"；`hostTitle('windows')` → "这台 Windows 电脑"。main 必败 |
| `ui/test/no-login-wording.test.ts`（新） | 用词 | 对 4.2 第一张表里每个文件读源码，去掉含 `lark`、`飞书` 的行后不含"登录"；`search.ts` 只有 98 的别名一处。main 必败 |
| `daemon/test/provider-wording.test.ts`（新） | 用词 | `CLAUDE_SIGNED_OUT_MESSAGE`、`CLAUDE_TURN_SIGNED_OUT_MESSAGE` 不含"登录"；`env.ts` 的 `LOGIN_STATE` 值不含"登录"；`authText`（导出给测试）对 codex、claude 四种状态都不含"登录"。main 必败 |
| 同上 | lark-cli 不变 | `authText` 对 lark-cli：没有 `auth` → "登录状态查不到"；`signedIn` → "已登录"；`unknown` → "登录状态不确定：<原文>"；`signedOut` → "没登录：运行 vonvon env login lark-cli"，四条都和今天一字不差 |
| `ui/test/directory-picker.test.tsx`（改） | 路径识别 | `looksLikePath`：`/srv`、`~/a`、`~`、`C:\\x`、`c:/x`、`\\\\host\\share` 为真；`srv`、`~a`、`C:` 为假。main 必败 |
| 同上 | 远程标题 | `ClientProvider device={远程 X}`、多选 → 标题"添加「X」上的文件夹"；本机 → "添加目录" |
| `daemon/test/server-directory.test.ts`（改 30、31、42、122、129-131） | 家目录外 | `list('/')`（测试里用 `mktemp -d` 建的家目录之外的另一个临时目录）→ 列出；`parent` 在根是 `null`；`choose(家目录外)` 给 token；`list('~')` 等于家目录。原来"家目录外拒绝"的用例改成"能进"。main 必败 |
| 同上 | 建议 | 子进程搜索带家目录外的绝对路径 → 有结果、没有 `outside_home` |
| `daemon/test/cli-dir.test.ts:52-53`（改） | 旧 daemon | 用例名改成"旧 daemon 回 outside_home 时 exit 4"，断言不变 |
| `cli-group.test.ts:215`、`rpc-ownership.test.ts:125`、`client/test/client.test.ts:73-77` | 不改 | 只测错误码映射，`outside_home` 仍是合法的码 |
| `ui/test/server-update-card.test.tsx`（新） | 远程 | `coreUpdate` standalone、有更新 → "「X」的服务端"、"独立安装的服务端"、"更新「X」"可点；`global-npm` 同；bundled → 文字"在那台电脑上的 Vonvon Bot 里更新"、没有按钮；`unsupported` → "不支持远程更新" |
| 同上 | 跟进度 | 点更新回 `done` → 每秒发 `coreUpdateStatus`，到 `done` 停 |
| `ui/test/application-page-remote.test.tsx`（新） | 应用卡 | 远程、`devicesState.client.version = 0.9.1`、快照版本 0.9.0 → 应用卡"这台电脑上的 Vonvon Bot 应用 … v0.9.1"；没有"外部 Core / CLI"；有"「X」的服务端"。main 必败 |
| 同上 | 后台服务组 | macos → 开关；linux → "`vonvon service install`"；windows → "这一批 Windows 不做登录自启"；页脚"退出这台电脑上的 Vonvon Bot 不影响「X」" |
| `ui/test/machine-panel.test.tsx`（改，或 `machine-restart.test.tsx`） | 远程 | `remote` 有值 → 没有"启动 daemon""启动服务""仅运行此 Bot"；按钮顺序 [重启][停止]；点重启 → `onRestart` 调一次、`request` 没收到东西；没传 `onRestart` → 没有 [重启]；点停止 → 确认框是设计第 15 节那句 |
| `ui/test/machine-restart.test.tsx:83,92`（改） | 退出页脚 | `quitKeepsDaemon` 真 → "退出桌面应用不会停止后台"；假 → 原文 |
| `ui/test/service-toggle.test.tsx`（改） | 远程开关 | `shell` 不带 `setLoginItem` → 发 `machine.service install` |
| `desktop/test/bridge.test.ts`（U1a 的） | 服务开关 | 不改：U1a 的"远程的服务开关"一例已经覆盖（远程 `machine {service install}` 先 `devices.expect('restart')` 再到对面，本机照旧拦） |
| `desktop/test/quit-daemon.test.ts`（改） | 不停 | `keep` 回真 → `requestStop` 没被调、返回；`keep` 第一轮假、停完第二轮读到新 owner 且真 → 只停第一个 |
| `desktop/test/quit-keep.test.ts`（新，注入依赖） | 判定 | 注册 `npm` + 在跑 `global-npm` → 真；注册 `desktop` → 假；注册 `npm` + 在跑 `bundled` → 假；`absent` → 假；`attachExisting` 抛 `AttachError('protocol')` → 假；pid 对不上 → 假。main 必败 |
| `desktop/test/daemon-manager.test.ts`（改） | 协议提示 | `server 1`、注册 `npm` → 含 `npm i -g vonvon-bot@latest`；`server 1`、`absent` → 含"退出 Vonvon Bot 再打开"；`server 3` → 含 `vonvon.cc/get` |
| `desktop/test/login-item.test.ts`（改） | Windows 修复 | `platform:'win32'`、packaged、`absent`、在跑 0.8.0、自带 0.9.0 → `'stop'`；没打包 → `'none'` |
| `daemon/test/snapshot.test.ts`（改） | 平台 | `hostPlatform('win32')` → `'windows'`；快照和 serverInfo 一致。main 必败 |
| `protocol/test/domain.test.ts`（改） | 枚举 | `application.platform: 'windows'` 能解析；job 类型 `installCodex` 不能 |
| `daemon/test/server-jobs.test.ts`（改） | 删除 | `command {installCodex}` → `invalid_request`（schema 已没有） |
| `daemon/test/settings-permission-warning.test.ts`（新） | 保存 | 群从 `write` 改 `full` → `saved.warnings` 含 `FULL_ACCESS_WARNING`；`full` 改 `full` → 没有；私聊（DM 范围）的 `full` → 没有。main 必败 |
| 同上 | 档位 | `permissionTiers` 里群的 `full` 有 `warning`，别的档没有 |
| `daemon/test/command-tools.test.ts`（改） | 工具 | `settings_set` 改成 `full` → 返回带 `warnings` |
| `daemon/test/cli-settings.test.ts`（改） | 命令行 | `settings set … --permission full` → 输出第二行是警示；`--json` 有 `warnings` |
| `daemon/test/dm-cards.test.ts`（改） | 卡片 | `buildPermissionCard` 含警示；`buildNewProjectDoneCard` 群是 `full` 时含，`write` 时不含 |
| `ui/test/permission-fields.test.tsx`（新或改） | 界面 | 选项里 `full` 有 `warning` → 渲染出这句；当前是 `full` → `PermissionSummary` 有这句 |
| `ui/test/join-group-dialog.test.tsx`（改） | 建群 | 建群模式 → "权限 完全访问" + 警示；绑定模式 → "只读（不联网）"、没有警示 |
| `daemon/test/peer-hub-maintenance-snapshot.test.ts`（新，D4a 先合入就并进它的 `authz-maintenance.test.ts`） | 维护连接不收快照 | protocol 1 和 protocol 2 的本机连接都连着时 hub `publish` 一条 `snapshot` 事件 → 只有 protocol 2 的收到；protocol 1 的 `admin.daemonStatus` 照常回。main 必败 |
| `daemon/test/server-info.test.ts`（D1 的，改） | 能力 | 注入 `standalone` → `capabilities` 含 `update.standalone`；`global-npm` → `update.npm`；`bundled` → 都没有 |

## 6. 自测和验收

**删除文件的硬规矩**（`~/.claude/CLAUDE.md`，原样照抄）：
- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。

### 6.1 Claude 在 JP-VPS 上

1. 单测：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run <第 5 节列出的文件>`，然后在锁里跑 protocol、daemon、desktop、ui 的 `typecheck`、`lint`、`build`。最后 `rm -rf -- "${T:?}"`。
2. 目录（验收 daemon）：
   - 拿目录锁 `mkdir /tmp/accept-user.d`，写上 `claude <UTC 时间>`；
   - 记下验收 worktree 的 sha，切到 PR 的 sha（detach），构建，重启验收 daemon；
   - `vonvon dir list /srv`、`vonvon dir list /`：列得出，不再是 `outside_home`；
   - 无头浏览器打开网页端 → 建群 → 选目录 → 输入 `/srv` → 能进。
3. 完全访问警示（验收 daemon、Bot 6、#422 正文里的一个测试群）：
   - `vonvon settings set` 把测试群改成完全访问 → 输出第二行是警示；
   - 用 lark-cli 以 owner 身份私聊 Bot 6："把<测试群>的权限改成完全访问" → bot 的回复里有这句；再私聊打开权限卡，完全访问选项旁有这句；
   - 最后把测试群改回原来的档。
4. 旧任务面板删干净：`git grep -n "installCodex\|startCodexLogin\|loginCodex" -- packages scripts` 没有结果（测试快照除外）。
5. 收尾：验收 worktree 切回原来的 sha，重启验收 daemon，放锁 `rm -f /tmp/accept-user.d/owner && rmdir /tmp/accept-user.d`。

### 6.2 Mac 上的 Codex（#322）

和 U1 的验收共用助手 `packages/desktop/test/manual/devices-accept-helper.ts`（U1b 6.2）：JP-VPS 当远程设备，Mac 开发版桌面端连它。U3 合入在先时，这一任务和 U3 的 Mac 验收合成一个任务（U3 第 6 节）。

**网页控制**（Mac 上的网页端连 Mac 上的隔离 daemon，本机模式）能做的：
1. 环境页、Provider 页、建群对话框、群设置、诊断页、用量页：页面上搜不到"登录 Codex""登录 Claude""请先登录"这类字；lark-cli 那一行是"登录飞书"。
2. 建群对话框有"权限 完全访问"和警示；群设置的执行权限选完全访问有警示，保存后的提示里也有。
3. 目录：建群 → 选目录 → 输入 `/Applications` 能进（家目录外），输入 `~/` 回到家目录。

**Computer Use**（开发版桌面端，远程模式和退出都在外壳里）：
4. 切到 JP-VPS 那台：
   - 环境页顶部写"这里装的、检查的都是「验收设备 1」上的…"；
   - 装 lark-cli 的确认框写"在「验收设备 1」上安装"；
   - 选目录的标题"选择「验收设备 1」上的文件夹"，输入 `/srv` 能进。
5. 应用与启动：
   - 上面是"这台电脑上的 Vonvon Bot 应用"，版本是 Mac 开发版的；
   - 下面"「验收设备 1」的服务端"写安装方式；
   - "「验收设备 1」的后台服务"：Linux 那一行写 `vonvon service install`；
   - 没有"启动 daemon""启动服务""仅运行此 Bot"；
   - 点停止 → 确认框是第 15 节那句 → 取消。
6. 点"重启"：提示条"正在重启"，30 秒内"重启过了，已重新连上"。
7. 退出（本机自带的）：切回这台电脑，退出开发版桌面端 → `VONVON_HOME=<临时目录>/vh vonvon daemon status` 显示已停。
8. 退出（另外装的 npm 版，注册成后台服务）：
   - 在本任务的临时 worktree 里构建后 `npm pack` 出 daemon 包（`vonvon-bot`），`npm i -g --prefix <临时目录>/npm <包>`；
   - `VONVON_HOME=<临时目录>/vh2 <临时目录>/npm/bin/vonvon service install`；
   - 用 `VONVON_DESKTOP_TEST_HOME=<临时目录>/desk2 VONVON_HOME=<临时目录>/vh2` 起开发版桌面端，它连上这份；"应用与启动"页脚写"退出桌面应用不会停止后台…"；
   - 退出桌面端 → `VONVON_HOME=<临时目录>/vh2 <临时目录>/npm/bin/vonvon daemon status` 仍在运行；
   - 收尾：`VONVON_HOME=<临时目录>/vh2 <临时目录>/npm/bin/vonvon service uninstall`，确认 `launchctl list` 里没有带这个数据目录哈希的任务。
   - 碰 launchd 的命令都带 `VONVON_HOME`，且不是 `$HOME/.vonvon-bot`（AGENTS.md"每个任务都按下面的规则跑"）。

提示词贴进 PR，任务贴 #322，任务号用 `next-mac-task.sh` 取。提示词写清：
- 第 0 步查开始和结果标记；开始前、每次 push 前都看有没有取消。
- 隔离：临时 worktree 取 PR 的 sha；开发版桌面端和 daemon 的前缀照 #322 正文"Mac 的测试环境"，不 export。
- 不碰：owner 的 `/Applications/Vonvon Bot.app`、`~/.vonvon-bot`、`com.vonvon.bot.daemon`、bridge 和它的数据、飞书客户端。
- 上面三条删除规矩原样写进去。
- 结果评论的标记；打码：不贴链接、地址、群名、完整 id。

Windows 的平台名和 4.8 的 Windows 启动修复，放进 U4 的 Windows 任务（#631）一起验：Windows 桌面端当被连的设备时，Mac 那边的"应用与启动"写"这台 Windows 电脑"和 Windows 那一行。

## 7. 文档

本计划的 PR 里已改：
- 设计 6.4："现有带登录的文案"那串位置后面加一句：lark-cli 的几处是飞书登录，保留；daemon 里的提示一起改，见本计划 4.2。
- 设计第 15 节加三行：
  - "远程设备的后台服务（页脚）"；
  - "退出桌面端不停另外装的后台服务（页脚和确认框）"；
  - "本机服务端协议不同（三种）"。
- 设计 4.5 末尾注明"本机协议不同时的提示文字见 U2 计划 4.8"。

实现 PR 里改：
- `docs/product.md` 3.10：退出桌面端那句加"另外注册成后台服务的 npm 版不停"。
- `docs/product.md` 3.14：远程时目录、Provider 的说法。
- 合入时在设计第 13 节 U2 行标"已合入"。

## 8. 验收要点

1. 远程时每处 Provider、工具、目录的文案都带"「X」"，本机不带。
2. Provider 相关的界面和 daemon 提示里没有"登录"，有"账号或自定义 API 都行"；飞书登录的几处保留，写明"飞书"。
3. 家目录限制在浏览和搜索建议两处都去掉；默认起点仍是家目录；`outside_home` 只为旧 daemon 留着。
4. 远程时应用卡的版本取客户端自己的，不取快照。
5. 远程时"启动 daemon""启动服务""仅运行此 Bot"不渲染，不只是灰掉。
6. 远程的服务开关和重启都先 `devices.expect('restart')`（U1a 的 bridge 做，本片的界面走到它）；维护连接收不到快照，旧客户端不会因为 `windows` 解析失败。
7. 退出规则只看三件事：注册种类不是 `desktop`、在跑的不是 `bundled`、owner 没换。拿不准一律照旧停；`beforeUpdateInstall` 没动。
8. 协议不同的提示分三种，说清楚哪边旧、该运行什么。
9. `installCodex`、`startCodexLogin`、`loginCodex` 在协议、daemon、UI、白名单里都没有了，RPC 种类计数减 2。
10. 完全访问警示只在群的 `full` 档出现，文字只有 `FULL_ACCESS_WARNING` 一份；界面、私聊卡片、bot 回复、`settings set` 都带。
11. `update.standalone`、`update.npm` 由 daemon 报出，`bundled` 不报。
12. diff 里没有真实 id、密钥、本机路径和地址；示例路径只用 `/srv`、`C:\work` 这类通用写法。

## 9. 风险和行数

- 估计约 1,700 行（原估 ~1,300）：
  - 文案（两张表和用词测试）250、目录 120、应用与启动页（`ServerUpdateCard`、后台服务组、`MachinePanel`、`UpdatePanel`）380、平台名 40、bridge 20、退出规则 120、协议提示和 Windows 修复 120、删除（净减，计改动行）250、完全访问警示 300、能力 30；
  - 测试约 600，压缩写，不计在上面。
  - 多出来的是 daemon 里的 Provider 文案（设计没列）、`ServerUpdateCard` 的抽取，和退出规则的页面提示。
- 超过 1,500，审查按模块分三份：
  - daemon + protocol：文案、目录、删除、警示、能力；
  - desktop：退出、协议提示、Windows 修复、bridge；
  - UI。
  再加一个读整个 diff 的。退出和启动修复碰到关闭顺序和子进程，加一轮多角度审查（AGENTS.md）。
- **放开家目录：** Bot 在只读、可写档下的沙箱不看这个浏览器，限制只影响选目录的界面。风险是用户在远程设备上选了系统目录当工作区，这本来就是 owner 接受的。
- **`keepOnQuit` 多一次 attach：** 退出时多一次本机连接，最多几百毫秒。失败就当 `false`，退回今天的行为。
- **Windows 启动修复**只在 Windows 真机上见效，靠单测 + U4 的 Windows 任务。修复失败的提示走已有的 `repairNotice`，不会让桌面端起不来。
- **删旧任务面板：** 网页端早就不发这两个 command，CLI 也没有对应命令（白名单标 dead），所以没有现存用户受影响。旧网页端连新 daemon 发这两个，会得到 `invalid_request`。

## 10. 审查后改了什么

2026-11-02，#640 上 Sonnet 审查（读整个 diff 一位，读 U2–U4 一位）。下面每条都接受了：

- 原来写"U1b、本片哪个先合入都行"，可本片依赖 U1a，U1a、U1b 又是一个 PR，"本片先合入"不会发生。改成定序：U1 先合入，本片把 U1b 维护视图里服务端那一段换成 `ServerUpdateCard variant="remote"`（第 1 节依赖、4.4.2）。
- 维护连接不收快照原来写在 `ws.ts` 的 `send` 里，可 D2 把 `publish` 挪进了 `peer-hub.ts`，D4a 用它的 `shape` 做同一件事。改成在推快照那一处传 `shape`，D4a 已做就不重复（第 2 节、4.5、第 5 节测试名）。
- `MachinePanel` 只拿到 `request`（`machine` 通道），可 `restartHost` 是 `command`，计划没说 [重启] 怎么发。加 `onRestart` prop，`RemoteServiceGroup` 同样收它（4.4.3、4.4.4、第 5 节）。
- I3 拆成 I3a、I3b 后，计划里钉的 `server-3-update-engine`（4aca3777）和行号过期，D1 的 sha 也旧了。头部改成 I3b（83550082）和 D1（147b2619），`UpdatePanel` 那一组从 101 行起，`rpc/machine.ts` 的服务开关在 75-81。

## 11. 实现时和计划不一样的地方

2026-11-02 实现时（Claude，JP-VPS）。基线是 U1（`claude/devices-ui-1` 3ed5f8b6）合上 `claude/devices-integration`（含 I3）。

**文案和目录**
- 4.2 的表以外，`P/setup-steps.ts`、`P/diagnostics.ts` 里 Codex、Claude 的"登录"也改成"配置好""可用"：这两处的字由网页端的设置清单和诊断页显示，不改的话第 8 节第 2 条做不到。
- `search.ts` 里留下的"登录"有两处：别名那一行，和"登录电脑时启动"。后者说的是系统登录项，不是 Provider 登录，用词测试把它也放过。
- 表外 `GroupDesignSettings` 可用模型那一栏的校验提示也改了："这个 Provider 现在不可用，先（在「X」上）安装并配置好。"原来写"请先安装并登录"。
- `DirectorySearchStep` 不自己判断是不是路径，交给 `directory-picker` 导出的 `browseQuery`，和选目录对话框同一条规则。

**删除（4.9）**
- `JobPanel` 整个删掉，不留"飞书扫码注册"的标题：基线上它只在环境页给 `installCodex` 任务用，删了任务就没有别的地方渲染它。
- `installManagedCodex` 这个导出留着：删掉任务后它没有调用方了，但同一模块的 `managedCodexBin`、`runSetupChild` 还在用，它自己也有测试。删不删留给以后清理。

**应用与启动页（4.4）**
- 抽出 `appCardFor(device, application, clientVersion)`，远程和本机的应用卡标题、设备名、版本都由它算，页面接线才测得到。计划里整页渲染的测试改成渲染 `UpdatePanel` + `RemoteServiceGroup`。
- `RemoteServiceGroup` 不另外读 `machine.status`，用快照里的 `application`（平台、`service`、linger），和本机的"启动选项"同一份数据。
- `ServerUpdateCard` 远程时打开就读一次 `checkCoreUpdate {fresh: false}`（只读那台设备每天检查的结果，不重新问更新源）；回 `unsupported` 或 `invalid_request`（I3 以前的服务端）就显示"不支持远程更新"那句。
- 页面上"退出桌面应用不会停止后台"那句的命令用 `<code>` 显示，文字拆成 `QUIT_KEEPS_DAEMON` 的前、命令、后三段，字和第 15 节一样。

**退出规则（4.7）**
- `keepOnQuit` 的判断写成 `quit-daemon.ts` 导出的 `daemonKeptOnQuit(owner, {readRegistration, attach})`，`main.ts` 只组装依赖。原因是要注入依赖测它；计划里的 `quit-keep.test.ts` 并进了 `quit-daemon.test.ts`。
- 页面用的 `quitKeepsDaemon` 通道：主进程读已验证的 owner（`readVerifiedDaemon`），读不到回 `false`。

**协议提示和 Windows 修复（4.8）**
- `startupMessage` 遇到 `AttachError('protocol')`（带对面的协议号）时也用 `protocolMismatchMessage`。这条路上拿不到注册信息，按 `absent` 算，所以服务端旧时显示"退出再打开"那句，不是 npm 那句。
- Windows 修复不经命令行停：`stopOwnerDirectly` 调 `stopVerifiedOwner`，再用读进来的 `ownerRunning` 等它退出，最多 60 秒。

**完全访问警示（4.10）**
- 私聊建群完成卡：群的实际权限是完全访问就显示（新建的群就是），不另看是不是刚改的。
- 私聊权限卡：选项里有完全访问时，在表单下面加一条 `note`，写"完全访问："加这句，不放在选项旁边。
- 私聊里保存权限后多发的那条 markdown，只在从别的档改成完全访问时发；本来就是完全访问再保存一次不发。
- 命令行逐行打印 `warnings`，不加反引号。

**能力（4.11）**
- 安装方式在启动时不等它读完：读完前 `serverInfo` 不带 `update.*`，读完后缓存。启动后最初那一下连上来的客户端看不到升级按钮，重连就有（写进已知限制）。
- 测试夹具 `startFixture` 多一个 `distribution` 参数，默认 `unknown`，免得每个用例都去跑 `npm root -g`。

**维护连接不收快照**
- 在 `http.ts` 推快照那一处传 `snapshotShape`：维护连接的 peer 回 `null`。测试写成对 `snapshotShape` 的单测，放进 `peer-hub.test.ts`，没有另起两条真连接。

**测试文件名**
- 第 5 节的几个新文件并进了已有的：`no-login-wording` → `device-copy.test.ts`；`settings-permission-warning` → `settings-owner.test.ts`；`command-tools` → `s47-tools.test.ts`；`cli-settings` → `cli-admin.test.ts`；`dm-cards` → `permissions.test.ts`；`permission-fields` → `permission-tiers.test.tsx`；`join-group-dialog` → `join-group.test.ts`；`server-info` → `server-handshake.test.ts`；`snapshot` → `server-snapshot.test.ts`；`domain` → `protocol.test.ts`；`machine-panel` → 新的 `machine-panel-remote.test.tsx`（退出页脚的两种也在这里）；`directory-picker` → `directory-picker-runtime.test.tsx`（远程标题）和 `device-copy.test.ts`（`looksLikePath`）。
- U1 已有的 `bot-schedules-app.test.tsx` 在合上 U1 后就挂了（它 mock 的 `client-context` 没有 `useActiveDevice`），本片顺手补上。

**没做的自测**
- 6.1 第 2、3、5 步（验收 daemon 上的目录、lark-cli 私聊 Bot 6 看警示）这次没做：这次的任务不碰验收 daemon、不发飞书消息。换成无头截图（`packages/ui/test/manual/remote-mode-fake-shell.ts`，假外壳）和单测。第 4 步的 `git grep` 做了，只剩测试里断言"已经没有了"的几处。

## 12. Codex 审查后改了什么（任务 244–246）

2026-11-02，Codex 在 JP-VPS 上审了 head 95e21996：任务 244 通读 U2 全部改动，245 看 desktop，246 看 ui。245 通过；244、246 的三条 P2 都接受了：

- **244-1 远程设备的「状态与诊断」页仍把工具说成这台电脑的。** 那一组叫「这台电脑」，按钮「查看本机环境」，说明是「在终端运行 codex 配置好……」「在本机环境里安装 Claude Agent SDK」，用户会去桌面所在的电脑上配。`P/setup-steps.ts` 的 `toolSteps` 不动（它不知道在看哪台设备），由页面读 `useActiveDevice()` 改写：`U/device-copy.ts` 加 `onDeviceText`（本机环境 → 「X」的「工具与连接」，本机的 → 「X」上的，在终端运行 → 在「X」的终端运行，一遍替换，设备名里有"本机"也不会再换）和 `toolStepsOn`（每步的说明和去工具页的按钮「查看「X」的工具」）；`DiagnosticsPanel` 的组名用 `whereName`，页脚写「「X」上的 Provider 每分钟检查一次……」。daemon 自己给的 Claude 提示（`login.ts` 的"在终端运行 `claude` ……"）也经它带上设备名。本机一字不改。测试：`diagnostics-panel.test.tsx` 的 `the tools of a remote device` 三例（signedOut/missing、Codex 缺失和太旧加 daemon 的 Claude 提示、本机原样），`device-copy.test.ts` 把 `toolSteps` 每种状态在远程时都过一遍，不许出现"本机"。
- **246-1 远程升级卡片重新挂载后不恢复进度。** 离开再回来、或者另一个客户端已经发起了升级，卡片只查 `checkCoreUpdate`，`following` 从 false 开始，进度没了、「更新「X」」又能点。`ServerUpdateCard` 远程时打开就同时读一次 `coreUpdateStatus`：没结束就接着每秒跟、进度条和状态行照旧、更新按钮不可点；已结束就显示结果（更新完成和版本，或者失败的原因）；没有记录什么都不显示。回滚的原因里没写"已切回"时，状态行补"（已切回 X）"，和 `vonvon update` 一样。测试：新的 `server-update-card-lifecycle.test.tsx`，它的 hook 替身照 React 的规则只在依赖变了时重跑 effect、先跑清理，四例：同一张卡跟到结束、离开再回来接着跟到结束（离开后不再轮询）、连上别人已经在升级的设备并看到回滚原因、打开时更新已结束只显示结果不轮询。原来 `server-update-card.test.tsx` 里"每秒跟到结束"那一例的替身每次渲染都重跑所有 effect，开头这次读会被重复，挪进了新文件。
- **246-2 远程 Provider 详情仍写本机配置和本机的修复办法。** `ProviderSetup` 远程时：「「X」上的配置」「已读取「X」上的配置」「「X」上的 Claude Code 无法启动。请先在「X」的终端运行 `claude`……Vonvon 会复用「X」上 Claude 的认证或 API 配置」、安装来源「「X」上已有」、卸载确认「「X」上的其他安装不受影响」；daemon 给的问题提示、Codex 的更新办法（如"请在终端运行 brew upgrade codex"）和操作结果也经 `onDeviceText`。同类的一起改了，都只在远程时换字：`EnvironmentPanel` 的「本机工具」组名、重新检测的提示、"正在检测本机工具…"和页面通知；`UsagePanel` 错误分支「检测本机配置」；`UsageContent`「所有 Bot 共用本机 Codex 账号的用量」；设置首页 Provider 一项的说明；MCP 授权「在本机终端运行命令」和移除确认「只移除本机配置」；工作区目录「移除引用，保留本机文件」和解除绑定的「本地目录和文件保留」。测试：新的 `provider-remote.test.tsx` 三例（远程 Claude Code 起不来、远程的 daemon 提示和 Homebrew 更新办法、本机原样），用真 React 渲染，只把发 RPC 的 `useProviderSetup` 换成固定数据。`mcp-runtime.test.tsx` 的 `client-context` mock 补上 `useActiveDevice`（MCP 面板现在读当前设备）。

## 13. 合入 U1 和集成分支

2026-11-02 先合 `claude/devices-ui-1`（5d0404ce，带 D2、D4a、D4b、I3 和 U1 补的两个测试），再合 `claude/devices-integration`（63ab38a6，多了 K1 内置 Skill 的 `--scope`，没有冲突）。冲突照两边的意思合：
- `D/server/http.ts`：D4a 按连接给事件（`viewFor`）已经不给维护连接任何东西，U2 的 `snapshotShape` 去掉；第 11 节"维护连接不收快照"的单测改成用 `viewFor` 建 hub。`capabilities()` 保留 D4a 的 `session-scope`，再按安装方式加 `update.standalone`、`update.npm`。
- `D/server/authz.ts`：用 D4a 的按场合的表，去掉 U2 删了的 `installCodex`、`startCodexLogin`（表里的行和 `commandInReach` 里的分支）；`authz-session.test.ts` 用 `restartHost` 代替 `installCodex` 当"整台机器的命令"。
- `D/test/server-fixture.ts`：`askBot` 仍是第 4 个参数，`distribution` 挪到第 5 个；握手测试期望 `['device', 'session-scope', ...update]`。
- `D/server/message-loop.ts` 用 D4a 的 `errorEnvelope`（同一份 `DRAIN_KINDS`）；`U/test/bot-schedules-app.test.tsx` 用 U1 的 mock（真模块上只换 hook）。
- 合完 desktop、ui 的测试都过，没有 U1 那样的语义冲突要修：U2 的退出规则（`quit-daemon.ts`）和 U1 在 `main.ts` 接的设备连接、退出顺序各管各的。

## 14. 合入集成分支前同步，本机页面写"本机"

2026-11-02 合 `claude/devices-integration`（eb6d55a6，多了 D3 #646 远程监听、U1 #647、C5 #651 记忆走 daemon）。冲突照两边的意思合：
- `D/server/http.ts`：D3 把 `capabilities()` 挪进 `startApi`，按有没有开远程地址加 `remote`；U2 的在模块里，按安装方式加 `update.*`。合成一个导出的 `capabilities(distribution, remoteOpen)`：`device`、`session-scope`，开着远程地址时 `remote`，再按安装方式 `update.standalone` 或 `update.npm`。`startApi` 两个参数都收。
- `D/test/server-fixture.ts`：D3 的 `remote` 是第 4 个参数，`askBot` 第 5 个，`distribution` 挪到第 6 个；握手测试跟着改。
- `P/test/rpc-kinds.test.ts`：C5 加了 `memory.branchDelete`（152），减去 U2 删的两个 Codex 命令，是 150。

D3 的排空规则（排空时 `snapshot.get`、`admin.negotiate`、`machine.coreUpdateStatus` 等照答，其余回 `draining`、不断开）和 U2 对得上：桌面重连后要快照、远程升级卡片每秒读 `coreUpdateStatus` 都在白名单里；退出时问 `daemonStatus` 也在，排空中的回复不带安装方式，`daemonKeptOnQuit` 就按"拿不准"处理，照旧停。只有一处要改：远程升级卡片打开时自己查一次 `checkCoreUpdate`，排空中会被回 `draining`，以前当成错误显示一行"daemon 正在停止或重启…"。现在这一次不显示，状态行已经在说正在升级；手动点"检查更新"仍照常显示。

**本机页面写"本机"（owner 2026-11-02）。** 第 1 节写的"本机照旧，不带设备名"改了：看远程设备时写"「X」"，看这台电脑时写"本机"。
- `U/device-copy.ts`：`whereName` 本机时是"本机"（设备列表里这台照旧叫"这台电脑"，那是 U1 的 `deviceCopyName`）；`onDevice` 两边都是"在 … 上"，`configureProvider` 本机是"在本机上把 Codex 配置好（账号或自定义 API 都行），然后点「重新检测」。"；新加 `placeOf`（本机 /「X」上）和 `updateServerText`。用到它们的地方本机都跟着写"本机"：选目录标题"选择本机上的文件夹"、建群时的"本机上的目录"、解除绑定的"本机上的目录和文件保留"、诊断页的组名"本机"和页脚"本机上的 Provider 每分钟检查一次…"、更新托管副本的确认框"Vonvon 将在本机安装并验证新版本…"、各处"先在本机上安装并配置好"。
- 原来写死"本机"、看远程时也这么说的，改成远程写「X」：
  - 决策模型：填 key 的对话框"密钥仅保存在「X」上"，删除确认"只删「X」上存的这一份"，诊断页"「X」上还没填它的 key"（`secretsModel` 的 `removalCopy`、`keyDiagnosis` 加 `place` 参数），自定义接口说明"供「X」上使用该服务的 Bot 和群共用"，服务端太旧时"请更新并重新连接「X」上的服务"（群设置里也是这句）；
  - 判断次数页脚"按「X」的日期统计"；上下文面板"智能判断交给「X」上的决策模型"；
  - 主页面连上前"正在读取「X」的运行状态"；导入 Bridge"正在检查 Bot、群和「X」上的数据"；
  - MCP 的连接方式"「X」上的命令"（本机照旧"本机命令"），daemon 回的 MCP 错误经 `onDeviceText`；
  - "工具与连接"页的区域名，工具卡的无障碍名；
  - "连接与设置"页的工具步骤（"去本机环境"那些）和诊断页"最近没回的消息"的下一步（"在本机环境里更新 Codex"）经 `toolStepsOn`、`onDeviceText`，和状态与诊断页的工具一样；
  - 远程升级卡片的状态行和提示经 `onDeviceText`（服务端说"本机没有 0.9.1"说的是它自己）。
- 不跟设备的：通用确认框的默认说明改成"请确认后再继续；取消不会做任何修改。"；搜索里"重新检测"那一组从"本机环境"改叫"工具与连接"（锚点跟着改），"本机环境"留作搜索词。
- 没改的：`main.tsx` 没凭证时的"需要本机访问凭证"（那时还没连任何设备）；搜索里状态与诊断那一组仍叫"这台电脑"（静态索引，不跟当前设备）；daemon 自己的其他提示（模型目录说明"使用本机保存的模型目录"等）原样显示，远程时也写"本机"，指的是那台设备自己。
- 测试：`device-copy.test.ts`（本机的说法和新函数）、`diagnostics-panel.test.tsx`（本机组名和页脚；远程"没回的消息"的下一步）、`setup-presentation.test.tsx`（远程的工具步骤）、`secrets-page.test.tsx`（远程的填、删、诊断）、`decision-provider-settings.test.tsx`、`judge-usage.test.tsx`、`mcp-presentation.test.tsx`、`memory-new-marks.test.tsx`、`directory-picker-runtime.test.tsx`（本机标题），`server-update-card-lifecycle.test.tsx` 加"排空中打开卡片"一例。`decision-provider-autosave.test.tsx` 的 `client-context` mock 改成在真模块上只换 hook。
