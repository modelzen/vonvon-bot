# v2 main（be17859）里 v1 能留什么、要改什么

调研日期 2026-10-14。只读：没有改任何仓库，没有跑构建和测试，gh 只做了查询。路径默认相对 `/home/operator/vonvon/vonvon-bot`，`daemon/src/...` 指 `packages/daemon/src/...`。标 `推断` 的是我的判断，标 `未知` 的是查不到或要实测的。人设、记忆、技能怎么接进 Codex 和 Claude，见同目录的 `persona-memory-skills.md` 和 `agent-mechanics.md`，这里不重复。

本版在同名旧稿上逐条复核过引用，并补了这些内容：群回复模式、后台服务按钮的 bug、bridge 老用户现有的 launchd 自启、桌面端对服务代码的依赖、#226 里能复用的部分。

## 结论

1. **飞书端运行内核可以整体保留。** 它从 bridge `446b2a4` 复制而来（`docs/roadmap.md:12`）。在本机 bridge 检出里核对过：0.6.14（`6698118`）是 `446b2a4` 的祖先，`446b2a4` 比它多 49 个提交，位于 `codex/device-handoff` 分支（`git merge-base --is-ancestor`、`git rev-list --count`）。bridge 老用户在用的群、话题、卡片、命令、咖啡一下、文档评论、语音、完成提醒，v2 里都有。这部分是 `bot`、`card`、`agent`、`project`、`config`、`admin`、`cli-bridge`、`voice` 几个目录，合计约 3.27 万行（`wc -l`，不含生成的协议文件）。
2. **离新 bot 模型最远的是数据模型。** 现在是"一个群对应一个目录"：
   - bot 只有名字、appId、租户和启用开关（`daemon/src/config/bots.ts:9-25`）；
   - 每个（bot，群）一条 `Project`，只有一个 `cwd`（`daemon/src/project/registry.ts:8-72`）；
   - 没有 bot 级工作区，没有仓库列表，没有技能、记忆和人设。

   好消息是设置已经分成主机、bot、群、会话四层（`packages/protocol/src/settings.ts:87-104`）。"bot 默认值加群内覆盖"可以直接挂在 bot 层和群层上。
3. **群回复模式已经有两档，正好是 owner 要的基础层。** "仅 @ 时回复"和"全部回复"就是 `response: mention | all`（`packages/protocol/src/domain.ts:72`、`:120`），存为 `Project.noMention`（`registry.ts:26-28`）。"智能回复"是第三档，要新做。
4. **macOS 桌面端已经能打开、能用。** 要交给用户还缺四样：公证过的 dmg 和下载地址、开机自启（现在开关和 `service install` 都会被拒绝）、更新源（现在是空的）、首次运行时导入 bridge。
5. **为三平台、远程和新 provider 层写的大量代码，v1 用不上。** 包括 Windows 服务和进程监管、systemd 和 Gate L、launchd 服务事务和 Gate M、holder 进程、V6b 以后的 provider 切换。合计约 4,650 行源码、约 7,850 行测试（第 7 节）。账号和中继一行代码都还没写，界面也不依赖它们。
6. **main 上没有能用的 bridge 导入。** 唯一的实现是草稿 PR #226（V8 导入事务），已暂停。它的预检、Hook 改写、旧密钥解密几块可以复用（第 5 节）。
7. **provider 方面，v1 能直接用的是 main 上的旧 `agent/` 路径，有 Codex 和 Claude 两个。** Cursor、Grok、Pi 没有代码。新的 provider 层（V6a）已全部合入，但还没接管 agent。负责接管的 V6b 1/14（#281）已暂停，而且它合入后打包版的 Codex 会失败。

---

## 1. 现在的数据模型

### Bot

- 注册表是 `~/.vonvon-bot/bots.json`（`daemon/src/config/paths.ts:55`）。数据根默认 `~/.vonvon-bot`，可用 `VONVON_HOME` 覆盖（`daemon/src/config/data-root.ts:19-24`）。
- 每条 `BotEntry` 有 `name`、`appId`、`tenant`、`botName`、`createdAt`、`active`（`bots.ts:9-25`）。可以同时启用多个 bot，每个 bot 一个进程（`bots.ts:17-24`、`:108-113`）。
- 每个 bot 一个目录 `bots/<appId>/`，里面有 `config.json`、`projects.json`、`sessions.json`、`processes.json`、`comment-instructions.md`、`comments/`、`outbound-files/`（`paths.ts:20-87`）。
- bot 级偏好 `AppPreferences`（`daemon/src/config/schema.ts:84-131`）包括：
  - 访问控制：`ownerOpenId`、`admins`、`allowedChats`；
  - 空白项目父目录 `projectsRootDir`；
  - 回复样式、并发数、空闲超时、插话或排队、完成提醒；
  - 咖啡一下（本机 CLI 桥）、文档评论、会话标题、语音。
