# 原生账号登录与网页回程

## 做什么

用户点「登录」后，系统浏览器打开提供方选择页。完成授权回到 App 时，账号设置显示本人身份；退出或取消不会改变已配对设备。依据是 [账号设计](../design/accounts-recipes/cloud.md)第 2 节及本轮 owner 的网页跳转决定。计划、实现和审查现均由 Codex 执行，沿用仓库分片、独立审查及集成分支规则。

## 范围

本片实现网页原生登录中转、桌面主进程会话、安全存储和账号 IPC。社区原有网页登录继续使用独立 BFF 会话。设备远控授权、飞书身份挑战及配方安装分别由后续片实现，不能借登录自动开通。账号状态属于当前 App，不属于正在查看的远端设备。

## 现在的代码

基线为 `151a05b1`。网页 `createLogin` 只提供浏览器自身的 PKCE。原生壳在 `main.ts:startDesktop` 建立 `electronSecretBox`，`installBridge` 已校验受信文档、调用参数及事件订阅。`createDesktopFacades` 暴露主进程操作。`DeviceSwitcher` 已有添加和管理设备，必须保留原动作。`DesktopRoot` 的设备 gate 会重挂载 App，主进程会话不能随它重建。

## 怎么改

两个独立方案均选择原生端持有 verifier。网页代换票虽能减少交接，但改变既定凭据所有权；原生端直接放三个提供方按钮会改变既定网页选择入口。本片保留网页选择，使用有界轮询，不增加常驻消息服务。

### 网页中转合同

原生路由只接受 JSON、无 Origin 且无 Cookie 的请求。除创建外均验证独立 256 位 Bearer 轮询凭据，不复用网页 cookie 或 API token。请求及响应禁止缓存，错误不回显凭据。状态为 issued、choosing、selected、authorized、ready、acknowledged；cancelled、expired、failed 为终态。每次操作均核对五分钟期限；有界内存表在服务重启后失效，客户端重新登录。

| 方法与路径 | 输入与输出 |
| --- | --- |
| POST `/auth/native/flows` | `{state}`，state 为原生端随机 32 字节 base64url。返回 `{flowId,launchUrl,pollToken,expiresAt,supabaseUrl,publishableKey}`。launchUrl 为配置站点 `/auth/native#ticket=…`。 |
| GET `/auth/native/flows/:id` | Bearer pollToken。返回 `{status,state,expiresAt,provider?,code?}`。status 取 waiting、provider、code、completed、cancelled、expired、failed。完成兑换前允许取回同一授权码。 |
| PUT `/auth/native/flows/:id/authorize` | Bearer pollToken，`{url}`。只接受选定提供方、配置 Supabase origin 和 `/auth/v1/authorize`、精确 `/auth/native/callback` 回程，以及唯一的 provider、redirect_to、code_challenge、code_challenge_method。S256 challenge 须为规范的 32 字节 base64url。相同重试幂等，变更拒绝。 |
| POST `/auth/native/flows/:id/ack` | Bearer pollToken，空 JSON。兑换并安全保存后确认，抹掉授权码；重复确认返回 completed。 |
| DELETE `/auth/native/flows/:id` | Bearer pollToken，取消并删除可用票据及授权码；重复取消返回 cancelled。 |

浏览器用 fragment 一次性票据换独立 HttpOnly、SameSite=Lax cookie，随即清除地址栏 fragment；HTTPS 使用 Secure。首方脚本在 sessionStorage 保存每个 tab 的随机 binding。选择页提交 provider，等待已验证 authorize URL 后跳转。所有浏览器修改要求同源 Origin、cookie 和 tab binding。提供方一旦选定不能偷偷改选。

回程只接收授权码。服务临时加密保存，并返回只含不透明 receipt 的首方完成页，立即将地址替换为固定干净路径。完成页提交 receipt 和原 tab binding 才能使对应 flow ready。这样取消 A 后在另一 tab 发起 B，迟到的 A 回程不能用当前 B 的 cookie 覆盖 B。浏览器永远拿不到 pollToken、verifier 或会话令牌。不得把 native 回程降级成普通 BFF 登录。

