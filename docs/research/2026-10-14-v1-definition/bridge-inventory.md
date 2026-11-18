# bridge 老用户迁移：v1 要留哪些功能，数据怎么搬

调研日期 2026-10-14。全程只读：没有改仓库，没有跑构建和测试，gh 只做了查询。

**缩写**
- `FCB` 指 /home/operator/vonvon/feishu-codex-bridge，版本 0.6.14，提交 `6698118`。
- `BOT` 指 /home/operator/vonvon/vonvon-bot，提交 `be17859`。`D/` 指 `BOT/packages/daemon/src/`。
- `PS` 指 `FCB/docs/design/project-status-2026-07-01.md`。这份文档按 0.6.4 写成，之后加的功能另查 `git log`。
- `群#N` 是交流群"Vonvon 灵感研究所"里第 N 条消息，数据是之前 bridge.report.md 那次运行拉下来的 `scratchpad/chat/msgs.json`。sender 尾号 `36db70` 的是维护者，发的多是版本公告，所以我只把其他人的消息算作用户证据。
- `issue #N`、`PR #N` 指 GitHub 上的 modelzen/feishu-codex-bridge。`v2 PR #N` 指 vonvon-bot。
- 标"推断"的是我的判断，标"未知"的是查不到或者要实测。

## 结论

1. **v2 已经带着 bridge 几乎所有用户能看到的功能。** 内核从 bridge `446b2a4` 复制过来。数据形状也一样，只是多了几个字段：Project 多了 `enabled` 和 `creationRequestId`（`D/project/registry.ts:11-13`），SessionRecord 多了 `detached`。功能清单里只有四项 v2 没做好：后台自启、桌面更新、首次导入，还有扫码注册在 v2 里一次都没走通过。
2. **大多数功能建议"保留"。** 建议"改"的是三类：迁到新 bot 模型的部分（群=目录改成 bot 工作区加群覆盖），桌面端替代的部分（网页控制台、`update`、系统服务），以及用户抱怨集中的默认值（120 秒超时、文件只能点击领取）。建议"丢"的只有 Windows、Linux 服务和 Codex Fast。
3. **草稿 V8 导入（v2 PR #226）按现在的写法，会拒绝所有已发布版本的用户。** 它要求先拿到 bridge 的"准入互斥锁"，否则 `execute` 以 `fence-unavailable` 拒绝（`docs/bridge-import.md:26`、`:177`，在分支 `origin/codex/v8-bridge-import`）。这个锁来自 `src/config/data-access.ts`，而 0.6.14 里没有这个文件，它只在未发布的 `446b2a4` 里有（我用 `git show` 核对过）。另外，这份设计稿有 463 行，Windows 上也拒绝执行。
4. **0.6.14 本身就有一把能用的排他锁。** 每个 bot 的 `bots/<appId>/processes.json` 用 O_EXCL 抢占，活着的进程占住时，bridge 的 `run` 会拒绝启动（`FCB/src/core/single-instance.ts:93-117`，`FCB/src/cli/commands/run.ts:141`）。bridge 自己的 `stop` 命令会停服务并去掉开机自启（`FCB/src/cli/index.ts:37-41`，`FCB/src/service/launchd.ts:103-120`）。只用这两样，就能拼出一条只做 macOS 的最小迁移路径，见第 4 节。
5. **旧的 Codex 会话可以接着用，前提是 v1 不改 `CODEX_HOME`。** 会话记录里存着 Codex thread id 和 cwd（`FCB/src/bot/session-store.ts:13-38`），线程文件在用户自己的 `~/.codex` 里。两边都用默认的 `CODEX_HOME`（`FCB/src/agent/codex-appserver/usage.ts:55`，`D/agent/codex-appserver/usage.ts:55`），`packages/*/src` 里也没有任何地方覆盖它。Claude 会话按 cwd 存在 `~/.claude/projects`（PS:52），只要导入后 cwd 不变就能续上。这两点都是推断，要在 Mac 上实测。
6. **非 macOS 用户迁不了。** owner 已经同意 v1 不支持 Windows。可 bridge 用户里有明确的 Windows 用户（issue #23、#42，群#94、#579）和 WSL 用户（issue #1）。没有遥测，各平台占比未知。V9 的通知只能对 macOS 用户说"可以迁"。
7. **几类痛点里，v1 应该一起解决的是：** 安装和飞书配置、超时和卡死、文件领取。这三类都是 v1 本来就要改的地方：桌面端、运行卡、bot 工作区。定时任务和更多模型要 owner 拍板，见第 5、6 节。

---

## 1. 功能清单

"v2 现状"一列指 BOT main。"有"的意思是代码已经复制过来，不代表在 v2 里验收过。

