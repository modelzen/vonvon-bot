# Windows 安装与启动修复（owner 2026-10-28）

- 目标：修复官网下载 0.7.5 安装后无法启动；EXE 明确命名 Setup，当前用户一键安装。先交 owner 验收，最终只合入 dev，由 Mac 发布。
- 原因：Windows staging 重复嵌套完整依赖树，NSIS 内有 dunder-proto/get.js，但安装后长路径文件缺失，daemon 报 MODULE_NOT_FOUND，桌面显示超时。
- 实现：Windows 改为无链接浅层依赖布局，保护已确定的版本解析，不能保留 peer 共享实例时拒绝打包。macOS compact 布局保留。保留 Electron 及其正常体积，不修改系统安全设置。
- 检查：深层依赖、版本冲突、循环、后续遮蔽和 peer 冲突回归；实际启动 ZIP 与 NSIS 安装后的 daemon，检查认证状态、UI 和正常退出，并检查安装路径预算。独立审查后在本机真实安装和打开欢迎页。
- 验收：交 owner 验收；不创建新的飞书应用、不发消息。本次不对外发布、不合入 main。Mac 后续构建同版本双平台产物并部署官网。
- 文档：docs/windows-release-build.md 记录包数、名称、链接与构建发布步骤；官网同步两个 Windows 下载入口。不写入个人数据或密钥。
