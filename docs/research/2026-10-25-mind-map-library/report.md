# 导图库替换与刷新开销

owner 反馈自写导图不流畅，明确允许引用库。本轮沿用 2026-10-24 已完成的选型，安装稳定版 Mind Elixir 5.15.1；不采用 npm latest 的 6.0.0-next.4 预发布。

- 固定源码：v5.15.1 / fb53ec7deb28cb7fe20f2db0428087e929a2952d。
- npm 包没有运行时依赖。esbuild 独立最小化测得 JS 91,998 bytes，gzip 29,564 bytes；CSS 12,441 bytes。App 实际增量以最终构建为准。
- MIT 声明从固定 tag 的 LICENSE 保留到 UI public/THIRD-PARTY-NOTICES.txt，随网页和 App 分发。
- 旧实现18个可见节点，闲置10.7秒、数据不变的一轮轮询，重新创建6个 ResizeObserver、40次 observe。测量是在隔离演示 Bot 的真实页面注入计数器得到；不是推算帧率。
- 自写 Links 在 children 对象每次更新时重新挂观察器，同步读取每个子节点的布局；树高变化会垂直重排整个父树。另无原生画布平移/缩放。
- 新 renderer 让 Mind Elixir 管理布局、连线和平移缩放；React 继续负责业务节点、权限与保存。不能让图库直接写入另一套数据或绕过 revision 校验。
- 无变化的记忆/继承轮询须保留 React 引用；结构变化保留编辑器 DOM 与视口锚点；测量合并到 animation frame。

来源：Mind Elixir 官方 v5.15.1 npm 发布包、GitHub tag/源码和 LICENSE，经 agent-reach GitHub CLI 路由核对。

https://github.com/SSShooter/mind-elixir-core/tree/v5.15.1
https://docs.mind-elixir.com/docs/guides/node-operation

## 接入后的本地测量

隔离演示 Bot 含44条有效记忆、画布挂载52个节点。布局稳定后闲置39.8秒（约5个轮询周期），新建 ResizeObserver=0、observe调用=0、导图 DOM mutation=0。旧版基线为18节点、10.7秒、6个新观察器/40次observe；两次节点规模不同，以上用于检查闲置刷新是否重建布局，不宣称帧率提升倍数。

画布空白拖动(-100,-50)的实际节点位移为(-100,-50) CSS px；Ctrl+wheel使图库scale到1.1。收拢大分支时根节点位置差为0px、DOM身份保留，无重复slots。文字输入与保存仍在库节点内，未出现图外对话框。构建、最终包体与 App 验收证据保存在本机 review 目录。

最终交互复查：收拢被点击分支的位置差 <0.01px；回到起点恢复 scale=1 与根节点位置；固定分类按 Delete 保留；新增记忆直接出现图内输入节点并保存。光标编辑时 Delete 只删除一个字，提交回到节点选择后 Delete 才归档整条，归档计数增加且图外 dialog 数为0。UI 全量60文件/539测试、类型检查通过。
