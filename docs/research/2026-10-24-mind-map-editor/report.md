# 导图直接编辑与固定节点：组件选型

日期：2026-10-24。范围：用户要求调查现成组件，支持图中编辑，文件夹等结构节点保持固定。本轮没有安装组件、修改产品代码或运行组件验收。Vonvon 源码基线为本地验收分支 `a54ee419`，不代表远端最新 dev。

## 后续决定

owner 对比预览及本地飞书交互后，要求保持简单、减少包体、不增加新依赖。最终沿用自写 HTML/SVG，接入原生内联编辑、节点＋与悬停收拢，不引入下面候选库。实现范围和验证见 `docs/plans/memory-map-inline.md`。以下保留本轮最初的选型依据。

## 结论

建议先用 Mind Elixir 做一个接入验证。它提供完整导图编辑交互，通过操作前置回调按节点限制编辑、删除和移动。React Flow 是需要更高程度自定义 React 节点时的备选；SimpleMindMap 有相关能力，但开源库已明确进入低维护状态。

这是一项基于官方文档和源码的选型建议，尚未验证实际 Electron 中的中文输入、长文本、交互和服务端保存。

## 当前实现

- `packages/ui/src/MindMap.tsx`：自写 HTML 树和 SVG 连线，没有第三方导图库。`MapNode.content` 已允许替换为节点内编辑器。
- `packages/ui/src/MemoryMap.tsx`：普通记忆已有节点内 textarea 与保存/放弃；保存使用已有 memory edit 请求及 revision。
- `packages/ui/src/ProjectPage.tsx`：本群角色仍通过 `panel` 显示在导图下面。因此截图反映的角色编辑方式与记忆内容编辑并不一致。

仅统一角色节点的编辑位置，可以沿用现有组件；若要同时获得成熟导图的键盘操作、缩放和平移，接入现成导图库更有价值。

## 候选比较

| 候选 | 图中编辑和固定节点 | 需要补的部分 | 判断 |
| --- | --- | --- | --- |
| Mind Elixir | 内置节点编辑；`before` 按操作拦截，可按节点元数据限制 `beginEdit`、`setNodeTopic`、`removeNodes`、移动等 | React 生命周期封装、业务节点映射、API 保存及冲突处理、角色长文本体验 | 最接近直接接入的完整导图 |
| React Flow | 自定义 React 节点可放 input/textarea；逐节点设置 draggable、deletable、connectable | 树布局、折叠策略、导图快捷键、编辑与撤销逻辑 | 业务节点复杂时灵活，但不是现成完整导图编辑器 |
| SimpleMindMap | 内置编辑与多种布局；`beforeTextEdit` 返回非 true 可阻止指定节点编辑 | 删除、移动等另设限制；React 封装与保存 | 功能全面，但维护状态降低优先级 |

上游仓库元数据此次均标记 MIT；依赖引入时仍需保留其许可证文件。

## 对此页面建议的交互

以下是提案，并非已确定的产品规则：

- 结构节点（文件夹、固定分类、群和 Bot 等）：仍可选中和展开收起，不提供改名、删除、拖动入口；按需要保留“添加记忆”等合法操作。
- 内容节点：在原位置进入多行编辑，长文本使节点增高；提供保存、取消与保存失败反馈，中文输入期间不触发提交。
- 新增、编辑和移动沿用已有业务 API。图库 JSON 只作视图，不作为记忆和角色的独立存储。
- 继承内容维持现有只读含义；组件更换不隐含改变继承或权限。

“固定”需要逐项定义能力，不能只设置一个全局 readonly。编辑、删除、移动、粘贴以及删除含固定节点的父节点，都应遵守同一套节点能力规则。结构节点仍可展开，并可接收业务允许的新记忆。

Mind Elixir 的 `before` 由 `src/methods.ts` 的 `beforeHook` 包装公开节点操作；回调返回假值则操作不执行。节点操作源码确认包含 beginEdit、setNodeTopic、removeNodes 和移动操作。快捷键、多选、撤销及程序更新路径仍应在集成验证中检查；图库自带 undo 不能被当成已有服务端写操作的撤销。

## 接入验证重点

1. 同一图中内容节点能编辑，固定节点能展开收起但不能改名、删除或移动。
2. 角色长文本、中文输入、取消、保存失败、服务端 revision 冲突和定时刷新期间的草稿保留。
3. 快捷键、多选删除、粘贴、拖动及撤销不越过结构限制。
4. 现有菜单、来源提示、计数、选中和继承只读样式可保留；展开和视口状态不因保存而跳动。

## 官方来源与核实记录

- [Mind Elixir 操作与前置拦截](https://docs.mind-elixir.com/docs/guides/node-operation)：核对 operation 事件和 before 回调。
- [Mind Elixir 操作包装源码](https://github.com/SSShooter/mind-elixir-core/blob/HEAD/src/methods.ts)：核对 beforeHook 及操作包装。
- [Mind Elixir 节点操作源码](https://github.com/SSShooter/mind-elixir-core/blob/HEAD/src/nodeOperation.ts)：核对可拦截操作名称。
- [Mind Elixir 项目及许可证](https://github.com/SSShooter/mind-elixir-core)：仓库元数据 MIT，最近推送 2026-10-19。
- [SimpleMindMap 构造选项](https://wanglin2.github.io/mind-map-docs/en/api/constructor/constructor-options.html)：核对 beforeTextEdit。
- [SimpleMindMap 自定义内容限制](https://wanglin2.github.io/mind-map-docs/course/course20.html)：自定义整个节点内容后，内置双击编辑等能力不能直接沿用。
- [SimpleMindMap README](https://github.com/wanglin2/mind-map)：作者注明库和 Web 进入低维护状态，客户端和插件另行闭源开发维护；仓库元数据 MIT，最近推送 2026-08-02。
- [React Flow 官方导图教程](https://reactflow.dev/learn/tutorials/mind-map-app-with-react-flow)：核对自定义 input 节点与状态同步。
- [React Flow Node 属性](https://reactflow.dev/api-reference/types/node)：核对 draggable、deletable、connectable。
- [React Flow 布局说明](https://reactflow.dev/learn/layouting/layouting)：布局需自行集成适合的方案。
- [xyflow 仓库](https://github.com/xyflow/xyflow)：元数据 MIT，最近推送 2026-10-22。

来源通过 agent-reach 的 Exa 搜索与 GitHub CLI 查询，官方页面另经网页读取核对。没有使用下载量或星数决定选型，没有独立代理复核或运行时验证。上游 HEAD 链接会变化，正式接入时需固定包版本和源码版本。
