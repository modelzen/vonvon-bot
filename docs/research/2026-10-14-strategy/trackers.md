# Vonvon Bot 桌面任务派发与三方沟通方案对比（2026-10-14）

## 结论

- **推荐方案：混合。** 新开一个 Linear 团队 `DESK` 作为用户工作台，只放需要用户本人去做或去决定的事，包括桌面任务、产品决策、Demo 试用和用户操作。代码、PR、CI、`owner:` 标签、交接评论、#122（程序看板）和验收证据仍然只在 GitHub。Linear 从 Free 计划起步。Claude 和 Codex 各用一个 Linear OAuth app 身份，Linear 文档写明 app 身份不算计费用户。
- **两个方案打分几乎持平：** 加权分 Linear 69/80，GitHub 修补版 70/80。选 Linear 是因为用户要的三件事 GitHub 做不到或做得差：
  - 在 issue 上一键打开 Codex 桌面版，prompt 按模板预先填好；
  - 手机上有一个只装用户待办的收件箱；
  - 有项目、里程碑和项目更新页面，适合讨论产品。

  如果不想多一个系统，就走 B 方案（只用 GitHub 并修补），成本 0，大约 1–2 小时。
- **两个方案都要先修的问题：** 在 GitHub 上，Claude、Codex 和用户用的是同一个账号 ClayCheung。GitHub 不会把你自己账号的操作推送给你，所以 agent 现在建的任何 issue 都到不了用户手机。换到 Linear 也一样：不能用用户的个人 API key，否则同样收不到推送。

## 现状核对（只跑了只读命令）

