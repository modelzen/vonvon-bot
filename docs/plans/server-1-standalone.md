# I1：服务端独立安装包（`standalone` 种类和 `build-server.mjs`）

## 1. 做什么

服务端第一次有自己的安装包：六个平台各一个压缩包，里面是压缩过的服务端代码、网页端、`vonvon` 入口和官方 Node（含 npm）。装好以后它认得自己是 `standalone`，能装后台服务，服务定义指向不随版本变的路径，托管安装 Codex 用包里自带的 npm。桌面端自带的 `Resources/daemon` 也一起变成压缩、无源码的样子。总设计 `docs/plans/devices.md`（下称"总设计"）7.1、7.2、第 13 节 I1 行；`stageDaemon` 对桌面端同样生效（总设计 7.1 REQ-11）。不依赖别的片；I2（安装脚本）、I3（升级）、I4a（Windows 计划任务）、I5（发布）在它上面接。

## 2. 范围

- 做：
  - protocol 的 `distribution.kind` 加 `standalone`，三处（`P/machine.ts` 的 `coreUpdate`、`P/admin.ts` 的 `daemonStatus`、daemon 的 `Distribution`），客户端按开放字符串解析；
  - `D/service/distribution.ts` 认 `standalone`（先于 `.git` 祖先检查）、`serviceProgram()`（服务定义走 `current`，不解析 realpath）；
  - `D/platform/npm.ts` 的 `bundledNpmCli()` 认 `standalone`；
  - systemd、launchd 的安装接受 `standalone`；定义的解码认得出 `standalone`；
  - `scripts/stage-daemon.mjs`：minify、把 `@vonvon/client`、`@vonvon/protocol` 打进 `dist/cli.js`、两种依赖布局都去掉 `.d.ts`/`.map`/`.ts`/测试目录；
  - 新 `scripts/build-server.mjs`：组装、检查、打包六个平台；`scripts/server-node.json` 钉 Node 版本和哈希。
- 不做：
  - 安装脚本、`bin/vonvon` 启动器、PATH、`current` 的建立和切换（I2）；
  - 签名清单、`vonvon update`、升级时子进程钉 release（I3）；
  - Windows 计划任务、`current.txt`、`vonvon-server.cmd`（I4a）；
  - 上传、CI 构建和冒烟、`ci-scope.mjs`、`product-version.mjs` 管服务端包（I5）；
  - 桌面端认 `standalone` 的注册后的界面和退出行为（U2；本片只把桌面端的类型扩一个值）；
  - `UpdatePanel` 的门控和"Core 来源"文案（I3）。
- 后面的片可以假设：`Distribution` 的 `standalone` 形状 `{ kind, cliPath, installRoot }`、`serviceProgram()`、`standalone.json` 的字段、包内布局（4.6）、`build-server.mjs` 的输出和 `vonvon-server-<version>-build.json`，不再改名。

## 3. 现在的代码

