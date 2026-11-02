# I5 `server-5-release`：服务端包的发布脚本、`release-publish` 的 server 项、CI 冒烟

依据 `docs/plans/devices.md` §7.6（发布流水线）、§7.1 末尾（三平台同版本 0.9.0）、§13 的 I5 行、`AGENTS.md`"Mac 发布任务（owner 2026-10-26 定）"和"双平台发布版本（owner 2026-10-28 定）"。契约 C1（签名清单）、C2（服务端签名密钥、`server-update.json`、`updateKey: test`）在 `docs/plans/server-3-update-engine.md` §4.1。缩写同 `devices.md`。

**2026-11-01 改动**（owner："Mac 和 Windows 上就直接通过安装包安装全部软件就好了，没有这种场景只安装 Server 端，也不用通过命令行安装"；`devices.md` 第 19 节）：服务端包只发 `linux-x64`、`linux-arm64`，安装脚本只有 `install.sh`、`uninstall.sh`（I2b 的 `.ps1` 取消）。I1 的 `build-server.mjs` 原来能打六个包，另外四个目标已由清理片 I6 删，现在只认两个 Linux 包（`PUBLISHED_TARGETS`）。签名清单的 `files` 只有两项：I2a 的脚本已经只认两项，I3 的 `SERVER_TARGETS` 在 I3 里改成两项，本片产出第一份清单时两边已经一致。下文已按两个包、两个脚本改过。

## 1. 做什么

发布一个版本时，两个服务端包（Linux）和它们的未签名清单随 macOS、Windows 的对象一起上传到 COS 的 `bot/server/<version>/`（禁止覆盖、公网复核）；**签名的 stable 清单和两个脚本（`install.sh`、`uninstall.sh`）只在 owner 本人确认后**写到 `bot/server/stable/` 和 `bot/server/`，和 macOS/Windows 切 stable 同一道门。`release-all.mjs build` 顺手打服务端包，`release-publish.mjs` 的 plan → upload → promote 各加一个 server 分支，`product-version.mjs` 管服务端包的版本。CI 的 Linux 任务加"打 linux-x64 包 + 在 `mktemp -d` 的 HOME 里真跑 `install.sh`"的冒烟；`ci-scope.mjs` 把 `scripts/install.*`、`scripts/build-server.mjs` 归全量。

## 2. 范围

做：
- `scripts/publish-server.mjs`：`planServerObjects`、`publishServerObjects`（版本化对象）、`planServerStable`、`promoteServerStable`（签名清单 + 脚本），`verifyServerPublic`。
- `scripts/server-update-signing.mjs`：`create-key`、`sign`、`verify`、`public-key` 四个子命令（照 `windows-update-signing.mjs`，用服务端那把钥匙）。
- COS 配置 `~/.config/vonvon-release/cos-server.json`（外部文件，不进仓库）：`{ bucket, region, prefix: 'bot/server/', publicBaseURL: 'https://dl.vonvon.cc/bot/server', secretIdEnv, secretKeyEnv, securityTokenEnv?, sdkModule, updatePrivateKeyFile }`，读法照 `readWindowsCosConfig`。
- `release-all.mjs`：`build` 阶段加 `server`（Linux 构建机或 Mac 上跑 `build-server.mjs --out <out>/server --targets linux-x64,linux-arm64`，产物进 `state.server`）；`status`/`collect` 列服务端包。
- `release-publish.mjs`：`plan` 的统一计划 SHA-256 覆盖 server 对象；`upload` 并发三个平台；`promote` 的 owner 确认同时切三个平台的 stable，server 的 stable 在 macOS、Windows 之后、最后一个切；`status`、website handoff 加服务端的下载地址和安装命令。
- `product-version.mjs`：`productVersion()` 读到的版本必须等于 `build-server.mjs` 写进 `standalone.json` 的；`checkedProductVersion()` 加"服务端包的 `vonvon-server-<v>-build.json` 存在时版本一致"。
- CI：`.github/scripts/ci-run.mjs` 的 Linux 分支在全量或 `scripts/install.*` / `build-server.mjs` 改动时加两步：`node scripts/build-server.mjs --out <tmp> --targets linux-x64 --update-public-key <tmp key> --update-base-url http://127.0.0.1:0/bot/server`（CI 里现生成测试钥匙）和 `node scripts/install-smoke.mjs --package <tmp>/… --key <tmp key>`；`ci-scope.mjs` 的路径表。
- `scripts/install-smoke.mjs`：起 loopback 假 CDN（签清单）、`mktemp` HOME、`PATH` 里放 `curl` 替身（或真 `curl` 指向 `http://127.0.0.1`——不行，脚本只允许 https，所以用替身）、真跑 `sh scripts/install.sh`、断言 `vonvon --version`、`vonvon open --print --json` 200、`vonvon hook` 退 0、`service install` 在 runner 上的退路（GitHub 的 ubuntu runner 有 systemd 用户实例但没有 linger；冒烟**不**让它真的 `systemctl --user enable`：`PATH` 里放 `systemctl` 替身让 `linux-session.ts` 判成 `no_systemd`，走 `daemon start` 退路，再 `daemon stop`），然后 `uninstall.sh`。
- `AGENTS.md`"双平台发布版本"扩成三平台（macOS、Windows 安装包和 Linux 服务端包）；`.agents/skills/release-mac/SKILL.md` 加服务端一节（版本化上传 + 公网复核就停，切 stable 的确认规则不变）。

