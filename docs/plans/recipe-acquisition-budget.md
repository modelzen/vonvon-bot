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
- 两端同 logical attempt 固定原 raw 和 key。弱网同键重试；换输入、过期、升级和时钟拒绝先对账，无权益后明确再次点击才换键。离线保留未知和内存输入，分享码不持久化。重启先读取版本详情。时钟错提示校准设备时间，429保留输入不循环。POST/GET/error/finally 均验证账号/会话、版本及导航/弹窗代次。取消或 Escape 关闭 Web 领取弹窗时释放旧弹窗的页面按钮，旧请求迟到不能修改新弹窗或新请求的按钮。

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

## 10. 客户端恢复修复

基线为 `d06b9dc9db513bf7d6c812a7f7944559309fa9a5`。独立审查确认取消后按钮占用、时钟拒绝键无法恢复、普通限流码在 IPC 丢失。先提交 RED 回归 `6ed67ff12d4a5833b1546c3da8d626301c5033fb`。Web 失败8项，原生 UI 失败4项；真实 HTTP 第11次兑换返回的 `rate_limited` 和600秒经主进程序列化后变为 `unavailable`。

修复复用既有代次与权益对账，不改 SQL、HTTP 错误行为或全局时钟状态。两端对账失败、离线、版本不符及迟到结果均保留原 raw/key；确认已有权益后结束，确认尚未获取后只允许下一次明确点击创建新键。原生允许的受控码补充 `rate_limited`，继续与每日额度的 `acquire_rate_limited` 区分。验收覆盖取消、Escape、迟到成功和错误、账号切换、路由 A-B-A、校准时间、已有权益、离线对账、版本不符、过期和升级恢复。父任务负责最终独立增量审查；本轮不推送或部署。

本地验证通过 Web/BFF 39项、API HTTP 9项、UI 社区37项、desktop bridge/community-api 96项和 protocol limits 10项。命令为 `node --test services/recipe-web/test/*.test.mjs`、`node --test services/recipe-api/test/http.test.mjs`，以及对应 workspace 内 `npx vitest run` 指定上述测试文件。protocol、UI 和 desktop 的 typecheck/build 通过，构建保留既有依赖及 CommonJS 的警告。没有修改 SQL，沿用父任务已完成的 PostgreSQL 验证，本轮未重复全套数据库测试或浏览器验收。

独立复查另发现两个客户端问题。时钟拒绝后的无权益对账删掉了分享码，导致 Web 取消后重开或桌面点击「重试读取」时丢失输入；Web 确认已获取时又在第二次详情读取期间释放了旧领取按钮。RED 提交 `b6aca5edbbb21998ca422cd81be7ffbb83a49d89` 在两个实际客户端的 DOM 测试中复现，Web 3 项失败，桌面 1 项失败。

账号和版本现在分别保留当前输入、可选的已提交请求（原始载荷和键）。只用一个「可提交／可重放」标记配一份分享码，无法表达用户输入新码时旧请求结果仍未知。编辑、取消、重读均不创建键。未知结果保留旧请求；确认尚未获取后只清除已提交请求，下一次提交使用当时的输入。Web 直接用已通过会话和版本核对的详情显示权益，无需额外读取。取消弹窗才释放当前详情按钮；成功会替换详情，旧按钮不再能打开弹窗。直接获取只属于详情，它的回包不会关闭后来打开的账号弹窗。

本轮隔离验证通过 Web/BFF 43 项、原生社区 38 项、桌面 IPC 96 项、HTTP 9 项、协议 10 项。覆盖换码时离线对账、校时后的重开或重读、旧按钮回调以及直接获取期间打开账号弹窗。UI、desktop、protocol 类型检查及 UI、desktop 构建通过。本轮未修改服务端或 SQL；独立审查和浏览器验收由父任务负责。