- 发行种类：`D/service/distribution.ts` 的 `classifyDistribution(root, globalRoot?)`，`bundled` 看 `Resources/{daemon,app.asar}`；`development` 看任何祖先有 `.git`，排在 `global-npm` 前面；其余 `unknown`。`runtimeDistribution()` 只在本地判不出时跑 `npm root -g`。
- 种类的分支：`D/service/adapter.ts:91`、`systemd.ts:302`、`launchd.ts:303` 只许 `bundled`、`global-npm` 装服务；定义的程序是 `d.executable`（`process.execPath`，已是真实路径）和 `distribution.cliPath`（包根的真实路径），`systemd.ts:316`、`launchd.ts:318`。
- 定义：`D/service/definitions.ts`，`DistributionInput` 只有 `npm`、`desktop` 两种可装；解码只按 `ELECTRON_RUN_AS_NODE` 分这两种。桌面端 `DT/daemon-manager.ts:15` 的 `RegisteredDaemon.kind` 同样两种，`DT/login-item.ts:181` 只对 `desktop` 做启动修复。
- npm：`D/platform/npm.ts` 的 `bundledNpmCli()` 只认 `VONVON_NPM_CLI` 和 `bundled` 旁边的 `Resources/npm`；`D/environment/service.ts:586` 和 `requireTrustedNpm`（托管安装 Codex）靠它。
- protocol：`P/machine.ts:45`、`P/admin.ts:88` 都是 `z.enum(['global-npm','bundled','development','unknown'])`，0.9 的服务端回 `standalone` 时 0.8 以前的客户端解析失败。
- 打包：`scripts/stage-daemon.mjs` 的 `stageDaemon()` 用 esbuild `bundle`、`packages: 'external'`、不 minify，client/protocol 以 tsc 输出放进 `node_modules`（带 `.d.ts`）；`hoist`（Windows 桌面端）整包复制，连 `src/`、`test/`、`.d.ts` 一起；`compact`（Mac 桌面端）会建 symlink。桌面端 `packages/desktop/build.mjs:89` 按构建机平台选布局。protocol、client 用 zod 3.25，daemon 用 zod 4.6。
- 现成的工具：`scripts/package-tools.mjs` 的 `fileEntries`（拒 symlink、记 sha256 和模式）、`scripts/desktop-backend-policy.mjs` 的 `assertNoBundledClaude`、`scripts/product-version.mjs` 的 `checkedProductVersion`。
- 版本号：`D/core/version.ts` 读 `dist/../package.json`；`vonvon hook` 在 `bin/vonvon.mjs` 里处理；网页端在 `dist/../ui/dist/`（`D/server/web-ui.ts:7-10`）。

## 4. 怎么改

### 4.1 protocol

`P/domain.ts` 加：

```ts
export const distributionKinds = ["global-npm", "bundled", "standalone", "development", "unknown"] as const;
export type DistributionKind = (typeof distributionKinds)[number];
/** kind 按开放字符串解析：新服务端报出这个客户端还不认识的种类时不报错。 */
export const distributionSchema = z.object({ kind: z.string().min(1), cliPath: z.string() });
```

`machine.ts` 的 `coreUpdate.distribution`、`admin.ts` 的 `daemonStatus.distribution` 改用它。界面现有的 `kind === 'global-npm'` 比较不用改。

### 4.2 `standalone` 的识别

安装后的布局（总设计 7.2）：`<installRoot>/releases/<version>/{app/, node/, standalone.json, build-manifest.json}`，daemon 的包根是 `app/`。

`classifyDistribution` 在 `bundled` 之后、`.git` 检查之前加一段：包根 `basename` 是 `app`、包名 `@vonvon/daemon`、`bin/vonvon.mjs` 和 `dist/cli.js` 是文件、`release = dirname(包根)`：
- `release/standalone.json` 能解析成 `{ v: 1, version, … }`（多出来的字段放过，I3 要往里记东西）；
- `version` 等于 `app/package.json` 的 `version`，也等于 `basename(release)`；所以解到一半的 `releases/<v>.part/` 不算；
- `basename(dirname(release)) === 'releases'`，`installRoot = dirname(dirname(release))`；文件里有 `installRoot` 时，它的真实路径必须等于这个值。

都满足回 `{ kind: 'standalone', cliPath, installRoot }`，`cliPath` 和别的种类一样是真实路径。不满足就照旧往下判（在 git 仓库下就是 `development`）。

### 4.3 服务定义走 `current`

`distribution.ts` 加：

```ts
export const installsService = (d: Distribution): boolean => d.kind === 'bundled' || d.kind === 'global-npm' || d.kind === 'standalone';
export function serviceProgram(d: Distribution, executable: string, capturedPath: string):
  { distribution: Definition['distribution']; capturedPath: string };
```

