# I6：删掉 Mac、Windows 只装服务端留下的代码（`server-6-linux-only`）

## 1. 做什么

owner 2026-11-01 定：Mac、Windows 只用桌面端安装包装全部软件，一条命令只装服务端只在 Linux 上做，服务端包只有 `linux-x64`、`linux-arm64`（`docs/plans/devices.md` 第 19 节）。I1、I3 当时已经为 Mac、Windows 的服务端包写了一些代码，这一片把它们删掉。用户看不到变化：Linux 的安装、升级照旧，Mac、Windows 桌面端自带的服务端和 npm 装的服务端都不动。

依据总设计第 13 节 I6 行。依赖 I2a（#639）、I3（#632、#633）、U2（#649），都已合入集成分支。I5 等这一片。

## 2. 范围

- 做：只删只为 Mac、Windows 服务端包存在的代码、测试和文档里的说法。
- 不做：桌面端自带的服务端（Mac、Windows 安装包里的 `Resources/daemon`）、npm 装的服务端、Windows 桌面端自己的升级和打包，一行都不动。有疑问的不删，写进第 4 节。

## 3. 删了什么

| 模块 | 删掉的 | 为什么能删 |
|---|---|---|
| `scripts/build-server.mjs` | 六个目标的 `TARGETS`（只留 `PUBLISHED_TARGETS` 两个）、`isWindowsTarget`、`.zip` 的包名、`WINDOWS_PREFIX` 和 260 字符预算、`nodeLayout` 的 Windows 布局、`unpackZip`、`writeZip`、大小写重名检查；"Windows 上只能打 win-*"改成"Windows 上不打包" | 只打两个 Linux 包。Linux 的文件系统区分大小写，路径也没有 260 字符的限制 |
| `scripts/server-node.json` | darwin、win 四个 Node 的哈希 | 同上 |
| `D/service/archive.ts` | `extractZip` | 只下载 `.tar.gz` |
| `D/service/current-release.ts` | `current.txt` 的读写、`platform` 参数、`switchCurrent` 的 `previous` 参数、`readCurrent` 返回的 `previous`、`releaseCommand` 的 `node.exe` | 只有 `current` 符号链接一种；`previous` 只在 `current.txt` 里有，Linux 上一直是空的 |
| `D/service/standalone-update.ts` | 下载时选 `.zip`、`node.exe`、`settleUpdateAtStartup` 的 `platform` 选项和 win32 下不挪 getter 的分支、清理时读 `current.previous` | 同上；`settleUpdateAtStartup` 只在 standalone 时有 `installRoot`，Windows 上没有 |
| `D/service/standalone-manifest.ts` | `archiveName` 的 `.zip`、`serverTarget` 把 `win32` 改写成 `win` | 清单只有两个 Linux 包 |
| `D/host/restart.ts` | `rollsBack`（Windows 服务下交给 I4b 监督进程切回） | I4b 取消，Windows 没有 standalone |
| `D/config/store.ts` | `ownStandaloneRoot` 的 win32 分支 | Windows 上判不出 standalone，结果一样是 `undefined` |
| `D/platform/npm.ts` | `bundledNpmCli` 的 Windows 布局和 `platform` 参数 | `bundled`（桌面端自带的 `Resources/npm`）一行没动 |
| `D/service/launchd.ts` | 接受 `standalone` | 改回 I1 之前的写法：只装 `bundled`、`global-npm`。共用的 `installsService`、`serviceProgram` systemd 还在用 |
| 测试 | 上面这些的 Windows、zip、大小写、260 字符、`current.txt`、`rollsBack` 用例；`fake-release` 的 zip 和 `node.exe` | 跟着代码删 |
| 文档 | `devices.md`、`architecture.md`、I1、I3、I5 计划里"I6 删"的说法改成"已删" | |

## 4. 留着的

