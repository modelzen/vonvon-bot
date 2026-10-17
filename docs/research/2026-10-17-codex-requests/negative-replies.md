# Codex 服务端请求的否定回复

2026-10-17，代码基准 `main 07ff9e4`。首次只补核对 s32 的服务端请求回复，不重复 e05 的配置、会话与沙箱实验；首次结构核对未运行真实 provider，后续 Mac 补验见文末。

当前仓库的 `protocol/generated/ServerRequest.ts` 及对应 response 类型是实现的结构依据，生成文件不手改：

| 请求 | 否定回复 |
|---|---|
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` | `decision: decline` |
| `execCommandApproval`、`applyPatchApproval` | `decision: denied` |
| `item/permissions/requestApproval` | `permissions: {}`、`scope: turn` |

最后一种的语义是推断：[官方 Permission requests](https://learn.chatgpt.com/docs/app-server#permission-requests) 规定只回复获授的权限子集，`scope` 决定生效时段；本地 `GrantedPermissionProfile` 的字段均可省略，因此空子集不新增权限。首次结构核对不能据此声称真实 Codex 已在拒绝后继续运行；文末的后续 Mac 检查补上实际语义。

提问回复按本地 `ToolRequestUserInputResponse`，以原问题 id 为键，值是答案文字数组。卡片使用的合成选项 id 需映射回原文，原生键和文字不做规范化；无人回答时返回空答案表，真实处理效果同样待验。没有选项或标成 secret 的问题不放到群卡里，打字回答与敏感问题私聊仍在 s33。

[官方提问说明](https://learn.chatgpt.com/docs/app-server#toolrequestuserinput) 还规定 `serverRequest/resolved` 用于回答及回合清理。该通知不应留下本地等待。当前官方文档提到连接器的副作用审批也可能经提问通道；本地问题 schema 没有可用于识别审批来源的字段，不能按题目文字猜权限语义。本片不把这种连接器行为称作已验收，也不改变 `approvalPolicy: never`。

未实现的方法继续返回 `-32601`。结构匹配、模拟子进程和假渠道测试证明接线；真实二进制的拒绝、后续事件及普通回合另由下述 Mac 检查验证。


2026-10-17 后续真实 Mac 补验：任务 30 在最终源码 `be7bf0e6fa590c6a74aadcce79c69d8ecd1447be`，用现有 ChatGPT 订阅、Codex CLI 0.162.1，在新隔离目录运行原 backend/transport/handler。普通产品回合完成且入站 method+id 请求为零；独立 on-request/readOnly probe 真实触发命令审批，原 handler 回 decline，item declined、原轮和后续轮均完成；独立权限 probe 真实触发非空 fileSystem 请求，空 turn 回复后 binary 自己的 request_permissions 工具结果为 network/file_system 均 null，原轮及续轮完成，未增权。权限工具开关只在 probe 中打开，产品 never 未改。完整命令、透明观察及限制见 [任务30结果](https://github.com/modelzen/vonvon-bot/pull/377#issuecomment-6232964899)。

真实问答答案、连接器提问来源、其他审批种类并未因此验收。首次新 CODEX_HOME 中预热 child 的 SQLite 初始化 code1 仍未归因，同次主回合成功、唯一重试两 child 正常；不隐去首次失败。EOF 修复另经真实 Node fixture、透明事件顺序和 Mac 十文件210项验证，不用这些 fixture 代替上述真实 binary 语义。