- `bundled` → `{ kind: 'desktop', executable, entry: cliPath }`；`global-npm` → `{ kind: 'npm', … }`；其余抛 `Distribution cannot install a service`（`action-report.ts` 的原因映射不变）。
- `standalone` → `executable = <installRoot>/current/node/bin/node`、`entry = <installRoot>/current/app/bin/vonvon.mjs`（不解析 realpath，升级只换 `current`），`capturedPath` 前面加 `<installRoot>/current/node/bin`（去重），托管工具 `#!/usr/bin/env node` 找得到自带的 Node。两个文件有一个不在就抛 `Standalone install has no usable current release at …`（I2 没建好 `current` 时拒绝，不写坏定义）。
- `adapter.ts`、`systemd.ts`、`launchd.ts` 的种类检查换成 `installsService`，`desired` 换成 `serviceProgram(...)` 的结果；launchd 的 App Translocation 检查看 `serviceProgram` 给出的两个路径。
- `definitions.ts` 的 `DistributionInput` 加 `{ kind: 'standalone'; executable; entry }`，渲染和 `npm` 一样（没有 `ELECTRON_RUN_AS_NODE`）；解码时 `entry` 是 `<X>/current/app/bin/vonvon.mjs` 且 `executable` 是 `<X>/current/node/bin/node` 就回 `standalone`，所以 U2 读注册就知道是独立安装的服务端。桌面端 `RegisteredDaemon.kind` 加 `'standalone'`，`login-item.ts:181` 对它和 `npm` 一样回 `none`，行为不变。
- Windows 不走这里（`getServiceAdapter` 在 win32 照旧抛，I4a 接）。

### 4.4 自带的 npm

`bundledNpmCli(env, daemonRoot, execPath = process.execPath, platform = process.platform)`：`VONVON_NPM_CLI` 优先照旧；`bundled` 照旧；`standalone` 时，`release` 自带的 Node 是 `node/bin/node`（Windows `node/node.exe`），**只有 `realpath(execPath)` 就是它**才回同一 release 的 `node/lib/node_modules/npm/bin/npm-cli.js`（Windows `node/node_modules/npm/bin/npm-cli.js`），文件不在回 `undefined`。用别的 Node 跑这份代码时不配对，回 `undefined`（落回 PATH 上的 npm，托管安装照旧拒绝）。`npmInvocation` 不变（`ELECTRON_RUN_AS_NODE` 对真 Node 无害）。不靠 `VONVON_NPM_CLI`（总设计 7.2 NPM-1）。

### 4.5 `stageDaemon`（桌面端和服务端共用）

- esbuild 加 `minify: true`、`keepNames: true`（错误名、栈里的函数名照旧可读，不赌依赖 `.name` 的代码）、`metafile: true`，不出 source map；`legalComments` 用默认（`eof`，第三方许可证声明留着）。
- 不再用 `packages: 'external'`，换成一个 resolve 插件：
  - `@vonvon/client`、`@vonvon/protocol`（含子路径）从源码打进 `dist/cli.js`：包 `exports` 指的 `./dist/x.js` 换成 `src/x.ts`，esbuild 直接编 TS，不看 `dist` 新旧（`dist` 旧了曾把旧的协议打进去，见第 9 节）；
  - daemon 自己的裸导入一律外置；
  - 被打进来的代码（上面两个包，以及因此打进来的第三方包）里的裸导入：包名在 daemon 的运行依赖里、**并且**解析到和 daemon 同一个真实目录，才外置；否则一起打进来。今天的结果是 `ws` 外置、protocol/client 的 zod 3 打进来（daemon 外置的是 zod 4）。
  - 构建后核对：`metafile` 里每个外置的非内置模块，包名都在运行依赖里，否则抛错（防"打包时能解析、装好后找不到"）。
- 写出的 `package.json` 和要复制的依赖去掉 `@vonvon/client`、`@vonvon/protocol`（`bundleDependencies` 同步去掉），`node_modules/@vonvon/` 不再出现。
- `runtimeFile` 对 `compact`、`hoist` 两种布局的每个第三方包都用（默认布局是 `pack-vonvon-bot.mjs` 的 npm 包，不动）：去掉包顶层的 `test/tests/__tests__/examples/docs`，去掉 `.d.ts/.d.mts/.d.cts/.map/.ts/.mts/.cts`。第三方包的 `src/` 不动：`debug`、`agent-base` 这些的运行代码就在 `src/` 里。
- 返回 `{ external, bundled }`（排好序的包名），给测试和 `build-server.mjs` 的输出用。

### 4.6 `scripts/build-server.mjs`