### 1.1 群里干活

| 功能 | 做什么 | 使用证据或抱怨 | v2 现状 | 建议 |
|---|---|---|---|---|
| 群=项目=固定目录，话题=会话 | 一个群绑一个 cwd，一个话题对应一个 agent 会话（README:70，PS:15-16） | 有公司把 20 多个实习生拉进同一个群直接问（群#544、#554）。也有用户搞不清两种群的区别（群#40-41） | 有（`D/project/registry.ts`） | **改。** v1 改成 bot 自带工作区，群只做覆盖。导入时把旧 cwd 记成这个群的工作区覆盖，目录本身不动 |
| 多话题群和单会话群 | multi：一个话题一个会话；single：整个群一个会话、全程免 @（README:93-95） | 有人要两种群互相转换（issue #6、群#595），单会话群要能重开会话（群#578、#598），单会话群回答错位（群#908） | 有 | **保留两种。** 允许在群设置里切换，切换后从新会话开始。上下文规则按 owner 的 update 3 重新设计（`context-model.md`） |
| 免 @（回复模式） | `noMention`：多话题群只在话题里免 @，主区闲聊仍要 @；消息 @ 了别人时不接（`FCB/src/bot/handle-message.ts:1161-1167`，`FCB/src/project/registry.ts:80-85`） | 群#647 说单会话群的免 @ 不生效。PR #19 是外部贡献者做的"全部回复 / 模型判断 / 仅 @"三档（+5321/-293，未合入），判定规则写在 PR 描述里 | 有两档（`packages/protocol/src/domain.ts:72`） | **改。** 按 owner 的决定加第三档"智能回复"，可以参考 PR #19 的 IGNORE/FOLLOW_UP 判定规则。导入时要保住旧行为：多话题群的 `noMention=true` 映射过来以后，主区仍要 @ |
| 运行中插话（steer）和排队 | Codex 运行中注入新消息，Claude 排队（README:73，PS:59） | 0.6.11 修过消息串到别的话题（群#959，PR #15）。群#953 提议同一会话内按发信人切换权限 | 有 | **保留** |
| `/goal` | 自主多轮，直到完成；卡片上有 ⏹ 终止和 🎯 结束目标两个按钮（README:97，`FCB/src/bot/handle-message.ts:570`） | 用户点名要过（群#93、#241），上线后有好评（群#279），有人连续跑很长时间（群#264-270） | 有。Claude 用提示词循环模拟（`D/agent/claude-agent/backend.ts:200`）。新 provider 层计划删掉这个模拟（`docs/architecture.md:127`） | **保留。** v1 留在旧 `agent/` 路径上，Claude 的模拟版本也一起保留 |
| `/resume` | 历史会话选择器，能续 Codex 或 Claude 原生会话（PS:70） | 有好评："飞书里继续聊，Codex 里也有"（群#45）。有人直接用（群#832-833）。有人想和 Codex 桌面端互通（群#591、#875、#910） | 有 | **保留。** v1 不要给每个 bot 换 `CODEX_HOME`，否则旧会话续不上，和 Codex 桌面端的互通也会断（`agent-mechanics.md` 第 38、330 行） |
| `/model` | 选模型和推理强度，下一轮生效（PS:69） | 想在卡片上看到当前模型（群#339、#826），想设默认推理强度（群#486、#711）。PR #2 加 `/effort`，PR #18 加 Codex Fast | 有 | **保留。** Codex Fast 不进 v1（**丢**） |
| `/compact`、`/context` | 手动压缩上下文，查看上下文用量（PS:71-72） | 带图片的会话越压越大（群#792） | 有 | **保留** |
| `/clear` | 只在单会话群可用：停掉当前会话，开一个新会话（`FCB/src/bot/handle-message.ts:1001`） | 有人要（群#578、#598）。Claude 用户找不到 `/new`（群#885） | 有 | **改。** 加 `/new` 作别名 |
| `/help`、`/settings` | 速查卡；群内设置卡，只有管理员能用（PS:73-74） | — | 有 | **保留。** `/settings` 卡只放回复模式、权限、模型。人设、工作区、skill 放到桌面端 |
| "用量" | **0.6.14 没有 `/usage` 这个群命令**（`parseCommand` 只认 7 个，`FCB/src/bot/handle-message.ts:1140-1151`）。用量在私聊菜单"📊 用量"里（`FCB/src/card/dm-cards.ts:176`），只支持 Codex 的 ChatGPT 登录 | 维护者推广过分享卡（群#197）。有人想按群统计 token（群#773） | 有（`packages/ui/src/management/UsagePanel.tsx`） | **保留。** 按群统计 token 不进 v1 |
| 表情控制 | 运行卡上点 👌 或 ✅ 停止，终态卡上点 👍 继续（`FCB/src/bot/handle-message.ts:582-596`） | 没找到用户提过 | 有 | **保留**（不用额外花工夫） |

