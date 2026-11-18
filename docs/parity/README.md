# 桌面版功能覆盖测试用例

以原 feishu-codex-bridge CLI、飞书管理卡片、本地 Web 控制台和参考旧 Vonvon 桌面的本地管理能力为基线。升级目标是接续 feishu-codex-bridge 的同一份数据，本地不要求产品账号。编号保留不同入口的测试变体，不代表同等数量的独立功能。

共 113 条用例。每条分别在 macOS 和 Windows 验证。

源码位置用于确认基线和查找实现，不代表整条用例通过。定位说明可以是代码符号或附近行为的描述。完成操作步骤、核对预期并保存证据后，才能记录平台测试结果。

本页只含可公开的测试规格。运行 `node scripts/parity-report.mjs --check` 检查它是否与 cases.json 同步。执行记录另行保存在本机忽略目录，用 `--results <观察文件> --checks <分项文件> --output <本地报告路径>` 生成；执行结果不会进入本页。

## 基线

- core。v0.6.14; current 21ed17cab64df7c1b481c56d63ea6aa51fc212ad
- desktop。aab1bb34442d6723016cfbdc3217159108b4348f
- legacy。3a168535c11a4f403553967908d272127e6a23af

## 覆盖表

| 编号 | 功能或设置 | 验证方式 |
| --- | --- | --- |
| [CLI-001](#cli-001) | 新用户无需终端或产品账号即可启动桌面 Host | 桌面实际操作 |
| [CLI-002](#cli-002) | 接续旧版后台服务并保持单份数据 | 桌面实际操作 |
| [CLI-003](#cli-003) | 离线升级迁移目录并建立兼容链接 | 桌面实际操作 |
| [CLI-004](#cli-004) | 数据迁移冲突提示与恢复重试 | 桌面实际操作 |
| [CLI-005](#cli-005) | 使用二维码或完整链接注册首个及后续 Agent | 外部服务验证 |
| [CLI-006](#cli-006) | 取消或过期注册不残留半成品数据 | 集成测试 |
| [CLI-007](#cli-007) | 启停多个 Agent 后保持准确的运行集合 | 桌面实际操作 |
| [CLI-008](#cli-008) | 移除已停止 Agent 只删除该 Agent 的本地数据 | 桌面实际操作 |
| [CLI-009](#cli-009) | 阻止删除仍启用或运行中的 Agent | 集成测试 |
| [CLI-010](#cli-010) | 安装启动及停止卸载后台服务 | 桌面实际操作 |
| [CLI-011](#cli-011) | 重启桌面启动或接续的 Host 并恢复连接 | 桌面实际操作 |
| [CLI-012](#cli-012) | 临时只运行指定 Agent 而不修改默认运行集合 | 桌面实际操作 |
| [CLI-013](#cli-013) | 区分桌面开机启动与旧版系统服务 | 桌面实际操作 |
| [CLI-014](#cli-014) | 查看进程、服务归属、退出状态和日志路径 | 桌面实际操作 |
| [CLI-015](#cli-015) | 查看最近日志并实时跟随新日志 | 桌面实际操作 |
| [CLI-016](#cli-016) | 诊断工具、授权、配置和飞书事件权限 | 集成测试 |
| [CLI-017](#cli-017) | 分别判断 Codex 安装与授权并显示正确操作 | 桌面实际操作 |
| [CLI-018](#cli-018) | 无需终端完成 Codex 安装和授权 | 桌面实际操作 |
| [CLI-019](#cli-019) | 查看并安装、更新、卸载可管理的执行工具 | 桌面实际操作 |
| [CLI-020](#cli-020) | 选择 Codex 可执行文件并恢复自动检测 | 桌面实际操作 |
| [CLI-021](#cli-021) | 只检查 Bridge 新版本而不安装 | 集成测试 |
| [CLI-022](#cli-022) | 执行升级并验证实际桌面与 Core 版本 | 桌面实际操作 |
| [CLI-023](#cli-023) | 无需终端访问完整本地管理功能 | 桌面实际操作 |
| [CARD-001](#card-001) | 新建飞书群并创建项目 | 外部服务验证 |
| [CARD-002](#card-002) | 绑定已有飞书群 | 外部服务验证 |
| [CARD-003](#card-003) | 项目目录真实存在且不改已有绑定 | 集成测试 |
| [CARD-004](#card-004) | 项目后端与单会话或多话题类型 | 外部服务验证 |
| [CARD-005](#card-005) | 项目列表与群内 Agent 视图 | 桌面实际操作 |
| [CARD-006](#card-006) | 项目话题列表 | 集成测试 |
| [CARD-007](#card-007) | 删除或解绑项目 | 外部服务验证 |
| [CARD-008](#card-008) | 原创建群删除时转让群主 | 外部服务验证 |
| [CARD-009](#card-009) | 加入群后提醒绑定 | 外部服务验证 |
| [CARD-010](#card-010) | 群里无需 @ 的响应开关 | 外部服务验证 |
| [CARD-011](#card-011) | 自动压缩上下文 | 集成测试 |
| [CARD-012](#card-012) | 管理员权限档位 | 外部服务验证 |
| [CARD-013](#card-013) | 普通成员权限档位 | 外部服务验证 |
| [CARD-014](#card-014) | 联网许可 | 外部服务验证 |
| [CARD-015](#card-015) | 新会话默认模型和推理强度 | 外部服务验证 |
| [CARD-016](#card-016) | 已下架或跨后端模型拒绝 | 集成测试 |
| [CARD-017](#card-017) | 项目响应成员添加删除与允许所有人 | 外部服务验证 |
| [CARD-018](#card-018) | 管理员列表增删 | 集成测试 |
| [CARD-019](#card-019) | 允许群名单 | 外部服务验证 |
| [CARD-020](#card-020) | 工具调用显示 | 外部服务验证 |
| [CARD-021](#card-021) | 模型显示 off/running/always | 外部服务验证 |
| [CARD-022](#card-022) | 并发任务上限 1 到 50 | 集成测试 |
| [CARD-023](#card-023) | 空闲超时 0 或 10 到 3600 秒 | 集成测试 |
| [CARD-024](#card-024) | 运行中消息 steer 或 queue | 外部服务验证 |
| [CARD-025](#card-025) | 任务结束提醒四档 | 外部服务验证 |
| [CARD-026](#card-026) | 长任务阈值 1 到 1440 分钟 | 集成测试 |
| [CARD-027](#card-027) | 语音转文字启停及诊断 | 外部服务验证 |
| [CARD-028](#card-028) | CLI 桥接启停与 Hook 修复 | 桌面实际操作 |
| [CARD-029](#card-029) | CLI 通知范围 | 外部服务验证 |
| [CARD-030](#card-030) | CLI Claude 和 Codex 事件过滤 | 外部服务验证 |
| [CARD-031](#card-031) | CLI 离开保活 | 桌面实际操作 |
| [CARD-032](#card-032) | CLI 审批与超时 | 外部服务验证 |
| [CARD-033](#card-033) | CLI 完成卡与回复续聊 | 外部服务验证 |
| [CARD-034](#card-034) | CLI 会话放行缓存 | 外部服务验证 |
| [CARD-035](#card-035) | CLI 在场检测 | 桌面实际操作 |
| [CARD-036](#card-036) | 云文档评论执行后端模型强度 | 外部服务验证 |
| [CARD-037](#card-037) | 云文档评论回复规则编辑重置 | 外部服务验证 |
| [CARD-038](#card-038) | 新会话标题按后端配置 | 集成测试 |
| [CARD-039](#card-039) | 新项目默认根目录 | 集成测试 |
| [CARD-040](#card-040) | 会话模型与推理强度覆盖 | 外部服务验证 |
| [CARD-041](#card-041) | 多话题首条消息创建话题 | 外部服务验证 |
| [CARD-042](#card-042) | 单会话群连续对话 | 外部服务验证 |
| [CARD-043](#card-043) | 恢复历史会话 | 外部服务验证 |
| [CARD-044](#card-044) | 清空当前单群会话 | 外部服务验证 |
| [CARD-045](#card-045) | 手动压缩上下文 | 外部服务验证 |
| [CARD-046](#card-046) | 查看上下文用量 | 外部服务验证 |
| [CARD-047](#card-047) | 自治目标启动与结束 | 外部服务验证 |
| [CARD-048](#card-048) | 终止运行任务 | 外部服务验证 |
| [CARD-049](#card-049) | 单次完成提醒请求 | 外部服务验证 |
| [CARD-050](#card-050) | 文件、图片、引用、语音输入 | 外部服务验证 |
| [CARD-051](#card-051) | 文件与图片输出 | 外部服务验证 |
| [CARD-052](#card-052) | 云文档评论任务执行 | 外部服务验证 |
| [CARD-053](#card-053) | 飞书 DM 重连与诊断 | 桌面实际操作 |
| [CARD-054](#card-054) | 飞书 DM 原地更新与进度 | 桌面实际操作 |
| [CARD-055](#card-055) | Codex 用量查询、刷新与分享 | 外部服务验证 |
| [CARD-056](#card-056) | 非管理员不能修改设置和删除绑定 | 外部服务验证 |
| [CARD-057](#card-057) | 卡片与桌面交叉编辑同一配置 | 集成测试 |
| [CARD-058](#card-058) | 停止或离线 Agent 只读 | 桌面实际操作 |
| [DATA-001](#data-001) | 诊断页显示当前接续 Host 的实际数据目录 | 桌面实际操作 |
| [LEGACY-001](#legacy-001) | 识别已安装且已授权的 Codex 与 Claude | 桌面实际操作 |
| [LEGACY-002](#legacy-002) | 安装缺失的 Codex | 桌面实际操作 |
| [LEGACY-003](#legacy-003) | 安装缺失的 Claude Code 与飞书 CLI | 桌面实际操作 |
| [LEGACY-004](#legacy-004) | 更新 Codex、Claude Code 和飞书 CLI | 桌面实际操作 |
| [LEGACY-005](#legacy-005) | 取消正在安装或更新的工具 | 桌面实际操作 |
| [LEGACY-006](#legacy-006) | Codex 官方账号授权及取消 | 桌面实际操作 |
| [LEGACY-007](#legacy-007) | Claude Code 和飞书 CLI 登录及重验 | 桌面实际操作 |
| [LEGACY-008](#legacy-008) | 列出并切换 Profile | 桌面实际操作 |
| [LEGACY-009](#legacy-009) | 新增已有应用 Profile 并安全保存凭据 | 桌面实际操作 |
| [LEGACY-010](#legacy-010) | 通过扫码新建应用 Profile | 外部服务验证 |
| [LEGACY-011](#legacy-011) | 扫码注册机器人并使用完整链接 | 外部服务验证 |
| [LEGACY-012](#legacy-012) | 复用已存在的飞书应用并刷新凭据 | 外部服务验证 |
| [LEGACY-013](#legacy-013) | 启用、停用与权限检查/修复入口 | 集成测试 |
| [LEGACY-014](#legacy-014) | 配置机器人任务卡显示、并发、超时、待处理策略和提醒 | 集成测试 |
| [LEGACY-015](#legacy-015) | 配置标题精炼与评论生成的执行模型 | 集成测试 |
| [LEGACY-016](#legacy-016) | 永久管理员与额外管理员管理 | 集成测试 |
| [LEGACY-017](#legacy-017) | 创建项目群或绑定已有群，选择目录与会话模式 | 外部服务验证 |
| [LEGACY-018](#legacy-018) | 编辑项目目录、会话模式、启用状态 | 集成测试 |
| [LEGACY-019](#legacy-019) | 配置权限、成员、免 @、网络、压缩、待处理和模型 | 集成测试 |
| [LEGACY-020](#legacy-020) | 删除项目后保留工作目录并清除绑定 | 桌面实际操作 |
| [LEGACY-021](#legacy-021) | 查看、搜索、筛选并跳转历史会话 | 桌面实际操作 |
| [LEGACY-022](#legacy-022) | 从桌面打开绑定的飞书项目群 | 桌面实际操作 |
| [LEGACY-023](#legacy-023) | 设置新项目默认根目录并恢复默认 | 桌面实际操作 |
| [LEGACY-024](#legacy-024) | 配置 CLI 活动通知、范围、工具和唤醒 | 集成测试 |
| [LEGACY-025](#legacy-025) | 检查并修复 Claude/Codex hooks | 桌面实际操作 |
| [LEGACY-026](#legacy-026) | 控制 Bridge 服务启动、停止、接管及登录自启 | 桌面实际操作 |
| [LEGACY-027](#legacy-027) | 检查并安装桌面软件更新 | 桌面实际操作 |
| [LEGACY-028](#legacy-028) | 查看 Bridge、机器人、项目、工具和 CLI 数据诊断 | 桌面实际操作 |
| [LEGACY-029](#legacy-029) | 搜索设置、机器人与项目，并保护未保存修改 | 桌面实际操作 |
| [LEGACY-030](#legacy-030) | 重启桌面后继续读取原本 Bridge 数据 | 桌面实际操作 |
| [LEGACY-031](#legacy-031) | 本地移除并重新添加同一 Agent | 外部服务验证 |

## CLI-001

新用户无需终端或产品账号即可启动桌面 Host

类别。installation

**前置条件**

1. Isolated empty user home; packaged macOS/Windows app

**操作步骤**

1. Launch app through OS shell
2. Wait for local Host and open Agent page

**预期结果**

1. Host reports connected/owned and core version 0.7.0
2. Add Agent is reachable without a product account or terminal

**恢复步骤**

1. Quit app and remove isolated home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:44](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L44)。run
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/daemon.ts:17](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/daemon.ts#L17)。runStart

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/host.ts:13](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/host.ts#L13)。acquireHost
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/index.ts:149](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/index.ts#L149)。bundled runtime


## CLI-002

接续旧版后台服务并保持单份数据

类别。installation

**前置条件**

1. Isolated legacy .feishu-codex-bridge directory; live service with two Agents

**操作步骤**

1. Record service PID and file hashes
2. Launch app
3. Read Agent list
4. Quit app

**预期结果**

1. Ownership is attached, both Agents appear
2. Legacy PID remains running after quit
3. File hashes remain unchanged

**恢复步骤**

1. Stop fixture service and remove fixture home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/config/data-root.ts:48](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/config/data-root.ts#L48)。resolveDataRoot

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/host.ts:13](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/host.ts#L13)。acquireHost
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:437](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L437)。refresh


## CLI-003

离线升级迁移目录并建立兼容链接

类别。data

**前置条件**

1. Isolated old physical directory with registry, secret and session fixtures; no Host running

**操作步骤**

1. Hash fixture files
2. Launch app and await migration
3. Write one harmless setting using desktop
4. Read it via both old and new paths

**预期结果**

1. Physical .vonvon-bridge contains the original files
2. Old path resolves to the same directory through symlink or Windows junction
3. Hashes and secret values remain intact
4. There is no second divergent copy

**恢复步骤**

1. Quit app; remove isolated home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/config/data-root-migration.ts:112](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/config/data-root-migration.ts#L112)。relocateOfflineDataRoot
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:29](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L29)。data migrate

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/host.ts:17](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/host.ts#L17)。migrateHostDataOffline


## CLI-004

数据迁移冲突提示与恢复重试

类别。data

**前置条件**

1. Isolated home with distinct physical old/new stores and explicit backup

**操作步骤**

1. Launch app
2. Inspect blocked message
3. Resolve fixture conflict
4. Use in-app retry/recover control

**预期结果**

1. Neither store is silently overwritten
2. Desktop names both paths and offers a recover/retry route
3. After resolution, app reconnects without terminal

**恢复步骤**

1. Remove isolated home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/config/data-root.ts:57](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/config/data-root.ts#L57)。conflicting stores
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:29](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L29)。data retry

**桌面源码核对位置**

- [desktop@c374a4a:desktop/main/controller.ts:103](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/main/controller.ts#L103)。class DesktopController


## CLI-005

使用二维码或完整链接注册首个及后续 Agent

类别。agents

**前置条件**

1. Isolated Host; test Feishu application or authorized target

**操作步骤**

1. Click Add Agent
2. Verify QR and complete link both point to the same registration
3. Open link and finish authorization
4. Repeat for a second Agent

**预期结果**

1. Both distinct appIds appear once in registry and UI
2. Each has an encrypted secret and separate state directory
3. Both are enabled and connect after restart

**恢复步骤**

1. Delete disposable test Agents and their local fixture data

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/bot.ts:10](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/bot.ts#L10)。runBotInit
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/admin/service.ts:753](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/admin/service.ts#L753)。registerBotByQr

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:878](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L878)。register
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:1193](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L1193)。registration link


## CLI-006

取消或过期注册不残留半成品数据

类别。agents

**前置条件**

1. Isolated Host with one existing Agent

**操作步骤**

1. Start registration and cancel
2. Start another registration and simulate QR expiry

**预期结果**

1. No new registry row, credential or bot directory is left
2. Existing Agent remains enabled and connected
3. A new registration can be started

**恢复步骤**

1. Remove isolated home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:362](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L362)。DELETE register-qr

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:1183](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L1183)。cancel
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:1189](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L1189)。expired QR


## CLI-007

启停多个 Agent 后保持准确的运行集合

类别。agents

**前置条件**

1. Three fixture Agents A, B, C active and connected

**操作步骤**

1. Disable B
2. Restart Host
3. Quit and relaunch app
4. Enable B and disable C
5. Restart again

**预期结果**

1. Persisted active set is A+C, then A+B
2. Disabled Agent process stops; enabled Agent connects
3. No unrelated Agent settings change

**恢复步骤**

1. Remove fixture home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/bot.ts:47](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/bot.ts#L47)。runBotUse
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/bot.ts:91](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/bot.ts#L91)。setActiveBots

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:701](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L701)。setAgentEnabled
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:551](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L551)。Agent toggle


## CLI-008

移除已停止 Agent 只删除该 Agent 的本地数据

类别。agents

**前置条件**

1. Two fixture Agents; target B disabled and disconnected

**操作步骤**

1. Capture A directory/secret hash
2. Confirm Remove B in desktop
3. Refresh list

**预期结果**

1. B registry, encrypted secret and state directory removed
2. A hashes unchanged and A remains connected
3. Feishu developer application is not deleted

**恢复步骤**

1. Remove fixture home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/bot.ts:104](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/bot.ts#L104)。runBotRm

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:708](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L708)。deleteAgent
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:615](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L615)。Remove Agent


## CLI-009

阻止删除仍启用或运行中的 Agent

类别。agents

**前置条件**

1. One running fixture Agent

**操作步骤**

1. Attempt delete through controller and visible UI

**预期结果**

1. Action unavailable or refused
2. Registry, secret and session directory remain byte-identical

**恢复步骤**

1. Remove fixture home after Host stopped

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/admin/service.ts:941](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/admin/service.ts#L941)。deleteBot

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:734](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L734)。agent-active
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:629](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L629)。Remove disabled


## CLI-010

安装启动及停止卸载后台服务

类别。service

**前置条件**

1. Isolated home and no user service; macOS launchd or Windows login service fixture

**操作步骤**

1. Use desktop to install/start service
2. Quit and relaunch app to attach
3. Use desktop to stop/uninstall service

**预期结果**

1. Service registered and running without terminal
2. Desktop attaches after relaunch
3. Stop removes service definition and leaves Agent data intact

**恢复步骤**

1. Uninstall fixture service

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/daemon.ts:17](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/daemon.ts#L17)。runStart
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:62](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L62)。stop
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:275](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L275)。daemon start/stop

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/MachinePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/MachinePanel.tsx#L6)。function MachinePanel


## CLI-011

重启桌面启动或接续的 Host 并恢复连接

类别。service

**前置条件**

1. Fixture Host running with two connected Agents

**操作步骤**

1. Change one non-secret setting
2. Click Restart
3. Wait for new PID and reconnect
4. Repeat in owned mode

**预期结果**

1. New Host process loads saved setting
2. Both Agents reconnect
3. No detached duplicate service remains

**恢复步骤**

1. Restore fixture setting and stop Host

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:66](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L66)。restart
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:260](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L260)。daemon restart

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:566](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L566)。restartAttached
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:861](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L861)。Restart Bridge


## CLI-012

临时只运行指定 Agent 而不修改默认运行集合

类别。service

**前置条件**

1. Two active fixture Agents

**操作步骤**

1. Select only Agent B for a temporary desktop-run session
2. Inspect running bot processes
3. End session

**预期结果**

1. Only B starts temporarily
2. Persisted active set remains A+B
3. Ending temporary run leaves neither process orphaned

**恢复步骤**

1. Stop fixture Host

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:41](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L41)。run --bot
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/host/bootstrap.ts:8](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/host/bootstrap.ts#L8)。runHostRuntime

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/MachinePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/MachinePanel.tsx#L6)。function MachinePanel


## CLI-013

区分桌面开机启动与旧版系统服务

类别。service

**前置条件**

1. Packaged app; isolated service state

**操作步骤**

1. Toggle desktop login item on/off
2. Inspect OS login item and legacy service definition separately

**预期结果**

1. Toggle controls only desktop app launch
2. UI states whether legacy service is installed/running
3. No second Host starts when both are enabled

**恢复步骤**

1. Restore original OS login item state

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/daemon.ts:17](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/daemon.ts#L17)。service install

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/MachinePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/MachinePanel.tsx#L6)。function MachinePanel


## CLI-014

查看进程、服务归属、退出状态和日志路径

类别。service

**前置条件**

1. Running fixture daemon with known PID and log path

**操作步骤**

1. Open Status and diagnostics
2. Compare visible fields with CLI status

**预期结果**

1. Installed/running, ownership, PID, service path, last exit and stdout/stderr paths are visible
2. Unmanaged foreground process is not called an installed service

**恢复步骤**

1. Stop fixture Host

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/daemon.ts:102](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/daemon.ts#L102)。printStatus
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:73](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L73)。status

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/MachinePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/MachinePanel.tsx#L6)。function MachinePanel


## CLI-015

查看最近日志并实时跟随新日志

类别。diagnostics

**前置条件**

1. Fixture Host writes two log lines after desktop opens

**操作步骤**

1. Open log view
2. Verify initial tail
3. Append a third line
4. Toggle follow and disconnect Host

**预期结果**

1. Tail and new line appear in order with bounded memory
2. Disconnect/reconnect is visible
3. Secret-like fixture text is redacted where Core contract requires it

**恢复步骤**

1. Remove fixture logs

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:89](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L89)。logs --follow
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:498](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L498)。logs and logs/stream

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/LogPanel.tsx:3](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/LogPanel.tsx#L3)。function LogPanel


## CLI-016

诊断工具、授权、配置和飞书事件权限

类别。diagnostics

**前置条件**

1. Fixture matrix: missing Codex, signed out, no lark-cli, missing config, missing required event

**操作步骤**

1. Run desktop refresh and per-Agent check for each fixture state

**预期结果**

1. Each failed check has a distinct actionable line
2. Warnings are distinguished from failures
3. Event settings link targets the selected Feishu/Lark tenant
4. Successful fixture clears previous warning

**恢复步骤**

1. Remove fixture home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/doctor.ts:27](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/doctor.ts#L27)。runDoctor
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:348](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L348)。host-doctor

**桌面源码核对位置**

- [desktop@c374a4a:desktop/main/controller.ts:103](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/main/controller.ts#L103)。class DesktopController


## CLI-017

分别判断 Codex 安装与授权并显示正确操作

类别。tools

**前置条件**

1. Fixtures for installed/signed in, installed/signed out and missing Codex

**操作步骤**

1. Open Local environment for each state

**预期结果**

1. Installed tool never offers install
2. Signed-in tool never offers login
3. Missing tool offers install and signed-out installed tool offers login

**恢复步骤**

1. Remove fixtures

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/doctor.ts:30](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/doctor.ts#L30)。Codex probe/login
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:219](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L219)。Codex setup

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:463](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L463)。Codex setup refresh
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:786](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L786)。Codex actions


## CLI-018

无需终端完成 Codex 安装和授权

类别。tools

**前置条件**

1. Fresh isolated packaged app with no Codex installation; test account/device authorization

**操作步骤**

1. Click Install and wait for success
2. Click Login and use official authorization URL
3. Refresh state

**预期结果**

1. Installation becomes installed and version appears
2. Login becomes signedIn
3. Cancel and failure states remain actionable

**恢复步骤**

1. Remove isolated tool installation or restore fixture

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:224](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L224)。Codex install/login jobs

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:776](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L776)。startTool
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:798](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L798)。Install Codex


## CLI-019

查看并安装、更新、卸载可管理的执行工具

类别。tools

**前置条件**

1. Isolated user package directory; one installable backend missing and one already installed

**操作步骤**

1. Open backend manager
2. Install missing backend
3. Check available version
4. Update installed backend
5. Uninstall disposable backend

**预期结果**

1. Catalog labels installable versus external CLI
2. Progress, installed/latest versions and errors appear
3. Only user-managed backend is removed
4. A running backend is protected or safely restarted

**恢复步骤**

1. Restore fixture package directory

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:511](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L511)。backend catalog/install/update/version/uninstall
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/admin/service.ts:798](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/admin/service.ts#L798)。listBackendCatalog

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## CLI-020

选择 Codex 可执行文件并恢复自动检测

类别。tools

**前置条件**

1. Isolated home and two test executables

**操作步骤**

1. Choose executable through OS picker
2. Save setting
3. Restart Host
4. Reset to auto-detect

**预期结果**

1. Chosen executable path persists and is the running one after restart
2. Arbitrary renderer-supplied raw path is refused
3. Reset removes override without changing unrelated settings

**恢复步骤**

1. Remove fixture home

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/doctor.ts:38](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/doctor.ts#L38)。CODEX_BIN

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1873](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1873)。Host execution
- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/index.ts:109](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/index.ts#L109)。chooseExecutable


## CLI-021

只检查 Bridge 新版本而不安装

类别。updates

**前置条件**

1. Controlled update metadata: current 0.7.0, latest 0.7.1; offline result also available

**操作步骤**

1. Open app update page
2. Check now
3. Repeat with registry unavailable

**预期结果**

1. Current/latest and update availability are accurate
2. No package is installed by check
3. Offline state is explicit rather than falsely latest

**恢复步骤**

1. Restore update stub

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/update.ts:17](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/update.ts#L17)。runUpdate check
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:321](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L321)。update check

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/UpdatePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/UpdatePanel.tsx#L6)。function UpdatePanel


## CLI-022

执行升级并验证实际桌面与 Core 版本

类别。updates

**前置条件**

1. Disposable packaged version 0.7.0; controlled 0.7.1 installer

**操作步骤**

1. Accept offered update
2. Watch progress
3. Relaunch app
4. Inspect both app and Core versions

**预期结果**

1. Update progress and failure are visible
2. App and bundled Core both report intended compatible versions
3. Agent data and active service remain usable
4. A global CLI upgrade alone is never shown as a desktop upgrade

**恢复步骤**

1. Restore disposable installation

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/commands/update.ts:45](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/commands/update.ts#L45)。installLatest
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:326](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L326)。update status/apply

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/UpdatePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/UpdatePanel.tsx#L6)。function UpdatePanel


## CLI-023

无需终端访问完整本地管理功能

类别。web

**前置条件**

1. Existing local Host and disabled network

**操作步骤**

1. 从桌面依次定位日志查看、执行工具管理和 Bridge 更新入口。
2. 逐一对照 CLI-015、CLI-019、CLI-021 的入口，无需终端命令。

**预期结果**

1. 三项能力均有桌面内可发现的入口。其完整行为由对应的独立用例记录，不能只凭外链或摘要算作通过。

**恢复步骤**

1. Close console

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:99](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L99)。web
- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/web/server.ts:254](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/web/server.ts#L254)。console APIs

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/App.tsx:79](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/App.tsx#L79)。function App


## CARD-001

新建飞书群并创建项目

类别。项目

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 桌面选择 Agent，寻找新建群入口并输入项目名、会话类型、后端、目录。

**预期结果**

1. 飞书产生新群；projects.json 新增 origin=created、chatId、cwd、kind、backend；桌面显示群。

**恢复步骤**

1. 删除测试项目并处理新建群。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2884](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2884)。DM.newProjectSubmit

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## CARD-002

绑定已有飞书群

类别。项目

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 选择未绑定群、真实目录、项目名、会话类型、后端并提交。

**预期结果**

1. projects.json 写入 origin=joined；相同绑定重试不重复；群详情显示目录。

**恢复步骤**

1. 仅删除本次测试绑定。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2921](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2921)。DM.joinGroupSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:969](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L969)。加入飞书群


## CARD-003

项目目录真实存在且不改已有绑定

类别。项目

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在绑定已有群入口提交不存在的目录或普通文件。
2. 在同一绑定入口再次提交已经绑定的群和另一个目录，不走项目编辑入口。

**预期结果**

1. 两种非法绑定均拒绝，projects.json 与原会话保持不变。

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2921](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2921)。DM.joinGroupSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:1039](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L1039)。目录选择器


## CARD-004

项目后端与单会话或多话题类型

类别。项目

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 绑定两个隔离群，分别选择单会话与多话题、Codex 与可用 Claude。

**预期结果**

1. 每个项目保存所选 kind/backend；后端在创建后不可切换。

**恢复步骤**

1. 移除测试绑定。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2884](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2884)。DM.newProjectSubmit

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## CARD-005

项目列表与群内 Agent 视图

类别。项目

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 打开 Agent 和群聊列表，进入同一个绑定详情后返回。

**预期结果**

1. 两个视图指向同一绑定，不出现重复项目；返回保持列表视图。

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2964](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2964)。DM.projects

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:400](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L400)。Agent 和群视图


## CARD-006

项目话题列表

类别。项目

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 给群创建两个话题，进入项目话题列表并刷新。

**预期结果**

1. 列表只显示该 chatId 的 session，展示标题和对应管理员或普通成员会话。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3728](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3728)。DM.projectTopics

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-007

删除或解绑项目

类别。项目

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在桌面项目详情删除一个 origin=joined 的测试项目。

**预期结果**

1. projects.json 删除对应项目；代码目录保留；机器人退出原群或明确提示退出失败；其他项目无变化。

**恢复步骤**

1. 需要时重新绑定测试群。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3202](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3202)。DM.rmDo

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## CARD-008

原创建群删除时转让群主

类别。项目

**前置条件**

1. 隔离的 origin=created 群由机器人创建。

**操作步骤**

1. 在桌面删除该项目。

**预期结果**

1. 项目解绑，代码目录保留，群主转给操作者；飞书群仍在且用户可自行解散。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3202](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3202)。DM.rmDo

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## CARD-009

加入群后提醒绑定

类别。项目

**前置条件**

1. 机器人由用户加入未绑定群。

**操作步骤**

1. 在群触发绑定提示，再到桌面选择该群绑定。

**预期结果**

1. 桌面能发现该群并绑定，不要求先在飞书卡片填写。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2921](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2921)。DM.joinGroupSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:969](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L969)。加入飞书群


## CARD-010

群里无需 @ 的响应开关

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在多话题测试群开启免 @，分别向群主区和已有话题发送普通消息。
2. 从桌面关闭免 @ 并保存，再在已有话题发送未 @ 的消息；随后发送 @ 机器人的正向对照。
3. 恢复原值，读取 projects.json。整群连续会话变体通过隔离项目执行。

**预期结果**

1. 多话题模式仅已有话题和支持的命令免 @；主区普通闲聊仍不会新建任务。
2. 关闭后未 @ 消息不进入任务，@ 机器人仍可用；single 模式开启时整群免 @。
3. 保存只作用于目标项目，其他群不变。界面说明与两种模式相符。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3554](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3554)。GS.setNoMention

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1483](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1483)。不 @ 也能发起任务


## CARD-011

自动压缩上下文

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 桌面关闭再开启并保存，分别新开会话。

**预期结果**

1. projects.json autoCompact 保存；现有 LIVE 线程被重绑，下次启动应用新值。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3567](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3567)。GS.setAutoCompact

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1553](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1553)。自动压缩上下文


## CARD-012

管理员权限档位

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 依次选择 qa、write、full 并保存，用管理员发受限任务。

**预期结果**

1. projects.json mode 正确保存；会话按新沙箱重绑；禁止档不能写文件。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3774](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3774)。DM.permissionSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1501](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1501)。管理员权限


## CARD-013

普通成员权限档位

类别。项目设置

**前置条件**

1. 测试群有普通成员。

**操作步骤**

1. 选择 qa、write、full 并保存，由普通成员发任务。

**预期结果**

1. projects.json guestMode 保存；普通成员使用对应隔离会话与沙箱。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3774](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3774)。DM.permissionSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1517](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1517)。普通成员权限


## CARD-014

联网许可

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在 qa 或 write 档切换 network，并发出需联网的任务。

**预期结果**

1. projects.json network 保存；下一轮沙箱按许可变化，full 档结果按后端规则。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3774](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3774)。DM.permissionSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1533](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1533)。允许网络访问


## CARD-015

新会话默认模型和推理强度

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 选择当前后端可用模型及支持的 effort，保存后新建话题。

**预期结果**

1. projects.json defaultModel/defaultEffort 保存；仅新会话采用新值，旧会话不变。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3805](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3805)。DM.modelDefaultSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1577](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1577)。新会话默认模型


## CARD-016

已下架或跨后端模型拒绝

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 用过期模型 ID 或另一后端模型提交。

**预期结果**

1. 拒绝写入，原模型与强度保留，界面提示具体字段。

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3805](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3805)。DM.modelDefaultSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1577](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1577)。新会话默认模型


## CARD-017

项目响应成员添加删除与允许所有人

类别。项目设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 添加普通成员 Open ID，删除，再设允许所有成员。

**预期结果**

1. projects.json allowedUsers 去重；空列表代表全体；owner/admin 始终可用。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3674](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3674)。DM.allowlist

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1593](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1593)。响应成员


## CARD-018

管理员列表增删

类别。项目设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 添加测试管理员 Open ID，再删除；尝试移除 owner。

**预期结果**

1. config.json admins 正确保存；owner 保留且始终有权限。

**恢复步骤**

1. 移除测试管理员。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3639](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3639)。DM.addAdminSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1274](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1274)。管理员


## CARD-019

允许群名单

类别。项目设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 将测试群设为唯一允许群，另一个群发消息。

**预期结果**

1. config.json allowedChats 保存；非允许群不响应，空列表恢复全群。

**恢复步骤**

1. 清空测试限制。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:941](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L941)。isChatAllowed

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1362](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1362)。允许的飞书群


## CARD-020

工具调用显示

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 关闭与开启工具调用显示，各执行含工具任务。

**预期结果**

1. config.json showToolCalls 保存；后续运行卡按值隐藏或显示调用。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3249](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3249)。DM.setTools

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:535](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L535)。任务卡片


## CARD-021

模型显示 off/running/always

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 逐档保存并执行任务。

**预期结果**

1. config.json showModel 为所选枚举；运行和终态卡显示时机符合枚举。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3252](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3252)。DM.setShowModel

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:535](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L535)。任务卡片


## CARD-022

并发任务上限 1 到 50

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 保存 1 与 50，尝试 0、51、非整数；重启并并发发任务。

**预期结果**

1. 合法值持久化，非法值拒绝；重启后的信号量使用新上限。

**恢复步骤**

1. 恢复原值并重启。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3342](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3342)。DM.setConcurrency

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:567](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L567)。最大并发任务


## CARD-023

空闲超时 0 或 10 到 3600 秒

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 保存 0、10、3600，尝试 9、3601 和非整数。

**预期结果**

1. config.json 存合法值；非法值拒绝；下一轮 watchdog 使用新值。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3257](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3257)。DM.setWatchdog

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:597](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L597)。空闲超时


## CARD-024

运行中消息 steer 或 queue

类别。Agent 设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 运行长任务时依次用 steer 与 queue 发送新消息。

**预期结果**

1. config.json pendingPolicy 保存；steer 进入当前任务，queue 排队到任务后。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3339](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3339)。DM.setPending

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:612](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L612)。待处理消息策略


## CARD-025

任务结束提醒四档

类别。Agent 设置

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 依次保存 manual、long、failures、always 并完成对应任务。

**预期结果**

1. config.json completionReminder.mode 保存；提醒仅在对应条件出现。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3279](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3279)。DM.setCompletionReminder

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:630](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L630)。任务结束提醒


## CARD-026

长任务阈值 1 到 1440 分钟

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 保存边界值并尝试 0、1441、非整数。

**预期结果**

1. 合法阈值保存，非法值拒绝；长任务提醒按新阈值。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3303](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3303)。DM.completionReminderCustomSubmit numeric validation

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:653](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L653)。长任务阈值


## CARD-027

语音转文字启停及诊断

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 启用、测试、刷新权限、禁用；发语音消息。

**预期结果**

1. config.json voice.enabled 变化；权限诊断显示状态；启用时语音进入任务，禁用后不转写。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/voice-console.ts:69](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/voice-console.ts#L69)。DM.setVoice

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:670](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L670)。语音转文字


## CARD-028

CLI 桥接启停与 Hook 修复

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 启用 CLI 桥接，检测并修复 Hook，禁用。

**预期结果**

1. config.json cliBridge.enabled 保存；服务和 Hook 状态与界面一致；修复警告可见。

**恢复步骤**

1. 恢复原值及测试 Hook。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2979](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2979)。CLI.toggleEnabled

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:740](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L740)。CLI 协作


## CARD-029

CLI 通知范围

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 选择 all、bound_projects、none，触发 CLI Hook。

**预期结果**

1. config.json notifyScope 保存；飞书转发范围符合档位。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3008](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3008)。CLI.setNotifyScope

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:809](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L809)。通知范围


## CARD-030

CLI Claude 和 Codex 事件过滤

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 分别关闭 Claude 和 Codex 转发并触发对应 Hook。

**预期结果**

1. config.json agents.claude/codex 保存；只转发启用后端事件。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3019](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3019)。CLI.toggleAgent

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:824](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L824)。转发 Claude


## CARD-031

CLI 离开保活

类别。Agent 设置

**前置条件**

1. macOS 隔离测试环境有 CLI 桥接。

**操作步骤**

1. 切换 keepAwake 并模拟离开。

**预期结果**

1. config.json keepAwake.enabled 保存；仅 macOS 启用 caffeinate。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3032](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3032)。CLI.toggleKeepAwake

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:853](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L853)。离开时保活


## CARD-032

CLI 审批与超时

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 先关闭再开启审批转发；审批超时设为 1 秒和 86400 秒；输入 0 与 86401 验证拒绝；触发一次测试审批。

**预期结果**

1. config.json 两字段保存；飞书审批按开关和时限发生。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/config/schema.ts:485](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/config/schema.ts#L485)。timeoutSeconds: secondsOr

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:880](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L880)。转发权限审批


## CARD-033

CLI 完成卡与回复续聊

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 先关闭再开启任务完成卡和完成卡回复；续聊超时设为 1 秒和 86400 秒；输入 0 与 86401 验证拒绝；完成任务并回复卡片。

**预期结果**

1. config.json 三字段保存；完成卡出现与否、回复是否续聊和超时符合配置。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/config/schema.ts:490](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/config/schema.ts#L490)。replyTimeoutSeconds: secondsOr

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:919](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L919)。发送任务完成卡


## CARD-034

CLI 会话放行缓存

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 切换 allowCache.enabled，触发同一会话重复审批。

**预期结果**

1. config.json 保存；缓存仅本会话有效。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/config/schema.ts:493](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/config/schema.ts#L493)。enabled: boolOr(raw?.allowCache?.enabled

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:976](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L976)。本会话放行缓存


## CARD-035

CLI 在场检测

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 先关闭再开启在场检测；平台分别选 auto 与 macos；离开阈值设为 10 秒和 3600 秒；输入 9 与 3601 验证拒绝；模拟活动和离开。

**预期结果**

1. config.json 三字段保存；转发根据检测平台和阈值变化。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/config/schema.ts:499](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/config/schema.ts#L499)。idleThresholdSeconds: secondsOr

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:992](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L992)。在场检测


## CARD-036

云文档评论执行后端模型强度

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 选择可用后端、模型、强度并在文档评论中 @bot。

**预期结果**

1. config.json comments 写入；下一条评论用所选后端模型，不改变群任务默认值。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3404](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3404)。DM.commentSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1060](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1060)。云文档评论


## CARD-037

云文档评论回复规则编辑重置

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 保存带占位符的非空规则，触发评论，随后重置。

**预期结果**

1. comment-instructions.md 写入并同步已有评论目录；重置回内置规则；空文本拒绝。

**恢复步骤**

1. 恢复原规则。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3469](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3469)。DM.commentPromptSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1099](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1099)。评论回复规则


## CARD-038

新会话标题按后端配置

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. Codex 与 Claude 分别关闭标题生成，再分别选可用模型 ID 和 medium 强度启用；创建新会话并检查一个旧会话标题。

**预期结果**

1. config.json sessionTitles.byBackend 独立保存；新会话标题策略生效，旧标题不回填。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3361](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3361)。DM.sessionTitleSubmit

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1169](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1169)。新会话标题


## CARD-039

新项目默认根目录

类别。Agent 设置

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 将新项目根目录设为隔离的绝对路径，再从桌面创建 QA-root-check 空白项目。

**预期结果**

1. config.json projectsRootDir 保存；新项目使用该根目录，现有项目不搬迁。

**恢复步骤**

1. 恢复原值并删除测试项目。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2884](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2884)。DM.newProjectSubmit

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## CARD-040

会话模型与推理强度覆盖

类别。会话

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 选择一个已有 Codex 话题，选可用 Codex 模型及 medium 强度，保存并发下一轮；重启后回读。

**预期结果**

1. sessions.json 记录新值；下一轮生效；重启后仍保留；跨后端型号拒绝。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2266](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2266)。MC.model

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-041

多话题首条消息创建话题

类别。会话

**前置条件**

1. 多话题测试群已绑定。

**操作步骤**

1. 在群主区 @bot 发送任务并查看桌面话题列表。

**预期结果**

1. 飞书创建新话题，sessions.json 绑定 threadId/cwd，桌面显示话题。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:1741](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L1741)。startTopicDirectly

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-042

单会话群连续对话

类别。会话

**前置条件**

1. 单会话测试群已绑定。

**操作步骤**

1. 连续发送两条相关消息，在桌面检查会话。

**预期结果**

1. 第二条沿用同一 sessionId 与项目目录。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:1266](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L1266)。handleTurn

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-043

恢复历史会话

类别。会话

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 从桌面群详情打开历史会话。
2. 选择标记为 QA-history-A 的已有会话，点击恢复。
3. 在飞书发下一条测试消息，再核对桌面会话和持久化 sessionId。

**预期结果**

1. 恢复从桌面发起。多话题模式关联新话题，单群模式切换当前会话。
2. 下一条消息使用选中的历史 sessionId；其他群会话不变。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2299](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2299)。RES.pick

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-044

清空当前单群会话

类别。会话

**前置条件**

1. 单会话群有历史会话。

**操作步骤**

1. 在桌面打开已存在连续会话的测试群。
2. 执行清空当前会话并确认。
3. 在飞书发送下一条消息，再从历史列表定位旧会话。

**预期结果**

1. 下一条消息创建不同的 sessionId。旧会话仍可恢复，项目目录与其他群不变。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2066](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2066)。runClear

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-045

手动压缩上下文

类别。会话

**前置条件**

1. 测试会话空闲且后端支持 compact。

**操作步骤**

1. 在桌面选择空闲且支持压缩的测试会话，记录上下文占用。
2. 执行手动压缩并等待完成。
3. 发送下一条测试消息。

**预期结果**

1. 压缩动作由桌面发起并显示完成或明确失败。
2. 成功后沿用同一 sessionId，可以继续协作；运行中不允许冲突压缩。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:1950](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L1950)。runCompact

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-046

查看上下文用量

类别。会话

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在桌面选择有至少两轮历史的测试会话。
2. 打开上下文用量并刷新。
3. 切换另一会话并再次查看。

**预期结果**

1. 展示选中会话的上下文占用和可用容量，不串到另一个会话。
2. 后端不支持时明确显示不可用，不用零值冒充成功。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:1927](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L1927)。postContextCard

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-047

自治目标启动与结束

类别。会话

**前置条件**

1. Codex 后端支持目标，测试目录可写。

**操作步骤**

1. 在桌面选中测试会话并设置目标“读取 fixture README，写入 goal-result.txt 后结束”。
2. 启动目标并观察状态。
3. 在第二个受控长任务中从桌面停止目标。

**预期结果**

1. 目标由桌面发起并驱动对应会话执行。
2. 完成或停止状态正确，不继续自动推进，不影响别的会话。

**恢复步骤**

1. 结束测试目标。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:4759](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L4759)。launchGoalRun

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-048

终止运行任务

类别。运行卡

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 在测试会话启动可控的等待任务。
2. 从桌面选中该任务并点击终止。
3. 检查执行进程状态和结果卡，随后再发一个正常任务。

**预期结果**

1. 目标任务停止并显示已终止。其他任务继续。
2. 下一次协作正常，不残留占用槽位。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2383](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2383)。RC.stop

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-049

单次完成提醒请求

类别。运行卡

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 将测试 Agent 常规结束提醒设为关闭。
2. 启动测试任务，从桌面请求本次完成提醒。
3. 等待任务结束，再执行不请求提醒的下一次任务。

**预期结果**

1. 仅目标任务发送一次结束提醒。后续任务不继承本次请求。
2. 原提醒配置没有被临时请求修改。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:2400](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L2400)。RC.remind

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## CARD-050

文件、图片、引用、语音输入

类别。消息

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 依次发送附件、图片、引用回复和语音。

**预期结果**

1. 附件写入本地清单且输入交给 Agent；引用内容附加；已授权语音可转写；桌面可观察会话但无任务输入界面。

**恢复步骤**

1. 清理测试附件。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:1266](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L1266)。handleTurn

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-051

