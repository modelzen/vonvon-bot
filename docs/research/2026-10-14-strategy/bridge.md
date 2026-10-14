# feishu-codex-bridge：用户现在在用的产品

## 结论速览

- bridge 已经发布到 npm，是一个开源 CLI，全局安装后在本机运行（`@modelzen/feishu-codex-bridge` 0.6.14）。它把飞书群接到本机的 Codex app-server 或 Claude Agent SDK：一个群对应一个项目目录，一个话题对应一个会话。支持 macOS、Windows 和 Linux/WSL。
- 使用量在 6 月上线时最高，之后一直下滑。npm 下载 6 月 6,110 次，8 月 675 次，最近一周 108 次。用户交流群有 285 人，但用户发言从 6 月的 333 条降到 9 月 11 条、10 月 1 条。9 月 18 日有用户在群里问"还维护吗这个项目"。
- bridge 的 `main` 从 2026-09-24（0.6.14）起没有新提交。就在同一天，私有仓库 vonvon-bot 创建。7 个外部 PR 至今没有任何 review，11 个开着的外部 issue 里有 10 个没有维护者回复。
- 用户的抱怨和需求集中在五类：安装和权限配置卡住；运行超时、卡死、掉线；产物拿不出来（手机打不开、群成员拿不到、没有定时投递）；想接更多模型；团队协作里的权限。
- v2 的主要新增是桌面端、云端账号、远程中继、Cursor 和 Pi 接入、数据导入，这些在 issue 和群聊里基本没人提过。用户明确提过、v2 也在计划里的，只有 Grok、子 agent 可见、可靠停止三项。

---

## 1. 用户从安装到使用的完整流程

**安装**
- 两条命令：`npm i -g @modelzen/feishu-codex-bridge`，然后 `feishu-codex-bridge web`（`feishu-codex-bridge/README.md:31-38`）。
- 后台服务必须全局安装，不能用 npx（`README.md:122`）。
- Node 版本要求有两处不一致：`package.json:48` 写 `>=20.0.0`，README 里给 AI 的安装提示写 ≥18（`README.md:45`）。
- 依赖本机已装 `codex` CLI（`README.md:46`）。

**飞书机器人配置**
- 在本机网页控制台（`127.0.0.1:51847` 加 token）扫码创建飞书应用，扫码人自动成为 owner 和 admin（`docs/design/project-status-2026-07-01.md:133-138`，下文简称 PS）。
- 15 个必需权限通过一键授权链接开通。事件订阅只能通过 deep-link 手工填写，再轮询检测是否生效。卡片回调配置无法检测，只能人工指引（PS:155-160）。
- 走飞书长连接（WSClient），不需要公网地址（PS:157）。

**项目和会话**
- 私聊机器人 → 新建项目 → 绑定本地目录 → 选后端（Codex 或 Claude）→ 机器人建群、置顶说明、把用户拉进群（`README.md:92`）。
- 群有两种：多话题群里每个话题是独立会话；单会话群整群一条会话，不用 @（`README.md:93-95`）。
- 项目目录和后端在创建时定死，之后不能切换（PS:17-22、145）。

**命令**
- `/goal`、`/model`、`/resume`、`/compact`、`/context`、`/help`、`/settings`、`/usage`（PS:67-76），另有 `/clear`（`src/bot/handle-message.ts:1001`）。
- 支持表情控制：OK 停止，👍 继续（PS:76）。

**运行卡片**
- CardKit 流式更新，有 ⏹ 停止按钮，运行中可插话（steer），连续工具调用会折叠（`README.md:72-73`）。
- 回答里引用的本地文件变成可点击的文字，点击才上传，每轮最多 10 处，单文件不超过 30 MB（`README.md:76`）。
- 语音转文字（`README.md:200-212`）。
- 任务完成提醒，有 4 种策略（issue #5，v0.6.9 加入）。

**其他入口**
- 在云文档评论里 @机器人，它会在同一评论线程回复，目前仅管理员可用（`README.md:78`，PS:162-169）。
- "☕ 咖啡一下"：把本机 Claude Code 或 Codex CLI 的审批、提问和完成通知推到飞书私聊（`README.md:77、102-104`），只有 macOS 完整可用（PS:176-185）。
- 一台机器可以注册多个机器人（`README.md:80`）。