### 1.2 运行卡和运行

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 流式卡片、⏹ 停止、工具折叠 | CardKit 逐字更新；连续工具调用折叠；完成后收起过程（README:72，PS:57-58、94-95） | 有人要能展开工具调用（群#577，已做）。长任务卡在"正在输出"时点终止，提示"任务已结束"（群#798） | 有 | **保留。** v1 加子 agent 显示（owner update 3）。停止必须任何时候都有效 |
| 空闲 watchdog | 默认 120 秒没有活动就中止并回收进程（PS:60，`FCB/src/config/schema.ts:318`） | 用户说的"超时"大多是它：群#217、#366、#545、#602、#767，还有网络失败（群#914） | 一样是 120 秒（`D/config/schema.ts:318`） | **改。** 把默认值调大。卡片文案要分清"N 分钟没输出"和"网络失败"，并给出重试按钮 |
| 并发上限和排队卡 | 默认 10 个并发，满了排队（PS:61） | — | 有 | **保留** |
| 完成提醒 | 四种策略：手动、长任务、失败或超时、每次结束。另发一条消息 @ 发起人（`FCB/src/config/schema.ts:47-58`） | 用户自己提的需求（issue #5、群#594），0.6.9 做完 | 有 | **保留** |
| 会话标题 | 给 `/resume` 列表生成原生标题（`30d5b9d`，0.6.10） | — | 有（TitleService，`docs/architecture.md:127`） | **保留** |

### 1.3 文件和多模态

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 入站图片、文件、引用、话题上文、发信人 | 下载后交给 agent，引用和上文编进这一轮的输入（PS:101-103） | 图片读不到（群#638，已修）。PR #3 注入发信人身份 | 有 | **改。** 入站文件现在放在 cwd 外，只有 full 档能读（PS:167）。v1 放进工作区，qa 和 write 档也能读 |
| 点击后发送本地文件 | 回答里的本地文件变成蓝色链接，点击才上传；每轮最多 10 处，每个不超过 30 MB（README:76，issue #11） | 群里其他成员领不到（issue #43，PR #44）。手机打不开 xlsx 和 html（群#661、#664）。有人问怎么回传附件（群#829） | 有（`D/bot/outbound-files.ts`） | **改。** 加"完成后自动投递"开关（按 issue #43 的边界）。群里允许使用 bot 的成员都能领取 |
| 图片外发、`feishu-card` 代码块 | 把 markdown 图片先上传再显示；代码块渲染成独立卡片（`FCB/src/agent/bridge-instructions.ts:22-31`，PS:97） | issue #14（已修） | 有 | **保留** |
| 多维表格自动化卡片 | 读回降级卡片的真实正文，让多维表格按钮能触发 agent（`FCB/src/bot/handle-message.ts:968`） | 用户提过（群#317），维护者推广过（群#403-404） | 有 | **保留** |
| 语音转文字 | 60 秒、20 MB 以内的纯语音（README:200-211，0.6.13） | 只有维护者的公告（群#964），没找到用户提过 | 有（`D/voice/`） | **保留**，但不再额外投入 |

### 1.4 权限

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 三档沙箱加网络开关 | 只读、读写、完全访问；始终 `approvalPolicy: never`（README:150-158，PS:79-83） | Linux 上拒绝启动（群#708）。群#409-412 骂"权限配不完"，说的是飞书应用权限，不是沙箱 | 有。macOS 上 Codex 和 Claude 都能强制（PS:181-182） | **保留。** v1 只做 macOS，Linux 上拒绝启动的问题不会出现 |
| 管理员、白名单、来宾分档 | owner 是扫码人；管理员；每个群的 allowedUsers；来宾档不同就拆成两个会话（PS:65、130） | 拆成两个会话导致上下文对不上（群#953）。非管理员不能私聊（群#582、#605） | 有 | **保留。** 拆会话的问题放进 context-model 一起设计 |

### 1.5 群和项目管理

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 建群、绑已有群、删项目、群公告、欢迎卡、群 tab | 私聊里建项目，bot 建群并拉人；bot 被拉进群就发绑定卡；删项目时转让群主或者自己退群（PS:86-91，README:92） | 用户理解成"私聊只用来建项目"（群#42、#47） | 有，桌面端另有绑群对话框（`packages/ui/src/JoinGroupDialog.tsx`） | **改。** 建群和绑群以桌面端为主，私聊里保留同样的入口 |
| 私聊控制台 | 菜单有新建项目、项目列表、设置、用量、诊断、重启、更新（`FCB/src/card/dm-cards.ts:171-179`）。只有管理员能用，从不跑任务（`FCB/src/bot/dm-console.ts:9-23`） | "仅管理员可在私聊里管理项目"出现在 issue #10、群#557、#582、#605、#704 | 有（`D/card/dm-cards.ts:179-186`） | **改。** 保留为手机上的轻量控制台。拒绝文案要写清"你不是这个 bot 的管理员，请找 X"。私聊里要不要聊天，等 owner 定上下文方案 |

