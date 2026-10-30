# Windows 连续升级验收

此工具验证独立 NSIS 9.90.1→9.90.2→9.90.3：原路径重开、B→C 丢失自身安装位置记录、旧版本文件移除、外部数据保留和最终清理。完整产品 UI/daemon、差分和系统信任提示另外验收。

## 启动上下文

安装、查询注册表、应用重开和卸载应使用同一普通用户桌面上下文。本轮实测中，同用户的命令工具来源与 Explorer 来源读到了不同的测试注册状态；具体底层机制未确定，不能只凭用户名、架构或令牌级别认定上下文一致。

自动化命令工具开始验收前，应先确认其注册表可见性与普通桌面一致。若不同，使用当前权限允许的正常桌面启动方式运行**整个协调器**，并记录真实父进程链；不要只把某一步换到另一个上下文。不得关闭安全设置、修改系统环境或绕过工具审批。保留先前失败证据。

## 命令

固定包含产品修复的完整工具 SHA，使用干净源码、Node.js 24.22.1 与隔离构建依赖：

```powershell
node --test scripts/windows-installer-compile.test.mjs scripts/windows-upgrade-acceptance.test.mjs
node scripts/windows-upgrade-acceptance.mjs --architecture arm64 --out "E:/acceptance/中文 空格/new-run" --source-sha FULL_TOOL_SHA
```

输出目录必须全新、在源码外。使用实际 ARM64/x64 Electron 核对运行架构；Node 自身可以是仿真架构。工具绑定源码哈希并使用独立 AppId/GUID、密钥和数据。查询异常会失败，只有成功的注册表 API 返回空键才记录不存在；中文值通过 UTF-8 JSON/Base64 保留。

大型临时文件与构建缓存进入输出目录，记录系统盘和输出盘容量。NSIS 仍使用普通用户的独立安装器缓存；磁盘不足时保留现场，不删除其他任务内容。

只有自动验收通过后才按 acceptance-plan.json 的 manualWizard 做安装向导检查。每次手动安装取消完成页的“运行”，只卸载本轮独立测试产品。报告区分自动升级、手动向导及完整产品验证范围，不覆盖原始失败 JSON。
