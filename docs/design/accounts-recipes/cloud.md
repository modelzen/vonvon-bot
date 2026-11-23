# 账号与配方的云端设计

2026-11-15 更新：[配方不携带记忆](memory-exclusion.md) 约束全部新写入，包含来源快照、编辑、元信息和发布。下文中允许作者选择记忆的早期规则不再适用；历史字节与已提交回执继续按原合同读取。

设计日期为 2026-11-13，是与客户端对接的拟议契约。基线 `origin/dev@6079afd180c8` 有本机 daemon、[设备配对](../../../packages/desktop/src/connections.ts)和[本地设备注册表](../../../packages/desktop/src/device-registry.ts)。本轮未建云项目，也未在该基线发现本方案的账号、发布或兑换 API。交互稿里的登录、传消息和兑换都是样例。

## 1. 选型与账号主键

首版采用一个账号 API、一套托管 PostgreSQL、一个对象存储和托管社交登录。GitHub、Google、Apple 在系统浏览器完成登录。首版不收手机号，不接短信，不用飞书组织身份认证 Vonvon 用户。UI 按钮写「登录」。配方由 Vonvon 的 `account_id`（UUID）拥有，在任何设备登录同一账号都能再获取已获授权的版本。邮箱、头像、昵称和 Feishu open_id 均不得作为所有权键。

**已定。GitHub 与 Google 返回相同的已验证邮箱时，登录同一个 Vonvon 账号。** 选一体化 Supabase Auth + PostgreSQL + Storage，身份关联由 Supabase 执行。后端只根据已验证 Supabase JWT 的 `(iss, sub)` 建立业务账号映射，同一 Supabase 用户的多个登录身份指向同一 `account_id`。关联结果不依赖客户端自报 provider 或邮箱。首版不提供手动合并或解绑。

| 实际登录信息 | 应验结果 |
| --- | --- |
| GitHub、Google 轮流返回完全一致且满足 Auth 关联规则的已验证邮箱 | 作品、领取权益、草稿和码管理归属同一个账号；第一次换登录渠道无需迁移业务数据。 |
| Apple 隐藏邮箱，或几个渠道返回不同邮箱 | 可能是不同账号。真实邮箱和 relay 地址不能推断为同一人，也不转移已有权益。 |
| 提供方不能给出可信邮箱或返回未验证身份 | 按提供方及 Auth 的真实结果报错或进入其可信验证流程；禁止客户端按邮箱补偿合并。测试以三家正式配置和真实测试身份为准。 |