### 1.6 其他入口

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 云文档评论 @bot | 在评论里 @ 机器人，回复写回同一个评论线程，可以改文档；每篇文档一条会话；只有管理员能触发（README:78，PS:107-109、164） | 维护者推广过（群#56、#512）。外部协作者触发不了（issue #8，PR #20） | 有 | **保留。** 谁能触发做成一项设置（PR #20 的方向） |
| ☕ 咖啡一下 | 把本机 Claude Code 或 Codex CLI 的审批、提问、完成推到飞书私聊；检测人是否离开；防止休眠（README:77、102-104，PS:112-115） | 维护者推广过（群#378、#400）。用户看不懂按钮（群#518、#566、#580）。和 Codex 定时任务冲突（群#567） | 有 | **保留，不扩展。** 只有 macOS 上完整可用（PS:183），刚好和 v1 的平台一致。打包版的 hook 命令要修，见 4.4 |

### 1.7 管理面

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| 多机器人 | 一台机器多个 bot，每个 bot 一个进程（README:80，PS:123） | 有人想让 bot 之间互相 @（群#414、#878）。有人遇到两个 bot 不能同时启动（群#894） | 有 | **保留。** 这是 v1 bot 模型的基础 |
| 网页控制台 | 在 127.0.0.1 上开；扫码、权限和事件清单、服务启停、日志（README:164-166） | 打不开（群#563）；版本检查每 5 秒跑一次（群#633-636）；重启请求失败（群#673） | 用新界面替换了（`packages/ui`），有日志、更新、环境、用量几个面板（`packages/ui/src/management/`） | **改。** 桌面窗口就是控制台，不再单独引导用户开网页 |
| `update` | 执行 `npm i -g` 后重启服务（README:116，PS:125） | 更新按钮从来没成功过（群#143），控制台更新不了（群#601） | 桌面更新源是空的（`packages/desktop/src/updates.ts:46`）。Core 更新的兜底包名还是 bridge 的（`D/service/update.ts:44`） | **改。** v1 必须有签名、公证过的桌面更新 |
| 系统服务 | macOS 用 launchd，Linux 用 systemd，Windows 用 HKCU Run（README:82，PS:124、180） | WSL 上不能用（issue #1）。断线后重连不上（群#706、#725） | `service install` 直接抛错（`D/host/service.ts:4-8`） | **改。** v1 只做 macOS 登录自启，用登录项还是 launchd 见 `v2-fit.md` 第 3 节。Windows 和 systemd **丢** |
| CLI | `run/start/stop/status/logs/update/web/bot/doctor`（README:111-119） | — | `vonvon` 只注册了 `daemon`、`open`、`service`（`D/cli/index.ts:20-63`）。`bot.ts` 和 `doctor.ts` 文件在，但没有注册 | **改。** v1 如果要 CLI，先注册 `bot list` 和 `doctor`（推断） |
| 诊断、权限和事件检查 | 诊断卡；15 个必需权限用一个授权链接开通；只读的事件订阅检查（PS:98、134-137，`FCB/src/config/scopes.ts:18-38`） | 应用没发布，或者只开了用户权限（群#529-530）。权限配不完（群#409-412） | 诊断卡有，但扫码注册在 v2 里没走通过（`results/runnable.report.md:57`） | **改。** 首次运行做成清单式引导，见第 5 节 |

### 1.8 Agent 后端

| 功能 | 做什么 | 证据 | v2 现状 | 建议 |
|---|---|---|---|---|
| Codex（app-server） | 默认后端，能力最全（PS:47-51） | 主力后端 | 有，还会去找 Codex.app 自带的 CLI（`D/agent/codex-appserver/locate.ts:50`）。bridge 不找（在 FCB/src 里 grep `/Applications` 没有命中） | **保留** |
| Claude（Agent SDK） | 按需下载约 265 MB；复用本机登录（PS:52、54） | 0.5.0 加入（群#368）。有人问 MCP 和 skill 会不会带进来（群#552）。API 错误被吞（issue #23，已修） | 有，但 v2 里没找到在真机上跑过 Claude 回合的记录（`v2-fit.md` 第 6 节） | **保留。** 发布前必须在 Mac 上真跑一遍 |
| 自定义模型（DeepSeek、Kimi 等） | 通过 Claude Code 的设置或 Codex 的配置接入 | 模型列表的兜底有问题（issue #37、#38、#40、#41），有人问怎么用自定义模型（群#949） | 同样的兜底问题原样在 v2 里（`bridge.report.md` 第 3 节） | **改。** 修模型列表的兜底，允许手填模型 id |

