# 已绑定 Bot 群的配方安装

## 1. 做什么

主人可以把已取得的不可变配方版本装进一个 Bot 已绑定的现有群。安装保存这个绑定行的补充职责、文字准备指引和来源，并在中断后查询或恢复同一个操作。

依赖账号映射、不可变版本及取得权。云端授权契约见 `docs/design/accounts-recipes/install-operations.md`。桌面账号认证与原生社区界面由同一集成批次的其他片负责。

## 2. 范围

本片包含 purpose 专用 RPC、精确清单校验、X25519 持机证明、本地准备、角色三方比较、原子提交和持久回执。只处理现有非私聊绑定。Bot SOUL、全局权限、调度器、其他 Bot 和共享工作区不在写入范围。

setup 只保存现有 `config.setup.steps` 的 `kind/title/instructions/check/required` 文字。不会执行指令、启动任务或申请工具权限，也不按步骤下标继承跨版本完成状态。

## 3. 现在的代码

`project/registry.ts` 是 projects.json 的唯一事务写入口，已经持有跨进程 projects 锁并保留顶层未知键。`config/bots.ts` 保存注册 incarnation。`bot/context-assembly.ts` 的 `supplementOf` 决定实际补充职责，兼容迁移前的 `profile.persona`。

`remote/device.ts` 已保存本数据根的 X25519 密钥。`server/authz.ts` 逐项声明 RPC 权限，`server/http.ts` 分发客户端请求。安装使用内部 `groupMembership` 操作，在运行中的对应 Bot 比对可信注册身份，只调用真实 `chatMembers.isInChat`。不读取成员列表，不要求列表权限。

## 4. 怎么改

为每个绑定行保存不可变 `bindingIncarnation` 和递增 `projectSettingsRevision`。新建绑定生成新 incarnation，改名保留，解绑后的重建不复用。所有设置写入在 registry 的统一入口维护 revision。

安装状态是 `prepared → in_progress → applied/rejected`。每个 operation 使用一次 UUIDv7、私有随机 32 字节 nonce 和 SHA-256 commitment。准备捕获可信 Bot 注册身份、binding incarnation、settings revision、完整行摘要、本机公钥和精确 manifest。manifest 先验原始字节摘要，再严格解析，职责最多 5,000 Unicode 码点。

首次安装的现有职责为空时，在正常安装确认中采用 incoming；现有职责非空且不同时，必须明确保留、替换或提供合并文本。review 返回绑定可信 Bot 身份、绑定 lifetime、设置摘要、账号、设备公钥及精确 manifest 摘要的 reviewToken。带 resolution 的准备必须原样带回该 token；缺失或过期返回新 review，不生成操作和 nonce。历史绑定在第一次 review 前先持久补齐 incarnation 与 revision。同配方同版本直接返回打开群设置的目标，不刷新来源元数据。其他配方占用时拒绝。更新比较 base、当前本地值和 incoming，双方冲突时要求明确解决，setup 按整体结构比较。

同配方的 incoming 发布 revision 不得小于当前安装 revision。准备阶段在创建 nonce 或操作前拒绝降级；提交阶段再次检查，不能用先前准备的旧版本覆盖之后安装的新版本。

同账号、可信 Bot/绑定、完整设置、精确清单及相同选择的五分钟内 unissued 准备，复用原 UUID 和 nonce。确知尚未发起授权的 unissued 过期后转为 rejected；旧 UUID 不重新登记。Main 发起云 authorize 前，必须先调用 issuing RPC 并等待持久化成功。issuing 只能在原五分钟窗口内开始，此后即使尚未取得票据，也不能据本机时间猜测是否签发，不能自动过期或回收。迟到的合法授权继续原操作；历史缺少 issuerState 的无票据记录按 issuing 不确定状态处理。

status 返回 issuerState（unissued、issuing、authorized）及 stillNeedsTicket。无票据 issuing 保持 prepared 且需要票据；已有授权返回 in_progress。已显示 applied 的本地事实仍可能需要补齐云回执，Main 清理 journal 前重发原 commit，不能只凭一次 status 读取宣称云回执已确认。

当前注册的所有 Bot 合计每账号最多三个活动操作，包含 issuing、不确定授权和仍待提交云完成回执的终态；每 UTC 日最多创建六十个新本机准备，重试不计数。准备、issuing 及授权的活动增加均受 bots 锁保护，跨 Bot 配额读取只会与减少活动的操作并发。删除安全 Bot 会同时删除其本机每日计数，本机计数不是永久防绕过凭据；云 API 独立强制真实账号每日六十次上限。

每个 Bot 的账本新建准入受 512 条和 8 MiB 双重上限约束，体积包含格式化存储及每条未来授权/终态的预留。只有超过八天、无需云完成回执的安全终态才回收。授权状态不明、已兑换或 cloudCompletion required 的记录不会被清理；无法安全腾出空间时拒绝新准备，原操作仍可恢复。每日预算只保留当日计数。