文件与图片输出

类别。消息

**前置条件**

1. 隔离群已绑定到测试目录，Agent 在线。

**操作步骤**

1. 让 Agent 在测试目录生成文件和图片。

**预期结果**

1. 飞书结果卡提供可打开的输出；路径限制只允许测试目录文件；桌面无结果/文件浏览。

**恢复步骤**

1. 删除测试产物。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:4116](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L4116)。launchRun

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1669](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1669)。SessionPicker


## CARD-052

云文档评论任务执行

类别。消息

**前置条件**

1. 机器人已获文档评论权限且有测试文档。

**操作步骤**

1. 在评论中 @bot 提问，查看回复和桌面设置。

**预期结果**

1. 评论原线程回复，使用评论专属规则、后端与会话目录；桌面不显示评论任务记录。

**恢复步骤**

1. 删除测试评论。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:5036](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L5036)。comment run

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1060](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1060)。云文档评论


## CARD-053

飞书 DM 重连与诊断

类别。诊断

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 打开桌面诊断；在受控断线时尝试恢复。

**预期结果**

1. 桌面显示机器人、依赖与服务问题，并提供可执行的重连；飞书 DM 重连仍有效。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3044](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3044)。DM.doctor

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:921](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L921)。诊断页面


## CARD-054

飞书 DM 原地更新与进度