### 原生端合同

本片的 `/auth/native/flows` 是独立 Web 中转的内部合同。账号设计中的 `/v1/auth/desktop-flows` 是早期拟议命名，后续统一为本计划路径，双方不能同时支持两个消费者。创建请求可附仅含不透明 ID 的 pendingActionRef，登录不会执行待办。

使用固定版本的 Supabase Auth SDK 生成一次 authorize URL 和一次换票。每次尝试持有独立内存 SDK storage，关闭 URL 自动换票和自动刷新，启用 PKCE。提供方来自受认证 flow 的轮询结果。原生主进程校验 state 和当前登录代次，调用 exchangeCodeForSession 后从可信身份服务验证本人信息；保存成功才 ACK。换票结果未知且没有有效本机会话时重新登录，不盲目重兑一次性码。

`AccountStatus` 是带判别字段的安全视图，包含 signedOut、signingIn、signedIn、unavailable，以及 signedIn 的稳定账号 ID、公开显示名、可选头像和当前提供方。UI 不接收原始 SDK session、refresh/access token、verifier、pollToken 或任意跳转 URL。登录代次用于拒绝退出或切号前的迟到结果。

主进程是刷新令牌唯一持有人。复用 SecretBox，以独立账号文件原子写入加密会话；安全存储不可用或拒绝时只留内存，不回退明文，不修改 devices.json。登录、刷新、退出和关闭串行协调；退出清除本端材料并使未完成工作失效。公开身份由可信服务返回，不从未验证 JWT 或邮箱推断所有权。独立业务账号 ID 由账号 API 按已验证的 issuer 和 subject 映射。原生端换票后用同一 access token 请求固定 API 的 GET `/v1/me`，读取 `{accountId}`，不把 Supabase subject 或邮箱当业务 ID。既有草稿和授权的 owner ID 在迁移中保留，新身份由映射表确定业务 ID。公开姓名和头像可从 SDK 的可信 getUser 结果取值，不能用于授权。

账号 facade 提供 status、login、cancelLogin、logout、订阅状态；供后续社区访问的带身份 HTTP 操作留在主进程，不暴露取 token 的 renderer API。主进程仅打开部署配置生成的受信 HTTPS 登录地址，不放宽 renderer 的通用 openExternal。没有部署配置时显示不可用的可恢复状态。本地回环只用于显式开发配置。

## 测试

- 主进程生成的真实 SDK authorize URL 被中转接受，其他 origin、路径、回调、重复或额外参数均拒绝。
- 错 pollToken、重放 launch ticket、跨网页 cookie、跨 tab、A 取消后迟到回程均不能取码或改变 B。
- 同一取码与 ACK 丢回执可重试；过期或取消后旧回程不能复活。
- 原生端单活动尝试、网络恢复、换票未知结果、退出与刷新并发、密钥串拒绝、持久化失败和重启恢复均有确定状态。
- 不向 UI、日志、配方或 URL 泄露会话凭据。原来的网页登录、设备切换、添加和管理流程保持可用。

## Codex 自测

Mac 上使用隔离数据目录、临时 HTTPS/回环上游与合成账号跑集成。此片不向真实飞书发送消息。网页使用浏览器控制操作提供方页，桌面壳返回及安全存储单独验。三家真实 OAuth 及 Windows 回程须在专用托管环境另验；模拟服务成功不能算真实提供方已通过。

## 文档

在账号设计、部署和验证文档标记本片实际能力及真实环境待验项。设计不因模拟登录通过而写成已公开上线。

## 验收要点

逐项核对上述失败与恢复路径、原生和网页登录隔离、无明文降级、无设备权限扩张。diff 不得包含真实用户 ID、密钥、本机绝对路径或私聊数据。

## 风险和行数

预计网页中转与测试约 800 行，原生会话、IPC 与测试约 1,200 行。分别由不同模型独立审查，在集成分支汇总后一次运行所需 CI。公共协议和桌面运行改动需检查三个平台。原生 UI 单独成片，继续复用现有设备菜单与群入口。
