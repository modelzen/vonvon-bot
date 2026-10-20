# s65 本地 universal 分发实测

2026-10-20，Mac 任务 133。基线 bfc22ccd，产品版本沿现有 Core 源定为 0.7.0（技术发行输入，不代表 owner 已批准公开发布）。Electron 44.4.5、electron-builder 26.15.3；本轮不公证、不上传、不安装 owner app、不运行真实 bot/provider。

## 产物和签名

官方 builder API 显式指定 `Platform.MAC.createTarget(['dmg','zip'], Arch.universal)`，分别取 x64/arm64 Electron，合并后以已有 Developer ID Application 签名。

- app `codesign --verify --deep --strict` 通过，TeamIdentifier 与预期现有身份匹配；hardened runtime 有效。
- 13 个实际 Mach-O 全部含 arm64+x86_64，逐个 strict 验签通过。Core/npm 随 Electron Node mode 运行，不另放单架构 Node。
- app 和四个 helper 的五份实际 XML entitlements 均精确只有 `com.apple.security.cs.allow-jit=true`。用 plist 解析布尔值，拒 false 或任何额外权限。
- dmg 独立 Developer ID 验签通过。只读挂载后，里面的 app 再做上述 13/5 项验证通过，随后正常 detach。
- zip 内 app/Core 版本均 0.7.0；第一方 UNLICENSED，LICENSE.bridge、LICENSE.paseo、NOTICE、PROVENANCE.md 均存在且非空。
- locale.pak 本地化数据不逐文件签名，仍在 framework 资源封印内；没有跳过任何实际 Mach-O 或最终 deep/strict 资源验证。

| 文件 | 大小（字节） | SHA-256 |
|---|---:|---|
| Vonvon-Bot-0.7.0-universal.dmg | 259056833 | 7f762334ebd0f221b22d5bae466f1fd4bbd1a43726da00231b066a242a179718 |
| Vonvon-Bot-0.7.0-universal.zip | 265325487 | 05ffe250d392c8c00b52ca8c8c2af1551da313e1d0814c8068d01cbd24ac0c85 |

两个附件和新旧 metadata 均复制到树外任务证据目录，逐项核 hash 相同。原 app 留在任务构建目录，不复制到 /Applications。源外交付物不会随 worktree 清理消失。

## 启动与首次失败

所有运行均明确给临时 HOME、VONVON_HOME、CODEX_HOME、CLAUDE_CONFIG_DIR 和 userData，只允许受控系统 PATH；CODEX_BIN 指向不存在的测试路径。未复制任何登录/凭据。

- arm64：真实 packaged renderer 加载 app.asar/ui 页面，独立空数据 daemon ready、0 bot；sample 为 ARM64。
- 已有 Rosetta：x86_64 首轮在探针 30 秒窗口内未到 renderer，临时 daemon.log 当时为空，记录为失败。
- 窄诊断：同一签名 Electron Node mode `process.arch=x64` 成功；Core `--version=0.7.0` 成功。随后在全新隔离目录重试，renderer 与空 daemon ready，sample 为 X86-64 (translated)。没有修改产品启动超时、权限或签名来通过。首次失败原因未证实，不把“冷缓存”当结论。
- 实测结束只停止有 PID/临时根归属证据的自有进程；无剩余任务 app/daemon，不触 owner app、默认 daemon 或 bridge。
- 首次打包 API 默认选 host arm64，作者识别后仅停止自己的构建/签名进程（exit143），完整保留首轮日志；加入显式 universal targets 后第二轮完整成功。没有把单架构包当 universal。

## 更新与常规检查

当前 app 更新配置仍为 `{}`，保持不可用；实际签名附件生成的主要 inventory 是 `awaiting-release-urls`。另以 `.test` 域名生成明确标注 NOT-PUBLISHED 的可校验模板：严格 `{version,feedURL}` manifest 和 Squirrel.Mac default `{url,name,notes,pub_date}` feed，关联同一实际 zip。没有调用该地址、部署或启用更新源。

缓存 npm ci、完整 build/typecheck/lint 均通过。初版工具测试 66 项通过；收紧 XML 权限后最终 68 项通过；桌面更新/daemon 生命周期定向五文件 95 项通过；Core distribution/update 两文件 8 项通过。npm tarball 由 clean tree 的正式 pack/check 脚本生成并验证（7281 manifest 文件），实际版本/许可为 0.7.0/UNLICENSED，第三方声明保留；最终 head 与 tarball manifest 的精确对应见任务结果。

公证、Gatekeeper 放行、真实 Intel 设备、公开下载、旧版完整在线更新安装、干净用户从零安装/真实飞书均未冒称完成，保留发布前验收。此文记录作者实测，不替代独立审查。

本机原始日志/附件入口为 `/tmp/vonvon-task133-evidence-root` 指向的任务自建目录：`artifacts/`、`metadata-current/`、`metadata-startup-verifier/`、`metadata-render-fixture/`、`strict-native-verification.json`、`dmg-and-zip-verification.json`、`launch-results.json`、`launch-retry-results.json`、`logs/`。启动时旧 verifier 的 metadata 保留，最终以新 XML/逐 Mach-O 验证证据为准。
