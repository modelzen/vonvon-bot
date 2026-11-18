# 主人过去的产品思路，以及 v2 有没有继承

路径缩写：`LEG`=/home/operator/vonvon/vonvon-bridge-legacy，`BOT`=/home/operator/vonvon/vonvon-bot，`FCB`=/home/operator/vonvon/feishu-codex-bridge。
文档缩写：PRD=`LEG/docs/product/vonvon-bridge-v1-prd.md`，FRD=`LEG/docs/product/first-run-main-flow-decisions.md`，REC=`LEG/docs/product/v1-prd-reconciliation.md`，V9=`LEG/docs/product/vonvon-bridge-commercialization-loopx-plan-v9.md`，DP=`…/vonvon-bridge-commercialization-decision-packet.md`，FOP=`…/vonvon-bridge-founder-operating-plan.md`，OR=`…/vonvon-bridge-paid-pilot-owner-review-v1.md`，ARCH=`BOT/docs/architecture.md`，RM=`BOT/docs/roadmap.md`，PLAN=`BOT/docs/plan.md`。

## 结论先说

- 约 4.5 个月里有五次产品尝试。每次替换都推翻了上一版至少一条产品决定。"是否必须登录"前后翻了 5 次，见第 1 节末尾。
- 关于"产品长什么样"，目前最完整的草稿是 legacy 的 FRD。它写清了首次设置路由、"设置完成"和"首次成功"的标准、修复流程。但 FRD 自己声明它是目标，代码没有实现（FRD:18），真实飞书端到端验收也一直没做（`LEG/README.md:64`）。
- v2 没有引用 legacy 的 PRD、FRD、REC 和任何商业化文档，只在推翻 ADR 0012 时提到它（ARCH:169，PLAN:2065），另外引用了 legacy 的迁移代码和账号服务代码。我在 `BOT/docs/*.md`、README、AGENTS.md 里搜过 `prd|first-run|首次|commercial|付费|pilot`，没有命中这些文档。

---

## 1. 产品尝试时间线

| # | 尝试 | 时间（首次到末次提交） | 规模 | 形态 | 为什么被替换 |
|---|---|---|---|---|---|
| 1 | **feishu-codex-bridge**（唯一发布的产品） | 2026-05-26 `0169786` 起；main 最后一次发布 0.6.14 在 2026-09-24（`6698118`）；分支最晚 2026-10-11 `ba7f5f8`（codex/v9-owner-notice，未合入） | main 283 个提交，全部 ref 387 个；main 约 6.4 万行 TS/JS；npm 共 56 个版本 | Node CLI 加本地 Web 控制台，MIT 协议（`FCB/LICENSE:1`）。项目=群=固定 cwd，话题=会话（`FCB/README.md`） | 没有被下线，到现在仍是唯一的发布版本。替代它的理由见 PRD:12：普通用户要理解全局安装、后台服务、权限、事件订阅等，成本太高。v2 计划让它的最后一个版本引导用户迁到 Vonvon Bot，并在迁移后拒绝启动（RM 的 V9 行；分支 `ba7f5f8` "refuse startup after Vonvon Bot import"） |
| — | vonvon-site（官网和文档站） | 2026-06-24 `c6617d7` → 2026-09-18 `aff1e49` | 72 个提交 | bridge.vonvon.cc 的文档站，2026-07-07 `b98754a` 上线；2026-08-11 `dfe46d7` 加了账号页面体验 | — |
| — | vonvon-platform（账号和控制面） | 只有 2 个提交：2026-07-21 `f3e271c`、2026-09-18 `3427634` | 约 1.3k 行 | 飞书/Lark 网页 SSO、设备身份、在线控制面；云端存脱敏快照，远程命令不排队（`vonvon-platform/README.md:3,30-34`） | legacy 的 ADR 0010 改用 Supabase 邮箱密码登录，取代了 ADR 0002 的飞书身份登录（`LEG/docs/adr/0010…:3`）。v2 又回到飞书/Lark SSO，复用它的 `src/oauth.ts`（ARCH:165，PLAN:2125） |
| 2 | **vonvon-bridge-legacy**（闭源 macOS 桌面版） | 2026-07-21 `f1b401b` → 主要开发到 2026-08-14 `9a18173`；2026-09-18 "迁移前存档"`d7c6867`；2026-09-24 `3a16853` "legacy repository rename" | main 46 个提交；约 9.5 万行 TS/TSX/RS（不含 vendor）；约 1.38 万行文档 | Tauri 2 + React，菜单栏常驻，内置 Node sidecar，精确固定公共 Runtime 版本（`LEG/README.md:3-11,46`；ADR 0007、0009）。Apple Silicon，另有 Windows x64 提交 `8ebb7cf`、`ef43482` | **仓库里没有写明替换理由**。能看到的只有：真实迁移、飞书端到端、签名公证都没完成（`LEG/README.md:64`）；09-24 改名为 legacy，同一天 vonvon-bot 建仓并开了 Electron 版的 PR #2。"迁移前存档"指什么也没写 |
| 3 | **vonvon-bot 旧 Electron 版**（PR #2–#19，分支 `origin/codex/device-handoff`） | 2026-09-24 `8c8fc9e` → 2026-10-09 `fab5237` | 76 个提交；约 1.47 万行 TS，另外 vendor 了 bridge 内核 | Electron 44 + React 19，面向 macOS 和 Windows，"让新老用户都能在不打开终端的情况下完成第一次飞书协作"，"本地功能无需产品账号"（该分支 `README.md:3,15`） | 2026-10-10 被 v2 取代，理由是 vendor 内核时，每改一处都要 bridge 发版再 pin 版本（ARCH:81，PLAN:2061），桌面端、CLI、网页三方争写同一份数据（ARCH:51），Linux 上跑不起来（ARCH:311）。PR #2–#19 到今天仍是 OPEN，从未合入（`gh pr list`）。RM:107 写的是"V4 合并、界面移植完成后关闭"，V4 的 #69 已在 10-11 合入 |
| 4 | **vonvon-bot v2**（独立 daemon） | 2026-10-10 `20b3224` → 今天 | 已合入 53 个 PR；main 约 10.4 万行 TS（含复制进来的 bridge 内核）；没有 release 或 tag | 照搬 Paseo 结构：每台机器一个 daemon，Electron、网页、CLI 都是它的客户端；云端账号可选并做端到端加密中继（ARCH:15-43） | 进行中。V5 外壳和服务、V6a/V6b provider 在飞；导入 V8、账号 V10、远程 V11 都没合入（RM:24-26，open PR #285、#281、#110） |

