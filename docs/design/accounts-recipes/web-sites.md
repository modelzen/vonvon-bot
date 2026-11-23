# 社区、我的配方与登录

2026-11-16 本地验收反馈：交互参考 Dify Marketplace，保持 Vonvon 官网的白底、黑字与橙色操作色。后续 owner 确认以统一个人库替代独立创作者中心，App 和 Web 使用相同语义。

## 当前可部署形态

现有测试域名提供社区 `/`、个人配方库 `/library`、账号设置 `/account` 和独立登录页 `/login`。社区负责公共发现，每位登录用户都能使用「我的配方」，不要求成为创作者。

社区是独立站点体验，顶部品牌为「Vonvon 灵感社区」，Logo 和位置沿用官网；header 只保留发布入口与登录／真实账号菜单。我的配方只在登录后的账号菜单中提供。首页的 Bot 配方／Bot 租赁（敬请期待）与搜索位于同一吸顶行，详情不复用列表控件；主 header 与正文右对齐的章节目录分层吸顶，不遮挡锚点。

个人库按 recipeId 聚合线上版本，通过全部／已获取／创作中／我发布的筛选。「创作中」只展示本地保存的说明与打开 App 的按钮，不读取或写入云草稿、不伪造本机草稿列表。App 保留真实本地草稿。发布入口只进入 App 本地整理和预览，明确确认发布后才上传。既有云端遗留数据不盲删；本地保存和发布管道的边界由对应实现与回归另行验证，不能仅凭隐藏标签宣称成立。

旧 `/creators`、`/publications` 以及旧创作者站根路径均重定向到社区的 `/library?state=published`。新页面不加载独立创作者管理资产。详情的旧 `from=creator`／`from=published` 返回个人库的已发布筛选，`from=library` 返回已获取筛选。不会出现两套管理页面。

所有端使用同一 Supabase issuer 与用户 ID，昵称和头像仍由现有账号资料接口统一维护。没有新的创作者账号、作者署名、公开邮箱或资料复制表。

## 独立测试域名的配置方案

可将同一服务部署为不同站点实例，配置必须来自服务端受控环境：

| 变量 | 作用 |
| --- | --- |
| `RECIPE_SITE_KIND` | `community`（默认）或 `account` 决定根页面；旧 `creators` 根路径仅重定向个人库 |
| `RECIPE_WEB_ORIGIN` | 当前实例的精确公开 origin，绑定 Origin 校验与 OAuth 回调 |
| `RECIPE_COMMUNITY_ORIGIN` | 社区 origin；未配置时使用同域 `/` |
| `RECIPE_CREATORS_ORIGIN` | 兼容旧配置并保留严格 origin 校验，不再作为新导航目标 |
| `RECIPE_ACCOUNT_ORIGIN` | 账号站 origin；未配置时使用同域 `/account` |
| `RECIPE_DESKTOP_CHANNEL` | `preview` 或 `stable`，决定 App 协议链接 |

所有 origin 均不得带用户信息、路径、查询或片段；公网必须 HTTPS。独立账号实例应显式配置社区和账号 origin。统一个人库不再需要独立创作者站。本轮继续使用 `recipes-staging.vonvon.cc` 下的同域页面，未切换正式入口；`account-staging.vonvon.cc` 仍可作为后续账号域候选。

截至此次只读核对，早期规划的 creators/account 测试域名虽解析至腾讯云，尚无对应的精确 nginx vhost 与有效证书配置，不能报告为已上线。启用前需准备 vhost、TLS、隔离实例配置、健康检查和回滚记录；在同一个 Supabase 项目中追加各实例**精确**的 `/auth/callback` 与必要的 `/auth/native/callback`，不使用任意 redirect 或通配符。

身份统一不等于跨站共享浏览器会话。当前网站会话是 host-only HttpOnly cookie，各站通过同一 OAuth 身份登录；不扩展 cookie Domain，不在 URL 或站点间转移 access/refresh token。如将来需要集中单点登录，应单独设计受信任客户端与一次性授权码交换。本轮不开放跨域 returnTo。

跨站进入账号设置时，已读取的真实用户 ID 可放在 `#account=…` 中；账号页仍执行现有 expected-account 核对，避免编辑另一个已登录网站账号的资料。

## 登录和返回

普通入口进入完整登录页，本轮只显示 GitHub、Google；只有配置中实际启用的方式可发起登录，其他项禁用且如实提示。提供方选择仍 POST 到同源 `/auth/start`，沿用 Origin 校验、PKCE、短期 flow cookie 与过期／重放保护。GitHub、Google 保留 `prompt=select_account`。首次授权创建账号写成次级说明，入口按钮只叫「登录」。

