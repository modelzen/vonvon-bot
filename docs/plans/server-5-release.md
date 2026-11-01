# I5 `server-5-release`：服务端包的发布脚本、`release-publish` 的 server 项、CI 冒烟

依据 `docs/plans/devices.md` §7.6（发布流水线）、§7.1 末尾（三平台同版本 0.9.0）、§13 的 I5 行、`AGENTS.md`"Mac 发布任务（owner 2026-10-26 定）"和"双平台发布版本（owner 2026-10-28 定）"。契约 C1（签名清单）、C2（服务端签名密钥、`server-update.json`、`updateKey: test`）在 `docs/plans/server-3-update-engine.md` §4.1。缩写同 `devices.md`。

## 1. 做什么

发布一个版本时，六个服务端包和它们的未签名清单随 macOS、Windows 的对象一起上传到 COS 的 `bot/server/<version>/`（禁止覆盖、公网复核）；**签名的 stable 清单和四个安装脚本只在 owner 本人确认后**写到 `bot/server/stable/` 和 `bot/server/`，和 macOS/Windows 切 stable 同一道门。`release-all.mjs build` 顺手打服务端包，`release-publish.mjs` 的 plan → upload → promote 各加一个 server 分支，`product-version.mjs` 管服务端包的版本。CI 的 Linux 任务加"打 linux-x64 包 + 在 `mktemp -d` 的 HOME 里真跑 `install.sh`"的冒烟；`ci-scope.mjs` 把 `scripts/install.*`、`scripts/build-server.mjs` 归全量。

## 2. 范围

做：
- `scripts/publish-server.mjs`：`planServerObjects`、`publishServerObjects`（版本化对象）、`planServerStable`、`promoteServerStable`（签名清单 + 脚本），`verifyServerPublic`。
- `scripts/server-update-signing.mjs`：`create-key`、`sign`、`verify`、`public-key` 四个子命令（照 `windows-update-signing.mjs`，用服务端那把钥匙）。
- COS 配置 `~/.config/vonvon-release/cos-server.json`（外部文件，不进仓库）：`{ bucket, region, prefix: 'bot/server/', publicBaseURL: 'https://dl.vonvon.cc/bot/server', secretIdEnv, secretKeyEnv, securityTokenEnv?, sdkModule, updatePrivateKeyFile }`，读法照 `readWindowsCosConfig`。
- `release-all.mjs`：`build` 阶段加 `server`（Linux 构建机或 Mac 上跑 `build-server.mjs --out <out>/server --targets <六个>`，产物进 `state.server`）；`status`/`collect` 列服务端包。
- `release-publish.mjs`：`plan` 的统一计划 SHA-256 覆盖 server 对象；`upload` 并发三个平台；`promote` 的 owner 确认同时切三个平台的 stable，server 的 stable 在 macOS、Windows 之后、最后一个切；`status`、website handoff 加服务端的下载地址和安装命令。
- `product-version.mjs`：`productVersion()` 读到的版本必须等于 `build-server.mjs` 写进 `standalone.json` 的；`checkedProductVersion()` 加"服务端包的 `vonvon-server-<v>-build.json` 存在时版本一致"。
- CI：`.github/scripts/ci-run.mjs` 的 Linux 分支在全量或 `scripts/install.*` / `build-server.mjs` 改动时加两步：`node scripts/build-server.mjs --out <tmp> --targets linux-x64 --update-public-key <tmp key> --update-base-url http://127.0.0.1:0/bot/server`（CI 里现生成测试钥匙）和 `node scripts/install-smoke.mjs --package <tmp>/… --key <tmp key>`；`ci-scope.mjs` 的路径表。
- `scripts/install-smoke.mjs`：起 loopback 假 CDN（签清单）、`mktemp` HOME、`PATH` 里放 `curl` 替身（或真 `curl` 指向 `http://127.0.0.1`——不行，脚本只允许 https，所以用替身）、真跑 `sh scripts/install.sh`、断言 `vonvon --version`、`vonvon open --print --json` 200、`vonvon hook` 退 0、`service install` 在 runner 上的退路（GitHub 的 ubuntu runner 有 systemd 用户实例但没有 linger；冒烟**不**让它真的 `systemctl --user enable`：`PATH` 里放 `systemctl` 替身让 `linux-session.ts` 判成 `no_systemd`，走 `daemon start` 退路，再 `daemon stop`），然后 `uninstall.sh`。
- `AGENTS.md`"双平台发布版本"扩成三平台；`.agents/skills/release-mac/SKILL.md` 加服务端一节（版本化上传 + 公网复核就停，切 stable 的确认规则不变）。