**网页控制台**
- 扫码加机器人、权限和事件订阅清单、服务启停和更新、查看机器人/项目/话题、实时日志（`README.md:166`）。

**支持的 agent**
- 只有两个后端（`src/agent/catalog.ts:85-115`）：
  - `codex-appserver`：默认后端，功能最全。
  - `claude-agent`：通过 Claude Agent SDK 运行 Claude Code。SDK 约 265 MB，按需下载（PS:48-54）。
- 没有 Grok、Cursor 或其他后端。

**支持的系统**
- macOS 用 launchd，Windows 用 HKCU Run（只做登录自启，崩溃后不会自动拉起），Linux/WSL 用 systemd（`README.md:82`，PS:176-185）。
- 维护者在 issue #1 里说明，Linux/WSL 的 systemd 路径还没有在真机上验证过。
- 机器人运行时始终是 `approvalPolicy: never`，沙箱是唯一的安全闸门（`README.md:150`）。只读和读写两档只在 macOS 和 Windows 上强制；Linux 上选这两档会直接拒绝启动（`README.md:158`）。

---

## 2. 使用情况

### npm 下载量

数据来自 `api.npmjs.org/downloads`，查询日期 2026-10-14。

| 区间 | 下载量 |
|---|---|
| 最近一周（10-06 至 10-12） | **108** |
| 最近一月（09-13 至 10-12） | **1,106** |
| 最近一年（等于全部，首个版本 0.1.0 发布于 2026-05-29） | **11,495** |
| 按月 | 5 月（29 日起）362，6 月 **6,110**，7 月 3,072，8 月 **675**，9 月 1,115，10 月 1-12 日 161 |
| 按周 | 峰值 2,363（06-08 那周）；8 月到 10 月没有发版的周在 58 到 178 之间；09-21 那周连发 4 个版本，为 619 |

下载量不等于用户数。`update` 命令本身就会执行 `npm i -g`（`README.md:116`），镜像同步和 CI 也会计入，所以每次发版都会冲高一次。bridge 没有任何遥测：在 `src` 里搜 telemetry 和 analytics，只在 Codex 协议的生成文件里有命中。因此活跃用户数无法得知。

### GitHub

- 81 star，22 fork（`gh api repos/modelzen/feishu-codex-bridge`）。
- 每月新增 star：5 月 3，6 月 24，7 月 18，8 月 15，9 月 18，10 月 3。
- 最近 14 天：浏览 182 次（122 个独立访客），clone 166 次（105 个独立来源）。
- issue 共 21 个，其中 4 个是维护者为桌面端工作开的（#31、#33、#34、#36），外部 issue 17 个。
- 开着的外部 issue 有 11 个，其中 10 个没有维护者回复：#43、#42、#41、#40、#38、#37、#12、#9、#8、#6。
- 外部 PR 15 个，合入 6 个。7 个开着，review 数都是 0：#2（6 月 4 日开）、#13、#17、#18、#19、#20（9 月 15 日开）、#44。

### 飞书交流群"Vonvon 灵感研究所"

只读查询，用的是 `lark-cli api GET /open-apis/im/v1/chats/oc_f212…` 和 `lark-cli im +chat-messages-list`。

- 成员 285 人，另有"天使群"42 人。
- 群里一共 951 条消息，按月统计如下：

| 月份 | 用户消息 | 发言人数 | 新入群 |
|---|---|---|---|
| 6 月 | 333 | 34 | 158 |
| 7 月 | 172 | 34 | 78 |
| 8 月 | 46 | 18 | 52 |
| 9 月 | 11 | 6 | 21 |
| 10 月 | 1 | 1 | 5 |

- 9 月 18 日（位置 #956）有用户问"还维护吗这个项目"。10 月 9 日（#970）唯一的一条用户消息是想把 Grok 部署进飞书。

### 发版节奏

