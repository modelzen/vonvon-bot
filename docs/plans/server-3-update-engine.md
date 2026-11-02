# I3 `server-3-update-engine`：standalone 的升级引擎和 `vonvon update`

依据 `docs/plans/devices.md` §7.5（升级引擎）、§6.5（升级按钮）、§4.7（排空期间放行）、§12（共享契约）、§13 的 I3 行。I2、I4a、I4b、I5 四片引用本文 §4.1 的契约，不各自重写。本文的缩写同 `devices.md`：`D/` = `packages/daemon/src`，`P/` = `packages/protocol/src`，`CL/` = `packages/client/src`，`DT/` = `packages/desktop/src`，`U/` = `packages/ui/src`。

**2026-11-01 改动**（owner："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"；`devices.md` 第 19 节）：`standalone` 只在 Linux 上有，服务端包和签名清单只有 `linux-x64`、`linux-arm64`，托管时的服务管理器只有 systemd。I4a、I4b、I2b 取消。所以本文下面为 Windows、macOS 写的部分都用不上：C1 的四个 darwin、win 目标和 `.zip`，C5 的 `current.txt`，C6、§4.6 里的 I4b 监督进程和 launchd，C7 的 Windows 计划任务名，§4.3 的 `extractZip`，§4.10 的 Windows 占用目录。I3 不再为它们写新代码；I3a、I3b 已经写好的（`current-release.ts` 的 `current.txt` 分支、`archive.ts` 的 `extractZip`、win32 下助手只写 `error` 的分支）先留着，I3 合入后由清理片 I6 一起删。清单不等 I6：I2a 的 `install.sh` 已经只认 `linux-x64`、`linux-arm64` 两项（多一项、少一项都 exit 4），I3 在自己的片里把 `standalone-manifest.ts` 的 `SERVER_TARGETS` 连同 `fake-cdn` 和测试改成同样两项，否则脚本认的清单 daemon 不认、daemon 认的脚本不认；万一 I3 按六项合入，I6 先改它，I5 发第一份 stable 清单之前两边必须一致。下文原样留着，读的时候按这一段。

## 1. 做什么

装了 `standalone` 服务端的机器能从任何客户端（界面按钮、`vonvon update`）升级到 CDN 上签名清单指向的版本：先把新版本完整放进 `releases/<v>/`、原子切 `current`，再排空、退 75，由服务管理器按 `current` 拉起新版本；重启助手核对新进程的版本号，起不来或版本不对就切回旧版。清单有签名、有回滚保护，坏签名和"旧版本的合法清单放到 stable"都拒。daemon 每 24 小时查一次清单，只为了在界面上标"有新版本"，不自动升级。

## 2. 范围

做：
- §4.1 列的全部共享契约：签名清单的格式和校验、服务端签名密钥的公钥怎么进包、`update-status.json` 的扩展、`update-state.json`（回滚保护）、`current`/`current.txt` 和 `D/service/current-release.ts`、退出码 75 的含义、服务名、`MAINTENANCE_KINDS`。
- `D/service/standalone-manifest.ts`（解析、验签、严格校验）、`D/service/archive.ts`（tar.gz 和 zip 的安全解包）、`D/service/standalone-update.ts`（检查 + 应用）、`D/service/current-release.ts`。
- `machine.checkCoreUpdate` / `applyCoreUpdate` 对 `standalone` 的分支；`applyCoreUpdate` 加可选参数 `{ version?, allowDowngrade? }`。
- `__restart-after-exit` 助手按版本判成功、超时回滚。
- `D/core/self-entry.ts`：daemon 启动时把入口文件 realpath 钉住，替换八处 `process.argv[1]`，升级切 `current` 之后旧进程起的助手、子进程仍跑旧版本的文件。
- `vonvon update [--check] [--json] [--allow-downgrade --to <v>]` 注册进 CLI；排空白名单加 `machine.coreUpdateStatus`。
- protocol：`coreUpdateStatusSchema` 的 `phase` 改开放字符串并加可选字段；`coreUpdate` 回复加 `channel`；`applyCoreUpdate` 请求加可选参数。
- UI：`U/management/UpdatePanel.tsx` 的门控改成按 `distribution.kind`（§6.5）。
- 清理 `releases/`：只留 `current` 和 `previous`，被占用的目录跳过。

不做：
- `bundled` 的远程升级（U4）、`global-npm` 路径的行为变化（照旧 `npm view` / `npm install -g`）。
- 安装脚本（I2）、Windows 计划任务和监督进程（I4a、I4b）、发布脚本和 CI（I5）。I4b 收到 75 之后看 `current.txt` 的那一套只在 I4b 里实现，本文只定契约。
- 自动升级。`publishedAt` 只用来拒绝倒退，不做"发布 N 天后才提示"之类的灰度。
- 增量包、差分下载、断点续传。下载失败就整个重来。

## 3. 现在的代码