不做：
- 自动切 stable、按日期自动发布、灰度。
- 构建签名（服务端包没有 Apple/Windows 代码签名；信任根是 HTTPS + Ed25519 清单）。
- 官网内容（W1）；网站部署。
- Linux arm64 / macOS 的真机冒烟（CI 只有 Linux x64 托管 runner；macOS 自托管 runner 不跑安装脚本——它会在 `ci-user` 账号的 HOME 下真装 LaunchAgent）。

## 3. 现在的代码

- `scripts/build-server.mjs`（I1）：`buildServer({ out, targets, cache, allowDirty })` → 两个 Linux 包（`PUBLISHED_TARGETS`，I6 起只有这两个）+ `vonvon-server-<v>-build.json`（每个包的 sha256/sha512/size、`node`、`sha` 源码提交）；I3 加 `--update-public-key`、`--update-base-url`、`updateKey: 'test' | 'release'`。
- `scripts/release-all.mjs`：`prepareRelease`（版本门、源码 worktree、runner 检查）→ `buildRelease`（mac 两个架构 + Windows Actions 分发）→ `releaseStatus` → `collectRelease`；状态文件原子写（`atomicJSON`）、`CANCEL` 文件、`lock`。
- `scripts/release-publish.mjs`：`planPublication` 打印统一计划的 SHA-256；`uploadPublication` 要 `--plan-sha256`，并发上传 mac 和 Windows 的版本化对象；`promotePublication` 要同一个哈希 + `--owner-confirmation`，切 stable、公网复核、写 website handoff；`publicationStatus`。配置路径 `~/.config/vonvon-release/cos-write.json`（mac）、`cos-windows.json`。
- `scripts/release-cos-publish.mjs`：`planPublish`/`uploadRelease`/`promoteRelease`/`reverifyRelease`/`rollbackRelease`/`fixReleaseHeaders`；禁止覆盖（`x-cos-forbid-overwrite`）、bucket 版本控制检查、stable 最后切、台账 `appendLedger`。
- `scripts/publish-windows.mjs`：`readWindowsCosConfig`（字段表 + `updatePrivateKeyFile` 必须绝对路径）、`windowsObjectPlan`、`publishWindowsObjects`、`planWindowsUpdates`（签 `latest.yml` 的信封）、`promoteWindowsUpdates`（要 `ownerConfirmation` + `planSHA256`）、`verifyWindowsPublic`。
- `scripts/release-cos-evidence.mjs`：`readCosConfig`、`isStableCosTarget`、`assertCredentialEnvNames`、`loadPinnedSdk`（COS SDK 版本钉死）。
- `scripts/verify-public-release.mjs`：`assertSecureTransport`、`cachePolicy(headers, kind)`（版本化对象长缓存、stable 不缓存）、`readStableManifest`、`verifyPublicRelease`。
- `scripts/windows-update-signing.mjs`：`create-key` / `sign`，私钥路径从 `VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE`。
- `scripts/product-version.mjs`：`productVersion`、`checkedProductVersion`（daemon、desktop 一致）、`syncProductVersion`。
- `.github/scripts/ci-scope.mjs`：`full(reason)`、`pathPlatforms(path, 'script')`、`scripts/` 下的路径按平台表；`ci-run.mjs`：Linux/macOS 对选中的包 `build` → `typecheck`/`lint` → 包测试 → `node --test scripts/*.test.mjs`；`ci.yml` 四个 job（scope、linux、macOS checks、Windows checks）+ `CI gate`。
- `AGENTS.md`：stable 的切换只认 owner 本人在自己的 Codex App 会话里、看完证据后、写明版本和 SHA 的那条消息；经 #322 / Paseo 的发布任务做到"版本化对象上传 + 公网复核"就停。

## 4. 怎么改

### 4.1 对象和路径

| 对象 | 路径（`prefix` = `bot/server/`） | 何时写 | 覆盖 | 缓存头 |
|---|---|---|---|---|
| 两个包 | `<v>/vonvon-server-<v>-linux-{x64,arm64}.tar.gz` | upload | 禁止 | 版本化长缓存（`cachePolicy(…, 'versioned')`） |
| 构建摘要 | `<v>/vonvon-server-<v>-build.json` | upload | 禁止 | 版本化 |
| 未签名清单 | `<v>/manifest.json`（C1 末段：payload 去 `channel`） | upload | 禁止 | 版本化 |
| 签名清单 | `stable/manifest.json` | **promote** | 允许（版本控制 bucket 留历史） | 不缓存（`'stable'`） |
| 脚本 | `install.sh`、`uninstall.sh` | **promote** | 允许 | 不缓存 |