**登录立场的反复**（同一个问题翻了 5 次）：
1. PRD：可选登录，首页是登录页但有弱化的"暂不登录"，最多 2 台设备（PRD:26-29,177-178）。
2. 2026-08-04 版 FRD：登录完全不阻塞，设置完成后才提示一次（`git show 6cd64ec:…first-run…md` 第 37、207-210 行）。
3. 2026-08-05 商业化计划：免费核心"不强制注册 Vonvon 账号"（`…commercialization-plan.md:113`）。
4. 2026-08-10 ADR 0012（`43adae3`）：必须登录，未登录时 fail-closed，推迟多设备。
5. 2026-09-24 旧 Electron 版："without a local product account"（PR #2 描述）。2026-10-10 v2：可选登录，"推翻了这条决定"（ARCH:161-169），PLAN:2065 写的是"The owner chose optional login"。

---

## 2. legacy 文档里记录的产品决定

**来源强度**怎么判断：legacy 的 46 个提交作者都是主人的 git 身份（`git log` 统计），所以从作者看不出是谁写的。文档内部的说法分三档：
- **[主人确认]**：FRD 自述"把已经在讨论中确认的规则从聊天记录中固化下来"、"以用户最后一次明确确认的产品决策为准"（FRD:14,18）；REC §2 是"已经在最新讨论中重新确认"（REC:46）。
- **[授权采纳]**：REC §3 是"按用户授权采用推荐方案，不再逐项等待确认"（REC:117），也就是 agent 推荐、主人统一授权，不是逐条拍板。
- **[主人原话/主人提问]**：DP 的"用户要求"一栏（DP:29-41）是主人提的问题，结论是 agent 写的；"用户提供：下载量超过 8,000、文档访问接近 10,000"（`…commercialization-plan.md:31`）；"2026-08-05 按用户再次纠正"（`…loopx-goal.md:3`）。

