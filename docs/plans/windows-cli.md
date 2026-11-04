# Windows vonvon 命令

## 1. 做什么

owner 2026-11-04 要求 Windows 和 Mac、Linux 一样能直接用 `vonvon`。Windows 桌面版首次启动时注册命令，关闭并重新打开终端后可在 PowerShell、CMD 中使用。

## 2. 范围

复用安装包内的 daemon CLI 和 Electron Node 模式，不要求安装系统 Node 或 npm。不增加 Windows 独立服务端安装、登录自启或后台服务。

## 3. 现在的代码

`packages/desktop/src/cli-registration.ts` 只接受 darwin，生成 POSIX 启动器和 shell PATH 块。`main.ts` 已在正式包启动时调用它，也已提供状态观察和修复 IPC。Windows 包已带完整 CLI，缺少的是命令注册。

## 4. 怎么改

- Windows 在打包阶段编译 Console 类型的 `resources/cli/vonvon.exe`，使用和现有 Windows 进程监督器相同的系统 .NET 工具链；运行时不需要编译器。按入口自身位置找到安装包的 Electron 和 `daemon/bin/vonvon.mjs`，支持中文、空格、`&`、`!` 安装目录，不修改终端代码页。
- 用局部 `ELECTRON_RUN_AS_NODE=1` 传递参数、stdin、stdout、stderr 和退出码，不污染调用者环境。
- PowerShell 读取 HKCU Environment 的原始 Path，保留其他条目、可展开变量、注册表值类型和长值，按大小写、目录分隔符及尾斜线去重。只增加当前安装的 CLI 目录，广播环境变更通知。
- 桌面启动时核对入口的构建哈希并注册 PATH，不改写已打包的入口；损坏时提示重装。PATH 注册失败可重开桌面重试，不阻止桌面启动。macOS 保留原流程。
- 已有 Path 为 ExpandString 时，其 `%变量%` 会由系统展开，安装目录不能含字面成对 `%名称%`，应明确报错，保留原 Path。已有 String 的条目和真实目标目录不展开；新建 Path 使用 String。
- 安装器仍管理整个安装目录，卸载会删除启动器。PATH 中可能留下已不存在的安装目录，本次不改卸载器。

## 5. 测试

新增 Windows 注册、重复执行、入口哈希校验和 PATH 写入失败测试（main 必败）。真实 CMD / Windows PowerShell 覆盖中文和特殊字符、空参数、引号、反斜线、输入输出、退出码及局部环境。真实 PowerShell 对隔离注册表键验证长 Path、展开变量、String/ExpandString 类型和去重，不写真实用户 Path。加入 Windows CI 与发布检查的相同测试清单，包运行时 smoke 还通过正式入口查询 daemon。

## 6. Codex 的自测

在 Windows 隔离 worktree 中 npm ci、构建所有包、类型检查及定向测试。数据目录、HOME 和构建产物独立，不启动 owner 的应用或 daemon，不发飞书消息。正式安装包及 owner 的终端验收与源码测试分别记录。

## 7. 文档

更新 product.md 中 Windows 不注册命令的现行限制，保留历史决定，补充使用说明及 v1-plan 实现记录。

## 8. 验收要点

正式 Windows 桌面启动后，重开 PowerShell 和 CMD，`vonvon --version`、`vonvon --help` 和 `vonvon daemon status --json` 可调用；无需系统 Node。参数、流和失败退出码正确，重复注册不截断或扩写 PATH，不改系统 PATH、shell profile 或默认数据。diff 不含真实 id、密钥及本机路径。

## 9. 风险和行数

约 500 行，涉及子进程、注册表和错误路径，需要独立审查及多角度审查。Windows 原生回归在本机执行，macOS/Linux 回归交 PR CI。Windows 受限 PowerShell 策略可能拒绝注册，应保留明确错误状态。
