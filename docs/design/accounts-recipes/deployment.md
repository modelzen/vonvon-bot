# 部署、测试与 owner 准备项

这里的「部署」指 Vonvon 首次启用账号与配方服务。**创作者以后每次发布配方只是通过已上线的 API 写入一个新版本，不是重新部署服务或重启 Bot。** 下文保留设计阶段的部署方案；开发后实际完成的环境步骤见[实现状态](implementation-status.md)。

## 最小拓扑

| 运行在哪 | 需要交付什么 | 不在那里做什么 |
| --- | --- | --- |
| 一个独立的 Supabase 托管项目／环境 | Auth（三种社交登录）、PostgreSQL（目录、授权、草稿、幂等回执）、Storage 私有桶（暂存、已验证清单、正文和 Logo）、由受限数据库角色执行发布、兑换和版本授权事务；用库内定时作业清理过期工单与无引用资产。不另起 Redis、消息队列或常驻 LLM 服务。 | 不把 service-role 凭证发给网页、桌面或用户设备；云不保存飞书应用密钥、整群聊天记录、未选本机记忆。 |
| Vonvon 自有 HTTPS Web 入口 | 登录选择/完成页、公开分享落地页。可复用 `vonvon-site` 的静态构建与既有 Web 前置，新设独立 host（例如测试 `recipes-test.vonvon.cc`、正式 `recipes.vonvon.cc`，均为**建议名，尚未配置**）。同一台腾讯云主机上，独立 Nginx vhost 转发到本机 recipe-web，由它处理网页登录、分享页与同源会话；recipe-api 只监听回环，验证 JWT 后连接 Supabase。账号和数据库仍托管，首片不另上一套 Edge Functions。配置独立 TLS、Origin、CSRF 和精确 redirect allowlist。 | 不把私有 API 响应混入静态站或 CDN 公共缓存；现有下载、stable 与 bridge 服务不动。无需为本期另租一台 Bot 主机。 |
| 用户已安装的桌面／目标设备 daemon | 桌面在浏览器发起登录，目标 daemon 走**已有授权的设备连接**、持本地 Bot 身份，通过飞书发送/接收、挑本机内容，在本机安装/更新。飞书长连接仍使用现有链路。 | 安装 App 不替用户启用远程管理；租用的 Bot、运营服务器、他人的账号不是本机操作凭据。 |