类别。诊断

**前置条件**

1. 测试安装版本低于可用发布版本。

**操作步骤**

1. 在桌面检查更新并执行到下载、替换与重启。

**预期结果**

1. 桌面可完成 DM 更新同等流程且显示失败或成功。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3111](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3111)。DM.updateDo

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/UpdatePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/UpdatePanel.tsx#L6)。function UpdatePanel


## CARD-055

Codex 用量查询、刷新与分享

类别。用量

**前置条件**

1. Codex 已授权且有用量。

**操作步骤**

1. 桌面读取 Codex 配额，刷新一次，选择配额与活动区块，生成分享卡。

**预期结果**

1. 可见配额、统计与热力图，并可生成可转发卡。

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3172](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3172)。DM.usageShareDo

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/UsagePanel.tsx:63](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/UsagePanel.tsx#L63)。function UsagePanel


## CARD-056

非管理员不能修改设置和删除绑定

类别。安全

**前置条件**

1. 隔离环境中有普通成员身份。

**操作步骤**

1. 以普通成员打开飞书卡片并尝试项目设置；本机桌面离线操作也检查权限模型。

**预期结果**

1. 飞书拒绝普通成员；桌面只允许本机 Host 授权操作者，对远程用户无桌面入口；无数据变化。

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3202](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3202)。DM.rmDo

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1435](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1435)。ProjectPanel


