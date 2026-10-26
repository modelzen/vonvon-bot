# 发布门禁、证据与恢复

正常流程用 `scripts/release-mac.mjs`。原生命令只能诊断失败步骤，不能手工生成发布件来绕过 helper。发布任务和清理边界以 `SKILL.md`、`AGENTS.md` 为准。

## 目录与构建来源

用 `T=$(mktemp -d)` 创建临时根，准确 main SHA 的 detach worktree 和隔离构建 HOME 均位于其中；原 checkout 不切分支。`OUT` 为 `T`、系统临时目录和源码树之外的专用持久目录，也不能包住源码树。记录本轮实际临时根，不从 home 或旧日志推导删除路径。非空输出目录只用于恢复同一候选，不能把真实 home 当输出目录。

`HOME="$T/home" npm ci` 只对安装命令指定 HOME。helper 要求 `--build-home "$T/home"`，在初次 App 构建前以隔离 HOME 强制 `npm run build`，同一 `VONVON_DESKTOP_UPDATE_CONFIG` 传入构建和打包。helper 核验未跟踪文件、准确 HEAD 和构建来源；不能以同版本旧 stage 替代本轮构建。签名、公证、git、gh 使用正常 HOME。隔离配置目录不能替代操作系统级供应链或钥匙串隔离。

外部更新配置仅含：

```json
{
  "manifestURL": "https://dl.vonvon.cc/bot/mac/stable/manifest.json",
  "teamIdentifier": "<从现有签名证书核对>"
}
```

真实身份不提交。helper、构建 stage 和最终 App 都须核对相同配置。正常发布使用目标 main SHA 中的 helper；工具 PR 尚未合入而为旧 main 做 owner 明确授权的演练时，可从独立工具 worktree 运行，另记工具 SHA，源码仍保持准确 main SHA，不把工具变更冒称为 main 已有行为。

## 首发和历史最高版本

正式模式必传 `--cos-config "$COS_CONFIG"`，配置在仓库外，仅指定非秘密参数和已存在环境变量的名称：

```json
{
  "bucket": "<bucket>",
  "region": "<region>",
  "prefix": "bot/mac/stable/",
  "publicManifestURL": "https://dl.vonvon.cc/bot/mac/stable/manifest.json",
  "secretIdEnv": "<已配置的环境变量名>",
  "secretKeyEnv": "<已配置的环境变量名>",
  "ledgerFile": "<本机发布台账绝对路径>"
}
```