- `D/service/update.ts`：`checkUpdate()` 用 `npm view` 查最新版；`performCoreUpdate({ install })` 拿 `update.lock`（`acquireUpdateLock()`：`O_EXCL` 建文件、写 pid、陈旧锁按 pid 存活回收）→ 写 `update-status.json`（`updateStatusSchema` 严格，`phase ∈ installing|restarting|done|error`，字段 `ok/message/from/to/at`）→ `npm install -g` → 回 `restarting` 状态；`finishOwnedUpdate(expected, outcome, message)` 只在状态文件还是自己写的那份时改成 `done`/`error`。`isNewer(a, b)` 已有语义版本比较。
- `D/host/restart.ts` `runSamePortRestartHelper({ port, oldPid, oldStartedAt, update })`：等 `update.lock` 释放 → `spawn(process.execPath, [process.argv[1], 'daemon', 'start', '--port', port])` → 轮询 pid 锁直到 owner 变了 → `finishOwnedUpdate(update, 'done')`。只看 pid 变了，不看版本。
- `D/host/lifecycle.ts` `observeShutdown`：`serviceManaged = Boolean(process.env.VONVON_SERVICE) && !process.send`；`requestRestart(port, update)` 排空后，托管时 `process.exitCode = 75` 让管理器拉起，不托管时起 detached 助手 `__restart-after-exit <port> <pid> <startedAt> <update JSON>`（Linux 用 `systemd-run --user --scope` 脱离 cgroup）。
- `D/server/ws.ts` 排空期间只放行 `admin.daemonStatus` 和 `machine.stopHost`（白名单写死在 ws.ts 里）。`D/server/http.ts` `control()` 暴露 `requestRestart`。
- `D/server/rpc/machine.ts`：`checkCoreUpdate` 回 `{ type: 'coreUpdate', distribution, current, latest, hasUpdate, dev }`；`applyCoreUpdate` 无参数，`service.applyUpdate()` 后 `kind: 'shutdown'`、`afterReply: control.requestRestart(port, update)`。
- `P/machine.ts`：`coreUpdateStatusSchema` 的 `phase` 是封闭枚举；`applyCoreUpdate` 请求没有参数。
- `D/cli/commands/update.ts` 有 `runUpdate`，但 `cli/index.ts` 没注册 `update` 命令；`cli/parity-allowlist.ts` 里 `update` 相关的 kind 标着 `pending('I3', …)`。
- `process.argv[1]` 当入口的地方八处：`host/supervisor.ts`、`host/lifecycle.ts`、`host/restart.ts`、`host/service-action.ts`、`cli/commands/daemon.ts`、`agent/…/store.ts` 两处、`client/daemon-client.ts`。`current` 切走之后它们会用 `current/app/bin/vonvon.mjs` 这个未解析的路径，起到的是新版本的文件。
- `server/pid-lock.ts` 的 `daemon.pid` 记 `{ pid, startedAt, listen, version, bootId }`，`version` 可以直接拿来核对。
- I1 已合入：`standalone` 种类、`releases/<v>/{app,node,standalone.json}`、服务定义走 `current`、`bundledNpmCli` 认 standalone、`scripts/build-server.mjs`（`TARGETS`、`archiveName`、`APP_TOP`、`checkServerTree`、六个包 + `vonvon-server-<v>-build.json` 含 sha256/sha512）。
- `DT/windows-update-manifest.mjs`：Ed25519 信封 `{ payload: base64, signature: base64 }`，`validateWindowsUpdatePayload` 严格校验，`normalizeWindowsPublicKey` 接受 raw 32 字节或 SPKI 的 base64。`scripts/windows-update-signing.mjs` 的 create-key / sign。
- `U/management/UpdatePanel.tsx` 的按钮只在 `attached && distribution.kind === 'global-npm'` 时可点（§6.5 "升级按钮今天是死的"）。

## 4. 怎么改

### 4.1 共享契约（I2、I4a、I4b、I5 引用这里，不重写）

**C1 签名清单 `https://dl.vonvon.cc/bot/server/stable/manifest.json`**
- 信封：`{ "payload": "<base64>", "signature": "<base64>" }`，和 Windows 清单同一种信封。`payload` 是 UTF-8 的紧凑 JSON（`JSON.stringify` 无空白）；`signature` 是对 **解码后的 payload 字节** 的 Ed25519 签名（64 字节）。信封最大 64 KiB，超了拒。
- payload 的键按这个顺序写（sh 脚本用 sed 取字段靠的是固定顺序和无空白）：`schemaVersion`、`product`、`channel`、`version`、`publishedAt`、`files`、`notes`（可选，最后）。`files` 的键按 `scripts/build-server.mjs` 的 `PUBLISHED_TARGETS`（I2a）顺序：`linux-x64`、`linux-arm64`；每项 `{ "url", "sha512", "size" }`。原来还有 `darwin-arm64`、`darwin-x64`、`win-x64`、`win-arm64`，2026-11-01 起不发（见文首），I3 改成两项，和 I2a 的脚本一致。
- 校验（TS 和 sh 都做，任一不过就整份拒，不用 payload 里的任何值）：`schemaVersion === 1`；`product === 'vonvon-bot-server'`；`channel === 'stable'`；`version` 匹配 `^[0-9]+\.[0-9]+\.[0-9]+$`；`publishedAt` 是正的安全整数（epoch 毫秒）；`files` 恰好两个键（2026-11-01 前写的是六个），不多不少；每个 `url` **字面等于** `https://dl.vonvon.cc/bot/server/<version>/vonvon-server-<version>-<target>.tar.gz`（原来 win 用 zip）；`sha512` 匹配 `^[0-9a-f]{128}$`；`size` 是正的安全整数；`notes` 可选、字符串、≤ 4096；没有别的键（zod `.strict()`）。
- 测试和 CI 的假 CDN 用不同的 `baseURL`（见 C2），`url` 的前缀就换成那个 `baseURL`；sh 脚本里 `baseURL` 是常量，只能靠改脚本副本换。
- 未签名的 `https://dl.vonvon.cc/bot/server/<version>/manifest.json`：内容是 payload 去掉 `channel` 的那份（`{ schemaVersion, product, version, publishedAt, files }`），给人和 I5 的 publish 自检看，daemon 和脚本都不读它。

**C2 服务端签名密钥**
- 一把**单独**的 Ed25519 密钥，不复用 Windows 桌面端的。私钥是 Mac 发布配置里的外部文件（I5 §4.2 `cos-server.json.updatePrivateKeyFile`），不进仓库。公钥的 raw 32 字节 base64 提交在仓库 `packages/daemon/server-update.json`：`{ "publicKey": "<base64 raw 32 字节>", "baseURL": "https://dl.vonvon.cc/bot/server" }`。
- `scripts/build-server.mjs` 把它拷进每个包的 `app/server-update.json`（I3 把 `server-update.json` 加进 `APP_TOP` 和 `checkServerTree` 的 `required`）。daemon 运行时从 `dirname(selfEntry()) + '/../server-update.json'` 读；没有或解析失败 → `checkCoreUpdate` 回 `latest: null` 并记事件 `update-config-missing`，不崩。
- 测试构建：`build-server.mjs --update-public-key <文件> --update-base-url <http://127.0.0.1:…/bot/server>` 用给的公钥和地址写 `app/server-update.json`，并在 `vonvon-server-<v>-build.json` 里写 `"updateKey": "test"`（默认 `"release"`）。I5 的 publish 看到 `test` 就拒绝上传。daemon 没有任何环境变量能换公钥或地址，脚本也没有。
- 公钥在 sh/ps1 里是**同一把钥匙**的 PEM（SPKI）形式写死；TS 这边 `normalizeWindowsPublicKey` 已经能把 raw 32 字节包成 SPKI。I5 的测试核对三处（`server-update.json`、`install.sh`、`install.ps1`）是同一把。