---

## 2. bridge 在磁盘上有什么

数据根是 `~/.feishu-codex-bridge`（`FCB/src/config/paths.ts:5`）。README 说"卸载时删掉这个目录即可清干净"（README:130）。

| 位置 | 内容 | v1 导入时怎么处理 |
|---|---|---|
| `bots.json` | bot 列表：`name`、`appId`、`tenant`、`botName`、`active`（`FCB/src/config/bots.ts:9-37`） | 复制 |
| 根目录下的 `config.json`、`projects.json`、`sessions.json` | 很老的单 bot 布局，bridge 首次运行时会迁走（`bots.ts:60-80`） | 按 bridge 自己的规则先归一化，再导入 |
| `bots/<appId>/config.json` | bot 级偏好；`access` 里有 `ownerOpenId`、`admins`、`allowedChats`；密钥只存引用，指向 `secrets-getter`（`FCB/src/config/store.ts:19-39`） | 复制。v2 用的是同样形状的引用（`D/bot/refresh-bot.ts:28`），只需改成指向 v2 的密钥库 |
| `secrets.enc`、`.keystore.salt` | App Secret。密钥由 `主机名|用户名` 加 salt 用 PBKDF2 派生（`FCB/src/config/keystore.ts:73-77`） | 解密后用 `~/.vonvon-bot/master.key` 重新加密。改过主机名就解不开，这时让原 owner 或管理员扫码刷新凭据（`D/bot/refresh-bot.ts:31-36`） |
| `bots/<appId>/projects.json` | 群绑定，包括 cwd、群类型、免 @、权限、后端、默认模型（`FCB/src/project/registry.ts:8-69`） | 映射到 v1 的群覆盖，见 4.2 |
| `bots/<appId>/sessions.json` | 话题对应的后端会话 id、cwd、模型（`FCB/src/bot/session-store.ts:13-38`） | 原样复制 |
| `bots/<appId>/comment-instructions.md`、`comments/` | 评论提示词，每篇文档一个目录（`paths.ts:76-87`） | 复制 |
| `bots/<appId>/outbound-files/` | 已发送文件的记录（`paths.ts:64-67`） | 复制。这样旧卡片上的蓝色文件链接还能点（推断） |
| `bots/<appId>/processes.json` | 单实例锁（`single-instance.ts:93-117`） | 不复制。导入期间和之后由 v1 占住，见 4.1 |
| `bots/<appId>/cli-bridge.sock` | 运行时的 socket | 不复制 |
| `projects/<项目名>/` | 空白项目的目录，里面是用户的工作成果（README:134，`paths.ts:115`） | **不移动，原地引用。** 要提醒用户别按 README:130 的说法删掉旧目录 |
| `media/`、`inbound/`、`logs/` | 缓存和日志（`paths.ts:126-129`，`FCB/src/core/logger.ts:67-68`） | 不迁 |
| `backends/`、`lark-cli/`、`codex-cli/`、`npm-cache/` | 按需下载的依赖（`paths.ts:105-119`） | 不迁 |
| `web-console.json`、`web-token` | 网页控制台用的（`paths.ts:130-135`） | 不迁 |
| `~/Library/LaunchAgents/ai.feishu-codex-bridge.bot.plist` | 开机自启，带 `RunAtLoad` 和 `KeepAlive`（`FCB/src/service/launchd.ts:16`、`:52-62`） | 用 bridge 自己的 `stop` 去掉 |
| `~/.claude/settings.json`、`~/.codex/hooks.json` 里的 hook 组 | 咖啡一下（`FCB/src/cli-bridge/hooks.ts:51-52`） | 用 v1 自己的 hook 安装覆盖，见 4.4 |
| `~/.codex/sessions`、`~/.claude/projects` | Codex 线程和 Claude 会话本体，不归 bridge 管 | 不动，v1 直接续用 |
| `~/.vonvon-bridge` | 未发布分支改名后的数据根，可能只在 owner 自己的机器上有 | 也要能识别。`D/service/control.ts:6-56` 已经能检测两个数据根和 launchd 标签 |

## 3. v2 原计划：V8 导入，V9 收尾版