## CARD-057

卡片与桌面交叉编辑同一配置

类别。设置一致性

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 飞书卡片改 showToolCalls 后桌面刷新；再从桌面改并打开飞书新设置卡。

**预期结果**

1. 双方读到同一 config.json；旧 revision 提交冲突，不能静默覆盖。

**恢复步骤**

1. 恢复原值。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3249](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3249)。DM.setTools

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:530](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L530)。Editor


## CARD-058

停止或离线 Agent 只读

类别。设置一致性

**前置条件**

1. 隔离数据目录内有已注册且运行的 Agent。

**操作步骤**

1. 停用 Agent 或断开 Host，打开其桌面设置并尝试保存。

**预期结果**

1. 当前值可预览，编辑拒绝；重连后重新读取，未写旧状态。

**恢复步骤**

1. 恢复 Agent 启用。

**原功能依据**

- [core@v0.6.14:src/bot/handle-message.ts:3249](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3249)。DM.setTools

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1966](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1966)。SettingsPanel


## DATA-001

诊断页显示当前接续 Host 的实际数据目录

类别。data

**前置条件**

1. 旧版数据保存在 .feishu-codex-bridge，现有服务正在运行，新目录尚不存在。

**操作步骤**

1. 启动桌面版并接续现有服务。
2. 打开状态与诊断，读取数据目录。
3. 与该服务发现文件所在目录和真实目录比较。

