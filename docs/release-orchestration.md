# 双平台发布编排

`scripts/release-all.mjs` 将每次重复的来源检查、Windows 调度、两架构 Mac 公证、聚合、下载和回执交接固定下来。Windows 在云端构建时，本机串行处理 arm64 和 x64；不会再等 Windows 完成后才开始 Mac。它复用现有 helper，不上传 COS、不切 stable、不部署官网，也不安装或启动 App。

首次使用前，本改动必须已经合入 main，所选源码 SHA 也须包含新发布链。该脚本不用于接管之前手工开始的候选。每次选一个新的产品版本和一个 main 完整 SHA；Core/Desktop 版本、Windows 构建、两个 Mac 架构和最终回执都绑定这组输入。main 后续推进不会改变源码。执行本机重命令前，仍须确认没有其他任务或自托管 CI 使用构建、测试和打包环境；本脚本的全局锁只协调本脚本的实例。

## 一个命令准备候选

owner 本轮明确要求构建和公证后，运行：

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

`status` 可在构建期间单独调用：列出准确源码的 CI checks、Windows run 的排队/运行/失败状态及 job/step 耗时，以及每个 App/DMG 的 Apple 状态。构建等待时每 45 秒简报一次。Windows 失败会在下一个本机 helper 边界停止；聚合后也重查，失败以非零退出，不能由另一平台成功掩盖。

本机依赖下载、两个 Mac helper、聚合和 Windows 产物下载各自记录起止时间；Mac helper 另外追加 `mac-*/logs/timings.jsonl`，区分 `source-build`、App 打包、`app-submit`/`dmg-submit` 上传、`app-wait`/`dmg-wait` 等等待和验证。Windows API 保留原来的 install/test/package step 名称和秒数，便于比较下一次的真实瓶颈。进行中的阶段时长未知时写 `null`，不伪造完成耗时。

Windows 另缓存 `%LOCALAPPDATA%\electron\Cache` 和 `%LOCALAPPDATA%\electron-builder\Cache`，路径来自当前锁定的 `@electron/get`、`env-paths` 与 `app-builder-lib/util/electronGet`。只缓存官方 runtime/NSIS 等工具下载，键绑定 runner OS、架构与完整依赖 lockfile；不缓存源码、stage、应用产物或凭据。命中效果仍须用下一次真实 workflow 耗时核验。

`CANCEL` 在下一阶段前生效，不会撤销已经提交的 Apple/GitHub 作业；Ctrl+C 会转发给当前 helper。恢复前先看状态，明确继续时只移除本次 OUT 内的 `CANCEL` 标记。锁文件中记录 PID；遇到遗留锁先核实记录的进程已结束，不绕过活锁。初始化、读取/决定 dispatch 和状态写入使用同一把输出锁，两个会话不能覆盖候选或重复派发。

恢复使用原来的版本、SHA、配置哈希、输出目录和公证 ID。上传结果未知时，仍按 skill 核对 Apple 日志，再按架构传 `--recover-arm64 app=UUID` 或 `--recover-x64 dmg=UUID`；不会自动清空未知提交。完整候选重算哈希后复用。聚合被中断时保留部分目录，下一次使用新的空 `mac-combined-N`，不删除证据。

Windows dispatch 发出前先持久保存请求 UUID；丢失响应后只查询同一个请求，不再次触发工作流。GitHub 尚未返回 run 时，稍后 `resume`。如果确认网络请求根本未到达 GitHub，保留旧 OUT，用新 OUT 重新准备，不手改状态。失败 run 不会自动 rerun；先定位问题，涉及换字节时按现有发布规则使用新版本。

## 版本化上传与 stable 的边界

候选完成后，`status.mac.combined` 指明聚合目录，`status.windows.runId` 指明 Windows 来源。Mac 发布保持原来的 plan → 审阅计划哈希 → 获准 upload → 公网验证流程，调用 `scripts/release-cos-publish.mjs`，详见 [workflow](../.agents/skills/release-mac/references/workflow.md)。脚本不复制上传或公网验证逻辑。把版本化对象、公证 ID、完整 SHA、最终哈希和 URL 展示给 owner 之后，stable 仍只接受 owner 在自己打开的 Codex App 会话中亲自输入的最终确认；不预填确认句，不从队列或其他代理转述生成确认。

Windows 上传同样是 owner 获准的独立阶段；复用已有发布器，并显式核对这次的版本与 SHA：

```sh
node scripts/publish-windows.mjs --run-id RUN_ID \
  --out /absolute/persistent/release-X.Y.Z/windows \
  --sha FULL_40_CHARACTER_MAIN_SHA --version X.Y.Z \
  --cos-config /absolute/external/windows-cos.json
```

新工作流从输入的完整 SHA checkout，并检查 main ancestry 与产品版本。下载器仍要求所属仓库、准确 workflow、成功状态和 artifact 来源；固定输入的 run 另外核对源码 SHA 和 workflow SHA 都在 main，保存两者，重算 inventory 与最终字节。旧的未带输入工作流仍绑定原 run head SHA。

## 官网交接

```sh
node scripts/release-all.mjs collect --out /absolute/persistent/release-X.Y.Z
```

`release-handoff.json` 从已有公开验证回执收集四个下载入口及尺寸/哈希，不拼接猜测已发布 URL。只有两平台同版本、同源码、Windows run 成功且下载来源匹配、Mac 版本化验证通过且 stable 回执为 `published` 时，`readyForWebsite` 才为 `true`。缺少阶段只输出未完成状态；版本、来源或 URL 矛盾直接失败。

官网消费 `downloads` 更新发布配置，再走网站既有测试、部署预演和发布授权。`evidence` 保存本机证据路径，不能原样复制到公开网站。编排脚本不会自动修改网站或报告部署成功。发布完成后保留 OUT，只用 `git worktree remove` 清理本次状态记录的源码 worktree；临时根按 skill 删除规则处理。

## 本次验证

模拟测试覆盖主线/版本门禁、组织继承 runner 授权、并发初始化与构建、丢失 dispatch 响应、Mac 串行与恢复、取消、Windows 失败和公开回执交接。模拟不代表真实签名、公证、Windows 安装、CI、上传或官网发布已经通过。