- 包的 sha512 来自 `vonvon-server-<v>-build.json`，upload 前再对本地文件算一次核对（防 build 之后文件被动过）。
- 脚本内容必须**逐字节等于**发布 SHA 那次 checkout 的 `scripts/install.sh`、`scripts/uninstall.sh`（`release-all.mjs` 的 `state.source` worktree），promote 时从那里读，不从当前工作目录读；写进计划的是两个文件的 sha256。
- 脚本和签名清单在 promote 一起切的原因：脚本里写死的公钥和 `BASE_URL` 必须和清单对得上，分开切会有"新脚本验旧清单"的窗口。

### 4.2 签名密钥和 `server-update-signing.mjs`

- `node scripts/server-update-signing.mjs create-key --out <绝对路径>`：`generateKeyPairSync('ed25519')`，私钥 PKCS#8 PEM 写到 `--out`（`wx`，0600），stdout 打印公钥的 raw 32 字节 base64 **和** SPKI PEM（分别给 `packages/daemon/server-update.json` 和 `install.sh` 的 `PUBKEY_PEM`）。不打印私钥。
- `sign --key <文件> --payload <json 文件> --out <信封文件>`：读 payload 文件（必须是 C1 的合法 payload，先过同一套 zod schema——从 daemon 的 `standalone-manifest.ts` 导出的 schema 不能被 `.mjs` 直接 import，所以 schema 的**纯 JSON 校验**在 `scripts/server-manifest.mjs` 里再写一份，I3 的测试里有"两份对同一组样本结论一致"的交叉测试），`JSON.stringify` 一次得到紧凑字节、签名、写 `{ payload: base64, signature: base64 }`。
- `verify --public-key <base64|pem> --envelope <文件>`：解信封、验签、校验、打印 payload。
- `public-key --key <文件>`：从私钥导出两种格式的公钥。
- 私钥路径只从 `cos-server.json.updatePrivateKeyFile`（绝对路径，外部）读；没有环境变量路径（和 Windows 的 `VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE` 不同——那是历史，这里不再多一条进路）。
- **owner 要做的事**（本片合入前）：在 Mac 发布配置的目录里 `create-key`，把公钥 base64 写进 `packages/daemon/server-update.json`、PEM 写进 `install.sh` 的公钥段（I2a 的 PR 里带占位，I5 这里换成真的；或者 owner 生成后 Claude 在 I2a 的 PR 里直接用真公钥）。私钥文件路径写进 `cos-server.json`。私钥不进仓库、不贴 GitHub、不进 Paseo 日志。

### 4.3 `publish-server.mjs`

- `readServerCosConfig(path)`：字段表 `['bucket','region','prefix','publicBaseURL','secretIdEnv','secretKeyEnv','securityTokenEnv','sdkModule','updatePrivateKeyFile']`；`prefix` 必须是 `bot/server/`，`publicBaseURL` 必须是 `https://dl.vonvon.cc/bot/server`（I3 C2 的 `baseURL`——两处常量从同一个 `scripts/server-constants.mjs` 读，daemon 的 `server-update.json` 由测试核对相等）；`updatePrivateKeyFile` 绝对路径、存在、0600。
- `planServerObjects({ out, version, sha })`：读 `<out>/server/vonvon-server-<v>-build.json`；`updateKey !== 'release'` → 抛"测试钥匙构建不能发布"；`sha` 不等于发布的源码 SHA → 抛；两个包都在且 sha512 重算一致（build json 里还有别的目标 → 抛"服务端只发 Linux 包"）→ 返回对象表（key、本地路径、sha512、size、contentType、cache 种类）+ 未签名清单的字节（从 build json 生成 payload，去 `channel`）。
- `publishServerObjects({ plan, config, client, log, cancelFile })`：照 `publishWindowsObjects`：每个对象 `putObject` 带 `x-cos-forbid-overwrite: true`（已存在 → 409 → 读回对象、sha512 相同就当已发、不同就抛）；每上传一个检查一次 `cancelFile`；全部上传后 `verifyServerPublic`：`fetch` 每个公网 URL（`assertSecureTransport`），比对 sha512、`Content-Length`、`cachePolicy`；写收据 `<out>/server/publish-receipt.json`（原子）。
- `planServerStable({ out, version, publishedAt, notes, privateKeyFile })`：生成 C1 payload（`channel: 'stable'`、`files` 的 `url` 用 `publicBaseURL`、`publishedAt` 用 **plan 时刻**并写进计划文件——promote 用计划里的同一个值，签出来的字节才能和计划的哈希一致）→ `sign` → 信封字节；读 `state.source` 的两个脚本 → 字节；检查 `install.sh` 里的 PEM 和 `server-update.json` 的公钥是同一把、且就是 `privateKeyFile` 对应的公钥（`publicKeyFromPrivate`）；返回 `{ manifest: bytes, scripts: {name: bytes}, sha256s }`，这些哈希进统一计划。
- `promoteServerStable({ plan, config, client, ownerConfirmation, planSHA256, cancelFile })`：`ownerConfirmation` 和 `planSHA256` 都必须有且 `planSHA256` 等于重算的计划哈希（和 `promoteWindowsUpdates` 同一套检查）→ 先读当前 `stable/manifest.json`（存在就解信封看 `version`，比要发的新 → 抛"stable 已经是更新的版本"；`publishedAt` 比要发的新 → 抛）→ 写两个脚本（`install.sh`、`uninstall.sh`，允许覆盖）→ **最后**写 `stable/manifest.json` → `verifyServerPublic` 对 stable 三个对象（不缓存头、内容一致）→ 验签一次公网上拿回的清单 → 收据。顺序"脚本先、清单最后"：中途崩了，公网上是"新脚本 + 旧清单"，新脚本的公钥和旧清单是同一把钥匙（换钥匙是另一件事，不在本片），能用。
- 不碰 mac/Windows 的对象；不写 website。