- 名称和头像从飞书读取，界面快照里只有 `name` 和 `avatarDataUrl`（`packages/protocol/src/domain.ts:111-115`）。

### 群绑定（Project）

- 一个 bot 在一个群里的绑定是一条 `Project`（`registry.ts:8-72`）。字段有：
  - `name`、`chatId`、`cwd`、`blank`；
  - `kind`：多话题或单会话；`noMention`：免 @；
  - `origin`：bot 建的群还是被拉进的群；`addedBy`；
  - `allowedUsers`：群内白名单；
  - `mode`、`guestMode`、`network`：权限；
  - `autoCompact`、`backend`、`defaultModel`、`defaultEffort`。
- 同一个 bot 里，项目名和 `chatId` 都不能重复（`registry.ts:191-200`）。
- 同一个群可以绑多个 bot，各自记在自己 bot 的 `projects.json` 里。界面上叫 Membership，只有一个 `directory` 字段（`domain.ts:117-123`）。界面文案也写明"同一个群可以有多个 Bot，各自保留工作目录和群内配置"（`packages/ui/src/App.tsx:512`）。
- 会话记录 `SessionRecord` 以话题 `threadId` 为键，记下创建时的 `cwd`、`sessionId`、`backend`、`model`、`effort`（`daemon/src/bot/session-store.ts:13-39`）。所以以后改了目录，老会话还会用老目录（推断）。

### 项目目录

- 绑定时二选一：选一个已有文件夹，或在 `<projectsRootDir>/<项目名>` 下新建空白目录（`daemon/src/project/lifecycle.ts:90-103`）。
- 默认父目录是 `~/.vonvon-bot/projects`，所有 bot 共用（`paths.ts:114-115`）。每个 bot 可以改（`settings.ts:69`；`lifecycle.ts:110-125`）。
- 界面里只有"新建飞书群"能用默认空白目录。"绑定已加入的群"必须选文件夹（`packages/ui/src/JoinGroupDialog.tsx:89-94`）。协议的 `bindGroup` 把 `folderToken` 设为必填（`domain.ts:52-67`）。

### 权限档位

- 三档：`qa` 只读、`write` 读写，两档都限制在项目目录内；`full` 是整机加网络（`daemon/src/agent/types.ts:20-29`）。
- 管理员和普通成员可以分档。分档后两者用不同的 agent 线程（`registry.ts:39-47`、`:115-126`）。
- 老数据没有 `mode` 时按 `full` 处理（`registry.ts:93-95`）。没有项目策略时默认 `write`（`types.ts:35`）。
- Codex 的 `qa` 和 `write` 在 macOS 上由 Seatbelt 强制执行。Linux 上限制不住读取，所以这两档在 Linux 上拒绝启动（`daemon/src/agent/codex-appserver/backend.ts:32-53`、`:78-82`）。
- Codex 的权限配置只放了一个工作区根，也就是 `cwd`（`codex-appserver/backend.ts:83-96` 的 `':workspace_roots': { '.': … }`）。

### 群回复模式

- 协议里是 `mention | all`（`domain.ts:72`、`:120`），存为 `noMention`（`registry.ts:26-28`）。
- 默认值：被拉进的已有群如果是单会话群，默认关掉免 @；其他情况默认打开（`registry.ts:83-85`）。
- 多话题群开了免 @，也只在话题里免 @。主区闲聊仍要 @，命令和 `/goal` 除外（`daemon/src/bot/handle-message.ts:1189-1203`）。
- 消息只要 @ 了全体或 @ 了别人（包括别的 bot），这个 bot 就不接（`handle-message.ts:1199`）。原因是 SDK 只把"@ 的是自己"标成 `isBot`（`node_modules/@larksuiteoapi/node-sdk/lib/index.js:98305`）。
- 推断：一条不带 @ 的消息发到一个群，群里所有开了免 @ 的 bot 都会回。现在 bot 收不到别的 bot 的消息，因为没申请 `include_bot` 类权限（`daemon/src/config/scopes.ts:18-38`），所以不会互相触发、形成循环。
- `schema.ts:115-116` 里的 bot 级开关 `requireMentionInGroup` 和它的读取函数（`schema.ts:232-234`）没有任何调用方，是死代码（grep 结果）。

### 设置作用域

- 四层：`host`、`agent`（即 bot）、`project`（bot 加群）、`session`（`settings.ts:87-104`）。
- 各层的段（`settings.ts:52-85`）：
  - bot 层：`cards`、`run`、`completion`、`cliBridge`、`comments`、`titles`、`paths`、`access`；
  - 群层：`permission`、`response`、`compact`、`model`；
  - 会话层：`model`；
  - 主机层：`execution`，即 Codex 可执行文件路径。