**预期结果**

1. 显示实际使用的 .feishu-codex-bridge。
2. 不显示尚不存在的 .vonvon-bridge，不为修正显示而迁移运行中的数据。

**恢复步骤**

1. 仅做只读核对，无需恢复。

**原功能依据**

- [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/config/data-root.ts:48](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/config/data-root.ts#L48)。resolveDataRoot

**桌面源码核对位置**

- [desktop@c374a4a:desktop/main/controller.ts:103](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/main/controller.ts#L103)。class DesktopController


## LEGACY-001

识别已安装且已授权的 Codex 与 Claude

类别。本机环境

**前置条件**

1. 隔离环境预置 Codex 与 Claude 可执行文件；Codex 已授权

**操作步骤**

1. 启动桌面端
2. 打开本机环境并刷新

**预期结果**

1. 两个工具均显示正确安装状态和版本；Codex 显示已授权，不出现安装或授权按钮；Claude 安装状态准确

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:packages/runtime/src/toolchain-manager.ts:148](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/packages/runtime/src/toolchain-manager.ts#L148)。scan

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:437](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L437)。refresh lifecycle


## LEGACY-002

安装缺失的 Codex

类别。本机环境

**前置条件**

1. 隔离环境未安装 Codex

**操作步骤**

1. 打开本机环境
2. 点击安装 Codex
3. 等待完成并重新检测

**预期结果**

1. Codex 可执行文件可运行，版本显示；安装失败有可操作错误

**恢复步骤**

1. 清理隔离环境安装目录

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:331](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L331)。ToolSummary install

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:791](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L791)。installCodex


