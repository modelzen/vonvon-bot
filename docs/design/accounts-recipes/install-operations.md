# 已绑定群的文字配方安装操作契约

本契约对应 `services/recipe-api` 和 `20261114000300_recipe_install_operations.sql`。本片提供账号服务的预览、授权、兑换、取消和完成回执。daemon 负责核对本机绑定并原子保存角色、setup 和安装来源。后续建群、更新、卸载和飞书代办不在本片内。

## 身份和数据边界

App 的主进程持有 Supabase JWT。`install-preview`、`authorize` 和 `cancel` 由 API 验证 JWT，再映射到当前活跃的业务账号。请求不能指定业务账号。daemon 持有本机 X25519 私钥与本次操作的随机 32 字节 nonce。API 不接收 Bot、群、项目路径或本机设置修订号。

daemon 的 `redeem` 和 `complete` 请求仅含 operation ID、操作票据、nonce 和证明。发送 Authorization 头会返回 422。daemon 只向预配置的可信 HTTPS API 发请求，不从票据读取 URL，不跟随重定向。固定服务地址和本机私钥的保存属于 daemon 集成片。

账号必须是该不可变版本的作者，或已经取得该版本。公开免费版本的匿名正文读取权限不能用作安装权。作者停用分享码不会撤销既有取得权。已有旧账号映射、不可变版本和取得权继续有效，不因本片新增格式限制而改写。

## 精确 manifest

`GET /v1/versions/:versionId/install-preview` 要求 JWT。返回以下字段。

| 字段 | 类型和含义 |
| --- | --- |
| accountId | API 从 JWT 映射的活跃业务 UUID |
| recipeId、versionId | 已选择的配方与不可变发布版本 UUID |
| manifest | 精确 UTF-8 JSON 字节的无填充 base64url |
| manifestSha256 | 解码后 manifest 字节的 SHA-256，小写 64 位十六进制 |

manifest 字段固定为 `schema: 1`、`recipeId`、`versionId`、`authorId`、正整数 `revision`、`access` 和 `role`。`access` 是该版本发布时的 `direct` 或 `coded`。`authorId` 是发布者的业务账号 UUID。存在 `config.setup` 时，manifest 带原值 `setup`。

`setup.steps` 保留现有格式。每项含 `kind`、`title`、`instructions`、`required`，可以含 `check`。`kind` 为 `config`、`tool` 或 `context`。安装只保存指引，不执行命令，不请求工具权限，不启动任务。

服务以 PostgreSQL `jsonb::text` 序列化这份白名单对象，再编码为 UTF-8。预览和兑换调用同一函数。客户端对收到的原始字节计算摘要，不能重排字段后重算。daemon 先核对摘要，再按 schema 解析。JSON 的字段顺序和空白不属于可独立重建的客户端约定。

## 操作标识和时间

daemon 在本机准备时生成一次 UUIDv7，并在重试中复用。其前 48 位是 Unix 毫秒时间。API 只为出生时间不早于服务器当前时间 5 分钟、且不晚于服务器当前时间 2 分钟的未知 UUID 建记录。未知旧 ID 返回 410 `operation_expired`。过于超前的 ID 返回 422 `operation_clock_skew`，用户须校准设备时钟并重新准备。已存在记录按服务器保存的期限处理。

`generation` 本片固定为 1。重新准备生成新 operation ID，不复活取消或过期的操作。API 从服务器时间生成 `deadline`，值为 Unix 毫秒整数，首次授权后最多 300,000 毫秒。客户端不能传期限。

首次兑换必须在 deadline 内提交。兑换成功后的原请求可以在创建记录起 7 天内恢复，即使五分钟期限已经过去。完成回执也受这七天限制。

## 授权请求

`POST /v1/operations/:operationId/authorize` 要求 JWT。operation ID 本身是幂等键，不需要 Idempotency-Key。请求体恰含以下字段。

