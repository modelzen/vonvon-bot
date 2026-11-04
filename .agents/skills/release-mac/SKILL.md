---
name: release-mac
description: 发布 Vonvon Bot：固定版本与 main SHA，编排 macOS、Windows 和 Linux 服务端包的构建、公证、版本化上传和 stable 交接。用户要求发版、准备候选、上传或续跑发布时使用。
---

# Vonvon Bot macOS 发布

执行 owner 本次指定的阶段并保留可复核产物。owner 直接要求发布某版本，已授权该轮正常构建、签名、公证、版本化上传和公网核验，无需逐步重复询问；仅要求分析、工具修改或本地候选时，不扩展成公开发布。helper 的彩排也会提交 App 与 DMG 公证，不默认彩排。工作流或其他代理的“调用者授权”不能代替 owner。**stable 确认绑定已展示候选：owner 在自己打开的 Codex App 会话里，看过版本、准确源码 SHA、产物和计划哈希后，可以回复“确认”“发布当前候选”或“发布到 stable”，不要求手抄 SHA。代理原样保存回复，以 --reviewed-plan 和准确计划哈希绑定该候选。确认只覆盖展示过的计划；版本、来源、字节或计划改变时重新展示并确认。代理转述、队列消息和预填确认不算 owner 的回复。**计划文档、代理转述和先前同版本演练也不算。先完成具体可审阅候选，再请求一次最终 stable 确认；同一未变候选已经得到确认时直接继续，不重复问。

## 默认发布入口

普通三平台发版默认按 [三平台编排](../../../docs/release-orchestration.md) 执行，不要求用户点名本技能或优化方案：

1. 固定 owner 验收过的 main 完整 SHA 和三平台同一新版本。用 `scripts/release-all.mjs build`（中断用 `resume`）准备候选；Windows 完成后自动下载，与 Mac 等待重叠，下载子进程默认复用现有代理。
2. 用 `scripts/release-publish.mjs plan --out "$OUT"` 生成统一上传计划。展示版本、来源、对象摘要及计划哈希；本轮已授权完整发布时，直接执行 `upload --out "$OUT" --plan-sha256 "$PLAN_SHA256"`，Mac/Windows/Linux 版本化对象并行上传；源码启用 R2 镜像时，同一计划还包含 Linux 镜像上传。
3. 展示公网验证回执，按上面的候选确认规则取得最终确认。用 `promote --out "$OUT" --plan-sha256 "$PLAN_SHA256" --owner-confirmation "$OWNER_MESSAGE"` 切 stable；原样传 owner 回复，不能合成授权文字。
4. `promote` 自动收集 `release-handoff.json`；按官网既有发布工具消费四个桌面安装包入口、Linux 安装命令、更新日志、测试、部署预演和部署，再核对页面入口。完整发布请求已包含官网更新，不再额外询问同一部署。完成状态与临时源码清理分别记录。

失败后使用原 OUT/版本/SHA，先 `status`，再重跑失败子命令；不得因网络失败重建已验证候选。旧手工候选没有编排状态时，才用下面的底层 helper 诊断与恢复。

## 输入与门禁