- npm 上共 56 个版本，时间从 05-29 到 09-24。
- 0.6.10（07-18）之后停了 64 天，然后 09-20 到 09-24 五天里连发 0.6.11 到 0.6.14。之后没有再发版。
- bridge `main` 最后一个提交是 `6698118`（09-24）。vonvon-bot 仓库同日创建，是私有仓库，至今没有发到 npm（registry 返回 404）。

### 反复出现的问题和需求

群聊消息按位置编号引用，不列出人名。

1. **安装和配置卡住（最多）**
   - 维护者自己说过"好多人都是卡在安装和使用"（#473）。
   - 权限配不完："手动配了一个小时，实在配不动了，干脆放弃了"（#409-412）。
   - 应用没发布，或者只配了用户权限没配应用权限（#529-530）。
   - 装了 Codex 桌面 App 但没装 CLI（#531-535、#652）。
   - 私聊提示"仅管理员可在私聊里管理项目"，在 issue #10 和群聊 #557、#582、#605、#704 都出现过。这句提示来自 `src/bot/dm-console.ts:20`。
   - 更新按钮更新不了（#143、#601）、网页控制台打不开（#563）、`spawn EPERM`（#808、#818）、WSL 上不支持 start 命令（issue #1）。
2. **超时、卡死、掉线**
   - 响应超时：#217、#366、#545、#602、#767、#914。
   - 卡在"正在输出"，点终止却提示"该任务已结束"（#798）。
   - 断线后重连不上（#706、#725）。
3. **产物拿不出来**
   - issue #11 已经用 0.6.12 的"点击后发送"关闭。
   - 群里其他成员拿不到文件：issue #43，对应 PR #44。
   - 手机上打不开返回的 Excel 和 HTML 文件（#661、#664），"怎么实现回传附件和图片"（#829）。
4. **定时和主动投递**
   - issue #42 提出定时任务执行后主动向绑定群发文字和附件。
   - 群聊里也有人问：支持定时任务吗（#570）、有没有持久调度器或 cron（#835）、咖啡模式和定时任务冲突（#567）。
5. **更多模型和后端**
   - Grok：issue #12，群聊 #899、#970。
   - DeepSeek Harness：PR #13，群聊 #882。
   - 自定义或本地模型：issue #37、#38、#40、#41，群聊 #949、#571-572。
   - 通过 Claude SDK 接 Kimi：issue #23、#24。
   - 阿里 qoder CLI（#702）。
   - Codex Fast（PR #18、群聊 #724）和推理强度（PR #2、群聊 #486、#711）。
6. **团队协作的权限**
   - 非管理员不能在文档评论里触发机器人：issue #8，对应 PR #20。
   - 群成员拿不到文件（issue #43）。
   - 单会话群里管理员和普通成员的会话被拆开（#953）。
   - 机器人之间互相 @ 协作（#414、#878）。
   - 多群隔离（#694）。
7. **会话控制和消息路由**
   - 单话题群和多话题群互相转换（issue #6、群聊 #595）。
   - 单会话群里重启或清空会话（#578、#598）；Claude 后端不支持 `/new`（#885）。
   - 回复总是对应上一个问题（#908）、文件发到群主区而不是话题里（#360）、消息队列把内容发到错误的会话（#952，PR #15 已合入）。
8. **卡片显示的信息**
   - 显示当前模型（#339、#826）、上下文和分支（#596）、按会话或群统计 token 消耗（#773）、展开工具调用（#577）。
9. **和 Codex 桌面端互通**
   - 在飞书里建的项目和对话能不能在 Codex 桌面端看到（#591、#875、#910）。

### 正面信号和真实使用场景

- 公司把 20 多个实习生拉进同一个群，直接在群里问机器人，不用按人头配额度（#544、#554）。
- 维护者给多家企业搭了内部"第二大脑"答疑群（#877），群里的答疑机器人本身就跑在 bridge 上（#107、#823）。
- 有人从同类项目 Zara 的 bridge 换过来（#485）。
- `/resume` 能和 Codex 两边同步，被夸体验好（#45）。
- 也有人说一个人写代码时"飞书 coding 卡卡的"，CLI 更顺（#43）。

