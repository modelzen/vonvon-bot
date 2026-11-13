# 配方社区网页

这个 Node 服务提供社区首页、固定版本的分享落地页、账号的「已获取」与「创作中心」。公开配方允许访客查看角色配置。凭码版本在作者本人或该版本的领取者访问时展示配置。服务向同机 Recipe API 请求真实目录、草稿与版本数据。

要求 Node 22.12 或更高版本。先启动 [Recipe API](../recipe-api/README.md)，在本目录执行：

```sh
npm ci
npm start
```

开发入口为 `http://127.0.0.1:49151/`。服务监听本机端口。Web 进程和 API 进程之间的默认连接是 `http://127.0.0.1:4317`。可在测试时将 `RECIPE_API_ORIGIN` 设置为其他 loopback 端口。若修改 `RECIPE_WEB_PORT`，相应设置 `RECIPE_WEB_ORIGIN`；从 Nginx 暴露时，后者必须等于浏览器实际打开的 HTTPS origin。

登录需设置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`，并在 Supabase 控制台给该环境登记精确回程 `<RECIPE_WEB_ORIGIN>/auth/callback`。测试和生产各用自己的应用配置。用 `RECIPE_WEB_PROVIDERS=github,google,apple` 指定该项目实际启用的身份提供方。缺少配置时网页提供公开浏览，真实登录按钮会提示当前不可用。社交认证走 PKCE，浏览器持有 HttpOnly 会话 cookie。一次性票据与上游会话保存在服务进程内存，部署时仅运行一个实例。重启此服务后，用户需要再次登录。Nginx 对 `/auth/` 关闭带查询串的访问日志。

浏览器在同一 origin 发起所有 `/api/v1/…` 请求；公开入口应将这些请求交给这个 Web 服务，再由它将登录身份转交给 API。OAuth 回程会立即跳转到干净的原始版本页面，登录本身不会消耗分享码。草稿和发布操作同样经此服务。配方安装、飞书准备草稿、完整配置与头像上传在后续开发中接入。

`npm test` 在隔离 HTTP 端口验证 PKCE 绑定、一次性回程、凭据转交、跨站写请求拒绝、退出登录。测试使用模拟 OAuth 服务；实际三家提供方的登录需要在专用测试项目验证。
