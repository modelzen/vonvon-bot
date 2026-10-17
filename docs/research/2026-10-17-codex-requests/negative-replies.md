# Codex 服务端请求的否定回复

2026-10-17，代码基准 `main 07ff9e4`。这次只补核对 s32 的服务端请求回复，不重复 e05 的配置、会话与沙箱实验。未运行真实 provider。

当前仓库的 `protocol/generated/ServerRequest.ts` 及对应 response 类型是实现的结构依据，生成文件不手改：

| 请求 | 否定回复 |
|---|---|
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` | `decision: decline` |
| `execCommandApproval`、`applyPatchApproval` | `decision: denied` |
| `item/permissions/requestApproval` | `permissions: {}`、`scope: turn` |

最后一种的语义是推断：[官方 Permission requests](https://learn.chatgpt.com/docs/app-server#permission-requests) 规定只回复获授的权限子集，`scope` 决定生效时段；本地 `GrantedPermissionProfile` 的字段均可省略，因此空子集不新增权限。不能由此声称真实 Codex 已在拒绝后继续运行；这项仍属于 Mac 检查。

提问回复按本地 `ToolRequestUserInputResponse`，以原问题 id 为键，值是答案文字数组。卡片使用的合成选项 id 需映射回原文，原生键和文字不做规范化；无人回答时返回空答案表，真实处理效果同样待验。没有选项或标成 secret 的问题不放到群卡里，打字回答与敏感问题私聊仍在 s33。

[官方提问说明](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput) 还规定 `serverRequest/resolved` 用于回答及回合清理。该通知不应留下本地等待。当前官方文档提到连接器的副作用审批也可能经提问通道；本地问题 schema 没有可用于识别审批来源的字段，不能按题目文字猜权限语义。本片不把这种连接器行为称作已验收，也不改变 `approvalPolicy: never`。

未实现的方法继续返回 `-32601`。结构匹配、模拟子进程和假渠道测试证明接线；真实二进制的拒绝、后续事件及普通回合仍需独立验证。