不做：
- 自动切 stable、按日期自动发布、灰度。
- 构建签名（服务端包没有 Apple/Windows 代码签名；信任根是 HTTPS + Ed25519 清单）。
- 官网内容（W1）；网站部署。
- Linux arm64 / macOS 的真机冒烟（CI 只有 Linux x64 托管 runner；macOS 自托管 runner 不跑安装脚本——它会在 `ci-user` 账号的 HOME 下真装 LaunchAgent）。

## 3. 现在的代码

- `scripts/build-server.mjs`（I1）：`buildServer({ out, targets, cache, allowDirty })` → 六个包 + `vonvon-server-<v>-build.json`（每个包的 sha256/sha512/size、`node`、`sha` 源码提交）；I3 加 `--update-public-key`、`--update-base-url`、`updateKey: 'test' | 'release'`。
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
| 六个包 | `<v>/vonvon-server-<v>-<target>.<tar.gz|zip>` | upload | 禁止 | 版本化长缓存（`cachePolicy(…, 'versioned')`） |
| 构建摘要 | `<v>/vonvon-server-<v>-build.json` | upload | 禁止 | 版本化 |
| 未签名清单 | `<v>/manifest.json`（C1 末段：payload 去 `channel`） | upload | 禁止 | 版本化 |
| 签名清单 | `stable/manifest.json` | **promote** | 允许（版本控制 bucket 留历史） | 不缓存（`'stable'`） |
| 脚本 | `install.sh`、`install.ps1`、`uninstall.sh`、`uninstall.ps1` | **promote** | 允许 | 不缓存 |

- 包的 sha512 来自 `vonvon-server-<v>-build.json`，upload 前再对本地文件算一次核对（防 build 之后文件被动过）。
- 脚本内容必须**逐字节等于**发布 SHA 那次 checkout 的 `scripts/install.sh` 等四个文件（`release-all.mjs` 的 `state.source` worktree），promote 时从那里读，不从当前工作目录读；写进计划的是四个文件的 sha256。
- 脚本和签名清单在 promote 一起切的原因：脚本里写死的公钥和 `BASE_URL` 必须和清单对得上，分开切会有"新脚本验旧清单"的窗口。

### 4.2 签名密钥和 `server-update-signing.mjs`