| 主题 | legacy 的决定 | 来源与强度 |
|---|---|---|
| 目标用户 | 觉得 CLI 难装难用的普通用户，以及要迁移的现有 CLI 用户（PRD:12-16，用户故事 9-23）。商业化阶段改为：有部署摩擦的团队负责人或技术负责人，先从不超过 5 个现有 Bridge 用户、至少 3 个组织里找（V9:66-68，OR:15-20,57-67）。社区证据：群里 1,904 人，反复出现安装、服务器常驻、多人 Session、权限问题，有"20 多名实习生共用一个项目群"的场景（V9:20，`…commercialization-plan.md:34`） | PRD 已作废；画像是 agent 根据社区证据推出来的 |
| 定价 | 免费核心，不按项目收费，否决"3/5 个项目收费墙"（V9:9-18,50；`…loopx-goal.md:19-21`）。第一阶段只卖服务：诊断 ¥299、安装迁移 ¥699、30 天团队试点 ¥1,999；Workspace 年费等至少 3 个组织付费并有续费再说（DP:47-53，V9:85-105）。桌面版免费，界面不显示套餐、不预告功能（ADR 0012:7-11）；"超体版"不定义、不售卖（ADR 0013:15-17） | 免费核心和不按项目收费是[主人原话/纠正]：DP:31-32 的"用户要求"，加上 `loopx-goal.md:3`。具体价格标明"不是市场已验证价格"（DP:45） |
| 付费试点 | 对外触达需要主人批准（OR:9-24,140-154）。截至 2026-08-05，"仍停在外部试点触达的用户批准门槛，未产生付款证据"（FOP:93，DP:9）。之后主人是否批准，仓库里没有记录 | 待主人决定，未决 |
| 经营方式 | 不辞职、不招人，每周 6–8 小时，最多同时 2 个试点（FOP:7-9，V9:123-129）。官网直接分发签名公证的 DMG，Mac App Store 不作首选（V9:117-119）。大陆收款走合法主体加对公转账，香港银行卡不等于有商户资格（V9:109-115） | DP:38-40 的"用户要求"是主人提的问题 |
| 登录和账号 | 最终是 ADR 0012：必须登录，未登录时本机 Bridge fail-closed；退出登录时停 Runtime 但保留数据（ADR 0012:13-17）。登录方式：账号网站邮箱密码（Supabase），系统浏览器 OAuth PKCE（ADR 0010:6-16），加 GitHub/Google（ADR 0011:5-10）。账号叫"Vonvon Bridge account"，唯一站点 bridge.vonvon.cc（ADR 0013:3-13） | ADR 没写是谁决定的。REC:48 把"必须登录"列为[主人确认] |
| 多设备 | PRD 原本最多 2 台设备、只能从另一台桌面远程管理、改设备要短信验证（PRD:177-178,265）；ADR 0012 全部推迟，桌面不调用任何设备接口（ADR 0012:19-25） | [主人确认]（REC:83） |
| 平台 | 当前验收产物是主人本机 macOS 26 Apple Silicon 上能跑的 `.app`；对外 beta 先做 macOS 14+ Apple Silicon，再验证 Intel，然后 Windows 11 x64（FRD:39，REC:59-60）；不承诺 Linux 桌面版（REC:147） | [主人确认] |
| 首次设置流程 | 见第 4 节 | [主人确认]（FRD 整篇） |
| 主流程 | 飞书是唯一的工作界面；桌面端不做聊天；私聊只当管理台（FRD:486-491，REC:56,82） | [主人确认] |
| 必备功能 | `feishu-codex-bridge` 已有的用户可见能力默认全部继承，不逐项再确认（FRD:27-33）：流式卡片和停止按钮，goal、steer/queue、model、resume、clear、compact、context，图片、文件、引用，云文档评论 @ 机器人，会话标题，"咖啡一下"Hook 审批、提问、完成卡片，多机器人隔离，权限分档和白名单（REC:96-113） | [主人确认]，规则是默认继承 |
| 桌面端的角色 | 菜单栏常驻；关窗口只隐藏；Quit 才停 Runtime 并退出；设置完成后默认开启登录时启动（FRD:401-422）。负责安装、配置、运行、诊断、迁移；检测并辅助安装 Codex、Claude、lark-cli，但不建 Vonvon 私有副本、不附带 Node（FRD:41-49）；Agent 登录在终端里做（FRD:249-252）；更新只在用户点"立即更新"后下载（REC:140） | [主人确认]，其中更新一条属于 §3 [授权采纳] |
| 隐私 | "Vonvon Bridge 是连接产品，不是云端数据库"（PRD:336）；云端不存密钥、路径、消息、会话、日志（REC:131）；不做自动遥测（PRD:259） | PRD 原则，被 REC 沿用 |
| 团队协作的长期愿景 | `LEG/docs/research/vonvon-bridge-agent-first-team-collaboration-v1.md:16-19`：让飞书成为人和本地 Agent 一起工作的"协作操作系统"，引入 AgentTeammate、WorkItem、claim、review | 调研报告里的建议，不是主人的决定 |

---

## 3. 和 v2 的对照

### 继承下来的
- 飞书是工作界面，桌面端和网页不聊天（ARCH:9 对应 PRD:169）。群=项目=cwd，话题=会话（ARCH:7）。私聊卡片做管理（ARCH:92,236）。
- 本地优先。v2 更严格：云端不存设置，连快照也不存（ARCH:85-87,173），legacy 还存最小脱敏快照（PRD:254-255）。
- 一次性导入：先预检、确认后先停旧服务再复制，App Secret 重新加密，原始数据不动，失败就恢复，过程写 journal（ARCH:145-159），实现上参考 legacy 的迁移代码。
- 扫码人就是机器人 owner（`Bot.ownerOpenId`，ARCH:202）。一个 Bot 只在一台机器上运行（ARCH:179），但只做客户端提示，legacy 是硬约束（FRD:428）。
- 关窗口或退出桌面端时 Bot 继续运行（ARCH:53）。这比 legacy 走得更远，见下一节。
- 会话标题保留，作为 Vonvon 自己的功能（ARCH:127）。"咖啡一下"的 Hook 在导入时改写成 `vonvon hook`（ARCH:151，PLAN:1810）。