### 4.4 `release-all.mjs` / `release-publish.mjs`

- `buildRelease`：mac 的两个架构之后加 `server`：`r.run(process.execPath, [join(state.source, 'scripts/build-server.mjs'), '--out', join(out, 'server'), '--targets', TARGETS.join(','), '--node-cache', join(out, 'node-cache')])`，`timed(state, 'server build')`；`state.server = { out, buildJSON, targets }`；失败照 mac 的处理（状态 `failed`，可 `resume`）。`build-server.mjs` 的两个 Linux 包都能在 Mac 上打（没有原生模块，Node 二进制是下载的）。
- `releaseStatus`/`collectRelease`：加服务端两个包的名字、sha256、size。
- `planPublication`：`configs.server` 路径默认 `~/.config/vonvon-release/cos-server.json`、`--server-cos-config` 覆盖；计划里加 `server: { versioned: [...], stable: { manifestSHA256, scripts: {…}, publishedAt } }`；统一计划 SHA-256 覆盖它。没有 `cos-server.json` → 计划里 `server: null`，`upload`/`promote` 跳过服务端并在输出里写"服务端未配置"（0.9.0 之前的过渡；0.9.0 起 `checkedProductVersion` 要求三平台都有）。
- `uploadPublication`：三个平台并发（`Promise.all` 三项），任一失败整体 `rejected`，已上传的版本化对象留着（禁止覆盖 + 重跑收敛）。
- `promotePublication`：顺序 mac → Windows → **server**（和总设计一致：server 的 stable 最后），同一个 `ownerConfirmation`；server 失败 → mac、Windows 已切，输出明说"服务端 stable 未切，重跑 promote 只补服务端"（promote 幂等：mac/Windows 已是目标版本就跳过）。handoff 加 `server: { installCommand: 'sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/install.sh)"', downloads: {...} }`（只有 Linux；Mac、Windows 照旧给桌面端安装包）。
- 帮助文字：promote 的说明加"包括服务端的 stable 清单和安装脚本"。

### 4.5 版本

- `product-version.mjs`：`checkedProductVersion(root, { serverBuildJSON? })` 给了 build json 时核对 `version` 相等；`release-all.mjs prepare` 的版本门用它。`build-server.mjs` 本来就从 `productVersion()` 读版本，不另存一份。
- `AGENTS.md`"双平台发布版本"→"三平台发布版本"：macOS、Windows 安装包和 Linux 服务端两个包同一个版本号；某个平台没变化也要出包；0.9.0 是第一个三平台版本。

### 4.6 CI

- `ci-scope.mjs`：`scripts/install.sh`、`scripts/uninstall.sh`、`scripts/install-smoke.mjs`、`scripts/build-server.mjs`、`scripts/publish-server.mjs`、`scripts/server-*.mjs`、`packages/daemon/server-update.json` → `full`（原因字串 `server install/release script`）。
- `ci-run.mjs` Linux 分支：`scope === 'full'` 或改动命中上面的路径 → 在包测试之后加 `{ executable: 'node', args: ['scripts/install-smoke.mjs'] }`。`install-smoke.mjs` 自己：`mkdtemp` 根 → `generateKeyPairSync` → `build-server.mjs --out <根>/out --targets linux-x64 --update-public-key … --update-base-url http://127.0.0.1:<port>/bot/server --allow-dirty`（CI 的 checkout 是干净的，`--allow-dirty` 只为本地跑）→ 签清单、放进 `<根>/cdn` → 起 `node:http` 假 CDN（loopback，端口 0）→ 写 `curl` 替身（把 `https://dl.vonvon.cc/bot/server/` 映射到 `http://127.0.0.1:<port>/bot/server/`，用真 `curl` 下载，保留 `-o`；记录参数）和 `systemctl` 替身（任何参数 → stderr `System has not been booted with systemd`、exit 1）→ `execFile('sh', ['scripts/install.sh'], { env: { HOME: <根>/home, PATH: <根>/shims:…, … } })` → 断言 exit 0、stdout 含"没有 systemd"和"已直接启动一次"、`<根>/home/.local/share/vonvon-bot/server/current` 指 `releases/<v>` → `HOME=… VONVON_HOME=<根>/home/.vonvon-bot bin/vonvon --version` 等于 `productVersion()` → `… open --print --json` 的 URL `fetch` 回 200 且 body 含 `<html` → `… hook` 退 0 → `… update --check --json`（I3 合入后；回 `latest === 当前`）→ `… daemon stop --json` → `sh scripts/uninstall.sh` → 安装根不存在、`.vonvon-bot` 还在 → 关假 CDN、`rm -rf -- <根>`（`<根>` 来自 `mkdtemp`）。超时 5 分钟整体。任何一步失败打印 `daemon.log` 末 100 行。
- macOS 自托管 runner **不跑**冒烟（2026-11-01 起脚本在 Mac 上只打印提示、退出，没有可装的包；这条由 I2a 的单测覆盖）；Windows runner 不跑（Windows 没有服务端包和安装脚本，2026-11-01）。`ci-run.mjs` 按 `process.platform` 只在 linux 加这一步。
- `ci.yml` 不改 job 结构（Linux 的 ubuntu runner 已有 `curl`、`tar`、`sha512sum`、`openssl 3`）。

