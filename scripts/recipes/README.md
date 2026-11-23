# 配方服务开发验收

从仓库根目录运行，使用 Node 22.12+ 和本机 PostgreSQL 15+ 的 `initdb`、`pg_ctl`、`psql`。当前用户必须能初始化临时数据库；不要以 root 运行。脚本只创建临时 Unix socket、临时数据库和本地签名密钥，在退出时关闭并清理。无需 Supabase 组织权限或第三方身份，无线上请求。

```sh
npm ci --prefix services/recipe-api
npm ci --prefix services/recipe-web
npm test --prefix services/recipe-api
npm test --prefix services/recipe-web
node scripts/recipes/check.mjs
```

多版本 PostgreSQL 可用 `PG_BINDIR` 指定二进制目录，例如 Homebrew 的 `$(brew --prefix postgresql@15)/bin`。测试使用本片全部 migrations、非管理数据库登录和临时 JWKS 发行方，通过 HTTP 创建及发布需码配方，以另一个账号兑换，验证旧版不被新版解锁、失败的旧发布确认不产生版本。独立数据库覆盖权限和事务，真实 Supabase、第三方登录、飞书和设备仍需在 staging 验收。

本机社区试用入口会创建一套新的临时数据库，读取 [Vonvon 帮助配方](../../content/recipes/vonvon-help/recipe.json)，以作者身份通过草稿和发布 API 创建第一个公开版本。首页起初只有这份配方。普通数据库验收使用的晨报、分享码和领取记录留在各自的临时测试库。

```sh
node scripts/recipes/check.mjs --review
```

打开输出的本地地址，选择 GitHub 使用合成作者身份，选择 Google 或 Apple 使用领取者身份。登录后可以获取配方、查看账号库，也可以创建自己的草稿。按 Ctrl-C 会关闭服务并清理该次试用数据。已有窗口正在试用时，另开一个端口即可同时保留两套互相独立的试用环境，例如 `RECIPE_REVIEW_PORT=49185 node scripts/recipes/check.mjs --review`。

要走一遍自动化网页验收，请另外启动专用试用环境。在另一终端运行 `RECIPE_REVIEW_PORT=49185 python3 scripts/recipes/browser-check.py`。脚本会在这个试用目录中额外发布一份测试配方。需要 Python Playwright 与 Chromium，可用 `CHROMIUM_BIN` 指定浏览器。
