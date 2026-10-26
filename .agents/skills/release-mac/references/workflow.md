# 发布步骤与恢复

本文补充 `SKILL.md` 中发布 helper 的输入、输出和中断恢复；原生命令供定位失败步骤使用。路径、版本与 SHA 都从本轮输入取得，示例中的变量不能沿用前一轮值。正常运行 `scripts/release-mac.mjs` 完成流程，不重复手工打包。

## 目录和配置

源码使用原 checkout 外的临时 detach worktree。用 `T=$(mktemp -d)` 创建临时根，源码 worktree 和额外临时工作目录都放在其中，不改原 checkout 的分支。helper 的 App、传输 ZIP、验证解压目录及日志均作为持久证据保存到 `--out`，例如 `~/.vonvon-release/releases/<版本>-<短 SHA>/`，不放在会清理的 worktree 内。复用非空输出目录前先核实是同一次发布的恢复；不覆盖旧候选。

更新配置由本机提供，不写进仓库，JSON 的准确结构是：

```json
{
  "manifestURL": "https://dl.vonvon.cc/bot/mac/stable/manifest.json",
  "teamIdentifier": "<从现有签名证书读取>"
}
```

示例占位符不能作为实际团队值。解析该文件后验证键集合、URL 和证书一致性；不用 shell `source` 读取 JSON。确认构建 stage 和最终 App 内的更新配置均与该文件一致。

## helper 调用与输出

源码 worktree 已完成 `npm ci` 和带外部更新配置的 `npm run build` 后，运行：

```sh
VONVON_DESKTOP_UPDATE_CONFIG="$HOME/.vonvon-release/desktop-update.json" \
  node "$RELEASE_HELPER" --repo "$SOURCE_WORKTREE" --version "$VERSION" \
  --sha "$SOURCE_SHA" --out "$OUT" --mode rehearsal \
  --next-version "$NEXT_VERSION" --keychain-profile notelet-notary
```

正式包使用 `--mode release --notes-file "$NOTES_FILE"`，不传彩排的 `--next-version`。`NOTES_FILE` 必须是本机非空 UTF-8 发行说明。先确认当前 helper 的 `--help`，它只构建、公证和验证，不上传 COS、不刷新 CDN、不安装 App。

helper 使用 `--repo` 指向的源码及其依赖。正常发布时 `RELEASE_HELPER` 指向该准确源码 worktree 的 `scripts/release-mac.mjs`；在发布工具 PR 尚未合入、为旧 main 做明确授权的彩排时，可从独立工具 worktree 运行 helper，`--repo` 仍指向不可变的 main 源码，另记录工具提交／本地改动。不能为了引入 helper 而改动被打包源码或把工具 PR 的行为冒称为 main 已有行为。

helper 在 `--out` 中输出最终公开候选：

- `Vonvon-Bot-<版本>-universal.zip`：由已装订 App 生成的更新 ZIP。
- `Vonvon-Bot-<版本>-universal.dmg`：包含已装订 App，自身也签名、公证、装订。
- `feed-<版本>.json`、`manifest.json`：与最终 ZIP 同目录。
- `release-inventory.json`、`SHA256SUMS`：最终字节尺寸、哈希和验证证据。

同一输出根还包含 `mac-universal/`、`app-notary-upload.zip`、`zip-verification/`、`logs/`、公证日志与状态记录，它们属于私有持久证据，**不得递归上传整个输出目录**。COS 上传明确选择 inventory 中的 ZIP/feed/DMG；manifest 在最后单独提升，inventory／校验文件如需公开也须明确选择。保留证据目录，不用删除它们来绕过恢复检查。

helper 先用 electron-builder 的 `dir` 目标生成 universal App；App 装订后再用 `prepackaged` DMG 目标封装同一个 App，跳过重新 doPack。不要先执行旧的 `package:universal` 生成装订前 ZIP/DMG。builder 配置关闭自动公证不代表免公证；helper 负责下面完整的公证顺序。

## 先公证 App，再制作最终容器

变量 `APP` 指向本轮已签名 App 的副本，`TRANSPORT_ZIP` 指向临时传输包，`PROFILE` 默认为 `notelet-notary`。签名和公证命令使用真实 HOME 与本机钥匙串。

```sh
ditto -c -k --sequesterRsrc --keepParent "$APP" "$TRANSPORT_ZIP"
xcrun notarytool submit "$TRANSPORT_ZIP" --keychain-profile "$PROFILE" --output-format json
```

在上传完成并拿到 submission ID 后立即持久保存 ID，随后用 `notarytool info`／`wait` 查询同一个提交；不要因等待超时就重新上传。等待可分段进行，向用户报告有意义的状态变化。

```sh
xcrun notarytool wait "$APP_SUBMISSION_ID" --keychain-profile "$PROFILE" --timeout 10m --output-format json
xcrun notarytool log "$APP_SUBMISSION_ID" --keychain-profile "$PROFILE" "$APP_LOG"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
```

只在 `Accepted` 后装订。`Invalid` 时停下，读取日志定位具体路径；不要重签后复用旧 submission ID。票据尚未传播时可有限重试装订，持续失败则保留 ID／产物并报告，不能跳过校验。

从此 `APP` 才可用于最终容器：

```sh
ditto -c -k --sequesterRsrc --keepParent "$APP" "$FINAL_ZIP"
```