| 字段 | 类型 |
| --- | --- |
| purpose | 固定字符串 `installBoundRole` |
| versionId | 精确发布版本 UUID |
| manifestSha256 | 已展示的精确 manifest 摘要，小写 64 位十六进制 |
| targetPublicKey | daemon 的原始 X25519 公钥，32 字节 base64url |
| nonceCommitment | SHA-256 原始 nonce 的 32 字节 base64url |
| generation | 固定整数 1 |

所有 32 字节二进制字段编码为 43 个 ASCII 字符，无填充。非规范尾部位、标准 base64 的 `+` 或 `/`、填充 `=` 和额外字段均被拒绝。X25519 全零或无有效共享秘密的公钥也被拒绝。

授权响应包含请求的全部字段，增加 `operationId`、`accountId`、`deadline`、`serverPublicKey`、`ticket` 和 `status`。首次 `status` 为 `authorized`。serverPublicKey 是本次临时 X25519 公钥。ticket 是独立随机 32 字节票据。

同一账号、operation ID 和相同规范请求返回原票据、原服务器公钥和原 deadline。字段改变返回 409 `conflict`。其他账号使用该 ID 返回 404。取消后的授权返回 409 `operation_cancelled`。账号服务不为重试生成第二个有效授权。

## 二进制证明

`rawUUID` 删除 UUID 中的连字符后按十六进制解码，结果是 16 字节。所有整数无符号、大端编码。`||` 表示字节连接。字符串末尾的 `\0` 是一个零字节。

```text
T = UTF8("vonvon.recipe.installBoundRole.v1\0")
    || rawUUID(operationId)
    || rawUUID(accountId)
    || rawUUID(versionId)
    || hexDecode(manifestSha256)
    || base64urlDecode(targetPublicKey)
    || base64urlDecode(nonceCommitment)
    || base64urlDecode(serverPublicKey)
    || uint32BE(generation)
    || uint64BE(deadline)

shared = X25519(daemonPrivateKey, serverPublicKey)
K = HKDF-SHA256(
      ikm = shared,
      salt = base64urlDecode(nonceCommitment),
      info = UTF8("vonvon.recipe.installBoundRole.proof-key.v1\0"),
      length = 32)
proof = HMAC-SHA256(K, T)
```

服务用临时私钥与 targetPublicKey 计算相同 shared，只保存 `SHA256(proof)`。计算结束后丢弃临时私钥引用，并清零共享秘密、K 和预期 proof 的字节数组。服务保存 nonceCommitment，不保存 nonce。数据库私有表保存 ticket，供授权响应丢失后的原请求恢复。票据泄漏本身不能完成兑换，还需要 nonce 原像及对应 daemon 私钥生成的证明。

[跨端黄金样例](../../../services/recipe-api/test/fixtures/install-proof.json) 使用公开的 RFC 7748 测试私钥，包含完整 transcript、shared、K 和 proof。它们仅供测试。`install-proof.test.mjs` 验证样例和所有绑定字段的变化。

## 兑换、完成和取消

以下端点均以 operation UUID 定位记录。除取消外，请求不能携带 JWT。响应默认 `private, no-store`。

| 请求 | 精确请求体 | 返回 |
| --- | --- | --- |
| POST `redeem` | `{ticket, nonce, proof}` | 原授权绑定字段、manifest、当前 status。不返回 ticket。首次变为 `redeemed`。原请求重试返回 `redeemed`、`applied` 或 `rejected` 及原 manifest。 |
| POST `complete` | `{ticket, nonce, proof, outcome}` | `{operationId, status}`。outcome 为 `applied` 或 `rejected`。兑换前提交返回 409。同结果重试返回原状态，改变结果返回 409。 |
| POST `cancel` | `{}`，要求 JWT | `{operationId, status}`。尚未兑换时变为 `cancelled`。已兑换时返回 `in_progress`，记录仍为 redeemed。终态返回 `applied` 或 `rejected`。 |