地域建议：先在独立 staging 选择**具体的新加坡 region**（若控制台可选，且用户的数据位置要求允许），用用户实际网络测 Auth、API、图像和包下载后，再决定生产。不要只选泛 APAC 却宣称数据固定在特定城市；也不要把新加坡视为从中国大陆所有网络都可用的保证。若存在只允许特定地区存储的数据约束，先按约束调整。初期本地开发 + 一个 staging 即可；公测时另建 production，不能共用账号库、飞书测试群、密钥、OAuth client 或对象桶。免费套餐有暂停、额度及备份限制，能否用于稳定公开服务另验。[地域规则](https://supabase.com/docs/guides/platform/regions) · [本地开发](https://supabase.com/docs/guides/local-development) · [Edge 运行限制](https://supabase.com/docs/guides/functions/limits)

**为什么先用免费层试。** 按 2026-11-13 核对的[官方定价](https://supabase.com/pricing)，Free 列出 50,000 MAU、500 MB 数据库和 1 GB 文件存储，空闲一周可能暂停。对本产品，版本与 Logo 的存储、反复下载通常比账号数更早值得看。若 40 位作者各占满 25 MiB 历史包，逻辑量已是 1,000 MiB，尚未计入草稿、暂存、数据库、传输或物理去重差异；按实际字节监测再决定套餐。

**完整发布包启用图片前。** 首片只有文字，不接图片。以后在 staging 实际运行受限解码器，用许可范围内最大的有效图测试内存/CPU/并发；服务器独立重解码、清元数据、重新编码（即使桌面已经做了预览）。CPU/内存超预算时保持默认图标，按测得负载再决定是否将转码外移。新增常驻费用须先说明。

## 如何测，达到什么程度才上线

1. **本地，可立即做。** 使用合成数据跑 SQL 并发/取消/授权、浏览器发布→获取→安装、跨账号隔离、聊天改草稿等；参见[已测与未测](validation.md)。Supabase CLI 的本地栈可在实现阶段验证 migration、RLS、Storage/Functions；不能推出真实 OAuth、飞书权限或公网可达性。
2. **staging，必须。** 先部署 schema、专用数据库登录、API 与测试网页；启用附件前再准备私有桶及对象策略。先获取一个测试授权码并正确返回到原 App，再测不同登录方式的匹配、取消、过期。端到端用测试 Bot 和明确可联系的测试人：发起→真实私聊→卡片→私人草稿→版本发布→另一测试账号实际凭码获取→在专用群安装。测试两个 Bot 同群、另一个管理员不能确认、设备离线、回执丢失、停用码与并发领取；用不同网络测速、重试，并验证敏感内容不在 API、IM、日志与缓存。去掉一项权限后应给具体可恢复状态，不得假报已送达。
3. **生产，小规模放量。** 用独立生产凭据部署，确认 TLS/回调、监测、对象配额、备份恢复、限流、运营撤下/封禁与回退，再按账号逐步开放写操作。先部署向后兼容服务端，再放行支持版本的客户端；失败时禁用新发布/安装写入口，保留现有本机构建与只读记录。破坏性回滚、公开部署、替换正式 Bot 和切 stable 均不是本轮动作。

## 什么时候需要 owner 做什么

- **现在**：不需要提供密钥、密码或测试群聊天内容。账号自动关联规则已经确认。本地设计验证可以继续。
- **建 staging 前**：组织已经确定；创建时核对实际可用的免费活动项目名额、地域/数据位置和额度；指定有权的维护账号、测试域名与管理 DNS/TLS 的负责人。优先复用已有组织和隔离环境，不必给个人主账号密码。
- **真实登录联调前**：由有权限的管理员在 GitHub/Google/Apple 配测试 OAuth 应用、精确回调与 Apple Services ID/签名密钥；将 secret **直接录到对应环境**，聊天里只给项目/应用标识、已配置回调及是否就绪。至少要有可验证同邮箱和不同账号边界的测试身份，并由本人完成授权。Apple 配置/签名轮换指定责任人。
- **真实私聊与安装前**：优先复用已授权的隔离测试设备、Bot、专用群；只在缺少时需要 owner 指定允许测试的飞书租户、两位测试身份、能管理的 Bot 和专用群，确认能接收测试私聊并完成一次身份关联。凭现有普通设备配对测试，不要求开放账号远控。不要提供生产 Bot secret、私聊原文或真实用户数据。

### 本次选址与隔离（2026-11-13）

- 已在 owner 提供的 Supabase 组织项目列表只读核对：Free，一个旧项目名为 `vonvon-prod`，新加坡，处于暂停状态；官网旧 bridge 账号页配置引用同一项目。不会从暂停推断它没有历史数据，亦不将其改名或用作配方 staging。[免费活动名额](https://supabase.com/docs/guides/platform/billing-on-supabase)跨管理的组织计算，暂停项目不计入。在有可用名额且没有收费的前提下，独立创建测试项目；生产再独立决策。
- 官网用系统 Nginx 托管，现有独立子域／本机服务有先例。使用单独的 vhost、证书、Unix 用户和部署目录，目录放在官网 `current/` 之外，免受原站同步清理。不要共享统计数据库、业务密钥或 bridge 回调。API 与 Web 都只监听回环；不给外部请求选代理目的地。网页、OAuth 回程、私有 API 禁止共享缓存，并关闭回调查询参数日志。[官网部署](https://github.com/modelzen/vonvon-site/blob/ebd56eb015ee9e936085d3cfdc45412aa1ba8f86/site/DEPLOY.md#L27-L36)。
- **采购决定：现在不买新机。** 尚未取得生产主机当前空闲内存、磁盘及到 Supabase 的时延实测。部署前检查资源余量和从真实用户网络访问三种登录的表现；对现有官网响应和资源设置隔离及预算。备选是托管函数或独立主机，只有实测共享资源会影响官网、地域可达性达不到要求或有隔离需求时再评估。每次作者发布只是数据写入，不会触发部署。

## 切换领取回执预算

SQL005 需要单事务执行。先在数据库副本运行 `scripts/recipes/check.mjs` 并检查当前数据量。以下 SQL 只读，可统计迁移的三类数据和本日接纳量。

```sql
select g.actor,
  count(*) filter (where r.request_id is null) as legacy_grant_only,
  count(*) filter (where r.request_id is not null) as legacy_with_raw
from recipe_private.grants g
left join recipe_private.receipts r on r.actor=g.actor and r.action='acquire' and r.request_id=g.original_request
group by g.actor;
select r.actor,count(*) as noop_rows,
  count(*) filter (where r.created_at>clock_timestamp()-interval '168 hours') as retained_candidates
from recipe_private.receipts r
where r.action='acquire' and not exists (
  select from recipe_private.grants g where g.actor=r.actor and g.original_request=r.request_id)
group by r.actor;
select actor,count(*) as accepted_today
from recipe_private.receipts
where action='acquire'
  and created_at>=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'
  and created_at<=clock_timestamp()
group by actor;
```

按下面顺序切换。不要把全库升级放入业务 HTTP 的五秒事务中。

1. 在流量入口暂停 acquire 和 redeem 写入，返回维护响应。停止旧 API 实例接纳新请求，排空既有请求。核对 `pg_stat_activity` 已无旧领取事务，并持有运维侧停写门。仅取得 grants 和 receipts 表锁不能替代排空旧函数调用。
2. 保存一致备份以及上述计数、首授 grants 和原始 receipts 的校验结果。以数据量评估锁等待、磁盘和 WAL，安排维护窗口。
3. 使用迁移账号执行 `psql -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261114000500_recipe_acquisition_budget.sql`。现有迁移工具若已保证每文件一个事务，可以使用相同事务边界。任一失败回滚整份 migration，保持停写并修正原因。
4. 检查 acquire 的 text 和旧 uuid 两签名均为 recipe_owner，固定 search_path，无 PUBLIC execute。以实际 API LOGIN 的 `SET LOCAL ROLE recipe_api` 检查 text 入口可用、私表和水位不可访问。核对首授原 digest、result、created_at 和 grant 原字段未改；确认 legacy no-op 每账号不超过2048，当前日 seed 等于迁移前成功数的 min(256,n)。
5. 部署发送 a2.UUIDv7 的 Web 和 native 调用者与显式 text SQL 的 API。先用合成账号验证 exact replay、raw mismatch409、未知裸键升级拒绝及 GET 对账会话保护，再恢复写入。

迁移提交后，只允许前滚修复。降级应用时也保留新 text 入口及旧签名恢复限制。不得恢复旧无限写函数、删除 acquisition_state 或重置 effective_at。裁剪的历史无操作回执只能从一致备份恢复，不能通过旧应用重新构造。第一份真实 raw 证明和永久权益不裁剪。

新成功领取键按业务账号 UTC 日最多256，作者和已取得者的重复操作也计数。已保存精确回执和历史 grant-only 恢复不计数。新无操作回执至少保留168小时，冷账号可能保留更久，实际淘汰后旧键不能重新作为新操作。v2 无操作回执最多2048/账号，迁移过渡期连同 legacy 最多4096/账号。此上界不包含真实权益及首次证明，也不代表数据库文件、WAL 或备份的字节上界。
