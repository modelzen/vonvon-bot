# Windows 双架构构建与安装验收（owner 2026-10-28）

## 做什么与范围

owner 要求当前 Windows Codex 自己构建、验收，再把同样的流程交给 Mac 通过 GitHub runner 调用。Windows 提供 x64 和 ARM64，保留 ZIP。当前只提交 dev；Mac 负责 main 与正式发布，不在 Windows 上传 COS、修改官网或切 stable。

产品版本准备为 0.7.7，macOS 与 Windows 共用该版本。本次版本号是候选，不代表已发布；若 Mac 开始发布前该号已被使用，须再同步提高版本。

## 现在的代码与改法

- 原 windows-release.yml 仅 x64，构建、安装校验散在 workflow 中。提取到 build-windows.ps1、windows-build-tools.mjs 和 accept-windows.ps1；本机和 runner 调用相同脚本。
- 每次构建固定 clean HEAD、lockfile、Electron 版本与指定 win32 架构；按架构下载官方 Electron，不能沿用宿主机 electronDist。
- NSIS 的 7z 压缩强制兼容解码器的 BCJ，避免锁定版本自动 ARM64 filter 静默漏掉所有 PE；安装后逐个比较 EXE/DLL/node 与未打包目录的哈希。
- 每个架构生成 Setup、ZIP、blockmap、feed、inventory 和实际安装验收报告。保留源码 SHA 与最终 installer SHA-256。
- 实际安装验收使用独立 /D 目录，拒绝碰已有真实安装。临时修改前备份本产品的两条 HKCU 安装记录、快捷方式和安装器缓存；结束时卸载测试 App，恢复原状态。默认数据不用于测试。
- 两个 native runner 分别为 windows-2025、windows-11-arm。汇总任务要求两种架构及同源同版本、各自原生验收成功；Mac 消费同名汇总 artifact 和扩展后的发布清单。

## 测试与自测

- 真实安装包：全新安装、覆盖安装、卸载、卸载后重装、0.7.5 卸载器与 App 均缺失的残留注册记录重装；每次检查打包后台认证状态、UI 服务和清洁关闭。
- 13 项 NSIS fixture 回归保留真实错误拒绝保护。
- ARM64 PE 与实际 process.arch 校验，ZIP / unpacked EXE 必须一致。汇总拒绝不同源码、不同版本、非原生或遗漏安装场景的报告。
- 当前 Windows ARM 机器验收 ARM64 原生、x64 仿真；原生 x64 由 GitHub runner 完成，不混淆报告。
- 本机可用 PauseForUi 在首次真实安装后暂停，使用隔离桌面状态观察初始界面，保留结果后继续卸载重装。
- 不注册飞书应用、不发飞书消息。

## 文档、验收与风险

更新 Windows 构建文档和 v1-plan。保留新版真实运行的本机及 runner 日志；未通过就不能生成可供发布的成功 artifact。

风险集中于安装器对用户安装记录的写入与恢复、两个架构的 runtime 选择、汇总来源校验。先验证脚本，再执行；备份失败或发现已有真实安装时拒绝。由独立模型复查错误路径与数据恢复。

“原样构建”指同一源码、依赖锁和构建验收流程；NSIS 的时间等构建元数据可能改变二进制哈希，每次产物必须重新记录哈希和验收，不承诺逐字节重建。