---

## 3. v2 比 bridge 多承诺了什么，有没有人要

v2 的飞书端体验本身不变。内核是从 bridge `446b2a4` 复制过来的（`vonvon-bot/docs/architecture.md:7、75-79`）。下表只列从用户角度看新增的部分。

| v2 承诺 | 出处 | 用户提过吗 |
|---|---|---|
| Electron 桌面端，带托盘、开机自启、自动更新（V5） | roadmap.md:15；architecture.md:187-193 | **没有。** issue 和群聊里没人要 bridge 的桌面端。只有 #49 说 Codex 桌面端比 CLI 对新手友好；#36 是维护者自己为"desktop parity"开的 |
| daemon 提供的新网页界面（V4） | roadmap.md:14 | bridge 已有网页控制台（README.md:166）。用户抱怨的是现有控制台不可靠：更新失败（#143、#601）、每 5 秒检查一次版本（#633-636）、重启请求失败（#673） |
| 换成 Vonvon 自己的服务标识重做系统服务（V5） | architecture.md:53-68 | bridge 已经有系统服务。相关的只有 issue #1（WSL）和掉线后重连不上（#706），**部分相关** |
| 新增 Cursor、Grok、Pi 和自定义 ACP（V7a、V7b） | architecture.md:35-36；roadmap.md:20-21 | **Grok 有人要**（#12、#899、#970）。Cursor 和 Pi 在群聊和 issue 里出现 0 次。qoder（#702）能否走自定义 ACP 不清楚 |
| DeepSeek、Kimi、GLM、Qwen 通过 `~/.claude/settings.json` 接入 | roadmap.md:40 | **有人要**（#23、#24、#41、#949）。但 #37、#38 说的模型列表兜底问题在 v2 复制的内核里原样存在（`packages/daemon/src/agent/codex-appserver/backend.ts:557`、`claude-agent/backend.ts:268`） |
| 卡片显示子 agent 区并能单独停止、todo、图片、结束原因（V6c） | roadmap.md:18；architecture.md:127 | **子 agent 有人要**：开 5 个子进程，结果一个完成会话就结束了（#681-693）。图片问题（#14）已在 0.6.12 修好 |
| 停止有时间上限（V6b） | architecture.md:125 | **部分相关**：#798 点终止失效。但用户说的"超时"大多是默认 120 秒的空闲 watchdog 触发，不是停止的问题 |
| 删掉 Claude 后端用提示词模拟的 `/goal` | architecture.md:127 | **和用户需求相反。** `/goal` 是用户点名要的功能，有人连续跑十几个小时（#241、#264-279）。Claude 用户可能会失去这个功能 |
| Claude 的只读和读写档，每格都要有实测证据（V6d） | roadmap.md:19 | 没有直接需求，属于安全加固。#708 抱怨 Linux 上 Codex 沙箱档被拒绝，v2 在 Linux 上仍然拒绝"仅项目目录"读取（architecture.md:129） |
| 导入 bridge 数据并关停 bridge（V8、V9） | architecture.md:145-159 | 没人提。这一步只是因为有了 v2 才需要。285 人的群将被迫迁移 |
| 账号、机器列表、在线状态（V10） | architecture.md:161-169 | 没人提。最接近的是"换新电脑用已有机器人 ID 后提示仅管理员"（#557）和"两个机器人不能同时启动"（#894） |
| 远程访问，端到端加密（V11） | architecture.md:171-179 | 没人提。飞书本身已经是手机上的远程入口。用户想要的远程能力是在手机上打开产物（#661、#664），V11 只管理设置（architecture.md:9 写明网页和桌面端不聊天），解决不了这个 |
| 出站路径判断，修掉符号链接绕过 | architecture.md:135 | 和 #43 提出的"拒绝符号链接逃逸"一致 |

**用户要、v2 文档里完全没有的**（在 plan、providers、architecture、roadmap 里搜"定时""cron""投递""附件""triggerPolicy""token 消耗"都是 0 次或命中无关内容）：
- 定时任务和主动投递（#42）、自动投递附件（#43、PR #44）。
- 非管理员在文档评论里触发（#8、PR #20）。
- 会话模式切换和重置（#6、#598）、按会话统计 token（#773）。
- 安装自检的缺口（第 2 节第 1 类）、超时问题（第 2 节第 2 类）。