### 和 legacy 冲突的
| 主题 | legacy | v2 | v2 是否交代 |
|---|---|---|---|
| 登录 | 必须登录（ADR 0012） | 可选；不登录也能完整用，包括导入（ARCH:161-163） | 有交代，并写明推翻（ARCH:169，PLAN:2065 "The owner chose optional login"）。PR #21 描述也写了"账号是可选的" |
| 登录方式 | Supabase 邮箱密码加 GitHub/Google，站点 bridge.vonvon.cc（ADR 0010、0011、0013） | 飞书/Lark 网页 SSO；没有桌面的机器用 `vonvon login` 设备码（ARCH:165） | **没交代**，没提 ADR 0010、0011、0013，只在阅读清单里列了 `docs/adr/`（PLAN:2124） |
| 平台 | macOS 优先，再 Windows，不承诺 Linux（REC:147） | macOS、Linux、Windows 都跑完整 daemon 和网页，明确支持没有桌面的服务器（ARCH:139,311） | 没提 legacy 的平台决定。不过 legacy 自己的社区证据里就有"服务器常驻、Docker/云服务器团队部署"的诉求（V9:20,66，OR:41） |
| 远程管理 | 浏览器和手机端远程管理不在范围内，手机继续用飞书（PRD:317，REC:149） | V10 机器列表，V11 云端托管网页加端到端加密远程访问（RM:25-26，ARCH:171-179） | 没交代 |
| Quit 的含义 | Quit 停止 Runtime（FRD:405，PRD 用户故事 6） | 退出应用后 Bot 继续运行，前提是开了开机自动运行（PLAN:1199，ARCH:53） | 没交代 |
| 旧 CLI 的去留 | 不发布 CLI 废弃公告，桌面停止后旧 CLI 仍能跑（PRD:141,204,329） | 导入后永久移除 bridge 自启并写标记；bridge 最后一版引导迁移、发现标记就拒绝启动（ARCH:11,153，RM:24） | 没交代。PRD 本身已作废，但 REC 也没恢复这一条 |
| 权限 | 管理员和访客分档、响应白名单；"咖啡一下"有审批卡（FRD:475-484，REC:103） | 只有 qa、write、full 三档加读取范围，provider 的审批请求由 daemon 自动应答，"没有审批卡"（providers.md:15，PLAN:2103） | 有交代，是主人 2026-10-12 的决定（providers.md:15）。本地会话通过"咖啡一下"弹出的审批卡还保不保留，v2 没写 |
| Agent 安装和登录 | 用户在终端登录；不建私有副本（REC:18,33） | 继承了旧 Electron 版的 `install`、`startLogin`、`loginStatus` 等 RPC（PLAN:807）；旧 Electron 版自称"提供私有安装与设备码登录"（device-handoff 分支 `README.md:11`） | 没交代（v2 有没有用私有 prefix 我没核实） |
| Provider | 只有 Codex 和 Claude | Codex、Claude Code、Cursor、Grok、Pi、自定义 ACP（ARCH:35,119-131） | 有交代，是主人的决定（providers.md:15） |
| 外壳和数据目录 | Tauri，平台应用数据目录（`LEG/README.md:31-35`） | Electron，`~/.vonvon-bot`（ARCH:139,189） | 数据目录有理由（ARCH:139），Tauri 换 Electron 在三个仓库里都**找不到理由** |
| 更新 | 只在用户点"立即更新"后下载（REC:140） | "自动更新沿用 `desktop/main`"（ARCH:191，PLAN:1192） | 会不会自动下载，没写清楚 |

### 没说一声就丢掉的（v2 文档里找不到对应内容）
- 首次设置的步骤和路由优先级表（FRD:159-179），"设置完成"的三个条件（FRD:96-104），"首次成功=在项目群发出真实任务并收到回复"和建议任务文案（FRD:106-120）。旧 Electron 版还保留着这一条（device-handoff 分支 `README.md:15`），v2 只有一行"Add the import step to first-run onboarding"（PLAN:1792）。
- 概览页上不能永久关闭的"完成设置"卡片，"修复而不是重建"，"完整性和健康状态分开"（FRD:122-131,653-672）。
- lark-cli 是推荐依赖、不阻塞设置（FRD:290-311）。v2 只验收环境页能显示 lark-cli 版本（PLAN:862）。
- 主动发起的"测试可用性"请求（FRD:238-247）；10 分钟内失败 3 次就停止自动重试（REC:136-137），在 ARCH 和 PLAN 里都搜不到；设置完成后默认开启登录时启动（FRD:406）。
- 所有商业化决定：免费核心、不按项目收费、服务定价、付费试点门槛、bridge.vonvon.cc 账号站点、"超体版"禁令，v2 一个字都没提。
- 不做自动遥测（PRD:259），v2 没写。
- 团队协作和 AgentTeammate 的愿景调研，v2 没提。

---

## 4. legacy 描述的首次流程和主流程

> 依据是 FRD（已扣除被 ADR 0012 改掉的部分，FRD:3-5）。FRD:18 声明这是产品目标，不代表代码已经实现。