**V8：导入 bridge 数据**（`docs/plan.md:1774-1835`，`docs/architecture.md:145-159`）
- 计划的顺序：只读预检 → 暂停 bridge → 复制并重新加密 → 改写咖啡 Hook 为 `vonvon hook` → 启动并确认长连接已连上 → 永久去掉 bridge 自启 → 写入 `migrated-to-vonvon-bot.json` 标记。任何一步失败都恢复 bridge。三个平台都要做。
- 验收：10 条 live lane，跑在专用的测试账户里，加 5 次计时，停机时间中位数不超过 30 秒。
- 现状：只有草稿 v2 PR #226（+2215/-10），已暂停（`v2-fit.md` 第 5 节）。设计稿 `docs/bridge-import.md` 有 463 行，围绕"每个有破坏性的动作都要绑定身份"展开：
  - 必须先拿到 bridge 的准入互斥锁，拿不到就拒绝（第 26 行、第 177 行）。0.6.14 没有这个锁，所以**所有已发布版本的用户都会被拒**，提示"先升级 bridge"，可是带这个锁的 bridge 版本从没发布过。
  - Windows 上 `execute` 直接拒绝（第 2.6 节）。
  - 导入程序不删 plist，所以 lane 1 的"plist 已删除"一直验不过（第 2.6 节）。
- 能复用的部分：`preflight.ts`（363 行）、`legacy-keystore.ts`（100 行）、`hooks.ts`（175 行）、`ImportPage.tsx`（91 行）（`v2-fit.md` 第 5 节）。

**V9：bridge 的最后一版**（`docs/plan.md:1836-1893`）
- 计划内容：每个 bot owner 在私聊里收到一次通知卡；`start`、`status`、`update` 时打印提示；发现标记就拒绝 `run`。
- 现状：分支 `origin/codex/v9-owner-notice` 有 3 个提交（`ba7f5f8`、`05e2635`、`597745e`，+737/-185）。但它是在 `446b2a4` 上开的。`446b2a4` 比 0.6.14 多 49 个未发布的提交，132 个文件 +13,623/-893（`git diff --stat 6698118 446b2a4`）。照这个分支发版，等于把一大批没发布过的改动一起推给全部用户。
- 依赖：V8，以及签名过的 Mac 安装包地址。

## 4. v1 的最小迁移路径（只做 macOS）

### 4.1 步骤

1. **发现。** 桌面端首次运行时，如果 `~/.vonvon-bot` 里还没有 bot，并且存在 `~/.feishu-codex-bridge/bots.json`（或者旧的平铺 `config.json`，或者 `~/.vonvon-bridge`），就显示导入页。之后在设置里保留"从 bridge 导入"的入口。
2. **只读预检。** 页面列出：
   - 每个 bot 的名字、群数、会话数；
   - 每个群的 cwd 是否还在；
   - App Secret 能不能解开；
   - 咖啡 Hook 有没有装；
   - bridge 是否在运行：`launchctl print gui/<uid>/ai.feishu-codex-bridge.bot` 能查到，或者某个 `processes.json` 里的进程还活着。
   - 解不开密钥的 bot 标成"导入后要扫码刷新"。
3. **停掉 bridge。** 调用用户自己装的 `feishu-codex-bridge stop`。它会先删 plist 再 bootout，这样自启也一起去掉了（`FCB/src/service/launchd.ts:103-120`）。命令路径从 plist 的 `ProgramArguments` 里读，或者从 PATH 里找（推断）。停完要确认所有 `processes.json` 里的进程都退出了。
4. **占住 bridge 的锁。** v1 daemon 用 bridge 自己的格式（`{pid, appId, startedAt}`，O_EXCL）占住每个导入 bot 的 `bots/<appId>/processes.json`。这样手动 `feishu-codex-bridge run` 会因为 `BridgeAlreadyRunningError` 拒绝启动（`single-instance.ts:93-117`、`:162`）。这也就不用先去实测"两个进程连同一个应用时，事件怎么分"（`docs/roadmap.md:113`）。这一步是推断：bridge 判断持有者是否活着时，会看 pid 在不在，还会比对 `startedAt`。进程真实启动时间比 `startedAt` 晚 15 秒以上，就当成 pid 被复用（`single-instance.ts:83-90`）。所以 v1 写入当前时间应该能被认成活着，要实测。
5. **复制和映射。** 按第 2 节的表复制，重新加密密钥，再按 4.2 写成 v1 的 bot 和群配置。所有 bot 一次导完，因为 bridge 是一个服务带全部 bot，只导一部分的话，剩下的 bot 就离线了。
6. **Hook。** 如果原来开着咖啡一下，就跑一遍 v2 现有的 hook 安装。它会先删掉旧的 bridge hook 组，再装新的（`D/cli-bridge/hooks.ts:153-170`、`:202-205`）。
7. **启动并确认。** 启动所有导入的 bot，等每个 bot 的长连接都连上。
8. **收尾。** 写入标记文件 `~/.feishu-codex-bridge/migrated-to-vonvon-bot.json`，显示一张回执，写明导入了什么、哪些没迁、旧目录不要删。
9. **失败就回滚。** 停掉 v1 里导入的 bot，释放锁，从备份恢复 hook，再执行 `feishu-codex-bridge start` 把自启装回去。

