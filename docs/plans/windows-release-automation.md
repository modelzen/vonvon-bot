# Windows 云端构建与 Mac 发布

## 做什么与范围

owner 2026-10-28 要求 Windows 发布不再每次打开虚拟机。GitHub 托管 Windows runner 从准确提交构建 x64 NSIS、ZIP 和更新证据，Mac 使用本机 COS 配置发布官网手动下载。真实 Windows 功能验收仍由 Windows 完成。当前无 Authenticode 身份，因此产物明确未签名，应用内更新不可用。

## 现在的代码与实现

现有 electron-builder 已有 Windows 目标，但只有本机构建，没有专用 Windows workflow。新增手动云端构建工作流、产物校验与 inventory。构建不接触 COS 或 SSH。发布 helper 验证所属仓库、workflow、成功状态和源码 SHA，下载对应 artifact，再重算本地文件哈希，仅写 `bot/windows/<version>/`，禁止覆盖旧字节。公网完整下载、响应头和 SHA-256 核对成功后保存 receipt。未签名流程不写 stable 更新源。官网使用同份 receipt 填入独立 Windows 配置再走现有部署流程。

## 测试与验收

测试错误版本、SHA、PE 架构、摘要、缺失文件、路径越界、错误 workflow、bucket versioning、重传与覆盖保护。实际运行一次 GitHub Windows 构建，从成功 run 取得产物，发布后核对官网及公开下载。Mac 上的单元测试不能替代 Windows 打包或真实安装验收。无需新的飞书消息测试。

## 文档与风险

用法在 `docs/windows-release-build.md`。涉及 CI、产物信任及外部写入，独立审查另外检查凭据输出、目录限制、准确来源、不可覆盖和失败恢复。约 700 行自动化代码及文档；与已合入 dev 的 Windows 产品代码一起发布前检查总 diff 大小。