## LEGACY-003

安装缺失的 Claude Code 与飞书 CLI

类别。本机环境

**前置条件**

1. 隔离环境缺失 Claude Code 与 lark-cli

**操作步骤**

1. 分别点击安装 Claude Code、飞书 CLI
2. 重新检测两者

**预期结果**

1. 两者可执行文件可运行且版本显示

**恢复步骤**

1. 清理隔离环境安装目录

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:331](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L331)。ToolSummary install

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-004

更新 Codex、Claude Code 和飞书 CLI

类别。本机环境

**前置条件**

1. 隔离环境预置旧版三个工具；更新源可达

**操作步骤**

1. 逐个选择版本更新
2. 完成后重新检测

**预期结果**

1. 每个工具实际版本变更；失败保留旧版且界面给出错误

**恢复步骤**

1. 清理隔离环境安装目录

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:426](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L426)。ToolDetails update

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-005

取消正在安装或更新的工具

类别。本机环境

**前置条件**

1. 隔离环境模拟缓慢下载或安装

**操作步骤**

1. 开始安装或更新
2. 点击取消

**预期结果**

1. 操作终止；工具状态回到可重新操作；未留下损坏的可执行文件

**恢复步骤**

1. 清理隔离环境下载目录

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:341](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L341)。cancelOperation

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-006

Codex 官方账号授权及取消

类别。本机环境

**前置条件**

1. 隔离环境 Codex 已安装但未授权

**操作步骤**

1. 点击授权
2. 打开官方授权页
3. 完成授权后刷新
4. 再次开始授权并取消

**预期结果**

1. 授权状态变为已登录；取消后无挂起任务；授权码和链接可见

**恢复步骤**

1. 撤销隔离环境授权

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:606](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L606)。environment-inline-login

**桌面源码核对位置**

- [desktop@c374a4a:desktop/main/controller.ts:103](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/main/controller.ts#L103)。class DesktopController


## LEGACY-007

Claude Code 和飞书 CLI 登录及重验

类别。本机环境

**前置条件**

1. 隔离环境对应工具已安装且未登录

**操作步骤**

1. 分别启动 Claude Code、飞书 CLI 登录
2. 完成官方授权
3. 重新检测
4. 对已授权账号触发重验

**预期结果**

1. 每个工具从未授权转为可用，重验结果准确

**恢复步骤**

1. 撤销隔离环境授权

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:369](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L369)。startLogin

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-008

列出并切换 Profile

类别。飞书 CLI

**前置条件**

1. 隔离环境 lark-cli 有 A、B 两个 Profile

**操作步骤**

1. 打开管理飞书 CLI
2. 查看 Profile
3. 将当前 Profile 从 A 切到 B
4. 重新打开

**预期结果**

1. B 持续标记为当前 Profile，其他 Profile 保留

**恢复步骤**

1. 切回 A

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:927](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L927)。Profile list/use

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-009

新增已有应用 Profile 并安全保存凭据

类别。飞书 CLI

**前置条件**

1. 隔离环境有测试 App ID/Secret

**操作步骤**

1. 管理飞书 CLI → 添加已有应用 Profile
2. 输入名称、App ID、Secret
3. 设为当前并保存