在临时 DMG staging 目录放入这个已装订 App，可加 `/Applications` 链接；再生成压缩 DMG，用已核对的 Developer ID 身份签名。若用 electron-builder 的 DMG 目标，必须核实它以此已装订 App 为输入，且没有重新打包或修改 App。

```sh
hdiutil create -volname "Vonvon Bot" -srcfolder "$DMG_STAGE" -format UDZO "$FINAL_DMG"
codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$FINAL_DMG"
codesign --verify --strict "$FINAL_DMG"
xcrun notarytool submit "$FINAL_DMG" --keychain-profile "$PROFILE" --output-format json
```

同样立即保存 DMG submission ID；查询、下载日志、装订与验证 DMG。绝不对 ZIP 执行 `stapler`。如果 App 在装订后又被重新签名或修改签名覆盖的内容，返回 App 公证阶段，重新生成全部最终容器。

## 最终元数据与验收

最终目录中放置版本化 ZIP、DMG、`feed-<版本>.json` 和候选 `manifest.json`。ZIP 的公开 URL 与 feed、manifest 同源；本地文件名和 URL 中版本相符。feed 使用真实发行说明和 ISO 日期，不能保留空白占位发布说明。先生成最终 ZIP／DMG，再生成 inventory 与哈希，任何后续字节变化都要求重新计算。

helper 复用 `scripts/desktop-release-tools.mjs` 的 `verifyUniversalApp`、`verifyDmg` 和 `artifactRecord`，在全部最终校验后另写最终 metadata，记录 source SHA、两个 submission ID、装订/Gatekeeper 结果和文件哈希。其他打包目录里早先生成的 `local-configured` inventory 不能证明本轮公证完成。

验收至少覆盖以下实际对象：

| 对象 | 检查 |
| --- | --- |
| 最终 App | `codesign --verify --deep --strict`、`spctl -a -vv -t exec`、`xcrun stapler validate`；团队、hardened runtime、entitlements、版本和各 Mach-O 双架构 |
| 最终 ZIP 解压的 App | 同上，确认传输包确实包含已装订 App |
| 最终 DMG | 独立 `codesign --verify --strict`、`xcrun stapler validate`；只读挂载后的 App 按上面检查，随后正常 detach |
| 更新配置与文件 | App 内 manifest URL／团队与外部配置一致，Core/App/build 版本一致，最终 ZIP/DMG 的尺寸与 SHA-256 与 inventory 相符 |

`spctl` 评估不需要启动 App。不要为验收启动默认 daemon 或改用户数据；用户未要求安装时不替换已安装 App。

## COS 发布和撤回

只有正式版本通过版本、源码、公证与验收门槛，而且本轮授权包括公开发布时才执行本节。先确认 COS 账号、bucket、目录、CDN 配置、既有上传工具和权限；未配置就保留本地产物并报告缺项，不臆造存储地址或放宽访问权限。

1. 用正常 TLS 保存线上现有 manifest 作为恢复依据；逐段数字确认候选版本更高。读取失败就停止正式发布。
2. 逐个检查候选版本化 ZIP、feed、DMG 的远端 key。存在即停止，不能 `--force`、`--clobber` 或静默覆盖；无法确定存在性也停止。若在恢复同一次中断发布，先比对既存对象的完整 SHA-256，匹配才可复用，不能覆盖。COS ETag 可能是分段上传值，不能替代完整 SHA-256。
3. 上传 ZIP／DMG 和对应版本化 feed。公开 HTTPS 下载复核文件字节、尺寸和 SHA-256；确认 feed 的 ZIP URL 可访问。不要先改 manifest。
4. 最后写入候选 manifest，刷新 CDN 的**固定 manifest URL**。用 `curl` 正常校验证书，重新读取该固定 URL，核实版本、feedURL、feed 内容和 ZIP 的 SHA-256。不能加随机 query 只测旁路缓存，而遗漏用户真正访问的固定地址；不能使用 `-k`／`--insecure`。
5. 仅在公网复核成功后报告公开发布完成。若 manifest 已切换而公网复核失败，优先按保存的原 manifest 撤回并刷新 CDN，核实原清单恢复；保留失败证据。

撤回 manifest 只停止新客户端继续获得这次更新。客户端版本比较不会降级，已经更新的用户需要更高版本修复。版本化对象保留用于核验和恢复，不用删除安装包处理回滚。

## 中断与清理

恢复前先读 `notarization-state.json`：source SHA、输入版本、配置哈希、mode、原件哈希、submission ID 和阶段状态。核对输入未变后，用同一 helper 命令和同一 `--out` 恢复；已有 submission ID 时先查它，已完成的公证不反复上传。`.release.lock` 存在时先核对记录的进程是否仍在运行，不能绕过活锁。若上传结果未知且没有 ID，先查询该账号近期历史，用文件名、时间与实际候选核对；不能靠文件名相同就认领其他提交。

工作目录变化不改变已记录源码版本；源码或 App 字节变化后建立新的候选记录。保留最终产物和日志到临时 worktree 外，再用 `git worktree remove` 移除自己创建的 worktree。剩余临时根仅可按 `SKILL.md` 的受限清理命令处理；不删除 home 下的发布目录、外部配置或其他会话文件。