- bot 视图里另有一块可编辑的 markdown，`commentInstructions`（`settings.ts:185-193`），落在 `bots/<appId>/comment-instructions.md`（`daemon/src/admin/settings-service.ts:50`）。人设要的"bot 级 markdown，界面可编辑"，这里有现成的做法可以照搬。
- 只读原因里有 `owner-offline`（`settings.ts:110`），是给远程管理预留的。

### 系统提示词

- 每个 bot、每个群拿到的都是同一段写死的飞书输出约定（`daemon/src/agent/bridge-instructions.ts:12-32`）。
- Codex 经 `developerInstructions` 注入（`codex-appserver/backend.ts:675`、`:689`），Claude 经 `systemPromptAppend` 注入（`daemon/src/agent/claude-agent/backend.ts:362`、`:378`）。

## 2. 和新 bot 模型的差距

| 新模型的要求 | v2 现状 | 要做的事 |
|---|---|---|
| bot 有 n 个工作区，其中 1 个是主的 | 没有 bot 级工作区。目录只挂在群上，一个群一个 `cwd`（`registry.ts:16-17`） | 给 bot 加工作区列表和主工作区，群默认继承。沙箱要从一个根改成多个根。新合同的 `Grant` 也只有一个 `root`（`daemon/src/provider/model.ts:6-8`） |
| 没设置时在默认路径建目录 | 有类似做法，但按群建：`<projectsRootDir>/<项目名>`，父目录所有 bot 共用（`paths.ts:115`；`lifecycle.ts:100-102`） | 改成按 bot 建默认主工作区。推断：放在按 bot 区分的子目录里，避免撞名（第 8 节第 6 条） |
| 0 到 n 个代码仓库 | 没有。`project/git-info.ts` 只读当前分支，用在群公告里 | 新增仓库列表。是否支持 git URL 要定。工作区和仓库有什么区别要在设计里写清。推断：工作区放产物、可写，仓库放代码 |
| Skill：创建时可加，之后可以增、删、管理 | vonvon 自己没有。Claude 读取用户级和项目级设置（`claude-agent/backend.ts:48`），用户自己的 skill 会带进 bot 会话。Codex 用用户自己的 `CODEX_HOME` | 新增 skill 库，bot 层、群层各一份名单，还要挡住用户的个人 skill。机制见 `agent-mechanics.md` 结论第 3 条 |
| 记忆 | 没有（grep `memory`、`记忆` 无相关代码） | 全新功能。范围和写入规则见 `persona-memory-skills.md` 结论第 2、3 条 |
| 个性 | 没有，只有上面那段固定约定 | bot 个性加群内补充，拼在固定约定后面。可以照搬 `commentInstructions` 的存储、编辑和版本号做法 |
| 每个群覆盖个性、工作区、仓库、skill | 群层（`project` 作用域）已经有，但只有权限、回复、压缩、模型四段（`settings.ts:72-81`） | 群层加四个覆盖段。另外，绑定已有的群时必须选目录（`domain.ts:63`；`JoinGroupDialog.tsx:94`）。新模型要允许群什么都不设、全部继承，所以绑定流程和待绑定群的卡片都要改 |
| 回复模式：仅 @、全部、智能 | 只有前两档（`domain.ts:72`） | 枚举加第三档，加判断模型的调用和多 bot 规则。旧 Codex 后端里有现成的不带工具的单次调用做法：会话标题服务，每次单开一个进程，30 秒超时（`codex-appserver/backend.ts:106-109`）。新合同里也有 `oneShot`（`daemon/src/provider/engines/engine.ts:64-65`），但还没接线。要判断不带 @ 的群消息，需要 `im:message.group_msg` 权限，这个已经在申请（`scopes.ts:24`） |
| 新 provider 合同 | `OpenSpec` 只有 `{cwd, resume, model, effort}`（`engine.ts:54`） | v1 如果走 V6b，就要改合同：加指令、额外根目录、skill、记忆目录。如果留在旧 `agent/` 路径，只改两个后端已知的注入点（推断：改动小很多） |
| 界面 | Membership 只有一个 `directory`（`domain.ts:119`），群详情只显示一行"工作目录"（`App.tsx:825`） | bot 详情和群详情都要加工作区、仓库、skill、记忆、个性几块，是新页面 |

**能直接复用的**：每个 bot 一个目录和一个进程、一个群绑多个 bot、bot 层和群层的设置分段、扫码注册、群白名单和管理员、两档回复模式。

## 3. macOS 桌面端离可用有多远

### 已经能用的（看代码，加上 Codex 在 Mac 上对 #257 的验收）

- Electron 44.4.5 外壳（`packages/desktop/electron-builder.yml:3`）：
  - 单实例（`packages/desktop/src/main.ts:40-43`）；
  - 托盘只有"显示"和"退出"两项（`packages/desktop/src/tray.ts:8-12`）；
  - 主窗口加载和网页相同的界面（`main.ts:21-31`；`docs/architecture.md:187-193`）。