推断：这条路径有一大半能用 #226 现成的预检、密钥和 hook 代码，不需要 V8 设计稿里的服务账本和 inode 绑定。代价是它依赖 bridge 自己的 `stop` 和 `start` 命令能正常工作，而这两个命令是 bridge 用户平时就在用的。

### 4.2 数据怎么对到 v1 的 bot 模型

| bridge | v1 |
|---|---|
| bot（appId） | 同一个飞书应用的 Bot。名字和头像从飞书读。人设、记忆、skill 都是空的 |
| bot 级偏好（回复样式、并发、超时、提醒、咖啡、评论、标题、语音、access） | bot 级设置，一一对应。v2 的 `AppPreferences` 和 bridge 一样（`v2-fit.md` 第 1 节） |
| `projectsRootDir` | bot 主工作区的父目录。没设过的话，在默认路径新建 |
| Project（bot 加群） | 这个 bot 在这个群里的覆盖。cwd 记成"这个群的主工作区覆盖"。`kind`、`mode`、`guestMode`、`network`、`allowedUsers`、`backend`、`defaultModel`、`defaultEffort`、`autoCompact` 原样带过来 |
| `noMention`（含默认值规则 `registry.ts:80-85`） | true 映射成"全部回复"，false 映射成"仅 @"。多话题群的主区仍要 @，不能因为迁移改变行为 |
| 用户的个人 CLAUDE.md、AGENTS.md、skill | 导入的 bot 默认开，新建的 bot 默认关（`persona-memory-skills.md` 第 246 行） |

### 4.3 旧会话能不能接着用

- **Codex：能（推断）。** 会话记录里的 `sessionId` 就是 Codex thread id（`session-store.ts:18-20`）。bridge 每次重启后都按它惰性 resume（PS:62），v1 走的是同一段代码。前提有两个：v1 不改 `CODEX_HOME`，旧 cwd 原地保留。
- **Claude：能（推断）。** 会话按 cwd 存在 `~/.claude/projects` 里（PS:52），cwd 不变就能找到。
- **新人设什么时候生效：** Codex 每次 resume 都新起进程，新的 `developerInstructions` 会进入会话配置。Claude 的系统提示要等到压缩或者开新会话才换（`agent-mechanics.md` 第 101-110 行）。
- **旧卡片上的按钮：** 应用还是同一个，所以按钮回调会发到 v1。v1 内核和 bridge 是同一套，应该能处理（推断，要实测）。

### 4.4 迁移前必须先修的两处（推断，要在 Mac 上验证）

1. **打包版的咖啡 hook 命令。** 写进 hook 的命令是 `"process.execPath" "argv[1]" hook`（`D/cli-bridge/hooks.ts:40-42`）。在打包版里，daemon 是用 Electron 二进制加 `ELECTRON_RUN_AS_NODE=1` 起来的（`packages/desktop/src/daemon-dependencies.ts:74`），所以 `execPath` 指向 Electron 本体。Claude 或 Codex 执行这条命令时不带那个环境变量，起来的可能是 GUI 而不是 Node。应该改成调用桌面端注册的 `vonvon` 小脚本，那个脚本会自己设好环境变量（`packages/desktop/src/cli-registration.ts:46`）。
2. **v2 自己的单实例锁发现不了 bridge。** v2 的锁放在自己的数据目录里（`results/runnable.report.md` 引 `core/single-instance.ts:118`）。用 4.1 第 4 步占住 bridge 的锁以后，这个问题从 bridge 那一侧也被挡住了。

### 4.5 用户会失去什么

- Windows、Linux、WSL 上的用法（v1 不支持）。
- 网页控制台和 `feishu-codex-bridge` 这个命令（由桌面端替代）。
- 日志、缓存、已下载的 Claude SDK（重新下载，约 265 MB）。
- 在另一台 Mac 上装 v1 的用户：那台机器上没有 bridge 数据，没东西可导。能不能扫码接管已有的 bot：未知。`refresh-bot` 要求本机已经有这个 bot 的记录（`D/bot/refresh-bot.ts:28`）。

### 4.6 V9 在 v1 里怎么缩小

- 从 0.6.14（`6698118`）开一个新分支，只加三样东西：给 owner 发一次通知、发现标记就拒绝 `run`、`stop` 和 `status` 时打印提示。不要在 `446b2a4` 上发版。
- 通知要分平台。macOS 用户收到下载地址和导入说明。Windows、Linux 用户收到"继续用 0.6.14，暂不支持迁移"。
- 发现标记时，顺带删掉自己的 plist，并把 README 里"删目录即卸载"改成先提醒空白项目的位置。