- **桌面端 `RegisteredDaemon.kind` 的 `standalone`**（总设计 I6 行列了它）。这个种类直接取自 daemon 共用的服务定义解码（`D/service/definitions.ts` 的 `decodeGeneratedDefinition`）：Linux 的 systemd 单元解出来就是 `standalone`，桌面端的 `readRegistration` 在 Linux 上也跑（开发和测试）。删它要在桌面端加一层改写，代码反而多；Mac 上 launchd 已不写这种 plist，Windows 不读注册，所以 Mac、Windows 上读不到它。U2 的退出判断用 `kind !== 'desktop'`，不点名 `standalone`。
- **`definitions.ts` 对 plist 也认 `standalone`**：解码是 launchd、systemd 共用的一段，launchd 不再写这种 plist。只给 plist 关掉要多加一个平台判断。
- **`classifyDistribution` 认 `standalone` 不分平台**：它也判桌面端自带、npm 和开发目录，测试在三个平台的 CI 上跑。Mac、Windows 上没有 `releases/<v>/app` 加 `standalone.json` 的布局，判不出 standalone。
- **`installsService` 仍含 `standalone`**：systemd 要用。`adapter.ts` 在 Mac 上先放行、建数据目录，再由 launchd 拒绝；不为一个判不出来的种类多写一层。
- **`serverTarget`、`StandaloneDeps.platform`、`arch`**：Linux 上别的处理器（比如 `linux-ia32`）也要回"这台电脑没有对应的服务端包"。
- **`standalone-setup.ts` 在非 Linux 上拒绝、`install.sh`/`uninstall.sh` 在 Mac 上只打印下载地址**：owner 定的行为，不是死代码。
- **`.gitattributes` 让 bin 文件按 LF 检出**：起因是 Windows 上 `npm ci` 后工作区变脏、`build-server.mjs` 拒绝出包；`pack-vonvon-bot.mjs`、发布脚本的干净检查在 Windows 上同样会被挡。测试仍在 `build-server.test.mjs`。
- **`build-server.mjs` 在 Windows 上直接拒绝**：一句判断，免得在 Windows 上打出没有执行位的包。
- **测试里的 `darwin-arm64`、`win-x64`**：`standalone-manifest.test.ts` 拿它们当清单要拒绝的例子，`build-server.test.mjs` 拿它们验证 `unknown target`。这是测试输入。

## 5. 测试

- `scripts/build-server.test.mjs`：只组装 `linux-x64`；`server-node.json` 的键正好是两个 Linux 目标、文件名都是 `.tar.gz`；`--targets darwin-arm64`、`--targets win-x64` 报 `unknown target`（main 必败：原来照打）；在 Windows 上拒绝打包。
- `service-transaction.test.ts`：launchd 装 `standalone` 拒绝，`Distribution cannot install a service`，不写 plist（main 必败：原来走到 `serviceProgram` 才因没有 `current` 失败）。
- 其余改动只删用例或去掉 `'linux'`、`platform: 'linux'` 参数：`archive`、`current-release`、`bundled-npm`、`standalone-update-apply`、`standalone-restart`、`standalone-getter`、`standalone-setup`、`cli-update`、`self-entry`。

## 6. 验收要点

- `build-server.mjs` 只认 `linux-x64`、`linux-arm64`，不带 `--targets` 打这两个。
- 服务端代码和脚本里搜不到 `current.txt`、`extractZip`、`unpackZip`、`writeZip`、`node.exe`、`win-x64`、`darwin-arm64`（测试输入除外）。
- 桌面端自带的服务端没动：`bundledNpmCli` 的 `bundled` 分支、`serviceProgram` 的 `desktop`、launchd 装 `bundled`、Windows 的 secrets 走 `process.execPath`。
- npm 装的服务端没动：launchd、systemd 都还装 `global-npm`。
- Linux 的升级、回滚、清理照旧：`standalone-*` 测试全过。
- diff 里没有真实 id、密钥、本机路径。

## 7. 风险和行数

约 +200 / −500，大多是删除。风险在"删多了"：桌面端自带的服务端和 npm 安装走的都是共用代码，所以 `installsService`、`serviceProgram`、`classifyDistribution`、`definitions.ts` 只删了 launchd 的一处判断，其余不动。

## 8. 实现时和计划不一样的地方

- 总设计写"`TARGETS` 只留两个"。实现把 `TARGETS` 和 `PUBLISHED_TARGETS` 合成一个，留 `PUBLISHED_TARGETS` 这个名字：`install.sh` 的测试（R1 #657 也在改这个文件）、`standalone-manifest.ts` 和 `fake-cdn.mjs` 的注释都用它，改名要碰在飞 PR 的文件。
- 总设计列了桌面端 `RegisteredDaemon.kind` 的 `standalone`，没删，原因见第 4 节。
