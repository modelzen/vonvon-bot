# 在线私人草稿操作契约

本契约实现 [准备请求](runtime.md) 和 [草稿编辑](chat-drafts.md) 的云仲裁首片。范围为文字角色、作者明确填写的公开文案和 setup 文本。没有真实群、任务、飞书投递、发布、Logo 或技能文件操作。完整可移植 manifest 与逐条来源链仍受后续实现门禁限制。

## 调用顺序与权限

目标 daemon 生成 UUIDv7 operationId、临时 X25519 密钥对和 32 字节随机 nonce，并先写入本地 journal。目标私钥与 nonce 留在原设备。main 持账号 JWT，核对本地设备控制权、当前账号、真实 Bot 管理员、来源 revision 和经双向挑战验证的收件人。

1. main 用当前原账号 JWT 登记同一 operationId。登记体只有用途、目标公钥、nonce 承诺，编辑时另有确切 draftId 和 baseRevision。云只知道不透明目标公钥，不接收 Bot、群、飞书身份、路径或未选择内容。
2. main 新鲜验证原账号与本地授权后，申请 dispatch 阶段票据。目标 daemon 用私钥和 nonce 证明持有该操作。成功的 `/dispatch` 回执仅表示云登记和阶段验权完成，daemon 此后才可以发 IM。真实投递状态和固定 Feishu 消息 UUID 由本地 journal 保存。云状态 `dispatched` 不表示飞书已收到消息。
3. 本人在可信私聊确认后，daemon 冻结经过本地来源检查的候选，并保存确切字节。公开文案默认全空，不能从源群名称、内部角色或任务内容自动填入。非空公开文案必须是作者明确提供或确认的文字。
4. main 再次验证原账号和授权，只为本次冻结候选的确切 SHA-256 申请 accept 阶段票据。dispatch 票据不能接受候选。main 离线、已退出或换号时保持待同步，daemon 不持账号 JWT，也不能自行签发下一阶段。
5. 目标 daemon 提交该阶段票据、nonce、设备证明和编码后的候选。云原子写入一份私人草稿或一个新修订及固定回执。只有收到回执后才能显示已保存。后续读取用 draftId 获取当前稿，回执永远返回本次原修订。

本地退出不能让云知道本机状态。main 和 daemon 必须暂停该账号的未完成操作并丢弃待用票据。云已经签发的票据最多有效五分钟，只有原阶段和确切摘要可用，不能换取新阶段。恢复需要原账号重新登录和本地授权。账号停用时，云在账号行锁内拒绝所有阶段，包括回执重放。

## HTTP 请求

所有响应为 `Cache-Control: private, no-store`。账号从验证过的 JWT 解析，body 不接受 accountId。下列 ID 均为 UUID。operationId 必须为 UUIDv7。

| 请求 | 认证 | 请求体与结果 |
| --- | --- | --- |
| `POST /v1/authoring/{operationId}/register` | JWT | `{purpose,targetPublicKey,nonceCommitment}`。purpose 为 `prepareDraft` 或 `editDraft`。editDraft 必须另带 `draftId,baseRevision`，prepareDraft 禁止这两个字段。相同参数重试返回原状态。 |
| `GET /v1/authoring/{operationId}` | JWT | 返回本人操作状态或既有完成回执，不返回任何票据。 |
| `POST /v1/authoring/{operationId}/cancel` | JWT | 空对象。未登记也可写取消墓碑，阻止迟到的登记。完成先赢时返回原完成回执，不删除草稿。 |
| `POST /v1/authoring/{operationId}/authorize` | 原账号 JWT | `{stage,stateRevision,payloadDigest}`。stage 为 `dispatch` 或 `accept`。dispatch 摘要为 SHA256 空字节 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。相同阶段同摘要在有效期内返回同一 ticket 和 deadline。 |
| `POST /v1/authoring/{operationId}/dispatch` | 设备证明 | `{ticket,nonce,proof}`。成功为 `{operationId,status:"dispatched",stateRevision:2}`。同票据重放只返回原 dispatch 回执。 |
| `POST /v1/authoring/{operationId}/accept` | 设备证明 | `{ticket,nonce,proof,payload}`。payload 是下述规范 UTF-8 JSON 字节的无填充 base64url。成功为 `{operationId,status:"accepted",stateRevision:3,draftId,revision}`。 |
| `POST /v1/drafts/{draftId}/patch` | JWT | 下述 DraftPatchV1。`Idempotency-Key` 必须为新鲜 UUIDv7。返回 `{draftId,revision}`，同键同参重放原结果。现有完整 `PATCH /drafts/{id}` 保持兼容。 |