---

## 4. 在 bridge 之上最小的有价值增量

建议直接在现有 npm 包上发一个 0.7.0，主题是"产物能送出去，安装不卡住"，发给现有的 285 人群和每周约 100 次的下载用户。

1. **先审已经写好的外部 PR**，代码现成，基本没有设计成本：
   - #44：按项目开启自动投递附件。贡献者 10 月 2 日到 3 日已经在真实项目里跑过（见 PR 评论）。
   - #20：文档评论的触发策略。
   - #2：`/effort` 命令。
   - #18：Codex Fast。
   - #17：Codex 沙箱启动修复。

   同时回复积压的 10 个 issue，并正面回答群里那句"还维护吗"。
2. **向绑定群主动投递**：采用 issue #42 的方向 B，加一个需要鉴权的本机入口，例如 `feishu-codex-bridge post --project <名> --text/--file`。外部 cron 或 Codex 桌面端的定时任务调用它，复用已绑定的 bot、chatId 和现有的文件上传与防重逻辑。#42 的作者已经用 lark-cli 证明飞书这一侧可行。定时调度本身先交给外部系统，以后再考虑 `/schedule`。
3. **补安装自检**：在诊断卡和 `doctor` 里加几项检查：
   - 应用是否已发布，应用权限和用户权限是否都开了（#529-530）。
   - 装的是 Codex CLI 还是只有桌面 App（#534）。
   - 换新机器重新注册时，owner 和 admin 身份是否带过去（issue #10、#557）。

**这个范围的理由：**
- 它覆盖了第 2 节第 1、3、4、6 类，是人数最多的几类抱怨。
- 不需要 daemon、桌面端或云端，代码都在 bridge 里，可以直接发版。
- 效果可以用 npm 每周下载和群里发言量来衡量。

**代价：**
- v2 内核已经从 bridge 分叉，两边各自演进（architecture.md:81）。这些改动以后要再移植进 `packages/daemon`。
- 如果决定以后不再维护 bridge，也可以把上面三项挪进 vonvon-bot，作为它第一个对外发布的版本。但那样就得等 V8 导入完成，现有用户才能用上。

**还不知道的：**
- 真实活跃用户数，因为没有遥测，下载量也不代表用户。
- 群里 285 人中有多少人还在用。
- qoder 是否支持 ACP。


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：## Verdict

The report is reliable on the hard numbers from GitHub and npm and on what the v2 docs leave out. It is weakest on the Feishu group, where it leaves out thread replies, and on what v2 changes for existing users. Both distortions push the same way, toward "users are leaving and v2 builds things nobody wants". The direction still mostly holds after the corrections, but the case is weaker than the report makes it look.

**What I re-checked and found accurate:**
- **Downloads and GitHub numbers.** npm: 108 last week, 1,106 last month, 11,495 all-time. GitHub: 81 stars, 22 forks, 182/122 views, 166/105 clones.
- **Release history.** 56 versions; 0.6.14 published on 09-24.
- **vonvon-bot repo.** Created 2026-09-24, private, not on npm.
- **Group sizes.** 285 members, and 42 in the angel group.
- **Backlog.** Exactly two backends. Seven open external PRs, all with 0 reviews. Ten of the 11 open external issues have no maintainer reply.
- **Fallback lines in v2.** The model-list fallback lines exist at the cited v2 lines, but those files are deleted in V6b.
- **Gaps in v2 docs.** No scheduling, delivery or attachment features anywhere.
- **Issue #42's proposal.** Its direction B is an authenticated external trigger with scheduling left to an outside system.

