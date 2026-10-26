---
name: release-mac
description: 构建、签名、公证和发布 Vonvon Bot 的 macOS universal 安装包与稳定更新源。用于版本发布、发布彩排、Apple 公证或恢复中断的发布；遵守调用时指定的发布范围。
---

# Vonvon Bot macOS 发布

完成调用者要求的阶段，保留可复核产物。一次调用可覆盖从构建到公开发布；调用者已经明确授权的步骤直接执行。只要求彩排或公证时，不扩展到 COS 上传、公开发布或本机安装。

## 输入与本机配置

- 每次确定 **版本号**、**main 上的准确提交 SHA** 和 **彩排／正式发布**。先刷新远端，解析 SHA 为完整提交，确认它在 `origin/main` 的历史中。固定该 SHA 后，不在本轮自动跟随分支前进。
- 产品版本只支持三段数字；源代码中 `packages/daemon/package.json` 与 `packages/desktop/package.json` 的版本必须都等于输入。不同则停止，交由版本修复 PR 处理，不在打包目录里临时改号。protocol/client 版本独立，不一起改号。
- 稳定清单固定为 `https://dl.vonvon.cc/bot/mac/stable/manifest.json`。正式版本必须严格大于线上清单版本；用数字逐段比较。请求失败、TLS 校验失败或清单无效时，不能认定线上为空，也不能发布。
- 彩排版本不得超过下一次正式版本；先确定下次正式版本。彩排产物标记为本地验证用途，不上传更新源，不作为正式版原样晋级。
- 本机更新配置位于 `~/.vonvon-release/desktop-update.json`，**只含** `manifestURL` 与 `teamIdentifier`。URL 必须等于上述稳定清单地址，团队值从本机现有 Developer ID Application 证书核对。该文件和实际团队值不提交仓库。
- 公证默认使用已存钥匙串配置 `notelet-notary`。先以 `xcrun notarytool history --keychain-profile notelet-notary` 验证可用性；在程序内部处理响应，不打印完整历史。凭据失效时，报告实际错误；不导出或打印密码、私钥。

## 构建和公证

1. 阅读目标提交的 `AGENTS.md` 和发布脚本。用 `T=$(mktemp -d)` 创建本轮临时根，在原 checkout 外建立 detach worktree 到准确 SHA。保留原 checkout 的分支和未提交内容。构建、测试和打包同一时间只占用一个任务。
2. 在该 worktree 执行 `npm ci`。**构建和发布 helper 两条命令都显式带上** `VONVON_DESKTOP_UPDATE_CONFIG`，指向上述外部 JSON；不能只在打包时传。使用真实账号与钥匙串，不设置或导出 `HOME`、`VONVON_HOME`。

   ```sh
   VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" npm run build
   ```

   然后运行 `scripts/release-mac.mjs`，先读 `--help`。`SOURCE_WORKTREE`、`VERSION`、`SOURCE_SHA`、`OUT` 与 `NEXT_VERSION` 从本轮输入绑定；`RELEASE_HELPER` 为该脚本的绝对路径，`OUT` 必须是源码 worktree 外的持久证据目录。彩排命令：

   ```sh
   VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" \
     node "$RELEASE_HELPER" --repo "$SOURCE_WORKTREE" --version "$VERSION" \
     --sha "$SOURCE_SHA" --out "$OUT" --mode rehearsal \
     --next-version "$NEXT_VERSION" --keychain-profile notelet-notary
   ```

   正式包把 `--mode rehearsal --next-version ...` 换为 `--mode release --notes-file "$NOTES_FILE"`，发行说明来自本机 UTF-8 文件。helper 的 release 模式校验线上版本，但仍不执行 COS、CDN 或安装。脚本从外部配置核对证书，无需另设签名团队变量；它要求源目录 tracked 文件干净且 App/Core/stage 版本一致。**不要先运行 `package:universal` 生成装订前容器**。helper 会按下面 3–6 自动完成打包与公证，成功后不再手工重复这些步骤。
