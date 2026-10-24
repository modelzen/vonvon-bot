# 公共组件统一与 Libraries.dev 适用性

2026-10-24。owner 要求把优化扩展到概览、Bot、群组和设置页，并指出下拉框粗糙及模型页控件尺寸不一致。本轮在模型与权限实现之上统一公共组件，owner 已明确要求合入 dev、跳过 CI 并重编译重启 App。

## 范围与基线

依赖模型与权限页 PR #499，包含 dev@5ea4db56 的已恢复界面。公共样式、少量选项直接选择、模型编辑入口、概览/Bot/群组/设置列表为本轮范围。导航、记忆画布、权限语义、Provider 目录来源和保存协议不变。

## 实现

- tokens 定义桌面控件高 32px、大按钮 36px、控件圆角 8px、常规字段宽 260px、卡片圆角 12px。触控热区至少 44px。
- component-foundation.css 在公共样式末尾统一按钮、输入、SettingsGroup、卡片、选择面板和 Dialog。保留蓝色主操作、系统字体与原有身份色，收敛多层阴影和渐变。
- SelectControl 对少量且文字适合的选项直接显示原生 radio 分段选择；长列表、复杂标签继续使用 Base UI 选择面板。同值、不可用、只读和非法选择仍禁止提交。
- Provider、模型与 Effort 使用相同宽高及左对齐。模型/Effort 的单一值按钮打开原有多选弹窗，图标表达编辑，取消、完成与页面保存语义不变。
- 概览、Bot 列表统一 64px 行、32px 头像与主次文字；群组仍保留展开树，搜索、操作、hover/focus 和卡片沿用同一套 tokens。概览图标操作复用公共 IconButton。
- 多行字段独立保持自动高度及最小 88px，避免单行尺寸规则挤压 MCP 参数和自定义权限的网站列表。

组件方案使用已有 Base UI，参考 [shadcn/ui](https://ui.shadcn.com/docs) 的组合及统一状态模式，未额外引入通用组件库。

## Libraries.dev

已实际查看官网及官方免费 Skill，并在本机安装 libraries-dev Skill；无需 MCP 或 Pro。owner 随后要求实际应用，并明确保留飞书头像。

- 新增精确版本 `thinking-orbs@0.3.2`（MIT，React peer，无其他运行时依赖）。ConversationPanel 仅在真实 `context.run` 存在满两秒后显示一个 20px working orb，与“当前任务 / 自主目标”文字并排。预留尺寸防止位移；任务结束、会话变化或运行 ID 更换会移除或重新计时。
- App 使用固定浅色面板，因此明确传入 `theme="light"`；保留库内的减少动态效果、离屏与隐藏标签页暂停，Canvas 对读屏隐藏，现有状态文字不变。
- Bot / 群组的飞书头像保持原样，未添加 Bot Avatars。
- 飞书消息卡片是 CardKit JSON，无法直接嵌入 React Canvas。按 owner“能做就试试，不行就算了”的范围保留已有原生状态图标与原位更新；没有发出真实测试消息，也不为模拟动画增加轮询写卡频率。
- Border Beam、Metal、Gooey、Voice 和 Image 当前没有合适的业务入口，本轮没有加入。

参考 [Thinking Orbs](https://libraries.dev/orbs) 和 [官方 Skill](https://libraries.dev/skill)。

## 验证与验收

- UI typecheck 通过；全量 51 个文件、440 项测试通过。新增短选项直接选择、无默认写入、禁用/同值保护、长列表保留面板和无障碍命名测试。
- 实际构建网页使用隔离演示客户端核验概览、Bot 列表、群组、设置首页及决策配置。Provider/模型/Effort 实测均为 260×32，同一左边缘。
- 键盘方向键切换 Provider 后仅更新草稿，模型/Effort 需重新选择；取消和页面放弃仍不保存。
- 自定义权限的网站列表实测 rows=4，高约 103px、最小高度 88px，保留多行输入。
- 独立审查修正 textarea 级联优先级与 orb 明暗主题适配后未发现 blocker。实际 App、真实 Feishu 和模型执行未由演示网页代替验收。
- owner 于 2026-10-24 明确要求“合入 dev 跳过 CI，重新编译 app 重启 app”，并追加 Libraries.dev 效果但保留飞书头像。此次按该指令合入 dev，CI 跳过不记为通过；App 构建与重启结果单独记录。

本轮差异约 500 行，无真实 ID、密钥或运行所需的本机路径。主要风险是公共 CSS 的作用范围、控件适配和等待效果生命周期，靠多页面截图、尺寸测量和定向状态测试核对。