设备证明端点拒绝任何 Authorization header，不能把账号 token 交给目标 daemon。其余端点不接受设备证明替代登录。

登记与授权请求最多 2 KiB。accept HTTP 请求最多 192 KiB，解码 payload 最多 128 KiB。所有对象拒绝未知字段、缺字段、NULL 和错误类型。字段、setup、凭据形状检查共用 App 完整保存使用的 `checkDraft`。SQL 再执行同一 `check_fields` 字段与容量检查，摘要从实际传入字节复算。

## 候选字节与类型

规范 JSON 以 UTF-8 编码。对象键按 ASCII 字典序排列，数组保持顺序，无空白，字符串采用 JSON 字符串编码，不归一化 Unicode。首片键名都为 ASCII。禁止重复键、无效 UTF-8、未配对代理项、NUL、非规范 base64url 和深于 16 层的输入。main、daemon 可以复用 `services/recipe-api/src/authoring-input.mjs` 的 `canonicalJson` 与 `payloadBytes`。云 HTTP 层解析后重新规范化并逐字节比较，数据库对原 bytea 计算 SHA-256，避免各语言 JSON 键序或空白改变授权内容。

prepareDraft 的解码 payload 只有 `{public,config}`。public 必须含 `name,summary,overview,version,access`，私人稿允许前四项为空字符串。config 必须有 role，可选 setup。setup 沿用 `{steps:[{kind,title,instructions,required,check?}]}`。未知字段和 sourceVersionId、来源路径等不进入此接口。

editDraft 使用 DraftPatchV1。

```json
{"baseRevision":7,"changes":[{"op":"setDraftRole","value":"新的角色说明"}],"draftId":"22222222-3333-4444-8555-666666666666","schemaVersion":1}
```

changes 为 1 至 16 项，每个字段只能出现一次。

| 操作 | 字段 |
| --- | --- |
| `setPublicText` | `{op,field,value}`。field 仅为 name、summary、overview、version，value 为字符串。 |
| `setDraftRole` | `{op,value}`。value 为字符串。 |
| `setSetup` | `{op,value}`。value 为合法 setup 对象，或 null 表示移除。 |

不支持任意 JSON path、整配置覆盖、访问方式、来源标签、Provider 权限、任务运行、群设置或发布。editDraft 登记、授权和接受都核对本人且仍存在的准确草稿和 baseRevision。发布先成功则 patch 冲突，patch 先成功则旧发布确认冲突。已发布草稿不会复活。相同请求摘要的成功重试在后来编辑或发布后仍返回本次原修订。改变 payload 或幂等键对应内容返回 409。

富内容来源链、共享条目和其他作者受限版本的再分发不因本片开通。目标设备仍须在冻结和授权前保留并检查已有来源门禁，拒绝来源未知、混合或受限条目。云没有接收“原创”自报字段来洗掉来源，也没有据此签发导出权限。将来接入 rich manifest 必须逐项核验受信来源链，不能把本文的文字结构视为已完成该能力。

## 状态、并发与留存

| 云状态 | 修订与允许动作 |
| --- | --- |
| registered | revision 1。只可授权 dispatch、取消或到期。 |
| dispatched | revision 2。只可授权固定候选 accept、取消或到期。 |
| accepted | revision 3。保存固定 IDs 和修订回执。接受重放、GET、登记重放和取消均返回原完成结果。 |
| cancelled | 终态。登记、阶段授权和接受均不能继续。未登记取消的 revision 为 1。 |
| expired | 终态。操作到期不能续签或复活。 |

