# 本地 macOS 分发

先修改 `packages/daemon/package.json` 的产品版本，执行 `npm run version:sync` 同步 desktop/lock，再在仓库根执行 `npm run build`。协议和 client 的独立 API 版本不随产品发行号改。

`npm run package:dir -w packages/desktop` 保持现有单机架构预览。正式本地包使用：

```sh
VONVON_DESKTOP_SIGNING_TEAM=<已有Developer-ID的10位TeamIdentifier> npm run package:universal -w packages/desktop
```

它从官方 Electron 44.4.5 分别取得 x64/arm64，使用 electron-builder 26.15.3 的 universal 合并与合并后签名。只用当前钥匙串已有 Developer ID，不配置公证、不发布、不安装 app。失败会中止，不以 ad-hoc 代替。仅 locale.pak 这类本地化数据不单独签名，仍由 framework 的资源封印覆盖；每个实际 Mach-O 单独验签、双架构核验，app 另做 deep/strict 验证。产物在 `dist/package/`：universal dmg、更新 zip，以及 `release-<版本>/` 下的签名/架构/哈希 inventory 和发布元数据。发布时 manifest/feed 与 zip 必须放在配置的同一 URL 目录，不能直接照本地子目录布局上传。

公开地址尚未决定时保留 `desktop-update.json` 为 `{}`。签名通过仍不会启用更新；inventory 标记 `awaiting-release-urls`。发布前用外部配置文件（不提交真实身份/地址），包含现有构建支持的 `manifestURL` 和 `teamIdentifier` 两项，通过 `VONVON_DESKTOP_UPDATE_CONFIG=<配置文件绝对路径>` 同时执行 build 与 package。manifestURL 用 HTTPS JSON 文件地址、无凭据/查询/fragment；脚本在相同 URL 目录生成版本 feed 与 zip 下载地址。

生成的 manifest 严格为 `{version,feedURL}`，供 `DesktopUpdater`；feed 为 Squirrel.Mac 默认服务端 `{url,name,notes,pub_date}`，供原生 Electron autoUpdater。zip 是同一签名 app 的更新附件，不能把 `latest-mac.yml` 当此 feed。脚本仅写本地文件；发布者仍须配置 HTTPS 站点、按 inventory 放置对应文件并验证旧版完整更新。现有检查器只对更高版本调用原生下载，所以版本 feed 可为静态文件；不能把它直接当所有历史客户端的动态“是否有更新”接口。

本地验签不等于公证或 Gatekeeper 放行。公证以后由 owner 决定；干净 macOS 用户从零安装、真实飞书和公开下载/更新是发布前 s67 等后续验证。

依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Squirrel.Mac 服务端协议](https://github.com/Squirrel/Squirrel.Mac#server-support)。构建选项以仓库锁定的 electron-builder 26.15.3 本地 schema 为准。
