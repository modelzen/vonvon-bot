# Windows 应用内更新

Windows NSIS 安装版使用 `electron-updater` 的 generic provider，与 macOS 的 Squirrel 更新清单分开。窗口里的检查、下载、安装并重启及托盘提示继续复用同一套界面。检查不自动下载，退出应用不自动安装；安装前先停止经过验证的 daemon，等待其退出。

## 签名与构建

构建时通过外部路径 `VONVON_WINDOWS_UPDATE_CONFIG` 指定 UTF-8 JSON，仅包含 `publisherName`，值为正式 Windows Authenticode 代码签名证书的名称。配置不含私钥或密码。缺少配置时生成空配置，应用内更新保持不可用。

运行中的 App 必须具有有效 Authenticode 签名，签名名称与打包配置一致，才启用 Windows 更新。下载后及启动安装前，再校验安装包的有效签名和发布者名称；校验命令失败、解析失败、证书不匹配均拒绝安装。不会将未签名候选转换为可自动更新发行包。Apple 的签名身份和公证 profile 不能替代 Windows 证书。

构建机需使用获准的 Windows 签名配置签署 App 与 NSIS 安装包，并从同一最终源码提交生成安装包、ZIP、`.blockmap` 和 `latest.yml`。目前的实现及测试不代表已经完成正式证书签名，也不代表两版本真实升级已经验收。

## 公开对象

固定更新源：`https://dl.vonvon.cc/bot/windows/stable/`。

- 版本化目录 `/bot/windows/<version>/`：最终 `.exe`、它的 `.blockmap`、ZIP，禁止覆盖现有版本。
- 稳定目录 `/bot/windows/stable/latest.yml`：来自同批 electron-builder 产物的更新元数据；`files[].url` 及兼容字段 `path` 指向 `../<version>/<installer>.exe`，保留 builder 计算出的尺寸、SHA-512 和发布时间。
- 版本化对象使用长期 immutable 缓存；`latest.yml` 使用 YAML 内容类型与 no-cache，先完整上传并公网核对版本化对象，再切换该文件。

客户端拒绝跨域文件或 `/bot/windows/` 外部的安装包地址。NSIS updater 校验更新元数据中的文件摘要；本应用另外严格核对 Authenticode。官网下载使用相同版本化 `.exe`、ZIP，并保存最终 SHA-256。

上传可以在有获准 COS 配置的 Windows 或 Mac 执行；构建与真实安装升级验收在 Windows 执行。现有 macOS 发布 helper 和 `bot/mac/stable/manifest.json` 不用于 Windows，发布工具需要单独准备 Windows 对象计划与公网复核。

## 验证范围

定向测试覆盖未签名候选不联网、只检查不下载、两次操作才安装、签名不符拒绝、更新地址约束和上次安装未生效。正式发布前需用两个有效签名的版本测试：旧版检查更新、下载安装、daemon 正常停止、新版重启、Bot 配置及对话数据保留；失败恢复、取消和重复点击也需在实际安装版复核。
