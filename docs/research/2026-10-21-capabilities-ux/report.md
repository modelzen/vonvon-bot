# Skills、CLI 与 MCP 的界面组织

2026-10-21。范围：官方公开文档 + 本机主仓库 `cf5ec97d` 源码；没有运行竞品完整应用，没有安装、登录或调用任何真实服务。实现只在交互原型中；此报告不是已交付的后端合同。

## 用户已选的方向

工作区优先：群内查看发现的 Skill 并控制本群加载；通过私聊添加到当前群×Bot 工作区；CLI/MCP 的安装与授权集中管理。不新增 Bot 技能库。原型保留「能力 / 个性与记忆 / 模型 / 工作区 / 回复规则」。

## 官方产品参照

| 产品 | 官方文档中的设计 | 对本原型的启发 |
| --- | --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) | 从仓库、个人、管理与系统目录发现 Skill；仓库内向上扫描 `.agents/skills`。分发可用插件打包。 | 展示真实来源；不把所有发现项误认为本群安装的内容。 |
| [Claude Code](https://code.claude.com/docs/en/skills#choose-where-skills-load) | 区分个人、项目、插件、账号等来源。删除方式随来源而变；插件技能应由插件管理。 | 详情页显示来源与范围；本群不能直接删除个人或插件技能。 |
| [OpenClaw](https://docs.openclaw.ai/tools/skills) | 区分技能是否被发现、依赖是否齐全、是否对 Agent 可见。依赖包含可执行文件、环境等；支持工作区和共享安装。 | 「已发现」不等于「可调用」。缺少 CLI 或授权时给出对应处理入口，而不是另加一个开关。 |
| [VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | 添加 MCP 可用 URL 或本机命令，并选择配置归属；配置好之后还需验证真实工具调用。连接与工具选择有各自的管理入口。 | 添加连接、授权、检测与群内使用应分开；不能将保存配置写成调用已成功。 |

[Claude 的技能可见性设置](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)与 [OpenClaw 的技能配置](https://docs.openclaw.ai/tools/skills-config)说明：控制技能加载是可行的产品能力。但这不等同于禁用操作系统中某条 CLI；后者需要实际执行权限机制。移除已加载技能也不能抹去现有对话已经读入的文字。

## 当前 Vonvon 已实现到哪里

- `packages/daemon/src/agent/session-profile.ts:28-40`：非空 capabilityPackages / mcpServers 会报未支持；两家 backend 都声明相应能力为 false。不能把群级开关当成后端已经接好。
- `packages/daemon/src/agent/claude-agent/backend.ts:46-64`：普通会话读取 user + project 配置。Codex 普通 start/resume 同样保留工作区原生配置（`agent/codex-appserver/backend.ts:78`）。
- `packages/daemon/src/agent/codex-appserver/judge-process.ts:365-408` 已有判断进程的技能枚举与关闭；Claude helper 也有 skills 空名单。说明 Provider 层存在接线可能，不能据此声称普通聊天已经支持。
- `packages/protocol/src/environment.ts:4`、`packages/ui/src/management/EnvironmentPanel.tsx:213`：已有本机安装与授权管理，但固定为 Codex、Claude、飞书 CLI；通用 gh/MCP 目录仍需补充。
- `packages/daemon/src/environment/service.ts:351-357`：停用的是 Vonvon 托管副本。后续解析仍可命中外部安装；`packages/daemon/test/environment-rpc.test.ts:166-168` 有对应测试。它不是群级禁止执行。
- 既有 `docs/product.md:429` 使用过本机库/Bot 名单/群增减的方案。用户本轮选择了更简单的工作区方案，当前先在原型验证；后续实现前应同步产品合同，不能让两套归属并存。

## 用户进一步简化后的设计

1. 技能列表只保留名称、用途、启用开关；来源和文件路径收进详情。不显示工具待安装、待授权或依赖就绪。通用 Skill 未必有结构化依赖元数据，不能从自由文本可靠推断工具就绪状态。OpenClaw 的显式依赖机制适合其自身体系，不直接套在所有 Provider 技能上。
2. 技能开关的含义是当前群×Bot 是否加载该技能。不是删除文件，不是 CLI 禁用，也不改其他群。此为已选的前端目标行为；后端普通聊天尚未支持，需落实后再宣称有效。
3. “添加 Skill”显示目标群与 Bot，并带预填消息进入私聊。用户在私聊描述需求或提供技能链接，后续由对话完成创建/安装；原型只演示进入私聊，不操作文件，不调用真实模型。
4. 用户明确不增加 Bot 级技能范围，只添加到当前群×Bot 工作区。共享文件夹仍可能共享技能文件；加载开关则按群×Bot 隔离。
5. CLI/MCP 安装、授权、配置继续集中在设置的“工具与连接”。群页只留入口，不重复工具状态清单。保存连接和实际工具调用成功仍是不同状态。
6. 小集合选项用分段单选；模型与 Effort 独立多选；群启停用固定标签“启用”的开关。

## 后端接入验收要点

- 发现结果来自当前 Provider + 实际工作区，包含来源、同名项和加载错误；不能硬编码一份全局技能表。
- 私聊添加要明确并校验目标群、Bot、工作区和操作者权限；不能依赖可改显示名作为授权依据，不能暗改个人或插件来源。
- 技能加载开关要在启动/恢复交付中实测；明确对已有对话何时生效，不当作 CLI 的执行权限。
- CLI 安装和授权状态分别探测，且考虑运行环境与 Provider 进程实际 PATH；不能只因为文件存在就展示「本群可调用」。
- MCP 来源、配置作用域与连接生命周期要和实际 Provider 配置一致；以后做群级限制时，必须验证普通聊天的工具交付和执行。

## 群内用法与当前命令来源

群页顶部放“群内用法”，不增加概览页。它按当前群×Bot、聊天方式以及主区/话题内位置展示命令；权限不明时标注主人/管理员，不推断当前网页操作者有权限。

依据 `packages/daemon/src/card/command-cards.ts:347`、`bot/handle-message.ts:2372,2598,878`：/help、/model、/context、/compact、/goal <目标>；主区管理命令包括 /new（/clear）、/resume、/settings。/new 限单会话/智能主区且任务不忙；模型与上下文命令在话题内或单会话/智能主区使用。当前未实现 /stop、/goal pause 或 /model <模型> 语法。普通文字和命令仍受群启停、消息准入和角色规则限制。

命令目录目前由帮助卡代码构造，网页没有可直接调用的统一结构化目录；后续应抽取共用来源，并结合实际会话 Provider 能力、忙闲和操作者权限判断。CLI、MCP、Skill 名称不自动成为飞书斜杠命令。

`packages/daemon/src/bot/dm-console.ts:9` 显示当前私聊以管理菜单和待回答问题为主。因此“通过私聊添加 Skill”是本轮选定的目标流程，尚需新增后端能力；原型仅演示目标提示、预填消息、模拟发送与返回。