- 固定版本、main 完整 SHA、彩排／正式模式；先 `git fetch origin main`，确认准确 SHA 在 `origin/main` 历史中。本轮不自动跟随 main。daemon/desktop 版本须与输入相同，版本仅支持三段数字；不同则走版本修复 PR，不在构建目录临时改号。
- 稳定地址为 `https://dl.vonvon.cc/bot/mac/stable/manifest.json`。正式版本须大于线上、COS 完整前缀历史和本机发布台账三者的最高版本。每次正式运行必传外部 `--cos-config`，见 [workflow.md](references/workflow.md)。超时、403、重定向、无效清单或 TLS 错误一律拒绝；不得用 `-k`、`--insecure`、`NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过，也不得用 `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_USE_SYSTEM_CA`、`--use-openssl-ca`、`--require`、`--import` 这类改信任链或预加载代码的设置，helper 和复核脚本会拒绝。`--cos-config` 的 key 只用只有 GetBucket 权限的子账号，SDK 按 workflow.md 照 `scripts/cos-sdk/` 的 lockfile 用 `npm ci` 装；COS 写入的 key 另配 `--cos-write-config`，见 workflow.md。
- 线上 manifest 正常 TLS 下确实是 HTTP 404 时分三种：COS 前缀里还有 `manifest.json`，一律停下查原因；COS 有旧 `feed-*.json`／`Vonvon-Bot-*` 或台账有版本（首发传了版本化对象但没切 stable、上传半途失败、首发撤回），显式加 `--no-live-manifest`，门槛取 COS 历史和台账的最高版本，记录 `baseline: {live: none, highestPublished: X}`；两边都空，才是首发，显式加 `--first-release`，记录 `baseline: none`。不能手写空列表充当 COS 证据。首发不免除 stable 的 owner 确认。
- 彩排版本不得超过下一次正式版本。彩排输出 `REHEARSAL-` 元数据和 `DO-NOT-PUBLISH`，不上传、不原样晋级。
- 更新配置只含 `manifestURL`、`teamIdentifier`，默认位于 `~/.vonvon-release/desktop-update.json`；地址须等于稳定地址，团队须与现有 Developer ID Application 证书相符。配置及真实身份值不提交。
- 公证默认钥匙串 profile `notelet-notary`。helper 在构建前检查凭据；人工诊断用 `xcrun notarytool history --keychain-profile notelet-notary --output-format json >/dev/null`，只看退出码，不打印其他项目历史。凭据失效就停止，不导出密码或私钥。

## 构建和公证

1. 读目标 SHA 的 `AGENTS.md` 和 helper `--help`。用 `T=$(mktemp -d)` 创建临时根，在原 checkout 外建 detach 源码 worktree。构建、测试和打包同一时间只由一个任务占用。开始前检查取消；经队列执行还须在 push、上传前和切 manifest 前重查取消。
2. 建立 `"$T/home"` 后，在源码 worktree 单条命令前指定隔离 HOME：`HOME="$T/home" npm ci`。不要预先运行 `package:universal` 或生成发布容器。helper 在初次打 App 前以 `--build-home` 隔离 HOME、同一外部更新配置强制执行 `npm run build`，重新核验 SHA 和包含未跟踪文件的干净状态，绑定构建来源；签名和公证步骤使用正常账号与钥匙串。隔离 HOME 限制配置读取，不是操作系统级私钥隔离。
3. `OUT` 必须是专用持久证据目录，位于 `T` 和系统临时目录之外，既不在源码 worktree 内，也不能包住 worktree；不传真实 home 或杂物目录。恢复仅复用同一候选的输出目录。绑定 `SOURCE_WORKTREE`、`VERSION`、`SOURCE_SHA`、`OUT`、`NEXT_VERSION` 后运行：

   ```sh
   VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" \
     node "$RELEASE_HELPER" --repo "$SOURCE_WORKTREE" --version "$VERSION" \
     --sha "$SOURCE_SHA" --out "$OUT" --build-home "$T/home" --mode rehearsal \
     --next-version "$NEXT_VERSION" --architecture arm64 --keychain-profile notelet-notary
   ```

   正式候选改为 `--mode release --notes-file "$NOTES_FILE" --cos-config "$COS_CONFIG"`；首发另加 `--first-release`，线上 404 而有发布历史时另加 `--no-live-manifest`。发行说明须非空 UTF-8。helper 不上传 COS、不刷新 CDN、不安装 App。
4. helper 分别构建签名 arm64、x64 App，检查各自实际 Mach-O 架构、Developer ID、hardened runtime、最小 entitlements、App/Core/build 版本、内置更新配置及不捆绑 Claude runtime 的约束。先公证签名 App，`Accepted` 且公证警告通过允许清单后，才钉票并验证；未知 warning 默认停止，不能自行放宽允许清单。
   分架构发布时，使用同一个源码 SHA、版本、配置、说明和基线，分别指定 `--architecture arm64`、`--architecture x64` 运行两次，每次使用独立持久 OUT；两次都须单独通过 App 与 DMG 的公证、钉票和验证。helper 不带 `--architecture` 时仍是历史兼容 universal，不用于正式发布。每个 OUT 的中断恢复单独进行。两者完成后执行：

   ```sh
   VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" \
     node "$SOURCE_WORKTREE/scripts/assemble-split-release.mjs" \
       --repo "$SOURCE_WORKTREE" --out "$SPLIT_OUT" \
       --arm64 "$ARM64_OUT" --x64 "$X64_OUT" --version "$VERSION" --sha "$SOURCE_SHA"
   ```

   `SPLIT_OUT` 是额外的空持久目录；后续发布工具的 `--out` 选它。聚合器重算两份证据与产物的哈希，重新解压 ZIP、只读挂载 DMG，逐个检查签名、架构、seal、票据和 Gatekeeper 后生成清单。它信任本机 helper 保存的状态及公证提交记录；这些可编辑的本地文件不是 Apple 公证日志的独立在线证明。真实公证的提交 ID、Apple 日志、签名和票据仍须按原流程复核，不得用模拟测试代替。
5. App 公证的传输 ZIP 用 Apple 文档的 `ditto -c -k --keepParent`；正式 0.7.0 之前要先跑一次彩排公证确认 `__MACOSX` warning 消失，见 workflow.md。从同一已钉票 App 生成最终 ZIP 与 prepackaged DMG；最终 ZIP 使用 `--sequesterRsrc --noqtn` 并保留代码签名扩展属性，不能用 `--norsrc` 粗暴剥除。DMG 单独签名、公证、钉票。对 ZIP 解压 App、DMG 只读挂载 App 再验签、钉票和 Gatekeeper，检查没有 `com.apple.quarantine`；不能只验工作目录原件。
6. 全部最终字节验证后生成 inventory、`SHA256SUMS` 和模式对应元数据。只按 inventory 选择公开对象；`app-notary-upload.zip`、App、解压目录、日志、`.blockmap`、builder 配置均为私有证据，**不得递归上传输出根目录**。中断恢复与警告诊断见 [workflow.md](references/workflow.md)。

## 公开发布与撤回

COS 写入只用 `scripts/release-cos-publish.mjs`，不得现场拼命令直接上传，用法见 [workflow.md](references/workflow.md)。先跑它的 `plan`，COS 零写入：核对本地证据和 `--local-only`，取线上 manifest 新快照，重算最高历史版本，确认 bucket 从未开启版本控制，把每个写操作写进 `OUT/publish-plan.json` 并打印它的 SHA-256。先展示 `plan` 的输出和这个哈希，再在本轮已获准的上传范围内用该哈希跑 `upload`；完整发布已授权上传，不重复提问；`upload` 只传版本化对象，带 `x-cos-forbid-overwrite: true`，不碰 manifest。写入的 key 另配 `--cos-write-config`，和只读枚举的 `--cos-config` 分开，写入、切换前都查 `--cancel-file`。只问 profile／配置路径，不索要密钥明文，不回显凭据文件，不把密钥放命令行；COS 写入凭据与 R2 镜像凭据分别确认存在和权限；CDN bypass 模式不需要每次发版调用刷新 API。

版本化 ZIP/feed/DMG 上传后，`upload` 用 `scripts/verify-public-release.mjs --versioned-only` 核验公网 HTTPS、完整 SHA-256 和每个对象的响应头（表见 workflow.md），通过后追加台账并打印它输出的 JSON（版本、源码 SHA、公证 submission ID、公开 URL 和哈希）。把这份 JSON 展示给 owner，再按本文开头那条规则取得确认，才可用 `promote` 最后切 stable manifest，`--owner-confirmation` 原样填 owner 那条消息。工具将回复绑定准确计划；带 `--reviewed-plan` 时接受简短肯定回复，旧完整格式也兼容。工具核不了是谁发的，只能填本文开头规则认的 owner 原话。使用 `scripts/verify-public-release.mjs` 复核固定 URL，不能跟随重定向或加随机 query 绕缓存；必须看到它的成功输出才算通过，不能只看退出码。只有公网复核通过才报告发布完成，并持久保存发布回执（`promote` 写 `OUT/publish-receipt.json`；复核失败时它不自动撤回，打印撤回命令并以非零退出）。复核因为网络抖动这类一时的原因失败，或者 `promote` 中途断了，用同一个计划哈希跑 `reverify` 补完复核和回执，它不写 COS；不再跑 `promote`。

manifest 使用 `Cache-Control: no-cache` 和 `application/json`；启用腾讯 CDN 时只支持显式的 `cdn: {provider: "tencent", mutablePolicy: "bypass"}`，可变对象及错误响应不缓存，具体路径和首次迁移步骤见 workflow.md；版本化文件使用 `public, max-age=31536000, immutable`，feed 也必须是 `application/json`。头传错了按 workflow.md 用 `fix-headers` 只改元数据，不覆盖字节、不废版本号。更新格式保持 Squirrel.Mac 的 manifest `{version, feedURL}`、feed `{url, name, notes, pub_date}`，同源 HTTPS。回滚只恢复事先验证并保存在计划里的旧 manifest（`rollback --restore-previous`；首发用 `rollback --delete-first-release-manifest` 只删 manifest；CDN bypass 下复核固定 URL，不做例行刷新）以停推，`--dry-run` 只打印、不留记录；撤回过的候选不能再 `plan`、`upload`、`promote`；已升级客户端不降级，修复版必须高于**曾发布的最高版本**。

## Linux 服务端包

0.9.0 起每次发布同时发 Linux 服务端的两个包（linux-x64、linux-arm64），版本号和 macOS、Windows 相同。不是 Linux 的机器装桌面端安装包，里面带着服务端。

- 签名钥匙：服务端的发布清单用单独的 Ed25519 钥匙签名，不和 Windows 的更新钥匙共用。第一次发布前，在 owner 的 Mac 上用 `node scripts/server-update-signing.mjs create-key --out <外部绝对路径>` 生成一次（文件 0600，已存在就拒绝），把它打印的 base64 公钥写进 `packages/daemon/server-update.json` 的 `publicKey`，PEM 写进 `scripts/install.sh` 的 `# BEGIN VONVON PUBKEY` 块，走 PR 合入后再从那个 main SHA 发布。私钥不进仓库，不贴、不打印；备份方式由 owner 定。
- 发布配置：默认 `~/.config/vonvon-release/cos-server.json`（或 `--server-cos-config`），只写 bucket、region、`prefix: "bot/server/"`、`publicBaseURL: "https://dl.vonvon.cc/bot/server"`、凭据的环境变量名和 `updatePrivateKeyFile`（私钥的绝对路径，0600），启用 CDN 时另加上述 `cdn` 策略。0.9.0 起这个文件必须在，最晚在 `plan` 之前建好：没有它，或者 `release-all` 的状态里没有打好的服务端包，`plan` 直接拒绝，不能只发 macOS 和 Windows；按以前的规则存下、没有服务端的计划，`upload`、`promote` 也拒绝，配好后重新 `plan`。0.9.0 以前的版本没有这个文件时，`plan` 写明"服务端未配置"，只发 macOS 和 Windows。
- 构建：`release-all.mjs build` 在两个 Mac 架构之后把两个包打进 `OUT/server/`（`vonvon-server-<v>-linux-x64.tar.gz`、`…-linux-arm64.tar.gz` 和构建记录 `vonvon-server-<v>-build.json`），Node 按 `scripts/server-node.json` 的钉值核过才用，缓存在 `OUT/node-cache`。构建记录的 `updateKey` 必须是 `release`：带 `--update-public-key` 打的测试包（`test`）和仓库里还没有公钥时打的包（`none`），`plan` 一律拒绝。
- `plan`：签一份 stable 清单（`OUT/server/stable-manifest.json`，只签一次，之后复用），核对私钥、`server-update.json`、包里的公钥和 `install.sh` 里的公钥是同一把，读一次线上的 stable 快照；线上比这次新、同版本却是另一份、或者 `publishedAt` 不比这次早，都拒绝。给 owner 看的除了 macOS、Windows 的对象，还有服务端两个包的 sha512 和大小、未签名的 `<v>/manifest.json`、签名清单的 `publishedAt` 和要切的三个 stable 对象，都在同一个计划哈希里。
- `upload`：两个包、构建记录和未签名清单写到 `bot/server/<v>/`，禁止覆盖，逐个公网复核，回执是 `OUT/server/server-publish-receipt.json`。经 #322／Paseo 的发布任务做到这里就停。
- `promote`：排在 macOS、Windows 之后，先写 `install.sh`、`uninstall.sh`，最后写签名清单 `bot/server/stable/manifest.json`，都是 `no-cache`。写第一个对象之前读一次线上清单，必须还是 `plan` 时的那份（重跑时也可以已经是这次的），不是就三个对象一个都不写；写清单之前再读一次，和 `plan` 时不同就停。切 stable 的确认规则和本文开头那条一样。只有服务端没切成时，用同一个计划哈希重跑 `promote`：已经切好的 macOS、Windows 只复核、不再写。回执是 `OUT/server/server-stable-receipt.json`；`release-handoff.json` 的 `server` 一项带安装命令和两个包，0.9.0 起 `readyForWebsite` 要等这份回执是 `published`。
- R2 镜像：源码 `packages/daemon/server-update.json` 的 `mirrorBaseURLs` 与构建记录必须一致。启用了镜像时，统一 `plan` 必须读取 `~/.config/vonvon-release/r2-linux.json`（或 `--r2-config`），其中 `publicBaseURL` 必须与包内镜像完全相同，不能临时去掉镜像绕过配置；配置哈希和镜像完整计划一起绑定 owner 看过的统一计划。只复制 Linux 包、原签名清单和脚本，不上传桌面包，不重签或改写规范 URL。外部配置和固定 SDK 安装见 [workflow.md](references/workflow.md#linux-r2-镜像)。
- R2 顺序与回执：版本化对象与三平台 COS 上传并行，完整字节公开验证通过后才可切 stable；R2 stable 在 COS 服务端 stable 公开验证后同步。`server/r2-publish-receipt.json`、`server/r2-stable-receipt.json` 必须与内外两层计划哈希、版本、源码及对象摘要匹配。镜像失败时保留其余回执，同一个计划续跑；官网交接必须等待镜像验证成功，不能只凭 COS 成功宣告整轮完成。最终 stable 确认仍遵守本文开头的准确候选规则，续跑同一候选沿用已取得的原始回复。
- 官网安装命令：使用 `release-handoff.json` 的 `server.installCommand` 完整多行内容，或同一 `OUT/linux-install-command.sh` 的内容。该命令最外层就并行获取完整安装脚本，不可替换成单域名 `curl`。0.9.1 旧包的更新器与旧安装脚本仍为单源，复制到 R2 不会改变行为；双源能力随包含新代码的正式包和脚本发布，不用开发脚本覆盖旧正式版本。
- 回退：装好的服务端不接受比自己见过的更低的版本，所以 stable 不能指回旧版本；有问题就发一个版本号更高的修复版。
- 证据：两个包的 sha512 和大小、未签名清单、签名清单的 `publishedAt`、两份回执。

## 输出与清理

区分签名、公证、钉票、版本化上传和 stable 发布状态；报告版本、准确 SHA、最终路径／尺寸／SHA-256、submission ID、已验证与未验证项。GitHub、文档和对话摘要不得贴 Key ID、Issuer ID、Team ID、Apple ID、密码、COS SecretId/SecretKey、IP、设备名、群号群名、飞书完整 id 或带凭据的网址。`/Users/<名字>` 写成 `/Users/<u>`，签名身份只写“Developer ID Application”。原始日志仅本机保存，对外先打码。

发布任务一律不碰 `/Applications/Vonvon Bot.app`、用户默认 daemon、bridge 与数据。保留持久产物后只用 `git worktree remove` 清理本任务的源码 worktree。以下硬规矩原样遵守：

- 临时目录只用 `T=$(mktemp -d)` 建，只用 `rm -rf -- "${T:?}"` 删，或者删刚在 `/tmp/` 下建的字面路径。
- 不对 `$HOME`、`~`、`$PWD`、`$VONVON_HOME` 或任何可能为空、未设置、指向真实 home 的变量拼出来的路径用 `rm`、`find -delete`、`find -exec rm` 或 `xargs rm`。
- 不在 shell 里给 `HOME`、`VONVON_HOME` 赋值或 export，只写在单条命令前面，例如 `HOME=$T/home VONVON_HOME=$T/vh npx vitest run`。