### 4.1 首次设置流程（FRD:35-92,159-192）
1. **登录门禁**：打开应用，没有有效的 Vonvon 会话时只显示独立登录页，没有跳过入口。在系统浏览器完成 OAuth，可以取消本次授权，但进不了本机功能（FRD:208-215,683-686；ADR 0010:11-16）。
2. **设置助手第 1 步：导入 Bridge 数据**。这是一个窄长窗口，没有侧栏，也不显示交通灯按钮。只有在"没有 Vonvon 业务数据且存在有效的 CLI 数据"时才出现。界面只有一个问题、一句安全说明、来源和机器人/项目/会话数量摘要、隐私说明、主按钮"导入原来的数据"和弱化的"暂不导入"（FRD:183-187）。
   - 如果 CLI 正在运行：先单独确认"停止 feishu-codex-bridge"，停止成功后才能选导入或重新开始（`LEG/README.md:52`）。
   - 导入的过程：停旧 CLI，取消它的开机自启，复制数据并重新加密；失败就恢复旧状态（FRD:353-358）。
   - 选"暂不导入"后，概览页仍保留导入入口。创建第一份业务数据前会再确认一次，确认后导入入口永久关闭（FRD:340）。
3. **设置助手第 2 步：准备本机环境**。检测 Codex（Codex App 内置的运行时也算）、Claude、lark-cli。只要有一个 Agent 通过官方状态命令（`codex login status`、`claude auth status --json`），"下一步：添加机器人"就可用，但不会自动前进（FRD:189,228-236）。
   - 缺工具时用用户自己的 Node/npm 辅助安装，不用 sudo；缺 Node/npm 这类前置条件时只提示。
   - Agent 登录让用户在终端完成，界面显示命令和"重新检查"按钮（FRD:249-252,267-276）。
   - lark-cli 只是推荐项，可以选"暂不安装，继续设置"或"在这台设备上不再主动提醒"（FRD:307-311）。
4. **第 3 步：添加机器人**。在真正的主界面里做，用遮罩和聚光框引导（FRD:190）。
   - 扫码同时创建飞书应用，扫码人成为不可转让的永久管理员（FRD:435-441）。
   - 凭证验证通过、保存后，Runtime 自动启动，这发生在创建项目之前（FRD:411-413）。
   - 如果旧 CLI 正在运行，二选一：停止旧版，或取消本次启动（FRD:415-418）。
   - "配置完整"的标准：凭证有效、必需权限齐全、必需事件已订阅、应用已发布（FRD:495-500）。
5. **第 4 步：创建项目**。填写：飞书群（新建，或绑定机器人已加入的群，不用手填 chat_id）、机器人、Agent（Codex 或 Claude，建好后固定）、工作目录（新建空目录或用已有目录）、会话模式（单会话或按话题多会话）（FRD:544-552）。
   - 另一个入口：机器人被拉进一个新群时，私聊里收到绑定卡片，桌面端同时出现待办，两边谁先提交谁生效，有效期 24 小时（FRD:585-612）。
6. **首次成功**：三个必需项（至少一个可用 Agent、一个配置完整的机器人、一个完整项目）都满足后，进入首次成功引导。
   - 给出可复制的建议任务："请先浏览当前项目，概括它的目录结构，并告诉我建议从哪里开始。"
   - 用户自己打开项目群并发出这条任务，桌面端不代发；群里收到 Agent 的有效回复才算成功（FRD:96-120）。
   - 这一步不插入账号或多设备推广（FRD:192）。
7. 第 3、4 步可以跳过。跳过后概览页顶部保留"完成设置"卡片，能折叠，不能关闭，点击后回到上次没完成的那一步（FRD:191,657-672）。设置完成后默认开启登录时启动（FRD:406）。

### 4.2 日常主流程
1. **常驻**：应用在菜单栏常驻，关窗口只隐藏，Quit 停止并退出。Runtime 记住用户最后一次希望它运行还是停止（FRD:403-410）。
2. **在项目群里干活**：发消息（可以免 @），机器人在群绑定的 cwd 里跑 Codex 或 Claude。
   - 卡片实时显示推理、工具调用、改动和结果，可以一键停止。
   - 支持 goal、steer/queue、model、resume、clear、compact、context。
   - 能处理图片、文件、引用；多话题群里一个话题就是一个会话（REC:100-113；`vonvon-site/_shared/content.md:30-45`）。
3. **云文档评论**：在评论里 @ 机器人，它按该机器人的评论配置调用 Agent，在原评论下回复，也可以按提示词直接改文档（FRD:458-465）。
4. **私聊只做管理**：设置、诊断、绑定卡片、管理员操作、"咖啡一下"卡片，不在私聊执行项目任务（FRD:486-491）。
5. **"咖啡一下"**：人离开电脑后，本机 Codex/Claude 的审批、提问、完成事件以卡片发到机器人永久管理员的私聊；以第一个有效回复为准；没有接收者或发送失败时立刻交回本机处理（FRD:475-484）。
6. **桌面端管理**：管理机器人（启停、管理员、按机器人设置并发/排队/watchdog、评论、标题、"咖啡一下"）和项目（换机器人或目录、权限、白名单、话题和会话）。
   - 对象失效时走"需要修复"，不重建。
   - 后台每 10 分钟复检一次；10 分钟内失败 3 次就停止自动重试（FRD:443-456,504-538；REC:136-137）。