兑换与完成先验证 ticket、nonce 原像和目标密钥证明，再核对账号仍活跃及该版本的作者或取得权。错误证明返回 403 `invalid_operation_proof`。账号停用返回 403 `account_disabled`。权利失效返回 403 `forbidden`。这些错误不改变记录，也不撤销已在本机保存的事实。

兑换只证明 daemon 已获 manifest，不代表安装成功。daemon 完成本地原子提交后才提交 applied。拒绝安装时提交 rejected。完成响应丢失后可重发同一 complete，或重发 redeem 查询已保存的终态。云回执只记录 daemon 的操作结果，云端不能独立观察本机写入。

取消可以先于授权到达，服务为同一账号写入 cancelled 记录。后来的授权不能复活该 ID。取消先获得操作锁时，兑换失败。兑换先获得操作锁时，取消返回 in_progress，不宣称撤销，也不回滚本机文件。

## 并发、限额和留存

数据库固定按账号行共享锁、账号 advisory 事务锁、操作行排他锁排序。带 JWT 的请求复用现有账号映射事务。持票据请求从操作记录找到账号，再取得相同账号共享锁。账号状态更新和安装操作因此存在明确先后顺序。版本和取得权行在判权时取得共享锁。

每账号最多三个待完成操作。`authorized` 且未过 deadline 的操作与 `redeemed` 操作占名额。完成、取消、未兑换授权过期或记录超过七天后不再占名额。达到上限返回 429 `operation_pending_limit`，附 Retry-After。

每账号每 UTC 自然日最多建立 60 个新 operation ID，包含提前取消的记录。原请求重试不计新操作。达到日额返回 429 `rate_limited`，Retry-After 指向 UTC 次日。预览和错误请求不创建回执表记录。操作端点请求体最多 2 KiB。

成功的新注册或取消会在同一账号事务内清除创建超过七天的操作。无后续活动的账号最多保留最后一批有日额约束的记录。不存在永久累计次数上限。purge 后的 UUID 已超过新建时间窗口，因此返回 410，不能重新创建。完整数据最多覆盖七天内的 UTC 日期，活跃账号最多保留 480 行。七天后不承诺返回旧完成回执，本机安装事实仍保留。

recipe_api 角色只能执行白名单函数，没有 install_operations 表权限。anon 与 authenticated 不具有函数权限。JSON Schema、绑定字段和状态转换由 HTTP 边界与 SQL 函数共同约束。

### App 恢复原操作与群来源

App 确认安装后，先把原 operationId 和目标保存在桌面日志，再让 daemon 持久标记 `issuing`，最后以原账号请求授权。标记之后，即使没有收到票据也不能据本地时间假定授权未签发。云端已兑换时，取消返回进行中；缺少完成回执时向同一个 daemon 重试原操作。renderer 只收到短时 handle、职责与 setup 对比以及进度，不接收票据或 nonce。

没有票据的 daemon 可以请求 `POST /v1/operations/:id/unredeemable`，精确请求体是 `{accountId}`，不带 JWT。回复仅含 `operationId`、`unredeemable`。服务取得与该账号的授权事务相同的锁后，只有云取消、未兑换授权已过期，或已过新建时间窗口且没有记录时，才返回 true。false 不能用来判断是否兑换；该接口不能授权、完成或取消任何操作。daemon 只把 true 用于尚无票据且正在等待签发结果的原操作。

按版本检查更新使用 `GET /v1/recipes/:recipeId/latest-install-version`，要求账号登录。返回最新已发布 revision、versionId、显示版本与该账号的确切权益；不包含正文。忽略最新版本只写目标 Bot 的当前物理群绑定，更新安装时仍从安装预览重新核验所选版本。

建群日志先记录原请求号，调用原 Bot 的建群或连接接口。成功响应返回后先保存真实群 ID，再准备安装。建群响应未知时只查相同请求号的已创建绑定；找不到时保持待核实，不重新发起建群。恢复时核对业务账号、设备 ID、公钥、Bot 和版本。安装被拒绝后可以在已知群重新预览，重新确认，不需再建群。