- 启动时先连已经在跑的 daemon。没有的话，用 Electron 自带的 Node 拉起内置 daemon（`packages/desktop/src/daemon-manager.ts:67-108`；`packages/desktop/src/daemon-dependencies.ts:70-90`）。daemon 以分离进程启动（`daemon-dependencies.ts:79-86`），所以退出应用后 Bot 还在后台跑（`App.tsx:899` 的页脚文案）。
- 打包版会注册 `vonvon` 命令（`main.ts:162`）。
- 界面里能重启 daemon（`App.tsx:881-893`）。
- #257 在 Mac 上做出了 Developer ID 签名、未公证的 arm64 包。真实窗口里验过重启、退出、连接已有 daemon，也在打包版里绑定过群（`results/runnable.report.md` 第 1 节表格）。

### 缺的

1. **发布。**
   - 只有 `package:dir` 脚本（`packages/desktop/package.json:12`）。配置里有 dmg 和 zip 目标（`electron-builder.yml:30-34`）。
   - 仓库里搜不到公证、`hardenedRuntime`、`entitlements` 的配置（grep 结果）。GitHub release 数为 0（`runnable.report.md` 第 5 节）。
   - 推断：要发给别人的 Mac，必须公证，否则 Gatekeeper 会拦。
   - 推断：Intel Mac 要另出 x64 或 universal 包，#257 只出了 arm64。
2. **开机自启。**
   - 桌面端的"登录电脑时启动"开关能点，但点了必定失败（`main.ts:315`；`App.tsx:894`）。
   - "后台服务"里的"安装并启动"按钮也能点，同样必定失败（`packages/ui/src/management/MachinePanel.tsx:57-62`、`:85-86`；`main.ts:316-317`）。
   - `vonvon service install` 和 `uninstall` 直接抛错（`daemon/src/cli/commands/service.ts:4-5`；`daemon/src/host/service.ts:4-8`）。
   - 结果：电脑重启后要用户手动打开应用，Bot 才会回来。
   - **bridge 老用户现在有自启。** 0.6.14 装的是 launchd LaunchAgent `ai.feishu-codex-bridge.bot`，带 `RunAtLoad` 和 `KeepAlive`（bridge `6698118:src/service/launchd.ts:16`、`:60-62`）。迁移过来以后如果没有自启，体验会倒退。
   - 原设计是开关调用 launchd 服务安装，要等 V5 第 12 到 15 块和 Gate M（`docs/plan.md:889`、`:1152`）。
   - 推断：只做 macOS 的话，可以用 Electron 自带的登录项拉起应用，再由应用拉起 daemon。这样能绕开 launchd 服务事务和两道 Gate。代价是崩溃后不会自动重启，`KeepAlive` 才管这个。选哪条路要 owner 定。
3. **更新。** `desktop-update.json` 是 `{}`，更新检查只会回"此预览版没有配置签名更新源"（`packages/desktop/src/updates.ts:46`；`packages/desktop/build.mjs:13-31`）。
4. **首次运行。**
   - 没有 bridge 导入（第 5 节）。
   - v2 里还没有人从头到尾扫码注册成功过一个新 bot（`runnable.report.md` 第 1 节）。
   - 打包版用 Claude 要先从"本机环境"页另外下载约 265 MB（`daemon/src/agent/catalog.ts:106-111`）。
5. **文案。**
   - 扫码预填的应用名是"Codex Bridge"，简介里写着 feishu-codex-bridge（`daemon/src/bot/wizard.ts:59-62`）。
   - 桌面端的弹窗、托盘和服务报错是英文（`main.ts:19`、`:33-37`；`tray.ts:9-11`），界面是中文。
   - 版本号对不上：桌面 0.1.0（`packages/desktop/package.json:3`；`build.mjs:59`），daemon 0.7.0（`packages/daemon/package.json:3`）。
6. **新 bot 模型的界面**（第 2 节列的那些），一项都没有。

### 对"只做 macOS、只在本机用"的 v1 来说做多了的部分

- Windows 服务、启动项、进程监管，以及桌面端的 Windows PATH 和 Run 值代码（`desktop/src/cli-registration.ts` 有 19 处、`daemon-dependencies.ts` 有 13 处 Windows 相关代码）。owner 已经说第一版不支持 Windows。
- systemd 服务和 Gate L：v1 没有 Linux 桌面。快照的平台枚举里也没有 Linux（`domain.ts:151`）。
- launchd 服务事务、排空、Gate M、拿锁前检查（#285）：只有坚持"系统服务"这条路才需要。
- holder 进程：现在只用在启动时扫孤儿进程（`daemon/src/host/bootstrap.ts:22-27`），启动时不会去拉起 holder（`daemon/src/provider/process/process-host.ts:227` 只在 spawn 路径上）。真正用上要等 V6b。生产代码里还留着一个测试钩子（`bootstrap.ts:28-31`）。
- 自动更新的签名校验链：没有更新源就用不上。可以留着，发布时再接。

