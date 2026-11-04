# Windows 差分更新单段 Range 兼容

## 做什么与范围

owner 要求修复 Windows 已有旧安装包缓存时的差分下载兼容问题，完成代码、验证及面向 dev 的 PR，留待验收，不合入或发布。从最新 origin/dev 开独立 worktree。只修改 Windows 自定义 Provider；不升级依赖，不改 macOS/Linux 更新、云服务、正式清单或版本。

## 当前代码与根因

基线 dev `f250aea5592d18a9012cb738919ebdd1b1cd05c6`，electron-updater 锁定 6.8.11。`createWindowsUpdateDriver` 的 SignedProvider 直接继承 GenericProvider，将 runtime 原样传入。AppUpdater 默认 `isUseMultipleRangeRequest=true`，custom Provider 不经过 generic 配置分支的 `useMultipleRangeRequest` 转换。因此设置应在 SignedProvider 传给基类的 runtime 上覆盖。

先前实际库与 HTTP 研究发现：0.9.0 → 0.9.1 的 35 段请求在 COS 得到非 multipart 的第一段响应，在所测 CDN 节点得到 416；单段模式两者均可重建，最终大小与 SHA-512 一致。这是历史库级实验，不是 Windows 客户端验收，也不证明线上回退比例。本次回归不依赖公网安装包。

## 修改方法

- `packages/desktop/src/windows-updates.ts`：向 GenericProvider 传入 `{...runtime,isUseMultipleRangeRequest:false}`，保留 executor、platform 及其他 runtime 字段，不修改调用方对象，不设置 `disableDifferentialDownload`。
- `packages/desktop/test/windows-updates.test.ts`：扩展已有 Windows CI 与发布构建回归入口，不改变 CI/发布脚本。使用运行时生成的 40 KiB 新旧夹具和 gzip blockmap，3 个不连续变化块各 4 KiB。受控服务拒绝多段 Range，支持单段 206 和完整 GET。
- 只替换 Electron app/session 和 socket，所有文件、用户数据和缓存写入各用例的临时目录；逻辑 URL 仍走产品域名校验，再在测试传输层映射到 loopback。Provider 验签、NSIS 缓存路径发现、差分规划/下载、全量回退和哈希均调用锁定版本的真实实现。拦截 quitAndInstall，不启动安装器。
- `docs/windows-updates.md`：说明兼容策略、回退及生效边界。没有 UI 或产品契约变化，无需修改历史 v1 切片清单。

## 测试与自测

1. 原 dev 必败：真实驱动经仅支持单段的服务重建 x64 时，预期零整包请求；原代码产生一次整包回退。修复后 x64/arm64 清单路径均以 3 个 206 Range 成功，下载差分数据 12,288 字节，重建 40,960 字节；完整 SHA-512 一致。分别覆盖远端旧 blockmap 与本地 current.blockmap。
2. 配置链路：真实驱动构建 Provider，验证 runtime 只覆盖多段选项、原对象未变、executor 身份和 platform 保留、差分开关仍为启用。
3. 缓存缺失、HTTP 416、差分内容损坏均进入真实全量回退并通过校验；损坏的完整下载或签名大小不符均拒绝安装。
4. 已成功重建的文件被同大小篡改或截短后，安装前再次校验失败，beforeInstall 和 quitAndInstall 均不调用。
5. 运行 `npm ci --no-audit --no-fund`、`npm run build`、`npm run typecheck -w @vonvon/desktop`、`npm run test -w @vonvon/desktop`、`npm run lint -w @vonvon/desktop` 和 `git diff --check`。PR 加 frozen 后按范围运行 Linux 和 Windows CI；不合入。

本机无已确认可用的隔离 Windows 运行环境（VMware 当前无运行中的 VM）。自动化即使在 Windows x64 CI 上通过，也不能替代 Electron/NSIS 真实客户端验收。不使用 Bot，不发送飞书消息，不碰 owner 默认数据或安装。

## Owner 验收步骤

在专用 Windows 测试用户或可回滚 VM 内，用独立应用身份、数据目录、更新缓存和测试签名密钥准备 A/B 两版；A 包含本修复，B 为内容有变化的较新测试版。测试构建需配套隔离 feed/网络映射，保持签名及域名约束，不为测试更改正式 stable 清单。若尚未准备这种环境，本轮只验代码/自动化，以下项目继续待验。

1. 安装 A，确认真实 NSIS 缓存已有对应旧 installer 与 blockmap。检查 B、点击下载；保存客户端日志和 HTTP 记录，确认每条 Range 不含逗号、没有完整 EXE GET，最终大小和 SHA-512 符合签名清单。
2. 点击重启升级，确认 B 启动、安装目录及数据保留，Bot/daemon 正常停止恢复；确认不是仅库级重建。
3. 恢复快照，移走隔离缓存中的旧 installer，再升级；确认完整 GET、校验及安装成功。
4. 恢复快照，让测试源对 Range 返回 416、完整 GET 正常；确认回退完整下载并成功安装。
5. 分别让完整 GET 返回损坏内容，以及在下载完成后篡改/截短待安装文件；确认拒绝安装、应用和 daemon 不因校验失败退出。
6. 另验 Windows ARM64、真实 Electron 网络限制和安装权限/SmartScreen。记录源码 SHA、系统/架构、版本、缓存路径（公开证据打码）、请求、文件大小和哈希。

旧客户端进入修复版时仍运行旧更新器，通常安装修复版后的下一次升级才受益。

## 验收要点与风险

- diff 不含凭据、真实用户/群 ID、本机私有路径；无正式发布、版本或其他平台变化。
- runtime 其余字段、签名清单、架构校验、域名限制、最终大小/SHA-512 和安装前校验保留。
- 单段请求次数多于 multipart，节省量与版本差异、旧缓存和网络有关，不承诺固定比例或速度。
- 约 200 行变更，主要为测试。真实客户端缓存生命周期、系统安装和 Windows ARM64 仍需上述隔离验收。
