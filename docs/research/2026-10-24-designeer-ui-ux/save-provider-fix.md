# 模型保存与 Claude Provider 检测修复

2026-10-24。owner 在最终 App 验收时报告：模型保存及“保存并离开”都显示“实时模型目录暂不可用”；已经可用的 Claude 没出现在 Provider 选择里。

## 根因

- daemon 的 models() 对实时读取成功也恒返回 fallback，群模型页只接受 ready。底层实际读到模型，却被界面阻止保存。
- Claude 安装状态与登录状态分离；快照初始及缓存过期时 authentication 为 unknown，群设置过滤该状态，但只在设置向导或诊断页自动登录探测，导致已可用的 Claude 被静默隐藏。
- 紧凑模型 / Effort 选择器允许 fallback 和 loading 时编辑，却在保存校验阶段拒绝，产生无法保存的草稿；目录读取也缺少同 Provider 重试。

## 修复

- 实时 probe 成功且 native peekModels 确认目录后返回 ready；静态兜底、磁盘缓存与显式离线保持 fallback。兜底不覆盖已确认目录文件。
- 保存始终通过 models() 重新确认状态；仅 ready 允许新增模型、强度或切换 Provider。目录降级时仅允许保留或收缩已保存选择，保留模型与强度合法性、版本冲突及权限校验。
- 非 ready 目录仅可查看已保存模型 / 强度；增加“重新读取模型”，恢复后不清页面草稿。Provider 切换仍可选择独立可用的其他后端。
- 群设置自动对已安装、兼容且登录状态未知的 Claude 使用既有 SDK backendLogin 检测；使用真实返回状态、显示结果并支持强制重新检查。检测慢时，已可用的 Codex 仍可操作；不把 unknown 推断为已登录。
- 不改用户登录、API Key、头像、权限配置或实际执行流程。

## 验证

- UI 全量 53 文件、460 项通过；UI typecheck、工作区完整构建通过。
- daemon 定向设置、模型与决策测试通过；最后 owner / group 回归 78 项通过，daemon typecheck 通过。
- 回归覆盖实时 / 静态 / 离线目录、保留缓存、目录失效下的保存拒绝、同 Provider 重试保留草稿、保存并离开、Claude 未检测到已登录、探测失败重试、TTL 失效、并发请求复用，以及慢探测不阻止 Codex。
- 真实 App 的目录、Claude 检测与保存结果在重新编译后单独记录，不用演示客户端代替。