**C3 `update-status.json`**（数据目录 `paths.appDir/update-status.json`，不变位置）
- `phase` 仍然只有 `installing | restarting | done | error`；新加可选字段：`to`（目标版本）、`previous`（切 `current` 前的版本，回滚用）、`progress: { transferred, total }`（下载中）、`detail`（`downloading | verifying | unpacking | switching | draining | waiting | rolled-back`）、`rolledBack: boolean`。schema 仍 `.strict()`。
- `P/machine.ts` 的 `coreUpdateStatusSchema.phase` 改成 `z.string()`（客户端按开放字符串解析，不认识的当"进行中"），其余新字段都 `.optional()`。
- 写法不变：`writeUpdateStatus` 整文件覆盖（内容 < 1 KiB，`writeFileSync` 到 `.tmp` 再 `renameSync`——今天是直接写，这次顺手改原子）。`finishOwnedUpdate` 的"只改自己写的那份"规则不变，判等用 `from + to + at`。
- `update.lock` 不变（`paths.appDir/update.lock`，`O_EXCL`，内容是 pid）。

**C4 `update-state.json`**（安装根 `<installRoot>/update-state.json`）
- `{ "v": 1, "highestSeen": "<semver>", "lastPublishedAt": <ms>, "lastCheckAt": <ms> }`。写 `.tmp` 再 `rename`。读不出来（没有、坏 JSON、v 不对）→ 当作 `{ highestSeen: currentVersion, lastPublishedAt: 0 }` 并记事件 `update-state-unreadable`，不拒绝检查。
- 接受一份清单的条件：`publishedAt >= lastPublishedAt` 且 `version >= highestSeen`（相等允许：同一份清单重读、上次没升成功）。接受后更新 `highestSeen = max(highestSeen, version)`、`lastPublishedAt = max(…)`。拒绝时回 `latest: null`、`refused: 'rollback'` 并记事件 `update-manifest-refused { reason }`。
- 和总设计不一样：§7.5 说记进 `standalone.json`。那个文件在版本目录里，每版一份、随版本目录删，升级切过去就"忘了"历史；放在安装根只有一份。见 §4.11。

