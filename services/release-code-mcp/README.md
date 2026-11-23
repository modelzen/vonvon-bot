# VonVon 发布版代码查阅

独立的 Streamable HTTP MCP 服务。源码来自发布机切换的只读目录，进程仅需该目录的读取权限和统计库的写入权限。它只绑定本机回环地址；Nginx 在前面提供 HTTPS。

## 运行

使用 Node.js 22.13 或更高版本、系统 ripgrep，在本目录执行 `npm ci --omit=dev`。配置环境后执行 `npm start`：

| 环境变量 | 含义 |
| --- | --- |
| `RELEASE_CODE_MCP_URL` | 客户端访问的完整 HTTPS URL，同时是令牌的唯一 audience，例如 `https://code.vonvon.cc/mcp` |
| `RELEASE_CODE_ISSUER` | VonVon 账号服务为此 MCP 签发令牌的完整 issuer，形如 `https://账号域/release-code/oauth` |
| `RELEASE_CODE_JWKS_URL` | 公钥地址，默认是 issuer 下的 `/jwks` |
| `RELEASE_CODE_ROOT` | 绝对目录，其中 `current` 指向当前不可修改的快照；快照含 `release.json` 和 `tree/` |
| `RELEASE_CODE_STATS_DB` | SQLite 文件绝对路径，父目录须存在且仅对该服务可写 |
| `RELEASE_CODE_RG`、`PORT` | 可选；默认使用 PATH 中的 `rg` 和本机端口 8784 |

反代转发 `/mcp` 和 `/.well-known/oauth-protected-resource/mcp`，保留请求的 Authorization、Accept、Content-Type 和 MCP-Protocol-Version。运维可在本机访问 `GET /healthz` 核对正在提供的版本和提交。代理与错误日志省略认证头及请求、响应正文。

## 工具和身份

每个 MCP 请求单独校验账号专用短期令牌。账号发行方、ES256 签名、`at+jwt` 类型、单一目标服务、VonVon 账号 UUID、`release-code:read` 与最长 10 分钟有效期均须匹配。首次授权和续签由账号服务处理。

- `rg({argv:["-n","-F","--","feedback_prepare","packages"]})` 搜索文本；`--files` 查文件。参数独立传递，仅允许工具描述中的只读选项。
- `read({path:"packages/daemon/src/feedback/recipe.ts",offset:35,limit:40})` 返回带行号原文；`nextOffset` 给出下一页起点。路径从发布代码根目录起算。
- 成功结果给出实际 `version` 和 `sourceSha`。文本输出上限为 32 KiB，搜索超时 4 秒，每个账号每小时最多 240 次，最多两次并发，全服务最多八次并发。

## 统计

服务按 UTC 小时、内部账号和工具累计已接纳的调用。「活跃账号数」表示 Bot 代表多少个不同账号查过代码。使用 SQLite 的只读连接查询，例如：

```sql
SELECT datetime(hour * 3600, 'unixepoch') AS hour_utc, tool,
       count(DISTINCT account) AS active_accounts, sum(calls) AS total_calls
FROM calls GROUP BY hour, tool ORDER BY hour DESC, tool;
```

`npm test` 在临时目录使用 SDK 客户端连接真实本机 HTTP 服务，检查 JWT、工具调用、快照切换与计数。
