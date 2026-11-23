# 配方社区网页

这个 Node 服务提供社区首页、固定版本的分享落地页、账号的「已获取」与「创作中心」。直接获取的配方允许访客查看完整配置。凭码版本在作者本人或该版本的领取者访问时展示完整配置。网页同时支持 role-v1 与 rich-v2，服务向同机 Recipe API 和私有成员 broker 请求真实数据。

要求 Node 22.12 或更高版本。先在仓库根目录执行 `npm ci`，安装共享 UI 和构建工具依赖，然后启动 [Recipe API](../recipe-api/README.md) 与 rich broker。在本目录执行：

```sh
npm ci
npm run build
npm start
```

`npm run build` 生成 `dist/viewer.mjs`、`dist/viewer.css` 与 `dist/rich-detail.mjs`。详情页复用 App 的 `RecipeDetails`、`RichConfiguration`、`BackButton` 和 `GlowButton`。`npm start` 或 `node server.mjs` 直接运行这些产物，不在运行机器上构建或写入发布目录。开发时可用 `npm run dev` 先构建再启动。

部署包须保留 `server.mjs`、`auth.mjs`、`native-auth.mjs`、`public/`、上述三个 `dist/` 文件、服务的 package 文件，以及 API 的 `src/credential-shapes.mjs`。构建只在有共享 UI 源码和根目录开发依赖的源码树运行；构建完成后，运行机器只需 `npm ci --omit=dev` 安装网页 Markdown 依赖，无需 React、esbuild、TypeScript 或 UI 源码。

开发入口为 `http://127.0.0.1:49151/`。服务监听本机端口。Web 到 API 的默认连接是 `http://127.0.0.1:4317`，到 broker 的默认连接是 `http://127.0.0.1:4318`。`RECIPE_API_ORIGIN` 和 `RECIPE_BROKER_ORIGIN` 只接受固定 loopback origin。若修改 `RECIPE_WEB_PORT`，相应设置 `RECIPE_WEB_ORIGIN`；从 Nginx 暴露时，后者必须等于浏览器实际打开的 HTTPS origin。

登录需设置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`，并在 Supabase 控制台给该环境登记精确回程 `<RECIPE_WEB_ORIGIN>/auth/callback`。测试和生产各用自己的应用配置。用 `RECIPE_WEB_PROVIDERS=github,google,apple` 指定该项目实际启用的身份提供方。缺少配置时网页提供公开浏览，真实登录按钮会提示当前不可用。社交认证走 PKCE，浏览器持有 HttpOnly 会话 cookie。一次性票据与上游会话保存在服务进程内存，部署时仅运行一个实例。重启此服务后，用户需要再次登录。Nginx 对 `/auth/` 关闭带查询串的访问日志。

浏览器在同一 origin 发起 `/api/v1/…` 和 `/api/v2/…` 请求。公开入口必须将两个前缀都交给这个 Web BFF，由它检查会话、Origin 和 CSRF 绑定，再转交 API。原生 App 的 `/v2/…` Bearer 请求继续路由到 API 或 broker；不能把浏览器的 `/api/v2/…` 直接转到它们。

rich 详情固定到 URL 中的 recipeId 和 versionId。BFF 验证 canonical manifest、release 哈希、被引用成员的大小与哈希，并只向浏览器返回已校验内容、解析后的文字及归一化 WebP Logo。凭码概览只读取公共 Logo，不请求 manifest 或私有成员。浏览器没有任意对象读取或本机安装接口。网页领取只把权益保存到当前账号，用户在 App 登录同一账号后添加到群聊。网页创作中心无需登录即可查看 App 创作步骤，不提供手动编辑或发布入口。配方从本地 Bot 和已有群聊的配置开始，在飞书私聊中整理，再回 App 核对发布；草稿、已发布版本和分享码也在 App 中管理。旧草稿链接仍进入这份说明，云端内容保留，后端 owner API 兼容保持不变。

OAuth 回程会立即跳转到干净的原始版本页面，登录本身不会消耗分享码。

`npm test` 在隔离 HTTP 端口验证 PKCE 绑定、一次性回程、凭据转交、跨站写请求拒绝、退出登录。测试使用模拟 OAuth 服务；实际三家提供方的登录需要在专用测试项目验证。

`npm run typecheck` 检查共享详情渲染器的 Web 入口。`PG_BINDIR=<PostgreSQL bin> npm run test:rich` 创建临时数据库，应用真实迁移，启动实际 API、broker 和 BFF，再执行网页构建产物，验证完整页签、凭码隔离、错误码重试、已提交响应丢失、跨账号与旧版回归。对象存储使用临时磁盘文件，OAuth 使用合成账号。命令结束会关闭服务并清理临时数据库。

桌面 App 使用独立的 `/auth/native/flows` 中转，浏览器选择页为 `/auth/native`。该入口要求显式的 `sb_publishable_…` 公钥，并在 Supabase 另登记精确回程 `<RECIPE_WEB_ORIGIN>/auth/native/callback`。原有 `/auth/callback` 登记继续保留。缺少公钥或提供方配置时，原生中转返回不可用，不将秘密密钥或旧版 JWT 配置发送给 App。

原生 flow 的期限为五分钟，服务仅保存有界的进程内状态。原生端持有 PKCE verifier 和独立 Bearer 轮询凭据，浏览器只持有一次性启动票据、独立 HttpOnly cookie 及当前 tab 的随机绑定。回程先生成不透明 receipt，浏览器确认 tab 绑定后才允许原生取码。待取授权码以进程随机密钥加密，ACK、取消或过期后清除。此过程不会创建社区 BFF 会话；服务重启后原生端重新登录。

网页登录和原生创建入口分别限制为最多 32 次突发请求，每秒恢复一次名额，避免单次匿名突发占满 flow 表。部署时还应由 Nginx 按可信代理解析的真实来源设置入口限流。应用内的全局预算不区分访客，不能阻止持续抢占额度影响其他用户。`Origin` 只用于浏览器同源检查，不能代表可信访客身份。

本地验证只使用合成 OAuth 服务。三家真实提供方、托管环境回程及 Windows 客户端仍需在专用环境验收，不能据此报告公开登录已上线。

运行 `node native-review.mjs` 可启动独立的浏览器流程验收环境，默认使用本机 49187 端口。打开它打印的一次性链接，选择任一提供方后，合成授权服务将浏览器送回干净完成页。该脚本只模拟原生轮询和确认，不创建账号、数据库、设备权限或真实上游会话，也不证明桌面 SDK 与三家提供方已经互通。按 Ctrl-C 关闭它创建的两个本地服务。