**删服务代码之前要注意**：桌面端启动时会读服务注册（`daemon-manager.ts:77-96`），引用了 `service/identity.ts`、`service/registration.ts`、`service/distribution.ts`（`daemon-dependencies.ts:9-11`）。`cli-registration.ts:6` 也引用了 `distribution.ts`。删之前要先改桌面端，不能整个目录一起删。

## 4. 云端账号和远程中继

- **没有代码。** workspaces 只有 protocol、client、daemon、ui、desktop（根 `package.json:8-14`），没有 `packages/cloud`。在 `packages/*/src` 里搜 `relay` 和 `e2ee`，没有结果。
- 客户端只有本机和浏览器两种传输（`packages/client/src/transport-local.ts`、`transport-browser.ts`）。计划里的端到端加密还没移植（`docs/architecture.md:171` 一节）。
- 协议里留了两个口子：握手带 `machineId`（`packages/protocol/src/handshake.ts:4`、`:14`），设置只读原因里有 `owner-offline`（`settings.ts:110`）。两者都不需要云端就能用。
- **界面不依赖账号。** 侧栏写"本地使用 · 无需登录"（`packages/ui/src/LocalShell.tsx:15`），设备页写"本地使用，无需产品账号"（`App.tsx:866`）。界面里出现的"账号"只有两处：本机 Codex 的登录账号，用在用量页（`packages/ui/src/management/UsagePanel.tsx:110-120`）；飞书 CLI 的登录身份，在本机环境页（`packages/ui/src/management/EnvironmentPanel.tsx:206`）。
- V10（账号）和 V11（中继）在 `docs/plan.md` 里共 146 行（`:1894-2039`），没有分支，也没有 PR（`gh pr list`）。v1 整体推后即可，不用删什么。

## 5. bridge 导入

- **main 上没有用户能用的导入。** `vonvon` 没有注册 `import` 命令（`daemon/src/cli/index.ts:20-104`），界面里也没有导入页。
- main 上有两段看起来像迁移的代码，对 bridge 用户都没用：
  - `ensureRegistry` 迁移的是 `~/.vonvon-bot/config.json` 这种单 bot 平铺老格式（`bots.ts:66-89`，`paths.appDir` 就是 v2 的数据根）。注释写的是 `~/.feishu-codex-bridge`，与代码不符（`bots.ts:62`）。
  - `host/migration.ts`、`config/legacy-data-root.ts`、`config/data-root-migration.ts` 是 bridge 自己把 `~/.feishu-codex-bridge` 改名成 `~/.vonvon-bridge` 用的（`legacy-data-root.ts:34-54`）。除了 `host/client.ts:11` 的再导出，只有测试在调用（grep 结果）。`host/client.ts` 的 `connectHost` 在生产代码里也没有调用方（grep 结果）。
- **有一处可复用。** `daemon/src/service/control.ts:6-56` 能检测 bridge 的 launchd 服务和数据目录（`ai.feishu-codex-bridge.bot`、`~/.feishu-codex-bridge`、`~/.vonvon-bridge`）。导入时可以用它判断 bridge 是否装了自启。
- **草稿 PR #226**（`codex/v8-bridge-import`，+2215/-10）：
  - 内容：`docs/bridge-import.md` 463 行；`import/bridge/preflight.ts` 363 行；`hooks.ts` 175 行，改写咖啡 Hook；`legacy-keystore.ts` 100 行，解 bridge 旧密钥；`bounded-local-files.ts` 131 行；`journal.ts` 25 行；界面 `ImportPage.tsx` 91 行；加上对应测试（`gh pr view 226 --json files`）。
  - 状态：PR 描述写明，服务控制的候选方案拿到了独立的 REQUEST CHANGES，界面部分还没接线。2026-10-13 因在飞上限暂停，保持草稿（PR 评论）。
- **计划的做法**：暂停 bridge → 复制数据，用新密钥重新加密 → 改写咖啡 Hook → 启动并确认连上 → 永久移除 bridge 自启 → 写入已迁移标记（`docs/architecture.md:145-155`）。
- **对 v1 有利的事实：**
  - 按 bot 分目录的数据形状沿用了 bridge，导入"基本是复制"（`architecture.md:141`）。
  - 要处理的事主要有三件。第一，密钥：bridge 的密钥是 `pbkdf2(主机名|用户名, salt)`（bridge `6698118:src/config/keystore.ts:74-76`），v2 改用随机的 `master.key`（`daemon/src/config/keystore.ts:33-60`）。第二，咖啡 Hook 的命令要改名。第三，要停掉 bridge 的 launchd 服务。
  - 只做 macOS 的话，只需要 launchd 一种服务控制。自有的 vonvon-bridge-legacy 里有只处理 macOS launchd 的迁移代码：`packages/runtime/src/cli-migration-*.ts` 和 `legacy-cli-control.ts`，共约 4,650 行，可以参考（`architecture.md:155`；`wc -l`）。