**Material corrections:**
1. **Group activity.** The report counted only top-level messages. With the 512 thread replies included, user messages run about 460/382/159/60/8 per month. Without the maintainer, they run 280/298/134/43/8, so activity peaked in July, not June. The fall since August is still steep.
2. **"还维护吗".** The question was answered in its thread within a minute ("在维护的…桌面版也会推出"), and four releases followed. The open item is the public promise of a desktop version.
3. **"No commits since 09-24".** This is true only of `main`. Forty-three commits went to other bridge branches through 10-11, including the V9 change that makes bridge refuse to start after an import.
4. **Linux sandbox claim.** The refusal on Linux applies only to Codex. The Claude backend uses bubblewrap on Linux.
5. **`/goal`.** The users who asked for `/goal` were on Codex, and v2 keeps Codex `/goal`. Only Claude-backend users lose it.
6. **"Experience unchanged".** v2 removes things from current users: no qa/write tier for Claude projects between V6b and V6d, no Claude `/goal`, and no DM console link until V4.
7. **Misread sources.** The "praise" in group message #45 was written by the maintainer. Issues #23 and #24 are bug reports from someone already running Kimi, not requests for it. PR #44 is still unverified for ordinary group members, which is the case #43 cares about.

**What this means for the decision:** The report proposes a 0.7.0 on bridge covering attachment delivery, external-trigger posting and install checks. That still matches the strongest recent signals: scheduled delivery came up again in a 10-09 thread, and Grok came up on 10-09 and 10-10. But bridge `main` is 49 commits behind v2's kernel base, and there are half-merged desktop and import branches. The choice between bridge and v2 has to account for both.

**Sources:**
- Local repos: /home/operator/vonvon/feishu-codex-bridge and /home/operator/vonvon/vonvon-bot/docs/{architecture,roadmap,providers,plan}.md.
- Read-only queries: `gh api`, api.npmjs.org, registry.npmjs.org, and `lark-cli` (read-only).
- Message dumps from those `lark-cli` calls are under （调研代理的本地临时目录，未归档）


### 逐条复查

- **说过头了**：npm downloads: June 6,110, August 675, last week 108, all-time 11,495, and usage 'has kept falling since the June launch'; August–October weeks with no release fell between 58 and 178
  - 依据：Re-queried api.npmjs.org today. point/last-week = 108 (10-06..10-12), last-month = 1,106, 2026-05-29..10-13 = 11,495. Monthly from the range endpoint: 05 362, 06 6,110, 07 3,072, 08 675, 09 1,115, 10 161. Monday-start weeks: 06-08 = 2,363, 08-10 = 249, 08-31 = 58, 09-14 = 261, 09-21 = 619. The registry shows releases 0.6.10 on 07-18 and 0.6.11 on 09-20, so no release fell in the 08-10 week.
- **说过头了**：The 285-member group 'Vonvon 灵感研究所' had 951 messages in total, and user messages fell 333 / 172 / 46 / 11 / 1 from June to October
  - 依据：`lark-cli api GET /open-apis/im/v1/chats/oc_f212…（已截断）` returned user_count 285; the angel group returned 42. `lark-cli im +chat-messages-list --page-all` returned 951 top-level messages, 557 of them from users. I count 330/170/45/11/1; the report's figures match if the 6 bot messages are included. The list leaves out thread replies. I fetched all 154 threads with `+threads-messages-list` and found 512 more user replies: 130/212/114/49/7. The maintainer (<飞书用户名>, sender of #411, #473, #877 and the release cards) sent 146 top-level messages.
