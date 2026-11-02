# 三平台发布编排

`scripts/release-all.mjs` 将每次重复的来源检查、Windows 调度、两架构 Mac 公证、聚合、下载和回执交接固定下来。Windows 在云端构建时，本机串行处理 arm64 和 x64；Windows 一完成就后台下载和校验，与 Mac 公证等待重叠。两个 Mac 架构之后，再打 Linux 服务端的两个包（见下面"Linux 服务端包"）。它复用现有 helper，不上传 COS、不切 stable、不部署官网，也不安装或启动 App。

首次使用前，本改动必须已经合入 main，所选源码 SHA 也须包含新发布链。该脚本不用于接管之前手工开始的候选。每次选一个新的产品版本和一个 main 完整 SHA；Core/Desktop 版本、Windows 构建、两个 Mac 架构和最终回执都绑定这组输入。main 后续推进不会改变源码。执行本机重命令前，仍须确认没有其他任务或自托管 CI 使用构建、测试和打包环境；本脚本的全局锁只协调本脚本的实例。

## 一个命令准备候选

owner 本轮要求完整发版或明确要求构建、公证后，运行：

```sh
node scripts/release-all.mjs build \
  --repo /absolute/repository --version X.Y.Z --sha FULL_40_CHARACTER_MAIN_SHA \
  --out /absolute/persistent/release-X.Y.Z \
  --update-config /absolute/external/desktop-update.json \
  --cos-config /absolute/external/cos-readonly.json \
  --notes-file /absolute/release-notes.md \
  --keychain-profile notelet-notary --authorize-notarization
```

这个命令会向 Apple 提交两个 App 和两个 DMG。`--authorize-notarization` 是明确的命令行关口，不能代替 skill 要求的 owner 本人授权。所有正式发布门禁继续执行：[release-mac skill](../.agents/skills/release-mac/SKILL.md)。首发或 stable 缺失仍按原规则显式传 `--first-release` 或 `--no-live-manifest`，不得用来绕过网络错误。

想先检查准备情况时，将 `build` 换成 `prepare` 并去掉 `--authorize-notarization`。`prepare` 只 fetch/读取，不提交 Apple、不构建、不发布。它检查：

- 完整 SHA 在 `origin/main`，该源码的产品版本与输入一致；正式版本高于线上、COS 全量历史和台账。
- 专用持久输出目录为空，外部配置可读且不在源码内；配置和发行说明的哈希保存后不得静默更换。
- 仓库 runner 与组织 runner 同时枚举。组织独有 runner 必须通过 runner group 的仓库授权，再按所有标签匹配；权限不足记为未知，不把“仓库级 0 台”称为离线。GitHub 托管 Windows runner 单独识别。Mac CI 的继承 runner 同样列入报告。
- 公证 profile 可用，Developer ID Application 与外部更新配置相符。凭据内容和账号历史不进入输出。

准备完运行 `build --out /absolute/persistent/release-X.Y.Z --authorize-notarization` 即可。构建使用新建 detach worktree 和临时隔离 HOME；git、签名、公证使用正常账号。输出、状态和证据留在持久目录。不会接触 owner 的 App、默认 daemon、bridge 或默认数据。

## 状态、中断与耗时

```sh
node scripts/release-all.mjs status --out /absolute/persistent/release-X.Y.Z
node scripts/release-all.mjs resume --out /absolute/persistent/release-X.Y.Z --authorize-notarization
node scripts/release-all.mjs cancel --out /absolute/persistent/release-X.Y.Z
```

`status` 可在构建期间单独调用：列出准确源码的 CI checks、Windows run 的排队/运行/失败状态及 job/step 耗时，以及每个 App/DMG 的 Apple 状态。构建等待时每 45 秒简报一次。Windows 每 15 秒查询一次，成功即开始下载；Mac 完成时 Windows 仍在排队或运行则返回 pending，之后用同一 OUT 续跑。后台下载的失败不会被 Mac 成功掩盖，退出时会中止并等待下载子进程组结束。Windows 失败会在下一个本机 helper 边界停止；聚合后也重查，失败以非零退出，不能由另一平台成功掩盖。

本机依赖下载、两个 Mac helper、聚合和 Windows 产物下载各自记录起止时间；Mac helper 另外追加 `mac-*/logs/timings.jsonl`，区分 `source-build`、App 打包、`app-submit`/`dmg-submit` 上传、`app-wait`/`dmg-wait` 等等待和验证。Windows API 保留原来的 install/test/package step 名称和秒数，便于比较下一次的真实瓶颈。进行中的阶段时长未知时写 `null`，不伪造完成耗时。

