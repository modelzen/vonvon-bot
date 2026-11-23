# 聊天反馈提交适配器

本模块供账号、配方联合候选集成，尚未注册为正式产品入口。

## 宿主接线

1. 用 `managedToolSelection(dataRoot, 'lark-cli')` 取得已安装工具路径。构造 `IsolatedFeedbackCli`，提供专用绝对根目录、当前 Bot 凭据的安全解析端口。凭据包括 appId、appSecret、registrationKey；不传到模型。
2. 构造 `FileFeedbackStore` → `NativeFeedbackGateway` → `FeedbackSubmissionService` → `FeedbackChatController`。目的 Base、表和后台表单分享 token 由本地明确配置；不能从模型参数或群消息覆盖。
3. `onMessage` 只处理 `/feedback` 命名空间，应在管理员专用私聊 gate **之前**调用，并保持 SDK 原始事件。其他聊天继续原流程。
4. 将 `feedback.prepare` 工具绑定本轮实际 SDK 消息，工具只接收摘要。附件从用户明确选择的本地文件引用解析，不能让模型任意读取本机路径。调用 controller.prepare 后向实际聊天发完整核对卡片。
5. 在该 Bot 的可信 SDK card dispatcher 注册 `feedback.submission`，调用 `onAction`。不能注册一个模型可调用的 confirm/yes API；不能从 HTTP/body 接受 actor。
6. 实现 `FeedbackChatIm`：普通回复、完整卡片，以及本人私聊的授权链接加二维码图片。群聊从不发送授权材料。授权链接在前，二维码在后；二维码只是展示，不把设备码返回模型。
7. shutdown 关闭 `IsolatedFeedbackCli` 并等待子进程退出。与正式 daemon、默认 lark-cli 登录和其他 Bot 的数据目录隔离。

`createFeedbackRecipe()` 返回经实际 rich-v2 codec 校验的可移植预览内容。setup 是普通技能，不能自动执行，不含宿主凭据或固定接收空间。管理员可在普通群配置反馈，领取的配方可供 Agent 参考；本函数本身不会发布配方。

## 实际权限和回执

需要当前本地 Bot 同一 app 的 USER 授权：`base:form:read`、`base:form:update`、`base:field:read`、`base:record:read`、`docs:document.media:upload`。核验 appId/openId/已验证身份和完整权限，不按显示名识别用户。

用户属于自己本地 Bot 的组织、目标 Base 属于维护者的另一组织，是待实测的正常路径。它与“使用另一个组织对外共享的 Bot”不同，后者不能据当前资料承诺取得外部 USER 授权。不要用 Bot 品牌 `tenant: feishu|lark` 代替组织 tenantKey。

`form-submit` 返回无 record ID。发送前把状态严格持久化，使用跟进编号与真实系统创建人查询回执。发送后出现未知结果，只查询，不再次发送。核对原生字段 ID/类型、目标表、唯一记录及官方记录链接后才报告成功。本地锁防同操作并发，不代表多设备全局幂等。

只有宿主提交前检查失败，或 CLI 明确证明 `form-submit` 子进程尚未启动，才持久化为 `not-submitted` 并允许整理新反馈。通用 CLI、网络或响应解析错误均不能证明记录未发出；子进程可能已启动时仍保持 `uncertain`，只查原操作，不重发。该状态只描述反馈记录，不承诺其他命令或附件上传从未发生。配置检查与外部提交并非原子操作。

已进入提交阶段的原卡片可由原本人在原聊天查询持久化的原目标，即使接收目标后来变化。物理卡片、群绑定代次、Bot 注册和本人授权仍须匹配；新摘要和首次提交仍必须通过当前配置检查。

Windows lark-cli 的固定 HKCU 凭据后端无法由 HOME 隔离，当前适配器明确拒绝 Windows。macOS/Linux 分别按有效 HOME 保存专用凭据。未通过真实双用户授权验收前，不宣称这一限制已解决。

## 验证范围

定向测试覆盖实际临时文件、跨进程锁、附件快照和限量读取、可信 SDK 身份、卡片完整展示、状态机、原生 CLI 合同、真实本地 stub 子进程生命周期。stub 与 fixture 证明本地行为，不证明真实飞书登录或云端权限。

上线前仍需联合验证：普通群配置接收目标、真人扫码授权、真实卡片确认、原生系统创建人为本人、唯一记录回链、网页继续补充评论，以及第二人隔离。

原生免费 Base 的本人删除/高级行权限受套餐额度限制；不能把所有人改为可编辑，也不能把 Bot 创建的记录当作真人创建。当前模块不实现网页删除或修改权限，也不承诺这些能力已验收。
