# 能力页技能列表：owner 选定方案的实施

2026-10-24。owner 要求以当前 dev 为基准，逐页展示现状 / 建议，认可后再改产品；本页对比后回复“采用建议”。实现基于 `d96120345fff3028d3e230fa58a8b30cb0598ab3`，仅修改能力页技能列表的呈现。

采用连续紧凑行和渐进披露：技能列表最大高度 240px，600px 以下窗口为 230px；简介一行截断，完整说明沿用详情弹窗；搜索栏旁显示总数与启用数，搜索时显示结果数 / 总数。搜索与重新读取在滚动列表外。短列表自然收缩，未发现技能和读取失败继续走原有分支。开关与保存逻辑、导航、模型与权限页均沿用当前 dev。

参考判断来自本任务已阅读的 apple-design、emil-design-eng、interface-design-review 及此前 affectUI / Designeer 研究。固定列表高度是本产品的取舍，不是这些参考的强制规范：它让语音、工具更容易到达，但浏览全部技能需要在列表内滚动。未新增依赖。

## 验证

- `npm ci --ignore-scripts`；protocol 和 client 构建通过。
- `npm run typecheck -w packages/ui` 通过。
- `npm run test -w packages/ui -- test/group-design-settings.test.tsx test/project-panel-runtime.test.tsx`：2 个文件、13 项测试通过。
- `npm run build -w packages/ui` 通过；保留已有 bundle 大小提示。
- Codex 浏览器加载本工作树真实 `GroupSettingsContent` / `Editor` / `AppShell` 与样式，使用 9 项隔离示例技能及内存 client；不是复制的 SkillsList 原型，也没有连接真实 Bot。
- 验证搜索无结果为 0 / 9，可清除恢复；开关经原 Editor 保存成功路径将启用数在 9 / 8 之间更新；最后一项滚动可达，完整详情可读，关闭后焦点回到触发项。长列表高度 240px、内容约 625px。浏览器无 error 日志。

本地验收入口为 `http://127.0.0.1:5190/`，由工作树 `.audit/capabilities/` 的隔离 harness 提供，模拟数据写入仅在内存。截图为该目录 `implemented.png`。这些本机产物不进发布包；真实 App 安装、真实 daemon 保存与最终 owner 产品验收尚未执行。

owner 的“采用建议”记录为设计选择，不伪称为对提交后真实 App 的验收通过。