GitHub 下载优先使用显式代理环境变量；没有显式设置时，macOS 默认读取系统 HTTP(S) 代理，仅传给 `gh run download`，保留 `NO_PROXY`，不改系统设置或 TLS。PAC/SOCKS-only 不猜测。单次下载有 15 分钟上限；失败只重试原 run 的下载，已有完整候选按来源及哈希复用。

Windows 另缓存 `%LOCALAPPDATA%\electron\Cache` 和 `%LOCALAPPDATA%\electron-builder\Cache`，路径来自当前锁定的 `@electron/get`、`env-paths` 与 `app-builder-lib/util/electronGet`。只缓存官方 runtime/NSIS 等工具下载，键绑定 runner OS、架构与完整依赖 lockfile；不缓存源码、stage、应用产物或凭据。命中效果仍须用下一次真实 workflow 耗时核验。

`CANCEL` 在下一阶段前生效，不会撤销已经提交的 Apple/GitHub 作业；Ctrl+C 会转发给当前 helper。恢复前先看状态，明确继续时只移除本次 OUT 内的 `CANCEL` 标记。锁文件中记录 PID；遇到遗留锁先核实记录的进程已结束，不绕过活锁。初始化、读取/决定 dispatch 和状态写入使用同一把输出锁，两个会话不能覆盖候选或重复派发。

恢复使用原来的版本、SHA、配置哈希、输出目录和公证 ID。上传结果未知时，仍按 skill 核对 Apple 日志，再按架构传 `--recover-arm64 app=UUID` 或 `--recover-x64 dmg=UUID`；不会自动清空未知提交。完整候选重算哈希后复用。聚合被中断时保留部分目录，下一次使用新的空 `mac-combined-N`，不删除证据。

源码和 build HOME 在新建及续跑时都转成真实路径，CLI 入口也按真实路径比对；macOS 的 `/tmp`、`/private/tmp` 或自定义目录别名不会使 helper 静默空跑。

Windows dispatch 发出前先持久保存请求 UUID；丢失响应后只查询同一个请求，不再次触发工作流。GitHub 尚未返回 run 时，稍后 `resume`。如果确认网络请求根本未到达 GitHub，保留旧 OUT，用新 OUT 重新准备，不手改状态。失败 run 不会自动 rerun；先定位问题，涉及换字节时按现有发布规则使用新版本。

## 版本化上传与 stable 的边界

正常发布使用薄编排器，不逐个平台临时拼上传命令。`OUT` 是 `release-all` 总目录：

```sh
node scripts/release-publish.mjs plan --out "$OUT"
node scripts/release-publish.mjs upload --out "$OUT" --plan-sha256 "$PLAN_SHA256"
node scripts/release-publish.mjs promote --out "$OUT" --plan-sha256 "$PLAN_SHA256" --owner-confirmation "$OWNER_MESSAGE"
node scripts/release-publish.mjs status --out "$OUT"
```

`plan` 只读 COS，绑定版本、完整源码 SHA、Mac 原计划哈希、Windows run/来源/文件摘要和配置摘要，持久保存统一计划并打印其 SHA-256。`--plan-sha256` 填这份统一计划的哈希，不能填 Mac 子计划哈希。输入更改就拒绝，不静默更换候选。默认沿用构建时只读配置，写入配置用 `~/.config/vonvon-release/cos-write.json`，Windows 用 `~/.config/vonvon-release/cos-windows.json`；首次可通过 `--cos-write-config`、`--windows-cos-config` 指定外部路径，计划后不可更换。凭据仍只通过既有外部环境加载，不进入计划、源码或日志，详见 [workflow](../.agents/skills/release-mac/references/workflow.md)。

展示计划后，在本轮已获准范围内运行 `upload`；完整发布请求已包括该阶段，不重复询问。Mac/Windows 上传并行，分别沿用禁止覆盖和完整公网 SHA-256 核验；一个失败会保留另一个的回执，重跑相同命令只续未完成平台。CANCEL 在每次写入前检查。Mac 的 ZIP/DMG 全量回读改为每架构两条流并行，依然验证全部字节；本改动不采用 HEAD 代替哈希，也不减少公证次数。

展示公网回执后，owner 在本聊天确认当前候选即可，不必手抄完整 SHA。`promote` 将原始回复和准确计划绑定，只有匹配的两平台上传回执齐备才提升 Mac stable；中断后从已写 manifest 的回执 `reverify`，已发布候选不重复写，成功自动调用 `collect`。旧底层 `release-cos-publish.mjs` 仍可诊断/恢复；简短确认用 `--reviewed-plan`，旧完整确认格式继续兼容。最终确认规则以 `AGENTS.md` 与发布 skill 为准，脚本不能证明回复人身份，不能代写 owner 回复。

## Linux 服务端包