### 4.7 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.6 "签名清单只有 stable 一份" | 同；补"两个脚本也只在 promote 写、脚本先清单后" | 脚本里的公钥和 `BASE_URL` 要和清单配套 |
| §7.6 CI 冒烟验证"`service install` 在无 systemd 下的退路" | 用 `systemctl` 替身制造无 systemd，不在 runner 上真 `systemctl --user` | runner 有用户实例，真装会改 runner 账号的服务状态；替身让路径可控、可断言 |
| §7.6 "复用 `DT/windows-update-manifest.mjs` 的签名代码" | 签名调用相同（`crypto.sign/verify` Ed25519），payload 校验在 `scripts/server-manifest.mjs` 单独写 | `.mjs` 脚本不能 import daemon 的 TS；Windows 的 `validateWindowsUpdatePayload` 校验的是另一种 payload |
| `cos-server.json` 的私钥路径可用环境变量（Windows 有） | 只认配置文件里的绝对路径 | 少一条进路 |
| 没写 promote 的幂等 | mac/Windows/server 任一已是目标版本就跳过那一项 | server 在最后，失败时要能只补它 |

## 5. 测试

`scripts/*.test.mjs`，`node --test`；跑法 `flock /tmp/vonvon-heavy.lock node --test scripts/publish-server.test.mjs scripts/server-update-signing.test.mjs scripts/install-smoke.test.mjs scripts/release-publish.test.mjs`。COS client 是假对象（记录 `putObject`/`getObject`/`headObject` 调用，`forbid-overwrite` 冲突模拟 409）；`fetch` 是假的；钥匙现生成；文件在 `mkdtemp`。

| 文件 | 输入 → 期望 | main 必败 |
|---|---|---|
| `server-update-signing.test.ts`→`.mjs` | `create-key` → 私钥文件 0600、stdout 两种公钥、两者对应同一把；已存在 → 拒（`wx`）；`sign` 合法 payload → 信封能被 `verify` 过、payload 字节是紧凑 JSON 且键顺序 C1；payload 多键 → `sign` 拒；`verify` 改一字节 → 拒 | 是 |
| 同上 | 交叉：用 I3 测试夹具里的同一组样本（合法 1 份、非法 8 份）跑 `scripts/server-manifest.mjs` 的校验 → 结论和 I3 `standalone-manifest.test.ts` 的期望表一致（样本放 `scripts/fixtures/server-manifest-cases.json`，两边都读它） | 是 |
| 同上 | sh 能读：用 `sign` 产出的信封跑 I2 `install.test.mjs` 的 sed 提取（导出成函数 `extractForShell`，或直接 `execFile('sh', ['-c', <同一段 sed>])`）→ 取到 `version`、`url`、`sha512`、`size` | 是 |
| `publish-server.test.mjs` plan | build json `updateKey: 'test'` → 抛含"测试钥匙"；`sha` 不符 → 抛；某个包 sha512 不符 → 抛；正常 → 4 个对象（2 包 + build json + 未签名清单）；build json 里有 darwin/win 目标 → 抛，key 以 `bot/server/<v>/` 开头，未签名清单没有 `channel`、`url` 全是 `https://dl.vonvon.cc/bot/server/<v>/…` | 是 |
| 同上 upload | 假 client：全部 `putObject` 带 `x-cos-forbid-overwrite`、顺序；第 3 个 409 且 `getObject` 返回相同 sha512 → 继续；不同 → 抛且后面的没传；`cancelFile` 在第 2 个之后出现 → 停、收据写了已传的 2 个；公网复核 `fetch` 回错 sha512 → 抛"公网内容不一致" | 是 |
| 同上 plan stable | `publishedAt` 由传入值决定，两次 plan 同参数 → 字节相同、哈希相同；`install.sh` 的 PEM 和 `server-update.json` 公钥不同 → 抛"脚本里的公钥不是这把"；私钥对不上 → 抛 | 是 |
| 同上 promote | 没有 `ownerConfirmation` → 抛，没有任何 `putObject`；`planSHA256` 不符 → 抛；当前 stable 版本更新 → 抛；顺序：两个脚本 → `stable/manifest.json` 最后；stable 对象的缓存头是 `no-cache`；写清单前 `cancelFile` 出现 → 脚本已写、清单未写、抛；公网拿回的清单验签过 | 是 |
| `release-publish.test.mjs`（扩） | 计划含 `server`，统一哈希随 server 的任一字节变化；`cos-server.json` 不存在 → `server: null`、upload 输出含"服务端未配置"；promote 顺序 mac → windows → server；server 失败 → 输出含"只补服务端"，再跑一次 → mac/windows 跳过、server 执行 | 是 |
| `release-all.test.mjs`（扩） | build 阶段调了 `build-server.mjs` 带 `--targets linux-x64,linux-arm64`、`--out <out>/server`；失败 → 状态 `failed`、`resume` 重跑这一步；`collect` 列两个包 | 是 |
| `product-version.test.mjs` | build json 版本不等 → `checkedProductVersion` 抛 | 是 |
| `ci-scope.test.mjs`（已有，扩） | `scripts/install.sh` → full、原因含 `server install`；`packages/daemon/server-update.json` → full | 是 |
| `ci-run.test.mjs`（已有，扩） | linux + full → 计划含 `install-smoke.mjs`；darwin + full → 不含；linux + 只改 `packages/ui` → 不含 | 是 |
| `install-smoke.test.mjs` | 真跑一遍 `install-smoke.mjs`（它自己就是端到端；这个测试只在 `VONVON_SMOKE=1` 或 CI 下跑，本地默认 skip 以免每次 `npm test` 都打包 + 下载 Node——Node 二进制从 `--node-cache` 读，CI 用 actions cache 存 `server-node.json` 钉的那一个版本） | 是 |
| `agents-md.test.mjs`（如果有规则文件测试）| "三平台"字样存在 | 否 |

