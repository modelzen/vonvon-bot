# 领取回执预算

## 1. 做什么

保留永久配方权益和首次领取原始请求证明，将重复领取产生的回执限制在有限存储内。网络失败仍可原样重试，并可从同账号同版本详情确认结果。

## 2. 范围

新增 SQL005，领取 HTTP 校验、受控错误、native IPC 单入口、原生与 Web 领取恢复以及本地合成验证。不触及已部署迁移、authoring/use 功能、生产数据、实际 Supabase、公开网站或飞书。

## 3. 现在的代码

`recipe_api.acquire` 在账号事务锁内永久保存每个成功键，包括作者和已取得者无操作。`grants` 永久保存 normalized 首授证明，现有 acquire receipts 才含实际 raw 摘要。旧裸 UUID 允许任意 version/variant，不能通过改认 UUIDv7 安全回收。Web 详情 GET 目前没有会话代次保护。native 的 Error 跨 contextBridge 只保留文案。

## 4. 怎么改

接受 Terra 候选作为基础，并落实独立 Astra 裁决的必改项。本轮是两个模型候选加独立裁决，不是四模型全阵容。

- 领取专属键为 `a2.<UUIDv7>`。旧任意裸 UUID 仅重放已知 receipt 或迁移确认的 legacy-grant-only。动作命名空间分别为 acquire_v2/acquire。其他动作 ID 不变。
- 新 SQL text 签名为唯一新写者，Node 显式 text。旧 uuid 签名只能转到恢复路径。所有函数固定 search_path、recipe_owner 拥有，无 PUBLIC execute。
- migration 将 grant 标为 legacy-grant-only、legacy-with-raw。新 grant 标 v2-with-raw。只有第一类可用 normalized 比较并补实际 raw 一次，原子转第二类；其余 raw 丢失 fail closed。保留两个原有 grant 唯一约束，未知跨代底 UUID 冲突在消费码前拒绝。
- 仅 acquire 的 receipt subject_id 标记首授 version，no-op 为 null。migration 先快照 UTC 当天成功数并 seed min(256,n)，再仅留每账号最近 168h 内最新最多2048旧 no-op。首授摘要、结果、时间和 grant 原字段不改。
- 同业务账号锁后取一次 wall，effective=max(wall, committed highwater)。先 raw replay，再检查新键出生范围 [-5min,+2min]，再查 UTC 日额256。所有新成功键均计费；失败回滚。权益和首授证明无终身次数上限。
- 成功新写同时清理至少168h且可回收的 no-op、写 quota/highwater。partial index 只覆盖 no-op，避免扫描永久首授。冷账号可延后实际清理，承诺至少168h可重放，实际淘汰前可能继续重放。steady v2 no-op ≤2048/账号，过渡含legacy≤4096，实际权益和首次证明另计。
- 429 的 Retry-After 由数据库 next effective UTC midnight 减 wall 向上取整。错误仅安全 code/数值，不透传 SQL 文本或分享码。
- native request('acquire') 经原 IPC 返回 plain success/failure outcome，保留受控机器码和 retry 秒数。其他动作接口不变。Web 对账 GET 携 displaySession，BFF 必须匹配当前 cookie 且登录，响应前再验；公开匿名详情仍可读。
- 两端同 logical attempt 固定原 raw 和 key。弱网同键重试；换输入、过期、升级先对账，无权益后明确再次点击才换键。离线保留未知和内存输入，分享码不持久化。重启先读取版本详情。时钟错单独提示，429保留输入不循环。POST/GET/error/finally 均验证账号/会话、版本及导航/弹窗代次。

## 5. 测试

现有真实 PG+HTTP 260-key RED 改为a2格式，前256成功、第257起429，核对数据库行数。增加迁移 legacy grant-only/withraw、future-v7裸键、跨代碰撞、其他 action、超限旧 no-op fixtures；验证 raw 精确冲突、已认证 raw 丢失拒绝、满额重放、失败回滚、并发最后额度及同码竞争、UTC边界/回拨/7d清理不复活、旧签名和实际权限。客户端覆盖真实BFF、JS runtime、typed IPC/facade 的丢回执、离线对账、过期、换号及路由A-B-A。

## 6. Codex 的自测

Mac 隔离临时 PostgreSQL 和 synthetic HTTP identity。运行 `PG_BINDIR=... node scripts/recipes/check.mjs`、API/Web测试、protocol/UI/desktop相关 typecheck/test/build。不用默认 owner 数据，不启动或替换正式应用，不发飞书消息。实际 UI/真实账号验收由父任务汇总安排。

## 7. 文档

部署说明记录停写排空、单事务DDL、预检、恢复写入及前滚恢复。256/day、168h、5min旧/2min未来是本轮试验运营边界，调整前重算上界。无线上发布授权。

## 8. 验收要点

永久权益和首授 raw 不变；保留期间同完整键异raw为409；旧未知键不能复活；只有成功新键扣日额；清理与highwater同提交；旧签名无无限写旁路；对账精确绑定最初账号和版本；迟到回包不修改新页或新pending；diff无真实id/密钥/本机路径。

## 9. 风险和行数

涉及事务并发、迁移、错误路径和跨会话恢复。预计1000至1600行，按SQL/HTTP、native协议、Web和tests模块独立审查，父任务安排 fresh no-comments 及独立Astra review。保留水位可令时钟异常后的新领取暂停，不能重置绕过。迁移提交后的裁剪不能用降级旧函数恢复，只能前滚修复或使用独立一致备份。