0.9.0 起，macOS、Windows 安装包和 Linux 服务端包（linux-x64、linux-arm64）同一个版本号（`AGENTS.md`"三平台发布版本"）。服务端的发布配置是 `~/.config/vonvon-release/cos-server.json`（或 `--server-cos-config`），这个文件不在时 `plan` 写明"服务端未配置"，这次只发 macOS 和 Windows；命令行或计划里指了路径而文件不在，直接失败。配置、签名钥匙和证据项见 [release-mac skill](../.agents/skills/release-mac/SKILL.md) 的"Linux 服务端包"。

- `build`：两个 Mac 架构之后，用 `scripts/build-server.mjs --targets linux-x64,linux-arm64` 打进 `OUT/server/`，Node 缓存在 `OUT/node-cache`；`product-version.mjs` 核对构建记录的版本。`status` 列出两个包。构建失败或被打断，`resume` 只重打服务端包，Mac 的公证不重做；构建之后包被改过直接失败。
- `plan`：服务端的候选（两个包、构建记录、未签名清单、签好的 stable 清单、两个脚本和线上 stable 快照）写进统一计划，和 macOS、Windows 用同一个计划哈希。构建记录的 `updateKey` 不是 `release`（测试钥匙打的包，或者仓库里还没有发布公钥）就拒绝。
- `upload`：服务端是和 macOS、Windows 并行的第三个分支，各自保留回执；失败的那个在报错里点名，重跑只补它。
- `promote`：顺序是 macOS、Windows、服务端。服务端没切成时，macOS 和 Windows 已经是新版本，报错写明"用同一个计划哈希重跑 promote，只补服务端"；重跑时已经切好的只复核。

| 对象 | COS 键 | 写入 | 缓存 |
| --- | --- | --- | --- |
| 两个包 | `bot/server/<v>/vonvon-server-<v>-linux-{x64,arm64}.tar.gz` | `upload`，禁止覆盖 | `public, max-age=31536000, immutable` |
| 构建记录 | `bot/server/<v>/vonvon-server-<v>-build.json` | `upload`，禁止覆盖 | 同上 |
| 未签名清单 | `bot/server/<v>/manifest.json` | `upload`，禁止覆盖 | 同上 |
| 安装、卸载脚本 | `bot/server/install.sh`、`bot/server/uninstall.sh` | `promote`，owner 确认后 | `no-cache` |
| 签名 stable 清单 | `bot/server/stable/manifest.json` | `promote` 最后一步 | `no-cache` |

服务端的 stable 不能回退：装好的服务端只接受比当前和见过的最高版本都新的版本，签名清单的 `publishedAt` 也只能往后。发现问题就发一个版本号更高的修复版，不把 stable 指回旧版本。

## 官网交接

```sh
node scripts/release-all.mjs collect --out /absolute/persistent/release-X.Y.Z
```

`release-handoff.json` 从已有公开验证回执收集下载入口及尺寸/哈希，不拼接猜测已发布 URL。新 Windows 候选不再生成 ZIP：两个 Mac DMG 加两个 Windows Setup，共四个用户入口；旧版六入口回执仍可读取。只有两平台同版本、同源码、Windows run 成功且下载来源匹配、Mac 版本化验证通过且 stable 回执为 `published` 时，`readyForWebsite` 才为 `true`；统一计划里有服务端时，还要服务端 stable 回执为 `published` 且属于这份计划。`server` 一项给出 Linux 的安装命令和两个包，不进 `downloads`：官网的下载入口仍是 macOS 和 Windows 安装包。新 Windows 候选另外生成架构独立的签名更新清单，统一计划绑定其字节与旧 stable 快照；owner 确认后，在安装包公网验证完成的基础上提升 `stable/x64/update.json` 与 `stable/arm64/update.json`。两份 feed 均验证后写独立 `windows-update-publish-receipt.json`，官网只有匹配此回执才宣告应用内更新可用。缺少阶段只输出未完成状态；版本、来源或 URL 矛盾直接失败。

官网消费 `downloads` 更新发布配置，再走网站既有测试、部署预演和部署；owner 的完整发布请求已包括官网更新，不重复请求同一部署授权。`evidence` 保存本机证据路径，不能原样复制到公开网站。编排脚本不会自动修改网站或报告部署成功。发布完成后保留 OUT，只用 `git worktree remove` 清理本次状态记录的源码 worktree；临时根按 skill 删除规则处理。

## 验证依据

模拟测试覆盖主线/版本门禁、组织继承 runner 授权、并发初始化与构建、丢失 dispatch 响应、Mac 串行与恢复、取消、Windows 失败和公开回执交接。模拟不代表真实签名、公证、Windows 安装、CI、上传或官网发布已经通过。提速小实验与边界见 [2026-10-30 发布提速验证](research/2026-10-30-release-speed/report.md)。