## 6. 自测和验收

JP-VPS：
1. §5 全绿；`node scripts/install-smoke.mjs` 本地跑一次（`flock /tmp/vonvon-heavy.lock`；Node 二进制下载一次进 `--node-cache`，之后复用）。
2. 发布脚本 dry-run：`T=$(mktemp -d)`，`create-key --out $T/key.pem`，写一个 `$T/cos-server.json`（假 bucket、`sdkModule` 指向测试里的假 client 模块），`build-server.mjs --out $T/out/server --update-public-key $T/pub --update-base-url https://dl.vonvon.cc/bot/server`（给了 `--update-public-key` 或 `--update-base-url` 任一个，`updateKey` 一律是 `test`，C2 的规则）→ `release-publish.mjs plan --out $T/out --dry-run`：`--dry-run` 下 `updateKey: 'test'` 只打警告不拒，列出 4 个版本化对象 + stable 三个对象和统一哈希；不带 `--dry-run` 的 `plan` 对同一份构建 → 被拒"测试钥匙构建不能发布" → `upload --dry-run` 不调 client → `promote` 没有 `--owner-confirmation` 被拒。`rm -rf -- "${T:?}"`。
3. 不碰真 COS、真 CDN、真钥匙。

验收（和 0.9.0 发布一起，Mac Codex 按 `release-mac` skill 做，owner 本人确认 stable）：
- `release-all.mjs build` 在 Mac 上产出 mac、Windows、server 三组；`release-publish.mjs plan` 的输出里 server 一节 4 + 3 个对象；`upload` 后 `https://dl.vonvon.cc/bot/server/0.9.0/…` 两个包能下、sha512 对、`manifest.json` 无 `channel`；**停在这里**，展示版本、SHA、哈希、URL；owner 在自己的 Codex App 会话里写明版本、SHA 和"发布到 stable"后 `promote`；之后 `curl https://dl.vonvon.cc/bot/server/stable/manifest.json` 验签过、`version` 0.9.0；在干净的 Linux 测试用户上 `sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/install.sh)"` 装上（I2 的验收）；在 Mac 上跑同一条只打印去下载桌面端安装包的话、退出非零。
- 在 0.9.0 之前任何一次发布：`cos-server.json` 不存在时 mac/Windows 流程不受影响（计划 `server: null`）。

## 7. 文档

- `AGENTS.md`："双平台发布版本"改三平台（见 §4.5），"Mac 发布任务"加一句"服务端的 stable 清单和安装脚本与 macOS/Windows 的 stable 同一道门，经 #322/Paseo 的任务做到版本化上传 + 公网复核就停"。
- `.agents/skills/release-mac/SKILL.md`：加服务端一节（build 产物位置、`cos-server.json`、证据项：两个 sha512、未签名清单、签名清单的 `publishedAt`）。
- `docs/release-orchestration.md`：加 server 分支和对象表（§4.1）。
- `docs/product.md` 3.11：加"服务端包和桌面端同版本发布；发布清单有签名"。
- `README.md`：安装一节的服务端命令（I2 写的）URL 定下来：`https://dl.vonvon.cc/bot/server/install.sh`，写明只给 Linux，Mac、Windows 下载桌面端安装包。

## 8. 验收要点