3. helper 先只构建并签名 universal App，检查实际字节：App 及内嵌 Mach-O 都是 `arm64` + `x86_64`，正确 Developer ID 团队，严格验签通过，App/Core 与输入版本一致。检查 hardened runtime、entitlements 和未捆绑 Claude SDK/runtime 的约束。若需修打包代码，走单独分支和 PR，不把尚未合入的修复冒称为原 main SHA。现有检查通过后，不无理由重复完整测试。
4. 先将**签名后的 App** 用 `ditto` 压成公证传输 ZIP，提交 Apple；必须收到 `Accepted`，并读取公证日志检查警告。保存 submission ID 和日志，随后对该 App 执行 `xcrun stapler staple` 与 `validate`。
5. **从已装订 App 重新生成最终更新 ZIP 和 DMG**。ZIP 本身不能装订；它应包含已装订的 App。不能继续分发 builder 在 App 装订前生成的 ZIP/DMG。DMG 使用同一 Developer ID 签名，再提交 Apple、等待 `Accepted`、读取日志、装订并验证。
6. 在最终 ZIP 所在目录生成版本化 feed、manifest 和 SHA-256 清单。尺寸和哈希在 App/DMG 最终装订、ZIP 最终重建之后计算。以 helper 的 `release-inventory.json` 与 `SHA256SUMS` 为最终字节证据；不混用其他旧打包目录的 inventory。

目录、工具与源码分离、原生工具顺序和中断恢复见 [references/workflow.md](references/workflow.md)。helper 输出还包含私有传输 ZIP、App、解压验证目录和日志，**不得递归上传整个输出根目录**；上传对象仅取最终 inventory 中的公开产物。

## 验收与公开发布

- App：`codesign --verify --deep --strict`、`spctl -a -vv -t exec`、`xcrun stapler validate`。DMG：独立验签、装订校验、只读挂载并核验其中 App。最终 ZIP 解压后也核验其中 App；不能只检查工作目录原件。
- 用 `lipo -archs` 核验实际内嵌 Mach-O，核对 `Info.plist` 的版本与 build、内置 Core 版本以及最终文件尺寸/SHA-256。把真实 Intel、旧版本完整更新等未测项目如实写明。
- COS 发布前必须已有可用账号、bucket、目标目录和 CDN 配置；先从现有本地配置或部署资料发现，缺少时只问缺失信息。先完成授权范围内的本地公证产物，不为等待存储配置而搁置独立工作。
- 按 [references/workflow.md](references/workflow.md) 上传版本化 ZIP/feed/DMG，拒绝覆盖同名远端对象。确认它们可公开访问且哈希匹配后，**最后更新 manifest**，刷新 CDN 的 manifest URL，再用正常 TLS 的 `curl` 读取公开清单和 ZIP，复核版本和 SHA-256。不能把私有仓库附件链接当作公开下载地址。
- 更新格式沿用现有 Squirrel.Mac：manifest 为 `{version, feedURL}`，feed 为 `{url, name, notes, pub_date}`，manifest/feed/ZIP 均为同源 HTTPS；不要换成 `latest-mac.yml`。更新配置缺失或仍为 `{}` 时不得公开发布。
- 回滚仅把 manifest 恢复为之前的已验证清单，以停止继续推广；已升级客户端不会降级。需要修复时发布更高版本。

## 输出和清理

报告版本、准确源码 SHA、阶段状态、最终各文件路径／尺寸／SHA-256、公证 submission ID 和验收结果；公开发布时还给出可用下载地址及公网复核结果。明确区分本地签名、公证、装订与公开发布。签名工具的原始输出可能带身份或团队信息，只存本机日志，对外输出摘要先脱敏。报告、PR 和文档不得包含真实 Team ID、密码、COS SecretId/SecretKey；用户路径用 `/Users/<u>` 脱敏。

保留发布产物及日志到 worktree 外的持久目录后，再用 `git worktree remove` 清理临时 worktree。临时目录只用 `T=$(mktemp -d)` 创建；递归清理仅可用 `rm -rf -- "${T:?}"` 或本轮刚创建的字面量 `/tmp/...` 路径，不从 home/config 路径推导删除目标。不要 export `HOME`／`VONVON_HOME`，不要使用 home 路径的递归删除或 `find -delete`。默认不替换 `/Applications/Vonvon Bot.app`，不启动、停止或修改用户默认 daemon、bridge 和数据。