| 事实 | 证据 |
|---|---|
| JP-VPS 上 `gh` 登录的是 ClayCheung，也就是 `docs/program-graph.json:4` 的 `operatorLogin` | `gh api user` |
| PR #284（平台相关超时的测试修复）上的交接、Shipping、冻结、合入评论，作者全是 ClayCheung。Codex 在 Mac 上也用同一个账号 | `gh pr view 284 --json comments` |
| GitHub Mobile 可以推送的事件：直接 @提及、被分配 issue 或 PR、评审请求、部署审批。旧版文档写明不会通知你自己的操作 | [GitHub 通知配置](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)；[旧版 about notifications](https://docs.github.com/enterprise/2.4/user/articles/about-notifications) |
| modelzen 组织是 Team 计划，1 个席位。已有组织 issue 类型 Task、Bug、Feature，已有 Project “Vonvon Bot v2” | `gh api orgs/modelzen`、`gh api orgs/modelzen/issue-types`、`gh project list` |
| 已经有“只有用户能做的事”这一类：标签 `needs-operator`，OP-1 到 OP-5 是 issue #205–#209（用户操作项，由 program-graph 生成） | `gh issue list --label needs-operator`；`docs/plan.md:191` |
| JP-VPS 的 `gh` 是 2.45.0（Ubuntu 包）。2026-09-01 新增的 `--attach` 上传图片和视频需要 v2.99.0 以上 | `gh --version`；[changelog 2026-09-01](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments) |
| 仓库规则：进度只看 #122 和 PR 状态（`AGENTS.md:26`）；状态只在 GitHub（`scripts/handoff.mjs:7-8`） | 文件 |
| 仓库里没有 `.github/ISSUE_TEMPLATE` | `ls .github` |

## 打分表

满分 5 分。权重：(1) ×3；(2)(3)(4)(6)(9) ×2；(5)(7)(8) ×1。加权满分 80。

| 标准 | Linear（只做 DESK 工作台） | GitHub 现状 | GitHub 修补版（B 方案） | Jira Free | Plane Cloud Free | Plane 自建 CE | Shortcut Free |
|---|---|---|---|---|---|---|---|
| 1 用户手机收到“有你的任务”推送 | 5 | 1 | 4（待验证） | 4 | 3（未验证） | 3（未验证） | 3（未验证） |
| 2 在桌面一键复制 prompt | 5 | 4 | 4 | 3 | 3 | 3 | 3 |
| 3 反馈带截图、视频方便 | 3 | 3 | 5 | 4 | 3 | 3 | 4 |
| 4 Claude 和 Codex 无桌面也能读写 | 5 | 5 | 5 | 3 | 4 | 3 | 4 |
| 5 自动关联 GitHub PR | 5 | 5 | 5 | 4 | 1 | 2（未验证） | 4 |
| 6 产品讨论和可见里程碑 | 5 | 3 | 3 | 4 | 4 | 4 | 4 |
| 7 独立开发者加 agent 的成本 | 4 | 5 | 5 | 3 | 4 | 3 | 4 |
| 8 设置工作量 | 3 | 5 | 4 | 2 | 3 | 1 | 3 |
| 9 锁定和两份真相的风险 | 3 | 5 | 5 | 2 | 3 | 4 | 3 |
| **加权合计** | **69** | 58 | **70** | 53 | 51 | 49 | 56 |

### 各项打分依据

**Linear**
1. 推送：iOS 和 Android app 有实时推送（[mobile](https://linear.app/mobile)，2024-09-19 上线）。2026-09-03 加了 Priority inbox，把被分配的通知单独放一栏（[changelog](https://linear.app/changelog/2026-09-03-priority-inbox)）。
2. 一键复制：2026-02-26 起可以从 issue 直接打开编程工具，prompt 自动带上 issue 描述、评论、链接和图片。prompt 模板可以自定义，支持 `{{issue.identifier}}` 和 `{{context}}`。也可以“复制为 prompt”（[changelog](https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools)）。2026-03-12 的条目明确列出“Codex desktop”和“Codex CLI”（[changelog](https://linear.app/changelog/2026-03-12-ui-refresh)）。
3. 截图视频：Free 单个文件上限 10MB（[pricing](https://linear.app/pricing)），视频会受限。2026-09-24 起 macOS 桌面版斜杠菜单可以“Insert screenshot”。
4. 无桌面读写：
   - 官方 MCP 地址 `https://mcp.linear.app/mcp`，可以直接用 `Authorization: Bearer` 传 OAuth token 或 API key，不用浏览器登录（[MCP docs](https://linear.app/docs/mcp)）。
   - OAuth 支持 `client_credentials`，以 app 身份操作，适合机器对机器，token 30 天有效、没有 refresh token，文档建议每次运行开始时现取一个（[OAuth docs](https://linear.app/developers/oauth-2-0-authentication)）。
   - 没有官方 CLI。
5. PR 关联：所有计划都有 PR 关联、magic words 和状态自动化。也可以用 `related to` 只关联、不改状态（[GitHub 集成](https://linear.app/docs/github)）。
6. 产品讨论：有项目、里程碑、项目更新、文档和 initiative。2026-09-03 起手机上能编辑文档。
7. 成本：Free 为 $0，成员不限，2 个团队，250 个 issue。“Agents don't count as billable users”（[agents](https://linear.app/developers/agents)）。不够用时 Basic 是 $10/人/月（按年付）。
8. 设置：大约半天。要建两个 OAuth app、在两台机器配 MCP、装 GitHub 集成、配模板和用户偏好。
9. 风险：多出一个系统，靠严格的分区规则压住两份真相的问题。

**GitHub 现状**
1. 推送：所有操作者都是 ClayCheung，推送事实上为零。
2. 复制：fenced code block 有复制按钮（这是我知道的现有行为，今天没找到带日期的文档出处）。GitHub 会清洗 markdown 里的自定义协议链接，`codex://` 链接点不了，旁证见 [github-mcp-server PR](https://gh.mise.run.place/github/github-mcp-server/pull/2085)。
3. 截图视频：网页可以拖放，Team 计划视频上限 100MB（[attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)）。agent 现在的 gh 2.45 没法传。

**GitHub 修补版（B 方案）**
1. 推送：改由 bot 身份分配或 @提及用户，就会走 GitHub Mobile 的“Assignments”或“Direct mentions”推送。由 GitHub App 或 github-actions 触发的推送能不能送到，我没找到文档，要先建一个测试 issue 确认。
3. 截图视频：升级到 gh 2.99 以上后，agent 和 Codex 桌面版都能用 `--attach` 传 PNG、JPEG、GIF、WebP、SVG、MP4、MOV、WebM（[docs](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)）。
6. 产品讨论：Projects 有 roadmap 视图。issue fields 已于 2026-07-02 GA，支持组织的 Free 和 Team 计划，并可通过 MCP 读写（[changelog](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available)）。2026-06-10 起 gh 能管理 issue 类型、子 issue 和依赖（[changelog](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/)）。项目更新和决策记录不如 Linear 结构化。
7. 成本：GitHub App 不占席位。机器账号在 Team 计划下作为成员或私有仓库外部协作者会占一个付费席位（[license users](https://docs.github.com/en/billing/reference/github-license-users)）。服务条款允许每人一个免费机器账号（[ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)）。

**Jira Free**
- 最多 10 个用户、2GB 存储，Free 不含 Rovo AI（[pricing](https://www.atlassian.com/en/software/jira/pricing)）。
- Rovo MCP 已 GA（第三方报道为 2026-02-04）。API token 要组织管理员先开启（[atlassian-mcp-server](https://github.com/atlassian/atlassian-mcp-server)）。
- 2026-07-15 发布的“把 Jira 工作项分配给编程 agent”只对付费客户开放，首批是云端 agent，Codex 稍后才支持（[The New Stack](https://thenewstack.io/atlassian-jira-coding-agents/)）。
- 对一个人的团队来说太重。

**Plane**
- Cloud Free 上限 12 人，**GitHub 集成要 Pro**（$6/人/月起）（[pricing](https://plane.so/pricing)）。
- 官方 MCP：`https://mcp.plane.so/http/api-key/mcp` 接受 PAT。自建 Community Edition 只能用 stdio 模式（[MCP docs](https://developers.plane.so/dev-tools/mcp-server)）。
- 自建要占 JP-VPS 那 3.9GB 内存，不现实。

**Shortcut**
- Free 最多 10 人，含 GitHub 集成，5GB 存储（[pricing](https://www.shortcut.com/pricing)）。
- 官方 MCP 在 `https://mcp.shortcut.com/mcp`，也有用 token 的本地版（[help](https://www.shortcut.com/help/integrations/mcp-server)）。
- 没找到 agent 身份是否占席位的说明。

### 没打分的候选

- **Height：** 已停服。2025-03-24 宣布 2025 年 9 月关闭（[AlternativeTo](https://alternativeto.net/software/height/news)），今天 height.app 连不上。
- **面向 agent 的看板（Backlog.md、Agent Kanban、kaban、Kelvia 等）：** 都很早期，没有手机推送，设计上是 agent 自己领任务，不是派给人。不适合。
- **GitHub Agent HQ、Linear 里的 Codex 云 agent、Jira coding agent：** 都是把活派给云端 agent，碰不到用户 Mac 的桌面，和这个闭环无关（[Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)；[Codex in Linear](https://learn.chatgpt.com/docs/third-party/linear.md)）。

## 推荐方案

用 Linear 只做用户工作台，GitHub 继续是唯一的工程真相。

**为什么选 Linear 而不是 GitHub 修补版：**
- 用户在 Mac 桌面版按 Cmd+Option+.（或 issue 编号旁的按钮），就能把桌面任务连同模板和参考截图直接送进 Codex 桌面版，比“复制再粘贴”少一步，也不会漏掉附图。
- 推送进的是一个只放用户待办的收件箱，不和每个 PR 的评审噪声混在一起。
- 项目更新和里程碑页面适合放“Demo 可试”和产品讨论。
- 两个 agent 身份免费。

**这样设计是为了压住两份真相的风险：**
- 一个条目只活在一个系统里，另一边只放链接。
- 不开 Linear 的 GitHub Issues 同步：一个仓库只能配一个双向同步，而且会把所有新建的 GitHub issue 都导进来。program-graph 会生成大量 issue，会很快吃光 Free 的 250 个 issue 额度。
- 截图和视频等验收证据一律贴在 GitHub PR 上：Team 计划视频上限 100MB，而且 PR 本来就是验收记录。Linear 上只放用户的结论和指向 PR 评论的链接，这样也避开了 Linear Free 的 10MB 上限。
- 设计决定最后写进 `docs/`。Linear 的决策条目只记录用户选了哪个，并链接到落地的 commit。

**什么情况下改选 B 方案：** 用户不想再多看一个 app、不在乎一键打开 Codex，或者 Linear 工作区不能新建团队或 OAuth app。

## 具体工作流（Linear 方案）

### 身份

- 在 Linear 建两个 OAuth app：“Claude · JP-VPS”和“Codex · Mac mini”。都开启 client credentials，以 `actor=app` 安装（要管理员）。
- 每次运行开始时现取一个 30 天有效的 token，用完不长期保存。
- 用户本人用自己的 Linear 账号。这样 app 建的条目、分配和 @提及都会推送给用户。

### 条目类型

用标签组 `Type` 区分。

| 类型 | 谁建 | 用户要做的 | 关闭条件 | 证据放在 |
|---|---|---|---|---|
| Desktop task（桌面任务） | Claude（设计期要在真桌面上确认的事）；Codex（验收时需要 Computer Use、托盘、系统弹窗、真窗口的步骤） | 在指定 Mac 上用 Codex 桌面版执行，看着它跑，给出结论 | 用户写了结论，agent 读完并在 PR 里回应 | GitHub PR 评论（`gh --attach`） |
| Product decision（产品决策） | Claude | 在 A/B/C 里选一个，可以在手机上完成 | Claude 把决定写进 `docs/` 并合入，条目链接到那个 commit | `docs/` |
| Demo ready（Demo 可试） | Codex（合入后）或 Claude（分支可试时） | 按清单试用，写体验意见 | 清单跑完；意见拆成决策条目或 GitHub 缺陷 | 清单在 Linear，缺陷在 GitHub |
| Operator action（用户操作） | 两边都可以 | 账号、付款、登录图形会话这类操作 | 用户做完 | Linear 评论 |

“Agent PR”不建 Linear 条目，PR 只在 GitHub。相关条目在附件里放 PR URL；PR 描述里写 `Related to DESK-12`，这是只关联不改状态的写法。不要用 `fixes` 这类关闭词，否则 PR 合入时会把桌面任务自动关掉。

### 状态（DESK 团队的工作流）

`Triage`（用户自己记的想法）→ `Todo`（等用户；agent 建的条目直接进这里并分配给用户，以触发推送）→ `In Progress`（用户正在执行）→ `Reported`（已反馈，等 agent 处理）→ `Done` / `Canceled`

### 标签和优先级

- `Type`：desktop-task / decision / demo / operator
- `Host`：mac-mini / macbook-air / iphone / any。桌面任务必须写死一台：Computer Use 只能操作运行 Codex 桌面版的那台 Mac 的屏幕。
- `Verdict`：pass / fail / blocked。只有用户能设。
- `Version`：V5…V11，可选，只用于筛选。
- 优先级：Urgent 表示挡住冻结或合入；High 表示挡住在飞 PR 的下一步；Medium 表示下个版本要；Low 表示随时都行。

### 用户一次性配置的 Codex 打开模板

在 Linear 的 Preferences → coding tools 里启用 Codex desktop，模板如下：

~~~text
{{context}}

---
这是 vonvon-bot 的桌面任务 {{issue.identifier}}。只执行描述里「Prompt」一节，用「期望结果」逐条判定。
不改代码、不 commit、不 push。遇到系统授权弹窗时停下来让我点。
截图和录屏存到 ~/vonvon-desk/{{issue.identifier}}/。结束时按「反馈」一节输出，并按 Prompt 末尾的命令贴到 PR。
~~~

### 桌面任务模板（Linear issue template；B 方案里同样可以做成 issue form）

````markdown
**标题** [桌面] <要确认的事> — PR #<号>（<PR 做什么>）

**来源** PR #<号> · head `<sha7>` · 发起方 Claude / Codex
**主机** Mac mini（用户 clay 的图形会话）  ← 只写一台
**构建** `<取得被测构建的方式：分支和 commit、构建命令或安装包路径>`
**挡住** PR #<号> 验收要点中的第 <n> 项 · **截止** <日期>

## Prompt
> 下面是当时设计的提示词模板，只作示例，不要执行。这个 Linear 方案没有采用。

在 Linear 桌面版按 ⌘⌥. 直接打开 Codex 桌面版，或复制下面整块：

```text
你在 <主机> 上，工作目录 <绝对路径>。任务 <DESK-ID>，对应 PR #<号> head <sha7>。
先确认 `git -C <路径> rev-parse --short HEAD` 等于 <sha7>，不等就停下报告。
目标：<一句话>
步骤：
1. <启动方式，例如 npm run desktop，或打开某个 .app>
2. <要点击或观察的地方：窗口、托盘菜单、系统对话框>
3. <……>
约束：不改代码，不碰 <受保护的服务或标签，例如日常 bridge>；遇到授权弹窗时停下让用户点。
证据：每一步截图存 ~/vonvon-desk/<DESK-ID>/NN-<步骤>.png；关键交互用 ⌘⇧5 录屏存 .mov（不超过 100MB）。
完成后：把「反馈」一节填好写入 ~/vonvon-desk/<DESK-ID>/feedback.md，再运行
  gh pr comment <号> -R modelzen/vonvon-bot --body-file ~/vonvon-desk/<DESK-ID>/feedback.md \
    --attach ~/vonvon-desk/<DESK-ID>/01-<步骤>.png --attach ~/vonvon-desk/<DESK-ID>/run.mov
（需要 gh ≥ 2.99）
```

## 期望结果
- [ ] E1 <可观察、可判定的结果，例如：托盘菜单出现「Vonvon Bot」并显示版本 x>
- [ ] E2 <……>
**不在范围** <……>
**已知缺口** <只用假对象测过的部分、Windows 未验等>

## 反馈（Codex 桌面版起草，结论由用户定）
- 结论：PASS / FAIL / BLOCKED（用户填；同时设置 Verdict 标签）
- 实际 head：`<sha7>` · 主机和 macOS 版本：
- E1：✅/❌ — 看到了什么（截图编号）
- E2：
- 意外发现：
- 证据：<PR 评论链接>
- 用户的产品意见：
````

**产品决策模板（简版）：**
- 正文：背景两三句；选项 A/B/C，每项写代价和影响到的版本；Claude 的推荐和理由；截止日期。
- 用户回复写“选 B + 一句理由”，在手机上就能完成。
- Claude 落地到 `docs/`，在条目里贴 commit 链接后关闭。

**Demo 可试模板（简版）：**
- 正文：构建位置、怎么启动；5–10 条试用清单（checkbox）；“哪些还没做”；反馈区写体验意见。
- 不需要贴证据。

### 一次桌面任务的走向

1. Claude 或 Codex 用自己的 Linear app 身份通过 MCP（`save_issue`）建条目，状态 Todo，分配给用户，附上 PR URL。PR 描述里加 `Related to DESK-n`。
2. 用户 iPhone 收到推送，在 Mac 上用 Linear 桌面版打开 Codex 桌面版，把状态改为 In Progress，看着 Computer Use 跑。
3. Codex 桌面版按 prompt 把证据和反馈贴到 PR。用户在 Linear 设 Verdict 标签、改为 Reported，并评论 PR 评论的链接。这一步也可以让 Codex 桌面版通过 Linear MCP 代做，这时它以用户身份操作。
4. 需要结果的 agent 会话在等待期间低频轮询这个条目是否变成 Reported，读取 PR 评论后继续。之后可以在一个 TOOLING PR 里写 `scripts/desk.mjs create|wait|close`。
5. agent 在 PR 里回应。结论是 FAIL 时，在 GitHub 开缺陷或改代码，不在 Linear 里讨论代码；然后把 DESK 条目改为 Done。

### 哪些留在 GitHub，哪些进 Linear

| 留在 GitHub（唯一真相） | 进 Linear DESK |
|---|---|
| 代码、分支、PR、评审、CI、`frozen` 和 `owner:` 标签、`handoff.mjs` 交接 | 桌面任务、产品决策、Demo 试用清单、用户操作 |
| #122 程序看板、版本和任务 issue、`docs/program-graph.json` | 面向用户的里程碑项目和项目更新，每个项目链接到对应的 GitHub 版本 issue |
| 验收证据（截图和视频贴在 PR）、发现的缺陷 | 用户的结论（Verdict）和产品意见 |
| 设计决定的最终文本（`docs/`） | 决策过程和用户选择，链接到落地的 commit |

还没定的一项：已有的 OP-2 到 OP-5（#206–#209，用户操作项）要么留在 GitHub，要么迁到 DESK、在 program-graph 里记 DESK 编号后关闭 GitHub 侧。迁移能做到一个收件箱；不迁则改动最小。这要用户决定。

### 设置清单（大约半天）

1. **工作区和模板：** 确认 Linear 工作区和计划（“我们的 Linear”说明可能已经有了；如果是付费计划，Free 的限制都不存在）。建 `DESK` 团队、上面的状态、标签组和三个模板。
2. **两个 OAuth app：** 建好并开启 client credentials，scope 只给 read 和 write。
3. **MCP：**
   - Claude Code：`claude mcp add --transport http linear https://mcp.linear.app/mcp --header "Authorization: Bearer <现取的 token>"`。
   - Codex CLI：`codex mcp add linear --url https://mcp.linear.app/mcp`，再在 config.toml 里配 bearer token。具体键名今天没核对。
   - token 每 30 天要重取，建议用一个小包装脚本在会话开始时取。
4. **GitHub 集成：** 只开 PR 关联，不开 GitHub Issues 同步。
5. **用户手机和桌面：** 在 iOS 的通知设置里打开 Mobile 渠道下的 Assignments 和 Mentions。桌面版启用 Codex desktop 并填上面的模板。
6. **gh 升级：** 跑 Codex 桌面版的那台 Mac 和 JP-VPS 都把 gh 升到 2.99 以上。JP-VPS 要换 GitHub 官方 apt 源，Ubuntu 自带的包是 2.45.0。
7. **规则文档：** 按照“在飞 PR 不另开文档 PR”和“纯文档 PR 可以自己合入”的规定，另开一个纯文档 PR 修改 `AGENTS.md:26`，加一句“用户待办只看 Linear DESK 团队”，并写明上面的分区表。

## B 方案：只用 GitHub（不增加新工具）

1. **bot 身份：** 加一个 Actions workflow，在 `issues: labeled` 且标签为 `needs-operator` 时触发，用 `GITHUB_TOKEN` 把 issue 分配给 ClayCheung，并发一条 `@ClayCheung` 评论。操作者变成 github-actions[bot]，就能触发推送。也可以用一个 GitHub App，免费、不占席位。机器账号会占 Team 席位，不推荐。先建一个测试 issue 确认推送能到手机。
2. **issue form：** 建 `.github/ISSUE_TEMPLATE/desktop-task.yml`，正文同上面的模板，prompt 放在 ```text 块里，用复制按钮复制。再加一个组织 issue 类型 “Desktop task”。
3. **Projects 视图：** 在 Project “Vonvon Bot v2” 里加一个 “Owner desk” 视图，筛选 `assignee:ClayCheung label:needs-operator`。
4. **gh 升级：** 同样升到 2.99 以上，用 `--attach` 上传证据。
5. **还缺的：** 没有一键打开 Codex 桌面版（`codex://new?prompt=…&path=…` 这种深链接存在，见 [Codex 深链接文档](https://learn.chatgpt.com/docs/reference/commands.md)，但 GitHub 会清洗掉自定义协议链接，只能另做一个 https 跳转页）；用户的推送和其他 GitHub 通知混在一起；产品讨论只有 issue 和 Discussions。

## 未知和待验证

- Linear Free 的 250 个 issue 是否包括已归档的：官方定价页和计费文档都没说明。只有 DESK 条目的量应该不大，但还是要盯着。
- Linear 的 Codex desktop 打开时会不会设置工作区路径：文档没说，所以模板在 prompt 里写了绝对路径。
- 由 GitHub App 或 github-actions 触发的分配和 @提及会不会推到 GitHub Mobile：预期会，没找到文档，要实测。
- Linear 编辑器的代码块有没有复制按钮：没核实。“复制为 prompt”已经由 changelog 确认。
- Linear MCP 能不能上传附件：文档没列工具清单。证据走 GitHub PR，所以这一点不影响方案。
- Plane 和 Shortcut 的手机推送质量、Shortcut 的 agent 是否占席位：没核实。
- Computer Use 的页面今天写的是“ChatGPT desktop app，ChatGPT Work and Codex 计划，部分地区可用”（[docs](https://learn.chatgpt.com/docs/computer-use.md)）。用户那台 Mac 上的具体可用性需要用户自己确认。

## 来源（访问于 2026-10-14）

- Linear：[pricing](https://linear.app/pricing) · [agents](https://linear.app/developers/agents) · [OAuth 和 client credentials](https://linear.app/developers/oauth-2-0-authentication) · [MCP](https://linear.app/docs/mcp) · [GitHub 集成](https://linear.app/docs/github) · [打开编程工具 2026-02-26](https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools) · [UI refresh 2026-03-12](https://linear.app/changelog/2026-03-12-ui-refresh) · [Priority inbox 2026-09-03](https://linear.app/changelog/2026-09-03-priority-inbox) · [changelog 索引](https://linear.app/changelog) · [mobile](https://linear.app/mobile) · [billing](https://linear.app/docs/billing-and-plans)
- GitHub：[通知配置](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications) · [附件上限](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) · [gh --attach 文档](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) · [gh --attach changelog 2026-09-01](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments) · [issue fields GA 2026-07-02](https://github.blog/changelog/2026-07-02-issue-fields-are-now-generally-available) · [gh 管理子 issue、类型、依赖 2026-06-10](https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/) · [license users](https://docs.github.com/en/billing/reference/github-license-users) · [ToS](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) · [Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/)
- OpenAI Codex：[深链接](https://learn.chatgpt.com/docs/reference/commands.md) · [Computer Use](https://learn.chatgpt.com/docs/computer-use.md) · [Codex in Linear](https://learn.chatgpt.com/docs/third-party/linear.md)
- 其他：[Jira pricing](https://www.atlassian.com/en/software/jira/pricing) · [Atlassian MCP](https://github.com/atlassian/atlassian-mcp-server) · [Jira coding agents](https://thenewstack.io/atlassian-jira-coding-agents/) · [Plane pricing](https://plane.so/pricing) · [Plane MCP](https://developers.plane.so/dev-tools/mcp-server) · [Shortcut pricing](https://www.shortcut.com/pricing) · [Shortcut MCP](https://www.shortcut.com/help/integrations/mcp-server) · [Height 停服消息](https://alternativeto.net/software/height/news)
- 本地文件：`/home/operator/vonvon/vonvon-bot/AGENTS.md:10,26,29` · `/home/operator/vonvon/vonvon-bot/scripts/handoff.mjs:7-8` · `/home/operator/vonvon/vonvon-bot/docs/plan.md:191` · `/home/operator/vonvon/vonvon-bot/docs/program-graph.json:4`


---

## 核实记录

另一个代理在 2026-10-14 独立复查了本文的主要结论。正文和这里冲突时，以这里为准。

**总体结论**：Most of the report's load-bearing facts hold up against official pages fetched 2026-10-14. These are confirmed: Linear Free limits and Basic price, agents not billed, the client_credentials 30-day token with no refresh, bearer auth on the MCP server, the open-in-coding-tool templates and Cmd+Option+. shortcut, Codex desktop listed as a launcher, `related to` linking without status changes, gh --attach in v2.99.0 with 100MB video on paid plans, the Plane and Jira limits, and the local facts (ClayCheung is the only identity, gh 2.45.0, Team plan with 1 seat, OP-1 to OP-5 are #205 to #209). These are overstated or unsupported: Priority inbox is an urgency filter, not an inbox for assignments; Insert screenshot shipped 2026-09-03, not 09-24; `save_issue` and attachment support appear in no official Linear doc; the Shortcut local token server is archived; 'GitHub App takes no seat' isn't on the page cited; GitHub integration on Linear Free isn't documented on the pages cited; the codex:// sanitization source should be the github.com PR, not a mirror. The main premise, that pushes only work when a separate identity does the assigning or mentioning, is backed by older GitHub docs. For Linear it is an inference, and for github-actions or App-triggered pushes it is untested, as the report says. The biggest gaps: 'Codex desktop' is now the ChatGPT desktop app (it keeps codex:// for compatibility), the Mac GUI user is <Mac 测试用户> and not clay, and the Agent APIs are a Developer Preview. None of this flips the recommendation, but run three live tests before committing to Linear: app-actor assignment reaching iPhone push, the Linear 'Codex desktop' launcher opening the ChatGPT/Codex app on the owner's Mac, and Linear Free's team count in the existing workspace.


### 逐条复查

- **属实**：Linear docs say app identities are not billable users ("Agents don't count as billable users"), so the Claude and Codex OAuth app identities are free.
  - 依据：https://linear.app/developers/agents (no date on page) says "agents installed in your workspace do not count as billable users" and "It does not cost anything to develop agents in Linear." Installing with actor=app needs admin permissions. The same page labels the Agent APIs a Developer Preview: "Functionality and Agent APIs may change before general availability." The billing doc (https://linear.app/docs/billing-and-plans) only says customers are billed for "unsuspended users" and says nothing about apps.
- **属实**：Linear Free costs $0 with unlimited members, 2 teams, 250 issues and a 10MB per-file limit. Basic is $10 per user per month, billed yearly.
  - 依据：https://linear.app/pricing, fetched 2026-10-14. Free: "$0", "Unlimited members", "2 teams", "250 issues", "10MB". Basic: "$10 per user/month" billed yearly, 5 teams, unlimited issues and uploads. Neither the pricing page nor the billing doc says whether archived issues count toward the 250, which the report already lists as unknown.
- **属实**：From 2026-02-26 you can open an issue in a coding tool. The prompt carries the description, comments, links and images. Templates support {{issue.identifier}} and {{context}}, "copy as prompt" exists, and the shortcut is Cmd+Option+. The 2026-03-12 entry lists Codex desktop and Codex CLI.
  - 依据：https://linear.app/changelog/2026-02-26-deeplink-to-ai-coding-tools says "Use {{issue.identifier}} or {{context}} to insert dynamic values" and the prompt includes "description, comments, updates, linked references, and images". It mentions copying an issue as a prompt and the shortcut "Cmd Option . (Mac) or Ctrl Alt . (Windows/Linux)", which opens the most recently used tool. Templates are personal settings at settings/account/preferences. https://linear.app/changelog/2026-03-12-ui-refresh says "...Claude Code, Cursor, and Codex desktop, you can also now open issues in:" and adds Codex CLI. Neither entry says whether this works only in the desktop app or also on the web, or whether a working directory is set.
- **说过头了**：The Linear MCP server at https://mcp.linear.app/mcp accepts an OAuth token or API key in Authorization: Bearer without a browser login. Agents create issues with the `save_issue` tool.
  - 依据：https://linear.app/docs/mcp (no date) says the server "supports passing OAuth token and API keys directly in the `Authorization: Bearer <yourtoken>` header", and that this lets you connect as an `app` user. That part is confirmed. The page lists no individual tools, only "finding, creating, and updating objects ... like issues, projects, and comments". The only `save_issue` reference I found is a third-party blog (mcpbundles.com). The page's own setup commands use interactive auth (`/mcp` in Claude Code, `codex mcp login linear`).
- **属实**：Linear OAuth supports client_credentials and acts as the app. Tokens last 30 days with no refresh token, and the docs recommend fetching a new token at the start of each run.
  - 依据：https://linear.app/developers/oauth-2-0-authentication: you must "toggle on client credentials tokens for your OAuth2 app". The result is an "app actor token" that "has access to all public teams" and "is valid for 30 days". "there is no refresh token paired with this access token." The docs say: "Request a new client credentials token at the start of each run." The page does not say an admin is required for client credentials. The admin requirement comes from the agents page, for actor=app installs.
- **说过头了**：Linear's GitHub integration on all plans has PR linking, magic words and status automation. `related to` links without changing status. Only one two-way GitHub Issues sync is allowed per repository, and it imports every newly created GitHub issue.
  - 依据：https://linear.app/docs/github: "relates to"/"related to" means "Linear simply marks the PR as related to the issue, with no status changes" (confirmed). The sync limit is "only one repo can be configured for two-way sync at a time", a limit on the whole configuration, not one per repository. "GitHub Issues Sync will only sync newly created issues" (consistent with the report). Neither this page nor https://linear.app/pricing says the GitHub integration is on every plan. Pricing has no GitHub row; only the GitHub Enterprise options are marked Enterprise.
- **说过头了**：Priority inbox, added 2026-09-03, puts assigned notifications in their own column, so the owner gets an inbox that holds only their to-dos. Also, the macOS desktop slash menu gained "Insert screenshot" on 2026-09-24.
  - 依据：https://linear.app/changelog/2026-09-03-priority-inbox: "The new Priority tab separates what needs your attention from what can wait." Linear picks what appears there by default, and you can customize it by source or filter. The entry doesn't say assignments go there. The changelog index (https://linear.app/changelog) puts "Added an Insert screenshot option to the desktop slash menu on macOS" in the 2026-09-03 entry, not 2026-09-24.
- **说过头了**：GitHub does not notify you about your own actions, so issues the agents create under ClayCheung never reach the owner's phone. The same would hold in Linear with the owner's personal API key.
  - 依据：For GitHub: the old GHE 2.4 docs (https://docs.github.com/enterprise/2.4/user/articles/about-notifications) say "You can't receive notifications for your own actions." The current configuring-notifications page is silent on this but offers an email-only opt-in for "Your own updates", which implies own actions are excluded by default. The shared identity is confirmed locally: `gh api user` returns ClayCheung, `gh pr view 284 --json comments` shows comment authors ["ClayCheung"], and `docs/program-graph.json:4` has operatorLogin ClayCheung. For Linear: https://linear.app/docs/notifications does not cover notifications about your own actions or from apps.
- **属实**：gh --attach for images and video arrived 2026-09-01 and needs gh v2.99.0+. JP-VPS has 2.45.0. Supported types are PNG/JPEG/GIF/WebP/SVG/MP4/MOV/WebM. The Team plan video limit is 100MB.
  - 依据：https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments: v2.99.0, repeatable `--attach` on issue/pr create, edit and comment, with exactly those eight types. Limits are 10MB for images, and for video 10MB on Free and 100MB on paid plans. It is available on all plans and needs write access. https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli: "You need push access to the repository". https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files: 100MB video for paid-plan orgs. Locally, `gh --version` prints `2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)` and `gh api orgs/modelzen` shows plan team, seats 1.
- **说过头了**：A GitHub App takes no seat. A machine account takes a paid Team seat, whether as a member or as an outside collaborator on a private repo. The ToS allows one free machine account per person.
  - 依据：https://docs.github.com/en/billing/reference/github-license-users lists members and "Outside collaborators on private repositories owned by your organization" as billed (confirmed, and the repo is PRIVATE per `gh repo view`). That page does not mention GitHub Apps or bots at all. The ToS says "You may maintain no more than one free machine account in addition to your free Personal Account" (confirmed).
- **属实**：GitHub sanitizes custom URL schemes in markdown, so `codex://` links cannot be clicked. The report's source is a github-mcp-server PR at gh.mise.run.place.
  - 依据：The report cites a non-GitHub mirror domain. The real PR is https://github.com/github/github-mcp-server/pull/2085 (`gh api repos/github/github-mcp-server/pulls/2085`: created 2026-02-25, merged 2026-06-11). Its body says "Since GitHub sanitizes custom URL schemes in markdown, the badges link through https://aka.ms/mcpinstall which redirects...". This is secondary evidence; I found no official GitHub doc on allowed schemes. The Codex deep-link page (https://learn.chatgpt.com/docs/reference/commands.md) confirms `codex://new?prompt=&path=&originUrl=`.
- **属实**：Plane Cloud Free allows 12 users and its GitHub integration needs Pro (from $6/user/month). Self-hosted Community Edition can only use MCP in stdio mode.
  - 依据：https://plane.so/pricing: Free has 12 users, and the integrations row reads "GitHub | No | Yes | Yes | Yes". Pro is $6 per user per month billed annually, $8 monthly. https://developers.plane.so/dev-tools/mcp-server: PAT endpoint `https://mcp.plane.so/http/api-key/mcp` needs both `Authorization: Bearer` and `x-workspace-slug`. Community Edition can't use OAuth, and the hosted service can't reach private instances, so CE should "use stdio mode".
- **说过头了**：Shortcut Free allows 10 users with the GitHub integration and 5GB storage. Its official MCP runs at https://mcp.shortcut.com/mcp, and there is also a local version that uses a token.
  - 依据：https://www.shortcut.com/pricing: Free allows 10 users and 5G of storage and lists "GitHub, Slack & Figma integrations" (confirmed). https://www.shortcut.com/help/integrations/mcp-server documents OAuth only ("No API token or local setup required"). The local repo https://github.com/useshortcut/mcp-server-shortcut is archived: future development happens on the remote server and the repo is "for historical reference purposes only".
- **属实**：Jira Free allows up to 10 users with 2GB of storage and no Rovo. Assigning Jira work items to coding agents is for paid customers only, and Codex support comes later.
  - 依据：https://www.atlassian.com/en/software/jira/pricing: "Up to 10 users", "2 GB of storage", "The Free plan does not include Rovo". Standard is $8.48 per user per month. Coding-agent assignment (July 2026, per SD Times, DevOps.com and The New Stack via search) is "available today for paid Jira Cloud customers". Sources disagree on Codex: The New Stack and DevOps.com body say it is coming later, while Atlassian's agent page lists it. I could not confirm the exact date of 2026-07-15. https://github.com/atlassian/atlassian-mcp-server says "An organization admin must enable API token authentication" (confirmed) but gives no GA date, so the 2026-02-04 date rests only on third-party reports.

### 正文遗漏的事实

- The Codex desktop app is now the ChatGPT desktop app. The deep-link page says "The ChatGPT desktop app keeps the `codex://` URL scheme for compatibility" (https://learn.chatgpt.com/docs/reference/commands.md). Computer Use is offered "in the ChatGPT desktop app and the Codex app" on macOS and Windows "with ChatGPT Work and Codex", in supported regions, and needs the Computer Use plugin plus Screen Recording and Accessibility permissions (https://learn.chatgpt.com/docs/computer-use.md). The workflow and Linear's "Codex desktop" launcher should be tested against the app the owner actually has installed.
- The report's template says "用户 clay 的图形会话", but OP-2 (#206, the operator item for the Mac graphical login) names the Mac GUI user `<Mac 测试用户>` (`gh issue list --label needs-operator`). The Host field and template should use that account, or ask the owner.
- The Linear Agent APIs, which the free app identities depend on, are labeled a Developer Preview that "may change before general availability" (https://linear.app/developers/agents). That makes the zero-cost-identity assumption less certain.
- A client_credentials app token "has access to all public teams in the workspace" by default (https://linear.app/developers/oauth-2-0-authentication). Restricting each app to DESK has to be done on the app details page, or the agents can write to any team.
- Codex needs `bearer_token_env_var` (or `http_headers`/`env_http_headers`) under `[mcp_servers.linear]` in config.toml to send a bearer token (https://learn.chatgpt.com/docs/extend/mcp?surface=cli). The report leaves this key unchecked. The `--bearer-token-env-var` flag for `codex mcp add` appears only in third-party guides. The Claude Code command in the report is valid: `claude mcp add --help` shows `-H, --header`.
- The gh flags for issue types, sub-issues and dependencies (2026-06-10) need gh v2.94.0+ (https://github.blog/changelog/2026-06-10-manage-sub-issues-types-and-dependencies-from-github-cli/). Like --attach, JP-VPS's 2.45.0 can't use them.
- Plan B's Actions workflow would use the org's metered Actions budget. OP-1 (#205, Actions payment, closed) records that a $20 per month cap stops usage when reached and that all jobs failed on 2026-10-12 for billing. If the budget runs out again, the notify workflow stops silently as well.
- Linear Free's 2-team limit matters if the owner's existing workspace ("我们的 Linear") already has 2 teams on Free. Then a DESK team can't be added without Basic, or the owner reuses an existing team. Check this before setup.
- The 'pure docs PR can self-merge' rule the report cites comes from a user memory permission, not from AGENTS.md. AGENTS.md only excludes docs-only PRs from the two-PR limit.
