# 本地 macOS 分发

macOS 的 Finder 使用 `assets/macos-icon.icns`，运行时 Dock 使用 `assets/macos-icon.png`：圆角以外及画布四周透明，保留原猫咪图案。ICNS 的各尺寸由 macOS 工具生成，避免打包时的小尺寸图标损坏。原 Logo 更新后，在 Mac 上从仓库根运行 `swift scripts/render-macos-icon.swift`，提交重新生成的 PNG 和 ICNS，再构建预览包。

先修改 `packages/daemon/package.json` 的产品版本，执行 `npm run version:sync` 同步 desktop/lock，再在仓库根执行 `npm run build`。协议和 client 的独立 API 版本不随产品发行号改。

正式发布使用仓库内 [release-mac 技能](../../.agents/skills/release-mac/SKILL.md)：准确 main SHA、隔离构建 HOME、App 先公证钉票，再生成最终 ZIP 与 DMG，DMG 单独公证钉票。正式候选和公开上传分阶段；切 stable 只认 owner 本人在自己打开的 Codex App 会话里、看完证据后的确认，规则见技能和 `AGENTS.md`"Mac 发布任务（owner 2026-10-26 定）"。

`npm run package:dir -w packages/desktop` 保持现有单机架构预览。以下 `package:universal` 生成本地未公证的 universal、Apple 芯片和 Intel 包，不用于产出公开发布件：

```sh
VONVON_DESKTOP_SIGNING_TEAM=<已有Developer-ID的10位TeamIdentifier> npm run package:universal -w packages/desktop
```

Electron 语言资源只保留英文（美式、英式）、简体中文和繁体中文，由 `electronLanguages` 在打包时过滤；单机预览和 universal 包共用这份配置。macOS 的 `.lproj` 使用 `en`、`en_GB`、`zh_CN`、`zh_TW`，其他平台的 `.pak` 使用 `en-US`、`en-GB`、`zh-CN`、`zh-TW`，因此分别配置。这个过滤不改变应用自身的中文文案或网页字体。

它按 `electron-builder.yml` 固定的版本分别下载官方 Electron x64 和 arm64，使用 electron-builder 26.15.3 的 universal 合并与合并后签名。只用当前钥匙串已有 Developer ID，不配置公证、不发布、不安装 app。失败会中止，不以 ad-hoc 代替。仅 locale.pak 这类本地化数据不单独签名，仍由 framework 的资源封印覆盖；每个实际 Mach-O 单独验签，按目标分别核对双架构或单架构，app 另做 deep/strict 验证。产物在 `dist/package/`：三种架构各自的 dmg 和更新 zip，以及 `release-<版本>/` 下的签名/架构/哈希 inventory 和发布元数据。发布时 manifest/feed 与 zip 必须放在配置的同一 URL 目录，不能直接照本地子目录布局上传。

公开地址尚未决定时保留 `desktop-update.json` 为 `{}`。签名通过仍不会启用更新；inventory 标记 `awaiting-release-urls`。发布前用外部配置文件（不提交真实身份/地址），包含现有构建支持的 `manifestURL` 和 `teamIdentifier` 两项，通过 `VONVON_DESKTOP_UPDATE_CONFIG=<配置文件绝对路径>` 同时执行 build 与 package。manifestURL 用 HTTPS JSON 文件地址、无凭据/查询/fragment；脚本在相同 URL 目录生成版本 feed 与 zip 下载地址。

生成的 manifest 保留 `{version,feedURL}`，同时提供 `feedURLs.arm64` 与 `feedURLs.x64`。不发布 universal 包，必填的 `feedURL` 指向 arm64 feed，新版按运行架构选择对应 feed；缺少新字段时仍能读取旧版 manifest。旧版 Intel 更新器不支持按架构选择，需要从官网下载对应版本手动升级。feed 为 Squirrel.Mac 默认服务端 `{url,name,notes,pub_date}`，供原生 Electron autoUpdater。zip 是同一签名 app 的更新附件，不能把 `latest-mac.yml` 当此 feed。脚本仅写本地文件；发布者仍须配置 HTTPS 站点、按 inventory 放置对应文件并验证按架构更新。现有检查器只对更高版本调用原生下载，所以版本 feed 可为静态文件；不能把它直接当所有历史客户端的动态“是否有更新”接口。

本地验签不等于公证或 Gatekeeper 放行。release-mac 每次运行 helper 都会提交 Apple 公证，必须 owner 本人点名要求，按技能核验现有钥匙串 profile，不在仓库配置凭据；干净 macOS 用户从零安装、真实飞书和公开下载/更新仍是发布前 s67 等后续验证。

依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[Squirrel.Mac 服务端协议](https://github.com/Squirrel/Squirrel.Mac#server-support)。构建选项以仓库锁定的 electron-builder 26.15.3 本地 schema 为准。

Claude Agent SDK 和原生运行程序不随桌面 App 分发。SDK 只作为开发依赖保留；用户在 Provider 页面主动安装后，固定的验证版本及当前架构运行程序下载到用户托管目录，支持更新、卸载和取消。打开页面、重新检测或启动 App 不触发安装。桌面保留 npm，安装时由 Electron 的 Node 模式执行，用户无需先装 Node。原有托管 SDK 可继续使用；独立 Claude Code CLI 与 SDK 分开管理。

build、electron-builder afterPack（包括单架构预览）与 universal 验证均拒绝 SDK、其平台包和 Claude Code 包进入 daemon 资源树。旧 staging 残留也会导致失败。universal 打包不再下载 Claude 的两个架构包，也没有 thin binary 例外。验证托管安装时，将 App 放在源码树之外，并使用隔离用户目录，避免开发依赖的向上解析掩盖缺失组件。

桌面依赖暂存使用 compact 模式：同一源包只保留一份，其他引用通过包内相对符号链接复用；不同版本和不同源目录保持独立。仅剔除声明文件、source map 与包根测试/示例/文档目录，保留许可证和运行资产。npm CLI 分发保持原有无符号链接的暂存/校验方式。
