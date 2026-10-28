# Windows 本地验收候选

## 做什么

按 owner 2026-10-28 的直接要求，在 Windows 本机构建桌面候选并启动，由 owner 完成实际使用和验收，之后再推进官网发布。基于 0.7.3；本任务明确扩展原 v1 不支持 Windows 的范围。

## 范围

提供 x64 可执行程序、NSIS 安装包和 ZIP。复用已有 Bot、Provider 和群组流程。本地候选使用独立数据目录。Windows 登录启动服务与命令行注册尚未纳入本次候选。owner 随后明确要求应用内更新，已加入签名 NSIS 安装版的更新实现，配置及发布约定见 [Windows 更新](../windows-updates.md)；未签名候选不启用更新，真实签名安装升级另验。

## 现在的代码

`packages/desktop/src/daemon-dependencies.ts` 拒绝 Windows；`build.mjs` 的紧凑依赖使用需要额外权限的符号链接；`electron-builder.yml` 只声明 Mac 目标。`OwnedProviderProcess` 使用负 PID 的 POSIX 进程组，Windows 下关闭 Codex 探测进程会一直等待。

## 怎么改

Windows 直接启动随包 daemon，视为没有注册服务，隐藏后台控制台。构建使用普通依赖副本。添加原品牌图标的 ICO、NSIS 和 ZIP 目标。Windows Provider 复用现有 Job Object supervisor，在启动前归属 Job；停止必须确认整个 Job 为空，覆盖父进程先退出的后代。自行结束的非零退出仍报告失败。POSIX 分支保留。

Windows 无法通过 Node 对目录执行 fsync，保留文件写入和发布前的同步，跳过目录同步。凭据读取器识别明确带数据目录的生成脚本，Windows 上的 Electron 读取命令启用 Node 模式；这也兼容已有注册记录。

owner 本地验收反馈 Windows 托盘图标看不清、任务栏图标偏小。Windows 托盘和窗口均显式使用完整彩色 logo 的多尺寸 ICO；移除 Mac Dock 用的外层透明留白，仅保留抗锯齿边缘。Mac 的 PNG、ICNS、18 点模板及 Retina 渲染保持原样。

## 测试

Windows 无服务注册和后台启动参数；真实子进程与孙进程的清理；正常版本探测退出；非预期非零退出。原主线的存活 Windows Provider 清理测试会卡住。运行类型检查和桌面启动、托盘的定向测试。

## Codex 自测

在本台 Windows 的独立数据目录启动实际打包程序，验证 daemon ready 和首屏 Provider 检测。用 computer-use 观察原生窗口。`winwin` 与 `winwin-test` 注册、凭据校验、权限查询和飞书长连接已验证；飞书 CLI 在独立用户目录配置测试 Bot 后，健康检查、群查询、建群、成员和消息读取通过。已读到 owner 在飞书发出的介绍请求及 Bot 的真实回复。owner 于 2026-10-28 明确表示验收完成，要求同步最新 main、改动合入 dev、跳过 CI；main 和正式发布由 owner 后续决定。随后补充的 Job Object 清理修复有真实 Windows 进程测试，尚未包含在 owner 验收的候选安装包内。

## 文档

本计划记录候选范围。验收结果和最终发布支持范围确定后，再更新产品说明、官网和发布记录。

## 验收要点

普通 Windows 账号可以构建并打开；Codex 本机配置和可用模型正常读取；不再等待 POSIX 进程组；安装包与测试程序来自同一批打包文件；diff 不包含真实 id、密钥或本机绝对路径。owner 验收前不报告主流程验收通过或官网发布完成。

## 风险和行数

涉及 Windows 子进程关闭及打包，另加 ICO 二进制资产。Job Object supervisor 冷启动需要数秒，失败或无法确认清理时报告错误。目录 fsync 不可用，因此 Windows 的断电目录持久性保证与 POSIX 有差异。公开发布前从最终 dev 提交重新打包验收；Windows 登录启动服务与终端命令注册仍未实现。应用内更新需要配置 Windows 发布者身份并对应用及安装包进行 Authenticode 签名，真实从旧版安装升级到新版的测试仍待最终产物。
