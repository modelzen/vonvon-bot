# 私人配方准备与精确草稿编辑的云端仲裁

## 1. 做什么

App 和飞书入口可以通过同一 operationId 收敛到一份私人草稿。聊天编辑只确认指定 draftId 和 baseRevision 的类型化补丁。取消、重试、重启和发布竞争均由云事务决定，不能误建第二份稿或发布。

依赖已集成的账号映射、文字角色草稿 API 和 PR #768 的在线安装证明实现。设计依据为 accounts-recipes 的 runtime、chat-drafts、cloud 和 limits。准确新接口与字节格式见 [在线私人草稿操作契约](../design/accounts-recipes/authoring-operations.md)。

## 2. 范围

实现文字角色、作者公开文案和 setup。包含云登记、取消墓碑、两阶段短票据、目标设备证明、冻结候选接收、DraftPatchV1、账号额度和固定回执。没有真实飞书、浏览器、账号 OAuth 回程、安装、发布调用、任务执行或 rich manifest。来源门禁保留，不能把本片当成任意来源导出权限。

## 3. 现在的代码

`services/recipe-api/src/http.mjs` 验证 JWT、body 和静态路由。`database.mjs` 绑定验证后的账号，每次事务设置最小 SQL 角色。`install-proof.mjs` 的临时 X25519 模式只服务 installBoundRole。

现有草稿、发布和额度用同一个账号 advisory lock。原 `save_draft` 重试会读取当前稿，不能承担编辑后或发布后的原 authoring 回执。本片保存独立固定结果，不复用其完整响应。

## 4. 怎么改

- `authoring-input.mjs` 定义 canonical JSON、编码候选和 DraftPatchV1 白名单，复用 `checkDraft` 字段、setup 和凭据检查。
- `authoring-proof.mjs` 定义独立 authoring domain、HKDF info 和二进制定长 transcript。目标私钥和操作 nonce 留在原设备，不新增常设设备密钥。
- `20261114000400_recipe_authoring.sql` 新增操作与固定两阶段票据表。操作为 registered、dispatched、accepted、cancelled、expired 状态机，每步使用 revision。每账号最多三项活动操作，每草稿最多一项活动提案。
- JWT 只能由 main 持有。每个新阶段 main 重新验证原账号与本地权限，签发绑定目标公钥、nonce、operationId、用途、阶段、摘要和修订的五分钟 capability。没有 main 时目标保留本地候选并等待。
- 云只接收不透明设备公钥、账号、用途和有限业务状态。登记体没有 Bot、群、飞书身份、路径或原内容。候选接收前先验证原 bytes 的 digest，写入本人私人区。
- 设备证明 helper 从验证过的 operation 推导 actor，不读取 renderer 自报账号，也不把设备能力扩成通用 save_draft 权限。
- 固定锁序为账号行、账号额度 advisory lock、操作行、草稿行。接受与取消、App 保存与发布共享事务序列化。一次接收只生成一份草稿或一个修订及 IDs 回执。
- 票据只在原阶段未消费、原状态活动且操作未到期时续签。相同授权有效期内返回同一票据。接受后重放返回保存的原修订，即使草稿后来编辑、删除或发布。
- 操作 24 小时截止，终态七天保留。UUIDv7 新鲜度防清理后重建。每日 60 个操作、600 个 typed patch 请求，固定两行阶段表和不含内容的回执限制账本大小。

本轮对结构做过顺序比较。复用 install_operations 无法表达独立目的和精确草稿 revision。新增通用授权引擎会扩大变更。选择独立 authoring 表与证明模块，复用既有 quota 锁和字段校验。

## 5. 测试

真实 PostgreSQL 15 与本机 HTTP 的合成 issuer 测试覆盖以下结果。

- 并发同 ID 登记只建一项，另一账号不可查改，私有 source 字段拒绝。
- dispatch 和 accept 不互借，错账号、目标私钥、purpose、stage、nonce、payload 和 revision 均拒绝。SQL NULL、错误 JSON 类型和缺字段都关闭授权。
- 票据过期后原账号可续签，原票据失效。失效 JWT 不能为下一阶段授权。重启或响应丢失后仍是同一 draftId 和原 revision。
- 提前取消墓碑和登记后取消都生效。用真实行锁等待分别证明取消与接收的两个获胜顺序。
- 精确编辑与发布分别先赢时，另一端冲突。接受重放在后来编辑和发布后仍返回原回执。
- 单稿活动提案互斥，三项活动额与日额并发不越界，七天清理与 UUIDv7 旧 ID 不复活。
- 两个证明函数域分离，黄金向量按完整 transcript 和 HMAC 比较。完整现有 recipe API 回归仍通过。

## 6. Codex 自测

只在独立源码 worktree 和新建的临时 PostgreSQL 目录执行，不使用任何测试 Bot、真实飞书、用户账号或默认数据。测试从 `mkdtemp` 建 0700 socket，禁用 TCP，finally 关闭服务器并清理本次创建的临时目录。

```bash
npm test --prefix services/recipe-api
PG_BINDIR=/opt/homebrew/opt/postgresql@15/bin node services/recipe-api/test/authoring.pg.mjs
PG_BINDIR=/opt/homebrew/opt/postgresql@15/bin node scripts/recipes/check.mjs
```

未执行真实私聊和桌面验收。daemon、本地主进程和 UI 由后续独立切片实现，联调时必须实证 IM 及云上传的隐私哨兵。

## 7. 文档

新增独立接口参考与本文。没有修改产品定稿或把整个账号配方阶段标为完成。来源、rich manifest、真实投递及发布验收继续保持后续门禁。

## 8. 验收要点

- actor 来自验证的 JWT 或已验证 capability 的原账号，不能借 renderer 的 accountId。
- 同 operation 的取消与接收原子仲裁，同提案只生成一次修订。
- 票据的目标、用途、阶段、nonce 和 digest 完整绑定，install 票据不能写草稿。
- 成功回执只有 IDs 和 revision，没有源文案或快照的重复副本。
- 四份批准设计的隐私边界与限额仍成立，diff 无真实 ID、密钥和用户数据。
- 本片只完成云 API，可以提交独立审查，不能宣称完整功能已发布。

## 9. 风险和行数

核心风险为错误路径、并发仲裁、账号停用和跨阶段能力复用。差异预计小于 2,000 行，按证明与输入、SQL 状态机、HTTP 适配、真实 PostgreSQL 测试分别审查。独立审查由父任务安排，本片不 push、不建 PR、不合入。
