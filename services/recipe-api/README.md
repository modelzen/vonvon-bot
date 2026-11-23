# 配方账号 API

Node 22.12 及以上通过 HTTP 提供首批文字配方的目录、草稿、发布、获取和分享码操作。进程默认监听 127.0.0.1:4317。浏览器使用同源网页登录服务，后者凭用户的 Supabase access token 调用此 API，桌面客户端可直接使用 Bearer token。

在隔离数据库按文件名前的时间戳顺序运行 [SQL 迁移](../../supabase/migrations)，每个文件单独事务执行，记录已执行的版本，升级时只执行新增迁移。创建专用数据库登录并授予 recipe_api 角色。应用启动时检查专用登录的权限，事务内切换至 recipe_api，使用已验证 JWT 的 sub 作为这次操作的账号。

| 环境变量 | 配置 |
| --- | --- |
| RECIPE_AUTH_ISSUER | 本项目签发方的完整 HTTPS 地址，以 /auth/v1 结尾。开发环境可使用 HTTP loopback 地址。签发方需启用 ES256 或 RS256，服务从该地址下的 .well-known/jwks.json 取公钥。 |
| RECIPE_DATABASE_URL | 专用 PostgreSQL 登录的连接字符串。远端使用 TLS 并验证服务器证书，私有 CA 可由 Node 的 NODE_EXTRA_CA_CERTS 配置。本地测试可在 localhost URL 的 host 查询参数指定专用 Unix socket 目录。 |
| RECIPE_CODE_KEY | 针对此环境固定的独立 32 字节随机密钥，使用 64 个十六进制字符表示。须与数据库备份分别保管。现有可用码依赖此密钥，变更前须安排迁移。 |
| PORT | 可选，默认 4317。 |

在本目录运行 npm ci、npm test 和 npm start。从仓库根目录可按 [联测脚本](../../scripts/recipes/check.mjs) 运行真实 PostgreSQL 与 HTTP 验收。

API 统一使用 /v1，亦支持以 /api/v1 转发。写操作携带 UUID 格式的 Idempotency-Key。修改、删除或发布已有草稿还须携带包含双引号的修订号，如 If-Match: "1"。草稿的公开字段为 name、summary、overview、version、access，独立的 config.role 保存携带的角色文字。从已发布版本准备新稿时，同时指定本人的 recipeId 和界面取回的 sourceVersionId；若作者的当前版本已经改变，服务返回 409，须重新核对当前版本。目录和详情可匿名访问，凭码详情取得授权后才返回 config。敏感响应均标记 no-store。

可选的 `config.setup.steps` 保存使用前准备，最多 8 项。每项包含 `kind`（config、tool 或 context）、`title`（最多 80 个 Unicode 码点）、`instructions`（最多 2048 UTF-8 字节）、`required`（布尔值），可附 `check`（最多 512 UTF-8 字节）。私人草稿可先存空标题和说明，发布时须完整；无步骤时省略 setup。凭码版本取得前不返回任何 setup 内容。这些字段只保存指引，不执行命令。

进程级的试码计数按已验证账号计算，同时计入正在验证的请求，连续在同一十分钟窗口内提交十次无效码后返回 429。开发与小规模联调使用单进程；多实例运行时须共享限流计数或使用统一入口限流。首次部署应测托管项目真实签发的 JWT、远端 TLS 连接和实际回程。此服务当前接收文字角色、使用前准备与发布元数据，附件、群技能及飞书采集留待后续接入。