- **未验证的前提**：同一个飞书应用开两条长连接时，事件只会发给其中一条（`roadmap.md:113`）。这决定导入前是否必须先停 bridge。
- V9（bridge 收尾版本）在 bridge 仓库里，还没开始。它依赖 V8 和 Mac 签名包（`roadmap.md:24`）。

## 6. provider 现状

| provider | main 上的状态 | 依据 |
|---|---|---|
| Codex | 在用，是默认后端，走旧的 `agent/codex-appserver`。三档权限都支持。真机上有多次 Codex 回复的验收 | `agent/types.ts:14`；`agent/index.ts` 的 `REGISTRY`；`agent/catalog.ts:84-97`；#24、#244、#249（`runnable.report.md` 第 1 节） |
| Claude Code | 已注册，界面里能选。用 `@anthropic-ai/claude-agent-sdk`，三档都标为支持。打包版要另外下载约 265 MB。**没找到真机上跑过 Claude 回合的记录** | `catalog.ts:98-116`；`runnable.report.md` 第 2 节 |
| Cursor、Grok、Pi、自定义 ACP | 没有代码，只有一个 `'acp'` 类型和一行注释 | `agent/catalog.ts:17`；`provider/registry.ts:3` |
| DeepSeek 等 | 不单独做 provider，计划经 Claude Code 的用户设置路由 | `roadmap.md:40` |

- **新 provider 层。** V6a 的 9 个 PR 全部合入（#237、#241、#244、#249、#255、#259、#262、#266、#272，见 `git log`），`daemon/src/provider` 共 3,754 行。
- **新层里真正在用的只有三块：**
  - JSON-RPC 传输，旧 Codex 客户端复用了它；
  - 出站路径门（修 #114 的那个，#114 是本地文件外发的路径问题）；
  - 启动时扫孤儿进程（`bootstrap.ts:22-27`）。

  依据见 `runnable.report.md` 第 2 节。
- **#281（V6b 1/14，把 Codex 子进程搬到新层）：** 独立 Shipping 结论 PASS+NOTES，2026-10-14 05:50 起暂停冻结和合入（PR 评论）。
  - 暂停评论里记了一个缺口：合入后，POSIX 上的 Codex 回合会因为找不到 `vonvon-holder` 而失败。原因是 `npm run build` 不编译 holder，打包脚本也不带它，`ProcessHost.available()` 也没人调用。
  - V6b 一共 14 个 PR，外加一个删除阶段。
  - 从 V6b 到 V6d 合入之间，Claude 的 `qa` 和 `write` 档会被拒绝；main 上这两档现在能用（`docs/plan.md:1417`）。
- **对 v1 的推断：** v1 要的是 Codex 和 Claude，再加上个性、多目录、skill、记忆、智能回复。在旧 `agent/` 路径上加这些，PR 会比先做完 V6b 再加少很多。缺点是以后做 V6b 时，这些新字段要一起迁到新合同上。

## 7. v1 可以暂停或删除的 v2 工作

行数用 `wc -l` 统计。"删除"的意思是：v1 用不上，留着还要维护，以后可以从 git 历史找回。删不删由 owner 决定。

### 代码

