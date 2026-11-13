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

需要亲自操作网页时，保持 `node scripts/recipes/check.mjs --review` 运行，并打开输出的本地地址。它用三个仅在本回环服务生效的合成身份分别模拟 GitHub（作者）、Google、Apple（领取者）。真实身份提供方与测试完全分离。按 Ctrl-C 清理临时数据。若已安装 Python Playwright 与 Chromium，可在另一终端运行 `python3 scripts/recipes/browser-check.py`，可选 `CHROMIUM_BIN` 指向浏览器。此脚本只接受数字端口并固定使用本机地址。
