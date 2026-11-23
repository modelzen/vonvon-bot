# VonVon 发布版代码查阅授权

账号 Web 服务在启用本功能的环境提供 OAuth 授权码（PKCE S256）和设备授权（RFC 8628）。使用现有 VonVon 浏览器登录，网页的 Supabase 令牌只提交给本机 recipe-api 的 `/v1/me`。API 验证身份并返回内部账号 ID；这一路径不查询配方领取记录。

## 部署

- 使用 Node 22.14+ 或 Node 24，安装本目录锁定的依赖。生产和 staging 使用独立的账号项目、签名密钥、数据库及域名。
- 在对应账号数据库，使用可以读取 Supabase `auth.users`、`auth.sessions` 和配方私有账号映射的受信任数据库部署身份运行 `psql -v ON_ERROR_STOP=1 -f services/recipe-web/release-code-oauth.sql`。它创建独立数据 schema 和 NOLOGIN 角色。用数据库管理器为服务部署一个独立 LOGIN，将 `release_code_auth` 授给该 LOGIN；该 LOGIN 不应具备 owner、超级用户、创建角色或直接读取 Auth/配方表的权限。
- 在账号 Web 的 systemd 环境设置以下变量。未配置 issuer 时，该服务不注册 OAuth 路由。

| 变量 | 值 |
| --- | --- |
| `RELEASE_CODE_ISSUER` | 该环境的 `RECIPE_WEB_ORIGIN` 加 `/release-code/oauth` |
| `RELEASE_CODE_RESOURCE` | 该环境 MCP 的完整 HTTPS 地址，包含 `/mcp` |
| `RELEASE_CODE_AUTH_DATABASE_URL` | 上述受限登录的 PostgreSQL DSN，远程连接验证 TLS 证书 |
| `RELEASE_CODE_AUTH_LOGOUT_DIR` | 0700、仅供账号 Web 进程写入的持久目录，数据库暂时不可用时记录待撤销的浏览器授权，重启后继续处理 |
| `RELEASE_CODE_AUTH_KEYS_FILE` | 服务账号可读的 0600 文件，保存签名 JWKS 和 cookie 签名钥匙 |

下列命令在目标账号服务的机密目录内新建密钥文件，仅限首次配置。命令使用排他创建，已有文件将保留。

```sh
node --input-type=module -e '
import {generateKeyPairSync,randomBytes,randomUUID} from "node:crypto";
import {writeFileSync} from "node:fs";
const {privateKey}=generateKeyPairSync("ec",{namedCurve:"P-256"});
const key={...privateKey.export({format:"jwk"}),use:"sig",alg:"ES256",kid:randomUUID()};
writeFileSync("release-code-auth.json", JSON.stringify({jwks:{keys:[key]},cookies:[randomBytes(48).toString("base64url")]}),{flag:"wx",mode:0o600});'
```

账号 Nginx 须将 `/.well-known/oauth-authorization-server/release-code/oauth`、`/release-code/oauth/`、`/release-code/confirm/` 及现有 `/auth/` 路由转给同一账号 Web。对公网 OAuth 入口设置请求速率和请求体上限；禁用含请求行、查询、正文、凭据或响应的访问／调试日志。账号服务的私有 JWKS 只在账号服务器保存，公开的 `<issuer>/jwks` 只返回验签公钥。更新密钥时先同时发布新旧公钥，待 MCP 公钥缓存更新再切换签名；保留旧公钥覆盖最后一次签发的令牌有效期。

当前公网验收部署在官网腾讯云主机。独立单元 `vonvon-feedback-auth.service` 监听 `127.0.0.1:4346`，由 `https://code.vonvon.cc/release-code/oauth` 签发，只向同域 `/mcp` 发证。网页登录复用 `vonvon-recipes-staging` 的真实账号，Supabase 精确回调为 `https://code.vonvon.cc/auth/callback`。首次登录通过同机配方 API 的 `127.0.0.1:4317/v1/me` 映射账号。授权单元已启用开机启动，通过 `Wants=vonvon-recipe-api-stg.service` 和 `After=vonvon-recipe-api-stg.service` 拉起配方 API 并排在它之后启动。依赖配置在 `/etc/systemd/system/vonvon-feedback-auth.service.d/account-api.conf`。

修复或升级授权服务时，在 `/opt/vonvon-feedback-auth/` 安装新版本并定向重启上述授权单元。保留 `/etc/vonvon-feedback-auth/` 内的配置、密钥以及 `/var/lib/vonvon-feedback-auth/logouts/` 的撤销记录。变更后检查公网 discovery、公钥以及未授权设备轮询是否得到 `authorization_pending`。

## 客户端与账号生命周期

固定公开客户端 `vonvon-feedback-bot`，无客户端密钥。设备授权使用授权服务器元数据中的 `device_authorization_endpoint`、`token_endpoint` 和 `revocation_endpoint`。客户端提交准确的 `resource` 和 `scope=release-code:read offline_access`；设备码、刷新令牌不能进入聊天或模型上下文。PKCE 登录使用 `http://127.0.0.1:<临时端口>/vonvon/oauth/callback`，同时请求离线权限时传 `prompt=consent`。

用户在本人浏览器核对设备码并确认账号后发放授权。刷新令牌轮换，首次兑换和续签都确认 VonVon 账号、映射、Supabase 登录会话仍然有效。账号 Web 主动退出也会撤销与该浏览器登录关联的授权。已签发到目标 MCP 的 ES256 JWT 最长 10 分钟。30 天后需要重新授权。设备授权会话和已同意的 grant 存在上述独立数据库。

数据库不可用时，账号服务先在本机拒绝该浏览器授权的续签，每 15 秒重试撤销。如果数据库和持久目录同时不可写，待撤销记录只能暂存在内存中；重启服务前应先恢复其中一处，并让服务完成一次重试。

## 验证

`npm test --prefix services/recipe-web` 覆盖真实 HTTP 设备流程、PKCE、轮换和受限资源验证。额外数据库用例须使用一次性的空白本机 PostgreSQL 测试库和独立集群，设置 `TEST_RELEASE_CODE_DATABASE_URL`，执行 `node --test services/recipe-web/test/release-code-store.pg.mjs`；用例创建隔离表与角色。
