# App 聊天草稿与群分享

## 1. 做什么

从创作中心选择当前设备的现有 Bot 与已绑定群，在 App 核对来源，再由 Bot 向验证过的本人私聊发送草稿卡。App 显示真实投递、候选、同步与原草稿回执。群设置新增分享页，固定当前 Bot 与群。

## 2. 范围

只接入现有 typed recipeAuthoring bridge 与文字角色/setup。沿用私人草稿编辑器及发布二次确认。完整 manifest、自然语言模型扩展、真实 GitHub 登录不属于本片。

## 3. 现在的代码

CommunityPage 管理公开目录、作者工作区与 RecipeEditor。GroupWorkspace 管理每个群内 Bot 的设置导航。DesktopRoot 提供账号、设备及 typed shell。recipe-authoring 协议已经提供 handle、首次私聊关联、来源审核、操作和云回执。

## 4. 怎么改

新增独立 authoring 页面和流程组件。数据结构以 typed session handle、challenge、source review、operation 为界。每次账户、设备或 Bot 改变都销毁旧流程并 close 旧 handle；迟到 open 也必须关闭。UI 不接触 JWT、设备 nonce 或票据。首次关联只显示 short code，在收到真实候选后显式核对 openId、租户与私聊再 confirm。来源 reviewToken 只在本轮明确 sourceAttested 后 prepare。等待期间前台退避查询，后台心跳仍归 main。候选只 inspect，不提供跳过飞书确认的 accept 按钮。取消处理中不显示已取消。

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
