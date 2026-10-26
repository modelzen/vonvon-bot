# Libraries.dev 第二轮适用位置（排除灵感页）

2026-10-26。owner 要求基于当前 dev 继续检查可优化组件，明确排除由另一个会话处理的灵感页。本轮仅阅读源码与官网、记录建议，不修改产品代码、不执行真实安装 / 密钥验证 / 注册。

## 基线与复用

远端 dev 为 `b56db712a6a77834c030e00c65bec41244af9e34`（PR #545）。先阅读本目录索引、上一轮 `2026-10-26-libraries-dev-fit/report.md` 及公共组件记录，再检查本次新增候选。详情标签 Gooey、任务 / 注册 / Provider 连接状态球、添加 Bot 内光及最终搜索内光均已实施，不重复作为新建议。

## 推荐顺序

1. **群设置 → 沟通方式滑杆：Gooey Move。** `packages/ui/src/settings/ConversationSlider.tsx:33` 当前使用原生三档 range，滑钮由 CSS 伪元素绘制（24px），拖动时按三档预览。可让单独的装饰滑钮在拖动或鼠标切档时轻微拉伸、落位收回，采用短暂约 160–200ms 的过渡；保留浅色表面、现有强调色和 24px 视觉尺寸。原生 range、文字说明、禁用状态、键盘、取消手势和释放后才提交的行为保留；键盘与减少动态效果即时落位。库不能直接包装伪元素，需要透明原生滑钮配合独立、不可交互的装饰层，因此应先做局部预览，再决定是否实施。优先级最高。

2. **设置 → 工具与连接 → 安装进度：Thinking Orbs working。** `packages/ui/src/management/EnvironmentPanel.tsx:246` 当前只有“正在安装 / 更新”、已运行秒数和取消 / 后台继续按钮，没有确定百分比。运行标题旁复用 `OperationActivity` 的浅色 20px Orb、两秒延迟和卸载清理；继续显示真实耗时和终态。Provider 安装行同类位置也可按真实安装状态统一，但不重复修改已经有 Orb 的模型读取 / 授权连接。不要凭时间生成百分比，也不同时给同一进度卡添加 Beam。优先级中等。

3. **设置 → 决策模型 → API 密钥验证：Thinking Orbs connecting。** `packages/ui/src/management/SecretsPanel.tsx:159` 与 `:175` 当前进度正文只有保存 / 验证文字，页脚按钮转圈；列表验证按钮同样是普通 loading。建议只在真实远端验证超过两秒时，正文显示 20px connecting Orb 和原有文字；短暂本机保存维持静态，成功 / 失败立即回到原有结果。一个区域只留一个动态提示，按钮维持禁用及原位置；不改输入清空、关闭后结果归属和错误重试。优先级中等。

## owner 的预览约束

owner 随后要求前后对比，并明确沟通方式继续使用一根连续轴线；第一项可以去掉原蓝色光圈、菱形刻度与渐变端点，按 Gooey Move 官方示例的简洁滑钮重新预览。当前预览采用官方示例的深灰填充、stretch 0.6 / trail 0.35，沿简洁单轴拖动，并保留三个档位与原有说明。

owner 明确第 3 项密钥验证不改、也不演示，后续候选范围仅第 1 项沟通方式与第 2 项安装进度。上述产品代码尚未修改，预览不等于实施验收。

## 未列为本轮建议的位置

- MCP 授权弹窗仅复制命令，明确不检测授权结果（`McpPanel.tsx`）；不能添加声称后台正在连接的动画。
- 用量页当前没有日期范围分段切换，不能凭通用仪表盘模板推荐一个不存在的控件；既有配额条继续表达真实百分比。
- Bridge 导入已有阶段步骤列表；不以 Orb 替代确定阶段。导入前检查可单独统一等待提示，但属低频流程，本轮不优先。
- 普通数据读取、目录列表、记忆导图节点不普遍加入状态球或内光。页面加载不等于 agent 正在处理任务。
- Bot Avatars 延续 owner 保留飞书头像的决定；Voice / Image 没有对应的实时录音 / 图片生成界面；Metal 暂无适合的新重点入口；Magnetic UI 面向手机磁力计与实体磁铁，当前 Mac 管理界面不适用。
- 不增加新的常驻彩光。当前按钮和搜索已承担视觉重点，继续扩散会削弱主次。

## 核实记录与边界

2026-10-26 重新读取官方页面及本机 Libraries.dev Skill 对应参考。Gooey 的 Move 可用于滑钮，Thinking Orbs 提供内联 20px 与 working / connecting 状态；以上适用性与优先级是结合当前源码的设计判断。未测量真实安装或验证耗时，因此仅建议延迟显示，不承诺这些操作必然超过两秒；未进行新一轮 App 交互验收或独立模型复核。

- [Gooey](https://libraries.dev/gooey)
- [Thinking Orbs](https://libraries.dev/orbs)
- [Border Beam](https://libraries.dev/beam)
- [Metal](https://libraries.dev/metal)
- [Voice](https://libraries.dev/voice)
- [Image](https://libraries.dev/image)
- [Magnetic UI](https://libraries.dev/magnetic)

## owner 确认后的实施

上述只读结论记录研究阶段；owner 随后要求实施第 1、2 项，并允许优化单轴两端。已按 [单轴与安装提示](../../plans/communication-axis-polish.md) 落地：4px 中性灰轴线在两端档位中心外各延伸约 26px 并渐隐，28px 官方 Gooey Move 滑钮连续跟手、释放吸附；安装运行标题复用两秒延迟的 OperationActivity。第 3 项和灵感页仍不涉及。

UI typecheck、718 项 UI 测试、构建与 arm64 打包通过，已签名并重启本机 App。隔离 fixture 验证手势、窄窗口、减少动态效果和安装终态；实际 App 只读检查群设置外观，未修改真实沟通方式或运行真实安装。实现已交给 owner 本机验收，尚未推送或合入。

### 实操反馈与修正

owner 随后否定初版的大号深灰滑钮和画面变化，允许还原或优化。隔离实操复现 Gooey 绘制落后于指针、保存提示推移内容、设置树重载，以及关注度显隐改变轴宽。本轮移除滑杆上的 Gooey，采用 18px 浅色蓝边滑钮、2px 蓝紫细轨和小档位点；保留单轴、连续跟手与释放提交。保存时保持目的档位和键盘焦点，刷新保留已载内容，标题栏预留保存反馈，固定轴区宽度。详情标签和安装 Orb 不变。

最终设计与实现以 [更新后的计划](../../plans/communication-axis-polish.md) 为准。720 项 UI 测试与构建通过，慢保存隔离实操确认三档切换前后滑轨坐标与滚动位置一致；已签名更新本机 App，等待 owner 验收。当前结论说明 Gooey Move 在本产品的这个小型三档滑杆中不值得保留，不能以预览效果替代实操。

owner 已在 Mac mini 本地验收通过最终提交 `e5ff4d75`，并明确要求合入远端 dev、跳过 CI；远端合入状态以 PR 记录为准。