- 对象表（§4.1）：版本化对象禁止覆盖 + 公网复核；stable 三个对象只在 promote、`ownerConfirmation` + `planSHA256` 缺一不可、脚本先清单后、stable 不缓存。
- `updateKey: 'test'` 的构建不能 plan/upload；脚本里的公钥、`server-update.json`、私钥三者一致才能 plan stable。
- 统一计划哈希覆盖 server；`publishedAt` 在 plan 固定；promote 幂等、server 最后、失败能单独补。
- 私钥只从外部配置文件的绝对路径读，不打印、不进仓库、不进日志；`create-key` 用 `wx` + 0600。
- CI：`install-smoke.mjs` 只在 Linux、用 `mkdtemp` HOME、`systemctl` 替身、不碰 runner 的真服务；macOS/Windows runner 不跑；`ci-scope` 把脚本路径归全量。
- `product-version` 覆盖服务端；`AGENTS.md` 三平台同版本（macOS、Windows 安装包和 Linux 服务端包）；只发两个 Linux 包。
- 测试用假 client、假 fetch、现生成钥匙；`HOME` 只在子进程 env。
- diff 里没有真实 id、密钥、本机路径、bucket 名、COS 凭据。

## 9. 风险和行数

- 服务端签名密钥是新的信任根：丢了就换不了清单（所有已装机器验不过）；泄了就能给所有机器推包。放在 Mac 发布配置目录、和 Windows 更新私钥同等对待；备份由 owner 定（I5 不替 owner 决定备份放哪，验收时问一句）。
- `publishedAt` 单调：promote 时检查公网 stable 的 `publishedAt` 不比要发的新；如果有一天要回退 stable 到旧版本（`rollbackRelease` 那种），服务端这边要**重新签**一份 `publishedAt` 更新、`version` 更旧的清单——但 I3 的回滚保护会拒 `version < highestSeen`。所以服务端的 stable 回退 = 发一个更高版本号的修复版，不是指回旧版本；写进 `docs/release-orchestration.md`。
- CI 冒烟要下载 Node 二进制（~30 MB）：用 actions cache 按 `server-node.json` 的哈希缓存 `--node-cache`；缓存失效时多 1 分钟。
- `install-smoke.mjs` 依赖 I2a（脚本）、I3（`update --check`、`server-update.json` 进包的构建选项）、I6（只剩两个目标）合入；I5 可以先合，冒烟里对未合入的步骤按文件是否存在跳过并打印"跳过：等 I3"——不行：跳过会让 CI 绿得没意义。顺序上 I5 最后合（§13 依赖 I1、I2a、I3、I6），冒烟不写条件跳过。
- 行数估计 ~950（`publish-server.mjs` 260、`server-update-signing.mjs` 90、`server-manifest.mjs` 60、`server-constants.mjs` 10、`release-publish.mjs` 改 80、`release-all.mjs` 改 60、`product-version.mjs` 15、`install-smoke.mjs` 150、`ci-scope`/`ci-run` 30、文档 60、测试 ~350——测试多一些就到 1,100）。不拆。

## 10. 实现时和计划不一样的地方

实现时（2026-11-02）照代码改了这些，理由写在每条后面。