---

## 5. 用户痛点：v1 要解决哪几个

| 痛点 | 证据 | v1 建议 | 理由 |
|---|---|---|---|
| 安装和配置卡住 | 维护者说"好多人都是卡在安装和使用"（群#473）。权限配了一小时放弃（群#409-412）。应用没发布、只开了用户权限（群#529-530）。只装了 Codex 桌面 App（群#531-535）。`spawn EPERM`（群#808、#818）。"仅管理员"（issue #10） | **解决。** 桌面安装包不需要 Node 和 npm；v2 已经会找 Codex.app 自带的 CLI（`locate.ts:50`）。首次运行改成清单：扫码 → 一键开权限 → 检测事件订阅 → 检测是否已发布。每一步都实时检测、不能跳过，只有卡片回调要人工确认（PS:157）。试一下扫码时用 `addons` 预填权限（需要平台开灰度，`results/fit.report.md:47`）。把预填的应用名"Codex Bridge"改掉（`D/bot/wizard.ts:59-62`） | 这是最大的一类抱怨，桌面端就是为它做的 |
| 超时、卡死、掉线 | 群#217、#366、#545、#602、#767、#914；停止失效（群#798）；断线重连不上（群#706、#725） | **解决。** 空闲超时默认调大，文案分清原因；停止任何时候都有效；长连接一直重连不上时自动重启这个 bot 的进程（推断：v2 现在只记录 `reconnecting` 事件，`D/bot/bridge.ts:159-160`）；桌面端显示每个 bot 的连接状态 | 新产品第一印象就是"能不能稳定回话" |
| 手机上拿不到文件 | issue #43、PR #44；群#661、#664、#829 | **解决一半。** 加"完成后自动投递"开关，放宽领取权限。xlsx、docx 可以选"转成飞书在线文档"（要额外申请云空间权限，推断）。手机上 html 打不开，v1 不处理 | v1 的 bot 有工作区，"交付目录"有了自然的位置 |
| 定时任务和主动投递 | issue #42；群#570、#835；和咖啡一下冲突（群#567） | **owner 定。** 如果做，只做最小版：在群设置或桌面端建任务 → 到点在这个群开一个新话题跑一轮 → 结果回帖；错过了不补跑。issue #42 已经写好了验收要点 | 符合"让 bot 更像人"，桌面端一直开着。但这是新功能，会加大 v1 的范围 |
| 更多模型 | Grok：issue #12，群#899、#970。DeepSeek、Kimi 和自定义：issue #37、#38、#40、#41，群#949，PR #13 | **部分解决。** 修模型列表兜底，允许手填模型 id，DeepSeek 等走 Claude Code 的设置（`docs/roadmap.md:40`）。Grok 要 owner 定，v2 里还没有 Grok 的代码（`v2-fit.md` 第 6 节） | 修兜底改动小，加新后端改动大 |
| 子 agent 不显示，主会话提前结束 | 开 5 个子进程，一个完成会话就结束（群#681-693） | **解决。** owner update 3 已经定了要做 | 已经确定 |

## 6. 需要 owner 拍板的事

1. 定时任务进不进 v1（第 5 节）。
2. Grok 进不进 v1。
3. "完成后自动投递"默认开还是关。issue #43 建议默认关。
4. 迁移时要不要把 `~/.feishu-codex-bridge/projects/` 下的空白项目搬进新的 bot 工作区。搬的话，旧会话的 cwd 就变了，Claude 会话可能找不到。我的建议是 v1 不搬。
5. 非 macOS 用户：V9 只通知、不迁移，这样行不行。
6. 用 4.1 的最小路径替换 V8 设计稿，还是继续推进 #226。

## 未知

- 0.6.14 的用户里各个平台各占多少。bridge 没有遥测（`bridge.report.md` 第 2 节）。
- v1 用 bridge 格式写的锁，bridge 会不会认成活着的持有者（4.1 第 4 步）。
- Codex `thread/resume` 在新进程、新的 developerInstructions 下能不能稳定续上旧线程；Claude 按 cwd 续会话在打包版里能不能用。
- 旧卡片上的按钮回调，到了 v1 能不能全部正常处理。
- 扫码时的 `addons` 预填，普通账号能不能用。
- 用户在另一台 Mac 上装 v1 时，能不能接管已有的 bot。
- "两个进程连同一个应用时，事件怎么分"仍然没有实测（`docs/roadmap.md:113`）。用 4.1 的锁可以绕开，但没有解决。
