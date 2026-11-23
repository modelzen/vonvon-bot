# 配方社区网页

这个 Node 服务提供社区首页、固定版本的分享落地页、账号的「已获取」与「创作配方」说明。直接获取的配方允许访客查看完整配置。凭码版本在作者本人或该版本的领取者访问时展示完整配置。网页同时支持 role-v1 与 rich-v2，服务向同机 Recipe API 和私有成员 broker 请求真实数据。

要求 Node 22.12 或更高版本。先在仓库根目录执行 `npm ci`，安装共享 UI 和构建工具依赖，然后启动 [Recipe API](../recipe-api/README.md) 与 rich broker。在本目录执行：

```sh
npm ci
npm run build
npm start
```

`npm run build` 生成 `dist/viewer.mjs`、`dist/viewer.css` 与 `dist/rich-detail.mjs`。网页与 App 读取同一个 Recipe API 的账号权益和固定版本数据。网页使用独立的社区首页、导航与详情布局，沿用官网的白底、墨黑字和橙色品牌点缀；详情为可通过目录链接定位的长页面，桌面右侧提供作者、版本及获取入口，窄屏将获取入口放在正文前。配置文字和 Markdown 复用内容渲染器，页面布局与操作控件由 Web 自己实现。`npm start` 或 `node server.mjs` 直接运行这些产物，不在运行机器上构建或写入发布目录。开发时可用 `npm run dev` 先构建再启动。

部署包须保留 `server.mjs`、`auth.mjs`、`native-auth.mjs`、`oauth-provider.mjs`、`release-code-oauth.mjs`、`release-code-store.mjs`、`public/`、上述三个 `dist/` 文件、服务的 package 文件，以及 API 的 `src/credential-shapes.mjs`。构建只在有共享 UI 源码和根目录开发依赖的源码树运行；构建完成后，运行机器只需 `npm ci --omit=dev` 安装网页及账号服务的运行依赖，无需 React、esbuild、TypeScript 或 UI 源码。

开发入口为 `http://127.0.0.1:49151/`。服务监听本机端口。Web 到 API 的默认连接是 `http://127.0.0.1:4317`，到 broker 的默认连接是 `http://127.0.0.1:4318`。`RECIPE_API_ORIGIN` 和 `RECIPE_BROKER_ORIGIN` 只接受固定 loopback origin。若修改 `RECIPE_WEB_PORT`，相应设置 `RECIPE_WEB_ORIGIN`；从 Nginx 暴露时，后者必须等于浏览器实际打开的 HTTPS origin。

生产社区使用 `https://market.vonvon.bot`，登录及账号设置使用 `https://account.vonvon.bot`。共用 Web 服务的 `RECIPE_WEB_ORIGIN` 和 `RECIPE_COMMUNITY_ORIGIN` 设为社区 origin，`RECIPE_ACCOUNT_ORIGIN` 设为账号 origin。保持两个入口同站，以便账号页使用社区的 host-only 会话 cookie。Supabase 登记新旧社区 origin 下网页及 App 的精确回程。

旧 `community.vonvon.bot` 的普通网页链接直接跳转至新社区，并保留路径和查询参数。Worker 的 `RECIPE_LEGACY_WEB_ORIGIN` 保留该域名的机器 API、原生登录、账号链接票据和 OAuth 回程。原 `recipes.vonvon.cc` 已退役，固定使用该地址的客户端需要改用 Market。浏览器在新社区使用独立的 host-only 会话。