- `node scripts/server-update-signing.mjs create-key --out <绝对路径>`：`generateKeyPairSync('ed25519')`，私钥 PKCS#8 PEM 写到 `--out`（`wx`，0600），stdout 打印公钥的 raw 32 字节 base64 **和** SPKI PEM（分别给 `packages/daemon/server-update.json` 和脚本的 `PUBKEY_PEM`）。不打印私钥。
- `sign --key <文件> --payload <json 文件> --out <信封文件>`：读 payload 文件（必须是 C1 的合法 payload，先过同一套 zod schema——从 daemon 的 `standalone-manifest.ts` 导出的 schema 不能被 `.mjs` 直接 import，所以 schema 的**纯 JSON 校验**在 `scripts/server-manifest.mjs` 里再写一份，I3 的测试里有"两份对同一组样本结论一致"的交叉测试），`JSON.stringify` 一次得到紧凑字节、签名、写 `{ payload: base64, signature: base64 }`。
- `verify --public-key <base64|pem> --envelope <文件>`：解信封、验签、校验、打印 payload。
- `public-key --key <文件>`：从私钥导出两种格式的公钥。
- 私钥路径只从 `cos-server.json.updatePrivateKeyFile`（绝对路径，外部）读；没有环境变量路径（和 Windows 的 `VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE` 不同——那是历史，这里不再多一条进路）。
- **owner 要做的事**（本片合入前）：在 Mac 发布配置的目录里 `create-key`，把公钥 base64 写进 `packages/daemon/server-update.json`、PEM 写进 `install.sh`/`install.ps1` 的公钥段（I2a/I2b 的 PR 里带占位，I5 这里换成真的；或者 owner 生成后 Claude 在 I2 的 PR 里直接用真公钥）。私钥文件路径写进 `cos-server.json`。私钥不进仓库、不贴 GitHub、不进 Paseo 日志。

### 4.3 `publish-server.mjs`

- `readServerCosConfig(path)`：字段表 `['bucket','region','prefix','publicBaseURL','secretIdEnv','secretKeyEnv','securityTokenEnv','sdkModule','updatePrivateKeyFile']`；`prefix` 必须是 `bot/server/`，`publicBaseURL` 必须是 `https://dl.vonvon.cc/bot/server`（I3 C2 的 `baseURL`——两处常量从同一个 `scripts/server-constants.mjs` 读，daemon 的 `server-update.json` 由测试核对相等）；`updatePrivateKeyFile` 绝对路径、存在、0600。
- `planServerObjects({ out, version, sha })`：读 `<out>/server/vonvon-server-<v>-build.json`；`updateKey !== 'release'` → 抛"测试钥匙构建不能发布"；`sha` 不等于发布的源码 SHA → 抛；六个包都在且 sha512 重算一致 → 返回对象表（key、本地路径、sha512、size、contentType、cache 种类）+ 未签名清单的字节（从 build json 生成 payload，去 `channel`）。
- `publishServerObjects({ plan, config, client, log, cancelFile })`：照 `publishWindowsObjects`：每个对象 `putObject` 带 `x-cos-forbid-overwrite: true`（已存在 → 409 → 读回对象、sha512 相同就当已发、不同就抛）；每上传一个检查一次 `cancelFile`；全部上传后 `verifyServerPublic`：`fetch` 每个公网 URL（`assertSecureTransport`），比对 sha512、`Content-Length`、`cachePolicy`；写收据 `<out>/server/publish-receipt.json`（原子）。
- `planServerStable({ out, version, publishedAt, notes, privateKeyFile })`：生成 C1 payload（`channel: 'stable'`、`files` 的 `url` 用 `publicBaseURL`、`publishedAt` 用 **plan 时刻**并写进计划文件——promote 用计划里的同一个值，签出来的字节才能和计划的哈希一致）→ `sign` → 信封字节；读 `state.source` 的四个脚本 → 字节；检查 `install.sh` 里的 PEM 和 `server-update.json` 的公钥是同一把、且就是 `privateKeyFile` 对应的公钥（`publicKeyFromPrivate`）；返回 `{ manifest: bytes, scripts: {name: bytes}, sha256s }`，这些哈希进统一计划。
- `promoteServerStable({ plan, config, client, ownerConfirmation, planSHA256, cancelFile })`：`ownerConfirmation` 和 `planSHA256` 都必须有且 `planSHA256` 等于重算的计划哈希（和 `promoteWindowsUpdates` 同一套检查）→ 先读当前 `stable/manifest.json`（存在就解信封看 `version`，比要发的新 → 抛"stable 已经是更新的版本"；`publishedAt` 比要发的新 → 抛）→ 写四个脚本（`install.sh`、`uninstall.sh`、`install.ps1`、`uninstall.ps1`，允许覆盖）→ **最后**写 `stable/manifest.json` → `verifyServerPublic` 对 stable 五个对象（不缓存头、内容一致）→ 验签一次公网上拿回的清单 → 收据。顺序"脚本先、清单最后"：中途崩了，公网上是"新脚本 + 旧清单"，新脚本的公钥和旧清单是同一把钥匙（换钥匙是另一件事，不在本片），能用。
- 不碰 mac/Windows 的对象；不写 website。

