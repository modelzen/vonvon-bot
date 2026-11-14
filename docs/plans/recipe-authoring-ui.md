# App 聊天草稿与群分享

## 1. 做什么

从创作中心选择当前设备的现有 Bot 与已绑定群，在 App 核对来源，再由 Bot 向验证过的本人私聊发送草稿卡。App 显示真实投递、候选、同步与原草稿回执。群设置新增分享页，固定当前 Bot 与群。

## 2. 范围

只接入现有 typed recipeAuthoring bridge 与文字角色/setup。沿用私人草稿编辑器及发布二次确认。完整 manifest、自然语言模型扩展、真实 GitHub 登录不属于本片。

## 3. 现在的代码

CommunityPage 管理公开目录、作者工作区与 RecipeEditor。GroupWorkspace 管理每个群内 Bot 的设置导航。DesktopRoot 提供账号、设备及 typed shell。recipe-authoring 协议已经提供 handle、首次私聊关联、来源审核、操作和云回执。

## 4. 怎么改

新增独立 authoring 页面和流程组件。数据结构以 typed session handle、challenge、source review、operation 为界。页面离开时 detach 旧 handle，迟到且无人使用的 open 要 close。Main 单独检查原账号和设备的连接代次。点击「暂停聊天编辑」时才显式 close；普通页面跳转后，已开始的操作仍可在飞书继续。UI 不接触 JWT、设备 nonce 或票据。首次关联只显示 short code，在收到真实候选后显式核对 openId、租户与私聊再 confirm。来源 reviewToken 只在本轮明确 sourceAttested 后 prepare。等待期间前台退避查询，后台心跳仍归 main。候选只 inspect，不提供跳过飞书确认的 accept 按钮。取消处理中不显示已取消。

云 accepted 使用原 draftId，聊天编辑复用同一编辑器。收到新修订时保留 dirty 输入并提供读取/核对，不覆盖本地缓冲。群分享只显示本来源关联操作和有确切来源关系的版本；其他作者已装作品仅分享原链接。公开详情不含作者管理。

## 5. 测试

通过 production DesktopRoot、createDesktopFacades 和协议 schema 驱动选择群、首次关联、错人重试、来源核对、等待/候选/同稿回执、取消、失败恢复；账户 A/B/A 和设备 A/B/A 都必须 close 旧 handle，新结果不能恢复旧上下文。草稿聊天更新保留 dirty 输入，旧修订冲突真实显示。公开配方不显示作者管理。

## 6. Codex 的自测

Mac 仅运行隔离 synthetic UI tests、typecheck、build。root 独占实际浏览器和完整 API/daemon 联调；本片不发真实飞书消息，不启动默认数据目录，不操作 owner 应用。

## 7. 文档

本片实现 docs/design/accounts-recipes/{prd,chat-drafts,runtime,authoring-operations}.md 的文字角色首片，无新产品默认值。未完成的完整 manifest 不呈现假详情。

## 8. 验收要点

来源设备、Bot、群明确；本人关联显式确认；仅云回执表示已保存；已保存稿关闭不删除；账户/设备切换隐藏旧私有状态；取消请求和完成结果准确；无私密票据进入 renderer；diff 无真实 id、密钥或本机用户数据路径。

## 9. 风险和行数

约 1,100 行，按 authoring 生命周期、Community/Editor、Group Share 和 strict UI tests 审查。主要风险为迟到响应、账户设备切换和 dirty 草稿的跨端修订，均有边界测试。真实浏览器与飞书验收由 root 汇总。

## 10. 草稿同步修复

独立审查复现了两项问题。飞书修订 2 的读取迟到时，编辑器可能已保留本地输入并保存为修订 3，但旧响应仍把页面退回修订 2。私人草稿默认只读页也没有显示这次读取的失败，用户只看见云端保存回执和旧内容。

编辑器使用一份 reducer 状态保存当前草稿、输入缓冲代次、读取请求、冲突核对及发布确认。读取开始时绑定 draftId、当前草稿修订、输入缓冲代次和递增请求号。响应只处理仍为当前请求且基线未变化的结果。期间产生的输入保留在原 DOM；新稿只进入核对。保存或核对推进基线后，旧响应和旧错误不再改变新修订及发布确认。保存回执丢失仍先重试原请求键，再基于回执修订保存后续输入。

只读页和编辑页共用同步提示。读取慢或失败时保留旧稿，并标出当前显示修订和云端回执修订。失败提供“重新读取新修订”，始终读取同一个 draftId。编辑页存在输入时，恢复读取仍需明确核对，不替换缓冲。

正式回归先复现两项失败，再验证迟到成功和失败、交错读取、读取慢期间输入、低于回执的响应、失败后同稿重试，以及路由切换和账号 A/B/A 后的旧 onSaved。发布确认保留新修订，旧回调不能读取已离开的私人稿。幂等保存回归迁到真实 React、DesktopRoot 和严格 facade schema，避免模拟 Hook 的用例依赖编辑器内部实现。