**预期结果**

1. lark-cli 能以新 Profile 使用；秘密不显示在日志/快照；重启后仍可用

**恢复步骤**

1. 删除隔离测试 Profile

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:996](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L996)。Add profile

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-010

通过扫码新建应用 Profile

类别。飞书 CLI

**前置条件**

1. 测试飞书账号与隔离 lark-cli 可用

**操作步骤**

1. 管理飞书 CLI → 创建机器人 Profile
2. 扫码或打开验证链接
3. 完成官方流程

**预期结果**

1. 新 Profile 显示并可设为当前；取消和超时路径可恢复

**恢复步骤**

1. 删除隔离测试 Profile 与测试应用

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/EnvironmentPage.tsx:1097](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/EnvironmentPage.tsx#L1097)。Profile config init

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/EnvironmentPanel.tsx:25](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/EnvironmentPanel.tsx#L25)。function EnvironmentPanel


## LEGACY-011

扫码注册机器人并使用完整链接

类别。Agent

**前置条件**

1. 隔离数据目录；飞书测试应用可创建

**操作步骤**

1. 点击添加 Agent
2. 验证二维码、完整链接、打开/复制/刷新
3. 完成飞书注册

**预期结果**

1. 一个 Agent 注册并可启用；链接过期可重试；没有重复注册

**恢复步骤**

1. 停用并删除隔离 Agent

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/components/RobotRegistrationCard.tsx:18](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/components/RobotRegistrationCard.tsx#L18)。RobotRegistrationCard

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:1156](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L1156)。JobPanel


## LEGACY-012

复用已存在的飞书应用并刷新凭据

类别。Agent

**前置条件**

1. 已有测试 App ID 的 Agent

**操作步骤**

1. 在 Agent 详情中刷新应用凭据
2. 通过飞书授权完成
3. 重新读取并重启服务

**预期结果**

1. 同一 Agent 身份保留，秘密更新，既有群和项目配置保留

**恢复步骤**

1. 恢复测试应用凭据或清理隔离数据

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/RobotsPage.tsx:291](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/RobotsPage.tsx#L291)。registrationTaskPurpose refresh

**桌面源码核对位置**

- [desktop@c374a4a:desktop/main/controller.ts:103](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/main/controller.ts#L103)。class DesktopController


## LEGACY-013

启用、停用与权限检查/修复入口

类别。Agent

**前置条件**

1. 已注册 Agent

**操作步骤**

1. 启用 Agent，检查连接
2. 停用 Agent
3. 重新检查权限
4. 对缺失事件/权限打开飞书控制台

**预期结果**

1. 运行状态与实际一致；权限缺口明确；修复后重查转为正常

**恢复步骤**

1. 恢复 Agent 原状态

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:487](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L487)。RobotDetails

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## LEGACY-014

配置机器人任务卡显示、并发、超时、待处理策略和提醒

类别。Agent

**前置条件**

1. 隔离 Agent 存在

**操作步骤**

1. 分别更改显示工具调用、模型展示、并发数、空闲超时、待处理策略、完成提醒
2. 保存并重新读取

**预期结果**

1. 每项保存为有效值；下一次任务按新设置运行；越界值被拒绝

**恢复步骤**

1. 恢复全部原值

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:500](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L500)。RobotDetails settings

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:449](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L449)。AgentPanel


## LEGACY-015

配置标题精炼与评论生成的执行模型

类别。Agent

**前置条件**

1. 隔离 Agent 可列出 Codex/Claude 模型

**操作步骤**

1. 分别设置两种后端标题模型、effort；更改评论 backend/model/effort/instructions
2. 保存并新建对应任务

**预期结果**

1. 每项持久化；标题和评论实际使用所选后端/模型，失败可见

**恢复步骤**

1. 恢复原值

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:1163](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L1163)。RobotDetails title/comments

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## LEGACY-016

永久管理员与额外管理员管理

类别。Agent

**前置条件**

1. 测试 Agent 有 owner 和额外管理员

**操作步骤**

1. 查看 owner
2. 新增一个额外管理员
3. 移除该管理员
4. 尝试移除 owner

**预期结果**

1. owner 保持不可删除；额外管理员增删生效且远端卡片权限同步

**恢复步骤**

1. 恢复额外管理员原列表

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:1351](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L1351)。RobotDetails admins

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:1280](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L1280)。AgentPanel administrators


## LEGACY-017

创建项目群或绑定已有群，选择目录与会话模式

类别。项目

**前置条件**

1. 隔离 Agent 已加入测试群；可选本地空目录

**操作步骤**

1. 创建一个新项目群
2. 再绑定已有群
3. 分别选择共享/话题会话模式与工作目录

**预期结果**

1. 群、目录、会话模式和 Agent 绑定持久化；不重名；重启后可见

**恢复步骤**

1. 删除测试项目绑定与外部测试群

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/components/ProjectCreateDialog.tsx:17](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/components/ProjectCreateDialog.tsx#L17)。ProjectCreateDialog

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## LEGACY-018

编辑项目目录、会话模式、启用状态

类别。项目

**前置条件**

1. 已有测试项目，工作目录 A/B 均存在

**操作步骤**

1. 将目录从 A 改为 B
2. 将共享切为话题
3. 停用再启用项目
4. 重新读取

**预期结果**

1. 每项变更持久化；新的任务使用 B/话题模式；已有目录不删除

**恢复步骤**

1. 恢复目录 A 和原会话模式

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:1680](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L1680)。ProjectDetails state

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## LEGACY-019

配置权限、成员、免 @、网络、压缩、待处理和模型

类别。项目

**前置条件**

1. 已有测试项目与不同权限测试成员

**操作步骤**

1. 逐项更改管理员/普通成员权限、允许成员、免 @、联网、自动压缩、待处理策略、默认模型/effort
2. 保存并重读
3. 分别发送触发任务

**预期结果**

1. 设置持久化；允许/拒绝、网络和模型行为符合设置

**恢复步骤**

1. 恢复原设置

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:2204](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L2204)。ProjectDetails settings

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## LEGACY-020

删除项目后保留工作目录并清除绑定

类别。项目

**前置条件**

1. 隔离项目绑定目录含标记文件

**操作步骤**

1. 在项目详情点击删除并确认
2. 重新读取项目列表和目录

**预期结果**

1. 项目绑定与关联会话映射清除；本地目录及标记文件仍在；其他项目不变

**恢复步骤**

1. 重建隔离测试项目

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:packages/runtime/src/project-service.ts:616](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/packages/runtime/src/project-service.ts#L616)。delete

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ProjectPanel.tsx:26](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ProjectPanel.tsx#L26)。function ProjectPanel


## LEGACY-021

查看、搜索、筛选并跳转历史会话

类别。项目

**前置条件**

1. 测试项目有共享与话题历史会话

**操作步骤**

1. 打开项目历史会话
2. 搜索关键词
3. 按来源筛选
4. 打开对应飞书群或话题

**预期结果**

1. 列表含来源/时间/目标；搜索筛选准确；跳转到对应群或话题

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:1422](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L1422)。ProjectSessionHistoryPage

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## LEGACY-022

从桌面打开绑定的飞书项目群

类别。项目

**前置条件**

1. 测试项目已绑定飞书群

**操作步骤**

1. 打开项目详情
2. 点击打开项目群

**预期结果**

1. 系统浏览器或飞书客户端定位到绑定群

**恢复步骤**