### 4.4 `release-all.mjs` / `release-publish.mjs`

- `buildRelease`：mac 的两个架构之后加 `server`：`r.run(process.execPath, [join(state.source, 'scripts/build-server.mjs'), '--out', join(out, 'server'), '--targets', TARGETS.join(','), '--node-cache', join(out, 'node-cache')])`，`timed(state, 'server build')`；`state.server = { out, buildJSON, targets }`；失败照 mac 的处理（状态 `failed`，可 `resume`）。`build-server.mjs` 的六个包都能在 Mac 上打（没有原生模块，Node 二进制是下载的）。
- `releaseStatus`/`collectRelease`：加服务端六个包的名字、sha256、size。
- `planPublication`：`configs.server` 路径默认 `~/.config/vonvon-release/cos-server.json`、`--server-cos-config` 覆盖；计划里加 `server: { versioned: [...], stable: { manifestSHA256, scripts: {…}, publishedAt } }`；统一计划 SHA-256 覆盖它。没有 `cos-server.json` → 计划里 `server: null`，`upload`/`promote` 跳过服务端并在输出里写"服务端未配置"（0.9.0 之前的过渡；0.9.0 起 `checkedProductVersion` 要求三平台都有）。
- `uploadPublication`：三个平台并发（`Promise.all` 三项），任一失败整体 `rejected`，已上传的版本化对象留着（禁止覆盖 + 重跑收敛）。
- `promotePublication`：顺序 mac → Windows → **server**（和总设计一致：server 的 stable 最后），同一个 `ownerConfirmation`；server 失败 → mac、Windows 已切，输出明说"服务端 stable 未切，重跑 promote 只补服务端"（promote 幂等：mac/Windows 已是目标版本就跳过）。handoff 加 `server: { installCommand: 'sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/install.sh)"', installCommandWindows: 'irm https://dl.vonvon.cc/bot/server/install.ps1 | iex', downloads: {...} }`。
- 帮助文字：promote 的说明加"包括服务端的 stable 清单和安装脚本"。

### 4.5 版本

- `product-version.mjs`：`checkedProductVersion(root, { serverBuildJSON? })` 给了 build json 时核对 `version` 相等；`release-all.mjs prepare` 的版本门用它。`build-server.mjs` 本来就从 `productVersion()` 读版本，不另存一份。
- `AGENTS.md`"双平台发布版本"→"三平台发布版本"：macOS、Windows、服务端六个包同一个版本号；某个平台没变化也要出包；0.9.0 是第一个三平台版本。

### 4.6 CI