**C5 `current` 和 `current.txt`，`D/service/current-release.ts`**（Windows 的 `current.txt` 2026-11-01 起用不上，I6 删）
- POSIX：`<installRoot>/current` 是**相对**符号链接 `releases/<version>`。切换：`unlink(current.next)`（忽略 ENOENT）→ `symlink('releases/<v>', 'current.next')` → `rename('current.next', 'current')`。`rename` 覆盖符号链接是原子的；任何一步崩掉，`current` 要么还是旧的要么已是新的。
- Windows：`<installRoot>\current.txt`，两行，LF 结尾：第 1 行当前版本，第 2 行上一版本（第一次安装时第 2 行是空行）。切换：写 `current.txt.tmp`（第 1 行新版本、第 2 行原第 1 行）→ `rename` 覆盖（Node 在 Windows 上用 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`）。启动器 `bin\vonvon*.cmd` 读第 1 行，`releases\<v>\standalone.json` 不存在就用第 2 行（I4a）。和总设计不一样：§7.2 说退回 `standalone.json` 里记的上一版，但那个文件就在可能缺失的目录里；上一版写在 `current.txt` 第 2 行。见 §4.11。
- 模块 `D/service/current-release.ts`：`readCurrent(installRoot): Promise<{ version: string; previous?: string } | null>`（POSIX 读 `readlink`，必须匹配 `^releases/(\d+\.\d+\.\d+)$`，否则 `null`；Windows 读 `current.txt`）；`switchCurrent(installRoot, version): Promise<{ previous: string | null }>`（先 `stat(releases/<v>/standalone.json)` 且其 `version === v`，否则抛 `ReleaseIncomplete`；再按上面两段切；返回切之前的版本）。两个函数都收 `platform` 参数（默认 `process.platform`），测试里在 Linux 上跑 Windows 分支。
- I2 的 `__standalone-setup` 和 I3 的 `performStandaloneUpdate` 都调 `switchCurrent`；I2、I3 谁先合入谁建这个文件，后到的直接用。

**C6 退出码**
- daemon `daemon run` 退 **75** = "请按 `current` 重新拉起我"（升级、`daemon restart`）；退 **0** = 停下、不要拉起（`daemon stop`、`machine.stopHost`、`service uninstall`）；其他退出码 = 崩溃，管理器 5 秒后拉起（systemd `RestartSec=5` / launchd `ThrottleInterval 5` / I4b 监督进程 5 秒）。这条在 `docs/architecture.md` 55-65 已有，这里只是把 I4b 的监督进程也绑上。

**C7 服务名**（Windows 计划任务名随 I4a 取消）
- launchd `com.vonvon.bot.daemon`、systemd `vonvon-bot.service`，非默认数据目录加哈希后缀（`D/service/identity.ts` 今天的规则，不变）。
- Windows 计划任务 `\VonvonBot\<sid-hash12>-<root-hash12>`：`sid-hash12` = 当前用户 SID 字符串的 sha256 前 12 个十六进制；`root-hash12` = 数据目录绝对路径**小写、`\` 结尾去掉**后的 sha256 前 12 个十六进制（I4a 实现，`identity.ts` 加 `windowsTaskName(sid, dataRoot)`）。

**C8 `MAINTENANCE_KINDS`**
- `P/domain.ts` 导出 `MAINTENANCE_KINDS = ['admin.daemonStatus', 'machine.stopHost', 'machine.coreUpdateStatus'] as const`，`D/server/ws.ts` 的排空白名单改成读它。D4a 也要这个常量（§4.7 维护子集），I3 和 D4a 谁先合入谁建，后到的只加自己的项。

### 4.2 清单：`D/service/standalone-manifest.ts`

- `parseSignedManifest(bytes: Uint8Array, publicKey: string, baseURL: string): Manifest`：长度 ≤ 65536 → `JSON.parse` 信封 → 两个字段都是 base64 字符串 → `Buffer.from(payload, 'base64')`，签名解出来必须恰好 64 字节 → `crypto.verify(null, payloadBytes, spki(publicKey), signature)`（Node 内建 Ed25519，和 `windows-update-manifest.mjs` 同一个调用）→ 验签过了才 `JSON.parse(payloadBytes)` → zod 严格 schema（C1）→ 自己再比对每个 `url === expectedURL(baseURL, version, target)`。任何一步失败抛 `ManifestError { reason: 'too_large' | 'envelope' | 'signature' | 'schema' | 'url' }`，调用方把 reason 记进事件、不把 payload 的内容带进用户可见文字（它没通过验证，不可信）。
- 复用 `DT/windows-update-manifest.mjs` 的 `normalizeWindowsPublicKey`（挪到 `P/` 或共享包不在本片范围；daemon 从 desktop 包 import 会把依赖方向弄反，所以**复制** 12 行 SPKI 前缀代码到 `standalone-manifest.ts`，加注释指回源头）。
- `fetchManifest(deps)`：`deps.fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { 'cache-control': 'no-cache' } })`；非 200 → `ManifestError 'http'`；读 body 用流并累计长度，超 64 KiB 中止。`redirect: 'error'`：清单地址是固定的，跳转说明中间有东西。

### 4.3 解包：`D/service/archive.ts`

- 不引新依赖（包里没有 tar 库；`build-server.mjs` 自己写 tar/zip，这里自己读）。`extractTarGz(file, into, { maxEntries: 50_000, maxBytes: 2 GiB })`：`createReadStream → zlib.createGunzip → ustar 解析`。每个成员：路径 `normalize` 后不能是绝对路径、不能含 `..` 段、不能是空；类型只接受普通文件（`'0'`、`'\0'`）和目录（`'5'`），**symlink、hardlink、设备文件一律拒**（I1 保证包里无 symlink，compact 布局在 I1 已换成 win 用 hoist、POSIX 包里 node_modules 的 symlink——核对 I1 结论：`checkServerTree` 要求"包内没有 symlink"对六个包都成立；如果 I1 的 POSIX 包仍含 symlink，这里要接受相对、不逃出根的 symlink，测试第 5 节有一条专门盯这个）；mode 只保留 `0o755`/`0o644` 两种（可执行位照包里的）。超过 `maxEntries`/`maxBytes` 中止并抛 `ArchiveError 'too_big'`。
- `extractZip(file, into, …)`：复用 `build-server.mjs` 的 `unpackZip` 思路（central directory → 本地头 → `inflateRaw`），加同样的路径和类型检查；zip 的 external attrs 里有 symlink 位（`0xA000`）也拒。
- 解到 `releases/<v>.part/`，解包前 `rm -rf` 这个 `.part`（只有这个目录可以删：它是本进程刚建的、在 `<installRoot>/releases/` 下、名字以 `.part` 结尾，三条都满足才删——`removeStaging(installRoot, version)` 函数内部检查）。

### 4.4 检查：`checkCoreUpdate` 的 `standalone` 分支

`D/service/standalone-update.ts`：
```
checkStandaloneUpdate(deps): Promise<{ current, latest: string | null, hasUpdate, channel: 'stable', refused?: 'rollback' | 'signature' | 'network' | 'config' }>
deps = { installRoot, config: () => ServerUpdateConfig | null, fetch, now, readState, writeState, currentVersion }
```
1. `config()` 为 null → `{ latest: null, refused: 'config' }`。
2. `fetchManifest` → 失败按 reason 映射到 `refused: 'network' | 'signature'`，记事件 `update-manifest-refused`。
3. C4 的回滚保护 → 不过 `refused: 'rollback'`。
4. `hasUpdate = isNewer(manifest.version, current)`；`latest = manifest.version`（即使等于 current 也回，界面显示"已是最新 0.9.0"）。写 `update-state.json`（`lastCheckAt = now()`）。
- `machine.checkCoreUpdate`：`distribution.kind === 'standalone'` 走这里，回复加 `channel: 'stable'` 和 `refused?`；其他种类照旧。
- 24 小时一次：`D/host/…` 的 daemon 启动后 60 秒查第一次，之后每 24 小时；结果缓存在内存，`checkCoreUpdate` 带 `fresh: false` 时直接回缓存（默认 `fresh: true`，界面点"检查"是 fresh）。定时器用 `deps.setTimeout`，测试里注入假时钟。查失败只记事件，不重试（下一个 24 小时再来）。

### 4.5 应用：`performStandaloneUpdate`

`machine.applyCoreUpdate { version?, allowDowngrade? }`（protocol 加可选参数；没参数 = 升到清单版本）。`standalone` 时：

0. 不是 `standalone` → 照旧路径。`allowDowngrade && !version` → `RpcError 'bad-args'`。
1. `acquireUpdateLock()` 为 null → `RpcError 'conflict'`、`reason: 'update_in_progress'`。拿到后 `writeUpdateStatus({ phase: 'installing', from: current, at, detail: 'downloading' })`，**立刻回复** `{ type: 'done', message: '开始更新…' }`（`kind: 'read'`，不是 `shutdown`——下载可能几分钟，连接不能挂着），后面的步骤在 `afterReply` 里跑，进度全在 `update-status.json`，客户端轮询 `coreUpdateStatus`。
2. 决定目标：
   - 升级：`checkStandaloneUpdate` → `hasUpdate` 为假 → 状态 `done`、`message: '已是最新'`、放锁、结束。`refused` → `error`、`message` 按 reason（第 15 节没有这几句，文案在 §7 补进 `product.md`）。
   - 降级（`allowDowngrade && version`）：**只接受本机 `releases/<version>/standalone.json` 存在的版本**，不下载（没有签名清单能证明旧版本的包，而 `releases/` 保留了上一版，回滚目标总在）。不存在 → `error`、`message: '本机没有 <v>，只能降到保留着的上一版 <previous>'`。跳到第 6 步。和总设计不一样：见 §4.11。
3. 下载到 `releases/<v>.part/download.<ext>`：`fetch(files[target].url, { signal: AbortSignal.timeout(600_000) })`，流式写文件，每 1 MiB 更新一次 `progress`；`Content-Length` 不等于 `size` 直接拒（省得下完才发现）；累计超过 `size` 中止。失败 → `removeStaging`、`error`、放锁。
4. `detail: 'verifying'`：流式 `sha512` 对比清单（**不**用 sidecar）。不等 → `removeStaging`、`error { message: '下载内容和发布清单不一致' }`。
5. `detail: 'unpacking'`：`extract*` 到 `releases/<v>.part/`（解完删 `download.<ext>`）；检查 `standalone.json.version === v`、`app/bin/vonvon.mjs`、`node/bin/node`（win：`node/node.exe`）存在；`chmod 755` node（tar 已带，zip 不带）。然后 `rename('releases/<v>.part', 'releases/<v>')`。`releases/<v>` 已存在（上次下载过没切）→ 先 `stat` 它的 `standalone.json`，完整就直接用、删 `.part`。
6. `detail: 'switching'`：`switchCurrent(installRoot, v)` → `{ previous }`。状态改成 `{ phase: 'restarting', from, to: v, previous, at, detail: 'draining' }`。写完状态**再**放 `update.lock`？不：锁要留到助手/新进程写 `done`——`runSamePortRestartHelper` 今天就是"等锁释放再启动"，这里的锁由**旧 daemon 进程退出时**由 OS 释放（锁文件按 pid 存活回收），新进程启动看到 `restarting` 且 `to === 自己的版本` 就 `finishOwnedUpdate(status, 'done')`（见 §4.6 托管路径）。
7. `control.requestRestart(port, status)`：排空（bot 做完手上的活，现有逻辑）→ 托管时退 75、不托管时起助手。记事件 `update-standalone-swapped { from, to }`。

崩在每一步：
- 步 1–5 崩：`current` 没动，重启后还是旧版；`update.lock` 的 pid 死了会被回收；`.part` 留在那里，下次升级第 3 步先 `removeStaging`，`releases/` 清理（§4.10）也删 `.part`。状态文件停在 `installing`：daemon 启动时 `readUpdateStatus()` 是 `installing` 且锁不是活的 → 改写成 `error { message: '上次更新中断' }`。
- 步 6 `switchCurrent` 中途崩：POSIX `rename` 原子，`current` 是旧或新；`current.next` 残留下次 `unlink`。Windows `current.txt.tmp` 残留同理。
- 步 6 之后、排空之前崩（非 0 退出）：管理器 5 秒后按 `current` 拉起**新版**。新进程看到 `restarting` 且 `to === 自己版本` → 写 `done`。等价于升级成功，只是没排空。
- 排空中崩：同上。
- 新版起不来（崩溃循环）：§4.6 的回滚。

### 4.6 重启助手和回滚

两条路径都要能回滚：
- **非托管**（`vonvon daemon start` 起的 detached daemon、容器、无 GUI 的 Mac）：`runSamePortRestartHelper` 改成：
  1. 等 `update.lock` 释放（现有，上限 30 秒）；
  2. `spawn(launcher, ['daemon', 'start', '--port', port])`，`launcher` = `standalone` 时 `<installRoot>/bin/vonvon`（**启动器**，它 exec `current/...`，所以起的是新版），其他种类照旧 `process.execPath + selfEntry()`；
  3. 轮询 pid 锁（每 500 毫秒），**60 秒**内要出现 `pid !== oldPid && startedAt !== oldStartedAt` 的新 owner；
  4. 新 owner 的 `version === update.to` → `finishOwnedUpdate(update, 'done')`；
  5. 版本不对（launcher 没切到、或者 `current` 被别人改了）或 60 秒没 owner → `switchCurrent(installRoot, update.previous)` → 再 `spawn(launcher, ['daemon', 'start', …])` → 再等 **25 秒** → `finishOwnedUpdate(update, 'error', '新版本起不来，已切回 <previous>')`，`rolledBack: true`，事件 `update-standalone-rolled-back`。第二次也起不来 → 同样写 `error`，`message` 加"请运行 `vonvon daemon start`"。助手总共最多 30 + 60 + 25 + 几秒，有上限。
  助手自己跑的是**旧版本**的代码（`selfEntry()` 钉住了，§4.7），所以它对 `switchCurrent` 的理解和写 `previous` 时一致。
- **托管**（systemd / launchd / I4b 监督进程）：没有助手，旧进程退 75 后管理器拉起 `current`。回滚由**新进程自己**和**旧版本留下的看门狗**配合：
  - 新进程 `D/host/bootstrap.ts` 启动早期：`readUpdateStatus()` 为 `restarting` 且 `to === currentVersion()` 且 pid 锁拿到了 → `finishOwnedUpdate(status, 'done')`；`to !== currentVersion()`（管理器拉起的还是旧版，比如 `current` 没切成）→ `finishOwnedUpdate(status, 'error', '重启后仍是 <version>')`。
  - 新版起不来（在拿到 pid 锁之前就崩）：管理器每 5 秒拉一次，永远拉不起来。看门狗：旧进程在第 7 步退出**之前**起一个 detached 的 `__update-watchdog <installRoot> <update JSON>`（和助手同一套脱离 cgroup / `windowsHide` 的 spawn，`VONVON_SERVICE` 不传给它），它只做一件事：睡到 **90 秒**后读 `update-status.json`，仍是 `restarting`（没人写 done/error）→ `switchCurrent(previous)` → 写 `error { rolledBack: true }` → 退出，管理器下一次拉起的就是旧版。`done`/`error` 已写 → 直接退出。看门狗跑旧版代码（钉住的入口）。systemd 下用 `systemd-run --user --scope` 脱离服务 cgroup（和今天助手一样，否则 `KillMode=control-group` 会随旧 daemon 一起被杀）；launchd 没有 cgroup 问题；Windows 由 I4b 的监督进程负责同一件事（它收到 75 时本来就要看 `current.txt`），所以 **win32 不起看门狗**，契约写在 C6 和 I4b §4.3。
  - 90 秒的来源：管理器 5 秒重试 + Node 启动 + 拿 pid 锁通常 2 秒内；留足 bot 子进程多的机器。看门狗读状态时顺带检查 `update.lock` 不是活的（活的说明有别的升级在进行，不动）。

### 4.7 `D/core/self-entry.ts`

- `export const selfEntry = once(() => realpathSync(process.argv[1]))`，模块加载时就求值（启动时 `current` 指向的目录就是这个进程的目录；切 `current` 之后再 realpath 会解析到新版）。八处 `process.argv[1]` 换成 `selfEntry()`。`process.execPath` 已是 realpath（Node 启动时解析过 `current/node/bin/node`）——在 Linux 上核实 `process.execPath` 是否解析符号链接：Node 文档说 `execPath` 是绝对路径但不一定解析了 symlink；测试第 5 节有一条，不对就在 `self-entry.ts` 里同样 `realpathSync(process.execPath)` 导出 `selfNode()`，八处一起换。
- 启动器 `bin/vonvon` 和服务定义仍写 `current/...`：那是"下次启动用新版"的意思；钉住只针对**已经在跑的进程**派生的子进程和助手。

### 4.8 `vonvon update`

注册到 `cli/index.ts`（走 `preAction` 的 lease 检查照旧，它不在跳过名单里）。`covers('update', 'bad-args', 'connection', 'refused', 'conflict', 'failed', 'outcome-unknown')`，`parity-allowlist.ts` 删掉 `pending('I3', …)`。
- `--check`：连上 daemon 发 `checkCoreUpdate`；文字版打印"当前 x，最新 y（有新版本 / 已是最新 / 没查到：原因）"；`--json` 原样输出回复。daemon 没在跑：`standalone` 时**本地**跑 `checkStandaloneUpdate`（同一份代码，`source: 'local'`），别的种类回 `connection`（exit 3）。
- 不带 `--check`：
  1. daemon 在跑：发 `applyCoreUpdate { version?, allowDowngrade? }`；`conflict` → exit 5；然后每 500 毫秒 `coreUpdateStatus`（排空期间白名单放行，C8），打印 `detail`/`progress` 的变化（文字版一行覆盖，`--json` 每次变化一行 JSON Lines）。
  2. 连接断了（daemon 退出重启那一刻）：改读本机 `update-status.json`（同一个数据目录），直到 `done`/`error`，**上限 120 秒**（覆盖 §4.6 的 60 + 25 + 余量；90 秒看门狗也在里面）。`done` → exit 0，打印"已更新到 y"；`error` → exit 1，打印 message，`rolledBack` 时加"已切回 x"；超时 → exit 6（`outcome-unknown`），打印"结果待定，稍后 `vonvon update --check` 或 `vonvon status`"。
  3. daemon 没在跑、`standalone`：本地直接做第 §4.5 的 2–6 步（下载、校验、解包、切 `current`），**不启动**，打印"已切到 y，运行 `vonvon daemon start` 生效"。拿不到 `update.lock` → exit 5。
  4. `bundled`：daemon 在跑 → 发 `applyCoreUpdate`（U4 接）；没在跑 → 今天的文案"在桌面端里更新"，exit 4。`global-npm` 照旧 `runUpdate` 的逻辑。`development` → exit 4 "开发态不升级"。
- `--allow-downgrade` 必须带 `--to`，否则 exit 2；`--to` 不是语义版本 exit 2。

### 4.9 protocol、排空白名单、UI

- `P/machine.ts`：`applyCoreUpdate` 请求 `{ type, version?: z.string().regex(semver), allowDowngrade?: z.boolean() }`；`coreUpdate` 回复加 `channel?: z.string()`、`refused?: z.string()`；`coreUpdateStatusSchema` 按 C3。`P/admin.ts` 的 `distribution` 已在 I1 加了 `standalone`。
- `D/server/ws.ts` 排空白名单改读 `MAINTENANCE_KINDS`（C8）。
- `U/management/UpdatePanel.tsx`：按钮可点条件改成 `distribution.kind ∈ {standalone, global-npm} && hasUpdate`（`attached` 不再要求：standalone 的 daemon 不是桌面端带的，`attached` 对它没意义）；`bundled` 的按钮和"要开着桌面端"文案归 U4，这里 `bundled` 仍禁用、文案照旧。进度条读 `progress`，`detail` 映射成中文（下载中 / 校验中 / 解包中 / 切换中 / 等 Bot 做完手上的活 / 等新版本启动 / 已切回旧版）。`phase` 不认识的显示"进行中"。

### 4.10 清理 `releases/`

- 升级 `done` 之后（新进程写 `done` 的那一处）和每次启动：列出 `releases/*`，保留 `current` 指向的和 `update-status.json.previous`（没有就是 `current.txt` 第 2 行 / 空），其余版本目录和所有 `*.part` 删掉。删法：`rm(dir, { recursive: true })` 只对 `<installRoot>/releases/` 的**直接子目录**、名字匹配 `^\d+\.\d+\.\d+(\.part)?$`、而且目录里有 `standalone.json` 或名字以 `.part` 结尾的目录；函数内部四条检查都过才删。Windows 上旧版本的 `node.exe` 可能还被进程占着 → `EBUSY`/`EPERM` → 记事件 `update-cleanup-skipped`、下次再试，不报错。
- 事件：`update-standalone-downloaded`、`update-standalone-swapped`、`update-standalone-rolled-back`、`update-manifest-refused`、`update-cleanup-skipped`、`update-config-missing`、`update-state-unreadable`。

### 4.11 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.5 历史最高版本和 `publishedAt` 记进 `standalone.json` | 安装根 `update-state.json`（C4） | `standalone.json` 在版本目录里、每版一份、随目录删；回滚保护要跨版本只有一份 |
| §7.2 Windows 启动器退回 `standalone.json` 里记的上一版 | `current.txt` 第 2 行（C5） | 那个文件在可能缺失的 `releases\<v>\` 里，读不到 |
| §7.5 "降级只能在本机 `--allow-downgrade --to <v>` 显式要求" 没说包从哪来 | 只降到本机 `releases/` 里还在的版本，不下载 | 非 stable 版本只有未签名清单，下载了也没法验签；`releases/` 保留上一版，回滚目标总在 |
| §7.5 助手"等新 owner 出现后核对 `serverInfo.version`" | 核对 pid 锁里的 `version`（`daemon.pid` 已有） | 不用再开 ws 连接；pid 锁是新进程拿到端口前就写好的 |
| §7.5 只写了助手回滚 | 加托管路径的看门狗 `__update-watchdog`（90 秒） | 托管时没有助手；`current` 已指新版，新版起不来时管理器只会每 5 秒拉起同一个起不来的新版，没人切回去就永远起不来 |
| §7.4 Windows 监督进程收到 75 看 `current.txt` | 同；Windows 不起看门狗，监督进程兼任（I4b） | 两个人切 `current.txt` 会打架 |
| `applyCoreUpdate` 回 `kind: 'shutdown'` 立刻排空 | 先回 `done` 再后台下载，排空在切 `current` 之后 | 下载几十 MB 要分钟级，不能在那之前就排空、拒绝新请求 |

## 5. 测试

全部在 `packages/daemon/test/`，vitest；`HOME`、`VONVON_HOME` 只写在命令前：`T=$(mktemp -d); HOME=$T/home VONVON_HOME=$T/vh flock /tmp/vonvon-heavy.lock npx vitest run packages/daemon/test/standalone-*.test.ts`。所有测试用 `mkdtemp` 的安装根和数据目录、注入的 `fetch`/`now`/`setTimeout`/`spawn`/`run`，不碰真服务管理器、不连网。

假 CDN：`test/helpers/fake-cdn.ts` 给一个 `fetch` 函数，从内存 `Map<url, { status, body, headers }>` 回应，记录请求；`signManifest(payload, privateKey)` 用测试里 `generateKeyPairSync('ed25519')` 现生成的钥匙（不进仓库）。假包：`test/helpers/fake-release.ts` 用 `build-server.mjs` 导出的 `writeTarGz`/`writeZip` 从一个最小目录树（`standalone.json`、`app/bin/vonvon.mjs`、`app/package.json`、`node/bin/node` 一个 shell 脚本 exec 真 node）打出 tar.gz/zip。

| 文件 | 输入 → 期望 | main 必败 |
|---|---|---|
| `standalone-manifest.test.ts` | 合法信封 → 解析出六个 files；改 payload 一个字节 → `signature`；签名 63 字节 → `envelope`；`channel: 'beta'` → `schema`；某个 `url` 换成别的主机 → `url`；多一个键 → `schema`；`version: '1.0'` → `schema`；65537 字节 → `too_large`；`publishedAt: 1.5` → `schema` | 是（文件不存在） |
| `standalone-manifest.test.ts` | `fetchManifest` 遇 301 → `http`；body 流到 64 KiB + 1 中止 | 是 |
| `archive.test.ts` | 含 `../x` 的 tar → 拒且目标目录为空；绝对路径成员 → 拒；symlink 成员 → 拒；zip external attrs 0xA000 → 拒；正常包 → 文件和 mode 一致；50,001 个成员 → `too_big`；如果 I1 的 POSIX 包含相对 symlink，这条改成"相对且不逃出根的 symlink 接受" | 是 |
| `current-release.test.ts` | POSIX：切 1.0.0 → `readlink === 'releases/1.0.0'`、残留 `current.next` 被清；`releases/1.0.1/standalone.json` 缺 → `ReleaseIncomplete` 且 `current` 不变；Windows 分支（platform 注入）：首次写两行 `1.0.0\n\n`，再切 1.0.1 → `1.0.1\n1.0.0\n`，`current.txt.tmp` 不残留 | 是 |
| `standalone-update-check.test.ts` | 清单 1.0.1 当前 1.0.0 → `hasUpdate: true`、状态文件 `highestSeen: 1.0.1`；再给 `publishedAt` 更小的 1.0.2 → `refused: 'rollback'`、`latest: null`、状态不变；`highestSeen: 1.0.1` 时给 1.0.0 → `rollback`；`server-update.json` 缺 → `refused: 'config'`；假时钟推 24 小时 → `fetch` 被调第二次，23 小时 → 没有 | 是 |
| `standalone-update-apply.test.ts` | 完整流程（假 CDN、假包、注入 `requestRestart` 记录调用）→ 顺序：status `installing/downloading` → `verifying` → `unpacking` → `switching` → `restarting{previous:'1.0.0', to:'1.0.1'}` → `requestRestart` 被调一次、`current` 指 1.0.1、`releases/1.0.1.part` 不存在；sha512 不对 → `error`、`.part` 已删、`current` 未动、`requestRestart` 没调；`Content-Length` ≠ size → 不读 body 就 `error`；`update.lock` 已被活 pid 占 → `RpcError conflict`；`allowDowngrade` 到本机没有的版本 → `error` 且文字含 `previous`；到本机有的 → 直接 `switching`、没有 `fetch` 调用；`hasUpdate` 假 → `done` '已是最新'，锁已放 | 是 |
| `standalone-update-apply.test.ts` | 崩溃点：在 `unpacking` 后注入抛错 → 状态 `error`、`.part` 残留；再跑一次 → 先 `removeStaging` 再下载；状态文件停在 `installing` 且锁 pid 不存活 → 启动清理改成 `error '上次更新中断'` | 是 |
| `daemon-restart.test.ts`（扩） | 注入 `readLock` 序列：旧 owner ×3 → 新 owner `version: '1.0.1'` → `done`；新 owner `version: '1.0.0'` → `switchCurrent(previous)` 被调、第二次 `start` 被调、最终 `error{rolledBack:true}`；60 秒内没新 owner（假时钟）→ 回滚；回滚后 25 秒仍没 owner → `error` 文字含 `daemon start`；`standalone` 时 `start` 的命令是 `<installRoot>/bin/vonvon`，`global-npm` 时仍是 `execPath + entry` | 是 |
| `update-watchdog.test.ts` | 90 秒后状态仍 `restarting` → 切回 previous、写 `error rolledBack`；状态已 `done` → 什么都不动；`update.lock` 活着 → 不动 | 是 |
| `bootstrap-update-finish.test.ts` | 状态 `restarting to 1.0.1`、`currentVersion` 1.0.1 → `done`；`currentVersion` 1.0.0 → `error '重启后仍是 1.0.0'` | 是 |
| `self-entry.test.ts` | 在 mkdtemp 里建 `current -> releases/1.0.0`，用 `current/app/bin/x.mjs` 当 argv[1] 起子进程打印 `selfEntry()`，然后切 `current` 到 1.0.1，再让它打印一次 → 两次都是 `releases/1.0.0/...`；同时打印 `process.execPath` 的 realpath 情况（决定要不要 `selfNode()`） | 是 |
| `release-cleanup.test.ts` | `releases/{1.0.0,1.0.1,1.0.2,1.0.3.part,junk}`，current 1.0.2、previous 1.0.1 → 删 1.0.0 和 `1.0.3.part`，`junk`（无 standalone.json、名字不匹配）不动；注入 `rm` 抛 `EBUSY` → 事件 `update-cleanup-skipped`、不抛 | 是 |
| `cli-update.test.ts` | `--check --json` 连上假 daemon → 原样回复；daemon 不在、standalone → 本地检查、`source: 'local'`；`--allow-downgrade` 无 `--to` → exit 2；apply 时假 daemon 回 status 序列然后断连 → 改读文件 `done` → exit 0 文字含 `1.0.1`；文件一直 `restarting`、假时钟 120 秒 → exit 6；`error rolledBack` → exit 1 文字含 '已切回'；`development` → exit 4 | 是 |
| `cli-parity.test.ts`（已有） | `update` 不再在 pending 里；`covers` 的 kinds 和实现一致 | 是（白名单对不上） |
| `ws-drain.test.ts`（已有，扩） | 排空期间 `machine.coreUpdateStatus` 放行、`machine.checkCoreUpdate` 拒 | 是 |
| `protocol` 测试 | `coreUpdateStatusSchema` 接受 `phase: 'whatever'`；`applyCoreUpdate { version: 'x' }` 拒 | 是 |
| `UpdatePanel.test.tsx` | `standalone + hasUpdate` → 按钮可点；`standalone + !hasUpdate` → 不可点；`bundled` → 不可点、文案照旧；`detail: 'draining'` → 显示"等 Bot 做完手上的活" | 是 |

## 6. 自测和验收

JP-VPS 上，不碰 `accept-home2`、Bot 6、真 CDN、真 systemd：
1. `flock /tmp/vonvon-heavy.lock npm run build`，`flock … npx tsc -p packages/daemon --noEmit`，`flock … npm run lint -w packages/daemon`，第 5 节的测试文件全部绿。
2. 端到端（非托管路径）：`T=$(mktemp -d)`；现生成一对测试钥匙到 `$T/keys`；`node scripts/build-server.mjs --out $T/out --targets linux-x64 --update-public-key $T/keys/pub --update-base-url http://127.0.0.1:<port>/bot/server`（两次，`product-version` 临时在工作副本里改成 1.0.0 和 1.0.1——不提交；或者 `--version-override` 如果 I1 给了）；用 `scripts/dev/fake-cdn.mjs`（本片新增、不进包：`node:http` 静态目录 + 用 `$T/keys/priv` 签 stable 清单）在 loopback 起假 CDN；解开 1.0.0 到 `$T/root/releases/1.0.0`，`node … __standalone-setup`（I2 没合入就手工 `ln -s`）；`HOME=$T/home VONVON_HOME=$T/vh $T/root/bin/vonvon daemon start --port <p>`（detached，非托管）；`HOME=… VONVON_HOME=… $T/root/bin/vonvon update --json` → 看到 JSON Lines 的 `downloading → … → restarting → done`，`vonvon status --json` 的版本是 1.0.1，`readlink $T/root/current` 是 `releases/1.0.1`，`releases/1.0.0` 还在（previous）。
3. 回滚：把 1.0.2 的包里 `app/bin/vonvon.mjs` 改成 `process.exit(3)` 再打包、签清单；`vonvon update` → `error`、`rolledBack: true`、`current` 回到 1.0.1、daemon 仍在跑 1.0.1。
4. 回滚保护：把 1.0.1 的清单（`publishedAt` 更早）重新放到 stable → `vonvon update --check --json` 回 `refused: 'rollback'`。
5. 坏签名：换一把钥匙签 → `refused: 'signature'`。
6. 排空：在 Bot 6 的替身（`test/helpers` 里的假 bot 子进程，占着一个会话 20 秒）跑着时 `vonvon update`，`detail: 'draining'` 持续到它结束才 `restarting`；期间另开终端 `vonvon update --check` 被拒（排空）、`vonvon status` 放行。
7. 托管路径的看门狗只能单元测试 + 在 CI 的 Linux runner（systemd 用户实例可用时）用 I5 的冒烟跑一次；JP-VPS 不对真用户 `systemctl --user` 做任何改动。
8. 收尾 `rm -rf -- "${T:?}"`。

验收（owner 或 Mac Codex）：从 Mac 桌面端的设备页对 JP-VPS 测试用户的服务端点"升级"（I2a、D3、U1 合入后），看到进度和版本变化。Mac 上不装 standalone（2026-11-01）。本片合入前不要求。

## 7. 文档

- `docs/product.md` 3.10：加"服务端（standalone）升级怎么走：先换文件再重启、起不来切回上一版、升级期间 Bot 做完手上的活、`vonvon update` 的四种退出"；3.11 加"服务端的发布清单有签名、只接受更新的版本、不自动升级"。§4.5 第 2 步 `refused` 的三句文案补进第 15 节的表：`没查到新版本：发布清单的签名不对，没有应用`、`没查到新版本：发布清单比上次看到的旧，没有应用`、`没查到新版本：连不上 dl.vonvon.cc`。
- `docs/architecture.md` 55-65：加 `update-status.json`、`update-state.json`、`current` 三段（原来还写 75 的规则加 I4b 监督进程、`current.txt`，2026-11-01 起不写）。
- `docs/plans/devices.md` §7.5、§7.2 不改正文，加一行指到本文 §4.11。
- `docs/v1-plan.md` 不动（这批不在 v1 清单里）。

## 8. 验收要点

- 签名清单的信封、键顺序、每个 `url` 的字面规则和本文 C1 一致（2026-11-01 起两项，I3a 已写的六项在 I3 里改，和 I2a 的脚本一致）；坏签名、多键、`channel` 不是 stable、`url` 换主机都拒，拒绝时不把 payload 内容带进用户可见文字。
- 回滚保护：`publishedAt` 倒退或版本低于 `highestSeen` 的清单拒，`update-state.json` 在安装根、原子写。
- 应用顺序是 下载 → sha512 → 解包到 `.part` → 改名 → 切 `current` → 写 `restarting{previous}` → 排空 → 75；每一步崩都有对应的测试且 `current` 不会半新半旧。
- 助手按 pid 锁里的 `version` 判成功；60 秒 / 25 秒 / 90 秒三个期限都有测试；回滚后状态带 `rolledBack: true`。
- `selfEntry()` 替换了全部 `process.argv[1]`（grep 为零），切 `current` 后旧进程派生的子进程仍是旧版文件。
- `vonvon update` 四种退出（0 / 1 / 5 / 6）各有测试；断线后读文件、120 秒上限。
- 排空白名单读 `MAINTENANCE_KINDS`；UI 门控按 `distribution.kind`。
- 测试不碰真服务管理器、不连网、全部用注入的 fetch/clock/spawn；`HOME`、`VONVON_HOME` 只写在命令前。
- diff 里没有真实 id、密钥、本机路径；测试钥匙在测试里现生成。
- 新增的 `scripts/dev/fake-cdn.mjs` 不进包、不被 `build-server.mjs` 拷贝。

## 9. 风险和行数

- 托管路径的回滚靠看门狗，看门狗和新进程"谁先写状态"用 `finishOwnedUpdate` 的"只改自己那份"规则避免覆盖；但看门狗切回 `previous` 和新进程刚好起来之间仍有窄窗口（新进程拿到 pid 锁的同一秒看门狗切回）——新进程写 `done` 时再 `readCurrent()` 核对一次仍指自己，不是就改写 `error '升级和回滚撞上了，当前运行 <v>'`，让人看得见。
- `process.execPath` 在 Linux 上是否解析 symlink 要在第 5 节的测试里核实，决定 `selfNode()` 要不要。
- 自己写的 tar/zip 读取器是安全面：成员类型、路径、大小三道检查都有测试；不接受任何链接类型。
- `applyCoreUpdate` 从 `shutdown` 改成先回 `done`：客户端今天的代码（UI、`vonvon update` 旧逻辑）期待回复后连接会断；改完连接不断，UI 要改成轮询状态（§4.9 已含）。
- 行数估计 ~1,450（daemon 代码 ~750：manifest 120、archive 220、standalone-update 220、current-release 80、self-entry 20、watchdog 60、restart 改 60、bootstrap 20、cleanup 50；protocol 30；CLI 150；UI 60；测试 ~450）。超过 1,500 就拆：**I3a** = C1–C8 契约 + manifest + archive + current-release + check + apply + 事件（~900，含测试）；**I3b** = 助手/看门狗/bootstrap 回滚 + self-entry + `vonvon update` + 排空白名单 + UI 门控（~550）。I3a 单独合入时 `applyCoreUpdate` 对 standalone 先回 `unsupported`，不半开。