- **plan 的两个函数合成一个** `planServerPublication`：版本化对象和 stable 三个对象一次算好，签名清单在 plan 时签一次、用 `wx` 写到 `OUT/server/stable-manifest.json`，之后的 upload、promote 复用这份字节，不在 promote 时重签。再跑 plan 时已签的那份和这次的包或说明不一样，就停（"候选变了"）。Ed25519 本身是确定的，重签也能得到同样的字节，但存一份字节更好查。
- **线上 stable 快照在 plan 时读**，写进统一计划（`previousManifest`）；线上比这次新、同版本却是另一份、`publishedAt` 不比这次早、或者用这把公钥验不过，plan 就拒。promote 写任何 stable 对象之前读一次，必须还是计划里的那份（重跑时也可以已经是这次的），不是就三个对象一个都不写；写清单前再读一次，必须和计划里的一样（计划写的是 promote 时才读、比版本）。这样 owner 看计划时就知道线上是什么，和 macOS、Windows 的做法一致；线上已经被别的版本切走时，两个脚本也不会先被覆盖（Codex 审查 270 的 P3）。
- **两个脚本不从 `state.source` 读**，用 `git show <发布 SHA>:scripts/install.sh` 从 `release-all` 开始时那个仓库读（`state.seedRepo`）。skill 要求发布完就删源码 worktree，promote 可能在那之后；按 SHA 取的字节和那个 worktree 里的一样。
- **桶的版本控制**：计划的对象表写 stable 对象"允许覆盖（版本控制 bucket 留历史）"。实际上 `x-cos-forbid-overwrite` 只在桶从没开过版本控制时生效，所以 upload 先查 `getBucketVersioning`，开过就停（和 Mac、Windows 同一条）。stable 的历史不靠桶：旧清单的版本、`publishedAt` 和 sha256 在统一计划里。线上原来没有清单时，写清单也带禁止覆盖。
- **409 和已存在的对象**：不用 `getObject` 读回，改成先 `headObject`，已存在或 409 就按公网地址整份下载、核 sha256 和 sha512，一样才算已经发过。和 Windows 的做法一致，也不需要给写入的 key 读权限。
- **回执的文件名**：`OUT/server/server-publish-receipt.json` 和 `OUT/server/server-stable-receipt.json`，不叫 `publish-receipt.json`，免得和 Mac 的同名回执混。stable 回执在每次写之前先记 `write-started`，切完记 `published` 和统一计划哈希；`collect` 只认属于这份计划的 `published`。
- **promote 的计划哈希**：`promoteServerStable` 只检查它在、是 64 位十六进制、写进回执；和重算的计划哈希比对由 `release-publish.mjs` 的 `reviewed()` 统一做（Windows 也是这样）。线上三个 stable 对象已经和计划一样时什么都不写，不要 owner 确认，只复核。
- **`release-publish.mjs` 没有 `--dry-run`**（§6 第 2 步写了 `plan --dry-run` 对测试钥匙只打警告）。一个能放过测试钥匙的开关就是一条把测试包发出去的路，没加。§6 的走查改成直接调 `publish-server.mjs` 的 plan → upload → promote，用测试钥匙、内存里的 COS 和假的公网地址，结果写在 PR 描述里。
- **0.9.0 起必须有服务端**，计划写的是"0.9.0 起 `checkedProductVersion` 要求三平台都有"。实现把版本门放在发布这一步（Claude 2026-11-02 定），`checkedProductVersion` 只核版本号：`release-all build` 每次都打两个服务端包，打完核它们的版本。版本 >= 0.9.0 时，`release-publish.mjs` 在没有 `cos-server.json`、或者 `release-all` 的状态里服务端包没打好（`server.phase` 不是 `complete`）时拒绝 `plan`，错误一句话写明缺什么、去 `docs/release-orchestration.md`「Linux 服务端包」配；同一处检查也挡住按以前的规则存下、没有服务端的计划的 `upload`、`promote`，`status` 也写明。`release-all collect` 在 >= 0.9.0 时不管计划里有没有服务端，`readyForWebsite` 都要服务端 stable 回执；`release-all status` 的 `server.required` 是 true。0.9.0 以前的版本照旧：没有 `cos-server.json` 就写明"服务端未配置"，只发 macOS 和 Windows。命令行或计划里指了配置路径而文件不在，直接失败。版本号放在 `server-constants.mjs` 的 `SERVER_REQUIRED_FROM`。
- **`checkedProductVersion` 在服务端包打完后核**，不在 `prepare`：`prepare` 时还没有构建记录。
- **`release-all build` 的服务端一步**：源码 worktree 里没有打好的网页（续跑时新建的 worktree）就先 `npm run build`；状态是 `state.server = { phase, report }`，失败记 `failed-or-interrupted`，`resume` 只重打服务端包；构建记录属于别的输入、或者包在构建后被改过，直接失败，不覆盖。
- **官网交接**：`release-handoff.json` 的 `server` 是 `{ published, stableVerified, installCommand, packages }`（计划写 `downloads`）。服务端的包不进 `downloads`，官网的下载入口仍是 macOS 和 Windows 的安装包；0.9.0 起（以前是统一计划里有服务端时），`readyForWebsite` 还要服务端 stable 回执是这份计划的 `published`。
- **CI 冒烟的范围**：Linux 上全量，或者选中了 daemon 的包（计划写"全量或命中服务端路径"——服务端路径本来就归全量）。服务端包就是 daemon，daemon 的改动也要真装一次。
- **CI 冒烟的 Node 缓存**：`ci.yml` 的 Linux 任务加了一步 `actions/cache`（键是 `scripts/server-node.json` 的哈希）和环境变量 `VONVON_SMOKE_NODE_CACHE`；任务结构没变。`build-server.mjs` 每次用之前都按钉值核对缓存里的 Node。
- **冒烟打本机的那个目标**（x64 的 runner 打 linux-x64，arm64 的打 linux-arm64），不写死 linux-x64。
- **假 CDN 上有两份清单**：daemon 的更新检查读 `http://127.0.0.1:<端口>/bot/server/stable/manifest.json`（测试包的 `server-update.json` 指这里），`install.sh` 经 curl 替身读 `/script/stable/manifest.json`；清单里的 url 必须以读它的地址开头，所以两份各签一次，包是同一个文件。`install.sh` 里的 `BASE_URL` 不改，只换公钥。
- **替身多了 `loginctl`**，和 `systemctl` 一样回"没有 systemd"。冒烟不单独跑 `daemon stop`：`uninstall.sh` 自己会停服务端，用户也是这样卸的；只有中途失败时才 `daemon stop`。
- **冒烟整体超时 10 分钟**（计划 5 分钟）：缓存没命中时要下载 Node，再打一个包。本机缓存命中时一次 3 分钟左右。
- **`install-smoke.test.mjs` 不跑整套冒烟**，只测替身、参数和目标；整套冒烟由 CI 的 Linux 任务直接跑 `node scripts/install-smoke.mjs`，不靠 `VONVON_SMOKE=1` 开关，`npm test` 也不会每次都打包。
- **共享样本**有 14 份（2 份合法、10 份 schema 不对、2 份地址不对），计划写的是 1 + 8。
- **`ci-scope.mjs`** 把"哪些原因不算收集出错"抽成 `isCollectionFailure`，加了 `server install/release script:`；不然新原因会让 scope 任务失败。
- **`release-publish.test.mjs` 原有的一条断言**要求 Mac 上传先于 Windows 开始，两个上传是并行的，谁先进假函数不一定（本机跑整个文件时偶尔反过来）。改成只比较集合，其余顺序断言不变。