- `ci-scope.mjs`：`scripts/install.sh`、`scripts/install.ps1`、`scripts/uninstall.*`、`scripts/install-smoke.mjs`、`scripts/build-server.mjs`、`scripts/publish-server.mjs`、`scripts/server-*.mjs`、`packages/daemon/server-update.json` → `full`（原因字串 `server install/release script`）。`.ps1` 单独改时平台加 Windows（`pathPlatforms` 的表已有 `.ps1` → windows 的规则则沿用）。
- `ci-run.mjs` Linux 分支：`scope === 'full'` 或改动命中上面的路径 → 在包测试之后加 `{ executable: 'node', args: ['scripts/install-smoke.mjs'] }`。`install-smoke.mjs` 自己：`mkdtemp` 根 → `generateKeyPairSync` → `build-server.mjs --out <根>/out --targets linux-x64 --update-public-key … --update-base-url http://127.0.0.1:<port>/bot/server --allow-dirty`（CI 的 checkout 是干净的，`--allow-dirty` 只为本地跑）→ 签清单、放进 `<根>/cdn` → 起 `node:http` 假 CDN（loopback，端口 0）→ 写 `curl` 替身（把 `https://dl.vonvon.cc/bot/server/` 映射到 `http://127.0.0.1:<port>/bot/server/`，用真 `curl` 下载，保留 `-o`；记录参数）和 `systemctl` 替身（任何参数 → stderr `System has not been booted with systemd`、exit 1）→ `execFile('sh', ['scripts/install.sh'], { env: { HOME: <根>/home, PATH: <根>/shims:…, … } })` → 断言 exit 0、stdout 含"没有 systemd"和"已直接启动一次"、`<根>/home/.local/share/vonvon-bot/server/current` 指 `releases/<v>` → `HOME=… VONVON_HOME=<根>/home/.vonvon-bot bin/vonvon --version` 等于 `productVersion()` → `… open --print --json` 的 URL `fetch` 回 200 且 body 含 `<html` → `… hook` 退 0 → `… update --check --json`（I3 合入后；回 `latest === 当前`）→ `… daemon stop --json` → `sh scripts/uninstall.sh` → 安装根不存在、`.vonvon-bot` 还在 → 关假 CDN、`rm -rf -- <根>`（`<根>` 来自 `mkdtemp`）。超时 5 分钟整体。任何一步失败打印 `daemon.log` 末 100 行。
- macOS 自托管 runner **不跑**冒烟（会在 `ci-user` 的 HOME 下装 LaunchAgent）；Windows runner 不跑（`.ps1` 真跑要 `schtasks`，runner 的用户是服务账号，`LogonTrigger` 没意义；`.ps1` 的真机验收在 I2b 的 Windows 清单）。`ci-run.mjs` 按 `process.platform` 只在 linux 加这一步。
- `ci.yml` 不改 job 结构（Linux 的 ubuntu runner 已有 `curl`、`tar`、`sha512sum`、`openssl 3`）。

### 4.7 和总设计不一样的地方

| 总设计 | 这里 | 原因 |
|---|---|---|
| §7.6 "签名清单只有 stable 一份" | 同；补"四个脚本也只在 promote 写、脚本先清单后" | 脚本里的公钥和 `BASE_URL` 要和清单配套 |
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
| `publish-server.test.mjs` plan | build json `updateKey: 'test'` → 抛含"测试钥匙"；`sha` 不符 → 抛；某个包 sha512 不符 → 抛；正常 → 8 个对象（6 包 + build json + 未签名清单），key 以 `bot/server/<v>/` 开头，未签名清单没有 `channel`、`url` 全是 `https://dl.vonvon.cc/bot/server/<v>/…` | 是 |
| 同上 upload | 假 client：全部 `putObject` 带 `x-cos-forbid-overwrite`、顺序；第 3 个 409 且 `getObject` 返回相同 sha512 → 继续；不同 → 抛且后面的没传；`cancelFile` 在第 2 个之后出现 → 停、收据写了已传的 2 个；公网复核 `fetch` 回错 sha512 → 抛"公网内容不一致" | 是 |
| 同上 plan stable | `publishedAt` 由传入值决定，两次 plan 同参数 → 字节相同、哈希相同；`install.sh` 的 PEM 和 `server-update.json` 公钥不同 → 抛"脚本里的公钥不是这把"；私钥对不上 → 抛 | 是 |
| 同上 promote | 没有 `ownerConfirmation` → 抛，没有任何 `putObject`；`planSHA256` 不符 → 抛；当前 stable 版本更新 → 抛；顺序：四个脚本 → `stable/manifest.json` 最后；stable 对象的缓存头是 `no-cache`；写清单前 `cancelFile` 出现 → 脚本已写、清单未写、抛；公网拿回的清单验签过 | 是 |
| `release-publish.test.mjs`（扩） | 计划含 `server`，统一哈希随 server 的任一字节变化；`cos-server.json` 不存在 → `server: null`、upload 输出含"服务端未配置"；promote 顺序 mac → windows → server；server 失败 → 输出含"只补服务端"，再跑一次 → mac/windows 跳过、server 执行 | 是 |
| `release-all.test.mjs`（扩） | build 阶段调了 `build-server.mjs` 带 `--targets` 六个、`--out <out>/server`；失败 → 状态 `failed`、`resume` 重跑这一步；`collect` 列六个包 | 是 |
| `product-version.test.mjs` | build json 版本不等 → `checkedProductVersion` 抛 | 是 |
| `ci-scope.test.mjs`（已有，扩） | `scripts/install.sh` → full、原因含 `server install`；`scripts/install.ps1` 单独 → 平台含 windows；`packages/daemon/server-update.json` → full | 是 |
| `ci-run.test.mjs`（已有，扩） | linux + full → 计划含 `install-smoke.mjs`；darwin + full → 不含；linux + 只改 `packages/ui` → 不含 | 是 |
| `install-smoke.test.mjs` | 真跑一遍 `install-smoke.mjs`（它自己就是端到端；这个测试只在 `VONVON_SMOKE=1` 或 CI 下跑，本地默认 skip 以免每次 `npm test` 都打包 + 下载 Node——Node 二进制从 `--node-cache` 读，CI 用 actions cache 存 `server-node.json` 钉的那一个版本） | 是 |
| `agents-md.test.mjs`（如果有规则文件测试）| "三平台"字样存在 | 否 |