7. **退出登录**：停止 Runtime，保留本机数据，回到登录页；重新登录后按之前记住的状态恢复（FRD:217-222）。


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：## 总评

报告的主线站得住：

- legacy 的 FRD 是唯一完整的产品形态草稿，没实现，也没做过飞书端到端验收。
- v2 不读 legacy 的 PRD、FRD、REC 和商业化文档，只在推翻 ADR 0012 时提了一句。
- 商业化停在主人批准门槛，没有付款。
- 旧 Electron 的 PR 栈仍然开着。

这些都对得上原文、git 和 gh 的输出。

## 需要修正的地方

**1. 数字和计数有夸大。**
- \"五次尝试\"实际是表里编号的 4 次。
- \"登录翻了 5 次\"实际是 3 次反转。
- v2 约 10.1 万行 TS/TSX，其中约 4.2 万行是测试。
- FCB main 的起点和分支最新提交都写错了。

**2. 来源强度给高了，这一条最影响决策。** REC:48 的\"必须登录\"和 REC:83 的多设备推迟，是 ADR 0012 那次提交（43adae3）在\"已经在最新讨论中重新确认\"这个旧标题下原位改写的。REC 自己也把登录门禁归在 §3\"按用户授权采用推荐方案\"之下。所以\"必须登录\"不能当作主人确认的决定。它还违反了 5 天前 V9:17 的原则：不能用登录状态切断前身已经免费的能力。

**3. 冲突表里有两项判断要改。**
- **Agent 私有安装：** 报告说没核实。我核实了，v2 确实用了 `managed-tools` 私有目录，推翻了 REC:62，文档没交代。
- **自动更新：** 代码里只在用户点安装后才下载，和 legacy 一致，不算冲突。

## 报告漏掉的、对策略最重要的事实

**1. 唯一发布的产品 FCB 已经停更三周。**
- 有 11 个没合入的 PR，包括用户要的功能和稳定性修复。
- 有 15 个 OPEN issue，其中有外部用户 09-24 到 10-02 提的 bug 和需求。
- 81 star，22 fork，最后一个版本是 09-24 的 0.6.14。

**2. v2 的 main 上已经有可以看的界面，但没有试用入口。** README 还停在 V1，这和主人说\"看不到能试的东西\"直接相关。

**3. v2 自己的决定记录也是 agent 写的。** plan.md:9 的分工说法已经过时，v2 关于 Quit 的说法有三种。v2 的产品决定和 legacy 一样，需要主人逐条明确确认。


### 逐条复查

- **说过头了**：约 4.5 个月里有五次产品尝试
  - 依据：表格本身只编号了 4 次尝试（#1 FCB、#2 legacy、#3 旧 Electron、#4 v2），vonvon-site 和 vonvon-platform 标的是 '—'。时间跨度没问题：FCB 全部 ref 中最早的提交是 0169786，日期 2026-05-26（`git log --all --reverse`），到今天 2026-10-14 约 4.6 个月。
- **说过头了**："是否必须登录"前后翻了 5 次
  - 依据：列出的是 5 个立场，但前 3 个都是不强制登录：PRD:24-27 是"未登录状态"加"暂不登录"；FRD 在 6cd64ec 版本第 37、207-210 行说"不以 Vonvon 登录阻塞"；commercialization-plan.md:113 说"不强制注册"。真正的反转只有三次：2026-08-10 的 43adae3（ADR 0012:13）改成必须登录；2026-09-24 的 PR #2 改成"without a local product account"；2026-10-10 的 v2（ARCH:161、169）改成可选登录。报告还漏了一条更强的证据：V9:17 在 2026-08-05 明确否决"用…登录状态切断前身已经免费的能力"，五天后 ADR 0012 就反着做了，而且没有提到 V9。
- **属实**：FRD 自己声明它是目标，代码没有实现（FRD:18）；真实飞书端到端验收没做（LEG/README.md:64）
  - 依据：FRD:18 原文："本文记录产品目标，不代表当前代码已经实现"。README.md:64 原文："当前仍未完成真实用户授权迁移与飞书端人工 E2E"，并且"不能宣称正式发布就绪"。FRD 末尾 700-718 行左右还有一张"当前实现与决策差距"表，例如 FRD:705 写 supervisor 没有"十分钟三次"的停止阈值。