| 内容 | 文件 | 行数 | 建议 |
|---|---|---|---|
| Windows 服务和启动项 | `daemon/src/service/windows.ts`、`win-startup.ts` | 361 + 98 | 删或冻结 |
| Windows 进程监管 | `daemon/src/provider/process/windows-supervisor.ts`、`windows-command-line.ts`、`windows-job-probe.ts`；`daemon/src/agent/codex-appserver/windows-job.ts` | 425 + 46 + 54 + 144 | 删或冻结。旧 Codex 路径里的调用点要一起处理 |
| Windows 测试 | `daemon/test` 和 `test/provider` 下文件名含 windows 的 8 个文件 | 1,362 | 跟着删 |
| Windows CI | `.github/workflows/ci.yml:84-118`（`windows-2025` 任务） | — | 停掉 |
| systemd 服务和 Gate L | `daemon/src/service/systemd.ts`；`host/lifecycle.ts` 里 Linux 的 scope 和就绪部分（`:66-90`、`:193-200`） | 380 + 部分 | 暂停 |
| launchd 服务事务、排空、注册读回 | `daemon/src/service/launchd.ts`、`drain.ts`、`definitions.ts`、`registration.ts`、`identity.ts`、`common.ts`、`adapter.ts` | 380 + 170 + 167 + 89 + 43 + 117 + 16 | 如果自启改用 Electron 登录项，这条线整体暂停。`identity.ts`、`registration.ts` 被桌面端引用，见第 3 节末尾 |
| bridge 服务检测 | `daemon/src/service/control.ts` | 129 | **保留**，导入用得上 |
| 服务相关测试 | `daemon/test` 下文件名含 service、systemd、launchd、drain、win 的 25 个文件（不算 `cli-bridge-*` 和 `web-admin-service`） | 5,400 | 跟着处理。有几个也覆盖 daemon 的正常停止和排空，要逐个看 |
| V5 第 12 到 15 块 | #285（+1135/-47，已暂停）；13 到 15 还没开 | — | 暂停 |
| holder 和进程托管 | `daemon/native/holder/holder.c`；`provider/process/process-host.ts`、`holder-*.ts`、`ledger.ts`、`identity.ts`、`exit-hold.ts` | 730 + 656 + 408 + 127 + 75 + 37 | 暂停。启动扫孤儿和测试钩子也可以先拿掉（`bootstrap.ts:22-31`） |
| holder 和进程测试 | `test/provider` 下的 holder、process、exit-hold、host-fixture 测试，加上 `native/holder-driver.ts` | 1,873 + 117 | 跟着处理 |
| V6b 切换 | #281（+822/-348，已暂停）；#234（V6b 依赖交接准备，+37/-119，草稿） | — | 暂停 |
| 新层里其余还没接线的部分 | `provider/runtime/**`、`policy/**`、`engines/engine.ts`、`model.ts` | 约 1,170 | 先不动。没有调用方，不影响运行 |
| bridge 自己的数据目录改名代码 | `host/migration.ts`、`config/legacy-data-root.ts`、`config/data-root-migration.ts`；`host/client.ts` 里没人调用的 `connectHost` | 52 + 54 + 185 + 123 | 删。只有测试在调用 |
| 没注册的 CLI 命令 | `daemon/src/cli/commands/bot.ts`、`doctor.ts`（没人引用）；`update.ts`（只有测试引用） | 129 + 131 + 88 | 不删。v1 要 CLI 的话，改名后注册成 `vonvon bot`、`vonvon doctor`（推断） |
| 旧桌面 PR 栈 | #2、#9 到 #19 还开着 | — | 关闭。`roadmap.md:107` 本来就说 V4 合入后关闭，V4 已经合入（#69） |
| V5 拆分来源 | #110（`owner:claude`，+17177/-2281） | — | 跟着 V5 服务线一起定 |

服务目录里的 `update.ts`（304 行）、`codex-bin.ts`（95）、`distribution.ts`（86）、`desktop-release.ts`（94）和 Core 更新、Codex 路径、发行判断有关，不全是服务代码。要逐个看，不能一刀切。

前四类（Windows、systemd、launchd 事务、holder）的源码合计约 4,650 行，测试合计约 7,850 行。

### 计划、文档和流程

| 内容 | 位置 | 行数 |
|---|---|---|
| V5 一节（服务部分占多数） | `docs/plan.md:887-1286` | 400 |
| V6b、V6c、V6d | `plan.md:1366-1588` | 101 + 60 + 62 |
| V7a、V7b、V7c | `plan.md:1589-1773` | 68 + 59 + 58 |
| V8、V9 | `plan.md:1774-1893` | 62 + 58（要按 macOS-only 改写，不是删） |
| V10、V11 | `plan.md:1894-2039` | 70 + 76 |
| 原生验收主机 | `docs/native-acceptance-hosts.md` | 685 |
| provider 设计和能力矩阵 | `docs/providers.md`、`docs/native-capabilities.md` | 876 + 409（留作 Cursor、Grok、Pi 的参考） |
| 程序图和看板同步 | `docs/program-graph.json`；`scripts/program-graph-sync.mjs` 及其测试；issue #122 看板 | 1,372 + 447 + 53 |
| 双机交接 | `scripts/handoff.mjs` 及其测试 | 192 + 257 |

推断：owner 要减少交接，要 Claude 自己审查、测试、合入。那么"frozen head 跑完整三平台 CI""Codex 做 Shipping 检查""看板同步"这套流程（`AGENTS.md`）也要跟着改。v1 要另写一份短计划，替换 V5 到 V11 的编排。上面这些文档标成"推后"，不再当作当前计划。

## 8. 目前看到的 bug

都是读代码得出的，没有实际运行过。

1. **Linux 上显示成 Windows。** 平台不是 `macos` 就一律显示"这台 Windows 电脑"（`packages/ui/src/App.tsx:861-865`）。daemon 在 Linux 上报的是 `unsupported`（`daemon/src/server/snapshot.ts:29`），所以 Linux 网页会显示成 Windows。
2. **自启开关和"安装后台服务"按钮能点，但必定失败，报错还是英文。**
   - 开关只在 `unsupported` 平台隐藏，桌面端可以点（`App.tsx:894`）。按钮只看"是否已安装"，不看服务状态里的 `supported: false`（`MachinePanel.tsx:57-62`；`host/service.ts:7`）。
   - 桌面端这两个操作都直接抛出英文的 `serviceUnavailable`（`main.ts:19`、`:315-317`），界面把消息原样显示（`App.tsx:226-231`；`MachinePanel.tsx:53`）。