## 6. 自测和验收

JP-VPS：
1. §5 全绿；`node scripts/install-smoke.mjs` 本地跑一次（`flock /tmp/vonvon-heavy.lock`；Node 二进制下载一次进 `--node-cache`，之后复用）。
2. 发布脚本 dry-run：`T=$(mktemp -d)`，`create-key --out $T/key.pem`，写一个 `$T/cos-server.json`（假 bucket、`sdkModule` 指向测试里的假 client 模块），`build-server.mjs --out $T/out/server --update-public-key $T/pub --update-base-url https://dl.vonvon.cc/bot/server`（给了 `--update-public-key` 或 `--update-base-url` 任一个，`updateKey` 一律是 `test`，C2 的规则）→ `release-publish.mjs plan --out $T/out --dry-run`：`--dry-run` 下 `updateKey: 'test'` 只打警告不拒，列出 8 个版本化对象 + stable 五个对象和统一哈希；不带 `--dry-run` 的 `plan` 对同一份构建 → 被拒"测试钥匙构建不能发布" → `upload --dry-run` 不调 client → `promote` 没有 `--owner-confirmation` 被拒。`rm -rf -- "${T:?}"`。
3. 不碰真 COS、真 CDN、真钥匙。

验收（和 0.9.0 发布一起，Mac Codex 按 `release-mac` skill 做，owner 本人确认 stable）：
- `release-all.mjs build` 在 Mac 上产出 mac、Windows、server 三组；`release-publish.mjs plan` 的输出里 server 一节 8 + 5 个对象；`upload` 后 `https://dl.vonvon.cc/bot/server/0.9.0/…` 六个包能下、sha512 对、`manifest.json` 无 `channel`；**停在这里**，展示版本、SHA、哈希、URL；owner 在自己的 Codex App 会话里写明版本、SHA 和"发布到 stable"后 `promote`；之后 `curl https://dl.vonvon.cc/bot/server/stable/manifest.json` 验签过、`version` 0.9.0；在干净的 Linux 测试用户上 `sh -c "$(curl -fsSL https://dl.vonvon.cc/bot/server/install.sh)"` 装上（I2 的验收）；Windows `irm | iex` 装上（I2b）。
- 在 0.9.0 之前任何一次发布：`cos-server.json` 不存在时 mac/Windows 流程不受影响（计划 `server: null`）。

