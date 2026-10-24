# 公共组件统一与 Libraries.dev 适用性

2026-10-24。owner 要求把优化扩展到概览、Bot、群组和设置页，并指出下拉框粗糙及模型页控件尺寸不一致。本轮在模型与权限实现之上统一公共组件，待网页验收。

## 范围与基线

依赖模型与权限页 PR #499，包含 dev@5ea4db56 的已恢复界面。公共样式、少量选项直接选择、模型编辑入口、概览/Bot/群组/设置列表为本轮范围。导航、记忆画布、权限语义、Provider 目录来源和保存协议不变。

## 实现

- tokens 定义桌面控件高 32px、大按钮 36px、控件圆角 8px、常规字段宽 260px、卡片圆角 12px。触控热区至少 44px。
- component-foundation.css 在公共样式末尾统一按钮、输入、SettingsGroup、卡片、选择面板和 Dialog。保留蓝色主操作、系统字体与原有身份色，收敛多层阴影和渐变。
- SelectControl 对少量且文字适合的选项直接显示原生 radio 分段选择；长列表、复杂标签继续使用 Base UI 选择面板。同值、不可用、只读和非法选择仍禁止提交。
- Provider、模型与 Effort 使用相同宽高及左对齐。模型/Effort 的单一值按钮打开原有多选弹窗，图标表达编辑，取消、完成与页面保存语义不变。
- 概览、Bot 列表统一 64px 行、32px 头像与主次文字；群组仍保留展开树，搜索、操作、hover/focus 和卡片沿用同一套 tokens。概览图标操作复用公共 IconButton。
- 多行字段独立保持自动高度及最小 88px，避免单行尺寸规则挤压 MCP 参数和自定义权限的网站列表。

组件方案使用已有 Base UI，参考 [shadcn/ui](https://ui.shadcn.com/docs) 的组合及统一状态模式，没有新增运行时组件依赖。

## Libraries.dev

已实际查看官网及官方免费 Skill，并在本机安装 libraries-dev Skill；下轮对话可自动使用。无需 MCP，也未添加 npm 动效依赖或购买 Pro。

适合后续使用的位置：

- AgentAvatar 的默认 Bot 图标可考虑 [Bot Avatars](https://libraries.dev/bots)，保留 owner 上传头像的优先级，实际任务状态与后台在线状态必须区分。
- ProviderSetup 的长时间连接/授权等待，或真实执行中的 ConversationPanel，可考虑 20px 的 [Thinking Orbs](https://libraries.dev/orbs)，配文字且仅在实际等待时出现。
- [Voice Glow](https://libraries.dev/voice) 适用于未来本地语音输入；当前飞书语音转文字开关没有本地麦克风，不据此新增麦克风能力。

Border Beam、Metal、Gooey 和 Image 目前没有必要放入常规设置按钮或卡片；先保证控件一致性与状态可读，不强行动效。Skill 安装方法以 [官方说明](https://libraries.dev/skill) 为准。

## 验证与验收

- UI typecheck 通过；全量 51 个文件、437 项测试通过。新增短选项直接选择、无默认写入、禁用/同值保护、长列表保留面板和无障碍命名测试。
- 实际构建网页使用隔离演示客户端核验概览、Bot 列表、群组、设置首页及决策配置。Provider/模型/Effort 实测均为 260×32，同一左边缘。
- 键盘方向键切换 Provider 后仅更新草稿，模型/Effort 需重新选择；取消和页面放弃仍不保存。
- 自定义权限的网站列表实测 rows=4，高约 103px、最小高度 88px，保留多行输入。
- 独立审查修正 textarea 级联优先级后未发现 blocker。实际 App、真实 Feishu 和模型执行未由演示网页代替验收。
- owner 在网页认可本轮提交后，再按仓库门禁合入 dev；当前不将早先设计稿认可视为本轮验收。

本轮差异约 500 行，无真实 ID、密钥或运行所需的本机路径。主要风险是公共 CSS 的作用范围和控件适配，靠多页面截图、尺寸测量和定向状态测试核对。
