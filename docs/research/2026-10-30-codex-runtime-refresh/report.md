# Codex 程序复用与模型刷新

基线：2026-10-30 `origin/dev`，`e87a49c4`。owner 明确本轮只实现 Codex，后续由 Claude 参考评估 Claude 部分。

## 核实与实现

- 旧入口固定安装 0.156.1，新入口安装 `@latest`；两类托管副本原来都可能遮挡更新的外部安装。本轮统一安装引擎，并异步比较候选版本。
- 本机 ChatGPT App 的 `Contents/Resources/codex-cli/bin/codex` 可运行，返回 0.165.0-alpha.1.2；终端 CLI 返回 0.165.0。App 内有 CLI 不等于 PATH 已有命令。打包路径不属稳定公开接口，需探测存在性和运行结果。
- 模型目录由执行程序、账号、配置目录与路由共同决定。同 binary / 配置 / 账号才能追求原生 picker 一致；不将不同账号或网关列表拼成“全部可用”，也不把目录条目当成推理权限证明。
- 模型刷新使用独立短命 app-server。任务结束已有空闲释放机制，下轮按原会话 ID 恢复；新程序选择接入 Bot 自身进程，避免只更新 supervisor 缓存。
- utility 按路径和文件指纹识别原地升级，旧请求排空再关闭；已暴露的代际目录保留，避免误删可能正被并发进程使用的文件。

## 代码入口

| 责任 | 代码 |
| --- | --- |
| 程序发现、版本比较及缓存 | `packages/daemon/src/agent/codex-appserver/locate.ts` |
| 旧安装兼容、版本基线与 setup | 同目录 `managed-install.ts`、`version.ts`、`setup.ts` |
| 模型与 start / resume 统一选择 | 同目录 `backend.ts` |
| 托管事务、可信 npm、取消、来源说明 | `packages/daemon/src/environment/service.ts`、`codex-source.ts` |
| utility 排空及指纹 | `packages/daemon/src/agent/codex-appserver/client-pool.ts` |
| 更新与模型刷新 UI | `packages/ui/src/setup/ProviderSetup.tsx`、`useProviderSetup.ts` |

具体契约见 `docs/plans/codex-runtime-refresh.md`。界面当前版本表示下次启动 / 恢复所选程序；在跑旧进程可持续到任务完成。

## 后续给 Claude 的参考

只读审计发现 Claude Provider 通过 Agent SDK 的内置 CLI 执行，环境页单独检测系统 `claude`。当前未传 SDK 的 `pathToClaudeCodeExecutable`；升级系统 CLI 不代表 SDK runtime 更新。SDK 更新目前固定版本、原位安装，进程缓存模块，UI 要求重启后台。不能只照抄路径选择就声称已复用系统 CLI。

可参考来源展示、异步发现、独立模型刷新、失败保留和代际安装。Claude 实施前需核实 SDK / 外部 CLI 兼容、`supportedModels()` 与执行的配置一致、模块如何分代，以及 query / 子代理完成后的切换边界。本轮未修改 Claude 机制。

## 依据与验证边界

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：模型与能力应使用 `model/list` 返回值，目录随客户端和账号而变。
- [Windows App / CLI 部署](https://learn.chatgpt.com/docs/enterprise/windows-deployment)：独立 CLI 用户命令目录为 `%LOCALAPPDATA%/Programs/OpenAI/Codex/bin`；本轮不猜 MSIX 私有目录。
- [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)：列出 `supportedModels()` 和外部 executable 选项，仅作后续线索。

本机 App / CLI 只读验证版本；隔离 fixture 不证明所有账号能用新模型。Windows 路径和专项清单纳入实现，原生运行以 CI / 真机记录为准。两位 gpt-6-sol 代理分别核对 Codex 与 Claude / UI，独立审查指出的候选缓存、迟到取消、utility 指纹采样时机已补修复。

末轮复核补充：旧设置入口和 HTTP 环境入口原先各持实例锁；同时安装或停用时，一方回滚可能覆盖另一成功发布。现按物理 dataRoot / tool 共用互斥，首次创建前从最近存在的父目录规范化路径，处理 macOS `/var` 别名。真实并发回归卡住发布后的校验窗口，确认另一实例的安装、更新、停用均被拒绝；31 项相关检查和独立复核通过。