- **有误**：On 9-18 (#956) a user asked '还维护吗这个项目', and the plan should 'answer it directly'
  - 依据：#956 exists (2026-09-18 09:51, '[看]还维护吗这个项目'). Its thread omt_19c8…（已截断） has a maintainer reply at 09:52: '在维护的。马上会有升级。桌面版也会推出'. The maintainer then posted release cards for 0.6.11, 0.6.12, 0.6.13 and 0.6.14 at #959, #961, #964 and #966 (09-20..09-24).
- **说过头了**：bridge `main` has had no commits since 2026-09-24 (6698118, 0.6.14), and private repo vonvon-bot was created the same day and is not on npm
  - 依据：`git log` in feishu-codex-bridge: the main tip is 6698118, 2026-09-24 22:10 +0800, 'chore(release): 0.6.14'. `gh api repos/modelzen/vonvon-bot`: created_at 2026-09-24T03:54:01Z, private. registry.npmjs.org/vonvon-bot returns 404. But `git log --all --since=2026-09-25` finds 43 commits on other bridge branches; the repo's pushed_at is 2026-10-11. Branch origin/codex/v9-owner-notice has ba7f5f8 'refuse startup after Vonvon Bot import' and 05e2635 'notify owners about Vonvon Bot import' (10-11). Maintainer PRs #30, #32, #35 and #45 are still open.
- **属实**：All 7 open external PRs have 0 reviews (#2, #13, #17, #18, #19, #20, #44), and 10 of the 11 open external issues have no maintainer reply
  - 依据：`gh api .../pulls?state=all` lists 15 non-MEMBER PRs. Six are merged (#3, #4, #7, #15, #25, #28) and seven are open. `pulls/N/reviews` returns length 0 for all seven, and the only issue comment on them is the contributor's own on #44. Open external issues: #1, #6, #8, #9, #12, #37, #38, #40, #41, #42, #43. Only #1 has a MEMBER comment (ClayCheung, 07-18). The comment on #6 is from a contributor, and those on #37 and #38 are from the issue author.
- **属实**：bridge has only two backends, codex-appserver and claude-agent (src/agent/catalog.ts:85-115)
  - 依据：BACKEND_CATALOG at feishu-codex-bridge/src/agent/catalog.ts:83-117 has exactly two entries, 'codex-appserver' and 'claude-agent'.
- **说过头了**：In bridge, read-only and read-write are enforced only on macOS and Windows, and on Linux choosing either refuses to start (README.md:158)
  - 依据：README.md:158 says this, but it describes Codex. src/agent/claude-agent/backend.ts:209-213 says 'Claude's sandbox supports macOS (Seatbelt) and Linux (bubblewrap), so all three tiers are offered'. The platform matrix at docs/design/project-status-2026-07-01.md:181-182 shows Claude qa/write as ✅ bubblewrap on Linux and ❌ on Windows.
- **说过头了**：v2 dropping the prompt-simulated `/goal` 'goes against user demand', since the users who asked for /goal (#241, #264-279) could lose it
  - 依据：vonvon-bot/docs/architecture.md:127 confirms the drop: '现有 Claude 后端用提示词循环模拟 goal，这一处删掉不搬'. But #241 (06-11) and #264 (06-12) were posted before the Claude backend existed: e7cb939 (06-13) added the minimal claude-sdk backend and 2e454e9 (06-17) added Claude /goal. Those users were on Codex's native goal. v2 keeps that through GoalControl and `goal: Support` (docs/providers.md:162, 256, 309).
- **说过头了**：v2's Feishu-side experience is unchanged and only adds things (section 3)
  - 依据：docs/roadmap.md:17 says V6b ships the 'Claude Code 引擎（只开完全访问）', and qa/write come back only in V6d after macOS and Linux tests (roadmap.md:19). docs/architecture.md:79 removes the DM menu's 网页控制台 button in V3. architecture.md:127 drops Claude /goal.
- **属实**：The v2 docs never mention scheduling, proactive delivery or attachments (定时/cron/投递/附件/triggerPolicy/token 消耗)
  - 依据：grep over docs/plan.md, providers.md, architecture.md and roadmap.md: 投递, 附件, triggerPolicy and 'token 消耗' have 0 hits. The one 定时 hit, roadmap.md:97, is about CI. The 'schedule' hits in plan.md:192/220/905/906/2099 are about the board, CI and the Windows scheduled-task relauncher, not product scheduling.
- **说过头了**：The only things users asked for that v2 also plans are Grok, visible sub-agents and reliable stop
  - 依据：The report's own table marks 'DeepSeek、Kimi、GLM、Qwen 通过 ~/.claude/settings.json 接入' (roadmap.md:40) as **有人要**. It also says the judgePath symlink fix (architecture.md:135) matches #43's request to block symlink escapes.
- **有误**：Positive signal: '/resume can sync both ways with Codex and was praised as a good experience (#45)'
  - 依据：Message #45 (2026-06-02, 'coding 用 bridge 的话，可以接力 codex 中进行一半的会话，用 /resume 接力…这个体验就很不错') was sent by <飞书用户名>. That is the maintainer's account, the same sender as #411, #473, #877 and the release cards #959-#966. #544/#554 (20+ interns), #877 (enterprise 'second brain' groups) and #485 (switched over from Zara) were checked and are as described; note that #877 is also the maintainer.
- **说过头了**：Users want Kimi through the Claude SDK (issue #23, #24)
  - 依据：Issue #23 body line 5: '在本地通过 Claude Agent SDK 接入 Kimi Coding 时稳定遇到此问题'. It is a bug report about swallowed API errors. #24 asks to show Kimi's quota reset time. Both are closed, and the maintainer commented '已合入 PR' on #24.
- **说过头了**：PR #44's contributor ran it in a real project on 10-02..10-03, so it is nearly ready to merge
  - 依据：The PR #44 comment of 2026-10-04 reports 6 delivery manifests and 9 attachments sent on 10-02..10-03. The same comment says: 'Ordinary group-member retrieval and tenant file-policy behavior remain unverified, so full live acceptance is still pending.'

### 正文遗漏的事实

- The report leaves out thread replies. There are 512 user replies across 154 threads, and the October replies matter for strategy. On 10-09 a user suggested '搞点定时任务让他把信息丢去飞书'. On 10-10 a user said they had Grok working with Feishu ('已经搞定了 回头测试好给原项目推pr'). On 10-03 a user proposed pre-uploading small files to Drive so the link is ready immediately. Source: `lark-cli im +threads-messages-list` over all thread_ids from the top-level list.
- On 09-18 the maintainer publicly promised a desktop version ('桌面版也会推出', reply in thread omt_19c8…（已截断）). This is the clearest outside reason v2 has a desktop shell, and the report's conclusion that 'nobody asked for a desktop' should be weighed against it.
- Bridge branch origin/codex/v9-owner-notice already makes bridge refuse to start after an import, notify owners and show Vonvon import guidance (ba7f5f8, 05e2635, 597745e, all 2026-10-11). Maintainer PRs #30 (adds a `vonvon-bridge` command and the `~/.vonvon-bridge` data root), #32, #35 and #45 are open on bridge. A 0.7.0 cut from bridge main would have to deal with this half-merged desktop work.
- v2's kernel base 446b2a4 is on `codex/device-handoff`, which is 49 commits ahead of bridge main (`git rev-list --count origin/main..origin/codex/device-handoff` = 49; docs/architecture.md:77). Porting fixes in either direction is harder than 'v2 copied bridge' suggests.
- Much of the 'desktop' interest in the group is about the Codex desktop app, not a bridge desktop app. Users mix up Codex.app and the Codex CLI (#49, #534, and several 07-02 thread replies asking whether Feishu controls the desktop app or the CLI). Users also asked whether Codex.app sees bridge sessions (#591, #875, #910). The maintainer replied that it does if the project uses the same path and Codex.app is restarted. That is an onboarding and doctor gap, not a desktop-shell need.
- The maintainer already has a Feishu-native answer for files that will not open on a phone (#669): have the agent turn csv/excel into online sheets, md into Feishu docs, and html into 妙搭 or Drive through lark-cli. The report's 0.7.0 plan does not mention this cheaper path.
- #708 says the current Codex CLI sandboxes on Linux/WSL2 with bubblewrap. v2's architecture.md:129 still refuses Codex 'project-only' read on Linux on the grounds that 'Landlock 不能限读'. This should be re-checked before V7c and V6d lock in the permission table.
- The idle watchdog default really is 120s (feishu-codex-bridge/src/config/schema.ts:310-319, 'Default 120s, ON'). The report's claim that most user 'timeouts' are this watchdog has no evidence behind it, and nothing I checked confirms it.
- The new-member counts per month (158/78/52/21/5) could not be reproduced. Counting invite/join system messages gives 172/80/57/26/5 messages, and one message can add several people. Treat those numbers as unverified.