账户页显示当前账号的公开身份与本次登录方式；如果展示“已关联的登录方式”，仅使用可信身份服务的可见记录，避免把不同登录渠道标作多个不同 owner。[Supabase 身份关联](https://supabase.com/docs/guides/auth/auth-identity-linking)

## 2. 网页与桌面登录回程

- 网页。自有 HTTPS 登录页提供三种选择，发起服务负责随机 `state`、PKCE S256 和 OIDC 需要的 `nonce`。精确登记测试/生产各自的回调。浏览器只持本站 HttpOnly、Secure、SameSite 会话 cookie；BFF 保管或加密托管上游 session/刷新令牌，写操作校验 Origin/CSRF。回程只接受服务器保存的动作，如“继续领取版本 X”；不接任意 return URL。
- 桌面。主进程建立一个 5 分钟登录事务，保存发起者的待办动作、不可预测的 state，以及浏览器不可见的轮询凭据；用系统浏览器打开固定 HTTPS 选择页。这个页面仅提交所选提供方到该事务并等待跳转。主进程取得经验证、与事务关联的 provider 后，调用本地 PKCE SDK 的 `signInWithOAuth({provider,options:{skipBrowserRedirect:true,redirectTo:…}})` 生成**一次** authorize URL，将它交给同一网页继续跳转。主进程以独立的 SDK storage 保存本流程 verifier，关闭 URL 检测自动换票，应用运行期间只允许一个登录事务。
- 提供方回已登记的 Supabase provider callback；Supabase 再回 Vonvon **精确白名单**里的 HTTPS 回程页，返回的只有授权码。桌面场景的回程页凭 HttpOnly flow cookie 找到同一事务，把授权码与一次性 state 暂存给发起的桌面进程并立即清除地址栏查询串；`Cache-Control: no-store`、`Referrer-Policy: no-referrer`，关掉第三方脚本、回调查询日志和分析。主进程用轮询凭据按事务取码、核对 state，调用 `exchangeCodeForSession` 配合本机原 verifier 兑换，成功后登录状态通过已有 IPC 告诉 App。不需要公网访问本机的端口，也不需要把令牌放进启动链接；浏览器可以提示切回已打开的 App。若改用原生 App Link 必须另测平台注册和串线，不能同时启用两个消费者抢码。
- 事务记录包含 owner client challenge、选择页/回程会话关联、允许的 provider、待办动作引用、状态、不可猜的取码凭据摘要及过期时间。选择页初次用一次性随机浏览器启动票据交换 flow cookie，跳转前 rotate/删除票据，桌面轮询凭据绝不交给浏览器。服务仅接受由主进程经认证事务提交的当前项目 authorize URL（HTTPS、主机、路径、provider、redirectTo 和 PKCE 参数精确校验）；网页不接收任意 URL 跳转。授权码只短期加密存放；同一已证明的发起者可在有效期内重取同一个响应，等兑换 ACK/取消/过期再清除。Supabase authorization code 本身一次有效，官方当前时限 5 分钟，兑换结果未知且本地没有有效 session 时须重新登录，旧动作仍待确认。网页独立登录时由网页 BFF 同时负责生成 verifier 和换票。两条路径都必须用 macOS、Windows 和网页实际验证。[Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)、[回调白名单](https://supabase.com/docs/guides/auth/redirect-urls)、[原生应用 OAuth](https://www.rfc-editor.org/rfc/rfc8252)
- 账号 API 每次验证签名、公钥来源、issuer、audience、有效期和已停用账号，issuer 只从部署配置选择，JWKS 有限缓存及轮换重取。桌面刷新令牌仅由主进程保存在系统安全存储，UI、配方、日志、URL 都不得携带。安全存储不可用时仅本次会话，不回退明文。当前设备退出后清本端会话，失效的 session/refresh 不再继续写；取消不领取、不兑换、不发布。切账号隔离并暂停该账号的未完成业务交接，原账号在有效期内重新登录可恢复；只有显式取消或到期才终止操作。不得借后来登录的账号续传。账号登录、手工设备配对、目标设备主动允许被管理是三个独立权限。
- GitHub 注册 OAuth App；Google 配 Web client、最小身份 scope、同意页面；Apple 配带 Sign in with Apple 能力的 App ID、Services ID、Web 域名、精确 return URL 和签名凭据。Apple Web OAuth client secret 最长约半年，设置过期前轮换与三渠道探测值班项。Apple 可能只返回 relay 邮箱，不保证有姓名或头像；账号页可用默认头像和可修改的公开署名。第三方 token 不用于读仓库、发邮件，也不写到配方。[GitHub 登录](https://supabase.com/docs/guides/auth/social-sign-in/auth-github)、[Google 登录](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)、[Apple 登录与轮换](https://supabase.com/docs/guides/auth/social-sign-in/auth-apple)

## 3. 数据与权限

首版存公开介绍、作者选出的快照、账号对具体版本的 entitlement（领取授权）、私人草稿和码。Bot/群配置在目标设备运行。云不接受整份本机配置备份。群名、机器地址、路径、Bot 凭据、飞书身份映射、provider 登录态、环境变量、工具/MCP、聊天记录和未勾选记忆都不进入公开接口。设备只上传 schema 允许、用户已复核的字段；云再次验证。作者私人草稿可以保存作者选出的内容及不透明来源引用，公开作者只展示公开资料。跨设备读草稿不等于能指挥原 Bot；再次联系原 Bot 仍须有该设备和本群对应权限。

| 表（拟） | 键与约束 | 谁可以读写 |
| --- | --- | --- |
| `accounts`、`account_identities` | 独立账号 UUID；身份唯一 `(issuer, subject)`，事务内首次建号。分开存私有邮箱与 `public_profiles` 昵称头像。 | 自己读账号；公开仅读公开 profile；服务才建身份映射。 |
| `recipes`、`versions` | 配方 owner FK；版本的 `(recipe_id, version_label)` 与 `(recipe_id, revision)` 各唯一；服务器分配单调 revision、不可变 version_id，不能按版本名字符串比较。current_version 复合 FK 确保属于本配方。 | 作者能发布自己的配方；发布后行不可被普通更新。状态和列表可见性另设策略。 |
| `version_public`、`version_payloads` | 两者以 version_id 为 PK。前者是限长公开投影，只含标题、一句话简介、公开 Markdown、署名、必要标志、版本、Logo 引用与出处。后者仅存受控对象引用、schema 版本、SHA-256、逻辑字节数与授权信息。完整 canonical manifest（含可能内嵌的私有文本）、正文和 Logo 成品均在受控对象存储中。 | 访客能读已发布公开介绍。直接获取型访客也能看完整快照。需码型全文只给该版本作者或已获该版本授权的账号。 |
| `drafts`、`handoffs` | 作者 + 草稿 UUID + draft_revision；交接有随机 id、owner、Bot/群**不透明**来源、预期修订、过期/取消/完成状态；每个 handoff 最多生成一份草稿。 | 草稿、选择、准备状态仅作者及该次受限回执可见。云行唯一 operation_id，按 state_revision 做 CAS；按 owner、device、op 限定的短期单用途提交票据只允许上传该次已选快照，无通用发布/写权限。 |
| `grants` | PK `(account_id, version_id)`；记录 direct/code 路径与取得时间，不覆盖历史。按 (account,recipe) 展示已获取时取最高已获 revision。 | 仅本人查看；作者查看自己的作品不会触发自领。安装行为另由本地记录。 |
| `code_batches`、`share_codes` | batch + version_id；每码随机至少 128 位，去分隔符、统一字母大小写后算带版本号密钥的 HMAC。摘要唯一。状态 available/redeemed/disabled 互斥，CHECK 对应时间和 redeemer_id。 | 作者管理自己版本的批次、码末尾、状态、时间和兑换者公开昵称。可用码另存可撤销的加密密文供作者主动复制，列表不返回邮箱或明文；服务仅凭摘要验证与消费。 |
| `uploads`、`assets`、`featured_entries`、`idempotency` | 上传属于 owner、draft、有效时间；完成后持不可变 key/hash。精选记录引用已发布版本、编辑者及顺序；幂等键唯一 `(actor, operation, request_id)`，另存请求摘要。 | 正常用户不能写精选；仅受控运营角色调整；固定首页唯一 slot 的主键保证同时最多一个。上传与请求回执均不能跨账号读。 |
| 账号额度、版本额度与预留记录 | 按作者锁账号计数，按版本锁可用码数。签发累计数跨批次和版本保留，UTC 自然日的签发／发布计数各自保留。暂存预留绑定账号、操作、容量与期限，提交和释放按预留 ID 去重。 | 只有服务可结算或经审计调额。作者可查询自己的已用量、剩余量及下一次日额重置时间。 |

应用数据库 schema 默认为 private，撤销 `PUBLIC`、`anon`、`authenticated` 的原始表/RPC权限，不把 `SELECT *` 视图或完整 payload 对外暴露。账号 API 验签后以非 owner、非 BYPASSRLS 的专用角色执行事务，事务级绑定由服务得出的 account_id（例如 `SET LOCAL`/带参数的 `set_config(..., true)`），每次事务从头设置；客户端无法调用设置主体的 SQL。启用 RLS，私有表按 owner、版本 entitlement 和发布状态分行；公共投影明确列白名单并测试视图不绕过 RLS。发码、发布、兑换经限定函数，收紧 `EXECUTE`、固定 search_path，函数所有者与可登录角色分开。配置的 service_role/secret key 可绕过 RLS，仅限受限后台工作如对象归档/清理，绝不放桌面、网页 JS 或普通 API 共用客户端。若将来开放 PostgREST 须单独授权并复测。[Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[Data API 权限](https://supabase.com/docs/guides/database/secure-data)

## 4. 业务接口与提交顺序

下列路径是拟定义的 Vonvon 账号 API；设备内部“拉 Bot 入群”与飞书 API 不在此表。作者/领取者均根据会话解析，拒绝以 body 的 actor 覆盖。外部链接形如 `/recipes/{recipeId}/versions/{versionId}`，不含码、云 token 或源群身份。

| 接口 | 核心契约 |
| --- | --- |
| `GET /v1/community/recipes?cursor=&limit=&q=&access=&sort=`、`GET /v1/recipes/{id}/versions/{v}` | 默认首屏返回单独的 hero（精选或最新）、其余 items 和 next_cursor；搜索及续页只返回 items 和 next_cursor。详情只返回公开字段、精确版本和本次调用者可执行动作。锁定者可见介绍。 |
| `GET /v1/recipes/{id}/versions/{v}/payload` | direct 型公开；coded 型逐请求验作者/对应 grant；未登录或无权时 401/403，响应中无摘要内文、预览片段或私有 URL。来源与 deep link 不改变判定。 |
| `POST /v1/handoffs`、`GET /v1/handoffs/{id}`、`PUT /v1/handoffs/{id}/draft` | 仅确认选好的现有 Bot + 群后建立请求。目标 daemon 持久化本地 operationId 及状态；云表只按 operationId 去重/镜像可同步的准备摘要与草稿，真实发送和投递回执以该 daemon 为准。云对同一 operation_id 的取消与提交使用行锁/预期 state_revision CAS，先提交的合法终态生效。目标 daemon 凭绑定账号、已授权设备、op、预期内容摘要、有效期的单用途凭据上传该次已选草稿，receipt + draft 在同一事务持久化。回执重放返回同一草稿；若取消或到期已胜，不接收内容。原账号回归时仅恢复尚未取消、到期的 op。App 查看状态、重开会话或查看草稿。无需全站 Realtime。 |
| `GET /v1/me/drafts`、`PATCH /v1/drafts/{id}`、`POST /v1/drafts/{id}/publish` | 改动须 `If-Match: draft_revision`。最终确认才执行发布。回执含 recipe_id、version_id、revision 和已发布的公开投影。 |
| `POST /v1/drafts/{id}/logo-uploads`、`PUT /v1/logo-uploads/{id}/content` | 只给草稿 owner，下面第 5 节规定有效时限与转码；返回状态与已验证的 asset_id。 |
| `POST /v1/versions/{v}/codes`、`GET /v1/versions/{v}/codes?status=&cursor=`、`POST /v1/codes/{id}/disable` | 仅作品作者，批量签发有上限；列表分页按状态；只能停用未兑换码，不撤销已经给出的 entitlement。创建时交付明文；作者也可在管理页主动复制尚可用的码。 |
| `POST /v1/codes/{id}/reveal` | 仅此版本 owner 可为复制而取单枚仍可用码。服务按调用频率和当前状态校验、单次解密返回，不可缓存，不把码写入日志、批量状态列表或分享链接。 |
| `POST /v1/versions/{v}/acquire`、`POST /v1/versions/{v}/redeem`、`GET /v1/me/recipes` | 已登录 direct 获取或 body 提交分享码。先存账号授权，再尝试入群。取消安装不丢授权。错误不带原码。 |
| `POST /v1/auth/desktop-flows`、`POST /v1/auth/desktop-flows/{id}/selection`、`PUT …/authorize`、`GET …/result`、`POST …/ack` | 创建返回启动票和私有轮询凭据；网页票据/CSRF 只能选 provider；authorize/result/ack 必须证明是发起主进程。失败支持取消、到期和重新开始。 |
| `POST /v1/me/applied-updates` | 仅结算 direct 型更新。下载前服务器登记限 account、device、version、operation 的待确认凭证，授予安装所需下载、不预先计入库。本机提交后以设备证明、原操作与摘要结算；云按 account + operation_id 幂等。普通撤下后仅允许对账此前已合法开始且已成功的原操作；无原凭证不接收。封禁时只记录处置状态，不恢复分发。coded 型必须先有该版 grant。云不据此宣称群已更新，本地提交才是安装依据。 |
| `GET /v1/me/publications`、`GET /v1/recipes/{id}/versions` | 作者单独管理自己的草稿、版本、码；社区页不暴露这些管理动作。历史详情按版本原获取条件鉴权。 |

**写草稿和发布。** App 编辑、私聊确认、准备请求提交草稿共用同一账号额度行。按固定顺序锁额度和相应操作、草稿，校验身份、幂等键、状态和预期修订。使用服务端核实的对象计算字节，创建按份数与总量占额，修改按差额增减，删除按实际占用释放；草稿、计数、交接或修订回执同一事务提交。准备和暂存的预留、过期与清理见[限额与留存](limits.md)。

发布带 `Idempotency-Key` 与 `If-Match`，同键异参返回 409。服务核对 owner、schema、公开字段与出处，先验证不可变对象。发布事务锁作者额度、配方和草稿，检查草稿与父版本的预期 revision、历史配额和日额，挂不可变 public/payload 引用、更新 current 指针、封印草稿、结算历史及草稿占用并写回执。凭码发布同事务生成首码并计入当版可用数、作者签发日额及累计额。若任一额度不足或首码失败，原稿继续可编辑，目录中没有半成品。事务未引用的对象在复查全部草稿和历史引用后回收。每版分别定义获取条件与授权。

**衍生与出处。** Opt-in 选择哪几项不能替代授权。受信 daemon 冻结候选时记录每个可导出字段/技能的来源 release_id、稳定条目 ID、基线摘要、作者和本地自有内容证明；云核对服务器保留的源版 manifest 与策略，不信任客户端单方面声称“自创”、改名、换 ID、改公开/凭码。受限来源的作者技能、规则、记忆、任务、setup 与可识别的改写一律不允许借独立作品再次分发；缺失或混合来源无法证明自有时，拒绝相应导出/发布。可共享原链接，或仅发布可验证的自有内容并保留明确出处。无法靠指纹识别任意手工抄写，需有举报/强制封禁入口。开放来源也保留署名与第三方授予的实际范围。新衍生作品不得继承原作者 Logo。

**发码。** 权限与幂等性校验通过后，先锁作者额度，再锁版本可用数。按整批 1–100 枚检查版本同时可用上限 500、作者每日签发上限 500、作者累计签发上限 5,000，随机碰撞则重生。批次与新码、三个计数和回执同事务提交。计数包含每次凭码发布的首码。多人或多端同时操作不能越额，重试不重复累加。每日限额按服务器 UTC 自然日计算。可用明文以独立于 HMAC 的密钥逐码加密，可由作者复制，普通列表仅给短指纹。

**兑换与停用。** 先检查版本存在、访问类型与分发状态。同一事务序列化 `(account,version)` 的领取，已有授权立即返回。否则依固定顺序锁版本可用数和精确的 available 码，插入唯一 grant、标记 redeemed 和兑换者、减一枚可用数、清除该码可逆密文。停用、撤下停用未用码走相同锁顺序按实际变更的枚数释放可用数。不可逆摘要、归属和审计保留。签发日额与累计额度均不返还，已获授权独立保留。任何冲突或失败整体回滚。两账号抢同一码只成功一个，同一账号并发提交两码只耗一个。重试返回原 grant 或已失效状态，不泄露失效码。码错误或错版本用统一提示，已兑提示不披露他人身份。发码、试码按账号/IP/版本限流并记录无明文计数。原有 grant 不随新版升级，可在不同设备重新安装原版。普通撤下保留已有 grant 下载原版的能力，强制封禁按第 6 节停止分发。

## 5. 配方 Logo、封面与公开目录

Logo 是作者可以提供的公开资产。没传时使用默认图标，换图校验失败时保留草稿原图或默认图标；首页的大卡由界面模板排版，读取该版本的公开 Logo（或默认图标）、标题、简介、作者和版本。确认发布页按同一组字段预览。封面无须截图入库，服务端不读取私聊、任务、记忆或私有 Markdown 来合成图文。更新 Logo 时生成新版本资产，旧版本仍指向原图。

**临时上传与公开。** 首版只收静态 PNG/JPEG/WebP。原文件最大 2 MiB（2,097,152 字节），解码单边最多 2048 像素，总计最多 4,194,304 像素。服务端检查内容签名和真实解码结果，拒绝 SVG、动画、多帧、损坏或超限数据。移除 EXIF/ICC/其他非必要元数据，中心裁切为 192×192 方图并重编码为 PNG/WebP。成品最多 128 KiB，计入版本总量。作者确认页显示相同裁切结果。限制 CPU、内存与每账号并发，尺寸超限、解码超时或格式不支持时保留原图。

1. 作者领取绑定 owner/draft 的一次性上传票据（建议 10 分钟）。签发前在账号额度中原子预留上传名额和暂存字节，通过 API 中转到私有暂存桶。按实际入站字节截流、随机路径禁止 upsert，桶再限制 MIME 和最大对象大小。过期先停止接收。删除暂存并确认成品已挂草稿或转入其他预留后才释放对应字节。未引用的 verified 孤儿计入预留直到清理，不能因重试重复退额。若以后改用 Supabase `createSignedUploadUrl`，该 URL 本身有效 **2 小时**。10 分钟后可以拒绝 finalize，原 URL 仍可能写入。必须让预留覆盖实际可写窗口及清理期，并由存储端强制每张票据的字节上限。[Signed upload URL](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl)、[私有/公开桶](https://supabase.com/docs/guides/storage/buckets/fundamentals)
2. 草稿转码输出位于私有 verified 存储，记录 hash、尺寸、类型、字节数和 owner；同一用户重复提交可按 hash 复用。发布阶段先确保不可变字节就绪，后在事务写 `version_public.logo_asset_id`。面向用户的公开资源路由只为已发布且允许展示的版本返回已重编码的公开 Logo；不让用户列举原图或草稿 object key。若用 CDN，只缓存该路由返回的公开 bytes，带 hash 的 URL 可长期缓存；强制移除内容需要撤销路由并 purge 缓存，已下载副本不能远程收回。草稿预览、锁定配置、发码和会话响应设 `Cache-Control: private, no-store`。
3. 首页早期按实际发布数显示；存在编辑指定的、可见且仍为该配方当前发布版本时才标「场景精选」。指定版本已被新版取代、下架或不存在时，立即选最新可见配方并标「最新配方」；不自动把旧精选转移到新版。同一配方不重复陈列，返回仍可续翻。编辑操作有权限、审计、下架失效，不把用户自己的上传次序伪装成运营推荐。目录每个 recipe 只取当前公开版本；运营选择时必须钉住当时的当前发布版本并显示该版本，点击去该确切版本。在同一数据库快照内重验 current_version 和 listing 资格。目录非空即显示搜索；以后需要的分类应有受控词表，当前不强加标签。
4. 建索引 `(status,listed_at DESC,recipe_id DESC)`，按稳定的发布时间与 recipe_id 排序。默认首屏单独返回一张精选或最新横幅，其余列表排除该 recipe，每批默认及最多 8 张，可多探测一条决定 has_more。续页不再返回横幅。搜索与过滤不显示横幅，命中的原横幅配方可在其自然位置出现，仍按每批至多 8 张返回。0 份为空态，1 份普通首页只有横幅。cursor 为签名不透明标记，含固定排序、查询/过滤哈希、首次窗口上界、首屏横幅的 recipe_id（如有）与上次列表末项的排序键和 recipe_id。不同查询不得混用 cursor。使用 keyset 分页。初期允许发布/撤下后轻微漂移，客户端按 recipe_id 去重，刷新重建窗口，撤下项绝不补出。首版只搜限长的公开标题、摘要和作者，中文短词用实际样本验证，可按规模加 pg_trgm 索引。后续如引入相关度，排序需在 cursor 中保存稳定 rank 和 tie-breaker。

## 6. 运行成本、上线条件与退出

**成本快照（2026-11-13 官网）。** Supabase Free 官方配额包括每项目 500 MB 数据库、1 GB 对象存储、50,000 MAU、每月 500,000 Edge Function 调用。5 GB 常规出站与 5 GB 缓存出站分别计量，不把两项合并成可互换的流量。跨组织的两个活跃免费项目名额还和账号已有项目有关。免费项目可能在约一周不活跃后被暂停，不能以“早期用户少”推导稳定可用。MAU 统计登录用户，配方读取与下载另消耗算力和流量。[Supabase 计费与配额](https://supabase.com/docs/guides/platform/billing-on-supabase)、[存储出站](https://supabase.com/docs/guides/storage/serving/bandwidth)、[套餐及暂停](https://supabase.com/pricing)

- 起步采用一个生产项目、开发使用本地或独立测试项目，不为每个版本建环境。不保留原始聊天、不上传项目目录、不生成 AI 封面；每次明确操作才读取/写入。图片用已重编码小图，配方快照设大小/层数预算，清理临时对象，只有正在等飞书结果的前台客户端做带退避的轮询。暂不订阅全站 Realtime、不建立设备在线心跳。
- 监测每周数据库与对象字节、单次兑换/发码失败率、月累计函数调用、cache/uncached egress、三家登录真实回程、Apple 密钥有效期。用实际平均 Logo/快照大小和下载次数分别乘算存储及出站，不仅看 MAU。预算预警建议设 70%/90%，持续耗尽或业务要求长期可用、可恢复备份时，在 owner 审阅预算后改套餐；不得承诺永久免费或为防暂停造流量。地域与域名选择要从实际目标网络测试入口、三家登录、下载和回调，未实测地区不能承诺可达。还需单独确认平台条款、商店发布要求和适用的隐私/内容政策。
- 生产分开持有 OAuth client secrets、Apple `.p8`、DB/Storage 维护凭证、码 HMAC 与幂等回执加密密钥。用环境密钥管理、权限分工及 key version 轮换；授权码、refresh token、完整分享码、群消息、私有快照和原图不进日志。迁移/索引/策略版本化，先测试双身份与横向权限，再发布后端、最后发客户端。管理/上传端点的超量请求应限流而不是挤占匿名目录。
- **普通撤下**由作者操作，事务中停公开列表、精选、公开详情/全文、所有新领取和未用码兑换。无权者打开原链接仅见“已下架”；作者仍可从创作中心管理，撤下前已经持本版本 grant 的账号可以查看该版并再次下载。**强制封禁**由受控运营角色执行，停止全部云端分发，含既有领取者；保留最少记录供用户说明与处置复核。两种操作均不遥删已经安装的本机副本。按请求重新核验状态，并为旧 CDN 资源失效；已公开下载的内容无法追回，因此未来可能被撤下的完整 payload 不能被永久缓存。具体账号删除保留期限仍须在开放公众发布前定稿。删除账号要求近期再次认证，先失效应用会话，清私有草稿、暂存图、身份数据，已发布版本按已确认的下架及历史保留政策处理。已删除的主体不能认领旧作者资产。会话事务、上传票据、交接回执、幂等明文回执分别有 TTL。
- 备份覆盖 PostgreSQL 数据（包含必要身份映射、不可变版本、授权、码状态）、私有对象原始字节和成品、配置/密钥版本，但隔离存放。Supabase 的数据库备份不会带上 Storage 对象。定期恢复到隔离环境，并对样本进行版本哈希、历史授权、单次码并发和对象可读性验证；记录实测 RPO/RTO 后才承诺恢复指标。迁出时先冻结发布/兑换、做最终增量同步并对账，禁止两套服务同时消费同一批码；保留稳定的业务 ID/链接，轮换密钥、要求用户重登。换身份商时须证明原主体与新主体；不能按邮箱批量“找回”或隐式合并。[数据库备份范围](https://supabase.com/docs/guides/platform/backups)、[托管项目迁移](https://supabase.com/docs/guides/platform/migrating-within-supabase)

## 7. 首版验收门槛

| 用例 | 可观测结果 |
| --- | --- |
| 同邮箱跨三个提供方、GitHub 隐藏邮箱、Apple relay、首次无头像，以及账号 B 打开账号 A 的资料和草稿 | 同一已验证邮箱的 GitHub、Google 共享资产；独立账号 A/B 资产隔离。网页、macOS、Windows 对每种 provider 验真实回程、取消、过期、重复回调、跨端误开、注销。 |
| 用匿名、作者、未领用户、已领旧版、已领当前版五种身份请求详情、payload、对象、搜索和 CDN | 公开视图相同，版本正文逐次判权。普通撤下前的 grant 只可读其确切版本，强制封禁停止云分发。旧码/获赠旧版不开放新版；锁定字段不会出现在响应、搜索、错误、URL、对象列表或缓存。 |
| 两人同一码；一人两码；同时停用/兑换；提交后丢响应；同键异参发布；两个草稿同时更新同个版本 | 获胜者唯一、另一事务没有半成品；重试结果稳定、旧授权保留、冲突返回 409 后刷新。 |
| 草稿只剩一份时两个设备同时建稿；最后一小段字节上两份草稿同时扩写；上传票据到期且暂存回收失败 | 各维度不超额，失败端保存本地输入。同键重放不再占额，清理完成或已可靠转入其他计量才释放预留字节。 |
| 当日已发 499 枚、累计已发 4,999 枚时，两端分别发一枚码和发布凭码新版；把旧码停用后重试 | 只允许一个新码，失败的凭码发布保留草稿。停用、兑换均不恢复签发额度。次日恢复日额，累计额度仍为 5,000；已兑换的用户可继续访问其授权版本。 |
| 中途取消准备/安装，客户端离线，注销切人，飞书重复/乱序回执 | 准备状态与快照一致。不误发布、重复建草稿或向另一个账号泄露；已获 grant 可稍后使用。 |
| 假后缀/超尺寸/动画/跨账号取图，分层提交失败，换 Logo 后打开旧链接 | 验证失败保留草稿；发布后的公开图与作者确认时相同，历史版本显示当时的 Logo；隔离存储和权限可实证。 |
| 默认 0、1、少量、多页，搜索/过滤后翻页，编辑精选被下架 | 首页名副其实，卡片不重复，守住游标条件，最新页、旧链接、撤下和强制禁用行为分明。 |

容量、并发占额、错误响应、保留和缓存的实施标准见[限额与留存](limits.md)。
