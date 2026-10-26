# 判断规则编辑窗口高度

2026-10-24，基于 dev `8a7dabe1a9e8c7491890284884bdc984d2eeb01c`。

## Owner 需求与边界

Owner 认为直接展示可编辑规则是产品特色，否决默认隐藏正文。最终选择正文常显的短编辑窗口、框内滚动，以及编辑框下沿居中的“展开全部规则 / 收起规则”。在查看该隔离预览后回复“ok”，授权当前实现。此认可针对设计预览；实际产品组件的最终本地验收和合入尚待完成。

## 实现

- 默认编辑区高 260px，600px 以下为 240px；正文、小标题、删除标题、恢复默认与原保存路径保留。
- 下沿 34px 底栏使用细分隔线和上下箭头。展开恢复全文高度，收起只改变显示高度，不卸载编辑 DOM。
- 展开状态由群设置页持有，Editor 保存、放弃或恢复默认导致子编辑器重建时不会意外收起。切换 Bot / 群的原有 loader key 仍隔离状态。
- 只读时仍可展开、滚动阅读；正文修改与标题删除仍由原 disabled 条件控制。
- 收起后仅在底栏按钮仍拥有焦点时保持其可见，不移动编辑光标、不额外添加动画或组件库。

## 验证

- protocol、client 构建；UI typecheck、UI build 通过。
- 既有 `smart-rules-editor.test.tsx`、`group-design-settings.test.tsx` 共 15 项通过。仅为既有直接组件测试补齐受控高度参数，未增加镜像实现的测试。
- 同任务子代理完成只读静态自审，没有发现有依据的问题；这不冒充 owner 的实际实现验收或另一模型的独立合入审核。
- 独立验收页直接导入本分支的实际 AppShell、GroupSettingsContent、SmartRulesEditor 与样式；使用模拟数据和内存 client，不连接真实 daemon，不改 owner 配置。
- 浏览器正常窗口内发送滚轮事件：内部编辑区 scrollTop 从 0 到 371.5，外层页面 scrollTop 保持 269。大尺寸模拟视口下、落在真实 WebView 外的输入事件没有产生滚动，改在正常视口中完成验证。
- 默认 260px，展开后示例正文高 631px；编辑并保存后仍展开，正文与保存内容一致；恢复默认并保存仍展开；收起后回到 260px 且焦点留在底栏。
- 只读示例 contentEditable=false，底栏保持可用；键盘 Enter 展开与收起通过。560px 模拟视口（实际 clientWidth 550）下编辑区为 240px，document scrollWidth 与 clientWidth 相同，没有横向溢出。
- 浏览器 error 日志为空。未声称完成真实飞书、持久化服务或 Electron 原生窗口验收；本次没有安装或替换 App。

## 本地验收产物

研究工作树 `ui-ux-research/vonvon-bot/prototypes/vonvon-group-redesign/` 保存实际组件的隔离 bundle、源码 harness 和截图；由 5188 服务提供 `communication-implemented/`。它不进入产品包。此目录与本次实现工作树分开保存，归档实现工作树后仍可查看。