登录需设置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`，并在 Supabase 控制台给该环境登记精确回程 `<RECIPE_WEB_ORIGIN>/auth/callback`。测试和生产各用自己的应用配置。本轮 UI 仅提供 GitHub 与 Google，用 `RECIPE_WEB_PROVIDERS=github,google` 按该项目实际启用情况配置；缺少凭据的方式必须保持禁用。通用协议仍保留 Apple 的历史兼容，本轮不展示或接入。缺少配置时网页提供公开浏览，真实登录按钮会提示当前不可用。社交认证走 PKCE，浏览器持有 HttpOnly 会话 cookie。一次性票据与上游会话保存在服务进程内存，部署时仅运行一个实例。重启此服务后，用户需要再次登录。Nginx 对 `/auth/` 关闭带查询串的访问日志。

生产 Web 在 Cloudflare Workers 上使用 `worker.mjs`，`wrangler.jsonc` 是部署配置模板。使用 `npm run build:worker` 打包受路由表控制的静态资源。生产配置通过独立环境设置社区、账号及 Supabase origin，提供 `SUPABASE_PUBLISHABLE_KEY`，并绑定独立的 `RECIPE_API` 和 `RECIPE_BROKER` 服务。API 通过验证 TLS 的 Hyperdrive 连接现有生产 Supabase。私有附件 Worker 使用独立服务密钥 `RECIPE_BROKER_RELAY_SECRET` 访问现有生产站点的 HTTPS 附件入口，继续由原附件服务执行用户鉴权、存储校验和数据库会话锁。两个站点共享一个 SQLite Durable Object 保存限时的 PKCE、浏览器会话和 App 登录状态。SQLite 闹钟清理过期记录，凭据不进入资源包。测试环境使用隔离的 Supabase，两套环境均提供 GitHub 和 Google 登录。

浏览器在同一 origin 发起 `/api/v1/…` 和 `/api/v2/…` 请求。公开入口必须将两个前缀都交给这个 Web BFF，由它检查会话、Origin 和 CSRF 绑定，再转交 API。原生 App 的 `/v2/…` Bearer 请求继续路由到 API 或 broker；不能把浏览器的 `/api/v2/…` 直接转到它们。

公开详情固定到 URL 中的 recipeId 和 versionId，仅向 API 请求安全的 `/preview` 元数据，并固定发送 `X-Vonvon-Browse: public-v2` 能力头。直接获取与凭码获取展示相同的允许公开的结构；私有规则和技能正文不返回，领取后浏览详情也不因此下载 manifest、正文对象或附件。原始对象仍由现有权益校验保护，只在 App 真正交给 Bot 的准备步骤中按精确版本读取。网页不提供任意对象读取或安装接口。

个人库使用 `/v2/me/recipe-groups?scope=all|acquired|published`，按不可变 recipeId 一张卡；版本选择按需读取该配方权限范围内的版本分页，不将一个版本的分享码升级成整份配方权益。默认展示 API 指定的最新已授权版本，原固定版本链接与已安装版本不自动变化。版本页以 nextCursor 为后续页依据，初始卡片计数不是永久快照。

网站的「创作中」仅说明草稿保存在本地，并以严格渠道 URI 打开 App 本地创作列表，不读写云草稿。顶部「发布配方」只打开 App 本地创作；用户确认发布后才上传。既有云端遗留数据不盲删。网页的「在 App 中交给 Bot」携带精确 recipeId/versionId，App 重新核对账号与权益后打开 Bot 选择，并保留最终确认；点击链接不自动获取、安装或发送。

Web 与 App 共用独立 `/login` 页面：普通 Web 继续带白名单 returnTo，App 使用 `/login?mode=app#ticket=…`，回程使用绑定原 cookie/标签页的密封 receipt。旧 `/auth/native` 两个页面路径兼容渲染同一模板。App 模式使用 no-referrer，普通 OAuth 表单保留 same-origin；nonce、state、PKCE 与显式身份确认机制不变。


OAuth 回程会立即跳转到干净的原始版本页面，登录本身不会消耗分享码。

`npm test` 在隔离 HTTP 端口验证 PKCE 绑定、一次性回程、凭据转交、跨站写请求拒绝、退出登录。测试使用模拟 OAuth 服务；实际三家提供方的登录需要在专用测试项目验证。

`npm run typecheck` 检查共享详情渲染器的 Web 入口。`PG_BINDIR=<PostgreSQL bin> npm run test:rich` 创建临时数据库，应用真实迁移，启动实际 API、broker 和 BFF，再执行网页构建产物，验证完整页签、凭码隔离、错误码重试、已提交响应丢失、跨账号与旧版回归。对象存储使用临时磁盘文件，OAuth 使用合成账号。命令结束会关闭服务并清理临时数据库。

桌面 App 使用独立的 `/auth/native/flows` 中转，浏览器选择页为 `/auth/native`。该入口要求显式的 `sb_publishable_…` 公钥，并在 Supabase 另登记精确回程 `<RECIPE_WEB_ORIGIN>/auth/native/callback`。原有 `/auth/callback` 登记继续保留。缺少公钥或提供方配置时，原生中转返回不可用，不将秘密密钥或旧版 JWT 配置发送给 App。

原生 flow 的期限为五分钟，服务仅保存有界的进程内状态。原生端持有 PKCE verifier 和独立 Bearer 轮询凭据，浏览器只持有一次性启动票据、独立 HttpOnly cookie 及当前 tab 的随机绑定。回程先生成不透明 receipt，浏览器确认 tab 绑定后才允许原生取码。待取授权码以进程随机密钥加密，ACK、取消或过期后清除。用户明确确认连接时建立社区 BFF 浏览器会话，App 回执到达后浏览器跳转到账号设置。Web 服务重启会结束进行中的流程和现有网站会话。

网页登录和原生创建入口分别限制为最多 32 次突发请求，每秒恢复一次名额，避免单次匿名突发占满 flow 表。部署时还应由 Nginx 按可信代理解析的真实来源设置入口限流。应用内的全局预算不区分访客，不能阻止持续抢占额度影响其他用户。`Origin` 只用于浏览器同源检查，不能代表可信访客身份。

本地验证只使用合成 OAuth 服务。三家真实提供方、托管环境回程及 Windows 客户端仍需在专用环境验收，不能据此报告公开登录已上线。

运行 `node native-review.mjs` 可启动独立的浏览器流程验收环境，默认使用本机 49187 端口。打开它打印的一次性链接，选择任一提供方后，合成授权服务将浏览器送回干净完成页。该脚本只模拟原生轮询和确认，不创建账号、数据库、设备权限或真实上游会话，也不证明桌面 SDK 与三家提供方已经互通。按 Ctrl-C 关闭它创建的两个本地服务。
