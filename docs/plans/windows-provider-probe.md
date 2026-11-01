# Windows Provider 检测超时

## 做什么

修复 Windows 上 Provider 详情能读到模型，群设置却显示 Codex 不可用的问题。owner 要求当前 Codex 修复、自行验证，通过后合入 dev。

## 范围

只调整共享后端检测的 Windows 等待预算，保留安装、登录和权限检测。不改产品版本，不发布。

## 现在的代码

`admin/settings.ts` 读取群模型前调用 `admin/ops.ts` 的 `probeBackends`。它强制执行 doctor，并在 3 秒后把未完成的结果视为不可用。Windows doctor 要启动 Job Object 监管器，读取版本并检查沙箱；版本探测内部预算为 20 秒，沙箱为 15 秒。Provider 详情的 `admin/model-catalog.ts` 直接等待 doctor，没有这个 3 秒门槛。

本机 0.8.0 实测：详情接口约 11.2 秒返回 8 个模型；群模型接口约 3.0 秒返回 unavailable；安装与账号检查均成功。与 2026-10-31 飞书群内反馈的两张截图一致。

## 怎么改

共享检测在 Windows 等待最多 60 秒，覆盖版本与沙箱探测；其他平台仍为 3 秒。每个后端独立超时，异常与超时仍不能通过。沿用原有子进程所有权、清理和并发机制。

## 测试

- Windows 版本读取 4 秒、沙箱检查 6 秒的健康 doctor 能通过；原代码在 3 秒时必败。
- 旧期限后才返回失败的 doctor 仍失败，永不完成的 doctor 到 60 秒仍超时。
- 更新共享常量契约；使用现有 Windows 专项文件，发布检查与 CI 都已包含它。

## Codex 的自测

在隔离 worktree 构建，隔离数据目录运行修复后的 Windows daemon；用本机 Codex 只读检查 Provider 详情和群模型目录，确认均能返回模型。用浏览器检查模型界面，保留证据。不发送飞书消息，不更换 owner 安装的应用。

## 风险

Windows 真正卡住的后端检测最长等待从 3 秒变为 60 秒。失败门槛不变；不把超时当成功。独立审查覆盖超时、错误、并发和清理路径。