`node scripts/build-server.mjs --out <dir> [--targets linux-x64,…] [--node-cache <dir>] [--allow-dirty]`，输出目录必须在仓库外；默认六个目标 `linux-x64`、`linux-arm64`、`darwin-arm64`、`darwin-x64`、`win-x64`、`win-arm64`。先要求 `packages/ui/dist/index.html` 在（没有就说先 `npm run build -w packages/ui`）；工作区不干净时拒绝，`--allow-dirty` 才放行并在输出里记 `sourceDirty: true`（I5 发布时拒绝它）。

1. **app**：`stageDaemon(<tmp>/app, { name: '@vonvon/daemon', version, type: 'module', private: true, bin, engines, license, author, dependencies }, { hoist: true })`，再复制 `packages/ui/dist` 到 `app/ui/dist`，`assertNoBundledClaude`。六个目标共用一份（没有原生模块，`validateFiles` 也拒 `.node`）。
2. **Node**：版本和六个文件的 SHA-256 钉在 `scripts/server-node.json`（取自 nodejs.org 该版本的 `SHASUMS256.txt`），本片用 24.22.2（24 LTS 最新）。下载 `https://nodejs.org/dist/v<ver>/<file>`（只走 https），哈希对上才放进缓存；用缓存时每次再核一遍。每个目标只用自己的官方包：POSIX `node-v<ver>-<os>-<arch>.tar.gz`，系统 `tar -xzf` 解开，取 `bin/node`、`lib/node_modules/npm/`、`LICENSE`；Windows `node-v<ver>-win-<arch>.zip`，用脚本里的小解包器 `unpackZip` 解开（只认 stored/deflate，核 CRC，拒绝 ZIP64、加密、绝对路径、反斜杠和 `..`，不覆盖已有文件），取 `node.exe`、`node_modules/npm/`、`LICENSE`。放到 `node/bin/node`、`node/lib/node_modules/npm/`（POSIX）或 `node/node.exe`、`node/node_modules/npm/`（Windows）。`bin/npm`、`bin/npx`、`corepack`、`include/`、`share/` 不带：没人用，`bin/npm` 还是 symlink。
3. **standalone.json**：`{ v: 1, version, target, node }`。`installRoot` 不写：构建时不知道装在哪，4.2 从布局推；I2、I3 想记可以加，4.2 会核对。
4. **build-manifest.json**：`{ schema: 1, package: 'vonvon-server', version, target, node, sourceHead, sourceDirty, lockfileSha256, buildNode, esbuild, files }`，`files` 用 `fileEntries`（路径、sha256、755/644），所以树里有 symlink 就失败。
5. **检查**（`checkServerTree(root, target)`，导出给测试和 I2/I5）：
   - 必有：`standalone.json`、`app/{package.json,bin/vonvon.mjs,dist/cli.js,ui/dist/index.html,NOTICE,LICENSE.paseo,LICENSE.bridge}`、目标平台的 Node、npm-cli.js、`node/LICENSE`；
   - 只有普通文件和目录，没有 symlink（六个包都没有，不只 Windows）；
   - 全包没有 `.ts/.mts/.cts/.d.ts/.map` 文件；`app/` 顶层只许 `package.json`、`bin/`、`dist/`、`ui/`、`node_modules/` 和许可证、`PROVENANCE.md`、`import-core.json`，`dist/` 里只有 `cli.js`；没有 `app/node_modules/@vonvon/`；
   - `dist/cli.js` 是压缩过的（平均每行超过 400 字节，没有 `sourceMappingURL`）；
   - 不区分大小写时没有重名（macOS、Windows 的默认文件系统）；
   - Windows 目标：`100 + 相对路径长度 < 260`。100 留给 `C:\Users\<最长 20 字的用户名>\AppData\Local\VonvonBot\server\releases\<v>.part\`（约 85 字），PS 5.1 的 `Expand-Archive` 受 260 限制。
6. **打包**：POSIX `vonvon-server-<version>-<target>.tar.gz`，Windows `.zip`，成员是 `app/…`、`node/…`、`standalone.json`、`build-manifest.json`，不套顶层目录（I2 解到 `releases/<v>.part/` 再改名）。tar 和 zip 都用 JS 写（`node:zlib`），不依赖构建机的 `tar`/`zip` 版本：按路径排序、时间固定、属主 0、模式 755/644，只写文件条目；tar 是 ustar，路径放不进 name/prefix 就失败；zip 用 deflate、UTF-8 文件名、条目数和大小超过非 ZIP64 上限就失败。
7. **汇总**：`<out>/vonvon-server-<version>-build.json`：`{ version, sourceHead, sourceDirty, node, external, bundled, files: { <target>: { name, size, sha256, sha512 } } }`，I5 做清单时用 `sha512`。

### 4.7 和总设计不一样的地方

- **六个包都用 `hoist`，不按"Windows hoist、其余 compact"**（总设计 7.1 PKG-2）。`compact` 会建 symlink，`package-tools` 的清单和 I2 解包都得另外处理链接，链接也是解包时的一类风险；`hoist` 没有链接，Windows 桌面端已经在用。桌面端照旧（Mac `compact`、Windows `hoist`），只是两种都过同一个文件过滤。
- **`standalone.json` 不带 `installRoot`**：构建时不知道绝对路径，由布局推出；文件里有就核对。总设计 7.1 写的是 `{ v: 1, version, installRoot }`。
- **"无 `src`"按"我们的代码"理解**：`app/` 顶层和 `@vonvon/*` 不能有 `src/`、TS 和 map；第三方包的 `src/` 是它们的运行代码，留着，只去掉其中的 `.ts`、`.d.ts`、`.map`。I1 验收那行"包里都无 `.ts/.d.ts/.map/src`"照这个核。

## 5. 测试

`node --test scripts/*.test.mjs` 和 vitest。标"main 必败"的在今天的代码上失败。

- `scripts/stage-daemon.test.mjs`：
  - 真跑 `stageDaemon`（`hoist`）：`dist/cli.js` 平均每行超过 400 字节、没有 `sourceMappingURL`；`node_modules/@vonvon` 不在；`package.json` 的依赖里没有 `@vonvon/*`；全树没有 `.d.ts/.map/.ts`；返回的 `external` 不含 `@vonvon/*`、含 `ws`；protocol 的 zod 和 daemon 的不是同一目录时 `bundled` 含 `zod`；`node bin/vonvon.mjs --version` 打出 daemon 的版本。**main 必败**。
  - 夹具：`hoist` 布局去掉第三方包的 `test/`、`docs/`、`.d.ts`、`.map`、`.ts`，留下 `src/index.js`。**main 必败**。
- `scripts/build-server.test.mjs`（不联网）：
  - 用假的官方 Node 目录组装 `linux-x64` 和 `win-x64`：布局、`standalone.json` 内容、`node/bin/node` 或 `node/node.exe`、npm 的位置，`node/` 下只有 Node、npm 和 `LICENSE`；Windows 的 npm 取自 Windows 包（CRLF 的 `.cmd` 原样）；
  - `unpackZip`：`writeZip` 写的包读回内容一致；`../`、绝对路径、反斜杠的条目拒绝且不写到目录外；改坏一个字节报 CRC 错；
  - `checkServerTree`：好树通过；有 symlink、有 `.d.ts`、有 `app/src/x.js`、有 `app/node_modules/@vonvon/protocol`、`cli.js` 没压缩、大小写重名、缺 Node、Windows 路径超预算，各自失败并说出原因；同一棵长路径树对 `linux-x64` 通过；
  - tar.gz 用系统 `tar -tzvf`/`-xzf` 读回：内容、模式、没有目录外路径；zip 用测试里的小读取器读回：文件名、内容一致；
  - `server-node.json` 六个目标都有 64 位十六进制哈希，文件名是该目标的官方包（Windows `.zip`）；下载的文件每次用都核哈希。
- `packages/protocol/test/distribution.test.ts`：`daemonStatus`、`coreUpdate` 接受 `standalone` 和一个没见过的种类。**main 必败**。
- `packages/daemon/test/distribution.test.ts`：
  - `releases/0.9.0/app` 布局认成 `standalone`、`installRoot` 对；在带 `.git` 的家目录下也是 `standalone`（**main 必败**）；经 `current` 符号链接进来时 `cliPath` 是真实路径；
  - `.part` 目录、版本对不上、`standalone.json` 缺或坏、`installRoot` 写的是别处、不在 `releases/` 下，都不是 `standalone`；
  - `serviceProgram`：`standalone` 给 `current` 路径和前置的 PATH，`current` 不完整就抛；`bundled`、`global-npm` 照旧；`development` 抛。
- `packages/daemon/test/bundled-npm.test.ts`：`standalone` 且用 release 自带的 Node 跑时给出同一 release 的 npm（POSIX 和 Windows 布局各一条，**main 必败**）；用别的 Node 跑时 `undefined`；npm 文件不在时 `undefined`。
- `packages/daemon/test/service-definitions.test.ts`：`standalone` 定义的解码回 `standalone`，换成别的路径回 `npm`。**main 必败**。
- `packages/daemon/test/service-systemd-transaction.test.ts`：`standalone` 安装写进的单元是 `current/node/bin/node current/app/bin/vonvon.mjs`、PATH 以 `current/node/bin` 开头；`current` 换到另一个版本后再装是 `already-installed`。**main 必败**。

## 6. 自测和验收

全部在 JP-VPS（Linux x64）上做，不用测试 bot、不发飞书消息、不碰在跑的 daemon。所有输出放在 `T=$(mktemp -d)` 下，测试和起 daemon 都在单条命令前写隔离的 `HOME`、`VONVON_HOME`。

1. 包、类型、lint、定向测试（第 5 节的文件），加上 `npm run build -w packages/desktop`（`stageDaemon` 改了，桌面端的 `stage/daemon` 也要能出，并核对它没有 `.ts/.d.ts/.map`、没有 `@vonvon/`、`cli.js` 已压缩）。
2. `build-server.mjs --out $T/out --node-cache $T/node-cache` 出六个包（会下载六个官方 Node 文件，只下载、不上传）。
3. 解开 `linux-x64` 包到 `$T/install/releases/<v>/`，手建 `current` 链接（I2 以后由脚本建）：
   - `node app/bin/vonvon.mjs --version` 是产品版本；`printf '{}' | … hook --agent claude` 退 0；
   - 隔离的 `HOME`、`VONVON_HOME` 下 `open --print` 起了 daemon、打出地址，`curl` 那个地址回 200 且是网页端的 `index.html`；`daemon status --json` 里 `distribution.kind` 是 `standalone`；最后 `daemon stop`；
   - 在一个带 `.git` 的目录下解开再看一次，仍是 `standalone`。
4. 其余五个包只做静态核对：`checkServerTree` 通过、Windows 两个包没有 symlink、最长路径在预算内；darwin 包的 `node/bin/node` 是 Mach-O、Windows 的 `node.exe` 是 PE（`file` 命令）。`win-x64` 包的 `node/` 和官方 zip 用系统 `unzip` 解出来的逐文件比对（除去 `.d.ts` 这类）。
5. 不在 JP-VPS 上真装 systemd 服务（会碰真实的用户 systemd 管理器）；服务定义的内容由第 5 节的单测覆盖，真装在 I2 的验收里做（干净测试用户）。

要别的机器验的（不在本片做，写进集成 PR 的"还没验过"）：
- Mac mini Codex：在 Mac 上解开 `darwin-arm64` 包跑 `--version`、`open --print`（I2 的 Mac 验收里一起做）；桌面端候选版本的 `Resources/daemon` 能起来、托管安装 Codex 能用（集成验收）。
- Windows Codex：`win-x64` 包 `Expand-Archive` 能解开、`node\node.exe app\bin\vonvon.mjs --version` 对（I4a 的任务里一起做）；Windows 桌面端候选版本的 `Resources\daemon` 能起来。

## 7. 文档

- `docs/product.md`：本片没有用户看得到的变化，不改（3.10 的服务端安装由 I2 改）。
- `docs/v1-plan.md`：这一批的切片清单在 `docs/plans/devices.md` 第 13 节，不在 v1-plan 里，不勾。
- 默认值：无。

## 8. 验收要点

1. `distribution.kind` 三处都有 `standalone`；protocol 的两处按开放字符串解析，测试里没见过的种类能过。
2. `standalone` 的识别先于 `.git`；`.part`、版本不一致、`installRoot` 不符、不在 `releases/` 下都不认。
3. `standalone` 的服务定义是 `<installRoot>/current/...`，没有解析 realpath；PATH 前置自带 Node；`current` 不完整时拒绝装，不写定义。
4. `bundledNpmCli` 对 `standalone` 只在 release 自带的 Node 跑时给出同一 release 的 npm；没用环境变量。
5. `stageDaemon`：`cli.js` 压缩、无 source map；`@vonvon/*` 从源码打进去、不在 `node_modules` 也不在依赖里；protocol 的 zod 3 没被 daemon 的 zod 4 顶替；外置模块都在运行依赖里；`compact`、`hoist` 过滤 `.d.ts/.map/.ts`，默认布局（npm 包）不变。
6. 桌面端构建（`packages/desktop/build.mjs`）不用改就拿到同样的 `Resources/daemon`；Mac 仍 `compact`、Windows 仍 `hoist`。
7. `build-server.mjs`：Node 文件按钉住的 SHA-256 校验，每个目标只用自己的官方包；`unpackZip` 拒绝不安全条目；六个包都无 symlink；检查项和第 4.6 节一致；Windows 路径预算按 260 算；输出在仓库外；脏工作区要 `--allow-dirty` 并记下来。
8. 第 6 节的自测命令和结果写在 PR 描述里。
9. diff 里没有真实 id、密钥、IP 和本机绝对路径。

## 9. 风险和行数

- 行数约 1,170（不含 lockfile，增删合计）：计划 ~180，protocol ~30（含测试），daemon 源码 ~110、测试 ~135，桌面端 2，脚本 ~470，脚本测试 ~260。
- `minify` 后的桌面端 `Resources/daemon` 是新产物：本片在 Linux 上跑了构建和 `--version`/`open --print`，Mac、Windows 桌面端的真机启动在集成验收里看（第 6 节）。`keepNames` 留着，降低改名带来的风险。
- protocol/client 从源码打进 `cli.js`：起初用的是它们的 `dist`，自测时 `dist` 比源码旧，打进了旧的协议，CLI 连自己起的 daemon 都报"Cannot verify daemon owner"，所以改成从源码编。代价是 esbuild 要能编这两个包的 TS（今天能，它们没有 esbuild 不支持的写法）。
- Windows 的 npm 取自官方 Windows zip：本来想省掉解包器、借 linux-x64 包里的 npm，比对后发现官方 Windows zip 的 npm 有 1,910/1,926 个文件是 CRLF 行尾（含 `.cmd` 启动器），不是同一份，所以加了 `unpackZip`。它只解官方 Node zip，哈希先核过；解包规则见 4.6 第 2 步。
- 首次下载 Node 走 nodejs.org，信任根是 HTTPS 加仓库里钉的哈希；没验 Node 的 GPG 签名。

## Windows 验收（任务 205）后改了什么

Windows 11 ARM64 上的 Codex 对集成分支 `aec3bb47` 做了验收（modelzen/vonvon-bot#631 任务 205）。发现和改动：

- **打包后的 daemon 查不了文件夹（所有平台）。** 网页端选文件夹和 `vonvon dir suggest` 在新的 Node 进程里跑一段搜索代码，这段代码原来是一个 TS 函数的 `toString()`。4.5 打开 `minify` + `keepNames` 以后，函数体里多了 esbuild 放在函数外面的 `__name` 调用，新进程里没有它，于是包里的 daemon（服务端包和桌面端自带的）每次搜索都报 `directory_unreadable`。改成：搜索代码直接写成 `directory-suggestions.ts` 里的一段 JS 字符串，打包工具不改字符串，`keepNames` 照旧不关。全仓库没有别处把函数 `toString()` 了再执行。`scripts/stage-daemon.test.mjs` 真跑 `stageDaemon`，起包里的 daemon，用 `dir suggest` 找到临时家目录里的文件夹，旧代码上失败。
- **Windows 上 `~\Docs` 不展开。** 新的 `D/platform/home-path.ts`：`~`、`~/…` 到处都认，`~\…` 只在 Windows 认（别的平台上 `\` 是文件名里的字符）。CLI 的 `--folder`（`group create/bind/set`、`dir list`、`project workspace`）、设置里的路径（`projectsRootDir` 和路径规则）、Bot 发文件的路径、Codex 的模型目录路径都走它；搜索代码里写了同样的规则。家目录边界照旧由 daemon 查（`outside_home`）。`folderPath` 按传进来的平台用 `path.win32` 或 `path.posix`，Linux 上也能测 Windows 的结果。`projectsRootDir` 在 macOS、Linux 上不再把 `~\x` 当成家目录。
- **Windows 上 `npm ci` 以后工作区变脏，`build-server.mjs` 拒绝出包。** 系统的 `core.autocrlf=true` 把 `bin/vonvon.mjs` 检出成 CRLF，npm 链接 bin 时把第一行改成 LF。加 `.gitattributes`，只让各包 `package.json` 的 `bin` 文件按 LF 检出，不动别的文件；测试核对每个 bin 都有 `eol=lf`。
- **找不到文件夹时的默认目录。** 原来是 `FEISHU_CODEX_CWD || process.cwd()`：服务起的 daemon 拿到 `/`（launchd）或 `C:\Windows\System32`（Windows 计划任务），命令行起的拿到当时 shell 的目录。新的 `fallbackWorkingDirectory()`：`FEISHU_CODEX_CWD` 照旧优先；`process.cwd()` 是磁盘根、在 `%SystemRoot%` 下、在 daemon 自己的安装目录（standalone 的安装根、桌面端的应用目录、或者包本身）里，或者已经不在了，就用家目录。设置页的 `runtime.fallbackCwd` 和 Bot 进程用的是同一个函数。
- **只在 Windows 上失败的测试（测试的问题，断言不放松）：**
  - `scripts/build-server.test.mjs`：执行位只在 POSIX 上从磁盘查，Windows 上由条目给出、再核 tar 头里的模式；`tar -tv` 的输出按 CRLF 也能切；"输出在仓库里"的测试原来用 URL 的 `pathname`，Windows 上是 `/E:/…`，不在仓库里，才走到了脏工作区检查，改用 `fileURLToPath`，并带 `allowDirty`。另外 `build-server.mjs` 在 Windows 上拒绝出 tar.gz 目标：Windows 磁盘上没有执行位，也解不开官方 Node 包里的符号链接。
  - `bundled-npm.test.ts`：`toolDirectories`、`withToolDirectories` 按目标平台用 `path.posix`/`path.win32`（产品代码），launchd、systemd 的 PATH 在任何机器上都是 `:` 和 `/`。
  - `cli-dir`、`cli-group`、`cli-project`：同上，`folderPath` 按测试给的平台算，夹具不用改；`cli-group` 补了 Windows 的用例。
  - `distribution.test.ts`、`server-directory.test.ts`：目录链接在 Windows 上建成 junction（不用管理员权限，目标用绝对路径）。Windows 的 `current.txt`（I4a/I3）还不在集成分支上，所以只改夹具。`chmod(0)` 的"读不了的目录"在 Windows 上跳过，Windows 没有 POSIX 权限位。
  - `daemon-cli.test.ts`：`daemon restart` 的"等待 daemon 重启…"本来就写在 stderr（命令行约定：结果在 stdout），测试原来把 stdout 和 stderr 拼在一起比，改成只比 stdout，失败时也在 `finally` 里停掉 daemon；"daemon ready"的等待在 Windows 上从 15 秒放到 45 秒，这条测试在 Windows 上自己的超时放到 120 秒（原来跟配置的 60 秒走，等满 45 秒后只剩约 15 秒给后面五次命令行和关闭），别的平台照旧 20 秒。
- **没改的：** `cli-json` 的 `service uninstall` 样本、`daemon-cli` 的"service status gives an isolated data root…"和"service commands from a checkout…"在 Windows 上失败，是因为 Windows 后台服务还没做，I4a 的分支会改这几条预期。RPC 的 `distribution` 没有 `installRoot` 是设计如此（协议只有 `{ kind, cliPath }`，4.1）；没有 Bot 时 `group list` 退出 0、列表为空，也是对的。
