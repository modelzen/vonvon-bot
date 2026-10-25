# Libraries.dev 在当前界面的后续适用位置

2026-10-26。owner 认可 Gooey 主导航后询问还有哪些组件适合优化。仅提供建议，本轮未修改产品代码或安装依赖。

基线：远端 dev `16c7de56d04d971ac1ca0d6af3dbd9e1dff4a911`，本机另含已验收、尚未推送的导航提交 `181584a83944d43ade5244a7b1e29692eaee4207`。已先复用 [2026-10-24 公共组件调研](../2026-10-24-designeer-ui-ux/component-foundation.md)，再核对现有源码和官网；早期“没有合适的 Beam / Gooey 入口”的结论已被本轮之前的按钮、导航工作取代。

## 建议

1. **Gooey：详情页标签导航。** `packages/ui/src/GroupWorkspace.tsx` 的“模型与权限 / 能力 / 沟通方式 / 记忆”，以及 `packages/ui/src/App.tsx` 的“群聊 / 记忆 / 设置”，仍是静态选中背景。可复用主导航已经验收的白色滑块和有效物理参数，按各项实际宽度定位；仅鼠标切换时移动，键盘和减少动态效果即时切换。保留草稿离开保护及原有路由。不要顺手改变设置表单中的 radio 选择语义。
2. **Thinking Orbs：任务及长等待状态。** `OperationActivity.tsx` 已提供浅色 20px Orb、两秒延迟和文字状态，现被 App 与 GroupWorkspace 的 Bot / 群启停使用。当前 `ConversationPanel.tsx` 的运行状态是普通圆点，不再使用早期调研中的 Orb，可恢复复用；`RegistrationDialog.tsx` 的注册 / 凭据刷新和 Provider 连接等待也可按真实状态采用 connecting。任务用 working，完成即移除；未知的任务细分阶段不能伪装为 searching / solving。已知进度继续用进度条，短于两秒不闪烁显示。
3. **Border Beam：全局搜索框，低优先级。** `SearchDialog.tsx` 的搜索为本地同步 `findEntries`，没有真实请求等待，不能加“搜索中”的循环扫光。若需要与核心入口形成视觉呼应，可仅在输入区底部使用很淡的静态内光，键盘打开和输入保持即时。避免把所有搜索、下拉和设置输入框都发光。

建议先做前两项，再决定是否需要搜索框的装饰。

## 暂不采用

- Bot Avatars 会改变身份呈现；2026-10-24 的 owner 决定是保留飞书头像。现有 AgentAvatar 继续显示飞书头像及普通缺省图标。
- Liquid Metal 不作为日常设置、导航和小按钮的默认材质；当前没有需要它的新营销入口。
- Voice 和 Image 应等待真实录音 / 音频可视化、图片生成界面。当前语音转文字开关不是实时收音界面。
- 新增的 Magnetic UI 是基于手机磁力计及真实磁铁的输入模型，不是普通鼠标磁吸 hover；当前桌面管理界面不适用。

## 核实来源

官网页面于本轮重新读取，产品适用性为结合源码的设计判断：

- [Thinking Orbs](https://libraries.dev/orbs)：内联尺寸、工作与连接等状态。
- [Gooey](https://libraries.dev/gooey)：Move / Morph 等形变效果。
- [Border Beam](https://libraries.dev/beam)：light 主题、强度及 active 暂停控制。
- [Bot Avatars](https://libraries.dev/bots)：独立动画形象与工作 / 休眠状态。
- [Liquid Metal](https://libraries.dev/metal)、[Voice](https://libraries.dev/voice)、[Image](https://libraries.dev/image)。
- [Magnetic UI](https://libraries.dev/magnetic)：手机磁力计输入，Web 依赖 Android Bridge。

这是一份界面建议记录，不是已实施或已验收的产品变更。未运行真实 Bot / 飞书操作，未做新一轮独立模型核实。