账号 quota advisory lock 使用现有草稿保存、删除及发布的同一键。锁顺序为账号行、账号 quota advisory lock、操作行、草稿行。新编辑提案以新 operationId 登记，一个 draftId 最多一个 registered 或 dispatched 提案。明确取消或到期后才可另建。已签发 accept 摘要在同一操作内不可更换，调整内容需要取消并新建提案。

操作有效期固定为登记后 24 小时。单阶段票据不超过五分钟，也不能超过操作截止时间。同参数续签只在原状态和原账号 JWT 下进行，覆盖已到期阶段的 ticket 和 proof hash。已结算 dispatch 票据不可被 accept 或续签覆盖。每个操作最多两行阶段记录。云不保存 X25519 服务端私钥，只保存公钥、ticket、预期 proof 的 SHA-256、授权摘要与有限元数据。

已经成功的 dispatch 回执可以在票据五分钟到期后重取，但仍须在操作的 24 小时截止时间内。数据库在取得操作行锁后读取当前时间，无需先经 JWT 查询或清理才能拒绝过期重放。accepted 的原完成回执按独立七天保留期重放，不受原活动截止时间影响。

每账号最多三个进行中的 authoring 操作，包含准备和编辑。每 UTC 日最多 60 个新 operationId，含提前取消。相同 ID 重放不计次数。终态操作及票据保留七天，过期活动操作的终态时间取原截止时间。由下一次账号操作清理。包括 24 小时活动窗口和自然日边界，每账号最多九个自然日的操作，即 540 行操作、1,080 行阶段记录。没有永久累计上限。

App 类型化 patch 每账号每 UTC 日最多 600 个新 requestId，回执保留七天，最多覆盖八个自然日，即 4,800 行。回执只含 digest、draftId、结果 revision 与固定键，绝不复制正文或 draft_json。单个回执 JSON 为固定字段、两个 UUID 和有限整数，最多 256 字节，4,800 份结果正文最多 1,228,800 字节。行头、摘要和索引另计数据库实物预算。原来的完整 PATCH 不受这个新端点日额影响。

新 ID 的 UUIDv7 出生时间只允许落后服务端五分钟或超前两分钟。保留期后删除回执也不能让旧 ID 重建。日额返回 429 和 UTC 重试时间，活跃数超额返回 429，状态或摘要冲突返回 409，到期返回 410，字段错误返回 422，超大 HTTP body 返回 413。

## 证明字节与黄金样例

`authoringTranscript` 依次连接以下字节，不含长度前缀。所有定长字段长度固定。

1. UTF-8 `vonvon.recipe.authoring.v1`，随后一个 NUL。
2. operationId、accountId、draftId 的各 16 字节 UUID。prepareDraft 的 draftId 为 16 个零字节。
3. targetPublicKey、nonceCommitment、serverPublicKey，各 32 字节。
4. purpose 一个字节，prepareDraft 为 1、editDraft 为 2。stage 一个字节，dispatch 为 1、accept 为 2。
5. payloadDigest 的 32 个原始摘要字节。
6. stateRevision 的 unsigned 32-bit big-endian。
7. baseRevision 的 unsigned 32-bit big-endian。prepareDraft 为 0。
8. deadline 的 unsigned 64-bit big-endian，单位为 UTC 毫秒。

X25519 得到 shared secret。HKDF-SHA256 的 salt 为 nonceCommitment 的 32 字节，info 为 UTF-8 `vonvon.recipe.authoring.proof-key.v1` 加 NUL，输出 32 字节。proof 为该 key 对上述 transcript 的 HMAC-SHA256。云只保留 SHA256(proof)，并独立核对 SHA256(nonce) 与承诺。ticket、nonce、proof、公钥均采用无填充 base64url。installBoundRole 使用不同 domain、info、布局和表，不能成为 authoring 票据。

可跨语言复验的合成私钥、全部 binding、transcript hex 和 proof hex 位于 [authoring-proof.json](../../../services/recipe-api/test/fixtures/authoring-proof.json)。这些是公开测试向量，不是生产密钥。
