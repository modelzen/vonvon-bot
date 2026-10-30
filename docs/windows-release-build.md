# Windows 构建、安装与更新发布

## 2026-10-30 起的新候选

Windows x64、ARM64 各生成一个当前用户 Setup EXE：`Vonvon-Bot-Setup-<version>-<arch>.exe`。首次简短安装向导允许更改到当前用户可写的目录；更新沿原目录，不再询问安装范围或路径。开始菜单与桌面入口保留。

停止新增 Windows ZIP；历史 ZIP 对象与旧产物清单仍可读取和续跑。macOS 的更新 ZIP 不受影响。官网主要展示 Windows 安装按钮，另一架构收进“其他版本”；无法可靠识别架构时如实标注默认 x64。

Windows EXE 仍无 Authenticode 签名；应用使用内置 Ed25519 公钥验证发布清单与最终 EXE 大小、SHA-512。应用内自动检查，下载和安装分别由用户点击；安装前可选“稍后”，并提示后台连接/任务可能中断。系统安全提示可能每版出现，部分策略可能阻止，不能承诺永久免提示，也不指导关闭安全功能。

## 构建与原生验收

要求 Windows、PowerShell 7、Node.js **24.22.1**。在干净且固定的源码提交上执行：

```powershell
./scripts/build-windows.ps1 -Architecture arm64 -Out C:\dedicated\release-arm64 -SourceSha FULL_SHA -InstallDependencies
```

x64 只改架构与新的独立输出目录。脚本完成构建、类型检查、Windows 定向测试、NSIS 打包、PE/实际运行架构核对、后台运行检查、NSIS 错误恢复回归，以及全新安装/覆盖/卸载重装。CI 分别使用 x64 与 ARM64 原生 runner，Mac/ARM 上的 x64 仿真不能替代 x64 原生证据。构建不带 COS 或更新签名私钥，不公开发布。

`accept-windows.ps1` 使用隔离数据，但会暂存与恢复正式产品的当前用户注册、快捷方式和安装器缓存；只适合无真实产品安装的专用验收用户/CI。不要在 owner 日常 Windows 用户下直接运行它。仅交付开发安装包、完全不碰已安装应用/注册时，增加 `-PackageOnly`；输出带 `DO-NOT-PUBLISH`，不生成发布 inventory 或原生安装通过报告，发布工具无法消费它。

本轮 Windows 虚拟机交互验收按 owner 指示由虚拟机上的 Codex 执行，由 owner 转发固定 SHA 和命令。检查简短路径向导、当前用户范围、真实下载进度、安装/稍后、连续 A→B→C、取消与篡改拒绝、数据保留和新版本重开。专用升级 fixture 使用不同于正式产品的 AppId、名称、缓存和测试密钥；不得把 fixture 的结果当作真实 Bot/daemon/UI 整体验收。

新 format2 `windows-release-inventory.json` 绑定内置 publicKey、源码与版本，每架构只有 installer/blockmap/feed 三种文件，以及对应原生安装报告。YAML feed 留作构建证据；应用实际消费签名 JSON。

## 更新密钥与发布

公钥配置在 `packages/desktop/windows-update.json`，构建可用 `VONVON_WINDOWS_UPDATE_CONFIG` 指向另一个只含 publicKey 的外部配置。私钥不进入应用、仓库、GitHub 构建或 CDN。首次用 `scripts/windows-update-signing.mjs create-key <外部私钥绝对路径> <公钥配置绝对路径>` 生成后，妥善独立备份；不要每次发版重建密钥。

外部 Windows COS 配置除既有字段外，可加绝对路径 `updatePrivateKeyFile`；也可用 `VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE` 覆盖。签名步骤先确认私钥与候选内置公钥匹配。公钥可公开；私钥、凭据明文不要贴入聊天或日志。

正常双平台发布仍使用 `release-all.mjs` / `release-publish.mjs`：

1. 固定经 owner 验收且已进入 main 的完整 SHA；两平台同一新版本。
2. Windows 云端完成构建与原生验收，Mac 下载并验证 artifact 来源、EXE、架构及全部摘要。
3. 版本化安装包与 blockmap 按原不可覆盖约束上传并完整公网复核；`windows-publish-receipt.json` 的 updatesEnabled 仅表示候选具备能力。
4. 本地签名步骤形成每架构 JSON envelope：payload 是 UTF-8 清单的 base64，signature 是 Ed25519 签名。清单绑定产品、版本、架构、固定版本化 EXE URL、大小、SHA-512 和可选纯文本说明。源 key 与目标 key 均受现有计划约束。
5. 统一发布计划固定签名 JSON 字节及旧 stable 快照。owner 审阅并确认准确计划后，安装包先验证，最后提升 `stable/<arch>/update.json`；使用 HTTPS、`application/json`、`Cache-Control: no-cache` 并回读全部字节。并发变更拒绝覆盖；中断续跑同一计划，保留旧快照和阶段回执。
6. 两份 feed 都成功后生成 `windows-update-publish-receipt.json`。官网导入安装包回执及此更新回执；版本、源码、架构或 stable 验证不匹配时，不宣传应用内更新可用。历史手动发行继续如实说明。

单独的 `publish-windows.mjs` CLI 仍只传版本化对象，不切 stable。没有 owner 绑定候选的最终确认，不运行 unified promote。线上已有 0.7.8 在请求更新服务器前就拒绝未签名更新，老用户须手动覆盖安装一次新机制版本，之后才可应用内更新。