3. **新建的 bot 叫"Codex Bridge"。** 扫码预填的名称和简介写死成 bridge 的（`wizard.ts:59-62`）。
4. **残留 bridge 的命令名和链接。**
   - 终端和诊断里提示 `feishu-codex-bridge bot init`、`bot list`、`doctor`（`daemon/src/bot/onboarding.ts:45`、`:81`、`:86`、`:116`、`:165`；`daemon/src/cli/commands/doctor.ts:75`、`:86`）。`vonvon` 没有注册 `bot` 和 `doctor`（`cli/index.ts:20-104`）。
   - 私聊帮助卡指向 bridge 仓库（`daemon/src/card/dm-cards.ts:44`、`:436`、`:455`）。`admin/service.ts:249` 也有一处。
   - `daemon/src` 里一共 48 行含 `feishu-codex-bridge` 的非注释代码（grep 计数）。
5. **注释里的默认路径和实际不符。** `schema.ts:96-97` 说空白项目默认放在 `~/.feishu-codex-bridge/projects`，实际是 `~/.vonvon-bot/projects`（`paths.ts:115`）。`bots.ts:62` 也有同类问题。
6. **两个 bot 的同名空白项目会共用一个目录（推断，没实测）。** 空白目录的建法是 `join(根目录, 项目名)` 加 `mkdir recursive`（`lifecycle.ts:100-102`）。父目录默认所有 bot 共用，而项目名只在单个 bot 里查重（`registry.ts:194`）。bot A 和 bot B 都建一个"demo"，会落进同一个目录，不报错。
7. **死配置。** `requireMentionInGroup` 和 `getRequireMentionInGroup` 没有调用方（`schema.ts:115-116`、`:232-234`）。
8. **桌面版和 daemon 版本号不一致**：0.1.0 对 0.7.0（第 3 节）。
9. **单实例锁发现不了正在跑同一个飞书应用的 bridge。** 锁放在 v2 自己的数据目录里（`runnable.report.md` 引 `core/single-instance.ts:118`）。在用户的 Mac 上两个同时跑，飞书事件可能分到两边。
10. **#281 合入后打包版的 Codex 会失败**，因为缺 `vonvon-holder`（第 6 节）。现在还不是 main 上的 bug。
11. **README 还停在 V1**，只讲 protocol 包（`README.md:1-9`）。要开源的话得重写。

## 附：和"要不要开源"有关的事实

- vonvon-bot 仓库是私有的，根目录没有 LICENSE 文件（`gh repo view` 返回 `PRIVATE`、`licenseInfo: null`；`ls`）。daemon 包的 `package.json` 写的是 MIT（`packages/daemon/package.json:63`）。
- 代码来源有四个（`docs/architecture.md:297-305`）：
  - bridge，MIT；
  - Paseo，Apache-2.0，要保留 NOTICE（根目录已有 `NOTICE`）；
  - vonvon-bridge-legacy，自有私有仓库；
  - vonvon-platform，自有私有仓库。
- 已提交的文件里有内部信息：Tailscale 地址、腾讯云主机的公网 IP、Mac 账户名和本机路径。涉及的文件有 `AGENTS.md`、`docs/plan.md`、`docs/program-graph.json`、`docs/self-hosted-ci.md`、`docs/native-acceptance-hosts.md`、`scripts/handoff.mjs` 及其测试，还有 `packages/daemon/test/event-map.test.ts`、`tool-presentation.test.ts`（`git grep` 结果）。开源前要清理，或者另开一个干净的公开仓库（推断）。
- comma 是 AGPL-3.0，只能借思路，不能把代码复制进 MIT 的 daemon（`results/comma.report.md` 摘要）。
- 开不开源由 owner 决定，这里只列事实。

## 未知

- 新 bot 扫码注册能不能一次走通，走通后还要在飞书后台手动做哪些操作。
- Claude 回合在真机上能不能跑通。
- 同一个飞书应用开两条长连接时，事件怎么分配。
- 改了个性以后，老话题恢复时能不能用上新个性（见 `persona-memory-skills.md`）。
- 用户 Mac 上如果还装着旧的 0.7.0 桌面应用，会不会和新应用的 `com.vonvon.bot.desktop` 冲突。
- #257 签过名的包是否还在 Mac 上，是不是 be17859 的版本。
- 智能回复的判断模型用哪家、延迟和费用多少。owner 说的模型名称听写不清，这里没有查证。
