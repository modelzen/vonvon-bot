# 已绑定群安装操作 API

## 1. 做什么

让已取得配方版本的用户授权目标 daemon 将该不可变文字角色和 setup 安装到现有绑定。App 展示的 manifest 字节与 daemon 兑换的字节一致，用户能区分已兑换、已安装和已拒绝。依赖集成分支已有账号映射、发布、取得权和使用前准备。

## 2. 范围

本片实现 `services/recipe-api` 的精确预览、在线操作票据、X25519 密钥证明、取消与完成回执、新 SQL 迁移、真实 PostgreSQL 联测及契约文档。daemon 的本地绑定核验与原子安装、主进程 JWT、App 页面由集成片的其他 owner 实现。新建群、更新、撤下、卸载、飞书采集和生产部署不在本片内。

## 3. 现在的代码

基线为集成分支 `74310da9`。`http.mjs` 以静态路由表分派请求，`database.mjs` 在事务内切换 recipe_api 角色，并由 `resolve_identity` 映射活跃业务账号。现有 version_detail 允许匿名读取免费版正文，但这不等于安装权。`recipe_private.versions` 保存不可变配置，grants 保存逐版本取得权。已有 setup schema 使用 kind、title、instructions、check 和 required。

## 4. 怎么改

状态记录为 install_operations，一行代表一个账号的一次 installBoundRole。状态为 authorized、redeemed、applied、rejected 或 cancelled。相同 UUID 和请求恢复原授权，参数改变报冲突。提前取消写同一状态表，不额外创建不受限的通用回执。

GET install-preview 和 POST authorize 均要求 owner 或该版本 grant，包括免费版。manifest 由版本行生成，包含 schema、配方与版本标识、作者、revision、access、role 和原 setup。预览与兑换共用序列化函数。

daemon 提供 UUIDv7、目标 X25519 公钥与 nonceCommitment。App 主进程以 JWT 授权。API 生成五分钟期限、临时 X25519 密钥和随机 ticket，按 [操作契约](../design/accounts-recipes/install-operations.md) 计算固定域 transcript 的 HMAC，只保存预期 proof 的哈希。daemon 用本机私钥证明目标身份，用原 nonce 证明预览准备的持有权。服务不接收 Bot、chat 或路径。

兑换和取消共享账号锁与操作行锁。取消先赢则兑换失败。兑换先赢则取消显示 in_progress。兑换之后必须有独立 applied 或 rejected 结果。账号停用与业务请求共享账号行锁。SQL 事务在进程退出或请求失败时回滚，不产生半份授权。

先完成跨端 wire 和黄金样例，再由本片 owner 实现 API、迁移和测试。daemon 与 UI 文件不共写。共享不变量只在账号和操作行上串行化。API 与其 SQL 状态机需要同一 owner 联测，拆成多个写者会增加状态契约漂移。独立审查在本地提交后由集成 owner 安排。

## 5. 测试

1. main 必败。作者和取得者可预览精确版本，匿名和未领取免费版的账号不能安装。原有匿名免费正文读取继续有效。
2. main 必败。同 ID 并发授权返回同 ticket、deadline 和服务器公钥。摘要、版本、公钥或 nonce 承诺变化返回冲突。
3. main 必败。公开 RFC 7748 私钥产生固定 transcript、HKDF 和 HMAC 样例。错误私钥、nonce 或 ticket 不能兑换。
4. main 必败。完成前兑换只得到 redeemed。相同完成回执可重放，反向 outcome 冲突。已完成后重发兑换可恢复终态。
5. main 必败。真实 PostgreSQL 持锁安排取消先赢和兑换先赢，分别拒绝兑换或返回 in_progress。账号先被禁用时，等待中的兑换不会读取 manifest。
6. main 必败。取得权被移除后不能兑换。旧映射账号和既有版本仍可使用。
7. main 必败。并发新请求最多占三个 pending。每天最多 60 个新 ID，提前取消和重试不会绕过计数，也不增长通用回执表。
8. main 必败。旧 UUIDv7、未来时钟、授权过期和七天清理分别返回明确错误，清理后的旧 ID 不复活。
9. main 必败。HTTP 拒绝 Bot、chat、路径、额外账号字段、非规范二进制与超过 2 KiB 的正文。兑换和完成拒绝 JWT。

## 6. Codex 的自测

Mac 上的 Codex 使用本片独立 worktree 和临时 PostgreSQL 15 数据库。测试仅使用合成账号和本机非对称 JWT 签发器，不连接 owner daemon、飞书群或真实云数据库。本计划未指定测试群，不发飞书消息，不需要 lark-cli 或浏览器操作。

执行 `npm ci --ignore-scripts` 和 `npm test`，目录为 services/recipe-api。执行 `PG_BINDIR=/opt/homebrew/opt/postgresql@15/bin node scripts/recipes/check.mjs`，目录为仓库根。测试自己建临时数据库、执行完整迁移并运行 API 后清理。生产 TLS、真实 Supabase 和实际 App 安装由后续集成验收覆盖。

## 7. 文档

新增 `docs/design/accounts-recipes/install-operations.md` 作为跨端协议。limits 补充 pending、日额、时钟和留存。runtime 增加本片实际边界。服务 README 标明操作 UUID 幂等及无 JWT 的 daemon 请求。此片属于现有账号与配方集成功能，不修改旧 v1 切片的完成状态。

## 8. 验收要点

- manifest 的精确字节和 SHA-256 在预览与兑换中一致，保留 setup 指引。
- target key、nonce commitment、operation、版本、账号、generation 和 deadline 全部进入固定证明 transcript。
- 数据库没有 daemon 私钥、临时服务器私钥或 nonce，预期 proof 仅存哈希。
- 账号 JWT 不转交 daemon。API 不接收 Bot、群或本机路径。
- 取消与兑换有真实数据库并发证据，redeemed 不被报告为 installed。
- 日额和七天留存约束提前取消及普通操作，无永久累计禁用阈值。
- diff 里没有真实 id、密钥或本机私有路径。黄金样例使用公开测试值。

## 9. 风险和行数

预计 900 行以内，涵盖 Node 证明、SQL 状态机、测试和文档，不含生成 lockfile。主要风险为密钥证明字段漂移、取消和账号停用并发、提前取消绕过留存及本地完成后云回执丢失。黄金样例、持锁并发测试和有界状态表分别验证这些风险。审查按 SQL 状态与权限、Node 验证和跨端契约核对。未运行生产托管环境或真实设备安装，不能据本片结果宣称整批功能完成。