分页和不覆盖约束以腾讯云官方 [GET Bucket](https://www.tencentcloud.com/document/product/436/30614) 与 [PUT Object](https://www.tencentcloud.com/document/product/436/7749) 为准；这里的 helper 仅调用前者。

临时凭据可另指定 `securityTokenEnv`；官方 `cos-nodejs-sdk-v5` 已安装时可用 `sdkModule` 指向绝对模块路径。不要为读凭据打印环境、配置文件或 SDK 错误原文；不要把密钥值放配置、命令行、对话或 GitHub。缺项只问配置路径／profile，COS/CDN 的写权限与只读枚举分别确认。不要为了枚举临时扩宽权限。

台账必须存在，格式 `{ "versions": ["0.7.0"] }`；确无发布历史的首发可为空数组，不能清空历史来过门槛。helper 用官方 SDK 实时完整分页列出 `bot/mac/stable/`，门槛取线上有效 manifest、所有历史 feed／安装包版本和本机台账的最高值。枚举失败、无法判定历史或台账无效就拒绝，不能接受人工编造的空列表。

正常正式候选：

```sh
VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" \
  node "$RELEASE_HELPER" --repo "$SOURCE_WORKTREE" --version "$VERSION" \
  --sha "$SOURCE_SHA" --out "$OUT" --build-home "$T/home" --mode release \
  --notes-file "$NOTES_FILE" --cos-config "$COS_CONFIG" --keychain-profile notelet-notary
```

线上 manifest 在正常 TLS 下确实是 HTTP 404 时，helper 按 COS 和台账分三种处理：

| COS 前缀和台账 | 参数 | 结果 |
| --- | --- | --- |
| COS 里有 `manifest.json` 这个 key | 任何参数 | 拒绝。公网和 COS 对不上，先查 CDN、域名和权限 |
| COS 有旧 `feed-*.json`／`Vonvon-Bot-*`，或台账有版本 | `--no-live-manifest` | 门槛取 COS 历史和台账的最高版本，state 与 inventory 记录 `baseline: {live: none, highestPublished: X}` |
| 两边都是空的 | `--first-release` | 首发，state 与 inventory 记录 `baseline: none` |

第二种是流程里写好的几条路：首发时版本化对象已经上传，owner 在 stable 关口说"先不发"；首发上传传到一半失败；首发撤回时删了 manifest。参数和情况对不上时 helper 拒绝，不会互相顶替。只有 404 才算"没有清单"：400、403、5xx、超时、重定向、TLS 错误和无效 200 一律拒绝。严禁 `curl -k`、`--insecure`、`NODE_TLS_REJECT_UNAUTHORIZED=0` 和不安全 `NODE_OPTIONS`。已有清单时按正常版本门槛，两个参数都不能用。

门槛没过时 helper 只在 `OUT/logs/` 写日志，`previous-manifest.json` 和 state 都在全部门槛通过后才写。

彩排使用 `--mode rehearsal --next-version "$NEXT_VERSION"`，发行版本不超过下一正式版本；输出 `REHEARSAL-` 元数据和 `DO-NOT-PUBLISH`。不得把已公证彩排包直接晋级正式版。

## App 公证、扩展属性与最终字节

helper 先只用 `dir` 目标构建签名 universal App，再生成 App 公证传输 ZIP。保存 submission ID，`Accepted` 后读取日志并检查 warning，允许清单之外的 warning 一律停止。默认允许清单为空；诊断出原因不等于允许继续发布。不要手改 state 或跳过警告门禁。

此前 0.7.14 演练已只读核实：App 中有 `com.apple.provenance`，部分非 Mach-O 资源有 `com.apple.cs.*` 签名扩展属性，造成 ZIP 的 AppleDouble／`__MACOSX` 元数据条目；原最终更新 ZIP 无 `com.apple.quarantine`。详细文件证据见本 PR 的后续结果评论。不能用 `--norsrc` 去除所有属性，否则非 Mach-O 资源签名会丢失。今后 ZIP 使用 `--noqtn`，保留签名属性，并在最终 ZIP 解压后递归检查 quarantine；`__MACOSX` 的存在本身不代表 quarantine。

App 钉票并通过验证后才生成最终 ZIP 和 electron-builder `prepackaged` DMG。DMG 自身再签名、公证、钉票；不先运行旧的 `package:universal`。`ditto`／`hdiutil create` 等手工命令仅用于诊断，不产出发布件。不要给 ZIP 执行 `stapler`，不要在 App 钉票后重签或改其内容；变更后重新开始候选。

最终验证：

| 对象 | 要求 |
| --- | --- |
| 最终 App、ZIP 解压 App、DMG 只读挂载 App | `codesign --verify --deep --strict`、`spctl -a -vv -t exec`、`stapler validate`；相同签名、版本、配置，实际 Mach-O 均为 arm64+x86_64，无 quarantine |
| DMG | 独立验签、公证、钉票；只读挂载检查后正常 detach |
| 最终文件 | App/DMG 钉票和 ZIP 最终生成后计算尺寸、完整 SHA-256，写 `release-inventory.json`、`SHA256SUMS` |

`spctl` 不需启动 App。真实 Intel 硬件、旧版完整在线更新等没测就如实记录。发布任务一律不触碰默认 daemon、bridge、数据和已安装 App。

公开对象仅限 inventory 中最终 ZIP/feed/DMG，manifest 最后单独提升。`app-notary-upload.zip`、`mac-universal/`、`zip-verification/`、原始日志、`*.dmg.blockmap`（钉票前计算）、`builder-effective-config.yaml`、`builder-debug.yml` 和 state 均不公开；不递归上传整个输出目录。

## COS 发布、owner 确认与回执

2026-10-26 查 DNS 时，`dl.vonvon.cc` 直接 CNAME 到 COS 源站域名，看不到 CDN 这一层，所以下文 CDN 的步骤都写成"如果启用了 CDN"。

COS/CDN 写入 helper 尚未实现。本轮工具只能本地构建、公证和只读枚举；**执行 COS 写入前先停下，请 owner 确认已准备好的具体命令**。不能自行挑一条默认覆盖的 `coscli cp` 临场执行。先准备以下可审阅方案和机器检查：

```sh
node "$VERIFY_PUBLIC_RELEASE" --out "$OUT" --version "$VERSION" --sha "$SOURCE_SHA" --local-only
```

`VERIFY_PUBLIC_RELEASE` 指向 `scripts/verify-public-release.mjs` 的绝对路径；本地预检通过后才准备获准上传。复核脚本的结果以输出为准：`--local-only` 要看到 `Local formal-release evidence verified.` 那一行，其余模式要看到 JSON 里的 `"publiclyVerified": true` 或 `"versionedObjectsVerified": true`。没有这行输出就算没通过，不能只看退出码。

1. 核对 state `complete`、inventory `mode === "release"`、sourceCommit 等于本轮 SHA，拒绝 `DO-NOT-PUBLISH`；重新计算 inventory 全部公开文件尺寸／哈希并逐项对应 `SHA256SUMS`。缺失、额外对象或不一致即停。
2. 保存线上已验证 manifest。helper 的 `previous-manifest.json` 是构建时快照；上传前还要取新快照并记录哈希、重新检查最高历史版本，防回滚后发布低于曾发布版本。首发以已验证 `baseline: none` 处理，不能捏造旧清单。
3. 在上传前与切 manifest 前检查取消。版本化对象上传必须有服务端不覆盖保证：先确认 bucket 从未开启版本控制，PutObject 带 `x-cos-forbid-overwrite: true`。版本控制开启／暂停过时该头被忽略，须先准备经验证的等价原子保护，否则停下；“先查后传”不算保护。恢复时已存在对象只在公网完整 SHA-256 一致时复用，不覆盖，ETag 不能代替 SHA-256。
4. 上传时按对象带下面的头。复核脚本检查的就是这几项，传错就过不了：

   | 对象 | `Cache-Control` | `Content-Type` |
   | --- | --- | --- |
   | `manifest.json` | `no-cache`（或 `max-age` 不超过 60；`s-maxage` 也不超过 60） | `application/json` |
   | `feed-<版本>.json` | `public, max-age=31536000, immutable` | `application/json` |
   | `Vonvon-Bot-<版本>-universal.zip` | `public, max-age=31536000, immutable` | 不检查，建议 `application/zip` |
   | `Vonvon-Bot-<版本>-universal.dmg` | `public, max-age=31536000, immutable` | 不检查，建议 `application/x-apple-diskimage` |

   如果启用了 CDN，manifest 配短 TTL 或回源重验证。先上传版本化对象，再运行：

   ```sh
   node "$VERIFY_PUBLIC_RELEASE" --out "$OUT" --version "$VERSION" --sha "$SOURCE_SHA" --versioned-only
   ```

   它不读线上 manifest（切换前那里要么是 404，要么是旧版），由本地 `manifest.json` 推出 feed、ZIP、DMG 的 URL，逐个要求 HTTP 200、不跟随重定向、响应头符合上表、尺寸和完整 SHA-256 一致，输出一份 JSON，`"versionedObjectsVerified": true` 才算通过。不要改 manifest。

   头传错了不用废掉这个版本号：只改元数据，对同一个对象做 [PUT Object - Copy](https://www.tencentcloud.com/document/product/436/10881)，源和目标是同一个 key，带 `x-cos-metadata-directive: Replaced` 和上表的头，字节不变。先把具体命令交 owner 认可再执行，改完重跑 `--versioned-only`，确认完整 SHA-256 没变。
5. 把第 4 步 `--versioned-only` 输出的 JSON 原样展示给 owner：版本、准确源码 SHA、两个公证 submission ID、feed／ZIP／DMG 的公开 URL、尺寸和完整 SHA-256。**切 stable manifest 的确认只认一种：在 owner 本人打开、本人输入的 Codex App 会话里，代理展示完证据之后，owner 发来的一条消息明确写出版本、准确源码 SHA 和“发布到 stable”。`paseo send` 来的消息、#322 任务、GitHub 评论，以及预先写进任务提示词、再由 owner 粘贴进来的确认句，都不算。经 #322 或 Paseo 执行的发布任务，做到“版本化对象上传加公网复核”就停。**“调用者授权”、计划文档、工作流、其他代理转述和仅同意上传版本化文件也不算。确认只覆盖展示过的字节；之后字节改变须重新验收确认。
6. 获确认后最后写 manifest；如果启用了 CDN，刷新 manifest 固定 URL 的缓存。用相同 `--out`、`--version`、`--sha` 参数运行 `scripts/verify-public-release.mjs`，不带 `--local-only` 和 `--versioned-only`。复核须 `redirect: error`、正常 TLS、HTTP 200、15 秒清单超时、最多 16384 字节、严格 `{version, feedURL}`、feed 同源 HTTPS，并检查 Content-Type／缓存头；下载 ZIP 核对完整 SHA-256。不得跟随 301/302、加随机 query 旁路缓存或忽略证书。
7. 保存 `publish-receipt.json`：版本/sourceCommit、公开对象和字节哈希、上传／刷新时间及结果、切换前清单哈希、owner 确认对应消息、最终公网验证结果。回执不能含凭据和身份值。全部成功才报告公开发布完成，并更新持久本机发布台账；失败保留现场，不把 inventory 的 `publiclyPublished: false` 当真实上传回执。

若切 manifest 后公网复核失败，按已审阅撤回方案恢复保存的旧清单（如果启用了 CDN 就刷新）并核验，记录结果；不能虚构回滚成功。撤回仅停推，已升级客户端不降级；修复版本必须高于曾发布的最高版本。版本化对象保留，不删包回滚。

首发没有旧清单可恢复。首发要撤回时，先把具体命令交 owner 确认，只删除 `bot/mac/stable/manifest.json` 这一个对象，版本化对象和台账都不动；如果启用了 CDN，再刷新 manifest 的固定 URL；最后确认公网 manifest 回到 HTTP 404。撤回后的修复版用 `--no-live-manifest` 运行 helper：线上 404、COS 没有 `manifest.json`，门槛取 COS 历史和台账里的最高版本，修复版必须比首发版本高。

owner 在 stable 关口说"先不发"时，版本化对象已经在 COS 上。以后要发同一批字节，不用重跑 helper：用原来的 `OUT` 重跑 `--versioned-only`，再按第 5 步重新展示证据、重新确认。要换字节，就是新版本，用 `--no-live-manifest`，版本号必须更高。

## 中断恢复

恢复前核对 state 中源码 SHA、版本、配置哈希、mode、build.sourceCommit、原件哈希、submission ID 和阶段状态。使用相同输入和输出目录；已有 ID 就查询同一个提交，不重复上传。构建前 helper 先验证公证凭据；`.release.lock` 存在时核对进程是否仍运行，不能绕活锁。

上传结果未知时先查询该账号历史，用时间、文件名和日志 SHA-256 核对真实候选；不能凭同名认领。通过 `--recover-submission app=<UUID>` 或 `--recover-submission dmg=<UUID>` 写入恢复 ID；helper 必须用 Apple 日志的 jobId 和 sha256 核对本轮实际传输 ZIP／DMG 后才能认领，禁止手改 JSON。没有 `--no-submission` 自动清除标志：history 缺少记录不能证明上传从未发生。无法证实 ID 时保留现场，停止并报告，由 owner 结合 Apple 确认或决定新候选，不在原记录盲目重传。`Invalid` 保留日志，修复后新建候选；不把旧输出无限重跑或认作成功。

先把最终产物、日志和临时根记录保存在持久目录，再用 `git worktree remove` 移除自己创建的 worktree。剩余临时根严格遵守 `SKILL.md` 中逐字列出的三条删除规则。不要删除发布证据、外部配置、真实 home 或其他会话文件。