prepare、apply 固定取得 bots 后取得 projects，两次均在锁内向真实 Bot 核对群成员身份，并以十秒期限释放卡住的核验。准备核验失败不创建操作和 nonce。提交重新核对注册身份、绑定 lifetime、revision 和完整设置摘要。唯一一次 fsync 后的 rename 同时写 supplement、recipeInstall base/来源和 applied/rejected receipt。回执位于 projects.json 顶层，解绑不会删除。所有 projects.json 临时文件使用 0600，普通设置改写也保持 nonce 私密。恢复读取在 projects 锁内再次同步实际 registry 文件和目录；持久化错误未解除前不返回终态成功，也不向云端提交 applied。

daemon 只使用配置的 HTTPS origin。测试可显式允许 loopback HTTP。请求拒绝重定向，不发送 JWT。Scoped ticket、nonce 和 X25519/HKDF/HMAC 证明用于 redeem/complete。兑换成功只表示进行中。本地 CAS 拒绝会持久记录 rejected。响应丢失后复用同一操作和凭据；本地已应用时只重发完成回执，不重复写职责。

取消只在确知未发起授权的 unissued 状态直接终结。issuing 无票据保持不确定 prepared；已有授权、兑换已发出或已兑换时保持进行中，主人由主进程凭当前账号请求云取消，再恢复原操作。daemon 的 reconcile RPC 自己向固定服务的 `/v1/operations/:id/unredeemable` 发出原 accountId 查询。只有匹配 operationId 且永久无法首次兑换的明确 true 才能关闭未兑换操作；unknown/false 或任何异常都不能作为取消成功。请求不接受界面自报云结果。精确的云端 operation_cancelled 或 operation_expired 也可以终结尚未兑换的本地操作。独立的 cloudCompletion 保存 none、required、confirmed，只有已兑换的终态才需要提交 complete，云端预兑换取消和本机提前取消均不提交 complete。

正常删除 Bot 在既有 bots 锁内先取得 projects 锁检查账本。issuing、授权不确定或 cloudCompletion required 会阻止删除，并提示恢复或取消原操作；检查发生在删除 keystore 凭据和 Bot 目录之前。issuing/授权增加同样取得 bots 锁，检查之后不能抢先新增不安全能力。安全终态确认后可沿用正常删除路径，不引入两文件提交协议。

## 5. 测试

主分支缺失的行为包括原子 receipt、解绑 ABA 防护、注册 incarnation 防护、同群双 Bot 隔离、legacy persona 读取、5000/5001 Unicode 边界及 purpose/key/nonce 绑定。增加真实 registry 文件测试和独立子进程在 rename 前后退出、重新启动恢复的测试。

测试还覆盖空职责采用、非空职责明确选择、review 与准备之间的编辑及解绑/重注册、并发编辑 CAS、三方合并、不同配方占用、相同版本不改元数据、setup 新版本不继承下标状态、错误兑换清单不落盘，以及完成响应丢失后恢复。目录同步 EIO 必须阻止可见终态和云 applied，解除故障后的重试只确认持久化，不重复应用。取消覆盖授权前、授权后尚未发送、等待兑换响应、已兑换、重启及终态；兑换前取消不会错误提交 complete。跨端黄金样例使用公开 RFC 7748 测试密钥。现有 authz、CLI parity 和 Bot namespace 测试继续运行。

## 6. Codex 的自测

Mac Codex 使用临时隔离数据根和虚构 Bot/group，不启动 owner daemon，不改 owner 数据，也不向飞书群发消息。真实云 API 的账号验证及桌面界面流程属于同批集成验收。此片只用测试内传输验证 scoped HTTP 契约；真实 `isInChat` 路径复用现有 Bot group executor。

## 7. 文档

本计划记录本片边界与验证方式。生产配置的 API origin 与嵌入方式见 `docs/plans/recipe-deployment-origin.md`。不把准备指引当作已经完成的环境检查，不声称本片完成公开部署或 owner 真实群验收。

## 8. 验收要点

- RPC 只能由 owner 发起，Bot session 的私聊、群聊和评论均拒绝。
- daemon 请求没有账号 JWT，nonce 和设备私钥不进入 RPC 回复。
- 一个 rename 同时写职责、base、来源及操作终态，重启后能读取同一回执。
- 解绑重绑、Bot 重注册及并发设置改动均不能被旧操作覆盖。
- setup 是有类型的只读文字，不执行，不改变权限或调度。
- diff 不含真实身份、密钥或 owner 机器路径。

## 9. 风险和行数

预计约 1,500 行，分为 protocol/RPC、纯本地事务与限额、proof/HTTP 和安全测试四个审查单元。风险是跨进程写入、关闭中断和错误路径。独立审查应按这四个单元检查准确提交，并确认 API、desktop 与 daemon 的清单、回执和证明黄金样例一致。

吞吐安排先固定云契约和项目事务入口，再并行推进云端、daemon 及桌面界面。共享 registry 写操作只在现有跨进程锁内进行。此片由一个 owner 维护同一文件集，避免多个代理同时改事务入口。