1. 只读或拒绝写入检查。核对隔离数据与测试前一致，退出测试实例。

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/ManagementPanel.tsx:2000](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/ManagementPanel.tsx#L2000)。ProjectDetails openProject

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/ConversationPanel.tsx:18](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/ConversationPanel.tsx#L18)。function ConversationPanel


## LEGACY-023

设置新项目默认根目录并恢复默认

类别。设备设置

**前置条件**

1. 隔离数据目录，目录 A 存在

**操作步骤**

1. 选择 A 为新项目默认位置
2. 创建空白项目验证路径
3. 点击恢复默认
4. 再创建项目验证默认路径

**预期结果**

1. 新项目按设定根目录创建；已有项目目录不移动

**恢复步骤**

1. 恢复初始根目录

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/DeviceSettingsSectionPage.tsx:249](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/DeviceSettingsSectionPage.tsx#L249)。project-preferences

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## LEGACY-024

配置 CLI 活动通知、范围、工具和唤醒

类别。设备设置

**前置条件**

1. 测试 Agent 有 owner；CLI hook 可安装

**操作步骤**

1. 启用本机 CLI 活动转发
2. 依次设置 all/bound_projects/none、Claude/Codex 开关与保持唤醒
3. 触发各 CLI 事件

**预期结果**

1. 设置持久化；仅允许的事件被推送；等待时唤醒行为正确

**恢复步骤**

1. 恢复原设置

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/DeviceSettingsSectionPage.tsx:305](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/DeviceSettingsSectionPage.tsx#L305)。handoff

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/settings/SettingsPanel.tsx:2001](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/settings/SettingsPanel.tsx#L2001)。function SettingsPanel


## LEGACY-025

检查并修复 Claude/Codex hooks

类别。设备设置

**前置条件**

1. 隔离 hook 配置可写且至少一项缺失

**操作步骤**

1. 查看 hook 状态
2. 点击检查并修复
3. 重新读取 hook 状态

**预期结果**

1. 缺失或损坏 hook 变为已安装；冲突不被覆盖；原有其他 hook 保留

**恢复步骤**

1. 恢复隔离 hook 配置

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/DeviceSettingsSectionPage.tsx:433](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/DeviceSettingsSectionPage.tsx#L433)。repairHooks

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/settings/SettingsPanel.tsx:780](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/settings/SettingsPanel.tsx#L780)。AgentPanel hooks


## LEGACY-026

控制 Bridge 服务启动、停止、接管及登录自启

类别。设备设置

**前置条件**

1. 隔离 CLI 服务可运行；桌面应用可管理登录项

**操作步骤**

1. 启动服务并确认飞书连接
2. 停止服务并确认停止
3. 在 CLI 已占用时执行接管
4. 切换桌面登录自启

**预期结果**

1. 同一设备只有一个宿主；期望运行状态保留；登录自启准确；无任务数据丢失

**恢复步骤**

1. 恢复服务及自启原状态

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/DeviceSettingsSectionPage.tsx:471](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/DeviceSettingsSectionPage.tsx#L471)。application

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/MachinePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/MachinePanel.tsx#L6)。function MachinePanel


## LEGACY-027

检查并安装桌面软件更新

类别。设备设置

**前置条件**

1. 隔离更新源提供比当前版本新的签名包

**操作步骤**

1. 打开应用与启动
2. 检查更新
3. 查看版本及发布页
4. 安装更新并重启

**预期结果**

1. 新版本启动且本机配置保留；下载/安装失败可恢复

**恢复步骤**

1. 恢复测试环境初始版本

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/pages/DeviceSettingsSectionPage.tsx:563](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/pages/DeviceSettingsSectionPage.tsx#L563)。application software update

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/management/UpdatePanel.tsx:6](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/management/UpdatePanel.tsx#L6)。function UpdatePanel


## LEGACY-028

查看 Bridge、机器人、项目、工具和 CLI 数据诊断

类别。诊断

**前置条件**

1. 隔离环境准备正常与权限缺失两种状态

**操作步骤**

1. 打开状态与诊断
2. 刷新
3. 检查各项及跳转修复入口

**预期结果**

1. 状态与真实服务/权限一致；缺失项给出可操作入口；历史状态不会伪装为实时

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/DiagnosticsPanel.tsx:35](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/DiagnosticsPanel.tsx#L35)。DiagnosticsPanel

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/renderer/App.tsx:921](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/renderer/App.tsx#L921)。diagnostics page


## LEGACY-029

搜索设置、机器人与项目，并保护未保存修改

类别。交互

**前置条件**

1. 已有 Agent/群绑定且项目设置有未保存改动

**操作步骤**

1. 搜索设置项及实体名称
2. 尝试离开编辑页
3. 选择保存/放弃/继续编辑

**预期结果**

1. 搜索定位正确；三种选择分别保存、丢弃或继续，不会静默丢失改动

**恢复步骤**

1. 恢复测试项目设置

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/app/AppShell.tsx:256](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/app/AppShell.tsx#L256)。AppShell search

**桌面源码核对位置**

- [desktop@c374a4a:desktop/renderer/SearchDialog.tsx:5](https://github.com/modelzen/vonvon-bot/blob/c374a4a/desktop/renderer/SearchDialog.tsx#L5)。function SearchDialog


## LEGACY-030

重启桌面后继续读取原本 Bridge 数据

类别。桌面运行

**前置条件**

1. 现有用户数据根有 Agent、项目与会话关联；隔离副本

**操作步骤**

1. 退出桌面应用
2. 重新启动
3. 查看 Agent/群/设置

**预期结果**

1. 原始数据无副本分叉；Agent、群与设置同 CLI 读取；无需重新导入或产品账号

**恢复步骤**

1. 结束测试任务，恢复测试前的设置与服务状态。保留验证证据后清理隔离测试数据；不清理用户真实数据。

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:packages/runtime/src/desktop-runtime-api.ts:303](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/packages/runtime/src/desktop-runtime-api.ts#L303)。desktop.snapshot

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:437](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L437)。refresh


## LEGACY-031

本地移除并重新添加同一 Agent

类别。Agent

**前置条件**

1. 隔离测试 Agent 已注册且停用

**操作步骤**

1. 移除本地 Agent
2. 核查凭据/群绑定/设置/会话记录
3. 通过扫码重新注册同一 App ID

**预期结果**

1. 仅目标 Agent 本地记录删除；飞书应用保留；重新注册后名称稳定，无重复 Agent

**恢复步骤**

1. 清理隔离 Agent

**原功能依据**

- [legacy@3a168535c11a4f403553967908d272127e6a23af:packages/runtime/src/robot-service.ts:27](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/packages/runtime/src/robot-service.ts#L27)。removeRobotData

**桌面源码核对位置**

- [desktop@aab1bb34442d6723016cfbdc3217159108b4348f:desktop/main/controller.ts:708](https://github.com/modelzen/vonvon-bot/blob/aab1bb34442d6723016cfbdc3217159108b4348f/desktop/main/controller.ts#L708)。deleteAgent


## 单列的范围说明

- LEGACY-032。单列研究，未列为本轮升级承诺。当前明确的升级来源是 feishu-codex-bridge；旧 Vonvon 仓库用于设计和实现参考，不能把其独立私有数据格式迁移自动加入本轮。 依据 [legacy@3a168535c11a4f403553967908d272127e6a23af:packages/runtime/src/legacy-desktop-store-upgrade.ts:37](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/packages/runtime/src/legacy-desktop-store-upgrade.ts#L37)。LegacyDesktopStoreUpgrade。

## 不单独提供桌面入口的内部机制

- Hidden secrets get/set/list/remove。Internal exec-provider and keystore plumbing. Desktop must preserve it for CLI interoperability, but must not expose raw secret values. 依据 [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:162](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L162)。hidden secrets command。
- Hidden hook, host and daemon-control helpers。Process integration entry points, not end-user controls. Their behavior is covered through registration, CLI collaboration and lifecycle cases. 依据 [core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:164](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L164)。hidden hook；[core@21ed17cab64df7c1b481c56d63ea6aa51fc212ad:src/cli/index.ts:108](https://github.com/modelzen/feishu-codex-bridge/blob/21ed17cab64df7c1b481c56d63ea6aa51fc212ad/src/cli/index.ts#L108)。hidden daemon-control。
- messageReply, requireMentionInGroup, agentStopGraceMs, access.allowedUsers。Schema accepts historical values but effective code path absent or field deprecated; preserve on migration, do not present as active controls. 依据 [core@v0.6.14:src/config/schema.ts:81](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/config/schema.ts#L81)。legacy getters and deprecated access field。
- backend switch on existing project。Old implementation already removed it; backend is fixed after project creation. 依据 [core@v0.6.14:src/bot/handle-message.ts:3838](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L3838)。backend switch removed。
- Feishu-only send/reaction transport。Messages, cards, and emoji still run in the bundled core and should be tested end to end, but a desktop inbox is a separate product requirement. Cases CARD-041 to CARD-052 mark desktop observability/controls separately. 依据 [core@v0.6.14:src/bot/handle-message.ts:881](https://github.com/modelzen/feishu-codex-bridge/blob/v0.6.14/src/bot/handle-message.ts#L881)。runReaction。
- 旧版 Vonvon 账号登录与账号切换。用户明确指定本地功能无需产品账号，团队空间再登录；旧版 ADR 0012 的登录门槛与新产品决策冲突。保留云端账号能力仅在团队空间设计后另行立项。 依据 [legacy@3a168535c11a4f403553967908d272127e6a23af:docs/adr/0012-require-login-and-defer-multi-device-capabilities.md:8](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/docs/adr/0012-require-login-and-defer-multi-device-capabilities.md#L8)。Require login and defer multi-device capabilities；[legacy@3a168535c11a4f403553967908d272127e6a23af:CONTEXT.md:11](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/CONTEXT.md#L11)。Vonvon Bridge account。
- 旧版一次性从 Bridge CLI 导入独立副本。用户明确指定升级直接接续旧数据，旧目录与 .vonvon-bridge 链接并保持随时切换；复制导入会制造两份数据，与新流程冲突。需测试路径别名和同一数据事实源。 依据 [legacy@3a168535c11a4f403553967908d272127e6a23af:docs/adr/0005-keep-data-roots-independent-and-share-the-schema.md:8](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/docs/adr/0005-keep-data-roots-independent-and-share-the-schema.md#L8)。independent roots；[legacy@3a168535c11a4f403553967908d272127e6a23af:apps/desktop/src/StartupGuide.tsx:197](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/apps/desktop/src/StartupGuide.tsx#L197)。import UI。
- 多设备远程管理与设备快照。旧版 ADR 0012 说明当前桌面发布版并未交付这些能力，不能作为旧版已有效功能。 依据 [legacy@3a168535c11a4f403553967908d272127e6a23af:docs/adr/0012-require-login-and-defer-multi-device-capabilities.md:19](https://github.com/modelzen/vonvon-bridge-legacy/blob/3a168535c11a4f403553967908d272127e6a23af/docs/adr/0012-require-login-and-defer-multi-device-capabilities.md#L19)。deferred multi-device。