原页返回采用白名单：根目录的有限搜索词、本人配方页、创作指引、兼容的旧创作者地址、账号页、作者页和精确版本详情。个人库只允许单一 `state=all|acquired|drafts|published` 参数；版本详情仅接受有限来源 token。不接受任意 URL、未知参数、重复参数、反斜线或片段。获取意图与账号核对边界保持不变。

登录页显示已有网站会话时，昵称／头像从带当前 display-session 的资料请求取得；点击「继续」前再次核对该账号。切换账号显示真实 OAuth 方式，不退出第三方网站。获取配方的待确认意图仍绑定精确版本和当前标签页 nonce，nonce 仅留在会话存储与 POST 字段，不进入 URL；登录本身不执行获取写入。

App 登录使用统一 `/login?mode=app` 页面及受绑定的原生登录流程（兼容旧 `/auth/native` 页面地址），保留强制协商的 `identity-v1` 确认能力，必须将本轮 App 与 Web 配套上线。PKCE verifier 留在 App，沿用 state、浏览器 cookie 与标签页绑定、短期回执和过期保护；旧 App 不具备此能力时拒绝流程并提示更新，不回退到自动接受账号。

官方 App 先在内存中兑换授权码并只读核对身份，再将临时凭证交给 native 流程的受控后端核验。后端向现有账号资料 API 独立确认 UUID，浏览器仅展示核验后的昵称、头像和用户 ID。用户明确点击「继续连接」后，官方 App 才执行账号接受与凭证保存；取消、切换或过期均不接受该账号。切换账号关闭旧流程并生成全新的 state、PKCE 与浏览器入口，不沿用旧授权结果。页面不会把 OAuth 回执当成已确认的账号。

此边界保证官方 App 的账号接受与持久化等待用户确认；授权码在该步骤之前已经由 App 兑换，不能声称服务器阻止任意修改过的客户端提前兑换授权码。临时 token 不进入浏览器、URL、截图或日志。已确认账号的 UUID 会在接受和保存前再次核对，异步保存超时或取消时清理本轮写入。

## 防滥用与 Cloudflare

当前测试站已有 nginx 对 `/auth/start` 的每 IP `10r/m`、burst `5` 限流，以及 Web 进程内最多 `32` 个突发、每秒补充 `1` 个的准入限制和 `1024` 个待登录流程上限。现有站点未接入 Turnstile；本次不展示模拟验证码或“验证成功”。

真实接入尚需 sitekey、服务器 secret、准确允许的站点主机名和 action 配置；这些值不进入仓库。后端必须在受保护的登录发起请求上调用 Siteverify，失败或超时不发起 OAuth，并核对 hostname/action；仅展示 widget 没有防护作用。原生登录入口也需单独确定覆盖策略，不把网站 gate 当成其已有防护。Cloudflare token 有时效且只可验证一次，重试必须重新取得。现有 CSP 只允许同源脚本／默认 frame 源，接入时还需按官方要求调整脚本与 frame 策略。不能假设托管 Supabase 的 OAuth 自动获得相同 CAPTCHA 保护。

参考：[Cloudflare 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[允许主机名](https://developers.cloudflare.com/turnstile/additional-configuration/hostname-management/)、[CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)、[Supabase CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha)。部署核对的详细凭据仅记录键是否存在，不记录秘密值。

## 本轮补充：版本与公开详情

私人库按 immutable recipeId 聚合，一张卡的默认版本来自 API 当前 scope 的最新已授权版本。选择器按需分页读取 metadata，以 nextCursor 决定后续页；根计数与首次打开版本页可能使用不同的当前快照，不据计数截断选项。固定版本 URL、精确 grant 与已安装指针不变。

公开详情的 direct/coded 使用相同安全 preview 结构；能力只展示允许公开的技能名称与说明，不新增规则分组，技能正文不因领取而拉取。正文对象只在真正交给 Bot 的准备步骤中按权益访问。Web 按钮使用 `recipes/{recipeId}/versions/{versionId}/handoff`；本地创作列表使用 `recipes/drafts`；两者均由部署渠道选择严格 scheme，App 仍核对权益并保留最终确认。

普通 Web 与 App 共用双栏 `/login` 模板。App 以 `mode=app` 和片段 ticket/receipt 回程，普通页保留严格 returnTo；两模式脚本隔离。当前只显示 GitHub、Google，未实际启用者禁用，不显示 Apple 或手机号。品牌展示图来自既有官网产品素材，没有新增无依据权益或付款承诺。