- **属实**：v2 没有引用 legacy 的 PRD、FRD、REC 和任何商业化文档，只在推翻 ADR 0012 时提到它（ARCH:169，PLAN:2065），另外引用了迁移代码和账号服务代码
  - 依据：在 docs/*.md、README.md、AGENTS.md 里 grep `prd|first-run|首次|commercial|付费|pilot|feature-parity|reconciliation`，没有命中 legacy 产品文档。ADR 0012 只出现在 ARCH:169 和 PLAN:2065。报告漏列了几处引用：roadmap.md:125 引用 legacy 的 `deploy/tencent`（云端部署参考），plan.md:20 固定了 legacy 的 `3a16853`，plan.md:2124 的阅读清单里列了 legacy 的 `docs/adr/`，但 v2 没有逐条处理 ADR 0010、0011、0013（这三个编号在 grep 里都没有命中）。
- **说过头了**：FCB：MIT；npm 56 个版本；0.6.14 于 2026-09-24 发布（6698118）；main 283 个提交、全部 ref 387 个；2026-05-26 0169786 起；分支最晚是 2026-10-11 的 ba7f5f8
  - 依据：已确认的部分：`head -1 LICENSE` 输出 MIT License；`npm view` 有 56 个版本，0.6.14 发布于 2026-09-24T14:12:37Z，dist-tag latest 是 0.6.14；main 283 个提交，全部 ref 387 个。有两处小错：main 的第一个提交是 ede72ef（2026-05-29，"首个开源版本"），0169786（05-26）只在别的 ref 上；codex/v9-owner-notice 分支最新的提交是 597745e（2026-10-11 09:09），不是 ba7f5f8（07:49），后者只是这条分支上"refuse startup"那一次提交。
- **属实**：旧 Electron 版 PR #2–#19 至今仍是 OPEN、从未合入；RM:107 说 V4 合入后关闭，V4 的 #69 已在 10-11 合入
  - 依据：`gh pr list --state open` 显示 #2、#9-#19 都是 OPEN。#3-#8 不是 PR（`gh pr view` 报 Could not resolve），所以实际只有 12 个 PR。roadmap.md:107 写的是"V4 合并、界面移植完成后，关闭这些 PR"。#69 在 2026-10-11T01:58Z 合入（MERGED），program-graph.json 的 merged 字段是 [V1..V4]。origin/codex/device-handoff 有 76 个提交。
- **属实**：v2 已合入 53 个 PR；main 约 10.4 万行 TS；没有 release 或 tag
  - 依据：`gh pr list --state merged` 共 53 个，最早的是 2026-10-10 合入的 #21。`gh release list` 和 `git tag` 都为空。用 `git ls-files '*.ts' '*.tsx'` 统计是 101,098 行，其中 packages/*/src 约 59k 行、packages/*/test 约 42k 行。报告的 10.4 万行略高，可能把 JS 也算进去了。
- **属实**：定价：免费核心、不按项目收费；只卖服务，诊断 ¥299、安装迁移 ¥699、30 天试点 ¥1,999；价格不是市场已验证价格（DP:45）
  - 依据：decision-packet 第三节报价表列出 ¥299/次、¥699/次、¥1,999/30 天，Workspace 年费"暂不销售"，并写明"这些价格是可执行的首轮实验，不是市场已验证价格"。V9:13-18 否决了 3/5 个项目收费。
- **属实**：付费试点停在主人批准门槛，没有付款证据（FOP:93）；之后是否批准，仓库里没有记录
  - 依据：FOP:93 原文："仍停在外部试点触达的用户批准门槛，未产生付款证据"。OR:145 和 OR:151 是两个待选项（批准小范围触达或暂不批准）。`git log -- docs/product` 显示最后一次改动是 2026-08-10 的 43adae3，之后没有任何关于试点的记录。
- **说过头了**：REC:48 把"必须登录"列为[主人确认]；多设备推迟是[主人确认]（REC:83）
  - 依据：`git show 43adae3 -- docs/product/v1-prd-reconciliation.md` 显示，这两行是 ADR 0012 那次提交在原位改写的。REC:48 原本写的是"未登录仍可使用本机 Agent、机器人、项目和 Runtime"，改写后"已经在最新讨论中重新确认"这个标题（REC:46）没变。原来的 REC:83 一带是关于设备数量和改名的多条规则，也是在同一次提交里被替换的。另外，REC §3.1（117-123 行）把"账号登录门禁"放在"按用户授权采用推荐方案"之下，也就是[授权采纳]一档。ADR 0012 本身没写是谁决定的。
- **属实**：Tauri 换 Electron 在三个仓库里都找不到理由
  - 依据：在 vonvon-bot 的 docs 和 README、device-handoff 分支、所有 remote 分支的 *.md、FCB 所有 ref 的 *.md 里 grep `tauri`，没有任何理由说明，唯一的命中是一个 `data-tauri-drag-region` 属性。`gh search issues/prs Tauri --owner modelzen` 只命中 legacy 的 PR #2（Windows x64）。另外，legacy 的两个 Windows 提交 8ebb7cf、ef43482 在没合入的分支 feat/windows-x64-p0 和 codex/windows-desktop 上，legacy PR #2 至今仍是 OPEN。
- **有误**：Agent 安装：v2 有没有用私有 prefix 没核实
  - 依据：已核实，v2 用了私有托管目录：packages/daemon/src/environment/service.ts:198-204 在数据根目录下建 `managed-tools/<tool>/current.json`，packages/daemon/src/agent/codex-appserver/managed-install.ts:11、58-68 用 `npm ci --prefix` 装私有 Codex。这直接违反 legacy 的 REC:62（"不建立 Vonvon 私有托管工具环境"）。这段代码来自旧 Electron 分支，FCB main 里没有 managed-install（`git ls-files src | grep managed` 没有对应文件）。
- **说过头了**：更新：v2"自动更新沿用 desktop/main"，会不会自动下载没写清楚
  - 依据：文档确实没写清楚，但代码是明确的：packages/desktop/src/updates.ts:39-59 的 check() 只拉清单，返回"可下载"；60-87 行的 install() 才调用 `driver.checkForUpdates()` 下载，下载完再要求"点击安装并重启"。main.ts:329-331 只把这两个函数暴露成 UI 调用的 RPC。
- **属实**：权限：v2 没有审批卡，是主人 2026-10-12 的决定（providers.md:15，PLAN:2103）
  - 依据：providers.md:15 原文："The user decided ... Exactly three tiers, qa, write, full, and no approval cards"。plan.md:2103 原文："the user excluded approval cards"。roadmap.md:40 把 provider 重设计的日期写为 2026-10-12。咖啡 Hook 在 v2 只出现在导入时的改写里（ARCH:151，PLAN:1810）。
- **说过头了**：legacy 被替换的理由仓库里没写；"迁移前存档"指什么也没写
  - 依据：三个仓库在同一天（2026-09-18）有同一条提交信息"chore: 同步本地未提交改动（迁移前存档）"：legacy 的 d7c6867、vonvon-platform 的 3427634、vonvon-site 的 aff1e49。FCB 和 vonvon-bot 在 10-09 也有"preserve ... drafts for another device"的提交（FCB #45、vonvon-bot #19）。这说明"迁移"很可能指开发机器或工作区的搬迁，不是产品迁移。这是推断，没有原文说明。

### 正文遗漏的事实

- 唯一发布的产品 FCB 积压了大量未合入的工作，也有真实外部用户。`gh pr list` 有 11 个 OPEN PR，包括 #44 自动投递附件、#17 Codex 沙箱稳定性修复、#13 DeepSeek Harness、#18 Fast 设置，以及 09-24 为 Vonvon 桌面准备的 #30、#32、#35。另有 15 个 OPEN issue，其中外部用户的 bug 和需求集中在 09-24 到 10-02（langhua425 报的 #37-#41，asuka-rei-froverEVA 提的 #42、#43），还有 #12 Grok 后端请求。仓库公开，81 star、22 fork。0.6.14（09-24）之后没有新版本，现有用户三周没拿到任何更新。
- V9:20 有已核实的流量数字：npm 下载 8,405，文档 PV 10,766、UV 9,464，相关群 1,904 人。这比报告引用的"用户提供 8,000/10,000"更可靠；同一行还记录了 1 条没成单的"远程排障可以付费"信号。
- v2 的飞书/Lark SSO 其实是回到 legacy 自己更早的立场。43adae3 之前，REC 写的是"只提供可选飞书 / Lark SSO，不建设手机号注册"（见该提交的 diff），ADR 0010 后来才改成 Supabase 邮箱密码。所以登录方式也翻了不止一次：ADR 0002 飞书身份 → 可选飞书 SSO → 邮箱密码加 GitHub/Google → v2 飞书 SSO。
- v2 的 main 上已经有可以看的界面和首次流程代码，但没有试用入口。packages/ui 有 JoinGroupDialog、PendingGroupToasts、management/*Panel；packages/daemon/src/bot/onboarding.ts 和 project/onboarding.ts 有欢迎卡和注册向导。但 README.md 还停留在 V1，只讲 protocol 包和 npm 命令，没有"怎么试"的说明，这和主人说"看不到能试的东西"直接相关。
- v2 文档对 Quit 的说法有三种：ARCH:53 说退出桌面端后 Bot 照常回复，没有条件；PLAN:1199 只在开了 Open at login 时才这样承诺；旧 Electron 的 README.md:13 是"退出应用只停止它自己启动的 Bridge"。报告只取了 PLAN 的说法。
- plan.md:9 还写着"Codex owns all code ... Claude Code ... writes no product code"，和 2026-10-13 的 AGENTS.md 分工相反。不只是产品决定，开发分工也在两周内翻过（10-09/10-10 Claude 设计、Codex 实现，10-13 改成 Claude 实现），计划文档没跟上。
- v2 的"The owner chose optional login"和 legacy 一样，也是 agent 写的记录。佐证只有本机的记忆文件 vonvon-bot-v2-architecture.md（"Owner decisions: login is optional"）和 PR #21 的描述，没有主人原话。用同一把尺子量，v2 的产品决定也可能出现 legacy 那种"在已确认标题下原位改写"的问题。