## 7. 文档

- `AGENTS.md`："双平台发布版本"改三平台（见 §4.5），"Mac 发布任务"加一句"服务端的 stable 清单和安装脚本与 macOS/Windows 的 stable 同一道门，经 #322/Paseo 的任务做到版本化上传 + 公网复核就停"。
- `.agents/skills/release-mac/SKILL.md`：加服务端一节（build 产物位置、`cos-server.json`、证据项：六个 sha512、未签名清单、签名清单的 `publishedAt`）。
- `docs/release-orchestration.md`：加 server 分支和对象表（§4.1）。
- `docs/product.md` 3.11：加"服务端包和桌面端同版本发布；发布清单有签名"。
- `README.md`：安装一节的服务端命令（I2 写的）URL 定下来：`https://dl.vonvon.cc/bot/server/install.sh`、`install.ps1`。

## 8. 验收要点

- 对象表（§4.1）：版本化对象禁止覆盖 + 公网复核；stable 五个对象只在 promote、`ownerConfirmation` + `planSHA256` 缺一不可、脚本先清单后、stable 不缓存。
- `updateKey: 'test'` 的构建不能 plan/upload；脚本里的公钥、`server-update.json`、私钥三者一致才能 plan stable。
- 统一计划哈希覆盖 server；`publishedAt` 在 plan 固定；promote 幂等、server 最后、失败能单独补。
- 私钥只从外部配置文件的绝对路径读，不打印、不进仓库、不进日志；`create-key` 用 `wx` + 0600。
- CI：`install-smoke.mjs` 只在 Linux、用 `mkdtemp` HOME、`systemctl` 替身、不碰 runner 的真服务；macOS/Windows runner 不跑；`ci-scope` 把脚本路径归全量。
- `product-version` 覆盖服务端；`AGENTS.md` 三平台同版本。
- 测试用假 client、假 fetch、现生成钥匙；`HOME` 只在子进程 env。
- diff 里没有真实 id、密钥、本机路径、bucket 名、COS 凭据。

## 9. 风险和行数

- 服务端签名密钥是新的信任根：丢了就换不了清单（所有已装机器验不过）；泄了就能给所有机器推包。放在 Mac 发布配置目录、和 Windows 更新私钥同等对待；备份由 owner 定（I5 不替 owner 决定备份放哪，验收时问一句）。
- `publishedAt` 单调：promote 时检查公网 stable 的 `publishedAt` 不比要发的新；如果有一天要回退 stable 到旧版本（`rollbackRelease` 那种），服务端这边要**重新签**一份 `publishedAt` 更新、`version` 更旧的清单——但 I3 的回滚保护会拒 `version < highestSeen`。所以服务端的 stable 回退 = 发一个更高版本号的修复版，不是指回旧版本；写进 `docs/release-orchestration.md`。
- CI 冒烟要下载 Node 二进制（~30 MB）：用 actions cache 按 `server-node.json` 的哈希缓存 `--node-cache`；缓存失效时多 1 分钟。
- `install-smoke.mjs` 依赖 I2a（脚本）、I3（`update --check`、`server-update.json` 进包的构建选项）合入；I5 可以先合，冒烟里对未合入的步骤按文件是否存在跳过并打印"跳过：等 I3"——不行：跳过会让 CI 绿得没意义。顺序上 I5 最后合（§13 依赖 I1、I2、I3），冒烟不写条件跳过。
- 行数估计 ~950（`publish-server.mjs` 260、`server-update-signing.mjs` 90、`server-manifest.mjs` 60、`server-constants.mjs` 10、`release-publish.mjs` 改 80、`release-all.mjs` 改 60、`product-version.mjs` 15、`install-smoke.mjs` 150、`ci-scope`/`ci-run` 30、文档 60、测试 ~350——测试多一些就到 1,100）。不拆。
